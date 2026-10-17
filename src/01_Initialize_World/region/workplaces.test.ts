// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? Lakefront Metro's workplaces are chosen from its pack (region/workplaces.ts) and walked to
 * on a street window that has dropped streets, dead ends and water. These tests hold the choice to its promises on the
 * real generated map (three seeds, the five zones each): at most six lots of the window, each with its doorway on a
 * two-way street with a sidewalk whose corner the visitor can walk to, never The Spire's lot or a lot under water, the
 * kinds in order, the same lots every time and the pack untouched, and seed 1337's metropolis on its six transit-hub
 * lots. They hold the route table too, through a mirror of the shader's commute (crowd.wgsl commuteCorner): from every
 * corner the visitor's can reach, a commuter arrives at the workplace's corner within twice the streets between plus
 * two, on streets that exist; while the greedy walk the city uses, with its dice, strands someone for good. And they
 * hold the hollowing (regionWorld.ts hollowLots): a copy of the pack with only the chosen lots' buildings put out of
 * sight, the ceiling slab in the podium's finish, what stood above the slab carried on it as the box it was, the
 * meshes short of exactly the hidden buildings, and the frame facts it leans on.
 * What breaks if it is removed? A room could open onto a missing street or the lake, a worker could circle a dead end
 * for a whole shift, a room could stand inside a building still drawn round it, and only the GPU laptop would show it.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { uniform } from 'three/tsl'
import { createRng } from '../../02_Define_The_Rules/degrees.ts'
import { CITY, STYLE, type Building } from '../city.ts'
import { FbmSet } from '../fbmTexture.ts'
import { ROOM, WORKPLACE_KINDS, targetCorner, toWorld, workplacesAt, type Side, type WorkplaceLot } from '../interiors.ts'
import { ZONE, generateLakefront } from '../lakefront.ts'
import { packOf } from '../lakefrontPack.ts'
import { polygonAt, polygonCount, pushPolygon, tallestBuilding, validatePack, type RegionPack } from './pack.ts'
import { SEG, hSeg, streetGridOf, vSeg, type StreetGrid } from './streets.ts'
import {
  ROUTE, ROUTE_LINES, ROUTE_ROOM_VEC4S, ROUTE_VEC4S, buildingLot, cornerAt, cornerComponent, cornerExists, cornerKey, cornerNear, cornerWays, frontOf,
  packRoutes, podiumOf, regionWorkplaceLots, windowLotBuildings, type Corner,
} from './workplaces.ts'

// Vite's `?raw` import, for Node: regionWorld.ts (the visitor's start, RegionPlaces; the hollowing; the meshes) imports
// a module that takes WGSL that way, so it is imported once the hook is in place.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { REGION_CORNER, RegionPlaces, buildingStyle, hollowLots, layoutOf, regionMeshes } = await import('./regionWorld.ts')

const P = CITY.pitch
interface Window { seed: number; zone: string; pack: RegionPack; layout: ReturnType<typeof layoutOf>; start: { x: number; z: number }; g: StreetGrid; lots: WorkplaceLot[] }
const WINDOWS: Window[] = [1337, 7, 42].flatMap((seed) => {
  const map = generateLakefront(seed, 64)
  return Object.entries(ZONE).filter(([name]) => name !== 'lake').map(([zone, z]) => {
    const pack = packOf(map, z)
    const layout = layoutOf(pack)
    const start = new RegionPlaces(pack, layout).spawn({ x: layout.offset.x, z: layout.offset.z })
    const g = streetGridOf(pack, layout.offset, start)!
    return { seed, zone, pack, layout, start, g, lots: regionWorkplaceLots(pack, layout, g, start, seed) }
  })
})
/** A lot's window indices. */
const local = (w: Window, l: { k: number; m: number }) => ({ i: l.k - w.g.originX / P, j: l.m - w.g.originZ / P })
/** The workplace corner of a lot, on the window's own corner graph. */
const target = (w: Window, l: { k: number; m: number; side: Side }): Corner => {
  const { i, j } = local(w, l)
  const t = targetCorner({ k: i, m: j, side: l.side })
  return { k: t.k, m: t.m, sx: t.sx, sz: t.sz }
}
const pointIn = (x: number, z: number, ring: readonly (readonly [number, number])[]): boolean => {
  let c = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j]
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c
  }
  return c
}

