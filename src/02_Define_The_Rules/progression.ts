// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the operator's progression as plain rules over one flat record: six attribute
 * modifiers, eight skills with proficiency ranks, a level from 1 to 20 with 1,000 XP to each, civic credits, hero
 * points, resolve, three actions and a reaction per round, and the unlock bits the wardrobe, the properties and the
 * furniture are bought into. A check is the city's ordinary check (degrees.ts: a d20, the four degrees, fortune)
 * against the level-based DC, eased for routine work; what it pays is a fixed, readable table by degree and level,
 * raised by how many different skills the operator has used in the current cycle of checks. The record is one
 * Int32Array of RECORD_WORDS words (structure of arrays over one buffer; a Uint32Array view of the same buffer reads
 * the masks and the seal), so the page keeps it, the store saves it in one write (05_Observe_Environment/
 * progressStore.ts) and a purchase debits the credits and sets the unlock bit in the same record, never half of it.
 * The mechanics are offered under the ORC License (NOTICE.md names the works they come from and lists them); the
 * breadth bonus, resolve and the bad-luck guard are this product's own. Pure: no clock, no storage, no DOM; the
 * dice are seeded from the record, so the same record always rolls the same next check.
 * What breaks if it is removed? The operator has no level, no skills and no credits, the console's `progress` has
 * nothing behind it, and the wardrobe and the properties have no purchase gate.
 */
import { CRIT_SUCCESS, FAILURE, RANKS, createRng, degreeOf, proficiencyBonus, rollD20, type Degree } from './degrees.ts'

// ---------------------------------------------------------------------------------------------------
// The record

/** Words in one record (512 bytes: eight 64-byte lines). */
export const RECORD_WORDS = 128
/** The layout a record written now has (AT.layout); a record of another layout is not read. */
export const RECORD_LAYOUT = 1

/**
 * Where each field sits. The first twenty-one keep the indices the plan gave them (level at 14, credits at 16), so a
 * reader of the plan finds them where it said; the unlock bits fill the second half.
 */
export const AT = Object.freeze({
  /** Six signed attribute modifiers, in ATTRIBUTES order. */
  attributes: 0,
  /** Eight proficiency ranks (0 untrained … 4 legendary), in OPERATOR_SKILLS order. */
  ranks: 6,
  level: 14,
  /** 0..999 toward the next level (999 at most at level 20). */
  xp: 15,
  credits: 16,
  /** 0..HERO_MAX. */
  hero: 17,
  /** 0..resolveCap(). */
  resolve: 18,
  /** Actions left this round (0..3) in bits 0-1, the reaction (0 or 1) in bit 2. */
  actions: 19,
  /** One bit per skill used in the current cycle (the breadth bonus). */
  breadth: 20,
  /** Checks in a row that came out a failure or worse (the bad-luck guard). */
  missStreak: 21,
  // 22 is kept free: the plan put a running reward expectation there, which this product does not keep (docs/progression.md).
  /** Skill increases earned and not yet spent. */
  increases: 23,
  /** One bit per attribute holding a partial boost (a boost taken at +4 or more counts half). */
  partial: 24,
  /** The dice's seed. */
  seed: 25,
  /** Checks rolled so far: the dice's position. */
  rolls: 26,
  /** Checks made, lifetime. */
  checks: 27,
  /** Eight words: checks per skill, lifetime (the attribute boosts follow them). */
  uses: 28,
  /** Checks made in the current cycle. */
  cycle: 36,
  /** Credits earned and spent, lifetime (each saturates at CREDITS_MAX). */
  earned: 37,
  spent: 38,
  layout: 39,
  /** FNV-1a over every other word. */
  seal: 63,
  /** The unlock bits, UNLOCK_BITS of them. */
  unlocks: 64,
} as const)

/** A progression record: RECORD_WORDS signed words over one buffer. */
export type ProgressRecord = Int32Array

/**
 * A fresh buffer for a record: shared memory where the page is cross-origin isolated (a worker can then read the same
 * record without a copy), an ordinary buffer otherwise. Only the page writes it either way.
 */
export function recordBuffer(): ArrayBuffer | SharedArrayBuffer {
  const bytes = RECORD_WORDS * 4
  const shared = typeof SharedArrayBuffer === 'function' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
  return shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes)
}

