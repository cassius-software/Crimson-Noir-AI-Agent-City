// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The painted light (paintedLight.ts) is the only light a lite phone's region has after
 * dark, and a picture baked from numbers can be wrong in ways only a night walk would show: a pool beside its lamp
 * instead of under its head, a frontage lighting the inside of its own building, a room's floor in the channel the
 * real fixtures switch off, light painted past the picture's edge as far as the ground goes. These tests hold the
 * picture to what stands in the window, first on small made-up scenes where every value can be worked out by hand, then
 * on the generated metropolis exactly as the page builds it: every lamp of the street window over a lit pool, every
 * room, shop and home lit inside, and the pools, the spill and the floors each in the channel the materials read
 * (regionWorld.ts paintedGlow).
 * What breaks if it is removed? A change to the bake could leave the phone's streets dark again, or light them where
 * nothing stands, and only a phone at night would show it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ClampToEdgeWrapping, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RGBAFormat, UnsignedByteType, Vector2, type MeshStandardNodeMaterial } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { CITY } from '../city.ts'
import { LAMP, lampHead } from '../cityLights.ts'
import { FbmSet } from '../fbmTexture.ts'
import { ROOM } from '../interiors.ts'
import { ZONE, generateLakefront } from '../lakefront.ts'
import { packOf } from '../lakefrontPack.ts'
import type { Pt } from './clip.ts'
import { regionHomeLots } from './homes.ts'
import { PAINT_MARGIN, PAINT_TEXEL, POOL, SPILL, bakePaintedLight, paintAt, poolAt, type PaintInput } from './paintedLight.ts'
import { regionShopLots } from './shops.ts'
import { SEG, WINDOW_BLOCKS, hSeg, streetGridOf, vSeg, windowFurniture } from './streets.ts'
import { regionWorkplaceLots } from './workplaces.ts'

// Vite's `?raw` import, for Node: regionWorld.ts imports a module that takes WGSL that way.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { PAINT_LIGHT, RegionPlaces, hollowLots, layoutOf, paintBounds, paintTexture, regionFrontages, regionMeshes } = await import('./regionWorld.ts')
const { regionTransit } = await import('./transit.ts')

const P = CITY.pitch
const WINDOW = { originX: 2000, originZ: 3000, blocks: WINDOW_BLOCKS }
const EXTENT = WINDOW_BLOCKS * P
const scene = (over: Partial<PaintInput>): PaintInput => ({ window: WINDOW, lamps: [], frontages: [], interiors: [], ...over })
const strip = (d: number): number => 1 - d / Math.hypot(d, SPILL.height)
const near = (got: number, want: number, slack: number, what: string): void => assert.ok(Math.abs(got - want) <= slack, `${what}: ${got} is not within ${slack} of ${want}`)

test('the picture is the window and its margin, a texel a metre, and dark where nothing stands', () => {
  const p = bakePaintedLight(scene({}))
  assert.equal(PAINT_TEXEL, 1)
  assert.equal(p.size, EXTENT + 2 * PAINT_MARGIN)
  assert.equal(p.originX, WINDOW.originX - PAINT_MARGIN)
  assert.equal(p.originZ, WINDOW.originZ - PAINT_MARGIN)
  assert.equal(p.data.length, p.size * p.size * 4)
  assert.ok(p.data.every((b) => b === 0), 'an empty window paints nothing, in any channel')
  assert.deepEqual(paintBounds(WINDOW), { x0: p.originX, z0: p.originZ, x1: p.originX + p.size, z1: p.originZ + p.size })
})

test('a lamp\'s pool is the light of a point its height up: full under the head, half at 4.5 m, an eighth at 10 m, gone at its reach', () => {
  assert.equal(poolAt(0), 1)
  const law = (d: number): number => (1 + (d * d) / (LAMP.height * LAMP.height)) ** -1.5
  for (const d of [1, 3, 5, 8, POOL.fade]) near(poolAt(d), law(d), 1e-12, `the cosine-cubed law at ${d} m`)
  near(poolAt(4.5), 0.5, 0.01, 'half')
  near(poolAt(10), 0.125, 0.01, 'an eighth')
  for (let d = 0; d < POOL.reach; d += 0.25) assert.ok(poolAt(d) > poolAt(d + 0.25), `it only falls (${d} m)`)
  assert.ok(poolAt(POOL.reach - 0.01) < 1e-6 && poolAt(POOL.reach) === 0 && poolAt(POOL.reach + 5) === 0, 'it ends where it says, without a step')
  assert.ok(POOL.fade < POOL.reach && POOL.reach <= PAINT_MARGIN - (3.9 - LAMP.reach), 'the margin holds the pool of the outermost row of heads')
})

