// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the headset mapper (xrInput.ts) against fake xr-standard sources: which sources
 * it reads and which it leaves to the session's select events, the left stick as the walk and the steer in the head's
 * frame, the snap turn's arm and re-arm, the right hand's throttle, brake, ping and interact edges, the run latch, a
 * source of no hand taking both duties, and reset(). No headset here: UNCONFIRMED on real hardware.
 * What breaks if it is removed? A regression could walk the body where the headset does not look, or snap every frame.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PAD_EDGE } from './gamepad.ts'
import { isPointerOnly, isTrackedController, roleOf, XR_AXIS, XR_BUTTON, XR_DEADZONE, XR_TURN, XrMapper } from './xrInput.ts'
import type { XrInputSourceLike } from './web-hardware.d.ts'

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps

interface Fake extends XrInputSourceLike {
  readonly axes: number[]
  readonly buttons: { pressed: boolean; value: number }[]
}

/** A tracked controller with the xr-standard mapping (axes and buttons are live arrays the test may edit). */
function controller(handedness: 'left' | 'right' | 'none', o: { axes?: number[]; pressed?: number[]; values?: Record<number, number> } = {}): Fake {
  const axes = o.axes ?? [0, 0, 0, 0]
  const buttons = Array.from({ length: 7 }, (_, i) => ({ pressed: !!o.pressed?.includes(i), value: o.values?.[i] ?? (o.pressed?.includes(i) ? 1 : 0) }))
  return { handedness, targetRayMode: 'tracked-pointer', profiles: ['meta-quest-touch-plus', 'generic-trigger-squeeze-thumbstick'], gamepad: { mapping: 'xr-standard', axes, buttons }, axes, buttons }
}

/** A gaze-and-pinch source: no gamepad, read by select events. */
const pinch = (): XrInputSourceLike => ({ handedness: 'none', targetRayMode: 'transient-pointer', profiles: [], gamepad: null })

test('which sources the mapper reads: xr-standard controllers with a thumbstick; the rest are pointers (pinches, hands, odd pads)', () => {
  assert.equal(isTrackedController(controller('left')), true)
  assert.equal(isPointerOnly(controller('left')), false)
  assert.equal(isPointerOnly(pinch()), true)
  const hand: XrInputSourceLike = { handedness: 'right', targetRayMode: 'tracked-pointer', profiles: ['generic-hand-select'], gamepad: null, hand: {} }
  assert.equal(isPointerOnly(hand), true)
  const oddMapping: XrInputSourceLike = { ...controller('right'), gamepad: { mapping: '', axes: [0, 0, 0, 0], buttons: [] } }
  assert.equal(isPointerOnly(oddMapping), true, 'without the xr-standard mapping the layout is unknown')
  const noStick: XrInputSourceLike = { ...controller('right'), gamepad: { mapping: 'xr-standard', axes: [0, 0], buttons: Array.from({ length: 7 }, () => ({ pressed: false, value: 0 })) } }
  assert.equal(isPointerOnly(noStick), true, 'two axes are a touchpad alone')
  assert.deepEqual([roleOf({ handedness: 'left' }), roleOf({ handedness: 'right' }), roleOf({ handedness: 'none' }), roleOf({ handedness: '' })], ['left', 'right', 'both', 'both'])
  assert.deepEqual(XR_BUTTON, { trigger: 0, squeeze: 1, touchpad: 2, thumbstick: 3, primary: 4, secondary: 5 })
  assert.deepEqual(XR_AXIS, { touchpadX: 0, touchpadY: 1, thumbX: 2, thumbY: 3 })
})

test('the left stick walks and steers, past the radial dead zone, in the head\'s frame when the head is turned', () => {
  const m = new XrMapper()
  assert.equal(m.read(), 0, 'no sources: nothing')
  assert.equal(m.live, false)
  const left = controller('left')
  m.sources = [left]
  assert.equal(m.live, true)
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
  assert.equal(m.active, false)
  // The head looks a quarter turn left of the body (headOffset = head yaw − body yaw): forward on the stick is the
  // head's forward, which in the body's frame is −sin(o) right and cos(o) forward.
  left.axes[XR_AXIS.thumbX] = 0
  left.axes[XR_AXIS.thumbY] = -1
  m.headOffset = Math.PI / 2
  m.read()
  assert.ok(close(m.analog.moveX, -1, 1e-9) && close(m.analog.moveY, 0, 1e-9), `turned: ${m.analog.moveX}, ${m.analog.moveY}`)
  m.headOffset = Math.PI / 6
  m.read()
  assert.ok(close(m.analog.moveX, -Math.sin(Math.PI / 6), 1e-9) && close(m.analog.moveY, Math.cos(Math.PI / 6), 1e-9))
  m.headOffset = 0
  const nothing = controller('left')
  m.sources = [nothing]
  m.read()
  assert.equal(m.analog.moveY, 0, 'a new still source: nothing carries over')
})

