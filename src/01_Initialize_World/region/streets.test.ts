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
 * a surveyed pack off the grid gives no window; and the shore wall is cut where a bridge crosses it.
 * What breaks if it is removed? A pedestrian could be routed down a street the map never built, a ring could run over
 * a ravine, or the fleet could ask for more seats than the window has, and only a browser session would show it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CITY } from '../city.ts'
import { ZONE, generateLakefront, type Zone } from '../lakefront.ts'
import { buildLakefrontPack, packOf, zoneCentre } from '../lakefrontPack.ts'
import { MACRO, STREET } from '../macroCity.ts'
import { carLoops, capacity, type Track } from '../../06_Make_Decisions/tracks.ts'
import { TRAFFIC } from '../../02_Define_The_Rules/civic.ts'
import { REGION_FORMAT, ROAD_CLASS, polygonAt, polygonCount, polygons, roadAt, type RegionPack } from './pack.ts'
import {
  SEG, STREET_SEGMENTS, STREET_VEC4S, STREET_WORDS, WINDOW_BLOCKS, WINDOW_GEOMETRY, cityStreetGrid, hSeg, packStreets, ringRectangles, spawnSegment,
  streetCapacity, streetCounts, streetGridOf, streetLoops, streetNetwork, vSeg, windowFurniture, type StreetGrid,
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
function windowOf(zone: Zone, seed = SEED) {
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
    const { map, pack, layout, start, grid: g } = windowOf(zone)
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
    const { grid: g } = windowOf(zone)
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
  const { grid: g } = windowOf(ZONE.metropolis)
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
  const { pack, layout, grid: g } = windowOf(ZONE.metropolis)
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

// A grid that is not a StreetGrid (the type is structural): the engine refuses nothing here, the host does (regionPhysics.test.ts).
void ((_: StreetGrid) => _)