/** The record's words as unsigned 32-bit values (the masks, the seal), over the same memory. */
export const wordsOf = (rec: ProgressRecord): Uint32Array => new Uint32Array(rec.buffer, rec.byteOffset, RECORD_WORDS)

// ---------------------------------------------------------------------------------------------------
// Attributes and skills

export const ATTRIBUTES = Object.freeze(['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'] as const)
export type Attribute = (typeof ATTRIBUTES)[number]
export const ATTRIBUTE_SHORT: readonly string[] = Object.freeze(['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'])
/** What each attribute means in the city. */
export const ATTRIBUTE_ROLE: readonly string[] = Object.freeze(['kinematics', 'handling', 'stamina', 'algorithms', 'observability', 'command'])
const STR = 0, DEX = 1, CON = 2, INT = 3, WIS = 4, CHA = 5

/** The operator's eight skills, as the console names them. */
export const OPERATOR_SKILLS = Object.freeze(['computers', 'piloting', 'robotics', 'security', 'swarm', 'voice', 'optics', 'commerce'] as const)
export type OperatorSkill = (typeof OPERATOR_SKILLS)[number]
export const SKILL_COUNT = OPERATOR_SKILLS.length
export const SKILL_TITLE: readonly string[] = Object.freeze([
  'Computers', 'Piloting', 'Robotics', 'Cyber security', 'Swarm command', 'Acoustics and voice', 'Optics and cinema', 'Architecture and commerce',
])
/** What earns a check in each skill (the page's keeper decides, 07_Execute_Actions/progress.ts; this is its summary). */
export const SKILL_DOES: readonly string[] = Object.freeze([
  'NoirScript, R0 and scripts at the console',
  'boarding a parked car with the door key',
  'the robots and the workplaces\' stations',
  'audits: the act log, the swarm\'s trail, the harnesses',
  'recruiting, asking, the swarm, allowing an act',
  'speech: say, Sloane, a spoken request understood',
  'the camera, the clock, rain mode, ghost view, the headset',
  'your look, and what you buy',
])
/** The attribute each skill adds (INT, DEX, STR, WIS, CHA, CHA, WIS, INT). Constitution keys no skill: it sets the resolve cap. */
export const SKILL_ATTRIBUTE: readonly number[] = Object.freeze([INT, DEX, STR, WIS, CHA, CHA, WIS, INT])

/** The skill a console word names (its name, or its title's first word, any case); -1 for none. */
export function skillIndex(name: string): number {
  const t = String(name ?? '').trim().toLowerCase()
  const i = (OPERATOR_SKILLS as readonly string[]).indexOf(t)
  return i >= 0 ? i : SKILL_TITLE.findIndex((s) => s.toLowerCase() === t || s.toLowerCase().split(' ')[0] === t)
}

// ---------------------------------------------------------------------------------------------------
// The tables

export const MAX_LEVEL = 20
export const XP_PER_LEVEL = 1000
export const HERO_MAX = 3
export const RESOLVE_MAX = 10
export const ACTIONS_PER_ROUND = 3
/** A round, ms: three actions and a reaction each. */
export const ROUND_MS = 6000
/** A skill earns again this long after its last check, ms: varied work pays, the same command over and over does not. */
export const SKILL_REST_MS = 60_000
/** Checks in a cycle: the breadth bonus counts the skills used since the cycle began, then starts again. */
export const CYCLE_CHECKS = 24
/** Failures in a row after which the next check rolls twice and keeps the higher die (fortune). */
export const GUARD_AFTER = 3
/** Credits a new operator starts with (fifteen gold pieces of starting wealth, at ten credits to the piece). */
export const STARTING_CREDITS = 150
/** Credits saturate here (well inside a signed word). */
export const CREDITS_MAX = 2_000_000_000

/** The level-based DCs, levels 0 to 20 (the ORC-licensed table NOTICE.md names). */
export const DC_BY_LEVEL: readonly number[] = Object.freeze([14, 15, 16, 18, 19, 20, 22, 23, 24, 26, 27, 28, 30, 31, 32, 34, 35, 36, 38, 39, 40])
/** City work is routine: every check is an easy one, the table's -2. */
export const EASY = -2

/**
 * The treasure a party gains over each level in the ORC-licensed treasure-by-level table, in credits (ten to the gold
 * piece); index = level, 0 unused. The plan's wealth curve: what a level's work is worth, and what the properties
 * are priced against.
 */
