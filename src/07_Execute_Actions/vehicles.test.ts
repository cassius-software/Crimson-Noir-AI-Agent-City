// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the fleet in real Rapier (WASM, run in Node): plausible coast-down,
 * First-Law braking inside the stopping envelope, Ackermann geometry, strict CCD on every chassis, the
 * world statistics, a sensing corridor that sweeps the whole body the way the bicycle model moves it, and
 * that no command reaches the wheels unvetted — an AI car stops short of a person in its lane or on the
 * crosswalk it turns into, a parked car rolling at someone is held, a player's throttle toward a person
 * (ahead, behind, or against the motion) is overruled while one toward a wall is not, a player's car left
 * without input coasts, and garbage commands are sanitised.
 * What breaks if it is removed? Tyre, drag or brake tuning could drift until a car can no longer stop for
 * a person, with nothing to catch it before a browser session does.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GROUND_COLLIDERS, Physics, RAPIER } from './physics.ts'
import { ackermann, CAR, corridorDistance, Fleet, type Vehicle, CAR_TUNE_RANGE } from './vehicles.ts'
import { MODES, POSE } from './simProtocol.ts'
import { Driver } from '../06_Make_Decisions/traffic.ts'
import { TrackDriver } from '../06_Make_Decisions/trackDriver.ts'
import { buildTrackNetwork, poseAt, projectOnto, ringGaps, TRACKS } from '../06_Make_Decisions/tracks.ts'
import { onRoad } from '../03_Spawn_Agents/skills.ts'
import { CITY, type Box } from '../01_Initialize_World/city.ts'
import { KERNEL, TRAFFIC } from '../02_Define_The_Rules/civic.ts'
import { Bouncer, stoppingDistance } from '../02_Define_The_Rules/laws.ts'
import { createRng } from '../02_Define_The_Rules/degrees.ts'

const H = 1 / 60
const NO_FURNITURE = { lamps: [], trees: [], signals: [] }
/** Open ground well away from the street grid the fleet spawns on (the ground plane spans ±1600 m around the centre). */
const TRACK_X = -600
/** Seed whose fleet of 8 has both sedans and SUVs. */
const SEED = 11

async function rig(count = 8, boxes: Box[] = []) {
  const physics = await Physics.create(boxes, NO_FURNITURE)
  const fleet = new Fleet(physics, count, SEED, { exposeRig: true })
  const step = (frames = 1) => {
    for (let k = 0; k < frames; k++) physics.step(H, (h) => fleet.updateControllers(h))
  }
  return { physics, fleet, step }
}

/** Puts `v` on open ground at (x, z) facing `heading`, settles its suspension, then sets it moving at `speed`. */
function place(fleet: Fleet, step: (frames?: number) => void, v: Vehicle, x: number, z: number, heading: number, speed = 0) {
  fleet.recover(v, x, z, heading)
  step(60)
  fleet.rig(v).body.setLinvel({ x: Math.sin(heading) * speed, y: 0, z: Math.cos(heading) * speed }, true)
}

function pick(fleet: Fleet, suv: boolean): Vehicle {
  const v = fleet.vehicles.find((c) => c.suv === suv)
  assert.ok(v, `seed ${SEED} has no ${suv ? 'SUV' : 'sedan'}`)
  return v
}

const kinds = [['sedan', false], ['SUV', true]] as const

test('every chassis has strict CCD, and the world stats count bodies, colliders, CCD bodies and substeps', async () => {
  const box: Box = [100, 0, 100, 110, 8, 110]
  const physics = await Physics.create([box], { lamps: [[90, 90, 0]], trees: [], signals: [] })
  const fleet = new Fleet(physics, 12, SEED, { exposeRig: true })
  for (const v of fleet.vehicles) assert.ok(fleet.rig(v).body.isCcdEnabled(), `vehicle ${v.index} has no CCD`)

  assert.equal(physics.step(1 / 30, (h) => fleet.updateControllers(h)), 2)
  const s = physics.stats
  assert.equal(s.steps, 2)
  assert.equal(s.ccd, 12)
  assert.equal(s.bodies, 1 + 12, 'the fixed city body and one chassis per car')
  assert.equal(s.colliders, GROUND_COLLIDERS + 2 + 12, 'ground tiles, building box, lamp pole and one chassis per car')
  assert.ok(Number.isFinite(s.stepMs) && s.stepMs > 0, `stepMs ${s.stepMs}`)

  physics.step(0.25 * H, (h) => fleet.updateControllers(h))
  assert.equal(physics.stats.steps, 0, 'a frame shorter than a step runs none')
})

test('coast-down from 50 km/h decelerates plausibly (drag, rolling resistance, engine braking)', async () => {
  const { fleet, step } = await rig()
  for (const [name, suv] of kinds) {
    const v = pick(fleet, suv)
    v.mode = 'player'
    place(fleet, step, v, TRACK_X, suv ? 60 : 0, Math.PI / 2, 50 / 3.6)
    fleet.drive(v, { throttle: 0, brake: 0, steer: 0 }, false)
    step(3)
    const v0 = fleet.speed(v)
    step(120)
    const decel = (v0 - fleet.speed(v)) / 2
    assert.ok(decel >= 0.2 && decel <= 0.6, `${name}: ${decel.toFixed(3)} m/s²`)

    // The road loads are rebuilt every substep, not accumulated: the chassis carries exactly one set.
    const speed = fleet.speed(v)
    const cda = suv ? CAR.suvDragCoefficient * CAR.suvFrontalArea : CAR.dragCoefficient * CAR.frontalArea
    const expected = 0.5 * 1.225 * cda * speed * speed + CAR.rollingResistance * v.mass * 9.81 + CAR.engineBraking * speed
    const f = fleet.rig(v).body.userForce()
    assert.ok(Math.abs(Math.hypot(f.x, f.z) - expected) / expected < 0.03, `${name}: road load ${Math.hypot(f.x, f.z).toFixed(0)} N, expected ${expected.toFixed(0)} N`)
  }
})

test(`braking at KERNEL.maxBrake from 40 km/h stops inside the First Law envelope`, async () => {
  const { fleet, step } = await rig()
  for (const [name, suv] of kinds) {
    const v = pick(fleet, suv)
    v.mode = 'player'
    place(fleet, step, v, TRACK_X, suv ? 60 : 0, Math.PI / 2, 40 / 3.6)
    fleet.drive(v, { throttle: 0, brake: 0, steer: 0 }, false)
    step(2)
    const v0 = fleet.speed(v)
    const x0 = fleet.position(v).x
    fleet.drive(v, { throttle: 0, brake: KERNEL.maxBrake, steer: 0 }, false)
    let frames = 0
    while (fleet.speed(v) > 0.05 && frames < 600) { step(); frames++ }
    const distance = fleet.position(v).x - x0
    const decel = v0 / (frames * H)
    assert.ok(distance <= stoppingDistance(v0) + KERNEL.standoff, `${name}: ${distance.toFixed(2)} m`)
    assert.ok(decel >= KERNEL.emergencyDecel && decel <= KERNEL.maxBrake + 1, `${name}: mean ${decel.toFixed(2)} m/s²`)
  }
})

