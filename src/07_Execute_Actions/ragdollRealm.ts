// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It wires the ragdoll balance machine (03_Spawn_Agents/ragdoll.ts) and its Rapier body
 * (ragdollRig.ts) into the physics realm, for the pedestrians within PROMOTE_RADIUS of the operator. The GPU crowd
 * moves every pedestrian kinematically; this module watches the realm's own crowd readout between consecutive steps
 * and, when one of three causes is seen — a shove in a dense crowd (two people within SHOVE_DISTANCE closing faster
 * than the machine's promote threshold), a kerb trip (someone crossing the sidewalk's kerb line faster than
 * KERB_SPEED) or a slip (drawn from the realm's seeded rng at a very low rate) — offers that person to the promotion
 * pool. A promoted person gets a rig built where the crowd had them, moving as they moved; every substep the pool
 * steps the machine on what the rig measures (perturbed, catch step, sitting down, seated, recovering), the rig is
 * driven with that state's gains, and on recovery the rig is removed and the person is the crowd's again: the crowd is
 * told to put them where the rig's pelvis stood, facing as it faced (`takeHandbacks`, CrowdSensor.place), and the slot
 * keeps streaming the rig's last pose until a crowd reading taken after that write arrives, so the page never draws the
 * figure where the crowd had walked it meanwhile (the handback jump, measured as `lastJump`, is the distance between
 * the last pose streamed and the figure the page then draws).
 *
 * A vehicle is never a cause. The pool refuses one by name, no car's push is ever offered, nobody standing within
 * VEHICLE_CLEARANCE of a moving car is promoted, and once a rig exists every one of its thirteen shapes is a ward of
 * the Sanctuary (a car about to reach it flips it to a sensor and nudges it clear, so no impulse is ever exchanged)
 * and a person to the Ring-0 audit (solid while not a sensor, with an id of its own: a car that reaches one halts the
 * realm naming it). A shielded segment keeps no gravity (a sensor meets no ground) until every car is clear again.
 * Like the rest of the realm it lives in the physics worker only, and nothing it returns is a reference into it.
 * What breaks if it is removed? The balance machine goes back to scaffolding: no pedestrian is ever promoted, the rig
 * stream is empty, and the Sanctuary and the audit have no rig to protect.
 */
import { CITY } from '../01_Initialize_World/city.ts'
import { createRng } from '../02_Define_The_Rules/degrees.ts'
import type { AuditPerson } from '../02_Define_The_Rules/ring0.ts'
import type { CrowdReadout } from '../03_Spawn_Agents/crowdSensor.ts'
import { POOL_CAPACITY, PROMOTE_IMPULSE, PROMOTE_RADIUS, RagdollPool, type Perturbation, type PerturbationCause, type Reading } from '../03_Spawn_Agents/ragdoll.ts'
import { applyGains, applyPush, buildRig, drive, FOOT, measure, removeRig, SEGMENTS, type Rig as BodyRig, type Segment } from '../03_Spawn_Agents/ragdollRig.ts'
import type { Physics } from './physics.ts'
import type { Nudge, PersonBody, Sanctuary, VehicleFootprint } from './sanctuary.ts'
import { RIG_POSE, RIG_SEGMENTS, RIG_SLOTS, RIG_STATES } from './simProtocol.ts'
import type { Person } from './vehicles.ts'

/** The crowd's one player figure (crowdCompute.ts PLAYER_INDEX): the operator's own body, never promoted. */
const OPERATOR_FIGURE = 0
/** kg: the person the machine's thresholds are measured on (PROMOTE_IMPULSE is 0.5 m/s on 70 kg). */
const PERSON_MASS = 70
/** m: two pedestrians this close are in contact (the crowd's figures are about 0.3 m across). */
export const SHOVE_DISTANCE = 0.35
/** m/s: the closing speed at which a contact in the crowd is a shove the springs cannot absorb (the machine's own threshold). */
export const SHOVE_CLOSING = PROMOTE_IMPULSE / PERSON_MASS
/** m/s: crossing the kerb line faster than this trips. */
export const KERB_SPEED = 2.4
/** The share of a tripping person's momentum that becomes the push (the foot stops, the body goes on). */
const TRIP_SHARE = 0.6
/** s: mean time between slips near the operator (one draw per crowd reading, at dt / SLIP_INTERVAL). */
export const SLIP_INTERVAL = 40
/** N·s: a slip is a firm push (the hard shove of ragdollRig.test.ts sits the person down; 40 is held in place). */
export const SLIP_IMPULSE = 110
/** m/s: slower than this a pedestrian is standing, and cannot slip. */
const WALKING = 0.3
/** m: nobody this close to a moving car's centre is promoted (a rig is never built where a car is about to be). */
export const VEHICLE_CLEARANCE = 3
/** m/s: a car slower than this is standing (the Sanctuary's own MOVING is 0.1; a standing car is an obstacle, not a cause). */
const CAR_MOVING = 0.1
/** The first audit id of rig persons: slot s's segment k is PERSON_ID_BASE + 13 s + k, never an avatar's (0..3). */
export const PERSON_ID_BASE = 1000
/** s: a crowd reading older than this against the previous one gives no velocity (a stalled sensor). */
const MAX_READING_GAP = 1

/** The thirteen shapes of a rig in stream order: the eleven segments, then the foot under each lower leg. */
interface ShapeSpec { name: string; segment: Segment; foot: boolean; halfHeight: number; radius: number }
const SHAPES: readonly ShapeSpec[] = RIG_SEGMENTS.map(([name, halfHeight, radius]) => {
  const foot = name === 'footL' || name === 'footR'
  return { name, segment: (foot ? (name === 'footL' ? 'lowerLegL' : 'lowerLegR') : name) as Segment, foot, halfHeight, radius }
})

/** One shape of a built rig: its body and collider, as the Sanctuary (ward) and the audit (person) see it. */
interface Shape {
  spec: ShapeSpec
  person: PersonBody
  /** The Sanctuary's ward index, fixed for the slot and shape once registered (−1 before). */
  ward: number
  /** True while this shape's gravity is off (shielded: a sensor meets no ground). */
  floating: boolean
}

interface Slot {
  /** The pedestrian promoted into this slot (or held after it), or −1 while free. */
  agent: number
  rig: BodyRig | null
  readonly shapes: Shape[]
  /**
   * After a handback: the rig's last RIG_POSE slice, streamed in place of the removed rig until the crowd reading `until`
   * (the first crowd step after the crowd was told where the person is; −1 until that step is dispatched) arrives.
   */
  hold: { pose: Float32Array; x: number; z: number; until: number } | null
  /** The RIG_STATES code the stream last carried for this slot. */
  drawn: number
}

/** A promoted person handed back: where the crowd is to put them (the rig's pelvis on the ground) and their facing. */
export interface Handback { agent: number; x: number; z: number; heading: number }

export interface RealmStats {
  promotions: number
  shoves: number
  kerbTrips: number
  slips: number
  /** Rigs removed (handed back to the crowd, or evicted). */
  handbacks: number
  /** m: at the last handback, how far the rig's pelvis stood from where the crowd had the person. */
  lastJump: number
  /** m: the largest such jump. */
  maxJump: number
}

const finite = (n: number): boolean => Number.isFinite(n)

/** Signed offset from the nearest street centreline on each axis (crowd.wgsl streetOffsets). */
const kerbSide = (x: number, z: number): boolean => {
  const ox = Math.abs(x - Math.round(x / CITY.pitch) * CITY.pitch), oz = Math.abs(z - Math.round(z / CITY.pitch) * CITY.pitch)
  return Math.min(ox, oz) < CITY.roadHalf
}

/** Rotates a vector by a unit quaternion (x, y, z, w). */
function rotate(q: { x: number; y: number; z: number; w: number }, v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x)
  return { x: v.x + q.w * tx + (q.y * tz - q.z * ty), y: v.y + q.w * ty + (q.z * tx - q.x * tz), z: v.z + q.w * tz + (q.x * ty - q.y * tx) }
}

