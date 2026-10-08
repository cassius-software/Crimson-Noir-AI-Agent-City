// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the single source of truth for check resolution: the four degrees of
 * success, proficiency scaling, fortune/misfortune and exact outcome odds. These are open game mechanics
 * offered under the ORC License (see LICENSE and NOTICE.md); no proprietary names or text.
 * What breaks if it is removed? Every check in the city: the pedestrian yield save, the driver and
 * walk-start perception checks, and the seeded PRNG the world builder uses. crowd.wgsl mirrors degreeOf().
 */

/**
 * The ORC Notice, verbatim in the form Section III(e) of the ORC License gives. It must match LICENSE and
 * NOTICE.md (degrees.test.ts checks); the Concierge card shows it and the build embeds NOTICE.md in the page.
 */
export const ORC_NOTICE =
  'This product is licensed under the ORC License located at the Library of Congress at TX 9-307-067 and ' +
  'available online at various locations including www.azoralaw.com/orclicense and others. All warranties ' +
  'are disclaimed as set forth therein.'

export const CRIT_FAILURE = 0
export const FAILURE = 1
export const SUCCESS = 2
export const CRIT_SUCCESS = 3
/** Ordered worst to best, so a degree indexes a [critical failure, failure, success, critical success] table. */
export type Degree = typeof CRIT_FAILURE | typeof FAILURE | typeof SUCCESS | typeof CRIT_SUCCESS

export const DEGREE_LABEL: Record<Degree, string> = {
  [CRIT_FAILURE]: 'CRITICAL FAILURE',
  [FAILURE]: 'FAILURE',
  [SUCCESS]: 'SUCCESS',
  [CRIT_SUCCESS]: 'CRITICAL SUCCESS',
}

/** Beat the DC by 10 → critical success; miss it by 10 → critical failure. A natural 20 raises the
 *  result one step and a natural 1 lowers it one step. */
export function degreeOf(natural: number, total: number, dc: number): Degree {
  let d: number = total >= dc + 10 ? CRIT_SUCCESS : total >= dc ? SUCCESS : total <= dc - 10 ? CRIT_FAILURE : FAILURE
  if (natural === 20) d = Math.min(CRIT_SUCCESS, d + 1)
  else if (natural === 1) d = Math.max(CRIT_FAILURE, d - 1)
  return d as Degree
}

export type Rank = 'untrained' | 'trained' | 'expert' | 'master' | 'legendary'
const RANK_BONUS: Record<Rank, number> = { untrained: 0, trained: 2, expert: 4, master: 6, legendary: 8 }

/** Untrained adds nothing (not even level); every trained rank adds its bonus plus level. */
export function proficiency(rank: Rank, level: number): number {
  return rank === 'untrained' ? 0 : RANK_BONUS[rank] + level
}

/** Fortune rolls twice and keeps the higher die; misfortune keeps the lower. */
export type Fortune = 'none' | 'fortune' | 'misfortune'

/** Deterministic PRNG (mulberry32). Seeded so a replay with the same seed resolves identically. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function rollD20(rng: () => number): number {
  return 1 + Math.floor(rng() * 20)
}

export interface CheckResult {
  natural: number
  rolls: [number] | [number, number]
  total: number
  dc: number
  degree: Degree
}

export function rollCheck(modifier: number, dc: number, rng: () => number, fortune: Fortune = 'none'): CheckResult {
  const a = rollD20(rng)
  let natural = a
  let rolls: CheckResult['rolls'] = [a]
  if (fortune !== 'none') {
    const b = rollD20(rng)
    natural = fortune === 'fortune' ? Math.max(a, b) : Math.min(a, b)
    rolls = [a, b]
  }
  const total = natural + modifier
  return { natural, rolls, total, dc, degree: degreeOf(natural, total, dc) }
}

/** Exact outcome probabilities, enumerating every face (or face pair under fortune/misfortune). */
export function outcomeDistribution(modifier: number, dc: number, fortune: Fortune = 'none'): [number, number, number, number] {
  const p: [number, number, number, number] = [0, 0, 0, 0]
  if (fortune === 'none') {
    for (let n = 1; n <= 20; n++) p[degreeOf(n, n + modifier, dc)] += 1 / 20
    return p
  }
  for (let a = 1; a <= 20; a++) {
    for (let b = 1; b <= 20; b++) {
      const n = fortune === 'fortune' ? Math.max(a, b) : Math.min(a, b)
      p[degreeOf(n, n + modifier, dc)] += 1 / 400
    }
  }
  return p
}
