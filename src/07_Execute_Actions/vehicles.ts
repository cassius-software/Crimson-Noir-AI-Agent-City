/**
 * Why does this file exist? It is the vehicle fleet: Rapier raycast-vehicle sedans and SUVs with strict
 * CCD on the chassis, driven by the AI (06_Make_Decisions/traffic.ts on random streets, or trackDriver.ts on
 * the fixed rings of tracks.ts when a network is given: the cars are then seated in headway slots and each
 * reads its own ring's gap beside its bonnet rays, which skip the cars on tracks) or by the player. A chassis is solid
 * to the ground, the buildings and people, and cars pass through cars: the collision groups of
 * 02_Define_The_Rules/collision.ts drop every chassis-chassis pair, on the chassis and on the wheel rays.
 * Every command is vetted by the Ring-0 bouncer (02_Define_The_Rules/laws.ts) before it reaches the wheels,
 * using the people in each car's sensing corridor (the GPU crowd's readback plus the avatar, measured here).
 * It adds what the raycast model lacks — Ackermann steering, aerodynamic drag, rolling resistance, engine
 * braking, a power limit. It runs inside the physics worker (simCore.ts): the page only ever receives the
 * packed poses writePoses() produces, and draws them (fleetView.ts).
 * What breaks if it is removed? There are no cars to watch, dodge or drive, and nothing keeps a car
 * from driving into a person.
 */
import { RAPIER, type Physics } from './physics.ts'
import { CAR, CAR_TUNE_RANGE, chassisBox, clampTuning, RIDE_HEIGHT, WHEELS, type CarTuning, type DriveMode } from './car.ts'
import { MODES, POSE } from './simProtocol.ts'
import type { VehicleFootprint } from './sanctuary.ts'
import { Driver, type DriverCommand, type DriverLike, type DriverPose } from '../06_Make_Decisions/traffic.ts'
import { TrackDriver } from '../06_Make_Decisions/trackDriver.ts'
import { assignSlots, poseAt, type TrackNetwork } from '../06_Make_Decisions/tracks.ts'
import { CITY } from '../01_Initialize_World/city.ts'
import { KERNEL } from '../02_Define_The_Rules/civic.ts'
import { VEHICLE_CHASSIS_GROUPS, WHEEL_RAY_GROUPS } from '../02_Define_The_Rules/collision.ts'
import { createRng } from '../02_Define_The_Rules/degrees.ts'
import { Bouncer, type Intent, type Situation } from '../02_Define_The_Rules/laws.ts'
import type { CarState } from '../03_Spawn_Agents/crowdCompute.ts'

export { CAR, CAR_TUNE_RANGE, type CarTuning, type DriveMode }

const AIR_DENSITY = 1.225
const GRAVITY = 9.81
const TAU = Math.PI * 2
/** Lateral offsets of the obstacle rays across the bonnet. */
const GAP_RAYS = [-0.6, 0, 0.6] as const
/**
 * People are kinematic bodies (the avatar), sensors while the sanctuary shields them: wheels never roll on
 * them (Rapier's wheel rays hit both by default, so a car would ride up over a shielded person), and the
 * obstacle rays skip them because people reach the bouncer through the sensing corridor instead.
 */
const NOT_PEOPLE = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC
/** Speed below which a vehicle counts as standing, m/s (laws.ts uses the same threshold). */
const AT_REST = 0.05
/** A car held by emergency braking stays held at a standstill while the person is this close, m. */
const HOLD_CLEAR = KERNEL.standoff + 0.5
/** Reach of the bonnet obstacle rays, m. */
const GAP_RANGE = 22
/** A parked car this far (lateral, m) off its ring or nearer counts in the ring's order; further, it stands elsewhere. */
const ON_LANE = 3

export interface Vehicle {
  /** Slot in the Fleet (its rig, its footprint). Fixed at creation: a rewritten index cannot re-point a vehicle at another car. */
  readonly index: number
  driver: DriverLike
  mode: DriveMode
  suv: boolean
  /** kg */
  mass: number
  /** Bicycle-model steering angle the driver (AI or player) is holding, radians, positive = left. */
  steer: number
  /**
   * A copy of the last command the bouncer let through, for telemetry (e.g. brake feedback). The wheels
   * follow the Fleet's own copy, so writing here cannot bypass the bouncer.
   */
  lastCommand: DriverCommand
  handbrake: boolean
}

/** A vehicle's Rapier handles. They never leave the Fleet, except through rig() on a Fleet built with exposeRig. */
interface Rig {
  body: RAPIER.RigidBody
  collider: RAPIER.Collider
  controller: RAPIER.DynamicRayCastVehicleController
}

export interface FleetOptions {
  /** Tests and the ?debug harness only: rig() hands out the raw Rapier handles. Off in production pages. */
  exposeRig?: boolean
  /**
   * The fixed track network (tracks.ts): the cars are seated in its headway slots and driven by TrackDrivers on
   * their rings. Absent, every car takes the random street-hopping Driver, exactly as before.
   */
  network?: TrackNetwork
}

/**
 * Ackermann steering: the inner front wheel turns tighter so both front wheels roll about the rear axle's
 * turn centre. `steer` is the bicycle-model angle (positive = left); `side` is +1 for the left wheel and
 * −1 for the right one.
 */
export function ackermann(steer: number, side: 1 | -1): number {
  const t = Math.tan(steer)
  return Math.atan((CAR.wheelbase * t) / (CAR.wheelbase - side * (CAR.track / 2) * t))
}

