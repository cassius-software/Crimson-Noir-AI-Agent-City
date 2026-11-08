// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the shops' catalogue, the purse and the shopkeeper (storeCatalog.ts,
 * shopkeeper.ts) to their promises: ids and bits stable and unique, every bit inside its unlock space and the worn
 * lines inside the shops' own range of the look space; the spaces, the level cap and the verdicts the progression
 * engine's own (progression.ts); every worn line on sale dresses every body in something the wardrobe has; the deeds
 * are on sale and dress nobody, while the furniture stays on order until furnishing opens; a line on order is never
 * sold; the progression keeper (progress.ts createProgress) buys a line once, takes its price from the record, sets its
 * bit and keeps both across a reload, and refuses with the first reason; a new operator claims the free loft and is
 * told the level the brownstone needs, and a keeper at that level buys it; a keeper that refuses leaves no bit; the
 * 14A screen passes every name.
 * What breaks if it is removed? A shop could sell a line twice, sell a line nobody can wear, take credits for nothing,
 * or set a bit another thread's line means.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SHOP_KINDS } from '../01_Initialize_World/storefronts.ts'
import { LOOK_PRESETS, LOOK_SLOTS, validateLook } from '../03_Spawn_Agents/look.ts'
import { screen } from '../02_Define_The_Rules/conduct.ts'
import { AT, MAX_LEVEL as PROGRESSION_MAX_LEVEL, PURCHASE, STARTING_CREDITS, UNLOCK_SPACE } from '../02_Define_The_Rules/progression.ts'
import { createProgress } from './progress.ts'
import {
  CATALOGUE, GATE, MAX_LEVEL, OPEN_KINDS, SHOP_LOOK_BASE, SHOP_LOOK_END, SPACE_SIZE, itemById, itemsOf, onSale, wearItem, wearing, whyOf,
  type ItemKind, type Space,
} from './storeCatalog.ts'
import { PROGRESS_WORD, createShopkeeper, progressionPurse, type ProgressLike } from './shopkeeper.ts'

/** A Map-backed localStorage. */
const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) }, m }
}

test('ids and bits are unique, every bit inside its space and the worn lines in the shops\' range; levels, prices and shops in range', () => {
  const ids = new Set<number>()
  const bits = new Set<string>()
  for (const i of CATALOGUE) {
    assert.ok(Number.isInteger(i.id) && i.id >= 0, `id ${i.id}`)
    assert.ok(!ids.has(i.id), `id ${i.id} twice`)
    ids.add(i.id)
    const bit = `${i.space}:${i.index}`
    assert.ok(!bits.has(bit), `${bit} twice`)
    bits.add(bit)
    assert.ok(Number.isInteger(i.index) && i.index >= 0 && i.index < SPACE_SIZE[i.space], `${i.name}: ${bit} outside its space`)
    assert.equal(i.space, i.kind === 'wear' ? 'look' : i.kind === 'furniture' ? 'furniture' : 'property')
    if (i.space === 'look') assert.ok(i.index >= SHOP_LOOK_BASE && i.index < SHOP_LOOK_END, `${i.name}: look ${i.index} outside the shops' range`)
    assert.ok(Number.isInteger(i.level) && i.level >= 1 && i.level <= MAX_LEVEL, `${i.name}: level ${i.level}`)
    assert.ok(Number.isInteger(i.price) && i.price >= 0 && i.price <= 2_000_000_000, `${i.name}: price ${i.price}`)
    assert.ok((SHOP_KINDS as readonly string[]).includes(i.shop))
    assert.equal(itemById(i.id), i)
    assert.ok(Object.isFrozen(i))
  }
  for (const shop of SHOP_KINDS) assert.ok(itemsOf(shop).length > 0, `${shop} lists nothing`)
  for (const shop of ['tailor', 'prosthetics', 'horology'] as const) assert.ok(itemsOf(shop).some((i) => onSale(i)), `${shop} sells nothing today`)
  assert.equal(itemById(9999), null)
  // Shipped bits keep their meaning: a few pinned by value.
  assert.deepEqual([itemById(0), itemById(24), itemById(96), itemById(128), itemById(160), itemById(224)].map((i) => `${i?.space}:${i?.index}`),
    ['look:512', 'look:536', 'look:608', 'look:640', 'furniture:0', 'property:0'])
})

