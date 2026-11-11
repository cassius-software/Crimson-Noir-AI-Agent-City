// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the furnishing rules for the seven homes (01_Initialize_World/properties.ts): the
 * shape of each of Lintel & Lumen's nine furniture lines on the floor plan (homeGrid.ts), how a piece turns, which
 * cells it fills and which it leaves walkable, the one rule that says whether a piece may go where the player puts it
 * (canPlace), how a saved layout is fitted to a home when it is drawn (fitLayout), how many kinds of furniture stand
 * in a home (comfortOf: a rest at home's comfort), the floor and wall finishes, the show homes' layouts, and the boxes
 * all of these are drawn and made solid with, in the room frame. It is pure and page-safe, and it imports only
 * homeGrid.ts.
 *
 * The room frame is interiors.ts's: u from the back wall toward the doorway, v across, y up. A piece's own cells run x
 * across its width and y from its back (y = 0) to its front. Turn 0 puts its back to the back wall, turn 1 to the +v
 * wall, turn 2 to the doorway's wall and turn 3 to the −v wall; (c, r) is the lowest column and row it covers after
 * turning. Finishes are named by the building material's style names ('concrete', 'deck', ...); the page maps the
 * names to numbers.
 *
 * Nobody is ever walled out of a home or shut in one: the apron in front of the doorway is never used, and a piece is
 * refused when it would cut off any cell that could be walked to from the apron, any workstation's seat, or the way out
 * of someone standing inside a piece that has not yet turned solid.
 * What breaks if it is removed? Nothing could be placed in a home, nothing would say a layout leaves the way in open,
 * and the show homes, the finishes and the furniture's colliders would have no shapes.
 */
import { APRON, CELL, DEPTH, GRID, GRID_HALF, HOME_PIECES, INSET, backEdge, inApron, inMask } from './homeGrid.ts'

// ---------------------------------------------------------------- the numbers

/** How far a piece's boxes stand inside its cells, and its collider inside its solid, m: two pieces side by side never touch. */
export const PIECE_INSET = 0.01
/** A solid that reaches no further than this into a cell leaves that cell walkable, m (so a free cell is at least 0.758 m wide). */
export const COVER = 0.01
/** A piece's tallest top, m: 10 cm under the ceiling slab. */
export const PIECE_TOP = 4.1
/** The solid is the bounding rectangle of every box that starts below this height, m... */
export const SOLID_FROM = 1.8
/** ... and stands as tall as the highest of them, but never taller than this, m. */
export const SOLID_MAX = 2.4
/** The glass's inner faces in the room frame, m (GRID_HALF + INSET: the walls are 0.5 m thick on a 13 m half-lot). */
export const GLASS = GRID_HALF + INSET
/** Half the doorway's width, m (interiors.ts ROOM.door, which homeLayout.test.ts pins: this file imports only homeGrid.ts). */
export const DOORWAY = 2
/** Floor to the ceiling slab's underside, m (interiors.ts ROOM.height, pinned the same way). */
export const CEILING = 4.2
/** The wall panels, m: how thick, how far off the glass's inner faces and the fill block's face, and how far back from the doorway's edges. */
export const PANEL = Object.freeze({ thick: 0.02, gap: 0.012, door: 0.02 })
/** The floor overlay's bottom and top above the floor's base, m: thin, and under every piece's lowest box top. */
export const OVERLAY = Object.freeze({ y0: 0.003, y1: 0.015 })
/** The catalogue id of the first furniture line (storeCatalog.ts): line id's furniture bit is id − FURNITURE_BASE. */
export const FURNITURE_BASE = 160

// ---------------------------------------------------------------- the finishes

/** The material styles a home's pieces and finishes are drawn in, by name (city.ts STYLE, and the two furnishing adds). */
export const FINISHES = Object.freeze(['concrete', 'deck', 'trim', 'masonry', 'rail', 'lit', 'planted'] as const)
export type Finish = (typeof FINISHES)[number]

/** A floor or wall finish: the name a player reads, and the style it is drawn in (null: nothing drawn, the glass shows). */
export interface FinishLine { readonly name: string; readonly style: Finish | null }

/**
 * The floors, by index (shipped data: a saved layout names one by its index). A floor is the top face of the overlay,
 * and the material draws an up face as its grey membrane unless the style is deck or trim, so concrete reads polished.
 */
export const FLOORS: readonly FinishLine[] = Object.freeze([
  Object.freeze({ name: 'Polished concrete', style: 'concrete' }),
  Object.freeze({ name: 'Oak boards', style: 'deck' }),
  Object.freeze({ name: 'Limestone', style: 'trim' }),
] satisfies FinishLine[])

/** The walls, by index (shipped data, like the floors). Glass has no panels; every other finish is five panels (wallPanels). */
export const WALLS: readonly FinishLine[] = Object.freeze([
  Object.freeze({ name: 'Glass', style: null }),
  Object.freeze({ name: 'Exposed brick', style: 'masonry' }),
  Object.freeze({ name: 'Oak panelling', style: 'deck' }),
  Object.freeze({ name: 'Limestone', style: 'trim' }),
  Object.freeze({ name: 'Board-formed concrete', style: 'concrete' }),
  Object.freeze({ name: 'Blackened steel', style: 'rail' }),
] satisfies FinishLine[])

/** Each home's finishes until its owner picks others, by property index: the brownstone in oak and brick, the timber loft all oak, the rest concrete and glass. */
export const DEFAULT_FINISH: readonly Readonly<{ floor: number; wall: number }>[] = Object.freeze(
  [[0, 0], [1, 1], [1, 2], [0, 0], [0, 0], [0, 0], [0, 0]].map(([floor, wall]) => Object.freeze({ floor, wall })),
)

// ---------------------------------------------------------------- the shapes

/** A rectangle in a piece's own cells: [x0, y0, x1, y1], x across its width, y from its back to its front. */
export type Rect = readonly [number, number, number, number]

/** One box of a piece: its rectangle in the piece's cells, the heights it stands between (m) and its finish. */
export interface ShapeBox { readonly rect: Rect; readonly y0: number; readonly y1: number; readonly finish: Finish }

/** A furniture line's shape. Shipped data, like the catalogue: a saved layout names its id and its cells. */
export interface Shape {
  /** The catalogue id (storeCatalog.ts), and so its furniture bit: id − FURNITURE_BASE. */
  readonly id: number
  /** Exactly the catalogue line's name. */
  readonly name: string
  /** Its footprint in whole cells: w across, d from back to front (d × w at an odd turn). */
  readonly w: number
  readonly d: number
  /** A wall piece must stand with its back on the floor plan's edge. */
  readonly wall: boolean
  /** The most of this line one home holds. */
  readonly cap: number
  /** At most four boxes, none above PIECE_TOP. */
  readonly boxes: readonly ShapeBox[]
  /**
   * Where a posted agent stands at the piece (stationOf), in the piece's cells, or null. A piece with one keeps its seat
   * (the cells of its footprint its solid leaves walkable) reserved: nothing else may use those cells, and they are
   * never cut off.
   */
  readonly station: readonly [number, number] | null
}

const part = (x0: number, y0: number, x1: number, y1: number, h0: number, h1: number, finish: Finish): ShapeBox =>
  Object.freeze({ rect: Object.freeze([x0, y0, x1, y1] as const), y0: h0, y1: h1, finish })

const line = (id: number, name: string, w: number, d: number, wall: boolean, cap: number, boxes: ShapeBox[], station: readonly [number, number] | null = null): Shape =>
  Object.freeze({ id, name, w, d, wall, cap, boxes: Object.freeze(boxes), station: station && Object.freeze(station) })

/**
 * The nine furniture lines, by catalogue id. The sofa's seat runs between its arms rather than under them, so no two
 * of its boxes share a face; nothing else differs from the plan's table. Screens and the hologram's field are lit,
 * because glass this low would draw as a shop's glazing; the bar is coffee and juice only.
 */
export const SHAPES: Readonly<Record<number, Shape>> = Object.freeze({
  160: line(160, 'Curved walnut executive desk', 3, 2, false, 2, [
    part(0, 0.5, 3, 1.5, 0.72, 0.76, 'deck'), // the top
    part(0.1, 0.55, 0.7, 1.45, 0, 0.72, 'deck'), // the two pedestals
    part(2.3, 0.55, 2.9, 1.45, 0, 0.72, 'deck'),
    part(2.25, 1.5, 2.95, 1.95, 0, 0.76, 'deck'), // the return: the curve, read as an L
  ]),
  161: line(161, 'Six-screen console station', 3, 2, false, 2, [
    part(0, 0.5, 3, 1.4, 0, 0.76, 'deck'), // the desk
    part(1.3, 0.2, 1.7, 0.5, 0, 0.95, 'rail'), // the post
    part(0.15, 0.2, 2.85, 0.45, 0.95, 1.95, 'lit'), // the screens
  ]),
  162: line(162, 'Holographic city table', 3, 3, false, 1, [
    part(0.6, 0.6, 2.4, 2.4, 0, 0.85, 'concrete'), // the plinth
    part(0.4, 0.4, 2.6, 2.6, 0.85, 1.35, 'lit'), // the field of light its name promises
  ]),
  163: line(163, 'Modular sectional sofa', 4, 2, false, 3, [
    part(0, 0, 4, 0.5, 0, 0.85, 'trim'), // the back
    part(0.35, 0.5, 3.65, 1.6, 0, 0.42, 'trim'), // the seat, between the arms
    part(0, 0.5, 0.35, 1.6, 0, 0.62, 'trim'), // the two arms
    part(3.65, 0.5, 4, 1.6, 0, 0.62, 'trim'),
  ]),
  164: line(164, 'Floor-to-ceiling bookcase', 3, 1, true, 6, [
    part(0, 0, 3, 0.55, 0, 4.1, 'deck'), // the carcass
  ]),
  165: line(165, 'Espresso and juice bar', 3, 2, true, 1, [
    part(0, 0, 3, 0.4, 0, 2.2, 'deck'), // the back shelf
    part(0, 1.0, 3, 1.8, 0, 1.05, 'masonry'), // the counter
    part(0, 0.95, 3, 1.85, 1.05, 1.1, 'trim'), // its top
    part(0.3, 1.2, 0.9, 1.6, 1.1, 1.5, 'rail'), // the espresso machine
  ]),
  166: line(166, 'Acoustic grand piano', 2, 3, false, 1, [
    part(0.4, 0.6, 1.6, 2.4, 0, 0.62, 'rail'), // the base
    part(0.1, 0.3, 1.9, 2.6, 0.62, 1.0, 'rail'), // the case
    part(0.6, 2.65, 1.4, 3, 0, 0.48, 'rail'), // the bench
  ]),
  167: line(167, 'Hydroponic green wall', 4, 1, true, 4, [
    part(0, 0, 4, 0.35, 0, 3.2, 'rail'), // the frame
    part(0.1, 0.35, 3.9, 0.55, 0.3, 3.1, 'planted'), // the planting
  ]),
  168: line(168, 'Agent workstation', 2, 2, false, 8, [
    part(0, 0.05, 2, 0.95, 0, 0.76, 'deck'), // the desk
    part(0.3, 0.1, 1.7, 0.25, 0.76, 1.45, 'lit'), // the screen
  ], [1, 1.5]), // the front row is the seat
})

/** The furniture lines' ids, in catalogue order. */
export const SHAPE_IDS: readonly number[] = Object.freeze(Object.keys(SHAPES).map(Number).sort((a, b) => a - b))

/** The shape of line `id`, or null when no furniture line has that id. */
export function shapeOf(id: number): Shape | null {
  return Object.hasOwn(SHAPES, id) ? SHAPES[id] : null
}

/** A piece's solid: its one collider before the inset, a rectangle in the piece's cells, from the floor to `top` (m). */
export interface Solid { readonly rect: Rect; readonly top: number }

/** The solid derived from a shape: the bounding rectangle of every box that starts below SOLID_FROM, min(SOLID_MAX, their highest top) tall. */
function deriveSolid(s: Shape): Solid {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, top = 0
  for (const b of s.boxes) {
    if (b.y0 >= SOLID_FROM) continue
    x0 = Math.min(x0, b.rect[0]); y0 = Math.min(y0, b.rect[1]); x1 = Math.max(x1, b.rect[2]); y1 = Math.max(y1, b.rect[3])
    top = Math.max(top, b.y1)
  }
  return Object.freeze({ rect: Object.freeze([x0, y0, x1, y1] as const), top: Math.min(SOLID_MAX, top) })
}

const SOLIDS: ReadonlyMap<number, Solid> = new Map(SHAPE_IDS.map((id) => [id, deriveSolid(SHAPES[id])]))

/** The solid of line `id` (derived from its boxes, never stored), or null when no furniture line has that id. */
export function solidOf(id: number): Solid | null {
  return SOLIDS.get(id) ?? null
}

// ---------------------------------------------------------------- pieces and turning

/** A placed piece: the line's catalogue id, the lowest column and row its footprint covers, and its turn 0..3. */
export interface Piece { readonly id: number; readonly c: number; readonly r: number; readonly rot: number }

/** A piece's footprint on the grid: columns c to c + cols − 1, rows r to r + rows − 1. */
export interface Footprint { c: number; r: number; cols: number; rows: number }

/** The shape of a well-formed piece (a furniture line, whole-number cells, a turn of 0 to 3), or null. */
function shapeOfPiece(p: Piece): Shape | null {
  if (!Number.isInteger(p.c) || !Number.isInteger(p.r) || !Number.isInteger(p.rot) || p.rot < 0 || p.rot > 3) return null
  return shapeOf(p.id)
}

/** A point (x, y) of a w × d piece's own cells, at turn `rot`, as (column, row) offsets from its footprint's lowest corner. */
function turn(x: number, y: number, w: number, d: number, rot: number): [number, number] {
  switch (rot & 3) {
    case 0: return [x, y]
    case 1: return [d - y, x] // the back (y = 0) to the +v wall: the highest column
    case 2: return [w - x, d - y] // the back to the doorway's wall: the highest row
    default: return [y, w - x] // the back to the −v wall: the lowest column
  }
}

/**
 * A rectangle of a w × d piece's own cells at turn `rot`, as [column0, row0, column1, row1] offsets from its
 * footprint's lowest corner (a d × w footprint at an odd turn). A quarter turn of the result, taken as a d × w piece,
 * is the next turn: four quarter turns give the rectangle back.
 */
export function rotateBox(rect: Rect, w: number, d: number, rot: number): Rect {
  const [a0, b0] = turn(rect[0], rect[1], w, d, rot), [a1, b1] = turn(rect[2], rect[3], w, d, rot)
  return [Math.min(a0, a1), Math.min(b0, b1), Math.max(a0, a1), Math.max(b0, b1)]
}

/**
 * Where a piece's posted agent stands and which way they face, in the room frame (u toward the doorway, v across, m),
 * or null for a piece with no station or not well formed: the shape's station turned with the piece, facing the cell
 * behind it (the piece's back). For line 168 at turn 0 that is the edge between its two seat cells, facing the screen.
 */
export function stationOf(p: Piece): { u: number; v: number; fu: number; fv: number } | null {
  const s = shapeOfPiece(p)
  if (!s?.station) return null
  const [x, y] = s.station
  const [c0, r0] = rotateBox([x, y, x, y], s.w, s.d, p.rot)
  const [c1, r1] = rotateBox([x, y - 1, x, y - 1], s.w, s.d, p.rot)
  return { u: -GRID_HALF + (p.r + r0) * CELL, v: -GRID_HALF + (p.c + c0) * CELL, fu: r1 - r0, fv: c1 - c0 }
}

/** The pieces of `placed` with a station (the workstations), in reading order: back row first, then left to right. */
export const stationsIn = (placed: readonly Piece[]): Piece[] => placed.filter((p) => stationOf(p)).sort((a, b) => a.r - b.r || a.c - b.c)

/** A piece's footprint, or null when it is not a well-formed piece. */
export function footprint(p: Piece): Footprint | null {
  const s = shapeOfPiece(p)
  if (!s) return null
  const odd = (p.rot & 1) === 1
  return { c: p.c, r: p.r, cols: odd ? s.d : s.w, rows: odd ? s.w : s.d }
}

/** Which of a footprint's cells (by j · cols + i) the solid blocks, and which are a seat, for one line at one turn. */
interface Pattern { cols: number; rows: number; blocked: Uint8Array; seat: Uint8Array }

/**
 * The cells line `s` blocks at turn `rot`: those its solid, inset PIECE_INSET, covers by more than COVER both ways.
 * A piece with a station has the rest of its footprint as its seat.
 */
function patternOf(s: Shape, rot: number): Pattern {
  const odd = (rot & 1) === 1
  const cols = odd ? s.d : s.w, rows = odd ? s.w : s.d
  const [a0, b0, a1, b1] = rotateBox(SOLIDS.get(s.id)!.rect, s.w, s.d, rot)
  const lo = (x: number) => x * CELL + PIECE_INSET, hi = (x: number) => x * CELL - PIECE_INSET
  const blocked = new Uint8Array(cols * rows), seat = new Uint8Array(cols * rows)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const across = Math.min(hi(a1), (i + 1) * CELL) - Math.max(lo(a0), i * CELL)
      const along = Math.min(hi(b1), (j + 1) * CELL) - Math.max(lo(b0), j * CELL)
      const solid = across > COVER && along > COVER
      blocked[j * cols + i] = solid ? 1 : 0
      seat[j * cols + i] = !solid && s.station !== null ? 1 : 0
    }
  }
  return { cols, rows, blocked, seat }
}

