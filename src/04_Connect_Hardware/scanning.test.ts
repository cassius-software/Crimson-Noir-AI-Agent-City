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

/** What has the focus in the fake page. */
const page0 = { focused: null as unknown }

class El implements ScanTarget {
  clicks = 0
  focuses = 0
  marked = false
  readonly name: string
  readonly typed: boolean
  readonly tagName: string
  constructor(name: string, typed = false) {
    this.name = name
    this.typed = typed
    this.tagName = typed ? 'INPUT' : 'BUTTON'
  }
  click(): void { this.clicks++ }
  focus(): void { this.focuses++; page0.focused = this }
  matches(): boolean { return this.typed }
  setAttribute(name: string): void { if (name === 'data-scan') this.marked = true }
  removeAttribute(name: string): void { if (name === 'data-scan') this.marked = false }
}

function page(shown: El[]) {
  let keyFn: ((e: ScanKey) => void) | null = null
  const timers = new Map<number, () => void>()
  let next = 1
  const env: ScanEnv = {
    candidates: () => shown.filter((e) => e.name !== 'gone'),
    active: () => page0.focused,
    onKey: (fn) => { keyFn = fn; return () => { keyFn = null } },
    setInterval: (fn) => { const id = next++; timers.set(id, fn); return id },
    clearInterval: (id) => { timers.delete(id as number) },
  }
  const key = (code: string, target: EventTarget | null = null, repeat = false) => {
    const e = { code, repeat, target, prevented: false, stopped: false, preventDefault() { this.prevented = true }, stopImmediatePropagation() { this.stopped = true } }
    keyFn?.(e)
    return e
  }
  return { env, key, tick: () => { for (const fn of [...timers.values()]) fn() }, timers: () => timers.size, listening: () => keyFn !== null }
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
  const typing = p.key('Space', { tagName: 'INPUT' } as unknown as EventTarget)
  assert.deepEqual([a.clicks, typing.prevented], [0, false], 'a space typed in a field stays a space')
  p.tick()
  assert.equal(s.current, c, 'the one that is gone is never offered')
  shown.length = 0
  p.tick()
  assert.equal(s.current, null)
  assert.equal(c.marked, false)
  shown.push(c)
  p.tick()
  assert.equal(s.current, c, 'back when something is shown')
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
  p.tick()
  assert.equal(s.current, a, 'the offer does not move (and does not take the focus)')
  assert.equal(page0.focused, field)
  for (let i = 0; i < 3; i++) p.tick()
  const space = p.key('Space', field as unknown as EventTarget)
  assert.deepEqual([space.prevented, a.clicks], [false, 0], 'Space typed in a field being typed in is a space, and presses nothing')
  for (let i = 0; i < SCAN.hold; i++) p.tick()
  assert.equal(s.current, a, 'every key restarts the hold')
  p.tick()
  assert.equal(s.current, field, 'quiet: the round goes on from where it stood')
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
  for (let i = 0; i <= SCAN.hold; i++) p.tick()
  assert.deepEqual([s.current, page0.focused], [a, field], 'the caret stays in the field for SCAN.hold offers and one')
  const space = p.key('Space', field as unknown as EventTarget)
  assert.deepEqual([space.prevented, a.clicks, b.clicks], [false, 0, 0], 'a space typed there is a space, and presses nothing')
  for (let i = 0; i < SCAN.hold; i++) p.tick()
  assert.equal(s.current, a, 'the key restarted the hold')
  p.tick()
  assert.deepEqual([s.current, page0.focused], [b, b], 'quiet: the round goes on and takes the focus')
  s.stop()
})
