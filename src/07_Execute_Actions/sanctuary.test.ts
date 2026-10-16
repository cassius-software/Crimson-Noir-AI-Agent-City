// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the sanctuary in real Rapier (the WASM build runs in Node): a car at
 * 10–14 m/s meeting a standing avatar turns the avatar into a sensor before any contact and passes with its
 * velocity untouched (a control run with the avatar left solid shows the impact); the avatar is nudged out
 * of the footprint and never into a wall; it is solid again once the car has gone, after one flip per pass
 * (on a curve and between two cars too); while shielded the character controller still slides along
 * walls and can never be trapped inside a car; a car pulling away shields a person who comes within 0.3 m of it
 * (they can run after it), and nobody farther off, and nudges nobody; a rig's foot is measured where the Ring-0 audit
 * sees it; and a standing car shields nobody: with the realm's chassis groups the avatar walks through a parked car
 * untouched (collision.ts avatarThroughCars).
 * What breaks if it is removed? A physics or tuning change could let a car run into a person unnoticed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Physics, RAPIER } from './physics.ts'
import { Avatar } from './player.ts'
import { Sanctuary, type PersonBody, type VehicleFootprint } from './sanctuary.ts'
import type { Box } from '../01_Initialize_World/city.ts'
import { VEHICLE_CHASSIS_GROUPS } from '../02_Define_The_Rules/collision.ts'

const H = 1 / 60
/** Fleet's sedan footprint and the avatar capsule. */
const HALF_LENGTH = 2.3
const HALF_WIDTH = 0.92
const RADIUS = 0.3
/** Must match sanctuary.ts: the nudge clears the footprint by MARGIN + EXIT. */
const MARGIN = 0.25
const WHEELS: readonly (readonly [number, number])[] = [[1.4, 0.8], [1.4, -0.8], [-1.4, 0.8], [-1.4, -0.8]]
/** Wheels roll on the city, never on a person: the filter Fleet.updateControllers must pass. */
const WHEEL_FILTER = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC
const EAST = Math.PI / 2

interface Car { body: RAPIER.RigidBody; collider: RAPIER.Collider; controller: RAPIER.DynamicRayCastVehicleController | null; footprint: VehicleFootprint }

function chassisRotation(heading: number): RAPIER.Rotation {
  // Chassis +x is forward, as in Fleet.create.
  const a = (heading - Math.PI / 2) / 2
  return { x: 0, y: Math.sin(a), z: 0, w: Math.cos(a) }
}

function headingOf(body: RAPIER.RigidBody): number {
  const r = body.rotation()
  return Math.atan2(1 - 2 * (r.y * r.y + r.z * r.z), 2 * (r.x * r.z - r.w * r.y))
}

function footprint(heading: number): VehicleFootprint {
  return { id: 0, x: 0, z: 0, vx: 0, vz: 0, wy: 0, active: true, halfLength: HALF_LENGTH, halfWidth: HALF_WIDTH, speed: 0, heading }
}

/** What Fleet.footprints() does every substep: samples the chassis into the footprint's plain numbers. */
function sample(car: Car): VehicleFootprint {
  const f = car.footprint, t = car.body.translation(), lv = car.body.linvel()
  f.x = t.x; f.z = t.z; f.vx = lv.x; f.vz = lv.z; f.wy = car.body.angvel().y
  f.active = car.collider.isEnabled()
  return f
}

/** A raycast-vehicle sedan built as Fleet.create builds one: CCD chassis, four suspended wheels. */
function sedan(world: RAPIER.World, x: number, z: number, heading: number): Car {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, 0.66, z).setRotation(chassisRotation(heading)).setCanSleep(false))
  body.enableCcd(true)
  const collider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(HALF_LENGTH - 0.05, 0.38, HALF_WIDTH - 0.04).setTranslation(0, 0.3, 0).setMass(1300).setFriction(0.4),
    body,
  )
  const controller = world.createVehicleController(body)
  for (const [wx, wz] of WHEELS) controller.addWheel({ x: wx, y: 0, z: wz }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: -1 }, 0.3, 0.34)
  for (let i = 0; i < 4; i++) {
    controller.setWheelSuspensionStiffness(i, 30)
    controller.setWheelSuspensionCompression(i, 2.3)
    controller.setWheelSuspensionRelaxation(i, 3.2)
    controller.setWheelMaxSuspensionForce(i, 40000)
    controller.setWheelFrictionSlip(i, 1.0)
    controller.setWheelSideFrictionStiffness(i, 1.0)
  }
  return { body, collider, controller, footprint: footprint(heading) }
}

/** The same chassis as a CCD box floating just clear of the road: it keeps exactly the velocity it is given. */
function box(world: RAPIER.World, x: number, z: number, heading: number): Car {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(x, 0.86, z).setRotation(chassisRotation(heading)).setGravityScale(0).setCanSleep(false),
  )
  body.enableCcd(true)
  const collider = world.createCollider(RAPIER.ColliderDesc.cuboid(HALF_LENGTH - 0.05, 0.38, HALF_WIDTH - 0.04).setMass(1300).setFriction(0.4), body)
  return { body, collider, controller: null, footprint: footprint(heading) }
}

