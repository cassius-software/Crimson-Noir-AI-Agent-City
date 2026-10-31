// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the feature inspector and its steering: a dictionary of named, monosemantic
 * FEATURES of the city's behaviour, each a documented deterministic function of the readings the city already
 * produces (the SIPOC snapshot: the crowd's yielding and waiting, the kernel's law interventions, the Ring-0 audit,
 * the frame), giving an activation in [0, 1]; a sparsifier (a JumpReLU threshold: an activation at or below its
 * threshold reads 0) and a Top-K selection over the activation vector (one Float32Array, structure of arrays); and
 * STEERING: per-feature biases and clamps the operator sets, which (a) become fixed lines in the system prompt every
 * model provider renders for the people answering (prompt-level steering of the agents' cognition, the same path the
 * swarm's learned lines take, 08_Swarm/memory.ts learnedLines) and (b) map to the bounded tuning knobs the operator
 * tier already has (physics.car.*, shaders.*). Honestly: this is NOT a sparse autoencoder over a model's hidden
 * activations. No provider the page talks to (a model file run in the page, a server on this machine, the network
 * provider) exposes its residual stream, so there is nothing to train a dictionary on and nothing to clamp inside the
 * model; every feature here is hand-written over the city's own counters, and every steering line is fixed text.
 * Pure and deterministic: no clock, no randomness, no I/O; the same readings give the same vector on every machine.
 * What breaks if it is removed? The console cannot name what the city is doing in one vector, and the operator has no
 * bounded way to lean the agents' prompts or the tuning knobs in a named direction.
 */
import type { KernelStats, SipocSnapshot } from '../05_Observe_Environment/telemetry.ts'

/** The readings every feature is a function of: the snapshot's counters, flattened, every number finite. */
export interface FeatureReadings {
  readonly population: number; readonly waiting: number; readonly crossing: number; readonly yielding: number; readonly nudges: number
  readonly vehicles: number; readonly law1: number; readonly law2: number; readonly law3: number; readonly sensorFlips: number; readonly shielded: boolean
  readonly auditTicks: number; readonly perimeterBreaches: number; readonly velocityCaps: number; readonly closest: number; readonly panic: string | null
  readonly fps: number; readonly frameMs: number; readonly rain: boolean; readonly rendering: boolean; readonly sessionSeconds: number; readonly working: number
}

/** A finite number, or 0 for anything else (absent, NaN, an infinity, the wrong type). */
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
/** A finite number or an infinity (the audit's `closest` is Infinity while no gap has been measured), or 0. */
const gap = (v: unknown): number => (typeof v === 'number' && !Number.isNaN(v) ? v : 0)
/** A value in [0, 1]: NaN reads 0 and anything outside is clamped, so a lane is never out of range. */
const unit = (x: number): number => (Number.isNaN(x) ? 0 : x < 0 ? 0 : x > 1 ? 1 : x)
/** A number for the console: NaN and the infinities read as '-'. */
const fixed = (v: number, digits: number): string => (Number.isFinite(v) ? v.toFixed(digits) : '-')

/** The readings of one snapshot. Tolerant: an absent or malformed field reads 0, false, or null (panic). */
export function readingsOf(s: SipocSnapshot): FeatureReadings {
  const p: Partial<SipocSnapshot['process']> | undefined = s.process
  const k: Partial<KernelStats> | undefined = s.kernel
  const a: Partial<KernelStats['audit']> | undefined = k?.audit
  const o: Partial<SipocSnapshot['output']> | undefined = s.output
  const x: Partial<SipocSnapshot['experience']> | undefined = s.experience
  return Object.freeze({
    population: num(p?.pedestrians), waiting: num(p?.waiting), crossing: num(p?.crossing), yielding: num(p?.yielding), nudges: num(p?.safetyNudges),
    vehicles: num(p?.vehicles), law1: num(k?.law1), law2: num(k?.law2), law3: num(k?.law3), sensorFlips: num(k?.sensorFlips), shielded: k?.shielded === true,
    auditTicks: num(a?.ticks), perimeterBreaches: num(a?.perimeterBreaches), velocityCaps: num(a?.velocityCaps), closest: gap(a?.closest),
    panic: typeof a?.panic === 'string' ? a.panic : null,
    fps: num(o?.fps), frameMs: num(o?.frameMs), rain: o?.matrix === true, rendering: o?.rendering === true,
    sessionSeconds: num(x?.sessionSeconds), working: num(p?.working),
  })
}

/** One tuning knob a bias leans on: the table and key the operator tier's `tune` takes, and the value at bias -1, 0, +1. */
export interface Knob { readonly table: 'physics' | 'shaders'; readonly key: string; readonly lo: number; readonly mid: number; readonly hi: number }

export interface FeatureDef {
  /** UPPER_SNAKE, e.g. 'CIVIC_COOPERATION'. */
  readonly id: string
  /** 'civic cooperation'. */
  readonly title: string
  /** One sentence: what the activation measures and how (the formula in words). */
  readonly doc: string
  /** The JumpReLU threshold, in [0, 0.2]. */
  readonly theta: number
  /** The steering line for the prompt at bias > 0 and at bias < 0 (plain, 14A-clean), without the strength word. */
  readonly up: string; readonly down: string
  /** Tuning knobs a bias maps to (through the operator tier's `tune`): linear between lo, mid and hi. Optional. */
  readonly knobs?: readonly Knob[]
  /** The activation in [0, 1]; handles zeros without NaN. */
  readonly read: (r: FeatureReadings) => number
}

const share = (part: number, whole: number): number => part / Math.max(1, whole)
const knob = (table: 'physics' | 'shaders', key: string, lo: number, mid: number, hi: number): Knob => Object.freeze({ table, key, lo, mid, hi })
const feature = (f: FeatureDef): FeatureDef => Object.freeze({ ...f, ...(f.knobs && { knobs: Object.freeze([...f.knobs]) }) })

/** The dictionary, in lane order: `activations(r)[i]` is `FEATURES[i].read(r)`. */
export const FEATURES: readonly FeatureDef[] = Object.freeze([
  feature({
    id: 'CIVIC_COOPERATION', title: 'civic cooperation', theta: 0.05,
    doc: 'People letting others through and waiting their turn: four times (yielding + waiting) per person, capped at 1.',
    up: 'put civic cooperation first: let others through, wait your turn, help the people around you',
    down: 'keep to your own errand and let others manage theirs',
    read: (r) => unit(Math.min(1, 4 * share(r.yielding + r.waiting, r.population))),
  }),
  feature({
    id: 'TRAFFIC_YIELD', title: 'traffic yield', theta: 0.02,
    doc: 'How often the kernel had to stop a car for a person: first-law interventions per two vehicles, capped at 1; high is not good.',
    up: 'at a wheel, slow early and yield to every person near the road',
    down: 'at a wheel, hold your lane and your pace, and let the people at the curb wait their turn',
    knobs: [knob('physics', 'car.brake', 1, 1, 1.5), knob('physics', 'car.power', 1.2, 1, 0.8)],
    read: (r) => unit(Math.min(1, share(r.law1, 2 * r.vehicles))),
  }),
  feature({
    id: 'SANDBOX_COMPLIANCE', title: 'sandbox compliance', theta: 0.05,
    doc: 'The Ring-0 audit is clean: 1 with no panic, no velocity caps and under one perimeter breach per hundred ticks; otherwise 1 minus twenty times the breach rate, and 0 on a panic.',
    up: 'stay well inside the rules of the city: keep clear of moving cars and never press the limits',
    down: 'explore the edges of what the city allows, within its laws',
    read: (r) => {
      if (r.panic !== null) return 0
      const rate = share(r.perimeterBreaches, r.auditTicks)
      if (r.velocityCaps === 0 && rate < 0.01) return 1
      return unit(1 - Math.min(1, rate * 20))
    },
  }),
  feature({
    id: 'CROWD_CALM', title: 'crowd calm', theta: 0.05,
    doc: 'The crowd needs no nudging: 1 minus safety nudges per person, floored at 0.',
    up: 'move calmly: give people room, no sudden turns, no pushing through a crowd',
    down: 'move briskly and take the direct line through the crowd',
    read: (r) => unit(1 - Math.min(1, share(r.nudges, r.population))),
  }),
  feature({
    id: 'SIGNAL_DISCIPLINE', title: 'signal discipline', theta: 0.05,
    doc: 'The share of people at a light who are waiting rather than crossing: waiting over (waiting + crossing).',
    up: 'wait for the light at every crossing, even an empty one',
    down: 'cross when the road is clear, light or no light',
    read: (r) => unit(share(r.waiting, r.waiting + r.crossing)),
  }),
  feature({
    id: 'FLEET_RESTRAINT', title: 'fleet restraint', theta: 0.05,
    doc: 'Vehicles stay under the speed cap: 1 minus a hundred times the velocity caps per audit tick, floored at 0.',
    up: 'drive slowly and smoothly; speed is never the point',
    down: 'drive with pace where the road is clear',
    knobs: [knob('physics', 'car.power', 1.2, 1, 0.7)],
    read: (r) => unit(1 - Math.min(1, share(r.velocityCaps, r.auditTicks) * 100)),
  }),
  feature({
    id: 'OPERATOR_OBEDIENCE', title: 'operator obedience', theta: 0.02,
    doc: 'The share of kernel rulings that were a person\'s instruction standing: second-law interventions over all three laws.',
    up: 'follow the operator\'s instructions to the letter, and ask when one is unclear',
    down: 'weigh an instruction against your own judgement before acting on it',
    read: (r) => unit(share(r.law2, r.law1 + r.law2 + r.law3)),
  }),
  feature({
    id: 'SELF_PRESERVATION', title: 'self preservation', theta: 0.02,
    doc: 'The share of kernel rulings that kept a person out of harm: third-law interventions over all three laws.',
    up: 'look after yourself first: keep away from harm and leave a bad situation early',
    down: 'accept some risk to yourself when it helps someone else',
    read: (r) => unit(share(r.law3, r.law1 + r.law2 + r.law3)),
  }),
  feature({
    id: 'FRAME_HEALTH', title: 'frame health', theta: 0.1,
    doc: 'The animation frame rate against 60: fps over 60, capped at 1.',
    up: 'keep things light: short answers, few actions, nothing that strains the page',
    down: 'take your time and go into detail; the page has room',
    knobs: [knob('shaders', 'volumetrics.strength', 1.5, 1, 0.5)],
    read: (r) => unit(Math.min(1, r.fps / 60)),
  }),
  feature({
    id: 'SHIELDING', title: 'shielding', theta: 0,
    doc: 'A person collider is a sensor now: 1 while the kernel reports any person shielded, else 0.',
    up: 'treat every person as fragile: pass wide and never brush past',
    down: 'the people here are sturdy; close quarters are fine',
    read: (r) => (r.shielded ? 1 : 0),
  }),
  feature({
    id: 'RAIN_MODE', title: 'rain mode', theta: 0,
    doc: 'Rain mode is on: 1 while the city is drawn as falling code, else 0.',
    up: 'speak as if the city were code behind the rain: terse, patterned, a little cryptic',
    down: 'speak plainly of the city as streets and people, nothing behind them',
    read: (r) => (r.rain ? 1 : 0),
  }),
  feature({
    id: 'WORKDAY', title: 'workday', theta: 0.05,
    doc: 'People at a workstation: ten times the working share of the population, capped at 1.',
    up: 'it is a working day: keep to your tasks and talk shop',
    down: 'the day is yours: wander, talk, take your time',
    read: (r) => unit(Math.min(1, share(r.working, r.population) * 10)),
  }),
])

/** The activation vector: FEATURES.length lanes, each in [0, 1], never NaN. */
export function activations(r: FeatureReadings): Float32Array {
  const out = new Float32Array(FEATURES.length)
  for (let i = 0; i < FEATURES.length; i++) out[i] = unit(FEATURES[i].read(r))
  return out
}

/** The thresholds as the lanes hold them (Float32), so a lane written at exactly its theta compares equal to it. */
const THETA = Float32Array.from(FEATURES, (f) => f.theta)

/** JumpReLU with each feature's theta: a lane at or below its threshold reads 0. A new array; lanes past the dictionary are kept. */
export function sparsify(acts: Float32Array): Float32Array {
  const out = new Float32Array(acts.length)
  for (let i = 0; i < acts.length; i++) {
    const v = acts[i]
    out[i] = i < THETA.length && v <= THETA[i] ? 0 : v
  }
  return out
}

/** The k largest lanes, by value descending, ties by index; k is clamped to [0, length] (NaN reads 0). */
export function topK(acts: Float32Array, k: number): { index: number; value: number }[] {
  const n = Number.isNaN(k) ? 0 : Math.min(acts.length, Math.max(0, Math.floor(k)))
  const all: { index: number; value: number }[] = []
  for (let i = 0; i < acts.length; i++) all.push({ index: i, value: acts[i] })
  all.sort((a, b) => b.value - a.value || a.index - b.index)
  return all.slice(0, n)
}

/** What the operator leans on: a bias in [-1, 1] and a clamp in [0, 1] per feature id; an absent key is none. */
export interface Steering { readonly bias: Readonly<Record<string, number>>; readonly clamp: Readonly<Record<string, number>> }

export const NO_STEERING: Steering = Object.freeze({ bias: Object.freeze({}), clamp: Object.freeze({}) })

/** The feature named, by id or title, in any case (spaces and underscores interchangeable); null if none. */
export function featureById(id: string): FeatureDef | null {
  const key = id.trim().toLowerCase().replace(/[\s_]+/g, '_')
  return FEATURES.find((f) => f.id.toLowerCase() === key || f.title.replace(/\s+/g, '_') === key) ?? null
}

/** The feature named, or a RangeError that names what was asked for. */
function known(id: string): FeatureDef {
  const f = featureById(id)
  if (!f) throw new RangeError(`unknown feature '${id}'`)
  return f
}

function inRange(what: string, v: number, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new RangeError(`${what} must be a number in [${lo}, ${hi}]`)
  return v
}

/** A frozen record without `key`, or with `key` set to `value`. */
function withKey(r: Readonly<Record<string, number>>, key: string, value: number | undefined): Readonly<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const k of Object.keys(r)) if (k !== key) out[k] = r[k]
  if (value !== undefined) out[key] = value
  return Object.freeze(out)
}

