// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the gateway every task that needs a skill goes through, so that the work is only
 * ever done while someone who has that skill is physically with the operator. A task names the skills it needs; the
 * gateway intersects them with the union of the skills of everyone Active in the page's newest copy of the worker's
 * list (recruitment.ts replaces it at every state) and either rejects the task at once or binds it to the fewest
 * tethers that cover it and starts it under an AbortController: its lease. Every copy that reaches the page re-checks
 * every lease before that state's events reach anyone, and a lease whose tether is gone is aborted there and then;
 * `lease.use` checks the newest copy and acts in one synchronous turn; and a task's result counts only if its lease
 * still holds when the result arrives. It only reads the list the worker sends: nothing here reaches a pedestrian or
 * the physics realm (the air gap), and the worker alone decides who is tethered.
 * What breaks if it is removed? A task could start on a skill nobody present has, or keep running (and report success)
 * after the person who had the skill was left behind.
 */
import { RECRUIT_SLOTS, SKILLS } from '../03_Spawn_Agents/skills.ts'
import type { RecruitView } from '../07_Execute_Actions/simProtocol.ts'

/*
 * The contract, as properties taskRouter.test.ts checks. A "mirror" is one copy of the worker's list on the page.
 *   P1 Gate. submit() is Authorized iff every skill the task requires is in the union of the skills of the Active
 *      tethers in the newest mirror; otherwise Rejected (InsufficientCapabilities), `missing` naming what nobody has.
 *   P2 Binding. An Authorized task is bound to a smallest set of those tethers that covers its requirement; of several,
 *      the one whose members joined earliest (lexicographic in join order). The same mirror always gives the same set.
 *   P3 Check, then start. The task is called synchronously inside submit(), right after the check: no state can
 *      arrive between the two.
 *   P4 Lease. Every mirror re-checks every running lease. The first mirror in which a bound tether is not Active (gone,
 *      not arrived, or the same person under a new recruitment) aborts the task: its state is Aborted and its signal
 *      fired inside that update, before that state's events are dispatched (recruitment.ts onMirror).
 *   P5 Use. lease.use(act) runs act iff the task is running and every bound tether is Active in the newest mirror at
 *      that moment; otherwise act does not run, a running task is aborted there and then, and use throws.
 *   P6 Commit. A task that settles while running is Authorized with its outcome iff its tethers are Active in the
 *      newest mirror at that moment; otherwise it is Aborted and the outcome is discarded. A task that settles after
 *      it was aborted changes nothing.
 *   P7 Finality. From submit() on a task is Authorized, Rejected or Aborted. The state changes at most once, from
 *      Authorized to Aborted, and only before the task's outcome is committed. The verdict settles exactly once and
 *      never rejects.
 *   P8 Signal. lease.signal is aborted exactly when the task is Aborted. The state is set first, so the signal's own
 *      listeners already see Aborted.
 *   P9 Close. dispose(), or the mirror's source closing (an empty mirror), aborts every running task; a closed gateway
 *      rejects everything.
 *   P10 Determinism. A verdict depends only on the requirement, the sequence of mirrors, the task's calls to use and
 *      the order in which it settles: no clock, no randomness.
 */

/** The only states the gateway reports. */
export type GatewayState = 'Authorized' | 'Rejected' | 'Aborted'

/** A tether as the gateway binds it: the person, the recruitment of them (never reused) and the skills they bring. */
export interface Tether {
  readonly agent: number
  readonly serial: number
  readonly skills: readonly string[]
}

/** What a task produced: its value, or what it threw. */
export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }

/** A task's final word from the gateway. */
export type Verdict<T> =
  | {
    readonly state: 'Authorized'
    readonly task: number
    readonly requires: readonly string[]
    readonly bound: readonly Tether[]
    /** The task ran to the end under its lease: this is what it returned, or threw. */
    readonly outcome: Outcome<T>
  }
  | {
    readonly state: 'Rejected'
    readonly task: number
    readonly requires: readonly string[]
    readonly reason: 'InsufficientCapabilities'
    /** The required skills nobody Active has. */
    readonly missing: readonly string[]
    readonly message: string
  }
  | {
    readonly state: 'Aborted'
    readonly task: number
    readonly requires: readonly string[]
    readonly bound: readonly Tether[]
    readonly reason: 'SpatialTetherLost'
    /** The bound tethers the mirror that broke the lease no longer held (all of them when the gateway closed). */
    readonly lost: readonly Tether[]
    readonly message: string
  }

