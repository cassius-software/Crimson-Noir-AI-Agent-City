// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It draws the on-screen keys and wires them to the page: a keyboard along the bottom of
 * the screen for a player with no keyboard to hand (a pad, a headset's controllers, a phone at the console's prompt,
 * a single switch, a resting pointer), mounted once beside the app (main.tsx), so the city, the onboarding and the
 * console alone all have it. What it decides is keysDesk.ts's; here are its eyes and hands: the page's focus and
 * presses go in, the board comes out as real buttons (a screen reader and a switch reach every key), a press on a key
 * keeps the caret in the field (the key never takes the focus), a key commits when the finger lifts on it (a finger
 * slid off cancels), Backspace and the arrows act at once and repeat while held, the pad types while the keys stand
 * open (keysPad.ts), and when they are only offered a small chip says how to open them. The keys publish their height
 * (`--keys-height`, `data-keys-open` on <html>) so the cards and the console stand clear of them (index.css), and what
 * they are doing (keysHost.ts keysView) so Sloane's card does not fold while its line is typed. Every key is drawn
 * with plain shapes and words: no font has to hold an icon, and no vendor's mark is drawn.
 * What breaks if it is removed? A player holding a pad, or a phone at the prompt, has no way to type.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type JSX, type MouseEvent, type PointerEvent } from 'react'
import { BOARD_COLUMNS, type KeyIcon, type PlacedKey } from './keyLayout.ts'
import { browserEntryEnv, isLiveField, isTextField, type FieldLike } from './textEntry.ts'
import { KeyboardSense, KEYS_ROOT, KEYS_SETTINGS, type KeysSetting } from './keyboardSense.ts'
import { DESK_HANDS, KeysDesk, type DeskEnv, type DeskHands, type DeskView } from './keysDesk.ts'
import { KeysPad, keysLegend } from './keysPad.ts'
import { keysBlocked, keysHost, keysView, onExpectKeys, onSummonKeys, type KeysHost, type KeysView } from './keysHost.ts'
import { padFamilyOf, PAD } from './gamepad.ts'
import { SCAN } from './scanning.ts'
import { borrowPads, pageHand, playerPads } from '../07_Execute_Actions/padNav.ts'
import { padButtonName, type PadFamily } from '../07_Execute_Actions/glyphs.ts'

/** A click with no press of a pointer this close before it came from a screen reader, a switch or the dwell, ms. */
const ASSIST_CLICK_MS = 600
const HIDDEN_VIEW: KeysView = Object.freeze({ mode: 'hidden', field: null })
const ALL_FIELDS = 'input, textarea'

/** What the keys read off <html>: access.ts applyAccess writes the setting (data-keys) and the hands it serves (data-assist). */
function pageHands(touchFirst: boolean): DeskHands {
  const root = document.documentElement
  const raw = root.dataset.keys
  const setting: KeysSetting = (KEYS_SETTINGS as readonly string[]).includes(raw ?? '') ? (raw as KeysSetting) : 'auto'
  const assist = (root.dataset.assist ?? '').split(/\s+/)
  return { ...DESK_HANDS, setting, scan: assist.includes('scan'), dwell: assist.includes('dwell'), system: touchFirst }
}

/** Scrolls the field's nearest scrolling box so the field ends above `top` (the keys' top edge), when it does not. */
function clearOfKeys(field: unknown, top: number): void {
  const el = field as HTMLElement | null
  if (!el || typeof el.getBoundingClientRect !== 'function') return
  const over = el.getBoundingClientRect().bottom - top + 8
  if (over <= 0) return
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY
    if ((y === 'auto' || y === 'scroll') && p.scrollHeight > p.clientHeight) { p.scrollTop += over; return }
  }
}

