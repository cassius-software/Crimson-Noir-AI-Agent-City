// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? A region's ground, lake, sidewalks and streets are flat meshes laid over one another, and
 * only the renderer's reversed depth buffer keeps them apart: each surface lies at its own height (regionWorld.ts
 * SURFACE), strictly over the one below, and nothing else decides what shows. Two things broke that rule and were seen
 * on the generated metropolis: every surface asked for a negative polygon offset, which three r186 hands to WebGPU as
 * it is, and under a reversed buffer that pushes a surface away from the camera, so past some 18 m the streets sank
 * under the pavement and the lawn ("grass over the roads"); and two ribbons crossing at a junction lay on one plane, so
 * their markings fought wherever the depths of the two triangles rounded apart. These tests hold the rule on the real
 * generated map: the heights in order, no polygon offset on any material, every crossing of two carriageways under a
 * patch of plain asphalt (and of two sidewalks under plain pavement) that reaches exactly the roads' overlap, and
 * nothing of a patch outside the roads it joins. A third fault was found with the same render: the ground was two
 * 8.5 km triangles and a lake strip 2.5 km long, and a rasteriser interpolating a pixel's depth from vertices that
 * far loses more of it than the surfaces' few centimetres, so near the map's edge the lawn still covered a causeway
 * and the lake the road on it; every surface is now drawn in pieces no longer than SURFACE_PIECE, which the tests
 * hold too, with the water's pieces covering exactly the water's area (no cell dropped or drawn twice).
 * What breaks if it is removed? An offset or a height could come back with the wrong sign, or a junction's patch go
 * missing, and only a GPU would show it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { uniform } from 'three/tsl'
import type { BufferGeometry, Mesh, MeshStandardNodeMaterial } from 'three/webgpu'
import { FbmSet } from '../fbmTexture.ts'
import { ZONE, generateLakefront, type Zone } from '../lakefront.ts'
import { packOf } from '../lakefrontPack.ts'
import type { Pt } from './clip.ts'
import { ROAD_CLASS, polygonAt, polygonCount, pushPolygon, roadAt, type RegionPack } from './pack.ts'

// Vite's `?raw` import, for Node: regionWorld.ts imports a module that takes WGSL that way.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { SIDEWALK, SURFACE, SURFACE_PIECE, layoutOf, regionMeshes, roadWidth } = await import('./regionWorld.ts')

/** The meshes of a generated zone, by name, with the pack and the layout they came from. */
function build(seed: number, zone: Zone) {
  const map = generateLakefront(seed, 64)
  const pack = packOf(map, zone)
  const layout = layoutOf(pack)
  const scene = regionMeshes(pack, layout, new FbmSet(1, [64]), uniform(0))
  const by = new Map<string, Mesh>()
  for (const m of scene.meshes) by.set(m.name, m)
  return { pack, layout, scene, by }
}
const METROPOLIS = build(1337, ZONE.metropolis)
const RIDGE = build(7, ZONE.northRidge)

/** Every vertex's y of a mesh. */
const ys = (m: Mesh): number[] => {
  const pos = (m.geometry as BufferGeometry).getAttribute('position')
  const out: number[] = []
  for (let i = 0; i < pos.count; i++) out.push(pos.getY(i))
  return out
}

test('the surfaces lie in order, each strictly over the one below, with room between them for the reversed buffer', () => {
  const order = ['water', 'sidewalk', 'sidewalkJunction', 'road', 'roadJunction'] as const
  let below = 0
  for (const k of order) {
    assert.ok(SURFACE[k] - below >= 0.0049, `${k} at ${SURFACE[k]} is less than 5 mm over ${below}`)
    below = SURFACE[k]
  }
  assert.deepEqual(Object.keys(SURFACE), order.slice(), 'the heights named are the surfaces drawn')
  for (const { by } of [METROPOLIS, RIDGE]) {
    const at = (name: string, y: number) => {
      const m = by.get(name)
      assert.ok(m, `${name} drawn`)
      const all = ys(m)
      assert.ok(all.length > 0, `${name} has vertices`)
      // To a micrometre: the geometry keeps 32-bit floats (0.045 reads back as 0.0450000018), and the ground is a plane
      // rotated flat, which leaves a residue of 1e-13 on its y.
      assert.ok(all.every((v) => Math.abs(v - y) < 1e-6), `${name}: every vertex at ${y} m (saw ${[...new Set(all)].slice(0, 4).join(', ')})`)
    }
    at('RegionGround', 0)
    at('RegionWater', SURFACE.water)
    at('RegionSidewalks', SURFACE.sidewalk)
    at('RegionSidewalkJunctions', SURFACE.sidewalkJunction)
    at('RegionRoads', SURFACE.road)
    at('RegionRoadJunctions', SURFACE.roadJunction)
  }
})

