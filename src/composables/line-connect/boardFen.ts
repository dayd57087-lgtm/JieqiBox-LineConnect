/**
 * Conversion helpers between YOLO detections, Jieqi FEN strings and screen
 * coordinates. Everything in this file is a pure function (apart from the
 * stateful pool tracker) so it can be reasoned about and unit checked offline.
 */
import { LABELS, type DetectionBox } from '../image-recognition/types'

export type Grid = (DetectionBox | null)[][]

export const BOARD_ROWS = 10
export const BOARD_COLS = 9

/** Label name -> FEN character for revealed pieces. */
const CHAR_BY_LABEL: Record<string, string> = {
  r_general: 'K',
  r_advisor: 'A',
  r_elephant: 'B',
  r_horse: 'N',
  r_chariot: 'R',
  r_cannon: 'C',
  r_soldier: 'P',
  b_general: 'k',
  b_advisor: 'a',
  b_elephant: 'b',
  b_horse: 'n',
  b_chariot: 'r',
  b_cannon: 'c',
  b_soldier: 'p',
}

/**
 * Initial hidden piece pool of each side.
 * A Jieqi game starts with 15 hidden pieces per side (the general is revealed).
 */
export const INITIAL_POOL: Record<string, number> = {
  R: 2,
  N: 2,
  B: 2,
  A: 2,
  C: 2,
  P: 5,
  r: 2,
  n: 2,
  b: 2,
  a: 2,
  c: 2,
  p: 5,
}

/** Order used by useChessGame.generateFen. */
const POOL_ORDER = ['R', 'N', 'B', 'A', 'K', 'C', 'P']

export function emptyGrid(): Grid {
  return Array.from({ length: BOARD_ROWS }, () =>
    Array.from({ length: BOARD_COLS }, () => null as DetectionBox | null)
  )
}

/** True for every label that means "hidden piece". */
export function isDarkLabel(box: DetectionBox | null | undefined): boolean {
  if (!box) return false
  const label = LABELS[box.labelIndex]?.name
  if (!label) return false
  return label === 'dark' || label.startsWith('dark_')
}

/**
 * Maps a detection to its FEN character, or null when it is not a piece.
 *
 * Hidden pieces are the tricky case. On the board they are all drawn as the very
 * same blank disc, so no classifier can tell which colour is underneath - the
 * `dark_r_*` / `dark_b_*` labels are pure noise and are ignored on purpose.
 *
 * A hidden piece cannot cross the river before it is revealed (moving it is what
 * reveals it), so it always sits on its owner's half of the board. The row is
 * therefore the only trustworthy colour signal, which is exactly what
 * {@link hiddenCharForRow} encodes.
 *
 * @param row the lattice row the piece was mapped to (0 = black back rank)
 */
export function labelToChar(box: DetectionBox, row: number): string | null {
  const label = LABELS[box.labelIndex]?.name
  if (!label) return null
  const revealed = CHAR_BY_LABEL[label]
  if (revealed) return revealed
  if (label === 'dark' || label.startsWith('dark_')) return hiddenCharForRow(row)
  return null
}

/**
 * Side a lattice cell belongs to, using the same rule as {@link labelToChar}:
 * revealed pieces by case, hidden pieces by row.
 */
export function sideAtCell(
  grid: Grid | null | undefined,
  row: number,
  col: number
): 'w' | 'b' | null {
  if (row < 0 || row >= BOARD_ROWS || col < 0 || col >= BOARD_COLS) return null
  const box = grid?.[row]?.[col] ?? null
  if (!box) return null
  const ch = labelToChar(box, row)
  if (!ch) return null
  return charSide(ch)
}

/**
 * Colour of the side that owns the piece that just moved between two
 * observations, or null when the difference is ambiguous.
 *
 * Used to identify our colour without relying on the "the side to move
 * alternates" assumption: the piece that disappeared tells us who moved.
 */
