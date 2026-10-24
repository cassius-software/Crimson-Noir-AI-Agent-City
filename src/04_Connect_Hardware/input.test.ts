// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It drives the real Input class through a minimal fake DOM (document, window and
 * canvas as EventTargets, pointer capture and pointer lock simulated) to prove the first-person look
 * contract: no zoom and no wheel handling, dragging with the primary button turns the head without pointer
 * lock, a click (no drag) captures the pointer, pitch is clamped to ±PITCH_LIMIT, the terminal and lost
 * focus end a drag, touch drag uses first-person sensitivity, the right stick turns the head,
 * `padFamily` follows the controller used last, the ping is one edge from Q, the middle mouse button
 * (never a drag) and a pad's right shoulder, a Command chord holds no key, Space and the arrows never click a
 * button a pointer press left focused (one reached with Tab keeps Space; decided when the focus moves, since Chromium
 * reads every keydown as keyboard use, and kept when the window's focus comes back or a key repeats through a tap),
 * raw mouse counts are asked for and a driver's spike is dropped (judged by rate, so a busy frame's merged movement,
 * a turn from rest, a long frame out of rest and a 125 Hz mouse on a 240 Hz screen are kept, a jump out of stillness
 * is not, and never two in a row), and a mouse
 * puts a touch laptop's overlay away, Run toggle and all, but never a touch-first tablet's (until its primary pointer
 * turns fine).
 * What breaks if it is removed? A regression to orbit-camera input (a wheel zoom, a click that must come
 * first, an unclamped pitch that flips the view) could ship unnoticed.
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { HalBus } from './hal.ts'
import { Input, isEditableTarget, LOOK, PITCH_LIMIT } from './input.ts'
import { PAD } from './gamepad.ts'
import { KEYBOARD_SEAT } from './seats.ts'
import type { GamepadLike } from './web-hardware.d.ts'

class FakeDocument extends EventTarget {
  pointerLockElement: unknown = null
  visibilityState = 'visible'
  exitPointerLock(): void {
    this.pointerLockElement = null
    this.dispatchEvent(new Event('pointerlockchange'))
  }
}

class FakeCanvas extends EventTarget {
  readonly captured = new Set<number>()
  lockRequests = 0
  lockAllowed = true
  private readonly doc: FakeDocument
  constructor(doc: FakeDocument) {
    super()
    this.doc = doc
  }
  setPointerCapture(id: number): void { this.captured.add(id) }
  releasePointerCapture(id: number): void {
    if (this.captured.delete(id)) this.dispatchEvent(ev('lostpointercapture', { pointerId: id }))
  }
  hasPointerCapture(id: number): boolean { return this.captured.has(id) }
  requestPointerLock(): Promise<void> {
    this.lockRequests++
    if (!this.lockAllowed) return Promise.reject(new Error('NotAllowedError'))
    this.doc.pointerLockElement = this
    this.doc.dispatchEvent(new Event('pointerlockchange'))
    return Promise.resolve()
  }
}

function ev(type: string, props: Record<string, unknown> = {}): Event {
  return Object.assign(new Event(type), props)
}

const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
  ev(type, { pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, ...extra })

function pad(opts: { id?: string; index?: number; axes?: number[]; pressed?: number[] } = {}): GamepadLike {
  return {
    id: opts.id ?? 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)',
    index: opts.index ?? 0,
    connected: true,
    mapping: 'standard',
    timestamp: 1,
    axes: opts.axes ?? [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: !!opts.pressed?.includes(i), value: opts.pressed?.includes(i) ? 1 : 0 })),
  }
}

const g = globalThis as unknown as { document?: unknown; window?: unknown }
let doc: FakeDocument, win: EventTarget, canvas: FakeCanvas, pads: GamepadLike[], input: Input

beforeEach(() => {
  doc = new FakeDocument()
  win = new EventTarget()
  g.document = doc
  g.window = win
  canvas = new FakeCanvas(doc)
  pads = []
  const hal = new HalBus({ navigator: { getGamepads: () => pads } })
  input = new Input(canvas as unknown as HTMLCanvasElement, hal)
})

afterEach(() => {
  input.dispose()
  delete g.document
  delete g.window
})

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps

test('first person: no zoom, and the mouse wheel does nothing', () => {
  assert.equal('zoom' in input, false)
  const before = { yaw: input.yaw, pitch: input.pitch }
  const wheel = ev('wheel', { deltaY: 120 })
  canvas.dispatchEvent(wheel)
  assert.equal(wheel.defaultPrevented, false, 'the wheel is not captured')
  assert.deepEqual({ yaw: input.yaw, pitch: input.pitch }, before)
  assert.ok(close(PITCH_LIMIT, (85 * Math.PI) / 180))
})

