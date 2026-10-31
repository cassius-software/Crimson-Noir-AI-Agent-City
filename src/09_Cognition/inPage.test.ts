// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the in-page mind (inPage.ts) over a fake runtime whose every call
 * is noted and can be held, failed or left hanging, a fake model store and a fake clock:
 * - the order of the refusals, at `ask` alone (no request, no load) and at an answer (the operator's stop first, then
 *   the same refusals, then the fit), none of them holding the city;
 * - one load for answers that arrive together, and one answer with the runtime at a time;
 * - the crash guard: written before a load, removed after it either way, left by a page that died loading (the next
 *   page refuses until `ask file load` or a file kept again, which retry on the processor), cleared by dispose (the
 *   page lived);
 * - a GPU load that fails tried once on the processor (once for answers that arrive together, and not at all for a
 *   model too large for the processor), a second failure 'model' with no third load;
 * - a runtime that stops mid-answer ('server', loaded again next time), one that never settles (release and dispose
 *   still settle the answer at once), the operator's stop before, during and after the load (a chunk after it is no
 *   part of the answer);
 * - the answer: the shared system prompt and its hash, the token count's fallback, thinking, the phase line (cleared
 *   only by the load or answer that set it), the waits and the placement handed to the runtime (its context no more
 *   than the model's header says it was trained on);
 * - unloading after ten idle minutes and after a minute hidden on a phone, a GPU reset turning the GPU off, a new
 *   choice of model unloading the old, busy said on and off on every path that held the city;
 * - and its settings, its own slice of the router's store, written without touching any other provider's.
 * What breaks if it is removed? A phone could load a model again and again after it took the tab down, an answer
 * could hang on a dead runtime, or the city stay held after an answer failed, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { AnswerRequest, GateTether, Memories, Piece } from '../07_Execute_Actions/operator.ts'
import { createInPageMind, GUARD_KEY, type ChatMessage, type ChatOptions, type ChatResult, type InPageRuntime, type LoadOptions } from './inPage.ts'
import { OPAQUE_REASON, runtimeMode, type Caps } from './inPageCaps.ts'
import { HIDDEN_UNLOAD_MS, IDLE_UNLOAD_MS, LOAD_MS, placement, START_MS, type PlanEnv } from './inPagePlan.ts'
import { CognitionError, FIRST_PIECE_MS, promptHash, STALL_MS, systemPrompt } from './localCompute.ts'
import { GONE, type KeptModel, type ModelStore } from './modelStore.ts'
import { createMindRouter, INPAGE_SERVER } from './router.ts'

const MIB = 2 ** 20
const GIB = 2 ** 30

// The GGUF writer is plain JavaScript (tools/ carries no types); a computed specifier keeps the page's typecheck off it.
const WRITER: string = '../../tools/browser/tinyGguf.mjs'
const { ggufBytes, GGUF_TYPE: T } = (await import(WRITER)) as {
  ggufBytes(kvs: readonly (readonly [string, number, unknown])[]): Uint8Array<ArrayBuffer>
  GGUF_TYPE: Readonly<Record<'U32' | 'STRING', number>>
}

type Env = Omit<PlanEnv, 'gpuMode' | 'gpuFailed'>
/** A desktop with a discrete GPU that has shader-f16: auto puts the model on the GPU. */
const GPU_DESKTOP: Env = { mobile: false, lite: false, gpuClass: 'discrete', cores: 8, memoryGb: 16, isolated: true, f16: true }
/** The same desktop without shader-f16: auto keeps the model on the processor, 4 threads. */
const CPU_DESKTOP: Env = { ...GPU_DESKTOP, f16: false }
/** A phone: the processor, one thread (not isolated). */
const PHONE: Env = { mobile: true, lite: false, gpuClass: 'mobile', cores: 8, memoryGb: 6, isolated: false, f16: false }
const CAPS: Caps = Object.freeze({ jspi: true, mem64shared: true, simd: true, exceptions: true, isolated: true, opfs: true, webgpu: true, opaque: false })

const NO_MODEL = 'no model file is kept in this page: Menu › Model file, or ask file'
const HIDDEN = 'the page went to the background, so the model was unloaded: the next ask loads it again'

interface LoadCall { files: readonly Blob[]; o: LoadOptions }
interface ChatCall { messages: readonly ChatMessage[]; o: ChatOptions }

/** A promise settled from outside. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
/** Never settles, whatever its signal does: a runtime that misbehaves. */
const never = <T>(): Promise<T> => new Promise<T>(() => {})

/**
 * The runtime under the mind: notes every call (`events`, in order), and loads and chats as `onLoad` and `onChat`
 * say (by default a load as asked in 1.5 s, and an answer of two pieces the runtime counts as 2 tokens).
 */
function fakeRuntime() {
  const r = {
    caps: { ...CAPS } as Caps,
    loads: [] as LoadCall[],
    chats: [] as ChatCall[],
    unloads: 0,
    idles: 0,
    held: false,
    events: [] as string[],
    lines: ['runtime: a line of its log'] as readonly string[],
    onLoad: (c: LoadCall): Promise<{ gpu: boolean; ms: number }> => Promise.resolve({ gpu: c.o.gpu, ms: 1500 }),
    onChat: (c: ChatCall): Promise<ChatResult> => {
      c.o.onChunk({ text: 'hello ' })
      c.o.onChunk({ text: 'there' })
      return Promise.resolve({ reason: 'stop', tokens: 2 })
    },
    onIdle: (): Promise<void> => Promise.resolve(),
  }
  const runtime: InPageRuntime = {
    caps: () => r.caps,
    load: async (files, o) => {
      const c = { files, o }
      r.loads.push(c)
      r.events.push(`load ${o.gpu ? 'gpu' : 'cpu'}`)
      r.held = false
      const v = await r.onLoad(c)
      r.held = true
      return v
    },
    chat: (messages, o) => {
      const c = { messages, o }
      r.chats.push(c)
      r.events.push('chat')
      return r.onChat(c)
    },
    unload: async () => {
      r.unloads++
      r.events.push('unload')
      r.held = false
    },
    loaded: () => r.held,
    idle: () => {
      r.idles++
      return r.onIdle()
    },
    log: () => r.lines,
  }
  return { r, runtime }
}

/** A kept model of one file. */
const kept = (name: string, bytes = 400 * MIB, keptAt = 1): KeptModel => ({ id: `${name}-${keptAt}`, name, files: [{ name: `${name}.gguf`, bytes }], bytes, keptAt, durable: true })

/** The model store: `models` newest first; an id in `gone` has lost its files, one in `heads` has that header (else its files are empty). Every call is noted. */
function fakeStore(models: KeptModel[]) {
  const s = { models, gone: new Set<string>(), heads: new Map<string, Uint8Array<ArrayBuffer>>(), calls: [] as string[], line: 'kept in this page' }
  const store: ModelStore = {
    keep: async (files) => {
      s.calls.push('keep')
      const m = kept(files[0].name.replace(/\.gguf$/, ''), files[0].size, 100 + s.models.length)
      s.models.unshift(m)
      return m
    },
    list: async () => {
      s.calls.push('list')
      return [...s.models]
    },
    open: async (id) => {
      s.calls.push(`open ${id}`)
      const m = s.models.find((k) => k.id === id)
      if (!m || s.gone.has(id)) throw new CognitionError('offline', GONE)
      const head = s.heads.get(id)
      return m.files.map((f, i) => new File(i === 0 && head ? [head] : [], f.name))
    },
    forget: async (id) => {
      s.calls.push(id === undefined ? 'forget' : `forget ${id}`)
      const before = s.models.length
      s.models = id === undefined ? [] : s.models.filter((m) => m.id !== id)
      return before - s.models.length
    },
    usage: async () => null,
    storageLine: () => s.line,
  }
  return { s, store }
}

/** The page's local storage, for the guard. */
function memory() {
  const m = new Map<string, string>()
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) } }
}

/**
 * The browser's Web Locks for one origin, shared by its tabs: `tab(n)` is tab n's navigator.locks. A lock is held until
 * its callback's promise settles, or until its tab dies (`kill(n)`: the browser releases a dead tab's locks).
 */
function webLocks() {
  const held: { name: string; tab: number }[] = []
  return {
    held,
    tab: (n: number) => ({
      request: async (name: string, _o: { mode: 'shared' }, fn: () => Promise<void>): Promise<unknown> => {
        const entry = { name, tab: n }
        held.push(entry)
        try {
          return await fn()
        } finally {
          const i = held.indexOf(entry)
          if (i >= 0) held.splice(i, 1)
        }
      },
      query: async () => ({ held: held.map((h) => ({ name: h.name })) }),
    }),
    kill(n: number): void {
      for (let i = held.length - 1; i >= 0; i--) if (held[i].tab === n) held.splice(i, 1)
    },
  }
}

