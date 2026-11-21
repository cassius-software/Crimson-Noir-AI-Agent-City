// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The region pack carries the map's quarters (pack.ts Quarters: the lakefront's five regions
 * by name, every block's region and ground, and the quarter the visitor chose), and everything that shares places out
 * among the quarters or names where the visitor stands reads it through region/quarters.ts. These tests hold the layer
 * to the generated map on three seeds and the five starts: it is the map's own zones and terrain as plain numbers, it
 * survives a clone and a file, it is the same for every start but its home, and a pack made without it is otherwise
 * the very same pack and still valid. They hold validatePack to refusing each way the layer can be malformed, the name
 * gate to reading the quarters' names, and the readers to the map: every block's centre, in engine metres, gives that
 * block's region and ground, a street line belongs to the block it opens, and off the map, over the lake and in a pack
 * without the layer there is no quarter.
 * What breaks if it is removed? A pack could name a quarter the map does not have there, a typed array could slip into
 * a document that is compared and cloned as plain numbers, or a reader could be a block off, and places would be shared
 * out among the wrong regions with nothing to say so.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRng } from '../../02_Define_The_Rules/degrees.ts'
import { screenNames } from '../assets/cc0.ts'
import { CITY } from '../city.ts'
import { REGION_NAMES, TERRAIN, ZONE, generateLakefront, type Zone } from '../lakefront.ts'
import { METRO, packOf, zoneCentre } from '../lakefrontPack.ts'
import { MACRO } from '../macroCity.ts'
import { macroToRegionPack } from './fromMacro.ts'
import { packNames, validatePack, type Quarters, type RegionPack } from './pack.ts'
import { quarterAt, quarterBlockAt, quarterName, terrainAt } from './quarters.ts'

// Vite's `?raw` import, for Node (crowdCompute.test.ts's hook): regionWorld.ts (the layout: where the pack sits in the
// engine's frame) imports a module that takes WGSL that way, so it is imported once the hook is in place.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { REGION_CORNER, layoutOf } = await import('./regionWorld.ts')

const P = CITY.pitch
const B = 64
const SEEDS = [1337, 7, 42]
const ZONES = (Object.entries(ZONE) as [string, Zone][]).filter(([name]) => name !== 'lake')
const MAPS = new Map(SEEDS.map((seed) => [seed, generateLakefront(seed, B)]))

test('the pack of a generated map carries its quarters: the five regions by name, every block\'s region and ground, the chosen quarter as home; plain numbers that survive a clone and a file; the same for every start but the home', () => {
  for (const [seed, map] of MAPS) {
    const layers: Quarters[] = []
    for (const [name, zone] of ZONES) {
      const at = `seed ${seed} ${name}`
      const pack = packOf(map, zone)
      const q = pack.quarters
      assert.ok(q, `${at}: the pack has the layer`)
      assert.deepEqual(q, { blocks: B, pitch: MACRO.pitch, names: [...REGION_NAMES], id: Array.from(map.zones), terrain: Array.from(map.terrain), home: zone }, at)
      // Plain arrays of the pack's own (never the map's typed arrays, never the frozen list of names).
      assert.ok(Array.isArray(q.id) && Array.isArray(q.terrain) && Array.isArray(q.names), `${at}: plain arrays`)
      assert.notEqual(q.names, REGION_NAMES)
      assert.ok(!Object.isFrozen(q.names))
      // The blocks tile the pack's bounds, and the pitch is the streets'.
      assert.deepEqual([pack.bounds.x1 - pack.bounds.x0, pack.bounds.z1 - pack.bounds.z0], [q.blocks * q.pitch, q.blocks * q.pitch], at)
      assert.equal(q.pitch, P)
      // Open water is the id past the names, exactly where the ground is the lake; every other block is one of the five.
      for (let i = 0; i < B * B; i++) {
        if ((q.id[i] >= q.names.length) !== (q.terrain[i] === TERRAIN.lake)) assert.fail(`${at}: block ${i} is quarter ${q.id[i]} on ground ${q.terrain[i]}`)
      }
      assert.ok(q.names.every((_, id) => q.id.includes(id)), `${at}: every quarter has blocks`)
      // It crosses a thread (structured clone) and a file (JSON) whole, and validates on the other side.
      assert.deepEqual(structuredClone(pack), pack, at)
      assert.deepEqual(validatePack(JSON.parse(JSON.stringify(pack))), pack, at)
      layers.push(q)
    }
    for (const q of layers) assert.deepEqual({ ...q, home: 0 }, { ...layers[0], home: 0 }, `seed ${seed}: one layer, whichever quarter is home`)
    assert.deepEqual(layers.map((q) => q.home), ZONES.map(([, zone]) => zone))
    // The lake is no quarter to start in: asked for it, the pack is still whole and valid, its home the metropolis.
    assert.equal(packOf(map, ZONE.lake).quarters?.home, ZONE.metropolis, `seed ${seed}: the lake`)
  }
})