test('the right stick snap-turns once per flick, re-armed under the off threshold; the body yaw is what turns', () => {
  const m = new XrMapper()
  const right = controller('right')
  m.sources = [right]
  right.axes[XR_AXIS.thumbX] = XR_TURN.on
  m.read()
  assert.ok(close(m.turn, XR_TURN.step), 'a flick to the right: one step')
  m.turn = 0 // the reader (Input) takes it
  m.read()
  assert.equal(m.turn, 0, 'held past the threshold: no second step')
  right.axes[XR_AXIS.thumbX] = (XR_TURN.on + XR_TURN.off) / 2
  m.read()
  assert.equal(m.turn, 0, 'between the thresholds: not re-armed yet')
  right.axes[XR_AXIS.thumbX] = XR_TURN.off - 0.01
  m.read()
  assert.equal(m.turn, 0)
  right.axes[XR_AXIS.thumbX] = -1
  m.read()
  assert.ok(close(m.turn, -XR_TURN.step), 're-armed: a flick to the left steps the other way')
  assert.equal(m.analog.moveX, 0, 'the right stick never walks')
  assert.equal(XR_TURN.step, Math.PI / 6)
})

test('the right hand drives: trigger throttles, squeeze brakes; A pings and B interacts on the rising edge only', () => {
  const m = new XrMapper()
  const right = controller('right', { values: { [XR_BUTTON.trigger]: 0.6 } })
  m.sources = [right]
  m.read()
  assert.ok(m.analog.throttle > 0.5 && m.analog.throttle < 0.7, `throttle from the trigger's value: ${m.analog.throttle}`)
  assert.equal(m.analog.brake, 0)
  right.buttons[XR_BUTTON.squeeze].value = 1
  right.buttons[XR_BUTTON.squeeze].pressed = true
  m.read()
  assert.equal(m.analog.brake, 1)
  assert.equal(m.analog.handbrake, false, 'the right squeeze is the brake, not the handbrake')
  right.buttons[XR_BUTTON.primary].pressed = true
  right.buttons[XR_BUTTON.primary].value = 1
  assert.equal(m.read() & PAD_EDGE.ping, PAD_EDGE.ping, 'A pings')
  assert.equal(m.read(), 0, 'held: no second edge')
  right.buttons[XR_BUTTON.primary].pressed = false
  right.buttons[XR_BUTTON.primary].value = 0
  right.buttons[XR_BUTTON.secondary].pressed = true
  right.buttons[XR_BUTTON.secondary].value = 1
  assert.equal(m.read() & PAD_EDGE.interact, PAD_EDGE.interact, 'B interacts')
  assert.equal(m.read(), 0)
})

test('the left hand\'s squeeze is the handbrake and its thumbstick press latches a run; a source of no hand takes both duties', () => {
  const m = new XrMapper()
  const left = controller('left', { pressed: [XR_BUTTON.squeeze] })
  m.sources = [left]
  m.read()
  assert.equal(m.analog.handbrake, true)
  assert.equal(m.analog.brake, 0, 'the left squeeze never brakes')
  assert.equal(m.analog.run, false)
  left.buttons[XR_BUTTON.thumbstick].pressed = true
  left.buttons[XR_BUTTON.thumbstick].value = 1
  m.read()
  assert.equal(m.analog.run, true, 'pressed: the run latches')
  m.read()
  assert.equal(m.analog.run, true, 'held: stays')
  left.buttons[XR_BUTTON.thumbstick].pressed = false
  left.buttons[XR_BUTTON.thumbstick].value = 0
  m.read()
  left.buttons[XR_BUTTON.thumbstick].pressed = true
  left.buttons[XR_BUTTON.thumbstick].value = 1
  m.read()
  assert.equal(m.analog.run, false, 'pressed again: the run unlatches')
  const both = controller('none', { axes: [0, 0, 0, -1], values: { [XR_BUTTON.trigger]: 1 } })
  m.sources = [both]
  m.read()
  assert.ok(close(m.analog.moveY, 1) && close(m.analog.throttle, 1), 'no hand: it walks and it throttles')
  m.sources = [pinch(), both]
  assert.equal(m.read(), 0, 'a pinch beside it is left to the session\'s select events')
  assert.ok(close(m.analog.moveY, 1))
})

test('reset() stills everything and drops the run latch; a mapper without sources reads nothing and clears its turn', () => {
  const m = new XrMapper()
  const left = controller('left', { axes: [0, 0, 0, -1], pressed: [XR_BUTTON.thumbstick] })
  const right = controller('right', { axes: [0, 0, 1, 0] })
  m.sources = [left, right]
  m.read()
  assert.equal(m.analog.run, true)
  assert.ok(m.turn !== 0)
  m.reset()
  assert.equal(m.analog.run, false)
  assert.equal(m.analog.moveY, 0)
  assert.equal(m.turn, 0)
  assert.equal(m.active, false)
  m.sources = null
  m.turn = 1
  assert.equal(m.read(), 0)
  assert.equal(m.turn, 0, 'no sources: the turn is cleared, nothing lingers for Input to subtract')
  assert.equal(m.analog.run, false, 'the latch was dropped by reset and is not read back')
})