/** A slice of a store holding one JSON string. */
function slice(json: string | null) {
  const k = { json, load: () => k.json, save: (v: string) => { k.json = v } }
  return k
}

/** Timers that run only when the test moves the clock. */
function clock() {
  let now = 0
  let n = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    setTimer: (fn: () => void, ms: number): unknown => {
      timers.set(++n, { at: now + ms, fn })
      return n
    },
    clearTimer: (h: unknown): void => { timers.delete(h as number) },
    tick(ms: number): void {
      now += ms
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id)
          t.fn()
        }
      }
    },
    get pending(): number { return timers.size },
  }
}

/** Lets every pending callback run. */
const flush = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}

/**
 * A mind over the fakes: by default one model `tiny` kept and chosen, on a desktop without shader-f16. `busy` notes
 * each busy() as 'on cpu', 'on gpu' or 'off'; `phases` each phase line.
 */
async function harness(o: { models?: KeptModel[]; env?: Env; settings?: string | null; guard?: ReturnType<typeof memory>; locks?: ReturnType<ReturnType<typeof webLocks>['tab']>; timeouts?: Parameters<typeof createInPageMind>[0]['timeouts'] } = {}) {
  const { r, runtime } = fakeRuntime()
  const st = fakeStore(o.models ?? [kept('tiny')])
  const settings = slice(o.settings === undefined ? JSON.stringify({ model: 'tiny', think: false, gpu: 'auto' }) : o.settings)
  const guard = o.guard ?? memory()
  const c = clock()
  const busy: string[] = []
  const phases: (string | null)[] = []
  const at = { env: o.env ?? CPU_DESKTOP }
  const mind = createInPageMind({
    runtime: () => runtime, store: st.store, kept: settings, env: () => at.env, guard,
    busy: (on, place) => busy.push(on ? `on ${place?.gpu ? 'gpu' : 'cpu'}` : 'off'),
    onPhase: (text) => phases.push(text),
    setTimer: c.setTimer, clearTimer: c.clearTimer, now: () => 1000,
    ...(o.timeouts && { timeouts: o.timeouts }),
    // No Web Locks unless the test hands in a fake, never the host's: Node 24 has navigator.locks, and a real lock held
    // in this very process would put a lock name in every mark and keep the pages that "die" loading below alive.
    locks: o.locks ?? null,
  })
  // The mind reads the kept files once as it starts.
  await flush()
  return { mind, r, s: st.s, settings, guard, clock: c, busy, phases, at }
}

const TETHER: GateTether = { agent: 7, serial: 1, skills: ['Rust'] }
const req = (signal = new AbortController().signal, memories?: readonly Memories[]): AnswerRequest => ({ tethers: [TETHER], prompt: 'hi', signal, ...(memories && { memories }) })

/** A signal's reason as something to throw, as the runtime throws it. */
const reasonOf = (sig: AbortSignal): Error => (sig.reason instanceof Error ? sig.reason : new DOMException('aborted', 'AbortError'))

/** What `p` rejected with (null: it resolved). */
const rejection = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e)

/** `p` rejects with a CognitionError of `code` (and the message, when given). */
async function fails(p: Promise<unknown>, code: string, message?: string | RegExp): Promise<CognitionError> {
  const e = await rejection(p)
  assert.ok(e instanceof CognitionError, `expected a CognitionError, got ${String(e)}`)
  assert.equal(e.code, code, e.message)
  if (typeof message === 'string') assert.equal(e.message, message)
  else if (message) assert.match(e.message, message)
  return e
}

const crash = (model: string, gpu: boolean): string => JSON.stringify({ model, gpu, at: 5 })

