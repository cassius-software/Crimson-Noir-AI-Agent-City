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
import { formatClock } from '../01_Initialize_World/solar.ts'
import { LITE_TIER, TIERS } from '../05_Observe_Environment/governor.ts'
import type { ScriptApi } from '../07_Execute_Actions/operator.ts'
import { classify, TIMES } from './intent.ts'

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
  | { readonly kind: 'refused'; readonly text: string; readonly reason: string; readonly line?: string }

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

/** The seven verbs, in the order the catalogue, the hints and the prompt name them. */
export const VERBS: readonly Verb[] = Object.freeze(['time', 'rain', 'light', 'quality', 'cars', 'crowd', 'sound'])

/** The most `setMode` commands one `cars` action sends: the realm's command queue has 256 slots (simClient.ts). */
export const MAX_CAR_SENDS = 64

type LightKey = keyof typeof LIGHT_RANGE
const LIGHT_KEYS: readonly LightKey[] = Object.freeze(['haze', 'exposure', 'sun', 'fill'])

/** Every word a line may open with and the verb it names; a bare light key names `light` with itself as the value's head. */
const SYNONYMS: ReadonlyMap<string, Verb | 'none'> = new Map<string, Verb | 'none'>([
  ['time', 'time'], ['clock', 'time'], ['hour', 'time'],
  ['rain', 'rain'],
  ['light', 'light'], ['lights', 'light'], ['lighting', 'light'], ['haze', 'light'], ['exposure', 'light'], ['sun', 'light'], ['fill', 'light'],
  ['quality', 'quality'], ['tier', 'quality'], ['graphics', 'quality'],
  ['cars', 'cars'], ['car', 'cars'], ['traffic', 'cars'], ['vehicles', 'cars'],
  ['crowd', 'crowd'], ['people', 'crowd'], ['pedestrians', 'crowd'],
  ['sound', 'sound'], ['audio', 'sound'], ['volume', 'sound'],
  ['none', 'none'], ['nothing', 'none'],
])

/** The hint the operator sees (and the proposer is told) when a verb's value has the wrong shape. */
export const HINTS: Readonly<Record<Verb, string>> = Object.freeze({
  time: 'time takes HH:MM from 00:00 to 23:59, or a name from midnight to night',
  rain: 'rain takes on or off',
  light: 'light takes haze, exposure, sun or fill and a number',
  quality: 'quality takes auto, lite, minimal, low, medium, high or ultra',
  cars: 'cars takes park or drive',
  crowd: 'crowd takes 0 to 100',
  sound: 'sound takes on, off or 0 to 100',
})

/** The refusal when the line stands in prose, and when two lines ask for different things. */
export const NOT_ALONE = 'the ACTION line must stand on a line of its own'
export const MORE_THAN_ONE = 'more than one action in the answer'

/**
 * One physical line that is an ACTION line: markdown decoration, a quote mark or a list dash before it, `city action`
 * or `action`, a separator, the body, then trailing decoration or a full stop. The body is group 1.
 */
const CANDIDATE = /^\s*[`*_>"\-\s]*(?:city\s+)?action\s*[:\-–—=]\s*[`*_"]*\s*(.*?)\s*[`*_".]*\s*$/i
/** The head of an ACTION line anywhere in the text: present with no whole line matching, the line is glued to prose. */
const HEAD = /\baction\s*[:\-–—=]/i

/** The typed reading of an action's value, from which the canonical line, the sentence and the facade call all follow. */
type Decoded =
  | { readonly verb: 'time'; readonly hours: number }
  | { readonly verb: 'rain'; readonly on: boolean }
  | { readonly verb: 'light'; readonly key: LightKey; readonly value: number }
  | { readonly verb: 'quality'; readonly tier: number | 'auto' }
  | { readonly verb: 'cars'; readonly park: boolean }
  | { readonly verb: 'crowd'; readonly percent: number }
  | { readonly verb: 'sound'; readonly level: 'on' | 'off' | number }

