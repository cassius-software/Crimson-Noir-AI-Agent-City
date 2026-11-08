// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for single-switch scanning (scanning.ts) over a fake page: the round
 * offers each control in order and comes back to the first, focusing and marking the one offered; the switch presses
 * it (a field takes the caret) and is taken before the page sees it; a key typed in a field is left alone and holds
 * the round on that field until it goes quiet; a control that goes away is skipped; stop() clears the mark and the key.
 * What breaks if it is removed? A round that stalls on a control that has gone, or a switch that also brakes the car.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SCAN, Scanner, type ScanEnv, type ScanKey, type ScanTarget } from './scanning.ts'

/** What has the focus in the fake page; moving it blurs the one that had it (the page's own element while it does)
 *  and tells the window's focus listeners, unless the window is in the back (`away`), where no blur or focus fires. */
const page0 = { focused: null as unknown, away: false, onFocus: new Set<() => void>(), onFocusIn: null as ((el: El) => void) | null }
function setFocus(el: El | null): void {
  const was = page0.focused as El | null
  if (was === el) return
  page0.focused = null
  if (!page0.away) was?.blurred()
  page0.focused = el
  if (el && !page0.away) { page0.onFocusIn?.(el); for (const fn of [...page0.onFocus]) fn() }
}

class El implements ScanTarget {
  clicks = 0
  focuses = 0
  marked = false
  readonly name: string
  readonly typed: boolean
  readonly tagName: string
  /** False for a control the browser will not focus as it is (a role="button" with no tabindex) ... */
  readonly focusable: boolean
  /** ... and false too for one it will not focus even with a tabindex (a button in a disabled fieldset). */
  readonly lendable: boolean
  readonly attrs = new Map<string, string>()
  readonly blurs: (() => void)[] = []
  /** Every write of its tabindex, by anyone (what a MutationObserver records). */
  writes = 0
  constructor(name: string, typed = false, focusable = true, lendable = true) {
    this.name = name
    this.typed = typed
    this.tagName = typed ? 'INPUT' : 'BUTTON'
    this.focusable = focusable
    this.lendable = lendable
  }
  click(): void { this.clicks++ }
  focus(): void { this.focuses++; if (this.focusable || (this.lendable && this.attrs.has('tabindex'))) setFocus(this) }
  matches(): boolean { return this.typed }
  hasAttribute(name: string): boolean { return this.attrs.has(name) }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); if (name === 'data-scan') this.marked = true; if (name === 'tabindex') this.writes++ }
  removeAttribute(name: string): void {
    this.attrs.delete(name)
    if (name === 'tabindex') this.writes++
    if (name === 'data-scan') this.marked = false
    // The browser's focus fixup: a focused element that can no longer take the focus drops it to the page.
    if (name === 'tabindex' && page0.focused === this && !this.focusable) setFocus(null)
  }
  addEventListener(_type: 'blur', fn: () => void): void { this.blurs.push(fn) }
  blurred(): void { const fns = this.blurs.splice(0); for (const fn of fns) fn() }
}

function page(shown: El[]) {
  page0.away = false
  page0.onFocus.clear()
  page0.onFocusIn = null
  setFocus(null)
  let keyFn: ((e: ScanKey) => void) | null = null
  const timers = new Map<number, () => void>()
  let next = 1
  const env: ScanEnv = {
    candidates: () => shown.filter((e) => e.name !== 'gone'),
    active: () => page0.focused,
    onKey: (fn) => { keyFn = fn; return () => { keyFn = null } },
    setInterval: (fn) => { const id = next++; timers.set(id, fn); return id },
    clearInterval: (id) => { timers.delete(id as number) },
    watch: (t) => { const el = t as El, at = el.writes; return { touched: () => el.writes > at, stop() {} } },
    onFocus: (fn) => { page0.onFocus.add(fn); return () => { page0.onFocus.delete(fn) } },
  }
  const key = (code: string, target: EventTarget | null = null, repeat = false) => {
    const e = { code, repeat, target, prevented: false, stopped: false, preventDefault() { this.prevented = true }, stopImmediatePropagation() { this.stopped = true } }
    keyFn?.(e)
    return e
  }
  return { env, key, tick: () => { for (const fn of [...timers.values()]) fn() }, timers: () => timers.size, listening: () => keyFn !== null, focusWatchers: () => page0.onFocus.size }
}

