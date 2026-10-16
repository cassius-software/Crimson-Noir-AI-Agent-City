// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the swarm orchestrator behind the console's `swarm` command (and anything the host
 * wires to it, a voice line included): a goal the operator states is split over up to five roles (the architect, the
 * coder, the tester, the auditor, the verifier), each a step of a fixed, deterministic DAG that hands its answer to
 * the steps after it, and each step is one prompt through the operator tier's gated ask: answered by whichever model
 * provider is chosen (09_Cognition/router.ts), only while someone tethered to the operator has the role's skill
 * (08_Swarm/taskRouter.ts), screened on the way in and out (02_Define_The_Rules/conduct.ts), and passed through the
 * guardrail layer before and after (02_Define_The_Rules/guardrails.ts), which also keeps the hash-chained audit trail
 * of the run. Steps run one after another, in topological order, because the operator tier answers one prompt at a
 * time; a refusal, a lost tether, a server failure or the operator's stop ends the run there, with everything that
 * came before kept in the report. Pure of I/O itself: it asks through the function it is handed and reads the clock
 * it is handed.
 * What it is not: the roles are prompts, not separate agents with tools; the orchestrator issues no script, changes
 * nothing in the city and writes no file. It answers in text, on the console.
 * What breaks if it is removed? `swarm` has nothing behind it; `ask` is one prompt at a time, by hand.
 */
import {
  admitAnswer, admitStep, AuditChain, QUOTA, tetherVerdict, verifyChain, type AuditEntry, type Invariant, type Quota,
} from '../02_Define_The_Rules/guardrails.ts'
import { sha256 } from '../02_Define_The_Rules/integrity.ts'
import type { AskResult, GatedAsk, Piece } from '../07_Execute_Actions/operator.ts'

export type RoleId = 'architect' | 'coder' | 'tester' | 'auditor' | 'verifier'

/** A role: its name, the skill whoever answers for it must have (03_Spawn_Agents/skills.ts), and its brief. */
export interface Role {
  readonly id: RoleId
  readonly title: string
  readonly skill: string
  readonly brief: string
}

/** The five roles, in the order they are rallied; `agents` on a plan takes the first that many. */
export const ROLES: readonly Role[] = Object.freeze([
  Object.freeze({ id: 'architect', title: 'Prime Architect', skill: 'Design', brief: 'You are the architect. Lay out how the goal is met: the parts, their boundaries, the order of work, and what must stay true throughout. Plain prose, numbered where order matters.' }),
  Object.freeze({ id: 'coder', title: 'Systems Coder', skill: 'TypeScript', brief: 'You are the coder. Turn the architecture into concrete changes: which files or units, what each does, the interfaces between them, and the edge cases each must handle. Code only where a few lines say it better than prose.' }),
  Object.freeze({ id: 'tester', title: 'Sim-to-Real Tester', skill: 'Testing', brief: 'You are the tester. For the changes proposed, name the tests that prove them, the inputs that break them, and what cannot be tested without real hardware. Say plainly what remains unverified.' }),
  Object.freeze({ id: 'auditor', title: 'Mechanistic Auditor', skill: 'Security', brief: 'You are the auditor. Read the architecture and the changes for what could go wrong: data leaving this machine, a rule bypassed, a budget exceeded, a claim stronger than its evidence. List findings by severity, each with the path that reaches it.' }),
  Object.freeze({ id: 'verifier', title: 'Legal/IP Verifier', skill: 'Writing', brief: 'You are the verifier. Check the work for third-party material, licence terms and claims about what was proved, and write the summary the operator will read: what was done, what was found, what is left, in plain sentences.' }),
])

export const isRoleId = (v: unknown): v is RoleId => ROLES.some((r) => r.id === v)
export const roleOf = (id: RoleId): Role => ROLES.find((r) => r.id === id)!

/** One step of a plan: a role, and the steps whose answers it reads. */
export interface SwarmStep {
  readonly id: string
  readonly role: RoleId
  readonly needs: readonly string[]
}

export interface SwarmPlan {
  readonly goal: string
  readonly agents: number
  readonly steps: readonly SwarmStep[]
}

/**
 * The plan for a goal: the first `agents` roles, each step reading every step before it (a chain, which is a DAG),
 * so the coder reads the architect, the tester reads both, and so on. Deterministic: the same goal and count give
 * the same plan. Throws on an empty or over-long goal, or a count outside 1..ROLES.length.
 */