test('zero-click look: dragging with the primary button turns the head without pointer lock', () => {
  const yaw0 = input.yaw, pitch0 = input.pitch
  canvas.dispatchEvent(mouse('pointerdown', 400, 300))
  assert.equal(input.dragging, true)
  assert.ok(canvas.captured.has(1), 'the drag keeps the pointer when it leaves the canvas')
  canvas.dispatchEvent(mouse('pointermove', 450, 280))
  canvas.dispatchEvent(mouse('pointermove', 500, 260))
  assert.ok(close(input.yaw, yaw0 - 100 * LOOK.mouse), 'dragging right turns right (yaw down)')
  assert.ok(close(input.pitch, pitch0 + 40 * LOOK.mouse), 'dragging up looks up')
  assert.ok(input.lastLook > 0)
  canvas.dispatchEvent(mouse('pointerup', 500, 260))
  assert.equal(input.dragging, false)
  assert.equal(canvas.captured.size, 0, 'capture released')
  assert.equal(canvas.lockRequests, 0, 'a drag never captures the pointer')
  assert.equal(input.locked, false)
})

test('a click (press and release without travel) captures the pointer; then plain mouse movement looks', async () => {
  canvas.dispatchEvent(mouse('pointerdown', 400, 300))
  canvas.dispatchEvent(mouse('pointermove', 402, 301))
  canvas.dispatchEvent(mouse('pointerup', 402, 301))
  assert.equal(canvas.lockRequests, 1)
  assert.equal(input.locked, true)
  assert.equal(input.engaged, true)
  const yaw = input.yaw
  doc.dispatchEvent(ev('mousemove', { movementX: -50, movementY: 0 }))
  assert.ok(close(input.yaw, yaw + 50 * LOOK.mouse), 'locked: movement turns the head with no button held')
  // While locked, presses do not start drags (and so do not double-count movement).
  canvas.dispatchEvent(mouse('pointerdown', 400, 300))
  assert.equal(input.dragging, false)
  canvas.dispatchEvent(mouse('pointermove', 600, 300))
  assert.ok(close(input.yaw, yaw + 50 * LOOK.mouse))
  // A denied lock (embedded page, too soon after Esc) is harmless: dragging still works.
  doc.exitPointerLock()
  canvas.lockAllowed = false
  canvas.dispatchEvent(mouse('pointerdown', 10, 10))
  canvas.dispatchEvent(mouse('pointerup', 10, 10))
  await Promise.resolve()
  assert.equal(input.locked, false)
  canvas.dispatchEvent(mouse('pointerdown', 10, 10))
  canvas.dispatchEvent(mouse('pointermove', 30, 10))
  assert.ok(close(input.yaw, yaw + 50 * LOOK.mouse - 20 * LOOK.mouse))
})

test('pitch is clamped to ±PITCH_LIMIT by every look source; yaw is not wrapped or clamped', () => {
  canvas.dispatchEvent(mouse('pointerdown', 0, 0))
  canvas.dispatchEvent(mouse('pointermove', 0, -100000))
  assert.equal(input.pitch, PITCH_LIMIT)
  canvas.dispatchEvent(mouse('pointermove', 0, 100000))
  assert.equal(input.pitch, -PITCH_LIMIT)
  canvas.dispatchEvent(mouse('pointerup', 0, 100000))
  input.touchLook(0, -1e6)
  assert.equal(input.pitch, PITCH_LIMIT)
  pads.push(pad({ axes: [0, 0, 0, 1] }))
  for (let i = 0; i < 200; i++) input.poll(1 / 60)
  assert.equal(input.pitch, -PITCH_LIMIT)
  input.touchLook(-1e4, 0)
  assert.ok(input.yaw > 40, 'yaw accumulates freely (unwrapped)')
})

test('only the primary mouse button drags; touch and pen engage the touch controls instead', () => {
  canvas.dispatchEvent(mouse('pointerdown', 0, 0, { button: 2, buttons: 2 }))
  assert.equal(input.dragging, false)
  canvas.dispatchEvent(mouse('pointerdown', 0, 0, { pointerType: 'touch' }))
  assert.equal(input.dragging, false)
  assert.equal(input.touch, true)
  assert.equal(input.device, 'touch')
  assert.equal(input.engaged, true)
})

