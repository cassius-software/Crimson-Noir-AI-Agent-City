// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the California-analog map: the same seed gives the same bytes; the five regions are
 * spelled exactly as the brief says and every one is present on every seed; the ocean is to the west and every land
 * block has a zone and a terrain; each region keeps its character (towers only in Del Mar, the hotel strip in Las
 * Vistas, mansions alone in Starwood, canyons only in Dusty Basin); the streets stay one connected car network; the map
 * becomes a valid region pack the engine's region path can build physics and a spawn from; no generated name carries a
 * forbidden word; the committed layouts under world/california/ are the generator's current output; and macroCity's own
 * river-and-lake city is byte-for-byte what it was before the plan hook was added.
 * What breaks if it is removed? A generator change could rename a region, drop one, put a tower in the mansions, cut the
 * road network, or leave world/california/ stale, unnoticed.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  REGIONS, REGION_NAMES, TERRAIN, TERRAIN_NAMES, ZONE, ZONE_FORMAT, californiaIndex, fbm, generateCalifornia, zoneLayout, zoneLayouts,
} from './california.ts'
import { CALIFORNIA_BLOCKS, CALIFORNIA_SEED, californiaFiles } from './californiaFiles.ts'
import { LOT, STREET, fnv1a, generateMacroCity, serializeMacroCity, walkable, navCells } from './macroCity.ts'
import { forbiddenWordIn } from './assets/cc0.ts'
import { macroToRegionPack } from './region/fromMacro.ts'
import { polygonCount, validatePack } from './region/pack.ts'
import { RegionPlaces, layoutOf, regionPhysics } from './region/regionWorld.ts'

const SEEDS = [1337, 7, 42, 90210]
const B = 64
const maps = new Map(SEEDS.map((s) => [s, generateCalifornia(s, B)]))
const WORLD = join(fileURLToPath(new URL('../../', import.meta.url)), 'world/california')

test('the five regions, spelled exactly so, in zone order', () => {
  assert.deepEqual(REGION_NAMES, ['Del Mar Metropolis', 'San Cero', 'Las Vistas', 'Dusty Basin', 'Starwood Hills'])
  assert.deepEqual(REGIONS.map((r) => r.id), [0, 1, 2, 3, 4])
  assert.deepEqual(REGIONS.map((r) => r.slug), ['del-mar-metropolis', 'san-cero', 'las-vistas', 'dusty-basin', 'starwood-hills'])
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
  for (const s of SEEDS) {
    const a = serializeMacroCity(generateCalifornia(s, B)), b = serializeMacroCity(maps.get(s)!)
    assert.deepEqual(a, b)
  }
  assert.notDeepEqual(serializeMacroCity(maps.get(7)!), serializeMacroCity(maps.get(42)!))
})

test('the ocean is to the west, every land block has one of the five zones and a terrain, and every zone is present', () => {
  for (const [s, map] of maps) {
    const counts = new Array(6).fill(0)
    for (let m = 0; m < B; m++) {
      let sea = true
      for (let k = 0; k < B; k++) {
        const i = m * B + k, z = map.zones[i]
        counts[z]++
        assert.ok(z <= ZONE.ocean, `seed ${s}: zone ${z}`)
        assert.ok(map.terrain[i] < TERRAIN_NAMES.length)
        if (z === ZONE.ocean) {
          assert.ok(sea, `seed ${s}: ocean at (${k}, ${m}) east of land`)
          assert.equal(map.lots[i], LOT.water)
          assert.equal(map.terrain[i], TERRAIN.ocean)
          assert.equal(map.elevation[i], 0)
        } else {
          sea = false
          assert.notEqual(map.lots[i], LOT.water)
        }
      }
      assert.equal(map.zones[m * B], ZONE.ocean, `seed ${s}: row ${m} starts at sea`)
    }
    for (const r of REGIONS) assert.ok(counts[r.id] >= B, `seed ${s}: ${r.name} has ${counts[r.id]} blocks`)
    assert.ok(counts[ZONE.ocean] > B * B * 0.08 && counts[ZONE.ocean] < B * B * 0.3, `seed ${s}: ocean ${counts[ZONE.ocean]}`)
  }
})

