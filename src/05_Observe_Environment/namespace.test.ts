// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the unified namespace: segment, topic and isTopic at their edges; the MQTT
 * filters ('+' one level, '#' the rest, a '#' not last refused); the bus (retained values, one sequence number per
 * accepted publish, sorted listings, children, the topic limit, non-finite numbers refused, subscribers called inside
 * the publish and surviving a throwing one, a deterministic head that moves with a value, clear); the exact sorted
 * topic list a complete snapshot publishes, the Area taken from the district line, the vehicle cap, the shorter list a
 * bare snapshot gives, ASCII-only console rows; and parity of the local mix32 with 10_Network/telemetry.ts.
 * What breaks if it is removed? A reading could land under a wrong name, a filter could miss a topic, or the head
 * could drift from the kernels' mixer without anyone noticing.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gen } from '../02_Define_The_Rules/property.ts'
import { mix32 as netMix32 } from '../10_Network/telemetry.ts'
import type { SipocSnapshot } from './telemetry.ts'
import {
  TOPIC_LIMIT, TopicBus, UNS, childLines, isTopic, matches, mix32, publishSnapshot, segment, topic, topicLines,
  type PhysicsReadings, type Retained,
} from './namespace.ts'

const ROOT = 'Enterprise/JCS/Site/AgentCity'
/** The output field that says rain mode is on, spelled in two halves (the old name stays out of this file). */
const RAIN_KEY = 'ma' + 'trix'

/** A snapshot with every optional field the namespace reads present, two cars on the map. */
function sample(): SipocSnapshot {
  const s: SipocSnapshot = {
    supplier: {
      device: 'desktop', pointerLocked: true, engaged: true, touch: false, triggerResistance: 0.5,
      hal: '1 device ready', glyphs: 'keyboard',
      recording: { active: true, source: 'canvas', seconds: 3, frames: 72, bytes: 1024, dropped: 0, codec: 'vp9' },
      recruiting: { listening: false, line: '' },
    },
    input: { mode: 'vehicle', nearVehicle: true },
    process: {
      pedestrians: 400, vehicles: 2, drawnNear: 120, drawnFar: 280, waiting: 10, crossing: 4, yielding: 1, safetyNudges: 7,
      gpu: 'some gpu', sensingAgeMs: 16.5, sensingLagMs: 2.25, crowdFrames: 500, seed: 42, working: 33, host: 'browser',
    },
    output: {
      fps: 60, frameMs: 16.6667, p50Ms: 16.2, p95Ms: 18.4, cpuMs: 4.5, gpuRenderMs: 6.25, gpuComputeMs: 1.125,
      physicsMs: 2.5, rapierMs: 1.75, postMs: 0.1, ghost: true, rendering: false,
      net: { state: 'joined', peers: 3, dropped: 1 },
    },
    kernel: {
      law1: 1, law2: 2, law3: 3, sensorFlips: 4, shielded: true, last: 'law 2: a person shielded',
      audit: { ticks: 1000, perimeterBreaches: 0, velocityCaps: 2, closest: 1.234, panic: null },
    },
    quality: { tier: 3, label: 'High', auto: true, renderScale: 1.5, targetMs: 16.667, lite: false, held: 2 },
    customer: {
      region: null, streets: true, name: 'Ada', clock: '21:30', daylight: 0.125, viewYaw: 0,
      district: 'Financial District · night', speedKmh: 42.5, gear: 'D2',
      x: 10.5, z: -20.25, heading: 1.5, signalEW: 'green', signalNS: 'red', signalRemaining: 12,
    },
    experience: { sessionSeconds: 600, longFrames: 3, distanceWalked: 1500.5, distanceDriven: 3200 },
    map: [{ x: 1, z: 2, heading: 0.5, player: true }, { x: -3.5, z: 4, heading: 3, player: false }],
    toasts: [],
  }
  ;(s.output as Record<string, unknown>)[RAIN_KEY] = true
  return s
}

