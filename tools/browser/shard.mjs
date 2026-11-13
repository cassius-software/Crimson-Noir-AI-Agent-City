// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It splits the browser smoke test's scenarios (smoke.mjs) into parts that take about the
 * same time, so CI's browser job runs as parallel jobs (ci.yml's matrix, `smoke.mjs --shard i/n`), each well under its
 * time limit, instead of one job that had grown to its limit. The split is decided by how long each scenario took in
 * CI (SHARD_SECONDS), the longest first into the part with the least time so far; a scenario the table does not know
 * counts as SHARD_DEFAULT. Every scenario falls in exactly one part, and each part keeps the scenarios' own order.
 * What breaks if it is removed? `--shard` stops working, and CI's browser job cannot be split.
 */

/**
 * Seconds each scenario took in CI's browser job (main's run for #111, 2026-11-11; `rest` from a later run, with its
 * staff steps added; `sitemodel` from its local run on SwiftShader with the page's own download added, 535 s, times
 * 1.5). Only the balance between the parts depends on these: a stale figure moves a scenario to the other part, never
 * out of the run.
 */
export const SHARD_SECONDS = Object.freeze({
  desktop: 96, phone: 427, split: 134, file: 58, ultra: 348, peak: 153, lite: 96, tty: 1, pwa: 170, inpage: 225,
  sitemodel: 800, actions: 65, walk: 104, walkshop: 82, walkhome: 85, walkphone: 125, lakefront: 93, homes: 119,
  furnish: 191, rest: 230, fail: 251,
})

/** What a scenario missing from SHARD_SECONDS counts as, s. */
export const SHARD_DEFAULT = 120

/** The most parts a run may be split into. */
export const SHARD_MAX = 8

/** `i/n` (1 <= i <= n <= SHARD_MAX) as { i, n }; throws a plain error for anything else. */
export function parseShard(text) {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String(text ?? ''))
  const i = m ? Number(m[1]) : NaN, n = m ? Number(m[2]) : NaN
  if (!(n >= 1 && n <= SHARD_MAX && i >= 1 && i <= n)) throw new Error(`--shard takes i/n with 1 <= i <= n <= ${SHARD_MAX}, not ${JSON.stringify(text)}`)
  return { i, n }
}

/**
 * The scenarios of `names` that part `i` of `n` runs, in the order of `names`: each scenario, longest first (ties in
 * the order of `names`), goes to the part with the least time so far (ties to the lowest part).
 */
export function shardOf(names, i, n, seconds = SHARD_SECONDS) {
  const cost = (name) => (Object.hasOwn(seconds, name) ? seconds[name] : SHARD_DEFAULT)
  const load = Array.from({ length: n }, () => 0)
  const part = new Map()
  const longest = names.map((name, at) => ({ name, at })).sort((a, b) => cost(b.name) - cost(a.name) || a.at - b.at)
  for (const { name } of longest) {
    let k = 0
    for (let j = 1; j < n; j++) if (load[j] < load[k]) k = j
    part.set(name, k)
    load[k] += cost(name)
  }
  return names.filter((name) => part.get(name) === i - 1)
}
