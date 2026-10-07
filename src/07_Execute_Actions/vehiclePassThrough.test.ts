/**
 * Why does this file exist? It proves in real Rapier (the WASM build runs in Node) that cars pass through cars and
 * that nothing else changed: a rolling car passes a parked car on its line exactly as over open ground (no contact
 * pair, no speed change, the parked car unmoved), its wheel rays never lift it onto the other chassis, a wall still
 * stops it, the avatar still stops at a parked car's face, the ground still carries the wheels at ride height, and
 * every chassis collider carries the groups collision.ts derives. The Sanctuary's own regression (sanctuary.test.ts,
 * the engine-order test with the real Fleet) covers people and cars.
 * What breaks if it is removed? A chassis could pair with a chassis again (a car pushed into a person's path by
 * another car), or the groups could drift until a car was ghost to the world or the wheels rode up on a car, with
 * nothing to say so before a browser session did.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Box, Furniture } from '../01_Initialize_World/city.ts'
import { VEHICLE_CHASSIS_GROUPS, WHEEL_RAY_GROUPS } from '../02_Define_The_Rules/collision.ts'
import { RIDE_HEIGHT } from './car.ts'
import { Physics } from './physics.ts'
import { Avatar } from './player.ts'
import { CAR, Fleet, type Vehicle } from './vehicles.ts'

const H = 1 / 60
const NONE: Furniture = { lamps: [], trees: [], signals: [] }
/** Open ground away from the street grid the fleet spawns on. */
const TRACK_X = -600
const EAST = Math.PI / 2
/** Seed whose fleet of 8 has both sedans and SUVs. */
const SEED = 11
/** Where the second car waits when the run is over open ground: far off the line, on the same ground. */
const AWAY_Z = 200

/**
 * Car A recovered at (TRACK_X - 30, 0) heading east, car B parked at (TRACK_X, 0) in its lane (or far away, the open
 * ground control), both settled 60 frames, A rolled at 10 m/s with the throttle closed for 240 frames. The template is
 * passThrough.test.ts's run(): the same tolerances apply to a car in the lane as to a pole in it.
 */
async function run(bInLane: boolean, boxes: Box[] = []) {
  const physics = await Physics.create(boxes, NONE)
  const fleet = new Fleet(physics, 2, SEED, { exposeRig: true })
  const [a, b] = fleet.vehicles
  a.mode = 'player'
  b.mode = 'parked'
  const step = (n: number) => { for (let k = 0; k < n; k++) physics.step(H, (h) => fleet.updateControllers(h)) }
  fleet.recover(a, TRACK_X - 30, 0, EAST)
  fleet.recover(b, TRACK_X, bInLane ? 0 : AWAY_Z, EAST)
  step(60)
  const rest = fleet.position(a).y
  const bStart = fleet.position(b)
  fleet.rig(a).body.setLinvel({ x: 10, y: 0, z: 0 }, true)
  let minSpeed = Infinity, contacts = 0, lift = 0
  for (let i = 0; i < 240; i++) {
    fleet.drive(a, { throttle: 0, brake: 0, steer: 0 }, false)
    step(1)
    physics.world.contactPair(fleet.rig(a).collider, fleet.rig(b).collider, (m) => { if (m.numContacts() > 0) contacts++ })
    minSpeed = Math.min(minSpeed, fleet.speed(a))
    lift = Math.max(lift, fleet.position(a).y - rest)
  }
  const p = fleet.position(a)
  const bEnd = fleet.position(b)
  return { x: p.x, z: p.z, speed: fleet.speed(a), minSpeed, contacts, lift, rest, bMoved: Math.hypot(bEnd.x - bStart.x, bEnd.z - bStart.z), fleet }
}