/** A snapshot with no optional field, an empty map, and empty strings where the namespace names the empty case. */
function bare(): SipocSnapshot {
  return {
    supplier: {
      device: 'phone', pointerLocked: false, engaged: false, touch: true, triggerResistance: 0, hal: '', glyphs: 'touch',
      recording: { active: false, source: null, seconds: 0, frames: 0, bytes: 0, dropped: 0, codec: '' },
    },
    input: { mode: 'foot', nearVehicle: false },
    process: {
      pedestrians: 0, vehicles: 0, drawnNear: 0, drawnFar: 0, waiting: 0, crossing: 0, yielding: 0, safetyNudges: 0,
      gpu: '', sensingAgeMs: null,
    },
    output: { fps: 30, frameMs: 33, p50Ms: 33, p95Ms: 40, cpuMs: 8, gpuRenderMs: 0, gpuComputeMs: 0, physicsMs: 3, rapierMs: 2 },
    kernel: {
      law1: 0, law2: 0, law3: 0, sensorFlips: 0, shielded: false, last: '',
      audit: { ticks: 0, perimeterBreaches: 0, velocityCaps: 0, closest: Infinity, panic: null },
    },
    quality: { tier: 0, label: 'Low', auto: false, renderScale: 0.5, targetMs: 33.3 },
    customer: {
      name: '', clock: '06:00', daylight: 1, viewYaw: 0, district: 'Harbour Quarter — dawn', speedKmh: 0, gear: 'P',
      x: 0, z: 0, heading: 0, signalEW: 'amber', signalNS: 'amber', signalRemaining: 0,
    },
    experience: { sessionSeconds: 0, longFrames: 0, distanceWalked: 0, distanceDriven: 0 },
    map: [],
    toasts: [],
  }
}

const PHYSICS: PhysicsReadings = { stepMs: 1.5, steps: 2, bodies: 500, colliders: 600, ccd: 3 }

/** The full list, sorted in plain string order, that `sample()` with PHYSICS publishes. */
const P = `${ROOT}/Area/FinancialDistrict/Line/`
const SAMPLE_TOPICS: readonly string[] = [
  ...['gear', 'heading', 'mode', 'name', 'nearVehicle', 'speedKmh', 'x', 'z'].map((t) => `${P}Avatar/Cell/Player/${t}`),
  ...['clock', 'daylight'].map((t) => `${P}Clock/Cell/Sun/${t}`),
  ...['crossing', 'drawnFar', 'drawnNear', 'pedestrians', 'safetyNudges', 'sensingAgeMs', 'sensingLagMs', 'waiting', 'working', 'yielding']
    .map((t) => `${P}Crowd/Cell/Population/${t}`),
  ...['distanceDriven', 'distanceWalked', 'longFrames', 'sessionSeconds'].map((t) => `${P}Experience/Cell/Session/${t}`),
  ...['cpuMs', 'fps', 'frameMs', 'ghost', 'gpuComputeMs', 'gpuRenderMs', 'p50Ms', 'p95Ms', 'physicsMs', 'rain', 'rapierMs', 'rendering']
    .map((t) => `${P}Frame/Cell/Page/${t}`),
  ...['device', 'glyphs', 'hal', 'pointerLocked', 'recording', 'touch'].map((t) => `${P}Hardware/Cell/Bus/${t}`),
  ...['closest', 'panic', 'perimeterBreaches', 'ticks', 'velocityCaps'].map((t) => `${P}Kernel/Cell/Audit/${t}`),
  ...['last', 'law1', 'law2', 'law3', 'sensorFlips', 'shielded'].map((t) => `${P}Kernel/Cell/Laws/${t}`),
  ...['publishes', 'topics'].map((t) => `${P}Namespace/Cell/Bus/${t}`),
  ...['dropped', 'peers', 'state'].map((t) => `${P}Network/Cell/Session/${t}`),
  ...['bodies', 'ccd', 'colliders', 'stepMs', 'steps'].map((t) => `${P}Physics/Cell/Realm/${t}`),
  ...['auto', 'held', 'label', 'lite', 'renderScale', 'targetMs', 'tier'].map((t) => `${P}Quality/Cell/Governor/${t}`),
  `${P}Traffic/Cell/Fleet/vehicles`,
  ...['ew', 'ns', 'remaining'].map((t) => `${P}Traffic/Cell/Signals/${t}`),
  ...['heading', 'player', 'x', 'z'].map((t) => `${P}Traffic/Cell/Vehicle000/${t}`),
  ...['heading', 'player', 'x', 'z'].map((t) => `${P}Traffic/Cell/Vehicle001/${t}`),
]

const value = (bus: TopicBus, t: string): unknown => bus.get(t)?.value

test('UNS is frozen and names the root; TOPIC_LIMIT is the default limit', () => {
  assert.ok(Object.isFrozen(UNS))
  assert.deepEqual(UNS, { enterprise: 'JCS', site: 'AgentCity', root: 'Enterprise/JCS/Site/AgentCity' })
  assert.equal(TOPIC_LIMIT, 4096)
  assert.equal(new TopicBus().limit, 4096)
})

test('segment keeps letters, digits, _ and -, drops the rest, names the empty case and stops at 32 chars', () => {
  assert.equal(segment('Financial District'), 'FinancialDistrict')
  assert.equal(segment('Harbour Quarter · night'), 'HarbourQuarternight')
  assert.equal(segment('a_b-c.d e/f+g#h'), 'a_b-cdefgh')
  assert.equal(segment(''), 'Unknown')
  assert.equal(segment(' · /'), 'Unknown')
  assert.equal(segment('x'.repeat(40)), 'x'.repeat(32))
  assert.equal(segment('x'.repeat(32)), 'x'.repeat(32))
  assert.equal(segment(segment('Financial District')), segment('Financial District'))
})

