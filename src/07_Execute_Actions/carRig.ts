/**
 * Why does this file exist? It is one car's physics, shared by the page's fleet (vehicles.ts) and the network room's
 * authority on the server (10_Network/garage.node.ts): how a car is built in a Rapier world (its chassis, its strict
 * CCD, its collision groups and its four raycast wheels), how one is rebuilt in a given state (a car handed between
 * the page and the room), its state read and written as plain numbers, what one fixed
 * substep does to it (the drivetrain with its power limit, the brakes and Ackermann steering, aerodynamic drag,
 * rolling resistance and engine braking, then the raycast wheels), the Ring-0 speed clamp, the chassis heading and
 * forward speed, where a driver is put down beside a car (the realm's exit rule), and the seeded plan that seats the
 * fleet (which car is an SUV and which ring each one starts on). The server replays a player's car with exactly this
 * code, so its result is the page's to the bit (garage.node.test.ts). Nothing here vets a command: the Ring-0 bouncer
 * stays the fleet's (vehicles.ts), and a car on the server replays the command the page's bouncer let through.
 * What breaks if it is removed? The fleet has no cars, and the room's authority could not replay one.
 */
import { RAPIER } from './physics.ts'
import { CAR, chassisBox, RIDE_HEIGHT, WHEELS, type CarTuning, type DriveMode } from './car.ts'
import { CITY, inLot } from '../01_Initialize_World/city.ts'
import { KERNEL } from '../02_Define_The_Rules/civic.ts'
import { VEHICLE_CHASSIS_GROUPS, WHEEL_RAY_GROUPS } from '../02_Define_The_Rules/collision.ts'
import { createRng } from '../02_Define_The_Rules/degrees.ts'
import { Driver, type DriverLike } from '../06_Make_Decisions/traffic.ts'
import { TrackDriver } from '../06_Make_Decisions/trackDriver.ts'
import { assignSlots, poseAt, type TrackNetwork } from '../06_Make_Decisions/tracks.ts'
import type { CarBodyState } from './simProtocol.ts'

const AIR_DENSITY = 1.225
const GRAVITY = 9.81
/**
 * People are kinematic bodies (the avatar), sensors while the sanctuary shields them: wheels never roll on them (Rapier's
 * wheel rays hit both by default, so a car would ride up over a shielded person). Other chassis are dropped by the
 * groups (WHEEL_RAY_GROUPS). What a wheel ray can hit is the ground and the buildings.
 */
export const NOT_PEOPLE = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC
/** Metres the driver is put down beside the chassis centre when leaving a car (the realm's exit rule). */
export const EXIT_SIDE = 2.1
/** How far a lot is kept from the exit point, m: an exit into a building lot is taken on the car's other side. */
const EXIT_LOT_PAD = 0.4

/** A car's Rapier handles and what its physics reads of it. */
export interface CarRig {
  body: RAPIER.RigidBody
  collider: RAPIER.Collider
  controller: RAPIER.DynamicRayCastVehicleController
  suv: boolean
  /** kg */
  mass: number
}

/** What reaches the wheels for a substep: the vetted throttle (−1..1), service brake (0..KERNEL.maxBrake, m/s²) and steer (rad). */
export interface WheelCommand { throttle: number; brake: number; steer: number }

/** A rotation of `angle` about +y as a quaternion (the chassis only ever spawns or recovers upright). */
export function yawQuat(angle: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) }
}

/**
 * Ackermann steering: the inner front wheel turns tighter so both front wheels roll about the rear axle's turn centre.
 * `steer` is the bicycle-model angle (positive = left); `side` is +1 for the left wheel and −1 for the right one.
 */
export function ackermann(steer: number, side: 1 | -1): number {
  const t = Math.tan(steer)
  return Math.atan((CAR.wheelbase * t) / (CAR.wheelbase - side * (CAR.track / 2) * t))
}

/** Fits the four raycast wheels to a vehicle controller, with the tyre grip `grip` × CAR.frictionSlip. */
function fitWheels(controller: RAPIER.DynamicRayCastVehicleController, grip: number): void {
  for (const [wx, wz] of WHEELS) controller.addWheel({ x: wx, y: 0, z: wz }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: -1 }, CAR.suspension, CAR.wheelRadius)
  for (let i = 0; i < 4; i++) {
    controller.setWheelSuspensionStiffness(i, 30)
    controller.setWheelSuspensionCompression(i, 2.3)
    controller.setWheelSuspensionRelaxation(i, 3.2)
    controller.setWheelMaxSuspensionForce(i, 40000)
    controller.setWheelFrictionSlip(i, CAR.frictionSlip * grip)
    controller.setWheelSideFrictionStiffness(i, 1.0)
  }
}

