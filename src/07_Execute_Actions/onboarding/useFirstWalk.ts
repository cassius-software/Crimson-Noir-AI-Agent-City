// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the page's side of the first walk (09_Cognition/firstWalk.ts): the React hook that
 * starts the seven stages once the city is on screen, feeds the walk what the page sees (the HUD's snapshot a few times
 * a second: where the visitor stands, where the head points, how far they have come, whether they are at a wheel,
 * inside one of the workplaces, or at the console) and what the page reports outright (a goal sent to Sloane, a
 * console line run, the wardrobe or a shop's card put away, the exit program's doors), asks it once a second whether there is something to say, and hands
 * the line to the card and the voice, in the model's rewording when one answers in time and keeps the words the
 * line needs. When the walk is passed it writes the one record that keeps the city open on the next visit. It
 * listens only; nothing here writes to the engine or the simulation (the card's accessible path is the host's).
 * What breaks if it is removed? The walk has no clock, no eyes and no mouth on the page, and no pass is ever kept.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { insideRoom } from '../../01_Initialize_World/interiors.ts'
import type { SipocSnapshot } from '../../05_Observe_Environment/telemetry.ts'
import type { Engine } from '../engine.ts'
import { glyph, type GlyphFamily } from '../glyphs.ts'
import { FirstWalk, lawLine, type Beat, type ControlWords, type Stage, type StageCard, type WalkEvent, type WalkPlace } from '../../09_Cognition/firstWalk.ts'
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
  timing?: { hintMs?: number; cooldownMs?: number; tickMs?: number }
}

/** The walk as React state: the card to show, Sloane's newest line, the exit's doors, whether it is passed, and the reports the host makes. */
export interface FirstWalkState {
  /** The card for the stage the visitor is on; null before the walk starts and once it is passed. */
  card: StageCard | null
  stage: Stage | null
  /** Sloane's newest line (null when none yet; a new one has a new id). */
  beat: Beat | null
  exam: { seal: boolean; swarm: boolean }
  passed: boolean
  /** The host reports what readings cannot show (a goal sent, a door of the exit). */
  note(e: WalkEvent): void
  /** The host reports a console line run; a law line finishes the Ring-0 stage. */
  line(text: string): void
}

const NO_EXAM = Object.freeze({ seal: false, swarm: false })

export function useFirstWalk({ active, engine, hud, family, name, voice, termOpen, now = () => performance.now(), wallClock = () => Date.now(), timing }: FirstWalkProps): FirstWalkState {
  const walk = useRef<FirstWalk | null>(null)
  const [beat, setBeat] = useState<Beat | null>(null)
  const [stage, setStage] = useState<Stage | null>(null)
  const [card, setCard] = useState<StageCard | null>(null)
  const [exam, setExam] = useState<{ seal: boolean; swarm: boolean }>(NO_EXAM)
  const [passed, setPassed] = useState(false)
  /** The pass written once, whatever renders follow. */
  const kept = useRef(false)
  const latest = useRef({ hud, family, name, voice, timing, termOpen, wallClock })
  useEffect(() => { latest.current = { hud, family, name, voice, timing, termOpen, wallClock } }, [hud, family, name, voice, timing, termOpen, wallClock])

  /** The React state follows the walk (its stage, the exit's doors, the pass), without a render per reading. */
  const sync = useCallback(() => {
    const w = walk.current
    if (!w) return
    const next = w.passed ? null : w.stage
    setStage((s) => (s === next ? s : next))
    setCard((c) => ((c?.stage ?? null) === next ? c : next === null ? null : w.card))
    setExam((e) => (e.seal === w.exam.seal && e.swarm === w.exam.swarm ? e : w.exam))
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
    const x = hud.customer.x, z = hud.customer.z
    w.read({
      x, z, yaw: hud.customer.viewYaw,
      travelled: hud.experience.distanceWalked + hud.experience.distanceDriven,
      driving: hud.input.mode === 'vehicle',
      inside: engine.workplaces().some((r) => insideRoom(r, x, z)),
      consoleOpen: termOpen,
    }, now())
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
        // Whether the map has shops (the city's five, Lakefront Metro's up to five, a surveyed region's none) lets the look stage name them.
        city: { fleet: engine.simControls().vehicles.count() > 0, rooms: rooms.length > 0, stores: engine.shops.length > 0 },
        place: () => { const s = latest.current.hud ?? h; return s ? nearestPlace(rooms, s.customer.x, s.customer.z) : null },
        ...(t?.hintMs !== undefined && { hintMs: t.hintMs }),
        ...(t?.cooldownMs !== undefined && { cooldownMs: t.cooldownMs }),
      })
      w.start(now())
      walk.current = w
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
  const line = useCallback((text: string) => { if (lawLine(text)) note('law'); else note('console') }, [note])
  return { card, stage, beat, exam, passed, note, line }
}
