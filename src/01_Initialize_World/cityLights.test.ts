// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the city's night lighting (cityLights.ts) where no GPU is needed: which lamps are
 * lit (the nearest to the focus, as many as asked, nearest first), where a room's fixtures hang (inside the room, under
 * its ceiling, whichever way its door faces), the lamp and fixture photometry the look was tuned to, and that the
 * clustered node's grid is constant: three's own node rebuilds its compute pass (and so re-keys every lit material)
 * whenever the drawing buffer changes size, which the quality governor does at every tier step; the city's must not.
 * What breaks if it is removed? A lamp lit on the far side of the city, a fixture outside its room, or a resize that
 * recompiles the city would only show on a device.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import ClusteredLightsNode from 'three/addons/tsl/lighting/ClusteredLightsNode.js'
import { CityLightsNode, FIXTURE, LAMP, LIGHT_GRID, MAX_CLUSTERED_LIGHTS, lampHead, nearestLamps, roomFixtures } from './cityLights.ts'
import { CITY, streetFurniture } from './city.ts'
import { ROOM, toWorld, workplaces } from './interiors.ts'

/** The lamp pool world.ts FULL_WORLD builds (liteWiring.test.ts pins it; world.ts needs the page's WGSL hook to load here). */
const POOL = 384

/** The parts of three's node a test reads (private to it). */
interface Internals { _compute: object | null; _bufferSize: { width: number; height: number } | null; _lightIndexes: { value: { array: Int32Array } } | null }

const scratch = () => ({ d2: new Float32Array(0), order: new Uint32Array(0) })

test('nearestLamps: the nearest heads first, as many as asked, no more than there are; the farthest chosen distance back', () => {
  const heads: [number, number, number][] = [[0, 5.9, 0], [10, 5.9, 0], [0, 5.9, 20], [30, 5.9, 0], [3, 5.9, 4]]
  const out: number[] = []
  const s = scratch()
  assert.equal(nearestLamps(heads, 0, 0, 3, out, s), 100)
  assert.deepEqual(out, [0, 4, 1], 'nearest first: the origin, (3, 4) at 5 m, (10, 0) at 10 m')
  assert.equal(nearestLamps(heads, 30, 0, 1, out, s), 0)
  assert.deepEqual(out, [3])
  assert.equal(nearestLamps(heads, 0, 0, 9, out, s), 900, 'more asked than there are: all of them')
  assert.equal(out.length, 5)
  assert.equal(nearestLamps(heads, 0, 0, 0, out, s), 0)
  assert.deepEqual(out, [])
  assert.equal(nearestLamps([], 0, 0, 4, out, s), 0)
  assert.deepEqual(out, [])
  assert.ok(s.d2.length >= 5 && s.order.length >= 5, 'the scratch grew to the heads once')
})

test('nearestLamps: the city\'s own lamps, from a sidewalk: a tier\'s count reaches as far as the lamp density says', () => {
  const heads = streetFurniture(1337).lamps.map(lampHead)
  assert.ok(heads.length > POOL, `${heads.length} lamps in the city, more than the pool`)
  const out: number[] = []
  const s = scratch()
  const at = CITY.blocks * CITY.pitch / 2 + CITY.lane
  // Eight lamps a block (two a kerb, two kerbs, two streets): 32 reach about 45 m, 384 about 155 m.
  const reach = (n: number) => Math.sqrt(nearestLamps(heads, at, at, n, out, s))
  const r32 = reach(32), r384 = reach(384)
  assert.ok(r32 > 30 && r32 < 60, `32 lamps reach ${r32.toFixed(0)} m`)
  assert.ok(r384 > 120 && r384 < 200, `384 lamps reach ${r384.toFixed(0)} m`)
  assert.equal(out.length, 384)
  assert.equal(new Set(out).size, 384, 'each lamp once')
  // Nearest first, so the lit set is a disc round the focus.
  const d = out.map((i) => Math.hypot(heads[i][0] - at, heads[i][2] - at))
  for (let k = 1; k < d.length; k++) assert.ok(d[k] >= d[k - 1] - 1e-6)
})

test('lampHead: the head over the kerb, LAMP.reach along the arm, at LAMP.height', () => {
  assert.deepEqual(lampHead([10, 20, 0]), [10, LAMP.height, 20 + LAMP.reach])
  const [x, y, z] = lampHead([10, 20, Math.PI / 2])
  assert.ok(Math.abs(x - (10 + LAMP.reach)) < 1e-9 && y === LAMP.height && Math.abs(z - 20) < 1e-9)
})

