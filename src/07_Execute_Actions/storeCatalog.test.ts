// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the shops' catalogue, the practice gate, the saved record, the purses and the
 * shopkeeper (storeCatalog.ts, shopStore.ts, shopkeeper.ts) to their promises: ids and bits stable and unique, every
 * bit inside its unlock space and the worn lines inside the shops' own range of the look space; every line on sale
 * dresses every body in something the wardrobe has; a line on order never sold; the gate takes the price and sets the
 * bit only when the level, the credits and the bit allow, and its verdict names the first reason; a stored record that
 * is not one reads as a fresh start; a purchase survives a reload; the progression keeper's contract (its record
 * words, its gate's verdicts, its subscribe) drives the shopkeeper the same way; the 14A screen passes every name.
 * What breaks if it is removed? A shop could sell a line twice, sell a line nobody can wear, take credits for nothing,
 * or set a bit another thread's line means.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SHOP_KINDS } from '../01_Initialize_World/storefronts.ts'
import { LOOK_PRESETS, LOOK_SLOTS, validateLook } from '../03_Spawn_Agents/look.ts'
import { screen } from '../02_Define_The_Rules/conduct.ts'
import { CREDITS_MAX, PRACTICE, SHOP_KEY, freshShop, loadShop, saveShop, validateShop } from '../05_Observe_Environment/shopStore.ts'
import {
  CATALOGUE, GATE, MAX_LEVEL, SHOP_LOOK_BASE, SHOP_LOOK_END, SPACE_SIZE, emptyBits, hasBit, itemById, itemsOf, onSale, purchaseGate, wearItem, wearing, whyOf,
  type Space,
} from './storeCatalog.ts'
import { PROGRESS_WORD, createShopkeeper, practicePurse, progressionPurse, type ProgressLike } from './shopkeeper.ts'

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
  assert.ok(deeds.every((d) => d.shop === 'designHouse' && !onSale(d)), 'deeds wait for the properties')
})

test('every line on sale dresses every preset body in a valid look; a line on order is never sold nor worn', () => {
  for (const i of CATALOGUE) {
    if (!onSale(i)) {
      for (const p of LOOK_PRESETS) assert.equal(wearItem(p.look, i), null, `${i.name} is on order but wearable`)
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
    assert.doesNotMatch(i.name, /\b(?:Toronto|Harbourfront|Yonge|Domus|Chronos|Sovereign Threads?)\b|matrix/i)
  }
})

test('the practice gate: bought only with the level, the credits and a clear bit; the price taken once; the first reason named', () => {
  const bits = emptyBits('look')
  assert.equal(bits.length, 32)
  const w = new Float64Array([3, 1000])
  assert.equal(purchaseGate(w, bits, 520, 4, 100), GATE.level, 'level first among the money reasons')
  assert.equal(w[1], 1000)
  assert.equal(hasBit(bits, 520), false)
  assert.equal(purchaseGate(w, bits, 520, 2, 5000), GATE.credits)
  assert.equal(w[1], 1000)
  assert.equal(purchaseGate(w, bits, 520, 2, 400), GATE.bought)
  assert.equal(w[1], 600)
  assert.equal(hasBit(bits, 520), true)
  assert.equal(purchaseGate(w, bits, 520, 2, 400), GATE.owned, 'never twice')
  assert.equal(w[1], 600)
  // The top bit of a word, and an exact balance.
  assert.equal(purchaseGate(w, bits, 543, 1, 600), GATE.bought)
  assert.equal(w[1], 0)
  assert.equal(bits[16] >>> 31, 1)
  // Millions of credits stay exact.
  const rich = new Float64Array([20, 4_500_000])
  const homes = emptyBits('property')
  assert.equal(purchaseGate(rich, homes, 6, 20, 4_500_000), GATE.bought)
  assert.equal(rich[1], 0)
  for (const bad of [-1, 64, 1.5, Number.NaN]) assert.equal(hasBit(homes, bad), false)
})

test('whyOf says why in words', () => {
  const coat = itemById(3)!
  assert.match(whyOf(coat, GATE.level, 0), /needs level 3/)
  assert.match(whyOf(coat, GATE.credits, 10), /640 more credits/)
  assert.equal(whyOf(coat, GATE.bought, 9999), 'for sale')
  assert.equal(whyOf(coat, GATE.owned, 0), 'owned')
  assert.match(whyOf(itemById(129)!, GATE.unavailable, 0), /on order/)
  assert.match(whyOf(itemById(225)!, GATE.unavailable, 0), /properties/)
})

test('the record: a fresh start for anything not a record, the practice purse full; a valid one round-trips', () => {
  const s = memory()
  const plain = (r: ReturnType<typeof freshShop>) => ({ ...r, look: [...r.look], property: [...r.property], furniture: [...r.furniture] })
  assert.deepEqual(plain(loadShop(s)), plain(freshShop()))
  assert.equal(loadShop(null).credits, PRACTICE.credits)
  const ok = { v: 1, look: Array(32).fill(0), property: [0, 0], furniture: Array(16).fill(0), level: 1, credits: 0 }
  for (const raw of ['', 'x', '[]', '{}', JSON.stringify({ ...ok, v: 2 }), JSON.stringify({ ...ok, look: [1] }),
    JSON.stringify({ ...ok, property: [0, -1] }), JSON.stringify({ ...ok, furniture: undefined }), JSON.stringify({ ...ok, level: 0 }),
    JSON.stringify({ ...ok, credits: 1.5 }), JSON.stringify({ ...ok, credits: CREDITS_MAX + 1 }), 'z'.repeat(1300)]) {
    s.setItem(SHOP_KEY, raw)
    assert.equal(loadShop(s).credits, PRACTICE.credits, `not a record: ${raw.slice(0, 40)}`)
  }
  const r = { ...freshShop(), level: 7, credits: 123 }
  r.look[16] = 5
  r.property[1] = 0x80000000
  assert.ok(saveShop(r, s))
  const back = loadShop(s)
  assert.deepEqual(plain(back), plain(r))
  assert.equal(validateShop({ ...ok, level: 21 }), null)
  // A store that throws on every call is a fresh start and a refused save, never an exception.
  const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('quota') }, removeItem: () => { throw new Error('x') } }
  assert.equal(loadShop(broken).credits, PRACTICE.credits)
  assert.equal(saveShop(r, broken), false)
})

