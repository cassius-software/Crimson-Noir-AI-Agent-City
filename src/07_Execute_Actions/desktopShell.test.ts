// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins how the page tells the desktop window from a browser tab (desktopShell.ts): only
 * Tauri's whole API shape counts, and the page keeps no Tauri package of its own, so the browser build stays what it
 * was. It also pins the shell's GPU reading: the page asks `gpu_memory` (src-tauri/src/gpu.rs) once, takes only a list
 * of numbers, never throws and never waits past GPU_READ_MS; the shell registers the command, lists hardware adapters
 * only, and answers elsewhere than Windows with an empty list.
 * What breaks if it is removed? A half-injected global could mount the title bar in a tab, a dependency could
 * quietly put Tauri's client into every browser build, or a shell that hangs or answers oddly could hold the page's
 * figure or throw at boot.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { desktopShell, GPU_READ_MS, SHELL_GLOBAL, shellGpuMemory } from './desktopShell.ts'

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

/** A shell whose `gpu_memory` answers with `answer` (a function: called per ask), noting each command asked. */
const gpuShell = (answer: () => unknown) => {
  const asked: string[] = []
  const core = { invoke(this: unknown, command: string): unknown { assert.equal(this, core, 'invoked on core, as Tauri expects'); asked.push(command); return answer() } }
  return { g: { [SHELL_GLOBAL]: { core } }, asked }
}

test('shellGpuMemory: the shell\'s list of adapter bytes as it answers; null in a browser or a shell without core.invoke', async () => {
  assert.equal(GPU_READ_MS, 2000)
  const { g, asked } = gpuShell(async () => [536_870_912, 8_589_934_592])
  assert.deepEqual(await shellGpuMemory(g), [536_870_912, 8_589_934_592])
  assert.deepEqual(asked, ['gpu_memory'])
  assert.deepEqual(await shellGpuMemory(gpuShell(async () => []).g), [], 'no hardware adapter (or not Windows): an empty list')
  for (const g of [{}, { [SHELL_GLOBAL]: null }, { [SHELL_GLOBAL]: {} }, { [SHELL_GLOBAL]: { core: {} } }, { [SHELL_GLOBAL]: { core: { invoke: 'x' } } }]) assert.equal(await shellGpuMemory(g), null)
})

test('shellGpuMemory: an answer that is not a list of numbers, a refusal, a throw, or no answer within the wait is null, and nothing throws', async () => {
  for (const odd of [null, 8_589_934_592, '8589934592', { bytes: [1] }, [1, '2'], [null]]) assert.equal(await shellGpuMemory(gpuShell(async () => odd).g), null, JSON.stringify(odd))
  assert.equal(await shellGpuMemory(gpuShell(async () => { throw new Error('command gpu_memory not found') }).g), null, 'an older shell without the command')
  assert.equal(await shellGpuMemory(gpuShell(() => { throw new Error('thrown at once') }).g), null, 'a synchronous throw')
  // A shell that never answers: null after the wait, and the timer does not hold the process (the test would hang).
  const t0 = performance.now()
  assert.equal(await shellGpuMemory(gpuShell(() => new Promise(() => {})).g, 50), null)
  assert.ok(performance.now() - t0 < 1000)
})

test('the shell registers gpu_memory, reads hardware adapters only through DXGI, and answers elsewhere with an empty list', async () => {
  const { readFileSync } = await import('node:fs')
  const rs = readFileSync(new URL('../../src-tauri/src/gpu.rs', import.meta.url), 'utf8')
  assert.match(rs, /#\[tauri::command\(async\)\]\npub fn gpu_memory\(\) -> Vec<u64> \{\n {4}adapters\(\)\n\}/, 'one command, off the main thread, a list of byte counts')
  assert.match(rs, /let skip = \(DXGI_ADAPTER_FLAG_SOFTWARE\.0 \| DXGI_ADAPTER_FLAG_REMOTE\.0\) as u32;/, 'software and remote adapters are left out')
  assert.match(rs, /if desc\.Flags & skip == 0 \{\n {12}bytes\.push\(desc\.DedicatedVideoMemory as u64\);/, 'dedicated memory, adapter by adapter')
  assert.match(rs, /#\[cfg\(not\(windows\)\)\]\nfn adapters\(\) -> Vec<u64> \{\n {4}Vec::new\(\)\n\}/, 'elsewhere than Windows: an empty list')
  assert.doesNotMatch(rs, /std::(fs|net|process)|Command::new|TcpStream|File::/, 'nothing but DXGI: no file, no socket, no process')
  const lib = readFileSync(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  assert.match(lib, /^mod gpu;$/m)
  assert.match(lib, /generate_handler!\[[^\]]*\bgpu::gpu_memory\]/)
  const cargo = readFileSync(new URL('../../src-tauri/Cargo.toml', import.meta.url), 'utf8')
  assert.match(cargo, /\[target\.'cfg\(windows\)'\.dependencies\](?:(?!\n\[)[\s\S])*\nwindows = \{ version = "0\.62", features = \["Win32_Foundation", "Win32_Graphics_Dxgi"\] \}/, 'Windows only, the version the web view already uses')
  const lock = readFileSync(new URL('../../src-tauri/Cargo.lock', import.meta.url), 'utf8')
  const app = /\[\[package\]\]\nname = "crimson-noir-app"[\s\S]*?dependencies = \[([^\]]*)\]/.exec(lock)
  assert.ok(app?.[1].includes('"windows"'), 'the lockfile carries the edge (the app builds --locked)')
  assert.equal([...lock.matchAll(/^name = "windows"$/gm)].length, 1, 'one windows crate in the tree, not a second copy')
})