test('a lamp paints its pool under its head', () => {
  // A lamp on the south kerb of an east-west street, its arm reaching north over the road (windowFurniture's yaw).
  const lamp: [number, number, number] = [2210, 3203.9, Math.PI]
  const [hx, , hz] = lampHead(lamp)
  near(hz, 3202.5, 1e-9, 'the head hangs 1.4 m toward the street')
  const p = bakePaintedLight(scene({ lamps: [lamp] }))
  // The head is over a texel's centre on z and over the line between two texels on x, so the filter reads the pool
  // half a texel off its peak on that one axis.
  near(paintAt(p, hx, hz)[0], poolAt(0.5), 0.01, 'under the head')
  assert.ok(paintAt(p, hx, hz)[0] > paintAt(p, lamp[0], lamp[1])[0], 'the pool is under the head, not under the pole')
  for (const d of [2, 4, 6, 8, 12]) {
    near(paintAt(p, hx + d, hz)[0], poolAt(d), 0.02, `${d} m along the street`)
    near(paintAt(p, hx, hz - d)[0], poolAt(d), 0.02, `${d} m across it`)
  }
  assert.equal(paintAt(p, hx + POOL.reach + 1.5, hz)[0], 0, 'nothing past its reach')
  assert.equal(paintAt(p, hx, hz - POOL.reach - 1.5)[0], 0)
  assert.deepEqual(paintAt(p, hx, hz).slice(1), [0, 0, 0], 'a lamp paints the pools\' channel alone')
})

test('two pools that meet brighten each other and never pass full', () => {
  // The two lamps facing each other across a street: heads 5 m apart.
  const south: [number, number, number] = [2210, 3203.9, Math.PI], north: [number, number, number] = [2210, 3196.1, 0]
  const one = bakePaintedLight(scene({ lamps: [south] })), other = bakePaintedLight(scene({ lamps: [north] }))
  const both = bakePaintedLight(scene({ lamps: [south, north] }))
  const mid = paintAt(both, 2210, 3200)[0]
  assert.ok(mid > paintAt(one, 2210, 3200)[0] + 0.1, 'the road between two heads is brighter than under one')
  // Screened, texel by texel: 1 − (1 − a)(1 − b), not their sum (which would pass full where two pools of a half meet).
  let screened = 0
  for (let i = 0; i < both.data.length; i += 4) {
    const a = one.data[i] / 255, b = other.data[i] / 255
    if (a === 0 && b === 0) { assert.equal(both.data[i], 0); continue }
    near(both.data[i] / 255, 1 - (1 - a) * (1 - b), 1.5 / 255, `texel ${i / 4}`)
    if (a > 0.3 && b > 0.3) screened++
  }
  assert.ok(screened > 20, `the two pools overlap where both are bright (${screened} texels), so the screen is tested`)
  // Twelve lamps on one spot still read full, not past it (a byte cannot, but the sum must not wrap either).
  const many = bakePaintedLight(scene({ lamps: Array.from({ length: 12 }, () => south) }))
  near(paintAt(many, 2210, 3202.5)[0], 1, 0.01, 'twelve pools on one spot')
  // The order the lamps come in does not change the picture beyond a byte's rounding.
  const swapped = bakePaintedLight(scene({ lamps: [north, south] }))
  assert.ok(both.data.every((b, i) => Math.abs(b - swapped.data[i]) <= 1))
})