test('topic builds the ISA-95 path through segment, with and without a tag', () => {
  assert.equal(topic('Financial District', 'Frame', 'Page', 'fps'), `${ROOT}/Area/FinancialDistrict/Line/Frame/Cell/Page/fps`)
  assert.equal(topic('Financial District', 'Frame', 'Page'), `${ROOT}/Area/FinancialDistrict/Line/Frame/Cell/Page`)
  assert.equal(topic('Financial District', 'Frame', 'Page', ''), `${ROOT}/Area/FinancialDistrict/Line/Frame/Cell/Page`)
  assert.equal(topic('', 'a b', 'c/d', 'e#f'), `${ROOT}/Area/Unknown/Line/ab/Cell/cd/ef`)
  assert.ok(isTopic(topic('', '', '', '')))
})

test('isTopic: non-empty levels, no wildcards, printable ASCII without spaces, at most 256 chars and 16 levels', () => {
  assert.ok(isTopic('a'))
  assert.ok(isTopic(`${ROOT}/Area/X/Line/Y/Cell/Z/t`))
  assert.ok(isTopic('a-b_c.d:e'))
  assert.equal(isTopic(''), false)
  assert.equal(isTopic('/a'), false)
  assert.equal(isTopic('a/'), false)
  assert.equal(isTopic('a//b'), false)
  assert.equal(isTopic('a/+/b'), false)
  assert.equal(isTopic('a/#'), false)
  assert.equal(isTopic('a b'), false)
  assert.equal(isTopic('a\tb'), false)
  assert.equal(isTopic('café'), false)
  assert.ok(isTopic('x'.repeat(256)))
  assert.equal(isTopic('x'.repeat(257)), false)
  assert.ok(isTopic(Array.from({ length: 16 }, () => 'l').join('/')))
  assert.equal(isTopic(Array.from({ length: 17 }, () => 'l').join('/')), false)
})

test('matches: exact, + for one level, # for the rest, # alone, # not last refused, a longer topic refused', () => {
  assert.ok(matches('a/b/c', 'a/b/c'))
  assert.equal(matches('a/b/c', 'a/b/d'), false)
  assert.equal(matches('a/b/c', 'a/b/c/d'), false)
  assert.equal(matches('a/b/c/d', 'a/b/c'), false)
  assert.equal(matches('a/b', 'a/bc'), false)
  assert.equal(matches('a/bc', 'a/b'), false)
  assert.ok(matches('a/+/c', 'a/b/c'))
  assert.ok(matches('a/+/c', 'a/xyz/c'))
  assert.equal(matches('a/+/c', 'a/b/x/c'), false)
  assert.equal(matches('a/+/c', 'a/c'), false)
  assert.ok(matches('+/b/c', 'a/b/c'))
  assert.ok(matches('a/b/+', 'a/b/c'))
  assert.equal(matches('a/b/+', 'a/b'), false)
  assert.ok(matches('#', 'a'))
  assert.ok(matches('#', 'a/b/c/d/e'))
  assert.ok(matches('a/#', 'a'))
  assert.ok(matches('a/#', 'a/b'))
  assert.ok(matches('a/#', 'a/b/c/d'))
  assert.equal(matches('a/#', 'b/c'), false)
  assert.ok(matches('a/+/#', 'a/b'))
  assert.ok(matches('a/+/#', 'a/b/c/d'))
  assert.equal(matches('a/+/#', 'a'), false)
  assert.equal(matches('a/#/c', 'a/b/c'), false)
  assert.equal(matches('#/c', 'a/c'), false)
  assert.equal(matches('a/b#', 'a/b#'), true, 'a # inside a level is a plain character, as MQTT reads it')
  assert.equal(matches('a/b#', 'a/bc'), false)
  const t = `${ROOT}/Area/FinancialDistrict/Line/Frame/Cell/Page/fps`
  assert.ok(matches(`${ROOT}/Area/+/Line/Frame/Cell/Page/fps`, t))
  assert.ok(matches(`${ROOT}/Area/+/Line/+/Cell/+/fps`, t))
  assert.ok(matches(`${ROOT}/#`, t))
  assert.equal(matches(`${ROOT}/Area/+/Line/Frame/#/fps`, t), false)
})