test('the round offers each control in order and comes back to the first, focusing and marking the one offered; the switch presses it, or puts the caret in a field', () => {
  const a = new El('a'), b = new El('b'), field = new El('field', true)
  const p = page([a, b, field])
  const s = new Scanner(p.env, 1000)
  assert.equal(s.running, false)
  s.start()
  assert.equal(s.running, true)
  assert.equal(p.timers(), 1)
  assert.equal(s.current, a, 'the first is offered at once')
  assert.deepEqual([a.marked, a.focuses], [true, 1])
  p.tick()
  assert.equal(s.current, b)
  assert.deepEqual([a.marked, b.marked], [false, true])
  const e = p.key(SCAN.key)
  assert.deepEqual([b.clicks, e.prevented, e.stopped], [1, true, true], 'pressed, and the key never reaches the page')
  p.tick()
  assert.equal(s.current, field)
  const take = p.key('Space', field as unknown as EventTarget)
  assert.deepEqual([field.clicks, field.focuses, take.prevented], [0, 2, true], 'the switch on the field offered (and focused) takes it, and types nothing')
  for (let i = 0; i < SCAN.hold; i++) p.tick()
  assert.equal(s.current, field, 'the field taken holds the round while it may be typed in')
  p.tick()
  assert.equal(s.current, a, 'quiet for SCAN.hold offers: round again')
  s.start()
  assert.equal(p.timers(), 1, 'started once')
  s.stop()
  assert.deepEqual([s.running, s.current, a.marked, p.timers(), p.listening()], [false, null, false, 0, false])
  assert.equal(s.select(), false)
})

test('other keys, a held switch and a switch typed in a field are left alone; a control that goes away is skipped; an empty page offers nothing', () => {
  const a = new El('a'), gone = new El('gone'), c = new El('c')
  const shown = [a, gone, c]
  const p = page(shown)
  const s = new Scanner(p.env, 1000)
  s.start()
  assert.equal(s.current, a)
  const other = p.key('Enter')
  assert.deepEqual([a.clicks, other.prevented], [0, false])
  const held = p.key('Space', null, true)
  assert.deepEqual([a.clicks, held.prevented], [0, true], 'a held switch is swallowed but presses nothing again')
  p.tick()
  assert.equal(s.current, c, 'the one that is gone is never offered')
  shown.length = 0
  p.tick()
  assert.equal(s.current, null)
  assert.equal(c.marked, false)
  shown.push(c)
  p.tick()
  assert.equal(s.current, c, 'back when something is shown')
  const field = new El('field', true)
  const typing = p.key('Space', field as unknown as EventTarget)
  assert.deepEqual([c.clicks, typing.prevented, s.current], [0, false, field], 'a space typed in a field (one the round never offered) stays a space, and the field is the one offered now')
  s.stop()
})

