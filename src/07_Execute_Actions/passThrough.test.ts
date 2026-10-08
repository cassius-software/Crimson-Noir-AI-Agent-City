// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves ghost-mode collision in real Rapier: the street furniture (lamps, tree trunks,
 * signal poles) is in the physics world as sensors, so the avatar walks through it and a car drives through it
 * exactly as over open ground, while buildings still stop both. The ground guard, the AI's obstacle ray and the
 * wheels never read a pole as ground or as an obstacle.
 * What breaks if it is removed? A pole could turn solid again (the avatar snagged on every lamp, a car wrapped round
 * a tree), or a sensor could lift the avatar onto a lamp's top, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { POLES, type Box, type Furniture } from '../01_Initialize_World/city.ts'
import { Physics, RAPIER } from './physics.ts'
import { Avatar } from './player.ts'
import { Fleet } from './vehicles.ts'

const H = 1 / 60
const NONE: Furniture = { lamps: [], trees: [], signals: [] }
/** Open ground away from the street grid the fleet spawns on. */
const TRACK_X = -600
/** One of each pole, on the line z = 0 at x = TRACK_X + 3, + 6, + 9. */
const LINE: Furniture = {
  lamps: [[TRACK_X + 3, 0, 0]],
  trees: [[TRACK_X + 6, 0, 1]],
  signals: [[TRACK_X + 9, 0, 0, 0]],
}

const feetOf = (a: Avatar) => a.body.translation().y - a.person.halfHeight - a.person.radius

/** Walks an avatar east from TRACK_X at 2 m/s for `frames`; returns its track (x, z, feet). */
async function walk(furniture: Furniture, boxes: Box[] = [], frames = 360) {
  const physics = await Physics.create(boxes, furniture)
  const avatar = new Avatar(physics, TRACK_X, 0)
  const track: { x: number; z: number; feet: number }[] = []
  for (let i = 0; i < frames; i++) {
    physics.step(H, (h) => avatar.move(2, 0, h))
    track.push({ x: avatar.x, z: avatar.z, feet: feetOf(avatar) })
  }
  return { physics, track }
}

test('the furniture is in the physics world, and every pole is a sensor', async () => {
  const physics = await Physics.create([], LINE)
  let sensors = 0, poles = 0
  physics.world.colliders.forEach((c) => {
    if (c.shape.type !== RAPIER.ShapeType.Cylinder) return
    poles++
    if (c.isSensor()) sensors++
  })
  assert.equal(poles, 3, 'a lamp, a tree and a signal pole')
  assert.equal(sensors, 3, 'none of them solid')
})

test('the avatar walks straight through a lamp, a tree and a signal pole, as over open ground', async () => {
  const open = await walk(NONE)
  const poles = await walk(LINE)
  const end = poles.track.at(-1)!, ref = open.track.at(-1)!
  assert.ok(end.x > TRACK_X + 11, `passed all three poles: x ${end.x.toFixed(2)}`)
  assert.ok(Math.abs(end.x - ref.x) < 1e-3, `no hold-up: ${end.x.toFixed(4)} against ${ref.x.toFixed(4)} on open ground`)
  for (const p of poles.track) {
    assert.ok(Math.abs(p.z) < 1e-3, `never pushed aside: z ${p.z.toFixed(4)} at x ${p.x.toFixed(2)}`)
    assert.ok(p.feet < 0.06, `never lifted onto a pole: feet ${p.feet.toFixed(3)} at x ${p.x.toFixed(2)}`)
  }
  // Inside each pole's radius at some frame (the walk really went through it, not beside it).
  for (const x of [TRACK_X + 3, TRACK_X + 6, TRACK_X + 9]) {
    assert.ok(poles.track.some((p) => Math.abs(p.x - x) < POLES.tree.radius), `went through the pole at ${x}`)
  }
})

test('a building still stops the avatar (the control: only furniture is ghost)', async () => {
  const wall: Box = [TRACK_X + 5, 0, -3, TRACK_X + 6, 3, 3]
  const { track } = await walk(LINE, [wall])
  const end = track.at(-1)!
  assert.ok(end.x < TRACK_X + 5, `stopped at the wall's face: x ${end.x.toFixed(2)}`)
  assert.ok(end.x > TRACK_X + 4.4, `after passing the lamp at +3: x ${end.x.toFixed(2)}`)
})

test('the ground guard and the fixed-geometry ray see through the poles, not through buildings', async () => {
  const physics = await Physics.create([[TRACK_X + 20, 0, -1, TRACK_X + 22, 3, 1]], LINE)
  physics.step(H, () => {}) // the query pipeline indexes the colliders on the first step
  // Straight down from inside the lamp: the road (y = 0), not the lamp's inside.
  const down = physics.castRay(TRACK_X + 3, 0.9, 0, 0, -1, 0, 5, undefined, true)
  assert.ok(down !== null && Math.abs(down - 0.9) < 1e-4, `ground at ${down}`)
  // East along the line at 1 m: through the three poles to the building's face.
  const east = physics.castRay(TRACK_X, 1, 0, 1, 0, 0, 40, undefined, true)
  assert.ok(east !== null && Math.abs(east - 20) < 1e-4, `the building at ${east} m`)
})

test('a car drives through a lamp and a tree at speed, as over open ground; a building still stops it', async () => {
  const run = async (furniture: Furniture, boxes: Box[] = []) => {
    const physics = await Physics.create(boxes, furniture)
    const fleet = new Fleet(physics, 1, 11, { exposeRig: true })
    const car = fleet.vehicles[0]
    car.mode = 'player'
    const step = (n: number) => { for (let k = 0; k < n; k++) physics.step(H, (h) => fleet.updateControllers(h)) }
    fleet.recover(car, TRACK_X - 30, 0, Math.PI / 2)
    step(60)
    fleet.rig(car).body.setLinvel({ x: 10, y: 0, z: 0 }, true)
    let minSpeed = Infinity
    for (let i = 0; i < 240; i++) {
      fleet.drive(car, { throttle: 0, brake: 0, steer: 0 }, false)
      step(1)
      minSpeed = Math.min(minSpeed, fleet.speed(car))
    }
    const p = fleet.position(car)
    return { x: p.x, z: p.z, speed: fleet.speed(car), minSpeed }
  }
  const open = await run(NONE)
  const poles = await run({ lamps: [[TRACK_X - 10, 0, 0]], trees: [[TRACK_X, 0, 1]], signals: [] })
  assert.ok(open.x > TRACK_X + 5, `the car passed the poles' place: x ${open.x.toFixed(1)}`)
  assert.ok(Math.abs(poles.x - open.x) < 0.05 && Math.abs(poles.z - open.z) < 0.05, `same line: (${poles.x.toFixed(2)}, ${poles.z.toFixed(2)}) against (${open.x.toFixed(2)}, ${open.z.toFixed(2)})`)
  assert.ok(Math.abs(poles.speed - open.speed) < 0.05, `no impact: ${poles.speed.toFixed(3)} m/s against ${open.speed.toFixed(3)}`)
  const walled = await run(NONE, [[TRACK_X - 10, 0, -4, TRACK_X - 9, 3, 4]])
  assert.ok(walled.x < TRACK_X - 10 && walled.minSpeed < 2, `a wall stops it: x ${walled.x.toFixed(1)}, slowest ${walled.minSpeed.toFixed(2)} m/s`)
})