test('no material of a region asks for a polygon offset: under the reversed depth buffer the height alone keeps a surface over the one below', () => {
  for (const { scene } of [METROPOLIS, RIDGE]) {
    for (const m of scene.meshes) {
      const mat = m.material as MeshStandardNodeMaterial
      assert.equal(mat.polygonOffset, false, `${m.name}: polygonOffset`)
      assert.equal(mat.polygonOffsetFactor, 0, `${m.name}: polygonOffsetFactor`)
      assert.equal(mat.polygonOffsetUnits, 0, `${m.name}: polygonOffsetUnits`)
      assert.equal(mat.depthWrite, true, `${m.name}: writes depth`)
      assert.equal(mat.depthTest, true, `${m.name}: tests depth`)
    }
  }
  // The source as well: the three fix for the sign (after r186) would turn a negative offset right again, so none is
  // written, whichever three builds the page.
  const src = readFileSync(new URL('./regionWorld.ts', import.meta.url), 'utf8')
  assert.equal(src.match(/polygonOffset\w*\s*=/g), null, 'regionWorld.ts sets no polygon offset')
})

test('the junction patches share the ribbons\' own materials (one asphalt, one pavement: no shader of their own)', () => {
  for (const { by } of [METROPOLIS, RIDGE]) {
    assert.equal(by.get('RegionRoadJunctions')!.material, by.get('RegionRoads')!.material)
    assert.equal(by.get('RegionSidewalkJunctions')!.material, by.get('RegionSidewalks')!.material)
  }
})

/** A road as the region lays it, in the engine's frame: its points and its carriageway's and sidewalks' half-widths. */
interface Ribbon { pts: Pt[]; half: number; walk: number }
function ribbonsOf(pack: RegionPack, offset: { x: number; z: number }): Ribbon[] {
  const out: Ribbon[] = []
  for (let i = 0; i < pack.roads.cls.length; i++) {
    const cls = pack.roads.cls[i]
    if (cls === ROAD_CLASS.ferry) continue
    const { carriage, sidewalk } = roadWidth(cls, pack.roads.lanes[i])
    out.push({ pts: roadAt(pack, i).map(([x, z]) => [x + offset.x, z + offset.z] as Pt), half: carriage / 2, walk: sidewalk ? carriage / 2 + SIDEWALK : 0 })
  }
  return out
}
/** Whether (x, z) lies on a ribbon `half` wide, `inset` metres inside its edges and ends (a ribbon ends square). */
function onRibbon(x: number, z: number, r: Ribbon, half: number, inset: number): boolean {
  for (let k = 0; k + 1 < r.pts.length; k++) {
    const [ax, az] = r.pts[k], [bx, bz] = r.pts[k + 1]
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz)
    if (len < 1e-9) continue
    const along = ((x - ax) * dx + (z - az) * dz) / len
    const across = Math.abs(((x - ax) * -dz + (z - az) * dx) / len)
    if (along >= inset && along <= len - inset && across <= half - inset) return true
  }
  return false
}
/** The patches of a junction mesh: each triangle's three corners, binned by 16 m cell for the lookups below. */
function patchesOf(m: Mesh) {
  const g = m.geometry as BufferGeometry
  const pos = g.getAttribute('position'), idx = g.getIndex()!
  const tris: [Pt, Pt, Pt][] = []
  for (let i = 0; i + 2 < idx.count; i += 3) {
    const p = (j: number): Pt => [pos.getX(idx.getX(j)), pos.getZ(idx.getX(j))]
    tris.push([p(i), p(i + 1), p(i + 2)])
  }
  const cell = 16
  const bins = new Map<string, [Pt, Pt, Pt][]>()
  for (const t of tris) {
    const xs = t.map((p) => p[0]), zs = t.map((p) => p[1])
    for (let cx = Math.floor(Math.min(...xs) / cell); cx <= Math.floor(Math.max(...xs) / cell); cx++) {
      for (let cz = Math.floor(Math.min(...zs) / cell); cz <= Math.floor(Math.max(...zs) / cell); cz++) {
        const k = `${cx},${cz}`
        const list = bins.get(k)
        if (list) list.push(t)
        else bins.set(k, [t])
      }
    }
  }
  const inTri = (x: number, z: number, [a, b, c]: [Pt, Pt, Pt]): boolean => {
    const s = (p: Pt, q: Pt) => (q[0] - p[0]) * (z - p[1]) - (q[1] - p[1]) * (x - p[0])
    const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a)
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
  }
  return {
    tris,
    covers: (x: number, z: number) => (bins.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) ?? []).some((t) => inTri(x, z, t)),
  }
}

