// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? A generated region's lamps, trees and signal poles stood along its 640 m street window
 * alone; the page now draws its whole map's (about 46,000 props on Lakefront Metro) in 160 m tiles shown by distance
 * (propTiles.ts, world.ts). These tests hold:
 * - tileFurniture: every prop in exactly one tile, the one it stands in (the edge tile for one off the map, the first
 *   for one whose place is not a number), each tile's props one run of the lists, in the order the furniture gave them;
 * - tilesWithin: every prop within reach of a focus stands in a tile it returns, and every tile it returns has ground
 *   within reach; nothing for a focus that is not a number or a reach of 0;
 * - the window's lamps and trees are the map's there: the same place, the same yaw, the same size (streets.ts
 *   treeScale), so the window and the map never draw a tree two sizes;
 * - on Lakefront Metro, the cost of every tier's reach (governor.ts propReach) wherever the visitor stands: Lite's
 *   reach holds at most nine tiles and fewer props than the window drew before, and each tier up holds more;
 * - propKeep, the fold's smoothstep: whole inside the reach's last PROP_FOLD metres, nothing at the reach;
 * - the world: a generated region's meshes are the map's tiles, hidden until the first update, then shown by the reach
 *   round the focus and round each camera that follows; a tier step glides the reach (REACH_GLIDE metres a second of
 *   the realm's clock, a step counting at most REACH_STEP_MAX seconds) with nothing rebuilt; each tile's instances are
 *   its run's props; the sensors are the window's; a dissolve mark re-uploads only the tiles it touches; a lit lamp's
 *   real light is dimmed by propKeep round the view being drawn; the painted pools are the window's lamps', none cut
 *   at the picture's edge, and fade by the props' focus and reach; a surveyed region with no window draws no prop; the
 *   city's furniture is its three meshes as ever, always drawn and never folded.
 * What breaks if it is removed? A prop could be drawn twice or not at all, a tile or a tier's band of props could pop
 * up in plain view, a lamp's light could shine where no pole stands, the trees of the window could change size at its
 * edge, and a phone could be handed the whole map's furniture.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Matrix4, PMREMGenerator, PerspectiveCamera, PointLight, Vector2, Vector3, WebGPURenderer, type DataTexture, type InstancedBufferAttribute, type InstancedBufferGeometry, type InstancedMesh, type Mesh } from 'three/webgpu'
import { CITY, type Furniture } from '../city.ts'
import { LAMP, lampHead } from '../cityLights.ts'
import { ZONE, generateLakefront } from '../lakefront.ts'
import { packOf } from '../lakefrontPack.ts'
import { LITE, PEAK, TIERS } from '../../05_Observe_Environment/governor.ts'
import { regionPlacement } from './placement.ts'
import { PROP_FOLD, TILE, TILE_BLOCKS, propKeep, tileDistance2, tileFurniture, tileWithin, tilesWithin, type TiledFurniture } from './propTiles.ts'
import { SEG, WINDOW_GEOMETRY, mapStreetGrid, streetGridOf, treeScale, windowFurniture, windowOf, type StreetGrid } from './streets.ts'

// Vite's `?raw` import, for Node (shadowShaders.test.ts's hook): world.ts and regionWorld.ts reach WGSL that way.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { LITE_WORLD, REACH_GLIDE, REACH_STEP_MAX, buildWorld } = await import('../world.ts')
const { RegionPlaces, layoutOf, regionStart } = await import('./regionWorld.ts')

const P = CITY.pitch
const KINDS = ['lamps', 'trees', 'signals'] as const

/** A made-up whole map, every street walked and driven: `blocks` across, its corner at (originX, originZ). */
function wholeMap(blocks: number, originX = 720, originZ = 720): StreetGrid {
  const all = SEG.walk | SEG.drive
  return { originX, originZ, blocks, ...WINDOW_GEOMETRY, h: new Uint8Array((blocks + 1) * blocks).fill(all), v: new Uint8Array((blocks + 1) * blocks).fill(all) }
}

/** Each prop as a string, for multiset comparisons. */
const keys = (list: readonly (readonly number[])[]): string[] => list.map((e) => e.join(',')).sort()

/** Which tile a place is in, by its rectangle (half-open), or -1. */
const tileOf = (t: TiledFurniture, x: number, z: number): number => t.tiles.findIndex((r) => x >= r.x0 && x < r.x1 && z >= r.z0 && z < r.z1)

test('tileFurniture: every prop once, in the tile it stands in, each tile one run of each list in the furniture\'s order', () => {
  // A map that is not a whole number of tiles (18 blocks: five tiles a side, the last half a tile of streets).
  const g = wholeMap(18)
  const f = windowFurniture(g, 9)
  const t = tileFurniture(f, g)
  assert.equal(t.across, Math.ceil(18 / TILE_BLOCKS))
  assert.equal(t.tiles.length, t.across * t.across)
  assert.equal(TILE, 160)
  assert.deepEqual([t.originX, t.originZ], [g.originX, g.originZ])
  for (const kind of KINDS) {
    assert.deepEqual(keys(t.furniture[kind]), keys(f[kind]), `${kind}: the same props, each once`)
    let next = 0
    t.tiles.forEach((r, n) => {
      const [start, end] = r[kind]
      assert.equal(start, next, `${kind}: tile ${n}'s run starts where the last ended`)
      next = end
      for (let i = start; i < end; i++) {
        const [x, z] = t.furniture[kind][i]
        const home = tileOf(t, x, z)
        // A prop on the map's outer kerb stands a few metres outside the last tile: it is the edge tile's.
        const edge = home < 0 && (x < r.x0 ? r.i === 0 : x >= r.x1 ? r.i === t.across - 1 : true) && (z < r.z0 ? r.j === 0 : z >= r.z1 ? r.j === t.across - 1 : true)
        assert.ok(home === n || edge, `${kind} ${i} at (${x}, ${z}) is in tile ${n}`)
      }
      // The furniture's own order within a tile (a stable sort).
      const list: readonly (readonly number[])[] = f[kind]
      const order = t.furniture[kind].slice(start, end).map((e) => list.indexOf(e))
      for (let k = 1; k < order.length; k++) assert.ok(order[k] > order[k - 1], `${kind}: tile ${n} keeps the furniture's order`)
    })
    assert.equal(next, f[kind].length, `${kind}: the runs cover the list`)
  }
  // Each tile's bounds are its square, grown outward on the map's edge alone, over the kerb's props (signals 4.6 m past the line).
  const far = t.across - 1
  for (const r of t.tiles) {
    const x0 = g.originX + r.i * TILE, z0 = g.originZ + r.j * TILE
    const grow = [x0 - r.x0, z0 - r.z0, r.x1 - (x0 + TILE), r.z1 - (z0 + TILE)]
    const edge = [r.i === 0, r.j === 0, r.i === far, r.j === far]
    grow.forEach((d, k) => assert.ok(edge[k] ? d >= 0 && d <= 5 : d === 0, `tile ${r.i},${r.j} side ${k}: grown ${d} m`))
  }
  assert.ok(t.tiles.some((r) => r.x0 < g.originX), 'the west edge grows over its kerb')
  assert.ok(Object.isFrozen(t.tiles) && t.tiles.every((r) => Object.isFrozen(r)))
})

test('tileFurniture: a place off the map is the edge tile\'s, one that is not a number the first\'s; no furniture gives empty runs', () => {
  const g = { originX: 0, originZ: 0, blocks: 8 }
  const f: Furniture = { lamps: [[-500, 10, 0], [10, 9000, 0], [Number.NaN, 10, 0], [200, 200, 0]], trees: [], signals: [] }
  const t = tileFurniture(f, g)
  assert.equal(t.across, 2)
  const where = (e: readonly number[]) => t.tiles.findIndex((r) => {
    const i = t.furniture.lamps.indexOf(e as [number, number, number])
    return i >= r.lamps[0] && i < r.lamps[1]
  })
  assert.equal(where(f.lamps[0]), 0, 'west of the map: the west edge tile of its row')
  assert.equal(where(f.lamps[1]), 2, 'south of the map: the south edge tile of its column')
  assert.equal(where(f.lamps[2]), 0, 'not a number: the first tile')
  assert.equal(where(f.lamps[3]), 3)
  const empty = tileFurniture({ lamps: [], trees: [], signals: [] }, g)
  assert.ok(empty.tiles.every((r) => KINDS.every((k) => r[k][0] === 0 && r[k][1] === 0)))
})

test('tilesWithin: every prop within reach stands in a tile it returns, and every tile it returns has ground within reach', () => {
  const g = wholeMap(24)
  const t = tileFurniture(windowFurniture(g, 3), g)
  const all = KINDS.flatMap((kind) => t.tiles.flatMap((r, n) => t.furniture[kind].slice(r[kind][0], r[kind][1]).map((e) => ({ x: e[0], z: e[1], n }))))
  let seed = 99
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  const span = g.blocks * P
  for (let k = 0; k < 40; k++) {
    const x = g.originX - 200 + next() * (span + 400), z = g.originZ - 200 + next() * (span + 400)
    for (const reach of [LITE.propReach, TIERS[2].propReach, PEAK.propReach]) {
      const shown = new Set(tilesWithin(t, x, z, reach))
      for (const p of all) if ((p.x - x) ** 2 + (p.z - z) ** 2 < reach * reach) assert.ok(shown.has(p.n), `(${x}, ${z}) reach ${reach}: a prop within it is in a shown tile`)
      for (const n of shown) assert.ok(tileDistance2(t.tiles[n], x, z) < reach * reach)
      for (let n = 0; n < t.tiles.length; n++) if (!shown.has(n)) assert.ok(tileDistance2(t.tiles[n], x, z) >= reach * reach)
    }
  }
  assert.deepEqual(tilesWithin(t, Number.NaN, 2000, 300), [])
  assert.deepEqual(tilesWithin(t, 2000, Number.POSITIVE_INFINITY, 300), [])
  assert.deepEqual(tilesWithin(t, 2000, 2000, 0), [])
  assert.deepEqual(tilesWithin(t, 2000, 2000, Number.NaN), [])
  assert.equal(tileWithin(t.tiles[0], t.tiles[0].x0 + 1, t.tiles[0].z0 + 1, 1e-3), true, 'a focus inside a tile needs it')
})

test('the window\'s lamps and trees are the map\'s there: the same places, yaws and sizes, so no tree changes size at the window\'s edge', () => {
  const g = wholeMap(32)
  const map = windowFurniture(g, 1337)
  const lamps = new Set(map.lamps.map((e) => e.join(',')))
  const trees = new Map(map.trees.map((e) => [`${e[0]},${e[1]}`, e[2]]))
  const signals = new Set(map.signals.map((e) => e.join(',')))
  for (const [k0, m0] of [[0, 0], [7, 11], [16, 16]]) {
    const w = windowFurniture(windowOf(g, k0, m0), 1337)
    for (const e of w.lamps) assert.ok(lamps.has(e.join(',')), `window (${k0}, ${m0}): its lamp at (${e[0]}, ${e[1]}) is the map's`)
    for (const e of w.trees) assert.equal(trees.get(`${e[0]},${e[1]}`), e[2], `window (${k0}, ${m0}): its tree at (${e[0]}, ${e[1]}) is the map's, the same size`)
    // A crossing on the window's own edge counts only the arms the window holds, so the map may have a signal the window has not; never the reverse.
    for (const e of w.signals) assert.ok(signals.has(e.join(',')), `window (${k0}, ${m0}): its signal at (${e[0]}, ${e[1]}) is the map's`)
  }
  for (const [x, z] of [[0, 0], [123.4, -56.7], [1e5, 3]]) {
    const s = treeScale(1337, x, z)
    assert.ok(s >= 0.85 && s < 1.2, `a tree's size ${s}`)
    assert.equal(treeScale(1337, x, z), s, 'the same place, the same size')
  }
  const sizes = map.trees.map((e) => e[2])
  assert.ok(new Set(sizes.map((v) => v.toFixed(3))).size > 300, 'the sizes vary from tree to tree, over the whole range')
  const mean = sizes.reduce((a, v) => a + v, 0) / sizes.length
  assert.ok(Math.abs(mean - 1.025) < 0.01, `evenly spread: a mean size of ${mean.toFixed(3)}`)
  assert.notEqual(treeScale(1, 100, 100), treeScale(2, 100, 100), 'and with the seed')
})

/** Lakefront Metro's metropolis: its whole map's furniture in tiles, and its street window's prop count round its middle. */
function metropolis(seed: number) {
  const pack = packOf(generateLakefront(seed, 64), ZONE.metropolis)
  const layout = layoutOf(pack)
  const g = mapStreetGrid(pack, layout.offset)
  assert.ok(g, 'the metropolis has a grid')
  const tiled = tileFurniture(windowFurniture(g, seed), g)
  // The window the page drew before (round the region's start), and its props: what every tier is measured against.
  const start = regionStart(pack, layout, new RegionPlaces(pack, layout), regionPlacement(pack, layout, seed)!)
  const w = windowFurniture(streetGridOf(pack, layout.offset, start)!, seed)
  return { pack, layout, g, tiled, start, window: w.lamps.length + w.trees.length + w.signals.length }
}

test('Lakefront Metro: wherever the visitor stands, Lite\'s reach holds at most nine tiles and fewer props than the start\'s window drew; each tier up holds more', () => {
  for (const seed of [1337, 7, 42]) {
    const { g, tiled, window } = metropolis(seed)
    const count = (r: (typeof tiled.tiles)[number]) => KINDS.reduce((a, k) => a + r[k][1] - r[k][0], 0)
    const total = tiled.tiles.reduce((a, r) => a + count(r), 0)
    assert.ok(total > 10 * window, `seed ${seed}: the map has ${total} props, the window ${window}`)
    // The worst place for each tier: every 40 m over the map and a tile beyond it.
    const worst = (reach: number) => {
      let tiles = 0, props = 0
      for (let z = g.originZ - TILE; z <= g.originZ + g.blocks * P + TILE; z += 40) {
        for (let x = g.originX - TILE; x <= g.originX + g.blocks * P + TILE; x += 40) {
          const shown = tilesWithin(tiled, x + 20, z + 20, reach)
          tiles = Math.max(tiles, shown.length)
          props = Math.max(props, shown.reduce((a, n) => a + count(tiled.tiles[n]), 0))
        }
      }
      return { tiles, props }
    }
    const lite = worst(LITE.propReach)
    assert.ok(lite.tiles <= 9, `seed ${seed}: Lite shows at most nine tiles (${lite.tiles}), 27 meshes before the camera culls`)
    assert.ok(lite.props < 0.9 * window, `seed ${seed}: Lite holds ${lite.props} props in reach at the worst place on the map, where the start's window drew ${window} everywhere`)
    let last = lite
    for (const k of [...TIERS, PEAK]) {
      const w = worst(k.propReach)
      assert.ok(w.props >= last.props, `seed ${seed}: ${k.label} holds no fewer props than the tier below`)
      last = w
    }
    // Peak, the most: a few windows' worth in reach, of which the camera's frustum draws about a third.
    assert.ok(last.props < 5 * window, `seed ${seed}: Peak holds ${last.props} props in reach (${(last.props / window).toFixed(2)} windows)`)
    assert.ok(PEAK.propReach - PROP_FOLD > LITE.propReach, 'Peak stands its props whole past the end of Lite\'s')
  }
})

/**
 * A WebGPURenderer never initialised (shadowShaders.test.ts's): enough to build the world's scene, no device asked for.
 * The environment probe's bake (world.ts update) needs a device, so it lands in a stand-in target here.
 */
function offlineRenderer(): WebGPURenderer {
  PMREMGenerator.prototype.fromScene = function (_s: unknown, _sigma?: number, _near?: number, _far?: number, o?: { renderTarget?: unknown }) {
    return (o?.renderTarget ?? { texture: {} }) as ReturnType<PMREMGenerator['fromScene']>
  } as PMREMGenerator['fromScene']
  const canvas = { style: {}, width: 1, height: 1, addEventListener() {}, removeEventListener() {}, getContext: () => null }
  const renderer = new WebGPURenderer({ canvas: canvas as unknown as HTMLCanvasElement, reversedDepthBuffer: true })
  Object.assign(renderer, { initTexture: () => {}, hasFeature: () => false })
  return renderer
}

const NAMES = { lamps: 'StreetLamps', trees: 'StreetTrees', signals: 'TrafficSignals' } as const

test('the world: a region\'s furniture is its map\'s, in tiles hidden until the first update, then shown by reach round the focus and each camera that follows', () => {
  const seed = 1337
  const { pack, layout, g, tiled } = metropolis(seed)
  const placed = regionPlacement(pack, layout, seed)!
  const start = regionStart(pack, layout, new RegionPlaces(pack, layout), placed)
  const streets = streetGridOf(pack, layout.offset, start)!
  const world = buildWorld(offlineRenderer(), seed, { pack, layout, streets, map: g })
  // The furniture is the map's, in tile order; the sensors the window's, as the furniture was before. The edge tiles'
  // bounds take in the props on the map's outer kerb.
  assert.ok(tiled.tiles.some((r) => r.x1 - r.x0 > TILE || r.z1 - r.z0 > TILE), 'an edge tile grows over its kerb')
  for (const kind of KINDS) assert.deepEqual(world.furniture[kind], tiled.furniture[kind], `${kind}: the map's, tile by tile`)
  assert.deepEqual(world.sensors, windowFurniture(streets, seed))
  const meshes = new Map<string, Mesh>()
  for (const o of world.scene.children) if (/^(StreetLamps|StreetTrees|TrafficSignals) \d+,\d+$/.test(o.name)) meshes.set(o.name, o as Mesh)
  const expected = tiled.tiles.flatMap((r) => KINDS.filter((k) => r[k][1] > r[k][0]).map((k) => `${NAMES[k]} ${r.i},${r.j}`))
  assert.deepEqual([...meshes.keys()].sort(), expected.sort(), 'one mesh of each kind for every tile that has some')
  assert.ok(![...meshes.values()].some((m) => m.visible), 'nothing shown before the first update')
  // Each mesh is a plain mesh (one shader for every tile of a kind: three builds an InstancedMesh's for each mesh) over
  // instanced geometry: its instances are its run's props, each placed at its foot, with its yaw and its size (a tree's
  // yaw from its size, as the city's), all inside the mesh's bounding sphere.
  for (const r of tiled.tiles) {
    for (const kind of KINDS) {
      const m = meshes.get(`${NAMES[kind]} ${r.i},${r.j}`)
      if (!m) continue
      assert.ok(!(m as Mesh & { isInstancedMesh?: boolean }).isInstancedMesh, `${m.name}: a plain mesh`)
      const g = m.geometry as InstancedBufferGeometry
      assert.ok(g.isInstancedBufferGeometry)
      const [start0, end] = r[kind]
      assert.equal(g.instanceCount, end - start0)
      const place = g.getAttribute('place') as InstancedBufferAttribute
      assert.equal(place.count, end - start0)
      const sphere = g.boundingSphere!
      for (let i = 0; i < place.count; i++) {
        const e = tiled.furniture[kind][start0 + i]
        const tree = kind === 'trees'
        assert.deepEqual([place.getX(i), place.getY(i), place.getZ(i), place.getW(i)], [e[0], e[1], tree ? e[2] * 7.3 : e[2], tree ? e[2] : 1].map(Math.fround), `${m.name} instance ${i}'s place`)
        assert.ok(sphere.containsPoint(new Vector3(e[0], 3, e[1])), `${m.name} instance ${i} inside the mesh's sphere`)
      }
      assert.ok(sphere.radius < TILE, `${m.name}: a sphere about its tile (${sphere.radius.toFixed(0)} m)`)
      assert.ok(m.castShadow && m.receiveShadow && m.frustumCulled, `${m.name}: casts, receives and is culled by the camera as one`)
      assert.ok(!m.matrixAutoUpdate && !m.matrixWorldAutoUpdate && m.matrixWorld.equals(new Matrix4()), `${m.name}: at the origin for good, never recomposed`)
    }
  }
  const lamps = [...meshes.values()].filter((m) => m.name.startsWith('StreetLamps'))
  assert.equal(new Set(lamps.map((m) => m.material)).size, 1, 'one lamp material for every tile')
  assert.equal(new Set(lamps.map((m) => m.geometry.getAttribute('position'))).size, 1, 'one lamp shape, uploaded once')

  const shown = () => new Set([...meshes.values()].filter((m) => m.visible).map((m) => m.name.split(' ')[1]))
  const want = (x: number, z: number, reach: number) => new Set(tilesWithin(tiled, x, z, reach).filter((n) => KINDS.some((k) => tiled.tiles[n][k][1] > tiled.tiles[n][k][0])).map((n) => `${tiled.tiles[n].i},${tiled.tiles[n].j}`))
  world.setPropReach(LITE.propReach)
  assert.equal(shown().size, 0, 'a reach before any focus shows nothing')
  world.update(21, 0, start.x, start.z)
  assert.deepEqual(shown(), want(start.x, start.z, LITE.propReach), 'Lite: the tiles round the start, the first reach taken at once')
  assert.ok(shown().size >= 1 && shown().size <= 9)
  // A tier step glides the drawn reach on the realm's clock (the update's seconds): nothing changes at once, then
  // REACH_GLIDE metres a second, a step counting at most REACH_STEP_MAX seconds, so the band between the two reaches
  // grows out of the street (every step's tiles hold only folded props at the new edge). Nothing is rebuilt.
  let t = 0, reach = LITE.propReach, target = PEAK.propReach
  const tick = (dt: number) => {
    t += dt
    reach += Math.sign(target - reach) * Math.min(Math.abs(target - reach), REACH_GLIDE * Math.min(dt, REACH_STEP_MAX))
    world.update(21, t, start.x, start.z)
  }
  world.setPropReach(PEAK.propReach)
  assert.deepEqual(shown(), want(start.x, start.z, LITE.propReach), 'a tier step shows nothing more at once')
  world.update(21, t, start.x, start.z)
  assert.deepEqual(shown(), want(start.x, start.z, LITE.propReach), 'nor while the realm\'s clock stands still')
  tick(0.125)
  assert.equal(reach, LITE.propReach + REACH_GLIDE / 8)
  assert.deepEqual(shown(), want(start.x, start.z, reach), 'an eighth of a second: an eighth of REACH_GLIDE further')
  assert.notDeepEqual(want(start.x, start.z, reach), want(start.x, start.z, PEAK.propReach), '(not yet Peak\'s tiles)')
  tick(30)
  assert.equal(reach, LITE.propReach + REACH_GLIDE * (1 / 8 + REACH_STEP_MAX))
  assert.deepEqual(shown(), want(start.x, start.z, reach), 'a hitch of thirty seconds glides one capped step, not to Peak at once')
  assert.notDeepEqual(want(start.x, start.z, reach), want(start.x, start.z, PEAK.propReach))
  const seen = new Set<string>()
  while (reach < PEAK.propReach) {
    tick(0.25)
    assert.deepEqual(shown(), want(start.x, start.z, reach), `the tiles of a ${reach} m reach`)
    seen.add([...shown()].sort().join(' '))
  }
  assert.ok(seen.size > 3, `the band came in over ${seen.size} sets of tiles, not at once`)
  assert.deepEqual(shown(), want(start.x, start.z, PEAK.propReach), 'Peak\'s tiles round the same focus, nothing rebuilt')
  assert.equal(world.scene.children.filter((o) => meshes.has(o.name)).length, meshes.size)
  // Another viewport's head, a kilometre off: its own tiles while it draws; the next update brings back player 1's.
  const cam = new PerspectiveCamera()
  cam.position.set(start.x + 1000, 1.7, start.z - 600)
  world.follow(cam)
  assert.deepEqual(shown(), want(cam.position.x, cam.position.z, PEAK.propReach), 'the tiles round the other head')
  world.update(21, t, start.x, start.z)
  assert.deepEqual(shown(), want(start.x, start.z, PEAK.propReach))
  // Down again: the band folds back the same way, tile by tile.
  target = LITE.propReach
  world.setPropReach(LITE.propReach)
  while (reach > LITE.propReach) {
    tick(0.25)
    assert.deepEqual(shown(), want(start.x, start.z, reach), `back down: the tiles of a ${reach} m reach`)
  }
  // A reach that is not a number is none: the props fold away, and with nothing drawn the next reach is taken at once.
  target = 0
  world.setPropReach(Number.NaN)
  while (reach > 0) tick(0.25)
  assert.equal(shown().size, 0, 'a reach that is not a number shows nothing, once folded away')
  world.setPropReach(TIERS[3].propReach)
  assert.deepEqual(shown(), want(start.x, start.z, TIERS[3].propReach), 'nothing drawn: the next reach at once')
  world.update(21, t, Number.NaN, start.z)
  assert.equal(shown().size, 0, 'a focus that is not a number needs no tile')
})

test('propKeep: whole inside the reach\'s last PROP_FOLD metres, folded at the reach, the smoothstep between; not a number folds', () => {
  assert.equal(propKeep(0, 160), 1)
  assert.equal(propKeep(160 - PROP_FOLD, 160), 1)
  assert.equal(propKeep(160 - PROP_FOLD / 2, 160), 0.5)
  assert.equal(propKeep(160, 160), 0)
  assert.equal(propKeep(1e6, 160), 0)
  assert.equal(propKeep(30, 0), 0, 'no reach: nothing stands')
  let last = 1
  for (let d = 100; d <= 170; d += 0.5) {
    const k = propKeep(d, 160)
    assert.ok(k <= last && k >= 0 && k <= 1, `falls with distance (${d} m)`)
    last = k
  }
  for (const [d, r] of [[Number.NaN, 160], [10, Number.NaN], [Infinity, 160], [10, Infinity]]) assert.equal(propKeep(d, r), 0)
})

/** Every node a material's nodes reach (three's Node.getChildren): what its shaders read. */
function nodesOf(material: object): object[] {
  const out: object[] = [], seen = new Set<object>()
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object' || seen.has(n) || !(n as { isNode?: boolean }).isNode) return
    seen.add(n)
    out.push(n)
    for (const c of (n as { getChildren(): Iterable<unknown> }).getChildren()) walk(c)
  }
  for (const v of Object.values(material)) walk(v)
  return out
}

