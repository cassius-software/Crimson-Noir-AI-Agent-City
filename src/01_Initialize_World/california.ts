// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the California-analog map: a sprawling fictitious coast generated from the seed alone
 * with fractal Brownian motion (fBm) over the macro city's grid (macroCity.ts: 40 m blocks, the same streets, lots and
 * footprints every later stage reads). An ocean lies to the west behind an fBm coastline; inland the ground rises
 * through fBm relief, and the north coast is wet with fog while the interior is dry. Five regions are carved from those
 * fields, under strict CC0 fictitious names that are nobody's trademark and no real place:
 * - Del Mar Metropolis, the coastal city: towers downtown, a port, dense apartment blocks;
 * - San Cero, hills and fog on the north coast: narrow rows on the slopes, a small centre;
 * - Las Vistas, desert neon: one strip of hotels along an arterial, low houses around it;
 * - Dusty Basin, desert and canyons: sparse homesteads, sheds, open desert and canyon floors;
 * - Starwood Hills, mansions: one house per lot on the slopes above the metropolis.
 * Every block of the map gets a zone, a terrain and a lot kind, the streets are laid by macroCity's own network
 * builder (so the car network is always whole), and each zone can be written out as a structural JSON layout
 * (zoneLayout) for tools, tests and the world data under world/california/. The same seed gives the same map, byte
 * for byte, on every run and every machine: nothing here reads the clock, the browser or the network.
 * What breaks if it is removed? There is no California-analog map: the onboarding has nothing to build in the
 * background and world/california/ cannot be regenerated or checked.
 */
import {
  LOT, LOT_NAMES, MACRO, STREET, fnv1a, generateMacroCity, hash2, noise, serializeMacroCity,
  type LotKind, type MacroCity, type MacroPlan, type PushFootprint,
} from './macroCity.ts'
import { NAME_HEADS, NAME_TAILS } from './region/names.ts'

export const CALIFORNIA_FORMAT = 'california/1'
export const ZONE_FORMAT = 'zone/1'

/** The five regions, in zone order (a block's `zones` byte indexes this list; ZONE.ocean is the sea). */
export const REGIONS = Object.freeze([
  Object.freeze({ id: 0, slug: 'del-mar-metropolis', name: 'Del Mar Metropolis', biome: 'coastal', climate: 'mild, sea breeze', character: 'towers, a port, dense blocks by the water' }),
  Object.freeze({ id: 1, slug: 'san-cero', name: 'San Cero', biome: 'hills and fog', climate: 'cool, foggy mornings', character: 'narrow rows on steep slopes, a small centre' }),
  Object.freeze({ id: 2, slug: 'las-vistas', name: 'Las Vistas', biome: 'desert neon', climate: 'hot, dry, clear nights', character: 'one strip of lit hotels, low houses around it' }),
  Object.freeze({ id: 3, slug: 'dusty-basin', name: 'Dusty Basin', biome: 'desert and canyons', climate: 'arid, wide skies', character: 'homesteads, sheds, canyon floors and open desert' }),
  Object.freeze({ id: 4, slug: 'starwood-hills', name: 'Starwood Hills', biome: 'mansions', climate: 'warm hillside', character: 'one house to a lot, gardens, a view of the coast' }),
])
export type Region = (typeof REGIONS)[number]
/** The five region names, exactly as they are to be spelled everywhere. */
export const REGION_NAMES: readonly string[] = Object.freeze(REGIONS.map((r) => r.name))

export const ZONE = Object.freeze({ delMar: 0, sanCero: 1, lasVistas: 2, dustyBasin: 3, starwood: 4, ocean: 5 })
export type Zone = (typeof ZONE)[keyof typeof ZONE]

/** What the ground is under a block, before anything is built on it. */
export const TERRAIN = Object.freeze({ ocean: 0, shore: 1, flat: 2, hill: 3, ridge: 4, canyon: 5 })
export const TERRAIN_NAMES = ['ocean', 'shore', 'flat', 'hill', 'ridge', 'canyon'] as const

/** The fBm's shape: six octaves, each twice as fine and half as loud as the one before. */
export const FBM = Object.freeze({ octaves: 6, lacunarity: 2, gain: 0.5 })

