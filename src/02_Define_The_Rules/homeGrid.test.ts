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
import { APRON, CELL, DEPTH, GRID, GRID_HALF, HOME_PIECES, INSET, backEdge, cellCentre, inApron, inMask } from './homeGrid.ts'

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
  assert.ok(!inMask(7, 0, GRID - 1), 'there is no eighth home')
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
