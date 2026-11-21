// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is how a key that is not a keyboard's reaches a text field: the on-screen keys
 * (ScreenKeys.tsx), pressed by a finger, a pad or a headset's ray, type through here into whatever field has the
 * caret, the Ring-0 prompt as much as Sloane's line, without either knowing the other. A stroke is delivered the way
 * a keyboard's is: a `keydown` the page may take (the prompt's Enter, Tab and Ctrl chords; the console's toggle on
 * the backquote), then, if nothing took it, what the key does by default (the text goes in at the caret, Backspace
 * takes the cluster before it, the arrows move it, Enter breaks a line or submits the field's form), told to the page
 * as `beforeinput` and `input`, then, in a later task as a keyboard's is, a `keyup` (a page that redraws its field in
 * answer to the keydown has redrawn it by then, so what it reads on keyup is true). The value is written through the
 * element's own prototype setter, the one a browser's typing ends in, so a field React controls sees the change and
 * calls its onChange; the field is scrolled to its caret, which a browser does only for its own typing. A stroke
 * goes where a keyboard's would: to a field that is still on the page and shown (never a closed console's prompt),
 * and, when the page answered the keydown by moving the focus to another field, into that one. Nothing here knows a
 * card or a console: a field is its value, its selection and the events it hears.
 * It is pure of the page (the events, the later task, the focused field and the scrolling come from an environment
 * handed in; `browserEntryEnv` is the one over a window), so a Node test types into a fake field and reads what
 * happened.
 * What breaks if it is removed? The on-screen keys press nothing: a player without a keyboard cannot type a word.
 */

/** One key going down and up: what a KeyboardEvent would say, and the text it types when nothing takes it. */
export interface KeyStroke {
  /** KeyboardEvent.key: the character, or the key's name ('Enter', 'Backspace', 'ArrowLeft'). */
  readonly key: string
  /** KeyboardEvent.code: the key's place on a US board ('KeyA', 'Backquote'), '' for a character no key carries. */
  readonly code: string
  /** The text the stroke inserts by default ('' for a key that types nothing). */
  readonly text: string
  readonly shift?: boolean
  readonly ctrl?: boolean
}

/** The part of a text field the entry touches (an <input> or a <textarea> satisfies it; a test hands in a fake). */
export interface FieldLike {
  value: string
  readonly tagName: string
  readonly type?: string
  readonly selectionStart: number | null
  readonly selectionEnd: number | null
  readonly maxLength?: number
  readonly readOnly?: boolean
  readonly disabled?: boolean
  readonly form?: FormLike | null
  setSelectionRange?(start: number, end: number): void
  dispatchEvent(event: Event): boolean
}

/** The part of a field's form Enter touches: its default button, or the form itself when it has none. */
export interface FormLike {
  requestSubmit?: () => void
  querySelector?: (selector: string) => { disabled?: boolean; click(): void } | null
}

/** What the entry needs of the page. */
export interface EntryEnv {
  /** A key event as a keyboard's is made (bubbling, cancelable). */
  key(type: 'keydown' | 'keyup', stroke: KeyStroke, repeat: boolean): Event
  input(type: 'beforeinput' | 'input', inputType: string, data: string | null): Event
  /** Runs `fn` in a later task (a keyup follows its keydown, never rides with it). */
  later(fn: () => void): void
  /** The field that has the focus now, when it is one to type in (document.activeElement); null otherwise. */
  active?(): FieldLike | null
  /** Scrolls a field so its caret shows (a browser does this only for its own typing). */
  reveal?(el: FieldLike): void
}

/** What became of a stroke. */
export type StrokeResult =
  /** A handler of the page took the keydown (preventDefault): the field was left to it. */
  | 'taken'
  /** The field changed, or its caret moved. */
  | 'typed'
  /** Enter in a one-line field: its form was asked to submit. */
  | 'submitted'
  /** Tab that nothing took: the caller moves the focus on (the entry knows no other field). */
  | 'tab'
  /** Nothing to do (a key with no default here, a full field, a field that cannot be written). */
  | 'none'

