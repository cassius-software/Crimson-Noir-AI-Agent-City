// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the guardrail layer every step of the swarm orchestrator (08_Swarm/orchestrator.ts)
 * passes before a model is asked and again before its answer is used: six named invariants, each a deterministic check
 * over plain text and settings, and a hash-chained audit trail of every step, refusal and stop, so the console can
 * show what the swarm did and prove the record was not edited after the fact. The invariants are:
 * - HumanOverrideSupreme: a run the operator has stopped admits no further step, whatever else holds.
 * - CapabilityTethered: a step runs only while someone tethered to the operator has the skill its role needs; the
 *   capability gateway (08_Swarm/taskRouter.ts) is that check, and its verdict is recorded here.
 * - ConductScreen14A: the prompt a role is given, and the answer it gives, pass the 14A screen (conduct.ts).
 * - LoopbackOnly: the model endpoint the step would reach is on this machine (airgap.ts loopbackServer), or there is
 *   none at all (the scripted provider, or a model running in this page).
 * - BudgetWithinQuota: steps, prompt and answer length and tokens stay within QUOTA.
 * - ProvenanceChained: the audit chain so far verifies, so no step runs on a record that has been tampered with.
 * What this is and is not: every check here is a rule over text, settings and counts, applied the same way every
 * time (no clock, no randomness, no I/O), and the tests hold each one; it is not a proof about a model, and it does not
 * look inside one (no model and no weights ship with the product, so there are no activations to inspect or clamp).
 * The screen is a lexicon and is described as such in conduct.ts; the model's own judgement under the conduct core
 * is the second layer. The chain is SHA-256 over each entry's canonical body followed by the hash before it (the same
 * construction as the OS weight ledger, 10_Network/ledger.ts).
 * What breaks if it is removed? The orchestrator asks a model for every step with nothing between the goal and the
 * model but the gateway, and leaves no record a reader can check.
 */
import { loopbackServer } from './airgap.ts'
import { screen } from './conduct.ts'
import { canonical, sha256 } from './integrity.ts'

export const INVARIANTS = Object.freeze([
  'HumanOverrideSupreme', 'CapabilityTethered', 'ConductScreen14A', 'LoopbackOnly', 'BudgetWithinQuota', 'ProvenanceChained',
] as const)
export type Invariant = (typeof INVARIANTS)[number]

/** Each invariant in one plain sentence, as `swarm guardrails` prints it. */
export const INVARIANT_TEXT: Readonly<Record<Invariant, string>> = Object.freeze({
  HumanOverrideSupreme: 'a run the operator has stopped admits no further step, whatever else holds',
  CapabilityTethered: "a step runs only while someone tethered to the operator has its role's skill (the capability gateway decides)",
  ConductScreen14A: 'the prompt a role is given and the answer it gives both pass the 14A screen (a lexicon; the model under the conduct core is the second layer)',
  LoopbackOnly: 'the model endpoint a step reaches is on this machine, or there is none (the scripted provider, or a model running in this page)',
  BudgetWithinQuota: 'steps, prompt length, answer length and tokens stay within the quota',
  ProvenanceChained: 'the hash-chained audit trail verifies before every step; a tampered record stops the run',
})

/** The budget one run may spend, frozen. */
export const QUOTA = Object.freeze({
  /** Roles in one run, at most (one step each). */
  agents: 5,
  /** Steps in one run, at most. */
  steps: 8,
  /** A goal, characters, at most. */
  goalChars: 600,
  /** A step's whole prompt (the brief, the goal, what came before), characters, at most. */
  promptChars: 6000,
  /** A step's answer, characters, at most. */
  answerChars: 12_000,
  /** Output tokens over one run, at most. */
  tokens: 24_576,
} as const)
/** A quota as the orchestrator takes it: QUOTA, or a smaller one for a test or a host. */
export type Quota = { readonly [K in keyof typeof QUOTA]: number }