test('the world: a region\'s lit lamps shine only as far as their poles stand round the view being drawn', () => {
  const seed = 1337
  const { pack, layout, g } = metropolis(seed)
  const placed = regionPlacement(pack, layout, seed)!
  const start = regionStart(pack, layout, new RegionPlaces(pack, layout), placed)
  const streets = streetGridOf(pack, layout.offset, start)!
  const world = buildWorld(offlineRenderer(), seed, { pack, layout, streets, map: g })
  const heads = new Set(world.furniture.lamps.map((e) => lampHead(e).map(Math.fround).join(',')))
  const lit = () => world.scene.children.filter((o): o is PointLight => o instanceof PointLight && o.visible && heads.has([o.position.x, o.position.y, o.position.z].map(Math.fround).join(',')))
  world.setPropReach(LITE.propReach)
  world.setLampLights(48)
  world.update(22, 0, start.x, start.z)
  const base = LAMP.candela * world.night.value
  assert.ok(base > 0, 'night')
  const lights = lit()
  assert.equal(lights.length, 48, 'the 48 lamps nearest the start are lit')
  const expect = (fx: number, fz: number) => lights.map((l) => base * propKeep(Math.hypot(l.position.x - fx, l.position.z - fz), LITE.propReach))
  const near = (a: number[], b: number[]) => a.every((v, n) => Math.abs(v - b[n]) < 1e-9)
  const now = () => lights.map((l) => l.intensity)
  assert.ok(near(now(), expect(start.x, start.z)) && now().every((v) => v === base), 'round player 1 every lit lamp stands whole and shines full')
  // Another viewport's head, a reach off along the street: the lamps past its reach go dark for its draw, those in the
  // fold dim with their poles; the next update brings back player 1's.
  const cam = new PerspectiveCamera()
  cam.position.set(start.x + LITE.propReach - PROP_FOLD / 2, 1.7, start.z)
  world.follow(cam)
  assert.ok(near(now(), expect(cam.position.x, cam.position.z)), 'dimmed by propKeep round the other head')
  assert.ok(now().some((v) => v === 0) && now().some((v) => v === base) && new Set(now()).size > 2, `dark, dimmed and full (${new Set(now()).size} values)`)
  cam.position.set(start.x + 1000, 1.7, start.z)
  world.follow(cam)
  assert.ok(now().every((v) => v === 0), 'a head a kilometre off sees none of them')
  world.update(22, 0, start.x, start.z)
  assert.ok(now().every((v) => v === base), 'player 1\'s again')
  cam.position.set(Number.NaN, 1.7, start.z)
  world.follow(cam)
  assert.ok(now().every((v) => v === base), 'a head that is not a number changes nothing')
  // A lite boot lights no lamp (LITE_WORLD): no light, and nothing asked of the lamp index at night.
  const lite = buildWorld(offlineRenderer(), seed, { pack, layout, streets, map: g }, LITE_WORLD)
  lite.setPropReach(LITE.propReach)
  lite.setLampLights(48)
  lite.update(22, 0, start.x, start.z)
  lite.follow(cam)
  assert.equal(lite.scene.children.filter((o) => o instanceof PointLight).length, 0, 'lite: no lamp light at all')
})

