// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the seven homes (properties.ts) to what the player, the renderer and the physics
 * worker rely on, for 64 seeds: seven lots of their own, never a workplace's or a shop's, each where its rule puts it
 * with its doorway on the right street (the micro-loft by a platform of the elevated loop, the brownstone on the
 * heritage seam, three homes on the lakefront row, two at the foot of the headquarters towers, and a tested fallback
 * for a city with no towers); each lot's podium really replaced by the shop's shell, the fill block and the planters,
 * with every other box of the city left as it was and in its order, so the VTOL pads and the track network do not
 * move; the planter gaps wide enough for a person and too narrow for either car, proved with the real Rapier world
 * (a cast of each chassis is stopped at the planters, and the real avatar walks in from the sidewalk onto the apron);
 * the minimap's colours; the deeds' names fit to show; and the physics worker's check of a home's furniture solids
 * (each home's room frame as its lot gives it, a sound solid taken in every doorway direction, and every bad box
 * refused with its reason).
 * What breaks if it is removed? A seed could put a home on a shop's lot, leave a podium standing inside a home, let a
 * car into one, or shift a rooftop pad, and only a browser on that seed would show it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { forbiddenWordIn } from './assets/cc0.ts'
import { CITY, CITY_CENTER, HERITAGE_COLUMNS, STYLE, cityPlan, districtOfLot, generateBuildings, type Box, type Building } from './city.ts'
import { ROOM, doorDir, doorFront, insideRoom, toLocal, toWorld, workplaceLots } from './interiors.ts'
import { DEED_BASE, HOME, HOME_SOLID, PROPERTY_KINDS, checkHomeBoxes, cityHomes, drawHomes, homeAt, homeFrames, homesAt, hollowProperties, propertyLots, type Home, type HomeFrame } from './properties.ts'
import { shopLots } from './storefronts.ts'
import { APRON, CELL, DEPTH, GRID, GRID_HALF, HOME_PIECES, INSET, backEdge, cellCentre } from '../02_Define_The_Rules/homeGrid.ts'
import { screen } from '../02_Define_The_Rules/conduct.ts'
import { buildTrackNetwork, poseAt, trainLoops, vtolPads } from '../06_Make_Decisions/tracks.ts'
import { RIDE_HEIGHT, chassisBox } from '../07_Execute_Actions/car.ts'
import { Physics, RAPIER } from '../07_Execute_Actions/physics.ts'
import { Avatar } from '../07_Execute_Actions/player.ts'
import { PERSON } from '../07_Execute_Actions/simProtocol.ts'
import { itemById } from '../07_Execute_Actions/storeCatalog.ts'

const SEEDS = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1337 : (i * 2654435761 + 12345) >>> 0))
const P = CITY.pitch, h = CITY.lotHalf, lake = CITY.blocks - 2
const key = ({ k, m }: { k: number; m: number }) => `${k},${m}`
const isPodium = (k: number, m: number) => ({ box: [x0, y0, z0, x1, , z1] }: Building) => {
  const cx = (k + 0.5) * P, cz = (m + 0.5) * P
  return y0 === 0 && x0 === cx - h && x1 === cx + h && z0 === cz - h && z1 === cz + h
}
const dist = (k: number, m: number) => Math.hypot((k + 0.5) * P - CITY_CENTER, (m + 0.5) * P - CITY_CENTER)
/** A city box in a home's room frame. */
const local = (home: Home, [x0, y0, z0, x1, y1, z1]: Box) => {
  const a = toLocal(home, x0, z0), b = toLocal(home, x1, z1)
  return { u0: Math.min(a.u, b.u), u1: Math.max(a.u, b.u), v0: Math.min(a.v, b.v), v1: Math.max(a.v, b.v), y0, y1 }
}
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps

/**
 * The headquarters lots of a city's boxes, worked out here on their own (the design's probe): a downtown lot inside the
 * outer streets whose box stands exactly on its podium, centred, 8 to 11.5 m to each face and at least 70 m tall.
 */
function hqLots(b: readonly Building[]): { k: number; m: number; top: number }[] {
  const out: { k: number; m: number; top: number }[] = []
  for (let k = HERITAGE_COLUMNS; k < CITY.blocks; k++) for (let m = 0; m < lake; m++) {
    if (districtOfLot(k, m) !== 'downtown') continue
    const podium = b.find(isPodium(k, m))
    if (!podium) continue
    const cx = (k + 0.5) * P, cz = (m + 0.5) * P, p = podium.box[4]
    const t = b.find(({ box: [x0, y0, z0, x1, y1, z1] }) => y0 === p && Math.abs((x0 + x1) / 2 - cx) < 1e-9 && Math.abs((z0 + z1) / 2 - cz) < 1e-9 &&
      (x1 - x0) / 2 >= 8 - 1e-9 && (z1 - z0) / 2 >= 8 - 1e-9 && (x1 - x0) / 2 <= 11.5 + 1e-9 && (z1 - z0) / 2 <= 11.5 + 1e-9 && y1 - y0 >= 70)
    if (t) out.push({ k, m, top: t.box[4] })
  }
  return out
}