export function inferMoverSide(
  previous: Grid,
  current: Grid
): { mover: 'w' | 'b'; from: { row: number; col: number }; to: { row: number; col: number } } | null {
  const move = findMoveBetweenGrids(previous, current)
  if (!move) return null
  const mover = sideAtCell(previous, move.from.row, move.from.col)
  if (!mover) return null
  return { mover, from: move.from, to: move.to }
}

/**
 * Locates the single move that separates two observed positions.
 *
 * Returns null unless the difference is unambiguous (exactly one square was
 * vacated and exactly one square was filled or replaced), which keeps detection
 * noise from being mistaken for a move.
 */
export function findMoveBetweenGrids(
  previous: Grid,
  current: Grid
): { from: { row: number; col: number }; to: { row: number; col: number } } | null {
  const vacated: { row: number; col: number }[] = []
  const filled: { row: number; col: number }[] = []

  for (let row = 0; row < BOARD_ROWS; row++) {
    for (let col = 0; col < BOARD_COLS; col++) {
      const before = previous?.[row]?.[col] ?? null
      const after = current?.[row]?.[col] ?? null
      if (before && !after) vacated.push({ row, col })
      else if (!before && after) filled.push({ row, col })
      else if (before && after && before.labelIndex !== after.labelIndex) {
        // A capture or a reveal: the square held something else before.
        filled.push({ row, col })
      }
    }
  }

  if (vacated.length !== 1 || filled.length !== 1) return null
  return { from: vacated[0], to: filled[0] }
}

/**
 * Whether a move actually landed on the board.
 *
 * The simplest reliable check is that the square the piece came from is now
 * empty. A tap that missed leaves the original position untouched, which is how
 * "the engine keeps suggesting the same move and nothing happens" used to look.
 */
export function moveLanded(
  gridAfter: Grid,
  expected: { from: { row: number; col: number }; to: { row: number; col: number } }
): boolean {
  const from = gridAfter?.[expected.from.row]?.[expected.from.col] ?? null
  return from === null
}

export function isHiddenChar(ch: string): boolean {
  return ch === 'X' || ch === 'x'
}

export function isRedChar(ch: string): boolean {
  return ch === ch.toUpperCase() && ch !== 'X'
}

/**
 * Colour of a FEN character.
 *
 * Note that this is not [isRedChar]: the hidden-piece token `X` is uppercase but
 * `isRedChar` deliberately excludes it (it is only meaningful for revealed
 * pieces), while here `X` really does mean a red hidden piece.
 */
export function charSide(ch: string): 'w' | 'b' {
  if (ch === 'X') return 'w'
  if (ch === 'x') return 'b'
  return ch === ch.toUpperCase() ? 'w' : 'b'
}

export function hiddenCharForRow(row: number): string {
  return row >= 5 ? 'X' : 'x'
}

/* ------------------------------------------------------------------------- */
/* Hidden piece pool tracking                                                */
/* ------------------------------------------------------------------------- */

/**
 * Tracks how many hidden pieces of each kind have been revealed so far by
 * watching the board across frames.
 *
 * Hidden pieces never turn back into hidden pieces, so the revealed counter is
 * monotonically increasing. Comparing against the historical maximum (instead
 * of the previous frame) keeps a single missed detection from inflating the
 * counter on the following frame.
 */
export class JieqiPoolTracker {
  private revealed: Record<string, number> = {}
  private maxOnBoard: Record<string, number> = {}
  private zeroStreak: Record<string, number> = {}

  /** How many consecutive empty frames before a kind is considered wiped out. */
  private static readonly ZERO_FRAMES = 2

  reset() {
    this.revealed = {}
    this.maxOnBoard = {}
    this.zeroStreak = {}
  }