/** Person position in the car's frame: u along its forward axis, w along its right (−fz, fx). */
function local(car: Car, x: number, z: number): { u: number; w: number } {
  const c = car.body.translation()
  const h = headingOf(car.body)
  const fx = Math.sin(h), fz = Math.cos(h)
  const rx = x - c.x, rz = z - c.z
  return { u: rx * fx + rz * fz, w: rz * fx - rx * fz }
}

interface Options {
  kind: 'sedan' | 'box'
  /** Where the avatar stands; null = nobody on the road. */
  person: { x: number; z: number } | null
  /** Register the avatar with the sanctuary (false = the control run: a solid avatar and no sanctuary). */
  shield: boolean
  car?: { x: number; z: number; heading: number }
  walls?: Box[]
  /**
   * Collision groups for the car's chassis. Unset, the test car keeps Rapier's default (it meets the avatar), so the
   * shield is proven by contrast with a control run; the realm's VEHICLE_CHASSIS_GROUPS never pair with the avatar.
   */
  groups?: number
}

interface Log {
  /** Chassis-forward speed after every step. */
  speeds: number[]
  /** Steps with at least one contact point between the car and the avatar. */
  contacts: number
  firstContact: number
  firstSensor: number
  /** Distance between the car and avatar colliders when the avatar turned into a sensor. */
  gapAtFlip: number
  path: { x: number; z: number; u: number; w: number; sensor: boolean }[]
}

async function rig(o: Options) {
  const physics = await Physics.create(o.walls ?? [], { lamps: [], trees: [], signals: [] })
  const world = physics.world
  const start = o.car ?? { x: -20, z: 0, heading: EAST }
  const car = (o.kind === 'sedan' ? sedan : box)(world, start.x, start.z, start.heading)
  if (o.groups !== undefined) car.collider.setCollisionGroups(o.groups)
  const avatar = o.person ? new Avatar(physics, o.person.x, o.person.z) : null
  const sanctuary = new Sanctuary(world)
  if (avatar && o.shield) sanctuary.register(avatar.person)
  const log: Log = { speeds: [], contacts: 0, firstContact: -1, firstSensor: -1, gapAtFlip: NaN, path: [] }
  let n = 0

  const forwardSpeed = () => {
    if (car.controller) return car.controller.currentVehicleSpeed()
    const v = car.body.linvel(), h = headingOf(car.body)
    return v.x * Math.sin(h) + v.z * Math.cos(h)
  }

  /** One fixed step in engine order: guard → nudge → avatar move → vehicle controllers → world.step(). */
  const step = (wish = { x: 0, z: 0 }) => {
    physics.step(H, (h) => {
      const fp = sample(car)
      fp.heading = headingOf(car.body)
      fp.speed = forwardSpeed()
      if (avatar && o.shield) {
        const nudge = sanctuary.guard([fp], h)[0]
        if (log.firstSensor < 0 && sanctuary.isSensor(0)) {
          log.firstSensor = n
          log.gapAtFlip = avatar.collider.contactCollider(car.collider, 10)?.distance ?? NaN
        }
        avatar.nudge(nudge.dx, nudge.dz)
      }
      if (avatar?.collider.isEnabled()) avatar.move(wish.x, wish.z, h)
      car.controller?.updateVehicle(h, WHEEL_FILTER)
    })
    if (avatar) {
      let touching = false
      world.contactPair(avatar.collider, car.collider, (m) => { if (m.numContacts() > 0) touching = true })
      if (touching) {
        log.contacts++
        if (log.firstContact < 0) log.firstContact = n
      }
      const { u, w } = local(car, avatar.x, avatar.z)
      log.path.push({ x: avatar.x, z: avatar.z, u, w, sensor: avatar.collider.isSensor() })
    }
    log.speeds.push(forwardSpeed())
    n++
  }

  const launch = (speed: number) => {
    const h = headingOf(car.body)
    car.body.setLinvel({ x: speed * Math.sin(h), y: 0, z: speed * Math.cos(h) }, true)
  }

  return { physics, world, car, avatar, sanctuary, log, step, launch }
}

/** A sedan settles on its suspension, is launched along +x at `speed`, and coasts past x = 0 for 4 s. */
async function pass(speed: number, person: { x: number; z: number } | null, shield: boolean, walls?: Box[]) {
  const r = await rig({ kind: 'sedan', person, shield, walls })
  for (let i = 0; i < 45; i++) r.step()
  const launchedAt = r.log.speeds.length
  r.launch(speed)
  for (let i = 0; i < 240; i++) r.step()
  return { ...r, speeds: r.log.speeds.slice(launchedAt), launchedAt }
}