/** What a step is about to do, as the invariants see it. */
export interface StepIntent {
  readonly step: string
  readonly role: string
  readonly skills: readonly string[]
  readonly prompt: string
  /** The operator has stopped the run. */
  readonly stopped: boolean
  /** The model endpoint the step would reach (the chosen provider's server), or null when there is none. */
  readonly endpoint: string | null
  /** What the run has spent before this step. */
  readonly spent: { readonly steps: number; readonly tokens: number }
  /** The audit chain so far verifies. */
  readonly chainOk: boolean
}

/** An invariant's verdict: admitted, or which failed and why, in the order they are listed in INVARIANTS. */
export interface Verdict {
  readonly admitted: boolean
  readonly failed: readonly Invariant[]
  readonly reasons: readonly string[]
}

const verdict = (failed: [Invariant, string][]): Verdict =>
  Object.freeze({ admitted: failed.length === 0, failed: Object.freeze(failed.map(([i]) => i)), reasons: Object.freeze(failed.map(([, r]) => r)) })

/** The pre-conditions of a step: everything but the gateway's own check, which `tetherVerdict` records once it has decided. */
export function admitStep(intent: StepIntent, quota: Quota = QUOTA): Verdict {
  const failed: [Invariant, string][] = []
  if (intent.stopped) failed.push(['HumanOverrideSupreme', 'the operator stopped the run'])
  if (!intent.skills.length) failed.push(['CapabilityTethered', `step '${intent.step}' names no skill`])
  const s = screen(intent.prompt)
  if (!s.admissible) failed.push(['ConductScreen14A', `the prompt for '${intent.step}' failed the 14A screen (${s.category})`])
  if (intent.endpoint !== null && loopbackServer(intent.endpoint) === null) failed.push(['LoopbackOnly', `${intent.endpoint} is not on this machine`])
  if (intent.spent.steps >= quota.steps) failed.push(['BudgetWithinQuota', `${quota.steps} steps already run`])
  else if (intent.prompt.length > quota.promptChars) failed.push(['BudgetWithinQuota', `the prompt for '${intent.step}' is ${intent.prompt.length} characters (at most ${quota.promptChars})`])
  else if (intent.spent.tokens >= quota.tokens) failed.push(['BudgetWithinQuota', `${intent.spent.tokens} tokens already spent (at most ${quota.tokens})`])
  if (!intent.chainOk) failed.push(['ProvenanceChained', 'the audit chain does not verify'])
  return verdict(failed)
}

/** The post-conditions of an answer: it passes the screen and fits the quota. */
export function admitAnswer(step: string, text: string, tokens: number, spent: { readonly tokens: number }, quota: Quota = QUOTA): Verdict {
  const failed: [Invariant, string][] = []
  const s = screen(text)
  if (!s.admissible) failed.push(['ConductScreen14A', `the answer of '${step}' failed the 14A screen (${s.category})`])
  if (text.length > quota.answerChars) failed.push(['BudgetWithinQuota', `the answer of '${step}' is ${text.length} characters (at most ${quota.answerChars})`])
  else if (spent.tokens + Math.max(0, tokens) > quota.tokens) failed.push(['BudgetWithinQuota', `${spent.tokens + tokens} tokens spent (at most ${quota.tokens})`])
  return verdict(failed)
}

/** The gateway's decision on a step, as CapabilityTethered: Authorized admits; anything else does not. */
export function tetherVerdict(state: 'Authorized' | 'Rejected' | 'Aborted', reason = ''): Verdict {
  if (state === 'Authorized') return verdict([])
  return verdict([['CapabilityTethered', state === 'Rejected' ? `Rejected (Insufficient Capabilities): ${reason}` : `Aborted (Spatial Tether Lost): ${reason}`]])
}

// ---------------------------------------------------------------------------------------------------
// The audit trail

export type AuditKind = 'plan' | 'step' | 'answer' | 'refusal' | 'stop' | 'end'