test('seven lots of their own for every seed, never a workplace\'s or a shop\'s, each where its rule puts it, its doorway on the right street', () => {
  const tally = new Map<string, number>()
  const bump = (what: string) => tally.set(what, (tally.get(what) ?? 0) + 1)
  for (const seed of SEEDS) {
    const at = `seed ${seed}`
    const plain = generateBuildings(seed, { homes: false })
    const lots = propertyLots(seed, plain)
    assert.deepEqual(lots.map((l) => l.home), [0, 1, 2, 3, 4, 5, 6], `${at}: one lot per property, in order`)
    assert.equal(new Set(lots.map(key)).size, 7, `${at}: seven lots`)
    const busy = new Set([...workplaceLots(seed), ...shopLots(seed)].map(key))
    for (const l of lots) {
      assert.ok(!busy.has(key(l)), `${at}: ${PROPERTY_KINDS[l.home]} on a workplace's or a shop's lot ${key(l)}`)
      assert.ok(plain.some(isPodium(l.k, l.m)), `${at}: ${PROPERTY_KINDS[l.home]} on a lot with no podium ${key(l)}`)
      assert.ok(districtOfLot(l.k, l.m) === 'downtown' || districtOfLot(l.k, l.m) === 'lakefront', `${at}: never a heritage or park lot`)
    }
    // The rules, worked out again from the seed's taken lots, in the picking order 0, 1, 2, 4, 5, 6, 3.
    const taken = new Set(busy)
    const free = (k: number, m: number) => !taken.has(`${k},${m}`) && plain.some(isPodium(k, m))
    const firstFree = (list: number[][]) => {
      const f = list.find(([k, m]) => free(k, m))!
      taken.add(`${f[0]},${f[1]}`)
      return f
    }
    const [loft, brown, pier, pent, villa, estate, mansion] = lots
    const wantLoft = firstFree([[8, 11, 0], [8, 12, 1], [11, 7, 2], [12, 7, 3], [7, 3, 0], [7, 4, 1], [4, 8, 3]])
    assert.deepEqual([loft.k, loft.m, loft.side], wantLoft, `${at}: the micro-loft`)
    assert.equal(brown.k, HERITAGE_COLUMNS, `${at}: the brownstone on the seam`)
    assert.ok(brown.m >= 1 && brown.m <= 5 && free(brown.k, brown.m), `${at}: the brownstone's row ${brown.m}`)
    assert.equal(brown.side, 3, `${at}: the brownstone faces the seam street`)
    taken.add(key(brown))
    assert.deepEqual([pier.k, pier.m, pier.side], [...firstFree([[7, lake], [8, lake]]), 0], `${at}: the timber loft by the pier`)
    assert.deepEqual([villa.k, villa.m, villa.side], [...firstFree([11, 10, 12, 9, 13].map((k) => [k, lake])), 0], `${at}: the villa`)
    assert.deepEqual([estate.k, estate.m, estate.side], [...firstFree([15, 14, 13, 12, 11, 10, 9].map((k) => [k, lake])), 0], `${at}: the estate`)
    const hq = hqLots(plain).filter((q) => free(q.k, q.m))
    assert.ok(hq.length >= 2, `${at}: ${hq.length} headquarters lots free for the two tower homes`)
    const tallest = [...hq].sort((a, b) => b.top - a.top || a.k - b.k || a.m - b.m)[0]
    assert.deepEqual([mansion.k, mansion.m], [tallest.k, tallest.m], `${at}: the sky-mansion on the tallest free tower`)
    const apart = hq.filter((q) => Math.max(Math.abs(q.k - mansion.k), Math.abs(q.m - mansion.m)) >= 2)
    const nearest = [...apart].sort((a, b) => dist(a.k, a.m) - dist(b.k, b.m) || a.k - b.k || a.m - b.m)[0]
    assert.ok(nearest, `${at}: a free tower two lots from the sky-mansion`)
    assert.deepEqual([pent.k, pent.m], [nearest.k, nearest.m], `${at}: the penthouse on the free tower nearest the centre, two lots from the sky-mansion`)
    for (const l of lots) assert.ok([0, 1, 2, 3].includes(l.side))
    assert.deepEqual(propertyLots(seed, generateBuildings(seed, { homes: false })), lots, `${at}: the seed alone decides`)
    bump(`loft ${key(loft)}`); bump(`pier ${key(pier)}`)
  }
  // The seed the design was drawn on.
  const l1337 = propertyLots(1337, generateBuildings(1337, { homes: false })).map((l) => [l.k, l.m, l.side])
  assert.deepEqual(l1337.map(([k, m]) => [k, m]), [[8, 11], [4, 3], [7, 14], [7, 9], [11, 14], [14, 14], [7, 7]])
  assert.deepEqual([l1337[0][2], l1337[1][2], l1337[2][2]], [0, 3, 0], 'the loft faces south onto the loop\'s street')
  assert.ok((tally.get('loft 8,11') ?? 0) > 50, 'the loft stands by the south platform in most seeds')
})

