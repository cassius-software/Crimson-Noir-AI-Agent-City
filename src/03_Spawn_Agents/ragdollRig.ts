// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the physical body of an active ragdoll in the realm's Rapier world: eleven capsule
 * segments (pelvis, torso, head, upper and lower legs with flat feet, upper and lower arms) joined by ten powered
 * joints (spherical spine, neck, hips and shoulders; revolute knees and elbows, with limits). It builds a rig where the
 * crowd had the person (same place, heading and velocity, so nothing jumps), applies the balance machine's motor gains
 * and upright assist each tick, reads back what the machine needs (ragdoll.ts BalanceInputs), and removes every body,
 * shape and joint it made. Like physics.ts, it is for the physics worker only: the page never loads Rapier.
 * What breaks if it is removed? Nothing yet: this is scaffolding the engine does not call. Without it, the balance
 * machine has no body to drive.
 *
 * The caller has awaited RAPIER.init(). Segments touch the world but not each other (their own contact group); the
 * joints hold them together. Rapier's spherical joints take no limits here, so the powered joints hold the range;
 * knees and elbows have hard limits.
 */
import RAPIER from '@dimforge/rapier3d-simd-compat'
import type { BalanceInputs, BalanceState, Continuity, MotorGains, Perturbation } from './ragdoll.ts'
import { GAINS } from './ragdoll.ts'

export type Segment =
  | 'pelvis' | 'torso' | 'head'
  | 'upperLegL' | 'lowerLegL' | 'upperLegR' | 'lowerLegR'
  | 'upperArmL' | 'lowerArmL' | 'upperArmR' | 'lowerArmR'

interface SegmentSpec {
  /** Centre in the standing pose, person facing +z, feet on y = 0: [x, y]. */
  at: readonly [number, number]
  halfHeight: number
  radius: number
  mass: number
}

/** A 1.75 m adult: 74 kg of segments, and 1 kg for each foot (FOOT). */
export const SEGMENTS: Readonly<Record<Segment, SegmentSpec>> = Object.freeze({
  pelvis: { at: [0, 0.97], halfHeight: 0.04, radius: 0.14, mass: 12 },
  torso: { at: [0, 1.3], halfHeight: 0.12, radius: 0.16, mass: 26 },
  head: { at: [0, 1.66], halfHeight: 0.01, radius: 0.11, mass: 5 },
  upperLegL: { at: [0.1, 0.7], halfHeight: 0.14, radius: 0.07, mass: 8 },
  lowerLegL: { at: [0.1, 0.28], halfHeight: 0.14, radius: 0.055, mass: 3.5 },
  upperLegR: { at: [-0.1, 0.7], halfHeight: 0.14, radius: 0.07, mass: 8 },
  lowerLegR: { at: [-0.1, 0.28], halfHeight: 0.14, radius: 0.055, mass: 3.5 },
  upperArmL: { at: [0.24, 1.38], halfHeight: 0.1, radius: 0.05, mass: 2.2 },
  lowerArmL: { at: [0.24, 1.1], halfHeight: 0.1, radius: 0.045, mass: 1.8 },
  upperArmR: { at: [-0.24, 1.38], halfHeight: 0.1, radius: 0.05, mass: 2.2 },
  lowerArmR: { at: [-0.24, 1.1], halfHeight: 0.1, radius: 0.045, mass: 1.8 },
})

/** The flat foot under each lower leg: half extents and its centre relative to the lower leg's centre. */
export const FOOT = Object.freeze({ half: [0.05, 0.03, 0.12] as const, offset: [0, -0.25, 0.05] as const, mass: 1 })

type JointKind = 'spherical' | 'revolute'
interface JointSpec {
  parent: Segment
  child: Segment
  kind: JointKind
  /** Joint point in the standing pose: [x, y]. */
  at: readonly [number, number]
  /** Revolute limits about +x (child relative to parent), rad. */
  limits?: readonly [number, number]
  /** Revolute rest angle the motor holds, rad. */
  rest?: number
  /** Share of the state's gains this joint gets. */
  scale: number
}