test('the deeds are the plan\'s seven tiers, in level order, priced as its table, homes 0 to 6', () => {
  const deeds = CATALOGUE.filter((i) => i.kind === 'deed')
  assert.deepEqual(deeds.map((d) => d.level), [1, 3, 6, 10, 14, 17, 20])
  assert.deepEqual(deeds.map((d) => d.price), [0, 4000, 18000, 75000, 320000, 1100000, 4500000])
  assert.deepEqual(deeds.map((d) => d.index), [0, 1, 2, 3, 4, 5, 6])
})

test('deeds are on sale; furniture is still on order, and goes on sale only when furnishing opens its kind', () => {
  assert.deepEqual([...OPEN_KINDS], ['deed'])
  const deeds = CATALOGUE.filter((i) => i.kind === 'deed')
  const furniture = CATALOGUE.filter((i) => i.kind === 'furniture')
  assert.equal(deeds.length, 7)
  assert.ok(furniture.length > 0)
  assert.ok(deeds.every((d) => d.shop === 'designHouse' && onSale(d)), 'the deeds are on sale')
  assert.ok(furniture.every((f) => f.shop === 'designHouse' && !onSale(f)), 'no piece is sold before it can be placed')
  // Furnishing adds its kind, and the pieces are on sale at once; without the deeds' kind, a deed is on order again.
  const furnishing: ReadonlySet<ItemKind> = new Set<ItemKind>(['deed', 'furniture'])
  assert.ok(furniture.every((f) => onSale(f, LOOK_SLOTS, furnishing)))
  assert.ok(deeds.every((d) => !onSale(d, LOOK_SLOTS, new Set<ItemKind>())))
  // A kind in the open set never puts a worn line on sale: those answer to the wardrobe alone.
  const watch = CATALOGUE.find((i) => i.wear && 'watch' in i.wear)!
  assert.equal(onSale(watch, LOOK_SLOTS, new Set<ItemKind>(['wear', 'deed', 'furniture'])), false)
})

test('every worn line on sale dresses every preset body in a valid look; a deed on sale dresses nobody; a line on order is never sold nor worn', () => {
  for (const i of CATALOGUE) {
    if (!onSale(i)) {
      for (const p of LOOK_PRESETS) assert.equal(wearItem(p.look, i), null, `${i.name} is on order but wearable`)
      continue
    }
    if (i.kind !== 'wear') {
      // A deed is sold, never worn: nothing it sets, nothing anyone shows as wearing.
      assert.equal(i.wear, null, `${i.name} is not worn`)
      for (const p of LOOK_PRESETS) {
        assert.equal(wearItem(p.look, i), null, `${i.name} would be worn by the ${p.name}`)
        assert.equal(wearing(p.look, i), false)
      }
      continue
    }
    for (const p of LOOK_PRESETS) {
      const worn = wearItem(p.look, i)
      assert.ok(worn, `${i.name} cannot be worn by the ${p.name}`)
      assert.ok(validateLook(worn), `${i.name} on the ${p.name} is not a look`)
      assert.ok(wearing(worn, i), `${i.name} on the ${p.name} does not show as worn`)
    }
  }
  // A line on order goes on sale the moment the wardrobe has its slots.
  const watch = CATALOGUE.find((i) => i.wear && 'watch' in i.wear)!
  assert.equal(onSale(watch), false)
  assert.equal(onSale(watch, [...LOOK_SLOTS, 'watch']), true)
})

