// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves a robot's body in the realm (articulated.ts) against the real Rapier: the
 * bodies, shapes and joints a manifest becomes and that removing them leaves the world as it was; the ragdoll's
 * contact groups on every link; limits that read back (Rapier 0.21 drops the joint data's revolute limits, so they
 * are set on the joint); the measured angle and slide against poses set by hand, with a turned joint frame and an
 * unwrapped wheel; the velocity motor as a first-order lag of the asked time constant, its speed cap and its effort
 * cap; the τ estimate against the torque that holds a link against gravity; the finiteness check; and what the
 * realm refuses to build.
 * What breaks if it is removed? A frame convention or a Rapier gotcha could put a twin's elbow about the wrong axis,
 * or at the wrong zero, and nothing would say so until a real robot moved the other way.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import RAPIER from '@dimforge/rapier3d-simd-compat'
import { RAGDOLL_GROUPS, ROBOT_GROUPS } from '../02_Define_The_Rules/collision.ts'
import { buildManifest, type Manifest } from '../04_Connect_Hardware/jointState.ts'
import { arcToX, axisQuat, buildArticulated, drive, hold, linkPose, measure, qmul, removeArticulated, ROBOT, rotate, rpyQuat, sane, ZUP_TO_YUP, type Articulated } from './articulated.ts'

await RAPIER.init()
const H = 1 / 60

function world(): RAPIER.World {
  const w = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  w.timestep = H
  const fixed = w.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  w.createCollider(RAPIER.ColliderDesc.cuboid(60, 0.5, 60).setTranslation(0, -0.5, 0).setFriction(1), fixed)
  return w
}
const counts = (w: RAPIER.World) => [w.bodies.len(), w.colliders.len(), w.impulseJoints.len()]
const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps

/** A small arm on a base with a wheel and a fixed sensor mount: every joint kind the realm builds. */
function arm(): Manifest {
  const m = buildManifest('arm', [
    { name: 'base', mass: 5, shape: { kind: 'box', size: [0.2, 0.2, 0.1] }, shapeOrigin: { xyz: [0, 0, 0.05], rpy: [0, 0, 0] } },
    { name: 'upper', mass: 1, shape: { kind: 'cylinder', radius: 0.03, length: 0.4 }, shapeOrigin: { xyz: [0, 0, 0.2], rpy: [0, 0, 0] } },
    { name: 'fore', mass: 0.5, shape: { kind: 'cylinder', radius: 0.025, length: 0.3 }, shapeOrigin: { xyz: [0, 0, 0.15], rpy: [0, 0, 0] } },
    { name: 'tip', mass: 0.1, shape: { kind: 'sphere', radius: 0.02 } },
    { name: 'wheel', mass: 0.3, shape: { kind: 'cylinder', radius: 0.05, length: 0.02 } },
    { name: 'sensor', mass: 0.05, shape: { kind: 'none' } },
  ], [
    { name: 'shoulder', kind: 'revolute', parent: 'base', child: 'upper', origin: { xyz: [0, 0, 0.1], rpy: [0, 0, 0] }, axis: [0, 0, 1], lower: -2, upper: 2, effort: 50, velocity: 2 },
    { name: 'elbow', kind: 'revolute', parent: 'upper', child: 'fore', origin: { xyz: [0, 0, 0.4], rpy: [0, 0, 0] }, axis: [0, 1, 0], lower: -1.5, upper: 1.5, effort: 20, velocity: 3 },
    { name: 'slide', kind: 'prismatic', parent: 'fore', child: 'tip', origin: { xyz: [0, 0, 0.3], rpy: [0, 0, 0] }, axis: [0, 0, 1], lower: 0, upper: 0.1, effort: 100, velocity: 0.5 },
    { name: 'axle', kind: 'continuous', parent: 'base', child: 'wheel', origin: { xyz: [0.2, 0, 0.05], rpy: [-Math.PI / 2, 0, 0] }, axis: [0, 0, 1] },
    { name: 'mount', kind: 'fixed', parent: 'base', child: 'sensor', origin: { xyz: [0, 0.1, 0.1], rpy: [0, 0, 0] } },
  ])
  assert.ok(m.ok, (m as { reason?: string }).reason)
  return (m as { value: Manifest }).value
}

const AT = { x: 2, y: 0, z: -1, heading: 0.3 }
const step = (w: RAPIER.World, a: Articulated, seconds: number, each: () => void = () => {}) => {
  for (let i = 0, n = Math.round(seconds / H); i < n; i++) { measure(a, H); each(); w.step() }
  measure(a, H)
}

