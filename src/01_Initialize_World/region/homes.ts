// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It gives a generated region (Lakefront Metro, through its street window, streets.ts) the
 * procedural city's seven homes (properties.ts): which lots of the window become homes, which home stands on each, and
 * which street front each doorway faces. The city places its homes by its own landmarks (the elevated loop, the pier,
 * the lakefront row, the headquarters towers); a window has none of those, so the lots come from the same candidates
 * as the region's workplaces and shops (workplaces.ts lotCandidates: a doorway on a two-way street with a sidewalk the
 * visitor can walk to, never the landmark's lot or a lot under water), less the workplaces' and the shops' own lots.
 * The homes stand where a visitor finds them: the nearest lots to the start first (the Chebyshev ring of lots), then
 * what stands on them (workplaces.ts lotTier), then the seed's dice. Among the seven, the grander homes take the
 * grander lots: a hub's podium and tower (which hollowLots carries on the home's slab) goes to the sky-mansion, and the
 * plainest lot to the micro-loft. Fewer than seven is legal, and then the cheapest homes are the ones that stand.
 * The page picks them; the physics worker needs nothing, since no car fits through a home's doorway and the boxes
 * reach it with the rest of the plan. Pure, and no three.js; this file is the page's alone.
 * What breaks if it is removed? Lakefront Metro has no homes, and a deed bought there has nowhere to go home to.
 */
import { createRng } from '../../02_Define_The_Rules/degrees.ts'
import { CITY } from '../city.ts'
import type { WorkplaceLot } from '../interiors.ts'
import { PROPERTY_KINDS, type HomeLot } from '../properties.ts'
import type { RegionPack } from './pack.ts'
import type { StreetGrid } from './streets.ts'
import { lotCandidates, type LotCandidate } from './workplaces.ts'

const P = CITY.pitch

/**
 * The region's home lots in window `g` for a visitor starting at `start` (engine metres), never on one of `taken` (the
 * workplaces' lots and the shops', workplaces.ts regionWorkplaceLots and shops.ts regionShopLots): at most
 * PROPERTY_KINDS.length, in property order, as properties.ts homesAt takes them (engine lot indices).
 * - The dice are createRng(seed ^ 0x40e5f00d): one draw per window lot in row order, then one per home, in property
 *   order, for its doorway's side among the fronts that qualify.
 * - The lots are the first N of the candidates ranked by ring, tier, the dice, then row and column.
 * - The N lots are ranked again by tier, ring and the dice, and the r-th of that ranking takes property N − 1 − r: the
 *   best built lot the grandest home of the N, the plainest the micro-loft.
 * Deterministic, and the pack is only read.
 */
export function regionHomeLots(pack: RegionPack, layout: { offset: { x: number; z: number } }, g: StreetGrid, start: { x: number; z: number }, seed: number, taken: readonly Pick<WorkplaceLot, 'k' | 'm'>[]): HomeLot[] {
  const B = g.blocks, K0 = g.originX / P, M0 = g.originZ / P
  const used = new Set(taken.map(({ k, m }) => `${k},${m}`))
  const candidates = lotCandidates(pack, layout, g, start).filter((c) => !used.has(`${K0 + c.i},${M0 + c.j}`))
  const rng = createRng((seed ^ 0x40e5f00d) >>> 0)
  const dice = new Float64Array(B * B)
  for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) dice[j * B + i] = rng()
  const die = (c: LotCandidate) => dice[c.j * B + c.i]
  candidates.sort((a, b) => a.ring - b.ring || a.tier - b.tier || die(a) - die(b) || a.j - b.j || a.i - b.i)
  const picks = candidates.slice(0, PROPERTY_KINDS.length)
  const grand = [...picks].sort((a, b) => a.tier - b.tier || a.ring - b.ring || die(a) - die(b) || a.j - b.j || a.i - b.i)
  const n = grand.length
  return grand.map((_, home) => {
    const c = grand[n - 1 - home]
    return { home, k: K0 + c.i, m: M0 + c.j, side: c.sides[Math.min(c.sides.length - 1, Math.floor(rng() * c.sides.length))] }
  })
}
