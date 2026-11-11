// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the furnishing rules (homeLayout.ts) to their promises. The nine shapes are the
 * catalogue's nine furniture lines and are shipped data, pinned here; each is whole cells, at most four boxes, under
 * the slab, with a derived solid that covers what a person could walk into. A piece turned four times comes back as it
 * was, and turns as a rotation, never a mirror. canPlace gives every verdict where it should (the wall rule for each
 * turn among them); the apron is never used; and 2,000 seeded runs of placing, removing and fitting never use the
 * apron, never cut off a workstation's seat, and never refuse a removal. Someone standing inside a piece that is not
 * yet solid is never ringed in (400 more seeded runs take the piece away and find them a way out), and people standing
 * by only ever add refusals. The seven show homes fit their own homes, and comfortOf counts the kinds of furniture
 * standing in a home (a rest at home's comfort). A workstation's station (where a posted agent stands, stationOf) turns
 * with the piece, lies on the edge between its two seat cells and faces the desk; stationsIn lists workstations in
 * reading order. No
 * two boxes of a home (the shell, the fill block, the planters, the floor overlay, the wall panels and a full layout)
 * share a face in the same plane facing the same way, in every home, facing every way; and every name passes the 14A
 * screen.
 * What breaks if it is removed? A shape could change under a saved layout, a turn could mirror a piece, a layout could
 * wall a player out of their own home or shut a split-screen partner inside it, and the finishes could flicker against
 * the glass, with nothing to say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { forbiddenWordIn } from '../01_Initialize_World/assets/cc0.ts'
import { CITY, type Box } from '../01_Initialize_World/city.ts'
import { ROOM, toWorld, type Side } from '../01_Initialize_World/interiors.ts'
import { homesAt } from '../01_Initialize_World/properties.ts'
import { CATALOGUE } from '../07_Execute_Actions/storeCatalog.ts'
import { REAL_PLACES } from '../../tools/world/real-places.mjs'
import { screen } from './conduct.ts'
import { createRng } from './degrees.ts'
import { APRON, CELL, DEPTH, GRID, GRID_HALF, HOME_PIECES, INSET, backEdge, cellCentre, inApron, inMask } from './homeGrid.ts'
import {
  CEILING, COVER, DEFAULT_FINISH, DOORWAY, FINISHES, FLOORS, FURNITURE_BASE, GLASS, HOME_STAGING, OVERLAY, PANEL, PIECE_INSET, PIECE_TOP, SHAPES, SHAPE_IDS,
  SOLID_FROM, SOLID_MAX, VERDICTS, WALLS, canPlace, cellAt, cellIndex, cellsNear, comfortOf, fitLayout, floorOverlay, footprint, pieceCells, reach, renderBoxes,
  rotateBox, shapeOf, solidBox, solidOf, stationOf, stationsIn, wallPanels, type Piece, type Rect, type RoomBox, type Verdict,
} from './homeLayout.ts'

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)
const P = (id: number, c: number, r: number, rot = 0): Piece => ({ id, c, r, rot })
const first = (home: number) => GRID - DEPTH[home]
const HOMES = DEPTH.map((_, i) => i)
const ROTS = [0, 1, 2, 3]

/** Places each piece in turn, asserting each is 'ok'; returns the layout. */
function build(home: number, pieces: readonly Piece[]): Piece[] {
  const placed: Piece[] = []
  for (const p of pieces) {
    assert.equal(canPlace(home, placed, p), 'ok', `home ${home}: ${JSON.stringify(p)} beside ${JSON.stringify(placed)}`)
    placed.push(p)
  }
  return placed
}

/** Everything a sound layout keeps: within the caps and the count, every footprint in the plan and off the apron, wall pieces backed, no shared cell, every seat reachable. */
function assertSound(home: number, placed: readonly Piece[], what: string): Uint8Array {
  assert.ok(placed.length <= HOME_PIECES, `${what}: ${placed.length} pieces`)
  const used = new Uint8Array(GRID * GRID)
  const count = new Map<number, number>()
  for (const p of placed) {
    const s = shapeOf(p.id)!
    count.set(p.id, (count.get(p.id) ?? 0) + 1)
    assert.ok(count.get(p.id)! <= s.cap, `${what}: too many of ${p.id}`)
    const f = footprint(p)!
    for (let r = f.r; r < f.r + f.rows; r++) {
      for (let c = f.c; c < f.c + f.cols; c++) {
        assert.ok(inMask(home, c, r), `${what}: ${c},${r} outside`)
        assert.ok(!inApron(c, r), `${what}: ${c},${r} is the apron`)
        assert.equal(used[cellIndex(c, r)], 0, `${what}: ${c},${r} used twice`)
        used[cellIndex(c, r)] = 1
      }
    }
    if (s.wall) {
      const ok = [f.r === first(home), f.c + f.cols === GRID, f.r + f.rows === GRID, f.c === 0][p.rot]
      assert.ok(ok, `${what}: wall piece ${JSON.stringify(p)} not backed`)
    }
  }
  const seen = reach(home, placed)
  for (let r = APRON.r0; r <= APRON.r1; r++) for (let c = APRON.c0; c <= APRON.c1; c++) assert.equal(seen[cellIndex(c, r)], 1, `${what}: apron ${c},${r} cut off`)
  for (const p of placed) for (const at of pieceCells(p).seat) assert.equal(seen[at], 1, `${what}: seat ${at} of ${JSON.stringify(p)} cut off`)
  return seen
}

// ---------------------------------------------------------------- the shipped data

test('the shapes are the plan\'s table, frozen: footprints, wall pieces, caps and the derived solids', () => {
  const table: Record<number, [w: number, d: number, wall: boolean, cap: number, solid: Rect, top: number]> = {
    160: [3, 2, false, 2, [0, 0.5, 3, 1.95], 0.76],
    161: [3, 2, false, 2, [0, 0.2, 3, 1.4], 1.95],
    162: [3, 3, false, 1, [0.4, 0.4, 2.6, 2.6], 1.35],
    163: [4, 2, false, 3, [0, 0, 4, 1.6], 0.85],
    164: [3, 1, true, 6, [0, 0, 3, 0.55], 2.4],
    165: [3, 2, true, 1, [0, 0, 3, 1.85], 2.2],
    166: [2, 3, false, 1, [0.1, 0.3, 1.9, 3], 1.0],
    167: [4, 1, true, 4, [0, 0, 4, 0.55], 2.4],
    168: [2, 2, false, 8, [0, 0.05, 2, 0.95], 1.45],
  }
  assert.deepEqual(SHAPE_IDS, [160, 161, 162, 163, 164, 165, 166, 167, 168])
  for (const id of SHAPE_IDS) {
    const s = SHAPES[id], [w, d, wall, cap, rect, top] = table[id]
    assert.deepEqual([s.id, s.w, s.d, s.wall, s.cap], [id, w, d, wall, cap], `line ${id}`)
    assert.deepEqual(solidOf(id), { rect, top }, `line ${id}'s solid`)
    assert.ok(Object.isFrozen(s) && Object.isFrozen(s.boxes) && s.boxes.every((b) => Object.isFrozen(b) && Object.isFrozen(b.rect)), `line ${id} is frozen`)
    assert.equal(shapeOf(id), s)
  }
  assert.ok(Object.isFrozen(SHAPES) && Object.isFrozen(SHAPE_IDS))
  assert.equal(SHAPES[168].cap, ROOM.stations, 'as many workstations as a workplace has stations')
  assert.deepEqual(SHAPES[168].station, [1, 1.5], 'slice 3\'s station point')
  assert.ok(SHAPE_IDS.every((id) => id === 168 ? SHAPES[id].station !== null : SHAPES[id].station === null), 'only the workstation has a seat')
  assert.equal(shapeOf(159), null)
  assert.equal(shapeOf(169), null)
  assert.equal(solidOf(224), null)
  assert.equal(shapeOf(Number.NaN), null)
})

