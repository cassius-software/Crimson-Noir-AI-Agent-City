// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is a robot's body in the realm: a manifest (04_Connect_Hardware/jointState.ts, read
 * from a URDF or sent by a controller) built as Rapier bodies and impulse joints, measured as the joint vector a
 * controller speaks (q, q̇ and an estimate of τ per movable joint), and driven towards a setpoint vector. The root
 * link is fixed where the robot is placed; every other link is dynamic, with the ragdoll's contact groups (it meets
 * the ground and the buildings, never a person, a car or another link). Joints are built with consistent frames so
 * the measured angle is zero where the file says zero and positive the right-hand way about the file's axis;
 * revolute limits are set on the created joint (Rapier 0.21 drops the ones given in the joint data). The drive is
 * the ragdoll rig's: not Rapier's joint motors (measured here: at the realm's four solver iterations they leave a
 * quarter of any steady load uncorrected and lose a tenth of an asked velocity along a chain) but a velocity servo
 * of torque impulses, equal and opposite on child and parent about the axis, sized by the pair's reduced inertia so it
 * is stable by construction at 60 Hz, with the weight of everything below the joint fed forward and the whole capped
 * at the joint's effort. The servo tracks a setpoint stiffly; the real actuator's lag and delay, which actuatorFit.ts
 * calibrates, are a setpoint filter the realm (jointRealm.ts) runs in front of it, so the fit is reproduced exactly
 * whatever the solver does. τ is the torque the servo applied, exact, not a sensed joint torque. Every Rapier call
 * stays in the physics worker; nothing here throws after a build, and a build that fails removes what it made. The
 * frame conventions are URDF's (z up, x forward) turned into the realm's (y up) at the root.
 * What breaks if it is removed? A robot has no twin: nothing in the realm moves as its joints do, and the realm has
 * no joint state to send back.
 */
import RAPIER from '@dimforge/rapier3d-simd-compat'
import { ROBOT_GROUPS } from '../02_Define_The_Rules/collision.ts'
import { buildable, type JointSpec, type Manifest, type Vec3 } from '../04_Connect_Hardware/jointState.ts'

/** The realm's choices for what a manifest leaves open. */
export const ROBOT = Object.freeze({
  /** kg for a link whose file gave no mass. */
  defaultMass: 1,
  /** A link with no geometry still needs mass somewhere: a ball of this radius at its origin. */
  pointRadius: 0.02,
  /** Caps for a continuous joint whose file gave none. */
  defaultEffort: 10,
  defaultVelocity: 10,
  friction: 0.8,
  angularDamping: 0.05,
  /**
   * The servo: the position loop's rate (1/s; a step of 1/60 s at 60 Hz, so under 120 is stable) and the share of the
   * velocity gap one tick removes (1 is exact on the estimated inertia, which is never more than the pair's true
   * inertia; a little less leaves margin). Measured on the test arm: a 0.5 rad step peaks 3 % over and is within
   * 0.005 rad by 300 ms; at rest the setpoint is held to 1e-4 rad under a 0.5 N·m load.
   */
  servoRate: 30,
  servoShare: 0.9,
  /** A body further than this from the origin, or not finite, is a fault. */
  worldRadius: 1e4,
})

