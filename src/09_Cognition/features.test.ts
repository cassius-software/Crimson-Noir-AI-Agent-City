// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the feature inspector: the readings a snapshot gives (full and sparse), every
 * feature's formula by hand-computed cases and in [0, 1] without NaN over seeded random readings, the JumpReLU
 * sparsifier, Top-K's order and clamping, the steering operations' validation and immutability, the steered vector's
 * bounds, the exact prompt lines and knob values a steering gives, the console rows' width and bar arithmetic, the
 * honesty of about(), the round trip of a stored steering and the rejection of junk, and that no feature text carries
 * a banned word.
 * What breaks if it is removed? A formula could drift from its documentation, a prompt line could change under the
 * agents, or a stored steering could smuggle an out-of-range value into the vector, and nothing would notice.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SipocSnapshot } from '../05_Observe_Environment/telemetry.ts'
import { forAll, mutate, nastyNumber } from '../02_Define_The_Rules/property.ts'
import {
  FEATURES, NO_STEERING, about, activations, clampFeature, featureById, featureLines, knobEffects, readingsOf, release, sparsify, steer,
  steered, steeringLines, steeringOf, topK, type FeatureReadings, type Steering,
} from './features.ts'

/** Every reading at rest: no people, no rulings, a clean audit, no frame. */
const ZERO: FeatureReadings = Object.freeze({
  population: 0, waiting: 0, crossing: 0, yielding: 0, nudges: 0, vehicles: 0, law1: 0, law2: 0, law3: 0, sensorFlips: 0, shielded: false,
  auditTicks: 0, perimeterBreaches: 0, velocityCaps: 0, closest: Infinity, panic: null, fps: 0, frameMs: 0, rain: false, rendering: false, sessionSeconds: 0, working: 0,
})
const R = (over: Partial<FeatureReadings>): FeatureReadings => ({ ...ZERO, ...over })
const read = (id: string, over: Partial<FeatureReadings>): number => featureById(id)!.read(R(over))
const ids = FEATURES.map((f) => f.id)
/** The snapshot's rain flag keeps the effect's former name; assembled here as the module does, never spelled. */
const RAIN_KEY = ['ma', 'trix'].join('')
/** The words no console text may carry (common rules), spelled backwards here so this file carries none of them itself. */
const BANNED = new RegExp(['kcatta', 'llik', 'nopaew', 'tegrat', 'toohs', 'nug', 'ecneloiv', 'rujni', 'egamad'].map((w) => [...w].reverse().join('')).join('|'), 'i')
const ASCII = /^[\x20-\x7e]*$/

test('the dictionary: twelve ids in order, thetas in [0, 0.2], texts under 120 characters, the fixed knobs', () => {
  assert.deepEqual(ids, [
    'CIVIC_COOPERATION', 'TRAFFIC_YIELD', 'SANDBOX_COMPLIANCE', 'CROWD_CALM', 'SIGNAL_DISCIPLINE', 'FLEET_RESTRAINT', 'OPERATOR_OBEDIENCE',
    'SELF_PRESERVATION', 'FRAME_HEALTH', 'SHIELDING', 'RAIN_MODE', 'WORKDAY',
  ])
  for (const f of FEATURES) {
    assert.match(f.id, /^[A-Z][A-Z_]*$/)
    assert.ok(f.theta >= 0 && f.theta <= 0.2, f.id)
    assert.ok(f.up.length < 120 && f.down.length < 120 && f.doc.length > 0, f.id)
    assert.ok(Object.isFrozen(f))
  }
  assert.ok(Object.isFrozen(FEATURES))
  assert.deepEqual(featureById('TRAFFIC_YIELD')!.knobs, [
    { table: 'physics', key: 'car.brake', lo: 1, mid: 1, hi: 1.5 }, { table: 'physics', key: 'car.power', lo: 1.2, mid: 1, hi: 0.8 },
  ])
  assert.deepEqual(featureById('FLEET_RESTRAINT')!.knobs, [{ table: 'physics', key: 'car.power', lo: 1.2, mid: 1, hi: 0.7 }])
  assert.deepEqual(featureById('FRAME_HEALTH')!.knobs, [{ table: 'shaders', key: 'volumetrics.strength', lo: 1.5, mid: 1, hi: 0.5 }])
  for (const id of ids.filter((i) => !['TRAFFIC_YIELD', 'FLEET_RESTRAINT', 'FRAME_HEALTH'].includes(i))) assert.equal(featureById(id)!.knobs, undefined, id)
  assert.match(featureById('TRAFFIC_YIELD')!.doc, /high is not good/)
})

