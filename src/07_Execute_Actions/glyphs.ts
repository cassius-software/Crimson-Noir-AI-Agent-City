// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It names every control the way the player's hands see it: keyboard keys, the
 * buttons and sticks of the controller they hold (named by its layout: letters with A at the south button,
 * letters with B there, numbered shoulders, or a generic pad named by button position), or the on-screen
 * touch controls. The HUD and the Concierge read their hints from here, so every hint switches silently when a
 * controller is picked up. Glyphs are plain letters, numbers, button positions and arrows only: no platform
 * names, logos, button symbols or other trademarked artwork.
 * What breaks if it is removed? Every control hint: the enter-vehicle prompt, the capture hint, the
 * Concierge's tips and its control list.
 *
 * Positions follow the W3C standard gamepad mapping the driver reads (gamepad.ts): interact = south
 * button, handbrake = east, reset = north, ping = right shoulder, run = left-stick click, mic = right-stick click,
 * throttle/brake = right/left trigger, clock = d-pad left/right. Labels are position-true, so on the 'bayx' layout
 * the south button reads 'B'.
 */
import type { GlyphFamily } from '../05_Observe_Environment/telemetry.ts'
import { PAD, type PadHand } from '../04_Connect_Hardware/gamepad.ts'

export type { GlyphFamily } from '../05_Observe_Environment/telemetry.ts'

export type ControlAction =
  | 'move' | 'look' | 'run' | 'interact' | 'handbrake' | 'reset' | 'throttle' | 'brake' | 'clock' | 'console' | 'hud' | 'ghost' | 'ping' | 'mic'

/**
 * A pad's layout: 'abxy' prints A B X Y at south, east, west, north; 'bayx' prints B A Y X there; 'numbered'
 * numbers its shoulders and stick clicks (L1 L2 L3) and its face buttons carry no letters, so they are named by
 * position; 'generic' is a pad nobody recognised, named by position throughout.
 */
export type PadFamily = 'abxy' | 'bayx' | 'numbered' | 'generic'
export type InputDevice = 'keyboard+mouse' | 'gamepad' | 'touch'

/** How a glyph is drawn: a keycap, a round face button, a stick, or a text pill (triggers, touch labels). */
export type GlyphKind = 'key' | 'button' | 'stick' | 'pill'

/** One control hint: what to press and what it does. */
export interface Hint { action: ControlAction; glyph: string; kind: GlyphKind; label: string }

/** '' = the family has no control for the action. Touch reaches the clock, the console, the HUD and ghost view
 *  through its Menu button (TouchControls.tsx); a pad reaches the console, the HUD and ghost view through its own
 *  menu (PadMenu.tsx), opened by its menu button, named here as the pad prints it (PAD_BUTTON_NAMES). */
const GLYPHS = {
  keyboard: {
    move: 'W A S D', look: 'Mouse', run: 'Shift', interact: 'E', handbrake: 'Space', reset: 'R',
    throttle: 'W', brake: 'S', clock: '[ ]', console: '~', hud: 'H', ghost: 'G', ping: 'Q', mic: 'V',
  },
  abxy: {
    move: 'L', look: 'R', run: 'LS', interact: 'A', handbrake: 'B', reset: 'Y',
    throttle: 'RT', brake: 'LT', clock: 'D-pad ◀ ▶', console: 'Menu', hud: 'Menu', ghost: 'Menu', ping: 'RB', mic: 'RS',
  },
  bayx: {
    move: 'L', look: 'R', run: 'LS', interact: 'B', handbrake: 'A', reset: 'X',
    throttle: 'ZR', brake: 'ZL', clock: 'D-pad ◀ ▶', console: '+', hud: '+', ghost: '+', ping: 'R', mic: 'RS',
  },
  numbered: {
    move: 'L', look: 'R', run: 'L3', interact: 'South', handbrake: 'East', reset: 'North',
    throttle: 'R2', brake: 'L2', clock: 'D-pad ◀ ▶', console: 'Start', hud: 'Start', ghost: 'Start', ping: 'R1', mic: 'R3',
  },
  generic: {
    move: 'L', look: 'R', run: 'LS', interact: 'South', handbrake: 'East', reset: 'North',
    throttle: 'RT', brake: 'LT', clock: 'D-pad ◀ ▶', console: 'Start', hud: 'Start', ghost: 'Start', ping: 'RB', mic: 'RS',
  },
  touch: {
    move: 'Stick', look: 'Drag', run: 'Run', interact: 'Enter car', handbrake: 'Handbrake', reset: 'Reset',
    throttle: 'Stick ▲', brake: 'Brake', clock: 'Menu', console: 'Menu', hud: 'Menu', ghost: 'Menu', ping: 'Ping', mic: 'Menu',
  },
} as const satisfies Record<GlyphFamily, Record<ControlAction, string>>