export interface Quat { readonly x: number; readonly y: number; readonly z: number; readonly w: number }
const IDENTITY: Quat = Object.freeze({ x: 0, y: 0, z: 0, w: 1 })
export const qmul = (a: Quat, b: Quat): Quat => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
})
export const qconj = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w })
/** v rotated by the unit quaternion q. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const tx = 2 * (q.y * v[2] - q.z * v[1]), ty = 2 * (q.z * v[0] - q.x * v[2]), tz = 2 * (q.x * v[1] - q.y * v[0])
  return [v[0] + q.w * tx + q.y * tz - q.z * ty, v[1] + q.w * ty + q.z * tx - q.x * tz, v[2] + q.w * tz + q.x * ty - q.y * tx]
}
/** A rotation of `angle` about the unit `axis`. */
export const axisQuat = (axis: Vec3, angle: number): Quat => {
  const s = Math.sin(angle / 2)
  return { x: axis[0] * s, y: axis[1] * s, z: axis[2] * s, w: Math.cos(angle / 2) }
}
/** URDF's fixed-axis roll, pitch, yaw: Rz(yaw) · Ry(pitch) · Rx(roll). */
export const rpyQuat = (rpy: Vec3): Quat => qmul(axisQuat([0, 0, 1], rpy[2]), qmul(axisQuat([0, 1, 0], rpy[1]), axisQuat([1, 0, 0], rpy[0])))
/** The shortest rotation taking +x onto the unit `axis` (Rapier's joint frames are "x along the axis"). */
export function arcToX(axis: Vec3): Quat {
  const d = axis[0]
  if (d > 1 - 1e-9) return IDENTITY
  if (d < -1 + 1e-9) return { x: 0, y: 1, z: 0, w: 0 }
  const x = 0, y = -axis[2], z = axis[1], w = 1 + d
  const l = Math.hypot(x, y, z, w)
  return { x: x / l, y: y / l, z: z / l, w: w / l }
}
/** A file's z-up frame into the realm's y-up: a quarter turn about x (z → y, y → −z). */
export const ZUP_TO_YUP: Quat = Object.freeze(axisQuat([1, 0, 0], -Math.PI / 2))
/** Rapier's cylinders and capsules stand along y; a file's stand along z. */
const Y_TO_Z: Quat = axisQuat([1, 0, 0], Math.PI / 2)
const yawQuat = (heading: number): Quat => axisQuat([0, 1, 0], heading)
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const v3 = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z]
const GRAVITY: Vec3 = [0, -9.81, 0]

/** Where a robot stands: its root link's origin in the realm (y up) and its heading about y. */
export interface Placement { readonly x: number; readonly y: number; readonly z: number; readonly heading: number }

/** One movable joint as the realm drives and measures it. */
export interface Movable {
  /** Its index in the manifest's joints. */
  readonly index: number
  readonly spec: JointSpec
  readonly kind: 'revolute' | 'prismatic'
  readonly joint: RAPIER.RevoluteImpulseJoint | RAPIER.PrismaticImpulseJoint
  readonly parent: RAPIER.RigidBody
  readonly child: RAPIER.RigidBody
  /** The joint frames, parent-local and child-local: x along the axis, equal in the world at q = 0. */
  readonly frame1: Quat
  readonly frame2: Quat
  /** The joint point in the parent's frame (the child's origin is the joint point). */
  readonly anchor1: Vec3
  /**
   * What one tick's impulse is sized by: the links below the joint, taken as one rigid piece in their present pose,
   * about the axis through the joint point (kg·m²), reduced with the parent link about the same axis (the piece alone
   * when the parent is the fixed root); or the reduced mass along a slide. Re-estimated by every `measure`.
   */
  inertia: number
  /** The links below this joint (the child and its descendants), as indices into the bodies. */
  readonly below: readonly number[]
  readonly effort: number
  readonly velocity: number
  /** Last measured state (written by `measure`). */
  q: number
  qd: number
  tau: number
  /** The gravity moment of the links below, about the axis (N·m or N), as last measured. */
  load: number
  /** The torque (N·m) or force (N) the servo applied in the last drive, after the cap. */
  applied: number
  /** Turns counted for a continuous joint so q is unwrapped. */
  turns: number
  /** True until the first measure, whose q̇ is 0. */
  fresh: boolean
}

export interface Articulated {
  readonly manifest: Manifest
  readonly placement: Placement
  /** One body per link, in the manifest's link order; bodies[rootIndex] is the fixed root. */
  readonly bodies: readonly RAPIER.RigidBody[]
  readonly rootIndex: number
  /** One joint per manifest joint, in order (fixed joints included). */
  readonly joints: readonly RAPIER.ImpulseJoint[]
  /** The movable joints in q order (the manifest's `movable`). */
  readonly movable: readonly Movable[]
  readonly mass: number
}