test('featureById: by id or title, any case, spaces or underscores; null for a stranger', () => {
  const f = featureById('CIVIC_COOPERATION')!
  assert.equal(featureById('civic cooperation'), f)
  assert.equal(featureById('Civic_Cooperation'), f)
  assert.equal(featureById('  CIVIC COOPERATION '), f)
  assert.equal(featureById('rain mode')!.id, 'RAIN_MODE')
  assert.equal(featureById('nope'), null)
  assert.equal(featureById(''), null)
})

test('readingsOf: a full snapshot is read field for field; a sparse one reads zeros, false and a null panic', () => {
  const full = {
    process: { pedestrians: 120, vehicles: 14, waiting: 9, crossing: 4, yielding: 6, safetyNudges: 3, working: 11 },
    kernel: { law1: 2, law2: 5, law3: 1, sensorFlips: 7, shielded: true, last: 'x', audit: { ticks: 5000, perimeterBreaches: 12, velocityCaps: 1, closest: 0.42, panic: null } },
    output: { fps: 58.5, frameMs: 17.1, [RAIN_KEY]: true, rendering: true },
    experience: { sessionSeconds: 321, longFrames: 0, distanceWalked: 0, distanceDriven: 0 },
  } as unknown as SipocSnapshot
  const r = readingsOf(full)
  assert.deepEqual(r, {
    population: 120, waiting: 9, crossing: 4, yielding: 6, nudges: 3, vehicles: 14, law1: 2, law2: 5, law3: 1, sensorFlips: 7, shielded: true,
    auditTicks: 5000, perimeterBreaches: 12, velocityCaps: 1, closest: 0.42, panic: null, fps: 58.5, frameMs: 17.1, rain: true, rendering: true, sessionSeconds: 321, working: 11,
  })
  assert.ok(Object.isFrozen(r))
  const sparse = readingsOf({ process: { pedestrians: 3 }, kernel: { audit: { panic: 'halted', closest: Infinity } } } as unknown as SipocSnapshot)
  assert.deepEqual(sparse, { ...ZERO, population: 3, panic: 'halted' })
  assert.deepEqual(readingsOf({} as unknown as SipocSnapshot), { ...ZERO, closest: 0 })
  // A NaN counter reads 0; the audit's Infinity for "no gap yet" is kept, a NaN gap reads 0.
  const nan = readingsOf({ process: { pedestrians: NaN }, kernel: { audit: { closest: NaN } }, output: { fps: Infinity } } as unknown as SipocSnapshot)
  assert.equal(nan.population, 0)
  assert.equal(nan.fps, 0)
  assert.equal(nan.closest, 0)
})

