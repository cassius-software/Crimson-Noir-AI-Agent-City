// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the lakefront metropolis: the same seed gives the same bytes; the five regions and
 * the two landmarks are spelled exactly as the brief says and every region is present on every seed; the lake fills the
 * south and every land block has a zone and a terrain; the core stands against the water with The Spire on the
 * waterfront as the tallest building; the ravines cut the grid and are crossed only by bridges; the sprawl has its
 * transit hubs (Transit City in the West Sprawl) as nodes of skyscrapers in a grid of houses; the car network stays one
 * piece; the map becomes a valid region pack the engine's region path can build physics and a spawn from; no generated
 * name carries a forbidden word or a real name; the committed layouts under world/lakefront/ are the generator's current
 * output; and macroCity's own river-and-lake city is byte-for-byte what it was before the plan hook was added.
 * What breaks if it is removed? A generator change could rename a region, drop one, lose The Spire, let a local street
 * cross a ravine, cut the road network, or leave world/lakefront/ stale, unnoticed.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  LANDMARK, REGIONS, REGION_NAMES, TERRAIN, TERRAIN_NAMES, ZONE, ZONE_FORMAT, fbm, generateLakefront, lakefrontIndex, zoneLayout, zoneLayouts,
} from './lakefront.ts'
import { LAKEFRONT_BLOCKS, LAKEFRONT_SEED, lakefrontFiles } from './lakefrontFiles.ts'
import { LOT, STREET, fnv1a, generateMacroCity, serializeMacroCity, walkable, navCells } from './macroCity.ts'
import { forbiddenWordIn } from './assets/cc0.ts'
import { macroToRegionPack } from './region/fromMacro.ts'
import { polygonCount, validatePack } from './region/pack.ts'

// Vite's `?raw` import, for Node (crowdCompute.test.ts's hook): regionWorld.ts takes matrix mode (matrixMode.ts),
// which imports its WGSL that way, so it is imported once the hook is in place.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { RegionPlaces, layoutOf, regionPhysics } = await import('./region/regionWorld.ts')

const SEEDS = [1337, 7, 42, 90210]
const B = 64
const maps = new Map(SEEDS.map((s) => [s, generateLakefront(s, B)]))
const WORLD = join(fileURLToPath(new URL('../../', import.meta.url)), 'world/lakefront')
/** Real names of the city this map is an analog of: none may appear anywhere in it. */
const REAL = /\b(Toronto|Mississauga|Scarborough|North York|Don Valley|CN Tower|Etobicoke|Yonge|Bloor|Ontario|Humber|Rouge)\b/i

test('the five regions and the landmarks, spelled exactly so, in zone order', () => {
  assert.deepEqual(REGION_NAMES, ['Lakefront Metropolis', 'West Sprawl', 'The East Bluffs', 'North Ridge', 'The Grand Ravine'])
  assert.deepEqual(REGIONS.map((r) => r.id), [0, 1, 2, 3, 4])
  assert.deepEqual(REGIONS.map((r) => r.slug), ['lakefront-metropolis', 'west-sprawl', 'the-east-bluffs', 'north-ridge', 'the-grand-ravine'])
  assert.equal(LANDMARK.spire, 'The Spire')
  assert.equal(LANDMARK.transitCity, 'Transit City')
})

test('fBm is deterministic, in [0, 1), and smooth', () => {
  assert.equal(fbm(1, 3.3, 4.4, 16), fbm(1, 3.3, 4.4, 16))
  for (let i = 0; i < 200; i++) {
    const v = fbm(9, i * 0.37, i * 0.11, 12)
    assert.ok(v >= 0 && v < 1)
  }
  assert.ok(Math.abs(fbm(5, 10, 10, 16) - fbm(5, 10.01, 10, 16)) < 0.02)
})

test('the same seed gives the same map, byte for byte; another seed another map', () => {
  for (const s of SEEDS) assert.deepEqual(serializeMacroCity(generateLakefront(s, B)), serializeMacroCity(maps.get(s)!))
  assert.notDeepEqual(serializeMacroCity(maps.get(7)!), serializeMacroCity(maps.get(42)!))
})