type ReadValue = { readonly d: Decoded; readonly note?: string } | { readonly reason: string }

/** A number at most two decimals long, as the sentence and the done line print it (`1.5`, `0.25`, `4`). */
const fmt = (n: number): string => String(Math.round(n * 100) / 100)
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)$/
const PERCENT = /^[+-]?(?:\d+\.?\d*|\.\d+)\s*%?$/
const noteOf = (from: number, to: number): { note?: string } => (from === to ? {} : { note: `clamped from ${fmt(from)}` })

/**
 * Hours from a value: `HH[:MM]`, `H[:MM] am|pm` or one of the ten named times; null for anything else. Never wraps.
 * A clock reading lands a hair past its minute (a few microseconds), so `formatClock`, which floors, reads the very
 * minute written back off the clock: the sentence, the done line and the HUD agree.
 */
function readTime(value: string): number | null {
  const s = value.toLowerCase().replace(/\s+/g, ' ').trim()
  const named = TIMES.find(([, name]) => name === s)
  if (named) return named[0]
  const m = /^(\d{1,2})(?::(\d{2}))?(?: ?(am|pm))?$/.exec(s)
  if (!m) return null
  const h = Number(m[1])
  const min = m[2] === undefined ? 0 : Number(m[2])
  if (min > 59) return null
  const minutes = (min + 1e-6) / 60
  if (m[3]) return h < 1 || h > 12 ? null : (h % 12) + (m[3] === 'pm' ? 12 : 0) + minutes
  return h > 23 ? null : h + minutes
}

/** The quality tier a value names: `auto`, `lite`, a tier's label, or an integer clamped into Lite…Ultra. */
function readQuality(value: string): { tier: number | 'auto'; note?: string } | null {
  const s = value.toLowerCase().trim()
  if (s === 'auto') return { tier: 'auto' }
  if (s === 'lite') return { tier: LITE_TIER }
  const byLabel = TIERS.findIndex((t) => t.label.toLowerCase() === s)
  if (byLabel >= 0) return { tier: byLabel }
  if (!/^[+-]?\d+$/.test(s)) return null
  const n = Number(s)
  const tier = clamp(n, LITE_TIER, TIERS.length - 1)
  return { tier, ...noteOf(n, tier) }
}

/** A percentage 0…100 from a number (`%` tolerated), rounded and clamped, with the clamp noted; null when not a number. */
function readPercent(value: string): { percent: number; note?: string } | null {
  const s = value.trim()
  if (!PERCENT.test(s)) return null
  const n = Math.round(Number(s.replace(/\s*%$/, '')))
  const percent = clamp(n, 0, 100)
  return { percent, ...noteOf(n, percent) }
}

const CROWD_WORDS: ReadonlyMap<string, number> = new Map([['none', 0], ['fewer', 50], ['half', 50], ['more', 100], ['full', 100]])

