/**
 * Why does this file exist? It is the headless Ring-0 mirror, the network room's authority: the server's own copy of
 * the city and of every peer's body. It builds the world the page's physics realm builds from the same seed
 * (01_Initialize_World/city.ts: every building box, the tiled ground, the street furniture as sensors) in Rapier, the
 * Rust physics engine compiled to WebAssembly that the page's physics worker loads, and gives each peer the realm's own
 * character controller (07_Execute_Actions/player.ts Avatar, in mirror mode). A peer's input says which walking
 * velocity its realm applied for each run of fixed 1/60 s substeps, and where its realm then had it: the claim. The
 * mirror replays the substeps on its own capsule with the same clamp (simProtocol.ts footWish) and the same controller,
 * so an honest client's claim matches within a micrometre, a 32-bit coordinate's last bit (mirror.node.test.ts drives
 * the realm and the mirror side by side), and judges the claim. One off by more than the tolerance (a speed hack, a
 * wall walked through, a position written into the client's memory) is refused: the trial is undone, the packet
 * changes nothing here, and the room snaps the client to the mirror's pose. At the wheel the mirror cannot replay the
 * car (the traffic is the client's own, never the room's), so it bounds the claim instead: no faster than the Ring-0
 * velocity cap, never through a building, and in or out of a car only within reach of where the mirror has the player.
 * Every pose it keeps passes the Ring-0 person audit first (finite, inside the containment slab, above the ground
 * floor). The world is built once and never stepped again (its query tree is the static city's; a mirror avatar moves
 * itself and ignores the other players), so a move costs tens of microseconds, not a world step. Node-only by
 * placement: the host imports it, the page never does.
 * What breaks if it is removed? The room has no authority: a client could say where it is and the others would see it.
 */
import { CITY, CITY_SIZE, generateCity, inLot, streetFurniture } from '../01_Initialize_World/city.ts'
import { panicReason, RING0, Ring0Auditor, type Violation } from '../02_Define_The_Rules/ring0.ts'
import { Physics, PHYSICS_HZ, RAPIER } from '../07_Execute_Actions/physics.ts'
import { Avatar } from '../07_Execute_Actions/player.ts'
import { footWish, PERSON, RUN } from '../07_Execute_Actions/simProtocol.ts'

export const MIRROR = Object.freeze({
  /** One substep, s: the realm's fixed step. */
  h: 1 / PHYSICS_HZ,
  /**
   * How far a claim may sit from the mirror's pose, m. An honest client matches to the bit; the slack is for what only
   * the client's world holds (its own traffic, which can block it, and the Sanctuary's nudges clear of a car).
   */
  tolerance: 0.25,
  /** Into or out of a car: how far from the mirror's pose the chassis or the exit point may be, m (a door, a car). */
  reach: 8,
  /** A chassis claim may run this far past what the velocity cap allows, m. */
  driveSlack: 0.5,
  /** Where a chassis centre may be, m (the ground floor below; a car on the roads never climbs this high). */
  driveCeiling: 12,
  /** The two lines a car's move must clear, m above its chassis centre: the sill and the roof line. */
  rayLift: [0, 0.6] as readonly number[],
  /** The room's players start a sidewalk step apart along the page's own spawn sidewalk (engine.ts), m, cycling. */
  spawnGap: 1.5,
  spawnSlots: 8,
})

/** A peer's pose as the mirror holds it: the truth the room's snapshots carry. */
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
}

/** What the mirror reads of an input: its mode, its runs of substeps, the facing, the claim, and an exit point. */
export interface MoveInput {
  mode: 'foot' | 'drive'
  /** Runs of substeps: [walking velocity x, z (m/s, foot only; 0 at the wheel), substeps]. */
  segs: readonly (readonly number[])[]
  heading: number
  /** Where the client's realm had it after the last substep: the capsule centre on foot, the chassis at the wheel. */
  claim: { x: number; y: number; z: number }
  /** The first input on foot after a car: where the realm put the player down beside it. */
  from?: { x: number; z: number }
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

/** Solid fixed geometry only: the ground and the buildings, never a sensor (furniture), a car or a player. */
const SOLID = RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS
/** A capsule standing at a point, as Avatar.teleport puts it down. */
const STANDING = PERSON.halfHeight + PERSON.radius + 0.05
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 }
const NO_VEHICLES: never[] = []

/** The world a page must be walking to join this mirror's room: the procedural city of a seed. */
export const worldOf = (seed: number): string => `city/${seed >>> 0}`

/** Total substeps an input covers. */
export const substeps = (segs: readonly (readonly number[])[]): number => segs.reduce((n, s) => n + s[2], 0)

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

export class Mirror {
  /** The world a joining page must name (worldOf). */
  readonly world: string
  readonly seed: number
  readonly #physics: Physics
  readonly #auditor = new Ring0Auditor({ x: CITY_SIZE / 2, z: CITY_SIZE / 2 })
  readonly #bodies = new Map<number, Body>()
  readonly #capsule = new RAPIER.Capsule(PERSON.halfHeight, PERSON.radius)
  /** Substeps replayed, inputs kept and refused, since the mirror was built. */
  readonly counts = { substeps: 0, kept: 0, refused: 0 }

  private constructor(physics: Physics, seed: number) {
    this.#physics = physics
    this.seed = seed
    this.world = worldOf(seed)
  }

