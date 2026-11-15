// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The on-screen keys (ScreenKeys.tsx) should stand up when there is no keyboard to type
 * on, or when the player is holding a pad, and stay down otherwise, and no browser will say whether a keyboard is
 * plugged in. So this file judges by evidence, the only thing a page has. It watches which device acted last (a
 * key, a mouse, a finger, a pen, a pad's button, a headset's controller) and whether a key only a real keyboard
 * sends has been seen lately: a trusted keydown that names a place on the board (`code` "KeyA", "Digit4",
 * "ShiftLeft"). A phone's own on-screen keyboard mostly names none (its keys arrive with an empty or "Unidentified"
 * code, or as the composition key 229), and a remote's arrows and OK are not evidence of letters, so neither counts;
 * and since some phone keyboards are reported to name real codes, on a touch-first device a key into a field the
 * device's own keyboard may be serving is not counted either.
 * `keysServe` is the whole policy, one pure function over those facts and the player's setting (`access keys
 * auto|on|off`): a pad or a headset in the hand gets our keys for every field; a keyboard or a mouse gets none; a
 * finger on a touch-first device gets ours for a command field (the prompt: no phone keyboard has Esc, Tab, Ctrl or
 * the arrows) and the device's own for prose (its language, its corrections, its voice typing), unless a real
 * keyboard was typed on in the last few minutes. The hands the accessibility settings serve have no keyboard to
 * reach for: with single-switch scanning on, the keys serve every field (and the switch's own key, Space, is never
 * taken for a keyboard), and with dwell on, a pointer gets them as a pad does. `keysStand` then says whether the keys
 * stand open, are only offered as a chip, or are away: open when the player asked for them (a tap on the field, the
 * pad's button, the chip), never because a card took the focus by itself.
 * What breaks if it is removed? The keys either never appear or always do: a pad player cannot type, or a laptop
 * has a keyboard drawn over its console.
 */

/** What acted last. */
export type LastDevice = 'keyboard' | 'mouse' | 'touch' | 'pen' | 'gamepad' | 'headset'

/** The player's word: let the evidence decide, always ours, never ours. */
export type KeysSetting = 'auto' | 'on' | 'off'
export const KEYS_SETTINGS: readonly KeysSetting[] = ['auto', 'on', 'off']

export interface KeysFacts {
  readonly setting: KeysSetting
  /** The device that acted last; null before anything has. */
  readonly last: LastDevice | null
  /** A key only a real keyboard sends was pressed within KEYBOARD_MEMORY_MS. */
  readonly keyboardLately: boolean
  /** The device is touch-first: its primary pointer is a finger, so it raises a keyboard of its own for a field. */
  readonly touchFirst: boolean
  /** The focused field is for commands (textEntry.ts isCodeField), not prose. */
  readonly codeField: boolean
  /** Single-switch scanning is on (07_Execute_Actions/access.ts `scan`): the player's one key is no keyboard. */
  readonly scan?: boolean
  /** Dwell is on (access.ts `dwell`): the player presses by resting a pointer. */
  readonly dwell?: boolean
}

/** How long a real keyboard is taken to be still attached after its last key: ten minutes. */
export const KEYBOARD_MEMORY_MS = 10 * 60_000

/** The policy: whether our keys serve the focused field. */
export function keysServe(f: KeysFacts): boolean {
  if (f.setting === 'off') return false
  if (f.setting === 'on') return true
  switch (f.last) {
    case 'gamepad':
    case 'headset':
      return true
    case 'keyboard':
      return false
    case 'mouse':
      // A pointer that presses by resting has no keyboard beside it, until one is typed on.
      return f.dwell === true || f.scan === true
    case 'touch':
    case 'pen':
    case null:
      if (f.scan === true || f.dwell === true) return true
      // Nothing used yet reads as the device's own kind: a phone's first focus is a finger's to come.
      return f.touchFirst && f.codeField && !f.keyboardLately
  }
}

/** The keys: away, offered as a chip that opens them, or open. */
export type KeysStand = 'hidden' | 'peek' | 'open'

export interface StandFacts {
  /** A field to type in has the caret (or is remembered while a key has the focus). */
  readonly field: boolean
  /** The policy gives that field our keys (keysServe), or the player asked for them outright. */
  readonly serve: boolean
  /** The player handed this field to the device's own keyboard. */
  readonly yielded: boolean
  /** The player asked for the keys (a tap on the field, the pad's button, the chip) and has not put them away. */
  readonly wanted: boolean
  /** A card that must be answered first is up: its buttons have the pad and the screen. */
  readonly blocked: boolean
}

/**
 * Whether the keys stand open, are offered, or are away. They open only when asked for: a card that takes the focus
 * by itself (Sloane asking a question) gets the chip, never a keyboard thrown over half the screen with the pad
 * taken from the game. A card that must be answered first folds them to the chip until it is gone.
 */
export function keysStand(f: StandFacts): KeysStand {
  if (!f.field || !f.serve || f.yielded) return 'hidden'
  return f.wanted && !f.blocked ? 'open' : 'peek'
}

/** The part of a KeyboardEvent the evidence reads. */
export interface KeyEventLike {
  readonly isTrusted: boolean
  readonly code: string
  readonly key: string
  readonly keyCode?: number
  readonly isComposing?: boolean
}

/** The places on a keyboard that type or shift a character: letters, digits, punctuation, the number pad, the modifiers. */
const BOARD_CODE = /^(?:Key[A-Z]|Digit[0-9]|Numpad[A-Za-z0-9]+|Space|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Intl[A-Za-z]+|(?:Shift|Control|Alt|Meta)(?:Left|Right)|CapsLock)$/

/**
 * Whether a key event is evidence of a real keyboard: made by the browser (never by a script, so the on-screen keys'
 * own strokes are not evidence), naming a character's or a modifier's place on the board, and not a composition.
 * The arrows, Enter, Escape, Tab and Backspace prove nothing: a remote, a pad the system turns into keys and some
 * on-screen keyboards send them too.
 */
export function isPhysicalKey(e: KeyEventLike, switchCode: string | null = null): boolean {
  if (!e.isTrusted || e.isComposing === true || e.keyCode === 229) return false
  if (e.key === 'Unidentified' || e.key === 'Process' || e.key === 'Dead') return false
  // A single switch sends one key (scanning.ts SCAN.key): it is the player's whole keyboard, and no keyboard.
  if (switchCode !== null && e.code === switchCode) return false
  return BOARD_CODE.test(e.code)
}

/** The mark the on-screen keys' root carries: a press inside it is a press of a key, not a touch of the page. */
export const KEYS_ROOT = 'data-screen-keys'

/** Whether an event's target is inside the on-screen keys (their root carries KEYS_ROOT). */
export function insideKeys(target: unknown): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null
  return !!el && typeof el.closest === 'function' && el.closest(`[${KEYS_ROOT}]`) !== null
}

/** Whether `target` is a field the device's own keyboard may be typing into: a text field not marked inputmode none. */
function deviceKeyboardMayServe(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean; getAttribute?(name: string): string | null } | null
  if (!el) return false
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && el.isContentEditable !== true) return false
  return el.getAttribute?.('inputmode') !== 'none'
}

/** What the watcher needs of a window: its events, its media queries, its touch points. */
export interface SenseWindow {
  addEventListener(type: string, listener: (e: Event) => void, options?: boolean | { capture?: boolean; passive?: boolean }): void
  removeEventListener(type: string, listener: (e: Event) => void, options?: boolean | { capture?: boolean }): void
  matchMedia?: (query: string) => { readonly matches: boolean }
  readonly navigator?: { readonly maxTouchPoints?: number }
}

/**
 * The watcher: listens at the window, in the capture phase (a handler that stops a key still leaves it seen), for
 * the keys and pointers that say which device is in use. The pads and the headset have no events: whoever reads
 * them calls `note`. `onChange` is told whenever a fact a decision rests on has changed, and at every real key.
 */
export class KeyboardSense {
  last: LastDevice | null = null
  /** When a real keyboard's key was last seen, on `now`'s clock; -Infinity before any. */
  keyboardAt = -Infinity
  /** When a pointer last pressed the page (not a key of the on-screen keys); -Infinity before any. */
  pointerAt = -Infinity
  /** The single switch's key while scanning is on (scanning.ts SCAN.key), which is never a keyboard's; null otherwise. */
  switchCode: string | null = null
  onChange: (() => void) | null = null
  private readonly win: SenseWindow
  private readonly now: () => number
  private readonly onKey = (e: Event): void => {
    const k = e as Event & KeyEventLike
    if (!k.isTrusted || !isPhysicalKey(k, this.switchCode)) return
    // On a touch-first device a key into a field the device's own keyboard may be serving can be that keyboard's (an
    // iPhone's sends real codes for every letter). Only a key into a field ours keep it down for, or with no field to
    // type in, is surely a keyboard's.
    if (this.touchFirst && deviceKeyboardMayServe(e.target)) return
    this.keyboardAt = this.now()
    // Every such key is told, not only the first: keys opened while the keyboard was already the last device used
    // still go away at the next real key.
    if (this.last === 'keyboard') this.onChange?.()
    else this.set('keyboard')
  }
  private readonly onPointer = (e: Event): void => {
    // A press on one of the on-screen keys is typing, whatever pressed it: the keys opened by a pad and typed on with
    // a thumb on the screen must not decide a finger is now in charge and hand the field to the phone's keyboard.
    if (!e.isTrusted || insideKeys(e.target)) return
    const type = (e as Event & { pointerType?: string }).pointerType
    this.pointerAt = this.now()
    this.set(type === 'touch' ? 'touch' : type === 'pen' ? 'pen' : 'mouse')
  }

  constructor(win: SenseWindow, now: () => number = () => performance.now()) {
    this.win = win
    this.now = now
    win.addEventListener('keydown', this.onKey, { capture: true })
    win.addEventListener('pointerdown', this.onPointer, { capture: true, passive: true })
  }

  /** A pad's button went down, or a headset's controller acted (a stick that drifts is not a hand on the pad). Only the
   *  pads are noted so far: inside a headset session the page is not on show, and App.tsx folds the keys there. */
  note(device: 'gamepad' | 'headset'): void {
    this.set(device)
  }

  private set(device: LastDevice): void {
    if (this.last === device) return
    this.last = device
    this.onChange?.()
  }

  /** Whether a real keyboard's key was seen within KEYBOARD_MEMORY_MS. */
  get keyboardLately(): boolean {
    return this.now() - this.keyboardAt < KEYBOARD_MEMORY_MS
  }

  /** Whether the device is touch-first: a coarse primary pointer and a touch screen behind it. */
  get touchFirst(): boolean {
    let coarse = false
    try { coarse = this.win.matchMedia?.('(pointer: coarse)').matches === true } catch { /* no media queries: not touch-first */ }
    return coarse && (this.win.navigator?.maxTouchPoints ?? 0) > 0
  }

  /** The facts for one field, under the player's setting and the hands the accessibility settings serve. */
  facts(setting: KeysSetting, codeField: boolean, hands: { scan?: boolean; dwell?: boolean } = {}): KeysFacts {
    return { setting, last: this.last, keyboardLately: this.keyboardLately, touchFirst: this.touchFirst, codeField, scan: hands.scan === true, dwell: hands.dwell === true }
  }

  dispose(): void {
    this.win.removeEventListener('keydown', this.onKey, { capture: true })
    this.win.removeEventListener('pointerdown', this.onPointer, { capture: true })
    this.onChange = null
  }
}