test('Ackermann steering: the inner front wheel turns tighter, both about the rear-axle turn centre', async () => {
  for (const steer of [0.05, 0.2, 0.4, CAR.maxSteer]) {
    const inner = ackermann(steer, 1), outer = ackermann(steer, -1)
    assert.ok(inner > steer && steer > outer && outer > 0, `steer ${steer}: ${inner} / ${outer}`)
    const R = CAR.wheelbase / Math.tan(steer)
    assert.ok(Math.abs(CAR.wheelbase / Math.tan(inner) + CAR.track / 2 - R) < 1e-9)
    assert.ok(Math.abs(CAR.wheelbase / Math.tan(outer) - CAR.track / 2 - R) < 1e-9)
    // Turning right mirrors it: the right wheel is now the inner one.
    assert.equal(ackermann(-steer, -1), -inner)
    assert.equal(ackermann(-steer, 1), -outer)
  }
  assert.equal(ackermann(0, 1), 0)

  const { fleet, step } = await rig()
  const v = pick(fleet, false)
  v.mode = 'player'
  place(fleet, step, v, TRACK_X, 0, Math.PI / 2)
  const steer = 0.4
  fleet.drive(v, { throttle: 0.15, brake: 0, steer }, false)
  step()
  const c = fleet.rig(v).controller
  // Wheel 1 is front-left (chassis −z), wheel 0 front-right: a left turn makes the left wheel the inner one.
  assert.ok(Math.abs((c.wheelSteering(1) ?? 0) - ackermann(steer, 1)) < 1e-6)
  assert.ok(Math.abs((c.wheelSteering(0) ?? 0) - ackermann(steer, -1)) < 1e-6)
  assert.ok((c.wheelSteering(1) ?? 0) > (c.wheelSteering(0) ?? 0))
  // At walking pace the car follows the kinematic circle and turns left (north of east is −z).
  const start = fleet.position(v)
  let minZ = Infinity, maxX = -Infinity
  for (let k = 0; k < 60 * 12; k++) {
    fleet.drive(v, { throttle: fleet.speed(v) < 2 ? 0.15 : 0, brake: 0, steer }, false)
    step()
    const t = fleet.position(v)
    minZ = Math.min(minZ, t.z); maxX = Math.max(maxX, t.x)
  }
  const R = CAR.wheelbase / Math.tan(steer)
  const diameter = start.z - minZ
  assert.ok(Math.abs(diameter / 2 - R) / R < 0.15, `turn radius ${(diameter / 2).toFixed(2)} m, kinematic ${R.toFixed(2)} m`)
  assert.ok(maxX - start.x < R * 1.3)
})

/**
 * Independent reference for the corridor: samples the kinematic bicycle model in world space (rear axle on
 * its circle, heading h0 + dir·k·t) and returns the first rear-axle travel at which the widened footprint
 * holds the point.
 */
function sweptReference(px: number, pz: number, cx: number, cz: number, h0: number, k: number, dir: 1 | -1, ds = 0.004): number {
  const half = CAR.halfWidth + KERNEL.corridor, wb = CAR.wheelbase
  const ax0 = cx - (Math.sin(h0) * wb) / 2, az0 = cz - (Math.cos(h0) * wb) / 2
  // Left of forward (sin h, cos h) is (cos h, −sin h); the turn centre lies 1/k along it from the rear axle.
  const wx = k === 0 ? 0 : ax0 + Math.cos(h0) / k, wz = k === 0 ? 0 : az0 - Math.sin(h0) / k
  for (let t = 0; t <= KERNEL.range; t += ds) {
    const h = k === 0 ? h0 : h0 + dir * k * t
    const ax = k === 0 ? ax0 + dir * t * Math.sin(h0) : wx - Math.cos(h) / k
    const az = k === 0 ? az0 + dir * t * Math.cos(h0) : wz + Math.sin(h) / k
    const fx = Math.sin(h), fz = Math.cos(h)
    const rx = px - ax - (fx * wb) / 2, rz = pz - az - (fz * wb) / 2
    if (Math.abs(rx * fx + rz * fz) <= CAR.halfLength && Math.abs(rx * fz - rz * fx) <= half) return t
  }
  return Infinity
}

test('corridor distance: the widened footprint swept about the rear-axle turn centre, ahead and behind', () => {
  const half = CAR.halfWidth + KERNEL.corridor
  // Facing east (heading π/2): forward +x, left −z, so a chassis point (u, l) sits at world (u, −l).
  const h = Math.PI / 2
  const at = (u: number, l: number, k: number, dir: 1 | -1) => corridorDistance(u, -l, 0, 0, h, k, dir)
  // Straight: bumper to person, the corridor's width, its range, and nothing the wrong way.
  assert.equal(at(20, 0, 0, 1), 20 - CAR.halfLength)
  assert.equal(at(20, half - 0.01, 0, 1), 20 - CAR.halfLength)
  assert.equal(at(20, -(half + 0.01), 0, 1), Infinity)
  assert.equal(at(CAR.halfLength + KERNEL.range + 0.5, 0, 0, 1), Infinity)
  assert.equal(at(-20, 0, 0, 1), Infinity)
  assert.equal(at(-20, 0, 0, -1), 20 - CAR.halfLength)
  assert.equal(at(20, 0, NaN, 1), 20 - CAR.halfLength, 'a curvature that is not a number reads as straight, never as no corridor')
  // Alongside the body, inside the margin: the car must not move either way.
  assert.equal(at(1, 1.2, 0, 1), 0)
  assert.equal(at(1, 1.2, 0, -1), 0)
  assert.equal(at(1, 2.5, 0, 1), Infinity)

  const full = Math.tan(CAR.maxSteer) / CAR.wheelbase, R = 1 / full
  // At full lock left the nose swings left at once: someone ahead-left, off the straight corridor, is
  // reached within 1.5 m, and so is someone beside the front-left door.
  assert.equal(at(CAR.halfLength + 1, 1.9, 0, 1), Infinity)
  assert.ok(at(CAR.halfLength + 1, 1.9, full, 1) < 1.5)
  assert.ok(at(1, 1.6, full, 1) < 0.5)
  // Nearer the turn centre than the inner side ever comes: never reached.
  assert.equal(at(-2, 1.6, full, 1), Infinity)
  // Reversing on a left lock swings the nose right, into someone beside the front-right corner.
  assert.ok(at(1.5, -1.6, full, -1) < 0.5)
  // The rear axle's quarter-turn point is swept by the body well before the axle gets there.
  assert.ok(at(-CAR.wheelbase / 2 + R, R, full, 1) < (Math.PI / 2) * R)
  assert.equal(at(CAR.halfLength + 20, 0, full, 1), Infinity, 'straight ahead is off a tight path')
  // Gentle curvature: the bumper leads the rear axle, so the path's offset is k·s²/2 plus
  // (halfLength + wheelbase/2)·k·s, not the parabola alone.
  const k = 0.05, s = 12, lead = (CAR.halfLength + CAR.wheelbase / 2) * k * s
  assert.equal(at(CAR.halfLength + s, (k * s * s) / 2, k, 1), Infinity)
  assert.ok(Number.isFinite(at(CAR.halfLength + s, (k * s * s) / 2 + lead, k, 1)))
  assert.equal(at(CAR.halfLength + s, -((k * s * s) / 2 + lead), -k, 1), at(CAR.halfLength + s, (k * s * s) / 2 + lead, k, 1), 'a right turn mirrors it')

  // Property: agrees with the world-space reference for any pose, curvature and direction.
  const rng = createRng(7)
  let hits = 0
  for (let n = 0; n < 700; n++) {
    const cx = (rng() - 0.5) * 10, cz = (rng() - 0.5) * 10
    const px = cx + (rng() - 0.5) * 44, pz = cz + (rng() - 0.5) * 44
    const heading = rng() * Math.PI * 2
    const kind = rng()
    const curvature = kind < 0.15 ? 0 : kind < 0.4 ? (rng() - 0.5) * 0.02 : (rng() - 0.5) * 2 * full
    const dir = rng() < 0.5 ? 1 : -1
    const got = corridorDistance(px, pz, cx, cz, heading, curvature, dir)
    const want = sweptReference(px, pz, cx, cz, heading, curvature, dir)
    if (want === Infinity) { assert.equal(got, Infinity, `false alarm at sample ${n}`); continue }
    hits++
    assert.ok(Math.abs(got - want) <= 0.01, `sample ${n}: ${got} m, reference ${want} m`)
  }
  assert.ok(hits > 30, `only ${hits} contacts sampled`)
})

