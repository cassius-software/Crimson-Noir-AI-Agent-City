/**
 * Why does this file exist? It pins the frame loop's control maths before and after it became a function: for a
 * table of intents the pure mapping gives exactly what the engine's inline block gave (walk, run, stand, the
 * normalised diagonal, the half-pushed stick; steer, throttle, brake, handbrake and the max() merge of keys,
 * triggers and stick), every output is finite whatever the intent holds, and the body heading wraps to [−π, π].
 * What breaks if it is removed? A speed, a sign or a merge rule could drift from what the README promises, or
 * a NaN from a broken axis could reach the physics realm, and nothing would notice.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAnalog, type Analog } from '../04_Connect_Hardware/gamepad.ts'
import { CONTROL_KEYS, readControls, type ControlSource } from './controls.ts'
import { RUN, WALK, type DriveControls, type FootControls } from './simProtocol.ts'

/** A stand-in for one player's intent: held keys in a Set, a hand-built Analog. */
function intent(opts: { yaw?: number; keys?: string[]; analog?: Partial<Analog> } = {}): ControlSource {
  const keys = new Set(opts.keys ?? [])
  return { yaw: opts.yaw ?? 0, analog: { ...createAnalog(), ...opts.analog }, down: (code) => keys.has(code) }
}

const foot = (): FootControls => ({ x: 99, z: 99, heading: 99 })
const drive = (): DriveControls => ({ steer: 99, fwd: 99, back: 99, handbrake: true })
const close = (a: number, b: number, eps = 1e-12) => Math.abs(a - b) < eps

/**
 * The engine's control block as it was inline (engine.ts frame(), before controls.ts), copied verbatim: the
 * oracle the pure mapping must reproduce for every finite intent.
 */
function engineBlock(input: ControlSource, driving: number, foot: FootControls, drive: DriveControls): void {
  const a = input.analog
  const yaw = input.yaw
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw)
  const rx = Math.cos(yaw), rz = -Math.sin(yaw)
  foot.x = 0; foot.z = 0
  foot.heading = yaw + Math.PI
  drive.steer = 0; drive.fwd = 0; drive.back = 0; drive.handbrake = false
  if (driving < 0) {
    let mx = 0, mz = 0
    if (input.down('KeyW')) { mx += fx; mz += fz }
    if (input.down('KeyS')) { mx -= fx; mz -= fz }
    if (input.down('KeyD')) { mx += rx; mz += rz }
    if (input.down('KeyA')) { mx -= rx; mz -= rz }
    mx += fx * a.moveY + rx * a.moveX
    mz += fz * a.moveY + rz * a.moveX
    const len = Math.hypot(mx, mz)
    const speed = input.down('ShiftLeft') || a.run ? RUN : WALK
    const k = len > 1 ? speed / len : speed
    foot.x = mx * k
    foot.z = mz * k
  } else {
    drive.steer = Math.max(-1, Math.min(1, (input.down('KeyA') ? 1 : 0) - (input.down('KeyD') ? 1 : 0) + a.steer))
    drive.fwd = input.down('KeyW') ? 1 : Math.max(a.throttle, a.moveY > 0 ? a.moveY : 0)
    drive.back = input.down('KeyS') ? 1 : Math.max(a.brake, a.moveY < 0 ? -a.moveY : 0)
    drive.handbrake = input.down('Space') || a.handbrake
  }
}

