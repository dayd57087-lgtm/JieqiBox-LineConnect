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

/** Maps a detection to its FEN character, or null when it is not a piece. */
export function labelToChar(box: DetectionBox): string | null {
  const label = LABELS[box.labelIndex]?.name
  if (!label) return null
  const revealed = CHAR_BY_LABEL[label]
  if (revealed) return revealed
  if (label === 'dark') return 'X'
  if (label.startsWith('dark_')) {
    // dark_r_* / dark_b_* encode the colour of the hidden piece.
    return label.startsWith('dark_r') ? 'X' : 'x'
  }
  return null
}

export function isHiddenChar(ch: string): boolean {
  return ch === 'X' || ch === 'x'
}

export function isRedChar(ch: string): boolean {
  return ch === ch.toUpperCase() && ch !== 'X'
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
        const mapped = labelToChar(box)
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