test('six lots of the window, each with its doorway on a two-way street the visitor can walk to; never The Spire\'s lot or the lake; the kinds in order; the same every time; the pack untouched', () => {
  for (const w of WINDOWS) {
    const at = `seed ${w.seed} ${w.zone}`
    const { lots, g } = w
    assert.equal(lots.length, ROOM.slots, `${at}: ${lots.length} lots`)
    assert.equal(new Set(lots.map((l) => `${l.k},${l.m}`)).size, lots.length, `${at}: every lot once`)
    assert.deepEqual(lots.map((l) => l.kind), WORKPLACE_KINDS.slice(0, lots.length), `${at}: the kinds in order`)
    const reach = cornerComponent(g, cornerNear(g, w.start))
    const tallest = tallestBuilding(w.pack)!
    for (const l of lots) {
      const { i, j } = local(w, l)
      assert.ok(Number.isInteger(i) && Number.isInteger(j) && i >= 0 && j >= 0 && i < g.blocks && j < g.blocks, `${at}: lot ${l.k},${l.m} is in the window`)
      assert.equal(frontOf(g, i, j, l.side), SEG.walk | SEG.drive, `${at}: lot ${l.k},${l.m}'s doorway is on a two-way street with a sidewalk`)
      assert.ok(reach.has(cornerKey(target(w, l))), `${at}: lot ${l.k},${l.m}'s workplace corner is reachable from the start`)
      assert.ok(!(Math.floor((tallest.x + w.layout.offset.x) / P) === l.k && Math.floor((tallest.z + w.layout.offset.z) / P) === l.m), `${at}: not The Spire's lot`)
      const cx = (l.k + 0.5) * P - w.layout.offset.x, cz = (l.m + 0.5) * P - w.layout.offset.z
      for (let p = 0; p < polygonCount(w.pack.water); p++) assert.ok(!polygonAt(w.pack.water, p).some((r) => pointIn(cx, cz, r)), `${at}: lot ${l.k},${l.m} is dry land`)
    }
    const before = JSON.stringify(w.pack)
    assert.deepEqual(regionWorkplaceLots(w.pack, w.layout, g, w.start, w.seed), lots, `${at}: the same lots again`)
    assert.equal(JSON.stringify(w.pack), before, `${at}: the pack is only read`)
  }
  assert.notDeepEqual(WINDOWS[0].lots, WINDOWS[5].lots, 'another seed, other doorways')
})

test('seed 1337\'s metropolis puts its six workplaces on the transit-hub lots: a low podium over the lot carrying a tower', () => {
  const w = WINDOWS.find((x) => x.seed === 1337 && x.zone === 'metropolis')!
  // Map lots: the engine's lot indices less the region corner's 50 blocks (regionWorld.ts REGION_CORNER, 2000 m).
  assert.deepEqual(w.lots.map((l) => `${l.k - 50},${l.m - 50}`).sort(), ['30,16', '30,17', '31,17', '32,17', '33,16', '33,17'])
  const on = windowLotBuildings(w.pack, w.layout.offset, w.g)
  for (const l of w.lots) {
    const { i, j } = local(w, l)
    assert.ok(podiumOf(on[j * w.g.blocks + i]), `lot ${l.k},${l.m} is a hub`)
  }
})

// ---------------------------------------------------------------- the commute, mirrored from crowd.wgsl

