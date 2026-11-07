// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the one place a shop's purchase happens: the catalogue (storeCatalog.ts) and a purse
 * together. A purse answers for the operator's level, credits and what they own, and buys: the progression engine's
 * keeper (07_Execute_Actions/progress.ts pageProgress, whose purchase gate debits the credits and sets the unlock bit
 * in one record and one save, docs/progression.md) once the host hands it in through `progressionPurse`, else the
 * practice purse kept in this browser (05_Observe_Environment/shopStore.ts) with the same spaces, the same bits and
 * the same verdicts. The card and the debug handle both buy through the shopkeeper, so they cannot disagree about what
 * is owned or what it cost.
 * What breaks if it is removed? Each surface would keep its own owned set and its own balance.
 */
import type { ShopKind } from '../01_Initialize_World/storefronts.ts'
import type { Look } from '../03_Spawn_Agents/look.ts'
import { loadShop, saveShop, type ShopRecord } from '../05_Observe_Environment/shopStore.ts'
import type { ProfileStore } from '../05_Observe_Environment/profile.ts'
import {
  GATE, MAX_LEVEL, SPACE_SIZE, credits as creditWords, hasBit, itemById, itemsOf, onSale, purchaseGate, wearItem, wearing, whyOf,
  type GateVerdict, type Space, type StoreItem,
} from './storeCatalog.ts'

/**
 * The operator's level, credits and unlocks as a shop reads them, and the gate it buys through: the shape of the
 * progression engine's keeper (progress.ts Progress), so it drops in. `canBuy` previews, `buy` debits and sets the bit
 * together or changes nothing; both answer with the gate's verdict (storeCatalog.ts GATE, the same numbers as
 * progression.ts PURCHASE).
 */
export interface Purse {
  readonly source: 'practice' | 'progression'
  level(): number
  credits(): number
  canBuy(space: Space, index: number, levelReq: number, price: number): GateVerdict
  buy(space: Space, index: number, levelReq: number, price: number): GateVerdict
  owns(space: Space, index: number): boolean
  /** Calls `fn` after every change; returns the unsubscribe. */
  subscribe(fn: () => void): () => void
}

/**
 * What the shops need of the progression keeper (progress.ts Progress, by its documented contract): the record, whose
 * word 14 is the level and word 16 the credits, and the purchase gate.
 */
export interface ProgressLike {
  readonly record: ArrayLike<number>
  canBuy(space: Space, index: number, levelReq: number, price: number): number
  buy(space: Space, index: number, levelReq: number, price: number): number
  owns(space: Space, index: number): boolean
  subscribe(fn: () => void): () => void
}
/** The progression record's words the shops read (progression.ts AT.level and AT.credits). */
export const PROGRESS_WORD = Object.freeze({ level: 14, credits: 16 })

/** A verdict from the progression gate as the shops' own (an unknown number is unavailable). */
const verdictOf = (r: number): GateVerdict => (r === 0 || r === 1 || r === 2 || r === 3 ? r : GATE.unavailable) as GateVerdict

/** The progression engine's keeper as a purse: its level, its credits, its gate, its unlocks. */
export function progressionPurse(p: ProgressLike): Purse {
  return Object.freeze({
    source: 'progression' as const,
    level: () => p.record[PROGRESS_WORD.level],
    credits: () => p.record[PROGRESS_WORD.credits],
    canBuy: (space: Space, index: number, levelReq: number, price: number) => verdictOf(p.canBuy(space, index, levelReq, price)),
    buy: (space: Space, index: number, levelReq: number, price: number) => verdictOf(p.buy(space, index, levelReq, price)),
    owns: (space: Space, index: number) => p.owns(space, index),
    subscribe: (fn: () => void) => p.subscribe(() => fn()),
  })
}

/** Whether a purchase's arguments are ones the progression gate takes (else it answers invalid; so does this purse). */
const valid = (space: Space, index: number, levelReq: number, price: number): boolean =>
  Object.hasOwn(SPACE_SIZE, space) && Number.isInteger(index) && index >= 0 && index < SPACE_SIZE[space]
  && Number.isInteger(levelReq) && levelReq >= 1 && levelReq <= MAX_LEVEL && Number.isInteger(price) && price >= 0 && price <= 2_000_000_000

