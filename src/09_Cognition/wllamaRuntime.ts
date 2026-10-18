// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the engine under the in-page mind (inPage.ts InPageRuntime): wllama, the
 * WebAssembly build of llama.cpp, driven so that nothing it does can reach off this machine or leave the mind waiting.
 * It is the only file that names wllama's package or the pinned runtime module the build embeds (vite.config.ts
 * wllamaRuntime); both are imported dynamically, the first time a model loads. It:
 * - unpacks the pinned module (the base64 of its gzip) in the page, checks its length and sha256 against the pin, and
 *   hands it to wllama as a page-made blob: URL (never a data: URL, which wllama would paste into its worker's
 *   source); a module that does not match is 'server' "damaged" and never runs;
 * - makes one wllama instance for each load, with a cache that keeps nothing (NO_STORAGE: wllama never stores, lists
 *   or reads a model of its own), its compatibility build switched off the moment it is made (the constructor points
 *   it at a CDN), and a logger of this file's own;
 * - keeps the runtime's last 200 log lines for `ask file log`, and reads them as the runtime's only signs: its worker
 *   gone (an "Aborted(" line, a failed file read, the worker's error event), its module up (wllama's own "Calling
 *   wllamaStart" line), why llama.cpp could not read a file, and whether the weights landed on the GPU. Every native
 *   line is let through for that (suppressNativeLog is off: it would drop them all, the abort line with them);
 *   `debug` only echoes them to the console as well;
 * - races every load and every answer against the caller's signal, its watchdogs and the worker going, so each
 *   settles even when wllama never does (a damaged module hangs a load forever; exit() leaves an answer pending
 *   forever), and lets the instance go (exit) whenever a race is lost; a stopped answer is the exception: wllama
 *   cancels it between two steps, so the model stays loaded unless the call fails to settle within STOP_MS (a long
 *   prompt step on the processor), and idle() lets the mind wait for that before it asks whether a model is loaded;
 * - turns what wllama says into the mind's failures: 'model' for a file llama.cpp cannot read, a model or context too
 *   large for the page's memory (said so, not called unreadable) or a prompt longer than the context, 'server' for a
 *   runtime that stopped, 'timeout' for one that went quiet, the signal's own reason for a
 *   stop. Errors are told apart by class and type, never by name (every WllamaError is named "Error").
 * It never calls wllama's download paths: the model is always a file the operator kept in this page (modelStore.ts).
 * airgap.test.ts pins this, the compatibility switch and the cache structurally.
 * What breaks if it is removed? The in-page provider has no engine: a kept model file is never run.
 */
// oxlint-disable-next-line typescript/triple-slash-reference -- the virtual module's type, for every program that reads this file (the Node test program includes no .d.ts of its own)
/// <reference path="../wllama-runtime.d.ts" />
import { hex, sha256 } from '../02_Define_The_Rules/integrity.ts'
import type { ChatChunk, ChatMessage, ChatOptions, ChatResult, InPageRuntime, LoadOptions } from './inPage.ts'
import { probe, type Caps } from './inPageCaps.ts'
import { CognitionError } from './localCompute.ts'

/** One of wllama's log functions: it hands over strings, Errors, the worker's ErrorEvent and plain objects. */
type LogFn = (...args: unknown[]) => void
/** The logger wllama takes (its WllamaLogger). */
export interface WllamaLogger { debug: LogFn; log: LogFn; warn: LogFn; error: LogFn }

/** A storage backend for wllama's cache manager (its StorageBackend). */
export interface WllamaStorage {
  isSupported(): boolean
  read(key: string): Promise<Blob | null>
  write(key: string, stream: ReadableStream): Promise<void>
  getSize(key: string): Promise<number>
  list(): Promise<{ key: string; size: number }[]>
  delete(key: string): Promise<void>
}

/** What a load hands wllama's loadModel (the keys of its LoadModelParams this file sets). */
export interface WllamaLoadParams {
  n_ctx: number
  n_threads: number
  n_gpu_layers?: number
  n_batch?: number
  n_ubatch?: number
  n_parallel: number
  kv_unified: boolean
  jinja: boolean
  warmup: boolean
  log_level: number
}

/** What an answer hands wllama's createChatCompletion: a stream with onData, which resolves once the stream ends. */
export interface WllamaChatParams {
  messages: ChatMessage[]
  stream: true
  onData: (chunk: unknown) => void
  abortSignal: AbortSignal
  max_tokens: number
  chat_template_kwargs: { enable_thinking: boolean }
  return_progress: boolean
}

/** One wllama instance, as this file uses it. */
export interface WllamaInstance {
  setCompat(compat: null): void
  loadModel(blobs: Blob[], params: WllamaLoadParams): Promise<void>
  getLoadedContextInfo(): object
  createChatCompletion(params: WllamaChatParams): Promise<unknown>
  exit(): Promise<void>
}

/**
 * The parts of wllama's module this file uses: the npm package in the product, a fake in the tests. `C` is the type
 * of its cache manager, which this file only makes and hands back to the same module's constructor.
 */
export interface WllamaLib<C = object> {
  Wllama: new (paths: { default: string }, config: { cacheManager?: C; suppressNativeLog?: boolean; logger?: WllamaLogger }) => WllamaInstance
  CacheManager: new (backends: WllamaStorage[]) => C
  WllamaError: abstract new (...args: never[]) => Error
  WllamaAbortError: abstract new (...args: never[]) => Error
  WllamaRuntimeError: abstract new (...args: never[]) => Error
}

/**
 * wllama's module as TypeScript reads it, checked against WllamaLib with its own cache type, so a wllama whose API
 * drifted fails to type-check here. The page's program (bundler resolution) reads the package's types; the Node test
 * program (nodenext) cannot follow their extensionless re-exports, sees no Wllama, and so checks nothing there.
 */
type Package = typeof import('@wllama/wllama/esm/index.js')
type Checked = Package extends { Wllama: unknown; CacheManager: new (backends: WllamaStorage[]) => infer C } ? WllamaLib<C> : unknown
/** The checked module, held without its cache type: a cache is only ever handed to the constructor of the module that made it. */
const asLib = (m: Checked): WllamaLib => m as unknown as WllamaLib

/** The pinned runtime module as the build embeds it (vite.config.ts wllamaModule, typed by src/wllama-runtime.d.ts). */
export interface PinnedRuntime {
  /** The module's gzip, as base64. */
  readonly default: string
  /** The raw module's sha256, lowercase hex. */
  readonly sha256: string
  /** The raw module's length in bytes. */
  readonly bytes: number
}

export interface WllamaRuntimeOptions {
  /** Echo every line the runtime logs to the console too (they are kept for `ask file log` either way). */
  debug?: boolean
  /** wllama's module (absent: the npm package, imported the first time a model loads). */
  lib?: () => Promise<WllamaLib>
  /** The runtime module's URL (absent: the pinned module the build embeds, checked and made a blob: URL here). */
  wasm?: () => Promise<string>
}

/** The log lines kept for `ask file log`. */
export const LOG_LINES = 200
/** wllama's LogLevel.INFO: llama.cpp's errors, its warnings and the load's own report (where the weights went). */
const LOG_INFO = 2
/** How long a stopped answer's call may take to settle (wllama sees its signal between two steps) before the instance goes. */
export const STOP_MS = 2_000
/** How long letting an instance go may take before it is taken as gone anyway (exit() only terminates its worker). */
export const EXIT_MS = 2_000
/** Why a pinned module that does not match its pin is refused. */
const DAMAGED = 'the in-page runtime in this file is damaged'
/** The line wllama logs once its module has started (after the worker compiled the module and set up its files). */
const STARTED = /^(?:Calling wllamaStart|Loading model)/
/** The runtime's glue aborted (a module that does not compile, a memory it could not have, a failed assertion). */
const ABORTED = /(?:^|\n)\s*Aborted\(/
/** wllama could not read a block of the model file for the runtime, and terminated its worker. */
const READ_FAILED = /fileReadResponse failed/
/** The lines of a load's report that say where the weights went. */
const PLACED = /model buffer size|layers to GPU/
/** What a long line is cut to in the log. */
const LINE_CHARS = 600

/** wllama's cache, keeping nothing: it never stores, lists or reads a model of its own (the operator's file is the only model). */
const NO_STORAGE: WllamaStorage = Object.freeze({
  isSupported: () => true,
  read: async () => null,
  write: async () => {
    throw new Error('the in-page runtime keeps no files of its own')
  },
  getSize: async () => -1,
  list: async () => [],
  delete: async () => undefined,
})

/** A signal's reason as something to throw: an Error as it is, anything else as an AbortError. */
const reasonOf = (s: AbortSignal): Error => (s.reason instanceof Error ? s.reason : new DOMException('aborted', 'AbortError'))

/** An error's message as one plain line. */
const said = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0].trim()

/** A span of milliseconds in words: "10 minutes", "1 minute", "90 s", "250 ms". */
const span = (ms: number): string =>
  ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}` : ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`