test('ping: Q, the middle mouse button and the right shoulder queue one edge each; a field, the terminal and a held key never do', () => {
  const yaw = input.yaw
  doc.dispatchEvent(ev('keydown', { code: 'KeyQ', repeat: false }))
  assert.equal(input.take('ping'), true)
  assert.equal(input.take('ping'), false, 'one edge per press')
  doc.dispatchEvent(ev('keydown', { code: 'KeyQ', repeat: true }))
  assert.equal(input.take('ping'), false, 'a held key repeats nothing')
  const typed = ev('keydown', { code: 'KeyQ', repeat: false })
  Object.defineProperty(typed, 'target', { value: { tagName: 'INPUT' } })
  doc.dispatchEvent(typed)
  assert.equal(input.take('ping'), false, 'typing in a field')
  input.suspend(true)
  doc.dispatchEvent(ev('keydown', { code: 'KeyQ', repeat: false }))
  assert.equal(input.take('ping'), false, 'the terminal is open')
  input.suspend(false)

  const middle = Object.assign(new Event('pointerdown', { cancelable: true }), { pointerId: 1, pointerType: 'mouse', button: 1, buttons: 4, clientX: 0, clientY: 0 })
  canvas.dispatchEvent(middle)
  assert.equal(middle.defaultPrevented, true, 'no autoscroll')
  assert.equal(input.dragging, false, 'the middle button never drags')
  assert.equal(input.take('ping'), true)
  canvas.dispatchEvent(mouse('pointermove', 40, 0, { buttons: 4 }))
  assert.equal(input.yaw, yaw, 'moving with it held is not a look')
  assert.equal(canvas.lockRequests, 0)
  canvas.dispatchEvent(mouse('pointerup', 40, 0))
  assert.equal(canvas.lockRequests, 0, 'nor a click that captures the pointer')
  input.suspend(true)
  canvas.dispatchEvent(mouse('pointerdown', 0, 0, { button: 1, buttons: 4 }))
  assert.equal(input.take('ping'), false, 'suspended: ignored')
  input.suspend(false)

  pads.push(pad({ pressed: [PAD.r1] }))
  input.poll(1 / 60)
  assert.equal(input.take('ping'), true, 'right shoulder')
  input.poll(1 / 60)
  assert.equal(input.take('ping'), false, 'held')
  input.press('ping')
  assert.equal(input.take('ping'), true, 'the touch button and the harness press it')
})

test('a touch laptop: a finger brings the touch overlay, the mouse moving again puts it away', () => {
  assert.equal(input.touch, false, 'no coarse pointer here')
  canvas.dispatchEvent(ev('pointerdown', { pointerId: 7, pointerType: 'touch', button: 0, buttons: 1, clientX: 10, clientY: 10 }))
  assert.equal(input.touch, true)
  doc.dispatchEvent(ev('pointermove', { pointerType: 'touch', movementX: 5, movementY: 0 }))
  assert.equal(input.touch, true, 'a finger moving is not the mouse')
  doc.dispatchEvent(ev('pointermove', { pointerType: 'mouse', movementX: 0, movementY: 0 }))
  assert.equal(input.touch, true, 'a mouse event that did not move (a synthetic one) changes nothing')
  // The Run toggle left on goes with its button: the keyboard walks again until Shift.
  input.setTouchButton('run', true)
  input.poll(1 / 60)
  assert.equal(input.analog.run, true)
  assert.equal(input.mouseHidesTouch, true)
  doc.dispatchEvent(ev('pointermove', { pointerType: 'mouse', movementX: 3, movementY: -1 }))
  assert.equal(input.touch, false)
  assert.equal(input.device, 'keyboard+mouse')
  assert.equal(input.touchHeld('run'), false, 'the latch is let go with the overlay')
  input.poll(1 / 60)
  assert.equal(input.analog.run, false)
  // A tablet whose primary pointer is the finger keeps the overlay (and the latch) when a mouse moves.
  const m = globalThis as unknown as { matchMedia?: unknown }
  const query = { matches: true, change: null as (() => void) | null, addEventListener(_: string, f: () => void) { this.change = f }, removeEventListener() {} }
  m.matchMedia = () => query
  try {
    const tablet = new Input(canvas as unknown as HTMLCanvasElement, new HalBus({ navigator: { getGamepads: () => [] } }))
    assert.equal(tablet.mouseHidesTouch, false, 'its overlay takes a mouse press like a finger (TouchControls.tsx)')
    tablet.setTouchButton('run', true)
    doc.dispatchEvent(ev('pointermove', { pointerType: 'mouse', movementX: 3, movementY: -1 }))
    assert.equal(tablet.touch, true)
    assert.equal(tablet.touchHeld('run'), true)
    // A trackpad attached: the primary pointer is fine now, and the overlay goes, Run toggle and all.
    query.matches = false
    query.change?.()
    assert.equal(tablet.touch, false)
    assert.equal(tablet.touchHeld('run'), false, 'the latch goes with the overlay')
    tablet.dispose()
  } finally {
    delete m.matchMedia
  }
})

test('a Command chord holds nothing (macOS sends no keyup for its letter); Command coming up drops every held key', () => {
  doc.dispatchEvent(ev('keydown', { code: 'MetaLeft', metaKey: true }))
  doc.dispatchEvent(ev('keydown', { code: 'KeyA', metaKey: true }))
  doc.dispatchEvent(ev('keydown', { code: 'KeyE', metaKey: true, repeat: false }))
  doc.dispatchEvent(ev('keyup', { code: 'MetaLeft' }))
  assert.equal(input.down('KeyA'), false, 'Cmd+A is the system\'s')
  assert.equal(input.take('interact'), false, 'Cmd+E opens no door')
  // W held, then Command pressed and W let go under it (no keyup reaches the page): Command's keyup releases W.
  doc.dispatchEvent(ev('keydown', { code: 'KeyW' }))
  doc.dispatchEvent(ev('keydown', { code: 'MetaRight', metaKey: true }))
  assert.equal(input.down('KeyW'), true)
  doc.dispatchEvent(ev('keyup', { code: 'MetaRight' }))
  assert.equal(input.down('KeyW'), false)
  // Shift is a key of its own, chord or not.
  doc.dispatchEvent(ev('keydown', { code: 'ShiftRight', metaKey: true }))
  assert.equal(input.down('ShiftRight'), true)
})