/** Every line's pattern at every turn, by id · 4 + turn, worked out once when the module loads. */
const PATTERNS: ReadonlyMap<number, Pattern> = new Map(SHAPE_IDS.flatMap((id) => [0, 1, 2, 3].map((rot): [number, Pattern] => [id * 4 + rot, patternOf(SHAPES[id], rot)])))

/** The index of cell (c, r) in a GRID × GRID cell table: r · GRID + c. */
export const cellIndex = (c: number, r: number): number => r * GRID + c

/** A piece's cells as cell-table indices: every cell of its footprint, those its solid blocks, and its seat. Empty when it is not well-formed. */
export function pieceCells(p: Piece): { cells: number[]; blocked: number[]; seat: number[] } {
  const out = { cells: [] as number[], blocked: [] as number[], seat: [] as number[] }
  const s = shapeOfPiece(p)
  if (!s) return out
  const { cols, rows, blocked, seat } = PATTERNS.get(s.id * 4 + p.rot)!
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const c = p.c + i, r = p.r + j
      if (c < 0 || c >= GRID || r < 0 || r >= GRID) continue
      const at = cellIndex(c, r)
      out.cells.push(at)
      if (blocked[j * cols + i]) out.blocked.push(at)
      if (seat[j * cols + i]) out.seat.push(at)
    }
  }
  return out
}