test('every furniture line in the catalogue has a shape of the same name, and every shape a line', () => {
  const lines = CATALOGUE.filter((i) => i.kind === 'furniture')
  assert.equal(lines.length, SHAPE_IDS.length)
  for (const i of lines) {
    const s = shapeOf(i.id)
    assert.ok(s, `${i.id} ${i.name} has no shape`)
    assert.equal(s.name, i.name, `line ${i.id}`)
    assert.equal(i.space, 'furniture')
    assert.equal(i.index, i.id - FURNITURE_BASE, `line ${i.id}'s furniture bit`)
  }
  for (const id of SHAPE_IDS) assert.ok(lines.some((i) => i.id === id), `shape ${id} has no catalogue line`)
})

test('the room\'s numbers this file keeps without importing interiors.ts are interiors.ts\'s', () => {
  assert.equal(DOORWAY, ROOM.door)
  assert.equal(CEILING, ROOM.height)
  close(GLASS, CITY.lotHalf - ROOM.wall)
  assert.equal(COVER, PIECE_INSET)
  assert.ok(CELL - 2 * COVER > 2 * (0.3 + 0.02), 'a free cell, less what a solid may reach into it each side, still takes a person')
})

test('the finishes: three floors and six walls by shipped index, each in a style the material has, and the defaults per home', () => {
  assert.deepEqual(FLOORS.map((f) => [f.name, f.style]), [['Polished concrete', 'concrete'], ['Oak boards', 'deck'], ['Limestone', 'trim']])
  assert.deepEqual(WALLS.map((f) => [f.name, f.style]), [
    ['Glass', null], ['Exposed brick', 'masonry'], ['Oak panelling', 'deck'], ['Limestone', 'trim'], ['Board-formed concrete', 'concrete'], ['Blackened steel', 'rail'],
  ])
  assert.deepEqual([...FINISHES], ['concrete', 'deck', 'trim', 'masonry', 'rail', 'lit', 'planted'])
  for (const f of [...FLOORS, ...WALLS]) assert.ok(f.style === null || FINISHES.includes(f.style), f.name)
  assert.deepEqual(DEFAULT_FINISH.map(({ floor, wall }) => [floor, wall]), [[0, 0], [1, 1], [1, 2], [0, 0], [0, 0], [0, 0], [0, 0]])
  assert.equal(FLOORS[DEFAULT_FINISH[1].floor].name, 'Oak boards')
  assert.equal(WALLS[DEFAULT_FINISH[1].wall].name, 'Exposed brick')
  assert.equal(WALLS[DEFAULT_FINISH[2].wall].name, 'Oak panelling')
  assert.ok(Object.isFrozen(FLOORS) && Object.isFrozen(WALLS) && Object.isFrozen(DEFAULT_FINISH) && DEFAULT_FINISH.every(Object.isFrozen))
})

// ---------------------------------------------------------------- the shapes

test('footprints are whole cells, at most four boxes each, inside the footprint and under 4.1 m', () => {
  for (const id of SHAPE_IDS) {
    const s = SHAPES[id]
    assert.ok(Number.isInteger(s.w) && Number.isInteger(s.d) && s.w > 0 && s.d > 0, `line ${id}`)
    assert.ok(s.boxes.length >= 1 && s.boxes.length <= 4, `line ${id}: ${s.boxes.length} boxes`)
    for (const b of s.boxes) {
      const [x0, y0, x1, y1] = b.rect
      assert.ok(x0 >= 0 && y0 >= 0 && x1 <= s.w && y1 <= s.d && x1 > x0 && y1 > y0, `line ${id}: ${b.rect}`)
      assert.ok(b.y0 >= 0 && b.y1 > b.y0 && b.y1 <= PIECE_TOP, `line ${id}: ${b.y0}-${b.y1}`)
      assert.ok(FINISHES.includes(b.finish), `line ${id}: ${b.finish}`)
    }
  }
})

test('the derived solids cover every box that starts below 1.8 m, stay inside the footprint, and stand at least 0.42 m', () => {
  for (const id of SHAPE_IDS) {
    const s = SHAPES[id], { rect: [x0, y0, x1, y1], top } = solidOf(id)!
    assert.ok(x0 >= 0 && y0 >= 0 && x1 <= s.w && y1 <= s.d, `line ${id}: the solid inside the footprint`)
    assert.ok(top >= 0.42 && top <= SOLID_MAX, `line ${id}: ${top} m`)
    for (const b of s.boxes) {
      if (b.y0 >= SOLID_FROM) continue
      assert.ok(b.rect[0] >= x0 && b.rect[1] >= y0 && b.rect[2] <= x1 && b.rect[3] <= y1, `line ${id}: ${b.rect} outside the solid`)
      assert.ok(top >= Math.min(SOLID_MAX, b.y1), `line ${id}: a box rises above the solid under ${SOLID_MAX} m`)
    }
  }
})

test('every line blocks its whole footprint but the workstation, whose front row is its seat, walkable, with the station point on it', () => {
  for (const id of SHAPE_IDS) {
    const s = SHAPES[id]
    const { cells, blocked, seat } = pieceCells(P(id, 0, 0))
    assert.equal(cells.length, s.w * s.d)
    if (id === 168) {
      assert.deepEqual(blocked, [cellIndex(0, 0), cellIndex(1, 0)])
      assert.deepEqual(seat, [cellIndex(0, 1), cellIndex(1, 1)])
      const [sx, sy] = s.station!
      assert.ok(seat.includes(cellIndex(Math.floor(sx - 1e-9), Math.floor(sy))) && sy > 1 && sy < 2, 'the station point is on the seat')
    } else {
      assert.deepEqual(blocked, cells, `line ${id}`)
      assert.deepEqual(seat, [])
    }
  }
})

// ---------------------------------------------------------------- turning

test('four quarter turns give back the original, and each turn is that many quarter turns', () => {
  for (const id of SHAPE_IDS) {
    const s = SHAPES[id]
    for (const rect of [...s.boxes.map((b) => b.rect), solidOf(id)!.rect]) {
      let r: Rect = rect, w = s.w, d = s.d
      for (let k = 1; k <= 4; k++) {
        r = rotateBox(r, w, d, 1);
        [w, d] = [d, w]
        if (k < 4) assert.deepEqual(r.map((x) => +x.toFixed(9)), rotateBox(rect, s.w, s.d, k).map((x) => +x.toFixed(9)), `line ${id}: ${k} quarter turns`)
      }
      assert.deepEqual(r.map((x) => +x.toFixed(9)), [...rect], `line ${id}: four quarter turns`)
      assert.deepEqual(rotateBox(rect, s.w, s.d, 0), rect)
    }
    for (const rot of ROTS) {
      const f = footprint(P(id, 3, 5, rot))!
      assert.deepEqual(f, { c: 3, r: 5, cols: rot % 2 ? s.d : s.w, rows: rot % 2 ? s.w : s.d }, `line ${id} turn ${rot}`)
      // Every box stays inside the turned footprint.
      for (const b of s.boxes) {
        const [c0, r0, c1, r1] = rotateBox(b.rect, s.w, s.d, rot)
        assert.ok(c0 >= -1e-9 && r0 >= -1e-9 && c1 <= f.cols + 1e-9 && r1 <= f.rows + 1e-9, `line ${id} turn ${rot}`)
      }
    }
  }
})

