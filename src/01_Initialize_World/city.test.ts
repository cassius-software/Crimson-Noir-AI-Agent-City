// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the city the districts generate: the district map by lot; every box inside its lot
 * at head height (so streets and sidewalks stay clear for cars and people) but the shoreline's; every built lot solid
 * at eye height (the crowd and the car-exit rule treat lots as solid) and the parks open; the heritage quarter's two-
 * to four-storey rows, its one church and one mill; the lakefront's mid-rise; the seawall along the whole world,
 * open only for the pier, whose deck is walkable; furniture clear of the pier and of the pavilions; the crowd's grid
 * ending short of the water; and all of it the same for the same seed.
 * What breaks if it is removed? A generator change could put a wall on a sidewalk, a car into the lake, a pedestrian's
 * route through a park, or a spire where the kernel's physics expects open street, unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CITY, CITY_CENTER, CITY_SIZE, HERITAGE_COLUMNS, LAKE, STYLE, cityWgsl, districtName, districtOfLot, generateBuildings, generateCity,
  streetFurniture, type Box, type Building,
} from './city.ts'
import { ROOM, workplaceLots } from './interiors.ts'

const SEEDS = [1337, 7, 42, 90210]
const lotOf = (x: number, z: number) => [Math.floor(x / CITY.pitch), Math.floor(z / CITY.pitch)] as const
const centreOf = (k: number, m: number) => [(k + 0.5) * CITY.pitch, (m + 0.5) * CITY.pitch] as const
/** Boxes whose footprint lies in lot (k, m) (by their centre). */
const inLotBoxes = (list: Building[], k: number, m: number) =>
  list.filter(({ box: [x0, , z0, x1, , z1] }) => {
    const [a, b] = lotOf((x0 + x1) / 2, (z0 + z1) / 2)
    return a === k && b === m
  })
const isShoreline = ([, , z0]: Box) => z0 >= LAKE.shore - 1e-9

test('the grid: 16 blocks of 40 m, 640 m across; the GPU crowd reads the same numbers', () => {
  assert.equal(CITY.blocks, 16)
  assert.equal(CITY_SIZE, 640)
  assert.equal(CITY_CENTER, 320)
  const w = cityWgsl()
  assert.match(w, /const CITY_BLOCKS: i32 = 16;/)
  assert.match(w, /const CITY_SIZE: f32 = 640\.0;/)
})

test('districts by lot: the heritage west, the lakefront row, the parks, the shore ring, downtown everywhere else', () => {
  for (let k = -1; k <= CITY.blocks; k++) {
    assert.equal(districtOfLot(k, CITY.blocks), 'shore')
    assert.equal(districtOfLot(k, CITY.blocks - 1), 'park')
    assert.equal(districtOfLot(k, CITY.blocks - 2), 'lakefront')
    for (let m = -1; m < CITY.blocks - 2; m++) assert.equal(districtOfLot(k, m), k < HERITAGE_COLUMNS ? 'heritage' : 'downtown', `${k},${m}`)
  }
  assert.equal(districtName(CITY_CENTER + 5, CITY_CENTER + 5), 'Financial District')
  assert.equal(districtName(60, 100), 'Heritage Quarter')
  assert.equal(districtName(300, CITY_SIZE - 20), 'Lakefront', 'the park row')
  assert.equal(districtName(300, CITY_SIZE - 60), 'Lakefront', 'the condominium row')
  assert.equal(districtName(LAKE.pier.x, LAKE.shore + 30), 'Lakefront', 'on the pier')
  assert.equal(districtName(CITY_SIZE - 20, CITY_CENTER), 'Market Quarter')
  assert.equal(districtName(CITY_CENTER, 40), 'Midtown')
  assert.equal(districtName(Number.NaN, 0), 'Downtown')
  // Generic names only: no real neighbourhood is named.
  for (const [x, z] of [[60, 100], [300, 620], [320, 320], [600, 320], [320, 40], [220, 320], [320, 500]]) {
    assert.doesNotMatch(districtName(x, z), /Cambridge|Burlington|Galt|Toronto|Harbourfront/)
  }
})

test('the same seed gives the same city (and furniture); another seed another', () => {
  assert.deepEqual(generateBuildings(1337), generateBuildings(1337))
  assert.deepEqual(streetFurniture(1337), streetFurniture(1337))
  assert.notDeepEqual(generateCity(1337), generateCity(7))
  assert.deepEqual(generateCity(1337), generateBuildings(1337).map((b) => b.box), 'the physics worker\'s boxes are the drawn ones')
})