for (const speed of [10, 12, 14]) {
  test(`a sedan at ${speed} m/s passes a standing avatar: sensor before contact, no impulse, nudged clear, solid again`, async () => {
    const baseline = await pass(speed, null, false)
    const shielded = await pass(speed, { x: 0, z: 0.2 }, true)
    const control = await pass(speed, { x: 0, z: 0.2 }, false)

    // Control: a solid avatar is an immovable kinematic capsule, and the car runs into it.
    assert.ok(control.log.firstContact >= 0, 'control run: the car should reach the solid avatar')
    assert.ok(Math.min(...control.speeds) < speed - 5, `control run: expected an impact, min speed ${Math.min(...control.speeds).toFixed(2)}`)

    // (a) The avatar is a sensor before the first contact the control run shows, and never touched.
    assert.ok(shielded.log.firstSensor >= 0, 'the sanctuary never shielded the avatar')
    assert.ok(shielded.log.firstSensor < control.log.firstContact, `flip at step ${shielded.log.firstSensor}, contact at ${control.log.firstContact}`)
    assert.ok(shielded.log.gapAtFlip > 0, `colliders already touching at the flip (${shielded.log.gapAtFlip})`)
    assert.equal(shielded.log.contacts, 0, 'a shielded avatar must have no contact with the car')

    // (b) The car's speed is exactly what it is with nobody there.
    let worst = 0
    for (let i = 0; i < baseline.speeds.length; i++) worst = Math.max(worst, Math.abs(shielded.speeds[i] - baseline.speeds[i]))
    assert.ok(worst < 0.01, `the person changed the car's speed by ${worst.toFixed(4)} m/s`)

    // (c) Nudged sideways out of the footprint while the car was still alongside, not dragged along it.
    const path = shielded.log.path.slice(shielded.launchedAt)
    const alongsideAndClear = path.some((p) => Math.abs(p.u) <= HALF_LENGTH && Math.abs(p.w) >= HALF_WIDTH + RADIUS)
    assert.ok(alongsideAndClear, 'the avatar was still inside the footprint when the car left')
    const end = path[path.length - 1]
    assert.ok(Math.abs(end.z) >= HALF_WIDTH + RADIUS + MARGIN, `ended ${end.z.toFixed(2)} m from the car's line`)
    assert.ok(Math.abs(end.x) < 0.05, `carried ${end.x.toFixed(3)} m along the car's path`)

    // (d) Solid again once the car has gone, after exactly one flip (no chatter during the pass).
    assert.equal(shielded.avatar!.collider.isSensor(), false)
    assert.equal(shielded.sanctuary.shielded(), false)
    assert.equal(shielded.sanctuary.flips, 1)
  })
}

test('the wheels of a sedan must not roll over a shielded person (Fleet.updateControllers filter)', async () => {
  // A sensor capsule right in the right-hand wheel track, as a nudged avatar can be for a few steps.
  const run = async (flags: RAPIER.QueryFilterFlags | undefined) => {
    const physics = await Physics.create([], { lamps: [], trees: [], signals: [] })
    const world = physics.world
    const car = sedan(world, -20, 0, EAST)
    const person = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0.92, 0.8))
    world.createCollider(RAPIER.ColliderDesc.capsule(0.6, RADIUS).setSensor(true), person)
    for (let i = 0; i < 45; i++) physics.step(H, (h) => car.controller!.updateVehicle(h, flags))
    car.body.setLinvel({ x: 12, y: 0, z: 0 }, true)
    let lift = 0
    for (let i = 0; i < 120; i++) {
      physics.step(H, (h) => car.controller!.updateVehicle(h, flags))
      lift = Math.max(lift, car.body.translation().y)
    }
    return { lift, speed: car.controller!.currentVehicleSpeed() }
  }
  const filtered = await run(WHEEL_FILTER)
  assert.ok(Math.abs(filtered.speed - 12) < 0.01 && filtered.lift < 0.6, `filtered wheels: ${JSON.stringify(filtered)}`)
  // Rapier's default wheel ray casts do hit sensors: this is why the filter is required.
  const unfiltered = await run(undefined)
  assert.ok(unfiltered.lift > filtered.lift + 0.02, `default filter should ride over the sensor: ${JSON.stringify(unfiltered)}`)
})

for (const speed of [14, 30]) {
  test(`a CCD box at ${speed} m/s passes a shielded avatar with its velocity exactly unchanged`, async () => {
    const r = await rig({ kind: 'box', person: { x: 0, z: -0.1 }, shield: true, car: { x: -12, z: 0, heading: EAST } })
    r.launch(speed)
    for (let i = 0; i < 120; i++) r.step()
    assert.ok(r.log.firstSensor >= 0 && r.log.gapAtFlip > 0)
    assert.equal(r.log.contacts, 0)
    for (const v of r.log.speeds) assert.ok(Math.abs(v - speed) < 1e-4, `speed ${v}`)
    assert.equal(r.sanctuary.flips, 1)
    assert.equal(r.avatar!.collider.isSensor(), false)
  })
}

test('a car reversing into a person shields them too', async () => {
  // Rear bumper 1.5 m ahead of the avatar, backing toward it at 3 m/s.
  const r = await rig({ kind: 'box', person: { x: 0, z: 0 }, shield: true, car: { x: 4.1, z: 0, heading: EAST } })
  r.launch(-3)
  for (let i = 0; i < 180; i++) r.step()
  assert.ok(r.log.firstSensor >= 0 && r.log.gapAtFlip > 0)
  assert.equal(r.log.contacts, 0)
  for (const v of r.log.speeds) assert.ok(Math.abs(v + 3) < 1e-4)
})

test('the nudge takes the open side when a wall blocks the near one, and never enters the wall', async () => {
  // A building face 0.18 m left of the car's flank; the avatar stands in the car's path, nearer the wall.
  const face = -1.1
  const walls: Box[] = [[-40, 0, -3, 40, 4, face]]
  const r = await rig({ kind: 'sedan', person: { x: 0, z: -0.35 }, shield: true, walls })
  for (let i = 0; i < 45; i++) r.step()
  r.launch(12)
  for (let i = 0; i < 240; i++) r.step()
  assert.equal(r.log.contacts, 0)
  for (const p of r.log.path) assert.ok(p.z - RADIUS >= face - 1e-3, `avatar entered the wall at z = ${p.z.toFixed(3)}`)
  const end = r.log.path[r.log.path.length - 1]
  assert.ok(end.z >= HALF_WIDTH + RADIUS, `expected the open (right) side, ended at z = ${end.z.toFixed(2)}`)
  assert.equal(r.avatar!.collider.isSensor(), false)
})

