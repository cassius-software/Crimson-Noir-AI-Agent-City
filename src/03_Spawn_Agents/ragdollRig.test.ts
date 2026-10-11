// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the active ragdoll's body in real Rapier (the realm's own build): the rig is the
 * eleven segments, thirteen shapes and ten joints it claims, starts where and as the crowd had the person, and leaves
 * nothing behind when removed, however often; its powered joints and assist hold a person up where a limp rig of the
 * same build sinks to the ground (the positive control); and the pool, the balance machine and the rig together take a
 * light shove back to the crowd and a hard one through catch steps, sitting down and rising.
 * What breaks if it is removed? A rig that leaks bodies into the realm's world, stands no better than a limp one, or
 * never hands a person back could land unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import RAPIER from '@dimforge/rapier3d-simd-compat'
import { RagdollPool, type BalanceState, type Reading } from './ragdoll.ts'
import { applyGains, applyPush, buildRig, drive, JOINTS, measure, RAGDOLL_GROUP, removeRig, SEGMENTS, type Rig } from './ragdollRig.ts'

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
const AT = { x: 3, y: 0, z: -2, vx: 0, vy: 0, vz: 0, heading: 0.7 }

test('a rig is 11 bodies, 13 shapes and 10 joints; removing it leaves the world as it was, over many cycles', () => {
  const w = world()
  const base = counts(w)
  const rig = buildRig(w, AT)
  assert.deepEqual(counts(w), [base[0] + 11, base[1] + 13, base[2] + 10])
  assert.equal(Object.keys(rig.bodies).length, Object.keys(SEGMENTS).length)
  assert.equal(rig.joints.length, JOINTS.length)
  assert.ok(Math.abs(rig.mass - 76) < 1e-9, `${rig.mass} kg`)
  for (let i = 0; i < 30; i++) w.step()
  removeRig(w, rig)
  assert.deepEqual(counts(w), base)
  for (let cycle = 0; cycle < 25; cycle++) {
    const r = buildRig(w, { ...AT, x: cycle })
    for (let i = 0; i < 5; i++) {
      drive(r, H)
      w.step()
    }
    removeRig(w, r)
  }
  assert.deepEqual(counts(w), base, 'no orphaned body, shape or joint')
  removeRig(w, rig)
  assert.deepEqual(counts(w), base, 'removing twice is harmless')
})

test('a rig starts where and as the crowd had the person: position, heading, velocity; its segments meet the world only', () => {
  const w = world()
  const rig = buildRig(w, { x: 10, y: 0.15, z: 20, vx: 1.3, vy: 0, vz: -0.4, heading: Math.PI / 2 })
  const pelvis = rig.bodies.pelvis.translation()
  assert.ok(Math.abs(pelvis.x - 10) < 1e-6 && Math.abs(pelvis.z - 20) < 1e-6 && Math.abs(pelvis.y - (0.15 + SEGMENTS.pelvis.at[1])) < 1e-6)
  // Heading π/2: the person's +x (their left) is world −z.
  const hip = rig.bodies.upperLegL.translation()
  assert.ok(Math.abs(hip.x - 10) < 1e-6 && Math.abs(hip.z - (20 - SEGMENTS.upperLegL.at[0])) < 1e-6, JSON.stringify(hip))
  for (const b of Object.values(rig.bodies)) {
    const v = b.linvel()
    assert.deepEqual([v.x, v.y, v.z].map((n) => Math.round(n * 1e6) / 1e6), [1.3, 0, -0.4])
  }
  // Out of the vehicle layer (collision.ts RAGDOLL_GROUPS): membership the ragdoll bit, filtering out itself, the chassis bit and the wheel-ray bit.
  assert.equal(rig.bodies.torso.collider(0).collisionGroups(), (RAGDOLL_GROUP << 16) | (0xffff & ~(RAGDOLL_GROUP | 0x0002 | 0x0001)))
  assert.equal(rig.bodies.lowerLegL.collider(1).collisionGroups(), rig.bodies.torso.collider(0).collisionGroups(), 'the foot too')
  assert.equal(rig.groundY, 0.15)
})