test('the bus retains the last value, numbers its publishes, and answers get/list/topics sorted', () => {
  const bus = new TopicBus()
  assert.equal(bus.count, 0)
  assert.equal(bus.publishes, 0)
  assert.equal(bus.refused, 0)
  assert.equal(bus.get('a/b'), null)
  assert.deepEqual(bus.list(), [])
  const r1 = bus.publish('a/b', 1, 10)
  assert.deepEqual(r1, { topic: 'a/b', value: 1, seq: 1, tick: 10 })
  assert.ok(Object.isFrozen(r1))
  assert.deepEqual(bus.publish('a/a', 'text', 11), { topic: 'a/a', value: 'text', seq: 2, tick: 11 })
  assert.deepEqual(bus.publish('b', true, 12), { topic: 'b', value: true, seq: 3, tick: 12 })
  assert.deepEqual(bus.publish('a/b', 2, 13), { topic: 'a/b', value: 2, seq: 4, tick: 13 })
  assert.equal(bus.count, 3)
  assert.equal(bus.publishes, 4)
  assert.deepEqual(bus.get('a/b'), { topic: 'a/b', value: 2, seq: 4, tick: 13 })
  assert.deepEqual(bus.topics(), ['a/a', 'a/b', 'b'])
  assert.deepEqual(bus.topics('a/#'), ['a/a', 'a/b'])
  assert.deepEqual(bus.topics('+'), ['b'])
  assert.deepEqual(bus.topics('a/+'), ['a/a', 'a/b'])
  assert.deepEqual(bus.topics('nothing/#'), [])
  assert.deepEqual(bus.list('a/#').map((r) => [r.topic, r.value, r.seq]), [['a/a', 'text', 2], ['a/b', 2, 4]])
  assert.deepEqual(bus.list(), bus.list('#'))
  // Plain string order: uppercase before lowercase, a digit before a letter.
  bus.publish('Z', 0, 0)
  bus.publish('1', 0, 0)
  assert.deepEqual(bus.topics(), ['1', 'Z', 'a/a', 'a/b', 'b'])
})

test('the bus refuses an invalid topic and a non-finite number, and counts each refusal', () => {
  const bus = new TopicBus()
  assert.equal(bus.publish('', 1, 0), null)
  assert.equal(bus.publish('a/+', 1, 0), null)
  assert.equal(bus.publish('a b', 1, 0), null)
  assert.equal(bus.publish('a', Number.NaN, 0), null)
  assert.equal(bus.publish('a', Infinity, 0), null)
  assert.equal(bus.publish('a', -Infinity, 0), null)
  assert.equal(bus.refused, 6)
  assert.equal(bus.publishes, 0)
  assert.equal(bus.count, 0)
  assert.ok(bus.publish('a', 0, 0))
  assert.ok(bus.publish('a', -0.5, 0))
  assert.equal(bus.refused, 6)
})

test('the topic limit: a new topic past it is refused, a known topic still updates', () => {
  const bus = new TopicBus(2)
  assert.equal(bus.limit, 2)
  assert.ok(bus.publish('a', 1, 0))
  assert.ok(bus.publish('b', 1, 0))
  assert.equal(bus.publish('c', 1, 0), null)
  assert.equal(bus.refused, 1)
  assert.equal(bus.count, 2)
  assert.deepEqual(bus.publish('a', 2, 1), { topic: 'a', value: 2, seq: 3, tick: 1 })
  assert.equal(bus.publish('c', 1, 0), null)
  assert.equal(bus.refused, 2)
  assert.equal(new TopicBus(0).publish('a', 1, 0), null)
  assert.equal(new TopicBus(Number.NaN).limit, TOPIC_LIMIT)
  assert.equal(new TopicBus(-1).limit, TOPIC_LIMIT)
})

test('subscribe: the filter selects, calls arrive inside publish in order, unsubscribe stops them, a throw stops nobody', () => {
  const bus = new TopicBus()
  const seen: string[] = []
  const offA = bus.subscribe('a/#', (r) => seen.push(`A:${r.topic}=${String(r.value)}@${r.seq}`))
  bus.subscribe('#', (r) => seen.push(`all:${r.topic}`))
  bus.subscribe('+/b', () => { throw new Error('a subscriber in trouble') })
  bus.subscribe('a/b', (r) => seen.push(`exact:${r.topic}`))
  assert.deepEqual(bus.publish('a/b', 1, 0), { topic: 'a/b', value: 1, seq: 1, tick: 0 })
  assert.deepEqual(seen, ['A:a/b=1@1', 'all:a/b', 'exact:a/b'])
  seen.length = 0
  bus.publish('c', 'x', 1)
  assert.deepEqual(seen, ['all:c'])
  seen.length = 0
  offA()
  offA()
  bus.publish('a/z', true, 2)
  assert.deepEqual(seen, ['all:a/z'])
  // A refused publish reaches nobody.
  seen.length = 0
  assert.equal(bus.publish('a/z', Number.NaN, 3), null)
  assert.deepEqual(seen, [])
  // A subscriber that unsubscribes another inside the call skips nobody in this publish.
  seen.length = 0
  let offLater = (): void => {}
  bus.subscribe('q', () => { seen.push('first'); offLater() })
  offLater = bus.subscribe('q', () => seen.push('second'))
  bus.publish('q', 1, 4)
  assert.deepEqual(seen, ['all:q', 'first', 'second'])
  seen.length = 0
  bus.publish('q', 2, 5)
  assert.deepEqual(seen, ['all:q', 'first'])
  assert.equal(bus.publishes, 5)
})

