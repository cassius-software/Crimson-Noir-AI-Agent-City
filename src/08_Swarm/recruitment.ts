// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is how the operator hires from the crowd by speaking: a continuously listening
 * speech recogniser on the page (the browser's own, on-device only), a parser that hears "recruit a Rust
 * developer", the proximity rule run on the main thread against the newest pedestrian positions the page holds
 * (every person not already asked, measured from where the operator's head stands: only someone within
 * AUDIBLE_RADIUS, on the operator's own side of the street, with the skill), and the request to the physics
 * worker to walk that person over. The worker decides again on its own readings (simCore.ts) and answers; the
 * person is Interviewing from the request on, walking over, then Active once they reach the operator: tethered,
 * following the operator and stopping 1.5 m away, their skills on the HUD, until the worker lets them go. The
 * same request is one call without a microphone: `recruit("Rust")` in the browser console, or `recruit rust` in
 * the Ring-0 console. An Active recruit can also be asked to walk to a sidewalk point instead of to the operator (a
 * rally, `rally(agent, x, z)`): checked here on the page's copy first, then decided by the worker on its own
 * readings, like any request; it moves nobody and promotes nobody. Voice never leaves the device: a recogniser that cannot promise on-device processing is not
 * used, and the on-device model is only ever installed on the operator's explicit command.
 * What breaks if it is removed? The operator has no way to ask anyone over, by voice or by command.
 */
import { AUDIBLE_RADIUS, findRecruit, parseRequest, SKILL_WORDS, SKILLS, skillNamed, whyNot, whyNotRally, type Skill } from '../03_Spawn_Agents/skills.ts'
import type { RecruitHost } from '../07_Execute_Actions/engine.ts'
import type { RecruitView, StepState } from '../07_Execute_Actions/simProtocol.ts'
import type { RecruitBridge } from '../07_Execute_Actions/terminal/bridge.ts'

/** Recognition language (the parser's words are English). */
export const SPEECH_LANG = 'en-US'
/** How often the page refreshes its copy of the pedestrians' positions, ms (the worker checks again on its own). */
const COPY_INTERVAL_MS = 250
/**
 * States from the physics worker a request may go unanswered before the page gives up on it. The answer comes in the
 * state for the step that carried the request (one or two states later), so this only trips if it was lost. Counted in
 * states, not seconds: while the page is hidden no step is sent, the request has not been made yet, and it waits.
 */
const ANSWER_STATES = 30
/** How long `listen` waits for the microphone to open (the browser's permission prompt included) before it reports, ms. */
const LISTEN_WAIT_MS = 8000
/** Restarts of a recogniser that keeps ending allowed per minute before the page gives up on it. */
const MAX_RESTARTS_PER_MINUTE = 20

/** The microphone as the operator sees it. */
export type MicState = 'off' | 'starting' | 'listening' | 'unavailable' | 'needs-model' | 'installing' | 'blocked' | 'error'

/** One request's answer. */
export interface RecruitOutcome {
  ok: boolean
  skill: Skill | null
  /** The person coming over (-1: nobody). */
  agent: number
  /** Their distance from the operator when asked, m (-1: nobody). */
  distance: number
  /** One line for a console or a toast. */
  message: string
}

/** A pedestrian's recruitment state on the page: nobody has asked them, they are walking over, or they are tethered. */
export type AgentState = 'Idle' | 'Interviewing' | 'Active'

/** The detail of each event the Recruiter dispatches (as CustomEvent). */
export interface RecruitEvents {
  /** A final transcript from the recogniser. */
  heard: { transcript: string }
  /** The main-thread match: someone within earshot has the skill (the worker has been asked to bring them over). */
  recruit: { agent: number; skill: Skill; distance: number }
  refused: { skill: Skill | null; reason: string }
  /** They reached the operator: Active, tethered, bringing these skills. */
  active: { agent: number; skill: string; skills: string[] }
  released: { agent: number; skill: string; reason: string }
  /** The worker's answer to a rally: the Active recruit is walking to the point, or why not. */
  rally: { agent: number; x: number; z: number; ok: boolean; reason: string }
  mic: { state: MicState; detail: string }
}

/** A rally's answer: whether the recruit is walking to the point, and one line for a console or a toast. */
export interface RallyOutcome { ok: boolean; message: string }

// ---------------------------------------------------------------- the browser's speech recognition, minimally typed

interface SpeechAlternativeLike { transcript: string }
interface SpeechResultLike { readonly isFinal: boolean; readonly length: number; [i: number]: SpeechAlternativeLike }
interface SpeechResultEventLike { readonly resultIndex: number; readonly results: { readonly length: number; [i: number]: SpeechResultLike } }
interface SpeechErrorEventLike { readonly error: string; readonly message?: string }
interface RecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  processLocally?: boolean
  phrases?: unknown
  onresult: ((e: SpeechResultEventLike) => void) | null
  onerror: ((e: SpeechErrorEventLike) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
interface LocalOptions { langs: string[]; processLocally: boolean }
interface RecognitionClass {
  new (): RecognitionLike
  readonly prototype: object
  available?(o: LocalOptions): Promise<string>
  install?(o: LocalOptions): Promise<boolean>
}
type PhraseClass = new (phrase: string, boost: number) => unknown

/** What the page has of Web Speech: the recogniser (standard name, or the older prefixed one) and phrase biasing. */
export interface SpeechEnv {
  Recognition: RecognitionClass | null
  Phrase: PhraseClass | null
}

export function speechEnv(g: object = globalThis): SpeechEnv {
  const w = g as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown; SpeechRecognitionPhrase?: unknown }
  const R = w.SpeechRecognition ?? w.webkitSpeechRecognition
  return {
    Recognition: typeof R === 'function' ? (R as RecognitionClass) : null,
    Phrase: typeof w.SpeechRecognitionPhrase === 'function' ? (w.SpeechRecognitionPhrase as PhraseClass) : null,
  }
}

/** The time, for timeouts and the copy cadence (a test passes its own). */
export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}
const realClock: Clock = {
  now: () => (typeof performance === 'undefined' ? Date.now() : performance.now()),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

const LOCAL: LocalOptions = { langs: [SPEECH_LANG], processLocally: true }
const USE_THE_COMMAND = 'type recruit <skill> in the console instead'

interface Pending { resolve: (o: RecruitOutcome) => void; skill: Skill; agent: number; states: number }
interface PendingRally { resolve: (o: RallyOutcome) => void; x: number; z: number; states: number }

export class Recruiter extends EventTarget {
  readonly #host: RecruitHost
  readonly #speech: SpeechEnv
  readonly #clock: Clock
  readonly #unsubscribe: () => void
  /** The page's own copy of every pedestrian's (x, z), refreshed from the render frames at most every COPY_INTERVAL_MS. */
  #xz: Float32Array | null = null
  #copiedAt = -Infinity
  /** Everyone asked over as far as the page knows: its own matches at once, then the worker's list each step. */
  readonly #states = new Map<number, Skill | string>()
  #recruits: RecruitView[] = []
  /** Told of every new copy of the worker's list (onMirror). */
  readonly #mirrorListeners = new Set<(recruits: readonly RecruitView[]) => void>()
  readonly #pending = new Map<number, Pending>()
  /** Rallies sent and not yet answered, by the recruit's pedestrian number (one at a time per recruit). */
  readonly #rallies = new Map<number, PendingRally>()
  /** Requests the page gave up on: if the worker still accepts one, the person is let go at once (never a silent summons). */
  readonly #abandoned = new Set<number>()
  #id = 0
  #mic: MicState = 'off'
  #micDetail = ''
  #heard = ''
  #last = ''
  #recognition: RecognitionLike | null = null
  /** The operator asked for the microphone and has not stopped it: an ended session restarts. */
  #wantListening = false
  #restarts: number[] = []
  #restartTimer: unknown = null
  /** Bumped by every listen() and stop(): a listen() that awaited the model check starts nothing if it changed meanwhile. */
  #generation = 0
  /** Resolves the listen() waiting for the microphone to open or fail. */
  #settle: ((m: { state: MicState; detail: string }) => void) | null = null
  /** The browser refused phrase biasing: sessions start without it. */
  #noPhrases = false
  /** An install() is awaiting the browser (the 'installing' state alone may also mean a download the browser started). */
  #installing = false
  #disposed = false

  constructor(host: RecruitHost, speech: SpeechEnv = speechEnv(), clock: Clock = realClock) {
    super()
    this.#host = host
    this.#speech = speech
    this.#clock = clock
    this.#unsubscribe = host.onState((s) => this.#received(s))
  }

  /** Every skill the city's people have, for completion and help. */
  get skills(): readonly Skill[] {
    return SKILLS
  }

  get mic(): { state: MicState; detail: string } {
    return { state: this.#mic, detail: this.#micDetail }
  }

  /** Everyone the physics worker has walking over (Interviewing) or tethered to the operator (Active). */
  get recruits(): readonly RecruitView[] {
    return this.#recruits
  }

  /**
   * Calls `fn` with the worker's list each time the page's copy is replaced: at every state from the worker, before
   * that state's events are dispatched (so no event listener ever sees a copy older than its own state), and once
   * with an empty list when the recruiter is disposed. The task gateway (taskRouter.ts) re-checks its leases here.
   * Returns the unsubscribe.
   */
  onMirror(fn: (recruits: readonly RecruitView[]) => void): () => void {
    this.#mirrorListeners.add(fn)
    return () => { this.#mirrorListeners.delete(fn) }
  }

  /** The last transcript heard, and the last outcome. */
  get heard(): string { return this.#heard }
  get last(): string { return this.#last }

  /** Pedestrian `agent`'s state: Active once the worker reports them arrived, Interviewing from the ask until then. */
  stateOf(agent: number): AgentState {
    if (!this.#states.has(agent)) return 'Idle'
    return this.#recruits.some((r) => r.agent === agent && r.arrived) ? 'Active' : 'Interviewing'
  }

  /** Every skill the Active recruits bring, each once, in the order they joined: the operator's swarm. */
  get swarmSkills(): string[] {
    return swarmSkills(this.#recruits)
  }

  /** The fallback without a microphone: asks the nearest person within earshot who knows `skill` over. */
  recruit(skill: string): Promise<RecruitOutcome> {
    const s = skillNamed(typeof skill === 'string' ? skill : '')
    if (s === null) return Promise.resolve(this.#refuse(null, `unknown skill '${String(skill)}': ${SKILLS.join(', ')}`))
    return this.#ask(s)
  }

  /** A transcript (from the recogniser, or typed): a request if it names one, otherwise nothing happens. */
  hear(transcript: string): Promise<RecruitOutcome> | null {
    const t = typeof transcript === 'string' ? transcript.trim() : ''
    if (!t) return null
    this.#heard = t
    this.#emit('heard', { transcript: t })
    const skill = parseRequest(t)
    return skill === null ? null : this.#ask(skill)
  }

  /**
   * Asks Active recruit `agent` to walk to the sidewalk point (x, z) instead of to the operator. Checked here first on
   * the page's copy (on foot, an Active recruit, the point finite, off the road, within RALLY_RANGE of the operator,
   * a sidewalk path from where they stand: skills.ts whyNotRally), then sent; the worker decides again on its own
   * readings and its 'rally' event answers. The tether is unchanged either way.
   */
  rally(agent: number, x: number, z: number): Promise<RallyOutcome> {
    if (this.#disposed) return Promise.resolve(this.#refuseRally(agent, 'the city is not running'))
    if (!Number.isInteger(agent) || agent <= 0) return Promise.resolve(this.#refuseRally(agent, 'a rally names a recruit by their pedestrian number'))
    if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) return Promise.resolve(this.#refuseRally(agent, 'the rally point is nowhere'))
    const operator = this.#host.operator()
    if (operator === null) return Promise.resolve(this.#refuseRally(agent, 'rallying works on foot'))
    if (this.stateOf(agent) !== 'Active') return Promise.resolve(this.#refuseRally(agent, 'only an Active recruit is sent to a rally point'))
    const xz = this.#xz
    if (xz === null) return Promise.resolve(this.#refuseRally(agent, 'the crowd has not been seen yet'))
    const why = whyNotRally(operator, xz, agent, x, z)
    if (why !== null) return Promise.resolve(this.#refuseRally(agent, why))
    if (this.#rallies.has(agent)) return Promise.resolve(this.#refuseRally(agent, 'their last rally has not been answered yet'))
    this.#host.send({ c: 'rally', agent, x, z })
    return new Promise((resolve) => { this.#rallies.set(agent, { resolve, x, z, states: 0 }) })
  }

  /** Ends every interview. */
  dismiss(): void {
    if (this.#disposed) return
    this.#host.send({ c: 'dismiss' })
  }

  /**
   * Opens the microphone for continuous on-device recognition (the browser asks for permission the first time).
   * Resolves with the microphone's state once known: listening, or why not (after LISTEN_WAIT_MS, still starting while
   * the browser's prompt is open). A recogniser that cannot promise on-device processing is never started: the audio
   * would leave the device.
   */
  async listen(): Promise<{ state: MicState; detail: string }> {
    if (this.#disposed) return this.mic
    const R = this.#speech.Recognition
    if (!R) return this.#setMic('unavailable', `this browser has no speech recognition: ${USE_THE_COMMAND}`)
    if (!('processLocally' in R.prototype)) {
      return this.#setMic('unavailable', `this browser cannot promise on-device recognition, so your voice would leave the device: ${USE_THE_COMMAND}`)
    }
    if (this.#mic === 'listening' || this.#mic === 'starting' || this.#installing) return this.mic
    const generation = ++this.#generation
    this.#wantListening = true
    this.#setMic('starting', 'checking the on-device speech model')
    if (typeof R.available === 'function') {
      let availability = ''
      try {
        availability = await R.available(LOCAL)
      } catch (e) {
        this.#wantListening = false
        return this.#setMic('error', `speech recognition failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      if (generation !== this.#generation || !this.#wantListening || this.#disposed) return this.mic
      if (availability === 'downloadable') { this.#wantListening = false; return this.#setMic('needs-model', `the on-device ${SPEECH_LANG} speech model is not installed: run 'recruit install' (the browser downloads it once)`) }
      if (availability === 'downloading') { this.#wantListening = false; return this.#setMic('installing', `the on-device ${SPEECH_LANG} speech model is still downloading; try 'recruit listen' again shortly`) }
      if (availability !== 'available') { this.#wantListening = false; return this.#setMic('unavailable', `on-device ${SPEECH_LANG} recognition is not supported here: ${USE_THE_COMMAND}`) }
    }
    const settled = new Promise<{ state: MicState; detail: string }>((resolve) => { this.#settle = resolve })
    this.#setMic('starting', 'waiting for the microphone (the browser may ask for permission)')
    const timer = this.#clock.setTimeout(() => this.#settleWith(), LISTEN_WAIT_MS)
    this.#start()
    const m = await settled
    this.#clock.clearTimeout(timer)
    return m
  }

  /** Closes the microphone. */
  stop(): { state: MicState; detail: string } {
    this.#generation++
    this.#wantListening = false
    this.#clock.clearTimeout(this.#restartTimer)
    this.#restartTimer = null
    const r = this.#recognition
    this.#recognition = null
    if (r) {
      r.onend = null; r.onerror = null; r.onresult = null; r.onstart = null
      try { r.abort() } catch { /* already stopped */ }
    }
    if (this.#mic === 'listening' || this.#mic === 'starting') this.#setMic('off', '')
    this.#settleWith()
    return this.mic
  }

  /**
   * Asks the browser to download its on-device speech model, the one step that reaches the network, and only on the
   * operator's command. Call it inside a user gesture (the console's Enter keydown); resolves with the result. Refused
   * while the microphone is open or opening: the state it reports must never hide a live microphone.
   */
  async install(): Promise<{ state: MicState; detail: string }> {
    if (this.#disposed) return this.mic
    if (this.#wantListening || this.#recognition !== null || this.#mic === 'listening' || this.#mic === 'starting') {
      return { state: this.#mic, detail: "the microphone is open: run 'recruit stop' first, then 'recruit install'" }
    }
    if (this.#installing) return this.mic
    const R = this.#speech.Recognition
    if (!R || typeof R.install !== 'function') return this.#setMic('unavailable', `this browser cannot install an on-device speech model: ${USE_THE_COMMAND}`)
    this.#setMic('installing', `downloading the on-device ${SPEECH_LANG} speech model`)
    let ok = false
    this.#installing = true
    try {
      ok = await R.install(LOCAL)
    } catch (e) {
      return this.#setMic('error', `the speech model did not install: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      this.#installing = false
    }
    return ok
      ? this.#setMic('off', `on-device ${SPEECH_LANG} speech model installed: run 'recruit listen'`)
      : this.#setMic('needs-model', 'the browser did not install the speech model (it needs a click or key press to allow it)')
  }

  /** Closes the microphone, lets everyone go, and stops listening to the city. */
  dispose(): void {
    if (this.#disposed) return
    this.stop()
    this.#disposed = true
    this.#unsubscribe()
    for (const [id, p] of this.#pending) {
      this.#pending.delete(id)
      p.resolve({ ok: false, skill: p.skill, agent: -1, distance: -1, message: 'the city stopped' })
    }
    for (const [agent, p] of this.#rallies) {
      this.#rallies.delete(agent)
      p.resolve({ ok: false, message: 'the city stopped' })
    }
    this.#states.clear()
    this.#mirror([])
    this.#mirrorListeners.clear()
  }

  /** Replaces the page's copy of the worker's list and tells every mirror listener, each on its own. */
  #mirror(list: RecruitView[]): void {
    this.#recruits = list
    for (const fn of [...this.#mirrorListeners]) {
      try {
        fn(list)
      } catch (e) {
        console.error(e)
      }
    }
  }

  // ---------------------------------------------------------------- matching

  /**
   * The operator's request on the main thread: every pedestrian not already Interviewing is measured from the
   * operator (the head's position, head.ts); the nearest within AUDIBLE_RADIUS, on this side of the street, with the
   * skill, becomes Interviewing, and the physics worker is asked to walk them over.
   */
  #ask(skill: Skill): Promise<RecruitOutcome> {
    if (this.#disposed) return Promise.resolve(this.#refuse(skill, 'the city is not running'))
    const operator = this.#host.operator()
    const why = whyNot(operator)
    if (why !== null || operator === null) return Promise.resolve(this.#refuse(skill, why ?? 'recruiting works on foot'))
    const xz = this.#xz
    if (xz === null) return Promise.resolve(this.#refuse(skill, 'the crowd has not been seen yet'))
    const found = findRecruit(xz, operator, skill, (a) => this.#states.has(a))
    if (found === null) return Promise.resolve(this.#refuse(skill, `nobody within ${AUDIBLE_RADIUS} m on this side of the street knows ${skill}`))
    this.#states.set(found.agent, skill)
    this.#emit('recruit', { agent: found.agent, skill, distance: found.distance })
    const id = ++this.#id
    this.#host.send({ c: 'recruit', id, skill, agent: found.agent })
    return new Promise((resolve) => { this.#pending.set(id, { resolve, skill, agent: found.agent, states: 0 }) })
  }

  #refuse(skill: Skill | null, reason: string): RecruitOutcome {
    this.#last = skill ? `${skill}: ${reason}` : reason
    this.#emit('refused', { skill, reason })
    return { ok: false, skill, agent: -1, distance: -1, message: this.#last }
  }

  #refuseRally(agent: number, reason: string, x = NaN, z = NaN): RallyOutcome {
    this.#last = `rally: ${reason}`
    this.#emit('rally', { agent: Number.isInteger(agent) ? agent : -1, x, z, ok: false, reason })
    return { ok: false, message: this.#last }
  }

  /** Each state from the physics worker: the page's position copy, the answers to requests, and who is over now. */
  #received(s: StepState): void {
    const frame = s.crowdFrame
    const n = this.#host.agents
    const now = this.#clock.now()
    if (frame && frame.length >= 4 * n && now - this.#copiedAt >= COPY_INTERVAL_MS) {
      const xz = this.#xz ?? (this.#xz = new Float32Array(2 * n))
      for (let i = 0; i < n; i++) {
        xz[2 * i] = frame[4 * i]
        xz[2 * i + 1] = frame[4 * i + 2]
      }
      this.#copiedAt = now
    }
    // The worker's list is the truth, and it is replaced first: the mirror listeners (the task gateway's leases) see
    // this state before any of its events is dispatched.
    this.#mirror(s.recruits ?? [])
    for (const ev of s.events) {
      if (ev.e === 'recruit') {
        const p = this.#pending.get(ev.id)
        if (!p) {
          // Accepted after the page gave up and told the operator nobody was coming: let them go at once.
          if (this.#abandoned.delete(ev.id) && ev.ok) this.#host.send({ c: 'dismiss', agent: ev.agent })
          continue
        }
        this.#pending.delete(ev.id)
        this.#states.delete(p.agent)
        if (ev.ok) {
          this.#states.set(ev.agent, ev.skill)
          const x = this.#xz?.[2 * ev.agent], z = this.#xz?.[2 * ev.agent + 1]
          if (x !== undefined && z !== undefined) this.#host.cue(x, z)
          this.#last = `${ev.skill}: someone ${ev.distance.toFixed(1)} m away is coming over`
          p.resolve({ ok: true, skill: p.skill, agent: ev.agent, distance: ev.distance, message: this.#last })
        } else {
          p.resolve(this.#refuse(p.skill, ev.reason))
        }
      } else if (ev.e === 'active') {
        this.#last = `${ev.skill}: tethered · ${ev.skills.join(', ')}`
        this.#emit('active', { agent: ev.agent, skill: ev.skill, skills: [...ev.skills] })
      } else if (ev.e === 'released') {
        this.#states.delete(ev.agent)
        this.#last = `${ev.skill}: ${ev.reason}`
        this.#emit('released', { agent: ev.agent, skill: ev.skill, reason: ev.reason })
      } else if (ev.e === 'rally') {
        const p = this.#rallies.get(ev.agent)
        if (!p) continue // not one of the page's (or given up on): nothing to answer
        this.#rallies.delete(ev.agent)
        if (ev.ok) {
          this.#last = `rally: someone is walking to (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`
          this.#emit('rally', { agent: ev.agent, x: p.x, z: p.z, ok: true, reason: '' })
          p.resolve({ ok: true, message: this.#last })
        } else {
          p.resolve(this.#refuseRally(ev.agent, ev.reason ?? 'refused', p.x, p.z))
        }
      }
    }
    // A request with no answer after ANSWER_STATES states was lost: given up, and withdrawn if it turns up later.
    for (const [id, p] of this.#pending) {
      if (++p.states < ANSWER_STATES) continue
      this.#pending.delete(id)
      this.#abandoned.add(id)
      p.resolve(this.#refuse(p.skill, 'the physics worker did not answer'))
    }
    // A rally with no answer was lost too: nothing to withdraw, the recruit walks nowhere new without an acceptance.
    for (const [agent, p] of this.#rallies) {
      if (++p.states < ANSWER_STATES) continue
      this.#rallies.delete(agent)
      p.resolve(this.#refuseRally(agent, 'the physics worker did not answer', p.x, p.z))
    }
    // The page's own matches stay only while their answer is still on its way.
    const waiting = new Set([...this.#pending.values()].map((p) => p.agent))
    for (const a of [...this.#states.keys()]) if (!waiting.has(a) && !this.#recruits.some((r) => r.agent === a)) this.#states.delete(a)
    for (const r of this.#recruits) this.#states.set(r.agent, r.skill)
  }

  // ---------------------------------------------------------------- the recogniser

  #start(): void {
    const R = this.#speech.Recognition
    if (!R || this.#disposed || !this.#wantListening) return
    // Never two sessions: one still here is detached and aborted first.
    const old = this.#recognition
    this.#recognition = null
    if (old) {
      old.onend = null; old.onerror = null; old.onresult = null; old.onstart = null
      try { old.abort() } catch { /* already stopped */ }
    }
    let r: RecognitionLike
    try {
      r = new R()
      r.lang = SPEECH_LANG
      r.continuous = true
      r.interimResults = false
      r.maxAlternatives = 3
      // On-device only: the audio never leaves the machine (the recogniser errors instead of falling back to a server).
      r.processLocally = true
      if (r.processLocally !== true) throw new Error('on-device processing was not accepted')
    } catch (e) {
      this.#wantListening = false
      this.#setMic('unavailable', `on-device recognition could not start (${e instanceof Error ? e.message : String(e)}): ${USE_THE_COMMAND}`)
      return
    }
    // Bias toward the words that matter here, where the browser supports it (optional).
    const Phrase = this.#speech.Phrase
    if (Phrase && !this.#noPhrases) {
      try { r.phrases = SKILLS.flatMap((s) => SKILL_WORDS[s]).concat(['recruit', 'hire']).map((w) => new Phrase(w, 5)) } catch { /* not supported */ }
    }
    r.onstart = () => {
      if (this.#recognition === r) this.#setMic('listening', `on-device ${SPEECH_LANG}: say "recruit" and a skill`)
    }
    r.onresult = (e) => {
      if (this.#recognition !== r) return
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]
        if (!res.isFinal) continue
        // The first alternative that makes a request wins; else the top one is what was heard.
        let chosen = res.length > 0 ? res[0].transcript : ''
        for (let k = 0; k < res.length; k++) if (parseRequest(res[k].transcript) !== null) { chosen = res[k].transcript; break }
        void this.hear(chosen)
      }
    }
    r.onerror = (e) => {
      if (this.#recognition !== r) return
      const why = e.error
      if (why === 'no-speech' || why === 'aborted') return // the session ends and restarts
      // Phrase biasing is optional: the session ends, and the next one starts without it.
      if (why === 'phrases-not-supported') { this.#noPhrases = true; return }
      this.#wantListening = false
      if (why === 'not-allowed') this.#setMic('blocked', `microphone permission was refused: ${USE_THE_COMMAND}`)
      else if (why === 'service-not-allowed') this.#setMic('blocked', `this browser does not allow speech recognition on this page: ${USE_THE_COMMAND}`)
      else if (why === 'language-not-supported') this.#setMic('needs-model', `the on-device ${SPEECH_LANG} speech model is not installed: run 'recruit install'`)
      else if (why === 'audio-capture') this.#setMic('error', `no microphone found: ${USE_THE_COMMAND}`)
      else this.#setMic('error', `speech recognition stopped (${why}): ${USE_THE_COMMAND}`)
    }
    r.onend = () => {
      if (this.#recognition !== r) return
      this.#recognition = null
      if (!this.#wantListening || this.#disposed) {
        if (this.#mic === 'listening' || this.#mic === 'starting') this.#setMic('off', '')
        return
      }
      // Continuous sessions still end (silence, a browser limit): start again, unless it keeps happening.
      const now = this.#clock.now()
      this.#restarts = this.#restarts.filter((t) => now - t < 60_000)
      this.#restarts.push(now)
      if (this.#restarts.length > MAX_RESTARTS_PER_MINUTE) {
        this.#wantListening = false
        this.#setMic('error', `speech recognition keeps stopping: ${USE_THE_COMMAND}`)
        return
      }
      this.#restartTimer = this.#clock.setTimeout(() => { this.#restartTimer = null; this.#start() }, 250)
    }
    this.#recognition = r
    try {
      r.start()
    } catch (e) {
      this.#recognition = null
      this.#wantListening = false
      this.#setMic('error', `speech recognition could not start: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  #setMic(state: MicState, detail: string): { state: MicState; detail: string } {
    this.#mic = state
    this.#micDetail = detail
    // A microphone that failed says so where the operator looks (the HUD line), not only in `recruit`'s status; once it
    // works again (listening, or the model installed) that failure is no longer news.
    if (state === 'blocked' || state === 'error' || state === 'needs-model' || state === 'unavailable') this.#last = `voice: ${detail}`
    else if ((state === 'listening' || state === 'off') && this.#last.startsWith('voice: ')) this.#last = ''
    this.#emit('mic', { state, detail })
    if (state !== 'starting') this.#settleWith()
    return this.mic
  }

  /** Answers the listen() waiting on the microphone with its state now. */
  #settleWith(): void {
    const settle = this.#settle
    this.#settle = null
    settle?.(this.mic)
  }

  #emit<K extends keyof RecruitEvents>(type: K, detail: RecruitEvents[K]): void {
    this.dispatchEvent(new CustomEvent(type, { detail }))
  }
}

/** Every skill the Active recruits in `list` bring, each once, in the order they joined. */
export function swarmSkills(list: readonly RecruitView[]): string[] {
  const out = new Set<string>()
  for (const r of list) if (r.arrived) for (const s of r.skills ?? [r.skill]) out.add(s)
  return [...out]
}

/** One recruit as a status line: skill, walking over or tethered, how far, how long, and what they bring once Active. */
export function recruitLine(r: RecruitView): string {
  const where = Number.isFinite(r.distance) ? `${r.distance.toFixed(1)} m` : '-'
  const brings = r.arrived && r.skills?.length ? `  [${r.skills.join(', ')}]` : ''
  return `${r.skill.padEnd(14)}${(r.arrived ? 'tethered' : 'coming over').padEnd(14)}${where.padStart(7)}  ${Math.floor(r.seconds)} s${brings}`
}

/** The microphone as one line. */
export function micLine(m: { state: MicState; detail: string }): string {
  return m.detail ? `${m.state} · ${m.detail}` : m.state
}

/**
 * What the HUD shows: whether the microphone is open, and one line about the swarm (every skill the Active recruits
 * bring, who is still walking over, and how many operator tasks, scripts or answers, are running bound to it: `tasks`,
 * from the task gateway), or the last outcome when nobody is over. `activity` (an answer streaming in) comes first,
 * so it stays in view when the line is cut short.
 */
export function hudLine(r: Recruiter, tasks = 0, activity = ''): { listening: boolean; line: string } {
  const list = r.recruits
  const active = list.filter((x) => x.arrived).length
  const coming = list.filter((x) => !x.arrived).map((x) => x.skill)
  const parts = [
    ...(activity ? [activity] : []),
    ...(active ? [`Active swarm ${active}: [${swarmSkills(list).join(', ')}]`] : []),
    ...(coming.length ? [`coming over · ${coming.join(', ')}`] : []),
    ...(tasks > 0 ? [`${tasks} ${tasks === 1 ? 'task' : 'tasks'} bound`] : []),
  ]
  return { listening: r.mic.state === 'listening', line: parts.length ? parts.join(' · ') : r.last }
}

/**
 * The console's surface over a recruiter (terminal/bridge.ts RecruitBridge): asking by skill, and `rally` (the
 * console's `recruit rally <agent>`: an Active recruit to the pinged sidewalk point).
 */
export function recruitBridge(r: Recruiter): RecruitBridge {
  return Object.freeze({
    ask: (skill: string) => r.recruit(skill).then((o) => ({ ok: o.ok, message: o.message, ...(o.ok && o.agent >= 0 ? { agent: o.agent } : {}) })),
    rally: (agent: number, x: number, z: number) => r.rally(agent, x, z).then((o) => ({ ok: o.ok, message: o.message })),
    listen: () => r.listen().then(micLine),
    stop: () => micLine(r.stop()),
    install: () => r.install().then(micLine),
    dismiss: () => {
      const n = r.recruits.length
      r.dismiss()
      return n ? `letting ${n} ${n === 1 ? 'person' : 'people'} go` : 'nobody to dismiss'
    },
    status: () => [
      `mic       ${micLine(r.mic)}`,
      ...(r.recruits.length ? r.recruits.map((x) => `recruit   ${recruitLine(x)}`) : ['recruit   nobody asked over']),
      ...(r.swarmSkills.length ? [`swarm     ${r.swarmSkills.join(', ')}`] : []),
      ...(r.heard ? [`heard     "${r.heard}"`] : []),
      ...(r.last ? [`last      ${r.last}`] : []),
      `earshot   ${AUDIBLE_RADIUS} m, this side of the street · skills: ${SKILLS.join(', ')}`,
    ],
    skills: () => SKILLS,
  })
}
