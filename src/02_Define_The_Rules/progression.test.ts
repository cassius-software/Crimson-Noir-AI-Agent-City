// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the operator's progression to its tables and its rules: the record's layout (the
 * plan's indices kept, the unlock spaces apart), the ORC-licensed tables as published (the level-based DCs, the
 * treasure by level at ten credits to the gold piece), a check's numbers and pay, XP rolling over at 1,000 and stopping
 * at level 20, skill increases and their level gates, attribute boosts (partial at +4), hero point rerolls, the breadth
 * bonus and its cycle, the bad-luck guard, the purchase gate's every outcome, and the seal and validation that keep a
 * damaged record out. A property suite plays thousands of seeded checks and holds every field in range.
 * What breaks if it is removed? A drifting table, a level past 20, credits below zero or a purchase that took the
 * credits without the item would ship unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CRIT_FAILURE, CRIT_SUCCESS, FAILURE, SUCCESS, outcomeDistribution, proficiencyBonus } from './degrees.ts'
import { forAll } from './property.ts'
import {
  ACTIONS_PER_ROUND, AT, ATTRIBUTES, BREADTH_Q8, CREDITS_MAX, CYCLE_CHECKS, DC_BY_LEVEL, EASY, GUARD_AFTER, HERO_MAX, LEVEL_TREASURE, MAX_LEVEL,
  OPERATOR_SKILLS, PURCHASE, RECORD_LAYOUT, RECORD_WORDS, REWARD, SKILL_ATTRIBUTE, SKILL_COUNT, SKILL_TITLE, STARTING_CREDITS, TASK_PAYOUT,
  UNLOCK_BITS, UNLOCK_SPACE, XP_PER_LEVEL, actionsLeft, attempt, buy, canBuy, dcOf, gainXp, modifierOf, newRecord, newRound, owns, payOf, popcount,
  reactionLeft, reroll, resolveCap, seal, sealOf, skillIndex, spend, spendAction, spendResolve, startSession, train, whyInvalid, whyNoIncrease,
  whyNoReroll, wordsOf, type Check, type UnlockSpace,
} from './progression.ts'

const fresh = (seed = 7) => newRecord(seed)

test('the record: 128 words, the plan\'s indices kept, the seal last of the first half, the unlock bits after it', () => {
  assert.equal(RECORD_WORDS, 128)
  assert.equal(AT.level, 14)
  assert.equal(AT.xp, 15)
  assert.equal(AT.credits, 16)
  assert.equal(AT.hero, 17)
  assert.equal(AT.resolve, 18)
  assert.equal(AT.actions, 19)
  assert.equal(AT.breadth, 20)
  assert.equal(AT.attributes, 0)
  assert.equal(AT.ranks, 6)
  assert.equal(AT.seal, 63)
  assert.equal(AT.unlocks, 64)
  // Every field has its own word (the uses take eight), and none reaches the seal or the unlocks.
  const words = new Map<number, string>()
  const width: Partial<Record<keyof typeof AT, number>> = { attributes: ATTRIBUTES.length, ranks: SKILL_COUNT, uses: SKILL_COUNT, unlocks: RECORD_WORDS - AT.unlocks }
  for (const [k, at] of Object.entries(AT) as [keyof typeof AT, number][]) {
    for (let i = 0; i < (width[k] ?? 1); i++) {
      assert.ok(!words.has(at + i), `${k} overlaps ${words.get(at + i)} at word ${at + i}`)
      words.set(at + i, k)
    }
  }
  assert.equal(UNLOCK_BITS, 2048)
})

test('the unlock spaces lie inside the unlock bits and never overlap', () => {
  const spaces = Object.values(UNLOCK_SPACE).sort((a, b) => a.from - b.from)
  for (let i = 0; i < spaces.length; i++) {
    assert.ok(spaces[i].size > 0)
    assert.ok(spaces[i].from + spaces[i].size <= UNLOCK_BITS)
    if (i > 0) assert.ok(spaces[i - 1].from + spaces[i - 1].size <= spaces[i].from)
  }
})