const FACE: ReadonlySet<ControlAction> = new Set(['interact', 'handbrake', 'reset'])

/** The glyph for an action in a family ('' when the family has no such control). */
export function glyph(action: ControlAction, family: GlyphFamily): string {
  return GLYPHS[family]?.[action] ?? ''
}

/** The glyph family for the input in use: touch, the most recently used pad's layout (generic when the
 *  vendor is unknown), or the keyboard. */
export function familyOf(device: InputDevice, padFamily: PadFamily | null): GlyphFamily {
  if (device === 'touch') return 'touch'
  if (device === 'gamepad') return padFamily ?? 'generic'
  return 'keyboard'
}

export function isPadFamily(family: GlyphFamily): family is PadFamily {
  return family !== 'keyboard' && family !== 'touch'
}

export function glyphKind(action: ControlAction, family: GlyphFamily): GlyphKind {
  if (family === 'touch') return 'pill'
  if (family === 'keyboard') return 'key'
  if (action === 'move' || action === 'look') return 'stick'
  if (FACE.has(action) && glyph(action, family).length === 1) return 'button'
  return 'pill'
}

/** Spoken form for assistive technology: the arrows and symbols read as words. */
const SPOKEN: Readonly<Record<string, string>> = { '◀': 'left', '▶': 'right', '▲': 'up', '~': 'Tilde', '[ ]': 'Square brackets' }
export function spokenGlyph(g: string): string {
  if (SPOKEN[g]) return SPOKEN[g]
  return g.replace(/[◀▶▲]/gu, (c) => SPOKEN[c]).replace(/\s+/g, ' ').trim()
}

/**
 * Each pad button's printed name by layout, in the standard mapping's order (south, east, west, north, the left and
 * right shoulders, the left and right triggers, the two centre buttons, the stick clicks, the d-pad up, down, left and
 * right, home): what the on-screen keys' legend and the pad's menu call a button. Position-true, as the table above.
 */
export const PAD_BUTTON_NAMES: Readonly<Record<PadFamily, readonly string[]>> = {
  abxy: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', 'Up', 'Down', 'Left', 'Right', 'Home'],
  bayx: ['B', 'A', 'Y', 'X', 'L', 'R', 'ZL', 'ZR', '−', '+', 'LS', 'RS', 'Up', 'Down', 'Left', 'Right', 'Home'],
  numbered: ['South', 'East', 'West', 'North', 'L1', 'R1', 'L2', 'R2', 'Select', 'Start', 'L3', 'R3', 'Up', 'Down', 'Left', 'Right', 'Home'],
  generic: ['South', 'East', 'West', 'North', 'LB', 'RB', 'LT', 'RT', 'Select', 'Start', 'LS', 'RS', 'Up', 'Down', 'Left', 'Right', 'Home'],
}

/** A pad button's printed name in a layout (standard mapping index); '' for an index the mapping has no name for. */
export function padButtonName(family: PadFamily, button: number): string {
  return PAD_BUTTON_NAMES[family][button] ?? ''
}

/**
 * The pad's menu button for the player's hand, as the pad prints it (gamepad.ts PAD_UI): start with both hands; with
 * one hand, whose centre buttons are its ping and run latch, select with that hand's shoulder held.
 */
export function padMenuWord(family: PadFamily, hand: PadHand): string {
  if (hand === 'both') return padButtonName(family, PAD.start)
  return `${padButtonName(family, PAD.select)} with ${padButtonName(family, hand === 'left' ? PAD.l1 : PAD.r1)} held`
}

type Row = readonly [ControlAction, string]

