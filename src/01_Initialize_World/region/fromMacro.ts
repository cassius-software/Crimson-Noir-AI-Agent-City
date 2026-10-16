// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It turns a generated macro map (macroCity.ts, lakefront.ts) into a region pack (pack.ts),
 * the one document the engine already knows how to walk: every street becomes a road at its class and lanes, every run
 * of water blocks a water polygon, every footprint a building at its floors' height, and every street line gets a
 * fictitious name from the region word lists. So the lakefront metropolis the onboarding builds in the background is
 * walked through the same regionWorld.ts path as a surveyed region, with nothing new in the engine.
 * What breaks if it is removed? A generated map can be drawn as a minimap and written out as layouts, but never walked.
 */
import { LOT, MACRO, STREET, type MacroCity } from '../macroCity.ts'
import { signedArea2, type Pt } from './clip.ts'
import { NAME_HEADS, NAME_TAILS } from './names.ts'
import { BUILDING_KIND, DM, FLOW, REGION_FORMAT, ROAD_CLASS, WATER_KIND, polygons, pushPolygon, type RegionPack } from './pack.ts'

/** Storey height, m: a floor count becomes a building height. */
export const FLOOR_HEIGHT = 3.3

/** A fictional grid for a fictitious place: no real meridian. The pack's coordinates are the map's own metres. */
export const FICTIONAL_GRID = Object.freeze({ lon0: -121.7, lat0: 36.4, k0: 0.9996 })

const orient = (ring: Pt[]): Pt[] => (-signedArea2(ring) > 0 ? ring : ring.slice().reverse())
const rect = (x0: number, z0: number, x1: number, z1: number): Pt[] => orient([[x0, z0], [x1, z0], [x1, z1], [x0, z1]])

