// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It runs the on-screen keys' mind (keysDesk.ts) against stand-in fields, clocks and pads,
 * and holds it to the rules a player would notice: the keys open when asked for and are only offered when a card took
 * the focus by itself; a phone's prompt gets them at a tap and a chat line keeps the phone's keyboard; a real key
 * typed puts them away; one stroke goes per task; a field taken away gets nothing; a card swapping one field for
 * another keeps them open; a held Backspace repeats and comes up once; the device's own keyboard is kept down only
 * while ours serve the field and is handed the field when asked; an OK card folds them; the pads are lent only while
 * they stand open; and the pad's buttons type, shift, change layer and put them away.
 * What breaks if it is removed? A change to when the keys show, or to where their strokes go, would reach a player
 * holding a pad or a phone before anything noticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DESK, KeysDesk, type DeskEnv, type DeskHands, type SenseLike } from './keysDesk.ts'
import { keysServe, type KeysFacts, type KeysSetting, type LastDevice } from './keyboardSense.ts'
import type { EntryEnv, FieldLike, FormLike } from './textEntry.ts'

/** A clock and its timers, run by hand. */
class Clock {
  now = 1000
  private timers: { at: number; fn: () => void; id: number }[] = []
  private seq = 0
  timer = (fn: () => void, ms: number): (() => void) => {
    const id = ++this.seq
    this.timers.push({ at: this.now + ms, fn, id })
    return () => { this.timers = this.timers.filter((t) => t.id !== id) }
  }
  /** Moves the clock on, running each timer due, in order (a timer that sets another due within the span runs it too). */
  advance(ms = 0): void {
    const end = this.now + ms
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id)
      const t = this.timers[0]
      if (!t || t.at > end) break
      this.timers.shift()
      this.now = Math.max(this.now, t.at)
      t.fn()
    }
    this.now = end
  }
}

/** A text field: its value, selection, attributes, liveness and the keys it heard. */
class Field extends EventTarget implements FieldLike {
  tagName: string
  type: string
  maxLength = -1
  readOnly = false
  disabled = false
  form: FormLike | null = null
  selectionStart: number | null = 0
  selectionEnd: number | null = 0
  isConnected = true
  shown = true
  inert = false
  attrs = new Map<string, string>()
  keys: string[] = []
  value = ''
  constructor(attrs: Record<string, string> = {}, tagName = 'INPUT', type = 'text') {
    super()
    this.tagName = tagName
    this.type = type
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v)
    this.addEventListener('keydown', (e) => { this.keys.push(`down:${(e as Event & { key: string }).key}${(e as Event & { repeat?: boolean }).repeat ? '*' : ''}`) })
    this.addEventListener('keyup', (e) => { this.keys.push(`up:${(e as Event & { key: string }).key}`) })
  }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null }
  setSelectionRange(a: number, b: number): void { this.selectionStart = a; this.selectionEnd = b }
  closest(sel: string): object | null { return sel.includes('inert') && this.inert ? {} : null }
  checkVisibility(): boolean { return this.shown }
}

/** The console's prompt: the writing aids off. */
const prompt = (): Field => new Field({ autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'go' }, 'TEXTAREA', 'textarea')
/** One of the on-screen keys (inside their root). */
const KEY_EL = { closest: (sel: string) => (sel.includes('data-screen-keys') ? {} : null) }
const PAGE_BUTTON = { closest: () => null }
/** A line of the console, beside its prompt. */
const AROUND = { closest: () => null }

interface Rig {
  clock: Clock
  desk: KeysDesk
  sense: { last: LastDevice | null; pointerAt: number; touchFirst: boolean; keyboardLately: boolean }
  marks: Map<FieldLike, boolean>
  lends: boolean[]
  said: string[]
  shown: FieldLike[]
  focus: { el: unknown }
  consoles: number
  clip: { text: string; reads: number }
  fields: Field[]
  scopes: Map<FieldLike, unknown>
}

