// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the headset mapper (xrInput.ts) against fake sources of every input shape the
 * WebXR input profiles registry describes (MIT; its 46 profiles reduce to the anonymous shapes below, named here by what
 * they hold, never by maker): which sources are controllers and which are pointers, each controller pair and each
 * controller alone (of any hand) able to walk, turn, enter and leave a car, ping and drive; the sticks in the head's
 * frame on foot only; snap turns by flick, by touchpad click and by sector; the run latch and when it goes; the step out
 * of a car held or refused; a pad's right stick snapping inside a headset; and the pinch's drag and tap (PinchDrag).
 * No headset here: UNCONFIRMED on real hardware.
 * What breaks if it is removed? A regression could leave a headset's player unable to walk or enter a car, walk the
 * body where the headset does not look, or snap every frame.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAnalog, PAD_EDGE } from './gamepad.ts'
import {
  isController, isPointerOnly, PINCH, PinchDrag, pinchKindOf, roleOf, shapeOf, XR_AXIS, XR_BUTTON, XR_DEADZONE, XR_HOLD_OUT_MS,
  XR_PAD_DEADZONE, XR_SECTOR, XR_TURN, XrMapper, type XrPoint,
} from './xrInput.ts'
import type { XrInputSourceLike } from './web-hardware.d.ts'

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps

interface Btn { pressed: boolean; value: number; touched: boolean }
interface Fake extends XrInputSourceLike {
  readonly axes: number[]
  readonly buttons: Btn[]
}

/** A tracked controller with the xr-standard mapping, `buttons` long and `axes` long (live arrays the test edits). */
function ctl(handedness: 'left' | 'right' | 'none', buttons: number, axes: number): Fake {
  const a = Array.from({ length: axes }, () => 0)
  const b = Array.from({ length: buttons }, () => ({ pressed: false, value: 0, touched: false }))
  return { handedness, targetRayMode: 'tracked-pointer', profiles: [], gamepad: { mapping: 'xr-standard', axes: a, buttons: b }, gripSpace: {}, targetRaySpace: {}, axes: a, buttons: b }
}
const down = (c: Fake, i: number, on = true) => { const b = c.buttons[i]; b.pressed = on; b.value = on ? 1 : 0; b.touched = on || b.touched }
const touch = (c: Fake, x: number, y: number) => { c.axes[XR_AXIS.touchpadX] = x; c.axes[XR_AXIS.touchpadY] = y; c.buttons[XR_BUTTON.touchpad].touched = true }
const untouch = (c: Fake) => { c.axes[XR_AXIS.touchpadX] = 0; c.axes[XR_AXIS.touchpadY] = 0; c.buttons[XR_BUTTON.touchpad].touched = false }

/**
 * The registry's controller shapes, as (buttons, axes): trailing placeholders trimmed as the Gamepads Module says.
 * stick6..8: a thumbstick and two face buttons (6), with a bumper (7), with a thumbrest and a menu (8); stickPad: a
 * thumbstick and a touchpad, no face button; stickPadA: the same with one face button; stickOnly: a thumbstick and no
 * face button (button 2 a placeholder); wand: a touchpad and no thumbstick, trigger and squeeze; padSingle: a touchpad and
 * a trigger only; padMenu: a touchpad and a trigger with a menu button at 4.
 */
const SHAPES = {
  stick6: [6, 4], stick7: [7, 4], stick8: [8, 4], stickPad: [4, 4], stickPadA: [5, 4], stickOnly: [4, 4],
  wand: [3, 2], padSingle: [3, 2], padMenu: [5, 2],
} as const
type ShapeName = keyof typeof SHAPES