/**
 * A car standing on the ground at (x, z), facing `heading` (forward is (sin h, cos h)): its chassis, CCD, groups and
 * wheels (tyre grip `grip` × CAR.frictionSlip).
 */
export function buildCarRig(world: RAPIER.World, x: number, z: number, heading: number, suv: boolean, grip = 1): CarRig {
  const mass = suv ? CAR.suvMass : CAR.mass
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(x, RIDE_HEIGHT + 0.1, z).setRotation(yawQuat(heading - Math.PI / 2)).setCanSleep(false),
  )
  // Strict CCD: fast cars cannot tunnel through poles, thin walls or people between steps.
  body.enableCcd(true)
  const box = chassisBox(suv)
  // Cars pass through cars: the chassis groups drop every chassis-chassis pair in the broad phase (no contact,
  // no impulse) and leave the ground, the buildings and the avatar's capsule as solid as before.
  const collider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(box.hx, box.hy, box.hz).setTranslation(0, box.y, 0).setMass(mass).setFriction(0.4).setCollisionGroups(VEHICLE_CHASSIS_GROUPS),
    body,
  )
  const controller = world.createVehicleController(body)
  fitWheels(controller, grip)
  return { body, collider, controller, suv, mass }
}

/** A car's full rigid-body state as plain numbers (what crosses between the page and the room). */
export function carState(rig: CarRig): CarBodyState {
  const b = rig.body
  const t = b.translation(), r = b.rotation(), u = b.linvel(), w = b.angvel()
  return { x: t.x, y: t.y, z: t.z, qx: r.x, qy: r.y, qz: r.z, qw: r.w, vx: u.x, vy: u.y, vz: u.z, wx: w.x, wy: w.y, wz: w.z }
}

/**
 * Car `old` (if any) taken out of `world` and built again in state `s`: a new chassis, collider and vehicle controller,
 * put exactly in that state. A car keeps state between substeps that no setter reaches: its vehicle controller's
 * wheels (their last contact and impulses) and its chassis contacts' warm-start impulses (a car resting against a
 * building corner). So a car handed from one world to another (the page's car to the room's authority when a player in
 * a room takes its wheel, and back on a correction) is matched to the bit only when both sides rebuild it, with this
 * function, from the same numbers (garage.node.test.ts).
 */
export function rebuildCarRig(world: RAPIER.World, old: CarRig | null, s: CarBodyState, suv: boolean, grip = 1): CarRig {
  if (old) {
    world.removeVehicleController(old.controller)
    world.removeRigidBody(old.body)
  }
  const rig = buildCarRig(world, s.x, s.z, headingOf({ x: s.qx, y: s.qy, z: s.qz, w: s.qw }), suv, grip)
  const b = rig.body
  b.setTranslation({ x: s.x, y: s.y, z: s.z }, true)
  b.setRotation({ x: s.qx, y: s.qy, z: s.qz, w: s.qw }, true)
  b.setLinvel({ x: s.vx, y: s.vy, z: s.vz }, true)
  b.setAngvel({ x: s.wx, y: s.wy, z: s.wz }, true)
  world.propagateModifiedBodyPositionsToColliders()
  return rig
}

/** Chassis heading, rad: forward (chassis +x) as (sin h, cos h). */
export function headingOf(r: { x: number; y: number; z: number; w: number }): number {
  const fx = 1 - 2 * (r.y * r.y + r.z * r.z)
  const fz = 2 * (r.x * r.z - r.w * r.y)
  return Math.atan2(fx, fz)
}

/**
 * Chassis-forward speed, m/s (negative when reversing): the chassis velocity along its +x axis. Not
 * currentVehicleSpeed(), which is |v| including the suspension's vertical bounce, signed by direction.
 */
export function forwardSpeedOf(r: { x: number; y: number; z: number; w: number }, u: { x: number; y: number; z: number }): number {
  const fx = 1 - 2 * (r.y * r.y + r.z * r.z)
  const fy = 2 * (r.x * r.y + r.w * r.z)
  const fz = 2 * (r.x * r.z - r.w * r.y)
  return u.x * fx + u.y * fy + u.z * fz
}

/**
 * Ring-0 L2 correction: scales the chassis velocity down to `max` m/s when above it (true if it did). It can only slow
 * a car down. The realm applies it after every step's substeps (simCore.ts #ring0Audit); the room's authority does the
 * same after every replayed step.
 */