function rig(opts: { touchFirst?: boolean; hands?: Partial<DeskHands>; console?: Field | null } = {}): Rig {
  const clock = new Clock()
  const marks = new Map<FieldLike, boolean>()
  const lends: boolean[] = []
  const said: string[] = []
  const shown: FieldLike[] = []
  const focus = { el: null as unknown }
  const fields: Field[] = []
  const scopes = new Map<FieldLike, unknown>()
  const clip = { text: 'pasted', reads: 0 }
  const s = { last: null as LastDevice | null, pointerAt: -Infinity, touchFirst: opts.touchFirst === true, keyboardLately: false }
  const sense: SenseLike = {
    get last() { return s.last },
    get pointerAt() { return s.pointerAt },
    facts: (setting: KeysSetting, codeField: boolean, hands: { scan?: boolean; dwell?: boolean }): KeysFacts =>
      ({ setting, last: s.last, keyboardLately: s.keyboardLately, touchFirst: s.touchFirst, codeField, scan: hands.scan === true, dwell: hands.dwell === true }),
  }
  const entry: EntryEnv = {
    key: (type, st, repeat) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { key: st.key, code: st.code, shiftKey: st.shift === true, ctrlKey: st.ctrl === true, repeat }),
    input: (type, inputType, data) => Object.assign(new Event(type, { bubbles: true, cancelable: type === 'beforeinput' }), { inputType, data }),
    later: (fn) => { clock.timer(fn, 0) },
    active: () => null,
  }
  const r: Rig = { clock, desk: null as unknown as KeysDesk, sense: s, marks, lends, said, shown, focus, consoles: 0, clip, fields, scopes }
  const env: DeskEnv = {
    entry,
    now: () => clock.now,
    timer: clock.timer,
    active: () => focus.el,
    scopeOf: (f) => scopes.get(f) ?? 'card',
    nextField: (f, back) => {
      const i = fields.indexOf(f as Field)
      return i < 0 ? null : fields[i + (back ? -1 : 1)] ?? null
    },
    firstField: () => fields[0] ?? null,
    focus: (f) => { focus.el = f; r.desk.focusIn(f) },
    hovered: () => false,
    around: (_f, target) => target === AROUND,
    mark: (f, on) => { marks.set(f, on) },
    showSystem: (f) => { shown.push(f) },
    lend: (on) => { lends.push(on) },
    openConsole: () => {
      if (opts.console === undefined) return false
      r.consoles++
      return true
    },
    readClip: () => { clip.reads++; return Promise.resolve(clip.text) },
    writeClip: (t) => { clip.text = t; return Promise.resolve() },
    say: (t) => { said.push(t) },
  }
  r.desk = new KeysDesk(env, sense)
  r.desk.setHands({ setting: 'auto', scan: false, dwell: false, system: opts.touchFirst === true, ...opts.hands })
  return r
}

/** Focuses a field as the page would, after `pointer` (a press on the page) when given. */
test('a real key typed puts away keys a pad asked for; the pad asks again', () => {
  const r = rig()
  r.sense.last = 'gamepad'
  const p = prompt()
  focusOn(r, p)
  r.desk.summon()
  assert.equal(r.desk.get().mode, 'open')
  r.sense.last = 'keyboard'
  r.sense.keyboardLately = true
  r.desk.deviceChanged()
  assert.equal(r.desk.get().mode, 'hidden', 'asked for or not, a keyboard under the hands puts them away')
  r.sense.last = 'gamepad'
  r.desk.deviceChanged()
  assert.equal(r.desk.get().mode, 'peek', 'a pad button only offers them again')
  r.desk.summon()
  assert.equal(r.desk.get().mode, 'open', 'select asks again')
})

function focusOn(r: Rig, f: Field, pointer = false): void {
  if (pointer) r.sense.pointerAt = r.clock.now
  r.focus.el = f
  r.desk.focusIn(f)
}

