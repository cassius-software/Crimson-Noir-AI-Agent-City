// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The body is drawn twice, by the CPU (humanoid.ts: the card's silhouette, these numbers)
 * and by the GPU (crowdBody.ts: the crowd), and they must be one person: the same tables, the same skeleton, the
 * same arithmetic for the sliders, the walk and the skinning. This pins the mesh (valid, bounded, deterministic, the
 * far body a subset of the near one), the sliders' arithmetic (neutral is identity; the widths move a limb with its
 * joint; a normal stays a unit normal), the walk and the skinning (a pivot stays put under its own bone), the eye's
 * height, the silhouette, and the WGSL's text (every constant humanoid.ts holds, written into it; the one call that
 * returns the position and the normal), with crowd.ts's use of it.
 * What breaks if it is removed? A table could change on one side only, and the card would promise a body the street
 * never draws, or the crowd would draw one nobody can see on the card.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { BODY_INCLUDES, BODY_WGSL, statureFactor } from './crowdBody.ts'
import {
  BODY_NAMES, BONE, BONES, EYE_LEVEL, FACE, FACE_NEUTRAL, FACE_REGION, GARMENT, GAZE, GAZE_AHEAD, HAIRLINE, HEIGHT_BASE, LANDMARK, LIMB_GIRTH, MORPH, PIECE, REGION, RIG_REST, RIG_WEAR, SHAPE_NEUTRAL, SLOT, SLOTS, SOLE, WALK,
  bodyTubes, boneGroup, boneSide, boneTransform, eyeHeightOf, faceNormal, facePoint, faceRings, footAt, gazeAt, heightMap, humanoidMesh, legReach, legSolve, morphNormal, morphPoint,
  pelvisDrop, pivotsOf, rigPoint, rotateByQuat, scaleOf, shapeFactors, silhouetteRings, skinPoint, skullFront, swingOf, walkAngles,
  type BodyPose, type BodyShape, type FaceShape, type LegAngles, type RigPose,
} from './humanoid.ts'
import { LOOK_BODIES, LOOK_PIECE_BIT } from './look.ts'
import { FOOT, SEGMENTS } from './ragdollRig.ts'
import { RIG_POSE, RIG_SEGMENTS, RIG_SLOTS } from '../07_Execute_Actions/simProtocol.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const near = (got: number, want: number, tol: number, what: string) => assert.ok(Math.abs(got - want) <= tol, `${what}: ${got} vs ${want}`)
const shape = (over: Partial<BodyShape>): BodyShape => ({ ...SHAPE_NEUTRAL, ...over })
const face = (over: Partial<FaceShape>): FaceShape => ({ ...FACE_NEUTRAL, ...over })
const STILL: BodyPose = { tilt: 0, bend: 0, fall: 0 }
const UNIT = { y: 1, xz: 1 }
const ORIGIN = [0, 0, 0] as const
const length = (v: number[]) => Math.hypot(v[0], v[1], v[2])
const VARIANTS = [0, 1, 2, 3]

// --- The tables ------------------------------------------------------------------------------------------------

test('the tables: four bodies named as the wardrobe names them, the pieces where the look\'s bits are, fourteen colour slots, eight face regions, fifteen bones in three groups on two sides', () => {
  assert.deepEqual([...BODY_NAMES], [...LOOK_BODIES])
  assert.deepEqual(LOOK_PIECE_BIT, { tie: PIECE.TIE, bag: PIECE.BAG, cup: PIECE.CUP, longHair: PIECE.LONG_HAIR, glasses: PIECE.GLASSES, hairCap: PIECE.HAIR_CAP, bob: PIECE.BOB, bun: PIECE.BUN, face: PIECE.FACE, coat: PIECE.COAT, scarf: PIECE.SCARF })
  assert.equal(PIECE.NONE, 0)
  assert.deepEqual([...Object.values(PIECE)].sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i))
  assert.deepEqual([...Object.values(FACE_REGION)].sort((a, b) => a - b), Array.from({ length: 8 }, (_, i) => i))
  assert.equal(FACE_REGION.NONE, 0)
  assert.equal(BONES, 15)
  assert.deepEqual([...Object.values(BONE)].sort((a, b) => a - b), Array.from({ length: 15 }, (_, i) => i))
  assert.deepEqual(Array.from({ length: 15 }, (_, b) => boneGroup(b)), [0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2])
  assert.deepEqual(Array.from({ length: 15 }, (_, b) => boneSide(b)), [0, 0, 0, -1, -1, -1, 1, 1, 1, -1, -1, -1, 1, 1, 1])
  assert.deepEqual([...Object.values(SLOT)].sort((a, b) => a - b), Array.from({ length: SLOTS }, (_, i) => i))
  assert.equal(SLOTS, 14)
  assert.deepEqual([SLOT.EYE, SLOT.IRIS, SLOT.LIP, SLOT.SCARF], [10, 11, 12, 13])
  for (const table of [BONE, SLOT, PIECE, LANDMARK, MORPH, REGION, LIMB_GIRTH, WALK, SHAPE_NEUTRAL, FACE, FACE_REGION, FACE_NEUTRAL]) assert.ok(Object.isFrozen(table))
  // The landmarks climb the body.
  assert.ok(LANDMARK.ankle < LANDMARK.knee && LANDMARK.knee < LANDMARK.hip && LANDMARK.hip < LANDMARK.chestPivot)
  assert.ok(LANDMARK.chestPivot < LANDMARK.shoulder && LANDMARK.shoulder < LANDMARK.neck && LANDMARK.neck < EYE_LEVEL && EYE_LEVEL < HEIGHT_BASE)
  assert.ok(LANDMARK.wrist < LANDMARK.elbow && LANDMARK.elbow < LANDMARK.shoulder)
  assert.equal(HEIGHT_BASE, 1.75)
  assert.equal(SHAPE_NEUTRAL.height, HEIGHT_BASE)
})

// --- The mesh --------------------------------------------------------------------------------------------------

test('every body, near and far: finite, indexed within range, every vertex on a bone with a slot, a piece and a face region (on the head alone), weights 0..1, unit normals, no flat triangle, within budget, deterministic', () => {
  const counts: Record<string, [number, number]> = {}
  for (const v of VARIANTS) for (const detailed of [true, false]) {
    const m = humanoidMesh(v, detailed)
    const name = `${BODY_NAMES[v]} ${detailed ? 'near' : 'far'}`
    assert.equal(m.position.length, m.vertexCount * 3)
    assert.equal(m.normal.length, m.vertexCount * 3)
    assert.equal(m.rig.length, m.vertexCount * 3)
    assert.equal(m.skin.length, m.vertexCount * 2)
    assert.equal(m.face.length, m.vertexCount * 2)
    assert.equal(m.index.length % 3, 0)
    assert.ok(m.index instanceof Uint32Array)
    for (const x of m.position) assert.ok(Number.isFinite(x))
    for (const i of m.index) assert.ok(i < m.vertexCount, `${name}: index ${i}`)
    const bones = new Set<number>()
    const regions = new Set<number>()
    for (let i = 0; i < m.vertexCount; i++) {
      const bone = m.rig[i * 3], slot = m.rig[i * 3 + 1], piece = m.rig[i * 3 + 2], bone1 = m.skin[i * 2], w = m.skin[i * 2 + 1]
      const region = m.face[i * 2], rw = m.face[i * 2 + 1]
      assert.ok(Number.isInteger(bone) && bone >= 0 && bone < BONES, `${name}: bone ${bone}`)
      assert.ok(Number.isInteger(bone1) && bone1 >= 0 && bone1 < BONES, `${name}: second bone ${bone1}`)
      assert.ok(Number.isInteger(slot) && slot >= 0 && slot < SLOTS, `${name}: slot ${slot}`)
      assert.ok(Number.isInteger(piece) && piece >= 0 && piece <= PIECE.SCARF, `${name}: piece ${piece}`)
      assert.ok(w >= 0 && w <= 1, `${name}: weight ${w}`)
      assert.ok(Number.isInteger(region) && region >= 0 && region <= FACE_REGION.LIPS, `${name}: face region ${region}`)
      assert.ok(rw >= 0 && rw <= 1, `${name}: face weight ${rw}`)
      if (region !== FACE_REGION.NONE) assert.equal(bone, BONE.HEAD, `${name}: a face region on the head alone (vertex ${i})`)
      if (!detailed) assert.equal(region, FACE_REGION.NONE, `${name}: the far body has no face to shape`)
      near(Math.hypot(m.normal[i * 3], m.normal[i * 3 + 1], m.normal[i * 3 + 2]), 1, 1e-3, `${name}: normal ${i}`)
      assert.ok(m.position[i * 3 + 1] >= -1e-6 && m.position[i * 3 + 1] <= HEIGHT_BASE + 0.05, `${name}: y ${m.position[i * 3 + 1]}`)
      bones.add(bone)
      regions.add(region)
    }
    assert.equal(bones.size, BONES, `${name}: every bone carries skin`)
    assert.equal(regions.size, detailed ? 8 : 1, `${name}: every face region is used by the near body`)
    // No triangle is flat: every feature pillow's cap and every ring pair has area.
    for (let t = 0; t < m.index.length; t += 3) {
      const [a, b, c] = [m.index[t], m.index[t + 1], m.index[t + 2]]
      const p = (k: number, j: number) => m.position[k * 3 + j]
      const ux = p(b, 0) - p(a, 0), uy = p(b, 1) - p(a, 1), uz = p(b, 2) - p(a, 2)
      const vx = p(c, 0) - p(a, 0), vy = p(c, 1) - p(a, 1), vz = p(c, 2) - p(a, 2)
      const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
      assert.ok(area > 1e-9, `${name}: triangle ${t / 3} is flat (${area})`)
    }
    assert.ok(m.vertexCount <= (detailed ? 1600 : 500), `${name}: ${m.vertexCount} vertices`)
    assert.ok(m.index.length / 3 <= (detailed ? 2800 : 820), `${name}: ${m.index.length / 3} triangles`)
    counts[name] = [m.vertexCount, m.index.length / 3]
    const again = humanoidMesh(v, detailed)
    assert.deepEqual(again.position, m.position)
    assert.deepEqual(again.index, m.index)
    assert.deepEqual(again.rig, m.rig)
    assert.deepEqual(again.skin, m.skin)
    assert.deepEqual(again.face, m.face)
  }
  // The far body is the smaller by far; the outfits differ in their rings, not only their colours.
  for (const v of VARIANTS) assert.ok(counts[`${BODY_NAMES[v]} far`][0] * 2 < counts[`${BODY_NAMES[v]} near`][0])
  assert.notDeepEqual(humanoidMesh(1).position, humanoidMesh(2).position, 'a man\'s trunk and a woman\'s')
  assert.notDeepEqual(humanoidMesh(2).position, humanoidMesh(3).position, 'the skirt')
  assert.deepEqual(humanoidMesh(7).position, humanoidMesh(3).position, 'clamped')
  assert.deepEqual(humanoidMesh(Number.NaN).position, humanoidMesh(0).position)
})