/** The page side of the desk: the document's focus and fields, its clipboard and its live region. */
function pageDeskEnv(say: (text: string) => void, lend: (on: boolean) => void): DeskEnv {
  /** The attributes the keys set on a field they serve, and what the field had before. */
  const kept = new WeakMap<object, { mode: string | null; policy: string | null }>()
  const scopeOf = (f: FieldLike): Element | null => (f as unknown as Element).closest?.('[role="dialog"], [role="alertdialog"], form, .ui-zoom, main') ?? null
  const fieldsIn = (root: ParentNode): FieldLike[] =>
    [...root.querySelectorAll(ALL_FIELDS)].filter((el) => isLiveField(el) && el.closest(`[${KEYS_ROOT}]`) === null) as unknown as FieldLike[]
  return {
    entry: browserEntryEnv(),
    now: () => performance.now(),
    timer: (fn, ms) => { const id = window.setTimeout(fn, ms); return () => window.clearTimeout(id) },
    active: () => document.activeElement,
    scopeOf,
    nextField: (field, back) => {
      const all = fieldsIn(scopeOf(field) ?? document)
      const i = all.indexOf(field)
      return i < 0 ? null : all[i + (back ? -1 : 1)] ?? null
    },
    firstField: () => fieldsIn(document)[0] ?? null,
    focus: (field) => { (field as unknown as HTMLElement).focus({ preventScroll: true }) },
    hovered: (field) => { try { return (field as unknown as Element).matches(':hover') } catch { return false } },
    around: (field, target) => {
      const box = (field as unknown as Element).closest?.('[role="dialog"], [role="alertdialog"], form')
      return !!box && target instanceof Node && box.contains(target)
    },
    mark: (field, on) => {
      const el = field as unknown as HTMLElement
      if (on) {
        if (!kept.has(el)) kept.set(el, { mode: el.getAttribute('inputmode'), policy: el.getAttribute('virtualkeyboardpolicy') })
        el.setAttribute('inputmode', 'none')
        el.setAttribute('virtualkeyboardpolicy', 'manual')
        // Where the browser offers it, the device's keyboard is told to go down for the field that has the caret.
        if (document.activeElement === el) { try { (navigator as Navigator & { virtualKeyboard?: { hide(): void } }).virtualKeyboard?.hide() } catch { /* not offered */ } }
        return
      }
      const was = kept.get(el)
      if (!was) return
      kept.delete(el)
      if (was.mode === null) el.removeAttribute('inputmode')
      else el.setAttribute('inputmode', was.mode)
      if (was.policy === null) el.removeAttribute('virtualkeyboardpolicy')
      else el.setAttribute('virtualkeyboardpolicy', was.policy)
    },
    showSystem: (field) => {
      // Its marks are already off: a focus made inside the press raises the device's own keyboard.
      const el = field as unknown as HTMLElement
      el.blur()
      el.focus({ preventScroll: true })
    },
    lend,
    openConsole: () => {
      const host = keysHost.get()
      if (!host) return false
      host.openConsole()
      return true
    },
    readClip: () => { try { return navigator.clipboard?.readText?.() ?? null } catch { return null } },
    writeClip: (text) => { try { return navigator.clipboard?.writeText?.(text) ?? null } catch { return null } },
    say,
  }
}

