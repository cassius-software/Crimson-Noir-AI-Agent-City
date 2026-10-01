/**
 * Why does this file exist? It is the headless Ring-0 mirror, the network room's authority: the server's own copy of
 * the city and of every peer's body. It builds the world the page's physics realm builds from the same seed
 * (01_Initialize_World/city.ts: every building box, the tiled ground, the street furniture as sensors) in Rapier, the
 * Rust physics engine compiled to WebAssembly that the page's physics worker loads, and gives each peer the realm's own
 * character controller (07_Execute_Actions/player.ts Avatar, in mirror mode). A peer's input says which walking
 * velocity its realm applied for each run of fixed 1/60 s substeps, and where its realm then had it: the claim. The
 * mirror replays the substeps on its own capsule with the same clamp (simProtocol.ts footWish) and the same controller,
 * and the page's realm in a network room walks player 1 as the mirror does (a ghost: only the city's fixed geometry
 * stops it, simCore.ts 'room'), so an honest claim matches to the bit (mirror.node.test.ts drives the realm and the
 * mirror side by side, traffic and corrections included) and the tolerance is a micrometre. One off by more (a speed
 * hack, a wall walked through, a position written into the client's memory) is refused: the trial is undone, and the
 * room snaps the client to the mirror's pose. Cars are the garage's (garage.node.ts, Phase 13): taking a car's wheel
 * and leaving it are doors the mirror checks against its own numbers (the car within the realm's door of where the
 * mirror has the player, and on its own ring's lane or within 0.5 m of where this player left it; the exit point
 * within 0.5 m of the one the mirror computes from its own chassis, which is where the mirror puts the player down),
 * and every run at the wheel is replayed on the room's own copy of the car, which then is the truth: a chassis claim
 * more than a micrometre from it is answered with a correction that carries the car's full state. Every pose it keeps
 * passes the Ring-0 person audit first (finite, inside the containment slab, above the ground floor). The city world
 * is built once and never stepped again (its query tree is the static city's; a mirror avatar moves itself and
 * ignores the other players), so a step on foot costs tens of microseconds, not a world step; a player at a wheel
 * steps a drive world of their own. Node-only by placement: the host imports it, the page never does.
 * What breaks if it is removed? The room has no authority: a client could say where it is and the others would see it.
 */
import { CITY, CITY_SIZE, generateCity, inLot, streetFurniture } from '../01_Initialize_World/city.ts'
import { panicReason, RING0, Ring0Auditor, type Violation } from '../02_Define_The_Rules/ring0.ts'
import { Physics, PHYSICS_HZ } from '../07_Execute_Actions/physics.ts'
import { Avatar } from '../07_Execute_Actions/player.ts'
import { footWish, PERSON, RUN } from '../07_Execute_Actions/simProtocol.ts'
import { Garage, GARAGE, type CarState, type DriveRun } from './garage.node.ts'
import type { CarFix, Door } from './replication.ts'

export const MIRROR = Object.freeze({
  /** One substep, s: the realm's fixed step. */
  h: 1 / PHYSICS_HZ,
  /**
   * How far a claim (the capsule on foot, the chassis at the wheel) may sit from the mirror's pose, m: a micrometre. An
   * honest page in a network room matches to the bit (mirror.node.test.ts, garage.node.test.ts); a 32-bit coordinate's
   * last bit near the city's far corner is about 60 µm, so a micrometre is no rounding allowance at all.
   */
  tolerance: 1e-6,
  /** The fleet a room's page runs when it does not say (the page's own default, engine.ts). */
  cars: 36,
  /** The room's players start a sidewalk step apart along the page's own spawn sidewalk (engine.ts), m, cycling. */
  spawnGap: 1.5,
  spawnSlots: 8,
})

/** A peer's pose as the mirror holds it: the truth the room's snapshots carry; from a settle at the wheel, the car's state. */
export interface MirrorPose {
  x: number
  /** Capsule centre height (the chassis centre at the wheel), m. */
  y: number
  z: number
  /** Facing, rad: the way the input said the player faces (display only; the body's own heading follows its walk). */
  heading: number
  /** Velocity over the ground in the last input kept, m/s. */
  vx: number
  vz: number
  speed: number
  driving: boolean
  car?: CarFix
}