/**
 * The <input> types that take typed text here; the rest are not fields to type in: a checkbox, a range, a file, and a
 * number field too (it empties itself whenever a half-typed value is not yet a number, so it keeps the device's own
 * keyboard).
 */
const TEXT_TYPES: ReadonlySet<string> = new Set(['', 'text', 'search', 'url', 'tel', 'email', 'password'])

/**
 * Whether an element is a field the keys can type in: a text <input> or a <textarea> that can be written. (An
 * editable region is not: it has no value to write; the page has none.)
 */
export function isTextField(el: unknown): boolean {
  if (!el || typeof el !== 'object') return false
  const e = el as { tagName?: unknown; type?: unknown; readOnly?: unknown; disabled?: unknown }
  if (e.disabled === true || e.readOnly === true) return false
  const tag = typeof e.tagName === 'string' ? e.tagName.toUpperCase() : ''
  if (tag === 'TEXTAREA') return true
  if (tag === 'INPUT') return TEXT_TYPES.has(typeof e.type === 'string' ? e.type.toLowerCase() : '')
  return false
}

/**
 * Whether a field is still there to type in: a text field, on the page, not made inert and not hidden (a closed
 * console's prompt is all three of the last, and still takes a dispatched key). Opacity is not asked about: the
 * prompt is see-through by design, behind the line that mirrors it.
 */
export function isLiveField(el: unknown): boolean {
  if (!isTextField(el)) return false
  const e = el as { isConnected?: boolean; closest?: (selector: string) => unknown; checkVisibility?: (options?: object) => boolean }
  if (e.isConnected === false) return false
  if (typeof e.closest === 'function' && e.closest('[inert]')) return false
  return typeof e.checkVisibility !== 'function' || e.checkVisibility({ visibilityProperty: true })
}

/**
 * Whether a field is for commands rather than prose: it has switched the writing aids off (no autocorrect, no
 * capitals, no spell check), as a prompt does and a chat line does not. Read from the attributes any field may carry,
 * so nothing has to name the console.
 */
export function isCodeField(el: { getAttribute?(name: string): string | null } | null | undefined): boolean {
  if (!el || typeof el.getAttribute !== 'function') return false
  const caps = (el.getAttribute('autocapitalize') ?? '').toLowerCase()
  const spell = (el.getAttribute('spellcheck') ?? '').toLowerCase()
  return (caps === 'off' || caps === 'none') && spell === 'false'
}

const SHIFTED_DIGITS = ')!@#$%^&*('
/** A US board's punctuation keys: the code, the character it types, and the one it types with Shift. */
const PUNCTUATION: readonly (readonly [code: string, plain: string, shifted: string])[] = [
  ['Backquote', '`', '~'], ['Minus', '-', '_'], ['Equal', '=', '+'], ['BracketLeft', '[', '{'], ['BracketRight', ']', '}'],
  ['Backslash', '\\', '|'], ['Semicolon', ';', ':'], ['Quote', '\'', '"'], ['Comma', ',', '<'], ['Period', '.', '>'], ['Slash', '/', '?'],
]

/** The stroke that types one character: its key, its place on a US board, and whether Shift is down for it. */
export function strokeFor(char: string, ctrl = false): KeyStroke {
  if (char === ' ') return { key: ' ', code: 'Space', text: ctrl ? '' : ' ', shift: false, ctrl }
  if (char.length === 1) {
    const c = char.toLowerCase()
    if (c >= 'a' && c <= 'z') return { key: char, code: `Key${c.toUpperCase()}`, text: ctrl ? '' : char, shift: char !== c, ctrl }
    if (char >= '0' && char <= '9') return { key: char, code: `Digit${char}`, text: ctrl ? '' : char, shift: false, ctrl }
    const digit = SHIFTED_DIGITS.indexOf(char)
    if (digit >= 0) return { key: char, code: `Digit${digit}`, text: ctrl ? '' : char, shift: true, ctrl }
    for (const [code, plain, shifted] of PUNCTUATION) {
      if (char === plain || char === shifted) return { key: char, code, text: ctrl ? '' : char, shift: char === shifted, ctrl }
    }
  }
  return { key: char, code: '', text: ctrl ? '' : char, shift: false, ctrl }
}