function colliderFor(l: Manifest['links'][number]): RAPIER.ColliderDesc {
  const s = l.shape
  const rot = rpyQuat(l.shapeOrigin.rpy)
  let d: RAPIER.ColliderDesc
  switch (s.kind) {
    case 'box': d = RAPIER.ColliderDesc.cuboid(s.size[0] / 2, s.size[1] / 2, s.size[2] / 2).setRotation(rot); break
    case 'sphere': d = RAPIER.ColliderDesc.ball(s.radius); break
    case 'cylinder': d = RAPIER.ColliderDesc.cylinder(s.length / 2, s.radius).setRotation(qmul(rot, Y_TO_Z)); break
    case 'capsule': d = RAPIER.ColliderDesc.capsule(s.length / 2, s.radius).setRotation(qmul(rot, Y_TO_Z)); break
    case 'none': d = RAPIER.ColliderDesc.ball(ROBOT.pointRadius); break
  }
  const [x, y, z] = l.shapeOrigin.xyz
  return d.setTranslation(x, y, z).setMass(l.mass > 0 ? l.mass : ROBOT.defaultMass).setFriction(ROBOT.friction).setCollisionGroups(ROBOT_GROUPS)
}

/** A body's inertia about the unit world `axis` through the world `point` (parallel-axis term included). */
function inertiaAbout(body: RAPIER.RigidBody, axis: Vec3, point: Vec3): number {
  const m = body.mass()
  const com = sub(v3(body.worldCom()), point)
  const pi = body.principalInertia()
  const a = rotate(qconj(qmul(body.rotation(), body.principalInertiaLocalFrame())), axis)
  const about = pi.x * a[0] * a[0] + pi.y * a[1] * a[1] + pi.z * a[2] * a[2]
  const along = dot(com, axis)
  const perp2 = dot(com, com) - along * along
  return about + m * Math.max(0, perp2)
}

/**
 * The pair's inertia about the world `axis` through the joint point as the links stand now: everything below the
 * joint as one piece (the joints among them hold their own setpoints), reduced with the parent link, which is the
 * whole of the pair when the parent is the fixed root. Along a slide, the masses the same way.
 */
function pairInertia(a: Articulated, mv: Movable, axisWorld: Vec3): number {
  const pivot = v3(mv.child.translation())
  let below = 0
  for (const i of mv.below) below += mv.kind === 'prismatic' ? a.bodies[i].mass() : inertiaAbout(a.bodies[i], axisWorld, pivot)
  if (mv.parent.isFixed()) return below
  const parent = mv.kind === 'prismatic' ? mv.parent.mass() : inertiaAbout(mv.parent, axisWorld, pivot)
  return below + parent > 0 ? (below * parent) / (below + parent) : 0
}

/**
 * Builds the robot where it is placed, at q = 0 everywhere. Throws (after removing what it made) when the manifest
 * is not buildable or Rapier refuses a joint; the caller turns that into a refused command.
 */
