// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the one place that decides whether the first-run tutorial (Sloane's "first walk",
 * 09_Cognition/firstWalk.ts) is on, and the one record that it was passed. The walk is on for every first run of the
 * city shell until its exit program has been run once, and only three things in the URL say otherwise: `?boot=tty`
 * (no city, nothing to walk), `?tutorial=0|off` (the setting off for this visit), and `?onboarding=0|off` (the expert
 * path the browser smoke, the harnesses and a developer take); `?tutorial=1|on` shows it again after a pass. No
 * button, key or menu turns it off (that is the point of it; FIRST_WALK_DEFAULT is the one constant that makes it
 * opt-in instead). The pass is kept under the package id like the onboarding's outcome, so a product rename keeps
 * it; it is written only when the console's exam unlocked the city, never by the card.
 * What breaks if it is removed? The walk has no switch and no memory: it shows every visit, or never.
 */
import type { KeyStore } from './script.ts'

/**
 * Whether a first run opens on the walk at all. True: the walk is mandatory on a first run, as the brief asks, and
 * the only way out is the console's exit program (its three words, verify_ring0, spawn_subagents and unlock_city, are
 * NoirScript's: terminal/noirscript, wired through onboarding/exam.ts). False: the walk shows only with `?tutorial=1`.
 * Flip this one constant to change the default; nothing else reads a setting.
 */
export const FIRST_WALK_DEFAULT = true

/** Keyed by the package id, like the profile and the onboarding, so a product rename keeps the pass. */
export const FIRST_WALK_KEY = 'civic-simulation:first-walk:v1'

/** The record of a pass: the version, that it was passed, and when (ms since the epoch, as the host gave it). */
export interface SavedFirstWalk { v: 1; passed: true; at: number }

function browserStore(): KeyStore | null {
  try { return (globalThis as { localStorage?: KeyStore }).localStorage ?? null } catch { return null }
}

export function loadFirstWalk(store: KeyStore | null = browserStore()): SavedFirstWalk | null {
  if (!store) return null
  let raw: string | null
  try { raw = store.getItem(FIRST_WALK_KEY) } catch { return null }
  if (typeof raw !== 'string' || !raw || raw.length > 128) return null
  try {
    const d = JSON.parse(raw) as Partial<SavedFirstWalk>
    if (!d || typeof d !== 'object' || d.v !== 1 || d.passed !== true) return null
    return { v: 1, passed: true, at: typeof d.at === 'number' && Number.isFinite(d.at) ? d.at : 0 }
  } catch { return null }
}

/** The city was unlocked by the exit program: kept, so the next visit opens on the city. */
export function saveFirstWalkPassed(at: number, store: KeyStore | null = browserStore()): void {
  if (!store) return
  const s: SavedFirstWalk = { v: 1, passed: true, at: Number.isFinite(at) ? at : 0 }
  try { store.setItem(FIRST_WALK_KEY, JSON.stringify(s)) } catch { /* storage unavailable */ }
}

export function clearFirstWalk(store: KeyStore | null = browserStore()): void {
  if (!store) return
  try { store.removeItem(FIRST_WALK_KEY) } catch { /* storage unavailable */ }
}

/**
 * Whether the walk is on for this visit: never in the console shell (?boot=tty); off with `?tutorial=0|off`; on
 * with `?tutorial=1|on` (again, after a pass); off on the expert path (`?onboarding=0|off`: the smoke, the harnesses,
 * a developer); else on for a first run, until passed, when the default says so.
 */
export function needsFirstWalk(q: URLSearchParams, saved: SavedFirstWalk | null, defaultOn: boolean = FIRST_WALK_DEFAULT): boolean {
  if (q.get('boot') === 'tty') return false
  const asked = q.get('tutorial')
  if (asked === '0' || asked === 'off') return false
  if (asked === '1' || asked === 'on') return true
  const onboarding = q.get('onboarding')
  if (onboarding === '0' || onboarding === 'off') return false
  return defaultOn && saved === null
}