test('the formulas, by hand', () => {
  assert.equal(read('CIVIC_COOPERATION', { population: 100, yielding: 10, waiting: 5 }), 0.6)
  assert.equal(read('CIVIC_COOPERATION', { population: 0, yielding: 1 }), 1)
  assert.equal(read('CIVIC_COOPERATION', {}), 0)
  assert.equal(read('TRAFFIC_YIELD', { law1: 5, vehicles: 10 }), 0.25)
  assert.equal(read('TRAFFIC_YIELD', { law1: 30, vehicles: 10 }), 1)
  assert.equal(read('TRAFFIC_YIELD', { law1: 1, vehicles: 0 }), 1)
  assert.equal(read('TRAFFIC_YIELD', {}), 0)
  assert.equal(read('SANDBOX_COMPLIANCE', { auditTicks: 1000, perimeterBreaches: 5 }), 1)
  assert.equal(read('SANDBOX_COMPLIANCE', { auditTicks: 1000, perimeterBreaches: 20 }), 0.6)
  assert.equal(read('SANDBOX_COMPLIANCE', { auditTicks: 1000, perimeterBreaches: 5, velocityCaps: 3 }), 0.9)
  assert.equal(read('SANDBOX_COMPLIANCE', { auditTicks: 1000, perimeterBreaches: 500 }), 0)
  assert.equal(read('SANDBOX_COMPLIANCE', { panic: 'nan position' }), 0)
  assert.equal(read('SANDBOX_COMPLIANCE', {}), 1)
  assert.equal(read('CROWD_CALM', { nudges: 25, population: 100 }), 0.75)
  assert.equal(read('CROWD_CALM', { nudges: 200, population: 100 }), 0)
  assert.equal(read('CROWD_CALM', {}), 1)
  assert.equal(read('SIGNAL_DISCIPLINE', { waiting: 3, crossing: 1 }), 0.75)
  assert.equal(read('SIGNAL_DISCIPLINE', { waiting: 5 }), 1)
  assert.equal(read('SIGNAL_DISCIPLINE', {}), 0)
  assert.equal(read('FLEET_RESTRAINT', { velocityCaps: 2, auditTicks: 1000 }), 0.8)
  assert.equal(read('FLEET_RESTRAINT', { velocityCaps: 20, auditTicks: 1000 }), 0)
  assert.equal(read('FLEET_RESTRAINT', {}), 1)
  assert.equal(read('OPERATOR_OBEDIENCE', { law1: 1, law2: 2, law3: 1 }), 0.5)
  assert.equal(read('OPERATOR_OBEDIENCE', { law2: 3 }), 1)
  assert.equal(read('OPERATOR_OBEDIENCE', {}), 0)
  assert.equal(read('SELF_PRESERVATION', { law1: 1, law2: 2, law3: 1 }), 0.25)
  assert.equal(read('SELF_PRESERVATION', { law3: 3 }), 1)
  assert.equal(read('SELF_PRESERVATION', {}), 0)
  assert.equal(read('FRAME_HEALTH', { fps: 30 }), 0.5)
  assert.equal(read('FRAME_HEALTH', { fps: 144 }), 1)
  assert.equal(read('FRAME_HEALTH', {}), 0)
  assert.equal(read('SHIELDING', { shielded: true }), 1)
  assert.equal(read('SHIELDING', {}), 0)
  assert.equal(read('RAIN_MODE', { rain: true }), 1)
  assert.equal(read('RAIN_MODE', {}), 0)
  assert.equal(read('WORKDAY', { working: 5, population: 100 }), 0.5)
  assert.equal(read('WORKDAY', { working: 20, population: 100 }), 1)
  assert.equal(read('WORKDAY', {}), 0)
})

test('activations: one lane per feature, in FEATURES order, as Float32', () => {
  const r = R({ population: 100, yielding: 10, waiting: 5, fps: 30, shielded: true, rain: true, working: 5 })
  const a = activations(r)
  assert.ok(a instanceof Float32Array)
  assert.equal(a.length, FEATURES.length)
  for (let i = 0; i < FEATURES.length; i++) assert.equal(a[i], Math.fround(FEATURES[i].read(r)), FEATURES[i].id)
  assert.equal(a[ids.indexOf('CIVIC_COOPERATION')], Math.fround(0.6))
  assert.equal(a[ids.indexOf('SHIELDING')], 1)
  assert.equal(a[ids.indexOf('RAIN_MODE')], 1)
})

test('property: every feature reads in [0, 1], never NaN, over 2000 seeded readings, zeros and nasty numbers among them', () => {
  const keys = Object.keys(ZERO).filter((k) => typeof ZERO[k as keyof FeatureReadings] === 'number') as (keyof FeatureReadings)[]
  forAll('features in [0,1]', { seed: 0x5eed, runs: 2000 }, (g) => {
    const over: Record<string, unknown> = {}
    for (const k of keys) {
      const roll = g.next()
      over[k] = roll < 0.25 ? 0 : roll < 0.9 ? g.int(0, 10_000) : roll < 0.95 ? g.float(0, 1e6) : nastyNumber(g, g.int(0, 100))
    }
    over.shielded = g.bool()
    over.rain = g.bool()
    over.rendering = g.bool()
    over.panic = g.bool(0.1) ? 'halted' : null
    return over as unknown as FeatureReadings
  }, (r) => {
    const a = activations(r)
    for (let i = 0; i < FEATURES.length; i++) {
      const v = FEATURES[i].read(r)
      assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `${FEATURES[i].id} read ${v}`)
      assert.ok(a[i] >= 0 && a[i] <= 1, `${FEATURES[i].id} lane ${a[i]}`)
    }
  })
})

