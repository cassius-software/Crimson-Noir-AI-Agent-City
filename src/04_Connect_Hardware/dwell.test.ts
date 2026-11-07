// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the dwell click (dwell.ts) over a fake page: a rest on a button
 * presses it once after the time and not again until the pointer leaves; a move past the slop starts the time again;
 * a text field is focused, not pressed; a disabled or hidden control, a touch, pointer lock and a real press never
 * dwell; stop() leaves nothing armed.
 * What breaks if it is removed? A button pressed twice by one rest, or one pressed under pointer lock.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DWELL, DwellClicker, type DwellEnv, type DwellPointer, type DwellTarget } from './dwell.ts'

class El implements DwellTarget {
  clicks = 0
  focuses = 0
  attrs = new Map<string, string>()
  readonly kind: 'button' | 'text' | 'div'
  readonly flags: { disabled?: boolean; hidden?: boolean }
  constructor(kind: 'button' | 'text' | 'div', flags: { disabled?: boolean; hidden?: boolean } = {}) {
    this.kind = kind
    this.flags = flags
  }
  click(): void { this.clicks++ }
  focus(): void { this.focuses++ }
  matches(selector: string): boolean {
    if (selector === DWELL.typed) return this.kind === 'text'
    return this.kind !== 'div'
  }
  closest(selector: string): DwellTarget | null {
    if (selector === DWELL.selector) return this.kind === 'div' ? null : this
    if (selector === '[aria-hidden="true"]') return this.flags.hidden ? this : null
    return null
  }
  hasAttribute(name: string): boolean { return name === 'disabled' ? this.flags.disabled === true : this.attrs.has(name) }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value) }
  removeAttribute(name: string): void { this.attrs.delete(name) }
}

function page() {
  const listeners = new Map<string, Set<(e: DwellPointer) => void>>()
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  const grid = new Map<string, El>()
  const state = { locked: false }
  const env: DwellEnv = {
    on(type, fn) {
      const set = listeners.get(type) ?? new Set()
      set.add(fn)
      listeners.set(type, set)
      return () => { set.delete(fn) }
    },
    at: (x, y) => grid.get(`${x},${y}`) ?? null,
    locked: () => state.locked,
    setTimeout: (fn) => { const id = nextTimer++; timers.set(id, fn); return id },
    clearTimeout: (id) => { timers.delete(id as number) },
  }
  const fire = (type: string, e: DwellPointer) => { for (const fn of listeners.get(type) ?? []) fn(e) }
  return {
    env, state, grid,
    place: (el: El, x: number, y: number) => grid.set(`${x},${y}`, el),
    move: (x: number, y: number, pointerType = 'mouse') => fire('pointermove', { clientX: x, clientY: y, pointerType }),
    down: (x: number, y: number, pointerType = 'mouse') => fire('pointerdown', { clientX: x, clientY: y, pointerType }),
    leave: () => fire('pointerleave', { clientX: 0, clientY: 0, pointerType: 'mouse' }),
    elapse: () => { const due = [...timers.entries()]; timers.clear(); for (const [, fn] of due) fn() },
    pending: () => timers.size,
    listening: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  }
}

test('a rest on a button arms it, the time presses it once, and it is not pressed again until the pointer has left it', () => {
  const p = page()
  const b = new El('button')
  p.place(b, 10, 10)
  p.place(b, 12, 11)
  p.place(b, 40, 10)
  const d = new DwellClicker(p.env)
  d.start()
  assert.equal(p.listening(), 3)
  p.move(10, 10)
  assert.equal(d.target, b)
  assert.equal(b.attrs.get('data-dwell'), 'arming')
  assert.equal(p.pending(), 1)
  p.move(12, 11) // within the slop: the same timer
  assert.equal(p.pending(), 1)
  p.elapse()
  assert.equal(b.clicks, 1)
  assert.equal(b.attrs.get('data-dwell'), 'done')
  assert.equal(d.arming, false)
  p.move(40, 10) // still on it, well past the slop: no re-arm once done
  p.elapse()
  assert.equal(b.clicks, 1)
  p.move(99, 99) // off it: the mark goes
  assert.equal(d.target, null)
  assert.equal(b.attrs.has('data-dwell'), false)
  p.move(10, 10)
  p.elapse()
  assert.equal(b.clicks, 2, 'back on it: a second rest is a second press')
  d.stop()
  assert.equal(p.listening(), 0)
  assert.equal(b.attrs.has('data-dwell'), false, 'stop leaves nothing armed')
})

test('a move past the slop starts the time again from the new place; moving to another control re-arms there; a text field is focused, not pressed', () => {
  const p = page()
  const b = new El('button'), t = new El('text')
  p.place(b, 0, 0)
  p.place(b, 20, 0)
  p.place(b, 25, 0)
  p.place(t, 100, 100)
  const d = new DwellClicker(p.env, 500)
  d.start()
  p.move(0, 0)
  p.move(20, 0) // 20 px: past the slop, the time restarts
  assert.equal(p.pending(), 1, 'one timer, the old one cleared')
  p.move(25, 0) // 5 px from the new anchor: no restart
  p.elapse()
  assert.equal(b.clicks, 1)
  p.move(100, 100)
  assert.equal(b.attrs.has('data-dwell'), false, 'the old control is cleared')
  assert.equal(d.target, t)
  p.elapse()
  assert.equal(t.focuses, 1)
  assert.equal(t.clicks, 0)
  d.stop()
})

test('nothing dwells on a disabled or hidden control, on plain content, under a touch, under pointer lock, or after a real press', () => {
  const p = page()
  const off = new El('button', { disabled: true }), hid = new El('button', { hidden: true }), div = new El('div'), b = new El('button')
  p.place(off, 1, 1)
  p.place(hid, 2, 2)
  p.place(div, 3, 3)
  p.place(b, 4, 4)
  const d = new DwellClicker(p.env)
  d.start()
  for (const [x, y] of [[1, 1], [2, 2], [3, 3]]) {
    p.move(x, y)
    assert.equal(d.target, null, `${x}: nothing to arm`)
  }
  p.move(4, 4, 'touch')
  assert.equal(d.target, null, 'a finger never dwells')
  p.state.locked = true
  p.move(4, 4)
  assert.equal(d.target, null, 'the pointer is the head')
  p.state.locked = false
  p.move(4, 4)
  assert.equal(d.target, b)
  p.down(4, 4)
  assert.equal(d.arming, false, 'a real press drops the arm')
  assert.equal(b.attrs.get('data-dwell'), 'done')
  p.elapse()
  assert.equal(b.clicks, 0, 'and the dwell never presses after it')
  p.leave()
  assert.equal(d.target, null)
  p.move(4, 4)
  p.state.locked = true
  p.move(4, 4)
  assert.equal(d.target, null, 'lock taken while armed: dropped')
  assert.equal(b.attrs.has('data-dwell'), false)
  d.stop()
  d.stop()
})
