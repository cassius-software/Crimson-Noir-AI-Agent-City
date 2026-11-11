// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins a home's floor plan (homeGrid.ts), which is shipped data: a saved layout names its
 * cells, so the grid's size, a cell's side, each home's depth and the apron must never change meaning. It holds the
 * grid to the room it lies in (its edges a few centimetres inside the glass, a cell wide enough for a person to walk
 * through, the apron covering the whole doorway) and the helpers to the numbers they derive from.
 * What breaks if it is removed? A change to a cell's size or a home's depth would strand every saved layout, or move
 * the grid through the glass, and nothing would notice until a player's furniture went missing.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CITY } from '../01_Initialize_World/city.ts'
import { ROOM } from '../01_Initialize_World/interiors.ts'
import { PERSON } from '../07_Execute_Actions/simProtocol.ts'
import {
  APRON, ARRIVAL, CELL, DEPTH, GRID, GRID_HALF, HOME_PIECES, INSET, ROOM_COUNT, SKY, SKY_HOMES, backEdge, cellCentre, deedOf, inApron, inKeep, inMask, planOf, skyRoom,
} from './homeGrid.ts'

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)

test('the shipped values: frozen, and exactly what a saved layout was written against', () => {
  assert.equal(GRID, 32)
  assert.equal(CELL, 0.778)
  assert.equal(GRID_HALF, 12.448)
  assert.equal(INSET, 0.052)
  assert.equal(HOME_PIECES, 16)
  assert.deepEqual(DEPTH, [12, 16, 20, 24, 28, 32, 32])
  assert.deepEqual(APRON, { r0: 28, r1: 31, c0: 13, c1: 18 })
  assert.ok(Object.isFrozen(DEPTH) && Object.isFrozen(APRON))
  assert.equal(HOME_PIECES, ROOM.furniture, 'a home holds as many pieces as a workplace')
})

test('the grid lies inside the glass: its edges 5.2 cm in from the inner faces, and GRID cells of CELL across', () => {
  close(GRID * CELL / 2, GRID_HALF)
  close(GRID_HALF + INSET, CITY.lotHalf - ROOM.wall)
  close(GRID_HALF + INSET, 12.5)
})

test('one cell is wide enough for a person to walk through, with two centimetres of skin each side', () => {
  assert.ok(CELL >= 2 * (PERSON.radius + 0.02), `${CELL} m for a ${PERSON.radius} m capsule`)
})

test('every home is as deep as the one before it or deeper, ending at the full grid for the two grandest', () => {
  assert.equal(DEPTH.length, 7)
  for (let i = 1; i < DEPTH.length; i++) assert.ok(DEPTH[i] >= DEPTH[i - 1], `home ${i} is shallower than home ${i - 1}`)
  assert.deepEqual(DEPTH.slice(-2), [GRID, GRID])
  for (const d of DEPTH) assert.ok(Number.isInteger(d) && d > APRON.r1 - APRON.r0 + 1 && d <= GRID, `${d} rows`)
  // The depths in metres, as the plan gives them.
  assert.deepEqual(DEPTH.map((d) => (d * CELL).toFixed(1)), ['9.3', '12.4', '15.6', '18.7', '21.8', '24.9', '24.9'])
})

test('the apron covers the whole doorway, from the doorway wall in, and is in every home\'s plan', () => {
  const lo = cellCentre(APRON.c0, APRON.r0), hi = cellCentre(APRON.c1, APRON.r1)
  const v0 = lo.v - CELL / 2, v1 = hi.v + CELL / 2
  assert.ok(v0 < -ROOM.door && v1 > ROOM.door, `the apron spans v ${v0.toFixed(3)} to ${v1.toFixed(3)}, the doorway ±${ROOM.door}`)
  close(v0, -2.334)
  close(v1, 2.334)
  close(lo.u - CELL / 2, 9.336)
  close(hi.u + CELL / 2, GRID_HALF)
  assert.equal(APRON.r1, GRID - 1, 'the apron reaches the doorway row')
  for (let home = 0; home < DEPTH.length; home++) {
    for (let r = APRON.r0; r <= APRON.r1; r++) for (let c = APRON.c0; c <= APRON.c1; c++) assert.ok(inMask(home, c, r), `home ${home}: apron cell ${c},${r}`)
  }
})