test('a turn is a rotation, never a mirror: the desk\'s return, the boxes in the room and the blocked cells all turn together', () => {
  // A quarter turn takes (column, row) offsets from the footprint's centre (a, b) to (−b, a).
  const quarter = ([a, b]: [number, number]): [number, number] => [-b, a]
  for (const id of SHAPE_IDS) {
    const s = SHAPES[id]
    const base = renderBoxes(P(id, 10, 10, 0))
    const centre0 = { u: -GRID_HALF + 10 * CELL + s.d * CELL / 2, v: -GRID_HALF + 10 * CELL + s.w * CELL / 2 }
    for (const rot of ROTS) {
      const f = footprint(P(id, 10, 10, rot))!
      const centre = { u: -GRID_HALF + 10 * CELL + f.rows * CELL / 2, v: -GRID_HALF + 10 * CELL + f.cols * CELL / 2 }
      const turned = renderBoxes(P(id, 10, 10, rot))
      turned.forEach(({ box, finish }, i) => {
        let off: [number, number] = [(base[i].box[1] + base[i].box[3]) / 2 - centre0.v, (base[i].box[0] + base[i].box[2]) / 2 - centre0.u]
        for (let k = 0; k < rot; k++) off = quarter(off)
        close((box[1] + box[3]) / 2 - centre.v, off[0], 1e-6)
        close((box[0] + box[2]) / 2 - centre.u, off[1], 1e-6)
        assert.equal(finish, base[i].finish)
        assert.deepEqual([box[4], box[5]], [base[i].box[4], base[i].box[5]], 'heights never turn')
      })
    }
  }
  // The desk's return is at its front right (+x, +y); facing the doorway (turn 0) that is toward +v and the doorway.
  const ret = (rot: number) => renderBoxes(P(160, 10, 10, rot))[3].box
  const mid = (b: RoomBox) => ({ u: (b[0] + b[2]) / 2, v: (b[1] + b[3]) / 2 })
  const at = (rot: number) => { const f = footprint(P(160, 10, 10, rot))!; return { u: -GRID_HALF + (10 + f.rows / 2) * CELL, v: -GRID_HALF + (10 + f.cols / 2) * CELL } }
  const dir = (rot: number) => { const m = mid(ret(rot)), c = at(rot); return [Math.sign(m.v - c.v), Math.sign(m.u - c.u)] }
  assert.deepEqual(dir(0), [1, 1], 'turn 0: front toward the doorway, the return toward +v')
  assert.deepEqual(dir(1), [-1, 1], 'turn 1: front toward −v, the return toward the doorway')
  assert.deepEqual(dir(2), [-1, -1], 'turn 2: front toward the back, the return toward −v')
  assert.deepEqual(dir(3), [1, -1], 'turn 3: front toward +v, the return toward the back')
  // The workstation's seat is always the row or column on its front side.
  const seatOf = (rot: number) => pieceCells(P(168, 4, 4, rot)).seat.map((at) => [at % GRID, Math.floor(at / GRID)])
  assert.deepEqual(seatOf(0), [[4, 5], [5, 5]], 'turn 0: the row toward the doorway')
  assert.deepEqual(seatOf(1), [[4, 4], [4, 5]], 'turn 1: the column toward −v')
  assert.deepEqual(seatOf(2), [[4, 4], [5, 4]], 'turn 2: the row toward the back')
  assert.deepEqual(seatOf(3), [[5, 4], [5, 5]], 'turn 3: the column toward +v')
})

test('a piece\'s back faces the wall its turn names: a wall piece stands against the floor plan\'s edge', () => {
  const home = 0, edge = GRID_HALF - PIECE_INSET
  const back = (rot: number, c: number, r: number) => renderBoxes(P(164, c, r, rot))[0].box
  close(back(0, 5, first(home))[0], backEdge(home) + PIECE_INSET)
  close(back(1, GRID - 1, 22)[3], edge)
  close(back(2, 2, GRID - 1)[2], edge)
  close(back(3, 0, 22)[1], -edge)
})

// ---------------------------------------------------------------- the rules

test('canPlace: each verdict', () => {
  const home = 0, top = first(home)
  assert.equal(top, 20)
  assert.deepEqual([...VERDICTS], ['ok', 'outside', 'overlap', 'doorway', 'wall', 'copies', 'full', 'you', 'sealed', 'seat', 'unowned'])
  const sofa = P(163, 2, 24)
  assert.equal(canPlace(home, [], sofa), 'ok')
  // outside: a row behind the plan, a column past the edge, and anything that is not a piece.
  assert.equal(canPlace(home, [], P(163, 2, top - 1)), 'outside')
  assert.equal(canPlace(home, [], P(163, 29, 24)), 'outside')
  assert.equal(canPlace(home, [], P(163, -1, 24)), 'outside')
  assert.equal(canPlace(home, [], P(163, 2, 31)), 'outside', 'two rows from the last row')
  for (const bad of [P(999, 2, 24), P(224, 2, 24), P(163, 2.5, 24), P(163, 2, 24, 4), P(163, 2, 24, -1), P(163, 2, 24, 0.5), P(163, Number.NaN, 24)]) {
    assert.equal(canPlace(home, [], bad), 'outside', JSON.stringify(bad))
  }
  assert.equal(canPlace(7, [], sofa), 'outside', 'there is no eighth home')
  // overlap
  assert.equal(canPlace(home, [sofa], P(160, 4, 25)), 'overlap')
  assert.equal(canPlace(home, [sofa], P(160, 6, 24)), 'ok', 'side by side')
  // doorway
  assert.equal(canPlace(home, [], P(163, 12, 27)), 'doorway')
  assert.equal(canPlace(home, [], P(163, 9, 27)), 'ok', 'up to the apron\'s edge')
  // copies
  assert.equal(canPlace(home, [P(166, 2, 22)], P(166, 8, 22)), 'copies')
  assert.equal(canPlace(home, [P(160, 2, 22), P(160, 8, 22)], P(160, 20, 22)), 'copies')
  // unowned
  assert.equal(canPlace(home, [], sofa, null, () => false), 'unowned')
  assert.equal(canPlace(home, [], sofa, null, (id) => id === 163), 'ok')
  // you: someone standing on a cell the piece would block; standing on a workstation's seat is fine.
  const centre = (c: number, r: number) => { const { u, v } = cellCentre(c, r); return { u, v } }
  assert.equal(canPlace(home, [], sofa, cellsNear([centre(3, 24)], 0.35)), 'you')
  assert.equal(canPlace(home, [], sofa, cellsNear([centre(3, 26)], 0.35)), 'ok', 'someone beside it')
  assert.equal(canPlace(home, [], P(168, 2, 24), cellsNear([centre(2, 25)], 0.35)), 'ok', 'someone on the seat')
  assert.equal(canPlace(home, [], P(168, 2, 24), cellsNear([centre(2, 24)], 0.35)), 'you', 'someone at the desk')
  // sealed: a bookcase on the back wall, then a sofa that would close the corner cell behind it off.
  assert.equal(canPlace(home, [P(164, 1, top)], P(163, 0, top + 1)), 'sealed')
  assert.equal(canPlace(home, [P(164, 0, top)], P(163, 0, top + 1)), 'ok', 'nothing left behind it to close off')
  // seat: another's seat closed off.
  const station = build(home, [P(168, 1, top), P(160, 0, top + 2)])
  assert.equal(canPlace(home, station, P(163, 3, top, 1)), 'seat')
  assert.equal(canPlace(home, station, P(163, 4, top, 1)), 'ok', 'a column further over leaves the way to the seat')
  // seat: its own seat in an old pocket (left when the piece that filled it was taken away)...
  const walls = build(home, [P(160, 0, top), P(163, 3, top, 1), P(160, 0, top + 2)])
  const pocket = walls.slice(1)
  assert.equal(reach(home, pocket)[cellIndex(0, top)], 0, 'the pocket')
  assert.equal(canPlace(home, pocket, P(168, 0, top)), 'seat')
  // ... while an old pocket never blocks a piece without one.
  assert.equal(canPlace(home, pocket, P(164, 0, top)), 'ok')
})

