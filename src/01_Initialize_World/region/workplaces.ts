// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It gives a generated region (Lakefront Metro, through its street window, streets.ts) the
 * procedural city's six indoor workplaces (interiors.ts): which lots of the window become rooms, which street front
 * each doorway faces, and the commute's route table the crowd shader walks to them.
 * - The lots. The city picks its six from the seed alone, on a grid where every lot has four streets. A region's
 *   window has dropped streets, pedestrian streets, water and ravines, so the lots are read from the pack: a lot is a
 *   candidate when one of its street fronts is a two-way street with a sidewalk (SEG.walk | SEG.drive) whose sidewalk
 *   corner on the corner graph is reachable from where the visitor starts. The candidates are ranked by what stands on
 *   them (a low podium carrying a tower first: the transit hubs, whose podium becomes the ceiling and whose tower is
 *   carried above the room; then lots one or two tall buildings fill; then one mid-rise; then one low building; then
 *   open lots), then by how near the start's lot they are, then by the seed's dice; never the tallest building's lot
 *   (the landmark stays) and never a lot under water. Six at most, the kinds in WORKPLACE_KINDS order; fewer is legal.
 *   The page picks them and the physics worker receives them as data (simProtocol.ts SimInit.workplaces), so the two
 *   never disagree.
 * - The route table. The city's commuters walk the corner graph greedily towards the workplace's corner, which always
 *   arrives where every street exists. In a window it can stall against a missing street for good. So each room gets
 *   a table over the window's intersections (packRoutes, crowd.wgsl Params.routes): from each intersection, the street
 *   to take to come one intersection nearer the workplace's (a breadth-first search over the streets with a sidewalk),
 *   5 at the workplace's own, 0 where it cannot be reached. The procedural city's table is all zero: its commute is
 *   the greedy one, bit for bit.
 * Pure, and no three.js: the physics worker builds the route table from it.
 * What breaks if it is removed? Lakefront Metro has no indoor workplaces: no rooms, no workday, nobody at work indoors.
 */
import { createRng } from '../../02_Define_The_Rules/degrees.ts'
import { CITY } from '../city.ts'
import { ROOM, WORKPLACE_KINDS, targetCorner, type Side, type WorkplaceLot } from '../interiors.ts'
import { DM, polygonAt, polygonCount, tallestBuilding, type Polygons, type RegionPack } from './pack.ts'
import { SEG, WINDOW_BLOCKS, hSeg, vSeg, type StreetGrid } from './streets.ts'

const P = CITY.pitch
/** A lot's square, m: CITY.lotHalf either side of the lot's centre, the macro map's built square (macroCity.ts). */
const LOT_HALF = CITY.lotHalf
const LOT_AREA = (2 * LOT_HALF) ** 2

/**
 * How a candidate lot is ranked by what stands on it (lakefront.ts footprints; its floors are 3.3 m, so two floors are
 * 6.6 m and ten are 33 m): the cover is the buildings' area over the lot's.
 */
export const LOT_TIERS = Object.freeze({
  /** A hub's podium: this much of the lot, at most this high, m, carrying a tower at least `tower` high. */
  podiumCover: 0.8,
  podiumTop: 6.6,
  tower: 33,
  /** One or two buildings covering this much, the tallest at least `tower`. */
  pairCover: 0.6,
  /** One building covering this much (a mid-rise at least `mid` high first). */
  oneCover: 0.4,
  mid: 6.6,
  /** An open lot: under this much cover. */
  open: 0.1,
})

/** A building as the lot rules read it: its index in the pack, its outer ring's box (engine metres), area and height. */
export interface LotBuilding { i: number; x0: number; z0: number; x1: number; z1: number; area: number; height: number }

/** Twice the signed area of a ring. */
const area2 = (r: readonly (readonly [number, number])[]): number => {
  let s = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1]
  return s
}