test('the layer is optional: a pack made without it has no quarters at all, validates, and is otherwise the very same pack', () => {
  const map = MAPS.get(1337)!
  for (const [name, zone] of ZONES) {
    const without = macroToRegionPack(map, { name: METRO.name, attribution: METRO.attribution, waterName: METRO.lake, origin: zoneCentre(map, zone) })
    assert.ok(!('quarters' in without), `${name}: no key, not an empty one (packs are compared whole)`)
    assert.equal(validatePack(JSON.parse(JSON.stringify(without))).quarters, undefined)
    const { quarters, ...rest } = packOf(map, zone)
    assert.ok(quarters)
    assert.deepEqual(rest, without, `${name}: the layer is the only difference`)
    assert.deepEqual(packNames(without), [without.name, ...without.names, ...without.attribution])
  }
  // The layer must cover the map: a list of another length is refused where the pack is made.
  const o = { name: METRO.name, attribution: METRO.attribution }
  assert.throws(() => macroToRegionPack(map, { ...o, quarters: { names: REGION_NAMES, id: map.zones.subarray(1), terrain: map.terrain, home: 0 } }), RangeError)
  assert.throws(() => macroToRegionPack(map, { ...o, quarters: { names: REGION_NAMES, id: map.zones, terrain: [], home: 0 } }), RangeError)
  // What the pack's maker lets through, validatePack still judges: a home that is no quarter.
  assert.throws(() => validatePack(macroToRegionPack(map, { ...o, quarters: { names: REGION_NAMES, id: map.zones, terrain: map.terrain, home: ZONE.lake } })), /quarters\.home/)
})

test('validatePack: a malformed quarters layer is refused with the problem named', () => {
  const good = JSON.parse(JSON.stringify(packOf(MAPS.get(1337)!, ZONE.eastBluffs))) as RegionPack
  assert.equal(validatePack(structuredClone(good)).quarters!.home, ZONE.eastBluffs)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a layer being broken on purpose
  const bad = (f: (q: any, p: any) => void, re: RegExp) => {
    const p = structuredClone(good)
    f(p.quarters, p)
    assert.throws(() => validatePack(p), (err: unknown) => err instanceof TypeError && re.test(err.message), String(re))
  }
  bad((_, p) => { p.quarters = null }, /quarters is not a table/)
  bad((_, p) => { p.quarters = 7 }, /quarters is not a table/)
  for (const blocks of [0, -64, 2.5, '64', undefined]) bad((q) => { q.blocks = blocks }, /quarters\.blocks/)
  for (const pitch of [0, -40, NaN, Infinity, '40', undefined]) bad((q) => { q.pitch = pitch }, /quarters\.pitch/)
  for (const names of [[], ['Northside', ''], ['Northside', 7], 'Northside', undefined]) bad((q) => { q.names = names }, /quarters\.names/)
  for (const key of ['id', 'terrain']) {
    bad((q) => { q[key].pop() }, new RegExp(`quarters\\.${key} has the wrong length`))
    bad((q) => { q[key].push(0) }, new RegExp(`quarters\\.${key} has the wrong length`))
    bad((q) => { q[key][3] = 1.5 }, new RegExp(`quarters\\.${key} is not a list of whole numbers`))
    bad((q) => { q[key][3] = '1' }, new RegExp(`quarters\\.${key} is not a list of whole numbers`))
    bad((q) => { q[key][3] = -1 }, new RegExp(`quarters\\.${key} holds a negative code`))
    // Plain numbers only: a typed array is not what a pack carries.
    bad((q) => { q[key] = Uint8Array.from(q[key]) }, new RegExp(`quarters\\.${key} is not a list of whole numbers`))
    bad((q) => { delete q[key] }, new RegExp(`quarters\\.${key} is not a list of whole numbers`))
  }
  for (const home of [5, -1, 1.5, '0', undefined]) bad((q) => { q.home = home }, /quarters\.home/)
  // Fewer names move the line between a quarter and open water: the home must still be one of them.
  bad((q) => { q.names = q.names.slice(0, 2) }, /quarters\.home/)
  // Legal: any id past the names is open water, however large; a single quarter; a layer of one block.
  const ok = (f: (q: Quarters) => void) => { const p = structuredClone(good); f(p.quarters!); validatePack(p) }
  ok((q) => { q.id[0] = 250 })
  ok((q) => { q.names = ['Northside']; q.home = 0 })
  ok((q) => { q.blocks = 1; q.id = [0]; q.terrain = [2]; q.pitch = 2560 })
  ok((q) => { q.pitch = 12.5; q.home = 0 })
})

