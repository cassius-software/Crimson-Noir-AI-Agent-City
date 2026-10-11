// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the onboarding conversation as plain data: what Wren, the concierge, says at each step,
 * the few one-word choices a brand-new visitor is offered (where to start, what time of day, sound on or off), how an
 * answer moves the conversation on, what the answers become as the page's options and as the saved choice a returning
 * visitor is taken back to, and when the onboarding is shown at all (a first visit, unless the URL says otherwise; never
 * in the console shell). Every line is plain words for someone who has never used anything like this; nothing here
 * names a shader, a seed or a frame rate. The React card (Onboarding.tsx) only renders this.
 * What breaks if it is removed? The onboarding has no words, no choices and no memory of the visitor's answers.
 */
import { REGIONS, ZONE, type Zone } from '../../01_Initialize_World/lakefront.ts'
import { zoneOf } from '../../01_Initialize_World/lakefrontPack.ts'
import type { Profile } from '../../05_Observe_Environment/profile.ts'

/** The steps, in order. */
export type Step = 'name' | 'place' | 'time' | 'sound' | 'ready'
export const STEPS: readonly Step[] = Object.freeze(['name', 'place', 'time', 'sound', 'ready'])

/** One of the one-word choices a step offers. */
export interface Choice<T> { label: string; value: T; blurb: string }

/** Where to start: one plain word per region, and what the visitor is told about it. */
export const PLACES: readonly Choice<Zone>[] = Object.freeze([
  { label: 'Downtown', value: ZONE.metropolis, blurb: 'Tall towers by the lake, and The Spire, the tallest of all.' },
  { label: 'West', value: ZONE.westSprawl, blurb: 'Quiet streets of houses, and a busy place called Transit City.' },
  { label: 'East', value: ZONE.eastBluffs, blurb: 'Houses on the cliffs, looking out over the lake.' },
  { label: 'North', value: ZONE.northRidge, blurb: 'Wide streets up on the ridge, with towers around the stations.' },
  { label: 'Ravine', value: ZONE.grandRavine, blurb: 'A deep green valley running right through the city.' },
])
export const TIMES: readonly Choice<number>[] = Object.freeze([
  { label: 'Morning', value: 9, blurb: 'Fresh light, long shadows.' },
  { label: 'Sunset', value: 17, blurb: 'Warm golden light.' },
  { label: 'Night', value: 22, blurb: 'Street lights and lit windows.' },
])
export const SOUNDS: readonly Choice<boolean>[] = Object.freeze([
  { label: 'On', value: true, blurb: 'You will hear the city around you.' },
  { label: 'Off', value: false, blurb: 'Quiet. You can turn it on later.' },
])

/** What the visitor has answered so far. */
export interface Answers { name: string; place: Zone | null; hour: number | null; audio: boolean | null }
export const NO_ANSWERS: Answers = Object.freeze({ name: '', place: null, hour: null, audio: null })

/** The name used when the visitor would rather not give one. */
export const NO_NAME = 'friend'

/** Wren's line for a step, given the answers so far (plain words, one or two short sentences). */
export function lineFor(step: Step, a: Answers, concierge: string): string {
  const name = a.name || NO_NAME
  switch (step) {
    case 'name': return `Hi, I’m ${concierge}. I’m going to build you a whole city to walk around in. While we talk, it’s already being built. First, what should I call you?`
    case 'place': return `Nice to meet you, ${name}. Your city has five parts. Where would you like to start?`
    case 'time': return `${placeOf(a.place)?.blurb ?? 'Good choice.'} Should it be morning, sunset or night when you arrive?`
    case 'sound': return 'Last one. Do you want sound on?'
    case 'ready': return `That’s everything, ${name}. Your city is ready. Press the button to walk in. You can look around by dragging, and walk with the arrow keys or the stick.`
  }
}

/** The choices a step offers (the name step takes typed text instead). */
export function choicesFor(step: Step): readonly Choice<unknown>[] | null {
  switch (step) {
    case 'place': return PLACES
    case 'time': return TIMES
    case 'sound': return SOUNDS
    default: return null
  }
}

export const placeOf = (zone: Zone | null): Choice<Zone> | null => PLACES.find((p) => p.value === zone) ?? null

/** The step after `step`. */
export function nextStep(step: Step): Step {
  const i = STEPS.indexOf(step)
  return STEPS[Math.min(i + 1, STEPS.length - 1)]
}

/** The answers with a step's choice taken (the name step takes the typed name; an empty one means "no name"). */
export function answer(a: Answers, step: Step, value: unknown): Answers {
  switch (step) {
    case 'name': return { ...a, name: typeof value === 'string' ? value : '' }
    case 'place': return { ...a, place: PLACES.some((p) => p.value === value) ? (value as Zone) : ZONE.metropolis }
    case 'time': return { ...a, hour: TIMES.some((t) => t.value === value) ? (value as number) : 17 }
    case 'sound': return { ...a, audio: value === true }
    default: return a
  }
}