export function buildArticulated(world: RAPIER.World, m: Manifest, at: Placement): Articulated {
  const why = buildable(m)
  if (why) throw new Error(why)
  if (![at.x, at.y, at.z, at.heading].every(Number.isFinite)) throw new Error('the placement is not finite')
  const linkIndex = new Map<string, number>()
  m.links.forEach((l, i) => linkIndex.set(l.name, i))
  const rootIndex = linkIndex.get(m.root)!
  // Forward kinematics at q = 0 in the file's frame, then into the realm's.
  const poses: ({ p: Vec3; q: Quat } | null)[] = m.links.map(() => null)
  const rootQ = qmul(yawQuat(at.heading), ZUP_TO_YUP)
  poses[rootIndex] = { p: [at.x, at.y, at.z], q: rootQ }
  const byChild = new Map<number, JointSpec>()
  for (const j of m.joints) byChild.set(linkIndex.get(j.child)!, j)
  const parentOf = new Map<number, number>()
  for (const j of m.joints) parentOf.set(linkIndex.get(j.child)!, linkIndex.get(j.parent)!)
  const descendants = (link: number): number[] => {
    const out: number[] = [link]
    for (let k = 0; k < out.length; k++) for (const [c, p] of parentOf) if (p === out[k]) out.push(c)
    return out
  }
  const pending = new Set<number>(m.links.map((_, i) => i))
  pending.delete(rootIndex)
  while (pending.size > 0) {
    let placed = 0
    for (const i of pending) {
      const j = byChild.get(i)!
      const parent = poses[linkIndex.get(j.parent)!]
      if (!parent) continue
      poses[i] = { p: addv(parent.p, rotate(parent.q, j.origin.xyz)), q: qmul(parent.q, rpyQuat(j.origin.rpy)) }
      pending.delete(i)
      placed++
    }
    if (placed === 0) throw new Error('the links do not form one tree')
  }
  const bodies: RAPIER.RigidBody[] = []
  const joints: RAPIER.ImpulseJoint[] = []
  const movable: Movable[] = []
  const undo = (): void => {
    for (const j of joints) if (j.isValid()) world.removeImpulseJoint(j, true)
    for (const b of bodies) if (b.isValid()) world.removeRigidBody(b)
  }
  try {
    let mass = 0
    m.links.forEach((l, i) => {
      const pose = poses[i]!
      const desc = (i === rootIndex ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic().setAngularDamping(ROBOT.angularDamping).setCcdEnabled(true))
        .setTranslation(pose.p[0], pose.p[1], pose.p[2])
        .setRotation(pose.q)
      const body = world.createRigidBody(desc)
      world.createCollider(colliderFor(l), body)
      bodies.push(body)
      if (i !== rootIndex) mass += body.mass()
    })
    m.joints.forEach((spec, index) => {
      const parent = bodies[linkIndex.get(spec.parent)!], child = bodies[linkIndex.get(spec.child)!]
      const a1 = { x: spec.origin.xyz[0], y: spec.origin.xyz[1], z: spec.origin.xyz[2] }
      const a2 = { x: 0, y: 0, z: 0 }
      const rpy = rpyQuat(spec.origin.rpy)
      if (spec.kind === 'fixed') {
        const j = world.createImpulseJoint(RAPIER.JointData.fixed(a1, rpy, a2, IDENTITY), parent, child, true)
        j.setContactsEnabled(false)
        joints.push(j)
        return
      }
      const axis = spec.axis
      const frame2 = arcToX(axis)
      const frame1 = qmul(rpy, frame2)
      const ax = { x: axis[0], y: axis[1], z: axis[2] }
      const prismatic = spec.kind === 'prismatic'
      const data = prismatic ? RAPIER.JointData.prismatic(a1, a2, ax) : RAPIER.JointData.revolute(a1, a2, ax)
      const j = world.createImpulseJoint(data, parent, child, true) as RAPIER.RevoluteImpulseJoint | RAPIER.PrismaticImpulseJoint
      j.setContactsEnabled(false)
      j.setFrameX1(frame1)
      j.setFrameX2(frame2)
      if (spec.kind !== 'continuous') j.setLimits(spec.lower, spec.upper)
      const effort = spec.effort > 0 ? spec.effort : ROBOT.defaultEffort
      const velocity = spec.velocity > 0 ? spec.velocity : ROBOT.defaultVelocity
      joints.push(j)
      movable.push({
        index, spec, kind: prismatic ? 'prismatic' : 'revolute', joint: j, parent, child, frame1, frame2, anchor1: spec.origin.xyz,
        inertia: 0, below: Object.freeze(descendants(linkIndex.get(spec.child)!)),
        effort, velocity, q: 0, qd: 0, tau: 0, load: 0, applied: 0, turns: 0, fresh: true,
      })
    })
    // q order is the manifest's `movable`, which is document order of the scalar joints: the same order as built.
    const built: Articulated = Object.freeze({ manifest: m, placement: at, bodies: Object.freeze(bodies), rootIndex, joints: Object.freeze(joints), movable: Object.freeze(movable), mass })
    // The first reading, at the build pose: q = 0, q̇ = 0, the inertia and the load as built.
    measure(built, 1)
    for (const mv of movable) mv.fresh = true
    return built
  } catch (e) {
    undo()
    throw e
  }
}

