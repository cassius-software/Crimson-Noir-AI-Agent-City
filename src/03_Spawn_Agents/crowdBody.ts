// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the crowd's skin on the GPU: the WGSL the vertex stage of every body material
 * (crowd.ts) runs once for each vertex, written as TSL functions. It is humanoid.ts's arithmetic, line for line,
 * with humanoid.ts's numbers written into it at load (the landmarks, the slider ranges, the regions, the face table,
 * the walk), so the body the card draws and the body the street draws are one: the face sliders reshape a head
 * vertex by its region, the body sliders reshape the rest point (and its normal, by the scales' reciprocals), the
 * walk sets each joint's angle from the phase, the point follows its two bones blended by its weight (linear blend
 * skinning), then the step's rise, the stature's scales, the spring-damper tilt, the heading and the position. One
 * call gives both the position and the normal, as two columns of a 3×3 matrix (the third is zero), so every sine is
 * taken once. Pure: builds nodes, needs no renderer; humanoid.test.ts holds its text to humanoid.ts's constants and
 * its include graph (BODY_INCLUDES) to the calls in the text.
 * What breaks if it is removed? The bodies have no vertex stage: nothing of the crowd is posed or drawn.
 */
import { wgslFn } from 'three/tsl'
import { FACE, HEIGHT_BASE, LANDMARK, LIMB_GIRTH, MORPH, REGION, WALK } from './humanoid.ts'

/** A number as a WGSL f32 literal (an integer gets its point). */
const f = (n: number): string => (Number.isInteger(n) ? `${n}.0` : `${n}`)

/**
 * The WGSL, one `fn` per wgslFn (the others are its includes). Every constant is humanoid.ts's. A `mat3x3f` passed
 * through the rotations carries the position in its first column and the normal in its second.
 *
 * bodyVertex's arguments: the rest position and normal; the vertex's `rig` (bone, slot, piece), `skin` (second
 * bone, weight of the first) and `face` (face region, weight); the agent's position and heading; its motion (vx, vz,
 * walk phase, speed); its spring-damper pose (tilt, bend, push angle, activity); `stance` = (stature as a factor of
 * the base height, piece mask, idle phase 0..1, -); `morphA` = (mass, muscle, shoulders, hips) and `morphB` = (legs,
 * posture, head, -), each a slider's 0..1; `faceA` = (brow, jaw, chin, cheek) and `faceB` = (nose, eyes, lips, -),
 * each −1..1; and the time.
 */
