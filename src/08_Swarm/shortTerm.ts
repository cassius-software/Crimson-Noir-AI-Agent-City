// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the swarm's short-term memory and its sense of the here and now: a small fixed ring
 * per pedestrian holding the last few things that happened between them and the player or another agent (who, what
 * was said or done, where they stood, when on the city's clock), oldest dropped first, and the one plain sentence that
 * says what the agent has around them this moment ("Standing near The Spire in Lakefront Metro, looking at a dark red
 * car, with two people close by"). Both go into the model's system prompt under one heading (09_Cognition
 * localCompute.ts systemPrompt) within a fixed character budget, so an answer knows where it is said and what just
 * happened without the prompt growing. This is the host-side counterpart of the swarm's long-term ledger
 * (memory.ts), which keeps whole recruitments on disk, hash-chained: this one lives in memory for the visit, holds
 * three moments, and is thrown away with the page. The agents' own sandboxed code (the stack machine behind the WASM
 * air gap) has no clock, no world and no memory, so this lives beside it in TypeScript and never changes a simulation
 * step: nothing here is read by the physics realm or the crowd kernel.
 * What breaks if it is removed? An agent answers every question as if it were the first, from nowhere in particular.
 */

/** Moments each pedestrian keeps: the last three interactions, oldest dropped first. */
export const SHORT_TERM = 3
/** Characters of `what` kept per moment (a line of what was said, or what was done). */
export const MOMENT_CHARS = 160
/** Characters the whole context (surroundings and moments) may take in a system prompt: about 150 tokens. */
export const CONTEXT_BUDGET = 600

/** One moment between an agent and someone: who it was with, what was said or done, where they stood, when. */
export interface Interaction {
  /** Who the moment was with: 'the player', or 'agent 1234'. */
  readonly who: string
  /** What was said or done, in one line (clipped to MOMENT_CHARS). */
  readonly what: string
  /** Where the agent stood, in the city's own words (a street, a region), or '' when unknown. */
  readonly where: string
  /** When, in simulation seconds (the engine's own clock), for ordering. */
  readonly at: number
  /** When, on the city's clock, as the agent would say it ('17:02'). */
  readonly clock: string
}

/** What an agent has around them this moment, as the host measures it; every part optional. */
export interface SurroundingsView {
  /** Where they stand: a region, a street corner ('Lakefront Metro', 'Aurel St & 3rd Ave'). */
  place?: string
  /** The nearest landmark and how far it is, metres. */
  landmark?: { name: string; metres: number } | null
  /** The nearest car and how far it is, metres, with its paint in a word. */
  car?: { colour: string; metres: number } | null
  /** People within a few metres, the player not counted. */
  people?: number
  /** Whether the player is right there with them. */
  withPlayer?: boolean
  /** The city's clock ('17:02'). */
  clock?: string
  /** Day or night, as the agent sees it. */
  daylight?: 'day' | 'dusk' | 'night'
}

/** What one agent brings to a prompt: where they are and what just happened to them. */
export interface AgentContext {
  readonly agent: number
  /** The surroundings sentence, or null when nothing is known. */
  readonly surroundings: string | null
  /** The last moments, oldest first. */
  readonly recent: readonly Interaction[]
}