export const LEVEL_TREASURE: readonly number[] = Object.freeze([
  0, 1750, 3000, 5000, 8500, 13500, 20000, 29000, 40000, 57000, 80000,
  115000, 165000, 250000, 365000, 545000, 825000, 1280000, 2080000, 3550000, 4900000,
])
/** What one successful check pays at each level, in credits (the plan's table, about a thirteenth of the level's treasure); index = level. */
export const TASK_PAYOUT: readonly number[] = Object.freeze([
  0, 150, 250, 400, 650, 1000, 1500, 2200, 3000, 4200, 6000,
  8500, 12000, 18000, 27000, 40000, 60000, 95000, 150000, 260000, 400000,
])

/** What each degree pays (critical failure, failure, success, critical success): XP, the payout's share in 256ths, hero points. */
export const REWARD = Object.freeze({
  xp: Object.freeze([0, 10, 40, 80]),
  payQ8: Object.freeze([0, 0, 256, 640]),
  hero: Object.freeze([0, 0, 0, 1]),
})
/**
 * The breadth bonus in 256ths, by how many different skills the current cycle has used (0..8): 1x for one skill, 1.5x
 * for three, 2x for five, 3.5x for all eight. It multiplies XP and credits alike.
 */
export const BREADTH_Q8: readonly number[] = Object.freeze([256, 256, 320, 384, 448, 512, 576, 640, 896])

/** A rank needs this level (master from 7, legendary from 15). */
export const RANK_MIN_LEVEL: readonly number[] = Object.freeze([1, 1, 1, 7, 15])
/** Levels at which four attribute boosts arrive. */
export const BOOST_LEVELS: readonly number[] = Object.freeze([5, 10, 15, 20])

