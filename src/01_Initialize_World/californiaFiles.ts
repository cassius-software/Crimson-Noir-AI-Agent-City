// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the one definition of what world/california/ holds: the seed and size of the committed
 * map, and the files (name → text) its layouts are written as, so the writer (tools/world/california.mjs) and the test
 * that pins the committed files (california.test.ts) produce the very same bytes.
 * What breaks if it is removed? The writer and the test could drift apart, and the committed layouts would pin nothing.
 */
import { californiaIndex, generateCalifornia, zoneLayouts } from './california.ts'

/** The committed map: the page's default seed, and the full 256-block (10.24 km) extent. */
export const CALIFORNIA_SEED = 1337
export const CALIFORNIA_BLOCKS = 256

/** The files of world/california/ for a seed and size, as text, JSON with two-space indents and a final newline. */
export function californiaFiles(seed: number = CALIFORNIA_SEED, blocks: number = CALIFORNIA_BLOCKS): Record<string, string> {
  const map = generateCalifornia(seed, blocks)
  const layouts = zoneLayouts(map)
  const files: Record<string, string> = { 'index.json': `${JSON.stringify(californiaIndex(map, layouts), null, 2)}\n` }
  for (const l of layouts) files[`${l.region.slug}.json`] = `${JSON.stringify(l, null, 2)}\n`
  return files
}
