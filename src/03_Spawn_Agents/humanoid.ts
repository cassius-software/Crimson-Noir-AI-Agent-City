// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the person the crowd is made of: one smooth humanoid, lofted from rings (the
 * trunk, the neck and head, each arm with its hand, each leg with its shoe, and the four outfits' garments, a hem, a
 * shirt front, a skirt, a tie, long hair, glasses, a bag, a cup) over a skeleton of fifteen bones, every vertex tied
 * to two of them, and the body sliders that reshape it (height, mass, muscle, shoulders, hips, leg length, posture,
 * head) as arithmetic the crowd's vertex stage (crowd.ts) runs on the GPU and this module runs on the CPU, so the
 * card's silhouette, the tests and the shader agree to the number. Everything here is written by hand for this
 * product: no imported mesh, skeleton or morph target. Pure: no three, no DOM, no GPU, no clock, no randomness.
 * What breaks if it is removed? The crowd has no body to draw, and the sliders have nothing to move.
 *
 * Frame: metres, feet on y = 0, the person faces +z, their left side at −x. The base person is HEIGHT_BASE tall;
 * the sliders move away from them. Bones (BONE): the trunk bends about the hip; the chest twists about the spine;
 * the head nods about the neck; each leg is thigh, shin and foot about the hip, knee and ankle; each arm is upper
 * arm, forearm and hand about the shoulder, elbow and wrist. A vertex carries its slot (the colour the fragment stage
 * paints it, crowd.ts), its optional piece (drawn only when the person's mask has the bit) and its two bones with a
 * weight, in two attributes the geometry carries: `rig` = (bone, slot, piece), `skin` = (second bone, weight of the
 * first).
 */

/** The base person's height, m: a slider's height of 1.75 m draws the rings exactly as written here. */
export const HEIGHT_BASE = 1.75

/** The bones, in the order the vertex stage's chain walks them. */
export const BONE = Object.freeze({
  TRUNK: 0, CHEST: 1, HEAD: 2,
  THIGH_L: 3, SHIN_L: 4, FOOT_L: 5, THIGH_R: 6, SHIN_R: 7, FOOT_R: 8,
  ARM_L: 9, FOREARM_L: 10, HAND_L: 11, ARM_R: 12, FOREARM_R: 13, HAND_R: 14,
})
export const BONES = 15

/** The colour slots the fragment stage paints (crowd.ts: the top, the shirt, the skin, ...). */
export const SLOT = Object.freeze({ TOP: 0, SHIRT: 1, SKIN: 2, HAIR: 3, BOTTOM: 4, SHOES: 5, ACCENT: 6, PROP: 7, LEGWEAR: 8, FRAME: 9 })
/** The optional pieces, one bit each in a person's piece mask (look.ts LOOK_PIECE_BIT; 0 is "always drawn"). */
export const PIECE = Object.freeze({ NONE: 0, TIE: 1, BAG: 2, CUP: 3, LONG_HAIR: 4, GLASSES: 5 })

/**
 * Where the base person's joints are, m (y up the body, x out to the side). The vertex stage takes them as
 * constants (crowd.ts writes them into its WGSL from here), so the skeleton the shader turns is the one the rings
 * were lofted round.
 */
export const LANDMARK = Object.freeze({
  ankle: 0.08, knee: 0.5, hip: 0.92, hipX: 0.095,
  chestPivot: 1.2, shoulder: 1.45, shoulderX: 0.2, elbow: 1.17, wrist: 0.92, neck: 1.52,
})

/** The body sliders, each 0..1 but the height in metres. */
export interface BodyShape {
  readonly height: number
  readonly mass: number
  readonly muscle: number
  readonly shoulders: number
  readonly hips: number
  readonly legs: number
  readonly posture: number
  readonly head: number
}

/** The base person: every slider halfway, HEIGHT_BASE tall. */
export const SHAPE_NEUTRAL: BodyShape = Object.freeze({ height: HEIGHT_BASE, mass: 0.5, muscle: 0.5, shoulders: 0.5, hips: 0.5, legs: 0.5, posture: 0.5, head: 0.5 })

/**
 * What a slider's 0..1 becomes: a factor base + t × range (the girths, the widths, the lengths), the posture's lean
 * in radians ((0.5 − t) × slouch: forward when slumped, a little back when upright) and the gait's swing factor. The
 * shader takes these as constants from here.
 */
export const MORPH = Object.freeze({
  legs: Object.freeze({ base: 0.92, range: 0.16 }),
  shoulders: Object.freeze({ base: 0.86, range: 0.28 }),
  hips: Object.freeze({ base: 0.86, range: 0.28 }),
  mass: Object.freeze({ base: 0.78, range: 0.44 }),
  muscle: Object.freeze({ base: 0.86, range: 0.28 }),
  head: Object.freeze({ base: 0.92, range: 0.16 }),
  slouch: 0.16,
  gait: Object.freeze({ base: 0.75, range: 0.5 }),
})

/**
 * Where on the trunk each slider acts: a hat of this half-width about this height (1 at the centre, 0 at the
 * edges), so a wider shoulder line leaves the waist alone. The shoulder and hip hats peak where the arms and legs
 * hang, so the trunk's widening there is exactly the limbs' sideways shift (one stretch, no step).
 */
export const REGION = Object.freeze({
  shoulder: Object.freeze({ at: 1.44, half: 0.16 }),
  hip: Object.freeze({ at: 0.92, half: 0.14 }),
  waist: Object.freeze({ at: 1.03, half: 0.22 }),
  chest: Object.freeze({ at: 1.36, half: 0.18 }),
  belly: Object.freeze({ at: 1.0, half: 0.16 }),
})

/** How much of the mass and muscle each limb takes (the trunk takes the hats above). */
export const LIMB_GIRTH = Object.freeze({
  thigh: Object.freeze({ mass: 0.45, muscle: 0.35 }),
  shin: Object.freeze({ mass: 0.25, muscle: 0.3 }),
  arm: Object.freeze({ mass: 0.4, muscle: 0.5 }),
  forearm: Object.freeze({ mass: 0.2, muscle: 0.35 }),
  head: Object.freeze({ mass: 0.12, muscle: 0 }),
})

/** The walk: the amplitudes the phase drives (crowd.wgsl's vel.z is the phase, vel.w the speed). */
export const WALK = Object.freeze({
  /** m/s at which the swing reaches its full amplitude, and the most it may exceed it. */
  fullSpeed: 1.4, maxSwing: 1.3,
  hip: 0.46, knee: 1.0, kneeRest: 0.06, ankle: 0.6,
  shoulder: 0.38, elbow: 0.3, elbowRest: 0.25, twist: 0.06, bob: 0.03,
  /** Holding a cup: the left arm raised with the forearm up; carrying a bag: the right arm swings little. */
  cupShoulder: -0.35, cupElbow: -1.6, cupSwing: 0.2, bagSwing: 0.35,
  /** The head counters the trunk's lean, in part. */
  headCounter: 0.7,
})

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const hat = (y: number, at: number, half: number): number => clamp01(1 - Math.abs(y - at) / half)
const factor = (t: number, f: { readonly base: number; readonly range: number }): number => f.base + clamp01(t) * f.range

/** The bone's group: 0 the trunk (trunk, chest, head), 1 a leg, 2 an arm. */
export const boneGroup = (bone: number): number => (bone < 3 ? 0 : bone < 9 ? 1 : 2)
/** The bone's side: −1 left, +1 right, 0 on the axis. */
export const boneSide = (bone: number): number => (bone < 3 ? 0 : (bone >= 6 && bone <= 8) || bone >= 12 ? 1 : -1)

/** The factors a shape gives, as the shader computes them from the slider values. */
export interface ShapeFactors {
  readonly legs: number
  readonly trunk: number
  readonly shoulders: number
  readonly hips: number
  readonly mass: number
  readonly muscle: number
  readonly head: number
  readonly slouch: number
  readonly gait: number
  readonly height: number
}

export function shapeFactors(s: BodyShape): ShapeFactors {
  const legs = factor(s.legs, MORPH.legs)
  // The legs take their share of the same height: the trunk gives it back, so the neck stays where it was.
  const trunk = (LANDMARK.neck - LANDMARK.hip * legs) / (LANDMARK.neck - LANDMARK.hip)
  return {
    legs, trunk,
    shoulders: factor(s.shoulders, MORPH.shoulders),
    hips: factor(s.hips, MORPH.hips),
    mass: factor(s.mass, MORPH.mass),
    muscle: factor(s.muscle, MORPH.muscle),
    head: factor(s.head, MORPH.head),
    slouch: (0.5 - clamp01(s.posture)) * MORPH.slouch,
    gait: factor(s.posture, MORPH.gait),
    height: (Number.isFinite(s.height) && s.height > 0 ? s.height : HEIGHT_BASE) / HEIGHT_BASE,
  }
}

/** The height map: the legs' share scaled by `legs`, the trunk above by `trunk`, the head unmoved. */
export function heightMap(y: number, f: ShapeFactors): number {
  if (y <= LANDMARK.hip) return y * f.legs
  if (y <= LANDMARK.neck) return LANDMARK.hip * f.legs + (y - LANDMARK.hip) * f.trunk
  return y
}

/** The joints after the shape: [x, y] of each pivot on the right side (mirror x for the left). */
export interface Pivots {
  readonly hipX: number
  readonly hip: number
  readonly knee: number
  readonly ankle: number
  readonly shoulderX: number
  readonly shoulder: number
  readonly elbow: number
  readonly wrist: number
  readonly chest: number
  readonly neck: number
}

export function pivotsOf(f: ShapeFactors): Pivots {
  const shoulder = heightMap(LANDMARK.shoulder, f)
  return {
    hipX: LANDMARK.hipX * f.hips,
    hip: LANDMARK.hip * f.legs,
    knee: LANDMARK.knee * f.legs,
    ankle: LANDMARK.ankle * f.legs,
    shoulderX: LANDMARK.shoulderX * f.shoulders,
    shoulder,
    elbow: shoulder - (LANDMARK.shoulder - LANDMARK.elbow),
    wrist: shoulder - (LANDMARK.shoulder - LANDMARK.wrist),
    chest: heightMap(LANDMARK.chestPivot, f),
    neck: LANDMARK.neck,
  }
}

/** The height map's slope at rest height y: what a vertical length there is multiplied by. */
const heightSlope = (y: number, f: ShapeFactors): number => (y <= LANDMARK.hip ? f.legs : y <= LANDMARK.neck ? f.trunk : 1)

/** What the sliders do to a rest point of a bone at height y: a scale per axis about the bone's own axis, and a shift. */
interface MorphAt {
  readonly gx: number
  readonly gy: number
  readonly gz: number
  /** The axis the x scale is about (the limb's centre line; 0 on the trunk). */
  readonly ax: number
  readonly shiftX: number
  readonly shiftZ: number
}

/**
 * The sliders at one rest point, by its bone: the girths (mass and muscle, about the trunk's axis or the limb's
 * own), the widths (the shoulder and hip hats on the trunk; a whole limb shifted with its joint), the head about the
 * neck, the belly's push, and the height map's slope. A position takes the scales and the shifts (morphPoint); a
 * normal takes the scales' reciprocals (morphNormal).
 */
function morphAt(y: number, z: number, bone: number, f: ShapeFactors): MorphAt {
  const group = boneGroup(bone)
  const side = boneSide(bone)
  const dm = f.mass - 1, du = f.muscle - 1
  if (group === 0) {
    if (bone === BONE.HEAD) {
      const g = (1 + dm * LIMB_GIRTH.head.mass) * f.head
      return { gx: g, gy: f.head, gz: g, ax: 0, shiftX: 0, shiftZ: 0 }
    }
    const g = 1 + dm * (0.5 + 0.5 * hat(y, REGION.waist.at, REGION.waist.half)) + du * 0.6 * hat(y, REGION.chest.at, REGION.chest.half)
    const hip = hat(y, REGION.hip.at, REGION.hip.half)
    const wx = 1 + (f.shoulders - 1) * hat(y, REGION.shoulder.at, REGION.shoulder.half) + (f.hips - 1) * hip
    const wz = 1 + (f.hips - 1) * 0.5 * hip
    const push = z > 0 && dm > 0 ? dm * 0.1 * hat(y, REGION.belly.at, REGION.belly.half) : 0
    return { gx: g * wx, gy: heightSlope(y, f), gz: g * wz, ax: 0, shiftX: 0, shiftZ: push * wz }
  }
  if (group === 1) {
    const limb = bone === BONE.THIGH_L || bone === BONE.THIGH_R ? LIMB_GIRTH.thigh : bone === BONE.SHIN_L || bone === BONE.SHIN_R ? LIMB_GIRTH.shin : null
    const g = limb ? 1 + dm * limb.mass + du * limb.muscle : 1
    return { gx: g, gy: heightSlope(y, f), gz: g, ax: side * LANDMARK.hipX, shiftX: side * LANDMARK.hipX * (f.hips - 1), shiftZ: 0 }
  }
  const limb = bone === BONE.ARM_L || bone === BONE.ARM_R ? LIMB_GIRTH.arm : bone === BONE.FOREARM_L || bone === BONE.FOREARM_R ? LIMB_GIRTH.forearm : null
  const g = limb ? 1 + dm * limb.mass + du * limb.muscle : 1
  return { gx: g, gy: 1, gz: g, ax: side * LANDMARK.shoulderX, shiftX: side * LANDMARK.shoulderX * (f.shoulders - 1), shiftZ: 0 }
}

/**
 * One rest-pose point reshaped by the sliders (morphAt), then the height map: the trunk and the legs by their
 * height, the head about the neck, an arm keeping its length under wherever its shoulder went. The stature's scale
 * is not here: the shader applies it with the rest of the per-agent scales, after the pose (scaleOf). Writes x, y, z
 * into `out` and returns it.
 */
export function morphPoint(x: number, y: number, z: number, bone: number, f: ShapeFactors, out: number[] = [0, 0, 0]): number[] {
  const m = morphAt(y, z, bone, f)
  const group = boneGroup(bone)
  out[0] = m.ax + (x - m.ax) * m.gx + m.shiftX
  out[2] = z * m.gz + m.shiftZ
  if (group === 2) out[1] = heightMap(LANDMARK.shoulder, f) - (LANDMARK.shoulder - y)
  else if (bone === BONE.HEAD) out[1] = LANDMARK.neck + (y - LANDMARK.neck) * f.head
  else out[1] = heightMap(y, f)
  return out
}

/**
 * A rest-pose normal under the same sliders: each component over its axis's scale (the shifts move nothing), then
 * normalised, so a widened torso is still lit as the round thing it is. Writes into `out` and returns it.
 */
export function morphNormal(nx: number, ny: number, nz: number, y: number, z: number, bone: number, f: ShapeFactors, out: number[] = [0, 0, 0]): number[] {
  const m = morphAt(y, z, bone, f)
  const x = nx / m.gx, yy = ny / m.gy, zz = nz / m.gz
  const l = Math.hypot(x, yy, zz) || 1
  out[0] = x / l; out[1] = yy / l; out[2] = zz / l
  return out
}

/** The per-agent scales the shader applies after the pose: the stature up the body, and its square root across. */
export function scaleOf(f: ShapeFactors): { readonly y: number; readonly xz: number } {
  return { y: f.height, xz: Math.sqrt(f.height) }
}

/** The base person's eye, m above the feet (the glasses sit on it). */
export const EYE_LEVEL = 1.68

/**
 * Where a shape's eye is, m above its feet: the base eye about the neck by the head slider, then the stature's
 * scale (the legs slider moves the hip, never the neck; the posture's lean is a few millimetres and left out). The
 * first-person camera stands here (07_Execute_Actions/head.ts).
 */
export function eyeHeightOf(shape: BodyShape): number {
  const f = shapeFactors(shape)
  return (LANDMARK.neck + (EYE_LEVEL - LANDMARK.neck) * f.head) * f.height
}

// --- The walk ---------------------------------------------------------------------------------------------------

/** The joint angles of one moment of the walk, rad: about x (a positive leg angle swings it back, a positive knee bends the heel up). */
export interface WalkAngles {
  readonly hipL: number; readonly kneeL: number; readonly ankleL: number
  readonly hipR: number; readonly kneeR: number; readonly ankleR: number
  readonly shoulderL: number; readonly elbowL: number
  readonly shoulderR: number; readonly elbowR: number
  /** The chest's yaw about the spine (counter to the swing), and the head's nod. */
  readonly twist: number
  readonly head: number
  /** The trunk's lean from the posture (about the hip, forward positive). */
  readonly slouch: number
  /** The step's rise, m. */
  readonly bob: number
}

/** The swing's amplitude for a walking speed, m/s: full at WALK.fullSpeed, at most WALK.maxSwing. */
export const swingOf = (speed: number): number => Math.min(WALK.maxSwing, Math.max(0, speed / WALK.fullSpeed))

/**
 * The walk at `phase` (rad; the left leg's cycle, the right half a turn behind) with `swing` (swingOf), for a
 * posture's factors, holding a cup (the left arm up) or carrying a bag (the right arm still). Exactly what the vertex
 * stage computes, in the same order.
 */
export function walkAngles(phase: number, swing: number, f: ShapeFactors, cup = false, bag = false): WalkAngles {
  const leg = (p: number) => {
    const s = Math.sin(p), c = Math.cos(p)
    const hip = s * WALK.hip * swing
    const lift = Math.max(0, -c)
    const knee = WALK.kneeRest + WALK.knee * swing * lift * lift
    const ankle = -(hip + knee) * WALK.ankle
    return [hip, knee, ankle] as const
  }
  const arm = (p: number) => {
    const s = Math.sin(p)
    const shoulder = -s * WALK.shoulder * swing * f.gait
    const elbow = -(WALK.elbowRest + WALK.elbow * swing * Math.max(0, s))
    return [shoulder, elbow] as const
  }
  const [hipL, kneeL, ankleL] = leg(phase)
  const [hipR, kneeR, ankleR] = leg(phase + Math.PI)
  let [shoulderL, elbowL] = arm(phase)
  let [shoulderR, elbowR] = arm(phase + Math.PI)
  if (cup) { shoulderL = WALK.cupShoulder + shoulderL * WALK.cupSwing; elbowL = WALK.cupElbow }
  if (bag) { shoulderR *= WALK.bagSwing; elbowR = -WALK.elbowRest }
  return {
    hipL, kneeL, ankleL, hipR, kneeR, ankleR, shoulderL, elbowL, shoulderR, elbowR,
    twist: Math.sin(phase) * WALK.twist * swing * f.gait,
    head: -f.slouch * WALK.headCounter,
    slouch: f.slouch,
    bob: Math.abs(Math.sin(phase)) * WALK.bob * swing,
  }
}

const rotXAbout = (p: number[], px: number, py: number, pz: number, a: number, w: number): void => {
  const c = Math.cos(a), s = Math.sin(a)
  const y = p[1] - py * w, z = p[2] - pz * w
  p[1] = y * c - z * s + py * w
  p[2] = y * s + z * c + pz * w
  p[0] = p[0] - px * w + px * w
}
const rotYAbout = (p: number[], py: number, a: number, w: number): void => {
  const c = Math.cos(a), s = Math.sin(a)
  const x = p[0], z = p[2]
  p[0] = x * c + z * s
  p[2] = -x * s + z * c
  p[1] = p[1] - py * w + py * w
}
const rotAxisAbout = (p: number[], py: number, kx: number, kz: number, a: number, w: number): void => {
  const c = Math.cos(a), s = Math.sin(a)
  const x = p[0], y = p[1] - py * w, z = p[2]
  const d = kx * x + kz * z
  // Rodrigues about the horizontal unit axis (kx, 0, kz).
  const cx = -kz * y, cy = kz * x - kx * z, cz = kx * y
  p[0] = x * c + cx * s + kx * d * (1 - c)
  p[1] = y * c + cy * s + py * w
  p[2] = z * c + cz * s + kz * d * (1 - c)
}

/** The spring-damper pose and the lean, as the crowd's pose buffer carries them (crowd.wgsl pose: tilt, bend, push angle). */
export interface BodyPose {
  /** rad about the feet, along the push's axis. */
  readonly tilt: number
  /** rad about the hip, the trunk's, along the same axis. */
  readonly bend: number
  /** The push's direction in the body's frame: the axis is (cos fall, 0, −sin fall). */
  readonly fall: number
}

/**
 * One bone's transform of a rest point (after morphPoint): the chain from the bone to the root, pivots scaled by
 * `w` (1 for a position, 0 for a normal, as the shader does it). Returns `p` moved.
 */
export function boneTransform(bone: number, p: number[], w: number, a: WalkAngles, pose: BodyPose, piv: Pivots): number[] {
  const side = boneSide(bone)
  const kx = Math.cos(pose.fall), kz = -Math.sin(pose.fall)
  if (bone >= BONE.THIGH_L && bone <= BONE.FOOT_R) {
    const left = side < 0
    const part = (bone - BONE.THIGH_L) % 3
    const x = side * piv.hipX
    if (part === 2) rotXAbout(p, x, piv.ankle, 0, left ? a.ankleL : a.ankleR, w)
    if (part >= 1) rotXAbout(p, x, piv.knee, 0, left ? a.kneeL : a.kneeR, w)
    rotXAbout(p, x, piv.hip, 0, left ? a.hipL : a.hipR, w)
  } else {
    if (bone >= BONE.ARM_L) {
      const left = side < 0
      const part = (bone - BONE.ARM_L) % 3
      const x = side * piv.shoulderX
      if (part >= 1) rotXAbout(p, x, piv.elbow, 0, left ? a.elbowL : a.elbowR, w)
      rotXAbout(p, x, piv.shoulder, 0, left ? a.shoulderL : a.shoulderR, w)
      rotYAbout(p, piv.chest, a.twist, w)
    } else {
      if (bone === BONE.HEAD) rotXAbout(p, 0, piv.neck, 0, a.head, w)
      if (bone >= BONE.CHEST) rotYAbout(p, piv.chest, a.twist, w)
    }
    // The trunk, and everything hanging from it, leans with the posture and bends with the push.
    rotXAbout(p, 0, piv.hip, 0, a.slouch, w)
    rotAxisAbout(p, piv.hip, kx, kz, pose.bend, w)
  }
  rotAxisAbout(p, 0, kx, kz, pose.tilt, w)
  return p
}

/**
 * A vertex posed: its two bones' transforms blended by the weight (linear blend skinning), then the step's rise,
 * the stature's scales, the heading and the position, exactly the shader's order. `w` 1 for a position (the
 * answer is in world metres), 0 for a normal (the answer wants normalising).
 */
export function skinPoint(
  x: number, y: number, z: number, bone0: number, bone1: number, weight: number, w: number,
  a: WalkAngles, pose: BodyPose, piv: Pivots, scale: { readonly y: number; readonly xz: number }, heading: number, at: readonly [number, number, number],
  out: number[] = [0, 0, 0],
): number[] {
  const p0 = boneTransform(bone0, [x, y, z], w, a, pose, piv)
  const p1 = bone1 === bone0 || weight >= 1 ? p0 : boneTransform(bone1, [x, y, z], w, a, pose, piv)
  let qx = p0[0] * weight + p1[0] * (1 - weight)
  let qy = p0[1] * weight + p1[1] * (1 - weight)
  let qz = p0[2] * weight + p1[2] * (1 - weight)
  if (w > 0.5) {
    qx *= scale.xz; qy = qy * scale.y + a.bob; qz *= scale.xz
  } else {
    // A normal takes the scales' reciprocals (the caller normalises).
    qx /= scale.xz; qy /= scale.y; qz /= scale.xz
  }
  const ch = Math.cos(heading), sh = Math.sin(heading)
  out[0] = qx * ch + qz * sh
  out[1] = qy
  out[2] = -qx * sh + qz * ch
  if (w > 0.5) { out[0] += at[0]; out[1] += at[1]; out[2] += at[2] }
  return out
}

// --- The rings --------------------------------------------------------------------------------------------------

/** One ring of a loft: an ellipse at height y about (x, z), its radii (the back may differ from the front), its colour slot, its bones. */
interface Ring {
  readonly y: number
  readonly x?: number
  readonly z?: number
  readonly rx: number
  readonly rz?: number
  readonly back?: number
  readonly slot: number
  readonly bone: number
  readonly bone1?: number
  readonly w?: number
  /** Kept in the distant body too. */
  readonly far?: boolean
}

interface Tube {
  readonly rings: readonly Ring[]
  readonly segments: number
  readonly farSegments: number
  readonly capTop?: number
  readonly capBottom?: number
  readonly piece?: number
  /** The slot of the front vertices within a V of this half-angle (rad) at the top ring, closing at the bottom ring named. */
  readonly front?: { readonly slot: number; readonly top: number; readonly closesAt: number; readonly opens: number }
  /** Left out of the distant body altogether. */
  readonly nearOnly?: boolean
}

/** The trunk's profile for a body: [y, rx, rz front, rz back, slot], from the seat up to the neck. */
type Profile = readonly (readonly [number, number, number, number, number])[]

const T = SLOT.TOP, B = SLOT.BOTTOM, K = SLOT.SKIN

/** A man's trunk (the suit and the smart casual): the jacket's hem at `hem`, the seat below it. */
function manTrunk(hem: number): Profile {
  const seat = (y: number) => (y < hem ? B : T)
  return [
    [0.8, 0.15, 0.11, 0.11, B], [0.86, 0.165, 0.12, 0.12, seat(0.86)], [hem, 0.168, 0.12, 0.12, T],
    [0.98, 0.165, 0.115, 0.115, seat(0.98)], [1.06, 0.158, 0.11, 0.11, T], [1.16, 0.165, 0.118, 0.115, T], [1.26, 0.18, 0.128, 0.12, T],
    [1.34, 0.195, 0.135, 0.125, T], [1.4, 0.21, 0.13, 0.12, T], [1.46, 0.2, 0.11, 0.105, T], [1.5, 0.12, 0.085, 0.085, T],
    [1.53, 0.062, 0.062, 0.062, K], [1.58, 0.056, 0.056, 0.056, K],
  ]
}
/** A woman's trunk (the pantsuit and the skirt suit): the bust, a narrower waist, the hem at `hem`. */
function womanTrunk(hem: number): Profile {
  const seat = (y: number) => (y < hem ? B : T)
  return [
    [0.8, 0.15, 0.105, 0.105, B], [0.86, 0.165, 0.115, 0.115, seat(0.86)], [0.92, 0.168, 0.118, 0.118, seat(0.92)],
    [hem, 0.16, 0.11, 0.11, T], [1.06, 0.142, 0.1, 0.1, seat(1.06)], [1.16, 0.15, 0.115, 0.105, T], [1.26, 0.168, 0.145, 0.112, T],
    [1.34, 0.18, 0.138, 0.118, T], [1.4, 0.19, 0.122, 0.112, T], [1.46, 0.182, 0.105, 0.1, T], [1.5, 0.11, 0.08, 0.08, T],
    [1.53, 0.056, 0.056, 0.056, K], [1.58, 0.05, 0.05, 0.05, K],
  ]
}

/** The front z of the trunk at height y (linear between its rings), to hang a tie or a hem just outside it. */
function frontOf(profile: Profile, y: number): number {
  for (let i = 1; i < profile.length; i++) {
    const [y0, , z0] = profile[i - 1], [y1, , z1] = profile[i]
    if (y <= y1) return z0 + ((y - y0) / (y1 - y0)) * (z1 - z0)
  }
  return profile[profile.length - 1][2]
}

const trunkRings = (profile: Profile, chestFrom: number): Ring[] =>
  profile.map(([y, rx, rz, back, slot], i) => ({
    y, rx, rz, back, slot,
    bone: y >= chestFrom ? BONE.CHEST : BONE.TRUNK,
    bone1: y >= chestFrom ? BONE.TRUNK : BONE.CHEST,
    w: y >= chestFrom + 0.1 ? 1 : y >= chestFrom ? 0.6 : y >= chestFrom - 0.1 ? 0.7 : 1,
    far: i % 2 === 0 || i === profile.length - 1,
  })).map((r, i, all) => (i >= all.length - 2 ? { ...r, bone: BONE.HEAD, bone1: BONE.CHEST, w: i === all.length - 1 ? 0.8 : 0.4 } : r))

/** The head: the skull from the chin to the crown, and the cap of hair over its top and back. */
function headTubes(): Tube[] {
  const H = BONE.HEAD
  const skull: Ring[] = [
    { y: 1.575, rx: 0.056, rz: 0.056, slot: K, bone: H, far: true },
    { y: 1.6, rx: 0.075, rz: 0.082, back: 0.078, z: 0.004, slot: K, bone: H },
    { y: 1.64, rx: 0.092, rz: 0.1, back: 0.096, z: 0.004, slot: K, bone: H, far: true },
    { y: 1.68, rx: 0.098, rz: 0.106, back: 0.104, slot: K, bone: H },
    { y: 1.71, rx: 0.095, rz: 0.1, back: 0.1, slot: K, bone: H, far: true },
    { y: 1.735, rx: 0.08, rz: 0.086, back: 0.088, slot: K, bone: H },
    { y: 1.75, rx: 0.046, rz: 0.05, back: 0.055, slot: K, bone: H, far: true },
  ]
  const hair: Ring[] = [
    { y: 1.62, rx: 0.088, rz: 0.1, z: -0.03, slot: SLOT.HAIR, bone: H, far: true },
    { y: 1.68, rx: 0.104, rz: 0.108, z: -0.016, slot: SLOT.HAIR, bone: H },
    { y: 1.72, rx: 0.101, rz: 0.102, z: -0.012, slot: SLOT.HAIR, bone: H, far: true },
    { y: 1.75, rx: 0.082, rz: 0.084, z: -0.01, slot: SLOT.HAIR, bone: H },
    { y: 1.766, rx: 0.042, rz: 0.044, z: -0.01, slot: SLOT.HAIR, bone: H, far: true },
  ]
  const long: Ring[] = [
    { y: 1.66, rx: 0.1, rz: 0.05, z: -0.075, slot: SLOT.HAIR, bone: H, far: true },
    { y: 1.56, rx: 0.11, rz: 0.05, z: -0.1, slot: SLOT.HAIR, bone: H },
    { y: 1.44, rx: 0.12, rz: 0.045, z: -0.15, slot: SLOT.HAIR, bone: H, bone1: BONE.CHEST, w: 0.5, far: true },
    { y: 1.33, rx: 0.115, rz: 0.04, z: -0.158, slot: SLOT.HAIR, bone: BONE.CHEST, far: true },
  ]
  const glasses: Ring[] = [
    { y: 1.672, rx: 0.095, rz: 0.014, z: 0.1, slot: SLOT.FRAME, bone: H },
    { y: 1.69, rx: 0.095, rz: 0.014, z: 0.1, slot: SLOT.FRAME, bone: H },
  ]
  return [
    { rings: skull, segments: 12, farSegments: 8, capTop: 1.762, capBottom: 1.572 },
    { rings: hair, segments: 12, farSegments: 8, capTop: 1.776 },
    { rings: long, segments: 10, farSegments: 6, capBottom: 1.31, piece: PIECE.LONG_HAIR },
    { rings: glasses, segments: 12, farSegments: 6, piece: PIECE.GLASSES, nearOnly: true },
  ]
}

/** One arm: the sleeve from inside the shoulder to the cuff (the top's cloth), then the hand. */
function armTubes(side: number, woman: boolean): Tube[] {
  const [arm, fore, hand] = side < 0 ? [BONE.ARM_L, BONE.FOREARM_L, BONE.HAND_L] : [BONE.ARM_R, BONE.FOREARM_R, BONE.HAND_R]
  const x = side * LANDMARK.shoulderX
  const r = woman ? 0.9 : 1
  const sleeve: Ring[] = [
    { y: 1.47, x: x * 1.02, rx: 0.052 * r, rz: 0.056 * r, slot: T, bone: arm, bone1: BONE.CHEST, w: 0.55, far: true },
    { y: 1.4, x: x * 1.06, rx: 0.05 * r, rz: 0.052 * r, slot: T, bone: arm, bone1: BONE.CHEST, w: 0.85 },
    { y: 1.3, x: x * 1.06, rx: 0.046 * r, slot: T, bone: arm, far: true },
    { y: 1.2, x: x * 1.06, rx: 0.042 * r, slot: T, bone: arm, bone1: fore, w: 0.5, far: true },
    { y: 1.1, x: x * 1.06, rx: 0.04 * r, slot: T, bone: fore },
    { y: 1.0, x: x * 1.06, rx: 0.036 * r, slot: T, bone: fore, far: true },
    { y: 0.935, x: x * 1.06, rx: 0.034 * r, slot: T, bone: fore, far: true },
  ]
  const palm: Ring[] = [
    { y: 0.92, x: x * 1.06, rx: 0.031 * r, rz: 0.02, slot: K, bone: hand, bone1: fore, w: 0.5, far: true },
    { y: 0.86, x: x * 1.06, rx: 0.04 * r, rz: 0.018, slot: K, bone: hand },
    { y: 0.78, x: x * 1.06, rx: 0.036 * r, rz: 0.016, slot: K, bone: hand, far: true },
    { y: 0.75, x: x * 1.06, rx: 0.02 * r, rz: 0.012, slot: K, bone: hand },
  ]
  return [
    { rings: sleeve, segments: 10, farSegments: 6 },
    { rings: palm, segments: 8, farSegments: 6, capBottom: 0.74 },
  ]
}

/** One leg: the trouser leg (or the hose under a skirt) from inside the seat to the ankle, then the shoe. */
function legTubes(side: number, legSlot: number, woman: boolean): Tube[] {
  const [thigh, shin, foot] = side < 0 ? [BONE.THIGH_L, BONE.SHIN_L, BONE.FOOT_L] : [BONE.THIGH_R, BONE.SHIN_R, BONE.FOOT_R]
  const x = side * LANDMARK.hipX
  const r = woman ? 0.92 : 1
  const leg: Ring[] = [
    { y: 0.88, x, rx: 0.085 * r, rz: 0.09 * r, slot: legSlot, bone: thigh, bone1: BONE.TRUNK, w: 0.6, far: true },
    { y: 0.8, x, rx: 0.082 * r, rz: 0.088 * r, slot: legSlot, bone: thigh, bone1: BONE.TRUNK, w: 0.9 },
    { y: 0.7, x, rx: 0.078 * r, rz: 0.082 * r, slot: legSlot, bone: thigh, far: true },
    { y: 0.6, x, rx: 0.07 * r, rz: 0.074 * r, slot: legSlot, bone: thigh },
    { y: 0.52, x, rx: 0.062 * r, rz: 0.066 * r, slot: legSlot, bone: thigh, bone1: shin, w: 0.5, far: true },
    { y: 0.44, x, rx: 0.06 * r, rz: 0.064 * r, slot: legSlot, bone: shin },
    { y: 0.34, x, rx: 0.06 * r, rz: 0.064 * r, slot: legSlot, bone: shin, far: true },
    { y: 0.24, x, rx: 0.052 * r, rz: 0.056 * r, slot: legSlot, bone: shin },
    { y: 0.14, x, rx: 0.045 * r, rz: 0.048 * r, slot: legSlot, bone: shin, far: true },
    { y: 0.095, x, rx: 0.041 * r, rz: 0.044 * r, slot: legSlot, bone: shin, bone1: foot, w: 0.5 },
  ]
  const shoe: Ring[] = [
    { y: 0.085, x, rx: 0.042 * r, rz: 0.05, slot: SLOT.SHOES, bone: foot, bone1: shin, w: 0.5, far: true },
    { y: 0.045, x, rx: 0.048 * r, rz: 0.1, z: 0.025, slot: SLOT.SHOES, bone: foot },
    { y: 0.012, x, rx: 0.05 * r, rz: 0.12, z: 0.03, slot: SLOT.SHOES, bone: foot, far: true },
    { y: 0, x, rx: 0.046 * r, rz: 0.115, z: 0.03, slot: SLOT.SHOES, bone: foot, far: true },
  ]
  return [
    { rings: leg, segments: 10, farSegments: 6 },
    { rings: shoe, segments: 8, farSegments: 6, capBottom: 0 },
  ]
}

/** The tie, a flat strip hanging just outside the shirt front (the suit alone). */
function tieTube(profile: Profile): Tube {
  const z = (y: number) => frontOf(profile, y) + 0.008
  const rings: Ring[] = [
    { y: 1.5, rx: 0.016, rz: 0.006, z: z(1.5), slot: SLOT.ACCENT, bone: BONE.CHEST },
    { y: 1.4, rx: 0.02, rz: 0.006, z: z(1.4), slot: SLOT.ACCENT, bone: BONE.CHEST },
    { y: 1.3, rx: 0.024, rz: 0.006, z: z(1.3), slot: SLOT.ACCENT, bone: BONE.CHEST },
    { y: 1.2, rx: 0.024, rz: 0.006, z: z(1.2), slot: SLOT.ACCENT, bone: BONE.CHEST, bone1: BONE.TRUNK, w: 0.6 },
    { y: 1.12, rx: 0.02, rz: 0.006, z: z(1.12), slot: SLOT.ACCENT, bone: BONE.TRUNK },
  ]
  return { rings, segments: 6, farSegments: 4, capBottom: 1.1, piece: PIECE.TIE, nearOnly: true }
}

/** A cup in the left hand (the pose brings it up to the chest). */
function cupTube(): Tube {
  const x = -LANDMARK.shoulderX * 1.06
  const rings: Ring[] = [
    { y: 0.745, x, rx: 0.028, z: 0.048, slot: SLOT.PROP, bone: BONE.HAND_L },
    { y: 0.855, x, rx: 0.034, z: 0.048, slot: SLOT.PROP, bone: BONE.HAND_L },
  ]
  return { rings, segments: 8, farSegments: 6, capTop: 0.855, capBottom: 0.745, piece: PIECE.CUP, nearOnly: true }
}

/** A bag hanging from the right hand. */
function bagTube(woman: boolean): Tube {
  const x = LANDMARK.shoulderX * 1.06 + 0.03
  const d = woman ? 0.16 : 0.19
  const rings: Ring[] = [
    { y: 0.8, x, rx: 0.012, rz: 0.06, slot: SLOT.PROP, bone: BONE.HAND_R, far: true },
    { y: 0.76, x, rx: 0.045, rz: d, slot: SLOT.PROP, bone: BONE.HAND_R, far: true },
    { y: 0.6, x, rx: 0.045, rz: d, slot: SLOT.PROP, bone: BONE.HAND_R },
    { y: 0.56, x, rx: 0.04, rz: d - 0.01, slot: SLOT.PROP, bone: BONE.HAND_R, far: true },
  ]
  return { rings, segments: 8, farSegments: 4, capTop: 0.8, capBottom: 0.56, piece: PIECE.BAG }
}

/** The skirt: a shell from the waist to above the knee, turned with the trunk. */
function skirtTube(): Tube {
  const rings: Ring[] = [
    { y: 1.02, rx: 0.17, rz: 0.12, slot: B, bone: BONE.TRUNK, far: true },
    { y: 0.92, rx: 0.185, rz: 0.135, slot: B, bone: BONE.TRUNK },
    { y: 0.8, rx: 0.2, rz: 0.15, slot: B, bone: BONE.TRUNK, far: true },
    { y: 0.66, rx: 0.215, rz: 0.16, slot: B, bone: BONE.TRUNK },
    { y: 0.56, rx: 0.225, rz: 0.17, slot: B, bone: BONE.TRUNK, far: true },
  ]
  return { rings, segments: 16, farSegments: 8 }
}

/** The four bodies' names, in draw-list order (crowd.ts VARIANT_NAMES, look.ts LOOK_BODIES). */
export const BODY_NAMES = ['suit', 'smart casual', 'pantsuit', 'skirt suit'] as const

/** Every tube of one body: the four outfits over the same person. */
export function bodyTubes(variant: number): Tube[] {
  const v = Number.isFinite(variant) ? Math.min(3, Math.max(0, Math.floor(variant))) : 0
  const woman = v >= 2
  const skirt = v === 3
  const hem = v === 0 ? 0.9 : v === 1 ? 0.94 : v === 2 ? 0.92 : 0.98
  const profile = woman ? womanTrunk(hem) : manTrunk(hem)
  // The shirt shows in a V between the lapels: from the collar down to the top button.
  const front = { slot: SLOT.SHIRT, top: v === 1 ? 0.6 : 0.5, opens: 1.5, closesAt: v === 0 ? 1.2 : v === 1 ? 1.28 : 1.24 }
  const tubes: Tube[] = [
    { rings: trunkRings(profile, 1.12), segments: 16, farSegments: 8, capBottom: 0.78, front },
    ...headTubes(),
    ...armTubes(-1, woman), ...armTubes(1, woman),
    ...legTubes(-1, skirt ? SLOT.LEGWEAR : B, woman), ...legTubes(1, skirt ? SLOT.LEGWEAR : B, woman),
    bagTube(woman), cupTube(),
  ]
  if (skirt) tubes.push(skirtTube())
  if (v === 0) tubes.push(tieTube(profile))
  return tubes
}

// --- The loft ---------------------------------------------------------------------------------------------------

/** The geometry of one body, as flat arrays the renderer wraps: three floats of position and normal, `rig` and `skin` per vertex. */
export interface HumanoidMesh {
  readonly position: Float32Array
  readonly normal: Float32Array
  /** (bone, slot, piece) per vertex. */
  readonly rig: Float32Array
  /** (second bone, weight of the first) per vertex. */
  readonly skin: Float32Array
  readonly index: Uint32Array
  readonly vertexCount: number
}

class Loft {
  readonly position: number[] = []
  readonly rig: number[] = []
  readonly skin: number[] = []
  readonly index: number[] = []

  vertex(x: number, y: number, z: number, bone: number, slot: number, piece: number, bone1: number, w: number): number {
    const i = this.position.length / 3
    this.position.push(x, y, z)
    this.rig.push(bone, slot, piece)
    this.skin.push(bone1, w)
    return i
  }

  tube(t: Tube, far: boolean): void {
    if (far && t.nearOnly) return
    const rings = far ? t.rings.filter((r, i) => r.far || i === 0 || i === t.rings.length - 1) : t.rings
    if (rings.length < 2) return
    const n = far ? t.farSegments : t.segments
    const piece = t.piece ?? PIECE.NONE
    const first: number[] = []
    const top = rings[rings.length - 1], bottom = rings[0]
    for (const r of rings) {
      const cx = r.x ?? 0, cz = r.z ?? 0, rz = r.rz ?? r.rx, back = r.back ?? rz
      const bone1 = r.bone1 ?? r.bone, w = r.w ?? 1
      const base = this.position.length / 3
      first.push(base)
      for (let j = 0; j < n; j++) {
        const th = (j / n) * Math.PI * 2
        const s = Math.sin(th)
        const z = cz + (s >= 0 ? rz : back) * s
        let slot = r.slot
        if (t.front && r.y >= t.front.closesAt && r.y <= t.front.opens && slot === T) {
          // The V's half-angle narrows from the collar to where it closes.
          const span = t.front.opens - t.front.closesAt
          const half = span > 0 ? t.front.top * (r.y - t.front.closesAt) / span : 0
          if (Math.abs(th - Math.PI / 2) <= half + 1e-9) slot = t.front.slot
        }
        this.vertex(cx + r.rx * Math.cos(th), r.y, z, r.bone, slot, piece, bone1, w)
      }
    }
    for (let k = 1; k < rings.length; k++) {
      const a = first[k - 1], b = first[k]
      for (let j = 0; j < n; j++) {
        const j1 = (j + 1) % n
        this.index.push(a + j, b + j, b + j1, a + j, b + j1, a + j1)
      }
    }
    if (t.capTop !== undefined) {
      const c = this.vertex(top.x ?? 0, t.capTop, top.z ?? 0, top.bone, top.slot, piece, top.bone1 ?? top.bone, top.w ?? 1)
      const a = first[rings.length - 1]
      for (let j = 0; j < n; j++) this.index.push(a + ((j + 1) % n), a + j, c)
    }
    if (t.capBottom !== undefined) {
      const c = this.vertex(bottom.x ?? 0, t.capBottom, bottom.z ?? 0, bottom.bone, bottom.slot, piece, bottom.bone1 ?? bottom.bone, bottom.w ?? 1)
      const a = first[0]
      for (let j = 0; j < n; j++) this.index.push(a + j, a + ((j + 1) % n), c)
    }
  }

  /** Smooth normals: every face's normal summed into its vertices, then normalised (a vertex with none points up). */
  normals(): Float32Array {
    const p = this.position
    const out = new Float32Array(p.length)
    for (let i = 0; i < this.index.length; i += 3) {
      const a = this.index[i] * 3, b = this.index[i + 1] * 3, c = this.index[i + 2] * 3
      const abx = p[b] - p[a], aby = p[b + 1] - p[a + 1], abz = p[b + 2] - p[a + 2]
      const acx = p[c] - p[a], acy = p[c + 1] - p[a + 1], acz = p[c + 2] - p[a + 2]
      const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx
      for (const v of [a, b, c]) { out[v] += nx; out[v + 1] += ny; out[v + 2] += nz }
    }
    for (let v = 0; v < out.length; v += 3) {
      const l = Math.hypot(out[v], out[v + 1], out[v + 2])
      if (l > 1e-12) { out[v] /= l; out[v + 1] /= l; out[v + 2] /= l } else { out[v] = 0; out[v + 1] = 1; out[v + 2] = 0 }
    }
    return out
  }

  mesh(): HumanoidMesh {
    return {
      position: new Float32Array(this.position),
      normal: this.normals(),
      rig: new Float32Array(this.rig),
      skin: new Float32Array(this.skin),
      index: new Uint32Array(this.index),
      vertexCount: this.position.length / 3,
    }
  }
}

/**
 * The body of `variant` (BODY_NAMES order, clamped) in its rest pose: detailed, or the distant one (fewer rings
 * round fewer segments, the small pieces left out). Deterministic: the same arrays every call.
 */
export function humanoidMesh(variant: number, detailed = true): HumanoidMesh {
  const loft = new Loft()
  for (const t of bodyTubes(variant)) loft.tube(t, !detailed)
  return loft.mesh()
}

// --- The silhouette (the card's preview) ------------------------------------------------------------------------

/**
 * One ring of a body's silhouette after the sliders: its height and its two edges (from the front: the left and the
 * right; from the side: the back and the front), m, and what paints it.
 */
export interface SilhouetteRing {
  readonly y: number
  readonly left: number
  readonly right: number
  readonly slot: number
  readonly piece: number
  /** The tube the ring belongs to (consecutive rings of one tube join into one band). */
  readonly tube: number
}

/** The standing pose the silhouette is drawn in: no step, no push. */
const STILL: BodyPose = Object.freeze({ tilt: 0, bend: 0, fall: 0 })

/**
 * The body's rings, standing, with the sliders applied (every ring's two edge points through morphPoint, the standing
 * pose's bones and the stature's scales, as the shader would place them) seen from the front (`side` false: x edges)
 * or from the person's left (`side` true: z edges, so the posture's lean and the knees' and elbows' rest show), for a
 * picture of the look without a GPU. Optional pieces are included with their piece bit; the caller leaves out the
 * ones the look does not wear. The legs' and arms' rings are weighted to their own bone alone here (their blend to
 * the trunk is a few millimetres at rest).
 */
export function silhouetteRings(variant: number, shape: BodyShape, side = false): SilhouetteRing[] {
  const f = shapeFactors(shape)
  const scale = scaleOf(f)
  const piv = pivotsOf(f)
  const a = walkAngles(0, 0, f)
  const out: SilhouetteRing[] = []
  const p = [0, 0, 0]
  const edge = (x: number, y: number, z: number, bone: number): number[] => {
    morphPoint(x, y, z, bone, f, p)
    boneTransform(bone, p, 1, a, STILL, piv)
    p[0] *= scale.xz; p[1] *= scale.y; p[2] *= scale.xz
    return p
  }
  bodyTubes(variant).forEach((t, tube) => {
    for (const r of t.rings) {
      const cx = r.x ?? 0, cz = r.z ?? 0, rz = r.rz ?? r.rx, back = r.back ?? rz
      let y: number, left: number, right: number
      if (side) {
        const b = edge(cx, r.y, cz - back, r.bone)
        left = b[2]; y = b[1]
        right = edge(cx, r.y, cz + rz, r.bone)[2]
      } else {
        const l = edge(cx - r.rx, r.y, cz, r.bone)
        left = l[0]; y = l[1]
        right = edge(cx + r.rx, r.y, cz, r.bone)[0]
      }
      out.push({ y, left, right, slot: r.slot, piece: t.piece ?? PIECE.NONE, tube })
    }
  })
  return out
}