/** What the gateway reads: the page's copy of the worker's list (recruitment.ts Recruiter). */
export interface SwarmSource {
  /** The newest mirror. */
  readonly recruits: readonly RecruitView[]
  /** Calls `fn` with every new mirror before anything else sees it, and with [] when the source closes; returns the unsubscribe. */
  onMirror(fn: (recruits: readonly RecruitView[]) => void): () => void
}

/** A task's hold on the tethers it was authorized on. */
export interface Lease {
  /** Aborted, with an AbortError naming the lost tethers, the moment the lease breaks (P4, P8). */
  readonly signal: AbortSignal
  /** The tethers the task is bound to. */
  readonly bound: readonly Tether[]
  /** Whether the task is still running and every bound tether is Active in the newest mirror (a pure query). */
  readonly held: boolean
  /**
   * The check and the use as one step (P5): runs `act` now if the lease holds in the newest mirror, and returns what
   * it returns; otherwise `act` does not run, the task is aborted if it was running, and this throws (the abort
   * reason, or an InvalidStateError once the task has ended). `act` should be synchronous: anything it leaves for
   * later runs outside the check, so call use again before each later effect.
   */
  use<R>(act: () => R): R
}

/** A submitted task, as the operator follows it. */
export interface TaskHandle<T> {
  readonly task: number
  /** The skills it requires, as the city names them. */
  readonly requires: readonly string[]
  /** Authorized from authorization on (running, then done), Rejected at once, or Aborted (P7). */
  readonly state: GatewayState
  /** Whether the verdict is decided. */
  readonly done: boolean
  readonly verdict: Promise<Verdict<T>>
  /** The lease it runs under (null when Rejected). */
  readonly lease: Lease | null
}

/** The work: called once, synchronously, when authorized, with its lease. */
export type Task<T> = (lease: Lease) => T | PromiseLike<T>

// ---------------------------------------------------------------- the pure core

/**
 * The skills a request names, each once, as the city names them, in any case ("rust" is Rust). No guessing: only a
 * skill's exact name counts ("Rust, Go" or "rust developer" is not Rust), and anything else is kept as given, so
 * nobody has it and the task is rejected rather than bound to less than it asked for. Throws a TypeError on anything
 * else: not a name or a list of names, a blank name, or no name at all (a task that requires nothing would be bound
 * to nobody, and nothing could ever abort it).
 */
export function requirement(requires: unknown): string[] {
  const list: unknown[] | null = typeof requires === 'string' ? [requires] : Array.isArray(requires) ? requires : null
  if (list === null) throw new TypeError('a task requires a skill name or a list of skill names')
  const out: string[] = []
  for (const raw of list) {
    if (typeof raw !== 'string' || !raw.trim()) throw new TypeError(`not a skill name: ${JSON.stringify(raw)}`)
    const given = raw.trim()
    const name = SKILLS.find((s) => s.toLowerCase() === given.toLowerCase()) ?? given
    if (!out.includes(name)) out.push(name)
  }
  if (!out.length) throw new TypeError('a task must require at least one skill: nothing else binds it to the swarm')
  return out
}

/**
 * The Active tethers in a mirror, in the worker's order (the order they were asked over). Only an entry the worker
 * marks Active and arrived, for an agent listed once, with an integer serial and at least one skill name, counts;
 * a list longer than the worker's slots is not one the worker sent and counts for nothing. Whatever is malformed is
 * treated as absent, so it can break a lease but never hold one.
 */