test('canPlace: full at sixteen pieces, and the order of the reasons', () => {
  const home = 5
  const sixteen = build(home, [...HOME_STAGING[5], ...[2, 5, 8, 22, 25, 28].map((c) => P(168, c, 20))])
  assert.equal(sixteen.length, HOME_PIECES)
  assert.equal(canPlace(home, sixteen, P(168, 2, 24)), 'full')
  assert.equal(canPlace(home, sixteen.slice(1), P(168, 2, 24)), 'ok')
  // The line's own reasons come before the cells': unowned, then full, then copies, then where it stands.
  assert.equal(canPlace(home, sixteen, P(168, -5, 24), null, () => false), 'unowned')
  assert.equal(canPlace(home, sixteen, P(168, -5, 24)), 'full')
  assert.equal(canPlace(home, [P(166, 25, 8)], P(166, -5, 24)), 'copies')
  assert.equal(canPlace(home, [], P(163, 12, 33)), 'outside', 'outside before the apron')
  assert.equal(canPlace(home, [], P(164, 12, 31, 2)), 'doorway', 'the apron before the wall rule')
  assert.equal(canPlace(home, [P(163, 2, 10)], P(164, 2, 10)), 'wall', 'the wall rule before overlap')
  assert.equal(canPlace(home, [P(163, 2, 10)], P(163, 2, 10), cellsNear([cellCentre(2, 10)], 0.35)), 'overlap', 'overlap before someone standing there')
})

test('the wall rule for every turn, every wall line and every home', () => {
  for (const id of SHAPE_IDS.filter((i) => SHAPES[i].wall)) {
    const s = SHAPES[id]
    for (const home of HOMES) {
      const top = first(home)
      // A backed spot and the spot one cell in from it, for each turn.
      const spots: [Piece, Piece][] = [
        [P(id, 2, top, 0), P(id, 2, top + 1, 0)],
        [P(id, GRID - s.d, top + 2, 1), P(id, GRID - s.d - 1, top + 2, 1)],
        [P(id, 2, GRID - s.d, 2), P(id, 2, GRID - s.d - 1, 2)],
        [P(id, 0, top + 2, 3), P(id, 1, top + 2, 3)],
      ]
      spots.forEach(([on, off], rot) => {
        assert.equal(canPlace(home, [], on), 'ok', `line ${id} home ${home} turn ${rot}: backed`)
        assert.equal(canPlace(home, [], off), 'wall', `line ${id} home ${home} turn ${rot}: one cell in`)
      })
      // Turn 2 on the doorway's wall is backed but may not stand in the apron.
      assert.equal(canPlace(home, [], P(id, 12, GRID - s.d, 2)), 'doorway')
    }
  }
  // A piece that is not a wall piece stands anywhere.
  assert.equal(canPlace(0, [], P(163, 10, 23, 1)), 'ok')
})

test('the apron always stays free: every footprint that reaches into it is refused as the doorway, in every home', () => {
  let refused = 0
  for (const home of HOMES) {
    for (const id of SHAPE_IDS) {
      for (const rot of ROTS) {
        for (let r = APRON.r0 - 4; r <= APRON.r1; r++) {
          for (let c = APRON.c0 - 4; c <= APRON.c1; c++) {
            const p = P(id, c, r, rot), f = footprint(p)!
            let into = false, inside = true
            for (let y = f.r; y < f.r + f.rows; y++) for (let x = f.c; x < f.c + f.cols; x++) { into ||= inApron(x, y); inside &&= inMask(home, x, y) }
            if (!inside) continue
            const v = canPlace(home, [], p)
            if (into) { assert.equal(v, 'doorway', `home ${home} ${JSON.stringify(p)}`); refused++ } else assert.notEqual(v, 'doorway')
          }
        }
      }
    }
  }
  assert.ok(refused > 1000, `${refused} refused`)
})

test('reach: the whole plan on an empty floor, never a solid cell, never diagonally', () => {
  for (const home of HOMES) {
    const seen = reach(home, [])
    let n = 0
    for (let at = 0; at < GRID * GRID; at++) n += seen[at]
    assert.equal(n, DEPTH[home] * GRID, `home ${home}`)
  }
  // Two pieces meeting at a corner leave the cell behind them closed off: a diagonal squeeze is no way through.
  const home = 0, top = first(home)
  const corner = build(home, [P(164, 1, top)])
  assert.equal(canPlace(home, corner, P(168, 0, top + 1, 1)), 'ok', 'a workstation turned with its seat on column 0 keeps the corner open')
  const seen = reach(home, [P(164, 1, top), P(166, 0, top + 1)])
  assert.equal(seen[cellIndex(0, top)], 0)
  assert.equal(seen[cellIndex(1, top)], 0, 'under the bookcase')
  assert.equal(reach(9, []).some((x) => x !== 0), false, 'no such home')
})

// ---------------------------------------------------------------- fitting, the fuzz and the show homes

test('fitLayout keeps what is not owned or does not fit, in order, and places the rest', () => {
  const home = 0, top = first(home)
  const saved = [P(163, 2, 24), P(166, 2, 24), P(164, 5, top), P(162, 20, 21), P(162, 25, 21), P(165, 14, top)]
  const owns = (id: number) => id !== 165
  const { placed, stored } = fitLayout(home, saved, owns)
  assert.deepEqual(placed, [saved[0], saved[2], saved[3]])
  assert.deepEqual(stored, [saved[1], saved[4], saved[5]], 'overlap, copies and unowned are stored, not dropped')
  assert.deepEqual(fitLayout(home, saved, () => false), { placed: [], stored: saved })
  // The brownstone's layout drawn in the shallower micro-loft: what stands behind its back row is stored.
  const moved = fitLayout(0, HOME_STAGING[1], () => true)
  assert.deepEqual(moved.placed, HOME_STAGING[1].filter((p) => p.r >= first(0)))
  assert.deepEqual(moved.stored, HOME_STAGING[1].filter((p) => p.r < first(0)))
  assert.ok(moved.stored.length > 0 && moved.placed.length > 0)
  assertSound(0, moved.placed, 'the brownstone in the micro-loft')
  // Someone standing where a piece goes stores it, when the engine asks.
  const sofaCells = cellsNear([cellCentre(3, 24)], 0.3)
  assert.deepEqual(fitLayout(home, [saved[0]], null, sofaCells), { placed: [], stored: [saved[0]] })
})