/** The keys that type nothing: their names are their `key` and their `code` alike. */
export type NamedKey = 'Enter' | 'Backspace' | 'Delete' | 'Tab' | 'Escape' | 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End'

export function strokeOf(key: NamedKey, shift = false, ctrl = false): KeyStroke {
  return { key, code: key, text: '', shift, ctrl }
}

/** The setter a browser's own typing ends in: the nearest `value` setter up the prototype chain, past any the page hung on the element itself. */
function nativeValueSetter(el: object): ((this: unknown, v: string) => void) | null {
  for (let p: object | null = Object.getPrototypeOf(el); p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, 'value')
    if (d?.set) return d.set as (this: unknown, v: string) => void
  }
  return null
}

function writeValue(el: FieldLike, value: string): void {
  const set = nativeValueSetter(el)
  if (set) set.call(el, value)
  else el.value = value
}

/** The field's selection as [start, end]; a field that keeps none (an email or a number input) has its caret at the end. */
function selectionOf(el: FieldLike): [number, number] {
  const n = el.value.length
  let a: number | null = null, b: number | null = null
  try { a = el.selectionStart; b = el.selectionEnd } catch { /* a type without a selection throws in some browsers */ }
  if (typeof a !== 'number' || typeof b !== 'number') return [n, n]
  const s = Math.max(0, Math.min(n, a)), e = Math.max(0, Math.min(n, b))
  return s <= e ? [s, e] : [e, s]
}

/** Whether the field keeps a selection a script can read and set (an email field keeps none). */
function hasSelection(el: FieldLike): boolean {
  try { return typeof el.selectionStart === 'number' } catch { return false }
}

function placeCaret(el: FieldLike, env: EntryEnv, start: number, end: number = start): void {
  try {
    // Already there: no call (in WebKit setting a selection takes the focus into the field, off a key being scanned).
    if (el.selectionStart !== start || el.selectionEnd !== end) el.setSelectionRange?.(start, end)
  } catch { /* a type without a selection: the caret stays at the end */ }
  env.reveal?.(el)
}

type Segmenter = { segment(text: string): Iterable<{ index: number; segment: string }> }
let segmenter: Segmenter | null | undefined

/** The user-perceived characters of a text, where the runtime can tell them (Intl.Segmenter), else its code points. */
function clusterStarts(text: string): number[] {
  if (segmenter === undefined) {
    try {
      const S = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => Segmenter }).Segmenter
      segmenter = S ? new S(undefined, { granularity: 'grapheme' }) : null
    } catch { segmenter = null }
  }
  const out: number[] = []
  if (segmenter) { for (const s of segmenter.segment(text)) out.push(s.index) }
  else { let i = 0; for (const c of text) { out.push(i); i += c.length } }
  return out
}

/** Where the cluster before `at` begins (an emoji with its joiners, a letter with its accents, is one cluster). */
export function clusterBefore(text: string, at: number): number {
  if (at <= 0) return 0
  // Only the caret's own line matters, and a long buffer need not be segmented whole. The search starts two back so
  // a line break right before the caret is segmented with what precedes it (a CR LF pair is one cluster).
  const from = Math.max(0, text.lastIndexOf('\n', at - 2))
  const starts = clusterStarts(text.slice(from, at))
  return from + (starts.length ? starts[starts.length - 1] : 0)
}