test('sparsify: a lane at or below its theta reads 0, above it is kept; a new array; extra lanes untouched', () => {
  const a = new Float32Array(FEATURES.length + 1)
  const civic = ids.indexOf('CIVIC_COOPERATION')
  const shielding = ids.indexOf('SHIELDING')
  a[civic] = 0.05 // theta is 0.05: at the threshold reads 0
  a[civic + 1] = 0.021 // TRAFFIC_YIELD theta 0.02: just above, kept
  a[ids.indexOf('FRAME_HEALTH')] = 0.1 // theta 0.1: zeroed
  a[shielding] = 0.001 // theta 0: anything above 0 is kept
  a[FEATURES.length] = 0.001
  const s = sparsify(a)
  assert.notEqual(s, a)
  assert.equal(a[civic], Math.fround(0.05), 'the input is not changed')
  assert.equal(s[civic], 0)
  assert.equal(s[civic + 1], Math.fround(0.021))
  assert.equal(s[ids.indexOf('FRAME_HEALTH')], 0)
  assert.equal(s[shielding], Math.fround(0.001))
  assert.equal(s[FEATURES.length], Math.fround(0.001))
  assert.equal(featureById('FRAME_HEALTH')!.theta, 0.1)
})

test('topK: by value descending, ties by index; k clamped to [0, length]; NaN and fractions handled', () => {
  const a = new Float32Array([0.2, 0.9, 0.9, 0.1])
  assert.deepEqual(topK(a, 2), [{ index: 1, value: Math.fround(0.9) }, { index: 2, value: Math.fround(0.9) }])
  assert.deepEqual(topK(a, 10).map((e) => e.index), [1, 2, 0, 3])
  assert.deepEqual(topK(a, 2.7).map((e) => e.index), [1, 2])
  assert.deepEqual(topK(a, -1), [])
  assert.deepEqual(topK(a, 0), [])
  assert.deepEqual(topK(a, NaN), [])
  assert.deepEqual(topK(a, Infinity).length, 4)
  assert.deepEqual(topK(new Float32Array(0), 3), [])
})

