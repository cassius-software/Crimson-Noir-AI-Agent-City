// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The street window (streets.ts) is what gives the lakefront metropolis its people and its
 * traffic, and it has to agree with three other things: the generated map (every segment the window holds is a street
 * the map built, with the kind the map gave it), the crowd shader (the bit field is laid out as crowd.wgsl segBits
 * reads it, and the procedural city packs as every bit set), and the track network (the window's rings over the city
 * itself are the city's own 64 rings, piece for piece, and over the metropolis they are disjoint rectangles whose every
 * side is a car street, so no (segment, direction) belongs to two rings). It also checks what the engine relies on:
 * the window is on the pitch, holds the start, and seats the whole fleet; the furniture stands only along streets;
 * a surveyed pack off the grid gives no window; and the shore wall is cut where a bridge crosses it. And it holds the
 * whole map's grid (mapStreetGrid) to the map, street for street, and the window to being a crop of it: streetGridOf,
 * now the map's grid cut by windowOrigin and windowOf, gives exactly the window its old body gave (kept here as the
 * oracle), for every seed, quarter and start.
 * What breaks if it is removed? A pedestrian could be routed down a street the map never built, a ring could run over
 * a ravine, or the fleet could ask for more seats than the window has, and only a browser session would show it.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { CITY } from '../city.ts'
import { ZONE, generateLakefront, type Zone } from '../lakefront.ts'
import { buildLakefrontPack, packOf, zoneCentre } from '../lakefrontPack.ts'
import { MACRO, STREET } from '../macroCity.ts'
import { carLoops, capacity, type Track } from '../../06_Make_Decisions/tracks.ts'
import { TRAFFIC } from '../../02_Define_The_Rules/civic.ts'
import { REGION_FORMAT, ROAD_CLASS, polygonAt, polygonCount, polygons, roadAt, validatePack, type RegionPack } from './pack.ts'
import {
  SEG, STREET_SEGMENTS, STREET_VEC4S, STREET_WORDS, WINDOW_BLOCKS, WINDOW_GEOMETRY, cityStreetGrid, hSeg, mapStreetGrid, packStreets, ringRectangles, spawnSegment,
  streetCapacity, streetCounts, streetGridOf, streetLoops, streetNetwork, vSeg, windowFurniture, windowOf, windowOrigin, type StreetGrid,
} from './streets.ts'

// Vite's `?raw` import, for Node (crowdCompute.test.ts's hook): regionWorld.ts takes the rain-mode WGSL that way.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { LANE_WIDTH, REGION_CORNER, RegionPlaces, SHORE_WALL, SIDEWALK, layoutOf, regionPhysics } = await import('./regionWorld.ts')

const P = CITY.pitch
const B = WINDOW_BLOCKS
const SEED = 1337
const ZONES = (Object.entries(ZONE) as [string, Zone][]).filter(([name]) => name !== 'lake')

/** The metropolis's window for a zone, with what it was built from. */
function windowFor(zone: Zone, seed = SEED) {
  const map = generateLakefront(seed, 64)
  const pack = packOf(map, zone)
  const layout = layoutOf(pack)
  const places = new RegionPlaces(pack, layout)
  const start = places.spawn({ x: layout.offset.x, z: layout.offset.z })
  const grid = streetGridOf(pack, layout.offset, start)
  assert.ok(grid, 'the metropolis has a window')
  return { map, pack, layout, start, grid }
}

/** A ring's pieces as plain numbers (what the cars follow), for an equality that ignores identity. */
const shape = (t: Track) => ({ length: t.length, pieces: t.pieces.map((p) => (p.kind === 'line' ? [p.s0, p.x0, p.z0, p.dx, p.dz, p.length] : p.kind === 'corner' ? [p.s0, ...p.e, ...p.c, ...p.x] : [p.s0, p.cx])), stops: t.stops.map((s) => [s.s, s.axis]) })

test('the window is the crowd shader\'s grid: CITY.blocks across, two bits per segment, in whole vec4u rows', () => {
  assert.equal(B, CITY.blocks)
  assert.equal(STREET_SEGMENTS, 2 * (B + 1) * B)
  assert.equal(STREET_WORDS, Math.ceil((STREET_SEGMENTS * 2) / 32))
  assert.equal(STREET_VEC4S * 4 >= STREET_WORDS, true)
  assert.deepEqual(SEG, { walk: 1, drive: 2 })
  // The widths match what regionWorld.ts draws for a two-lane street: one lane of carriageway each side, the pedestrian
  // lane on the sidewalk's outer half, the furniture at the kerb, clear of the lane.
  assert.equal(WINDOW_GEOMETRY.roadHalf, LANE_WIDTH)
  assert.ok(WINDOW_GEOMETRY.lane > LANE_WIDTH + SIDEWALK / 2 && WINDOW_GEOMETRY.lane <= LANE_WIDTH + SIDEWALK + 0.2)
  assert.ok(WINDOW_GEOMETRY.furniture > LANE_WIDTH && WINDOW_GEOMETRY.furniture < WINDOW_GEOMETRY.lane - 0.7)
})

