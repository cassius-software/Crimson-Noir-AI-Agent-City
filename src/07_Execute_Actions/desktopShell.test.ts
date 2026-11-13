// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins how the page tells the desktop window from a browser tab (desktopShell.ts): only
 * Tauri's whole API shape counts, and the page keeps no Tauri package of its own, so the browser build stays what it
 * was. It also pins the shell's GPU reading: the page asks `gpu_memory` (src-tauri/src/gpu.rs) once, takes only a list
 * of numbers, never throws and never waits past GPU_READ_MS; the shell registers the command, lists hardware adapters
 * only, and answers elsewhere than Windows with an empty list. And it pins the page's way to the model the Windows
 * installer carries (src-tauri/src/model.rs): the offer only for exactly the pin, the fetch only of that one file,
 * read by read in order as base64 text, the first read before the fetch answers, a stop between reads, and the
 * shell's two commands over one fixed file with no path from the page.
 * What breaks if it is removed? A half-injected global could mount the title bar in a tab, a dependency could
 * quietly put Tauri's client into every browser build, or a shell that hangs or answers oddly could hold the page's
 * figure or throw at boot.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { APP_MODEL_ASK_MS, APP_READ_BYTES, desktopShell, fromBase64, GPU_READ_MS, SHELL_GLOBAL, shellGpuMemory, shellModel, shellModelFetch } from './desktopShell.ts'
import { APP_MODEL, fetchSiteModel, type SiteModelPin } from '../09_Cognition/siteModel.ts'

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
  // A shell that never answers: null after the wait.
  const t0 = performance.now()
  assert.equal(await shellGpuMemory(gpuShell(() => new Promise(() => {})).g, 50), null)
  assert.ok(performance.now() - t0 < 1000)
  // A quick answer, or a quick refusal, leaves no wait timer behind to hold the window's process.
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  const before = timers()
  assert.deepEqual(await shellGpuMemory(gpuShell(async () => [1]).g, 5000), [1])
  assert.equal(await shellGpuMemory(gpuShell(async () => { throw new Error('no') }).g, 5000), null)
  assert.equal(timers(), before, 'the wait is cleared once the shell answers')
})