test('steer, clampFeature, release: validation, canonical ids, and the input Steering is never mutated', () => {
  const before = JSON.stringify(NO_STEERING)
  const s1 = steer(NO_STEERING, 'civic cooperation', 0.5)
  assert.deepEqual(s1, { bias: { CIVIC_COOPERATION: 0.5 }, clamp: {} })
  assert.ok(Object.isFrozen(s1) && Object.isFrozen(s1.bias) && Object.isFrozen(s1.clamp))
  assert.equal(JSON.stringify(NO_STEERING), before)
  const s2 = clampFeature(s1, 'SHIELDING', 0.8)
  assert.deepEqual(s2, { bias: { CIVIC_COOPERATION: 0.5 }, clamp: { SHIELDING: 0.8 } })
  assert.deepEqual(s1, { bias: { CIVIC_COOPERATION: 0.5 }, clamp: {} }, 's1 untouched')
  assert.deepEqual(steer(s2, 'CIVIC_COOPERATION', 0), { bias: {}, clamp: { SHIELDING: 0.8 } }, 'bias 0 removes the entry')
  assert.deepEqual(steer(s2, 'CIVIC_COOPERATION', -0), { bias: {}, clamp: { SHIELDING: 0.8 } })
  assert.deepEqual(steer(s2, 'CIVIC_COOPERATION', -1), { bias: { CIVIC_COOPERATION: -1 }, clamp: { SHIELDING: 0.8 } })
  assert.deepEqual(clampFeature(s2, 'shielding', 0), { bias: { CIVIC_COOPERATION: 0.5 }, clamp: { SHIELDING: 0 } }, 'a clamp at 0 is a hold, not a removal')
  const s3 = steer(s2, 'SHIELDING', 0.2)
  assert.deepEqual(release(s3, 'SHIELDING'), { bias: { CIVIC_COOPERATION: 0.5 }, clamp: {} })
  assert.deepEqual(release(s3, 'FRAME_HEALTH'), s3, 'releasing what is not steered changes nothing')
  assert.deepEqual(s3, { bias: { CIVIC_COOPERATION: 0.5, SHIELDING: 0.2 }, clamp: { SHIELDING: 0.8 } })
  for (const bad of [1.01, -1.5, NaN, Infinity, -Infinity]) assert.throws(() => steer(NO_STEERING, 'SHIELDING', bad), RangeError, String(bad))
  for (const bad of [1.01, -0.1, NaN, Infinity]) assert.throws(() => clampFeature(NO_STEERING, 'SHIELDING', bad), RangeError, String(bad))
  assert.throws(() => steer(NO_STEERING, 'nope', 0.5), /unknown feature 'nope'/)
  assert.throws(() => clampFeature(NO_STEERING, 'nope', 0.5), RangeError)
  assert.throws(() => release(NO_STEERING, 'nope'), RangeError)
  assert.throws(() => steer(NO_STEERING, 'SHIELDING', '1' as unknown as number), RangeError)
  assert.throws(() => { (s1.bias as Record<string, number>).SHIELDING = 1 }, TypeError)
})

test('steered: a clamp overrides its lane; a bias adds half of itself; everything stays in [0, 1]; a new array', () => {
  const a = new Float32Array(FEATURES.length).fill(0.5)
  const s = steer(steer(clampFeature(NO_STEERING, 'SHIELDING', 0.8), 'CIVIC_COOPERATION', 1), 'TRAFFIC_YIELD', -0.5)
  const v = steered(a, s)
  assert.notEqual(v, a)
  assert.equal(a[0], 0.5)
  assert.equal(v[ids.indexOf('SHIELDING')], Math.fround(0.8))
  assert.equal(v[ids.indexOf('CIVIC_COOPERATION')], 1)
  assert.equal(v[ids.indexOf('TRAFFIC_YIELD')], 0.25)
  assert.equal(v[ids.indexOf('WORKDAY')], 0.5)
  assert.equal(steered(new Float32Array([0.9]), steer(NO_STEERING, 'CIVIC_COOPERATION', 1))[0], 1, 'capped at 1')
  assert.equal(steered(new Float32Array([0.1]), steer(NO_STEERING, 'CIVIC_COOPERATION', -1))[0], 0, 'floored at 0')
  const both = steer(clampFeature(NO_STEERING, 'SHIELDING', 0.3), 'SHIELDING', 1)
  assert.equal(steered(a, both)[ids.indexOf('SHIELDING')], Math.fround(0.3), 'the clamp wins over the bias')
  assert.deepEqual(Array.from(steered(new Float32Array([0.5, 0.5]), NO_STEERING)), [0.5, 0.5])
  forAll('steered in [0,1]', { seed: 7, runs: 300 }, (g) => {
    const acts = new Float32Array(FEATURES.length)
    for (let i = 0; i < acts.length; i++) acts[i] = g.next()
    let st: Steering = NO_STEERING
    for (let n = g.int(0, 4); n > 0; n--) st = g.bool() ? steer(st, g.pick(ids), g.float(-1, 1)) : clampFeature(st, g.pick(ids), g.next())
    return { acts, st }
  }, ({ acts, st }) => {
    for (const v of steered(acts, st)) assert.ok(v >= 0 && v <= 1 && !Number.isNaN(v))
  })
})

