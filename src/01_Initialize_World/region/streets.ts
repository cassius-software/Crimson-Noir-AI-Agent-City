// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the street window: the part of a generated region (the lakefront metropolis,
 * lakefront.ts, through fromMacro.ts) that the pedestrian crowd walks and the car fleet drives. The crowd shader
 * (03_Spawn_Agents/crowd.wgsl) and the car rings (06_Make_Decisions/tracks.ts) were written for the procedural city's
 * grid: a window of CITY.blocks × CITY.blocks blocks at the city's pitch, every street present. A generated map is laid
 * on the same pitch, but some streets are dropped (superblocks), some are pedestrian streets, and water and ravines
 * have none but the bridges. So this file reads the region pack's roads back into that grid: a window of the map
 * (CITY.blocks across, centred where the visitor starts, aligned to the pitch), and per street segment whether a
 * sidewalk runs along it (any street) and whether cars use it (a one-lane road is a pedestrian street). From the
 * window it makes the three things the realms need: the bit words the shader reads (packStreets), the car rings over
 * the window's whole cells (streetLoops: disjoint rectangles whose every side is a car street, so every (segment,
 * direction) belongs to at most one ring, the zero-jam invariant of tracks.ts), and the street furniture (lamps along
 * every sidewalk, signals where car streets meet). A surveyed pack whose roads do not lie on the grid gives no window
 * (null): that region keeps the crowd hidden and the fleet empty, as before.
 * The pack's roads are read once into the whole map's grid (mapStreetGrid: every street of the map, uncropped, for
 * whoever asks about a lot anywhere on it), and the window is a crop of that (windowOrigin says where, windowOf cuts
 * it): streetGridOf is the three together, and gives the window it always gave.
 * What breaks if it is removed? The lakefront metropolis is a region without people or traffic: the HUD reads
 * Population 0 and Vehicles 0 for every first-time visitor.
 */
import { CITY, type Furniture } from '../city.ts'
import { TRAFFIC } from '../../02_Define_The_Rules/civic.ts'
import { createRng } from '../../02_Define_The_Rules/degrees.ts'
import { capacity, ring, type Track, type TrackNetwork } from '../../06_Make_Decisions/tracks.ts'
import { ROAD_CLASS, roadAt, type RegionPack } from './pack.ts'

/** Blocks per axis of the window: the crowd shader's grid (crowd.wgsl is compiled for CITY.blocks). */
export const WINDOW_BLOCKS = CITY.blocks

/** Lane width, m, and the sidewalk each side of a street that has one, as regionWorld.ts draws them (and re-exports them). */
export const LANE_WIDTH = 3.3
export const SIDEWALK = 2.2

/** The width of a road's carriageway, m, and whether it has sidewalks (regionWorld.ts lays the ribbons by it; transit.ts keeps clear of it). */
export function roadWidth(cls: number, lanes: number): { carriage: number; sidewalk: boolean } {
  const carriage = Math.max(cls === ROAD_CLASS.lane ? 3.2 : 3.5, lanes * LANE_WIDTH)
  const sidewalk = cls === ROAD_CLASS.arterial || cls === ROAD_CLASS.collector || cls === ROAD_CLASS.local
  return { carriage, sidewalk }
}

/** Segment bits: a sidewalk runs along it (any street); cars use it (crossing it waits for the signal). */
export const SEG = Object.freeze({ walk: 1, drive: 2 })

/**
 * The street geometry of a generated region's two-lane streets (regionWorld.ts draws a lane LANE_WIDTH = 3.3 m wide and
 * a SIDEWALK of 2.2 m beyond the carriageway): the road half-width is one lane, the pedestrian lane runs along the
 * sidewalk's outer half, and the furniture stands at the kerb. The procedural city's own numbers are CITY's.
 */
export const WINDOW_GEOMETRY = Object.freeze({ roadHalf: 3.3, lane: 4.9, furniture: 3.9 })

/** Words of the street bit field the shader reads: two bits per segment, east-west segments first. */
export const STREET_SEGMENTS = 2 * (WINDOW_BLOCKS + 1) * WINDOW_BLOCKS
export const STREET_WORDS = Math.ceil((STREET_SEGMENTS * 2) / 32)
/** The field as vec4u (crowd.wgsl Params.streets): whole 16-byte rows. */
export const STREET_VEC4S = Math.ceil(STREET_WORDS / 4)