test('a field being typed in holds the round: its keys (the switch\'s Space too, once taken) stay its own, each key restarts the hold, and the round moves on once the focus leaves or it goes quiet', () => {
  const a = new El('a'), field = new El('field', true), b = new El('b')
  const p = page([a, field, b])
  const s = new Scanner(p.env, 1000)
  s.start()
  assert.equal(s.current, a)
  // A visitor clicks into the field (another hand) and types: the round holds there.
  field.focus()
  const letter = p.key('KeyA', field as unknown as EventTarget)
  assert.equal(letter.prevented, false, 'a letter typed is the field\'s')
  assert.deepEqual([s.current, field.marked, a.marked], [field, true, false], 'the field is the one offered now: the ring is where the caret is')
  p.tick()
  assert.equal(s.current, field, 'the offer does not move (and does not take the focus)')
  assert.equal(page0.focused, field)
  for (let i = 0; i < 3; i++) p.tick()
  const space = p.key('Space', field as unknown as EventTarget)
  assert.deepEqual([space.prevented, a.clicks], [false, 0], 'Space typed in a field being typed in is a space, and presses nothing')
  for (let i = 0; i < SCAN.hold; i++) p.tick()
  assert.equal(s.current, field, 'every key restarts the hold')
  p.tick()
  assert.deepEqual([s.current, page0.focused], [b, b], 'quiet: the round goes on from the field')
  p.tick()
  p.tick()
  assert.deepEqual([s.current, page0.focused], [field, field], 'round again to the field, merely offered')
  // Offered now; a letter typed in it holds it, the switch is then a space too.
  const typed = p.key('KeyB', field as unknown as EventTarget)
  assert.equal(typed.prevented, false)
  const spaced = p.key('Space', field as unknown as EventTarget)
  assert.deepEqual([spaced.prevented, field.clicks], [false, 0])
  p.tick()
  assert.equal(s.current, field, 'held')
  a.focus()
  p.tick()
  assert.equal(s.current, b, 'the focus left the field: the round moves on at once')
  s.stop()
})

test('a field that takes the focus without a key (a click, a card\'s own focus, the dwell) holds the round from that moment, then lets it go when it stays quiet', () => {
  const a = new El('a'), b = new El('b'), field = new El('field', true)
  const p = page([a, b, field])
  const s = new Scanner(p.env, 1000)
  s.start()
  assert.equal(s.current, a)
  field.focus()
  p.tick()
  assert.deepEqual([s.current, field.marked, a.marked], [field, true, false], 'taken without a key: the field is the one offered, the ring moves to it')
  for (let i = 0; i < SCAN.hold; i++) p.tick()
  assert.deepEqual([s.current, page0.focused], [field, field], 'the caret stays in the field for SCAN.hold offers and one')
  const space = p.key('Space', field as unknown as EventTarget)
  assert.deepEqual([space.prevented, a.clicks, b.clicks], [false, 0, 0], 'a space typed there is a space, and presses nothing')
  for (let i = 0; i < SCAN.hold; i++) p.tick()
  assert.equal(s.current, field, 'the key restarted the hold')
  p.tick()
  assert.deepEqual([s.current, page0.focused], [a, a], 'quiet: the round goes on from the field (round to the first) and takes the focus')
  s.stop()
})

test('a control that cannot take the focus never hands the round back to the field before it: the round goes on past it', () => {
  // The fourth review's case: the focus stays on the field the round offered last, which used to read as a field
  // focused by another hand, so the round came back to it after every offer of the stuck control and never reached b.
  const a = new El('a'), field = new El('field', true), stuck = new El('stuck', false, false), b = new El('b')
  const p = page([a, field, stuck, b])
  const s = new Scanner(p.env, 1000)
  s.start()
  const seen: string[] = [(s.current as El).name]
  for (let i = 0; i < 6; i++) { p.tick(); seen.push((s.current as El).name) }
  assert.deepEqual(seen, ['a', 'field', 'stuck', 'b', 'a', 'field', 'stuck'], 'every control is offered in turn')
  s.stop()
  // A field outside the round with the focus, then a first control that cannot take it: taken once, then let go.
  const outside = new El('outside', true), stuck2 = new El('stuck', false, false), c = new El('c')
  const q = page([stuck2, c])
  outside.focus()
  const t = new Scanner(q.env, 1000)
  t.start()
  assert.equal(t.current, outside, 'the field with the focus is the one offered')
  for (let i = 0; i < SCAN.hold; i++) q.tick()
  const after: string[] = []
  for (let i = 0; i < 4; i++) { q.tick(); after.push((t.current as El).name) }
  assert.deepEqual(after, ['stuck', 'c', 'stuck', 'c'], 'quiet: the round goes on, and the field it left is not taken again')
  t.stop()
})

