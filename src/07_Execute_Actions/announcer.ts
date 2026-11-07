// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is what a screen reader is told of the city as it changes (07_Execute_Actions/access.ts
 * `announce`; the HUD's live region reads `customer.announce`): the district walked into, a vehicle beside you and
 * what enters it, a seat taken or left, and every toast (a network event, a robot's line, a recording stopped). The
 * HUD's captions, the microphone pill and Sloane's lines have live regions of their own. One line at a time, at most
 * one every ANNOUNCE.gapMs so a reader is never flooded, the rest held in a short queue; a district is announced only
 * once it has been held ANNOUNCE.districtHoldMs, so a walk along a border does not flap. Pure: a snapshot in, a line
 * or null out, with the clock handed in.
 * What breaks if it is removed? A reader hears the counters and nothing of where they are or what is beside them.
 */
import type { GlyphFamily } from '../05_Observe_Environment/telemetry.ts'

export const ANNOUNCE = {
  /** The least time between two lines. */
  gapMs: 2500,
  /** A district is announced once it has been the district this long. */
  districtHoldMs: 4000,
  /** Lines waiting beyond this many: the oldest go. */
  queue: 4,
} as const

/** The parts of a HUD snapshot (telemetry.ts SipocSnapshot) the announcer reads. */
export interface Announced {
  supplier: { glyphs: GlyphFamily; touch: boolean }
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

export class Announcer {
  private seen = false
  private mode: 'foot' | 'vehicle' = 'foot'
  private near = false
  private district = ''
  private districtSince = 0
  private said = ''
  private lastToast = 0
  private lastAt = Number.NEGATIVE_INFINITY
  private readonly queue: string[] = []

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
      this.lastToast = s.toasts.reduce((m, t) => (t.id > m ? t.id : m), 0)
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
    for (const t of s.toasts) {
      if (t.id > this.lastToast) {
        this.lastToast = t.id
        this.push(t.body ? `${t.title}: ${t.body}` : t.title)
      }
    }
    if (this.queue.length === 0 || now - this.lastAt < ANNOUNCE.gapMs) return null
    this.lastAt = now
    return this.queue.shift()!
  }

  /** Lines waiting. */
  get pending(): number { return this.queue.length }

  private push(line: string): void {
    this.queue.push(line)
    while (this.queue.length > ANNOUNCE.queue) this.queue.shift()
  }
}
