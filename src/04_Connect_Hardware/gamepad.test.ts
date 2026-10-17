// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the standard-gamepad mapping the contract promises: left stick
 * move/steer (steer > 0 = left), right stick look, right trigger throttle, left trigger brake, south button
 * interact, north reset, east handbrake, right shoulder ping, left-stick click run latch, d-pad left/right clock — with dead zones, edge detection, multi-pad merge,
 * pads without the standard mapping read by position (the face button that wakes one doing nothing else; left stick
 * and face buttons always; the Linux kernel's axis
 * order in full once its triggers have sat at rest, and dropped for good when a stick and a hat stand there instead (the
 * joystick driver's order, Chromium's on Windows); an axis read only after it is seen resting where its part rests,
 * timed in milliseconds whatever the frame rate, so a held stick, a held trigger, a trigger a browser reports as 0, a
 * pedal passing or pausing in the middle, a parked lever or a slider never moves anything on its own),
 * browser pad ids parsed, the controller family the HUD's glyphs follow, and the
 * right stick's first-person head motion (rates, curve, rim boost, easing, frame-rate independence).
 * What breaks if it is removed? A mapping slip (a flipped axis, a repeating edge, a wrong glyph family, a
 * head that drifts after the stick is released) could ship unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createAnalog, GENERIC_MS, GenericPads, isUsablePad, PAD, PAD_EDGE, PAD_LOOK, PAD_TUNING, PadLook, PadMapper, padFamilyOf, padName, parsePadId,
  radialDeadzone, triggerValue,
} from './gamepad.ts'
import type { GamepadLike } from './web-hardware.d.ts'

function pad(opts: { index?: number; id?: string; axes?: number[]; pressed?: number[]; values?: Record<number, number>; mapping?: string; connected?: boolean } = {}): GamepadLike {
  const buttons = Array.from({ length: 17 }, (_, i) => {
    const value = opts.values?.[i] ?? (opts.pressed?.includes(i) ? 1 : 0)
    return { pressed: value > 0.5 || !!opts.pressed?.includes(i), value }
  })
  return {
    id: opts.id ?? 'Test pad (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)',
    index: opts.index ?? 0,
    connected: opts.connected ?? true,
    mapping: opts.mapping ?? 'standard',
    timestamp: 1,
    axes: opts.axes ?? [0, 0, 0, 0],
    buttons,
  }
}

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps

/** A frame at 60 frames a second, and the reads it takes at `frame` ms apart to hold a pattern for `ms` (the first read
 *  of a run counts no time; one more covers rounding). */
const FRAME_MS = 1000 / 60
const readsFor = (ms: number, frame = FRAME_MS) => Math.ceil(ms / frame) + 2
/** A PadMapper whose clock moves `frame` ms per read, as the page's does at a steady frame rate. */
function mapper(frame = FRAME_MS): PadMapper {
  let t = 0
  return new PadMapper(() => (t += frame))
}

test('radial dead zone zeroes the centre, rescales the rest and clamps corners', () => {
  const v = { x: 9, y: 9 }
  radialDeadzone(0.1, 0.05, 0.14, v)
  assert.deepEqual(v, { x: 0, y: 0 })
  radialDeadzone(1, 0, 0.14, v)
  assert.ok(close(v.x, 1) && close(v.y, 0))
  radialDeadzone(0.57, 0, 0.14, v)
  assert.ok(close(v.x, 0.5))
  radialDeadzone(1, 1, 0.14, v)
  assert.ok(close(Math.hypot(v.x, v.y), 1) && close(v.x, v.y), 'square-gate corner clamps to 1, keeps direction')
  radialDeadzone(Number.NaN, 0.5, 0.14, v)
  assert.deepEqual(v, { x: 0, y: 0 })
})

test('trigger value has a small dead zone and full range', () => {
  assert.equal(triggerValue(undefined), 0)
  assert.equal(triggerValue({ pressed: false, value: 0.03 }), 0)
  assert.equal(triggerValue({ pressed: true, value: 1 }), 1)
  assert.equal(triggerValue({ pressed: true, value: 0 }), 1, 'digital trigger')
  assert.ok(close(triggerValue({ pressed: false, value: 0.52 }), 0.5))
})