/**
 * A street grid, as plain data: the window (WINDOW_BLOCKS across; it crosses to the physics worker by structured
 * clone) or the whole map's (mapStreetGrid, as many blocks as the map has). Streets run along x = originX + k·pitch
 * and z = originZ + m·pitch, k, m ∈ [0, blocks], in the engine's frame.
 */
export interface StreetGrid {
  /** The grid's north-west corner, engine metres: a multiple of the pitch on each axis. */
  originX: number
  originZ: number
  blocks: number
  /** Road half-width and the pedestrian lane's offset from a street's centreline, m, and where the furniture stands. */
  roadHalf: number
  lane: number
  furniture: number
  /** East-west segment at line m (z = m·pitch) between k and k + 1: index m·blocks + k, m ∈ [0, blocks], k ∈ [0, blocks). */
  h: Uint8Array
  /** North-south segment at line k (x = k·pitch) between m and m + 1: index k·blocks + m. */
  v: Uint8Array
}

const P = CITY.pitch
const onGrid = (v: number): boolean => Math.abs(v / P - Math.round(v / P)) < 1e-6

/** The procedural city as a window: every segment a street cars use, the city's own geometry, at the origin. */
export function cityStreetGrid(): StreetGrid {
  const B = WINDOW_BLOCKS
  const all = SEG.walk | SEG.drive
  return {
    originX: 0, originZ: 0, blocks: B,
    roadHalf: CITY.roadHalf, lane: CITY.lane, furniture: CITY.furniture,
    h: new Uint8Array((B + 1) * B).fill(all), v: new Uint8Array((B + 1) * B).fill(all),
  }
}

export const hSeg = (g: StreetGrid, k: number, m: number): number => (k < 0 || k >= g.blocks || m < 0 || m > g.blocks ? 0 : g.h[m * g.blocks + k])
export const vSeg = (g: StreetGrid, k: number, m: number): number => (m < 0 || m >= g.blocks || k < 0 || k > g.blocks ? 0 : g.v[k * g.blocks + m])

/**
 * The whole map's street grid: every grid street of a region pack, uncropped, or null when none of its roads lies on
 * the grid (a surveyed region). `offset` is the layout's (regionWorld.ts layoutOf: added to the pack's metres). A road
 * counts when every one of its points is a grid vertex and every run between two is along one axis; a one-lane road is
 * a pedestrian street (fromMacro.ts roadOf), walked but not driven. Ferries are not streets. The grid's origin is the
 * lowest street line on each axis and it is as many blocks across as the streets' larger span, so every street of the
 * pack has its segment (a map longer one way than the other leaves the rest of the square empty). Its geometry is the
 * window's (WINDOW_GEOMETRY). It is a grid for reading (where a lot's fronts are, what can be walked to): the shader's
 * field and the car rings take a window of it (windowOf).
 */
export function mapStreetGrid(pack: RegionPack, offset: { x: number; z: number }): StreetGrid | null {
  // Every run of the pack along a grid line, in engine block indices, with its bits: (k0, m0, k1, m1, bits) each.
  const runs: number[] = []
  let minK = Infinity, maxK = -Infinity, minM = Infinity, maxM = -Infinity
  for (let i = 0; i < pack.roads.cls.length; i++) {
    if (pack.roads.cls[i] === ROAD_CLASS.ferry) continue
    const pts = roadAt(pack, i).map(([x, z]) => [x + offset.x, z + offset.z] as const)
    if (pts.length < 2 || !pts.every(([x, z]) => Number.isFinite(x) && Number.isFinite(z) && onGrid(x) && onGrid(z))) continue
    const bits = SEG.walk | (pack.roads.lanes[i] >= 2 ? SEG.drive : 0)
    for (let p = 0; p + 1 < pts.length; p++) {
      const k0 = Math.round(pts[p][0] / P), m0 = Math.round(pts[p][1] / P), k1 = Math.round(pts[p + 1][0] / P), m1 = Math.round(pts[p + 1][1] / P)
      if ((k0 !== k1) === (m0 !== m1)) continue
      runs.push(k0, m0, k1, m1, bits)
      minK = Math.min(minK, k0, k1); maxK = Math.max(maxK, k0, k1); minM = Math.min(minM, m0, m1); maxM = Math.max(maxM, m0, m1)
    }
  }
  if (runs.length === 0) return null
  const S = Math.max(maxK - minK, maxM - minM)
  const g: StreetGrid = {
    originX: minK * P, originZ: minM * P, blocks: S, ...WINDOW_GEOMETRY,
    h: new Uint8Array((S + 1) * S), v: new Uint8Array((S + 1) * S),
  }
  for (let r = 0; r < runs.length; r += 5) {
    const k0 = runs[r] - minK, m0 = runs[r + 1] - minM, k1 = runs[r + 2] - minK, m1 = runs[r + 3] - minM, bits = runs[r + 4]
    if (m0 === m1) for (let k = Math.min(k0, k1); k < Math.max(k0, k1); k++) g.h[m0 * S + k] |= bits
    else for (let m = Math.min(m0, m1); m < Math.max(m0, m1); m++) g.v[k0 * S + m] |= bits
  }
  return g
}

