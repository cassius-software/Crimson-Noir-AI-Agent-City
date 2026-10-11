// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the lakefront metropolis: a sprawling fictitious map in the shape of a great lake city,
 * generated from the seed alone over the macro city's grid (macroCity.ts: 40 m blocks, the same streets, lots and
 * footprints every later stage reads). A massive lake fills the south behind a wandering shoreline with a harbour; a
 * highly dense financial core stands against the water, with The Spire, its needle, on the waterfront; deep natural
 * ravines (fractal Brownian motion makes them wander) slice the grid from the north down to the lake, crossed only by
 * the arterials' bridges; and a suburban grid sprawls north, west and east, studded with transit hubs: nodes of
 * skyscrapers in the sprawl. Five regions, under strict CC0 fictitious names that are nobody's trademark and no real
 * place: Lakefront Metropolis (the core and the old city on the water), West Sprawl (whose main hub is Transit City),
 * The East Bluffs (houses on the cliffs above the lake's east shore), North Ridge (the northern sprawl on its rise) and
 * The Grand Ravine (the main ravine and the streets along its edges). Every block gets a zone, a terrain and a lot kind,
 * the streets are laid by macroCity's own network builder (so the car network is always whole and the ravines are
 * bridged), and each zone can be written out as a structural JSON layout (zoneLayout) for tools, tests and the world
 * data under world/lakefront/. The same seed gives the same map, byte for byte, on every run and every machine: nothing
 * here reads the clock, the browser or the network.
 * What breaks if it is removed? There is no lakefront map: the onboarding has nothing to build in the background and
 * world/lakefront/ cannot be regenerated or checked.
 */
import {
  LOT, LOT_NAMES, MACRO, STREET, fnv1a, generateMacroCity, hash2, noise, serializeMacroCity,
  type LotKind, type MacroCity, type MacroPlan, type PushFootprint,
} from './macroCity.ts'
import { NAME_HEADS, NAME_TAILS } from './region/names.ts'

export const LAKEFRONT_FORMAT = 'lakefront/1'
export const ZONE_FORMAT = 'zone/1'

/** The five regions, in zone order (a block's `zones` byte indexes this list; ZONE.lake is the water). */
export const REGIONS = Object.freeze([
  Object.freeze({ id: 0, slug: 'lakefront-metropolis', name: 'Lakefront Metropolis', biome: 'financial core on the water', character: 'the dense core, The Spire on the waterfront, apartment blocks and the port lands' }),
  Object.freeze({ id: 1, slug: 'west-sprawl', name: 'West Sprawl', biome: 'suburban sprawl', character: 'a wide suburban grid with towers around its hubs; Transit City is the main one' }),
  Object.freeze({ id: 2, slug: 'the-east-bluffs', name: 'The East Bluffs', biome: 'bluffs over the lake', character: 'houses on the cliffs above the east shore, a hub inland' }),
  Object.freeze({ id: 3, slug: 'north-ridge', name: 'North Ridge', biome: 'northern sprawl on a rise', character: 'the northern grid on its ridge, with skyscraper nodes at the stations' }),
  Object.freeze({ id: 4, slug: 'the-grand-ravine', name: 'The Grand Ravine', biome: 'ravine', character: 'the deep green valley running from the north to the lake, and the streets along its edges' }),
])
export type Region = (typeof REGIONS)[number]
/** The five region names, exactly as they are to be spelled everywhere. */
export const REGION_NAMES: readonly string[] = Object.freeze(REGIONS.map((r) => r.name))

/** The landmarks' names, exactly so. */
export const LANDMARK = Object.freeze({ spire: 'The Spire', transitCity: 'Transit City' })

export const ZONE = Object.freeze({ metropolis: 0, westSprawl: 1, eastBluffs: 2, northRidge: 3, grandRavine: 4, lake: 5 })
export type Zone = (typeof ZONE)[keyof typeof ZONE]

/** What the ground is under a block, before anything is built on it. */
export const TERRAIN = Object.freeze({ lake: 0, shore: 1, flat: 2, ravine: 3, bluff: 4, ridge: 5 })
export const TERRAIN_NAMES = ['lake', 'shore', 'flat', 'ravine', 'bluff', 'ridge'] as const