test('comfortOf counts the different furniture lines standing in a home: copies once, nothing that is not a line; the show homes hold 3, 4, 3, 4, 3, 5 and 5', () => {
  assert.deepEqual(HOME_STAGING.map(comfortOf), [3, 4, 3, 4, 3, 5, 5])
  const top = first(0)
  assert.equal(comfortOf([P(164, 4, top), P(164, 25, top), P(164, 8, top)]), 1, 'three bookcases are one kind')
  assert.equal(comfortOf([]), 0)
  assert.equal(comfortOf([P(999, 4, top)]), 0, 'not a furniture line')
  assert.equal(comfortOf([P(999, 4, top), P(163, 2, 24), P(160, 14, 21)]), 2)
  // What stands, not what is saved: a layout fitted with only the bookcase owned has one kind.
  assert.equal(comfortOf(fitLayout(0, HOME_STAGING[0], (id) => id === 164).placed), 1)
})

test('2,000 seeded runs of placing, removing and fitting keep the apron free, every seat reachable, and every removal allowed', () => {
  const t0 = performance.now()
  const rng = createRng(0x2b5eed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]
  const verdicts = new Map<Verdict, number>()
  const randomPiece = (home: number): Piece => {
    const id = rng() < 0.3 ? 168 : pick(SHAPE_IDS), s = SHAPES[id], rot = Math.floor(rng() * 4)
    const cols = rot % 2 ? s.d : s.w, rows = rot % 2 ? s.w : s.d, top = first(home)
    let c = Math.floor(rng() * (GRID - cols + 1)), r = top + Math.floor(rng() * (DEPTH[home] - rows + 1))
    if (s.wall && rng() < 0.7) [c, r] = [[c, top], [GRID - cols, r], [c, GRID - rows], [0, r]][rot] as [number, number]
    if (rng() < 0.03) r = top - 1 // now and then a row behind the plan
    return P(id, c, r, rot)
  }
  for (let run = 0; run < 2000; run++) {
    const home = Math.floor(rng() * 7)
    let placed: Piece[] = [], stored: Piece[] = []
    const steps = 8 + Math.floor(rng() * 12)
    for (let step = 0; step < steps; step++) {
      const what = rng()
      if (what < 0.72) {
        const p = randomPiece(home)
        const blocked = rng() < 0.2 ? cellsNear([{ u: (rng() * 2 - 1) * GRID_HALF, v: (rng() * 2 - 1) * GRID_HALF }], 0.35) : null
        const v = canPlace(home, placed, p, blocked)
        verdicts.set(v, (verdicts.get(v) ?? 0) + 1)
        if (v === 'ok') {
          if (blocked) for (const at of pieceCells(p).blocked) assert.equal(blocked[at], 0, 'placed over someone')
          if (blocked) assert.equal(canPlace(home, placed, p), 'ok', 'someone standing by only ever adds a refusal')
          placed = [...placed, p]
        } else stored = [...stored, p].slice(-8)
      } else if (what < 0.9) {
        if (placed.length === 0) continue
        const before = reach(home, placed)
        const i = Math.floor(rng() * placed.length)
        placed = placed.filter((_, j) => j !== i)
        const after = assertSound(home, placed, `run ${run} removal`)
        for (let at = 0; at < GRID * GRID; at++) if (before[at]) assert.equal(after[at], 1, `run ${run}: a removal cut off cell ${at}`)
      } else {
        const saved = [...placed, ...stored, randomPiece(home)]
        for (let i = saved.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [saved[i], saved[j]] = [saved[j], saved[i]] }
        const mask = Math.floor(rng() * 512)
        const owns = (id: number) => ((mask >>> (id - FURNITURE_BASE)) & 1) === 1
        const fit = fitLayout(home, saved, owns)
        assert.equal(fit.placed.length + fit.stored.length, saved.length, 'nothing dropped')
        for (const p of fit.placed) assert.ok(owns(p.id), 'only owned lines placed')
        let i = 0, j = 0
        for (const p of saved) { if (fit.placed[i] === p) i++; else { assert.equal(fit.stored[j], p, 'order kept'); j++ } }
        placed = fit.placed
        stored = fit.stored.slice(-8)
      }
      assertSound(home, placed, `run ${run} step ${step}`)
    }
  }
  const ms = performance.now() - t0
  for (const v of ['ok', 'outside', 'overlap', 'doorway', 'wall', 'copies', 'you', 'sealed'] as Verdict[]) assert.ok((verdicts.get(v) ?? 0) > 0, `the fuzz never saw '${v}': ${JSON.stringify([...verdicts])}`)
  assert.ok(ms < 4000, `${ms.toFixed(0)} ms`)
})

test('someone standing inside a piece that is not yet solid is never ringed in, and nobody else\'s way is measured through them', () => {
  const home = 5
  // A sofa fitted over someone (fitLayout without the engine's table): the worker keeps it off while they stand in it.
  const sofa = fitLayout(home, [P(163, 9, 10)], () => true).placed
  assert.equal(sofa.length, 1)
  const inSofa = cellsNear([cellCentre(10, 10)], 0.37)
  const ring = [P(163, 9, 8), P(163, 9, 12), P(166, 7, 9)]
  for (const p of ring) assert.equal(canPlace(home, [...sofa, ...ring.slice(0, ring.indexOf(p))], p, inSofa), 'ok', `${JSON.stringify(p)}: a way out stays`)
  const closing = P(160, 13, 9, 1)
  assert.equal(canPlace(home, [...sofa, ...ring], closing, inSofa), 'sealed', 'the last way out of the sofa\'s floor')
  assert.equal(canPlace(home, [...sofa, ...ring], closing), 'ok', 'with nobody inside it the same piece is fine')
  assert.equal(reach(home, ring)[cellIndex(10, 10)], 1, 'the sofa taken away: they walk out')
  // Deep inside: the middle of the hologram table, whose every neighbouring cell is the table's own.
  const table = [P(162, 14, 14)]
  const inTable = cellsNear([cellCentre(15, 15)], 0.37)
  const round = [P(163, 14, 12), P(163, 14, 17), P(166, 12, 14)]
  for (const p of round) assert.equal(canPlace(home, [...table, ...round.slice(0, round.indexOf(p))], p, inTable), 'ok')
  assert.equal(canPlace(home, [...table, ...round], P(160, 17, 14, 1), inTable), 'sealed')
  assert.equal(canPlace(home, [...table, ...round], P(160, 17, 14, 1)), 'ok')
  assert.equal(reach(home, round)[cellIndex(15, 15)], 1)
  // Someone inside a sofa joins the strip behind it to the room, but only while they stand there: a bookcase that cuts
  // the strip's real way out is still refused, though someone else stands in the strip.
  const { u, v } = cellCentre(1, 1)
  const two = cellsNear([{ u: u + CELL / 2, v }, cellCentre(3, 0)], 0.37)
  assert.deepEqual([...two.keys()].filter((i) => two[i]), [cellIndex(3, 0), cellIndex(1, 1), cellIndex(1, 2)])
  assert.equal(canPlace(home, [P(163, 0, 1)], P(164, 4, 0), two), 'sealed')
  assert.equal(canPlace(home, [P(163, 0, 1)], P(164, 4, 0)), 'sealed')
})