export function clampSpeed(body: RAPIER.RigidBody, max: number): boolean {
  const u = body.linvel(vel)
  const speed = Math.hypot(u.x, u.y, u.z)
  // A velocity that is not a finite number is the Ring-0 audit's to name (NON_FINITE), never the clamp's to scale:
  // max/∞ is 0, and ∞·0 would invent a NaN.
  if (!(speed > max) || !(max >= 0) || !Number.isFinite(speed)) return false
  const k = max / speed
  body.setLinvel({ x: u.x * k, y: u.y * k, z: u.z * k }, true)
  return true
}

/**
 * Where the driver is put down when leaving a car whose chassis stands at (x, z) facing `heading`: EXIT_SIDE m to the
 * car's left, or to its right when the left lies in a building lot. The realm's rule (simCore.ts #interact) and the
 * room's check of it are this one function.
 */
export function exitPoint(x: number, z: number, heading: number): { x: number; z: number } {
  const lx = Math.cos(heading), lz = -Math.sin(heading)
  let ex = x + lx * EXIT_SIDE, ez = z + lz * EXIT_SIDE
  if (inLot(ex, ez, EXIT_LOT_PAD)) {
    ex = x - lx * EXIT_SIDE
    ez = z - lz * EXIT_SIDE
  }
  return { x: ex, z: ez }
}

// Scratch for the substep (no allocation per car per substep).
const vel = { x: 0, y: 0, z: 0 }
const rot = { x: 0, y: 0, z: 0, w: 1 }
const force = { x: 0, y: 0, z: 0 }

/**
 * Aerodynamic drag (½ρC_dAv², against the velocity), rolling resistance (C_rr·m·g on the wheels touching the road,
 * against the rolling direction, faded in below 0.5 m/s so it never pushes a stopped car back) and engine braking with
 * the throttle closed. Rapier keeps user forces until reset, so they are rebuilt every substep. Returns the rolling
 * (horizontal chassis-forward) speed, m/s.
 */
function roadLoads(rig: CarRig, cmd: WheelCommand, mode: DriveMode, tuning: CarTuning): number {
  const b = rig.body
  b.resetForces(false)
  b.linvel(vel)
  b.rotation(rot)
  let fx = 1 - 2 * (rot.y * rot.y + rot.z * rot.z)
  let fz = 2 * (rot.x * rot.z - rot.w * rot.y)
  const fl = Math.hypot(fx, fz)
  if (fl < 1e-3) return 0
  fx /= fl; fz /= fl
  const rolling = vel.x * fx + vel.z * fz
  const speed = Math.hypot(vel.x, vel.z)
  if (speed < 0.01) return rolling
  const c = rig.controller
  let contact = 0
  for (let w = 0; w < 4; w++) if (c.wheelIsInContact(w)) contact++
  const cda = rig.suv ? CAR.suvDragCoefficient * CAR.suvFrontalArea : CAR.dragCoefficient * CAR.frontalArea
  const aero = 0.5 * AIR_DENSITY * cda * speed * tuning.drag
  const tyre = (contact / 4) * CAR.rollingResistance * rig.mass * GRAVITY * Math.max(-1, Math.min(1, rolling / 0.5))
  const engine = mode !== 'parked' && cmd.throttle === 0 && contact > 0 ? CAR.engineBraking * rolling : 0
  force.x = -aero * vel.x - (tyre + engine) * fx
  force.y = 0
  force.z = -aero * vel.z - (tyre + engine) * fz
  b.addForce(force, false)
  return rolling
}

/** Engine force (capped by power at speed), brakes and Ackermann steering for this substep. */
function drivetrain(rig: CarRig, cmd: WheelCommand, handbrake: boolean, h: number, speed: number, tuning: CarTuning): void {
  const c = rig.controller
  const peak = CAR.engine * (rig.suv ? 1.25 : 1)
  const power = rig.suv ? CAR.suvPower : CAR.power
  const perWheel = Math.min(peak, power / 2 / Math.max(1, Math.abs(speed))) * tuning.power
  // Negative engine force drives toward chassis +x (calibrated). A wheel with engine force ignores its brake, so the
  // handbrake, or any service brake (brake overrides throttle), cuts the drive.
  const engineForce = handbrake || cmd.brake > 0 ? 0 : -cmd.throttle * perWheel
  c.setWheelEngineForce(2, engineForce)
  c.setWheelEngineForce(3, engineForce)
  // Rapier's wheel brake is the largest impulse the wheel may apply per step: decel·m·h over four wheels.
  const unit = rig.mass * h
  const service = (Math.min(KERNEL.maxBrake, Math.max(0, cmd.brake)) * unit * tuning.brake) / 4
  const rear = service + (handbrake ? (CAR.handbrake * unit * tuning.brake) / 2 : 0)
  c.setWheelBrake(0, service)
  c.setWheelBrake(1, service)
  c.setWheelBrake(2, rear)
  c.setWheelBrake(3, rear)
  c.setWheelSteering(0, ackermann(cmd.steer, -1))
  c.setWheelSteering(1, ackermann(cmd.steer, 1))
}

