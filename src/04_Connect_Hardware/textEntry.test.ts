// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It types into a stand-in text field and reads what happened, to hold textEntry.ts to
 * what a keyboard does: the events in a keyboard's order (keydown, beforeinput, input, and the keyup in a later
 * task) with a keyboard's fields, a page handler that takes the keydown left alone with the key, the value written
 * through the prototype's setter and not one the page hung on the element (the way a framework that controls the
 * field hears of the change), Backspace taking a whole emoji but only the last accent of a letter, the arrows moving
 * by whole characters, Enter breaking a line in a multi-line field and pressing a one-line field's default button
 * (never a disabled one), a full field taking no more, a field that keeps no selection typed at its end, a field
 * that cleans what it is given left as it was, a field taken off the page or hidden getting nothing, a key the page
 * answered by moving the focus typed where the focus went, the caret scrolled into view, and a field that cannot be
 * written hearing the keys and changing nothing.
 * What breaks if it is removed? The on-screen keys could type a letter twice, split an emoji, write past a field's
 * limit, or write in a way the prompt never hears of, and only a person without a keyboard would find out.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  caretByLine, changeBefore, clusterAfter, clusterBefore, insertText, isCodeField, isLiveField, isTextField, strokeDown, strokeFor, strokeOf, strokeUp,
  typeStroke as typeStrokeLater,
  type EntryEnv, type FieldLike, type FormLike, type KeyStroke, type StrokeResult,
} from './textEntry.ts'

type Heard = { type: string; key?: string; code?: string; shift?: boolean; ctrl?: boolean; repeat?: boolean; inputType?: string; data?: string | null }

/** What the page was asked to do later, in order (the keyups), the fields scrolled to their carets, and the focused field. */
const later: (() => void)[] = []
const revealed: FieldLike[] = []
let focused: FieldLike | null = null

/** Events as a browser makes them, less the browser: a plain Event carrying the fields a handler reads. */
const env: EntryEnv = {
  key: (type, s, repeat) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { key: s.key, code: s.code, shiftKey: s.shift === true, ctrlKey: s.ctrl === true, repeat }),
  input: (type, inputType, data) => Object.assign(new Event(type, { bubbles: true, cancelable: type === 'beforeinput' }), { inputType, data }),
  later: (fn) => { later.push(fn) },
  active: () => focused,
  reveal: (el) => { revealed.push(el) },
}
/** The later tasks, run. */
const flush = (): void => { for (const fn of later.splice(0)) fn() }
/** One whole stroke, its keyup's task run: what a test that is not about the timing means by typing a key. */
function typeStroke(el: FieldLike, stroke: KeyStroke, e: EntryEnv, repeat = false): StrokeResult {
  const r = typeStrokeLater(el, stroke, e, repeat)
  flush()
  return r
}