test('the name gate reads the quarters\' names with the rest, and packOf screens them', () => {
  const pack = packOf(MAPS.get(1337)!, ZONE.metropolis)
  const names = packNames(pack)
  assert.deepEqual(names, [pack.name, ...pack.names, ...pack.attribution, ...REGION_NAMES])
  assert.deepEqual(screenNames(names, 'region pack', () => {}), [], 'the five regions pass the gate')
  const lines: string[] = []
  const armed = { ...pack, quarters: { ...pack.quarters!, names: ['Lakefront Metropolis', 'Rifle Row', 'The East Bluffs', 'North Ridge', 'The Grand Ravine'] } }
  const purged = screenNames(packNames(armed), 'region pack', (line) => lines.push(line))
  assert.deepEqual(purged.map((p) => [p.asset, p.word]), [['Rifle Row', 'rifle']])
  assert.equal(lines.length, 1)
  // packOf hands the gate every name of the pack it made, the quarters' among them.
  const source = readFileSync(new URL('../lakefrontPack.ts', import.meta.url), 'utf8')
  assert.match(source, /const purged = screenNames\(packNames\(pack\), 'region pack', log\)/)
})

test('quarterAt, terrainAt and quarterName read the layer in engine metres: every block of the map, from a layout or its offset; a street line belongs to the block it opens; no quarter off the map, over the lake, or without the layer', () => {
  for (const [seed, map] of MAPS) {
    for (const [name, zone] of ZONES) {
      const at = `seed ${seed} ${name}`
      const pack = packOf(map, zone)
      const layout = layoutOf(pack)
      // Engine metres are the map's plus the region's corner, whichever quarter the pack starts in: map block (k, m) is
      // engine lot (k + 50, m + 50), and its centre names its region.
      assert.deepEqual([layout.bounds.x0, layout.bounds.z0], [REGION_CORNER.x, REGION_CORNER.z], at)
      for (let m = 0; m < B; m++) for (let k = 0; k < B; k++) {
        const i = m * B + k
        const x = (k + REGION_CORNER.x / P + 0.5) * P, z = (m + REGION_CORNER.z / P + 0.5) * P
        const want = map.zones[i] === ZONE.lake ? -1 : map.zones[i]
        if (quarterBlockAt(pack, layout, x, z) !== i || quarterAt(pack, layout, x, z) !== want || terrainAt(pack, layout, x, z) !== map.terrain[i]) {
          assert.fail(`${at}: block ${k}, ${m} reads block ${quarterBlockAt(pack, layout, x, z)}, quarter ${quarterAt(pack, layout, x, z)}, ground ${terrainAt(pack, layout, x, z)}; the map has ${i}, ${want}, ${map.terrain[i]}`)
        }
        // The offset alone says the same as the layout.
        if (quarterAt(pack, layout.offset, x, z) !== want || terrainAt(pack, layout.offset, x, z) !== map.terrain[i] || quarterBlockAt(pack, layout.offset, x, z) !== i) assert.fail(`${at}: block ${k}, ${m} from the offset`)
      }
      for (let id = 0; id < REGION_NAMES.length; id++) assert.equal(quarterName(pack, id), REGION_NAMES[id])
      assert.equal(quarterName(pack, pack.quarters!.home), REGION_NAMES[zone], `${at}: the home quarter by name`)
      for (const id of [-1, 5, 1.5, NaN, 250]) assert.equal(quarterName(pack, id), null, `${at}: no quarter ${id}`)
    }
  }
  const map = MAPS.get(1337)!
  const pack = packOf(map, ZONE.northRidge)
  const layout = layoutOf(pack)
  const b = layout.bounds
  // Anywhere at all (points on no lattice, a hair either side of street lines among them), the five packs of one map
  // say the same: an engine point is one place, whichever quarter the visitor chose.
  const homes = ZONES.map(([, zone]) => { const p = packOf(map, zone); return { p, l: layoutOf(p) } })
  const rng = createRng(20261114)
  for (let n = 0; n < 4000; n++) {
    const line = n % 4 === 0 ? Math.floor(rng() * 65) * P + (rng() - 0.5) * 1e-9 : 0
    const x = line ? b.x0 + line : b.x0 - 100 + rng() * 2760, z = b.z0 - 100 + rng() * 2760
    const read = homes.map(({ p, l }) => `${quarterBlockAt(p, l, x, z)} ${quarterAt(p, l, x, z)} ${terrainAt(p, l, x, z)}`)
    if (new Set(read).size !== 1) assert.fail(`at ${x}, ${z} the five packs read ${read.join(' | ')}`)
  }
  // The north edge is land on every column (lakefront.test.ts); the south edge is the lake.
  assert.notEqual(quarterAt(pack, layout, b.x0 + 20, b.z0 + 20), -1)
  assert.equal(quarterAt(pack, layout, b.x0 + 20, b.z1 - 20), -1, 'open water is no quarter')
  assert.equal(terrainAt(pack, layout, b.x0 + 20, b.z1 - 20), TERRAIN.lake, 'but it has a ground: the lake')
  assert.equal(quarterBlockAt(pack, layout, b.x0 + 20, b.z1 - 20), (B - 1) * B)
  // A street line belongs to the block it opens: the block east of it, south of it.
  assert.equal(quarterBlockAt(pack, layout, b.x0 + 7 * P, b.z0 + 3 * P), 3 * B + 7)
  assert.equal(quarterBlockAt(pack, layout, b.x0 + 7 * P - 0.001, b.z0 + 3 * P - 0.001), 2 * B + 6)
  assert.equal(quarterBlockAt(pack, layout, b.x0, b.z0), 0)
  // Off the map on every side (the far edges are outside), and nowhere at all.
  for (const [x, z] of [[b.x0 - 0.001, b.z0 + 20], [b.x0 + 20, b.z0 - 0.001], [b.x1, b.z0 + 20], [b.x0 + 20, b.z1], [b.x1 + 4000, b.z1 + 4000], [NaN, b.z0 + 20], [b.x0 + 20, NaN], [Infinity, -Infinity]]) {
    assert.deepEqual([quarterBlockAt(pack, layout, x, z), quarterAt(pack, layout, x, z), terrainAt(pack, layout, x, z)], [-1, -1, -1], `at ${x}, ${z}`)
  }
  // A pack without the layer has no quarter anywhere, and no name for one.
  const { quarters: _layer, ...rest } = pack
  const surveyed: RegionPack = rest
  assert.deepEqual([quarterBlockAt(surveyed, layout, b.x0 + 20, b.z0 + 20), quarterAt(surveyed, layout, b.x0 + 20, b.z0 + 20), terrainAt(surveyed, layout, b.x0 + 20, b.z0 + 20)], [-1, -1, -1])
  assert.equal(quarterName(surveyed, 0), null)
  // The layer's own blocks and the pack's own bounds are what is read (not the city's pitch, not the region's corner):
  // three blocks of 100 m from (-50, 20), two quarters and water, placed by an offset of its own.
  const small = {
    bounds: { x0: -50, z0: 20, x1: 250, z1: 320 },
    quarters: { blocks: 3, pitch: 100, names: ['Northside', 'Southside'], id: [0, 0, 2, 0, 1, 2, 1, 1, 9], terrain: [5, 2, 0, 2, 3, 0, 1, 1, 0], home: 1 },
  }
  const offset = { x: 1000, z: -500 }
  const read = (x: number, z: number) => [quarterBlockAt(small, offset, x, z), quarterAt(small, offset, x, z), terrainAt(small, offset, x, z)]
  assert.deepEqual(read(950, -480), [0, 0, 5], 'the first block\'s corner')
  assert.deepEqual(read(1049.9, -380.1), [0, 0, 5])
  assert.deepEqual(read(1050, -380), [4, 1, 3], 'the middle block')
  assert.deepEqual(read(1249.9, -180.1), [8, -1, 0], 'an id past the names is open water')
  assert.deepEqual(read(1160, -470), [2, -1, 0])
  assert.deepEqual(read(960, -200), [6, 1, 1])
  assert.deepEqual(read(949.9, -480), [-1, -1, -1])
  assert.deepEqual(read(1250, -480), [-1, -1, -1])
  assert.deepEqual(read(950, -180), [-1, -1, -1])
  assert.deepEqual([quarterAt(small, { offset }, 1050, -380), terrainAt(small, { offset }, 1050, -380)], [1, 3], 'a layout says the same as its offset')
  assert.deepEqual([quarterName(small, 0), quarterName(small, 1), quarterName(small, 2), quarterName(small, 9)], ['Northside', 'Southside', null, null])
})
