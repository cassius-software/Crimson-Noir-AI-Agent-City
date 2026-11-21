// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the pad's way of typing on the on-screen keys to its rules: a press is one
 * edge, a held control acts again after a pause and then steadily (and only the controls meant to), whatever is down
 * when the keys take the pad does nothing until let go (the button that opened them above all), a stick steps once
 * per tilt with no chatter at the threshold and no flip between axes on a diagonal, a trigger hovering at its edge
 * presses once, the right stick is left to the microphone's mute with both hands, and each one-hand layout reaches
 * every control it is given with that hand's side of the pad alone.
 * What breaks if it is removed? The button that opened the keys could type a letter, a held stick could run the
 * highlight off in bursts or not at all, or a one-handed player could be handed a control on the wrong side.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PAD } from './gamepad.ts'
import { KEYS_PAD, KeysPad, keysLegend, padButtonsFor, type KeysPadLike, type PadControl } from './keysPad.ts'

function pad(pressed: number[] = [], axes: number[] = [0, 0, 0, 0], values: Record<number, number> = {}): KeysPadLike {
  return { axes, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: values[i] ?? (pressed.includes(i) ? 1 : 0) })) }
}
const asks = (k: KeysPad, p: KeysPadLike | KeysPadLike[], now: number, hand: 'both' | 'left' | 'right' = 'both'): string[] =>
  k.read(Array.isArray(p) ? p : [p], now, hand).map(a => a.repeat ? `${a.control}+` : a.control)

test('a press is one edge; what was down when the keys took the pad does nothing until let go', () => {
  const k = new KeysPad()
  // Select opened the keys and is still down on the first read; south too.
  assert.deepEqual(asks(k, pad([PAD.select, PAD.south]), 0), [])
  assert.deepEqual(asks(k, pad([PAD.select, PAD.south]), 16), [], 'still held: still nothing')
  assert.deepEqual(asks(k, pad([PAD.select, PAD.south]), 2000), [], 'however long')
  assert.deepEqual(asks(k, pad([PAD.south]), 2016), [], 'select let go; south still the old press')
  assert.deepEqual(asks(k, pad(), 2032), [])
  assert.deepEqual(asks(k, pad([PAD.select]), 2048), ['layer'], 'pressed again: the layer')
  assert.deepEqual(asks(k, pad([PAD.select]), 2064), [], 'held: once')
  assert.deepEqual(asks(k, pad([PAD.south]), 2080), ['press'])
  // After reset the next read learns again.
  k.reset()
  assert.deepEqual(asks(k, pad([PAD.east]), 3000), [])
  assert.deepEqual(asks(k, pad(), 3016), [])
  assert.deepEqual(asks(k, pad([PAD.east]), 3032), ['close'])
})

test('both hands: every control has its button', () => {
  const want: [number, PadControl][] = [
    [PAD.up, 'up'], [PAD.down, 'down'], [PAD.left, 'left'], [PAD.right, 'right'], [PAD.south, 'press'], [PAD.east, 'close'], [PAD.west, 'back'],
    [PAD.north, 'space'], [PAD.l1, 'caretLeft'], [PAD.r1, 'caretRight'], [PAD.l2, 'shift'], [PAD.r2, 'enter'], [PAD.start, 'enter'], [PAD.select, 'layer'],
  ]
  for (const [button, control] of want) {
    const k = new KeysPad()
    k.read([pad()], 0)
    assert.deepEqual(asks(k, pad([button]), 16), [control], `button ${button}`)
    assert.ok(padButtonsFor('both', control).includes(button))
  }
  // A trigger a browser reports by value alone still presses, and one hovering at the edge presses once.
  const k = new KeysPad()
  k.read([pad()], 0)
  assert.deepEqual(asks(k, pad([], [0, 0, 0, 0], { [PAD.r2]: 0.9 }), 16), ['enter'])
  assert.deepEqual(asks(k, pad([PAD.r2], [0, 0, 0, 0], { [PAD.r2]: 0.5 }), 32), [], 'eased to the middle: still down')
  assert.deepEqual(asks(k, pad([], [0, 0, 0, 0], { [PAD.r2]: 0.45 }), 48), [], 'the browser says released at 0.45; the keys wait for 0.4')
  assert.deepEqual(asks(k, pad([PAD.r2], [0, 0, 0, 0], { [PAD.r2]: 0.55 }), 64), [], 'and back over the browser\'s threshold is not a second Enter')
  assert.deepEqual(asks(k, pad([], [0, 0, 0, 0], { [PAD.r2]: 0.1 }), 80), [])
  assert.deepEqual(asks(k, pad([PAD.r2], [0, 0, 0, 0], { [PAD.r2]: 0.55 }), 96), [], 'not yet squeezed past 0.6')
  assert.deepEqual(asks(k, pad([PAD.r2], [0, 0, 0, 0], { [PAD.r2]: 0.7 }), 112), ['enter'])
  assert.deepEqual(asks(k, pad(), 128), [], 'dropped to nothing in one frame')
  // A trigger that is a plain button: pressed, value 0.
  assert.deepEqual(asks(k, pad([PAD.l2], [0, 0, 0, 0], { [PAD.l2]: 0 }), 144), ['shift'])
  assert.deepEqual(asks(k, pad([], [0, 0, 0, 0], { [PAD.l2]: 0 }), 160), [])
  assert.deepEqual(asks(k, pad([PAD.l2], [0, 0, 0, 0], { [PAD.l2]: 0 }), 176), ['shift'])
  // The stick clicks and the home button are nobody's here (R3 stays the microphone's mute).
  for (const button of [PAD.l3, PAD.r3, 16]) {
    const q = new KeysPad()
    q.read([pad()], 0)
    assert.deepEqual(asks(q, pad([button]), 16), [], `button ${button}`)
  }
})