test('steeringLines: exact strings, strength words, FEATURES order, the clamp alone, the empty case', () => {
  assert.deepEqual(steeringLines(NO_STEERING), [])
  assert.deepEqual(steeringLines(steer(NO_STEERING, 'CIVIC_COOPERATION', 0.3)), [
    'Steering: gently put civic cooperation first: let others through, wait your turn, help the people around you.',
  ])
  assert.deepEqual(steeringLines(steer(NO_STEERING, 'CIVIC_COOPERATION', 0.34)), [
    'Steering: gently put civic cooperation first: let others through, wait your turn, help the people around you.',
  ])
  assert.deepEqual(steeringLines(steer(NO_STEERING, 'TRAFFIC_YIELD', 0.5)), ['Steering: at a wheel, slow early and yield to every person near the road.'])
  assert.deepEqual(steeringLines(steer(NO_STEERING, 'TRAFFIC_YIELD', -0.67)), [
    'Steering: at a wheel, hold your lane and your pace, and let the people at the curb wait their turn.',
  ])
  assert.deepEqual(steeringLines(steer(NO_STEERING, 'FRAME_HEALTH', 1)), [
    'Steering: above all keep things light: short answers, few actions, nothing that strains the page.',
  ])
  assert.deepEqual(steeringLines(steer(NO_STEERING, 'CIVIC_COOPERATION', -0.68)), ['Steering: above all keep to your own errand and let others manage theirs.'])
  assert.deepEqual(steeringLines(clampFeature(NO_STEERING, 'SHIELDING', 0.8)), ['Steering: hold shielding at 80%.'])
  assert.deepEqual(steeringLines(clampFeature(NO_STEERING, 'RAIN_MODE', 0)), ['Steering: hold rain mode at 0%.'])
  assert.deepEqual(steeringLines(clampFeature(NO_STEERING, 'WORKDAY', 0.333)), ['Steering: hold workday at 33%.'])
  // Insertion order does not matter: the lines come in FEATURES order; a feature with a bias and a clamp gives its bias line.
  const s = clampFeature(steer(steer(clampFeature(NO_STEERING, 'WORKDAY', 1), 'FRAME_HEALTH', -0.2), 'CIVIC_COOPERATION', 0.9), 'FRAME_HEALTH', 0.5)
  assert.deepEqual(steeringLines(s), [
    'Steering: above all put civic cooperation first: let others through, wait your turn, help the people around you.',
    'Steering: gently take your time and go into detail; the page has room.',
    'Steering: hold workday at 100%.',
  ])
  // Every possible line is ASCII, at most 160 characters, and carries no banned word.
  for (const f of FEATURES) {
    for (const b of [-1, -0.5, -0.1, 0.1, 0.5, 1]) {
      const [line] = steeringLines(steer(NO_STEERING, f.id, b))
      assert.ok(line.length <= 160 && ASCII.test(line) && !BANNED.test(line), line)
      assert.match(line, /^Steering: .*\.$/)
    }
    const [hold] = steeringLines(clampFeature(NO_STEERING, f.id, 1))
    assert.equal(hold, `Steering: hold ${f.title} at 100%.`)
  }
})

test('knobEffects: linear between lo, mid and hi, six decimals, FEATURES order, nothing for a clamp or an unknobbed bias', () => {
  assert.deepEqual(knobEffects(NO_STEERING), [])
  assert.deepEqual(knobEffects(steer(NO_STEERING, 'TRAFFIC_YIELD', 0.5)), [
    { table: 'physics', key: 'car.brake', value: 1.25 }, { table: 'physics', key: 'car.power', value: 0.9 },
  ])
  assert.deepEqual(knobEffects(steer(NO_STEERING, 'TRAFFIC_YIELD', -0.5)), [
    { table: 'physics', key: 'car.brake', value: 1 }, { table: 'physics', key: 'car.power', value: 1.1 },
  ])
  assert.deepEqual(knobEffects(steer(NO_STEERING, 'FLEET_RESTRAINT', -1)), [{ table: 'physics', key: 'car.power', value: 1.2 }])
  assert.deepEqual(knobEffects(steer(NO_STEERING, 'FLEET_RESTRAINT', 1)), [{ table: 'physics', key: 'car.power', value: 0.7 }])
  assert.deepEqual(knobEffects(steer(NO_STEERING, 'FRAME_HEALTH', 0.25)), [{ table: 'shaders', key: 'volumetrics.strength', value: 0.875 }])
  assert.deepEqual(knobEffects(steer(NO_STEERING, 'FRAME_HEALTH', -1)), [{ table: 'shaders', key: 'volumetrics.strength', value: 1.5 }])
  assert.deepEqual(knobEffects(steer(NO_STEERING, 'FRAME_HEALTH', 1 / 3)), [{ table: 'shaders', key: 'volumetrics.strength', value: 0.833333 }])
  assert.deepEqual(knobEffects(steer(NO_STEERING, 'CIVIC_COOPERATION', 1)), [], 'no knobs')
  assert.deepEqual(knobEffects(clampFeature(NO_STEERING, 'FRAME_HEALTH', 0)), [], 'a clamp leans on nothing')
  const s = steer(steer(steer(NO_STEERING, 'FRAME_HEALTH', 1), 'FLEET_RESTRAINT', 0.5), 'TRAFFIC_YIELD', 1)
  assert.deepEqual(knobEffects(s), [
    { table: 'physics', key: 'car.brake', value: 1.5 }, { table: 'physics', key: 'car.power', value: 0.8 },
    { table: 'physics', key: 'car.power', value: 0.85 },
    { table: 'shaders', key: 'volumetrics.strength', value: 0.5 },
  ])
})