test('the shopkeeper on the practice purse: buys through the gate, saves at once, refuses twice, wears only what is owned', () => {
  const s = memory()
  const k = createShopkeeper({ purse: practicePurse(s) })
  assert.equal(k.purse.source, 'practice')
  let calls = 0
  const off = k.onChange(() => { calls++ })
  const look = LOOK_PRESETS[0].look
  assert.equal(k.wear(0, look), null, 'not owned: not worn')
  const before = k.purse.credits()
  const r = k.buy(0)
  assert.equal(r.verdict, GATE.bought, r.message)
  assert.equal(k.purse.credits(), before - itemById(0)!.price)
  assert.equal(k.purse.owns('look', 512), true, 'the line\'s own bit')
  assert.equal(calls, 1)
  assert.equal(k.buy(0).verdict, GATE.owned)
  assert.equal(k.purse.credits(), before - itemById(0)!.price, 'never charged twice')
  const worn = k.wear(0, look)
  assert.ok(worn && worn.layer === 2 && worn.top === 0)
  assert.equal(k.rows('tailor', worn).find((row) => row.item.id === 0)?.worn, true)
  // Reloaded: the purchase and the balance are still there.
  const again = createShopkeeper({ purse: practicePurse(s) })
  assert.equal(again.owns(0), true)
  assert.equal(again.purse.credits(), before - itemById(0)!.price)
  // Above the practice level, and on order: refused with the reason, nothing taken.
  assert.equal(again.buy(14).verdict, GATE.level)
  assert.equal(again.buy(129).verdict, GATE.unavailable)
  assert.equal(again.buy(4242).verdict, GATE.unavailable)
  assert.equal(again.purse.credits(), before - itemById(0)!.price)
  // The purse refuses what the progression gate would call invalid.
  for (const [space, index, level, price] of [['look', 1024, 1, 0], ['nowhere', 0, 1, 0], ['look', 0, 0, 0], ['look', 0, 21, 0], ['look', 0, 1, -1], ['look', 0, 1, 0.5]] as const) {
    assert.equal(again.purse.canBuy(space as Space, index, level, price), GATE.unavailable)
    assert.equal(again.purse.buy(space as Space, index, level, price), GATE.unavailable)
  }
  off()
})

/** A stand-in for the progression keeper, by its documented contract (docs/progression.md, the purchase gate). */
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

test('the progression keeper drives the shopkeeper: its level gates, its gate buys, its record holds the balance, its subscribe redraws', () => {
  const p = fakeProgress(20, 10_000)
  const k = createShopkeeper({ purse: progressionPurse(p) })
  assert.equal(k.purse.source, 'progression')
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
  assert.notEqual(k.buy(15).verdict, GATE.bought, 'the keeper refused')
  assert.equal(k.owns(15), false, 'no bit without the credits taken')
  // A low level and an empty purse: the rows say why, and nothing changes.
  const poor = createShopkeeper({ purse: progressionPurse(fakeProgress(1, 150)) })
  const rows = poor.rows('tailor', LOOK_PRESETS[0].look)
  assert.equal(rows.find((r) => r.item.id === 5)!.verdict, GATE.level)
  assert.equal(rows.find((r) => r.item.id === 0)!.verdict, GATE.credits)
  assert.match(rows.find((r) => r.item.id === 0)!.why, /250 more credits/)
  assert.equal(rows.find((r) => r.item.id === 24)!.verdict, GATE.bought, 'a 120-credit tie on a new operator\'s 150')
})