/**
 * Every point on two ribbons at once is under a patch, and every patch corner is on two ribbons: the patch is the
 * overlap, no more and no less. The overlap is searched where the ribbons' centre lines come within reach of each
 * other, on a 0.25 m grid, a hair inside each ribbon's edges and ends so a boundary never decides.
 */
function holdJunctions(label: string, ribbons: Ribbon[], halfOf: (r: Ribbon) => number, mesh: Mesh): { pairs: number; samples: number } {
  const patches = patchesOf(mesh)
  const inset = 0.02, step = 0.25
  let pairs = 0, samples = 0
  for (let i = 0; i < ribbons.length; i++) {
    const A = ribbons[i], ha = halfOf(A)
    if (!(ha > 0)) continue
    for (let j = i + 1; j < ribbons.length; j++) {
      const B = ribbons[j], hb = halfOf(B)
      if (!(hb > 0)) continue
      let met = false
      for (let ka = 0; ka + 1 < A.pts.length; ka++) {
        for (let kb = 0; kb + 1 < B.pts.length; kb++) {
          const [p, q] = [A.pts[ka], A.pts[ka + 1]], [a, b] = [B.pts[kb], B.pts[kb + 1]]
          const dx = q[0] - p[0], dz = q[1] - p[1], ex = b[0] - a[0], ez = b[1] - a[1]
          const den = dx * ez - dz * ex
          if (Math.abs(den) < 1e-9) continue
          // Where the centre lines cross (anywhere along them): the overlap, if any, is within reach of that point.
          const t = ((a[0] - p[0]) * ez - (a[1] - p[1]) * ex) / den
          const u = ((a[0] - p[0]) * dz - (a[1] - p[1]) * dx) / den
          const la = Math.hypot(dx, dz), lb = Math.hypot(ex, ez)
          const reach = ha + hb + 1
          if (t * la < -reach || (t - 1) * la > reach || u * lb < -reach || (u - 1) * lb > reach) continue
          const cx = p[0] + dx * t, cz = p[1] + dz * t
          for (let x = cx - reach; x <= cx + reach; x += step) {
            for (let z = cz - reach; z <= cz + reach; z += step) {
              if (!onRibbon(x, z, A, ha, inset) || !onRibbon(x, z, B, hb, inset)) continue
              samples++
              met = true
              assert.ok(patches.covers(x, z), `${label}: (${x.toFixed(2)}, ${z.toFixed(2)}) is on roads ${i} and ${j} and under no patch`)
            }
          }
        }
      }
      if (met) pairs++
    }
  }
  // The other way: no patch reaches ground that is not two ribbons' (its corners lie on two of them, to the half
  // millimetre the geometry's 32-bit floats keep at 4 km from the origin).
  for (const t of patches.tris) {
    for (const [x, z] of t) {
      let on = 0
      for (const r of ribbons) if (halfOf(r) > 0 && onRibbon(x, z, r, halfOf(r), -2e-3)) on++
      assert.ok(on >= 2, `${label}: patch corner (${x.toFixed(3)}, ${z.toFixed(3)}) lies on ${on} ribbon(s)`)
    }
  }
  return { pairs, samples }
}

test('every crossing of two carriageways on the metropolis is under a patch of plain asphalt that reaches exactly their overlap', () => {
  const { pack, layout, by, scene } = METROPOLIS
  const ribbons = ribbonsOf(pack, layout.offset)
  const mesh = by.get('RegionRoadJunctions')!
  const { pairs, samples } = holdJunctions('metropolis roads', ribbons, (r) => r.half, mesh)
  assert.ok(pairs > 2000, `${pairs} crossings met`)
  assert.ok(samples > 100_000, `${samples} points checked`)
  assert.equal(scene.stats.junctions, pairs, 'one patch per pair of roads that meet')
  // No marking on a patch: lanes 0 draws neither a centre line, nor a dash, nor an edge line; twoWay 0 as well.
  const g = mesh.geometry as BufferGeometry
  for (const k of ['lanes', 'twoWay', 'across', 'dist']) {
    const a = g.getAttribute(k)
    assert.ok(a && a.count === g.getAttribute('position').count, `${k} attribute`)
    for (let i = 0; i < a.count; i++) assert.equal(a.getX(i), 0, `${k}[${i}]`)
  }
  const hw = g.getAttribute('halfWidth')
  for (let i = 0; i < hw.count; i++) assert.ok(hw.getX(i) > 0, `halfWidth[${i}] is positive (the shader divides by it)`)
})