test('400 seeded runs: whatever is placed or removed round someone inside a piece, taking the piece away leaves them a way out', () => {
  const t0 = performance.now()
  const rng = createRng(0x5ea7ed)
  const int = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1))
  const LOOSE = SHAPE_IDS.filter((id) => !SHAPES[id].wall)
  /**
   * A random piece anywhere in the plan; or, given a piece, a free-standing one grown away from it over a cell beside its
   * footprint that can still be walked to, so the runs try hard to ring it in.
   */
  const piece = (home: number, round: Piece | null, layout: readonly Piece[]): Piece => {
    const id = round ? LOOSE[int(0, LOOSE.length - 1)] : SHAPE_IDS[int(0, SHAPE_IDS.length - 1)], rot = int(0, 3), s = SHAPES[id]
    const cols = rot % 2 ? s.d : s.w, rows = rot % 2 ? s.w : s.d
    if (!round) return P(id, int(0, GRID - cols), int(first(home), GRID - rows), rot)
    const seen = reach(home, layout), f = footprint(round)!
    const open: number[] = []
    for (let r = f.r - 1; r <= f.r + f.rows; r++) {
      for (let c = f.c - 1; c <= f.c + f.cols; c++) {
        const beside = (r === f.r - 1 || r === f.r + f.rows) !== (c === f.c - 1 || c === f.c + f.cols)
        if (beside && c >= 0 && c < GRID && r >= 0 && r < GRID && seen[cellIndex(c, r)]) open.push(cellIndex(c, r))
      }
    }
    if (open.length === 0) return P(id, f.c, f.r, rot)
    const z = open[int(0, open.length - 1)], zc = z % GRID, zr = Math.floor(z / GRID)
    const c = zc < f.c ? zc - cols + 1 : zc >= f.c + f.cols ? zc : zc - int(0, cols - 1)
    const r = zr < f.r ? zr - rows + 1 : zr >= f.r + f.rows ? zr : zr - int(0, rows - 1)
    return P(id, c, r, rot)
  }
  let runs = 0, rings = 0
  for (let run = 0; run < 400; run++) {
    const home = int(0, 6)
    // A few pieces already standing, then one fitted over someone in one of the cells it blocks: mostly near the cell's
    // middle (marking that cell alone), otherwise anywhere in it (marking the cells beside it too).
    const placed: Piece[] = []
    for (let k = int(0, 5); k > 0; k--) { const p = piece(home, null, placed); if (canPlace(home, placed, p) === 'ok') placed.push(p) }
    const s = piece(home, null, placed)
    if (canPlace(home, placed, s) !== 'ok') continue
    const solid = pieceCells(s).blocked
    const at = solid[int(0, solid.length - 1)], centre = cellCentre(at % GRID, Math.floor(at / GRID))
    const spread = rng() < 0.6 ? 0.04 : 0.9
    const person = { u: centre.u + (rng() - 0.5) * CELL * spread, v: centre.v + (rng() - 0.5) * CELL * spread }
    const cell = cellAt(person.u, person.v)!
    const near = cellsNear([person], 0.37)
    if (reach(home, placed)[cellIndex(cell.c, cell.r)] !== 1) continue // they stood in an old pocket to begin with
    placed.push(s)
    runs++
    for (let step = 0; step < 30; step++) {
      if (rng() < 0.85) {
        const p = piece(home, s, placed)
        const v = canPlace(home, placed, p, near)
        if (v === 'ok') placed.push(p)
        else if (v === 'sealed' && canPlace(home, placed, p) === 'ok') rings++
      } else if (placed.length > 1) {
        const i = int(0, placed.length - 1)
        if (placed[i] !== s) placed.splice(i, 1)
      }
    }
    assert.equal(reach(home, placed.filter((p) => p !== s))[cellIndex(cell.c, cell.r)], 1, `run ${run}: shut in on the floor of ${JSON.stringify(s)}`)
  }
  assert.ok(runs > 150, `${runs} runs had someone inside a piece`)
  assert.ok(rings >= 10, `${rings} pieces refused only because they would ring someone in`)
  assert.ok(performance.now() - t0 < 2000, 'quick')
})

test('every show home fits its own home piece by piece, with the plan\'s furniture', () => {
  const want: Record<number, number>[] = [
    { 163: 1, 164: 2, 160: 1 },
    { 163: 2, 164: 3, 160: 1, 167: 1 },
    { 163: 2, 165: 1, 164: 2 },
    { 162: 1, 166: 1, 163: 2, 161: 1 },
    { 163: 3, 166: 1, 167: 2 },
    { 166: 1, 165: 1, 163: 3, 162: 1, 164: 4 },
    { 162: 1, 166: 1, 163: 2, 161: 1, 168: 2 },
  ]
  assert.equal(HOME_STAGING.length, 7)
  for (const home of HOMES) {
    const layout = HOME_STAGING[home]
    assert.ok(Object.isFrozen(layout) && layout.every(Object.isFrozen), `home ${home} is frozen`)
    build(home, layout)
    assertSound(home, layout, `show home ${home}`)
    const count: Record<number, number> = {}
    for (const p of layout) count[p.id] = (count[p.id] ?? 0) + 1
    assert.deepEqual(count, want[home], `show home ${home}`)
    assert.deepEqual(fitLayout(home, layout, () => true), { placed: [...layout], stored: [] })
  }
})

// ---------------------------------------------------------------- the boxes

test('renderBoxes and solidBox: in the room frame, inside the footprint by 1 cm, and within what the worker accepts', () => {
  const apron = { u0: -GRID_HALF + APRON.r0 * CELL, u1: -GRID_HALF + (APRON.r1 + 1) * CELL, v0: -GRID_HALF + APRON.c0 * CELL, v1: -GRID_HALF + (APRON.c1 + 1) * CELL }
  for (const home of HOMES) {
    for (const p of [...HOME_STAGING[home], ...dense(home)]) {
      const f = footprint(p)!
      const u0 = -GRID_HALF + f.r * CELL, v0 = -GRID_HALF + f.c * CELL, u1 = u0 + f.rows * CELL, v1 = v0 + f.cols * CELL
      for (const { box } of renderBoxes(p)) {
        assert.ok(box[0] >= u0 + PIECE_INSET - 1e-9 && box[2] <= u1 - PIECE_INSET + 1e-9 && box[1] >= v0 + PIECE_INSET - 1e-9 && box[3] <= v1 - PIECE_INSET + 1e-9, `${JSON.stringify(p)}: ${box}`)
        assert.ok(box[2] > box[0] && box[3] > box[1] && box[5] > box[4])
      }
      const s = solidBox(p)!
      const solid = solidOf(p.id)!
      assert.deepEqual([s[4], s[5]], [0, solid.top])
      // The bounds simCore's 'home' command checks (plan 6.7): inside the plan with 1 cm of slack, on the floor, under 4.15 m, at least 0.4 m tall and 5 cm across, off the apron.
      assert.ok(s[0] >= backEdge(home) - 0.01 && s[2] <= GRID_HALF + 0.01 && s[1] >= -GRID_HALF - 0.01 && s[3] <= GRID_HALF + 0.01, `${JSON.stringify(p)}: ${s}`)
      assert.ok(s[5] <= 4.15 && s[5] - s[4] >= 0.4 && s[2] - s[0] >= 0.05 && s[3] - s[1] >= 0.05)
      assert.ok(!(s[2] > apron.u0 && s[0] < apron.u1 && s[3] > apron.v0 && s[1] < apron.v1), `${JSON.stringify(p)} reaches the apron`)
      // The collider is the solid, turned and inset: exactly the cells it blocks.
      const { blocked } = pieceCells(p)
      for (let r = f.r; r < f.r + f.rows; r++) {
        for (let c = f.c; c < f.c + f.cols; c++) {
          const cu0 = -GRID_HALF + r * CELL, cv0 = -GRID_HALF + c * CELL
          const over = Math.min(s[2], cu0 + CELL) - Math.max(s[0], cu0) > COVER && Math.min(s[3], cv0 + CELL) - Math.max(s[1], cv0) > COVER
          assert.equal(blocked.includes(cellIndex(c, r)), over, `${JSON.stringify(p)} cell ${c},${r}`)
        }
      }
    }
  }
  assert.deepEqual(renderBoxes(P(999, 0, 0)), [])
  assert.equal(solidBox(P(163, 0, 0, 5)), null)
})