test('fleet sensing: avatar corridor, GPU readings, curvature and footprints', async () => {
  const { fleet, step } = await rig()
  const v = pick(fleet, false)
  v.mode = 'player'
  place(fleet, step, v, TRACK_X, 0, Math.PI / 2)
  const t = fleet.position(v)

  assert.equal(fleet.personAhead(v), Infinity)
  fleet.setAvatar(t.x + CAR.halfLength + 10, t.z, true)
  assert.ok(Math.abs(fleet.personAhead(v) - 10) < 0.05)
  assert.equal(fleet.personBehind(v), Infinity)
  fleet.setAvatar(t.x + CAR.halfLength + 10, t.z, false)
  assert.equal(fleet.personAhead(v), Infinity, 'an avatar inside a car is not a person on the road')

  const ahead = new Float32Array(fleet.vehicles.length).fill(Infinity)
  const behind = new Float32Array(fleet.vehicles.length).fill(Infinity)
  ahead[v.index] = 7
  behind[v.index] = -0.3
  fleet.setPersonHazards(ahead, behind)
  assert.equal(fleet.personAhead(v), 7)
  assert.equal(fleet.personBehind(v), 0, 'an overlap reads as zero')
  fleet.setAvatar(t.x + CAR.halfLength + 4, t.z, true)
  assert.ok(Math.abs(fleet.personAhead(v) - 4) < 0.05, 'the nearer of GPU and avatar')
  fleet.setPersonHazards([NaN], [])
  fleet.setAvatar(0, 0, false)
  assert.equal(fleet.personAhead(fleet.vehicles[0]), Infinity, 'NaN is no reading')
  assert.equal(fleet.personBehind(v), Infinity, 'vehicles past the end of the array have none')

  fleet.drive(v, { throttle: 0, brake: 0, steer: 0.3 }, false)
  const states = fleet.crowdStates()
  assert.ok(Math.abs(states[v.index].curvature - Math.tan(0.3) / CAR.wheelbase) < 1e-12)
  fleet.drive(v, { throttle: 0, brake: 0, steer: -0.2 }, false)
  assert.ok(fleet.crowdStates()[v.index].curvature < 0, 'turning right is negative')

  const prints = fleet.footprints()
  assert.equal(prints, fleet.footprints(), 'the footprint array is reused')
  assert.equal(prints.length, fleet.vehicles.length)
  for (const f of prints) {
    const w = fleet.vehicles[f.id]
    const t = fleet.position(w), lv = fleet.velocity(w)
    assert.deepEqual([f.x, f.z, f.vx, f.vz, f.active], [t.x, t.z, lv.x, lv.z, true], 'sampled from the chassis')
    for (const value of Object.values(f)) assert.ok(typeof value === 'number' || typeof value === 'boolean', 'plain data only')
    assert.equal(f.halfLength, CAR.halfLength)
    assert.equal(f.halfWidth, CAR.halfWidth)
    assert.equal(f.heading, fleet.heading(w))
  }
  const poses = fleet.writePoses(new Float32Array(fleet.vehicles.length * POSE.stride))
  assert.ok(poses.every(Number.isFinite), 'the packed poses are finite')
  for (const w of fleet.vehicles) {
    const o = w.index * POSE.stride, t = fleet.position(w)
    assert.deepEqual([poses[o + POSE.x], poses[o + POSE.z]], [Math.fround(t.x), Math.fround(t.z)])
    assert.equal(poses[o + POSE.heading], Math.fround(fleet.heading(w)))
    assert.equal(MODES[poses[o + POSE.mode]], w.mode)
  }
})

test('wheel spin follows the ground: Rapier rolling angle, decreasing rolling forward (the mesh convention)', async () => {
  const { fleet, step } = await rig()
  const v = pick(fleet, false)
  v.mode = 'player'
  place(fleet, step, v, TRACK_X, 0, Math.PI / 2, 5)
  fleet.drive(v, { throttle: 0, brake: 0, steer: 0 }, false)
  const before = fleet.rig(v).controller.wheelRotation(2) ?? 0
  step(30)
  const after = fleet.rig(v).controller.wheelRotation(2) ?? 0
  // 0.5 s at ~5 m/s on a 0.34 m wheel is ~7 rad of roll.
  assert.ok(before - after > 6 && before - after < 8, `rolled ${(before - after).toFixed(2)} rad`)
  const poses = fleet.writePoses(new Float32Array(fleet.vehicles.length * POSE.stride))
  assert.equal(poses[v.index * POSE.stride + POSE.wheels + 3 * 2 + 1], Math.fround(after), 'the pose buffer carries the rolling angle')
})

