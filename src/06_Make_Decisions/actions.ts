// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the bounded catalogue of city actions an agent may propose at the end of an answer
 * (one `ACTION: <verb> <value>` line: the clock, rain mode, the light dials, the quality tier, the cars, the crowd,
 * the sound), the rules that teach a model the line, the parser that reads it (pure, total, never the model's
 * words), the sentence the operator is shown and the one call per verb that runs it over the script facade once the
 * operator has allowed it. Nothing here runs anything by itself: 07_Execute_Actions/acts.ts proposes, waits for the
 * OK and runs `perform` under the proposer's lease. The scripted provider's deterministic line lives here too, so the
 * browser smoke drives the whole path with no model.
 * What breaks if it is removed? An answer's ACTION line is text again: nothing an agent says can change the city.
 */
import type { ScriptApi } from '../07_Execute_Actions/operator.ts'

export type Verb = 'time' | 'rain' | 'light' | 'quality' | 'cars' | 'crowd' | 'sound'

/** One catalogue action as parsed: the verb, its value as the catalogue spells it, and the canonical line body. */
export interface Action {
  readonly verb: Verb
  readonly value: string
  /** `time 22:00`, `rain on`, `light haze 1.5`, `quality lite`, `cars park`, `crowd 50`, `sound off`. */
  readonly canonical: string
}

/** What `parseAction` makes of an answer: nothing proposed, one action proposed, or a line refused with its reason. */
export type Parsed =
  | { readonly kind: 'none'; readonly text: string }
  | { readonly kind: 'proposed'; readonly text: string; readonly action: Action; readonly line: string; readonly note?: string }
  | { readonly kind: 'refused'; readonly text: string; readonly reason: string }

/** The two engine knobs that are not script facade leaves: rain mode and the sound (handed in by the host as senses). */
export interface CityKnobs {
  rain(on: boolean): void
  audio(level: 'on' | 'off' | number): void
}

/** The four lines appended to the base reality (09_Cognition/localCompute.ts BASE_REALITY) that teach the line. */
export const ACTION_RULES: readonly string[] = Object.freeze([
  'City actions: to ask the operator for one change to the city, write your answer, then the action alone on the last line, exactly like this example:',
  'ACTION: time 20:00',
  'The actions: time HH:MM (or midnight, dawn, morning, noon, afternoon, golden hour, sunset, dusk, evening, night); rain on or off; light haze, exposure, sun or fill and a number (1 is the city as authored); quality auto, lite, minimal, low, medium, high or ultra; cars park or drive; crowd 0 to 100; sound on, off or 0 to 100.',
  'One ACTION line at most, and none when nothing needs changing (ACTION: none also means none). The operator sees it and allows or refuses it before anything happens, so never say that it happened.',
])

/** The light dials' ranges, mirrored from 01_Initialize_World/world.ts (pinned there by actions.test.ts). */
export const LIGHT_RANGE = Object.freeze({
  haze: Object.freeze([0, 4] as const),
  exposure: Object.freeze([0.25, 3] as const),
  sun: Object.freeze([0, 3] as const),
  fill: Object.freeze([0, 3] as const),
})

// SKELETON: builder A replaces every function below with the contract's behaviour (scratchpad prc/contract.md, sections 1, 2, 5).

/** Reads an answer: the stripped text and, at most, one proposal or one refusal with its reason. Pure, never throws. */
export function parseAction(text: string): Parsed {
  return { kind: 'none', text }
}

/** The sentence the operator is shown for an action, in the city's own words (`set the clock to 22:00`). */
export function sentence(action: Action): string {
  return action.canonical
}

/** Runs one allowed action over the facade and the city knobs (one call per verb) and returns the done line. */
export function perform(action: Action, sim: ScriptApi, city: CityKnobs | undefined): string {
  void sim
  void city
  throw new Error(`not built: ${action.canonical}`)
}

/** The catalogue as `act list` prints it: one row per verb. */
export function catalogueLines(): readonly string[] {
  return []
}

/** The scripted provider's line for a prompt that plainly asks for one action (06_Make_Decisions/intent.ts classify), or null. */
export function scriptedAction(prompt: string): string | null {
  void prompt
  return null
}