const FOOT_ALL: readonly Row[] = [
  ['move', 'Walk'], ['look', 'Look around'], ['run', 'Run'], ['interact', 'Enter a car'], ['ping', 'Ping a spot or a person'],
  ['mic', 'Microphone on · mute'], ['clock', 'Clock −1 h / +1 h'], ['console', 'Ring-0 console'], ['hud', 'Hide the HUD'], ['ghost', 'Ghost view'],
]
const DRIVE_ALL: readonly Row[] = [
  ['move', 'Steer'], ['throttle', 'Accelerate'], ['brake', 'Brake · reverse'], ['handbrake', 'Handbrake'],
  ['reset', 'Right the car'], ['interact', 'Leave the car'], ['ping', 'Ping a spot or a person'], ['look', 'Look around'],
  ['mic', 'Microphone on · mute'], ['clock', 'Clock −1 h / +1 h'], ['console', 'Ring-0 console'], ['hud', 'Hide the HUD'], ['ghost', 'Ghost view'],
]
/** The Concierge's three tips. Interact is prompted in context near a car, so the keyboard gets the
 *  console instead; touch explains where its car button appears. */
const TIPS: Readonly<Record<'keyboard' | 'pad' | 'touch', { foot: readonly Row[]; drive: readonly Row[] }>> = {
  keyboard: {
    foot: [['move', 'Walk'], ['look', 'Look around'], ['console', 'Ring-0 console']],
    drive: [['throttle', 'Accelerate'], ['move', 'Steer'], ['interact', 'Leave the car']],
  },
  pad: {
    foot: [['move', 'Walk'], ['look', 'Look around'], ['interact', 'Enter a car']],
    drive: [['throttle', 'Accelerate'], ['brake', 'Brake · reverse'], ['interact', 'Leave the car']],
  },
  touch: {
    foot: [['move', 'Walk'], ['look', 'Look around'], ['interact', 'Appears near a car']],
    drive: [['move', 'Steer and accelerate'], ['brake', 'Brake · reverse'], ['interact', 'Leave the car']],
  },
}

/** Glyph overrides in the car: the keyboard splits W A S D into throttle, brake and steering, and the
 *  touch button that enters a car reads "Exit car" from inside. */
function driveGlyph(action: ControlAction, family: GlyphFamily): string | undefined {
  if (family === 'keyboard' && action === 'move') return 'A D'
  if (family === 'touch' && action === 'interact') return 'Exit car'
  return undefined
}

/** The glyph for an action as the player sees it in the current mode (in the car the touch door button reads "Exit car"). */
export function modeGlyph(action: ControlAction, family: GlyphFamily, driving: boolean): string {
  return (driving ? driveGlyph(action, family) : undefined) ?? glyph(action, family)
}

/** Touch's one row for everything its Menu holds: the four keyboard rows it stands for would push a landscape phone's
 *  card off the screen. A pad's menu gets one row too, which also names the on-screen keys it opens. */
const TOUCH_MENU_LABEL = 'Microphone, clock, console, HUD, ghost view'
const PAD_MENU_LABEL = 'Menu: console, HUD, ghost view, on-screen keys'

/**
 * Control hints for the current mode. 'tips' = the Concierge's three; 'all' = every control the family
 * has (unbound ones skipped, the touch stick's throttle folded into "Steer and accelerate", and the touch
 * Menu's actions into one row).
 */
export function controlHints(family: GlyphFamily, driving: boolean, scope: 'tips' | 'all', hand: PadHand = 'both'): Hint[] {
  const group = family === 'keyboard' || family === 'touch' ? family : 'pad'
  let rows = scope === 'tips' ? TIPS[group][driving ? 'drive' : 'foot'] : driving ? DRIVE_ALL : FOOT_ALL
  if (scope === 'all' && driving && family === 'touch') {
    rows = rows.filter(([a]) => a !== 'throttle').map(([a, l]) => (a === 'move' ? ['move', 'Steer and accelerate'] as const : [a, l] as const))
  }
  const out: Hint[] = []
  for (const [action, label] of rows) {
    const g = modeGlyph(action, family, driving)
    if (!g) continue
    if (family === 'touch' && g === GLYPHS.touch.console) {
      if (!out.some((h) => h.glyph === g)) out.push({ action, glyph: g, kind: glyphKind(action, family), label: TOUCH_MENU_LABEL })
      continue
    }
    if (isPadFamily(family) && (action === 'console' || action === 'hud' || action === 'ghost')) {
      if (!out.some((h) => h.label === PAD_MENU_LABEL)) out.push({ action, glyph: hand === 'both' ? g : padMenuWord(family, hand), kind: glyphKind(action, family), label: PAD_MENU_LABEL })
      continue
    }
    out.push({ action, glyph: g, kind: glyphKind(action, family), label })
  }
  return out
}