test('the lake fills the south, every land block has one of the five zones and a terrain, and every zone is present', () => {
  for (const [s, map] of maps) {
    const counts = new Array(6).fill(0)
    for (let k = 0; k < B; k++) {
      let land = true
      for (let m = 0; m < B; m++) {
        const i = m * B + k, z = map.zones[i]
        counts[z]++
        assert.ok(z <= ZONE.lake, `seed ${s}: zone ${z}`)
        assert.ok(map.terrain[i] < TERRAIN_NAMES.length)
        if (z === ZONE.lake) {
          land = false
          assert.equal(map.lots[i], LOT.water)
          assert.equal(map.terrain[i], TERRAIN.lake)
          assert.equal(map.elevation[i], 0)
        } else {
          assert.ok(land, `seed ${s}: land at (${k}, ${m}) south of the lake`)
          assert.notEqual(map.lots[i], LOT.water)
        }
      }
      assert.equal(map.zones[(B - 1) * B + k], ZONE.lake, `seed ${s}: column ${k} ends in the lake`)
      assert.equal(map.zones[k], ZONE.lake === map.zones[k] ? ZONE.lake : map.zones[k])
      assert.notEqual(map.zones[k], ZONE.lake, `seed ${s}: the north edge is land`)
    }
    for (const r of REGIONS) assert.ok(counts[r.id] >= B, `seed ${s}: ${r.name} has ${counts[r.id]} blocks`)
    assert.ok(counts[ZONE.lake] > B * B * 0.2 && counts[ZONE.lake] < B * B * 0.4, `seed ${s}: lake ${counts[ZONE.lake]} blocks`)
  }
})

test('the core stands against the water with The Spire on the waterfront; the sprawl is houses with skyscraper hubs; the bluffs are east', () => {
  for (const [s, map] of maps) {
    const l = zoneLayouts(map)
    const [core, west, east, north, ravine] = l
    // The Spire: the tallest building on the map, in the core, on a land block whose south neighbour is the lake.
    const spire = core.landmarks.find((x) => x.kind === 'spire')
    assert.ok(spire && spire.name === LANDMARK.spire && spire.floors === 168, `seed ${s}: The Spire`)
    assert.equal(core.buildings.floors.max, 168)
    assert.equal(map.zones[map.spire.m * B + map.spire.k], ZONE.metropolis)
    assert.equal(map.zones[(map.spire.m + 1) * B + map.spire.k], ZONE.lake, `seed ${s}: The Spire on the waterfront`)
    for (const z of [west, east, north, ravine]) assert.ok(z.buildings.floors.max < 168)
    // The core is dense: towers of 24 floors and more, plazas, the port lands.
    assert.ok(core.lots.downtown > 20 && core.lots.plaza > 0 && core.lots.industrial > 0, `seed ${s}: the core`)
    // The sprawl: mostly houses, with hubs of skyscrapers; Transit City is in the West Sprawl.
    for (const z of [west, east, north]) {
      assert.ok(z.lots.residential > z.area.blocks * 0.5, `seed ${s}: ${z.region.name} is mostly houses`)
      assert.ok(z.landmarks.some((h) => h.kind === 'hub' && h.floors >= 14), `seed ${s}: ${z.region.name} has a skyscraper hub`)
    }
    assert.ok(west.landmarks.some((h) => h.name === LANDMARK.transitCity && h.floors >= 14), `seed ${s}: Transit City in the West Sprawl`)
    assert.equal(map.hubs[0].name, LANDMARK.transitCity)
    // The bluffs are the east shore; the ridge is in the north.
    assert.ok(east.terrain.bluff > 0 && west.terrain.bluff === 0 && north.terrain.bluff === 0, `seed ${s}: bluffs east`)
    assert.ok(north.terrain.ridge > west.terrain.ridge && north.elevation.mean > core.elevation.mean, `seed ${s}: the ridge north`)
    assert.ok(east.centroid.k > core.centroid.k && west.centroid.k < core.centroid.k && north.centroid.m < core.centroid.m, `seed ${s}: the compass`)
    // The Grand Ravine: ravine floor and the streets along it, no towers.
    assert.ok(ravine.terrain.ravine > ravine.area.blocks * 0.25 && ravine.lots.downtown === 0, `seed ${s}: the ravine`)
    for (const z of l) {
      assert.equal(z.format, ZONE_FORMAT)
      assert.equal(z.lots.water, 0)
      assert.ok(z.districts.length > 0 && z.districts.length <= 24)
    }
    assert.ok(Math.abs(l.reduce((n, z) => n + z.area.shareOfLand, 0) - 1) < 0.01)
  }
})