test('the floor overlay and the wall panels: the plan\'s numbers', () => {
  for (const home of HOMES) {
    const face = backEdge(home) - INSET
    assert.deepEqual(floorOverlay(home).map((x) => +x.toFixed(9)), [face, -12.5, 12.5, 12.5, 0.003, 0.015].map((x) => +x.toFixed(9)))
    assert.deepEqual(floorOverlay(home, 0.035).slice(4).map((x) => +x.toFixed(9)), [0.038, 0.05])
    assert.deepEqual(wallPanels(home, 0), [], 'glass has no panels')
    assert.deepEqual(wallPanels(home, 99), [], 'nor does an index that is not a finish')
    for (let wall = 1; wall < WALLS.length; wall++) {
      const panels = wallPanels(home, wall).map((b) => b.map((x) => +x.toFixed(9)))
      const r = (x: number) => +x.toFixed(9)
      assert.deepEqual(panels, [
        [r(face + 0.012), -12.488, r(face + 0.032), 12.488, 0, 4.2],
        [r(face + 0.032), -12.488, 12.468, -12.468, 0, 4.2],
        [r(face + 0.032), 12.468, 12.468, 12.488, 0, 4.2],
        [12.468, -12.488, 12.488, -2.02, 0, 4.2],
        [12.468, 2.02, 12.488, 12.488, 0, 4.2],
      ], `home ${home} wall ${wall}`)
    }
  }
  close(face(5), -12.5)
  assert.deepEqual([PANEL.thick, PANEL.gap, PANEL.door, OVERLAY.y0, OVERLAY.y1], [0.02, 0.012, 0.02, 0.003, 0.015])
  assert.throws(() => floorOverlay(7), RangeError)
  assert.throws(() => wallPanels(-1, 1), RangeError)
  function face(home: number) { return backEdge(home) - INSET }
})

/** A layout as full as a seeded fill can make it, in every line and turn it can fit: sixteen pieces, or as near as it gets. */
function dense(home: number): Piece[] {
  const rng = createRng(0xd15e + home)
  const placed: Piece[] = []
  for (let n = 0; n < 6000 && placed.length < HOME_PIECES; n++) {
    const id = SHAPE_IDS[Math.floor(rng() * SHAPE_IDS.length)], rot = Math.floor(rng() * 4)
    const p = P(id, Math.floor(rng() * GRID), first(home) + Math.floor(rng() * DEPTH[home]), rot)
    if (canPlace(home, placed, p) === 'ok') placed.push(p)
  }
  return placed
}

/** A room-frame box as a city box for a lot facing `side` (properties.ts worldBox, the same sums). */
function cityBox(room: { cx: number; cz: number; side: Side }, [u0, v0, u1, v1, y0, y1]: RoomBox): Box {
  const p = toWorld(room, u0, v0), q = toWorld(room, u1, v1)
  return [Math.min(p.x, q.x), y0, Math.min(p.z, q.z), Math.max(p.x, q.x), y1, Math.max(p.z, q.z)]
}

/** The first pair of faces that lie in one plane, face the same way and share some area, or null. */
function sharedFace(a: Box, b: Box, eps = 1e-6): string | null {
  for (let axis = 0; axis < 3; axis++) {
    const [o1, o2] = [0, 1, 2].filter((x) => x !== axis)
    const area = Math.min(a[o1 + 3], b[o1 + 3]) - Math.max(a[o1], b[o1]) > eps && Math.min(a[o2 + 3], b[o2 + 3]) - Math.max(a[o2], b[o2]) > eps
    if (!area) continue
    if (Math.abs(a[axis] - b[axis]) < eps) return `the ${'xyz'[axis]}− faces at ${a[axis]}`
    if (Math.abs(a[axis + 3] - b[axis + 3]) < eps) return `the ${'xyz'[axis]}+ faces at ${a[axis + 3]}`
  }
  return null
}

const overlaps = (a: Box, b: Box, eps = 1e-6) => [0, 1, 2].every((k) => Math.min(a[k + 3], b[k + 3]) - Math.max(a[k], b[k]) > eps)

test('no two boxes of a home share a face: the shell, the fill, the planters, the overlay, the panels and a full layout, in every home facing every way', () => {
  let pairs = 0
  for (const home of HOMES) {
    for (const side of [0, 1, 2, 3] as Side[]) {
      const [built] = homesAt([{ home, k: 5, m: 6, side }])
      const room = { cx: built.cx, cz: built.cz, side }
      const fixed: [string, Box][] = [...built.shell.map((b, i): [string, Box] => [`shell ${i}`, b.box]), ...built.fixtures.map((b, i): [string, Box] => [`fixture ${i}`, b.box])]
      const panels = wallPanels(home, 1).map((b, i): [string, Box] => [`panel ${i}`, cityBox(room, b)])
      const finishes: [string, Box][] = [['overlay', cityBox(room, floorOverlay(home))], ['overlay on a paved floor', cityBox(room, floorOverlay(home, 0.035))], ...panels]
      for (const [name, layout] of [['show home', HOME_STAGING[home]], ['full layout', dense(home)]] as const) {
        const pieces = layout.flatMap((p, i) => renderBoxes(p).map(({ box }, j): [string, Box] => [`${name} piece ${i} box ${j}`, cityBox(room, box)]))
        const all = [...fixed, ...finishes.filter(([n]) => n !== 'overlay on a paved floor'), ...pieces]
        for (let i = 0; i < all.length; i++) {
          for (let j = i + 1; j < all.length; j++) {
            pairs++
            const hit = sharedFace(all[i][1], all[j][1])
            assert.equal(hit, null, `home ${home} side ${side}: ${all[i][0]} and ${all[j][0]} share ${hit}`)
          }
        }
        // Nothing drawn inside a wall, the fill block, a planter or a panel, and no two pieces inside each other.
        for (const [pn, pb] of pieces) for (const [fn, fb] of [...fixed, ...panels]) assert.ok(!overlaps(pb, fb), `home ${home} side ${side}: ${pn} inside ${fn}`)
        for (const [an, ab] of panels) for (const [fn, fb] of fixed) assert.ok(!overlaps(ab, fb), `home ${home} side ${side}: ${an} inside ${fn}`)
        for (let i = 0; i < layout.length; i++) {
          for (let j = i + 1; j < layout.length; j++) {
            for (const a of renderBoxes(layout[i])) for (const b of renderBoxes(layout[j])) assert.ok(!overlaps(cityBox(room, a.box), cityBox(room, b.box)), `home ${home}: pieces ${i} and ${j} meet`)
          }
        }
      }
      // The overlay on a paved floor clears the fixtures' faces too.
      for (const [fn, fb] of [...fixed, ...panels]) assert.equal(sharedFace(finishes[1][1], fb), null, `home ${home} side ${side}: the paved overlay and ${fn}`)
      // The overlay runs from the fill block's face (or the back glass) to the doorway wall, wall to wall: it touches them and goes into none.
      for (const [fn, fb] of fixed) assert.ok(!overlaps(finishes[0][1], fb), `home ${home} side ${side}: the overlay inside ${fn}`)
    }
  }
  // Every line at every turn, alone.
  for (const id of SHAPE_IDS) {
    for (const rot of ROTS) {
      const boxes = renderBoxes(P(id, 8, 8, rot)).map(({ box }) => cityBox({ cx: 0, cz: 0, side: 0 }, box))
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.equal(sharedFace(boxes[i], boxes[j]), null, `line ${id} turn ${rot}: boxes ${i} and ${j}`)
    }
  }
  assert.ok(pairs > 50000, `${pairs} pairs`)
  // The test itself: two boxes side by side share no face; a box on another's top face, flush at one side, does.
  assert.equal(sharedFace([0, 0, 0, 1, 1, 1], [1, 0, 0, 2, 1, 1]), null)
  assert.ok(sharedFace([0, 0, 0, 2, 1, 1], [0, 0, 0, 1, 0.5, 1]))
})