test('the source: one system prompt, built as every provider builds it, and no wllama here', () => {
  const src = readFileSync(new URL('./inPage.ts', import.meta.url), 'utf8')
  assert.equal((src.match(/systemPrompt\(/g) ?? []).length, 1, 'one call, and no mention of it as a call anywhere else')
  assert.equal((src.match(/systemPrompt\(req\.tethers, req\.memories, req\.context, req\.steering\)/g) ?? []).length, 1)
  assert.doesNotMatch(src, /@wllama|wllama-runtime|wllamaRuntime\.ts'/, 'the runtime is handed in; this file never imports it')
  assert.equal(GUARD_KEY, 'civic-simulation:inpage:loading:v1')
})

test('ask alone: no request and no load; refuses in order: the browser, a page that died loading, a load that failed, a kept file gone', async () => {
  const h = await harness({ env: GPU_DESKTOP })
  const before = h.s.calls.length
  h.r.caps = { ...CAPS, jspi: false }
  h.guard.setItem(GUARD_KEY, crash('tiny', true))
  const off = runtimeMode(h.r.caps)
  assert.ok(!off.ok)
  await fails(h.mind.installed(), 'offline', off.reason)
  assert.equal(h.s.calls.length, before, 'the store is not even listed')

  h.r.caps = { ...CAPS }
  await fails(h.mind.installed(), 'offline', 'the page closed while it was loading tiny last time (the device may have run out of memory), so it is not loaded again on its own: ask file load tries again, on the processor')

  // A load that failed this visit: refused after the crash mark, before the list.
  h.guard.removeItem(GUARD_KEY)
  h.at.env = CPU_DESKTOP
  h.r.onLoad = () => Promise.reject(new CognitionError('model', 'not a GGUF model file'))
  await fails(h.mind.answer(req(), () => {}), 'model', 'tiny could not be loaded in this page: not a GGUF model file')
  const failed = 'tiny could not be loaded in this page this visit (not a GGUF model file): ask file load tries again'
  await fails(h.mind.installed(), 'offline', failed)
  h.guard.setItem(GUARD_KEY, crash('tiny', false))
  await fails(h.mind.installed(), 'offline', /^the page closed while it was loading tiny last time .*: ask file load tries again$/)
  assert.equal(h.r.loads.length, 1, 'refusing never loads')

  // Nothing kept and nothing chosen is no model, not a failure.
  const none = await harness({ models: [], settings: null })
  assert.deepEqual(await none.mind.installed(), [])
  // The chosen file gone: from the list, or its files from the storage.
  const gone = await harness({ models: [] })
  await fails(gone.mind.installed(), 'offline', GONE)
  const evicted = await harness()
  evicted.s.gone.add('tiny-1')
  await fails(evicted.mind.installed(), 'offline', GONE)

  const ok = await harness({ models: [kept('b', 400 * MIB, 2), kept('tiny')] })
  assert.deepEqual(await ok.mind.installed(), ['b', 'tiny'])
  assert.deepEqual(ok.s.calls, ['list', 'list', 'open tiny-1'], 'it lists and checks the files; it loads nothing')
  for (const x of [h, none, gone, evicted, ok]) assert.equal(x.r.loads.length + x.r.chats.length, x === h ? 1 : 0)
  assert.deepEqual(ok.busy, [])
})

test('an answer: the stop first, then the same refusals, then the fit; none of them loads or holds the city', async () => {
  const h = await harness()
  const before = h.s.calls.length
  const stopped = new AbortController()
  stopped.abort(new DOMException('stopped by the operator', 'AbortError'))
  h.r.caps = { ...CAPS, simd: false }
  const e = await rejection(h.mind.answer(req(stopped.signal), () => {}))
  assert.ok(e instanceof DOMException && e.name === 'AbortError' && e.message === 'stopped by the operator', String(e))
  assert.equal(h.s.calls.length, before)
  await fails(h.mind.answer(req(), () => {}), 'offline', /vector instructions/)
  h.r.caps = { ...CAPS }
  h.guard.setItem(GUARD_KEY, 'not even JSON')
  await fails(h.mind.answer(req(), () => {}), 'offline', /^the page closed while it was loading a model last time/)
  h.guard.removeItem(GUARD_KEY)

  const none = await harness({ models: [], settings: null })
  await fails(none.mind.answer(req(), () => {}), 'offline', NO_MODEL)
  const gone = await harness({ models: [kept('other')] })
  await fails(gone.mind.answer(req(), () => {}), 'offline', GONE)
  const huge = await harness({ models: [kept('huge', 5 * GIB)], settings: JSON.stringify({ model: 'huge' }) })
  await fails(huge.mind.answer(req(), () => {}), 'model', 'this model is 5.0 GB; this page can hold about 3.7 GB (a page gets 4 GB of memory in all)')
  for (const x of [h, none, gone, huge]) {
    assert.equal(x.r.loads.length, 0)
    assert.deepEqual(x.busy, [], 'nothing held the city')
  }

  // None chosen (the operator refuses first, but if reached): the newest kept.
  const newest = await harness({ models: [kept('new', 400 * MIB, 2), kept('old')], settings: null })
  assert.equal((await newest.mind.answer(req(), () => {})).text, 'hello there')
  assert.ok(newest.s.calls.includes('open new-2'))
  assert.equal(newest.mind.settings().model, null, 'answering does not choose for the operator')
})

test('answers that arrive together share one load, and the runtime answers one at a time', async () => {
  const h = await harness()
  const loaded = deferred<{ gpu: boolean; ms: number }>()
  h.r.onLoad = () => loaded.promise
  let live = 0
  let most = 0
  h.r.onChat = async (c) => {
    most = Math.max(most, ++live)
    await flush(2)
    c.o.onChunk({ text: 'one' })
    live--
    return { reason: 'stop', tokens: 1 }
  }
  const a = h.mind.answer(req(), () => {})
  const b = h.mind.answer(req(), () => {})
  const c = h.mind.answer(req(), () => {})
  await flush()
  assert.equal(h.r.loads.length, 1)
  loaded.resolve({ gpu: false, ms: 900 })
  assert.deepEqual((await Promise.all([a, b, c])).map((x) => x.text), ['one', 'one', 'one'])
  assert.equal(h.r.loads.length, 1, 'one load for the three')
  assert.equal(h.r.chats.length, 3)
  assert.equal(most, 1, 'never two chats at once')
  assert.deepEqual(h.busy, ['on cpu', 'off'], 'the city held once, for all three')
  assert.equal(h.phases[0], 'loading the model in this page')
  assert.equal(h.phases.at(-1), null)
})

test('an answer queued behind a load that fails is not loaded again', async () => {
  const h = await harness()
  const loaded = deferred<{ gpu: boolean; ms: number }>()
  h.r.onLoad = () => loaded.promise
  const a = h.mind.answer(req(), () => {})
  const b = h.mind.answer(req(), () => {})
  await flush()
  loaded.reject(new CognitionError('server', 'the runtime in this page stopped while it loaded the model'))
  await fails(a, 'model', 'tiny could not be loaded in this page: the runtime in this page stopped while it loaded the model')
  await fails(b, 'offline', /^tiny could not be loaded in this page this visit/)
  assert.equal(h.r.loads.length, 1)
  assert.deepEqual(h.busy, ['on cpu', 'off'])
})

test('the crash guard: written before the load and removed after it, either way', async () => {
  const h = await harness({ env: GPU_DESKTOP })
  let seen: unknown = null
  h.r.onLoad = (c) => {
    seen = JSON.parse(h.guard.getItem(GUARD_KEY) ?? 'null')
    return Promise.resolve({ gpu: c.o.gpu, ms: 10 })
  }
  await h.mind.answer(req(), () => {})
  assert.deepEqual(seen, { model: 'tiny', gpu: true, at: 1000 })
  assert.equal(h.guard.getItem(GUARD_KEY), null)

  const bad = await harness()
  bad.r.onLoad = () => {
    assert.notEqual(bad.guard.getItem(GUARD_KEY), null)
    return Promise.reject(new CognitionError('model', 'out of memory'))
  }
  await fails(bad.mind.answer(req(), () => {}), 'model')
  assert.equal(bad.guard.getItem(GUARD_KEY), null, 'a failed load is not a crash')

  // While its own load runs, ask alone is not refused by its own guard.
  const busy = await harness()
  const loaded = deferred<{ gpu: boolean; ms: number }>()
  busy.r.onLoad = () => loaded.promise
  const a = busy.mind.answer(req(), () => {})
  await flush()
  assert.notEqual(busy.guard.getItem(GUARD_KEY), null)
  assert.deepEqual(await busy.mind.installed(), ['tiny'])
  loaded.resolve({ gpu: false, ms: 5 })
  await a
})

test('a page that died loading leaves the guard: the next page refuses until ask file load, which tries again on the processor', async () => {
  const guard = memory()
  const first = await harness({ env: GPU_DESKTOP, guard })
  first.r.onLoad = () => never()
  void first.mind.answer(req(), () => {})
  await flush()
  // The page dies here: nothing settles, nothing is disposed.
  assert.deepEqual(JSON.parse(guard.getItem(GUARD_KEY) ?? 'null'), { model: 'tiny', gpu: true, at: 1000 })

  const next = await harness({ env: GPU_DESKTOP, guard })
  const why = 'the page closed while it was loading tiny last time (the device may have run out of memory), so it is not loaded again on its own: ask file load tries again, on the processor'
  await fails(next.mind.installed(), 'offline', why)
  await fails(next.mind.answer(req(), () => {}), 'offline', why)
  assert.equal(next.r.loads.length, 0)
  assert.match(await next.mind.load(), /^tiny is loaded in this page \(CPU, 4 threads, 8192 tokens of context, in 1\.5 s\)$/)
  assert.deepEqual(next.r.loads.map((l) => l.o.gpu), [false], 'the processor this time, though the GPU would be chosen')
  assert.equal(guard.getItem(GUARD_KEY), null)
  assert.match(next.mind.settings().runtime ?? '', /the page closed while the model was loading onto the GPU last time, so it runs on the processor this visit/)
  assert.deepEqual(await next.mind.installed(), ['tiny'])
  assert.equal((await next.mind.answer(req(), () => {})).text, 'hello there')
  assert.equal(next.r.loads.length, 1, 'the answer used what load() loaded')
})

test('keeping the file again after a page died loading clears the mark as ask file load does: after a GPU crash, the processor', async () => {
  for (const gpu of [true, false]) {
    const guard = memory()
    guard.setItem(GUARD_KEY, crash('tiny', gpu))
    const h = await harness({ env: GPU_DESKTOP, guard })
    await fails(h.mind.answer(req(), () => {}), 'offline', /^the page closed while it was loading tiny last time/)
    // Menu › Model file with the same file: the store hands back the same model.
    await h.mind.keep([new File([new Uint8Array(64)], 'tiny.gguf')])
    assert.equal(guard.getItem(GUARD_KEY), null)
    await h.mind.answer(req(), () => {})
    assert.deepEqual(h.r.loads.map((l) => l.o.gpu), [!gpu], gpu ? 'not the load that took the page down' : 'a crash on the processor leaves the GPU to auto')
    const row = h.mind.settings().runtime ?? ''
    if (gpu) assert.match(row, /the page closed while the model was loading onto the GPU last time, so it runs on the processor this visit/)
    else assert.doesNotMatch(row, /the page closed/)
  }
})

test('dispose: the page lived, so the guard goes, and an answer hanging on the load settles at once', async () => {
  const h = await harness()
  h.r.onLoad = () => never()
  const a = h.mind.answer(req(), () => {})
  await flush()
  assert.notEqual(h.guard.getItem(GUARD_KEY), null)
  const disposed = h.mind.dispose()
  assert.equal(h.guard.getItem(GUARD_KEY), null, 'gone before anything waits: the page may be closing')
  await disposed
  await fails(a, 'server', 'the model in this page was shut down')
  assert.deepEqual(h.busy, ['on cpu', 'off'])
  assert.equal(h.clock.pending, 0, 'no timer left behind')
  await fails(h.mind.answer(req(), () => {}), 'offline', 'the model in this page was shut down')

  // A mark an earlier page left is not this page's to clear: it stays until ask file load.
  const marked = await harness()
  marked.guard.setItem(GUARD_KEY, crash('tiny', false))
  await marked.mind.dispose()
  assert.equal(marked.guard.getItem(GUARD_KEY), crash('tiny', false))
})

test('a page that unloads while its load runs (pagehide: a reload, a closed tab, the city restarting) takes its mark with it; one that comes back writes it again', async () => {
  const guard = memory()
  const h = await harness({ guard })
  const gate = deferred<{ gpu: boolean; ms: number }>()
  h.r.onLoad = () => gate.promise
  const loading = h.mind.load()
  await flush()
  assert.deepEqual(JSON.parse(guard.getItem(GUARD_KEY) ?? 'null'), { model: 'tiny', gpu: false, at: 1000 })
  h.mind.leave()
  assert.equal(guard.getItem(GUARD_KEY), null, 'a page that unloads did not die in its load')
  // The next page, after the reload: no crash to refuse for.
  const next = await harness({ guard })
  assert.deepEqual(await next.mind.installed(), ['tiny'])
  assert.equal(next.mind.settings().runtime?.includes('the page closed'), false)
  // The page back from the browser's back/forward cache with its load still running: marked again until it settles.
  h.mind.foreground()
  assert.deepEqual(JSON.parse(guard.getItem(GUARD_KEY) ?? 'null'), { model: 'tiny', gpu: false, at: 1000 })
  gate.resolve({ gpu: false, ms: 5 })
  await loading
  assert.equal(guard.getItem(GUARD_KEY), null)
  // With no load running, leaving touches nothing: a mark an earlier page left stays.
  guard.setItem(GUARD_KEY, crash('tiny', false))
  h.mind.leave()
  h.mind.foreground()
  assert.equal(guard.getItem(GUARD_KEY), crash('tiny', false))
})

test('two tabs: a load running in one is not a crash to the other, which neither refuses for it nor clears it; a tab that dies loading is', async () => {
  const guard = memory()
  const locks = webLocks()
  const tab1 = await harness({ guard, locks: locks.tab(1) })
  const tab2 = await harness({ guard, locks: locks.tab(2) })
  const gate = deferred<{ gpu: boolean; ms: number }>()
  tab1.r.onLoad = () => gate.promise
  const loading = tab1.mind.load()
  await flush()
  const mark = JSON.parse(guard.getItem(GUARD_KEY) ?? 'null') as { model: string; gpu: boolean; lock?: string }
  assert.equal(mark.model, 'tiny')
  assert.ok(typeof mark.lock === 'string' && locks.held.some((l) => l.name === mark.lock && l.tab === 1), 'tab 1 holds the lock its mark names while it loads')
  // Tab 2 sees a load running, not a page that died: it is not refused, and its word to try again leaves tab 1's mark.
  const marks = (): { lock?: string }[] => { const v = JSON.parse(guard.getItem(GUARD_KEY) ?? '[]') as unknown; return (Array.isArray(v) ? v : [v]) as { lock?: string }[] }
  let during: (string | undefined)[] = []
  tab2.r.onLoad = (c) => {
    during = marks().map((m) => m.lock)
    return Promise.resolve({ gpu: c.o.gpu, ms: 5 })
  }
  assert.deepEqual(await tab2.mind.installed(), ['tiny'])
  assert.equal(await rejection(tab2.mind.answer(req(), () => {})), null)
  assert.equal(during.length, 2, 'while both load, the key lists both marks')
  assert.equal(during[0], mark.lock)
  assert.ok(typeof during[1] === 'string' && during[1] !== mark.lock)
  await tab2.mind.unload()
  assert.match(await tab2.mind.load(), /^tiny is loaded in this page/)
  assert.deepEqual(marks().map((m) => m.lock), [mark.lock], 'tab 2 loaded beside it and took only its own mark away')
  // Tab 1's load ends: its mark goes, and the lock with it.
  gate.resolve({ gpu: false, ms: 5 })
  await loading
  assert.equal(guard.getItem(GUARD_KEY), null)
  assert.equal(locks.held.length, 0)

  // Tab 1 loads again, a third tab starts a load beside it, and tab 1 dies in its load (the browser releases a dead
  // tab's locks; its mark stays).
  await tab1.mind.unload()
  tab1.r.onLoad = () => never()
  void tab1.mind.load()
  await flush()
  const tab3 = await harness({ guard, locks: locks.tab(3) })
  const gate3 = deferred<{ gpu: boolean; ms: number }>()
  tab3.r.onLoad = () => gate3.promise
  const loading3 = tab3.mind.load()
  await flush()
  assert.equal(marks().length, 2)
  const live = marks()[1].lock
  locks.kill(1)
  await fails(tab2.mind.installed(), 'offline', /^the page closed while it was loading tiny last time/)
  // Only the mark whose tab is gone is cleared by the word to try again: tab 3's load keeps its own.
  await tab2.mind.unload()
  assert.match(await tab2.mind.load(), /^tiny is loaded in this page/)
  assert.deepEqual(marks().map((m) => m.lock), [live])
  gate3.resolve({ gpu: false, ms: 5 })
  await loading3
  assert.equal(guard.getItem(GUARD_KEY), null)
})

test('a mind given no locks finds the page\'s navigator.locks, as the product does: its mark names a lock that page holds, let go with the mark', async () => {
  // The harness above always names its locks (null or a fake), so the product's own discovery is pinned here, on a
  // faked page navigator: the same on Node 22, which has no navigator.locks, and Node 24, which has.
  const locks = webLocks()
  const was = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, get: () => ({ locks: locks.tab(1) }) })
  try {
    const { r, runtime } = fakeRuntime()
    const st = fakeStore([kept('tiny')])
    const guard = memory()
    const mind = createInPageMind({ runtime: () => runtime, store: st.store, kept: slice(JSON.stringify({ model: 'tiny', think: false, gpu: 'auto' })), env: () => CPU_DESKTOP, guard, now: () => 1000 })
    await flush()
    const gate = deferred<{ gpu: boolean; ms: number }>()
    r.onLoad = () => gate.promise
    const loading = mind.load()
    await flush()
    const mark = JSON.parse(guard.getItem(GUARD_KEY) ?? 'null') as { model: string; lock?: string }
    assert.equal(mark.model, 'tiny')
    assert.ok(typeof mark.lock === 'string' && locks.held.some((l) => l.name === mark.lock && l.tab === 1), 'the mark names a lock held through the page\'s navigator.locks')
    gate.resolve({ gpu: false, ms: 5 })
    await loading
    assert.equal(guard.getItem(GUARD_KEY), null)
    assert.equal(locks.held.length, 0, 'the lock went with the mark')
    await mind.dispose()
  } finally {
    if (was) Object.defineProperty(globalThis, 'navigator', was)
    else delete (globalThis as { navigator?: unknown }).navigator
  }
})

