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
 * post whose workstation is moved or put away is kept, so Undo or putting it back brings the agent back. A rename
 * carries the post to the new name and a forget lets it go (carry, which App runs on every roster change); a post
 * whose name is still off the roster is drawn by nobody (App joins posts to the roster by name) until the next post
 * lets it go. Every storage access is guarded like the other stores'; a value that is not a record reads as nobody
 * posted, and a record a newer build wrote is never overwritten. Two tabs: the last save wins. Nothing leaves the device.
 * What breaks if it is removed? Nobody stays posted at a workstation past the visit.
 */
import { DEPTH, GRID } from '../02_Define_The_Rules/homeGrid.ts'
import { sanitizeName, type ProfileStore } from './profile.ts'

/** Keyed by the package id like the profile, the look, the progression and the homes. */
export const STAFF_KEY = 'civic-simulation:staff:v1'
/** The JSON record's own version (its `v`): a higher one is a newer build's (never written over), any other reads as nobody posted. */
export const STAFF_VERSION = 1
/** At most one post per agent, so at most the roster's twelve (roster.ts ROSTER_MAX; staffStore.test.ts holds them equal). */
export const STAFF_MAX = 12
/** A stored value longer than this is corrupt: twelve posts of a 24-letter name are under 500 characters. */
export const RAW_MAX = 1024

/** One agent posted at one workstation: the roster's name, the home's property index, the workstation's lowest cell. */
export interface Post { readonly name: string; readonly home: number; readonly c: number; readonly r: number }
/**
 * Every post, frozen: at most one per name (any case) and one per workstation, at most STAFF_MAX; and whether the stored
 * value came from a newer build (then it reads as nobody posted, and nothing here writes over it).
 */
export interface StaffRecord { readonly posts: readonly Post[]; readonly newer: boolean }

/** Nobody posted. */
export const NO_STAFF: StaffRecord = Object.freeze({ posts: Object.freeze([]), newer: false })

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const cell = (n: unknown, size: number): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < size
const at = (p: Post, home: number, c: number, r: number): boolean => p.home === home && p.c === c && p.r === r

/** The record a list of entries [name, home, c, r] gives: each well formed, the first for a name (any case) and the first for a seat. */
function postsFrom(list: readonly unknown[], newer = false): StaffRecord {
  const out: Post[] = []
  for (const e of list) {
    const [name, home, c, r] = Array.isArray(e) && e.length === 4 ? (e as unknown[]) : []
    if (typeof name !== 'string' || !name || sanitizeName(name) !== name || /\s/.test(name) || !cell(home, DEPTH.length) || !cell(c, GRID) || !cell(r, GRID)) continue
    if (!out.some((p) => same(p.name, name) || at(p, home, c, r))) out.push(Object.freeze({ name, home, c, r }))
  }
  return Object.freeze({ posts: Object.freeze(out.slice(0, STAFF_MAX)), newer })
}

const entries = (posts: readonly Post[]): unknown[][] => posts.map((p) => [p.name, p.home, p.c, p.r])

function decode(raw: unknown): StaffRecord {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > RAW_MAX) return NO_STAFF
  let data: unknown
  try { data = JSON.parse(raw) } catch { return NO_STAFF }
  const { v, posts } = (data ?? {}) as { v?: unknown; posts?: unknown }
  if (typeof v === 'number' && v > STAFF_VERSION) return postsFrom([], true)
  return v === STAFF_VERSION && Array.isArray(posts) ? postsFrom(posts) : NO_STAFF
}

const encode = (rec: StaffRecord): string => JSON.stringify({ v: STAFF_VERSION, posts: entries(rec.posts) })

function browserStore(): ProfileStore | null {
  try { return (globalThis as { localStorage?: ProfileStore }).localStorage ?? null } catch { return null }
}

/** The saved posts, or nobody posted (no storage, nothing saved, not a record, a newer build's record). Never throws. */
export function loadStaff(store: ProfileStore | null = browserStore()): StaffRecord {
  if (!store) return NO_STAFF
  let raw: string | null
  try { raw = store.getItem(STAFF_KEY) } catch { return NO_STAFF }
  return decode(raw)
}

/**
 * Saves the posts, only when the text reads back the same (so never more than RAW_MAX) and the record loaded was not a
 * newer build's. Never throws; whether it was written.
 */
export function saveStaff(rec: StaffRecord, store: ProfileStore | null = browserStore()): boolean {
  const raw = encode(rec)
  if (!store || rec.newer || encode(decode(raw)) !== raw) return false
  try { store.setItem(STAFF_KEY, raw) } catch { return false }
  return true
}

/** Forgets every post (no-op without storage). */
export function clearStaff(store: ProfileStore | null = browserStore()): void {
  if (!store) return
  try { store.removeItem(STAFF_KEY) } catch { /* storage unavailable */ }
}

/** Where `name` is posted (any case), or null. */
export const postOf = (rec: StaffRecord, name: string): Post | null => rec.posts.find((p) => same(p.name, name)) ?? null
/** Who is posted at workstation (c, r) of home `home`, or null. */
export const postAt = (rec: StaffRecord, home: number, c: number, r: number): Post | null => rec.posts.find((p) => at(p, home, c, r)) ?? null

/**
 * `name` posted at workstation (c, r) of `home`: off any workstation they had, whoever was there freed, and every post
 * whose name is not on `roster` let go. A write is the only time those go, never a load. App posts roster names only,
 * which every check here admits.
 */
export function postTo(rec: StaffRecord, name: string, home: number, c: number, r: number, roster: readonly string[]): StaffRecord {
  return postsFrom(entries([...rec.posts.filter((p) => !same(p.name, name) && !at(p, home, c, r) && roster.some((n) => same(n, p.name))), { name, home, c, r }]), rec.newer)
}

/** Workstation (c, r) of `home` with nobody posted at it. */
export const standDownAt = (rec: StaffRecord, home: number, c: number, r: number): StaffRecord => postsFrom(entries(rec.posts.filter((p) => !at(p, home, c, r))), rec.newer)

/**
 * The posts after the roster's names went from `before` to `after` (roster.ts keeps a record's place on a rename and
 * splices it out on a forget): one name changed in place, its post follows the new name; one name gone with the rest
 * in order, its post goes. Null for anything else (a hire, a new agent, a change of case, no change, several at once)
 * and when that agent had no post: nothing to write.
 */
export function carry(rec: StaffRecord, before: readonly string[], after: readonly string[]): StaffRecord | null {
  if (before.length === after.length) {
    const i = before.findIndex((n, k) => !same(n, after[k]))
    if (i < 0 || before.some((n, k) => k !== i && !same(n, after[k])) || !postOf(rec, before[i])) return null
    // A stale post already under the new name (another tab's, or an older build's) gives way to the agent's own.
    return postsFrom(entries(rec.posts.filter((p) => !same(p.name, after[i])).map((p) => (same(p.name, before[i]) ? { ...p, name: after[i] } : p))), rec.newer)
  }
  if (before.length !== after.length + 1) return null
  const i = before.findIndex((n, k) => !same(n, after[k] ?? ''))
  if (before.some((n, k) => k > i && !same(n, after[k - 1])) || !postOf(rec, before[i])) return null
  return postsFrom(entries(rec.posts.filter((p) => !same(p.name, before[i]))), rec.newer)
}
