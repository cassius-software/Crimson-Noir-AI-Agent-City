// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It remembers how the operator furnished the seven homes (01_Initialize_World/properties.ts)
 * between visits: one record in this browser's localStorage under a key of its own, beside the profile's, the look's
 * and the progression's. Each home is kept by its property index (0 the micro-loft to 6 the sky-mansion) in the room
 * frame of its floor plan (02_Define_The_Rules/homeGrid.ts), so a layout does not depend on which lot the home stands
 * on, which way its door faces, the city's seed or the map: its floor and wall finish, and its pieces as a catalogue
 * id, a column, a row and a turn.
 *
 * Every storage access is guarded like the other stores', so a private window, blocked site data or a file:// quirk
 * reads as "nothing furnished" and a write is a no-op. What is read is checked for its form only, the way the roster
 * is: a value that is not this record at all gives a fresh record, a home that is not a home is forgotten on its own,
 * and a piece that is not a piece is dropped on its own. Whether a piece fits its home, and whether its line is still
 * owned, is not decided here: homeLayout.ts fitLayout decides that each time the home is drawn, and keeps a piece
 * that does not fit as "not placed here" rather than deleting it, so a layout survives a progress reset or a change
 * of purse. Nothing leaves the device. Two tabs: the last save wins.
 * What breaks if it is removed? Every visit starts with empty homes, and the furnishing card has nowhere to keep what
 * the operator placed.
 */
import { DEPTH, GRID, HOME_PIECES } from '../02_Define_The_Rules/homeGrid.ts'
import { DEFAULT_FINISH, FLOORS, WALLS, shapeOf, type Piece } from '../02_Define_The_Rules/homeLayout.ts'
import type { ProfileStore } from './profile.ts'

/** Keyed by the package id like the profile, the look and the progression. */
export const HOME_KEY = 'civic-simulation:home:v1'
/** The JSON record's own version (its `v`). */
export const HOME_RECORD_VERSION = 1
/** How many homes the record holds, by property index: one for each home's depth (homeGrid.ts DEPTH). */
export const HOME_COUNT = DEPTH.length
/**
 * The most pieces one home keeps: the HOME_PIECES a home can hold placed, plus up to eight that do not fit or are not
 * owned and are kept as "not placed here". Nothing in the furnishing rules stops a home going past it (a progress
 * reset stores every placed piece, and new lines can then fill the floor again), so layoutOf and saveHomes keep a home
 * within it themselves: the placed pieces come first, and the "not placed here" ones past it are let go, the last
 * first. A home over it never makes the whole record unsavable.
 */
export const SAVED_MAX = HOME_PIECES + 8
/**
 * A stored value longer than this is corrupt, not a record. The longest record (seven homes of SAVED_MAX pieces, each
 * piece four small whole numbers) is about 2.5 KB, so every record this file writes fits.
 */
export const RAW_MAX = 4096

/** One home's furnishing: its floor and wall finish (indices into homeLayout.ts FLOORS and WALLS) and its pieces. */
export interface HomeLayout {
  readonly floor: number
  readonly wall: number
  /** In saved order: the placed pieces first, then the ones kept as "not placed here" (layoutOf). */
  readonly pieces: readonly Piece[]
}

/** The whole record: HOME_COUNT entries by property index, null for a home never furnished (its default finishes, no pieces). */
export type HomeRecord = readonly (HomeLayout | null)[]

/** A record with nothing furnished: every home null. */
export function freshHomes(): HomeRecord {
  return Object.freeze(Array.from({ length: HOME_COUNT }, () => null))
}

/** Whether n is a whole number from 0 to max. */
const whole = (n: unknown, max: number): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= max

/** A stored piece [id, c, r, rot] as a piece, or null when it is not four whole numbers with a furniture line, cells on the grid and a turn of 0 to 3. */
function pieceFrom(raw: unknown): Piece | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null
  const [id, c, r, rot] = raw as unknown[]
  if (!Number.isInteger(id) || shapeOf(id as number) === null) return null
  if (!whole(c, GRID - 1) || !whole(r, GRID - 1) || !whole(rot, 3)) return null
  return Object.freeze({ id: id as number, c, r, rot })
}

/**
 * A stored home [floor, wall, pieces] as a layout, or null when it is not one: a floor or wall that is not a whole
 * number naming a finish, or pieces that are not a list of at most SAVED_MAX. A piece that is not a piece is dropped
 * and its siblings are kept.
 */
function homeFrom(raw: unknown): HomeLayout | null {
  if (!Array.isArray(raw) || raw.length !== 3) return null
  const [floor, wall, pieces] = raw as unknown[]
  if (!whole(floor, FLOORS.length - 1) || !whole(wall, WALLS.length - 1)) return null
  if (!Array.isArray(pieces) || pieces.length > SAVED_MAX) return null
  const kept: Piece[] = []
  for (const p of pieces as unknown[]) {
    const piece = pieceFrom(p)
    if (piece) kept.push(piece)
  }
  return Object.freeze({ floor, wall, pieces: Object.freeze(kept) })
}