export function activeTethers(mirror: unknown): Tether[] {
  if (!Array.isArray(mirror) || mirror.length > RECRUIT_SLOTS) return []
  const listed = new Map<unknown, number>()
  for (const r of mirror) {
    const agent = typeof r === 'object' && r !== null ? (r as { agent?: unknown }).agent : undefined
    listed.set(agent, (listed.get(agent) ?? 0) + 1)
  }
  const out: Tether[] = []
  for (const r of mirror) {
    if (typeof r !== 'object' || r === null) continue
    const { agent, serial, state, arrived, skills } = r as { [K in keyof RecruitView]?: unknown }
    if (state !== 'Active' || arrived !== true) continue
    if (typeof agent !== 'number' || !Number.isInteger(agent) || agent < 1 || listed.get(agent) !== 1) continue
    if (typeof serial !== 'number' || !Number.isInteger(serial) || serial < 1) continue
    if (!Array.isArray(skills) || !skills.length || !skills.every((s) => typeof s === 'string')) continue
    out.push(Object.freeze({ agent, serial, skills: Object.freeze([...(skills as string[])]) }))
  }
  return out
}

/** Every skill the tethers bring, each once, in the order they joined: the capability set the gate intersects with. */
export function capabilities(tethers: readonly Tether[]): string[] {
  const out = new Set<string>()
  for (const t of tethers) for (const s of t.skills) out.add(s)
  return [...out]
}

/** The gate's decision. */
export type Decision = { readonly ok: true; readonly bound: readonly Tether[] } | { readonly ok: false; readonly missing: readonly string[] }

/** Every k-subset of 0…n−1, as ascending index lists, in lexicographic order. */
function* combinations(n: number, k: number): Generator<number[]> {
  if (k < 1 || k > n) return
  const c = Array.from({ length: k }, (_, i) => i)
  for (;;) {
    yield [...c]
    let i = k - 1
    while (i >= 0 && c[i] === n - k + i) i--
    if (i < 0) return
    c[i]++
    for (let j = i + 1; j < k; j++) c[j] = c[j - 1] + 1
  }
}

/**
 * The gate (P1, P2). Missing: the required skills outside the capability set, each once, in the order required.
 * Otherwise the smallest set of tethers whose skills cover the requirement, the first such set in lexicographic join
 * order (only tethers bringing a required skill can be in a smallest set, and filtering keeps their order). An empty
 * requirement is never authorized: nothing would bind it.
 */
export function authorize(requires: readonly string[], tethers: readonly Tether[]): Decision {
  const have = new Set(capabilities(tethers))
  const missing = Object.freeze(requires.filter((s, i) => !have.has(s) && requires.indexOf(s) === i))
  if (missing.length || !requires.length) return { ok: false, missing }
  const useful = tethers.filter((t) => t.skills.some((s) => requires.includes(s)))
  // One tether per required skill always covers, so a smallest cover has at most requires.length members.
  for (let k = 1; k <= Math.min(requires.length, useful.length); k++) {
    for (const pick of combinations(useful.length, k)) {
      const chosen = pick.map((i) => useful[i])
      if (requires.every((s) => chosen.some((t) => t.skills.includes(s)))) return { ok: true, bound: Object.freeze(chosen) }
    }
  }
  return { ok: false, missing }
}

/**
 * The bound tethers a mirror's Active tethers no longer hold, in bound order (empty: the lease holds). A bound tether
 * is held by an Active tether of the same person under the same recruitment that still brings every skill it had.
 */
export function lostFrom(bound: readonly Tether[], tethers: readonly Tether[]): Tether[] {
  return bound.filter((b) => {
    const now = tethers.find((t) => t.agent === b.agent && t.serial === b.serial)
    return !now || !b.skills.every((s) => now.skills.includes(s))
  })
}

/** A submitted task's phase: running under its lease, or decided. */
export type Phase<T> =
  | { readonly kind: 'running' }
  | { readonly kind: 'completed'; readonly outcome: Outcome<T> }
  | { readonly kind: 'aborted'; readonly lost: readonly Tether[]; readonly closed: boolean }
  | { readonly kind: 'rejected'; readonly missing: readonly string[] }

/**
 * What can happen to a running task: a mirror (a new state, a use, or any other look at the newest copy), the task
 * settling (with the newest mirror at that moment), or the gateway closing.
 */
