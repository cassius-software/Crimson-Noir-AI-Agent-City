// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the one place a shop's purchase happens: the catalogue (storeCatalog.ts) and a purse
 * together. A purse answers for the operator's level, credits and what they own, and buys: the page hands in the
 * progression engine's keeper (07_Execute_Actions/progress.ts pageProgress, whose purchase gate debits the credits and
 * sets the unlock bit in one record and one save, docs/progression.md) through `progressionPurse`. The card and the
 * debug handle both buy through the shopkeeper, so they cannot disagree about what is owned or what it cost.
 * What breaks if it is removed? Each surface would keep its own owned set and its own balance.
 */
import type { ShopKind } from '../01_Initialize_World/storefronts.ts'
import type { Look } from '../03_Spawn_Agents/look.ts'
import {
  GATE, credits as creditWords, itemById, itemsOf, onSale, wearItem, wearing, whyOf, type GateVerdict, type Space, type StoreItem,
} from './storeCatalog.ts'

/**
 * The operator's level, credits and unlocks as a shop reads them, and the gate it buys through (progressionPurse over
 * the progression engine's keeper). `canBuy` previews, `buy` debits and sets the bit together or changes nothing; both
 * answer with the gate's verdict (storeCatalog.ts GATE, the same numbers as progression.ts PURCHASE).
 */
export interface Purse {
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
    level: () => p.record[PROGRESS_WORD.level],
    credits: () => p.record[PROGRESS_WORD.credits],
    canBuy: (space: Space, index: number, levelReq: number, price: number) => verdictOf(p.canBuy(space, index, levelReq, price)),
    buy: (space: Space, index: number, levelReq: number, price: number) => verdictOf(p.buy(space, index, levelReq, price)),
    owns: (space: Space, index: number) => p.owns(space, index),
    subscribe: (fn: () => void) => p.subscribe(() => fn()),
  })
}

/** One line as a card lists it: the line, whether it may be bought now and why not, and whether the look wears it. */
export interface ShopRow { item: StoreItem; verdict: GateVerdict; why: string; owned: boolean; worn: boolean }

export interface Shopkeeper {
  /** The purse every purchase goes through (the progression engine's keeper, on the page). */
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

/** The shopkeeper over a purse. */
export function createShopkeeper(o: { purse: Purse }): Shopkeeper {
  const { purse } = o
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