export const BODY_WGSL = `
fn bodyRotX(m: mat3x3f, piv: vec3f, a: f32) -> mat3x3f {
  let c = cos(a);
  let s = sin(a);
  let q = m[0] - piv;
  let n = m[1];
  return mat3x3f(vec3f(q.x, q.y * c - q.z * s, q.y * s + q.z * c) + piv, vec3f(n.x, n.y * c - n.z * s, n.y * s + n.z * c), vec3f(0.0));
}
fn bodyRotY(m: mat3x3f, piv: vec3f, a: f32) -> mat3x3f {
  let c = cos(a);
  let s = sin(a);
  let q = m[0] - piv;
  let n = m[1];
  return mat3x3f(vec3f(q.x * c + q.z * s, q.y, -q.x * s + q.z * c) + piv, vec3f(n.x * c + n.z * s, n.y, -n.x * s + n.z * c), vec3f(0.0));
}
fn bodyRotAxis(m: mat3x3f, piv: vec3f, k: vec3f, a: f32) -> mat3x3f {
  let c = cos(a);
  let s = sin(a);
  let q = m[0] - piv;
  let n = m[1];
  return mat3x3f(q * c + cross(k, q) * s + k * dot(k, q) * (1.0 - c) + piv, n * c + cross(k, n) * s + k * dot(k, n) * (1.0 - c), vec3f(0.0));
}
fn bodyHat(y: f32, at: f32, half: f32) -> f32 {
  return clamp(1.0 - abs(y - at) / half, 0.0, 1.0);
}
fn bodyHeightMap(y: f32, fLegs: f32, fTrunk: f32) -> f32 {
  let low = y * fLegs;
  let mid = ${f(LANDMARK.hip)} * fLegs + (y - ${f(LANDMARK.hip)}) * fTrunk;
  return select(select(y, mid, y <= ${f(LANDMARK.neck)}), low, y <= ${f(LANDMARK.hip)});
}
fn bodySlope(y: f32, fLegs: f32, fTrunk: f32) -> f32 {
  return select(select(1.0, fTrunk, y <= ${f(LANDMARK.neck)}), fLegs, y <= ${f(LANDMARK.hip)});
}
fn bodyFace(p: vec3f, n: vec3f, face: vec2f, fa: vec4f, fb: vec4f) -> mat3x3f {
  // face = (region, weight): 1 brow, 2 jaw, 3 chin, 4 cheek, 5 nose, 6 eyes, 7 lips (humanoid.ts FACE_REGION, FACE).
  let region = u32(face.x + 0.5);
  let w = face.y;
  var q = p;
  var m = n;
  if (region == 1u) {
    q = vec3f(p.x, p.y + fa.x * ${f(FACE.brow.lift)}, p.z + fa.x * ${f(FACE.brow.push)});
  } else if (region == 2u) {
    let s = 1.0 + fa.y * ${f(FACE.jaw.width)} * w;
    q = vec3f(p.x * s, p.y, p.z);
    m = vec3f(n.x / s, n.y, n.z);
  } else if (region == 3u) {
    let s = 1.0 + fa.y * ${f(FACE.jaw.width)};
    q = vec3f(p.x * s, p.y, p.z + fa.z * ${f(FACE.chin.push)} * w);
    m = vec3f(n.x / s, n.y, n.z);
  } else if (region == 4u) {
    q = vec3f(p.x + sign(p.x) * fa.w * ${f(FACE.cheek.width)} * w, p.y + fa.w * ${f(FACE.cheek.lift)} * w, p.z);
  } else if (region == 5u) {
    let s = 1.0 + fb.x * ${f(FACE.nose.size)};
    q = vec3f(p.x * s, p.y, ${f(FACE.nose.rootZ)} + (p.z - ${f(FACE.nose.rootZ)}) * s);
    m = vec3f(n.x / s, n.y, n.z / s);
  } else if (region == 6u) {
    let d = fb.y * ${f(FACE.eyes.spread)};
    q = vec3f(p.x + sign(p.x) * d, p.y, p.z - d * ${f(FACE.eyes.slope)});
  } else if (region == 7u) {
    let s = 1.0 + fb.z * ${f(FACE.lips.fullness)};
    q = vec3f(p.x, ${f(FACE.lips.lineY)} + (p.y - ${f(FACE.lips.lineY)}) * s, p.z);
    m = vec3f(n.x, n.y / s, n.z);
  }
  return mat3x3f(q, normalize(m), vec3f(0.0));
}
fn bodyMorph(p: vec3f, n: vec3f, bone: u32, m: vec4f, fD: f32, fLegs: f32, fTrunk: f32) -> mat3x3f {
  // m = (mass factor, muscle factor, shoulders factor, hips factor), each about 1; fD the head's.
  let dm = m.x - 1.0;
  let du = m.y - 1.0;
  var g = vec3f(1.0);
  var ax = 0.0;
  var shiftX = 0.0;
  var shiftZ = 0.0;
  var y = p.y;
  if (bone < 3u) {
    if (bone == 2u) {
      let gh = (1.0 + dm * ${f(LIMB_GIRTH.head.mass)}) * fD;
      g = vec3f(gh, fD, gh);
      y = ${f(LANDMARK.neck)} + (p.y - ${f(LANDMARK.neck)}) * fD;
    } else {
      let gg = 1.0 + dm * (0.5 + 0.5 * bodyHat(p.y, ${f(REGION.waist.at)}, ${f(REGION.waist.half)})) + du * 0.6 * bodyHat(p.y, ${f(REGION.chest.at)}, ${f(REGION.chest.half)});
      let hip = bodyHat(p.y, ${f(REGION.hip.at)}, ${f(REGION.hip.half)});
      let wx = 1.0 + (m.z - 1.0) * bodyHat(p.y, ${f(REGION.shoulder.at)}, ${f(REGION.shoulder.half)}) + (m.w - 1.0) * hip;
      let wz = 1.0 + (m.w - 1.0) * 0.5 * hip;
      let push = select(0.0, dm * 0.1 * bodyHat(p.y, ${f(REGION.belly.at)}, ${f(REGION.belly.half)}), p.z > 0.0 && dm > 0.0);
      g = vec3f(gg * wx, bodySlope(p.y, fLegs, fTrunk), gg * wz);
      shiftZ = push * wz;
      y = bodyHeightMap(p.y, fLegs, fTrunk);
    }
  } else if (bone < 9u) {
    let side = select(-1.0, 1.0, bone >= 6u);
    let part = (bone - 3u) % 3u;
    let gl = 1.0 + select(select(0.0, dm * ${f(LIMB_GIRTH.shin.mass)} + du * ${f(LIMB_GIRTH.shin.muscle)}, part == 1u), dm * ${f(LIMB_GIRTH.thigh.mass)} + du * ${f(LIMB_GIRTH.thigh.muscle)}, part == 0u);
    g = vec3f(gl, bodySlope(p.y, fLegs, fTrunk), gl);
    ax = side * ${f(LANDMARK.hipX)};
    shiftX = side * ${f(LANDMARK.hipX)} * (m.w - 1.0);
    y = bodyHeightMap(p.y, fLegs, fTrunk);
  } else {
    let side = select(-1.0, 1.0, bone >= 12u);
    let part = (bone - 9u) % 3u;
    let ga = 1.0 + select(select(0.0, dm * ${f(LIMB_GIRTH.forearm.mass)} + du * ${f(LIMB_GIRTH.forearm.muscle)}, part == 1u), dm * ${f(LIMB_GIRTH.arm.mass)} + du * ${f(LIMB_GIRTH.arm.muscle)}, part == 0u);
    g = vec3f(ga, 1.0, ga);
    ax = side * ${f(LANDMARK.shoulderX)};
    shiftX = side * ${f(LANDMARK.shoulderX)} * (m.z - 1.0);
    y = bodyHeightMap(${f(LANDMARK.shoulder)}, fLegs, fTrunk) - (${f(LANDMARK.shoulder)} - p.y);
  }
  return mat3x3f(vec3f(ax + (p.x - ax) * g.x + shiftX, y, p.z * g.z + shiftZ), normalize(n / g), vec3f(0.0));
}
fn bodyBone(bone: u32, m: mat3x3f, legL: vec4f, legR: vec4f, armL: vec4f, armR: vec4f, trunk: vec4f, pivA: vec4f, pivB: vec4f, pivX: vec2f, k: vec3f) -> mat3x3f {
  // legL/legR = (hip, knee, ankle, -), armL/armR = (shoulder, elbow, -, -), trunk = (twist, head, slouch, bend);
  // pivA = (hip, knee, ankle, shoulder), pivB = (elbow, wrist, chest, neck) heights, pivX = (hipX, shoulderX).
  var q = m;
  if (bone >= 3u && bone <= 8u) {
    let left = bone <= 5u;
    let side = select(1.0, -1.0, left);
    let part = (bone - 3u) % 3u;
    let a = select(legR, legL, left);
    let x = side * pivX.x;
    if (part == 2u) { q = bodyRotX(q, vec3f(x, pivA.z, 0.0), a.z); }
    if (part >= 1u) { q = bodyRotX(q, vec3f(x, pivA.y, 0.0), a.y); }
    q = bodyRotX(q, vec3f(x, pivA.x, 0.0), a.x);
  } else {
    if (bone >= 9u) {
      let left = bone <= 11u;
      let side = select(1.0, -1.0, left);
      let part = (bone - 9u) % 3u;
      let a = select(armR, armL, left);
      let x = side * pivX.y;
      if (part >= 1u) { q = bodyRotX(q, vec3f(x, pivB.x, 0.0), a.y); }
      q = bodyRotX(q, vec3f(x, pivA.w, 0.0), a.x);
      q = bodyRotY(q, vec3f(0.0, pivB.z, 0.0), trunk.x);
    } else {
      if (bone == 2u) { q = bodyRotX(q, vec3f(0.0, pivB.w, 0.0), trunk.y); }
      if (bone >= 1u) { q = bodyRotY(q, vec3f(0.0, pivB.z, 0.0), trunk.x); }
    }
    let hip = vec3f(0.0, pivA.x, 0.0);
    q = bodyRotX(q, hip, trunk.z);
    q = bodyRotAxis(q, hip, k, trunk.w);
  }
  return q;
}
fn bodyVertex(v: vec3f, n: vec3f, rig: vec3f, skin: vec2f, face: vec2f, agent: vec4f, motion: vec4f, pose: vec4f, stance: vec4f, morphA: vec4f, morphB: vec4f, faceA: vec4f, faceB: vec4f, t: f32) -> mat3x3f {
  let bone0 = u32(rig.x + 0.5);
  let opt = u32(rig.z + 0.5);
  let bone1 = u32(skin.x + 0.5);
  let weight = clamp(skin.y, 0.0, 1.0);
  let mask = u32(stance.y + 0.5);
  if (opt != 0u && ((mask >> opt) & 1u) == 0u) {
    // A piece this person does not wear (the features too, in the shadow pass): every vertex on one point, nothing rasterised.
    return mat3x3f(agent.xyz, vec3f(0.0, 1.0, 0.0), vec3f(0.0));
  }
  // The face sliders, on the head's regions alone (the distant body carries no region).
  var v0 = v;
  var n0 = n;
  if (bone0 == 2u && face.x > 0.5) {
    let shaped = bodyFace(v, n, face, faceA, faceB);
    v0 = shaped[0];
    n0 = shaped[1];
  }
  // The sliders' factors.
  let fLegs = ${f(MORPH.legs.base)} + morphB.x * ${f(MORPH.legs.range)};
  let fTrunk = (${f(LANDMARK.neck)} - ${f(LANDMARK.hip)} * fLegs) / ${f(LANDMARK.neck - LANDMARK.hip)};
  let m = vec4f(${f(MORPH.mass.base)} + morphA.x * ${f(MORPH.mass.range)}, ${f(MORPH.muscle.base)} + morphA.y * ${f(MORPH.muscle.range)}, ${f(MORPH.shoulders.base)} + morphA.z * ${f(MORPH.shoulders.range)}, ${f(MORPH.hips.base)} + morphA.w * ${f(MORPH.hips.range)});
  let fD = ${f(MORPH.head.base)} + morphB.z * ${f(MORPH.head.range)};
  let slouch = (0.5 - morphB.y) * ${f(MORPH.slouch)};
  let gait = ${f(MORPH.gait.base)} + morphB.y * ${f(MORPH.gait.range)};
  // The joints after the sliders.
  let shoulderY = bodyHeightMap(${f(LANDMARK.shoulder)}, fLegs, fTrunk);
  let pivA = vec4f(${f(LANDMARK.hip)} * fLegs, ${f(LANDMARK.knee)} * fLegs, ${f(LANDMARK.ankle)} * fLegs, shoulderY);
  let pivB = vec4f(shoulderY - ${f(LANDMARK.shoulder - LANDMARK.elbow)}, shoulderY - ${f(LANDMARK.shoulder - LANDMARK.wrist)}, bodyHeightMap(${f(LANDMARK.chestPivot)}, fLegs, fTrunk), ${f(LANDMARK.neck)});
  let pivX = vec2f(${f(LANDMARK.hipX)} * m.w, ${f(LANDMARK.shoulderX)} * m.z);
  // The walk: the left leg's cycle at the phase, the right half a turn behind, the arms against them.
  let swing = clamp(motion.w / ${f(WALK.fullSpeed)}, 0.0, ${f(WALK.maxSwing)});
  let phase = motion.z;
  let sL = sin(phase);
  let cL = cos(phase);
  let liftL = max(0.0, -cL);
  let liftR = max(0.0, cL);
  let hipL = sL * ${f(WALK.hip)} * swing;
  let hipR = -sL * ${f(WALK.hip)} * swing;
  let kneeL = ${f(WALK.kneeRest)} + ${f(WALK.knee)} * swing * liftL * liftL;
  let kneeR = ${f(WALK.kneeRest)} + ${f(WALK.knee)} * swing * liftR * liftR;
  let legL = vec4f(hipL, kneeL, -(hipL + kneeL) * ${f(WALK.ankle)}, 0.0);
  let legR = vec4f(hipR, kneeR, -(hipR + kneeR) * ${f(WALK.ankle)}, 0.0);
  let holdingCup = ((mask >> 3u) & 1u) == 1u;
  let carryingBag = ((mask >> 2u) & 1u) == 1u;
  var shoulderL = -sL * ${f(WALK.shoulder)} * swing * gait;
  var elbowL = -(${f(WALK.elbowRest)} + ${f(WALK.elbow)} * swing * max(0.0, sL));
  var shoulderR = sL * ${f(WALK.shoulder)} * swing * gait;
  var elbowR = -(${f(WALK.elbowRest)} + ${f(WALK.elbow)} * swing * max(0.0, -sL));
  if (holdingCup) { shoulderL = ${f(WALK.cupShoulder)} + shoulderL * ${f(WALK.cupSwing)}; elbowL = ${f(WALK.cupElbow)}; }
  if (carryingBag) { shoulderR = shoulderR * ${f(WALK.bagSwing)}; elbowR = -${f(WALK.elbowRest)}; }
  let armL = vec4f(shoulderL, elbowL, 0.0, 0.0);
  let armR = vec4f(shoulderR, elbowR, 0.0, 0.0);
  // Idle weight shift while standing; the push's bend on top, about the push's axis.
  let idle = (1.0 - clamp(motion.w * 4.0, 0.0, 1.0)) * sin(t * 1.3 + stance.z * 6.28) * 0.03;
  let fall = pose.z - agent.w;
  let k = vec3f(cos(fall), 0.0, -sin(fall));
  let trunk = vec4f(sL * ${f(WALK.twist)} * swing * gait, -slouch * ${f(WALK.headCounter)}, slouch, pose.y + idle);
  // The rest point reshaped, then its two bones, blended; the tilt about the feet.
  let rest = bodyMorph(v0, n0, bone0, m, fD, fLegs, fTrunk);
  let b0 = bodyBone(bone0, rest, legL, legR, armL, armR, trunk, pivA, pivB, pivX, k);
  var b = b0;
  if (bone1 != bone0 && weight < 1.0) {
    let b1 = bodyBone(bone1, rest, legL, legR, armL, armR, trunk, pivA, pivB, pivX, k);
    b = b0 * weight + b1 * (1.0 - weight);
  }
  b = bodyRotAxis(b, vec3f(0.0), k, pose.x);
  // The stature's scales (the normal takes their reciprocals), the step's rise, the heading, the place.
  let across = sqrt(stance.x);
  let p = b[0];
  let q = vec3f(p.x * across, p.y * stance.x + abs(sL) * ${f(WALK.bob)} * swing, p.z * across);
  let nn = vec3f(b[1].x / across, b[1].y / stance.x, b[1].z / across);
  let ch = cos(agent.w);
  let sh = sin(agent.w);
  let world = vec3f(q.x * ch + q.z * sh, q.y, -q.x * sh + q.z * ch) + agent.xyz;
  return mat3x3f(world, normalize(vec3f(nn.x * ch + nn.z * sh, nn.y, -nn.x * sh + nn.z * ch)), vec3f(0.0));
}
`