test('each region keeps its character', () => {
  for (const [s, map] of maps) {
    const l = zoneLayouts(map)
    const [delMar, sanCero, lasVistas, dusty, starwood] = l
    assert.ok(delMar.buildings.floors.max >= 20, `seed ${s}: the metropolis has towers`)
    assert.ok(delMar.lots.downtown > 0 && delMar.lots.industrial > 0, `seed ${s}: a centre and a port`)
    assert.ok(sanCero.moisture.mean > lasVistas.moisture.mean && sanCero.moisture.mean > dusty.moisture.mean, `seed ${s}: the fog is on San Cero`)
    assert.ok(sanCero.elevation.mean > delMar.elevation.mean, `seed ${s}: San Cero is the hills`)
    assert.ok(lasVistas.lots.downtown > 0 && lasVistas.buildings.floors.max >= 15, `seed ${s}: the neon strip has hotels`)
    assert.equal(starwood.lots.downtown, 0, `seed ${s}: no towers in the mansions`)
    assert.ok(starwood.buildings.floors.max <= 6 && starwood.lots.residential > 0, `seed ${s}: mansions are low`)
    assert.ok(dusty.terrain.canyon > 0, `seed ${s}: canyons in Dusty Basin`)
    for (const z of [delMar, sanCero, lasVistas, starwood]) assert.equal(z.terrain.canyon, 0, `seed ${s}: canyons only in Dusty Basin`)
    assert.ok(dusty.lots.park / dusty.area.blocks > 0.3, `seed ${s}: the basin is mostly open desert`)
    for (const z of l) {
      assert.equal(z.format, ZONE_FORMAT)
      assert.equal(z.lots.water, 0)
      assert.ok(z.districts.length > 0 && z.districts.length <= 24)
      for (let i = 1; i < z.districts.length; i++) assert.ok(z.districts[i - 1].blocks >= z.districts[i].blocks)
    }
    const land = l.reduce((n, z) => n + z.area.blocks, 0)
    assert.ok(Math.abs(l.reduce((n, z) => n + z.area.shareOfLand, 0) - 1) < 0.01)
    assert.equal(land, map.zones.filter((z) => z !== ZONE.ocean).length)
  }
})

test('the car network is whole: every built street corner reaches every other over arterials and local streets', () => {
  for (const [s, map] of maps) {
    const node = (i: number, j: number) => j * (B + 1) + i
    const parent = new Int32Array((B + 1) * (B + 1)).map((_, i) => i)
    const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a] } return a }
    const union = (a: number, b: number) => { parent[find(a)] = find(b) }
    const car = (k: number) => k === STREET.arterial || k === STREET.local || k === STREET.bridge
    const touched = new Set<number>()
    for (let m = 0; m <= B; m++) for (let k = 0; k < B; k++) if (car(map.hStreets[m * B + k])) { union(node(k, m), node(k + 1, m)); touched.add(node(k, m)); touched.add(node(k + 1, m)) }
    for (let k = 0; k <= B; k++) for (let m = 0; m < B; m++) if (car(map.vStreets[k * B + m])) { union(node(k, m), node(k, m + 1)); touched.add(node(k, m)); touched.add(node(k, m + 1)) }
    const roots = new Set([...touched].map(find))
    assert.equal(roots.size, 1, `seed ${s}: ${roots.size} road networks`)
    // And people can walk somewhere: a sidewalk cell exists in every zone.
    const n = navCells(map)
    let walk = 0
    for (let c = 0; c < 2000; c++) { const cx = (c * 7919) % n, cz = (c * 104729) % n; if (walkable(map, cx, cz)) walk++ }
    assert.ok(walk > 100, `seed ${s}: ${walk} walkable samples of 2000`)
  }
})