/** The fBm's shape: four octaves, each twice as fine and half as loud as the one before (the ravines' wander). */
export const FBM = Object.freeze({ octaves: 4, lacunarity: 2, gain: 0.5 })

/** Fractal Brownian motion in [0, 1): octaves of macroCity's smooth value noise, the first at lattice spacing `scale`. */
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

export interface Hub { name: string; k: number; m: number; zone: Zone; radius: number }

export interface LakefrontMap extends MacroCity {
  /** TERRAIN per block, index m · blocks + k. */
  terrain: Uint8Array
  /** ZONE per block (ZONE.lake on the water). */
  zones: Uint8Array
  /** Ground height per block, 0 (the lake) … 1 (the ridge). */
  elevation: Float32Array
  /** Where the lake begins on each column: rows from the north edge (fractional). */
  shore: Float32Array
  /** The transit hubs (nodes of skyscrapers in the sprawl), Transit City first; `zone` is the one each stands in. */
  hubs: Hub[]
  /** The Spire's block. */
  spire: { k: number; m: number }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smooth = (a: number, b: number, v: number) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t) }

/** The lake's north shore on column k, rows from the north edge: around 72 % of the way down, wandering, with a harbour bay at the centre. */
export function shoreAt(seed: number, blocks: number, k: number): number {
  const u = (k + 0.5) / blocks
  const wander = (fbm(seed ^ 0x5a0e, k, 0, blocks / 4, 3) - 0.5) * 0.08
  const bay = 0.025 * smooth(0.12, 0, Math.abs(u - 0.5)) // the harbour: the shore steps back at the core
  return blocks * (0.72 + wander - bay)
}

/** A ravine's centre column at row m: a meander from its head to its mouth, wandering with fBm. */
function ravineCentre(seed: number, salt: number, B: number, m: number, head: number, mouth: number, mouthRow: number): number {
  const t = clamp01(m / mouthRow)
  const base = head + (mouth - head) * t
  return base + (fbm(seed ^ salt, 0, m, B / 6, 3) - 0.5) * B * 0.12
}

interface Ravine { salt: number; head: number; mouth: number; half: number; main: boolean }

/** The ravines: the Grand Ravine from the north-east to the harbour's east side, and two lesser ones. */
function ravines(seed: number, B: number): Ravine[] {
  const h = hash2(seed, 3, 5)
  return [
    { salt: 0x9a71, head: B * (0.6 + 0.08 * h), mouth: B * 0.56, half: Math.max(1, B / 64), main: true },
    { salt: 0x9a72, head: B * (0.3 + 0.06 * h), mouth: B * 0.36, half: Math.max(0.6, B / 110), main: false },
    { salt: 0x9a73, head: B * (0.82 - 0.05 * h), mouth: B * 0.74, half: Math.max(0.6, B / 128), main: false },
  ]
}

/** Snaps a block coordinate to the nearest arterial intersection (every `every` blocks), inside the map. */
const snap = (v: number, every: number, B: number) => Math.min(B - every, Math.max(every, Math.round(v / every) * every))

/**
 * Generates the lakefront metropolis for `seed`: the lake, the ravines, the zones and terrain, the hubs and The Spire,
 * then macroCity's streets and the zones' own footprints over the lots this file assigns. Deterministic. `blocks` as
 * macroCity (default 256: 10.24 km).
 */
