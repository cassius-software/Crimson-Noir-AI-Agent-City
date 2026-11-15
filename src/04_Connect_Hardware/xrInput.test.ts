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
  isController, isPointerOnly, neckOf, PINCH, PinchDrag, pinchKindOf, roleOf, shapeOf, XR_AXIS, XR_BUTTON, XR_DEADZONE, XR_HOLD_OUT_MS,
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

test('a pair drives: right trigger throttles, squeeze brakes, the lower face button pings, the upper enters; left squeeze is the handbrake, left trigger pings, the left upper face button resets a car', () => {
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
  assert.equal(r.tap(right, XR_BUTTON.primary), PAD_EDGE.ping, 'the lower face button pings')
  assert.equal(r.tap(right, XR_BUTTON.secondary), PAD_EDGE.interact, 'the upper one enters or leaves')
  assert.equal(r.tap(left, XR_BUTTON.trigger), PAD_EDGE.ping, 'the left trigger pings')
  assert.equal(r.tap(left, XR_BUTTON.secondary), 0, 'the left upper face button on foot: nothing')
  m.driving = true
  assert.equal(r.tap(left, XR_BUTTON.secondary), PAD_EDGE.reset, 'at the wheel it rights the car')
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

test('out of a car: the hold counts only while stopped, a lone controller with an upper face button keeps its click for the handbrake, and every door is refused at speed with a buzz', () => {
  // A lone stick controller with no upper face button: its stick's click held while the car stays stopped is its door.
  const c = ctl('none', 4, 4)
  const r = rig([c])
  r.m.driving = true
  r.m.stopped = false
  down(c, XR_BUTTON.thumbstick)
  assert.equal(r.m.read(), 0)
  r.tick(XR_HOLD_OUT_MS + 200)
  assert.equal(r.m.read(), 0, 'moving: held on, nothing')
  r.m.stopped = true
  assert.equal(r.m.read(), 0, 'the car has only now stopped: the second starts here, no exit while it was still rolling')
  assert.equal(r.m.analog.handbrake, false, 'and the click is no handbrake on a controller whose click is its door')
  r.tick(XR_HOLD_OUT_MS / 2)
  assert.equal(r.m.read(), 0)
  r.m.stopped = false
  r.m.read()
  r.m.stopped = true
  r.tick(XR_HOLD_OUT_MS / 2 + 10)
  assert.equal(r.m.read(), 0, 'rolling again restarts the second')
  r.tick(XR_HOLD_OUT_MS + 10)
  assert.equal(r.m.read(), PAD_EDGE.interact, 'a full second stopped: out')
  r.tick(XR_HOLD_OUT_MS + 10)
  assert.equal(r.m.read(), 0, 'once per hold')
  down(c, XR_BUTTON.thumbstick, false)
  r.m.read()
  // A click held into the wheel (it was down before the car was) never counts.
  const k = ctl('none', 4, 4)
  const q = rig([k])
  down(k, XR_BUTTON.thumbstick)
  q.m.read()
  q.m.driving = true
  q.m.read()
  q.tick(XR_HOLD_OUT_MS + 10)
  assert.equal(q.m.read(), 0, 'held from before the wheel: no step out')
  // A lone controller with an upper face button: the click is the handbrake, held as long as you like; the button is the door.
  const h = ctl('right', 6, 4)
  const w = rig([h])
  w.m.driving = true
  down(h, XR_BUTTON.thumbstick)
  w.m.read()
  w.tick(XR_HOLD_OUT_MS * 3)
  assert.equal(w.m.read(), 0, 'a handbrake held through a stop is no exit')
  assert.equal(w.m.analog.handbrake, true)
  down(h, XR_BUTTON.thumbstick, false)
  w.m.read()
  // Every door at speed is refused, said once and buzzed on the controller that asked; stopped, it opens.
  const pulses: number[] = []
  const buzzing = (c: Fake) => Object.assign(c.gamepad as object, { hapticActuators: [{ pulse: (v: number) => { pulses.push(v); return Promise.resolve(true) } }] })
  const cases: [string, Fake[], (cs: Fake[]) => [Fake, number]][] = [
    ['the upper face button, alone', [ctl('none', 6, 4)], (cs) => [cs[0], XR_BUTTON.secondary]],
    ['the right upper face button of a pair', [ctl('left', 6, 4), ctl('right', 6, 4)], (cs) => [cs[1], XR_BUTTON.secondary]],
    ['a touchpad alone', [ctl('none', 3, 2)], (cs) => [cs[0], XR_BUTTON.touchpad]],
    ['the right touchpad of a wand pair', [ctl('left', 3, 2), ctl('right', 3, 2)], (cs) => [cs[1], XR_BUTTON.touchpad]],
    ['the touchpad beside a lone stick', [ctl('none', 4, 4)], (cs) => [cs[0], XR_BUTTON.touchpad]],
  ]
  for (const [what, cs, pick] of cases) {
    const t = rig(cs)
    const [src, button] = pick(cs)
    buzzing(src)
    if (button === XR_BUTTON.touchpad) touch(src, 0, 0)
    t.m.driving = true
    t.m.stopped = false
    pulses.length = 0
    assert.equal(t.tap(src, button), 0, `${what}: not at speed`)
    assert.equal(t.m.takeRefused(), true, `${what}: said`)
    assert.equal(t.m.takeRefused(), false, `${what}: said once`)
    assert.equal(pulses.length, 1, `${what}: buzzed once`)
    t.m.stopped = true
    assert.equal(t.tap(src, button), PAD_EDGE.interact, `${what}: stopped, out`)
  }
  // A controller with no actuator is refused just the same, without a throw.
  const bare = ctl('none', 6, 4)
  const u = rig([bare])
  u.m.driving = true
  u.m.stopped = false
  assert.equal(u.tap(bare, XR_BUTTON.secondary), 0)
  assert.equal(u.m.takeRefused(), true)
})

test('the trigger that opened the door gives no throttle until it is let go; one held as a controller wakes at the wheel neither', () => {
  for (const [hands, b, a] of [[['none'], 6, 4], [['left', 'right'], 4, 4], [['none'], 3, 2]] as const) {
    const cs = hands.map((h) => ctl(h, b, a))
    const r = rig(cs)
    const src = cs[cs.length - 1]
    r.m.nearCar = true
    down(src, XR_BUTTON.trigger)
    assert.equal(r.m.read(), PAD_EDGE.interact, `${hands.join('+')} ${b}/${a}: the trigger opens the door`)
    r.m.nearCar = false
    r.m.driving = true
    r.m.read()
    assert.equal(r.m.analog.throttle, 0, 'seated with the trigger still held: no lurch')
    r.m.read()
    assert.equal(r.m.analog.throttle, 0, 'nor on the frames after, while it is held')
    down(src, XR_BUTTON.trigger, false)
    r.m.read()
    down(src, XR_BUTTON.trigger)
    r.m.read()
    assert.equal(r.m.analog.throttle, 1, 'let go and pulled again: the throttle')
  }
  const c = ctl('none', 6, 4)
  const r = rig([])
  r.m.driving = true
  r.m.read()
  down(c, XR_BUTTON.trigger)
  r.m.sources = [c]
  r.m.read()
  assert.equal(r.m.analog.throttle, 0, 'woke at the wheel with the trigger held: nothing until let go')
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

test('a lone touchpad: a thumb resting at the edge before and after its click turns once, never three times', () => {
  const c = ctl('none', 3, 2)
  const r = rig([c])
  let total = 0
  touch(c, 0.9, 0)
  r.m.read(); total += r.m.turn
  assert.equal(r.m.turn, 0, 'a thumb at the edge alone never turns')
  down(c, XR_BUTTON.touchpad)
  r.m.read(); total += r.m.turn
  down(c, XR_BUTTON.touchpad, false)
  r.m.read(); total += r.m.turn
  r.m.read(); total += r.m.turn
  untouch(c)
  r.m.read(); total += r.m.turn
  assert.ok(close(total, XR_TURN.step), `one click, one step: ${total}`)
  assert.equal(r.m.analog.moveX, 0, 'and never a strafe')
})

test('a run latched by a wand pair goes when the partner leaves, since a lone touchpad cannot unlatch it', () => {
  const left = ctl('left', 3, 2), right = ctl('right', 3, 2)
  const r = rig([left, right])
  touch(left, 0, 0)
  r.tap(left, XR_BUTTON.touchpad)
  r.m.read()
  assert.equal(r.m.analog.run, true, 'latched')
  r.m.sources = [left]
  r.m.read()
  assert.equal(r.m.analog.run, false, 'alone it could never be unlatched: it goes')
  // A lone stick controller can unlatch, so its latch stays.
  const a = ctl('left', 6, 4), b = ctl('right', 6, 4)
  const q = rig([a, b])
  q.tap(a, XR_BUTTON.thumbstick)
  q.m.sources = [a]
  q.m.read()
  assert.equal(q.m.analog.run, true, 'a lone stick keeps it: its click toggles it')
  q.tap(a, XR_BUTTON.thumbstick)
  q.m.read()
  assert.equal(q.m.analog.run, false)
})

test('a pinch is judged as the head faces: a player turned in the room walks where they look by pinch, and a sideways draw snaps', () => {
  const id = {}
  // The head looks along the body's right (+x of the space): headOffset −π/2.
  const d = new PinchDrag()
  d.start(id, 'grip', false, 0, P(0, -0.3))
  d.sample(id, 10, P(0, -0.3), HEAD)
  d.sample(id, 20, P(0.15, -0.3), HEAD)
  const o = createAnalog()
  assert.equal(d.read(o, false, -Math.PI / 2), true)
  assert.ok(close(o.moveX, 1, 1e-6) && close(o.moveY, 0, 1e-6), `walks to the body's right, where the head looks: ${o.moveX}, ${o.moveY}`)
  assert.equal(d.takeTurn(), 0, 'and no snap')
  // The same draw with the head straight ahead is sideways: a snap to the right, no walk.
  const e = new PinchDrag()
  e.start(id, 'grip', false, 0, P(0, -0.3))
  e.sample(id, 10, P(0, -0.3), HEAD)
  e.sample(id, 20, P(0.15, -0.3), HEAD)
  const o2 = createAnalog()
  assert.equal(e.read(o2, false, 0), false)
  assert.ok(close(e.takeTurn(), XR_TURN.step))
  // Turned: a draw along the body's forward is the head's left: a snap to the left.
  const f = new PinchDrag()
  f.start(id, 'grip', false, 0, P(0, -0.3))
  f.sample(id, 10, P(0, -0.3), HEAD)
  f.sample(id, 20, P(0, -0.45), HEAD)
  f.read(createAnalog(), false, -Math.PI / 2)
  assert.ok(close(f.takeTurn(), -XR_TURN.step))
  // No dead band: a draw 58° round from forward (past the walk sector) and far enough sideways snaps.
  const g = new PinchDrag()
  const ang = (58 * Math.PI) / 180
  g.start(id, 'grip', false, 0, P(0, -0.3))
  g.sample(id, 10, P(0, -0.3), HEAD)
  g.sample(id, 20, P(0.15 * Math.sin(ang), -0.3 - 0.15 * Math.cos(ang)), HEAD)
  assert.equal(g.read(createAnalog(), false, 0), false, 'outside the walk sector: no walk')
  assert.ok(close(g.takeTurn(), XR_TURN.step), 'the rest of the circle is the turn\'s')
  // The mapper hands the drag its head offset on foot, none at the wheel.
  const m = new XrMapper()
  m.sources = []
  m.headOffset = -Math.PI / 2
  m.pinches.start(id, 'grip', false, 0, P(0, -0.3))
  m.pinches.sample(id, 10, P(0, -0.3), HEAD)
  m.pinches.sample(id, 20, P(0.15, -0.3), HEAD)
  m.read()
  assert.ok(close(m.analog.moveX, 1, 1e-6) && m.turn === 0, 'through the mapper too')
})

test('a hand that drops out of tracking mid-drag stands still; after a blink it resumes against its first anchor, after a long loss it is spent', () => {
  const id = {}
  for (const driving of [false, true]) {
    for (const frames of [1, 3]) {
      const d = new PinchDrag()
      d.start(id, 'grip', false, 0, P(0, -0.3))
      d.sample(id, 10, P(0, -0.3), HEAD)
      d.sample(id, 20, P(0, -0.45), HEAD)
      assert.equal(d.read(createAnalog(), driving), true, 'drawn forward: going')
      let t = 20
      for (let k = 0; k < frames; k++) d.sample(id, (t += 11), k % 2 ? P(0, -0.45) : null, k % 2 ? null : HEAD)
      const o = createAnalog()
      assert.equal(d.read(o, driving), false, `${frames} frame(s) without the hand or the head: still`)
      assert.ok(o.moveY === 0 && o.steer === 0)
      d.sample(id, (t += 11), P(0, -0.45), HEAD)
      const o2 = createAnalog()
      assert.equal(d.read(o2, driving), true, 'back where it was: it resumes, against the first anchor')
      assert.ok(close(o2.moveY, 1), `${o2.moveY}`)
      // Eased back to where the pinch began: it stops. Never a walk (or a reverse) the other way.
      let least = 1
      for (const z of [-0.42, -0.38, -0.34, -0.31, -0.3]) {
        d.sample(id, (t += 11), P(0, z), HEAD)
        const o3 = createAnalog()
        d.read(o3, driving)
        least = Math.min(least, o3.moveY)
      }
      assert.ok(least >= 0, `${driving ? 'driving' : 'walking'}, ${frames} frame(s): eased back never goes backward (${least})`)
    }
    // Untracked longer than lostMs: spent. It comes back anywhere and never walks again until pinched afresh.
    const d = new PinchDrag()
    d.start(id, 'grip', false, 0, P(0, -0.3))
    d.sample(id, 10, P(0, -0.3), HEAD)
    d.sample(id, 20, P(-0.1, -0.43), HEAD)
    for (let t = 30; t < 30 + PINCH.lostMs + 20; t += 11) d.sample(id, t, null, HEAD)
    assert.equal(d.read(createAnalog(), driving), false)
    for (const z of [-0.55, -0.3, -0.1, -0.5]) {
      d.sample(id, 600, P(0, z), HEAD)
      assert.equal(d.read(createAnalog(), driving), false, 'spent: wherever it comes back, nothing')
    }
    assert.equal(d.takeTurn(), 0)
    assert.equal(d.end(id, 900, P(0, -0.5)), 'none', 'and its release is no tap')
    // A fresh pinch walks again.
    d.start(id, 'grip', false, 1000, P(0, -0.3))
    d.sample(id, 1010, P(0, -0.3), HEAD)
    d.sample(id, 1020, P(0, -0.45), HEAD)
    assert.equal(d.read(createAnalog(), driving), true, 'pinched afresh: it goes')
  }
})

test('a glance aside mid-drag changes nothing: the drag is judged against the way the head faced when it began', () => {
  const id = {}
  const d = new PinchDrag()
  d.start(id, 'grip', false, 0, P(0, -0.3))
  d.sample(id, 10, P(0, -0.3), HEAD)
  d.sample(id, 20, P(0, -0.42), HEAD)
  const o = createAnalog()
  assert.equal(d.read(o, false, 0), true)
  for (const glance of [0.6, 1.05, -1.05, 0.96, 0]) {
    d.sample(id, 30, P(0, -0.42), HEAD)
    const g = createAnalog()
    assert.equal(d.read(g, false, glance), true, `a glance of ${glance} rad: still walking`)
    assert.ok(close(g.moveY, 1, 1e-6), `forward: ${g.moveY}`)
  }
  assert.equal(d.takeTurn(), 0, 'and never a snap')
})

test('when the walking pinch is let go, a second one held meanwhile starts afresh instead of jumping by how far it drifted', () => {
  const a = {}, b = {}
  const d = new PinchDrag()
  d.start(a, 'grip', false, 0, P(0, -0.3))
  d.start(b, 'grip', false, 0, P(0.3, -0.3))
  d.sample(a, 10, P(0, -0.3), HEAD)
  d.sample(b, 10, P(0.3, -0.3), HEAD)
  d.sample(a, 20, P(0, -0.45), HEAD)
  d.sample(b, 20, P(0.47, -0.3), HEAD) // drifted 17 cm while the other walked
  d.read(createAnalog(), false)
  d.takeTurn()
  d.end(a, 500, P(0, -0.45))
  d.sample(b, 520, P(0.47, -0.3), HEAD)
  const o = createAnalog()
  assert.equal(d.read(o, false), false, 'no walk')
  assert.equal(d.takeTurn(), 0, 'and no snap the frame after')
  d.sample(b, 540, P(0.47, -0.45), HEAD)
  assert.equal(d.read(o, false), true, 'it walks once it is drawn itself')
})

test('neckOf: the point the head turns about, whatever the head does, from the eyes and the head\'s orientation', () => {
  const at = (yaw: number, pitch = 0) => {
    // Yaw about y (+ to the left), then pitch about x (+ up): q = qy · qx.
    const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cx = Math.cos(pitch / 2), sx = Math.sin(pitch / 2)
    return { x: cy * sx, y: sy * cx, z: -sy * sx, w: cy * cx }
  }
  /** v turned by q. */
  const turn = (q: { x: number; y: number; z: number; w: number }, v: [number, number, number]) => {
    const [vx, vy, vz] = v
    const cx = q.y * vz - q.z * vy, cy = q.z * vx - q.x * vz, cz = q.x * vy - q.y * vx
    return { x: vx + 2 * (q.w * cx + q.y * cz - q.z * cy), y: vy + 2 * (q.w * cy + q.z * cx - q.x * cz), z: vz + 2 * (q.w * cz + q.x * cy - q.y * cx) }
  }
  const neck = { x: 1, y: 1.5, z: 2 }
  const eyesAt = (q: { x: number; y: number; z: number; w: number }) => { const e = turn(q, [0, PINCH.eyeUpM, -PINCH.eyeFwdM]); return { x: neck.x + e.x, y: neck.y + e.y, z: neck.z + e.z } }
  for (const yaw of [0, 0.7, Math.PI / 2, -2.5, Math.PI]) {
    for (const pitch of [0, 0.5, -0.6, Math.PI / 2, -Math.PI / 2]) {
      const q = at(yaw, pitch)
      const n = neckOf({ position: eyesAt(q), orientation: q })
      assert.ok(close(n.x, neck.x, 1e-9) && close(n.y, neck.y, 1e-9) && close(n.z, neck.z, 1e-9), `yaw ${yaw}, pitch ${pitch}: ${JSON.stringify(n)}`)
    }
  }
  const eyes = { x: 1, y: 1.6, z: 2 }
  assert.deepEqual(neckOf({ position: eyes }), eyes, 'no orientation: the eyes')
  assert.deepEqual(neckOf({ position: eyes, orientation: { x: 0, y: 0, z: 0, w: 0 } }), eyes, 'a broken one: the eyes')
  const unnormalised = neckOf({ position: eyesAt(at(0.4, 0.2)), orientation: { x: at(0.4, 0.2).x * 2, y: at(0.4, 0.2).y * 2, z: at(0.4, 0.2).z * 2, w: at(0.4, 0.2).w * 2 } })
  assert.ok(close(unnormalised.x, neck.x, 1e-9) && close(unnormalised.z, neck.z, 1e-9), 'an unnormalised one is normalised')
  // Turning and nodding with the hand still, looking up as in a city of tall buildings: the neck stays, nothing walks.
  for (const pitch of [0, 0.52, 0.7, -0.5]) {
    const id = {}
    const d = new PinchDrag()
    d.start(id, 'grip', false, 0, P(0.2, -0.35))
    let t = 0
    for (let k = 0; k <= 30; k++) { const q = at((k / 30) * (Math.PI / 2), pitch); d.sample(id, (t += 11), P(0.2, -0.35), neckOf({ position: eyesAt(q), orientation: q })) }
    assert.equal(d.read(createAnalog(), false), false, `pitched ${pitch}, a look a quarter round does not walk`)
    assert.equal(d.dragging, false)
    assert.equal(d.takeTurn(), 0)
  }
})

test('the step-out hold at speed is refused like any door, once per hold, then waits for the car to stop', () => {
  const c = ctl('none', 4, 4)
  const pulses: number[] = []
  Object.assign(c.gamepad as object, { hapticActuators: [{ pulse: (v: number) => { pulses.push(v) } }] })
  const r = rig([c])
  r.m.driving = true
  r.m.stopped = false
  down(c, XR_BUTTON.thumbstick)
  r.m.read()
  r.tick(XR_HOLD_OUT_MS - 10)
  r.m.read()
  assert.equal(r.m.takeRefused(), false, 'under a second: not yet')
  r.tick(20)
  assert.equal(r.m.read(), 0)
  assert.equal(r.m.takeRefused(), true, 'a second held at speed: said')
  assert.equal(pulses.length, 1, 'and buzzed')
  r.tick(XR_HOLD_OUT_MS * 2)
  r.m.read()
  assert.equal(r.m.takeRefused(), false, 'once per hold')
  assert.equal(pulses.length, 1)
  r.m.stopped = true
  r.m.read()
  r.tick(XR_HOLD_OUT_MS + 5)
  assert.equal(r.m.read(), PAD_EDGE.interact, 'held on through the stop: a second stopped, out')
})

test('a trigger held as it takes on the throttle (its partner left) gives none until let go', () => {
  const left = ctl('left', 6, 4), right = ctl('right', 6, 4)
  const r = rig([left, right])
  r.m.driving = true
  r.m.read()
  down(left, XR_BUTTON.trigger)
  r.m.read()
  assert.equal(r.m.analog.throttle, 0, 'the left trigger is no throttle in a pair')
  r.m.sources = [left]
  r.m.read()
  assert.equal(r.m.analog.throttle, 0, 'alone now, the held trigger does not become the throttle')
  down(left, XR_BUTTON.trigger, false)
  r.m.read()
  down(left, XR_BUTTON.trigger)
  r.m.read()
  assert.equal(r.m.analog.throttle, 1, 'let go and pulled: the throttle')
})

test('a blink while a draw is held out to the side is no second snap, and a blink in the speed band keeps full speed', () => {
  const id = {}
  for (const lose of ['hand', 'head'] as const) {
    for (const frames of [1, 3, 20]) {
      const d = new PinchDrag()
      d.start(id, 'grip', false, 0, P(0, -0.3))
      d.sample(id, 10, P(0, -0.3), HEAD)
      let t = 10, total = 0
      const frame = (hand: XrPoint | null, head: XrPoint | null) => { d.sample(id, (t += 11), hand, head); d.read(createAnalog(), false); total += d.takeTurn() }
      frame(P(0.11, -0.3), HEAD)
      frame(P(0.11, -0.3), HEAD)
      for (let k = 0; k < frames; k++) frame(lose === 'hand' ? null : P(0.11, -0.3), lose === 'head' ? null : HEAD)
      for (let k = 0; k < 4; k++) frame(P(0.11, -0.3), HEAD)
      assert.ok(close(total, XR_TURN.step), `${lose} lost for ${frames} frame(s): one snap in all (${total})`)
    }
  }
  // Drawn into the band where the speed holds (between the steps' hysteresis), a blink comes back at the same speed.
  const d = new PinchDrag()
  d.start(id, 'grip', false, 0, P(0, -0.3))
  d.sample(id, 10, P(0, -0.3), HEAD)
  d.sample(id, 20, P(0, -0.45), HEAD)
  d.sample(id, 30, P(0, -0.405), HEAD) // back to 10.5 cm: still full speed by hysteresis
  const o = createAnalog()
  d.read(o, false)
  assert.ok(close(o.moveY, 1, 1e-6), `held in the band: ${o.moveY}`)
  d.sample(id, 41, null, HEAD)
  assert.equal(d.read(createAnalog(), false), false)
  d.sample(id, 52, P(0, -0.405), HEAD)
  const o2 = createAnalog()
  d.read(o2, false)
  assert.ok(close(o2.moveY, 1, 1e-6), `after the blink: still full (${o2.moveY})`)
})

test('a light pull on a trigger as it takes on the throttle is held at nothing too', () => {
  for (const value of [0.2, 0.3, 0.45]) {
    const left = ctl('left', 6, 4), right = ctl('right', 6, 4)
    const r = rig([left, right])
    r.m.driving = true
    r.m.read()
    left.buttons[XR_BUTTON.trigger].value = value
    r.m.read()
    r.m.sources = [left]
    r.m.read()
    assert.equal(r.m.analog.throttle, 0, `a ${value} pull: no throttle as it takes over`)
    left.buttons[XR_BUTTON.trigger].value = 0
    r.m.read()
    left.buttons[XR_BUTTON.trigger].value = value
    r.m.read()
    assert.ok(r.m.analog.throttle > 0, 'let go and pulled again: it drives')
  }
})