// ---------------------------------------------------------------- the rules

/** What canPlace answers: 'ok', or why not (HomeCard.tsx words each one). */
export const VERDICTS = Object.freeze(['ok', 'outside', 'overlap', 'doorway', 'wall', 'copies', 'full', 'you', 'sealed', 'seat', 'unowned'] as const)
export type Verdict = (typeof VERDICTS)[number]

/** Bits of the cell table a layout is drawn into: a cell some footprint uses, and a cell a solid blocks. */
const USED = 1, SOLID = 2

/** A layout drawn into a cell table (USED and SOLID bits). Pieces that are not well-formed are left out. */
function occupancy(placed: readonly Piece[]): Uint8Array {
  const grid = new Uint8Array(GRID * GRID)
  for (const p of placed) {
    const { cells, blocked } = pieceCells(p)
    for (const at of cells) grid[at] |= USED
    for (const at of blocked) grid[at] |= SOLID
  }
  return grid
}

/** Every cell of home `home` that can be walked to from the apron, four ways (never diagonally), past nothing SOLID: 1, else 0. */
function flood(home: number, grid: Uint8Array): Uint8Array {
  const seen = new Uint8Array(GRID * GRID)
  const depth = DEPTH[home]
  if (depth === undefined) return seen
  const lowest = (GRID - depth) * GRID, last = GRID * GRID - GRID
  // A cell is queued once: marked seen as it is queued, and only when nothing solid stands on it.
  const queue = new Int16Array(GRID * GRID)
  let head = 0, tail = 0
  for (let r = APRON.r0; r <= APRON.r1; r++) {
    for (let c = APRON.c0; c <= APRON.c1; c++) {
      const at = cellIndex(c, r)
      if ((grid[at] & SOLID) === 0) { seen[at] = 1; queue[tail++] = at }
    }
  }
  while (head < tail) {
    const at = queue[head++], c = at % GRID
    let n = at - 1
    if (c > 0 && seen[n] === 0 && (grid[n] & SOLID) === 0) { seen[n] = 1; queue[tail++] = n }
    n = at + 1
    if (c < GRID - 1 && seen[n] === 0 && (grid[n] & SOLID) === 0) { seen[n] = 1; queue[tail++] = n }
    n = at - GRID
    if (n >= lowest && seen[n] === 0 && (grid[n] & SOLID) === 0) { seen[n] = 1; queue[tail++] = n }
    n = at + GRID
    if (at < last && seen[n] === 0 && (grid[n] & SOLID) === 0) { seen[n] = 1; queue[tail++] = n }
  }
  return seen
}