test('the world: the painted pools are the window\'s lamps\', none cut at the picture\'s edge, and fade with the props round the view being drawn', () => {
  for (const seed of [1337, 7]) {
    const { pack, layout, g } = metropolis(seed)
    const placed = regionPlacement(pack, layout, seed)!
    const start = regionStart(pack, layout, new RegionPlaces(pack, layout), placed)
    const streets = streetGridOf(pack, layout.offset, start)!
    const world = buildWorld(offlineRenderer(), seed, { pack, layout, streets, map: g })
    const roads = world.scene.children.find((o) => o.name === 'RegionRoads') as Mesh
    const nodes = nodesOf(roads.material as object)
    const picture = (nodes.find((n) => (n as { isTextureNode?: boolean; value?: { name?: string } }).isTextureNode && (n as { value: { name: string } }).value.name === 'paintedLight') as { value: DataTexture }).value
    const { data, width: S } = picture.image as { data: Uint8Array; width: number }
    // The ring just inside the picture's dark edge holds no pool: every lamp painted is the window's, each pool whole
    // inside the margin (the map's lamps past the window would be cut there, a bright step on every street leaving it).
    let ring = 0
    for (let k = 1; k < S - 1; k++) for (const [x, z] of [[1, k], [S - 2, k], [k, 1], [k, S - 2]]) ring = Math.max(ring, data[(z * S + x) * 4])
    assert.equal(ring, 0, `seed ${seed}: no pool reaches the picture's edge`)
    // The asphalt's glow reads the props' focus and reach: the view being drawn's.
    const uniforms = nodes.filter((n) => (n as { isUniformNode?: boolean }).isUniformNode) as { value: unknown }[]
    const focus = () => uniforms.filter((u) => u.value instanceof Vector2).map((u) => (u.value as Vector2).toArray().join(','))
    world.setPropReach(LITE.propReach)
    world.update(22, 0, start.x, start.z)
    assert.ok(focus().includes([start.x, start.z].join(',')), `seed ${seed}: the props' focus, player 1's`)
    assert.ok(uniforms.some((u) => u.value === LITE.propReach), 'and their reach')
    const cam = new PerspectiveCamera()
    cam.position.set(start.x + 500, 1.7, start.z + 300)
    world.follow(cam)
    assert.ok(focus().includes([cam.position.x, cam.position.z].join(',')), 'the other head\'s while it draws')
  }
})