export function generateLakefront(seed: number, blocks: number = MACRO.blocks): LakefrontMap {
  if (!Number.isInteger(blocks) || blocks < 8 || blocks > 1024) throw new RangeError('blocks must be an integer in 8…1024')
  const B = blocks
  const every = Math.min(MACRO.arterialEvery, Math.max(4, B >> 2))
  const shore = new Float32Array(B)
  for (let k = 0; k < B; k++) shore[k] = shoreAt(seed, B, k)
  const zones = new Uint8Array(B * B), terrain = new Uint8Array(B * B), elevation = new Float32Array(B * B)
  const rav = ravines(seed, B)
  const coreK = B / 2
  // The core's waterfront row: the shore at the centre column.
  const coreM = shore[Math.floor(coreK)]
  const inRavine = (k: number, m: number): Ravine | null => {
    for (const r of rav) {
      const mouthRow = shore[Math.min(B - 1, Math.max(0, Math.round(r.mouth)))]
      if (m > mouthRow) continue
      if (Math.abs(k + 0.5 - ravineCentre(seed, r.salt, B, m, r.head, r.mouth, mouthRow)) < r.half) return r
    }
    return null
  }
  // Terrain and elevation.
  for (let m = 0; m < B; m++) for (let k = 0; k < B; k++) {
    const i = m * B + k
    const u = (k + 0.5) / B, v = (m + 0.5) / B
    const lake = m + 0.5 >= shore[k]
    const rise = smooth(0.5, 0.05, v) * 0.5 + 0.25 * fbm(seed ^ 0xe1e7, k, m, B / 5)
    const east = u > 0.62 && shore[k] - (m + 0.5) < B * 0.05 && !lake
    elevation[i] = lake ? 0 : clamp01(0.15 + rise + (east ? 0.3 : 0))
    const r = lake ? null : inRavine(k, m)
    if (lake) terrain[i] = TERRAIN.lake
    else if (r) terrain[i] = TERRAIN.ravine
    else if (shore[k] - (m + 0.5) < 1.5) terrain[i] = east ? TERRAIN.bluff : TERRAIN.shore
    else if (east) terrain[i] = TERRAIN.bluff
    else if (v < 0.22 && elevation[i] > 0.6) terrain[i] = TERRAIN.ridge
    else terrain[i] = TERRAIN.flat
  }
  // Zones: the lake; the main ravine's corridor; the core and old city around the harbour; else by the compass.
  const mainCorridor = (k: number, m: number): boolean => {
    const r = rav[0]
    const mouthRow = shore[Math.min(B - 1, Math.max(0, Math.round(r.mouth)))]
    if (m > mouthRow) return false
    return Math.abs(k + 0.5 - ravineCentre(seed, r.salt, B, m, r.head, r.mouth, mouthRow)) < r.half + Math.max(1.5, B / 40)
  }
  for (let m = 0; m < B; m++) for (let k = 0; k < B; k++) {
    const i = m * B + k
    if (terrain[i] === TERRAIN.lake) { zones[i] = ZONE.lake; continue }
    if (mainCorridor(k, m)) { zones[i] = ZONE.grandRavine; continue }
    const u = (k + 0.5) / B, v = (m + 0.5) / B
    const dCore = Math.hypot((k + 0.5 - coreK) / B, ((m + 0.5) - coreM) / B * 1.4)
    if (dCore < 0.2 + 0.02 * noise(seed + 17, k, m, 9)) { zones[i] = ZONE.metropolis; continue }
    const north = v < 0.36, west = u < 0.5 - (v - 0.36) * 0.15, eastSide = u > 0.5 + (v - 0.36) * 0.15
    if (north && !(west && u < 0.22) && !(eastSide && u > 0.8)) zones[i] = ZONE.northRidge
    else if (u < 0.5) zones[i] = ZONE.westSprawl
    else zones[i] = ZONE.eastBluffs
  }
  // Transit hubs: Transit City in the west, one more west, two north, one east, each on an arterial crossing.
  const hubs: Hub[] = []
  const hub = (name: string, zone: Zone, u: number, v: number, radius: number) => {
    const k = snap(u * B, every, B), m = snap(v * B, every, B)
    if (m + 0.5 < shore[Math.min(B - 1, k)] - 2) hubs.push({ name, k, m, zone, radius })
  }
  const jitter = (a: number) => (hash2(seed, 23, a) - 0.5) * 0.06
  hub(LANDMARK.transitCity, ZONE.westSprawl, 0.22 + jitter(1), 0.5 + jitter(2), 2)
  hub(`${fictionalName(seed, 31, 1)} Station`, ZONE.westSprawl, 0.12 + jitter(3), 0.3 + jitter(4), 1)
  hub(`${fictionalName(seed, 31, 2)} Centre`, ZONE.northRidge, 0.5 + jitter(5), 0.14 + jitter(6), 2)
  hub(`${fictionalName(seed, 31, 3)} Station`, ZONE.northRidge, 0.7 + jitter(7), 0.22 + jitter(8), 1)
  hub(`${fictionalName(seed, 31, 4)} Town Centre`, ZONE.eastBluffs, 0.82 + jitter(9), 0.5 + jitter(10), 2)
  for (const h of hubs) h.zone = zones[h.m * B + h.k] as Zone
  const hubAt = (k: number, m: number): Hub | null => {
    for (const h of hubs) if (Math.max(Math.abs(k + 0.5 - h.k), Math.abs(m + 0.5 - h.m)) <= h.radius) return h
    return null
  }
  // The Spire: on the waterfront at the centre of the core, the land block just north of the harbour's shore.
  const spire = { k: Math.floor(coreK), m: Math.max(0, Math.ceil(coreM) - 1) }
  for (let m = spire.m; m >= 0; m--) if (terrain[m * B + spire.k] !== TERRAIN.lake) { spire.m = m; break }

  const near = (k: number, m: number) => Math.hypot((k + 0.5 - coreK) / B, ((m + 0.5) - coreM) / B * 1.4)
  const lotAt = (k: number, m: number): LotKind => {
    const i = m * B + k, z = zones[i], t = terrain[i]
    if (z === ZONE.lake) return LOT.water
    if (t === TERRAIN.ravine) return LOT.park
    if (k === spire.k && m === spire.m) return LOT.downtown
    const h = hash2(seed, k, m), h1 = hash2(seed + 1, k, m), n = noise(seed + 11, k, m, 9)
    const hb = z === ZONE.grandRavine ? null : hubAt(k, m)
    if (hb) return Math.abs(k + 0.5 - hb.k) < 0.6 && Math.abs(m + 0.5 - hb.m) < 0.6 ? LOT.plaza : h < 0.06 ? LOT.civic : LOT.downtown
    switch (z) {
      case ZONE.metropolis: {
        const d = near(k, m)
        if (t === TERRAIN.shore) return Math.abs(k + 0.5 - coreK) < B * 0.06 ? LOT.park : LOT.industrial // the waterfront park, the port lands
        if (d < 0.11 + 0.015 * n) return h < 0.06 ? LOT.plaza : h1 < 0.04 ? LOT.civic : LOT.downtown
        if (n > 0.86) return LOT.park
        if (n > 0.76 && d > 0.16) return LOT.industrial
        return h1 < 0.015 ? LOT.civic : LOT.residential
      }
      case ZONE.grandRavine:
        return n > 0.7 ? LOT.park : h1 < 0.01 ? LOT.civic : LOT.residential
      case ZONE.eastBluffs:
        if (t === TERRAIN.bluff && shore[k] - (m + 0.5) < 1.5) return LOT.park // the cliff edge
        if (n > 0.84) return LOT.park
        if (n > 0.78) return LOT.industrial
        return h1 < 0.01 ? LOT.civic : LOT.residential
      case ZONE.westSprawl:
      case ZONE.northRidge:
        if (t === TERRAIN.shore) return n > 0.5 ? LOT.industrial : LOT.park
        if (n > 0.85) return LOT.park
        if (n > 0.77) return LOT.industrial
        return h1 < 0.01 ? LOT.civic : LOT.residential
      default:
        return LOT.park
    }
  }
  const blocked = (k: number, m: number): boolean => terrain[m * B + k] === TERRAIN.ravine

  const footprints = (li: number, kind: LotKind, k: number, m: number, r: () => number, push: PushFootprint): void => {
    const z = zones[m * B + k]
    if (k === spire.k && m === spire.m) { push(li, 100, 100, 160, 160, 168); push(li, 30, 30, 230, 90, 2); return }
    if (kind === LOT.civic) { push(li, 40, 40, 220, 220, 3 + Math.floor(r() * 4)); return }
    if (kind === LOT.park) { if (r() < 0.15) push(li, 110, 110, 150, 150, 1); return }
    if (kind === LOT.industrial) { push(li, 20, 20, 240, 200 + Math.floor(r() * 40), 1 + Math.floor(r() * 2)); return }
    if (kind === LOT.plaza) return
    const hb = z === ZONE.grandRavine ? null : hubAt(k, m)
    if (kind === LOT.downtown) {
      if (hb) {
        // A hub: a tower on a podium.
        push(li, 10, 10, 250, 250, 2)
        push(li, 50, 50, 210, 210, 14 + Math.floor(r() * 30))
      } else if (z === ZONE.metropolis) {
        if (r() < 0.5) push(li, 10, 10, 250, 250, 24 + Math.floor(r() * 50))
        else { push(li, 0, 0, 125, 260, 12 + Math.floor(r() * 28)); push(li, 135, 0, 260, 260, 12 + Math.floor(r() * 28)) }
      } else push(li, 20, 20, 240, 240, 4 + Math.floor(r() * 6))
      return
    }
    if (kind === LOT.residential) {
      if (z === ZONE.metropolis) {
        // The old city: apartment blocks around a courtyard.
        push(li, 8, 8, 252, 90, 4 + Math.floor(r() * 5)); push(li, 8, 170, 252, 252, 4 + Math.floor(r() * 5))
      } else {
        // The sprawl: two rows of detached houses, three or four to a row.
        const cols = 3 + Math.floor(r() * 2), w = Math.floor(260 / cols)
        for (let c = 0; c < cols; c++) for (let q = 0; q < 2; q++) push(li, c * w + 10, q * 130 + 25, (c + 1) * w - 10, q * 130 + 105, 2)
      }
    }
  }

  const plan: MacroPlan = { lotAt, blocked, footprints }
  const macro = generateMacroCity(seed, B, plan)
  return { ...macro, terrain, zones, elevation, shore, hubs, spire }
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
export interface Landmark { name: string; kind: 'spire' | 'hub'; k: number; m: number; floors: number }

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
  terrain: Record<(typeof TERRAIN_NAMES)[number], number>
  lots: Record<(typeof LOT_NAMES)[number], number>
  buildings: { count: number; floors: { min: number; mean: number; max: number }; tallest: { k: number; m: number; floors: number } | null }
  streets: { arterial: number; local: number; pedestrian: number; bridge: number }
  /** The Spire and the transit hubs in this zone. */
  landmarks: Landmark[]
  /** The zone's neighbourhoods: connected runs of one lot kind, largest first (at most 24). */
  districts: District[]
  /** Which other zones (by slug) it touches. */
  neighbours: string[]
}