test('Space and the arrows never click a button the mouse left focused (one reached with Tab keeps Space); the canvas has no context menu', () => {
  const key = (code: string, target?: object) => {
    const e = Object.assign(new Event('keydown', { cancelable: true }), { code, repeat: false })
    if (target) Object.defineProperty(e, 'target', { value: target })
    return e
  }
  // Chromium counts a key as keyboard use before the key's own event runs, so a button reads :focus-visible inside every
  // keydown, the first Space after a click included: how it was focused is decided when the focus moves.
  const button = () => ({ tagName: 'BUTTON', matches: (q: string) => q === ':focus-visible' })
  const focus = (target: object) => {
    const e = new Event('focusin')
    Object.defineProperty(e, 'target', { value: target })
    doc.dispatchEvent(e)
  }
  const clicked = button()
  doc.dispatchEvent(ev('pointerdown', { pointerType: 'mouse', button: 0 }))
  focus(clicked)
  for (const code of ['Space', 'ArrowUp', 'ArrowLeft']) {
    // Over a button the mouse clicked (it kept the focus): the game's, never a second click or a scroll.
    const e = key(code, clicked)
    doc.dispatchEvent(e)
    assert.equal(e.defaultPrevented, true, code)
    assert.equal(input.down(code), true, code)
    // Nothing focused: there is no default to stop, so the Concierge still reads the key as movement.
    const page = key(code, { tagName: 'BODY', matches: () => false })
    doc.dispatchEvent(page)
    assert.equal(page.defaultPrevented, false, `${code} on the page`)
  }
  // Tab on to a Concierge chip: Space presses it, as the keyboard does everywhere.
  doc.dispatchEvent(key('Tab', clicked))
  const chip = button()
  focus(chip)
  const tabbed = key('Space', chip)
  doc.dispatchEvent(tabbed)
  assert.equal(tabbed.defaultPrevented, false, 'a button reached with Tab keeps Space')
  // Clicked once it has the focus (the focus does not move, so no focusin comes): Space is the game's again.
  const focused = doc as unknown as { activeElement?: object }
  focused.activeElement = chip
  const click = ev('pointerdown', { pointerType: 'mouse', button: 0 })
  Object.defineProperty(click, 'target', { value: chip })
  doc.dispatchEvent(click)
  delete focused.activeElement
  const again = key('Space', chip)
  doc.dispatchEvent(again)
  assert.equal(again.defaultPrevented, true, 'the same button clicked after Tab')
  // Any key, then Alt+Tab away and back: the window's focus comes back to the button with a focusin of its own, and
  // the button stays the pointer's.
  doc.dispatchEvent(key('AltLeft', chip))
  win.dispatchEvent(new Event('blur'))
  focus(chip)
  const back = key('Space', chip)
  doc.dispatchEvent(back)
  assert.equal(back.defaultPrevented, true, 'back from another window, still the pointer\'s')
  // Pressed with a finger while W is held: a tap focuses only once the finger lifts, after the key's repeats.
  doc.dispatchEvent(Object.assign(key('KeyW', { tagName: 'BODY', matches: () => false }), { repeat: true }))
  doc.dispatchEvent(ev('click'))
  doc.dispatchEvent(ev('pointerdown', { pointerType: 'touch', button: 0 }))
  doc.dispatchEvent(Object.assign(key('KeyW', { tagName: 'BODY', matches: () => false }), { repeat: true }))
  const run = button()
  focus(run)
  doc.dispatchEvent(ev('click'))
  const held = key('Space', run)
  doc.dispatchEvent(held)
  assert.equal(held.defaultPrevented, true, 'a key held through a tap leaves the tap\'s focus the pointer\'s')
  // The press over (its click came), a focus that follows is not the pointer's: Space presses it.
  const later = button()
  focus(later)
  const moved = key('Space', later)
  doc.dispatchEvent(moved)
  assert.equal(moved.defaultPrevented, false, 'a focus after the press ended is the keyboard\'s')
  // A finger's tap focuses like a click.
  doc.dispatchEvent(ev('pointerdown', { pointerType: 'touch', button: 0 }))
  const menuButton = button()
  focus(menuButton)
  const tapped = key('Space', menuButton)
  doc.dispatchEvent(tapped)
  assert.equal(tapped.defaultPrevented, true, 'a tapped button')
  // Under pointer lock every Space and arrow is the game's.
  canvas.dispatchEvent(mouse('pointerdown', 0, 0))
  canvas.dispatchEvent(mouse('pointerup', 0, 0))
  assert.equal(input.locked, true)
  const locked = key('Space', { tagName: 'BODY', matches: () => false })
  doc.dispatchEvent(locked)
  assert.equal(locked.defaultPrevented, true, 'locked')
  doc.exitPointerLock()
  const w = key('KeyW', menuButton)
  doc.dispatchEvent(w)
  assert.equal(w.defaultPrevented, false, 'letters keep their default')
  const typed = key('Space', { tagName: 'TEXTAREA' })
  doc.dispatchEvent(typed)
  assert.equal(typed.defaultPrevented, false, 'a space typed in a field is a space')
  const menu = new Event('contextmenu', { cancelable: true })
  canvas.dispatchEvent(menu)
  assert.equal(menu.defaultPrevented, true)
})