test('every name passes the 14A screen and names no real place', () => {
  for (const i of CATALOGUE) {
    assert.ok(screen(i.name).admissible, `${i.name} fails the screen`)
    assert.doesNotMatch(i.name, /\b(?:Toronto|Harbourfront|Yonge|Domus|Chronos|Sovereign Threads?|Apex Citadel|Citadel Apex)\b|matrix/i)
  }
})

test('whyOf says why in words', () => {
  const coat = itemById(3)!
  assert.match(whyOf(coat, GATE.level, 0), /needs level 3/)
  assert.match(whyOf(coat, GATE.credits, 10), /640 more credits/)
  assert.equal(whyOf(coat, GATE.bought, 9999), 'for sale')
  assert.equal(whyOf(coat, GATE.owned, 0), 'owned')
  assert.match(whyOf(itemById(129)!, GATE.unavailable, 0), /on order/)
  assert.match(whyOf(itemById(160)!, GATE.unavailable, 0), /furnishing/)
  assert.equal(whyOf(itemById(225)!, GATE.unavailable, 0), 'not for sale', 'a deed is on sale, so an unavailable one is refused, not on order')
  assert.match(whyOf(itemById(226)!, GATE.level, 0), /needs level 6/)
})

test('the shops speak the progression engine\'s numbers: its spaces, its level cap, its verdicts, its record words', () => {
  for (const space of Object.keys(UNLOCK_SPACE) as Space[]) assert.equal(SPACE_SIZE[space], UNLOCK_SPACE[space].size, space)
  assert.deepEqual(Object.keys(SPACE_SIZE), Object.keys(UNLOCK_SPACE))
  assert.equal(MAX_LEVEL, PROGRESSION_MAX_LEVEL)
  assert.deepEqual([GATE.bought, GATE.owned, GATE.level, GATE.credits, GATE.unavailable],
    [PURCHASE.bought, PURCHASE.owned, PURCHASE.level, PURCHASE.credits, PURCHASE.invalid])
  assert.deepEqual({ ...PROGRESS_WORD }, { level: AT.level, credits: AT.credits })
})

test('the progression keeper behind the shopkeeper: a new operator\'s level and credits, bought once, kept across a reload', () => {
  const s = memory()
  const p = createProgress({ store: s, seed: () => 1337, now: () => 0 })
  const k = createShopkeeper({ purse: progressionPurse(p) })
  assert.equal(k.purse.level(), 1)
  assert.equal(k.purse.credits(), STARTING_CREDITS)
  let calls = 0
  const off = k.onChange(() => { calls++ })
  const look = LOOK_PRESETS[0].look
  const tie = itemById(24)!
  assert.ok(onSale(tie) && tie.level === 1 && tie.price <= STARTING_CREDITS, 'a first-floor line a new operator can afford')
  assert.equal(k.wear(24, look), null, 'not owned: not worn')
  const rows = k.rows('tailor', look)
  assert.equal(rows.find((r) => r.item.id === 24)!.verdict, GATE.bought)
  assert.equal(rows.find((r) => r.item.id === 5)!.verdict, GATE.level, 'a level 2 line at level 1')
  assert.equal(rows.find((r) => r.item.id === 0)!.verdict, GATE.credits)
  assert.match(rows.find((r) => r.item.id === 0)!.why, /250 more credits/)
  const r = k.buy(24)
  assert.equal(r.verdict, GATE.bought, r.message)
  assert.equal(k.purse.credits(), STARTING_CREDITS - tie.price, 'the price taken from the record')
  assert.equal(p.record[AT.credits], STARTING_CREDITS - tie.price)
  assert.equal(p.owns('look', SHOP_LOOK_BASE + 24), true, 'the line\'s own bit in the look space')
  assert.equal(p.owns('furniture', SHOP_LOOK_BASE + 24), false, 'and in no other space')
  assert.equal(calls, 1)
  assert.equal(k.buy(24).verdict, GATE.owned)
  assert.equal(k.purse.credits(), STARTING_CREDITS - tie.price, 'never charged twice')
  const worn = k.wear(24, look)
  assert.ok(worn && wearing(worn, tie))
  assert.equal(k.rows('tailor', worn).find((row) => row.item.id === 24)?.worn, true)
  // Refused with the reason, nothing taken: above the level, on order, no such line.
  assert.equal(k.buy(5).verdict, GATE.level)
  assert.equal(k.buy(129).verdict, GATE.unavailable)
  assert.equal(k.buy(160).verdict, GATE.unavailable, 'furniture is on order')
  assert.equal(k.buy(4242).verdict, GATE.unavailable)
  assert.equal(k.purse.credits(), STARTING_CREDITS - tie.price)
  // The gate refuses what is not a purchase.
  for (const [space, index, level, price] of [['look', 1024, 1, 0], ['nowhere', 0, 1, 0], ['look', 0, 0, 0], ['look', 0, 21, 0], ['look', 0, 1, -1], ['look', 0, 1, 0.5]] as const) {
    assert.equal(k.purse.canBuy(space as Space, index, level, price), GATE.unavailable)
    assert.equal(k.purse.buy(space as Space, index, level, price), GATE.unavailable)
  }
  off()
  // Reloaded from the same store: the purchase and the balance are still there.
  const again = createShopkeeper({ purse: progressionPurse(createProgress({ store: s, seed: () => 1, now: () => 0 })) })
  assert.equal(again.owns(24), true)
  assert.equal(again.purse.credits(), STARTING_CREDITS - tie.price)
})

