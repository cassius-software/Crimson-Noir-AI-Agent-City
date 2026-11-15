// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the page's side of its own speech recogniser: the thing that makes an open
 * microphone understand words in every browser, not only where the browser brings a recogniser of its own. It takes
 * the speech pack from where the page kept it on an earlier visit (speechPack.ts speechStore: nothing is asked of the
 * network then, so it works offline), or asks the site whether the pack is served beside the page, gets its files and
 * keeps them; hands them to a worker that checks every byte and runs the model (speech.worker.ts: it has no
 * network), and then reads each utterance the microphone hands over (04_Connect_Hardware/microphone.ts `utterance`),
 * one at a time, in order, and says what was said (`heard`). Everything that can go wrong has a state and a sentence:
 * no pack on this site (`absent`: the page file opened alone), the site unreachable just now (asked again later, a
 * few times, further apart), a file that is not the pin's (fetched once more past the cache, then refused), a
 * recogniser that would not start or stopped answering (`failed`, with the reason; started again on the next ask, a
 * few times). A reading the model was not sure of is dropped, not passed on as words.
 * It is a state machine over things passed in (the fetch, the worker, the clock, the timers), so every path runs in a
 * Node test with fakes; App.tsx makes the one instance and wires it to the microphone and to what a heard sentence
 * does. No audio is kept: an utterance goes to the worker and is dropped there once read.
 * What breaks if it is removed? Words are understood only where the browser has an on-device recogniser (desktop
 * Chrome after an install, the newest desktop Firefox): on a phone, in Safari and in the apps the pill says Listening
 * and nothing that is said does anything.
 */
import { linkHold, type Link } from './siteAuto.ts'
import type { SiteFetch } from './siteModel.ts'
import type { Reading } from './speechCore.ts'
import { SPEECH_PACK, fetchSpeechFile, speechOffered, speechSize, type SpeechFile, type SpeechPackPin, type SpeechRole, type SpeechStore } from './speechPack.ts'

/** What the page sends the worker. */
export type SpeechRequest =
  /** Files of the pack (all four at first; one again after a `bad`), each with the SHA-256 it must have. */
  | { t: 'load'; files: { role: SpeechRole; bytes: ArrayBuffer; sha256: string }[] }
  /** One utterance to read: 16 kHz samples. */
  | { t: 'read'; id: number; samples: Float32Array }

/** What the worker answers. */
export type SpeechReply =
  /** Every file checked, the model loaded: `ms` it took. */
  | { t: 'ready'; ms: number }
  /** A file's bytes are not the pin's (the worker keeps the others and waits for this one again). */
  | { t: 'bad'; role: SpeechRole }
  /** The model could not be loaded here, and why. */
  | { t: 'failed'; why: string }
  /** An utterance read. */
  | { t: 'read'; id: number; reading: Reading; ms: number }
  /** An utterance the runtime threw on. */
  | { t: 'error'; id: number; why: string }

/** The part of a Worker the engine uses. */
export interface SpeechWorkerLike {
  postMessage(message: SpeechRequest, transfer?: Transferable[]): void
  terminate(): void
  onmessage: ((e: { data: SpeechReply }) => void) | null
  onerror: ((e: unknown) => void) | null
}

/**
 * Where the recogniser stands. `off`: not asked yet. `waiting`: asked, and holding off (the browser is set to save
 * data; the site could not be reached just now). `absent`: this site serves no pack (final for the visit).
 * `checking`: asking the site. `getting`: the files are arriving (`pct`). `starting`: the worker is checking and
 * loading them. `ready`: utterances are read. `failed`: it could not be started, or stopped (`detail` says why).
 */
export type SpeechPhase = 'off' | 'waiting' | 'absent' | 'checking' | 'getting' | 'starting' | 'ready' | 'failed'

export interface SpeechState {
  readonly phase: SpeechPhase
  readonly detail: string
  /** Whole percent of the pack that has arrived, while `getting`. */
  readonly pct: number
  /** An utterance is being read right now. */
  readonly reading: boolean
}

/** A sentence that was heard. */
export interface Heard {
  readonly text: string
  /** How long the speech was, how long reading it took (ms), and how sure the model was (0..1). */
  readonly seconds: number
  readonly ms: number
  readonly sure: number
}