test('the world: a surveyed region with no street window draws no prop and has nothing to dissolve', () => {
  const { pack, layout } = metropolis(1337)
  const world = buildWorld(offlineRenderer(), 1337, { pack, layout, streets: null, map: null })
  assert.equal(world.scene.children.filter((o) => /^(StreetLamps|StreetTrees|TrafficSignals)/.test(o.name)).length, 0)
  for (const kind of KINDS) {
    assert.equal(world.furniture[kind].length, 0)
    assert.equal(world.sensors[kind].length, 0)
    assert.equal(world.dissolve[kind].array.length, 0)
  }
  world.setPropReach(PEAK.propReach)
  world.setLampLights(32)
  world.update(22, 0, 3000, 3000)
  world.follow(new PerspectiveCamera())
})

test('the world: a dissolve mark re-uploads the tiles whose runs it touches, through a view of the one list', () => {
  const seed = 7
  const { pack, layout, g, tiled } = metropolis(seed)
  const streets = streetGridOf(pack, layout.offset, { x: g.originX + 1300, z: g.originZ + 1300 })!
  const world = buildWorld(offlineRenderer(), seed, { pack, layout, streets, map: g })
  const amounts = world.dissolve.trees
  assert.equal(amounts.array.length, world.furniture.trees.length)
  const byName = new Map(world.scene.children.map((o) => [o.name, o as Mesh]))
  const busy = tiled.tiles.filter((r) => r.trees[1] - r.trees[0] > 2)
  const [a, b] = [busy[3], busy[busy.length - 2]]
  const attr = (r: (typeof busy)[number]) => byName.get(`StreetTrees ${r.i},${r.j}`)!.geometry.getAttribute('dissolve') as InstancedBufferAttribute
  const versions = () => busy.map((r) => attr(r).version)
  const before = versions()
  const k = a.trees[0] + 1
  amounts.array[k] = 1
  amounts.mark(k, k + 1)
  assert.equal(attr(a).getX(1), 1, 'the tile\'s mesh reads the list through a view')
  const after = versions()
  busy.forEach((r, n) => assert.equal(after[n] - before[n], r === a ? 1 : 0, `tile ${r.i},${r.j}`))
  // A range from one tile to another marks both and every tile between, none else.
  amounts.mark(a.trees[0], b.trees[1])
  const span = versions()
  busy.forEach((r, n) => assert.equal(span[n] - after[n], r.trees[0] < b.trees[1] && a.trees[0] < r.trees[1] ? 1 : 0, `tile ${r.i},${r.j} in the range`))
})

test('the world: the city\'s furniture is its three meshes, always drawn, never folded; its sensors are its furniture', () => {
  const world = buildWorld(offlineRenderer(), 1337)
  const props = world.scene.children.filter((o) => /^(StreetLamps|StreetTrees|TrafficSignals)/.test(o.name)) as InstancedMesh[]
  assert.deepEqual(props.map((m) => m.name), ['StreetLamps', 'StreetTrees', 'TrafficSignals'])
  assert.equal(world.sensors, world.furniture)
  for (const m of props) assert.ok(m.isInstancedMesh && m.geometry.getAttribute('place') === undefined, `${m.name}: placed by its instance matrices, no place of its own to fold`)
  world.setPropReach(LITE.propReach)
  world.update(21, 0, 1e5, 1e5)
  assert.ok(props.every((m) => m.visible), 'the reach never hides the city\'s')
  assert.deepEqual(props.map((m) => m.count), KINDS.map((k) => world.furniture[k].length))
  for (const kind of KINDS) assert.equal(world.dissolve[kind].array.length, world.furniture[kind].length, `${kind}: a dissolve slot for every prop`)
})