/** What the mirror reads of an input (replication.ts InputMessage): its door, mode, runs of substeps, facing and claim. */
export interface MoveInput {
  mode: 'foot' | 'drive'
  /** Runs of substeps: on foot [walking velocity x, z (m/s), n]; at the wheel [throttle, brake, steer, handbrake, n]. */
  segs: readonly (readonly number[])[]
  heading: number
  /** Where the client's realm had it after the last substep: the capsule centre on foot, the chassis at the wheel. */
  claim: { x: number; y: number; z: number }
  /** Into a car (its index and the state the realm took it over in) or out of one (where the realm put the player down). */
  door?: Door
}

/** The mirror's verdict on one input: kept (the new truth), or refused (the truth unchanged) and why. */
export type Judgement = { ok: true; pose: MirrorPose } | { ok: false; pose: MirrorPose; reason: string }

interface Body {
  avatar: Avatar
  driving: boolean
  heading: number
  vx: number
  vz: number
}

const NO_VEHICLES: never[] = []

/** The world a page must be running to join this mirror's room: the procedural city of a seed, and its fleet's size. */
export const worldOf = (seed: number, cars: number = MIRROR.cars): string => `city/${seed >>> 0}/${Math.max(0, Math.floor(cars))}`

/** Total substeps an input covers: each run's last entry, on foot and at the wheel alike. */
export const substeps = (segs: readonly (readonly number[])[]): number => segs.reduce((n, s) => n + s[s.length - 1], 0)

/**
 * The Ring-0 person audit on one pose: non-finite (the realm's auditor), then containment (the slab around the city,
 * and the ground floor under the capsule). The panic sentence the realm would have halted on, or null.
 */
export function personViolation(auditor: Ring0Auditor, id: number, x: number, y: number, z: number): string | null {
  const r = auditor.run(NO_VEHICLES, [{ id, x, y, z, solid: true }], false)
  if (r.violations.length > 0) return panicReason(r.violations[0])
  const c = CITY_SIZE / 2
  if (y < RING0.groundFloor || Math.abs(x - c) > RING0.worldExtent || Math.abs(z - c) > RING0.worldExtent) {
    const v: Violation = { code: 'OUT_OF_BOUNDS', subject: `person ${id}`, detail: `x=${x.toFixed(2)}m y=${y.toFixed(2)}m z=${z.toFixed(2)}m`, extent: RING0.worldExtent }
    return panicReason(v)
  }
  return null
}

/** A distance for a refusal, with its unit: metres to the centimetre, micrometres below a millimetre. */
const fmt = (m: number): string => (!Number.isFinite(m) ? `${String(m)} m` : m >= 1e-3 ? `${m.toFixed(2)} m` : `${(m * 1e6).toFixed(1)} µm`)

/** The Ring-0 audit on a chassis: the person audit's containment (personViolation) and the velocity cap. */
export function carViolation(auditor: Ring0Auditor, id: number, s: CarState): string | null {
  const v = personViolation(auditor, id, s.x, s.y, s.z)
  if (v !== null) return v
  const speed = Math.hypot(s.vx, s.vy, s.vz)
  return speed <= RING0.maxVelocity * (1 + 1e-6) ? null : `car ${id} at ${speed.toFixed(2)} m/s past the velocity cap`
}

export class Mirror {
  /** The world a joining page must name (worldOf). */
  readonly world: string
  readonly seed: number
  readonly #physics: Physics
  readonly #auditor = new Ring0Auditor({ x: CITY_SIZE / 2, z: CITY_SIZE / 2 })
  readonly #bodies = new Map<number, Body>()
  /** The room's cars: the fleet's plan, and every player's own car replayed (garage.node.ts). */
  readonly garage: Garage
  /** Substeps replayed on foot, inputs kept and refused, since the mirror was built (the garage counts its own). */
  readonly counts = { substeps: 0, kept: 0, refused: 0 }

  private constructor(physics: Physics, seed: number, cars: number) {
    this.#physics = physics
    this.seed = seed
    this.garage = new Garage(seed, cars)
    this.world = worldOf(seed, this.garage.cars)
  }

