#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? On Windows, `npm test` runs it first (the `pretest` script). A repository that arrived as a
 * downloaded ZIP carries the mark of the web, and an on-access scanner opens each of those files exclusively the
 * first time anything reads it. The test runner's parallel processes import a few hundred source files at once, so on
 * a fresh extract dozens of them die at import with `EPERM: operation not permitted, open '…\src\…\x.ts'` (four runs
 * of exactly that in the project's own history; never a test asserting anything). This script opens every file of the
 * checkout once, one at a time, before the runner starts, and when a file is held it waits and tries again, so the
 * scanner has seen each file before the tests race for it. It also says so when the checkout sits in `Downloads`,
 * where that scanner is the rule. Anywhere but Windows it exits at once and prints nothing (CI runs `node --test`
 * directly, so it never sees this script); `CRIMSON_WARM=always` runs the walk on any platform, for the test of it.
 * What breaks if it is removed? A first `npm test` from a fresh ZIP on Windows fails tens of files with EPERM and
 * nothing explains why.
 */
import { closeSync, openSync, readSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WINDOWS = process.platform === 'win32'
if (!WINDOWS && process.env.CRIMSON_WARM !== 'always') process.exit(0)

/** Directory names not walked: nothing a test imports lives there, and node_modules alone is tens of thousands of files. */
const SKIP = new Set(['.git', 'node_modules', 'dist', 'target', '.vite'])
/** The errors a file held by another program comes back with on Windows (EPERM is errno -4048, the one seen). */
const HELD = new Set(['EPERM', 'EBUSY', 'EACCES'])
const TRIES = 30
const WAIT_MS = 100

const cell = new Int32Array(new SharedArrayBuffer(4))
/** A synchronous pause: the walk is deliberately serial, one open at a time, so nothing races the scanner. */
const sleep = (ms) => { Atomics.wait(cell, 0, 0, ms) }

function* files(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* files(p)
    else if (e.isFile()) yield p
  }
}

/** Opens the file and reads its first byte; a held file is retried after a pause. Returns how many opens were refused. */
function warm(path) {
  const byte = Buffer.alloc(1)
  for (let refused = 0; ; refused++) {
    try {
      const fd = openSync(path, 'r')
      try { readSync(fd, byte, 0, 1, 0) } finally { closeSync(fd) }
      return refused
    } catch (e) {
      if (!HELD.has(e.code) || refused + 1 >= TRIES) throw e
      sleep(WAIT_MS)
    }
  }
}

let count = 0
let held = 0
let longest = 0
const unreadable = []
for (const f of files(ROOT)) {
  count++
  try {
    const refused = warm(f)
    if (refused > 0) { held++; longest = Math.max(longest, refused * WAIT_MS) }
  } catch (e) {
    unreadable.push(`${relative(ROOT, f).split(sep).join('/')}: ${e.code ?? e.message}`)
  }
}

console.log(`warm: ${count} files opened once before the test run`)
if (held > 0) console.log(`warm: ${held} of them were held by another program at first open (an on-access scanner) and came free within ${longest} ms`)
if (unreadable.length > 0) {
  console.log(`warm: ${unreadable.length} still could not be opened after ${(TRIES * WAIT_MS) / 1000} s each; the tests that import them will fail with the same error:`)
  for (const u of unreadable) console.log(`  ${u}`)
}
const downloads = join(homedir(), 'Downloads') + sep
if (WINDOWS && ROOT.toLowerCase().startsWith(downloads.toLowerCase())) {
  console.log('warm: this checkout is inside Downloads. A fresh download carries the mark of the web, and the scanner that')
  console.log('warm: holds those files on first open is what fails tests with EPERM. Move the folder out of Downloads (say')
  console.log('warm: C:\\dev), or `git clone` instead of extracting a ZIP, and the first run comes out like the second.')
}