test('the shell registers gpu_memory, reads hardware adapters only through DXGI, and answers elsewhere with an empty list', async () => {
  const { readFileSync } = await import('node:fs')
  const rs = readFileSync(new URL('../../src-tauri/src/gpu.rs', import.meta.url), 'utf8')
  assert.match(rs, /#\[tauri::command\(async\)\]\npub fn gpu_memory\(\) -> Vec<u64> \{\n {4}adapters\(\)\n\}/, 'one command, off the main thread, a list of byte counts')
  assert.match(rs, /let software = DXGI_ADAPTER_FLAG_SOFTWARE\.0 as u32;/, 'software adapters (the Basic Render Driver) are left out')
  assert.match(rs, /if desc\.Flags & software == 0 \{\n {12}bytes\.push\(desc\.DedicatedVideoMemory as u64\);/, 'dedicated memory, adapter by adapter')
  assert.doesNotMatch(rs, /^\s*(?:use|let)\b.*DXGI_ADAPTER_FLAG_REMOTE/m, 'the remote flag is reserved (always 0), so it is not masked as if it filtered anything')
  assert.match(rs, /#\[cfg\(not\(windows\)\)\]\nfn adapters\(\) -> Vec<u64> \{\n {4}Vec::new\(\)\n\}/, 'elsewhere than Windows: an empty list')
  assert.doesNotMatch(rs, /std::(fs|net|process)|Command::new|TcpStream|File::/, 'nothing but DXGI: no file, no socket, no process')
  const lib = readFileSync(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  assert.match(lib, /^mod gpu;$/m)
  assert.match(lib, /generate_handler!\[[^\]]*\bgpu::gpu_memory\b[^\]]*\]/)
  const cargo = readFileSync(new URL('../../src-tauri/Cargo.toml', import.meta.url), 'utf8')
  assert.match(cargo, /\[target\.'cfg\(windows\)'\.dependencies\](?:(?!\n\[)[\s\S])*\nwindows = \{ version = "0\.62", features = \["Win32_Foundation", "Win32_Graphics_Dxgi"\] \}/, 'Windows only, the version the web view already uses')
  const lock = readFileSync(new URL('../../src-tauri/Cargo.lock', import.meta.url), 'utf8')
  const app = /\[\[package\]\]\nname = "crimson-noir-app"[\s\S]*?dependencies = \[([^\]]*)\]/.exec(lock)
  assert.ok(app?.[1].includes('"windows"'), 'the committed lockfile carries the edge, so a build does not have to add it')
  assert.equal([...lock.matchAll(/^name = "windows"$/gm)].length, 1, 'one windows crate in the tree, not a second copy')
})

/** A shell carrying `model` (bytes): `app_model` answers its name and size, `app_model_read` reads it as model.rs does. */
const modelShell = (model: Uint8Array, opts: { file?: string; bytes?: number; read?: (offset: number, len: number) => unknown; answer?: () => unknown } = {}) => {
  const reads: { offset: number; len: number }[] = []
  const asked: string[] = []
  const core = {
    invoke(this: unknown, command: string, args?: { offset: number; len: number }): unknown {
      assert.equal(this, core, 'invoked on core, as Tauri expects')
      asked.push(command)
      if (command === 'app_model') return opts.answer ? opts.answer() : Promise.resolve({ file: opts.file ?? 'tiny.gguf', bytes: opts.bytes ?? model.length })
      if (command !== 'app_model_read' || !args) return Promise.reject(new Error(`command ${command} not found`))
      reads.push({ offset: args.offset, len: args.len })
      if (opts.read) return opts.read(args.offset, args.len)
      if (args.offset > model.length) return Promise.reject(new Error('past the end'))
      return Promise.resolve(Buffer.from(model.subarray(args.offset, args.offset + args.len)).toString('base64'))
    },
  }
  return { g: { [SHELL_GLOBAL]: { core } }, reads, asked }
}

const sample = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff)
const pinOf = (model: Uint8Array): SiteModelPin => ({ ...APP_MODEL, file: 'tiny.gguf', bytes: model.length, sha256: createHash('sha256').update(model).digest('hex') })

test('shellModel: the app\'s model is offered only when the shell names exactly the pin\'s file and size; else, or in a browser, null; a refusal or no answer in time throws, to be asked again', async () => {
  assert.equal(APP_MODEL_ASK_MS, 5000)
  const model = sample(1000)
  const pin = pinOf(model)
  const s = modelShell(model)
  assert.deepEqual(await shellModel(pin, s.g), { file: 'tiny.gguf', bytes: 1000, sha256: pin.sha256 })
  assert.deepEqual(s.asked, ['app_model'], 'one question, and no read')
  for (const answer of [null, undefined, {}, { file: 'tiny.gguf' }, { file: 'tiny.gguf', bytes: 999 }, { file: 'other.gguf', bytes: 1000 }, { file: 'tiny.gguf', bytes: '1000' }, 'tiny.gguf', [1000]]) {
    assert.equal(await shellModel(pin, modelShell(model, { answer: () => Promise.resolve(answer) }).g), null, JSON.stringify(answer))
  }
  await assert.rejects(shellModel(pin, modelShell(model, { answer: () => Promise.reject(new Error('the shell refused it')) }).g), /the shell refused it/, 'a refusal is not "none"')
  await assert.rejects(shellModel(pin, modelShell(model, { answer: () => new Promise(() => {}) }).g, 30), /did not say within 30 ms/, 'nor is no answer in time')
  // A quick answer leaves no wait timer behind.
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  const before = timers()
  assert.ok(await shellModel(pin, modelShell(model).g, 60_000))
  assert.equal(timers(), before, 'the wait is cleared once the shell answers')
  for (const g of [{}, { [SHELL_GLOBAL]: {} }, { [SHELL_GLOBAL]: { core: {} } }]) assert.equal(await shellModel(pin, g), null)
})

test('shellModelFetch: the one file, read by read in order, each piece asked only once the last is taken, and the empty read ends it', async () => {
  assert.equal(APP_READ_BYTES, 4 * 1024 * 1024)
  assert.equal(shellModelFetch(APP_MODEL, {}), null, 'a browser has no app to read from')
  const model = sample(10_000)
  const pin = pinOf(model)
  const s = modelShell(model)
  const fetch = shellModelFetch(pin, s.g, 4096)
  assert.ok(fetch)
  await assert.rejects(fetch('models/other.gguf', {}), /models\/other\.gguf is not the model this app carries/)
  await assert.rejects(fetch('models/manifest.json', {}), /is not the model this app carries/)
  assert.deepEqual(s.reads, [], 'nothing is read for another path')
  const res = await fetch('models/tiny.gguf', { cache: 'no-store' })
  assert.deepEqual(s.reads, [{ offset: 0, len: 4096 }], 'the first read is made before the fetch answers, and no more')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-length'), '10000')
  // Taken piece by piece: after each piece the page takes, exactly one read has been made for it, none ahead.
  const reader = res.body!.getReader()
  const tick = (): Promise<void> => new Promise((ok) => setTimeout(ok, 0))
  const pieces: Uint8Array[] = []
  for (let k = 1; ; k++) {
    const r = await reader.read()
    await tick()
    if (r.done) break
    assert.equal(s.reads.length, k, `piece ${k} taken: ${k} reads, none ahead`)
    pieces.push(r.value)
  }
  assert.deepEqual(new Uint8Array(Buffer.concat(pieces)), model)
  assert.deepEqual(s.reads, [0, 4096, 8192, 10_000].map((offset) => ({ offset, len: 4096 })), 'in order, from where the last ended, to the empty read at the end')
  // The same file through the page's own check (siteModel.ts fetchSiteModel): kept whole, in the app's words.
  const file = await fetchSiteModel(shellModelFetch(pin, modelShell(model).g, 3000)!, pin, () => {}, undefined, 'app')
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), model)
})