test('a manifest becomes one body and shape per link and one joint per joint; removal restores the world, twice', () => {
  const w = world()
  const base = counts(w)
  const a = buildArticulated(w, arm(), AT)
  assert.deepEqual(counts(w), [base[0] + 6, base[1] + 6, base[2] + 5])
  assert.deepEqual(a.movable.map((m) => m.spec.name), ['shoulder', 'elbow', 'slide', 'axle'])
  assert.deepEqual(a.movable.map((m) => m.kind), ['revolute', 'revolute', 'prismatic', 'revolute'])
  assert.equal(a.rootIndex, 0)
  assert.equal(a.bodies[0].bodyType(), RAPIER.RigidBodyType.Fixed)
  for (let i = 1; i < a.bodies.length; i++) {
    assert.equal(a.bodies[i].bodyType(), RAPIER.RigidBodyType.Dynamic)
    assert.equal(a.bodies[i].isCcdEnabled(), true)
  }
  assert.ok(near(a.mass, 1 + 0.5 + 0.1 + 0.3 + 0.05, 1e-6), `${a.mass} kg of moving links`)
  assert.equal(ROBOT_GROUPS, RAGDOLL_GROUPS, 'a robot link is grouped as a rig segment: the avatar through it, no car and no wheel ray on it')
  for (const b of a.bodies) assert.equal(b.collider(0).collisionGroups(), ROBOT_GROUPS, 'every link carries the robot contact groups')
  const t = a.bodies[0].translation()
  assert.ok(near(t.x, AT.x, 1e-9) && near(t.y, AT.y, 1e-9) && near(t.z, AT.z, 1e-9))
  const out = new Float32Array(7)
  linkPose(a, 0, out, 0)
  assert.ok(near(out[0], AT.x, 1e-6) && near(out[6], a.bodies[0].rotation().w, 1e-6))
  removeArticulated(w, a)
  assert.deepEqual(counts(w), base)
  removeArticulated(w, a)
  assert.deepEqual(counts(w), base)
})

test('limits are set on the created joint and read back; a continuous joint has none; the effort cap is the motor force', () => {
  const w = world()
  const a = buildArticulated(w, arm(), AT)
  const [shoulder, elbow, slide, axle] = a.movable
  assert.equal(shoulder.joint.limitsEnabled(), true)
  assert.ok(near(shoulder.joint.limitsMin(), -2, 1e-6) && near(shoulder.joint.limitsMax(), 2, 1e-6))
  assert.ok(near(elbow.joint.limitsMin(), -1.5, 1e-6) && near(elbow.joint.limitsMax(), 1.5, 1e-6))
  assert.equal(slide.joint.limitsEnabled(), true)
  assert.ok(near(slide.joint.limitsMin(), 0, 1e-6) && near(slide.joint.limitsMax(), 0.1, 1e-6))
  assert.equal(axle.joint.limitsEnabled(), false)
  assert.deepEqual(a.movable.map((m) => [m.effort, m.velocity]), [[50, 2], [20, 3], [100, 0.5], [ROBOT.defaultEffort, ROBOT.defaultVelocity]])
  assert.ok(near(slide.inertia, 0.1 * 0.5 / 0.6, 1e-6), 'a prismatic joint between two moving links: the reduced mass')
  assert.deepEqual(a.movable.map((m) => m.below.map((i) => a.manifest.links[i].name)), [['upper', 'fore', 'tip'], ['fore', 'tip'], ['tip'], ['wheel']])
  // Below the elbow, as built (straight up): the fore link, a 0.5 kg rod 0.3 m long hinged at one end (m L²/3), and the
  // 0.1 kg tip 0.3 m out (m r²); reduced with the upper arm, a 1 kg rod 0.4 m long, about the same axis.
  const belowElbow = 0.5 * 0.3 * 0.3 / 3 + 0.1 * 0.3 * 0.3, upperI = 1 * 0.4 * 0.4 / 3
  assert.ok(near(elbow.inertia, (belowElbow * upperI) / (belowElbow + upperI), 0.002), `${elbow.inertia} kg·m²`)
  // Straight up, everything below the shoulder lies along its axis: only the cylinders' own ½ m r² (the parent is fixed).
  assert.ok(shoulder.parent.isFixed() && near(shoulder.inertia, 0.5 * 1 * 0.03 ** 2 + 0.5 * 0.5 * 0.025 ** 2 + 0.4 * 0.1 * 0.02 ** 2, 1e-4), `${shoulder.inertia} kg·m²`)
  assert.ok(near(shoulder.load, 0, 1e-9) && elbow.load < 0 === (0.5 * 0.15 + 0.1 * 0.3) * -9.81 * Math.sin(0) < 0, 'loads read at the build pose')
  // The estimate follows the pose: the fore arm turned a right angle about its own y (the elbow's axis) is a
  // horizontal rod hinged on the shoulder's axis (m L²/3; the tip, left where it was, still stands on the axis).
  const bent = buildArticulated(w, arm(), { ...AT, x: 5 })
  bent.bodies[2].setRotation(qmul(bent.bodies[2].rotation(), axisQuat([0, 1, 0], Math.PI / 2)), true)
  measure(bent, 1 / 60)
  assert.ok(near(bent.movable[0].inertia, 0.5 * 0.3 * 0.3 / 3, 0.002), `bent: ${bent.movable[0].inertia} kg·m²`)
})

