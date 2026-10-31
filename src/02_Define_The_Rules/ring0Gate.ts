// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the Ring-0 action gate: the one verdict every effect a model's words can have on the
 * city passes before any state changes, ranked under the four laws (laws.ts LAWS: the Zeroth Law and the three). A
 * model's words reach the city by one road only: a model is asked through the operator tier (07_Execute_Actions/
 * operator.ts gatedAsk, whichever provider answers: the Claude gateway, a model server on this machine, the model file
 * kept in this page, or the script; the swarm orchestrator asks the same way, one step at a time), its answer may end
 * with one ACTION line from a fixed catalogue (06_Make_Decisions/actions.ts), the line is proposed to the operator
 * (07_Execute_Actions/acts.ts) and, once a person allows it, runs once under the proposer's lease. This gate stands at
 * the three moments on that road, and ring0Gate.test.ts pins at the source that there is no other road:
 * - `admitAsk`, before a model is asked: the page's outbound primitives are held to this machine (Contained: what the
 *   host vouches, airgap.ts airgapInstalled), the model is on this machine or there is none (LoopbackOnly), and the
 *   operator tier is unlocked (OperatorUnlocked). The 14A screen of the prompt is the Zeroth Law's too, and gatedAsk
 *   applies it itself, in the form the conduct law requires: an inadmissible prompt is not refused, it is not engaged
 *   with (conduct.ts DISENGAGED), so nothing streams and nothing is remembered.
 * - `admitProposal`, when an answer's ACTION line is read: the line passes the screen (Conduct14A) and is one of the
 *   catalogue (Catalogued: a line the catalogue could not read is refused in the catalogue's own words, under the
 *   Zeroth Law), the tier is unlocked, and no other proposal waits (OneAtATime).
 * - `admitRun`, the moment before an allowed action runs, inside the lease's `use`: the page is contained, the realm
 *   stands (RealmStanding: the Ring-0 audit of ring0.ts has not panicked), the verb reaches no leaf that moves a body
 *   or weakens the kernel (KineticFree: the First-Law table below, which the test proves exact by running every verb
 *   over a recording facade), the tier is unlocked and a person allowed it (PersonAllowed: at the console, on the
 *   card or through the host; the gateway never allows), the proposer is still tethered under the same recruitment
 *   (LeaseHeld, ProposerBound), and the hash-chained trail verifies (ChainVerified).
 * - `admitWords`, for a model's words shown as the city's own (the onboarding's reworded lines): the screen alone. The
 *   onboarding voice asks a model for that rewording outside `admitAsk` (it changes nothing, and the provider's own
 *   loopback gate holds its address); its words pass here before they are spoken.
 * What this is and is not: every check is a rule over plain values (no clock, no randomness, no I/O), applied the same
 * way every time, and the tests hold each one; the verdict names the highest-ranked law that refused and every check
 * that failed. It is not a proof about a model, and it does not look inside one. The three laws' own rulings on vehicle
 * commands (laws.ts adjudicate) and the audit after every physics tick (ring0.ts) are the kernel's; this gate is what
 * stands between an answer and the kernel. The exports are frozen, so nothing running in the page can monkey-patch
 * the gate away.
 * What breaks if it is removed? An answer's line would reach the city on the operator's OK alone, with no check that
 * the page is contained, the realm stands, the proposer is still here or the trail is whole, and no law named when
 * one of them fails.
 */
import { loopbackServer } from './airgap.ts'
import { screen } from './conduct.ts'
import type { Invariant } from './guardrails.ts'
import { LAW_NAMES, type GateLaw } from './laws.ts'

export type CheckName =
  | 'Contained' | 'LoopbackOnly' | 'Conduct14A' | 'Catalogued'
  | 'RealmStanding' | 'KineticFree'
  | 'OperatorUnlocked' | 'PersonAllowed'
  | 'LeaseHeld' | 'ProposerBound' | 'ChainVerified' | 'OneAtATime'

export interface Check { readonly law: GateLaw; readonly name: CheckName; readonly text: string }

/** Every check, in rank order (the law first, then the order within it); a verdict's refusals come in this order. */
export const CHECKS: readonly Check[] = Object.freeze([
  Object.freeze({ law: 0, name: 'Contained', text: "the page's outbound primitives are held to this machine (airgap.ts), as the host vouches" }),
  Object.freeze({ law: 0, name: 'LoopbackOnly', text: 'the model the words come from is on this machine, or there is none (the script, a model in this page)' }),
  Object.freeze({ law: 0, name: 'Conduct14A', text: 'the words pass the 14A screen (conduct.ts); a prompt that fails it is not engaged with at all' }),
  Object.freeze({ law: 0, name: 'Catalogued', text: 'the effect is one line of the fixed catalogue (actions.ts): nothing else an answer says can change the city' }),
  Object.freeze({ law: 1, name: 'RealmStanding', text: 'the Ring-0 audit (ring0.ts) has not panicked: a halted realm takes no action' }),
  Object.freeze({ law: 1, name: 'KineticFree', text: 'the verb reaches no leaf that moves a body, drives a car or weakens the kernel: a car is only parked, or handed back to a driver the Bouncer vets' }),
  Object.freeze({ law: 2, name: 'OperatorUnlocked', text: 'the operator tier is unlocked' }),
  Object.freeze({ law: 2, name: 'PersonAllowed', text: 'a person allowed it, at the console, on the card or through the host; the gateway never allows' }),
  Object.freeze({ law: 3, name: 'LeaseHeld', text: "the proposer is still tethered to the operator (the capability gateway's lease holds)" }),
  Object.freeze({ law: 3, name: 'ProposerBound', text: 'the gate binds the proposer, under the same recruitment, and nobody else' }),
  Object.freeze({ law: 3, name: 'ChainVerified', text: 'the hash-chained trail verifies before anything runs' }),
  Object.freeze({ law: 3, name: 'OneAtATime', text: 'no other proposal waits: one effect at a time' }),
])

/** The law each check stands under. */
export const CHECK_LAW: Readonly<Record<CheckName, GateLaw>> = Object.freeze(Object.fromEntries(CHECKS.map((c) => [c.name, c.law])) as Record<CheckName, GateLaw>)

/**
 * The guardrail invariant (guardrails.ts) a check is recorded under in a hash-chained trail, or null where the six
 * have no word for it (the catalogue, the realm's standing and the First-Law table are the gate's own).
 */
export const CHECK_INVARIANT: Readonly<Record<CheckName, Invariant | null>> = Object.freeze({
  Contained: 'LoopbackOnly', LoopbackOnly: 'LoopbackOnly', Conduct14A: 'ConductScreen14A', Catalogued: null,
  RealmStanding: null, KineticFree: null,
  OperatorUnlocked: 'HumanOverrideSupreme', PersonAllowed: 'HumanOverrideSupreme',
  LeaseHeld: 'CapabilityTethered', ProposerBound: 'CapabilityTethered', ChainVerified: 'ProvenanceChained', OneAtATime: 'HumanOverrideSupreme',
})

/** One check that failed: its law, its name and why, in one plain clause. */
export interface Refusal { readonly law: GateLaw; readonly check: CheckName; readonly reason: string }

/** The gate's verdict: admitted, or the highest-ranked law that refused and every check that failed, in CHECKS order. */
export interface GateVerdict {
  readonly admitted: boolean
  readonly law: GateLaw | null
  readonly failed: readonly Refusal[]
}

/** The fixed clause of each check that has one (the others name what they found). */
export const REASONS = Object.freeze({
  Contained: "this page's outbound primitives are not held to this machine (the host has not vouched for the air gap)",
  OperatorUnlocked: 'the operator tier is locked',
  PersonAllowed: 'nobody allowed it',
  LeaseHeld: 'the proposer is no longer tethered to the operator',
  ProposerBound: 'the gate binds someone other than the proposer',
  ChainVerified: 'the audit chain does not verify',
  OneAtATime: 'a proposal is waiting: act ok or act no first',
  Catalogued: 'not a line of the catalogue (the catalogue gave no reason)',
} as const)

/** `rank` orders refusals as CHECKS does, whatever order the checks were made in. */
const RANK: Readonly<Record<CheckName, number>> = Object.freeze(Object.fromEntries(CHECKS.map((c, i) => [c.name, i])) as Record<CheckName, number>)

const verdictOf = (failed: Refusal[]): GateVerdict => {
  const sorted = failed.slice().sort((a, b) => RANK[a.check] - RANK[b.check]).map((r) => Object.freeze({ ...r }))
  return Object.freeze({ admitted: sorted.length === 0, law: sorted.length ? sorted[0].law : null, failed: Object.freeze(sorted) })
}
const fail = (check: CheckName, reason: string): Refusal => ({ law: CHECK_LAW[check], check, reason })

/** A verdict's first refusal as one sentence, the law named the way the kernel names it ('Second Law: the operator tier is locked'); '' when admitted. */
export function sentence(v: GateVerdict): string {
  const first = v.failed[0]
  return first ? `${LAW_NAMES[first.law]}: ${first.reason}` : ''
}

/** The invariants a verdict's refusals are recorded under, each once, in CHECKS order. */
export function invariantsOf(v: GateVerdict): Invariant[] {
  const out: Invariant[] = []
  for (const r of v.failed) {
    const i = CHECK_INVARIANT[r.check]
    if (i !== null && !out.includes(i)) out.push(i)
  }
  return out
}

// ---------------------------------------------------------------------------------------------------
// The First-Law table

/**
 * The facade leaves (07_Execute_Actions/operator.ts ScriptApi, dotted) and the two city knobs (`city.rain`,
 * `city.audio`) each catalogue verb reaches when it runs (actions.ts perform): the gate's First-Law table.
 * ring0Gate.test.ts proves it exact by running every verb over a recording facade, so a verb added to the catalogue
 * is refused here under the First Law until its leaves are declared and shown kinetic-free.
 */
export const ACTION_LEAVES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  time: Object.freeze(['clock.set', 'clock.hours']),
  rain: Object.freeze(['city.rain']),
  light: Object.freeze(['shaders.set', 'shaders.uniforms']),
  quality: Object.freeze(['quality.set', 'quality.state']),
  cars: Object.freeze(['vehicles.count', 'vehicles.state', 'vehicles.setMode']),
  crowd: Object.freeze(['crowd.cull']),
  sound: Object.freeze(['city.audio']),
})

