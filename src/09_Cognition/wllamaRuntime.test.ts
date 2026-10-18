// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the in-page runtime's adapter (wllamaRuntime.ts) over a fake
 * wllama that behaves as the spike saw the real one behave in Chromium:
 * - the pinned module reaches wllama as a page-made blob: URL only when its gzip unpacks to the pinned length and
 *   sha256 (the committed module too), with the page's own sha256 where the platform has no digest;
 * - each load makes a fresh instance with a cache that keeps nothing, its compatibility build off before anything else,
 *   the placement as wllama's load options (no reasoning at load), the files in the mind's order, and a logger that
 *   works unbound and keeps 200 lines;
 * - a load that resolves although llama.cpp refused the file (success false) is 'model' in llama.cpp's own words; a
 *   damaged module that aborts is 'server' at once; one that never says it started is 'timeout' at the start
 *   watchdog; one that started is held only to the whole load's; a stop, a failed file read and the worker's error
 *   event settle a load that would never settle; a second load lets the first go (wllama's "Module is already
 *   initialized" never happens); where the weights landed is read off the load's report;
 * - an answer maps the stream (the role-only chunk is nothing; text, thinking, progress), counts tokens from the
 *   stream's timings (it carries no usage); a stop settles it at once, the chunks still delivered after it are
 *   dropped and the model stays loaded, unless wllama's call never settles (then the instance goes); exit() leaving
 *   wllama's call pending forever, the two quiet watchdogs, a runtime error and an abort line all settle it and let the
 *   instance go; a prompt too long for the context is 'model' and the instance answers again; errors are told apart
 *   by class and type, never by name;
 * - unload settles even when exit never does, and every path above settles.
 * What breaks if it is removed? A change to the adapter could leave an answer or a load hanging, ship a damaged
 * runtime, or let wllama keep or fetch something of its own, and no test would go red.
 */
import assert from 'node:assert/strict'
import { resolveObjectURL } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import type { ChatChunk, ChatOptions, LoadOptions } from './inPage.ts'
import { probe } from './inPageCaps.ts'
import { CognitionError } from './localCompute.ts'
import { createWllamaRuntime, EXIT_MS, LOG_LINES, STOP_MS, wasmBlobUrl, type WllamaChatParams, type WllamaInstance, type WllamaLib, type WllamaLoadParams, type WllamaLogger, type WllamaStorage } from './wllamaRuntime.ts'

const PIN_DIR = new URL('../../third_party/wllama/3.8.1/', import.meta.url)
const DAMAGED = 'the in-page runtime in this file is damaged'

/** wllama's WllamaError: its name stays "Error" (spike 8), only `type` tells them apart. */
class FakeWllamaError extends Error {
  type: string
  constructor(message: string, type = 'unknown_error') {
    super(message)
    this.type = type
  }
}
/** wllama's WllamaAbortError: named "AbortError", not a WllamaError. */
class FakeAbortError extends Error {
  override name = 'AbortError'
  constructor() {
    super('Operation aborted')
  }
}
/** wllama's WllamaRuntimeError. */
class FakeRuntimeError extends Error {
  override name = 'RuntimeError'
}

/** A turn of the event loop, as a worker's message takes. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
/** Never settles: what wllama does after exit(), or with a damaged module. */
const never = <T>(): Promise<T> => new Promise<T>(() => {})

/** The lines llama.cpp logs for a file that is not a GGUF (spike, iso-errors). */
const NOT_GGUF_LINES = [
  "gguf_init_from_reader: invalid magic characters: 'this', expected 'GGUF'",
  'llama_model_load: error loading model: llama_model_loader: failed to load model from models/model-00001-of-00001.gguf',
  'llama_model_load_from_file_impl: failed to load model',
  "cmn  common_init_: failed to load model 'models/model-00001-of-00001.gguf'",
  "srv    load_model: failed to load model, 'models/model-00001-of-00001.gguf'",
]
/** And for a truncated one. */
const TRUNCATED_LINES = [
  "llama_model_load: error loading model: tensor 'blk.0.ffn_up.weight' data is not within the file bounds, model is corrupted or incomplete",
  'llama_model_load_from_file_impl: failed to load model',
  "srv    load_model: failed to load model, 'models/model-00001-of-00001.gguf'",
]
const CPU_REPORT = ['load_tensors:          CPU model buffer size =     0.14 MiB']

interface FakeInstance extends WllamaInstance {
  readonly id: number
  readonly paths: { default: string }
  readonly config: { cacheManager?: object; suppressNativeLog?: boolean; logger?: WllamaLogger }
  readonly logger: WllamaLogger
  compat: unknown
  proxy: boolean
  info: Record<string, unknown> | null
  /** exit() was called: the worker is terminated, so a call in flight never settles. */
  dead: boolean
  exits: number
  loads: { blobs: Blob[]; params: WllamaLoadParams }[]
  chats: WllamaChatParams[]
}

/** The logger lines wllama itself writes for a module that started and a model that loaded (wllama.ts loadModel). */
async function started(w: FakeInstance, report: readonly string[] = CPU_REPORT): Promise<void> {
  await tick()
  w.logger.debug('Calling wllamaStart...')
  await tick()
  w.logger.debug('Loading model...')
  // llama.cpp's INFO lines reach the logger as debug (wllama's worker maps INFO to console.debug).
  for (const line of report) w.logger.debug(line)
}

/** The stream llama.cpp's server writes for an answer of `pieces` (spike: the role-only chunk, then one per token, then finish and timings). */
function chunks(pieces: readonly string[], end: { finish?: string | null; timings?: object | null; usage?: object | null } = {}): object[] {
  const finish = end.finish === undefined ? 'length' : end.finish
  const timings = end.timings === undefined ? { cache_n: 0, prompt_n: 114, predicted_n: pieces.length } : end.timings
  const out: object[] = [{ choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] }]
  out.push({ choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }], prompt_progress: { total: 114, cache: 0, processed: 114, time_ms: 8 } })
  for (const p of pieces) out.push({ choices: [{ index: 0, delta: { content: p }, finish_reason: null }] })
  const last: Record<string, unknown> = { choices: [{ index: 0, delta: {}, finish_reason: finish }] }
  if (timings) last.timings = timings
  if (end.usage) last.usage = end.usage
  out.push(last)
  return out
}