test('a control the browser will not focus as it is takes the focus for its offer (lent tabindex -1, given back after), so the switch presses it and a field is never guessed at', () => {
  // The fifth review's case: the round offered such a control, the focus stayed on the field before it, and the switch
  // (Space) went to that field, typing a space and holding the round there, so the control could never be pressed. The
  // sixth review's case: guessing that a space in the field the focus stayed on was the switch swallowed the first
  // space a visitor typed after clicking back into it. Lent a tabindex, the control has the focus and the key.
  const a = new El('a'), field = new El('field', true), stuck = new El('stuck', false, false), b = new El('b')
  const p = page([a, field, stuck, b])
  const s = new Scanner(p.env, 1000)
  s.start()
  p.tick()
  p.tick()
  assert.deepEqual([s.current, page0.focused, stuck.attrs.get('tabindex')], [stuck, stuck, '-1'], 'offered, lent a tabindex, and focused')
  const press = p.key(SCAN.key, stuck as unknown as EventTarget)
  assert.deepEqual([stuck.clicks, press.prevented, press.stopped], [1, true, true], 'the switch presses it')
  // The visitor clicks back into the field (or the dwell focuses it) and types a space first: it is the field's.
  field.focus()
  const space = p.key(SCAN.key, field as unknown as EventTarget)
  assert.deepEqual([space.prevented, stuck.clicks, s.current], [false, 1, field], 'a space in the field the visitor went back to is a space')
  assert.equal(stuck.attrs.has('tabindex'), false, 'the tabindex is given back once the round moves on')
  s.stop()
  // A control that takes the focus as it is is never lent one; one that takes none even when lent (a button in a
  // disabled fieldset, which no press would press either) is passed, and a key in the field before it is the field's.
  const c = new El('c'), field2 = new El('field', true), dead = new El('dead', false, false, false), d = new El('d')
  const q = page([c, field2, dead, d])
  const t = new Scanner(q.env, 1000)
  t.start()
  const seen: string[] = [(t.current as El).name]
  for (let i = 0; i < 4; i++) { q.tick(); seen.push((t.current as El).name) }
  assert.deepEqual(seen, ['c', 'field', 'dead', 'd', 'c'], 'the round goes on past it')
  assert.deepEqual([c.attrs.has('tabindex'), d.attrs.has('tabindex'), dead.attrs.has('tabindex')], [false, false, false], 'nothing left lent')
  t.stop()
})

test('the lent tabindex is given back only once the focus has left the control (on stop, or past a control that takes none), and never one the page has set since', () => {
  // The seventh review's cases: taking it off the control that has the focus drops the focus to the page, which the
  // stop() contract ("focus stays where it is") and the round's own comment ruled out; and a tabindex the page gave the
  // control meanwhile (a roving tabindex) was taken away with it.
  const a = new El('a', false, false), b = new El('b', false, false), c = new El('c')
  const p = page([a, b, c])
  const s = new Scanner(p.env, 1000)
  s.start()
  assert.deepEqual([page0.focused, a.attrs.get('tabindex')], [a, '-1'])
  s.stop()
  assert.deepEqual([page0.focused, a.attrs.get('tabindex')], [a, '-1'], 'stopped: the focus stays, and so does the tabindex under it')
  c.focus()
  assert.deepEqual([page0.focused, a.attrs.has('tabindex')], [c, false], 'given back once the focus has left')
  // Past a control that takes no focus even when lent one: the focus stays on the last, and so does its tabindex.
  const d = new El('d', false, false), dead = new El('dead', false, false, false), e = new El('e')
  const q = page([d, dead, e])
  const t = new Scanner(q.env, 1000)
  t.start()
  q.tick()
  assert.deepEqual([t.current, page0.focused, d.attrs.get('tabindex')], [dead, d, '-1'], 'the focus never drops to the page')
  q.tick()
  assert.deepEqual([t.current, page0.focused, d.attrs.has('tabindex'), dead.attrs.has('tabindex')], [e, e, false, false], 'both given back once the focus moved on')
  t.stop()
  // The page sets its own tabindex on the control while it is offered: kept.
  const f = new El('f', false, false), g = new El('g')
  const r = page([f, g])
  const u = new Scanner(r.env, 1000)
  u.start()
  f.setAttribute('tabindex', '0')
  r.tick()
  assert.deepEqual([u.current, f.attrs.get('tabindex')], [g, '0'], 'the page\'s own tabindex stays')
  u.stop()
})