/**
 * The leaves a model's word may ever reach: readings, the clock, a light dial, the quality tier, a car parked or handed
 * back to its vetted driver, the crowd's density, rain mode and the sound. None moves a body, drives a car, changes the
 * physics or touches the kernel. With KINETIC below it classifies every leaf of the facade (the test pins that), so a
 * leaf added to the facade is kinetic until it is declared free.
 */
export const KINETIC_FREE: readonly string[] = Object.freeze([
  'clock.hours', 'clock.set', 'quality.state', 'quality.set', 'avatar.position', 'vehicles.count', 'vehicles.state', 'vehicles.setMode', 'vehicles.nearest',
  'physics.tune', 'shaders.uniforms', 'shaders.set', 'crowd.stats', 'crowd.cull', 'crowd.positions', 'kernel.stats', 'snapshot', 'city.rain', 'city.audio',
])

/**
 * The leaves no verb may ever reach: they move the avatar, drive or move a car, change the physics or blind the kernel.
 * A script the operator types may reach the first five (through the Bouncer and the engine's clamps); an answer never.
 */
export const KINETIC: readonly string[] = Object.freeze([
  'avatar.teleport', 'avatar.walk', 'avatar.interact', 'vehicles.intent', 'vehicles.recover', 'physics.set', 'kernel.blindSensing',
])