/**
 * The cells of home `home` a person can walk to from the apron with `placed` standing, as a GRID × GRID table
 * (cellIndex): 1 reachable, 0 not (outside the floor plan, under a solid, or cut off). Steps are four-way: a diagonal
 * squeeze between two corners never counts. A seat is walkable.
 */
export function reach(home: number, placed: readonly Piece[]): Uint8Array {
  return flood(home, occupancy(placed))
}

/**
 * Whether someone free to walk anywhere in a piece's footprint `cells` can step to a cell in `seen` (a reach table):
 * a cell of the footprint (a seat) or one beside it four ways is in it. Their marked cells outside the piece are not
 * counted: one that is free is held by the plain 'sealed' rule already, and one only across the piece's corner is a
 * diagonal step.
 */
function wayOut(cells: readonly number[], seen: Uint8Array): boolean {
  for (const at of cells) {
    const c = at % GRID
    if (seen[at] || (c > 0 && seen[at - 1]) || (c < GRID - 1 && seen[at + 1]) || (at >= GRID && seen[at - GRID]) || (at < GRID * GRID - GRID && seen[at + GRID])) return true
  }
  return false
}

/**
 * Whether anyone `blocked` marks inside a placed piece would lose their way out (canPlace's 'sealed'). Someone can only
 * stand inside a piece whose collider is still off: the worker builds each new piece off and keeps the home's off
 * pieces off while anyone stands by one. While the piece stays they can walk anywhere in it, but once it is taken away
 * they stand on its bare floor, and the pieces round it turn solid as soon as they are clear of them. So a piece that
 * blocks a marked cell may have someone inside, and its footprint must still lead to the apron, through a seat or a
 * cell beside it, if it did before. It is measured with every solid as it will be, never through another person. A
 * piece someone only stands beside is held the same way: a stricter test, never a looser one.
 */