test('every crossing of two sidewalks on the metropolis is under a patch of plain pavement that reaches exactly their overlap', () => {
  const { pack, layout, by } = METROPOLIS
  const ribbons = ribbonsOf(pack, layout.offset)
  const mesh = by.get('RegionSidewalkJunctions')!
  const { pairs, samples } = holdJunctions('metropolis sidewalks', ribbons, (r) => r.walk, mesh)
  assert.ok(pairs > 1000, `${pairs} crossings met`)
  assert.ok(samples > 100_000, `${samples} points checked`)
  const g = mesh.geometry as BufferGeometry
  const d = g.getAttribute('dist')
  for (let i = 0; i < d.count; i++) assert.equal(d.getX(i), 0, `dist[${i}]: no joint on a junction's pavement`)
})

test('the same on another zone and seed (the ridge), roads and sidewalks', () => {
  const { pack, layout, by, scene } = RIDGE
  const ribbons = ribbonsOf(pack, layout.offset)
  const roads = holdJunctions('ridge roads', ribbons, (r) => r.half, by.get('RegionRoadJunctions')!)
  const walks = holdJunctions('ridge sidewalks', ribbons, (r) => r.walk, by.get('RegionSidewalkJunctions')!)
  assert.ok(roads.pairs > 500 && walks.pairs > 100, `${roads.pairs} road crossings, ${walks.pairs} sidewalk crossings`)
  assert.equal(scene.stats.junctions, roads.pairs)
})

test('the patches, where the roads meet at a T or a corner, stop at the ribbon that ends there', () => {
  // Hand-made: a two-lane street along x from 0 to 100, met by one from z = −50 that ends on its centre line at x = 50
  // (a T), and one from z = 50 that ends at (100, 0), where the first ends too (a corner). Half-widths 3.3; no
  // sidewalks (ROAD_CLASS.lane).
  const pack: RegionPack = {
    format: 'region/1', name: 'T', grid: METROPOLIS.pack.grid, bounds: { x0: -10, z0: -60, x1: 110, z1: 60 }, attribution: [], names: ['a', 'b', 'c'],
    roads: { cls: [ROAD_CLASS.lane, ROAD_CLASS.lane, ROAD_CLASS.lane], lanes: [2, 2, 2], flow: [0, 0, 0], name: [0, 1, 2], start: [0, 2, 4, 6], xz: [0, 0, 1000, 0, 500, -500, 500, 0, 1000, 500, 1000, 0] },
    water: { polyStart: [0], ringStart: [0], xz: [], kind: [], name: [] },
    buildings: { polyStart: [0], ringStart: [0], xz: [], height: [], kind: [] },
  }
  const layout = layoutOf(pack)
  const scene = regionMeshes(pack, layout, new FbmSet(1, [64]), uniform(0))
  const mesh = scene.meshes.find((m) => m.name === 'RegionRoadJunctions')!
  assert.ok(mesh, 'patches drawn')
  const ribbons = ribbonsOf(pack, layout.offset)
  const { pairs } = holdJunctions('T and corner', ribbons, (r) => r.half, mesh)
  assert.equal(pairs, 2)
  assert.equal(scene.stats.junctions, 2)
  const { covers } = patchesOf(mesh)
  const o = layout.offset
  // The T: the patch covers the near half of the first street at x = 50 and nothing of the far half.
  assert.ok(covers(50 + o.x, -1 + o.z), 'the T, on the side the street comes from')
  assert.ok(!covers(50 + o.x, 1 + o.z), 'the T, past the centre line, where the first street alone is drawn')
  // The corner: the overlap is the square behind both caps (x in 96.7..100, z in 0..3.3), not the three quadrants
  // with one road or none.
  assert.ok(covers(99 + o.x, 1 + o.z), 'the corner, inside both ribbons')
  assert.ok(!covers(101 + o.x, 1 + o.z) && !covers(99 + o.x, -1 + o.z) && !covers(101 + o.x, -1 + o.z), 'the corner, outside')
  // No sidewalks on lanes: no pavement patch at all.
  assert.ok(!scene.meshes.some((m) => m.name === 'RegionSidewalkJunctions'), 'nothing to pave at a junction of lanes')
})

