/**
 * Offline checks for the grid calibration and side detection added in 0.8.1.
 *
 * Run with:
 *   npx esbuild tools/test-grid.ts --bundle --platform=node --format=esm --outfile=/tmp/test-grid.mjs && node /tmp/test-grid.mjs
 */
import { LABELS, type DetectionBox } from '../src/composables/image-recognition/types'
import {
  buildGrid,
  buildJieqiFen,
  detectOrientation,
  emptyGrid,
  findMoveBetweenGrids,
  fitLattice,
  inferMoverSide,
  isStartPosition,
  labelToChar,
  latticeToPoint,
  mirrorGrid,
  moveLanded,
  sideAtCell,
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

const INDEX_BY_LABEL: Record<string, number> = {}
Object.entries(LABELS).forEach(([index, info]) => {
  INDEX_BY_LABEL[info.name] = Number(index)
})

function box(label: string, x: number, y: number, w = 48, h = 48, score = 0.9): DetectionBox {
  return { box: [x, y, w, h], score, labelIndex: INDEX_BY_LABEL[label] }
}

/**
 * Fabricates a detection pass the way the model reports it: a `Board` box plus
 * one box per piece, all in the analysed image's pixels.
 *
 * The board box is deliberately generous (the model boxes the whole wooden
 * board, margins included) and the piece centres sit on a lattice that is NOT
 * implied by that box - exactly the situation that made the naive mapping drift
 * by most of a cell at the edges.
 */
function fabricate(options: {
  cells: { row: number; col: number; label: string }[]
  boardBox: [number, number, number, number]
  originX: number
  originY: number
  stepX: number
  stepY: number
}): DetectionBox[] {
  const out: DetectionBox[] = [box('Board', ...options.boardBox, 0.95)]
  for (const cell of options.cells) {
    const x = options.originX + cell.col * options.stepX
    const y = options.originY + cell.row * options.stepY
    out.push(box(cell.label, x - 24, y - 24))
  }
  return out
}

/* ---------------------------------------------------------------- */
/* 1. lattice fit                                                    */
/* ---------------------------------------------------------------- */

console.log('lattice fit')
{
  const values: number[] = []
  for (let c = 0; c < 9; c++) values.push(100 + c * 100)
  const fit = fitLattice(values, 100)
  check('exact lattice step', fit ? Math.round(fit.step) : null, 100)
  check('exact lattice score > 0.95', fit ? fit.score > 0.95 : false, true)
  check('exact lattice residual 0', fit ? Math.round(fit.residual * 1000) : null, 0)

  // Only a few columns occupied (mid game), and with a real-world error of a
  // couple of pixels: the spacing must still come out right.
  const sparse = [126.5, 253.4, 379.9, 632.6, 1012.4, 1139.1]
  const fitSparse = fitLattice(sparse, 126.5)
  check('sparse lattice step', fitSparse ? Math.abs(fitSparse.step - 126.5) < 0.5 : false, true)

  // Too few points to be meaningful.
  check('two points rejected', fitLattice([100, 200], 100), null)
}

/* ---------------------------------------------------------------- */
/* 2. grid from an inflated board box                                */
/* ---------------------------------------------------------------- */

console.log('grid calibration')
{
  // Model geometry taken from a real screenshot: the piece lattice is
  // 126.5 x 124.5 px while the board box is roughly half a cell bigger on every
  // side. Mapping the box linearly puts the corner pieces ~0.75 of a cell off.
  const stepX = 126.5
  const stepY = 124.5
  const originX = 124
  const originY = 458
  const cells: { row: number; col: number; label: string }[] = []
  const corners = [
    { row: 0, col: 0, label: 'b_chariot' },
    { row: 0, col: 8, label: 'b_chariot' },
    { row: 9, col: 0, label: 'r_chariot' },
    { row: 9, col: 8, label: 'r_chariot' },
  ]
  for (const corner of corners) cells.push(corner)
  // A few more so the fit has something to work with.
  cells.push({ row: 0, col: 4, label: 'b_general' })
  cells.push({ row: 9, col: 4, label: 'r_general' })
  cells.push({ row: 2, col: 1, label: 'b_cannon' })
  cells.push({ row: 7, col: 7, label: 'r_cannon' })

  // Real screenshots show the board box covering the wooden board, i.e. clearly
  // wider than the lattice on every side (measured: ~0.75 cell on the left).
  const boardLeft = originX - stepX * 0.75
  const boardTop = originY - stepY * 0.75
  const boardW = stepX * 8 + stepX * 1.25
  const boardH = stepY * 9 + stepY * 1.25

  const boxes = fabricate({
    cells,
    boardBox: [boardLeft, boardTop, boardW, boardH],
    originX,
    originY,
    stepX,
    stepY,
  })

  const built = buildGrid(boxes)
  const placed: string[] = []
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      if (built.grid[r][c]) placed.push(`${r},${c}`)
    }
  }
  check('all pieces placed', placed.length, cells.length)
  check(
    'corners land on the correct squares',
    [
      !!built.grid[0][0],
      !!built.grid[0][8],
      !!built.grid[9][0],
      !!built.grid[9][8],
      !!built.grid[0][4],
      !!built.grid[9][4],
    ],
    [true, true, true, true, true, true]
  )
  check('nothing off-lattice', built.offLattice, 0)
  check('calibration used', built.calibration.used, true)
  check(
    'fitted step close to the truth',
    Math.abs(built.calibration.stepX - stepX) < 2 && Math.abs(built.calibration.stepY - stepY) < 2,
    true
  )

  // The un-calibrated mapping (board box taken as the lattice) must NOT be right,
  // otherwise this whole change would be pointless.
  const naive = originX - boardLeft
  check('naive mapping would have been wrong', naive > stepX / 2, true)

  const p00 = latticeToPoint(built.lattice, 0, 0)
  check(
    'lattice to point round trip',
    Math.abs(p00.x - built.lattice.originX) < 0.001 &&
      Math.abs(p00.y - built.lattice.originY) < 0.001,
    true
  )
}

