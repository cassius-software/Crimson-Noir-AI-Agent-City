// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the Ring-0 operator tier behind `operator unlock`: the SimControls
 * contract the engine fulfils, the deep-frozen ScriptApi facade a script sees (SimControls minus the
 * harness-only sensing blind, and structurally nothing else: no laws, no Bouncer, no Sanctuary, no crowd
 * nudge, no world), the sandboxed script runner behind `run <skill>: <js>`, the API text behind `api`, and the
 * factory that builds the bridge's `operator` surface for the engine. Every script goes through the capability
 * gateway the host hands in (SkillGate: 08_Swarm/taskRouter.ts over the recruiter, not imported here): it runs only
 * while someone tethered to the operator has the skills it names, over a facade whose every call is checked against
 * that tether, and it is stopped the moment the tether breaks. A prompt to the local model (`ask <skill>: …`,
 * Mind: 09_Cognition/localCompute.ts, handed in the same way) goes through the same gate: it is answered for the
 * people it is bound to, with what they remember (Diary: 08_Swarm/memory.ts), streamed while they stay, and cut off
 * with them. Speech (`say <skill>: …`, Voice: 09_Cognition/localSpeech.ts; SpeechOut: the engine's soundscape) is
 * said by the person it is bound to, from where they stand, and cut mid-word when they are left behind. Every vehicle
 * command a script issues still goes through Fleet's vetting; the facade only forwards plain numbers and strings.
 * What breaks if it is removed? `operator`, `run`, `ask`, `say`, `api`, `get`, `set` and `harness` have nothing
 * behind them, and the engine has no contract to implement.
 */
import { DISENGAGED, disengaged, screen } from '../02_Define_The_Rules/conduct.ts'
import type { CrowdStats } from '../03_Spawn_Agents/crowdCompute.ts'
import type { KernelStats, QualityState, SipocSnapshot } from '../05_Observe_Environment/telemetry.ts'
import type { OperatorBridge } from './terminal/bridge.ts'
import { harnesses, runHarness, type HarnessReport } from './harness.ts'

/** What the ENGINE provides (engine.ts implements it). Rich enough for scripts and harnesses. */
export interface SimControls {
  clock: { hours(): number; set(hours: number): void }
  quality: { state(): QualityState; set(tier: number | 'auto'): void }
  avatar: {
    /** Where the avatar stands (feetY: the feet's height, 0 on the ground, the deck's height on the pier). */
    position(): { x: number; z: number; heading: number; feetY: number }
    teleport(x: number, z: number, yaw?: number): void
    interact(): void
    /** Walks at (vx, vz) m/s (the physics realm caps it at a run) for `ms` (default 1000, at most 10 000); walk(0, 0) stops. On foot only. */
    walk(vx: number, vz: number, ms?: number): void
  }
  vehicles: {
    count(): number
    state(i: number): { x: number; z: number; heading: number; speed: number; mode: 'ai' | 'player' | 'parked'; suv: boolean }
    setMode(i: number, mode: 'ai' | 'parked'): void
    recover(i: number, x?: number, z?: number, heading?: number): void
    /** Player-style intent for vehicle i (throttle −1..1, brake m/s², steer rad) — vetted by the Bouncer like any other. */
    intent(i: number, throttle: number, brake: number, steer: number): void
    nearest(x: number, z: number): number
  }
  /** Bounded, engine-defined keys (e.g. 'car.power', 'car.drag'); throws on an unknown key or out of bounds. */
  physics: { tune(): Record<string, number>; set(key: string, value: number): void }
  /** e.g. 'light.haze', 'light.exposure', 'light.sun', 'light.fill', 'volumetrics.strength'. */
  shaders: { uniforms(): Record<string, number>; set(key: string, value: number): void }
  crowd: {
    stats(): CrowdStats
    cull(c: { lodDistance?: number; nearRadius?: number; density?: number; maxDistance?: number }): void
    /** Where every pedestrian stood in the newest reading, x then z for each (index 0 is the player's own body); a copy. Empty before the first reading. */
    positions(): Float32Array
  }
  kernel: { stats(): KernelStats; /** HARNESS-ONLY: blinds the fleet's person sensing for ≤ ttlMs so a harness can prove the Sanctuary alone. */ blindSensing(on: boolean, ttlMs?: number): void }
  snapshot(): SipocSnapshot
}

/** What SCRIPTS see: SimControls minus kernel.blindSensing (and never laws/bouncer/sanctuary). Deep-frozen facade. */
export type ScriptApi = Omit<SimControls, 'kernel'> & { kernel: { stats(): KernelStats } }

export interface ExecResult {
  value: string
  logs: string[]
  error?: string
  ms: number
  /** The script produced no value (undefined): `value` spells it, but there is nothing to print. A string "undefined" carries no flag. */
  empty?: true
}

/** The capability gateway's three states (08_Swarm/taskRouter.ts), as the operator tier reports a script's. */
export type RunState = 'Authorized' | 'Rejected' | 'Aborted'

/** A tether a script is bound to, as the gateway reports it: the person, the recruitment, the skills they bring. */
export interface GateTether {
  readonly agent: number
  readonly serial: number
  readonly skills: readonly string[]
}

/** A script's hold on its tethers (the gateway's Lease). */
export interface GateLease {
  /** Aborted the moment a bound tether breaks. */
  readonly signal: AbortSignal
  readonly bound: readonly GateTether[]
  readonly held: boolean
  /** Runs `act` in the same step as a check of the newest copy of the swarm; throws instead once the lease is gone. */
  use<R>(act: () => R): R
}

/** The gateway's final word on a script. */
export type GateVerdict<T> =
  | { readonly state: 'Authorized'; readonly outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown } }
  | { readonly state: 'Rejected' | 'Aborted'; readonly message: string }

export interface GateHandle<T> {
  readonly state: RunState
  readonly lease: GateLease | null
  readonly verdict: Promise<GateVerdict<T>>
}

/**
 * The capability gateway as the operator tier uses it: 08_Swarm/taskRouter.ts's TaskRouter over the recruiter,
 * handed in by the host (App.tsx). This tier knows only this shape; the host's compiler checks that the gateway fits.
 */
export interface SkillGate {
  submit<T>(requires: readonly string[], task: (lease: GateLease) => T | PromiseLike<T>): GateHandle<T>
}

/** A script's outcome under the gateway. */
export interface RunResult extends ExecResult {
  readonly state: RunState
  /** Rejected or Aborted: the gateway's reason (what nobody tethered has, or which tether broke). */
  readonly reason?: string
}