test('a frontage spills light on the ground before it, never inside it, whichever way its ring is wound', () => {
  // A building 20 m square.
  const ccw: Pt[] = [[2100, 3100], [2120, 3100], [2120, 3120], [2100, 3120]]
  const cw = [...ccw].reverse()
  const a = bakePaintedLight(scene({ frontages: [ccw] })), b = bakePaintedLight(scene({ frontages: [cw] }))
  assert.deepEqual(a.data, b.data, 'the winding does not matter')
  // Before the middle of each wall, by the distance from it: the light of a long strip the glazing's height.
  for (const d of [1.5, 3.5, 5.5]) {
    const want = strip(d)
    for (const [x, z] of [[2110, 3100 - d], [2110, 3120 + d], [2100 - d, 3110], [2120 + d, 3110]]) near(paintAt(a, x, z)[1], want, 0.03, `${d} m before a wall`)
  }
  assert.ok(paintAt(a, 2110, 3098)[1] > paintAt(a, 2110, 3095)[1] && paintAt(a, 2110, 3095)[1] > paintAt(a, 2110, 3092)[1], 'it falls off with the distance')
  assert.equal(paintAt(a, 2110, 3100 - SPILL.reach - 1)[1], 0, 'and ends at its reach')
  assert.equal(paintAt(a, 2110, 3110)[1], 0, 'nothing inside the building')
  assert.equal(paintAt(a, 2104, 3104)[1], 0)
  // A convex corner is rounded by its two walls: the diagonal reads by its distance from the corner.
  near(paintAt(a, 2122.5, 3122.5)[1], strip(Math.hypot(2.5, 2.5)), 0.03, 'off a corner')
  assert.deepEqual([paintAt(a, 2110, 3097)[0], paintAt(a, 2110, 3097)[2], paintAt(a, 2110, 3097)[3]], [0, 0, 0], 'a frontage paints the spill\'s channel alone')
})

test('a lit lot paints its floor inside the glass, by whether real fixtures hang there, and spills through its glass', () => {
  const room = { cx: 2000 + 2.5 * P, cz: 3000 + 3.5 * P, fixtures: true }, shop = { cx: 2000 + 5.5 * P, cz: 3000 + 3.5 * P, fixtures: false }
  const p = bakePaintedLight(scene({ interiors: [room, shop] }))
  const h = CITY.lotHalf
  assert.deepEqual(paintAt(p, room.cx, room.cz).slice(2), [1, 0], 'a workplace\'s floor is in the channel the fixtures switch off')
  assert.deepEqual(paintAt(p, shop.cx, shop.cz).slice(2), [0, 1], 'a shop\'s or a home\'s is always shown')
  for (const lot of [room, shop]) {
    const c = lot.fixtures ? 2 : 3
    assert.equal(paintAt(p, lot.cx + h - ROOM.wall - 1, lot.cz - h + ROOM.wall + 1)[c], 1, 'lit to the glass')
    assert.equal(paintAt(p, lot.cx + h + 1.5, lot.cz)[c], 0, 'not past it')
    assert.equal(paintAt(p, lot.cx, lot.cz)[1], 0, 'no spill inside the lot')
    near(paintAt(p, lot.cx + h + 2.5, lot.cz)[1], strip(2.5), 0.03, 'the glass spills on the forecourt')
    assert.equal(paintAt(p, lot.cx, lot.cz)[0], 0)
  }
})

test('nothing is painted on the picture\'s outermost texels, whatever stands there', () => {
  // A lamp, a frontage and a lot right on the picture's corner.
  const x = WINDOW.originX - PAINT_MARGIN, z = WINDOW.originZ - PAINT_MARGIN
  const p = bakePaintedLight(scene({ lamps: [[x + 1, z + 1, 0]], frontages: [[[x - 5, z + 3], [x + 5, z + 3], [x + 5, z + 9], [x - 5, z + 9]]], interiors: [{ cx: x + 3, cz: z + 3, fixtures: false }] }))
  for (let i = 0; i < p.size; i++) {
    for (const [tx, tz] of [[i, 0], [i, p.size - 1], [0, i], [p.size - 1, i]]) {
      const o = (tz * p.size + tx) * 4
      assert.deepEqual([...p.data.subarray(o, o + 4)], [0, 0, 0, 0], `texel ${tx},${tz}`)
    }
  }
  assert.ok(paintAt(p, x + 3, z + 3)[0] > 0.5, 'while the texels inside are lit')
  assert.deepEqual(paintAt(p, x - 40, z - 40), [0, 0, 0, 0], 'and a place past the picture reads its dark edge')
  // Something wholly outside the picture is skipped, not wrapped in.
  const far = bakePaintedLight(scene({ lamps: [[x - 200, z - 200, 0], [x + p.size + 200, z + 5, 0]], frontages: [[[x - 300, z], [x - 280, z], [x - 280, z + 20], [x - 300, z + 20]]], interiors: [{ cx: x - 300, cz: z - 300, fixtures: true }] }))
  assert.ok(far.data.every((b) => b === 0))
})

