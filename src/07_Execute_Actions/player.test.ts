/**
 * Why does this file exist? It proves the first-person head rig against a real three.js camera and real
 * Rapier bodies: the eye EYE_HEIGHT above the feet with horizontal motion never smoothed and vertical steps
 * eased (frame-rate independent, bounded lag, snaps on teleports and car exits); the camera posed as
 * (pitch, yaw, 0, 'YXZ') with head forward (−sin yaw·cos pitch, sin pitch, −cos yaw·cos pitch), pitch clamped,
 * never rolled; the driver's eye at DRIVER_EYE carried by the chassis (left seat, inside the cabin, SUV
 * raised); and the head carried by a turning car but kept within ±HEAD_TURN_LIMIT of the nose, continuously.
 * What breaks if it is removed? A camera that bobs, lags sideways, rolls with the car, sits in the wrong
 * seat or spins by 2π when the heading wraps could ship unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu'
import { PITCH_LIMIT as INPUT_PITCH_LIMIT } from '../04_Connect_Hardware/input.ts'
import { Physics } from './physics.ts'
import { Avatar } from './player.ts'
import { carriedYaw, DRIVER_EYE, EYE_HEIGHT, HEAD_TURN_LIMIT, HeadRig, PITCH_LIMIT, yawFacing } from './head.ts'

const H = 1 / 60
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps
const wrap = (a: number) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2))
const forwardOf = (cam: PerspectiveCamera) => cam.getWorldDirection(new Vector3())
/** Chassis orientation for a heading, exactly as vehicles.ts builds it (chassis +x forward). */
const chassis = (heading: number) => new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), heading - Math.PI / 2)

test('head constants: eye level, a shoulder-check turn limit, and the pitch limit Input clamps to', () => {
  assert.equal(EYE_HEIGHT, 1.7)
  assert.ok(close(HEAD_TURN_LIMIT, (110 * Math.PI) / 180))
  assert.ok(close(PITCH_LIMIT, (85 * Math.PI) / 180))
  assert.equal(PITCH_LIMIT, INPUT_PITCH_LIMIT, 'one definition')
  assert.ok(DRIVER_EYE.z < 0, 'driver sits on the left (−z): right-hand traffic')
  assert.ok(Object.isFrozen(DRIVER_EYE))
})

test('on foot: the eye is EYE_HEIGHT above the feet and the camera looks along the head forward', () => {
  const rig = new HeadRig(), cam = new PerspectiveCamera()
  for (const [yaw, pitch] of [[0, 0], [0.7, 0.3], [-2.2, -0.9], [3.1, 1.2], [12.5, -0.2]]) {
    rig.onFoot(cam, 10, 0.02, -4, yaw, pitch, H)
    assert.ok(close(cam.position.x, 10) && close(cam.position.y, 1.72) && close(cam.position.z, -4))
    assert.equal(cam.rotation.order, 'YXZ')
    assert.equal(cam.rotation.z, 0, 'no roll')
    const f = forwardOf(cam)
    const want = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)]
    assert.ok(close(f.x, want[0], 1e-6) && close(f.y, want[1], 1e-6) && close(f.z, want[2], 1e-6), `forward at yaw ${yaw}, pitch ${pitch}`)
    assert.deepEqual(rig.pose, { x: 10, y: 1.72, z: -4, yaw, pitch })
  }
  // matrixWorldInverse is fresh for the frustum the engine builds right after.
  const probe = new Vector3(10, 1.72, -4).applyMatrix4(cam.matrixWorldInverse)
  assert.ok(probe.length() < 1e-9)
})

test('yawFacing looks straight along a heading, forward (sin h, cos h)', () => {
  const rig = new HeadRig(), cam = new PerspectiveCamera()
  for (let h = -7; h <= 7; h += 0.37) {
    rig.onFoot(cam, 0, 0, 0, yawFacing(h), 0, H)
    const f = forwardOf(cam)
    assert.ok(close(f.x, Math.sin(h), 1e-6) && close(f.z, Math.cos(h), 1e-6) && close(f.y, 0, 1e-6), `heading ${h.toFixed(2)}`)
  }
})

