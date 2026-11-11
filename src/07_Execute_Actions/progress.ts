// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the page's keeper of the operator's progression: the one record
 * (02_Define_The_Rules/progression.ts), loaded at start and saved after every change
 * (05_Observe_Environment/progressStore.ts), the round clock (three actions and a reaction every six seconds), each
 * skill's rest (a skill earns again a minute after its last check), the last check (a hero point may reroll it), and
 * whoever listens for a check (the console, the chime and the pad's pulse). It also decides which console commands
 * earn a check, in which skill, which of the recruiter's events earn one (someone arriving, a spoken request
 * understood), and writes the words: the console's `progress` text and the HUD's progress chip, finished here so the
 * HUD imports nothing of the keeper. The wardrobe and the properties buy through `buy`, which debits the credits and
 * sets the unlock in the same record and the same save. It keeps a rest at home (the home card's Rest), and its words.
 * What breaks if it is removed? Nothing earns XP or credits, `progress` and the HUD have nothing to show, and nothing
 * can be bought.
 */
import { CRIT_FAILURE, CRIT_SUCCESS, FAILURE, RANKS, SUCCESS } from '../02_Define_The_Rules/degrees.ts'
import {
  ACTIONS_PER_ROUND, AT, ATTRIBUTE_SHORT, ATTRIBUTES, BREADTH_Q8, COMFORT_STEPS, CYCLE_CHECKS, DC_BY_LEVEL, EASY, GUARD_AFTER, HERO_MAX,
  ITEM_BONUS_LEVELS, LEVEL_TREASURE, MAX_LEVEL, OPERATOR_SKILLS, PURCHASE, REST_CHECKS, REWARD, ROUND_MS, SKILL_ATTRIBUTE, SKILL_COUNT, SKILL_DOES,
  SKILL_REST_MS, SKILL_TITLE, TASK_PAYOUT, XP_PER_LEVEL, actionsLeft, attempt, buy as buyIn, canBuy as canBuyIn, dcOf, homeRest as homeRestIn,
  itemBonusOf, modifierOf, newRecord, newRound, owns as ownsIn, popcount, preparedLeft, reactionLeft, reroll as rerollIn, resolveCap, restBonus,
  skillIndex, spend as spendIn, spendAction, spendResolve as spendResolveIn, startSession, train as trainIn, whyNoIncrease, whyNoRest, wordsOf,
  type Check, type OperatorSkill, type ProgressRecord, type PurchaseResult, type UnlockSpace,
} from '../02_Define_The_Rules/progression.ts'
import { loadProgress, saveProgress } from '../05_Observe_Environment/progressStore.ts'
import type { ProfileStore } from '../05_Observe_Environment/profile.ts'
import type { HudProgress } from '../05_Observe_Environment/telemetry.ts'
import type { RecruitEvents } from '../08_Swarm/recruitment.ts'

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
  /**
   * A rest at home with item bonus `bonus` (progression.ts homeRest): saved and told, the round clock started again
   * with the full round. Throws why not; the hero points it gave.
   */
  restAtHome(bonus: number): number
  /** The last check made (or rerolled), or null. */
  last(): Check | null
  /** How long until `skill` earns again, ms (0 when it may now). */
  restFor(skill: number): number
  /**
   * Runs the round clock, as earn does: a new round (three actions and the reaction) once ROUND_MS has passed since
   * this one began. Returns ms to the next. Neither saved nor told, because a new session starts with a full round
   * anyway; the HUD and the console's `progress` call it so their pips refill without waiting for the next check.
   */
  round(): number
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
    restAtHome(bonus: number): number {
      const n = homeRestIn(record, bonus)
      roundStart = now()
      changed(null)
      return n
    },
    last: (): Check | null => last,
    restFor: (s: number): number => Math.max(0, SKILL_REST_MS - (now() - rested[index(s)])),
    round(): number {
      tick()
      return Math.min(ROUND_MS, Math.max(0, ROUND_MS - (now() - roundStart)))
    },
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
// What the recruiter's events earn

/**
 * All earnFromRecruiter needs of the recruiter (08_Swarm/recruitment.ts Recruiter): its events. Typed this narrowly so
 * this file never loads the recruiter, the skills or the city to earn from them.
 */
export type RecruitFeed = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

/** Someone recruited reached the operator (once per recruit, however they were asked), and a spoken request understood. */
const ARRIVED = 'active' satisfies keyof RecruitEvents
const UNDERSTOOD = 'understood' satisfies keyof RecruitEvents

/**
 * Earns from what the recruiter says happened: Swarm command when someone recruited arrives, spent from the reaction
 * because the city chose the moment and the round's actions stay the operator's, and Acoustics and voice when a spoken
 * request is understood. The keeper's rests and rounds still decide, so an event while the skill rests earns nothing.
 * Returns the unsubscribe.
 */
export function earnFromRecruiter(p: Progress, feed: RecruitFeed): () => void {
  const arrived = (): void => { p.earn('swarm', true) }
  const understood = (): void => { p.earn('voice') }
  feed.addEventListener(ARRIVED, arrived)
  feed.addEventListener(UNDERSTOOD, understood)
  return () => {
    feed.removeEventListener(ARRIVED, arrived)
    feed.removeEventListener(UNDERSTOOD, understood)
  }
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
    // Asking for a skill earns nothing here: the arrival earns Swarm command, once for every way of recruiting, and a
    // spoken request understood earns Acoustics and voice (earnFromRecruiter), so opening the microphone does not.
    case 'recruit': return head === 'rally' ? SWARM : -1
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
/** A rest's steps as words: '+1 from <the first, named>, +2 from 9, +3 from 17'. */
const ladder = (steps: readonly number[], first: (n: number) => string): string =>
  steps.map((n, i) => `+${i + 1} from ${i === 0 ? first(n) : n}`).join(', ')
const kindsOf = (n: number): string => `${n} kind${n === 1 ? '' : 's'}`

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
    `${SKILL_TITLE[c.skill]}${c.reroll ? ' (hero point reroll)' : ''}: ${dice} ${signed(c.modifier - c.item)}${c.item ? ` +${c.item} prepared` : ''} = ${c.total} vs DC ${c.dc}, ${DEGREE_WORD[c.degree]}` +
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
  // The round first, so these pips agree with the HUD's after a quiet spell.
  p.round()
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
  const left = preparedLeft(rec), prep = itemBonusOf(rec)
  if (left > 0) {
    const more = `${left} more check${left === 1 ? '' : 's'}`
    lines.push(prep > 0 ? `  prepared: +${prep} to every check for ${more} (a rest at home)`
      : `  rested at home: another rest after ${more}, or in a home that adds to checks`)
  }
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
    `  rest at a home you own (its card's Rest tab): a hero point, a new round, and on the next ${REST_CHECKS} checks the lower of the home's bonus` +
      ` (${ladder(ITEM_BONUS_LEVELS, (n) => `a level ${n} deed`)}) and its comfort's (${ladder(COMFORT_STEPS, (n) => `${kindsOf(n)} of furniture standing there`)})`,
  ]
}