/** The leaves of `verb` outside the kinetic-free set (every leaf when the verb is not in the table). */
export function kineticLeaves(verb: string): readonly string[] {
  const leaves = Object.prototype.hasOwnProperty.call(ACTION_LEAVES, verb) ? ACTION_LEAVES[verb] : null
  return leaves === null ? Object.freeze(['(not in the First-Law table)']) : leaves.filter((l) => !KINETIC_FREE.includes(l))
}

// ---------------------------------------------------------------------------------------------------
// The three moments

/** What the host vouches: true, false, or null when it has said nothing (which admits nothing: the gate fails closed). */
export type Vouched = boolean | null

/** Before a model is asked (operator.ts askThrough: the console's ask and every swarm step alike). */
export interface AskIntent {
  readonly contained: Vouched
  /** The model's server, or null when there is none (the scripted provider, or a model running in this page). */
  readonly endpoint: string | null
  readonly unlocked: boolean
}

/** An answer's ACTION line, as it is read (acts.ts onAnswer), before it is shown to the operator. */
export interface ProposalIntent {
  readonly contained: Vouched
  /** The line as the model wrote it. */
  readonly line: string
  /** The catalogue read it (actions.ts parseAction gave an action), or the catalogue's own reason why it could not. */
  readonly catalogued: true | { readonly reason: string }
  readonly unlocked: boolean
  /** No other proposal waits. */
  readonly vacant: boolean
}