function hold(rig: Rig, w: RAPIER.World, seconds: number): { minPelvis: number; maxTilt: number; end: ReturnType<typeof measure> } {
  let minPelvis = Infinity, maxTilt = 0
  for (let i = 0; i < seconds / H; i++) {
    drive(rig, H)
    w.step()
    const m = measure(rig)
    minPelvis = Math.min(minPelvis, m.pelvisHeight)
    maxTilt = Math.max(maxTilt, m.tilt)
  }
  return { minPelvis, maxTilt, end: measure(rig) }
}

test('positive control: the powered rig stands for 4 s, a limp rig of the same build sinks to the ground', () => {
  const w = world()
  const powered = buildRig(w, AT)
  applyGains(powered, 'perturbed')
  const up = hold(powered, w, 4)
  assert.ok(up.minPelvis > 0.85, `powered pelvis fell to ${up.minPelvis}`)
  assert.ok(up.maxTilt < 0.15, `powered torso leaned ${up.maxTilt}`)
  removeRig(w, powered)

  const w2 = world()
  const limp = buildRig(w2, AT)
  applyGains(limp, 'kinematic') // all gains zero
  const down = hold(limp, w2, 4)
  assert.ok(down.end.pelvisHeight < 0.4, `limp pelvis still at ${down.end.pelvisHeight}`)
  assert.ok(down.maxTilt > 1, 'and it went over')
})

test('sitting down is a lowering, not a drop: less support brings the pelvis down while the trunk stays up', () => {
  const w = world()
  const rig = buildRig(w, AT)
  applyGains(rig, 'sittingDown')
  const r = hold(rig, w, 4)
  assert.ok(r.end.pelvisHeight < 0.6, `pelvis still at ${r.end.pelvisHeight}`)
  assert.ok(r.maxTilt < 0.6, `torso leaned ${r.maxTilt} while lowering`)
})

/** The whole loop the realm will run: pool → rig → drive → step → measure → machine, until the person is released. */
function scene(impulse: number): { visited: BalanceState[]; released: boolean; base: number[]; after: number[]; seconds: number } {
  const w = world()
  const base = counts(w)
  const pool = new RagdollPool()
  const decision = pool.offer({ id: 7, distance: 4, perturbation: { cause: 'shove', impulse }, ...AT })
  assert.equal(decision.kind, 'promoted')
  let rig: Rig | null = null
  const visited: BalanceState[] = []
  let released = false
  let t = 0
  for (; t < 15 && !released; t += H) {
    const readings = new Map<number, Reading>()
    if (rig) readings.set(7, { ...measure(rig), distance: 4 })
    const ev = pool.step(H, readings)
    if (ev.build.includes(7)) rig = buildRig(w, pool.get(7)!.spawn)
    for (const p of ev.pushes) if (rig) applyPush(rig, p.push, 1, 0.3)
    if (ev.remove.includes(7) && rig) {
      removeRig(w, rig)
      rig = null
    }
    if (ev.released.includes(7)) released = true
    const state = pool.get(7)?.machine.state ?? 'kinematic'
    if (visited.at(-1) !== state) visited.push(state)
    if (rig) {
      applyGains(rig, state)
      drive(rig, H)
    }
    w.step()
  }
  return { visited, released, base, after: counts(w), seconds: t }
}

test('a light shove: balanced in place, handed back to the crowd, the rig gone', () => {
  const s = scene(40)
  assert.deepEqual(s.visited, ['perturbed', 'recovering', 'kinematic'])
  assert.ok(s.released && s.seconds < 5, `released after ${s.seconds} s`)
  assert.deepEqual(s.after, s.base)
})

test('a hard shove: catch steps, then a controlled sit, rest, rise, and back to the crowd; the rig gone', () => {
  const s = scene(160)
  assert.ok(s.visited.includes('catchStep'), s.visited.join(' → '))
  const tail = s.visited.slice(s.visited.indexOf('sittingDown'))
  assert.deepEqual(tail, ['sittingDown', 'seated', 'recovering', 'kinematic'], s.visited.join(' → '))
  assert.ok(s.released, `still a member after ${s.seconds} s`)
  assert.deepEqual(s.after, s.base)
})