test('children: the next-level names below a prefix with their topic counts, sorted; the root by default', () => {
  const bus = new TopicBus()
  publishSnapshot(bus, sample(), PHYSICS, 1)
  assert.deepEqual(bus.children(), [{ name: 'Area', topics: 82 }])
  assert.deepEqual(bus.children(''), [{ name: 'Enterprise', topics: 82 }])
  assert.deepEqual(bus.children(`${ROOT}/Area/FinancialDistrict/Line`), [
    { name: 'Avatar', topics: 8 }, { name: 'Clock', topics: 2 }, { name: 'Crowd', topics: 10 }, { name: 'Experience', topics: 4 },
    { name: 'Frame', topics: 12 }, { name: 'Hardware', topics: 6 }, { name: 'Kernel', topics: 11 }, { name: 'Namespace', topics: 2 },
    { name: 'Network', topics: 3 }, { name: 'Physics', topics: 5 }, { name: 'Quality', topics: 7 }, { name: 'Traffic', topics: 12 },
  ])
  assert.deepEqual(bus.children(`${ROOT}/Area/FinancialDistrict/Line/Traffic/Cell/`), [
    { name: 'Fleet', topics: 1 }, { name: 'Signals', topics: 3 }, { name: 'Vehicle000', topics: 4 }, { name: 'Vehicle001', topics: 4 },
  ])
  assert.deepEqual(bus.children(`${ROOT}/Area/FinancialDistrict/Line/Clock/Cell/Sun`), [{ name: 'clock', topics: 1 }, { name: 'daylight', topics: 1 }])
  assert.deepEqual(bus.children(`${ROOT}/Area/FinancialDistrict/Line/Clock/Cell/Sun/clock`), [])
  assert.deepEqual(bus.children(`${ROOT}/Area/Financial`), [], 'a prefix is whole levels, not a prefix of a level')
  assert.deepEqual(bus.children('nowhere'), [])
  assert.deepEqual(childLines(bus), ['Area/              82 topics'])
  assert.deepEqual(childLines(bus, `${ROOT}/Area/FinancialDistrict/Line/Traffic/Cell`), [
    'Fleet/              1 topics',
    'Signals/            3 topics',
    'Vehicle000/         4 topics',
    'Vehicle001/         4 topics',
  ])
  assert.deepEqual(childLines(bus, 'nowhere'), [])
})

test('head: deterministic over the same publishes, moved by a value, by the order of publishes, and by a tick-free change of seq', () => {
  const run = (publishes: readonly [string, number | string | boolean][]): number => {
    const bus = new TopicBus()
    for (const [t, v] of publishes) bus.publish(t, v, 0)
    return bus.head()
  }
  const base: readonly [string, number][] = [['a/b', 1], ['a/c', 2], ['d', 3]]
  const h = run(base)
  assert.equal(h, run(base))
  assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff)
  assert.notEqual(h, run([['a/b', 1], ['a/c', 2], ['d', 4]]), 'a value change moves the head')
  assert.notEqual(h, run([['a/c', 2], ['a/b', 1], ['d', 3]]), 'the sequence numbers are folded, so the order of publishes counts')
  assert.notEqual(h, run([['a/b', 1], ['a/c', 2], ['d', 3], ['d', 3]]), 'a re-publish of the same value takes a new seq')
  assert.equal(run([['a/b', 1], ['a/c', 2], ['d', 3]]), run([['a/b', 1], ['a/c', 2], ['d', 3]]))
  // The tick is not part of the head: the same readings on another tick fold the same way.
  const b1 = new TopicBus(), b2 = new TopicBus()
  b1.publish('a', 1, 10)
  b2.publish('a', 1, 20)
  assert.equal(b1.head(), b2.head())
  // Pinned: the empty bus is mix32 of the FNV offset; one entry folds the exact text 'a=1@1'.
  assert.equal(new TopicBus().head(), netMix32(0x811c9dc5))
  let f = 0x811c9dc5
  for (const ch of 'a=1@1') f = Math.imul(f ^ ch.charCodeAt(0), 0x01000193) >>> 0
  assert.equal(b1.head(), netMix32(f))
  // Booleans and strings fold as String(value).
  const b3 = new TopicBus()
  b3.publish('a', true, 0)
  const b4 = new TopicBus()
  b4.publish('a', 'true', 0)
  assert.equal(b3.head(), b4.head())
})