/** A text field's value, selection and events, the value on the prototype as a browser's is. */
class Field extends EventTarget implements FieldLike {
  tagName: string
  type: string
  maxLength = -1
  readOnly = false
  disabled = false
  form: FormLike | null = null
  selectionStart: number | null = 0
  selectionEnd: number | null = 0
  heard: Heard[] = []
  isConnected = true
  /** How many times a script set the selection. */
  selections = 0
  #value = ''
  constructor(tagName = 'TEXTAREA', value = '', type = 'textarea') {
    super()
    this.tagName = tagName
    this.type = type
    this.#value = value
    this.selectionStart = this.selectionEnd = value.length
    for (const t of ['keydown', 'keyup', 'beforeinput', 'input']) {
      this.addEventListener(t, e => {
        const x = e as Event & { key?: string; code?: string; shiftKey?: boolean; ctrlKey?: boolean; repeat?: boolean; inputType?: string; data?: string | null }
        this.heard.push(t.startsWith('key')
          ? { type: t, key: x.key, code: x.code, shift: x.shiftKey, ctrl: x.ctrlKey, repeat: x.repeat }
          : { type: t, inputType: x.inputType, data: x.data })
      })
    }
  }
  get value(): string { return this.#value }
  /** A browser puts the caret at the end when a script sets the value. */
  set value(v: string) {
    this.#value = v
    if (this.selectionStart !== null) this.selectionStart = this.selectionEnd = v.length
  }
  setSelectionRange(start: number, end: number): void {
    if (this.selectionStart === null) throw new Error('InvalidStateError: this type keeps no selection')
    this.selections++
    this.selectionStart = start
    this.selectionEnd = end
  }
  caret(at: number, to = at): this { this.selectionStart = at; this.selectionEnd = to; return this }
  types(): string[] { return this.heard.map(h => h.type) }
}

const type = (f: Field, text: string): void => { for (const c of text) typeStroke(f, strokeFor(c), env) }

test('a character has a keyboard\'s key, code and Shift', () => {
  assert.deepEqual(strokeFor('a'), { key: 'a', code: 'KeyA', text: 'a', shift: false, ctrl: false })
  assert.deepEqual(strokeFor('Q'), { key: 'Q', code: 'KeyQ', text: 'Q', shift: true, ctrl: false })
  assert.deepEqual(strokeFor('7'), { key: '7', code: 'Digit7', text: '7', shift: false, ctrl: false })
  assert.deepEqual(strokeFor('&'), { key: '&', code: 'Digit7', text: '&', shift: true, ctrl: false })
  assert.deepEqual(strokeFor(')'), { key: ')', code: 'Digit0', text: ')', shift: true, ctrl: false })
  assert.deepEqual(strokeFor(' '), { key: ' ', code: 'Space', text: ' ', shift: false, ctrl: false })
  assert.deepEqual(strokeFor('`'), { key: '`', code: 'Backquote', text: '`', shift: false, ctrl: false })
  assert.deepEqual(strokeFor('~'), { key: '~', code: 'Backquote', text: '~', shift: true, ctrl: false })
  assert.deepEqual(strokeFor('|'), { key: '|', code: 'Backslash', text: '|', shift: true, ctrl: false })
  assert.deepEqual(strokeFor('?'), { key: '?', code: 'Slash', text: '?', shift: true, ctrl: false })
  // A character no US key carries still types; it has no place on the board to report.
  assert.deepEqual(strokeFor('é'), { key: 'é', code: '', text: 'é', shift: false, ctrl: false })
  // A chord types nothing by itself.
  assert.deepEqual(strokeFor('c', true), { key: 'c', code: 'KeyC', text: '', shift: false, ctrl: true })
  assert.deepEqual(strokeOf('Enter', true), { key: 'Enter', code: 'Enter', text: '', shift: true, ctrl: false })
})

test('every printable ASCII character has a code on the board', () => {
  for (let c = 0x20; c < 0x7f; c++) assert.notEqual(strokeFor(String.fromCharCode(c)).code, '', String.fromCharCode(c))
})

test('a stroke is heard as a keyboard\'s: keydown, beforeinput, input, and the keyup in a later task', () => {
  const f = new Field()
  assert.equal(typeStrokeLater(f, strokeFor('H'), env), 'typed')
  assert.equal(f.value, 'H')
  assert.deepEqual(f.types(), ['keydown', 'beforeinput', 'input'], 'the key is not up yet: a page that redraws its field on keydown reads it true on keyup')
  assert.equal(later.length, 1)
  flush()
  assert.deepEqual(f.heard, [
    { type: 'keydown', key: 'H', code: 'KeyH', shift: true, ctrl: false, repeat: false },
    { type: 'beforeinput', inputType: 'insertText', data: 'H' },
    { type: 'input', inputType: 'insertText', data: 'H' },
    { type: 'keyup', key: 'H', code: 'KeyH', shift: true, ctrl: false, repeat: false },
  ])
  f.heard.length = 0
  typeStroke(f, strokeFor('i'), env, true)
  assert.equal(f.heard[0].repeat, true, 'a held key\'s later strokes are marked')
  assert.equal(f.heard[f.heard.length - 1].repeat, false, 'the keyup is not')
})

test('text goes in at the caret and over a selection; the caret follows it', () => {
  const f = new Field('TEXTAREA', 'hello world')
  f.caret(5)
  type(f, ',')
  assert.equal(f.value, 'hello, world')
  assert.deepEqual([f.selectionStart, f.selectionEnd], [6, 6])
  f.caret(7, 12)
  type(f, 'you')
  assert.equal(f.value, 'hello, you')
  assert.deepEqual([f.selectionStart, f.selectionEnd], [10, 10])
})

test('a page handler that takes the keydown keeps the key', () => {
  const f = new Field('TEXTAREA', 'help')
  let submitted = ''
  f.addEventListener('keydown', e => {
    if ((e as Event & { key: string }).key === 'Enter') { e.preventDefault(); submitted = f.value }
  })
  assert.equal(typeStroke(f, strokeOf('Enter'), env), 'taken')
  assert.equal(submitted, 'help')
  assert.equal(f.value, 'help', 'no line break was typed behind the handler\'s back')
  assert.deepEqual(f.types(), ['keydown', 'keyup'])
})

test('a page that declines the beforeinput keeps its field', () => {
  const f = new Field('INPUT', 'abc', 'text')
  f.addEventListener('beforeinput', e => e.preventDefault())
  assert.equal(typeStroke(f, strokeFor('d'), env), 'none')
  assert.equal(typeStroke(f, strokeOf('Backspace'), env), 'none')
  assert.equal(f.value, 'abc')
  assert.ok(!f.types().includes('input'))
})

test('an edit is made on what the field holds after its beforeinput handlers ran', () => {
  const f = new Field('INPUT', 'abcdef', 'text')
  f.addEventListener('beforeinput', () => { if (f.value.length > 2) f.value = 'ab' }, { once: true })
  typeStroke(f, strokeFor('x'), env)
  assert.equal(f.value, 'abx', 'never an index past the end of the new value')
})

test('the value is written through the prototype\'s setter, past one the page hung on the element', () => {
  const f = new Field('INPUT', '', 'text')
  let own = 0
  const proto = Object.getOwnPropertyDescriptor(Field.prototype, 'value')!
  // What a framework that controls a field does to follow its value: an own property over the prototype's.
  Object.defineProperty(f, 'value', { configurable: true, get: () => proto.get!.call(f), set: (v: string) => { own++; proto.set!.call(f, v) } })
  type(f, 'ok')
  assert.equal(f.value, 'ok')
  assert.equal(own, 0, 'the tracker was not told, so it sees a change when the input event arrives')
})

test('Backspace and Delete take whole characters, or the selection', () => {
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}'
  const f = new Field('TEXTAREA', `aé${family}`)
  assert.equal(typeStroke(f, strokeOf('Backspace'), env), 'typed')
  assert.equal(f.value, 'aé', 'the family is one character, not seven code units')
  assert.deepEqual(f.heard.filter(h => h.type === 'input'), [{ type: 'input', inputType: 'deleteContentBackward', data: null }])
  typeStroke(f, strokeOf('Backspace'), env)
  assert.equal(f.value, 'ae', 'a letter gives up its accent first, as a keyboard\'s Backspace has it')
  typeStroke(f, strokeOf('Backspace'), env)
  typeStroke(f, strokeOf('Backspace'), env)
  assert.equal(f.value, '')
  assert.equal(typeStroke(f, strokeOf('Backspace'), env), 'none', 'nothing before the caret: nothing to tell the page')
  // Whole: a flag, a keycap, an emoji with a skin tone, a lone astral character. One code point: a conjunct's last sign.
  for (const [text, left] of [['x\u{1F1E8}\u{1F1E6}', 'x'], ['x7\ufe0f\u20e3', 'x'], ['x\u{1F44D}\u{1F3FD}', 'x'], ['x\u{1F600}', 'x'], ['x\u{1D11E}', 'x'], ['\u0915\u094d\u0937\u093f', '\u0915\u094d\u0937']] as const) {
    const g = new Field('INPUT', text, 'text')
    typeStroke(g, strokeOf('Backspace'), env)
    assert.equal(g.value, left, JSON.stringify(text))
  }

  const g = new Field('INPUT', `x${family}y`, 'text').caret(1)
  typeStroke(g, strokeOf('Delete'), env)
  assert.equal(g.value, 'xy')
  assert.deepEqual([g.selectionStart, g.selectionEnd], [1, 1])
  assert.equal(g.heard.find(h => h.type === 'input')?.inputType, 'deleteContentForward')
  g.caret(0, 2)
  typeStroke(g, strokeOf('Backspace'), env)
  assert.equal(g.value, '')
  assert.equal(typeStroke(new Field('INPUT', 'end', 'text'), strokeOf('Delete'), env), 'none')
})