/** Reads a verb's value into its typed form, or the verb's hint. The canonical value reads back to the same form. */
function readValue(verb: Verb, value: string): ReadValue {
  const s = value.toLowerCase().replace(/\s+/g, ' ').trim()
  switch (verb) {
    case 'time': {
      const hours = readTime(s)
      return hours === null ? { reason: HINTS.time } : { d: { verb, hours } }
    }
    case 'rain':
      return s === 'on' || s === 'off' ? { d: { verb, on: s === 'on' } } : { reason: HINTS.rain }
    case 'light': {
      const m = /^(haze|exposure|sun|fill) (\S+)$/.exec(s)
      if (!m || !DECIMAL.test(m[2])) return { reason: HINTS.light }
      const key = m[1] as LightKey
      const n = Number(m[2])
      if (!Number.isFinite(n)) return { reason: HINTS.light }
      const [lo, hi] = LIGHT_RANGE[key]
      const clamped = clamp(n, lo, hi)
      return { d: { verb, key, value: Math.round(clamped * 100) / 100 }, ...noteOf(n, clamped) }
    }
    case 'quality': {
      const q = readQuality(s)
      return q === null ? { reason: HINTS.quality } : { d: { verb, tier: q.tier }, ...(q.note && { note: q.note }) }
    }
    case 'cars':
      if (s === 'park' || s === 'parked' || s === 'stop') return { d: { verb, park: true } }
      if (s === 'drive' || s === 'ai' || s === 'go' || s === 'release') return { d: { verb, park: false } }
      return { reason: HINTS.cars }
    case 'crowd': {
      const word = CROWD_WORDS.get(s)
      if (word !== undefined) return { d: { verb, percent: word } }
      const p = readPercent(s)
      return p === null ? { reason: HINTS.crowd } : { d: { verb, percent: p.percent }, ...(p.note && { note: p.note }) }
    }
    case 'sound': {
      if (s === 'on') return { d: { verb, level: 'on' } }
      if (s === 'off' || s === 'mute') return { d: { verb, level: 'off' } }
      const p = readPercent(s)
      return p === null ? { reason: HINTS.sound } : { d: { verb, level: p.percent }, ...(p.note && { note: p.note }) }
    }
  }
}

/** The quality label of a tier: `Lite` below the table, else the table's own. */
const tierLabel = (tier: number): string => (tier < 0 ? 'Lite' : TIERS[tier].label)

/** The value as the catalogue spells it, from the typed reading. */
function valueOf(d: Decoded): string {
  switch (d.verb) {
    case 'time': return formatClock(d.hours)
    case 'rain': return d.on ? 'on' : 'off'
    case 'light': return `${d.key} ${fmt(d.value)}`
    case 'quality': return d.tier === 'auto' ? 'auto' : tierLabel(d.tier).toLowerCase()
    case 'cars': return d.park ? 'park' : 'drive'
    case 'crowd': return String(d.percent)
    case 'sound': return typeof d.level === 'number' ? String(d.level) : d.level
  }
}

const encode = (d: Decoded): Action => {
  const value = valueOf(d)
  return Object.freeze({ verb: d.verb, value, canonical: `${d.verb} ${value}` })
}

/** The typed reading of a parsed action; a hand-made action that is not in the catalogue is an error, never a call. */
function decode(action: Action): Decoded {
  const r = VERBS.includes(action.verb) ? readValue(action.verb, action.value) : { reason: `no city action called '${String(action.verb)}'` }
  if ('reason' in r) throw new Error(`not a catalogue action: ${action.canonical} (${r.reason})`)
  return r.d
}

/** The model's own verb word, as the refusal names it: letters, digits and a few joiners only, cut short. */
const quoteVerb = (head: string): string => head.replace(/[^\p{L}\p{N}_.-]/gu, '').slice(0, 24)

type ReadBody = { readonly kind: 'none' } | { readonly kind: 'action'; readonly action: Action; readonly note?: string } | { readonly kind: 'refused'; readonly reason: string }

/** Reads one line's body: the verb (a synonym allowed), then its value. */
function readBody(body: string): ReadBody {
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body.trim())
  const head = (m?.[1] ?? '').toLowerCase()
  const rest = (m?.[2] ?? '').trim()
  const verb = SYNONYMS.get(head)
  if (verb === undefined) return { kind: 'refused', reason: `no city action called '${quoteVerb(head)}' (${VERBS.join(', ')})` }
  if (verb === 'none') return { kind: 'none' }
  const value = (LIGHT_KEYS as readonly string[]).includes(head) ? `${head} ${rest}`.trim() : rest
  const r = readValue(verb, value)
  if ('reason' in r) return { kind: 'refused', reason: r.reason }
  return { kind: 'action', action: encode(r.d), ...(r.note && { note: r.note }) }
}

