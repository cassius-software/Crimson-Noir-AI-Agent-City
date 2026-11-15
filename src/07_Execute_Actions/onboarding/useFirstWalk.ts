// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the page's side of the first walk (09_Cognition/firstWalk.ts): the React hook that
 * starts the six stages once the city is on screen, feeds the walk what the page sees (the HUD's snapshot a few times
 * a second: where the visitor stands, where the head points, how far they have come, whether they are at a wheel,
 * inside one of the workplaces, or at the console) and what the page reports outright (a goal sent to Sloane, a
 * console line run, the wardrobe, a shop's card or a home's doorstep card put away, the exit program's doors), asks it
 * once a second whether there is something to say and whether to lend a hand, and hands the line to the card and the
 * voice, in the model's rewording when one answers in time and keeps the words the line needs. When the walk is passed
 * (the console reached) it writes the one record that keeps the city open on the next visit. It also reads the
 * visitor's machine for the first card (`machineOf`) and finds the walk's marker (`beaconOf`: the nearest parked car,
 * the nearest workplace's doorway), as plain data the host draws. It listens only; nothing here writes to the engine
 * or the simulation (the card's accessible path and the marker are the host's).
 * What breaks if it is removed? The walk has no clock, no eyes and no mouth on the page, and no pass is ever kept.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { insideRoom } from '../../01_Initialize_World/interiors.ts'
import type { DeviceProfile, HardwareClass } from '../../05_Observe_Environment/governor.ts'
import type { SipocSnapshot } from '../../05_Observe_Environment/telemetry.ts'
import type { Engine } from '../engine.ts'
import { glyph, type GlyphFamily } from '../glyphs.ts'
import { FirstWalk, type Beat, type ControlWords, type Stage, type StageCard, type WalkEvent, type WalkPlace, type WalkReading } from '../../09_Cognition/firstWalk.ts'
import { saveFirstWalkPassed } from './firstWalkStore.ts'
import { familyOf } from './useMentor.ts'
import { mustKeep, type Voice } from './voice.ts'

/** How often the walk is asked whether it is time to say something, ms. */
export const TICK_MS = 1000

/** The device's words for the controls the walk names, from the glyph family in use. */
export function wordsOf(f: GlyphFamily): ControlWords {
  return { move: glyph('move', f), look: glyph('look', f), interact: glyph('interact', f), console: glyph('console', f) }
}

/** Which way (x, z) lies from (x0, z0), as the compass says it (−z is north, as the minimap draws it). */
export function bearingOf(x0: number, z0: number, x: number, z: number): string {
  const dx = x - x0, dz = z - z0
  return Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? 'east' : 'west') : dz >= 0 ? 'south' : 'north'
}

/** The nearest workplace's door from (x, z), named for the hint, or null when there is none. */
export function nearestPlace(rooms: readonly { name: string; door: { x: number; z: number } }[], x: number, z: number): WalkPlace | null {
  let best: WalkPlace | null = null
  for (const r of rooms) {
    const metres = Math.hypot(r.door.x - x, r.door.z - z)
    if (best === null || metres < best.metres) best = { name: `the ${r.name}`, metres, bearing: bearingOf(x, z, r.door.x, r.door.z) }
  }
  return best
}

/** What the walk reads of the page from a snapshot: where the visitor stands and looks, how far they have come, at a wheel, indoors, at the console. */
function readingOf(hud: SipocSnapshot, engine: Engine, consoleOpen: boolean): WalkReading {
  const x = hud.customer.x, z = hud.customer.z
  return {
    x, z, yaw: hud.customer.viewYaw,
    travelled: hud.experience.distanceWalked + hud.experience.distanceDriven,
    driving: hud.input.mode === 'vehicle',
    inside: engine.workplaces().some((r) => insideRoom(r, x, z)),
    consoleOpen,
  }
}

/** The first card's reading of the visitor's machine, in plain words (three rows: the device, the picture, Sloane). */
export interface MachineReading {
  /** 'A phone', 'A laptop or desktop', 'A workstation'. */
  readonly device: string
  /** The graphics, plainly: 'built-in graphics', 'its own graphics card', 'phone graphics', or '' when unknown. */
  readonly graphics: string
  /** The quality tier the city runs at now (governor.ts labels: Lite, Minimal ... Ultra, Peak). */
  readonly picture: string
  /** The tier as a share of the scale, 0..1 (Lite the least, Peak the most), for the card's bar. */
  readonly level: number
  /** Sloane's state: her planner runs on every device, so she is always ready to plan. */
  readonly sloane: string
}

const DEVICE_WORDS: Record<HardwareClass, string> = { phone: 'A phone', desktop: 'A laptop or desktop', workstation: 'A workstation' }
const GRAPHICS_WORDS: Record<DeviceProfile['gpuClass'], string> = { mobile: 'phone graphics', integrated: 'built-in graphics', discrete: 'its own graphics card', unknown: '' }
/** The quality tiers' range (governor.ts: −1 Lite up to 5 Peak). */
const TIER_LOW = -1, TIER_HIGH = 5

/** The machine as the first card says it: what the engine sized the city for and the tier it runs at now. */
export function machineOf(hardware: HardwareClass, gpu: DeviceProfile['gpuClass'], quality: { label: string; tier: number }): MachineReading {
  const tier = Number.isFinite(quality.tier) ? Math.min(TIER_HIGH, Math.max(TIER_LOW, Math.round(quality.tier))) : TIER_LOW
  return Object.freeze({
    device: DEVICE_WORDS[hardware] ?? 'A computer',
    graphics: GRAPHICS_WORDS[gpu] ?? '',
    picture: quality.label,
    level: (tier - TIER_LOW + 1) / (TIER_HIGH - TIER_LOW + 1),
    sloane: 'Ready to plan',
  })
}

/** The walk's marker: a place over the world and on the minimap the stage sends the visitor to (engine.ts setBeacon). */
export interface WalkBeacon { readonly x: number; readonly z: number; readonly label: string }

/** What the marker reads from the city: the cars and the workplaces' doorways. */
export interface BeaconCity {
  cars: readonly { readonly x: number; readonly z: number; readonly mode: string }[]
  rooms: readonly { readonly name: string; readonly door: { readonly x: number; readonly z: number } }[]
}

/**
 * The marker for a stage, from where the visitor stands: on the car stage the nearest parked car (the nearest one not at
 * the visitor's own wheel when none is parked, labelled for what it is: a car in traffic is no parked car), on the
 * indoor stage the nearest workplace's doorway; null on every other stage, or when the map has none.
 */
export function beaconOf(stage: Stage | null, city: BeaconCity, x: number, z: number): WalkBeacon | null {
  if (stage === 'fleet') {
    let best: BeaconCity['cars'][number] | null = null, near = Number.POSITIVE_INFINITY
    for (const c of city.cars) {
      if (c.mode === 'player') continue
      const d = Math.hypot(c.x - x, c.z - z) + (c.mode === 'parked' ? 0 : 1e6)
      if (d < near) { near = d; best = c }
    }
    return best ? { x: best.x, z: best.z, label: best.mode === 'parked' ? 'Parked car' : 'Car' } : null
  }
  if (stage === 'work') {
    let best: BeaconCity['rooms'][number] | null = null, near = Number.POSITIVE_INFINITY
    for (const r of city.rooms) {
      const d = Math.hypot(r.door.x - x, r.door.z - z)
      if (d < near) { near = d; best = r }
    }
    // One short word for every room: the names run to fifty letters, too wide for a chip over the world on a phone
    // (Sloane's hint names the nearest one in full).
    return best ? { x: best.door.x, z: best.door.z, label: 'Workplace door' } : null
  }
  return null
}

export interface FirstWalkProps {
  /** Whether the walk is on at all (firstWalkStore.ts needsFirstWalk), with the city on screen. */
  active: boolean
  engine: Engine | null
  hud: SipocSnapshot | null
  family: GlyphFamily
  /** The visitor's name, or ''. */
  name: string
  /** Who says the lines: the script, or the configured model over it (onboarding/voice.ts). */
  voice: Voice
  /** The Ring-0 console is open. */
  termOpen: boolean
  /** The clock the walk runs on (performance.now by default; tests inject one). */
  now?: () => number
  /** When the pass is written (Date.now by default). */
  wallClock?: () => number
  /** Tests shorten the waits. */
  timing?: { assistMs?: number; hintMs?: number; cooldownMs?: number; tickMs?: number }
}

/** The walk as React state: the card to show, Sloane's newest line, whether it lends a hand, whether it is passed, and the reports the host makes. */
export interface FirstWalkState {
  /** The card for the stage the visitor is on; null before the walk starts and once it is passed. */
  card: StageCard | null
  stage: Stage | null
  /** Sloane's newest line (null when none yet; a new one has a new id; the line that ends the walk is kind 'passed'). */
  beat: Beat | null
  /** The walk is lending a hand on this stage (09_Cognition/firstWalk.ts WALK.assistMs with nothing done on it). */
  assisting: boolean
  passed: boolean
  /** The host reports what readings cannot show (a goal sent, a door of the exit). */
  note(e: WalkEvent): void
  /** The host reports a console line run (the console open on the last stage ends the walk). */
  line(text: string): void
}

/**
 * The default clocks, made once. A default written inline would be a new function on every render, and the hook
 * restarts its once-a-second tick whenever the clock changes: the page renders on every HUD snapshot (ten a second),
 * so the tick never came round and Sloane's lines, the hint, the lent hand and the closing line waited for a slow frame.
 */
const PERF_NOW = (): number => performance.now()
const WALL_NOW = (): number => Date.now()

export function useFirstWalk({ active, engine, hud, family, name, voice, termOpen, now = PERF_NOW, wallClock = WALL_NOW, timing }: FirstWalkProps): FirstWalkState {
  const walk = useRef<FirstWalk | null>(null)
  const [beat, setBeat] = useState<Beat | null>(null)
  const [stage, setStage] = useState<Stage | null>(null)
  const [card, setCard] = useState<StageCard | null>(null)
  const [assisting, setAssisting] = useState(false)
  const [passed, setPassed] = useState(false)
  /** The pass written once, whatever renders follow. */
  const kept = useRef(false)
  const latest = useRef({ hud, family, name, voice, timing, termOpen, wallClock })
  useEffect(() => { latest.current = { hud, family, name, voice, timing, termOpen, wallClock } }, [hud, family, name, voice, timing, termOpen, wallClock])

  /** The React state follows the walk (its stage, whether it lends a hand, the pass), without a render per reading. */
  const sync = useCallback(() => {
    const w = walk.current
    if (!w) return
    const next = w.passed ? null : w.stage
    setStage((s) => (s === next ? s : next))
    setCard((c) => ((c?.stage ?? null) === next ? c : next === null ? null : w.card))
    setAssisting(w.assisting)
    if (w.passed && !kept.current) {
      kept.current = true
      saveFirstWalkPassed(latest.current.wallClock())
      setPassed(true)
    }
  }, [])

  // Every snapshot is a reading (once the walk has started).
  useEffect(() => {
    const w = walk.current
    if (!w || !hud || !engine) return
    w.read(readingOf(hud, engine, termOpen), now())
    sync()
  }, [hud, engine, termOpen, now, sync])

  // The walk: started once the city is on screen for an active visitor, then once a second the question whether there
  // is something to say. The script's line shows at once; the model's rewording replaces it if it comes in time and
  // keeps the words the line needs.
  const ready = active && engine !== null && hud !== null
  useEffect(() => {
    if (!ready || !engine) return
    if (!walk.current) {
      const { hud: h, family: f, name: n, timing: t } = latest.current
      const rooms = engine.workplaces()
      const w = new FirstWalk({
        family: familyOf(f),
        words: wordsOf(f),
        name: n,
        // Whether the map has shops (the city's five, Lakefront Metro's up to five, a surveyed region's none) and homes for
        // sale (the city's seven, Lakefront Metro's up to seven, a surveyed region's none) lets the look stage name them.
        city: { fleet: engine.simControls().vehicles.count() > 0, rooms: rooms.length > 0, stores: engine.shops.length > 0, homes: engine.homes.length > 0 },
        place: () => { const s = latest.current.hud ?? h; return s ? nearestPlace(rooms, s.customer.x, s.customer.z) : null },
        ...(t?.assistMs !== undefined && { assistMs: t.assistMs }),
        ...(t?.hintMs !== undefined && { hintMs: t.hintMs }),
        ...(t?.cooldownMs !== undefined && { cooldownMs: t.cooldownMs }),
      })
      w.start(now())
      walk.current = w
      // The first reading anchors the head and the odometer, taken now, before the card is on screen: a turn made
      // before the next snapshot (the card's Walk for me, pressed at once) would otherwise be the anchor itself, and
      // the first stage would wait for a second turn that button never makes.
      if (h) w.read(readingOf(h, engine, latest.current.termOpen), now())
      sync()
    }
    let ctl: AbortController | null = null
    const id = window.setInterval(() => {
      const w = walk.current
      if (!w) return
      const b = w.tick(now())
      sync()
      if (!b) { if (w.passed) window.clearInterval(id); return }
      setBeat(b)
      ctl?.abort()
      const own = new AbortController()
      ctl = own
      void latest.current.voice.say(b.text, own.signal).then((s) => {
        if (own.signal.aborted || s === b.text || !mustKeep(s, b.keep)) return
        setBeat((cur) => (cur && cur.id === b.id ? { ...cur, text: s } : cur))
      })
    }, latest.current.timing?.tickMs ?? TICK_MS)
    return () => {
      window.clearInterval(id)
      ctl?.abort()
    }
  }, [ready, engine, now, sync])

  const note = useCallback((e: WalkEvent) => { walk.current?.note(e, now()); sync() }, [now, sync])
  const line = useCallback((_text: string) => { note('console') }, [note])
  return { card, stage, beat, assisting, passed, note, line }
}
