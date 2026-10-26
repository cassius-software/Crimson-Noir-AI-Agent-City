// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? On Windows an on-access scanner opens a freshly downloaded file exclusively the first time
 * anything reads it, and a read that lands meanwhile fails with `EPERM: operation not permitted, open '…'` (warm.mjs,
 * the `pretest` script, says more). The warm-up opens every file of the checkout once before the run, but the scanner
 * can hold a file again during it: a laptop run from a ZIP in Downloads, warmed, still lost the two tests that read
 * the whole tree to one held file each. So the tests that read hundreds of files in a row (compliance, zeroTrust,
 * airgap) read them through `readHeld`, which waits a held file out the way the warm-up does: a pause, then the same
 * read again, up to TRIES times, and the last error thrown as it came. Anywhere but Windows nothing holds a file this
 * way, so there the first try is the only one (`CRIMSON_WARM=always` turns the retries on anywhere, for the test of
 * them). A test file the runner itself cannot open, at import, is out of any test's reach: only a folder the scanner
 * has seen, or one outside Downloads, avoids that failure.
 * What breaks if it is removed? A tree-reading test on a fresh Windows checkout fails on whichever file the scanner
 * holds at that moment, with an EPERM that asserts nothing.
 */
import { readFileSync } from 'node:fs'

/** The errors a file held by another program comes back with on Windows (EPERM is errno -4048, the one seen). */
export const HELD = new Set(['EPERM', 'EBUSY', 'EACCES'])
export const TRIES = 30
export const WAIT_MS = 100

const cell = new Int32Array(new SharedArrayBuffer(4))
/** A synchronous pause: the retries are deliberately serial, one open at a time, so nothing races the scanner. */
export const sleep = (ms) => { Atomics.wait(cell, 0, 0, ms) }

/** Whether a held file is tried again here: on Windows, or wherever CRIMSON_WARM=always asks for it. */
const retrying = () => process.platform === 'win32' || process.env.CRIMSON_WARM === 'always'

/**
 * `open()` (a synchronous read of one file), tried again after a pause while it fails the way a held file fails, up
 * to `tries` times; any other error, or the last, is thrown as it came. Off Windows, unforced, the first try is the
 * only one.
 */
export function held(open, tries = TRIES) {
  for (let refused = 0; ; refused++) {
    try {
      return open()
    } catch (e) {
      if (!retrying() || !HELD.has(e?.code) || refused + 1 >= tries) throw e
      sleep(WAIT_MS)
    }
  }
}

/** readFileSync, with a held file waited out. */
export const readHeld = (path, options) => held(() => readFileSync(path, options))