/**
 * Fractal Brownian motion in [0, 1): `FBM.octaves` octaves of macroCity's smooth value noise at (x, z), the first with
 * lattice spacing `scale`, each next one `lacunarity` times finer and `gain` times quieter, normalised by the sum of
 * the gains. Deterministic in (seed, x, z).
 */
export function fbm(seed: number, x: number, z: number, scale: number, octaves: number = FBM.octaves): number {
  let sum = 0, amp = 1, total = 0, s = scale
  for (let o = 0; o < octaves; o++) {
    sum += noise(seed + o * 7919, x, z, s) * amp
    total += amp
    amp *= FBM.gain
    s /= FBM.lacunarity
  }
  return sum / total
}

/** Ridged fBm in [0, 1]: 1 at a ridge (or a canyon wall), 0 in the channel between. */
export function ridged(seed: number, x: number, z: number, scale: number, octaves = 4): number {
  let sum = 0, amp = 1, total = 0, s = scale
  for (let o = 0; o < octaves; o++) {
    sum += (1 - Math.abs(noise(seed + o * 7919, x, z, s) * 2 - 1)) * amp
    total += amp
    amp *= FBM.gain
    s /= FBM.lacunarity
  }
  return sum / total
}

export interface CaliforniaMap extends MacroCity {
  /** TERRAIN per block, index m · blocks + k. */
  terrain: Uint8Array
  /** ZONE per block (ZONE.ocean at sea). */
  zones: Uint8Array
  /** Ground height per block, 0 (sea level) … 1 (the highest ridge). */
  elevation: Float32Array
  /** Moisture (fog) per block, 0 dry … 1 wet. */
  moisture: Float32Array
  /** Where the coast is on each row: blocks from the west edge (fractional). */
  coast: Float32Array
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smooth = (a: number, b: number, v: number) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t) }

/** The ocean's eastern edge on row m, in blocks from the west: an fBm coastline around 16 % of the width. */
export function coastAt(seed: number, blocks: number, m: number): number {
  return blocks * (0.16 + 0.09 * (fbm(seed ^ 0xc0a57, 0, m, blocks / 5, 4) - 0.5) * 2)
}

/** The fields the zones are carved from, per block. */
function fields(seed: number, B: number): { elevation: Float32Array; moisture: Float32Array; coast: Float32Array; canyon: Float32Array } {
  const elevation = new Float32Array(B * B), moisture = new Float32Array(B * B), canyon = new Float32Array(B * B), coast = new Float32Array(B)
  for (let m = 0; m < B; m++) coast[m] = coastAt(seed, B, m)
  for (let m = 0; m < B; m++) {
    const v = (m + 0.5) / B
    for (let k = 0; k < B; k++) {
      const i = m * B + k
      const inland = (k + 0.5 - coast[m]) / B
      // Relief rises inland and with the fBm; the north coast is the steepest shore.
      const relief = fbm(seed ^ 0xe1e7, k, m, B / 6)
      const rise = smooth(0, 0.7, inland) * 0.22 + smooth(0, 0.25, inland) * smooth(0.45, 0.1, v) * 0.3
      elevation[i] = inland < 0 ? 0 : clamp01(0.08 + 0.6 * relief + rise - 0.25 * smooth(0.02, -0.02, inland))
      // Fog: the north coast is wet, the interior dry.
      moisture[i] = clamp01(0.45 * fbm(seed ^ 0xf06, k, m, B / 4, 4) + 0.6 * (1 - v) * (1 - smooth(0.05, 0.5, inland)) + 0.15 * (1 - smooth(0, 0.2, inland)))
      canyon[i] = ridged(seed ^ 0xca9, k, m, B / 10)
    }
  }
  return { elevation, moisture, coast, canyon }
}