test('the helpers: backEdge, cellCentre, inMask and inApron agree with the numbers', () => {
  close(backEdge(5), -GRID_HALF)
  close(backEdge(6), -GRID_HALF)
  close(backEdge(0), -GRID_HALF + 20 * CELL)
  for (let home = 0; home < DEPTH.length; home++) {
    const first = GRID - DEPTH[home]
    close(cellCentre(0, first).u - CELL / 2, backEdge(home))
    assert.ok(inMask(home, 0, first) && inMask(home, GRID - 1, GRID - 1))
    assert.ok(!inMask(home, 0, first - 1), `home ${home}: the row behind its first is out`)
    assert.ok(!inMask(home, -1, GRID - 1) && !inMask(home, GRID, GRID - 1) && !inMask(home, 0, GRID))
    assert.ok(!inMask(home, 0.5, GRID - 1), 'a cell is named by whole numbers')
  }
  assert.ok(!inMask(7, 0, GRID - 1), "room 7's plan does not reach column 0")
  assert.ok(!inMask(9, 15, 15), 'there is no tenth room')
  const c = cellCentre(0, 0)
  close(c.u, -GRID_HALF + CELL / 2)
  close(c.v, -GRID_HALF + CELL / 2)
  const last = cellCentre(GRID - 1, GRID - 1)
  close(last.u, GRID_HALF - CELL / 2)
  close(last.v, GRID_HALF - CELL / 2)
  let apron = 0
  for (let r = 0; r < GRID; r++) for (let col = 0; col < GRID; col++) if (inApron(col, r)) apron++
  assert.equal(apron, 4 * 6)
  assert.ok(!inApron(12, 31) && !inApron(19, 31) && !inApron(15, 27) && !inApron(15.5, 30))
})

test('the rooms: nine; the halls\' plans as before; rooms 7 and 8 share the 20 x 20 plan and its arrival; deedOf and skyRoom undo each other', () => {
  assert.equal(ROOM_COUNT, 9)
  assert.deepEqual([...SKY_HOMES], [3, 6], 'the Penthouse and the Sky-Mansion')
  assert.ok(Object.isFrozen(SKY_HOMES) && Object.isFrozen(SKY) && Object.isFrozen(ARRIVAL))
  // The halls: every row the home is deep, every column, the apron kept.
  for (let h = 0; h < DEPTH.length; h++) {
    assert.deepEqual(planOf(h), { r0: GRID - DEPTH[h], r1: GRID - 1, c0: 0, c1: GRID - 1, keep: APRON }, `hall ${h}`)
    assert.equal(deedOf(h), h)
  }
  // The sky floors: one fixed plan, 20 cells each way, its edges 7.78 m from the centre, the arrival on the doorway side.
  for (const room of [7, 8]) assert.equal(planOf(room), SKY)
  assert.deepEqual([SKY.r0, SKY.r1, SKY.c0, SKY.c1], [6, 25, 6, 25])
  assert.equal(SKY.keep, ARRIVAL)
  assert.deepEqual([ARRIVAL.r0, ARRIVAL.r1, ARRIVAL.c0, ARRIVAL.c1], [22, 25, 13, 18])
  close(backEdge(7), -7.78, 1e-9)
  close(-GRID_HALF + (SKY.r1 + 1) * CELL, 7.78, 1e-9)
  close(-GRID_HALF + SKY.c0 * CELL, -7.78, 1e-9)
  close(cellCentre(ARRIVAL.c0, ARRIVAL.r0).u - CELL / 2, 4.668, 1e-9)
  close((cellCentre(ARRIVAL.c0, ARRIVAL.r0).u - CELL / 2 + cellCentre(ARRIVAL.c1, ARRIVAL.r1).u + CELL / 2) / 2, 6.224, 1e-9)
  close((cellCentre(ARRIVAL.c0, ARRIVAL.r0).v + cellCentre(ARRIVAL.c1, ARRIVAL.r1).v) / 2, 0, 1e-9)
  // The arrival inside the plan, and the hall's apron and the arrival each only their own room's.
  for (let r = ARRIVAL.r0; r <= ARRIVAL.r1; r++) for (let c = ARRIVAL.c0; c <= ARRIVAL.c1; c++) assert.ok(inMask(7, c, r) && inKeep(7, c, r) && inKeep(8, c, r))
  assert.ok(!inKeep(7, APRON.c0, APRON.r1), 'the apron\'s last row is outside the sky plan')
  assert.ok(inKeep(0, APRON.c0, APRON.r1) && !inKeep(0, ARRIVAL.c0, ARRIVAL.r0))
  assert.ok(inMask(7, 6, 6) && inMask(8, 25, 25) && !inMask(7, 5, 6) && !inMask(7, 26, 6) && !inMask(7, 6, 26))
  // deedOf and skyRoom: the sky floors' deeds are their homes'; only homes 3 and 6 have a sky room.
  assert.deepEqual([deedOf(7), deedOf(8)], [3, 6])
  assert.deepEqual([skyRoom(3), skyRoom(6)], [7, 8])
  for (const h of [0, 1, 2, 4, 5]) assert.equal(skyRoom(h), -1, `hall ${h} has no sky floor`)
  for (const room of [7, 8]) assert.equal(skyRoom(deedOf(room)), room)
  // Nothing past the ninth room, nor a room that is not a whole number.
  for (const bad of [9, -1, 0.5, Number.NaN]) {
    assert.equal(planOf(bad), null, `room ${bad}`)
    assert.ok(Number.isNaN(backEdge(bad)))
    assert.ok(!inMask(bad, 15, 15) && !inKeep(bad, 15, 23))
  }
  assert.equal(deedOf(9), -1)
})
