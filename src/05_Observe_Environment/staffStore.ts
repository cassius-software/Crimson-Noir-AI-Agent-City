// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It remembers which of the player's own agents (08_Swarm/roster.ts, by name: the only thing
 * about an agent a new page still knows) is posted at which Agent workstation (02_Define_The_Rules/homeLayout.ts line
 * 168) in which home, between visits: one small record in this browser's localStorage under its own key. A post is a
 * name, a property index and the workstation's lowest cell (c, r), which is unique while it stands because footprints
 * never overlap. Whether that workstation still stands, whether the home is still owned and whether the name is still
 * on the roster is not decided here: the engine joins posts to the workstations it draws (homeView.ts homeSeats), and a
 * post whose workstation is moved or put away is kept, so Undo or putting it back brings the agent back. A post whose
 * name left the roster (renamed or forgotten) is kept too, drawn by nobody (App joins posts to the roster by name),
 * until the next post lets it go. Every storage access is guarded like the other stores'; a value that is not this
 * version's record reads as nobody posted. Two tabs: the last save wins. Nothing leaves the device.
 * What breaks if it is removed? Nobody stays posted at a workstation past the visit.
 */
import { DEPTH, GRID } from '../02_Define_The_Rules/homeGrid.ts'
import { sanitizeName, type ProfileStore } from './profile.ts'

/** Keyed by the package id like the profile, the look, the progression and the homes. */
export const STAFF_KEY = 'civic-simulation:staff:v1'
/** The JSON record's own version (its `v`): any other reads as nobody posted. */
export const STAFF_VERSION = 1
/** At most one post per agent, so at most the roster's twelve (roster.ts ROSTER_MAX; staffStore.test.ts holds them equal). */
export const STAFF_MAX = 12
/** A stored value longer than this is corrupt: twelve posts of a 24-letter name are under 500 characters. */
export const RAW_MAX = 1024

/** One agent posted at one workstation: the roster's name, the home's property index, the workstation's lowest cell. */
export interface Post { readonly name: string; readonly home: number; readonly c: number; readonly r: number }
/** Every post, frozen: at most one per name (any case) and one per workstation, at most STAFF_MAX. */
export type StaffRecord = readonly Post[]

/** Nobody posted. */
export const NO_STAFF: StaffRecord = Object.freeze([])

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const cell = (n: unknown, size: number): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < size
const at = (p: Post, home: number, c: number, r: number): boolean => p.home === home && p.c === c && p.r === r

/** The posts a list of entries [name, home, c, r] keeps: each well formed, the first for a name (any case) and the first for a seat. */
function postsFrom(list: readonly unknown[]): StaffRecord {
  const out: Post[] = []
  for (const e of list) {
    const [name, home, c, r] = Array.isArray(e) && e.length === 4 ? (e as unknown[]) : []
    if (typeof name !== 'string' || !name || sanitizeName(name) !== name || /\s/.test(name) || !cell(home, DEPTH.length) || !cell(c, GRID) || !cell(r, GRID)) continue
    if (!out.some((p) => same(p.name, name) || at(p, home, c, r))) out.push(Object.freeze({ name, home, c, r }))
  }
  return Object.freeze(out.slice(0, STAFF_MAX))
}

const entries = (rec: readonly Post[]): unknown[][] => rec.map((p) => [p.name, p.home, p.c, p.r])

function decode(raw: unknown): StaffRecord {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > RAW_MAX) return NO_STAFF
  let data: unknown
  try { data = JSON.parse(raw) } catch { return NO_STAFF }
  const { v, posts } = (data ?? {}) as { v?: unknown; posts?: unknown }
  return v === STAFF_VERSION && Array.isArray(posts) ? postsFrom(posts) : NO_STAFF
}

const encode = (rec: StaffRecord): string => JSON.stringify({ v: STAFF_VERSION, posts: entries(rec) })

function browserStore(): ProfileStore | null {
  try { return (globalThis as { localStorage?: ProfileStore }).localStorage ?? null } catch { return null }
}

/** The saved posts, or nobody posted (no storage, nothing saved, not this version's record). Never throws. */
export function loadStaff(store: ProfileStore | null = browserStore()): StaffRecord {
  if (!store) return NO_STAFF
  let raw: string | null
  try { raw = store.getItem(STAFF_KEY) } catch { return NO_STAFF }
  return decode(raw)
}

/** Saves the posts, only when the text reads back the same (so never more than RAW_MAX). Never throws; whether it was written. */
export function saveStaff(rec: StaffRecord, store: ProfileStore | null = browserStore()): boolean {
  const raw = encode(rec)
  if (!store || encode(decode(raw)) !== raw) return false
  try { store.setItem(STAFF_KEY, raw) } catch { return false }
  return true
}

/** Forgets every post (no-op without storage). */
export function clearStaff(store: ProfileStore | null = browserStore()): void {
  if (!store) return
  try { store.removeItem(STAFF_KEY) } catch { /* storage unavailable */ }
}

/** Where `name` is posted (any case), or null. */
export const postOf = (rec: StaffRecord, name: string): Post | null => rec.find((p) => same(p.name, name)) ?? null
/** Who is posted at workstation (c, r) of home `home`, or null. */
export const postAt = (rec: StaffRecord, home: number, c: number, r: number): Post | null => rec.find((p) => at(p, home, c, r)) ?? null

/**
 * `name` posted at workstation (c, r) of `home`: off any workstation they had, whoever was there freed, and every post
 * whose name is not on `roster` (renamed or forgotten agents) let go. A write is the only time those go, never a load.
 * App posts roster names only, which every check here admits.
 */
export function postTo(rec: StaffRecord, name: string, home: number, c: number, r: number, roster: readonly string[]): StaffRecord {
  return postsFrom(entries([...rec.filter((p) => !same(p.name, name) && !at(p, home, c, r) && roster.some((n) => same(n, p.name))), { name, home, c, r }]))
}

/** Workstation (c, r) of `home` with nobody posted at it. */
export const standDownAt = (rec: StaffRecord, home: number, c: number, r: number): StaffRecord => Object.freeze(rec.filter((p) => !at(p, home, c, r)))