test('streets and sidewalks stay clear: below head height every box is inside its lot, but the shoreline\'s', () => {
  for (const seed of SEEDS) {
    for (const { box } of generateBuildings(seed)) {
      const [x0, y0, z0, x1, y1, z1] = box
      assert.ok(x1 > x0 && y1 > y0 && z1 > z0, `${seed}: an empty box ${box}`)
      assert.ok([...box].every(Number.isFinite))
      if (isShoreline(box)) continue
      const [k, m] = lotOf((x0 + x1) / 2, (z0 + z1) / 2)
      const [cx, cz] = centreOf(k, m)
      // A cornice may overhang its lot by 0.3 m, but only up where no one walks or drives.
      const over = y0 >= 6 ? 0.31 : 1e-9
      const h = CITY.lotHalf + over
      assert.ok(x0 >= cx - h && x1 <= cx + h && z0 >= cz - h && z1 <= cz + h, `${seed}: ${box} leaves lot ${k},${m} at y ${y0}`)
    }
  }
})

test('every built lot is solid at eye height; the parks are open ground (a pavilion at most)', () => {
  for (const seed of SEEDS) {
    const list = generateBuildings(seed)
    for (let k = -1; k <= CITY.blocks; k++) {
      for (let m = -1; m < CITY.blocks; m++) {
        const [cx, cz] = centreOf(k, m)
        const mine = inLotBoxes(list, k, m)
        const h = CITY.lotHalf
        const covers = mine.some(({ box: [x0, y0, z0, x1, y1, z1] }) => y0 === 0 && y1 >= 1.2 && x0 <= cx - h && x1 >= cx + h && z0 <= cz - h && z1 >= cz + h)
        if (districtOfLot(k, m) === 'park') {
          assert.ok(!covers, `${seed}: park ${k},${m} is built over`)
          assert.ok(mine.length <= 1 && mine.every(({ box, style }) => box[4] <= 4 && style === STYLE.concrete), `${seed}: park ${k},${m}: ${JSON.stringify(mine)}`)
        } else if (workplaceLots(seed).some((w) => w.k === k && w.m === m)) {
          // A workplace lot (interiors.ts): a room behind glass walls under the podium, open at its doorway alone.
          assert.ok(!covers, `${seed}: workplace ${k},${m} is solid`)
          const glass = mine.filter(({ style }) => style === STYLE.glass)
          assert.equal(glass.length, 5, `${seed}: workplace ${k},${m} has four glass walls, the doorway's in two`)
          assert.ok(glass.every(({ box }) => box[1] === 0 && box[4] === ROOM.height))
          assert.ok(mine.some(({ box }) => box[1] === ROOM.height && box[0] === cx - h && box[3] === cx + h && box[2] === cz - h && box[5] === cz + h), `${seed}: the ceiling slab carries the podium`)
        } else {
          assert.ok(covers, `${seed}: lot ${k},${m} (${districtOfLot(k, m)}) is open at eye height`)
        }
      }
    }
  }
})

test('the heritage quarter: two to four storeys of stone and brick with cornices, one church with its spire, one mill with its chimney', () => {
  for (const seed of SEEDS) {
    const list = generateBuildings(seed)
    const heritage = list.filter(({ box: [x0, , z0, x1, , z1] }) => {
      const [k, m] = lotOf((x0 + x1) / 2, (z0 + z1) / 2)
      return districtOfLot(k, m) === 'heritage'
    })
    assert.ok(heritage.length > 200)
    const allowed = new Set<number>([STYLE.stone, STYLE.brick, STYLE.trim, STYLE.roof, STYLE.masonry])
    assert.ok(heritage.every(({ style }) => allowed.has(style)), 'no curtain wall or condominium in the heritage quarter')
    // Spire: its finial is the one box topping out above 44 m; chimney: the one plain-masonry box above 30 m.
    const spires = heritage.filter(({ box, style }) => style === STYLE.roof && box[4] > 44)
    const chimneys = heritage.filter(({ box, style }) => style === STYLE.masonry && box[4] >= 30)
    assert.equal(spires.length, 1, `${seed}: one spire`)
    assert.equal(chimneys.length, 1, `${seed}: one chimney`)
    // A row is a stone or brick box from the ground with its cornice (0.5 m of trim overhanging it by 0.3 m) on top.
    const trims = heritage.filter(({ style, box }) => style === STYLE.trim && Math.abs(box[4] - box[1] - 0.5) < 1e-9)
    const rows = heritage.filter(({ style, box }) => (style === STYLE.stone || style === STYLE.brick) && box[1] === 0 &&
      trims.some(({ box: t }) => Math.abs(t[1] - box[4]) < 1e-9 && Math.abs(t[0] + 0.3 - box[0]) < 1e-9 && Math.abs(t[3] - 0.3 - box[3]) < 1e-9))
    assert.ok(rows.length > 100, `${seed}: ${rows.length} rows`)
    const odd = rows.filter(({ box }) => ![2, 3, 4].some((n) => Math.abs((box[4] - 1) / 3.6 - n) < 1e-9))
    assert.equal(odd.length, 1, `${seed}: every row two to four storeys but the mill (${JSON.stringify(odd.map((b) => b.box))})`)
    assert.equal(odd[0].box[4], 18.4, 'the mill: five storeys of brick')
    // Above 30 m stand only the spire's steps and the chimney with its cap: within 3 m of their axes.
    const axis = (b: Building) => [(b.box[0] + b.box[3]) / 2, (b.box[2] + b.box[5]) / 2]
    const [sx, sz] = axis(spires[0]), [hx, hz] = axis(chimneys[0])
    for (const b of heritage.filter((x) => x.box[4] > 30)) {
      const [x, z] = axis(b)
      assert.ok(Math.hypot(x - sx, z - sz) < 3 || Math.hypot(x - hx, z - hz) < 3, `${seed}: a heritage box of ${b.box[4]} m away from the spire and the chimney`)
    }
  }
})