/**
 * One fixed substep of a car ahead of the world step: drivetrain, brakes, steering and road loads, then the raycast
 * wheels (which skip people and other chassis). The world step that follows integrates it.
 */
export function carSubstep(rig: CarRig, cmd: WheelCommand, handbrake: boolean, mode: DriveMode, tuning: CarTuning, h: number): void {
  drivetrain(rig, cmd, handbrake, h, roadLoads(rig, cmd, mode, tuning), tuning)
  rig.controller.updateVehicle(h, NOT_PEOPLE, WHEEL_RAY_GROUPS)
}

/**
 * The cars a network room holds for one player where they were left (garage.node.ts park: the oldest is let go past
 * it), and so the cars the page keeps stopped for player 1 in a room before it hands the oldest back to traffic
 * (simCore.ts): the two sides forget the same car.
 */
export const HELD_CARS = 16

/** The command a parked car's wheels hold: the brake on, nothing else (vehicles.ts think). */
export const PARKED: Readonly<WheelCommand> = Object.freeze({ throttle: 0, brake: 4, steer: 0 })

/** The authored car: no operator scale factor (vehicles.ts setTuning moves these within CAR_TUNE_RANGE). */
export const AUTHORED: Readonly<CarTuning> = Object.freeze({ power: 1, drag: 1, grip: 1, brake: 1 })

/** Body colours, 0xRRGGBB (sRGB). Picked from the seeded stream in spawn order, so every car keeps its colour. */
const PAINT = [0xf2f2f0, 0x111214, 0xa9adb3, 0x5c6168, 0x1d2f55, 0x7a1a1f, 0x2d3e33, 0xc9c1ad, 0x2a4f7a, 0x3a3a3c]

/** One car of the fleet's seeded plan: where it starts, whether it is an SUV, its AI driver, its paint, and its ring (−1: none). */
export interface PlannedCar {
  pose: { x: number; z: number; heading: number }
  suv: boolean
  driver: DriverLike
  paint: number
  /** The ring it is seated on (an index into network.tracks), or −1 on random streets. */
  track: number
}

/**
 * The fleet of `count` cars as the seed lays it out, drawn from one seeded stream in spawn order: on a track network,
 * a headway seat per car (assignSlots) on a straight clear of every intersection box; otherwise a random street
 * segment and direction, spaced so no two cars start on the same stretch. The fleet (vehicles.ts) builds its cars from
 * this plan; the room's authority reads which car is an SUV and which ring it was seated on from the same plan, so
 * both agree on every car without a word on the wire. The returned stream goes on to drive the AI.
 */
export function planFleet(count: number, seed: number, network: TrackNetwork | null): { cars: PlannedCar[]; rng: () => number } {
  const rng = createRng(seed ^ 0xca75)
  const cars: PlannedCar[] = []
  const used = new Set<string>()
  const seatsOf = network ? assignSlots(network, count, rng) : null
  for (let i = 0; i < count; i++) {
    let pose: { x: number; z: number; heading: number }
    let suv: boolean
    let driver: DriverLike
    let track = -1
    if (network && seatsOf) {
      const seat = seatsOf[i]
      const t = network.tracks[seat.track]
      pose = poseAt(t, seat.s)
      suv = rng() < 0.3
      driver = new TrackDriver(t, seat.s, rng)
      track = seat.track
    } else {
      let from: [number, number] = [0, 0], dir: [number, number] = [1, 0], slot = ''
      for (let tries = 0; tries < 50; tries++) {
        const line = Math.floor(rng() * (CITY.blocks + 1))
        const seg = Math.floor(rng() * CITY.blocks)
        const sign = rng() < 0.5 ? 1 : -1
        if (rng() < 0.5) {
          dir = [sign, 0]
          from = [sign > 0 ? seg : seg + 1, line]
        } else {
          dir = [0, sign]
          from = [line, sign > 0 ? seg : seg + 1]
        }
        slot = `${from},${dir}`
        if (!used.has(slot)) break
      }
      used.add(slot)
      const [k, m] = from
      const s = 12 + rng() * 10
      pose = Driver.lanePose([k, m], dir, s)
      suv = rng() < 0.3
      driver = new Driver([k, m], dir, rng)
    }
    const paint = PAINT[Math.floor(rng() * PAINT.length)]
    cars.push({ pose, suv, driver, paint, track })
  }
  return { cars, rng }
}
