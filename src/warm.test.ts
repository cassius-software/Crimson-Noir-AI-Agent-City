// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? `npm test` on Windows runs tools/test/warm.mjs first (the `pretest` script): it opens every
 * file of the checkout once, serially, so a scanner that holds freshly downloaded files on first open has seen them
 * before the runner's parallel processes race for them (the EPERM failures of four Windows runs). CI runs on Linux,
 * where the script is a silent no-op, so this is the only place the walk itself runs: forced with CRIMSON_WARM=always
 * it must visit the whole checkout, skip node_modules, and exit 0; unforced it must print nothing and exit 0. The
 * same wait at a read inside a test (tools/test/held.mjs, what the tree-reading tests read files through) is held to
 * its word here too: tried again on a held file's error only, up to the limit, and off Windows not at all.
 * What breaks if it is removed? The warm-up could stop walking (a wrong root, a thrown readdir), or the read's retry
 * could swallow a real error or spin, and no one would know until a Windows run failed the way it did before the
 * script existed.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = 'tools/test/warm.mjs'
// The read's retry is plain JavaScript (tools/ carries no types); a computed specifier keeps the page's typecheck off it.
const HELD: string = '../tools/test/held.mjs'
const { held, TRIES, WAIT_MS } = (await import(HELD)) as { held<T>(open: () => T, tries?: number): T; TRIES: number; WAIT_MS: number }
/** What a read of a file throws when the scanner holds it (EPERM, errno -4048 on Windows), or when it is missing (ENOENT). */
const refused = (code: string): Error => Object.assign(new Error(`${code}: operation not permitted, open`), { code })

/** `fn` with CRIMSON_WARM set to `value` (or unset), the variable put back after. */
function forced<T>(value: string | undefined, fn: () => T): T {
  const was = process.env.CRIMSON_WARM
  if (value === undefined) delete process.env.CRIMSON_WARM
  else process.env.CRIMSON_WARM = value
  try {
    return fn()
  } finally {
    if (was === undefined) delete process.env.CRIMSON_WARM
    else process.env.CRIMSON_WARM = was
  }
}

function warm(env: Record<string, string>) {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } })
  return { status: r.status, out: r.stdout, err: r.stderr }
}

test('forced, the warm-up opens every file of the checkout once and exits 0', { timeout: 60_000 }, () => {
  const r = warm({ CRIMSON_WARM: 'always' })
  assert.equal(r.status, 0, r.err)
  const m = /^warm: (\d+) files opened once before the test run$/m.exec(r.out)
  assert.ok(m, `the count line is printed:\n${r.out}${r.err}`)
  const count = Number(m[1])
  // The tracked files number a few hundred; node_modules alone would be tens of thousands.
  assert.ok(count >= 400 && count < 5_000, `${count} files: the whole checkout and nothing of node_modules`)
  assert.ok(!/could not be opened/.test(r.out), r.out)
})

test('on a platform other than Windows, unforced, it prints nothing and exits 0', { skip: process.platform === 'win32' }, () => {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (k !== 'CRIMSON_WARM' && v !== undefined) env[k] = v
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '')
  assert.equal(r.stderr, '')
})

test('held: a read the scanner refuses is tried again after a pause, up to the limit; any other error is thrown as it came', () => {
  forced('always', () => {
    let calls = 0
    const t0 = performance.now()
    assert.equal(held(() => { if (++calls < 3) throw refused('EPERM'); return 'read' }), 'read')
    assert.equal(calls, 3)
    assert.ok(performance.now() - t0 >= 1.5 * WAIT_MS, 'a pause between the tries')
    calls = 0
    assert.throws(() => held(() => { calls++; throw refused('EPERM') }, 2), { code: 'EPERM' })
    assert.equal(calls, 2, 'the limit, then the last error as it came')
    assert.ok(TRIES * WAIT_MS >= 1_000, 'the real limit waits a held file out for at least a second')
    calls = 0
    assert.throws(() => held(() => { calls++; throw refused('ENOENT') }), { code: 'ENOENT' })
    assert.equal(calls, 1, 'a missing file is not a held one')
  })
})

test('held: off Windows, unforced, the first try is the only one', { skip: process.platform === 'win32' }, () => {
  forced(undefined, () => {
    let calls = 0
    assert.throws(() => held(() => { calls++; throw refused('EPERM') }), { code: 'EPERM' })
    assert.equal(calls, 1)
  })
})
