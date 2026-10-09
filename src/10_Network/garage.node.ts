// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the network room's authority over cars (the headless Ring-0 mirror's garage): the
 * fleet as the seed lays it out, and every player's own car replayed on the server with the page's own car physics.
 * It knows natively, from the seed and the fleet size alone, which ring of the track network every car was seated on
 * and which one is an SUV (07_Execute_Actions/carRig.ts planFleet, the plan the page's fleet is built from). A car an AI
 * drives is the page's, not the room's: where it is along its ring depends on the pedestrians of that page's own GPU
 * crowd, whom the First Law makes it brake for, so no server can compute it. What the garage checks when a player takes
 * a car's wheel is everything that can be checked:
 *   - the door: the chassis within ENTER_RANGE of where the room has the player (the realm's own rule);
 *   - a car this player has driven before (the room holds it, stopped where it was left): within 0.5 m of that spot,
 *     turned no further from how it was left and moving no faster than a car settling on its springs;
 *   - any other car: on its own ring's lane (within the fleet's measured cornering envelope), facing along the ring,
 *     upright, at a car's height, and moving as a car on a street moves: along its heading at the ring's speed or
 *     below, not sliding, rising or falling, pitching or rolling past what the fleet ever does (GARAGE: each bound is
 *     measured, with a margin).
 * The room adopts the state it lets through, so every number of it is checked, not only where the car is.
 * From then on the car is the room's: each step's wheel command (what the page's Ring-0 bouncer let through) is replayed
 * here on the same car, in a world of the same city's buildings and ground, with the same code (carRig.ts carSubstep and
 * the Ring-0 speed clamp after each step), from the same numbers, the car built again from them on both sides (carRig.ts
 * rebuildCarRig: no controller or contact state carried over), so the page's car and the room's agree to the bit
 * (garage.node.test.ts). Leaving a car is checked against the realm's exit
 * rule (carRig.ts exitPoint) within 0.5 m, and the car stops where it is left (the room's rule on the page too). Each
 * player has a drive world of their own, built the first time they take a wheel and stepped only while they drive.
 * What breaks if it is removed? The room could only bound a car, not replay it: a client could claim to be driving
 * anywhere a car might be, and jump in and out of cars that are not there.
 */
import { generateCity } from '../01_Initialize_World/city.ts'
import { RING0 } from '../02_Define_The_Rules/ring0.ts'
import { buildTrackNetwork, projectOnto, tangentAt, type TrackNetwork } from '../06_Make_Decisions/tracks.ts'
import { AUTHORED, carState, carSubstep, clampSpeed, exitPoint, HELD_CARS, headingOf, planFleet, rebuildCarRig, type CarRig, type PlannedCar } from '../07_Execute_Actions/carRig.ts'
import { Physics, PHYSICS_HZ } from '../07_Execute_Actions/physics.ts'
import { ENTER_RANGE, type CarBodyState } from '../07_Execute_Actions/simProtocol.ts'

export const GARAGE = Object.freeze({
  /** A car the room holds (driven or left by this player) and every exit point: within this of the room's own coordinate, m. */
  door: 0.5,
  /**
   * An AI car the room does not hold: within this of its own ring's lane, m. The lane is computed from the seed; how far
   * a car on it strays is the fleet's own: never past 0.53 m on straights nor 0.78 m in corners, every frame (measured
   * over a minute of 36 cars: 0.18 m and 0.58 m; garage.node.test.ts measures it again, every frame).
   */
  lane: 1.0,
  /** …facing along its ring within this, rad (measured every frame: 0.35 at most). */
  heading: 0.5,
  /**
   * …moving along its own heading: forward no faster than its ring's speed limit and this, nor backward faster than
   * this, m/s (measured: never over the limit, never backward faster than 0.1).
   */
  speedSlack: 0.5,
  /** …sliding sideways no faster than this, m/s (measured: 1.67 at most, cornering; a claimed slide stops in half a metre). */
  slip: 4,
  /**
   * …rising no faster than `rise` and falling no faster than `fall`, m/s: a car on a street is on its wheels (measured:
   * never rising faster than 0.08, settling onto its springs at the start included; falling 0.08 driving, 0.17 in an
   * emergency stop, 0.74 in that first settling drop). Only rising is a danger: a car claimed moving upward would be
   * launched by the room's own replay.
   */
  rise: 0.5,
  fall: 2,
  /** …turning about its up axis no faster than this, rad/s (measured: 1.28 at most). */
  spin: 3,
  /** …pitching or rolling no faster than this, rad/s (measured: 0.17 driving, 0.31 in an emergency stop). */
  tilt: 1,
  /** …upright: its up axis at least this much vertical (measured: never under 0.9993). */
  upright: 0.99,
  /** …its chassis centre this high above the ground, m (measured: 0.55 to 0.57 driving, 0.54 to 0.66 settling). */
  low: 0.4,
  high: 0.9,
  /**
   * A car the room holds was stopped where it was left; when its driver comes back, the page's car has only settled on
   * its springs (measured over a minute after a dead stop mid-manoeuvre: never faster than 0.10 m/s, never spinning
   * past 0.12 rad/s, turned at most 0.02 rad, moved at most 1.6 cm). So it must be within `door` of that spot, turned
   * within `heldTurn` rad of that orientation, and no faster than `heldSpeed` m/s or `heldSpin` rad/s.
   */
  heldTurn: 0.1,
  heldSpeed: 0.5,
  heldSpin: 0.5,
  /** The door's own margin past ENTER_RANGE, m (the page measures the same distance from the same numbers). */
  enterSlack: 0.01,
  /** Cars one player may hold parked at once; the oldest is let go past it (the room then treats it as any car). */
  maxParked: HELD_CARS,
})

/** A car's full rigid-body state as plain numbers (simProtocol.ts CarBodyState): what the room takes over at the door. */
export type CarState = CarBodyState

/** One replayed step at the wheel: the vetted command, the handbrake (0 or 1), and the substeps it ran. */
export type DriveRun = readonly [throttle: number, brake: number, steer: number, handbrake: number, n: number]

interface Bay {
  physics: Physics | null
  /** The car this player drives, its index and its rig in the bay's world; null on foot. */
  driving: { index: number; rig: CarRig } | null
  /** Cars this player left, where the room has them (at rest), oldest first. */
  parked: Map<number, CarState>
}

const H = 1 / PHYSICS_HZ
const NO_FURNITURE = Object.freeze({ lamps: [], trees: [], signals: [] })

/** Every number finite and the orientation a unit quaternion (within 1 %). */
function wellFormed(s: CarState): boolean {
  const all = [s.x, s.y, s.z, s.qx, s.qy, s.qz, s.qw, s.vx, s.vy, s.vz, s.wx, s.wy, s.wz]
  if (!all.every(Number.isFinite)) return false
  const q = Math.hypot(s.qx, s.qy, s.qz, s.qw)
  return q > 0.99 && q < 1.01
}

/** A car's chassis heading from a state (carRig.ts headingOf). */
const headingOfState = (s: CarState): number => headingOf({ x: s.qx, y: s.qy, z: s.qz, w: s.qw })

/**
 * A state's motion in its own chassis frame (forward is the chassis +x, up its +y, side its +z): the velocity along each,
 * the turn rate about up (yaw) and about any horizontal axis of the chassis (pitch and roll), and how upright it is.
 */
export function motionOf(s: CarState): { forward: number; side: number; vertical: number; yaw: number; tilt: number; up: number } {
  const { qx: x, qy: y, qz: z, qw: w } = s
  const f = [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)]
  const u = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)]
  const d = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)]
  const yaw = s.wx * u[0] + s.wy * u[1] + s.wz * u[2]
  return {
    forward: s.vx * f[0] + s.vy * f[1] + s.vz * f[2],
    side: s.vx * d[0] + s.vy * d[1] + s.vz * d[2],
    vertical: s.vy,
    yaw,
    tilt: Math.hypot(s.wx - yaw * u[0], s.wy - yaw * u[1], s.wz - yaw * u[2]),
    up: u[1],
  }
}