test('q is zero as built and reads the hand-set pose: an angle about the axis, a turned frame, a slide, an unwrapped wheel', () => {
  const w = world()
  const a = buildArticulated(w, arm(), AT)
  measure(a, H)
  for (const m of a.movable) assert.ok(near(m.q, 0, 1e-6) && m.qd === 0, `${m.spec.name} at ${m.q}`)
  const [shoulder, elbow, slide, axle] = a.movable
  // Turn the upper arm 0.4 rad about the shoulder's axis, the right-hand way, in the base's frame.
  const baseQ = a.bodies[0].rotation()
  shoulder.child.setRotation(qmul(baseQ, axisQuat([0, 0, 1], 0.4)), true)
  measure(a, H)
  assert.ok(near(shoulder.q, 0.4, 1e-6), `shoulder ${shoulder.q}`)
  // The wheel's joint frame is rolled a quarter turn: its axis is the base's −y. Turn it −0.7 about its own axis.
  axle.child.setRotation(qmul(qmul(baseQ, rpyQuat([-Math.PI / 2, 0, 0])), axisQuat([0, 0, 1], -0.7)), true)
  measure(a, H)
  assert.ok(near(axle.q, -0.7, 1e-6), `axle ${axle.q}`)
  // Past a half turn it keeps counting instead of flipping sign.
  for (const ang of [-1.5, -2.5, -3.3, -4.2]) {
    axle.child.setRotation(qmul(qmul(baseQ, rpyQuat([-Math.PI / 2, 0, 0])), axisQuat([0, 0, 1], ang)), true)
    measure(a, H)
    assert.ok(near(axle.q, ang, 1e-6), `axle ${axle.q} vs ${ang}`)
  }
  // Slide the tip 0.07 m out along the fore link's z.
  const foreQ = slide.parent.rotation(), foreT = slide.parent.translation()
  const along = rotate(foreQ, [0, 0, 0.37])
  slide.child.setTranslation({ x: foreT.x + along[0], y: foreT.y + along[1], z: foreT.z + along[2] }, true)
  measure(a, H)
  assert.ok(near(slide.q, 0.07, 1e-6), `slide ${slide.q}`)
  assert.ok(near(elbow.q, 0, 1e-6), 'the elbow did not move')
  // The frame conventions: z up becomes y up, and the axis of x stays x.
  assert.deepEqual(rotate(ZUP_TO_YUP, [0, 0, 1]).map((v) => Math.round(v * 1e9) / 1e9), [0, 1, 0])
  assert.deepEqual(rotate(arcToX([0, 0, 1]), [1, 0, 0]).map((v) => Math.round(v * 1e9) / 1e9), [0, 0, 1])
  assert.deepEqual(rotate(arcToX([-1, 0, 0]), [1, 0, 0]).map((v) => Math.round(v * 1e9) / 1e9), [-1, 0, 0])
})