const round = (v: number, places = 3) => Math.round(v * 10 ** places) / 10 ** places

/** The structural layout of zone `zone` of `map`. */
export function zoneLayout(map: LakefrontMap, zone: number): ZoneLayout {
  const B = map.blocks, region = REGIONS[zone]
  if (!region) throw new RangeError(`no region ${zone}`)
  const extent: Extent = { k0: B, m0: B, k1: -1, m1: -1 }
  let n = 0, land = 0, ck = 0, cm = 0, eMin = 1, eMax = 0, eSum = 0
  const terrain = Object.fromEntries(TERRAIN_NAMES.map((t) => [t, 0])) as ZoneLayout['terrain']
  const lots = Object.fromEntries(LOT_NAMES.map((t) => [t, 0])) as ZoneLayout['lots']
  const touching = new Set<number>()
  for (let m = 0; m < B; m++) for (let k = 0; k < B; k++) {
    const i = m * B + k, z = map.zones[i]
    if (z !== ZONE.lake) land++
    if (z !== zone) continue
    n++
    ck += k + 0.5; cm += m + 0.5
    extent.k0 = Math.min(extent.k0, k); extent.m0 = Math.min(extent.m0, m); extent.k1 = Math.max(extent.k1, k); extent.m1 = Math.max(extent.m1, m)
    const e = map.elevation[i]
    eMin = Math.min(eMin, e); eMax = Math.max(eMax, e); eSum += e
    terrain[TERRAIN_NAMES[map.terrain[i]]]++
    lots[LOT_NAMES[map.lots[i]]]++
    for (const [dk, dm] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const kk = k + dk, mm = m + dm
      if (kk < 0 || mm < 0 || kk >= B || mm >= B) continue
      const o = map.zones[mm * B + kk]
      if (o !== zone && o !== ZONE.lake) touching.add(o)
    }
  }
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
  const streets = { arterial: 0, local: 0, pedestrian: 0, bridge: 0 }
  const tally = (kind: number) => {
    if (kind === STREET.arterial) streets.arterial++
    else if (kind === STREET.local) streets.local++
    else if (kind === STREET.pedestrian) streets.pedestrian++
    else if (kind === STREET.bridge) streets.bridge++
  }
  const zoneAt = (k: number, m: number) => (k < 0 || m < 0 || k >= B || m >= B ? ZONE.lake : map.zones[m * B + k])
  for (let m = 0; m <= B; m++) for (let k = 0; k < B; k++) if (zoneAt(k, m - 1) === zone || zoneAt(k, m) === zone) tally(map.hStreets[m * B + k])
  for (let k = 0; k <= B; k++) for (let m = 0; m < B; m++) if (zoneAt(k - 1, m) === zone || zoneAt(k, m) === zone) tally(map.vStreets[k * B + m])
  const landmarks: Landmark[] = []
  /** The tallest building within `radius` blocks of (k, m). */
  const floorsAt = (k: number, m: number, radius: number): number => {
    let best = 0
    for (let i = 0; i < fp.length; i += 6) {
      const li = fp[i]
      if (Math.max(Math.abs((li % B) + 0.5 - k), Math.abs(Math.floor(li / B) + 0.5 - m)) <= radius) best = Math.max(best, fp[i + 5])
    }
    return best
  }
  if (map.zones[map.spire.m * B + map.spire.k] === zone) landmarks.push({ name: LANDMARK.spire, kind: 'spire', k: map.spire.k, m: map.spire.m, floors: floorsAt(map.spire.k + 0.5, map.spire.m + 0.5, 0.5) })
  for (const h of map.hubs) if (h.zone === zone) landmarks.push({ name: h.name, kind: 'hub', k: h.k, m: h.m, floors: floorsAt(h.k, h.m, h.radius) })

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
    terrain,
    lots,
    buildings: { count, floors: count ? { min: fMin, mean: round(fSum / count, 2), max: fMax } : { min: 0, mean: 0, max: 0 }, tallest },
    streets,
    landmarks,
    districts: districts(map, zone),
    neighbours: [...touching].sort().map((z) => REGIONS[z].slug),
  }
}