export const JOINTS: readonly Readonly<JointSpec>[] = Object.freeze([
  { parent: 'pelvis', child: 'torso', kind: 'spherical', at: [0, 1.08], scale: 1 },
  { parent: 'torso', child: 'head', kind: 'spherical', at: [0, 1.56], scale: 0.3 },
  { parent: 'pelvis', child: 'upperLegL', kind: 'spherical', at: [0.1, 0.9], scale: 1 },
  { parent: 'pelvis', child: 'upperLegR', kind: 'spherical', at: [-0.1, 0.9], scale: 1 },
  { parent: 'upperLegL', child: 'lowerLegL', kind: 'revolute', at: [0.1, 0.49], limits: [0, 2.3], rest: 0.05, scale: 1 },
  { parent: 'upperLegR', child: 'lowerLegR', kind: 'revolute', at: [-0.1, 0.49], limits: [0, 2.3], rest: 0.05, scale: 1 },
  { parent: 'torso', child: 'upperArmL', kind: 'spherical', at: [0.24, 1.52], scale: 0.2 },
  { parent: 'torso', child: 'upperArmR', kind: 'spherical', at: [-0.24, 1.52], scale: 0.2 },
  { parent: 'upperArmL', child: 'lowerArmL', kind: 'revolute', at: [0.24, 1.24], limits: [-2.4, 0], rest: -0.2, scale: 0.1 },
  { parent: 'upperArmR', child: 'lowerArmR', kind: 'revolute', at: [-0.24, 1.24], limits: [-2.4, 0], rest: -0.2, scale: 0.1 },
])

/**
 * Contact group of rig segments: they meet the world, never another segment, and never a vehicle's chassis (bit
 * 0x0002) or wheel ray (bit 0x0001): a rig is out of the vehicle layer, so a car reaching one exchanges no impulse
 * and cannot ride up on it. Rapier packs membership << 16 | filter. The realm's bit table (02_Define_The_Rules,
 * RAGDOLL_GROUPS) says the same, and its test holds this literal equal to it; the table is not imported here, as this
 * file's wording is held to balance alone.
 */
export const RAGDOLL_GROUP = 0x0004
const GROUPS = (RAGDOLL_GROUP << 16) | (0xffff & ~(RAGDOLL_GROUP | 0x0002 | 0x0001))

/**
 * The assist, the stand-in for what legs and ankles do for a standing person (applyAssist): an upright turn of the torso
 * and pelvis and a pull of the pelvis over the feet (both scaled by the state's `assist`), and a support force holding
 * the pelvis at standing height (scaled by its `support`). Sitting down is less support with the trunk still held.
 */
export const ASSIST = Object.freeze({
  /** Upright: wanted turn rate per rad of tilt (1/s), share of the rate gap closed per tick, torque cap (N·m). */
  rate: 12,
  fraction: 0.5,
  maxTorque: 600,
  /** Support: N per m of sag; damping N per m/s (kept under half the pelvis's mass per tick); cap × body weight. */
  lift: 6000,
  liftDamping: 300,
  maxLift: 1.3,
  /**
   * Ankle strategy: a horizontal pull keeping the pelvis over the middle of the feet, N per m and per m/s, capped at
   * `maxCenter` times the body's weight. The cap is the person's balance capacity: a push beyond it must be caught
   * by stepping, or by sitting down.
   */
  center: 800,
  centerDamping: 150,
  maxCenter: 0.12,
})
/** Pelvis height of the standing pose above the ground, m. */
export const STANDING_PELVIS = 0.97

export interface Rig {
  readonly bodies: Readonly<Record<Segment, RAPIER.RigidBody>>
  readonly joints: readonly RAPIER.ImpulseJoint[]
  readonly groundY: number
  readonly mass: number
  /** The gains drive() uses (applyGains sets them from the balance state). */
  gains: Readonly<MotorGains>
}

/** N·m a joint of scale 1 can exert at most (a hip or knee); others get their scale's share. */
export const STRENGTH = 400