test('the procedural city as a window: every segment a car street, every bit set, the city\'s own geometry', () => {
  const g = cityStreetGrid()
  assert.deepEqual([g.originX, g.originZ, g.blocks, g.roadHalf, g.lane, g.furniture], [0, 0, B, CITY.roadHalf, CITY.lane, CITY.furniture])
  assert.deepEqual(streetCounts(g), { walk: STREET_SEGMENTS, drive: STREET_SEGMENTS })
  const words = packStreets(g)
  assert.equal(words.length, STREET_VEC4S * 4)
  for (let i = 0; i < STREET_SEGMENTS; i++) assert.equal((words[(i * 2) >> 5] >>> ((i * 2) & 31)) & 3, 3, `segment ${i}`)
  for (let bit = STREET_SEGMENTS * 2; bit < words.length * 32; bit++) assert.equal((words[bit >> 5] >>> (bit & 31)) & 1, 0, 'nothing past the last segment')
  assert.deepEqual(spawnSegment(g), { k: 0, m: 0 })
  // Outside the window there is no segment, whatever the bits say.
  assert.equal(hSeg(g, -1, 0), 0); assert.equal(hSeg(g, B, 0), 0); assert.equal(hSeg(g, 0, B + 1), 0); assert.equal(hSeg(g, 0, B), 3)
  assert.equal(vSeg(g, 0, -1), 0); assert.equal(vSeg(g, 0, B), 0); assert.equal(vSeg(g, B + 1, 0), 0); assert.equal(vSeg(g, B, 0), 3)
})

test('over the city the window\'s rings are the city\'s own 64 rings, piece for piece, with the same seats', () => {
  const g = cityStreetGrid()
  const rects = ringRectangles(g)
  assert.equal(rects.length, 64)
  for (const r of rects) assert.deepEqual([r[1][0] - r[0][0], r[2][1] - r[1][1]], [2, 2])
  for (const seed of [0, SEED, 42]) {
    const mine = streetLoops(seed, g), theirs = carLoops(seed)
    assert.equal(mine.length, theirs.length)
    for (let i = 0; i < mine.length; i++) assert.deepEqual(shape(mine[i]), shape(theirs[i]), `ring ${i}, seed ${seed}`)
  }
  for (const seed of [0, SEED]) assert.equal(streetCapacity(g, seed), carLoops(seed).reduce((n, t) => n + capacity(t), 0))
  const net = streetNetwork(7, g)
  assert.equal(net.seed, 7)
  assert.ok(net.tracks.every((t, id) => t.id === id && t.kind === 'car'))
})

test('the metropolis\'s window: on the pitch, around the start, inside the region, every segment a street the map built, of its kind', () => {
  for (const [name, zone] of ZONES) {
    const { map, pack, layout, start, grid: g } = windowFor(zone)
    assert.equal(g.originX % P, 0, name); assert.equal(g.originZ % P, 0, name)
    assert.equal(g.blocks, B)
    assert.deepEqual([g.roadHalf, g.lane, g.furniture], [WINDOW_GEOMETRY.roadHalf, WINDOW_GEOMETRY.lane, WINDOW_GEOMETRY.furniture])
    // The start is in the window's middle blocks, and the window lies inside the region.
    assert.ok(start.x > g.originX + 6 * P && start.x < g.originX + 10 * P && start.z > g.originZ + 6 * P && start.z < g.originZ + 10 * P, `${name}: ${JSON.stringify(start)} in ${g.originX}, ${g.originZ}`)
    assert.ok(g.originX >= layout.bounds.x0 && g.originX + B * P <= layout.bounds.x1 && g.originZ >= layout.bounds.z0 && g.originZ + B * P <= layout.bounds.z1, name)
    // Every segment is the map's, with the map's kind: a pedestrian street is walked but not driven, a dropped one is nothing.
    // Engine metres → pack metres (the layout's offset) → map metres (the pack's origin is the zone's centre) → blocks.
    const k0 = Math.round((g.originX - layout.offset.x - pack.bounds.x0) / P), m0 = Math.round((g.originZ - layout.offset.z - pack.bounds.z0) / P)
    const expect = (kind: number) => (kind === STREET.none ? 0 : kind === STREET.pedestrian ? SEG.walk : SEG.walk | SEG.drive)
    let checked = 0, pedestrian = 0, dropped = 0
    for (let m = 0; m <= B; m++) for (let k = 0; k < B; k++) {
      const kind = map.hStreets[(m0 + m) * map.blocks + (k0 + k)]
      assert.equal(hSeg(g, k, m), expect(kind), `${name} h(${k}, ${m})`)
      checked++; if (kind === STREET.pedestrian) pedestrian++; if (kind === STREET.none) dropped++
    }
    for (let k = 0; k <= B; k++) for (let m = 0; m < B; m++) {
      const kind = map.vStreets[(k0 + k) * map.blocks + (m0 + m)]
      assert.equal(vSeg(g, k, m), expect(kind), `${name} v(${k}, ${m})`)
      checked++; if (kind === STREET.pedestrian) pedestrian++; if (kind === STREET.none) dropped++
    }
    assert.equal(checked, STREET_SEGMENTS)
    const counts = streetCounts(g)
    assert.ok(counts.walk > STREET_SEGMENTS * 0.7, `${name}: ${counts.walk} walkable of ${STREET_SEGMENTS}`)
    assert.equal(counts.walk, STREET_SEGMENTS - dropped)
    assert.equal(counts.drive, STREET_SEGMENTS - dropped - pedestrian)
    const spawn = spawnSegment(g)
    assert.ok(hSeg(g, spawn.k, spawn.m) & SEG.walk)
  }
})