test('walled in on both sides, the nudge stops at the wall and the car still passes untouched', async () => {
  // A 2.3 m alley: 0.27 m either side of the chassis.
  const walls: Box[] = [[-40, 0, -3, 40, 4, -1.15], [-40, 0, 1.15, 40, 4, 3]]
  const r = await rig({ kind: 'box', person: { x: 0, z: -0.4 }, shield: true, walls, car: { x: -12, z: 0, heading: EAST } })
  r.launch(12)
  for (let i = 0; i < 150; i++) r.step()
  assert.equal(r.log.contacts, 0)
  for (const v of r.log.speeds) assert.ok(Math.abs(v - 12) < 1e-4)
  for (const p of r.log.path) {
    assert.ok(p.z - RADIUS >= -1.15 - 1e-3 && p.z + RADIUS <= 1.15 + 1e-3, `avatar entered a wall at z = ${p.z.toFixed(3)}`)
  }
  assert.equal(r.sanctuary.flips, 1)
  assert.equal(r.avatar!.collider.isSensor(), false, 'solid again once the car has left the alley')
})

test('(e) while shielded, the character controller still slides along a wall', async () => {
  // A car crawls east at 1.5 m/s beside the avatar, which is pinned between it and a wall and walks
  // diagonally into the wall while keeping pace with the car.
  const face = 1.7
  const walls: Box[] = [[-40, 0, face, 40, 4, 3]]
  const r = await rig({ kind: 'box', person: { x: -1, z: 1.3 }, shield: true, walls, car: { x: -1, z: 0, heading: EAST } })
  // Scene queries (the character controller, the wall probe) only see colliders after a world step.
  for (let i = 0; i < 5; i++) r.step()
  assert.equal(r.sanctuary.flips, 0, 'a standing car beside the avatar does not shield it')
  r.launch(1.5)
  for (let i = 0; i < 10; i++) r.step({ x: 1.5, z: 1.5 })
  assert.ok(r.sanctuary.shielded(), 'the crawling car beside the avatar should shield it')
  const x0 = r.avatar!.x
  for (let i = 0; i < 90; i++) {
    r.step({ x: 1.5, z: 1.5 })
    assert.ok(r.sanctuary.isSensor(0) && r.avatar!.collider.isSensor(), `lost the shield at step ${i}`)
    assert.ok(r.avatar!.z + RADIUS <= face + 1e-3, `avatar entered the wall at z = ${r.avatar!.z.toFixed(3)}`)
  }
  const slid = r.avatar!.x - x0
  assert.ok(slid > 1.5 * 1.5 * 0.9, `slid only ${slid.toFixed(2)} m along the wall in 1.5 s`)
  assert.equal(r.log.contacts, 0)
})

test('a shielded avatar is never trapped inside a car that stops on top of it', async () => {
  const r = await rig({ kind: 'box', person: { x: 0, z: 0 }, shield: true, car: { x: -12, z: 0, heading: EAST } })
  r.launch(20)
  // Stop dead with the front bumper 1 m past the avatar, before the nudge has carried it clear.
  while (r.car.body.translation().x + HALF_LENGTH < 1) r.step()
  r.car.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
  const parked = r.car.body.translation()
  const inside = local(r.car, r.avatar!.x, r.avatar!.z)
  assert.ok(Math.abs(inside.w) < HALF_WIDTH && Math.abs(inside.u) < HALF_LENGTH, 'setup: the avatar should be inside the footprint')
  for (let i = 0; i < 90; i++) r.step()
  const out = local(r.car, r.avatar!.x, r.avatar!.z)
  assert.ok(Math.abs(out.w) >= HALF_WIDTH + RADIUS + MARGIN, `still inside: w = ${out.w.toFixed(2)}`)
  assert.equal(r.avatar!.collider.isSensor(), false, 'solid again beside the stopped car')
  assert.equal(r.log.contacts, 0)
  const now = r.car.body.translation()
  assert.ok(Math.hypot(now.x - parked.x, now.z - parked.z) < 1e-6, 'the stopped car was pushed')
  // Solid again, the avatar walks back into the stopped car, now with the realm's chassis groups (collision.ts
  // avatarThroughCars; this rig's default groups would let the capsule shove the box): into it with no shield, no
  // contact, and the car unmoved.
  r.car.collider.setCollisionGroups(VEHICLE_CHASSIS_GROUPS)
  const side = Math.sign(out.w)
  for (let i = 0; i < 60; i++) r.step({ x: 0, z: -side * 2 })
  assert.ok(Math.abs(local(r.car, r.avatar!.x, r.avatar!.z).w) < HALF_WIDTH, 'walked into the stopped car')
  assert.equal(r.sanctuary.flips, 1)
  assert.equal(r.log.contacts, 0)
  const after = r.car.body.translation()
  assert.ok(Math.hypot(after.x - parked.x, after.z - parked.z) < 1e-6, 'the stopped car was pushed')
})