test('the ORC-licensed tables as published: level-based DCs, and the treasure by level at ten credits to the gold piece', () => {
  assert.deepEqual(DC_BY_LEVEL, [14, 15, 16, 18, 19, 20, 22, 23, 24, 26, 27, 28, 30, 31, 32, 34, 35, 36, 38, 39, 40])
  const gp = [175, 300, 500, 850, 1350, 2000, 2900, 4000, 5700, 8000, 11500, 16500, 25000, 36500, 54500, 82500, 128000, 208000, 355000, 490000]
  assert.deepEqual(LEVEL_TREASURE.slice(1), gp.map((g) => g * 10))
  assert.equal(LEVEL_TREASURE.length, MAX_LEVEL + 1)
  assert.equal(TASK_PAYOUT.length, MAX_LEVEL + 1)
  assert.equal(EASY, -2)
  assert.equal(STARTING_CREDITS, 150, 'fifteen gold pieces of starting wealth')
  for (let l = 2; l <= MAX_LEVEL; l++) {
    assert.ok(TASK_PAYOUT[l] > TASK_PAYOUT[l - 1] && LEVEL_TREASURE[l] > LEVEL_TREASURE[l - 1], `level ${l} pays more than ${l - 1}`)
    // The payout is about a thirteenth of the level's treasure (the plan's curve).
    const r = LEVEL_TREASURE[l] / TASK_PAYOUT[l]
    assert.ok(r > 11 && r < 15, `level ${l}: treasure / payout = ${r}`)
  }
})

test('rewards: by degree, and the breadth bonus from 1x for one skill to 3.5x for all eight', () => {
  assert.deepEqual(REWARD.xp, [0, 10, 40, 80])
  assert.deepEqual(REWARD.payQ8, [0, 0, 256, 640])
  assert.deepEqual(REWARD.hero, [0, 0, 0, 1])
  assert.equal(BREADTH_Q8.length, SKILL_COUNT + 1)
  assert.equal(BREADTH_Q8[1], 256)
  assert.equal(BREADTH_Q8[3], 384)
  assert.equal(BREADTH_Q8[5], 512)
  assert.equal(BREADTH_Q8[8], 896)
  for (let i = 1; i < BREADTH_Q8.length; i++) assert.ok(BREADTH_Q8[i] >= BREADTH_Q8[i - 1])
  assert.deepEqual(payOf(SUCCESS, 1, 256), { xp: 40, credits: 150, hero: 0 })
  assert.deepEqual(payOf(CRIT_SUCCESS, 1, 256), { xp: 80, credits: 375, hero: 1 })
  assert.deepEqual(payOf(SUCCESS, 20, 896), { xp: 140, credits: 1_400_000, hero: 0 })
  assert.deepEqual(payOf(FAILURE, 5, 896), { xp: 35, credits: 0, hero: 0 })
  assert.deepEqual(payOf(CRIT_FAILURE, 5, 896), { xp: 0, credits: 0, hero: 0 })
})

test('a new operator: level 1, +1 everywhere, every skill trained, the starting credits, a hero point, full resolve and a full round', () => {
  const r = fresh()
  assert.equal(whyInvalid(r), null)
  assert.equal(r[AT.level], 1)
  assert.equal(r[AT.xp], 0)
  assert.equal(r[AT.credits], STARTING_CREDITS)
  assert.equal(r[AT.hero], 1)
  assert.equal(r[AT.resolve], resolveCap(r))
  assert.equal(resolveCap(r), 6, '5 plus constitution')
  assert.equal(r[AT.layout], RECORD_LAYOUT)
  assert.equal(actionsLeft(r), ACTIONS_PER_ROUND)
  assert.equal(reactionLeft(r), true)
  for (let s = 0; s < SKILL_COUNT; s++) {
    assert.equal(r[AT.ranks + s], 1)
    assert.equal(modifierOf(r, s), proficiencyBonus(1, 1) + 1, `${OPERATOR_SKILLS[s]}: trained at level 1, +1 attribute`)
  }
  assert.equal(dcOf(r), 13, 'level 1 DC 15, eased by 2')
})

