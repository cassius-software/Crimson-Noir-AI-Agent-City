// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It reads a region pack's quarters layer (pack.ts Quarters: the lakefront's five regions and
 * the ground, per block) at a point of the walked world: which quarter stands there, what it is called, and what the
 * ground is. The layer is in the pack's own blocks; the engine speaks its own metres (regionWorld.ts layoutOf adds an
 * offset to the pack's), so every reader would otherwise redo the same subtraction and the same bounds test. A pack
 * without the layer (a surveyed region) has no quarter anywhere: every answer is -1 or null, never a throw.
 * Pure, and no three.js: the page, the physics worker and the tests read the same answers.
 * What breaks if it is removed? Nothing can say which of the five regions a place or the visitor stands in: places
 * could not be shared out among the quarters, and the place label could only name the whole map.
 */
import type { RegionPack } from './pack.ts'

/** Where a pack sits in the engine's frame: a layout (regionWorld.ts layoutOf) or its offset alone, m. */
export type QuartersFrame = { x: number; z: number } | { offset: { x: number; z: number } }

const offsetOf = (at: QuartersFrame): { x: number; z: number } => ('offset' in at ? at.offset : at)

/**
 * The block of the quarters layer under (x, z), engine metres, as its row-major index (m · blocks + k), or -1 where the
 * layer has no block: outside its blocks, or a pack without the layer. A street line belongs to the block it opens.
 */
export function quarterBlockAt(pack: Pick<RegionPack, 'quarters' | 'bounds'>, at: QuartersFrame, x: number, z: number): number {
  const q = pack.quarters
  if (!q) return -1
  const off = offsetOf(at)
  // The layer's north-west corner in engine metres, summed first: on a generated map both terms are whole metres and
  // the sum is the region's corner whichever quarter the pack starts in, so the same point reads the same block from
  // every such pack, to the last bit.
  const x0 = off.x + pack.bounds.x0, z0 = off.z + pack.bounds.z0
  const k = Math.floor((x - x0) / q.pitch), m = Math.floor((z - z0) / q.pitch)
  return k >= 0 && m >= 0 && k < q.blocks && m < q.blocks ? m * q.blocks + k : -1
}

/**
 * The quarter under (x, z), engine metres: its id (an index of the layer's names), or -1 over open water, outside the
 * map, and in a pack without the layer.
 */
export function quarterAt(pack: Pick<RegionPack, 'quarters' | 'bounds'>, at: QuartersFrame, x: number, z: number): number {
  const i = quarterBlockAt(pack, at, x, z)
  if (i < 0) return -1
  const q = pack.quarters!
  const id = q.id[i]
  return id >= 0 && id < q.names.length ? id : -1
}

/** The ground under (x, z), engine metres (lakefront.ts TERRAIN codes), or -1 outside the map and without the layer. */
export function terrainAt(pack: Pick<RegionPack, 'quarters' | 'bounds'>, at: QuartersFrame, x: number, z: number): number {
  const i = quarterBlockAt(pack, at, x, z)
  return i < 0 ? -1 : (pack.quarters!.terrain[i] ?? -1)
}

/** What quarter `id` is called, or null when the pack has no such quarter (-1, open water, no layer). */
export function quarterName(pack: Pick<RegionPack, 'quarters'>, id: number): string | null {
  return pack.quarters?.names[id] ?? null
}