test('a car respawned on top of a standing person neither shields nor moves them: a standing chassis and the avatar never pair', async () => {
  // Fleet.recover() can set a car down anywhere. With the realm's chassis groups there is no contact to depenetrate,
  // so the person stays where they stand, solid, inside the car (which dissolves around the camera on the page).
  const r = await rig({ kind: 'box', person: { x: 0, z: 0 }, shield: true, car: { x: 0.5, z: 0.3, heading: EAST }, groups: VEHICLE_CHASSIS_GROUPS })
  for (let i = 0; i < 90; i++) r.step()
  assert.equal(r.sanctuary.flips, 0, 'a standing car shields nobody')
  assert.equal(r.log.contacts, 0)
  const t = r.car.body.translation()
  assert.ok(Math.hypot(t.x - 0.5, t.z - 0.3) < 1e-6, 'the car was shoved')
  assert.ok(Math.hypot(r.avatar!.x, r.avatar!.z) < 1e-3, `the person was moved: (${r.avatar!.x.toFixed(3)}, ${r.avatar!.z.toFixed(3)})`)
  assert.equal(r.avatar!.collider.isSensor(), false)
  // The moment the car moves with them inside, the sweep shields them and the nudge carries them clear.
  r.car.body.setLinvel({ x: 3, y: 0, z: 0 }, true)
  for (let i = 0; i < 90; i++) r.step()
  assert.equal(r.sanctuary.flips, 1)
  assert.equal(r.log.contacts, 0)
  assert.ok(Math.abs(local(r.car, r.avatar!.x, r.avatar!.z).w) >= HALF_WIDTH + RADIUS + MARGIN || Math.abs(local(r.car, r.avatar!.x, r.avatar!.z).u) > HALF_LENGTH, 'carried clear')
})

test('a parked car: the avatar walks through it, never shielded, never nudged (collision.ts avatarThroughCars)', async () => {
  const r = await rig({ kind: 'sedan', person: { x: 0, z: 3 }, shield: true, car: { x: 0, z: 0, heading: EAST }, groups: VEHICLE_CHASSIS_GROUPS })
  for (let i = 0; i < 60; i++) r.step()
  for (let i = 0; i < 180; i++) r.step({ x: 0, z: -2 })
  assert.equal(r.sanctuary.flips, 0)
  assert.equal(r.log.contacts, 0)
  const { u, w } = local(r.car, r.avatar!.x, r.avatar!.z)
  assert.ok(w < -(HALF_WIDTH + RADIUS), `out the far side of the parked car: w = ${w.toFixed(3)}`)
  assert.ok(Math.abs(u) < 0.05 && Math.abs(r.avatar!.x) < 0.05, `in a straight line: u = ${u.toFixed(3)}`)
  assert.ok(Math.abs(r.avatar!.z - (3 - 2 * 3)) < 0.3, `at walking pace throughout: z = ${r.avatar!.z.toFixed(2)}`)
})

test('a car pulling away from a person just behind it, or passing in the next lane, shields nobody', async () => {
  const away = await rig({ kind: 'box', person: { x: 0, z: 0 }, shield: true, car: { x: 2.7, z: 0, heading: EAST } })
  away.launch(3)
  for (let i = 0; i < 90; i++) away.step()
  assert.equal(away.sanctuary.flips, 0)
  const lane = await rig({ kind: 'box', person: { x: 0, z: 2.5 }, shield: true, car: { x: -12, z: 0, heading: EAST } })
  lane.launch(14)
  for (let i = 0; i < 90; i++) lane.step()
  assert.equal(lane.sanctuary.flips, 0)
})

test('a car pulling away shields a person once their centre is within 0.3 m of its footprint, at a face or a corner, and nobody farther off', async () => {
  // A footprint pulling away cannot reach anyone, so its sweep never fires; but people on foot walk into cars and can
  // run after one (sanctuary.ts CLOSE). A standing car shields nobody at any distance.
  const physics = await Physics.create([], { lamps: [], trees: [], signals: [] })
  const world = physics.world
  const d = (m: number) => m / Math.SQRT2
  const cases: readonly (readonly [string, number, number, boolean])[] = [
    ['0.29 m behind', -(HALF_LENGTH + 0.29), 0, true],
    ['0.31 m behind', -(HALF_LENGTH + 0.31), 0, false],
    ['0.29 m off the rear-left corner', -(HALF_LENGTH + d(0.29)), -(HALF_WIDTH + d(0.29)), true],
    ['0.31 m off the rear-left corner', -(HALF_LENGTH + d(0.31)), -(HALF_WIDTH + d(0.31)), false],
    ['inside, at the back', -(HALF_LENGTH - 0.2), 0, true],
  ]
  for (const speed of [0.6, 0]) {
    for (const [where, x, z, near] of cases) {
      const sanctuary = new Sanctuary(world)
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, 0.92, z))
      sanctuary.register({ body, collider: world.createCollider(RAPIER.ColliderDesc.capsule(0.6, RADIUS), body), radius: RADIUS, halfHeight: 0.6 })
      sanctuary.guard([{ ...footprint(EAST), vx: speed, speed }], H)
      assert.equal(sanctuary.isSensor(0), near && speed > 0, `${where}, the car at ${speed} m/s`)
      world.removeRigidBody(body)
    }
  }
})