test('the micro-loft\'s lots flank the elevated loop\'s platforms, each doorway onto the street the platform stands over', () => {
  const train = trainLoops()[0]
  const platforms = train.stations.map((s) => poseAt(train, s))
  assert.equal(platforms.length, 4)
  const list: [number, number, 0 | 1 | 2 | 3][] = [[8, 11, 0], [8, 12, 1], [11, 7, 2], [12, 7, 3], [7, 3, 0], [7, 4, 1], [4, 8, 3]]
  for (const [k, m, side] of list) {
    const front = toWorld({ cx: (k + 0.5) * P, cz: (m + 0.5) * P, side }, P / 2, 0)
    assert.ok(platforms.some((p) => Math.hypot(p.x - front.x, p.z - front.z) < 1e-6), `lot ${k},${m}: its street in front of the doorway is a platform's`)
    assert.ok(districtOfLot(k, m) === 'downtown')
  }
  // Every platform has its lots, both sides of the street, but a heritage lot's.
  for (const p of platforms) {
    const flank = list.filter(([k, m, side]) => {
      const f = toWorld({ cx: (k + 0.5) * P, cz: (m + 0.5) * P, side }, P / 2, 0)
      return Math.hypot(p.x - f.x, p.z - f.z) < 1e-6
    })
    assert.equal(flank.length, p.x === 160 ? 1 : 2, `the platform at ${p.x}, ${p.z}`)
  }
})

test('with no headquarters tower free, the tower homes go on the free downtown lots nearest the centre, two lots apart', () => {
  for (const seed of SEEDS.slice(0, 8)) {
    const plain = generateBuildings(seed, { homes: false })
    const towers = new Set(hqLots(plain).map(key))
    // The synthetic city: every headquarters tower and its crown taken off its podium.
    const flat = plain.filter(({ box: [x0, y0, z0, x1, , z1] }) => {
      if (y0 === 0) return true
      const k = Math.floor((x0 + x1) / 2 / P), m = Math.floor((z0 + z1) / 2 / P)
      return !towers.has(`${k},${m}`)
    })
    assert.equal(hqLots(flat).length, 0)
    const lots = propertyLots(seed, flat)
    const taken = new Set([...workplaceLots(seed), ...shopLots(seed)].map(key))
    for (const l of [0, 1, 2, 4, 5].map((i) => lots[i])) taken.add(key(l))
    const inner: { k: number; m: number }[] = []
    for (let k = 5; k <= 14; k++) for (let m = 1; m <= 12; m++) if (!taken.has(`${k},${m}`)) inner.push({ k, m })
    inner.sort((a, b) => dist(a.k, a.m) - dist(b.k, b.m) || a.k - b.k || a.m - b.m)
    const mansion = lots[6], pent = lots[3]
    assert.deepEqual([mansion.k, mansion.m], [inner[0].k, inner[0].m], `seed ${seed}: the sky-mansion nearest the centre`)
    const apart = inner.filter((l) => Math.max(Math.abs(l.k - mansion.k), Math.abs(l.m - mansion.m)) >= 2)
    assert.deepEqual([pent.k, pent.m], [apart[0].k, apart[0].m], `seed ${seed}: the penthouse the next nearest, two lots away`)
    // The rest are the city's picks as they were: the towers only ever decide the two tower homes.
    const real = propertyLots(seed, plain)
    assert.deepEqual([0, 1, 2, 4, 5].map((i) => lots[i]), [0, 1, 2, 4, 5].map((i) => real[i]))
  }
})

test('the city\'s boxes: each home\'s podium replaced by the shop\'s glass, the slab in the podium\'s finish and height, the fixtures; every other box as it was, in its order', () => {
  for (const seed of SEEDS.slice(0, 16)) {
    const at = `seed ${seed}`
    const plain = generateBuildings(seed, { homes: false })
    const { buildings, homes } = cityPlan(seed)
    assert.equal(homes.length, 7)
    const own = new Set(homes.flatMap((x) => [...x.shell, ...x.fixtures]))
    for (const home of homes) {
      const podium = plain.find(isPodium(home.k, home.m))!
      assert.ok(podium, `${at}: home ${home.home} had a podium`)
      assert.equal(buildings.find(isPodium(home.k, home.m)), undefined, `${at}: the ${home.kind}'s podium still stands`)
      assert.equal(home.shell.length, 6)
      const glass = home.shell.filter(({ style, box }) => style === STYLE.glass && box[1] === 0 && box[4] === ROOM.height)
      assert.equal(glass.length, 5, `${at}: five glass walls, the doorway's in two`)
      const slab = home.shell[5]
      assert.deepEqual(slab.box, [home.cx - h, ROOM.height, home.cz - h, home.cx + h, podium.box[4], home.cz + h], `${at}: the slab up to the podium's top`)
      assert.equal(slab.style, podium.style, `${at}: the slab in the podium's finish`)
      for (const b of [...home.shell, ...home.fixtures]) assert.ok(buildings.includes(b), `${at}: every box of the ${home.kind} is in the city`)
      // Nothing of the old building below the ceiling reaches inside the walls.
      const inner = h - ROOM.wall
      for (const b of buildings) {
        const [x0, y0, z0, x1, , z1] = b.box
        if (y0 >= ROOM.height - 1e-6) continue
        if (x1 > home.cx - inner && x0 < home.cx + inner && z1 > home.cz - inner && z0 < home.cz + inner) assert.ok(own.has(b), `${at}: a box not the ${home.kind}'s stands inside it`)
      }
    }
    // Every other box byte for byte, in the same order: the towers over the homes too.
    const podiums = new Set(homes.map((x) => plain.find(isPodium(x.k, x.m))))
    assert.deepEqual(buildings.filter((b) => !own.has(b)), plain.filter((b) => !podiums.has(b)), `${at}: the rest of the city as it was`)
    assert.equal(buildings.length, plain.length + homes.reduce((n, x) => n + x.shell.length + x.fixtures.length - 1, 0))
  }
})