test('a GPU load that fails is tried once on the processor, and the GPU is off for the visit', async () => {
  const h = await harness({ env: GPU_DESKTOP })
  h.r.onLoad = (c) => (c.o.gpu ? Promise.reject(new CognitionError('model', 'the GPU ran out of memory')) : Promise.resolve({ gpu: false, ms: 2000 }))
  assert.equal((await h.mind.answer(req(), () => {})).text, 'hello there')
  assert.deepEqual(h.r.events, ['load gpu', 'unload', 'load cpu', 'chat'])
  const row = h.mind.settings().runtime ?? ''
  assert.match(row, /CPU, 4 threads, 8192 tokens of context, loaded in 2\.0 s/)
  assert.match(row, /the GPU could not load tiny \(the GPU ran out of memory\), so it runs on the processor this visit/)
  await h.mind.answer(req(), () => {})
  assert.equal(h.r.loads.length, 2, 'the processor load is kept, not tried on the GPU again')
  assert.deepEqual(h.busy, ['on gpu', 'off', 'on cpu', 'off'])
})

test('answers that arrive together when the GPU load fails: the GPU is tried once and the processor loads once for all of them', async () => {
  const h = await harness({ env: GPU_DESKTOP })
  h.r.onLoad = (c) => (c.o.gpu ? Promise.reject(new CognitionError('model', 'the GPU ran out of memory')) : Promise.resolve({ gpu: false, ms: 2000 }))
  // Each placed itself on the GPU as it arrived; the ones that waited are placed again in their turn.
  const answers = await Promise.all([1, 2, 3].map(() => h.mind.answer(req(), () => {})))
  assert.deepEqual(answers.map((a) => a.text), ['hello there', 'hello there', 'hello there'])
  assert.deepEqual(h.r.events, ['load gpu', 'unload', 'load cpu', 'chat', 'chat', 'chat'])
  assert.deepEqual(h.busy, ['on gpu', 'off'])
})