  /**
   * Feeds one observed board into the tracker.
   *
   * Comparing against the historical maximum instead of the previous frame
   * keeps a single missed detection from inflating the revealed counter. When a
   * kind of piece disappears from the board for a couple of frames we assume it
   * was captured (or fully traded) and allow it to be counted again, which
   * covers the "two chariots revealed one after the other" case.
   */
  observe(charCounts: Record<string, number>) {
    for (const ch of Object.keys(INITIAL_POOL)) {
      const now = charCounts[ch] ?? 0
      const max = this.maxOnBoard[ch] ?? 0

      if (now > max) {
        this.revealed[ch] = (this.revealed[ch] ?? 0) + (now - max)
        this.maxOnBoard[ch] = now
        this.zeroStreak[ch] = 0
        continue
      }

      if (now === 0) {
        const streak = (this.zeroStreak[ch] ?? 0) + 1
        this.zeroStreak[ch] = streak
        if (streak >= JieqiPoolTracker.ZERO_FRAMES) {
          this.maxOnBoard[ch] = 0
        }
      } else {
        this.zeroStreak[ch] = 0
      }
    }
  }

  /** Remaining hidden pieces, formatted the way useChessGame expects. */
  poolFen(): string {
    let out = ''
    for (const upper of POOL_ORDER) {
      const lower = upper.toLowerCase()
      const redRemaining = Math.max(
        0,
        (INITIAL_POOL[upper] ?? 0) - (this.revealed[upper] ?? 0)
      )
      const blackRemaining = Math.max(
        0,
        (INITIAL_POOL[lower] ?? 0) - (this.revealed[lower] ?? 0)
      )
      if (redRemaining > 0) out += `${upper}${redRemaining}`
      if (blackRemaining > 0) out += `${lower}${blackRemaining}`
    }
    return out || '-'
  }

  snapshot(): { revealed: Record<string, number>; pool: string } {
    return { revealed: { ...this.revealed }, pool: this.poolFen() }
  }
}

/* ------------------------------------------------------------------------- */
/* Opening position detection                                                */
/* ------------------------------------------------------------------------- */

/**
 * Occupancy mask of the standard Jieqi opening position.
 *
 * The opening setup is fixed and highly distinctive, so recognising it gives a
 * reliable anchor: whoever plays red moves first, which pins down the side to
 * move for the rest of the game.
 */
const START_OCCUPANCY = [
  '111111111', // xxxxkxxxx
  '000000000', // 9
  '010000010', // 1x5x1
  '101010101', // x1x1x1x1x
  '000000000', // 9
  '000000000', // 9
  '101010101', // X1X1X1X1X
  '010000010', // 1X5X1
  '000000000', // 9
  '111111111', // XXXXKXXXX
]

/**
 * True when the grid matches the standard opening layout.
 *
 * Only occupancy and the two generals are checked: every other piece is hidden
 * at the start, so their identity carries no information.
 */
export function isStartPosition(grid: Grid): boolean {
  for (let row = 0; row < BOARD_ROWS; row++) {
    for (let col = 0; col < BOARD_COLS; col++) {
      const occupied = grid?.[row]?.[col] != null
      const expected = START_OCCUPANCY[row][col] === '1'
      if (occupied !== expected) return false
    }
  }

  // The generals must be on their own back rank; they are the only pieces that
  // are revealed from the very first move.
  const blackKing = labelToChar(grid[0][4]!, 0)
  const redKing = labelToChar(grid[9][4]!, 9)
  return blackKing === 'k' && redKing === 'K'
}

/**
 * Which way round the captured board is drawn.
 *
 * `normal` is the canonical layout (black at the top, red at the bottom) that
 * the rest of the app assumes. Many playing apps flip the board when the user
 * plays black, and feeding a mirrored position to the engine produces mirrored
 * moves - which is why this is checked on every pass.
 *
 * Only the generals are used: they are revealed from move one and never leave
 * their own palace, so their half of the board is a stable signal.
 */
