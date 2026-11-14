// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins how the page tells the desktop window from a browser tab (desktopShell.ts): only
 * Tauri's whole API shape counts, and the page keeps no Tauri package of its own, so the browser build stays what it
 * was. It also pins the shell's GPU reading: the page asks `gpu_memory` (src-tauri/src/gpu.rs) once, takes only a list
 * of numbers, never throws and never waits past GPU_READ_MS; the shell registers the command, lists hardware adapters
 * only, and answers elsewhere than Windows with an empty list. It pins the page's way to the model the Windows
 * installer carries (src-tauri/src/model.rs): the offer only for exactly the pin, the fetch only of that one file,
 * read by read in order as base64 text, the first read before the fetch answers, a stop between reads, and the
 * shell's two commands over one fixed file with no path from the page. And it pins the page's way to the app's own
 * model (shellRunner): its three commands over `core.invoke`, the request sent as `{ req, onEvent }` with a channel
 * of its own, every event of native/llm/tests/wire.json handed through as it came, and an answer settled only once
 * its channel has ended (or after DRAIN_MS), so a reply that overtakes the last message never cuts it off. On the
 * shell's side it pins the three commands (src-tauri/src/runner.rs): registered in the design's order, taking exactly
 * the names shellRunner sends, compiled only with the native-runner feature on Linux (off by default, so no shipped
 * build compiles llama.cpp), answering none, 'offline' and false everywhere else, waiting for an answer off Tauri's
 * async workers, a page load stopping every answer, no socket and no process, the plan the page asks for, and the
 * installer's model lent to the page nowhere the runner is compiled.
 * What breaks if it is removed? A half-injected global could mount the title bar in a tab, a dependency could
 * quietly put Tauri's client into every browser build, or a shell that hangs or answers oddly could hold the page's
 * figure or throw at boot; the request could reach the runner in a shape it refuses, or an answer lose its tail.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { createNativeMind, type GenRequest } from '../09_Cognition/nativeMind.ts'
import { APP_MODEL_ASK_MS, APP_READ_BYTES, desktopShell, DRAIN_MS, fromBase64, GPU_READ_MS, SHELL_GLOBAL, shellGpuMemory, shellModel, shellModelFetch, shellRunner } from './desktopShell.ts'
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