test('sticks: left = move/steer (forward positive, left steer positive), right = look (up positive)', () => {
  const m = new PadMapper(), a = createAnalog()
  m.read([pad({ axes: [-1, 0, 0.8, -1] })], a)
  assert.ok(close(a.moveX, -1) && close(a.steer, 1), 'stick left: move left, steer left (+)')
  assert.ok(close(a.moveY, 0))
  m.read([pad({ axes: [0, -1, 0, 0] })], a)
  assert.ok(close(a.moveY, 1), 'stick up = forward')
  m.read([pad({ axes: [0, 0, 1, -1] })], a)
  const rim = 1 / Math.SQRT2
  assert.ok(close(a.lookX, rim) && close(a.lookY, rim), 'right stick up-right at the rim: look right and up at the full rate')
  m.read([pad({ axes: [0, 0, -0.5, 0] })], a)
  const r = (0.5 - PAD_TUNING.stickDeadzone) / (1 - PAD_TUNING.stickDeadzone)
  assert.ok(close(a.lookX, -r * r), 'radial quadratic: fine control near the centre')
  m.read([pad({ axes: [0, 0, 0.4, 0.4] })], a)
  const m2 = (Math.hypot(0.4, 0.4) - PAD_TUNING.stickDeadzone) / (1 - PAD_TUNING.stickDeadzone)
  assert.ok(close(Math.hypot(a.lookX, a.lookY), m2 * m2), 'the curve acts on the deflection, not per axis')
  assert.ok(close(a.lookX, -a.lookY), 'and keeps its direction')
})

test('triggers: right throttle, left brake; the east button holds the handbrake', () => {
  const m = new PadMapper(), a = createAnalog()
  m.read([pad({ values: { [PAD.r2]: 1, [PAD.l2]: 0.52 }, pressed: [PAD.east] })], a)
  assert.equal(a.throttle, 1)
  assert.ok(close(a.brake, 0.5))
  assert.equal(a.handbrake, true)
  m.read([pad()], a)
  assert.equal(a.throttle, 0)
  assert.equal(a.brake, 0)
  assert.equal(a.handbrake, false)
})

test('edges fire once per press: A interact, Y reset, right shoulder ping, d-pad left/right clock', () => {
  const m = new PadMapper(), a = createAnalog()
  assert.equal(m.read([pad({ pressed: [PAD.south] })], a), PAD_EDGE.interact)
  assert.equal(m.read([pad({ pressed: [PAD.south] })], a), 0, 'held: no repeat')
  assert.equal(m.read([pad()], a), 0)
  assert.equal(m.read([pad({ pressed: [PAD.south] })], a), PAD_EDGE.interact, 'released and pressed again')
  assert.equal(m.read([pad({ pressed: [PAD.north, PAD.left] })], a), PAD_EDGE.reset | PAD_EDGE.timeBack)
  assert.equal(m.read([pad({ pressed: [PAD.right] })], a), PAD_EDGE.timeForward)
  assert.equal(m.read([pad({ pressed: [PAD.r1] })], a), PAD_EDGE.ping, 'right shoulder: ping')
  assert.equal(m.read([pad({ pressed: [PAD.r1] })], a), 0, 'held: no repeat')
  assert.equal(m.read([pad()], a), 0)
  assert.equal(m.read([pad({ pressed: [PAD.r1, PAD.south] })], a), PAD_EDGE.ping | PAD_EDGE.interact, 'pressed again, with another edge')
  assert.equal(m.read([pad({ pressed: [PAD.west, PAD.l1, PAD.start, PAD.select] })], a), 0, 'unmapped buttons')
})

test('L3 latches run while the left stick is deflected; centring or another click clears it', () => {
  const m = new PadMapper(), a = createAnalog()
  m.read([pad({ axes: [0, -1, 0, 0], pressed: [PAD.l3] })], a)
  assert.equal(a.run, true)
  m.read([pad({ axes: [0, -1, 0, 0] })], a)
  assert.equal(a.run, true, 'latched after release')
  m.read([pad({ axes: [0, 0, 0, 0] })], a)
  assert.equal(a.run, false, 'stick centred')
  m.read([pad({ axes: [0, -1, 0, 0], pressed: [PAD.l3] })], a)
  m.read([pad({ axes: [0, -1, 0, 0] })], a)
  m.read([pad({ axes: [0, -1, 0, 0], pressed: [PAD.l3] })], a)
  assert.equal(a.run, false, 'second click toggles off')
})

test('several pads merge; disconnected and stickless pads are ignored; used/active track input', () => {
  const m = new PadMapper(), a = createAnalog()
  assert.equal(m.used, false)
  m.read([pad({ index: 0, axes: [0.3, 0, 0, 0] }), pad({ index: 1, axes: [0, -0.9, 0, 0], values: { [PAD.r2]: 0.6 } }), null], a)
  assert.ok(a.moveY > 0.8 && close(a.moveX, 0), 'the furthest-deflected stick wins')
  assert.ok(a.throttle > 0.5)
  assert.equal(m.used, true)
  assert.equal(m.active, true)
  m.read([pad({ index: 3, mapping: '', pressed: [PAD.south], axes: [1] }), pad({ connected: false, pressed: [PAD.south] }), pad({ index: 2 })], a)
  assert.deepEqual(a, createAnalog())
  assert.equal(m.active, false)
  assert.equal(m.used, true, 'a standard pad is still present')
  m.read([], a)
  assert.equal(m.used, false, 'cleared when every pad is gone')
  assert.equal(m.read(null, a), 0)
})