export function planSwarm(goal: string, agents = ROLES.length, quota: Quota = QUOTA): SwarmPlan {
  const g = typeof goal === 'string' ? goal.replace(/\s+/g, ' ').trim() : ''
  if (!g) throw new Error('swarm: state the goal, e.g. swarm run audit the fleet\'s braking envelope')
  if (g.length > quota.goalChars) throw new Error(`swarm: the goal is ${g.length} characters; at most ${quota.goalChars}`)
  if (!Number.isInteger(agents) || agents < 1 || agents > Math.min(ROLES.length, quota.agents)) throw new RangeError(`swarm: --agents takes 1 to ${Math.min(ROLES.length, quota.agents)}`)
  const roles = ROLES.slice(0, agents)
  const steps = roles.map((r, i) => Object.freeze({ id: r.id, role: r.id, needs: Object.freeze(roles.slice(0, i).map((p) => p.id)) }))
  return Object.freeze({ goal: g, agents, steps: Object.freeze(steps) })
}

/** The steps in an order that runs every step after the steps it needs (Kahn's algorithm, ties by plan order). Throws on a cycle or an unknown need. */
export function order(steps: readonly SwarmStep[]): string[] {
  const ids = new Set(steps.map((s) => s.id))
  const left = new Map(steps.map((s) => [s.id, new Set(s.needs)]))
  for (const [id, needs] of left) for (const n of needs) if (!ids.has(n)) throw new Error(`swarm: step '${id}' needs unknown step '${n}'`)
  const out: string[] = []
  while (out.length < steps.length) {
    const next = steps.find((s) => !out.includes(s.id) && left.get(s.id)!.size === 0)
    if (!next) throw new Error('swarm: the plan has a cycle')
    out.push(next.id)
    for (const needs of left.values()) needs.delete(next.id)
  }
  return out
}

/** How much of a previous answer a step is shown, characters; the rest is cut with a note. */
const HANDOFF_CHARS = 1500

/** The prompt a step is asked: its role's brief, the goal, and what the steps it needs answered. */
export function stepPrompt(plan: SwarmPlan, step: SwarmStep, answers: ReadonlyMap<string, string>): string {
  const role = roleOf(step.role)
  const parts = [role.brief, '', `Goal: ${plan.goal}`]
  for (const id of step.needs) {
    const from = roleOf(id as RoleId)
    const text = (answers.get(id) ?? '').trim()
    const shown = text.length > HANDOFF_CHARS ? `${text.slice(0, HANDOFF_CHARS).trimEnd()}\n[cut at ${HANDOFF_CHARS} characters]` : text
    parts.push('', `From the ${from.title}:`, shown || '(no answer)')
  }
  return parts.join('\n')
}

export type StepState = 'pending' | 'asking' | 'answered' | 'refused' | 'rejected' | 'aborted' | 'failed' | 'stopped'

export interface StepReport {
  readonly id: string
  readonly role: RoleId
  readonly title: string
  readonly skill: string
  readonly state: StepState
  readonly text: string
  readonly ms: number
  readonly tokens: number
  readonly promptHash?: string
  /** The invariants that refused the step, if any (guardrails.ts). */
  readonly failed: readonly Invariant[]
  /** One line on how it ended. */
  readonly note: string
}

export interface SwarmReport {
  readonly goal: string
  readonly agents: number
  readonly steps: readonly StepReport[]
  /** Every step answered. */
  readonly ok: boolean
  readonly stopped: boolean
  /** The audit chain's head after the run. */
  readonly head: string
  readonly ms: number
}

export type SwarmEvent =
  | { readonly kind: 'step'; readonly step: StepReport }
  | { readonly kind: 'piece'; readonly step: string; readonly piece: Piece }
  | { readonly kind: 'end'; readonly report: SwarmReport }

export interface SwarmStatus {
  readonly running: boolean
  readonly goal: string | null
  /** The step being asked now. */
  readonly step: string | null
  readonly done: number
  readonly total: number
  readonly stopped: boolean
  readonly spent: { readonly steps: number; readonly tokens: number }
  readonly audit: number
  readonly head: string
}

export interface SwarmRun {
  readonly plan: SwarmPlan
  /** Calls `fn` with every event as it happens; returns the unsubscribe. */
  follow(fn: (ev: SwarmEvent) => void): () => void
  /** Settles once and never rejects. */
  readonly result: Promise<SwarmReport>
  stop(): void
}

/** A gated ask as the operator tier gives it (operator.ts gatedAsk), with its stop when the host hands one. */
export type AskFn = (skills: readonly string[], prompt: string) => GatedAsk & { stop?(): void }