/** The zone a land block falls in, by its position on the coast and its fields: the highest affinity wins. */
function classify(inland: number, v: number, e: number, w: number): Zone {
  const north = 1 - v
  const scores = [
    // Del Mar Metropolis: the coast, from the centre south, low ground.
    smooth(0.26, 0, inland) * smooth(0.25, 0.5, v) * (1.2 - e),
    // San Cero: the north coast, hills and fog.
    smooth(0.3, 0, inland) * smooth(0.5, 0.8, north) * (0.6 + w),
    // Las Vistas: the flat dry middle of the interior.
    smooth(0.25, 0.45, inland) * smooth(0.12, 0.3, v) * smooth(0.78, 0.55, v) * (1.3 - e) * (1 - 0.5 * w) * 1.25,
    // Dusty Basin: the high dry interior, the far east, the north-east and the south-east.
    smooth(0.3, 0.6, inland) * (0.45 + e) * (1 - 0.5 * w) * (0.55 + 0.7 * (smooth(0.6, 0.9, v) + smooth(0.3, 0.05, v)) + 0.5 * smooth(0.5, 0.8, inland)),
    // Starwood Hills: the slopes just inland of the metropolis.
    smooth(0.06, 0.18, inland) * smooth(0.36, 0.14, inland) * smooth(0.2, 0.7, v) * (0.5 + e),
  ]
  let best = 0
  for (let z = 1; z < scores.length; z++) if (scores[z] > scores[best]) best = z
  return best as Zone
}

/** Two passes of a 3 × 3 majority filter over the land zones, so no zone is a single speck in another. */
function majority(zones: Uint8Array, B: number): void {
  const counts = new Uint8Array(6)
  for (let pass = 0; pass < 2; pass++) {
    const prev = zones.slice()
    for (let m = 0; m < B; m++) for (let k = 0; k < B; k++) {
      const i = m * B + k
      if (prev[i] === ZONE.ocean) continue
      counts.fill(0)
      for (let dm = -1; dm <= 1; dm++) for (let dk = -1; dk <= 1; dk++) {
        const kk = k + dk, mm = m + dm
        if (kk < 0 || mm < 0 || kk >= B || mm >= B) continue
        const z = prev[mm * B + kk]
        if (z !== ZONE.ocean) counts[z]++
      }
      let best = prev[i]
      for (let z = 0; z < 5; z++) if (counts[z] > counts[best] || (counts[z] === counts[best] && z < best && counts[z] * 2 > 9)) best = z
      zones[i] = best
    }
  }
}

interface Centroid { k: number; m: number; n: number }
function centroids(zones: Uint8Array, B: number): Centroid[] {
  const c: Centroid[] = REGIONS.map(() => ({ k: 0, m: 0, n: 0 }))
  for (let m = 0; m < B; m++) for (let k = 0; k < B; k++) {
    const z = zones[m * B + k]
    if (z === ZONE.ocean) continue
    c[z].k += k + 0.5; c[z].m += m + 0.5; c[z].n++
  }
  for (const z of c) if (z.n) { z.k /= z.n; z.m /= z.n }
  return c
}

/** Las Vistas' strip: the arterial column nearest the zone's centroid. */
const stripColumn = (c: Centroid, B: number): number => {
  const every = Math.min(MACRO.arterialEvery, Math.max(4, B >> 2))
  return Math.max(every, Math.round(c.k / every) * every)
}

/**
 * Generates the California-analog map for `seed`: the fields, the zones, the terrain, then macroCity's streets and the
 * zone's own footprints over the lots this file assigns. Deterministic. `blocks` as macroCity (default 256: 10.24 km).
 */
