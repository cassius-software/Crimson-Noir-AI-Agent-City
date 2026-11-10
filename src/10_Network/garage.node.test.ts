// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the room's garage (garage.node.ts) is the authority a car needs: the page's own
 * physics realm (SimCore, as the worker runs it: the seed's city and its fleet on the track network, the player in a
 * network room) and the garage, fed what the page reports (the car's state the moment the player took its wheel, then
 * each step's vetted wheel command and substeps), agree on the car to the bit, through frames of 0 to 3 substeps, a
 * departure, a walk, a return to the parked car and a second drive. It pins every door rule (the door's reach, the
 * car's ring and lane, its heading, speed, height and spin, a parked car's spot, the exit point), measures again the
 * lane envelope the fleet keeps, and shows the plan the garage reads is the one the fleet is built from.
 * What breaks if it is removed? The room could replay a car the page does not have, refuse honest drivers, or let a
 * client claim a car where none is, unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateCity, streetFurniture } from '../01_Initialize_World/city.ts'
import { cornerAhead, projectOnto, tangentAt } from '../06_Make_Decisions/tracks.ts'
import { exitPoint, headingOf, planFleet } from '../07_Execute_Actions/carRig.ts'
import { Physics } from '../07_Execute_Actions/physics.ts'
import { SimCore } from '../07_Execute_Actions/simCore.ts'
import { ENTER_RANGE, POSE, type CarBodyState, type SimEvent, type StepState } from '../07_Execute_Actions/simProtocol.ts'
import { Fleet } from '../07_Execute_Actions/vehicles.ts'
import { Garage, GARAGE, motionOf, type CarState, type DriveRun } from './garage.node.ts'

const SEED = 1337
const CARS = 36
const STILL = { x: 0, z: 0, heading: 0 }
const IDLE = { steer: 0, fwd: 0, back: 0, handbrake: false }

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
}

let garage: Garage | null = null
async function theGarage(): Promise<Garage> {
  await Physics.create([], { lamps: [], trees: [], signals: [] })
  garage ??= new Garage(SEED, CARS)
  return garage
}

/** The page: the realm in a network room, and a step that returns the state with its events. */
async function page() {
  const sim = await SimCore.create({ seed: SEED, cars: CARS, agents: 256, boxes: generateCity(SEED), furniture: streetFurniture(SEED), spawn: { x: 345.8, z: 332 }, debug: false, tracks: true }, null)
  const poses = new Float32Array(sim.meta.count * POSE.stride)
  const step = (o: { dt?: number; foot?: { x: number; z: number; heading: number }; drive?: typeof IDLE; cmds?: unknown[] } = {}): StepState => {
    const st = sim.step({ dt: o.dt ?? 1 / 60, foot: o.foot ?? STILL, drive: o.drive ?? IDLE, cmds: o.cmds ?? [] }, poses)
    return { ...st, t: 'state', id: 0 }
  }
  step({ cmds: [{ c: 'room', on: true }] })
  return { sim, poses, step }
}

const chassisOf = (poses: Float32Array, i: number) => ({ x: poses[i * POSE.stride + POSE.x], y: poses[i * POSE.stride + POSE.y], z: poses[i * POSE.stride + POSE.z] })
const entered = (st: StepState) => st.events.find((e): e is Extract<SimEvent, { e: 'entered' }> => e.e === 'entered' && e.player === 0)
const exited = (st: StepState) => st.events.find((e): e is Extract<SimEvent, { e: 'exited' }> => e.e === 'exited' && e.player === 0)