test('shellModelFetch: a first read that fails is the fetch\'s own refusal; a later one breaks the body; odd answers and a stop end it', async () => {
  const model = sample(10_000)
  const pin = pinOf(model)
  const missing = modelShell(model, { read: () => Promise.reject(new Error("the app's model is not beside the app (os error 2)")) })
  await assert.rejects(shellModelFetch(pin, missing.g, 4096)!('models/tiny.gguf', {}), /not beside the app/)
  await assert.rejects(
    fetchSiteModel(shellModelFetch(pin, missing.g, 4096)!, pin, () => {}, undefined, 'app'),
    /^Error: the app could not read the model it carries \(the app's model is not beside the app \(os error 2\)\): install the app again and try again$/,
  )
  const later = modelShell(model, { read: (offset, len) => (offset > 0 ? Promise.reject(new Error('disk')) : Promise.resolve(Buffer.from(model.subarray(offset, offset + len)).toString('base64'))) })
  await assert.rejects(fetchSiteModel(shellModelFetch(pin, later.g, 4096)!, pin, () => {}, undefined, 'app'), /^Error: the copy from the app stopped at 4,096 of 10,000 bytes: try again$/)
  const notText = modelShell(model, { read: () => Promise.resolve([1, 2, 3]) })
  await assert.rejects(shellModelFetch(pin, notText.g, 4096)!('models/tiny.gguf', {}), /something other than text/)
  const tooMuch = modelShell(model, { read: () => Promise.resolve(Buffer.from(model.subarray(0, 5000)).toString('base64')) })
  await assert.rejects(shellModelFetch(pin, tooMuch.g, 4096)!('models/tiny.gguf', {}), /sent 5000 bytes for a read of 4096/)
  const junk = modelShell(model, { read: () => Promise.resolve('not base64 at all!') })
  await assert.rejects(shellModelFetch(pin, junk.g, 4096)!('models/tiny.gguf', {}))
  // A stop: before the first read nothing is asked; mid-way, no read after it.
  const s = modelShell(model)
  const early = new AbortController()
  early.abort(new Error('stopped'))
  await assert.rejects(shellModelFetch(pin, s.g, 4096)!('models/tiny.gguf', { signal: early.signal }), /stopped/)
  assert.deepEqual(s.reads, [])
  const mid = new AbortController()
  await assert.rejects(fetchSiteModel(shellModelFetch(pin, s.g, 1000)!, pin, (done) => { if (done >= 2000) mid.abort(new Error('the visitor stopped it')) }, mid.signal, 'app'), /the visitor stopped it/)
  assert.ok(s.reads.length <= 4, `${s.reads.length} reads: none long after the stop`)
})

test('fromBase64: the engine\'s decoder or atob, the same bytes either way', () => {
  const bytes = sample(300)
  const text = Buffer.from(bytes).toString('base64')
  assert.deepEqual(fromBase64(text), bytes)
  assert.deepEqual(fromBase64(''), new Uint8Array(0))
  const U = Uint8Array as unknown as { fromBase64?: unknown }
  const had = Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64')
  try {
    U.fromBase64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'))
    assert.deepEqual(fromBase64(text), bytes, 'the engine\'s own')
    delete U.fromBase64
    assert.deepEqual(fromBase64(text), bytes, 'atob')
    assert.throws(() => fromBase64('###'))
  } finally {
    if (had) Object.defineProperty(Uint8Array, 'fromBase64', had)
    else delete U.fromBase64
  }
})

test('the shell lends the page the carried model over one fixed file: two commands, no path from the page, reads of at most 4 MiB', async () => {
  const { readFileSync } = await import('node:fs')
  const rs = readFileSync(new URL('../../src-tauri/src/model.rs', import.meta.url), 'utf8')
  assert.match(rs, /#\[tauri::command\(async\)\]\npub fn app_model\(app: AppHandle\) -> Option<AppModel> \{/)
  assert.match(rs, /#\[tauri::command\(async\)\]\npub fn app_model_read\(app: AppHandle, offset: u64, len: u64\) -> Result<String, String> \{/, 'an offset and a length: no path, no file name')
  assert.match(rs, /app\.path\(\)\.resolve\(format!\("models\/\{FILE\}"\), BaseDirectory::Resource\)/, 'the installer\'s models/ folder, beside the app')
  assert.doesNotMatch(rs, /std::(net|process)|Command::new|TcpStream|OpenOptions|write/, 'read only: no socket, no process, no write')
  const file = readFileSync(new URL('../../src-tauri/src/model_file.rs', import.meta.url), 'utf8')
  assert.match(file, /if len == 0 \|\| len > MAX_READ \{/, 'a read is bounded')
  assert.match(file, /if size != bytes \{/, 'a file of another size is never read')
  const code = file.slice(0, file.indexOf('#[cfg(test)]')).replace(/^\s*\/\/.*$/gm, '')
  assert.ok(code.length > 500, 'the reading half, without its tests')
  assert.doesNotMatch(code, /std::(net|process)|tauri|OpenOptions|File::create|\.write/, 'no Tauri, and nothing written')
  const lib = readFileSync(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  assert.match(lib, /^mod model;$/m)
  assert.match(lib, /^mod model_file;$/m)
  assert.match(lib, /generate_handler!\[[^\]]*\bmodel::app_model, model::app_model_read\]/)
  const cargo = readFileSync(new URL('../../src-tauri/Cargo.toml', import.meta.url), 'utf8')
  assert.match(cargo, /\n\[dependencies\](?:(?!\n\[)[\s\S])*\nbase64 = "0\.22"\n/, 'for every platform the app builds on (the reads are the same everywhere)')
  const lock = readFileSync(new URL('../../src-tauri/Cargo.lock', import.meta.url), 'utf8')
  const app = /\[\[package\]\]\nname = "crimson-noir-app"[\s\S]*?dependencies = \[([^\]]*)\]/.exec(lock)
  assert.ok(app?.[1].includes('"base64 0.22.1"'), 'the committed lockfile carries the edge to the base64 Tauri already builds')
})
