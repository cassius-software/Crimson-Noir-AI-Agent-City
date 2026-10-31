// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the operator tier's keeper of one proposed city action at a time: after a console
 * ask settles, it reads the answer's ACTION line (06_Make_Decisions/actions.ts), asks the Ring-0 action gate
 * (02_Define_The_Rules/ring0Gate.ts admitProposal) whether the line may be proposed at all, submits the proposal to the
 * capability gateway as a task of its own bound to the people who answered, shows it to the operator and waits for
 * their OK; on allow it asks the gate again (admitRun: the page contained, the realm standing, the verb kinetic-free,
 * the tier unlocked, a person's OK, the lease held by the proposer, the trail whole) and runs the action once under
 * that lease in the same step; on refuse, `ask stop`, `operator lock`, a lost tether, a closed gateway or the gate's
 * own refusal it ends it, and every proposal, decision and end goes into a hash-chained trail (`act log verify`) and
 * into what the proposer remembers. Nothing runs before the OK, nothing runs twice, nothing waits past a lock, and
 * nothing runs past one either: a lock typed between the OK and the run is found by the gate.
 * What breaks if it is removed? The console and the card have nothing to allow or refuse, and an agent's line is text.
 */
import type { ActBy, ActEnd, ActEvent, ActsBridge, AskResult, Awareness, GatedAsk, GateLease, GateTether, PendingAct, RunState, ScriptApi, SkillGate } from './operator.ts'
import { catalogueLines, parseAction, perform, sentence, type Action, type CityKnobs } from '../06_Make_Decisions/actions.ts'
import { AuditChain, tetherVerdict, type AuditKind, type Invariant } from '../02_Define_The_Rules/guardrails.ts'
import { sha256 } from '../02_Define_The_Rules/integrity.ts'
import { admitProposal, admitRun, invariantsOf, REASONS, sentence as lawSentence, type GateVerdict, type Vouched } from '../02_Define_The_Rules/ring0Gate.ts'

/** What the tier hands the keeper: values only, so this module imports nothing but types from operator.ts. */
export interface ActsDeps {
  readonly gate: SkillGate
  /** The script facade under a lease (operator.ts leasedApi over the tier's ScriptApi). */
  readonly facade: (lease: GateLease) => ScriptApi
  readonly city?: CityKnobs
  /** Notes an allowed action as a run for the people bound (the swarm's diary), or nothing. */
  readonly note?: (bound: readonly GateTether[], skills: readonly string[], text: string, state: RunState, began: number, outcome: 'ok' | 'error' | undefined) => void
  readonly awareness?: Awareness
  readonly nameOf?: (agent: number) => string | null
  readonly now: () => number
  readonly unlocked: () => boolean
  /** What the host vouches to the gate: the page's outbound primitives are held to this machine (null: it has not said). */
  readonly contained: () => Vouched
}

/** The keeper as the tier uses it: the bridge surface plus the two calls only operator.ts makes. */
export interface Acts extends ActsBridge {
  /** After a console ask settles as answered: reads the answer and proposes, refuses or does nothing; the text is the answer with the line stripped. */
  onAnswer(a: GatedAsk, r: AskResult, skills: readonly string[]): Promise<{ text: string; act?: AskResult['act'] }>
  /** `ask stop` or `operator lock` ends a waiting proposal; the proposal it withdrew, or null when none waited. */
  withdraw(why: 'ask stop' | 'operator lock'): PendingAct | null
}

/** Thrown by `allow` and `refuse` when no proposal waits. */
export const NOTHING_WAITING = 'nothing is waiting for your OK'
/** Thrown by `ask` and `swarm run` while a proposal waits (operator.ts): the gate's own clause (OneAtATime). */
export const PROPOSAL_WAITING: string = REASONS.OneAtATime
/** The withdrawal `lock()` makes, and the gate's clause for a line that arrived after `operator lock` was typed (OperatorUnlocked). */
export const TIER_LOCKED: string = REASONS.OperatorUnlocked
const LOCKED = "act: locked; type 'operator unlock' first"

/** Who may decide a proposal: the gateway never allows or refuses, so a `by` it did not make is the host's. */
type Decider = 'console' | 'card' | 'host'
const decider = (by: ActBy | undefined): Decider => (by === 'console' || by === 'card' ? by : 'host')
const BY_TEXT: Readonly<Record<Decider, string>> = Object.freeze({ console: 'at the console', card: 'on the card', host: 'by the host' })

/** What the waiting task is told: the decision, or that the gateway ended it first. */
type Decision = { readonly kind: 'allow'; readonly by: Decider } | { readonly kind: 'refused' } | { readonly kind: 'withdrawn' } | { readonly kind: 'aborted' }

/** One proposal as the keeper holds it from its submission to its end. */
interface Waiting {
  readonly act: PendingAct
  readonly action: Action
  /** The ask's whole binding: the proposer. */
  readonly bound: readonly GateTether[]
  readonly skills: readonly string[]
  /** The gateway's identity of the proposer (`agent 17 (Design)`), the chain's `role`. */
  readonly role: string
  decide: (d: Decision) => void
  /** Settles with the end, whichever way it came. */
  readonly end: Promise<ActEnd>
  settle: (e: ActEnd) => void
  /** Set the moment the operator allows it, so an abort at `use` is noted as an allowed action that never ran. */
  allowed: Decider | null
  /** Ended one way: no second entry, event or episode may follow. */
  over: boolean
}

/** Set equality of two bindings on `{ agent, serial }`: the same people under the same recruitments. */
export function sameBinding(x: readonly GateTether[], y: readonly GateTether[]): boolean {
  const keys = (ts: readonly GateTether[]): Set<string> => new Set(ts.map((t) => `${t.agent}#${t.serial}`))
  const a = keys(x)
  const b = keys(y)
  return a.size === b.size && [...a].every((k) => b.has(k))
}

/** The gateway's own name for a tether (08_Swarm/taskRouter.ts describe): never the roster's. */
const gatewayName = (t: GateTether): string => `agent ${t.agent} (${t.skills.join(', ')})`

/** An error's own message (no "Name:" prefix): what the facade or the engine said. */
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The Ring-0 audit's panic reason as the facade reports it (null while the realm stands); a facade that cannot say is a halted realm. */
const panicOf = (facade: ScriptApi): string | null => {
  try {
    return facade.kernel.stats().audit.panic ?? null
  } catch (e) {
    return messageOf(e)
  }
}

/**
 * The keeper of proposals (section 3 of the design): one waiting at a time, submitted to the gateway the moment the
 * answer is parsed so it binds the tethers the answer had, ended by the operator (allow, refuse, `ask stop`,
 * `operator lock`) or by the gateway (the tether breaking, the gateway closing). One audit chain for the page.
 */
export function createActs(deps: ActsDeps): Acts {
  const chain = new AuditChain()
  const followers = new Set<(ev: ActEvent) => void>()
  let pending: Waiting | null = null
  /** Proposals shown on this page. */
  let seq = 0

  const record = (kind: AuditKind, step: string, role: string, input: string, output: string, promptHash: string | null, failed: readonly Invariant[], note: string): void => {
    chain.append({ at: deps.now(), kind, step, role, inputHash: input ? sha256(input) : '', outputHash: output ? sha256(output) : '', promptHash, failed, note })
  }
  const tell = (ev: ActEvent): void => {
    for (const fn of [...followers]) {
      try {
        fn(ev)
      } catch {
        // a follower's own failure does not end a proposal
      }
    }
  }
  /** A moment for every person the answer was bound to: fixed words plus the city's own sentence, reason or line. */
  const remember = (bound: readonly GateTether[], who: string, what: string): void => {
    for (const t of bound) deps.awareness?.remember(t.agent, who, what)
  }
  /** `Mara (agent 17, Design)` when the roster knows them, else the gateway's `agent 17 (Design)`. */
  const whoOf = (t: GateTether): string => {
    const name = deps.nameOf?.(t.agent) ?? null
    const skills = t.skills.join(', ')
    return name ? `${name} (agent ${t.agent}, ${skills})` : `agent ${t.agent} (${skills})`
  }
  const stepOf = (w: Waiting): string => `act-${w.act.seq}`
  /** Ends a proposal: the event every surface follows, then the promise `allow` handed out. */
  const finish = (w: Waiting, end: ActEnd, by: ActBy): void => {
    w.over = true
    tell({ kind: 'ended', act: w.act, end, by })
    w.settle(end)
  }

  /** The proposal's task: waits for the decision and, on allow, runs the action once under the lease. */
  const taskOf = (w: Waiting, lease: GateLease, unbound: (now: readonly GateTether[]) => void): Promise<string> => {
    // The identity rule: the proposer is the ask's whole binding. Anyone else bound now, or the same people under a new
    // recruitment, is not the proposer; the task ends here and the keeper refuses in its own words.
    if (!sameBinding(w.bound, lease.bound)) {
      unbound(lease.bound)
      return Promise.resolve('unbound')
    }
    return new Promise<Decision>((resolve) => { w.decide = resolve }).then((d) => {
      if (d.kind !== 'allow') return d.kind
      const text = `city action: ${w.act.sentence}`
      try {
        // P5: the tether is checked against the newest copy of the swarm, the gate asked, and the action made in that
        // one step, over the leased facade (each of its calls checked again) and the two city knobs.
        const ran = lease.use((): { readonly ok: true; readonly line: string } | { readonly ok: false; readonly verdict: GateVerdict } => {
          const facade = deps.facade(lease)
          const verdict = admitRun({
            contained: deps.contained(), verb: w.action.verb, panic: panicOf(facade), unlocked: deps.unlocked(), allowedBy: d.by,
            held: lease.held, proposer: sameBinding(w.bound, lease.bound), chainOk: chain.verify().ok,
          })
          return verdict.admitted ? { ok: true, line: perform(w.action, facade, deps.city) } : { ok: false, verdict }
        })
        if (!ran.ok) {
          // The gate refused an allowed action: nothing of it reached the city, and the law that refused is on the trail.
          const reason = lawSentence(ran.verdict)
          record('refusal', stepOf(w), w.role, w.action.canonical, '', null, invariantsOf(ran.verdict), `not run: ${reason}`)
          remember(w.bound, 'the player', `allowed your proposal but the city refused it: ${w.act.sentence} (${reason})`)
          deps.note?.(w.bound, w.skills, text, 'Rejected', w.act.since, undefined)
          finish(w, { state: 'denied', line: reason }, d.by)
          return 'refused'
        }
        const line = ran.line
        record('end', stepOf(w), w.role, w.action.canonical, line, null, [], `done: ${line}`)
        remember(w.bound, 'the player', `allowed your proposal and the city did it: ${line}`)
        deps.note?.(w.bound, w.skills, text, 'Authorized', w.act.since, 'ok')
        finish(w, { state: 'done', line }, d.by)
        return 'done'
      } catch (e) {
        // The lease is gone (the tether broke in this very step, P5): the gateway's verdict, a step later, records the
        // stop in its own words; nothing of the action reached the city.
        if (lease.signal.aborted) return 'aborted'
        const message = messageOf(e)
        record('end', stepOf(w), w.role, w.action.canonical, message, null, [], `failed: ${message}`)
        remember(w.bound, 'the player', `allowed your proposal but the city could not: ${w.act.sentence} (${message})`)
        deps.note?.(w.bound, w.skills, text, 'Authorized', w.act.since, 'error')
        finish(w, { state: 'failed', line: message }, d.by)
        return 'failed'
      }
    })
  }

  /** The gateway ended the task (P4 while it waited, P5 at `use`, P9 when the gateway closed): the stop, in its words. */
  const aborted = (w: Waiting, message: string): void => {
    if (w.over) return
    if (pending === w) pending = null
    const by: ActBy = w.allowed ?? 'gateway'
    const reason = tetherVerdict('Aborted', message).reasons[0]
    record('stop', stepOf(w), w.role, w.action.canonical, '', null, ['CapabilityTethered'], reason)
    // An allowed action that never ran teaches nothing: the episode says Aborted and has no outcome.
    if (w.allowed !== null) deps.note?.(w.bound, w.skills, `city action: ${w.act.sentence}`, 'Aborted', w.act.since, undefined)
    finish(w, { state: 'aborted', line: reason }, by)
    w.decide({ kind: 'aborted' })
  }

  const onAnswer = async (a: GatedAsk, r: AskResult, skills: readonly string[]): Promise<{ text: string; act?: AskResult['act'] }> => {
    const p = parseAction(r.text)
    if (p.kind === 'none') return { text: p.text }
    const first = a.bound[0]
    // An Authorized ask is bound to someone (the gateway never authorizes an empty requirement); nothing to propose for otherwise.
    if (!first) return { text: p.text }
    const role = gatewayName(first)
    const promptHash = r.promptHash ?? null
    // The gate, before anything is shown: the page contained, the line screened, the line one of the catalogue (a line
    // the catalogue could not read fails Catalogued in the catalogue's own words), the tier unlocked (a lock typed
    // during the stream: no proposal past a lock), one at a time (an ask cannot settle while a proposal waits,
    // operator.ts refuses it, so that one never fires; it holds anyway). The law that refused is on the trail and in
    // the reason; the proposer of an unreadable line is told next time, in the catalogue's words.
    const line = p.kind === 'refused' ? p.line ?? '' : p.line
    const pre = admitProposal({ contained: deps.contained(), line, catalogued: p.kind === 'refused' ? { reason: p.reason } : true, unlocked: deps.unlocked(), vacant: pending === null })
    if (p.kind === 'refused' || !pre.admitted) {
      const reason = lawSentence(pre)
      record('refusal', 'act-', role, line, '', promptHash, invariantsOf(pre), `not run: ${reason}`)
      if (p.kind === 'refused') {
        remember(a.bound, 'the city', `could not read your action line: ${p.reason}; nothing was proposed`)
        return { text: p.text, act: { kind: 'refused', reason, ...(p.line !== undefined && { line: p.line }), told: first.agent } }
      }
      return { text: p.text, act: { kind: 'refused', reason, line } }
    }
    const { action } = p
    const words = sentence(action)
    const since = deps.now()
    const act: PendingAct = Object.freeze({
      seq: seq + 1, who: whoOf(first), agent: first.agent, serial: first.serial, skills: Object.freeze([...first.skills]),
      verb: action.verb, canonical: action.canonical, sentence: words, ...(p.note !== undefined && { note: p.note }), since,
    })
    let settle: (e: ActEnd) => void = () => {}
    const end = new Promise<ActEnd>((resolve) => { settle = resolve })
    const w: Waiting = { act, action, bound: a.bound, skills, role, decide: () => {}, end, settle, allowed: null, over: false }
    /** Who the gate bound instead, when it was not the proposer (set by the task in the same step as the submission). */
    const seen: { other: readonly GateTether[] | null } = { other: null }
    // Submitted inside the ask's own settlement, so the gateway binds the tethers the answer had (the same mirror).
    const handle = deps.gate.submit(skills, (lease) => taskOf(w, lease, (now) => { seen.other = now }))
    if (handle.state === 'Rejected') {
      const v = await handle.verdict
      const reason = tetherVerdict('Rejected', v.state === 'Rejected' ? v.message : '').reasons[0]
      record('refusal', 'act-', role, line, '', promptHash, ['CapabilityTethered'], `not run: ${reason}`)
      return { text: p.text, act: { kind: 'refused', reason, line } }
    }
    if (seen.other !== null) {
      // The same person under a new recruitment is named as such, so the line never reads "binds X, not X".
      const renamed = seen.other.map((t) => (a.bound.some((b) => b.agent === t.agent && b.serial !== t.serial) ? `${whoOf(t)} under a new recruitment` : whoOf(t))).join(' and ')
      const reason = `Refused (Proposer Not Bound): the gate now binds ${renamed}, not ${act.who}`
      record('refusal', 'act-', role, line, '', promptHash, ['CapabilityTethered'], `not run: ${reason}`)
      return { text: p.text, act: { kind: 'refused', reason, line } }
    }
    seq = act.seq
    pending = w
    void handle.verdict.then((v) => { if (v.state === 'Aborted') aborted(w, v.message) })
    record('step', stepOf(w), role, line, action.canonical, promptHash, [], `proposed: ${words}${p.note !== undefined ? ` (${p.note})` : ''}`)
    tell({ kind: 'proposed', act })
    return { text: p.text, act: { kind: 'proposed', seq: act.seq, who: act.who, sentence: words, ...(p.note !== undefined && { note: p.note }), line } }
  }

  /** The proposal waiting, or the refusal: locked first, then nothing waiting. */
  const waiting = (): Waiting => {
    if (!deps.unlocked()) throw new Error(LOCKED)
    if (!pending) throw new Error(NOTHING_WAITING)
    const w = pending
    // Nulled before the decision is made or announced: nothing can be allowed or refused twice.
    pending = null
    return w
  }

  return Object.freeze({
    pending: () => pending?.act ?? null,
    follow: (fn: (ev: ActEvent) => void) => {
      followers.add(fn)
      return () => { followers.delete(fn) }
    },
    allow: (by?: ActBy) => {
      const w = waiting()
      const d = decider(by)
      w.allowed = d
      record('answer', stepOf(w), w.role, w.action.canonical, '', null, [], `allowed ${BY_TEXT[d]}`)
      tell({ kind: 'allowed', act: w.act, by: d })
      w.decide({ kind: 'allow', by: d })
      return { act: w.act, result: w.end }
    },
    refuse: (by?: ActBy) => {
      const w = waiting()
      const d = decider(by)
      record('refusal', stepOf(w), w.role, w.action.canonical, '', null, ['HumanOverrideSupreme'], `refused ${BY_TEXT[d]}`)
      remember(w.bound, 'the player', `refused your proposal: ${w.act.sentence}`)
      finish(w, { state: 'refused', line: w.act.sentence }, d)
      w.decide({ kind: 'refused' })
      return w.act
    },
    log: () => chain.entries(),
    verify: () => chain.verify(),
    list: () => catalogueLines(),
    onAnswer,
    withdraw: (why: 'ask stop' | 'operator lock') => {
      const w = pending
      if (!w) return null
      pending = null
      const line = why === 'ask stop' ? 'ask stop' : TIER_LOCKED
      record('stop', stepOf(w), w.role, w.action.canonical, '', null, ['HumanOverrideSupreme'], `withdrawn: ${line}`)
      remember(w.bound, 'the player', `withdrew your proposal: ${w.act.sentence} (${why})`)
      // The console caused it (ask stop, operator lock): the command prints the line, the follower stays quiet.
      finish(w, { state: 'withdrawn', line }, 'console')
      w.decide({ kind: 'withdrawn' })
      return w.act
    },
  })
}