test('the arrows, Home and End move the caret and tell the page nothing was typed', () => {
  const f = new Field('INPUT', 'a\u{1F600}b', 'text')
  typeStroke(f, strokeOf('ArrowLeft'), env)
  assert.equal(f.selectionStart, 3)
  typeStroke(f, strokeOf('ArrowLeft'), env)
  assert.equal(f.selectionStart, 1, 'over the emoji in one step')
  typeStroke(f, strokeOf('ArrowRight'), env)
  assert.equal(f.selectionStart, 3)
  typeStroke(f, strokeOf('Home'), env)
  assert.equal(f.selectionStart, 0)
  typeStroke(f, strokeOf('End'), env)
  assert.equal(f.selectionStart, 4)
  // In a one-line field up is the start and down the end, as a browser has it.
  typeStroke(f, strokeOf('ArrowUp'), env)
  assert.equal(f.selectionStart, 0)
  typeStroke(f, strokeOf('ArrowDown'), env)
  assert.equal(f.selectionStart, 4)
  assert.ok(!f.types().includes('input') && !f.types().includes('beforeinput'))
  // A selection collapses to the side the arrow points at.
  f.caret(1, 3)
  typeStroke(f, strokeOf('ArrowLeft'), env)
  assert.deepEqual([f.selectionStart, f.selectionEnd], [1, 1])
  f.caret(1, 3)
  typeStroke(f, strokeOf('ArrowRight'), env)
  assert.deepEqual([f.selectionStart, f.selectionEnd], [3, 3])
})