test('a pad player: a card that takes the focus by itself gets the chip; asked for, the keys open and borrow the pads', () => {
  const r = rig()
  r.sense.last = 'gamepad'
  const f = new Field()
  focusOn(r, f)
  assert.equal(r.desk.get().mode, 'peek', 'offered, not thrown over the screen')
  assert.deepEqual(r.lends, [], 'the pads stay the game\'s')
  assert.equal(r.marks.get(f), true, 'the device\'s keyboard is kept down meanwhile')
  r.desk.summon()
  assert.equal(r.desk.get().mode, 'open')
  assert.deepEqual(r.lends, [true])
  assert.equal(r.desk.get().at, 'g', 'the highlight starts in the middle of the letters')
  assert.equal(r.desk.get().pad, true)
  r.desk.padAsk({ control: 'press', repeat: false })
  assert.equal(f.value, 'g')
  r.desk.padAsk({ control: 'close', repeat: false })
  assert.equal(r.desk.get().mode, 'peek')
  assert.deepEqual(r.lends, [true, false], 'given back when they close')
  assert.equal(r.focus.el, f, 'closing never takes the caret from the field')
})

test('a phone: a tap on the console\'s prompt opens the keys; a chat line keeps the phone\'s own keyboard', () => {
  const r = rig({ touchFirst: true })
  r.sense.last = 'touch'
  const p = prompt()
  focusOn(r, p, true)
  assert.equal(r.desk.get().mode, 'open')
  assert.equal(r.marks.get(p), true)
  const chat = new Field({ enterkeyhint: 'send' })
  r.scopes.set(chat, 'sloane')
  r.clock.advance(5000)
  focusOn(r, chat, true)
  assert.equal(r.desk.get().mode, 'hidden')
  assert.equal(r.marks.get(p), false, 'the prompt\'s own attributes are given back')
  assert.equal(r.marks.has(chat), false, 'the chat line is never marked')
  // Focused by a card's own effect, with no tap: offered, not opened.
  r.clock.advance(5000)
  const q = prompt()
  r.scopes.set(q, 'other')
  focusOn(r, q)
  assert.equal(r.desk.get().mode, 'peek')
  r.desk.pointerDown(q)
  assert.equal(r.desk.get().mode, 'open', 'a tap on the field asks for them')
  r.desk.padAsk({ control: 'close', repeat: false })
  r.desk.pointerDown(AROUND, 'mouse')
  assert.equal(r.desk.get().mode, 'peek', 'a mouse beside the prompt asks nothing')
  r.desk.pointerDown(PAGE_BUTTON, 'touch')
  assert.equal(r.desk.get().mode, 'peek', 'a finger elsewhere on the page asks nothing')
  r.desk.pointerDown(AROUND, 'touch')
  assert.equal(r.desk.get().mode, 'open', 'a finger on the console\'s lines, beside the prompt, asks for them')
})

test('a real key typed puts the keys away and gives the field its attributes back', () => {
  const r = rig({ touchFirst: true })
  r.sense.last = 'touch'
  const p = prompt()
  focusOn(r, p, true)
  assert.equal(r.desk.get().mode, 'open')
  r.sense.last = 'keyboard'
  r.sense.keyboardLately = true
  r.desk.refresh()
  assert.equal(r.desk.get().mode, 'hidden')
  assert.equal(r.marks.get(p), false)
  assert.deepEqual(r.lends, [true, false])
})

test('one stroke per task: the first goes at once, the next after the page has had its turn', () => {
  const r = rig()
  r.sense.last = 'gamepad'
  const f = new Field()
  focusOn(r, f)
  r.desk.summon()
  r.desk.press('h')
  r.desk.press('i')
  assert.equal(f.value, 'h', 'the second waits')
  assert.deepEqual(f.keys, ['down:h'])
  r.clock.advance(0)
  assert.equal(f.value, 'hi')
  assert.deepEqual(f.keys, ['down:h', 'up:h', 'down:i', 'up:i'], 'each key comes up in a later task, in order')
})