/** An allowed action, the moment before it runs (acts.ts, inside the lease's use). */
export interface RunIntent {
  readonly contained: Vouched
  readonly verb: string
  /** The Ring-0 audit's panic reason (telemetry.ts AuditStats.panic), or null while the realm stands. */
  readonly panic: string | null
  readonly unlocked: boolean
  /** Who allowed it, or null. */
  readonly allowedBy: 'console' | 'card' | 'host' | null
  /** The lease holds in the newest copy of the swarm. */
  readonly held: boolean
  /** The lease binds the proposer, under the recruitment the answer had, and nobody else. */
  readonly proposer: boolean
  readonly chainOk: boolean
}

const contained = (v: Vouched): Refusal | null => (v === true ? null : fail('Contained', REASONS.Contained))
const unlocked = (v: boolean): Refusal | null => (v ? null : fail('OperatorUnlocked', REASONS.OperatorUnlocked))
const conduct = (text: string): Refusal | null => {
  const s = screen(text)
  return s.admissible ? null : fail('Conduct14A', `the line failed the 14A screen (${s.category})`)
}
const refusals = (...rs: (Refusal | null)[]): Refusal[] => rs.filter((r): r is Refusal => r !== null)

/** Before a model is asked: contained, on this machine or none, unlocked. Pure. */
export function admitAsk(i: AskIntent): GateVerdict {
  return verdictOf(refusals(
    contained(i.contained),
    i.endpoint === null || loopbackServer(i.endpoint) !== null ? null : fail('LoopbackOnly', `${i.endpoint} is not on this machine`),
    unlocked(i.unlocked),
  ))
}

/** An ACTION line read: contained, screened, of the catalogue, unlocked, one at a time. Pure. */
export function admitProposal(i: ProposalIntent): GateVerdict {
  return verdictOf(refusals(
    contained(i.contained),
    conduct(i.line),
    i.catalogued === true ? null : fail('Catalogued', i.catalogued.reason || REASONS.Catalogued),
    unlocked(i.unlocked),
    i.vacant ? null : fail('OneAtATime', REASONS.OneAtATime),
  ))
}

/** An allowed action about to run: every check of the table above but the two of the line, which was read already. Pure. */
export function admitRun(i: RunIntent): GateVerdict {
  const kinetic = kineticLeaves(i.verb)
  return verdictOf(refusals(
    contained(i.contained),
    i.panic === null ? null : fail('RealmStanding', `the realm has halted: ${i.panic}`),
    kinetic.length === 0 ? null : fail('KineticFree', `'${i.verb}' reaches ${kinetic.join(', ')}`),
    unlocked(i.unlocked),
    i.allowedBy === 'console' || i.allowedBy === 'card' || i.allowedBy === 'host' ? null : fail('PersonAllowed', REASONS.PersonAllowed),
    i.held ? null : fail('LeaseHeld', REASONS.LeaseHeld),
    i.proposer ? null : fail('ProposerBound', REASONS.ProposerBound),
    i.chainOk ? null : fail('ChainVerified', REASONS.ChainVerified),
  ))
}

/** A model's words about to be shown as the city's own: the screen alone. Pure. */
export function admitWords(text: string): GateVerdict {
  return verdictOf(refusals(conduct(text)))
}

Object.freeze(admitAsk)
Object.freeze(admitProposal)
Object.freeze(admitRun)
Object.freeze(admitWords)
Object.freeze(sentence)
Object.freeze(invariantsOf)
Object.freeze(kineticLeaves)