test('a drag ends when the button is found released, when focus is lost, and when the terminal opens', () => {
  const yaw = input.yaw
  canvas.dispatchEvent(mouse('pointerdown', 0, 0))
  canvas.dispatchEvent(mouse('pointermove', 10, 0, { buttons: 0 }))
  assert.equal(input.dragging, false, 'button released where no pointerup reached us')
  assert.equal(input.yaw, yaw, 'that move is not a look')
  assert.equal(canvas.lockRequests, 0)

  canvas.dispatchEvent(mouse('pointerdown', 0, 0))
  win.dispatchEvent(new Event('blur'))
  assert.equal(input.dragging, false)
  assert.equal(canvas.captured.size, 0)
  canvas.dispatchEvent(mouse('pointermove', 50, 0))
  assert.equal(input.yaw, yaw)

  canvas.dispatchEvent(mouse('pointerdown', 0, 0))
  doc.dispatchEvent(ev('keydown', { code: 'KeyW', repeat: false }))
  assert.equal(input.down('KeyW'), true)
  input.suspend(true)
  assert.equal(input.dragging, false)
  assert.equal(input.down('KeyW'), false)
  canvas.dispatchEvent(mouse('pointermove', 50, 0))
  canvas.dispatchEvent(mouse('pointerup', 50, 0))
  assert.equal(input.yaw, yaw)
  assert.equal(canvas.lockRequests, 0, 'no capture while the terminal is open')
  canvas.dispatchEvent(mouse('pointerdown', 0, 0))
  assert.equal(input.dragging, false, 'suspended: presses are ignored')
  input.suspend(false)
  canvas.dispatchEvent(mouse('pointerdown', 0, 0))
  canvas.dispatchEvent(mouse('pointermove', 5, 0))
  assert.ok(input.yaw < yaw, 'resumed')
})

