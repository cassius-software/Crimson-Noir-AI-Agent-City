// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves, in real Rapier run in Node, what the one contact rule of
 * 02_Define_The_Rules/collision.ts (canCollide) means in the realm: a vehicle meets the solid world and nothing else,
 * and that meeting harms nothing. A sedan and an SUV driven into a wall at the speed cap stop dead at it (no bounce:
 * WALL_CONTACT.restitution is zero), stay on their wheels and drive away again; nothing is added to or removed from the
 * world by the impact, no event is raised, and there is no number anywhere that could call either the car or the
 * wall damaged. A player walks through another player's capsule as through anyone else (the second kinematic body
 * the realm holds), the one pair the words alone did not settle. Cars through cars, the avatar through a car and a
 * fallen person out of the vehicle layer are proved in vehiclePassThrough.test.ts and collision.test.ts.
 * What breaks if it is removed? A chassis could be built with a bounce that flips it or that the room's replay
 * cannot follow, or two players could block each other, and only a browser session would show it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Box, Furniture } from '../01_Initialize_World/city.ts'
import { WALL_CONTACT } from '../02_Define_The_Rules/collision.ts'
import { RING0 } from '../02_Define_The_Rules/ring0.ts'
import { Physics } from './physics.ts'
import { Avatar } from './player.ts'
import { Fleet, type Vehicle } from './vehicles.ts'

const H = 1 / 60
const NONE: Furniture = { lamps: [], trees: [], signals: [] }
/** Open ground away from the street grid. */
const X = -600
const EAST = Math.PI / 2
/** Seed whose fleet of 8 has both sedans and SUVs. */
const SEED = 11

async function wallWorld(): Promise<{ physics: Physics; fleet: Fleet; wallX: number; step: (n?: number) => void }> {
  const wallX = X + 60
  const wall: Box = [wallX, 0, -20, wallX + 2, 6, 20]
  const physics = await Physics.create([wall], NONE)
  const fleet = new Fleet(physics, 8, SEED, { exposeRig: true })
  const step = (n = 1) => { for (let k = 0; k < n; k++) physics.step(H, (h) => fleet.updateControllers(h)) }
  return { physics, fleet, wallX, step }
}

/** Drives `v` at `speed` into the wall with the throttle closed for `frames`, watching the worst of everything. */
function impact(fleet: Fleet, physics: Physics, wallX: number, v: Vehicle, speed: number, frames: number) {
  fleet.recover(v, X, 0, EAST)
  for (let k = 0; k < 60; k++) physics.step(H, (h) => fleet.updateControllers(h))
  fleet.rig(v).body.setLinvel({ x: speed, y: 0, z: 0 }, true)
  const bodies = physics.world.bodies.len(), colliders = physics.world.colliders.len()
  let minGap = Infinity, maxTilt = 0, rebound = 0, touched = false, maxY = 0
  for (let i = 0; i < frames; i++) {
    fleet.drive(v, { throttle: 0, brake: 0, steer: 0 }, false)
    physics.step(H, (h) => fleet.updateControllers(h))
    const p = fleet.position(v)
    const gap = wallX - (p.x + 2.3)
    minGap = Math.min(minGap, gap)
    maxY = Math.max(maxY, p.y)
    if (gap < 0.05) touched = true
    rebound = Math.min(rebound, fleet.speed(v))
    const r = fleet.rotation(v)
    maxTilt = Math.max(maxTilt, 2 * Math.asin(Math.min(1, Math.hypot(r.x, r.z))))
    assert.equal(fleet.flipped(v), false, `flipped at frame ${i}`)
  }
  assert.equal(physics.world.bodies.len(), bodies, 'nothing added to or removed from the world')
  assert.equal(physics.world.colliders.len(), colliders)
  return { minGap, maxTilt, rebound, touched, maxY, end: fleet.position(v), speed: fleet.speed(v) }
}