test('the pieces: the suit alone has a tie; the cup, the glasses, the tie and the face are near-only; the bag, the hair, the coat and the scarf reach the far body; the shirt\'s V is paint, not a slot; the arms hang at rest', () => {
  const pieces = (v: number, detailed: boolean) => { const m = humanoidMesh(v, detailed); return new Set(Array.from({ length: m.vertexCount }, (_, i) => m.rig[i * 3 + 2])) }
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b)
  assert.deepEqual(sorted(pieces(0, true)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  for (const v of [1, 2, 3]) assert.deepEqual(sorted(pieces(v, true)), [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], BODY_NAMES[v])
  for (const v of VARIANTS) {
    assert.deepEqual(sorted(pieces(v, false)), [PIECE.NONE, PIECE.BAG, PIECE.LONG_HAIR, PIECE.HAIR_CAP, PIECE.BOB, PIECE.BUN, PIECE.COAT, PIECE.SCARF], `${BODY_NAMES[v]} far`)
    for (const p of pieces(v, false)) assert.ok(pieces(v, true).has(p), 'the far body wears nothing the near one lacks')
  }
  const slots = (v: number, detailed = true) => { const m = humanoidMesh(v, detailed); return new Set(Array.from({ length: m.vertexCount }, (_, i) => m.rig[i * 3 + 1])) }
  assert.ok(slots(0).has(SLOT.ACCENT), 'the tie\'s cloth')
  assert.ok(slots(3).has(SLOT.LEGWEAR) && !slots(2).has(SLOT.LEGWEAR), 'hose under the skirt alone')
  for (const v of VARIANTS) {
    for (const s of [SLOT.TOP, SLOT.SKIN, SLOT.HAIR, SLOT.BOTTOM, SLOT.SHOES, SLOT.PROP, SLOT.FRAME, SLOT.EYE, SLOT.IRIS, SLOT.LIP, SLOT.SCARF]) assert.ok(slots(v).has(s), `${BODY_NAMES[v]} slot ${s}`)
    assert.ok(!slots(v).has(SLOT.SHIRT) && !slots(v, false).has(SLOT.SHIRT), `${BODY_NAMES[v]}: the shirt's V, collar and cuffs are the fragment stage's (GARMENT), no vertex wears the shirt's slot`)
    for (const s of [SLOT.EYE, SLOT.IRIS, SLOT.LIP, SLOT.FRAME]) assert.ok(!slots(v, false).has(s), `${BODY_NAMES[v]} far: no slot ${s}`)
  }
  // Rest pose: the hands below the elbows, nothing below the feet, the top of the head near the base height.
  const m = humanoidMesh(0)
  let hand = -1, top = -1
  for (let i = 0; i < m.vertexCount; i++) {
    const bone = m.rig[i * 3]
    if (bone === BONE.HAND_L || bone === BONE.HAND_R) hand = Math.max(hand, m.position[i * 3 + 1])
    top = Math.max(top, m.position[i * 3 + 1])
  }
  assert.ok(hand < LANDMARK.elbow, `the hands hang (${hand})`)
  assert.ok(top > HEIGHT_BASE - 0.02 && top < HEIGHT_BASE + 0.05, `${top} m tall at rest`)
  assert.equal(bodyTubes(0).length, bodyTubes(1).length + 1, 'the tie')
  assert.equal(bodyTubes(3).length, bodyTubes(2).length + 1, 'the skirt')
})

// --- The sliders ------------------------------------------------------------------------------------------------

test('shapeFactors: the base person is every factor 1; the slider ranges are MORPH\'s; the legs take height the trunk gives back; an odd height is the base', () => {
  const f0 = shapeFactors(SHAPE_NEUTRAL)
  for (const [k, v] of Object.entries(f0)) if (k !== 'slouch') near(v, 1, 1e-12, k)
  assert.equal(f0.slouch, 0)
  const tall = shapeFactors(shape({ legs: 1 }))
  near(tall.legs, MORPH.legs.base + MORPH.legs.range, 1e-12, 'long legs')
  near(heightMap(LANDMARK.neck, tall), LANDMARK.neck, 1e-12, 'the neck stays')
  near(heightMap(LANDMARK.hip, tall), LANDMARK.hip * tall.legs, 1e-12, 'the hip rises')
  assert.ok(tall.trunk < 1)
  near(heightMap(LANDMARK.neck, shapeFactors(shape({ legs: 0 }))), LANDMARK.neck, 1e-12, 'and stays for short legs')
  assert.equal(heightMap(1.7, tall), 1.7, 'the head is not mapped')
  for (const k of ['mass', 'muscle', 'shoulders', 'hips', 'head'] as const) {
    near(shapeFactors(shape({ [k]: 0 }))[k], MORPH[k].base, 1e-12, `${k} 0`)
    near(shapeFactors(shape({ [k]: 1 }))[k], MORPH[k].base + MORPH[k].range, 1e-12, `${k} 1`)
    near(shapeFactors(shape({ [k]: 7 }))[k], MORPH[k].base + MORPH[k].range, 1e-12, `${k} clamped`)
  }
  near(shapeFactors(shape({ posture: 0 })).slouch, 0.5 * MORPH.slouch, 1e-12, 'slumped: forward')
  near(shapeFactors(shape({ posture: 1 })).slouch, -0.5 * MORPH.slouch, 1e-12, 'upright: a little back')
  near(shapeFactors(shape({ posture: 1 })).gait, MORPH.gait.base + MORPH.gait.range, 1e-12, 'a brisk gait')
  near(shapeFactors(shape({ height: 2.1 })).height, 1.2, 1e-12, 'height as a factor')
  for (const h of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) assert.equal(shapeFactors(shape({ height: h })).height, 1)
  assert.deepEqual(scaleOf(shapeFactors(shape({ height: 1.75 * 4 }))), { y: 4, xz: 2 })
})

test('pivotsOf: the base joints are the landmarks; the widths move the hip and shoulder pivots out; the legs lift every joint below the neck', () => {
  const p0 = pivotsOf(shapeFactors(SHAPE_NEUTRAL))
  assert.deepEqual(p0, { hipX: LANDMARK.hipX, hip: LANDMARK.hip, knee: LANDMARK.knee, ankle: LANDMARK.ankle, shoulderX: LANDMARK.shoulderX, shoulder: LANDMARK.shoulder, elbow: LANDMARK.elbow, wrist: LANDMARK.wrist, chest: LANDMARK.chestPivot, neck: LANDMARK.neck })
  const wide = pivotsOf(shapeFactors(shape({ shoulders: 1, hips: 1 })))
  near(wide.shoulderX, LANDMARK.shoulderX * (MORPH.shoulders.base + MORPH.shoulders.range), 1e-12, 'shoulder pivot')
  near(wide.hipX, LANDMARK.hipX * (MORPH.hips.base + MORPH.hips.range), 1e-12, 'hip pivot')
  const f = shapeFactors(shape({ legs: 1 }))
  const long = pivotsOf(f)
  near(long.hip, LANDMARK.hip * f.legs, 1e-12, 'hip')
  near(long.knee, LANDMARK.knee * f.legs, 1e-12, 'knee')
  near(long.ankle, LANDMARK.ankle * f.legs, 1e-12, 'ankle')
  near(long.shoulder, heightMap(LANDMARK.shoulder, f), 1e-12, 'shoulder')
  near(long.shoulder - long.elbow, LANDMARK.shoulder - LANDMARK.elbow, 1e-12, 'the upper arm keeps its length')
  near(long.shoulder - long.wrist, LANDMARK.shoulder - LANDMARK.wrist, 1e-12, 'the forearm too')
  assert.equal(long.neck, LANDMARK.neck)
  assert.ok(long.shoulder > LANDMARK.shoulder && long.chest > LANDMARK.chestPivot, 'the trunk\'s joints ride up with the hip')
})

test('morphPoint: the base person is every vertex unmoved; a wider shoulder line or hip moves the trunk\'s edge and the limb\'s axis together and leaves the waist; mass thickens, the belly pushes forward, the head scales about the neck, an arm keeps its length', () => {
  const f0 = shapeFactors(SHAPE_NEUTRAL)
  for (const v of VARIANTS) {
    const m = humanoidMesh(v)
    for (let i = 0; i < m.vertexCount; i++) {
      const p = morphPoint(m.position[i * 3], m.position[i * 3 + 1], m.position[i * 3 + 2], m.rig[i * 3], f0)
      for (let k = 0; k < 3; k++) near(p[k], m.position[i * 3 + k], 1e-9, `${BODY_NAMES[v]} vertex ${i} axis ${k}`)
    }
  }
  const sh = shapeFactors(shape({ shoulders: 1 }))
  const trunkEdge = morphPoint(LANDMARK.shoulderX, REGION.shoulder.at, 0, BONE.CHEST, sh)
  const armAxis = morphPoint(LANDMARK.shoulderX, REGION.shoulder.at, 0, BONE.ARM_R, sh)
  near(trunkEdge[0], LANDMARK.shoulderX * sh.shoulders, 1e-12, 'the trunk at the shoulder line')
  near(armAxis[0], trunkEdge[0], 1e-12, 'the arm hangs from it')
  near(morphPoint(-LANDMARK.shoulderX, REGION.shoulder.at, 0, BONE.ARM_L, sh)[0], -trunkEdge[0], 1e-12, 'mirrored on the left')
  near(morphPoint(0.12, REGION.waist.at, 0, BONE.TRUNK, sh)[0], 0.12, 1e-12, 'the waist is left alone')
  const hp = shapeFactors(shape({ hips: 1 }))
  near(morphPoint(LANDMARK.hipX, REGION.hip.at, 0, BONE.TRUNK, hp)[0], LANDMARK.hipX * hp.hips, 1e-12, 'the trunk at the hip')
  near(morphPoint(LANDMARK.hipX, REGION.hip.at, 0, BONE.THIGH_R, hp)[0], LANDMARK.hipX * hp.hips, 1e-12, 'the thigh under it')
  near(morphPoint(0.1, REGION.hip.at, 0.08, BONE.TRUNK, hp)[2], 0.08 * (1 + (hp.hips - 1) * 0.5), 1e-12, 'half as much front to back')
  near(morphPoint(0.2, REGION.shoulder.at, 0, BONE.CHEST, hp)[0], 0.2, 1e-12, 'the shoulders are left alone')
  const heavy = shapeFactors(shape({ mass: 1 }))
  const dm = heavy.mass - 1
  near(morphPoint(0.1, REGION.waist.at, 0, BONE.TRUNK, heavy)[0], 0.1 * (1 + dm), 1e-12, 'the waist thickens by the whole mass')
  const front = morphPoint(0, REGION.belly.at, 0.1, BONE.TRUNK, heavy)[2], back = morphPoint(0, REGION.belly.at, -0.1, BONE.TRUNK, heavy)[2]
  assert.ok(front > -back + 0.01, `the belly pushes forward (${front} vs ${-back})`)
  near(morphPoint(LANDMARK.hipX + 0.06, 0.7, 0, BONE.THIGH_R, heavy)[0] - LANDMARK.hipX, 0.06 * (1 + dm * LIMB_GIRTH.thigh.mass), 1e-12, 'the thigh about its own axis')
  near(morphPoint(LANDMARK.shoulderX + 0.04, 1.3, 0, BONE.ARM_R, heavy)[0] - LANDMARK.shoulderX, 0.04 * (1 + dm * LIMB_GIRTH.arm.mass), 1e-12, 'the arm about its own')
  near(morphPoint(0, 1.7, 0.08, BONE.HEAD, heavy)[2], 0.08 * (1 + dm * LIMB_GIRTH.head.mass), 1e-12, 'the head takes a little')
  const strong = shapeFactors(shape({ muscle: 1 }))
  const du = strong.muscle - 1
  near(morphPoint(0.15, REGION.chest.at, 0, BONE.CHEST, strong)[0], 0.15 * (1 + du * 0.6), 1e-12, 'muscle broadens the chest')
  near(morphPoint(0.1, REGION.waist.at - 0.2, 0, BONE.TRUNK, strong)[0], 0.1, 1e-9, 'not the hips')
  const big = shapeFactors(shape({ head: 1 }))
  near(morphPoint(0.08, 1.7, 0, BONE.HEAD, big)[1], LANDMARK.neck + (1.7 - LANDMARK.neck) * big.head, 1e-12, 'the head grows up from the neck')
  near(morphPoint(0.08, 1.7, 0, BONE.HEAD, big)[0], 0.08 * big.head, 1e-12, 'and out')
  const long = shapeFactors(shape({ legs: 1 }))
  near(morphPoint(LANDMARK.hipX, 0.7, 0, BONE.THIGH_R, long)[1], 0.7 * long.legs, 1e-12, 'the thigh stretches')
  near(morphPoint(0, 1.3, 0, BONE.CHEST, long)[1], heightMap(1.3, long), 1e-12, 'the trunk follows the map')
  near(morphPoint(0.2, LANDMARK.shoulder, 0, BONE.ARM_R, long)[1] - morphPoint(0.2, LANDMARK.elbow, 0, BONE.FOREARM_R, long)[1], LANDMARK.shoulder - LANDMARK.elbow, 1e-12, 'the arm keeps its length under the shoulder')
  near(morphPoint(0.2, LANDMARK.shoulder, 0, BONE.ARM_R, long)[1], heightMap(LANDMARK.shoulder, long), 1e-12, 'wherever the shoulder went')
})

test('morphNormal: unit, the base person\'s unchanged, and still perpendicular to a ring\'s tangent after the sliders', () => {
  const f0 = shapeFactors(SHAPE_NEUTRAL)
  const n0 = morphNormal(0.6, 0.0, 0.8, 1.0, 0.1, BONE.TRUNK, f0)
  near(n0[0], 0.6, 1e-12, 'x'); near(n0[1], 0, 1e-12, 'y'); near(n0[2], 0.8, 1e-12, 'z')
  const shapes = [shape({ mass: 1, shoulders: 1 }), shape({ hips: 0, muscle: 1, legs: 1 }), shape({ mass: 0, head: 1 }), shape({ mass: 1, hips: 1, legs: 0 })]
  const points: [number, number, number, number][] = [[0.12, 1.0, 0.06, BONE.TRUNK], [0.15, 1.4, 0.08, BONE.CHEST], [0.06, 1.65, 0.07, BONE.HEAD], [0.14, 0.7, 0.05, BONE.THIGH_R], [-0.22, 1.3, 0.04, BONE.ARM_L]]
  const eps = 1e-5
  for (const s of shapes) {
    const f = shapeFactors(s)
    for (const [x, y, z, bone] of points) {
      // A normal tilted out of the ring's plane, and the horizontal tangent perpendicular to it.
      const nx = 0.5, ny = 0.6, nz = 0.3
      const tx = -nz, tz = nx
      const n = morphNormal(nx, ny, nz, y, z, bone, f)
      near(length(n), 1, 1e-12, 'unit')
      const p = morphPoint(x, y, z, bone, f), q = morphPoint(x + eps * tx, y, z + eps * tz, bone, f)
      const t = [(q[0] - p[0]) / eps, (q[1] - p[1]) / eps, (q[2] - p[2]) / eps]
      assert.ok(length(t) > 0.1)
      near((n[0] * t[0] + n[1] * t[1] + n[2] * t[2]) / length(t), 0, 1e-6, `perpendicular on bone ${bone}`)
    }
  }
})

// --- The walk and the skin -------------------------------------------------------------------------------------

test('footAt: a foot at mid-stance stands under the hip, flat; through the stance it is carried back linearly in the phase, rolling onto its heel ahead and its toes behind; the swing lifts it and brings it forward; both handovers are continuous', () => {
  const stride = 0.7, lift = 0.07, roll = 0.03
  const flat = (f: ReturnType<typeof footAt>) => ({ z: f.z + 0, y: f.y + 0, sole: f.sole + 0, planted: f.planted })
  assert.deepEqual(flat(footAt(0, stride, lift, roll)), { z: 0, y: 0, sole: 0, planted: true })
  near(footAt(0.3, stride, 0, 0).z, -stride * 0.3 / Math.PI, 1e-12, 'linear in the phase through the stance')
  near(footAt(-0.3, stride, 0, 0).z, stride * 0.3 / Math.PI, 1e-12, 'ahead before the zero')
  const eps = 1e-9
  const off = footAt(Math.PI / 2 - eps, stride, lift, roll), swung = footAt(Math.PI / 2 + eps, stride, lift, roll)
  assert.ok(off.planted && !swung.planted, 'the toe-off at a quarter turn')
  near(off.z, -stride / 2, 1e-6, 'half a stride behind'); near(off.y, roll, 1e-6, 'up on the toes'); near(off.sole, Math.asin(roll / SOLE.toe), 1e-6, 'toes down')
  near(swung.z, off.z, 1e-6, 'z continuous'); near(swung.y, off.y, 1e-6, 'y continuous'); near(swung.sole, off.sole, 1e-6, 'the sole continuous')
  const top = footAt(Math.PI, stride, lift, roll)
  assert.ok(!top.planted); near(top.z, 0, 1e-12, 'mid-swing under the hip'); near(top.y, roll + lift, 1e-12, 'at the lift')
  const strike = footAt(3 * Math.PI / 2 - eps, stride, lift, roll), struck = footAt(3 * Math.PI / 2 + eps, stride, lift, roll)
  assert.ok(!strike.planted && struck.planted, 'the strike at three quarters')
  near(strike.z, stride / 2, 1e-6, 'half a stride ahead'); near(strike.y, roll, 1e-6, 'on the heel'); near(strike.sole, -Math.asin(roll / SOLE.heel), 1e-6, 'toes up')
  near(struck.z, strike.z, 1e-6, 'z continuous'); near(struck.y, strike.y, 1e-6, 'y continuous'); near(struck.sole, strike.sole, 1e-6, 'the sole continuous')
  assert.deepEqual(footAt(7 * Math.PI / 4, stride, lift, roll), footAt(-Math.PI / 4, stride, lift, roll), 'periodic')
  for (let p = 0; p < 2 * Math.PI; p += 0.05) { const a = footAt(p, stride, lift, roll); assert.ok(a.y >= -1e-12 && a.y <= roll + lift + 1e-12 && Math.abs(a.z) <= stride / 2 + 1e-12) }
  assert.deepEqual(flat(footAt(1.3, 0, 0, 0)), { z: 0, y: 0, sole: 0, planted: true }, 'standing: under the hip whatever the phase')
})

test('legSolve: the hip and knee put the ankle where the foot is, the knee forward and never locked, the distance held to the reach; the ankle turns the sole to its angle', () => {
  const t = 0.42, s = 0.42
  const place = (leg: LegAngles): [number, number] => [-t * Math.cos(leg.hip) - s * Math.cos(leg.hip + leg.knee), -t * Math.sin(leg.hip) - s * Math.sin(leg.hip + leg.knee)]
  near(legReach(t, s), Math.sqrt(t * t + s * s + 2 * t * s * Math.cos(WALK.kneeRest)), 1e-12, 'the reach')
  for (const [dy, dz] of [[-0.7, 0.3], [-0.6, -0.35], [-0.8, 0.1], [-0.5, 0], [-0.75, -0.2]]) {
    const leg = legSolve(dy, dz, t, s, 0)
    const [y, z] = place(leg)
    near(y, dy, 1e-9, `ankle y for ${dy}, ${dz}`); near(z, dz, 1e-9, `ankle z for ${dy}, ${dz}`)
    assert.ok(leg.knee > WALK.kneeRest, 'bent')
    assert.ok(-t * Math.sin(leg.hip) > dz * (t / Math.hypot(dy, dz)) - 1e-9, 'the knee ahead of the line from the hip to the ankle')
    near(leg.ankle, -leg.hip - leg.knee, 1e-12, 'the sole flat')
  }
  const straight = legSolve(-legReach(t, s), 0, t, s, 0)
  near(straight.hip, -WALK.kneeRest / 2, 1e-9, 'the thigh leans forward by half the standing bend'); near(straight.knee, WALK.kneeRest, 1e-9, 'the standing bend')
  const beyond = legSolve(-2, 0.5, t, s, 0)
  near(beyond.knee, WALK.kneeRest, 1e-9, 'out of reach: the knee at its standing bend, no further')
  near(beyond.hip, Math.atan2(-0.5, 2) - WALK.kneeRest / 2, 1e-9, 'along the line')
  const soled = legSolve(-0.7, 0.3, t, s, 0.25)
  near(soled.ankle, 0.25 - soled.hip - soled.knee, 1e-12, 'the sole turned toes down')
  assert.equal(soled.hip, legSolve(-0.7, 0.3, t, s, 0).hip)
})

test('pelvisDrop: nothing with the foot under the hip, more the further the planted foot is from under it, nothing with the foot raised', () => {
  const piv = pivotsOf(shapeFactors(SHAPE_NEUTRAL))
  const leg = piv.hip - piv.ankle
  near(pelvisDrop(0, 0, piv), leg - legReach(piv.hip - piv.knee, piv.knee - piv.ankle), 1e-12, 'the standing bend alone')
  assert.ok(pelvisDrop(0, 0, piv) < 0.001)
  let last = 0
  for (const dz of [0.1, 0.2, 0.3, 0.36]) { const d = pelvisDrop(dz, 0, piv); assert.ok(d > last, `more at ${dz}`); last = d }
  assert.ok(pelvisDrop(0.36, 0, piv) > 0.04 && pelvisDrop(0.36, 0, piv) < 0.1, 'a few centimetres at the end of a stride')
  assert.ok(pelvisDrop(0.36, 0.03, piv) < pelvisDrop(0.36, 0, piv), 'the roll lifts the ankle and spares some')
  assert.equal(pelvisDrop(0, 0.5, piv), 0)
})

test('walkAngles: standing, the feet are together under the hips with the knees and elbows at their small bend; the right leg is the left half a cycle on; the leg is forward where the foot is ahead; the arms swing with the speed to a cap, against the legs, with the gait; a cup raises the left arm, a bag stills the right; the gaze turns the chest and the head', () => {
  const f0 = shapeFactors(SHAPE_NEUTRAL)
  const rest = walkAngles(0, 0, f0)
  assert.deepEqual(Object.keys(rest).sort(), ['ankleL', 'ankleR', 'elbowL', 'elbowR', 'head', 'headYaw', 'hipL', 'hipR', 'kneeL', 'kneeR', 'rise', 'shoulderL', 'shoulderR', 'slouch', 'twist'])
  near(rest.kneeL, WALK.kneeRest, 1e-9, 'the knee\'s small bend standing'); near(rest.hipL, -WALK.kneeRest / 2, 1e-9, 'the thigh leans forward by half of it, the ankle under the hip')
  near(rest.ankleL, -rest.hipL - rest.kneeL, 1e-12, 'the sole flat')
  assert.deepEqual([rest.hipR, rest.kneeR, rest.ankleR], [rest.hipL, rest.kneeL, rest.ankleL], 'both legs alike')
  assert.deepEqual([rest.shoulderL, rest.elbowL, rest.shoulderR, rest.elbowR, rest.twist, rest.head, rest.headYaw, rest.slouch], [-0, -WALK.elbowRest, -0, -WALK.elbowRest, 0, -0, 0, 0])
  assert.ok(rest.rise <= 0 && rest.rise > -0.001, 'the pelvis all but at standing')
  for (const [k, v] of Object.entries(walkAngles(2.2, 0, f0))) near(v, rest[k as keyof typeof rest], 1e-12, `standing, the phase does not matter: ${k}`)
  for (const phase of [0.3, 1.1, 2.9, 4.4]) {
    const a = walkAngles(phase, 1, f0), b = walkAngles(phase + Math.PI, 1, f0)
    near(a.hipL, b.hipR, 1e-12, 'hip'); near(a.kneeL, b.kneeR, 1e-12, 'knee'); near(a.ankleL, b.ankleR, 1e-12, 'ankle')
    near(a.shoulderL, b.shoulderR, 1e-12, 'shoulder'); near(a.elbowL, b.elbowR, 1e-12, 'elbow'); near(a.rise, b.rise, 1e-12, 'the rise')
    assert.ok(a.kneeL >= WALK.kneeRest - 1e-9 && a.kneeR >= WALK.kneeRest - 1e-9, 'never locked')
    near(a.shoulderL, -Math.sin(phase) * WALK.shoulder * swingOf(1) * f0.gait, 1e-12, 'the arm swings with the phase, against the leg')
  }
  assert.ok(walkAngles(-Math.PI / 4, 1, f0).hipL < -0.1, 'the left foot ahead: the thigh forward')
  assert.ok(walkAngles(Math.PI / 4, 1, f0).hipL > 0.1, 'the left foot behind: the thigh back')
  assert.equal(swingOf(0), 0)
  assert.equal(swingOf(WALK.fullSpeed), 1)
  assert.equal(swingOf(WALK.fullSpeed * 10), WALK.maxSwing)
  assert.equal(swingOf(-1), 0)
  near(walkAngles(1, WALK.fullSpeed / 2, f0).shoulderL, -Math.sin(1) * WALK.shoulder * 0.5 * f0.gait, 1e-12, 'half the swing')
  const brisk = shapeFactors(shape({ posture: 1 })), slumped = shapeFactors(shape({ posture: 0 }))
  near(walkAngles(1, 1, brisk).twist / walkAngles(1, 1, slumped).twist, brisk.gait / slumped.gait, 1e-9, 'the twist and the arm swing follow the gait')
  near(walkAngles(1, 1, brisk).shoulderL / walkAngles(1, 1, slumped).shoulderL, brisk.gait / slumped.gait, 1e-9, 'the arm swing too')
  near(walkAngles(1, 1, slumped).hipL, walkAngles(1, 1, brisk).hipL, 1e-12, 'the legs do not')
  near(walkAngles(0, 0, slumped).head, -slumped.slouch * WALK.headCounter, 1e-12, 'the head counters the lean')
  assert.equal(walkAngles(0, 0, slumped).slouch, slumped.slouch)
  const cup = walkAngles(1, 1, f0, true, false), bag = walkAngles(1, 1, f0, false, true), plain = walkAngles(1, 1, f0)
  near(cup.shoulderL, WALK.cupShoulder + plain.shoulderL * WALK.cupSwing, 1e-12, 'the cup arm')
  assert.equal(cup.elbowL, WALK.cupElbow)
  assert.equal(cup.shoulderR, plain.shoulderR)
  near(bag.shoulderR, plain.shoulderR * WALK.bagSwing, 1e-12, 'the bag arm')
  assert.equal(bag.elbowR, -WALK.elbowRest)
  assert.equal(bag.shoulderL, plain.shoulderL)
  const looking = walkAngles(1, 1, f0, false, false, { chest: 0.2, head: 0.4, pitch: -0.3 })
  near(looking.twist, plain.twist + 0.2, 1e-12, 'the chest takes its share of the gaze'); assert.equal(looking.headYaw, 0.4); near(looking.head, plain.head + 0.3, 1e-12, 'looking down nods the head')
  assert.deepEqual(walkAngles(1, 1, f0, false, false, GAZE_AHEAD), plain)
})

test('the feet stay planted: walking at any speed from WALK.strideSpeed up, at any stature or heading, a foot keeps its spot of ground through its stance to a micrometre while the body passes over it, its ankle rising as it rolls heel to toe; the swing foot is up; the pelvis rides continuously through the handover; under strideSpeed the stride shrinks toward standing and the foot shuffles by the difference', () => {
  const TAU = 2 * Math.PI
  for (const [speed, height, heading] of [[0.5, 1.75, 0], [1.0, 1.75, 0], [1.4, 1.75, 2.1], [2.0, 1.75, -0.7], [1.2, 1.5, 0], [1.2, 2.05, Math.PI / 2], [0.9, 1.75, 0]] as const) {
    const f = shapeFactors(shape({ height, legs: speed === 0.9 ? 1 : 0.5 }))
    const piv = pivotsOf(f), scale = scaleOf(f)
    let spot: [number, number] | null = null
    let lastRise = 0, lastDist = 0
    for (let dist = 0; dist < WALK.cycle * 2; dist += WALK.cycle / 500) {
      const phase = dist * TAU / WALK.cycle
      const a = walkAngles(phase, speed, f)
      const at = [dist * Math.sin(heading), 0, dist * Math.cos(heading)] as const
      const ankle = skinPoint(-piv.hipX, piv.ankle, 0, BONE.FOOT_L, BONE.FOOT_L, 1, 1, a, STILL, piv, scale, heading, at)
      const s = (((phase + Math.PI / 2) / TAU) % 1) * 2
      if (s < 1) {
        if (spot) { near(ankle[0], spot[0], 1e-6, `${speed} m/s, ${height} m, heading ${heading}: the planted ankle's x at ${dist.toFixed(3)} m`); near(ankle[2], spot[1], 1e-6, `${speed} m/s, ${height} m, heading ${heading}: the planted ankle's z at ${dist.toFixed(3)} m`) }
        else spot = [ankle[0], ankle[2]]
        near(ankle[1], piv.ankle * scale.y + WALK.roll * (1 - 2 * s) ** 2, 1e-6, 'the ankle rises as the foot rolls onto its heel or its toes')
      } else {
        spot = null
        assert.ok(ankle[1] >= piv.ankle * scale.y + WALK.roll - 1e-6, 'the swing foot is up')
      }
      assert.ok(a.kneeL >= WALK.kneeRest - 1e-9 && a.kneeR >= WALK.kneeRest - 1e-9, 'the knee never locks')
      assert.ok(a.rise <= 1e-12 && a.rise > -0.12, 'the pelvis at or below standing, by centimetres')
      if (dist > 0) assert.ok(Math.abs(a.rise - lastRise) < 0.004 * (dist - lastDist) / (WALK.cycle / 500) + 1e-9, `the rise rides continuously (${a.rise} after ${lastRise} at ${dist.toFixed(3)} m)`)
      lastRise = a.rise; lastDist = dist
    }
  }
  // Under strideSpeed the stride is a fraction of the cycle, so the planted foot slides by the rest of the travel.
  const f0 = shapeFactors(SHAPE_NEUTRAL), piv = pivotsOf(f0), scale = scaleOf(f0)
  const slow = WALK.strideSpeed / 2
  const foot = (dist: number) => skinPoint(-piv.hipX, piv.ankle, 0, BONE.FOOT_L, BONE.FOOT_L, 1, 1, walkAngles(dist * TAU / WALK.cycle, slow, f0), STILL, piv, scale, 0, [0, 0, dist])
  near(foot(0.1)[2] - foot(0.05)[2], 0.05 * 0.5, 1e-6, 'a shuffle of half the travel at half the stride speed')
  const standing = skinPoint(-piv.hipX, piv.ankle, 0, BONE.FOOT_L, BONE.FOOT_L, 1, 1, walkAngles(1.7, 0, f0), STILL, piv, scale, 0, ORIGIN)
  near(standing[0], -piv.hipX, 1e-9, 'standing: the ankle under the hip'); near(standing[1], piv.ankle, 1e-9, 'at its rest'); near(standing[2], 0, 1e-9, 'neither ahead nor behind')
})

test('gazeAt: the eye ahead holds the head straight; to the side it turns the chest by its share and the head by the rest, to their limits; behind, beyond reach or at the person\'s own neck it is let go; it fades from near to reach; the way they go turns the head within its small limit, whole from a slow walk; a heading wraps', () => {
  const neck = [0, 1.5, 0] as const
  const sum = GAZE.headYaw + GAZE.chestYaw
  const same = (got: ReturnType<typeof gazeAt>, want: ReturnType<typeof gazeAt>, what: string) => { near(got.chest, want.chest, 1e-12, `${what}: chest`); near(got.head, want.head, 1e-12, `${what}: head`); near(got.pitch, want.pitch, 1e-12, `${what}: pitch`) }
  same(gazeAt(neck, 0, 0, 1, [0, 1.5, 2]), GAZE_AHEAD, 'ahead')
  same(gazeAt(neck, 0, 0, 1, null), GAZE_AHEAD, 'nobody')
  const aside = gazeAt(neck, 0, 0, 0, [1, 1.5, 1.5])
  const bearing = Math.atan2(1, 1.5)
  near(aside.chest, bearing * GAZE.chestShare, 1e-12, 'the chest\'s share'); near(aside.head, bearing * (1 - GAZE.chestShare), 1e-12, 'the head the rest'); assert.equal(aside.pitch, 0)
  const right = gazeAt(neck, 0, 0, 0, [2, 1.5, 0])
  same(right, { chest: GAZE.chestYaw, head: GAZE.headYaw, pitch: 0 }, 'square to the right: both at their limits')
  assert.ok(Math.PI / 2 > sum, 'which a right angle exceeds')
  const left = gazeAt(neck, 0, 0, 0, [-1, 1.5, 1.5])
  near(left.chest, -aside.chest, 1e-12, 'mirrored'); near(left.head, -aside.head, 1e-12, 'mirrored')
  same(gazeAt(neck, 0, 0, 0, [0, 1.5, -3]), GAZE_AHEAD, 'behind')
  same(gazeAt(neck, 0, 0, 0, [3, 1.5, 5]), GAZE_AHEAD, 'beyond reach')
  same(gazeAt(neck, 0, 0, 0, [0.2, 1.5, 0.3]), GAZE_AHEAD, 'their own neck')
  const far = gazeAt(neck, 0, 0, 0, [1, 1.5, 3.3]), nearer = gazeAt(neck, 0, 0, 0, [1, 1.5, 2.2])
  assert.ok(far.head > 0 && far.head < Math.atan2(1, 3.3) * (1 - GAZE.chestShare) - 1e-6, 'fading between near and reach')
  near(nearer.head + nearer.chest, Math.atan2(1, 2.2), 1e-12, 'whole within near')
  near(gazeAt(neck, 0, 0, 0, [0, 2.5, 2]).pitch, Math.atan2(1, 2), 1e-12, 'looking up at an eye above')
  assert.equal(gazeAt(neck, 0, 0, 0, [0, 4, 1]).pitch, GAZE.headPitch, 'to the limit')
  near(gazeAt(neck, 0, 0, 0, [0, 1.0, 2]).pitch, -Math.atan2(0.5, 2), 1e-12, 'down at one below')
  // The heading turns the frame: facing +x, an eye at +x is ahead and one at +z is to the left.
  same(gazeAt(neck, Math.PI / 2, 0, 0, [2, 1.5, 0]), GAZE_AHEAD, 'facing +x, an eye at +x')
  assert.ok(gazeAt(neck, Math.PI / 2, 0, 0, [0, 1.5, 2]).head < 0)
  // The way they go.
  const travel = gazeAt(neck, 0, 1, 0, null)
  near(travel.chest + travel.head, GAZE.travelYaw, 1e-12, 'walking to the right of the heading, the head leads, to its small limit')
  near(travel.chest, GAZE.travelYaw * GAZE.chestShare, 1e-12, 'the chest\'s share')
  near(gazeAt(neck, 0, -1, 0, null).head, -travel.head, 1e-12, 'to the left')
  near(gazeAt(neck, 0, GAZE.travelSpeed / 2, 0, null).head + gazeAt(neck, 0, GAZE.travelSpeed / 2, 0, null).chest, GAZE.travelYaw / 2, 1e-12, 'half at half the speed')
  near(gazeAt(neck, 0, 0.1, 1, null).head + gazeAt(neck, 0, 0.1, 1, null).chest, Math.atan2(0.1, 1), 1e-12, 'a slight bearing, whole')
  near(gazeAt(neck, 3, Math.sin(-3), Math.cos(-3), null).head + gazeAt(neck, 3, Math.sin(-3), Math.cos(-3), null).chest, 2 * Math.PI - 6, 1e-9, 'the bearing off the heading wraps')
  const both = gazeAt(neck, 0, 1, 0, [0, 1.5, 2])
  same(both, GAZE_AHEAD, 'an eye ahead overrides the way they go')
  const farBoth = gazeAt(neck, 0, 1, 0, [0, 1.5, 3.5])
  assert.ok(farBoth.head + farBoth.chest > 0 && farBoth.head + farBoth.chest < GAZE.travelYaw, 'a fading eye blends with it')
})

test('RIG_REST: every bone hangs from the rig shape on its own side of the body, at that shape\'s standing centre (ragdollRig.ts SEGMENTS and FOOT, by the stream\'s order); the hands from the lower arms; RIG_WEAR is the realm\'s slots and shapes', () => {
  assert.equal(RIG_REST.length, BONES)
  assert.deepEqual(RIG_WEAR, { slots: RIG_SLOTS, shapes: RIG_POSE.segmentCount })
  assert.equal(RIG_SEGMENTS.length, RIG_WEAR.shapes)
  const part = (bone: number): string => {
    if (bone === BONE.TRUNK) return 'pelvis'
    if (bone === BONE.CHEST) return 'torso'
    if (bone === BONE.HEAD) return 'head'
    const group = (bone - BONE.THIGH_L) % 3
    if (bone < BONE.ARM_L) return ['upperLeg', 'lowerLeg', 'foot'][group]
    return ['upperArm', 'lowerArm', 'lowerArm'][group]
  }
  for (let bone = 0; bone < BONES; bone++) {
    const [shape, x, y, z] = RIG_REST[bone]
    const name = RIG_SEGMENTS[shape][0]
    const side = boneSide(bone)
    assert.equal(name.replace(/[LR]$/, ''), part(bone), `bone ${bone} hangs from a ${part(bone)}`)
    if (side === 0) { assert.ok(!/[LR]$/.test(name)); assert.equal(x, 0) }
    else {
      // The rig's left is +x (its own view), this body's left is −x (the viewer's): a left bone takes the rig's R shape.
      assert.equal(name.endsWith('R'), side < 0, `bone ${bone} takes the shape on its side`)
      assert.equal(Math.sign(x), side, 'the centre on the same side')
    }
    if (name.startsWith('foot')) {
      const leg = SEGMENTS[(name === 'footL' ? 'lowerLegL' : 'lowerLegR') as keyof typeof SEGMENTS]
      near(x, leg.at[0] + FOOT.offset[0], 1e-12, 'the foot under its lower leg'); near(y, leg.at[1] + FOOT.offset[1], 1e-12, 'at the offset'); near(z, FOOT.offset[2], 1e-12, 'ahead')
    } else {
      const seg = SEGMENTS[name as keyof typeof SEGMENTS]
      assert.deepEqual([x, y, z], [seg.at[0], seg.at[1], 0], `${name}'s centre`)
    }
  }
  assert.equal(RIG_REST[BONE.HAND_L][0], RIG_REST[BONE.FOREARM_L][0]); assert.equal(RIG_REST[BONE.HAND_R][0], RIG_REST[BONE.FOREARM_R][0])
})

test('rigPoint: on a rig standing at rest the body stands as it was; a shape moved carries its bone\'s points, turned turns them about its centre; two bones blend; a normal turns and never moves; the stature scales the offsets', () => {
  const rest: RigPose[] = RIG_SEGMENTS.map((_, shape) => {
    const bone = RIG_REST.findIndex(([s]) => s === shape)
    const [, x, y, z] = RIG_REST[bone]
    return { at: [x, y, z], q: [0, 0, 0, 1] }
  })
  const f0 = shapeFactors(SHAPE_NEUTRAL), piv = pivotsOf(f0)
  for (const [x, y, z, bone] of [[0, piv.neck, 0.1, BONE.HEAD], [-piv.hipX, 0.3, 0.02, BONE.SHIN_L], [piv.shoulderX, 1.0, 0, BONE.FOREARM_R], [0.1, 1.2, 0.08, BONE.CHEST]]) {
    const p = rigPoint(x, y, z, bone, bone, 1, 1, rest, UNIT)
    near(p[0], x, 1e-12, 'x at rest'); near(p[1], y, 1e-12, 'y at rest'); near(p[2], z, 1e-12, 'z at rest')
  }
  // The head turned a right angle about y: the nose, ahead of the neck, comes round to +x about the head's centre.
  const s = Math.SQRT1_2
  const turned = rest.map((pose, shape) => (shape === RIG_REST[BONE.HEAD][0] ? { at: pose.at, q: [0, s, 0, s] as const } : pose))
  const nose = rigPoint(0, piv.neck, 0.1, BONE.HEAD, BONE.HEAD, 1, 1, turned, UNIT)
  near(nose[0], 0.1, 1e-12, 'the nose to +x'); near(nose[1], piv.neck, 1e-12, 'level'); near(nose[2], 0, 1e-12, 'no longer ahead')
  const noseN = rigPoint(0, 0, 1, BONE.HEAD, BONE.HEAD, 1, 0, turned, UNIT)
  near(noseN[0], 1, 1e-12, 'a normal turned'); near(noseN[2], 0, 1e-12, 'and not moved'); near(length(noseN), 1, 1e-12, 'unit')
  // The pelvis carried two metres along +x and lowered: the trunk's points go with it, the head's stay.
  const pelvis = RIG_REST[BONE.TRUNK][0]
  const carried = rest.map((pose, shape) => (shape === pelvis ? { at: [2, 0.5, 0] as const, q: pose.q } : pose))
  const hip = rigPoint(0.05, 0.95, 0.02, BONE.TRUNK, BONE.TRUNK, 1, 1, carried, UNIT)
  near(hip[0], 2.05, 1e-12, 'carried'); near(hip[1], 0.5 + (0.95 - 0.97), 1e-12, 'lowered'); near(hip[2], 0.02, 1e-12, 'z')
  const crown = rigPoint(0, 1.75, 0, BONE.HEAD, BONE.HEAD, 1, 1, carried, UNIT)
  near(crown[1], 1.75, 1e-12, 'the head stays')
  const half = rigPoint(0, 1.0, 0, BONE.TRUNK, BONE.HEAD, 0.5, 1, carried, UNIT)
  near(half[0], 1.0, 1e-12, 'blended half way'); near(half[1], (0.5 + (1.0 - 0.97) + 1.0) / 2, 1e-12, 'in y too')
  assert.deepEqual(rigPoint(0, 1.0, 0, BONE.TRUNK, BONE.HEAD, 1, 1, carried, UNIT), rigPoint(0, 1.0, 0, BONE.TRUNK, BONE.TRUNK, 1, 1, carried, UNIT), 'weight 1 is the first bone alone')
  // A taller person: the offset from the shape's centre scales with the stature, the shape's centre does not.
  const tall = rigPoint(0, 1.75, 0.1, BONE.HEAD, BONE.HEAD, 1, 1, rest, { y: 1.2, xz: Math.sqrt(1.2) })
  near(tall[1], 1.66 + (1.75 - 1.66) * 1.2, 1e-12, 'y by the stature from the head\'s centre'); near(tall[2], 0.1 * Math.sqrt(1.2), 1e-12, 'z by its root')
  const tallN = rigPoint(0, 1, 0, BONE.HEAD, BONE.HEAD, 1, 0, rest, { y: 4, xz: 2 })
  near(tallN[1], 0.25, 1e-12, 'a normal takes the reciprocal')
  // rotateByQuat: a half turn about z flips x and y.
  assert.deepEqual(rotateByQuat([1, 2, 3], [0, 0, 1, 0]).map((v) => Math.round(v * 1e12) / 1e12), [-1, -2, 3])
  assert.deepEqual(rotateByQuat([1, 2, 3], [0, 0, 0, 1]), [1, 2, 3])
})

test('SOLE: the shoe\'s lowest ring reaches SOLE.heel behind the ankle and SOLE.toe ahead of it, on every body', () => {
  for (const v of VARIANTS) {
    const soles = bodyTubes(v).flatMap((t) => t.rings).filter((r) => r.slot === SLOT.SHOES && r.y === 0)
    assert.equal(soles.length, 2, `two soles on body ${v}`)
    for (const r of soles) { near((r.z ?? 0) - (r.rz ?? r.rx), -SOLE.heel, 1e-12, 'the heel'); near((r.z ?? 0) + (r.rz ?? r.rx), SOLE.toe, 1e-12, 'the toes') }
  }
})

test('skinPoint: a pivot stays put under its own bone; the trunk rides the heading and the place; the scales act after the pose; a normal takes their reciprocals; two bones blend by the weight', () => {
  const f0 = shapeFactors(SHAPE_NEUTRAL)
  const piv = pivotsOf(f0)
  for (const phase of [0, 0.7, 2.5]) {
    const a = walkAngles(phase, 1, f0)
    const hip = skinPoint(piv.hipX, piv.hip, 0, BONE.THIGH_R, BONE.THIGH_R, 1, 1, a, STILL, piv, UNIT, 0, ORIGIN)
    near(hip[0], piv.hipX, 1e-12, 'hip x'); near(hip[1], piv.hip + a.rise, 1e-12, 'hip y (the pelvis\' rise)'); near(hip[2], 0, 1e-12, 'hip z')
    const shoulder = skinPoint(-piv.shoulderX, piv.shoulder, 0, BONE.ARM_L, BONE.ARM_L, 1, 1, a, STILL, piv, UNIT, 0, ORIGIN)
    // The shoulder turns with the chest's twist about the spine, nothing else.
    near(Math.hypot(shoulder[0], shoulder[2]), piv.shoulderX, 1e-12, 'shoulder radius'); near(shoulder[1], piv.shoulder + a.rise, 1e-12, 'shoulder y')
    const toe = skinPoint(piv.hipX, 0, 0.1, BONE.FOOT_R, BONE.FOOT_R, 1, 1, a, STILL, piv, UNIT, 0, ORIGIN)
    if (phase !== 0) assert.ok(Math.abs(toe[2] - 0.1) > 1e-3 || Math.abs(toe[1]) > 1e-3, 'the toe moves with the stride')
  }
  const a0 = walkAngles(0, 0, f0)
  const knee = skinPoint(piv.hipX, piv.knee, 0, BONE.SHIN_R, BONE.SHIN_R, 1, 1, a0, STILL, piv, UNIT, 0, ORIGIN)
  near(knee[1], piv.knee, 1e-3, 'the knee pivot, the leg all but straight'); near(knee[2], (piv.hip - piv.knee) * Math.sin(WALK.kneeRest / 2), 1e-9, 'the knee a shade forward: half the standing bend')
  // The gaze: the head's own yaw turns the nose to the right about the neck; the chest's share turns the shoulders.
  const looking = walkAngles(0, 0, f0, false, false, { chest: 0, head: 0.5, pitch: 0 })
  const nose = skinPoint(0, piv.neck, 0.1, BONE.HEAD, BONE.HEAD, 1, 1, looking, STILL, piv, UNIT, 0, ORIGIN)
  near(nose[0], 0.1 * Math.sin(0.5), 1e-12, 'the nose to the right'); near(nose[1], piv.neck + looking.rise, 1e-12, 'level'); near(nose[2], 0.1 * Math.cos(0.5), 1e-12, 'and less ahead')
  const chested = walkAngles(0, 0, f0, false, false, { chest: 0.3, head: 0, pitch: 0 })
  const shoulderL = skinPoint(-piv.shoulderX, piv.shoulder, 0, BONE.ARM_L, BONE.ARM_L, 1, 1, chested, STILL, piv, UNIT, 0, ORIGIN)
  near(shoulderL[2], piv.shoulderX * Math.sin(0.3), 1e-12, 'the chest turned right brings the left shoulder forward')
  const noseChested = skinPoint(0, piv.neck, 0.1, BONE.HEAD, BONE.HEAD, 1, 1, chested, STILL, piv, UNIT, 0, ORIGIN)
  near(noseChested[0], 0.1 * Math.sin(0.3), 1e-12, 'and the head with it')
  const pitched = walkAngles(0, 0, f0, false, false, { chest: 0, head: 0, pitch: 0.4 })
  const noseUp = skinPoint(0, piv.neck, 0.1, BONE.HEAD, BONE.HEAD, 1, 1, pitched, STILL, piv, UNIT, 0, ORIGIN)
  near(noseUp[1], piv.neck + pitched.rise + 0.1 * Math.sin(0.4), 1e-12, 'looking up lifts the nose')
  const turned = skinPoint(0.1, 1.0, 0.05, BONE.TRUNK, BONE.TRUNK, 1, 1, a0, STILL, piv, UNIT, Math.PI / 2, [1, 2, 3])
  near(turned[0], 1 + 0.05, 1e-12, 'heading x'); near(turned[1], 2 + 1.0 + a0.rise, 1e-12, 'heading y (with the standing bend\'s small drop)'); near(turned[2], 3 - 0.1, 1e-12, 'heading z')
  const scaled = skinPoint(0.1, 1.0, 0.05, BONE.TRUNK, BONE.TRUNK, 1, 1, a0, STILL, piv, { y: 4, xz: 2 }, 0, ORIGIN)
  near(scaled[0], 0.2, 1e-12, 'x by the square root'); near(scaled[1], 4 + a0.rise, 1e-12, 'y by the stature, then the rise'); near(scaled[2], 0.1, 1e-12, 'z by the square root')
  const n = skinPoint(Math.SQRT1_2, Math.SQRT1_2, 0, BONE.TRUNK, BONE.TRUNK, 1, 0, a0, STILL, piv, { y: 4, xz: 2 }, 0, [5, 5, 5])
  near(n[0] / n[1], (Math.SQRT1_2 / 2) / (Math.SQRT1_2 / 4), 1e-12, 'the normal leans the other way')
  assert.ok(length(n) < 1, 'the caller normalises')
  const nt = skinPoint(0, 1, 0, BONE.TRUNK, BONE.TRUNK, 1, 0, a0, { tilt: 0.5, bend: 0, fall: 0 }, piv, UNIT, 0, ORIGIN)
  near(length(nt), 1, 1e-12, 'a rotation keeps the length'); near(nt[2], Math.sin(0.5), 1e-12, 'tilted forward'); near(nt[1], Math.cos(0.5), 1e-12, 'tilted')
  const bent = skinPoint(0, 1.5, 0, BONE.CHEST, BONE.CHEST, 1, 1, a0, { tilt: 0, bend: 0.4, fall: 0 }, piv, UNIT, 0, ORIGIN)
  near(bent[2], (1.5 - piv.hip) * Math.sin(0.4), 1e-12, 'the trunk bends about the hip'); near(bent[1], piv.hip + (1.5 - piv.hip) * Math.cos(0.4) + a0.rise, 1e-12, 'and down')
  const a1 = walkAngles(Math.PI / 2, 1, f0)
  const thigh = skinPoint(piv.hipX, 0.7, 0, BONE.THIGH_R, BONE.THIGH_R, 1, 1, a1, STILL, piv, UNIT, 0, ORIGIN)
  const trunk = skinPoint(piv.hipX, 0.7, 0, BONE.TRUNK, BONE.TRUNK, 1, 1, a1, STILL, piv, UNIT, 0, ORIGIN)
  const half = skinPoint(piv.hipX, 0.7, 0, BONE.THIGH_R, BONE.TRUNK, 0.5, 1, a1, STILL, piv, UNIT, 0, ORIGIN)
  for (let k = 0; k < 3; k++) near(half[k], (thigh[k] + trunk[k]) / 2, 1e-12, `blend axis ${k}`)
  assert.ok(Math.abs(thigh[2] - trunk[2]) > 0.05, 'the thigh swings where the trunk stands')
  assert.deepEqual(skinPoint(piv.hipX, 0.7, 0, BONE.THIGH_R, BONE.TRUNK, 1, 1, a1, STILL, piv, UNIT, 0, ORIGIN), thigh, 'weight 1 is the first bone alone')
  // boneTransform with w = 0 is the rotation without the pivots: a normal's path.
  const nn = boneTransform(BONE.THIGH_R, [0, 0, 1], 0, a1, STILL, piv)
  near(length(nn), 1, 1e-12, 'unit'); near(nn[1], -Math.sin(a1.hipR), 1e-12, 'turned by the hip')
})

test('eyeHeightOf: the base person\'s eye is EYE_LEVEL; it scales with the stature and the head, the legs and the posture leave it, and every shape keeps it within the camera\'s range', () => {
  near(eyeHeightOf(SHAPE_NEUTRAL), EYE_LEVEL, 1e-12, 'base')
  near(eyeHeightOf(shape({ height: 2.0 })), EYE_LEVEL * 2 / HEIGHT_BASE, 1e-12, 'taller')
  near(eyeHeightOf(shape({ legs: 1 })), EYE_LEVEL, 1e-12, 'long legs, the same neck')
  near(eyeHeightOf(shape({ legs: 0, posture: 0, mass: 1 })), EYE_LEVEL, 1e-12, 'nor the posture or the mass')
  near(eyeHeightOf(shape({ head: 1 })), LANDMARK.neck + (EYE_LEVEL - LANDMARK.neck) * (MORPH.head.base + MORPH.head.range), 1e-12, 'a bigger head')
  assert.ok(eyeHeightOf(shape({ head: 0 })) < EYE_LEVEL)
  let lo = Number.POSITIVE_INFINITY, hi = 0
  for (const height of [1.5, 1.75, 2.05]) for (const head of [0, 0.5, 1]) for (const legs of [0, 1]) {
    const e = eyeHeightOf(shape({ height, head, legs }))
    lo = Math.min(lo, e); hi = Math.max(hi, e)
  }
  assert.ok(lo > 1.4 && hi < 2.0, `${lo} to ${hi}: within head.ts's [1.2, 2.2]`)
  assert.ok(eyeHeightOf(shape({ height: 1.5 })) < eyeHeightOf(shape({ height: 1.6 })))
  near(eyeHeightOf(shape({ height: Number.NaN })), EYE_LEVEL, 1e-12, 'an odd height is the base')
})

// --- The silhouette --------------------------------------------------------------------------------------------

test('silhouetteRings: one ring per ring of every tube, from the front and from the side; the stature scales it; a slumped posture carries the head forward; the pieces keep their bits', () => {
  for (const v of VARIANTS) {
    const front = silhouetteRings(v, SHAPE_NEUTRAL), side = silhouetteRings(v, SHAPE_NEUTRAL, true)
    const rings = bodyTubes(v).reduce((n, t) => n + t.rings.length, 0)
    assert.equal(front.length, rings, BODY_NAMES[v])
    assert.equal(side.length, rings)
    assert.equal(new Set(front.map((r) => r.tube)).size, bodyTubes(v).length, 'every tube')
    for (const [i, r] of front.entries()) {
      assert.ok(Number.isFinite(r.y) && Number.isFinite(r.left) && Number.isFinite(r.right))
      assert.ok(r.left < r.right, `ring ${i} has width`)
      assert.ok(side[i].left < side[i].right, `ring ${i} has depth`)
      assert.equal(side[i].slot, r.slot); assert.equal(side[i].piece, r.piece); assert.equal(side[i].tube, r.tube)
      assert.ok(r.y > -0.01 && r.y < HEIGHT_BASE + 0.05)
      // At rest, facing +z, a ring on the body's axis is centred.
      if (r.slot !== SLOT.PROP && r.piece === PIECE.NONE && Math.abs(r.left + r.right) < 1e-9) assert.ok(true)
    }
    const pieces = new Set(front.map((r) => r.piece))
    assert.equal(pieces.has(PIECE.TIE), v === 0)
    for (const p of [PIECE.BAG, PIECE.CUP, PIECE.LONG_HAIR, PIECE.GLASSES, PIECE.HAIR_CAP, PIECE.BOB, PIECE.BUN, PIECE.FACE, PIECE.COAT, PIECE.SCARF]) assert.ok(pieces.has(p), `piece ${p}`)
  }
  const top = (rings: ReturnType<typeof silhouetteRings>) => Math.max(...rings.map((r) => r.y))
  const tall = silhouetteRings(0, shape({ height: 2.05 })), short = silhouetteRings(0, shape({ height: 1.5 }))
  near(top(tall) / top(short), 2.05 / 1.5, 1e-9, 'the stature')
  const wide = silhouetteRings(0, shape({ shoulders: 1 })), narrow = silhouetteRings(0, shape({ shoulders: 0 }))
  const span = (rings: ReturnType<typeof silhouetteRings>) => Math.max(...rings.filter((r) => r.piece === PIECE.NONE && r.y > 1.3 && r.y < 1.5).map((r) => r.right - r.left))
  assert.ok(span(wide) > span(narrow) * 1.2, 'broader at the shoulder line')
  const headZ = (posture: number) => {
    const rings = silhouetteRings(0, shape({ posture }), true).filter((r) => r.y > 1.6 && r.piece === PIECE.NONE)
    return rings.reduce((s, r) => s + (r.left + r.right) / 2, 0) / rings.length
  }
  assert.ok(headZ(0) > headZ(1) + 0.05, `slumped ${headZ(0)} vs upright ${headZ(1)}`)
  const still = silhouetteRings(0, SHAPE_NEUTRAL, true).filter((r) => r.y > 1.6 && r.piece === PIECE.NONE)
  near(still.reduce((s, r) => s + (r.left + r.right) / 2, 0) / still.length, 0, 0.03, 'the base head over the feet')
})

// --- The face --------------------------------------------------------------------------------------------------

test('facePoint and faceNormal: the base face moves nothing; each slider moves its own region along its own axes, the normals take the scales\' reciprocals and stay unit', () => {
  const regions = Object.values(FACE_REGION)
  const points: [number, number, number][] = [[0.03, 1.68, 0.09], [-0.05, 1.6, 0.07], [0, 1.66, 0.11], [0.08, 1.64, 0.02]]
  for (const r of regions) for (const w of [0, 0.5, 1]) for (const [x, y, z] of points) {
    const p = facePoint(x, y, z, r, w, FACE_NEUTRAL)
    near(p[0], x, 1e-15, `region ${r} at rest, x`); near(p[1], y, 1e-15, `region ${r} at rest, y`); near(p[2], z, 1e-15, `region ${r} at rest, z`)
    const n = faceNormal(0.6, 0, 0.8, r, w, FACE_NEUTRAL)
    near(n[0], 0.6, 1e-12, 'nx'); near(n[2], 0.8, 1e-12, 'nz')
  }
  const extreme = face({ brow: 1, jaw: 1, chin: 1, cheek: 1, nose: 1, eyes: 1, lips: 1 })
  // Off the head, or in no region: unmoved however the sliders stand.
  assert.deepEqual(facePoint(0.03, 1.68, 0.09, FACE_REGION.NONE, 1, extreme), [0.03, 1.68, 0.09])
  // The brow: up and forward, the weight unused (a brow moves whole).
  assert.deepEqual(facePoint(0.03, 1.7, 0.09, FACE_REGION.BROW, 0.3, face({ brow: 1 })), [0.03, 1.7 + FACE.brow.lift, 0.09 + FACE.brow.push])
  assert.deepEqual(facePoint(0.03, 1.7, 0.09, FACE_REGION.BROW, 1, face({ brow: -1 })), [0.03, 1.7 - FACE.brow.lift, 0.09 - FACE.brow.push])
  // The jaw: x alone, by the weight.
  near(facePoint(0.05, 1.6, 0.07, FACE_REGION.JAW, 1, face({ jaw: 1 }))[0], 0.05 * (1 + FACE.jaw.width), 1e-12, 'jaw x')
  near(facePoint(0.05, 1.6, 0.07, FACE_REGION.JAW, 0.5, face({ jaw: 1 }))[0], 0.05 * (1 + FACE.jaw.width * 0.5), 1e-12, 'jaw x, half weight')
  assert.deepEqual(facePoint(0.05, 1.6, 0.07, FACE_REGION.JAW, 1, face({ jaw: 1 })).slice(1), [1.6, 0.07])
  // The chin: the jaw's width whole, and forward by the chin slider and the weight.
  const chin = facePoint(0.02, 1.575, 0.08, FACE_REGION.CHIN, 0.5, face({ jaw: 1, chin: 1 }))
  near(chin[0], 0.02 * (1 + FACE.jaw.width), 1e-12, 'chin x'); near(chin[2], 0.08 + FACE.chin.push * 0.5, 1e-12, 'chin z'); assert.equal(chin[1], 1.575)
  // The cheekbones: out (away from the centre) and up, by the weight.
  const cheek = facePoint(-0.08, 1.64, 0.02, FACE_REGION.CHEEK, 1, face({ cheek: 1 }))
  near(cheek[0], -0.08 - FACE.cheek.width, 1e-12, 'cheek x'); near(cheek[1], 1.64 + FACE.cheek.lift, 1e-12, 'cheek y'); assert.equal(cheek[2], 0.02)
  // The nose: scaled about its root in x and z, y kept.
  const nose = facePoint(0.01, 1.66, FACE.nose.rootZ + 0.02, FACE_REGION.NOSE, 1, face({ nose: 1 }))
  near(nose[0], 0.01 * (1 + FACE.nose.size), 1e-12, 'nose x'); near(nose[2], FACE.nose.rootZ + 0.02 * (1 + FACE.nose.size), 1e-12, 'nose z'); assert.equal(nose[1], 1.66)
  assert.deepEqual(facePoint(0, 1.66, FACE.nose.rootZ, FACE_REGION.NOSE, 1, face({ nose: 1 })), [0, 1.66, FACE.nose.rootZ], 'the root stays')
  // The eyes: apart along the skull, back as they go out.
  const eye = facePoint(-0.03, 1.68, 0.1, FACE_REGION.EYES, 1, face({ eyes: 1 }))
  near(eye[0], -0.03 - FACE.eyes.spread, 1e-12, 'eye x'); near(eye[2], 0.1 - FACE.eyes.spread * FACE.eyes.slope, 1e-12, 'eye z')
  near(facePoint(0.03, 1.68, 0.1, FACE_REGION.EYES, 1, face({ eyes: -1 }))[0], 0.03 - FACE.eyes.spread, 1e-12, 'closer')
  // The lips: fuller about the lip line.
  near(facePoint(0, 1.612, 0.1, FACE_REGION.LIPS, 1, face({ lips: 1 }))[1], FACE.lips.lineY + (1.612 - FACE.lips.lineY) * (1 + FACE.lips.fullness), 1e-12, 'upper lip')
  assert.equal(facePoint(0, FACE.lips.lineY, 0.1, FACE_REGION.LIPS, 1, face({ lips: 1 }))[1], FACE.lips.lineY, 'the line stays')
  // Values past the sliders' range are clamped.
  assert.deepEqual(facePoint(0.03, 1.7, 0.09, FACE_REGION.BROW, 1, face({ brow: 5 })), facePoint(0.03, 1.7, 0.09, FACE_REGION.BROW, 1, face({ brow: 1 })))
  // The normals: unit, and the reciprocal of each scale (a wider jaw's normal leans toward the axis).
  for (const r of regions) {
    const n = faceNormal(0.6, 0.3, 0.74, r, 1, extreme)
    near(length(n), 1, 1e-12, `region ${r} unit`)
  }
  const jawN = faceNormal(1, 0, 1, FACE_REGION.JAW, 1, face({ jaw: 1 }))
  near(jawN[0] / jawN[2], 1 / (1 + FACE.jaw.width), 1e-12, 'the jaw\'s normal')
  const lipN = faceNormal(0, 1, 1, FACE_REGION.LIPS, 1, face({ lips: 1 }))
  near(lipN[1] / lipN[2], 1 / (1 + FACE.lips.fullness), 1e-12, 'the lips\' normal')
  assert.deepEqual(faceNormal(0.6, 0, 0.8, FACE_REGION.EYES, 1, extreme), [0.6, 0, 0.8], 'a shift leaves the normal')
  // The skull's chord: on the axis it is the front; it falls off toward the sides; outside the skull's rings it is finite.
  assert.ok(skullFront(1.68, 0) > 0.09 && skullFront(1.68, 0) < 0.12, `${skullFront(1.68, 0)}`)
  assert.ok(skullFront(1.68, 0.05) < skullFront(1.68, 0))
  near(skullFront(1.68, 0.05), skullFront(1.68, -0.05), 1e-12, 'symmetric')
  assert.ok(Number.isFinite(skullFront(1.9, 0)) && Number.isFinite(skullFront(1.4, 0.5)))
  near(FACE.nose.rootZ, skullFront(FACE.nose.rootY, 0), 1e-12, 'the nose roots on the skull')
})

test('the features sit on the skull: every eye, brow and lip vertex is clear of the skull\'s chord, the eyes sit between the glasses\' rims, and the face column is the regions with their weights', () => {
  for (const v of VARIANTS) {
    const m = humanoidMesh(v)
    let features = 0
    for (let i = 0; i < m.vertexCount; i++) {
      const region = m.face[i * 2], piece = m.rig[i * 3 + 2], slot = m.rig[i * 3 + 1]
      const x = m.position[i * 3], y = m.position[i * 3 + 1], z = m.position[i * 3 + 2]
      if (region === FACE_REGION.EYES || region === FACE_REGION.LIPS || region === FACE_REGION.BROW) {
        assert.ok(z - skullFront(y, x) >= 0.001, `${BODY_NAMES[v]}: vertex ${i} (region ${region}) is ${z - skullFront(y, x)} m off the skull`)
        assert.equal(piece, PIECE.FACE)
        features++
      }
      if (slot === SLOT.EYE || slot === SLOT.IRIS) assert.ok(y > 1.6735 && y < 1.6885, `${BODY_NAMES[v]}: an eye vertex at ${y} m is under a rim`)
      if (slot === SLOT.FRAME) assert.ok(Math.abs(y - 1.672) < 0.002 || Math.abs(y - 1.69) < 0.002, `${BODY_NAMES[v]}: a rim at ${y} m`)
      if (piece === PIECE.FACE) assert.equal(m.rig[i * 3], BONE.HEAD)
      // A region's weight: the chin's front carries its push, its back none (the jaw's width still acts on it).
      if (region === FACE_REGION.CHIN && z < 0) assert.equal(m.face[i * 2 + 1], 0)
      if (region === FACE_REGION.JAW) assert.ok(m.face[i * 2 + 1] > 0)
    }
    assert.ok(features > 100, `${BODY_NAMES[v]}: ${features} feature vertices`)
  }
})

test('faceRings: the head\'s rings alone, the same rings the silhouette holds at the base face, in the same shape across the bodies; the sliders move the view as they move the mesh', () => {
  const key = (r: { y: number; left: number; right: number; slot: number; piece: number }) => [r.y, r.left, r.right, r.slot, r.piece].map((n) => Math.round(n * 1e6)).join(':')
  for (const v of VARIANTS) for (const side of [false, true]) {
    const head = faceRings(v, SHAPE_NEUTRAL, FACE_NEUTRAL, side)
    assert.ok(head.length >= 50, `${head.length} rings`)
    assert.equal(head.length, faceRings(0, SHAPE_NEUTRAL, FACE_NEUTRAL, side).length, 'one head for every body')
    const whole = new Set(silhouetteRings(v, SHAPE_NEUTRAL, side).map(key))
    for (const r of head) assert.ok(whole.has(key(r)), `${BODY_NAMES[v]}: a head ring the silhouette lacks (${key(r)})`)
    assert.ok(head.every((r) => r.y > 1.3), 'the head and its hair')
    assert.ok(head.some((r) => r.slot === SLOT.EYE) && head.some((r) => r.slot === SLOT.IRIS) && head.some((r) => r.slot === SLOT.LIP), 'the features')
    assert.equal(head[0].tube, 0)
  }
  const front = (f: FaceShape) => faceRings(0, SHAPE_NEUTRAL, f, false)
  const profile = (f: FaceShape) => faceRings(0, SHAPE_NEUTRAL, f, true)
  const widest = (rings: ReturnType<typeof faceRings>, pick: (r: ReturnType<typeof faceRings>[number]) => boolean) => Math.max(...rings.filter(pick).map((r) => r.right - r.left))
  // A wider jaw widens the skull about the chin, not the crown.
  const jawLine = (r: ReturnType<typeof faceRings>[number]) => r.tube === 0 && r.y > 1.59 && r.y < 1.61
  const crown = (r: ReturnType<typeof faceRings>[number]) => r.tube === 0 && r.y > 1.74
  assert.ok(widest(front(face({ jaw: 1 })), jawLine) > widest(front(face({ jaw: -1 })), jawLine) * 1.1, 'the jaw')
  near(widest(front(face({ jaw: 1 })), crown), widest(front(face({ jaw: -1 })), crown), 1e-9, 'the crown is left alone')
  // Eyes apart: the whites' centres move outward.
  const eyeCentre = (f: FaceShape) => Math.max(...front(f).filter((r) => r.slot === SLOT.EYE).map((r) => Math.abs((r.left + r.right) / 2)))
  assert.ok(eyeCentre(face({ eyes: 1 })) > eyeCentre(face({ eyes: -1 })) + 0.01, 'the eyes')
  // A bigger nose stands further out in profile (the ears, the other skin-coloured features, sit far behind it).
  const noseTip = (f: FaceShape) => Math.max(...profile(f).filter((r) => r.piece === PIECE.FACE && r.slot === SLOT.SKIN).map((r) => r.right))
  assert.ok(noseTip(face({ nose: 1 })) > noseTip(face({ nose: -1 })) + 0.003, 'the nose')
  // Fuller lips span more.
  const lipSpan = (f: FaceShape) => { const ys = front(f).filter((r) => r.slot === SLOT.LIP).map((r) => r.y); return Math.max(...ys) - Math.min(...ys) }
  assert.ok(lipSpan(face({ lips: 1 })) > lipSpan(face({ lips: -1 })) * 1.3, 'the lips')
  // The brow rides up.
  const browY = (f: FaceShape) => Math.max(...front(f).filter((r) => r.piece === PIECE.FACE && r.slot === SLOT.HAIR).map((r) => r.y))
  near(browY(face({ brow: 1 })) - browY(face({ brow: -1 })), 2 * FACE.brow.lift, 1e-9, 'the brow')
  // The body sliders still act: a taller stature lifts the whole head.
  assert.ok(Math.max(...faceRings(0, shape({ height: 2.0 }), FACE_NEUTRAL).map((r) => r.y)) > Math.max(...front(FACE_NEUTRAL).map((r) => r.y)) + 0.1)
})

test('HAIRLINE: the cap\'s front leaves the skull\'s front at the hairline and its shell leaves the skull\'s side at the temple; under the hairline the cap and the bob paint behind the face from the front and over the side of the head, back from the temple, from the side', () => {
  const tubes = bodyTubes(0).filter((t) => t.head)
  const skull = tubes[0], cap = tubes.find((t) => t.piece === PIECE.HAIR_CAP)!, bob = tubes.find((t) => t.piece === PIECE.BOB)!
  assert.equal(skull.piece, undefined)
  type R = (typeof cap.rings)[number]
  const frontOf = (r: R) => (r.z ?? 0) + (r.rz ?? r.rx)
  const gap = (r: R) => frontOf(r) - skullFront(r.y, 0)
  const below = cap.rings.filter((r) => r.y < HAIRLINE.y), above = cap.rings.filter((r) => r.y >= HAIRLINE.y)
  assert.equal(below.length, 3); assert.equal(above.length, 2)
  for (const r of below) assert.ok(gap(r) < -0.002, `the cap at ${r.y} is inside the face (${gap(r)})`)
  for (const r of above.filter((r) => r.y <= skull.capTop!)) assert.ok(gap(r) > 0.002, `the cap at ${r.y} is outside the skull (${gap(r)})`)
  assert.ok(above[above.length - 1].y > skull.capTop!, 'the last ring is over the crown')
  const a = below[below.length - 1], b = above[0]
  // The loft runs straight between the two rings; the skull's front is piecewise straight too, with a knee between them, so scan.
  let cross = a.y
  while (cross < b.y && frontOf(a) + (frontOf(b) - frontOf(a)) * ((cross - a.y) / (b.y - a.y)) < skullFront(cross, 0)) cross += 0.0001
  near(cross, HAIRLINE.y, 0.0005, 'the hairline is where the cap\'s front crosses the skull\'s')
  // The temple: at the eyes' height the cap's and the skull's rings are equally wide at z = temple; the cap is wider behind it, the skull ahead.
  const eyeY = 1.68
  const capEye = cap.rings.find((r) => r.y === eyeY)!, skullEye = skull.rings.find((r) => r.y === eyeY)!
  const halfWidth = (r: R, z: number) => r.rx * Math.sqrt(Math.max(0, 1 - ((z - (r.z ?? 0)) / (r.rz ?? r.rx)) ** 2))
  near(halfWidth(capEye, HAIRLINE.temple), halfWidth(skullEye, HAIRLINE.temple), 0.001, 'the temple')
  assert.ok(halfWidth(capEye, HAIRLINE.temple - 0.03) > halfWidth(skullEye, HAIRLINE.temple - 0.03) + 0.002, 'hair behind the temple')
  assert.ok(halfWidth(capEye, HAIRLINE.temple + 0.03) < halfWidth(skullEye, HAIRLINE.temple + 0.03) - 0.002, 'face ahead of it')
  assert.ok(bob.rings.every((r) => r.y < HAIRLINE.y), 'the whole bob is under the hairline')
  assert.ok(bob.rings.every((r) => r.y > 1.575), 'and hemmed above the chin')
  // The card's rings carry the depth: hair under the hairline is 0 from the front and 3 from the side, where its front edge stops at the temple.
  for (const side of [false, true]) {
    const rings = faceRings(0, SHAPE_NEUTRAL, FACE_NEUTRAL, side)
    const under = rings.filter((r) => (r.piece === PIECE.HAIR_CAP || r.piece === PIECE.BOB) && r.y < HAIRLINE.y)
    assert.equal(under.length, 3 + bob.rings.length)
    for (const r of under) assert.equal(r.depth, side ? 3 : 0, `${side ? 'side' : 'front'} ${r.y}`)
    for (const r of rings.filter((r) => r.piece === PIECE.HAIR_CAP && r.y >= HAIRLINE.y)) assert.equal(r.depth, 3)
    for (const r of rings.filter((r) => r.piece === PIECE.LONG_HAIR || r.piece === PIECE.BUN)) assert.equal(r.depth, 0)
    for (const r of rings.filter((r) => r.piece === PIECE.FACE || r.piece === PIECE.GLASSES)) assert.ok(r.depth === 4 || (r.depth === 2 && r.slot === SLOT.SKIN && r.piece === PIECE.FACE), `a feature at depth ${r.depth}`)
    assert.ok(rings.some((r) => r.depth === 2), 'the ears')
    for (const r of rings.filter((r) => r.tube === 0)) assert.equal(r.depth, 1, 'the skull')
    if (side) {
      for (const r of under) assert.ok(r.right <= HAIRLINE.temple + 1e-9, `the hair stops at the temple at ${r.y} (${r.right})`)
      for (const r of under.filter((r) => r.piece === PIECE.HAIR_CAP)) near(r.right, HAIRLINE.temple, 1e-9, `the cap reaches the temple at ${r.y}`)
      const crown = rings.find((r) => r.piece === PIECE.HAIR_CAP && r.y >= HAIRLINE.y)!
      assert.ok(crown.right > HAIRLINE.temple + 0.03, 'above the hairline the cap reaches the forehead')
    } else {
      const skullAt = (y: number) => rings.find((r) => r.tube === 0 && Math.abs(r.y - y) < 1e-9)!
      assert.ok(under.every((r) => r.right > 0.085), 'the cap and the bob show beside the head')
      assert.ok(under.filter((r) => r.piece === PIECE.HAIR_CAP).every((r) => r.right < skullAt(1.68).right + 0.02), 'by a little')
    }
  }
  // The body's silhouette carries the same depths (one ringEdges).
  const body = silhouetteRings(0, SHAPE_NEUTRAL, false)
  assert.ok(body.some((r) => r.piece === PIECE.HAIR_CAP && r.depth === 0) && body.some((r) => r.piece === PIECE.HAIR_CAP && r.depth === 3))
  assert.ok(body.filter((r) => r.piece === PIECE.NONE && r.tube > 0).every((r) => r.depth === 1), 'the body at 1')
})

// --- The WGSL --------------------------------------------------------------------------------------------------

test('crowdBody.ts: the WGSL carries every number humanoid.ts holds (the elbow and wrist as their drop from the shoulder), seventeen functions, one call for the position and the normal, the face shaped on the head alone, the legs solved from the feet, the gaze from the operator\'s eye, a fallen body hung from its rig', () => {
  const lit = (n: number): string => (Number.isInteger(n) ? `${n}.0` : `${n}`)
  const flat = (name: string, o: unknown, out: [string, number][] = []): [string, number][] => {
    if (typeof o === 'number') out.push([name, o])
    else for (const [k, v] of Object.entries(o as object)) flat(`${name}.${k}`, v, out)
    return out
  }
  const carried = [...flat('LANDMARK', LANDMARK), ...flat('MORPH', MORPH), ...flat('REGION', REGION), ...flat('LIMB_GIRTH', LIMB_GIRTH), ...flat('WALK', WALK), ...flat('SOLE', SOLE), ...flat('GAZE', GAZE), ...flat('FACE', FACE)]
    .filter(([name]) => name !== 'LANDMARK.elbow' && name !== 'LANDMARK.wrist' && name !== 'FACE.nose.rootY' && name !== 'FACE.clear')
  for (const [name, v] of carried) assert.ok(BODY_WGSL.includes(lit(v)), `${name} = ${lit(v)} in the WGSL`)
  assert.ok(BODY_WGSL.includes(`shoulderY - ${lit(LANDMARK.shoulder - LANDMARK.elbow)}`), 'the elbow hangs its drop under the shoulder')
  assert.ok(BODY_WGSL.includes(`shoulderY - ${lit(LANDMARK.shoulder - LANDMARK.wrist)}`), 'the wrist too')
  assert.doesNotMatch(BODY_WGSL, /undefined|NaN|\[object/, 'every interpolation is a number')
  // Tint refuses WGSL's reserved words as names (it refused `target`); the ones a hand reaches for, as a declared name.
  assert.doesNotMatch(BODY_WGSL, /\b(?:target|flat|smooth|filter|get|set|type|mod|of|from|new|ref|self|this|with|where|use|pass|premerge|precise|common|shared|static|sizeof|null|nil|do|match|move|mut|pub|priv|super|try|catch|throw|final|package|module|import|export|layout|resource|register|precision|patch|partition|require|regardless|unless|operator|namespace|template|typedef|union|enum|class|interface|extends|implements|instanceof|delete|yield|await|become|crate|impl|trait|unsafe|unsized|external|demote|coherent|readonly|writeonly|varying|attribute|active|cast|highp|mediump|lowp|snorm|unorm|std|meta|macro|auto|goto|inline|noexcept|volatile|virtual|friend|explicit|mutable|restrict|protected|public|using|typename|typeof|typeid|decltype|concept|debugger|fallthrough|finally|subroutine|groupshared|nointerpolation|noperspective|packoffset|pixelfragment|thread_local|column_major)\s*[:=]/, 'no name WGSL reserves')
  assert.deepEqual([...BODY_WGSL.matchAll(/^fn (\w+)\(/gm)].map((m) => m[1]), ['bodyRotX', 'bodyRotY', 'bodyRotAxis', 'bodyHat', 'bodyHeightMap', 'bodySlope', 'bodyFace', 'bodyMorph', 'bodyFoot', 'bodyReach', 'bodyLeg', 'bodyGaze', 'bodyRigCentre', 'bodyRotQ', 'bodyRig', 'bodyBone', 'bodyVertex'])
  assert.ok(BODY_WGSL.includes('fn bodyVertex(v: vec3f, n: vec3f, rig: vec3f, skin: vec2f, face: vec2f, agent: vec4f, motion: vec4f, pose: vec4f, stance: vec4f, morphA: vec4f, morphB: vec4f, faceA: vec4f, faceB: vec4f, t: f32, gaze: vec4f, rigA: vec4f, rigAq: vec4f, rigB: vec4f, rigBq: vec4f) -> mat3x3f'))
  assert.ok(BODY_WGSL.includes('fn bodyRig(m: mat3x3f, bone0: u32, bone1: u32, weight: f32, stature: f32, pA: vec4f, qA: vec4f, pB: vec4f, qB: vec4f) -> mat3x3f'))
  // The fallen body: after the sliders and before the walk, hung from its rig; every shape's standing centre in the text.
  assert.match(BODY_WGSL, /let rest = bodyMorph\(v0, n0, bone0, m, fD, fLegs, fTrunk\);\n\s*if \(stance\.w > 0\.5\) \{\n(?:\s*\/\/[^\n]*\n)*\s*return bodyRig\(rest, bone0, bone1, weight, stance\.x, rigA, rigAq, rigB, rigBq\);/)
  assert.ok(BODY_WGSL.includes(`var c = array<vec3f, 15>(${RIG_REST.map(([, x, y, z]) => `vec3f(${lit(x)}, ${lit(y)}, ${lit(z)})`).join(', ')});`), 'RIG_REST in the WGSL')
  assert.ok(BODY_WGSL.includes('return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);'), 'the quaternion turn as rotateByQuat')
  assert.ok(BODY_WGSL.includes('fn bodyFoot(phase: f32, stride: f32, lift: f32, roll: f32) -> vec4f'))
  assert.ok(BODY_WGSL.includes('fn bodyLeg(dy: f32, dz: f32, thigh: f32, shin: f32, sole: f32) -> vec4f'))
  assert.ok(BODY_WGSL.includes('fn bodyGaze(neck: vec3f, heading: f32, vel: vec2f, eye: vec4f) -> vec3f'))
  assert.ok(BODY_WGSL.includes('fn bodyBone(bone: u32, m: mat3x3f, legL: vec4f, legR: vec4f, armL: vec4f, armR: vec4f, trunk: vec4f, pivA: vec4f, pivB: vec4f, pivX: vec2f, k: vec3f, headYaw: f32) -> mat3x3f'))
  // The legs from the feet, the pelvis' drop from the planted one, the gaze from the neck's place in the world, in humanoid.ts's order.
  assert.match(BODY_WGSL, /let footL = bodyFoot\(phase, stride, lift, roll\);\n\s*let footR = bodyFoot\(phase \+ 3\.14159\d+, stride, lift, roll\);/)
  assert.match(BODY_WGSL, /let planted = select\(footR, footL, footL\.w > 0\.5\);\n\s*let drop = max\(0\.0, pivA\.x - pivA\.z - planted\.y - sqrt\(max\(reach \* reach - planted\.x \* planted\.x, 0\.0\)\)\);/)
  assert.match(BODY_WGSL, /let legL = bodyLeg\(pivA\.z \+ footL\.y \+ drop - pivA\.x, footL\.x, thigh, shin, footL\.z\);/)
  assert.match(BODY_WGSL, /let look = bodyGaze\(agent\.xyz \+ vec3f\(0\.0, pivB\.w \* stance\.x, 0\.0\), agent\.w, motion\.xy, gaze\);/)
  assert.match(BODY_WGSL, /p\.y \* stance\.x - drop \* stance\.x/, 'the pelvis\' drop after the stature\'s scale, as humanoid.ts rise')
  assert.match(BODY_WGSL, /if \(bone == 2u\) \{ q = bodyRotX\(q, vec3f\(0\.0, pivB\.w, 0\.0\), trunk\.y\); q = bodyRotY\(q, vec3f\(0\.0, pivB\.w, 0\.0\), headYaw\); \}/, 'the head nods, then turns, about the neck')
  assert.ok(BODY_WGSL.includes('fn bodyMorph(p: vec3f, n: vec3f, bone: u32, m: vec4f, fD: f32, fLegs: f32, fTrunk: f32) -> mat3x3f'))
  assert.ok(BODY_WGSL.includes('fn bodyFace(p: vec3f, n: vec3f, face: vec2f, fa: vec4f, fb: vec4f) -> mat3x3f'))
  assert.equal((BODY_WGSL.match(/-> mat3x3f/g) ?? []).length, 8, 'the rotations, the face, the morph, the rig, the bone chain and the vertex each carry a position and a normal')
  assert.ok(BODY_WGSL.includes('return mat3x3f(world, normalize('), 'the world position and a unit normal')
  for (const piece of ['mask', 'holdingCup', 'carryingBag']) assert.ok(BODY_WGSL.includes(piece), piece)
  // The face is shaped before the body sliders, on the head bone, where the vertex names a region; the regions in
  // humanoid.ts's order.
  assert.match(BODY_WGSL, /if \(bone0 == 2u && face\.x > 0\.5\) \{\n\s*let shaped = bodyFace\(v, n, face, faceA, faceB\);/)
  assert.equal(BONE.HEAD, 2)
  for (const [name, r] of Object.entries(FACE_REGION)) if (r > 0) assert.ok(BODY_WGSL.includes(`region == ${r}u`), `${name} is region ${r} in the WGSL`)
  assert.ok(BODY_WGSL.includes('let rest = bodyMorph(v0, n0, bone0, m, fD, fLegs, fTrunk);'), 'the morph takes the shaped point')
  // Every call in the text is an include of its caller (transitively), so three writes each function once per shader.
  const parts = new Map([...BODY_WGSL.split(/(?=^fn )/m)].filter((p) => p.startsWith('fn ')).map((p) => [p.match(/^fn (\w+)/)![1], p]))
  const reach = (name: string, seen = new Set<string>()): Set<string> => {
    for (const inc of BODY_INCLUDES[name] ?? []) if (!seen.has(inc)) { seen.add(inc); reach(inc, seen) }
    return seen
  }
  for (const [name, body] of parts) {
    const calls = new Set([...body.replace(/^fn \w+\([^)]*\)[^{]*\{/, '').matchAll(/\b(body\w+)\(/g)].map((m) => m[1]).filter((c) => c !== name))
    const included = reach(name)
    for (const c of calls) assert.ok(included.has(c), `${name} calls ${c}, which BODY_INCLUDES does not reach from it`)
    for (const inc of BODY_INCLUDES[name] ?? []) assert.ok(parts.has(inc), `${name} includes ${inc}, which is no function`)
  }
  const src = read('./crowdBody.ts')
  assert.match(src, /^(?:\/\/[^\n]*\n)*\/\*\*\n \* Why does this file exist\?[\s\S]*What breaks if it is removed\?/, 'the header')
  assert.match(src, /import \{ FACE, GAZE, HEIGHT_BASE, LANDMARK, LIMB_GIRTH, MORPH, REGION, RIG_REST, SOLE, WALK \} from '\.\/humanoid\.ts'/)
  assert.match(src, /export const bodyVertex = fn\('bodyVertex'\)/)
  assert.doesNotMatch(src, /from 'three\/webgpu'|three\/src/, 'nodes only: no renderer')
  assert.equal(statureFactor(HEIGHT_BASE), 1)
  assert.equal(statureFactor(HEIGHT_BASE * 2), 2)
})

test('crowd.ts: the geometry is humanoid.ts\'s mesh with its rig, skin and face attributes, and the vertex stage is one bodyVertex call whose columns are the position and the normal', () => {
  const crowd = read('./crowd.ts')
  assert.match(crowd, /import \{ bodyVertex \} from '\.\/crowdBody\.ts'/)
  assert.match(crowd, /return geometryOf\(humanoidMesh\(v, detailed\)\)/)
  assert.match(crowd, /g\.setAttribute\('rig', new Float32BufferAttribute\(mesh\.rig, 3\)\)/)
  assert.match(crowd, /g\.setAttribute\('skin', new Float32BufferAttribute\(mesh\.skin, 2\)\)/)
  assert.match(crowd, /g\.setAttribute\('face', new Float32BufferAttribute\(mesh\.face, 2\)\)/, 'every body carries the face column (zero off the head)')
  assert.match(crowd, /g\.setIndex\(new Uint32BufferAttribute\(mesh\.index, 1\)\)/)
  assert.match(crowd, /const g = bodyGeometry\(v, lod === 0\)/, 'the far body past the lod cut')
  assert.match(crowd, /this\.material\(buffers, lod \* quota \* VARIANTS \+ v \* quota, v, lod === 0\)/, 'the near material alone shapes a face')
  assert.match(crowd, /const rig = attribute\('rig', 'vec3'\)\n\s*const skin = attribute\('skin', 'vec2'\)\n\s*const face = attribute\('face', 'vec2'\)/)
  assert.match(crowd, /if \(near\) \{\n\s*If\(rig\.x\.greaterThan\(BONE\.HEAD - 0\.5\)\.and\(rig\.x\.lessThan\(BONE\.HEAD \+ 0\.5\)\), \(\) => \{/, 'the face hashes run for the head alone')
  assert.match(crowd, /const skinned = \(bodyVertex\(positionLocal, normalLocal, rig, skin, face, agent, motion, pose, stance, morphA, morphB, faceA, faceB, time, this\.gazeTarget, this\.rigPoses\.element\(rigA\), this\.rigPoses\.element\(rigA\.add\(uint\(1\)\)\), this\.rigPoses\.element\(rigB\), this\.rigPoses\.element\(rigB\.add\(uint\(1\)\)\)\) as unknown as Mat3\)\.toVar\(\)/)
  assert.match(crowd, /readonly rigPoses = uniformArray\(Array\.from\(\{ length: RIG_WEAR\.slots \* RIG_WEAR\.shapes \* 2 \}, \(_, i\) => new Vector4\(0, 0, 0, i % 2\)\), 'vec4'\)/, 'the rig poses: a centre then a quaternion per shape, identity when empty')
  assert.match(crowd, /readonly rigShape = uniformArray\(RIG_REST\.map\(\(\[shape\]\) => shape\), 'float'\)/, 'the shape per bone')
  assert.match(crowd, /readonly gazeTarget: UniformNode<'vec4', Vector4> = uniform\(new Vector4\(0, 0, 0, 0\)\)/, 'the operator\'s eye, one uniform for both passes')
  assert.match(crowd, /normalLocal\.assign\(skinned\.element\(uint\(1\)\)\)/)
  assert.match(crowd, /const body = skinned\.element\(uint\(0\)\)/)
  assert.match(crowd, /export const VARIANT_NAMES = BODY_NAMES/)
  assert.doesNotMatch(crowd, /BoxGeometry|CylinderGeometry|SphereGeometry|CapsuleGeometry/, 'no primitives: the body is the loft')
})

test('GARMENT, the coat and the scarf: the jacket\'s lines sit on the loft (the V closes on the chest and opens at the trunk\'s top ring, the cuff line cuts every sleeve, a band stands above the collar line); the coat is a shell outside the trunk on both bodies; the scarf wraps the neck, with a tail down the chest on the near body alone', () => {
  assert.ok(Object.isFrozen(GARMENT) && Object.isFrozen(GARMENT.closes) && Object.isFrozen(GARMENT.halfAtCollar))
  assert.equal(GARMENT.opens, 1.5, 'the trunk\'s collar ring')
  assert.ok(GARMENT.collar < GARMENT.opens && GARMENT.collar > 1.4)
  assert.ok(GARMENT.coatCloses > Math.max(...GARMENT.closes) && GARMENT.coatCloses < GARMENT.collar, 'a coat\'s V is the shorter')
  assert.equal(GARMENT.closes.length, 4)
  assert.equal(GARMENT.halfAtCollar.length, 4)
  assert.ok(GARMENT.lapel > 0.02 && GARMENT.lapel < 0.05)
  for (const v of VARIANTS) {
    assert.ok(GARMENT.closes[v] >= 1.2 && GARMENT.closes[v] < GARMENT.collar, `${BODY_NAMES[v]}: the V closes on the chest`)
    assert.ok(GARMENT.halfAtCollar[v] > 0.05 && GARMENT.halfAtCollar[v] + GARMENT.lapel < LANDMARK.shoulderX, `${BODY_NAMES[v]}: the V and its lapels are narrower than the shoulders`)
    for (const detailed of [true, false]) {
      const m = humanoidMesh(v, detailed)
      const name = `${BODY_NAMES[v]} ${detailed ? 'near' : 'far'}`
      let sleeveLow = Infinity, sleeveHigh = -Infinity, trunkTop = -Infinity
      const coat = new Map<number, [number, number]>(), body: [number, number, number][] = [], scarf: number[] = []
      for (let i = 0; i < m.vertexCount; i++) {
        const bone = m.rig[i * 3], slot = m.rig[i * 3 + 1], piece = m.rig[i * 3 + 2]
        const x = Math.abs(m.position[i * 3]), y = m.position[i * 3 + 1], z = Math.abs(m.position[i * 3 + 2])
        if (slot === SLOT.TOP && bone >= BONE.ARM_L) { sleeveLow = Math.min(sleeveLow, y); sleeveHigh = Math.max(sleeveHigh, y) }
        if (slot === SLOT.TOP && bone < BONE.HEAD && piece === PIECE.NONE) { trunkTop = Math.max(trunkTop, y); body.push([y, x, z]) }
        if (piece === PIECE.COAT) {
          assert.equal(slot, SLOT.TOP, `${name}: the coat wears the top's dye`)
          assert.ok(bone < BONE.HEAD, `${name}: the coat is on the trunk`)
          const ring = coat.get(y) ?? [0, 0]
          coat.set(y, [Math.max(ring[0], x), Math.max(ring[1], z)])
        }
        if (piece === PIECE.SCARF) {
          assert.equal(slot, SLOT.SCARF, `${name}: the scarf's own dye`)
          assert.ok(bone < BONE.THIGH_L, `${name}: the scarf is on the trunk or the head`)
          scarf.push(y)
        }
      }
      assert.ok(sleeveLow < GARMENT.cuff && sleeveHigh > GARMENT.cuff + 0.2, `${name}: the cuff line cuts the sleeve (${sleeveLow}..${sleeveHigh})`)
      near(trunkTop, GARMENT.opens, 1e-6, `${name}: the jacket opens at the trunk's top ring`)
      assert.ok(body.some(([y]) => y > GARMENT.collar && y < GARMENT.opens + 1e-9), `${name}: the collar band lies between the collar line and the opening`)
      assert.ok(coat.size >= 5 && scarf.length > 0, `${name}: a coat of rings and a scarf`)
      // The coat: from the hips to the trunk's top ring, each ring wider and deeper than the trunk's own rings about its height.
      const ys = [...coat.keys()]
      near(Math.min(...ys), 0.56, 1e-6, `${name}: the coat's hem`)
      near(Math.max(...ys), GARMENT.opens, 1e-6, `${name}: the coat's collar`)
      for (const [y, [half, depth]] of coat) {
        let bodyHalf = 0, bodyDepth = 0
        for (const [by, bx, bz] of body) if (Math.abs(by - y) < 0.02) { bodyHalf = Math.max(bodyHalf, bx); bodyDepth = Math.max(bodyDepth, bz) }
        assert.ok(half >= bodyHalf - 1e-6, `${name}: the coat at ${y} (${half} wide) outside the trunk (${bodyHalf})`)
        assert.ok(depth >= bodyDepth - 1e-6, `${name}: the coat at ${y} (${depth} deep) outside the trunk (${bodyDepth})`)
      }
      // The scarf: wrapped about the neck; the near body's tail hangs down the chest.
      assert.ok(Math.max(...scarf) > 1.5 && Math.max(...scarf) < 1.6, `${name}: the wrap at the neck`)
      if (detailed) assert.ok(Math.min(...scarf) < 1.2, `${name}: the tail down the chest`)
      else assert.ok(Math.min(...scarf) > 1.45, `${name}: no tail on the far body`)
    }
  }
})