export class RagdollRealm {
  readonly stats: RealmStats = { promotions: 0, shoves: 0, kerbTrips: 0, slips: 0, handbacks: 0, lastJump: 0, maxJump: 0 }
  readonly #physics: Physics
  readonly #sanctuary: Sanctuary
  readonly #pool = new RagdollPool(POOL_CAPACITY, PROMOTE_RADIUS)
  readonly #slots: Slot[]
  readonly #rng: () => number
  /** The direction each queued push is applied along (the pool carries the push, not its direction). */
  readonly #pushDir = new Map<number, { x: number; z: number }>()
  /** The previous crowd reading: its number, its clock, and every pedestrian's (x, z) then. */
  #prevSeq = -1
  #prevTime = 0
  #prevXZ: Float32Array
  /** The newest reading's positions (for the handback jump). */
  #xz: Float32Array
  /** The operator's position at the last observe(). */
  #opX = 0
  #opZ = 0
  /** Scratch: the pedestrians within PROMOTE_RADIUS this reading. */
  #near: number[] = []
  readonly #readings = new Map<number, Reading>()
  readonly #at = { x: 0, y: 0, z: 0 }
  /** Every pedestrian's facing in the newest reading (NaN where the reading carries none). */
  #heading: Float32Array
  readonly #handbacks: Handback[] = []