// ---------------------------------------------------------------------------------------------------
// A rest at home: the home card's words

/** What a rest at a home would give now, in finished words for the card: the bonus, why not (null when it may), and the lines. */
export interface RestOffer {
  readonly bonus: number
  readonly why: string | null
  readonly lines: readonly string[]
}

/** The first sentence of a rest's offer: what it gives here, or why not now. */
function offerLine(p: Progress, bonus: number, cap: number, why: string | null): string {
  const rec = p.record
  const left = preparedLeft(rec), running = itemBonusOf(rec)
  if (why !== null) {
    const more = `${left} more check${left === 1 ? '' : 's'}`
    return running > 0 ? `You are prepared: +${running} to every check for ${more}. Rest again after ${left === 1 ? 'it' : 'them'}, or in a home that adds more.`
      : `You have rested: rest again after ${more}, or in a home that adds to checks.`
  }
  const full = rec[AT.hero] >= HERO_MAX
  const heroFull = full ? ` Your hero points are full (${rec[AT.hero]} of ${HERO_MAX}).` : ''
  if (bonus > 0) {
    const instead = left > 0 && running > 0 ? `, in place of your +${running}` : ''
    return `Rest here: ${full ? '' : 'a hero point, '}a new round, and +${bonus} to every check for the next ${REST_CHECKS} checks${instead}.${heroFull}`
  }
  const none = cap === 0 ? `A home adds to checks from a level ${ITEM_BONUS_LEVELS[0]} deed.` : 'No bonus on checks yet: furniture standing here adds one.'
  return `Rest here: ${full ? 'a new round' : 'a hero point and a new round'}. ${none}${heroFull}`
}