test('people are not road and not obstacles: wheels skip a shielded person, the gap rays see only cars and walls', async () => {
  const wallX = TRACK_X + 20
  const { physics, fleet, step } = await rig(8, [[wallX, 0, -20, wallX + 2, 6, 20]])
  const world = physics.world
  const v = pick(fleet, false)
  v.mode = 'player'
  place(fleet, step, v, TRACK_X, 0, Math.PI / 2)
  const bumper = fleet.position(v).x + CAR.halfLength + 0.1
  assert.ok(Math.abs(fleet.gapAhead(v) - (wallX - bumper)) < 0.05, 'the wall is an obstacle')
  // A standing avatar (kinematic capsule) 10 m ahead: a person, so not an obstacle.
  const person = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(bumper + 10, 0.9, 0))
  const capsule = world.createCollider(RAPIER.ColliderDesc.capsule(0.6, 0.3), person)
  step()
  assert.ok(Math.abs(fleet.gapAhead(v) - (wallX - bumper)) < 0.05, 'the person is not an obstacle')

  // Shielded (a sensor) in the right-hand wheel track: the car passes level, as if nobody were there.
  world.removeCollider(capsule, true)
  world.createCollider(RAPIER.ColliderDesc.capsule(0.6, 0.3).setSensor(true), person)
  person.setTranslation({ x: bumper + 6, y: 0.9, z: CAR.track / 2 }, true)
  place(fleet, step, v, TRACK_X, 0, Math.PI / 2, 12)
  const rest = fleet.position(v).y
  fleet.drive(v, { throttle: 0, brake: 0, steer: 0 }, false)
  let lift = 0
  for (let k = 0; k < 60; k++) {
    step()
    lift = Math.max(lift, fleet.position(v).y - rest)
  }
  assert.ok(fleet.position(v).x > bumper + 6, 'the car has passed the person')
  assert.ok(lift < 0.02, `the car rode ${lift.toFixed(3)} m up over the person`)
})

/** An AI car on a straight street at 40 km/h meets a person standing in its lane; `appearAt` is when they step in. */
async function aiMeetsPerson(natural: number, appearAt = 0) {
  const { physics, fleet, step } = await rig(1)
  const v = fleet.vehicles[0]
  const from: [number, number] = [2, 5], east: [number, number] = [1, 0]
  // First draw: straight on at the next intersection. Second: the Perception check's d20.
  const queue = [0.1, (natural - 0.5) / 20]
  v.driver = new Driver(from, east, () => queue.shift() ?? 0.5)
  const start = Driver.lanePose(from, east, 0)
  place(fleet, step, v, start.x, start.z, start.heading, TRAFFIC.speedLimit)
  const person = Driver.lanePose(from, east, 32)
  let minGap = Infinity
  for (let t = 0; t < 10; t += H) {
    fleet.setAvatar(person.x, person.z, t >= appearAt)
    fleet.think(H, 1)
    physics.step(H, (h) => fleet.updateControllers(h))
    minGap = Math.min(minGap, person.x - fleet.position(v).x - CAR.halfLength)
  }
  return { fleet, v, minGap }
}

test('an AI car stops short of a person in its lane, whatever its Perception degree', async () => {
  for (const natural of [1, 3, 10, 18]) {
    const { fleet, v, minGap } = await aiMeetsPerson(natural)
    assert.ok(Math.abs(fleet.speed(v)) < 0.05, `natural ${natural}: still moving`)
    assert.ok(minGap >= KERNEL.standoff, `natural ${natural}: came within ${minGap.toFixed(2)} m`)
    assert.equal(fleet.bouncer.counts[1], 0, `natural ${natural}: the driver stopped in time without the First Law`)
  }
})

test('a person stepping out just beyond the envelope: a slow driver is stopped by the First Law, as one intervention; a quick one stops on their own', async () => {
  // 40 km/h reaches 12 m from the person 1.59 s in; the envelope there is 10.8 m.
  const appearAt = (32 - CAR.halfLength - 12) / TRAFFIC.speedLimit
  // A critical failure (1 s to notice): the First Law brakes, and holds to a standstill. A success (0.25 s, counted to the
  // frame: hazards.ts REACTION_SLACK) brakes before the envelope is reached, with nothing for the First Law to do.
  for (const [natural, interventions] of [[1, 1], [18, 0]]) {
    const { fleet, v, minGap } = await aiMeetsPerson(natural, appearAt)
    assert.ok(Math.abs(fleet.speed(v)) < 0.05)
    assert.ok(minGap >= KERNEL.standoff, `natural ${natural}: came within ${minGap.toFixed(2)} m`)
    assert.equal(fleet.bouncer.counts[1], interventions, `natural ${natural}: emergency braking holds to a standstill: at most one rising edge, no pulsing`)
  }
})

test('the player cannot throttle into a person ahead or reverse into one behind', async () => {
  const { fleet, step } = await rig()
  const v = pick(fleet, false)
  v.mode = 'player'
  place(fleet, step, v, TRACK_X, 0, Math.PI / 2)
  const personX = fleet.position(v).x + CAR.halfLength + 25
  const ahead = new Float32Array(fleet.vehicles.length).fill(Infinity)
  const behind = new Float32Array(fleet.vehicles.length).fill(Infinity)
  let minGap = Infinity
  for (let t = 0; t < 8; t += H) {
    const gap = personX - fleet.position(v).x - CAR.halfLength
    ahead[v.index] = gap
    fleet.setPersonHazards(ahead, behind)
    fleet.drive(v, { throttle: 1, brake: 0, steer: 0 }, false)
    step()
    minGap = Math.min(minGap, gap)
  }
  const forward = fleet.bouncer.counts[1]
  assert.ok(forward >= 1 && forward <= 3, `${forward} interventions: emergency braking must hold, not pulse`)
  assert.ok(Math.abs(fleet.speed(v)) < 0.05, 'held at a standstill with the throttle still down')
  assert.ok(minGap >= KERNEL.standoff, `came within ${minGap.toFixed(2)} m`)

  // Reversing toward a person 12 m behind the rear bumper: moving away from the one ahead is allowed.
  ahead.fill(Infinity)
  const rearPerson = fleet.position(v).x - CAR.halfLength - 12
  let minRear = Infinity
  for (let t = 0; t < 10; t += H) {
    const gap = fleet.position(v).x - CAR.halfLength - rearPerson
    behind[v.index] = gap
    fleet.setPersonHazards(ahead, behind)
    fleet.drive(v, { throttle: -0.55, brake: 0, steer: 0 }, false)
    step()
    minRear = Math.min(minRear, gap)
  }
  assert.ok(minRear >= KERNEL.standoff, `reversed within ${minRear.toFixed(2)} m`)
  assert.ok(minRear < 12 - 8, 'the car did reverse most of the way before the First Law held it')
  assert.ok(fleet.bouncer.counts[1] - forward <= 3)
})

/** Chassis rectangle to a standing person's capsule (radius 0.3 m), metres; negative = overlap. */
function clearance(fleet: Fleet, v: Vehicle, px: number, pz: number): number {
  const t = fleet.position(v), h = fleet.heading(v)
  const fx = Math.sin(h), fz = Math.cos(h)
  const rx = px - t.x, rz = pz - t.z
  const du = Math.abs(rx * fx + rz * fz) - CAR.halfLength, dw = Math.abs(rz * fx - rx * fz) - CAR.halfWidth
  return (du <= 0 && dw <= 0 ? Math.max(du, dw) : Math.hypot(Math.max(du, 0), Math.max(dw, 0))) - 0.3
}