export function generateCalifornia(seed: number, blocks: number = MACRO.blocks): CaliforniaMap {
  if (!Number.isInteger(blocks) || blocks < 8 || blocks > 1024) throw new RangeError('blocks must be an integer in 8…1024')
  const B = blocks
  const f = fields(seed, B)
  const zones = new Uint8Array(B * B), terrain = new Uint8Array(B * B)
  for (let m = 0; m < B; m++) for (let k = 0; k < B; k++) {
    const i = m * B + k
    const inland = (k + 0.5 - f.coast[m]) / B
    zones[i] = inland < 0 ? ZONE.ocean : classify(inland, (m + 0.5) / B, f.elevation[i], f.moisture[i])
  }
  majority(zones, B)
  for (let m = 0; m < B; m++) for (let k = 0; k < B; k++) {
    const i = m * B + k
    const e = f.elevation[i]
    if (zones[i] === ZONE.ocean) terrain[i] = TERRAIN.ocean
    else if (k + 0.5 - f.coast[m] < 1.5) terrain[i] = TERRAIN.shore
    else if (e > 0.88) terrain[i] = TERRAIN.ridge
    else if (zones[i] === ZONE.dustyBasin && f.canyon[i] < 0.36) terrain[i] = TERRAIN.canyon
    else if (e > 0.62 || (e > 0.5 && (zones[i] === ZONE.starwood || zones[i] === ZONE.sanCero))) terrain[i] = TERRAIN.hill
    else terrain[i] = TERRAIN.flat
  }
  const cs = centroids(zones, B)
  const strip = stripColumn(cs[ZONE.lasVistas], B)
  const near = (c: Centroid, k: number, m: number) => (c.n ? Math.hypot(k + 0.5 - c.k, m + 0.5 - c.m) / B : 1)

  const lotAt = (k: number, m: number): LotKind => {
    const i = m * B + k, z = zones[i], t = terrain[i]
    if (z === ZONE.ocean) return LOT.water
    if (t === TERRAIN.ridge || t === TERRAIN.canyon) return LOT.park
    const h = hash2(seed, k, m), h1 = hash2(seed + 1, k, m), n = noise(seed + 11, k, m, 9)
    switch (z) {
      case ZONE.delMar: {
        const d = near(cs[z], k, m)
        if (t === TERRAIN.shore) return n > 0.3 || (m + 0.5) / B > 0.55 ? LOT.industrial : LOT.park // the port and the beaches
        if (d < 0.05 + 0.02 * n) return h < 0.06 ? LOT.plaza : h1 < 0.04 ? LOT.civic : LOT.downtown
        if (n > 0.86) return LOT.park
        if (n > 0.78 && d > 0.1) return LOT.industrial
        return h1 < 0.015 ? LOT.civic : LOT.residential
      }
      case ZONE.sanCero: {
        const d = near(cs[z], k, m)
        if (t === TERRAIN.shore) return LOT.park
        if (d < 0.03 + 0.01 * n) return h < 0.08 ? LOT.plaza : LOT.downtown
        if (n > 0.8 || t === TERRAIN.hill && n > 0.7) return LOT.park
        return h1 < 0.012 ? LOT.civic : LOT.residential
      }
      case ZONE.lasVistas: {
        if (Math.abs(k + 0.5 - strip) <= 1.5 && near(cs[z], k, m) < 0.2) return h < 0.05 ? LOT.plaza : LOT.downtown
        if (n > 0.84) return LOT.park
        if (n > 0.76) return LOT.industrial
        return h1 < 0.01 ? LOT.civic : LOT.residential
      }
      case ZONE.dustyBasin:
        if (n > 0.6 || (t === TERRAIN.hill && n > 0.45)) return LOT.park // open desert
        if (n > 0.56) return LOT.industrial
        return h1 < 0.006 ? LOT.civic : LOT.residential
      case ZONE.starwood:
        if (n > 0.8 || t === TERRAIN.ridge) return LOT.park
        return h1 < 0.008 ? LOT.civic : LOT.residential
      default:
        return LOT.park
    }
  }

  const footprints = (li: number, kind: LotKind, k: number, m: number, r: () => number, push: PushFootprint): void => {
    const z = zones[m * B + k]
    if (kind === LOT.civic) { push(li, 40, 40, 220, 220, 3 + Math.floor(r() * 4)); return }
    if (kind === LOT.park) { if (r() < 0.15) push(li, 110, 110, 150, 150, 1); return }
    if (kind === LOT.industrial) { push(li, 20, 20, 240, 200 + Math.floor(r() * 40), 1 + Math.floor(r() * 2)); return }
    switch (z) {
      case ZONE.delMar:
        if (kind === LOT.downtown) {
          if (r() < 0.5) push(li, 10, 10, 250, 250, 20 + Math.floor(r() * 40))
          else { push(li, 0, 0, 125, 260, 10 + Math.floor(r() * 24)); push(li, 135, 0, 260, 260, 10 + Math.floor(r() * 24)) }
        } else if (kind === LOT.residential) {
          // Apartment blocks around a courtyard.
          push(li, 8, 8, 252, 90, 3 + Math.floor(r() * 4)); push(li, 8, 170, 252, 252, 3 + Math.floor(r() * 4))
        }
        return
      case ZONE.sanCero:
        if (kind === LOT.downtown) push(li, 15, 15, 245, 245, 6 + Math.floor(r() * 18))
        else if (kind === LOT.residential) {
          // Narrow rows on the slope: four houses to a row, two rows.
          const w = 65
          for (let c = 0; c < 4; c++) for (let q = 0; q < 2; q++) push(li, c * w + 6, q * 130 + 15, (c + 1) * w - 6, q * 130 + 110, 2 + Math.floor(r() * 3))
        }
        return
      case ZONE.lasVistas:
        if (kind === LOT.downtown) {
          // A hotel tower on a casino podium, set back behind its forecourt.
          push(li, 10, 10, 250, 120, 2)
          push(li, 60, 60, 200, 240, 15 + Math.floor(r() * 24))
        } else if (kind === LOT.residential) {
          const w = 85
          for (let c = 0; c < 3; c++) for (let q = 0; q < 2; q++) if (r() < 0.85) push(li, c * w + 10, q * 130 + 25, (c + 1) * w - 10, q * 130 + 105, 1)
        }
        return
      case ZONE.dustyBasin:
        if (kind === LOT.residential) {
          // Homesteads: one or two low houses, well apart.
          push(li, 30 + Math.floor(r() * 60), 40 + Math.floor(r() * 60), 110 + Math.floor(r() * 40), 120 + Math.floor(r() * 40), 1 + Math.floor(r() * 2))
          if (r() < 0.4) push(li, 160, 150 + Math.floor(r() * 40), 230, 230, 1)
        } else if (kind === LOT.downtown) push(li, 20, 20, 240, 240, 2)
        return
      case ZONE.starwood:
        if (kind === LOT.residential) {
          // One mansion to a lot, in its garden.
          const x0 = 50 + Math.floor(r() * 30), z0 = 60 + Math.floor(r() * 30)
          push(li, x0, z0, x0 + 110 + Math.floor(r() * 50), z0 + 90 + Math.floor(r() * 50), 2 + Math.floor(r() * 2))
        } else if (kind === LOT.downtown) push(li, 20, 20, 240, 240, 3)
        return
      default:
        return
    }
  }

  const plan: MacroPlan = { lotAt, footprints }
  const macro = generateMacroCity(seed, B, plan)
  return { ...macro, terrain, zones, elevation: f.elevation, moisture: f.moisture, coast: f.coast }
}

