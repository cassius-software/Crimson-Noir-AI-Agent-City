// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the walkable lakefront metropolis as the page builds it: the generator (lakefront.ts)
 * at the size a browser walks (64 blocks, 2.56 km, a few thousand buildings), turned into a region pack
 * (region/fromMacro.ts) with the chosen region's centre at the pack's origin, so the engine's region path spawns the
 * visitor there. The onboarding runs this in a worker (lakefront.worker.ts) while the concierge talks; `?map=lakefront`
 * runs it before the engine starts. The pack's names are screened by the CC0 gate (assets/cc0.ts) before they leave.
 * What breaks if it is removed? The onboarding and `?map=lakefront` have no map to hand the engine.
 */
import { generateLakefront, REGIONS, ZONE, type LakefrontMap, type Zone } from './lakefront.ts'
import { MACRO } from './macroCity.ts'
import { screenNames } from './assets/cc0.ts'
import { macroToRegionPack } from './region/fromMacro.ts'
import { validatePack, type RegionPack } from './region/pack.ts'

/** The walkable map's size, blocks (2.56 km across). */
export const WALK_BLOCKS = 64

/** The fictitious metropolis's own names (no real place): the region the pack is, and its lake. */
export const METRO = Object.freeze({
  name: 'Lakefront Metro',
  lake: 'Lake Aurel',
  attribution: Object.freeze([
    'Lakefront Metro is a procedural, fictitious place generated from a seed: no surveyed data, no real streets, no real names.',
    'Its five regions (Lakefront Metropolis, West Sprawl, The East Bluffs, North Ridge, The Grand Ravine), The Spire, Transit City and every street name are original and dedicated to the public domain (CC0 1.0).',
  ]),
})

/** The centre of a zone, metres from the map's north-west corner (the map's centre when the zone is empty). */
export function zoneCentre(map: LakefrontMap, zone: Zone): { x: number; z: number } {
  const B = map.blocks
  let k = 0, m = 0, n = 0
  for (let i = 0; i < B * B; i++) if (map.zones[i] === zone) { k += (i % B) + 0.5; m += Math.floor(i / B) + 0.5; n++ }
  if (!n) return { x: (B * MACRO.pitch) / 2, z: (B * MACRO.pitch) / 2 }
  return { x: Math.round((k / n) * MACRO.pitch), z: Math.round((m / n) * MACRO.pitch) }
}

/** The region pack of a generated map, the visitor's first walk starting at `zone`'s centre; its names screened. */
export function packOf(map: LakefrontMap, zone: Zone, log?: (line: string) => void): RegionPack {
  const pack = validatePack(macroToRegionPack(map, { name: METRO.name, attribution: METRO.attribution, waterName: METRO.lake, origin: zoneCentre(map, zone) }))
  const purged = screenNames([pack.name, ...pack.names, ...pack.attribution], 'region pack', log)
  if (purged.length) throw new Error(`the generated map named something after a weapon: ${purged.map((p) => p.asset).join(', ')}`)
  return pack
}

/** The whole thing in one call (tests, and a page without workers): the map for `seed`, as a pack starting in `zone`. */
export function buildLakefrontPack(seed: number, zone: Zone = ZONE.metropolis, blocks: number = WALK_BLOCKS): RegionPack {
  return packOf(generateLakefront(seed, blocks), zone)
}

/** The zone a region slug names (the saved onboarding choice), or null. */
export function zoneOf(slug: string | null | undefined): Zone | null {
  const r = REGIONS.find((r) => r.slug === slug)
  return r ? (r.id as Zone) : null
}

// ─── The worker's protocol ──────────────────────────────────────────────────────────────────────────────────────────

/** What the page says to the worker: build the map for a seed; then, give me the pack starting in a zone. */
export type ToWorker = { kind: 'build'; seed: number; blocks: number } | { kind: 'pack'; zone: Zone; id: number }
/** What the worker says back: a stage of the build (plain words), the map's summary, a pack, or a failure. */
export type FromWorker =
  | { kind: 'stage'; stage: BuildStage }
  | { kind: 'built'; seed: number; blocks: number; zoneBlocks: number[]; zones: Uint8Array }
  | { kind: 'pack'; id: number; pack: RegionPack }
  | { kind: 'error'; message: string; id?: number }

/** The build's stages, in order, as the concierge tells them (plain words, no jargon). */
export const BUILD_STAGES = Object.freeze(['lake', 'ravines', 'regions', 'streets', 'buildings', 'names', 'ready'] as const)
export type BuildStage = (typeof BUILD_STAGES)[number]
export const STAGE_WORDS: Readonly<Record<BuildStage, string>> = Object.freeze({
  lake: 'Filling the lake',
  ravines: 'Cutting the ravines',
  regions: 'Drawing the five regions',
  streets: 'Laying the streets and bridges',
  buildings: 'Raising the towers',
  names: 'Naming the streets',
  ready: 'Your city is ready',
})