/** What the visitor's choice reads as in the transcript (their side of the conversation). */
export function said(step: Step, a: Answers): string {
  switch (step) {
    case 'name': return a.name || 'I’d rather not say'
    case 'place': return placeOf(a.place)?.label ?? ''
    case 'time': return TIMES.find((t) => t.value === a.hour)?.label ?? ''
    case 'sound': return SOUNDS.find((s) => s.value === a.audio)?.label ?? ''
    default: return ''
  }
}

/** The page options the answers become. */
export function optionsFrom(a: Answers): { startHour: number; audio: boolean } {
  return { startHour: a.hour ?? 17, audio: a.audio ?? true }
}

// ─── What is kept between visits ────────────────────────────────────────────────────────────────────────────────────

/** Keyed by the package id, like the profile, so a product rename keeps the visitor's city. */
export const ONBOARDING_KEY = 'civic-simulation:onboarding:v1'

/** The saved outcome: where the visitor started (a region slug), the hour, the sound; or that they skipped to the expert path. */
export interface SavedOnboarding { v: 1; place: string | null; hour: number; audio: boolean; skipped: boolean }

export interface KeyStore { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

function browserStore(): KeyStore | null {
  try { return (globalThis as { localStorage?: KeyStore }).localStorage ?? null } catch { return null }
}

export function loadOnboarding(store: KeyStore | null = browserStore()): SavedOnboarding | null {
  if (!store) return null
  let raw: string | null
  try { raw = store.getItem(ONBOARDING_KEY) } catch { return null }
  if (typeof raw !== 'string' || !raw || raw.length > 512) return null
  try {
    const d = JSON.parse(raw) as Partial<SavedOnboarding>
    if (!d || typeof d !== 'object' || d.v !== 1) return null
    const hour = typeof d.hour === 'number' && Number.isFinite(d.hour) ? Math.min(24, Math.max(0, d.hour)) : 17
    return { v: 1, place: typeof d.place === 'string' && zoneOf(d.place) !== null ? d.place : null, hour, audio: d.audio !== false, skipped: d.skipped === true }
  } catch { return null }
}

export function saveOnboarding(s: SavedOnboarding, store: KeyStore | null = browserStore()): void {
  if (!store) return
  try { store.setItem(ONBOARDING_KEY, JSON.stringify(s)) } catch { /* storage unavailable */ }
}

export function clearOnboarding(store: KeyStore | null = browserStore()): void {
  if (!store) return
  try { store.removeItem(ONBOARDING_KEY) } catch { /* storage unavailable */ }
}

/** The saved outcome of finished answers. */
export function outcomeOf(a: Answers): SavedOnboarding {
  const o = optionsFrom(a)
  return { v: 1, place: REGIONS[a.place ?? ZONE.metropolis].slug, hour: o.startHour, audio: o.audio, skipped: false }
}

/** The saved outcome of the expert path ("I know my way around"): the procedural city, the page's own defaults. */
export const SKIPPED: SavedOnboarding = Object.freeze({ v: 1, place: null, hour: 17, audio: true, skipped: true })

// ─── When, and which map ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Whether the onboarding is shown: on a first visit (nothing saved from it and no profile), unless `?onboarding=0`
 * (the expert path) says not to; always with `?onboarding=1` (to see it again); never in the console shell (?boot=tty).
 */
export function needsOnboarding(q: URLSearchParams, saved: SavedOnboarding | null, profile: Profile | null): boolean {
  if (q.get('boot') === 'tty') return false
  const asked = q.get('onboarding')
  if (asked === '0' || asked === 'off') return false
  if (asked === '1' || asked === 'on') return true
  return saved === null && profile === null
}

export type MapChoice = 'lakefront' | 'region' | 'city'

/**
 * Which map the page walks: `?region=on` the embedded surveyed region (and by default in the pilot build, as before);
 * `?map=lakefront` the generated metropolis, `?map=city` or `?region=off` the procedural city; with nothing in the URL,
 * the metropolis the visitor chose in the onboarding, else the procedural city.
 */
export function mapWanted(q: URLSearchParams, saved: SavedOnboarding | null, regionFirst: boolean): MapChoice {
  const region = q.get('region'), map = q.get('map')
  if (region === 'on') return 'region'
  if (map === 'lakefront' || map === 'metro') return 'lakefront'
  if (map === 'city' || region === 'off') return 'city'
  if (regionFirst) return 'region'
  return saved && !saved.skipped && saved.place !== null ? 'lakefront' : 'city'
}
