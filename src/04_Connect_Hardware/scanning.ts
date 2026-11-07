// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is single-switch scanning (07_Execute_Actions/access.ts `scan`): for a visitor with
 * one switch, the page's controls (buttons, links, fields, anything focusable) are offered one at a time, in the
 * page's order, every SCAN.ms; the one offered is focused and marked (`data-scan`, which index.css rings), and the
 * switch, the Space bar (a switch interface sends one key, and Space is the usual one), presses it, or puts the caret
 * in a field. The press is taken on the way down, before the rest of the page sees the key, so the city's handbrake
 * never fires with it; Space typed into a field stays a space. Every round reads the controls again, so a card that
 * opens or closes joins or leaves the round. Pure: the page is an environment handed in (`browserScanEnv` is the one
 * over `document`), so a Node test drives it with fakes.
 * What breaks if it is removed? A visitor with one switch can reach nothing.
 */
import { isEditableTarget } from './input.ts'

export const SCAN = {
  /** Each control is offered this long. */
  ms: 1200,
  /** The switch. */
  key: 'Space',
  /** What is offered, in page order; the environment keeps only the ones that are shown. */
  selector: 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [role="button"]:not([aria-disabled="true"]), [tabindex]:not([tabindex="-1"])',
} as const

/** The element's parts the scan touches (an Element in the page; a fake in a test). */
export interface ScanTarget {
  click(): void
  focus(options?: { preventScroll?: boolean }): void
  matches(selector: string): boolean
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

/** The key event's parts the scan reads. */
export interface ScanKey { code: string; repeat: boolean; target: EventTarget | null; preventDefault(): void; stopImmediatePropagation(): void }

/** The page, as the scan sees it. */
export interface ScanEnv {
  /** The controls shown now, in page order. */
  candidates(): ScanTarget[]
  /** Subscribes to the document's keydown, ahead of every other listener; returns the unsubscribe. */
  onKey(fn: (e: ScanKey) => void): () => void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(id: unknown): void
}

/** The fields a press focuses instead of pressing (dwell.ts has the same list). */
const TYPED = 'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="range"]), textarea, select'

export class Scanner {
  private readonly env: ScanEnv
  private readonly ms: number
  private readonly key: string
  private timer: unknown = null
  private offKey: (() => void) | null = null
  private now: ScanTarget | null = null

  constructor(env: ScanEnv, ms: number = SCAN.ms, key: string = SCAN.key) {
    this.env = env
    this.ms = ms
    this.key = key
  }

  /** The control offered now. */
  get current(): ScanTarget | null { return this.now }
  get running(): boolean { return this.timer !== null }

  /** Offers the first control at once, then the next every SCAN.ms; the switch presses the one offered. */
  start(): void {
    if (this.timer !== null) return
    this.offKey = this.env.onKey((e) => this.onKey(e))
    this.step()
    this.timer = this.env.setInterval(() => this.step(), this.ms)
  }

  /** Stops the round and clears the mark; focus stays where it is. */
  stop(): void {
    if (this.timer !== null) { this.env.clearInterval(this.timer); this.timer = null }
    this.offKey?.()
    this.offKey = null
    this.mark(null)
  }

  /** Offers the next control in page order (the first after the last, or when the one offered has gone). */
  step(): void {
    const all = this.env.candidates()
    if (all.length === 0) { this.mark(null); return }
    const i = this.now ? all.indexOf(this.now) : -1
    this.mark(all[(i + 1) % all.length])
  }

  /** Presses the control offered (a field takes the caret instead). Returns whether there was one. */
  select(): boolean {
    const el = this.now
    if (!el) return false
    if (el.matches(TYPED)) el.focus()
    else el.click()
    return true
  }

  private onKey(e: ScanKey): void {
    if (e.code !== this.key || isEditableTarget(e.target)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (!e.repeat) this.select()
  }

  private mark(el: ScanTarget | null): void {
    if (this.now === el) return
    this.now?.removeAttribute('data-scan')
    this.now = el
    if (el) {
      el.setAttribute('data-scan', '')
      el.focus({ preventScroll: false })
    }
  }
}

/** The scan's environment over the page's document: the controls shown (with a box, not under aria-hidden or inert). */
export function browserScanEnv(doc: Document = document): ScanEnv {
  return {
    candidates: () => [...doc.querySelectorAll<HTMLElement>(SCAN.selector)].filter((el) =>
      el.getClientRects().length > 0 && el.closest('[aria-hidden="true"]') === null && el.closest('[inert]') === null,
    ) as unknown as ScanTarget[],
    onKey(fn) {
      const h = fn as unknown as EventListener
      doc.addEventListener('keydown', h, { capture: true })
      return () => doc.removeEventListener('keydown', h, { capture: true })
    },
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
  }
}