test('up and down keep the column across lines of a multi-line field', () => {
  const text = 'first line\nab\nthird line'
  assert.equal(caretByLine(text, 7, true), 13, 'a shorter line takes the caret at its end')
  assert.equal(caretByLine(text, 12, true), 15)
  assert.equal(caretByLine(text, 18, false), 13)
  assert.equal(caretByLine(text, 12, false), 1)
  assert.equal(caretByLine(text, 4, false), 0, 'up from the first line is the start')
  assert.equal(caretByLine(text, 16, true), text.length, 'down from the last line is the end')
  const f = new Field('TEXTAREA', text).caret(12)
  typeStroke(f, strokeOf('Home'), env)
  assert.equal(f.selectionStart, 11)
  typeStroke(f, strokeOf('End'), env)
  assert.equal(f.selectionStart, 13)
  typeStroke(f, strokeOf('ArrowUp'), env)
  assert.equal(f.selectionStart, 2)
})

test('Enter breaks a line in a multi-line field and submits a one-line field\'s form', () => {
  const area = new Field('TEXTAREA', 'ab').caret(1)
  assert.equal(typeStroke(area, strokeOf('Enter'), env), 'typed')
  assert.equal(area.value, 'a\nb')
  assert.equal(area.heard.find(h => h.type === 'input')?.inputType, 'insertLineBreak')

  const line = new Field('INPUT', 'name', 'text')
  let asked = 0, clicked = 0
  // A form with no button: the form itself is asked.
  line.form = { requestSubmit: () => { asked++ }, querySelector: () => null }
  assert.equal(typeStroke(line, strokeOf('Enter'), env), 'submitted')
  assert.equal(asked, 1)
  assert.equal(line.value, 'name')
  // A form with a default button: Enter presses it, as a keyboard's does, and does nothing while it is disabled.
  const button = { disabled: false, click: () => { clicked++ } }
  let query = ''
  line.form = { requestSubmit: () => { asked++ }, querySelector: (q: string) => { query = q; return button } }
  assert.equal(typeStroke(line, strokeOf('Enter'), env), 'submitted')
  assert.deepEqual([asked, clicked], [1, 1], 'the button was pressed, the form was not submitted behind it')
  assert.match(query, /button:not\(\[type\]\)/, 'the default button: a submit button, or one with no type')
  button.disabled = true
  assert.equal(typeStroke(line, strokeOf('Enter'), env), 'none', 'a reply still being sent is not sent twice')
  assert.deepEqual([asked, clicked], [1, 1])
  line.form = {}
  assert.equal(typeStroke(line, strokeOf('Enter'), env), 'none', 'a form that cannot be asked')
  line.form = null
  assert.equal(typeStroke(line, strokeOf('Enter'), env), 'none', 'a field with no form: Enter is only heard')
  assert.equal(typeStroke(line, strokeOf('Tab'), env), 'tab', 'the caller moves the focus')
  assert.equal(typeStroke(line, strokeOf('Escape'), env), 'none')
})