/** `p`, or the signal's reason the moment it aborts; a rejection of `p` after that is caught here. */
function stopped<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => undefined)
    return Promise.reject(reasonOf(signal))
  }
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(reasonOf(signal))
    signal.addEventListener('abort', stop, { once: true })
    p.then(
      (v) => { signal.removeEventListener('abort', stop); resolve(v) },
      (e: unknown) => { signal.removeEventListener('abort', stop); reject(e) },
    )
  })
}

/** Bytes from base64. */
function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** The bytes a gzip holds, unpacked by the page itself (DecompressionStream). */
async function gunzip(gz: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** The sha256 of `bytes`, lowercase hex: the platform's digest, or the page's own (integrity.ts) where there is none. */
async function digestOf(bytes: Uint8Array<ArrayBuffer>, subtle: Pick<SubtleCrypto, 'digest'> | null | undefined): Promise<string> {
  if (subtle) {
    try {
      return hex(new Uint8Array(await subtle.digest('SHA-256', bytes)))
    } catch {
      // not in this context (an address that is not a secure origin): the page's own below
    }
  }
  return sha256(bytes)
}

/**
 * The pinned runtime module as a page-made blob: URL: its gzip unpacked here, its length and sha256 checked against the
 * pin ('server' "damaged" when either differs, or the gzip does not unpack). `subtle` is the platform's digest
 * (absent or failing: integrity.ts sha256 instead).
 */
export async function wasmBlobUrl(pin: PinnedRuntime, subtle: Pick<SubtleCrypto, 'digest'> | null | undefined = globalThis.crypto?.subtle): Promise<string> {
  let raw: Uint8Array<ArrayBuffer>
  try {
    raw = await gunzip(fromBase64(pin.default))
  } catch {
    throw new CognitionError('server', DAMAGED)
  }
  if (raw.byteLength !== pin.bytes || (await digestOf(raw, subtle)) !== pin.sha256) throw new CognitionError('server', DAMAGED)
  return URL.createObjectURL(new Blob([raw], { type: 'application/wasm' }))
}

/** Whether `a` is the worker's error event (wllama hands its worker's onerror straight to logger.error). */
const isErrorEvent = (a: unknown): a is Event & { message?: unknown } => typeof Event !== 'undefined' && a instanceof Event && a.type === 'error'

/** One argument of a log call as words: a string as it is, an error by name and message, the worker's error event, anything else as JSON with long strings cut. */
function words(a: unknown): string {
  if (typeof a === 'string') return a
  if (a instanceof Error) return `${a.name}: ${a.message}`
  if (isErrorEvent(a)) return `the worker failed: ${typeof a.message === 'string' && a.message ? a.message : 'no message'}`
  try {
    return JSON.stringify(a, (_k, v: unknown) => (typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…` : v)) ?? String(a)
  } catch {
    return String(a)
  }
}

/** A log line on one line, cut to LINE_CHARS. */
function flat(text: string): string {
  const one = text.replace(/\s*\n\s*/g, ' | ').trim()
  return one.length > LINE_CHARS ? `${one.slice(0, LINE_CHARS)}…` : one
}

/** A log line without the function names llama.cpp starts it with ("srv    load_model: ", "llama_model_load: error loading model: "). */
const plain = (line: string): string =>
  line.trim().replace(/^(?:[a-z]{2,4}\s+)?\w+:\s+/, '').replace(/^error loading model:\s*/, '').trim()

/** llama.cpp's words when the page's memory could not hold what it needed (the weights, the context's cache, its buffers). */
const NO_ROOM = /insufficient memory|failed to allocate|unable to allocate|out of memory/i

/**
 * Why llama.cpp could not load a file: a model (or its context) too large for the page's memory is said so, with the
 * size it asked for, since the file itself is good; else, in llama.cpp's own words, its first error line that says
 * more than "failed to load model".
 */
function unreadable(errors: readonly string[]): string {
  if (errors.some((l) => NO_ROOM.test(l))) {
    const asked = errors.map((l) => /attempted to allocate ([\d.]+ ?[KMG]i?B)/.exec(l)?.[1]).find((a) => a !== undefined)
    const context = errors.some((l) => /kv cache|initiali[sz]e the context|create_?context/i.test(l))
    return `the model${context ? ' and its context do' : ' does'} not fit in this page's memory${asked ? ` (llama.cpp asked for ${asked} and was refused)` : ''}: a smaller model, or a smaller quantization of this one, may`
  }
  const line = errors.find((l) => !/failed to load model/i.test(l)) ?? errors.at(-1)
  return line === undefined ? 'this is not a model llama.cpp can read (it gave no reason)' : `this is not a model llama.cpp can read: ${plain(line)}`
}

/**
 * Whether the weights landed on the GPU, from the load's report: a model buffer anywhere but the CPU, or layers
 * offloaded, says yes; only CPU buffers (or no layer offloaded) says no (wllama runs a GPU load on the processor where
 * the adapter lacks shader-f16, without a word otherwise); no report at all keeps what was asked.
 */
function landed(lines: readonly string[], asked: boolean): boolean {
  if (!asked) return false
  let cpu = false
  for (const l of lines) {
    const buffer = /(\S+)\s+model buffer size/.exec(l)
    if (buffer) {
      if (!/^CPU/i.test(buffer[1])) return true
      cpu = true
    }
    const offloaded = /offloaded (\d+)\/\d+ layers to GPU/.exec(l)
    if (offloaded) {
      if (Number(offloaded[1]) > 0) return true
      cpu = true
    }
  }
  return !cpu
}

/** What an engine's logger has said, and how it stands: everything about one load but the wllama instance itself. */
interface EngineState {
  readonly lib: WllamaLib
  /** Why it is gone (its worker, or this file let it go), or null while it lives. */
  why: string | null
  /** Its model loaded and readable. */
  loaded: boolean
  /** Its module reported it started. */
  started: boolean
  /** Called once when its module reports it started. */
  onStart: (() => void) | null
  /** The error lines it logged (why llama.cpp refused a file). */
  readonly errors: string[]
  /** The lines of its load's report that say where the weights went. */
  readonly placed: string[]
  /** Told once when it goes, with why. */
  readonly watchers: Set<(why: string) => void>
  /** A stopped answer's call still settling, or null. */
  settling: Promise<void> | null
  /** Its exit, once asked. */
  exiting: Promise<void> | null
}
/** One wllama instance and what its logger has said: one for each load. */
interface Engine extends EngineState {
  readonly w: WllamaInstance
}

/** Marks `e` gone for `why` (the first reason stands) and tells everything still racing on it. */
function fail(e: EngineState, why: string): void {
  if (e.why !== null) return
  e.why = why
  e.loaded = false
  for (const w of [...e.watchers]) {
    try {
      w(why)
    } catch {
      // a watcher's own failure is not the runtime's
    }
  }
  e.watchers.clear()
}

/** Tells `fn` when `e` goes (at once, after this turn, if it has gone already); returns the unsubscription. */
function watch(e: EngineState, fn: (why: string) => void): () => void {
  if (e.why !== null) {
    const why = e.why
    queueMicrotask(() => fn(why))
    return () => undefined
  }
  e.watchers.add(fn)
  return () => { e.watchers.delete(fn) }
}

/** Lets `e` go: gone for `why`, then its exit (which terminates its worker), never waiting longer than EXIT_MS. */
function letGo(e: Engine, why: string): Promise<void> {
  fail(e, why)
  e.exiting ??= (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.resolve().then(() => e.w.exit()).catch(() => undefined),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, EXIT_MS) }),
      ])
    } finally {
      clearTimeout(timer)
    }
  })()
  return e.exiting
}

