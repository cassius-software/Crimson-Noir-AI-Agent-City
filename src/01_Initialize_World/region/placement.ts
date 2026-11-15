// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It shares a generated region's places out over the whole map: which lots of Lakefront
 * Metro become its sixteen indoor workplaces (interiors.ts), its five storefronts (storefronts.ts) and its seven homes
 * (properties.ts), which street front each doorway faces, and where a visitor who chose a quarter first stands.
 * The places used to be the nearest lots to the start inside the one street window (streets.ts: 640 m of a map 2.56 km
 * across), so more than nine tenths of the map had none and every quarter the visitor did not start in was empty of them. Here
 * the map is read whole (streets.ts mapStreetGrid) and the places go by a programme (PROGRAMME): each of the pack's
 * quarters (pack.ts Quarters: the lakefront's five regions) gets the kinds that suit it, one shop and at least one
 * workplace in every quarter, the homes where their names say they stand (a tower's foot downtown, the bluffs, the
 * shore, a hub's podium on the ridge).
 * - A quarter's heart (its anchor) is the middle of its tallest cluster: the lot with the most built volume round it,
 *   or, in a quarter with no tower at all, the lot nearest its centroid.
 * - Its first places, the starters, stand by the heart: the shop within three lots of it, the others within two lots
 *   of the shop (farther only where no lot that near is free), so whoever starts there has a shop and a workplace in
 *   sight.
 * - The rest are spread: each takes a lot at least `cap` lots from every place already chosen and from the heart
 *   (as far as the quarter allows), the dice choosing among those, so they stand apart like a thrown handful and not
 *   in a row.
 * - No two places stand on neighbouring lots, not even corner to corner (SPACING), and no doorway faces the street
 *   round the map's edge or stands on a ravine's floor.
 * The lots are the engine's lot indices, which do not depend on where the visitor starts, so one placement serves every
 * start: a home is on the same corner whichever quarter the visitor chose. Deterministic, the pack only read.
 * Pure, and no three.js: the page picks the places and the physics worker receives them as data.
 * What breaks if it is removed? Lakefront Metro has no workplaces, shops or homes, and its visitor no start.
 */
import { createRng } from '../../02_Define_The_Rules/degrees.ts'
import { CITY } from '../city.ts'
import { WORKPLACE_KINDS, doorDir, type Side, type WorkplaceKind, type WorkplaceLot } from '../interiors.ts'
import { PROPERTY_KINDS, type HomeLot, type PropertyKind } from '../properties.ts'
import { SHOP_KINDS, type ShopKind, type ShopLot } from '../storefronts.ts'
import { DM, polygonCount, type RegionPack } from './pack.ts'
import { GROUND, quarterAt, terrainAt } from './quarters.ts'
import { SIDEWALK, mapStreetGrid, type StreetGrid } from './streets.ts'
import { LOT_TIERS, buildingLot, lotCandidates } from './workplaces.ts'

const P = CITY.pitch

/** Lots between any two places, Chebyshev: never on neighbouring lots, not even corner to corner. */
export const SPACING = 2
/** How far from a quarter's heart its shop may stand, lots (widened a lot at a time where the heart has no free lot). */
export const STARTER_RING = 3
/** How far from the quarter's shop its other starters may stand, lots (widened likewise). */
export const STARTER_REACH = 2
/** The dice's salt: one draw per lot of the map in row order, then one per place for its doorway's side. */
export const PLACEMENT_SALT = 0x91ace5

/** What leads a spread place's choice of lot: how far it stands from the others, what stands on the lot, or the ground. */
type Lead = 'reach' | 'tier' | 'terrain'

interface Want {
  /** Lot tiers (workplaces.ts lotTier), best first. */
  tiers: readonly number[]
  /** Grounds (quarters.ts GROUND) the place would rather stand on, best first; absent: any. Binds spread places only. */
  ground?: readonly number[]
  lead: Lead
}

/** One place of the programme: what it is, and whether it stands by its quarter's heart. */
export type Programmed =
  | { type: 'shop'; kind: ShopKind; starter: boolean }
  | { type: 'home'; kind: PropertyKind; starter: boolean }
  | { type: 'work'; kind: WorkplaceKind; starter: boolean }

const shop = (kind: ShopKind, starter = false): Programmed => ({ type: 'shop', kind, starter })
const home = (kind: PropertyKind, starter = false): Programmed => ({ type: 'home', kind, starter })
const work = (kind: WorkplaceKind, starter = false): Programmed => ({ type: 'work', kind, starter })

/**
 * The programme: which places each of the lakefront's five quarters has, in the quarters' id order (lakefront.ts
 * ZONE), each quarter's starters first. Sixteen workplaces, five shops, seven homes, each once.
 * - Lakefront Metropolis (the core): the tailor, the micro-loft and the console deck by its heart; the clearing floor,
 *   the server vault, the twin studio and the penthouse on tower lots.
 * - West Sprawl (the working suburb round Transit City): the prosthetics atelier, the robotics lab and the micro-fab by
 *   its heart; the warehouse and the fleet bay out in the grid, the timber loft down by the shore.
 * - The East Bluffs: the ink studio, the kitchen and the acoustics chamber by its heart; the response centre inland,
 *   the glass villa and the estate on the bluffs over the lake.
 * - North Ridge (the hubs on the rise): the horology shop, the sky-mansion and the control tower at a hub's towers; the
 *   gait lab and the microgrid along the ridge.
 * - The Grand Ravine: the design house, the brownstone and the greenhouse by the valley; the metro operations centre
 *   farther along it.
 */
export const PROGRAMME: readonly (readonly Programmed[])[] = Object.freeze([
  Object.freeze([shop('tailor', true), home('microLoft', true), work('consoleDeck', true), work('clearingFloor'), work('serverVault'), work('twinStudio'), home('penthouse')]),
  Object.freeze([shop('prosthetics', true), work('roboticsLab', true), work('microFab', true), work('warehouse'), work('fleetBay'), home('timberLoft')]),
  Object.freeze([shop('inkStudio', true), work('kitchen', true), work('acousticsLab', true), work('responseCenter'), home('glassVilla'), home('estate')]),
  Object.freeze([shop('horology', true), home('skyMansion', true), work('controlTower', true), work('gaitLab'), work('microgrid')]),
  Object.freeze([shop('designHouse', true), home('brownstone', true), work('greenhouse', true), work('metroOps')]),
])

/** A map without the quarters layer is one quarter: the first shop, home and workplace by its heart, the rest spread. */
const SINGLE: readonly Programmed[] = Object.freeze([
  shop(SHOP_KINDS[0], true), home(PROPERTY_KINDS[0], true), work(WORKPLACE_KINDS[0], true),
  ...WORKPLACE_KINDS.slice(1).map((k) => work(k)), ...SHOP_KINDS.slice(1).map((k) => shop(k)), ...PROPERTY_KINDS.slice(1).map((k) => home(k)),
])

const BEST_BUILT = [0, 1, 2, 3, 5, 4] as const
const TOWERS = [1, 0, 2, 3, 5, 4] as const
const SHEDS = [3, 2, 5, 4, 1, 0] as const
const HOUSES = [2, 3, 5, 4, 1, 0] as const
const VILLAS = [3, 5, 2, 4, 1, 0] as const
const FRONTS = [2, 3, 1, 0, 5, 4] as const

/** What each kind wants of its lot (lot tiers are workplaces.ts LOT_TIERS: 0 a hub's podium and tower … 5 anything else). */
function wantOf(p: Programmed): Want {
  if (p.type === 'shop') return { tiers: FRONTS, lead: 'reach' }
  if (p.type === 'home') {
    switch (p.kind) {
      case 'skyMansion': return { tiers: BEST_BUILT, ground: [GROUND.ridge], lead: 'tier' }
      case 'penthouse': return { tiers: TOWERS, lead: 'tier' }
      case 'glassVilla': case 'estate': return { tiers: VILLAS, ground: [GROUND.bluff, GROUND.shore], lead: 'terrain' }
      case 'timberLoft': return { tiers: HOUSES, ground: [GROUND.shore], lead: 'terrain' }
      default: return { tiers: HOUSES, lead: 'reach' }
    }
  }
  switch (p.kind) {
    case 'clearingFloor': case 'serverVault': case 'twinStudio': return { tiers: TOWERS, lead: 'tier' }
    case 'consoleDeck': return { tiers: TOWERS, lead: 'reach' }
    case 'warehouse': case 'fleetBay': case 'microFab': case 'greenhouse': case 'metroOps': case 'kitchen': return { tiers: SHEDS, lead: 'reach' }
    default: return { tiers: BEST_BUILT, lead: 'reach' }
  }
}

/** Where a visitor who chose a quarter first stands, engine metres: a hint the engine snaps to a sidewalk. */
export interface PlacedStart { quarter: number; x: number; z: number }

export interface RegionPlacement {
  /** In WORKPLACE_KINDS order, no kind left out before one that stands. */
  workplaces: WorkplaceLot[]
  /** In SHOP_KINDS order, likewise. */
  shops: ShopLot[]
  /** By property index, ascending, likewise. */
  homes: HomeLot[]
  /**
   * One per quarter, in id order: across the street from the quarter's shop's doorway (or its first place, or its heart),
   * on a sidewalk in the quarter itself wherever one of its places allows it (regionStart.test.ts, 401 seeds).
   */
  starts: PlacedStart[]
  /** Each quarter's heart: an engine lot. */
  anchors: { quarter: number; k: number; m: number }[]
}

interface Lot { i: number; j: number; tier: number; sides: Side[]; quarter: number; ground: number; die: number }

const cheb = (ai: number, aj: number, bi: number, bj: number): number => Math.max(Math.abs(ai - bi), Math.abs(aj - bj))
const rank = (order: readonly number[] | undefined, v: number): number => {
  if (!order) return 0
  const at = order.indexOf(v)
  return at < 0 ? order.length : at
}
/** The first of `lots` by `key` (numbers compared in turn, lower first), or null when there is none. */
function best<T>(lots: readonly T[], key: (l: T) => number[]): T | null {
  let pick: T | null = null, pickKey: number[] = []
  for (const l of lots) {
    const k = key(l)
    let less = pick === null
    for (let n = 0; !less && n < k.length; n++) {
      if (k[n] === pickKey[n]) continue
      less = k[n] < pickKey[n]
      break
    }
    if (less) { pick = l; pickKey = k }
  }
  return pick
}

/** Twice the area of building i's outer ring, in the pack's own square decimetres: a whole number, the same from every start. */
function area2Dm(pack: Pick<RegionPack, 'buildings'>, i: number): number {
  const t = pack.buildings
  const r = t.polyStart[i]
  if (r >= t.polyStart[i + 1]) return 0
  const a = t.ringStart[r], b = t.ringStart[r + 1]
  let s = 0
  for (let p = a, q = b - 1; p < b; q = p++) s += t.xz[2 * q] * t.xz[2 * p + 1] - t.xz[2 * p] * t.xz[2 * q + 1]
  return Math.abs(s)
}

const cache = new WeakMap<RegionPack, Map<string, RegionPlacement | null>>()

/**
 * The places of a generated region, over its whole map, and the start of each of its quarters; null for a pack whose
 * roads do not lie on the grid (a surveyed region has no street grid and no places). `layout` is regionWorld.ts
 * layoutOf's (its offset is added to the pack's metres). The same for every quarter the pack may start in (the layer's
 * `home` is not read), and for every call: kept per pack and seed.
 */
export function regionPlacement(pack: RegionPack, layout: { offset: { x: number; z: number } }, seed: number): RegionPlacement | null {
  const key = `${seed >>> 0}|${layout.offset.x}|${layout.offset.z}`
  let byKey = cache.get(pack)
  if (!byKey) cache.set(pack, (byKey = new Map()))
  const kept = byKey.get(key)
  if (kept !== undefined) return kept
  const placed = place(pack, layout.offset, seed)
  byKey.set(key, placed)
  return placed
}

function place(pack: RegionPack, off: { x: number; z: number }, seed: number): RegionPlacement | null {
  const map = mapStreetGrid(pack, off)
  if (!map) return null
  const S = map.blocks, K0 = Math.round(map.originX / P), M0 = Math.round(map.originZ / P)
  const layered = pack.quarters !== undefined
  const programme: readonly (readonly Programmed[])[] = layered ? PROGRAMME : [SINGLE]
  const quarters = layered ? Math.max(programme.length, pack.quarters!.names.length) : 1
  const centre = (i: number, j: number) => ({ x: map.originX + (i + 0.5) * P, z: map.originZ + (j + 0.5) * P })
  const quarterHere = (x: number, z: number): number => (layered ? quarterAt(pack, off, x, z) : 0)
  const quarterOf = (i: number, j: number): number => { const c = centre(i, j); return quarterHere(c.x, c.z) }
  const groundOf = (i: number, j: number): number => { const c = centre(i, j); return layered ? terrainAt(pack, off, c.x, c.z) : GROUND.flat }

  // The dice: one draw per lot of the map in row order (the sides' draws follow, one per place, as it is placed).
  const rng = createRng((seed ^ PLACEMENT_SALT) >>> 0)
  const dice = new Float64Array(S * S)
  for (let n = 0; n < S * S; n++) dice[n] = rng()

  // The lots a place may take: the map's candidates (never the landmark's lot, never under water, a two-way front with
  // a sidewalk that can be walked to), less a ravine's floor, less every front on the street round the map's edge.
  const lots: Lot[] = []
  for (const c of lotCandidates(pack, { offset: off }, map)) {
    const quarter = quarterOf(c.i, c.j), ground = groundOf(c.i, c.j)
    if (quarter < 0 || ground === GROUND.ravine || ground === GROUND.lake) continue
    const sides = c.sides.filter((side) => !(side === 0 ? c.j + 1 === S : side === 1 ? c.j === 0 : side === 2 ? c.i + 1 === S : c.i === 0))
    if (sides.length === 0) continue
    lots.push({ i: c.i, j: c.j, tier: c.tier, sides, quarter, ground, die: dice[c.j * S + c.i] })
  }

  // What is built on each lot, in whole cubic decimetres (twice over: the ring's doubled area times its height), and the
  // tallest building of each quarter: the hearts are read from these, exactly, whichever quarter the pack starts in.
  const volume = new Float64Array(S * S)
  const quarterOfLot = new Int16Array(S * S).fill(-1)
  const land = new Array<number>(quarters).fill(0), sumI = new Array<number>(quarters).fill(0), sumJ = new Array<number>(quarters).fill(0)
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const q = quarterOf(i, j)
    quarterOfLot[j * S + i] = q
    if (q >= 0 && q < quarters) { land[q]++; sumI[q] += i; sumJ[q] += j }
  }
  const tallest = new Array<number>(quarters).fill(0)
  for (let b = 0; b < polygonCount(pack.buildings); b++) {
    const at = buildingLot(pack, off, b)
    if (!at) continue
    const i = at.K - K0, j = at.M - M0
    if (i < 0 || j < 0 || i >= S || j >= S) continue
    const h = pack.buildings.height[b] ?? 0
    volume[j * S + i] += area2Dm(pack, b) * h
    const q = quarterOfLot[j * S + i]
    if (q >= 0 && q < quarters) tallest[q] = Math.max(tallest[q], h)
  }
  // How far lot (i, j) is from quarter q's centroid, as a whole number (the centroid times the quarter's lot count).
  const off2 = (q: number, i: number, j: number): number => (i * land[q] - sumI[q]) ** 2 + (j * land[q] - sumJ[q]) ** 2
  const anchorOf = (q: number): { i: number; j: number } | null => {
    if (!land[q]) return null
    if (tallest[q] >= LOT_TIERS.tower * DM) {
      // The tallest cluster: the quarter's lot with the most built on the quarter's lots within two of it.
      let pick: { i: number; j: number } | null = null, score = -1, far = Infinity
      for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
        if (quarterOfLot[j * S + i] !== q) continue
        let sum = 0
        for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
          const ni = i + di, nj = j + dj
          if (ni >= 0 && nj >= 0 && ni < S && nj < S && quarterOfLot[nj * S + ni] === q) sum += volume[nj * S + ni]
        }
        const d = off2(q, i, j)
        if (sum > score || (sum === score && d < far)) { pick = { i, j }; score = sum; far = d }
      }
      return pick
    }
    // No tower anywhere in the quarter: the lot a place may take that is nearest its centroid.
    const near = best(lots.filter((l) => l.quarter === q), (l) => [off2(q, l.i, l.j), l.j, l.i])
    if (near) return { i: near.i, j: near.j }
    let pick: { i: number; j: number } | null = null, far = Infinity
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      if (quarterOfLot[j * S + i] !== q) continue
      const d = off2(q, i, j)
      if (d < far) { pick = { i, j }; far = d }
    }
    return pick
  }
  // A map without the layer has its heart where the pack's origin is (the lot under it, held inside the map).
  const anchors: ({ i: number; j: number } | null)[] = []
  for (let q = 0; q < quarters; q++) {
    anchors.push(layered ? anchorOf(q) : { i: Math.min(S - 1, Math.max(0, Math.floor((off.x - map.originX) / P))), j: Math.min(S - 1, Math.max(0, Math.floor((off.z - map.originZ) / P))) })
  }

  // How many of each kind stand: all of them, or, on a map too small to seat them, fewer, always the first of each list
  // and in proportion: one at a time, the kind with the largest share of its list still standing loses its last (of
  // two with the same share, a workplace before a home before a shop), until what is left fits.
  const full = { work: WORKPLACE_KINDS.length, home: PROPERTY_KINDS.length, shop: SHOP_KINDS.length } as const
  const counts: { work: number; home: number; shop: number } = { ...full }
  for (;;) {
    const chosen = attempt(map, programme, lots, anchors, land, counts, seed, quarterHere)
    if (chosen) return finish(chosen, map, anchors, quarters, quarterHere)
    if (counts.work + counts.home + counts.shop === 0) return finish([], map, anchors, quarters, quarterHere)
    let most: 'work' | 'home' | 'shop' = 'work'
    // Shares compared as cross products, in whole numbers.
    for (const kind of ['home', 'shop'] as const) if (counts[kind] * full[most] > counts[most] * full[kind]) most = kind
    counts[most]--
  }
}