test('a full field takes no more, and never half a character', () => {
  const f = new Field('INPUT', 'abc', 'text')
  f.maxLength = 4
  type(f, 'de')
  assert.equal(f.value, 'abcd')
  assert.equal(typeStroke(f, strokeFor('z'), env), 'none')
  assert.equal(insertText(f, '\u{1F600}', env), false)
  // A selection makes room.
  f.caret(0, 4)
  assert.equal(insertText(f, 'pasted text', env, 'insertFromPaste'), true)
  assert.equal(f.value, 'past')
  const g = new Field('INPUT', 'ab', 'text')
  g.maxLength = 3
  assert.equal(insertText(g, '\u{1F600}', env), false, 'two code units do not fit one unit of room')
  assert.equal(g.value, 'ab')
})

test('pasted text keeps its line breaks only where the field has lines', () => {
  const line = new Field('INPUT', '', 'text')
  insertText(line, 'one\r\ntwo\nthree', env, 'insertFromPaste')
  assert.equal(line.value, 'one two three')
  assert.equal(line.heard.find(h => h.type === 'input')?.inputType, 'insertFromPaste')
  const area = new Field()
  insertText(area, 'one\r\ntwo\rthree', env, 'insertFromPaste')
  assert.equal(area.value, 'one\ntwo\nthree')
  assert.equal(insertText(area, '', env), false)
})

test('a field that keeps no selection is typed at its end', () => {
  const f = new Field('INPUT', 'a@b', 'email')
  f.selectionStart = f.selectionEnd = null
  type(f, '.c')
  assert.equal(f.value, 'a@b.c')
  typeStroke(f, strokeOf('Backspace'), env)
  assert.equal(f.value, 'a@b.')
  for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'] as const) assert.equal(typeStroke(f, strokeOf(k), env), 'none', `${k}: the caret cannot move there, and nothing throws or claims it did`)
  assert.equal(typeStroke(f, strokeFor('a', true), env), 'none')
})

test('a field that cleans what it is given is left as it was when it refuses an edit', () => {
  // An email field drops a space it is handed: the write does not stick.
  class Email extends Field {
    override get value(): string { return super.value }
    override set value(v: string) { super.value = v.replace(/\s/g, '') }
  }
  const f = new Email('INPUT', 'a@b', 'email')
  assert.equal(typeStroke(f, strokeFor(' '), env), 'none')
  assert.equal(f.value, 'a@b')
  assert.ok(!f.types().includes('input'), 'the page is not told of a change that did not happen')
  assert.equal(typeStroke(f, strokeFor('c'), env), 'typed')
  assert.equal(f.value, 'a@bc')
})

test('a field taken off the page, hidden or made inert gets nothing', () => {
  const f = new Field('TEXTAREA', 'ls')
  // The key's own handler closes what the field stands in.
  f.addEventListener('keydown', () => { f.isConnected = false }, { once: true })
  assert.equal(typeStroke(f, strokeFor('x'), env), 'none')
  assert.equal(f.value, 'ls')
  assert.deepEqual(f.types(), ['keydown', 'keyup'])
  const el = (over: object) => ({ tagName: 'TEXTAREA', isConnected: true, closest: () => null, checkVisibility: () => true, ...over })
  assert.equal(isLiveField(el({})), true)
  assert.equal(isLiveField(el({ isConnected: false })), false)
  assert.equal(isLiveField(el({ closest: (q: string) => q === '[inert]' ? {} : null })), false, 'a closed console\'s prompt is inert')
  let asked: object | undefined
  assert.equal(isLiveField(el({ checkVisibility: (o?: object) => { asked = o; return false } })), false, 'and hidden')
  assert.deepEqual(asked, { visibilityProperty: true }, 'opacity is not asked about: the prompt is see-through by design')
  assert.equal(isLiveField({ tagName: 'INPUT', type: 'text' }), true, 'a stand-in with none of the three is taken at its word')
  assert.equal(isLiveField(el({ tagName: 'BUTTON' })), false)
  assert.equal(isLiveField(el({ readOnly: true })), false)
})