test('a pad without the standard mapping: the left stick walks and drives, south enters a car, east is the handbrake', () => {
  const m = mapper(), a = createAnalog()
  const generic = (axes: number[], pressed: number[] = []) => pad({ id: 'USB Gamepad', mapping: '', axes, pressed })
  assert.equal(isUsablePad(generic([0, 0])), true)
  assert.equal(isUsablePad(pad({ mapping: '', axes: [0] })), false, 'no stick')
  // First seen at rest, then pushed forward with south pressed: a walk and a door.
  m.read([generic([0, 0, 0, 0])], a)
  const edges = m.read([generic([0, -1, 0, 0], [PAD.south])], a)
  assert.equal(edges & PAD_EDGE.interact, PAD_EDGE.interact)
  assert.ok(a.moveY > 0.9, `forward (${a.moveY})`)
  assert.equal(m.active, true)
  assert.equal(m.used, true)
  m.read([generic([0.8, 0, 0, 0], [PAD.east])], a)
  assert.ok(a.steer < -0.6, 'stick right steers right')
  assert.equal(a.handbrake, true)
  // Four axes: axes 2/3 are the right stick (seen centred at the first read). Buttons past the shoulders are dropped.
  m.read([generic([0, 0, 0.9, 0], [6, 7, 9])], a)
  assert.ok(a.lookX > 0.5, 'right stick looks')
  assert.equal(a.throttle, 0, 'button 7 is not taken for a trigger on a pad of unknown order')
  assert.equal(a.brake, 0)
  assert.equal(m.generic.layoutOf(0), 'four-axis')
  const g = new GenericPads()
  g.view(generic([0, 0, 0, 0, 0]), 0)
  assert.equal(g.layoutOf(0), 'stick-only')
})

test('the face button that wakes a pad without the standard mapping does nothing else; a standard pad\'s first press acts', () => {
  const m = mapper(), a = createAnalog()
  const generic = (pressed: number[] = []) => pad({ id: 'USB Gamepad', mapping: '', pressed })
  // hal.ts passes such a pad on only from the read where a face button is down: that press is the wake.
  assert.equal(m.read([generic([PAD.south])], a), 0, 'no door opened by the wake')
  assert.equal(m.read([generic([PAD.south])], a), 0)
  m.read([generic()], a)
  assert.equal(m.read([generic([PAD.south])], a) & PAD_EDGE.interact, PAD_EDGE.interact, 'the next press is a door')
  // Gone for a read and back (another wake): the press is swallowed again.
  m.read([], a)
  assert.equal(m.read([generic([PAD.north])], a), 0, 'no car reset by the wake')
  // A standard pad has no wake: a browser shows it from its first press, which acts as before.
  const s = new PadMapper()
  assert.equal(s.read([pad({ pressed: [PAD.south] })], a) & PAD_EDGE.interact, PAD_EDGE.interact)
})

test('the Linux kernel\'s axis order (triggers resting at −1 on axes 2 and 5): sticks, triggers, d-pad and the remapped buttons', () => {
  const m = mapper(), a = createAnalog()
  const evdev = (axes: number[], pressed: number[] = []) => pad({ id: '45e-28e-Generic X-Box pad', index: 1, mapping: '', axes, pressed })
  const rest = [0, 0, -1, 0, 0, -1, 0, 0]
  m.read([evdev(rest)], a)
  assert.equal(m.generic.layoutOf(1), 'stick-only', 'one read is not a rest')
  for (let i = 1; i < readsFor(GENERIC_MS.rest); i++) m.read([evdev(rest)], a)
  assert.equal(m.generic.layoutOf(1), 'evdev', 'triggers at rest, sticks centred, for half a second: the kernel\'s order')
  assert.deepEqual(a, createAnalog(), 'at rest: no throttle, no brake, no look (the triggers are not sticks)')
  m.read([evdev([0, 0, -1, 0.9, -0.9, 1])], a)
  assert.ok(a.lookX > 0.5 && a.lookY > 0.5, 'right stick on axes 3/4')
  assert.equal(a.throttle, 1, 'right trigger fully pulled')
  assert.equal(a.brake, 0)
  m.read([evdev([0, 0, 0, 0, 0, -1])], a)
  assert.ok(close(a.brake, triggerValue({ pressed: false, value: 0.5 })), `left trigger half way (${a.brake})`)
  // The d-pad is two axes: right steps the clock on, left back.
  m.read([evdev(rest)], a)
  assert.equal(m.read([evdev([0, 0, -1, 0, 0, -1, 1, 0])], a) & PAD_EDGE.timeForward, PAD_EDGE.timeForward)
  m.read([evdev(rest)], a)
  assert.equal(m.read([evdev([0, 0, -1, 0, 0, -1, -1, 0])], a) & PAD_EDGE.timeBack, PAD_EDGE.timeBack)
  // Buttons: 0-5 as they are (5 is the right shoulder: a ping); 9 is the left stick click (the run latch).
  m.read([evdev(rest)], a)
  assert.equal(m.read([evdev(rest, [PAD.r1])], a) & PAD_EDGE.ping, PAD_EDGE.ping)
  m.read([evdev([0, -1, -1, 0, 0, -1], [9])], a)
  assert.equal(a.run, true, 'button 9 is the left stick click here')
  // Half throttle and half brake held together, wavering as fingers do, for seconds: still the kernel's order.
  for (let i = 0; i < readsFor(3000); i++) m.read([evdev([0, 0, (i % 3) * 0.03 - 0.03, 0, 0, (i % 2) * 0.05, 0, 0])], a)
  assert.equal(m.generic.layoutOf(1), 'evdev', 'triggers held at half by fingers are not a stick and a hat at rest')
})