/** Clips a line to one line of at most `max` characters. */
export function clipLine(text: string, max: number = MOMENT_CHARS): string {
  const line = String(text).replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * The short-term memory: a ring of SHORT_TERM moments per pedestrian. `remember` drops the oldest once the ring is full;
 * `recent` is oldest first; `forget` clears one person (they left) or everyone.
 */
export class ShortTermMemory {
  readonly #rings = new Map<number, Interaction[]>()
  readonly size: number

  constructor(size: number = SHORT_TERM) {
    if (!Number.isInteger(size) || size < 1) throw new RangeError('a short-term memory holds at least one moment')
    this.size = size
  }

  remember(agent: number, moment: Omit<Interaction, 'what'> & { what: string }): void {
    if (!Number.isInteger(agent) || agent < 0) return
    const ring = this.#rings.get(agent) ?? []
    ring.push(Object.freeze({ ...moment, what: clipLine(moment.what), where: clipLine(moment.where, 80), who: clipLine(moment.who, 40) }))
    while (ring.length > this.size) ring.shift()
    this.#rings.set(agent, ring)
  }

  /** The moments kept for `agent`, oldest first (a copy). */
  recent(agent: number): readonly Interaction[] {
    return [...(this.#rings.get(agent) ?? [])]
  }

  forget(agent?: number): void {
    if (agent === undefined) this.#rings.clear()
    else this.#rings.delete(agent)
  }

  /** How many people have a moment kept. */
  get people(): number {
    return this.#rings.size
  }
}

/** The fleet's body colours (07_Execute_Actions/carRig.ts PAINT), each in a word an agent would use. */
const PAINT_WORDS: readonly (readonly [number, string])[] = Object.freeze([
  [0xf2f2f0, 'white'], [0x111214, 'black'], [0xa9adb3, 'silver'], [0x5c6168, 'grey'], [0x1d2f55, 'navy blue'],
  [0x7a1a1f, 'dark red'], [0x2d3e33, 'dark green'], [0xc9c1ad, 'beige'], [0x2a4f7a, 'steel blue'], [0x3a3a3c, 'charcoal'],
])

/** A car's paint (0xRRGGBB) in one word: the nearest of the fleet's colours. */
export function paintWord(rgb: number): string {
  if (!Number.isFinite(rgb)) return 'grey'
  const r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255
  let best = 'grey', d = Infinity
  for (const [hex, word] of PAINT_WORDS) {
    const dd = ((hex >> 16) & 255) - r, dg = ((hex >> 8) & 255) - g, db = (hex & 255) - b
    const dist = dd * dd + dg * dg + db * db
    if (dist < d) { d = dist; best = word }
  }
  return best
}

/** A distance as an agent would say it. */
export function nearWord(metres: number): string {
  if (!Number.isFinite(metres) || metres < 0) return 'somewhere near'
  if (metres < 4) return 'right here'
  if (metres < 15) return 'a few steps away'
  if (metres < 60) return 'just down the street'
  if (metres < 250) return 'a short walk away'
  return `about ${Math.round(metres / 50) * 50} m away`
}

/**
 * One plain sentence of what an agent has around them, from what the host measured: the place, the landmark, the
 * nearest car, the people near, the time. Parts that are not known are left out; nothing known gives null.
 */
export function describeSurroundings(v: SurroundingsView): string | null {
  const parts: string[] = []
  const place = v.place ? clipLine(v.place, 80) : ''
  if (v.landmark && Number.isFinite(v.landmark.metres)) {
    const l = v.landmark
    parts.push(l.metres < 120 ? `near ${l.name}` : `with ${l.name} ${nearWord(l.metres)}`)
  }
  if (place) parts.push(parts.length ? `in ${place}` : `at ${place}`)
  if (!parts.length && v.clock === undefined && !v.car && v.people === undefined && v.withPlayer === undefined) return null
  let s = parts.length ? `Standing ${parts.join(' ')}` : 'Standing in the city'
  if (v.clock) s += ` at ${v.clock}${v.daylight === 'night' ? ', after dark' : v.daylight === 'dusk' ? ', at dusk' : ''}`
  const seen: string[] = []
  if (v.car && Number.isFinite(v.car.metres)) seen.push(`looking at a ${v.car.colour} car ${nearWord(v.car.metres)}`)
  if (v.withPlayer) seen.push('with the player beside them')
  if (v.people !== undefined && v.people > 0) seen.push(`with ${v.people === 1 ? 'one other person' : `${Math.min(v.people, 99)} people`} close by`)
  if (seen.length) s += `, ${seen.join(', ')}`
  return `${s}.`
}

/** A moment as one prompt line: when, where, who, what. */
export function momentLine(m: Interaction): string {
  const where = m.where ? ` ${m.where}` : ''
  return `${m.clock}${where}: ${m.who} ${m.what}`
}

/**
 * The prompt lines for one agent's context under one heading, within `budget` characters: the surroundings first,
 * then the moments newest to oldest until the budget is spent (the newest moment is always kept if any is), so what
 * matters most survives a tight budget. Empty when nothing is known.
 */
export function contextLines(ctx: AgentContext, budget: number = CONTEXT_BUDGET): string[] {
  const out: string[] = []
  let spent = 0
  const take = (line: string): boolean => {
    if (spent + line.length + 1 > budget && out.length > 1) return false
    out.push(clipLine(line, Math.max(16, budget - spent - 1)))
    spent += out[out.length - 1].length + 1
    return true
  }
  const head = `Agent ${ctx.agent}, right now:`
  if (ctx.surroundings === null && ctx.recent.length === 0) return out
  out.push(head)
  spent += head.length + 1
  // The surroundings take at most half the budget, so a long sentence never crowds the moments out.
  if (ctx.surroundings) take(`- ${clipLine(ctx.surroundings, Math.max(40, Math.floor(budget / 2)))}`)
  if (ctx.recent.length) {
    const sub = 'Just before this, oldest first:'
    spent += sub.length + 1
    const kept: string[] = []
    for (let i = ctx.recent.length - 1; i >= 0; i--) {
      const line = `- ${momentLine(ctx.recent[i])}`
      if (spent + line.length + 1 > budget && kept.length > 0) break
      kept.unshift(clipLine(line, Math.max(16, budget - spent - 1)))
      spent += kept[0].length + 1
    }
    out.push(sub, ...kept)
  }
  return out
}

/**
 * The prompt section for the bound people's contexts: only the people bound, only those with something to say, each
 * under its own heading and within its own budget.
 */
export function contextSection(agents: readonly number[], contexts: readonly AgentContext[] | undefined, budget: number = CONTEXT_BUDGET): string[] {
  if (!contexts?.length) return []
  return contexts.filter((c) => agents.includes(c.agent)).flatMap((c) => contextLines(c, budget))
}