const hash = (seed: number, a: number, b: number): number => {
  let h = (seed ^ Math.imul(a + 1, 0x27d4eb2d) ^ Math.imul(b + 1, 0x165667b1)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/**
 * A fictitious, injective street name per line: east-west lines are Streets (arterials Boulevards), north-south lines
 * Avenues (arterials Highways); a compound already taken on this map gets the next one in the hash's order.
 */
export function streetNames(seed: number, blocks: number, kinds: (h: boolean, line: number) => number): { names: string[]; h: number[]; v: number[] } {
  const names = ['']
  const taken = new Set<string>()
  const pick = (h: boolean, line: number): number => {
    const kind = kinds(h, line)
    if (kind === STREET.none) return 0
    let n = hash(seed, h ? 1 : 2, line)
    let body = ''
    for (let i = 0; i < 64; i++) {
      body = NAME_HEADS[n % NAME_HEADS.length] + NAME_TAILS[Math.floor(n / NAME_HEADS.length) % NAME_TAILS.length]
      if (!taken.has(body)) break
      n = hash(seed, n, i)
    }
    if (taken.has(body)) body = `${body} ${line}` // past 64 collisions (never on a 1024-block map); still injective
    taken.add(body)
    const type = kind === STREET.arterial || kind === STREET.bridge ? (h ? 'Boulevard' : 'Highway') : kind === STREET.pedestrian ? 'Walk' : h ? 'Street' : 'Avenue'
    names.push(`${body} ${type}`)
    return names.length - 1
  }
  const h: number[] = [], v: number[] = []
  for (let m = 0; m <= blocks; m++) h.push(pick(true, m))
  for (let k = 0; k <= blocks; k++) v.push(pick(false, k))
  return { names, h, v }
}

/**
 * What a street kind is as a road: its class and lanes (none: not a road). Every street cars use has two lanes, one
 * each way, like the procedural city's: the crowd walks the sidewalk beyond them and the fleet drives the right-hand
 * one (region/streets.ts). A pedestrian street is a one-lane road: walked, never driven.
 */
export function roadOf(kind: number): { cls: number; lanes: number } | null {
  switch (kind) {
    case STREET.arterial: case STREET.bridge: return { cls: ROAD_CLASS.arterial, lanes: 2 }
    case STREET.local: return { cls: ROAD_CLASS.local, lanes: 2 }
    case STREET.pedestrian: return { cls: ROAD_CLASS.local, lanes: 1 }
    default: return null
  }
}

export interface FromMacroOptions {
  /** The region's fictional name. */
  name: string
  /** Statements shown in the product's notices: that the map is procedural and its names fictitious. */
  attribution: readonly string[]
  /** The sea's and the lakes' fictitious name (one water body on this map: the one the blocks make). */
  waterName?: string
  /**
   * The map point, metres, that becomes the pack's (0, 0): the engine spawns on the arterial sidewalk nearest a region's
   * origin, so this is where the first walk starts (a zone's centre). Absent: the map's north-west corner.
   */
  origin?: { x: number; z: number }
}

/**
 * The region pack of a macro map: roads from the streets (one road per run of one kind along a line), water from the
 * water blocks (one polygon per run along a row), buildings from the footprints. Coordinates are the map's metres.
 */
export function macroToRegionPack(map: MacroCity, o: FromMacroOptions): RegionPack {
  const B = map.blocks, P = MACRO.pitch
  const hKind = (m: number, k: number) => map.hStreets[m * B + k]
  const vKind = (k: number, m: number) => map.vStreets[k * B + m]
  const dominant = (h: boolean, line: number): number => {
    // The line's most common built kind (arterials are whole lines; a local line is named once).
    const counts = new Map<number, number>()
    for (let i = 0; i < B; i++) {
      const kind = h ? hKind(line, i) : vKind(line, i)
      if (kind !== STREET.none) counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
    let best: number = STREET.none, n = 0
    for (const [kind, c] of counts) if (c > n || (c === n && kind < best)) { best = kind; n = c }
    return best
  }
  const named = streetNames(map.seed, B, dominant)
  const roads: RegionPack['roads'] = { cls: [], lanes: [], flow: [], name: [], start: [0], xz: [] }
  const ox = o.origin?.x ?? 0, oz = o.origin?.z ?? 0
  const emit = (cls: number, lanes: number, name: number, pts: readonly Pt[]) => {
    roads.cls.push(cls); roads.lanes.push(lanes); roads.flow.push(FLOW.both); roads.name.push(name)
    for (const [x, z] of pts) roads.xz.push(Math.round((x - ox) * DM), Math.round((z - oz) * DM))
    roads.start.push(roads.xz.length / 2)
  }
  for (let m = 0; m <= B; m++) {
    let k = 0
    while (k < B) {
      const kind = hKind(m, k)
      if (kind === STREET.none) { k++; continue }
      let end = k
      while (end + 1 < B && hKind(m, end + 1) === kind) end++
      const r = roadOf(kind)
      if (r) emit(r.cls, r.lanes, named.h[m], [[k * P, m * P], [(end + 1) * P, m * P]])
      k = end + 1
    }
  }
  for (let k = 0; k <= B; k++) {
    let m = 0
    while (m < B) {
      const kind = vKind(k, m)
      if (kind === STREET.none) { m++; continue }
      let end = m
      while (end + 1 < B && vKind(k, end + 1) === kind) end++
      const r = roadOf(kind)
      if (r) emit(r.cls, r.lanes, named.v[k], [[k * P, m * P], [k * P, (end + 1) * P]])
      m = end + 1
    }
  }
  const names = named.names.slice()
  const waterName = o.waterName ?? ''
  const waterIndex = waterName ? names.push(waterName) - 1 : 0
  const water: RegionPack['water'] = { ...polygons(), kind: [], name: [] }
  for (let m = 0; m < B; m++) {
    let k = 0
    while (k < B) {
      if (map.lots[m * B + k] !== LOT.water) { k++; continue }
      let end = k
      while (end + 1 < B && map.lots[m * B + end + 1] === LOT.water) end++
      pushPolygon(water, [rect(k * P - ox, m * P - oz, (end + 1) * P - ox, (m + 1) * P - oz)])
      water.kind.push(WATER_KIND.lake); water.name.push(waterIndex)
      k = end + 1
    }
  }
  const buildings: RegionPack['buildings'] = { ...polygons(), height: [], kind: [] }
  const fp = map.footprints, band = MACRO.bandHalf
  for (let i = 0; i < fp.length; i += 6) {
    const li = fp[i], k = li % B, m = Math.floor(li / B)
    const x = k * P + band - ox, z = m * P + band - oz
    pushPolygon(buildings, [rect(x + fp[i + 1] / 10, z + fp[i + 2] / 10, x + fp[i + 3] / 10, z + fp[i + 4] / 10)])
    buildings.height.push(Math.round(fp[i + 5] * FLOOR_HEIGHT * DM)) // whole decimetres, as the compiler writes them
    buildings.kind.push(map.lots[li] === LOT.civic ? BUILDING_KIND.civic : BUILDING_KIND.building)
  }
  return {
    format: REGION_FORMAT,
    name: o.name,
    grid: { ...FICTIONAL_GRID },
    bounds: { x0: -ox, z0: -oz, x1: B * P - ox, z1: B * P - oz },
    attribution: [...o.attribution],
    names,
    roads,
    water,
    buildings,
  }
}
