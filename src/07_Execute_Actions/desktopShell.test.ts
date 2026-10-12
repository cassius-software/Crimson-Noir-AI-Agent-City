// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins how the page tells the desktop window from a browser tab (desktopShell.ts): only
 * Tauri's whole API shape counts, and the page keeps no Tauri package of its own, so the browser build stays what it
 * was.
 * What breaks if it is removed? A half-injected global could mount the title bar in a tab, or a dependency could
 * quietly put Tauri's client into every browser build.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { desktopShell, SHELL_GLOBAL } from './desktopShell.ts'

test('a browser global, or one with a half-shaped API, is no desktop shell', () => {
  assert.equal(desktopShell({}), null)
  assert.equal(desktopShell({ [SHELL_GLOBAL]: null }), null)
  assert.equal(desktopShell({ [SHELL_GLOBAL]: {} }), null)
  assert.equal(desktopShell({ [SHELL_GLOBAL]: { window: {} } }), null)
})

test('the Tauri global with a current window is the shell, returned as is', () => {
  const api = { window: { getCurrentWindow: () => ({}) } }
  assert.equal(desktopShell({ [SHELL_GLOBAL]: api }), api)
})

test('the page bundles no Tauri package: the shell is read from the global alone', async () => {
  const { readFileSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { dependencies?: Record<string, string> }
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith('@tauri-apps/')), [])
})