test('cellAt and cellsNear', () => {
  for (const [c, r] of [[0, 0], [31, 31], [13, 28], [5, 20]]) {
    const { u, v } = cellCentre(c, r)
    assert.deepEqual(cellAt(u, v), { c, r })
  }
  assert.equal(cellAt(GRID_HALF + 0.01, 0), null)
  assert.equal(cellAt(0, -GRID_HALF - 0.01), null)
  assert.equal(cellAt(Number.NaN, 0), null)
  // A person in the middle of a cell, with a margin smaller than half a cell, stands in that cell alone.
  const one = cellsNear([cellCentre(4, 22)], 0.35)
  assert.deepEqual([...one.keys()].filter((i) => one[i]), [cellIndex(4, 22)])
  // On a corner, in all four.
  const { u, v } = cellCentre(4, 22)
  const four = cellsNear([{ u: u + CELL / 2, v: v + CELL / 2 }], 0.35)
  assert.deepEqual([...four.keys()].filter((i) => four[i]), [cellIndex(4, 22), cellIndex(5, 22), cellIndex(4, 23), cellIndex(5, 23)])
  assert.equal(cellsNear([{ u: Number.NaN, v: 0 }], 1).some((x) => x !== 0), false)
})

// ---------------------------------------------------------------- the names

/** The words conduct.test.ts calls armed (its ARMED), as whole words with their common forms. */
const ARMED = /\b(?:guns?|gunfire|firearms?|rifles?|pistols?|handguns?|shotguns?|revolvers?|weapons?|weaponry|holsters?|ammo|ammunition|bullets?|knife|knives|blades?|swords?|katanas?|machetes?|daggers?|grenades?|bombs?|explosives?|muzzles?|snipers?|shoot(?:s|ing|ers?)?|shots?|melee|combat|armed|arsenal|turrets?|missiles?|rockets?|punch(?:es|ing|ed)?|fights?|fighting|attacks?|attacking)\b/i
/** The shipped source's real-place scan (compliance.test.ts REAL_PLACES). */
const SHIPPED_PLACES = /\b(?:Toronto|Ontario|Mississauga|Brampton|Scarborough|Etobicoke|Markham|Oakville|Burlington|Oshawa|Pickering|Vaughan|Richmond Hill|Hamilton|Niagara|Cambridge|Galt|Hespeler|Harbourfront|Queens? Quay|Yonge|Gardiner|Don Valley|Humber|CN Tower|Rogers Centre|Scotiabank)\b/

test('every line and finish name passes the 14A screen, is unarmed, names no real place and avoids the banned word', () => {
  const names = [...SHAPE_IDS.map((id) => SHAPES[id].name), ...FLOORS.map((f) => f.name), ...WALLS.map((f) => f.name)]
  assert.equal(names.length, 9 + 3 + 6)
  for (const name of names) {
    assert.ok(screen(name).admissible, `${name} fails the screen`)
    assert.equal(name.match(ARMED), null, name)
    assert.equal(forbiddenWordIn(name), null, name)
    assert.equal(name.match(SHIPPED_PLACES), null, name)
    for (const place of REAL_PLACES) assert.ok(!new RegExp(`\\b${place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(name), `${name} names ${place}`)
    assert.doesNotMatch(name, /matri/i)
  }
  assert.doesNotMatch(SHAPES[165].name, /\b(?:wine|beer|cocktail|liquor|spirits?|whisk(?:e)?y|vodka|gin|rum)\b/i, 'the bar is coffee and juice')
})

test('stationOf turns with the piece: on the edge between the two seat cells, facing the desk', () => {
  // Line 168 at (10, 20): u toward the doorway, v across, in the room frame (probed: the station is [1, 1.5] in its own cells).
  const want = [
    { u: -GRID_HALF + 21.5 * CELL, v: -GRID_HALF + 11 * CELL, fu: -1, fv: 0 },
    { u: -GRID_HALF + 21 * CELL, v: -GRID_HALF + 10.5 * CELL, fu: 0, fv: 1 },
    { u: -GRID_HALF + 20.5 * CELL, v: -GRID_HALF + 11 * CELL, fu: 1, fv: 0 },
    { u: -GRID_HALF + 21 * CELL, v: -GRID_HALF + 11.5 * CELL, fu: 0, fv: -1 },
  ]
  for (let rot = 0; rot < 4; rot++) {
    const p = P(168, 10, 20, rot)
    const s = stationOf(p)
    assert.ok(s, `turn ${rot}`)
    close(s.u, want[rot].u)
    close(s.v, want[rot].v)
    assert.deepEqual([s.fu, s.fv], [want[rot].fu, want[rot].fv], `turn ${rot} faces the desk`)
    // Three quarters of a cell ahead is a cell the desk blocks; a quarter of a cell to either side is one of the two
    // seat cells, so the station is on the edge between them, in the middle of the seat row.
    const at = (du: number, dv: number) => { const cell = cellAt(s.u + du * CELL, s.v + dv * CELL); return cell ? cellIndex(cell.c, cell.r) : -1 }
    const { blocked, seat } = pieceCells(p)
    assert.ok(blocked.includes(at(s.fu * 0.75, s.fv * 0.75)), `turn ${rot}: the desk ahead`)
    const left = at(s.fv * 0.25, -s.fu * 0.25), right = at(-s.fv * 0.25, s.fu * 0.25)
    assert.ok(left !== right && seat.includes(left) && seat.includes(right), `turn ${rot}: on the edge between the two seat cells`)
  }
})

test('stationOf is null for lines without a station and for malformed pieces; stationsIn lists workstations in reading order', () => {
  for (const id of SHAPE_IDS) if (id !== 168) assert.equal(stationOf(P(id, 10, 20)), null, `line ${id}`)
  assert.equal(stationOf(P(168, 10, 20, 4)), null)
  assert.equal(stationOf(P(168, 1.5, 20)), null)
  assert.equal(stationOf(P(168, 10, 20, -1)), null)
  assert.equal(stationOf(P(999, 10, 20)), null)
  const list = [P(164, 2, 16), P(168, 10, 20), P(168, 4, 24), P(168, 4, 20)]
  assert.deepEqual(stationsIn(list), [P(168, 4, 20), P(168, 10, 20), P(168, 4, 24)], 'back row first, then left to right')
  assert.deepEqual(stationsIn(HOME_STAGING[6]).map((p) => p.c), [4, 7], 'the sky-mansion\'s two')
})
