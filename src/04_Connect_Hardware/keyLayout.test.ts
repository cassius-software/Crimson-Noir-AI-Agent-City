// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the on-screen keys' board to its promises: every row of every layer fills the
 * same twenty half-columns (so no key hangs off a phone's edge), no two keys of a board share an id, every character
 * a US keyboard types can be typed from some layer, Shift goes off, on for one letter, locked, off, a chord with Ctrl
 * types nothing and lets Ctrl go, Enter carries Shift and the arrows do not, a d-pad's highlight wraps and remembers
 * its column across rows of unequal length and across layers, and a letter cycles through its accents and comes
 * home, capitals among capitals.
 * What breaks if it is removed? A key could vanish from a layer, a character could become untypeable without a
 * keyboard, or the highlight could strand a pad user on a row, and only that user would find out.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BOARD_COLUMNS, boardFor, cursorOn, fitCursor, keyAt, keysOf, KEYS_START, nextAccent, pressKey, stepCursor,
  type Board, type Cursor, type KeyDef, type KeysState, type Layer, type ShiftState, type StepDir,
} from './keyLayout.ts'

const LAYERS: readonly Layer[] = ['letters', 'numbers', 'symbols']
const board = (layer: Layer = 'letters', shift: ShiftState = 'off', system = false, enter = ''): Board => boardFor({ layer, shift, system, enter })
const key = (b: Board, id: string): KeyDef => {
  const k = keysOf(b).find(x => x.id === id)
  assert.ok(k, `the board has a key "${id}"`)
  return k
}
/** Presses keys by id on the board the state shows, and returns the state and everything that went out. */
function run(ids: readonly string[], start: KeysState = KEYS_START): { state: KeysState; out: unknown[] } {
  let state = start
  const out: unknown[] = []
  for (const id of ids) {
    const p = pressKey(state, key(board(state.layer, state.shift), id))
    state = p.state
    if (p.out) out.push(p.out.kind === 'stroke' ? p.out.stroke : p.out.kind)
  }
  return { state, out }
}
const typed = (ids: readonly string[], start?: KeysState): string => run(ids, start).out.map(o => typeof o === 'string' ? `<${o}>` : (o as { text: string; key: string }).text || `<${(o as { key: string }).key}>`).join('')

test('every row of every layer fills the board, edge to edge', () => {
  for (const layer of LAYERS) for (const system of [false, true]) for (const shift of ['off', 'once', 'lock'] as const) {
    const b = board(layer, shift, system)
    assert.equal(b.rows.length, 5, `${layer}: five rows`)
    for (const row of b.rows) {
      let x = row[0].x
      for (const k of row) {
        assert.equal(k.x, x, `${layer}: "${k.id}" stands where the key before it ends`)
        assert.ok(k.w >= 2, `${layer}: "${k.id}" is at least a letter wide`)
        x += k.w
      }
      const pad = row[0].x
      assert.equal(pad + (x - pad) + pad, BOARD_COLUMNS, `${layer} row ${row[0].row}: ${row.map(k => k.id).join(' ')}`)
    }
    const ids = keysOf(b).map(k => k.id)
    assert.equal(new Set(ids).size, ids.length, `${layer}: no id twice`)
    for (const k of keysOf(b)) {
      assert.ok(k.say.length > 0, `${layer}: "${k.id}" has a spoken name`)
      assert.ok(k.label !== '' || k.icon !== undefined || k.id === 'space', `${layer}: "${k.id}" shows something`)
    }
  }
})