  /** The city of `seed`, as the page's realm builds it; one world step builds the query tree the controllers search. */
  static async create(seed: number): Promise<Mirror> {
    const s = Math.floor(Number.isFinite(seed) ? seed : 0) >>> 0
    const physics = await Physics.create(generateCity(s), streetFurniture(s))
    physics.world.step()
    return new Mirror(physics, s)
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
    return this.pose(id)
  }

  leave(id: number): void {
    const b = this.#bodies.get(id)
    if (!b) return
    b.avatar.dispose()
    this.#bodies.delete(id)
  }

  /** Peer `id`'s truth. */
  pose(id: number): MirrorPose {
    const b = this.#body(id)
    const s = b.avatar.state()
    return { x: s.x, y: s.y, z: s.z, heading: b.heading, vx: b.vx, vz: b.vz, speed: Math.hypot(b.vx, b.vz), driving: b.driving }
  }

  /**
   * Puts peer `id` down at its truth again, standing (Avatar.teleport): what the room does with every correction, so
   * the client's realm, teleported to the same point, and the mirror take the same next step. At the wheel the truth is
   * the chassis: the client is put down on foot there, and so is the mirror's body.
   */
  settle(id: number): MirrorPose {
    const b = this.#body(id)
    const s = b.avatar.state()
    b.avatar.teleport(s.x, s.z)
    b.driving = false
    b.vx = 0
    b.vz = 0
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
   * One input judged: replayed on trial (on foot) or bounded (at the wheel), the claim compared, the Ring-0 audit run
   * on what would be kept. Kept: the new truth. Refused: everything put back exactly as it was, and why.
   */
  judge(id: number, input: MoveInput): Judgement {
    const b = this.#body(id)
    const before = b.avatar.state()
    const was = { driving: b.driving, heading: b.heading, vx: b.vx, vz: b.vz }
    const refuse = (reason: string): Judgement => {
      b.avatar.restore(before)
      Object.assign(b, was)
      this.counts.refused++
      return { ok: false, pose: this.pose(id), reason }
    }
    const n = substeps(input.segs)
    const claim = input.claim
    if (input.mode === 'foot') {
      if (input.from) {
        if (!b.driving) return refuse('exit point without a car')
        const from = input.from
        if (Math.hypot(from.x - before.x, from.z - before.z) > MIRROR.reach) return refuse('exit point out of reach of the car')
        if (this.#blocked(before, { x: from.x, y: before.y, z: from.z })) return refuse('exit point through a building')
        if (!this.#clear(from.x, from.z)) return refuse('exit point inside a building')
        b.avatar.teleport(from.x, from.z)
      } else if (b.driving) {
        return refuse('on foot without leaving the car')
      }
      b.driving = false
      for (const seg of input.segs) {
        const w = footWish(seg[0], seg[1])
        for (let i = 0; i < seg[2]; i++) b.avatar.move(w.x, w.z, MIRROR.h)
      }
      this.counts.substeps += n
      const after = b.avatar.state()
      const off = Math.hypot(claim.x - after.x, claim.y - after.y, claim.z - after.z)
      if (!(off <= MIRROR.tolerance)) return refuse(`claim ${Number.isFinite(off) ? off.toFixed(2) : String(off)} m from the mirror's pose`)
    } else {
      const reach = (b.driving ? 0 : MIRROR.reach) + RING0.maxVelocity * n * MIRROR.h + MIRROR.driveSlack
      const moved = Math.hypot(claim.x - before.x, claim.z - before.z)
      if (!(moved <= reach)) return refuse(`a car cannot cover ${moved.toFixed(1)} m in ${n} substeps`)
      if (!(claim.y >= RING0.groundFloor && claim.y <= MIRROR.driveCeiling)) return refuse('chassis height')
      if (this.#blocked(before, claim)) return refuse('a car through a building')
      b.avatar.restore({ ...before, x: claim.x, y: claim.y, z: claim.z })
      b.driving = true
    }
    const kept = b.avatar.state()
    const violation = personViolation(this.#auditor, id, kept.x, kept.y, kept.z)
    if (violation !== null) return refuse(`Ring-0: ${violation}`)
    // The velocity the others' views carry this pose forward by: from the exit point after a car, capped at a run on
    // foot and at the velocity cap at the wheel (a step into a car is a door, not a speed).
    const t = n * MIRROR.h
    const origin = input.mode === 'foot' && input.from ? input.from : before
    const top = b.driving ? RING0.maxVelocity : RUN
    let vx = t > 0 ? (kept.x - origin.x) / t : 0, vz = t > 0 ? (kept.z - origin.z) / t : 0
    const speed = Math.hypot(vx, vz)
    if (speed > top) {
      vx *= top / speed
      vz *= top / speed
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

  /** Whether a straight move from `a` to `b` (centres) meets a building at the sill or the roof line. */
  #blocked(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean {
    const dx = b.x - a.x, dz = b.z - a.z
    const len = Math.hypot(dx, dz)
    if (!(len > 1e-6)) return false
    for (const lift of MIRROR.rayLift) {
      const toi = this.#physics.castRay(a.x, a.y + lift, a.z, dx / len, 0, dz / len, len, undefined, true)
      if (toi !== null) return true
    }
    return false
  }

  /** Whether a person can stand at (x, z): the capsule, put down as a teleport puts it, meets no solid geometry. */
  #clear(x: number, z: number): boolean {
    const hit = this.#physics.world.intersectionWithShape({ x, y: STANDING, z }, IDENTITY, this.#capsule, SOLID)
    return hit === null
  }
}
