// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the "is there a keyboard?" judgement to its rules, device by device: a pad or
 * a headset in the hand gets the on-screen keys for every field; a keyboard or a mouse gets none; a finger on a
 * touch-first device gets them for a command field and the device's own keyboard for prose; a real keyboard typed
 * on lately keeps them down even under a finger, and ten minutes later no longer does; the setting overrides all of
 * it. And it holds the evidence to what a real keyboard alone can send: a phone's on-screen keyboard, a composition,
 * a remote's arrows and a script's made-up key never count. The hands the accessibility settings serve (a single
 * switch, a resting pointer) get the keys, and the switch's own key is not a keyboard. The keys open only when asked
 * for, fold to a chip under a card that must be answered first, and a press on them is never a touch of the page.
 * What breaks if it is removed? The keys could cover a laptop's console after a stray event, or stay down for a
 * player holding a pad, and nothing would notice the rule had changed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { insideKeys, isPhysicalKey, KEYBOARD_MEMORY_MS, KeyboardSense, keysServe, keysStand, KEYS_ROOT, type KeysFacts, type LastDevice, type SenseWindow, type StandFacts } from './keyboardSense.ts'

const facts = (over: Partial<KeysFacts> = {}): KeysFacts => ({ setting: 'auto', last: null, keyboardLately: false, touchFirst: false, codeField: false, ...over })

test('a pad or a headset in the hand gets the keys for every field', () => {
  for (const last of ['gamepad', 'headset'] as const) for (const codeField of [true, false]) for (const touchFirst of [true, false]) for (const keyboardLately of [true, false]) {
    assert.equal(keysServe(facts({ last, codeField, touchFirst, keyboardLately })), true, `${last} code=${codeField} touch=${touchFirst} kb=${keyboardLately}`)
  }
})

test('a keyboard or a mouse gets none', () => {
  for (const last of ['keyboard', 'mouse'] as const) for (const codeField of [true, false]) for (const touchFirst of [true, false]) {
    assert.equal(keysServe(facts({ last, codeField, touchFirst })), false, `${last} code=${codeField} touch=${touchFirst}`)
  }
})

test('a finger gets ours for a command field on a touch-first device, and the device\'s own keyboard for prose', () => {
  for (const last of ['touch', 'pen', null] as const) {
    assert.equal(keysServe(facts({ last, touchFirst: true, codeField: true })), true, `${last}: the prompt`)
    assert.equal(keysServe(facts({ last, touchFirst: true, codeField: false })), false, `${last}: a chat line keeps the phone's keyboard`)
    assert.equal(keysServe(facts({ last, touchFirst: false, codeField: true })), false, `${last}: a touch laptop has its keyboard`)
    assert.equal(keysServe(facts({ last, touchFirst: true, codeField: true, keyboardLately: true })), false, `${last}: a keyboard typed on lately is still there`)
  }
})

test('the setting overrides the evidence', () => {
  const all: (LastDevice | null)[] = ['keyboard', 'mouse', 'touch', 'pen', 'gamepad', 'headset', null]
  for (const last of all) for (const touchFirst of [true, false]) for (const codeField of [true, false]) {
    assert.equal(keysServe(facts({ setting: 'on', last, touchFirst, codeField, keyboardLately: true })), true)
    assert.equal(keysServe(facts({ setting: 'off', last, touchFirst, codeField })), false)
  }
})

test('only a real keyboard\'s key is evidence of one', () => {
  const key = (code: string, k: string, over: object = {}) => ({ isTrusted: true, code, key: k, keyCode: 65, isComposing: false, ...over })
  for (const [code, k] of [['KeyA', 'a'], ['Digit4', '4'], ['Space', ' '], ['Backquote', '`'], ['Slash', '/'], ['ShiftLeft', 'Shift'], ['ControlRight', 'Control'],
    ['MetaLeft', 'Meta'], ['AltRight', 'AltGraph'], ['CapsLock', 'CapsLock'], ['Numpad7', '7'], ['NumpadEnter', 'Enter'], ['IntlBackslash', '<'], ['IntlYen', '¥']]) {
    assert.equal(isPhysicalKey(key(code, k)), true, code)
  }
  // What a remote, a pad turned into keys, or an on-screen keyboard also sends.
  for (const [code, k] of [['ArrowUp', 'ArrowUp'], ['Enter', 'Enter'], ['Escape', 'Escape'], ['Tab', 'Tab'], ['Backspace', 'Backspace'], ['F5', 'F5'], ['BrowserBack', 'BrowserBack'], ['MediaPlayPause', 'MediaPlayPause']]) {
    assert.equal(isPhysicalKey(key(code, k)), false, code)
  }
  // A phone's own keyboard: no place on the board, or the composition key.
  assert.equal(isPhysicalKey(key('', 'a')), false)
  assert.equal(isPhysicalKey(key('', 'Unidentified', { keyCode: 229 })), false)
  assert.equal(isPhysicalKey(key('Unidentified', 'a')), false)
  assert.equal(isPhysicalKey(key('KeyA', 'Process', { keyCode: 229 })), false)
  assert.equal(isPhysicalKey(key('KeyA', 'a', { isComposing: true })), false)
  assert.equal(isPhysicalKey(key('BracketLeft', 'Dead')), false, 'a dead key is half a character: the next key says more')
  // A key a script made (the on-screen keys' own strokes).
  assert.equal(isPhysicalKey(key('KeyA', 'a', { isTrusted: false })), false)
})