export interface Swarm {
  readonly roles: readonly Role[]
  readonly quota: Quota
  plan(goal: string, agents?: number): SwarmPlan
  /** Starts a run; throws while one is running, or on a bad goal or count. */
  run(goal: string, agents?: number): SwarmRun
  status(): SwarmStatus
  /** Stops the run, if any; returns what it did. */
  stop(): string
  /** The audit trail of every run this session, oldest first. */
  audit(): readonly AuditEntry[]
  verify(): ReturnType<typeof verifyChain>
}

/**
 * The orchestrator over a gated ask: `endpoint` reads the chosen provider's server each step (null when the provider
 * reaches no network at all), `now` is the clock the audit trail stamps.
 */
export function createSwarm({ ask, endpoint, quota = QUOTA, now = Date.now }: { ask: AskFn; endpoint: () => string | null; quota?: Quota; now?: () => number }): Swarm {
  const chain = new AuditChain()
  let current: { run: SwarmRun; goal: string; step: string | null; done: number; total: number; stopped: boolean; spent: { steps: number; tokens: number }; asking: (GatedAsk & { stop?(): void }) | null } | null = null

  const start = (plan: SwarmPlan): SwarmRun => {
    const followers = new Set<(ev: SwarmEvent) => void>()
    const tell = (ev: SwarmEvent): void => {
      for (const fn of [...followers]) {
        try {
          fn(ev)
        } catch {
          // a follower's own failure does not stop the run
        }
      }
    }
    const state = { run: null as unknown as SwarmRun, goal: plan.goal, step: null as string | null, done: 0, total: plan.steps.length, stopped: false, spent: { steps: 0, tokens: 0 }, asking: null as (GatedAsk & { stop?(): void }) | null }
    const t0 = now()
    const reports: StepReport[] = []
    const answers = new Map<string, string>()
    const record = (kind: AuditEntry['kind'], step: string, role: string, input: string, output: string, promptHash: string | null, failed: readonly Invariant[], note: string): void => {
      chain.append({ at: now(), kind, step, role, inputHash: input ? sha256(input) : '', outputHash: output ? sha256(output) : '', promptHash, failed, note })
    }
    const finish = (r: StepReport): void => {
      reports.push(r)
      tell({ kind: 'step', step: r })
    }

    // Deferred a microtask, so `run` exists before the first step can end the run.
    const result = Promise.resolve().then(async (): Promise<SwarmReport> => {
      record('plan', '', '', plan.goal, '', null, [], `${plan.agents} role${plan.agents === 1 ? '' : 's'}: ${plan.steps.map((s) => s.id).join(' → ')}`)
      let ended = false
      for (const id of order(plan.steps)) {
        const step = plan.steps.find((s) => s.id === id)!
        const role = roleOf(step.role)
        const base = { id: step.id, role: step.role, title: role.title, skill: role.skill, text: '', tokens: 0, failed: [] as readonly Invariant[] }
        const prompt = stepPrompt(plan, step, answers)
        const ts = now()
        // Before the model: the pre-conditions (guardrails.ts admitStep). A refusal ends the run here, recorded.
        const pre = admitStep({ step: step.id, role: role.title, skills: [role.skill], prompt, stopped: state.stopped, endpoint: endpoint(), spent: state.spent, chainOk: chain.verify().ok }, quota)
        if (!pre.admitted) {
          const note = pre.reasons.join('; ')
          record(state.stopped ? 'stop' : 'refusal', step.id, role.title, prompt, '', null, pre.failed, note)
          finish({ ...base, state: state.stopped ? 'stopped' : 'refused', ms: now() - ts, failed: pre.failed, note })
          ended = true
          break
        }
        record('step', step.id, role.title, prompt, '', null, [], `asked as ${role.skill}`)
        state.step = step.id
        let a: GatedAsk & { stop?(): void }
        try {
          a = ask([role.skill], prompt)
        } catch (e) {
          const note = e instanceof Error ? e.message : String(e)
          record('refusal', step.id, role.title, prompt, '', null, [], note)
          finish({ ...base, state: 'failed', ms: now() - ts, note })
          ended = true
          break
        }
        // The gateway's own word (CapabilityTethered): Rejected never asked a model.
        if (a.state === 'Authorized') {
          state.asking = a
          const off = a.follow((p) => tell({ kind: 'piece', step: step.id, piece: p }))
          const r: AskResult = await a.result
          off()
          state.asking = null
          state.spent = { steps: state.spent.steps + 1, tokens: state.spent.tokens + (r.tokens ?? 0) }
          const ms = now() - ts
          if (r.state !== 'Authorized') {
            const v = tetherVerdict(r.state, r.reason)
            record('refusal', step.id, role.title, prompt, r.text, null, v.failed, v.reasons.join('; '))
            finish({ ...base, state: 'aborted', text: r.text, ms, failed: v.failed, note: v.reasons.join('; ') })
            ended = true
            break
          }
          if (r.stopped || state.stopped) {
            record('stop', step.id, role.title, prompt, r.text, null, ['HumanOverrideSupreme'], 'stopped by the operator')
            finish({ ...base, state: 'stopped', text: r.text, ms, failed: ['HumanOverrideSupreme'], note: 'stopped by the operator' })
            ended = true
            break
          }
          if (r.error !== undefined) {
            record('refusal', step.id, role.title, prompt, r.text, null, [], r.error)
            finish({ ...base, state: 'failed', text: r.text, ms, note: r.error })
            ended = true
            break
          }
          if (r.disengaged) {
            // The operator tier's own 14A screen on the way out (gatedAsk): the agent did not engage.
            record('refusal', step.id, role.title, prompt, '', r.promptHash ?? null, ['ConductScreen14A'], 'no reply: the agent did not engage')
            finish({ ...base, state: 'refused', ms, failed: ['ConductScreen14A'], note: 'no reply: the agent did not engage' })
            ended = true
            break
          }
          // After the model: the post-conditions (guardrails.ts admitAnswer), on the whole answer.
          const post = admitAnswer(step.id, r.text, r.tokens ?? 0, { tokens: state.spent.tokens - (r.tokens ?? 0) }, quota)
          if (!post.admitted) {
            record('refusal', step.id, role.title, prompt, r.text, r.promptHash ?? null, post.failed, post.reasons.join('; '))
            finish({ ...base, state: 'refused', ms, tokens: r.tokens ?? 0, failed: post.failed, note: post.reasons.join('; ') })
            ended = true
            break
          }
          answers.set(step.id, r.text)
          const note = `answered in ${(ms / 1000).toFixed(1)} s${r.done === 'length' ? ' (cut at the token limit)' : ''}${r.done === 'scripted' ? ' (scripted: no backend was answering)' : ''}`
          record('answer', step.id, role.title, prompt, r.text, r.promptHash ?? null, [], note)
          finish({ ...base, state: 'answered', text: r.text, ms, tokens: r.tokens ?? 0, ...(r.promptHash !== undefined && { promptHash: r.promptHash }), note })
          state.done++
        } else {
          const r = await a.result
          const v = tetherVerdict(a.state, r.reason)
          record('refusal', step.id, role.title, prompt, '', null, v.failed, v.reasons.join('; '))
          finish({ ...base, state: 'rejected', ms: now() - ts, failed: v.failed, note: v.reasons.join('; ') })
          ended = true
          break
        }
      }
      state.step = null
      const ok = !ended && reports.length === plan.steps.length && reports.every((r) => r.state === 'answered')
      record('end', '', '', '', '', null, [], ok ? `every step answered; ${state.spent.tokens} tokens` : `ended after ${reports.length} of ${plan.steps.length} steps`)
      const report: SwarmReport = Object.freeze({ goal: plan.goal, agents: plan.agents, steps: Object.freeze(reports.slice()), ok, stopped: state.stopped, head: chain.head, ms: now() - t0 })
      if (current?.run === run) current = null
      tell({ kind: 'end', report })
      return report
    })

    const run: SwarmRun = Object.freeze({
      plan,
      follow: (fn: (ev: SwarmEvent) => void) => {
        followers.add(fn)
        return () => { followers.delete(fn) }
      },
      result,
      stop: () => {
        state.stopped = true
        state.asking?.stop?.()
      },
    })
    state.run = run
    current = state
    return run
  }

  return Object.freeze({
    roles: ROLES,
    quota,
    plan: (goal: string, agents?: number) => planSwarm(goal, agents, quota),
    run: (goal: string, agents?: number): SwarmRun => {
      if (current) throw new Error("a swarm is still running: wait for it, or type 'swarm stop'")
      return start(planSwarm(goal, agents, quota))
    },
    status: (): SwarmStatus => current
      ? { running: true, goal: current.goal, step: current.step, done: current.done, total: current.total, stopped: current.stopped, spent: { ...current.spent }, audit: chain.length, head: chain.head }
      : { running: false, goal: null, step: null, done: 0, total: 0, stopped: false, spent: { steps: 0, tokens: 0 }, audit: chain.length, head: chain.head },
    stop: (): string => {
      if (!current) return 'no swarm is running'
      if (current.stopped) return 'already stopping'
      current.run.stop()
      return `stopping at ${current.step ?? 'the next step'}`
    },
    audit: () => chain.entries(),
    verify: () => chain.verify(),
  })
}