test('the metropolis\'s rings: disjoint rectangles whose every side is a car street, each (segment, direction) on one ring, seats for the whole fleet', () => {
  for (const [name, zone] of ZONES) {
    const { grid: g } = windowFor(zone)
    const rects = ringRectangles(g)
    const used = new Uint8Array(B * B)
    const directed = new Set<string>()
    for (const r of rects) {
      assert.equal(r.length, 4)
      const [k0, m0] = r[0], [k1, m1] = r[2]
      assert.ok(k1 > k0 && m1 > m0 && k0 >= 0 && m0 >= 0 && k1 <= B && m1 <= B, `${name}: ${JSON.stringify(r)}`)
      assert.deepEqual(r, [[k0, m0], [k1, m0], [k1, m1], [k0, m1]], 'clockwise from the north-west corner')
      for (let m = m0; m < m1; m++) for (let k = k0; k < k1; k++) { assert.equal(used[m * B + k], 0, `${name}: block ${k}, ${m} in two rings`); used[m * B + k] = 1 }
      for (let k = k0; k < k1; k++) {
        assert.ok(hSeg(g, k, m0) & SEG.drive, `${name}: north side h(${k}, ${m0})`); assert.ok(hSeg(g, k, m1) & SEG.drive, `${name}: south side`)
        for (const d of [`h${k},${m0},+`, `h${k},${m1},-`]) { assert.ok(!directed.has(d), `${name}: ${d} twice`); directed.add(d) }
      }
      for (let m = m0; m < m1; m++) {
        assert.ok(vSeg(g, k0, m) & SEG.drive, `${name}: west side`); assert.ok(vSeg(g, k1, m) & SEG.drive, `${name}: east side`)
        for (const d of [`v${k0},${m},-`, `v${k1},${m},+`]) { assert.ok(!directed.has(d), `${name}: ${d} twice`); directed.add(d) }
      }
    }
    assert.ok(rects.length >= 40, `${name}: ${rects.length} rings`)
    assert.ok(used.reduce((n, u) => n + u, 0) >= B * B * 0.6, `${name}: most blocks ringed`)
    // The rings as tracks: in the engine's frame, every straight on a window street's right-hand lane.
    const loops = streetLoops(SEED, g)
    assert.equal(loops.length, rects.length)
    for (const t of loops) {
      assert.equal(t.kind, 'car')
      for (const piece of t.pieces) {
        if (piece.kind !== 'line') continue
        const x = piece.x0 - g.originX, z = piece.z0 - g.originZ
        const onV = Math.abs(x - Math.round(x / P) * P) === TRAFFIC.laneOffset, onH = Math.abs(z - Math.round(z / P) * P) === TRAFFIC.laneOffset
        assert.ok(onV || onH, `${name}: a straight ${TRAFFIC.laneOffset} m off a street line`)
      }
    }
    const seats = streetCapacity(g, SEED)
    assert.ok(seats >= 48, `${name}: ${seats} seats for a fleet of at most 48`)
    assert.equal(seats, loops.reduce((n, t) => n + capacity(t), 0))
  }
})

test('the furniture stands along the window\'s streets alone: lamps and trees by every sidewalk, signals where car streets meet', () => {
  const { grid: g } = windowFor(ZONE.metropolis)
  const f = windowFurniture(g, SEED)
  const counts = streetCounts(g)
  assert.equal(f.lamps.length, counts.walk * 4, 'two lamps a side per segment with a sidewalk')
  assert.equal(f.trees.length, counts.walk * 2)
  const segmentUnder = (x: number, z: number): number => {
    const lx = x - g.originX, lz = z - g.originZ
    const k = Math.round(lx / P), m = Math.round(lz / P)
    if (Math.abs(Math.abs(lx - k * P) - g.furniture) < 1e-6) return vSeg(g, k, Math.floor(lz / P))
    if (Math.abs(Math.abs(lz - m * P) - g.furniture) < 1e-6) return hSeg(g, Math.floor(lx / P), m)
    return 0
  }
  for (const [x, z] of f.lamps) assert.ok(segmentUnder(x, z) & SEG.walk, `a lamp at ${x}, ${z} stands by no sidewalk`)
  for (const [x, z] of f.trees) assert.ok(segmentUnder(x, z) & SEG.walk, `a tree at ${x}, ${z} stands by no sidewalk`)
  assert.equal(f.signals.length % 4, 0)
  const junctions = new Set<string>()
  for (const [x, z] of f.signals) {
    const k = Math.round((x - g.originX) / P), m = Math.round((z - g.originZ) / P)
    const arms = [hSeg(g, k, m), hSeg(g, k - 1, m), vSeg(g, k, m), vSeg(g, k, m - 1)].filter((b) => b & SEG.drive).length
    assert.ok(arms >= 3, `a signal at ${k}, ${m} with ${arms} arms`)
    junctions.add(`${k},${m}`)
  }
  let expected = 0
  for (let k = 0; k <= B; k++) for (let m = 0; m <= B; m++) if ([hSeg(g, k, m), hSeg(g, k - 1, m), vSeg(g, k, m), vSeg(g, k, m - 1)].filter((b) => b & SEG.drive).length >= 3) expected++
  assert.equal(junctions.size, expected)
  assert.ok(expected > 100 && expected < (B + 1) * (B + 1), `${expected} signalled junctions`)
  // The city's own furniture is the same recipe (city.ts streetFurniture places the signals at every intersection; a
  // window's four outer corners are bends of two arms, and get none).
  const city = windowFurniture(cityStreetGrid(), 1)
  assert.equal(city.signals.length, ((B + 1) * (B + 1) - 4) * 4)
  assert.equal(city.lamps.length, STREET_SEGMENTS * 4)
})

