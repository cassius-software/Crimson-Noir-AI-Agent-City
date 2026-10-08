// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the rules engine to the published math, including the worked
 * example from the design document (+1 near the centre of the curve doubles the crit chance), keeps the
 * kernel free of combat mechanics, and keeps the ORC Notice identical in code, LICENSE and NOTICE.md.
 * What breaks if it is removed? Regressions in check resolution, or a drifting legal notice, would ship silently.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { BRAND } from '../brand.ts'
import { DRIVER_REACTION, WALK_START } from './civic.ts'
import * as degrees from './degrees.ts'
import {
  CRIT_FAILURE, CRIT_SUCCESS, DEGREE_LABEL, FAILURE, ORC_NOTICE, SUCCESS,
  createRng, degreeOf, outcomeDistribution, proficiency, rollCheck, type Degree,
} from './degrees.ts'

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)
const DEGREES: readonly Degree[] = [CRIT_FAILURE, FAILURE, SUCCESS, CRIT_SUCCESS]

test('DC+10 / DC-10 thresholds', () => {
  assert.equal(degreeOf(10, 25, 15), CRIT_SUCCESS)
  assert.equal(degreeOf(10, 24, 15), SUCCESS)
  assert.equal(degreeOf(10, 15, 15), SUCCESS)
  assert.equal(degreeOf(10, 14, 15), FAILURE)
  assert.equal(degreeOf(10, 6, 15), FAILURE)
  assert.equal(degreeOf(10, 5, 15), CRIT_FAILURE)
})

test('natural 20 and natural 1 shift one step and clamp', () => {
  assert.equal(degreeOf(20, 14, 15), SUCCESS)
  assert.equal(degreeOf(20, 5, 15), FAILURE)
  assert.equal(degreeOf(20, 30, 15), CRIT_SUCCESS)
  assert.equal(degreeOf(1, 15, 15), FAILURE)
  assert.equal(degreeOf(1, 30, 15), SUCCESS)
  assert.equal(degreeOf(1, 2, 15), CRIT_FAILURE)
})

test('degrees are ordered worst to best and every one has a label', () => {
  assert.deepEqual(DEGREES, [0, 1, 2, 3])
  for (const d of DEGREES) assert.ok(DEGREE_LABEL[d].length > 0)
})

test('design-doc example: +5 vs DC 15 succeeds 55% / crits 5%; +6 succeeds 60% / crits 10%', () => {
  const a = outcomeDistribution(5, 15)
  close(a[SUCCESS] + a[CRIT_SUCCESS], 0.55)
  close(a[CRIT_SUCCESS], 0.05)
  const b = outcomeDistribution(6, 15)
  close(b[SUCCESS] + b[CRIT_SUCCESS], 0.6)
  close(b[CRIT_SUCCESS], 0.1)
})

test('distributions sum to 1, fortune dominates misfortune', () => {
  for (const f of ['none', 'fortune', 'misfortune'] as const) {
    close(outcomeDistribution(7, 18, f).reduce((s, x) => s + x, 0), 1)
  }
  const fo = outcomeDistribution(14, 22, 'fortune')
  const mi = outcomeDistribution(14, 22, 'misfortune')
  assert.ok(fo[CRIT_SUCCESS] > mi[CRIT_SUCCESS])
  assert.ok(fo[CRIT_FAILURE] < mi[CRIT_FAILURE])
})

test('pedestrian yield save (+7 vs DC 18) splits 5/45/45/5', () => {
  const p = outcomeDistribution(7, 18)
  close(p[CRIT_FAILURE], 0.05)
  close(p[FAILURE], 0.45)
  close(p[SUCCESS], 0.45)
  close(p[CRIT_SUCCESS], 0.05)
})

test('proficiency: untrained adds no level; ranks add +2/+4/+6/+8 plus level', () => {
  assert.equal(proficiency('untrained', 7), 0)
  assert.equal(proficiency('trained', 7), 9)
  assert.equal(proficiency('expert', 7), 11)
  assert.equal(proficiency('master', 7), 13)
  assert.equal(proficiency('legendary', 7), 15)
})

