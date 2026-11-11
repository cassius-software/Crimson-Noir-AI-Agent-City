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
 *
 * The two sky floors (rooms 7 and 8, homeGrid.ts ROOM_COUNT) are kept under a key of their own, SKY_KEY, in the same
 * form, so the homes' record stays byte for byte what an older build wrote and reads: an older build never meets a
 * changed record, and leaves the sky floors' key alone. Each key is read and written on its own, so a broken one never
 * empties the other's rooms.
 * What breaks if it is removed? Every visit starts with empty homes, and the furnishing card has nowhere to keep what
 * the operator placed.
 */
import { DEPTH, GRID, HOME_PIECES, ROOM_COUNT } from '../02_Define_The_Rules/homeGrid.ts'
import { FLOORS, WALLS, finishDefault, shapeOf, type Piece } from '../02_Define_The_Rules/homeLayout.ts'
import type { ProfileStore } from './profile.ts'

/** Keyed by the package id like the profile, the look and the progression. */
export const HOME_KEY = 'civic-simulation:home:v1'
/** The two sky floors' record (rooms 7 and 8), beside the homes' and in its form. */
export const SKY_KEY = 'civic-simulation:home-sky:v1'
/** The JSON record's own version (its `v`). */
export const HOME_RECORD_VERSION = 1
/** How many homes HOME_KEY's record holds, by property index: one for each home's depth (homeGrid.ts DEPTH). The sky floors follow them in the record. */
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

/** The whole record: ROOM_COUNT entries by room (the halls by property index, then the two sky floors), null for a room never furnished (its default finishes, no pieces). */
export type HomeRecord = readonly (HomeLayout | null)[]

/** `count` rooms with nothing furnished. */
const empty = (count: number): HomeRecord => Object.freeze(Array.from({ length: count }, () => null))

/** A record with nothing furnished: every room null. */
export function freshHomes(): HomeRecord {
  return empty(ROOM_COUNT)
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
 * A stored value as `count` rooms (HOME_COUNT under HOME_KEY, two under SKY_KEY). Never throws. A value that is not
 * text, is longer than RAW_MAX, is not JSON, is not an object of this version, or whose `homes` is not a list of
 * `count` gives `count` empty rooms; otherwise each room is read on its own (homeFrom), and one that is not one becomes
 * null while the others are kept.
 */
function decode(raw: unknown, count = HOME_COUNT): HomeRecord {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > RAW_MAX) return empty(count)
  let data: unknown
  try { data = JSON.parse(raw) } catch { return empty(count) }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return empty(count)
  const { v, homes } = data as { v?: unknown; homes?: unknown }
  if (v !== HOME_RECORD_VERSION || !Array.isArray(homes) || homes.length !== count) return empty(count)
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

/**
 * The saved record: the homes' key's seven rooms, then the sky floors' key's two, each read on its own (none saved,
 * storage unavailable, or an entry that is not a record leaves only that key's rooms empty). Never throws.
 */
export function loadHomes(store: ProfileStore | null = browserStore()): HomeRecord {
  const read = (key: string, count: number): HomeRecord => {
    if (!store) return empty(count)
    let raw: string | null
    try { raw = store.getItem(key) } catch { return empty(count) }
    return decode(raw, count)
  }
  return Object.freeze([...read(HOME_KEY, HOME_COUNT), ...read(SKY_KEY, ROOM_COUNT - HOME_COUNT)])
}

/**
 * Saves the record (ROOM_COUNT rooms, or nothing is written): the seven homes under HOME_KEY, exactly as before the
 * sky floors, and the two sky floors under SKY_KEY. A room with more than SAVED_MAX pieces is saved with its first
 * SAVED_MAX (its placed pieces and the first of those not placed here), never refused, so one crowded room cannot stop
 * the others from saving. Each key's text is then checked on its own: it is written only when reading it back gives
 * the same text (its rooms, finishes that exist, every piece well formed), so a store never holds a value that would
 * load as something else, and a key that fails keeps its last good save while the other is still written. Never
 * throws: a record that is not one, quota, private mode and blocked storage all return false. Returns whether both
 * keys were written.
 */
export function saveHomes(r: HomeRecord, store: ProfileStore | null = browserStore()): boolean {
  if (!store || !Array.isArray(r) || r.length !== ROOM_COUNT) return false
  const write = (key: string, rooms: HomeRecord): boolean => {
    let raw: string
    try { raw = encode(rooms) } catch { return false }
    if (raw.length > RAW_MAX || encode(decode(raw, rooms.length)) !== raw) return false
    try { store.setItem(key, raw) } catch { return false }
    return true
  }
  const halls = write(HOME_KEY, r.slice(0, HOME_COUNT))
  return write(SKY_KEY, r.slice(HOME_COUNT)) && halls
}

/** Forgets the saved record, both keys (no-op without storage): every room shows its default finishes, and its show home if unowned. */
export function clearHomes(store: ProfileStore | null = browserStore()): void {
  if (!store) return
  for (const key of [HOME_KEY, SKY_KEY]) {
    try { store.removeItem(key) } catch { /* storage unavailable */ }
  }
}

/**
 * One home's layout in saved order: the placed pieces first, then the ones kept as "not placed here", at most
 * SAVED_MAX in all. Those not placed here past it are let go, the last first, so the record in hand is the one a
 * reload brings back.
 */
export function layoutOf(floor: number, wall: number, placed: readonly Piece[], stored: readonly Piece[] = []): HomeLayout {
  return Object.freeze({ floor, wall, pieces: Object.freeze([...placed, ...stored].slice(0, SAVED_MAX)) })
}

/** A copy of `r` with room `home`'s entry replaced (null forgets it), ROOM_COUNT rooms. `r` itself is left as it was. */
export function withHome(r: HomeRecord, home: number, layout: HomeLayout | null): HomeRecord {
  if (!Number.isInteger(home) || home < 0 || home >= ROOM_COUNT) throw new RangeError(`no home ${home}`)
  return Object.freeze(Array.from({ length: ROOM_COUNT }, (_, i) => (i === home ? layout : r[i] ?? null)))
}

/** Room `home`'s finishes: the record's, or the room's defaults (homeLayout.ts finishDefault) while it has no entry. */
export function finishOf(r: HomeRecord, home: number): Readonly<{ floor: number; wall: number }> {
  const h = r[home]
  if (h) return { floor: h.floor, wall: h.wall }
  const d = Number.isInteger(home) && home >= 0 ? finishDefault(home) : undefined
  if (!d) throw new RangeError(`no home ${home}`)
  return d
}
