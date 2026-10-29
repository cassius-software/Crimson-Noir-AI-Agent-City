// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the in-page model as the operator tier uses it (operator.ts Mind, the router's
 * `inpage` provider): a model file the operator keeps in this page (modelStore.ts), run by the page itself on this
 * device through a runtime it is handed (wllamaRuntime.ts in the product, a fake in the tests; this file never
 * imports wllama). It decides everything around that runtime:
 * - whether the model may run at all, without loading it and without a request: this browser must be able to run the
 *   runtime (inPageCaps.ts), the page must not have closed while it was loading a model last time (the crash guard,
 *   a key in the page's storage written before a load and removed once it settles or the page unloads, so only a load
 *   the page died in leaves it; each mark names a Web Lock its page holds while it loads, so a load still running in
 *   another tab is not taken for a crash), no load may have failed this visit, and the kept file must still be there;
 *   each refusal is 'offline' with a plain reason, so the script stands in and auto looks elsewhere;
 * - where and how it runs (inPagePlan.ts), with no more context than the model was trained on (its header says), and
 *   whether its files fit this device at all ('model' when not);
 * - loading it once for every answer that needs it, with the city's quality held down while it works (busy) and a
 *   phase line for the HUD; a load the GPU could not do is tried once more on the processor when the model fits
 *   there, and a load that failed for good is 'model' and marks the visit, never 'offline', so the router does not
 *   look again and load it again;
 * - the answer itself: the same system prompt every provider sends, streamed piece by piece, its hash for the audit;
 * - every call into the runtime is raced against the answer's own signal and the mind's, so the operator's stop,
 *   release() and dispose() settle an answer at once even if the runtime does not;
 * - when it is unloaded: after ten minutes idle, after a minute in the background on a phone, at the console, and
 *   when the GPU it was on was reset (the GPU is then left off for this page).
 * Its settings (the file chosen, think, the GPU) are kept as JSON in its own slice of the router's store.
 * What breaks if it is removed? The `inpage` provider has nothing behind it: the router's stand-in answers 'offline',
 * so a phone with no model server never gets a model answering in the page.
 */
import type { Answer, AnswerRequest, Mind, Piece } from '../07_Execute_Actions/operator.ts'
import { blobReader, readGgufHeader } from './gguf.ts'
import { capsLine, runtimeMode, type Caps } from './inPageCaps.ts'
import { fits, HIDDEN_UNLOAD_MS, IDLE_UNLOAD_MS, LOAD_MS, placement, START_MS, type GpuMode, type PlanEnv, type Placement } from './inPagePlan.ts'
import { CognitionError, FIRST_PIECE_MS, promptHash, sentence, STALL_MS, systemPrompt, type SettingsStore } from './localCompute.ts'
import { GONE, type KeptModel, type ModelStore } from './modelStore.ts'

/** What a load asks of the runtime (inPagePlan.ts Placement), its signal and its two watchdogs (the runtime enforces them). */
export interface LoadOptions { ctx: number; threads: number; gpu: boolean; batch?: number; ubatch?: number; warmup: boolean; signal: AbortSignal; startMs: number; loadMs: number }
/** One message of a chat, as the runtime takes it. */
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
/** One piece of a streamed chat: text of the answer, thinking, or how far the prompt has been read. */
export interface ChatChunk { text?: string; thinking?: string; progress?: { processed: number; total: number } }
/** What a chat asks of the runtime: its signal, the longest answer, thinking, the two waits and where the pieces go. */
export interface ChatOptions { signal: AbortSignal; maxTokens: number; think: boolean; firstMs: number; stallMs: number; onChunk(c: ChatChunk): void }
/** How a chat ended: why it stopped, and the tokens it wrote when the runtime counted them. */
export interface ChatResult { reason: string; tokens: number | null }

/**
 * The engine under the mind (wllamaRuntime.ts in the product, a fake in tests). Every rejection is a CognitionError
 * ('model' | 'server' | 'timeout') or the signal's own reason (an AbortError). Never hangs: the runtime races every
 * call against the signal, its watchdogs and the worker-gone flag.
 */
export interface InPageRuntime {
  caps(): Caps
  load(files: readonly Blob[], o: LoadOptions): Promise<{ gpu: boolean; ms: number }>
  chat(messages: readonly ChatMessage[], o: ChatOptions): Promise<ChatResult>
  unload(): Promise<void>
  loaded(): boolean
  /**
   * Settles once no stopped answer is still settling in the runtime: at once when none is, else when the runtime has
   * let go of it or of the model (a stop it could not honour in time). loaded() says the truth only after this.
   */
  idle(): Promise<void>
  log(): readonly string[]
}

/** Where the crash guard is kept: the page's local storage in the product. */
type GuardStore = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
/**
 * The page's Web Locks (navigator.locks), as far as the guard uses them: a load holds a lock of its own while it runs,
 * and the browser lets it go when its page goes, however it goes, so another tab can tell a load still running from a
 * page that died in one.
 */