test('controllers are xr-standard tracked pointers with axes; hands, styluses, screens, gazes and pinches are pointers', () => {
  for (const [name, [b, a]] of Object.entries(SHAPES)) assert.equal(isController(ctl('left', b, a)), true, name)
  const pointer = (o: Partial<XrInputSourceLike> & { gamepad?: XrInputSourceLike['gamepad'] }): XrInputSourceLike => ({ handedness: 'none', targetRayMode: 'tracked-pointer', profiles: [], ...o })
  const pad = (mapping: string, buttons: number, axes: number) => ({ mapping, axes: Array.from({ length: axes }, () => 0), buttons: Array.from({ length: buttons }, () => ({ pressed: false, value: 0 })) })
  const pointers: [string, XrInputSourceLike][] = [
    ['a hand with only its pinch', pointer({ hand: {}, gamepad: pad('xr-standard', 1, 0), gripSpace: {} })],
    ['a hand with a pinch and a grasp at 4', pointer({ hand: {}, gamepad: pad('xr-standard', 5, 0), gripSpace: {} })],
    ['a hand with gestures up to 9', pointer({ hand: {}, gamepad: pad('xr-standard', 10, 0), gripSpace: {} })],
    ['a hand that only carries a pose', pointer({ hand: {}, gamepad: null, gripSpace: {} })],
    ['a controller with no axes (a trigger)', pointer({ gamepad: pad('xr-standard', 1, 0), gripSpace: {} })],
    ['a stylus (tip force at 5)', pointer({ gamepad: pad('xr-standard', 7, 0), gripSpace: {} })],
    ['a single button, no mapping', pointer({ gamepad: pad('', 1, 0), gripSpace: {} })],
    ['a touchpad with no mapping (its press at 2)', pointer({ gamepad: pad('', 3, 2), gripSpace: {} })],
    ['a touchpad with no mapping (its press at 0)', pointer({ gamepad: pad('', 1, 2), gripSpace: {} })],
    ['a phone screen', pointer({ targetRayMode: 'screen', gamepad: pad('', 3, 2) })],
    ['a gaze-and-pinch transient pointer', pointer({ targetRayMode: 'transient-pointer', gamepad: pad('', 1, 0), gripSpace: {} })],
    ['a gaze button', pointer({ targetRayMode: 'gaze', gamepad: null })],
  ]
  for (const [name, s] of pointers) assert.equal(isPointerOnly(s), true, name)
  assert.deepEqual(pointers.map(([, s]) => pinchKindOf(s)), ['grip', 'grip', 'grip', 'grip', 'grip', 'grip', 'grip', 'grip', 'grip', 'tap', 'grip', 'tap'])
  assert.equal(pinchKindOf(pointer({ targetRayMode: 'transient-pointer', gripSpace: null })), 'tap', 'a transient pointer drags by its grip only: its ray swings with the wrist')
  assert.equal(pinchKindOf(pointer({ gripSpace: null })), 'ray', 'a tracked pointer with no grip drags by its ray')
  assert.deepEqual([roleOf({ handedness: 'left' }), roleOf({ handedness: 'right' }), roleOf({ handedness: 'none' }), roleOf({ handedness: '' })], ['left', 'right', 'both', 'both'])
  assert.deepEqual(XR_BUTTON, { trigger: 0, squeeze: 1, touchpad: 2, thumbstick: 3, primary: 4, secondary: 5 })
  assert.deepEqual(XR_AXIS, { touchpadX: 0, touchpadY: 1, thumbX: 2, thumbY: 3 })
  assert.deepEqual(shapeOf(ctl('left', 6, 4)), { stick: true, padWalks: false, pad: true, faces: 2 })
  assert.deepEqual(shapeOf(ctl('left', 3, 2)), { stick: false, padWalks: true, pad: true, faces: 0 })
  assert.deepEqual(shapeOf(ctl('left', 5, 4)), { stick: true, padWalks: false, pad: true, faces: 1 })
})

/** A rig: a mapper on a clock, with a helper that presses one button for a frame and returns the edges. */
function rig(sources: Fake[]) {
  let t = 1000
  const m = new XrMapper(() => t)
  m.sources = sources
  m.read() // first sight: what is held is learned, nothing pressed
  return {
    m,
    tick: (ms: number) => { t += ms },
    tap: (c: Fake, b: number) => { down(c, b); const e = m.read(); down(c, b, false); m.read(); return e },
  }
}

/** Every way a source of this shape could do something, tried one at a time: the buttons, then a held walking click. */
function probe(name: ShapeName, hands: ('left' | 'right' | 'none')[], ctx: { driving?: boolean; nearCar?: boolean; stopped?: boolean }) {
  const [b, a] = SHAPES[name]
  const cs = hands.map((h) => ctl(h, b, a))
  const r = rig(cs)
  Object.assign(r.m, { driving: false, nearCar: false, stopped: true, ...ctx })
  let edges = 0
  for (const c of cs) for (let i = 0; i < Math.min(6, b); i++) edges |= r.tap(c, i)
  // The walking hand's click held for a second (the step out of a stopped car).
  for (const c of cs) {
    const click = a >= 4 ? XR_BUTTON.thumbstick : XR_BUTTON.touchpad
    if (click >= b) continue
    down(c, click)
    edges |= r.m.read()
    r.tick(XR_HOLD_OUT_MS + 1)
    edges |= r.m.read()
    down(c, click, false)
    r.m.read()
  }
  return edges
}