test('raw mouse counts are asked for, a plain lock where they are refused; a spike is dropped, a flick, a turn from rest and a busy frame\'s movement are kept', async () => {
  // Events and frames on one clock, as the page's are (performance.now()).
  let t = 1000
  input.dispose()
  input = new Input(canvas as unknown as HTMLCanvasElement, new HalBus({ navigator: { getGamepads: () => pads } }), () => t)
  const asked: unknown[] = []
  const lockWith = canvas.requestPointerLock.bind(canvas)
  let refuse = true
  canvas.requestPointerLock = ((o?: unknown) => {
    asked.push(o)
    if (o && refuse) return Promise.reject(Object.assign(new Error('raw input unavailable'), { name: 'NotSupportedError' }))
    return lockWith()
  }) as typeof canvas.requestPointerLock
  canvas.dispatchEvent(mouse('pointerdown', 0, 0))
  canvas.dispatchEvent(mouse('pointerup', 0, 0))
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(asked, [{ unadjustedMovement: true }, undefined], 'refused, then a plain lock')
  assert.equal(input.locked, true)
  // Events a frame apart (16 ms), as the browser stamps them, with the frame's poll before each.
  const send = (dx: number) => {
    const e = ev('mousemove', { movementX: dx, movementY: 0 })
    Object.defineProperty(e, 'timeStamp', { value: t })
    doc.dispatchEvent(e)
  }
  const move = (dx: number, after = 16) => {
    t += after
    input.poll(after / 1000)
    send(dx)
  }
  /** The mouse at rest for `ms`: frames run with no movement. */
  const rest = (ms: number) => {
    for (let k = 0; k < ms / 16; k++) { t += 16; input.poll(1 / 60) }
  }
  const yaw = input.yaw
  move(900)
  assert.equal(input.yaw, yaw, 'a 900-count jump as the lock starts is a spike')
  move(6)
  assert.ok(close(input.yaw, yaw - 6 * LOOK.mouse), 'the next move looks')
  // A flick ramps up: every event is kept.
  let expect = input.yaw
  for (const dx of [40, 120, 300, 600, 380]) {
    move(dx)
    expect -= dx * LOOK.mouse
  }
  assert.ok(close(input.yaw, expect), 'the flick turned the head in full')
  // A steady turn, then a 200 ms frame (a region loading): the browser merges its moves into one event of 600 counts,
  // no faster than the turn, with no frame polled in between. Kept: the view turns the whole way.
  for (let i = 0; i < 10; i++) move(50)
  expect = input.yaw
  t += 200
  const merged = ev('mousemove', { movementX: 600, movementY: 0 })
  Object.defineProperty(merged, 'timeStamp', { value: t })
  doc.dispatchEvent(merged)
  assert.ok(close(input.yaw, expect - 600 * LOOK.mouse), 'a busy frame\'s movement is a look')
  // Half a second at rest, then a jump of 900 counts in one event: a spike out of stillness, dropped.
  rest(500)
  expect = input.yaw
  move(900)
  assert.equal(input.yaw, expect, 'a spike after a rest is dropped')
  // Half a second at rest, then a quick about-face at 30 fps: every frame of it is kept.
  rest(500)
  expect = input.yaw
  for (const dx of [106, 448, 595, 236, 43]) {
    move(dx, 33)
    expect -= dx * LOOK.mouse
  }
  assert.ok(close(input.yaw, expect), 'a turn from rest turns the head in full')
  // Mid-turn, a jump at many times the turn's rate in one frame is a driver's spike; the next event is judged against
  // it, so two in a row are never dropped.
  move(50)
  expect = input.yaw
  move(900)
  assert.equal(input.yaw, expect, 'dropped')
  move(900)
  assert.ok(close(input.yaw, expect - 900 * LOOK.mouse), 'the event after a dropped one is kept')
  // At rest, then a 200 ms frame (a region loading) in which the hand starts turning: its merged move of 600 counts
  // arrives with no frame polled since the one before the stall. As slow as the hand: kept.
  rest(500)
  expect = input.yaw
  t += 16
  input.poll(1 / 60)
  t += 200
  send(600)
  assert.ok(close(input.yaw, expect - 600 * LOOK.mouse), 'a long frame\'s move out of rest is a look')
  // A mouse reporting at 125 Hz on a 240 Hz screen: two frames between events, never a rest. A fast turn is kept whole.
  rest(500)
  expect = input.yaw
  for (const dx of [60, 200, 450, 500, 500, 500, 300]) {
    t += 4
    input.poll(1 / 240)
    t += 4
    input.poll(1 / 240)
    send(dx)
    expect -= dx * LOOK.mouse
  }
  assert.ok(close(input.yaw, expect), 'a 125 Hz mouse\'s turn on a 240 Hz screen is kept')
  doc.exitPointerLock()
  // Where raw counts are granted, one request is enough.
  refuse = false
  asked.length = 0
  canvas.dispatchEvent(mouse('pointerdown', 0, 0))
  canvas.dispatchEvent(mouse('pointerup', 0, 0))
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(asked, [{ unadjustedMovement: true }])
  assert.equal(input.locked, true)
})

test('the terminal releases pointer lock', () => {
  canvas.dispatchEvent(mouse('pointerdown', 0, 0))
  canvas.dispatchEvent(mouse('pointerup', 0, 0))
  assert.equal(input.locked, true)
  input.suspend(true)
  assert.equal(input.locked, false)
  const yaw = input.yaw
  doc.dispatchEvent(ev('mousemove', { movementX: 40, movementY: 0 }))
  assert.equal(input.yaw, yaw)
})

test('touch drag turns the head at first-person sensitivity', () => {
  const yaw = input.yaw, pitch = input.pitch
  input.touchLook(100, -50)
  assert.ok(close(input.yaw, yaw - 100 * LOOK.touchYaw))
  assert.ok(close(input.pitch, pitch + 50 * LOOK.touchPitch))
  const swipe = 180 * LOOK.touchYaw
  assert.ok(swipe > 0.75 && swipe < 1.35, `a 180 px thumb swipe turns ${(swipe * 180 / Math.PI).toFixed(0)}°`)
  input.touchLook(Number.NaN, 5)
  assert.ok(Number.isFinite(input.yaw) && Number.isFinite(input.pitch))
  assert.equal(input.device, 'touch')
})

test('the right stick turns the head; the left stick walks; padFamily follows the pad used last', () => {
  assert.equal(input.padFamily, null)
  pads.push(pad())
  input.poll(1 / 60)
  assert.equal(input.padFamily, null, 'connected, not used')
  assert.equal(input.device, 'keyboard+mouse')
  const yaw = input.yaw, pitch = input.pitch
  pads[0] = pad({ axes: [0, -1, 1, -0.3] })
  for (let i = 0; i < 60; i++) input.poll(1 / 60)
  assert.equal(input.padFamily, 'numbered')
  assert.equal(input.device, 'gamepad')
  assert.equal(input.engaged, true)
  assert.ok(input.analog.moveY > 0.99, 'left stick forward walks forward')
  assert.ok(yaw - input.yaw > 1.2 && yaw - input.yaw < 2.4 + 1.3, `1 s full right turned ${(yaw - input.yaw).toFixed(2)} rad`)
  assert.ok(input.pitch > pitch, 'stick up looks up')
  pads[0] = pad({ id: 'Controller (XInput STANDARD GAMEPAD)', pressed: [PAD.south] })
  input.poll(1 / 60)
  assert.equal(input.padFamily, 'abxy', 'a different pad in the same slot')
  assert.equal(input.take('interact'), true)
  pads.length = 0
  input.poll(1 / 60)
  assert.equal(input.padFamily, null, 'all disconnected')
})

