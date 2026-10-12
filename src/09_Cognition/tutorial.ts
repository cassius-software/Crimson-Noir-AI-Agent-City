// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is Wren's quiet way of showing a brand-new visitor the city without ever calling it a
 * lesson: for the first five minutes after they walk in, Wren watches what they do (look around, walk, go to The
 * Spire, talk to someone, press M, turn the clock) and, when they have done nothing for half a minute, says one thing
 * in the chat, in the shape of the Five Whys: first why they might want something ("Ever wonder what's behind you?"),
 * then how. One line at a time, a long pause between lines, never the same line twice, nothing for what they have
 * already found out for themselves, and nothing at all once they are busy. Every line is a plain sentence a
 * five-year-old would follow; the words "tutorial", "lesson" and "step" never appear. This is pure data and timing with
 * an injected clock (the React hook, 07_Execute_Actions/onboarding/useMentor.ts, feeds it the page's readings and
 * events); it reads the simulation and never writes to it, so a watched visit steps exactly like an unwatched one.
 * What breaks if it is removed? A first visitor who does not know to drag, walk or press a key stands still in a
 * beautiful city and leaves.
 */

/** The things worth finding out, in the order Wren offers them (each only if not yet done, and only where it exists). */
export type Discovery = 'look' | 'spire' | 'talk' | 'mode' | 'clock'
export const DISCOVERIES: readonly Discovery[] = Object.freeze(['look', 'spire', 'talk', 'mode', 'clock'])

/** How patient Wren is, ms. */
export const WATCH = Object.freeze({
  /** Nothing done for this long and Wren says something. */
  quietMs: 30_000,
  /** The least time between two of Wren's lines, so a visitor who is simply slow is not nagged. */
  cooldownMs: 45_000,
  /** How long after walking in Wren keeps watching. */
  watchMs: 300_000,
  /** How far a visitor has to be from the landmark to have been there, metres. */
  landmarkMetres: 90,
  /** Looking around: this much turn of the head counts, radians (about 20 degrees). */
  lookRadians: 0.35,
  /** Walking: this much ground counts, metres. */
  walkMetres: 3,
  /** The clock turned by hand: this much jump in one reading (the day's own drift is far slower), hours. */
  clockHours: 0.4,
} as const)

/** How the visitor drives the page: a keyboard and mouse, a controller, or a touch screen (the words change with it). */
export type InputFamily = 'keyboard' | 'pad' | 'touch'

/** What Wren knows about this city and visitor before the watch starts. */
export interface MentorOptions {
  /** The city's landmark and where it stands, or null (then there is nothing to walk to). */
  landmark: { name: string; x: number; z: number } | null
  /** Whether the city has people walking about (the procedural city), or is the quiet generated metropolis. */
  people: boolean
  family: InputFamily
  /** The visitor's name, or '' (Wren then says nothing in its place). */
  name?: string
  /** What is already found out (a reload), skipped. */
  done?: readonly Discovery[]
  quietMs?: number
  cooldownMs?: number
  watchMs?: number
}

/** One of Wren's lines: which discovery it leads to, the words, and the words a model's rewording must keep. */
export interface Nudge {
  readonly id: number
  readonly discovery: Discovery
  readonly text: string
  readonly keep: readonly string[]
}

/** A reading of the page, as the hook takes it from the engine's snapshot a few times a second. */
export interface Reading {
  x: number
  z: number
  /** The head's yaw, radians. */
  yaw: number
  /** Metres walked and driven so far. */
  travelled: number
  /** Whether falling code is on (the M key). */
  mode: boolean
  /** The city's clock, hours. */
  hour: number
}

/** An event the page reports outright (keys, taps, a chat opened), beyond what a reading shows. */
export type Event = 'look' | 'move' | 'talk' | 'goal' | 'mode' | 'clock' | 'input'

/** What the visitor does to turn the head, in their own device's words. */
const LOOK_HOW: Readonly<Record<InputFamily, string>> = Object.freeze({
  keyboard: 'Hold the mouse button down and drag',
  pad: 'Push the right stick',
  touch: 'Drag one finger across the screen',
})
const WALK_HOW: Readonly<Record<InputFamily, string>> = Object.freeze({
  keyboard: 'Walk with W A S D or the arrow keys',
  pad: 'Walk with the left stick',
  touch: 'Walk with the stick in the corner',
})

/** The one word a rewording must keep for each line, so a tap or key named is never lost. */
const KEEP: Readonly<Record<InputFamily, string>> = Object.freeze({ keyboard: 'drag', pad: 'stick', touch: 'drag' })

/**
 * Whether a discovery exists for this visitor: no landmark means nothing to walk to; a touch screen has no console,
 * no M key and no clock keys.
 */
export function available(d: Discovery, o: Pick<MentorOptions, 'landmark' | 'people' | 'family'>): boolean {
  switch (d) {
    case 'look': return true
    case 'spire': return o.landmark !== null
    case 'talk': return true
    case 'mode': return o.family !== 'touch'
    case 'clock': return o.family !== 'touch'
  }
}

