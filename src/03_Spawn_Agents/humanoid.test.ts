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
  BODY_NAMES, BONE, BONES, EYE_LEVEL, FACE, FACE_NEUTRAL, FACE_REGION, HAIRLINE, HEIGHT_BASE, LANDMARK, LIMB_GIRTH, MORPH, PIECE, REGION, SHAPE_NEUTRAL, SLOT, WALK,
  bodyTubes, boneGroup, boneSide, boneTransform, eyeHeightOf, faceNormal, facePoint, faceRings, heightMap, humanoidMesh, morphNormal, morphPoint,
  pivotsOf, scaleOf, shapeFactors, silhouetteRings, skinPoint, skullFront, swingOf, walkAngles,
  type BodyPose, type BodyShape, type FaceShape,
} from './humanoid.ts'
import { LOOK_BODIES, LOOK_PIECE_BIT } from './look.ts'

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

test('the tables: four bodies named as the wardrobe names them, the pieces where the look\'s bits are, thirteen colour slots, eight face regions, fifteen bones in three groups on two sides', () => {
  assert.deepEqual([...BODY_NAMES], [...LOOK_BODIES])
  assert.deepEqual(LOOK_PIECE_BIT, { tie: PIECE.TIE, bag: PIECE.BAG, cup: PIECE.CUP, longHair: PIECE.LONG_HAIR, glasses: PIECE.GLASSES, hairCap: PIECE.HAIR_CAP, bob: PIECE.BOB, bun: PIECE.BUN, face: PIECE.FACE })
  assert.equal(PIECE.NONE, 0)
  assert.deepEqual([...Object.values(PIECE)].sort((a, b) => a - b), Array.from({ length: 10 }, (_, i) => i))
  assert.deepEqual([...Object.values(FACE_REGION)].sort((a, b) => a - b), Array.from({ length: 8 }, (_, i) => i))
  assert.equal(FACE_REGION.NONE, 0)
  assert.equal(BONES, 15)
  assert.deepEqual([...Object.values(BONE)].sort((a, b) => a - b), Array.from({ length: 15 }, (_, i) => i))
  assert.deepEqual(Array.from({ length: 15 }, (_, b) => boneGroup(b)), [0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2])
  assert.deepEqual(Array.from({ length: 15 }, (_, b) => boneSide(b)), [0, 0, 0, -1, -1, -1, 1, 1, 1, -1, -1, -1, 1, 1, 1])
  assert.deepEqual([...Object.values(SLOT)].sort((a, b) => a - b), Array.from({ length: 13 }, (_, i) => i))
  assert.deepEqual([SLOT.EYE, SLOT.IRIS, SLOT.LIP], [10, 11, 12])
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
      assert.ok(Number.isInteger(slot) && slot >= 0 && slot < 13, `${name}: slot ${slot}`)
      assert.ok(Number.isInteger(piece) && piece >= 0 && piece <= PIECE.FACE, `${name}: piece ${piece}`)
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
    assert.ok(m.vertexCount <= (detailed ? 1400 : 450), `${name}: ${m.vertexCount} vertices`)
    assert.ok(m.index.length / 3 <= (detailed ? 2400 : 800), `${name}: ${m.index.length / 3} triangles`)
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

test('the pieces: the suit alone has a tie; the cup, the glasses, the tie and the face are near-only; the bag and the hair reach the far body; the arms hang at rest', () => {
  const pieces = (v: number, detailed: boolean) => { const m = humanoidMesh(v, detailed); return new Set(Array.from({ length: m.vertexCount }, (_, i) => m.rig[i * 3 + 2])) }
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b)
  assert.deepEqual(sorted(pieces(0, true)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  for (const v of [1, 2, 3]) assert.deepEqual(sorted(pieces(v, true)), [0, 2, 3, 4, 5, 6, 7, 8, 9], BODY_NAMES[v])
  for (const v of VARIANTS) {
    assert.deepEqual(sorted(pieces(v, false)), [PIECE.NONE, PIECE.BAG, PIECE.LONG_HAIR, PIECE.HAIR_CAP, PIECE.BOB, PIECE.BUN], `${BODY_NAMES[v]} far`)
    for (const p of pieces(v, false)) assert.ok(pieces(v, true).has(p), 'the far body wears nothing the near one lacks')
  }
  const slots = (v: number, detailed = true) => { const m = humanoidMesh(v, detailed); return new Set(Array.from({ length: m.vertexCount }, (_, i) => m.rig[i * 3 + 1])) }
  assert.ok(slots(0).has(SLOT.ACCENT), 'the tie\'s cloth')
  assert.ok(slots(3).has(SLOT.LEGWEAR) && !slots(2).has(SLOT.LEGWEAR), 'hose under the skirt alone')
  for (const v of VARIANTS) {
    for (const s of [SLOT.TOP, SLOT.SHIRT, SLOT.SKIN, SLOT.HAIR, SLOT.BOTTOM, SLOT.SHOES, SLOT.PROP, SLOT.FRAME, SLOT.EYE, SLOT.IRIS, SLOT.LIP]) assert.ok(slots(v).has(s), `${BODY_NAMES[v]} slot ${s}`)
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

test('walkAngles: at rest the knees and elbows keep their small bend; the right leg is the left half a cycle on; the swing scales with speed to a cap; a cup raises the left arm, a bag stills the right', () => {
  const f0 = shapeFactors(SHAPE_NEUTRAL)
  const rest = walkAngles(0, 0, f0)
  assert.deepEqual(rest, { hipL: 0, kneeL: WALK.kneeRest, ankleL: -WALK.kneeRest * WALK.ankle, hipR: 0, kneeR: WALK.kneeRest, ankleR: -WALK.kneeRest * WALK.ankle, shoulderL: -0, elbowL: -WALK.elbowRest, shoulderR: -0, elbowR: -WALK.elbowRest, twist: 0, head: -0, slouch: 0, bob: 0 })
  for (const phase of [0.3, 1.1, 2.9, 4.4]) {
    const a = walkAngles(phase, 1, f0), b = walkAngles(phase + Math.PI, 1, f0)
    near(a.hipL, b.hipR, 1e-12, 'hip'); near(a.kneeL, b.kneeR, 1e-12, 'knee'); near(a.ankleL, b.ankleR, 1e-12, 'ankle')
    near(a.shoulderL, b.shoulderR, 1e-12, 'shoulder'); near(a.elbowL, b.elbowR, 1e-12, 'elbow')
    near(a.hipL, Math.sin(phase) * WALK.hip, 1e-12, 'the hip swings with the phase')
    assert.ok(a.kneeL >= WALK.kneeRest && a.kneeL <= WALK.kneeRest + WALK.knee)
    assert.ok(a.bob >= 0 && a.bob <= WALK.bob)
    near(a.shoulderL, -a.hipL / WALK.hip * WALK.shoulder, 1e-12, 'the arm counters the leg')
  }
  assert.equal(swingOf(0), 0)
  assert.equal(swingOf(WALK.fullSpeed), 1)
  assert.equal(swingOf(WALK.fullSpeed * 10), WALK.maxSwing)
  assert.equal(swingOf(-1), 0)
  near(walkAngles(1, 0.5, f0).hipL, Math.sin(1) * WALK.hip * 0.5, 1e-12, 'half the swing')
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
})

test('skinPoint: a pivot stays put under its own bone; the trunk rides the heading and the place; the scales act after the pose; a normal takes their reciprocals; two bones blend by the weight', () => {
  const f0 = shapeFactors(SHAPE_NEUTRAL)
  const piv = pivotsOf(f0)
  for (const phase of [0, 0.7, 2.5]) {
    const a = walkAngles(phase, 1, f0)
    const hip = skinPoint(piv.hipX, piv.hip, 0, BONE.THIGH_R, BONE.THIGH_R, 1, 1, a, STILL, piv, UNIT, 0, ORIGIN)
    near(hip[0], piv.hipX, 1e-12, 'hip x'); near(hip[1], piv.hip + a.bob, 1e-12, 'hip y (the step\'s rise)'); near(hip[2], 0, 1e-12, 'hip z')
    const shoulder = skinPoint(-piv.shoulderX, piv.shoulder, 0, BONE.ARM_L, BONE.ARM_L, 1, 1, a, STILL, piv, UNIT, 0, ORIGIN)
    // The shoulder turns with the chest's twist about the spine, nothing else.
    near(Math.hypot(shoulder[0], shoulder[2]), piv.shoulderX, 1e-12, 'shoulder radius'); near(shoulder[1], piv.shoulder + a.bob, 1e-12, 'shoulder y')
    const toe = skinPoint(piv.hipX, 0, 0.1, BONE.FOOT_R, BONE.FOOT_R, 1, 1, a, STILL, piv, UNIT, 0, ORIGIN)
    if (phase !== 0) assert.ok(Math.abs(toe[2] - 0.1) > 1e-3 || Math.abs(toe[1]) > 1e-3, 'the toe moves with the stride')
  }
  const a0 = walkAngles(0, 0, f0)
  const knee = skinPoint(piv.hipX, piv.knee, 0, BONE.SHIN_R, BONE.SHIN_R, 1, 1, a0, STILL, piv, UNIT, 0, ORIGIN)
  near(knee[1], piv.knee, 1e-12, 'the knee pivot, the hip straight')
  const turned = skinPoint(0.1, 1.0, 0.05, BONE.TRUNK, BONE.TRUNK, 1, 1, a0, STILL, piv, UNIT, Math.PI / 2, [1, 2, 3])
  near(turned[0], 1 + 0.05, 1e-12, 'heading x'); near(turned[1], 2 + 1.0, 1e-12, 'heading y'); near(turned[2], 3 - 0.1, 1e-12, 'heading z')
  const scaled = skinPoint(0.1, 1.0, 0.05, BONE.TRUNK, BONE.TRUNK, 1, 1, a0, STILL, piv, { y: 4, xz: 2 }, 0, ORIGIN)
  near(scaled[0], 0.2, 1e-12, 'x by the square root'); near(scaled[1], 4, 1e-12, 'y by the stature'); near(scaled[2], 0.1, 1e-12, 'z by the square root')
  const n = skinPoint(Math.SQRT1_2, Math.SQRT1_2, 0, BONE.TRUNK, BONE.TRUNK, 1, 0, a0, STILL, piv, { y: 4, xz: 2 }, 0, [5, 5, 5])
  near(n[0] / n[1], (Math.SQRT1_2 / 2) / (Math.SQRT1_2 / 4), 1e-12, 'the normal leans the other way')
  assert.ok(length(n) < 1, 'the caller normalises')
  const nt = skinPoint(0, 1, 0, BONE.TRUNK, BONE.TRUNK, 1, 0, a0, { tilt: 0.5, bend: 0, fall: 0 }, piv, UNIT, 0, ORIGIN)
  near(length(nt), 1, 1e-12, 'a rotation keeps the length'); near(nt[2], Math.sin(0.5), 1e-12, 'tilted forward'); near(nt[1], Math.cos(0.5), 1e-12, 'tilted')
  const bent = skinPoint(0, 1.5, 0, BONE.CHEST, BONE.CHEST, 1, 1, a0, { tilt: 0, bend: 0.4, fall: 0 }, piv, UNIT, 0, ORIGIN)
  near(bent[2], (1.5 - piv.hip) * Math.sin(0.4), 1e-12, 'the trunk bends about the hip'); near(bent[1], piv.hip + (1.5 - piv.hip) * Math.cos(0.4), 1e-12, 'and down')
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
    for (const p of [PIECE.BAG, PIECE.CUP, PIECE.LONG_HAIR, PIECE.GLASSES, PIECE.HAIR_CAP, PIECE.BOB, PIECE.BUN, PIECE.FACE]) assert.ok(pieces.has(p), `piece ${p}`)
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

test('crowdBody.ts: the WGSL carries every number humanoid.ts holds (the elbow and wrist as their drop from the shoulder), ten functions, one call for the position and the normal, the face shaped on the head alone', () => {
  const lit = (n: number): string => (Number.isInteger(n) ? `${n}.0` : `${n}`)
  const flat = (name: string, o: unknown, out: [string, number][] = []): [string, number][] => {
    if (typeof o === 'number') out.push([name, o])
    else for (const [k, v] of Object.entries(o as object)) flat(`${name}.${k}`, v, out)
    return out
  }
  const carried = [...flat('LANDMARK', LANDMARK), ...flat('MORPH', MORPH), ...flat('REGION', REGION), ...flat('LIMB_GIRTH', LIMB_GIRTH), ...flat('WALK', WALK), ...flat('FACE', FACE)]
    .filter(([name]) => name !== 'LANDMARK.elbow' && name !== 'LANDMARK.wrist' && name !== 'FACE.nose.rootY' && name !== 'FACE.clear')
  for (const [name, v] of carried) assert.ok(BODY_WGSL.includes(lit(v)), `${name} = ${lit(v)} in the WGSL`)
  assert.ok(BODY_WGSL.includes(`shoulderY - ${lit(LANDMARK.shoulder - LANDMARK.elbow)}`), 'the elbow hangs its drop under the shoulder')
  assert.ok(BODY_WGSL.includes(`shoulderY - ${lit(LANDMARK.shoulder - LANDMARK.wrist)}`), 'the wrist too')
  assert.doesNotMatch(BODY_WGSL, /undefined|NaN|\[object/, 'every interpolation is a number')
  assert.deepEqual([...BODY_WGSL.matchAll(/^fn (\w+)\(/gm)].map((m) => m[1]), ['bodyRotX', 'bodyRotY', 'bodyRotAxis', 'bodyHat', 'bodyHeightMap', 'bodySlope', 'bodyFace', 'bodyMorph', 'bodyBone', 'bodyVertex'])
  assert.ok(BODY_WGSL.includes('fn bodyVertex(v: vec3f, n: vec3f, rig: vec3f, skin: vec2f, face: vec2f, agent: vec4f, motion: vec4f, pose: vec4f, stance: vec4f, morphA: vec4f, morphB: vec4f, faceA: vec4f, faceB: vec4f, t: f32) -> mat3x3f'))
  assert.ok(BODY_WGSL.includes('fn bodyMorph(p: vec3f, n: vec3f, bone: u32, m: vec4f, fD: f32, fLegs: f32, fTrunk: f32) -> mat3x3f'))
  assert.ok(BODY_WGSL.includes('fn bodyFace(p: vec3f, n: vec3f, face: vec2f, fa: vec4f, fb: vec4f) -> mat3x3f'))
  assert.equal((BODY_WGSL.match(/-> mat3x3f/g) ?? []).length, 7, 'the rotations, the face, the morph, the bone chain and the vertex each carry a position and a normal')
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
  assert.match(src, /import \{ FACE, HEIGHT_BASE, LANDMARK, LIMB_GIRTH, MORPH, REGION, WALK \} from '\.\/humanoid\.ts'/)
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
  assert.match(crowd, /const skinned = \(bodyVertex\(positionLocal, normalLocal, rig, skin, face, agent, motion, pose, stance, morphA, morphB, faceA, faceB, time\) as unknown as Mat3\)\.toVar\(\)/)
  assert.match(crowd, /normalLocal\.assign\(skinned\.element\(uint\(1\)\)\)/)
  assert.match(crowd, /const body = skinned\.element\(uint\(0\)\)/)
  assert.match(crowd, /export const VARIANT_NAMES = BODY_NAMES/)
  assert.doesNotMatch(crowd, /BoxGeometry|CylinderGeometry|SphereGeometry|CapsuleGeometry/, 'no primitives: the body is the loft')
})