test('a pad\'s axes are timed in milliseconds, not reads: the same at 144 frames a second, and a stall is not a rest', () => {
  const a = createAnalog()
  const evdev = (axes: number[]) => pad({ id: '45e-28e-Generic X-Box pad', mapping: '', axes })
  const rest = [0, 0, -1, 0, 0, -1, 0, 0]
  const fast = mapper(1000 / 144)
  for (let i = 0; i < readsFor(GENERIC_MS.rest); i++) fast.read([evdev(rest)], a)
  assert.equal(fast.generic.layoutOf(0), 'stick-only', 'half a second\'s worth of reads at 60 Hz is a fifth of a second at 144 Hz')
  for (let i = 0; i < readsFor(GENERIC_MS.rest, 1000 / 144); i++) fast.read([evdev(rest)], a)
  assert.equal(fast.generic.layoutOf(0), 'evdev')
  // Reads two seconds apart (a tab in the background): each counts for GENERIC_MS.gap at most.
  const slow = mapper(2000)
  for (let i = 0; i < GENERIC_MS.rest / GENERIC_MS.gap; i++) slow.read([evdev(rest)], a)
  assert.equal(slow.generic.layoutOf(0), 'stick-only')
  slow.read([evdev(rest)], a)
  assert.equal(slow.generic.layoutOf(0), 'evdev')
})

test('a stick or trigger held when the pad is first seen moves nothing, then works once let go', () => {
  const m = mapper(), a = createAnalog()
  // A four-axis pad first seen with its left stick pushed forward: no walk until the stick has rested centred.
  const four = (axes: number[]) => pad({ id: 'USB Gamepad', mapping: '', axes })
  m.read([four([0, -0.9, 0, 0])], a)
  assert.equal(a.moveY, 0, 'held at first sight: nothing yet')
  m.read([four([0, 0, 0, 0])], a)
  m.read([four([0, -1, 0, 0])], a)
  assert.equal(a.moveY, 0, 'passing the middle is not resting there')
  for (let i = 0; i < readsFor(GENERIC_MS.settle); i++) m.read([four([0, 0.004, 0, 0])], a)
  m.read([four([0, -1, 0, 0])], a)
  assert.ok(a.moveY > 0.9, `let go and rested, then it walks (${a.moveY})`)
  // The kernel's order, first seen with the right trigger held: never read backwards (no throttle when let go).
  const n = mapper()
  const evdev = (axes: number[]) => pad({ id: '45e-28e-Generic X-Box pad', index: 2, mapping: '', axes })
  n.read([evdev([0, 0, -1, 0, 0, 0.9, 0, 0])], a)
  assert.equal(a.throttle, 0)
  assert.equal(n.generic.layoutOf(2), 'stick-only', 'not the kernel\'s order until both triggers are seen at rest')
  for (let i = 0; i < readsFor(GENERIC_MS.rest); i++) n.read([evdev([0, 0, -1, 0, 0, -1, 0, 0])], a)
  assert.equal(n.generic.layoutOf(2), 'evdev')
  assert.equal(a.throttle, 0, 'let go: no throttle')
  assert.equal(n.active, false)
  n.read([evdev([0, 0, -1, 0, 0, 1, 0, 0])], a)
  assert.equal(a.throttle, 1, 'pulled fully: full throttle')
})