test('the bake is deterministic and leaves its input alone', () => {
  const input = scene({ lamps: [[2210, 3203.9, Math.PI], [2230, 3203.9, Math.PI]], frontages: [[[2100, 3100], [2120, 3100], [2120, 3120], [2100, 3120]]], interiors: [{ cx: 2300, cz: 3300, fixtures: true }] })
  const before = JSON.stringify(input)
  const a = bakePaintedLight(input), b = bakePaintedLight(input)
  assert.deepEqual(a, b)
  assert.equal(JSON.stringify(input), before)
})

// ---------------------------------------------------------------------------------------------------
// The metropolis, as the page builds it (engine.ts Engine.create, world.ts buildWorld)

function metropolis() {
  const seed = 1337
  const pack = packOf(generateLakefront(seed, 64), ZONE.metropolis)
  const layout = layoutOf(pack)
  const start = new RegionPlaces(pack, layout).spawn({ x: layout.offset.x, z: layout.offset.z })
  const streets = streetGridOf(pack, layout.offset, start)
  assert.ok(streets, 'the metropolis has a street window')
  const lots = regionWorkplaceLots(pack, layout, streets, start, seed)
  const shopLots = regionShopLots(pack, layout, streets, start, seed, lots)
  const homeLots = regionHomeLots(pack, layout, streets, start, seed, [...lots, ...shopLots])
  const hollow = hollowLots(pack, layout, lots, shopLots, homeLots)
  const lamps = windowFurniture(streets, seed).lamps
  const interiors = [...hollow.rooms.map(({ cx, cz }) => ({ cx, cz, fixtures: true })), ...[...hollow.shops, ...hollow.homes].map(({ cx, cz }) => ({ cx, cz, fixtures: false }))]
  const frontages = regionFrontages(hollow.pack, layout, paintBounds(streets), SPILL.reach)
  return { streets, start, lamps, interiors, frontages, hollow, layout, picture: bakePaintedLight({ window: streets, lamps, frontages, interiors }) }
}
const METROPOLIS = metropolis()

test('the metropolis: every lamp of the street window stands over a lit pool, and the start is among them', () => {
  const { lamps, picture, start, streets } = METROPOLIS
  assert.ok(lamps.length > 1500, `the window has its lamps (${lamps.length})`)
  let dimmest = 1
  for (const lamp of lamps) {
    const [hx, , hz] = lampHead(lamp)
    dimmest = Math.min(dimmest, paintAt(picture, hx, hz)[0])
  }
  assert.ok(dimmest > 0.9, `the dimmest pool under a head reads ${dimmest}`)
  // The pools are pools, not a wash, and the street between them is lit, not black: the middle of a block, 10 m from
  // the lamp either side of it on this kerb and 11 m from the two across the road, reads between a quarter and a half.
  const lamp = lamps.reduce((best, l) => (Math.hypot(l[0] - start.x, l[1] - start.z) < Math.hypot(best[0] - start.x, best[1] - start.z) ? l : best))
  const [hx, , hz] = lampHead(lamp)
  const alongX = Math.abs(Math.sin(lamp[2])) < 0.5
  // The lamps stand 10 and 30 m into a block: from the first the middle is further on, from the second further back.
  const into = (((alongX ? hx - streets.originX : hz - streets.originZ) % P) + P) % P
  near(Math.min(Math.abs(into - 10), Math.abs(into - 30)), 0, 1e-6, 'a lamp stands 10 or 30 m into its block')
  const step = into < 20 ? 10 : -10
  const between = alongX ? paintAt(picture, hx + step, hz)[0] : paintAt(picture, hx, hz + step)[0]
  assert.ok(between > 0.25 && between < 0.5 && between < paintAt(picture, hx, hz)[0] - 0.4, `between two lamps reads ${between}`)
  // A crossing with all four streets has eight lamps 10 m from its middle: it is lit, where a narrower pool left it dark.
  let crossings = 0
  for (let m = 1; m < streets.blocks; m++) {
    for (let k = 1; k < streets.blocks; k++) {
      if (!(hSeg(streets, k - 1, m) & hSeg(streets, k, m) & vSeg(streets, k, m - 1) & vSeg(streets, k, m) & SEG.walk)) continue
      crossings++
      const mid = paintAt(picture, streets.originX + k * P, streets.originZ + m * P)[0]
      assert.ok(mid > 0.55 && mid < 0.75, `the crossing ${k},${m} reads ${mid}`)
    }
  }
  assert.ok(crossings > 100, `the window has its crossings (${crossings})`)
  // And some pool is within a lamp's spacing of where the visitor starts.
  assert.ok(Math.hypot(lamp[0] - start.x, lamp[1] - start.z) < 20)
  // A street the window does not hold has no lamps and no pools: the middle of every missing east-west segment is dark
  // (the lamps of the segments either side of it stand 30 m off, and the heads of a crossing street 20 m: a pool ends
  // POOL.reach from its head).
  let missing = 0
  for (let m = 0; m <= streets.blocks; m++) {
    for (let k = 0; k < streets.blocks; k++) {
      if (hSeg(streets, k, m) & SEG.walk) continue
      missing++
      assert.equal(paintAt(picture, streets.originX + (k + 0.5) * P, streets.originZ + m * P)[0], 0, `segment ${k},${m} has no street and no pool`)
    }
  }
  assert.ok(missing > 0, 'the window has streets missing (superblocks, water): the picture follows the map, not the grid')
})