/** Whether a frame with the walking surface pushed forward walks (or drives forward). */
function walks(name: ShapeName, hands: ('left' | 'right' | 'none')[], driving = false): boolean {
  const [b, a] = SHAPES[name]
  const cs = hands.map((h) => ctl(h, b, a))
  const r = rig(cs)
  r.m.driving = driving
  let best = 0
  for (const c of cs) {
    if (a >= 4) c.axes[XR_AXIS.thumbY] = -1
    else touch(c, 0, -1)
    r.m.read()
    best = Math.max(best, r.m.analog.moveY)
    if (a >= 4) c.axes[XR_AXIS.thumbY] = 0
    else untouch(c)
  }
  return best > 0.5
}

/** Whether some input turns the body on foot (a flick, or a touchpad's edge click). */
function turns(name: ShapeName, hands: ('left' | 'right' | 'none')[]): boolean {
  const [b, a] = SHAPES[name]
  const cs = hands.map((h) => ctl(h, b, a))
  const r = rig(cs)
  for (const c of cs) {
    if (a >= 4) { c.axes[XR_AXIS.thumbX] = 1; r.m.read(); if (r.m.turn !== 0) return true; c.axes[XR_AXIS.thumbX] = 0; r.m.read() }
    else { touch(c, 0.9, 0); down(c, XR_BUTTON.touchpad); r.m.read(); if (r.m.turn !== 0) return true; down(c, XR_BUTTON.touchpad, false); untouch(c); r.m.read() }
  }
  return false
}

test('every registry controller shape, as a pair and alone in either hand or none, can walk, turn, enter and leave a car, ping and drive', () => {
  const sets: ('left' | 'right' | 'none')[][] = [['left', 'right'], ['left'], ['right'], ['none'], ['left', 'left'], ['none', 'none']]
  for (const name of Object.keys(SHAPES) as ShapeName[]) {
    for (const hands of sets) {
      const what = `${name} as ${hands.join('+')}`
      assert.ok(walks(name, hands), `${what}: walks`)
      assert.ok(walks(name, hands, true), `${what}: drives forward`)
      assert.ok(turns(name, hands), `${what}: turns`)
      assert.ok(probe(name, hands, { nearCar: true }) & PAD_EDGE.interact, `${what}: enters a car`)
      assert.ok(probe(name, hands, {}) & PAD_EDGE.ping, `${what}: pings`)
      assert.ok(probe(name, hands, { driving: true, stopped: true }) & PAD_EDGE.interact, `${what}: leaves a stopped car`)
    }
  }
})

test('the walking hand walks and steers past the dead zone, in the head\'s frame on foot and the car\'s at the wheel', () => {
  const left = ctl('left', 6, 4), right = ctl('right', 6, 4)
  const { m } = rig([left, right])
  left.axes[XR_AXIS.thumbY] = -1
  m.read()
  assert.ok(close(m.analog.moveY, 1) && close(m.analog.moveX, 0) && close(m.analog.steer, 0), 'stick up is forward')
  assert.equal(m.active, true)
  assert.equal(m.used, true)
  left.axes[XR_AXIS.thumbY] = 0
  left.axes[XR_AXIS.thumbX] = 1
  m.read()
  assert.ok(close(m.analog.moveX, 1) && close(m.analog.steer, -1), 'stick right strafes right and steers (a pad\'s sign)')
  left.axes[XR_AXIS.thumbX] = XR_DEADZONE / 2
  m.read()
  assert.equal(m.analog.moveX, 0, 'inside the dead zone: still')
  // The head looks a quarter turn left of the body: forward on the stick is the head's forward.
  left.axes[XR_AXIS.thumbX] = 0
  left.axes[XR_AXIS.thumbY] = -1
  m.headOffset = Math.PI / 2
  m.read()
  assert.ok(close(m.analog.moveX, -1, 1e-9) && close(m.analog.moveY, 0, 1e-9), `turned: ${m.analog.moveX}, ${m.analog.moveY}`)
  m.driving = true
  m.read()
  assert.ok(close(m.analog.moveY, 1, 1e-9), 'at the wheel the stick is never turned by the head: back always brakes')
  m.driving = false
  m.headOffset = 0
})