/** A script handed to the gateway: its state now, who it is bound to, and its outcome later. */
export interface GatedRun {
  /** Decided at submission: Authorized (running under its lease) or Rejected (it never ran). */
  readonly state: RunState
  /** The tethers it is bound to (none unless Authorized). */
  readonly bound: readonly GateTether[]
  /** Settles once and never rejects: the script's result, or why it did not run or was stopped. */
  readonly result: Promise<RunResult>
}

/** A piece of a model's answer as it streams in: a token of its thinking, or text of the answer. */
export interface Piece {
  readonly kind: 'thinking' | 'text'
  readonly text: string
}

/** A model's finished answer: its text, how many pieces it thought, how many tokens it wrote, why it stopped. */
export interface Answer {
  readonly text: string
  readonly thinking: number
  readonly tokens: number
  /** 'stop' (it finished) or 'length' (it reached the token limit), as the server says. */
  readonly reason: string
  /** The SHA-256 of the exact system prompt sent (02_Define_The_Rules/integrity.ts), so an audit can prove what the model was given. */
  readonly promptHash?: string
}

/**
 * The local model as the operator tier uses it: 09_Cognition/localCompute.ts, handed in by the host (App.tsx) like
 * the gate. This tier knows only this shape. `answer` speaks for the tethers it is given, streams through `onPiece`
 * and stops the moment `signal` aborts.
 */
export interface Mind {
  /**
   * `think`: the model reasons before it answers (absent: the server's own default). `api`: the wire format the server
   * is spoken to in (absent: the mind has one only). `provider`: which model provider answers (absent: the mind has one
   * only); `key`: the network provider's key, masked (null: none set); `effort`: how hard it works (absent: its default).
   */
  settings(): { server: string; model: string | null; think?: boolean; api?: string; provider?: string; key?: string | null; effort?: string; cache?: string }
  setServer(url: string): string
  setModel(name: string): string
  /** Whether the model reasons before it answers; returns the new value. Absent: the mind has no such switch. */
  setThink?(on: boolean): boolean
  /** The wire format (09_Cognition/localCompute.ts WireFormat); returns the new one. Absent: the mind has one only. */
  setApi?(format: string): string
  /** The provider that answers (09_Cognition/router.ts Provider); returns the new one. Absent: the mind has one only. */
  setProvider?(name: string): string
  /** The network provider's key (empty clears it); returns it masked. Absent: no provider takes a key. */
  setKey?(key: string): string | null
  /** The network provider's effort (empty clears it); returns it. Absent: no provider takes one. */
  setEffort?(level: string): string | null
  installed(signal?: AbortSignal): Promise<string[]>
  answer(req: { tethers: readonly GateTether[]; prompt: string; signal: AbortSignal; memories?: readonly Memories[] }, onPiece: (p: Piece) => void): Promise<Answer>
}

/** What one of the people an answer speaks for remembers of the operator (Diary.recall), oldest first. */
export interface Memories {
  readonly agent: number
  readonly lines: readonly string[]
}

/**
 * The local speech server as the operator tier uses it: 09_Cognition/localSpeech.ts, handed in by the host like the
 * mind. `synthesize` resolves with the audio's bytes and stops the moment `signal` aborts. `auto`: answers to `ask`
 * are spoken as well.
 */
export interface Voice {
  settings(): { server: string; model: string | null; voice: string | null; auto: boolean }
  setServer(url: string): string
  setModel(name: string): string
  setVoice(name: string): string
  setAuto(on: boolean): boolean
  voices(signal?: AbortSignal): Promise<string[] | null>
  synthesize(text: string, signal: AbortSignal): Promise<ArrayBuffer>
}

/** Decoded speech, ready to play (opaque to this tier): how long it lasts. */
export interface SpeechClip {
  readonly seconds: number
}

/** Speech playing: when it is over, and the way to stop it. */
export interface Utterance {
  /** Resolves when the clip has played to its end or was stopped; never rejects. */
  readonly ended: Promise<void>
  /** Fades the speech out now; idempotent. */
  stop(): void
}

/**
 * Where speech is heard: the city's soundscape (engine.ts speechOut; the engine holds no network code). It places a
 * voice at a pedestrian's head and keeps it there as they walk.
 */
export interface SpeechOut {
  /** Decodes the audio a speech server sent; rejects when it is not audio or the city's sound is off. */
  decode(bytes: ArrayBuffer): Promise<SpeechClip>
  /**
   * Starts `clip` at pedestrian `agent`'s head at once (synchronous); throws when it cannot sound. It cuts any other.
   * `text` is what the clip says (already screened), for the soundscape's captions; it reaches no speech server.
   */
  play(clip: SpeechClip, agent: number, text?: string): Utterance
}

/**
 * The swarm's memory as the operator tier uses it (08_Swarm/memory.ts SwarmMemory.diary), handed in by the host: what
 * a person remembers, as lines a prompt can carry, and a note of what a task did with the people it was bound to.
 */
export interface Diary {
  recall(agent: number): readonly string[]
  /**
   * `at`: when the task began, ms since the epoch (it is noted when it ends, but belongs where it began). `promptHash`:
   * an ask's, the SHA-256 of the exact system prompt the model was given (AskResult.promptHash), for the audit.
   * `outcome`: how an Authorized task ended (taskOutcome), what the swarm's memory learns from.
   */
  note(bound: readonly GateTether[], kind: 'run' | 'ask' | 'say', skills: readonly string[], text: string, state: RunState, at: number, promptHash?: string, outcome?: Outcome): void
}

/**
 * How an Authorized task ended, in the few words the swarm's memory learns from (08_Swarm/memory.ts rewardOf):
 * an ask answered, cut at the token limit, stopped by the operator, or failed by its server; a script that ran
 * through or threw; a line said to the end. A Rejected or Aborted task has none: the agent was not at fault.
 */
export type Outcome = 'answered' | 'cut' | 'stopped' | 'failed' | 'ok' | 'error' | 'said'

/** The outcome of a finished ask, run or say (undefined unless Authorized). Pure. */
export function taskOutcome(r: AskResult | RunResult | SayResult): Outcome | undefined {
  if (r.state !== 'Authorized') return undefined
  if ('stopped' in r && r.stopped) return 'stopped'
  if ('done' in r || 'thinking' in r) {
    const a = r as AskResult
    if (a.error !== undefined) return 'failed'
    return a.done === 'length' ? 'cut' : 'answered'
  }
  if ('value' in r) return r.error !== undefined ? 'error' : 'ok'
  return r.error !== undefined ? 'failed' : 'said'
}