const rotY = (x: number, z: number, h: number): [number, number] => [x * Math.cos(h) + z * Math.sin(h), -x * Math.sin(h) + z * Math.cos(h)]

/** Builds a standing rig at the person's feet (`c.x`, `c.y` = ground, `c.z`), facing `c.heading`, moving at `c.v*`. */
export function buildRig(world: RAPIER.World, c: Continuity): Rig {
  const q = { x: 0, y: Math.sin(c.heading / 2), z: 0, w: Math.cos(c.heading / 2) }
  const bodies = {} as Record<Segment, RAPIER.RigidBody>
  let mass = 0
  for (const [name, s] of Object.entries(SEGMENTS) as [Segment, SegmentSpec][]) {
    const [ox, oz] = rotY(s.at[0], 0, c.heading)
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(c.x + ox, c.y + s.at[1], c.z + oz)
        .setRotation(q)
        .setLinvel(c.vx, c.vy, c.vz)
        .setAngularDamping(0.5),
    )
    world.createCollider(RAPIER.ColliderDesc.capsule(s.halfHeight, s.radius).setMass(s.mass).setFriction(0.9).setCollisionGroups(GROUPS), body)
    mass += s.mass
    if (name === 'lowerLegL' || name === 'lowerLegR') {
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(...FOOT.half).setTranslation(...FOOT.offset).setMass(FOOT.mass).setFriction(1).setCollisionGroups(GROUPS),
        body,
      )
      mass += FOOT.mass
    }
    bodies[name] = body
  }
  const joints = JOINTS.map((j) => {
    const p = SEGMENTS[j.parent].at, ch = SEGMENTS[j.child].at
    const a1 = { x: j.at[0] - p[0], y: j.at[1] - p[1], z: 0 }
    const a2 = { x: j.at[0] - ch[0], y: j.at[1] - ch[1], z: 0 }
    const data = j.kind === 'spherical' ? RAPIER.JointData.spherical(a1, a2) : RAPIER.JointData.revolute(a1, a2, { x: 1, y: 0, z: 0 })
    if (j.limits) {
      data.limitsEnabled = true
      data.limits = [j.limits[0], j.limits[1]]
    }
    const joint = world.createImpulseJoint(data, bodies[j.parent], bodies[j.child], true)
    joint.setContactsEnabled(false)
    return joint
  })
  return { bodies, joints, groundY: c.y, mass, gains: GAINS.perturbed }
}

/** Unit quaternion helpers (x, y, z, w). */
type Quat = { x: number; y: number; z: number; w: number }
const qmul = (a: Quat, b: Quat): Quat => ({
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
})
const qconj = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w })

/** Scalar tumbling inertia of a segment about its centre (a solid cylinder of the capsule's length), kg·m². */
function segmentInertia(name: Segment): number {
  const s = SEGMENTS[name]
  const len = 2 * (s.halfHeight + s.radius)
  const foot = name === 'lowerLegL' || name === 'lowerLegR' ? FOOT.mass * 0.25 ** 2 : 0
  return (s.mass * (3 * s.radius * s.radius + len * len)) / 12 + foot
}

/**
 * The inertia each joint's servo sizes its impulse by: the reduced inertia of its two segments. That is the least the
 * joint ever moves, so one tick never overshoots (a leg carrying the body moves more, and is corrected over more ticks);
 * sizing by the whole body above made free limbs overshoot and flail (measured). Carrying the body's weight is the
 * assist's job (applyAssist), not the joints'.
 */
export const JOINT_INERTIA: readonly number[] = JOINTS.map((j) => {
  const a = segmentInertia(j.parent), b = segmentInertia(j.child)
  return (a * b) / (a + b)
})

/**
 * Sets the gains the powered joints use from now on. The joints are driven by the rig itself (drive), not by Rapier's
 * joint motors: Rapier 0.21's JS motors proved too weak to carry a body (a 1 kg arm on a revolute motor of stiffness
 * 10⁴ still sagged 0.43 of 0.5 m in 2 s), its spherical joints come back as generic joints with no motor methods, and
 * its multibody joints have none.
 */