/** Manhattan distance between two corners' positions (towardCorner's measure). */
const apart = (g: StreetGrid, a: Corner, b: Corner) => { const p = cornerAt(g, a), q = cornerAt(g, b); return Math.abs(p.x - q.x) + Math.abs(p.z - q.z) }
/** crowd.wgsl nextCorner: the day's dice over the ways out, in its order and with its fallbacks. */
function nextCorner(g: StreetGrid, c: Corner, r: number): Corner {
  const [[ax, alongX], [az, alongZ], [cx, acrossX], [cz, acrossZ]] = cornerWays(g, c)
  if (r < 0.38 && alongX) return ax
  if (r < 0.76 && alongZ) return az
  if (r < 0.88 && acrossX) return cx
  if (acrossZ) return cz
  if (acrossX) return cx
  if (alongZ) return az
  if (alongX) return ax
  return c
}
/** crowd.wgsl towardCorner: the way out that comes nearest the destination, else the dice. */
function towardCorner(g: StreetGrid, c: Corner, dest: Corner, r: number): Corner {
  let best = c, bestD = apart(g, c, dest)
  for (const [w, open] of cornerWays(g, c)) {
    if (!open) continue
    const d = apart(g, w, dest)
    if (d < bestD - 1e-3) { bestD = d; best = w }
  }
  return best === c ? nextCorner(g, c, r) : best
}
/** crowd.wgsl routeWay, decoded on its own: slot r's 40 words, the nibble of intersection m · 17 + k. */
function routeWayOf(words: Uint32Array, r: number, k: number, m: number): number {
  if (k < 0 || m < 0 || k > 16 || m > 16) return 0
  const n = m * 17 + k
  return (words[r * 40 + Math.floor(n / 8)] >>> ((n % 8) * 4)) & 15
}
/** crowd.wgsl commuteCorner: the route table's street where the room is routed, the greedy walk where it is not. */
function commuteCorner(g: StreetGrid, words: Uint32Array, r: number, dest: Corner, c: Corner, dice: number): Corner {
  if (routeWayOf(words, r, dest.k, dest.m) !== 5) return towardCorner(g, c, dest, dice)
  const way = routeWayOf(words, r, c.k, c.m)
  if (way === 5) return towardCorner(g, c, dest, dice)
  if (way === 0) return nextCorner(g, c, dice)
  const { k, m, sx, sz } = c
  if (way === 1) return sx > 0 ? { k: k + 1, m, sx: -1, sz } : { k, m, sx: 1, sz }
  if (way === 2) return sx < 0 ? { k: k - 1, m, sx: 1, sz } : { k, m, sx: -1, sz }
  if (way === 3) return sz > 0 ? { k, m: m + 1, sx, sz: -1 } : { k, m, sx, sz: 1 }
  return sz < 0 ? { k, m: m - 1, sx, sz: 1 } : { k, m, sx, sz: -1 }
}
/** Intersections between (k, m) and every other over the window's streets with a sidewalk: a search of its own. */
function hops(g: StreetGrid, k: number, m: number): Map<string, number> {
  const out = new Map([[`${k},${m}`, 0]]), queue = [[k, m]]
  const walk = (b: number) => (b & SEG.walk) !== 0
  for (let q = 0; q < queue.length; q++) {
    const [a, b] = queue[q], d = out.get(`${a},${b}`)!
    for (const [na, nb, open] of [[a + 1, b, walk(hSeg(g, a, b))], [a - 1, b, walk(hSeg(g, a - 1, b))], [a, b + 1, walk(vSeg(g, a, b))], [a, b - 1, walk(vSeg(g, a, b - 1))]] as const) {
      if (open && !out.has(`${na},${nb}`)) { out.set(`${na},${nb}`, d + 1); queue.push([na, nb]) }
    }
  }
  return out
}