export function detectOrientation(grid: Grid): 'normal' | 'flipped' | null {
  let redRow = -1
  let blackRow = -1
  for (let row = 0; row < BOARD_ROWS; row++) {
    for (let col = 0; col < BOARD_COLS; col++) {
      const ch = grid?.[row]?.[col] ? labelToChar(grid[row][col]!, row) : null
      if (ch === 'K') redRow = row
      else if (ch === 'k') blackRow = row
    }
  }
  if (redRow < 0 && blackRow < 0) return null
  if (redRow >= 7 && (blackRow < 0 || blackRow <= 2)) return 'normal'
  if (redRow >= 0 && redRow <= 2 && (blackRow < 0 || blackRow >= 7)) return 'flipped'
  return null
}

/** Rotates a grid by 180 degrees (row and col), i.e. undoes a flipped board. */
export function mirrorGrid(grid: Grid): Grid {
  const out = emptyGrid()
  for (let row = 0; row < BOARD_ROWS; row++) {
    for (let col = 0; col < BOARD_COLS; col++) {
      out[BOARD_ROWS - 1 - row][BOARD_COLS - 1 - col] = grid[row][col]
    }
  }
  return out
}

/* ------------------------------------------------------------------------- */
/* Grid -> FEN                                                               */
/* ------------------------------------------------------------------------- */

export interface FenBuildResult {
  fen: string
  rows: string[][]
  pieceCount: number
  hiddenCount: number
  revealedRed: number
  revealedBlack: number
  hasRedKing: boolean
  hasBlackKing: boolean
  warnings: string[]
}

function encodeRow(chars: string[]): string {
  let out = ''
  let empty = 0
  for (const ch of chars) {
    if (ch === '.') {
      empty++
      continue
    }
    if (empty > 0) {
      out += empty
      empty = 0
    }
    out += ch
  }
  if (empty > 0) out += empty
  return out
}

/**
 * Builds a new-format Jieqi FEN from a recognised grid.
 *
 * @param grid     10x9 detections produced by updateBoardGrid
 * @param pool     hidden piece pool string (see JieqiPoolTracker.poolFen)
 * @param sideToMove 'w' for red, 'b' for black
 * @param minScore detections below this confidence are ignored
 */
export function buildJieqiFen(
  grid: Grid,
  pool: string,
  sideToMove: 'w' | 'b',
  minScore = 0
): FenBuildResult {
  const rows: string[][] = []
  const charCounts: Record<string, number> = {}
  const warnings: string[] = []
  let pieceCount = 0
  let hiddenCount = 0
  let revealedRed = 0
  let revealedBlack = 0
  let hasRedKing = false
  let hasBlackKing = false

  for (let row = 0; row < BOARD_ROWS; row++) {
    const line: string[] = []
    for (let col = 0; col < BOARD_COLS; col++) {
      const box = grid?.[row]?.[col] ?? null
      let ch = '.'
      if (box && box.score >= minScore) {
        const mapped = labelToChar(box, row)
        if (mapped) {
          ch = mapped
        } else if (box.score >= minScore) {
          // Unknown label: treat as a hidden piece of the owning half so the
          // resulting FEN stays structurally valid.
          ch = hiddenCharForRow(row)
        }
      }
      if (ch !== '.') {
        pieceCount++
        if (isHiddenChar(ch)) {
          hiddenCount++
        } else if (ch === ch.toUpperCase()) {
          revealedRed++
          if (ch === 'K') hasRedKing = true
        } else {
          revealedBlack++
          if (ch === 'k') hasBlackKing = true
        }
        charCounts[ch] = (charCounts[ch] ?? 0) + 1
      }
      line.push(ch)
    }
    rows.push(line)
  }

  if (!hasRedKing) warnings.push('未识别到红方将/帅')
  if (!hasBlackKing) warnings.push('未识别到黑方将/帅')
  if (pieceCount < 4) warnings.push(`识别到的棋子过少（${pieceCount}）`)

  const boardFen = rows.map(encodeRow).join('/')
  const fen = `${boardFen} ${sideToMove} ${pool} - 0 1`

  return {
    fen,
    rows,
    pieceCount,
    hiddenCount,
    revealedRed,
    revealedBlack,
    hasRedKing,
    hasBlackKing,
    warnings,
  }
}