test('a held control acts again after a pause, then steadily; Shift, Enter, the layer and away act once', () => {
  const k = new KeysPad()
  k.read([pad()], 0)
  const held = pad([PAD.west, PAD.l2, PAD.right])
  assert.deepEqual(asks(k, held, 100), ['right', 'back', 'shift'])
  assert.deepEqual(asks(k, held, 100 + KEYS_PAD.delayMs - 1), [])
  assert.deepEqual(asks(k, held, 100 + KEYS_PAD.delayMs), ['right+', 'back+'], 'Shift does not repeat')
  assert.deepEqual(asks(k, held, 100 + KEYS_PAD.delayMs + KEYS_PAD.rateMs - 1), [])
  assert.deepEqual(asks(k, held, 100 + KEYS_PAD.delayMs + KEYS_PAD.rateMs), ['right+', 'back+'])
  // Let go and pressed again: the pause again.
  k.read([pad()], 2000)
  assert.deepEqual(asks(k, pad([PAD.west]), 2016), ['back'])
  assert.deepEqual(asks(k, pad([PAD.west]), 2016 + KEYS_PAD.rateMs), [])
  for (const once of [PAD.r2, PAD.start, PAD.select, PAD.east, PAD.l2]) {
    const q = new KeysPad()
    q.read([pad()], 0)
    assert.equal(asks(q, pad([once]), 16).length, 1)
    assert.deepEqual(asks(q, pad([once]), 5000), [], `button ${once} acts once however long it is held`)
  }
})

test('a stick steps once per tilt, holds through the threshold, and keeps its axis on a diagonal', () => {
  const k = new KeysPad()
  k.read([pad()], 0)
  const tilt = (x: number, y: number, now: number, right = false): string[] => asks(k, pad([], right ? [0, 0, x, y] : [x, y, 0, 0]), now)
  assert.deepEqual(tilt(0.5, 0, 16), [], 'not far enough')
  assert.deepEqual(tilt(0.7, 0, 32), ['right'])
  assert.deepEqual(tilt(0.5, 0, 48), [], 'eased back between the two thresholds: still held, no second step')
  assert.deepEqual(tilt(0.65, 0, 64), [])
  assert.deepEqual(tilt(0.3, 0, 80), [], 'at rest')
  assert.deepEqual(tilt(0.7, 0, 96), ['right'], 'tilted again: a step')
  // A diagonal that wobbles around 45 degrees keeps going right.
  assert.deepEqual(tilt(0.7, 0.75, 112), [])
  assert.deepEqual(tilt(0.7, 0.95, 128), ['down'], 'clearly down now: one step down')
  assert.deepEqual(tilt(0.9, 0.95, 144), [], 'and it keeps down')
  assert.deepEqual(tilt(0, 0, 160), [])
  // Up is negative y. Held, the stick repeats like the d-pad.
  assert.deepEqual(tilt(0, -1, 176), ['up'])
  assert.deepEqual(tilt(0, 0, 192), [])
  assert.deepEqual(tilt(-1, 0, 208), ['left'])
  assert.deepEqual(tilt(-1, 0, 208 + KEYS_PAD.delayMs), ['left+'])
  assert.deepEqual(tilt(0, 0, 1000), [])
  // With both hands the right stick steps nothing: its click is the microphone's mute, and a push must not move the highlight under it.
  assert.deepEqual(tilt(-1, 0, 1016, true), [])
  assert.deepEqual(tilt(0, 1, 1032, true), [])
})

test('a stick held over when the keys open waits to be centred, and two pads are one pair of hands', () => {
  const k = new KeysPad()
  assert.deepEqual(asks(k, pad([], [0, 1, 0, 0]), 0), [], 'walking forward as the keys opened')
  assert.deepEqual(asks(k, pad([], [0, 1, 0, 0]), 500), [])
  assert.deepEqual(asks(k, pad(), 516), [])
  assert.deepEqual(asks(k, pad([], [0, 1, 0, 0]), 532), ['down'])
  const q = new KeysPad()
  q.read([pad(), pad()], 0)
  assert.deepEqual(asks(q, [pad([PAD.south]), pad([PAD.south])], 16), ['press'], 'the same button on two pads: one press')
  assert.deepEqual(asks(q, [pad(), pad([PAD.south])], 32), [], 'still held on one of them')
  assert.deepEqual(asks(q, [pad(), null as unknown as KeysPadLike], 48), [])
})

