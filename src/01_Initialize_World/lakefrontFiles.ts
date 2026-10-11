// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the one definition of what world/lakefront/ holds: the seed and size of the committed
 * map, and the files (name → text) its layouts are written as, so the writer (tools/world/lakefront.mjs) and the test
 * that pins the committed files (lakefront.test.ts) produce the very same bytes.
 * What breaks if it is removed? The writer and the test could drift apart, and the committed layouts would pin nothing.
 */
import { lakefrontIndex, generateLakefront, zoneLayouts } from './lakefront.ts'

/** The committed map: the page's default seed, and the full 256-block (10.24 km) extent. */
export const LAKEFRONT_SEED = 1337
export const LAKEFRONT_BLOCKS = 256

/** The files of world/lakefront/ for a seed and size, as text, JSON with two-space indents and a final newline. */
export function lakefrontFiles(seed: number = LAKEFRONT_SEED, blocks: number = LAKEFRONT_BLOCKS): Record<string, string> {
  const map = generateLakefront(seed, blocks)
  const layouts = zoneLayouts(map)
  const files: Record<string, string> = { 'index.json': `${JSON.stringify(lakefrontIndex(map, layouts), null, 2)}\n` }
  for (const l of layouts) files[`${l.region.slug}.json`] = `${JSON.stringify(l, null, 2)}\n`
  return files
}
