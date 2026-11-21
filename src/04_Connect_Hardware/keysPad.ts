// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is how a pad types on the on-screen keys (ScreenKeys.tsx): which button does what
 * while the keys have the pad, for both hands and for one (07_Execute_Actions/access.ts `pad`), and when a held
 * control acts again. The d-pad or the left stick steps the highlight, the south button presses the key under it,
 * and the controls a typist reaches for most have buttons of their own (delete, space, the caret, Shift, Enter, the
 * layer, away), so a word is not a tour of the board. With one hand, that hand's stick steps and its trigger presses;
 * what it has no button for is a key on the board. The right stick steps nothing with both hands, so its click stays
 * a clean microphone mute. A press is an edge; a control held on acts again after a pause, then at a steady rate, as
 * a held key does; a trigger is down past six tenths and up under four, so one hovering at the edge does not
 * chatter. Whatever is already down when the keys take the pad (the very button that opened them) does nothing
 * until it has been let go. Pure: the pads are handed in, in the standard shape (gamepad.ts PadMapper.views), and
 * the clock too.
 * What breaks if it is removed? A player holding a pad can open the keys and then press none of them.
 */
import { PAD, type PadHand } from './gamepad.ts'
import { padButtonName, type PadFamily } from '../07_Execute_Actions/glyphs.ts'

/** What a pad can ask of the keys. */
export type PadControl =
  | 'up' | 'down' | 'left' | 'right'
  /** The key under the highlight. */
  | 'press'
  /** Backspace. */
  | 'back'
  | 'space'
  /** Puts the keys away. */
  | 'close'
  | 'caretLeft' | 'caretRight'
  | 'shift'
  | 'enter'
  /** The next layer: letters, numbers, symbols. */
  | 'layer'

export const KEYS_PAD = Object.freeze({
  /** A held control acts again after this long, ms. */
  delayMs: 380,
  /** Then this often, ms. */
  rateMs: 95,
  /** A stick steps the highlight past this much tilt, and is at rest again under `stickRest`. */
  stick: 0.6,
  stickRest: 0.4,
  /** A trigger is down past this much squeeze, and up again under `triggerUp`. */
  triggerDown: 0.6,
  triggerUp: 0.4,
})

/** The controls that act again while held; the rest act once a press. */
const REPEATS: ReadonlySet<PadControl> = new Set<PadControl>(['up', 'down', 'left', 'right', 'press', 'back', 'space', 'caretLeft', 'caretRight'])

const CONTROLS: readonly PadControl[] = ['up', 'down', 'left', 'right', 'press', 'back', 'space', 'close', 'caretLeft', 'caretRight', 'shift', 'enter', 'layer']

/** The buttons of each control, by hand. A control with no button for a hand is on the board itself, under the highlight. */
const BUTTONS: Readonly<Record<PadHand, Partial<Record<PadControl, readonly number[]>>>> = {
  both: {
    up: [PAD.up], down: [PAD.down], left: [PAD.left], right: [PAD.right],
    press: [PAD.south], close: [PAD.east], back: [PAD.west], space: [PAD.north],
    caretLeft: [PAD.l1], caretRight: [PAD.r1], shift: [PAD.l2], enter: [PAD.r2, PAD.start], layer: [PAD.select],
  },
  // The left hand: its stick or the d-pad steps, its trigger presses, its shoulder deletes; the centre buttons are shared.
  left: {
    up: [PAD.up], down: [PAD.down], left: [PAD.left], right: [PAD.right],
    press: [PAD.l2], back: [PAD.l1], enter: [PAD.start], layer: [PAD.select],
  },
  // The right hand: its stick steps, its face buttons are the both-hands ones, and its trigger and shoulder press and delete too.
  right: {
    press: [PAD.south, PAD.r2], close: [PAD.east], back: [PAD.west, PAD.r1], space: [PAD.north],
    enter: [PAD.start], layer: [PAD.select],
  },
}

/** The stick that steps the highlight, as an axis pair, by hand (with both hands the left one: the right one's click is the mute). */
const STICKS: Readonly<Record<PadHand, readonly (readonly [number, number])[]>> = { both: [[0, 1]], left: [[0, 1]], right: [[2, 3]] }

/** The buttons a hand's layout gives a control: what the legend names. */
export function padButtonsFor(hand: PadHand, control: PadControl): readonly number[] {
  return BUTTONS[hand][control] ?? []
}

/** The legend's lines, in the order a typist reaches for them: the controls and the word for each. */
const LEGEND: readonly (readonly [readonly PadControl[], string])[] = [
  [['press'], 'type'], [['back'], 'delete'], [['space'], 'space'], [['caretLeft', 'caretRight'], 'caret'],
  [['shift'], 'shift'], [['enter'], 'enter'], [['layer'], 'symbols'], [['close'], 'hide'],
]

export interface LegendItem {
  /** The buttons, by their printed names in the pad's layout (glyphs.ts PAD_BUTTON_NAMES). */
  readonly buttons: string
  readonly word: string
}