test('a field taken off the page or hidden gets nothing, and the keys let it go', () => {
  const r = rig()
  r.sense.last = 'gamepad'
  const f = new Field()
  focusOn(r, f)
  r.desk.summon()
  f.isConnected = false
  r.desk.press('a')
  assert.equal(f.value, '')
  assert.equal(r.desk.get().mode, 'hidden')
  assert.deepEqual(r.lends, [true, false])
  const g = prompt()
  focusOn(r, g)
  r.desk.summon()
  g.inert = true
  r.desk.refresh()
  assert.equal(r.desk.get().mode, 'hidden', 'a console closed under the keys')
  assert.equal(r.marks.get(g), false)
})

test('a card that swaps one field for another keeps the keys open; a field in another card is only offered', () => {
  const r = rig()
  r.sense.last = 'gamepad'
  const goal = new Field()
  focusOn(r, goal)
  r.desk.summon()
  assert.equal(r.desk.get().mode, 'open')
  // The goal field goes, and the chat line the same card shows takes the focus a moment later.
  r.focus.el = null
  r.desk.focusOut(goal, null)
  r.clock.advance(DESK.graceMs + 10)
  assert.equal(r.desk.get().mode, 'hidden', 'the focus went nowhere: the keys let the field go')
  const chat = new Field()
  r.clock.advance(300)
  focusOn(r, chat)
  assert.equal(r.desk.get().mode, 'open', 'the same card, within a second: still open')
  // Straight from one field to another of another card: offered.
  const other = new Field()
  r.scopes.set(other, 'elsewhere')
  focusOn(r, other)
  assert.equal(r.desk.get().mode, 'peek')
  // A card's field focused long after the last one left: offered.
  r.desk.summon()
  r.focus.el = null
  r.desk.focusOut(other, null)
  r.clock.advance(DESK.stickyMs + 500)
  const late = new Field()
  r.scopes.set(late, 'elsewhere')
  focusOn(r, late)
  assert.equal(r.desk.get().mode, 'peek')
})

test('the focus on one of the keys keeps the field; a scanning player\'s round keeps it while it is shown', () => {
  const r = rig({ hands: { scan: true } })
  r.sense.last = 'mouse'
  const f = prompt()
  focusOn(r, f)
  assert.equal(r.desk.get().mode, 'peek', 'scan on: the keys serve the field')
  r.desk.switchOn(f)
  assert.equal(r.desk.get().mode, 'open', 'the switch pressed on the field asks for them')
  r.focus.el = KEY_EL
  r.desk.focusOut(f, KEY_EL)
  r.desk.focusIn(KEY_EL)
  r.clock.advance(1000)
  assert.equal(r.desk.get().field, f)
  r.desk.press('l')
  assert.equal(f.value, 'l', 'a key pressed with the focus on it types into the field')
  r.focus.el = PAGE_BUTTON
  r.desk.focusIn(PAGE_BUTTON)
  r.clock.advance(1000)
  assert.equal(r.desk.get().field, f, 'the round going on past the page\'s buttons keeps the field')
  f.shown = false
  r.desk.refresh()
  assert.equal(r.desk.get().mode, 'hidden')
})

test('without scanning, the focus going to the page lets the field go after a moment', () => {
  const r = rig()
  r.sense.last = 'gamepad'
  const f = new Field()
  focusOn(r, f)
  r.desk.summon()
  r.focus.el = PAGE_BUTTON
  r.desk.focusOut(f, PAGE_BUTTON)
  r.desk.focusIn(PAGE_BUTTON)
  r.clock.advance(DESK.graceMs - 1)
  assert.equal(r.desk.get().mode, 'open', 'not at once')
  r.clock.advance(2)
  assert.equal(r.desk.get().mode, 'hidden')
})