export function applyGains(rig: Rig, state: BalanceState, gains: Readonly<MotorGains> = GAINS[state]): void {
  rig.gains = gains
}

/**
 * One tick of the powered joints and the upright assist, before world.step(). Each joint is a velocity servo: the
 * relative angular velocity it wants is `stiffness` (1/s) times the pose error, and one tick removes the fraction
 * `damping` (0…1) of the gap by an equal and opposite angular impulse on parent and child, capped at the joint's
 * share of STRENGTH. Correcting velocity (not applying a spring force) keeps it stable on light segments at 60 Hz.
 */
export function drive(rig: Rig, dt: number): void {
  const g = rig.gains
  if (g.stiffness > 0 || g.damping > 0) {
    JOINTS.forEach((j, i) => {
      const p = rig.bodies[j.parent], c = rig.bodies[j.child]
      const qp = p.rotation(), qc = c.rotation()
      const rest: Quat = j.rest ? { x: Math.sin(j.rest / 2), y: 0, z: 0, w: Math.cos(j.rest / 2) } : { x: 0, y: 0, z: 0, w: 1 }
      let e = qmul(qc, qconj(qmul(qp, rest)))
      if (e.w < 0) e = { x: -e.x, y: -e.y, z: -e.z, w: -e.w }
      const sinHalf = Math.hypot(e.x, e.y, e.z)
      const angle = 2 * Math.atan2(sinHalf, e.w)
      const k = sinHalf > 1e-9 ? angle / sinHalf : 2
      const wp = p.angvel(), wc = c.angvel()
      const gap = {
        x: -g.stiffness * e.x * k - (wc.x - wp.x),
        y: -g.stiffness * e.y * k - (wc.y - wp.y),
        z: -g.stiffness * e.z * k - (wc.z - wp.z),
      }
      const inertia = JOINT_INERTIA[i]
      let jx = gap.x * inertia * g.damping, jy = gap.y * inertia * g.damping, jz = gap.z * inertia * g.damping
      const cap = STRENGTH * j.scale * dt
      const mag = Math.hypot(jx, jy, jz)
      if (mag > cap) {
        jx *= cap / mag
        jy *= cap / mag
        jz *= cap / mag
      }
      c.applyTorqueImpulse({ x: jx, y: jy, z: jz }, true)
      p.applyTorqueImpulse({ x: -jx, y: -jy, z: -jz }, true)
    })
  }
  applyAssist(rig, g.assist, g.support, dt)
}

/** Rotates a vector by a unit quaternion. */
function rotate(q: Quat, v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x)
  return { x: v.x + q.w * tx + (q.y * tz - q.z * ty), y: v.y + q.w * ty + (q.z * tx - q.x * tz), z: v.z + q.w * tz + (q.x * ty - q.y * tx) }
}

/** The middle of the two feet on the ground plane (x, z): the centre of the support. */
function supportCentre(rig: Rig): { x: number; z: number } {
  const foot = (b: RAPIER.RigidBody) => {
    const t = b.translation(), o = rotate(b.rotation(), { x: FOOT.offset[0], y: FOOT.offset[1], z: FOOT.offset[2] })
    return { x: t.x + o.x, z: t.z + o.z }
  }
  const l = foot(rig.bodies.lowerLegL), r = foot(rig.bodies.lowerLegR)
  return { x: (l.x + r.x) / 2, z: (l.z + r.z) / 2 }
}

/** Rotates (0, 1, 0) by a unit quaternion. */
function up(q: RAPIER.Rotation): { x: number; y: number; z: number } {
  return { x: 2 * (q.x * q.y - q.w * q.z), y: 1 - 2 * (q.x * q.x + q.z * q.z), z: 2 * (q.y * q.z + q.w * q.x) }
}

/**
 * The assist for one tick of `dt` s (see ASSIST): lift under the pelvis scaled by `support` (never pulls down); and,
 * scaled by `assist`, a capped pull of the pelvis over the feet and a velocity servo turning the torso and pelvis back
 * toward vertical (about horizontal axes only).
 */