/** What the host hands the operator tier besides the gate and the mind; each is optional (the tier says what is missing). */
export interface Senses {
  readonly voice?: Voice
  readonly speech?: SpeechOut
  readonly diary?: Diary
}

/** What a say ended as. */
export interface SayResult {
  readonly state: RunState
  /** Authorized: who spoke (the first tether the text is bound to). */
  readonly speaker?: GateTether
  /** Authorized and synthesized: the clip's length, seconds. */
  readonly seconds?: number
  /** Rejected or Aborted: the gateway's reason. */
  readonly reason?: string
  /** Authorized, but not spoken to the end: why (the speech server, the soundscape, or the operator's stop). */
  readonly error?: string
  readonly stopped?: true
  /** Authorized, but not said at all: the 14A screen (02_Define_The_Rules/conduct.ts) found the text inadmissible. */
  readonly silent?: true
  readonly ms: number
}

/** A text handed to the gateway to be said aloud: its state now, who it is bound to, the outcome later. */
export interface GatedSay {
  readonly state: RunState
  readonly bound: readonly GateTether[]
  /** Settles once and never rejects. */
  readonly result: Promise<SayResult>
}

/** The local speech server as configured, and what it says it has. */
export interface VoiceStatus {
  readonly server: string
  readonly model: string | null
  readonly voice: string | null
  readonly auto: boolean
  /** The voices the server lists; null when it keeps no list, or did not answer (`error` then says why). */
  readonly voices: readonly string[] | null
  readonly error?: string
  /** Whether something is being said now. */
  readonly speaking: boolean
}

/** Longest text said at once, characters (09_Cognition/localSpeech.ts SPEECH_CHARS; operator.test.ts pins them). */
export const SAY_CHARS = 1200

/** What an ask ended as. */
export interface AskResult {
  readonly state: RunState
  /** The answer's text: all of it, or what arrived before it was stopped, aborted or failed. */
  readonly text: string
  /** Being said aloud as well (Voice auto): how that ends. */
  readonly speech?: Promise<SayResult>
  /** Pieces of thinking that arrived. */
  readonly thinking: number
  /** Rejected or Aborted: the gateway's reason. */
  readonly reason?: string
  /** Authorized, but no whole answer: why (the server's failure, or the operator's stop), in one line. */
  readonly error?: string
  readonly stopped?: true
  /** Authorized and answered: why the model stopped ('stop', or 'length' at the token limit), and its tokens. */
  readonly done?: string
  readonly tokens?: number
  /** Authorized and answered: the SHA-256 of the exact system prompt the model was given (Answer.promptHash), for the audit. */
  readonly promptHash?: string
  /** Authorized, but the agent did not engage (the 14A screen, or the model's own refusal): no reply. */
  readonly disengaged?: true
  readonly ms: number
}

/** A prompt handed to the gateway: its state now, who it is bound to, the answer as it streams, the outcome later. */
export interface GatedAsk {
  readonly state: RunState
  readonly bound: readonly GateTether[]
  /** Calls `fn` with each piece of the answer as it arrives (only while the lease holds); returns the unsubscribe. */
  follow(fn: (p: Piece) => void): () => void
  /** Settles once and never rejects. */
  readonly result: Promise<AskResult>
}

/** The local model server as configured, and what it says it has (null, with the reason, when it did not answer). */
export interface MindStatus {
  readonly server: string
  readonly model: string | null
  /** The model reasons before it answers (absent: the mind has no such switch). */
  readonly think?: boolean
  /** The wire format the server is spoken to in (absent: the mind has one only). */
  readonly api?: string
  /** The provider that answers (absent: the mind has one only); the network provider's key, masked; its effort. */
  readonly provider?: string
  readonly key?: string | null
  readonly effort?: string
  /** The prompt-prefix page table's counts, one line (absent: the mind keeps none, or has paged nothing yet). */
  readonly cache?: string
  readonly installed: readonly string[] | null
  readonly error?: string
}

/** A script that has not finished by then is abandoned (its timers are cleared) and reported as timed out. */
export const DEFAULT_TIMEOUT_MS = 30_000
/** Longest `value` a script result carries; anything longer is cut with an ellipsis. */
const MAX_VALUE_CHARS = 16_384
type CullKey = 'lodDistance' | 'nearRadius' | 'density' | 'maxDistance'
const CULL_KEYS: ReadonlySet<string> = new Set<CullKey>(['lodDistance', 'nearRadius', 'density', 'maxDistance'])
const isCullKey = (k: string): k is CullKey => CULL_KEYS.has(k)

/**
 * A finite number from a script's argument: a number, or a numeric string. Anything else (NaN, Infinity,
 * undefined, null, booleans, objects) is a TypeError here, because the engine does not guard every path:
 * NaN hours break the sun, a NaN pose puts a Rapier body or the avatar's head at NaN.
 */
function num(v: unknown, what: string): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n)) throw new TypeError(`${what} must be a finite number`)
  return n
}
const opt = (v: unknown, what: string): number | undefined => (v === undefined ? undefined : num(v, what))
const copy = <T extends object>(o: T): T => ({ ...o })
const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now())

/** Freezes every object and function reachable through own properties (the facade holds no cycles). */
function deepFreeze<T>(value: T): T {
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    Object.freeze(value)
    for (const key of Reflect.ownKeys(value as object)) deepFreeze((value as Record<PropertyKey, unknown>)[key])
  }
  return value
}

/**
 * The facade scripts get as `sim`. Every member is a fresh arrow function forwarding validated plain
 * values (finite numbers, the two mode names) to the engine's SimControls, so no engine object, method
 * or `this` is reachable from it; objects the engine hands back are copied (the snapshot, which nests,
 * by structured clone, so a script never holds an object the HUD still reads). Frozen at every depth:
 * a script cannot add, replace or remove a member.
 */