test('fortune keeps the higher die, misfortune the lower, and both consume two dice', () => {
  const seed = 99
  for (const f of ['fortune', 'misfortune'] as const) {
    const rng = createRng(seed)
    for (let i = 0; i < 500; i++) {
      const r = rollCheck(4, 15, rng, f)
      assert.equal(r.rolls.length, 2)
      const [a, b] = r.rolls as [number, number]
      assert.equal(r.natural, f === 'fortune' ? Math.max(a, b) : Math.min(a, b))
      assert.equal(r.total, r.natural + 4)
      assert.equal(r.degree, degreeOf(r.natural, r.total, 15))
    }
  }
  // Same seed, same first pair: fortune can never come out worse than misfortune.
  const f = createRng(seed), m = createRng(seed)
  for (let i = 0; i < 500; i++) assert.ok(rollCheck(0, 10, f, 'fortune').natural >= rollCheck(0, 10, m, 'misfortune').natural)
})

test('rolled checks converge on the exact distribution (fortune and misfortune included)', () => {
  const n = 120000
  for (const [mod, dc, f] of [[9, 15, 'none'], [6, 12, 'fortune'], [3, 18, 'misfortune']] as const) {
    const rng = createRng(2024)
    const counts = [0, 0, 0, 0]
    for (let i = 0; i < n; i++) counts[rollCheck(mod, dc, rng, f).degree]++
    const exact = outcomeDistribution(mod, dc, f)
    for (const d of DEGREES) close(counts[d] / n, exact[d], 0.006)
  }
})

test('seeded rolls are deterministic and uniform over 1..20', () => {
  const r1 = createRng(42), r2 = createRng(42)
  const seq1 = Array.from({ length: 50 }, () => rollCheck(3, 15, r1).natural)
  const seq2 = Array.from({ length: 50 }, () => rollCheck(3, 15, r2).natural)
  assert.deepEqual(seq1, seq2)
  const rng = createRng(7)
  const counts = new Array(21).fill(0)
  for (let i = 0; i < 200000; i++) counts[rollCheck(0, 10, rng).natural]++
  assert.equal(counts[0], 0)
  for (let n = 1; n <= 20; n++) assert.ok(Math.abs(counts[n] / 200000 - 0.05) < 0.003, `face ${n}`)
})

test('civic reaction tables index by degree: four entries, a better degree is never slower', () => {
  for (const table of [DRIVER_REACTION.latency, WALK_START.delay]) {
    assert.equal(table.length, DEGREES.length)
    for (let d = 1; d < table.length; d++) assert.ok(table[d] <= table[d - 1], `entry ${d}`)
    for (const s of table) assert.ok(s >= 0 && Number.isFinite(s))
  }
  // Expected driver reaction under the published check (+9 vs DC 15: 5 / 20 / 50 / 25 %).
  const p = outcomeDistribution(DRIVER_REACTION.modifier, DRIVER_REACTION.dc)
  const mean = DEGREES.reduce<number>((s, d) => s + p[d] * DRIVER_REACTION.latency[d], 0)
  assert.ok(mean > 0 && mean < DRIVER_REACTION.latency[CRIT_FAILURE])
})

test('pacifist kernel: no combat mechanics are exported or described', () => {
  for (const name of Object.keys(degrees)) assert.doesNotMatch(name, /attack|damage|weapon|kill/i, name)
  const source = readFileSync(new URL('./degrees.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\b(attack|damage|weapon|kill|combat)/i)
})

/** Markdown/plain-text wrapping must not matter: collapse whitespace and blockquote markers. */
const flat = (s: string) => s.replace(/^\s*>\s?/gm, '').replace(/\s+/g, ' ')

test('the ORC Notice is identical in code, LICENSE and NOTICE.md, and names the registration', () => {
  assert.match(ORC_NOTICE, /TX 9-307-067/)
  assert.match(ORC_NOTICE, /All warranties are disclaimed as set forth therein\.$/)
  const license = readFileSync(new URL('../../LICENSE', import.meta.url), 'utf8')
  const notice = readFileSync(new URL('../../NOTICE.md', import.meta.url), 'utf8')
  assert.ok(flat(license).includes(ORC_NOTICE), 'LICENSE lacks the ORC Notice')
  assert.ok(flat(notice).includes(ORC_NOTICE), 'NOTICE.md lacks the ORC Notice')
  // A rename in brand.ts must be carried into the Reserved Material and credit lines.
  assert.ok(notice.includes(BRAND.name), 'NOTICE.md does not name the current BRAND.name')
  for (const heading of ['ORC Notice', 'Attribution', 'Reserved Material', 'Expressly Designated Licensed Material']) {
    assert.ok(notice.includes(`## ${heading}`), `NOTICE.md lacks "## ${heading}"`)
  }
})