/**
 * The lot building `i` of the pack stands on, (K, M) in the engine's lot indices (between streets K and K + 1, M and
 * M + 1), or null: a building is on a lot when the centre of its outer ring's box lies in the lot's square. `offset`
 * is the layout's (regionWorld.ts layoutOf).
 */
export function buildingLot(pack: Pick<RegionPack, 'buildings'>, offset: { x: number; z: number }, i: number): { K: number; M: number; b: LotBuilding } | null {
  const ring = polygonAt(pack.buildings, i)[0]
  if (!ring || ring.length < 3) return null
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
  for (const [x, z] of ring) {
    x0 = Math.min(x0, x + offset.x); x1 = Math.max(x1, x + offset.x)
    z0 = Math.min(z0, z + offset.z); z1 = Math.max(z1, z + offset.z)
  }
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2
  const K = Math.floor(cx / P), M = Math.floor(cz / P)
  const lx = cx - (K + 0.5) * P, lz = cz - (M + 0.5) * P
  if (!(Math.abs(lx) <= LOT_HALF && Math.abs(lz) <= LOT_HALF)) return null
  const height = (pack.buildings.height[i] ?? 0) / DM
  return { K, M, b: { i, x0, z0, x1, z1, area: Math.abs(area2(ring)) / 2, height } }
}

/** The buildings standing on each lot of the window, by window lot index j · blocks + i. */
export function windowLotBuildings(pack: Pick<RegionPack, 'buildings'>, offset: { x: number; z: number }, g: StreetGrid): LotBuilding[][] {
  const B = g.blocks, K0 = g.originX / P, M0 = g.originZ / P
  const out: LotBuilding[][] = Array.from({ length: B * B }, () => [])
  for (let i = 0; i < polygonCount(pack.buildings); i++) {
    const at = buildingLot(pack, offset, i)
    if (!at) continue
    const wi = at.K - K0, wj = at.M - M0
    if (wi >= 0 && wi < B && wj >= 0 && wj < B) out[wj * B + wi].push(at.b)
  }
  return out
}

/** Whether a building is a podium: low (LOT_TIERS podiumTop) and over most of its lot (podiumCover). */
const lowAndBroad = (p: LotBuilding): boolean => p.area >= LOT_TIERS.podiumCover * LOT_AREA && p.height <= LOT_TIERS.podiumTop + 1e-6

/** A lot's hub podium (LOT_TIERS: low, over most of the lot, carrying a tower within its box), or null. */
export function podiumOf(on: readonly LotBuilding[]): LotBuilding | null {
  const eps = 1e-6
  for (const p of on) {
    if (!lowAndBroad(p)) continue
    const tower = on.some((t) => t !== p && t.height >= LOT_TIERS.tower - eps && t.x0 >= p.x0 && t.x1 <= p.x1 && t.z0 >= p.z0 && t.z1 <= p.z1)
    if (tower) return p
  }
  return null
}

/**
 * The podium a room's ceiling slab stands for (regionWorld.ts hollowLots), or null: a low building over most of the
 * lot, carrying a tower or not. The slab takes its height and its finish, so the street sees the podium it saw before.
 */
export function slabPodium(on: readonly LotBuilding[]): LotBuilding | null {
  return on.find(lowAndBroad) ?? null
}

/** The lot's tier, 0 (a hub's podium and tower) to 5 (anything else): LOT_TIERS. */
export function lotTier(on: readonly LotBuilding[]): number {
  const eps = 1e-6
  if (podiumOf(on)) return 0
  const cover = on.reduce((s, b) => s + b.area, 0) / LOT_AREA
  const tallest = on.reduce((h, b) => Math.max(h, b.height), 0)
  if (on.length >= 1 && on.length <= 2 && tallest >= LOT_TIERS.tower - eps && cover >= LOT_TIERS.pairCover) return 1
  if (on.length === 1 && on[0].height >= LOT_TIERS.mid - eps && on[0].area >= LOT_TIERS.oneCover * LOT_AREA) return 2
  if (on.length === 1 && on[0].area >= LOT_TIERS.oneCover * LOT_AREA) return 3
  if (cover < LOT_TIERS.open) return 4
  return 5
}