test('a browser that reports untouched triggers as 0 (Firefox) gets the full layout once they have been pressed', () => {
  const m = mapper(), a = createAnalog()
  const ff = (axes: number[], pressed: number[] = []) => pad({ id: '45e-28e-Generic X-Box pad', mapping: '', axes, pressed })
  m.read([ff([0, 0, 0, 0, 0, 0, 0, 0], [PAD.south])], a)
  assert.equal(m.generic.layoutOf(0), 'stick-only')
  assert.equal(a.throttle, 0, 'a trigger reading 0 is not half pulled')
  // The right trigger squeezed to about half and held there a while before the left one is ever pressed.
  for (let i = 0; i < readsFor(2 * GENERIC_MS.rest); i++) m.read([ff([0, 0, 0, 0, 0, (i % 4) * 0.03 - 0.04, 0, 0])], a)
  m.read([ff([0, 0, 1, 0, 0, 1, 0, 0])], a)
  assert.equal(a.throttle, 0, 'not read before it has been seen at rest')
  for (let i = 0; i < readsFor(GENERIC_MS.rest); i++) m.read([ff([0, 0, -1, 0, 0, -1, 0, 0])], a)
  assert.equal(m.generic.layoutOf(0), 'evdev', 'pressed and let go: now known')
  m.read([ff([0, 0, -1, 0.9, 0, 1, 0, 0])], a)
  assert.ok(a.lookX > 0.5, 'right stick on axis 3 looks')
  assert.equal(a.throttle, 1)
})

test('levers and sliders parked off centre (a throttle quadrant, a flight stick\'s slider) never drive, turn or step the clock', () => {
  const m = mapper(), a = createAnalog()
  const quadrant = (axes: number[]) => pad({ id: 'Throttle Quadrant', mapping: '', axes })
  for (let i = 0; i < 3; i++) m.read([quadrant([-0.4, -0.45, 0.3, -0.6])], a)
  assert.deepEqual(a, createAnalog())
  assert.equal(m.active, false)
  // The kernel's order with a slider on axis 6 resting at −1: no hat, so no clock step.
  const n = mapper()
  const stick = (axes: number[]) => pad({ id: 'Flight stick', index: 1, mapping: '', axes })
  for (let i = 0; i < readsFor(GENERIC_MS.rest); i++) n.read([stick([0, 0, -1, 0, 0, -1, -1, 0])], a)
  assert.equal(n.generic.layoutOf(1), 'evdev')
  assert.equal(n.read([stick([0, 0, -1, 0, 0, -1, -1, 0])], a) & PAD_EDGE.timeBack, 0)
})

test('a pedal resting at an end is never taken for a stick, even after passing the middle or pausing there under a foot', () => {
  for (const frame of [FRAME_MS, 1000 / 144]) {
    const m = mapper(frame), a = createAnalog()
    // A wheel: the wheel on axis 0, then accelerator, brake and clutch pedals resting at +1 (fully up).
    const wheel = (axes: number[], pressed: number[] = []) => pad({ id: '46d-c24f-Racing Wheel', mapping: '', axes, pressed })
    m.read([wheel([0, 1, 1, 1, 0, 0], [PAD.south])], a)
    // The accelerator on axis 1 (the left stick's Y by position) pressed to the floor and let go, then held near half
    // for three seconds, wavering as a foot does: up again, it reads nothing, where a stick there would walk backwards
    // for good.
    for (const y of [0.6, 0.1, -0.4, -1, -0.3, 0, 0.5, 1]) m.read([wheel([0, y, 1, 1, 0, 0])], a)
    for (let i = 0; i < readsFor(3000, frame); i++) m.read([wheel([0.02, 0.05 + 0.03 * Math.sin(i / 7), 1, 1, 0, 0])], a)
    m.read([wheel([0, 1, 1, 1, 0, 0])], a)
    assert.equal(a.moveY, 0, `the pedal at rest moves nobody (${frame.toFixed(1)} ms frames)`)
    assert.equal(m.active, false)
    assert.ok(Math.abs(a.steer) < 1e-9, 'the wheel centred steers nowhere')
    m.read([wheel([0.8, 1, 1, 1, 0, 0])], a)
    assert.ok(a.steer < -0.6, 'the wheel (first seen centred) steers at once')
  }
})