/** Where the cluster at `at` ends. */
export function clusterAfter(text: string, at: number): number {
  if (at >= text.length) return text.length
  const next = text.indexOf('\n', at)
  const to = next < 0 ? text.length : next + 1
  const starts = clusterStarts(text.slice(at, to))
  return starts.length > 1 ? at + starts[1] : to
}

/** The caret one line up or down in a multi-line value, keeping its column where the line is long enough. */
export function caretByLine(text: string, at: number, down: boolean): number {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  const col = at - lineStart
  if (down) {
    const lineEnd = text.indexOf('\n', at)
    if (lineEnd < 0) return text.length
    const nextEnd = text.indexOf('\n', lineEnd + 1)
    return Math.min(lineEnd + 1 + col, nextEnd < 0 ? text.length : nextEnd)
  }
  if (lineStart === 0) return 0
  const prevStart = text.lastIndexOf('\n', lineStart - 2) + 1
  return Math.min(prevStart + col, lineStart - 1)
}

/** Replaces [start, end) with `text` and tells the page, as typing does; false when the page declined it or nothing changed. */
function edit(el: FieldLike, env: EntryEnv, start: number, end: number, text: string, inputType: string): boolean {
  if (start === end && text === '') return false
  if (!el.dispatchEvent(env.input('beforeinput', inputType, text || null))) return false
  // A handler of beforeinput may have changed the field: the edit is made on what it holds now.
  const now = el.value
  const s = Math.min(start, now.length), e = Math.min(end, now.length)
  const next = `${now.slice(0, s)}${text}${now.slice(e)}`
  if (next === now) return false
  writeValue(el, next)
  // A field that cleans what it is given (an email field drops a space) may have refused the edit: nothing was typed.
  if (el.value !== next) { writeValue(el, now); return false }
  placeCaret(el, env, s + text.length)
  el.dispatchEvent(env.input('input', inputType, text || null))
  return true
}

/** How much of `text` a field with a maxLength still takes over the selection [start, end) (whole clusters only). */
function fitted(el: FieldLike, start: number, end: number, text: string): string {
  const max = typeof el.maxLength === 'number' && el.maxLength >= 0 ? el.maxLength : -1
  if (max < 0) return text
  const room = max - (el.value.length - (end - start))
  if (room >= text.length) return text
  if (room <= 0) return ''
  let cut = 0
  for (const at of clusterStarts(text)) { if (at <= room) cut = at; else break }
  return text.slice(0, cut)
}

/**
 * Text put in at the caret, over the selection, as one edit (a paste, or a stroke's text): what fits the field's
 * maxLength, with the line breaks a one-line field cannot hold taken out. False when nothing went in.
 */
export function insertText(el: FieldLike, text: string, env: EntryEnv, inputType = 'insertText'): boolean {
  if (el.disabled || el.readOnly) return false
  const clean = el.tagName.toUpperCase() === 'TEXTAREA' ? text.replace(/\r\n?/g, '\n') : text.replace(/[\r\n]+/g, ' ')
  const [a, b] = selectionOf(el)
  const fit = fitted(el, a, b, clean)
  if (fit === '' && (clean !== '' || a === b)) return false
  return edit(el, env, a, b, fit, inputType)
}

/**
 * The cluster before the caret replaced by what `change` makes of it (a letter given its next accent). False when the
 * caret has none before it, a selection is open, or `change` has no other form for it.
 */
export function changeBefore(el: FieldLike, env: EntryEnv, change: (cluster: string) => string | null): boolean {
  if (el.disabled || el.readOnly) return false
  const [a, b] = selectionOf(el)
  if (a !== b || a === 0) return false
  const from = clusterBefore(el.value, a)
  const was = el.value.slice(from, a)
  const next = change(was)
  if (next === null || next === was || fitted(el, from, a, next) !== next) return false
  return edit(el, env, from, a, next, 'insertReplacementText')
}

/** A cluster that is deleted whole: an emoji and its joiners, a flag, a keycap. A letter gives up its last accent first, as a keyboard's Backspace has it. */
const WHOLE_CLUSTER = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u200d|\ufe0f|\u20e3/u