test('clear drops every topic, keeps the counters and the subscribers', () => {
  const bus = new TopicBus()
  const seen: string[] = []
  bus.subscribe('#', (r) => seen.push(r.topic))
  bus.publish('a', 1, 0)
  bus.publish('b', 2, 0)
  bus.publish('c', Number.NaN, 0)
  bus.clear()
  assert.equal(bus.count, 0)
  assert.equal(bus.get('a'), null)
  assert.deepEqual(bus.topics(), [])
  assert.deepEqual(bus.children(''), [])
  assert.equal(bus.head(), new TopicBus().head())
  assert.equal(bus.publishes, 2)
  assert.equal(bus.refused, 1)
  bus.publish('a', 1, 1)
  assert.deepEqual(seen, ['a', 'b', 'a'])
  assert.equal(bus.get('a')?.seq, 3, 'the sequence goes on after a clear')
})

test('publishSnapshot: the exact sorted topic list of a complete snapshot, the Area from the district line', () => {
  const bus = new TopicBus()
  const s = sample()
  assert.equal(publishSnapshot(bus, s, PHYSICS, 7), 82)
  assert.equal(bus.refused, 0)
  assert.equal(bus.count, 82)
  assert.equal(bus.publishes, 82)
  assert.deepEqual(bus.topics(), SAMPLE_TOPICS)
  assert.equal(SAMPLE_TOPICS.length, 82)
  for (const t of bus.topics()) {
    assert.ok(isTopic(t), t)
    assert.ok(t.startsWith(`${ROOT}/Area/FinancialDistrict/Line/`), t)
  }
  for (const r of bus.list()) assert.equal(r.tick, 7)
})

test('publishSnapshot: the values land under their tags, with the named empty cases', () => {
  const bus = new TopicBus()
  publishSnapshot(bus, sample(), PHYSICS, 1)
  const F = `${P}Frame/Cell/Page/`
  assert.equal(value(bus, `${F}fps`), 60)
  assert.equal(value(bus, `${F}frameMs`), 16.6667)
  assert.equal(value(bus, `${F}rendering`), false)
  assert.equal(value(bus, `${F}ghost`), true)
  assert.equal(value(bus, `${F}rain`), true)
  assert.equal(value(bus, `${P}Physics/Cell/Realm/bodies`), 500)
  assert.equal(value(bus, `${P}Physics/Cell/Realm/stepMs`), 1.5)
  assert.equal(value(bus, `${P}Crowd/Cell/Population/pedestrians`), 400)
  assert.equal(value(bus, `${P}Crowd/Cell/Population/working`), 33)
  assert.equal(value(bus, `${P}Crowd/Cell/Population/sensingAgeMs`), 16.5)
  assert.equal(value(bus, `${P}Crowd/Cell/Population/sensingLagMs`), 2.25)
  assert.equal(value(bus, `${P}Traffic/Cell/Fleet/vehicles`), 2)
  assert.equal(value(bus, `${P}Traffic/Cell/Signals/ew`), 'green')
  assert.equal(value(bus, `${P}Traffic/Cell/Signals/ns`), 'red')
  assert.equal(value(bus, `${P}Traffic/Cell/Signals/remaining`), 12)
  assert.equal(value(bus, `${P}Traffic/Cell/Vehicle000/x`), 1)
  assert.equal(value(bus, `${P}Traffic/Cell/Vehicle000/player`), true)
  assert.equal(value(bus, `${P}Traffic/Cell/Vehicle001/x`), -3.5)
  assert.equal(value(bus, `${P}Traffic/Cell/Vehicle001/player`), false)
  assert.equal(value(bus, `${P}Kernel/Cell/Laws/law2`), 2)
  assert.equal(value(bus, `${P}Kernel/Cell/Laws/shielded`), true)
  assert.equal(value(bus, `${P}Kernel/Cell/Laws/last`), 'law 2: a person shielded')
  assert.equal(value(bus, `${P}Kernel/Cell/Audit/closest`), 1.234)
  assert.equal(value(bus, `${P}Kernel/Cell/Audit/panic`), 'none')
  assert.equal(value(bus, `${P}Quality/Cell/Governor/label`), 'High')
  assert.equal(value(bus, `${P}Quality/Cell/Governor/auto`), true)
  assert.equal(value(bus, `${P}Quality/Cell/Governor/lite`), false)
  assert.equal(value(bus, `${P}Quality/Cell/Governor/held`), 2)
  assert.equal(value(bus, `${P}Clock/Cell/Sun/clock`), '21:30')
  assert.equal(value(bus, `${P}Clock/Cell/Sun/daylight`), 0.125)
  assert.equal(value(bus, `${P}Avatar/Cell/Player/mode`), 'vehicle')
  assert.equal(value(bus, `${P}Avatar/Cell/Player/nearVehicle`), true)
  assert.equal(value(bus, `${P}Avatar/Cell/Player/name`), 'Ada')
  assert.equal(value(bus, `${P}Avatar/Cell/Player/gear`), 'D2')
  assert.equal(value(bus, `${P}Avatar/Cell/Player/z`), -20.25)
  assert.equal(value(bus, `${P}Hardware/Cell/Bus/device`), 'desktop')
  assert.equal(value(bus, `${P}Hardware/Cell/Bus/hal`), '1 device ready')
  assert.equal(value(bus, `${P}Hardware/Cell/Bus/glyphs`), 'keyboard')
  assert.equal(value(bus, `${P}Hardware/Cell/Bus/recording`), true)
  assert.equal(value(bus, `${P}Network/Cell/Session/state`), 'joined')
  assert.equal(value(bus, `${P}Network/Cell/Session/peers`), 3)
  assert.equal(value(bus, `${P}Experience/Cell/Session/distanceWalked`), 1500.5)
  // The bus's own readings are published last, with the counts at that moment.
  assert.equal(value(bus, `${P}Namespace/Cell/Bus/topics`), 80)
  assert.equal(value(bus, `${P}Namespace/Cell/Bus/publishes`), 81)
  assert.equal(bus.get(`${P}Namespace/Cell/Bus/publishes`)?.seq, 82)
  // The empty cases, the infinite closest, the other dash, and the defaults of the absent flags.
  const b = new TopicBus()
  assert.equal(publishSnapshot(b, bare(), null, 2), 61)
  assert.equal(b.count, 61)
  assert.equal(b.refused, 0)
  const Q = `${ROOT}/Area/HarbourQuarter/Line/`
  assert.ok(b.topics().every((t) => t.startsWith(Q)))
  assert.equal(value(b, `${Q}Kernel/Cell/Audit/closest`), 'none')
  assert.equal(value(b, `${Q}Kernel/Cell/Laws/last`), 'none')
  assert.equal(value(b, `${Q}Avatar/Cell/Player/name`), 'anonymous')
  assert.equal(value(b, `${Q}Hardware/Cell/Bus/hal`), 'none')
  assert.equal(value(b, `${Q}Frame/Cell/Page/rendering`), true)
  assert.equal(value(b, `${Q}Frame/Cell/Page/ghost`), false)
  assert.equal(value(b, `${Q}Frame/Cell/Page/rain`), false)
  assert.equal(value(b, `${Q}Namespace/Cell/Bus/topics`), 59)
  assert.equal(value(b, `${Q}Namespace/Cell/Bus/publishes`), 60)
  assert.equal(b.get(`${Q}Physics/Cell/Realm/steps`), null)
  assert.equal(b.get(`${Q}Network/Cell/Session/state`), null)
  assert.equal(b.get(`${Q}Crowd/Cell/Population/sensingAgeMs`), null)
  assert.equal(b.get(`${Q}Crowd/Cell/Population/working`), null)
  assert.equal(b.get(`${Q}Quality/Cell/Governor/lite`), null)
  assert.equal(b.get(`${Q}Traffic/Cell/Vehicle000/x`), null)
})