test('the shell lends the runner\'s three commands in the design\'s order, under the names shellRunner sends, compiled only with the native-runner feature on Linux', async () => {
  const lib = readFileSync(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  assert.match(lib, /^mod runner;$/m)
  assert.match(lib, /generate_handler!\[hid::hid_list, hid::hid_open, hid::hid_write, hid::hid_feature, hid::hid_close, gpu::gpu_memory, runner::native_model, runner::native_generate, runner::native_stop, model::app_model, model::app_model_read\]/)
  assert.match(lib, /\.manage\(runner::Runner::default\(\)\)/, 'managed on the Builder, filled in setup')
  assert.match(lib, /\.setup\(\|app\| \{[\s\S]*?runner::start\(app\.handle\(\)\);[\s\S]*?\}\)/)
  assert.match(lib, /\.on_page_load\(\|webview, payload\| \{\n {12}if matches!\(payload\.event\(\), PageLoadEvent::Started\) \{\n {16}runner::page_loading\(webview\.app_handle\(\)\);/, 'a page that starts loading stops every answer')
  const rs = readFileSync(new URL('../../src-tauri/src/runner.rs', import.meta.url), 'utf8')
  // The names the page sends: native_model (), native_generate ({ req, onEvent }: Tauri reads on_event as onEvent), native_stop ({ id }).
  assert.match(rs, /#\[tauri::command\]\npub fn native_model\(runner: State<'_, Runner>\) -> Option<NativeModel> \{/)
  assert.match(rs, /#\[tauri::command\]\npub async fn native_generate\(runner: State<'_, Runner>, req: GenRequest, on_event: Channel<RunEvent>\) -> Result<GenDone, RunError> \{/)
  assert.match(rs, /#\[tauri::command\]\npub fn native_stop\(runner: State<'_, Runner>, id: u32\) -> bool \{/)
  assert.match(rs, /pub const COMPILED: bool = cfg!\(all\(target_os = "linux", feature = "native-runner"\)\);/)
  assert.equal(rs.split('#[cfg(all(target_os = "linux", feature = "native-runner"))]\nmod imp {').length, 2, 'the runner, where it is compiled')
  assert.equal(rs.split('#[cfg(not(all(target_os = "linux", feature = "native-runner")))]\nmod imp {').length, 2, 'the answers everywhere else')
  const code = rs.slice(0, rs.indexOf('#[cfg(test)]')).replace(/^\s*\/\/.*$/gm, '')
  assert.ok(code.length > 3000, 'the commands and both halves, without their tests')
  assert.doesNotMatch(code, /std::(net|process)\b|Command::new|TcpStream|UdpSocket|reqwest/, 'no socket, no process')
  assert.doesNotMatch(code, /\.unwrap\(\)|\.expect\(|panic!|unreachable!|todo!/, 'nothing the page sends can panic the shell')
  assert.match(code, /tauri::async_runtime::spawn_blocking\(move \|\| answer\.recv\(\)\)/, 'the wait for an answer holds no async worker')
  assert.match(code, /let sink: Sink = Box::new\(move \|event\| on_event\.send\(event\)\.is_ok\(\)\);/, 'a channel that can no longer send stops the answer')
  assert.match(code, /Err\(RunError \{ code: "offline", message: NO_RUNNER \}\)/, 'without the runner an answer is offline, with a sentence')
  assert.match(code, /pub fn stop\(&self, _id: u32\) -> bool \{\n {12}false\n {8}\}/)
  assert.match(code, /pub fn model\(&self\) -> Option<NativeModel> \{\n {12}None\n {8}\}/)
  assert.match(code, /pub const NO_RUNNER: &str = "this app does not run a model itself";/)
  assert.match(code, /pub const NO_MODEL: &str = "this app carries no model to run itself";/)
  // The carried model as a resource, stamped in the app's data folder; a computer's processor alone.
  assert.match(code, /app\.path\(\)\.resolve\(format!\("models\/\{\}", c\.file\), BaseDirectory::Resource\)/)
  assert.match(code, /runner\.start_carried\(c, model, app\.path\(\)\.app_data_dir\(\)\);/)
  assert.match(code, /let path = model\.filter\(\|p\| p\.is_file\(\)\)\?;/, 'no carried file, no runner')
  assert.match(code, /Ok\(dir\) => dir\.join\("models"\),/, 'the stamp in the app\'s data folder')
  assert.match(code, /gpu: Gpu::Off,/)
  assert.match(code, /threads: half_the_threads\(THREADS_CAP\),/)
  assert.match(code, /sampling: Sampling::Chat \{ seed: None \},/)
  // The plan is what the page asks for on a computer: its context, its answer's length, the integrated row's batch.
  const { CONTEXT_TOKENS, ANSWER_TOKENS } = await import('../09_Cognition/localCompute.ts')
  assert.match(code, new RegExp(`pub const N_CTX: u32 = ${CONTEXT_TOKENS};`))
  assert.match(code, new RegExp(`pub const MAX_TOKENS: u32 = ${ANSWER_TOKENS};`))
  assert.match(code, /pub const N_BATCH: u32 = 512;/)
  assert.match(code, /pub const THREADS_CAP: i32 = 8;/)
  // The installer's model is never lent where the app runs its own.
  const model = readFileSync(new URL('../../src-tauri/src/model.rs', import.meta.url), 'utf8')
  assert.match(model, /pub fn app_model\(app: AppHandle\) -> Option<AppModel> \{\n {4}if crate::runner::COMPILED \{\n {8}return None;\n {4}\}/)
  // The feature table: off by default, Linux only, the runner an optional dependency the lockfile still records.
  const cargo = readFileSync(new URL('../../src-tauri/Cargo.toml', import.meta.url), 'utf8')
  const features = /\n\[features\]\n([\s\S]*?)\n\[/.exec(cargo)?.[1] ?? ''
  assert.deepEqual(features.split('\n').filter((l) => l && !l.startsWith('#')), ['native-runner = ["dep:crimson-noir-llm"]', 'tiny-model = ["native-runner"]'], 'no default feature')
  assert.match(cargo, /\n\[target\.'cfg\(target_os = "linux"\)'\.dependencies\]\n(?:#.*\n)*crimson-noir-llm = \{ path = "\.\.\/native\/llm", optional = true \}\n/)
  assert.equal(cargo.split('crimson-noir-llm').length - 1, 2, 'named once as a dependency and once by its feature')
  const lock = readFileSync(new URL('../../src-tauri/Cargo.lock', import.meta.url), 'utf8')
  const app = /\[\[package\]\]\nname = "crimson-noir-app"[\s\S]*?dependencies = \[([^\]]*)\]/.exec(lock)
  assert.ok(app?.[1].includes('"crimson-noir-llm"'), 'the lockfile records the optional edge, so a --locked build with the feature needs no change')
  assert.match(lock, /\nname = "llama-cpp-2"\nversion = "0\.1\.161"\n/)
})

test('shellRunner: the runner\'s three commands over core.invoke, the request as { req, onEvent } with a channel of its own, every wire.json event handed through; null without invoke or Channel', async () => {
  const wire = JSON.parse(readFileSync(new URL('../../native/llm/tests/wire.json', import.meta.url), 'utf8')) as { request: GenRequest; events: unknown[]; done: unknown[]; models: { file: string; status: { state: string } }[] }
  class Bare { onmessage: (m: unknown) => void = () => {} }
  for (const g of [{}, { [SHELL_GLOBAL]: {} }, { [SHELL_GLOBAL]: { core: { invoke: async () => null } } }, { [SHELL_GLOBAL]: { core: { Channel: Bare } } }, { [SHELL_GLOBAL]: { core: { invoke: async () => null, Channel: 'x' } } }]) {
    assert.equal(shellRunner(g), null, JSON.stringify(g))
  }
  // Tauri's Channel serializes as its callback id, so the args are what Tauri would post; its end (the shell letting
  // the channel go) calls cleanupCallback after every message.
  let made = 0
  let ended = 0
  class Channel { readonly n = ++made; onmessage: (m: unknown) => void = () => {}; cleanupCallback() { ended++ } toJSON() { return `__CHANNEL__:${this.n}` } }
  const calls: [string, Record<string, unknown> | undefined][] = []
  const ready = wire.models.find((m) => m.status.state === 'ready')
  assert.ok(ready)
  const core = {
    Channel,
    invoke(this: unknown, command: string, args?: Record<string, unknown>): Promise<unknown> {
      assert.equal(this, core, 'invoked on core, as Tauri expects')
      calls.push([command, args])
      if (command === 'native_model') return Promise.resolve(ready)
      if (command === 'native_generate') {
        const channel = args?.onEvent as Channel
        for (const e of wire.events) channel.onmessage(e)
        channel.cleanupCallback()
        return Promise.resolve(wire.done[0])
      }
      return Promise.resolve(true)
    },
  }
  const host = shellRunner({ [SHELL_GLOBAL]: { core } })
  assert.ok(host)
  assert.deepEqual(await host.model(), ready)
  const got: unknown[] = []
  assert.deepEqual(await host.generate(wire.request, (e) => got.push(e)), wire.done[0])
  assert.deepEqual(got, wire.events, 'every event as the runner sent it')
  assert.equal(ended, 1, 'Tauri\'s own cleanup still runs at the end')
  assert.equal(await host.stop(42), true)
  assert.deepEqual(calls.map(([c, a]) => [c, a === undefined ? 'none' : Object.keys(a)]), [['native_model', 'none'], ['native_generate', ['req', 'onEvent']], ['native_stop', ['id']]])
  const gen = calls[1][1]
  assert.equal(gen?.req, wire.request, 'the request under req as given, never spread beside the channel')
  assert.ok(gen?.onEvent instanceof Channel)
  assert.equal(JSON.stringify(gen), JSON.stringify({ req: wire.request, onEvent: '__CHANNEL__:1' }))
  assert.deepEqual(calls[2][1], { id: 42 })
  // Through the page's own mind: a channel per answer, and the request exactly the runner's shape.
  const mind = createNativeMind({ host, maxTokens: () => 512 })
  assert.deepEqual(await mind.installed(), [ready.file])
  const a = await mind.answer({ tethers: [], prompt: 'Say hi.', signal: new AbortController().signal, talk: true }, () => {})
  assert.equal(a.text, 'Hello')
  assert.equal(made, 2)
  const sent = calls.at(-1)?.[1]
  assert.deepEqual(Object.keys(sent ?? {}), ['req', 'onEvent'])
  const req = sent?.req as GenRequest
  assert.deepEqual(Object.keys(req).sort(), Object.keys(wire.request).sort())
  assert.deepEqual([req.messages.map((m) => m.role), req.messages[1].content, req.maxTokens, req.think], [['system', 'user'], 'Say hi.', 512, false])
})

test('shellRunner: an answer settles only once its channel has ended, every message handed over first (the reply can overtake them), or after DRAIN_MS with no end', async () => {
  const wire = JSON.parse(readFileSync(new URL('../../native/llm/tests/wire.json', import.meta.url), 'utf8')) as { request: GenRequest; done: unknown[]; errors: unknown[] }
  assert.equal(DRAIN_MS, 1000)
  let channel!: { onmessage: (m: unknown) => void; cleanupCallback(): void }
  let cleaned = 0
  let reply: () => Promise<unknown> = async () => wire.done[0]
  class Channel { onmessage: (m: unknown) => void = () => {}; cleanupCallback() { cleaned++ } }
  const core = {
    Channel,
    invoke: (command: string, args?: Record<string, unknown>): Promise<unknown> => {
      if (command !== 'native_generate') return Promise.resolve(null)
      channel = args?.onEvent as Channel
      return reply()
    },
  }
  const host = shellRunner({ [SHELL_GLOBAL]: { core } })
  assert.ok(host)
  const later = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  // The reply first, then the last message and the end, as the ipc fetch can deliver them.
  const got: unknown[] = []
  let settled = false
  const p = host.generate(wire.request, (e) => got.push(e)).then((d) => { settled = true; return d })
  await later(20)
  assert.equal(settled, false, 'the reply alone does not settle it')
  channel.onmessage({ kind: 'text', text: 'the tail' })
  channel.cleanupCallback()
  assert.deepEqual(await p, wire.done[0])
  assert.deepEqual(got, [{ kind: 'text', text: 'the tail' }], 'the last message reached the answer before it settled')
  assert.equal(cleaned, 1, 'Tauri\'s own cleanup still runs')
  // A refusal waits for the end too.
  reply = async () => { throw wire.errors[2] }
  let refused = false
  const q = host.generate(wire.request, () => {}).catch((e: unknown) => { refused = true; return e })
  await later(20)
  assert.equal(refused, false)
  channel.cleanupCallback()
  assert.equal(await q, wire.errors[2])
  // A shell that never ends the channel: the reply is taken after DRAIN_MS.
  reply = async () => wire.done[0]
  const t0 = Date.now()
  assert.deepEqual(await host.generate(wire.request, () => {}), wire.done[0])
  assert.ok(Date.now() - t0 >= DRAIN_MS - 20, `${Date.now() - t0} ms`)
})
