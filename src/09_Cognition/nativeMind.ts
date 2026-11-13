// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the model the app runs itself, as the operator tier uses it (operator.ts Mind, the
 * router's `native` provider): llama.cpp inside the Tauri shell (native/llm), for the apps whose web view cannot run
 * the model in the page (inPageCaps.ts: no JSPI or no Memory64). The page asks the shell three things through
 * desktopShell.ts shellRunner (a fake in the tests): what it carries and how that stands (`native_model`), one answer
 * whose events come back on a channel (`native_generate`), and a stop (`native_stop`); what the runner sends back
 * (what it carries, its events, endings and errors) and the request are in exactly the words
 * native/llm/tests/wire.json pins (its tests replay that file here), the commands' argument names are shellRunner's.
 * The answer is asked with the same system prompt every provider sends (systemFor: the talk prompt for a
 * conversation) as the same two messages the model in this page is sent, hashed for the audit; it waits as the model
 * in this page waits (the first piece, then a stall between two events; none while it waits its turn, even as the
 * file's check is reported to it), and a wait that runs out is 'timeout' and stops the runner; a Stop settles the
 * answer at once and tells the runner, and nothing the runner sends after an answer settled reaches it. Where there
 * is no runner (a browser, the Windows app, an app built before the runner) or no model, it lists nothing, so auto
 * passes it over unsaid, and an answer is told there is none (NO_RUNNER, 'offline') before any channel is made; a
 * runner that cannot start is named with its reason, and the runner's own failure keeps its code and its words, but
 * one whose model would not load (or whose file failed its check) after a look found it has failed for good: it says
 * so as there being none ('offline', with its reason), Sloane's card hears why, and every look and answer after it
 * pass it over.
 * What breaks if it is removed? An app that runs its model itself has nothing in the page to ask it.
 */
import type { Answer, AnswerRequest, Mind, Piece } from '../07_Execute_Actions/operator.ts'
import { WAITING } from './inPage.ts'
import { ANSWER_TOKENS, CognitionError, FIRST_PIECE_MS, promptHash, STALL_MS, systemFor } from './localCompute.ts'

/** One message of the conversation (wire.json "request"). */
export interface NativeMessage { role: 'system' | 'user' | 'assistant'; content: string }
/** The page's request for one answer (wire.json "request"; the runner refuses any other field). */
export interface GenRequest { id: number; messages: NativeMessage[]; maxTokens: number; think: boolean }
/** Where the runner stands (wire.json "statuses"). */
export type NativeStatus = { state: 'preparing'; done: number; total: number } | { state: 'ready' } | { state: 'loaded' } | { state: 'failed'; reason: string; refused: boolean }
/** What the app carries (`native_model`): null where it runs no model. */
export interface NativeModel { file: string; bytes: number; status: NativeStatus }
/** What the page is told while its answer is made (wire.json "events"). */
export type RunEvent = { kind: 'waiting' } | { kind: 'preparing'; done: number; total: number } | { kind: 'loading'; fraction: number } | { kind: 'read'; done: number; total: number } | { kind: 'text'; text: string }
/** How an answer ended (wire.json "done"). */
export interface GenDone { id: number; reason: 'eog' | 'maxTokens' | 'stopped' | 'context'; tokens: number; promptTokens: number; reused: number; prefillMs: number; genMs: number; threads: number; nCtx: number; nBatch: number; gpu: boolean }
/** Why an answer could not be made (wire.json "errors"): what `native_generate` rejects with. */
export interface RunError { code: 'offline' | 'refused' | 'model'; message: string }

/** The shell's runner (desktopShell.ts shellRunner). Every answer is the shell's, read here as unknown and checked. */
export interface NativeHost {
  /** NativeModel or null; a shell without the command rejects. */
  model(): Promise<unknown>
  /** Each event goes to `onEvent`; resolves with a GenDone, rejects with a RunError. */
  generate(req: GenRequest, onEvent: (event: unknown) => void): Promise<unknown>
  stop(id: number): Promise<unknown>
}

export interface NativeDeps {
  host: NativeHost | null
  /** The longest answer (inPagePlan.ts placement maxTokens: shorter on a phone). */
  maxTokens?: () => number
  /** An answer is under way, or none is: the host holds the city's tier down meanwhile. */
  busy?: (on: boolean) => void
  /** The HUD's phase line, or null to clear it. */
  onPhase?: (text: string | null) => void
  /**
   * At each look, and when an answer finds the runner failed for good: why the model inside the app cannot start
   * (its file's name taken out, as in every reason this provider gives: the card never names the model), or null when
   * it can (Sloane's card says it).
   */
  onFailed?: (reason: string | null) => void
  timeouts?: { firstMs?: number; stallMs?: number; askMs?: number }
}

/** What the native provider reports as its server: nothing is addressed, the app runs the model. */
export const NATIVE_SERVER = 'this app'
/** Its model until the app has named the file it carries. */
export const NATIVE_MODEL = 'the model this app carries'
/** A request's phase while the app loads its model (voice.ts phaseLine). */
export const LOADING_APP = 'loading the model in the app'
/** Why there is nothing to ask. */
export const NO_RUNNER = 'this page is not inside an app that runs a model itself'
/** How long the app has to say what it carries, ms: it answers from memory. */
export const ASK_MS = 5000

const reasonOf = (s: AbortSignal): Error => (s.reason instanceof Error ? s.reason : new DOMException('aborted', 'AbortError'))
const said = (e: unknown): string => {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try { return JSON.stringify(e) ?? String(e) } catch { return String(e) }
}
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
const pct = (done: unknown, total: unknown): number | null => {
  const d = num(done), t = num(total)
  return d === null || t === null || t === 0 ? null : Math.min(100, Math.floor((d / t) * 100))
}
const span = (ms: number): string => (ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}` : `${ms / 1000} s`)
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

/** `p`, or the signal's reason the moment it aborts (a late rejection of `p` is caught). */
function race<T>(p: Promise<T>, s: AbortSignal): Promise<T> {
  p.catch(() => undefined)
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(reasonOf(s))
    if (s.aborted) return stop()
    s.addEventListener('abort', stop, { once: true })
    p.then((v) => { s.removeEventListener('abort', stop); resolve(v) }, (e: unknown) => { s.removeEventListener('abort', stop); reject(e) })
  })
}

/** What `native_model` said, or null for no model (anything without a file and a status is none). */
function modelOf(m: unknown): { file: string; status: { state?: unknown; reason?: unknown; refused?: unknown } } | null {
  const o = (typeof m === 'object' && m !== null ? m : {}) as { file?: unknown; status?: unknown }
  return typeof o.file === 'string' && o.file && typeof o.status === 'object' && o.status !== null ? { file: o.file, status: o.status } : null
}

/** The runner's refusal as the router's failure: its own code and words (a RunError), else 'server'. */
function failure(e: unknown): CognitionError {
  if (e instanceof CognitionError) return e
  const o = (typeof e === 'object' && e !== null ? e : {}) as { code?: unknown; message?: unknown }
  const code = (['offline', 'refused', 'model'] as const).find((c) => c === o.code)
  const message = typeof o.message === 'string' && o.message ? o.message : said(e)
  return code ? new CognitionError(code, message) : new CognitionError('server', `the model inside this app failed (${message})`)
}

/** The last answer's cost as the runner measured it, one line (read off a device to tune it), or null. */
function costOf(r: { [k: string]: unknown }): string | null {
  const [tokens, prompt, reused, prefill, gen, threads, ctx] = [r.tokens, r.promptTokens, r.reused, r.prefillMs, r.genMs, r.threads, r.nCtx].map(num)
  if (tokens === null || prompt === null || reused === null || prefill === null || gen === null || threads === null || ctx === null) return null
  const rate = gen > 0 ? ` (${(tokens / (gen / 1000)).toFixed(1)} a second)` : ''
  return `the app itself, ${r.gpu === true ? 'on the GPU' : 'on the processor'}, ${threads} thread${threads === 1 ? '' : 's'}, ${ctx} tokens of context; last answer: ${prompt} prompt tokens (${reused} kept from the one before) read in ${secs(prefill)}, ${tokens} written in ${secs(gen)}${rate}`
}

/** The native provider: a Mind that can also say whether the app's model is still to be loaded. */
export interface NativeMind extends Mind {
  /**
   * Whether an answer now would wait for the app to load its model, as last heard: the app has not said it is loaded
   * (at the last look), and no answer has run since. False with no runner, no model, or one that failed for good.
   * Asks nothing.
   */
  cold(): boolean
}

/**
 * A reason as this provider gives it, the model's file name taken out: the card never names the model, and a look's
 * sentence reaches the card's details too (`ask` shows the file on its model row).
 */
const unnamed = (why: string, file: string): string => why.replaceAll(` (${file})`, '')

/** The native provider over `d.host` (see the file's comment). */
export function createNativeMind(d: NativeDeps): NativeMind {
  const firstMs = d.timeouts?.firstMs ?? FIRST_PIECE_MS
  const stallMs = d.timeouts?.stallMs ?? STALL_MS
  const askMs = d.timeouts?.askMs ?? ASK_MS
  let file: string | null = null
  let cost: string | null = null
  let hud: string | null = null
  let holds = 0
  // Whether the shell has the runner's commands, once asked (null: not yet). A shell without them (the Windows app, an
  // app built before the runner) rejects native_model; its command set never changes while the page is open.
  let runner: boolean | null = null
  // The model is loaded, as last heard (at a look, or an answer that ran).
  let warm = false
  // The app said it carries no model (native_model answered null): nothing to load.
  let empty = false
  // The runner failed for good after a look found it (its load, or its file's check, failed at an answer): why (its
  // file's name taken out, as everywhere here) and the code a look gives it. The runner refuses every answer from then
  // on (engine.rs fail).
  let gone: { why: string; code: 'refused' | 'model' } | null = null
  const hudLine = (t: string | null): void => {
    if (t === hud) return
    hud = t
    try { d.onPhase?.(t) } catch { /* the host's line, not the answer's */ }
  }
  const hold = (delta: 1 | -1): void => {
    const was = holds
    holds = Math.max(0, holds + delta)
    try {
      if (was === 0 && holds > 0) d.busy?.(true)
      else if (was > 0 && holds === 0) d.busy?.(false)
    } catch { /* the host's hold, not the answer's */ }
  }
  const failed = (why: string | null): void => { try { d.onFailed?.(why) } catch { /* the host's */ } }
  return Object.freeze<NativeMind>({
    settings: () => ({ server: NATIVE_SERVER, model: file ?? NATIVE_MODEL, ...(cost !== null && { runtime: cost }) }),
    setServer: (): string => { throw new Error('the native provider has no server: the app runs the model itself (ask provider <name> for one that does)') },
    setModel: (): string => { throw new Error('the native provider runs the one model this app carries') },

    // No answer and no load: whether the app runs a model, and whether it can start. An app without the command (or a
    // browser) has none, said nowhere.
    installed: async (signal?: AbortSignal): Promise<string[]> => {
      const host = d.host
      if (host === null) return []
      // Failed for good at an answer: named as the look that would ask the runner now names it.
      if (gone !== null) {
        failed(gone.why)
        throw new CognitionError(gone.code, gone.why)
      }
      const wait = AbortSignal.timeout(askMs)
      let m: unknown
      try {
        m = await race(Promise.resolve().then(() => host.model()), signal ? AbortSignal.any([signal, wait]) : wait)
        runner = true
      } catch {
        if (signal?.aborted) throw reasonOf(signal)
        if (wait.aborted) throw new CognitionError('offline', `the app did not say within ${span(askMs)} whether the model it carries can start`)
        // A shell built before the runner has no such command: no model, as in a browser.
        runner = false
        return []
      }
      const o = modelOf(m)
      empty = o === null
      if (o === null) return []
      file = o.file
      const s = o.status
      warm = s.state === 'loaded'
      // This device cannot ('refused'), or the model cannot ('model'): the runner's own codes, and its sentence.
      if (s.state === 'failed') {
        const why = unnamed(typeof s.reason === 'string' && s.reason ? s.reason : 'the app did not say why', o.file)
        failed(why)
        throw new CognitionError(s.refused === true ? 'refused' : 'model', why)
      }
      failed(null)
      return [o.file]
    },

    cold: (): boolean => d.host !== null && runner !== false && !empty && gone === null && !warm,

    answer: async (req: AnswerRequest, onPiece: (p: Piece) => void): Promise<Answer> => {
      const host = d.host
      if (host === null) throw new CognitionError('offline', NO_RUNNER)
      if (gone !== null) throw new CognitionError('offline', gone.why)
      if (req.signal.aborted) throw reasonOf(req.signal)
      // Chosen with ask provider native, no look has asked the shell yet: a shell without the runner's commands, or an
      // app that carries no model, is no runner, said before a channel is made that nothing would ever end.
      if (runner === null) {
        const wait = AbortSignal.timeout(askMs)
        try {
          empty = modelOf(await race(Promise.resolve().then(() => host.model()), AbortSignal.any([req.signal, wait]))) === null
          runner = true
        } catch {
          if (req.signal.aborted) throw reasonOf(req.signal)
          if (wait.aborted) throw new CognitionError('offline', `the app did not say within ${span(askMs)} whether the model it carries can start`)
          runner = false
        }
      }
      if (!runner || empty) throw new CognitionError('offline', NO_RUNNER)
      const own = new AbortController()
      const stop = AbortSignal.any([req.signal, own.signal])
      if (stop.aborted) throw reasonOf(stop)
      const id = crypto.getRandomValues(new Uint32Array(1))[0]
      const system = systemFor(req)
      let text = ''
      let pieces = 0
      // This request's own phase, each change once; the HUD's line too, cleared only while it is still this answer's.
      let heard: string | null = null
      let mine: string | null = null
      const phase = (t: string | null): void => {
        if (t !== heard) {
          heard = t
          try { req.onPhase?.(t) } catch { /* the asker's line, not the answer's */ }
        }
        if (t !== null) mine = t
        if (t !== null || hud === mine) hudLine(t)
      }
      // The waits: the first piece, then a stall between two events (progress counts); none while it waits its turn.
      let timer: ReturnType<typeof setTimeout> | undefined
      // Told it waits its turn: no wait runs until its own load, prompt or text begins (a queued job still hears the
      // file's check, engine.rs prepare, and that is no sign its turn has come).
      let queued = false
      // The answer has settled: whatever the runner still sends is no part of it.
      let settled = false
      const arm = (ms: number, why: string): void => {
        clearTimeout(timer)
        timer = setTimeout(() => own.abort(new CognitionError('timeout', why)), ms)
      }
      arm(firstMs, `the model inside this app wrote nothing for ${span(firstMs)}`)
      const give = (p: Piece): void => {
        try { onPiece(p) } catch (e) { own.abort(e) }
      }
      const onEvent = (raw: unknown): void => {
        if (settled || stop.aborted || typeof raw !== 'object' || raw === null) return
        const e = raw as { kind?: unknown; done?: unknown; total?: unknown; text?: unknown }
        if (e.kind === 'waiting') {
          queued = true
          clearTimeout(timer)
          phase(WAITING)
          return
        }
        // The file's check while it waits its turn: its share, and once it is done, waiting again; no wait runs.
        if (queued && e.kind === 'preparing') {
          const n = pct(e.done, e.total)
          if (n !== null) phase(n < 100 ? `preparing the model in the app ${n}%` : WAITING)
          return
        }
        queued = false
        const piece = e.kind === 'text' && typeof e.text === 'string' && e.text ? e.text : null
        if (piece !== null) pieces++
        arm(stallMs, `the model inside this app went quiet for ${span(stallMs)} ${pieces ? 'in the middle of the answer' : 'before its answer began'}`)
        if (piece !== null) {
          phase(null)
          text += piece
          give({ kind: 'text', text: piece })
          return
        }
        // Progress only until the answer begins: a report after it is nothing to show.
        if (pieces) return
        const n = pct(e.done, e.total)
        if (e.kind === 'loading') phase(LOADING_APP)
        else if (e.kind === 'preparing' && n !== null) phase(`preparing the model in the app ${n}%`)
        else if (e.kind === 'read' && n !== null) phase(`reading the prompt ${n}%`)
      }
      // A Stop, a refused piece or a wait that ran out: the runner is told, and the answer settles now.
      const halt = (): void => { void Promise.resolve().then(() => host.stop(id)).catch(() => undefined) }
      stop.addEventListener('abort', halt, { once: true })
      hold(1)
      let err: CognitionError
      try {
        // The runner reads the cap as a whole number (u32): anything else would be refused, so the usual cap goes.
        const cap = d.maxTokens?.() ?? ANSWER_TOKENS
        const sent: GenRequest = { id, messages: [{ role: 'system', content: system }, { role: 'user', content: req.prompt }], maxTokens: Number.isSafeInteger(cap) && cap > 0 && cap < 2 ** 32 ? cap : ANSWER_TOKENS, think: false }
        const r = await race(Promise.resolve().then(() => host.generate(sent, onEvent)), stop)
        const o = (typeof r === 'object' && r !== null ? r : {}) as { [k: string]: unknown }
        cost = costOf(o) ?? cost
        // A job stopped before any load is answered untouched: only another ending says the model is loaded now.
        if (o.reason !== 'stopped') warm = true
        // A full context cuts the answer as the token cap does: both are 'length', which the operator reads as cut
        // (taskOutcome) and never acts on.
        const reason = o.reason === 'eog' ? 'stop' : o.reason === 'maxTokens' || o.reason === 'context' ? 'length' : typeof o.reason === 'string' && o.reason ? o.reason : 'stop'
        return { text, thinking: 0, tokens: num(o.tokens) ?? pieces, reason, promptHash: promptHash(system) }
      } catch (e) {
        if (req.signal.aborted) throw reasonOf(req.signal)
        if (own.signal.aborted) throw reasonOf(own.signal)
        err = failure(e)
      } finally {
        settled = true
        clearTimeout(timer)
        stop.removeEventListener('abort', halt)
        phase(null)
        hold(-1)
      }
      // The runner's refusal may be for good: its model would not load, or its file failed its check, after the look
      // that found it ready (engine.rs fail: it refuses every answer from then on). Asked how it stands now (it answers
      // from memory); a per-request failure while it stands loaded stays this answer's.
      if (err.code !== 'model' && err.code !== 'refused') throw err
      const now = modelOf(await race(Promise.resolve().then(() => host.model()), AbortSignal.timeout(askMs)).catch(() => null))
      if (now === null || now.status.state !== 'failed') throw err
      const why = unnamed(typeof now.status.reason === 'string' && now.status.reason ? now.status.reason : err.message, now.file)
      file = now.file
      gone = { why, code: now.status.refused === true ? 'refused' : 'model' }
      failed(why)
      // As there being none: the script stands in, the card says why, and auto goes on to what answers next.
      throw new CognitionError('offline', why)
    },
  })
}