/** Counts revealed pieces per FEN character. */
export function countRevealedChars(rows: string[][]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const line of rows) {
    for (const ch of line) {
      if (ch === '.' || isHiddenChar(ch)) continue
      counts[ch] = (counts[ch] ?? 0) + 1
    }
  }
  return counts
}

/** Position key used for change detection (board + side to move). */
export function fenPositionKey(fen: string): string {
  const parts = fen.trim().split(/\s+/)
  return parts.slice(0, 2).join(' ')
}

/* ------------------------------------------------------------------------- */
/* Grid construction with lattice self-calibration                           */
/* ------------------------------------------------------------------------- */

/** Result of a one dimensional lattice fit. */
export interface LatticeFit {
  /** Spacing that best explains the observed centres, in pixels. */
  step: number
  /** Where the lattice points sit, modulo `step`. */
  phase: number
  /** How well the points line up (1 = perfect, 0 = random). */
  score: number
  /** Mean distance from a centre to its lattice point, in cells. */
  residual: number
}

/**
 * Fits a regular lattice to a set of coordinates.
 *
 * Piece centres always sit on integer lattice points, so their spacing can be
 * measured directly instead of being derived from the detected board box. This
 * matters because the `Board` box usually covers the whole wooden board with a
 * margin, which makes the naive mapping drift by most of a cell at the edges -
 * a left-flank piece then lands on the wrong column and the whole line of play
 * falls apart.
 *
 * The search is confined to +/-`range` around `expectedStep`, which keeps the
 * aliases at half and double the true step out of reach, and a mild pull towards
 * `expectedStep` breaks ties when only a few points are available.
 *
 * Returns null when the points cannot support a conclusion (too few, all bunched
 * together, or no convincing alignment), in which case the caller keeps the
 * box based mapping.
 */
export function fitLattice(
  values: number[],
  expectedStep: number,
  range = 0.25
): LatticeFit | null {
  if (values.length < 3 || !(expectedStep > 0)) return null

  const min = Math.min(...values)
  const max = Math.max(...values)
  // Points that all sit on one line carry no information about the spacing.
  if (max - min < expectedStep * 1.2) return null

  const lo = expectedStep * (1 - range)
  const hi = expectedStep * (1 + range)
  const steps = 300

  let bestStep = 0
  let bestScore = -1
  for (let i = 0; i <= steps; i++) {
    const s = lo + ((hi - lo) * i) / steps
    let cx = 0
    let cy = 0
    for (const v of values) {
      const phase = (v % s) / s
      const angle = 2 * Math.PI * phase
      cx += Math.cos(angle)
      cy += Math.sin(angle)
    }
    // Circular concentration: 1 when every centre sits on the same lattice
    // phase, ~0 when they are spread evenly.
    const concentration = Math.hypot(cx, cy) / values.length
    // Nudge towards the expected spacing so a near-alias cannot win by a hair.
    const penalty = 1 - 0.6 * Math.abs(s / expectedStep - 1)
    const score = concentration * penalty
    if (score > bestScore) {
      bestScore = score
      bestStep = s
    }
  }

  if (bestStep <= 0 || bestScore < 0.75) return null

  // Circular mean phase of the winning spacing.
  let cx = 0
  let cy = 0
  for (const v of values) {
    const angle = (2 * Math.PI * (v % bestStep)) / bestStep
    cx += Math.cos(angle)
    cy += Math.sin(angle)
  }
  const meanAngle = Math.atan2(cy, cx)
  let phase = ((meanAngle / (2 * Math.PI)) * bestStep) % bestStep
  if (phase < 0) phase += bestStep

  let residualSum = 0
  for (const v of values) {
    const off = (((v - phase) / bestStep) % 1 + 1) % 1
    residualSum += Math.min(off, 1 - off)
  }

  return {
    step: bestStep,
    phase,
    score: bestScore,
    residual: residualSum / values.length,
  }
}

/** Board region inside an analysed image, in that image's pixels. */
export interface BoardRegion {
  left: number
  top: number
  width: number
  height: number
}