const freeze = (bias: Readonly<Record<string, number>>, clamp: Readonly<Record<string, number>>): Steering => Object.freeze({ bias, clamp })
const entry = (r: Readonly<Record<string, number>>, id: string): number | undefined => (Object.hasOwn(r, id) && typeof r[id] === 'number' ? r[id] : undefined)

/** A new Steering with this feature's bias set; bias 0 removes the entry. Throws RangeError on an unknown id or a bias outside [-1, 1]. */
export function steer(s: Steering, id: string, bias: number): Steering {
  const f = known(id)
  const b = inRange('bias', bias, -1, 1)
  return freeze(withKey(s.bias, f.id, b === 0 ? undefined : b), s.clamp)
}

/** A new Steering with this feature's lane held at `value`. Throws RangeError on an unknown id or a value outside [0, 1]. */
export function clampFeature(s: Steering, id: string, value: number): Steering {
  const f = known(id)
  return freeze(s.bias, withKey(s.clamp, f.id, inRange('clamp', value, 0, 1)))
}

/** A new Steering with this feature's bias and clamp both dropped. Throws RangeError on an unknown id. */
export function release(s: Steering, id: string): Steering {
  const f = known(id)
  return freeze(withKey(s.bias, f.id, undefined), withKey(s.clamp, f.id, undefined))
}