test('the fill block stands behind every home shallower than the grid, its face 5.2 cm behind the floor plan; the planters in the doorway band; no two boxes of a home overlap', () => {
  for (const seed of SEEDS.slice(0, 16)) {
    for (const home of cityHomes(seed)) {
      const at = `seed ${seed} ${home.kind}`
      assert.equal(home.depth, DEPTH[home.home])
      assert.ok(close(home.back, backEdge(home.home)))
      const fill = home.depth < GRID
      assert.equal(home.fixtures.length, fill ? 3 : 2, `${at}: the fill block exactly when the home is shallower than the grid`)
      if (fill) {
        const f = home.fixtures[0], l = local(home, f.box)
        assert.ok(close(l.u0, -12.5) && close(l.u1, backEdge(home.home) - INSET) && close(l.v0, -12.5) && close(l.v1, 12.5), `${at}: the fill block's extent`)
        assert.ok(l.y0 === 0 && l.y1 === ROOM.height, `${at}: from the floor to the slab`)
        assert.ok(close(l.u1, -12.5 + (GRID - home.depth) * CELL), `${at}: its face at the first row's back`)
        assert.equal(f.style, home.home === 1 ? STYLE.masonry : home.home === 2 ? STYLE.deck : STYLE.trim)
        // A whole number of rows from the doorway wall's inner face.
        assert.ok(close((12.448 - backEdge(home.home)) / CELL, home.depth, 1e-6))
      }
      const planters = home.fixtures.slice(-2).map((p) => ({ ...local(home, p.box), style: p.style }))
      for (const p of planters) {
        assert.equal(p.style, STYLE.concrete)
        assert.ok(close(p.u0, HOME.planter.u0) && close(p.u1, HOME.planter.u1) && p.y0 === 0 && p.y1 === HOME.planter.height, `${at}: a planter in the doorway band`)
        assert.ok(p.u0 > CITY.lotHalf - ROOM.wall && p.u1 < CITY.lotHalf, `${at}: touching neither face of the doorway wall`)
      }
      const [left, right] = [...planters].sort((a, b) => a.v0 - b.v0)
      assert.ok(close(left.v0, -0.9) && close(left.v1, -0.6) && close(right.v0, 0.6) && close(right.v1, 0.9))
      // No two boxes of the home overlap in volume; touching is allowed.
      const all = [...home.shell, ...home.fixtures].map((b) => b.box)
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j]
        const lap = [0, 1, 2].every((ax) => Math.min(a[ax + 3], b[ax + 3]) - Math.max(a[ax], b[ax]) > 1e-9)
        assert.ok(!lap, `${at}: boxes ${i} and ${j} overlap`)
      }
    }
  }
})

test('the planter gaps: wide enough for a person with skin to spare, too narrow for either car', () => {
  const [home] = homesAt([{ home: 0, k: 8, m: 11, side: 0 }])
  const planters = home.fixtures.slice(-2).map((p) => local(home, p.box)).sort((a, b) => a.v0 - b.v0)
  const gaps = [planters[0].v0 + ROOM.door, planters[1].v0 - planters[0].v1, ROOM.door - planters[1].v1]
  assert.ok(close(gaps[0], 1.1) && close(gaps[1], 1.2) && close(gaps[2], 1.1), gaps.join(', '))
  for (const g of gaps) {
    assert.ok(g >= 2 * (PERSON.radius + 0.02), `a ${g} m gap for a person`)
    for (const suv of [false, true]) assert.ok(g < 2 * chassisBox(suv).hz, `a ${g} m gap lets a car through`)
  }
})

