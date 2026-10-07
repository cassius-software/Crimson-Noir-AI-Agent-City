/**
 * Why does this file exist? It proves the standard-gamepad mapping the contract promises: left stick
 * move/steer (steer > 0 = left), right stick look, right trigger throttle, left trigger brake, south button
 * interact, north reset, east handbrake, right shoulder ping, left-stick click run latch, d-pad left/right clock — with dead zones, edge detection, multi-pad merge,
 * non-standard pads ignored, browser pad ids parsed, the controller family the HUD's glyphs follow, and the
 * right stick's first-person head motion (rates, curve, rim boost, easing, frame-rate independence).
 * What breaks if it is removed? A mapping slip (a flipped axis, a repeating edge, a wrong glyph family, a
 * head that drifts after the stick is released) could ship unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createAnalog, PAD, PAD_EDGE, PAD_LOOK, PAD_TUNING, PadLook, PadMapper, padFamilyOf, padName, parsePadId, radialDeadzone, triggerValue,
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

test('several pads merge; non-standard and disconnected pads are ignored; used/active track input', () => {
  const m = new PadMapper(), a = createAnalog()
  assert.equal(m.used, false)
  m.read([pad({ index: 0, axes: [0.3, 0, 0, 0] }), pad({ index: 1, axes: [0, -0.9, 0, 0], values: { [PAD.r2]: 0.6 } }), null], a)
  assert.ok(a.moveY > 0.8 && close(a.moveX, 0), 'the furthest-deflected stick wins')
  assert.ok(a.throttle > 0.5)
  assert.equal(m.used, true)
  assert.equal(m.active, true)
  m.read([pad({ mapping: '', pressed: [PAD.south], axes: [1, 1, 1, 1] }), pad({ connected: false, pressed: [PAD.south] }), pad({ index: 2 })], a)
  assert.deepEqual(a, createAnalog())
  assert.equal(m.active, false)
  assert.equal(m.used, true, 'a standard pad is still present')
  m.read([], a)
  assert.equal(m.used, false, 'cleared when every pad is gone')
  assert.equal(m.read(null, a), 0)
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
  m.read([pad({ index: 1, id: xb, mapping: '' })], a)
  assert.equal(m.family, null, 'no standard pad left')
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