test('a key the page answered by moving the focus is typed where the focus went, and comes up there', () => {
  const chat = new Field('INPUT', '', 'text'), prompt = new Field('TEXTAREA', '')
  chat.addEventListener('keydown', () => { focused = prompt })
  const down = strokeDown(chat, strokeFor('a'), env)
  assert.deepEqual([down.result, down.field === prompt], ['typed', true])
  assert.deepEqual([chat.value, prompt.value], ['', 'a'], 'as a keyboard\'s key would land')
  strokeUp(down.field, strokeFor('a'), env)
  assert.deepEqual(prompt.types(), ['beforeinput', 'input', 'keyup'])
  assert.deepEqual(chat.types(), ['keydown'])
  // The whole stroke sends the keyup to the same place.
  typeStroke(chat, strokeFor('b'), env)
  assert.equal(prompt.value, 'ab')
  assert.equal(prompt.types().at(-1), 'keyup')
  // Focus on something that is not a field (null), or on the field itself, changes nothing.
  focused = null
  const other = new Field('INPUT', '', 'text')
  assert.equal(strokeDown(other, strokeFor('c'), env).field, other)
  focused = other
  assert.equal(strokeDown(other, strokeFor('d'), env).field, other)
  assert.equal(other.value, 'cd')
  // A focused field that cannot be written is not one to type in: the key stays where it was sent.
  const locked = new Field('INPUT', 'keep', 'text')
  locked.readOnly = true
  focused = locked
  assert.equal(strokeDown(other, strokeFor('e'), env).result, 'typed')
  assert.equal(other.value, 'cde')
  assert.equal(locked.value, 'keep')
  focused = null
})

test('the caret is scrolled into view after every edit and move, and a selection already in place is not set again', () => {
  const f = new Field('INPUT', 'abc', 'text')
  revealed.length = 0
  typeStroke(f, strokeFor('d'), env)
  assert.deepEqual(revealed, [f], 'after typing')
  assert.equal(f.selections, 0, 'a write leaves the caret at the end already: no call that could move the focus')
  typeStroke(f, strokeOf('ArrowLeft'), env)
  assert.equal(revealed.length, 2, 'after a move')
  assert.equal(f.selections, 1)
  typeStroke(f, strokeOf('Home'), env)
  typeStroke(f, strokeOf('Home'), env)
  assert.equal(f.selections, 2, 'already at the start: not set again')
  typeStroke(f, strokeFor('x'), env)
  assert.equal(f.value, 'xabcd')
  assert.equal(f.selections, 3, 'typed in the middle: the caret is put after the letter')
  assert.deepEqual([f.selectionStart, f.selectionEnd], [1, 1])
})

test('a field that cannot be written hears the keys and changes nothing', () => {
  for (const lock of ['readOnly', 'disabled'] as const) {
    const f = new Field('TEXTAREA', 'copy me')
    f[lock] = true
    assert.equal(typeStroke(f, strokeFor('x'), env), 'none')
    assert.equal(typeStroke(f, strokeOf('Backspace'), env), 'none')
    assert.equal(insertText(f, 'x', env), false)
    assert.equal(changeBefore(f, env, () => 'x'), false)
    assert.equal(f.value, 'copy me')
    assert.deepEqual(f.types(), ['keydown', 'keyup', 'keydown', 'keyup'])
  }
})

test('Ctrl+A selects everything; the other chords are left to the page', () => {
  const f = new Field('TEXTAREA', 'all of it').caret(3)
  assert.equal(typeStroke(f, strokeFor('a', true), env), 'typed')
  assert.deepEqual([f.selectionStart, f.selectionEnd], [0, 9])
  assert.equal(typeStroke(f, strokeFor('c', true), env), 'none')
  assert.equal(f.value, 'all of it')
  assert.equal(f.heard[0].ctrl, true)
})