/**
 * Where the window stands on a map's grid (mapStreetGrid) for someone at `around` (engine metres): the street lines
 * (k0, m0) of its north-west corner, in the engine's block indices (the line at x = k0 · pitch, z = m0 · pitch). The
 * window is WINDOW_BLOCKS across, centred on the block under `around`, and kept inside the map's streets: between the
 * lowest and the highest street line on each axis (read from the grid's own segments, so a map shorter one way than
 * the other is clamped to what it has); a map with fewer blocks than the window starts the window at its lowest line.
 */
export function windowOrigin(map: StreetGrid, around: { x: number; z: number }): { k0: number; m0: number } {
  const B = WINDOW_BLOCKS, S = map.blocks
  // The street lines the grid holds, in its own indices (a grid with no street at all: its own square).
  let minK = Infinity, maxK = -Infinity, minM = Infinity, maxM = -Infinity
  for (let m = 0; m <= S; m++) for (let k = 0; k < S; k++) {
    if (!map.h[m * S + k]) continue
    minK = Math.min(minK, k); maxK = Math.max(maxK, k + 1); minM = Math.min(minM, m); maxM = Math.max(maxM, m)
  }
  for (let k = 0; k <= S; k++) for (let m = 0; m < S; m++) {
    if (!map.v[k * S + m]) continue
    minK = Math.min(minK, k); maxK = Math.max(maxK, k); minM = Math.min(minM, m); maxM = Math.max(maxM, m + 1)
  }
  if (maxK < minK) { minK = 0; maxK = S; minM = 0; maxM = S }
  const K0 = Math.round(map.originX / P), M0 = Math.round(map.originZ / P)
  const clampTo = (want: number, lo: number, hi: number) => Math.max(lo, Math.min(Math.max(lo, hi - B), want))
  return {
    k0: clampTo(Math.round(around.x / P) - B / 2, K0 + minK, K0 + maxK),
    m0: clampTo(Math.round(around.z / P) - B / 2, M0 + minM, M0 + maxM),
  }
}

/**
 * Whether engine lot (k, m) is one of grid `g`'s lots. The crowd's rooms and their route table both ask this of the
 * street window (interiors.ts packRooms, workplaces.ts packRoutes): a region's workplaces stand all over its map
 * (placement.ts), and only those on the window's lots are rooms to the people who walk it.
 */
export function lotInWindow(g: Pick<StreetGrid, 'originX' | 'originZ' | 'blocks'>, k: number, m: number): boolean {
  const i = k - Math.round(g.originX / P), j = m - Math.round(g.originZ / P)
  return i >= 0 && j >= 0 && i < g.blocks && j < g.blocks
}

/**
 * The window of a map's grid whose north-west corner is the street lines (k0, m0), in the engine's block indices
 * (windowOrigin gives them): WINDOW_BLOCKS across, every segment the map's, nothing where the map has no street or the
 * window reaches past it. The map's own geometry; a new grid, the map only read.
 */