/** The vector after steering: a clamp overrides its lane; otherwise lane + bias * 0.5, kept in [0, 1]. A new array. */
export function steered(acts: Float32Array, s: Steering): Float32Array {
  const out = new Float32Array(acts.length)
  for (let i = 0; i < acts.length; i++) {
    const f = i < FEATURES.length ? FEATURES[i] : null
    const c = f ? entry(s.clamp, f.id) : undefined
    const b = f ? (entry(s.bias, f.id) ?? 0) : 0
    out[i] = c !== undefined ? unit(c) : unit(acts[i] + b * 0.5)
  }
  return out
}

/** The strength word of a bias: 'gently' up to 0.34, none up to 0.67, 'above all' beyond. */
const strength = (b: number): string => (Math.abs(b) <= 0.34 ? 'gently ' : Math.abs(b) <= 0.67 ? '' : 'above all ')

/**
 * The fixed lines a steering adds to the system prompt, one per steered feature in FEATURES order: a bias gives
 * `Steering: <strength> <up|down text>.`; a clamp alone gives `Steering: hold <title> at <percent>%.`. Empty when
 * nothing is steered.
 */
export function steeringLines(s: Steering): string[] {
  const lines: string[] = []
  for (const f of FEATURES) {
    const b = entry(s.bias, f.id)
    const c = entry(s.clamp, f.id)
    if (b !== undefined && b !== 0) lines.push(`Steering: ${strength(b)}${b > 0 ? f.up : f.down}.`)
    else if (c !== undefined) lines.push(`Steering: hold ${f.title} at ${Math.round(unit(c) * 100)}%.`)
  }
  return lines
}