/**
 * Streams `list` to `p.onData` a turn apart, as wllama's getResponse does: it checks the signal before each step and
 * throws its abort error then, after delivering `late` more chunks (spike: at least one arrives after abort()); a call
 * whose instance was exited never settles.
 */
async function stream(w: FakeInstance, p: WllamaChatParams, list: readonly object[], late = 1): Promise<void> {
  let after = late
  for (const c of list) {
    await tick()
    if (w.dead) return never()
    if (p.abortSignal.aborted) {
      if (after-- > 0) {
        p.onData(c)
        continue
      }
      throw new FakeAbortError()
    }
    p.onData(c)
  }
  if (p.abortSignal.aborted) throw new FakeAbortError()
}

/**
 * A fake wllama module and everything done with it. `onLoad` and `onChat` say what a load and an answer do (by
 * default: a model that loads on the processor, and an answer of max_tokens "a"s). With `shared`, the constructor
 * returns one instance every time, so a second load without exit() meets "Module is already initialized".
 */
function fakeWllama() {
  let n = 0
  const world = {
    made: [] as FakeInstance[],
    events: [] as string[],
    backends: [] as WllamaStorage[][],
    shared: false,
    exitHangs: false,
    onLoad: async (w: FakeInstance): Promise<void> => {
      await started(w)
      w.info = { success: true, n_vocab: 259 }
    },
    onChat: (w: FakeInstance, p: WllamaChatParams): Promise<void> => stream(w, p, chunks(Array.from({ length: p.max_tokens }, () => 'a'))),
  }
  class CacheManager {
    readonly backends: WllamaStorage[]
    constructor(backends: WllamaStorage[]) {
      this.backends = backends
      world.backends.push(backends)
      // wllama's constructor asks each backend whether it is supported (spike: the only call NO_STORAGE ever sees).
      if (!backends.some((b) => b.isSupported())) throw new Error('No supported storage backend found')
    }
  }
  class Wllama implements FakeInstance {
    readonly id: number = 0
    readonly paths: { default: string } = { default: '' }
    readonly config: FakeInstance['config'] = {}
    readonly logger: WllamaLogger = console
    compat: unknown = null
    proxy = false
    info: Record<string, unknown> | null = null
    dead = false
    exits = 0
    loads: FakeInstance['loads'] = []
    chats: WllamaChatParams[] = []
    constructor(paths: { default: string }, config: FakeInstance['config']) {
      if (world.shared && world.made.length) {
        world.events.push(`new #${world.made[0].id} (the same)`)
        return world.made[0] as Wllama
      }
      this.id = ++n
      this.paths = paths
      this.config = config
      this.logger = config.logger ?? console
      // The real constructor points the compatibility build at a CDN.
      this.compat = { worker: 'cdn', wasm: 'cdn' }
      world.made.push(this)
      world.events.push(`new #${this.id}`)
    }
    setCompat(compat: null): void {
      world.events.push(`setCompat ${String(compat)} #${this.id}`)
      this.compat = compat
    }
    async loadModel(blobs: Blob[], params: WllamaLoadParams): Promise<void> {
      world.events.push(`load #${this.id}`)
      this.loads.push({ blobs, params })
      if (blobs.some((b) => b.size === 0)) throw new FakeWllamaError('Input model (or splits) must be non-empty Blob or File', 'load_error')
      if (this.proxy) throw new FakeWllamaError('Module is already initialized', 'load_error')
      this.proxy = true
      this.dead = false
      this.logger.debug('Multithread enabled: false, pthreadPoolSize: 0')
      await world.onLoad(this)
    }
    getLoadedContextInfo(): object {
      if (!this.proxy || this.info === null) throw new FakeWllamaError('loadModel() is not yet called', 'model_not_loaded')
      return { ...this.info }
    }
    async createChatCompletion(p: WllamaChatParams): Promise<unknown> {
      if (!this.proxy || this.info === null) throw new FakeWllamaError('loadModel() is not yet called', 'model_not_loaded')
      this.chats.push(p)
      await world.onChat(this, p)
      return undefined
    }
    exit(): Promise<void> {
      world.events.push(`exit #${this.id}`)
      this.exits++
      this.proxy = false
      this.info = null
      this.dead = true
      return world.exitHangs ? never() : Promise.resolve()
    }
  }
  const lib: WllamaLib = { Wllama, CacheManager, WllamaError: FakeWllamaError, WllamaAbortError: FakeAbortError, WllamaRuntimeError: FakeRuntimeError }
  return { world, lib }
}

const URL_OF_RUNTIME = 'blob:http://127.0.0.1/runtime-module'
/** Every test settles well within this; one that hangs fails here instead of holding the suite. */
const SETTLES = { timeout: 15_000 }

function setup() {
  const { world, lib } = fakeWllama()
  const calls = { lib: 0, wasm: 0 }
  const runtime = createWllamaRuntime({
    lib: async () => { calls.lib++; return lib },
    wasm: async () => { calls.wasm++; return URL_OF_RUNTIME },
  })
  return { world, runtime, calls }
}

const loadOptions = (o: Partial<LoadOptions> = {}): LoadOptions => ({ ctx: 512, threads: 1, gpu: false, warmup: false, signal: new AbortController().signal, startMs: 5_000, loadMs: 10_000, ...o })
const MODEL = [new File([new Uint8Array(64).fill(7)], 'tiny-a.gguf')]

function chatOptions(o: Partial<ChatOptions> = {}): ChatOptions & { got: ChatChunk[] } {
  const got: ChatChunk[] = []
  return { signal: new AbortController().signal, maxTokens: 16, think: false, firstMs: 5_000, stallMs: 5_000, onChunk: (c) => { got.push(c) }, got, ...o }
}
const MESSAGES = [{ role: 'system' as const, content: 'You are a test.' }, { role: 'user' as const, content: 'Say hi.' }]