// ─── Fictitious names ───────────────────────────────────────────────────────────────────────────────────────────────

/** A fictitious compound name from the region word lists (names.ts), chosen by (seed, a, b): "Copperdale". */
export function fictionalName(seed: number, a: number, b: number): string {
  const head = NAME_HEADS[Math.floor(hash2(seed ^ 0x5a1e, a, b) * NAME_HEADS.length)]
  const tail = NAME_TAILS[Math.floor(hash2(seed ^ 0x7a11, a, b) * NAME_TAILS.length)]
  return head + tail
}

// ─── Zone layouts ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface Extent { k0: number; m0: number; k1: number; m1: number }
export interface District { name: string; kind: string; blocks: number; extent: Extent; centroid: { k: number; m: number } }

/** One zone's structural layout: what a tool or a test needs to know about the region without the whole map. */
export interface ZoneLayout {
  format: typeof ZONE_FORMAT
  seed: number
  blocks: number
  /** Block pitch and the map's edge, metres. */
  pitch: number
  size: number
  region: Region
  /** The zone's blocks' bounding box and its share of the land. */
  extent: Extent
  area: { blocks: number; km2: number; shareOfLand: number }
  centroid: { k: number; m: number }
  elevation: { min: number; mean: number; max: number }
  moisture: { mean: number }
  terrain: Record<(typeof TERRAIN_NAMES)[number], number>
  lots: Record<(typeof LOT_NAMES)[number], number>
  buildings: { count: number; floors: { min: number; mean: number; max: number }; tallest: { k: number; m: number; floors: number } | null }
  streets: { arterial: number; local: number; pedestrian: number; bridge: number }
  /** The zone's neighbourhoods: connected runs of one lot kind, largest first (at most 24). */
  districts: District[]
  /** Which other zones (by slug) it touches. */
  neighbours: string[]
}