  /** The city of `seed` with a fleet of `cars`, as the page's realm builds it (its query tree built, Physics.build). */
  static async create(seed: number, cars: number = MIRROR.cars): Promise<Mirror> {
    const s = Math.floor(Number.isFinite(seed) ? seed : 0) >>> 0
    const physics = await Physics.create(generateCity(s), streetFurniture(s))
    return new Mirror(physics, s, Number.isFinite(cars) ? cars : MIRROR.cars)
  }

  /** Bodies in the mirror's world (the city's one fixed body, plus one per peer). */
  get bodies(): number {
    return this.#physics.world.bodies.len()
  }

  get peers(): number {
    return this.#bodies.size
  }

  /**
   * Where peer `id` starts: the page's own spawn (engine.ts, the sidewalk beside the centre street), a sidewalk step
   * along it per peer, cycling; never inside a building lot.
   */
  spawnOf(id: number): { x: number; z: number } {
    const slot = ((Math.max(1, Math.floor(id)) - 1) % MIRROR.spawnSlots)
    const x = CITY_SIZE / 2 + CITY.lane
    let z = CITY_SIZE / 2 + 12 + slot * MIRROR.spawnGap
    while (inLot(x, z, PERSON.radius)) z += MIRROR.spawnGap
    return { x, z }
  }