test('ravines are crossed by bridges only: no local street stands on a ravine block, and the car network is whole', () => {
  for (const [s, map] of maps) {
    const rav = (k: number, m: number) => k >= 0 && m >= 0 && k < B && m < B && map.terrain[m * B + k] === TERRAIN.ravine
    let bridges = 0
    for (let m = 0; m <= B; m++) for (let k = 0; k < B; k++) {
      const kind = map.hStreets[m * B + k]
      if (rav(k, m - 1) && rav(k, m)) { assert.ok(kind === STREET.none || kind === STREET.bridge, `seed ${s}: a ${kind} street over the ravine at h(${k}, ${m})`); if (kind === STREET.bridge) bridges++ }
    }
    for (let k = 0; k <= B; k++) for (let m = 0; m < B; m++) {
      const kind = map.vStreets[k * B + m]
      if (rav(k - 1, m) && rav(k, m)) { assert.ok(kind === STREET.none || kind === STREET.bridge, `seed ${s}: a ${kind} street along the ravine at v(${k}, ${m})`); if (kind === STREET.bridge) bridges++ }
    }
    assert.ok(bridges > 0, `seed ${s}: the arterials bridge the ravines`)
    const node = (i: number, j: number) => j * (B + 1) + i
    const parent = new Int32Array((B + 1) * (B + 1)).map((_, i) => i)
    const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a] } return a }
    const union = (a: number, b: number) => { parent[find(a)] = find(b) }
    const car = (k: number) => k === STREET.arterial || k === STREET.local || k === STREET.bridge
    const touched = new Set<number>()
    for (let m = 0; m <= B; m++) for (let k = 0; k < B; k++) if (car(map.hStreets[m * B + k])) { union(node(k, m), node(k + 1, m)); touched.add(node(k, m)); touched.add(node(k + 1, m)) }
    for (let k = 0; k <= B; k++) for (let m = 0; m < B; m++) if (car(map.vStreets[k * B + m])) { union(node(k, m), node(k, m + 1)); touched.add(node(k, m)); touched.add(node(k, m + 1)) }
    assert.equal(new Set([...touched].map(find)).size, 1, `seed ${s}: more than one road network`)
    const n = navCells(map)
    let walk = 0
    for (let c = 0; c < 2000; c++) { const cx = (c * 7919) % n, cz = (c * 104729) % n; if (walkable(map, cx, cz)) walk++ }
    assert.ok(walk > 100, `seed ${s}: ${walk} walkable samples of 2000`)
  }
})