function shutsIn(placed: readonly Piece[], blocked: ArrayLike<number>, before: Uint8Array, after: Uint8Array): boolean {
  for (const p of placed) {
    const { cells, blocked: solid } = pieceCells(p)
    if (solid.some((at) => blocked[at]) && wayOut(cells, before) && !wayOut(cells, after)) return true
  }
  return false
}

/** Whether a wall piece's back lies on the floor plan's edge for its turn. */
function backed(home: number, f: Footprint, rot: number): boolean {
  switch (rot) {
    case 0: return f.r === GRID - DEPTH[home]
    case 1: return f.c + f.cols - 1 === GRID - 1
    case 2: return f.r + f.rows - 1 === GRID - 1
    default: return f.c === 0
  }
}

/**
 * Whether `piece` may be placed in home `home` beside `placed` (the layout without it: to move a piece, take it out
 * first). The first reason that applies is the answer, in this order:
 * - 'unowned': `owns` is given and says the line is not the player's (the show homes and the tests leave it out);
 * - 'full': HOME_PIECES pieces are already placed; 'copies': the line is already at its cap in this home;
 * - 'outside': a footprint cell is outside the home's floor plan (so is a piece that is not well-formed: no such line,
 *   cells that are not whole numbers, a turn outside 0..3);
 * - 'doorway': a footprint cell is in the apron; 'wall': a wall piece's back is not on the floor plan's edge;
 * - 'overlap': a footprint cell is already some piece's (a seat's included);
 * - 'you': a cell the piece would block is set in `blocked`, a GRID × GRID table by cellIndex (nonzero: someone
 *   stands there; the engine marks every cell near a local avatar on foot in this home, cellsNear);
 * - 'seat': a workstation's seat, its own or another's, would be cut off from the apron (its own must be reachable;
 *   another's only must not be lost);
 * - 'sealed': a cell that could be walked to from the apron before could not be after, other than the cells the piece
 *   itself blocks; or someone `blocked` marks inside a placed piece (one put down where they stood, still off) would
 *   lose their way out (shutsIn), so taking that piece away later never leaves them walled in. Measuring the loss keeps
 *   removal always allowed, and an old pocket never blocks a new piece. People only ever add refusals: the reach is
 *   measured with every solid as it will be, never through a person.
 */