/** The rejection of `p` (which must reject), and how long it took. */
async function rejection(p: Promise<unknown>): Promise<{ error: unknown; ms: number }> {
  const t = Date.now()
  try {
    await p
  } catch (error) {
    return { error, ms: Date.now() - t }
  }
  assert.fail('expected a rejection')
}
function isCognition(e: unknown, code: string, message?: RegExp | string): asserts e is CognitionError {
  assert.ok(e instanceof CognitionError, `a CognitionError, not ${String(e)}`)
  assert.equal(e.code, code, e.message)
  if (typeof message === 'string') assert.equal(e.message, message)
  else if (message) assert.match(e.message, message)
}

// ---------------------------------------------------------------------------------------------------------------
// The runtime module

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64')
const MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...Array.from({ length: 300 }, (_, i) => i % 251)])

async function blobBytes(url: string): Promise<{ type: string; bytes: Uint8Array }> {
  const blob = resolveObjectURL(url)
  assert.ok(blob, `${url} is a blob this page made`)
  return { type: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) }
}

test('the runtime module reaches wllama as a page-made blob: URL once its gzip unpacks to the pinned length and sha256', SETTLES, async () => {
  const pin = { default: b64(gzipSync(MODULE)), sha256: sha(MODULE), bytes: MODULE.length }
  for (const subtle of [undefined, null, { digest: () => Promise.reject(new Error('not a secure context')) }]) {
    // The platform's digest, none at all, and one that refuses: integrity.ts sha256 stands in for the last two.
    const url = await wasmBlobUrl(pin, subtle)
    assert.match(url, /^blob:/)
    assert.doesNotMatch(url, /^data:/)
    const got = await blobBytes(url)
    assert.equal(got.type, 'application/wasm')
    assert.deepEqual(got.bytes, MODULE)
  }
  const wrong = [
    { ...pin, sha256: sha(new Uint8Array([1])) },
    { ...pin, bytes: MODULE.length + 1 },
    { ...pin, default: b64(MODULE) }, // not a gzip
    { ...pin, default: b64(gzipSync(MODULE.slice(0, -1))) },
    { ...pin, default: '%%% not base64 %%%' },
  ]
  for (const p of wrong) for (const subtle of [undefined, null]) isCognition((await rejection(wasmBlobUrl(p, subtle))).error, 'server', DAMAGED)
})

test('the committed pin unpacks to the module SHA256SUMS names, and one flipped byte of its gzip is refused as damaged', SETTLES, async () => {
  const gz = readFileSync(new URL('wllama.wasm.gz', PIN_DIR))
  const sums = readFileSync(new URL('SHA256SUMS', PIN_DIR), 'utf8')
  const sum = /^([0-9a-f]{64}) {2}wllama\.wasm$/m.exec(sums)?.[1]
  assert.ok(sum)
  const raw = new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
  const pin = { default: b64(gz), sha256: sum, bytes: raw.length }
  const got = await blobBytes(await wasmBlobUrl(pin))
  assert.equal(got.bytes.length, pin.bytes)
  assert.equal(sha(got.bytes), sum)
  const flipped = new Uint8Array(gz)
  flipped[Math.floor(flipped.length / 2)] ^= 0xff
  isCognition((await rejection(wasmBlobUrl({ ...pin, default: b64(flipped) }))).error, 'server', DAMAGED)
})

test('a damaged runtime module fails the load as server before any wllama is made, and the next load prepares it again', SETTLES, async () => {
  const { world, lib } = fakeWllama()
  let tries = 0
  const runtime = createWllamaRuntime({
    lib: async () => lib,
    wasm: async () => {
      tries++
      if (tries === 1) throw new CognitionError('server', DAMAGED)
      return URL_OF_RUNTIME
    },
  })
  isCognition((await rejection(runtime.load(MODEL, loadOptions()))).error, 'server', DAMAGED)
  assert.deepEqual(world.events, [], 'no wllama was made')
  await runtime.load(MODEL, loadOptions())
  assert.equal(tries, 2)
})

// ---------------------------------------------------------------------------------------------------------------
// Loading

test('a load makes a fresh wllama with a cache that keeps nothing, switches its compatibility build off first, and hands it the placement and the files in order', SETTLES, async () => {
  const { world, runtime, calls } = setup()
  const files = [new File([new Uint8Array(10)], 'm-00002-of-00002.gguf'), new File([new Uint8Array(10)], 'm-00001-of-00002.gguf')]
  const r = await runtime.load(files, loadOptions({ ctx: 4096, threads: 2 }))
  assert.equal(r.gpu, false)
  assert.ok(r.ms >= 0)
  assert.equal(runtime.loaded(), true)
  assert.deepEqual(world.events, ['new #1', 'setCompat null #1', 'load #1'], 'nothing is asked of wllama before its compatibility build is off')
  const w = world.made[0]
  assert.equal(w.compat, null)
  assert.deepEqual(w.paths, { default: URL_OF_RUNTIME })
  assert.equal(w.config.suppressNativeLog, false, 'native lines reach the logger: the abort line and llama.cpp\'s reasons are among them')
  // The cache: one backend that keeps nothing, made by the same module and handed to its constructor.
  assert.equal(world.backends.length, 1)
  const [backend] = world.backends[0]
  assert.ok(w.config.cacheManager instanceof Object && (w.config.cacheManager as { backends?: unknown }).backends === world.backends[0])
  assert.equal(backend.isSupported(), true)
  assert.equal(await backend.read('k'), null)
  assert.equal(await backend.getSize('k'), -1)
  assert.deepEqual(await backend.list(), [])
  assert.equal(await backend.delete('k'), undefined)
  await assert.rejects(backend.write('k', new Blob(['x']).stream()), /keeps no files/)
  // The placement, as wllama's load options: one sequence, unified KV, jinja, no reasoning at load, the processor.
  const { blobs, params } = w.loads[0]
  assert.deepEqual(params, { n_ctx: 4096, n_threads: 2, n_gpu_layers: 0, n_parallel: 1, kv_unified: true, jinja: true, warmup: false, log_level: 2 })
  assert.ok(!('reasoning' in params))
  assert.equal(blobs.length, 2)
  assert.ok(blobs[0] === files[0] && blobs[1] === files[1], 'the files in the order given')
  assert.notEqual(blobs, files, 'a copy of the list')
  assert.deepEqual(calls, { lib: 1, wasm: 1 })

  // Batch sizes when the placement has them; the GPU by leaving n_gpu_layers out (wllama's default offloads every layer).
  await runtime.load(MODEL, loadOptions({ gpu: true, batch: 256, ubatch: 128, warmup: true }))
  assert.deepEqual(world.made[1].loads[0].params, { n_ctx: 512, n_threads: 1, n_batch: 256, n_ubatch: 128, n_parallel: 1, kv_unified: true, jinja: true, warmup: true, log_level: 2 })
  assert.deepEqual(calls, { lib: 1, wasm: 1 }, 'the module is imported and the runtime prepared once')
  assert.deepEqual(world.events.slice(3), ['exit #1', 'new #2', 'setCompat null #2', 'load #2'], 'the first instance goes before the second is made')
})