test('the map becomes a valid region pack the engine can build physics and a spawn from', () => {
  const map = maps.get(1337)!
  const pack = validatePack(macroToRegionPack(map, { name: 'Lakefront Metro', attribution: ['Procedural; every name fictitious'], waterName: 'Lake Aurel' }))
  assert.equal(pack.bounds.x1, B * 40)
  assert.ok(pack.roads.cls.length > 500)
  assert.ok(polygonCount(pack.water) > 0 && polygonCount(pack.buildings) > 1000)
  assert.ok(pack.buildings.height.every((h) => Number.isInteger(h) && h >= 33))
  assert.equal(Math.max(...pack.buildings.height), 168 * 33, 'The Spire is 554 m')
  assert.equal(new Set(pack.names).size, pack.names.length)
  assert.ok(pack.roads.name.every((i) => i > 0))
  assert.ok(pack.names.includes('Lake Aurel'))
  for (const n of pack.names) { assert.equal(forbiddenWordIn(n), null, n); assert.doesNotMatch(n, REAL) }
  const layout = layoutOf(pack)
  const physics = regionPhysics(pack, layout)
  assert.ok(physics.walls.length >= polygonCount(pack.buildings) * 4 * 5)
  const places = new RegionPlaces(pack, layout)
  const spawn = places.spawn({ x: (layout.bounds.x0 + layout.bounds.x1) / 2, z: (layout.bounds.z0 + layout.bounds.z1) / 2 })
  assert.ok(Number.isFinite(spawn.x) && Number.isFinite(spawn.z))
  assert.ok(spawn.x >= layout.bounds.x0 && spawn.x <= layout.bounds.x1 && spawn.z >= layout.bounds.z0 && spawn.z <= layout.bounds.z1)
})

test('no generated name carries a forbidden word or a real name (districts, hubs, regions)', () => {
  for (const map of maps.values()) {
    for (const l of zoneLayouts(map)) {
      for (const n of [l.region.name, ...l.districts.map((d) => d.name), ...l.landmarks.map((x) => x.name)]) {
        assert.equal(forbiddenWordIn(n), null, n)
        assert.doesNotMatch(n, REAL)
      }
    }
  }
})

test('world/lakefront/ is the generator\'s current output for the committed seed (run node tools/world/lakefront.mjs after a change)', () => {
  const files = lakefrontFiles(LAKEFRONT_SEED, LAKEFRONT_BLOCKS)
  const committed = readdirSync(WORLD).filter((f) => f.endsWith('.json')).sort()
  assert.deepEqual(committed, Object.keys(files).sort())
  for (const [name, text] of Object.entries(files)) assert.equal(readFileSync(join(WORLD, name), 'utf8'), text, `${name} is stale`)
  const index = JSON.parse(files['index.json'])
  assert.equal(index.format, 'lakefront/1')
  assert.deepEqual(index.regions.map((r: { name: string }) => r.name), REGION_NAMES)
  assert.equal(index.blocks, 256)
  assert.equal(index.size, 10240)
  assert.equal(index.spire.name, LANDMARK.spire)
  assert.equal(index.spire.heightMetres, 554.4)
  assert.equal(index.hubs[0].name, LANDMARK.transitCity)
  assert.equal(index.hubs[0].region, 'West Sprawl')
  assert.doesNotMatch(JSON.stringify(files), REAL)
})

test('a zone layout is consistent with the map it came from', () => {
  const map = maps.get(42)!
  const l = zoneLayout(map, ZONE.metropolis)
  let n = 0
  for (let m = 0; m < B; m++) for (let k = 0; k < B; k++) if (map.zones[m * B + k] === ZONE.metropolis) { n++; assert.ok(k >= l.extent.k0 && k <= l.extent.k1 && m >= l.extent.m0 && m <= l.extent.m1) }
  assert.equal(l.area.blocks, n)
  assert.equal(Object.values(l.lots).reduce((a, b) => a + b, 0), n)
  assert.equal(Object.values(l.terrain).reduce((a, b) => a + b, 0), n)
  const idx = lakefrontIndex(map, zoneLayouts(map))
  assert.equal(idx.fingerprint, fnv1a(serializeMacroCity(map)).toString(16).padStart(8, '0'))
  assert.equal(idx.land.blocks + idx.lake.blocks, B * B)
  assert.throws(() => zoneLayout(map, 9), RangeError)
})

test('macroCity\'s own city is unchanged by the plan hook: its bytes are what they were', () => {
  assert.equal(fnv1a(serializeMacroCity(generateMacroCity(7, 64))).toString(16), 'ec5e9358')
  assert.equal(fnv1a(serializeMacroCity(generateMacroCity(42, 128))).toString(16), '4942d4d7')
})