const addv = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

/** Removes every joint and body; harmless twice. */
export function removeArticulated(world: RAPIER.World, a: Articulated): void {
  for (const j of a.joints) if (j.isValid()) world.removeImpulseJoint(j, true)
  for (const b of a.bodies) if (b.isValid()) world.removeRigidBody(b)
}

const wrap = (x: number): number => Math.atan2(Math.sin(x), Math.cos(x))

/**
 * Reads q and q̇ of every movable joint into the Movables (and `out` as q, q̇, τ triples when given), with τ the torque
 * the last drive applied. Call once per substep of `h` seconds, before `drive` or `hold`.
 */
export function measure(a: Articulated, h: number, out: Float32Array | Float64Array | number[] | null = null): void {
  const n = a.movable.length
  for (let i = 0; i < n; i++) {
    const mv = a.movable[i]
    const q1 = mv.parent.rotation(), q2 = mv.child.rotation()
    const axisWorld = rotate(q2, mv.spec.axis)
    let q: number
    if (mv.kind === 'revolute') {
      let rel = qmul(qconj(mv.frame1), qmul(qconj(q1), qmul(q2, mv.frame2)))
      if (rel.w < 0) rel = { x: -rel.x, y: -rel.y, z: -rel.z, w: -rel.w }
      const angle = 2 * Math.atan2(rel.x, rel.w)
      if (mv.spec.kind === 'continuous') {
        // Unwrapped: the nearest turn to the last reading.
        const last = wrap(mv.q)
        const step = wrap(angle - last)
        if (last + step > Math.PI) mv.turns++
        else if (last + step <= -Math.PI) mv.turns--
        q = mv.turns * 2 * Math.PI + wrap(last + step)
      } else q = angle
    } else {
      const p1 = addv(v3(mv.parent.translation()), rotate(q1, mv.anchor1))
      const p2 = v3(mv.child.translation())
      q = dot(sub(p2, p1), axisWorld)
    }
    // q̇ as the change of q over the substep: Rapier's body velocities after a step carry the part its position
    // correction took back, so a joint standing still under load would read a speed it does not have.
    const qd = mv.fresh ? 0 : (q - mv.q) / h
    mv.fresh = false
    const load = gravityMoment(a, mv, axisWorld)
    const inertia = pairInertia(a, mv, axisWorld)
    mv.q = q
    mv.qd = qd
    mv.load = Number.isFinite(load) ? load : 0
    mv.inertia = Number.isFinite(inertia) ? inertia : 0
    mv.tau = mv.applied
    if (out) { out[3 * i] = q; out[3 * i + 1] = qd; out[3 * i + 2] = mv.tau }
  }
}

/** The gravity moment about the joint's axis of every link below it (N·m), or the gravity force along a slide (N). */
function gravityMoment(a: Articulated, mv: Movable, axisWorld: Vec3): number {
  let sum = 0
  if (mv.kind === 'revolute') {
    const pivot = v3(mv.child.translation())
    for (const i of mv.below) {
      const b = a.bodies[i]
      const r = sub(v3(b.worldCom()), pivot)
      sum += dot(cross(r, [0, b.mass() * GRAVITY[1], 0]), axisWorld)
    }
  } else {
    for (const i of mv.below) sum += a.bodies[i].mass() * dot(GRAVITY, axisWorld)
  }
  return sum
}

/**
 * One tick of the servo on one joint: an impulse pair about the axis sized to remove `share` of the gap between the
 * wanted and the measured joint speed, plus the weight below fed forward, capped at `cap` (N·m or N) over `h`.
 */