/** The zone's connected runs of one lot kind (4-neighbour), four blocks or more, largest first, at most 24, each named. */
export function districts(map: LakefrontMap, zone: number): District[] {
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

/** The index of a map's zone layouts: the map's identity, its landmarks, and a line per region (the file each layout is written to). */
export interface LakefrontIndex {
  format: typeof LAKEFRONT_FORMAT
  seed: number
  blocks: number
  pitch: number
  size: number
  /** FNV-1a of the serialised macro city (lots, streets, footprints): the map's fingerprint. */
  fingerprint: string
  land: { blocks: number; km2: number }
  lake: { blocks: number; km2: number }
  spire: { name: string; k: number; m: number; floors: number; heightMetres: number }
  hubs: { name: string; region: string; k: number; m: number }[]
  regions: { id: number; slug: string; name: string; biome: string; blocks: number; file: string }[]
}

/** Storey height, m, as region/fromMacro.ts builds it (repeated here so the index needs no pack). */
const FLOOR_METRES = 3.3

export function lakefrontIndex(map: LakefrontMap, layouts: readonly ZoneLayout[]): LakefrontIndex {
  const land = layouts.reduce((s, l) => s + l.area.blocks, 0)
  const lake = map.blocks * map.blocks - land
  const spireFloors = layouts.flatMap((l) => l.landmarks).find((l) => l.kind === 'spire')?.floors ?? 0
  return {
    format: LAKEFRONT_FORMAT,
    seed: map.seed,
    blocks: map.blocks,
    pitch: MACRO.pitch,
    size: map.blocks * MACRO.pitch,
    fingerprint: fnv1a(serializeMacroCity(map)).toString(16).padStart(8, '0'),
    land: { blocks: land, km2: round((land * MACRO.pitch * MACRO.pitch) / 1e6) },
    lake: { blocks: lake, km2: round((lake * MACRO.pitch * MACRO.pitch) / 1e6) },
    spire: { name: LANDMARK.spire, k: map.spire.k, m: map.spire.m, floors: spireFloors, heightMetres: round(spireFloors * FLOOR_METRES, 1) },
    hubs: map.hubs.map((h) => ({ name: h.name, region: REGIONS[h.zone].name, k: h.k, m: h.m })),
    regions: layouts.map((l) => ({ id: l.region.id, slug: l.region.slug, name: l.region.name, biome: l.region.biome, blocks: l.area.blocks, file: `${l.region.slug}.json` })),
  }
}

/** Every zone's layout, in zone order. */
export const zoneLayouts = (map: LakefrontMap): ZoneLayout[] => REGIONS.map((r) => zoneLayout(map, r.id))