test('a surveyed pack off the grid gives no window; a tiny grid pack a window with its streets and nothing else', () => {
  const roads = (xz: number[][], lanes: number[]) => ({ cls: lanes.map(() => ROAD_CLASS.local), lanes, flow: lanes.map(() => 0), name: lanes.map(() => 0), start: xz.reduce((s, r) => [...s, s[s.length - 1] + r.length / 2], [0]), xz: xz.flat().map((v) => v * 10) })
  const base = (r: RegionPack['roads']): RegionPack => ({
    format: REGION_FORMAT, name: 'Testmere', grid: { lon0: 0, lat0: 0, k0: 1 }, bounds: { x0: 0, z0: 0, x1: 400, z1: 400 }, attribution: [], names: [''],
    roads: r, water: { ...polygons(), kind: [], name: [] }, buildings: { ...polygons(), height: [], kind: [] },
  })
  const offset = { x: REGION_CORNER.x, z: REGION_CORNER.z }
  assert.equal(streetGridOf(base(roads([[3, 5, 120, 77], [0, 0, 400, 400]], [2, 2])), offset, { x: 2200, z: 2200 }), null, 'off the grid')
  assert.equal(streetGridOf(base(roads([], [])), offset, { x: 2200, z: 2200 }), null, 'no roads')
  // Two streets on the grid, one of them a pedestrian street; the window is clamped to the pack's streets.
  const g = streetGridOf(base(roads([[0, 40, 120, 40], [40, 0, 40, 120]], [2, 1])), offset, { x: 2200, z: 2200 })
  assert.ok(g)
  assert.deepEqual([g.originX, g.originZ], [REGION_CORNER.x, REGION_CORNER.z])
  assert.deepEqual(streetCounts(g), { walk: 6, drive: 3 })
  assert.equal(hSeg(g, 0, 1), SEG.walk | SEG.drive); assert.equal(hSeg(g, 2, 1), SEG.walk | SEG.drive); assert.equal(hSeg(g, 3, 1), 0)
  assert.equal(vSeg(g, 1, 0), SEG.walk); assert.equal(vSeg(g, 1, 2), SEG.walk); assert.equal(vSeg(g, 1, 3), 0)
  assert.deepEqual(ringRectangles(g), [], 'no cell is closed by car streets')
  assert.equal(streetCapacity(g, 1), 0)
  assert.deepEqual(spawnSegment(g), { k: 0, m: 1 })
  assert.throws(() => packStreets({ ...g, blocks: 8 }), RangeError)
})

test('the shore wall is cut where a bridge crosses it: the lake\'s edge under an arterial leaves the road\'s width open', async () => {
  const { pack, layout, grid: g } = windowFor(ZONE.metropolis)
  const phys = regionPhysics(pack, layout)
  // Every bridge of the pack (an arterial whose points are over water) crosses the water's edge where it starts.
  const walls: [number, number, number, number][] = []
  for (let i = 0; i < phys.walls.length; i += 5) if (Math.abs(phys.walls[i + 4] - SHORE_WALL) < 1e-3) walls.push([phys.walls[i], phys.walls[i + 1], phys.walls[i + 2], phys.walls[i + 3]])
  assert.ok(walls.length > 100, 'the lake has a shoreline')
  const near = (x: number, z: number, d: number) => walls.some(([x0, z0, x1, z1]) => {
    const dx = x1 - x0, dz = z1 - z0, l2 = dx * dx + dz * dz
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / l2)) : 0
    return Math.hypot(x - x0 - t * dx, z - z0 - t * dz) < d
  })
  // Every north-south road of the pack that crosses or ends on a horizontal edge of a water block (the lake's shore, or a
  // row line inside the lake under a bridge): the edge, as the pack has it, runs across the road...
  const edges: [number, number, number][] = []
  for (let i = 0; i < polygonCount(pack.water); i++) {
    for (const ring of polygonAt(pack.water, i)) {
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k], b = ring[(k + 1) % ring.length]
        if (a[1] === b[1]) edges.push([Math.min(a[0], b[0]) + layout.offset.x, Math.max(a[0], b[0]) + layout.offset.x, a[1] + layout.offset.z])
      }
    }
  }
  let crossings = 0
  for (let i = 0; i < pack.roads.cls.length; i++) {
    if (pack.roads.lanes[i] < 2) continue
    const pts = roadAt(pack, i).map(([x, z]) => [x + layout.offset.x, z + layout.offset.z] as const)
    if (pts.length !== 2 || pts[0][0] !== pts[1][0]) continue
    const x = pts[0][0], za = Math.min(pts[0][1], pts[1][1]), zb = Math.max(pts[0][1], pts[1][1])
    for (const [xa, xb, z] of edges) {
      if (!(xa < x - 8 && x + 8 < xb && za <= z && z <= zb)) continue
      if (Math.abs(z - layout.bounds.z0) < 0.2 || Math.abs(z - layout.bounds.z1) < 0.2) continue
      crossings++
      // ...the wall stands on either side of the road, and under the road itself it is cut for the carriageway and both sidewalks.
      assert.ok(near(x + g.roadHalf + SIDEWALK + 1, z, 0.3) && near(x - g.roadHalf - SIDEWALK - 1, z, 0.3), `the shore wall beside the road at ${x}, ${z}`)
      for (const dx of [-g.roadHalf - SIDEWALK + 0.3, -g.roadHalf, 0, g.roadHalf, g.roadHalf + SIDEWALK - 0.3]) assert.ok(!near(x + dx, z, 0.2), `a wall across the road at ${x + dx}, ${z}`)
    }
  }
  assert.ok(crossings > 0, 'some road of the pack meets the water\'s edge')
})