test('an AI car turning right stops short of the avatar on the exit crosswalk (the body is swept, not only the bumper)', async () => {
  // Eastbound, turning right into the southbound lane (x = B.x − 2), whose crosswalk spans z = B.z + 4.4 … 7.4.
  for (const [ax, az] of [[-2, 4.4], [-2, 5.5], [-3, 6]]) {
    const { physics, fleet, step } = await rig(1)
    const v = fleet.vehicles[0]
    const from: [number, number] = [2, 5], east: [number, number] = [1, 0]
    // First draw: turn right at the next intersection. Second: the Perception check's d20 (a plain success).
    const queue = [0.9, (10 - 0.5) / 20]
    v.driver = new Driver(from, east, () => queue.shift() ?? 0.5)
    const start = Driver.lanePose(from, east, 12)
    place(fleet, step, v, start.x, start.z, start.heading, TRAFFIC.speedLimit)
    const px = (from[0] + 1) * 40 + ax, pz = from[1] * 40 + az
    let minClear = Infinity
    for (let t = 0; t < 14; t += H) {
      fleet.setAvatar(px, pz, true)
      fleet.think(H, 1)
      physics.step(H, (h) => fleet.updateControllers(h))
      minClear = Math.min(minClear, clearance(fleet, v, px, pz))
    }
    assert.ok(minClear >= 0.3, `avatar at (${ax}, ${az}): the chassis came within ${minClear.toFixed(2)} m`)
    assert.ok(Math.abs(fleet.speed(v)) < 0.05, `avatar at (${ax}, ${az}): still moving`)
  }
})

test('a parked car rolling toward a person is held by the First Law too', async () => {
  const { fleet, step } = await rig()
  const v = pick(fleet, false)
  place(fleet, step, v, TRACK_X, 0, Math.PI / 2, 8)
  // The player stepped out at 8 m/s: the parking brake alone (4 m/s²) would need 8 m, leaving under 1 m.
  v.mode = 'parked'
  const personX = fleet.position(v).x + CAR.halfLength + 9
  let minGap = Infinity
  for (let t = 0; t < 4; t += H) {
    fleet.setAvatar(personX, 0, true)
    fleet.think(H, 0)
    assert.equal(v.lastCommand.throttle, 0)
    step()
    minGap = Math.min(minGap, personX - fleet.position(v).x - CAR.halfLength)
  }
  assert.ok(fleet.bouncer.counts[1] >= 1, 'the parked car was vetted')
  assert.ok(minGap >= KERNEL.standoff, `came within ${minGap.toFixed(2)} m`)
  assert.ok(Math.abs(fleet.speed(v)) < 0.05)
})

test('drive against the motion toward a person within the standoff is braking, never throttle', async () => {
  const { fleet, step } = await rig()
  const v = pick(fleet, false)
  v.mode = 'player'
  const ahead = new Float32Array(fleet.vehicles.length).fill(Infinity)
  const behind = new Float32Array(fleet.vehicles.length).fill(Infinity)
  for (const dir of [1, -1] as const) {
    // Rolling away from a person 1 m off the other bumper while the driver selects drive toward them.
    place(fleet, step, v, TRACK_X, 0, Math.PI / 2, dir * 1.2)
    const bumper = (x: number) => x - dir * CAR.halfLength
    const personX = bumper(fleet.position(v).x) - dir * 1
    let minGap = Infinity
    for (let t = 0; t < 3; t += H) {
      const gap = dir * (bumper(fleet.position(v).x) - personX)
      ahead.fill(Infinity); behind.fill(Infinity)
      ;(dir > 0 ? behind : ahead)[v.index] = gap
      fleet.setPersonHazards(ahead, behind)
      fleet.drive(v, { throttle: -dir * 0.55, brake: 0, steer: 0 }, false)
      assert.ok(v.lastCommand.throttle * -dir <= 0, `t ${t.toFixed(2)} s: throttle ${v.lastCommand.throttle} toward the person at ${gap.toFixed(2)} m`)
      step()
      minGap = Math.min(minGap, gap)
    }
    assert.ok(minGap >= 1 - 0.01, `came within ${minGap.toFixed(2)} m`)
    assert.ok(Math.abs(fleet.speed(v)) < 0.05)
  }
})

test('First Law, end to end: no throttle ever points at a person inside the envelope (grid over speed, people and input)', async () => {
  const { fleet, step } = await rig()
  const v = pick(fleet, false)
  v.mode = 'player'
  place(fleet, step, v, TRACK_X, 0, Math.PI / 2)
  const ahead = new Float32Array(fleet.vehicles.length).fill(Infinity)
  const behind = new Float32Array(fleet.vehicles.length).fill(Infinity)
  const distances = [0, 0.5, 1.4, 1.6, 3, 8, 20, Infinity]
  let cases = 0, refused = 0
  // The latch carries over between cases on purpose: the invariant must hold in whatever state it is in.
  for (const speed of [-6, -1, -0.2, -0.04, 0, 0.03, 0.2, 1, 6, 14]) {
    for (const a of distances) {
      for (const b of distances) {
        for (const throttle of [-1, -0.55, -0.1, 0.1, 1, NaN]) {
          for (const brake of [0, KERNEL.maxBrake]) {
            fleet.rig(v).body.setLinvel({ x: speed, y: 0, z: 0 }, true)
            ahead[v.index] = a
            behind[v.index] = b
            fleet.setPersonHazards(ahead, behind)
            const s = fleet.speed(v)
            fleet.drive(v, { throttle, brake, steer: 0 }, false)
            const out = v.lastCommand.throttle
            const where = `speed ${s.toFixed(2)} ahead ${a} behind ${b} input ${throttle}/${brake}: throttle ${out}`
            if (out > 0) assert.ok(a > stoppingDistance(Math.max(0, s)) + KERNEL.standoff, where)
            if (out < 0) assert.ok(b > stoppingDistance(Math.max(0, -s)) + KERNEL.standoff, where)
            assert.ok(Number.isFinite(out) && Number.isFinite(v.lastCommand.brake), where)
            if (throttle === throttle && out === 0) refused++
            cases++
          }
        }
      }
    }
  }
  assert.ok(cases > 7000 && refused > 1000, `${cases} cases, ${refused} refused`)
})