// ---------------------------------------------------------------- the corner graph (crowd.wgsl's, mirrored)

/** A sidewalk corner: quadrant (sx, sz) of window intersection (k, m), as crowd.wgsl cornerPos has it. */
export interface Corner { k: number; m: number; sx: 1 | -1; sz: 1 | -1 }

const walk = (bits: number): boolean => (bits & SEG.walk) !== 0
/** crowd.wgsl cornerExists: a corner exists where one of its two streets has a sidewalk. */
export function cornerExists(g: StreetGrid, k: number, m: number, sx: number, sz: number): boolean {
  return walk(hSeg(g, sx > 0 ? k : k - 1, m)) || walk(vSeg(g, k, sz > 0 ? m : m - 1))
}

/**
 * The four ways out of corner c as crowd.wgsl nextCorner and towardCorner have them, in their order (along the
 * east-west street, along the north-south one, across the north-south line, across the east-west one), each with
 * whether the window has it.
 */
export function cornerWays(g: StreetGrid, c: Corner): [Corner, boolean][] {
  const { k, m, sx, sz } = c
  const nk = k + sx, nm = m + sz
  const flip = (s: 1 | -1): 1 | -1 => (s > 0 ? -1 : 1)
  return [
    [{ k: nk, m, sx: flip(sx), sz }, walk(hSeg(g, Math.min(k, nk), m))],
    [{ k, m: nm, sx, sz: flip(sz) }, walk(vSeg(g, k, Math.min(m, nm)))],
    [{ k, m, sx: flip(sx), sz }, cornerExists(g, k, m, -sx, sz)],
    [{ k, m, sx, sz: flip(sz) }, cornerExists(g, k, m, sx, -sz)],
  ]
}

export const cornerKey = (c: Corner): string => `${c.k},${c.m},${c.sx},${c.sz}`

/** Where a corner stands, engine metres (crowd.wgsl cornerPos), on the window's lane. */
export function cornerAt(g: StreetGrid, c: Corner): { x: number; z: number } {
  return { x: g.originX + c.k * P + c.sx * g.lane, z: g.originZ + c.m * P + c.sz * g.lane }
}

/** The corner nearest p on p's own block (crowd.wgsl cornerOf): where someone standing at p walks the graph from. */
export function cornerNear(g: StreetGrid, p: { x: number; z: number }): Corner {
  const x = p.x - g.originX, z = p.z - g.originZ
  const k = Math.round(x / P), m = Math.round(z / P)
  return { k, m, sx: x - k * P >= 0 ? 1 : -1, sz: z - m * P >= 0 ? 1 : -1 }
}

/** Every corner reachable on the corner graph from `from` (none when `from` itself does not exist), by key. */
export function cornerComponent(g: StreetGrid, from: Corner): Map<string, Corner> {
  const seen = new Map<string, Corner>()
  if (!cornerExists(g, from.k, from.m, from.sx, from.sz)) return seen
  seen.set(cornerKey(from), from)
  const stack = [from]
  while (stack.length) {
    const c = stack.pop()!
    for (const [w, open] of cornerWays(g, c)) {
      if (!open || seen.has(cornerKey(w))) continue
      seen.set(cornerKey(w), w)
      stack.push(w)
    }
  }
  return seen
}

// ---------------------------------------------------------------- the lots

/** The street segment of a lot's front `side` (interiors.ts Side), window lot (i, j). */
export function frontOf(g: StreetGrid, i: number, j: number, side: Side): number {
  return side === 0 ? hSeg(g, i, j + 1) : side === 1 ? hSeg(g, i, j) : side === 2 ? vSeg(g, i + 1, j) : vSeg(g, i, j)
}