test('on the GPU a model may be larger than the processor holds; when the GPU fails it is refused for the processor, not tried there', async () => {
  const big = kept('big', 4.5 * GIB)
  const warn = 'this model is 4.5 GB; above 4.0 GB this page may answer slowly or run out of memory'
  const h = await harness({ env: GPU_DESKTOP, models: [big], settings: JSON.stringify({ model: 'big' }) })
  assert.equal(await h.mind.load(), `big is loaded in this page (WebGPU, 8192 tokens of context, in 1.5 s): ${warn}`)
  assert.match(h.mind.settings().runtime ?? '', new RegExp(`; ${warn}$`))
  // The operator turns the GPU off: refused for the processor before anything waits, and the idle unload still comes.
  assert.equal(h.clock.pending, 1)
  h.mind.setGpu('off')
  await fails(h.mind.answer(req(), () => {}), 'model', /^this model is 4\.5 GB; this page can hold about 3\.7 GB/)
  assert.equal(h.clock.pending, 1, 'the idle timer of the model still loaded is left armed')
  assert.deepEqual(h.busy, ['on gpu', 'off'])

  // 3.5 GB: no warning on the GPU; when the GPU fails it runs on the processor, with the processor's warning.
  const mid = await harness({ env: GPU_DESKTOP, models: [kept('mid', 3.5 * GIB)], settings: JSON.stringify({ model: 'mid' }) })
  mid.r.onLoad = (c) => (c.o.gpu ? Promise.reject(new CognitionError('model', 'the GPU ran out of memory')) : Promise.resolve({ gpu: false, ms: 1500 }))
  assert.equal(await mid.mind.load(), 'mid is loaded in this page (CPU, 4 threads, 8192 tokens of context, in 1.5 s): this model is 3.5 GB; above 3.0 GB this page may answer slowly or run out of memory')

  const failing = await harness({ env: GPU_DESKTOP, models: [big], settings: JSON.stringify({ model: 'big' }) })
  failing.r.onLoad = () => Promise.reject(new CognitionError('model', 'the GPU ran out of memory'))
  const why = 'the GPU could not load it (the GPU ran out of memory), and on the processor this model is 4.5 GB; this page can hold about 3.7 GB (a page gets 4 GB of memory in all)'
  await fails(failing.mind.answer(req(), () => {}), 'model', `big could not be loaded in this page: ${why}`)
  assert.deepEqual(failing.r.events, ['load gpu', 'unload'], 'no load on the processor')
  assert.doesNotMatch(failing.mind.settings().runtime ?? '', /so it runs on the processor/)
  assert.match(failing.mind.settings().runtime ?? '', /the last load failed: the GPU could not load it/)
  await fails(failing.mind.answer(req(), () => {}), 'offline', /^big could not be loaded in this page this visit/)
  // ask file load: the GPU failed this visit, so the processor's limit refuses it before any load.
  await fails(failing.mind.load(), 'model', 'this model is 4.5 GB; this page can hold about 3.7 GB (a page gets 4 GB of memory in all)')
  assert.equal(failing.r.loads.length, 1)
  assert.deepEqual(failing.busy, ['on gpu', 'off'])
})