export interface SpeechEvents {
  change: SpeechState
  heard: Heard
  /** An utterance that gave no words, and why ('short', 'quiet', 'unsure', 'empty', 'late': dropped unread because
   *  newer speech was waiting, 'error'). For the console's count; nothing is said to the visitor. */
  dropped: { why: string; seconds: number }
}

export interface SpeechDeps {
  /** The page's fetch held to its own site (App.tsx siteFetch). */
  fetch: SiteFetch
  /** Makes the worker (speech.worker.ts, bundled into the page). */
  worker: () => SpeechWorkerLike
  /** Whether this page was served by a web server at all (a file opened from disk has nothing beside it). */
  served: () => boolean
  /** Where the pack is kept between visits (speechPack.ts speechStore); none keeps nothing. */
  store?: SpeechStore
  /** The connection as the browser describes it (siteAuto.ts readLink), or null where it does not say. */
  link?: () => Link | null
  pin?: SpeechPackPin
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

/** Utterances that may wait while one is read: a device slower than the speech drops the oldest waiting, not the newest. */
export const WAITING_MAX = 3
/** How long one reading may take before the worker is taken for hung: this, plus four times the utterance's length. */
export const READ_MS = 20_000
/** How long the worker may take to check and load the pack. */
export const LOAD_MS = 120_000
/** After a failed try, the next start() is held off this long: the first time, the second, and from the third on. */
export const RETRY_MS: readonly number[] = Object.freeze([15_000, 60_000, 300_000])
/** Tries a visit gets by itself; past them only a forced start() (the visitor's own ask) tries again. */
export const TRIES = 4
/** A sentence cut at the microphone's cap waits this long for its rest before it is passed on alone. */
export const JOIN_MS = 15_000

/** The words for each phase, for the pill's tooltip and the console. */
export function speechWord(s: SpeechState, pin: SpeechPackPin = SPEECH_PACK): string {
  switch (s.phase) {
    case 'off': return 'words: not started'
    case 'waiting': return `words: waiting (${s.detail})`
    case 'absent': return `words: this page has no speech pack beside it (${s.detail})`
    case 'checking': return 'words: asking this site for the speech pack'
    case 'getting': return `words: getting the speech pack, ${s.pct}% of ${speechSize(pin)}`
    case 'starting': return 'words: starting the recogniser'
    case 'ready': return `words: understood on this device (${pin.name})`
    case 'failed': return `words: not available (${s.detail})`
  }
}

/**
 * The few words beside the pill while words are not being understood yet, or cannot be: '' when they are, or when
 * nothing was asked. The pill's tooltip has the whole sentence (speechWord).
 */
export function speechNote(s: SpeechState): string {
  switch (s.phase) {
    case 'checking': return 'words soon'
    case 'getting': return `words ${s.pct}%`
    case 'starting': return 'words starting'
    case 'waiting': return 'words waiting'
    case 'failed': return 'no words'
    default: return ''
  }
}

const say = (e: unknown): string => (e instanceof Error && e.message ? e.message : String(e))

/** A kept file turned out not to be the pin's while the connection says not to download unasked: not a failure, a wait. */
class LinkHeld extends Error {}

/** The page's speech recogniser. One per page. */
export class SpeechEngine extends EventTarget {
  readonly #d: SpeechDeps
  readonly #pin: SpeechPackPin
  readonly #now: () => number
  readonly #setTimeout: (fn: () => void, ms: number) => unknown
  readonly #clearTimeout: (h: unknown) => void
  #phase: SpeechPhase = 'off'
  #detail = ''
  #pct = 0
  #worker: SpeechWorkerLike | null = null
  /** Bumped by every start and stop: a start that awaited the site does nothing if it changed meanwhile. */
  #generation = 0
  #abort: AbortController | null = null
  /** Failed tries this visit, and when the last one ended. */
  #fails = 0
  #failedAt = -Infinity
  /** Utterances waiting to be read, and the one being read (its id, its length, its watchdog). */
  #waiting: { samples: Float32Array; cut: boolean }[] = []
  #current: { id: number; seconds: number; cut: boolean; timer: unknown } | null = null
  #nextId = 1
  /** The text of a sentence cut at the cap, waiting for its rest (and the timer that passes it on alone). */
  #held: { text: string; seconds: number; ms: number; sure: number; timer: unknown } | null = null
  /** Waiting because the connection says not to download unasked (not because the site could not be asked). */
  #linkHeld = false
  #disposed = false
  /** Counts for the console: sentences heard, utterances dropped by reason. */
  readonly counts: Record<string, number> = { heard: 0 }