test('roomFixtures: four a room, inside its walls, under its ceiling, in the room\'s own frame whichever way it faces', () => {
  const rooms = workplaces(1337)
  assert.ok(rooms.length > 0)
  const fixtures = roomFixtures(rooms)
  assert.equal(fixtures.length, FIXTURE.at.length * rooms.length)
  const inner = CITY.lotHalf - ROOM.wall
  rooms.forEach((room, r) => {
    const own = fixtures.slice(r * FIXTURE.at.length, (r + 1) * FIXTURE.at.length)
    for (const f of own) {
      assert.ok(Math.abs(f.x - room.cx) < inner && Math.abs(f.z - room.cz) < inner, `${room.name}: a fixture inside the walls`)
      assert.equal(f.y, ROOM.height - FIXTURE.drop)
      assert.equal(f.candela, FIXTURE.candela)
      assert.equal(f.range, FIXTURE.range)
      assert.equal(f.decay, FIXTURE.decay)
      assert.ok(f.range > Math.hypot(inner, inner), 'one fixture reaches the far corner')
    }
    // In the room's frame: at FIXTURE.at, each quarter's centre.
    const want = FIXTURE.at.map(([u, v]) => toWorld(room, u, v))
    for (const [i, f] of own.entries()) assert.ok(Math.abs(f.x - want[i].x) < 1e-9 && Math.abs(f.z - want[i].z) < 1e-9)
  })
  assert.deepEqual(roomFixtures([]), [])
})

test('photometry: the lamp pool and every room fit the clustered node; a lamp lights a street, a fixture a room', () => {
  assert.ok(POOL + FIXTURE.at.length * ROOM.slots <= MAX_CLUSTERED_LIGHTS, 'the pool and every room\'s fixtures fit')
  assert.ok(LAMP.range >= 20 && LAMP.range <= 40, 'a lamp reaches the far kerb and the facades, not the next block')
  // The night is drawn near the day's exposure, so a lamp's irradiance under the pole is a fraction of the sun's 3.
  const underPole = LAMP.candela / (LAMP.height * LAMP.height)
  assert.ok(underPole > 0.5 && underPole < 1.2, `${underPole.toFixed(2)} under the pole: lit, not daylight`)
  assert.ok(FIXTURE.candela / ((ROOM.height - FIXTURE.drop) ** 2) < 1.5, 'the floor under a fixture lit, not daylight')
  assert.deepEqual(FIXTURE.at.map(([u, v]) => [Math.abs(u), Math.abs(v)]), [[6.5, 6.5], [6.5, 6.5], [6.5, 6.5], [6.5, 6.5]], 'the same four points whichever way the door faces: the ceiling panels find them')
  assert.equal(LAMP.decay, 2)
  assert.equal(FIXTURE.decay, 2)
  assert.ok(FIXTURE.color[2] >= FIXTURE.color[0] && LAMP.color[2] < LAMP.color[0], 'cool office white indoors, warm sodium outdoors')
  assert.equal(LIGHT_GRID.x * LIGHT_GRID.y * LIGHT_GRID.z * LIGHT_GRID.perCluster * 4, 48 * 27 * 24 * 32 * 4, 'the index buffer: four bytes a light slot, 4 MB')
})

test('CityLightsNode: the grid is constant; a resize or a new drawing buffer rebuilds nothing, where three\'s node rebuilds', () => {
  const city = new CityLightsNode()
  const c = city as unknown as Internals
  assert.ok(c._compute && c._lightIndexes, 'built once, in the constructor')
  assert.deepEqual([c._bufferSize?.width, c._bufferSize?.height], [LIGHT_GRID.x, LIGHT_GRID.y])
  assert.equal(c._lightIndexes.value.array.length, LIGHT_GRID.x * LIGHT_GRID.y * LIGHT_GRID.z * Math.ceil(LIGHT_GRID.perCluster / 4) * 4)
  const compute = c._compute, indexes = c._lightIndexes
  const key = city.customCacheKey()
  city.setSize(1920, 1080)
  city.setSize(640, 360)
  city.updateProgram()
  assert.equal(c._compute, compute, 'the same compute pass after resizes')
  assert.equal(c._lightIndexes, indexes)
  assert.equal(city.customCacheKey(), key, 'the same cache key: no lit material re-keys')
  assert.equal(city.maxLights, MAX_CLUSTERED_LIGHTS)
  assert.equal(city.maxLightsPerCluster, LIGHT_GRID.perCluster)
  assert.equal(city.zSlices, LIGHT_GRID.z)
  // three's own, for contrast: sized to the buffer, rebuilt when it changes.
  const theirs = new ClusteredLightsNode(MAX_CLUSTERED_LIGHTS, 32, LIGHT_GRID.z, LIGHT_GRID.perCluster)
  const t = theirs as unknown as Internals
  theirs.setSize(1920, 1080)
  const first = t._compute
  theirs.setSize(640, 360)
  assert.notEqual(t._compute, first, 'three\'s node rebuilds its pass for a new size (the reason the city has its own)')
})