test('skills: eight, each named and keyed to an attribute; constitution keys none', () => {
  assert.equal(OPERATOR_SKILLS.length, 8)
  assert.equal(SKILL_TITLE.length, 8)
  assert.equal(SKILL_ATTRIBUTE.length, 8)
  assert.ok(!SKILL_ATTRIBUTE.includes(2))
  for (let s = 0; s < 8; s++) {
    assert.equal(skillIndex(OPERATOR_SKILLS[s]), s)
    assert.equal(skillIndex(OPERATOR_SKILLS[s].toUpperCase()), s)
  }
  assert.equal(skillIndex('cyber'), 3)
  assert.equal(skillIndex('swarm command'), 4)
  assert.equal(skillIndex('nothing'), -1)
  assert.doesNotMatch(SKILL_TITLE.join(' '), /matrix/i)
})

test('actions: three and a reaction per round, spent one at a time, all back at a new round', () => {
  const r = fresh()
  assert.ok(spendAction(r))
  assert.ok(spendAction(r))
  assert.ok(spendAction(r))
  assert.equal(spendAction(r), false)
  assert.equal(reactionLeft(r), true, 'the actions do not spend the reaction')
  assert.ok(spendAction(r, true))
  assert.equal(spendAction(r, true), false)
  assert.equal(whyInvalid(r), null, 'every spend reseals')
  newRound(r)
  assert.equal(actionsLeft(r), 3)
  assert.equal(reactionLeft(r), true)
})

test('a check: the dice seeded by the record, the numbers as the rules give them, and what it paid added in', () => {
  const a = fresh(42), b = fresh(42)
  const ca = attempt(a, 0), cb = attempt(b, 0)
  assert.deepEqual(ca, cb, 'the same record rolls the same check')
  assert.equal(ca.modifier, 4)
  assert.equal(ca.dc, 13)
  assert.equal(ca.total, ca.natural + 4)
  assert.ok(ca.natural >= 1 && ca.natural <= 20)
  assert.equal(a[AT.rolls], 1)
  assert.equal(a[AT.checks], 1)
  assert.equal(a[AT.uses + 0], 1)
  assert.equal(a[AT.xp], ca.xp)
  assert.equal(a[AT.credits], STARTING_CREDITS + ca.credits)
  assert.equal(whyInvalid(a), null)
  // The next check is a new position.
  const next = attempt(a, 0)
  assert.equal(a[AT.rolls], 2)
  assert.ok(next !== ca)
})

test('over many seeds the checks land on the exact odds of +4 against DC 13', () => {
  const counts = [0, 0, 0, 0]
  const n = 20_000
  for (let seed = 0; seed < n; seed++) counts[attempt(fresh(seed), 0).degree]++
  const exact = outcomeDistribution(4, 13)
  for (let d = 0; d < 4; d++) assert.ok(Math.abs(counts[d] / n - exact[d]) < 0.012, `degree ${d}: ${counts[d] / n} vs ${exact[d]}`)
})

test('XP rolls over at 1,000 into the next level and keeps the rest; at level 20 it stops at 999', () => {
  const r = fresh()
  r[AT.xp] = 990
  seal(r)
  const ups = gainXp(r, 40)
  assert.equal(r[AT.level], 2)
  assert.equal(r[AT.xp], 30)
  assert.equal(ups.length, 1)
  assert.equal(ups[0].level, 2)
  assert.equal(r[AT.increases], 1)
  const top = fresh()
  top[AT.level] = MAX_LEVEL
  seal(top)
  gainXp(top, 5000)
  assert.equal(top[AT.level], MAX_LEVEL)
  assert.equal(top[AT.xp], XP_PER_LEVEL - 1)
  assert.equal(whyInvalid(top), null)
})

test('levels: a skill increase at each, four boosts at 5, 10, 15 and 20 to the attributes behind the skills used most, and a resolve', () => {
  const r = fresh()
  // Computers (INT) most, then piloting (DEX), then swarm (CHA), then security (WIS).
  r[AT.uses + 0] = 40
  r[AT.uses + 1] = 30
  r[AT.uses + 4] = 20
  r[AT.uses + 3] = 10
  r[AT.resolve] = 0
  seal(r)
  const ups = gainXp(r, 4 * XP_PER_LEVEL)
  assert.equal(r[AT.level], 5)
  assert.equal(ups.length, 4)
  assert.equal(r[AT.increases], 4)
  assert.deepEqual(ups[3].boosts, ['INT +2', 'DEX +2', 'CHA +2', 'WIS +2'])
  assert.deepEqual(Array.from(r.subarray(AT.attributes, AT.attributes + 6)), [1, 2, 1, 2, 2, 2])
  assert.equal(r[AT.resolve], 4, 'one per level')
})