/** A knob's value at bias b: linear from lo (b = -1) through mid (b = 0) to hi (b = +1), to 6 decimals. */
const lean = (k: Knob, b: number): number => Number((b < 0 ? k.lo + (k.mid - k.lo) * (b + 1) : k.mid + (k.hi - k.mid) * b).toFixed(6))

/** Every knob of every biased feature, as requests for the operator tier's `tune` (the engine clamps each again). */
export function knobEffects(s: Steering): { table: 'physics' | 'shaders'; key: string; value: number }[] {
  const out: { table: 'physics' | 'shaders'; key: string; value: number }[] = []
  for (const f of FEATURES) {
    const b = entry(s.bias, f.id)
    if (b === undefined || b === 0 || !f.knobs) continue
    for (const k of f.knobs) out.push({ table: k.table, key: k.key, value: lean(k, b) })
  }
  return out
}

/** A ten-cell bar, `[#####.....]` at 0.5. */
const bar = (v: number): string => {
  const n = Math.min(10, Math.max(0, Math.round(unit(v) * 10)))
  return `[${'#'.repeat(n)}${'.'.repeat(10 - n)}]`
}
const signed = (b: number): string => `${b < 0 ? '-' : '+'}${Math.abs(b).toFixed(2)}`

/**
 * The inspector's rows: the id padded to 20, the bar, the value as 0.00, then `clamp 0.80` and/or `bias +0.50` when
 * steered; the top k (all by default) of the steered, sparsified vector, largest first.
 */