test('looking with the captured mouse after a controller switches the HUD back to keyboard and mouse', () => {
  canvas.dispatchEvent(mouse('pointerdown', 0, 0))
  canvas.dispatchEvent(mouse('pointerup', 0, 0))
  assert.equal(input.locked, true)
  pads.push(pad({ axes: [0, 0, 1, 0] }))
  input.poll(1 / 60)
  assert.equal(input.device, 'gamepad')
  pads[0] = pad()
  input.poll(1 / 60)
  doc.dispatchEvent(ev('mousemove', { movementX: 0, movementY: 0 }))
  assert.equal(input.device, 'gamepad', 'a zero movement is not use')
  doc.dispatchEvent(ev('mousemove', { movementX: 12, movementY: -3 }))
  assert.equal(input.device, 'keyboard+mouse')
  assert.equal(input.padFamily, 'numbered', 'the pad family is kept for when the controller is picked up again')
})

test('a stick released mid-turn stops the head within a few frames', () => {
  pads.push(pad({ axes: [0, 0, 1, 0] }))
  for (let i = 0; i < 30; i++) input.poll(1 / 60)
  pads[0] = pad()
  for (let i = 0; i < 12; i++) input.poll(1 / 60)
  const settled = input.yaw
  for (let i = 0; i < 30; i++) input.poll(1 / 60)
  assert.equal(input.yaw, settled)
})

test('after dispose nothing reacts', () => {
  input.dispose()
  const yaw = input.yaw
  canvas.dispatchEvent(mouse('pointerdown', 0, 0))
  canvas.dispatchEvent(mouse('pointermove', 100, 0))
  canvas.dispatchEvent(mouse('pointerup', 100, 0))
  doc.dispatchEvent(ev('keydown', { code: 'KeyW', repeat: false }))
  assert.equal(input.yaw, yaw)
  assert.equal(input.down('KeyW'), false)
  assert.equal(canvas.lockRequests, 0)
})

test('editable targets never take game keys', () => {
  assert.equal(isEditableTarget({ tagName: 'input' } as unknown as EventTarget), true)
  assert.equal(isEditableTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget), true)
  assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget), true)
  assert.equal(isEditableTarget({ tagName: 'CANVAS' } as unknown as EventTarget), false)
  assert.equal(isEditableTarget(null), false)
})

test('seated (split screen): the pads are dealt to seats, player 1 keeps the keyboard, and each seat reads its own pad', () => {
  assert.equal(input.seated, false)
  input.setPlayers(3)
  assert.equal(input.seated, true)
  assert.equal(input.seats.players, 3)
  assert.equal(input.intent(KEYBOARD_SEAT), input, 'seat 0 is the keyboard, the mouse and touch')
  pads.push(pad({ index: 0, axes: [0, -1, 0, 0] }), pad({ index: 3, id: 'Controller (XInput STANDARD GAMEPAD)', pressed: [PAD.south] }))
  input.poll(1 / 60)
  assert.equal(input.seats.seatOf(0), 1, 'the first pad takes seat 1 (player 2)')
  assert.equal(input.seats.seatOf(3), 2, 'the next the seat after')
  assert.equal(input.seats.padIndexOf(KEYBOARD_SEAT), -1, 'no pad merges into player 1')
  assert.ok(input.analog.moveY === 0, 'player 1 reads no stick')
  assert.ok(input.intent(1).analog.moveY > 0.99, 'player 2 walks forward on its own pad')
  assert.equal(input.intent(2).take('interact'), true, 'player 3 pressed south')
  assert.equal(input.intent(1).take('interact'), false)
  assert.equal(input.take('interact'), false)
  assert.equal(input.familyOf(2), 'abxy')
  assert.equal(input.familyOf(1), 'numbered')
  assert.equal(input.familyOf(0), null)
  assert.equal(input.familyOf(3), null, 'no seat 3 at a table of three')
  // Keyboard still drives player 1.
  doc.dispatchEvent(ev('keydown', { code: 'KeyW' }))
  assert.equal(input.down('KeyW'), true)
  assert.equal(input.intent(1).down('KeyW'), false, 'a pad has no keys')
  // The right stick on seat 1's pad turns that head, not player 1's.
  const yaw = input.yaw, yaw1 = input.intent(1).yaw
  pads[0] = pad({ index: 0, axes: [0, 0, 1, 0] })
  for (let i = 0; i < 30; i++) input.poll(1 / 60)
  assert.equal(input.yaw, yaw, 'player 1 did not turn')
  assert.ok(input.intent(1).yaw < yaw1, 'player 2 turned right')
  // suspend() rests every seat: queued presses are dropped.
  pads[1] = pad({ index: 3, id: 'Controller (XInput STANDARD GAMEPAD)', pressed: [PAD.east] })
  input.poll(1 / 60)
  input.suspend(true)
  assert.equal(input.intent(2).take('reset'), false, 'dropped with the console open')
  input.suspend(false)
  // A third pad joins seat 0 once seats 1 and 2 are taken (player 1 then has a pad as well as the keyboard); a fourth
  // waits; a pad that leaves frees its seat and the waiting pad takes it, while every seated pad keeps its seat.
  pads.push(pad({ index: 5, axes: [0, -1, 0, 0] }))
  input.poll(1 / 60)
  assert.equal(input.seats.seatOf(5), KEYBOARD_SEAT, 'seat 0 last')
  assert.ok(input.analog.moveY > 0.99, 'and it drives player 1')
  pads.push(pad({ index: 7 }))
  input.poll(1 / 60)
  assert.equal(input.seats.seatOf(7), -1, 'no seat free at a table of three')
  pads.splice(0, 1)
  input.poll(1 / 60)
  assert.equal(input.seats.seatOf(7), 1, 'took the freed seat')
  assert.equal(input.seats.seatOf(5), KEYBOARD_SEAT, 'kept its seat')
  assert.equal(input.seats.seatOf(3), 2, 'kept its seat')
  // Back to one player: every pad merges into player 1 again.
  input.setPlayers(1)
  assert.equal(input.seated, false)
  pads.length = 0
  pads.push(pad({ index: 0, axes: [0, -1, 0, 0] }))
  input.poll(1 / 60)
  assert.ok(input.analog.moveY > 0.99, 'merged into player 1 as before')
})