/**
 * One call into an engine, settled once: by the call itself (`win`, or `lose` with what its error means), or by
 * whatever beats it (the signal, a watchdog, the worker going). Losing with `exit` lets the engine go before the
 * rejection, so the caller never meets an engine that is half there. Settling runs every `then`.
 */
function once<T>(e: Engine) {
  let over = false
  const ends: (() => void)[] = []
  let resolve!: (v: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  const end = (): boolean => {
    if (over) return false
    over = true
    for (const f of ends.splice(0)) {
      try {
        f()
      } catch {
        // a cleanup's own failure changes nothing
      }
    }
    return true
  }
  return {
    promise,
    over: (): boolean => over,
    then: (f: () => void): void => { if (over) f(); else ends.push(f) },
    win: (v: T): void => { if (end()) resolve(v) },
    lose: (err: unknown, exit: boolean, why: string): void => {
      if (!end()) return
      if (exit) void letGo(e, why).then(() => reject(err))
      else reject(err)
    },
  }
}

/** What a failed load's error means: a file llama.cpp refused ('model'), or a runtime that stopped ('server'). */
function loadFailure(lib: WllamaLib, err: unknown): CognitionError {
  if (err instanceof CognitionError) return err
  if (err instanceof lib.WllamaRuntimeError) return new CognitionError('server', `the in-page runtime stopped while it was loading the model (${said(err)})`)
  if (err instanceof lib.WllamaError && (err as { type?: unknown }).type === 'load_error') return new CognitionError('model', `the in-page runtime refused the file: ${said(err)}`)
  return new CognitionError('server', `the in-page runtime failed while it was loading the model (${said(err)})`)
}

/** What a failed answer's error means, and whether the engine must go: only a stop and a refused prompt keep it. */
function chatFailure(lib: WllamaLib, err: unknown, signal: AbortSignal): { error: unknown; exit: boolean } {
  if (err instanceof lib.WllamaAbortError) return { error: signal.aborted ? reasonOf(signal) : new CognitionError('server', 'the in-page runtime stopped the answer on its own'), exit: false }
  if (err instanceof lib.WllamaRuntimeError) return { error: new CognitionError('server', 'the in-page runtime stopped: the next ask loads it again'), exit: true }
  if (err instanceof lib.WllamaError) {
    const type = (err as { type?: unknown }).type
    if (type === 'inference_error' || type === 'kv_cache_full') {
      const too = /exceeds the available context size/.test(said(err))
      return { error: new CognitionError('model', `${too ? 'the prompt is longer than the model in this page can read' : 'the model in this page could not answer'}: ${said(err)}`), exit: false }
    }
  }
  return { error: new CognitionError('server', `the in-page runtime failed (${said(err)}): the next ask loads it again`), exit: true }
}

/** The part of a streamed chunk the mind reads, taken defensively (wllama's chunks follow llama.cpp's server). */
interface Chunk {
  choices?: { delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }; finish_reason?: unknown }[]
  prompt_progress?: { processed?: unknown; total?: unknown }
  timings?: { predicted_n?: unknown }
  usage?: { completion_tokens?: unknown } | null
}