/** Wren's line for a discovery: the why first, the how after. Plain words; no lesson named. */
export function lineFor(d: Discovery, o: Pick<MentorOptions, 'landmark' | 'people' | 'family' | 'name'>): { text: string; keep: readonly string[] } {
  const name = o.name?.trim() ? `, ${o.name.trim()}` : ''
  switch (d) {
    case 'look':
      return { text: `Beautiful city, isn’t it${name}? Ever wonder what’s behind you? ${LOOK_HOW[o.family]} and the whole view turns with you.`, keep: [KEEP[o.family]] }
    case 'spire': {
      const l = o.landmark?.name ?? 'the tallest tower'
      return { text: `See the tallest needle on the skyline? That’s ${l}. Want to know how big it really is? ${WALK_HOW[o.family]} and go stand right under it.`, keep: [l] }
    }
    case 'talk':
      if (o.people && o.family !== 'touch') {
        return { text: 'Everyone walking past knows a trade. Curious what one of them would say? Press ~ to open the console and type recruit Rust; when they arrive, type operator unlock, then ask Rust: hello.', keep: ['recruit Rust', 'ask Rust'] }
      }
      return { text: `Want the city to do something for you${name}? Tap my name down by the map and tell me a goal in your own words, like “make it night”, and I’ll sort it out.`, keep: ['goal'] }
    case 'mode':
      return { text: 'Wondering what this city is made of underneath? Press M once and every wall turns into falling code. Press M again to bring it back.', keep: ['press M'] }
    case 'clock':
      return { text: 'Want to see this place at night? Press ] a few times and the hours roll forward; [ rolls them back. Sunset here is worth waiting for.', keep: [']'] }
  }
}

/**
 * Wren's watch over the first minutes: told when the visitor walks in (`start`), fed readings (`read`) and events
 * (`note`), and asked a few times a second (`tick`) whether now is a moment to say something. Everything is timed
 * from the clock values it is given, never from Date.now, so a test can run five minutes in a microsecond.
 */
export class Mentor {
  readonly options: Readonly<MentorOptions>
  readonly #done = new Set<Discovery>()
  #started = Number.NaN
  #lastActive = Number.NaN
  #lastSaid = Number.NaN
  #last: Reading | null = null
  /** The yaw where the head was when the watch began (looking around is a turn from there). */
  #yaw0 = Number.NaN
  #travelled0 = Number.NaN
  #said = 0
  #ended = false

  constructor(options: MentorOptions) {
    this.options = Object.freeze({ ...options })
    for (const d of options.done ?? []) this.#done.add(d)
    for (const d of DISCOVERIES) if (!available(d, options)) this.#done.add(d)
  }

  /** The visitor walked in: the quiet timer starts now. */
  start(now: number): void {
    this.#started = now
    this.#lastActive = now
  }

  get started(): boolean {
    return Number.isFinite(this.#started)
  }

  /** The watch is over: five minutes passed, or everything is found. */
  get over(): boolean {
    return this.#ended
  }

  /** What is found out so far. */
  get discovered(): ReadonlySet<Discovery> {
    return this.#done
  }

  /** What is still to find, in Wren's order. */
  get pending(): readonly Discovery[] {
    return DISCOVERIES.filter((d) => !this.#done.has(d))
  }

  /** How many lines Wren has said. */
  get said(): number {
    return this.#said
  }

  /** The visitor did something: the quiet timer restarts; a discovery, if the event names one, is marked. */
  note(e: Event, now: number): void {
    if (!this.started) return
    this.#lastActive = now
    if (e === 'look' || e === 'mode' || e === 'clock') this.#done.add(e)
    if (e === 'talk' || e === 'goal') this.#done.add('talk')
  }

  /** A reading of the page: a change from the last one is activity, and some changes are discoveries. */
  read(r: Reading, now: number): void {
    if (!this.started) return
    const last = this.#last
    this.#last = { ...r }
    if (!last) {
      this.#yaw0 = r.yaw
      this.#travelled0 = r.travelled
      return
    }
    let active = false
    if (Number.isFinite(r.yaw) && Number.isFinite(this.#yaw0) && Math.abs(turn(r.yaw - this.#yaw0)) >= WATCH.lookRadians) { this.#done.add('look'); active = true }
    if (Number.isFinite(r.travelled) && Number.isFinite(this.#travelled0) && r.travelled - this.#travelled0 >= WATCH.walkMetres) { active = true; this.#travelled0 = r.travelled }
    if (r.mode && !last.mode) { this.#done.add('mode'); active = true }
    if (Number.isFinite(r.hour) && Number.isFinite(last.hour) && Math.abs(turn24(r.hour - last.hour)) >= WATCH.clockHours) { this.#done.add('clock'); active = true }
    const l = this.options.landmark
    if (l && Number.isFinite(r.x + r.z) && Math.hypot(r.x - l.x, r.z - l.z) <= WATCH.landmarkMetres) { this.#done.add('spire'); active = true }
    if (active) this.#lastActive = now
  }

  /**
   * Whether this is a moment for Wren to speak: the watch is on, the visitor has been quiet for quietMs, the last line
   * was cooldownMs ago or more, and something is left to find. Returns the line (marked as said) or null.
   */
  tick(now: number): Nudge | null {
    if (!this.started || this.#ended) return null
    const o = this.options
    if (now - this.#started > (o.watchMs ?? WATCH.watchMs)) { this.#ended = true; return null }
    const next = this.pending[0]
    if (next === undefined) { this.#ended = true; return null }
    if (now - this.#lastActive < (o.quietMs ?? WATCH.quietMs)) return null
    if (Number.isFinite(this.#lastSaid) && now - this.#lastSaid < (o.cooldownMs ?? WATCH.cooldownMs)) return null
    this.#lastSaid = now
    this.#said++
    // Said once: the next quiet spell offers the next thing, not this one again.
    this.#done.add(next)
    const { text, keep } = lineFor(next, o)
    return Object.freeze({ id: this.#said, discovery: next, text, keep })
  }
}

/** A turn wrapped to (−π, π]. */
function turn(rad: number): number {
  const t = ((rad + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
  return t <= -Math.PI ? t + 2 * Math.PI : t
}
/** An hour difference wrapped to (−12, 12]. */
function turn24(h: number): number {
  const t = ((h + 12) % 24 + 24) % 24 - 12
  return t <= -12 ? t + 24 : t
}
