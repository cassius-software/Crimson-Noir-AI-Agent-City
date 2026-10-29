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
import { BODY_WGSL, statureFactor } from './crowdBody.ts'
import {
  BODY_NAMES, BONE, BONES, EYE_LEVEL, HEIGHT_BASE, LANDMARK, LIMB_GIRTH, MORPH, PIECE, REGION, SHAPE_NEUTRAL, SLOT, WALK,
  bodyTubes, boneGroup, boneSide, boneTransform, eyeHeightOf, heightMap, humanoidMesh, morphNormal, morphPoint, pivotsOf, scaleOf,
  shapeFactors, silhouetteRings, skinPoint, swingOf, walkAngles,
  type BodyPose, type BodyShape,
} from './humanoid.ts'
import { LOOK_BODIES, LOOK_PIECE_BIT } from './look.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const near = (got: number, want: number, tol: number, what: string) => assert.ok(Math.abs(got - want) <= tol, `${what}: ${got} vs ${want}`)
const shape = (over: Partial<BodyShape>): BodyShape => ({ ...SHAPE_NEUTRAL, ...over })
const STILL: BodyPose = { tilt: 0, bend: 0, fall: 0 }
const UNIT = { y: 1, xz: 1 }
const ORIGIN = [0, 0, 0] as const
const length = (v: number[]) => Math.hypot(v[0], v[1], v[2])
const VARIANTS = [0, 1, 2, 3]

// --- The tables ------------------------------------------------------------------------------------------------

test('the tables: four bodies named as the wardrobe names them, the pieces where the look\'s bits are, fifteen bones in three groups on two sides', () => {
  assert.deepEqual([...BODY_NAMES], [...LOOK_BODIES])
  assert.deepEqual(LOOK_PIECE_BIT, { tie: PIECE.TIE, bag: PIECE.BAG, cup: PIECE.CUP, longHair: PIECE.LONG_HAIR, glasses: PIECE.GLASSES })
  assert.equal(PIECE.NONE, 0)
  assert.equal(BONES, 15)
  assert.deepEqual([...Object.values(BONE)].sort((a, b) => a - b), Array.from({ length: 15 }, (_, i) => i))
  assert.deepEqual(Array.from({ length: 15 }, (_, b) => boneGroup(b)), [0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2])
  assert.deepEqual(Array.from({ length: 15 }, (_, b) => boneSide(b)), [0, 0, 0, -1, -1, -1, 1, 1, 1, -1, -1, -1, 1, 1, 1])
  assert.deepEqual([...Object.values(SLOT)].sort((a, b) => a - b), Array.from({ length: 10 }, (_, i) => i))
  for (const table of [BONE, SLOT, PIECE, LANDMARK, MORPH, REGION, LIMB_GIRTH, WALK, SHAPE_NEUTRAL]) assert.ok(Object.isFrozen(table))
  // The landmarks climb the body.
  assert.ok(LANDMARK.ankle < LANDMARK.knee && LANDMARK.knee < LANDMARK.hip && LANDMARK.hip < LANDMARK.chestPivot)
  assert.ok(LANDMARK.chestPivot < LANDMARK.shoulder && LANDMARK.shoulder < LANDMARK.neck && LANDMARK.neck < EYE_LEVEL && EYE_LEVEL < HEIGHT_BASE)
  assert.ok(LANDMARK.wrist < LANDMARK.elbow && LANDMARK.elbow < LANDMARK.shoulder)
  assert.equal(HEIGHT_BASE, 1.75)
  assert.equal(SHAPE_NEUTRAL.height, HEIGHT_BASE)
})

// --- The mesh --------------------------------------------------------------------------------------------------