test('the route table: from every corner the visitor can reach, a commuter arrives at the workplace\'s corner within twice the streets between plus two, on streets that exist', () => {
  assert.equal(ROUTE_LINES, 17)
  assert.equal(ROUTE_ROOM_VEC4S, 10, 'a room\'s 289 nibbles in whole vec4u rows: 37 words, 10 rows')
  assert.equal(ROUTE_VEC4S, 60)
  let walks = 0
  for (const w of WINDOWS) {
    const { g } = w
    const rooms = workplacesAt(w.lots)
    const words = packRoutes(rooms, g)
    assert.equal(words.length, ROUTE_VEC4S * 4)
    assert.ok(words.subarray(rooms.length * 40).every((v) => v === 0), 'an empty slot is all zero')
    const reach = [...cornerComponent(g, cornerNear(g, w.start)).values()]
    const rng = createRng(w.seed)
    rooms.forEach((room, r) => {
      const dest = target(w, room)
      assert.equal(routeWayOf(words, r, dest.k, dest.m), ROUTE.here, `seed ${w.seed} ${w.zone} ${room.kind}: routed`)
      const between = hops(g, dest.k, dest.m)
      for (const from of reach) {
        assert.notEqual(routeWayOf(words, r, from.k, from.m), ROUTE.none, `seed ${w.seed} ${w.zone} ${room.kind}: intersection ${from.k},${from.m} has its street`)
        const limit = 2 * between.get(`${from.k},${from.m}`)! + 2
        let c = from, moves = 0
        while (cornerKey(c) !== cornerKey(dest)) {
          const next = commuteCorner(g, words, r, dest, c, rng())
          assert.ok(cornerWays(g, c).some(([way, open]) => open && cornerKey(way) === cornerKey(next)), `seed ${w.seed} ${w.zone} ${room.kind}: ${cornerKey(c)} to ${cornerKey(next)} is no street`)
          assert.ok(cornerExists(g, next.k, next.m, next.sx, next.sz))
          c = next
          assert.ok(++moves <= limit, `seed ${w.seed} ${w.zone} ${room.kind}: from ${cornerKey(from)}, still walking after ${moves} moves`)
        }
        walks++
      }
    })
  }
  assert.ok(walks > 10000, `${walks} walks`)
})

test('why the table: the greedy walk the city commutes by, with its dice, strands someone for good on seed 1337\'s windows', () => {
  // The first start that never arrives in four times as many moves as the window has reachable corners (the table
  // brings everyone in within a few dozen) is the witness.
  const strandedFrom = (): string | null => {
    for (const w of WINDOWS.filter((x) => x.seed === 1337)) {
      const reach = [...cornerComponent(w.g, cornerNear(w.g, w.start)).values()]
      const rng = createRng(99)
      for (const room of workplacesAt(w.lots)) {
        const dest = target(w, room)
        for (const from of reach) {
          let c = from
          for (let moves = 0; moves < 4 * reach.length && cornerKey(c) !== cornerKey(dest); moves++) c = towardCorner(w.g, c, dest, rng())
          if (cornerKey(c) !== cornerKey(dest)) return `${w.zone} ${room.kind} from ${cornerKey(from)}, stuck about ${cornerKey(c)}`
        }
      }
    }
    return null
  }
  assert.ok(strandedFrom() !== null, 'the greedy walk arrived from everywhere')
})

// ---------------------------------------------------------------- the hollowing (regionWorld.ts hollowLots)

const LOT_AREA = (2 * CITY.lotHalf) ** 2
/** Whether a box stands over a room's lot (its centre in the lot's square). */
const overLot = (room: { cx: number; cz: number }, { box: [x0, , z0, x1, , z1] }: Building) =>
  Math.abs((x0 + x1) / 2 - room.cx) <= CITY.lotHalf && Math.abs((z0 + z1) / 2 - room.cz) <= CITY.lotHalf
const byBox = (a: Building, b: Building) => a.box.join() < b.box.join() ? -1 : a.box.join() > b.box.join() ? 1 : 0

test('hollowing the chosen lots is a copy: their buildings at height 0 and no others, every polygon, ring and kind kept, the landmark where it was', () => {
  for (const w of WINDOWS) {
    const at = `seed ${w.seed} ${w.zone}`
    const before = JSON.stringify(w.pack)
    const h = hollowLots(w.pack, w.layout, w.lots)
    assert.equal(JSON.stringify(w.pack), before, `${at}: the pack is only read`)
    const { height, ...shape } = h.pack.buildings
    const { height: was, ...wasShape } = w.pack.buildings
    assert.deepEqual(shape, wasShape, `${at}: every polygon, ring and kind, by index`)
    assert.deepEqual({ ...h.pack, buildings: null }, { ...w.pack, buildings: null }, `${at}: the roads, the water and the names`)
    const chosen = new Set(w.lots.map((l) => `${l.k},${l.m}`))
    let hidden = 0
    for (let i = 0; i < was.length; i++) {
      const on = buildingLot(w.pack, w.layout.offset, i)
      const hide = on !== null && chosen.has(`${on.K},${on.M}`)
      assert.equal(height[i], hide ? 0 : was[i], `${at}: building ${i}`)
      if (hide) hidden++
    }
    assert.ok(hidden > 0, `${at}: something was hidden`)
    assert.deepEqual(tallestBuilding(h.pack), tallestBuilding(w.pack), `${at}: the landmark`)
    assert.deepEqual(h.rooms.map(({ kind, k, m, side }) => ({ kind, k, m, side })), w.lots, `${at}: a room on every chosen lot`)
  }
})

