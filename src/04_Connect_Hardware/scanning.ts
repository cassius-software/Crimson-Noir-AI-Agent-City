// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is single-switch scanning (07_Execute_Actions/access.ts `scan`): for a visitor with
 * one switch, the page's controls (buttons, links, fields, anything focusable) are offered one at a time, in the
 * page's order, every SCAN.ms; the one offered is focused and marked (`data-scan`, which index.css rings), and the
 * switch, the Space bar (a switch interface sends one key, and Space is the usual one), presses it, or puts the caret
 * in a field (a control the browser will not focus as it is, a role="button" with no tabindex, is lent tabindex -1
 * for its offer, so the switch's key goes to it and not to the field the focus was on; it is given back once the focus
 * has left it, and never if the page wrote that tabindex itself meanwhile). The press is taken on the way down, before the rest of the page sees the key, so the city's handbrake
 * never fires with it. A field being typed in (taken by the switch, focused by any other hand, or typed into) becomes
 * the one offered (the ring moves to it) and holds the round on it until SCAN.hold offers pass without a key, so the
 * caret is never taken mid-word and the round goes on from the field; while it holds, Space typed there stays a space. Every round reads the controls again, so a card that opens or closes joins or leaves the round. Pure: the page is an environment handed in (`browserScanEnv` is the one
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
  hasAttribute(name: string): boolean
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  addEventListener(type: 'blur', fn: () => void, options?: { once?: boolean }): void
}

/** A watch on a control's tabindex: whether anything has written it since the watch began, and its end. */
export interface ScanWatch { touched(): boolean; stop(): void }

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
  /** Watches the control's tabindex from now (a MutationObserver, its records taken at once): a tabindex the page wrote
   *  after the scan lent one is the page's, even when it is "-1" too (a roving tabindex). Without it, the value alone. */
  watch?(el: ScanTarget): ScanWatch
  /** Subscribes to every focus that lands in the window, the window's own included (a blur does not fire when the focus
   *  moves while the window is in the back); returns the unsubscribe. */
  onFocus?(fn: () => void): () => void
}

const UNWATCHED: ScanWatch = Object.freeze({ touched: () => false, stop() {} })

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
  /** What had the focus when the round last looked (after its own focus move too): only a field the focus moved to
   *  since is taken as typed in, so a control that takes no focus even when lent a tabindex (a button in a disabled
   *  fieldset) never hands the round back to the field before it. */
  private seen: unknown = null
  /** The control offered now that holds a lent tabindex -1 (it is not given back while offered) ... */
  private lent: ScanTarget | null = null
  /** ... and every control holding one not given back yet, with the watch on its tabindex: each is given back once the
   *  focus has left it (looked at on its blur, at every offer, and whenever the focus lands anywhere in the window). */
  private readonly owed = new Map<ScanTarget, ScanWatch>()
  /** The owed controls that had the focus when last looked at, waiting for their blur. */
  private readonly waiting = new Set<ScanTarget>()
  private offFocus: (() => void) | null = null

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
   * is being typed in: one that still has the focus and took a key within SCAN.hold offers holds the round, and so does
   * one that took the focus some other way (a click, a card's own focus, the dwell), from that moment.
   */
  step(): void {
    this.settleAll()
    const active = this.env.active()
    const moved = active !== this.seen
    this.seen = active
    if (moved && active !== this.held && active !== this.now && isEditableTarget(active as EventTarget | null)) { this.typing(active); return }
    if (this.held !== null && active === this.held && this.idle < SCAN.hold) { this.idle++; return }
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

  /** The field is the one offered now (marked, so the ring is where the caret is and the round goes on from it), held. */
  private typing(field: unknown): void {
    this.mark(field as ScanTarget)
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
    const lent = this.lent
    this.lent = null
    if (el) {
      el.setAttribute('data-scan', '')
      el.focus({ preventScroll: false })
      if (this.owed.has(el)) this.lent = el
      // Not focused as it is: lent tabindex -1 for its offer (a field never needs it: fields take the focus).
      else if (this.env.active() !== el && !el.hasAttribute('tabindex')) {
        el.setAttribute('tabindex', '-1')
        this.owed.set(el, this.env.watch?.(el) ?? UNWATCHED)
        this.lent = el
        if (this.offFocus === null && this.env.onFocus) this.offFocus = this.env.onFocus(() => this.settleAll())
        el.focus({ preventScroll: false })
      }
    }
    if (lent && lent !== el) this.settle(lent)
    this.seen = this.env.active()
  }

  /** Looks at every control still holding a lent tabindex. */
  private settleAll(): void {
    for (const el of [...this.owed.keys()]) this.settle(el)
  }

  /**
   * Gives a lent tabindex back once the control is no longer offered and the focus has left it: taking it off the
   * focused control would drop the focus to the page (on stop(), or when the next control offered could not take the
   * focus either), and a window losing the focus is not the focus leaving. A tabindex the page wrote since is the
   * page's, and stays.
   */
  private settle(el: ScanTarget): void {
    const watch = this.owed.get(el)
    if (!watch || el === this.lent) return
    if (watch.touched() || el.getAttribute('tabindex') !== '-1') { this.forget(el); return }
    if (this.env.active() === el) {
      if (!this.waiting.has(el)) {
        this.waiting.add(el)
        el.addEventListener('blur', () => { this.waiting.delete(el); this.settle(el) }, { once: true })
      }
      return
    }
    this.forget(el)
    el.removeAttribute('tabindex')
  }

  private forget(el: ScanTarget): void {
    this.owed.get(el)?.stop()
    this.owed.delete(el)
    this.waiting.delete(el)
    if (this.owed.size === 0 && this.offFocus !== null) { this.offFocus(); this.offFocus = null }
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
    watch(el) {
      const Observer = doc.defaultView?.MutationObserver
      if (!Observer) return UNWATCHED
      let touched = false
      const mo = new Observer(() => { touched = true })
      mo.observe(el as unknown as Node, { attributes: true, attributeFilter: ['tabindex'] })
      return { touched: () => touched || (touched = mo.takeRecords().length > 0), stop: () => mo.disconnect() }
    },
    onFocus(fn) {
      const win = doc.defaultView
      if (!win) return () => {}
      // Focus does not bubble, but the window sees every element's at the capture phase.
      const h = (): void => fn()
      win.addEventListener('focus', h, true)
      return () => win.removeEventListener('focus', h, true)
    },
  }
}