/**
 * A rest at a home whose deed is level `deedLevel` with `kinds` kinds of furniture standing in it (homeLayout.ts
 * comfortOf), as the home card shows it: the bonus it gives (progression.ts restBonus), why it cannot be taken now
 * (whyNoRest, null when it can), and the lines: what it gives here or why not, then, where the home can add to checks
 * at all, its comfort and the most it allows.
 */
export function restOffer(p: Progress, deedLevel: number, kinds: number): RestOffer {
  const bonus = restBonus(deedLevel, kinds)
  const cap = restBonus(deedLevel, COMFORT_STEPS[COMFORT_STEPS.length - 1])
  const why = whyNoRest(p.record, bonus)
  const lines = [offerLine(p, bonus, cap, why)]
  if (cap > 0) {
    const k = Number.isFinite(kinds) ? Math.max(0, Math.floor(kinds)) : 0
    const stand = k === 0 ? 'no furniture stands here yet' : `${kindsOf(k)} of furniture stand${k === 1 ? 's' : ''} here`
    lines.push(`Comfort: ${stand}. Furniture adds ${ladder(COMFORT_STEPS, kindsOf).replace(/, (?=[^,]*$)/, ' and ')}; this home allows up to +${cap}.`)
  }
  return Object.freeze({ bonus, why, lines: Object.freeze(lines) })
}

/**
 * The rest itself, through the keeper (restAtHome), at a home of `deedLevel` with `kinds` kinds of furniture: the
 * sentence that says what it gave, or, refused, the offer's own sentence for why not.
 */
export function restTake(p: Progress, deedLevel: number, kinds: number): string {
  const offer = restOffer(p, deedLevel, kinds)
  if (offer.why !== null) return offer.lines[0]
  const n = p.restAtHome(offer.bonus)
  const hero = p.record[AT.hero]
  const bonus = offer.bonus > 0 ? `+${offer.bonus} to every check for the next ${REST_CHECKS} checks` : ''
  if (n > 0) return bonus ? `Rested: hero ${hero} of ${HERO_MAX}, a new round, and ${bonus}.` : `Rested: hero ${hero} of ${HERO_MAX} and a new round.`
  return bonus ? `Rested: a new round, and ${bonus} (hero points already ${hero} of ${HERO_MAX}).` : `Rested: a new round (hero points already ${hero} of ${HERO_MAX}).`
}

// ---------------------------------------------------------------------------------------------------
// The HUD's progress chip

/**
 * The last check worth a cue, as the host keeps it: plain numbers it sets from the keeper's listener (cueOf), so the
 * HUD loop reads a variable and no React state changes inside a check. `at` is on the clock hudProgress gets as `now`.
 */
export interface ProgressCue {
  readonly degree: number
  readonly skill: number
  readonly xp: number
  readonly credits: number
  readonly hero: number
  readonly at: number
}

/** How long a check stays fresh on the HUD, ms: its words shown, and the phone's chip up. */
export const HUD_CUE_MS = 4000

/**
 * Whether check `c` is cued (the chime, the tap, the HUD's words and its ring): a success or a critical success, but
 * not a hero point's reroll that stayed where the first roll was. A reroll pays only what it adds (progression.ts
 * reroll), and every step up to a success adds XP or a hero point, so a reroll that paid nothing climbed nothing and
 * would only repeat a success already cued.
 */
export const worthCue = (c: Check | null): c is Check =>
  c !== null && c.degree >= SUCCESS && !(c.reroll && c.xp === 0 && c.credits === 0 && c.hero === 0)

/** The cue for check `c` made at `at`. */
export const cueOf = (c: Check, at: number): ProgressCue =>
  Object.freeze({ degree: c.degree, skill: c.skill, xp: c.xp, credits: c.credits, hero: c.hero, at })

const counted = (n: number, one: string): string => `${grouped(n)} ${one}${n === 1 ? '' : 's'}`
const sameCue = (a: ProgressCue | null, b: ProgressCue | null): boolean =>
  a === b || (a !== null && b !== null && a.at === b.at && a.degree === b.degree && a.skill === b.skill && a.xp === b.xp && a.credits === b.credits && a.hero === b.hero)