test('each room\'s ceiling slab carries its lot\'s podium in the podium\'s finish, and what stood above the slab stands on it as the box it was', () => {
  let carried = 0
  for (const w of WINDOWS) {
    const at = `seed ${w.seed} ${w.zone}`
    const h = hollowLots(w.pack, w.layout, w.lots)
    const on = windowLotBuildings(w.pack, w.layout.offset, w.g)
    const inRoom = new Set(h.rooms.flatMap((r) => [...r.shell, ...r.furniture]))
    for (const b of inRoom) assert.ok(h.plan.includes(b), `${at}: every shell and furniture box is drawn`)
    const lifted = h.plan.filter((b) => !inRoom.has(b))
    let above = 0
    for (const room of h.rooms) {
      const { i, j } = local(w, room)
      const here = on[j * w.g.blocks + i]
      // The podium: a low building over most of the lot (two floors at most), tower or none.
      const podium = here.find((b) => b.area >= 0.8 * LOT_AREA && b.height <= 6.6 + 1e-6)
      const top = Math.max(podium?.height ?? 0, ROOM.height + 0.3)
      const slab = room.shell[5]
      assert.deepEqual(slab.box, [room.cx - CITY.lotHalf, ROOM.height, room.cz - CITY.lotHalf, room.cx + CITY.lotHalf, top, room.cz + CITY.lotHalf], `${at} ${room.kind}: the slab`)
      assert.equal(slab.style, podium ? buildingStyle(w.pack, w.layout, podium.i) : STYLE.mixed, `${at} ${room.kind}: the slab's finish`)
      const want = here.filter((b) => b.height >= top + 3.3 - 1e-6)
        .map((b): Building => ({ box: [b.x0, top, b.z0, b.x1, b.height, b.z1], style: buildingStyle(w.pack, w.layout, b.i) }))
      assert.deepEqual(lifted.filter((b) => overLot(room, b)).sort(byBox), want.sort(byBox), `${at} ${room.kind}: carried above the slab`)
      above += want.length
    }
    assert.equal(lifted.length, above, `${at}: nothing else is drawn`)
    carried += above
  }
  assert.ok(carried > 0, 'something stood above a slab')
  // Seed 1337's metropolis: six hubs, each slab its two-floor podium, each tower carried from it.
  const m = WINDOWS.find((x) => x.seed === 1337 && x.zone === 'metropolis')!
  const h = hollowLots(m.pack, m.layout, m.lots)
  assert.deepEqual(h.rooms.map((r) => r.shell[5].box[4]), Array(6).fill(6.6))
  assert.equal(h.plan.length - h.rooms.reduce((n, r) => n + r.shell.length + r.furniture.length, 0), 6, 'a tower on each')
})

test('a building on a chosen lot that is not one plain rectangle is hidden and not carried: a turned square, a courtyard', () => {
  const w = WINDOWS.find((x) => x.seed === 1337 && x.zone === 'metropolis')!
  const pack: RegionPack = structuredClone(w.pack)
  const room = workplacesAt(w.lots)[0]
  const cx = room.cx - w.layout.offset.x, cz = room.cz - w.layout.offset.z
  pushPolygon(pack.buildings, [[[cx, cz - 6], [cx + 6, cz], [cx, cz + 6], [cx - 6, cz]]])
  pushPolygon(pack.buildings, [[[cx - 9, cz - 9], [cx + 9, cz - 9], [cx + 9, cz + 9], [cx - 9, cz + 9]], [[cx - 3, cz - 3], [cx - 3, cz + 3], [cx + 3, cz + 3], [cx + 3, cz - 3]]])
  pack.buildings.height.push(600, 600)
  pack.buildings.kind.push(0, 0)
  const n = polygonCount(pack.buildings)
  const plain = hollowLots(w.pack, w.layout, w.lots), h = hollowLots(pack, w.layout, w.lots)
  assert.deepEqual([h.pack.buildings.height[n - 2], h.pack.buildings.height[n - 1]], [0, 0], 'both hidden')
  assert.deepEqual(h.plan, plain.plan, 'neither carried')
})