/** The keys, mounted once beside the app. */
export function ScreenKeys(): JSX.Element {
  const [desk, setDesk] = useState<KeysDesk | null>(null)
  const liveRef = useRef<HTMLDivElement>(null)
  const [family, setFamily] = useState<PadFamily>('generic')

  useEffect(() => {
    const say = (text: string): void => {
      const el = liveRef.current
      if (el) el.textContent = text
    }
    // The pads, lent while the keys stand open: player 1's from the running city, and every screen's reader of them.
    let lentTo: KeysHost | null = null
    let giveBack: (() => void) | null = null
    let lentOn = false
    const lend = (on: boolean): void => {
      lentOn = on
      if (on) {
        lentTo = keysHost.get()
        lentTo?.lend('keys', true)
        giveBack = borrowPads('keys')
      } else {
        lentTo?.lend('keys', false)
        lentTo = null
        giveBack?.()
        giveBack = null
      }
    }
    const sense = new KeyboardSense(window)
    const d = new KeysDesk(pageDeskEnv(say, lend), sense)
    const coarse = window.matchMedia?.('(pointer: coarse)')
    const hands = (): void => {
      const h = pageHands(sense.touchFirst)
      sense.switchCode = h.scan ? SCAN.key : null
      d.setHands(h)
    }
    hands()
    sense.onChange = () => d.deviceChanged()
    const attrs = new MutationObserver(hands)
    attrs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-keys', 'data-assist'] })
    coarse?.addEventListener?.('change', hands)

    const onFocusIn = (e: FocusEvent): void => d.focusIn(e.target)
    const onFocusOut = (e: FocusEvent): void => d.focusOut(e.target, e.relatedTarget)
    // Registered after the sense's own: the device in use is already known when the press is looked at.
    const onPointer = (e: globalThis.PointerEvent): void => { if (e.isTrusted) d.pointerDown(e.target, e.pointerType) }
    const onKey = (e: KeyboardEvent): void => { if (e.isTrusted && e.code === SCAN.key && !e.repeat) d.switchOn(e.target) }
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('focusout', onFocusOut, true)
    window.addEventListener('pointerdown', onPointer, { capture: true, passive: true })
    window.addEventListener('keydown', onKey, true)
    const offBlocked = keysBlocked.subscribe(() => d.setBlocked(keysBlocked.get()))
    d.setBlocked(keysBlocked.get())
    const offSummon = onSummonKeys(() => d.summon())
    const offExpect = onExpectKeys(() => d.expect())
    // What the keys are doing, for the page: Sloane's card, and the cards and console that stand clear of them.
    let published: KeysView = HIDDEN_VIEW
    const offView = d.subscribe(() => {
      const v = d.get()
      const next = v.mode === 'hidden' ? HIDDEN_VIEW : published.mode === v.mode && published.field === v.field ? published : Object.freeze({ mode: v.mode, field: v.field })
      published = next
      keysView.set(next)
      document.documentElement.toggleAttribute('data-keys-open', v.mode === 'open')
      if (v.mode !== 'open') document.documentElement.style.removeProperty('--keys-height')
    })
    if (document.activeElement && isTextField(document.activeElement)) d.focusIn(document.activeElement)

    // The pads, read once a frame: a button going down says a pad is in use; the select button summons the keys where no
    // city reads it (the city's own read hands it over: App.tsx); while the keys stand open, the pad types.
    const pad = new KeysPad()
    const was = new Map<number, number>()
    let open = false
    let seenFamily: PadFamily = 'generic'
    let raf = 0
    const frame = (t: number): void => {
      raf = requestAnimationFrame(frame)
      const { pads, fresh } = playerPads()
      let edge = false, select = false
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i]
        if (!p) continue
        let mask = 0
        for (let b = 0; b < Math.min(17, p.buttons.length); b++) if (p.buttons[b]?.pressed) mask |= 1 << b
        const fresh_ = mask & ~(was.get(i) ?? 0)
        was.set(i, mask)
        if (fresh_ !== 0) {
          edge = true
          if (fresh_ & (1 << PAD.select)) select = true
          const fam = padFamilyOf(p.id)
          if (fam !== seenFamily) { seenFamily = fam; setFamily(fam) }
        }
      }
      if (edge) sense.note('gamepad')
      // A city that came up while the keys stood open lends its pads too.
      if (lentOn && keysHost.get() !== lentTo) { lentTo?.lend('keys', false); lentTo = keysHost.get(); lentTo?.lend('keys', true) }
      const v = d.get()
      const nowOpen = v.mode === 'open'
      if (nowOpen !== open) { pad.reset(); open = nowOpen }
      if (nowOpen) { for (const ask of pad.read(pads, t, pageHand())) d.padAsk(ask) }
      else if (select && !fresh) d.summon()
      if (v.mode !== 'hidden') d.refresh()
    }
    raf = requestAnimationFrame(frame)
    setDesk(d)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', onFocusOut, true)
      window.removeEventListener('pointerdown', onPointer, { capture: true })
      window.removeEventListener('keydown', onKey, true)
      coarse?.removeEventListener?.('change', hands)
      attrs.disconnect()
      offBlocked()
      offSummon()
      offExpect()
      offView()
      d.dispose()
      sense.dispose()
      keysView.set(HIDDEN_VIEW)
      document.documentElement.removeAttribute('data-keys-open')
      document.documentElement.style.removeProperty('--keys-height')
      setDesk(null)
    }
  }, [])

  return (
    <div {...{ [KEYS_ROOT]: '' }} data-way-out="">
      <div ref={liveRef} role="status" aria-live="polite" className="sr-only" />
      {desk && <Keys desk={desk} family={family} />}
    </div>
  )
}

function Keys({ desk, family }: { desk: KeysDesk; family: PadFamily }): JSX.Element | null {
  const view = useSyncExternalStore(desk.subscribe, desk.get, desk.get)
  if (view.mode === 'hidden') return null
  if (view.mode === 'peek') return <Chip desk={desk} pad={view.pad} family={family} />
  return <Board desk={desk} view={view} family={family} />
}

/** The keys offered, not open: one small button that opens them, with the pad's button for it. */
function Chip({ desk, pad, family }: { desk: KeysDesk; pad: boolean; family: PadFamily }): JSX.Element {
  return (
    <div className="sk-chip-row ui-zoom">
      <button
        type="button"
        className="sk-chip"
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => desk.summon()}
        aria-label="Open the on-screen keys"
      >
        <Icon name="system" />
        <span>Keys</span>
        {pad && <span className="sk-pill">{padButtonName(family, PAD.select)}</span>}
      </button>
    </div>
  )
}

/** A key being pressed by a pointer: which key, by which pointer, and whether it acts while held. */
interface Pressing { readonly id: string; readonly pointer: number; readonly held: boolean; readonly el: Element }