export function scriptApi(sim: SimControls): ScriptApi {
  const api: ScriptApi = {
    clock: {
      hours: () => sim.clock.hours(),
      set: (hours) => sim.clock.set(num(hours, 'hours')),
    },
    quality: {
      state: () => copy(sim.quality.state()),
      set: (tier) => sim.quality.set(tier === 'auto' ? 'auto' : num(tier, "tier (or 'auto')")),
    },
    avatar: {
      position: () => copy(sim.avatar.position()),
      teleport: (x, z, yaw) => sim.avatar.teleport(num(x, 'x'), num(z, 'z'), opt(yaw, 'yaw')),
      interact: () => sim.avatar.interact(),
      walk: (vx, vz, ms) => sim.avatar.walk(num(vx, 'vx'), num(vz, 'vz'), opt(ms, 'ms')),
    },
    vehicles: {
      count: () => sim.vehicles.count(),
      state: (i) => copy(sim.vehicles.state(num(i, 'vehicle index'))),
      setMode: (i, mode) => {
        if (mode !== 'ai' && mode !== 'parked') throw new TypeError("mode must be 'ai' or 'parked'")
        sim.vehicles.setMode(num(i, 'vehicle index'), mode)
      },
      recover: (i, x, z, heading) => sim.vehicles.recover(num(i, 'vehicle index'), opt(x, 'x'), opt(z, 'z'), opt(heading, 'heading')),
      intent: (i, throttle, brake, steer) =>
        sim.vehicles.intent(num(i, 'vehicle index'), num(throttle, 'throttle'), num(brake, 'brake'), num(steer, 'steer')),
      nearest: (x, z) => sim.vehicles.nearest(num(x, 'x'), num(z, 'z')),
    },
    physics: {
      tune: () => copy(sim.physics.tune()),
      set: (key, value) => sim.physics.set(String(key), num(value, `physics.${String(key)}`)),
    },
    shaders: {
      uniforms: () => copy(sim.shaders.uniforms()),
      set: (key, value) => sim.shaders.set(String(key), num(value, `shaders.${String(key)}`)),
    },
    crowd: {
      stats: () => copy(sim.crowd.stats()),
      positions: () => Float32Array.from(sim.crowd.positions()),
      cull: (c) => {
        if (typeof c !== 'object' || c === null) throw new TypeError('cull takes an object of lodDistance, nearRadius, density, maxDistance')
        // The known keys, in the order the script wrote them; anything else is dropped.
        const clean: { [K in CullKey]?: number } = {}
        for (const k of Object.keys(c)) if (isCullKey(k) && c[k] !== undefined) clean[k] = num(c[k], `cull.${k}`)
        sim.crowd.cull(clean)
      },
    },
    kernel: {
      stats: () => copy(sim.kernel.stats()),
    },
    // Plain data by contract (SipocSnapshot), so the clone never throws; it isolates nested objects the engine keeps.
    snapshot: () => structuredClone(sim.snapshot()),
  }
  return deepFreeze(api)
}

// ---------------------------------------------------------------------------------------------------
// Script runner

/** A compiled script: `sim`, `console`, `sleep` and `signal` are its whole scope beyond the language's globals. */
type Compiled = (sim: ScriptApi, console: object, sleep: (ms: number) => Promise<void>, signal: AbortSignal) => Promise<unknown>

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => Compiled

class TimeoutError extends Error {
  override readonly name = 'TimeoutError'
}

/** Numbers JSON cannot carry, functions and bigints become readable strings instead of null. */
function replacer(_key: string, v: unknown): unknown {
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v)
  if (typeof v === 'bigint') return `${v}n`
  if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`
  return v
}

/** One line for a script value: strings as they are, objects as JSON (parseable by `get`), the rest as JS would print it. */
export function formatValue(v: unknown): string {
  if (v === undefined) return 'undefined'
  if (typeof v === 'string') return clip(v)
  if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`
  if (typeof v === 'bigint') return `${v}n`
  if (typeof v === 'symbol') return v.toString()
  if (v instanceof Error) return describe(v)
  if (typeof v !== 'object' || v === null) return String(v)
  try {
    const json = JSON.stringify(v, replacer)
    return clip(json === undefined ? String(v) : json)
  } catch {
    return clip(String(v))
  }
}

const clip = (s: string): string => (s.length > MAX_VALUE_CHARS ? `${s.slice(0, MAX_VALUE_CHARS)}…` : s)

/** `Name: message` for errors, String() for anything else thrown. */
export function describe(e: unknown): string {
  if (e instanceof Error) return e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message || e.name || 'Error'
  return String(e)
}

/** The script's `console`: every method captures a line; nothing reaches the browser console. */
function capture(logs: string[]): object {
  const line = (prefix: string) => (...args: unknown[]) => { logs.push(prefix + args.map(formatValue).join(' ')) }
  const quiet = () => {}
  return {
    log: line(''), info: line(''), debug: line(''), table: line(''), dir: line(''), trace: line(''),
    warn: line('warn: '), error: line('error: '),
    assert: (ok: unknown, ...args: unknown[]) => { if (!ok) logs.push(`assert: ${args.length ? args.map(formatValue).join(' ') : 'failed'}`) },
    count: quiet, group: quiet, groupEnd: quiet, time: quiet, timeEnd: quiet, clear: quiet,
  }
}

/**
 * Compiles a script as one expression (its value is the result), or, when that does not parse, as a
 * statement body where `return` gives the value. Strict mode either way.
 */
function compile(script: string): Compiled {
  try {
    return new AsyncFunction('sim', 'console', 'sleep', 'signal', `"use strict"; return (\n${script}\n);`)
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e
    return new AsyncFunction('sim', 'console', 'sleep', 'signal', `"use strict";\n${script}`)
  }
}

/**
 * Runs one script with `sim` (the ScriptApi facade), a capturing `console`, `sleep(ms)` and `signal` in
 * scope, async-aware (`await` is allowed at the top level), against a wall-clock timeout after which the
 * script is abandoned (its sleeps are cancelled). The moment `signal` aborts, the script is stopped: its
 * sleeps reject with the reason, and the result reports the abort without waiting for the script (with the
 * lines it logged until then). Never throws. This is the operator's own local page, like the browser's
 * devtools: the isolation here is structural (what `sim` can reach), not a security boundary.
 */