test('a boost at +4 or more is partial; a second partial boost raises it by one', () => {
  const r = fresh()
  r[AT.attributes + 3] = 4
  r[AT.uses + 0] = 50
  seal(r)
  gainXp(r, 4 * XP_PER_LEVEL)
  assert.equal(r[AT.attributes + 3], 4)
  assert.equal(wordsOf(r)[AT.partial] & (1 << 3), 1 << 3)
  r[AT.level] = 9
  r[AT.xp] = 0
  seal(r)
  gainXp(r, XP_PER_LEVEL)
  assert.equal(r[AT.level], 10)
  assert.equal(r[AT.attributes + 3], 5)
  assert.equal(wordsOf(r)[AT.partial] & (1 << 3), 0)
})

test('skill increases: one per level, expert any time, master from 7, legendary from 15', () => {
  const r = fresh()
  assert.match(whyNoIncrease(r, 0)!, /no skill increase/)
  r[AT.increases] = 3
  seal(r)
  assert.equal(train(r, 0), 'expert')
  assert.match(whyNoIncrease(r, 0)!, /master needs level 7/)
  assert.throws(() => train(r, 0), /master needs level 7/)
  r[AT.level] = 7
  seal(r)
  assert.equal(train(r, 0), 'master')
  assert.match(whyNoIncrease(r, 0)!, /legendary needs level 15/)
  r[AT.level] = 15
  seal(r)
  assert.equal(train(r, 0), 'legendary')
  assert.match(whyNoIncrease(r, 0)!, /no skill increase|legendary already/)
  r[AT.increases] = 1
  seal(r)
  assert.match(whyNoIncrease(r, 0)!, /legendary already/)
  assert.equal(modifierOf(r, 0), 15 + 8 + 1)
  assert.equal(whyNoIncrease(r, 9), 'no such skill')
  assert.equal(whyInvalid(r), null)
})

test('a hero point rerolls a check that was not a critical success; the better result pays, nothing is taken back', () => {
  let rec = fresh(), first: Check | null = null
  for (let seed = 0; seed < 500 && !first; seed++) {
    rec = fresh(seed)
    const c = attempt(rec, 0)
    if (c.degree === CRIT_FAILURE || c.degree === FAILURE) first = c
  }
  assert.ok(first, 'some seed misses its first check')
  const credits = rec[AT.credits], xp = rec[AT.xp]
  assert.equal(whyNoReroll(rec, first), null)
  const second = reroll(rec, first)
  assert.equal(second.reroll, true)
  assert.equal(rec[AT.hero], 0)
  assert.ok(rec[AT.credits] >= credits && (rec[AT.xp] >= xp || rec[AT.level] > 1))
  assert.equal(second.credits, Math.max(0, payOf(second.degree, 1, second.breadthQ8).credits - payOf(first.degree, 1, first.breadthQ8).credits))
  assert.equal(whyNoReroll(rec, second), 'that check was already rerolled')
  assert.equal(whyNoReroll(rec, null), 'no check to reroll yet')
  const none = fresh()
  none[AT.hero] = 0
  seal(none)
  assert.equal(whyNoReroll(none, first), 'no hero point left')
  assert.equal(whyNoReroll(rec, { ...first, degree: CRIT_SUCCESS }), 'that check was a critical success already')
  assert.equal(whyInvalid(rec), null)
})