test('a stick and a hat where the kernel puts its triggers (the joystick driver, Chromium on Windows) are dropped for good once at rest', () => {
  const a = createAnalog()
  // The joystick driver's order: X Y (left stick), Z Rz (right stick), then the hat as two axes.
  const joy = (axes: number[]) => pad({ id: '79-11-USB Gamepad', mapping: '', axes })
  const m = mapper()
  for (let i = 0; i < 40; i++) m.read([joy([0, 0, 0, 0, 0, 0])], a)
  // The right stick pushed left (axis 2) and the hat held up (axis 5) at once, for a moment: nothing changes.
  for (let i = 0; i < 5; i++) m.read([joy([0, 0, -1, 0, 0, -1])], a)
  assert.equal(m.generic.layoutOf(0), 'stick-only')
  // Held that way for half a second, it is taken for the kernel's order: while it lasts, moving them brakes and
  // throttles. Let go, both rest centred and steady, and within half a second the order is dropped, for good.
  for (let i = 0; i < readsFor(GENERIC_MS.rest); i++) m.read([joy([0, 0, -1, 0, 0, -1])], a)
  assert.equal(m.generic.layoutOf(0), 'evdev', 'the one misreading this rule allows')
  m.read([joy([0, 0, 0.6, 0, 0, -1])], a)
  assert.ok(a.brake > 0.7, `the misread stick brakes as it moves (${a.brake})`)
  for (let i = 0; i < readsFor(GENERIC_MS.rest); i++) m.read([joy([0, 0, 0.004, 0, 0, 0])], a)
  assert.equal(m.generic.layoutOf(0), 'stick-only')
  assert.equal(a.throttle, 0)
  assert.equal(a.brake, 0)
  for (let i = 0; i < readsFor(3 * GENERIC_MS.rest); i++) m.read([joy([0, 0, -1, 0, 0, -1])], a)
  assert.equal(m.generic.layoutOf(0), 'stick-only', 'dropped once, never taken again')
  assert.equal(a.throttle, 0)
  assert.equal(a.brake, 0)
  // Chromium on Windows: X Y Z, two unused axes, Rz (the right stick on axes 2 and 5), then the hat on axis 9, which
  // rests out of range. The same once-only misreading, held up and to the left.
  const hid = (axes: number[]) => pad({ id: 'USB Gamepad (Vendor: 0079 Product: 0011)', index: 1, mapping: '', axes })
  const n = mapper()
  const at = (x: number, y: number) => [0, 0, x, 0, 0, y, 0, 0, 0, 1.2857]
  for (let i = 0; i < readsFor(GENERIC_MS.rest); i++) n.read([hid(at(-1, -1))], a)
  assert.equal(n.generic.layoutOf(1), 'evdev')
  for (let i = 0; i < readsFor(GENERIC_MS.rest); i++) n.read([hid(at(0, 0))], a)
  assert.equal(n.generic.layoutOf(1), 'stick-only')
  for (let i = 0; i < readsFor(3 * GENERIC_MS.rest); i++) n.read([hid(at(-1, -1))], a)
  assert.equal(n.generic.layoutOf(1), 'stick-only')
  assert.equal(a.throttle, 0)
  assert.equal(a.brake, 0)
})

test('a new pad in a slot is measured afresh; broken numbers read as centred', () => {
  const g = new GenericPads()
  let t = 0
  const read = (p: GamepadLike) => g.view(p, (t += FRAME_MS))
  const held = pad({ id: 'Held pad', mapping: '', axes: [0, -1, 0, 0] })
  assert.equal(read(held).axes[1], 0)
  for (let i = 0; i < readsFor(GENERIC_MS.settle); i++) assert.equal(read(pad({ id: 'Held pad', mapping: '', axes: [0, 0, 0, 0] })).axes[1], 0)
  assert.equal(read(pad({ id: 'Held pad', mapping: '', axes: [0, -1, 0, 0] })).axes[1], -1, 'rested centred: read')
  // Another pad in slot 0: measured again from scratch.
  const next = pad({ id: 'Next pad', mapping: '', axes: [0, -1, 0, 0] })
  assert.equal(read(next).axes[1], 0)
  assert.equal(g.layoutOf(0), 'four-axis')
  g.forget(0)
  assert.equal(g.layoutOf(0), null)
  const broken = read(pad({ id: 'Broken', index: 5, mapping: '', axes: [Number.NaN, Infinity, 0, 0] }))
  assert.ok(broken.axes.every(Number.isFinite))
  assert.equal(broken.mapping, 'standard')
})

test('edge state is per pad: a press on a second pad is its own edge', () => {
  const m = new PadMapper(), a = createAnalog()
  assert.equal(m.read([pad({ index: 0, pressed: [PAD.south] })], a), PAD_EDGE.interact)
  assert.equal(m.read([pad({ index: 0, pressed: [PAD.south] }), pad({ index: 1, pressed: [PAD.south] })], a), PAD_EDGE.interact)
  assert.equal(m.read([pad({ index: 0, pressed: [PAD.south] }), pad({ index: 1, pressed: [PAD.south] })], a), 0)
})

test('pad ids: Chromium and Firefox vendor/product, clean names', () => {
  assert.deepEqual(parsePadId('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'), { vendor: 0x054c, product: 0x0ce6 })
  assert.deepEqual(parsePadId('54c-df2-DualSense Edge Wireless Controller'), { vendor: 0x054c, product: 0x0df2 })
  assert.equal(parsePadId('Wireless Controller'), null)
  assert.equal(padName('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'), 'DualSense Wireless Controller')
  assert.equal(padName('Controller (XInput STANDARD GAMEPAD)'), 'Controller')
  assert.equal(padName('54c-df2-DualSense Edge Wireless Controller'), 'DualSense Edge Wireless Controller')
  assert.equal(padName(''), 'Gamepad')
  assert.ok(PAD_TUNING.stickDeadzone > 0.05 && PAD_TUNING.stickDeadzone < 0.25)
})