/** A whole turn, normalised to [0, 2π), with a turn a hair short of 2π read as none (rounding at contact). */
function clockwise(angle: number): number {
  const t = angle - TAU * Math.floor(angle / TAU)
  return t > TAU - 1e-9 ? 0 : t
}

/**
 * Metres a vehicle travels (along its rear axle's path) before any part of its footprint, widened by
 * `KERNEL.corridor` either side, reaches a person at (px, pz); Infinity beyond `KERNEL.range` or never.
 * `dir` 1 is driving forward, −1 reversing; either way the result is the distance from the leading bumper
 * when the path is straight. On a steer of `curvature` (tan(steer) / wheelbase, positive = left) the
 * chassis turns rigidly about the rear axle's turn centre (the kinematic bicycle model), so the body is
 * swept exactly: the front swings toward the turn at once and the inner side cuts the corner. (A path
 * circle tangent at the bumper, or its parabola curvature·s²/2, omits the bumper's lead over the rear
 * axle, a lateral term (halfLength + wheelbase/2)·curvature·s, and misses most people in a turn.) A person
 * inside the widened footprint is 0 m away both ways: the car must not move.
 */
export function corridorDistance(px: number, pz: number, cx: number, cz: number, heading: number, curvature: number, dir: 1 | -1): number {
  const fx = Math.sin(heading), fz = Math.cos(heading)
  const dx = px - cx, dz = pz - cz
  // Travel frame: u along the direction of travel, lateral to the car's left.
  const u = (dx * fx + dz * fz) * dir
  const lateral = dx * fz - dz * fx
  const hl = CAR.halfLength
  const half = CAR.halfWidth + KERNEL.corridor
  if (Math.abs(u) <= hl && Math.abs(lateral) <= half) return 0
  const k = Math.abs(curvature)
  // Straight, and the fallback for a curvature that is not a number.
  if (!(k >= 1e-6)) {
    const s = u - hl
    return s >= 0 && s <= KERNEL.range && Math.abs(lateral) <= half ? s : Infinity
  }
  const r = 1 / k
  // A footprint point at ρ from the turn centre moves 2ρ·sin(θ/2) ≤ min(2ρ, ρ·range/r) before the car has
  // travelled the range: anyone farther from the car's centre than that cannot be reached.
  const rhoMax = Math.hypot(hl + CAR.wheelbase / 2, r + half)
  const reach = Math.hypot(hl, half) + Math.min(2 * rhoMax, (rhoMax * KERNEL.range) / r)
  if (dx * dx + dz * dz > reach * reach) return Infinity
  // Mirror a right turn onto a left one: the turn centre is then at lateral +r, level with the rear axle
  // (behind the centre driving forward, ahead of it in the travel frame when reversing). Travel turns the
  // car counter-clockwise about it, so the person turns clockwise about it relative to the car.
  const l = curvature > 0 ? lateral : -lateral
  const au = (-dir * CAR.wheelbase) / 2
  // The person's circle about the turn centre, in polar form: (au + ρ·cos φ, r + ρ·sin φ), starting at φ0.
  // First contact is the smallest clockwise turn onto an edge of the footprint. Each edge crossing comes
  // from a discriminant factored so nothing cancels when r is huge (gentle curvature; also safe in f32).
  const phi0 = Math.atan2(l - r, u - au)
  let best = Infinity
  for (let e = -1; e <= 1; e += 2) {
    // An end, u = ±halfLength: the circle crosses it at lateral r ± q.
    const end = e * hl
    const du = (u - end) * (u + end - 2 * au)
    const d = (l - r) * (l - r) + du
    if (d >= 0) {
      const q = Math.sqrt(d)
      const near = (l * (2 * r - l) - du) / (r + q) // r − q without the cancellation
      if (Math.abs(r + q) <= half + 1e-9) best = Math.min(best, clockwise(phi0 - Math.atan2(q, end - au)))
      if (Math.abs(near) <= half + 1e-9) best = Math.min(best, clockwise(phi0 - Math.atan2(-q, end - au)))
    }
    // A side, lateral ±half: the circle crosses it at u = au ± q.
    const side = e * half
    const d2 = (u - au) * (u - au) + (l - side) * (l + side - 2 * r)
    if (d2 >= 0) {
      const q = Math.sqrt(d2)
      if (Math.abs(au + q) <= hl + 1e-9) best = Math.min(best, clockwise(phi0 - Math.atan2(side - r, q)))
      if (Math.abs(au - q) <= hl + 1e-9) best = Math.min(best, clockwise(phi0 - Math.atan2(side - r, -q)))
    }
  }
  const travel = best * r
  return travel <= KERNEL.range ? travel : Infinity
}

const reading = (m: number): number => (Number.isNaN(m) ? Infinity : Math.max(0, m))

/** Throttle −1..1, brake 0..KERNEL.maxBrake, steer ±CAR.maxSteer; NaN is 0 and ±Infinity the limit. */
function sanitize(src: Intent, dst: Intent): Intent {
  const t = src.throttle, b = src.brake, s = src.steer
  dst.throttle = t > 0 ? Math.min(1, t) : t < 0 ? Math.max(-1, t) : 0
  dst.brake = b > 0 ? Math.min(KERNEL.maxBrake, b) : 0
  dst.steer = s > 0 ? Math.min(CAR.maxSteer, s) : s < 0 ? Math.max(-CAR.maxSteer, s) : 0
  return dst
}