test('the garage reads the fleet\'s own plan: every car\'s ring and SUV flag, from the seed and the fleet size alone', async () => {
  const g = await theGarage()
  const p = await Physics.create([], { lamps: [], trees: [], signals: [] })
  const fleet = new Fleet(p, CARS, SEED, { network: g.network, bays: { boxes: generateCity(SEED) } })
  assert.equal(g.plan.length, CARS)
  assert.ok(g.plan.filter((c) => c.bay).length >= 8, 'the parked share is in its bays')
  for (let i = 0; i < CARS; i++) {
    assert.equal(g.plan[i].suv, fleet.vehicles[i].suv, `car ${i}`)
    assert.equal(g.plan[i].bay, fleet.vehicles[i].bay !== null, `car ${i}: the same bays`)
    assert.equal(fleet.vehicles[i].mode, g.plan[i].bay ? 'parked' : 'ai', `car ${i}: parked in its bay, driven on its ring`)
    assert.ok(g.plan[i].track >= 0 && g.network.tracks[g.plan[i].track].kind === 'car', `car ${i} is seated on a car ring`)
    const at = fleet.position(fleet.vehicles[i])
    assert.ok(Math.abs(at.x - g.plan[i].pose.x) < 1e-3 && Math.abs(at.z - g.plan[i].pose.z) < 1e-3, `car ${i} starts at its seat`)
  }
  assert.deepEqual(planFleet(CARS, SEED, g.network).cars.map((c) => c.paint), [...fleet.paint], 'the same stream, in the same order')
})

test('a car replayed in the garage is the page\'s car to the bit: taking the wheel, 0–3 substeps a frame, leaving, returning, driving again', async () => {
  const g = new Garage(SEED, CARS)
  g.join(1)
  const { step, poses } = await page()
  const r = rng(5)
  // Let the traffic run, then stand 2.5 m beside a parked car in its bay (on its road side) and take its wheel.
  for (let k = 0; k < 120; k++) step()
  const i = g.plan.findIndex((c) => c.bay)
  const c = chassisOf(poses, i), h = poses[i * POSE.stride + POSE.heading]
  const at = { x: c.x + Math.cos(h) * 2.5, z: c.z - Math.sin(h) * 2.5 }
  const st0 = step({ cmds: [{ c: 'teleport', ...at }, { c: 'interact' }] })
  const e = entered(st0)
  assert.ok(e && e.index === i, `took car ${i}'s wheel`)
  assert.equal(st0.driving, i)
  // The door: the room has the player where the page teleported them; the claim is the car's state at the wheel.
  assert.equal(g.whyNotEnter(1, at, i, e.state), null)
  g.enter(1, i, e.state)
  // A step takes its door first, then its substeps: the frame the wheel was taken in already drove the car.
  const run = (st: StepState): DriveRun => [st.wheels!.throttle, st.wheels!.brake, st.wheels!.steer, st.wheels!.handbrake ? 1 : 0, st.physics.steps]
  let worst = 0, frames = 0
  const near = (st: StepState): void => {
    const s = g.drive(1, [run(st)])
    const p = chassisOf(poses, st.driving)
    worst = Math.max(worst, Math.hypot(s.x - p.x, s.y - p.y, s.z - p.z))
    frames++
  }
  near(st0)
  const drive = (n: number): void => {
    for (let k = 0; k < n; k++) {
      const dt = [1 / 144, 1 / 60, 2 / 60, 0.05][Math.floor(r() * 4)]
      const control = { steer: (r() - 0.5) * 2, fwd: r() < 0.8 ? r() : 0, back: r() < 0.1 ? r() : 0, handbrake: r() < 0.03 }
      near(step({ dt, drive: control }))
    }
  }
  drive(600)
  assert.equal(worst, 0, `the garage and the page differ by ${worst} m`)
  // Leave: the realm's exit point is the garage's, from the same chassis.
  const expect = g.exitPoint(1)!
  const stx = step({ cmds: [{ c: 'interact' }] })
  const x = exited(stx)!
  assert.ok(x, 'left the car')
  assert.equal(Math.hypot(x.x - expect.x, x.z - expect.z), 0, 'the exit point, to the bit')
  g.park(1)
  const left = g.parkedAt(1, i)!
  assert.deepEqual([left.vx, left.vy, left.vz, left.wx, left.wy, left.wz], [0, 0, 0, 0, 0, 0], 'a car left in a room stops where it is')
  assert.equal(g.driving(1), -1)
  // Walk around it for a while; it stays where it was left.
  for (let k = 0; k < 90; k++) step({ foot: { x: 1, z: 0.5, heading: 0 } })
  const back = chassisOf(poses, i)
  assert.ok(Math.hypot(back.x - left.x, back.z - left.z) < 0.01, 'the parked car has not moved on the page')
  // Back into it: within the door of the player (the page puts them beside it), within 0.5 m of where it was left.
  const at2 = { x: back.x + 1.5, z: back.z }
  const st2 = step({ cmds: [{ c: 'teleport', ...at2 }, { c: 'interact' }] })
  const e2 = entered(st2)!
  assert.equal(e2.index, i)
  assert.equal(g.whyNotEnter(1, at2, i, e2.state), null)
  g.enter(1, i, e2.state)
  worst = 0
  near(st2)
  drive(600)
  assert.equal(worst, 0, `after the return the garage and the page differ by ${worst} m`)
  assert.ok(frames >= 1200)
  assert.equal(g.worlds, 1, 'one drive world for the player')
  g.leave(1)
  assert.equal(g.worlds, 0)
})