/* ---------------------------------------------------------------- */
/* 3. masking our own overlay                                        */
/* ---------------------------------------------------------------- */

console.log('overlay masking')
{
  const boxes = fabricate({
    cells: [
      { row: 9, col: 0, label: 'r_chariot' },
      { row: 9, col: 4, label: 'r_general' },
      { row: 9, col: 8, label: 'r_chariot' },
      { row: 7, col: 1, label: 'r_cannon' },
    ],
    boardBox: [0, 0, 1200, 1300],
    originX: 100,
    originY: 100,
    stepX: 126.5,
    stepY: 124.5,
  })

  const withMask = buildGrid(boxes, {
    maskRects: [{ left: 0, top: 1150, width: 300, height: 200 }],
  })
  check('masked detection dropped', withMask.masked, 1)
  check('masked square empty', withMask.grid[9][0], null)
  check('unmasked square kept', !!withMask.grid[9][4], true)

  const withoutMask = buildGrid(boxes)
  check('nothing masked by default', withoutMask.masked, 0)
}

/* ---------------------------------------------------------------- */
/* 4. board orientation                                              */
/* ---------------------------------------------------------------- */

console.log('board orientation')
{
  const normal = emptyGrid()
  normal[0][4] = box('b_general', 0, 0)
  normal[9][4] = box('r_general', 0, 0)
  check('normal detected', detectOrientation(normal), 'normal')

  const flipped = emptyGrid()
  flipped[9][4] = box('b_general', 0, 0)
  flipped[0][4] = box('r_general', 0, 0)
  check('flipped detected', detectOrientation(flipped), 'flipped')

  check('mirror puts red back at the bottom', mirrorGrid(flipped)[9][4]?.labelIndex, INDEX_BY_LABEL['r_general'])

  const generalsOnly = emptyGrid()
  generalsOnly[9][4] = box('r_general', 0, 0)
  check('partial information tolerated', detectOrientation(generalsOnly), 'normal')
}

/* ---------------------------------------------------------------- */
/* 5. hidden pieces take their colour from the row                   */
/* ---------------------------------------------------------------- */

console.log('hidden piece colours')
{
  const upper = box('dark_b_chariot', 0, 0)
  const lower = box('dark_b_chariot', 0, 0)
  check('row 0 hidden is black', labelToChar(upper, 0), 'x')
  check('row 9 hidden is red', labelToChar(lower, 9), 'X')
  check('misclassified dark_r on the top half still black', labelToChar(box('dark_r_chariot', 0, 0), 1), 'x')
  check('misclassified dark_b on the bottom half still red', labelToChar(box('dark_b_chariot', 0, 0), 8), 'X')

  const grid = emptyGrid()
  grid[7][3] = box('dark_r_general', 0, 0)
  grid[2][3] = box('dark_r_general', 0, 0)
  check('sideAtCell uses the row', [sideAtCell(grid, 7, 3), sideAtCell(grid, 2, 3)], ['w', 'b'])
}

/* ---------------------------------------------------------------- */
/* 6. move detection, mover inference and verification               */
/* ---------------------------------------------------------------- */

console.log('move detection')
{
  const before = emptyGrid()
  before[9][4] = box('r_general', 0, 0)
  before[7][1] = box('r_cannon', 0, 0)
  before[0][4] = box('b_general', 0, 0)

  const after = emptyGrid()
  after[9][4] = box('r_general', 0, 0)
  after[7][1] = null as never
  after[7][4] = box('r_cannon', 0, 0)
  after[0][4] = box('b_general', 0, 0)

  check('move found', findMoveBetweenGrids(before, after), {
    from: { row: 7, col: 1 },
    to: { row: 7, col: 4 },
  })
  check('mover inferred as red', inferMoverSide(before, after)?.mover, 'w')
  check('move verified as landed', moveLanded(after, { from: { row: 7, col: 1 }, to: { row: 7, col: 4 } }), true)
  check(
    'move reported as not landed when the square is still occupied',
    moveLanded(before, { from: { row: 7, col: 1 }, to: { row: 7, col: 4 } }),
    false
  )

  // Two squares changing at once is ambiguous and must not be used.
  // Two squares filled at once cannot be attributed to a single move.
  const noisy = emptyGrid()
  noisy[9][4] = box('r_advisor', 0, 0)
  noisy[0][4] = box('b_general', 0, 0)
  noisy[5][5] = box('r_soldier', 0, 0)
  check('ambiguous difference rejected', findMoveBetweenGrids(before, noisy), null)
}

/* ---------------------------------------------------------------- */
/* 7. the FEN finally matches the side that is to move               */
/* ---------------------------------------------------------------- */

console.log('fen side')
{
  const grid = emptyGrid()
  grid[0][4] = box('b_general', 0, 0)
  grid[9][4] = box('r_general', 0, 0)
  check('start position recognised', isStartPosition(grid), false)
  const fen = buildJieqiFen(grid, '-', 'b').fen
  check('side field honoured', fen.split(' ')[1], 'b')
}

if (failures > 0) {
  console.log(`\n${failures} CHECK(S) FAILED`)
  process.exit(1)
}
console.log('\nALL GRID CHECKS PASSED')