/** What one entry records; its hash covers exactly these fields, in canonical form. */
export interface AuditBody {
  readonly seq: number
  /** ms since the epoch, as the orchestrator's clock gave it. */
  readonly at: number
  readonly kind: AuditKind
  readonly step: string
  readonly role: string
  /** SHA-256 of what went in (a goal, a prompt), or the empty digest's stand-in '' when nothing did. */
  readonly inputHash: string
  /** SHA-256 of what came out (an answer), or ''. */
  readonly outputHash: string
  /** The SHA-256 of the exact system prompt the model was given (Answer.promptHash), when a model answered. */
  readonly promptHash: string | null
  readonly failed: readonly Invariant[]
  readonly note: string
}

export interface AuditEntry extends AuditBody {
  readonly prev: string
  readonly hash: string
}

/** The hash before the first entry. */
export const AUDIT_GENESIS = '0'.repeat(64)

const BODY_KEYS = ['seq', 'at', 'kind', 'step', 'role', 'inputHash', 'outputHash', 'promptHash', 'failed', 'note'] as const

/** The body alone, in key order, so an entry hashes the same wherever it was built. */
function bodyOf(e: AuditBody): AuditBody {
  const b: Record<string, unknown> = {}
  for (const k of BODY_KEYS) b[k] = k === 'failed' ? [...e.failed] : e[k]
  return b as unknown as AuditBody
}

/** An entry's hash: SHA-256 of its canonical body followed by the hash before it. */
export const entryHash = (body: AuditBody, prev: string): string => sha256(canonical(bodyOf(body)) + prev)

const KINDS: ReadonlySet<string> = new Set<AuditKind>(['plan', 'step', 'answer', 'refusal', 'stop', 'end'])
const DIGEST = /^[0-9a-f]{64}$/

/**
 * Checks a chain from GENESIS: every entry links to the one before, is numbered in order, and hashes to what it says.
 * Returns where it first fails and why, so the console can point at the entry.
 */
export function verifyChain(entries: readonly AuditEntry[]): { readonly ok: true; readonly length: number; readonly head: string } | { readonly ok: false; readonly at: number; readonly why: string } {
  let prev = AUDIT_GENESIS
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (typeof e !== 'object' || e === null) return { ok: false, at: i, why: 'not an entry' }
    if (e.seq !== i) return { ok: false, at: i, why: `numbered ${String(e.seq)}, expected ${i}` }
    if (!Number.isFinite(e.at)) return { ok: false, at: i, why: 'no time' }
    if (!KINDS.has(e.kind)) return { ok: false, at: i, why: `unknown kind '${String(e.kind)}'` }
    if (!Array.isArray(e.failed) || !e.failed.every((f) => (INVARIANTS as readonly string[]).includes(f))) return { ok: false, at: i, why: 'names an unknown invariant' }
    if (e.prev !== prev) return { ok: false, at: i, why: 'does not link to the entry before it' }
    if (!DIGEST.test(e.hash) || e.hash !== entryHash(e, prev)) return { ok: false, at: i, why: 'its hash is not the hash of its body' }
    prev = e.hash
  }
  return { ok: true, length: entries.length, head: prev }
}

/** The chain as the orchestrator keeps it: append-only, frozen entries, the head always at hand. */
export class AuditChain {
  readonly #entries: AuditEntry[] = []

  get length(): number {
    return this.#entries.length
  }

  get head(): string {
    return this.#entries.length ? this.#entries[this.#entries.length - 1].hash : AUDIT_GENESIS
  }

  entries(): readonly AuditEntry[] {
    return this.#entries.slice()
  }

  /** Verifies the whole chain as kept (an entry replaced from outside would show here). */
  verify(): ReturnType<typeof verifyChain> {
    return verifyChain(this.#entries)
  }

  append(e: Omit<AuditBody, 'seq'>): AuditEntry {
    const prev = this.head
    const body: AuditBody = {
      seq: this.#entries.length, at: e.at, kind: e.kind, step: e.step, role: e.role, inputHash: e.inputHash, outputHash: e.outputHash,
      promptHash: e.promptHash, failed: Object.freeze([...e.failed]), note: e.note,
    }
    const entry: AuditEntry = Object.freeze({ ...body, prev, hash: entryHash(body, prev) })
    this.#entries.push(entry)
    return entry
  }
}
Object.freeze(AuditChain)
Object.freeze(AuditChain.prototype)
