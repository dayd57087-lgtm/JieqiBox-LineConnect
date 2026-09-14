/**
 * Line connect (连线自动走棋) main loop.
 *
 * Pipeline per pass:
 *   screen capture -> YOLO recognition -> Jieqi FEN -> engine -> tap/drag
 *
 * Two ideas drive the design:
 *
 * 1. **Observations, not frames.** A frame that has not changed is still an
 *    observation of the same position, so it counts towards stability instead of
 *    being thrown away. This is what makes the loop both fast (one inference per
 *    opponent move) and reliable (the position must persist before we act).
 *
 * 2. **The game flow tells us which side we play.** The standard opening layout
 *    pins red as the side to move; from there the side to move simply alternates
 *    with every move. A move that happens while we are not playing must have
 *    been made by the opponent, which identifies our colour without any setup.
 */
import { ref, watch } from 'vue'
import { LABELS, type DetectionBox } from '../image-recognition/types'
import {
  JieqiPoolTracker,
  buildJieqiFen,
  countRevealedChars,
  fenPositionKey,
  gridToImagePoint,
  isStartPosition,
  quadFromBox,
  uciToSquares,
  type BoardQuad,
  type Grid,
} from './boardFen'
import {
  DEFAULT_SETTINGS,
  type LogEntry,
  type LogLevel,
  type LineConnectSettings,
} from './types'

export interface LineConnectDeps {
  /** Result of useImageRecognition() */
  recognition: any
  /** Result of useChessGame() */
  game: any
  /** Result of useUciEngine() */
  engine: any
}

const MAX_LOGS = 250

type Side = 'w' | 'b'

/** Everything one recognition pass produces. */
interface PassResult {
  grid: Grid
  fen: string
  warnings: string[]
  pieceCount: number
  quad: BoardQuad | null
  boxes: DetectionBox[]
  imageWidth: number
  imageHeight: number
}

const other = (side: Side): Side => (side === 'w' ? 'b' : 'w')