test('a person standing just behind a car that pulls away is shielded but never nudged: the car clears them by itself', async () => {
  for (const behind of [0.05, 0.25, 0.29]) {
    const r = await rig({ kind: 'box', person: { x: 0, z: 0 }, shield: true, car: { x: HALF_LENGTH + behind, z: 0, heading: EAST }, groups: VEHICLE_CHASSIS_GROUPS })
    for (let i = 0; i < 10; i++) r.step()
    r.launch(3)
    for (let i = 0; i < 90; i++) r.step()
    assert.equal(r.sanctuary.flips, 1, `${behind} m behind`)
    assert.ok(Math.hypot(r.avatar!.x, r.avatar!.z) < 1e-3, `${behind} m behind: moved to (${r.avatar!.x.toFixed(3)}, ${r.avatar!.z.toFixed(3)})`)
    assert.equal(r.avatar!.collider.isSensor(), false, `${behind} m behind: solid again once the car has gone`)
  }
})

test('a shape off its body\'s origin (a rig\'s foot) is measured where the Ring-0 audit sees it: the offset carried by the body', async () => {
  const physics = await Physics.create([], { lamps: [], trees: [], signals: [] })
  const world = physics.world
  const quarter = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }
  // The origin 0.45 m behind a car pulling away (outside CLOSE), the shape 0.25 m nearer it: 0.2 m, inside.
  const cases: readonly (readonly [string, RAPIER.Rotation, readonly [number, number, number] | undefined, boolean])[] = [
    ['no offset', { x: 0, y: 0, z: 0, w: 1 }, undefined, false],
    ['offset along +x', { x: 0, y: 0, z: 0, w: 1 }, [0.25, 0, 0], true],
    ['offset along +z, the body turned a quarter about +y (z to x)', quarter, [0, 0, 0.25], true],
    ['offset along −x', { x: 0, y: 0, z: 0, w: 1 }, [-0.25, 0, 0], false],
  ]
  // ragdollRealm.ts hands every foot its offset.
  assert.match(readFileSync(new URL('./ragdollRealm.ts', import.meta.url), 'utf8'), /offset: spec\.foot \? FOOT\.offset : undefined/)
  for (const [where, rotation, offset, near] of cases) {
    const sanctuary = new Sanctuary(world)
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(-(HALF_LENGTH + 0.45), 0.92, 0).setRotation(rotation))
    sanctuary.register({ body, collider: world.createCollider(RAPIER.ColliderDesc.capsule(0.1, 0.08), body), radius: 0.08, halfHeight: 0.1, offset })
    sanctuary.guard([{ ...footprint(EAST), vx: 0.6, speed: 0.6 }], H)
    assert.equal(sanctuary.isSensor(0), near, where)
    world.removeRigidBody(body)
  }
})

test('a person out of the world (seated in a car) is never shielded', async () => {
  const r = await rig({ kind: 'box', person: { x: 0, z: 0 }, shield: true, car: { x: -12, z: 0, heading: EAST } })
  r.avatar!.setEnabled(false)
  r.launch(12)
  for (let i = 0; i < 120; i++) r.step()
  assert.equal(r.sanctuary.flips, 0)
  assert.equal(r.sanctuary.shielded(), false)
  assert.equal(r.log.contacts, 0)
})

test('a spinning or sideways-sliding car shields the person too: the sweep reads the body, not the forward speed', async () => {
  // Chassis-forward speed is 0 in every case here, so only the body's own velocity and yaw can warn.
  const cases = [
    { name: 'spinning left', lin: { x: 0, z: 0 }, spin: 2, person: { x: 0.8, z: 1.7 } },
    { name: 'spinning right', lin: { x: 0, z: 0 }, spin: -3, person: { x: 0.8, z: 1.7 } },
    { name: 'sliding sideways', lin: { x: 0, z: 4 }, spin: 0, person: { x: 0, z: 4 } },
  ]
  for (const c of cases) {
    const r = await rig({ kind: 'box', person: c.person, shield: true, car: { x: 0, z: 0, heading: EAST } })
    for (let i = 0; i < 3; i++) r.step()
    r.car.body.setLinvel({ x: c.lin.x, y: 0, z: c.lin.z }, true)
    r.car.body.setAngvel({ x: 0, y: c.spin, z: 0 }, true)
    for (let i = 0; i < 120; i++) {
      r.step()
      const v = r.car.body.linvel(), w = r.car.body.angvel()
      assert.ok(Math.abs(v.x - c.lin.x) + Math.abs(v.z - c.lin.z) + Math.abs(w.y - c.spin) < 1e-3, `${c.name}: the person changed the car's motion at step ${i}`)
    }
    assert.ok(r.sanctuary.flips >= 1, `${c.name}: never shielded`)
    assert.equal(r.log.contacts, 0, `${c.name}: contact with the car`)
  }
})