/** A window's events, media queries and touch points, for the watcher. */
function fakeWindow(opts: { coarse?: boolean; touchPoints?: number } = {}): SenseWindow & { fire(type: string, fields: object): void; listeners: Map<string, Set<(e: Event) => void>> } {
  const listeners = new Map<string, Set<(e: Event) => void>>()
  return {
    listeners,
    addEventListener(type, listener) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(listener) },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
    matchMedia: (q: string) => ({ matches: q === '(pointer: coarse)' && opts.coarse === true }),
    navigator: { maxTouchPoints: opts.touchPoints ?? 0 },
    fire(type, fields) { for (const l of listeners.get(type) ?? []) l({ isTrusted: true, ...fields } as unknown as Event) },
  }
}

test('the watcher follows the device in use and remembers a keyboard for ten minutes', () => {
  let now = 1000
  const win = fakeWindow({ coarse: true, touchPoints: 5 })
  const sense = new KeyboardSense(win, () => now)
  let changes = 0
  sense.onChange = () => { changes++ }
  assert.equal(sense.last, null)
  assert.equal(sense.touchFirst, true)
  assert.equal(sense.keyboardLately, false)
  assert.equal(keysServe(sense.facts('auto', true)), true, 'a phone\'s prompt, before anything is touched')

  win.fire('pointerdown', { pointerType: 'touch' })
  assert.equal(sense.last, 'touch')
  assert.equal(changes, 1)
  win.fire('pointerdown', { pointerType: 'touch' })
  assert.equal(changes, 1, 'the same device again changes nothing')
  assert.equal(keysServe(sense.facts('auto', true)), true)
  assert.equal(keysServe(sense.facts('auto', false)), false)

  // The phone's own keyboard types: no evidence, nothing changes.
  win.fire('keydown', { code: '', key: 'Unidentified', keyCode: 229 })
  win.fire('keydown', { code: '', key: 'Enter', keyCode: 13 })
  assert.equal(sense.last, 'touch')
  assert.equal(sense.keyboardLately, false)

  // An iPhone's own keyboard sends real codes into the chat line it serves: no evidence either.
  const chat = { tagName: 'INPUT', getAttribute: () => null }
  win.fire('keydown', { code: 'KeyH', key: 'h', keyCode: 72, target: chat })
  assert.equal(sense.last, 'touch', 'the phone\'s keyboard in a field it serves is not a keyboard clipped on')
  assert.equal(sense.keyboardLately, false)

  // A keyboard clipped on and typed on: into the prompt ours keep the phone's keyboard down for.
  const prompt = { tagName: 'TEXTAREA', getAttribute: (n: string) => (n === 'inputmode' ? 'none' : null) }
  win.fire('keydown', { code: 'KeyL', key: 'l', keyCode: 76, target: prompt })
  assert.equal(sense.last, 'keyboard')
  assert.equal(changes, 2)
  // Every real key is told, so keys opened while the keyboard was already the last device go away at the next one.
  win.fire('keydown', { code: 'KeyS', key: 's', keyCode: 83, target: prompt })
  assert.equal(changes, 3, 'the keyboard again is still told')
  assert.equal(keysServe(sense.facts('auto', true)), false)
  win.fire('pointerdown', { pointerType: 'touch' })
  assert.equal(changes, 4)
  assert.equal(keysServe(sense.facts('auto', true)), false, 'a tap right after typing: the keyboard is still there')
  now += KEYBOARD_MEMORY_MS - 1
  assert.equal(sense.keyboardLately, true)
  now += 1
  assert.equal(sense.keyboardLately, false)
  assert.equal(keysServe(sense.facts('auto', true)), true, 'ten minutes on, the finger gets the keys again')

  // A pad's button, told by whoever reads the pads.
  sense.note('gamepad')
  assert.equal(sense.last, 'gamepad')
  assert.equal(keysServe(sense.facts('auto', false)), true)
  win.fire('pointerdown', { pointerType: 'mouse' })
  assert.equal(sense.last, 'mouse')
  win.fire('pointerdown', { pointerType: 'pen' })
  assert.equal(sense.last, 'pen')
  sense.note('headset')
  assert.equal(sense.last, 'headset')

  // A script's events are not the player's.
  win.fire('keydown', { isTrusted: false, code: 'KeyA', key: 'a' })
  win.fire('pointerdown', { isTrusted: false, pointerType: 'mouse' })
  assert.equal(sense.last, 'headset')
})

