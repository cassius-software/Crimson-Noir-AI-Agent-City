// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It remembers the operator's progression between visits: the one record
 * (02_Define_The_Rules/progression.ts: level, XP, credits, skills and every unlock bought) kept in this browser's
 * localStorage under a key of its own, beside the profile's and the look's. Every storage access is guarded like
 * theirs, so a private window, blocked site data or a file:// quirk reads as "no record" (a new operator starts) and
 * a write is a no-op; and a stored record is used only when it has the right length and layout, its seal matches and
 * every field is in range (whyInvalid), so a damaged entry never becomes a level 20 operator with negative credits.
 * A record that fails is set aside under a second key rather than overwritten, so nothing is lost without a trace.
 * Nothing leaves the device.
 * What breaks if it is removed? Every visit starts a new operator, and what was bought is gone.
 */
import { RECORD_WORDS, recordBuffer, whyInvalid, type ProgressRecord } from '../02_Define_The_Rules/progression.ts'
import type { ProfileStore } from './profile.ts'

/** Keyed by the package id like the profile and the look. */
export const PROGRESS_KEY = 'civic-simulation:progress:v1'
/** Where a stored record that failed its checks is moved, once, before a new one is written. */
export const PROGRESS_SET_ASIDE_KEY = 'civic-simulation:progress:set-aside'
/** The JSON record's own version (its `v`). */
export const PROGRESS_RECORD_VERSION = 1
/** A stored value longer than this is corrupt, not a record (128 integers are a few kilobytes at most). */
const RAW_MAX = 4096

/** localStorage, or null where the page may not use it (reading the property itself can throw). */
function browserStore(): ProfileStore | null {
  try { return (globalThis as { localStorage?: ProfileStore }).localStorage ?? null } catch { return null }
}

/** What loading found: a record, nothing stored, or a stored value that could not be used (and why). */
export type ProgressLoad = { readonly record: ProgressRecord } | { readonly record: null; readonly why?: string }

/** Reads the stored record. A value that fails is moved to PROGRESS_SET_ASIDE_KEY and reported with its reason. */
export function loadProgress(store: ProfileStore | null = browserStore()): ProgressLoad {
  if (!store) return { record: null }
  let raw: string | null
  try { raw = store.getItem(PROGRESS_KEY) } catch { return { record: null } }
  if (raw === null || raw === '') return { record: null }
  const why = (reason: string): ProgressLoad => {
    try {
      store.setItem(PROGRESS_SET_ASIDE_KEY, raw.slice(0, RAW_MAX))
      store.removeItem(PROGRESS_KEY)
    } catch { /* storage refused: the next save overwrites it */ }
    return { record: null, why: reason }
  }
  if (typeof raw !== 'string' || raw.length > RAW_MAX) return why('the stored record is too long')
  let data: unknown
  try { data = JSON.parse(raw) } catch { return why('the stored record is not JSON') }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return why('the stored record is not an object')
  const { v, words } = data as { v?: unknown; words?: unknown }
  if (v !== PROGRESS_RECORD_VERSION) return why(`the stored record is version ${String(v)}`)
  if (!Array.isArray(words) || words.length !== RECORD_WORDS || !words.every((n) => Number.isInteger(n) && n >= -0x80000000 && n <= 0xffffffff)) {
    return why('the stored record does not have its words')
  }
  const record = new Int32Array(recordBuffer())
  for (let i = 0; i < RECORD_WORDS; i++) record[i] = words[i] as number
  const bad = whyInvalid(record)
  return bad ? why(bad) : { record }
}

/** Saves the record. Never throws: quota, private mode and blocked storage are silent no-ops. Returns whether it was written. */
export function saveProgress(record: ProgressRecord, store: ProfileStore | null = browserStore()): boolean {
  if (!store || whyInvalid(record)) return false
  try { store.setItem(PROGRESS_KEY, JSON.stringify({ v: PROGRESS_RECORD_VERSION, words: Array.from(record) })) } catch { return false }
  return true
}

/** Forgets the stored record (no-op without storage): the next visit starts a new operator. */
export function clearProgress(store: ProfileStore | null = browserStore()): void {
  if (!store) return
  try { store.removeItem(PROGRESS_KEY) } catch { /* storage unavailable */ }
}