/**
 * Reads an answer: the stripped text and, at most, one proposal or one refusal with its reason. Pure, never throws.
 * The rules, in order: no ACTION line and no head anywhere is nothing proposed; a head with no whole line of its own
 * is refused; every line is read to its canonical form, identical ones merge and two different ones are refused;
 * `none` (or `nothing`) proposes nothing; an unknown verb or a value of the wrong shape is refused with the verb's
 * hint; a dial out of its range is clamped and noted; the text is the answer with every ACTION line removed and its
 * trailing white space trimmed.
 */
export function parseAction(text: string): Parsed {
  const raw = typeof text === 'string' ? text : String(text ?? '')
  const kept: string[] = []
  const candidates: { line: string; body: string }[] = []
  for (const line of raw.split('\n')) {
    const m = CANDIDATE.exec(line)
    if (m) candidates.push({ line: line.trim(), body: m[1] })
    else kept.push(line)
  }
  const stripped = kept.join('\n').trimEnd()
  if (!candidates.length) {
    return HEAD.test(raw) ? { kind: 'refused', text: stripped, reason: NOT_ALONE } : { kind: 'none', text: stripped }
  }
  const seen = new Set<string>()
  let first: { action: Action; note?: string; line: string } | null = null
  for (const c of candidates) {
    const r = readBody(c.body)
    if (r.kind === 'refused') return { kind: 'refused', text: stripped, reason: r.reason, line: c.line }
    seen.add(r.kind === 'none' ? 'none' : r.action.canonical)
    if (seen.size > 1) return { kind: 'refused', text: stripped, reason: MORE_THAN_ONE, line: c.line }
    if (r.kind === 'action' && first === null) first = { action: r.action, line: c.line, ...(r.note && { note: r.note }) }
  }
  if (first === null) return { kind: 'none', text: stripped }
  return { kind: 'proposed', text: stripped, action: first.action, line: first.line, ...(first.note && { note: first.note }) }
}

/** The sentence the operator is shown for an action, in the city's own words (`set the clock to 22:00`). */
export function sentence(action: Action): string {
  const d = decode(action)
  switch (d.verb) {
    case 'time': return `set the clock to ${formatClock(d.hours)}`
    case 'rain': return `turn rain mode ${d.on ? 'on' : 'off'}`
    case 'light': return `set the light ${d.key} to ${fmt(d.value)}`
    case 'quality': return d.tier === 'auto' ? 'let the quality govern itself' : `set the quality to ${tierLabel(d.tier)}`
    case 'cars': return d.park ? 'park every car' : 'let every car drive'
    case 'crowd': return `set the crowd to ${d.percent}%`
    case 'sound': return d.level === 'on' ? 'turn the sound on' : d.level === 'off' ? 'turn the sound off' : `set the volume to ${d.level}%`
  }
}

/** Runs one allowed action over the facade and the city knobs (one call per verb) and returns the done line. */
export function perform(action: Action, sim: ScriptApi, city: CityKnobs | undefined): string {
  const d = decode(action)
  switch (d.verb) {
    case 'time':
      sim.clock.set(d.hours)
      return `the clock is set to ${formatClock(sim.clock.hours())}`
    case 'rain':
      if (!city) throw new Error('rain mode is not reachable from here')
      city.rain(d.on)
      return `rain mode is ${d.on ? 'on' : 'off'}`
    case 'light': {
      const key = `light.${d.key}`
      sim.shaders.set(key, d.value)
      return `the light ${d.key} is ${fmt(sim.shaders.uniforms()[key])}`
    }
    case 'quality': {
      sim.quality.set(d.tier)
      const state = sim.quality.state()
      return state.auto ? 'the quality governs itself' : `the quality is ${state.label}`
    }
    case 'cars': {
      // One setMode per car that is not being driven (the facade throws for the driven one), MAX_CAR_SENDS at most.
      const mode = d.park ? 'parked' : 'ai'
      const count = sim.vehicles.count()
      let sent = 0
      let left = 0
      for (let i = 0; i < count; i++) {
        if (sim.vehicles.state(i).mode === 'player') continue
        if (sent < MAX_CAR_SENDS) { sim.vehicles.setMode(i, mode); sent++ } else left++
      }
      const n = left ? `${sent} of ${sent + left}` : String(sent)
      const noun = sent === 1 && !left ? 'car' : 'cars'
      return d.park ? `${n} ${noun} parked` : `${n} ${noun} handed to their drivers`
    }
    case 'crowd':
      sim.crowd.cull({ density: d.percent / 100 })
      return `the crowd is at ${d.percent}% until the quality tier next changes`
    case 'sound':
      if (!city) throw new Error('the sound is not reachable from here')
      city.audio(d.level)
      return d.level === 'on' ? 'the sound is on' : d.level === 'off' ? 'the sound is off' : `the volume is ${d.level}%`
  }
}