export interface GridBuildResult {
  grid: Grid
  boardBox: DetectionBox | null
  /** Lattice geometry in the analysed image's pixels. */
  lattice: { originX: number; originY: number; stepX: number; stepY: number }
  /** Pieces the model found that could not be placed on a lattice point. */
  offLattice: number
  /** Squares two detections fought over. */
  overlaps: number
  /** How many detections were dropped because our own overlay covered them. */
  masked: number
  calibration: {
    used: boolean
    stepX: number
    stepY: number
    residualX: number
    residualY: number
    scoreX: number
    scoreY: number
  }
}

/**
 * Turns raw detections into the 10x9 lattice.
 *
 * Two things happen here that the previous implementation got wrong:
 *
 * 1. the lattice is re-fitted from the piece centres instead of being assumed to
 *    span the `Board` box, so edge columns do not drift;
 * 2. detections that fall inside one of our own floating windows are dropped,
 *    because the chessboard overlay is itself drawn on screen and would
 *    otherwise be captured along with the real board.
 *
 * @param boxes      detections in the analysed image's coordinate space
 * @param maskRects  rectangles (same space) covered by our own overlays
 */
export function buildGrid(
  boxes: DetectionBox[],
  options: { minScore?: number; maskRects?: BoardRegion[]; calibrate?: boolean } = {}
): GridBuildResult {
  const minScore = options.minScore ?? 0
  const maskRects = options.maskRects ?? []
  const calibrate = options.calibrate !== false

  const grid = emptyGrid()
  const result: GridBuildResult = {
    grid,
    boardBox: null,
    lattice: { originX: 0, originY: 0, stepX: 1, stepY: 1 },
    offLattice: 0,
    overlaps: 0,
    masked: 0,
    calibration: {
      used: false,
      stepX: 0,
      stepY: 0,
      residualX: 0,
      residualY: 0,
      scoreX: 0,
      scoreY: 0,
    },
  }

  const boardBox = boxes
    .filter(b => LABELS[b.labelIndex]?.name === 'Board')
    .sort((a, b) => b.score - a.score)[0]
  if (!boardBox) return result
  result.boardBox = boardBox

  const [bx, by, bw, bh] = boardBox.box

  const pieces: DetectionBox[] = []
  for (const box of boxes) {
    if (box.score < minScore) continue
    if (LABELS[box.labelIndex]?.name === 'Board') continue
    const cx = box.box[0] + box.box[2] / 2
    const cy = box.box[1] + box.box[3] / 2
    // Keep a little slack: a piece hugging the border may sit just outside.
    const slackX = bw * 0.12
    const slackY = bh * 0.08
    if (
      cx < bx - slackX ||
      cx > bx + bw + slackX ||
      cy < by - slackY ||
      cy > by + bh + slackY
    ) {
      continue
    }
    if (maskRects.some(r => pointInRect(cx, cy, r))) {
      result.masked++
      continue
    }
    pieces.push(box)
  }

  const centers = pieces.map(box => ({
    x: box.box[0] + box.box[2] / 2,
    y: box.box[1] + box.box[3] / 2,
  }))

  let stepX = bw / 8
  let stepY = bh / 9
  let originX = bx
  let originY = by

  if (calibrate && centers.length >= 3) {
    const fitX = fitLattice(centers.map(c => c.x), stepX)
    const fitY = fitLattice(centers.map(c => c.y), stepY)
    if (fitX) {
      // Anchor on the box centre (which is reliable) but with the measured
      // spacing (which the box is not).
      originX = anchorOrigin(fitX, bx + bw / 2, BOARD_COLS)
      stepX = fitX.step
      result.calibration.used = true
      result.calibration.stepX = fitX.step
      result.calibration.residualX = fitX.residual
      result.calibration.scoreX = fitX.score
    }
    if (fitY) {
      originY = anchorOrigin(fitY, by + bh / 2, BOARD_ROWS)
      stepY = fitY.step
      result.calibration.used = true
      result.calibration.stepY = fitY.step
      result.calibration.residualY = fitY.residual
      result.calibration.scoreY = fitY.score
    }
  }

  for (let i = 0; i < pieces.length; i++) {
    const box = pieces[i]
    const col = Math.round((centers[i].x - originX) / stepX)
    const row = Math.round((centers[i].y - originY) / stepY)
    if (row < 0 || row >= BOARD_ROWS || col < 0 || col >= BOARD_COLS) {
      result.offLattice++
      continue
    }
    const existing = grid[row][col]
    if (existing) {
      result.overlaps++
      if (existing.score >= box.score) continue
    }
    grid[row][col] = box
  }

  result.lattice = { originX, originY, stepX, stepY }
  return result
}