const pointIn = (x: number, z: number, ring: readonly (readonly [number, number])[]): boolean => {
  let c = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j]
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c
  }
  return c
}
/** Whether (x, z), in the pack's own metres, lies in a water polygon (even-odd over its rings). */
const inWater = (water: Polygons, x: number, z: number): boolean => {
  for (let i = 0; i < polygonCount(water); i++) {
    let inside = false
    for (const ring of polygonAt(water, i)) if (pointIn(x, z, ring)) inside = !inside
    if (inside) return true
  }
  return false
}

/**
 * The region's workplace lots in the window `g` (streets.ts streetGridOf), for a visitor starting at `start` (engine
 * metres): at most ROOM.slots, in WORKPLACE_KINDS order, as interiors.ts workplacesAt takes them (engine lot indices).
 * The ranking is the file's header's: the tier (lotTier), then the Chebyshev ring of lots from the start's, then the
 * dice (createRng(seed ^ 0x1a7e): one draw per window lot in row order, then one per pick for its doorway's side
 * among the fronts that qualify). Deterministic, and the pack is only read.
 */
export function regionWorkplaceLots(pack: RegionPack, layout: { offset: { x: number; z: number } }, g: StreetGrid, start: { x: number; z: number }, seed: number): WorkplaceLot[] {
  if (g.blocks !== WINDOW_BLOCKS) throw new RangeError(`a street window is ${WINDOW_BLOCKS} blocks across, got ${g.blocks}`)
  const B = g.blocks, K0 = g.originX / P, M0 = g.originZ / P, off = layout.offset
  const on = windowLotBuildings(pack, off, g)
  const landmark = tallestBuilding(pack)
  const tallK = landmark ? Math.floor((landmark.x + off.x) / P) : NaN, tallM = landmark ? Math.floor((landmark.z + off.z) / P) : NaN
  const reach = cornerComponent(g, cornerNear(g, start))
  const rng = createRng((seed ^ 0x1a7e) >>> 0)
  const dice = new Float64Array(B * B)
  for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) dice[j * B + i] = rng()
  const si = Math.floor((start.x - g.originX) / P), sj = Math.floor((start.z - g.originZ) / P)
  const two = SEG.walk | SEG.drive
  const candidates: { i: number; j: number; tier: number; ring: number; sides: Side[] }[] = []
  for (let j = 0; j < B; j++) {
    for (let i = 0; i < B; i++) {
      if (K0 + i === tallK && M0 + j === tallM) continue
      if (inWater(pack.water, (K0 + i + 0.5) * P - off.x, (M0 + j + 0.5) * P - off.z)) continue
      const sides = ([0, 1, 2, 3] as const).filter((side) => {
        if (frontOf(g, i, j, side) !== two) return false
        const t = targetCorner({ k: i, m: j, side })
        return reach.has(cornerKey(t))
      })
      if (sides.length === 0) continue
      candidates.push({ i, j, tier: lotTier(on[j * B + i]), ring: Math.max(Math.abs(i - si), Math.abs(j - sj)), sides })
    }
  }
  candidates.sort((a, b) => a.tier - b.tier || a.ring - b.ring || dice[a.j * B + a.i] - dice[b.j * B + b.i] || a.j - b.j || a.i - b.i)
  return candidates.slice(0, ROOM.slots).map((c, n) => ({
    kind: WORKPLACE_KINDS[n], k: K0 + c.i, m: M0 + c.j, side: c.sides[Math.min(c.sides.length - 1, Math.floor(rng() * c.sides.length))],
  }))
}

// ---------------------------------------------------------------- the route table (crowd.wgsl Params.routes)

/** Intersections per axis of the window. */
export const ROUTE_LINES = WINDOW_BLOCKS + 1
/** A room's table: four bits per intersection (index m · ROUTE_LINES + k), eight to a word, in whole vec4u rows. */
export const ROUTE_ROOM_WORDS = Math.ceil((ROUTE_LINES * ROUTE_LINES) / 8)
export const ROUTE_ROOM_VEC4S = Math.ceil(ROUTE_ROOM_WORDS / 4)
/** The whole table (crowd.wgsl ROUTE_VEC4S): one room's per slot. */
export const ROUTE_VEC4S = ROOM.slots * ROUTE_ROOM_VEC4S