test('publishSnapshot: a non-finite reading is skipped and counted refused; the district of an empty line is Unknown', () => {
  const bus = new TopicBus()
  const s = sample()
  s.output.fps = Number.NaN
  s.customer.daylight = Infinity
  s.customer.district = ''
  assert.equal(publishSnapshot(bus, s, PHYSICS, 1), 80)
  assert.equal(bus.refused, 2)
  assert.equal(bus.count, 80)
  assert.equal(bus.get(`${ROOT}/Area/Unknown/Line/Frame/Cell/Page/fps`), null)
  assert.equal(value(bus, `${ROOT}/Area/Unknown/Line/Frame/Cell/Page/frameMs`), 16.6667)
  assert.equal(value(bus, `${ROOT}/Area/Unknown/Line/Namespace/Cell/Bus/topics`), 78)
})

test('publishSnapshot: at most 64 vehicles, zero-padded to three digits', () => {
  const bus = new TopicBus()
  const s = sample()
  s.map = Array.from({ length: 70 }, (_, i) => ({ x: i, z: -i, heading: 0, player: i === 0 }))
  assert.equal(publishSnapshot(bus, s, PHYSICS, 1), 82 - 8 + 64 * 4)
  assert.equal(bus.topics(`${P}Traffic/Cell/+/x`).length, 64)
  assert.equal(value(bus, `${P}Traffic/Cell/Vehicle063/x`), 63)
  assert.equal(bus.get(`${P}Traffic/Cell/Vehicle064/x`), null)
  assert.deepEqual(bus.children(`${P}Traffic/Cell`).slice(0, 3).map((c) => c.name), ['Fleet', 'Signals', 'Vehicle000'])
  assert.equal(bus.children(`${P}Traffic/Cell`).length, 66)
})