test('seated: with one pad and two players the pad is player 2, so player 1 is the keyboard alone', () => {
  input.setPlayers(2)
  pads.push(pad({ index: 0, pressed: [PAD.south] }))
  input.poll(1 / 60)
  assert.equal(input.seats.seatOf(0), 1)
  assert.equal(input.take('interact'), false, 'player 1 did not press it')
  assert.equal(input.intent(1).take('interact'), true)
  // A second pad then fills seat 0: player 1 has a pad as well as the keyboard.
  pads.push(pad({ index: 1, axes: [0, -1, 0, 0] }))
  input.poll(1 / 60)
  assert.equal(input.seats.seatOf(1), KEYBOARD_SEAT)
  assert.ok(input.analog.moveY > 0.99, 'seat 0\'s pad drives player 1')
  assert.equal(input.familyOf(0), 'numbered')
})

test('the shield: while a card waits for the operator\'s OK the pad\'s edges and the touch taps queue nothing, keys and sticks stay live, and no edge replays when it lifts', () => {
  pads.push(pad())
  input.poll(1 / 60)
  assert.equal(input.shielded, false)
  input.shield(true)
  assert.equal(input.shielded, true)
  pads[0] = pad({ pressed: [PAD.south], axes: [0, -1, 0, 0] })
  input.poll(1 / 60)
  assert.equal(input.take('interact'), false, 'the south face button is the card\'s, never the car door')
  assert.ok(input.analog.moveY > 0.99, 'the stick still walks')
  assert.equal(input.device, 'gamepad', 'the pad is still the input in use')
  input.press('interact')
  assert.equal(input.take('interact'), false, 'the touch cluster\'s Enter car tap queues nothing')
  input.press('ping')
  assert.equal(input.take('ping'), false, 'nor any other tap')
  doc.dispatchEvent(ev('keydown', { code: 'KeyE' }))
  assert.equal(input.take('interact'), true, 'E still ends the proposal, in the gateway\'s words')
  // The button held through the shield: lifting it replays nothing (the mapper's held bits advanced all the while).
  input.shield(false)
  assert.equal(input.shielded, false)
  input.poll(1 / 60)
  assert.equal(input.take('interact'), false, 'no edge replays when the shield lifts')
  // Let go and pressed again: the edge is the game's once more, and so is a tap.
  pads[0] = pad()
  input.poll(1 / 60)
  pads[0] = pad({ pressed: [PAD.south] })
  input.poll(1 / 60)
  assert.equal(input.take('interact'), true)
  input.press('interact')
  assert.equal(input.take('interact'), true)
})

test('the shield is not the console\'s suspend: it leaves the keyboard alone, and suspend() leaves the shield alone', () => {
  input.shield(true)
  doc.dispatchEvent(ev('keydown', { code: 'KeyW' }))
  assert.equal(input.down('KeyW'), true, 'a held key is still held')
  input.suspend(true)
  assert.equal(input.shielded, true, 'the console opening does not lift the shield')
  input.suspend(false)
  assert.equal(input.shielded, true)
  pads.push(pad({ pressed: [PAD.r1] }))
  input.poll(1 / 60)
  assert.equal(input.take('ping'), false, 'the right shoulder\'s ping is dropped like the rest of the pad\'s edges')
})
