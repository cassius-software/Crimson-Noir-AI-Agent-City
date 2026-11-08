// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is single-switch scanning (07_Execute_Actions/access.ts `scan`): for a visitor with
 * one switch, the page's controls (buttons, links, fields, anything focusable) are offered one at a time, in the
 * page's order, every SCAN.ms; the one offered is focused and marked (`data-scan`, which index.css rings), and the
 * switch, the Space bar (a switch interface sends one key, and Space is the usual one), presses it, or puts the caret
 * in a field. The press is taken on the way down, before the rest of the page sees the key, so the city's handbrake
 * never fires with it. A field being typed in (taken by the switch, or by any other hand) holds the round on it until
 * SCAN.hold offers pass without a key, so the caret is never taken mid-word, and while it holds Space typed there stays
 * a space. Every round reads the controls again, so a card that opens or closes joins or leaves the round. Pure: the page is an environment handed in (`browserScanEnv` is the one
 * over `document`), so a Node test drives it with fakes.
 * What breaks if it is removed? A visitor with one switch can reach nothing.
 */
import { isEditableTarget } from './input.ts'

export const SCAN = {
  /** Each control is offered this long. */
  ms: 1200,
  /** A field being typed in holds the round this many offers after its last key (6 s at SCAN.ms). */
  hold: 5,
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
  /** The element that has the focus now (document.activeElement). */
  active(): unknown
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
  /** The field being typed in, which holds the round, and the offers since its last key. */
  private held: unknown = null
  private idle = 0

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
    this.held = null
    this.mark(null)
  }

  /**
   * Offers the next control in page order (the first after the last, or when the one offered has gone), unless a field
   * is being typed in: one that still has the focus and took a key within SCAN.hold offers holds the round.
   */
  step(): void {
    if (this.held !== null && this.env.active() === this.held && this.idle < SCAN.hold) { this.idle++; return }
    this.held = null
    const all = this.env.candidates()
    if (all.length === 0) { this.mark(null); return }
    const i = this.now ? all.indexOf(this.now) : -1
    this.mark(all[(i + 1) % all.length])
  }

  /** Presses the control offered (a field takes the caret instead, and holds the round). Returns whether there was one. */
  select(): boolean {
    const el = this.now
    if (!el) return false
    if (el.matches(TYPED)) { el.focus(); this.typing(el) }
    else el.click()
    return true
  }

  private typing(field: unknown): void {
    this.held = field
    this.idle = 0
  }

  private onKey(e: ScanKey): void {
    // A key typed in a field is the field's: one the round did not offer, one already taken, or any key but the switch
    // in the one offered. It holds the round there. The switch on a field merely offered takes it (select).
    if (isEditableTarget(e.target) && (e.target !== this.now || e.target === this.held || e.code !== this.key)) { this.typing(e.target); return }
    if (e.code !== this.key) return
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
    active: () => doc.activeElement,
    onKey(fn) {
      const h = fn as unknown as EventListener
      doc.addEventListener('keydown', h, { capture: true })
      return () => doc.removeEventListener('keydown', h, { capture: true })
    },
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
  }
}