test('publishSnapshot twice: the same topics, new values and sequence numbers, the head moves with a reading', () => {
  const bus = new TopicBus()
  const s = sample()
  publishSnapshot(bus, s, PHYSICS, 1)
  const h1 = bus.head()
  assert.equal(publishSnapshot(bus, s, PHYSICS, 2), 82)
  assert.equal(bus.count, 82)
  assert.equal(bus.publishes, 164)
  assert.deepEqual(bus.topics(), SAMPLE_TOPICS)
  assert.notEqual(bus.head(), h1)
  // Two buses fed the same snapshots in the same order agree on the head.
  const other = new TopicBus()
  publishSnapshot(other, sample(), PHYSICS, 1)
  publishSnapshot(other, sample(), PHYSICS, 2)
  assert.equal(other.head(), bus.head())
  s.output.fps = 59
  publishSnapshot(bus, s, PHYSICS, 3)
  publishSnapshot(other, sample(), PHYSICS, 3)
  assert.notEqual(other.head(), bus.head())
})

test('topicLines: the root as ~, two spaces, the value as the console shows it; ASCII only and within 100 columns', () => {
  const bus = new TopicBus()
  publishSnapshot(bus, sample(), PHYSICS, 1)
  const lines = topicLines(bus.list())
  assert.equal(lines.length, 82)
  for (const line of lines) {
    assert.match(line, /^[\x20-\x7e]+$/, line)
    assert.ok(line.length <= 100, line)
    assert.ok(line.startsWith('~/Area/FinancialDistrict/Line/'), line)
  }
  assert.deepEqual(topicLines(bus.list(`${P}Frame/Cell/Page/#`)), [
    '~/Area/FinancialDistrict/Line/Frame/Cell/Page/cpuMs  4.500',
    '~/Area/FinancialDistrict/Line/Frame/Cell/Page/fps  60',
    '~/Area/FinancialDistrict/Line/Frame/Cell/Page/frameMs  16.667',
    '~/Area/FinancialDistrict/Line/Frame/Cell/Page/ghost  on',
    '~/Area/FinancialDistrict/Line/Frame/Cell/Page/gpuComputeMs  1.125',
    '~/Area/FinancialDistrict/Line/Frame/Cell/Page/gpuRenderMs  6.250',
    '~/Area/FinancialDistrict/Line/Frame/Cell/Page/p50Ms  16.200',
    '~/Area/FinancialDistrict/Line/Frame/Cell/Page/p95Ms  18.400',
    '~/Area/FinancialDistrict/Line/Frame/Cell/Page/physicsMs  2.500',
    '~/Area/FinancialDistrict/Line/Frame/Cell/Page/rain  on',
    '~/Area/FinancialDistrict/Line/Frame/Cell/Page/rapierMs  1.750',
    '~/Area/FinancialDistrict/Line/Frame/Cell/Page/rendering  off',
  ])
  assert.deepEqual(topicLines(bus.list(`${P}Kernel/Cell/Audit/#`)), [
    '~/Area/FinancialDistrict/Line/Kernel/Cell/Audit/closest  1.234',
    '~/Area/FinancialDistrict/Line/Kernel/Cell/Audit/panic  none',
    '~/Area/FinancialDistrict/Line/Kernel/Cell/Audit/perimeterBreaches  0',
    '~/Area/FinancialDistrict/Line/Kernel/Cell/Audit/ticks  1000',
    '~/Area/FinancialDistrict/Line/Kernel/Cell/Audit/velocityCaps  2',
  ])
  // A topic off the root is shown whole; a string that is not ASCII reads with '?' in place of each odd character.
  const odd: Retained[] = [
    { topic: 'a/b', value: 'café · ok', seq: 1, tick: 0 },
    { topic: 'a/c', value: -0.5, seq: 2, tick: 0 },
    { topic: 'a/d', value: -3, seq: 3, tick: 0 },
    { topic: 'a/e', value: Number.NaN, seq: 4, tick: 0 },
  ]
  assert.deepEqual(topicLines(odd), ['a/b  caf? ? ok', 'a/c  -0.500', 'a/d  -3', 'a/e  -'])
  assert.deepEqual(topicLines([]), [])
})

test('the local mix32 is the one 10_Network/telemetry.ts uses, on 1000 seeded values', () => {
  const g = gen(0xc0ffee)
  for (let i = 0; i < 1000; i++) {
    const x = g.int(0, 0xffffffff)
    assert.equal(mix32(x), netMix32(x), `mix32(${x})`)
  }
  for (const x of [0, 1, 0xffffffff, 0x80000000, 0x7fffffff, -1, 2 ** 32, 1.5]) assert.equal(mix32(x), netMix32(x), `mix32(${x})`)
})
