// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? `npm test` on Windows runs tools/test/warm.mjs first (the `pretest` script): it opens every
 * file of the checkout once, serially, so a scanner that holds freshly downloaded files on first open has seen them
 * before the runner's parallel processes race for them (the EPERM failures of four Windows runs). CI runs on Linux,
 * where the script is a silent no-op, so this is the only place the walk itself runs: forced with CRIMSON_WARM=always
 * it must visit the whole checkout, skip node_modules, and exit 0; unforced it must print nothing and exit 0.
 * What breaks if it is removed? The warm-up could stop walking (a wrong root, a thrown readdir) and no one would know
 * until a Windows run failed the way it did before the script existed.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = 'tools/test/warm.mjs'

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