export async function exec(script: string, sim: ScriptApi, timeoutMs: number = DEFAULT_TIMEOUT_MS, signal: AbortSignal = new AbortController().signal): Promise<ExecResult> {
  // Stopped before it began: nothing is compiled, nothing runs.
  if (signal.aborted) return { value: '', logs: [], error: describe(signal.reason), ms: 0 }
  const logs: string[] = []
  const t0 = now()
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const sleep = (ms: number): Promise<void> => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const n = Number(ms)
    const stop = (): void => { clearTimeout(id); timers.delete(id); reject(signal.reason) }
    const id = setTimeout(() => { timers.delete(id); signal.removeEventListener('abort', stop); resolve() }, Number.isFinite(n) && n > 0 ? n : 0)
    timers.add(id)
    signal.addEventListener('abort', stop, { once: true })
  })
  let deadline: ReturnType<typeof setTimeout> | undefined
  let stopped: (() => void) | undefined
  // What the script logged by the time its result is decided: lines it logs later (if it keeps going) are not part of it.
  const lines = (): string[] => [...logs]
  try {
    const fn = compile(String(script))
    const run = Promise.resolve(fn(sim, capture(logs), sleep, signal))
    // The race may abandon `run`; its own rejection must not surface as unhandled.
    run.catch(() => {})
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new TimeoutError(`script timed out after ${limit} ms`)), limit)
    })
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) return reject(signal.reason)
      stopped = () => reject(signal.reason)
      signal.addEventListener('abort', stopped, { once: true })
    })
    aborted.catch(() => {})
    const value = await Promise.race([run, timeout, aborted])
    if (value === undefined) return { value: 'undefined', logs: lines(), ms: now() - t0, empty: true }
    return { value: formatValue(value), logs: lines(), ms: now() - t0 }
  } catch (e) {
    return { value: '', logs: lines(), error: describe(e), ms: now() - t0 }
  } finally {
    if (deadline !== undefined) clearTimeout(deadline)
    if (stopped) signal.removeEventListener('abort', stopped)
    for (const id of timers) clearTimeout(id)
  }
}

/**
 * The facade a script under a lease gets as `sim`: the same members over the same ScriptApi, every call made through
 * the lease's `use`, so each one is checked against the newest copy of the swarm and made in that same step. Once the
 * tether breaks, or the run is over, every call throws instead of reaching the city. Plain arrows and plain objects,
 * frozen at every depth, like the facade it wraps.
 */
export function leasedApi(api: ScriptApi, lease: Pick<GateLease, 'use'>): ScriptApi {
  const wrap = (v: unknown): unknown => {
    if (typeof v === 'function') {
      const f = v as (...args: unknown[]) => unknown
      return (...args: unknown[]) => lease.use(() => f(...args))
    }
    if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wrap(x)]))
    return v
  }
  return deepFreeze(wrap(api) as ScriptApi)
}

/**
 * A script through the capability gateway, with the skills it needs: decided at once. Rejected, it is never compiled
 * or run. Authorized, it starts in that same step, with the leased facade, the lease's `signal` and a `sleep` the
 * signal cancels. When a bound tether breaks, the result is Aborted at once, with the gateway's reason and whatever
 * the script logged before, and from then on the script cannot reach the city. Throws only if the gateway refuses the
 * request itself (no skill named).
 */
export function gatedExec(gate: SkillGate, skills: readonly string[], script: string, api: ScriptApi, timeoutMs: number = DEFAULT_TIMEOUT_MS): GatedRun {
  const run: { started?: Promise<ExecResult> } = {}
  const handle = gate.submit(skills, (lease) => (run.started = exec(script, leasedApi(api, lease), timeoutMs, lease.signal)))
  const result = handle.verdict.then(async (v): Promise<RunResult> => {
    if (v.state === 'Authorized') {
      const r: ExecResult = v.outcome.ok ? v.outcome.value : { value: '', logs: [], error: describe(v.outcome.error), ms: 0 }
      return { ...r, state: 'Authorized' }
    }
    // Aborted: the lines the script logged before its tether broke (it stops at once: its sleeps and sim calls refuse).
    const partial = v.state === 'Aborted' && run.started ? await run.started : null
    return { value: '', logs: partial ? partial.logs : [], ms: partial ? partial.ms : 0, state: v.state, reason: v.message }
  })
  return Object.freeze({ state: handle.state, bound: handle.lease?.bound ?? [], result })
}

/**
 * A prompt through the capability gateway, answered by the local model for the people it is bound to: decided at once.
 * Rejected, the model is never asked. Authorized, the request starts in that same step, under a signal that aborts
 * when the tether breaks or when `stop` is called; each piece of the answer reaches the followers only through the
 * lease (checked and shown in one step), so nothing arrives once the tether is gone. Aborted keeps the text that came
 * before; a stop or a server failure is Authorized with the reason (the tether held). With a diary, the answer carries
 * what each bound person remembers.
 */
export function gatedAsk(gate: SkillGate, mind: Mind, skills: readonly string[], prompt: string, diary?: Diary): GatedAsk & { stop(): void } {
  const followers = new Set<(p: Piece) => void>()
  const stopper = new AbortController()
  const t0 = now()
  let text = ''
  let thinking = 0
  const remembered = (bound: readonly GateTether[]): Memories[] =>
    diary ? bound.map((t) => ({ agent: t.agent, lines: [...diary.recall(t.agent)] })).filter((m) => m.lines.length > 0) : []
  // 14A: an inadmissible prompt (violence, toxicity, illegality) is not engaged with: it reaches no model, whichever
  // provider answers, nothing streams, and the answer is nothing at once.
  const handle = gate.submit(skills, (lease) => screen(prompt).admissible ? mind.answer(
    { tethers: lease.bound, prompt, signal: AbortSignal.any([lease.signal, stopper.signal]), memories: remembered(lease.bound) },
    (p) => lease.use(() => {
      if (p.kind === 'text') text += p.text
      else thinking++
      for (const fn of [...followers]) {
        try {
          fn(p)
        } catch {
          // a follower's own failure does not stop the answer
        }
      }
    }),
  ) : Promise.resolve(DISENGAGED))
  const result = handle.verdict.then((v): AskResult => {
    const ms = now() - t0
    if (v.state !== 'Authorized') return { state: v.state, text, thinking, reason: v.message, ms }
    if (v.outcome.ok) {
      const { reason, tokens, promptHash } = v.outcome.value
      return {
        state: 'Authorized', text, thinking, done: reason, tokens, ms,
        ...(promptHash !== undefined && { promptHash }), ...(disengaged(reason) && { disengaged: true as const }),
      }
    }
    if (stopper.signal.aborted) return { state: 'Authorized', text, thinking, error: 'stopped by the operator', stopped: true, ms }
    const e = v.outcome.error
    return { state: 'Authorized', text, thinking, error: e instanceof Error ? e.message : String(e), ms }
  })
  return Object.freeze({
    state: handle.state,
    bound: handle.lease?.bound ?? [],
    follow: (fn: (p: Piece) => void) => {
      followers.add(fn)
      return () => { followers.delete(fn) }
    },
    result,
    stop: () => stopper.abort(new DOMException('stopped by the operator', 'AbortError')),
  })
}