/** Bits set in a 32-bit word. */
export function popcount(v: number): number {
  let x = v - ((v >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24)
}

const clampInt = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
const addCredits = (a: number, b: number): number => Math.min(CREDITS_MAX, Math.max(0, a + b))

/** The most resolve the operator can hold: 5 plus their constitution, from 1 to RESOLVE_MAX. */
export function resolveCap(rec: ProgressRecord): number {
  return clampInt(5 + rec[AT.attributes + CON], 1, RESOLVE_MAX)
}

/** The check's modifier in skill `s`: the rank's proficiency at the operator's level plus the skill's attribute. */
export function modifierOf(rec: ProgressRecord, s: number): number {
  return proficiencyBonus(rec[AT.ranks + s], rec[AT.level]) + rec[AT.attributes + SKILL_ATTRIBUTE[s]]
}

/** The DC of the operator's checks: the level's DC, eased. */
export function dcOf(rec: ProgressRecord): number {
  return DC_BY_LEVEL[clampInt(rec[AT.level], 0, MAX_LEVEL)] + EASY
}

// ---------------------------------------------------------------------------------------------------
// A new record, the seal and validation

/**
 * A new operator: level 1, every attribute +1, every skill trained, the starting credits, one hero point, full
 * resolve, a full round, and the dice seeded with `seed`. Into `rec` when given (its words are overwritten).
 */
export function newRecord(seed: number, rec: ProgressRecord = new Int32Array(recordBuffer())): ProgressRecord {
  rec.fill(0)
  for (let a = 0; a < ATTRIBUTES.length; a++) rec[AT.attributes + a] = 1
  for (let s = 0; s < SKILL_COUNT; s++) rec[AT.ranks + s] = 1
  rec[AT.level] = 1
  rec[AT.credits] = STARTING_CREDITS
  rec[AT.hero] = 1
  rec[AT.resolve] = resolveCap(rec)
  rec[AT.actions] = ACTIONS_PER_ROUND | 4
  rec[AT.seed] = seed | 0
  rec[AT.layout] = RECORD_LAYOUT
  seal(rec)
  return rec
}

/** FNV-1a over the bytes of every word but the seal. It finds a damaged or hand-edited record; it is not tamper-proof. */
export function sealOf(rec: ProgressRecord): number {
  const w = wordsOf(rec)
  let h = 0x811c9dc5
  for (let i = 0; i < RECORD_WORDS; i++) {
    if (i === AT.seal) continue
    const v = w[i]
    h = Math.imul(h ^ (v & 0xff), 0x01000193)
    h = Math.imul(h ^ ((v >>> 8) & 0xff), 0x01000193)
    h = Math.imul(h ^ ((v >>> 16) & 0xff), 0x01000193)
    h = Math.imul(h ^ (v >>> 24), 0x01000193)
  }
  return h >>> 0
}

/** Writes the seal; every change to a record ends with it. */
export function seal(rec: ProgressRecord): void {
  wordsOf(rec)[AT.seal] = sealOf(rec)
}

/** Why a record cannot be used (its length, its layout, its seal, a field out of range), or null when it can. */
export function whyInvalid(rec: ArrayLike<number>): string | null {
  if (!(rec instanceof Int32Array) || rec.length !== RECORD_WORDS) return 'not a record'
  if (rec[AT.layout] !== RECORD_LAYOUT) return `layout ${rec[AT.layout]}, not ${RECORD_LAYOUT}`
  if (wordsOf(rec)[AT.seal] !== sealOf(rec)) return 'the seal does not match'
  const level = rec[AT.level]
  if (level < 1 || level > MAX_LEVEL) return 'level out of range'
  if (rec[AT.xp] < 0 || rec[AT.xp] >= XP_PER_LEVEL) return 'XP out of range'
  if (rec[AT.credits] < 0 || rec[AT.credits] > CREDITS_MAX) return 'credits out of range'
  if (rec[AT.hero] < 0 || rec[AT.hero] > HERO_MAX) return 'hero points out of range'
  if (rec[AT.resolve] < 0 || rec[AT.resolve] > RESOLVE_MAX) return 'resolve out of range'
  for (let a = 0; a < ATTRIBUTES.length; a++) if (rec[AT.attributes + a] < -5 || rec[AT.attributes + a] > 10) return 'an attribute out of range'
  for (let s = 0; s < SKILL_COUNT; s++) if (rec[AT.ranks + s] < 0 || rec[AT.ranks + s] >= RANKS.length) return 'a rank out of range'
  if (rec[AT.increases] < 0 || rec[AT.increases] > MAX_LEVEL) return 'skill increases out of range'
  if (rec[AT.cycle] < 0 || rec[AT.cycle] > CYCLE_CHECKS) return 'cycle out of range'
  return null
}

// ---------------------------------------------------------------------------------------------------
// Rounds, levels and checks

/** Actions left this round, and whether the reaction is. */
export const actionsLeft = (rec: ProgressRecord): number => rec[AT.actions] & 3
export const reactionLeft = (rec: ProgressRecord): boolean => (rec[AT.actions] & 4) !== 0

/** A new round: three actions and the reaction. */
export function newRound(rec: ProgressRecord): void {
  rec[AT.actions] = ACTIONS_PER_ROUND | 4
  seal(rec)
}

/** Spends an action (or, with `reaction`, the reaction); false when none is left. */
export function spendAction(rec: ProgressRecord, reaction = false): boolean {
  const a = rec[AT.actions]
  if (reaction ? (a & 4) === 0 : (a & 3) === 0) return false
  rec[AT.actions] = reaction ? a & 3 : (a & 4) | ((a & 3) - 1)
  seal(rec)
  return true
}

/** What a level brought: the skill increase, the attribute boosts by name, resolve. */
export interface LevelUp { readonly level: number; readonly increase: boolean; readonly boosts: readonly string[] }

/**
 * Four boosts to four different attributes: those behind the skills used most (ties go to the earlier attribute). A
 * boost raises a modifier below +4 by one; at +4 or more it is partial, and a second partial boost raises it by one.
 */
function boost(rec: ProgressRecord): string[] {
  const weight = new Float64Array(ATTRIBUTES.length)
  for (let s = 0; s < SKILL_COUNT; s++) weight[SKILL_ATTRIBUTE[s]] += rec[AT.uses + s]
  const order = [0, 1, 2, 3, 4, 5].sort((a, b) => weight[b] - weight[a] || a - b).slice(0, 4)
  const named: string[] = []
  const w = wordsOf(rec)
  for (const a of order) {
    const bit = 1 << a
    if (rec[AT.attributes + a] < 4) {
      rec[AT.attributes + a]++
      named.push(`${ATTRIBUTE_SHORT[a]} +${rec[AT.attributes + a]}`)
    } else if (w[AT.partial] & bit) {
      w[AT.partial] &= ~bit
      rec[AT.attributes + a]++
      named.push(`${ATTRIBUTE_SHORT[a]} +${rec[AT.attributes + a]}`)
    } else {
      w[AT.partial] |= bit
      named.push(`${ATTRIBUTE_SHORT[a]} partial`)
    }
  }
  return named
}

/** Adds XP, levelling up past each thousand (XP keeps the rest; at level 20 it stops at 999). The levels gained. */
export function gainXp(rec: ProgressRecord, xp: number): LevelUp[] {
  const ups: LevelUp[] = []
  let total = rec[AT.xp] + Math.max(0, Math.floor(xp))
  while (total >= XP_PER_LEVEL && rec[AT.level] < MAX_LEVEL) {
    total -= XP_PER_LEVEL
    const level = ++rec[AT.level]
    rec[AT.increases]++
    const boosts = BOOST_LEVELS.includes(level) ? boost(rec) : []
    rec[AT.resolve] = Math.min(resolveCap(rec), rec[AT.resolve] + 1)
    ups.push(Object.freeze({ level, increase: true, boosts: Object.freeze(boosts) }))
  }
  rec[AT.xp] = rec[AT.level] >= MAX_LEVEL ? Math.min(total, XP_PER_LEVEL - 1) : total
  seal(rec)
  return ups
}

/** One check's whole story: the dice, the numbers, the degree, and what it paid. */
export interface Check {
  readonly skill: number
  /** The die kept, and every die rolled (two when the guard or a reroll's fortune applied). */
  readonly natural: number
  readonly rolls: readonly number[]
  readonly modifier: number
  readonly dc: number
  readonly total: number
  readonly degree: Degree
  /** The level the check was made at (its payout's level). */
  readonly level: number
  /** Skills used this cycle, counting this one, and the bonus they gave, in 256ths. */
  readonly breadth: number
  readonly breadthQ8: number
  readonly xp: number
  readonly credits: number
  readonly hero: number
  /** The bad-luck guard rolled this check twice. */
  readonly guarded: boolean
  /** This check lit the eighth skill of the cycle. */
  readonly overdrive: boolean
  readonly levels: readonly LevelUp[]
  /** A hero point's reroll of an earlier check. */
  readonly reroll: boolean
}

/** A 32-bit mix of the seed and the dice's position (lowbias32), so each check has its own stream. */
function diceSeed(seed: number, position: number): number {
  let x = (seed ^ Math.imul(position + 1, 0x9e3779b1)) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d)
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b)
  return (x ^ (x >>> 16)) >>> 0
}