/** The catalogue as `act list` prints it: a verb, its values and what it does, one row each. */
const CATALOGUE: readonly { readonly verb: Verb; readonly values: string; readonly summary: string }[] = Object.freeze([
  { verb: 'time', values: 'HH:MM, or midnight to night', summary: 'set the clock' },
  { verb: 'rain', values: 'on, off', summary: 'turn rain mode on or off' },
  { verb: 'light', values: 'haze, exposure, sun or fill, a number', summary: 'set a light dial' },
  { verb: 'quality', values: 'auto, lite, minimal to ultra', summary: 'pin or free the quality tier' },
  { verb: 'cars', values: 'park, drive', summary: 'park every car, or let them drive' },
  { verb: 'crowd', values: '0 to 100', summary: 'set the crowd density' },
  { verb: 'sound', values: 'on, off, 0 to 100', summary: 'the sound and its volume' },
])

/** The catalogue as `act list` prints it: one row per verb (the verb padded to 10, the values to 36). */
export function catalogueLines(): readonly string[] {
  return Object.freeze(CATALOGUE.map((r) => `  ${r.verb.padEnd(10)}${r.values.padEnd(36)} ${r.summary}`))
}

/** The words of a prompt that ask for rain mode outright (the goal planner knows no weather). */
const RAIN_WORD = /\brain(?: mode)?\s+(on|off)\b/i

/**
 * The scripted provider's line for a prompt that plainly asks for one action, or null: the first control the goal
 * planner's classifier (06_Make_Decisions/intent.ts) reads with a value among time, quality, audio, crowd and cars,
 * rendered as the catalogue's line; failing those, a rain word. Deterministic, so the browser smoke drives the whole
 * path with no model.
 */
export function scriptedAction(prompt: string): string | null {
  for (const c of classify(prompt)) {
    const v = c.value
    if (v === undefined) continue
    switch (c.control) {
      case 'time':
        if (typeof v === 'number') return `ACTION: time ${formatClock(v)}`
        break
      case 'quality':
        if (v === 'auto') return 'ACTION: quality auto'
        if (typeof v === 'number' && Number.isInteger(v) && v >= LITE_TIER && v < TIERS.length) return `ACTION: quality ${tierLabel(v).toLowerCase()}`
        break
      case 'audio':
        if (v === 'on' || v === 'off') return `ACTION: sound ${v}`
        if (typeof v === 'number' && Number.isFinite(v)) return `ACTION: sound ${clamp(Math.round(v), 0, 100)}`
        break
      case 'crowd':
        if (v === 'fewer') return 'ACTION: crowd 50'
        if (v === 'none') return 'ACTION: crowd 0'
        if (v === 'more') return 'ACTION: crowd 100'
        break
      case 'cars':
        if (v === 'fewer' || v === 'none') return 'ACTION: cars park'
        if (v === 'more') return 'ACTION: cars drive'
        break
      default:
        break
    }
  }
  const m = RAIN_WORD.exec(prompt)
  return m ? `ACTION: rain ${m[1].toLowerCase()}` : null
}