/** The codes: none (not reachable), the street to take (one intersection nearer along +x, −x, +z, −z), or here. */
export const ROUTE = Object.freeze({ none: 0, east: 1, west: 2, south: 3, north: 4, here: 5 })

/** The code room slot `r`'s table holds for window intersection (k, m) in packed `words` (crowd.wgsl routeWay). */
export function routeWay(words: Uint32Array, r: number, k: number, m: number): number {
  if (k < 0 || m < 0 || k >= ROUTE_LINES || m >= ROUTE_LINES) return ROUTE.none
  const n = m * ROUTE_LINES + k
  return (words[r * ROUTE_ROOM_VEC4S * 4 + (n >> 3)] >>> ((n & 7) * 4)) & 15
}

/**
 * The route table of the rooms (interiors.ts Workplace, on lots of window `g`) as crowd.wgsl reads it: per room slot,
 * a breadth-first search from the intersection of the room's workplace corner (interiors.ts targetCorner) over the
 * window's streets with a sidewalk, each intersection given the first street (in the order +x, −x, +z, −z) that leads
 * one intersection nearer. A slot with no room, or a room whose corner is outside the window, is all zero (the greedy
 * commute). Little-endian nibbles in u32s, ROUTE_ROOM_VEC4S rows per slot.
 */
export function packRoutes(rooms: readonly { k: number; m: number; side: Side }[], g: StreetGrid): Uint32Array {
  if (g.blocks !== WINDOW_BLOCKS) throw new RangeError(`a street window is ${WINDOW_BLOCKS} blocks across, got ${g.blocks}`)
  if (rooms.length > ROOM.slots) throw new RangeError(`at most ${ROOM.slots} rooms`)
  const words = new Uint32Array(ROUTE_VEC4S * 4)
  const L = ROUTE_LINES, K0 = g.originX / P, M0 = g.originZ / P
  // The streets out of intersection (k, m), in code order, with the neighbour each leads to.
  const ways = (k: number, m: number): [number, number, boolean][] => [
    [k + 1, m, walk(hSeg(g, k, m))], [k - 1, m, walk(hSeg(g, k - 1, m))],
    [k, m + 1, walk(vSeg(g, k, m))], [k, m - 1, walk(vSeg(g, k, m - 1))],
  ]
  rooms.forEach((room, r) => {
    const t = targetCorner(room)
    const tk = t.k - K0, tm = t.m - M0
    if (tk < 0 || tm < 0 || tk >= L || tm >= L) return
    const dist = new Int32Array(L * L).fill(-1)
    dist[tm * L + tk] = 0
    const queue = [tm * L + tk]
    for (let q = 0; q < queue.length; q++) {
      const n = queue[q], k = n % L, m = Math.floor(n / L)
      for (const [nk, nm, open] of ways(k, m)) {
        if (!open || nk < 0 || nm < 0 || nk >= L || nm >= L || dist[nm * L + nk] >= 0) continue
        dist[nm * L + nk] = dist[n] + 1
        queue.push(nm * L + nk)
      }
    }
    const base = r * ROUTE_ROOM_VEC4S * 4
    for (let n = 0; n < L * L; n++) {
      if (dist[n] < 0) continue
      const k = n % L, m = Math.floor(n / L)
      let code: number = ROUTE.here
      if (dist[n] > 0) {
        const w = ways(k, m).findIndex(([nk, nm, open]) => open && nk >= 0 && nm >= 0 && nk < L && nm < L && dist[nm * L + nk] === dist[n] - 1)
        code = w + 1
      }
      words[base + (n >> 3)] |= code << ((n & 7) * 4)
    }
  })
  return words
}