/** Chooses the lattice multiple whose centre matches `anchor`. */
function anchorOrigin(fit: LatticeFit, anchor: number, cells: number): number {
  const cellsFromOrigin = (cells - 1) / 2
  const k = Math.round((anchor - fit.phase) / fit.step - cellsFromOrigin)
  return fit.phase + k * fit.step
}

function pointInRect(x: number, y: number, rect: BoardRegion): boolean {
  return (
    x >= rect.left &&
    x <= rect.left + rect.width &&
    y >= rect.top &&
    y <= rect.top + rect.height
  )
}

/* ------------------------------------------------------------------------- */
/* Coordinates                                                               */
/* ------------------------------------------------------------------------- */

export interface BoardQuad {
  tl: { x: number; y: number }
  tr: { x: number; y: number }
  bl: { x: number; y: number }
  br: { x: number; y: number }
}

export function quadFromBox(box: DetectionBox): BoardQuad {
  const [x, y, w, h] = box.box
  return {
    tl: { x, y },
    tr: { x: x + w, y },
    bl: { x, y: y + h },
    br: { x: x + w, y: y + h },
  }
}

/**
 * Maps a board square to a point inside the captured image, using the same
 * bilinear interpolation as updateBoardGrid.
 */
export function gridToImagePoint(
  quad: BoardQuad,
  row: number,
  col: number
): { x: number; y: number } {
  const u = col / (BOARD_COLS - 1)
  const v = row / (BOARD_ROWS - 1)

  const topX = (1 - u) * quad.tl.x + u * quad.tr.x
  const topY = (1 - u) * quad.tl.y + u * quad.tr.y
  const botX = (1 - u) * quad.bl.x + u * quad.br.x
  const botY = (1 - u) * quad.bl.y + u * quad.br.y

  return {
    x: (1 - v) * topX + v * botX,
    y: (1 - v) * topY + v * botY,
  }
}

export function rowColToUci(row: number, col: number): string {
  return `${String.fromCharCode(97 + col)}${9 - row}`
}

/**
 * Maps a lattice coordinate to a pixel inside the analysed image, using the
 * fitted lattice rather than the detected board box.
 */
export function latticeToPoint(
  lattice: { originX: number; originY: number; stepX: number; stepY: number },
  row: number,
  col: number
): { x: number; y: number } {
  return {
    x: lattice.originX + col * lattice.stepX,
    y: lattice.originY + row * lattice.stepY,
  }
}

export function uciToRowCol(uci: string): { row: number; col: number } | null {
  if (!uci || uci.length < 2) return null
  const fromCol = uci.charCodeAt(0) - 97
  const fromRank = parseInt(uci[1], 10)
  if (Number.isNaN(fromRank)) return null
  if (fromCol < 0 || fromCol > 8) return null
  if (fromRank < 0 || fromRank > 9) return null
  return { row: 9 - fromRank, col: fromCol }
}

export function uciToSquares(uci: string): {
  from: { row: number; col: number }
  to: { row: number; col: number }
} | null {
  const from = uciToRowCol(uci.substring(0, 2))
  const to = uciToRowCol(uci.substring(2, 4))
  if (!from || !to) return null
  return { from, to }
}