export function useLineConnect(deps: LineConnectDeps) {
  const settings = ref<LineConnectSettings>({ ...DEFAULT_SETTINGS })
  const isRunning = ref(false)
  /** Auto play (true) or analysis only (false). */
  const autoPlay = ref(true)
  const phase = ref<
    'idle' | 'capturing' | 'recognising' | 'thinking' | 'moving' | 'waiting'
  >('idle')
  const logs = ref<LogEntry[]>([])
  const lastPreview = ref('')
  const lastFen = ref('')
  const lastMove = ref('')
  const passes = ref(0)
  const moveCount = ref(0)
  const errorCount = ref(0)
  const detectionCount = ref(0)
  const boardDetected = ref(false)
  const lastWarnings = ref<string[]>([])

  /** Our colour, once known. `null` while still working it out. */
  const mySide = ref<Side | null>(null)
  /** Which side we believe is to move in the last observed position. */
  const sideToMove = ref<Side>('w')

  const overlayVisible = ref(false)
  const chessboardVisible = ref(false)
  const tickCount = ref(0)
  const lastChangeRatio = ref(1)
  const lastPassMode = ref<'full' | 'crop' | 'cached'>('full')
  const lastInferenceMs = ref(0)
  const sampleCount = ref(0)
  const sampleSaved = ref(0)
  const sampleRecordingActive = ref(false)
  const sampleDirPath = ref('')

  /** Engine evaluation shown on the overlay, e.g. "+0.35". */
  const evaluation = ref('--')

  const poolTracker = new JieqiPoolTracker()

  /* ------------------------------------------------------------------ */
  /* Loop state                                                          */
  /* ------------------------------------------------------------------ */

  let timer: ReturnType<typeof setTimeout> | null = null
  let busy = false
  let nativeTickActive = false
  let overlayListenerBound = false
  let chessboardWanted = false

  /** See the note in startLoopDriver(). */
  let boardRect: { left: number; top: number; width: number; height: number } | null = null
  let boardQuad: BoardQuad | null = null
  let framesSinceLocate = 0

  /** Newest stable observation. */
  let lastGrid: Grid | null = null
  let lastFenValue = ''
  /** Key of the last position we treated as a new position. */
  let observedKey = ''
  let stableKey = ''
  let stableCount = 0

  /** True between playing a move and observing the resulting position. */
  let ourMoveInFlight = false

  /** When we first saw a stable position, used for the side-detection window. */
  let firstStableAt = 0

  /** Position key of the last move attempt, and when it happened. */
  let lastAttemptKey = ''
  let lastAttemptAt = 0

  /** Position key the engine has already analysed in analysis-only mode. */
  let lastAnalysedKey = ''

  /** How long to wait before retrying a move that did not register. */
  const RETRY_BACKOFF_MS = 2500

  /** Move the next analysis should avoid (the "变招" / change-move action). */
  let avoidMove: string | null = null
  let lastMoveTime = 0

  /* ------------------------------------------------------------------ */
  /* Logging                                                             */
  /* ------------------------------------------------------------------ */

  function log(level: LogLevel, text: string) {
    logs.value.push({ time: Date.now(), level, text })
    if (logs.value.length > MAX_LOGS) {
      logs.value.splice(0, logs.value.length - MAX_LOGS)
    }
  }

  function clearLogs() {
    logs.value = []
  }

  /* ------------------------------------------------------------------ */
  /* Native bridge                                                       */
  /* ------------------------------------------------------------------ */

  function bridge(): any | null {
    return (window as any).LineConnect ?? null
  }

  function isSupported(): boolean {
    return bridge() !== null
  }

  function supportsOverlay(): boolean {
    const api = bridge() as any
    return !!api && typeof api.showOverlay === 'function'
  }

  function hasCapturePermission(): boolean {
    try {
      return !!bridge()?.hasCapturePermission()
    } catch {
      return false
    }
  }

  function isCapturing(): boolean {
    try {
      return !!bridge()?.isCapturing()
    } catch {
      return false
    }
  }

  function hasAccessibility(): boolean {
    try {
      return !!bridge()?.hasAccessibility()
    } catch {
      return false
    }
  }

  function canDrawOverlays(): boolean {
    try {
      return !!bridge()?.canDrawOverlays?.()
    } catch {
      return false
    }
  }

  function captureStatus(): any {
    try {
      const raw = bridge()?.captureStatus()
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }

  function requestCapturePermission() {
    try {
      bridge()?.requestCapturePermission()
      log('info', '已请求截屏权限，请在系统弹窗中确认')
    } catch (e) {
      log('error', `请求截屏权限失败：${String(e)}`)
    }
  }

  function openAccessibilitySettings() {
    try {
      bridge()?.openAccessibilitySettings()
      log('info', '已打开系统无障碍设置，请启用「JieqiBox 自动走棋」')
    } catch (e) {
      log('error', `打开无障碍设置失败：${String(e)}`)
    }
  }

  function openOverlaySettings() {
    try {
      bridge()?.openOverlaySettings?.()
      log('info', '已打开「显示在其他应用上层」设置，请为本应用开启')
    } catch (e) {
      log('error', `打开悬浮窗设置失败：${String(e)}`)
    }
  }

  function startCapture(): boolean {
    const api = bridge()
    if (!api) return false
    if (!api.hasCapturePermission()) {
      log('warn', '尚未获得截屏权限')
      return false
    }
    const ok = api.startCapture(
      settings.value.captureScale,
      settings.value.jpegQuality,
      100
    )
    if (ok) {
      log('info', `已启动截屏服务（缩放 ${settings.value.captureScale}）`)
    } else {
      log('error', '启动截屏服务失败')
    }
    return !!ok
  }

  function stopCapture() {
    try {
      bridge()?.stopCapture()
      log('info', '已停止截屏服务')
    } catch (e) {
      log('warn', `停止截屏失败：${String(e)}`)
    }
  }

  /** Diagnostic helper: tap the centre of the screen. */
  function testTap() {
    const api = bridge()
    if (!api) {
      log('error', '当前平台不支持自动点击')
      return
    }
    if (!api.hasAccessibility()) {
      log('error', '无障碍服务未开启')
      return
    }
    const status = captureStatus()
    const w = status?.screenWidth || window.screen.width
    const h = status?.screenHeight || window.screen.height
    const ok = api.tap(w / 2, h / 2, 40)
    log(
      ok ? 'info' : 'error',
      ok
        ? `已发送测试点击 (${Math.round(w / 2)}, ${Math.round(h / 2)})`
        : `测试点击失败：${api.lastGestureError?.()}`
    )
  }

  /* ------------------------------------------------------------------ */
  /* Floating bar and chessboard                                         */
  /* ------------------------------------------------------------------ */

  function showOverlay(): boolean {
    const api = bridge()
    if (!api?.showOverlay) return false
    if (!canDrawOverlays()) {
      log('warn', '需要「显示在其他应用上层」权限才能使用悬浮窗')
      return false
    }
    const ok = !!api.showOverlay()
    overlayVisible.value = ok
    if (ok) {
      log('info', '悬浮窗已显示，可拖动状态条移动位置')
      syncOverlay()
    } else {
      log('warn', '悬浮窗显示失败，请先启动截屏服务')
    }
    return ok
  }

  function hideOverlay() {
    try {
      bridge()?.hideOverlay?.()
    } catch {
      // ignore
    }
    overlayVisible.value = false
  }

  function refreshOverlayVisible() {
    try {
      overlayVisible.value = !!bridge()?.isOverlayVisible?.()
    } catch {
      // ignore
    }
  }

  function refreshChessboardVisible() {
    try {
      chessboardVisible.value = !!bridge()?.isChessboardVisible?.()
      if (chessboardVisible.value) chessboardWanted = true
    } catch {
      // ignore
    }
  }

  function showChessboard(): boolean {
    const api = bridge()
    if (!api?.showChessboard) return false
    if (!canDrawOverlays()) {
      log('warn', '需要「显示在其他应用上层」权限才能显示棋盘')
      return false
    }
    const ok = !!api.showChessboard()
    chessboardWanted = ok
    chessboardVisible.value = ok
    if (ok) {
      log('info', '棋盘窗口已显示：拖动移动，拖右下角调整大小')
      pushBoardState()
    } else {
      log('warn', '棋盘显示失败，请先启动截屏服务')
    }
    return ok
  }

  function hideChessboard() {
    try {
      bridge()?.hideChessboard?.()
    } catch {
      // ignore
    }
    chessboardWanted = false
    chessboardVisible.value = false
  }

  function toggleChessboard() {
    if (chessboardVisible.value) hideChessboard()
    else showChessboard()
  }

  /* ------------------------------------------------------------------ */
  /* Status text                                                         */
  /* ------------------------------------------------------------------ */

  function sideLabel(side: Side): string {
    return side === 'w' ? '红方' : '黑方'
  }

  function mySideText(): string {
    if (mySide.value) return `我执${sideLabel(mySide.value)}`
    return '判断中…'
  }

  function phaseText(): string {
    switch (phase.value) {
      case 'capturing':
        return '截屏'
      case 'recognising':
        return '识别中'
      case 'thinking':
        return '思考中'
      case 'moving':
        return '落子中'
      case 'waiting':
        return '待机'
      default:
        return '待机'
    }
  }

  function stateText(): string {
    if (!isRunning.value) return '未连线'
    if (!mySide.value) return '判断走棋方'
    return `${sideLabel(sideToMove.value)}走 · ${phaseText()}`
  }

  function waitingText(): string {
    const base = lastMoveTime ? Math.max(0, Math.round((Date.now() - lastMoveTime) / 1000)) : 0
    return `等待 ${base}秒`
  }

  function syncOverlay() {
    const api = bridge()
    if (!api?.updateOverlay) return
    if (!api.isOverlayVisible?.()) return
    try {
      api.updateOverlay(
        JSON.stringify({
          turn: mySideText(),
          status: stateText(),
          evaluation: `评估 ${evaluation.value}`,
          waiting: waitingText(),
          connectRunning: isRunning.value,
          autoPlay: autoPlay.value,
          autoEnabled: hasAccessibility() && !!deps.engine?.isEngineLoaded?.value,
          boardVisible: chessboardVisible.value,
        })
      )
    } catch {
      // best effort
    }
  }

  /** Pushes the position plus the arrows (engine move / last move). */
  function pushBoardState() {
    const api = bridge()
    if (!api) return
    const wanted = chessboardVisible.value || chessboardWanted
    if (!wanted) return

    try {
      if (lastFen.value) api.setChessboardFen?.(lastFen.value)
      const pv: string[] = deps.engine?.pvMoves?.value ?? []
      const best = String(pv[0] ?? deps.engine?.bestMove?.value ?? '').slice(0, 4)
      api.setChessboardMove?.(
        JSON.stringify({ best, last: String(lastMove.value || '').slice(0, 4) })
      )
    } catch {
      // best effort
    }
  }

  function updateEvaluation() {
    const raw = String(deps.engine?.analysis?.value ?? '').trim()
    if (!raw) return
    const cp = raw.match(/score\s+cp\s+(-?\d+)/)
    if (cp) {
      const pawns = Number(cp[1]) / 100
      evaluation.value = `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`
      return
    }
    const mate = raw.match(/score\s+mate\s+(-?\d+)/)
    if (mate) evaluation.value = `杀${mate[1]}`
  }

  /* ------------------------------------------------------------------ */
  /* Sample recording                                                    */
  /* ------------------------------------------------------------------ */

  function isSampleRecording(): boolean {
    try {
      return !!bridge()?.isSampleRecording?.() || sampleRecordingActive.value
    } catch {
      return sampleRecordingActive.value
    }
  }

  function samplePath(): string {
    try {
      return bridge()?.samplePath?.() ?? sampleDirPath.value
    } catch {
      return sampleDirPath.value
    }
  }

  function toggleSampleRecording(): boolean {
    const api = bridge()
    if (!api?.startSampleRecording) return false
    if (sampleRecordingActive.value) {
      try {
        api.stopSampleRecording?.()
      } catch {
        // ignore
      }
      sampleRecordingActive.value = false
      settings.value.recordSamples = false
      log('info', `已停止采集样本（共 ${sampleCount.value} 张）`)
      return false
    }
    try {
      api.requestStoragePermission?.()
      const ok = !!api.startSampleRecording()
      sampleRecordingActive.value = ok
      settings.value.recordSamples = ok
      if (ok) {
        sampleDirPath.value = api.samplePath?.() ?? ''
        sampleCount.value = api.sampleCount?.() ?? 0
        log('info', `开始采集样本，保存在 ${sampleDirPath.value || '(应用目录)'}`)
      } else {
        log('error', '无法开始采集样本，请确认截屏服务已启动')
      }
      return ok
    } catch (e) {
      log('error', `采集样本失败：${String(e)}`)
      return false
    }
  }

  /** Called from JS for full-frame passes only (keeps coordinates consistent). */
  function saveSampleIfRecording(boxes: DetectionBox[], imageWidth: number, imageHeight: number) {
    if (!settings.value.recordSamples || !sampleRecordingActive.value) return
    const api = bridge()
    if (!api?.saveSample) return
    const payload = {
      imageWidth,
      imageHeight,
      board: boardRect,
      boxes: boxes.map(b => ({
        cls: b.labelIndex,
        name: LABELS[b.labelIndex]?.name ?? '',
        x: b.box[0],
        y: b.box[1],
        w: b.box[2],
        h: b.box[3],
        score: b.score,
      })),
    }
    try {
      if (api.saveSample(JSON.stringify(payload))) {
        sampleSaved.value++
        sampleCount.value = api.sampleCount?.() ?? sampleCount.value + 1
      }
    } catch {
      // ignore
    }
  }

  /* ------------------------------------------------------------------ */
  /* Session reset                                                       */
  /* ------------------------------------------------------------------ */

  function resetSession(silent = false) {
    poolTracker.reset()
    boardRect = null
    boardQuad = null
    framesSinceLocate = 0
    lastGrid = null
    lastFenValue = ''
    observedKey = ''
    stableKey = ''
    stableCount = 0
    ourMoveInFlight = false
    firstStableAt = 0
    avoidMove = null
    lastMoveTime = 0
    moveCount.value = 0
    passes.value = 0
    errorCount.value = 0
    detectionCount.value = 0
    lastMove.value = ''
    lastFen.value = ''
    lastWarnings.value = []
    evaluation.value = '--'
    sideToMove.value = 'w'
    mySide.value = settings.value.mySide === 'auto' ? null : (settings.value.mySide as Side)
    if (!silent) {
      log(
        'info',
        mySide.value
          ? `已重置，我方执${sideLabel(mySide.value)}`
          : '已重置，将自动判断我方走棋方'
      )
    }
    syncOverlay()
  }

  /* ------------------------------------------------------------------ */
  /* Engine                                                              */
  /* ------------------------------------------------------------------ */

  function waitForBestMove(timeoutMs: number): Promise<string | null> {
    const engine = deps.engine
    return new Promise(resolve => {
      let done = false
      let stopWatch: (() => void) | null = null
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null

      const finish = (value: string | null) => {
        if (done) return
        done = true
        if (timeoutHandle) clearTimeout(timeoutHandle)
        if (stopWatch) stopWatch()
        resolve(value)
      }

      stopWatch = watch(
        () => String(engine.bestMove.value ?? ''),
        value => {
          if (value) finish(value)
        }
      )
      timeoutHandle = setTimeout(() => finish(null), timeoutMs)
    })
  }

  async function analysePosition(fen: string): Promise<string | null> {
    const engine = deps.engine
    if (!engine.isEngineLoaded.value) {
      log('error', '尚未加载象棋引擎，请先在「引擎管理」中加载 UCI 引擎')
      return null
    }

    // Keep the app board in sync; the engine then receives exactly the FEN the
    // rest of the app produces.
    try {
      deps.game.loadFen(fen, false)
    } catch (e) {
      log('warn', `载入局面失败：${String(e)}`)
    }

    // "变招": exclude the move we just played so the engine picks a different one.
    let searchmoves: string[] = []
    if (avoidMove) {
      const banned = avoidMove.slice(0, 4)
      try {
        const all = (deps.game.getAllLegalMovesForCurrentPosition?.() ?? []) as string[]
        searchmoves = all.map(m => String(m).slice(0, 4)).filter(m => m && m !== banned)
        log(
          'info',
          searchmoves.length
            ? `变招：已排除 ${banned}，候选 ${searchmoves.length} 个着法`
            : `变招：没有其他着法可选，按常规分析`
        )
      } catch (e) {
        log('warn', `计算候选着法失败：${String(e)}`)
      }
      avoidMove = null
    }

    // A previous search that is still running would make startAnalysis() a
    // no-op (it returns early while thinking), which used to burn a full
    // timeout and stall the loop. Stop it and give the engine a moment.
    try {
      engine.stopAnalysis?.()
    } catch {
      // ignore
    }
    await new Promise(resolve => setTimeout(resolve, 60))

    engine.bestMove.value = ''
    engine.startAnalysis({ movetime: settings.value.thinkTimeMs }, [], fen, searchmoves)

    const best = await waitForBestMove(settings.value.thinkTimeMs + 3000)
    if (!best) log('warn', '引擎未在预期时间内给出着法')
    return best
  }

  /* ------------------------------------------------------------------ */
  /* Move execution                                                      */
  /* ------------------------------------------------------------------ */

  function screenScale(status: any): number {
    if (status?.screenWidth && status?.frameWidth) {
      return status.frameWidth / status.screenWidth
    }
    return settings.value.captureScale
  }

  async function performMove(uci: string, quad: BoardQuad, scale: number): Promise<boolean> {
    const squares = uciToSquares(uci)
    if (!squares) {
      log('error', `无法解析引擎着法：${uci}`)
      return false
    }
    const from = gridToImagePoint(quad, squares.from.row, squares.from.col)
    const to = gridToImagePoint(quad, squares.to.row, squares.to.col)
    const fx = from.x / scale
    const fy = from.y / scale
    const tx = to.x / scale
    const ty = to.y / scale

    log(
      'move',
      `执行 ${uci}：(${Math.round(fx)}, ${Math.round(fy)}) -> (${Math.round(tx)}, ${Math.round(ty)})`
    )

    const api = bridge()
    if (!api || !api.hasAccessibility()) {
      log('error', '无障碍服务未开启，无法自动落子')
      return false
    }

    if (settings.value.clickMode === 'drag') {
      const ok = api.swipe(fx, fy, tx, ty, 320)
      if (!ok) log('error', `滑动失败：${api.lastGestureError?.() ?? ''}`)
      return !!ok
    }

    const first = api.tap(fx, fy, 40)
    await new Promise(resolve => setTimeout(resolve, settings.value.clickGapMs))
    const second = api.tap(tx, ty, 40)
    if (!first || !second) {
      log('error', `点击失败：${api.lastGestureError?.() ?? ''}`)
      return false
    }
    return true
  }

  /* ------------------------------------------------------------------ */
  /* Recognition                                                         */
  /* ------------------------------------------------------------------ */

  function loadImageElement(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('截图解码失败'))
      img.src = dataUrl
    })
  }

  /**
   * Runs one full pipeline pass and returns the recognised position.
   *
   * `mode` is 'full' when the whole screen was analysed (needed to locate the
   * board, and to keep sample annotations in a consistent coordinate space) and
   * 'crop' when only the board region was analysed. Both use the same grid
   * mapping, so the two paths cannot drift apart.
   */
  async function recognise(mode: 'full' | 'crop'): Promise<PassResult | null> {
    const api = bridge()!
    const status = captureStatus()
    const frameWidth: number = status?.frameWidth || 0
    const frameHeight: number = status?.frameHeight || 0

    let base64: string
    let imageWidth: number
    let toFrame = 1

    if (mode === 'full') {
      base64 = api.captureFrame()
      if (!base64) return null
      lastPreview.value = `data:image/jpeg;base64,${base64}`
      const image = await loadImageElement(lastPreview.value)
      imageWidth = image.naturalWidth || 1
      toFrame = frameWidth > 0 ? frameWidth / imageWidth : 1
      return await recogniseImage(image, boxes => {
        const boardBox = deps.recognition.getBoardBox(boxes)
        boardDetected.value = !!boardBox
        if (!boardBox) return null

        // Convert the box from transferred-image pixels back into captured-frame
        // pixels, which is the space the native crop expects. A margin is added
        // so the board is fully inside the crop and the model can still detect
        // it there.
        const [bx, by, bw, bh] = boardBox.box
        const margin = 0.06
        const left = Math.max(0, (bx - bw * margin) * toFrame)
        const top = Math.max(0, (by - bh * margin) * toFrame)
        const right = Math.min(frameWidth || Infinity, (bx + bw * (1 + margin)) * toFrame)
        const bottom = Math.min(frameHeight || Infinity, (by + bh * (1 + margin)) * toFrame)
        boardRect = { left, top, width: right - left, height: bottom - top }
        framesSinceLocate = 0
        try {
          // Restrict change detection to the board; the status-bar clock would
          // otherwise keep the loop busy.
          if (frameWidth > 0 && frameHeight > 0) {
            api.setWatchRegion?.(
              left / frameWidth,
              top / frameHeight,
              right / frameWidth,
              bottom / frameHeight
            )
          }
        } catch {
          // ignore
        }
        return boardRect
      })
    }

    const rect = boardRect!
    base64 = api.captureCrop(
      Math.round(rect.left),
      Math.round(rect.top),
      Math.round(rect.width),
      Math.round(rect.height),
      settings.value.cropMaxEdge
    )
    if (!base64) return null
    lastPreview.value = `data:image/jpeg;base64,${base64}`
    const image = await loadImageElement(lastPreview.value)
    imageWidth = image.naturalWidth || 1

    return await recogniseImage(image, boxes => {
      // The crop lives inside the frame, so its own Board detection gives the
      // accurate quad; no coordinate juggling is required for the pieces.
      const boardBox = deps.recognition.getBoardBox(boxes)
      boardDetected.value = !!boardBox
      if (!boardBox) return null
      const scaleX = frameWidth > 0 ? (imageWidth ? rect.width / imageWidth : 1) : 1
      const [bx, by, bw, bh] = boardBox.box
      return {
        left: rect.left + bx * scaleX,
        top: rect.top + by * scaleX,
        width: bw * scaleX,
        height: bh * scaleX,
      } as any
    })
  }

  /**
   * Shared part of both capture paths: run the detector, build the grid and the
   * FEN. `locate` maps the detection result onto a board rectangle (in frame
   * coordinates) for the caller to persist.
   */
  async function recogniseImage(
    image: HTMLImageElement,
    locate: (boxes: DetectionBox[]) => any
  ): Promise<PassResult | null> {
    const startedAt = Date.now()
    const boxes: DetectionBox[] = await deps.recognition.processImageElement(image)
    lastInferenceMs.value = Date.now() - startedAt
    detectionCount.value = boxes.length

    const located = locate(boxes)
    if (!located) return null

    // Both paths use the same mapping helper: it finds the Board inside the
    // analysed image and maps pieces onto the lattice with the bilinear quad.
    // Using one code path avoids the two modes drifting apart.
    const grid: Grid = deps.recognition.updateBoardGrid(boxes)

    // Hidden piece pools only shrink when pieces are revealed, so feeding every
    // observation keeps the estimate tight.
    const probe = buildJieqiFen(grid, '-', sideToMove.value, settings.value.minScore)
    poolTracker.observe(countRevealedChars(probe.rows))

    const result = buildJieqiFen(
      grid,
      poolTracker.poolFen(),
      sideToMove.value,
      settings.value.minScore
    )

    return {
      grid,
      fen: result.fen,
      warnings: result.warnings,
      pieceCount: result.pieceCount,
      quad: quadFromBox({
        box: [
          located.left,
          located.top,
          located.width,
          located.height,
        ],
        score: 1,
        labelIndex: 4,
      }),
      boxes,
      imageWidth: image.naturalWidth || 1,
      imageHeight: image.naturalHeight || 1,
    }
  }

  /* ------------------------------------------------------------------ */
  /* Decision making                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Handles a position that has been observed `stableFrames` times in a row.
   *
   * Called on every tick while the board is static, so it has to be careful to
   * only act once per position (and to back off when a move failed to register).
   */
  async function onStablePosition(grid: Grid, fen: string, key: string) {
    // --- keep the side-to-move bookkeeping in sync ---------------------
    const isNewPosition = key !== observedKey
    if (isNewPosition) {
      const mover = sideToMove.value

      if (!ourMoveInFlight) {
        // The board changed and we did not play: the opponent just moved.
        const inferred = other(mover)
        if (mySide.value !== inferred) {
          mySide.value = inferred
          log('info', `自动判断：我方执${sideLabel(inferred)}`)
        }
      }
      ourMoveInFlight = false
      sideToMove.value = other(mover)
      observedKey = key
      lastAttemptKey = ''
      lastAnalysedKey = ''

      if (isStartPosition(grid)) {
        // The opening layout is authoritative: red moves first.
        sideToMove.value = 'w'
        log('info', '识别到开局局面，红方先行')
      }
    }

    // --- make sure we know which colour we play ------------------------
    if (!mySide.value) {
      if (!firstStableAt) firstStableAt = Date.now()
      const waited = Date.now() - firstStableAt
      if (waited < settings.value.detectWindowMs) {
        // Give the opponent a chance to move first; if they do, the change
        // above identifies our colour for free.
        phase.value = 'waiting'
        return
      }
      const assumed = sideToMove.value
      mySide.value = assumed
      log(
        'info',
        `自动判断：我方执${sideLabel(assumed)}（等待 ${(waited / 1000).toFixed(1)} 秒内对手未走子）`
      )
      firstStableAt = 0
    }

    // --- is it our move? ----------------------------------------------
    if (sideToMove.value !== mySide.value) {
      phase.value = 'waiting'
      return
    }

    if (!deps.engine.isEngineLoaded.value) {
      if (isNewPosition) log('error', '尚未加载象棋引擎，请先在「引擎管理」中加载 UCI 引擎')
      phase.value = 'waiting'
      return
    }

    // --- analysis-only mode -------------------------------------------
    if (!autoPlay.value) {
      if (lastAnalysedKey === key) {
        updateEvaluation()
        pushBoardState()
        phase.value = 'waiting'
        return
      }
      lastAnalysedKey = key
      phase.value = 'thinking'
      try {
        deps.engine.stopAnalysis?.()
        await new Promise(resolve => setTimeout(resolve, 60))
        deps.engine.startAnalysis(
          { movetime: Math.max(1500, settings.value.thinkTimeMs) },
          [],
          fen
        )
      } catch (e) {
        log('warn', `分析失败：${String(e)}`)
      }
      updateEvaluation()
      pushBoardState()
      phase.value = 'waiting'
      return
    }

    if (!boardQuad) {
      boardRect = null
      phase.value = 'waiting'
      return
    }

    // A move that never reached the platform leaves the position unchanged; back
    // off for a moment instead of hammering the engine.
    if (lastAttemptKey === key && Date.now() - lastAttemptAt < RETRY_BACKOFF_MS) {
      phase.value = 'waiting'
      return
    }
    lastAttemptKey = key
    lastAttemptAt = Date.now()

    // --- think ---------------------------------------------------------
    phase.value = 'thinking'
    const best = await analysePosition(fen)
    updateEvaluation()
    if (!best) {
      phase.value = 'waiting'
      return
    }

    const squares = uciToSquares(best)
    if (squares) {
      const label = LABELS[grid[squares.from.row]?.[squares.from.col]?.labelIndex ?? -1]?.name
      const ours =
        sideToMove.value === 'w'
          ? label?.startsWith('r_') || label?.startsWith('dark_r')
          : label?.startsWith('b_') || label?.startsWith('dark_b')
      if (label && !ours) {
        // Not fatal: the detector may simply have missed the piece on that square.
        log('warn', `注意：着法起点识别为 ${label}，与走子方不一致`)
      }
    }

    // --- play ----------------------------------------------------------
    phase.value = 'moving'
    const played = await performMove(best, boardQuad, screenScale(captureStatus()))
    lastMove.value = best
    if (played) {
      moveCount.value++
      lastMoveTime = Date.now()
      ourMoveInFlight = true
      log('info', `已落子 ${best}，等待对手…`)
    }
    pushBoardState()
    phase.value = 'waiting'
  }

  /* ------------------------------------------------------------------ */
  /* Main loop                                                           */
  /* ------------------------------------------------------------------ */

  /** Entry point used by the native tick driver. */
  function onNativeTick() {
    tickCount.value++
    if (!isRunning.value) return
    updateEvaluation()
    syncOverlay()
    // The engine's suggested move feeds the arrow on the floating chessboard.
    pushBoardState()
    if (busy) return
    void runOnce()
  }

  function schedule(delayMs: number) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (nativeTickActive) return
      void runOnce()
    }, delayMs)
  }

  async function runOnce() {
    if (!isRunning.value || busy) return
    busy = true
    try {
      await tick()
    } catch (e) {
      errorCount.value++
      log('error', `识别轮次失败：${String(e)}`)
    } finally {
      busy = false
      if (isRunning.value && !nativeTickActive) {
        schedule(settings.value.pollIntervalMs)
      }
      syncOverlay()
    }
  }

  /** Runs a single pipeline pass without starting the loop. */
  async function stepOnce() {
    if (busy) return
    busy = true
    try {
      await tick()
    } catch (e) {
      log('error', `单步执行失败：${String(e)}`)
    } finally {
      busy = false
    }
  }

  async function tick() {
    passes.value++
    phase.value = 'capturing'

    const api = bridge()
    if (!api) {
      stop('当前平台不支持连线功能')
      return
    }

    const needLocate =
      !boardRect ||
      !settings.value.useBoardCrop ||
      framesSinceLocate >= Math.max(1, settings.value.relocateEvery)

    const ratio =
      typeof api.frameChangeRatio === 'function' ? Number(api.frameChangeRatio()) : 1
    lastChangeRatio.value = ratio

    const frameChanged = ratio >= settings.value.changeThreshold

    // ---- unchanged frame: still an observation of the same position ----
    if (!needLocate && !frameChanged && lastGrid) {
      lastPassMode.value = 'cached'
      // An unchanged frame is still an observation of the same position, so it
      // feeds the stability counter rather than being discarded. Without this
      // the counter can never advance while the board is static, and the loop
      // would simply never play.
      bumpStability()
      pushBoardState()
      return
    }

    // ---- (re)locate the board on a full frame ----
    if (needLocate) {
      phase.value = 'recognising'
      const located = await recognise('full')
      framesSinceLocate = 0
      if (!located) {
        lastGrid = null
        boardRect = null
        boardDetected.value = false
        lastWarnings.value = ['未识别到棋盘']
        lastPassMode.value = 'full'
        phase.value = 'waiting'
        return
      }
      lastPassMode.value = 'full'
      saveSampleIfRecording(located.boxes, located.imageWidth, located.imageHeight)
      onObservation(located)
      return
    }

    // ---- crop pass ----
    phase.value = 'recognising'
    framesSinceLocate++
    const located = await recognise('crop')
    if (!located) {
      // The cached rectangle is stale; force a full re-locate next round.
      boardRect = null
      lastPassMode.value = 'crop'
      phase.value = 'waiting'
      return
    }
    lastPassMode.value = 'crop'
    onObservation(located)
  }

  /**
   * Advances the stability counter without a new recognition.
   *
   * Used when the frame is unchanged: the board still shows the previous
   * position, which is exactly what "stable" means.
   */
  function bumpStability() {
    if (!lastGrid || !stableKey) return
    stableCount++
    if (stableCount < Math.max(1, settings.value.stableFrames)) {
      phase.value = 'waiting'
      return
    }
    void onStablePosition(lastGrid, lastFenValue, stableKey)
  }

  function onObservation(result: PassResult) {
    if (result.quad) boardQuad = result.quad
    lastGrid = result.grid
    lastFenValue = result.fen
    lastFen.value = result.fen
    lastWarnings.value = result.warnings

    const key = fenPositionKey(result.fen)
    if (key === stableKey) stableCount++
    else {
      stableKey = key
      stableCount = 1
    }

    pushBoardState()

    if (stableCount < Math.max(1, settings.value.stableFrames)) {
      phase.value = 'waiting'
      return
    }

    void onStablePosition(result.grid, result.fen, key)
  }

  /* ------------------------------------------------------------------ */
  /* Overlay actions                                                     */
  /* ------------------------------------------------------------------ */

  function handleOverlayAction(action: string) {
    switch (action) {
      case 'newGame':
        log('info', '悬浮窗：新局（重置识别状态）')
        resetSession()
        break
      case 'connect':
        if (isRunning.value) stop()
        else start()
        break
      case 'auto':
        setAutoPlay(!autoPlay.value)
        break
      case 'variation':
        if (!lastMove.value) {
          log('warn', '悬浮窗：还没有可变更的着法')
          break
        }
        avoidMove = lastMove.value
        log('info', `悬浮窗：变招（排除 ${lastMove.value.slice(0, 4)}）`)
        break
      case 'board':
        toggleChessboard()
        break
      case 'app':
        try {
          bridge()?.bringToFront?.()
        } catch {
          // ignore
        }
        break
      case 'close':
        stop()
        hideOverlay()
        break
      default:
        break
    }
  }

  /** Re-applies the model input size when the user changes it. */
  watch(
    () => settings.value.modelInputSize,
    () => {
      if (isRunning.value) {
        deps.recognition.setModelInputSize?.(settings.value.modelInputSize)
      }
    }
  )

  function setAutoPlay(value: boolean) {
    autoPlay.value = value
    log('info', value ? '已切换到自动走棋' : '已切换到只分析（不会落子）')
    syncOverlay()
  }

  function bindOverlayListener() {
    if (overlayListenerBound) return
    overlayListenerBound = true
    window.addEventListener('line-connect-overlay', (event: Event) => {
      const action = (event as CustomEvent)?.detail?.action
      if (typeof action === 'string') handleOverlayAction(action)
    })
  }

  /* ------------------------------------------------------------------ */
  /* Loop driver                                                         */
  /* ------------------------------------------------------------------ */

  function startLoopDriver() {
    const api = bridge()
    nativeTickActive = false
    if (api?.startTick) {
      try {
        nativeTickActive = !!api.startTick(settings.value.pollIntervalMs)
      } catch {
        nativeTickActive = false
      }
    }
    if (nativeTickActive) {
      log('info', `识别循环由原生服务驱动（每 ${settings.value.pollIntervalMs}ms）`)
    } else {
      log('info', '使用前端定时器驱动识别循环')
      schedule(200)
    }
  }

  function stopLoopDriver() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (nativeTickActive) {
      try {
        bridge()?.stopTick?.()
      } catch {
        // ignore
      }
      nativeTickActive = false
    }
  }

  /* ------------------------------------------------------------------ */
  /* Start / stop                                                        */
  /* ------------------------------------------------------------------ */

  /** Applies the configured model input size and warms the model up. */
  function prepareModel() {
    void Promise.resolve(deps.recognition.initializeModel?.())
      .then(() => {
        deps.recognition.setModelInputSize?.(settings.value.modelInputSize)
        const info = deps.recognition.modelInput?.value
        if (info) {
          const mode = info.dynamic
            ? `可变输入，当前 ${info.size}px`
            : `固定输入 ${info.size}px（模型不支持缩放）`
          log('info', `识别模型：${mode}`)
        }
      })
      .catch(() => {
        /* surfaced by the recognition composable */
      })
  }

  function start() {
    if (isRunning.value) return
    if (!bridge()) {
      log('error', '当前平台不支持连线功能（仅 Android 可用）')
      return
    }
    if (!deps.engine.isEngineLoaded.value) {
      log('error', '请先加载 UCI 引擎再开始连线')
      return
    }

    resetSession(true)
    isRunning.value = true
    prepareModel()

    log(
      'info',
      `开始连线（${settings.value.mySide === 'auto' ? '自动判断走棋方' : `我方执${sideLabel(settings.value.mySide as Side)}`}，${
        autoPlay.value ? '自动走棋' : '只分析'
      }）`
    )
    startLoopDriver()
    syncOverlay()
  }

  function stop(reason?: string) {
    stopLoopDriver()
    if (isRunning.value) {
      log('info', reason ? `已停止：${reason}` : '已停止连线')
    }
    isRunning.value = false
    phase.value = 'idle'
    try {
      deps.engine.stopAnalysis?.()
    } catch {
      // ignore
    }
    syncOverlay()
  }

  /** Pulls counters that live on the native side. */
  function refreshNativeCounters() {
    const api = bridge()
    if (!api) return
    try {
      sampleRecordingActive.value = !!api.isSampleRecording?.()
      if (sampleRecordingActive.value) {
        sampleCount.value = api.sampleCount?.() ?? sampleCount.value
      }
      refreshOverlayVisible()
      refreshChessboardVisible()
    } catch {
      // ignore
    }
  }

  if (typeof window !== 'undefined') {
    bindOverlayListener()
    ;(window as any).__lineConnectTick__ = onNativeTick
  }

  return {
    settings,
    isRunning,
    autoPlay,
    phase,
    logs,
    lastPreview,
    lastFen,
    lastMove,
    passes,
    moveCount,
    errorCount,
    detectionCount,
    boardDetected,
    lastWarnings,
    mySide,
    sideToMove,
    overlayVisible,
    chessboardVisible,
    tickCount,
    lastChangeRatio,
    lastPassMode,
    lastInferenceMs,
    sampleCount,
    sampleSaved,
    sampleRecordingActive,
    evaluation,
    isSupported,
    supportsOverlay,
    hasCapturePermission,
    isCapturing,
    hasAccessibility,
    canDrawOverlays,
    captureStatus,
    requestCapturePermission,
    openAccessibilitySettings,
    openOverlaySettings,
    startCapture,
    stopCapture,
    testTap,
    showOverlay,
    hideOverlay,
    refreshOverlayVisible,
    showChessboard,
    hideChessboard,
    toggleChessboard,
    refreshChessboardVisible,
    isSampleRecording,
    toggleSampleRecording,
    samplePath,
    refreshNativeCounters,
    setAutoPlay,
    start,
    stop,
    stepOnce,
    resetSession,
    clearLogs,
    log,
    onNativeTick,
  }
}