/** A promise that rejects with the signal's reason once it aborts (never settles otherwise). */
function abortion(signal: AbortSignal): Promise<never> {
  const p = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  p.catch(() => {})
  return p
}

/**
 * A text through the capability gateway, said aloud by the first person it is bound to, from where they stand:
 * decided at once. Rejected, nothing is sent to the speech server. Authorized, the request starts in that same step,
 * under a signal that aborts when the tether breaks or when `stop` is called; the audio is decoded, then started
 * through the lease (checked and started in one step), at the speaker's head, and followed as they walk. The moment
 * the tether breaks the speech is cut, wherever it is (synthesizing, decoding or mid-word). A stop, a server failure
 * or a soundscape that cannot sound is Authorized with the reason (the tether held).
 */
export function gatedSay(gate: SkillGate, voice: Voice, out: SpeechOut, skills: readonly string[], text: string): GatedSay & { stop(): void } {
  const stopper = new AbortController()
  const t0 = now()
  let seconds: number | undefined
  let silent = false
  const handle = gate.submit(skills, async (lease) => {
    // 14A: an inadmissible line is not said: it reaches no speech server, and the speaker stays silent.
    if (!screen(text).admissible) {
      silent = true
      return lease.bound[0]
    }
    const signal = AbortSignal.any([lease.signal, stopper.signal])
    const bytes = await voice.synthesize(text, signal)
    signal.throwIfAborted()
    const clip = await out.decode(bytes)
    signal.throwIfAborted()
    seconds = clip.seconds
    const speaker = lease.bound[0]
    // P5: the tether is checked against the newest copy of the swarm and the speech started in that one step.
    const speaking = lease.use(() => out.play(clip, speaker.agent, text))
    const cut = (): void => speaking.stop()
    signal.addEventListener('abort', cut, { once: true })
    try {
      await Promise.race([speaking.ended, abortion(signal)])
    } finally {
      signal.removeEventListener('abort', cut)
    }
    // Cutting the speech ends it too, in the same step as the abort: an utterance that ended because it was cut
    // was not said to the end.
    signal.throwIfAborted()
    return speaker
  })
  const result = handle.verdict.then((v): SayResult => {
    const ms = now() - t0
    if (v.state !== 'Authorized') return { state: v.state, reason: v.message, ms, ...(seconds !== undefined && { seconds }) }
    if (v.outcome.ok) return { state: 'Authorized', speaker: v.outcome.value, ms, ...(seconds !== undefined && { seconds }), ...(silent && { silent: true as const }) }
    if (stopper.signal.aborted) return { state: 'Authorized', error: 'stopped by the operator', stopped: true, ms }
    return { state: 'Authorized', error: describeError(v.outcome.error), ms }
  })
  return Object.freeze({
    state: handle.state,
    bound: handle.lease?.bound ?? [],
    result,
    stop: () => stopper.abort(new DOMException('stopped by the operator', 'AbortError')),
  })
}

/** An error's own message (no "Name:" prefix): what a speech server or the soundscape said. */
const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * An answer as speech: at most SAY_CHARS characters, ending on the last whole sentence that fits (or the last whole
 * word), runs of white space folded.
 */
export function speakable(text: string): string {
  const t = String(text).replace(/\s+/g, ' ').trim()
  if (t.length <= SAY_CHARS) return t
  const head = t.slice(0, SAY_CHARS)
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '))
  if (stop > SAY_CHARS / 3) return head.slice(0, stop + 1)
  const space = head.lastIndexOf(' ')
  return space > 0 ? `${head.slice(0, space)}…` : head
}

/** The skills a task named, as the people bound to it name them (the gateway matches names in any case). */
function asNamed(skills: readonly string[], bound: readonly GateTether[]): string[] {
  const theirs = bound.flatMap((t) => t.skills)
  return skills.map((s) => theirs.find((k) => k.toLowerCase() === s.trim().toLowerCase()) ?? s.trim())
}

// ---------------------------------------------------------------------------------------------------
// Documentation

export interface ApiEntry { path: string; signature: string; summary: string }