test('the onboarding\'s own packs: every zone\'s window seats the default fleet, and the one-call build agrees', () => {
  for (const [, zone] of ZONES) {
    const map = generateLakefront(SEED, 64)
    const c = zoneCentre(map, zone)
    const pack = buildLakefrontPack(SEED, zone)
    const layout = layoutOf(pack)
    const g = streetGridOf(pack, layout.offset, { x: layout.offset.x, z: layout.offset.z })
    assert.ok(g)
    assert.ok(streetCapacity(g, SEED) >= 36)
    // The pack's origin is the zone's centre: the window around it is around the zone.
    assert.ok(Math.abs(g.originX + (B / 2) * P - (c.x - c.x + layout.offset.x)) <= P && Math.abs(g.originZ + (B / 2) * P - layout.offset.z) <= P)
  }
  assert.equal(MACRO.pitch, P)
})

// ---------------------------------------------------------------- the whole map's grid, and the window as a crop of it

/** streetGridOf as it stood before the whole map's grid existed, word for word: the oracle the new one is held to. */
function oracleStreetGridOf(pack: RegionPack, offset: { x: number; z: number }, around: { x: number; z: number }): StreetGrid | null {
  const onGrid = (v: number): boolean => Math.abs(v / P - Math.round(v / P)) < 1e-6
  // Every grid segment of the pack, in engine block indices, with its bits.
  const h = new Map<string, number>(), v = new Map<string, number>()
  let minK = Infinity, maxK = -Infinity, minM = Infinity, maxM = -Infinity
  for (let i = 0; i < pack.roads.cls.length; i++) {
    if (pack.roads.cls[i] === ROAD_CLASS.ferry) continue
    const pts = roadAt(pack, i).map(([x, z]) => [x + offset.x, z + offset.z] as const)
    if (pts.length < 2 || !pts.every(([x, z]) => Number.isFinite(x) && Number.isFinite(z) && onGrid(x) && onGrid(z))) continue
    const bits = SEG.walk | (pack.roads.lanes[i] >= 2 ? SEG.drive : 0)
    for (let p = 0; p + 1 < pts.length; p++) {
      const k0 = Math.round(pts[p][0] / P), m0 = Math.round(pts[p][1] / P), k1 = Math.round(pts[p + 1][0] / P), m1 = Math.round(pts[p + 1][1] / P)
      if ((k0 !== k1) === (m0 !== m1)) continue
      if (m0 === m1) for (let k = Math.min(k0, k1); k < Math.max(k0, k1); k++) h.set(`${k},${m0}`, (h.get(`${k},${m0}`) ?? 0) | bits)
      else for (let m = Math.min(m0, m1); m < Math.max(m0, m1); m++) v.set(`${k0},${m}`, (v.get(`${k0},${m}`) ?? 0) | bits)
      minK = Math.min(minK, k0, k1); maxK = Math.max(maxK, k0, k1); minM = Math.min(minM, m0, m1); maxM = Math.max(maxM, m0, m1)
    }
  }
  if (h.size + v.size === 0) return null
  // The window: CITY.blocks across, centred on the block under `around`, kept inside the map's streets.
  const clampTo = (want: number, lo: number, hi: number) => Math.max(lo, Math.min(Math.max(lo, hi - B), want))
  const k0 = clampTo(Math.round(around.x / P) - B / 2, minK, maxK), m0 = clampTo(Math.round(around.z / P) - B / 2, minM, maxM)
  const g: StreetGrid = {
    originX: k0 * P, originZ: m0 * P, blocks: B, ...WINDOW_GEOMETRY,
    h: new Uint8Array((B + 1) * B), v: new Uint8Array((B + 1) * B),
  }
  for (const [key, bits] of h) {
    const [k, m] = key.split(',').map(Number)
    if (k - k0 >= 0 && k - k0 < B && m - m0 >= 0 && m - m0 <= B) g.h[(m - m0) * B + (k - k0)] = bits
  }
  for (const [key, bits] of v) {
    const [k, m] = key.split(',').map(Number)
    if (m - m0 >= 0 && m - m0 < B && k - k0 >= 0 && k - k0 <= B) g.v[(k - k0) * B + (m - m0)] = bits
  }
  return g
}

/** A pack of nothing but roads, each [class, lanes, x, z, x, z, …] in the pack's metres. */
function roadPack(roads: readonly (readonly number[])[]): RegionPack {
  const r: RegionPack['roads'] = { cls: [], lanes: [], flow: [], name: [], start: [0], xz: [] }
  for (const [cls, lanes, ...xz] of roads) {
    r.cls.push(cls); r.lanes.push(lanes); r.flow.push(0); r.name.push(0)
    for (const c of xz) r.xz.push(Math.round(c * 10))
    r.start.push(r.xz.length / 2)
  }
  return {
    format: REGION_FORMAT, name: 'Testmere', grid: { lon0: 0, lat0: 0, k0: 1 }, bounds: { x0: -400, z0: 0, x1: 1200, z1: 400 }, attribution: ['a test'], names: [''],
    roads: r, water: { ...polygons(), kind: [], name: [] }, buildings: { ...polygons(), height: [], kind: [] },
  }
}
/**
 * A map longer east to west (40 blocks) than north to south (5), with everything streetGridOf has a rule for: a
 * two-lane street and a pedestrian street over part of it, a road of three points whose first run is a diagonal, one
 * with a run of no length, a ferry on the grid, a road off the grid, and a road of a single point.
 */