export type LeaseEvent<T> =
  | { readonly e: 'mirror'; readonly tethers: readonly Tether[] }
  | { readonly e: 'settled'; readonly tethers: readonly Tether[]; readonly outcome: Outcome<T> }
  | { readonly e: 'closed' }

/**
 * The lease's transition function (P4, P6, P7, P9): total and pure. A decided phase is returned as it is, and so is a
 * running one that goes on running; any other result is a new, decided phase.
 */
export function advance<T>(phase: Phase<T>, bound: readonly Tether[], ev: LeaseEvent<T>): Phase<T> {
  if (phase.kind !== 'running') return phase
  if (ev.e === 'closed') return { kind: 'aborted', lost: bound, closed: true }
  const lost = lostFrom(bound, ev.tethers)
  if (lost.length) return { kind: 'aborted', lost: Object.freeze(lost), closed: false }
  return ev.e === 'settled' ? { kind: 'completed', outcome: ev.outcome } : phase
}

/** The state the operator sees in a phase. */
export function gatewayState(phase: Phase<unknown>): GatewayState {
  return phase.kind === 'rejected' ? 'Rejected' : phase.kind === 'aborted' ? 'Aborted' : 'Authorized'
}

const describe = (t: Tether): string => `agent ${t.agent} (${t.skills.join(', ')})`

/** Why a lease broke, in one line. */
function abortMessage(p: { readonly lost: readonly Tether[]; readonly closed: boolean }): string {
  return p.closed ? 'the gateway closed: the tether can no longer be checked' : `${p.lost.map(describe).join('; ')}: no longer tethered to the operator`
}

// ---------------------------------------------------------------- the gateway

