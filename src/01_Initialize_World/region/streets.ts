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
 * The window, as plain data (it crosses to the physics worker by structured clone). Streets run along
 * x = originX + k·pitch and z = originZ + m·pitch, k, m ∈ [0, blocks], in the engine's frame.
 */
export interface StreetGrid {
  /** The window's north-west corner, engine metres: a multiple of the pitch on each axis. */
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
 * The window of a region pack's grid streets around `around` (engine metres), or null when none of its roads lies on
 * the grid (a surveyed region). `offset` is the layout's (regionWorld.ts layoutOf: added to the pack's metres). A road
 * counts when every one of its points is a grid vertex and every run between two is along one axis; a one-lane road is
 * a pedestrian street (fromMacro.ts roadOf), walked but not driven. Ferries are not streets.
 */
export function streetGridOf(pack: RegionPack, offset: { x: number; z: number }, around: { x: number; z: number }): StreetGrid | null {
  const B = WINDOW_BLOCKS
  // Every grid segment of the pack, in engine block indices, with its bits.
  const h = new Map<string, number>(), v = new Map<string, number>()
  let minK = Infinity, maxK = -Infinity, minM = Infinity, maxM = -Infinity
  for (let i = 0; i < pack.roads.cls.length; i++) {
    if (pack.roads.cls[i] === ROAD_CLASS.ferry) continue
    const pts = roadAt(pack, i).map(([x, z]) => [x + offset.x, z + offset.z] as const)
    if (pts.length < 2 || !pts.every(([x, z]) => Number.isFinite(x) && Number.isFinite(z) && onGrid(x) && onGrid(z))) continue
    const bits = SEG.walk | (pack.roads.lanes[i] >= 2 ? SEG.drive : 0)
    for (let p = 0; p + 1 < pts.length; p++) {
      const k0 = Math.round(pts[p][0] / P), m0 = Math.round(pts[p][1] / P), k1 = Math.round(pts[p + 1][0] / P), m1 = Math.round(pts[p + 1][1] / P)
      if ((k0 !== k1) === (m0 !== m1)) continue
      if (m0 === m1) for (let k = Math.min(k0, k1); k < Math.max(k0, k1); k++) h.set(`${k},${m0}`, (h.get(`${k},${m0}`) ?? 0) | bits)
      else for (let m = Math.min(m0, m1); m < Math.max(m0, m1); m++) v.set(`${k0},${m}`, (v.get(`${k0},${m}`) ?? 0) | bits)
      minK = Math.min(minK, k0, k1); maxK = Math.max(maxK, k0, k1); minM = Math.min(minM, m0, m1); maxM = Math.max(maxM, m0, m1)
    }
  }
  if (h.size + v.size === 0) return null
  // The window: CITY.blocks across, centred on the block under `around`, kept inside the map's streets.
  const clampTo = (want: number, lo: number, hi: number) => Math.max(lo, Math.min(Math.max(lo, hi - B), want))
  const k0 = clampTo(Math.round(around.x / P) - B / 2, minK, maxK), m0 = clampTo(Math.round(around.z / P) - B / 2, minM, maxM)
  const g: StreetGrid = {
    originX: k0 * P, originZ: m0 * P, blocks: B, ...WINDOW_GEOMETRY,
    h: new Uint8Array((B + 1) * B), v: new Uint8Array((B + 1) * B),
  }
  for (const [key, bits] of h) {
    const [k, m] = key.split(',').map(Number)
    if (k - k0 >= 0 && k - k0 < B && m - m0 >= 0 && m - m0 <= B) g.h[(m - m0) * B + (k - k0)] = bits
  }
  for (const [key, bits] of v) {
    const [k, m] = key.split(',').map(Number)
    if (m - m0 >= 0 && m - m0 < B && k - k0 >= 0 && k - k0 <= B) g.v[(k - k0) * B + (m - m0)] = bits
  }
  return g
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