const LONG = roadPack([
  [ROAD_CLASS.arterial, 2, -400, 80, 1200, 80],
  [ROAD_CLASS.local, 1, 0, 80, 200, 80],
  [ROAD_CLASS.local, 1, 0, 0, 0, 200],
  [ROAD_CLASS.local, 1, 240, 120, 400, 120],
  [ROAD_CLASS.local, 2, 400, 120, 240, 120],
  [ROAD_CLASS.collector, 2, 1200, 160, 1200, 40],
  [ROAD_CLASS.local, 2, 40, 0, 80, 40, 80, 120],
  [ROAD_CLASS.local, 2, 160, 0, 160, 0, 160, 40],
  [ROAD_CLASS.ferry, 2, 0, 200, 400, 200],
  [ROAD_CLASS.local, 2, 3, 5, 120, 77],
  [ROAD_CLASS.local, 2, 600, 160],
])

test('streetGridOf is the whole map\'s grid, cropped: the very window its old body gave, for three seeds, the five quarters, the old start, the quarter\'s centre and starts all over the map and past its edges', () => {
  let compared = 0
  const same = (pack: RegionPack, offset: { x: number; z: number }, around: { x: number; z: number }, what: string) => {
    const was = oracleStreetGridOf(pack, offset, around)
    assert.deepEqual(streetGridOf(pack, offset, around), was, what)
    compared++
    return was
  }
  const origins = new Set<string>()
  for (const seed of [1337, 7, 42]) {
    const map = generateLakefront(seed, 64)
    for (const [name, zone] of ZONES) {
      const pack = packOf(map, zone)
      const layout = layoutOf(pack)
      const b = layout.bounds
      const old = new RegionPlaces(pack, layout).spawn({ x: layout.offset.x, z: layout.offset.z })
      // The old start (the arterial run nearest the quarter's centre), the quarter's centre itself (the pack's origin: where
      // a start in the chosen quarter is), the map's corners and a block past them, and its middle.
      const starts = [old, { x: layout.offset.x, z: layout.offset.z }, { x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2 }]
      for (const x of [b.x0 - P, b.x0, b.x1, b.x1 + P]) for (const z of [b.z0 - P, b.z0, b.z1, b.z1 + P]) starts.push({ x, z })
      // And, once a seed (the streets stand at the same engine metres whichever quarter is home): a lattice over the whole
      // map and past every edge, four blocks apart and off the street lines, so the clamp and the crop are met everywhere.
      if (zone === ZONE.metropolis) for (let z = b.z0 - 2 * P - 7; z <= b.z1 + 2 * P; z += 4 * P + 1) for (let x = b.x0 - 2 * P - 7; x <= b.x1 + 2 * P; x += 4 * P + 1) starts.push({ x, z })
      for (const around of starts) {
        const g = same(pack, layout.offset, around, `seed ${seed} ${name}, around ${around.x}, ${around.z}`)
        assert.ok(g)
        origins.add(`${seed}:${g.originX},${g.originZ}`)
      }
    }
  }
  assert.ok(origins.size > 3 * 150, `${origins.size} different windows compared`)
  // A map longer one way than the other, at three offsets (the last is off the pitch: no road lies on the grid), from
  // starts on a lattice past every edge, and from nowhere at all (a start that is not a number gives the same empty window).
  for (const offset of [{ x: REGION_CORNER.x, z: REGION_CORNER.z }, { x: 120, z: -360 }, { x: 13, z: 7 }]) {
    const starts = [{ x: NaN, z: NaN }, { x: Infinity, z: -Infinity }, { x: -Infinity, z: Infinity }]
    for (let z = offset.z - 130; z <= offset.z + 450; z += 70) for (let x = offset.x - 530; x <= offset.x + 1330; x += 90) starts.push({ x, z })
    for (const around of starts) same(LONG, offset, around, `the long map at ${offset.x}, ${offset.z}, around ${around.x}, ${around.z}`)
  }
  assert.equal(oracleStreetGridOf(LONG, { x: 13, z: 7 }, { x: 0, z: 0 }), null)
  assert.ok(compared > 1500, `${compared} windows compared`)
  // The surveyed pilot, where it is checked out: its roads lie on no grid, so it has no window and no map grid, as before.
  const pilot = new URL('../../../world/pilot.region.json.gz', import.meta.url)
  if (existsSync(pilot)) {
    const pack = validatePack(JSON.parse(gunzipSync(readFileSync(pilot)).toString('utf8')))
    const layout = layoutOf(pack)
    assert.equal(same(pack, layout.offset, { x: layout.offset.x, z: layout.offset.z }, 'the pilot'), null)
    assert.equal(mapStreetGrid(pack, layout.offset), null)
    assert.equal(pack.quarters, undefined, 'a surveyed pack has no quarters')
  }
})