/** One submitted task as the gateway keeps it. */
class Job {
  readonly id: number
  readonly requires: readonly string[]
  readonly bound: readonly Tether[]
  phase: Phase<unknown>
  readonly controller = new AbortController()
  readonly verdict: Promise<Verdict<unknown>>
  #resolve: (v: Verdict<unknown>) => void = () => {}
  constructor(id: number, requires: readonly string[], bound: readonly Tether[], phase: Phase<unknown>) {
    this.id = id
    this.requires = requires
    this.bound = bound
    this.phase = phase
    this.verdict = new Promise((resolve) => { this.#resolve = resolve })
  }

  /** The verdict for the decided phase; called once, when the phase is decided. */
  decide(closed: boolean): void {
    const { id: task, requires, bound } = this
    const p = this.phase
    let v: Verdict<unknown>
    if (p.kind === 'completed') v = { state: 'Authorized', task, requires, bound, outcome: p.outcome }
    else if (p.kind === 'aborted') v = { state: 'Aborted', task, requires, bound, reason: 'SpatialTetherLost', lost: p.lost, message: abortMessage(p) }
    else if (p.kind === 'rejected') {
      const message = closed ? 'the gateway is closed' : `nobody tethered to the operator has ${p.missing.join(', ')}`
      v = { state: 'Rejected', task, requires, reason: 'InsufficientCapabilities', missing: p.missing, message }
    } else throw new Error('a running task has no verdict')
    this.#resolve(Object.freeze(v))
  }
}

/** The operator's task gateway over the page's copy of the swarm. */
export class TaskRouter {
  readonly #source: SwarmSource
  readonly #unsubscribe: () => void
  /** Every task Authorized and still running, in the order submitted. */
  readonly #running = new Set<Job>()
  #tasks = 0
  #closed = false

  constructor(source: SwarmSource) {
    this.#source = source
    this.#unsubscribe = source.onMirror((recruits) => this.#mirror(recruits))
  }

  /** The skills the Active tethers bring in the newest mirror: what a task can require now. */
  get capabilities(): string[] {
    return capabilities(this.#tethers())
  }

  /** How many tasks are running under a lease. */
  get running(): number {
    return this.#running.size
  }

  get closed(): boolean {
    return this.#closed
  }

  /**
   * Submits a task that requires `requires` (P1–P3): decided at once against the newest mirror. Rejected, the task is
   * never called. Authorized, it is called now with its lease, and its verdict follows the lease. Throws a TypeError
   * only for a malformed request (requirement()) or a task that is not a function.
   */
  submit<T>(requires: string | readonly string[], task: Task<T>): TaskHandle<T> {
    const need = Object.freeze(requirement(requires))
    if (typeof task !== 'function') throw new TypeError('a task is a function of its lease')
    const id = ++this.#tasks
    const decision = authorize(need, this.#tethers())
    if (!decision.ok) {
      const job = new Job(id, need, Object.freeze([]), { kind: 'rejected', missing: decision.missing })
      job.decide(this.#closed)
      return handleOf<T>(job, null)
    }
    const job = new Job(id, need, decision.bound, { kind: 'running' })
    this.#running.add(job)
    const lease = this.#lease(job)
    const handle = handleOf<T>(job, lease)
    // P3: the check above and the start below are one synchronous step.
    let result: T | PromiseLike<T>
    try {
      result = task(lease)
    } catch (error) {
      result = Promise.reject(error)
    }
    Promise.resolve(result).then(
      (value) => this.#apply(job, { e: 'settled', tethers: this.#tethers(), outcome: Object.freeze({ ok: true, value }) }),
      (error: unknown) => this.#apply(job, { e: 'settled', tethers: this.#tethers(), outcome: Object.freeze({ ok: false, error }) }),
    )
    return handle
  }

  /** Stops following the swarm: every running task is aborted (P9), and every later one rejected. */
  dispose(): void {
    if (this.#closed) return
    this.#closed = true
    this.#unsubscribe()
    for (const job of [...this.#running]) this.#apply(job, { e: 'closed' })
  }

  /** The Active tethers in the newest mirror (none once closed). */
  #tethers(): Tether[] {
    return this.#closed ? [] : activeTethers(this.#source.recruits)
  }

  /** Each new mirror re-checks every running lease, in the order the tasks were submitted (P4). */
  #mirror(recruits: readonly RecruitView[]): void {
    if (this.#closed) return
    const tethers = activeTethers(recruits)
    for (const job of [...this.#running]) this.#apply(job, { e: 'mirror', tethers })
  }

  /**
   * Moves a task by one event. A decision takes effect in a fixed order: the phase (so the state reads Aborted or
   * done), the running set, then the signal, then the verdict (P8). A listener on the signal that submits, uses a
   * lease or disposes the gateway finds everything already consistent.
   */
  #apply(job: Job, ev: LeaseEvent<unknown>): void {
    const next = advance(job.phase, job.bound, ev)
    if (next === job.phase) return
    job.phase = next
    this.#running.delete(job)
    if (next.kind === 'aborted') job.controller.abort(new DOMException(`Spatial tether lost: ${abortMessage(next)}`, 'AbortError'))
    job.decide(this.#closed)
  }

  #lease(job: Job): Lease {
    const holds = (): boolean => job.phase.kind === 'running' && lostFrom(job.bound, this.#tethers()).length === 0
    return Object.freeze({
      signal: job.controller.signal,
      bound: job.bound,
      get held(): boolean {
        return holds()
      },
      use: <R>(act: () => R): R => {
        // P5: checked against the newest mirror and acted on in this one synchronous turn.
        this.#apply(job, { e: 'mirror', tethers: this.#tethers() })
        if (job.phase.kind === 'aborted') throw job.controller.signal.reason
        if (job.phase.kind !== 'running') throw new DOMException('the lease ended with its task', 'InvalidStateError')
        return act()
      },
    })
  }
}

/** The operator's view of a task: live state over the gateway's record. */
function handleOf<T>(job: Job, lease: Lease | null): TaskHandle<T> {
  return Object.freeze({
    task: job.id,
    requires: job.requires,
    get state(): GatewayState {
      return gatewayState(job.phase)
    },
    get done(): boolean {
      return job.phase.kind !== 'running'
    },
    // The outcome is what the task (a Task<T>) returned: the only place T is restored.
    verdict: job.verdict as Promise<Verdict<T>>,
    lease,
  })
}
