// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is what a screen reader is told of the city as it changes (07_Execute_Actions/access.ts
 * `announce`; the HUD's live region reads `customer.announce`): the district walked into, a vehicle beside you and
 * what enters it, a seat taken or left, someone close enough to talk to and how to start, and every toast (a network
 * event, a robot's line, a recording stopped, a conversation that ended). The HUD's captions, the microphone pill,
 * Sloane's lines and the conversation's own panel have live regions of their own. One line at a time, at most one
 * every ANNOUNCE.gapMs so a reader is never flooded, the rest held in a short queue; a district is announced only once
 * it has been held ANNOUNCE.districtHoldMs, so a walk along a border does not flap. Someone offered to talk to
 * (telemetry.ts HudTalk, state 'near') is announced only once the same proposal has stood ANNOUNCE.talkHoldMs, at most
 * one such line every ANNOUNCE.talkGapMs, and never while a conversation is open: a line still waiting when the
 * proposal goes or the conversation opens is not said. Pure: a snapshot in, a line or null out, with the clock handed
 * in (and the pad hand, read from the page unless a reader of it is handed in).
 * What breaks if it is removed? A reader hears the counters and nothing of where they are or what is beside them.
 */
import type { PadHand } from '../04_Connect_Hardware/gamepad.ts'
import type { GlyphFamily, HudTalk } from '../05_Observe_Environment/telemetry.ts'
import { glyph, isPadFamily } from './glyphs.ts'
import { pageHand } from './padNav.ts'

export const ANNOUNCE = {
  /** The least time between two lines. */
  gapMs: 2500,
  /** A district is announced once it has been the district this long. */
  districtHoldMs: 4000,
  /** Lines waiting beyond this many: the oldest go. */
  queue: 4,
  /** Someone offered to talk to is announced once the same proposal has stood this long, so a passer-by is not news. */
  talkHoldMs: 1500,
  /** The least time between two lines about someone to talk to (from when the last was said). */
  talkGapMs: 15000,
} as const

/** The parts of a HUD snapshot (telemetry.ts SipocSnapshot) the announcer reads. */
export interface Announced {
  supplier: { glyphs: GlyphFamily; touch: boolean; talk?: Pick<HudTalk, 'state' | 'label' | 'serial'> }
  input: { mode: 'foot' | 'vehicle'; nearVehicle: boolean }
  customer: { district: string }
  toasts: readonly { id: number; title: string; body: string }[]
}

/** What enters a vehicle, said for the controls in use. */
export function enterWord(family: GlyphFamily, touch: boolean): string {
  if (touch || family === 'touch') return 'the Enter car button enters it'
  if (family === 'keyboard') return 'E enters it'
  return 'the bottom face button enters it'
}

/**
 * How to start talking to the person offered, said for the controls in use: the key, the pad's button (glyphs.ts
 * names it: a letter on a lettered pad, else its position; with the left hand alone, the d-pad's up), or on touch the
 * HUD's Talk chip, which stands at the foot of the screen there.
 */
export function talkWord(family: GlyphFamily, touch: boolean, hand: PadHand = 'both'): string {
  const g = touch ? '' : glyph('talk', family, hand)
  if (!g) return 'tap Talk at the foot of the screen'
  if (hand === 'left' && isPadFamily(family)) return 'press up on the d-pad'
  if (family === 'keyboard' || g.length === 1) return `press ${g}`
  return `press the ${g} button`
}

export class Announcer {
  /** The pad hand the accessibility settings chose (padNav.ts pageHand by default), read as a line is made. */
  readonly #hand: () => PadHand
  private seen = false
  private mode: 'foot' | 'vehicle' = 'foot'
  private near = false
  private district = ''
  private districtSince = 0
  private said = ''
  /** The newest toast id told (ids start at 0, so none yet is −1). */
  private lastToast = -1
  private lastAt = Number.NEGATIVE_INFINITY
  private readonly queue: string[] = []
  /** The proposal seen offered now (its serial, −1 for none) and since when; the proposal last announced. */
  private talkSerial = -1
  private talkSince = 0
  private talkTold = -1
  /** The line about it while it waits in the queue (null once said, dropped or let go), and when the last was said. */
  private talkLine: string | null = null
  private talkSaidAt = Number.NEGATIVE_INFINITY

  constructor(hand: () => PadHand = pageHand) {
    this.#hand = hand
  }

  /** The line to tell now, or null; `now` in ms. */
  next(s: Announced, now: number): string | null {
    if (!this.seen) {
      // The first look sets the baseline: nothing is announced of a city that was already so.
      this.seen = true
      this.mode = s.input.mode
      this.near = s.input.nearVehicle
      this.district = s.customer.district
      this.districtSince = now
      this.said = s.customer.district
      this.lastToast = s.toasts.reduce((m, t) => (t.id > m ? t.id : m), -1)
      this.talkSerial = s.supplier.talk?.state === 'near' ? s.supplier.talk.serial : -1
      this.talkSince = now
      this.talkTold = this.talkSerial
      return null
    }
    if (s.input.mode !== this.mode) {
      this.mode = s.input.mode
      this.push(this.mode === 'vehicle' ? 'Driving.' : 'On foot.')
    }
    if (s.input.nearVehicle !== this.near) {
      this.near = s.input.nearVehicle
      if (this.near && this.mode === 'foot') this.push(`A vehicle is beside you: ${enterWord(s.supplier.glyphs, s.supplier.touch)}.`)
    }
    if (s.customer.district !== this.district) {
      this.district = s.customer.district
      this.districtSince = now
    } else if (this.district && this.district !== this.said && now - this.districtSince >= ANNOUNCE.districtHoldMs) {
      this.said = this.district
      this.push(`Now in ${this.district}.`)
    }
    this.talk(s, now)
    // Every toast newer than the last told, oldest first, whatever order the HUD lists them in (newest first).
    const fresh = s.toasts.filter((t) => t.id > this.lastToast).sort((a, b) => a.id - b.id)
    for (const t of fresh) {
      this.lastToast = t.id
      this.push(t.body ? `${t.title}: ${t.body}` : t.title)
    }
    if (this.queue.length === 0 || now - this.lastAt < ANNOUNCE.gapMs) return null
    this.lastAt = now
    const line = this.queue.shift()!
    if (line === this.talkLine) {
      this.talkLine = null
      this.talkSaidAt = now
    }
    return line
  }

  /** Lines waiting. */
  get pending(): number { return this.queue.length }

  /**
   * Someone offered to talk to: a line once the same proposal has stood talkHoldMs, unless one was said within
   * talkGapMs; a line still waiting is taken back when its proposal is no longer offered (gone, replaced, or the
   * conversation opened). A snapshot without `talk` is nobody offered.
   */
  private talk(s: Announced, now: number): void {
    const t = s.supplier.talk
    const near = t !== undefined && t.state === 'near' ? t : null
    if (this.talkLine !== null && near?.serial !== this.talkTold) {
      const i = this.queue.lastIndexOf(this.talkLine)
      if (i >= 0) this.queue.splice(i, 1)
      this.talkLine = null
    }
    if (near === null) {
      this.talkSerial = -1
      return
    }
    if (near.serial !== this.talkSerial) {
      this.talkSerial = near.serial
      this.talkSince = now
      return
    }
    if (near.serial === this.talkTold || now - this.talkSince < ANNOUNCE.talkHoldMs || now - this.talkSaidAt < ANNOUNCE.talkGapMs) return
    this.talkTold = near.serial
    this.talkLine = `${near.label} is close enough to talk to: ${talkWord(s.supplier.glyphs, s.supplier.touch, this.#hand())}.`
    this.push(this.talkLine)
  }

  private push(line: string): void {
    this.queue.push(line)
    while (this.queue.length > ANNOUNCE.queue) {
      if (this.queue.shift() === this.talkLine) this.talkLine = null
    }
  }
}