test('the whole map\'s grid: every street the map built and nothing else, the same for every start quarter; the long map\'s as many blocks as its longer side', () => {
  const expect = (kind: number) => (kind === STREET.none ? 0 : kind === STREET.pedestrian ? SEG.walk : SEG.walk | SEG.drive)
  for (const seed of [1337, 7, 42]) {
    const map = generateLakefront(seed, 64)
    const grids = ZONES.map(([, zone]) => { const pack = packOf(map, zone); return mapStreetGrid(pack, layoutOf(pack).offset) })
    const g = grids[0]
    assert.ok(g)
    // Engine metres are the map's plus the region's corner, whichever quarter the pack starts in: one grid for all five.
    for (const other of grids) assert.deepEqual(other, g, `seed ${seed}: the same grid for every start`)
    assert.deepEqual([g.originX, g.originZ, g.blocks], [REGION_CORNER.x, REGION_CORNER.z, map.blocks], `seed ${seed}`)
    assert.deepEqual([g.roadHalf, g.lane, g.furniture], [WINDOW_GEOMETRY.roadHalf, WINDOW_GEOMETRY.lane, WINDOW_GEOMETRY.furniture])
    assert.deepEqual([g.h.length, g.v.length], [65 * 64, 65 * 64])
    let streets = 0, driven = 0
    for (let m = 0; m <= 64; m++) for (let k = 0; k < 64; k++) {
      const kind = map.hStreets[m * 64 + k]
      assert.equal(hSeg(g, k, m), expect(kind), `seed ${seed} h(${k}, ${m})`)
      if (kind !== STREET.none) streets++
      if (kind !== STREET.none && kind !== STREET.pedestrian) driven++
    }
    for (let k = 0; k <= 64; k++) for (let m = 0; m < 64; m++) {
      const kind = map.vStreets[k * 64 + m]
      assert.equal(vSeg(g, k, m), expect(kind), `seed ${seed} v(${k}, ${m})`)
      if (kind !== STREET.none) streets++
      if (kind !== STREET.none && kind !== STREET.pedestrian) driven++
    }
    assert.deepEqual(streetCounts(g), { walk: streets, drive: driven })
    assert.ok(streets > 5000, `seed ${seed}: ${streets} street segments on the map, against ${STREET_SEGMENTS} in a window`)
    // The shader's field stays the window's: the map's grid is for reading, never packed.
    assert.throws(() => packStreets(g), RangeError)
  }
  // The long map: 40 blocks by 5, from its lowest street lines; the rest of the square is empty.
  const offset = { x: REGION_CORNER.x, z: REGION_CORNER.z }
  const long = mapStreetGrid(LONG, offset)
  assert.ok(long)
  assert.deepEqual([long.originX, long.originZ, long.blocks], [REGION_CORNER.x - 400, REGION_CORNER.z, 40])
  assert.deepEqual([long.roadHalf, long.lane, long.furniture], [WINDOW_GEOMETRY.roadHalf, WINDOW_GEOMETRY.lane, WINDOW_GEOMETRY.furniture])
  const two = SEG.walk | SEG.drive
  for (let k = 0; k < 40; k++) assert.equal(hSeg(long, k, 2), two, `the long street at ${k}: a pedestrian street over a two-lane one is still driven`)
  for (let m = 0; m < 5; m++) assert.equal(vSeg(long, 10, m), SEG.walk, 'the pedestrian street')
  for (let k = 16; k < 20; k++) assert.equal(hSeg(long, k, 3), two, 'a street laid twice, once each way and once with one lane')
  assert.deepEqual([vSeg(long, 40, 0), vSeg(long, 40, 1), vSeg(long, 40, 3), vSeg(long, 40, 4)], [0, two, two, 0], 'the far street, on the grid\'s last line')
  assert.deepEqual([vSeg(long, 12, 0), vSeg(long, 12, 1), vSeg(long, 12, 2), vSeg(long, 12, 3)], [0, two, two, 0], 'the diagonal run is no street; the run after it is')
  assert.deepEqual([vSeg(long, 14, 0), vSeg(long, 14, 1)], [two, 0], 'a run of no length is no street; the run after it is')
  assert.equal(hSeg(long, 10, 5), 0, 'the ferry is no street')
  assert.deepEqual(streetCounts(long), { walk: 40 + 5 + 4 + 3 + 2 + 1, drive: 40 + 4 + 3 + 2 + 1 })
  for (let m = 6; m <= 40; m++) for (let k = 0; k < 40; k++) assert.equal(hSeg(long, k, m), 0, 'nothing past the map\'s short side')
  assert.equal(mapStreetGrid(LONG, { x: 13, z: 7 }), null, 'off the pitch, no road lies on the grid')
  assert.equal(mapStreetGrid(roadPack([]), offset), null, 'no roads')
  assert.equal(mapStreetGrid(roadPack([[ROAD_CLASS.ferry, 2, 0, 0, 400, 0], [ROAD_CLASS.local, 2, 0, 0, 40, 40]]), offset), null, 'a ferry and a diagonal: no street')
})