test('the logger works unbound and keeps the last 200 lines, each on one line', SETTLES, async () => {
  const { world, runtime } = setup()
  await runtime.load(MODEL, loadOptions())
  const { debug, log, warn, error } = world.made[0].logger
  error('one', new Error('two'))
  warn({ message: 'x'.repeat(500) })
  log('a\n  stack line\nanother')
  debug(Object.assign(new Event('message'), { data: 1 }))
  const lines = runtime.log()
  assert.ok(lines.includes('error: one Error: two'))
  assert.ok(lines.some((l) => l.startsWith('warn: {"message":"xxxx') && l.length < 260), 'a long string is cut')
  assert.ok(lines.includes('log: a | stack line | another'))
  assert.ok(lines.includes('debug: Calling wllamaStart...'))
  for (let i = 0; i < 250; i++) debug(`line ${i}`)
  const after = runtime.log()
  assert.equal(after.length, LOG_LINES)
  assert.equal(after.at(-1), 'debug: line 249')
  assert.equal(after[0], 'debug: line 50')
  assert.equal(runtime.loaded(), true, 'none of these lines is a sign the worker went')
})

test('a file llama.cpp cannot read resolves the load with success false: the instance goes and the load is model, in llama.cpp\'s own words', SETTLES, async () => {
  for (const [lines, said] of [
    [NOT_GGUF_LINES, "this is not a model llama.cpp can read: invalid magic characters: 'this', expected 'GGUF'"],
    [TRUNCATED_LINES, "this is not a model llama.cpp can read: tensor 'blk.0.ffn_up.weight' data is not within the file bounds, model is corrupted or incomplete"],
    [["srv    load_model: failed to load model, 'models/model-00001-of-00001.gguf'"], "this is not a model llama.cpp can read: failed to load model, 'models/model-00001-of-00001.gguf'"],
    [[], 'this is not a model llama.cpp can read (it gave no reason)'],
    // A good file whose context's cache does not fit the page's 4 GiB (Chromium 141, the real runtime: n_ctx 30,000,000).
    [[
      'ggml_aligned_malloc: insufficient memory (attempted to allocate 7324.25 MB)',
      'ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 7680032768',
      'ggml_backend_buft_alloc_buffer_n_default: failed to allocate CPU buffer of size 7680032768',
      'llama_init_from_model: failed to initialize the context: failed to allocate buffer for kv cache',
      "cmn  common_init_: failed to create context with model 'models/model-00001-of-00001.gguf'",
      "srv    load_model: failed to create_context with model 'models/model-00001-of-00001.gguf'",
    ], "the model and its context do not fit in this page's memory (llama.cpp asked for 7324.25 MB and was refused): a smaller model, or a smaller quantization of this one, may"],
    // Weights too large for it, with no size given.
    [['llama_model_load: error loading model: unable to allocate CPU buffer', 'llama_model_load_from_file_impl: failed to load model'],
      "the model does not fit in this page's memory: a smaller model, or a smaller quantization of this one, may"],
  ] as const) {
    const { world, runtime } = setup()
    world.onLoad = async (w) => {
      await started(w, [])
      for (const l of lines) w.logger.error(l)
      // wllama resolves and isModelLoaded() is true: only success (not in its types) says the load failed.
      w.info = { success: false, n_vocab: 0 }
    }
    const { error, ms } = await rejection(runtime.load(MODEL, loadOptions()))
    isCognition(error, 'model', said)
    assert.ok(ms < 1000)
    assert.equal(world.made[0].exits, 1, 'the instance went')
    assert.equal(runtime.loaded(), false)
  }
})

