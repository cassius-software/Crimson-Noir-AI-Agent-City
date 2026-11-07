// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the page's keeper of the operator's progression: the one record
 * (02_Define_The_Rules/progression.ts), loaded at start and saved after every change
 * (05_Observe_Environment/progressStore.ts), the round clock (three actions and a reaction every six seconds), each
 * skill's rest (a skill earns again a minute after its last check), the last check (a hero point may reroll it), and
 * whoever listens for a check (the console now; the cues and the HUD as they are wired). It also decides which console
 * commands earn a check, in which skill, and writes the console's `progress` text. The wardrobe and the properties buy
 * through `buy`, which debits the credits and sets the unlock in the same record and the same save.
 * What breaks if it is removed? Nothing earns XP or credits, `progress` has nothing to show, and nothing can be bought.
 */
import { CRIT_FAILURE, CRIT_SUCCESS, FAILURE, RANKS, SUCCESS } from '../02_Define_The_Rules/degrees.ts'
import {
  ACTIONS_PER_ROUND, AT, ATTRIBUTE_SHORT, ATTRIBUTES, BREADTH_Q8, CYCLE_CHECKS, DC_BY_LEVEL, EASY, GUARD_AFTER, HERO_MAX, LEVEL_TREASURE,
  MAX_LEVEL, OPERATOR_SKILLS, PURCHASE, REWARD, ROUND_MS, SKILL_ATTRIBUTE, SKILL_COUNT, SKILL_DOES, SKILL_REST_MS, SKILL_TITLE, TASK_PAYOUT,
  XP_PER_LEVEL, actionsLeft, attempt, buy as buyIn, canBuy as canBuyIn, dcOf, modifierOf, newRecord, newRound, owns as ownsIn, popcount,
  reactionLeft, reroll as rerollIn, resolveCap, skillIndex, spend as spendIn, spendAction, spendResolve as spendResolveIn, startSession,
  train as trainIn, whyNoIncrease, wordsOf, type Check, type OperatorSkill, type ProgressRecord, type PurchaseResult, type UnlockSpace,
} from '../02_Define_The_Rules/progression.ts'
import { loadProgress, saveProgress } from '../05_Observe_Environment/progressStore.ts'
import type { ProfileStore } from '../05_Observe_Environment/profile.ts'

const COMPUTERS = 0, ROBOTICS = 2, SECURITY = 3, SWARM = 4, VOICE = 5, OPTICS = 6, COMMERCE = 7

export interface ProgressOptions {
  /** Where the record is kept: localStorage when absent, nowhere with null (a test, or a page that cannot keep one). */
  readonly store?: ProfileStore | null
  /** The dice's seed for a new operator. */
  readonly seed?: () => number
  /** The clock rounds and rests are measured on, ms. */
  readonly now?: () => number
}

/** The keeper. Every method that changes the record saves it and tells the listeners. */
export interface Progress {
  /** The live record (read it; change it only through these methods). */
  readonly record: ProgressRecord
  /**
   * A check in `skill` for something the operator just did: spends an action (the reaction with `reaction`), rolls,
   * pays and saves. Null, with nothing spent, while the skill rests or no action (or reaction) is left this round.
   */
  earn(skill: number | OperatorSkill, reaction?: boolean): Check | null
  /** A hero point spent to reroll the last check. Throws why not. */
  reroll(): Check
  /** Spends a skill increase on `skill`; the rank it reached. Throws why not. */
  train(skill: number | OperatorSkill): string
  /** The purchase gate (progression.ts buy): credits and unlock in one record, one save. */
  buy(space: UnlockSpace, index: number, levelReq: number, price: number): PurchaseResult
  canBuy(space: UnlockSpace, index: number, levelReq: number, price: number): PurchaseResult
  owns(space: UnlockSpace, index: number): boolean
  /** Spends credits on something that is not an unlock; false when there are not enough. */
  spend(price: number): boolean
  /** Spends resolve; false when there is not that much. */
  spendResolve(n: number): boolean
  /** The last check made (or rerolled), or null. */
  last(): Check | null
  /** How long until `skill` earns again, ms (0 when it may now). */
  restFor(skill: number): number
  /** Calls `fn` after every change (with the check, when a check made it); returns the unsubscribe. */
  subscribe(fn: (check: Check | null) => void): () => void
  /** A new operator: everything earned and bought is gone. */
  reset(): void
  /** Why the stored record was set aside when the page started (it failed its checks), or null. */
  setAside(): string | null
}

