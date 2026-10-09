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
  const fleet = new Fleet(p, CARS, SEED, { network: g.network })
  assert.equal(g.plan.length, CARS)
  for (let i = 0; i < CARS; i++) {
    assert.equal(g.plan[i].suv, fleet.vehicles[i].suv, `car ${i}`)
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
  // Let the traffic run, then stand 2.5 m beside a car on its ring and take its wheel.
  for (let k = 0; k < 120; k++) step()
  const i = 3
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

test('the door rules: reach, the car\'s ring, lane, heading, speed, height, spin, a parked car\'s spot, the fleet\'s bounds', async () => {
  const g = await theGarage()
  g.join(7)
  const car = g.plan[0]
  const track = g.network.tracks[car.track]
  const t = tangentAt(track, projectOnto(track, car.pose.x, car.pose.z).s)
  const yaw = car.pose.heading - Math.PI / 2
  const ok: CarState = { x: car.pose.x, y: 0.56, z: car.pose.z, qx: 0, qy: Math.sin(yaw / 2), qz: 0, qw: Math.cos(yaw / 2), vx: t[0] * 8, vy: 0, vz: t[1] * 8, wx: 0, wy: 0, wz: 0 }
  assert.ok(Math.abs(headingOf({ x: ok.qx, y: ok.qy, z: ok.qz, w: ok.qw }) - car.pose.heading) < 1e-9)
  const at = { x: car.pose.x + 2, z: car.pose.z }
  assert.equal(g.whyNotEnter(7, at, 0, ok), null, 'a car on its lane, facing along it, at speed, upright, in reach')
  const why = (o: Partial<CarState>, where = at, index = 0) => g.whyNotEnter(7, where, index, { ...ok, ...o })
  assert.match(why({}, { x: at.x + ENTER_RANGE, z: at.z }) ?? '', /from the room's pose/)
  assert.match(why({}, at, CARS) ?? '', /no car 36/)
  assert.match(why({}, at, -1) ?? '', /no car -1/)
  assert.match(why({}, at, 1.5) ?? '', /no car 1.5/)
  // Another car's index claims this car's spot: its ring runs elsewhere.
  const other = g.plan.findIndex((c) => c.track !== car.track && Math.hypot(c.pose.x - car.pose.x, c.pose.z - car.pose.z) > 50)
  assert.match(why({}, at, other) ?? '', /off its ring's lane/)
  // Off the lane: a lateral step of the lane envelope and a little more.
  const n = [t[1], -t[0]]
  assert.match(why({ x: ok.x + n[0] * (GARAGE.lane + 0.05), z: ok.z + n[1] * (GARAGE.lane + 0.05) }, { x: at.x + n[0] * (GARAGE.lane + 0.05), z: at.z + n[1] * (GARAGE.lane + 0.05) }) ?? '', /off its ring's lane/)
  assert.equal(why({ x: ok.x + n[0] * (GARAGE.lane - 0.05), z: ok.z + n[1] * (GARAGE.lane - 0.05) }), null, 'inside the envelope')
  assert.match(why({ qy: Math.sin((yaw + 1) / 2), qw: Math.cos((yaw + 1) / 2) }) ?? '', /facing along its ring/)
  assert.match(why({ vx: t[0] * 20, vz: t[1] * 20 }) ?? '', /past its ring's/)
  assert.match(why({ y: 3 }) ?? '', /height/)
  assert.match(why({ y: 1.2 }) ?? '', /height/, 'a chassis held 0.6 m off the street')
  assert.match(why({ wy: 5 }) ?? '', /spinning/)
  // The whole state the room would adopt (found by the Phase 13 review: only the speed's size was checked, so a car could
  // be claimed moving upward and the room's own replay landed it on a roof).
  const f = [t[0], t[1]], side = [t[1], -t[0]]
  assert.match(why({ vx: f[0] * 5, vy: 10, vz: f[1] * 5 }) ?? '', /moving up at 10\.0 m\/s/)
  assert.match(why({ vy: -3 }) ?? '', /moving down at 3\.0 m\/s/)
  assert.equal(why({ vy: -0.74 }), null, 'settling onto its springs at the start')
  assert.match(why({ vx: f[0] * 6 + side[0] * 5, vz: f[1] * 6 + side[1] * 5 }) ?? '', /sliding sideways at 5\.0 m\/s/)
  assert.match(why({ vx: -f[0] * 3, vz: -f[1] * 3 }) ?? '', /reversing at 3\.0 m\/s/)
  assert.match(why({ wx: f[0] * 2, wz: f[1] * 2, wy: 0 }) ?? '', /pitching or rolling/, 'a roll rate past the fleet\'s')
  assert.match(why({ wx: side[0] * 2, wz: side[1] * 2, wy: 0 }) ?? '', /pitching or rolling/, 'a pitch rate past the fleet\'s')
  // The fleet's own extremes pass: an emergency stop's pitch, a corner's slip and yaw, the springs' bounce.
  assert.equal(why({ vx: f[0] * 9 + side[0] * 1.6, vy: -0.17, vz: f[1] * 9 + side[1] * 1.6, wy: 1.2, wx: side[0] * 0.3, wz: side[1] * 0.3 }), null)
  assert.match(why({ qx: 0.5, qy: 0, qz: 0, qw: Math.sqrt(0.75) }) ?? '', /upright/)
  assert.match(why({ x: Number.NaN }) ?? '', /the car state/)
  assert.match(why({ qw: 2 }) ?? '', /the car state/)
  g.leave(7)
})

test('a car the room holds is checked against where it was left; an exit is checked against the realm\'s rule', async () => {
  const g = await theGarage()
  g.join(8)
  const car = g.plan[2]
  const yaw = car.pose.heading - Math.PI / 2
  const s: CarBodyState = { x: car.pose.x, y: 0.56, z: car.pose.z, qx: 0, qy: Math.sin(yaw / 2), qz: 0, qw: Math.cos(yaw / 2), vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 }
  const at = { x: car.pose.x + 1, z: car.pose.z }
  assert.equal(g.whyNotEnter(8, at, 2, s), null)
  g.enter(8, 2, s)
  assert.match(g.whyNotEnter(8, at, 3, s) ?? '', /already at a wheel/)
  g.drive(8, [[0.6, 0, 0.1, 0, 60]])
  const chassis = g.chassis(8)!
  assert.deepEqual(g.exitPoint(8), exitPoint(chassis.x, chassis.z, headingOf({ x: chassis.qx, y: chassis.qy, z: chassis.qz, w: chassis.qw })))
  g.park(8)
  const held = g.parkedAt(8, 2)!
  assert.ok(Math.hypot(held.x - s.x, held.z - s.z) > 1, 'it drove somewhere first')
  const near = { x: held.x + 1, z: held.z }
  assert.equal(g.whyNotEnter(8, near, 2, { ...held, x: held.x + 0.4 }), null, 'within 0.5 m of where it was left')
  assert.match(g.whyNotEnter(8, near, 2, { ...held, x: held.x + 0.6 }) ?? '', /0\.60 m from where it was left/)
  // Where it was left, but not as it was left (found by the Phase 13 review: only the position was checked, so a car
  // left at rest could be taken back moving at 36 m/s, 30 of them upward, and the room's replay put it on a roof).
  const yawBy = (q: CarBodyState, a: number): CarBodyState => {
    const h = { x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) }
    return { ...q, qx: h.w * q.qx + h.x * q.qw + h.y * q.qz - h.z * q.qy, qy: h.w * q.qy - h.x * q.qz + h.y * q.qw + h.z * q.qx, qz: h.w * q.qz + h.x * q.qy - h.y * q.qx + h.z * q.qw, qw: h.w * q.qw - h.x * q.qx - h.y * q.qy - h.z * q.qz }
  }
  assert.match(g.whyNotEnter(8, near, 2, { ...held, vx: 20, vy: 30 }) ?? '', /was left at rest, not moving \(36\.06 m\/s/)
  assert.match(g.whyNotEnter(8, near, 2, { ...held, wy: 2 }) ?? '', /was left at rest, not moving/)
  assert.match(g.whyNotEnter(8, near, 2, yawBy(held, 0.3)) ?? '', /turned 0\.30 rad from how it was left/)
  // A car settled on its springs since: a little lower, a little turned, barely moving.
  assert.equal(g.whyNotEnter(8, near, 2, { ...yawBy(held, 0.03), y: held.y - 0.012, vy: -0.09, wz: 0.1 }), null)
  assert.match(g.whyNotEnter(8, near, 2, { ...s, x: car.pose.x }) ?? '', /from where it was left|from the room's pose/, 'not at its old seat any more')
  g.leave(8)
})

test('the lane envelope: the fleet\'s own cars stay within every door bound, in their lane, speed, heading and motion', async () => {
  const g = await theGarage()
  const p = await Physics.create(generateCity(SEED), streetFurniture(SEED))
  const fleet = new Fleet(p, CARS, SEED, { network: g.network, exposeRig: true })
  let clock = 0, lat = 0, dh = 0, over = 0
  /** The most lateral on a straight and in a corner (cornerAhead 0), every frame: a cut lasts only a few frames. */
  const lane = { straight: 0, corner: 0 }
  const most = { rise: 0, fall: 0, side: 0, back: 0, yaw: 0, tilt: 0, up: 1, low: Infinity, high: -Infinity }
  for (let k = 0; k < 1800; k++) {
    clock += 1 / 60
    fleet.think(1 / 60, clock)
    p.step(1 / 60, (h) => fleet.updateControllers(h))
    for (let i = 0; i < CARS; i++) {
      const v = fleet.vehicles[i], track = g.network.tracks[g.plan[i].track]
      const at = fleet.position(v)
      const pr = projectOnto(track, at.x, at.z)
      lat = Math.max(lat, Math.abs(pr.lateral))
      if (cornerAhead(track, pr.s) === 0) lane.corner = Math.max(lane.corner, Math.abs(pr.lateral))
      else lane.straight = Math.max(lane.straight, Math.abs(pr.lateral))
      const tg = tangentAt(track, pr.s)
      let d = fleet.heading(v) - Math.atan2(tg[0], tg[1])
      d = Math.atan2(Math.sin(d), Math.cos(d))
      dh = Math.max(dh, Math.abs(d))
      if (Math.abs(fleet.speed(v)) > track.speedLimit + GARAGE.speedSlack) over++
      // The whole state a page would report at its door, read as the room reads it.
      const m = motionOf(fleet.bodyState(v))
      most.rise = Math.max(most.rise, m.vertical)
      most.fall = Math.max(most.fall, -m.vertical)
      most.side = Math.max(most.side, Math.abs(m.side))
      most.back = Math.max(most.back, -m.forward)
      most.yaw = Math.max(most.yaw, Math.abs(m.yaw))
      most.tilt = Math.max(most.tilt, m.tilt)
      most.up = Math.min(most.up, m.up)
      const y = fleet.bodyState(v).y
      most.low = Math.min(most.low, y)
      most.high = Math.max(most.high, y)
    }
  }
  assert.ok(lat < GARAGE.lane, `lateral ${lat.toFixed(3)} m`)
  // The lane the track followers hold, every frame (trackDriver.ts: pure pursuit with lateral feedback): never past
  // 0.78 m in a corner nor 0.53 m on a straight, the bounds GARAGE.lane documents (measured: 0.58 and 0.18).
  assert.ok(lane.corner < 0.78, `${lane.corner.toFixed(3)} m off the lane in a corner`)
  assert.ok(lane.straight < 0.53, `${lane.straight.toFixed(3)} m off the lane on a straight`)
  assert.ok(lat > 0.3, 'corners are cut: the envelope is not slack for nothing')
  assert.ok(dh < GARAGE.heading, `heading ${dh.toFixed(3)} rad`)
  assert.equal(over, 0)
  // Every motion bound holds the fleet with room to spare (each is at least twice what the fleet does here).
  const twice = (v: number, bound: number, what: string) => assert.ok(2 * v <= bound, `${what}: ${v.toFixed(3)} against a bound of ${bound}`)
  twice(most.rise, GARAGE.rise, 'rising')
  twice(most.fall, GARAGE.fall, 'falling (the first frames settle the fleet onto its springs)')
  twice(most.side, GARAGE.slip, 'sideways slip')
  twice(Math.max(0, most.back), GARAGE.speedSlack, 'reversing')
  twice(most.yaw, GARAGE.spin, 'yaw rate')
  twice(most.tilt, GARAGE.tilt, 'pitch and roll rate')
  assert.ok(most.up >= GARAGE.upright && most.low >= GARAGE.low && most.high <= GARAGE.high, JSON.stringify(most))
})