/** The next position's dice: one d20, or two keeping the higher with `fortune`. Advances the position. */
function roll(rec: ProgressRecord, fortune: boolean): { natural: number; rolls: number[] } {
  const rng = createRng(diceSeed(rec[AT.seed], rec[AT.rolls]))
  rec[AT.rolls] = (rec[AT.rolls] + 1) | 0
  const a = rollD20(rng)
  if (!fortune) return { natural: a, rolls: [a] }
  const b = rollD20(rng)
  return { natural: Math.max(a, b), rolls: [a, b] }
}

/** What degree `d` pays at `level` with breadth bonus `q8`. */
export function payOf(d: Degree, level: number, q8: number): { xp: number; credits: number; hero: number } {
  return {
    xp: Math.floor((REWARD.xp[d] * q8) / 256),
    credits: Math.floor((TASK_PAYOUT[clampInt(level, 0, MAX_LEVEL)] * REWARD.payQ8[d] * q8) / 65536),
    hero: REWARD.hero[d],
  }
}

/** Pays: XP (with its levels), credits and hero points. */
function pay(rec: ProgressRecord, xp: number, credits: number, hero: number): LevelUp[] {
  rec[AT.credits] = addCredits(rec[AT.credits], credits)
  rec[AT.earned] = addCredits(rec[AT.earned], credits)
  rec[AT.hero] = Math.min(HERO_MAX, rec[AT.hero] + hero)
  return gainXp(rec, xp)
}

/**
 * One check in skill `s` (the caller has spent the action): the guard's fortune after GUARD_AFTER misses, the dice at
 * the record's position, the degree against the eased DC, the cycle's breadth, and the pay. The cycle starts again
 * after CYCLE_CHECKS checks; lighting its eighth skill is the overdrive (one resolve).
 */