export function windowOf(map: StreetGrid, k0: number, m0: number): StreetGrid {
  const B = WINDOW_BLOCKS
  const dk = k0 - Math.round(map.originX / P), dm = m0 - Math.round(map.originZ / P)
  const g: StreetGrid = {
    originX: k0 * P, originZ: m0 * P, blocks: B, roadHalf: map.roadHalf, lane: map.lane, furniture: map.furniture,
    h: new Uint8Array((B + 1) * B), v: new Uint8Array((B + 1) * B),
  }
  for (let m = 0; m <= B; m++) for (let k = 0; k < B; k++) g.h[m * B + k] = hSeg(map, k + dk, m + dm)
  for (let k = 0; k <= B; k++) for (let m = 0; m < B; m++) g.v[k * B + m] = vSeg(map, k + dk, m + dm)
  return g
}

/**
 * The window of a region pack's grid streets around `around` (engine metres), or null when none of its roads lies on
 * the grid (a surveyed region): the whole map's grid (mapStreetGrid), cropped (windowOf) to WINDOW_BLOCKS across where
 * windowOrigin puts it, centred on the block under `around` and kept inside the map's streets.
 */
export function streetGridOf(pack: RegionPack, offset: { x: number; z: number }, around: { x: number; z: number }): StreetGrid | null {
  const map = mapStreetGrid(pack, offset)
  if (!map) return null
  const { k0, m0 } = windowOrigin(map, around)
  return windowOf(map, k0, m0)
}

/** How many segments of each kind the window holds. */
export function streetCounts(g: StreetGrid): { walk: number; drive: number } {
  let walk = 0, drive = 0
  for (const bits of [...g.h, ...g.v]) {
    if (bits & SEG.walk) walk++
    if (bits & SEG.drive) drive++
  }
  return { walk, drive }
}

/**
 * The street bit field for the shader (crowd.wgsl Params.streets, segBits): two bits per segment, the east-west
 * segments (index m·blocks + k) then the north-south ones ((blocks + 1)·blocks + k·blocks + m), little-endian in u32s.
 */
export function packStreets(g: StreetGrid): Uint32Array {
  if (g.blocks !== WINDOW_BLOCKS) throw new RangeError(`a street window is ${WINDOW_BLOCKS} blocks across, got ${g.blocks}`)
  const words = new Uint32Array(STREET_VEC4S * 4)
  const put = (index: number, bits: number) => {
    const bit = index * 2
    words[bit >> 5] |= (bits & 3) << (bit & 31)
  }
  for (let i = 0; i < g.h.length; i++) put(i, g.h[i])
  for (let i = 0; i < g.v.length; i++) put(g.h.length + i, g.v[i])
  return words
}

/** The first east-west segment with a sidewalk, scanning rows: where the shader spawns someone it found no street for. */
export function spawnSegment(g: StreetGrid): { k: number; m: number } {
  for (let m = 0; m <= g.blocks; m++) for (let k = 0; k < g.blocks; k++) if (hSeg(g, k, m) & SEG.walk) return { k, m }
  return { k: 0, m: 0 }
}

/** Rectangle sizes (blocks along x, along z) tried at each free block, the city's own 2 × 2 cell first. */
const RECTANGLES: readonly (readonly [number, number])[] = Object.freeze([
  [2, 2], [2, 3], [3, 2], [3, 3], [1, 2], [2, 1], [2, 4], [4, 2], [1, 3], [3, 1], [1, 1],
] as const)

/**
 * The car rings' rectangles over the window, as window block corners clockwise ([k0, m0], [k1, m0], [k1, m1], [k0, m1]):
 * greedy over the blocks in row order, the first size of RECTANGLES whose every side is a car street and whose every
 * block is still free. Disjoint by construction, so a street segment is driven one way by at most one ring (a shared
 * side is the north edge of one rectangle, eastward, and the south edge of the other, westward): tracks.ts INV-1.
 */