  constructor(physics: Physics, sanctuary: Sanctuary, seed: number, agentCount: number) {
    if (POOL_CAPACITY !== RIG_SLOTS) throw new Error(`the rig stream holds ${RIG_SLOTS} slots, the pool ${POOL_CAPACITY}`)
    this.#physics = physics
    this.#sanctuary = sanctuary
    this.#rng = createRng((seed ^ 0x5a1b) >>> 0)
    this.#slots = Array.from({ length: RIG_SLOTS }, () => ({ agent: -1, rig: null, shapes: [], hold: null, drawn: 0 }))
    this.#prevXZ = new Float32Array(agentCount * 2).fill(NaN)
    this.#xz = new Float32Array(agentCount * 2).fill(NaN)
    this.#heading = new Float32Array(agentCount).fill(NaN)
    Object.freeze(this)
  }

  /** Rigs built now. */
  get rigs(): number {
    let n = 0
    for (const s of this.#slots) if (s.rig) n++
    return n
  }

  /** The pedestrians promoted now, or handed back and still held (their crowd figures are hidden on the page), in slot order. */
  promoted(): number[] {
    const out: number[] = []
    for (const s of this.#slots) if (s.rig || s.hold) out.push(s.agent)
    return out
  }

  /** The handbacks since the last call, for the crowd to put down (CrowdSensor.place) before its next step. */
  takeHandbacks(): Handback[] {
    const out = this.#handbacks.slice()
    this.#handbacks.length = 0
    return out
  }

  /**
   * The crowd step `seq` was dispatched after the handbacks taken were written: each held slot waits for its reading.
   * `written` false (a crowd that cannot be written): the hold ends now and the figure is drawn where the crowd has it.
   */
  placed(seq: number, written: boolean): void {
    for (const s of this.#slots) {
      if (!s.hold || s.hold.until >= 0) continue
      if (written) s.hold.until = seq
      else this.#release(s, null)
    }
  }

  /** The balance state of pedestrian `agent`, or null when they are the crowd's alone. */
  stateOf(agent: number): string | null {
    return this.#pool.get(agent)?.machine.state ?? null
  }

  /**
   * One realm step's look at the crowd: the newest reading against the previous one (velocities), the causes above,
   * offered to the pool for the people within PROMOTE_RADIUS of the operator at (opX, opZ). `cars` are the fleet's
   * footprints now: nobody near a moving one is promoted. Nothing moves here; the pool acts on the next substep.
   */
  observe(readout: CrowdReadout | null, opX: number, opZ: number, cars: readonly VehicleFootprint[]): void {
    this.#opX = opX
    this.#opZ = opZ
    if (readout === null || readout.seq === this.#prevSeq) return
    const xz = readout.xz
    const n = Math.min(xz.length, this.#xz.length) >>> 1
    const prev = this.#prevXZ, cur = this.#xz
    if (readout.heading) this.#heading.set(readout.heading.subarray(0, Math.min(readout.heading.length, this.#heading.length)))
    // A held slot ends with the first reading taken after the crowd was told where the person is.
    for (const s of this.#slots) if (s.hold && s.hold.until >= 0 && readout.seq >= s.hold.until) this.#release(s, xz)
    const dt = readout.time - this.#prevTime
    const hadPrev = this.#prevSeq >= 0 && dt > 0 && dt <= MAX_READING_GAP
    cur.set(xz.subarray(0, 2 * n))
    const near = this.#near
    near.length = 0
    const r2 = PROMOTE_RADIUS * PROMOTE_RADIUS
    for (let i = OPERATOR_FIGURE + 1; i < n; i++) {
      const x = cur[2 * i], z = cur[2 * i + 1]
      const dx = x - opX, dz = z - opZ
      if (dx * dx + dz * dz <= r2 && finite(x) && finite(z)) near.push(i)
    }
    if (hadPrev && near.length > 0) {
      // Who is close to a moving car: not a candidate (a rig is never built where a car is about to be).
      const clear = (x: number, z: number): boolean => {
        for (let j = 0; j < cars.length; j++) {
          const c = cars[j]
          if (!c.active || Math.hypot(c.vx, c.vz) <= CAR_MOVING) continue
          if (Math.hypot(x - c.x, z - c.z) < c.halfLength + VEHICLE_CLEARANCE) return false
        }
        return true
      }
      const vel = (i: number): [number, number] | null => {
        const px = prev[2 * i], pz = prev[2 * i + 1]
        if (!finite(px) || !finite(pz)) return null
        return [(cur[2 * i] - px) / dt, (cur[2 * i + 1] - pz) / dt]
      }
      const offer = (i: number, cause: PerturbationCause, impulse: number, dirX: number, dirZ: number): boolean => {
        if (this.#pool.get(i) !== undefined || !clear(cur[2 * i], cur[2 * i + 1])) return false
        const v = vel(i) ?? [0, 0]
        const x = cur[2 * i], z = cur[2 * i + 1]
        const speed = Math.hypot(v[0], v[1])
        const decision = this.#pool.offer({
          id: i, distance: Math.hypot(x - opX, z - opZ), perturbation: { cause, impulse },
          // Facing where the crowd had them facing (someone standing at a crossing too), else along their walk.
          x, y: 0, z, vx: v[0], vy: 0, vz: v[1], heading: finite(this.#heading[i]) ? this.#heading[i] : speed > 0.1 ? Math.atan2(v[0], v[1]) : 0,
        })
        if (decision.kind !== 'promoted') return false
        const len = Math.hypot(dirX, dirZ)
        this.#pushDir.set(i, len > 1e-6 ? { x: dirX / len, z: dirZ / len } : { x: 1, z: 0 })
        this.stats.promotions++
        return true
      }
      // Shoves: pairs within SHOVE_DISTANCE closing faster than the threshold. Sorted on x, a sweep finds the pairs.
      near.sort((a, b) => cur[2 * a] - cur[2 * b])
      for (let a = 0; a < near.length; a++) {
        const i = near[a]
        const xi = cur[2 * i], zi = cur[2 * i + 1]
        for (let b = a + 1; b < near.length; b++) {
          const j = near[b]
          const dx = cur[2 * j] - xi
          if (dx > SHOVE_DISTANCE) break
          const dz = cur[2 * j + 1] - zi
          const d = Math.hypot(dx, dz)
          if (d > SHOVE_DISTANCE || d < 1e-6) continue
          const vi = vel(i), vj = vel(j)
          if (!vi || !vj) continue
          // Closing speed: how fast the gap shrinks (relative velocity against the separation).
          const closing = -((vj[0] - vi[0]) * dx + (vj[1] - vi[1]) * dz) / d
          if (closing <= SHOVE_CLOSING) continue
          // The slower one is shoved, along the line from the faster one.
          const si = Math.hypot(vi[0], vi[1]), sj = Math.hypot(vj[0], vj[1])
          const shoved = si <= sj ? i : j
          const sign = shoved === j ? 1 : -1
          if (offer(shoved, 'shove', PERSON_MASS * closing, sign * dx, sign * dz)) this.stats.shoves++
        }
      }
      // Kerb trips: the kerb line crossed faster than KERB_SPEED, along the way they were going.
      for (const i of near) {
        const v = vel(i)
        if (!v) continue
        const speed = Math.hypot(v[0], v[1])
        if (speed <= KERB_SPEED) continue
        if (kerbSide(prev[2 * i], prev[2 * i + 1]) === kerbSide(cur[2 * i], cur[2 * i + 1])) continue
        if (offer(i, 'kerbTrip', PERSON_MASS * speed * TRIP_SHARE, v[0], v[1])) this.stats.kerbTrips++
      }
      // Slips: one draw per reading, at the realm's own rate, on someone walking near the operator.
      if (this.#rng() < dt / SLIP_INTERVAL) {
        const i = near[Math.floor(this.#rng() * near.length)]
        const v = vel(i)
        if (v && Math.hypot(v[0], v[1]) > WALKING && offer(i, 'slip', SLIP_IMPULSE, v[0], v[1])) this.stats.slips++
      }
    }
    prev.set(cur.subarray(0, 2 * n))
    this.#prevSeq = readout.seq
    this.#prevTime = readout.time
  }

  /**
   * The start of one substep of `h` s, BEFORE the Sanctuary's guard: the pool steps every member on what its rig
   * measures, rigs are removed (recovering, evicted) and built (promoted) so the guard that follows sweeps every
   * shape as it now is, and queued pushes land.
   */
  tend(h: number): void {
    const readings = this.#readings
    readings.clear()
    for (const s of this.#slots) {
      if (!s.rig) continue
      const p = s.rig.bodies.pelvis.translation(this.#at)
      readings.set(s.agent, { ...measure(s.rig), distance: Math.hypot(p.x - this.#opX, p.z - this.#opZ) })
    }
    const ev = this.#pool.step(h, readings)
    for (const id of ev.remove) this.#free(id)
    for (const id of ev.build) this.#build(id)
    for (const { id, push } of ev.pushes) {
      const s = this.#slot(id)
      const d = this.#pushDir.get(id) ?? { x: 1, z: 0 }
      if (s?.rig) this.#push(s.rig, push, d.x, d.z)
    }
    for (const id of ev.released) this.#pushDir.delete(id)
  }

  /**
   * The rest of the substep, AFTER the guard: the state's gains, the shield (a sensor keeps no gravity and takes the
   * Sanctuary's nudge as a sidestep: `nudges` are the guard's, by ward index; null with the Sanctuary off), then the
   * powered joints and the assist.
   */
  drive(h: number, nudges: readonly Nudge[] | null): void {
    for (const s of this.#slots) {
      const rig = s.rig
      if (!rig) continue
      const m = this.#pool.get(s.agent)
      applyGains(rig, m?.machine.state ?? 'perturbed')
      for (const shape of s.shapes) {
        const body = shape.person.body
        const sensor = nudges !== null && this.#sanctuary.isSensor(shape.ward)
        if (sensor) {
          if (!shape.floating) {
            body.setGravityScale(0, true)
            shape.floating = true
          }
          const v = body.linvel()
          if (v.y < 0) body.setLinvel({ x: v.x, y: 0, z: v.z }, true)
          const n = nudges[shape.ward]
          const len = n ? Math.hypot(n.dx, n.dz) : 0
          if (len > 0) {
            // A sidestep at the nudge's own speed: the shape's velocity along it is topped up, never doubled.
            const nx = n!.dx / len, nz = n!.dz / len
            const want = len / h, have = v.x * nx + v.z * nz
            if (have < want) {
              const k = body.mass() * (want - have)
              body.applyImpulse({ x: k * nx, y: 0, z: k * nz }, true)
            }
          }
        } else if (shape.floating) {
          body.setGravityScale(1, true)
          shape.floating = false
        }
      }
      drive(rig, h)
    }
  }

  /** Appends one person per rig (its pelvis) to `out` from index `from` for the Fleet (setPeople); returns the new length. */
  peopleInto(out: Person[], from: number, present: boolean): number {
    let k = from
    for (const s of this.#slots) {
      if (!s.rig) continue
      const p = s.rig.bodies.pelvis.translation(this.#at)
      const q = out[k] ?? (out[k] = { x: 0, z: 0, present: false })
      q.x = p.x; q.z = p.z; q.present = present
      k++
    }
    return k
  }

  /**
   * Appends every shape of every rig to `out` from index `from` as a Ring-0 person (id PERSON_ID_BASE + 13 slot +
   * shape; solid while its collider is not a Sanctuary sensor; the capsule's radius); returns the new length.
   */
  auditInto(out: AuditPerson[], from: number): number {
    let k = from
    this.#slots.forEach((s, slot) => {
      if (!s.rig) return
      s.shapes.forEach((shape, j) => {
        const p = out[k] ?? (out[k] = { id: 0, x: 0, y: 0, z: 0, solid: true, radius: 0 })
        const at = this.#shapeAt(shape)
        p.id = PERSON_ID_BASE + RIG_POSE.segmentCount * slot + j
        p.x = at.x; p.y = at.y; p.z = at.z
        p.solid = shape.person.collider.isEnabled() && !this.#sanctuary.isSensor(shape.ward)
        p.radius = shape.spec.radius
        k++
      })
    })
    return k
  }

  /** Fills `out` with every slot's RIG_POSE slice (agent −1 and zeros for a free slot) and returns it. */
  write(out: Float32Array): Float32Array {
    if (out.length < RIG_SLOTS * RIG_POSE.stride) throw new RangeError(`the rig buffer holds ${out.length} floats, ${RIG_SLOTS * RIG_POSE.stride} are needed`)
    this.#slots.forEach((s, slot) => {
      const o = slot * RIG_POSE.stride
      if (!s.rig) {
        if (s.hold) out.set(s.hold.pose, o)
        else {
          out.fill(0, o, o + RIG_POSE.stride)
          out[o + RIG_POSE.agent] = -1
        }
        return
      }
      this.#slice(s, out, o)
      s.drawn = out[o + RIG_POSE.state]
    })
    return out
  }

  /** Slot `s`'s RIG_POSE slice (its rig as it stands now) into `out` at `o`. */
  #slice(s: Slot, out: Float32Array, o: number): void {
    {
      out[o + RIG_POSE.agent] = s.agent
      out[o + RIG_POSE.state] = Math.max(0, RIG_STATES.indexOf(this.#pool.get(s.agent)?.machine.state ?? 'perturbed'))
      s.shapes.forEach((shape, j) => {
        const b = o + RIG_POSE.segments + j * RIG_POSE.segmentStride
        const at = this.#shapeAt(shape), q = shape.person.body.rotation()
        out[b] = at.x; out[b + 1] = at.y; out[b + 2] = at.z
        out[b + 3] = q.x; out[b + 4] = q.y; out[b + 5] = q.z; out[b + 6] = q.w
      })
    }
  }

  /** Removes every rig and every hold (tests). */
  dispose(): void {
    for (const s of this.#slots) if (s.rig) this.#free(s.agent)
    for (const s of this.#slots) if (s.hold) this.#release(s, null)
  }

  /**
   * A held slot freed: the figure is the crowd's again. `xz`, the reading that ends the hold: the handback jump is the
   * last pose streamed against where that reading has the person.
   */
  #release(s: Slot, xz: Float32Array | null): void {
    const h = s.hold
    if (!h) return
    if (xz) {
      const cx = xz[2 * s.agent], cz = xz[2 * s.agent + 1]
      const jump = finite(cx) && finite(cz) ? Math.hypot(h.x - cx, h.z - cz) : NaN
      if (finite(jump)) {
        this.stats.lastJump = jump
        if (jump > this.stats.maxJump) this.stats.maxJump = jump
      }
    }
    // The reading before had them where the crowd walked them meanwhile: no velocity is read across the put-down (it
    // would read as a shove or a trip and promote them again).
    this.#prevXZ[2 * s.agent] = NaN
    this.#prevXZ[2 * s.agent + 1] = NaN
    s.hold = null
    s.agent = -1
  }

  #slot(agent: number): Slot | undefined {
    return this.#slots.find((s) => s.agent === agent)
  }

  /** A shape's centre: the body's, or the foot's offset from its lower leg. */
  #shapeAt(shape: Shape): { x: number; y: number; z: number } {
    const t = shape.person.body.translation(this.#at)
    if (!shape.spec.foot) return t
    const o = rotate(shape.person.body.rotation(), { x: FOOT.offset[0], y: FOOT.offset[1], z: FOOT.offset[2] })
    return { x: t.x + o.x, y: t.y + o.y, z: t.z + o.z }
  }

  #build(agent: number): void {
    const member = this.#pool.get(agent)
    // Promoted again while still held from the last handback: the hold ends (the new rig is drawn instead).
    for (const s of this.#slots) if (s.hold && s.agent === agent) this.#release(s, null)
    const slot = this.#slots.find((s) => s.agent < 0)
    if (!member || !slot) return
    const rig = buildRig(this.#physics.world, member.spawn)
    slot.rig = rig
    slot.agent = agent
    SHAPES.forEach((spec, j) => {
      const body = rig.bodies[spec.segment]
      const collider = body.collider(spec.foot ? 1 : 0)
      const shape = slot.shapes[j]
      if (shape) {
        shape.person.body = body
        shape.person.collider = collider
        shape.floating = false
        this.#sanctuary.rebind(shape.ward, shape.person)
      } else {
        // A foot is a collider off its lower leg's origin: the Sanctuary measures it there, as the audit does (#shapeAt).
        const person: PersonBody = { body, collider, radius: spec.radius, halfHeight: spec.halfHeight, offset: spec.foot ? FOOT.offset : undefined }
        slot.shapes[j] = { spec, person, ward: this.#sanctuary.register(person), floating: false }
      }
    })
  }

  #free(agent: number): void {
    const slot = this.#slot(agent)
    if (!slot?.rig) return
    // The handback: the crowd puts the person where the pelvis stands, facing as it faces, and the slot streams the rig's
    // last pose until the crowd's reading has them there.
    const pelvis = slot.rig.bodies.pelvis
    // Copied out: the scratch the translation lands in is reused by every shape the slice below reads.
    const at = pelvis.translation(this.#at)
    const p = { x: at.x, z: at.z }
    const f = rotate(pelvis.rotation(), { x: 0, y: 0, z: 1 })
    const heading = Math.hypot(f.x, f.z) > 1e-6 ? Math.atan2(f.x, f.z) : 0
    const pose = new Float32Array(RIG_POSE.stride)
    this.#slice(slot, pose, 0)
    // The state the page last drew (the machine has moved on to recovering, which the stream never shows).
    pose[RIG_POSE.state] = slot.drawn
    this.stats.handbacks++
    removeRig(this.#physics.world, slot.rig)
    slot.rig = null
    for (const shape of slot.shapes) shape.floating = false
    if (finite(p.x) && finite(p.z)) {
      this.#handbacks.push({ agent, x: p.x, z: p.z, heading })
      slot.hold = { pose, x: p.x, z: p.z, until: -1 }
    } else slot.agent = -1
  }

  #push(rig: BodyRig, push: Perturbation, dirX: number, dirZ: number): void {
    applyPush(rig, push, dirX, dirZ)
  }
}

Object.freeze(RagdollRealm)
Object.freeze(RagdollRealm.prototype)

/** Segment j's spec in stream order (the page's rigView.ts draws RIG_SEGMENTS; this pins them to the rig's SEGMENTS). */
export function shapeSpec(j: number): { segment: Segment; foot: boolean; halfHeight: number; radius: number; rigHalfHeight: number; rigRadius: number } {
  const s = SHAPES[j]
  if (!s) throw new RangeError(`no shape ${j} (0–${SHAPES.length - 1})`)
  const seg = SEGMENTS[s.segment]
  return {
    segment: s.segment, foot: s.foot, halfHeight: s.halfHeight, radius: s.radius,
    rigHalfHeight: s.foot ? FOOT.half[2] - FOOT.half[0] : seg.halfHeight, rigRadius: s.foot ? FOOT.half[0] : seg.radius,
  }
}