test('real Rapier: either chassis driven straight at a doorway from the street is stopped by a planter, at any line through the opening', async () => {
  const homes = cityHomes(1337)
  for (const home of homes) {
    const boxes = [...home.shell, ...home.fixtures].map((b) => b.box)
    const bare = [...home.shell, ...home.fixtures.slice(0, -2)].map((b) => b.box)
    const physics = await Physics.create(boxes, { lamps: [], trees: [], signals: [] })
    const open = await Physics.create(bare, { lamps: [], trees: [], signals: [] })
    const d = doorDir(home.side)
    for (const suv of [false, true]) {
      const c = chassisBox(suv)
      const shape = d.x !== 0 ? new RAPIER.Cuboid(c.hx, c.hy, c.hz) : new RAPIER.Cuboid(c.hz, c.hy, c.hx)
      const u0 = 20
      // Every line through the opening that clears its jambs.
      for (const v of [-1.1, -0.8, -0.45, 0, 0.45, 0.8, 1.1]) {
        const p = toWorld(home, u0, v)
        const pos = { x: p.x, y: RIDE_HEIGHT + c.y, z: p.z }
        const vel = { x: -d.x, y: 0, z: -d.z }
        const rot = { x: 0, y: 0, z: 0, w: 1 }
        const hit = physics.world.castShape(pos, rot, vel, shape, 0, 30, true)
        assert.ok(hit, `${home.kind} suv=${suv} v=${v}: nothing stopped the car`)
        const want = u0 - c.hx - HOME.planter.u1
        assert.ok(Math.abs(hit.time_of_impact - want) < 0.02, `${home.kind} suv=${suv} v=${v}: stopped at ${hit.time_of_impact.toFixed(3)}, the planters at ${want.toFixed(3)}`)
        // Without the planters the same car would have gone through the doorway.
        const through = open.world.castShape(pos, rot, vel, shape, 0, 30, true)
        assert.ok(!through || through.time_of_impact > want + 1, `${home.kind} suv=${suv} v=${v}: the planters are what stop it`)
      }
    }
  }
})

test('real Rapier: the real avatar walks from the sidewalk through the centre gap onto the apron, in every home', async () => {
  for (const seed of SEEDS.slice(0, 4)) {
    const homes = cityHomes(seed)
    for (const home of homes) {
      const boxes: Box[] = [...home.shell, ...home.fixtures].map((b) => b.box)
      const physics = await Physics.create(boxes, { lamps: [], trees: [], signals: [] })
      const start = doorFront(home)
      const a = new Avatar(physics, start.x, start.z)
      const goal = toWorld(home, 11, 0)
      const dt = 1 / 60, speed = 1.4
      let there = false
      for (let t = 0; t < 20 && !there; t += dt) {
        const dx = goal.x - a.x, dz = goal.z - a.z, d = Math.hypot(dx, dz)
        if (d < 0.08) { there = true; break }
        physics.step(dt, (hh) => a.move((speed * dx) / d, (speed * dz) / d, hh))
      }
      assert.ok(there, `seed ${seed} ${home.kind}: the avatar did not reach the apron (stood at ${a.x.toFixed(2)}, ${a.z.toFixed(2)})`)
      const l = toLocal(home, a.x, a.z)
      const lo = cellCentre(APRON.c0, APRON.r0), hi = cellCentre(APRON.c1, APRON.r1)
      assert.ok(l.u > lo.u - CELL / 2 && l.u < hi.u + CELL / 2 && l.v > lo.v - CELL / 2 && l.v < hi.v + CELL / 2, `seed ${seed} ${home.kind}: on the apron`)
      assert.equal(homeAt(homes, a.x, a.z), home.home)
    }
  }
})

test('cityHomes is cityPlan\'s homes, remembered; generateBuildings is cityPlan\'s boxes', () => {
  for (const seed of [1337, 7, 42]) {
    const plan = cityPlan(seed)
    assert.deepEqual(cityHomes(seed), plan.homes)
    assert.equal(cityHomes(seed), cityHomes(seed), 'the same list for the same seed')
    assert.deepEqual(generateBuildings(seed), plan.buildings)
    assert.deepEqual(cityPlan(seed, { homes: false }).homes, [])
  }
  // hollowProperties on a fresh copy builds the same homes.
  const plain = generateBuildings(9, { homes: false })
  assert.deepEqual(hollowProperties(9, plain), cityPlan(9).homes)
  assert.deepEqual(plain, generateBuildings(9))
})

test('the VTOL pads and the whole track network are the same with the homes and without them', () => {
  for (const seed of SEEDS.slice(0, 16)) {
    const withHomes = generateBuildings(seed).map((b) => b.box)
    const without = generateBuildings(seed, { homes: false }).map((b) => b.box)
    assert.notDeepEqual(withHomes, without)
    const pads = vtolPads(withHomes)
    assert.ok(pads.length > 0, `seed ${seed}: some pads`)
    assert.deepEqual(pads, vtolPads(without), `seed ${seed}: the pads`)
    assert.deepEqual(buildTrackNetwork(seed, withHomes), buildTrackNetwork(seed, without), `seed ${seed}: the track network`)
  }
})

test('homeAt: inside on the apron and in the doorway band, outside on the sidewalk', () => {
  for (const seed of SEEDS.slice(0, 4)) {
    const homes = cityHomes(seed)
    for (const home of homes) {
      const apron = toWorld(home, 10.5, 1)
      assert.equal(homeAt(homes, apron.x, apron.z), home.home)
      const band = toWorld(home, CITY.lotHalf - 0.2, 0)
      assert.equal(homeAt(homes, band.x, band.z), home.home, 'the doorway band counts')
      assert.ok(insideRoom(home, home.door.x, home.door.z))
      const out = doorFront(home)
      assert.equal(homeAt(homes, out.x, out.z), -1, 'the sidewalk is in no home')
    }
    assert.equal(homeAt(homes, Number.NaN, 0), -1)
  }
})