test('the window is a crop of the map\'s grid wherever it is put, and windowOrigin puts it round the visitor, inside the map\'s streets', () => {
  const map = generateLakefront(SEED, 64)
  const pack = packOf(map, ZONE.westSprawl)
  const layout = layoutOf(pack)
  const g = mapStreetGrid(pack, layout.offset)
  assert.ok(g)
  const before = structuredClone(g)
  const K0 = REGION_CORNER.x / P, M0 = REGION_CORNER.z / P
  const expect = (kind: number) => (kind === STREET.none ? 0 : kind === STREET.pedestrian ? SEG.walk : SEG.walk | SEG.drive)
  // What the generated map has at a street segment, by the map's own block indices: nothing off the map.
  const hAt = (k: number, m: number) => (k < 0 || k >= 64 || m < 0 || m > 64 ? 0 : expect(map.hStreets[m * 64 + k]))
  const vAt = (k: number, m: number) => (m < 0 || m >= 64 || k < 0 || k > 64 ? 0 : expect(map.vStreets[k * 64 + m]))
  // Every place a window can stand on the map, and a few hanging over each edge and clear of it.
  let windows = 0
  for (let dm = -20; dm <= 68; dm++) for (let dk = -20; dk <= 68; dk++) {
    const inside = dk >= 0 && dk <= 48 && dm >= 0 && dm <= 48
    if (!inside && (dk + 20) % 11 !== 0 && (dm + 20) % 11 !== 0) continue
    const w = windowOf(g, K0 + dk, M0 + dm)
    assert.deepEqual([w.originX, w.originZ, w.blocks, w.roadHalf, w.lane, w.furniture], [(K0 + dk) * P, (M0 + dm) * P, B, g.roadHalf, g.lane, g.furniture])
    assert.deepEqual([w.h.length, w.v.length], [(B + 1) * B, (B + 1) * B])
    for (let m = 0; m <= B; m++) for (let k = 0; k < B; k++) if (w.h[m * B + k] !== hAt(dk + k, dm + m)) assert.fail(`window ${dk}, ${dm}: h(${k}, ${m}) is ${w.h[m * B + k]}, the map has ${hAt(dk + k, dm + m)}`)
    for (let k = 0; k <= B; k++) for (let m = 0; m < B; m++) if (w.v[k * B + m] !== vAt(dk + k, dm + m)) assert.fail(`window ${dk}, ${dm}: v(${k}, ${m}) is ${w.v[k * B + m]}, the map has ${vAt(dk + k, dm + m)}`)
    windows++
  }
  assert.ok(windows > 49 * 49, `${windows} windows read`)
  assert.deepEqual(streetCounts(windowOf(g, K0 + 64, M0 - 17)), { walk: 0, drive: 0 }, 'a window clear of the map is empty')
  const lastLine = [...Array(B).keys()].map((m) => vAt(64, m))
  assert.ok(lastLine.some((bits) => bits !== 0), 'the map\'s last street line is a street')
  assert.deepEqual(streetCounts(windowOf(g, K0 + 64, M0)), { walk: lastLine.filter((bits) => bits & SEG.walk).length, drive: lastLine.filter((bits) => bits & SEG.drive).length }, 'a window whose first line is the map\'s last holds that line alone')
  assert.notEqual(windowOf(g, K0, M0), windowOf(g, K0, M0), 'a new grid every time')
  assert.deepEqual(g, before, 'the map\'s grid is only read')
  // The geometry is the map's own: a window of the procedural city's grid keeps the city's numbers, and is the city.
  assert.deepEqual(windowOf(cityStreetGrid(), 0, 0), cityStreetGrid())
  // Where the window stands: centred on the visitor's block, and kept between the map's first and last street lines.
  const at = (x: number, z: number) => windowOrigin(g, { x, z })
  assert.deepEqual(at(REGION_CORNER.x + 1280, REGION_CORNER.z + 1280), { k0: K0 + 32 - B / 2, m0: M0 + 32 - B / 2 }, 'the middle of the map')
  assert.deepEqual(at(REGION_CORNER.x + 1299, REGION_CORNER.z + 1301), { k0: K0 + 32 - B / 2, m0: M0 + 33 - B / 2 }, 'the nearest street line decides')
  assert.deepEqual(at(REGION_CORNER.x + 10 * P, REGION_CORNER.z + 30 * P), { k0: K0 + 2, m0: M0 + 22 })
  assert.deepEqual(at(REGION_CORNER.x, REGION_CORNER.z), { k0: K0, m0: M0 }, 'the north-west corner: the first lines')
  assert.deepEqual(at(REGION_CORNER.x - 9000, REGION_CORNER.z + 64 * P), { k0: K0, m0: M0 + 64 - B }, 'past the west edge, on the south one')
  assert.deepEqual(at(Infinity, Infinity), { k0: K0 + 64 - B, m0: M0 + 64 - B }, 'the last window that fits')
  for (const [name, zone] of ZONES) {
    const p = packOf(map, zone), l = layoutOf(p)
    const start = new RegionPlaces(p, l).spawn({ x: l.offset.x, z: l.offset.z })
    const o = windowOrigin(g, start)
    assert.deepEqual(windowOf(g, o.k0, o.m0), streetGridOf(p, l.offset, start), `${name}: streetGridOf is the three together`)
  }
  // The long map: clamped along its long side, and from its first line on the short side, where it has fewer blocks than a window.
  const offset = { x: REGION_CORNER.x, z: REGION_CORNER.z }
  const long = mapStreetGrid(LONG, offset)!
  const L0 = (REGION_CORNER.x - 400) / P
  assert.deepEqual(windowOrigin(long, { x: REGION_CORNER.x + 400, z: REGION_CORNER.z + 80 }), { k0: K0 + 10 - B / 2, m0: M0 })
  assert.deepEqual(windowOrigin(long, { x: -1e6, z: 1e6 }), { k0: L0, m0: M0 }, 'never before the first street line')
  assert.deepEqual(windowOrigin(long, { x: 1e6, z: -1e6 }), { k0: L0 + 40 - B, m0: M0 }, 'the long side ends at its last street line, the short side at its own (5 blocks), not the square\'s')
  // A grid no street stands on is clamped to its own square.
  const bare: StreetGrid = { originX: 400, originZ: 800, blocks: 20, ...WINDOW_GEOMETRY, h: new Uint8Array(21 * 20), v: new Uint8Array(21 * 20) }
  assert.deepEqual(windowOrigin(bare, { x: 0, z: 0 }), { k0: 10, m0: 20 })
  assert.deepEqual(windowOrigin(bare, { x: 1e6, z: 1e6 }), { k0: 14, m0: 24 })
})

// A grid that is not a StreetGrid (the type is structural): the engine refuses nothing here, the host does (regionPhysics.test.ts).
void ((_: StreetGrid) => _)
