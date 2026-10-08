// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the Ring-0 audit: after every physics tick, before anything is rendered
 * or sent to hardware, it re-checks — with its own Euclidean geometry, never Rapier's colliders — the
 * invariants that hold whenever the kernel (laws.ts, sanctuary.ts, the fleet's vetting) has done its job:
 * every state finite, no vehicle past the velocity cap, every vehicle inside the world slab, no solid
 * person inside a moving vehicle's footprint, and no moving vehicle closing on a solid person inside its
 * standoff while its applied command is anything but an emergency stop; and, over the scheduled craft stream
 * (the trains, drones and planes that have no body and no Bouncer), every value finite and every craft at or
 * above the floor of the corridor that keeps it away from people. A violation is a kernel panic:
 * the engine severs the hardware bridge, halts, and `kernelPanic` throws out of the frame. The 1.85 m
 * radius of the operator's directive is kept as a watched perimeter (counted, never panicked): measured
 * on this build, cars legally pass people on the sidewalk 1.1 m from their side and First-Law stops land
 * 1.7–2.0 m from the bumper, so a panic on that radius would lock a working kernel.
 * The exports are frozen (functions, class, prototype, instances) so nothing running in the page can
 * monkey-patch the audit away.
 * What breaks if it is removed? A failed kernel keeps running: a car through a person would be rendered
 * and felt on the hardware instead of locking the system.
 */
import { KERNEL } from './civic.ts'
import type { AuditStats } from '../05_Observe_Environment/telemetry.ts'
import { kernelPanic } from './ring0Panic.ts'

export { kernelPanic }

export const RING0 = Object.freeze({
  /** Watched perimeter, metres from a moving vehicle's footprint: breaches are counted, never panicked. */
  pacifistRadius: 1.85,
  /** m/s; above it the engine clamps the body (a correction), above twice it the tick is a RUNAWAY panic. */
  maxVelocity: 50,
  /** A chassis centre below this (m) has fallen through the ground. */
  groundFloor: -0.5,
  /** Metres from the centre, both axes: the ground slab (world.ts, physics.ts). */
  worldExtent: 1600,
  /** Metres the footprint is grown by for IMPACT. */
  contactMargin: 0.1,
  /** Metres each side of the footprint for the path test: the bouncer's sensing corridor. */
  corridorMargin: KERNEL.corridor,
  /** m/s below which a vehicle is standing. */
  movingSpeed: 0.5,
} as const)

export interface AuditVehicle {
  id: number
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  /** Forward = (sin heading, cos heading). */
  heading: number
  halfLength: number
  halfWidth: number
  /** Chassis-forward speed (signed; negative = reversing). */
  speed: number
  /** The command the kernel let through this tick. */
  throttle: number
  brake: number
  /** id of the person occupying it (the driver), or -1. */
  occupant: number
  /**
   * Path curvature the wheels follow, 1/m, positive = turning left (Fleet.curvature). With it the path
   * test bends exactly as the bouncer's corridor does; without it the path is straight ahead. Pass it: a
   * car at full lock never reaches the outer half of the straight band ahead of its bumper, so the bouncer
   * rightly leaves its throttle open there, and a straight audit would panic on a working kernel.
   */
  curvature?: number
  /**
   * World velocity at the start of the physics step, before any contact was resolved. A solid car driven into
   * a solid person is stopped by the contact in the very step it touches, so its post-step velocity alone reads
   * "standing": IMPACT takes the faster of the two toward the person. Without it only the post-step one is used.
   */
  preVx?: number
  preVz?: number
}

export interface AuditPerson {
  id: number; x: number; y: number; z: number; solid: boolean
  /** Contact radius of the person's collider in (x, z), m (a Rapier capsule's radius). Omitted = a point. */
  radius?: number
}

export type ViolationCode = 'NON_FINITE' | 'OUT_OF_BOUNDS' | 'RUNAWAY' | 'IMPACT' | 'UNGUARDED_APPROACH' | 'OFF_CORRIDOR'

/** `extent`: for OUT_OF_BOUNDS, the half-size of the slab that was breached, m (a region's differs from the city's). */
export interface Violation { code: ViolationCode; subject: string; detail: string; extent?: number }

export interface AuditResult {
  /** Empty when the tick is clean. The first violation is the panic reason. */
  violations: Violation[]
  /** Vehicle ids whose speed exceeded maxVelocity this tick (the engine clamps them). */
  capped: number[]
  /** Closest footprint gap to a solid person in any moving vehicle's path this tick (Infinity if none). */
  closest: number
  /** Solid people within the watched perimeter of a moving vehicle this tick (pairs). */
  perimeterBreaches: number
}

/** Rear axle: half the wheelbase behind the chassis centre (vehicles.ts CAR.wheelbase, crowd.wgsl CAR_AXLE). */
const AXLE = 1.4
const TAU = Math.PI * 2
/** The per-vehicle approach latch starts this long; it only grows, once, if the fleet is larger. */
const LATCH_SIZE = 64

/** A whole turn, normalised to [0, 2π), with a turn a hair short of 2π read as none (rounding at contact). */
function clockwise(angle: number): number {
  const t = angle - TAU * Math.floor(angle / TAU)
  return t > TAU - 1e-9 ? 0 : t
}

/**
 * Metres the vehicle travels (along its rear axle's path) before its footprint, widened by `half` either
 * side, reaches a person at `u` along the direction of travel and `lateral` to the chassis' left. This is
 * the bouncer's own measure (vehicles.ts corridorDistance: the kinematic bicycle model turning rigidly
 * about the rear axle's turn centre), so "in its path" here means exactly what "sensed" means there, and
 * whatever this finds inside the standoff the bouncer had inside its envelope. 0 inside the widened
 * footprint, Infinity beyond KERNEL.range or never. `dir` is 1 driving on, -1 reversing.
 */
function pathDistance(u: number, lateral: number, hl: number, half: number, curvature: number, dir: 1 | -1): number {
  if (Math.abs(u) <= hl && Math.abs(lateral) <= half) return 0
  const k = Math.abs(curvature)
  // Straight, and the fallback for a curvature that is not a number.
  if (!(k >= 1e-6)) {
    const s = u - hl
    return s >= 0 && s <= KERNEL.range && Math.abs(lateral) <= half ? s : Infinity
  }
  const r = 1 / k
  // A footprint point at ρ from the turn centre moves 2ρ·sin(θ/2) ≤ min(2ρ, ρ·range/r) over the range.
  const rhoMax = Math.hypot(hl + AXLE, r + half)
  const reach = Math.hypot(hl, half) + Math.min(2 * rhoMax, (rhoMax * KERNEL.range) / r)
  if (u * u + lateral * lateral > reach * reach) return Infinity
  // Mirror a right turn onto a left one: the turn centre is at lateral +r, level with the rear axle.
  // Travel turns the car counter-clockwise about it, so the person turns clockwise relative to the car.
  const l = curvature > 0 ? lateral : -lateral
  const au = -dir * AXLE
  const phi0 = Math.atan2(l - r, u - au)
  let best = Infinity
  for (let e = -1; e <= 1; e += 2) {
    // An end, u = ±hl: the person's circle crosses it at lateral r ± q.
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

const FIELDS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'heading', 'speed', 'halfLength', 'halfWidth', 'throttle', 'brake', 'curvature', 'preVx', 'preVz'] as const

/** The non-finite fields of a vehicle as `name=value` pairs ('' when every field is finite). Allocates only on a fault. */
function nonFinite(v: AuditVehicle): string {
  if (Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) && Number.isFinite(v.vx) && Number.isFinite(v.vy) &&
    Number.isFinite(v.vz) && Number.isFinite(v.heading) && Number.isFinite(v.speed) && Number.isFinite(v.halfLength) &&
    Number.isFinite(v.halfWidth) && Number.isFinite(v.throttle) && Number.isFinite(v.brake) && (v.curvature === undefined || Number.isFinite(v.curvature)) &&
    (v.preVx === undefined || Number.isFinite(v.preVx)) && (v.preVz === undefined || Number.isFinite(v.preVz))) return ''
  let out = ''
  for (const name of FIELDS) {
    const value = v[name]
    if (value !== undefined && !Number.isFinite(value)) out += `${out ? ' ' : ''}${name}=${value}`
  }
  return out
}

const m3 = (x: number): string => `${x.toFixed(3)}m`

/**
 * The scheduled craft stream (the train sets, drones and planes on the corridors of 06_Make_Decisions/tracks.ts,
 * packed by 07_Execute_Actions/trackFleet.ts) as this audit reads it: `stride` floats per craft, named in `fields`
 * (simProtocol.ts TRACK_POSE; ring0.test.ts pins the two equal), the kind codes of `kinds` (simProtocol.ts
 * TRACK_KINDS), and per kind the floor of its corridor, m over the street plane: a train's deck, the lower drone
 * altitude, the planes' altitude (tracks.ts TRACKS, pinned equal by ring0.test.ts). A craft has no body, no driver
 * and no Bouncer: what keeps it from ever reaching a person is that its corridor is in the air (tracks.test.ts
 * INV-1), so one below its floor, or of a kind with no corridor (a car: NaN), has left the proof and halts the realm.
 */
export const CRAFT = Object.freeze({
  stride: 8,
  fields: Object.freeze(['x', 'y', 'z', 'heading', 'kind', 'track', 's', 'speed'] as const),
  y: 1,
  kind: 4,
  kinds: Object.freeze(['car', 'train', 'drone', 'plane'] as const),
  floor: Object.freeze([NaN, 9, 40, 400] as const),
} as const)

/**
 * Audits one craft buffer, allocating only for a violation: every value finite, every craft of a kind that has a
 * corridor and at or above its floor, and the buffer a whole number of craft. The first fault found is returned
 * (NON_FINITE or OFF_CORRIDOR); null when the buffer is clean. It only ever halts: nothing is corrected.
 */
export function auditCraft(craft: Float32Array): Violation | null {
  const { stride, fields, y: Y, kind: K, kinds, floor } = CRAFT
  const n = Math.floor(craft.length / stride)
  if (craft.length !== n * stride) return { code: 'OFF_CORRIDOR', subject: 'craft buffer', detail: `${craft.length} floats is not a whole number of craft` }
  for (let i = 0; i < n; i++) {
    const o = i * stride
    for (let f = 0; f < stride; f++) {
      const v = craft[o + f]
      if (!Number.isFinite(v)) return { code: 'NON_FINITE', subject: `craft ${i}`, detail: `${fields[f]}=${v}` }
    }
    const kind = craft[o + K]
    const fl = Number.isInteger(kind) && kind >= 0 && kind < floor.length ? floor[kind] : NaN
    if (Number.isNaN(fl)) return { code: 'OFF_CORRIDOR', subject: `craft ${i}`, detail: `kind ${kind} (${kinds[kind] ?? 'unknown'}) has no corridor` }
    const y = craft[o + Y]
    if (y < fl) return { code: 'OFF_CORRIDOR', subject: `${kinds[kind]} craft ${i}`, detail: `y=${y.toFixed(2)}m below its ${fl}m floor` }
  }
  return null
}

export class Ring0Auditor {
  /** Cumulative over the session; `panic` holds the first reason once one has fired. */
  readonly stats: AuditStats = { ticks: 0, perimeterBreaches: 0, velocityCaps: 0, closest: Infinity, panic: null }
  private readonly centre: { x: number; z: number }
  /** Half the containment slab's side, m: the city's (RING0.worldExtent) unless a region set its own. */
  private readonly extent: number
  private readonly standoff: number
  private readonly maxBrake: number
  /** The one result every run() returns: its arrays are emptied, never replaced. */
  private readonly result: AuditResult = { violations: [], capped: [], closest: Infinity, perimeterBreaches: 0 }
  /**
   * Per vehicle (by position in `vehicles`): 1 when the unguarded-approach condition held last tick. The
   * kernel vets every command at the start of a frame and the audit runs at its end, so a person can enter
   * the standoff inside one frame (a runner covers 9 cm) while the command was ruled with them outside;
   * that clears at the next vet, a failed kernel does not. UNGUARDED_APPROACH therefore needs two
   * consecutive ticks; IMPACT never waits. An ES private field: writable on the frozen instance.
   */
  #latch = new Uint8Array(LATCH_SIZE)

  constructor(centre: { x: number; z: number }, opts: { standoff?: number; maxBrake?: number; extent?: number } = {}) {
    this.centre = { x: centre.x, z: centre.z }
    const extent = opts.extent ?? RING0.worldExtent
    if (!(Number.isFinite(extent) && extent > 0)) throw new RangeError(`the containment slab must be a positive size, got ${extent}`)
    this.extent = extent
    this.standoff = opts.standoff ?? KERNEL.standoff
    this.maxBrake = opts.maxBrake ?? KERNEL.maxBrake
    Object.freeze(this)
  }

  /**
   * Audits one tick; reuses one result object, allocating only for a violation. Order: people finite;
   * then per vehicle finite, RUNAWAY, OUT_OF_BOUNDS, IMPACT per solid person, UNGUARDED_APPROACH. The
   * first violation is the panic reason. `harnessBlind`: UNGUARDED_APPROACH is suspended (a harness has
   * blinded person sensing on purpose, so the bouncer cannot have stopped anything); IMPACT never is.
   */
  run(vehicles: readonly AuditVehicle[], people: readonly AuditPerson[], harnessBlind: boolean): AuditResult {
    const r = this.result
    const violations = r.violations
    violations.length = 0
    r.capped.length = 0
    r.closest = Infinity
    r.perimeterBreaches = 0
    if (this.#latch.length < vehicles.length) this.#latch = new Uint8Array(Math.max(vehicles.length, 2 * this.#latch.length))
    const latch = this.#latch
    const { pacifistRadius, maxVelocity, groundFloor, contactMargin, corridorMargin, movingSpeed } = RING0
    const worldExtent = this.extent

    for (let j = 0; j < people.length; j++) {
      const p = people[j]
      if (!(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))) {
        violations.push({ code: 'NON_FINITE', subject: `person ${p.id}`, detail: `x=${p.x} y=${p.y} z=${p.z}` })
      }
    }

    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i]
      // 1. Non-finite state: nothing below can be measured on it.
      const bad = nonFinite(v)
      if (bad) {
        violations.push({ code: 'NON_FINITE', subject: `vehicle ${v.id}`, detail: bad })
        latch[i] = 0
        continue
      }
      // 2. Velocity: a correction up to twice the cap, a panic beyond it.
      const body = Math.hypot(v.vx, v.vy, v.vz)
      if (body > 2 * maxVelocity) violations.push({ code: 'RUNAWAY', subject: `vehicle ${v.id}`, detail: `${body.toFixed(2)}m/s` })
      else if (body > maxVelocity) r.capped.push(v.id)
      // 3. Containment.
      if (v.y < groundFloor || Math.abs(v.x - this.centre.x) > worldExtent || Math.abs(v.z - this.centre.z) > worldExtent) {
        violations.push({ code: 'OUT_OF_BOUNDS', subject: `vehicle ${v.id}`, detail: `x=${v.x.toFixed(2)}m y=${v.y.toFixed(2)}m z=${v.z.toFixed(2)}m`, extent: worldExtent })
      }
      // 4. Pacifist invariants, against the footprint as an oriented box in (x, z).
      const moving = Math.hypot(v.vx, v.vz) > movingSpeed
      const dir: 1 | -1 | 0 = v.speed > movingSpeed ? 1 : v.speed < -movingSpeed ? -1 : 0
      const emergency = v.throttle === 0 && v.brake >= this.maxBrake
      const fx = Math.sin(v.heading), fz = Math.cos(v.heading)
      const hl = v.halfLength, hw = v.halfWidth, half = hw + corridorMargin
      const curvature = v.curvature ?? 0
      let unguarded = Infinity
      for (let j = 0; j < people.length; j++) {
        const p = people[j]
        if (!p.solid || p.id === v.occupant || !(Number.isFinite(p.x) && Number.isFinite(p.z))) continue
        const dx = p.x - v.x, dz = p.z - v.z
        // Chassis frame: u forward, lateral to the left.
        const u = dx * fx + dz * fz
        const lateral = dx * fz - dz * fx
        const du = Math.abs(u) - hl, dw = Math.abs(lateral) - hw
        const gap = du <= 0 && dw <= 0 ? 0 : Math.hypot(Math.max(du, 0), Math.max(dw, 0))
        // IMPACT: the person's centre inside the moving footprint (+ margin), or their collider touching it while
        // the car was driving INTO them (its velocity toward them, before or after the step, above movingSpeed).
        // Contact alone is not enough: touching the side of a car rolling past, or the back of one pulling away,
        // is not an impact, and the Sanctuary does not shield those either.
        let impact = moving && du <= contactMargin && dw <= contactMargin
        if (!impact && gap > 0 && gap <= (p.radius ?? 0) + contactMargin) {
          // Outward normal from the footprint's nearest point toward the person, in world (x, z).
          const nu = (u - Math.max(-hl, Math.min(hl, u))) / gap
          const nl = (lateral - Math.max(-hw, Math.min(hw, lateral))) / gap
          const nx = nu * fx + nl * fz, nz = nu * fz - nl * fx
          const closing = Math.max(v.vx * nx + v.vz * nz, (v.preVx ?? v.vx) * nx + (v.preVz ?? v.vz) * nz)
          impact = closing > movingSpeed
        }
        if (impact) violations.push({ code: 'IMPACT', subject: `vehicle ${v.id}, person ${p.id}`, detail: m3(gap) })
        if (moving && gap < pacifistRadius) r.perimeterBreaches++
        if (dir !== 0) {
          const d = pathDistance(u * dir, lateral, hl, half, curvature, dir)
          if (d < r.closest) r.closest = d
          if (d > 0 && d <= this.standoff && !emergency && d < unguarded) unguarded = d
        }
      }
      if (unguarded !== Infinity && !harnessBlind) {
        if (latch[i] !== 0) {
          const way = dir > 0 ? 'ahead' : 'behind'
          const detail = `${m3(unguarded)} ${way} at ${Math.abs(v.speed).toFixed(1)}m/s, throttle ${v.throttle.toFixed(2)}, brake ${v.brake.toFixed(1)}m/s²`
          violations.push({ code: 'UNGUARDED_APPROACH', subject: `vehicle ${v.id}`, detail })
        } else latch[i] = 1
      } else latch[i] = 0
    }

    const s = this.stats
    s.ticks++
    if (r.perimeterBreaches > 0) s.perimeterBreaches++
    s.velocityCaps += r.capped.length
    if (r.closest < s.closest) s.closest = r.closest
    return r
  }

  /** Records the panic reason in stats (the engine calls this right before kernelPanic). The first one stands. */
  markPanic(reason: string): void {
    if (this.stats.panic === null) this.stats.panic = reason
  }
}

/** Formats the reason the directive's way: 'First-Law Violation: Perimeter breached (0.412m)', 'IEEE 754 Exploit: …', … */
export function panicReason(v: Violation): string {
  switch (v.code) {
    case 'NON_FINITE': return `IEEE 754 Exploit: Non-finite spatial matrix generated (${v.subject}: ${v.detail}).`
    case 'RUNAWAY': return `Velocity Exploit: ${v.detail} exceeds hardcap (${v.subject}).`
    case 'OUT_OF_BOUNDS': return `OOB Exploit: ${v.subject} breached the ${v.extent ?? RING0.worldExtent}m containment slab (${v.detail}).`
    case 'IMPACT': return `First-Law Violation: Perimeter breached (${v.detail}) — ${v.subject}.`
    case 'UNGUARDED_APPROACH': return `First-Law Violation: Unguarded approach (${v.detail}) — ${v.subject}.`
    case 'OFF_CORRIDOR': return `Corridor Exploit: ${v.subject} left its corridor (${v.detail}).`
  }
}

Object.freeze(Ring0Auditor)
Object.freeze(Ring0Auditor.prototype)
Object.freeze(panicReason)
Object.freeze(auditCraft)