interface Chosen { place: Programmed; quarter: number; lot: Lot; side: Side }

const indexOf = (p: Programmed): number => (p.type === 'shop' ? SHOP_KINDS.indexOf(p.kind) : p.type === 'home' ? PROPERTY_KINDS.indexOf(p.kind) : WORKPLACE_KINDS.indexOf(p.kind))

/**
 * One pass of the placement with `counts` of each kind standing; null when a place of those found no lot at all.
 * `quarterHere` is the quarter under a point (engine metres), -1 in none.
 */
function attempt(
  map: StreetGrid, programme: readonly (readonly Programmed[])[], lots: readonly Lot[], anchors: readonly ({ i: number; j: number } | null)[],
  land: readonly number[], counts: { work: number; home: number; shop: number }, seed: number, quarterHere: (x: number, z: number) => number,
): Chosen[] | null {
  const S = map.blocks
  // The sides' dice restart with every pass, after the lots' draws, so a pass is a function of the seed and the counts.
  const rng = createRng((seed ^ PLACEMENT_SALT) >>> 0)
  for (let n = 0; n < S * S; n++) rng()
  const chosen: Chosen[] = []
  const free = (l: Lot): boolean => chosen.every((c) => cheb(c.lot.i, c.lot.j, l.i, l.j) >= SPACING)
  const reachOf = (l: Lot, a: { i: number; j: number } | null): number => {
    let r = a ? cheb(a.i, a.j, l.i, l.j) : Infinity
    for (const c of chosen) r = Math.min(r, cheb(c.lot.i, c.lot.j, l.i, l.j))
    return r
  }
  // The front of a lot nearest a point (the street's middle along that front), the lowest side of two as near.
  const frontNear = (l: Lot, x: number, z: number): Side => {
    const cx = map.originX + (l.i + 0.5) * P, cz = map.originZ + (l.j + 0.5) * P
    return best(l.sides, (side) => { const d = doorDir(side); return [Math.hypot(cx + d.x * P / 2 - x, cz + d.z * P / 2 - z), side] })!
  }
  const startOf = (q: number): { x: number; z: number } | null => {
    const first = chosen.find((c) => c.quarter === q)
    return first ? acrossFrom(map, first.lot, first.side) : null
  }
  const leftover: { place: Programmed; quarter: number }[] = []
  programme.forEach((list, q) => {
    const a = anchors[q] ?? null
    const standing = list.filter((p) => indexOf(p) < counts[p.type])
    const cap = Math.max(3, Math.round(0.6 * Math.sqrt((land[q] ?? 0) / Math.max(1, standing.length))))
    let lead: Lot | null = null
    for (const p of standing) {
      const want = wantOf(p)
      const draw = rng()
      const mine = lots.filter((l) => l.quarter === q && free(l))
      let lot: Lot | null = null
      if (p.starter && a) {
        // By the heart: the quarter's first starter within STARTER_RING lots of it, the others within STARTER_REACH of
        // that first one, each ring widened a lot at a time until a free lot is found.
        const from: { i: number; j: number } = lead ?? a
        for (let ring: number = lead === null ? STARTER_RING : STARTER_REACH; lot === null && ring <= S; ring++) {
          lot = best(mine.filter((l) => cheb(from.i, from.j, l.i, l.j) <= ring), (l): number[] => [rank(want.tiers, l.tier), cheb(from.i, from.j, l.i, l.j), l.die, l.j, l.i])
        }
      } else {
        const order = (l: Lot): number[] => {
          const reach = -Math.min(reachOf(l, a), cap), tier = rank(want.tiers, l.tier), ground = rank(want.ground, l.ground)
          return want.lead === 'tier' ? [tier, reach, ground] : want.lead === 'terrain' ? [ground, reach, tier] : [reach, ground, tier]
        }
        lot = best(mine, (l) => [...order(l), l.die, l.j, l.i])
      }
      if (!lot) { leftover.push({ place: p, quarter: q }); continue }
      let side: Side
      if (p.starter && a) {
        const s = lead === null ? null : startOf(q)
        if (s) side = frontNear(lot, s.x, s.z)
        else {
          // The first starter's doorway is where the quarter's visitor starts, across its street (acrossFrom): of its
          // fronts, those whose far sidewalk is in the quarter itself (a lot on the quarter's edge can face a street
          // whose far side is the next quarter's), the one nearest the heart; any front only where none is.
          const own = lot.sides.filter((side) => { const at = acrossFrom(map, lot!, side); return quarterHere(at.x, at.z) === q })
          side = frontNear(own.length > 0 ? { ...lot, sides: own } : lot, map.originX + (a.i + 0.5) * P, map.originZ + (a.j + 0.5) * P)
        }
      } else side = lot.sides[Math.min(lot.sides.length - 1, Math.floor(draw * lot.sides.length))]
      chosen.push({ place: p, quarter: q, lot, side })
      if (p.starter && lead === null) lead = lot
    }
  })
  // A quarter short of lots: its place stands wherever the map still has room, by the spread rule and its own heart.
  for (const { place: p, quarter: q } of leftover) {
    const want = wantOf(p), a = anchors[q] ?? null
    const draw = rng()
    const cap = Math.max(3, Math.round(0.6 * Math.sqrt((land[q] ?? 0) / Math.max(1, programme[q].length))))
    const lot = best(lots.filter(free), (l) => [-Math.min(reachOf(l, a), cap), rank(want.ground, l.ground), rank(want.tiers, l.tier), l.die, l.j, l.i])
    if (!lot) return null
    chosen.push({ place: p, quarter: q, lot, side: lot.sides[Math.min(lot.sides.length - 1, Math.floor(draw * lot.sides.length))] })
  }
  return chosen
}

