// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the page's side of Wren's quiet watch (09_Cognition/tutorial.ts Mentor): the React
 * hook that starts the watch when a first visitor has walked in and the city is on screen, feeds the mentor what the
 * page sees (the HUD's snapshot a few times a second: where the visitor stands, where the head points, how far they
 * have walked, whether falling code is on, the clock) and what the visitor does (the walking and look keys, a drag,
 * the M key, the clock keys, a touch), asks it once a second whether there is something to say, and hands the line to
 * the Concierge card as a nudge, in the model's rewording when a backend is configured and answers in time (the
 * onboarding's own Voice), else word for word. It listens only; nothing here writes to the engine or the simulation.
 * What breaks if it is removed? Wren watches nobody: the mentor has no clock, no eyes and no mouth on the page.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SipocSnapshot } from '../../05_Observe_Environment/telemetry.ts'
import type { Engine } from '../engine.ts'
import { isPadFamily, type GlyphFamily } from '../glyphs.ts'
import { Mentor, WATCH, type Event, type InputFamily, type Nudge } from '../../09_Cognition/tutorial.ts'
import { mustKeep, type Voice } from './voice.ts'

/** How often the mentor is asked whether it is time to say something, ms. */
export const TICK_MS = 1000

/** Keys that are walking (not typed into a field). */
const MOVE_KEYS: ReadonlySet<string> = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'])

/** The mentor's word for the HUD's input family. */
export function familyOf(f: GlyphFamily): InputFamily {
  return f === 'touch' ? 'touch' : isPadFamily(f) ? 'pad' : 'keyboard'
}

/** The hours on the HUD's clock ('17:02'), or NaN. */
export function hoursOf(clock: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(clock)
  return m ? Number(m[1]) + Number(m[2]) / 60 : Number.NaN
}

function isEditable(t: EventTarget | null): boolean {
  if (!t || typeof t !== 'object') return false
  const el = t as { isContentEditable?: boolean; tagName?: unknown }
  if (el.isContentEditable) return true
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export interface MentorProps {
  /** Whether Wren watches at all: a first visitor who walked in from the onboarding, with the city on screen. */
  active: boolean
  engine: Engine | null
  hud: SipocSnapshot | null
  family: GlyphFamily
  /** The visitor's name, or ''. */
  name: string
  /** Who says the lines: the script, or the configured model over it (onboarding/voice.ts). */
  voice: Voice
  /** The clock the watch runs on (performance.now by default; tests inject one). */
  now?: () => number
  /** Tests shorten the watch. */
  timing?: { quietMs?: number; cooldownMs?: number; watchMs?: number; tickMs?: number }
}

/**
 * Wren's watch as React state: `nudge` is the line to show (null when none; a new one has a new id), `note` is for
 * the host to report what readings cannot show (a prompt sent to someone, a goal told to Wren).
 */
export function useMentor({ active, engine, hud, family, name, voice, now = () => performance.now(), timing }: MentorProps): { nudge: Nudge | null; note(e: Event): void } {
  const mentor = useRef<Mentor | null>(null)
  const [nudge, setNudge] = useState<Nudge | null>(null)
  // The newest of what the watch reads when it starts and while it runs, without restarting its listeners.
  const latest = useRef({ hud, family, name, voice, timing })
  useEffect(() => { latest.current = { hud, family, name, voice, timing } }, [hud, family, name, voice, timing])

  // Every snapshot is a reading (once the watch has started).
  useEffect(() => {
    const m = mentor.current
    if (!m || !hud) return
    m.read({
      x: hud.customer.x, z: hud.customer.z, yaw: hud.customer.viewYaw,
      travelled: hud.experience.distanceWalked + hud.experience.distanceDriven,
      mode: hud.output.matrix === true, hour: hoursOf(hud.customer.clock),
    }, now())
  }, [hud, now])

  // The watch: started once the city is on screen (a snapshot exists) for an active visitor, then the listeners for
  // what the visitor does with the keys, the mouse and a finger (the quiet timer restarts; some of it is a discovery),
  // and once a second the question whether it is a moment to say something. The script shows at once; the model's
  // rewording replaces it if it comes in time and keeps the words the line needs (a key, a name).
  const ready = active && engine !== null && hud !== null
  useEffect(() => {
    if (!ready || !engine) return
    if (!mentor.current) {
      const { hud: h, family: f, name: n, timing: t } = latest.current
      const l = engine.landmark()
      const m = new Mentor({
        landmark: l ? { name: l.name, x: l.x, z: l.z } : null,
        people: (h?.process.pedestrians ?? 0) > 0,
        family: familyOf(f),
        name: n,
        ...(t?.quietMs !== undefined && { quietMs: t.quietMs }),
        ...(t?.cooldownMs !== undefined && { cooldownMs: t.cooldownMs }),
        ...(t?.watchMs !== undefined && { watchMs: t.watchMs }),
      })
      m.start(now())
      mentor.current = m
    }
    const note = (e: Event) => mentor.current?.note(e, now())
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || isEditable(e.target)) return
      if (MOVE_KEYS.has(e.code)) note('move')
      else if (e.code === 'KeyM') note('mode')
      else if (e.code === 'BracketLeft' || e.code === 'BracketRight') note('clock')
      else note('input')
    }
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' ? e.buttons !== 0 || document.pointerLockElement !== null : e.pointerType === 'touch') note('look')
    }
    const onDown = () => note('input')
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerdown', onDown, true)
    let ctl: AbortController | null = null
    const id = window.setInterval(() => {
      const m = mentor.current
      if (!m) return
      const n = m.tick(now())
      if (!n) { if (m.over) window.clearInterval(id); return }
      setNudge(n)
      ctl?.abort()
      const own = new AbortController()
      ctl = own
      void latest.current.voice.say(n.text, own.signal).then((s) => {
        if (own.signal.aborted || s === n.text || !mustKeep(s, n.keep)) return
        setNudge((cur) => (cur && cur.id === n.id ? { ...cur, text: s } : cur))
      })
    }, latest.current.timing?.tickMs ?? TICK_MS)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerdown', onDown, true)
      window.clearInterval(id)
      ctl?.abort()
    }
  }, [ready, engine, now])

  const note = useCallback((e: Event) => { mentor.current?.note(e, now()) }, [now])
  return { nudge, note }
}

export { WATCH }