const seedNow = (): number => {
  try {
    const a = new Uint32Array(1)
    globalThis.crypto.getRandomValues(a)
    return a[0] | 0
  } catch {
    return Date.now() | 0
  }
}
const clock = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now())

/** The keeper over a stored record (or a new one), with a new session started (one hero point at least, a full round). */
export function createProgress(opts: ProgressOptions = {}): Progress {
  const store = opts.store
  const now = opts.now ?? clock
  const loaded = store === null ? { record: null } : loadProgress(store)
  const record = loaded.record ?? newRecord((opts.seed ?? seedNow)())
  startSession(record)
  const why = loaded.record === null && 'why' in loaded ? (loaded.why ?? null) : null
  const listeners = new Set<(check: Check | null) => void>()
  const rested = new Float64Array(SKILL_COUNT).fill(-Infinity)
  let roundStart = now()
  let last: Check | null = null
  const changed = (check: Check | null): void => {
    if (store !== null) saveProgress(record, store)
    for (const fn of [...listeners]) {
      try { fn(check) } catch { /* a listener's failure is its own */ }
    }
  }
  const index = (skill: number | OperatorSkill): number => {
    const s = typeof skill === 'number' ? skill : skillIndex(skill)
    if (!(Number.isInteger(s) && s >= 0 && s < SKILL_COUNT)) throw new RangeError(`no skill '${String(skill)}': ${OPERATOR_SKILLS.join(', ')}`)
    return s
  }
  const tick = (): void => {
    const t = now()
    if (t - roundStart >= ROUND_MS) {
      roundStart = t
      newRound(record)
    }
  }
  return Object.freeze({
    record,
    earn(skill: number | OperatorSkill, reaction = false): Check | null {
      const s = index(skill)
      tick()
      const t = now()
      if (t - rested[s] < SKILL_REST_MS) return null
      if (!spendAction(record, reaction)) return null
      rested[s] = t
      last = attempt(record, s)
      changed(last)
      return last
    },
    reroll(): Check {
      if (!last) throw new Error('no check to reroll yet')
      last = rerollIn(record, last)
      changed(last)
      return last
    },
    train(skill: number | OperatorSkill): string {
      const rank = trainIn(record, index(skill))
      changed(null)
      return rank
    },
    buy(space: UnlockSpace, i: number, levelReq: number, price: number): PurchaseResult {
      const r = buyIn(record, space, i, levelReq, price)
      if (r === PURCHASE.bought) changed(null)
      return r
    },
    canBuy: (space: UnlockSpace, i: number, levelReq: number, price: number): PurchaseResult => canBuyIn(record, space, i, levelReq, price),
    owns: (space: UnlockSpace, i: number): boolean => ownsIn(record, space, i),
    spend(price: number): boolean {
      const ok = spendIn(record, price)
      if (ok) changed(null)
      return ok
    },
    spendResolve(n: number): boolean {
      const ok = spendResolveIn(record, n)
      if (ok) changed(null)
      return ok
    },
    last: (): Check | null => last,
    restFor: (s: number): number => Math.max(0, SKILL_REST_MS - (now() - rested[index(s)])),
    subscribe(fn: (check: Check | null) => void): () => void {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    reset(): void {
      newRecord(seedNow(), record)
      rested.fill(-Infinity)
      last = null
      roundStart = now()
      changed(null)
    },
    setAside: (): string | null => why,
  })
}

let page: Progress | null = null
/** The page's one keeper, made on first use over this browser's storage (the console, the wardrobe and the properties share it). */
export function pageProgress(): Progress {
  return (page ??= createProgress())
}

// ---------------------------------------------------------------------------------------------------
// Which console commands earn a check

/** A prompt or a line said for a skill (`ask rust: …`, `say design,audio: …`): the skill list, then a colon. */
const SKILLED = /^[^\s:,]+(?:,[^\s:,]+)*:/

/**
 * The skill a console command earns a check in when it ran without an error, or -1 for none. Reading the city
 * (status, help, a list, a dry plan) earns nothing; doing something in it does. `args` as the console parsed them:
 * the rest of the line in one piece for the commands that take it raw (noir, r0, run, ask, say, swarm, sloane).
 */
export function commandSkill(name: string, args: readonly string[]): number {
  const head = (args[0] ?? '').trim().split(/\s+/)[0].toLowerCase()
  const any = args.length > 0 && head !== ''
  switch (name) {
    case 'noir':
    case 'r0': return any && head !== 'reset' && head !== 'words' && head !== 'asm' ? COMPUTERS : -1
    case 'run': return any ? COMPUTERS : -1
    case 'robot': return ['spawn', 'urdf', 'demo', 'set', 'arm', 'calibrate', 'mode'].includes(head) ? ROBOTICS : -1
    case 'harness': return head === 'run' ? SECURITY : -1
    case 'act': return head === 'ok' ? SWARM : head === 'gate' || (head === 'log' && args[1] === 'verify') ? SECURITY : -1
    case 'swarm': return head === 'run' ? SWARM : head === 'audit' && /\sverify\b/.test(args[0] ?? '') ? SECURITY : -1
    case 'recruit': return !any || ['stop', 'install', 'dismiss'].includes(head) ? -1 : head === 'listen' ? VOICE : SWARM
    case 'ask': return SKILLED.test((args[0] ?? '').trim()) ? SWARM : -1
    case 'ping': return any && head !== 'clear' ? SWARM : -1
    case 'say': return SKILLED.test((args[0] ?? '').trim()) ? VOICE : -1
    case 'sloane': return head === 'say' ? VOICE : -1
    case 'rain':
    case 'ghost':
    case 'time': return any ? OPTICS : -1
    case 'xr': return head === 'vr' || head === 'ar' ? OPTICS : -1
    case 'record': return head === 'start' ? OPTICS : -1
    case 'look': return any && head !== 'show' ? COMMERCE : -1
    default: return -1
  }
}

// ---------------------------------------------------------------------------------------------------
// The console's text

/** Thousands with commas (the same on every machine, unlike a locale's). */
export const grouped = (n: number): string => String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const signed = (n: number): string => (n < 0 ? `-${-n}` : `+${n}`)
const times = (q8: number): string => `x${(q8 / 256).toFixed(2).replace(/0$/, '')}`
const DEGREE_WORD: readonly string[] = ['critical failure', 'failure', 'success', 'critical success']

/** The round's actions as pips: filled for each left, hollow for each spent, and the reaction's mark while it is left. */
export function pips(rec: ProgressRecord): string {
  const a = actionsLeft(rec)
  return `${'◆'.repeat(a)}${'◇'.repeat(ACTIONS_PER_ROUND - a)}${reactionLeft(rec) ? ' ↺' : ''}`
}

/** What one check said and paid, as the console prints it (`heroLeft`: the hero points the operator has now). */
export function checkLines(c: Check, heroLeft = 0): string[] {
  const dice = c.rolls.length > 1 ? `${c.rolls.join(' and ')}, kept ${c.natural}` : String(c.natural)
  const pay = [c.xp ? `+${c.xp} XP` : '', c.credits ? `+${grouped(c.credits)} credits` : '', c.hero ? `+${c.hero} hero point` : ''].filter(Boolean).join(', ')
  const lines = [
    `${SKILL_TITLE[c.skill]}${c.reroll ? ' (hero point reroll)' : ''}: ${dice} ${signed(c.modifier)} = ${c.total} vs DC ${c.dc}, ${DEGREE_WORD[c.degree]}` +
      `${pay ? ` · ${pay}` : c.reroll ? ' · nothing more than the first roll paid' : ''}${c.breadth > 1 && (c.xp || c.credits) ? ` (${c.breadth} skills this cycle, ${times(c.breadthQ8)})` : ''}`,
  ]
  if (c.guarded) lines.push(`  ${GUARD_AFTER} misses in a row, so this check rolled twice and kept the higher die`)
  if (c.overdrive) lines.push(`  all ${SKILL_COUNT} skills this cycle: ${times(BREADTH_Q8[SKILL_COUNT])} for the rest of it, and +1 resolve`)
  for (const up of c.levels) {
    lines.push(`  level ${up.level}: a skill increase to spend (progress train <skill>)${up.boosts.length ? `; attribute boosts ${up.boosts.join(', ')}` : ''}`)
  }
  if (!c.reroll && c.degree <= FAILURE && heroLeft > 0) lines.push('  progress reroll spends a hero point on this check')
  return lines
}

/** The console's `progress`: the operator as they stand. */
export function statusLines(p: Progress): string[] {
  const rec = p.record
  const level = rec[AT.level]
  const xp = level >= MAX_LEVEL ? 'top level' : `${rec[AT.xp]}/${XP_PER_LEVEL} XP`
  const attrs = ATTRIBUTES.map((_, a) => `${ATTRIBUTE_SHORT[a]} ${signed(rec[AT.attributes + a])}`).join('  ')
  const skills = OPERATOR_SKILLS.map((name, s) => {
    const rest = p.restFor(s)
    return `  ${name.padEnd(10)}${RANKS[rec[AT.ranks + s]].padEnd(10)}${signed(modifierOf(rec, s)).padStart(3)}  ${ATTRIBUTE_SHORT[SKILL_ATTRIBUTE[s]]}  ${SKILL_DOES[s]}${rest > 0 ? ` (rests ${Math.ceil(rest / 1000)} s)` : ''}`
  })
  const used = popcount(wordsOf(rec)[AT.breadth])
  const lines = [
    `level ${level} · ${xp} · ${grouped(rec[AT.credits])} credits · hero ${rec[AT.hero]}/${HERO_MAX} · resolve ${rec[AT.resolve]}/${resolveCap(rec)} · actions ${pips(rec)}`,
    `  ${attrs}`,
    ...skills,
    `  cycle: ${used} of ${SKILL_COUNT} skills (${times(BREADTH_Q8[used])}), ${rec[AT.cycle]} of ${CYCLE_CHECKS} checks · next check DC ${dcOf(rec)} (easy) · a success pays ${grouped(TASK_PAYOUT[level])} credits`,
  ]
  const increases = rec[AT.increases]
  if (increases > 0) {
    const can = OPERATOR_SKILLS.filter((_, s) => whyNoIncrease(rec, s) === null)
    lines.push(`  ${increases} skill increase${increases === 1 ? '' : 's'} to spend: progress train <skill>${can.length ? ` (${can.join(', ')})` : ' (none can rise until a higher level)'}`)
  }
  const why = p.setAside()
  if (why) lines.push(`  the record kept before was set aside (${why}); this is a new operator`)
  return lines
}

/** The console's `progress table`: the DC, a success's pay and the level's treasure at every level, and the degrees and breadth. */
export function tableLines(): string[] {
  const rows = []
  for (let level = 1; level <= MAX_LEVEL; level++) {
    rows.push(`  ${String(level).padStart(5)}  ${String(DC_BY_LEVEL[level] + EASY).padStart(3)}  ${grouped(TASK_PAYOUT[level]).padStart(8)}  ${grouped(LEVEL_TREASURE[level]).padStart(10)}`)
  }
  const deg = (d: number): string =>
    `${DEGREE_WORD[d]} ${REWARD.xp[d]} XP${REWARD.payQ8[d] ? `, ${times(REWARD.payQ8[d])} the payout` : ''}${REWARD.hero[d] ? ', a hero point' : ''}`
  return [
    '  level   DC    payout    treasure',
    ...rows,
    `  each check: a d20 plus the skill's modifier against the DC (the level's, eased by ${-EASY}); ${XP_PER_LEVEL} XP to a level`,
    `  degrees: ${[CRIT_FAILURE, FAILURE, SUCCESS, CRIT_SUCCESS].map(deg).join(' · ')}`,
    `  breadth: ${BREADTH_Q8.slice(1).map((q, i) => `${i + 1} ${times(q)}`).join(' · ')} (skills used in a cycle of ${CYCLE_CHECKS} checks; XP and credits alike)`,
    `  ${ACTIONS_PER_ROUND} actions and a reaction every ${ROUND_MS / 1000} s; each skill earns again after ${SKILL_REST_MS / 1000} s; after ${GUARD_AFTER} misses in a row the next check rolls twice`,
  ]
}

/** The console's `progress` surface (terminal/bridge.ts ProgressBridge) over a keeper. */
export function progressBridge(p: Progress): {
  status(): string[]; table(): string[]; train(skill: string): string; reroll(): string[]; reset(): string; command(name: string, args: readonly string[]): string[]
} {
  return Object.freeze({
    status: () => statusLines(p),
    table: () => tableLines(),
    train: (skill: string): string => {
      const s = skillIndex(skill)
      if (s < 0) throw new RangeError(`no skill '${skill}': ${OPERATOR_SKILLS.join(', ')}`)
      return `${SKILL_TITLE[s]} is ${p.train(s)} now (${signed(modifierOf(p.record, s))})`
    },
    reroll: (): string[] => checkLines(p.reroll(), p.record[AT.hero]),
    reset: (): string => {
      p.reset()
      return `a new operator: level 1, ${grouped(p.record[AT.credits])} credits, every skill trained`
    },
    command: (name: string, args: readonly string[]): string[] => {
      const s = commandSkill(name, args)
      if (s < 0) return []
      const c = p.earn(s)
      return c ? checkLines(c, p.record[AT.hero]) : []
    },
  })
}