test('the door rules: reach, a parked car in its bay at rest, upright, at a car\'s height; a car in traffic is nobody\'s; the fleet\'s bounds', async () => {
  const g = await theGarage()
  g.join(7)
  // A car in traffic, honestly on its lane at its ring's speed: it has a driver, and the door is refused.
  const lane = g.plan.findIndex((c) => !c.bay)
  const car = g.plan[lane]
  const track = g.network.tracks[car.track]
  const t = tangentAt(track, projectOnto(track, car.pose.x, car.pose.z).s)
  const yaw = car.pose.heading - Math.PI / 2
  const moving: CarState = { x: car.pose.x, y: 0.56, z: car.pose.z, qx: 0, qy: Math.sin(yaw / 2), qz: 0, qw: Math.cos(yaw / 2), vx: t[0] * 8, vy: 0, vz: t[1] * 8, wx: 0, wy: 0, wz: 0 }
  assert.match(g.whyNotEnter(7, { x: car.pose.x + 2, z: car.pose.z }, lane, moving) ?? '', /has a driver/, 'a car in traffic is not taken from its driver')
  // A bay car (parking.ts): parked where the seed put it, at rest, facing along its lane; the player on its road side.
  const b = g.plan.findIndex((c) => c.bay)
  const bay = g.plan[b]
  const byaw = bay.pose.heading - Math.PI / 2
  const ok: CarState = { x: bay.pose.x, y: 0.56, z: bay.pose.z, qx: 0, qy: Math.sin(byaw / 2), qz: 0, qw: Math.cos(byaw / 2), vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 }
  assert.ok(Math.abs(headingOf({ x: ok.qx, y: ok.qy, z: ok.qz, w: ok.qw }) - bay.pose.heading) < 1e-9)
  const at = { x: bay.pose.x + Math.cos(bay.pose.heading) * 2, z: bay.pose.z - Math.sin(bay.pose.heading) * 2 }
  assert.equal(g.whyNotEnter(7, at, b, ok), null, 'a parked car in its bay, at rest, in reach')
  const why = (o: Partial<CarState>, where = at, index = b) => g.whyNotEnter(7, where, index, { ...ok, ...o })
  assert.match(why({}, { x: at.x + ENTER_RANGE, z: at.z }) ?? '', /from the room's pose/)
  assert.match(why({}, at, CARS) ?? '', /no car 36/)
  assert.match(why({}, at, -1) ?? '', /no car -1/)
  assert.match(why({}, at, 1.5) ?? '', /no car 1.5/)
  // Another bay car's index for this bay's state: its bay is elsewhere.
  const other = g.plan.findIndex((c, k) => c.bay && k !== b)
  assert.match(why({}, at, other) ?? '', /from its bay/)
  // Out of its bay by more than the door; settled within it.
  const f = [Math.sin(bay.pose.heading), Math.cos(bay.pose.heading)]
  assert.match(why({ x: ok.x + f[0] * 0.6, z: ok.z + f[1] * 0.6 }, { x: at.x + f[0] * 0.6, z: at.z + f[1] * 0.6 }) ?? '', /0\.60 m from its bay/)
  assert.equal(why({ x: ok.x + f[0] * 0.4, z: ok.z + f[1] * 0.4 }, { x: at.x + f[0] * 0.4, z: at.z + f[1] * 0.4 }), null, 'within the door')
  // Turned, moving, spinning, in the air, on its side, malformed: refused. Settled on its springs: let through.
  assert.match(why({ qy: Math.sin((byaw + 0.3) / 2), qw: Math.cos((byaw + 0.3) / 2) }) ?? '', /turned 0\.30 rad in its bay/)
  assert.equal(why({ qy: Math.sin((byaw + 0.03) / 2), qw: Math.cos((byaw + 0.03) / 2) }), null, 'settled a hair')
  assert.match(why({ vx: f[0] * 8, vz: f[1] * 8 }) ?? '', /stands parked in its bay, not moving \(8\.00 m\/s/)
  assert.match(why({ vy: 12 }) ?? '', /not moving \(12\.00 m\/s/)
  assert.match(why({ wy: 5 }) ?? '', /not moving \(0\.00 m\/s, 5\.00 rad\/s\)/)
  assert.equal(why({ vy: -0.09, wz: 0.1, y: 0.548 }), null, 'settling onto its springs')
  assert.match(why({ y: 3 }) ?? '', /height/)
  assert.match(why({ y: 1.2 }) ?? '', /height/, 'a chassis held 0.6 m off the street')
  assert.match(why({ qx: 0.5, qy: 0, qz: 0, qw: Math.sqrt(0.75) }) ?? '', /upright/)
  assert.match(why({ x: Number.NaN }) ?? '', /the car state/)
  assert.match(why({ qw: 2 }) ?? '', /the car state/)
  g.leave(7)
})

test('a car the room holds is checked against where it was left; an exit is checked against the realm\'s rule', async () => {
  const g = await theGarage()
  g.join(8)
  // The plan's second bay car, taken from its bay (the only kind of car the door opens on).
  const i = g.plan.map((c, k) => (c.bay ? k : -1)).filter((k) => k >= 0)[1]
  const car = g.plan[i]
  const yaw = car.pose.heading - Math.PI / 2
  const s: CarBodyState = { x: car.pose.x, y: 0.56, z: car.pose.z, qx: 0, qy: Math.sin(yaw / 2), qz: 0, qw: Math.cos(yaw / 2), vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 }
  const at = { x: car.pose.x + 1, z: car.pose.z }
  assert.equal(g.whyNotEnter(8, at, i, s), null)
  g.enter(8, i, s)
  assert.match(g.whyNotEnter(8, at, 3, s) ?? '', /already at a wheel/)
  g.drive(8, [[0.6, 0, 0.1, 0, 60]])
  const chassis = g.chassis(8)!
  assert.deepEqual(g.exitPoint(8), exitPoint(chassis.x, chassis.z, headingOf({ x: chassis.qx, y: chassis.qy, z: chassis.qz, w: chassis.qw })))
  g.park(8)
  const held = g.parkedAt(8, i)!
  assert.ok(Math.hypot(held.x - s.x, held.z - s.z) > 1, 'it drove somewhere first')
  const near = { x: held.x + 1, z: held.z }
  assert.equal(g.whyNotEnter(8, near, i, { ...held, x: held.x + 0.4 }), null, 'within 0.5 m of where it was left')
  assert.match(g.whyNotEnter(8, near, i, { ...held, x: held.x + 0.6 }) ?? '', /0\.60 m from where it was left/)
  // Where it was left, but not as it was left (found by the Phase 13 review: only the position was checked, so a car
  // left at rest could be taken back moving at 36 m/s, 30 of them upward, and the room's replay put it on a roof).
  const yawBy = (q: CarBodyState, a: number): CarBodyState => {
    const h = { x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) }
    return { ...q, qx: h.w * q.qx + h.x * q.qw + h.y * q.qz - h.z * q.qy, qy: h.w * q.qy - h.x * q.qz + h.y * q.qw + h.z * q.qx, qz: h.w * q.qz + h.x * q.qy - h.y * q.qx + h.z * q.qw, qw: h.w * q.qw - h.x * q.qx - h.y * q.qy - h.z * q.qz }
  }
  assert.match(g.whyNotEnter(8, near, i, { ...held, vx: 20, vy: 30 }) ?? '', /was left at rest, not moving \(36\.06 m\/s/)
  assert.match(g.whyNotEnter(8, near, i, { ...held, wy: 2 }) ?? '', /was left at rest, not moving/)
  assert.match(g.whyNotEnter(8, near, i, yawBy(held, 0.3)) ?? '', /turned 0\.30 rad from how it was left/)
  // A car settled on its springs since: a little lower, a little turned, barely moving.
  assert.equal(g.whyNotEnter(8, near, i, { ...yawBy(held, 0.03), y: held.y - 0.012, vy: -0.09, wz: 0.1 }), null)
  assert.match(g.whyNotEnter(8, near, i, { ...s, x: car.pose.x }) ?? '', /from where it was left|from the room's pose/, 'not in its bay any more: where it was left')
  g.leave(8)
})

test('the lane envelope: the fleet\'s own cars keep their lanes, upright and at a car\'s height; the bay cars never leave their bays', async () => {
  const g = await theGarage()
  const p = await Physics.create(generateCity(SEED), streetFurniture(SEED))
  const fleet = new Fleet(p, CARS, SEED, { network: g.network, exposeRig: true, bays: { boxes: generateCity(SEED) } })
  let clock = 0, lat = 0, dh = 0, over = 0
  /** The most lateral on a straight and in a corner (cornerAhead 0), every frame: a cut lasts only a few frames. */
  const lane = { straight: 0, corner: 0 }
  const most = { up: 1, low: Infinity, high: -Infinity }
  /** What the room asks of a bay car at its door, read every frame: in its bay, facing as laid out, at rest. */
  const bays = { off: 0, turned: 0, speed: 0, cars: 0 }
  for (let k = 0; k < 1800; k++) {
    clock += 1 / 60
    fleet.think(1 / 60, clock)
    p.step(1 / 60, (h) => fleet.updateControllers(h))
    for (let i = 0; i < CARS; i++) {
      const v = fleet.vehicles[i], track = g.network.tracks[g.plan[i].track]
      const at = fleet.position(v)
      const m = motionOf(fleet.bodyState(v))
      most.up = Math.min(most.up, m.up)
      const y = fleet.bodyState(v).y
      most.low = Math.min(most.low, y)
      most.high = Math.max(most.high, y)
      if (v.bay) {
        if (k === 0) bays.cars++
        bays.off = Math.max(bays.off, Math.hypot(at.x - v.bay.x, at.z - v.bay.z))
        let d = fleet.heading(v) - v.bay.heading
        d = Math.atan2(Math.sin(d), Math.cos(d))
        bays.turned = Math.max(bays.turned, Math.abs(d))
        bays.speed = Math.max(bays.speed, Math.abs(fleet.speed(v)))
        continue
      }
      const pr = projectOnto(track, at.x, at.z)
      lat = Math.max(lat, Math.abs(pr.lateral))
      if (cornerAhead(track, pr.s) === 0) lane.corner = Math.max(lane.corner, Math.abs(pr.lateral))
      else lane.straight = Math.max(lane.straight, Math.abs(pr.lateral))
      const tg = tangentAt(track, pr.s)
      let d = fleet.heading(v) - Math.atan2(tg[0], tg[1])
      d = Math.atan2(Math.sin(d), Math.cos(d))
      dh = Math.max(dh, Math.abs(d))
      if (Math.abs(fleet.speed(v)) > track.speedLimit + 0.5) over++
    }
  }
  // The lane the track followers hold, every frame (trackDriver.ts: pure pursuit with lateral feedback): never past
  // 0.78 m in a corner nor 0.53 m on a straight (measured: 0.58 and 0.18).
  assert.ok(lane.corner < 0.78, `${lane.corner.toFixed(3)} m off the lane in a corner`)
  assert.ok(lane.straight < 0.53, `${lane.straight.toFixed(3)} m off the lane on a straight`)
  assert.ok(lat > 0.3, 'corners are cut: the envelope is not slack for nothing')
  assert.ok(dh < 0.5, `heading ${dh.toFixed(3)} rad`)
  assert.equal(over, 0)
  assert.ok(most.up >= GARAGE.upright && most.low >= GARAGE.low && most.high <= GARAGE.high, JSON.stringify(most))
  // The bay cars: within a fifth of the door's bounds the whole half minute, with the traffic lapping past them, so a
  // player's claim of one as it stands is let through.
  assert.ok(bays.cars >= 8, `${bays.cars} bay cars`)
  assert.ok(bays.off < GARAGE.door / 5, `a bay car drifted ${bays.off.toFixed(3)} m`)
  assert.ok(bays.turned < GARAGE.heldTurn / 5, `a bay car turned ${bays.turned.toFixed(3)} rad`)
  assert.ok(bays.speed < GARAGE.heldSpeed / 5, `a bay car moved at ${bays.speed.toFixed(3)} m/s`)
})