test('the hollow pack draws its hidden buildings no more: the vertices drop by exactly theirs, no tile is added, and each room\'s floor is paved', () => {
  const fbm = new FbmSet(1, [64])
  for (const w of WINDOWS.filter((x) => x.zone === 'metropolis')) {
    const at = `seed ${w.seed}`
    const h = hollowLots(w.pack, w.layout, w.lots)
    const before = regionMeshes(w.pack, w.layout, fbm, uniform(0))
    const after = regionMeshes(h.pack, { ...w.layout, floors: h.floors }, fbm, uniform(0))
    // A footprint is drawn as a quad a wall edge and its roof's ring: five vertices a corner, every edge being whole.
    let hiddenVertices = 0
    for (let i = 0; i < polygonCount(w.pack.buildings); i++) {
      if (h.pack.buildings.height[i] === 0) for (const r of polygonAt(w.pack.buildings, i)) hiddenVertices += 5 * r.length
    }
    assert.ok(hiddenVertices > 0, `${at}: something hidden`)
    // Each floor is a ribbon of the sidewalks: four vertices.
    const walks = (s: { meshes: { name: string; geometry: { getAttribute(n: string): { count: number } } }[] }) => s.meshes.find((x) => x.name === 'RegionSidewalks')!.geometry.getAttribute('position').count
    assert.equal(walks(after) - walks(before), 4 * h.floors.length, `${at}: the floors are paved as sidewalk`)
    assert.equal(before.stats.vertices - after.stats.vertices, hiddenVertices - 4 * h.floors.length, `${at}: the vertices`)
    assert.ok(after.stats.tiles <= before.stats.tiles, `${at}: ${after.stats.tiles} tiles, ${before.stats.tiles} before`)
    // The floors: the room's whole lot (under the walls and the doorway's threshold) and the forecourt from the
    // doorway to the sidewalk's edge (the street's centre 20 m out, less its lane and sidewalk), 5 m across.
    const rect = (a: { x: number; z: number }, b: { x: number; z: number }) => ({ x0: Math.min(a.x, b.x), z0: Math.min(a.z, b.z), x1: Math.max(a.x, b.x), z1: Math.max(a.z, b.z) })
    const edge = CITY.pitch / 2 - 3.3 - 2.2
    assert.deepEqual(h.floors, h.rooms.flatMap((r) => [
      rect(toWorld(r, -CITY.lotHalf, -CITY.lotHalf), toWorld(r, CITY.lotHalf, CITY.lotHalf)),
      rect(toWorld(r, CITY.lotHalf, -2.5), toWorld(r, edge, 2.5)),
    ]), `${at}: the floors`)
  }
})

test('guards: the region frame and the window sit on the 40 m lot grid, and no building of a generated pack or the surveyed one is 0 high', () => {
  // The hollowing marks a hidden building with height 0 (the meshes and the physics skip it): no pack writes one
  // (compile.ts, fromMacro.ts write whole decimetres of at least one).
  assert.equal(REGION_CORNER.x % P, 0)
  assert.equal(REGION_CORNER.z % P, 0)
  for (const w of WINDOWS) {
    const at = `seed ${w.seed} ${w.zone}`
    // The generated map's own origin lands on the region corner, so its lots are the engine's, 50 blocks on.
    assert.deepEqual([w.pack.bounds.x0 + w.layout.offset.x, w.pack.bounds.z0 + w.layout.offset.z], [REGION_CORNER.x, REGION_CORNER.z], at)
    assert.deepEqual([w.g.originX % P, w.g.originZ % P], [0, 0], at)
    assert.ok(w.pack.buildings.height.every((x) => x >= 1), `${at}: every building at least a decimetre`)
  }
  const pilot = new URL('../../../world/pilot.region.json.gz', import.meta.url)
  if (existsSync(pilot)) {
    const pack = validatePack(JSON.parse(gunzipSync(readFileSync(pilot)).toString('utf8')))
    assert.ok(pack.buildings.height.every((x) => x >= 1), 'the pilot: every building at least a decimetre')
  }
})