test('the metropolis: every room, shop and home is lit inside, and its frontages light the ground before them', () => {
  const { interiors, frontages, picture, hollow, streets } = METROPOLIS
  assert.equal(interiors.length, hollow.rooms.length + hollow.shops.length + hollow.homes.length)
  assert.ok(hollow.rooms.length > 0 && hollow.shops.length > 0 && hollow.homes.length > 0)
  for (const lot of interiors) {
    const [, , fixtured, bare] = paintAt(picture, lot.cx, lot.cz)
    assert.deepEqual([fixtured, bare], lot.fixtures ? [1, 0] : [0, 1], `the lot at ${lot.cx},${lot.cz}`)
  }
  // The frontages are the buildings that stand in or beside the picture, and none of a hollowed lot's.
  assert.ok(frontages.length > 500, `the window has its frontages (${frontages.length})`)
  const b = paintBounds(streets)
  for (const ring of frontages) {
    assert.ok(ring.some(([x, z]) => x >= b.x0 - SPILL.reach && x <= b.x1 + SPILL.reach && z >= b.z0 - SPILL.reach && z <= b.z1 + SPILL.reach))
    for (const lot of interiors) {
      const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length, cz = ring.reduce((s, p) => s + p[1], 0) / ring.length
      assert.ok(Math.max(Math.abs(cx - lot.cx), Math.abs(cz - lot.cz)) > CITY.lotHalf - 1e-6 || ring.length !== 4, 'no frontage stands on a hollowed lot')
    }
  }
  // Light reaches the pavement: a fair share of the picture is under some spill, and a fair share under none.
  let lit = 0
  for (let i = 1; i < picture.data.length; i += 4) if (picture.data[i] > 25) lit++
  const share = lit / (picture.size * picture.size)
  assert.ok(share > 0.1 && share < 0.7, `${Math.round(share * 100)}% of the picture is under a frontage's spill`)
})

// ---------------------------------------------------------------------------------------------------
// The wiring (regionWorld.ts regionMeshes, world.ts buildWorld, engine.ts Engine.create)

/** The surfaces the painted light lies on, by the mesh's name. */
const PAINTED = ['RegionGround', 'RegionSidewalks', 'RegionSidewalkJunctions', 'RegionRoads', 'RegionRoadJunctions', 'RegionMarkings']

test('the picture is a texture the ground can read at any distance: bytes as baked, filtered, mipmapped, clamped, linear', () => {
  const { picture } = METROPOLIS
  const tex = paintTexture(picture)
  assert.equal(tex.image.data, picture.data, 'the bake\'s own bytes, not a copy')
  assert.deepEqual([tex.image.width, tex.image.height], [picture.size, picture.size])
  assert.deepEqual([tex.format, tex.type, tex.colorSpace], [RGBAFormat, UnsignedByteType, NoColorSpace], 'four channels of linear data: the format the FBM textures have')
  assert.deepEqual([tex.wrapS, tex.wrapT], [ClampToEdgeWrapping, ClampToEdgeWrapping])
  assert.deepEqual([tex.magFilter, tex.minFilter, tex.generateMipmaps], [LinearFilter, LinearMipmapLinearFilter, true], 'a pool a street away is smaller than a pixel')
  assert.ok(tex.version > 0, 'marked for upload')
  // What a lite phone holds for it: under 2.5 MB with its mips.
  assert.ok((picture.data.length * 4) / 3 < 2.5 * 1024 * 1024, `${picture.data.length} bytes and a third again of mips`)
})