test('a damaged runtime that aborts settles the load at once as server, at every log level, long before the start watchdog', SETTLES, async () => {
  for (const level of ['log', 'debug', 'warn', 'error'] as const) {
    const { world, runtime } = setup()
    world.onLoad = async (w) => {
      await tick()
      w.logger.log('wasm streaming compile failed: CompileError: WebAssembly.instantiateStreaming(): expected magic word 00 61 73 6d, found 00 00 00 00 @+0')
      w.logger[level]('Aborted(CompileError: WebAssembly.instantiate(): expected magic word 00 61 73 6d, found 00 00 00 00 @+0)')
      // The real load never settles after this (spike: an unhandled TypeError in wllama, and no rejection).
      return never()
    }
    const { error, ms } = await rejection(runtime.load(MODEL, loadOptions({ startMs: 10_000 })))
    isCognition(error, 'server', /^the in-page runtime stopped \(Aborted\(CompileError: WebAssembly\.instantiate\(\): expected magic word/)
    assert.ok(ms < 1000, `${ms} ms`)
    assert.equal(world.made[0].exits, 1)
    assert.equal(runtime.loaded(), false)
  }
})

test('a runtime that never says it started is given up at the start watchdog as timeout; one that started is held only to the whole load\'s', SETTLES, async () => {
  {
    const { world, runtime } = setup()
    world.onLoad = async (w) => {
      w.logger.debug('Loading "wllama.wasm" from "blob:..."')
      return never()
    }
    const { error, ms } = await rejection(runtime.load(MODEL, loadOptions({ startMs: 60, loadMs: 10_000 })))
    isCognition(error, 'timeout', 'the in-page runtime did not start within 60 ms')
    assert.ok(ms >= 50 && ms < 1000, `${ms} ms`)
    assert.equal(world.made[0].exits, 1)
  }
  {
    const { world, runtime } = setup()
    world.onLoad = async (w) => {
      await started(w, [])
      return never()
    }
    const { error, ms } = await rejection(runtime.load(MODEL, loadOptions({ startMs: 30, loadMs: 200 })))
    isCognition(error, 'timeout', 'the model did not finish loading in 200 ms')
    assert.ok(ms >= 180, `${ms} ms: the start watchdog was cleared once the module started`)
    assert.equal(world.made[0].exits, 1)
  }
})

test('the operator\'s stop settles a load that would never settle, with the signal\'s own reason, and lets the instance go', SETTLES, async () => {
  const { world, runtime } = setup()
  world.onLoad = () => never()
  const stop = new AbortController()
  const why = new DOMException('the operator stopped it', 'AbortError')
  setTimeout(() => stop.abort(why), 20)
  const { error, ms } = await rejection(runtime.load(MODEL, loadOptions({ signal: stop.signal })))
  assert.equal(error, why)
  assert.ok(ms < 1000)
  assert.equal(world.made[0].exits, 1)
  // A signal stopped before the load makes nothing.
  const before = world.events.length
  assert.equal((await rejection(runtime.load(MODEL, loadOptions({ signal: AbortSignal.abort(why) })))).error, why)
  assert.deepEqual(world.events.slice(before), [])
})

test('a load lets whatever is loaded or half loaded go first, so wllama\'s "Module is already initialized" never happens', SETTLES, async () => {
  const { world, runtime } = setup()
  // One instance for every construction: a second loadModel without exit() throws, as wllama's does.
  world.shared = true
  await runtime.load(MODEL, loadOptions())
  await runtime.load(MODEL, loadOptions())
  // Half loaded: a load stopped mid-way leaves wllama's proxy set until exit().
  world.onLoad = () => never()
  const stop = new AbortController()
  setTimeout(() => stop.abort(), 10)
  await rejection(runtime.load(MODEL, loadOptions({ signal: stop.signal })))
  world.onLoad = async (w) => {
    await started(w)
    w.info = { success: true }
  }
  await runtime.load(MODEL, loadOptions())
  assert.equal(runtime.loaded(), true)
  const loadsAndExits = world.events.filter((e) => /^(load|exit)/.test(e))
  assert.deepEqual(loadsAndExits, ['load #1', 'exit #1', 'load #1', 'exit #1', 'load #1', 'exit #1', 'load #1'])
})

test('a failed file read, the worker\'s error event and an empty file each settle the load', SETTLES, async () => {
  {
    const { world, runtime } = setup()
    world.onLoad = async (w) => {
      await started(w, [])
      // wllama logs this, terminates the worker and rejects what was waiting (worker.ts fileReadResponse).
      w.logger.error('fileReadResponse failed, terminating worker:', new Error('the file is gone'))
      throw new FakeRuntimeError('File read failed: Error: the file is gone')
    }
    isCognition((await rejection(runtime.load(MODEL, loadOptions()))).error, 'server', /^the in-page runtime could not read the model file \(fileReadResponse failed, terminating worker: Error: the file is gone\)$/)
    assert.equal(world.made[0].exits, 1)
  }
  {
    const { world, runtime } = setup()
    world.onLoad = async (w) => {
      await tick()
      // wllama hands its worker's onerror the logger's error function, unbound.
      const onerror = w.logger.error
      onerror(Object.assign(new Event('error'), { message: 'Uncaught RangeError: WebAssembly.Memory(): could not allocate memory' }))
      return never()
    }
    const { error, ms } = await rejection(runtime.load(MODEL, loadOptions()))
    isCognition(error, 'server', /^the in-page runtime's worker failed \(the worker failed: Uncaught RangeError: WebAssembly\.Memory\(\): could not allocate memory\)$/)
    assert.ok(ms < 1000)
  }
  {
    const { world, runtime } = setup()
    isCognition((await rejection(runtime.load([new Blob([])], loadOptions()))).error, 'model', 'the in-page runtime refused the file: Input model (or splits) must be non-empty Blob or File')
    assert.equal(world.made[0].exits, 1)
  }
  {
    // A load that rejects with a runtime error without a word in the log.
    const { world, runtime } = setup()
    world.onLoad = async () => { throw new FakeRuntimeError('(ABORT) ') }
    isCognition((await rejection(runtime.load(MODEL, loadOptions()))).error, 'server', 'the in-page runtime stopped while it was loading the model ((ABORT))')
  }
})

test('where the weights landed is read off the load\'s report', SETTLES, async () => {
  const cases: [readonly string[], boolean, boolean][] = [
    [CPU_REPORT, true, false], // asked for the GPU, run on the processor (SwiftShader has no shader-f16)
    [['load_tensors: offloaded 3/3 layers to GPU', 'load_tensors:          CPU model buffer size =     0.01 MiB', 'load_tensors:       WebGPU model buffer size =     0.13 MiB'], true, true],
    [['load_tensors: offloaded 3/3 layers to GPU'], true, true],
    [['load_tensors: offloaded 0/3 layers to GPU'], true, false],
    [[], true, true], // no report: as asked
    [['load_tensors:       WebGPU model buffer size =     0.13 MiB'], false, false], // asked for the processor: n_gpu_layers 0
  ]
  for (const [report, gpu, landed] of cases) {
    const { world, runtime } = setup()
    world.onLoad = async (w) => {
      await started(w, report)
      w.info = { success: true }
    }
    const r = await runtime.load(MODEL, loadOptions({ gpu }))
    assert.equal(r.gpu, landed, `${report.join(' / ')} asked ${gpu}`)
    assert.equal('n_gpu_layers' in world.made[0].loads[0].params, !gpu)
  }
})

// ---------------------------------------------------------------------------------------------------------------
// Answering

async function loaded() {
  const s = setup()
  await s.runtime.load(MODEL, loadOptions())
  return { ...s, w: s.world.made[0] }
}

test('an answer streams text, thinking and the prompt\'s progress, and counts tokens from the stream\'s timings (a stream carries no usage)', SETTLES, async () => {
  const { world, runtime, w } = await loaded()
  world.onChat = (inst, p) => stream(inst, p, [
    { choices: [{ delta: { role: 'assistant', content: null }, finish_reason: null }] },
    { choices: [{ delta: { role: 'assistant', content: null }, finish_reason: null }], prompt_progress: { total: 114, cache: 0, processed: 57, time_ms: 4 } },
    { choices: [{ delta: { reasoning_content: 'hmm' }, finish_reason: null }] },
    { choices: [{ delta: { reasoning: 'so' }, finish_reason: null }] },
    { choices: [{ delta: { content: 'a' }, finish_reason: null }] },
    { choices: [{ delta: { content: '' }, finish_reason: null }] },
    { choices: [{ delta: { content: 'b' }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'length' }], timings: { predicted_n: 2, prompt_n: 114 } },
  ])
  const o = chatOptions({ maxTokens: 2, think: true })
  const r = await runtime.chat(MESSAGES, o)
  assert.deepEqual(r, { reason: 'length', tokens: 2 })
  assert.deepEqual(o.got, [{ progress: { processed: 57, total: 114 } }, { thinking: 'hmm' }, { thinking: 'so' }, { text: 'a' }, { text: 'b' }])
  const p = w.chats[0]
  assert.deepEqual(p.messages, MESSAGES)
  assert.notEqual(p.messages, MESSAGES)
  assert.equal(p.stream, true)
  assert.equal(p.max_tokens, 2)
  assert.deepEqual(p.chat_template_kwargs, { enable_thinking: true })
  assert.equal(p.return_progress, true)
  assert.ok(p.abortSignal instanceof AbortSignal && !p.abortSignal.aborted)
  // The default answer: max_tokens "a"s, reason length, the count from timings.
  world.onChat = (inst, q) => stream(inst, q, chunks(Array.from({ length: q.max_tokens }, () => 'a')))
  const o2 = chatOptions({ maxTokens: 16 })
  assert.deepEqual(await runtime.chat(MESSAGES, o2), { reason: 'length', tokens: 16 })
  assert.equal(o2.got.filter((c) => c.text).map((c) => c.text).join(''), 'a'.repeat(16))
  assert.deepEqual(w.chats[1].chat_template_kwargs, { enable_thinking: false })
})

test('the token count falls back to usage and then to none, and the reason to stop', SETTLES, async () => {
  const { world, runtime } = await loaded()
  world.onChat = (w, p) => stream(w, p, chunks(['x', 'y'], { finish: 'stop', timings: null, usage: { completion_tokens: 7 } }))
  assert.deepEqual(await runtime.chat(MESSAGES, chatOptions()), { reason: 'stop', tokens: 7 })
  world.onChat = (w, p) => stream(w, p, chunks(['x', 'y'], { finish: null, timings: null }))
  assert.deepEqual(await runtime.chat(MESSAGES, chatOptions()), { reason: 'stop', tokens: null })
  // Both: llama.cpp's own count of what it predicted comes first.
  world.onChat = (w, p) => stream(w, p, chunks(['x', 'y'], { timings: { predicted_n: 2 }, usage: { completion_tokens: 9 } }))
  assert.deepEqual(await runtime.chat(MESSAGES, chatOptions()), { reason: 'length', tokens: 2 })
})

test('a stop mid-answer settles it at once with the signal\'s reason, drops the chunks still delivered after it, and keeps the model for the next answer', SETTLES, async () => {
  const { world, runtime, w } = await loaded()
  const stop = new AbortController()
  const why = new DOMException('the operator stopped the answer', 'AbortError')
  const o = chatOptions({ signal: stop.signal, maxTokens: 300, onChunk: (c) => { o.got.push(c); if (o.got.filter((g) => g.text).length === 3) stop.abort(why) } })
  world.onChat = (inst, p) => stream(inst, p, chunks(Array.from({ length: p.max_tokens }, () => 'a')), 3)
  const { error, ms } = await rejection(runtime.chat(MESSAGES, o))
  assert.equal(error, why)
  assert.ok(ms < 1000)
  await sleep(20)
  assert.equal(o.got.filter((c) => c.text).length, 3, 'nothing after the stop reached the caller')
  assert.equal(w.chats[0].abortSignal.aborted, true, 'wllama was asked to stop')
  assert.equal(w.exits, 0, 'the model stays loaded')
  assert.equal(runtime.loaded(), true)
  // A stop from a timer, outside the stream.
  const stop2 = new AbortController()
  world.onChat = (inst, p) => stream(inst, p, chunks(Array.from({ length: p.max_tokens }, () => 'a')))
  setTimeout(() => stop2.abort(why), 5)
  assert.equal((await rejection(runtime.chat(MESSAGES, chatOptions({ signal: stop2.signal, maxTokens: 100_000 })))).error, why)
  const o3 = chatOptions({ maxTokens: 4 })
  assert.deepEqual(await runtime.chat(MESSAGES, o3), { reason: 'length', tokens: 4 })
  assert.equal(w.exits, 0)
  // A signal stopped before the answer asks nothing of wllama.
  const asked = w.chats.length
  assert.equal((await rejection(runtime.chat(MESSAGES, chatOptions({ signal: AbortSignal.abort(why) })))).error, why)
  assert.equal(w.chats.length, asked)
})

test('a stopped answer whose call never settles lets the instance go after STOP_MS, and the next answer waits for that', { timeout: STOP_MS + EXIT_MS + 3_000 }, async () => {
  const { world, runtime, w } = await loaded()
  world.onChat = async (_inst, p) => {
    await tick()
    p.onData(chunks(['a'])[2])
    // A call that ignores its signal (wllama checks it only between steps).
    return never()
  }
  const stop = new AbortController()
  const o = chatOptions({ signal: stop.signal, onChunk: () => stop.abort() })
  const { error, ms } = await rejection(runtime.chat(MESSAGES, o))
  assert.equal((error as Error).name, 'AbortError')
  assert.ok(ms < 1000)
  assert.equal(runtime.loaded(), true)
  const t = Date.now()
  const next = await rejection(runtime.chat(MESSAGES, chatOptions()))
  isCognition(next.error, 'server', 'the in-page runtime did not stop the answer when asked: the next ask loads it again')
  assert.ok(Date.now() - t >= STOP_MS - 100, 'the next answer waited for the stopped one')
  assert.equal(w.chats.length, 1, 'the next answer never reached the runtime the stopped call still held')
  assert.equal(w.exits, 1)
  assert.equal(runtime.loaded(), false)
})

test('a stopped answer whose call settles late still holds the runtime: the next answer starts only once it settled, on the same model', SETTLES, async () => {
  const { world, runtime, w } = await loaded()
  let settledAt = 0
  const startedAt: number[] = []
  world.onChat = async (inst, p) => {
    startedAt.push(Date.now())
    if (startedAt.length > 1) return stream(inst, p, chunks(['b', 'b']))
    await tick()
    p.onData(chunks(['a'])[2])
    // wllama finishes the step it is in before it looks at its signal again.
    while (!p.abortSignal.aborted) await tick()
    await new Promise((resolve) => setTimeout(resolve, 300))
    settledAt = Date.now()
    throw new FakeAbortError()
  }
  const stop = new AbortController()
  const first = rejection(runtime.chat(MESSAGES, chatOptions({ signal: stop.signal, onChunk: () => stop.abort() })))
  assert.equal(((await first).error as Error).name, 'AbortError')
  const o = chatOptions()
  assert.deepEqual(await runtime.chat(MESSAGES, o), { reason: 'length', tokens: 2 })
  assert.equal(startedAt.length, 2)
  assert.ok(settledAt > 0 && startedAt[1] >= settledAt, 'the next call began after the stopped one settled')
  assert.equal(o.got.filter((c) => c.text).map((c) => c.text).join(''), 'bb')
  assert.equal(w.exits, 0)
  assert.equal(runtime.loaded(), true)
})

test('idle() settles at once with nothing stopped, else once a stopped call has settled or been let go: only then does loaded() say whether the model stayed', { timeout: STOP_MS + EXIT_MS + 3_000 }, async () => {
  for (const late of [300, null]) {
    const { world, runtime, w } = await loaded()
    let t = Date.now()
    await runtime.idle()
    assert.ok(Date.now() - t < 100, 'nothing is settling')
    world.onChat = async (_inst, p) => {
      await tick()
      p.onData(chunks(['a'])[2])
      // wllama looks at its signal only between steps: this step ends `late` ms after the stop, or never.
      while (!p.abortSignal.aborted) await tick()
      if (late === null) return never()
      await sleep(late)
      throw new FakeAbortError()
    }
    const stop = new AbortController()
    const { error, ms } = await rejection(runtime.chat(MESSAGES, chatOptions({ signal: stop.signal, onChunk: () => stop.abort() })))
    assert.equal((error as Error).name, 'AbortError')
    assert.ok(ms < 200, 'the stop settles the answer at once')
    assert.equal(runtime.loaded(), true, 'not yet known: the call is still settling')
    t = Date.now()
    await runtime.idle()
    const waited = Date.now() - t
    if (late !== null) {
      assert.ok(waited >= late - 50 && waited < STOP_MS, `waited ${waited} ms for the call to settle`)
      assert.equal(runtime.loaded(), true, 'a stop honoured in time keeps the model')
      assert.equal(w.exits, 0)
    } else {
      assert.ok(waited >= STOP_MS - 100, `waited ${waited} ms, up to STOP_MS`)
      assert.equal(runtime.loaded(), false, 'a stop not honoured in time took the model with it')
      assert.equal(w.exits, 1)
    }
    t = Date.now()
    await runtime.idle()
    assert.ok(Date.now() - t < 100, 'and nothing is settling after')
  }
})

test('unload during an answer settles the answer (exit leaves wllama\'s call pending forever) and the model is gone', SETTLES, async () => {
  const { world, runtime, w } = await loaded()
  world.onChat = (inst, p) => stream(inst, p, chunks(Array.from({ length: 1000 }, () => 'a')))
  const o = chatOptions({ maxTokens: 1000 })
  const answer = runtime.chat(MESSAGES, o)
  while (o.got.filter((c) => c.text).length < 2) await tick()
  await runtime.unload()
  const { error, ms } = await rejection(answer)
  isCognition(error, 'server', 'the model in this page was unloaded: the next ask loads it again')
  assert.ok(ms < 1000)
  assert.equal(w.exits, 1)
  assert.equal(w.dead, true, 'the fake\'s call is left pending, as wllama\'s is')
  assert.equal(runtime.loaded(), false)
  isCognition((await rejection(runtime.chat(MESSAGES, chatOptions()))).error, 'server', 'no model is loaded in this page: the next ask loads it again')
})

test('the first-piece and stall watchdogs end a quiet answer as timeout and let the instance go', SETTLES, async () => {
  {
    const { world, runtime, w } = await loaded()
    world.onChat = () => never()
    const { error, ms } = await rejection(runtime.chat(MESSAGES, chatOptions({ firstMs: 60 })))
    isCognition(error, 'timeout', /^the model in this page wrote nothing for 60 ms/)
    assert.ok(ms >= 50 && ms < 1000, `${ms} ms`)
    assert.equal(w.exits, 1)
    assert.equal(runtime.loaded(), false)
  }
  {
    const { world, runtime, w } = await loaded()
    world.onChat = async (_inst, p) => {
      for (const c of chunks(['a', 'b', 'c']).slice(0, 4)) {
        await tick()
        p.onData(c)
      }
      return never()
    }
    const o = chatOptions({ firstMs: 5_000, stallMs: 60 })
    const { error, ms } = await rejection(runtime.chat(MESSAGES, o))
    isCognition(error, 'timeout', 'the model in this page went quiet for 60 ms in the middle of the answer')
    assert.ok(ms < 1000)
    assert.equal(o.got.filter((c) => c.text).length, 2)
    assert.equal(w.exits, 1)
  }
})

test('a prompt longer than the context is model, and the same instance answers the next prompt', SETTLES, async () => {
  const { world, runtime, w } = await loaded()
  world.onChat = async () => {
    await tick()
    throw new FakeWllamaError('request (4954 tokens) exceeds the available context size (512 tokens), try increasing it', 'inference_error')
  }
  isCognition((await rejection(runtime.chat(MESSAGES, chatOptions()))).error, 'model', 'the prompt is longer than the model in this page can read: request (4954 tokens) exceeds the available context size (512 tokens), try increasing it')
  assert.equal(w.exits, 0)
  assert.equal(runtime.loaded(), true)
  world.onChat = (inst, p) => stream(inst, p, chunks(['a', 'a']))
  assert.deepEqual(await runtime.chat(MESSAGES, chatOptions()), { reason: 'length', tokens: 2 })
})

test('a runtime error or an abort line mid-answer is server, and the instance goes', SETTLES, async () => {
  {
    const { world, runtime, w } = await loaded()
    world.onChat = async (inst, p) => {
      await stream(inst, p, chunks(['a']).slice(0, 3))
      throw new FakeRuntimeError('(ABORT) ')
    }
    isCognition((await rejection(runtime.chat(MESSAGES, chatOptions()))).error, 'server', 'the in-page runtime stopped: the next ask loads it again')
    assert.equal(w.exits, 1)
    assert.equal(runtime.loaded(), false)
  }
  {
    const { world, runtime, w } = await loaded()
    world.onChat = async (inst, p) => {
      await stream(inst, p, chunks(['a']).slice(0, 3))
      inst.logger.log('/source/llama.cpp/common/chat.cpp:1532: GGML_ASSERT(chat_templates != nullptr) failed')
      inst.logger.log('Aborted()')
      return never()
    }
    const { error, ms } = await rejection(runtime.chat(MESSAGES, chatOptions()))
    isCognition(error, 'server', 'the in-page runtime stopped (Aborted()): the next ask loads it again')
    assert.ok(ms < 1000)
    assert.equal(w.exits, 1)
  }
})

test('errors are told apart by class and type, never by name', SETTLES, async () => {
  const cases: [() => Error, string, boolean][] = [
    // Named like wllama's abort, but not its class: a failure, not a stop.
    [() => Object.assign(new Error('Operation aborted'), { name: 'AbortError' }), 'server', true],
    // An inference error's type on something that is not a WllamaError.
    [() => Object.assign(new Error('request exceeds the available context size'), { type: 'inference_error' }), 'server', true],
    // A WllamaError (named "Error") of another type.
    [() => new FakeWllamaError('loadModel() is not yet called', 'model_not_loaded'), 'server', true],
    [() => new FakeWllamaError('Model failed to start inference', 'inference_error'), 'model', false],
    [() => new FakeWllamaError('the KV cache is full', 'kv_cache_full'), 'model', false],
    // wllama's own abort with no stop asked: not the caller's stop.
    [() => new FakeAbortError(), 'server', false],
  ]
  for (const [make, code, exits] of cases) {
    const { world, runtime, w } = await loaded()
    world.onChat = async () => {
      await tick()
      throw make()
    }
    isCognition((await rejection(runtime.chat(MESSAGES, chatOptions()))).error, code)
    assert.equal(w.exits, exits ? 1 : 0, `${make().name} ${String((make() as { type?: string }).type)}`)
  }
})

test('a piece the caller refuses ends the answer with that error and stops wllama\'s call', SETTLES, async () => {
  const { world, runtime, w } = await loaded()
  world.onChat = (inst, p) => stream(inst, p, chunks(Array.from({ length: 50 }, () => 'a')), 0)
  const refused = new Error('the 14A screen refused this piece')
  let n = 0
  const { error } = await rejection(runtime.chat(MESSAGES, chatOptions({ maxTokens: 50, onChunk: (c) => { if (c.text && ++n === 2) throw refused } })))
  assert.equal(error, refused)
  assert.equal(w.chats[0].abortSignal.aborted, true)
  await sleep(20)
  assert.equal(n, 2)
  assert.equal(w.exits, 0)
})

test('a chunk after the answer settled is ignored', SETTLES, async () => {
  const { world, runtime } = await loaded()
  const late: { send?: () => void } = {}
  world.onChat = async (inst, p) => {
    await stream(inst, p, chunks(['a']))
    late.send = () => p.onData({ choices: [{ delta: { content: 'late' } }] })
  }
  const o = chatOptions()
  await runtime.chat(MESSAGES, o)
  const seen = o.got.length
  assert.ok(late.send)
  late.send()
  assert.equal(o.got.length, seen)
})

test('an answer with nothing loaded is server; a worker gone while idle is server and lets the instance go', SETTLES, async () => {
  const { runtime } = setup()
  isCognition((await rejection(runtime.chat(MESSAGES, chatOptions()))).error, 'server', 'no model is loaded in this page: the next ask loads it again')
  const s = await loaded()
  s.w.logger.error(Object.assign(new Event('error'), { message: 'Uncaught out of memory' }))
  assert.equal(s.runtime.loaded(), false)
  isCognition((await rejection(s.runtime.chat(MESSAGES, chatOptions()))).error, 'server', 'the in-page runtime\'s worker failed (the worker failed: Uncaught out of memory): the next ask loads it again')
  assert.equal(s.w.exits, 1)
})

test('unload settles even when exit never does, and twice is harmless', { timeout: EXIT_MS + 3_000 }, async () => {
  const { world, runtime, w } = await loaded()
  world.exitHangs = true
  const t = Date.now()
  await runtime.unload()
  assert.ok(Date.now() - t < EXIT_MS + 500)
  assert.equal(runtime.loaded(), false)
  await runtime.unload()
  assert.equal(w.exits, 1)
})

test('caps() is the probe of this page\'s global', SETTLES, () => {
  const { runtime } = setup()
  assert.deepEqual(runtime.caps(), probe(globalThis))
  assert.equal(runtime.caps(), runtime.caps(), 'asked once')
})