test('horizontal motion is never smoothed; a step up or down is eased, bounded and frame-rate independent', () => {
  const rig = new HeadRig(), cam = new PerspectiveCamera()
  rig.onFoot(cam, 0, 0, 0, 0, 0, H)
  rig.onFoot(cam, 3, 0, -2, 0, 0, H)
  assert.ok(close(cam.position.x, 3) && close(cam.position.z, -2), 'a 3.6 m jump sideways lands the same frame')
  // A 0.2 m step up.
  rig.onFoot(cam, 3.05, 0.2, -2, 0, 0, H)
  const first = cam.position.y - EYE_HEIGHT
  assert.ok(first > 0.02 && first < 0.2, `first frame after the step: +${first.toFixed(3)} m of 0.2`)
  let t = H
  while (t < 0.5) { rig.onFoot(cam, 3.05, 0.2, -2, 0, 0, H); t += H }
  assert.ok(close(cam.position.y, EYE_HEIGHT + 0.2, 1e-3), 'settled on the new level')
  // Never more than 0.3 m behind the body (a 0.8 m drop in one frame).
  rig.onFoot(cam, 3.05, -0.6, -2, 0, 0, H)
  assert.ok(cam.position.y - (EYE_HEIGHT - 0.6) <= 0.3 + 1e-9)
  // The same step at different frame rates gives the same eye height at the same time (times that are
  // whole numbers of frames at every rate).
  const at = (hz: number, seconds: number) => {
    const r = new HeadRig(), c = new PerspectiveCamera()
    r.onFoot(c, 0, 0, 0, 0, 0, 1 / hz)
    for (let k = 0; k < Math.round(seconds * hz); k++) r.onFoot(c, 0, 0.25, 0, 0, 0, 1 / hz)
    return c.position.y
  }
  for (const s of [1 / 15, 0.1, 0.2]) {
    const ref = at(240, s)
    for (const hz of [30, 60, 120]) assert.ok(Math.abs(at(hz, s) - ref) < 1e-9, `${hz} Hz at ${s.toFixed(3)} s: ${at(hz, s).toFixed(6)} vs ${ref.toFixed(6)}`)
  }
  // No motion at all without time (a paused frame).
  const r = new HeadRig(), c = new PerspectiveCamera()
  r.onFoot(c, 0, 0, 0, 0, 0, H)
  r.onFoot(c, 0, 0.2, 0, 0, 0, 0)
  assert.equal(c.position.y, EYE_HEIGHT)
})