const round = (v: number, places = 3) => Math.round(v * 10 ** places) / 10 ** places

/** The structural layout of zone `zone` of `map`. */
export function zoneLayout(map: CaliforniaMap, zone: number): ZoneLayout {
  const B = map.blocks, region = REGIONS[zone]
  if (!region) throw new RangeError(`no region ${zone}`)
  const extent: Extent = { k0: B, m0: B, k1: -1, m1: -1 }
  let n = 0, land = 0, ck = 0, cm = 0, eMin = 1, eMax = 0, eSum = 0, wSum = 0
  const terrain = Object.fromEntries(TERRAIN_NAMES.map((t) => [t, 0])) as ZoneLayout['terrain']
  const lots = Object.fromEntries(LOT_NAMES.map((t) => [t, 0])) as ZoneLayout['lots']
  const touching = new Set<number>()
  for (let m = 0; m < B; m++) for (let k = 0; k < B; k++) {
    const i = m * B + k, z = map.zones[i]
    if (z !== ZONE.ocean) land++
    if (z !== zone) continue
    n++
    ck += k + 0.5; cm += m + 0.5
    extent.k0 = Math.min(extent.k0, k); extent.m0 = Math.min(extent.m0, m); extent.k1 = Math.max(extent.k1, k); extent.m1 = Math.max(extent.m1, m)
    const e = map.elevation[i]
    eMin = Math.min(eMin, e); eMax = Math.max(eMax, e); eSum += e; wSum += map.moisture[i]
    terrain[TERRAIN_NAMES[map.terrain[i]]]++
    lots[LOT_NAMES[map.lots[i]]]++
    for (const [dk, dm] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const kk = k + dk, mm = m + dm
      if (kk < 0 || mm < 0 || kk >= B || mm >= B) continue
      const o = map.zones[mm * B + kk]
      if (o !== zone && o !== ZONE.ocean) touching.add(o)
    }
  }
  // Buildings.
  let count = 0, fMin = Infinity, fMax = 0, fSum = 0, tallest: ZoneLayout['buildings']['tallest'] = null
  const fp = map.footprints
  for (let i = 0; i < fp.length; i += 6) {
    const li = fp[i]
    if (map.zones[li] !== zone) continue
    const floors = fp[i + 5]
    count++
    fMin = Math.min(fMin, floors); fMax = Math.max(fMax, floors); fSum += floors
    if (!tallest || floors > tallest.floors) tallest = { k: li % B, m: Math.floor(li / B), floors }
  }
  // Streets bordering the zone's blocks (a segment between two blocks counts for each zone it touches, once).
  const streets = { arterial: 0, local: 0, pedestrian: 0, bridge: 0 }
  const tally = (kind: number) => {
    if (kind === STREET.arterial) streets.arterial++
    else if (kind === STREET.local) streets.local++
    else if (kind === STREET.pedestrian) streets.pedestrian++
    else if (kind === STREET.bridge) streets.bridge++
  }
  const zoneAt = (k: number, m: number) => (k < 0 || m < 0 || k >= B || m >= B ? ZONE.ocean : map.zones[m * B + k])
  for (let m = 0; m <= B; m++) for (let k = 0; k < B; k++) if (zoneAt(k, m - 1) === zone || zoneAt(k, m) === zone) tally(map.hStreets[m * B + k])
  for (let k = 0; k <= B; k++) for (let m = 0; m < B; m++) if (zoneAt(k - 1, m) === zone || zoneAt(k, m) === zone) tally(map.vStreets[k * B + m])

  return {
    format: ZONE_FORMAT,
    seed: map.seed,
    blocks: B,
    pitch: MACRO.pitch,
    size: B * MACRO.pitch,
    region,
    extent: n ? extent : { k0: 0, m0: 0, k1: -1, m1: -1 },
    area: { blocks: n, km2: round((n * MACRO.pitch * MACRO.pitch) / 1e6), shareOfLand: land ? round(n / land) : 0 },
    centroid: n ? { k: round(ck / n, 2), m: round(cm / n, 2) } : { k: 0, m: 0 },
    elevation: n ? { min: round(eMin), mean: round(eSum / n), max: round(eMax) } : { min: 0, mean: 0, max: 0 },
    moisture: { mean: n ? round(wSum / n) : 0 },
    terrain,
    lots,
    buildings: { count, floors: count ? { min: fMin, mean: round(fSum / count, 2), max: fMax } : { min: 0, mean: 0, max: 0 }, tallest },
    streets,
    districts: districts(map, zone),
    neighbours: [...touching].sort().map((z) => REGIONS[z].slug),
  }
}