test('a player car without drive() since the last think() coasts with the throttle closed, re-vetted', async () => {
  const { fleet, step } = await rig()
  const v = pick(fleet, false)
  v.mode = 'player'
  place(fleet, step, v, TRACK_X, 0, Math.PI / 2, 5)
  fleet.drive(v, { throttle: 1, brake: 0, steer: 0.1 }, false)
  fleet.think(H, 0)
  assert.equal(v.lastCommand.throttle, 1, 'driven this frame: the input stands')
  step()
  fleet.think(H, 0)
  assert.equal(v.lastCommand.throttle, 0, 'no input since: throttle closed')
  assert.equal(v.lastCommand.steer, 0.1, 'the wheel stays where it was')
  // Full throttle once more, then the input stops and a person steps in front: stopped like any other car.
  fleet.drive(v, { throttle: 1, brake: 0, steer: 0 }, false)
  step()
  const t0 = fleet.position(v)
  const personX = t0.x + CAR.halfLength + 6, personZ = t0.z
  for (let t = 0; t < 3; t += H) {
    fleet.setAvatar(personX, personZ, true)
    fleet.think(H, 0)
    step()
  }
  assert.ok(fleet.bouncer.counts[1] >= 1)
  assert.ok(Math.abs(fleet.speed(v)) < 0.05)
})

test('commands are sanitised, lastCommand is only a copy, and the brake overrides the throttle', async () => {
  const { fleet, step } = await rig()
  const v = pick(fleet, false)
  v.mode = 'player'
  place(fleet, step, v, TRACK_X, 0, Math.PI / 2)
  fleet.drive(v, { throttle: NaN, brake: NaN, steer: NaN }, false)
  assert.deepEqual({ ...v.lastCommand }, { throttle: 0, brake: 0, steer: 0 })
  fleet.drive(v, { throttle: Infinity, brake: -3, steer: -Infinity }, false)
  assert.deepEqual({ ...v.lastCommand }, { throttle: 1, brake: 0, steer: -CAR.maxSteer })
  fleet.drive(v, { throttle: -7, brake: 99, steer: 2 }, false)
  assert.deepEqual({ ...v.lastCommand }, { throttle: -1, brake: KERNEL.maxBrake, steer: CAR.maxSteer })

  // Writing the telemetry copy cannot reach the wheels.
  fleet.drive(v, { throttle: 0, brake: 0, steer: 0 }, false)
  v.lastCommand.throttle = 1
  step(60)
  assert.ok(Math.abs(fleet.speed(v)) < 0.05, `moved at ${fleet.speed(v).toFixed(2)} m/s`)
  assert.ok(Object.values(fleet.position(v)).every(Number.isFinite))

  // Throttle and brake together (both pedals): the brake wins, as it would alone.
  place(fleet, step, v, TRACK_X, 0, Math.PI / 2, 40 / 3.6)
  fleet.drive(v, { throttle: 0, brake: 0, steer: 0 }, false)
  step(2)
  const v0 = fleet.speed(v), x0 = fleet.position(v).x
  let frames = 0
  while (fleet.speed(v) > 0.05 && frames < 600) {
    fleet.drive(v, { throttle: 1, brake: KERNEL.maxBrake, steer: 0 }, false)
    step()
    frames++
  }
  assert.ok(fleet.position(v).x - x0 <= stoppingDistance(v0) + KERNEL.standoff, `${(fleet.position(v).x - x0).toFixed(2)} m`)
})

test('the Second Law: a player driving at a wall keeps control (counted, not overruled)', async () => {
  const wallX = TRACK_X + 60
  const { fleet, step } = await rig(8, [[wallX, 0, -20, wallX + 2, 6, 20]])
  const v = pick(fleet, false)
  v.mode = 'player'
  place(fleet, step, v, TRACK_X, 0, Math.PI / 2, 12)
  let overruled = false
  for (let t = 0; t < 3 && fleet.bouncer.counts[2] === 0; t += H) {
    fleet.drive(v, { throttle: 1, brake: 0, steer: 0 }, false)
    if (v.lastCommand.throttle !== 1) overruled = true
    step()
  }
  assert.equal(fleet.bouncer.counts[2], 1)
  assert.equal(overruled, false)
  assert.equal(v.lastCommand.throttle, 1)
})

test('operator tuning is clamped so grip and brakes can only strengthen the stopping envelope', async () => {
  const physics = await Physics.create([], { lamps: [], trees: [], signals: [] })
  const fleet = new Fleet(physics, 3, SEED, { exposeRig: true })
  assert.deepEqual(fleet.tuning, { power: 1, drag: 1, grip: 1, brake: 1 })
  // Weakening is refused: the lower bound of grip and brake is the authored car.
  assert.equal(fleet.setTuning('grip', 0.5), 1)
  assert.equal(fleet.setTuning('brake', 0.2), 1)
  assert.equal(CAR_TUNE_RANGE.grip[0], 1)
  assert.equal(CAR_TUNE_RANGE.brake[0], 1)
  // Every key clamps into its range, and a non-finite value resets to 1.
  for (const key of Object.keys(CAR_TUNE_RANGE) as (keyof typeof CAR_TUNE_RANGE)[]) {
    const [lo, hi] = CAR_TUNE_RANGE[key]
    assert.equal(fleet.setTuning(key, -99), lo, `${key} low`)
    assert.equal(fleet.setTuning(key, 99), hi, `${key} high`)
    assert.equal(fleet.setTuning(key, Number.NaN), 1, `${key} NaN`)
    assert.equal(fleet.tuning[key], 1)
  }
  // Grip reaches the wheels at once.
  const set = fleet.setTuning('grip', 1.25)
  assert.equal(set, 1.25)
  const c = fleet.rig(fleet.vehicles[1]).controller as unknown as { wheelFrictionSlip?: (i: number) => number | null }
  if (typeof c.wheelFrictionSlip === 'function') {
    for (let w = 0; w < 4; w++) assert.ok(Math.abs((c.wheelFrictionSlip(w) ?? 0) - 1.25) < 1e-6, `wheel ${w} friction`)
  }
})