test('teleports and car exits snap the eye; bad numbers hold the last good pose; pitch is clamped', () => {
  const rig = new HeadRig(), cam = new PerspectiveCamera()
  rig.onFoot(cam, 0, 0, 0, 0, 0, H)
  rig.onFoot(cam, 0, 5, 0, 0, 0, H)
  assert.equal(cam.position.y, 5 + EYE_HEIGHT, 'a >1 m change is a teleport')
  rig.inVehicle(cam, { x: 0, y: 0.56, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, false, 0, 0)
  rig.onFoot(cam, 2, 0.1, 0, 0, 0, H)
  assert.equal(cam.position.y, 0.1 + EYE_HEIGHT, 'first frame out of the car stands up at once')
  rig.onFoot(cam, 2, Number.NaN, 0, Number.NaN, Number.POSITIVE_INFINITY, H)
  assert.ok(close(cam.position.y, 0.1 + EYE_HEIGHT) && cam.rotation.y === 0 && cam.rotation.x === 0, 'held')
  assert.ok([cam.position.x, cam.position.y, cam.position.z].every(Number.isFinite))
  rig.onFoot(cam, 2, 0.1, 0, 0, 3, H)
  assert.equal(cam.rotation.x, PITCH_LIMIT)
  assert.equal(rig.pose.pitch, PITCH_LIMIT)
  rig.onFoot(cam, 2, 0.1, 0, 0, -3, H)
  assert.equal(cam.rotation.x, -PITCH_LIMIT)
})

test('in a car: the eye is DRIVER_EYE carried by the chassis pose, on the left, level with the horizon', () => {
  const rig = new HeadRig(), cam = new PerspectiveCamera()
  for (let h = -3; h <= 3; h += 0.5) {
    const q = chassis(h)
    rig.inVehicle(cam, { x: 5, y: 0.56, z: 7 }, q, false, yawFacing(h), 0)
    const dx = cam.position.x - 5, dz = cam.position.z - 7
    const ahead = dx * Math.sin(h) + dz * Math.cos(h)
    const left = dx * Math.cos(h) - dz * Math.sin(h)
    assert.ok(close(ahead, DRIVER_EYE.x, 1e-6), `heading ${h}: ${ahead} ahead`)
    assert.ok(close(left, -DRIVER_EYE.z, 1e-6), `heading ${h}: ${left} to the left`)
    assert.ok(close(cam.position.y, 0.56 + DRIVER_EYE.y, 1e-6))
    const f = forwardOf(cam)
    assert.ok(close(f.x, Math.sin(h), 1e-6) && close(f.z, Math.cos(h), 1e-6), 'facing the windscreen')
  }
  // The rotation is exact for any chassis attitude (compared with three's quaternion maths).
  const q = new Quaternion(0.12, -0.4, 0.21, 0.88).normalize()
  rig.inVehicle(cam, { x: 1, y: 2, z: 3 }, q, false, 0.3, 0.1)
  const want = new Vector3(DRIVER_EYE.x, DRIVER_EYE.y, DRIVER_EYE.z).applyQuaternion(q).add(new Vector3(1, 2, 3))
  assert.ok(cam.position.distanceTo(want) < 1e-9)
  assert.equal(cam.rotation.z, 0, 'a rolled chassis never rolls the head')
  assert.ok(close(cam.rotation.x, 0.1) && close(cam.rotation.y, 0.3))
  // The SUV body is the sedan scaled (1, 1.16, 1.03): the seat, and so the eye, rises with it.
  rig.inVehicle(cam, { x: 0, y: 0.56, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, true, 0, 0)
  assert.ok(close(cam.position.y, 0.56 + DRIVER_EYE.y * 1.16, 1e-9))
  assert.ok(close(cam.position.z, DRIVER_EYE.z * 1.03, 1e-9) && close(cam.position.x, DRIVER_EYE.x, 1e-9))
})

test('carriedYaw: the head turns with the car, continuously across the heading seam', () => {
  const glance = yawFacing(0.2) + 0.3
  assert.ok(close(carriedYaw(glance, 0.2, 0.7), glance + 0.5), 'a 0.5 rad turn carries the head 0.5 rad')
  const seam = carriedYaw(yawFacing(3.1), 3.1, -3.1)
  assert.ok(close(seam, yawFacing(3.1) + (2 * Math.PI - 6.2), 1e-9), 'π → −π is a small left turn, not a 2π spin')
  const spun = glance + 20 * Math.PI
  assert.ok(close(carriedYaw(spun, 0.2, 0.4), spun + 0.2, 1e-9), 'an unwrapped yaw (ten turns on) stays unwrapped')
  assert.equal(carriedYaw(glance, Number.NaN, 0.2), glance, 'a NaN heading carries nothing')
  // Straight driving: the head stays exactly where it looks.
  let yaw = glance
  for (let i = 0; i < 1000; i++) yaw = carriedYaw(yaw, 0.2, 0.2)
  assert.equal(yaw, glance)
})

test('carriedYaw keeps the head within ±HEAD_TURN_LIMIT of the nose and only removes the excess', () => {
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
  for (let i = 0; i < 5000; i++) {
    const heading = (rnd() - 0.5) * 20
    const prev = heading - (rnd() - 0.5) * 0.3
    const yaw = (rnd() - 0.5) * 40
    const out = carriedYaw(yaw, prev, heading)
    const carried = yaw + wrap(heading - prev)
    const rel = wrap(carried - yawFacing(heading))
    const relOut = wrap(out - yawFacing(heading))
    assert.ok(Math.abs(relOut) <= HEAD_TURN_LIMIT + 1e-9, `within the limit (${relOut})`)
    if (Math.abs(rel) <= HEAD_TURN_LIMIT) assert.ok(close(out, carried, 1e-9), 'inside the limit: pure carry')
    else assert.ok(close(Math.abs(relOut), HEAD_TURN_LIMIT, 1e-9) && Math.sign(relOut) === Math.sign(rel), 'clamped to the near edge')
    assert.ok(Math.abs(out - carried) <= Math.PI, 'never a 2π jump')
  }
  // A custom (tighter) limit, and a head looking back over the right shoulder clamped to 110°.
  const nose = yawFacing(0)
  assert.ok(close(carriedYaw(nose - 2.5, 0, 0), nose - HEAD_TURN_LIMIT))
  assert.ok(close(carriedYaw(nose + 1, 0, 0, 0.5), nose + 0.5))
  assert.ok(close(carriedYaw(nose + 1, 0, 0, -1), nose), 'a negative limit locks the head to the nose')
})

test('real Rapier: standing eye height, and a kerb-high step eased rather than jumped', async () => {
  // A 0.15 m platform from x = 1 onward; the avatar walks onto it along +x.
  const physics = await Physics.create([[1, 0, -5, 20, 0.15, 5]], { lamps: [], trees: [], signals: [] })
  const avatar = new Avatar(physics, -1, 0)
  const rig = new HeadRig(), cam = new PerspectiveCamera()
  const feet = () => avatar.body.translation().y - avatar.person.halfHeight - avatar.person.radius
  const frame = (vx: number) => {
    physics.step(H, (h) => avatar.move(vx, 0, h))
    rig.onFoot(cam, avatar.x, feet(), avatar.z, yawFacing(Math.PI / 2), 0, H)
  }
  for (let i = 0; i < 60; i++) frame(0)
  assert.ok(Math.abs(cam.position.y - EYE_HEIGHT) < 0.05, `standing eye ${cam.position.y.toFixed(3)} m`)
  let worstEyeStep = 0, worstFeetStep = 0, prevEye = cam.position.y, prevFeet = feet()
  for (let i = 0; i < 150; i++) {
    frame(2)
    assert.ok(close(cam.position.x, avatar.x) && close(cam.position.z, avatar.z), 'horizontal exact')
    worstEyeStep = Math.max(worstEyeStep, Math.abs(cam.position.y - prevEye))
    worstFeetStep = Math.max(worstFeetStep, Math.abs(feet() - prevFeet))
    prevEye = cam.position.y
    prevFeet = feet()
  }
  assert.ok(avatar.x > 2, `walked onto the platform (x = ${avatar.x.toFixed(2)})`)
  assert.ok(Math.abs(cam.position.y - (0.15 + EYE_HEIGHT)) < 0.05, `eye on the platform ${cam.position.y.toFixed(3)} m`)
  assert.ok(worstEyeStep < worstFeetStep || worstFeetStep < 0.03, `eye moved at most ${worstEyeStep.toFixed(3)} m/frame, feet ${worstFeetStep.toFixed(3)}`)
  assert.ok(worstEyeStep < 0.06, `no visible jump: ${worstEyeStep.toFixed(3)} m in one frame`)
})

test('real Fleet car: the driver\'s eye sits inside the cabin, over the left seat, looking out of the windscreen', async () => {
  const { Fleet } = await import('./vehicles.ts')
  const physics = await Physics.create([], { lamps: [], trees: [], signals: [] })
  const fleet = new Fleet(physics, 1, 3)
  const car = fleet.vehicles[0]
  const heading = 0.6
  fleet.recover(car, 0, 0, heading)
  for (let i = 0; i < 90; i++) physics.step(H, (h) => fleet.updateControllers(h))
  const rig = new HeadRig(), cam = new PerspectiveCamera()
  const h = fleet.heading(car)
  rig.inVehicle(cam, fleet.position(car), fleet.rotation(car), car.suv, yawFacing(h), 0)
  const t = fleet.position(car)
  const dx = cam.position.x - t.x, dz = cam.position.z - t.z
  const ahead = dx * Math.sin(h) + dz * Math.cos(h), left = dx * Math.cos(h) - dz * Math.sin(h)
  // vehicles.ts sedan profile: beltline 0.96 m, roof 1.38–1.42 m, windscreen foot at +1.12 m (heights above the road).
  const scale = car.suv ? 1.16 : 1
  assert.ok(cam.position.y > 0.96 && cam.position.y < 0.56 + (1.38 - 0.56) * scale - 0.12, `eye ${cam.position.y.toFixed(2)} m above the road`)
  assert.ok(ahead > -0.82 && ahead < 0.42, `under the roof: ${ahead.toFixed(2)} m ahead of the centre`)
  assert.ok(left > 0.25 && left < 0.5, `driver's seat: ${left.toFixed(2)} m left of the centre`)
  const f = forwardOf(cam)
  assert.ok(close(f.x, Math.sin(h), 1e-6) && close(f.z, Math.cos(h), 1e-6))
  assert.ok(close(h, heading, 0.02), 'the settled car still faces the recovered heading')
})

test('real Rapier: the avatar stands, lands and walks on its skin above the road, never sunk into it (steady eye)', async () => {
  // Places where Rapier's snap-to-ground used to sink the capsule 0.1–0.3 m into physics.ts's large ground box.
  const physics = await Physics.create([[300, 0, 300, 310, 0.3, 310]], { lamps: [], trees: [], signals: [] })
  const spots = [[240, 240], [100, 100], [400, 400], [245.8, 252], [0.5, 0.5], [37.3, 411.9], [-100, 700]]
  const feetOf = (a: Avatar) => a.body.translation().y - a.person.halfHeight - a.person.radius
  const avatars = spots.map(([x, z]) => new Avatar(physics, x, z))
  const run = (frames: number, vx: number, list: Avatar[]) => {
    const track = list.map(() => [] as number[])
    for (let i = 0; i < frames; i++) {
      physics.step(H, (h) => { for (const a of list) a.move(vx, 0, h) })
      list.forEach((a, k) => track[k].push(feetOf(a)))
    }
    return track
  }
  const settled = (ys: number[]) => ys.slice(20)
  const within = (ys: number[], lo: number, hi: number) => ys.every((y) => y >= lo && y <= hi)
  const jitter = (ys: number[]) => ys.slice(1).reduce((m, y, i) => Math.max(m, Math.abs(y - ys[i])), 0)
  for (const [k, ys] of run(60, 0, avatars).entries()) {
    assert.ok(within(settled(ys), 0.015, 0.03), `standing at ${spots[k]}: feet ${Math.min(...ys).toFixed(3)}..${Math.max(...ys).toFixed(3)}`)
    assert.ok(jitter(settled(ys)) < 0.002, `standing still at ${spots[k]} does not bob (${jitter(settled(ys)).toFixed(4)} m/frame)`)
  }
  avatars.forEach((a, k) => a.teleport(spots[k][0] + 3, spots[k][1] - 2))
  for (const [k, ys] of run(40, 0, avatars).entries()) assert.ok(within(settled(ys), 0.015, 0.06), `after a teleport at ${spots[k]}: ${Math.min(...ys).toFixed(3)}`)
  for (const [k, ys] of run(120, 2, avatars).entries()) {
    assert.ok(within(ys, 0.015, 0.06), `walking from ${spots[k]}: feet ${Math.min(...ys).toFixed(3)}..${Math.max(...ys).toFixed(3)}`)
    assert.ok(jitter(ys) < 0.02, `walking from ${spots[k]}: at most ${jitter(ys).toFixed(3)} m per frame`)
  }
  // Up onto a 0.3 m platform and off its far edge: on it, then back down on the road.
  const climber = new Avatar(physics, 298.5, 305)
  const path = run(420, 2, [climber])[0]
  assert.ok(Math.max(...path) > 0.3, 'climbed the platform')
  assert.ok(climber.x > 311 && feetOf(climber) > 0.015 && feetOf(climber) < 0.04, `stepped down to the road: x ${climber.x.toFixed(1)}, feet ${feetOf(climber).toFixed(3)}`)
})