test('a tabindex the page writes after the lend is the page\'s, even when it is "-1" (a roving tabindex), and a lent one is given back when the focus leaves with no blur (the window in the back)', () => {
  // The eighth review's cases. A roving tabindex gives every item but the current one "-1", the very value lent, so the
  // value alone could not tell them apart: moving on, the scan took away the "-1" the page had just written and the
  // page's arrow keys could no longer reach the item. And a focus that moves while the window is in the back fires no
  // blur, so a lent tabindex waiting for one stayed for good.
  const x = new El('x', false, false), y = new El('y', false, false), z = new El('z')
  const p = page([x, y, z])
  page0.onFocusIn = (el) => { if (el === x || el === y) { el.setAttribute('tabindex', '0'); (el === x ? y : x).setAttribute('tabindex', '-1') } }
  const s = new Scanner(p.env, 1000)
  s.start()
  assert.deepEqual([page0.focused, x.attrs.get('tabindex'), y.attrs.get('tabindex')], [x, '0', '-1'], 'lent, then the page took it over')
  p.tick()
  assert.deepEqual([s.current, page0.focused, x.attrs.get('tabindex'), y.attrs.get('tabindex')], [y, y, '-1', '0'], 'the page\'s own "-1" on the item it left stays')
  s.stop()
  assert.equal(p.focusWatchers(), 0, 'nothing owed, nothing watched')
  // Lent, then the round passes a control that takes no focus (the focus stays, waiting for its blur); the window goes
  // to the back (a blur with the focus still there: still waiting), and the next offer moves the focus with no blur.
  const a = new El('a', false, false), dead = new El('dead', false, false, false), e = new El('e'), f = new El('f')
  const q = page([a, dead, e, f])
  const t = new Scanner(q.env, 1000)
  t.start()
  q.tick()
  assert.deepEqual([t.current, page0.focused, a.attrs.get('tabindex')], [dead, a, '-1'])
  page0.away = true
  a.blurred()
  q.tick()
  assert.deepEqual([t.current, page0.focused, a.attrs.get('tabindex')], [e, e, '-1'], 'the focus left with no blur')
  q.tick()
  assert.deepEqual([t.current, a.attrs.has('tabindex')], [f, false], 'given back at the next offer')
  t.stop()
  // Stopped with the focus on it, the window in the back, then its card hidden (the focus drops to the page with no
  // blur): given back when the window comes forward again.
  const b = new El('b', false, false), c = new El('c')
  const r = page([b, c])
  const u = new Scanner(r.env, 1000)
  u.start()
  u.stop()
  page0.away = true
  b.blurred()
  setFocus(null)
  assert.equal(b.attrs.get('tabindex'), '-1', 'no blur, no offer: still lent')
  page0.away = false
  for (const fn of [...page0.onFocus]) fn()
  assert.deepEqual([b.attrs.has('tabindex'), r.focusWatchers()], [false, 0], 'the window\'s focus came back: given back, and nothing left watched')
})

test('a field the round merely offers is not taken: with no key it is passed like any control', () => {
  const a = new El('a'), field = new El('field', true), b = new El('b')
  const p = page([a, field, b])
  const s = new Scanner(p.env, 1000)
  s.start()
  assert.equal(s.current, a)
  p.tick()
  assert.deepEqual([s.current, page0.focused], [field, field], 'offered: marked and focused by the round itself')
  p.tick()
  assert.deepEqual([s.current, page0.focused], [b, b], 'no key: passed on the next offer, not held')
  s.stop()
})