test('the servo reaches a setpoint and holds it, clamped to the speed cap; hold stands still; a NaN setpoint holds', () => {
  const w = world()
  const a = buildArticulated(w, arm(), AT)
  const q = [0, 0.5, 0, 0], qd = [0, 0, 0, 0], tau = [0, 0, 0, 0]
  step(w, a, 0.3, () => drive(a, { q, qd, tau }, H))
  const elbow = a.movable[1]
  assert.ok(near(elbow.q, 0.5, 0.01), `at the setpoint within 300 ms: ${elbow.q}`)
  step(w, a, 1, () => drive(a, { q, qd, tau }, H))
  assert.ok(near(elbow.q, 0.5, 0.003), `held: ${elbow.q}`)
  assert.ok(Math.abs(a.movable[0].q) < 0.01 && Math.abs(a.movable[2].q) < 0.002, 'the others stayed')
  // The shoulder's cap is 2 rad/s: a far setpoint moves at the cap.
  q[0] = 1.5
  step(w, a, 0.5, () => drive(a, { q, qd, tau }, H))
  assert.ok(near(a.movable[0].q, 1.0, 0.08), `capped: ${a.movable[0].q}`)
  // Held: the shoulder, still moving at its cap, stops within a few ticks; then nothing drifts in a second.
  step(w, a, 0.1, () => hold(a, H))
  const before = a.movable.map((m) => m.q)
  step(w, a, 1, () => hold(a, H))
  a.movable.forEach((m, i) => assert.ok(near(m.q, before[i], 0.01), `${m.spec.name} drifted ${m.q - before[i]}`))
  // A NaN setpoint holds instead of moving.
  q[1] = NaN
  step(w, a, 0.5, () => drive(a, { q, qd, tau }, H))
  assert.ok(near(elbow.q, 0.5, 0.02), `NaN held: ${elbow.q}`)
  // The slide: out to 0.08 m and back, within its 0..0.1 m limits.
  q[1] = 0.5; q[2] = 0.08
  step(w, a, 0.5, () => drive(a, { q, qd, tau }, H))
  assert.ok(near(a.movable[2].q, 0.08, 0.003), `slide ${a.movable[2].q}`)
  q[2] = -0.5
  step(w, a, 0.5, () => drive(a, { q, qd, tau }, H))
  assert.ok(near(a.movable[2].q, 0, 0.005), `slide at its limit ${a.movable[2].q}`)
  // The wheel: a continuous joint driven past a half turn keeps counting.
  q[3] = 4
  step(w, a, 1.5, () => drive(a, { q, qd, tau }, H))
  assert.ok(near(a.movable[3].q, 4, 0.02), `wheel ${a.movable[3].q}`)
  assert.equal(sane(a), true)
})

test('τ is the torque applied: at rest, what holds everything below against gravity; a smaller cap lets the link sag', () => {
  const w = world()
  const a = buildArticulated(w, arm(), AT)
  const elbow = a.movable[1]
  const q = [0, 1.2, 0, 0], qd = [0, 0, 0, 0], tau = [0, 0, 0, 0]
  step(w, a, 2, () => drive(a, { q, qd, tau }, H))
  assert.ok(near(elbow.q, 1.2, 0.005), `at the setpoint: ${elbow.q}`)
  // The fore link's 0.5 kg at 0.15 m and the tip's 0.1 kg at 0.3 m, both swung 1.2 rad off the vertical.
  const holding = (0.5 * 0.15 + 0.1 * 0.3) * 9.81 * Math.sin(1.2)
  assert.ok(near(Math.abs(elbow.tau), holding, 0.05), `|τ| ${elbow.tau} vs ${holding}`)
  assert.ok(near(Math.abs(elbow.load), holding, 0.05))
  const sign = Math.sign(elbow.tau)
  q[1] = -1.2
  step(w, a, 2, () => drive(a, { q, qd, tau }, H))
  assert.ok(near(elbow.q, -1.2, 0.005))
  assert.equal(Math.sign(elbow.tau), -sign, 'the other way, the other sign')
  // The shoulder turns about the vertical: no weight to hold, so its τ is near zero at rest.
  assert.ok(Math.abs(a.movable[0].tau) < 0.05, `shoulder τ ${a.movable[0].tau}`)
  // Capped below the holding torque, the link drops away from the setpoint and the cap is what was applied.
  q[1] = 1.2
  step(w, a, 2, () => drive(a, { q, qd, tau }, H))
  tau[1] = 0.2
  step(w, a, 1, () => drive(a, { q, qd, tau }, H))
  assert.ok(Math.abs(elbow.q - 1.2) > 0.2, `sagged to ${elbow.q}`)
  assert.ok(near(Math.abs(elbow.tau), 0.2, 1e-9), `applied at the cap: ${elbow.tau}`)
})

test('what the realm refuses: a floating joint, a heavy link, a placement that is not finite; nothing is left behind', () => {
  const w = world()
  const base = counts(w)
  const floating = buildManifest('f', [{ name: 'a' }, { name: 'b' }], [{ name: 'j', kind: 'floating', parent: 'a', child: 'b' }])
  assert.ok(floating.ok)
  assert.throws(() => buildArticulated(w, (floating as { value: Manifest }).value, AT), /floating/)
  const heavy = buildManifest('h', [{ name: 'a' }, { name: 'b', mass: 600 }], [{ name: 'j', kind: 'revolute', parent: 'a', child: 'b', effort: 1, velocity: 1, lower: 0, upper: 1 }])
  assert.ok(heavy.ok)
  assert.throws(() => buildArticulated(w, (heavy as { value: Manifest }).value, AT), /600 kg/)
  assert.throws(() => buildArticulated(w, arm(), { ...AT, y: NaN }), /not finite/)
  assert.deepEqual(counts(w), base)
  const a = buildArticulated(w, arm(), AT)
  a.bodies[2].setTranslation({ x: NaN, y: 0, z: 0 }, true)
  assert.equal(sane(a), false)
  removeArticulated(w, a)
  assert.deepEqual(counts(w), base)
})
