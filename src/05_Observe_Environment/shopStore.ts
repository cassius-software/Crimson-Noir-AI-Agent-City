// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the practice purse's memory: until the progression engine's keeper lands
 * (docs/progression.md, the purchase gate), the shops run on a practice level and balance of civic credits that start
 * at PRACTICE and go down as things are bought, and remember what was bought as bits in the same three unlock spaces
 * the progression record has (07_Execute_Actions/storeCatalog.ts SPACE_SIZE: look, property, furniture), so a line's
 * bit means the same thing in both. Kept in this browser's localStorage under a key of its own, guarded like the
 * look's (lookStore.ts): a private window, blocked site data or a quota reads as a fresh start and a write is a
 * no-op, and every stored value is validated on the way in, so nothing a page once wrote, or a hand once edited, can
 * own a bit outside its space or hold credits that are not a whole, finite, non-negative number.
 * What breaks if it is removed? Every purchase is forgotten on reload, and the shops have no practice purse to run on.
 */
import { MAX_LEVEL, SPACE_SIZE, emptyBits, type Space } from '../07_Execute_Actions/storeCatalog.ts'
import type { ProfileStore } from './profile.ts'

export const SHOP_KEY = 'civic-simulation:shop:v1'
export const SHOP_RECORD_VERSION = 1
/** A stored value longer than this is corrupt, not a record (50 words and a balance are well under 1,000 bytes). */
const RAW_MAX = 1200
const SPACES = Object.keys(SPACE_SIZE) as Space[]

/**
 * The practice purse's start: the level and the credits a visitor shops with until the progression engine's keeper
 * replaces it. Enough for the first floor of every shop, not for everything.
 */
export const PRACTICE = Object.freeze({ level: 5, credits: 5000 })
/** The most credits a record may hold (the dearest deed, ten times over): anything above is corrupt. */
export const CREDITS_MAX = 45_000_000

/** What the practice purse remembers: the bits bought in each space, the level and the balance. */
export interface ShopRecord {
  look: Uint32Array
  property: Uint32Array
  furniture: Uint32Array
  level: number
  credits: number
}

/** A fresh record: nothing owned, the practice purse full. */
export const freshShop = (): ShopRecord => ({ look: emptyBits('look'), property: emptyBits('property'), furniture: emptyBits('furniture'), level: PRACTICE.level, credits: PRACTICE.credits })

/** A stored space's words, made safe, or null. */
function wordsOf(raw: unknown, space: Space): Uint32Array | null {
  if (!Array.isArray(raw) || raw.length !== SPACE_SIZE[space] / 32) return null
  if (!raw.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffffffff)) return null
  return Uint32Array.from(raw as number[])
}

/** localStorage, or null where the page may not use it (reading the property itself can throw). */
function browserStore(): ProfileStore | null {
  try { return (globalThis as { localStorage?: ProfileStore }).localStorage ?? null } catch { return null }
}

/** A stored record made safe, or null when it is not one. */
export function validateShop(raw: unknown): ShopRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.v !== SHOP_RECORD_VERSION) return null
  const [look, property, furniture] = SPACES.map((sp) => wordsOf(r[sp], sp))
  if (!look || !property || !furniture) return null
  const { level, credits } = r
  if (!Number.isInteger(level) || (level as number) < 1 || (level as number) > MAX_LEVEL) return null
  if (!Number.isInteger(credits) || (credits as number) < 0 || (credits as number) > CREDITS_MAX) return null
  return { look, property, furniture, level: level as number, credits: credits as number }
}

/** The saved record, or a fresh one when there is none, storage is unavailable or the entry is not a record. */
export function loadShop(store: ProfileStore | null = browserStore()): ShopRecord {
  if (!store) return freshShop()
  let raw: string | null
  try { raw = store.getItem(SHOP_KEY) } catch { return freshShop() }
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > RAW_MAX) return freshShop()
  let data: unknown
  try { data = JSON.parse(raw) } catch { return freshShop() }
  return validateShop(data) ?? freshShop()
}

/** Saves a record (only a valid one). Never throws: quota, private mode and blocked storage are silent no-ops. */
export function saveShop(r: ShopRecord, store: ProfileStore | null = browserStore()): boolean {
  const data = { v: SHOP_RECORD_VERSION, look: Array.from(r.look), property: Array.from(r.property), furniture: Array.from(r.furniture), level: r.level, credits: r.credits }
  if (!validateShop(data) || !store) return false
  try { store.setItem(SHOP_KEY, JSON.stringify(data)) } catch { return false }
  return true
}

/** Forgets every purchase and refills the practice purse (no-op without storage). */
export function clearShop(store: ProfileStore | null = browserStore()): void {
  if (!store) return
  try { store.removeItem(SHOP_KEY) } catch { /* storage unavailable */ }
}