  /** A new peer's body at its spawn, put down the way the page's realm is told to (a teleport): its pose. */
  join(id: number): MirrorPose {
    if (this.#bodies.has(id)) throw new Error(`peer ${id} is already in the mirror`)
    const at = this.spawnOf(id)
    const avatar = new Avatar(this.#physics, at.x, at.z, { mirror: true })
    avatar.teleport(at.x, at.z)
    this.#bodies.set(id, { avatar, driving: false, heading: 0, vx: 0, vz: 0 })
    this.garage.join(id)
    return this.pose(id)
  }

  leave(id: number): void {
    const b = this.#bodies.get(id)
    if (!b) return
    b.avatar.dispose()
    this.#bodies.delete(id)
    this.garage.leave(id)
  }

  /** Peer `id`'s truth: the capsule on foot, the chassis at the wheel. */
  pose(id: number): MirrorPose {
    const b = this.#body(id)
    const c = b.driving ? this.garage.chassis(id) : null
    if (c) return { x: c.x, y: c.y, z: c.z, heading: b.heading, vx: b.vx, vz: b.vz, speed: Math.hypot(b.vx, b.vz), driving: true }
    const s = b.avatar.state()
    return { x: s.x, y: s.y, z: s.z, heading: b.heading, vx: b.vx, vz: b.vz, speed: Math.hypot(b.vx, b.vz), driving: false }
  }

  /**
   * Puts peer `id` down at its truth again, as the room does with every correction, so the client's realm and the
   * mirror take the same next step: on foot standing (Avatar.teleport; the client's realm is teleported to the same
   * point); at the wheel the car built again in the garage's own state (`car`; the client's realm builds its car again
   * from the same numbers, simCore.ts 'netCar').
   */
  settle(id: number): MirrorPose {
    const b = this.#body(id)
    b.vx = 0
    b.vz = 0
    if (b.driving) {
      const state = this.garage.settle(id)
      if (state) return { ...this.pose(id), car: { index: this.garage.driving(id), state } }
      b.driving = false
    }
    const s = b.avatar.state()
    b.avatar.teleport(s.x, s.z)
    return this.pose(id)
  }

  /**
   * The honest client's side, for a predictor standing in for the page's realm (the tests, `npm run smoke:net`): runs
   * of substeps replayed on peer `id` and kept, no claim judged. The room never calls it.
   */
  walk(id: number, segs: readonly (readonly number[])[]): MirrorPose {
    const b = this.#body(id)
    b.driving = false
    for (const seg of segs) {
      const w = footWish(seg[0], seg[1])
      for (let i = 0; i < seg[2]; i++) b.avatar.move(w.x, w.z, MIRROR.h)
    }
    return this.pose(id)
  }

  /** The client's side of a correction: peer `id` put down standing at (x, z), as the page's realm is by a teleport. */
  place(id: number, x: number, z: number): MirrorPose {
    const b = this.#body(id)
    b.avatar.teleport(x, z)
    b.driving = false
    return this.pose(id)
  }

  /**
   * One input judged. Its door first, against the mirror's own numbers: a refused door changes nothing; a door taken
   * stands whatever the runs then say (it was checked on its own). Then its runs: on foot replayed on trial (refused:
   * undone to where the door left the player); at the wheel replayed on the room's car, which is then the truth (a
   * chassis claim off it is refused, and the correction carries the car). Then the Ring-0 audit on what is kept.
   */
  judge(id: number, input: MoveInput): Judgement {
    const b = this.#body(id)
    const garage = this.garage
    const refuse = (reason: string, undo?: () => void): Judgement => {
      undo?.()
      this.counts.refused++
      return { ok: false, pose: this.pose(id), reason }
    }
    const door = input.door
    let origin: { x: number; z: number } | null = null
    if (door && 'enter' in door) {
      if (b.driving) return refuse('enter: already at a wheel')
      const why = garage.whyNotEnter(id, b.avatar.state(), door.enter.car, door.enter.state)
      if (why !== null) return refuse(why)
      garage.enter(id, door.enter.car, door.enter.state)
      b.driving = true
    } else if (door) {
      if (!b.driving) return refuse('exit: not at a wheel')
      const at = garage.exitPoint(id)
      if (!at) return refuse('exit: not at a wheel')
      const off = Math.hypot(door.exit.x - at.x, door.exit.z - at.z)
      if (!(off <= GARAGE.door)) return refuse(`exit: ${fmt(off)} from where the car lets its driver out`)
      // The car stops where it is left, and the player is put down where the mirror's own chassis says.
      garage.park(id)
      b.avatar.teleport(at.x, at.z)
      b.driving = false
      origin = at
    } else if (b.driving !== (input.mode === 'drive')) {
      return refuse(b.driving ? 'on foot without leaving the car' : 'at a wheel without taking one')
    }
    if (b.driving !== (input.mode === 'drive')) return refuse('the door and the mode disagree')
    const n = substeps(input.segs)
    const claim = input.claim
    const t = n * MIRROR.h
    let vx: number, vz: number
    if (input.mode === 'foot') {
      const before = b.avatar.state()
      const was = { heading: b.heading, vx: b.vx, vz: b.vz }
      const undo = (): void => {
        b.avatar.restore(before)
        Object.assign(b, was)
      }
      for (const seg of input.segs) {
        const w = footWish(seg[0], seg[1])
        for (let i = 0; i < seg[2]; i++) b.avatar.move(w.x, w.z, MIRROR.h)
      }
      this.counts.substeps += n
      const after = b.avatar.state()
      const off = Math.hypot(claim.x - after.x, claim.y - after.y, claim.z - after.z)
      if (!(off <= MIRROR.tolerance)) return refuse(`claim ${fmt(off)} from the mirror's pose`, undo)
      const violation = personViolation(this.#auditor, id, after.x, after.y, after.z)
      if (violation !== null) return refuse(`Ring-0: ${violation}`, undo)
      // The velocity the others' views carry this pose forward by: from the exit point after a car, capped at a run.
      const from = origin ?? before
      vx = t > 0 ? (after.x - from.x) / t : 0
      vz = t > 0 ? (after.z - from.z) / t : 0
      const speed = Math.hypot(vx, vz)
      if (speed > RUN) {
        vx *= RUN / speed
        vz *= RUN / speed
      }
    } else {
      // The room's car, replayed: it is the truth from here, whatever the claim says.
      const s = garage.drive(id, input.segs as unknown as DriveRun[])
      vx = s.vx
      vz = s.vz
      const off = Math.hypot(claim.x - s.x, claim.y - s.y, claim.z - s.z)
      if (!(off <= MIRROR.tolerance)) return refuse(`chassis claim ${fmt(off)} from the room's car`)
      const violation = carViolation(this.#auditor, id, s)
      if (violation !== null) return refuse(`Ring-0: ${violation}`)
    }
    b.vx = vx
    b.vz = vz
    b.heading = Math.atan2(Math.sin(input.heading), Math.cos(input.heading))
    this.counts.kept++
    return { ok: true, pose: this.pose(id) }
  }

  #body(id: number): Body {
    const b = this.#bodies.get(id)
    if (!b) throw new Error(`peer ${id} is not in the mirror`)
    return b
  }
}