test('drawHomes: gold for a home the player owns, violet for one on sale, lot, floor and doorway; the far ones not at all', () => {
  const homes = cityHomes(7)
  const fills: { style: string; rect: number[] }[] = []
  const ctx = { fillStyle: '' as string | object, fillRect(x: number, y: number, w: number, h: number) { fills.push({ style: String(this.fillStyle), rect: [x, y, w, h] }) } }
  const [a, b] = homes
  drawHomes(ctx, homes, a.cx, a.cz, false, 1 << a.home, 1)
  assert.equal(fills.length, 3, 'the one home under the point: lot, floor, doorway')
  assert.equal(fills[0].style, '#f59e0b', 'owned: gold')
  fills.length = 0
  drawHomes(ctx, homes, b.cx, b.cz, true, 1 << a.home, 1)
  assert.equal(fills[0].style, '#5b21b6', 'on sale, dark: violet')
  fills.length = 0
  drawHomes(ctx, homes, b.cx, b.cz, false, 0, 1)
  assert.equal(fills[0].style, '#8b5cf6', 'on sale: violet')
  fills.length = 0
  drawHomes(ctx, homes, a.cx, a.cz, true, 0b1111111, 1e6)
  assert.equal(fills.length, 3 * homes.length)
  assert.equal(fills[0].style, '#b45309', 'owned, dark: gold')
})

test('homesAt: the property index decides the depth in any map, and an unknown property is refused', () => {
  const lots = PROPERTY_KINDS.map((_, home) => ({ home, k: 5 + home, m: 3, side: (home % 4) as 0 | 1 | 2 | 3 }))
  const homes = homesAt(lots, () => ({ top: 2, style: STYLE.condo }))
  for (const x of homes) {
    assert.equal(x.kind, PROPERTY_KINDS[x.home])
    assert.equal(x.shell[5].style, STYLE.condo)
    assert.ok(x.shell[5].box[4] >= ROOM.height + 0.3 - 1e-9, 'the slab never below the room')
  }
  assert.throws(() => homesAt([{ home: 7, k: 5, m: 3, side: 0 }]), /no property 7/)
  assert.throws(() => homesAt([{ home: 1.5, k: 5, m: 3, side: 0 }]), /no property/)
})

test('homeFrames: each home\'s room frame as its lot gives it, by property index, the same for a lot and its home; null where a map has none', () => {
  for (const seed of SEEDS.slice(0, 4)) {
    const homes = cityHomes(seed)
    const frames = homeFrames(homes)
    assert.equal(frames.length, PROPERTY_KINDS.length)
    for (const x of homes) {
      assert.deepEqual(frames[x.home], { home: x.home, cx: x.cx, cz: x.cz, side: x.side, back: x.back }, `seed ${seed}: home ${x.home}`)
      assert.ok(Object.isFrozen(frames[x.home]))
    }
    assert.deepEqual(homeFrames(homes.map(({ home, k, m, side }) => ({ home, k, m, side }))), frames, 'a lot gives its home\'s frame')
  }
  // A region with three of the seven: the others are null.
  const some = homeFrames([{ home: 6, k: 52, m: 53, side: 2 }, { home: 0, k: 55, m: 52, side: 1 }, { home: 3, k: 60, m: 61, side: 3 }])
  assert.deepEqual(some.map((f) => f?.home ?? null), [0, null, null, 3, null, null, 6])
  assert.deepEqual(some[6], { home: 6, cx: 52.5 * P, cz: 53.5 * P, side: 2, back: backEdge(6) })
  assert.deepEqual(homeFrames([]), [null, null, null, null, null, null, null])
  assert.throws(() => homeFrames([{ home: 7, k: 5, m: 3, side: 0 }]), /no property 7/)
  assert.throws(() => homeFrames([{ home: -1, k: 5, m: 3, side: 0 }]), /no property -1/)
  assert.throws(() => homeFrames([{ home: 2.5, k: 5, m: 3, side: 0 }]), /no property 2\.5/)
  assert.throws(() => homeFrames([{ home: 2, k: 5, m: 3, side: 0 }, { home: 2, k: 6, m: 3, side: 0 }]), /property 2 listed twice/)
})

/** A room-frame box (u, v, y ranges) as the page sends it: six city numbers, through toWorld. */
const sent = (f: HomeFrame, u0: number, v0: number, u1: number, v1: number, y0: number, y1: number): number[] => {
  const a = toWorld(f, u0, v0), b = toWorld(f, u1, v1)
  return [Math.min(a.x, b.x), y0, Math.min(a.z, b.z), Math.max(a.x, b.x), y1, Math.max(a.z, b.z)]
}
/** The edge of cell index n along u or v (the grid's lines), m. */
const line = (n: number) => -GRID_HALF + n * CELL