function servo(mv: Movable, wanted: number, cap: number, h: number): void {
  const gap = wanted - mv.qd
  let torque = (mv.inertia * gap * ROBOT.servoShare) / h - mv.load
  if (!Number.isFinite(torque)) torque = 0
  if (torque > cap) torque = cap
  else if (torque < -cap) torque = -cap
  mv.applied = torque
  if (torque === 0) return
  const axisWorld = rotate(mv.child.rotation(), mv.spec.axis)
  const j = torque * h
  const plus = { x: axisWorld[0] * j, y: axisWorld[1] * j, z: axisWorld[2] * j }
  const minus = { x: -plus.x, y: -plus.y, z: -plus.z }
  if (mv.kind === 'revolute') {
    mv.child.applyTorqueImpulse(plus, true)
    if (!mv.parent.isFixed()) mv.parent.applyTorqueImpulse(minus, true)
  } else {
    mv.child.applyImpulse(plus, true)
    if (!mv.parent.isFixed()) mv.parent.applyImpulseAtPoint(minus, mv.child.translation(), true)
  }
}

/** One joint's setpoint: where to be, how fast to be moving there, and at most how hard (0 = the joint's own cap). */
export interface Setpoints { readonly q: ArrayLike<number>; readonly qd: ArrayLike<number>; readonly tau: ArrayLike<number> }

/**
 * Drives every movable joint towards its setpoint: the wanted speed is servoRate · (q* − q) + q̇*, clamped to the
 * joint's speed cap; the effort is capped at min(effort, τ*) (τ* ≤ 0 or absent leaves the joint's cap). Uses the last
 * `measure`; call once per substep of `h` seconds after it. A non-finite setpoint holds that joint.
 */
export function drive(a: Articulated, s: Setpoints, h: number): void {
  const n = a.movable.length
  for (let i = 0; i < n; i++) {
    const mv = a.movable[i]
    const qStar = s.q[i], qdStar = i < s.qd.length ? s.qd[i] : 0, tauStar = i < s.tau.length ? s.tau[i] : 0
    let wanted = 0
    if (Number.isFinite(qStar)) {
      wanted = ROBOT.servoRate * (qStar - mv.q) + (Number.isFinite(qdStar) ? qdStar : 0)
      if (wanted > mv.velocity) wanted = mv.velocity
      else if (wanted < -mv.velocity) wanted = -mv.velocity
    }
    const cap = Number.isFinite(tauStar) && tauStar > 0 ? Math.min(mv.effort, tauStar) : mv.effort
    servo(mv, wanted, cap, h)
  }
}

/** Every joint asked to stand still at its effort cap (no setpoint, or a stale one), the weight below fed forward. */
export function hold(a: Articulated, h: number): void {
  for (const mv of a.movable) servo(mv, 0, mv.effort, h)
}

/** False when any body has left the finite world: the robot must be removed before the solver spreads it. */
export function sane(a: Articulated): boolean {
  for (const b of a.bodies) {
    const t = b.translation()
    if (!Number.isFinite(t.x) || !Number.isFinite(t.y) || !Number.isFinite(t.z)) return false
    if (Math.abs(t.x) > ROBOT.worldRadius || Math.abs(t.y) > ROBOT.worldRadius || Math.abs(t.z) > ROBOT.worldRadius) return false
    const v = b.linvel()
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return false
  }
  return true
}

/** Writes link i's pose (x, y, z, qx, qy, qz, qw) at out[o..o+7). */
export function linkPose(a: Articulated, i: number, out: Float32Array | Float64Array | number[], o: number): void {
  const b = a.bodies[i]
  const t = b.translation(), r = b.rotation()
  out[o] = t.x; out[o + 1] = t.y; out[o + 2] = t.z
  out[o + 3] = r.x; out[o + 4] = r.y; out[o + 5] = r.z; out[o + 6] = r.w
}