/** Where Backspace at `at` starts deleting: the whole cluster for an emoji, else one code point. */
function backspaceFrom(text: string, at: number): number {
  const from = clusterBefore(text, at)
  if (at - from <= 1 || WHOLE_CLUSTER.test(text.slice(from, at))) return from
  const low = text.charCodeAt(at - 1), high = text.charCodeAt(at - 2)
  return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? at - 2 : at - 1
}

/** What a stroke does by default, the page having left it alone. */
function defaultAction(el: FieldLike, stroke: KeyStroke, env: EntryEnv): StrokeResult {
  const multiline = el.tagName.toUpperCase() === 'TEXTAREA'
  const [a, b] = selectionOf(el)
  const v = el.value
  if (stroke.ctrl) {
    // The one chord with a default the keys can give: everything selected. Copy, cut and paste are the caller's (the clipboard is the page's).
    if ((stroke.key === 'a' || stroke.key === 'A') && hasSelection(el)) { placeCaret(el, env, 0, v.length); return 'typed' }
    return 'none'
  }
  const move = (to: number): StrokeResult => {
    if (!hasSelection(el)) return 'none'
    placeCaret(el, env, to)
    return 'typed'
  }
  switch (stroke.key) {
    case 'Backspace':
      return edit(el, env, a === b ? backspaceFrom(v, a) : a, b, '', 'deleteContentBackward') ? 'typed' : 'none'
    case 'Delete':
      return edit(el, env, a, a === b ? clusterAfter(v, b) : b, '', 'deleteContentForward') ? 'typed' : 'none'
    case 'Enter': {
      if (multiline) return insertText(el, '\n', env, 'insertLineBreak') ? 'typed' : 'none'
      // A keyboard's Enter presses the form's default button, and does nothing while that button is disabled.
      const form = el.form
      if (!form) return 'none'
      const button = form.querySelector?.('button:not([type]), button[type="submit" i], input[type="submit" i], input[type="image" i]')
      if (button) {
        if (button.disabled) return 'none'
        button.click()
        return 'submitted'
      }
      if (typeof form.requestSubmit !== 'function') return 'none'
      form.requestSubmit()
      return 'submitted'
    }
    case 'Tab':
      return 'tab'
    case 'ArrowLeft':
      return move(a === b ? clusterBefore(v, a) : a)
    case 'ArrowRight':
      return move(a === b ? clusterAfter(v, b) : b)
    case 'ArrowUp':
      return move(multiline ? caretByLine(v, a, false) : 0)
    case 'ArrowDown':
      return move(multiline ? caretByLine(v, b, true) : v.length)
    case 'Home':
      return move(multiline ? v.lastIndexOf('\n', a - 1) + 1 : 0)
    case 'End': {
      const end = multiline ? v.indexOf('\n', b) : -1
      return move(end < 0 ? v.length : end)
    }
    default:
      return stroke.text ? (insertText(el, stroke.text, env) ? 'typed' : 'none') : 'none'
  }
}

/** A stroke begun: what became of it, and the field its keyup belongs to. */
export interface StrokeDown {
  readonly result: StrokeResult
  /** The field the default action went to: the one the keydown was sent to, or the one the page moved the focus to. */
  readonly field: FieldLike
}

/**
 * The first half of a stroke: keydown (the page may take it), then the key's default if it did not. `repeat` marks a
 * held key's later strokes, as a keyboard's are marked. The default goes where a keyboard's would: nowhere when the
 * keydown's own handlers took the field off the page, and into the field the page moved the focus to when it moved
 * it (the console, open, pulls a key typed elsewhere to its prompt). A field that cannot be written (disabled,
 * read-only) still hears the key, as it would a keyboard's, but nothing is typed.
 */