test('breadth: each new skill in a cycle raises the bonus; the eighth is the overdrive; the cycle starts again after its checks', () => {
  const r = fresh()
  const checks = OPERATOR_SKILLS.map((_, s) => attempt(r, s))
  assert.deepEqual(checks.map((c) => c.breadth), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.deepEqual(checks.map((c) => c.breadthQ8), BREADTH_Q8.slice(1))
  assert.deepEqual(checks.map((c) => c.overdrive), [false, false, false, false, false, false, false, true])
  assert.equal(popcount(wordsOf(r)[AT.breadth]), 8)
  // Repeating a skill keeps the cycle's bonus.
  assert.equal(attempt(r, 0).breadthQ8, BREADTH_Q8[8])
  while (r[AT.cycle] < CYCLE_CHECKS) attempt(r, 1)
  const after = attempt(r, 1)
  assert.equal(after.breadth, 1, 'a new cycle')
  assert.equal(r[AT.cycle], 1)
})

test('the bad-luck guard: after three misses in a row the next check rolls twice and keeps the higher die', () => {
  const r = fresh()
  r[AT.missStreak] = GUARD_AFTER
  seal(r)
  const c = attempt(r, 0)
  assert.equal(c.guarded, true)
  assert.equal(c.rolls.length, 2)
  assert.equal(c.natural, Math.max(...c.rolls))
  assert.equal(r[AT.missStreak], c.degree <= FAILURE ? GUARD_AFTER + 1 : 0)
  const plain = fresh()
  assert.equal(attempt(plain, 0).rolls.length, 1)
})

test('a critical success brings a hero point, never past three', () => {
  for (let seed = 0, found = 0; seed < 4000 && found < 3; seed++) {
    const r = fresh(seed)
    r[AT.hero] = HERO_MAX
    seal(r)
    const c = attempt(r, 0)
    if (c.degree !== CRIT_SUCCESS) continue
    found++
    assert.equal(c.hero, 1)
    assert.equal(r[AT.hero], HERO_MAX)
  }
})

test('resolve: the cap is 5 plus constitution within 1..10; spent only when there is enough', () => {
  const r = fresh()
  r[AT.attributes + 2] = 9
  assert.equal(resolveCap(r), 10)
  r[AT.attributes + 2] = -5
  assert.equal(resolveCap(r), 1)
  r[AT.attributes + 2] = 1
  seal(r)
  assert.equal(spendResolve(r, 7), false)
  assert.equal(spendResolve(r, 0), false)
  assert.ok(spendResolve(r, 2))
  assert.equal(r[AT.resolve], 4)
  assert.equal(whyInvalid(r), null)
})

test('a new session: at least one hero point and a full round', () => {
  const r = fresh()
  r[AT.hero] = 0
  r[AT.actions] = 0
  seal(r)
  startSession(r)
  assert.equal(r[AT.hero], 1)
  assert.equal(actionsLeft(r), 3)
  assert.equal(reactionLeft(r), true)
  r[AT.hero] = 3
  startSession(r)
  assert.equal(r[AT.hero], 3)
})

test('the purchase gate: bought (credits and bit in one record), owned, level, credits, invalid', () => {
  const r = fresh()
  r[AT.credits] = 5000
  r[AT.level] = 3
  seal(r)
  assert.equal(canBuy(r, 'property', 1, 3, 4000), PURCHASE.bought)
  assert.equal(owns(r, 'property', 1), false)
  assert.equal(buy(r, 'property', 1, 3, 4000), PURCHASE.bought)
  assert.equal(r[AT.credits], 1000)
  assert.equal(r[AT.spent], 4000)
  assert.equal(owns(r, 'property', 1), true)
  assert.equal(owns(r, 'look', 1), false, 'the spaces are separate')
  assert.equal(owns(r, 'furniture', 1), false)
  assert.equal(whyInvalid(r), null)
  assert.equal(buy(r, 'property', 1, 3, 4000), PURCHASE.owned)
  assert.equal(r[AT.credits], 1000, 'owned costs nothing')
  assert.equal(buy(r, 'property', 2, 6, 10), PURCHASE.level)
  assert.equal(buy(r, 'property', 3, 1, 1001), PURCHASE.credits)
  assert.equal(r[AT.credits], 1000, 'a refusal costs nothing')
  assert.equal(buy(r, 'look', 0, 1, 0), PURCHASE.bought, 'a free starter item')
  assert.equal(owns(r, 'look', 0), true)
  for (const [space, index, level, price] of [
    ['property', UNLOCK_SPACE.property.size, 1, 0], ['property', -1, 1, 0], ['property', 1.5, 1, 0], ['nowhere', 0, 1, 0],
    ['look', 2, 0, 0], ['look', 2, 21, 0], ['look', 2, 1, -1], ['look', 2, 1, 0.5], ['look', 2, 1, CREDITS_MAX + 1], ['__proto__', 0, 1, 0],
  ] as [UnlockSpace, number, number, number][]) {
    assert.equal(buy(r, space, index, level, price), PURCHASE.invalid, `${space} ${index} ${level} ${price}`)
  }
  assert.equal(owns(r, 'nowhere' as UnlockSpace, 0), false)
  // Every bit of every space can be bought and is found where it was set.
  const all = fresh()
  all[AT.credits] = CREDITS_MAX
  seal(all)
  for (const space of Object.keys(UNLOCK_SPACE) as UnlockSpace[]) {
    for (let i = 0; i < UNLOCK_SPACE[space].size; i++) assert.equal(buy(all, space, i, 1, 1), PURCHASE.bought)
    for (let i = 0; i < UNLOCK_SPACE[space].size; i++) assert.equal(owns(all, space, i), true)
  }
  assert.equal(whyInvalid(all), null)
})

test('spend: credits for a service, never below zero', () => {
  const r = fresh()
  assert.equal(spend(r, STARTING_CREDITS + 1), false)
  assert.ok(spend(r, 50))
  assert.equal(r[AT.credits], STARTING_CREDITS - 50)
  assert.equal(spend(r, -1), false)
  assert.equal(whyInvalid(r), null)
})

test('the seal finds one flipped bit anywhere; validation refuses a record out of range or of another layout', () => {
  const r = fresh()
  for (const i of [0, 14, 16, 40, 64, 100, 127]) {
    const c = new Int32Array(r)
    c[i] ^= 1
    assert.notEqual(sealOf(c), sealOf(r), `word ${i}`)
    assert.equal(whyInvalid(c), 'the seal does not match')
  }
  const bad = (f: (c: Int32Array) => void): string | null => {
    const c = new Int32Array(r)
    f(c)
    seal(c)
    return whyInvalid(c)
  }
  assert.equal(bad((c) => { c[AT.level] = 21 }), 'level out of range')
  assert.equal(bad((c) => { c[AT.level] = 0 }), 'level out of range')
  assert.equal(bad((c) => { c[AT.xp] = 1000 }), 'XP out of range')
  assert.equal(bad((c) => { c[AT.credits] = -1 }), 'credits out of range')
  assert.equal(bad((c) => { c[AT.hero] = 4 }), 'hero points out of range')
  assert.equal(bad((c) => { c[AT.resolve] = 11 }), 'resolve out of range')
  assert.equal(bad((c) => { c[AT.ranks + 2] = 5 }), 'a rank out of range')
  assert.equal(bad((c) => { c[AT.attributes] = 11 }), 'an attribute out of range')
  assert.equal(bad((c) => { c[AT.layout] = 2 }), 'layout 2, not 1')
  assert.equal(whyInvalid(new Int32Array(64)), 'not a record')
  assert.equal(whyInvalid([] as unknown as Int32Array), 'not a record')
})

test('property: thousands of seeded checks, rerolls, trainings and purchases keep every field in range and the seal whole', () => {
  forAll('progression', { seed: 0x5eed, runs: 200 }, (g) => ({ seed: g.int(-0x80000000, 0x7fffffff), steps: Array.from({ length: 60 }, () => [g.int(0, 9), g.int(0, 7), g.int(0, 2000)]) }), ({ seed, steps }) => {
    const r = newRecord(seed)
    let last: Check | null = null
    for (const [op, s, n] of steps) {
      if (op <= 5) last = attempt(r, s)
      else if (op === 6 && last && !whyNoReroll(r, last)) last = reroll(r, last)
      else if (op === 7 && !whyNoIncrease(r, s)) train(r, s)
      else if (op === 8) buy(r, (['look', 'property', 'furniture'] as const)[s % 3], n % 64, 1 + (n % 20), n)
      else gainXp(r, n)
      assert.equal(whyInvalid(r), null, `after op ${op}`)
    }
  })
})