export function attempt(rec: ProgressRecord, s: number): Check {
  if (!(Number.isInteger(s) && s >= 0 && s < SKILL_COUNT)) throw new RangeError(`no skill ${s}`)
  const w = wordsOf(rec)
  if (rec[AT.cycle] >= CYCLE_CHECKS) {
    w[AT.breadth] = 0
    rec[AT.cycle] = 0
  }
  const guarded = rec[AT.missStreak] >= GUARD_AFTER
  const { natural, rolls } = roll(rec, guarded)
  const level = rec[AT.level]
  const modifier = modifierOf(rec, s)
  const dc = dcOf(rec)
  const total = natural + modifier
  const degree = degreeOf(natural, total, dc)
  const before = popcount(w[AT.breadth])
  w[AT.breadth] |= 1 << s
  const breadth = popcount(w[AT.breadth])
  const overdrive = breadth === SKILL_COUNT && before < SKILL_COUNT
  const breadthQ8 = BREADTH_Q8[breadth]
  rec[AT.cycle]++
  rec[AT.checks] = (rec[AT.checks] + 1) | 0
  rec[AT.uses + s] = (rec[AT.uses + s] + 1) | 0
  rec[AT.missStreak] = degree <= FAILURE ? rec[AT.missStreak] + 1 : 0
  if (overdrive) rec[AT.resolve] = Math.min(resolveCap(rec), rec[AT.resolve] + 1)
  const p = payOf(degree, level, breadthQ8)
  const levels = pay(rec, p.xp, p.credits, p.hero)
  return Object.freeze({
    skill: s, natural, rolls: Object.freeze(rolls), modifier, dc, total, degree, level, breadth, breadthQ8,
    xp: p.xp, credits: p.credits, hero: p.hero, guarded, overdrive, levels: Object.freeze(levels), reroll: false,
  })
}

/** Why a hero point cannot reroll `last` now, or null when it can. */
export function whyNoReroll(rec: ProgressRecord, last: Check | null): string | null {
  if (!last) return 'no check to reroll yet'
  if (last.reroll) return 'that check was already rerolled'
  if (last.degree === CRIT_SUCCESS) return 'that check was a critical success already'
  if (rec[AT.hero] < 1) return 'no hero point left'
  return null
}

/**
 * A hero point spent to reroll `last`: a new die at the next position, against the same numbers. The better of the
 * two results pays: what the first one paid stays, and a better second pays the difference.
 */
export function reroll(rec: ProgressRecord, last: Check): Check {
  const why = whyNoReroll(rec, last)
  if (why) throw new Error(why)
  rec[AT.hero]--
  const { natural, rolls } = roll(rec, false)
  const total = natural + last.modifier
  const degree = degreeOf(natural, total, last.dc)
  const first = payOf(last.degree, last.level, last.breadthQ8)
  const second = payOf(degree, last.level, last.breadthQ8)
  const xp = Math.max(0, second.xp - first.xp), credits = Math.max(0, second.credits - first.credits), hero = Math.max(0, second.hero - first.hero)
  rec[AT.missStreak] = degree <= FAILURE ? rec[AT.missStreak] : 0
  const levels = pay(rec, xp, credits, hero)
  return Object.freeze({
    ...last, natural, rolls: Object.freeze(rolls), total, degree, xp, credits, hero, guarded: false, overdrive: false, levels: Object.freeze(levels), reroll: true,
  })
}

/** Why skill `s` cannot take a skill increase now, or null when it can. */
export function whyNoIncrease(rec: ProgressRecord, s: number): string | null {
  if (!(Number.isInteger(s) && s >= 0 && s < SKILL_COUNT)) return 'no such skill'
  if (rec[AT.increases] < 1) return 'no skill increase to spend: one comes with every level from 2'
  const next = rec[AT.ranks + s] + 1
  if (next >= RANKS.length) return `${SKILL_TITLE[s]} is legendary already`
  if (rec[AT.level] < RANK_MIN_LEVEL[next]) return `${RANKS[next]} needs level ${RANK_MIN_LEVEL[next]}`
  return null
}

/** Spends a skill increase on skill `s`: its next rank. Returns the rank's name. */
export function train(rec: ProgressRecord, s: number): string {
  const why = whyNoIncrease(rec, s)
  if (why) throw new Error(why)
  rec[AT.increases]--
  rec[AT.ranks + s]++
  seal(rec)
  return RANKS[rec[AT.ranks + s]]
}