/** The zone's connected runs of one lot kind (4-neighbour), four blocks or more, largest first, at most 24, each named. */
export function districts(map: CaliforniaMap, zone: number): District[] {
  const B = map.blocks
  const seen = new Uint8Array(B * B)
  const out: District[] = []
  const stack: number[] = []
  for (let start = 0; start < B * B; start++) {
    if (seen[start] || map.zones[start] !== zone) continue
    const kind = map.lots[start]
    if (kind === LOT.water) { seen[start] = 1; continue }
    let n = 0, ck = 0, cm = 0
    const ex: Extent = { k0: B, m0: B, k1: -1, m1: -1 }
    stack.push(start)
    seen[start] = 1
    while (stack.length) {
      const i = stack.pop() as number
      const k = i % B, m = Math.floor(i / B)
      n++; ck += k + 0.5; cm += m + 0.5
      ex.k0 = Math.min(ex.k0, k); ex.m0 = Math.min(ex.m0, m); ex.k1 = Math.max(ex.k1, k); ex.m1 = Math.max(ex.m1, m)
      for (const [dk, dm] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const kk = k + dk, mm = m + dm
        if (kk < 0 || mm < 0 || kk >= B || mm >= B) continue
        const j = mm * B + kk
        if (seen[j] || map.zones[j] !== zone || map.lots[j] !== kind) continue
        seen[j] = 1
        stack.push(j)
      }
    }
    if (n < 4) continue
    const kindName = LOT_NAMES[kind]
    const suffix = kindName === 'downtown' ? 'Centre' : kindName === 'park' ? 'Park' : kindName === 'industrial' ? 'Yards' : kindName === 'plaza' ? 'Plaza' : kindName === 'civic' ? 'Square' : 'Heights'
    out.push({ name: `${fictionalName(map.seed, start, kind)} ${suffix}`, kind: kindName, blocks: n, extent: ex, centroid: { k: round(ck / n, 2), m: round(cm / n, 2) } })
  }
  out.sort((a, b) => b.blocks - a.blocks || a.extent.m0 - b.extent.m0 || a.extent.k0 - b.extent.k0)
  return out.slice(0, 24)
}

/** The index of a map's zone layouts: the map's identity and a line per region (the file each layout is written to). */
export interface CaliforniaIndex {
  format: typeof CALIFORNIA_FORMAT
  seed: number
  blocks: number
  pitch: number
  size: number
  /** FNV-1a of the serialised macro city (lots, streets, footprints): the map's fingerprint. */
  fingerprint: string
  land: { blocks: number; km2: number }
  regions: { id: number; slug: string; name: string; biome: string; blocks: number; file: string }[]
}

export function californiaIndex(map: CaliforniaMap, layouts: readonly ZoneLayout[]): CaliforniaIndex {
  const land = layouts.reduce((s, l) => s + l.area.blocks, 0)
  return {
    format: CALIFORNIA_FORMAT,
    seed: map.seed,
    blocks: map.blocks,
    pitch: MACRO.pitch,
    size: map.blocks * MACRO.pitch,
    fingerprint: fnv1a(serializeMacroCity(map)).toString(16).padStart(8, '0'),
    land: { blocks: land, km2: round((land * MACRO.pitch * MACRO.pitch) / 1e6) },
    regions: layouts.map((l) => ({ id: l.region.id, slug: l.region.slug, name: l.region.name, biome: l.region.biome, blocks: l.area.blocks, file: `${l.region.slug}.json` })),
  }
}

/** Every zone's layout, in zone order. */
export const zoneLayouts = (map: CaliforniaMap): ZoneLayout[] => REGIONS.map((r) => zoneLayout(map, r.id))