test('every body, near and far: finite, indexed within range, every vertex on a bone with a slot and a piece, weights 0..1, unit normals, within budget, deterministic', () => {
  const counts: Record<string, [number, number]> = {}
  for (const v of VARIANTS) for (const detailed of [true, false]) {
    const m = humanoidMesh(v, detailed)
    const name = `${BODY_NAMES[v]} ${detailed ? 'near' : 'far'}`
    assert.equal(m.position.length, m.vertexCount * 3)
    assert.equal(m.normal.length, m.vertexCount * 3)
    assert.equal(m.rig.length, m.vertexCount * 3)
    assert.equal(m.skin.length, m.vertexCount * 2)
    assert.equal(m.index.length % 3, 0)
    assert.ok(m.index instanceof Uint32Array)
    for (const x of m.position) assert.ok(Number.isFinite(x))
    for (const i of m.index) assert.ok(i < m.vertexCount, `${name}: index ${i}`)
    const bones = new Set<number>()
    for (let i = 0; i < m.vertexCount; i++) {
      const bone = m.rig[i * 3], slot = m.rig[i * 3 + 1], piece = m.rig[i * 3 + 2], bone1 = m.skin[i * 2], w = m.skin[i * 2 + 1]
      assert.ok(Number.isInteger(bone) && bone >= 0 && bone < BONES, `${name}: bone ${bone}`)
      assert.ok(Number.isInteger(bone1) && bone1 >= 0 && bone1 < BONES, `${name}: second bone ${bone1}`)
      assert.ok(Number.isInteger(slot) && slot >= 0 && slot < 10, `${name}: slot ${slot}`)
      assert.ok(Number.isInteger(piece) && piece >= 0 && piece <= PIECE.GLASSES, `${name}: piece ${piece}`)
      assert.ok(w >= 0 && w <= 1, `${name}: weight ${w}`)
      near(Math.hypot(m.normal[i * 3], m.normal[i * 3 + 1], m.normal[i * 3 + 2]), 1, 1e-3, `${name}: normal ${i}`)
      assert.ok(m.position[i * 3 + 1] >= -1e-6 && m.position[i * 3 + 1] <= HEIGHT_BASE + 0.05, `${name}: y ${m.position[i * 3 + 1]}`)
      bones.add(bone)
    }
    assert.equal(bones.size, BONES, `${name}: every bone carries skin`)
    assert.ok(m.vertexCount <= (detailed ? 1200 : 400), `${name}: ${m.vertexCount} vertices`)
    assert.ok(m.index.length / 3 <= (detailed ? 2000 : 700), `${name}: ${m.index.length / 3} triangles`)
    counts[name] = [m.vertexCount, m.index.length / 3]
    const again = humanoidMesh(v, detailed)
    assert.deepEqual(again.position, m.position)
    assert.deepEqual(again.index, m.index)
    assert.deepEqual(again.rig, m.rig)
    assert.deepEqual(again.skin, m.skin)
  }
  // The far body is the smaller by far; the outfits differ in their rings, not only their colours.
  for (const v of VARIANTS) assert.ok(counts[`${BODY_NAMES[v]} far`][0] * 2 < counts[`${BODY_NAMES[v]} near`][0])
  assert.notDeepEqual(humanoidMesh(1).position, humanoidMesh(2).position, 'a man\'s trunk and a woman\'s')
  assert.notDeepEqual(humanoidMesh(2).position, humanoidMesh(3).position, 'the skirt')
  assert.deepEqual(humanoidMesh(7).position, humanoidMesh(3).position, 'clamped')
  assert.deepEqual(humanoidMesh(Number.NaN).position, humanoidMesh(0).position)
})