test('a touch laptop is not touch-first, and a window without media queries is not either', () => {
  assert.equal(new KeyboardSense(fakeWindow({ coarse: false, touchPoints: 10 })).touchFirst, false)
  assert.equal(new KeyboardSense(fakeWindow({ coarse: true, touchPoints: 0 })).touchFirst, false, 'a coarse pointer with no touch screen: a TV\'s remote')
  const bare: SenseWindow = { addEventListener() {}, removeEventListener() {} }
  assert.equal(new KeyboardSense(bare).touchFirst, false)
  const throwing: SenseWindow = { addEventListener() {}, removeEventListener() {}, matchMedia: () => { throw new Error('no') }, navigator: { maxTouchPoints: 5 } }
  assert.equal(new KeyboardSense(throwing).touchFirst, false)
})

test('the watcher lets go of the window', () => {
  const win = fakeWindow()
  const sense = new KeyboardSense(win)
  assert.equal(win.listeners.get('keydown')?.size, 1)
  assert.equal(win.listeners.get('pointerdown')?.size, 1)
  sense.dispose()
  assert.equal(win.listeners.get('keydown')?.size, 0)
  assert.equal(win.listeners.get('pointerdown')?.size, 0)
  win.fire('keydown', { code: 'KeyA', key: 'a' })
  assert.equal(sense.last, null)
})

test('a single switch or a resting pointer gets the keys: neither has a keyboard to reach for', () => {
  for (const hands of [{ scan: true }, { dwell: true }]) for (const last of ['mouse', 'touch', 'pen', null] as const) for (const codeField of [true, false]) {
    assert.equal(keysServe(facts({ ...hands, last, codeField })), true, `${JSON.stringify(hands)} ${last} code=${codeField}`)
  }
  // Typing on a real keyboard still says there is one.
  assert.equal(keysServe(facts({ scan: true, last: 'keyboard' })), false)
  assert.equal(keysServe(facts({ dwell: true, last: 'keyboard' })), false)
  assert.equal(keysServe(facts({ scan: true, setting: 'off', last: 'touch' })), false, 'the player\'s word still wins')
})

test('the switch\'s own key is never evidence of a keyboard', () => {
  const key = (code: string, k: string) => ({ isTrusted: true, code, key: k, keyCode: 32, isComposing: false })
  assert.equal(isPhysicalKey(key('Space', ' ')), true)
  assert.equal(isPhysicalKey(key('Space', ' '), 'Space'), false)
  assert.equal(isPhysicalKey(key('KeyA', 'a'), 'Space'), true, 'any other key still is')
  let now = 0
  const win = fakeWindow()
  const sense = new KeyboardSense(win, () => now)
  sense.switchCode = 'Space'
  win.fire('keydown', { code: 'Space', key: ' ', keyCode: 32 })
  assert.equal(sense.last, null)
  assert.equal(sense.keyboardLately, false)
  win.fire('keydown', { code: 'KeyH', key: 'h', keyCode: 72 })
  assert.equal(sense.last, 'keyboard')
  now += 1
})

test('the keys stand open only when asked for, and fold to a chip under a card that must be answered first', () => {
  const stand = (over: Partial<StandFacts> = {}) => keysStand({ field: true, serve: true, yielded: false, wanted: true, blocked: false, ...over })
  assert.equal(stand(), 'open')
  assert.equal(stand({ wanted: false }), 'peek', 'a card took the focus by itself: offered, not thrown open')
  assert.equal(stand({ blocked: true }), 'peek', 'an OK card is up: its buttons first')
  assert.equal(stand({ field: false }), 'hidden')
  assert.equal(stand({ serve: false }), 'hidden', 'a keyboard in use: nothing drawn')
  assert.equal(stand({ yielded: true }), 'hidden', 'handed to the device\'s own keyboard')
  assert.equal(stand({ field: false, wanted: true, blocked: true }), 'hidden')
})

test('a press on the on-screen keys is typing, not a touch of the page', () => {
  const keyEl = { closest: (sel: string) => (sel === `[${KEYS_ROOT}]` ? {} : null) }
  const pageEl = { closest: () => null }
  assert.equal(insideKeys(keyEl), true)
  assert.equal(insideKeys(pageEl), false)
  assert.equal(insideKeys(null), false)
  assert.equal(insideKeys({}), false, 'a target that is no element (the window) is outside')
  let now = 5
  const win = fakeWindow({ coarse: true, touchPoints: 5 })
  const sense = new KeyboardSense(win, () => now)
  sense.note('gamepad')
  win.fire('pointerdown', { pointerType: 'touch', target: keyEl })
  assert.equal(sense.last, 'gamepad', 'a thumb on the keys a pad opened does not hand the field to the phone\'s keyboard')
  assert.equal(sense.pointerAt, -Infinity)
  now = 9
  win.fire('pointerdown', { pointerType: 'touch', target: pageEl })
  assert.equal(sense.last, 'touch')
  assert.equal(sense.pointerAt, 9)
})

test('the facts carry the hands the accessibility settings serve', () => {
  const sense = new KeyboardSense(fakeWindow())
  assert.deepEqual(sense.facts('auto', true), { setting: 'auto', last: null, keyboardLately: false, touchFirst: false, codeField: true, scan: false, dwell: false })
  assert.equal(sense.facts('on', false, { scan: true }).scan, true)
  assert.equal(sense.facts('on', false, { dwell: true }).dwell, true)
})
