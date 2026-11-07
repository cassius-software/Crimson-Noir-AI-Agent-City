// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the dwell click (07_Execute_Actions/access.ts `dwell`): a pointer that rests on a
 * control for DWELL.ms presses it, for a visitor who can steer a pointer (a head mouse, an eye tracker, a trackball)
 * but not press a button. The control under the pointer is found as it moves (the nearest button, link, field or
 * role under it); resting there arms it (`data-dwell="arming"`, which index.css draws as a ring filling over the
 * time), a move of more than DWELL.slopPx starts the time again where the pointer is now, and the time running out
 * presses it (`click()`; a text field is focused instead) and marks it done until the pointer leaves it, so one rest
 * is one press. A touch never dwells (a finger that rests is a hold), a real press cancels and latches the arm, and
 * nothing dwells under pointer lock (the pointer is the head, and there is no control under it). Pure: the page is
 * an environment handed in (`browserDwellEnv` is the one over `document`), so a Node test drives it with fakes.
 * What breaks if it is removed? A visitor without a button has no way to press one.
 */

export const DWELL = {
  /** Resting this long presses the control. */
  ms: 600,
  /** A move of more than this many CSS pixels while armed starts the time again. */
  slopPx: 8,
  /** What a rest presses: the nearest of these under the pointer. */
  selector: 'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="option"]',
  /** Of those, the ones a rest focuses instead of pressing (a press would do nothing a caret cannot). */
  typed: 'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="range"]), textarea, select',
} as const

/** The pointer event's parts the dwell reads. */
export interface DwellPointer { clientX: number; clientY: number; pointerType: string }

/** The element's parts the dwell touches (an Element in the page; a fake in a test). */
export interface DwellTarget {
  click(): void
  focus(): void
  matches(selector: string): boolean
  closest(selector: string): DwellTarget | null
  hasAttribute(name: string): boolean
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

/** The page, as the dwell sees it. */
export interface DwellEnv {
  /** Subscribes to the document's pointer events; returns the unsubscribe. */
  on(type: 'pointermove' | 'pointerdown' | 'pointerleave', fn: (e: DwellPointer) => void): () => void
  /** The element at a point of the viewport (document.elementFromPoint), or null. */
  at(x: number, y: number): DwellTarget | null
  /** Whether the pointer is locked to the city (then it is the head, and nothing is under it). */
  locked(): boolean
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

export class DwellClicker {
  private readonly env: DwellEnv
  private readonly ms: number
  private off: (() => void)[] = []
  private timer: unknown = null
  private current: DwellTarget | null = null
  /** Where the pointer was when the current control was armed (the slop is measured from here). */
  private ax = 0
  private ay = 0
  /** The current control has been pressed (or really pressed): no second press until the pointer leaves it. */
  private done = false

  constructor(env: DwellEnv, ms: number = DWELL.ms) {
    this.env = env
    this.ms = ms
  }

  /** The control armed or pressed now, for a test or a readout. */
  get target(): DwellTarget | null { return this.current }
  /** Whether a press is counting down. */
  get arming(): boolean { return this.timer !== null }

  start(): void {
    if (this.off.length) return
    this.off = [
      this.env.on('pointermove', (e) => this.move(e)),
      this.env.on('pointerdown', (e) => this.pressed(e)),
      this.env.on('pointerleave', () => this.leave()),
    ]
  }

  /** Unsubscribes and clears any arm: the control under the pointer is left as it was. */
  stop(): void {
    for (const f of this.off) f()
    this.off = []
    this.leave()
  }

  private move(e: DwellPointer): void {
    if (e.pointerType === 'touch') return
    if (this.env.locked()) { this.leave(); return }
    const under = this.env.at(e.clientX, e.clientY)
    let el = under ? under.closest(DWELL.selector) : null
    if (el && (el.hasAttribute('disabled') || el.closest('[aria-hidden="true"]') !== null || el.closest('[inert]') !== null)) el = null
    if (el !== this.current) {
      this.leave()
      if (!el) return
      this.current = el
      this.arm(e)
      return
    }
    if (!el || this.done) return
    const dx = e.clientX - this.ax, dy = e.clientY - this.ay
    if (dx * dx + dy * dy > DWELL.slopPx * DWELL.slopPx) this.arm(e)
  }

  /** Starts (or restarts) the time on the current control from where the pointer is. */
  private arm(e: DwellPointer): void {
    const el = this.current!
    this.ax = e.clientX
    this.ay = e.clientY
    if (this.timer !== null) this.env.clearTimeout(this.timer)
    el.setAttribute('data-dwell', 'arming')
    this.timer = this.env.setTimeout(() => this.fire(), this.ms)
  }

  private fire(): void {
    this.timer = null
    const el = this.current
    if (!el) return
    this.done = true
    el.setAttribute('data-dwell', 'done')
    if (el.matches(DWELL.typed)) el.focus()
    else el.click()
  }

  /** A real press (a button, a switch wired as one) is the press: the arm is dropped and the control is done. */
  private pressed(e: DwellPointer): void {
    if (e.pointerType === 'touch' || !this.current) return
    if (this.timer !== null) { this.env.clearTimeout(this.timer); this.timer = null }
    this.done = true
    this.current.setAttribute('data-dwell', 'done')
  }

  private leave(): void {
    if (this.timer !== null) { this.env.clearTimeout(this.timer); this.timer = null }
    if (this.current) this.current.removeAttribute('data-dwell')
    this.current = null
    this.done = false
  }
}

/** The dwell's environment over the page's document. */
export function browserDwellEnv(doc: Document = document): DwellEnv {
  return {
    on(type, fn) {
      const h = fn as unknown as EventListener
      doc.addEventListener(type, h)
      return () => doc.removeEventListener(type, h)
    },
    at: (x, y) => doc.elementFromPoint(x, y) as unknown as DwellTarget | null,
    locked: () => doc.pointerLockElement !== null,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  }
}