test('runtime isolation: no Rapier handle leaves the Fleet, and the vetted path cannot be replaced', async () => {
  const physics = await Physics.create([], NO_FURNITURE)
  const fleet = new Fleet(physics, 3, SEED)
  const v = fleet.vehicles[0]
  const handle = (x: unknown) => x instanceof RAPIER.RigidBody || x instanceof RAPIER.Collider || x instanceof RAPIER.DynamicRayCastVehicleController
  const reaches = (root: unknown, seen = new Set<unknown>()): boolean => {
    if (root === null || typeof root !== 'object' || seen.has(root)) return false
    seen.add(root)
    return handle(root) || Object.values(root).some((x) => reaches(x, seen))
  }
  // Nothing enumerable on the fleet, its vehicles or its footprints leads to a Rapier handle.
  for (const car of fleet.vehicles) assert.equal(reaches(car), false, `vehicle ${car.index} carries a handle`)
  assert.equal(reaches(fleet.footprints()), false)
  assert.deepEqual(Object.keys(fleet).sort(), ['bouncer', 'paint', 'vehicles'], 'only the public surface is visible')
  assert.ok(Object.isFrozen(fleet.paint))
  assert.equal((fleet as unknown as Record<string, unknown>).rigs, undefined)
  assert.equal((fleet as unknown as Record<string, unknown>).commands, undefined)
  assert.throws(() => fleet.rig(v), /private to the Fleet/)

  // Accessors hand out copies: writing to one changes nothing in the world.
  const p = fleet.position(v), q = fleet.rotation(v), u = fleet.velocity(v)
  p.x = 1e9; q.w = 0; u.x = 1e9
  assert.notEqual(fleet.position(v).x, 1e9)
  assert.notEqual(fleet.rotation(v).w, 0)
  assert.notEqual(fleet.velocity(v).x, 1e9)
  const t = fleet.tuning
  assert.ok(Object.isFrozen(t))
  assert.throws(() => { (t as { grip: number }).grip = 0.1 }, TypeError)
  assert.equal(fleet.tuning.grip, 1)

  // The vetted path is sealed: the instance, its vehicle list, the class, the prototype and the bouncer.
  for (const o of [fleet, fleet.vehicles, Fleet, Fleet.prototype, fleet.bouncer, Bouncer, Bouncer.prototype]) assert.ok(Object.isFrozen(o))
  const loose = fleet as unknown as Record<string, unknown>
  assert.throws(() => { loose.think = () => {} }, TypeError)
  assert.throws(() => { loose.bouncer = new Bouncer() }, TypeError)
  assert.throws(() => { (Fleet.prototype as unknown as Record<string, unknown>).drive = () => {} }, TypeError)
  assert.throws(() => { (fleet.bouncer as unknown as Record<string, unknown>).vet = (_: number, i: unknown) => i }, TypeError)
  assert.throws(() => { (Bouncer.prototype as unknown as Record<string, unknown>).vet = (_: number, i: unknown) => i }, TypeError)
  assert.throws(() => { (fleet.vehicles as Vehicle[]).push(v) }, TypeError)
  assert.throws(() => { (v as { index: number }).index = 1 }, TypeError)
  assert.equal(v.index, 0)
  assert.throws(() => { (fleet.bouncer.counts as Record<number, number>)[1] = 99 }, TypeError)
  assert.equal(fleet.bouncer.counts[1], 0)
})

test('clampSpeed only ever slows a chassis, and keeps its direction', async () => {
  const physics = await Physics.create([], NO_FURNITURE)
  const fleet = new Fleet(physics, 1, SEED, { exposeRig: true })
  const v = fleet.vehicles[0]
  const body = fleet.rig(v).body
  body.setLinvel({ x: 60, y: 0, z: -45 }, true)
  assert.equal(fleet.clampSpeed(v, 50), true)
  const u = fleet.velocity(v)
  assert.ok(Math.abs(Math.hypot(u.x, u.y, u.z) - 50) < 1e-3)
  assert.ok(Math.abs(u.x / u.z - 60 / -45) < 1e-6, 'direction kept')
  assert.equal(fleet.clampSpeed(v, 50), false, 'already at the cap')
  body.setLinvel({ x: 10, y: 0, z: 0 }, true)
  for (const max of [50, Number.NaN, -1]) assert.equal(fleet.clampSpeed(v, max), false, `max ${max}`)
  assert.equal(fleet.velocity(v).x, 10)
})

test('a fleet on tracks spawns in headway seats on the lanes and follows its rings without the First or Third Law', async () => {
  const physics = await Physics.create([], NO_FURNITURE)
  const network = buildTrackNetwork(SEED)
  const fleet = new Fleet(physics, 12, SEED, { exposeRig: true, network })
  const trackOf = (v: Vehicle) => network.tracks[(v.driver as TrackDriver).track]
  // Seated: every car on a car ring, on the carriageway, exactly laneOffset from a street centreline, on a straight.
  const seen = new Set<string>()
  for (const v of fleet.vehicles) {
    assert.ok(v.driver instanceof TrackDriver)
    const track = trackOf(v)
    assert.equal(track.kind, 'car')
    const t = fleet.position(v)
    assert.ok(onRoad(t.x, t.z), `car ${v.index} off the carriageway`)
    const off = [t.x - Math.round(t.x / CITY.pitch) * CITY.pitch, t.z - Math.round(t.z / CITY.pitch) * CITY.pitch]
    const along = Math.abs(Math.sin(fleet.heading(v))) > 0.5 ? off[1] : off[0]
    assert.ok(Math.abs(Math.abs(along) - TRAFFIC.laneOffset) < 1e-3, `car ${v.index}: ${along} m from its centreline`)
    const seat = `${track.id}:${(v.driver as TrackDriver).progress.toFixed(1)}`
    assert.ok(!seen.has(seat), `two cars in seat ${seat}`)
    seen.add(seat)
  }
  const seatOf = fleet.vehicles.map((v) => (v.driver as TrackDriver).progress)
  // 30 s of think + step on the flat city: the fleet drives its rings.
  let maxLateral = 0, minGap = Infinity, maxSpeed = 0
  const gapsOf = () => {
    const byTrack = new Map<number, Vehicle[]>()
    for (const v of fleet.vehicles) byTrack.set(trackOf(v).id, [...(byTrack.get(trackOf(v).id) ?? []), v])
    for (const [id, cars] of byTrack) {
      if (cars.length < 2) continue
      const s = Float64Array.from(cars.map((v) => (v.driver as TrackDriver).progress).sort((a, b) => a - b))
      for (const g of ringGaps(s, network.tracks[id].length, 2 * CAR.halfLength)) minGap = Math.min(minGap, g)
    }
  }
  for (let frame = 0; frame < 30 * 60; frame++) {
    fleet.think(H, frame * H)
    physics.step(H, (h) => fleet.updateControllers(h))
    if (frame % 10 !== 0) continue
    gapsOf()
    for (const v of fleet.vehicles) {
      const t = fleet.position(v)
      const d = v.driver as TrackDriver
      maxLateral = Math.max(maxLateral, Math.abs(projectOnto(trackOf(v), t.x, t.z, d.progress).lateral))
      maxSpeed = Math.max(maxSpeed, fleet.speed(v))
      assert.equal(d.rejoining, false, `car ${v.index} lost its track`)
    }
  }
  assert.equal(fleet.bouncer.counts[1], 0, 'no First-Law intervention: nobody is in the city')
  assert.equal(fleet.bouncer.counts[3], 0, 'no Third-Law ruling: the rays skip the cars on rings and the ring gap keeps the envelope')
  assert.ok(maxLateral < 0.8, `a car drifted ${maxLateral.toFixed(2)} m off its ring`)
  assert.ok(minGap >= 1, `a ring gap fell to ${minGap.toFixed(2)} m`)
  assert.ok(maxSpeed > 5 && maxSpeed <= TRAFFIC.speedLimit + 0.5, `max speed ${maxSpeed.toFixed(2)}`)
  for (const v of fleet.vehicles) {
    const track = trackOf(v), d = v.driver as TrackDriver
    const gained = ((d.progress - seatOf[v.index]) % track.length + track.length) % track.length
    assert.ok(gained >= 5, `car ${v.index} moved only ${gained.toFixed(1)} m along its ring in 30 s`)
    assert.ok(v.mode === 'ai' && d.stuckSeconds < 8)
  }
  // The public surface is unchanged: the network and the ring order live behind private fields.
  assert.deepEqual(Object.keys(fleet).sort(), ['bouncer', 'paint', 'vehicles'])
  const handle = (x: unknown) => x instanceof RAPIER.RigidBody || x instanceof RAPIER.Collider || x instanceof RAPIER.DynamicRayCastVehicleController
  const reaches = (root: unknown, seen = new Set<unknown>()): boolean => {
    if (root === null || typeof root !== 'object' || seen.has(root)) return false
    seen.add(root)
    return handle(root) || Object.values(root).some((x) => reaches(x, seen))
  }
  for (const car of fleet.vehicles) {
    assert.equal(reaches(car), false, `vehicle ${car.index} carries a handle`)
    assert.deepEqual(Object.keys(car.driver), ['stuckSeconds', 'ringGap'], 'a track driver shows no track: it is ES-private')
  }
  assert.equal(TRACKS.car.headway, 8)
})