/** What the chip was last built from, per keeper, so a HUD tick with nothing new builds no strings. */
interface HudMemo {
  readonly words: Int32Array
  readonly cue: ProgressCue | null
  readonly fresh: boolean
  readonly out: HudProgress
}
const memos = new WeakMap<Progress, HudMemo>()
/** The record words the chip shows: level, XP, credits, hero points, the round, a rest at home. */
const SHOWN = [AT.level, AT.xp, AT.credits, AT.hero, AT.actions, AT.prepared] as const

/**
 * The HUD's progress chip as finished strings: the standing ('Level 3 · 420 of 1,000 XP · 1,250 credits · hero 2 ·
 * ◆◆◇ ↺', then ' · prepared +2' while a rest at home adds to checks), the same in full words for a screen reader,
 * and the fresh check (`cue`, made within HUD_CUE_MS of `now`): which degree, in which skill, and what it paid. Runs
 * the round clock first, so the pips refill on their own. Returns the same object while nothing it shows has changed,
 * so calling it at the HUD's cadence costs a few comparisons.
 */
export function hudProgress(p: Progress, cue: ProgressCue | null, now: number): HudProgress {
  p.round()
  const rec = p.record
  const age = cue === null ? Infinity : Math.max(0, now - cue.at)
  const fresh = cue !== null && cue.degree >= SUCCESS && age < HUD_CUE_MS
  const memo = memos.get(p)
  if (memo && memo.fresh === fresh && sameCue(memo.cue, cue) && SHOWN.every((at, i) => memo.words[i] === rec[at])) {
    return fresh ? Object.freeze({ ...memo.out, cueAge: age }) : memo.out
  }
  const level = rec[AT.level]
  const top = level >= MAX_LEVEL
  const hero = rec[AT.hero]
  const left = actionsLeft(rec)
  const round = pips(rec)
  const prep = itemBonusOf(rec)
  const xp = top ? 'top level' : `${grouped(rec[AT.xp])} of ${grouped(XP_PER_LEVEL)} XP`
  const said = [
    `Level ${level}`,
    top ? 'the top level' : `${grouped(rec[AT.xp])} of ${grouped(XP_PER_LEVEL)} experience points`,
    counted(rec[AT.credits], 'credit'),
    counted(hero, 'hero point'),
    `${left} of ${ACTIONS_PER_ROUND} actions left this round`,
    `reaction ${reactionLeft(rec) ? 'ready' : 'spent'}`,
    ...(prep > 0 ? [`prepared: ${prep} added to every check`] : []),
  ].join(', ')
  let cueText = ''
  let delta = ''
  let label = said
  if (fresh) {
    const critical = cue.degree >= CRIT_SUCCESS
    cueText = `${critical ? 'Critical success' : 'Success'} in ${SKILL_TITLE[cue.skill] ?? 'a skill'}`
    delta = [cue.xp ? `+${grouped(cue.xp)} XP` : '', cue.credits ? `+${grouped(cue.credits)} credits` : '', cue.hero ? `+${counted(cue.hero, 'hero point')}` : '']
      .filter(Boolean).join(', ')
    const paid = [cue.xp ? counted(cue.xp, 'experience point') : '', cue.credits ? counted(cue.credits, 'credit') : '', cue.hero ? counted(cue.hero, 'hero point') : '']
      .filter(Boolean).join(', ')
    label = `${said}. ${cueText}${paid ? `: ${paid}` : ''}`
  }
  const out: HudProgress = Object.freeze({
    text: `Level ${level} · ${xp} · ${counted(rec[AT.credits], 'credit')} · hero ${hero} · ${round}${prep ? ` · prepared +${prep}` : ''}`,
    label,
    pips: round,
    cue: fresh ? (cue.degree >= CRIT_SUCCESS ? 'critical' : 'success') : null,
    cueText,
    delta,
    cueAt: fresh ? cue.at : -1,
    cueAge: fresh ? age : Infinity,
  })
  memos.set(p, { words: Int32Array.from(SHOWN, (at) => rec[at]), cue, fresh, out })
  return out
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