/** The longest edge, m, of any triangle of a mesh. */
function longestEdge(m: Mesh): number {
  const g = m.geometry as BufferGeometry
  const pos = g.getAttribute('position'), idx = g.getIndex()!
  let longest = 0
  const at = (j: number): [number, number, number] => { const i = idx.getX(j); return [pos.getX(i), pos.getY(i), pos.getZ(i)] }
  for (let i = 0; i + 2 < idx.count; i += 3) {
    const [a, b, c] = [at(i), at(i + 1), at(i + 2)]
    for (const [p, q] of [[a, b], [b, c], [c, a]]) longest = Math.max(longest, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]))
  }
  return longest
}
/** Twice the area of a mesh's triangles, summed (all flat, so the y is ignored). */
function area2Of(m: Mesh): number {
  const g = m.geometry as BufferGeometry
  const pos = g.getAttribute('position'), idx = g.getIndex()!
  let s = 0
  for (let i = 0; i + 2 < idx.count; i += 3) {
    const [a, b, c] = [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)]
    s += Math.abs((pos.getX(b) - pos.getX(a)) * (pos.getZ(c) - pos.getZ(a)) - (pos.getX(c) - pos.getX(a)) * (pos.getZ(b) - pos.getZ(a)))
  }
  return s
}
const ringArea2 = (ring: readonly Pt[]): number => {
  let s = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  return Math.abs(s)
}

test('every flat surface is drawn in pieces no longer than SURFACE_PIECE, the ground and the lake included', () => {
  assert.ok(SURFACE_PIECE <= 160, `${SURFACE_PIECE} m pieces`)
  const limit = SURFACE_PIECE * Math.SQRT2 + 1e-3
  for (const { by } of [METROPOLIS, RIDGE]) {
    for (const name of ['RegionGround', 'RegionWater', 'RegionSidewalks', 'RegionSidewalkJunctions', 'RegionRoads', 'RegionRoadJunctions']) {
      const m = by.get(name)!
      const longest = longestEdge(m)
      assert.ok(longest <= limit, `${name}: an edge of ${longest.toFixed(1)} m (limit ${limit.toFixed(1)})`)
    }
    // The ground still reaches its margin: the region and 3 km around it.
    const g = by.get('RegionGround')!.geometry as BufferGeometry
    g.computeBoundingBox()
    const bb = g.boundingBox!, b = METROPOLIS.layout.bounds
    assert.ok(bb.min.x <= b.x0 - 2999 && bb.max.x >= b.x1 + 2999 && bb.min.z <= b.z0 - 2999 && bb.max.z >= b.z1 + 2999, 'the ground and its margin')
  }
})

test('the water\'s pieces cover exactly the water: the polygons\' area, no cell dropped or drawn twice, holes left open', () => {
  for (const { pack, layout, by } of [METROPOLIS, RIDGE]) {
    let polygons = 0
    for (let i = 0; i < polygonCount(pack.water); i++) {
      const rings = polygonAt(pack.water, i)
      polygons += ringArea2(rings[0])
      for (const h of rings.slice(1)) polygons -= ringArea2(h)
    }
    const drawn = area2Of(by.get('RegionWater')!)
    assert.ok(Math.abs(drawn - polygons) <= polygons * 1e-6 + 1e-3, `water drawn ${drawn / 2} m², the polygons ${polygons / 2} m² (offset ${JSON.stringify(layout.offset)})`)
  }
  // A lake with an island: the cells inside the island draw nothing, the cells on its shore stop at it.
  const pack: RegionPack = {
    format: 'region/1', name: 'island', grid: METROPOLIS.pack.grid, bounds: { x0: 0, z0: 0, x1: 600, z1: 600 }, attribution: [], names: ['lake'],
    roads: { cls: [], lanes: [], flow: [], name: [], start: [0], xz: [] },
    water: { polyStart: [0], ringStart: [0], xz: [], kind: [], name: [] },
    buildings: { polyStart: [0], ringStart: [0], xz: [], height: [], kind: [] },
  }
  pushPolygon(pack.water, [[[0, 0], [600, 0], [600, 600], [0, 600]], [[100, 100], [100, 500], [500, 500], [500, 100]]])
  pack.water.kind.push(0); pack.water.name.push(0)
  assert.equal(polygonCount(pack.water), 1)
  const layout = layoutOf(pack)
  const scene = regionMeshes(pack, layout, new FbmSet(1, [64]), uniform(0))
  const water = scene.meshes.find((m) => m.name === 'RegionWater')!
  const rings = polygonAt(pack.water, 0)
  const expected = ringArea2(rings[0]) - ringArea2(rings[1])
  const drawn = area2Of(water)
  assert.ok(Math.abs(drawn - expected) <= expected * 1e-6, `drawn ${drawn / 2} m², expected ${expected / 2} m²`)
  assert.ok(longestEdge(water) <= SURFACE_PIECE * Math.SQRT2 + 1e-3)
})