test('checkHomeBoxes takes real solids from inside a home, in every doorway direction: against the back, against a side wall, beside the apron, at the doorway edge', () => {
  for (const side of [0, 1, 2, 3] as const) {
    for (const home of [0, 3, 6]) {
      const [f] = homeFrames(homesAt([{ home, k: 6, m: 5, side }])).filter((x) => x !== null)
      const first = GRID - DEPTH[home]
      // A sofa (4 x 2 cells, its solid the first 1.6 cells from its back, 0.85 m) against the back, a bookcase
      // (3 x 1, its solid 0.55 cells deep, 2.4 m) against the +v wall, a desk beside the apron and a console at the
      // doorway's edge of the floor plan on the -v side, each inset 1 cm as the page draws them.
      const flat = [
        ...sent(f, line(first) + 0.01, line(2) + 0.01, line(first + 1.6) - 0.01, line(6) - 0.01, 0, 0.85),
        ...sent(f, line(first + 2) + 0.01, line(32 - 0.55) + 0.01, line(first + 5) - 0.01, line(32) - 0.01, 0, 2.4),
        ...sent(f, line(APRON.r0) + 0.01, line(APRON.c1 + 1) + 0.01, line(32) - 0.01, line(APRON.c1 + 3) - 0.01, 0, 0.76),
        ...sent(f, line(30) + 0.01, line(0) + 0.01, line(32) - 0.01, line(3) - 0.01, 0, 1.95),
        // The tallest a piece stands (a bookcase's carcass would reach 4.1 m; its solid stops at 2.4 m, this does not).
        ...sent(f, line(first) + 0.01, line(10) + 0.01, line(first + 1) - 0.01, line(13) - 0.01, 0, 4.1),
      ]
      const at = `side ${side}, home ${home}`
      const boxes = checkHomeBoxes(f, flat)
      assert.equal(boxes.length, 5, at)
      assert.deepEqual(boxes.flat(), flat, `${at}: the boxes come back as sent, city boxes`)
      for (const [x0, , z0, x1, , z1] of boxes) assert.ok(x1 > x0 && z1 > z0, at)
    }
  }
  // The city's homes, each one's real frame: a solid against its back edge.
  for (const x of cityHomes(1337)) {
    const [f] = homeFrames([x]).filter((y) => y !== null)
    assert.equal(checkHomeBoxes(f, sent(f, x.back + 0.01, -1, x.back + 1, 1, 0, 0.85)).length, 1, `home ${x.home}`)
  }
  // No boxes: a home with nothing solid.
  const [f] = homeFrames(homesAt([{ home: 5, k: 6, m: 5, side: 0 }])).filter((x) => x !== null)
  assert.deepEqual(checkHomeBoxes(f, []), [])
  // HOME_PIECES boxes, the most a home holds.
  assert.equal(checkHomeBoxes(f, Array.from({ length: HOME_PIECES }, (_, i) => sent(f, line(i) + 0.01, -1, line(i + 1) - 0.01, 1, 0, 1)).flat()).length, HOME_PIECES)
})