test('a held Backspace acts at once, again after a pause, then steadily, and comes up once', () => {
  const r = rig()
  r.sense.last = 'gamepad'
  const f = new Field()
  focusOn(r, f)
  r.desk.summon()
  f.value = 'abcdef'
  f.selectionStart = f.selectionEnd = 6
  r.desk.holdStart('Backspace')
  assert.equal(f.value, 'abcde')
  assert.equal(r.desk.get().held, 'Backspace')
  r.clock.advance(DESK.delayMs - 1)
  assert.equal(f.value, 'abcde')
  r.clock.advance(1)
  assert.equal(f.value, 'abcd')
  r.clock.advance(DESK.rateMs * 2)
  assert.equal(f.value, 'ab')
  r.desk.holdEnd('Backspace')
  r.clock.advance(1000)
  assert.equal(f.value, 'ab')
  assert.equal(r.desk.get().held, null)
  assert.deepEqual(f.keys, ['down:Backspace', 'down:Backspace*', 'down:Backspace*', 'down:Backspace*', 'up:Backspace'])
  r.desk.holdStart('a')
  assert.equal(f.value, 'ab', 'a letter is no held key')
})

test('a press on a field the keys will serve marks it before it takes the focus; a press that focuses nothing gives the marks back', () => {
  const r = rig({ touchFirst: true })
  r.sense.last = 'touch'
  const p = prompt()
  r.desk.pointerDown(p)
  assert.equal(r.marks.get(p), true, 'marked before the focus, so the phone\'s keyboard does not rise')
  r.clock.advance(DESK.premarkMs)
  assert.equal(r.marks.get(p), false)
  const chat = new Field()
  r.desk.pointerDown(chat)
  assert.equal(r.marks.has(chat), false, 'a chat line is the phone keyboard\'s')
  r.desk.pointerDown(p)
  focusOn(r, p, true)
  r.clock.advance(DESK.premarkMs * 2)
  assert.equal(r.marks.get(p), true, 'focused and served: the marks stay')
})

test('the system key hands the field to the device\'s keyboard inside the press, and a pad\'s select takes it back', () => {
  const r = rig({ touchFirst: true })
  r.sense.last = 'touch'
  const p = prompt()
  focusOn(r, p, true)
  assert.ok(r.desk.get().board.rows.flat().some((k) => k.id === 'system'), 'a touch-first device has the key')
  r.desk.press('system')
  assert.deepEqual(r.shown, [p], 'at once, not in a later task')
  assert.equal(r.desk.get().mode, 'hidden')
  assert.equal(r.marks.get(p), false)
  r.desk.pointerDown(p)
  assert.equal(r.desk.get().mode, 'hidden', 'a tap on it now is the device keyboard\'s')
  r.sense.last = 'gamepad'
  r.desk.summon()
  assert.equal(r.desk.get().mode, 'open')
})

test('a card that must be answered first folds the keys to the chip and takes the pads back', () => {
  const r = rig()
  r.sense.last = 'gamepad'
  const f = new Field()
  focusOn(r, f)
  r.desk.summon()
  r.desk.setBlocked(true)
  assert.equal(r.desk.get().mode, 'peek')
  assert.deepEqual(r.lends, [true, false])
  r.desk.setBlocked(false)
  assert.equal(r.desk.get().mode, 'open', 'and they come back when it is gone')
})

test('Tab goes to the card\'s next field and the keys stay open there; Ctrl+C copies and Ctrl+V pastes', async () => {
  const r = rig()
  r.sense.last = 'gamepad'
  const a = new Field(), b = new Field()
  r.fields.push(a, b)
  focusOn(r, a)
  r.desk.summon()
  r.desk.press('Tab')
  assert.equal(r.focus.el, b)
  assert.equal(r.desk.get().field, b)
  assert.equal(r.desk.get().mode, 'open')
  r.clock.advance(0)
  b.value = 'hello world'
  b.selectionStart = 6
  b.selectionEnd = 11
  r.desk.press('ctrl')
  r.desk.press('c')
  r.clock.advance(0)
  assert.equal(r.clip.text, 'world')
  b.selectionStart = b.selectionEnd = 11
  r.clip.text = '!'
  r.desk.press('ctrl')
  r.desk.press('v')
  await Promise.resolve()
  await Promise.resolve()
  r.clock.advance(0)
  assert.equal(b.value, 'hello world!')
  assert.equal(r.clip.reads, 1)
})