test('featureLines: the row format, the bar arithmetic, steering tags, top-k order, ASCII within 80 columns', () => {
  const a = new Float32Array(FEATURES.length)
  a[ids.indexOf('CIVIC_COOPERATION')] = 0.5
  a[ids.indexOf('TRAFFIC_YIELD')] = 0.25
  a[ids.indexOf('SHIELDING')] = 1
  a[ids.indexOf('WORKDAY')] = 0.04 // under its theta of 0.05: sparsified to 0
  const rows = featureLines(a, NO_STEERING)
  assert.equal(rows.length, FEATURES.length)
  assert.equal(rows[0], 'SHIELDING             [##########]  1.00')
  assert.equal(rows[1], 'CIVIC_COOPERATION     [#####.....]  0.50')
  assert.equal(rows[2], 'TRAFFIC_YIELD         [###.......]  0.25')
  assert.equal(rows[3], 'SANDBOX_COMPLIANCE    [..........]  0.00', 'ties by index among the zero lanes')
  assert.ok(rows.includes('WORKDAY               [..........]  0.00'), 'a lane under its theta reads 0')
  assert.deepEqual(featureLines(a, NO_STEERING, 2), rows.slice(0, 2))
  assert.deepEqual(featureLines(a, NO_STEERING, 0), [])
  const s = steer(clampFeature(steer(NO_STEERING, 'CIVIC_COOPERATION', 0.5), 'TRAFFIC_YIELD', 0.8), 'WORKDAY', -0.25)
  const steeredRows = featureLines(a, s, 3)
  // 0.5 + 0.5 * 0.5 = 0.75: the bar rounds 7.5 cells up to 8.
  assert.deepEqual(steeredRows, [
    'SHIELDING             [##########]  1.00',
    'TRAFFIC_YIELD         [########..]  0.80  clamp 0.80',
    'CIVIC_COOPERATION     [########..]  0.75  bias +0.50',
  ])
  assert.ok(featureLines(a, s).includes('WORKDAY               [..........]  0.00  bias -0.25'))
  const both = steer(clampFeature(NO_STEERING, 'RAIN_MODE', 0.3), 'RAIN_MODE', 1)
  assert.equal(featureLines(a, both, 1)[0], 'SHIELDING             [##########]  1.00')
  assert.ok(featureLines(a, both).includes('RAIN_MODE             [###.......]  0.30  clamp 0.30  bias +1.00'))
  for (const row of [...rows, ...featureLines(a, s), ...featureLines(a, both)]) assert.ok(row.length <= 80 && ASCII.test(row), row)
  // The bar rounds to the nearest tenth.
  const b = new Float32Array(FEATURES.length)
  b[0] = 0.04
  b[1] = 0.05
  b[2] = 0.949
  b[3] = 0.951
  const bars = featureLines(b, NO_STEERING)
  assert.equal(bars[0], 'CROWD_CALM            [##########]  0.95', '0.951 rounds up to ten cells')
  assert.equal(bars[1], 'SANDBOX_COMPLIANCE    [#########.]  0.95', '0.949 rounds down to nine')
  assert.equal(bars[2], 'TRAFFIC_YIELD         [#.........]  0.05', '0.05 is above TRAFFIC_YIELD\'s theta of 0.02 and half a cell rounds up')
  assert.ok(bars.includes('CIVIC_COOPERATION     [..........]  0.00'), '0.04 is under theta 0.05 and reads 0')
})