/**
 * A stored value as a record. Never throws. A value that is not text, is longer than RAW_MAX, is not JSON, is not an
 * object of this version, or whose `homes` is not a list of HOME_COUNT gives a fresh record; otherwise each home is
 * read on its own (homeFrom), and a home that is not one becomes null while the others are kept.
 */
function decode(raw: unknown): HomeRecord {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > RAW_MAX) return freshHomes()
  let data: unknown
  try { data = JSON.parse(raw) } catch { return freshHomes() }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return freshHomes()
  const { v, homes } = data as { v?: unknown; homes?: unknown }
  if (v !== HOME_RECORD_VERSION || !Array.isArray(homes) || homes.length !== HOME_COUNT) return freshHomes()
  return Object.freeze((homes as unknown[]).map((h) => (h === null ? null : homeFrom(h))))
}

/**
 * A record as the text the key holds: {"v":1,"homes":[[floor,wall,[[id,c,r,rot],...]] | null, ...]}, each home's first
 * SAVED_MAX pieces only (layoutOf puts the placed ones first). Throws when `r` is not record-shaped.
 */
function encode(r: HomeRecord): string {
  return JSON.stringify({ v: HOME_RECORD_VERSION, homes: r.map((h) => (h ? [h.floor, h.wall, h.pieces.slice(0, SAVED_MAX).map((p) => [p.id, p.c, p.r, p.rot])] : null)) })
}

/** localStorage, or null where the page may not use it (reading the property itself can throw). */
function browserStore(): ProfileStore | null {
  try { return (globalThis as { localStorage?: ProfileStore }).localStorage ?? null } catch { return null }
}

/** The saved record, or a fresh one when there is none, storage is unavailable, or the entry is not a record. Never throws. */
export function loadHomes(store: ProfileStore | null = browserStore()): HomeRecord {
  if (!store) return freshHomes()
  let raw: string | null
  try { raw = store.getItem(HOME_KEY) } catch { return freshHomes() }
  return decode(raw)
}

/**
 * Saves the record. A home with more than SAVED_MAX pieces is saved with its first SAVED_MAX (its placed pieces and
 * the first of those not placed here), never refused, so one crowded home cannot stop the other six from saving. The
 * text is then checked: it is written only when reading it back gives the same text (HOME_COUNT homes, finishes that
 * exist, every piece well formed), so a store never holds a value that would load as something else, and a record that
 * fails leaves the last good save in place. Never throws: a record that is not one, quota, private mode and blocked
 * storage all return false. Returns whether it was written.
 */
export function saveHomes(r: HomeRecord, store: ProfileStore | null = browserStore()): boolean {
  if (!store) return false
  let raw: string
  try { raw = encode(r) } catch { return false }
  if (raw.length > RAW_MAX || encode(decode(raw)) !== raw) return false
  try { store.setItem(HOME_KEY, raw) } catch { return false }
  return true
}

/** Forgets the saved record (no-op without storage): every home shows its default finishes, and its show home if unowned. */
export function clearHomes(store: ProfileStore | null = browserStore()): void {
  if (!store) return
  try { store.removeItem(HOME_KEY) } catch { /* storage unavailable */ }
}

/**
 * One home's layout in saved order: the placed pieces first, then the ones kept as "not placed here", at most
 * SAVED_MAX in all. Those not placed here past it are let go, the last first, so the record in hand is the one a
 * reload brings back.
 */
export function layoutOf(floor: number, wall: number, placed: readonly Piece[], stored: readonly Piece[] = []): HomeLayout {
  return Object.freeze({ floor, wall, pieces: Object.freeze([...placed, ...stored].slice(0, SAVED_MAX)) })
}

/** A copy of `r` with home `home`'s entry replaced (null forgets it). `r` itself is left as it was. */
export function withHome(r: HomeRecord, home: number, layout: HomeLayout | null): HomeRecord {
  if (!Number.isInteger(home) || home < 0 || home >= HOME_COUNT) throw new RangeError(`no home ${home}`)
  return Object.freeze(Array.from({ length: HOME_COUNT }, (_, i) => (i === home ? layout : r[i] ?? null)))
}

/** Home `home`'s finishes: the record's, or the home's defaults (homeLayout.ts DEFAULT_FINISH) while it has no entry. */
export function finishOf(r: HomeRecord, home: number): Readonly<{ floor: number; wall: number }> {
  const h = r[home]
  if (h) return { floor: h.floor, wall: h.wall }
  const d = DEFAULT_FINISH[home]
  if (!d) throw new RangeError(`no home ${home}`)
  return d
}