/** The far sidewalk's middle, across the street from a lot's front `side`: where someone stands to see its doorway. */
function acrossFrom(map: StreetGrid, lot: { i: number; j: number }, side: Side): { x: number; z: number } {
  const d = doorDir(side), reach = P / 2 + map.roadHalf + SIDEWALK / 2
  return { x: map.originX + (lot.i + 0.5) * P + d.x * reach, z: map.originZ + (lot.j + 0.5) * P + d.z * reach }
}

function finish(chosen: readonly Chosen[], map: StreetGrid, anchors: readonly ({ i: number; j: number } | null)[], quarters: number, quarterHere: (x: number, z: number) => number): RegionPlacement {
  const K0 = Math.round(map.originX / P), M0 = Math.round(map.originZ / P)
  const at = (c: Chosen) => ({ k: K0 + c.lot.i, m: M0 + c.lot.j, side: c.side })
  const of = (type: Programmed['type']) => chosen.filter((c) => c.place.type === type).sort((a, b) => indexOf(a.place) - indexOf(b.place))
  const workplaces = of('work').map((c): WorkplaceLot => ({ kind: c.place.kind as WorkplaceKind, ...at(c) }))
  const shops = of('shop').map((c): ShopLot => ({ kind: c.place.kind as ShopKind, ...at(c) }))
  const homes = of('home').map((c): HomeLot => ({ home: indexOf(c.place), ...at(c) }))
  const starts: PlacedStart[] = []
  const hearts: RegionPlacement['anchors'] = []
  for (let q = 0; q < quarters; q++) {
    const a = anchors[q]
    if (!a) continue
    hearts.push({ quarter: q, k: K0 + a.i, m: M0 + a.j })
    // Across from the quarter's shop, else its first home, else its first workplace, else the heart itself; of those,
    // the first whose far sidewalk is in the quarter (the shop's, but for a shop whose every front faces another
    // quarter across its street), and the shop's when none is.
    const mine = chosen.filter((c) => c.quarter === q)
    const order = [...mine.filter((c) => c.place.type === 'shop'), ...mine.filter((c) => c.place.type === 'home'), ...mine.filter((c) => c.place.type === 'work')]
    const inside = order.find((c) => { const at = acrossFrom(map, c.lot, c.side); return quarterHere(at.x, at.z) === q })
    const front = inside ?? order[0]
    const s = front ? acrossFrom(map, front.lot, front.side) : { x: map.originX + (a.i + 0.5) * P, z: map.originZ + (a.j + 0.5) * P }
    starts.push({ quarter: q, x: s.x, z: s.z })
  }
  return { workplaces, shops, homes, starts, anchors: hearts }
}