test('a rolling car passes through a parked car on its line as over open ground: no contact, no speed change, the parked car unmoved', async () => {
  const open = await run(false)
  const lane = await run(true)
  assert.ok(open.x > TRACK_X + 5, `the car passed the parked car's place: x ${open.x.toFixed(1)}`)
  assert.ok(lane.x > TRACK_X + 5, `the car is past the parked car: x ${lane.x.toFixed(1)}`)
  assert.ok(Math.abs(lane.x - open.x) < 0.05 && Math.abs(lane.z - open.z) < 0.05, `same line: (${lane.x.toFixed(2)}, ${lane.z.toFixed(2)}) against (${open.x.toFixed(2)}, ${open.z.toFixed(2)})`)
  assert.ok(Math.abs(lane.speed - open.speed) < 0.05, `no contact: ${lane.speed.toFixed(3)} m/s against ${open.speed.toFixed(3)}`)
  assert.equal(lane.contacts, 0, 'the two chassis never formed a contact pair')
  assert.ok(lane.bMoved < 1e-3, `the parked car moved ${lane.bMoved.toFixed(4)} m`)
})

test('the wheel rays never lift a car onto the car it passes through', async () => {
  const lane = await run(true)
  assert.ok(lane.lift < 0.02, `the car rode ${lane.lift.toFixed(3)} m up over the other chassis`)
  assert.ok(lane.contacts === 0 && lane.minSpeed > 9, `it rolled clean through: slowest ${lane.minSpeed.toFixed(2)} m/s`)
})

test('a wall still stops a car, and the ground still carries the wheels at ride height', async () => {
  const walled = await run(false, [[TRACK_X - 10, 0, -4, TRACK_X - 9, 3, 4]])
  assert.ok(walled.x < TRACK_X - 10 && walled.minSpeed < 2, `a wall stops it: x ${walled.x.toFixed(1)}, slowest ${walled.minSpeed.toFixed(2)} m/s`)
  const open = await run(false)
  assert.ok(Math.abs(open.rest - RIDE_HEIGHT) < 0.05, `settled at ${open.rest.toFixed(3)} m, ride height ${RIDE_HEIGHT}`)
})

test('the avatar still stops at a parked car\'s face: cars stay solid to people', async () => {
  const physics = await Physics.create([], NONE)
  const fleet = new Fleet(physics, 1, SEED, { exposeRig: true })
  const car = fleet.vehicles[0]
  car.mode = 'parked'
  fleet.recover(car, TRACK_X, 0, EAST)
  for (let i = 0; i < 60; i++) physics.step(H, (h) => fleet.updateControllers(h))
  const avatar = new Avatar(physics, TRACK_X - 10, 0)
  for (let i = 0; i < 360; i++) {
    physics.step(H, (h) => {
      avatar.move(2, 0, h)
      fleet.updateControllers(h)
    })
  }
  const face = fleet.position(car).x - CAR.halfLength
  assert.ok(avatar.x < face, `stopped at the car's face: x ${avatar.x.toFixed(2)}, face ${face.toFixed(2)}`)
  assert.ok(avatar.x > face - 1, `walked up to it: x ${avatar.x.toFixed(2)}, face ${face.toFixed(2)}`)
  assert.ok(Math.abs(avatar.z) < 0.5 && avatar.body.translation().y < 1.2, 'never lifted onto or pushed round the car')
})

test('every chassis carries the collision groups collision.ts derives; the wheel rays accept theirs', async () => {
  const physics = await Physics.create([], NONE)
  const fleet = new Fleet(physics, 8, SEED, { exposeRig: true })
  const kinds = new Set<boolean>()
  for (const v of fleet.vehicles as readonly Vehicle[]) {
    kinds.add(v.suv)
    assert.equal(fleet.rig(v).collider.collisionGroups(), VEHICLE_CHASSIS_GROUPS, `vehicle ${v.index}`)
  }
  assert.equal(kinds.size, 2, 'sedans and SUVs both')
  assert.equal(VEHICLE_CHASSIS_GROUPS, 0x0002fffd)
  assert.equal(WHEEL_RAY_GROUPS, 0x0001fffd)
  // A wrong u32 throws at the wasm boundary: one frame through updateVehicle with the groups proves they are accepted.
  assert.doesNotThrow(() => physics.step(H, (h) => fleet.updateControllers(h)))
  assert.equal(physics.stats.steps, 1)
})