test('the lakefront row: condominiums of about 20 to 50 m over shops; the park row: trees round open ground', () => {
  for (const seed of SEEDS) {
    const list = generateBuildings(seed)
    for (let k = -1; k <= CITY.blocks; k++) {
      const mine = inLotBoxes(list, k, CITY.blocks - 2)
      assert.ok(mine.every(({ style }) => style === STYLE.condo || style === STYLE.trim))
      const slab = Math.max(...mine.filter(({ style }) => style === STYLE.condo).map((b) => b.box[4]))
      assert.ok(slab >= 19 && slab <= 51, `${seed}: lot ${k}: ${slab} m`)
    }
  }
  const f = streetFurniture(1337)
  for (let k = -1; k <= CITY.blocks; k++) {
    const [cx, cz] = centreOf(k, CITY.blocks - 1)
    const trees = f.trees.filter(([x, z]) => Math.max(Math.abs(x - cx), Math.abs(z - cz)) < CITY.lotHalf)
    assert.equal(trees.length, 6, `park ${k}`)
    for (const [x, z] of trees) assert.ok(Math.hypot(x - cx, z - cz) >= 7.5, 'clear of a pavilion')
  }
})

test('the shore: a seawall along the whole world, open only for the pier; the pier\'s deck walkable, railed on three sides', () => {
  const all = generateBuildings(1337)
  const list = all.filter(({ box }) => isShoreline(box))
  const { shore, wall, pier } = LAKE
  const walls = list.filter(({ style }) => style === STYLE.concrete)
  assert.equal(walls.length, 2)
  const [w0, w1] = walls.map((b) => b.box).sort((a, b) => a[0] - b[0])
  assert.equal(w0[0], CITY_CENTER - wall.halfLength)
  assert.equal(w1[3], CITY_CENTER + wall.halfLength)
  assert.equal(w0[3], pier.x - pier.halfWidth)
  assert.equal(w1[0], pier.x + pier.halfWidth)
  for (const w of [w0, w1]) {
    assert.equal(w[4] - w[1], wall.height)
    assert.equal(w[2], shore)
    assert.equal(w[5], shore + wall.thickness)
  }
  const deck = list.find(({ style }) => style === STYLE.deck)!.box
  assert.deepEqual(deck, [pier.x - pier.halfWidth, 0, shore, pier.x + pier.halfWidth, pier.deck, shore + pier.length])
  assert.ok(pier.deck <= 0.35, 'the character controller steps up 0.35 m: the deck is walkable')
  const rails = list.filter(({ style }) => style === STYLE.rail).map((b) => b.box)
  assert.equal(rails.length, 3)
  for (const r of rails) assert.ok(r[1] === pier.deck && Math.abs(r[4] - r[1] - pier.rail) < 1e-9, JSON.stringify(r))
  assert.ok(LAKE.water > 0 && LAKE.water < pier.deck, 'the water sits above the ground and below the deck')
  // Nothing else stands in the lake.
  assert.ok(all.every((b) => b.box[2] < shore + wall.thickness || list.includes(b)))
})

test('the promenade\'s trees and lamps keep clear of the pier; the crowd\'s grid ends short of the water', () => {
  const f = streetFurniture(1337)
  const { pier, shore } = LAKE
  const onPromenade = (z: number) => z > CITY_SIZE + CITY.roadHalf && z < shore
  for (const [x, z] of [...f.trees, ...f.lamps]) {
    if (onPromenade(z)) assert.ok(Math.abs(x - pier.x) >= pier.halfWidth + 2, `furniture at ${x} blocks the pier`)
  }
  assert.ok(f.trees.some(([, z]) => onPromenade(z)) && f.lamps.some(([, z]) => onPromenade(z)))
  // crowd.wgsl clampCity keeps pedestrians within 6.5 m of the grid: the seawall is 26 m out.
  assert.ok(CITY_SIZE + 6.5 < shore)
})