test('the region\'s lawn, pavement, asphalt and road markings glow by the picture when handed one, and nothing glows without', () => {
  const { hollow, layout, streets, picture } = METROPOLIS
  const fbm = new FbmSet(1, [64])
  const transit = regionTransit(hollow.pack, layout, streets)
  assert.ok(transit.markings.length > 0, 'the window has road markings')
  const paint = { originX: picture.originX, originZ: picture.originZ, size: picture.size, map: paintTexture(picture), night: uniform(1), real: { focus: uniform(new Vector2()), radius: uniform(0) }, floors: uniform(1) }
  const drawn = { ...layout, floors: hollow.floors }
  const lit = new Map(regionMeshes(hollow.pack, drawn, fbm, paint.night, null, transit, paint).meshes.map((m) => [m.name, m.material as MeshStandardNodeMaterial]))
  const dark = new Map(regionMeshes(hollow.pack, drawn, fbm, paint.night, null, transit).meshes.map((m) => [m.name, m.material as MeshStandardNodeMaterial]))
  for (const name of PAINTED) {
    assert.ok(lit.get(name), `${name} is drawn`)
    assert.ok(lit.get(name)!.emissiveNode, `${name} takes the painted light`)
    assert.equal(dark.get(name)!.emissiveNode, null, `${name} without a picture glows by nothing`)
  }
  assert.equal(lit.get('RegionSidewalks'), lit.get('RegionSidewalkJunctions'), 'one pavement material')
  assert.equal(lit.get('RegionRoads'), lit.get('RegionRoadJunctions'), 'one asphalt material')
  // Nothing else is painted: the water, the facades and the rest keep what they had.
  for (const [name, m] of lit) if (!PAINTED.includes(name)) assert.equal(m.emissiveNode === null, dark.get(name)!.emissiveNode === null, `${name} is as it was`)
  // The strengths: each a share of the surface's own colour, the pools the city ground's own.
  assert.deepEqual(PAINT_LIGHT.pool, { color: [1.0, 0.8, 0.55], gain: 0.7 })
  for (const k of ['pool', 'spill', 'floor'] as const) assert.ok(PAINT_LIGHT[k].gain > 0 && PAINT_LIGHT[k].gain <= 1 && PAINT_LIGHT[k].color.every((c) => c > 0 && c <= 1), k)
})

test('the world bakes the picture for a street window alone and hands it to the region; the engine sends the lit lots (source pins)', () => {
  const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\s+/g, ' ')
  const world = read('../world.ts'), engine = read('../../07_Execute_Actions/engine.ts'), region = read('./regionWorld.ts')
  assert.ok(world.includes('if (region?.streets) { const picture = bakePaintedLight({ window: region.streets, lamps: furniture.lamps, interiors: region.interiors ?? [], frontages: regionFrontages(region.pack, region.layout, paintBounds(region.streets), SPILL.reach), })'), 'baked from the window\'s own lamps, the lit lots and the frontages round it')
  assert.ok(world.includes('const map = paintTexture(picture) renderer.initTexture(map)'), 'uploaded at boot, not at the first night frame')
  assert.ok(world.includes('paint = { originX: picture.originX, originZ: picture.originZ, size: picture.size, map, night, real: realLight, floors: paintFloors }'), 'with the night, the real light\'s reach and the fixtures\' switch')
  assert.ok(world.includes('regionMeshes(region.pack, region.layout, fbm, night, matrixMode.globalState, region.transit ?? null, paint)'))
  // The floors under real fixtures show only while those are off; the glow of the city joins the fill only then too.
  assert.ok(world.includes('for (const l of fixtureLights) l.visible = litLamps > 0 paintFloors.value = litLamps > 0 ? 0 : 1'))
  assert.ok(world.includes('if (litLamps === 0 && day < 1) { const glow = (1 - day) / (0.04 + 0.16 * day)'))
  assert.ok(engine.includes('const interiors = hollow ? [...hollow.rooms.map(({ cx, cz }) => ({ cx, cz, fixtures: true })), ...[...hollow.shops, ...hollow.homes].map(({ cx, cz }) => ({ cx, cz, fixtures: false }))] : []'), 'a workplace hangs fixtures, a shop and a home none')
  // The glow is set before rain mode wraps the material (matrixMode.ts multiplies the emissive it finds).
  for (const make of ['groundMaterial(fbm, glow)', 'sidewalkMaterial(fbm, glow)', 'asphaltMaterial(fbm, glow)', 'markingMaterial(glow)']) assert.ok(region.includes(`moded(${make})`), make)
})