export type GuardLocks = {
  request(name: string, options: { mode: 'shared' }, granted: () => Promise<void>): Promise<unknown>
  query(): Promise<{ held?: readonly { name?: string }[] }>
}

export interface InPageDeps {
  runtime: () => InPageRuntime
  store: ModelStore
  /** The mind's OWN slice of the router's store: load() returns only what this mind last saved (or null), save(json) replaces it. */
  kept: SettingsStore
  /** The device as the page knows it; the mind fills gpuMode and gpuFailed (a full PlanEnv is taken too, and those two are replaced). */
  env: () => Omit<PlanEnv, 'gpuMode' | 'gpuFailed'>
  /** The model works (loading or answering) or has stopped: the host holds the city's tier down meanwhile (inPagePlan.ts holdTier). */
  busy?: (on: boolean, place: Placement | null) => void
  /** The HUD's phase line, or null to clear it. */
  onPhase?: (text: string | null) => void
  /** Where the crash guard is kept (absent: the page's local storage; null: nowhere). */
  guard?: GuardStore | null
  /** The page's Web Locks for the guard (absent: navigator.locks where there is one; null: none, every mark found is a crash). */
  locks?: GuardLocks | null
  timeouts?: { loadMs?: number; startMs?: number; firstMs?: number; stallMs?: number; idleMs?: number; hiddenMs?: number }
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  now?: () => number
}

export interface InPageMind extends Mind {
  keep(files: readonly File[], onProgress?: (done: number, total: number) => void): Promise<KeptModel>
  forget(name?: string): Promise<string>  // a console line
  load(): Promise<string>                 // clears the crash guard and the failed mark, loads now; a console line
  unload(): Promise<string>
  setGpu(mode: GpuMode): GpuMode
  log(): readonly string[]
  release(reason: string): Promise<void>  // unload; an answer in flight rejects CognitionError('server', reason)
  background(): void
  foreground(): void
  /** The page is unloading, or going into the back/forward cache (pagehide): its load's guard goes (foreground() writes it again). */
  leave(): void
  noteGpuReset(): void
  dispose(): Promise<void>
}

/** The crash guard's key: present while a load runs, so only a load the page died in leaves it behind. */
export const GUARD_KEY = 'civic-simulation:inpage:loading:v1'

/** What the in-page provider reports as its server (router.ts INPAGE_SERVER): nothing is addressed. */
const SERVER = 'this page'
/** Why there is nothing to load. */
const NO_MODEL = 'no model file is kept in this page: Menu › Model file, or ask file'
/** The HUD's phase line while the model loads. */
const LOADING = 'loading the model in this page'
/** Why an answer in flight stopped when a phone's page stayed in the background. */
const HIDDEN = 'the page went to the background, so the model was unloaded: the next ask loads it again'
/** Why the mind answers nothing once the page has shut it down. */
const CLOSED = 'the model in this page was shut down'

/**
 * One mark in the guard (the key also holds when the load began): the model being loaded, whether onto the GPU, and
 * the Web Lock its page holds while it loads (null: none, so once another page finds it, it can only be a crash). The
 * key holds one mark, or a list of them while loads in several tabs overlap.
 */
interface Guard { readonly model: string | null; readonly gpu: boolean; readonly lock: string | null }

/** The model the runtime holds: which, how it was asked to run (compared for reuse), where it ran and how long it took. */
interface Loaded {
  readonly id: string
  readonly name: string
  readonly asked: Placement
  readonly gpu: boolean
  readonly ms: number
  readonly warn: string | undefined
}

/** A signal's reason as something to throw: an Error as it is, anything else as an AbortError. */
const reasonOf = (s: AbortSignal): Error => (s.reason instanceof Error ? s.reason : new DOMException('aborted', 'AbortError'))

/** An error's message as one plain clause, without a closing full stop. */
const said = (e: unknown): string => sentence(e instanceof Error ? e.message : String(e)).replace(/\.$/, '')

/**
 * `p`, or the signal's reason the moment it aborts, whatever `p` does after. A rejection of `p` after the abort is
 * caught here, so a runtime that settles late never leaves an unhandled rejection.
 */
function race<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(reasonOf(signal))
    if (signal.aborted) {
      p.catch(() => undefined)
      stop()
      return
    }
    signal.addEventListener('abort', stop, { once: true })
    p.then(
      (v) => { signal.removeEventListener('abort', stop); resolve(v) },
      (e: unknown) => { signal.removeEventListener('abort', stop); reject(e) },
    )
  })
}

/** Whether two placements load the same way (what an answer may change, think and its length, does not count). */
const sameLoad = (a: Placement, b: Placement): boolean =>
  a.gpu === b.gpu && a.threads === b.threads && a.ctx === b.ctx && a.batch === b.batch && a.ubatch === b.ubatch && a.warmup === b.warmup

/** "WebGPU" or "CPU, 2 threads", from how a load was asked and where the runtime ran it. */
function where(asked: Placement, gpu: boolean): string {
  const cpu = `CPU, ${asked.threads} thread${asked.threads === 1 ? '' : 's'}`
  if (gpu) return 'WebGPU'
  return asked.gpu ? `${cpu} (asked for the GPU, the runtime ran it on the processor)` : cpu
}