test('the turning hand snap-turns once per flick, re-armed under the off threshold, and never at the wheel', () => {
  const left = ctl('left', 6, 4), right = ctl('right', 6, 4)
  const { m } = rig([left, right])
  right.axes[XR_AXIS.thumbX] = XR_TURN.on
  m.read()
  assert.ok(close(m.turn, XR_TURN.step), 'a flick to the right: one step')
  m.read()
  assert.equal(m.turn, 0, 'held past the threshold: no second step')
  right.axes[XR_AXIS.thumbX] = (XR_TURN.on + XR_TURN.off) / 2
  m.read()
  assert.equal(m.turn, 0, 'between the thresholds: not re-armed yet')
  right.axes[XR_AXIS.thumbX] = XR_TURN.off - 0.01
  m.read()
  right.axes[XR_AXIS.thumbX] = -1
  m.read()
  assert.ok(close(m.turn, -XR_TURN.step), 're-armed: a flick to the left steps the other way')
  assert.equal(m.analog.moveX, 0, 'the turning stick never walks')
  right.axes[XR_AXIS.thumbX] = 0
  m.read()
  m.driving = true
  right.axes[XR_AXIS.thumbX] = 1
  m.read()
  assert.equal(m.turn, 0, 'at the wheel the body faces the car\'s way: no snap')
})

test('a pair drives: right trigger throttles, squeeze brakes, A pings, B enters; left squeeze is the handbrake, left trigger pings, left Y resets a car', () => {
  const left = ctl('left', 6, 4), right = ctl('right', 6, 4)
  const r = rig([left, right])
  const { m } = r
  right.buttons[XR_BUTTON.trigger].value = 0.6
  m.read()
  assert.ok(m.analog.throttle > 0.5 && m.analog.throttle < 0.7, `throttle from the trigger's value: ${m.analog.throttle}`)
  right.buttons[XR_BUTTON.trigger].value = 0
  down(right, XR_BUTTON.squeeze)
  m.read()
  assert.equal(m.analog.brake, 1)
  assert.equal(m.analog.handbrake, false, 'the right squeeze is the brake, not the handbrake')
  down(right, XR_BUTTON.squeeze, false)
  down(left, XR_BUTTON.squeeze)
  m.read()
  assert.equal(m.analog.handbrake, true)
  assert.equal(m.analog.brake, 0, 'the left squeeze never brakes')
  down(left, XR_BUTTON.squeeze, false)
  assert.equal(r.tap(right, XR_BUTTON.primary), PAD_EDGE.ping, 'A pings')
  assert.equal(r.tap(right, XR_BUTTON.secondary), PAD_EDGE.interact, 'B enters or leaves')
  assert.equal(r.tap(left, XR_BUTTON.trigger), PAD_EDGE.ping, 'the left trigger pings')
  assert.equal(r.tap(left, XR_BUTTON.secondary), 0, 'Y on foot: nothing')
  m.driving = true
  assert.equal(r.tap(left, XR_BUTTON.secondary), PAD_EDGE.reset, 'Y at the wheel rights the car')
  assert.equal(r.tap(right, XR_BUTTON.thumbstick), PAD_EDGE.mute, 'the right stick\'s click is the microphone\'s mute, as a pad\'s')
  assert.equal(r.tap(right, XR_BUTTON.trigger), 0, 'the trigger at the wheel is the throttle alone')
})

