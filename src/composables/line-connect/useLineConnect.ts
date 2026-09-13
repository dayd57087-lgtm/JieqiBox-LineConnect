/**
 * Line connect (连线自动走棋) main loop.
 *
 * Pipeline per pass:
 *   screen capture -> YOLO recognition -> Jieqi FEN -> engine -> tap/drag
 *
 * The loop deliberately keeps only a very small state machine:
 *   - `expectedOpponentKey` records the position we produced ourselves, so the
 *     next differing position must come from the opponent.
 *   - `turn` is our belief about whose move it is. It is verified against the
 *     recognised board whenever the engine returns a move, and flipped if the
 *     engine tried to move one of the opponent's pieces.
 */
import { ref, watch } from 'vue'
import { LABELS, type DetectionBox } from '../image-recognition/types'
import {
  BOARD_COLS,
  BOARD_ROWS,
  JieqiPoolTracker,
  buildJieqiFen,
  countRevealedChars,
  fenPositionKey,
  gridToImagePoint,
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

export function useLineConnect(deps: LineConnectDeps) {
  const settings = ref<LineConnectSettings>({ ...DEFAULT_SETTINGS })
  const isRunning = ref(false)
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

  const overlayVisible = ref(false)
  const overlaySupported = ref(false)
  const tickCount = ref(0)

  const poolTracker = new JieqiPoolTracker()

  let timer: ReturnType<typeof setTimeout> | null = null
  let expectedOpponentKey: string | null = null
  let stableKey = ''
  let stableCount = 0
  let turn: 'w' | 'b' = 'w'
  let startedOnce = false
  let busy = false

  /**
   * When true the polling loop is driven by the native capture service rather
   * than by `setTimeout`. A webview that is not visible throttles its own
   * timers, so the native tick is what keeps the loop alive once the user
   * switches to the game app.
   */
  let nativeTickActive = false

  /** Move the next analysis should avoid (the "变招" / change-move action). */
  let avoidMove: string | null = null

  /** Timestamp of the last move we played, used for the waiting counter. */
  let lastMoveTime = 0

  let overlayListenerBound = false

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
    const api = (window as any).LineConnect
    return api ?? null
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
    log(ok ? 'info' : 'error', ok ? `已发送测试点击 (${Math.round(w / 2)}, ${Math.round(h / 2)})` : `测试点击失败：${api.lastGestureError?.()}`)
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  function loadImageElement(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('截图解码失败'))
      img.src = dataUrl
    })
  }

  function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  function charAt(grid: Grid, row: number, col: number): string | null {
    if (row < 0 || row >= BOARD_ROWS || col < 0 || col >= BOARD_COLS) return null
    const box = grid?.[row]?.[col] ?? null
    if (!box) return null
    const label = LABELS[box.labelIndex]?.name
    if (!label) return null
    if (label === 'Board') return null
    return label
  }

  function labelSide(label: string): 'w' | 'b' | null {
    if (label.startsWith('r_') || label.startsWith('dark_r')) return 'w'
    if (label.startsWith('b_') || label.startsWith('dark_b')) return 'b'
    if (label === 'dark') return 'w'
    return null
  }

  /* ------------------------------------------------------------------ */
  /* Engine interaction                                                  */
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
        () => engine.bestMove.value,
        value => {
          if (value) finish(String(value))
        },
        { immediate: false }
      )

      timeoutHandle = setTimeout(() => finish(null), timeoutMs)

      // Guard against a stale bestMove already sitting in the ref.
      const existing = engine.bestMove.value
      if (existing) {
        setTimeout(() => finish(String(existing)), 0)
      }
    })
  }

  async function analysePosition(fen: string): Promise<string | null> {
    const engine = deps.engine
    if (!engine.isEngineLoaded.value) {
      log('error', '尚未加载象棋引擎，请先在「引擎管理」中加载 UCI 引擎')
      return null
    }

    // Loading the position onto the app board keeps the UI in sync and lets the
    // engine use the exact same FEN the rest of the app produces.
    try {
      deps.game.loadFen(fen, false)
    } catch (e) {
      log('warn', `载入局面失败：${String(e)}`)
    }

    // "变招": restrict the search to every legal move except the previous one.
    let searchmoves: string[] = []
    if (avoidMove) {
      const banned = avoidMove.slice(0, 4)
      try {
        const all = (deps.game.getAllLegalMovesForCurrentPosition?.() ??
          []) as string[]
        searchmoves = all
          .map(m => String(m).slice(0, 4))
          .filter(m => m && m !== banned)
        if (!searchmoves.length) {
          log('warn', '没有可用的替代着法，按常规分析')
        } else {
          log('info', `变招：已排除 ${banned}，候选 ${searchmoves.length} 个着法`)
        }
      } catch (e) {
        log('warn', `计算候选着法失败：${String(e)}`)
      }
      avoidMove = null
    }

    engine.bestMove.value = ''
    engine.startAnalysis(
      { movetime: settings.value.thinkTimeMs },
      [],
      fen,
      searchmoves
    )

    const best = await waitForBestMove(settings.value.thinkTimeMs + 4000)
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

  async function performMove(
    uci: string,
    quad: BoardQuad,
    scale: number
  ): Promise<boolean> {
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

    if (settings.value.dryRun) {
      log('info', '演练模式：未实际点击屏幕')
      return true
    }

    const api = bridge()
    if (!api || !api.hasAccessibility()) {
      log('error', '无障碍服务未开启，无法自动落子')
      return false
    }

    if (settings.value.clickMode === 'drag') {
      const ok = api.swipe(fx, fy, tx, ty, 320)
      if (!ok) {
        log('error', `滑动失败：${api.lastGestureError?.() ?? ''}`)
      }
      return !!ok
    }

    const first = api.tap(fx, fy, 40)
    await delay(settings.value.clickGapMs)
    const second = api.tap(tx, ty, 40)
    if (!first || !second) {
      log('error', `点击失败：${api.lastGestureError?.() ?? ''}`)
      return false
    }
    return true
  }

  /* ------------------------------------------------------------------ */
  /* Floating control bar                                                */
  /* ------------------------------------------------------------------ */

  function openOverlaySettings() {
    try {
      bridge()?.openOverlaySettings?.()
      log('info', '已打开「显示在其他应用上层」设置，请为本应用开启')
    } catch (e) {
      log('error', `打开悬浮窗设置失败：${String(e)}`)
    }
  }

  function canDrawOverlays(): boolean {
    try {
      return !!bridge()?.canDrawOverlays?.()
    } catch {
      return false
    }
  }

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

  function evaluationText(): string {
    const raw = String(deps.engine?.analysis?.value ?? '').trim()
    if (!raw) return '评估 --'
    // Engine lines look like: "info depth 20 score cp 35 pv ..." — surface the score.
    const cp = raw.match(/score\s+cp\s+(-?\d+)/)
    if (cp) {
      const pawns = Number(cp[1]) / 100
      return `评估 ${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`
    }
    const mate = raw.match(/score\s+mate\s+(-?\d+)/)
    if (mate) return `评估 杀 ${mate[1]}`
    return '评估 --'
  }

  function turnText(): string {
    return `轮到${turn === 'w' ? '红方' : '黑方'}`
  }

  function statusText(): string {
    switch (phase.value) {
      case 'capturing':
      case 'recognising':
        return '识别中'
      case 'thinking':
        return '思考中'
      case 'moving':
        return '落子中'
      case 'waiting':
        return isRunning.value ? '等待对手' : '待机'
      default:
        return '待机'
    }
  }

  function waitingText(): string {
    if (!lastMoveTime) return '等待 0秒'
    const seconds = Math.max(0, Math.round((Date.now() - lastMoveTime) / 1000))
    return `等待 ${seconds}秒`
  }

  /** Pushes the current state into the floating bar. */
  function syncOverlay() {
    const api = bridge()
    if (!api?.updateOverlay) return
    if (!api.isOverlayVisible?.()) return
    try {
      api.updateOverlay(
        JSON.stringify({
          turn: turnText(),
          status: statusText(),
          evaluation: evaluationText(),
          waiting: waitingText(),
          autoRunning: isRunning.value,
          autoEnabled: hasAccessibility() && !!deps.engine?.isEngineLoaded?.value,
          scanEnabled: hasCapturePermission(),
        })
      )
    } catch {
      // ignore: the bar is best-effort
    }
  }

  /* ------------------------------------------------------------------ */
  /* Overlay actions                                                     */
  /* ------------------------------------------------------------------ */

  function handleOverlayAction(action: string) {
    switch (action) {
      case 'scan':
        log('info', '悬浮窗：执行一次识别')
        void stepOnce()
        break
      case 'auto':
        if (isRunning.value) stop()
        else start()
        break
      case 'variation':
        if (!lastMove.value) {
          log('warn', '悬浮窗：还没有可变更的着法')
          break
        }
        avoidMove = lastMove.value
        log('info', `悬浮窗：变招（排除 ${lastMove.value.slice(0, 4)}）`)
        break
      case 'newGame':
        log('info', '悬浮窗：重置为新对局')
        resetSession()
        break
      case 'board':
        log('info', '悬浮窗：切回 JieqiBox 查看棋盘')
        try {
          bridge()?.bringToFront?.()
        } catch {
          // ignore
        }
        break
      case 'close':
        log('info', '悬浮窗：已关闭')
        stop()
        hideOverlay()
        break
      default:
        break
    }
  }

  function bindOverlayListener() {
    if (overlayListenerBound) return
    overlayListenerBound = true
    window.addEventListener('line-connect-overlay', (event: Event) => {
      const action = (event as CustomEvent)?.detail?.action
      if (typeof action === 'string') handleOverlayAction(action)
    })
  }

  /** Clears per-game state so a new game can be tracked from scratch. */
  function resetSession() {
    poolTracker.reset()
    expectedOpponentKey = null
    stableKey = ''
    stableCount = 0
    startedOnce = false
    avoidMove = null
    lastMoveTime = 0
    moveCount.value = 0
    passes.value = 0
    errorCount.value = 0
    detectionCount.value = 0
    lastMove.value = ''
    lastFen.value = ''
    lastWarnings.value = []
    turn = settings.value.mySide
    syncOverlay()
  }

  /* ------------------------------------------------------------------ */
  /* Main loop                                                           */
  /* ------------------------------------------------------------------ */

  /** Entry point used by the native tick driver. */
  function onNativeTick() {
    tickCount.value++
    if (!isRunning.value) return
    syncOverlay()
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

  async function runOnce() {
    if (!isRunning.value || busy) return
    busy = true
    const started = Date.now()
    try {
      await tick()
    } catch (e) {
      errorCount.value++
      log('error', `识别轮次失败：${String(e)}`)
    } finally {
      busy = false
      if (isRunning.value) {
        if (!nativeTickActive) {
          const elapsed = Date.now() - started
          schedule(Math.max(120, settings.value.pollIntervalMs - elapsed))
        }
      }
      syncOverlay()
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

    const base64 = api.captureFrame()
    if (!base64) {
      phase.value = 'waiting'
      return
    }
    lastPreview.value = `data:image/jpeg;base64,${base64}`

    phase.value = 'recognising'
    const img = await loadImageElement(lastPreview.value)
    const boxes: DetectionBox[] =
      await deps.recognition.processImageElement(img)
    detectionCount.value = boxes.length

    const boardBox = deps.recognition.getBoardBox(boxes)
    boardDetected.value = !!boardBox
    if (!boardBox) {
      phase.value = 'waiting'
      lastWarnings.value = ['未识别到棋盘']
      return
    }

    const grid: Grid = deps.recognition.updateBoardGrid(boxes)
    const quad = quadFromBox(boardBox)

    // First build to learn which pieces are revealed in this frame...
    const probe = buildJieqiFen(
      grid,
      '-',
      turn,
      settings.value.minScore
    )
    poolTracker.observe(countRevealedChars(probe.rows))

    // ...then rebuild with the updated hidden pool.
    const result = buildJieqiFen(
      grid,
      poolTracker.poolFen(),
      turn,
      settings.value.minScore
    )
    lastFen.value = result.fen
    lastWarnings.value = result.warnings

    if (resultsLookUnusable(result)) {
      phase.value = 'waiting'
      return
    }

    const key = fenPositionKey(result.fen)
    if (key === stableKey) {
      stableCount++
    } else {
      stableKey = key
      stableCount = 1
    }

    if (stableCount < Math.max(1, settings.value.stableFrames)) {
      phase.value = 'waiting'
      return
    }

    // First pass after start: decide whether to act immediately.
    if (!startedOnce) {
      startedOnce = true
      if (!settings.value.assumeMyTurn) {
        expectedOpponentKey = key
        log('info', '等待对手先走一步…')
        phase.value = 'waiting'
        return
      }
    }

    if (expectedOpponentKey && expectedOpponentKey === key) {
      // Our own move is still on the board, the opponent has not replied yet.
      phase.value = 'waiting'
      return
    }

    // The board differs from what we left behind: the opponent has moved.
    if (expectedOpponentKey && expectedOpponentKey !== key) {
      log('info', '检测到对手走子')
    }
    expectedOpponentKey = null

    phase.value = 'thinking'
    let best = await analysePosition(result.fen)
    if (!best) {
      log('warn', '引擎未在预期时间内给出着法')
      phase.value = 'waiting'
      return
    }

    // Sanity check: the move must start on a piece belonging to the side we
    // believe is to move. If not, flip our belief and retry once.
    if (!moveStartsOnOwnPiece(grid, best, turn)) {
      const flipped: 'w' | 'b' = turn === 'w' ? 'b' : 'w'
      log(
        'warn',
        `引擎着法 ${best} 与推断的走子方不符，切换到${flipped === 'w' ? '红方' : '黑方'}重试`
      )
      turn = flipped
      const retryResult = buildJieqiFen(
        grid,
        poolTracker.poolFen(),
        turn,
        settings.value.minScore
      )
      lastFen.value = retryResult.fen
      best = await analysePosition(retryResult.fen)
      if (!best || !moveStartsOnOwnPiece(grid, best, turn)) {
        log('error', '无法确定当前走子方，请确认「我方执子」设置，或等待棋盘稳定后重试')
        phase.value = 'waiting'
        return
      }
    }

    phase.value = 'moving'
    const played = await performMove(best, quad, screenScale(captureStatus()))
    lastMove.value = best
    if (played) {
      moveCount.value++
      lastMoveTime = Date.now()
      // From now on we expect the opponent to answer.
      expectedOpponentKey = key
      turn = turn === 'w' ? 'b' : 'w'
      log('info', `已落子 ${best}，等待对手…`)
    } else {
      expectedOpponentKey = key
    }

    phase.value = 'waiting'
  }

  function resultsLookUnusable(result: {
    pieceCount: number
    warnings: string[]
  }): boolean {
    if (result.pieceCount < 6) return true
    return false
  }

  function moveStartsOnOwnPiece(
    grid: Grid,
    uci: string,
    side: 'w' | 'b'
  ): boolean {
    const squares = uciToSquares(uci)
    if (!squares) return false
    const label = charAt(grid, squares.from.row, squares.from.col)
    if (!label) return false
    const labelOwner = labelSide(label)
    if (!labelOwner) return true
    return labelOwner === side
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */

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
    resetSession()
    isRunning.value = true
    // Warm the model up in the background so the first pass is not slowed down
    // by a multi-second ONNX session creation.
    void Promise.resolve(deps.recognition.initializeModel?.()).catch(() => {})
    log(
      'info',
      `开始连线自动走棋（我方执${settings.value.mySide === 'w' ? '红' : '黑'}，${
        settings.value.dryRun ? '演练模式' : '自动落子'
      }）`
    )
    startLoopDriver()
    syncOverlay()
  }

  function stop(reason?: string) {
    stopLoopDriver()
    if (isRunning.value) {
      log('info', reason ? `已停止：${reason}` : '已停止连线自动走棋')
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

  /** Runs a single recognition pass without starting the loop. */
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

  // The floating bar is created by the native layer, so its taps arrive as
  // window events; the native tick driver calls back into onNativeTick.
  if (typeof window !== 'undefined') {
    bindOverlayListener()
    ;(window as any).__lineConnectTick__ = onNativeTick
  }

  return {
    settings,
    isRunning,
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
    isSupported,
    overlayVisible,
    overlaySupported,
    tickCount,
    supportsOverlay,
    showOverlay,
    hideOverlay,
    refreshOverlayVisible,
    canDrawOverlays,
    openOverlaySettings,
    syncOverlay,
    resetSession,
    onNativeTick,
    hasCapturePermission,
    isCapturing,
    hasAccessibility,
    captureStatus,
    requestCapturePermission,
    openAccessibilitySettings,
    startCapture,
    stopCapture,
    testTap,
    start,
    stop,
    stepOnce,
    clearLogs,
    log,
  }
}