  constructor(d: SpeechDeps) {
    super()
    this.#d = d
    this.#pin = d.pin ?? SPEECH_PACK
    this.#now = d.now ?? (() => (typeof performance === 'undefined' ? Date.now() : performance.now()))
    this.#setTimeout = d.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this.#clearTimeout = d.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  get state(): SpeechState { return { phase: this.#phase, detail: this.#detail, pct: this.#pct, reading: this.#current !== null } }
  get phase(): SpeechPhase { return this.#phase }
  /** Utterances are read. */
  get ready(): boolean { return this.#phase === 'ready' }
  /** The recogniser is ready or on its way: the page need not start a browser's own recogniser beside it. */
  get claims(): boolean { return this.#phase === 'checking' || this.#phase === 'getting' || this.#phase === 'starting' || this.#phase === 'ready' }
  /** Waiting only because the connection says not to download unasked (mobile data, a data saver): a forced start() gets it. */
  get held(): boolean { return this.#phase === 'waiting' && this.#linkHeld }
  /** One line for the pill's tooltip and the console. */
  word(): string { return speechWord(this.state, this.#pin) }

  /**
   * Starts the recogniser if it is not started: asks the site for the pack, gets it, loads it. Safe to call often
   * (every time the microphone opens, every time speech starts): it does nothing while it is on its way or ready, on
   * a site that has no pack, or within the hold-off after a failed try. `force` (the visitor's own ask) skips the
   * hold-off, the data saver's wait and the count of tries. Resolves with the state it reached; never rejects.
   */
  async start(force = false): Promise<SpeechState> {
    if (this.#disposed || this.claims) return this.state
    if (this.#phase === 'absent') return this.state
    if (!force) {
      if (this.#fails >= TRIES) return this.state
      if (this.#fails > 0 && this.#now() - this.#failedAt < RETRY_MS[Math.min(this.#fails, RETRY_MS.length) - 1]) return this.state
    }
    // Still held by the connection, and not the visitor's own ask: nothing has changed, so nothing is read or said again.
    if (!force && this.held && linkHold(this.#d.link?.() ?? null) !== null) return this.state
    if (!this.#d.served()) return this.#set('absent', 'it was opened as a file, not served by a site')
    const generation = ++this.#generation
    const abort = new AbortController()
    this.#abort = abort
    const mine = (): boolean => generation === this.#generation && !this.#disposed
    const store = this.#d.store
    // What an earlier visit kept: with all of it here, nothing is asked of the network at all.
    this.#set('checking')
    const kept = new Map<SpeechRole, ArrayBuffer>()
    if (store) {
      for (const f of this.#pin.files) {
        const bytes = await store.get(f)
        if (!mine()) return this.state
        if (bytes !== null) kept.set(f.role, bytes)
      }
    }
    const missing = this.#pin.files.filter((f) => !kept.has(f.role))
    if (missing.length > 0) {
      const hold = force ? null : linkHold(this.#d.link?.() ?? null)
      this.#linkHeld = hold !== null
      if (hold !== null) return this.#set('waiting', hold)
      let offered: boolean
      try {
        offered = await speechOffered(this.#d.fetch, this.#pin, abort.signal)
      } catch (e) {
        if (!mine()) return this.state
        // The site could not say just now: not a failure of the recogniser, but asked again no sooner than a failure.
        this.#failed()
        return this.#set('waiting', `this site could not be asked for it just now (${say(e)})`)
      }
      if (!mine()) return this.state
      if (!offered) return this.#set('absent', 'this site serves none')
      this.#pct = 0
      this.#set('getting')
      const total = missing.reduce((n, f) => n + f.bytes, 0)
      let got = 0
      const onBytes = (n: number): void => {
        got += n
        const pct = Math.min(100, Math.floor((got / total) * 100))
        if (pct !== this.#pct && mine()) { this.#pct = pct; this.#emit('change', this.state) }
      }
      try {
        await Promise.all(missing.map(async (f) => {
          const bytes = await fetchSpeechFile(this.#d.fetch, f, onBytes, abort.signal)
          // Kept before it is handed on (the worker takes the bytes away with it); the worker's check forgets a bad one.
          await store?.put(f, bytes)
          kept.set(f.role, bytes)
        }))
      } catch (e) {
        abort.abort()
        if (!mine()) return this.state
        this.#failed()
        return this.#set('failed', say(e))
      }
    }
    const files = this.#pin.files.map((f) => ({ f, bytes: kept.get(f.role)! }))
    if (!mine()) return this.state
    this.#set('starting')
    try {
      await this.#load(files, abort.signal, mine, () => (force ? null : linkHold(this.#d.link?.() ?? null)))
    } catch (e) {
      if (!mine()) return this.state
      this.#drop()
      if (e instanceof LinkHeld) {
        this.#linkHeld = true
        return this.#set('waiting', e.message)
      }
      this.#failed()
      return this.#set('failed', say(e))
    }
    if (!mine()) return this.state
    this.#fails = 0
    return this.#set('ready', this.#pin.name)
  }

  /**
   * The worker checks and loads the files; a file whose hash is wrong is forgotten and fetched once more past the
   * cache (unless `hold` says the connection is not to be used unasked: then it is forgotten and waited for).
   */
  #load(files: { f: SpeechFile; bytes: ArrayBuffer }[], signal: AbortSignal, mine: () => boolean, hold: () => string | null): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let worker: SpeechWorkerLike
      try {
        worker = this.#d.worker()
      } catch (e) {
        reject(new Error(`this browser could not start the recogniser's worker (${say(e)})`))
        return
      }
      this.#worker = worker
      const again = new Set<SpeechRole>()
      const timer = this.#setTimeout(() => reject(new Error('the recogniser took too long to start')), LOAD_MS)
      const done = (fn: () => void): void => { this.#clearTimeout(timer); fn() }
      // Stopped while it was loading: the wait ends now, not when the timer would have.
      signal.addEventListener('abort', () => done(() => reject(new Error('the recogniser was stopped'))), { once: true })
      worker.onerror = (e) => done(() => reject(new Error(`the recogniser's worker stopped (${say((e as { message?: unknown })?.message ?? e)})`)))
      worker.onmessage = (e) => {
        const m = e.data
        if (!mine() || this.#worker !== worker) return
        if (m.t === 'ready') {
          done(() => {
            worker.onmessage = (ev) => this.#reply(worker, ev.data)
            worker.onerror = (ev) => this.#crashed(worker, say((ev as { message?: unknown })?.message ?? ev))
            resolve()
          })
        } else if (m.t === 'failed') {
          done(() => reject(new Error(m.why)))
        } else if (m.t === 'bad') {
          const f = this.#pin.files.find((x) => x.role === m.role)
          if (!f || again.has(m.role)) {
            done(() => reject(new Error(`what this site sent as ${f?.file ?? m.role} is not the speech pack this page was built for (its SHA-256 differs), so it was not run`)))
            return
          }
          again.add(m.role)
          // The kept copy (or what the cache gave) is not the pin's: forgotten, and asked for once more past every cache.
          const store = this.#d.store
          const held = hold()
          if (held !== null) {
            void (store?.drop(f) ?? Promise.resolve()).then(() => done(() => reject(new LinkHeld(held))))
            return
          }
          void (async () => {
            await store?.drop(f)
            const bytes = await fetchSpeechFile(this.#d.fetch, f, () => undefined, signal, true)
            await store?.put(f, bytes)
            return bytes
          })().then(
            (bytes) => { if (mine() && this.#worker === worker) worker.postMessage({ t: 'load', files: [{ role: f.role, bytes, sha256: f.sha256 }] }, [bytes]) },
            (err: unknown) => done(() => reject(err instanceof Error ? err : new Error(String(err)))),
          )
        }
      }
      worker.postMessage({ t: 'load', files: files.map(({ f, bytes }) => ({ role: f.role, bytes, sha256: f.sha256 })) }, files.map(({ bytes }) => bytes))
    })
  }

  /**
   * Reads an utterance (16 kHz samples; `cut` when the microphone cut it at its cap and the rest follows). Returns
   * false, and keeps nothing, unless the recogniser is ready. Readings come back in order as `heard`.
   */
  read(samples: Float32Array, cut = false): boolean {
    if (this.#phase !== 'ready' || this.#worker === null || samples.length === 0) return false
    this.#waiting.push({ samples, cut })
    while (this.#waiting.length > WAITING_MAX) {
      const old = this.#waiting.shift()!
      this.#count('late', old.samples.length / 16_000)
    }
    this.#pump()
    return true
  }

  #pump(): void {
    const worker = this.#worker
    if (this.#current !== null || worker === null || this.#phase !== 'ready') return
    const next = this.#waiting.shift()
    if (!next) return
    const id = this.#nextId++
    const seconds = next.samples.length / 16_000
    const timer = this.#setTimeout(() => this.#crashed(worker, 'it stopped answering'), READ_MS + seconds * 4_000)
    this.#current = { id, seconds, cut: next.cut, timer }
    try {
      worker.postMessage({ t: 'read', id, samples: next.samples }, [next.samples.buffer as ArrayBuffer])
    } catch (e) {
      this.#crashed(worker, say(e))
      return
    }
    this.#emit('change', this.state)
  }

  #reply(worker: SpeechWorkerLike, m: SpeechReply): void {
    if (this.#worker !== worker || this.#current === null) return
    if (m.t !== 'read' && m.t !== 'error') return
    if (m.id !== this.#current.id) return
    const cur = this.#current
    this.#clearTimeout(cur.timer)
    this.#current = null
    if (m.t === 'error') {
      this.#count('error', cur.seconds)
      if (!cur.cut) this.flush()
    } else if (m.reading.text === '') {
      this.#count(m.reading.dropped || 'empty', cur.seconds)
      // The rest of a cut sentence gave nothing: what was held goes on alone.
      if (!cur.cut) this.flush()
    } else {
      this.#said({ text: m.reading.text, seconds: cur.seconds, ms: m.ms, sure: m.reading.sure }, cur.cut)
    }
    this.#emit('change', this.state)
    this.#pump()
  }

  /** A reading with words: joined to a held first part, then passed on, or held if its own rest is still to come. */
  #said(h: Heard, cut: boolean): void {
    const held = this.#held
    if (held) {
      this.#clearTimeout(held.timer)
      this.#held = null
      h = { text: `${held.text} ${h.text}`, seconds: held.seconds + h.seconds, ms: held.ms + h.ms, sure: Math.min(held.sure, h.sure) }
    }
    if (cut) {
      this.#held = { ...h, timer: this.#setTimeout(() => this.flush(), JOIN_MS) }
      return
    }
    this.counts.heard++
    this.#emit('heard', h)
  }

  /** Passes on what is held of a cut sentence (the microphone closed, or its rest never came). */
  flush(): void {
    const held = this.#held
    if (!held) return
    this.#clearTimeout(held.timer)
    this.#held = null
    this.counts.heard++
    this.#emit('heard', { text: held.text, seconds: held.seconds, ms: held.ms, sure: held.sure })
  }

  #count(why: string, seconds: number): void {
    this.counts[why] = (this.counts[why] ?? 0) + 1
    this.#emit('dropped', { why, seconds })
  }

  /** The worker died or hung while ready: everything waiting is dropped, and the next start() makes a new one. */
  #crashed(worker: SpeechWorkerLike, why: string): void {
    if (this.#worker !== worker) return
    // What was already read of a cut sentence is still the visitor's words.
    this.flush()
    this.#drop()
    this.#failed()
    this.#set('failed', `the recogniser stopped (${why})`)
  }

  #failed(): void {
    this.#fails++
    this.#failedAt = this.#now()
  }

  /** Ends the worker and forgets what was waiting. */
  #drop(): void {
    const w = this.#worker
    this.#worker = null
    if (w) {
      w.onmessage = null
      w.onerror = null
      try { w.terminate() } catch { /* already gone */ }
    }
    if (this.#current) this.#clearTimeout(this.#current.timer)
    this.#current = null
    this.#waiting = []
    if (this.#held) this.#clearTimeout(this.#held.timer)
    this.#held = null
  }

  /** Stops the recogniser and frees its memory (the model is some tens of megabytes): the next start() loads it again. */
  stop(): void {
    this.#generation++
    this.#abort?.abort()
    this.#abort = null
    this.#drop()
    if (this.#phase !== 'absent' && this.#phase !== 'off') this.#set('off')
  }

  dispose(): void {
    this.stop()
    this.#disposed = true
  }

  #set(phase: SpeechPhase, detail = ''): SpeechState {
    this.#phase = phase
    this.#detail = detail
    const s = this.state
    this.#emit('change', s)
    return s
  }

  #emit<K extends keyof SpeechEvents>(type: K, detail: SpeechEvents[K]): void {
    this.dispatchEvent(new CustomEvent(type, { detail }))
  }
}