test('a car sweeping past on a curve shields the avatar once, not on and off', async () => {
  // A right-hand arc (radius 12 m at 6 m/s) past an avatar beside it: the front corner reaches them, the
  // flank falls away as the car turns, then the rear corner swings back in. The shield must hold throughout.
  const speed = 6, curvature = -1 / 12
  for (const [x, z] of [[0, 3.3], [0, 3.45], [-1, 2.55], [-2, 1.65]]) {
    const physics = await Physics.create([], { lamps: [], trees: [], signals: [] })
    const world = physics.world
    const car = box(world, -10, 0, EAST)
    const avatar = new Avatar(physics, x, z)
    const sanctuary = new Sanctuary(world)
    sanctuary.register(avatar.person)
    for (let i = 0; i < 3; i++) physics.step(H, (h) => avatar.move(0, 0, h))
    let contacts = 0, restoredAlongside = 0
    for (let i = 0; i < 360; i++) {
      physics.step(H, (h) => {
        // Steer the box along the arc, as the wheels would.
        const heading = headingOf(car.body)
        car.body.setLinvel({ x: speed * Math.sin(heading), y: 0, z: speed * Math.cos(heading) }, true)
        car.body.setAngvel({ x: 0, y: speed * curvature, z: 0 }, true)
        car.footprint.heading = heading
        const was = sanctuary.isSensor(0)
        const n = sanctuary.guard([sample(car)], h)[0]
        const p = local(car, avatar.x, avatar.z)
        if (was && !sanctuary.isSensor(0) && Math.abs(p.u) <= HALF_LENGTH + RADIUS + 0.3) restoredAlongside++
        avatar.nudge(n.dx, n.dz)
        avatar.move(0, 0, h)
      })
      world.contactPair(avatar.collider, car.collider, (m) => { if (m.numContacts() > 0) contacts++ })
    }
    assert.equal(contacts, 0, `(${x}, ${z}): contact with the car`)
    assert.equal(sanctuary.flips, 1, `(${x}, ${z}): shielded ${sanctuary.flips} times in one pass`)
    assert.equal(restoredAlongside, 0, `(${x}, ${z}): turned solid while the car was still alongside`)
    assert.equal(avatar.collider.isSensor(), false)
  }
})

test('between a parked car and a passing one, the nudge clears the moving car and does not bounce between them', async () => {
  // Parked car B along x at z = 0; car A passes at 10 m/s in the next lane (z = −2.2); the avatar stands
  // in the 0.36 m between their footprints, overlapping A's path. There is no room between the two cars,
  // so it is nudged into the parked one (a sensor harms nothing) while A passes, then back out.
  const physics = await Physics.create([], { lamps: [], trees: [], signals: [] })
  const world = physics.world
  const parked = box(world, 0, 0, EAST)
  const passing = box(world, -15, -2.2, EAST)
  passing.footprint.id = 1
  const avatar = new Avatar(physics, 0, -1.3)
  const sanctuary = new Sanctuary(world)
  sanctuary.register(avatar.person)
  for (let i = 0; i < 3; i++) physics.step(H, (h) => avatar.move(0, 0, h))
  passing.body.setLinvel({ x: 10, y: 0, z: 0 }, true)
  let reversals = 0, lastDz = 0, insidePassing = 0
  for (let i = 0; i < 180; i++) {
    physics.step(H, (h) => {
      const n = sanctuary.guard([sample(parked), sample(passing)], h)[0]
      if (n.dz !== 0) {
        if (lastDz !== 0 && Math.sign(n.dz) !== Math.sign(lastDz)) reversals++
        lastDz = n.dz
      }
      avatar.nudge(n.dx, n.dz)
      avatar.move(0, 0, h)
    })
    const p = local(passing, avatar.x, avatar.z)
    if (Math.abs(p.u) < HALF_LENGTH && Math.abs(p.w) < HALF_WIDTH + RADIUS) insidePassing++
  }
  assert.ok(reversals <= 1, `the nudge changed direction ${reversals} times`)
  assert.equal(insidePassing, 0, 'the avatar was inside the footprint of the passing car')
  assert.ok(Math.abs(passing.body.linvel().x - 10) < 1e-4)
  const moved = parked.body.translation()
  assert.ok(Math.hypot(moved.x, moved.z) < 1e-6, 'the parked car was pushed')
  assert.equal(sanctuary.flips, 1)
  assert.equal(avatar.collider.isSensor(), false)
  const w = local(parked, avatar.x, avatar.z).w
  assert.ok(w <= -(HALF_WIDTH + RADIUS + MARGIN), `ended inside the parked car's margin: w = ${w.toFixed(2)}`)
})