function Board({ desk, view, family }: { desk: KeysDesk; view: DeskView; family: PadFamily }): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const pressing = useRef<Pressing | null>(null)
  const pointerAt = useRef(-Infinity)
  const keys = view.board.rows.flat()
  const byId = (id: string | null): PlacedKey | undefined => (id ? keys.find((k) => k.id === id) : undefined)

  // The keys' height, for the cards and the console that stand clear of them, and the field kept above them.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const publish = (): void => {
      const h = Math.ceil(el.getBoundingClientRect().height)
      document.documentElement.style.setProperty('--keys-height', `${h}px`)
      requestAnimationFrame(() => clearOfKeys(desk.get().field, el.getBoundingClientRect().top))
    }
    publish()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null
    ro?.observe(el)
    window.addEventListener('resize', publish)
    return () => { ro?.disconnect(); window.removeEventListener('resize', publish) }
  }, [desk])

  const keyOf = (target: EventTarget | null): Element | null => (target instanceof Element ? target.closest('[data-key]') : null)
  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    const el = keyOf(e.target)
    // The caret stays in the field: no key, and no gap between keys, takes the focus.
    e.preventDefault()
    if (!el || pressing.current) return
    const id = el.getAttribute('data-key') ?? ''
    const key = byId(id)
    if (!key) return
    pointerAt.current = e.timeStamp
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId) } catch { /* the pointer is gone already */ }
    el.setAttribute('data-down', '')
    pressing.current = { id, pointer: e.pointerId, held: key.held === true, el }
    if (key.held) desk.holdStart(id)
  }
  const end = (e: PointerEvent<HTMLDivElement>, commit: boolean): void => {
    const p = pressing.current
    if (!p || p.pointer !== e.pointerId) return
    pressing.current = null
    p.el.removeAttribute('data-down')
    pointerAt.current = e.timeStamp
    if (p.held) { desk.holdEnd(p.id); return }
    // A key commits when the finger lifts on it: one slid off onto another key, or off the keys, presses nothing.
    if (commit && keyOf(document.elementFromPoint(e.clientX, e.clientY))?.getAttribute('data-key') === p.id) desk.press(p.id)
  }
  const onClick = (e: MouseEvent<HTMLDivElement>): void => {
    // A click no pointer pressed for: a screen reader's, a switch's (scanning.ts presses with click()), the dwell's.
    const el = keyOf(e.target)
    if (!el || (e.detail !== 0 && e.timeStamp - pointerAt.current < ASSIST_CLICK_MS)) return
    desk.press(el.getAttribute('data-key') ?? '')
  }
  const legend = view.pad ? keysLegend(family, pageHand()) : null

  return (
    <div ref={rootRef} className="sk-root" role="group" aria-label="On-screen keys">
      {legend && (
        <p className="sk-legend ui-zoom">
          {legend.map((l) => <span key={l.word}><b>{l.buttons}</b> {l.word}</span>)}
        </p>
      )}
      <div
        className="sk-board"
        style={{ gridTemplateColumns: `repeat(${BOARD_COLUMNS}, minmax(0, 1fr))` }}
        onPointerDown={onPointerDown}
        onPointerUp={(e) => end(e, true)}
        onPointerCancel={(e) => end(e, false)}
        onLostPointerCapture={(e) => end(e, false)}
        onClick={onClick}
        onContextMenu={(e) => e.preventDefault()}
      >
        {keys.map((k) => (
          <button
            key={`${k.row}:${k.id}`}
            type="button"
            tabIndex={-1}
            className="sk-key"
            data-key={k.id}
            data-kind={k.kind}
            data-key-at={view.at === k.id ? '' : undefined}
            data-held={view.held === k.id ? '' : undefined}
            aria-label={k.say}
            aria-pressed={k.kind === 'shift' ? view.keys.shift !== 'off' : k.kind === 'ctrl' ? view.keys.ctrl : undefined}
            style={{ gridColumn: `${k.x + 1} / span ${k.w}`, gridRow: k.row + 1 }}
          >
            {k.icon && !k.label ? <Icon name={k.icon} locked={k.kind === 'shift' && view.keys.shift === 'lock'} /> : k.id === 'space' ? <span className="sk-space" /> : k.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** The keys' pictures, drawn as plain strokes (no font, no mark). */
function Icon({ name, locked = false }: { name: KeyIcon; locked?: boolean }): JSX.Element {
  const path: Record<KeyIcon, string> = {
    shift: 'M12 4 4 12h4v6h8v-6h4z',
    backspace: 'M9 6h11v12H9l-6-6zM12 9l5 6M17 9l-5 6',
    enter: 'M19 6v6H6M10 8l-4 4 4 4',
    hide: 'M6 9l6 6 6-6',
    left: 'M15 6l-6 6 6 6',
    right: 'M9 6l6 6-6 6',
    up: 'M6 15l6-6 6 6',
    down: 'M6 9l6 6 6-6',
    tab: 'M4 12h14M14 8l4 4-4 4M20 6v12',
    system: 'M3 7h18v10H3zM6 10h1M9 10h1M12 10h1M15 10h1M18 10h0M7 14h10',
  }
  return (
    <svg viewBox="0 0 24 24" width="1.2em" height="1.2em" aria-hidden="true" fill={locked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d={path[name]} />
      {name === 'shift' && locked && <path d="M8 21h8" />}
    </svg>
  )
}