/**
 * What the keys' legend says for a pad layout and a hand: what steps the highlight, then each control a button of
 * its own does. A control a hand has no button for is not said: it is a key on the board (with the left hand, the
 * Hide key puts the keys away).
 */
export function keysLegend(family: PadFamily, hand: PadHand): LegendItem[] {
  const items: LegendItem[] = [{ buttons: hand === 'right' ? 'Right stick' : 'D-pad, left stick', word: 'move' }]
  for (const [controls, word] of LEGEND) {
    const names = [...new Set(controls.flatMap((c) => padButtonsFor(hand, c)).map((b) => padButtonName(family, b)).filter(Boolean))]
    if (names.length > 0) items.push({ buttons: names.join(' '), word })
  }
  return items
}

/** The part of a pad read here: the standard shape. */
export interface KeysPadLike {
  readonly axes: ArrayLike<number>
  readonly buttons: ArrayLike<{ readonly pressed: boolean; readonly value?: number } | undefined>
}

export interface PadAsk {
  control: PadControl
  /** A held control acting again (false: the press itself). */
  repeat: boolean
}

const TRIGGERS: ReadonlySet<number> = new Set([PAD.l2, PAD.r2])

/**
 * The reader: one `read` a frame while the keys have the pad. It answers with what the pads ask for now, in a list it
 * reuses (read it before the next call).
 */
export class KeysPad {
  private readonly held = new Map<PadControl, boolean>()
  /** Down when the keys took the pad: nothing until let go. */
  private readonly stale = new Set<PadControl>()
  private readonly nextAt = new Map<PadControl, number>()
  /** Each stick's direction as last judged (hysteresis between `stick` and `stickRest`). */
  private readonly tilt = new Map<string, PadControl | null>()
  /** The triggers judged down (hysteresis between `triggerDown` and `triggerUp`), as "pad:button". */
  private readonly squeezed = new Set<string>()
  private first = true
  private readonly out: PadAsk[] = []
  private readonly now_ = new Map<PadControl, boolean>()

  /** Whether button `b` of pad `i` is down: a trigger by how far it is squeezed, where the pad says. */
  private down(i: number, b: number, button: { readonly pressed: boolean; readonly value?: number } | undefined): boolean {
    if (!button) return false
    if (!TRIGGERS.has(b) || typeof button.value !== 'number') return button.pressed
    const key = `${i}:${b}`
    // A pad that reports its trigger as a plain button says pressed with no value: that is down too.
    if (button.value >= KEYS_PAD.triggerDown || (button.pressed && button.value === 0)) this.squeezed.add(key)
    else if (button.value < KEYS_PAD.triggerUp) this.squeezed.delete(key)
    return this.squeezed.has(key)
  }

  /** Forgets everything: the next read only learns what is held. */
  reset(): void {
    this.held.clear()
    this.stale.clear()
    this.nextAt.clear()
    this.tilt.clear()
    this.squeezed.clear()
    this.first = true
  }

  read(pads: ArrayLike<KeysPadLike | null | undefined>, now: number, hand: PadHand = 'both'): readonly PadAsk[] {
    const is = this.now_
    for (const c of CONTROLS) is.set(c, false)
    const map = BUTTONS[hand]
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i]
      if (!p) continue
      for (const c of CONTROLS) {
        const buttons = map[c]
        if (!buttons) continue
        for (const b of buttons) if (this.down(i, b, p.buttons[b])) is.set(c, true)
      }
      for (const [ax, ay] of STICKS[hand]) {
        const x = p.axes[ax] ?? 0, y = p.axes[ay] ?? 0
        const key = `${i}:${ax}`
        const was = this.tilt.get(key) ?? null
        const mx = Math.abs(x), my = Math.abs(y)
        let dir: PadControl | null = null
        // Tilted past `stick`, a stick stays tilted until it is back under `stickRest`.
        if (Math.max(mx, my) >= (was === null ? KEYS_PAD.stick : KEYS_PAD.stickRest)) {
          // The greater axis decides, and a direction held is kept until the other axis clearly passes it.
          const horizontal = was === 'left' || was === 'right' ? my <= mx + 0.2 : was === 'up' || was === 'down' ? mx > my + 0.2 : mx > my
          dir = horizontal ? (x > 0 ? 'right' : 'left') : (y > 0 ? 'down' : 'up')
        }
        this.tilt.set(key, dir)
        if (dir) is.set(dir, true)
      }
    }
    const out = this.out
    out.length = 0
    for (const c of CONTROLS) {
      const on = is.get(c) === true
      const was = this.held.get(c) === true
      this.held.set(c, on)
      if (this.first) { if (on) this.stale.add(c); continue }
      if (!on) { this.stale.delete(c); continue }
      if (this.stale.has(c)) continue
      if (!was) {
        out.push({ control: c, repeat: false })
        this.nextAt.set(c, now + KEYS_PAD.delayMs)
      } else if (REPEATS.has(c) && now >= (this.nextAt.get(c) ?? Infinity)) {
        out.push({ control: c, repeat: true })
        this.nextAt.set(c, now + KEYS_PAD.rateMs)
      }
    }
    this.first = false
    return out
  }
}