/** Spends `n` resolve; false (nothing spent) when there is not that much. */
export function spendResolve(rec: ProgressRecord, n: number): boolean {
  if (!(Number.isInteger(n) && n > 0 && rec[AT.resolve] >= n)) return false
  rec[AT.resolve] -= n
  seal(rec)
  return true
}

/** A new session: at least one hero point (the rule's session start), and a new round. */
export function startSession(rec: ProgressRecord): void {
  rec[AT.hero] = Math.max(1, rec[AT.hero])
  rec[AT.actions] = ACTIONS_PER_ROUND | 4
  seal(rec)
}

// ---------------------------------------------------------------------------------------------------
// The purchase gate

/** Unlock bits in a record. */
export const UNLOCK_BITS = (RECORD_WORDS - AT.unlocks) * 32

/**
 * The unlock bits, split by who sells into them: the wardrobe and the body art (the customizer), the properties, and
 * the furniture placed in them. An index is within its space (0 to size - 1); the rest of the bits are kept free.
 */
export const UNLOCK_SPACE = Object.freeze({
  look: Object.freeze({ from: 0, size: 1024 }),
  property: Object.freeze({ from: 1024, size: 64 }),
  furniture: Object.freeze({ from: 1088, size: 512 }),
} as const)
export type UnlockSpace = keyof typeof UNLOCK_SPACE

/** What a purchase came to. */
export const PURCHASE = Object.freeze({ bought: 0, owned: 1, level: 2, credits: 3, invalid: 4 } as const)
export type PurchaseResult = (typeof PURCHASE)[keyof typeof PURCHASE]
export const PURCHASE_TEXT: readonly string[] = Object.freeze(['bought', 'owned already', 'needs a higher level', 'not enough credits', 'not something that can be bought'])

/** The bit of `index` in `space`, or -1 when either is not one. */
function bitOf(space: UnlockSpace, index: number): number {
  const sp = Object.hasOwn(UNLOCK_SPACE, space) ? UNLOCK_SPACE[space] : null
  return sp && Number.isInteger(index) && index >= 0 && index < sp.size ? sp.from + index : -1
}

/** Whether the operator owns `index` in `space`. */
export function owns(rec: ProgressRecord, space: UnlockSpace, index: number): boolean {
  const bit = bitOf(space, index)
  return bit >= 0 && (wordsOf(rec)[AT.unlocks + (bit >>> 5)] & (1 << (bit & 31))) !== 0
}

/** What buying `index` in `space` at `levelReq` for `price` credits would come to, without buying. */
export function canBuy(rec: ProgressRecord, space: UnlockSpace, index: number, levelReq: number, price: number): PurchaseResult {
  const bit = bitOf(space, index)
  if (bit < 0 || !Number.isInteger(levelReq) || levelReq < 1 || levelReq > MAX_LEVEL || !Number.isInteger(price) || price < 0 || price > CREDITS_MAX) return PURCHASE.invalid
  if (owns(rec, space, index)) return PURCHASE.owned
  if (rec[AT.level] < levelReq) return PURCHASE.level
  if (rec[AT.credits] < price) return PURCHASE.credits
  return PURCHASE.bought
}

/** Buys `index` in `space`: the credits debited and the bit set in the same record, or nothing at all. */
export function buy(rec: ProgressRecord, space: UnlockSpace, index: number, levelReq: number, price: number): PurchaseResult {
  const r = canBuy(rec, space, index, levelReq, price)
  if (r !== PURCHASE.bought) return r
  const bit = bitOf(space, index)
  rec[AT.credits] -= price
  rec[AT.spent] = addCredits(rec[AT.spent], price)
  wordsOf(rec)[AT.unlocks + (bit >>> 5)] |= 1 << (bit & 31)
  seal(rec)
  return r
}

/** Spends `price` credits on something that is not an unlock (a service); false (nothing spent) when there are not enough. */
export function spend(rec: ProgressRecord, price: number): boolean {
  if (!(Number.isInteger(price) && price >= 0 && rec[AT.credits] >= price)) return false
  rec[AT.credits] -= price
  rec[AT.spent] = addCredits(rec[AT.spent], price)
  seal(rec)
  return true
}