test('a controller alone, of any hand: forward and back walk, sideways snaps, never both; at the wheel it steers and drives', () => {
  for (const hand of ['left', 'right', 'none'] as const) {
    const c = ctl(hand, 6, 4)
    const r = rig([c])
    const { m } = r
    c.axes[XR_AXIS.thumbX] = 1
    m.read()
    assert.equal(m.analog.moveX, 0, `${hand}: sideways never strafes`)
    assert.ok(close(m.turn, XR_TURN.step), `${hand}: sideways snaps`)
    c.axes[XR_AXIS.thumbX] = 0
    m.read()
    c.axes[XR_AXIS.thumbY] = -1
    m.read()
    assert.ok(close(m.analog.moveY, 1) && m.turn === 0, `${hand}: up walks, no turn`)
    // A diagonal push: the sectors give it to one or the other, never both.
    const at = (deg: number) => { c.axes[XR_AXIS.thumbX] = Math.cos((deg * Math.PI) / 180); c.axes[XR_AXIS.thumbY] = -Math.sin((deg * Math.PI) / 180); c.axes[XR_AXIS.thumbX] = c.axes[XR_AXIS.thumbX]; m.read() }
    at(0); at(90) // re-arm
    c.axes[XR_AXIS.thumbX] = 0; c.axes[XR_AXIS.thumbY] = 0; m.read()
    at((XR_SECTOR.snap * 180) / Math.PI - 5)
    assert.ok(m.turn !== 0 && m.analog.moveY === 0, `${hand}: near sideways snaps only`)
    c.axes[XR_AXIS.thumbX] = 0; c.axes[XR_AXIS.thumbY] = 0; m.read()
    at(90 - (XR_SECTOR.walk * 180) / Math.PI + 5)
    assert.ok(m.turn === 0 && m.analog.moveY > 0, `${hand}: near forward walks only`)
    c.axes[XR_AXIS.thumbX] = 0; c.axes[XR_AXIS.thumbY] = 0; m.read()
    // At the wheel: x steers (and rides moveX, so a merge by the larger move keeps it), y drives, no snap.
    m.driving = true
    c.axes[XR_AXIS.thumbX] = -1
    m.read()
    assert.ok(close(m.analog.steer, 1) && m.turn === 0, `${hand}: steers left`)
    c.axes[XR_AXIS.thumbX] = 0
    c.axes[XR_AXIS.thumbY] = 1
    m.read()
    assert.ok(close(m.analog.moveY, -1), `${hand}: back brakes`)
    c.axes[XR_AXIS.thumbY] = 0
    // Its squeeze brakes (never the handbrake too), its stick's click is the handbrake at the wheel.
    down(c, XR_BUTTON.squeeze)
    m.read()
    assert.ok(m.analog.brake === 1 && !m.analog.handbrake, `${hand}: the squeeze is the brake alone`)
    down(c, XR_BUTTON.squeeze, false)
    down(c, XR_BUTTON.thumbstick)
    m.read()
    assert.equal(m.analog.handbrake, true, `${hand}: the stick's click is the handbrake at the wheel`)
    down(c, XR_BUTTON.thumbstick, false)
    m.read()
    // The trigger: throttle at the wheel with no edge; on foot what is at hand.
    assert.equal(r.tap(c, XR_BUTTON.trigger), 0, `${hand}: no edge from the throttle`)
    m.driving = false
    assert.equal(r.tap(c, XR_BUTTON.trigger), PAD_EDGE.ping, `${hand}: on foot with nothing at hand, a ping`)
    m.nearCar = true
    assert.equal(r.tap(c, XR_BUTTON.trigger), PAD_EDGE.interact, `${hand}: beside a car, its door`)
  }
})

test('at the wheel the walking hand\'s click held a second steps out of a stopped car; a moving car is refused for a touchpad click', () => {
  const c = ctl('none', 6, 4)
  const r = rig([c])
  r.m.driving = true
  r.m.stopped = false
  down(c, XR_BUTTON.thumbstick)
  assert.equal(r.m.read(), 0)
  r.tick(XR_HOLD_OUT_MS + 10)
  assert.equal(r.m.read(), 0, 'moving: held on, nothing')
  r.m.stopped = true
  assert.equal(r.m.read(), PAD_EDGE.interact, 'stopped and held past a second: out')
  r.tick(XR_HOLD_OUT_MS + 10)
  assert.equal(r.m.read(), 0, 'once per hold')
  down(c, XR_BUTTON.thumbstick, false)
  r.m.read()
  // A click held into the wheel (it was down before the car was) never counts.
  const k = ctl('none', 6, 4)
  const q = rig([k])
  down(k, XR_BUTTON.thumbstick)
  q.m.read()
  q.m.driving = true
  q.m.read()
  q.tick(XR_HOLD_OUT_MS + 10)
  assert.equal(q.m.read(), 0, 'held from before the wheel: no step out')
  // A touchpad controller alone: its click steps out at once when stopped, and is refused while moving.
  const p = ctl('none', 3, 2)
  const s = rig([p])
  s.m.driving = true
  s.m.stopped = false
  touch(p, 0, 0)
  assert.equal(s.tap(p, XR_BUTTON.touchpad), 0)
  assert.equal(s.m.takeRefused(), true, 'said, not done')
  assert.equal(s.m.takeRefused(), false, 'said once')
  s.m.stopped = true
  assert.equal(s.tap(p, XR_BUTTON.touchpad), PAD_EDGE.interact)
})