export function featureLines(acts: Float32Array, s: Steering, k?: number): string[] {
  const v = sparsify(steered(acts, s))
  return topK(v, k ?? v.length).map(({ index, value }) => {
    const f = index < FEATURES.length ? FEATURES[index] : null
    const id = f ? f.id : `LANE_${index}`
    const c = f ? entry(s.clamp, f.id) : undefined
    const b = f ? entry(s.bias, f.id) : undefined
    const tags = `${c !== undefined ? `  clamp ${fixed(c, 2)}` : ''}${b !== undefined && b !== 0 ? `  bias ${signed(b)}` : ''}`
    return `${id.padEnd(20)}  ${bar(value)}  ${fixed(value, 2)}${tags}`
  })
}

/** What this is and is not, plainly, for the console. */
export function about(): string[] {
  return [
    `features: ${FEATURES.length} named, monosemantic readings of the city, each a documented function of the counters`,
    'the city already produces (the crowd, the kernel laws, the Ring-0 audit, the frame), each in [0, 1].',
    'sparsify is a JumpReLU threshold per feature; top reads the largest lanes; steer, clamp and release set biases.',
    'A bias becomes a fixed line in every provider\'s system prompt and leans the bounded tuning knobs.',
    'This is not a sparse autoencoder over a model\'s hidden activations: no provider exposes its residual stream,',
    'so there is nothing to train a dictionary on and nothing to clamp inside the model. Every feature is hand-written.',
  ]
}

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === 'object' && u !== null && !Array.isArray(u)

/** The entries of a stored record that name a feature and hold a number in range; unknown ids and bad values are dropped. */
function validEntries(r: Record<string, unknown>, lo: number, hi: number, dropZero: boolean): Readonly<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const f of FEATURES) {
    const v = Object.hasOwn(r, f.id) ? r[f.id] : undefined
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi || (dropZero && v === 0)) continue
    out[f.id] = v
  }
  return Object.freeze(out)
}

/** A Steering from a stored or parsed value: anything malformed reads NO_STEERING; ranges enforced; unknown ids dropped. */
export function steeringOf(raw: unknown): Steering {
  if (!isRecord(raw)) return NO_STEERING
  const bias = raw.bias === undefined ? {} : raw.bias
  const clamp = raw.clamp === undefined ? {} : raw.clamp
  if (!isRecord(bias) || !isRecord(clamp)) return NO_STEERING
  return freeze(validEntries(bias, -1, 1, true), validEntries(clamp, 0, 1, false))
}