test('a sedan and an SUV into a wall at the speed cap: a dead stop at the wall, upright, intact, and away again', async () => {
  const { physics, fleet, wallX, step } = await wallWorld()
  for (const suv of [false, true]) {
    const v = fleet.vehicles.find((c) => c.suv === suv)!
    v.mode = 'player'
    const r = impact(fleet, physics, wallX, v, RING0.maxVelocity, 300)
    assert.ok(r.touched, `${suv ? 'SUV' : 'sedan'} never reached the wall (${r.minGap.toFixed(2)} m)`)
    assert.ok(r.minGap > -0.15, `${suv ? 'SUV' : 'sedan'} went ${(-r.minGap).toFixed(3)} m into the wall`)
    assert.ok(r.maxTilt < 0.1, `${suv ? 'SUV' : 'sedan'} tilted ${r.maxTilt.toFixed(3)} rad`)
    assert.ok(r.maxY < 0.8, `${suv ? 'SUV' : 'sedan'} rose to ${r.maxY.toFixed(2)} m`)
    // No bounce: the only way back is the solver's penetration correction, a few percent of the approach at most
    // (about a metre a second from the cap), which a car with no brake on then keeps as a slow roll.
    assert.ok(r.rebound > -0.05 * RING0.maxVelocity, `${suv ? 'SUV' : 'sedan'} bounced back at ${(-r.rebound).toFixed(2)} m/s`)
    assert.ok(r.end.x < wallX, 'on the near side of the wall')
    assert.equal(fleet.bouncer.counts[1], 0, 'no First-Law ruling: nobody was there')
    // Away again: full throttle in reverse for two seconds, then it drives.
    const before = fleet.position(v).x
    for (let i = 0; i < 120; i++) { fleet.drive(v, { throttle: -1, brake: 0, steer: 0 }, false); step() }
    assert.ok(fleet.position(v).x < before - 3, `${suv ? 'SUV' : 'sedan'} drove ${(before - fleet.position(v).x).toFixed(2)} m away`)
    assert.equal(fleet.flipped(v), false)
  }
  // The chassis carries the policy's numbers.
  for (const v of fleet.vehicles) {
    assert.ok(Math.abs(fleet.rig(v).collider.restitution() - WALL_CONTACT.restitution) < 1e-6)
    assert.ok(Math.abs(fleet.rig(v).collider.friction() - WALL_CONTACT.friction) < 1e-6)
  }
})

test('a corner hit: a car sliding along a wall at an angle keeps its wheels and its heading sense', async () => {
  const { physics, fleet, wallX } = await wallWorld()
  const v = fleet.vehicles.find((c) => !c.suv)!
  v.mode = 'player'
  // Twenty degrees off the wall's normal, at 15 m/s.
  const heading = EAST + 0.35
  fleet.recover(v, wallX - 30, 0, heading)
  for (let k = 0; k < 60; k++) physics.step(H, (h) => fleet.updateControllers(h))
  fleet.rig(v).body.setLinvel({ x: Math.sin(heading) * 15, y: 0, z: Math.cos(heading) * 15 }, true)
  let maxTilt = 0
  for (let i = 0; i < 240; i++) {
    fleet.drive(v, { throttle: 0, brake: 0, steer: 0 }, false)
    physics.step(H, (h) => fleet.updateControllers(h))
    const r = fleet.rotation(v)
    maxTilt = Math.max(maxTilt, 2 * Math.asin(Math.min(1, Math.hypot(r.x, r.z))))
    assert.equal(fleet.flipped(v), false, `flipped at frame ${i}`)
  }
  assert.ok(maxTilt < 0.2, `tilted ${maxTilt.toFixed(3)} rad`)
  assert.ok(fleet.position(v).x < wallX, 'still on the near side')
  assert.ok(Math.abs(fleet.position(v).y - 0.56) < 0.15, `settled at ${fleet.position(v).y.toFixed(2)} m`)
})

test('players walk through players: a second avatar walking into the first is neither stopped nor deflected, and the first is unmoved', async () => {
  const physics = await Physics.create([], NONE)
  const a = new Avatar(physics, X, 0)
  const b = new Avatar(physics, X - 4, 0)
  const settle = () => { for (let k = 0; k < 30; k++) { a.move(0, 0, H); b.move(0, 0, H); physics.step(H, () => {}) } }
  settle()
  const ax = a.x, az = a.z
  // b walks east at 2 m/s for three seconds: through a's capsule at X and 2 m beyond it.
  for (let i = 0; i < 180; i++) {
    a.move(0, 0, H)
    b.move(2, 0, H)
    physics.step(H, () => {})
    assert.ok(Math.abs(b.z) < 0.01, `deflected to z=${b.z.toFixed(3)} at frame ${i}`)
  }
  assert.ok(b.x > X + 1.8, `b walked to x=${(b.x - X).toFixed(2)} m past a (6 m asked)`)
  assert.ok(Math.abs(b.x - (X - 4 + 6)) < 0.1, `b walked ${(b.x - (X - 4)).toFixed(2)} m of 6`)
  assert.ok(Math.hypot(a.x - ax, a.z - az) < 1e-6, 'a was not shoved')
  // And the wall still stops a player: a walks west into a wall box for two seconds and ends at its face.
  const physics2 = await Physics.create([[X - 10, 0, -5, X - 8, 4, 5]], NONE)
  const c = new Avatar(physics2, X - 5, 0)
  for (let k = 0; k < 30; k++) { c.move(0, 0, H); physics2.step(H, () => {}) }
  for (let i = 0; i < 120; i++) { c.move(-2, 0, H); physics2.step(H, () => {}) }
  assert.ok(c.x > X - 8 && c.x < X - 7.5, `stopped at the wall: x=${(c.x - X).toFixed(2)}`)
})