test('touchpads walk only while touched, past their own dead zone, snap only on an edge click, and run at the rim', () => {
  const left = ctl('left', 3, 2), right = ctl('right', 3, 2)
  const r = rig([left, right])
  const { m } = r
  // An untouched pad (axes zero, touched false) and a resting thumb inside the dead zone: still.
  m.read()
  assert.equal(m.analog.moveY, 0)
  touch(left, 0, -XR_PAD_DEADZONE / 2)
  m.read()
  assert.equal(m.analog.moveY, 0, 'a resting thumb does not walk')
  touch(left, 0, -0.8)
  m.read()
  assert.ok(m.analog.moveY > 0.5 && !m.analog.run, 'touched forward walks')
  touch(left, 0, -0.95)
  m.read()
  assert.equal(m.analog.run, true, 'at the rim it runs')
  untouch(left)
  m.read()
  assert.equal(m.analog.moveY, 0, 'lifted: still')
  // The left pad's click latches a run.
  assert.equal(r.tap(left, XR_BUTTON.touchpad), 0)
  m.read()
  assert.equal(m.analog.run, true, 'latched')
  r.tap(left, XR_BUTTON.touchpad)
  m.read()
  assert.equal(m.analog.run, false, 'unlatched')
  // The right pad: a thumb at the edge without a click never snaps; an edge click does; a centre click enters.
  touch(right, 0.9, 0)
  m.read()
  assert.equal(m.turn, 0, 'touch alone never snaps')
  down(right, XR_BUTTON.touchpad)
  m.read()
  assert.ok(close(m.turn, XR_TURN.step), 'an edge click snaps')
  down(right, XR_BUTTON.touchpad, false)
  m.read()
  touch(right, 0, 0)
  m.nearCar = true
  assert.equal(r.tap(right, XR_BUTTON.touchpad), PAD_EDGE.interact, 'a centre click is the door')
  // A touchpad alone does not walk while its click is down (the click deflects the pad).
  const one = ctl('none', 3, 2)
  const s = rig([one])
  touch(one, 0, -0.9)
  down(one, XR_BUTTON.touchpad)
  s.m.read()
  assert.equal(s.m.analog.moveY, 0, 'clicking, not walking')
})

test('roles come from the whole list: two of one hand split by order; a controller beside a hand is alone; first sight teaches', () => {
  const a = ctl('left', 6, 4), b = ctl('left', 6, 4)
  const r = rig([a, b])
  b.axes[XR_AXIS.thumbX] = 1
  r.m.read()
  assert.ok(r.m.turn !== 0 && r.m.analog.moveX === 0, 'the second left controller turns')
  const hand: XrInputSourceLike = { handedness: 'left', targetRayMode: 'tracked-pointer', profiles: [], hand: {}, gamepad: { mapping: 'xr-standard', axes: [], buttons: [{ pressed: false, value: 0 }] } }
  const c = ctl('right', 6, 4)
  const q = rig([c])
  q.m.sources = [hand, c]
  c.axes[XR_AXIS.thumbY] = -1
  q.m.read()
  assert.ok(close(q.m.analog.moveY, 1), 'a right controller beside a hand walks: it is alone')
  // A controller that comes back with B held gives no press on its first frame.
  const d = ctl('right', 6, 4)
  down(d, XR_BUTTON.secondary)
  q.m.sources = [d]
  assert.equal(q.m.read(), 0, 'first sight: no edge')
  down(d, XR_BUTTON.secondary, false)
  q.m.read()
  down(d, XR_BUTTON.secondary)
  assert.equal(q.m.read(), PAD_EDGE.interact, 'pressed again: the edge')
})