/** Members of `sim` (the ScriptApi), one per leaf function, in the order `api` prints them. */
const SIM_DOCS: readonly ApiEntry[] = [
  { path: 'sim.clock.hours', signature: 'sim.clock.hours(): number', summary: 'Local solar time in hours, 0 to 24, minutes as a fraction.' },
  { path: 'sim.clock.set', signature: 'sim.clock.set(hours: number): void', summary: 'Set the city clock (wraps into 0 to 24).' },
  { path: 'sim.quality.state', signature: 'sim.quality.state(): QualityState', summary: 'Tier, label, auto flag, render scale and frame budget of the quality governor.' },
  { path: 'sim.quality.set', signature: "sim.quality.set(tier: number | 'auto'): void", summary: 'Pin a tier 0 to 4, or hand control back to the governor.' },
  { path: 'sim.avatar.position', signature: 'sim.avatar.position(): { x, z, heading, feetY }', summary: 'Where the avatar stands, the way it faces (forward = sin heading, cos heading) and how high its feet are (0 on the ground).' },
  { path: 'sim.avatar.teleport', signature: 'sim.avatar.teleport(x: number, z: number, yaw?: number): void', summary: 'Move the avatar (it leaves a car first); yaw sets the head.' },
  { path: 'sim.avatar.interact', signature: 'sim.avatar.interact(): void', summary: 'Enter the nearest car, or leave the current one.' },
  { path: 'sim.avatar.walk', signature: 'sim.avatar.walk(vx: number, vz: number, ms?: number): void', summary: 'Walk at (vx, vz) m/s, capped at a run, for ms (default 1 s, at most 10 s); walk(0, 0) stops. On foot only.' },
  { path: 'sim.vehicles.count', signature: 'sim.vehicles.count(): number', summary: 'Number of vehicles; indices run 0 to count - 1.' },
  { path: 'sim.vehicles.state', signature: 'sim.vehicles.state(i: number): { x, z, heading, speed, mode, suv }', summary: "Pose, chassis-forward speed (m/s) and mode ('ai' | 'player' | 'parked') of vehicle i." },
  { path: 'sim.vehicles.setMode', signature: "sim.vehicles.setMode(i: number, mode: 'ai' | 'parked'): void", summary: 'Hand a car to its AI driver or park it (not the car being driven).' },
  { path: 'sim.vehicles.recover', signature: 'sim.vehicles.recover(i: number, x?: number, z?: number, heading?: number): void', summary: 'Set a car back on its wheels where it is, or at a pose.' },
  { path: 'sim.vehicles.intent', signature: 'sim.vehicles.intent(i: number, throttle: -1..1, brake: m/s2, steer: rad): void', summary: 'Drive car i for one frame as a player would (call it every frame; it coasts otherwise). Vetted by the kernel: a person in its envelope stops it.' },
  { path: 'sim.vehicles.nearest', signature: 'sim.vehicles.nearest(x: number, z: number): number', summary: 'Index of the vehicle nearest to a point (-1 if none).' },
  { path: 'sim.physics.tune', signature: 'sim.physics.tune(): Record<string, number>', summary: 'The bounded tuning keys (car.power, car.drag, car.grip, car.brake) and their scale factors.' },
  { path: 'sim.physics.set', signature: 'sim.physics.set(key: string, value: number): void', summary: 'Set a tuning key; clamped to the engine range (grip and brakes only ever get stronger). Throws on an unknown key.' },
  { path: 'sim.shaders.uniforms', signature: 'sim.shaders.uniforms(): Record<string, number>', summary: 'The lighting and post uniforms (light.haze, light.exposure, light.sun, light.fill, volumetrics.strength).' },
  { path: 'sim.shaders.set', signature: 'sim.shaders.set(key: string, value: number): void', summary: 'Set a uniform scale factor; clamped to the engine range. Throws on an unknown key.' },
  { path: 'sim.crowd.stats', signature: 'sim.crowd.stats(): CrowdStats', summary: 'Drawn near/far, waiting, crossing, retreating pedestrians and safety nudges this frame.' },
  { path: 'sim.crowd.cull', signature: 'sim.crowd.cull({ lodDistance?, nearRadius?, density?, maxDistance? }): void', summary: 'Override the crowd culling until the quality tier next changes.' },
  { path: 'sim.crowd.positions', signature: 'sim.crowd.positions(): Float32Array', summary: 'Where every pedestrian stood in the newest reading: x, z per person (index 0 is your own body), a copy.' },
  { path: 'sim.kernel.stats', signature: 'sim.kernel.stats(): KernelStats', summary: 'Interventions per law, Solid->Sensor flips, shield state and the last reason. Read-only: the laws cannot be reached.' },
  { path: 'sim.snapshot', signature: 'sim.snapshot(): SipocSnapshot', summary: 'The HUD snapshot: supplier, input, process, output, kernel, quality, customer, experience, map.' },
]

/** Also in scope while a script runs. */
const SCOPE_DOCS: readonly ApiEntry[] = [
  { path: 'console.log', signature: 'console.log(...values): void', summary: 'Captured (log, info, warn, error, table, dir) and printed after the script.' },
  { path: 'sleep', signature: 'sleep(ms: number): Promise<void>', summary: 'Wait inside a script (await it). The whole script must finish within the timeout; a broken tether ends the wait.' },
  { path: 'signal', signature: 'signal: AbortSignal', summary: 'Aborted the moment a tether the script is bound to breaks; from then on every sim call throws.' },
]

/** For the `api` command: every `sim.*` member, then the helpers in scope. Fresh copies each call. */
export function apiDoc(): ApiEntry[] {
  return [...SIM_DOCS, ...SCOPE_DOCS].map(copy)
}

// ---------------------------------------------------------------------------------------------------
// The bridge surface

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Builds TerminalBridge.operator for the engine: one facade over `sim`, an unlock latch that gates
 * scripts, prompts, speech, tuning keys and harnesses (the terminal refuses them first; this refuses again), every
 * script, every prompt to the local model and everything said aloud through `gate` (nothing runs any other way), one
 * answer, one utterance and one harness at a time. `get` and `set` read and write the tuning keys through the facade
 * directly: fixed, bounded knobs, not code. With a diary, what each task did is noted for the people it was bound to.
 */