/** Body colours, 0xRRGGBB (sRGB). Picked from the seeded stream in spawn order, so every car keeps its colour. */
const PAINT = [0xf2f2f0, 0x111214, 0xa9adb3, 0x5c6168, 0x1d2f55, 0x7a1a1f, 0x2d3e33, 0xc9c1ad, 0x2a4f7a, 0x3a3a3c]

/** A rotation of `angle` about +y as a quaternion (the chassis only ever spawns or recovers upright). */
function yawQuat(angle: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) }
}

export class Fleet {
  readonly vehicles: Vehicle[] = []
  /** Body colour per vehicle, 0xRRGGBB (sRGB), for whoever draws the fleet. */
  readonly paint: readonly number[]
  /** Ring-0: every command reaching the wheels passes through here first. */
  readonly bouncer = new Bouncer()
  /** Operator scale factors (see CarTuning); written only by setTuning(), which clamps and re-applies grip. */
  readonly #tuning: CarTuning = { power: 1, drag: 1, grip: 1, brake: 1 }
  /** Per vehicle index: the Rapier handles. Unreachable from outside the class (runtime-private). */
  readonly #rigs: Rig[] = []
  readonly #exposeRig: boolean
  readonly #physics: Physics
  readonly #rng: () => number
  /** The track network the fleet was seated on (null: random streets). */
  readonly #network: TrackNetwork | null
  /** Per vehicle: the bumper gap to the car ahead on its ring this frame (Infinity: alone, or not on a ring). */
  readonly #trackGap: Float64Array
  /** Scratch: the vehicles on rings this frame, sorted by (track, arc length). */
  readonly #ringOrder: number[] = []
  /** Collider handle -> vehicle index, for the bonnet rays' filter. */
  readonly #byCollider = new Map<number, number>()
  readonly #ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })
  /** The bonnet rays' filter on a track: a chassis on a ring is not an obstacle (the ring gap places it exactly). */
  readonly #notOnTrack = (c: RAPIER.Collider): boolean => {
    const i = this.#byCollider.get(c.handle)
    return i === undefined || !this.#onRing(this.vehicles[i])
  }
  readonly #states: CarState[] = []
  readonly #prints: VehicleFootprint[] = []
  /** Per-vehicle metres to the nearest pedestrian from the GPU crowd (Infinity = none). */
  readonly #crowdAhead: Float32Array
  readonly #crowdBehind: Float32Array
  readonly #avatar = { x: 0, z: 0, present: false }
  /** Per vehicle: emergency braking latched by the First Law, 1 moving forward, −1 reversing, 0 off. */
  readonly #emergency: Int8Array
  /** Per vehicle: the vetted command the wheels follow (only apply() writes it). */
  readonly #commands: Intent[] = []
  /**
   * Per vehicle: the steer the driver is heading for — the AI's unsmoothed pure-pursuit steer, the player's
   * latest input — so the corridor also covers the turn the car is steering into, not only the current lock.
   */
  readonly #aim: Float64Array
  /** Per vehicle: drive() was called since the last think() (a player's car without input is re-vetted there). */
  readonly #driven: Uint8Array
  // Scratch, so the per-frame and per-substep paths do not allocate.
  readonly #pose: DriverPose = { x: 0, z: 0, heading: 0, speed: 0 }
  readonly #intent: Intent = { throttle: 0, brake: 0, steer: 0 }
  readonly #clean: Intent = { throttle: 0, brake: 0, steer: 0 }
  readonly #latched: Intent = { throttle: 0, brake: 0, steer: 0 }
  readonly #guarded: Intent = { throttle: 0, brake: 0, steer: 0 }
  readonly #situation: Situation = { source: 'ai', speed: 0, personAhead: Infinity, personBehind: Infinity, obstacleAhead: Infinity }
  readonly #pos = { x: 0, y: 0, z: 0 }
  readonly #vel = { x: 0, y: 0, z: 0 }
  readonly #force = { x: 0, y: 0, z: 0 }
  readonly #rot = { x: 0, y: 0, z: 0, w: 1 }

  constructor(physics: Physics, count: number, seed: number, opts: FleetOptions = {}) {
    this.#exposeRig = opts.exposeRig === true
    this.#physics = physics
    this.#rng = createRng(seed ^ 0xca75)
    this.#network = opts.network ?? null
    this.#trackGap = new Float64Array(count).fill(Infinity)
    this.#crowdAhead = new Float32Array(count).fill(Infinity)
    this.#crowdBehind = new Float32Array(count).fill(Infinity)
    this.#emergency = new Int8Array(count)
    this.#aim = new Float64Array(count)
    this.#driven = new Uint8Array(count)

    const paint: number[] = []
    const used = new Set<string>()
    // On a network: a headway seat per car, on a straight clear of every intersection box, from the same stream.
    const seatsOf = this.#network ? assignSlots(this.#network, count, this.#rng) : null
    for (let i = 0; i < count; i++) {
      let pose: { x: number; z: number; heading: number }
      let suv: boolean
      let driver: DriverLike
      if (this.#network && seatsOf) {
        const seat = seatsOf[i]
        const track = this.#network.tracks[seat.track]
        pose = poseAt(track, seat.s)
        suv = this.#rng() < 0.3
        driver = new TrackDriver(track, seat.s, this.#rng)
      } else {
        // A random street segment and direction, spaced so no two cars start on the same stretch.
        let from: [number, number] = [0, 0], dir: [number, number] = [1, 0], slot = ''
        for (let tries = 0; tries < 50; tries++) {
          const line = Math.floor(this.#rng() * (CITY.blocks + 1))
          const seg = Math.floor(this.#rng() * CITY.blocks)
          const sign = this.#rng() < 0.5 ? 1 : -1
          if (this.#rng() < 0.5) {
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
        const s = 12 + this.#rng() * 10
        pose = Driver.lanePose([k, m], dir, s)
        suv = this.#rng() < 0.3
        driver = new Driver([k, m], dir, this.#rng)
      }
      const vehicle = this.#create(i, pose.x, pose.z, pose.heading, suv, driver)
      paint.push(PAINT[Math.floor(this.#rng() * PAINT.length)])
      this.vehicles.push(vehicle)
      this.#commands.push({ throttle: 0, brake: 0, steer: 0 })
      this.#states.push({ x: pose.x, z: pose.z, heading: pose.heading, speed: 0, halfWidth: CAR.halfWidth, halfLength: CAR.halfLength, curvature: 0 })
      this.#prints.push({ id: i, x: pose.x, z: pose.z, vx: 0, vz: 0, wy: 0, active: true, halfLength: CAR.halfLength, halfWidth: CAR.halfWidth, speed: 0, heading: pose.heading })
    }
    this.paint = Object.freeze(paint)
    // Runtime integrity: no method or field can be replaced, so drive()/think() stay the only way to the wheels.
    Object.freeze(this.vehicles)
    Object.freeze(this)
  }

  #create(index: number, x: number, z: number, heading: number, suv: boolean, driver: DriverLike): Vehicle {
    const world = this.#physics.world
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
    for (const [wx, wz] of WHEELS) controller.addWheel({ x: wx, y: 0, z: wz }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: -1 }, CAR.suspension, CAR.wheelRadius)
    for (let i = 0; i < 4; i++) {
      controller.setWheelSuspensionStiffness(i, 30)
      controller.setWheelSuspensionCompression(i, 2.3)
      controller.setWheelSuspensionRelaxation(i, 3.2)
      controller.setWheelMaxSuspensionForce(i, 40000)
      controller.setWheelFrictionSlip(i, CAR.frictionSlip)
      controller.setWheelSideFrictionStiffness(i, 1.0)
    }
    this.#rigs[index] = { body, collider, controller }
    this.#byCollider.set(collider.handle, index)
    const vehicle: Vehicle = {
      index, driver, mode: 'ai', suv, mass, steer: 0,
      lastCommand: { throttle: 0, brake: 0, steer: 0 }, handbrake: false,
    }
    return Object.defineProperty(vehicle, 'index', { writable: false, configurable: false })
  }

  heading(v: Vehicle): number {
    const r = this.#rigs[v.index].body.rotation(this.#rot)
    // Chassis +x is forward.
    const fx = 1 - 2 * (r.y * r.y + r.z * r.z)
    const fz = 2 * (r.x * r.z - r.w * r.y)
    return Math.atan2(fx, fz)
  }

  /**
   * Chassis-forward speed, m/s (negative when reversing): the chassis velocity along its +x axis. Not
   * currentVehicleSpeed(), which is |v| including the suspension's vertical bounce, signed by direction —
   * it reads ±0.06 m/s on a car at rest, enough to flip the bouncer between forward and reverse.
   */
  speed(v: Vehicle): number {
    const r = this.#rigs[v.index].body.rotation(this.#rot)
    const u = this.#rigs[v.index].body.linvel(this.#vel)
    const fx = 1 - 2 * (r.y * r.y + r.z * r.z)
    const fy = 2 * (r.x * r.y + r.w * r.z)
    const fz = 2 * (r.x * r.z - r.w * r.y)
    return u.x * fx + u.y * fy + u.z * fz
  }

  /** Operator scale factors, as a frozen copy: writing to it changes nothing (use setTuning). */
  get tuning(): Readonly<CarTuning> {
    return Object.freeze({ ...this.#tuning })
  }

  /** Chassis centre, m, copied into `out` (a new object without it): plain numbers, never a Rapier reference. */
  position(v: Vehicle, out: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }): { x: number; y: number; z: number } {
    const t = this.#rigs[v.index].body.translation(this.#pos)
    out.x = t.x; out.y = t.y; out.z = t.z
    return out
  }

  /** Chassis orientation (quaternion), copied into `out`. */
  rotation(v: Vehicle, out: { x: number; y: number; z: number; w: number } = { x: 0, y: 0, z: 0, w: 1 }): { x: number; y: number; z: number; w: number } {
    const r = this.#rigs[v.index].body.rotation(this.#rot)
    out.x = r.x; out.y = r.y; out.z = r.z; out.w = r.w
    return out
  }

  /** Chassis linear velocity, m/s, copied into `out`. */
  velocity(v: Vehicle, out: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }): { x: number; y: number; z: number } {
    const u = this.#rigs[v.index].body.linvel(this.#vel)
    out.x = u.x; out.y = u.y; out.z = u.z
    return out
  }

  /**
   * Ring-0 L2 correction: scales the chassis velocity down to `max` m/s when above it (true if it did). The
   * only velocity write outside the vetted drivetrain, and it can only slow a car down.
   */
  clampSpeed(v: Vehicle, max: number): boolean {
    const b = this.#rigs[v.index].body
    const u = b.linvel(this.#vel)
    const speed = Math.hypot(u.x, u.y, u.z)
    if (!(speed > max) || !(max >= 0)) return false
    const k = max / speed
    b.setLinvel({ x: u.x * k, y: u.y * k, z: u.z * k }, true)
    return true
  }

  /** The raw Rapier handles: only on a Fleet built with exposeRig (tests, the ?debug harness); throws otherwise. */
  rig(v: Vehicle): Readonly<Rig> {
    if (!this.#exposeRig) throw new Error('rig(): the Rapier handles are private to the Fleet')
    return this.#rigs[v.index]
  }

  /** Path curvature of the steer the wheels are following, 1/m (tan(steer) / wheelbase; positive = left). */
  curvature(v: Vehicle): number {
    return Math.tan(this.#commands[v.index].steer) / CAR.wheelbase
  }

  /** True when the chassis is on its side or roof. */
  flipped(v: Vehicle): boolean {
    const r = this.#rigs[v.index].body.rotation(this.#rot)
    return 1 - 2 * (r.x * r.x + r.z * r.z) < 0.35
  }

  /** Arcade recovery: set the car back on its wheels, facing the same way. */
  recover(v: Vehicle, x?: number, z?: number, heading?: number): void {
    if ([x, z, heading].some((n) => n !== undefined && !Number.isFinite(n))) return
    const t = this.#rigs[v.index].body.translation(this.#pos)
    this.#rigs[v.index].body.setTranslation({ x: x ?? t.x, y: RIDE_HEIGHT + 0.4, z: z ?? t.z }, true)
    this.#rigs[v.index].body.setRotation(yawQuat((heading ?? this.heading(v)) - Math.PI / 2), true)
    this.#rigs[v.index].body.setLinvel({ x: 0, y: 0, z: 0 }, true)
    this.#rigs[v.index].body.setAngvel({ x: 0, y: 0, z: 0 }, true)
  }

  /** Free road ahead of the front bumper to a car, wall or pole, from rays at bonnet height (people excluded). */
  gapAhead(v: Vehicle): number {
    return this.#gapAhead(v, false)
  }

  /**
   * The bonnet rays; with `skipTracked`, the chassis of every car on a ring is never found. A track follower reads
   * its own ring's gap for those (exact, through corners) and keeps the rays for walls, poles and cars off the
   * rings: from the apex of a right turn the rays sweep the cross street's queue head at 2.4 m though the two
   * bodies never meet (tracks.test.ts), which would stop every turning car and have the Third Law rule at every corner.
   */
  #gapAhead(v: Vehicle, skipTracked: boolean): number {
    const t = this.#rigs[v.index].body.translation(this.#pos)
    const h = this.heading(v)
    const fx = Math.sin(h), fz = Math.cos(h)
    const ox = t.x + fx * (CAR.halfLength + 0.1), oz = t.z + fz * (CAR.halfLength + 0.1)
    let best = Infinity
    for (const side of GAP_RAYS) {
      let toi: number | null
      if (skipTracked) {
        const ray = this.#ray
        ray.origin.x = ox - fz * side; ray.origin.y = 0.7; ray.origin.z = oz + fx * side
        ray.dir.x = fx; ray.dir.y = 0; ray.dir.z = fz
        const hit = this.#physics.world.castRay(ray, GAP_RANGE, true, NOT_PEOPLE, undefined, undefined, this.#rigs[v.index].body, this.#notOnTrack)
        toi = hit ? hit.timeOfImpact : null
      } else {
        toi = this.#physics.castRay(ox - fz * side, 0.7, oz + fx * side, fx, 0, fz, GAP_RANGE, this.#rigs[v.index].body, NOT_PEOPLE)
      }
      if (toi !== null && toi < best) best = toi
    }
    return best
  }

  /** True for a car a track follower drives or has parked on its ring: placed by its ring's order, not by a ray. */
  #onRing(v: Vehicle): boolean {
    return v.driver instanceof TrackDriver && v.mode !== 'player'
  }

  /**
   * Every ring's order this frame: the cars on tracks (AI at their last projection, parked ones re-projected and
   * counted only while on their lane) sorted by (track, arc length), then the bumper gap ahead of each within its
   * ring, wrapping (the rule of tracks.ts ringGaps; Infinity alone). Player-driven cars are left to the rays. A car
   * steering back to its ring from off it (rejoining: set down elsewhere, say by a harness) is not in the order
   * either: its projection names a point on the ring where no car stands, and a follower would queue behind it.
   */
  #ringGaps(): void {
    const order = this.#ringOrder
    order.length = 0
    this.#trackGap.fill(Infinity)
    for (const v of this.vehicles) {
      if (!this.#onRing(v)) continue
      const driver = v.driver as TrackDriver
      if (v.mode === 'parked') {
        const t = this.#rigs[v.index].body.translation(this.#pos)
        if (Math.abs(driver.locate(t.x, t.z).lateral) > ON_LANE) continue
      } else if (driver.rejoining) continue
      order.push(v.index)
    }
    const at = (i: number) => this.vehicles[i].driver as TrackDriver
    order.sort((a, b) => at(a).track - at(b).track || at(a).progress - at(b).progress)
    const network = this.#network
    if (!network) return
    for (let a = 0; a < order.length;) {
      const track = at(order[a]).track
      let b = a + 1
      while (b < order.length && at(order[b]).track === track) b++
      if (b - a > 1) {
        const L = network.tracks[track].length
        for (let k = a; k < b; k++) {
          const ahead = k + 1 < b ? at(order[k + 1]).progress : at(order[a]).progress + L
          this.#trackGap[order[k]] = ahead - at(order[k]).progress - 2 * CAR.halfLength
        }
      }
      a = b
    }
  }

  /**
   * Pedestrian distances from the GPU crowd, per vehicle index, metres from the bumper (Infinity = none).
   * Vehicles past the end of either array have no reading; a negative distance (overlap) counts as 0.
   */
  setPersonHazards(ahead: ArrayLike<number>, behind: ArrayLike<number>): void {
    const n = this.vehicles.length
    for (let i = 0; i < n; i++) {
      this.#crowdAhead[i] = i < ahead.length ? reading(ahead[i]) : Infinity
      this.#crowdBehind[i] = i < behind.length ? reading(behind[i]) : Infinity
    }
  }

  /** The player's avatar, which the CPU knows exactly (`present` false while it is inside a car). */
  setAvatar(x: number, z: number, present: boolean): void {
    this.#avatar.x = x
    this.#avatar.z = z
    this.#avatar.present = present
  }

  /**
   * Metres from the front bumper to the nearest person in the forward corridor (Infinity = none): the
   * GPU crowd's reading, or the avatar on the current steer or the one the driver is heading for.
   */
  personAhead(v: Vehicle): number {
    return this.#personIn(v, 1, this.#commands[v.index].steer)
  }

  /** Metres from the rear bumper to the nearest person in the rear corridor (Infinity = none). */
  personBehind(v: Vehicle): number {
    return this.#personIn(v, -1, this.#commands[v.index].steer)
  }

  /**
   * The player's controls, once per frame while driving: vetted by the bouncer (Second Law standing), then
   * sent to the wheels. A player's car that misses a frame's drive() coasts, re-vetted, from think().
   */
  drive(v: Vehicle, intent: Intent, handbrake: boolean): void {
    const clean = sanitize(intent, this.#clean)
    this.#aim[v.index] = clean.steer
    this.#driven[v.index] = 1
    this.#apply(v, this.#vet(v, clean, 'player', this.gapAhead(v)), handbrake)
  }

  /**
   * Once per rendered frame ahead of the physics substeps: AI decisions, parked cars held, and a player's car
   * that received no drive() since the last think() re-vetted with the throttle closed (a stale command is
   * never left standing while the people around it move).
   */
  think(dt: number, signalSeconds: number): void {
    const intent = this.#intent
    if (this.#network) this.#ringGaps()
    for (const v of this.vehicles) {
      const i = v.index
      const fresh = this.#driven[i] === 1
      this.#driven[i] = 0
      if (v.mode === 'parked') {
        intent.throttle = 0; intent.brake = 4; intent.steer = 0
        this.#aim[i] = 0
        this.#apply(v, this.#vet(v, intent, 'ai', Infinity), false)
        continue
      }
      if (v.mode === 'player') {
        if (fresh) continue
        intent.throttle = 0; intent.brake = 0; intent.steer = this.#commands[i].steer
        this.#aim[i] = intent.steer
        this.#apply(v, this.#vet(v, intent, 'player', this.gapAhead(v)), v.handbrake)
        continue
      }
      if (this.flipped(v)) this.recover(v)
      const t = this.#rigs[v.index].body.translation(this.#pos)
      const p = this.#pose
      p.x = t.x; p.z = t.z; p.heading = this.heading(v); p.speed = this.speed(v)
      // On a ring: the least of the rays (walls, poles, cars off the rings) and the ring's own gap ahead; the same
      // number is the driver's following gap and the bouncer's obstacleAhead.
      const onRing = this.#onRing(v)
      if (onRing) (v.driver as TrackDriver).ringGap = this.#trackGap[i]
      const gap = onRing ? Math.min(this.#gapAhead(v, true), this.#trackGap[i]) : this.gapAhead(v)
      const cmd = v.driver.command(p, signalSeconds, gap, dt, this.personAhead(v))
      this.#aim[i] = Number.isFinite(cmd.steer) ? cmd.steer : 0
      // Smooth the wheel so pure pursuit does not twitch.
      if (!Number.isFinite(v.steer)) v.steer = 0
      v.steer += (this.#aim[i] - v.steer) * Math.min(1, dt * 6)
      intent.throttle = cmd.throttle; intent.brake = cmd.brake; intent.steer = v.steer
      this.#apply(v, this.#vet(v, intent, 'ai', gap), false)
      if (v.driver.stuckSeconds > 8) {
        v.driver.stuckSeconds = 0
        this.recover(v)
      }
    }
  }

  /** Runs inside each physics substep: drivetrain, brakes, steering and road loads, then the raycast wheels. */
  updateControllers(h: number): void {
    for (const v of this.vehicles) {
      this.#drivetrain(v, h, this.#roadLoads(v))
      // The wheel rays skip people (flags) and other chassis (groups): a car never rides up on a car it passes through.
      this.#rigs[v.index].controller.updateVehicle(h, NOT_PEOPLE, WHEEL_RAY_GROUPS)
    }
  }

  /** Vehicle footprints for the GPU crowd (yielding, hazard sensing and the safety nudge). */
  crowdStates(): CarState[] {
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i]
      const t = this.#rigs[v.index].body.translation(this.#pos)
      const s = this.#states[i]
      s.x = t.x; s.z = t.z; s.heading = this.heading(v); s.speed = this.speed(v); s.curvature = this.curvature(v)
    }
    return this.#states
  }

  /** Vehicle footprints for the Sanctuary (`id` = vehicle index). The array and its objects are reused. */
  footprints(): VehicleFootprint[] {
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i], rig = this.#rigs[i], f = this.#prints[i]
      const t = rig.body.translation(this.#pos)
      f.x = t.x; f.z = t.z
      const lv = rig.body.linvel(this.#vel)
      f.vx = lv.x; f.vz = lv.z
      f.wy = rig.body.angvel(this.#force).y
      f.active = rig.collider.isEnabled()
      f.speed = this.speed(v)
      f.heading = this.heading(v)
    }
    return this.#prints
  }

  nearest(x: number, z: number, maxDistance: number): Vehicle | null {
    let best: Vehicle | null = null
    let bestD = maxDistance
    for (const v of this.vehicles) {
      const t = this.#rigs[v.index].body.translation(this.#pos)
      const d = Math.hypot(t.x - x, t.z - z)
      if (d < bestD) { bestD = d; best = v }
    }
    return best
  }

  /**
   * Packs every vehicle into `out` (POSE layout, simProtocol.ts): chassis position, orientation, heading, speed,
   * curvature, the vetted throttle and brake, the drive mode, the velocity and each wheel's suspension, rolling
   * and steering angles. Plain numbers only: this is all the page ever learns of a car.
   */
  writePoses(out: Float32Array): Float32Array {
    for (const v of this.vehicles) {
      const o = v.index * POSE.stride
      const rig = this.#rigs[v.index]
      const t = rig.body.translation(this.#pos)
      out[o + POSE.x] = t.x; out[o + POSE.y] = t.y; out[o + POSE.z] = t.z
      const r = rig.body.rotation(this.#rot)
      out[o + POSE.qx] = r.x; out[o + POSE.qy] = r.y; out[o + POSE.qz] = r.z; out[o + POSE.qw] = r.w
      out[o + POSE.heading] = this.heading(v)
      out[o + POSE.speed] = this.speed(v)
      out[o + POSE.curvature] = this.curvature(v)
      const cmd = this.#commands[v.index]
      out[o + POSE.throttle] = cmd.throttle
      out[o + POSE.brake] = cmd.brake
      out[o + POSE.mode] = MODES.indexOf(v.mode)
      const u = rig.body.linvel(this.#vel)
      out[o + POSE.vx] = u.x; out[o + POSE.vy] = u.y; out[o + POSE.vz] = u.z
      const c = rig.controller
      for (let w = 0; w < 4; w++) {
        const k = o + POSE.wheels + 3 * w
        out[k] = c.wheelSuspensionLength(w) ?? CAR.suspension
        out[k + 1] = c.wheelRotation(w) ?? 0
        out[k + 2] = c.wheelSteering(w) ?? 0
      }
    }
    return out
  }

  /**
   * The nearest person in the corridor: the GPU crowd's reading, or the avatar on either `steer` (the lock
   * the wheels hold now, or the one a new command sets) or the steer the driver is heading for.
   */
  #personIn(v: Vehicle, dir: 1 | -1, steer: number): number {
    const crowd = dir > 0 ? this.#crowdAhead[v.index] : this.#crowdBehind[v.index]
    const a = this.#avatar
    if (!a.present) return crowd
    const t = this.#rigs[v.index].body.translation(this.#pos)
    const h = this.heading(v)
    const now = corridorDistance(a.x, a.z, t.x, t.z, h, Math.tan(steer) / CAR.wheelbase, dir)
    const aim = this.#aim[v.index]
    const next = aim === steer ? now : corridorDistance(a.x, a.z, t.x, t.z, h, Math.tan(aim) / CAR.wheelbase, dir)
    return Math.min(crowd, now, next)
  }

  /**
   * Every command passes the bouncer here, sanitised first (a NaN must never reach Rapier or slip past a
   * comparison). The corridor is measured on the steer the command sets. Once the First Law has stopped a
   * moving vehicle, emergency braking holds: throttle closed and full brake to a standstill, and at a
   * standstill no throttle toward the person while they stand within `HOLD_CLEAR`. Without it, braking
   * harder than the envelope assumes releases the hold early and lets the throttle back in, pulsing toward
   * the person. Moving away from them, or the person leaving the path, releases it.
   */
  #vet(v: Vehicle, intent: Intent, source: Situation['source'], obstacleAhead: number): Intent {
    const clean = sanitize(intent, this.#clean)
    const s = this.#situation
    s.source = source
    s.speed = this.speed(v)
    s.personAhead = this.#personIn(v, 1, clean.steer)
    s.personBehind = this.#personIn(v, -1, clean.steer)
    s.obstacleAhead = obstacleAhead
    const i = v.index
    let cmd = clean
    const dir = this.#emergency[i]
    if (dir !== 0) {
      const person = dir > 0 ? s.personAhead : s.personBehind
      const standing = Math.abs(s.speed) <= AT_REST
      if (person >= KERNEL.range || (standing && (person > HOLD_CLEAR || clean.throttle * dir <= 0))) {
        this.#emergency[i] = 0
      } else {
        cmd = this.#latched
        cmd.throttle = 0
        cmd.brake = KERNEL.maxBrake
        cmd.steer = clean.steer
      }
    }
    let out = this.bouncer.vet(i, cmd, s)
    if (this.bouncer.holding(i) && Math.abs(s.speed) > AT_REST) this.#emergency[i] = s.speed > 0 ? 1 : -1
    // The bouncer reads the direction of travel from the speed, so drive against the motion is checked only
    // once the car has turned round; it already points at whoever stands on that side. Toward a person
    // within the envelope of a car starting from rest (the standoff), it becomes service braking instead.
    if ((out.throttle > 0 && s.speed < -AT_REST && s.personAhead <= KERNEL.standoff) ||
      (out.throttle < 0 && s.speed > AT_REST && s.personBehind <= KERNEL.standoff)) {
      const g = this.#guarded
      g.brake = Math.max(out.brake, Math.abs(out.throttle) * KERNEL.maxBrake)
      g.throttle = 0
      g.steer = out.steer
      out = g
    }
    return out
  }

  /** The only way a command reaches the wheels; callers pass it through the bouncer first. */
  #apply(v: Vehicle, cmd: Intent, handbrake: boolean): void {
    const wheels = this.#commands[v.index]
    wheels.throttle = cmd.throttle
    wheels.brake = cmd.brake
    wheels.steer = cmd.steer
    const last = v.lastCommand
    last.throttle = cmd.throttle
    last.brake = cmd.brake
    last.steer = cmd.steer
    v.handbrake = handbrake
  }

  /** Clamps into CAR_TUNE_RANGE and applies; returns the value actually set. Grip is pushed to every wheel now. */
  setTuning(key: keyof CarTuning, value: number): number {
    const v = clampTuning(key, value)
    this.#tuning[key] = v
    if (key === 'grip') for (const car of this.vehicles) for (let w = 0; w < 4; w++) this.#rigs[car.index].controller.setWheelFrictionSlip(w, CAR.frictionSlip * v)
    return v
  }

  /** Engine force (capped by power at speed), brakes and Ackermann steering for this substep. */
  #drivetrain(v: Vehicle, h: number, speed: number): void {
    const c = this.#rigs[v.index].controller
    const cmd = this.#commands[v.index]
    const peak = CAR.engine * (v.suv ? 1.25 : 1)
    const power = v.suv ? CAR.suvPower : CAR.power
    const perWheel = Math.min(peak, power / 2 / Math.max(1, Math.abs(speed))) * this.#tuning.power
    // Negative engine force drives toward chassis +x (calibrated). A wheel with engine force ignores its
    // brake, so the handbrake, or any service brake (brake overrides throttle), cuts the drive.
    const force = v.handbrake || cmd.brake > 0 ? 0 : -cmd.throttle * perWheel
    c.setWheelEngineForce(2, force)
    c.setWheelEngineForce(3, force)
    // Rapier's wheel brake is the largest impulse the wheel may apply per step: decel·m·h over four wheels.
    const unit = v.mass * h
    const service = (Math.min(KERNEL.maxBrake, Math.max(0, cmd.brake)) * unit * this.#tuning.brake) / 4
    const rear = service + (v.handbrake ? (CAR.handbrake * unit * this.#tuning.brake) / 2 : 0)
    c.setWheelBrake(0, service)
    c.setWheelBrake(1, service)
    c.setWheelBrake(2, rear)
    c.setWheelBrake(3, rear)
    c.setWheelSteering(0, ackermann(cmd.steer, -1))
    c.setWheelSteering(1, ackermann(cmd.steer, 1))
  }

  /**
   * Aerodynamic drag (½ρC_dAv², against the velocity), rolling resistance (C_rr·m·g on the wheels touching
   * the road, against the rolling direction, faded in below 0.5 m/s so it never pushes a stopped car back)
   * and engine braking with the throttle closed. Rapier keeps user forces until reset, so they are rebuilt
   * every substep. Returns the rolling (horizontal chassis-forward) speed, m/s.
   */
  #roadLoads(v: Vehicle): number {
    const b = this.#rigs[v.index].body
    b.resetForces(false)
    const u = b.linvel(this.#vel)
    const r = b.rotation(this.#rot)
    let fx = 1 - 2 * (r.y * r.y + r.z * r.z)
    let fz = 2 * (r.x * r.z - r.w * r.y)
    const fl = Math.hypot(fx, fz)
    if (fl < 1e-3) return 0
    fx /= fl; fz /= fl
    const rolling = u.x * fx + u.z * fz
    const speed = Math.hypot(u.x, u.z)
    if (speed < 0.01) return rolling
    const c = this.#rigs[v.index].controller
    let contact = 0
    for (let w = 0; w < 4; w++) if (c.wheelIsInContact(w)) contact++
    const cda = v.suv ? CAR.suvDragCoefficient * CAR.suvFrontalArea : CAR.dragCoefficient * CAR.frontalArea
    const aero = 0.5 * AIR_DENSITY * cda * speed * this.#tuning.drag
    const tyre = (contact / 4) * CAR.rollingResistance * v.mass * GRAVITY * Math.max(-1, Math.min(1, rolling / 0.5))
    const engine = v.mode !== 'parked' && this.#commands[v.index].throttle === 0 && contact > 0 ? CAR.engineBraking * rolling : 0
    const f = this.#force
    f.x = -aero * u.x - (tyre + engine) * fx
    f.y = 0
    f.z = -aero * u.z - (tyre + engine) * fz
    b.addForce(f, false)
    return rolling
  }
}

// A replaced prototype method could skip the vetting; the prototype and the class are sealed.
Object.freeze(Fleet.prototype)
Object.freeze(Fleet)