test('the progression keeper sells homes: a new operator claims the Micro-Loft for 0 cr and is told the Brownstone\'s level; at level 3 it is bought', () => {
  const s = memory()
  const k = createShopkeeper({ purse: progressionPurse(createProgress({ store: s, seed: () => 1337, now: () => 0 })) })
  let calls = 0
  k.onChange(() => { calls++ })
  // The design house's card: the free loft for sale, the other six deeds gated by level, every piece of furniture on order.
  const rows = k.rows('designHouse', null)
  assert.deepEqual(rows.filter((r) => r.item.kind === 'deed').map((r) => r.verdict),
    [GATE.bought, GATE.level, GATE.level, GATE.level, GATE.level, GATE.level, GATE.level])
  assert.deepEqual(rows.filter((r) => r.item.kind === 'deed').slice(1).map((r) => r.why),
    ['needs level 3', 'needs level 6', 'needs level 10', 'needs level 14', 'needs level 17', 'needs level 20'])
  for (const r of rows.filter((row) => row.item.kind === 'furniture')) {
    assert.equal(r.verdict, GATE.unavailable, r.item.name)
    assert.equal(r.why, 'on order: opens with furnishing')
  }
  assert.ok(rows.every((r) => !r.worn))
  // The free loft is claimed for nothing, and sets property bit 0.
  const loft = k.buy(224)
  assert.equal(loft.verdict, GATE.bought, loft.message)
  assert.equal(k.purse.credits(), STARTING_CREDITS)
  assert.equal(k.owns(224), true)
  assert.equal(k.purse.owns('property', 0), true)
  assert.equal(k.buy(224).verdict, GATE.owned, 'claimed once')
  assert.equal(k.wear(224, LOOK_PRESETS[0].look), null, 'a deed is never worn')
  // The brownstone needs level 3: refused with the level named, nothing taken, nothing set.
  const early = k.buy(225)
  assert.equal(early.verdict, GATE.level)
  assert.match(early.message, /needs level 3/)
  assert.equal(k.purse.credits(), STARTING_CREDITS)
  assert.equal(k.owns(225), false)
  assert.equal(calls, 1)
  // Reloaded, the loft is still owned and the rows say so.
  const again = createShopkeeper({ purse: progressionPurse(createProgress({ store: s, seed: () => 1, now: () => 0 })) })
  assert.deepEqual(again.rows('designHouse', null).filter((r) => r.owned).map((r) => r.item.id), [224])
  // A keeper at level 3 with the credits buys the brownstone: 4,000 cr taken, property bit 1 set.
  const p = fakeProgress(3, 5000)
  const k3 = createShopkeeper({ purse: progressionPurse(p) })
  const brownstone = k3.buy(225)
  assert.equal(brownstone.verdict, GATE.bought, brownstone.message)
  assert.equal(k3.purse.credits(), 1000)
  assert.equal(p.owns('property', 1), true)
  assert.match(k3.buy(226).message, /Pierside Timber Loft: needs level 6/)
})

