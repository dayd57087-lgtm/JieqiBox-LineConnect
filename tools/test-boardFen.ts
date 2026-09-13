/**
 * Offline sanity checks for the board <-> FEN conversion used by the
 * line-connect feature. Run with:
 *   npx esbuild tools/test-boardFen.ts --bundle --platform=node --format=esm --outfile=/tmp/test-boardFen.mjs && node /tmp/test-boardFen.mjs
 */
import { LABELS, type DetectionBox } from '../src/composables/image-recognition/types'
import {
  JieqiPoolTracker,
  buildJieqiFen,
  countRevealedChars,
  emptyGrid,
  fenPositionKey,
  gridToImagePoint,
  quadFromBox,
  uciToSquares,
  rowColToUci,
  type Grid,
} from '../src/composables/line-connect/boardFen'

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.log(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`)
  }
}

/* ---------------------------------------------------------------- */
/* helpers to fabricate detections from a FEN board                  */
/* ---------------------------------------------------------------- */

const LABEL_BY_CHAR: Record<string, string> = {
  K: 'r_general',
  A: 'r_advisor',
  B: 'r_elephant',
  N: 'r_horse',
  R: 'r_chariot',
  C: 'r_cannon',
  P: 'r_soldier',
  k: 'b_general',
  a: 'b_advisor',
  b: 'b_elephant',
  n: 'b_horse',
  r: 'b_chariot',
  c: 'b_cannon',
  p: 'b_soldier',
  X: 'dark_r_advisor',
  x: 'dark_b_advisor',
}

const INDEX_BY_LABEL: Record<string, number> = {}
Object.entries(LABELS).forEach(([index, info]) => {
  INDEX_BY_LABEL[info.name] = Number(index)
})

function boardRowsFromFen(boardPart: string): string[][] {
  return boardPart.split('/').map(row => {
    const cells: string[] = []
    for (const ch of row) {
      if (/\d/.test(ch)) {
        for (let i = 0; i < Number(ch); i++) cells.push('.')
      } else {
        cells.push(ch)
      }
    }
    return cells
  })
}

function gridFromBoard(rows: string[][]): Grid {
  const grid = emptyGrid()
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      const ch = rows[r][c]
      if (ch === '.') continue
      const label = LABEL_BY_CHAR[ch]
      if (!label) throw new Error(`no label for ${ch}`)
      const box: DetectionBox = {
        box: [c * 50, r * 50, 48, 48],
        score: 0.9,
        labelIndex: INDEX_BY_LABEL[label],
      }
      grid[r][c] = box
    }
  }
  return grid
}

/* ---------------------------------------------------------------- */
/* 1. START_FEN round trip                                           */
/* ---------------------------------------------------------------- */

const START_BOARD =
  'xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/9/XXXXKXXXX'
const START_POOL = 'A2B2N2R2C2P5a2b2n2r2c2p5'

console.log('start position round trip')
{
  const rows = boardRowsFromFen(START_BOARD)
  const grid = gridFromBoard(rows)
  const result = buildJieqiFen(grid, START_POOL, 'w')
  check('board part', result.fen.split(' ')[0], START_BOARD)
  check('piece count', result.pieceCount, 32)
  check('hidden count', result.hiddenCount, 30)
  check('has both kings', [result.hasRedKing, result.hasBlackKing], [true, true])
  check(
    'generated pool matches tracker start',
    result.fen.split(' ')[2],
    START_POOL
  )
  check('warnings empty', result.warnings, [])
}

/* ---------------------------------------------------------------- */
/* 2. pool tracker behaviour                                         */
/* ---------------------------------------------------------------- */

console.log('hidden pool tracker')
{
  const tracker = new JieqiPoolTracker()
  const initialPool = 'R2r2N2n2B2b2A2a2C2c2P5p5'

  // frame 1: only the two generals are revealed -> pool unchanged
  let grid = gridFromBoard(boardRowsFromFen(START_BOARD))
  let r = buildJieqiFen(grid, '-', 'w')
  tracker.observe(countRevealedChars(r.rows))
  check('initial pool', tracker.poolFen(), initialPool)

  // frame 2: a red chariot gets revealed on row 9 col 0
  grid[9][0] = {
    box: [0, 450, 48, 48],
    score: 0.9,
    labelIndex: INDEX_BY_LABEL['r_chariot'],
  }
  r = buildJieqiFen(grid, tracker.poolFen(), 'w')
  tracker.observe(countRevealedChars(r.rows))
  check('one red chariot revealed', tracker.poolFen().includes('R1'), true)

  // frame 3: single-frame miss by the detector -> must not change the pool
  grid[9][0] = null
  r = buildJieqiFen(grid, tracker.poolFen(), 'w')
  tracker.observe(countRevealedChars(r.rows))
  check('missed detection keeps pool', tracker.poolFen().includes('R1'), true)

  // frame 4: the chariot is detected again -> still no double counting
  grid[9][0] = {
    box: [0, 450, 48, 48],
    score: 0.9,
    labelIndex: INDEX_BY_LABEL['r_chariot'],
  }
  r = buildJieqiFen(grid, tracker.poolFen(), 'w')
  tracker.observe(countRevealedChars(r.rows))
  check('recovered detection does not inflate', tracker.poolFen().includes('R1'), true)

  // frames 5-6: the chariot is gone for good (captured)
  grid[9][0] = null
  r = buildJieqiFen(grid, tracker.poolFen(), 'w')
  tracker.observe(countRevealedChars(r.rows))
  tracker.observe(countRevealedChars(r.rows))

  // frame 7: a second red chariot shows up on the other square
  grid[9][1] = {
    box: [50, 450, 48, 48],
    score: 0.9,
    labelIndex: INDEX_BY_LABEL['r_chariot'],
  }
  r = buildJieqiFen(grid, tracker.poolFen(), 'w')
  tracker.observe(countRevealedChars(r.rows))
  check(
    'second chariot counted after the first disappeared',
    tracker.poolFen().includes('R'),
    false
  )
  check('other kinds untouched', tracker.poolFen().includes('N2'), true)
}

/* ---------------------------------------------------------------- */
/* 3. coordinates                                                    */
/* ---------------------------------------------------------------- */

console.log('coordinates')
{
  const quad = quadFromBox({ box: [100, 200, 800, 900], score: 1, labelIndex: 4 })
  const topLeft = gridToImagePoint(quad, 0, 0)
  check('top-left corner', [Math.round(topLeft.x), Math.round(topLeft.y)], [100, 200])
  const bottomRight = gridToImagePoint(quad, 9, 8)
  check(
    'bottom-right corner',
    [Math.round(bottomRight.x), Math.round(bottomRight.y)],
    [900, 1100]
  )
  const centre = gridToImagePoint(quad, 4.5, 4)
  check('centre', [Math.round(centre.x), Math.round(centre.y)], [500, 650])

  check('red bottom-left uci', rowColToUci(9, 0), 'a0')
  check('black top-right uci', rowColToUci(0, 8), 'i9')
  check('parse a0i9', uciToSquares('a0i9'), {
    from: { row: 9, col: 0 },
    to: { row: 0, col: 8 },
  })
  check('position key ignores pool', fenPositionKey('abc w X1 - 0 1'), 'abc w')
}

/* ---------------------------------------------------------------- */
/* 4. degraded input                                                 */
/* ---------------------------------------------------------------- */

console.log('degraded input')
{
  const grid = emptyGrid()
  const result = buildJieqiFen(grid, START_POOL, 'w')
  check('empty board board part', result.fen.split(' ')[0], '9/9/9/9/9/9/9/9/9/9')
  check('empty board warns', result.warnings.length > 0, true)
}

console.log('')
if (failures === 0) {
  console.log('ALL CHECKS PASSED')
} else {
  console.log(`${failures} CHECK(S) FAILED`)
  process.exitCode = 1
}