export function operatorBridge(sim: SimControls, gate: SkillGate, mind: Mind, sleep: (ms: number) => Promise<void> = wait, senses: Senses = {}): OperatorBridge {
  const api = scriptApi(sim)
  const { voice, speech, diary } = senses
  let unlocked = false
  let running: string | null = null
  let asking: (GatedAsk & { stop(): void }) | null = null
  let saying: (GatedSay & { stop(): void }) | null = null
  const locked = (what: string): Error => new Error(`${what}: locked; type 'operator unlock' first`)
  const text = (e: unknown): string => (e instanceof Error ? e.message : String(e))
  const speaker = (): { voice: Voice; speech: SpeechOut } => {
    if (!voice || !speech) throw new Error('speech is not available on this page')
    return { voice, speech }
  }
  /** One utterance through the gate; noted for whoever said it. */
  const say = (skills: readonly string[], words: string): GatedSay => {
    const { voice: v, speech: out } = speaker()
    const began = Date.now()
    const s = gatedSay(gate, v, out, skills, words)
    if (s.state === 'Authorized') {
      saying = s
      void s.result.then(() => { if (saying === s) saying = null })
    }
    // A line the 14A screen kept unsaid is not remembered either: it would come back in the next prompt.
    void s.result.then((r) => { if (!r.silent) diary?.note(s.bound.slice(0, 1), 'say', asNamed(skills, s.bound), words, r.state, began, undefined, taskOutcome(r)) })
    return s
  }
  return Object.freeze({
    unlock: () => { unlocked = true },
    lock: () => { unlocked = false },
    unlocked: () => unlocked,
    exec: (skills: readonly string[], script: string): GatedRun => {
      if (!unlocked) throw locked('run')
      const began = Date.now()
      const r = gatedExec(gate, skills, String(script), api)
      void r.result.then((res) => diary?.note(r.bound, 'run', asNamed(skills, r.bound), String(script).split('\n')[0], res.state, began, undefined, taskOutcome(res)))
      return r
    },
    tuning: () => {
      if (!unlocked) throw locked('get')
      return { physics: api.physics.tune(), shaders: api.shaders.uniforms() }
    },
    tune: (table: 'physics' | 'shaders', key: string, value: number): number => {
      if (!unlocked) throw locked('set')
      if (table === 'physics') {
        api.physics.set(key, value)
        return api.physics.tune()[String(key)]
      }
      if (table === 'shaders') {
        api.shaders.set(key, value)
        return api.shaders.uniforms()[String(key)]
      }
      throw new TypeError(`no tuning table '${String(table)}': physics or shaders`)
    },
    ask: (skills: readonly string[], prompt: string): GatedAsk => {
      if (!unlocked) throw locked('ask')
      if (asking) throw new Error("an answer is still coming: wait for it, or type 'ask stop'")
      if (mind.settings().model === null) throw new Error('choose a model first: ask model <name> (type ask to list them)')
      const words = String(prompt)
      const began = Date.now()
      const a = gatedAsk(gate, mind, skills, words, diary)
      if (a.state === 'Authorized') {
        asking = a
        void a.result.then(() => { if (asking === a) asking = null })
      }
      const result = a.result.then((r): AskResult => {
        // A prompt the agent did not engage with is not acknowledged: nothing of it is remembered either.
        if (!disengaged(r.done)) diary?.note(a.bound, 'ask', asNamed(skills, a.bound), `${words.split('\n')[0]} → ${r.text}`, r.state, began, r.promptHash, taskOutcome(r))
        // Said aloud as well (say auto on): a whole answer, through the gate again, while nothing else is being said.
        const v = voice?.settings()
        if (r.state !== 'Authorized' || r.error !== undefined || !r.text.trim() || !v?.auto || v.voice === null || !speech || saying) return r
        const s = say(skills, speakable(r.text))
        return { ...r, speech: s.result }
      })
      return Object.freeze({ state: a.state, bound: a.bound, follow: a.follow, result })
    },
    askStatus: (): Promise<MindStatus> => {
      if (!unlocked) throw locked('ask')
      const { server, model, think, api, provider, key, effort, cache } = mind.settings()
      const base = {
        server, model, ...(think !== undefined && { think }), ...(api !== undefined && { api }),
        ...(provider !== undefined && { provider }), ...(key !== undefined && { key }), ...(effort !== undefined && { effort }), ...(cache !== undefined && { cache }),
      }
      return mind.installed().then(
        (installed) => ({ ...base, installed }),
        (e: unknown) => ({ ...base, installed: null, error: text(e) }),
      )
    },
    askSet: (key: 'model' | 'server' | 'think' | 'api' | 'provider' | 'key' | 'effort', value: string): string => {
      if (!unlocked) throw locked('ask')
      if (key === 'model') return mind.setModel(value)
      if (key === 'server') return mind.setServer(value)
      if (key === 'provider') {
        if (!mind.setProvider) throw new Error('this page has one model provider only')
        const p = mind.setProvider(value)
        return p === 'claude' ? 'claude: the Claude API through a gateway on this machine (best with the key in the gateway; ask key <key> keeps one in this browser)' : p === 'ollama' ? 'ollama: a model server on this machine (the Ollama API)' : `${p}: a packaged model under a llama.cpp server on this machine`
      }
      if (key === 'key') {
        if (!mind.setKey) throw new Error('no provider on this page takes a key')
        const masked = mind.setKey(value === 'none' ? '' : value)
        return masked === null ? 'none: cleared (the gateway on this machine adds the key)' : `${masked}: kept in this browser's local storage (ask key none clears it)`
      }
      if (key === 'effort') {
        if (!mind.setEffort) throw new Error('no provider on this page takes an effort')
        return mind.setEffort(value === 'none' ? '' : value) ?? "none: the provider's own default"
      }
      if (key === 'think') {
        if (value !== 'on' && value !== 'off') throw new TypeError('ask think takes on or off')
        if (!mind.setThink) throw new Error('this model server has no think switch')
        return mind.setThink(value === 'on') ? 'on: the model reasons before it answers (slower; its thinking shows live)' : 'off: the model answers without reasoning first'
      }
      if (key === 'api') {
        if (!mind.setApi) throw new Error('this model server speaks one wire format only')
        const api = mind.setApi(value)
        return api === 'chat' ? 'chat: /v1/chat/completions (the chat-completions format most local servers speak)' : `${api}: /api/generate (the default)`
      }
      throw new TypeError(`nothing to set called '${String(key)}': model, server, think, api, provider, key or effort`)
    },
    askStop: (): string => {
      if (!unlocked) throw locked('ask')
      if (!asking) return 'no answer is being generated'
      asking.stop()
      return 'stopping the answer'
    },
    say: (skills: readonly string[], words: string): GatedSay => {
      if (!unlocked) throw locked('say')
      const { voice: v } = speaker()
      if (saying) throw new Error("something is still being said: wait for it, or type 'say stop'")
      if (v.settings().voice === null) throw new Error('choose a voice first: say voice <name> (type say to list them)')
      return say(skills, String(words))
    },
    sayStatus: (): Promise<VoiceStatus> => {
      if (!unlocked) throw locked('say')
      const { voice: v } = speaker()
      const s = v.settings()
      const base = { server: s.server, model: s.model, voice: s.voice, auto: s.auto, speaking: saying !== null }
      return v.voices().then(
        (voices): VoiceStatus => ({ ...base, voices }),
        (e: unknown): VoiceStatus => ({ ...base, voices: null, error: text(e) }),
      )
    },
    saySet: (key: 'model' | 'server' | 'voice' | 'auto', value: string): string => {
      if (!unlocked) throw locked('say')
      const { voice: v } = speaker()
      if (key === 'model') return v.setModel(value)
      if (key === 'server') return v.setServer(value)
      if (key === 'voice') return v.setVoice(value)
      if (key === 'auto') {
        if (value !== 'on' && value !== 'off') throw new TypeError('say auto takes on or off')
        return v.setAuto(value === 'on') ? 'on: answers are said aloud by whoever gives them' : 'off'
      }
      throw new TypeError(`nothing to set called '${String(key)}': server, voice, model or auto`)
    },
    sayStop: (): string => {
      if (!unlocked) throw locked('say')
      if (!saying) return 'nothing is being said'
      saying.stop()
      return 'stopping the speech'
    },
    api: () => apiDoc(),
    harnesses: () => harnesses(),
    harness: (name: string): Promise<HarnessReport> => {
      if (!unlocked) throw locked('harness')
      if (running !== null) throw new Error(`harness: '${running}' is still running`)
      running = String(name)
      return runHarness(running, sim, sleep).finally(() => { running = null })
    },
  })
}