/** "3.1 s". */
const secs = (ms: number): string => `${(Math.max(0, ms) / 1000).toFixed(1)} s`

/** The page's local storage for the guard, or null where there is none (or it refuses this page). */
function pageStorage(): GuardStore | null {
  try {
    const s = (globalThis as { localStorage?: GuardStore }).localStorage
    return s && typeof s.getItem === 'function' ? s : null
  } catch {
    return null
  }
}

/** The page's Web Locks, or null where there are none (an insecure page, an older browser). */
function pageLocks(): GuardLocks | null {
  try {
    const l = (globalThis as { navigator?: { locks?: Partial<GuardLocks> } }).navigator?.locks
    return l && typeof l.request === 'function' && typeof l.query === 'function' ? (l as GuardLocks) : null
  } catch {
    return null
  }
}

/** A mark as found in the guard (anything unreadable is a mark too: a load a page died in, its model unknown). */
function markOf(m: unknown): Guard {
  const g = (typeof m === 'object' && m !== null ? m : {}) as { model?: unknown; gpu?: unknown; lock?: unknown }
  return { model: typeof g.model === 'string' ? g.model : null, gpu: g.gpu === true, lock: typeof g.lock === 'string' ? g.lock : null }
}

/** The kept models' names, newest first, each once. */
const namesOf = (list: readonly KeptModel[]): string[] => [...new Set(list.map((m) => m.name))]

/**
 * The in-page mind over `d.runtime` and the files in `d.store`, its settings in `d.kept` (see the file's comment).
 * It reads the kept files once at the start, so `ask model <name>` can be checked against them.
 */
