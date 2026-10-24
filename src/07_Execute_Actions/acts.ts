// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the operator tier's keeper of one proposed city action at a time: after a console
 * ask settles, it reads the answer's ACTION line (06_Make_Decisions/actions.ts), submits the proposal to the capability
 * gateway as a task of its own bound to the people who answered, shows it to the operator and waits for their OK; on
 * allow it runs the action once under that lease, on refuse, `ask stop`, `operator lock`, a lost tether or a closed
 * gateway it ends it, and every proposal, decision and end goes into a hash-chained trail (`act log verify`) and into
 * what the proposer remembers. Nothing runs before the OK, nothing runs twice, and nothing waits past a lock.
 * What breaks if it is removed? The console and the card have nothing to allow or refuse, and an agent's line is text.
 */
import type { ActsBridge, AskResult, Awareness, GatedAsk, GateLease, GateTether, PendingAct, RunState, ScriptApi, SkillGate } from './operator.ts'
import type { CityKnobs } from '../06_Make_Decisions/actions.ts'
import { AUDIT_GENESIS } from '../02_Define_The_Rules/guardrails.ts'

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
}

/** The keeper as the tier uses it: the bridge surface plus the two calls only operator.ts makes. */
export interface Acts extends ActsBridge {
  /** After a console ask settles as answered: reads the answer and proposes, refuses or does nothing; the text is the answer with the line stripped. */
  onAnswer(a: GatedAsk, r: AskResult, skills: readonly string[]): Promise<{ text: string; act?: AskResult['act'] }>
  /** `ask stop` or `operator lock` ends a waiting proposal; the proposal it withdrew, or null when none waited. */
  withdraw(why: 'ask stop' | 'operator lock'): PendingAct | null
}

// SKELETON: builder B replaces this with the contract's state machine (scratchpad prc/contract.md, sections 3 and 6).
export function createActs(deps: ActsDeps): Acts {
  void deps
  const none = (): never => { throw new Error('nothing is waiting for your OK') }
  return Object.freeze({
    pending: () => null,
    follow: () => () => {},
    allow: none,
    refuse: none,
    log: () => [],
    verify: () => ({ ok: true as const, length: 0, head: AUDIT_GENESIS }),
    list: () => [],
    onAnswer: async (_a: GatedAsk, r: AskResult) => ({ text: r.text }),
    withdraw: () => null,
  })
}
