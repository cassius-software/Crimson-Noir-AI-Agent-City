// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It remembers what the visitor chose to look like: their Look (03_Spawn_Agents/look.ts,
 * a record of indices into the crowd's closed wardrobe) kept in this browser's localStorage under a key of its own,
 * beside the profile's (profile.ts) and separate from it, so a renamed visitor keeps their outfit and a cleared
 * outfit keeps the name. Every storage access is guarded like the profile's, so a private window, blocked site data
 * or a file:// quirk reads as "no look" (the hash dresses them, as it dresses everyone) and a write is a no-op; and
 * every stored value goes through validateLook on the way in, so nothing a page once wrote, or a hand once edited,
 * can dress anyone in anything the crowd does not wear.
 * What breaks if it is removed? The player's look is lost between visits, and the customizer has nowhere to keep it.
 */
import { validateLook, type Look } from '../03_Spawn_Agents/look.ts'
import type { ProfileStore } from './profile.ts'

/** Keyed by the package id like the profile. The record's `v` is the look's layout: 1 the fourteen slots before the figure (read and upgraded by validateLook), 2 the twenty slots with the eight body sliders (written). */
export const LOOK_KEY = 'civic-simulation:look:v1'
export const LOOK_RECORD_VERSION = 2
/** A stored value longer than this is corrupt, not a look (twenty small integers are a few hundred bytes). */
const RAW_MAX = 1024

/** localStorage, or null where the page may not use it (reading the property itself can throw). */
function browserStore(): ProfileStore | null {
  try { return (globalThis as { localStorage?: ProfileStore }).localStorage ?? null } catch { return null }
}

/** The saved look, or null when there is none, storage is unavailable, or the entry is not a look within the wardrobe. */
export function loadLook(store: ProfileStore | null = browserStore()): Look | null {
  if (!store) return null
  let raw: string | null
  try { raw = store.getItem(LOOK_KEY) } catch { return null }
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > RAW_MAX) return null
  let data: unknown
  try { data = JSON.parse(raw) } catch { return null }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const { v, look } = data as { v?: unknown; look?: unknown }
  if (v !== 1 && v !== LOOK_RECORD_VERSION) return null
  return validateLook(look)
}

/** Saves a look (only one within the wardrobe; anything else is not written). Never throws: quota, private mode and
 *  blocked storage are silent no-ops. Returns whether it was written. */
export function saveLook(look: Look, store: ProfileStore | null = browserStore()): boolean {
  const valid = validateLook(look)
  if (!valid || !store) return false
  try { store.setItem(LOOK_KEY, JSON.stringify({ v: LOOK_RECORD_VERSION, look: valid })) } catch { return false }
  return true
}

/** Forgets the saved look (no-op without storage): the hash dresses the player again on the next visit. */
export function clearLook(store: ProfileStore | null = browserStore()): void {
  if (!store) return
  try { store.removeItem(LOOK_KEY) } catch { /* storage unavailable */ }
}