test('a fleet on tracks: the rays of a car on a ring skip the cars on rings, still see a wall and a player\'s car; a random fleet is untouched', async () => {
  const wall: Box = [TRACK_X - 1, 0, 20, TRACK_X + 1, 3, 22]
  const physics = await Physics.create([wall], NO_FURNITURE)
  const network = buildTrackNetwork(SEED)
  const fleet = new Fleet(physics, 3, SEED, { exposeRig: true, network })
  const [a, b, c] = fleet.vehicles
  /** A track driver that remembers the gap the Fleet fed it. */
  class Spy extends TrackDriver {
    fed = Infinity
    command(p: Parameters<TrackDriver['command']>[0], signalSeconds: number, gap: number, dt: number, personAhead?: number) {
      this.fed = gap
      return super.command(p, signalSeconds, gap, dt, personAhead)
    }
  }
  const spy = new Spy(network.tracks[(a.driver as TrackDriver).track], (a.driver as TrackDriver).progress, createRng(1))
  a.driver = spy
  // a at the origin of the open ground heading +z; b, a car of the fleet, parked 10 m ahead of it; the wall 20 m on (inside the rays' 22 m reach);
  // c driven by the player far away (so it is in no ring's order).
  fleet.recover(a, TRACK_X, 0, 0)
  fleet.recover(b, TRACK_X, 10, 0)
  fleet.recover(c, TRACK_X + 100, 0, 0)
  b.mode = 'parked'
  c.mode = 'player'
  for (let k = 0; k < 60; k++) physics.step(H, (h) => fleet.updateControllers(h))
  const toCar = 10 - 2 * CAR.halfLength - 0.1, toWall = 20 - CAR.halfLength - 0.1
  // The public rays (what a player's car reads) see the parked car ahead ...
  assert.ok(Math.abs(fleet.gapAhead(a) - toCar) < 0.3, `gapAhead ${fleet.gapAhead(a).toFixed(2)}`)
  // ... while the track driver is fed the least of the rays filtered of the cars on rings (the wall) and its ring gap
  // (alone: Infinity; the parked car stands off its ring, so the ring's order leaves it out).
  fleet.think(H, 1)
  assert.ok(Math.abs(spy.fed - toWall) < 0.3, `the track driver was fed ${spy.fed.toFixed(2)} m: the wall, not the parked car on a ring`)
  assert.equal(fleet.bouncer.counts[3], 0)
  // A player's car is not on a ring: the rays are its backstop.
  b.mode = 'player'
  fleet.think(H, 1)
  assert.ok(Math.abs(spy.fed - toCar) < 0.3, `fed ${spy.fed.toFixed(2)} m with the player's car ahead`)

  // Without a network the fleet is what it always was: Drivers on random lane seats, the same for the same seed.
  const plain = await Physics.create([], NO_FURNITURE)
  const random = new Fleet(plain, 8, SEED)
  const again = new Fleet(await Physics.create([], NO_FURNITURE), 8, SEED)
  for (const v of random.vehicles) {
    assert.ok(v.driver instanceof Driver && !(v.driver instanceof TrackDriver))
    const p = random.position(v), q = again.position(again.vehicles[v.index])
    assert.deepEqual(p, q)
    assert.ok(onRoad(p.x, p.z))
    assert.equal(random.paint[v.index], again.paint[v.index])
  }
  assert.equal(poseAt(network.tracks[0], 0).y, 0)
})

test('a fleet on tracks: a car set down off its ring leaves the ring\'s order while it steers back, so nobody queues behind its projection', async () => {
  const physics = await Physics.create([], NO_FURNITURE)
  const network = buildTrackNetwork(SEED)
  const fleet = new Fleet(physics, 2, SEED, { exposeRig: true, network })
  const [a, b] = fleet.vehicles
  /** A track driver that remembers the gap the Fleet fed it. */
  class Spy extends TrackDriver {
    fed = Infinity
    command(p: Parameters<TrackDriver['command']>[0], signalSeconds: number, gap: number, dt: number, personAhead?: number) {
      this.fed = gap
      return super.command(p, signalSeconds, gap, dt, personAhead)
    }
  }
  // Both on ring 0: a at a seat, b 30 m ahead of it on the same lane.
  const track = network.tracks[0]
  const sA = 20, sB = sA + 30
  const pA = poseAt(track, sA), pB = poseAt(track, sB)
  const spy = new Spy(track, sA, createRng(1))
  a.driver = spy
  b.driver = new TrackDriver(track, sB, createRng(2))
  fleet.recover(a, pA.x, pA.z, pA.heading)
  fleet.recover(b, pB.x, pB.z, pB.heading)
  for (let k = 0; k < 60; k++) physics.step(H, (h) => fleet.updateControllers(h))
  fleet.think(H, 1)
  const ringGap = 30 - 2 * CAR.halfLength
  assert.ok(Math.abs(spy.fed - ringGap) < 0.5, `fed ${spy.fed.toFixed(2)} m with b 30 m ahead on the ring`)
  // b is set down 40 m to the right of its lane (open ground beside the grid), still an AI car of ring 0.
  const q = poseAt(track, sB)
  fleet.recover(b, q.x - q.tangentZ * 40, q.z + q.tangentX * 40, q.heading)
  for (let k = 0; k < 60; k++) physics.step(H, (h) => fleet.updateControllers(h))
  fleet.think(H, 1)
  assert.equal((b.driver as TrackDriver).rejoining, true, 'b noticed it is off its ring')
  // From the next frame b is out of the ring's order: a's ring gap is Infinity and its rays (which skip the cars on
  // rings) find nothing, so a is fed a clear road, not a queue behind a car that is not there.
  fleet.think(H, 1)
  assert.equal(spy.fed, Infinity, `a was fed ${spy.fed.toFixed(2)} m behind b's projection while b stands 40 m off the ring`)
  assert.equal((b.driver as TrackDriver).ringGap, Infinity)
  assert.equal(fleet.bouncer.counts[3], 0)
})
