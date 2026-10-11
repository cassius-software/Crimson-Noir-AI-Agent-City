// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
// Why does this file exist? It writes the lakefront metropolis's structural layouts (src/01_Initialize_World/lakefront.ts
// zoneLayout) to world/lakefront/: one JSON file per region (Lakefront Metropolis, West Sprawl, The East Bluffs, North
// Ridge, The Grand Ravine) and an index with the map's fingerprint, The Spire and the transit hubs. The files are generated from the seed alone, so this is run
// again whenever the generator changes, and lakefront.test.ts fails until it is. Runs from cmd.exe as well as a POSIX
// shell: Node only, forward-slash paths in what it prints.
// What breaks if it is removed? The committed layouts cannot be regenerated, and a generator change cannot be checked in.
//
// Usage: node tools/world/lakefront.mjs [--seed N] [--blocks N] [--out DIR] [--check]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LAKEFRONT_SEED, LAKEFRONT_BLOCKS, lakefrontFiles } from '../../src/01_Initialize_World/lakefrontFiles.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const args = process.argv.slice(2)
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback }
const seed = Number(opt('seed', LAKEFRONT_SEED)), blocks = Number(opt('blocks', LAKEFRONT_BLOCKS))
const out = join(ROOT, opt('out', 'world/lakefront'))
const check = args.includes('--check')
if (!Number.isInteger(seed) || !Number.isInteger(blocks)) { console.error('usage: node tools/world/lakefront.mjs [--seed N] [--blocks N] [--out DIR] [--check]'); process.exit(2) }

const files = lakefrontFiles(seed, blocks)
const slash = (p) => relative(ROOT, p).replaceAll('\\', '/')
let stale = 0
mkdirSync(out, { recursive: true })
for (const [name, text] of Object.entries(files)) {
  const path = join(out, name)
  if (check) {
    let current = null
    try { current = readFileSync(path, 'utf8') } catch { /* missing */ }
    if (current !== text) { stale++; console.log(`stale: ${slash(path)}`) }
  } else {
    writeFileSync(path, text)
    console.log(`wrote ${slash(path)} (${text.length} bytes)`)
  }
}
if (check) {
  if (stale) { console.error(`${stale} file(s) differ from the generator's output; run node tools/world/lakefront.mjs`); process.exit(1) }
  console.log(`world/lakefront is current (seed ${seed}, ${blocks} blocks)`)
}