test('a broken driver reporting ±Infinity or NaN axes reads as centred, never as NaN steering', () => {
  const v = { x: 9, y: 9 }
  radialDeadzone(Number.POSITIVE_INFINITY, 0, 0.14, v)
  assert.deepEqual(v, { x: 0, y: 0 })
  radialDeadzone(Number.NaN, Number.NEGATIVE_INFINITY, 0.14, v)
  assert.deepEqual(v, { x: 0, y: 0 })
  const m = new PadMapper(), a = createAnalog()
  m.read([pad({ axes: [Number.NEGATIVE_INFINITY, Number.NaN, Number.POSITIVE_INFINITY, 1], values: { [PAD.r2]: Number.POSITIVE_INFINITY } })], a)
  for (const [k, x] of Object.entries(a)) if (typeof x === 'number') assert.ok(Number.isFinite(x), `${k} is finite`)
  assert.equal(a.throttle, 1)
})

test('pad layout: the USB vendor first, then what the id says, else generic (named by position, never mislabelled)', () => {
  assert.equal(padFamilyOf('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'), 'numbered')
  assert.equal(padFamilyOf('54c-df2-DualSense Edge Wireless Controller'), 'numbered', 'Firefox id')
  assert.equal(padFamilyOf('Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'), 'abxy')
  assert.equal(padFamilyOf('45e-b13-Wireless Controller'), 'abxy')
  assert.equal(padFamilyOf('Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)'), 'bayx')
  assert.equal(padFamilyOf('L+R (STANDARD GAMEPAD Vendor: 057e Product: 200e)'), 'bayx')
  // No vendor in the id: Chromium's XInput pads on Windows, the HAL's HID-decoded DualSense; any other bare name
  // (Safari reports none) is generic.
  assert.equal(padFamilyOf('Controller (XInput STANDARD GAMEPAD)'), 'abxy')
  // Valve's vendor id: Steam Input's virtual pad and the Steam Deck put A at the south button; Safari names the
  // PlayStation pads without a vendor id.
  assert.equal(padFamilyOf('Steam Virtual Gamepad (STANDARD GAMEPAD Vendor: 28de Product: 11ff)'), 'abxy')
  assert.equal(padFamilyOf('28de-1205-Steam Deck'), 'abxy')
  assert.equal(padFamilyOf('DUALSHOCK 4 Wireless Controller'), 'numbered')
  assert.equal(padFamilyOf('DualSense Wireless Controller'), 'numbered')
  assert.equal(padFamilyOf('DualSense Edge (HID)'), 'numbered')
  assert.equal(padFamilyOf('Wireless Controller'), 'generic')
  assert.equal(padFamilyOf('Input Controller'), 'generic', 'a word merely containing "input" is not XInput')
  assert.equal(padFamilyOf('8BitDo SN30 Pro (STANDARD GAMEPAD Vendor: 2dc8 Product: 6101)'), 'generic')
  assert.equal(padFamilyOf('USB Gamepad'), 'generic')
  assert.equal(padFamilyOf(''), 'generic')
})

test('PadMapper.family follows the pad used most recently; null before use and once every pad is gone', () => {
  const ps = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'
  const xb = 'Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'
  const m = new PadMapper(), a = createAnalog()
  m.read([pad({ index: 0, id: ps }), pad({ index: 1, id: xb })], a)
  assert.equal(m.family, null, 'connected but never used')
  m.read([pad({ index: 0, id: ps }), pad({ index: 1, id: xb, pressed: [PAD.south] })], a)
  assert.equal(m.family, 'abxy')
  m.read([pad({ index: 0, id: ps }), pad({ index: 1, id: xb })], a)
  assert.equal(m.family, 'abxy', 'idle: the last used pad still decides')
  m.read([pad({ index: 0, id: ps, axes: [0, 0, 0.9, 0] }), pad({ index: 1, id: xb })], a)
  assert.equal(m.family, 'numbered', 'the other pad moved a stick')
  m.read([pad({ index: 1, id: xb })], a)
  assert.equal(m.family, 'abxy', 'the used pad was unplugged: a pad still connected stands in')
  m.read([pad({ index: 1, id: xb, mapping: '', axes: [0] })], a)
  assert.equal(m.family, null, 'no usable pad left (a stickless one is not)')
  m.read([pad({ index: 3, id: 'Controller (XInput STANDARD GAMEPAD)', values: { [PAD.r2]: 0.8 } })], a)
  assert.equal(m.family, 'abxy', 'a trigger counts as use')
  m.read([], a)
  assert.equal(m.family, null)
})