test('a second failure is model, marks the visit and loads nothing more until ask file load', async () => {
  const h = await harness({ env: GPU_DESKTOP })
  h.r.onLoad = () => Promise.reject(new CognitionError('timeout', 'the runtime did not start within 30 s'))
  await fails(h.mind.answer(req(), () => {}), 'model', 'tiny could not be loaded in this page on the GPU or on the processor: the runtime did not start within 30 s')
  assert.deepEqual(h.r.loads.map((l) => l.o.gpu), [true, false])
  await fails(h.mind.answer(req(), () => {}), 'offline', 'tiny could not be loaded in this page this visit (the runtime did not start within 30 s): ask file load tries again')
  await fails(h.mind.installed(), 'offline')
  assert.equal(h.r.loads.length, 2, 'no third load')
  assert.match(h.mind.settings().runtime ?? '', /the last load failed: the runtime did not start within 30 s/)
  // The operator's word: one more load (on the processor, the GPU having failed this visit).
  await fails(h.mind.load(), 'model')
  assert.deepEqual(h.r.loads.map((l) => l.o.gpu), [true, false, false])
  h.r.onLoad = (c) => Promise.resolve({ gpu: c.o.gpu, ms: 1500 })
  assert.match(await h.mind.load(), /^tiny is loaded in this page \(CPU, 4 threads/)
  assert.equal((await h.mind.answer(req(), () => {})).text, 'hello there')
  assert.equal(h.r.loads.length, 4)

  // On the processor from the start: one load, then the same mark.
  const cpu = await harness()
  cpu.r.onLoad = () => Promise.reject(new CognitionError('model', 'not a GGUF model file'))
  await fails(cpu.mind.answer(req(), () => {}), 'model', 'tiny could not be loaded in this page: not a GGUF model file')
  assert.equal(cpu.r.loads.length, 1)
})

test('the runtime stopping mid-answer is server, and the next ask loads the model again; a prompt too long leaves it loaded', async () => {
  const h = await harness()
  h.r.onChat = (c) => {
    c.o.onChunk({ text: 'half' })
    return Promise.reject(new CognitionError('server', 'the runtime in this page stopped: the next ask loads it again'))
  }
  const pieces: string[] = []
  await fails(h.mind.answer(req(), (p) => pieces.push(p.text)), 'server', 'the runtime in this page stopped: the next ask loads it again')
  assert.deepEqual(pieces, ['half'])
  assert.equal(h.r.unloads, 1)
  h.r.onChat = () => Promise.reject(new CognitionError('model', 'the prompt is longer than the model can read (8192 tokens)'))
  await fails(h.mind.answer(req(), () => {}), 'model')
  assert.equal(h.r.loads.length, 2, 'loaded again after the stop')
  assert.equal(h.r.unloads, 1, 'a prompt too long does not unload it')
  h.r.onChat = () => Promise.reject(new CognitionError('timeout', 'the model sent nothing for 5 minutes'))
  await fails(h.mind.answer(req(), () => {}), 'timeout')
  assert.equal(h.r.unloads, 2, 'a timeout unloads it')
  assert.deepEqual(h.busy, ['on cpu', 'off', 'on cpu', 'off', 'on cpu', 'off'])
})

test('a runtime that never settles: release() settles the answer at once with server, at the load or mid-answer', async () => {
  const h = await harness()
  h.r.onChat = (c) => {
    c.o.onChunk({ text: 'part' })
    return never()
  }
  const a = h.mind.answer(req(), () => {})
  await flush()
  await h.mind.release('released for the test')
  await fails(a, 'server', 'released for the test')
  assert.equal(h.r.unloads, 1)
  assert.deepEqual(h.busy, ['on cpu', 'off'])

  h.r.onLoad = () => never()
  const b = h.mind.answer(req(), () => {})
  await flush()
  await h.mind.release('released again')
  await fails(b, 'server', 'released again')
  assert.equal(h.guard.getItem(GUARD_KEY), null, 'the page lived')

  // The next ask starts afresh.
  h.r.onLoad = (c) => Promise.resolve({ gpu: c.o.gpu, ms: 1 })
  h.r.onChat = (c) => { c.o.onChunk({ text: 'back' }); return Promise.resolve({ reason: 'stop', tokens: 1 }) }
  assert.equal((await h.mind.answer(req(), () => {})).text, 'back')
  assert.equal(h.phases.at(-1), null)
})

test('the operator\'s stop: before the load, during it and mid-answer; a chunk after it is no part of the answer', async () => {
  const h = await harness()
  const before = new AbortController()
  before.abort()
  const e = await rejection(h.mind.answer(req(before.signal), () => {}))
  assert.ok(e instanceof DOMException && e.name === 'AbortError')
  assert.equal(h.r.loads.length, 0)

  h.r.onLoad = () => never()
  const during = new AbortController()
  const a = h.mind.answer(req(during.signal), () => {})
  await flush()
  during.abort(new DOMException('stopped by the operator', 'AbortError'))
  const stoppedLoad = await rejection(a)
  assert.ok(stoppedLoad instanceof DOMException && stoppedLoad.message === 'stopped by the operator')
  assert.equal(h.r.loads[0].o.signal.aborted, true, 'the load was told to stop')
  assert.equal(h.guard.getItem(GUARD_KEY), null)
  assert.deepEqual(h.busy, ['on cpu', 'off'])
  assert.deepEqual(await h.mind.installed(), ['tiny'], 'a stop is not a failed load')

  h.r.onLoad = (c) => Promise.resolve({ gpu: c.o.gpu, ms: 1 })
  const mid = new AbortController()
  const after = deferred<void>()
  h.r.onChat = async (c) => {
    c.o.onChunk({ text: 'a' })
    await after.promise
    c.o.onChunk({ text: 'b' })
    c.o.onChunk({ thinking: 'c' })
    return never()
  }
  const pieces: Piece[] = []
  const b = rejection(h.mind.answer(req(mid.signal), (p) => pieces.push(p)))
  await flush()
  mid.abort(new DOMException('stopped by the operator', 'AbortError'))
  after.resolve()
  await flush()
  const stoppedChat = await b
  assert.ok(stoppedChat instanceof DOMException && stoppedChat.name === 'AbortError')
  assert.deepEqual(pieces, [{ kind: 'text', text: 'a' }])
  assert.equal(h.r.chats[0].o.signal.aborted, true)
  assert.deepEqual(h.busy, ['on cpu', 'off', 'on cpu', 'off'])
})

test('a piece the operator tier refuses ends the answer with that error', async () => {
  const h = await harness()
  const refused = new Error('the answer failed the 14A screen')
  const pieces: string[] = []
  const e = await rejection(h.mind.answer(req(), (p) => {
    pieces.push(p.text)
    throw refused
  }))
  assert.equal(e, refused)
  assert.deepEqual(pieces, ['hello '], 'nothing after the refused piece')
})

test('tokens: the runtime\'s count, else the pieces of text; reason: the runtime\'s, else stop', async () => {
  const h = await harness()
  const answer = async (result: ChatResult) => {
    h.r.onChat = (c) => {
      for (const t of ['a', 'b', 'c']) c.o.onChunk({ text: t })
      c.o.onChunk({ thinking: 'x' })
      c.o.onChunk({ thinking: 'y' })
      return Promise.resolve(result)
    }
    return h.mind.answer(req(), () => {})
  }
  const counted = await answer({ reason: 'length', tokens: 42 })
  assert.deepEqual([counted.text, counted.tokens, counted.thinking, counted.reason], ['abc', 42, 2, 'length'])
  const uncounted = await answer({ reason: '', tokens: null })
  assert.deepEqual([uncounted.tokens, uncounted.thinking, uncounted.reason], [3, 2, 'stop'], 'text pieces only; thinking is not counted')
  assert.equal((await answer({ reason: 'stop', tokens: Number.NaN })).tokens, 3)
  assert.equal((await answer({ reason: 'stop', tokens: 0 })).tokens, 0, 'a count of none is a count')
})

test('thinking as pieces of its own, the prompt\'s progress as the phase line, and the line cleared when the answer begins', async () => {
  const h = await harness()
  h.r.onChat = (c) => {
    c.o.onChunk({ progress: { processed: 0, total: 200 } })
    c.o.onChunk({ progress: { processed: 101, total: 200 } })
    c.o.onChunk({ thinking: 'hmm' })
    c.o.onChunk({ text: 'ok' })
    c.o.onChunk({ progress: { processed: 1, total: 0 } })
    return Promise.resolve({ reason: 'stop', tokens: null })
  }
  const pieces: Piece[] = []
  const a = await h.mind.answer(req(), (p) => pieces.push(p))
  assert.deepEqual(pieces, [{ kind: 'thinking', text: 'hmm' }, { kind: 'text', text: 'ok' }])
  assert.equal(a.thinking, 1)
  assert.equal(a.text, 'ok')
  assert.deepEqual(h.phases, ['loading the model in this page', null, 'reading the prompt 0%', 'reading the prompt 50%', null])
})

test('the phase line is cleared only by the load or answer that set it, never by one that waited its turn or finished before', async () => {
  // An answer stopped while it waits behind a load: the load's line stays until the load is done.
  const h = await harness()
  const loaded = deferred<{ gpu: boolean; ms: number }>()
  h.r.onLoad = () => loaded.promise
  const a = h.mind.answer(req(), () => {})
  await flush()
  const stopB = new AbortController()
  const b = rejection(h.mind.answer(req(stopB.signal), () => {}))
  await flush()
  stopB.abort()
  assert.ok((await b) instanceof DOMException)
  await flush()
  assert.deepEqual(h.phases, ['loading the model in this page'], 'still loading')
  loaded.resolve({ gpu: false, ms: 5 })
  await a
  assert.deepEqual(h.phases, ['loading the model in this page', null])

  // An answer that finishes while the next one, placed elsewhere, loads: the next one's line stays.
  const n = await harness({ env: GPU_DESKTOP })
  const first = deferred<ChatResult>()
  let chats = 0
  n.r.onChat = (c) => {
    c.o.onChunk({ text: 'x' })
    return ++chats === 1 ? first.promise : Promise.resolve({ reason: 'stop', tokens: 1 })
  }
  const one = n.mind.answer(req(), () => {})
  await flush()
  n.mind.setGpu('off')
  const two = n.mind.answer(req(), () => {})
  await flush()
  const reload = deferred<{ gpu: boolean; ms: number }>()
  n.r.onLoad = () => reload.promise
  first.resolve({ reason: 'stop', tokens: 1 })
  await one
  await flush()
  assert.deepEqual(n.r.events, ['load gpu', 'chat', 'unload', 'load cpu'])
  assert.equal(n.phases.at(-1), 'loading the model in this page')
  reload.resolve({ gpu: false, ms: 1 })
  await two
  assert.equal(n.phases.at(-1), null)

  // Stopped mid-prompt: the answer clears its own progress line.
  const p = await harness()
  const c = new AbortController()
  p.r.onChat = (call) => {
    call.o.onChunk({ progress: { processed: 10, total: 100 } })
    return never()
  }
  const s = p.mind.answer(req(c.signal), () => {})
  await flush()
  assert.equal(p.phases.at(-1), 'reading the prompt 10%')
  c.abort()
  await rejection(s)
  assert.equal(p.phases.at(-1), null)
})

test('what the runtime is handed: the shared system prompt and the prompt, its hash, the waits and the placement', async () => {
  const h = await harness()
  const memories = [{ agent: 7, lines: ['met the operator at the pier'] }]
  const a = await h.mind.answer(req(undefined, memories), () => {})
  const system = systemPrompt([TETHER], memories)
  assert.deepEqual(h.r.chats[0].messages, [{ role: 'system', content: system }, { role: 'user', content: 'hi' }])
  assert.equal(a.promptHash, promptHash(system))
  const place = placement({ ...CPU_DESKTOP, gpuMode: 'auto', gpuFailed: false })
  const { signal: chatSignal, onChunk, ...chat } = h.r.chats[0].o
  assert.ok(chatSignal instanceof AbortSignal && typeof onChunk === 'function')
  assert.deepEqual(chat, { maxTokens: place.maxTokens, think: false, firstMs: FIRST_PIECE_MS, stallMs: STALL_MS })
  const { signal: loadSignal, ...load } = h.r.loads[0].o
  assert.ok(loadSignal instanceof AbortSignal)
  assert.deepEqual(load, { ctx: 8192, threads: 4, gpu: false, warmup: true, startMs: START_MS, loadMs: LOAD_MS }, 'a discrete desktop leaves the batches to wllama')
  assert.equal(h.r.loads[0].files.length, 1)
  assert.equal((h.r.loads[0].files[0] as File).name, 'tiny.gguf')

  // A phone: its own batches and length; think as the operator set it; the waits as handed in.
  const phone = await harness({ env: PHONE, timeouts: { firstMs: 5, stallMs: 6, loadMs: 7, startMs: 8 } })
  assert.equal(phone.mind.setThink?.(true), true)
  await phone.mind.answer(req(), () => {})
  const { signal: _p, ...phoneLoad } = phone.r.loads[0].o
  assert.deepEqual(phoneLoad, { ctx: 4096, threads: 1, gpu: false, batch: 256, ubatch: 128, warmup: false, startMs: 8, loadMs: 7 })
  const { signal: _c, onChunk: _o, ...phoneChat } = phone.r.chats[0].o
  assert.deepEqual(phoneChat, { maxTokens: 512, think: true, firstMs: 5, stallMs: 6 })
})

test('a load asks for no more context than the model was trained on (its header says), the lines say so, and the next answer keeps it', async () => {
  const head = (n: number): Uint8Array<ArrayBuffer> => ggufBytes([['general.architecture', T.STRING, 'llama'], ['llama.context_length', T.U32, n]])
  const h = await harness()
  h.s.heads.set('tiny-1', head(4096))
  // Before its header is read, the row can only say the plan's context.
  assert.match(h.mind.settings().runtime ?? '', /not loaded: the next ask loads it \(CPU, 4 threads, 8192 tokens of context\)/)
  await h.mind.answer(req(), () => {})
  assert.equal(h.r.loads.length, 1)
  assert.equal(h.r.loads[0].o.ctx, 4096)
  assert.match(h.mind.settings().runtime ?? '', /CPU, 4 threads, 4096 tokens of context, loaded in 1\.5 s/)
  // Placed again for the next answer, it is the same load: the model is kept, not loaded again.
  await h.mind.answer(req(), () => {})
  assert.equal(h.r.loads.length, 1)
  await h.mind.unload()
  assert.match(h.mind.settings().runtime ?? '', /not loaded: the next ask loads it \(CPU, 4 threads, 4096 tokens of context\)/)
  assert.equal(await h.mind.load(), 'tiny is loaded in this page (CPU, 4 threads, 4096 tokens of context, in 1.5 s)')
  assert.equal(h.r.loads[1].o.ctx, 4096)

  // Trained on more than the plan asks for, a header that names no context, or none that can be read: the plan's.
  for (const bytes of [head(32768), ggufBytes([['general.architecture', T.STRING, 'llama']]), new Uint8Array(new ArrayBuffer(8))]) {
    const k = await harness()
    k.s.heads.set('tiny-1', bytes)
    await k.mind.answer(req(), () => {})
    assert.equal(k.r.loads[0].o.ctx, 8192)
    await k.mind.answer(req(), () => {})
    assert.equal(k.r.loads.length, 1)
  }
})

test('idle: the model is unloaded ten minutes after the last answer, never while one is in flight', async () => {
  const h = await harness()
  await h.mind.answer(req(), () => {})
  assert.equal(h.clock.pending, 1)
  h.clock.tick(IDLE_UNLOAD_MS - 1)
  assert.equal(h.r.unloads, 0)
  h.clock.tick(1)
  await flush()
  assert.equal(h.r.unloads, 1)
  assert.match(h.mind.settings().runtime ?? '', /not loaded: the next ask loads it \(CPU, 4 threads, 8192 tokens of context\)/)
  await h.mind.answer(req(), () => {})
  assert.equal(h.r.loads.length, 2)

  const slow = deferred<ChatResult>()
  h.r.onChat = () => slow.promise
  const a = h.mind.answer(req(), () => {})
  await flush()
  h.clock.tick(IDLE_UNLOAD_MS * 3)
  await flush()
  assert.equal(h.r.unloads, 1, 'the earlier timer was cleared when this answer began')
  slow.resolve({ reason: 'stop', tokens: 0 })
  await a
  assert.equal(h.clock.pending, 1, 'armed again once it is done')
})

test('a phone in the background: unloaded after a minute hidden, an answer in flight told why; back in time, nothing; a desktop never', async () => {
  const h = await harness({ env: PHONE })
  await h.mind.answer(req(), () => {})
  h.mind.background()
  h.clock.tick(HIDDEN_UNLOAD_MS - 1)
  h.mind.foreground()
  h.clock.tick(HIDDEN_UNLOAD_MS)
  await flush()
  assert.equal(h.r.unloads, 0)
  h.mind.background()
  h.clock.tick(HIDDEN_UNLOAD_MS)
  await flush()
  assert.equal(h.r.unloads, 1)

  h.r.onChat = () => never()
  const a = h.mind.answer(req(), () => {})
  await flush()
  h.mind.background()
  h.clock.tick(HIDDEN_UNLOAD_MS)
  await fails(a, 'server', HIDDEN)

  const desk = await harness()
  await desk.mind.answer(req(), () => {})
  desk.mind.background()
  desk.clock.tick(HIDDEN_UNLOAD_MS)
  await flush()
  assert.equal(desk.r.unloads, 0)
})

test('a GPU reset turns the GPU off for this page when the model was on it, or loading onto it, and nothing otherwise', async () => {
  const h = await harness({ env: GPU_DESKTOP })
  await h.mind.answer(req(), () => {})
  h.mind.noteGpuReset()
  await flush()
  assert.equal(JSON.parse(h.settings.json ?? '{}').gpu, 'off')
  assert.equal(h.r.unloads, 1)
  assert.match(h.mind.settings().runtime ?? '', /the GPU was reset while the model was on it, so it runs on the processor from now on/)
  await h.mind.answer(req(), () => {})
  assert.deepEqual(h.r.loads.map((l) => l.o.gpu), [true, false])

  const loading = await harness({ env: GPU_DESKTOP })
  loading.r.onLoad = () => never()
  const a = loading.mind.answer(req(), () => {})
  await flush()
  loading.mind.noteGpuReset()
  await fails(a, 'server', /^the GPU was reset while the model was on it/)
  assert.equal(JSON.parse(loading.settings.json ?? '{}').gpu, 'off')

  const cpu = await harness()
  await cpu.mind.answer(req(), () => {})
  const was = cpu.settings.json
  cpu.mind.noteGpuReset()
  assert.equal(cpu.settings.json, was)
  assert.equal(cpu.r.unloads, 0)
})

test('setModel chooses among the kept files and a new choice unloads the one in use; setServer and setGpu refuse plainly', async () => {
  const h = await harness({ models: [kept('a', 400 * MIB, 2), kept('b')], settings: JSON.stringify({ model: 'a' }) })
  await h.mind.answer(req(), () => {})
  assert.throws(() => h.mind.setModel('zzz'), (e: unknown) => e instanceof Error && !(e instanceof CognitionError) && e.message === "no model file named 'zzz' is kept in this page: a, b")
  assert.equal(h.mind.setModel('a'), 'a')
  await flush()
  assert.equal(h.r.unloads, 0, 'the same choice keeps it loaded')
  assert.equal(h.mind.setModel(' b '), 'b')
  await flush()
  assert.equal(h.r.unloads, 1)
  assert.equal(JSON.parse(h.settings.json ?? '{}').model, 'b')
  await h.mind.answer(req(), () => {})
  assert.ok(h.s.calls.includes('open b-1'))

  assert.throws(() => h.mind.setServer('http://localhost:8080'), (e: unknown) => e instanceof Error && e.message === 'the inpage provider has no server: the model runs in this page (ask provider <name> for one that does)')
  assert.throws(() => h.mind.setGpu('sometimes' as 'on'), TypeError)
  assert.equal(h.mind.setGpu('on'), 'on')
  assert.equal(JSON.parse(h.settings.json ?? '{}').gpu, 'on')
  const none = await harness({ models: [], settings: null })
  assert.throws(() => none.mind.setModel('a'), { message: NO_MODEL })
})

test('an answer queued right behind a stop waits for the runtime to settle it: the same model when the stop was in time, loaded again when the runtime let it go', async () => {
  for (const intime of [true, false]) {
    const h = await harness()
    await h.mind.answer(req(), () => {})
    assert.equal(h.r.loads.length, 1)
    // The runtime: a stopped answer ends at once for the mind, but its call may still be in a long step (a prompt read
    // on the processor); it settles later, and the runtime lets the model go if that took longer than it allows.
    const settled = deferred<void>()
    let settling: Promise<void> | null = null
    let calls = 0
    h.r.onChat = async (c) => {
      if (++calls === 1) {
        return new Promise<ChatResult>((_resolve, reject) => {
          c.o.signal.addEventListener('abort', () => {
            settling = settled.promise.then(() => { if (!intime) h.r.held = false })
            reject(reasonOf(c.o.signal))
          }, { once: true })
          c.o.onChunk({ text: 'part' })
        })
      }
      // As the runtime does: an answer waits for a stopped one still settling, and fails if the model went with it.
      if (settling) await settling
      if (!h.r.held) throw new CognitionError('server', 'the in-page runtime did not stop the answer when asked: the next ask loads it again')
      c.o.onChunk({ text: 'again' })
      return { reason: 'stop', tokens: 1 }
    }
    h.r.onIdle = () => settling ?? Promise.resolve()
    const stop = new AbortController()
    const a = rejection(h.mind.answer(req(stop.signal), () => stop.abort(new DOMException('stopped by the operator', 'AbortError'))))
    const b = h.mind.answer(req(), () => {})
    assert.equal(((await a) as Error).name, 'AbortError')
    await flush()
    assert.equal(h.r.chats.length, 2, 'the next answer waits while the stopped one settles (the first answer and the stopped one only)')
    assert.equal(h.r.loads.length, 1)
    settled.resolve()
    const r = await b
    assert.equal(r.text, 'again', intime ? 'answered by the model still loaded' : 'answered, not failed')
    assert.equal(h.r.loads.length, intime ? 1 : 2, intime ? 'no load for a stop the runtime honoured' : 'the model the runtime let go is loaded again')
    assert.ok(h.r.idles >= 1)
    assert.deepEqual(h.busy.at(-1), 'off')
  }
})

test('a new placement or another model unloads first: the runtime holds one model at a time', async () => {
  const h = await harness({ env: GPU_DESKTOP, models: [kept('a', 400 * MIB, 2), kept('b')], settings: JSON.stringify({ model: 'a' }) })
  await h.mind.answer(req(), () => {})
  h.mind.setGpu('off')
  await h.mind.answer(req(), () => {})
  assert.deepEqual(h.r.events, ['load gpu', 'chat', 'unload', 'load cpu', 'chat'])
  await h.mind.answer(req(), () => {})
  assert.equal(h.r.loads.length, 2, 'the same file loaded the same way is used again')
})

test('busy is said on once and off once on every path that held the city, and never on a refusal', async () => {
  const paths: [string, (h: Awaited<ReturnType<typeof harness>>) => Promise<unknown>][] = [
    ['an answer', (h) => h.mind.answer(req(), () => {})],
    ['a failed load', (h) => { h.r.onLoad = () => Promise.reject(new CognitionError('model', 'no')); return h.mind.answer(req(), () => {}) }],
    ['a failed chat', (h) => { h.r.onChat = () => Promise.reject(new CognitionError('server', 'gone')); return h.mind.answer(req(), () => {}) }],
    ['a file gone at the load', (h) => { h.s.gone.add('tiny-1'); return h.mind.answer(req(), () => {}) }],
    ['a stop at the load', async (h) => {
      const c = new AbortController()
      h.r.onLoad = () => never()
      const a = h.mind.answer(req(c.signal), () => {})
      await flush()
      c.abort()
      return a
    }],
    ['a release mid-answer', async (h) => {
      h.r.onChat = () => never()
      const a = h.mind.answer(req(), () => {})
      await flush()
      void h.mind.release('released')
      return a
    }],
    ['ask file load', (h) => h.mind.load()],
  ]
  for (const [name, run] of paths) {
    const h = await harness()
    await run(h).catch(() => undefined)
    await flush()
    assert.deepEqual(h.busy, ['on cpu', 'off'], name)
    assert.equal(h.phases.at(-1), null, name)
  }
  const refused = await harness({ models: [] })
  await refused.mind.answer(req(), () => {}).catch(() => undefined)
  assert.deepEqual(refused.busy, [])
})

test('keep chooses what it kept and clears a failed load and a crash mark; forget, unload and log say what they did', async () => {
  const guard = memory()
  guard.setItem(GUARD_KEY, crash('old', false))
  const h = await harness({ models: [], settings: null, guard })
  assert.equal(h.mind.settings().model, null)
  const m = await h.mind.keep([new File([new Uint8Array(64)], 'new.gguf')])
  assert.equal(m.name, 'new')
  assert.equal(h.mind.settings().model, 'new')
  assert.equal(guard.getItem(GUARD_KEY), null)
  assert.deepEqual(await h.mind.installed(), ['new'])

  h.r.onLoad = () => Promise.reject(new CognitionError('model', 'not a GGUF model file'))
  await fails(h.mind.answer(req(), () => {}), 'model')
  await fails(h.mind.installed(), 'offline')
  h.r.onLoad = (c) => Promise.resolve({ gpu: c.o.gpu, ms: 3100 })
  await h.mind.keep([new File([new Uint8Array(64)], 'fixed.gguf')])
  assert.equal(h.mind.settings().model, 'fixed')
  assert.deepEqual(await h.mind.installed(), ['fixed', 'new'])
  await h.mind.answer(req(), () => {})
  const s = h.mind.settings()
  assert.equal(s.server, INPAGE_SERVER)
  assert.equal(s.storage, 'kept in this page')
  assert.equal(s.runtime, 'this browser runs it; CPU, 4 threads, 8192 tokens of context, loaded in 3.1 s')

  await assert.rejects(h.mind.forget('nope'), { message: "no model file named 'nope' is kept in this page: fixed, new" })
  assert.equal(await h.mind.forget('fixed'), 'forgot fixed: it is no longer kept in this page')
  assert.equal(h.r.unloads, 1, 'the model in use was forgotten, so it was unloaded')
  assert.equal(h.mind.settings().model, null)
  assert.equal(await h.mind.forget(), 'forgot 1 model file: none is kept in this page now')
  assert.equal(await h.mind.forget(), 'no model file is kept in this page')
  assert.equal(await h.mind.unload(), 'no model is loaded in this page')
  assert.deepEqual(h.mind.log(), ['runtime: a line of its log'])

  const loaded = await harness()
  await loaded.mind.answer(req(), () => {})
  assert.equal(await loaded.mind.unload(), 'the model in this page is unloaded: the next ask loads it again')
  assert.equal(loaded.r.unloads, 1)
  // The chosen file gone from the storage: forgetting it by name chooses none.
  const gone = await harness({ models: [] })
  assert.equal(await gone.mind.forget('tiny'), 'tiny was no longer kept in this page; no model file is chosen now')
  assert.equal(gone.mind.settings().model, null)
})

test('keep where this page cannot run the runtime copies nothing, chooses nothing and says why (a browser without JSPI, a page opened from a file)', async () => {
  for (const [caps, reason] of [[{ ...CAPS, jspi: false }, runtimeMode({ ...CAPS, jspi: false })], [{ ...CAPS, opaque: true, isolated: false }, { ok: false, reason: OPAQUE_REASON }]] as const) {
    const guard = memory()
    guard.setItem(GUARD_KEY, crash('old', false))
    const h = await harness({ models: [kept('mine')], settings: JSON.stringify({ model: 'mine', think: false, gpu: 'auto' }), guard })
    h.r.caps = caps
    const before = [...h.s.calls]
    const settings = h.settings.json
    assert.ok(!reason.ok)
    await fails(h.mind.keep([new File([new Uint8Array(64)], 'new.gguf')]), 'offline', reason.reason)
    assert.deepEqual(h.s.calls, before, 'nothing is copied into the page\'s storage')
    assert.equal(h.mind.settings().model, 'mine', 'the model chosen before stays chosen')
    assert.equal(h.settings.json, settings, 'nothing is saved')
    assert.equal(guard.getItem(GUARD_KEY), crash('old', false), 'a refused keep is no word to try again')
    assert.equal(h.r.loads.length + h.r.unloads, 0)
    assert.equal(h.mind.settings().runtime, reason.reason, 'the runtime row says the same')
  }
})

test('its settings: its own slice of the router\'s store, garbage tolerated, written without touching any other provider\'s', async () => {
  const ollama = JSON.stringify({ v: 1, server: 'http://localhost:11434', model: 'mine:7b', think: true, api: 'generate' })
  const saved = { v: 3, provider: 'inpage', claude: { server: 'http://localhost:8089', model: 'claude-opus-5-5', key: null, effort: null }, ollama, llamacpp: null, openai: null, inpage: JSON.stringify({ model: 'tiny', think: false, gpu: 'auto', later: 7 }) }
  let json: string | null = JSON.stringify(saved)
  const routerStore = { load: () => json, save: (v: string) => { json = v } }
  const { runtime } = fakeRuntime()
  const st = fakeStore([kept('tiny')])
  let mind: ReturnType<typeof createInPageMind> | null = null
  const router = createMindRouter({
    fetch: async () => new Response('?', { status: 404 }), store: routerStore,
    inPage: (s) => (mind = createInPageMind({ runtime: () => runtime, store: st.store, kept: s, env: () => CPU_DESKTOP, guard: null })),
  })
  await flush()
  assert.ok(mind)
  const m = mind as ReturnType<typeof createInPageMind>
  assert.equal(m.settings().model, 'tiny')
  m.setThink?.(true)
  m.setGpu('off')
  const after = JSON.parse(json ?? '{}') as typeof saved
  assert.equal(after.ollama, ollama, 'another provider\'s slice is left as it was')
  assert.deepEqual(after.claude, saved.claude)
  assert.equal(after.provider, 'inpage')
  assert.deepEqual(JSON.parse(after.inpage), { later: 7, model: 'tiny', think: true, gpu: 'off' }, 'a key a later version kept stays')
  const s = router.settings()
  assert.equal(s.server, INPAGE_SERVER)
  assert.equal(s.model, 'tiny')
  assert.match(s.runtime ?? '', /^this browser runs it/)
  await m.dispose()

  for (const garbage of ['not json', '[1,2]', '"tiny"', JSON.stringify({ model: 5, think: 'yes', gpu: 'sideways' }), JSON.stringify({ model: '   ' })]) {
    const g = await harness({ settings: garbage })
    assert.equal(g.mind.settings().model, null, garbage)
    assert.equal(g.mind.settings().think, false, garbage)
    g.mind.setThink?.(false)
    assert.equal(JSON.parse(g.settings.json ?? '{}').gpu, 'auto', garbage)
  }
  const refused = await harness()
  refused.settings.save = () => { throw new Error('quota') }
  assert.equal(refused.mind.setThink?.(true), true, 'a store that refuses keeps the setting for the visit')
})