test('one hand: every control it is given sits on that hand\'s side', () => {
  const LEFT_SIDE = new Set<number>([PAD.l1, PAD.l2, PAD.l3, PAD.up, PAD.down, PAD.left, PAD.right, PAD.select, PAD.start])
  const RIGHT_SIDE = new Set<number>([PAD.r1, PAD.r2, PAD.r3, PAD.south, PAD.east, PAD.west, PAD.north, PAD.select, PAD.start])
  const all: PadControl[] = ['up', 'down', 'left', 'right', 'press', 'back', 'space', 'close', 'caretLeft', 'caretRight', 'shift', 'enter', 'layer']
  for (const c of all) {
    for (const b of padButtonsFor('left', c)) assert.ok(LEFT_SIDE.has(b), `left ${c}: button ${b}`)
    for (const b of padButtonsFor('right', c)) assert.ok(RIGHT_SIDE.has(b), `right ${c}: button ${b}`)
  }
  // Each hand can step, press a key, delete, enter and turn the layer without the board.
  for (const hand of ['left', 'right'] as const) for (const c of ['press', 'back', 'enter', 'layer'] as const) assert.ok(padButtonsFor(hand, c).length > 0, `${hand} ${c}`)
  // The left hand: its stick or the d-pad steps, L2 presses, L1 deletes, start enters, select turns the layer.
  const l = new KeysPad()
  l.read([pad()], 0, 'left')
  assert.deepEqual(asks(l, pad([PAD.l2]), 16, 'left'), ['press'])
  assert.deepEqual(asks(l, pad([PAD.l1]), 32, 'left'), ['back'])
  assert.deepEqual(asks(l, pad([PAD.start]), 48, 'left'), ['enter'])
  assert.deepEqual(asks(l, pad([PAD.select]), 64, 'left'), ['layer'])
  assert.deepEqual(asks(l, pad([PAD.down]), 80, 'left'), ['down'])
  assert.deepEqual(asks(l, pad([], [1, 0, 0, 0]), 96, 'left'), ['right'])
  assert.deepEqual(asks(l, pad([PAD.south, PAD.east], [0, 0, 1, 0]), 112, 'left'), [], 'the right side is not this hand\'s')
  // The right hand: its stick steps, its face buttons as with both hands, and R2 presses and R1 deletes too.
  const r = new KeysPad()
  r.read([pad()], 0, 'right')
  assert.deepEqual(asks(r, pad([], [0, 0, 0, 1]), 16, 'right'), ['down'])
  assert.deepEqual(asks(r, pad([PAD.south]), 32, 'right'), ['press'])
  assert.deepEqual(asks(r, pad([PAD.r2]), 40, 'right'), [], 'two buttons of one control, one handed to the other: one press, not two')
  assert.deepEqual(asks(r, pad(), 44, 'right'), [])
  assert.deepEqual(asks(r, pad([PAD.r2]), 48, 'right'), ['press'])
  assert.deepEqual(asks(r, pad([PAD.r1]), 64, 'right'), ['back'])
  assert.deepEqual(asks(r, pad([PAD.east]), 80, 'right'), ['close'])
  assert.deepEqual(asks(r, pad([PAD.north]), 96, 'right'), ['space'])
  assert.deepEqual(asks(r, pad([PAD.start]), 112, 'right'), ['enter'])
  assert.deepEqual(asks(r, pad([PAD.l1, PAD.l2, PAD.down], [1, 0, 0, 0]), 128, 'right'), [], 'the left side is not this hand\'s')
})

test('the legend names each control by the pad\'s own printed buttons, for each hand', () => {
  const words = (items: readonly { buttons: string; word: string }[]) => items.map((i) => `${i.buttons} ${i.word}`).join(' · ')
  assert.equal(words(keysLegend('abxy', 'both')), 'D-pad, left stick move · A type · X delete · Y space · LB RB caret · LT shift · RT Menu enter · View symbols · B hide')
  assert.equal(words(keysLegend('bayx', 'both')), 'D-pad, left stick move · B type · Y delete · X space · L R caret · ZL shift · ZR + enter · − symbols · A hide')
  assert.equal(words(keysLegend('numbered', 'both')), 'D-pad, left stick move · South type · West delete · North space · L1 R1 caret · L2 shift · R2 Start enter · Select symbols · East hide')
  assert.equal(words(keysLegend('generic', 'left')), 'D-pad, left stick move · LT type · LB delete · Start enter · Select symbols')
  assert.equal(words(keysLegend('abxy', 'right')), 'Right stick move · A RT type · X RB delete · Y space · Menu enter · View symbols · B hide')
})