/** Integrates PadLook over `seconds` at a fixed frame time; returns the total yaw and pitch. */
function spin(look: PadLook, lx: number, ly: number, seconds: number, dt: number): { yaw: number; pitch: number } {
  const out = { yaw: 0, pitch: 0 }, total = { yaw: 0, pitch: 0 }
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    look.step(lx, ly, dt, out)
    total.yaw += out.yaw
    total.pitch += out.pitch
  }
  return total
}

test('head look from the right stick: first-person rates, calmer pitch, a rim boost for an about-face', () => {
  const look = new PadLook()
  const first = spin(look, 1, 0, 0.25, 1 / 60)
  assert.ok(first.yaw > 0.35 && first.yaw < 0.25 * PAD_LOOK.yawRate, `quarter second at full right: ${first.yaw.toFixed(3)} rad (eases in, no boost yet)`)
  assert.equal(first.pitch, 0)
  const rest = spin(look, 1, 0, 1.75, 1 / 60)
  const total = first.yaw + rest.yaw
  assert.ok(total > 2 * PAD_LOOK.yawRate && total < 2 * (PAD_LOOK.yawRate + PAD_LOOK.boost), `2 s at the rim: ${total.toFixed(2)} rad (boosted beyond the base rate)`)
  assert.ok(total > Math.PI, 'a 2 s hold turns the head right round')
  look.reset()
  const nod = spin(look, 0, 1, 1, 1 / 60)
  assert.ok(nod.pitch > 0.8 * PAD_LOOK.pitchRate && nod.pitch < PAD_LOOK.pitchRate, `1 s full up: ${nod.pitch.toFixed(2)} rad`)
  assert.ok(PAD_LOOK.pitchRate < PAD_LOOK.yawRate, 'nodding is slower than turning')
  look.reset()
  const half = spin(look, 0.25, 0, 1, 1 / 60)
  assert.ok(half.yaw > 0.2 && half.yaw < 0.25 * PAD_LOOK.yawRate + 1e-9, `half deflection (0.25 after the curve): ${half.yaw.toFixed(3)} rad/s, never boosted`)
  look.reset()
  const left = spin(look, -1, -1, 0.5, 1 / 60)
  assert.ok(left.yaw < 0 && left.pitch < 0, 'left and down are negative')
})

test('head look stops almost at once when the stick is released, and reverses without a long overshoot', () => {
  const look = new PadLook()
  spin(look, 1, 1, 1, 1 / 60)
  const coast = spin(look, 0, 0, 0.5, 1 / 60)
  assert.ok(coast.yaw > 0 && coast.yaw < 0.1, `after release the head drifts ${(coast.yaw * 180 / Math.PI).toFixed(1)}°`)
  assert.ok(coast.pitch > 0 && coast.pitch < 0.06)
  assert.equal(look.yawRate, 0, 'settles to exactly zero')
  assert.equal(look.pitchRate, 0)
  spin(look, 1, 0, 1, 1 / 60)
  const out = { yaw: 0, pitch: 0 }
  let t = 0
  while (look.yawRate > 0 && t < 1) { look.step(-1, 0, 1 / 60, out); t += 1 / 60 }
  assert.ok(t < 0.12, `reversal crosses zero in ${(t * 1000).toFixed(0)} ms`)
})

test('head look is frame-rate independent and survives broken input', () => {
  const at = (hz: number) => spin(new PadLook(), 0.7, -0.4, 1.5, 1 / hz)
  const ref = at(240)
  for (const hz of [30, 60, 90, 144]) {
    const r = at(hz)
    assert.ok(Math.abs(r.yaw - ref.yaw) / Math.abs(ref.yaw) < 0.02, `${hz} Hz yaw ${r.yaw.toFixed(4)} vs ${ref.yaw.toFixed(4)}`)
    assert.ok(Math.abs(r.pitch - ref.pitch) / Math.abs(ref.pitch) < 0.02, `${hz} Hz pitch`)
  }
  const look = new PadLook(), out = { yaw: 9, pitch: 9 }
  look.step(Number.NaN, Number.POSITIVE_INFINITY, 1 / 60, out)
  assert.deepEqual(out, { yaw: 0, pitch: 0 })
  look.step(1, 1, -1, out)
  assert.deepEqual(out, { yaw: 0, pitch: 0 }, 'no time, no motion')
  look.step(5, -5, 1 / 60, out)
  assert.ok(Number.isFinite(out.yaw) && out.yaw <= PAD_LOOK.yawRate / 60, 'out-of-range axes are clamped')
  const big = spin(new PadLook(), 1, 0, 1, 1)
  assert.ok(big.yaw <= 0.1 * (PAD_LOOK.yawRate + PAD_LOOK.boost) + 1e-9, 'a 1 s hitch turns by at most one 0.1 s step')
})