export function canPlace(home: number, placed: readonly Piece[], piece: Piece, blocked: ArrayLike<number> | null = null, owns: ((id: number) => boolean) | null = null): Verdict {
  const s = shapeOfPiece(piece)
  if (!s || DEPTH[home] === undefined) return 'outside'
  if (owns && !owns(piece.id)) return 'unowned'
  if (placed.length >= HOME_PIECES) return 'full'
  let copies = 0
  for (const p of placed) if (p.id === piece.id) copies++
  if (copies >= s.cap) return 'copies'
  const f = footprint(piece)!
  for (let r = f.r; r < f.r + f.rows; r++) for (let c = f.c; c < f.c + f.cols; c++) if (!inMask(home, c, r)) return 'outside'
  for (let r = f.r; r < f.r + f.rows; r++) for (let c = f.c; c < f.c + f.cols; c++) if (inApron(c, r)) return 'doorway'
  if (s.wall && !backed(home, f, piece.rot)) return 'wall'
  const grid = occupancy(placed)
  const own = pieceCells(piece)
  for (const at of own.cells) if (grid[at] & USED) return 'overlap'
  if (blocked) for (const at of own.blocked) if (blocked[at]) return 'you'
  const before = flood(home, grid)
  for (const at of own.blocked) grid[at] |= SOLID
  const after = flood(home, grid)
  for (const at of own.seat) if (!after[at]) return 'seat'
  for (const p of placed) if (shapeOf(p.id)?.station) for (const at of pieceCells(p).seat) if (before[at] && !after[at]) return 'seat'
  for (let at = 0; at < GRID * GRID; at++) if (before[at] && !after[at] && (grid[at] & SOLID) === 0) return 'sealed'
  if (blocked && shutsIn(placed, blocked, before, after)) return 'sealed'
  return 'ok'
}

/**
 * A saved layout fitted to home `home` as it is drawn: the pieces in order, each placed when its line is owned and
 * canPlace says 'ok', otherwise kept as stored ("not placed here"), never dropped. Leaving a piece out only frees cells
 * and the apron is never used, so the result can always be walked into.
 */
