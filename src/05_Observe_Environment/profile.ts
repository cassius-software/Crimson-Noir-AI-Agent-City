/**
 * Why does this file exist? It remembers who is visiting: the name the user gave the Concierge and the
 * avatar seed derived from it, kept in this browser's localStorage (a per-viewer convenience; nothing
 * leaves the device). Every storage access is guarded, so a private window, blocked site data or a
 * file:// quirk reads as "no profile" and a write becomes a no-op: the city always starts.
 * What breaks if it is removed? The Concierge cannot greet a returning user by name, and the avatar
 * seed is not stable across visits.
 */

export interface Profile { name: string; seed: number }

/** The Web Storage calls used here; tests pass a Map-backed fake. */
export interface ProfileStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Longest name kept, in UTF-16 code units (so also at most 24 code points). */
export const NAME_MAX = 24
/** Keyed by the package id, not the provisional product name, so a rename keeps returning users. */
export const PROFILE_KEY = 'civic-simulation:profile:v1'
/** A stored value longer than this is corrupt, not a profile. */
const RAW_MAX = 1024

/**
 * Removed outright: C0/C1 controls (after line breaks and tabs became spaces), soft hyphen, the Arabic
 * letter mark, zero-width and invisible format characters, bidi marks, embeddings, overrides and
 * isolates (they can reorder the text around a name), deprecated format controls, BOM, interlinear
 * annotation marks, lone surrogates, non-characters, and blank "filler" letters that render as nothing.
 * ZWJ and ZWNJ (U+200D, U+200C) stay: emoji sequences and several scripts need them.
 */
const DROP = /[\p{Cc}\p{Cs}\u00AD\u061C\u115F\u1160\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u2800\u3164\uFEFF\uFFA0\uFFF9-\uFFFB\uFFFE\uFFFF]/gu
/** More than four combining marks on one base is stacking abuse, not writing. */
const MARK_RUN = /(\p{M}{4})\p{M}+/gu
/** A name must show at least one letter, digit, symbol or punctuation mark. */
const VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u

let segmenter: Intl.Segmenter | null | undefined
function graphemes(s: string): Iterable<string> {
  if (segmenter === undefined) {
    try { segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null } catch { segmenter = null }
  }
  if (!segmenter) return s // code points: never splits a surrogate pair
  const seg = segmenter
  return { *[Symbol.iterator]() { for (const g of seg.segment(s)) yield g.segment } }
}

/** Longest prefix of whole graphemes that fits in `max` UTF-16 code units. */
function fit(s: string, max: number): string {
  if (s.length <= max) return s
  let out = ''
  for (const g of graphemes(s)) {
    if (out.length + g.length > max) break
    out += g
  }
  return out
}

/** Trimmed, whitespace collapsed, control/bidi/invisible characters dropped, at most NAME_MAX code units
 *  without cutting a character in half; '' if nothing visible is left. */
export function sanitizeName(raw: string): string {
  if (typeof raw !== 'string') return ''
  const name = raw
    .slice(0, RAW_MAX)
    .normalize('NFC')
    .replace(/\uFEFF/g, '') // invisible, yet JavaScript's \s would turn it into a space
    .replace(/\s+/gu, ' ')
    .replace(DROP, '')
    .replace(MARK_RUN, '$1')
    .replace(/ {2,}/g, ' ')
    .trim()
  const kept = fit(name, NAME_MAX).trimEnd()
  return VISIBLE.test(kept) ? kept : ''
}

/** Stable unsigned 32-bit hash of the name's UTF-8 bytes: FNV-1a, then the murmur3 finalizer so short,
 *  similar names still land far apart. Any value 0 … 2³²−1 is possible. */
export function seedFromName(name: string): number {
  const bytes = new TextEncoder().encode(name)
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

const isSeed = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff

/** localStorage, or null where the page may not use it (reading the property itself can throw). */
function browserStore(): ProfileStore | null {
  try { return (globalThis as { localStorage?: ProfileStore }).localStorage ?? null } catch { return null }
}

/** The saved profile, or null when there is none, storage is unavailable, or the entry is unusable. */
export function loadProfile(store: ProfileStore | null = browserStore()): Profile | null {
  if (!store) return null
  let raw: string | null
  try { raw = store.getItem(PROFILE_KEY) } catch { return null }
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > RAW_MAX) return null
  let data: unknown
  try { data = JSON.parse(raw) } catch { return null }
  if (!data || typeof data !== 'object') return null
  const { name, seed } = data as { name?: unknown; seed?: unknown }
  if (typeof name !== 'string') return null
  const clean = sanitizeName(name)
  if (!clean) return null
  // A valid stored seed wins, so the avatar stays the same even if the name rules change.
  return { name: clean, seed: isSeed(seed) ? seed : seedFromName(clean) }
}

/** Saves the profile (name sanitized; an invalid seed is re-derived). A name that sanitizes to '' is not
 *  saved. Never throws: quota, private mode and blocked storage are silent no-ops. */
export function saveProfile(p: Profile, store: ProfileStore | null = browserStore()): void {
  const name = sanitizeName(p?.name)
  if (!name || !store) return
  const seed = isSeed(p.seed) ? p.seed : seedFromName(name)
  try { store.setItem(PROFILE_KEY, JSON.stringify({ v: 1, name, seed })) } catch { /* storage unavailable */ }
}

/** Forgets the saved profile (no-op without storage). */
export function clearProfile(store: ProfileStore | null = browserStore()): void {
  if (!store) return
  try { store.removeItem(PROFILE_KEY) } catch { /* storage unavailable */ }
}