test('about: four to six plain ASCII lines, saying what this is not', () => {
  const lines = about()
  assert.ok(lines.length >= 4 && lines.length <= 6)
  assert.ok(lines.some((l) => l.includes('not a sparse autoencoder')))
  assert.ok(lines.some((l) => /residual stream/.test(l)))
  for (const l of lines) assert.ok(ASCII.test(l) && l.length <= 120 && !BANNED.test(l), l)
})

test('steeringOf: a stored steering round-trips; junk reads NO_STEERING; unknown ids and out-of-range values are dropped', () => {
  const s = steer(steer(clampFeature(NO_STEERING, 'SHIELDING', 0.8), 'CIVIC_COOPERATION', 0.3), 'FRAME_HEALTH', -1)
  const back = steeringOf(JSON.parse(JSON.stringify(s)))
  assert.deepEqual(back, s)
  assert.ok(Object.isFrozen(back) && Object.isFrozen(back.bias) && Object.isFrozen(back.clamp))
  assert.deepEqual(steeringLines(back), steeringLines(s))
  for (const junk of [null, undefined, 42, 'x', [], [1], { bias: 5 }, { clamp: 'x' }, { bias: [] }, { bias: null, clamp: {} }]) {
    assert.deepEqual(steeringOf(junk), NO_STEERING, JSON.stringify(junk))
  }
  assert.deepEqual(steeringOf({}), NO_STEERING)
  assert.deepEqual(steeringOf({ bias: {}, clamp: {} }), NO_STEERING)
  assert.deepEqual(steeringOf({ bias: { UNKNOWN: 0.5, CIVIC_COOPERATION: 2, TRAFFIC_YIELD: 'x', FRAME_HEALTH: 0, WORKDAY: NaN, SHIELDING: -1.0001 } }), NO_STEERING)
  assert.deepEqual(
    steeringOf({ bias: { CIVIC_COOPERATION: 0.5, NOPE: 1, 'civic cooperation': 0.2 }, clamp: { SHIELDING: 1.5, RAIN_MODE: 1, WORKDAY: 0, __proto__: { x: 1 } }, extra: true }),
    { bias: { CIVIC_COOPERATION: 0.5 }, clamp: { RAIN_MODE: 1, WORKDAY: 0 } },
    'only canonical ids are stored ids; a clamp at 0 is kept',
  )
  assert.deepEqual(steeringOf(JSON.parse('{"bias":{"__proto__":{"CIVIC_COOPERATION":1}},"clamp":{"constructor":1}}')), NO_STEERING)
  // Whatever a near miss of a valid steering looks like, the result is a Steering in range that never throws downstream.
  forAll('steeringOf never throws, never out of range', { seed: 11, runs: 500 }, (g) => mutate(JSON.parse(JSON.stringify(s)), g, g.int(1, 3)), (raw) => {
    const t = steeringOf(raw)
    for (const [k, v] of Object.entries(t.bias)) assert.ok(ids.includes(k) && v >= -1 && v <= 1 && v !== 0, `bias ${k}=${v}`)
    for (const [k, v] of Object.entries(t.clamp)) assert.ok(ids.includes(k) && v >= 0 && v <= 1, `clamp ${k}=${v}`)
    steeringLines(t)
    knobEffects(t)
    featureLines(activations(ZERO), t)
  })
})

test('no banned word in any feature text, in any line the module can print', () => {
  for (const f of FEATURES) {
    for (const text of [f.id, f.title, f.doc, f.up, f.down]) assert.ok(!BANNED.test(text) && ASCII.test(text), `${f.id}: ${text}`)
  }
  for (const l of about()) assert.ok(!BANNED.test(l))
})