test('the character before the caret can be changed in place', () => {
  const next = (c: string): string | null => c === 'e' ? 'é' : null
  const f = new Field('INPUT', 'caffe!', 'text').caret(5)
  assert.equal(changeBefore(f, env, next), true)
  assert.equal(f.value, 'caffé!')
  assert.deepEqual([f.selectionStart, f.selectionEnd], [5, 5], 'the caret stays behind the letter')
  assert.deepEqual(f.heard.at(-1), { type: 'input', inputType: 'insertReplacementText', data: 'é' })
  assert.equal(changeBefore(f, env, next), false, 'a letter with no other form is left')
  assert.equal(changeBefore(f.caret(0), env, next), false, 'nothing before the caret')
  assert.equal(changeBefore(f.caret(1, 3), env, next), false, 'not over a selection')
  const full = new Field('INPUT', 'gros', 'text')
  full.maxLength = 4
  assert.equal(changeBefore(full, env, () => 'ss'), false, 'a longer form does not fit a full field')
  assert.equal(full.value, 'gros')
  assert.equal(changeBefore(full, env, () => '\u00df'), true)
  assert.equal(full.value, 'gro\u00df')
})

test('characters are counted as a reader sees them', () => {
  const flag = '\u{1F1E8}\u{1F1E6}'
  assert.equal(clusterBefore(`a${flag}`, 5), 1)
  assert.equal(clusterAfter(`${flag}b`, 0), 4)
  assert.equal(clusterBefore('abc', 0), 0)
  assert.equal(clusterAfter('abc', 3), 3)
  assert.equal(clusterBefore('a\nb', 2), 1, 'a line break is a character to step over')
  assert.equal(clusterAfter('a\nb', 1), 2)
  assert.equal(clusterBefore('x\r\ny', 3), 1, 'and a CR LF pair is one')
})

test('which elements are fields to type in, and which of them are for commands', () => {
  assert.equal(isTextField({ tagName: 'TEXTAREA' }), true)
  assert.equal(isTextField({ tagName: 'INPUT', type: 'text' }), true)
  assert.equal(isTextField({ tagName: 'input', type: 'Search' }), true)
  assert.equal(isTextField({ tagName: 'INPUT', type: '' }), true)
  assert.equal(isTextField({ tagName: 'INPUT', type: 'checkbox' }), false)
  assert.equal(isTextField({ tagName: 'INPUT', type: 'range' }), false)
  assert.equal(isTextField({ tagName: 'INPUT', type: 'file' }), false)
  assert.equal(isTextField({ tagName: 'TEXTAREA', readOnly: true }), false)
  assert.equal(isTextField({ tagName: 'INPUT', type: 'text', disabled: true }), false)
  assert.equal(isTextField({ tagName: 'DIV', isContentEditable: true }), false, 'an editable region has no value to write')
  assert.equal(isTextField({ tagName: 'INPUT', type: 'number' }), false, 'a number field keeps the device\'s keyboard')
  assert.equal(isTextField({ tagName: 'INPUT', type: 'email' }), true)
  assert.equal(isTextField({ tagName: 'INPUT', type: 'password' }), true)
  assert.equal(isTextField({ tagName: 'BUTTON' }), false)
  assert.equal(isTextField(null), false)
  const attrs = (a: Record<string, string>) => ({ getAttribute: (n: string) => a[n] ?? null })
  assert.equal(isCodeField(attrs({ autocapitalize: 'off', spellcheck: 'false' })), true)
  assert.equal(isCodeField(attrs({ autocapitalize: 'none', spellcheck: 'false' })), true)
  assert.equal(isCodeField(attrs({ autocapitalize: 'words', spellcheck: 'false' })), false, 'a name is prose')
  assert.equal(isCodeField(attrs({ spellcheck: 'false' })), false)
  assert.equal(isCodeField(attrs({})), false)
  assert.equal(isCodeField(null), false)
})

test('a keyboard\'s stroke shape is what the page gets', () => {
  const s: KeyStroke = strokeFor('A', false)
  assert.equal(s.shift, true)
  const f = new Field()
  typeStroke(f, s, env)
  assert.equal(f.heard[0].shift, true)
})