test('the pieces: the suit alone has a tie; the cup, the glasses and the tie are near-only; the bag and long hair reach the far body; the arms hang at rest', () => {
  const pieces = (v: number, detailed: boolean) => { const m = humanoidMesh(v, detailed); return new Set(Array.from({ length: m.vertexCount }, (_, i) => m.rig[i * 3 + 2])) }
  assert.deepEqual([...pieces(0, true)].sort(), [0, 1, 2, 3, 4, 5])
  for (const v of [1, 2, 3]) assert.deepEqual([...pieces(v, true)].sort(), [0, 2, 3, 4, 5], BODY_NAMES[v])
  for (const v of VARIANTS) {
    assert.deepEqual([...pieces(v, false)].sort(), [PIECE.NONE, PIECE.BAG, PIECE.LONG_HAIR], `${BODY_NAMES[v]} far`)
    for (const p of pieces(v, false)) assert.ok(pieces(v, true).has(p), 'the far body wears nothing the near one lacks')
  }
  const slots = (v: number) => { const m = humanoidMesh(v); return new Set(Array.from({ length: m.vertexCount }, (_, i) => m.rig[i * 3 + 1])) }
  assert.ok(slots(0).has(SLOT.ACCENT), 'the tie\'s cloth')
  assert.ok(slots(3).has(SLOT.LEGWEAR) && !slots(2).has(SLOT.LEGWEAR), 'hose under the skirt alone')
  for (const v of VARIANTS) for (const s of [SLOT.TOP, SLOT.SHIRT, SLOT.SKIN, SLOT.HAIR, SLOT.BOTTOM, SLOT.SHOES, SLOT.PROP, SLOT.FRAME]) assert.ok(slots(v).has(s), `${BODY_NAMES[v]} slot ${s}`)
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
    for (const p of [PIECE.BAG, PIECE.CUP, PIECE.LONG_HAIR, PIECE.GLASSES]) assert.ok(pieces.has(p), `piece ${p}`)
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

// --- The WGSL --------------------------------------------------------------------------------------------------

test('crowdBody.ts: the WGSL carries every number humanoid.ts holds (the elbow and wrist as their drop from the shoulder), nine functions, one call for the position and the normal', () => {
  const lit = (n: number): string => (Number.isInteger(n) ? `${n}.0` : `${n}`)
  const flat = (name: string, o: unknown, out: [string, number][] = []): [string, number][] => {
    if (typeof o === 'number') out.push([name, o])
    else for (const [k, v] of Object.entries(o as object)) flat(`${name}.${k}`, v, out)
    return out
  }
  const carried = [...flat('LANDMARK', LANDMARK), ...flat('MORPH', MORPH), ...flat('REGION', REGION), ...flat('LIMB_GIRTH', LIMB_GIRTH), ...flat('WALK', WALK)]
    .filter(([name]) => name !== 'LANDMARK.elbow' && name !== 'LANDMARK.wrist')
  for (const [name, v] of carried) assert.ok(BODY_WGSL.includes(lit(v)), `${name} = ${lit(v)} in the WGSL`)
  assert.ok(BODY_WGSL.includes(`shoulderY - ${lit(LANDMARK.shoulder - LANDMARK.elbow)}`), 'the elbow hangs its drop under the shoulder')
  assert.ok(BODY_WGSL.includes(`shoulderY - ${lit(LANDMARK.shoulder - LANDMARK.wrist)}`), 'the wrist too')
  assert.doesNotMatch(BODY_WGSL, /undefined|NaN|\[object/, 'every interpolation is a number')
  assert.deepEqual([...BODY_WGSL.matchAll(/^fn (\w+)\(/gm)].map((m) => m[1]), ['bodyRotX', 'bodyRotY', 'bodyRotAxis', 'bodyHat', 'bodyHeightMap', 'bodySlope', 'bodyMorph', 'bodyBone', 'bodyVertex'])
  assert.ok(BODY_WGSL.includes('fn bodyVertex(v: vec3f, n: vec3f, rig: vec3f, skin: vec2f, agent: vec4f, motion: vec4f, pose: vec4f, stance: vec4f, morphA: vec4f, morphB: vec4f, t: f32) -> mat3x3f'))
  assert.ok(BODY_WGSL.includes('fn bodyMorph(p: vec3f, n: vec3f, bone: u32, m: vec4f, fD: f32, fLegs: f32, fTrunk: f32) -> mat3x3f'))
  assert.equal((BODY_WGSL.match(/-> mat3x3f/g) ?? []).length, 6, 'the rotations, the morph, the bone chain and the vertex each carry a position and a normal')
  assert.ok(BODY_WGSL.includes('return mat3x3f(world, normalize('), 'the world position and a unit normal')
  for (const piece of ['mask', 'holdingCup', 'carryingBag']) assert.ok(BODY_WGSL.includes(piece), piece)
  const src = read('./crowdBody.ts')
  assert.match(src, /^(?:\/\/[^\n]*\n)*\/\*\*\n \* Why does this file exist\?[\s\S]*What breaks if it is removed\?/, 'the header')
  assert.match(src, /import \{ HEIGHT_BASE, LANDMARK, LIMB_GIRTH, MORPH, REGION, WALK \} from '\.\/humanoid\.ts'/)
  assert.match(src, /export const bodyVertex = fn\('bodyVertex', \[heightMapFn, morphFn, boneFn, rotAxis\]\)/)
  assert.doesNotMatch(src, /from 'three\/webgpu'|three\/src/, 'nodes only: no renderer')
  assert.equal(statureFactor(HEIGHT_BASE), 1)
  assert.equal(statureFactor(HEIGHT_BASE * 2), 2)
})

test('crowd.ts: the geometry is humanoid.ts\'s mesh with its rig and skin attributes, and the vertex stage is one bodyVertex call whose columns are the position and the normal', () => {
  const crowd = read('./crowd.ts')
  assert.match(crowd, /import \{ bodyVertex \} from '\.\/crowdBody\.ts'/)
  assert.match(crowd, /return geometryOf\(humanoidMesh\(v, detailed\)\)/)
  assert.match(crowd, /g\.setAttribute\('rig', new Float32BufferAttribute\(mesh\.rig, 3\)\)/)
  assert.match(crowd, /g\.setAttribute\('skin', new Float32BufferAttribute\(mesh\.skin, 2\)\)/)
  assert.match(crowd, /g\.setIndex\(new Uint32BufferAttribute\(mesh\.index, 1\)\)/)
  assert.match(crowd, /const g = bodyGeometry\(v, lod === 0\)/, 'the far body past the lod cut')
  assert.match(crowd, /const rig = attribute\('rig', 'vec3'\)\n\s*const skin = attribute\('skin', 'vec2'\)/)
  assert.match(crowd, /const skinned = \(bodyVertex\(positionLocal, normalLocal, rig, skin, agent, motion, pose, stance, morphA, morphB, time\) as unknown as Mat3\)\.toVar\(\)/)
  assert.match(crowd, /normalLocal\.assign\(skinned\.element\(uint\(1\)\)\)/)
  assert.match(crowd, /const body = skinned\.element\(uint\(0\)\)/)
  assert.match(crowd, /export const VARIANT_NAMES = BODY_NAMES/)
  assert.doesNotMatch(crowd, /BoxGeometry|CylinderGeometry|SphereGeometry|CapsuleGeometry/, 'no primitives: the body is the loft')
})