/** A chunk as the mind takes it: its text, its thinking, how far the prompt has been read; null for the role-only chunk. */
function pieceOf(c: Chunk): ChatChunk | null {
  const out: ChatChunk = {}
  const delta = c.choices?.[0]?.delta
  if (typeof delta?.content === 'string' && delta.content) out.text = delta.content
  const thinking = typeof delta?.reasoning_content === 'string' && delta.reasoning_content ? delta.reasoning_content : delta?.reasoning
  if (typeof thinking === 'string' && thinking) out.thinking = thinking
  const p = c.prompt_progress
  if (p && typeof p.processed === 'number' && typeof p.total === 'number' && Number.isFinite(p.processed) && Number.isFinite(p.total)) {
    out.progress = { processed: p.processed, total: p.total }
  }
  return out.text === undefined && out.thinking === undefined && out.progress === undefined ? null : out
}

/** A finite number, or null. */
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * The in-page runtime over wllama (see the file's comment). `o.lib` and `o.wasm` stand in for the package and the
 * pinned module in the tests; `o.debug` echoes the runtime's log to the console.
 */
export function createWllamaRuntime(o: WllamaRuntimeOptions = {}): InPageRuntime {
  const debug = o.debug === true
  const ring: string[] = []
  let current: Engine | null = null
  let caps: Caps | null = null

  let libOnce: Promise<WllamaLib> | null = null
  const wllama = (): Promise<WllamaLib> =>
    (libOnce ??= (o.lib ?? (async () => asLib(await import('@wllama/wllama/esm/index.js'))))().catch((e: unknown) => {
      libOnce = null
      throw new CognitionError('server', `the in-page runtime could not be started (${said(e)})`)
    }))
  let urlOnce: Promise<string> | null = null
  const wasmUrl = (): Promise<string> =>
    (urlOnce ??= (o.wasm ?? (async () => wasmBlobUrl(await import('virtual:wllama-runtime'))))().catch((e: unknown) => {
      urlOnce = null
      throw e instanceof CognitionError ? e : new CognitionError('server', `the in-page runtime could not be prepared (${said(e)})`)
    }))

  function keep(level: string, text: string): void {
    ring.push(`${level}: ${flat(text)}`)
    if (ring.length > LOG_LINES) ring.splice(0, ring.length - LOG_LINES)
  }

  /** What the engine's logger makes of a line: kept, echoed when debugging, and read for the engine's signs. */
  function heard(e: EngineState, level: 'debug' | 'log' | 'warn' | 'error', args: unknown[]): void {
    const text = args.map(words).join(' ')
    keep(level, text)
    if (debug) console[level](...args)
    if (STARTED.test(text) && !e.started) {
      e.started = true
      e.onStart?.()
    }
    if (level === 'error' && e.errors.length < 40) e.errors.push(text)
    if (PLACED.test(text) && e.placed.length < 40) e.placed.push(text)
    const event = args.find(isErrorEvent)
    if (event) fail(e, `the in-page runtime's worker failed (${words(event)})`)
    else if (ABORTED.test(text)) fail(e, `the in-page runtime stopped (${flat(text)})`)
    else if (READ_FAILED.test(text)) fail(e, `the in-page runtime could not read the model file (${flat(text)})`)
  }

  /** The engine's logger: arrow functions (wllama hands logger.error to its worker's onerror unbound) that never throw. */
  function loggerOf(e: EngineState): WllamaLogger {
    const at = (level: 'debug' | 'log' | 'warn' | 'error'): LogFn => (...args: unknown[]): void => {
      try {
        heard(e, level, args)
      } catch {
        // a line that cannot be read is dropped, never thrown back into wllama
      }
    }
    return { debug: at('debug'), log: at('log'), warn: at('warn'), error: at('error') }
  }

  /** A new engine: wllama over the runtime module at `url`, with a cache that keeps nothing and no compatibility build. */
  function create(lib: WllamaLib, url: string): Engine {
    const e: EngineState = { lib, why: null, loaded: false, started: false, onStart: null, errors: [], placed: [], watchers: new Set(), settling: null, exiting: null }
    const w = new lib.Wllama({ default: url }, { cacheManager: new lib.CacheManager([NO_STORAGE]), suppressNativeLog: false, logger: loggerOf(e) })
    w.setCompat(null)
    return Object.assign(e, { w })
  }

  async function unload(): Promise<void> {
    const e = current
    current = null
    if (e) await letGo(e, 'the model in this page was unloaded')
  }

  async function load(files: readonly Blob[], lo: LoadOptions): Promise<{ gpu: boolean; ms: number }> {
    const t0 = Date.now()
    if (lo.signal.aborted) throw reasonOf(lo.signal)
    // Whatever is loaded or half loaded goes first: a load on a live instance throws "Module is already initialized".
    await unload()
    const [lib, url] = await stopped(Promise.all([wllama(), wasmUrl()]), lo.signal)
    if (lo.signal.aborted) throw reasonOf(lo.signal)
    const e = create(lib, url)
    current = e
    const op = once<void>(e)
    const params: WllamaLoadParams = {
      n_ctx: lo.ctx,
      n_threads: lo.threads,
      // 0 keeps the runtime off the GPU altogether; left out, wllama offloads every layer.
      ...(lo.gpu ? {} : { n_gpu_layers: 0 }),
      ...(lo.batch !== undefined && { n_batch: lo.batch }),
      ...(lo.ubatch !== undefined && { n_ubatch: lo.ubatch }),
      n_parallel: 1,
      kv_unified: true,
      jinja: true,
      warmup: lo.warmup,
      log_level: LOG_INFO,
    }
    // The module must say it started within startMs (a damaged one hangs without a word), and the whole load must
    // end within loadMs.
    const notStarted = `the in-page runtime did not start within ${span(lo.startMs)}`
    const start = setTimeout(() => op.lose(new CognitionError('timeout', notStarted), true, notStarted), lo.startMs)
    e.onStart = () => clearTimeout(start)
    const whole = setTimeout(() => op.lose(new CognitionError('timeout', `the model did not finish loading in ${span(lo.loadMs)}`), true, 'the load took too long'), lo.loadMs)
    const stop = (): void => op.lose(reasonOf(lo.signal), true, 'the load was stopped')
    lo.signal.addEventListener('abort', stop, { once: true })
    const unwatch = watch(e, (why) => op.lose(new CognitionError('server', why), true, why))
    op.then(() => {
      clearTimeout(start)
      clearTimeout(whole)
      e.onStart = null
      lo.signal.removeEventListener('abort', stop)
      unwatch()
    })
    let call: Promise<void>
    try {
      // The files in the mind's order (wllama would sort only Files named -NNNNN-of-NNNNN).
      call = e.w.loadModel([...files], params)
    } catch (err) {
      call = Promise.reject(err)
    }
    call.then(() => op.win(), (err: unknown) => op.lose(loadFailure(lib, err), true, 'its load failed'))
    await op.promise
    // llama.cpp refusing the file still resolves the load: only the context's success says so (not in wllama's types).
    let info: unknown
    try {
      info = e.w.getLoadedContextInfo()
    } catch (err) {
      info = err
    }
    if (typeof info !== 'object' || info === null || info instanceof Error || (info as { success?: unknown }).success === false) {
      await letGo(e, 'its model could not be read')
      throw new CognitionError('model', unreadable(e.errors))
    }
    if (e.why !== null) {
      await letGo(e, e.why)
      throw new CognitionError('server', e.why)
    }
    e.loaded = true
    return { gpu: landed(e.placed, lo.gpu), ms: Date.now() - t0 }
  }

  /** A stopped answer's call gets STOP_MS to settle; one that does not is let go (the next answer waits for this). */
  function afterStop(e: Engine, call: Promise<unknown>): void {
    let timer: ReturnType<typeof setTimeout> | undefined
    const settling: Promise<void> = Promise.race([
      call.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), STOP_MS) }),
    ]).then(async (inTime) => {
      clearTimeout(timer)
      if (!inTime) await letGo(e, 'the in-page runtime did not stop the answer when asked')
    }).finally(() => {
      if (e.settling === settling) e.settling = null
    })
    e.settling = settling
  }

  async function chat(messages: readonly ChatMessage[], co: ChatOptions): Promise<ChatResult> {
    if (co.signal.aborted) throw reasonOf(co.signal)
    const e = current
    const gone = async (g: Engine, why: string): Promise<never> => {
      await letGo(g, why)
      throw new CognitionError('server', `${why}: the next ask loads it again`)
    }
    // Its worker went while nothing was running on it.
    if (e !== null && e.why !== null) return gone(e, e.why)
    if (e === null || !e.loaded) throw new CognitionError('server', 'no model is loaded in this page: the next ask loads it again')
    // An answer stopped just before may still be settling in the runtime, which runs one call at a time.
    if (e.settling) await stopped(e.settling, co.signal)
    if (e.why !== null) return gone(e, e.why)
    const op = once<ChatResult>(e)
    // The signal wllama sees: aborted by the caller's stop, and by a piece the caller refuses.
    const own = new AbortController()
    let finish: string | null = null
    let predicted: number | null = null
    let completion: number | null = null
    let dog: ReturnType<typeof setTimeout> | undefined
    const quiet = (ms: number, why: string): void => {
      clearTimeout(dog)
      dog = setTimeout(() => op.lose(new CognitionError('timeout', why), true, 'the answer went quiet'), ms)
    }
    quiet(co.firstMs, `the model in this page wrote nothing for ${span(co.firstMs)}: it may be too large for this device, or the prompt too long for it`)
    // A stop (the caller's, or a piece the caller refused) settles the answer at once; wllama cancels its call between
    // two steps and the model stays loaded, unless the call does not settle within STOP_MS (afterStop).
    let call: Promise<unknown> | null = null
    let halted = false
    const halt = (why: unknown, error: unknown): void => {
      if (op.over()) return
      own.abort(why)
      op.lose(error, false, '')
      halted = true
      if (call) afterStop(e, call)
    }
    try {
      call = e.w.createChatCompletion({
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
        onData: (chunk: unknown) => {
          // Chunks still arrive after a stop and after the answer settled (spike): none of them is the answer's.
          if (op.over() || co.signal.aborted || typeof chunk !== 'object' || chunk === null) return
          quiet(co.stallMs, `the model in this page went quiet for ${span(co.stallMs)} in the middle of the answer`)
          const c = chunk as Chunk
          const f = c.choices?.[0]?.finish_reason
          if (typeof f === 'string' && f) finish = f
          predicted = count(c.timings?.predicted_n) ?? predicted
          completion = count(c.usage?.completion_tokens) ?? completion
          const piece = pieceOf(c)
          if (piece === null) return
          try {
            co.onChunk(piece)
          } catch (err) {
            halt(err, err)
          }
        },
        abortSignal: own.signal,
        max_tokens: co.maxTokens,
        chat_template_kwargs: { enable_thinking: co.think },
        return_progress: true,
      })
    } catch (err) {
      call = Promise.reject(err)
    }
    if (halted) afterStop(e, call)
    const stop = (): void => halt(co.signal.reason, reasonOf(co.signal))
    co.signal.addEventListener('abort', stop, { once: true })
    const unwatch = watch(e, (why) => op.lose(new CognitionError('server', `${why}: the next ask loads it again`), true, why))
    op.then(() => {
      clearTimeout(dog)
      co.signal.removeEventListener('abort', stop)
      unwatch()
    })
    call.then(
      () => op.win({ reason: finish ?? 'stop', tokens: predicted ?? completion }),
      (err: unknown) => {
        const f = chatFailure(e.lib, err, co.signal)
        op.lose(f.error, f.exit, 'its answer failed')
      },
    )
    return op.promise
  }

  return Object.freeze({
    caps: (): Caps => (caps ??= probe(globalThis)),
    load,
    chat,
    unload: async (): Promise<void> => {
      // Stopped (and the model with it) at once, however long exit() takes (letGo waits at most EXIT_MS).
      await unload()
    },
    loaded: (): boolean => current !== null && current.loaded && current.why === null,
    // A stopped answer's call settles within STOP_MS, or its instance is let go (afterStop); a later stop cannot start
    // while this is awaited, since the mind runs one call at a time.
    idle: async (): Promise<void> => {
      for (let s = current?.settling; s; s = current?.settling) await s.catch(() => undefined)
    },
    log: (): readonly string[] => ring.slice(),
  })
}