export function fitLayout(home: number, saved: readonly Piece[], owns: ((id: number) => boolean) | null, blocked: ArrayLike<number> | null = null): { placed: Piece[]; stored: Piece[] } {
  const placed: Piece[] = [], stored: Piece[] = []
  for (const p of saved) (canPlace(home, placed, p, blocked, owns) === 'ok' ? placed : stored).push(p)
  return { placed, stored }
}

/**
 * How many kinds of furniture stand in a home: the different lines among `placed` (what fitLayout places, as the
 * engine draws it), copies of one line counted once and anything that is not a line not at all. A rest at home's comfort.
 */
export function comfortOf(placed: readonly Piece[]): number {
  const kinds = new Set<number>()
  for (const p of placed) if (shapeOf(p.id) !== null) kinds.add(p.id)
  return kinds.size
}

/** The cell (c, r) the room-frame point (u, v) stands in, or null off the grid. */
export function cellAt(u: number, v: number): { c: number; r: number } | null {
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null
  const c = Math.floor((v + GRID_HALF) / CELL), r = Math.floor((u + GRID_HALF) / CELL)
  return c >= 0 && c < GRID && r >= 0 && r < GRID ? { c, r } : null
}

/**
 * Every cell that comes within `radius` m of one of the room-frame points, as a GRID × GRID table (cellIndex, 1 near):
 * canPlace's `blocked`. The engine passes the local avatars on foot in the home and PERSON.radius plus a margin.
 */
export function cellsNear(points: readonly { u: number; v: number }[], radius: number): Uint8Array {
  const out = new Uint8Array(GRID * GRID)
  for (const { u, v } of points) {
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue
    const r0 = Math.max(0, Math.floor((u - radius + GRID_HALF) / CELL)), r1 = Math.min(GRID - 1, Math.floor((u + radius + GRID_HALF) / CELL))
    const c0 = Math.max(0, Math.floor((v - radius + GRID_HALF) / CELL)), c1 = Math.min(GRID - 1, Math.floor((v + radius + GRID_HALF) / CELL))
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cu = Math.max(-GRID_HALF + r * CELL, Math.min(u, -GRID_HALF + (r + 1) * CELL))
        const cv = Math.max(-GRID_HALF + c * CELL, Math.min(v, -GRID_HALF + (c + 1) * CELL))
        if (Math.hypot(u - cu, v - cv) <= radius) out[cellIndex(c, r)] = 1
      }
    }
  }
  return out
}

// ---------------------------------------------------------------- the boxes, in the room frame

/** A box in the room frame: [u0, v0, u1, v1, y0, y1], m (interiors.ts's local order; toWorld turns it into the city's). */
export type RoomBox = readonly [number, number, number, number, number, number]

/** One drawn box and the style it is drawn in. */
export interface Part { readonly box: RoomBox; readonly finish: Finish }

/**
 * A piece's boxes as drawn, in the room frame: each turned with the piece and kept PIECE_INSET inside its footprint
 * (an edge inside the footprint stays where the shape puts it, so the parts of one piece still meet). Empty for a
 * piece that is not well-formed.
 */
export function renderBoxes(p: Piece): Part[] {
  const s = shapeOfPiece(p)
  if (!s) return []
  const f = footprint(p)!
  const u = -GRID_HALF + p.r * CELL, v = -GRID_HALF + p.c * CELL
  const across = (x: number) => Math.min(f.cols * CELL - PIECE_INSET, Math.max(PIECE_INSET, x * CELL))
  const along = (y: number) => Math.min(f.rows * CELL - PIECE_INSET, Math.max(PIECE_INSET, y * CELL))
  return s.boxes.map((b) => {
    const [c0, r0, c1, r1] = rotateBox(b.rect, s.w, s.d, p.rot)
    return { box: [u + along(r0), v + across(c0), u + along(r1), v + across(c1), b.y0, b.y1], finish: b.finish }
  })
}

/** A piece's one collider in the room frame: its solid turned with it and inset PIECE_INSET on every side, from the floor. Null for a piece that is not well-formed. */
export function solidBox(p: Piece): RoomBox | null {
  const s = shapeOfPiece(p)
  if (!s) return null
  const solid = SOLIDS.get(s.id)!
  const [c0, r0, c1, r1] = rotateBox(solid.rect, s.w, s.d, p.rot)
  const u = -GRID_HALF + p.r * CELL, v = -GRID_HALF + p.c * CELL
  return [u + r0 * CELL + PIECE_INSET, v + c0 * CELL + PIECE_INSET, u + r1 * CELL - PIECE_INSET, v + c1 * CELL - PIECE_INSET, 0, solid.top]
}

/** Throws unless `home` is a property index. */
function checkHome(home: number): void {
  if (DEPTH[home] === undefined || !Number.isInteger(home)) throw new RangeError(`no home ${home}`)
}