test('the keys every layer keeps stay where they are', () => {
  const place = (b: Board, id: string): string => { const k = keysOf(b).find(x => x.id === id)!; return `${k.row}:${k.x}:${k.w}` }
  for (const id of ['Escape', 'Tab', 'ctrl', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight', '-', '/', 'accent', 'Backspace', 'space', ',', '.', 'Enter', 'hide']) {
    const at = place(board('letters'), id)
    for (const layer of LAYERS) assert.equal(place(board(layer), id), at, `${id} on ${layer}`)
  }
})

test('every character a US keyboard types can be typed from some layer', () => {
  const reach = new Set<string>()
  for (const layer of LAYERS) for (const shift of ['off', 'lock'] as const) {
    const state: KeysState = { layer, shift, ctrl: false }
    for (const k of keysOf(board(layer, shift))) {
      const p = pressKey(state, k)
      if (p.out?.kind === 'stroke' && p.out.stroke.text) reach.add(p.out.stroke.text)
    }
  }
  const missing: string[] = []
  for (let c = 0x20; c < 0x7f; c++) if (!reach.has(String.fromCharCode(c))) missing.push(String.fromCharCode(c))
  assert.deepEqual(missing, [])
})

test('Shift is for one letter, then locked, then off', () => {
  assert.equal(typed(['shift', 'h', 'i']), 'Hi')
  assert.equal(typed(['shift', 'shift', 'o', 'k', 'shift', 'a', 'y']), 'OKay')
  assert.equal(run(['shift']).state.shift, 'once')
  assert.equal(run(['shift', 'shift']).state.shift, 'lock')
  assert.equal(run(['shift', 'shift', 'shift']).state.shift, 'off')
  // A key that is not a letter does not use a one-letter Shift up: "- N" still gets its capital.
  assert.equal(typed(['shift', '-', 'space', 'n', 'o']), '- No')
  // The letters show what they will type.
  assert.equal(key(board('letters', 'once'), 'q').label, 'Q')
  assert.equal(key(board('letters', 'off'), 'q').label, 'q')
  const up = pressKey({ ...KEYS_START, shift: 'once' }, key(board('letters', 'once'), 'q'))
  assert.deepEqual(up.out, { kind: 'stroke', stroke: { key: 'Q', code: 'KeyQ', text: 'Q', shift: true, ctrl: false } })
})

test('Enter and Tab carry Shift; the caret keys neither carry it nor use it up', () => {
  const enter = run(['shift', 'Enter'])
  assert.deepEqual(enter.out, [{ key: 'Enter', code: 'Enter', text: '', shift: true, ctrl: false }], 'Shift+Enter: a new line at the prompt')
  assert.equal(enter.state.shift, 'off')
  assert.deepEqual(run(['Enter']).out, [{ key: 'Enter', code: 'Enter', text: '', shift: false, ctrl: false }])
  const caps = run(['shift', 'shift', 'h', 'Enter', 'Tab'])
  assert.deepEqual((caps.out as { key: string; shift: boolean }[]).map((o) => [o.key, o.shift]), [['H', true], ['Enter', false], ['Tab', false]], 'caps lock: Enter runs the line, Tab goes forward')
  assert.equal(caps.state.shift, 'lock')
  const moved = run(['shift', 'ArrowLeft', 'Backspace'])
  assert.deepEqual(moved.out, [
    { key: 'ArrowLeft', code: 'ArrowLeft', text: '', shift: false, ctrl: false },
    { key: 'Backspace', code: 'Backspace', text: '', shift: false, ctrl: false },
  ])
  assert.equal(moved.state.shift, 'once', 'the capital is still owed')
  assert.deepEqual(run(['shift', 'Escape']).out, [{ key: 'Escape', code: 'Escape', text: '', shift: false, ctrl: false }])
})

test('Ctrl holds for one key: a chord types nothing, and Ctrl+V asks for a paste', () => {
  assert.deepEqual(run(['ctrl', 'c', 'c']).out, [
    { key: 'c', code: 'KeyC', text: '', shift: false, ctrl: true },
    { key: 'c', code: 'KeyC', text: 'c', shift: false, ctrl: false },
  ])
  assert.deepEqual(run(['ctrl', 'v']).out, ['paste'])
  assert.equal(run(['ctrl', 'ctrl']).state.ctrl, false, 'pressed again, it lets go')
  assert.equal(run(['ctrl', 'layer:numbers']).state.ctrl, false)
  assert.deepEqual(run(['ctrl', 'Backspace']).out, [{ key: 'Backspace', code: 'Backspace', text: '', shift: false, ctrl: true }])
  // With Shift locked the chord is still the plain letter's: Ctrl+C, never a capital typed.
  assert.deepEqual(run(['shift', 'shift', 'ctrl', 'l']).out, [{ key: 'l', code: 'KeyL', text: '', shift: false, ctrl: true }])
})

test('the layer keys walk letters, numbers and symbols and back', () => {
  assert.equal(run(['layer:numbers']).state.layer, 'numbers')
  assert.equal(run(['layer:numbers', 'layer:symbols']).state.layer, 'symbols')
  assert.equal(run(['layer:numbers', 'layer:symbols', 'layer:numbers']).state.layer, 'numbers')
  assert.equal(run(['layer:numbers', 'layer:symbols', 'layer:letters']).state.layer, 'letters')
  assert.equal(typed(['c', 'd', 'space', 'layer:numbers', '1', '_', 'layer:letters', 'a']), 'cd 1_a')
  assert.equal(run(['shift', 'layer:numbers', 'layer:letters']).state.shift, 'off', 'a one-letter Shift does not outlive a trip to the numbers')
  assert.equal(run(['shift', 'shift', 'layer:numbers', 'layer:letters']).state.shift, 'lock', 'a locked one does')
  assert.deepEqual(run(['hide', 'accent']).out, ['hide', 'accent'])
  const system = keysOf(board('letters', 'off', true)).find(k => k.kind === 'system')!
  assert.deepEqual(pressKey({ ...KEYS_START, ctrl: true }, system), { state: KEYS_START, out: { kind: 'system' } })
})

test('Enter says what the field will do with it, and the system key takes its room from the space bar', () => {
  assert.equal(key(board('letters', 'off', false, 'go'), 'Enter').label, 'Go')
  assert.equal(key(board('letters', 'off', false, 'SEND'), 'Enter').label, 'Send')
  assert.equal(key(board('letters', 'off', false, 'go'), 'Enter').icon, undefined)
  assert.equal(key(board('letters', 'off', false, ''), 'Enter').icon, 'enter')
  assert.equal(key(board('letters', 'off', false, 'enter'), 'Enter').icon, 'enter')
  assert.equal(key(board('letters', 'off', false), 'space').w, 8)
  assert.equal(key(board('letters', 'off', true), 'space').w, 6)
  assert.ok(keysOf(board('letters', 'off', true)).some(k => k.kind === 'system'))
  assert.ok(!keysOf(board('letters', 'off', false)).some(k => k.kind === 'system'))
})

test('the highlight wraps along a row and keeps its column across rows', () => {
  const b = board()
  const at = (c: Cursor): string => keyAt(b, c).id
  const go = (c: Cursor, ...dirs: StepDir[]): Cursor => dirs.reduce((x, d) => stepCursor(b, x, d), c)
  const g = cursorOn(b, 'g')!
  assert.equal(at(g), 'g')
  assert.equal(at(go(g, 'right')), 'h')
  assert.equal(at(go(cursorOn(b, 'p')!, 'right')), 'q', 'off the right end, on at the left')
  assert.equal(at(go(cursorOn(b, 'q')!, 'left')), 'p')
  // Down through the space bar and up again: home.
  assert.equal(at(go(g, 'down')), 'v')
  assert.equal(at(go(g, 'down', 'down')), 'space')
  assert.equal(at(go(g, 'down', 'down', 'up', 'up')), 'g')
  // And from a key at the edge, past wide keys.
  const p = cursorOn(b, 'p')!
  assert.equal(at(go(p, 'down')), 'l')
  assert.equal(at(go(p, 'down', 'down')), 'Backspace')
  assert.equal(at(go(p, 'down', 'down', 'down')), 'hide')
  assert.equal(at(go(p, 'down', 'down', 'down', 'up', 'up', 'up')), 'p')
  // The top wraps to the bottom.
  assert.equal(at(go(cursorOn(b, 'Escape')!, 'up')), 'layer:numbers')
  assert.equal(at(go(cursorOn(b, 'space')!, 'down')), keyAt(b, { row: 0, index: 0, x: cursorOn(b, 'space')!.x }).id)
  // Every key can be reached from every other by steps.
  const seen = new Set<string>()
  const queue: Cursor[] = [g]
  while (queue.length) {
    const c = queue.pop()!
    const id = at(c)
    if (seen.has(id)) continue
    seen.add(id)
    for (const d of ['left', 'right', 'up', 'down'] as const) queue.push(stepCursor(b, cursorOn(b, id)!, d))
  }
  assert.equal(seen.size, keysOf(b).length)
  assert.equal(cursorOn(b, 'no such key'), null)
})

test('the highlight lands on the key that stands in its place when the layer changes', () => {
  const letters = board('letters'), numbers = board('numbers')
  const onE = cursorOn(letters, 'e')!
  assert.equal(keyAt(numbers, fitCursor(numbers, onE)).id, '3')
  const onL = cursorOn(letters, 'l')!
  assert.equal(keyAt(numbers, fitCursor(numbers, onL)).id, ')', 'the half-column offset row maps onto the full one: a key on the seam goes right')
  assert.equal(keyAt(numbers, fitCursor(numbers, cursorOn(letters, 'a')!)).id, '@')
  const onShift = cursorOn(letters, 'shift')!
  assert.equal(keyAt(numbers, fitCursor(numbers, onShift)).id, 'layer:symbols')
  // A cursor from a longer row is fitted, never out of range.
  const stale: Cursor = { row: 9, index: 42, x: 19.5 }
  assert.equal(keyAt(letters, stale).id, 'hide')
  assert.equal(keyAt(letters, { row: -3, index: -1, x: -5 }).id, 'Escape')
})

test('a letter cycles through its accents and comes home, capitals among capitals', () => {
  const ring = (c: string): string[] => {
    const out = [c]
    for (let n = nextAccent(c); n !== null && n !== c && out.length < 40; n = nextAccent(n)) out.push(n)
    return out
  }
  assert.deepEqual(ring('e'), ['e', 'é', 'è', 'ê', 'ë', 'ē', 'ę', 'ě'])
  assert.deepEqual(ring('E'), ['E', 'É', 'È', 'Ê', 'Ë', 'Ē', 'Ę', 'Ě'])
  assert.deepEqual(ring('s'), ['s', 'ß', 'ś', 'š', 'ş'])
  assert.deepEqual(ring('S'), ['S', 'Ś', 'Š', 'Ş'], 'the sharp s has no capital of one character')
  assert.equal(nextAccent('n'), 'ñ')
  assert.equal(nextAccent('ü'), 'ū')
  assert.equal(nextAccent('é'), 'è', 'a letter typed with a combining accent is the same letter')
  for (const c of ['b', '1', ' ', '-', '', '\u{1F600}', 'ab']) assert.equal(nextAccent(c), null, JSON.stringify(c))
  // Every form is one character, and every ring closes.
  for (const base of 'acdegilnorstuyzACDEGILNORSTUYZ') {
    const r = ring(base)
    assert.ok(r.length > 1 && r.length < 40, base)
    assert.equal(nextAccent(r[r.length - 1]), base, `${base} comes home`)
    for (const c of r) assert.equal(Array.from(c).length, 1, c)
  }
})