test('checkHomeBoxes refuses each bad box with its reason, in every doorway direction', () => {
  const { slack, ceiling, height, thin } = HOME_SOLID
  assert.deepEqual({ slack, ceiling, height, thin, floor: HOME_SOLID.floor }, { slack: 0.01, ceiling: 4.15, height: 0.4, thin: 0.05, floor: -0.01 })
  for (const side of [0, 1, 2, 3] as const) {
    const [f] = homeFrames(homesAt([{ home: 1, k: 9, m: 3, side }])).filter((x) => x !== null)
    const back = backEdge(1)
    const good = sent(f, back + 1, -1, back + 3, 1, 0, 0.85)
    const at = `side ${side}`
    assert.equal(checkHomeBoxes(f, good).length, 1, at)
    const refused = (flat: unknown, reason: RegExp, why: string) => assert.throws(() => checkHomeBoxes(f, flat), reason, `${at}: ${why}`)
    refused('0,0,0,1,1,1', /^Error: home: boxes must be a list of numbers$/, 'a string')
    refused({ length: 6, 0: 1 }, /boxes must be a list of numbers/, 'not an array')
    refused(null, /boxes must be a list of numbers/, 'nothing')
    refused(new Float64Array(good), /boxes must be a list of numbers/, 'a typed array is not a plain list')
    refused(good.slice(0, 5), /boxes come in sixes/, 'five numbers')
    refused([...good, 1], /boxes come in sixes/, 'seven numbers')
    refused(Array.from({ length: HOME_PIECES + 1 }, () => good).flat(), /at most 16 boxes/, 'seventeen boxes')
    for (const bad of [Number.NaN, Infinity, -Infinity, '1', null, undefined]) {
      const flat: unknown[] = [...good]
      flat[3] = bad
      refused(flat, /every number of a box must be finite/, `a ${String(bad)}`)
    }
    const hole: unknown[] = new Array(6)
    good.forEach((n, i) => { if (i !== 3) hole[i] = n })
    refused(hole, /every number of a box must be finite/, 'a hole')
    const [x0, y0, z0, x1, y1, z1] = good
    refused([x0, y0, z0, x0 + thin - 0.001, y1, z1], /at least 0\.05 m across/, 'too thin along x')
    refused([x0, y0, z0, x1, y1, z0 + thin - 0.001], /at least 0\.05 m across/, 'too thin along z')
    refused([x1, y0, z0, x0, y1, z1], /at least 0\.05 m across/, 'turned inside out')
    refused([x0, -0.011, z0, x1, y1, z1], /must start on the floor/, 'under the floor')
    refused([x0, y0, z0, x1, ceiling + 0.001, z1], /must stay under 4\.15 m/, 'into the ceiling')
    refused([x0, 0.2, z0, x1, 0.2 + height - 0.001, z1], /at least 0\.4 m tall/, 'low enough to step onto')
    refused([x0, 1, z0, x1, 1.2, z1], /at least 0\.4 m tall/, 'a shelf in the air, too thin')
    assert.equal(checkHomeBoxes(f, [x0, -0.009, z0, x1, ceiling, z1]).length, 1, `${at}: a centimetre's slack at the floor, the ceiling's limit itself`)
    // Outside the floor plan: behind the back edge, past the doorway edge, past either side.
    refused(sent(f, back - slack - 0.005, -1, back + 1, 1, 0, 1), /inside the home's floor plan/, 'behind the back edge')
    refused(sent(f, -12, -1, -11, 1, 0, 1), /inside the home's floor plan/, 'in the fill block')
    refused(sent(f, 11, 4, GRID_HALF + slack + 0.005, 5, 0, 1), /inside the home's floor plan/, 'past the doorway edge')
    refused(sent(f, 0, GRID_HALF - 1, 1, GRID_HALF + slack + 0.005, 0, 1), /inside the home's floor plan/, 'past the +v side')
    refused(sent(f, 0, -GRID_HALF - slack - 0.005, 1, -GRID_HALF + 1, 0, 1), /inside the home's floor plan/, 'past the -v side')
    refused(sent(f, 20, -1, 21, 1, 0, 1), /inside the home's floor plan/, 'out in the street')
    assert.equal(checkHomeBoxes(f, sent(f, back - slack + 0.001, -GRID_HALF - slack + 0.001, back + 1, -GRID_HALF + 1, 0, 1)).length, 1, `${at}: a centimetre's slack behind and beside`)
    // On the apron: from behind it, from either side of it, wholly in it; touching it is not on it.
    const a = { u0: line(APRON.r0), v0: line(APRON.c0), v1: line(APRON.c1 + 1) }
    refused(sent(f, a.u0 - 1, -0.5, a.u0 + 0.01, 0.5, 0, 1), /keep off the apron/, 'into the apron from behind')
    refused(sent(f, a.u0 + 1, a.v1 - 0.01, a.u0 + 2, a.v1 + 1, 0, 1), /keep off the apron/, 'into the apron from the +v side')
    refused(sent(f, a.u0 + 1, a.v0 - 1, a.u0 + 2, a.v0 + 0.01, 0, 1), /keep off the apron/, 'into the apron from the -v side')
    refused(sent(f, a.u0 + 1, -0.5, a.u0 + 2, 0.5, 0, 1), /keep off the apron/, 'on the apron')
    refused(sent(f, 12, -0.5, GRID_HALF, 0.5, 0, 1), /keep off the apron/, 'in the doorway')
    assert.equal(checkHomeBoxes(f, [...sent(f, a.u0 - 1, -0.5, a.u0, 0.5, 0, 1), ...sent(f, a.u0, a.v1, GRID_HALF, a.v1 + 1, 0, 1)]).length, 2, `${at}: touching the apron`)
    // One bad box refuses the whole set.
    refused([...good, ...sent(f, a.u0 + 1, -0.5, a.u0 + 2, 0.5, 0, 1)], /keep off the apron/, 'a good box and a bad one')
  }
})

/** Words that name a weapon or a fight, as conduct.test.ts's unarmed() reads them. */
const ARMED = /\b(?:guns?|gunfire|firearms?|rifles?|pistols?|handguns?|shotguns?|revolvers?|weapons?|weaponry|holsters?|ammo|ammunition|bullets?|knife|knives|blades?|swords?|katanas?|machetes?|daggers?|grenades?|bombs?|explosives?|muzzles?|snipers?|shoot(?:s|ing|ers?)?|shots?|melee|combat|armed|arsenal|turrets?|missiles?|rockets?|punch(?:es|ing|ed)?|fights?|fighting|attacks?|attacking)\b/i
const REAL_PLACES = /\b(?:Toronto|Ontario|Mississauga|Brampton|Scarborough|Etobicoke|Markham|Oakville|Burlington|Oshawa|Pickering|Vaughan|Richmond Hill|Hamilton|Niagara|Cambridge|Galt|Hespeler|Harbourfront|Queens? Quay|Yonge|Gardiner|Don Valley|Humber|CN Tower|Rogers Centre|Scotiabank)\b/

test('the seven deeds\' names, as the page reads them from the catalogue, pass the conduct screen, are unarmed and name no real place', () => {
  for (let home = 0; home < PROPERTY_KINDS.length; home++) {
    const deed = itemById(DEED_BASE + home)
    assert.ok(deed, `deed ${DEED_BASE + home}`)
    assert.equal(deed.kind, 'deed')
    const name = deed.name
    assert.equal(screen(name).admissible, true, name)
    assert.equal(name.match(ARMED), null, name)
    assert.equal(forbiddenWordIn(name), null, name)
    assert.equal(name.match(REAL_PLACES), null, name)
    assert.doesNotMatch(name, /matri/i)
  }
  assert.equal(itemById(DEED_BASE + PROPERTY_KINDS.length)?.kind === 'deed', false, 'seven deeds, no eighth')
})