/** A stand-in for the progression keeper, by its documented contract (docs/progression.md, the purchase gate): any level, and a refusal on demand. */
function fakeProgress(level: number, balance: number) {
  const record = new Float64Array(32)
  record[PROGRESS_WORD.level] = level
  record[PROGRESS_WORD.credits] = balance
  const owned = new Set<string>()
  const fns = new Set<(check: null) => void>()
  let refuse = false
  const canBuy = (space: Space, index: number, levelReq: number, price: number) =>
    !Object.hasOwn(SPACE_SIZE, space) || index < 0 || index >= SPACE_SIZE[space] ? 4 : owned.has(`${space}:${index}`) ? 1 : record[14] < levelReq ? 2 : record[16] < price ? 3 : 0
  const p: ProgressLike & { refuse(v: boolean): void } = {
    record,
    canBuy,
    buy(space, index, levelReq, price) {
      const r = refuse ? 3 : canBuy(space, index, levelReq, price)
      if (r !== 0) return r
      record[16] -= price
      owned.add(`${space}:${index}`)
      for (const f of fns) f(null)
      return 0
    },
    owns: (space, index) => owned.has(`${space}:${index}`),
    subscribe(fn) { fns.add(fn); return () => { fns.delete(fn) } },
    refuse(v) { refuse = v },
  }
  return p
}

test('a keeper by the documented contract: its level gates, its gate buys, its refusal leaves no bit, its subscribe redraws', () => {
  const p = fakeProgress(20, 10_000)
  const k = createShopkeeper({ purse: progressionPurse(p) })
  assert.equal(k.purse.level(), 20)
  assert.equal(k.purse.credits(), 10_000)
  let calls = 0
  k.onChange(() => { calls++ })
  assert.equal(k.buy(14).verdict, GATE.bought, 'level 6 trim at level 20')
  assert.equal(k.purse.credits(), 10_000 - itemById(14)!.price)
  assert.equal(p.owns('look', SHOP_LOOK_BASE + 14), true)
  assert.equal(k.owns(14), true)
  assert.equal(calls, 1)
  assert.equal(k.buy(14).verdict, GATE.owned)
  p.refuse(true)
  assert.ok(itemById(16) && onSale(itemById(16)!), 'a line on sale, so the refusal is the keeper\'s')
  assert.equal(k.buy(16).verdict, GATE.credits, 'the keeper refused')
  assert.equal(k.owns(16), false, 'no bit without the credits taken')
  assert.equal(p.owns('look', SHOP_LOOK_BASE + 16), false)
  // A low level and an empty purse: the rows say why, and nothing changes.
  const poor = createShopkeeper({ purse: progressionPurse(fakeProgress(1, 150)) })
  const rows = poor.rows('tailor', LOOK_PRESETS[0].look)
  assert.equal(rows.find((r) => r.item.id === 5)!.verdict, GATE.level)
  assert.equal(rows.find((r) => r.item.id === 0)!.verdict, GATE.credits)
  assert.match(rows.find((r) => r.item.id === 0)!.why, /250 more credits/)
  assert.equal(rows.find((r) => r.item.id === 24)!.verdict, GATE.bought, 'a 120-credit tie on a new operator\'s 150')
})