test('the run latch goes when no controller that could latch it is left; reset stills everything', () => {
  const left = ctl('left', 6, 4), right = ctl('right', 6, 4)
  const r = rig([left, right])
  r.tap(left, XR_BUTTON.thumbstick)
  r.m.read()
  assert.equal(r.m.analog.run, true)
  const hand: XrInputSourceLike = { handedness: 'right', targetRayMode: 'tracked-pointer', profiles: [], hand: {}, gamepad: null }
  r.m.sources = [hand]
  r.m.read()
  assert.equal(r.m.analog.run, false, 'put down for hands: the run goes with them')
  r.m.sources = [left, right]
  right.axes[XR_AXIS.thumbX] = 1
  r.m.read()
  assert.ok(r.m.turn !== 0)
  r.m.reset()
  assert.equal(r.m.analog.run, false)
  assert.equal(r.m.turn, 0)
  assert.equal(r.m.active, false)
  r.m.sources = null
  r.m.turn = 1
  assert.equal(r.m.read(), 0)
  assert.equal(r.m.turn, 0, 'no sources: the turn is cleared')
})

test('a pad\'s right stick inside a headset snaps once per flick', () => {
  const m = new XrMapper()
  assert.ok(close(m.padSnap(0.9), XR_TURN.step))
  assert.equal(m.padSnap(0.9), 0, 'held: once')
  assert.equal(m.padSnap(XR_TURN.off - 0.01), 0)
  assert.ok(close(m.padSnap(-1), -XR_TURN.step), 're-armed')
})

// ── The pinch ─────────────────────────────────────────────────────────────────────────────────────────────────────

const P = (x: number, z: number, y = 1.2): XrPoint => ({ x, y, z })
const HEAD = P(0, 0, 1.6)

test('a quick still pinch is a tap; a slow one, a moved one, one that lost its pose, or one dropped by a recentre is not', () => {
  const d = new PinchDrag()
  const id = {}
  d.start(id, 'grip', false, 0, P(0, -0.3))
  d.sample(id, 16, P(0.005, -0.3), HEAD)
  assert.equal(d.end(id, 200, P(0.01, -0.3)), 'tap')
  d.start(id, 'grip', false, 0, P(0, -0.3))
  assert.equal(d.end(id, PINCH.tapMs + 1, P(0, -0.3)), 'none', 'held too long: nothing')
  d.start(id, 'grip', false, 0, P(0, -0.3))
  d.sample(id, 16, P(0, -0.3, 1.2 + PINCH.tapM + 0.001), HEAD)
  assert.equal(d.end(id, 100, P(0, -0.3)), 'none', 'moved (even up and back): not a tap')
  d.start(id, 'grip', false, 0, P(0, -0.3))
  d.sample(id, 16, null, HEAD)
  assert.equal(d.end(id, 100, P(0, -0.3)), 'none', 'the pose was lost a moment ago: maybe a hand leaving view')
  d.start(id, 'grip', true, 0, P(0, -0.3))
  assert.equal(d.end(id, 100, P(0.04, -0.3)), 'tap', 'a transient pointer\'s release jump is not counted')
  d.start(id, 'grip', true, 0, null)
  d.sample(id, 16, null, HEAD)
  assert.equal(d.end(id, 100, null), 'tap', 'nor does its tap wait on a pose: it is the system\'s own pinch')
  d.start(id, 'grip', true, 0, P(0, -0.3))
  d.sample(id, 16, P(0, -0.3 - PINCH.tapM - 0.01), HEAD)
  assert.equal(d.end(id, 100, null), 'none', 'but one that moved is no tap')
  d.start(id, 'grip', false, 0, P(0, -0.3))
  d.clear()
  assert.equal(d.end(id, 100, P(0, -0.3)), 'none', 'dropped by a recentre or the menu: no tap when let go')
  assert.equal(d.end({}, 100, null), 'tap', 'a select never seen to start keeps the old behaviour')
  d.start(id, 'tap', false, 0, null)
  assert.equal(d.end(id, 5000, null), 'tap', 'a screen or a gaze button always taps')
  d.start(id, 'grip', false, 0, P(0, -0.3))
  d.cancel(id)
  assert.equal(d.size, 0)
})