/** The angle between two orientations, rad. */
const turnBetween = (a: CarState, b: CarState): number => 2 * Math.acos(Math.min(1, Math.abs(a.qx * b.qx + a.qy * b.qy + a.qz * b.qz + a.qw * b.qw)))

export class Garage {
  readonly seed: number
  readonly cars: number
  readonly network: TrackNetwork
  readonly plan: readonly PlannedCar[]
  readonly #boxes: ReturnType<typeof generateCity>
  readonly #bays = new Map<number, Bay>()
  /** Substeps replayed at the wheel, and drive worlds built, since the garage was made. */
  readonly counts = { substeps: 0, worlds: 0 }

  /** The fleet of `cars` cars on the seed's track network. Rapier must be loaded (the mirror has loaded it). */
  constructor(seed: number, cars: number) {
    this.seed = seed >>> 0
    this.cars = Math.max(0, Math.floor(cars))
    this.network = buildTrackNetwork(this.seed)
    this.plan = Object.freeze(planFleet(this.cars, this.seed, this.network).cars)
    this.#boxes = generateCity(this.seed)
  }

  join(id: number): void {
    if (!this.#bays.has(id)) this.#bays.set(id, { physics: null, driving: null, parked: new Map() })
  }

  /**
   * The room lets go of car `index` it held for the player: from now on it is an AI car to the room, checked on its own
   * ring's lane (whyNotEnter). Taken when the page claims a held car somewhere the room does not have it: the page has
   * put that car back in traffic (simCore.ts release) after the correction took the player out of it.
   */
  release(id: number, index: number): void {
    this.#bay(id).parked.delete(index)
  }

  /** The player's bay goes, its drive world freed. */
  leave(id: number): void {
    const bay = this.#bays.get(id)
    if (!bay) return
    bay.physics?.world.free()
    this.#bays.delete(id)
  }

  /** The car the player drives, or −1. */
  driving(id: number): number {
    return this.#bay(id).driving?.index ?? -1
  }

  /** The chassis state of the car the player drives (null on foot). */
  chassis(id: number): CarState | null {
    const d = this.#bay(id).driving
    return d ? carState(d.rig) : null
  }

  /** Where the room holds car `index` for this player: parked where it was left, or null. */
  parkedAt(id: number, index: number): CarState | null {
    return this.#bay(id).parked.get(index) ?? null
  }

  /** Drive worlds built and alive. */
  get worlds(): number {
    let n = 0
    for (const b of this.#bays.values()) if (b.physics) n++
    return n
  }

  /**
   * Why the player standing at (x, z) may not take the wheel of car `index` in state `s`, or null when they may (see the
   * header). Changes nothing.
   */
  whyNotEnter(id: number, at: { x: number; z: number }, index: number, s: CarState): string | null {
    const bay = this.#bay(id)
    if (bay.driving) return 'enter: already at a wheel'
    if (!Number.isInteger(index) || index < 0 || index >= this.cars) return `enter: no car ${String(index)} in this room's fleet`
    if (!wellFormed(s)) return 'enter: the car state'
    const door = Math.hypot(s.x - at.x, s.z - at.z)
    if (!(door <= ENTER_RANGE + GARAGE.enterSlack)) return `enter: the car is ${door.toFixed(2)} m from the room's pose (the door is ${ENTER_RANGE} m)`
    // The room adopts the state it lets through, so every number in it is checked, not only where the car is: a car
    // claimed at the right spot but moving upward, sideways or spinning would be launched by the room's own replay.
    const held = bay.parked.get(index)
    if (held) {
      const off = Math.hypot(s.x - held.x, s.y - held.y, s.z - held.z)
      if (!(off <= GARAGE.door)) return `enter: car ${index} is ${off.toFixed(2)} m from where it was left`
      const turned = turnBetween(s, held)
      if (!(turned <= GARAGE.heldTurn)) return `enter: car ${index} is turned ${turned.toFixed(2)} rad from how it was left`
      const speed = Math.hypot(s.vx, s.vy, s.vz), spin = Math.hypot(s.wx, s.wy, s.wz)
      if (!(speed <= GARAGE.heldSpeed && spin <= GARAGE.heldSpin)) return `enter: car ${index} was left at rest, not moving (${speed.toFixed(2)} m/s, ${spin.toFixed(2)} rad/s)`
      return null
    }
    const car = this.plan[index]
    const track = car.track >= 0 ? this.network.tracks[car.track] : null
    if (!track) return `enter: car ${index} has no ring`
    if (!(s.y >= GARAGE.low && s.y <= GARAGE.high)) return 'enter: chassis height'
    const m = motionOf(s)
    if (!(m.up >= GARAGE.upright)) return 'enter: the car is not upright'
    const p = projectOnto(track, s.x, s.z)
    if (!(Math.abs(p.lateral) <= GARAGE.lane)) return `enter: car ${index} is ${Math.abs(p.lateral).toFixed(2)} m off its ring's lane`
    const t = tangentAt(track, p.s)
    let dh = headingOfState(s) - Math.atan2(t[0], t[1])
    dh = Math.atan2(Math.sin(dh), Math.cos(dh))
    if (!(Math.abs(dh) <= GARAGE.heading)) return `enter: car ${index} is not facing along its ring`
    if (!(Math.abs(m.yaw) <= GARAGE.spin)) return 'enter: the car is spinning'
    if (!(m.tilt <= GARAGE.tilt)) return 'enter: the car is pitching or rolling'
    if (!(m.vertical <= GARAGE.rise)) return `enter: car ${index} is moving up at ${m.vertical.toFixed(1)} m/s`
    if (!(m.vertical >= -GARAGE.fall)) return `enter: car ${index} is moving down at ${(-m.vertical).toFixed(1)} m/s`
    if (!(Math.abs(m.side) <= GARAGE.slip)) return `enter: car ${index} is sliding sideways at ${Math.abs(m.side).toFixed(1)} m/s`
    if (!(m.forward <= track.speedLimit + GARAGE.speedSlack)) return `enter: car ${index} at ${m.forward.toFixed(1)} m/s is past its ring's ${track.speedLimit.toFixed(1)}`
    if (!(m.forward >= -GARAGE.speedSlack)) return `enter: car ${index} is reversing at ${(-m.forward).toFixed(1)} m/s against its ring`
    return null
  }

  /**
   * The player takes the wheel of car `index` in state `s` (whyNotEnter has passed): the car is built in their drive world
   * in exactly that state, as the page builds its own again (vehicles.ts rebuild).
   */
  enter(id: number, index: number, s: CarState): void {
    const bay = this.#bay(id)
    if (!bay.physics) {
      bay.physics = Physics.build(this.#boxes, NO_FURNITURE)
      this.counts.worlds++
    }
    const rig = rebuildCarRig(bay.physics.world, null, s, this.plan[index].suv)
    bay.parked.delete(index)
    bay.driving = { index, rig }
  }

  /**
   * Replays steps at the wheel: each run's command for its substeps (drivetrain, road loads, wheels, then the world
   * step), the Ring-0 speed clamp after each run (the realm's audit after each step). Returns the chassis state.
   */
  drive(id: number, runs: readonly DriveRun[]): CarState {
    const bay = this.#bay(id)
    const d = bay.driving
    if (!d || !bay.physics) throw new Error(`player ${id} is not at a wheel`)
    const world = bay.physics.world
    const cmd = { throttle: 0, brake: 0, steer: 0 }
    for (const r of runs) {
      cmd.throttle = r[0]
      cmd.brake = r[1]
      cmd.steer = r[2]
      const handbrake = r[3] === 1
      for (let i = 0; i < r[4]; i++) {
        carSubstep(d.rig, cmd, handbrake, 'player', AUTHORED, H)
        world.step()
      }
      this.counts.substeps += r[4]
      clampSpeed(d.rig.body, RING0.maxVelocity)
    }
    return carState(d.rig)
  }

  /** Where leaving the car the player drives puts them (carRig.ts exitPoint, from the room's chassis), or null on foot. */
  exitPoint(id: number): { x: number; z: number } | null {
    const s = this.chassis(id)
    return s ? exitPoint(s.x, s.z, headingOfState(s)) : null
  }

  /** The player leaves their car: it stops where it is (the room's rule), and the room holds it there. */
  park(id: number): void {
    const bay = this.#bay(id)
    const d = bay.driving
    if (!d || !bay.physics) return
    const s = carState(d.rig)
    s.vx = s.vy = s.vz = 0
    s.wx = s.wy = s.wz = 0
    bay.physics.world.removeVehicleController(d.rig.controller)
    bay.physics.world.removeRigidBody(d.rig.body)
    bay.driving = null
    bay.parked.set(d.index, s)
    while (bay.parked.size > GARAGE.maxParked) bay.parked.delete(bay.parked.keys().next().value as number)
  }

  /**
   * The car the player drives built again in state `s` (its own, by default): a correction, which the page answers by
   * building its car again from the same numbers (vehicles.ts rebuild). Returns that state, or null on foot.
   */
  settle(id: number, s: CarState | null = null): CarState | null {
    const bay = this.#bay(id)
    const d = bay.driving
    if (!d || !bay.physics) return null
    const to = s ?? carState(d.rig)
    d.rig = rebuildCarRig(bay.physics.world, d.rig, to, d.rig.suv)
    return to
  }

  #bay(id: number): Bay {
    const b = this.#bays.get(id)
    if (!b) throw new Error(`player ${id} has no bay in the garage`)
    return b
  }
}