test('the keys are the README\'s: WASD, left Shift to run, Space for the handbrake', () => {
  assert.deepEqual(CONTROL_KEYS, { forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', run: 'ShiftLeft', handbrake: 'Space' })
  assert.ok(Object.isFrozen(CONTROL_KEYS))
  assert.equal(WALK, 2.0)
  assert.equal(RUN, 5.2)
})

test('on foot: stand, walk, run, the normalised diagonal and the half-pushed stick, at yaw 0', () => {
  const f = foot(), d = drive()
  // Standing: both sets at rest, the drive set zeroed too.
  readControls(intent(), false, f, d)
  assert.deepEqual([f.x, f.z], [0, 0])
  assert.deepEqual(d, { steer: 0, fwd: 0, back: 0, handbrake: false })
  // W walks forward: forward at yaw 0 is −z.
  readControls(intent({ keys: ['KeyW'] }), false, f, d)
  assert.ok(close(f.x, 0) && close(f.z, -WALK), `W: ${f.x}, ${f.z}`)
  // S walks back, D right (+x), A left.
  readControls(intent({ keys: ['KeyS'] }), false, f, d)
  assert.ok(close(f.x, 0) && close(f.z, WALK))
  readControls(intent({ keys: ['KeyD'] }), false, f, d)
  assert.ok(close(f.x, WALK) && close(f.z, 0))
  readControls(intent({ keys: ['KeyA'] }), false, f, d)
  assert.ok(close(f.x, -WALK) && close(f.z, 0))
  // W+D: the diagonal is normalised to one walking speed.
  readControls(intent({ keys: ['KeyW', 'KeyD'] }), false, f, d)
  assert.ok(close(Math.hypot(f.x, f.z), WALK), 'diagonal at walking speed')
  assert.ok(close(f.x, WALK / Math.SQRT2) && close(f.z, -WALK / Math.SQRT2))
  // W+S cancel.
  readControls(intent({ keys: ['KeyW', 'KeyS'] }), false, f, d)
  assert.deepEqual([f.x, f.z], [0, 0])
  // Shift runs; the pad's run latch runs too.
  readControls(intent({ keys: ['KeyW', 'ShiftLeft'] }), false, f, d)
  assert.ok(close(f.z, -RUN), `Shift: ${f.z}`)
  readControls(intent({ analog: { moveY: 1, run: true } }), false, f, d)
  assert.ok(close(f.z, -RUN), `run latch: ${f.z}`)
  // A half-pushed stick walks at half speed; a stick plus a key beyond unit length is normalised.
  readControls(intent({ analog: { moveY: 0.5 } }), false, f, d)
  assert.ok(close(f.x, 0) && close(f.z, -WALK / 2), `half stick: ${f.z}`)
  readControls(intent({ analog: { moveX: 0.5 } }), false, f, d)
  assert.ok(close(f.x, WALK / 2) && close(f.z, 0), 'half stick right')
  readControls(intent({ keys: ['KeyW'], analog: { moveY: 1 } }), false, f, d)
  assert.ok(close(f.z, -WALK), 'key and stick together do not exceed a walk')
  // Shift while standing still is still standing.
  readControls(intent({ keys: ['ShiftLeft'] }), false, f, d)
  assert.deepEqual([f.x, f.z], [0, 0])
})

test('on foot: the basis follows the head yaw (forward = (−sin yaw, −cos yaw), right = (cos yaw, −sin yaw))', () => {
  const f = foot(), d = drive()
  const yaw = Math.PI / 2
  readControls(intent({ yaw, keys: ['KeyW'] }), false, f, d)
  assert.ok(close(f.x, -WALK) && close(f.z, 0), `W at yaw π/2 walks −x: ${f.x}, ${f.z}`)
  readControls(intent({ yaw, keys: ['KeyD'] }), false, f, d)
  assert.ok(close(f.x, 0) && close(f.z, -WALK), `D at yaw π/2 walks −z: ${f.x}, ${f.z}`)
  readControls(intent({ yaw: 0.7, analog: { moveX: 0.3, moveY: 0.4 } }), false, f, d)
  const fx = -Math.sin(0.7), fz = -Math.cos(0.7), rx = Math.cos(0.7), rz = -Math.sin(0.7)
  assert.ok(close(f.x, (fx * 0.4 + rx * 0.3) * WALK) && close(f.z, (fz * 0.4 + rz * 0.3) * WALK))
})

test('at the wheel: steer, throttle, brake and handbrake from keys, triggers and the stick, merged by max()', () => {
  const f = foot(), d = drive()
  // At rest: everything zero, and the foot set is at rest too.
  readControls(intent(), true, f, d)
  assert.deepEqual(d, { steer: 0, fwd: 0, back: 0, handbrake: false })
  assert.deepEqual([f.x, f.z], [0, 0])
  // A steers left (+1), D right (−1), both cancel; the stick adds and the sum is clamped.
  readControls(intent({ keys: ['KeyA'] }), true, f, d)
  assert.equal(d.steer, 1)
  readControls(intent({ keys: ['KeyD'] }), true, f, d)
  assert.equal(d.steer, -1)
  readControls(intent({ keys: ['KeyA', 'KeyD'] }), true, f, d)
  assert.equal(d.steer, 0)
  readControls(intent({ keys: ['KeyA'], analog: { steer: 0.5 } }), true, f, d)
  assert.equal(d.steer, 1, 'clamped')
  readControls(intent({ keys: ['KeyD'], analog: { steer: 0.25 } }), true, f, d)
  assert.equal(d.steer, -0.75)
  readControls(intent({ analog: { steer: -0.4 } }), true, f, d)
  assert.equal(d.steer, -0.4)
  // W is full throttle; otherwise the larger of the right trigger and the forward stick.
  readControls(intent({ keys: ['KeyW'] }), true, f, d)
  assert.equal(d.fwd, 1)
  readControls(intent({ analog: { throttle: 0.3, moveY: 0.6 } }), true, f, d)
  assert.equal(d.fwd, 0.6)
  readControls(intent({ analog: { throttle: 0.7, moveY: 0.6 } }), true, f, d)
  assert.equal(d.fwd, 0.7)
  readControls(intent({ analog: { throttle: 0.7, moveY: -0.6 } }), true, f, d)
  assert.equal(d.fwd, 0.7, 'a backward stick does not reduce the throttle')
  assert.equal(d.back, 0.6, 'the backward stick brakes')
  // S is full brake; otherwise the larger of the left trigger and the backward stick.
  readControls(intent({ keys: ['KeyS'], analog: { brake: 0.2 } }), true, f, d)
  assert.equal(d.back, 1)
  readControls(intent({ analog: { brake: 0.2, moveY: -0.1 } }), true, f, d)
  assert.equal(d.back, 0.2)
  readControls(intent({ analog: { brake: 0.2, moveY: 0.9 } }), true, f, d)
  assert.equal(d.back, 0.2, 'the left trigger brakes under a forward stick')
  assert.equal(d.fwd, 0.9)
  // Space or the pad's handbrake.
  readControls(intent({ keys: ['Space'] }), true, f, d)
  assert.equal(d.handbrake, true)
  readControls(intent({ analog: { handbrake: true } }), true, f, d)
  assert.equal(d.handbrake, true)
  readControls(intent({ keys: ['KeyW', 'KeyS', 'KeyA', 'KeyD'] }), true, f, d)
  assert.deepEqual(d, { steer: 0, fwd: 1, back: 1, handbrake: false })
  // Walking keys at the wheel do not fill the foot set.
  readControls(intent({ keys: ['KeyW', 'ShiftLeft'], analog: { moveY: 1 } }), true, f, d)
  assert.deepEqual([f.x, f.z], [0, 0])
})

test('the pure mapping reproduces the engine\'s inline block for a table of intents, on foot and at the wheel', () => {
  // A small deterministic generator (LCG) so the table is the same every run.
  let s = 12345
  const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 0x100000000 }
  const KEYS = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ShiftLeft', 'Space']
  const f1 = foot(), d1 = drive(), f2 = foot(), d2 = drive()
  let compared = 0
  for (let i = 0; i < 2000; i++) {
    const keys = KEYS.filter(() => rnd() < 0.3)
    const analog: Partial<Analog> = {
      moveX: rnd() < 0.5 ? 0 : rnd() * 2 - 1,
      moveY: rnd() < 0.5 ? 0 : rnd() * 2 - 1,
      steer: rnd() < 0.5 ? 0 : rnd() * 2 - 1,
      throttle: rnd() < 0.5 ? 0 : rnd(),
      brake: rnd() < 0.5 ? 0 : rnd(),
      run: rnd() < 0.2,
      handbrake: rnd() < 0.2,
    }
    const yaw = (rnd() - 0.5) * 40
    const it = intent({ yaw, keys, analog })
    for (const driving of [false, true]) {
      engineBlock(it, driving ? 0 : -1, f1, d1)
      readControls(it, driving, f2, d2)
      assert.ok(close(f1.x, f2.x) && close(f1.z, f2.z), `foot ${i}: ${f1.x},${f1.z} vs ${f2.x},${f2.z}`)
      // The heading is wrapped: the same direction as the engine's unwrapped yaw + π.
      assert.ok(close(Math.sin(f1.heading), Math.sin(f2.heading), 1e-9) && close(Math.cos(f1.heading), Math.cos(f2.heading), 1e-9), `heading ${i}`)
      assert.equal(d2.steer, d1.steer, `steer ${i}`)
      assert.equal(d2.fwd, d1.fwd, `fwd ${i}`)
      assert.equal(d2.back, d1.back, `back ${i}`)
      assert.equal(d2.handbrake, d1.handbrake, `handbrake ${i}`)
      compared++
    }
  }
  assert.equal(compared, 4000)
})

test('the heading wraps into [−π, π] and faces away from the view', () => {
  const f = foot(), d = drive()
  readControls(intent({ yaw: 0 }), false, f, d)
  assert.ok(close(Math.abs(f.heading), Math.PI), `yaw 0 → ±π (the body faces +z, the view −z): ${f.heading}`)
  readControls(intent({ yaw: Math.PI / 2 }), false, f, d)
  assert.ok(close(f.heading, -Math.PI / 2))
  for (const yaw of [10 * Math.PI, -10 * Math.PI, 1e6, -1e6, 123.456]) {
    readControls(intent({ yaw }), true, f, d)
    assert.ok(f.heading >= -Math.PI && f.heading <= Math.PI, `yaw ${yaw} → ${f.heading}`)
    assert.ok(close(Math.sin(f.heading), Math.sin(yaw + Math.PI), 1e-6) && close(Math.cos(f.heading), Math.cos(yaw + Math.PI), 1e-6), `direction kept for yaw ${yaw}`)
  }
})

test('NaN never leaks: a non-finite yaw or axis reads as centred, in both sets', () => {
  const finite = (f: FootControls, d: DriveControls) => [f.x, f.z, f.heading, d.steer, d.fwd, d.back].every(Number.isFinite) && typeof d.handbrake === 'boolean'
  const f = foot(), d = drive()
  for (const yaw of [NaN, Infinity, -Infinity]) {
    for (const driving of [false, true]) {
      readControls(intent({ yaw, keys: ['KeyW', 'KeyA'], analog: { moveX: 0.5, moveY: 0.5, steer: 0.5, throttle: 0.5 } }), driving, f, d)
      assert.ok(finite(f, d), `yaw ${yaw}, driving ${driving}`)
      assert.ok(f.heading >= -Math.PI && f.heading <= Math.PI)
    }
  }
  const bad: Partial<Analog> = { moveX: NaN, moveY: Infinity, steer: -Infinity, throttle: NaN, brake: NaN }
  readControls(intent({ analog: bad }), false, f, d)
  assert.ok(finite(f, d))
  assert.deepEqual([f.x, f.z], [0, 0], 'a broken stick stands still')
  readControls(intent({ keys: ['KeyW'], analog: bad }), false, f, d)
  assert.ok(close(f.z, -WALK), 'the keys still walk beside a broken stick')
  readControls(intent({ analog: bad }), true, f, d)
  assert.ok(finite(f, d))
  assert.deepEqual(d, { steer: 0, fwd: 0, back: 0, handbrake: false }, 'a broken pad does not drive')
  readControls(intent({ keys: ['KeyA'], analog: bad }), true, f, d)
  assert.equal(d.steer, 1, 'the keys still steer beside a broken stick')
  // Booleans that are not booleans (a hostile frame) read as off.
  const odd = { ...createAnalog(), run: 'yes' as unknown as boolean, handbrake: 1 as unknown as boolean }
  readControls({ yaw: 0, analog: odd, down: () => false }, false, f, d)
  assert.deepEqual([f.x, f.z], [0, 0])
  readControls({ yaw: 0, analog: odd, down: () => false }, true, f, d)
  assert.equal(d.handbrake, false)
})

test('allocation-free and idempotent: the same intent fills the same objects with the same numbers', () => {
  const f = foot(), d = drive()
  const it = intent({ yaw: 1.2, keys: ['KeyW', 'KeyD', 'ShiftLeft'], analog: { moveX: 0.2 } })
  readControls(it, false, f, d)
  const a = { ...f, ...d }
  readControls(it, false, f, d)
  assert.deepEqual({ ...f, ...d }, a)
  assert.ok(close(Math.hypot(f.x, f.z), RUN), 'running on the normalised diagonal')
})