test('a drag walks in steps of speed, against the head (a lean does not walk), in its sector; sideways snaps once; far runs', () => {
  const d = new PinchDrag()
  const id = {}
  const out = createAnalog()
  const walk = (x: number, z: number, t: number, head: XrPoint = HEAD) => { d.sample(id, t, P(x, z), head); out.moveX = 0; out.moveY = 0; out.run = false; out.steer = 0; return d.read(out, false) }
  d.start(id, 'grip', false, 0, P(0, -0.3))
  walk(0, -0.3, 10) // the anchor
  assert.equal(walk(0, -0.3 - 0.02, 20), false, 'inside the dead zone: still')
  walk(0, -0.3 - 0.07, 40)
  assert.ok(close(out.moveY, 0.5) && close(out.moveX, 0, 1e-6), `half speed forward: ${out.moveY}`)
  walk(0, -0.3 - 0.14, 60)
  assert.ok(close(out.moveY, 1), 'full speed')
  walk(0, -0.3 - 0.11, 80)
  assert.ok(close(out.moveY, 1), 'a little back: still full (hysteresis)')
  walk(0, -0.3 - 0.25, 100)
  assert.equal(out.run, true, 'drawn far: runs')
  // A lean: the head and the hand move together; nothing changes against the head.
  const e = new PinchDrag()
  e.start(id, 'grip', false, 0, P(0, -0.3))
  e.sample(id, 10, P(0, -0.3), HEAD)
  e.sample(id, 20, P(0, -0.5), P(0, -0.2, 1.6))
  const o2 = createAnalog()
  assert.equal(e.read(o2, false), false, 'leaning forward does not walk')
  // Sideways past the turn's reach: one snap, re-armed back near the middle; no walking there.
  const f = new PinchDrag()
  f.start(id, 'grip', false, 0, P(0, -0.3))
  f.sample(id, 10, P(0, -0.3), HEAD)
  f.sample(id, 20, P(PINCH.turnM + 0.01, -0.3), HEAD)
  const o3 = createAnalog()
  f.read(o3, false)
  assert.ok(close(f.takeTurn(), XR_TURN.step) && o3.moveX === 0, 'one snap right, no strafe')
  f.sample(id, 30, P(PINCH.turnM + 0.02, -0.3), HEAD)
  f.read(o3, false)
  assert.equal(f.takeTurn(), 0, 'held out there: once')
  f.sample(id, 40, P(0.01, -0.3), HEAD)
  f.read(o3, false)
  f.sample(id, 50, P(-PINCH.turnM - 0.01, -0.3), HEAD)
  f.read(o3, false)
  assert.ok(close(f.takeTurn(), -XR_TURN.step), 're-armed: left')
  // At the wheel: x steers, z drives.
  const g = new PinchDrag()
  g.start(id, 'grip', false, 0, P(0, -0.3))
  g.sample(id, 10, P(0, -0.3), HEAD)
  g.sample(id, 20, P(-0.13, -0.43), HEAD)
  const o4 = createAnalog()
  assert.equal(g.read(o4, true), true)
  assert.ok(close(o4.steer, 1, 1e-6) && close(o4.moveY, 1, 1e-6), `steer ${o4.steer} drive ${o4.moveY}`)
  // A lost pose mid-drag stands still, never walking on blind.
  walk(0, -0.3 - 0.14, 120)
  d.sample(id, 140, null, HEAD)
  const o5 = createAnalog()
  assert.equal(d.read(o5, false), false, 'no pose: still')
})

test('one pinch walks at a time; a second can still tap; the mapper merges the drag with the sticks by the larger', () => {
  const m = new XrMapper()
  const handA = {}, handB = {}
  m.sources = []
  m.pinches.start(handA, 'grip', false, 0, P(0, -0.3))
  m.pinches.sample(handA, 10, P(0, -0.3), HEAD)
  m.pinches.start(handB, 'grip', false, 10, P(0.3, -0.3))
  m.pinches.sample(handA, 20, P(0, -0.45), HEAD)
  m.pinches.sample(handB, 20, P(0.3, -0.3), HEAD)
  m.read()
  assert.ok(close(m.analog.moveY, 1), 'the first drags')
  assert.equal(m.pinches.end(handB, 100, P(0.3, -0.3)), 'tap', 'the second taps')
  assert.equal(m.active, true)
  m.reset()
  assert.equal(m.pinches.size, 0, 'reset drops every pinch')
  m.read()
  assert.equal(m.analog.moveY, 0)
})
