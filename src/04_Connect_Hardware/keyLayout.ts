// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the on-screen keys as data and rules, with no screen in it: which keys stand on
 * which row of which layer (letters, numbers, symbols, under one row of the keys a prompt needs: Esc, Tab, Ctrl, the
 * arrows, the dash and the slash), how wide each is on a grid of twenty half-columns, what pressing one does to the
 * board's own state (Shift for one letter, then locked, then off; Ctrl for one chord; the layer shown) and what it
 * sends on (a stroke for textEntry.ts, or a wish the overlay grants: put the keys away, hand over to the system's
 * keyboard, paste, change the last letter's accent), where a highlight goes when a d-pad or a stick steps across rows
 * of unequal length (it remembers its column, so down through the space bar and up again lands where it left), and
 * the accented forms a letter cycles through. Every character a US keyboard types is on some layer, which a test
 * holds it to. ScreenKeys.tsx draws the board and presses its keys; nothing here knows a pointer, a pad or a field.
 * What breaks if it is removed? The overlay has no keys to draw and no rule for Shift, the layers or the highlight.
 */
import { strokeFor, strokeOf, type KeyStroke, type NamedKey } from './textEntry.ts'

export type Layer = 'letters' | 'numbers' | 'symbols'
/** Shift: off, on for the next letter only, or locked on. */
export type ShiftState = 'off' | 'once' | 'lock'

/** The pictures a key may carry in place of text (drawn by the overlay, so no font has to hold them). */
export type KeyIcon = 'shift' | 'backspace' | 'enter' | 'hide' | 'left' | 'right' | 'up' | 'down' | 'tab' | 'system'

export type KeyKind =
  /** Types a character. */
  | 'char'
  /** A key with a name and no text: Enter, Backspace, Tab, Escape, an arrow. */
  | 'named'
  | 'shift'
  | 'ctrl'
  /** Shows another layer. */
  | 'layer'
  /** Changes the letter before the caret to its next accented form. */
  | 'accent'
  /** Puts the keys away. */
  | 'hide'
  /** Hands the field to the system's own keyboard. */
  | 'system'

export interface KeyDef {
  /** Unique on a board: the character a key types, or its name. Stable across layers for the keys every layer has. */
  readonly id: string
  readonly kind: KeyKind
  /** The character a `char` key types (lower case for a letter; Shift raises it). */
  readonly char?: string
  readonly named?: NamedKey
  /** The layer a `layer` key shows. */
  readonly to?: Layer
  /** Width in half-columns (a letter is 2). */
  readonly w: number
  /** What the key shows; '' when it shows its icon. */
  readonly label: string
  readonly icon?: KeyIcon
  /** What a screen reader says for it. */
  readonly say: string
  /** Acts when pressed, and again while held (Backspace, the arrows), where the other keys act once on release. */
  readonly held?: boolean
}

/** A key on its row: `x` is its left edge in half-columns from the board's left. */
export interface PlacedKey extends KeyDef {
  readonly row: number
  readonly x: number
}

export interface Board {
  readonly layer: Layer
  readonly rows: readonly (readonly PlacedKey[])[]
}

/** The board's width in half-columns: ten letters across. */
export const BOARD_COLUMNS = 20

export interface BoardOptions {
  readonly layer: Layer
  readonly shift: ShiftState
  /** Whether a key that hands over to the system's keyboard is offered (a device that has one). */
  readonly system: boolean
  /** The focused field's `enterkeyhint` ('go', 'send', 'done', 'search', 'next'), '' when it has none. */
  readonly enter: string
}

const SAY: Readonly<Record<string, string>> = {
  ' ': 'Space', ',': 'Comma', '.': 'Full stop', '-': 'Dash', '/': 'Slash', '\\': 'Backslash', '|': 'Bar', '_': 'Underscore',
  '\'': 'Apostrophe', '"': 'Quote', ':': 'Colon', ';': 'Semicolon', '`': 'Backtick', '~': 'Tilde',
}

function char(c: string, w = 2): KeyDef {
  return { id: c, kind: 'char', char: c, w, label: c, say: SAY[c] ?? c }
}
function chars(text: string): KeyDef[] {
  return Array.from(text, c => char(c))
}

const ARROWS: readonly KeyDef[] = [
  { id: 'ArrowLeft', kind: 'named', named: 'ArrowLeft', w: 2, label: '', icon: 'left', say: 'Left', held: true },
  { id: 'ArrowUp', kind: 'named', named: 'ArrowUp', w: 2, label: '', icon: 'up', say: 'Up', held: true },
  { id: 'ArrowDown', kind: 'named', named: 'ArrowDown', w: 2, label: '', icon: 'down', say: 'Down', held: true },
  { id: 'ArrowRight', kind: 'named', named: 'ArrowRight', w: 2, label: '', icon: 'right', say: 'Right', held: true },
]

/** The row every layer keeps: what a prompt needs and a phone's keyboard lacks. */
const TOP_ROW: readonly KeyDef[] = [
  { id: 'Escape', kind: 'named', named: 'Escape', w: 2, label: 'Esc', say: 'Escape' },
  { id: 'Tab', kind: 'named', named: 'Tab', w: 2, label: '', icon: 'tab', say: 'Tab' },
  { id: 'ctrl', kind: 'ctrl', w: 2, label: 'Ctrl', say: 'Control' },
  ...ARROWS,
  char('-'), char('/'),
  { id: 'accent', kind: 'accent', w: 2, label: 'áü', say: 'Accent: change the last letter' },
]

const BACKSPACE: KeyDef = { id: 'Backspace', kind: 'named', named: 'Backspace', w: 3, label: '', icon: 'backspace', say: 'Backspace', held: true }

/** What Enter shows for a field's `enterkeyhint`; a field without one gets the bent arrow. */
const ENTER_LABELS: Readonly<Record<string, string>> = { go: 'Go', send: 'Send', done: 'Done', search: 'Search', next: 'Next', previous: 'Back' }

function layerKey(to: Layer, label: string, say: string): KeyDef {
  return { id: `layer:${to}`, kind: 'layer', to, w: 3, label, say }
}

function bottomRow(layer: Layer, system: boolean, enter: string): KeyDef[] {
  const enterLabel = ENTER_LABELS[enter.toLowerCase()] ?? ''
  const row: KeyDef[] = [layer === 'letters' ? layerKey('numbers', '123', 'Numbers') : layerKey('letters', 'abc', 'Letters')]
  if (system) row.push({ id: 'system', kind: 'system', w: 2, label: '', icon: 'system', say: 'Use the device\'s own keyboard' })
  row.push(char(','))
  row.push({ ...char(' ', system ? 6 : 8), id: 'space', label: '' })
  row.push(char('.'))
  row.push({ id: 'Enter', kind: 'named', named: 'Enter', w: 3, label: enterLabel, ...(enterLabel ? {} : { icon: 'enter' as const }), say: enterLabel || 'Enter' })
  row.push({ id: 'hide', kind: 'hide', w: 2, label: '', icon: 'hide', say: 'Hide the keys' })
  return row
}

/** The three rows that differ by layer, top to bottom. `pad` is the room left of a row, in half-columns. */
function layerRows(layer: Layer, shift: ShiftState): { pad: number; keys: KeyDef[] }[] {
  if (layer === 'letters') {
    const up = shift !== 'off'
    const letters = (text: string): KeyDef[] => chars(text).map(k => up ? { ...k, label: k.label.toUpperCase(), say: `Capital ${k.label}` } : k)
    return [
      { pad: 0, keys: letters('qwertyuiop') },
      { pad: 1, keys: letters('asdfghjkl') },
      { pad: 0, keys: [
        { id: 'shift', kind: 'shift', w: 3, label: '', icon: 'shift', say: shift === 'lock' ? 'Shift, locked' : shift === 'once' ? 'Shift, on' : 'Shift' },
        ...letters('zxcvbnm'), BACKSPACE,
      ] },
    ]
  }
  if (layer === 'numbers') {
    return [
      { pad: 0, keys: chars('1234567890') },
      { pad: 0, keys: chars('!@#$%^&*()') },
      { pad: 0, keys: [layerKey('symbols', '#+=', 'More symbols'), ...chars('_\'":=+?'), BACKSPACE] },
    ]
  }
  return [
    { pad: 0, keys: chars('~`\\|{}[]<>') },
    { pad: 0, keys: chars(';€£¥°§¿¡«»') },
    { pad: 0, keys: [layerKey('numbers', '123', 'Numbers'), ...chars('–—“”‘’…'), BACKSPACE] },
  ]
}

/** The board for a layer: five rows, each key with its place. */
export function boardFor(opts: BoardOptions): Board {
  const rows = [{ pad: 0, keys: [...TOP_ROW] }, ...layerRows(opts.layer, opts.shift), { pad: 0, keys: bottomRow(opts.layer, opts.system, opts.enter) }]
  return {
    layer: opts.layer,
    rows: rows.map((r, row) => {
      let x = r.pad
      return r.keys.map(k => { const placed: PlacedKey = { ...k, row, x }; x += k.w; return placed })
    }),
  }
}

/** Every key of a board, row by row. */
export function keysOf(board: Board): PlacedKey[] {
  return board.rows.flat()
}

// ---- the board's own state ------------------------------------------------------------------------------------------

export interface KeysState {
  readonly layer: Layer
  readonly shift: ShiftState
  /** Ctrl is down for the next key. */
  readonly ctrl: boolean
}

export const KEYS_START: KeysState = Object.freeze({ layer: 'letters', shift: 'off', ctrl: false })

/** What a pressed key sends on: a stroke for the field, or a wish only the overlay can grant. */
export type KeyOut =
  | { readonly kind: 'stroke'; readonly stroke: KeyStroke }
  | { readonly kind: 'accent' }
  | { readonly kind: 'paste' }
  | { readonly kind: 'hide' }
  | { readonly kind: 'system' }

export interface KeyPress {
  readonly state: KeysState
  /** Null when the key only changed the board (Shift, Ctrl, a layer). */
  readonly out: KeyOut | null
}

/** The keys Shift has no say over and that do not use it up: the caret's own. */
const CARET_KEYS: ReadonlySet<string> = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace', 'Delete', 'Home', 'End'])

/**
 * One key pressed: the board's next state and what goes to the field. Shift goes off → on for one letter → locked →
 * off (a second press locks it, with no clock to race). A letter uses up a one-letter Shift; Enter and Tab carry it
 * (Shift+Enter is a new line at the prompt) and use it up; the arrows and Backspace neither carry nor use it. Ctrl
 * holds for one key: with a letter it is a chord (Ctrl+V asks the overlay to paste, since the clipboard is the
 * page's), and any key that is not Shift lets it go.
 */
export function pressKey(state: KeysState, key: KeyDef): KeyPress {
  switch (key.kind) {
    case 'shift':
      return { state: { ...state, shift: state.shift === 'off' ? 'once' : state.shift === 'once' ? 'lock' : 'off' }, out: null }
    case 'ctrl':
      return { state: { ...state, ctrl: !state.ctrl }, out: null }
    case 'layer':
      return { state: { layer: key.to ?? 'letters', shift: state.shift === 'lock' ? 'lock' : 'off', ctrl: false }, out: null }
    case 'hide':
      return { state: { ...state, ctrl: false }, out: { kind: 'hide' } }
    case 'system':
      return { state: { ...state, ctrl: false }, out: { kind: 'system' } }
    case 'accent':
      return { state: { ...state, ctrl: false }, out: { kind: 'accent' } }
    case 'named': {
      const named = key.named ?? 'Enter'
      if (CARET_KEYS.has(named)) return { state: { ...state, ctrl: false }, out: { kind: 'stroke', stroke: strokeOf(named, false, state.ctrl) } }
      // Shift pressed once goes with the next key (Shift+Enter: a new line at the prompt; Shift+Tab: back a field); caps
      // lock, like a keyboard's, raises letters and leaves Enter and Tab as they are.
      const shift = named !== 'Escape' && state.shift === 'once'
      return {
        state: { ...state, ctrl: false, shift: state.shift === 'once' ? 'off' : state.shift },
        out: { kind: 'stroke', stroke: strokeOf(named, shift, state.ctrl) },
      }
    }
    case 'char': {
      const base = key.char ?? ''
      const letter = base.length === 1 && base.toLowerCase() !== base.toUpperCase()
      const next: KeysState = { ...state, ctrl: false, shift: letter && state.shift === 'once' ? 'off' : state.shift }
      if (state.ctrl) {
        if (base === 'v') return { state: next, out: { kind: 'paste' } }
        return { state: next, out: { kind: 'stroke', stroke: strokeFor(base, true) } }
      }
      const typed = letter && state.shift !== 'off' ? base.toUpperCase() : base
      return { state: next, out: { kind: 'stroke', stroke: strokeFor(typed) } }
    }
  }
}

// ---- the highlight a d-pad or a stick moves -------------------------------------------------------------------------

export type StepDir = 'left' | 'right' | 'up' | 'down'

/** Where the highlight is: a key by row and place in the row, and the column (in half-columns) it means to keep. */
export interface Cursor {
  readonly row: number
  readonly index: number
  readonly x: number
}

function centre(k: PlacedKey): number {
  return k.x + k.w / 2
}

/** The key of a row that stands over column `x`, else the nearest to it. */
function indexAt(row: readonly PlacedKey[], x: number): number {
  let best = 0, bestGap = Infinity
  for (let i = 0; i < row.length; i++) {
    const k = row[i]
    if (x >= k.x && x < k.x + k.w) return i
    const gap = Math.abs(centre(k) - x)
    if (gap < bestGap) { best = i; bestGap = gap }
  }
  return best
}

/** The cursor on the key with this id, or null when the board has none. */
export function cursorOn(board: Board, id: string): Cursor | null {
  for (let r = 0; r < board.rows.length; r++) {
    const i = board.rows[r].findIndex(k => k.id === id)
    if (i >= 0) return { row: r, index: i, x: centre(board.rows[r][i]) }
  }
  return null
}

/** The key under a cursor (the cursor of another layer lands on the key that stands where it stood). */
export function keyAt(board: Board, c: Cursor): PlacedKey {
  const row = board.rows[Math.max(0, Math.min(board.rows.length - 1, c.row))]
  const byIndex = row[c.index]
  if (byIndex && c.x >= byIndex.x && c.x < byIndex.x + byIndex.w) return byIndex
  return row[indexAt(row, c.x)]
}

/** The cursor fitted to a board: the same row and column, on whatever key stands there now. */
export function fitCursor(board: Board, c: Cursor): Cursor {
  const r = Math.max(0, Math.min(board.rows.length - 1, c.row))
  return { row: r, index: indexAt(board.rows[r], c.x), x: c.x }
}

/**
 * One step of the highlight. Left and right walk the row and wrap at its ends, and set the column the cursor keeps;
 * up and down change rows, wrapping top to bottom, and land on the key over that column, so a trip down through the
 * space bar and back comes home.
 */
export function stepCursor(board: Board, from: Cursor, dir: StepDir): Cursor {
  const c = fitCursor(board, from)
  const rows = board.rows
  if (dir === 'left' || dir === 'right') {
    const row = rows[c.row]
    const index = (c.index + (dir === 'right' ? 1 : -1) + row.length) % row.length
    return { row: c.row, index, x: centre(row[index]) }
  }
  const r = (c.row + (dir === 'down' ? 1 : -1) + rows.length) % rows.length
  return { row: r, index: indexAt(rows[r], c.x), x: c.x }
}

// ---- accents --------------------------------------------------------------------------------------------------------

/** The forms a letter cycles through under the accent key, the plain letter first. */
const ACCENT_RINGS: readonly string[] = [
  'aáàâäãåæāą', 'cçćč', 'dďđ', 'eéèêëēęě',
  'gğ', 'iíìîïīı', 'lł', 'nñńň', 'oóòôöõøœōő',
  'rř', 'sßśšş', 'tťţ', 'uúùûüūůű', 'yýÿ', 'zžźż',
]

const NEXT_ACCENT: ReadonlyMap<string, string> = (() => {
  const next = new Map<string, string>()
  const link = (ring: readonly string[]): void => { ring.forEach((c, i) => next.set(c, ring[(i + 1) % ring.length])) }
  for (const text of ACCENT_RINGS) {
    const lower = Array.from(text)
    link(lower)
    // The capitals' ring holds only the forms that have a capital of their own, one character long (the sharp s and the dotless i have none).
    const upper = lower.map(c => c.toUpperCase()).filter((c, i, all) => c.length === 1 && c !== lower[i] && all.indexOf(c) === i)
    if (upper.length > 1) link(upper)
  }
  return next
})()

/** The next accented form of a letter (the plain one again after the last), or null for a character that has none. */
export function nextAccent(cluster: string): string | null {
  return NEXT_ACCENT.get(cluster.normalize('NFC')) ?? null
}
