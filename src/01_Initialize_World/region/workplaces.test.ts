// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? Lakefront Metro's workplaces stand on lots of its pack (region/placement.ts chooses them,
 * placement.test.ts holds the choice) and are walked to on a street window that has dropped streets, dead ends and
 * water. These tests hold what region/workplaces.ts gives that choice and that walk, on the real generated map (three
 * seeds, the five zones each, each from the start the engine gives it). They hold the route table, through a mirror of
 * the shader's commute (crowd.wgsl commuteCorner): from every corner that can reach a room's, a commuter arrives at it
 * within twice the streets between plus two, on streets that exist, for sixteen rooms a window (the window's
 * best-built lots: a fixture, so that every slot is walked) and for the placement's own rooms that stand on the
 * window; a room off the window has no table; while the greedy walk the city uses, with its dice, strands someone for
 * good. And they hold the hollowing (regionWorld.ts hollowLots) of the placement's sixteen lots, wherever on the map
 * they stand: a copy of the pack with only the chosen lots' buildings put out of sight, the ceiling slab in the
 * podium's finish, what stood above the slab carried on it as the box it was, the meshes short of exactly the hidden
 * buildings, and the frame facts it leans on. And they hold the lot and corner helpers to reading the whole map's grid
 * (streets.ts mapStreetGrid) as they read the window: the same buildings on the same lots, the same fronts, a window's
 * candidates the map's own with the corners the window cannot reach left out, and, with no start, the lots the largest
 * part of the corner graph reaches, which on these maps is every dry lot with a two-way front but The Spire's.
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
import { LOT, STREET } from '../macroCity.ts'
import { polygonAt, polygonCount, pushPolygon, tallestBuilding, validatePack, type RegionPack } from './pack.ts'
import { regionPlacement } from './placement.ts'
import { SEG, WINDOW_GEOMETRY, hSeg, lotInWindow, mapStreetGrid, streetGridOf, vSeg, type StreetGrid } from './streets.ts'
import {
  ROUTE, ROUTE_LINES, ROUTE_ROOM_VEC4S, ROUTE_VEC4S, buildingLot, cornerAt, cornerComponent, cornerExists, cornerKey, cornerNear, cornerWays, frontOf,
  largestCornerComponent, lotCandidates, lotTier, packRoutes, windowLotBuildings, type Corner, type LotCandidate,
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
const { REGION_CORNER, RegionPlaces, buildingStyle, hollowLots, layoutOf, regionMeshes, regionStart } = await import('./regionWorld.ts')

const P = CITY.pitch
interface Window {
  seed: number; zone: string; pack: RegionPack; layout: ReturnType<typeof layoutOf>; start: { x: number; z: number }
  /** The street window round the start, and the whole map's grid. */
  g: StreetGrid
  map: StreetGrid
  /** The placement's sixteen workplaces: all over the map, the same lots whichever zone the pack starts in. */
  lots: WorkplaceLot[]
  /** Sixteen rooms on the window's own lots, for the route table: the best built first, then the nearest the start. */
  near: WorkplaceLot[]
}
const WINDOWS: Window[] = [1337, 7, 42].flatMap((seed) => {
  const map = generateLakefront(seed, 64)
  return Object.entries(ZONE).filter(([name]) => name !== 'lake').map(([zone, z]) => {
    const pack = packOf(map, z)
    const layout = layoutOf(pack)
    const placement = regionPlacement(pack, layout, seed)!
    const start = regionStart(pack, layout, new RegionPlaces(pack, layout), placement)
    const g = streetGridOf(pack, layout.offset, start)!
    const near = lotCandidates(pack, layout, g, start).sort((a, b) => a.tier - b.tier || a.ring - b.ring || a.j - b.j || a.i - b.i).slice(0, ROOM.slots)
      .map((c, n): WorkplaceLot => ({ kind: WORKPLACE_KINDS[n], k: g.originX / P + c.i, m: g.originZ / P + c.j, side: c.sides[0] }))
    return { seed, zone, pack, layout, start, g, map: mapStreetGrid(pack, layout.offset)!, lots: placement.workplaces, near }
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
  assert.equal(ROUTE_VEC4S, 160, 'sixteen slots of ten rows')
  let walks = 0
  for (const w of WINDOWS) {
    const { g } = w
    // Every window of the three seeds has sixteen lots a room could stand on (the fixture: every slot is walked).
    assert.equal(w.near.length, ROOM.slots, `seed ${w.seed} ${w.zone}: ${w.near.length} lots`)
    const rooms = workplacesAt(w.near)
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

test('the placement\'s own rooms: one on the window\'s lots is routed, from every corner that reaches its own, in its own slot; one off the window has no table; every window has a room to walk to', () => {
  let onWindow = 0, walks = 0
  for (const w of WINDOWS) {
    const at = `seed ${w.seed} ${w.zone}`
    const { g } = w
    const rooms = workplacesAt(w.lots)
    assert.equal(rooms.length, ROOM.slots, `${at}: sixteen rooms on the map`)
    const words = packRoutes(rooms, g)
    const rng = createRng(w.seed)
    let here = 0, fromStart = 0
    rooms.forEach((room, r) => {
      const slot = words.subarray(r * ROUTE_ROOM_VEC4S * 4, (r + 1) * ROUTE_ROOM_VEC4S * 4)
      if (!lotInWindow(g, room.k, room.m)) {
        // Even a room on the lot just outside, whose workplace corner is one of the window's own intersections.
        assert.ok(slot.every((v) => v === 0), `${at} ${room.kind}: off the window, no table`)
        return
      }
      here++
      const dest = target(w, room)
      assert.equal(routeWayOf(words, r, dest.k, dest.m), ROUTE.here, `${at} ${room.kind}: routed`)
      // Everyone who can reach the room's corner over the window's sidewalks does, by the table.
      const between = hops(g, dest.k, dest.m)
      for (const from of cornerComponent(g, dest).values()) {
        const limit = 2 * between.get(`${from.k},${from.m}`)! + 2
        let c = from, moves = 0
        while (cornerKey(c) !== cornerKey(dest)) {
          c = commuteCorner(g, words, r, dest, c, rng())
          assert.ok(++moves <= limit, `${at} ${room.kind}: from ${cornerKey(from)}, still walking after ${moves} moves`)
        }
        walks++
      }
      if (cornerComponent(g, dest).has(cornerKey(cornerNear(g, w.start)))) fromStart++
    })
    // A window's streets are cut where it ends and at a ravine, so a room across one may be out of the start's reach
    // inside the window (its workers on the far side walk as anyone does); never every room.
    assert.ok(here >= 2 && fromStart >= 1, `${at}: ${here} rooms on the window, ${fromStart} the start's corner walks to inside it`)
    onWindow += here
  }
  assert.ok(onWindow >= 30 && walks > 10000, `${onWindow} rooms on their windows, ${walks} walks`)
})

test('why the table: the greedy walk the city commutes by, with its dice, strands someone for good on seed 1337\'s windows', () => {
  // The first start that never arrives in four times as many moves as the window has reachable corners (the table
  // brings everyone in within a few dozen) is the witness.
  const strandedFrom = (): string | null => {
    for (const w of WINDOWS.filter((x) => x.seed === 1337)) {
      const reach = [...cornerComponent(w.g, cornerNear(w.g, w.start)).values()]
      const rng = createRng(99)
      for (const room of workplacesAt(w.near)) {
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

// ---------------------------------------------------------------- the helpers on the whole map's grid

test('the lot and corner helpers read the whole map\'s grid as they read the window: the same buildings on the same lots, the same fronts; a window\'s candidates are the map\'s, less the corners the window cannot reach', () => {
  const two = SEG.walk | SEG.drive
  for (const w of WINDOWS) {
    const at = `seed ${w.seed} ${w.zone}`
    const g = mapStreetGrid(w.pack, w.layout.offset)
    assert.ok(g, `${at}: the map has a grid`)
    const S = g.blocks
    assert.deepEqual([g.originX, g.originZ, S], [REGION_CORNER.x, REGION_CORNER.z, 64], at)
    // Where the window's lot (0, 0) is on the map's grid.
    const di = (w.g.originX - g.originX) / P, dj = (w.g.originZ - g.originZ) / P
    assert.ok(Number.isInteger(di) && Number.isInteger(dj) && di >= 0 && dj >= 0 && di + w.g.blocks <= S && dj + w.g.blocks <= S, `${at}: the window is on the map`)
    // The buildings: every building of the pack on one lot's list (each stands on a lot), and a window lot's list is the map lot's.
    const onMap = windowLotBuildings(w.pack, w.layout.offset, g), onWin = windowLotBuildings(w.pack, w.layout.offset, w.g)
    assert.equal(onMap.length, S * S)
    assert.equal(onMap.reduce((n, l) => n + l.length, 0), polygonCount(w.pack.buildings), `${at}: every building once`)
    onMap.forEach((list, n) => {
      for (const b of list) {
        const lot = buildingLot(w.pack, w.layout.offset, b.i)
        if (!lot || lot.K - g.originX / P !== n % S || lot.M - g.originZ / P !== Math.floor(n / S)) assert.fail(`${at}: building ${b.i} is listed on lot ${n % S}, ${Math.floor(n / S)}`)
      }
    })
    for (let j = 0; j < w.g.blocks; j++) for (let i = 0; i < w.g.blocks; i++) {
      assert.deepEqual(onWin[j * w.g.blocks + i], onMap[(j + dj) * S + i + di], `${at}: lot ${i}, ${j}`)
      for (const side of [0, 1, 2, 3] as const) if (frontOf(w.g, i, j, side) !== frontOf(g, i + di, j + dj, side)) assert.fail(`${at}: lot ${i}, ${j}'s front ${side}`)
    }
    // The corner graph: whatever the window's graph reaches from the start, the map's reaches too, and more.
    const reachWin = cornerComponent(w.g, cornerNear(w.g, w.start)), reachMap = cornerComponent(g, cornerNear(g, w.start))
    for (const c of reachWin.values()) if (!reachMap.has(cornerKey({ ...c, k: c.k + di, m: c.m + dj }))) assert.fail(`${at}: corner ${cornerKey(c)} of the window is not reached on the map`)
    assert.ok(reachMap.size > 4 * reachWin.size, `${at}: ${reachMap.size} corners on the map, ${reachWin.size} in the window`)
    // The candidates on the map, for the same start: each front a two-way street whose corner the start reaches, the
    // tier the lot's, the ring from the start's lot. (Before, any grid but a window's was refused.)
    const before = JSON.stringify(w.pack)
    const onTheMap = lotCandidates(w.pack, w.layout, g, w.start)
    assert.equal(JSON.stringify(w.pack), before, `${at}: the pack is only read`)
    const si = Math.floor((w.start.x - g.originX) / P), sj = Math.floor((w.start.z - g.originZ) / P)
    for (const c of onTheMap) {
      assert.ok(c.sides.length > 0 && c.sides.every((side) => frontOf(g, c.i, c.j, side) === two && reachMap.has(cornerKey(targetCorner({ k: c.i, m: c.j, side })))), `${at}: lot ${c.i}, ${c.j}'s fronts`)
      assert.equal(c.tier, lotTier(onMap[c.j * S + c.i]), `${at}: lot ${c.i}, ${c.j}'s tier`)
      assert.equal(c.ring, Math.max(Math.abs(c.i - si), Math.abs(c.j - sj)), `${at}: lot ${c.i}, ${c.j}'s ring`)
    }
    assert.deepEqual(onTheMap.map((c) => c.j * S + c.i), onTheMap.map((c) => c.j * S + c.i).sort((a, b) => a - b), `${at}: in row order`)
    assert.ok(onTheMap.length > 2500, `${at}: ${onTheMap.length} candidates on the map`)
    // The window's candidates are the map's inside the window, in the window's own indices, each with the fronts
    // whose corner the window's own graph reaches (a lot whose every such corner is reached only by leaving the
    // window is no candidate of the window).
    const cropped: LotCandidate[] = []
    for (const c of onTheMap) {
      const i = c.i - di, j = c.j - dj
      if (i < 0 || j < 0 || i >= w.g.blocks || j >= w.g.blocks) continue
      const sides = c.sides.filter((side) => reachWin.has(cornerKey(targetCorner({ k: i, m: j, side }))))
      if (sides.length) cropped.push({ i, j, tier: c.tier, ring: c.ring, sides })
    }
    assert.deepEqual(lotCandidates(w.pack, w.layout, w.g, w.start), cropped, `${at}: the window's candidates`)
    // The route table and the shader's field stay the window's.
    assert.throws(() => packRoutes(workplacesAt(w.lots), g), RangeError)
  }
})

test('with no start the largest part of the corner graph decides: on the generated maps, every dry lot with a two-way front but The Spire\'s; on a grid in parts, the largest, and the first of two as large', () => {
  const twoWay = (kind: number) => kind !== STREET.none && kind !== STREET.pedestrian
  for (const w of WINDOWS.filter((x) => x.zone === 'metropolis' || x.zone === 'grandRavine')) {
    const at = `seed ${w.seed} ${w.zone}`
    const map = generateLakefront(w.seed, 64)
    const g = mapStreetGrid(w.pack, w.layout.offset)!
    const S = g.blocks
    // The map's sidewalks are one piece: the largest part is every corner there is, and any start reaches it.
    const whole = largestCornerComponent(g)
    let corners = 0
    for (let m = 0; m <= S; m++) for (let k = 0; k <= S; k++) for (const sz of [-1, 1]) for (const sx of [-1, 1]) if (cornerExists(g, k, m, sx, sz)) corners++
    assert.equal(whole.size, corners, `${at}: one corner graph`)
    assert.ok(corners > 12000, `${at}: ${corners} corners`)
    assert.deepEqual([...whole.keys()].sort(), [...cornerComponent(g, cornerNear(g, w.start)).keys()].sort(), `${at}: the start's part is the largest`)
    // So the candidates are read off the generated map itself: a lot that is not water, not The Spire's, with a street
    // front of two lanes (interiors.ts Side: 0 the street south of the lot, 1 north, 2 east, 3 west).
    const want: [number, number, number[]][] = []
    for (let m = 0; m < S; m++) for (let k = 0; k < S; k++) {
      if (map.lots[m * S + k] === LOT.water || (k === map.spire.k && m === map.spire.m)) continue
      const sides = [map.hStreets[(m + 1) * S + k], map.hStreets[m * S + k], map.vStreets[(k + 1) * S + m], map.vStreets[k * S + m]].flatMap((kind, side) => (twoWay(kind) ? [side] : []))
      if (sides.length) want.push([k, m, sides])
    }
    const free = lotCandidates(w.pack, w.layout, g)
    assert.deepEqual(free.map((c) => [c.i, c.j, c.sides]), want, `${at}: the candidates`)
    assert.ok(free.every((c) => c.ring === 0), `${at}: no start, no ring`)
    assert.deepEqual(lotCandidates(w.pack, w.layout, g, null), free, `${at}: null is no start`)
    // The same lots as any start gives on a map in one piece, the ring apart.
    assert.deepEqual(lotCandidates(w.pack, w.layout, g, w.start).map((c) => ({ ...c, ring: 0 })), free, `${at}: a start changes the ring alone`)
    const land = map.lots.reduce((n, lot) => n + (lot === LOT.water ? 0 : 1), 0)
    assert.ok(free.length >= land - 3 && free.length < land, `${at}: ${free.length} candidates of ${land} dry lots`)
    if (w.seed === 1337) assert.equal(free.length, 2923, `${at}: every dry lot but The Spire's`)
    // The same lots whichever quarter the pack starts in: lot indices are the engine's, the same for every start.
    if (w.zone === 'grandRavine') {
      const other = WINDOWS.find((x) => x.seed === w.seed && x.zone === 'metropolis')!
      assert.deepEqual(free, lotCandidates(other.pack, other.layout, mapStreetGrid(other.pack, other.layout.offset)!), `${at}: as from the metropolis`)
    }
  }
  // A grid in parts, by hand: one street of a block in the north-west (four corners), one of two blocks further on
  // (eight), one of a block below (four).
  const grid = (...h: [number, number][]): StreetGrid => {
    const g: StreetGrid = { originX: 0, originZ: 0, blocks: 6, ...WINDOW_GEOMETRY, h: new Uint8Array(7 * 6), v: new Uint8Array(7 * 6) }
    for (const [k, m] of h) g.h[m * 6 + k] = SEG.walk
    return g
  }
  const parts = largestCornerComponent(grid([0, 0], [3, 4], [4, 4], [0, 2]))
  assert.deepEqual([...parts.keys()].sort(), ['3,4,1,-1', '3,4,1,1', '4,4,-1,-1', '4,4,-1,1', '4,4,1,-1', '4,4,1,1', '5,4,-1,-1', '5,4,-1,1'], 'the largest part, though it is not the first')
  const tie = largestCornerComponent(grid([0, 2], [0, 0]))
  assert.deepEqual([...tie.keys()].sort(), ['0,0,1,-1', '0,0,1,1', '1,0,-1,-1', '1,0,-1,1'], 'of two as large, the first in row order')
  assert.equal(largestCornerComponent(grid()).size, 0, 'no sidewalk, no corner')
  assert.equal(cornerComponent(grid([0, 0]), { k: 3, m: 3, sx: 1, sz: 1 }).size, 0)
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
    const on = windowLotBuildings(w.pack, w.layout.offset, w.map)
    const inRoom = new Set(h.rooms.flatMap((r) => [...r.shell, ...r.furniture]))
    for (const b of inRoom) assert.ok(h.plan.includes(b), `${at}: every shell and furniture box is drawn`)
    const lifted = h.plan.filter((b) => !inRoom.has(b))
    let above = 0
    for (const room of h.rooms) {
      const here = on[(room.m - w.map.originZ / P) * w.map.blocks + room.k - w.map.originX / P]
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
  // Seed 1337: three rooms stand on a hub (the robotics lab, the control tower and the acoustics chamber, each by its
  // quarter's heart), their slab the hub's two-floor podium; every other slab is the room's least (4.5 m).
  const m = WINDOWS.find((x) => x.seed === 1337 && x.zone === 'metropolis')!
  const h = hollowLots(m.pack, m.layout, m.lots)
  const hubs = new Set(['roboticsLab', 'controlTower', 'acousticsLab'])
  assert.deepEqual(h.rooms.map((r) => r.shell[5].box[4]), h.rooms.map((r) => (hubs.has(r.kind) ? 6.6 : ROOM.height + 0.3)))
  // What is carried: the tower of each hub, and the towers of the core's four tower lots (the server vault, the twin
  // studio, the clearing floor and the console deck, two each), a tall building on two more.
  const carriedOn = (kind: string) => { const r = h.rooms.find((x) => x.kind === kind)!; return h.plan.filter((b) => !r.shell.includes(b) && !r.furniture.includes(b) && overLot(r, b)).length }
  assert.deepEqual(WORKPLACE_KINDS.map(carriedOn), [1, 0, 2, 1, 1, 0, 0, 2, 0, 0, 1, 0, 2, 1, 0, 2])
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