/**
 * Which functions each function calls (its wgslFn includes, so three writes each once per shader). A call the table
 * misses would build in Node and fail only when a GPU compiles the module: humanoid.test.ts checks every `bodyX(` in
 * the text against this table, transitively.
 */
export const BODY_INCLUDES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  bodyMorph: Object.freeze(['bodyHat', 'bodyHeightMap', 'bodySlope']),
  bodyBone: Object.freeze(['bodyRotX', 'bodyRotY', 'bodyRotAxis']),
  bodyVertex: Object.freeze(['bodyFace', 'bodyHeightMap', 'bodyMorph', 'bodyBone', 'bodyRotAxis']),
})

const parts = BODY_WGSL.split(/(?=^fn )/m).map((s) => s.trim()).filter(Boolean)
const named = new Map(parts.map((p) => [p.match(/^fn (\w+)/)![1], p]))
type Includes = Parameters<typeof wgslFn>[1]
const built = new Map<string, ReturnType<typeof wgslFn>>()
/** The TSL function of a WGSL `fn`, its includes built first from the table (each once). */
const fn = (name: string): ReturnType<typeof wgslFn> => {
  const have = built.get(name)
  if (have) return have
  const includes = (BODY_INCLUDES[name] ?? []).map(fn)
  const made = wgslFn(named.get(name)!, includes as Includes)
  built.set(name, made)
  return made
}

/** The vertex stage's function, with every function it calls as its includes. */
export const bodyVertex = fn('bodyVertex')

/** A stature in metres as the factor the shader scales the base body by (stance.x). */
export const statureFactor = (metres: number): number => metres / HEIGHT_BASE