/**
 * The practice purse over a store (localStorage by default): a level and credits that start at shopStore.ts PRACTICE,
 * bits in the progression record's spaces, saved after every purchase (a refused save keeps it for the visit).
 */
export function practicePurse(store?: ProfileStore | null): Purse {
  let record: ShopRecord = store === undefined ? loadShop() : loadShop(store)
  const listeners = new Set<() => void>()
  const preview = (space: Space, index: number, levelReq: number, price: number): GateVerdict => {
    if (!valid(space, index, levelReq, price)) return GATE.unavailable
    if (hasBit(record[space], index)) return GATE.owned
    if (record.level < levelReq) return GATE.level
    return record.credits < price ? GATE.credits : GATE.bought
  }
  return Object.freeze({
    source: 'practice' as const,
    level: () => record.level,
    credits: () => record.credits,
    canBuy: preview,
    buy(space: Space, index: number, levelReq: number, price: number): GateVerdict {
      if (!valid(space, index, levelReq, price)) return GATE.unavailable
      // The gate on copies: the credits and the bit change together, in a new record, or not at all.
      const wallet = new Float64Array([record.level, record.credits])
      const bits = record[space].slice()
      const verdict = purchaseGate(wallet, bits, index, levelReq, price)
      if (verdict !== GATE.bought) return verdict
      record = { ...record, [space]: bits, credits: wallet[1] }
      if (store === undefined) saveShop(record)
      else saveShop(record, store)
      for (const f of listeners) f()
      return verdict
    },
    owns: (space: Space, index: number) => Object.hasOwn(SPACE_SIZE, space) && hasBit(record[space], index),
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  })
}

/** One line as a card lists it: the line, whether it may be bought now and why not, and whether the look wears it. */
export interface ShopRow { item: StoreItem; verdict: GateVerdict; why: string; owned: boolean; worn: boolean }

export interface Shopkeeper {
  /** The purse in use: the progression engine's, or the practice one. */
  readonly purse: Purse
  /** A shop's lines for `look` (worn: the look already wears all the line sets). */
  rows(shop: ShopKind, look: Look | null): ShopRow[]
  /** Whether catalogue line `id` is owned. */
  owns(id: number): boolean
  /** Buys catalogue line `id`: its verdict, and the words for it. */
  buy(id: number): { verdict: GateVerdict; message: string }
  /** `look` wearing owned line `id`, or null (not owned, not wearable, or not for this body). */
  wear(id: number, look: Look): Look | null
  /** Called after every change to the purse (the host re-renders its card). Returns the unsubscribe. */
  onChange(f: () => void): () => void
}

/** The verdict for a line: on order is unavailable before the purse is asked; else the purse's gate decides. */
function verdictFor(purse: Purse, item: StoreItem): GateVerdict {
  if (purse.owns(item.space, item.index)) return GATE.owned
  if (!onSale(item)) return GATE.unavailable
  return purse.canBuy(item.space, item.index, item.level, item.price)
}

/** The shopkeeper over a purse (the practice one by default). */
export function createShopkeeper(o: { purse?: Purse | null } = {}): Shopkeeper {
  const purse = o.purse ?? practicePurse()
  return {
    purse,
    rows(shop, look) {
      const balance = purse.credits()
      return itemsOf(shop).map((item) => {
        const verdict = verdictFor(purse, item)
        return { item, verdict, why: whyOf(item, verdict, balance), owned: verdict === GATE.owned, worn: look !== null && wearing(look, item) }
      })
    },
    owns(id) {
      const item = itemById(id)
      return item !== null && purse.owns(item.space, item.index)
    },
    buy(id) {
      const item = itemById(id)
      if (!item) return { verdict: GATE.unavailable, message: `no line ${id}` }
      const ask = verdictFor(purse, item)
      if (ask !== GATE.bought) return { verdict: ask, message: `${item.name}: ${whyOf(item, ask, purse.credits())}` }
      const verdict = purse.buy(item.space, item.index, item.level, item.price)
      if (verdict !== GATE.bought) return { verdict, message: `${item.name}: ${whyOf(item, verdict, purse.credits())}` }
      return { verdict, message: `${item.name} bought for ${creditWords(item.price)}; ${creditWords(purse.credits())} left` }
    },
    wear(id, look) {
      const item = itemById(id)
      if (!item || !purse.owns(item.space, item.index)) return null
      return wearItem(look, item)
    },
    onChange: (f) => purse.subscribe(f),
  }
}