export function ringRectangles(g: StreetGrid): [number, number][][] {
  const B = g.blocks
  const used = new Uint8Array(B * B)
  const drive = (bits: number) => (bits & SEG.drive) !== 0
  const fits = (k0: number, m0: number, w: number, d: number): boolean => {
    if (k0 + w > B || m0 + d > B) return false
    for (let m = m0; m < m0 + d; m++) for (let k = k0; k < k0 + w; k++) if (used[m * B + k]) return false
    for (let k = k0; k < k0 + w; k++) if (!drive(hSeg(g, k, m0)) || !drive(hSeg(g, k, m0 + d))) return false
    for (let m = m0; m < m0 + d; m++) if (!drive(vSeg(g, k0, m)) || !drive(vSeg(g, k0 + w, m))) return false
    return true
  }
  const out: [number, number][][] = []
  for (let m0 = 0; m0 < B; m0++) {
    for (let k0 = 0; k0 < B; k0++) {
      if (used[m0 * B + k0]) continue
      for (const [w, d] of RECTANGLES) {
        if (!fits(k0, m0, w, d)) continue
        for (let m = m0; m < m0 + d; m++) for (let k = k0; k < k0 + w; k++) used[m * B + k] = 1
        out.push([[k0, m0], [k0 + w, m0], [k0 + w, m0 + d], [k0, m0 + d]])
        break
      }
    }
  }
  return out
}

/**
 * The car rings of the window (tracks.ts ring: Bézier corners, a stop line at every intersection, on the right-hand lane),
 * in engine block indices; the seed only picks each ring's starting corner, as carLoops does.
 */
export function streetLoops(seed: number, g: StreetGrid): Track[] {
  const rng = createRng(seed ^ 0x7ac5)
  const kx = g.originX / P, mz = g.originZ / P
  return ringRectangles(g).map((corners, id) => {
    const start = Math.floor(rng() * 4)
    const rotated = corners.map((_, i) => corners[(i + start) % 4]).map(([k, m]) => [k + kx, m + mz] as const)
    return ring(rotated, 0, TRAFFIC.laneOffset, 'car', id)
  })
}

/** The window's track network: its car rings alone (no elevated loop, no drone corridors, no planes over a region). */
export function streetNetwork(seed: number, g: StreetGrid): TrackNetwork {
  return Object.freeze({ seed, tracks: Object.freeze(streetLoops(seed, g)) })
}

/** Cars the window's rings can seat for `seed` (tracks.ts capacity, summed; a ring's start moves its seats): the fleet is never larger. */
export function streetCapacity(g: StreetGrid, seed: number): number {
  return streetLoops(seed, g).reduce((n, t) => n + capacity(t), 0)
}

/**
 * The window's street furniture, placed as the city's (city.ts streetFurniture): lamps at 10 and 30 m along every
 * segment with a sidewalk, on both kerbs, a tree at 20 m; the four signal poles at every intersection where car streets
 * meet from at least three sides (a bend or a straight has no signal: the shared cycle still times the stop lines).
 */
export function windowFurniture(g: StreetGrid, seed: number): Furniture {
  const rng = createRng(seed + 99)
  const out: Furniture = { lamps: [], trees: [], signals: [] }
  const B = g.blocks, f = g.furniture
  for (let line = 0; line <= B; line++) {
    for (let seg = 0; seg < B; seg++) {
      const h = (hSeg(g, seg, line) & SEG.walk) !== 0, v = (vSeg(g, line, seg) & SEG.walk) !== 0
      for (const side of [-1, 1]) {
        const c = line * P + side * f
        for (const a of [10, 30]) {
          const along = seg * P + a
          if (h) out.lamps.push([g.originX + along, g.originZ + c, side > 0 ? Math.PI : 0])
          if (v) out.lamps.push([g.originX + c, g.originZ + along, side > 0 ? -Math.PI / 2 : Math.PI / 2])
        }
        const along = seg * P + 20
        const th = 0.85 + rng() * 0.35, tv = 0.85 + rng() * 0.35
        if (h) out.trees.push([g.originX + along, g.originZ + c, th])
        if (v) out.trees.push([g.originX + c, g.originZ + along, tv])
      }
    }
  }
  const s = g.roadHalf + 1.3
  for (let k = 0; k <= B; k++) {
    for (let m = 0; m <= B; m++) {
      const arms = [hSeg(g, k, m), hSeg(g, k - 1, m), vSeg(g, k, m), vSeg(g, k, m - 1)].filter((bits) => bits & SEG.drive).length
      if (arms < 3) continue
      const x = g.originX + k * P, z = g.originZ + m * P
      out.signals.push([x - s, z + s, -Math.PI / 2, 0])
      out.signals.push([x + s, z - s, Math.PI / 2, 0])
      out.signals.push([x - s, z - s, Math.PI, 1])
      out.signals.push([x + s, z + s, 0, 1])
    }
  }
  return out
}