test('the pad types: the highlight steps, Shift and the layer change the board, a held south button repeats letters only', () => {
  const r = rig()
  r.sense.last = 'gamepad'
  const f = new Field()
  focusOn(r, f)
  r.desk.summon()
  r.desk.padAsk({ control: 'right', repeat: false })
  assert.equal(r.desk.get().at, 'h')
  assert.equal(r.said.at(-1), 'h', 'the highlighted key is said')
  r.desk.padAsk({ control: 'shift', repeat: false })
  assert.equal(r.desk.get().keys.shift, 'once')
  r.desk.padAsk({ control: 'press', repeat: false })
  r.clock.advance(0)
  assert.equal(f.value, 'H')
  r.desk.padAsk({ control: 'press', repeat: true })
  r.clock.advance(0)
  assert.equal(f.value, 'Hh', 'held, it types again')
  r.desk.padAsk({ control: 'layer', repeat: false })
  assert.equal(r.desk.get().board.layer, 'numbers')
  r.desk.padAsk({ control: 'layer', repeat: false })
  assert.equal(r.desk.get().board.layer, 'symbols')
  r.desk.padAsk({ control: 'layer', repeat: false })
  assert.equal(r.desk.get().board.layer, 'letters')
  r.desk.padAsk({ control: 'space', repeat: false })
  r.desk.padAsk({ control: 'back', repeat: false })
  r.clock.advance(0)
  assert.equal(f.value, 'Hh')
  // On the Shift key itself, a held south button does not flip it on and off.
  r.desk.padAsk({ control: 'down', repeat: false })
  for (let i = 0; i < 12 && r.desk.get().at !== 'shift'; i++) r.desk.padAsk({ control: 'left', repeat: false })
  assert.equal(r.desk.get().at, 'shift')
  r.desk.padAsk({ control: 'press', repeat: false })
  assert.equal(r.desk.get().keys.shift, 'once')
  r.desk.padAsk({ control: 'press', repeat: true })
  assert.equal(r.desk.get().keys.shift, 'once')
  r.desk.padAsk({ control: 'enter', repeat: false })
  r.clock.advance(0)
  assert.deepEqual(f.keys.slice(-2), ['down:Enter', 'up:Enter'])
})

test('summoned with no field: the first field shown, else the console, whose prompt then opens them', () => {
  const r = rig({ console: prompt() })
  r.sense.last = 'gamepad'
  const a = new Field()
  r.fields.push(a)
  r.desk.summon()
  assert.equal(r.focus.el, a)
  assert.equal(r.desk.get().mode, 'open')
  const r2 = rig({ console: prompt() })
  r2.sense.last = 'gamepad'
  r2.desk.summon()
  assert.equal(r2.consoles, 1)
  r2.clock.advance(300)
  const p = prompt()
  focusOn(r2, p)
  assert.equal(r2.desk.get().mode, 'open', 'the prompt the console focuses gets them open')
  const r3 = rig()
  r3.sense.last = 'gamepad'
  r3.desk.summon()
  assert.equal(r3.desk.get().mode, 'hidden', 'nowhere to type: nothing')
})

test('the keys serve under the policy keyboardSense.ts sets (the desk adds no rule of its own)', () => {
  for (const last of ['keyboard', 'mouse', 'touch', 'pen', 'gamepad', 'headset', null] as const) for (const touchFirst of [true, false]) for (const code of [true, false]) {
    const r = rig({ touchFirst })
    r.sense.last = last
    const f = code ? prompt() : new Field()
    focusOn(r, f, true)
    const served = keysServe({ setting: 'auto', last, keyboardLately: false, touchFirst, codeField: code, scan: false, dwell: false })
    assert.equal(r.desk.get().mode !== 'hidden', served, `${last} touch=${touchFirst} code=${code}`)
  }
})

test('let go, the desk gives everything back', () => {
  const r = rig()
  r.sense.last = 'gamepad'
  const f = new Field()
  focusOn(r, f)
  r.desk.summon()
  r.desk.dispose()
  assert.equal(r.marks.get(f), false)
  assert.deepEqual(r.lends, [true, false])
})