test('with the real Fleet in the engine order (guard, nudge, move, updateControllers), a coasting car passes the avatar untouched', async () => {
  // Imported here so a mid-edit vehicles.ts cannot take the other tests down with it.
  const { Fleet } = await import('./vehicles.ts')
  const run = async (person: boolean, shield: boolean, at = 0.2, walls: Box[] = []) => {
    const physics = await Physics.create(walls, { lamps: [], trees: [], signals: [] })
    const world = physics.world
    const fleet = new Fleet(physics, 1, 11, { exposeRig: true })
    const car = fleet.vehicles[0]
    fleet.recover(car, -20, 0, EAST)
    const avatar = person ? new Avatar(physics, 0, at) : null
    const sanctuary = new Sanctuary(world)
    if (avatar && shield) sanctuary.register(avatar.person)
    const speeds: number[] = []
    let contacts = 0
    const frame = () => {
      physics.step(H, (h) => {
        const n = sanctuary.guard(fleet.footprints(), h)[0]
        if (avatar) {
          avatar.nudge(n?.dx ?? 0, n?.dz ?? 0)
          avatar.move(0, 0, h)
        }
        fleet.updateControllers(h)
      })
      if (avatar) world.contactPair(avatar.collider, fleet.rig(car).collider, (m) => { if (m.numContacts() > 0) contacts++ })
      speeds.push(fleet.speed(car))
    }
    for (let i = 0; i < 60; i++) frame()
    // No command: the car coasts (drag, rolling resistance, engine braking) as one that cannot stop in time.
    fleet.rig(car).body.setLinvel({ x: 12, y: 0, z: 0 }, true)
    speeds.length = 0
    for (let i = 0; i < 180; i++) frame()
    return { speeds, contacts, sanctuary, avatar }
  }
  const worstChange = (a: number[], b: number[]) => {
    let worst = 0
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]))
    return worst
  }
  const baseline = await run(false, false)
  const control = await run(true, false)
  const shielded = await run(true, true)
  // The real fleet's chassis and the avatar's capsule never pair (collision.ts avatarThroughCars), so even the solid,
  // unshielded avatar is passed with no contact and no change of speed: the Sanctuary is the law's second line here.
  assert.equal(control.contacts, 0, 'control run: a real chassis never pairs with the avatar, shielded or not')
  assert.ok(worstChange(control.speeds, baseline.speeds) < 0.01, 'control run: the unshielded avatar changed the car\'s speed')
  assert.equal(shielded.contacts, 0)
  const worst = worstChange(shielded.speeds, baseline.speeds)
  assert.ok(worst < 0.01, `the person changed the car's speed by ${worst.toFixed(4)} m/s`)
  assert.equal(shielded.sanctuary.flips, 1)
  assert.equal(shielded.avatar!.collider.isSensor(), false)
  assert.ok(Math.abs(shielded.avatar!.z) >= HALF_WIDTH + RADIUS + MARGIN, `ended ${shielded.avatar!.z.toFixed(2)} m from the car's line`)

  // In a 2.3 m alley the nudge cannot carry the avatar out of a wheel track, so the car passes over a shielded
  // person: only Fleet's wheel-ray filter keeps the wheels from riding up on them (about 1.1 m/s lost without it).
  const alley: Box[] = [[-40, 0, -3, 40, 4, -1.15], [-40, 0, 1.15, 40, 4, 3]]
  const alleyBaseline = await run(false, false, 0.8, alley)
  const alleyShielded = await run(true, true, 0.8, alley)
  assert.equal(alleyShielded.contacts, 0)
  const alleyWorst = worstChange(alleyShielded.speeds, alleyBaseline.speeds)
  assert.ok(alleyWorst < 0.01, `in the alley the person changed the car's speed by ${alleyWorst.toFixed(4)} m/s (wheel ray casts must exclude people)`)
  assert.equal(alleyShielded.sanctuary.flips, 1)
  assert.equal(alleyShielded.avatar!.collider.isSensor(), false)
})

test('a shielded person is never an obstacle to a character controller', async () => {
  const physics = await Physics.create([], { lamps: [], trees: [], signals: [] })
  const still = new Avatar(physics, 0, 0)
  const walker = new Avatar(physics, -1.5, 0)
  // Scene queries only see colliders after a world step.
  physics.step(H, () => {})
  for (let i = 0; i < 30; i++) physics.step(H, (h) => walker.move(2, 0, h))
  assert.ok(walker.x < -0.55, `walked through a solid person to x = ${walker.x.toFixed(2)}`)
  still.collider.setSensor(true)
  for (let i = 0; i < 60; i++) physics.step(H, (h) => walker.move(2, 0, h))
  assert.ok(walker.x > 0.6, `a sensor blocked the walker at x = ${walker.x.toFixed(2)}`)
})

test('guard() results are index-aligned with register() order', async () => {
  const physics = await Physics.create([], { lamps: [], trees: [], signals: [] })
  const world = physics.world
  const car = box(world, -12, 0, EAST)
  const sanctuary = new Sanctuary(world)
  const person = (x: number, z: number): PersonBody => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, 0.92, z))
    return { body, collider: world.createCollider(RAPIER.ColliderDesc.capsule(0.6, RADIUS), body), radius: RADIUS, halfHeight: 0.6 }
  }
  const aside = person(0, 6)
  const inPath = person(0, 0.3)
  sanctuary.register(aside)
  sanctuary.register(inPath)
  car.body.setLinvel({ x: 12, y: 0, z: 0 }, true)
  let shieldedSecond = false
  for (let i = 0; i < 120; i++) {
    physics.step(H, (h) => {
      const nudges = sanctuary.guard([sample(car)], h)
      assert.equal(nudges.length, 2)
      assert.deepEqual(nudges[0], { dx: 0, dz: 0 })
      assert.equal(sanctuary.isSensor(0), false)
      if (sanctuary.isSensor(1)) shieldedSecond = true
      // Kinematic bodies without a character controller: apply the nudge directly.
      const t = inPath.body.translation()
      inPath.body.setNextKinematicTranslation({ x: t.x + nudges[1].dx, y: t.y, z: t.z + nudges[1].dz })
    })
  }
  assert.ok(shieldedSecond)
  assert.equal(sanctuary.flips, 1)
  assert.equal(sanctuary.isSensor(5), false, 'an unknown index is not a sensor')
  assert.ok(Math.abs(car.body.linvel().x - 12) < 1e-4)
})