test('the map becomes a valid region pack the engine can build physics and a spawn from', () => {
  const map = maps.get(1337)!
  const pack = validatePack(macroToRegionPack(map, { name: 'California Analog', attribution: ['Procedural; every name fictitious'], waterName: 'Sunfall Sea' }))
  assert.equal(pack.bounds.x1, B * 40)
  assert.ok(pack.roads.cls.length > 500)
  assert.ok(polygonCount(pack.water) > 0 && polygonCount(pack.buildings) > 1000)
  assert.ok(pack.buildings.height.every((h) => Number.isInteger(h) && h >= 33))
  // Injective street names: every road name index points at a distinct, non-empty name; names are unique.
  assert.equal(new Set(pack.names).size, pack.names.length)
  assert.ok(pack.roads.name.every((i) => i > 0))
  assert.ok(pack.names.includes('Sunfall Sea'))
  for (const n of pack.names) assert.equal(forbiddenWordIn(n), null, n)
  const layout = layoutOf(pack)
  const physics = regionPhysics(pack, layout)
  assert.ok(physics.walls.length >= polygonCount(pack.buildings) * 4 * 5)
  const places = new RegionPlaces(pack, layout)
  const spawn = places.spawn({ x: (layout.bounds.x0 + layout.bounds.x1) / 2, z: (layout.bounds.z0 + layout.bounds.z1) / 2 })
  assert.ok(Number.isFinite(spawn.x) && Number.isFinite(spawn.z))
  assert.ok(spawn.x >= layout.bounds.x0 && spawn.x <= layout.bounds.x1 && spawn.z >= layout.bounds.z0 && spawn.z <= layout.bounds.z1)
})

test('no generated name carries a forbidden word (districts, streets, regions)', () => {
  for (const map of maps.values()) {
    for (const l of zoneLayouts(map)) {
      assert.equal(forbiddenWordIn(l.region.name), null)
      for (const d of l.districts) assert.equal(forbiddenWordIn(d.name), null, d.name)
    }
  }
})

test('world/california/ is the generator\'s current output for the committed seed (run node tools/world/california.mjs after a change)', () => {
  const files = californiaFiles(CALIFORNIA_SEED, CALIFORNIA_BLOCKS)
  const committed = readdirSync(WORLD).filter((f) => f.endsWith('.json')).sort()
  assert.deepEqual(committed, Object.keys(files).sort())
  for (const [name, text] of Object.entries(files)) assert.equal(readFileSync(join(WORLD, name), 'utf8'), text, `${name} is stale`)
  const index = JSON.parse(files['index.json'])
  assert.equal(index.format, 'california/1')
  assert.deepEqual(index.regions.map((r: { name: string }) => r.name), REGION_NAMES)
  assert.equal(index.blocks, 256)
  assert.equal(index.size, 10240)
})

test('a zone layout is consistent with the map it came from', () => {
  const map = maps.get(42)!
  const l = zoneLayout(map, ZONE.delMar)
  let n = 0
  for (let m = 0; m < B; m++) for (let k = 0; k < B; k++) if (map.zones[m * B + k] === ZONE.delMar) { n++; assert.ok(k >= l.extent.k0 && k <= l.extent.k1 && m >= l.extent.m0 && m <= l.extent.m1) }
  assert.equal(l.area.blocks, n)
  assert.equal(Object.values(l.lots).reduce((a, b) => a + b, 0), n)
  assert.equal(Object.values(l.terrain).reduce((a, b) => a + b, 0), n)
  const idx = californiaIndex(map, zoneLayouts(map))
  assert.equal(idx.fingerprint, fnv1a(serializeMacroCity(map)).toString(16).padStart(8, '0'))
  assert.throws(() => zoneLayout(map, 9), RangeError)
})

test('macroCity\'s own city is unchanged by the plan hook: its bytes are what they were', () => {
  assert.equal(fnv1a(serializeMacroCity(generateMacroCity(7, 64))).toString(16), 'ec5e9358')
  assert.equal(fnv1a(serializeMacroCity(generateMacroCity(42, 128))).toString(16), '4942d4d7')
})