export function strokeDown(el: FieldLike, stroke: KeyStroke, env: EntryEnv, repeat = false): StrokeDown {
  if (!el.dispatchEvent(env.key('keydown', stroke, repeat))) return { result: 'taken', field: el }
  if ((el as { isConnected?: boolean }).isConnected === false) return { result: 'none', field: el }
  const now = env.active?.() ?? null
  const field = now && now !== el && isTextField(now) ? now : el
  if (field.disabled || field.readOnly) return { result: 'none', field }
  return { result: defaultAction(field, stroke, env), field }
}

/** The second half: the key comes up. */
export function strokeUp(el: FieldLike, stroke: KeyStroke, env: EntryEnv): void {
  el.dispatchEvent(env.key('keyup', stroke, false))
}

/**
 * One whole stroke into a field: `strokeDown` now, `strokeUp` in a later task. Two strokes are never to be sent in one
 * task: a page that answers a keydown by redrawing its field (a prompt completing a word) has not redrawn it yet, and
 * the second stroke would edit what is about to be replaced. The caller sends one per task (ScreenKeys.tsx queues).
 */
export function typeStroke(el: FieldLike, stroke: KeyStroke, env: EntryEnv, repeat = false): StrokeResult {
  const down = strokeDown(el, stroke, env, repeat)
  env.later(() => strokeUp(down.field, stroke, env))
  return down.result
}

/** The part of a window the browser's environment uses. */
export interface EntryWindow {
  KeyboardEvent: typeof KeyboardEvent
  InputEvent: typeof InputEvent
  setTimeout(fn: () => void, ms: number): unknown
  document: { readonly activeElement: unknown; createElement(tag: 'canvas'): { getContext(kind: '2d'): { font: string; measureText(text: string): { width: number } } | null } }
  getComputedStyle(el: Element): { font: string; fontStyle: string; fontWeight: string; fontSize: string; fontFamily: string; paddingLeft: string; paddingRight: string; direction: string }
}

/**
 * The window's own events (KeyboardEvent, InputEvent), bubbling and cancelable as a keyboard's are, its tasks, its
 * focused field, and the scroll that shows a caret: a one-line field is scrolled so the text before the caret, as
 * the field's own font measures it, ends inside the field; a multi-line one follows its end.
 */
export function browserEntryEnv(win: EntryWindow = window as unknown as EntryWindow): EntryEnv {
  let ruler: { font: string; measureText(text: string): { width: number } } | null | undefined
  return {
    key: (type, s, repeat) => new win.KeyboardEvent(type, {
      key: s.key, code: s.code, shiftKey: s.shift === true, ctrlKey: s.ctrl === true, repeat, bubbles: true, cancelable: true, composed: true,
    }),
    input: (type, inputType, data) => new win.InputEvent(type, { inputType, data, bubbles: true, cancelable: type === 'beforeinput', composed: true }),
    later: (fn) => { win.setTimeout(fn, 0) },
    active: () => {
      const el = win.document.activeElement
      return isTextField(el) ? (el as FieldLike) : null
    },
    reveal: (field) => {
      try {
        const el = field as unknown as HTMLInputElement | HTMLTextAreaElement
        const at = el.selectionStart ?? el.value.length
        if (el.tagName === 'TEXTAREA') {
          if (at === el.value.length) el.scrollTop = el.scrollHeight
          return
        }
        if (ruler === undefined) ruler = win.document.createElement('canvas').getContext('2d')
        if (!ruler) return
        const cs = win.getComputedStyle(el)
        // Some browsers give no `font` shorthand for a computed style: it is put together from its parts.
        ruler.font = cs.font || `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
        const x = ruler.measureText(el.value.slice(0, at)).width
        const view = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
        // Right-to-left text scrolls the other way, from 0 down.
        const sign = cs.direction === 'rtl' ? -1 : 1
        const left = sign * el.scrollLeft
        if (x < left) el.scrollLeft = sign * x
        else if (x > left + view) el.scrollLeft = sign * (x - view + 2)
      } catch { /* a field that cannot be measured stays where it is */ }
    },
  }
}
