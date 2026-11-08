// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It gives a generated region (Lakefront Metro, through its street window, streets.ts) the
 * procedural city's five storefronts (storefronts.ts): which lots of the window become shops and which street front
 * each doorway faces. The city puts its shops in quarters of a grid where every lot has four streets; a window has
 * dropped streets, water and ravines, so the lots come from the same candidates as the region's workplaces
 * (workplaces.ts lotCandidates: a doorway on a two-way street with a sidewalk the visitor can walk to, never the
 * landmark's lot or a lot under water), less the workplaces' own lots.
 * The shops stand where a visitor finds them: the nearest lots to the start first (the Chebyshev ring of lots), then
 * what stands on them (workplaces.ts lotTier: a hub, then one or two tall buildings, then a mid-rise, a low building,
 * an open lot, the rest), then the seed's dice. Five at most, the kinds in SHOP_KINDS order; fewer is legal. The page
 * picks them and the physics worker receives them as data (simProtocol.ts SimInit.shops), so the two build the same
 * glass (storefronts.ts shopsAt) and a car left in a shop puts its driver down clear of it.
 * Pure, and no three.js: the physics worker imports storefronts.ts, and this file is the page's alone.
 * What breaks if it is removed? Lakefront Metro has no shops, and a visitor who lands there by default (the onboarding's
 * place) never sees one.
 */
import { createRng } from '../../02_Define_The_Rules/degrees.ts'
import { CITY } from '../city.ts'
import type { WorkplaceLot } from '../interiors.ts'
import { SHOP_KINDS, type ShopLot } from '../storefronts.ts'
import type { RegionPack } from './pack.ts'
import type { StreetGrid } from './streets.ts'
import { lotCandidates } from './workplaces.ts'

const P = CITY.pitch

/**
 * The region's shop lots in window `g` for a visitor starting at `start` (engine metres), never on one of `taken`
 * (the workplaces' lots, workplaces.ts regionWorkplaceLots): at most SHOP_KINDS.length, in its order, as storefronts.ts
 * shopsAt takes them (engine lot indices). Ranked by ring, tier and the dice (createRng(seed ^ 0x5409f00d): one draw per
 * window lot in row order, then one per pick for its doorway's side among the fronts that qualify). Deterministic, and
 * the pack is only read.
 */
export function regionShopLots(pack: RegionPack, layout: { offset: { x: number; z: number } }, g: StreetGrid, start: { x: number; z: number }, seed: number, taken: readonly Pick<WorkplaceLot, 'k' | 'm'>[]): ShopLot[] {
  const B = g.blocks, K0 = g.originX / P, M0 = g.originZ / P
  const used = new Set(taken.map(({ k, m }) => `${k},${m}`))
  const candidates = lotCandidates(pack, layout, g, start).filter((c) => !used.has(`${K0 + c.i},${M0 + c.j}`))
  const rng = createRng((seed ^ 0x5409f00d) >>> 0)
  const dice = new Float64Array(B * B)
  for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) dice[j * B + i] = rng()
  candidates.sort((a, b) => a.ring - b.ring || a.tier - b.tier || dice[a.j * B + a.i] - dice[b.j * B + b.i] || a.j - b.j || a.i - b.i)
  return candidates.slice(0, SHOP_KINDS.length).map((c, n) => ({
    kind: SHOP_KINDS[n], k: K0 + c.i, m: M0 + c.j, side: c.sides[Math.min(c.sides.length - 1, Math.floor(rng() * c.sides.length))],
  }))
}