export function applyAssist(rig: Rig, assist: number, support: number, dt: number): void {
  const pelvis = rig.bodies.pelvis
  if (support > 0) {
    const sag = STANDING_PELVIS - (pelvis.translation().y - rig.groundY)
    const lift = Math.min(ASSIST.maxLift * rig.mass * 9.81, Math.max(0, ASSIST.lift * sag - ASSIST.liftDamping * pelvis.linvel().y))
    pelvis.applyImpulse({ x: 0, y: lift * support * dt, z: 0 }, true)
  }
  if (!(assist > 0)) return
  const sc = supportCentre(rig), p = pelvis.translation(), v = pelvis.linvel()
  let fx = ASSIST.center * (sc.x - p.x) - ASSIST.centerDamping * v.x
  let fz = ASSIST.center * (sc.z - p.z) - ASSIST.centerDamping * v.z
  const fmag = Math.hypot(fx, fz), fcap = ASSIST.maxCenter * rig.mass * 9.81
  if (fmag > fcap) {
    fx *= fcap / fmag
    fz *= fcap / fmag
  }
  pelvis.applyImpulse({ x: fx * assist * dt, y: 0, z: fz * assist * dt }, true)
  for (const name of ['torso', 'pelvis'] as const) {
    const b = rig.bodies[name]
    const u = up(b.rotation())
    // Axis of the correction: up × world-up = (−u.z, 0, u.x); its length is sin(tilt).
    const ax = -u.z, az = u.x
    const tilt = Math.atan2(Math.hypot(ax, az), u.y)
    const len = Math.hypot(ax, az)
    const w = b.angvel()
    // A velocity servo, like the joints: an explicit damping torque would exceed its stability limit on the pelvis.
    const wx = len > 1e-9 ? (ax / len) * ASSIST.rate * tilt : 0
    const wz = len > 1e-9 ? (az / len) * ASSIST.rate * tilt : 0
    const inertia = segmentInertia(name) * ASSIST.fraction * assist
    let jx = (wx - w.x) * inertia, jz = (wz - w.z) * inertia
    const mag = Math.hypot(jx, jz), cap = ASSIST.maxTorque * dt
    if (mag > cap) {
      jx *= cap / mag
      jz *= cap / mag
    }
    b.applyTorqueImpulse({ x: jx, y: 0, z: jz }, true)
  }
}

/** Applies a push to the torso: `impulse` N·s along (dirX, dirZ) (normalised here), at chest height. */
export function applyPush(rig: Rig, push: Perturbation, dirX: number, dirZ: number): void {
  const len = Math.hypot(dirX, dirZ)
  if (!(len > 0)) return
  const t = rig.bodies.torso
  const p = t.translation()
  t.applyImpulseAtPoint({ x: (dirX / len) * push.impulse, y: 0, z: (dirZ / len) * push.impulse }, { x: p.x, y: p.y + 0.1, z: p.z }, true)
}

/** What the balance machine reads (ragdoll.ts BalanceInputs, without a push). */
export function measure(rig: Rig): BalanceInputs {
  const torso = rig.bodies.torso
  const u = up(torso.rotation())
  const w = torso.angvel()
  let mx = 0, mz = 0, m = 0
  for (const b of Object.values(rig.bodies)) {
    const p = b.translation(), bm = b.mass()
    mx += p.x * bm
    mz += p.z * bm
    m += bm
  }
  const sc = supportCentre(rig)
  return {
    tilt: Math.acos(Math.max(-1, Math.min(1, u.y))),
    tiltRate: Math.hypot(w.x, w.z),
    comOffset: Math.hypot(mx / m - sc.x, mz / m - sc.z),
    pelvisHeight: rig.bodies.pelvis.translation().y - rig.groundY,
  }
}

/** Removes the rig: its joints, then its bodies (and with them their shapes). Nothing of it is left in the world. */
export function removeRig(world: RAPIER.World, rig: Rig): void {
  for (const j of rig.joints) if (j.isValid()) world.removeImpulseJoint(j, true)
  for (const b of Object.values(rig.bodies)) if (b.isValid()) world.removeRigidBody(b)
}