/**
 * Home `home`'s floor overlay in the room frame: from the fill block's face (or the back glass, which is where
 * backEdge − INSET falls in the two grandest homes) to the doorway wall's inner face, wall to wall, a few millimetres
 * above `base` (0 in the city, the region's paved floor height in a region). Its top is the floor finish. It hides the
 * street's ground under the room, is never a collider, and pieces stand through it from the floor.
 */
export function floorOverlay(home: number, base = 0): RoomBox {
  checkHome(home)
  return [backEdge(home) - INSET, -GLASS, GLASS, GLASS, base + OVERLAY.y0, base + OVERLAY.y1]
}

/**
 * Home `home`'s wall panels in the room frame for wall finish `wall` (WALLS): none for glass (or an index that is not
 * a finish), otherwise five panels PANEL.thick thick and PANEL.gap off the glass's inner faces and the fill block's face,
 * floor to slab: the back, the two sides (from the back panel's front face to the doorway wall's panels), and the
 * doorway wall either side of the opening, PANEL.door back from its edges. No two share a face.
 */
export function wallPanels(home: number, wall: number): RoomBox[] {
  checkHome(home)
  if (!Number.isInteger(wall) || (WALLS[wall]?.style ?? null) === null) return []
  const out = GLASS - PANEL.gap, inn = out - PANEL.thick
  const b0 = backEdge(home) - INSET + PANEL.gap, b1 = b0 + PANEL.thick
  const door = DOORWAY + PANEL.door
  return [
    [b0, -out, b1, out, 0, CEILING], // the back
    [b1, -out, inn, -inn, 0, CEILING], // the −v side
    [b1, inn, inn, out, 0, CEILING], // the +v side
    [inn, -out, out, -door, 0, CEILING], // the doorway's wall, −v of the opening
    [inn, door, out, out, 0, CEILING], // and +v of it
  ]
}

// ---------------------------------------------------------------- the show homes

const staged = (list: readonly (readonly [number, number, number, number])[]): readonly Piece[] =>
  Object.freeze(list.map(([id, c, r, rot]) => Object.freeze({ id, c, r, rot })))

/**
 * The show homes, by property index: the layout drawn and made solid in a home while its deed is unowned, in
 * Lintel & Lumen's furniture (no line need be owned). Each passes canPlace piece by piece in its own floor plan
 * (homeLayout.test.ts), so a show home can always be walked through. The estate holds three sofas, the line's cap.
 */
export const HOME_STAGING: readonly (readonly Piece[])[] = Object.freeze([
  // The micro-loft (rows 20 to 31): a sofa, two bookcases and a desk.
  staged([[164, 4, 20, 0], [164, 25, 20, 0], [160, 14, 21, 0], [163, 1, 23, 3]]),
  // The brownstone (rows 16 to 31): two sofas face to face, three bookcases, a desk and a green wall.
  staged([[164, 2, 16, 0], [164, 5, 16, 0], [164, 8, 16, 0], [167, 23, 16, 0], [160, 14, 17, 0], [163, 4, 21, 0], [163, 4, 25, 2]]),
  // The timber loft (rows 12 to 31): two sofas, the bar on the back wall and two bookcases on the +v wall.
  staged([[165, 14, 12, 0], [164, 31, 15, 1], [164, 31, 19, 1], [163, 5, 17, 0], [163, 5, 21, 2]]),
  // The penthouse (rows 8 to 31): the hologram table between two sofas, the piano and the console.
  staged([[161, 4, 8, 0], [162, 14, 14, 0], [163, 10, 13, 3], [163, 19, 13, 1], [166, 25, 10, 0]]),
  // The glass villa (rows 4 to 31): three sofas round an open square, the piano and two green walls.
  staged([[167, 6, 4, 0], [167, 22, 4, 0], [163, 13, 10, 0], [163, 10, 13, 3], [163, 18, 13, 1], [166, 25, 18, 0]]),
  // The estate (the whole grid): the bar and four bookcases on the back wall, three sofas round the hologram table, the piano.
  staged([[165, 14, 0, 0], [164, 3, 0, 0], [164, 6, 0, 0], [164, 23, 0, 0], [164, 26, 0, 0], [162, 14, 13, 0], [163, 13, 10, 0], [163, 11, 12, 3], [163, 18, 12, 1], [166, 25, 8, 0]]),
  // The sky-mansion (the whole grid): the console and two workstations on the back wall, two sofas by the hologram table, the piano.
  staged([[161, 14, 0, 0], [168, 4, 0, 0], [168, 7, 0, 0], [162, 14, 12, 0], [163, 11, 11, 3], [163, 18, 11, 1], [166, 25, 6, 0]]),
])