export function createInPageMind(d: InPageDeps): InPageMind {
  const store = d.store
  const guard = d.guard === undefined ? pageStorage() : d.guard
  const locks = d.locks === undefined ? pageLocks() : d.locks
  const t = d.timeouts ?? {}
  const loadMs = t.loadMs ?? LOAD_MS
  const startMs = t.startMs ?? START_MS
  const firstMs = t.firstMs ?? FIRST_PIECE_MS
  const stallMs = t.stallMs ?? STALL_MS
  const idleMs = t.idleMs ?? IDLE_UNLOAD_MS
  const hiddenMs = t.hiddenMs ?? HIDDEN_UNLOAD_MS
  const setTimer = d.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const clearTimer = d.clearTimer ?? ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>))
  const now = d.now ?? Date.now

  // The settings: the file chosen (by its name; null: none), think and the GPU, with any other key a later version
  // kept in the same slice left as it was.
  let model: string | null = null
  let think = false
  let gpuMode: GpuMode = 'auto'
  let other: Record<string, unknown> = {}
  try {
    const saved: unknown = JSON.parse(d.kept.load() ?? 'null')
    if (typeof saved === 'object' && saved !== null && !Array.isArray(saved)) {
      const { model: m, think: th, gpu: g, ...rest } = saved as { model?: unknown; think?: unknown; gpu?: unknown }
      other = rest
      model = typeof m === 'string' && m.trim() ? m.trim() : null
      think = th === true
      gpuMode = g === 'on' || g === 'off' ? g : 'auto'
    }
  } catch {
    // nothing kept, or not readable: the defaults
  }
  const save = (): void => {
    try {
      d.kept.save(JSON.stringify({ ...other, model, think, gpu: gpuMode }))
    } catch {
      // storage refused: the settings last for this visit
    }
  }

  let runtime: InPageRuntime | null = null
  /** The runtime, made the first time it is needed. */
  const rt = (): InPageRuntime => (runtime ??= d.runtime())

  /** The kept models as last read (null: not yet), for the setters, which cannot wait. */
  let known: readonly KeptModel[] | null = null
  /** The model the runtime holds, or null. */
  let current: Loaded | null = null
  /** The context each kept model was trained on, from its first file's header (null: it names none), by trainedKey. */
  const trained = new Map<string, number | null>()
  /** The model being loaded now, and whether onto the GPU. */
  let loading: { id: string; name: string; gpu: boolean } | null = null
  /** This mind wrote the guard and its load has not settled: the key is its own, not a crash's. */
  let guarding = false
  /** This mind's own mark while it guards a load (as written), its lock's name, and the call that lets the lock go. */
  let own: { mark: object; lock: string | null; release: () => void } | null = null
  /** The page left (pagehide) while this mind guarded a load: its mark was taken away, to be written again if it returns. */
  let left = false
  /** A load on the GPU failed this visit, or the page died loading onto it: the processor for the rest of the visit. */
  let gpuFailed = false
  /** A line for the runtime row: why the model is not where it was asked to run. */
  let note: string | null = null
  /** A load that failed this visit: the model and why. Cleared by load(), keep() and choosing another model. */
  let failed: { name: string; reason: string } | null = null
  /** Aborted by release() and dispose(): every answer and load in flight races it. Replaced after each abort. */
  let life = new AbortController()
  /** One answer or load works with the runtime at a time; the others wait their turn. */
  let queue: Promise<void> = Promise.resolve()
  /** How many answers and loads are working or waiting: busy() is said when this leaves and returns to 0. */
  let holds = 0
  let shown: string | null = null
  let idle: unknown = null
  let hidden: unknown = null
  let disposed = false

  const envNow = (): PlanEnv => ({ ...d.env(), gpuMode, gpuFailed })

  /** The marks in the guard as written ([] for none); one that cannot be read is still a load a page died in. */
  function readMarks(): unknown[] {
    let raw: string | null
    try {
      raw = guard?.getItem(GUARD_KEY) ?? null
    } catch {
      return []
    }
    if (raw === null) return []
    try {
      const v: unknown = JSON.parse(raw)
      return Array.isArray(v) ? v : [v]
    } catch {
      return [null]
    }
  }
  /** The guard holding `marks`: none removes the key, one is written as it is, several as a list. */
  function writeMarks(marks: readonly unknown[]): void {
    try {
      if (!marks.length) guard?.removeItem(GUARD_KEY)
      else guard?.setItem(GUARD_KEY, JSON.stringify(marks.length === 1 ? marks[0] : marks))
    } catch {
      // storage refused: no guard this time
    }
  }
  /** The marks but this mind's own (with no lock to tell its own apart, none: a page has one load at a time). */
  const othersOf = (marks: readonly unknown[]): unknown[] => (own?.lock ? marks.filter((m) => markOf(m).lock !== own?.lock) : [])
  /** The locks held now in this origin, every tab's; null where the page cannot ask (then every mark found is a crash). */
  async function heldLocks(): Promise<ReadonlySet<string> | null> {
    if (!locks) return null
    try {
      const q = await locks.query()
      return new Set((q.held ?? []).map((l) => l.name).filter((n): n is string => typeof n === 'string'))
    } catch {
      return null
    }
  }
  /** Whether a mark is a page that died loading: no lock to show for it, or its page no longer holds that lock. */
  const dead = (m: unknown, held: ReadonlySet<string> | null): boolean => {
    const lock = markOf(m).lock
    return lock === null || held === null || !held.has(lock)
  }
  /** The marks pages that died loading left (none while this mind guards a load of its own). */
  async function crashes(): Promise<Guard[]> {
    if (guarding) return []
    const marks = readMarks()
    if (!marks.length) return []
    const held = marks.some((m) => markOf(m).lock !== null) ? await heldLocks() : null
    return marks.filter((m) => dead(m, held)).map(markOf)
  }
  /**
   * Marks this mind's load in the guard, beside a load another tab is running, once the page holds the mark's own
   * lock (where it has Web Locks): the lock is let go only after the mark is gone, so a mark with no lock held behind
   * it is always a page that died.
   */
  async function writeGuard(name: string, gpu: boolean): Promise<void> {
    guarding = true
    left = false
    let lock: string | null = null
    let release = (): void => undefined
    if (locks) {
      const n = `${GUARD_KEY}:${now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`
      let free!: () => void
      const held = new Promise<void>((resolve) => { free = resolve })
      const granted = await new Promise<boolean>((resolve) => {
        try {
          locks.request(n, { mode: 'shared' }, () => { resolve(true); return held }).catch(() => resolve(false))
        } catch {
          resolve(false)
        }
      })
      if (granted) {
        lock = n
        release = free
      } else free()
    }
    const mark = { model: name, gpu, at: now(), ...(lock !== null && { lock }) }
    own = { mark, lock, release }
    writeMarks([...othersOf(readMarks()), mark])
  }
  /** This mind's load settled (or the page lived): its own mark goes, then its lock; another tab's marks stay. */
  function clearGuard(): void {
    guarding = false
    left = false
    const was = own
    writeMarks(othersOf(readMarks()))
    own = null
    was?.release()
  }
  /**
   * The operator's word to try again (ask file load, or keeping a file): the marks pages that died loading left are
   * cleared (a load another tab is running keeps its own), and a crash on the GPU means the processor for this visit,
   * so the retry is not the load that took the page down.
   */
  async function clearCrash(): Promise<void> {
    if (guarding) return
    const marks = readMarks()
    if (!marks.length) return
    const held = marks.some((m) => markOf(m).lock !== null) ? await heldLocks() : null
    const gone = marks.filter((m) => dead(m, held))
    if (!gone.length) return
    if (gone.some((m) => markOf(m).gpu)) {
      gpuFailed = true
      note = 'the page closed while the model was loading onto the GPU last time, so it runs on the processor this visit'
    }
    writeMarks(readMarks().filter((m) => !dead(m, held)))
  }

  /** Why this page cannot run the runtime at all (inPageCaps.ts: the browser, or a page opened from a file), or null. */
  function unrunnable(): CognitionError | null {
    let caps: Caps
    try {
      caps = rt().caps()
    } catch (e) {
      return new CognitionError('offline', `the runtime for a model in this page could not start here (${said(e)})`)
    }
    const mode = runtimeMode(caps)
    return mode.ok ? null : new CognitionError('offline', mode.reason)
  }

  /**
   * Why the model may not run now, or null: the mind was shut down; this page cannot run the runtime; the page
   * closed while loading a model last time (a mark this mind did not write, and no tab still loading behind it); a
   * load failed this visit.
   */
  async function refusal(): Promise<CognitionError | null> {
    if (disposed) return new CognitionError('offline', CLOSED)
    const cannot = unrunnable()
    if (cannot) return cannot
    const g = (await crashes())[0]
    if (g) {
      return new CognitionError('offline', `the page closed while it was loading ${g.model ?? 'a model'} last time (the device may have run out of memory), so it is not loaded again on its own: ask file load tries again${g.gpu ? ', on the processor' : ''}`)
    }
    if (failed) return new CognitionError('offline', `${failed.name} could not be loaded in this page this visit (${failed.reason}): ask file load tries again`)
    return null
  }

  async function listKept(signal?: AbortSignal): Promise<readonly KeptModel[]> {
    const list = signal ? await race(store.list(), signal) : await store.list()
    known = list
    return list
  }

  /** The model to run: the one chosen, or the newest kept when none is; 'offline' when there is none, or it has gone. */
  function chosenOf(list: readonly KeptModel[]): KeptModel {
    if (model === null) {
      if (!list.length) throw new CognitionError('offline', NO_MODEL)
      return list[0]
    }
    const m = list.find((k) => k.name === model)
    if (!m) throw new CognitionError('offline', GONE)
    return m
  }

  /** A kept model's key in `trained`: a model forgotten and kept again under the same id is read again. */
  const trainedKey = (m: KeptModel): string => `${m.id} ${m.keptAt}`

  /**
   * `place` asking for no more context than `target` was trained on, once its header has been read: llama.cpp gives
   * a load all the context it asks for (a cache twice the size for a model trained on half of it) and only warns that
   * the tokens past its training may overflow, so the plan's context is a ceiling, not a demand.
   */
  function withinTraining(target: KeptModel, place: Placement): Placement {
    const t = trained.get(trainedKey(target))
    return t != null && t < place.ctx ? { ...place, ctx: t } : place
  }

  /** Reads `target`'s trained context from `first`'s header, once per kept model; a header it cannot read names none. */
  async function readTraining(target: KeptModel, first: Blob | undefined, signal: AbortSignal): Promise<void> {
    const key = trainedKey(target)
    if (trained.has(key) || first === undefined) return
    let t: number | null = null
    try {
      const n = (await race(readGgufHeader(blobReader(first), first.size), signal)).contextLength
      if (n !== undefined && Number.isSafeInteger(n) && n > 0) t = n
    } catch {
      if (signal.aborted) throw reasonOf(signal)
      // The load reads the header again and says what is wrong with it.
    }
    trained.set(key, t)
  }

  /** Where and how `target` runs now (inPagePlan.ts) and any warning on its size; 'model' when it does not fit. */
  function placed(target: KeptModel): { place: Placement; warn: string | undefined } {
    const env = envNow()
    const place = placement(env, think)
    const fit = fits(target.files, env, place)
    if (!fit.ok) throw new CognitionError('model', fit.reason)
    return { place, warn: fit.warn }
  }

  function phase(text: string | null): void {
    if (text === shown) return
    shown = text
    try {
      d.onPhase?.(text)
    } catch {
      // the host's line, not the answer's failure
    }
  }

  function hold(delta: 1 | -1, place: Placement | null): void {
    const was = holds
    holds = Math.max(0, holds + delta)
    try {
      if (was === 0 && holds > 0) d.busy?.(true, place)
      else if (was > 0 && holds === 0) d.busy?.(false, null)
    } catch {
      // the host's hold, not the answer's failure
    }
  }

  function clearIdle(): void {
    if (idle !== null) clearTimer(idle)
    idle = null
  }
  function clearHidden(): void {
    if (hidden !== null) clearTimer(hidden)
    hidden = null
  }
  /** Unloads the model once nothing has asked for it for idleMs. */
  function armIdle(): void {
    clearIdle()
    if (disposed || holds > 0 || current === null) return
    idle = setTimer(() => {
      idle = null
      if (holds === 0 && !disposed) void unloadNow()
    }, idleMs)
  }

  async function unloadNow(): Promise<void> {
    current = null
    if (runtime === null) return
    try {
      await runtime.unload()
    } catch {
      // already gone
    }
  }

  /** Waits for every earlier answer or load to finish with the runtime (or the signal), then runs `fn`. */
  async function inTurn<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    const before = queue
    let done!: () => void
    const mine = new Promise<void>((resolve) => { done = resolve })
    queue = before.then(() => mine)
    try {
      await race(before, signal)
      return await fn()
    } finally {
      done()
    }
  }

  /** One load of `files` as `place` asks, under the crash guard (written before, removed once it settles). */
  async function loadOnce(target: KeptModel, files: readonly Blob[], place: Placement, signal: AbortSignal): Promise<{ gpu: boolean; ms: number }> {
    loading = { id: target.id, name: target.name, gpu: place.gpu }
    try {
      await race(writeGuard(target.name, place.gpu), signal)
      return await race(rt().load(files, {
        ctx: place.ctx, threads: place.threads, gpu: place.gpu,
        ...(place.batch !== undefined && { batch: place.batch }), ...(place.ubatch !== undefined && { ubatch: place.ubatch }),
        warmup: place.warmup, signal, startMs, loadMs,
      }), signal)
    } finally {
      clearGuard()
    }
  }

  /**
   * A load that failed for good: the visit is marked, and the failure is 'model' (never 'offline': no look, no second
   * load). `e` is the runtime's error, or a reason this file wrote (a string, taken as it is).
   */
  function failure(target: KeptModel, e: unknown, both: boolean): CognitionError {
    const why = typeof e === 'string' ? e : said(e)
    failed = { name: target.name, reason: why }
    return new CognitionError('model', `${target.name} could not be loaded in this page${both ? ' on the GPU or on the processor' : ''}: ${why}`)
  }

  /**
   * The model loaded as `place` asks: the one the runtime holds when it is the same file loaded the same way, else
   * whatever it holds unloaded first and this one loaded. A GPU load that fails is tried once more on the processor
   * when the model fits there (the GPU is then off for the visit); a load that fails for good is failure().
   */
  async function ensureLoaded(target: KeptModel, place: Placement, signal: AbortSignal, warn: string | undefined): Promise<Loaded> {
    // An answer stopped just before may still be settling in the runtime; one it cannot stop in time takes the model
    // with it, so whether it is still loaded is asked only once that is over (else this ask would fail, not load).
    if (current !== null) await race(rt().idle(), signal)
    place = withinTraining(target, place)
    if (current !== null && current.id === target.id && sameLoad(current.asked, place) && rt().loaded()) return current
    // Waited for its turn behind a load that failed, or a crash mark another page left meanwhile: not loaded again.
    const refused = await refusal()
    if (refused) throw refused
    loading = { id: target.id, name: target.name, gpu: place.gpu }
    phase(LOADING)
    try {
      if (current !== null || rt().loaded()) {
        current = null
        await race(rt().unload(), signal)
      }
      const files = await race(store.open(target.id), signal)
      await readTraining(target, files[0], signal)
      place = withinTraining(target, place)
      let asked = place
      let r: { gpu: boolean; ms: number }
      try {
        r = await loadOnce(target, files, asked, signal)
      } catch (e) {
        if (signal.aborted) throw reasonOf(signal)
        if (!asked.gpu || !(e instanceof CognitionError)) throw failure(target, e, false)
        gpuFailed = true
        await race(rt().unload().catch(() => undefined), signal)
        asked = { ...place, gpu: false }
        // The processor holds the whole model in the page's own memory: one too large for it is not tried there.
        const cpu = fits(target.files, envNow(), asked)
        if (!cpu.ok) throw failure(target, `the GPU could not load it (${said(e)}), and on the processor ${cpu.reason}`, false)
        note = `the GPU could not load ${target.name} (${said(e)}), so it runs on the processor this visit`
        warn = cpu.warn
        try {
          r = await loadOnce(target, files, asked, signal)
        } catch (e2) {
          if (signal.aborted) throw reasonOf(signal)
          throw failure(target, e2, true)
        }
      }
      if (signal.aborted) throw reasonOf(signal)
      current = { id: target.id, name: target.name, asked, gpu: r.gpu === true, ms: r.ms, warn }
      return current
    } finally {
      loading = null
      phase(null)
    }
  }

  /** The answer itself, with the model loaded: the system prompt and the prompt, streamed into `onPiece`. */
  async function speak(req: AnswerRequest, onPiece: (p: Piece) => void, place: Placement, stop: AbortSignal, own: AbortController): Promise<Answer> {
    const system = systemPrompt(req.tethers, req.memories, req.context, req.steering)
    const messages: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: req.prompt }]
    let text = ''
    let thinking = 0
    let pieces = 0
    // A piece the operator tier refuses (onPiece throws) ends the answer there, with that error.
    const give = (p: Piece): void => {
      try {
        onPiece(p)
      } catch (e) {
        own.abort(e)
      }
    }
    // The phase line this answer sets (the prompt's progress) is its own to clear, however the chat ends.
    const result = await race(rt().chat(messages, {
      signal: stop, maxTokens: place.maxTokens, think: place.think, firstMs, stallMs,
      onChunk: (c: ChatChunk) => {
        // A chunk can still arrive after a stop (spike): nothing after it is the answer.
        if (stop.aborted) return
        const p = c.progress
        if (p && Number.isFinite(p.processed) && Number.isFinite(p.total) && p.total > 0) {
          phase(`reading the prompt ${Math.max(0, Math.min(100, Math.floor((p.processed / p.total) * 100)))}%`)
        }
        if (typeof c.thinking === 'string' && c.thinking) {
          phase(null)
          thinking++
          give({ kind: 'thinking', text: c.thinking })
        }
        if (typeof c.text === 'string' && c.text && !stop.aborted) {
          phase(null)
          text += c.text
          pieces++
          give({ kind: 'text', text: c.text })
        }
      },
    }), stop).finally(() => phase(null))
    return {
      text, thinking,
      tokens: typeof result.tokens === 'number' && Number.isFinite(result.tokens) ? result.tokens : pieces,
      reason: typeof result.reason === 'string' && result.reason ? result.reason : 'stop',
      // The hash of the exact string sent, for the audit.
      promptHash: promptHash(system),
    }
  }

  async function release(reason: string): Promise<void> {
    clearIdle()
    clearHidden()
    const was = life
    life = new AbortController()
    was.abort(new CognitionError('server', reason))
    await unloadNow()
  }

  /** Chooses the model named `n`; one in use that is not it is unloaded (an answer in flight with it stops). */
  function choose(n: string): void {
    if (failed && failed.name !== n) failed = null
    if (n === model) return
    model = n
    save()
    const inUse = current?.name ?? loading?.name ?? null
    if (inUse !== null && inUse !== n) void release(`another model file was chosen (${n}), so the one in use was unloaded: ask again`)
  }

  /** The runtime row: can this browser run it, then how it runs (or would), and any note on where or why. */
  function runtimeRow(): string {
    let caps: Caps
    try {
      caps = rt().caps()
    } catch (e) {
      return `the runtime for a model in this page could not start here (${said(e)})`
    }
    const parts = [capsLine(caps)]
    if (!runtimeMode(caps).ok) return parts[0]
    if (current !== null) parts.push(`${where(current.asked, current.gpu)}, ${current.asked.ctx} tokens of context, loaded in ${secs(current.ms)}`)
    else {
      try {
        const next = model === null ? known?.[0] : known?.find((k) => k.name === model)
        const plan = placement(envNow(), think)
        const p = next ? withinTraining(next, plan) : plan
        parts.push(`${loading !== null ? 'loading' : 'not loaded: the next ask loads it'} (${where(p, p.gpu)}, ${p.ctx} tokens of context)`)
      } catch {
        parts.push(loading !== null ? 'loading' : 'not loaded: the next ask loads it')
      }
    }
    if (current?.warn) parts.push(current.warn)
    if (note !== null) parts.push(note)
    if (failed !== null) parts.push(`the last load failed: ${failed.reason}`)
    return parts.join('; ')
  }

  /** A setter's refusal of a name that is not kept, listing the ones that are. */
  function notKept(n: string): Error {
    if (known === null) return new Error('the kept model files have not been read yet: type ask to list them')
    const names = namesOf(known)
    return new Error(names.length ? `no model file named '${n}' is kept in this page: ${names.join(', ')}` : NO_MODEL)
  }

  // The kept files are read once now, so a model can be chosen by name before anything else has listed them.
  void listKept().catch(() => undefined)

  const mind: InPageMind = {
    settings: () => {
      let storage: string
      try {
        storage = store.storageLine()
      } catch {
        storage = 'none'
      }
      return { server: SERVER, model, think, runtime: runtimeRow(), storage }
    },
    setServer: (): string => { throw new Error('the inpage provider has no server: the model runs in this page (ask provider <name> for one that does)') },
    setModel: (name: string): string => {
      const n = typeof name === 'string' ? name.trim() : ''
      if (!n || known === null || !known.some((m) => m.name === n)) throw notKept(n)
      choose(n)
      return n
    },
    setThink: (on: boolean): boolean => {
      think = on === true
      save()
      return think
    },
    setGpu: (mode: GpuMode): GpuMode => {
      if (mode !== 'auto' && mode !== 'on' && mode !== 'off') throw new TypeError('ask gpu takes auto, on or off')
      gpuMode = mode
      save()
      return gpuMode
    },

    // No request and no load: the kept names, or why the model cannot run here.
    installed: async (signal?: AbortSignal): Promise<string[]> => {
      if (signal?.aborted) throw reasonOf(signal)
      const refused = await refusal()
      if (refused) throw refused
      const list = await listKept(signal)
      if (model === null) return namesOf(list)
      // The chosen file: still listed, and every one of its files still there (open() reads them, it loads nothing).
      const m = list.find((k) => k.name === model)
      if (!m) throw new CognitionError('offline', GONE)
      await (signal ? race(store.open(m.id), signal) : store.open(m.id))
      return namesOf(list)
    },

    answer: async (req: AnswerRequest, onPiece: (p: Piece) => void): Promise<Answer> => {
      const own = new AbortController()
      const stop = AbortSignal.any([req.signal, life.signal, own.signal])
      if (stop.aborted) throw reasonOf(stop)
      const refused = await refusal()
      if (refused) throw refused
      const target = chosenOf(await listKept(stop))
      // Refused before it waits or holds the city when it does not fit; placed again in its turn, where a GPU load
      // that failed meanwhile (or the operator's ask gpu) has changed where it runs.
      const first = placed(target).place
      clearIdle()
      hold(1, first)
      try {
        return await inTurn(stop, async () => {
          const { place, warn } = placed(target)
          await ensureLoaded(target, place, stop, warn)
          return speak(req, onPiece, place, stop, own)
        })
      } catch (e) {
        if (stop.aborted) throw reasonOf(stop)
        // The runtime stopped or went quiet mid-answer: what it holds is unloaded, and the next ask loads it again. A
        // prompt too long for the model ('model') leaves it loaded.
        if (!(e instanceof CognitionError) || (e.code !== 'model' && e.code !== 'offline')) await unloadNow()
        throw e
      } finally {
        // The phase line is cleared by whichever load or answer set it, never here: an answer stopped while it waited
        // its turn would blank the line of the load still running ahead of it.
        hold(-1, null)
        armIdle()
      }
    },

    keep: async (files, onProgress) => {
      // Where the runtime cannot run, nothing is copied and nothing is chosen: the file would only take the room, and
      // the provider would switch to a model the script must stand in for.
      const cannot = unrunnable()
      if (cannot) throw cannot
      const m = await store.keep(files, onProgress)
      known = [m, ...(known ?? []).filter((k) => k.id !== m.id)]
      failed = null
      await clearCrash()
      choose(m.name)
      return m
    },

    forget: async (name?: string): Promise<string> => {
      const n = typeof name === 'string' ? name.trim() : ''
      const list = await listKept()
      const hit = n ? list.filter((m) => m.name === n) : list
      if (n && !hit.length) {
        // The chosen file has gone already: forgetting it is choosing none.
        if (model === n) {
          model = null
          save()
          return `${n} was no longer kept in this page; no model file is chosen now`
        }
        throw notKept(n)
      }
      const ids = new Set(hit.map((m) => m.id))
      if ((current !== null && ids.has(current.id)) || (loading !== null && ids.has(loading.id))) await release('the model file was forgotten, so it was unloaded')
      let removed = 0
      if (n) for (const m of hit) removed += await store.forget(m.id)
      else removed = await store.forget()
      if (model !== null && (!n || model === n)) {
        model = null
        save()
      }
      if (failed !== null && (!n || failed.name === n)) failed = null
      await listKept().catch(() => undefined)
      if (removed === 0) return 'no model file is kept in this page'
      return n ? `forgot ${n}: it is no longer kept in this page` : `forgot ${removed} model file${removed === 1 ? '' : 's'}: none is kept in this page now`
    },

    load: async (): Promise<string> => {
      // The operator's word to try again: a crash mark and a failed load are cleared.
      await clearCrash()
      failed = null
      const signal = life.signal
      const refused = await refusal()
      if (refused) throw refused
      const target = chosenOf(await listKept(signal))
      const first = placed(target).place
      clearIdle()
      hold(1, first)
      try {
        const l = await inTurn(signal, () => {
          const { place, warn } = placed(target)
          return ensureLoaded(target, place, signal, warn)
        })
        return `${l.name} is loaded in this page (${where(l.asked, l.gpu)}, ${l.asked.ctx} tokens of context, in ${secs(l.ms)})${l.warn ? `: ${l.warn}` : ''}`
      } finally {
        hold(-1, null)
        armIdle()
      }
    },

    unload: async (): Promise<string> => {
      const had = current !== null || loading !== null || holds > 0
      await release('the model was unloaded at the console: ask again')
      return had ? 'the model in this page is unloaded: the next ask loads it again' : 'no model is loaded in this page'
    },

    log: (): readonly string[] => {
      try {
        return rt().log()
      } catch {
        return []
      }
    },

    release,

    background: (): void => {
      if (disposed) return
      let mobile = false
      try {
        mobile = d.env().mobile
      } catch {
        // not known: a desktop
      }
      if (!mobile) return
      clearHidden()
      hidden = setTimer(() => {
        hidden = null
        if (current !== null || loading !== null || holds > 0) void release(HIDDEN)
      }, hiddenMs)
    },

    foreground: (): void => {
      clearHidden()
      // Back from the back/forward cache with its load still running: marked again until that load settles.
      if (left && guarding && own) writeMarks([...othersOf(readMarks()), own.mark])
      left = false
    },

    // A page that unloads did not die in its load (a reload, a closed tab, the city restarting): only a page the
    // system kills, which runs no pagehide, leaves its mark. Its lock goes with the page.
    leave: (): void => {
      if (!guarding || left) return
      left = true
      writeMarks(othersOf(readMarks()))
    },

    noteGpuReset: (): void => {
      const onGpu = (current !== null && current.gpu) || (loading !== null && loading.gpu)
      if (!onGpu) return
      gpuMode = 'off'
      save()
      note = 'the GPU was reset while the model was on it, so it runs on the processor from now on (ask gpu auto tries the GPU again)'
      void release('the GPU was reset while the model was on it, so it was unloaded: the next ask loads it on the processor')
    },

    // The page lived, so a load of this mind's own did not take it down: its guard goes at once, before anything
    // waits (the page may be closing). A mark an earlier page left stays until the operator's ask file load.
    dispose: async (): Promise<void> => {
      if (disposed) return
      disposed = true
      if (guarding) clearGuard()
      await release(CLOSED)
    },
  }
  return Object.freeze(mind)
}
