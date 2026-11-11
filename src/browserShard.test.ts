// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? CI's browser smoke runs as two parallel jobs, each running the part of the scenarios that
 * tools/browser/shard.mjs gives it (`smoke.mjs --shard i/n`). A part that dropped a scenario would let a browser-only
 * bug through with every check green, so this pins, without a browser: every scenario runs in exactly one part, in
 * the smoke's own order; the parts take about the same time; `--shard` refuses anything but i/n; the time table names
 * exactly the smoke's scenarios; and ci.yml runs both parts, keeps the crowd kernels' compile in one of them, and
 * keeps each part's screenshots apart.
 * What breaks if it is removed? A change to the split, the smoke or the workflow could leave a scenario out of every
 * part, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// tools/ is plain JavaScript with no types; a computed specifier keeps the page's typecheck off it.
const SHARD: string = '../tools/browser/shard.mjs'
const shard = (await import(SHARD)) as {
  SHARD_SECONDS: Readonly<Record<string, number>>
  SHARD_DEFAULT: number
  SHARD_MAX: number
  parseShard(text: unknown): { i: number; n: number }
  shardOf(names: string[], i: number, n: number, seconds?: Record<string, number>): string[]
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const SMOKE = read('../tools/browser/smoke.mjs')
const CI = read('../.github/workflows/ci.yml')

/** The smoke's scenarios, in its own order (each is an `async name(` method of its SCENARIOS table). */
const SCENARIOS = (() => {
  const from = SMOKE.indexOf('\nconst SCENARIOS = {\n')
  assert.ok(from > 0, 'smoke.mjs has its SCENARIOS table')
  const to = SMOKE.indexOf('\n}\n', from)
  return [...SMOKE.slice(from, to).matchAll(/^ {2}async (\w+)\(/gm)].map((m) => m[1])
})()

const cost = (name: string) => shard.SHARD_SECONDS[name] ?? shard.SHARD_DEFAULT
const total = (names: string[]) => names.reduce((s, name) => s + cost(name), 0)

test('the time table names exactly the smoke\'s scenarios, and the usage line lists them in the same order', () => {
  assert.ok(SCENARIOS.length >= 20, `${SCENARIOS.length} scenarios found`)
  assert.deepEqual([...SCENARIOS].sort(), Object.keys(shard.SHARD_SECONDS).sort(),
    'a new scenario gets its CI seconds in SHARD_SECONDS (a missing one only counts as SHARD_DEFAULT, but say how long it takes)')
  const usage = /\[--only ([\w,]+)\]/.exec(SMOKE)
  assert.ok(usage, 'smoke.mjs keeps its usage line')
  assert.deepEqual(usage[1].split(','), SCENARIOS)
  for (const [name, s] of Object.entries(shard.SHARD_SECONDS)) assert.ok(Number.isInteger(s) && s > 0, `${name}: ${s}`)
  assert.ok(Object.isFrozen(shard.SHARD_SECONDS))
})

test('every scenario runs in exactly one part, each part in the smoke\'s order, for every split up to the most', () => {
  for (let n = 1; n <= shard.SHARD_MAX; n++) {
    const parts = Array.from({ length: n }, (_, k) => shard.shardOf(SCENARIOS, k + 1, n))
    const seen = parts.flat()
    assert.equal(seen.length, SCENARIOS.length, `${n} parts: no scenario twice`)
    assert.deepEqual([...seen].sort(), [...SCENARIOS].sort(), `${n} parts: every scenario once`)
    for (const part of parts) assert.deepEqual(part, SCENARIOS.filter((name) => part.includes(name)), `${n} parts: the smoke's order`)
    if (n <= SCENARIOS.length) for (const part of parts) assert.ok(part.length > 0, `${n} parts: none empty`)
  }
  assert.deepEqual(shard.shardOf(SCENARIOS, 1, 1), SCENARIOS, 'one part is the whole run')
})

test('the two parts CI runs take about the same time, and the longest scenarios are not in the same part', () => {
  const [a, b] = [shard.shardOf(SCENARIOS, 1, 2), shard.shardOf(SCENARIOS, 2, 2)]
  const [ta, tb] = [total(a), total(b)]
  // Longest first into the lighter part is never further apart than the longest scenario; here it is far closer.
  assert.ok(Math.abs(ta - tb) <= 60, `parts of ${ta} s and ${tb} s`)
  assert.ok(Math.max(ta, tb) < 0.52 * total(SCENARIOS), `the longer part is ${Math.max(ta, tb)} s of ${total(SCENARIOS)} s`)
  assert.notEqual(a.includes('phone'), a.includes('ultra'), 'the phone and Ultra (the two longest) are split')
  // A filter (`--only`) is split the same way: the parts of a filtered list cover it once.
  const some = ['tty', 'file', 'homes', 'rest']
  assert.deepEqual([...shard.shardOf(some, 1, 2), ...shard.shardOf(some, 2, 2)].sort(), [...some].sort())
})

test('the split is decided by the times alone, ties go in order, and an unknown scenario counts as the default', () => {
  assert.deepEqual(shard.shardOf(['a', 'b', 'c', 'd'], 1, 2, { a: 10, b: 10, c: 10, d: 10 }), ['a', 'c'])
  assert.deepEqual(shard.shardOf(['a', 'b', 'c', 'd'], 2, 2, { a: 10, b: 10, c: 10, d: 10 }), ['b', 'd'])
  assert.deepEqual(shard.shardOf(['a', 'b', 'c'], 1, 2, { a: 1, b: 9, c: 1 }), ['b'])
  assert.deepEqual(shard.shardOf(['a', 'b', 'c'], 2, 2, { a: 1, b: 9, c: 1 }), ['a', 'c'])
  // 'new' is not in the table: it counts as SHARD_DEFAULT (120), heavier than 'x' and lighter than 'y'.
  assert.deepEqual(shard.shardOf(['x', 'new', 'y'], 1, 2, { x: 100, y: 130 }), ['y'])
  assert.deepEqual(shard.shardOf(['x', 'new', 'y'], 2, 2, { x: 100, y: 130 }), ['x', 'new'])
  assert.deepEqual(shard.shardOf([], 1, 2), [])
  assert.deepEqual(shard.shardOf(SCENARIOS, 1, 2), shard.shardOf([...SCENARIOS], 1, 2), 'the same answer every time')
})

test('--shard takes i/n with 1 <= i <= n <= the most, and refuses everything else', () => {
  assert.deepEqual(shard.parseShard('1/2'), { i: 1, n: 2 })
  assert.deepEqual(shard.parseShard(' 2 / 2 '), { i: 2, n: 2 })
  assert.deepEqual(shard.parseShard(`${shard.SHARD_MAX}/${shard.SHARD_MAX}`), { i: shard.SHARD_MAX, n: shard.SHARD_MAX })
  for (const bad of ['0/2', '3/2', '1/0', '/2', '1/', '1', '1/2/3', 'a/b', '-1/2', '1.5/2', '', `1/${shard.SHARD_MAX + 1}`, undefined, null])
    assert.throws(() => shard.parseShard(bad), /--shard takes i\/n/, JSON.stringify(bad))
})

test('the smoke runs only its part with --shard, after any --only, and says which scenarios that is', () => {
  assert.match(SMOKE, /import \{ parseShard, shardOf \} from '\.\/shard\.mjs'/)
  assert.match(SMOKE, /const SHARD = arg\('shard'\) === undefined \? null : parseShard\(arg\('shard'\)\)/)
  assert.match(SMOKE, /const names = Object\.keys\(SCENARIOS\)\.filter\(\(name\) => !ONLY \|\| ONLY\.includes\(name\)\)\n\s+const chosen = SHARD \? shardOf\(names, SHARD\.i, SHARD\.n\) : names\n/)
  assert.match(SMOKE, /for \(const name of chosen\) \{/)
  assert.doesNotMatch(SMOKE, /for \(const \[name, run\] of Object\.entries\(SCENARIOS\)\)/, 'the loop goes over the chosen part only')
  assert.match(read('../tools/selfheal/checks.sh'), /page-browser\)\s+node tools\/browser\/smoke\.mjs .*\$\{BROWSER_SHARD:\+--shard "\$BROWSER_SHARD"\}/)
})

test('ci.yml runs both parts side by side, a failure in one never cancels the other, and the kernels compile in one', () => {
  const from = CI.indexOf('\n  browser:\n')
  assert.ok(from > 0, 'ci.yml has its browser job')
  const next = CI.slice(from + 1).search(/\n {2}[a-z][\w-]*:\n/)
  const job = next < 0 ? CI.slice(from) : CI.slice(from, from + 1 + next)
  assert.match(job, /\n {4}strategy:\n {6}fail-fast: false\n {6}matrix:\n {8}shard: \[1, 2\]\n/)
  assert.match(job, /BROWSER_SHARD: \$\{\{ matrix\.shard \}\}\/2\n/)
  assert.match(job, /run: sh tools\/selfheal\/checks\.sh page-build page-browser \$\{\{ matrix\.shard == 2 && 'page-kernels' \|\| '' \}\}\n/)
  assert.match(job, /name: browser-smoke-\$\{\{ github\.run_id \}\}-\$\{\{ matrix\.shard \}\}\n/, 'each part keeps its own screenshots')
  assert.match(job, /timeout-minutes: 90\n/)
  // The job list's parts and the workflow's i/n agree, so no part is left unrun.
  const parts = /shard: \[([\d, ]+)\]/.exec(job)![1].split(',').map((s) => Number(s.trim()))
  assert.deepEqual(parts, Array.from({ length: 2 }, (_, k) => k + 1))
})
