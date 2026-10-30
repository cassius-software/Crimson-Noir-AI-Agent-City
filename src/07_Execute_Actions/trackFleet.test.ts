// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the scheduled craft stream in Node, with no physics engine: the fleet lists
 * every train set, drone and plane of the network in buffer order with its kind code and track id; over two hours
 * of realm time at half-second steps every value it writes is finite and passes the Ring-0 craft audit, every
 * train stands on the deck within 1.5 m of the elevated loop at a speed the timetable allows, every drone flies at
 * 40 or 46 m and every plane at 400 m, the three train sets never come within their spacing, and the arc length
 * and speed fields agree with the positions; the buffer is periodic in each craft's lap and a pure function of the
 * clock whatever was written before; every sample clears every building box of four seeds by the craft's envelope;
 * and the class refuses a short buffer or a bad index and is frozen.
 * What breaks if it is removed? A timetable, a corridor or a packing change could send a train off its deck, a
 * drone into a tower or a NaN into the page, and only the live audit would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TRACKS, buildTrackNetwork, lapSeconds, poseAt, projectOnto, scheduledCount, scheduledPose, type Track } from '../06_Make_Decisions/tracks.ts'
import { CITY, generateBuildings, type Box } from '../01_Initialize_World/city.ts'
import { auditCraft } from '../02_Define_The_Rules/ring0.ts'
import { TRACK_KINDS, TRACK_POSE } from './simProtocol.ts'
import { TrackFleet, trackPoseAt } from './trackFleet.ts'

const S = TRACK_POSE.stride
const net = buildTrackNetwork(1337)
const fleet = new TrackFleet(net)
const sky = net.tracks.filter((t) => t.kind !== 'car')
const KIND = { train: TRACK_KINDS.indexOf('train'), drone: TRACK_KINDS.indexOf('drone'), plane: TRACK_KINDS.indexOf('plane') }

const field = (buf: Float32Array, i: number, f: keyof typeof TRACK_POSE): number => buf[i * S + TRACK_POSE[f]]
/** Signed arc-length difference b − a around a loop of `length`, in (−length/2, length/2]. */
function around(a: number, b: number, length: number): number {
  let d = (b - a) % length
  if (d > length / 2) d -= length
  if (d <= -length / 2) d += length
  return d
}
/** Distance in (x, z) from a point to a box [x0, y0, z0, x1, y1, z1] (0 inside). */
function boxDistance(x: number, z: number, b: Box): number {
  const dx = Math.max(b[0] - x, 0, x - b[3]), dz = Math.max(b[2] - z, 0, z - b[5])
  return Math.hypot(dx, dz)
}

test('the fleet lists every scheduled craft of the network in buffer order, with its kind code and track id, and no car', () => {
  const expected = sky.reduce((n, t) => n + scheduledCount(t), 0)
  assert.equal(fleet.count, expected)
  assert.equal(fleet.length, expected * S)
  assert.ok(fleet.count > 900 && fleet.count < 1100, `${fleet.count} craft`)
  const buf = fleet.writePoses(0, new Float32Array(fleet.length))
  let i = 0
  for (const t of sky) {
    const n = scheduledCount(t)
    for (let k = 0; k < n; k++, i++) {
      assert.deepEqual(fleet.craftAt(i), { track: t.id, kind: TRACK_KINDS.indexOf(t.kind), index: k, count: n })
      assert.equal(field(buf, i, 'kind'), TRACK_KINDS.indexOf(t.kind))
      assert.equal(field(buf, i, 'track'), t.id)
      assert.equal(fleet.periodOf(i), lapSeconds(t))
    }
  }
  assert.equal(i, fleet.count)
  assert.ok(!Array.from({ length: fleet.count }, (_, k) => field(buf, k, 'kind')).includes(TRACK_KINDS.indexOf('car')))
  const kinds = new Set(Array.from({ length: fleet.count }, (_, k) => field(buf, k, 'kind')))
  assert.deepEqual([...kinds].sort(), [KIND.train, KIND.drone, KIND.plane])
  assert.equal(Array.from({ length: fleet.count }, (_, k) => field(buf, k, 'kind')).filter((k) => k === KIND.train).length, TRACKS.train.sets)
  assert.equal(Array.from({ length: fleet.count }, (_, k) => field(buf, k, 'kind')).filter((k) => k === KIND.plane).length, TRACKS.plane.count)
})

test('two hours at 0.5 s: finite and clean for the audit, trains on the deck within 1.5 m of the loop and never faster than the timetable, drones at 40/46 m, planes at 400 m, sets ≥ 74 m apart, s and speed true', () => {
  const buf = new Float32Array(fleet.length)
  const trackOf: Track[] = Array.from({ length: fleet.count }, (_, i) => net.tracks[fleet.craftAt(i).track])
  const trains = Array.from({ length: fleet.count }, (_, i) => i).filter((i) => trackOf[i].kind === 'train')
  const train = trackOf[trains[0]]
  assert.equal(trains.length, TRACKS.train.sets)
  const prevS = new Float64Array(fleet.count), prevV = new Float64Array(fleet.count)
  let minSpacing = Infinity, maxTrainSpeed = 0, maxLateral = 0, maxTrainLateral = 0
  const DT = 0.5
  for (let step = 0; step * DT <= 7200; step++) {
    const t = step * DT
    fleet.writePoses(t, buf)
    assert.equal(auditCraft(buf), null, `at t ${t}`)
    for (let i = 0; i < fleet.count; i++) {
      const tr = trackOf[i]
      const y = field(buf, i, 'y'), s = field(buf, i, 's'), v = field(buf, i, 'speed')
      if (tr.kind === 'train') {
        assert.equal(y, TRACKS.train.deck)
        assert.ok(v >= 0 && v <= TRACKS.train.speed + 0.05, `train speed ${v} at t ${t}`)
        maxTrainSpeed = Math.max(maxTrainSpeed, v)
        const lateral = Math.abs(projectOnto(tr, field(buf, i, 'x'), field(buf, i, 'z'), s).lateral)
        maxTrainLateral = Math.max(maxTrainLateral, lateral)
        assert.ok(lateral < 1.5, `train ${i} is ${lateral} m off the loop at t ${t}`)
      } else if (tr.kind === 'drone') {
        assert.ok(y === TRACKS.drone.altitude[0] || y === TRACKS.drone.altitude[1], `drone at ${y} m`)
        assert.equal(v, TRACKS.drone.speed)
      } else {
        assert.equal(y, TRACKS.plane.altitude)
        assert.equal(v, TRACKS.plane.speed)
      }
      assert.ok(s >= 0 && s < tr.length, `s ${s} on a ${tr.length} m track`)
      // The arc length names the position (f32 rounding of x, z up to 1.3 km: 1.2e-4 per ulp).
      if (step % 20 === 0) {
        const q = poseAt(tr, s)
        const off = Math.hypot(q.x - field(buf, i, 'x'), q.z - field(buf, i, 'z'))
        maxLateral = Math.max(maxLateral, off)
        assert.ok(off < 2e-3, `${tr.kind} ${i}: s ${s} is ${off} m from (x, z) at t ${t}`)
        assert.ok(Math.abs(q.heading - field(buf, i, 'heading')) < 1e-5 || Math.abs(Math.abs(q.heading - field(buf, i, 'heading')) - 2 * Math.PI) < 1e-5)
      }
      // The speed integrates to the arc length: the trapezoid over one step (a train's timetable is piecewise linear in speed).
      if (step > 0) {
        const d = around(prevS[i], s, tr.length)
        assert.ok(d >= -1e-3, `${tr.kind} ${i} went backwards: ${d} m`)
        const tol = tr.kind === 'train' ? 0.2 : 1e-2
        assert.ok(Math.abs(d - ((prevV[i] + v) / 2) * DT) < tol, `${tr.kind} ${i}: moved ${d} m at ${(prevV[i] + v) / 2} m/s over ${DT} s`)
      }
      prevS[i] = s; prevV[i] = v
    }
    const ss = trains.map((i) => field(buf, i, 's')).sort((a, b) => a - b)
    for (let k = 0; k < ss.length; k++) minSpacing = Math.min(minSpacing, (k + 1 < ss.length ? ss[k + 1] : ss[0] + train.length) - ss[k])
  }
  assert.ok(minSpacing >= TRACKS.train.spacing, `train sets came within ${minSpacing.toFixed(1)} m`)
  assert.ok(maxTrainSpeed > TRACKS.train.speed - 0.1, `the trains reach their cruise: ${maxTrainSpeed}`)
  assert.ok(maxTrainLateral < 1e-2, `trains stay on the loop: ${maxTrainLateral} m`)
})

test('periodic in each craft\'s lap, and a pure function of the clock: the same t writes the same buffer whatever came before', () => {
  const a = new Float32Array(fleet.length), b = new Float32Array(fleet.length)
  const periods = new Set(Array.from({ length: fleet.count }, (_, i) => fleet.periodOf(i)))
  assert.equal(periods.size, 3, 'one lap time per kind')
  for (const t of [0, 17.3, 400.9, 3599.5]) {
    fleet.writePoses(t, a)
    for (const T of periods) {
      fleet.writePoses(t + T, b)
      for (let i = 0; i < fleet.count; i++) {
        if (fleet.periodOf(i) !== T) continue
        const tr = net.tracks[fleet.craftAt(i).track]
        for (const f of ['x', 'y', 'z'] as const) assert.ok(Math.abs(field(a, i, f) - field(b, i, f)) < 5e-4, `${tr.kind} ${i} ${f} at t ${t} + ${T}`)
        assert.ok(Math.abs(field(a, i, 'heading') - field(b, i, 'heading')) < 1e-5)
        assert.ok(Math.abs(around(field(a, i, 's'), field(b, i, 's'), tr.length)) < 2e-3)
        assert.ok(Math.abs(field(a, i, 'speed') - field(b, i, 'speed')) < 0.05)
      }
    }
  }
  // History-free: a fresh fleet and one that has been anywhere agree bit for bit at the same t.
  const fresh = new TrackFleet(net).writePoses(1000, new Float32Array(fleet.length))
  fleet.writePoses(1000, a)
  fleet.writePoses(3, b)
  fleet.writePoses(6000.25, b)
  fleet.writePoses(1000, b)
  assert.deepEqual(Array.from(b), Array.from(fresh))
  assert.deepEqual(Array.from(a), Array.from(fresh))
  // poseOf is the double the buffer rounds, and trackPoseAt the track's own pose at the buffer's s.
  for (const i of [0, 1, 2, 10, fleet.count - 1]) {
    const p = fleet.poseOf(i, 1000)
    assert.ok(Math.abs(p.x - field(a, i, 'x')) < 1e-3 && Math.abs(p.z - field(a, i, 'z')) < 1e-3 && p.y === field(a, i, 'y'))
    const q = trackPoseAt(net.tracks[fleet.craftAt(i).track], field(a, i, 's'))
    assert.ok(Math.hypot(q.x - p.x, q.z - p.z) < 2e-3)
  }
})

test('every craft clears every building box of four seeds by its envelope (INV-1, read off the stream)', () => {
  const envelope = {
    train: { half: TRACKS.train.halfWidth, low: 0, high: TRACKS.train.height },
    drone: { half: TRACKS.drone.halfSize, low: -TRACKS.drone.halfSize, high: TRACKS.drone.halfSize },
    plane: { half: TRACKS.plane.halfLength, low: -TRACKS.plane.halfHeight, high: TRACKS.plane.halfHeight },
  } as const
  const buf = new Float32Array(fleet.length)
  const cell = CITY.pitch
  for (const seed of [1337, 7, 42, 90210]) {
    const boxes = generateBuildings(seed).map((b) => b.box)
    const hash = new Map<string, Box[]>()
    for (const b of boxes) {
      for (let i = Math.floor(b[0] / cell); i <= Math.floor(b[3] / cell); i++) for (let j = Math.floor(b[2] / cell); j <= Math.floor(b[5] / cell); j++) {
        const k = `${i},${j}`
        const list = hash.get(k)
        if (list) list.push(b); else hash.set(k, [b])
      }
    }
    for (let t = 0; t < 600; t += 2) {
      fleet.writePoses(t, buf)
      for (let i = 0; i < fleet.count; i++) {
        const tr = net.tracks[fleet.craftAt(i).track]
        const env = envelope[tr.kind as keyof typeof envelope]
        const x = field(buf, i, 'x'), y = field(buf, i, 'y'), z = field(buf, i, 'z')
        const y0 = y + env.low, y1 = y + env.high
        const cx = Math.floor(x / cell), cz = Math.floor(z / cell)
        for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) {
          for (const b of hash.get(`${cx + a},${cz + c}`) ?? []) {
            if (b[4] <= y0 || b[1] >= y1) continue
            const d = boxDistance(x, z, b)
            assert.ok(d >= env.half, `seed ${seed}: ${tr.kind} craft ${i} at t ${t} (${x.toFixed(1)}, ${z.toFixed(1)}) is ${d.toFixed(2)} m from a box`)
          }
        }
      }
    }
  }
})

test('writePoses refuses a short buffer and leaves the floats past the craft alone; a bad index is refused; the class is frozen', () => {
  assert.throws(() => fleet.writePoses(0, new Float32Array(fleet.length - 1)), RangeError)
  const long = new Float32Array(fleet.length + 5).fill(-7)
  fleet.writePoses(0, long)
  assert.deepEqual(Array.from(long.subarray(fleet.length)), [-7, -7, -7, -7, -7])
  assert.throws(() => fleet.craftAt(fleet.count), RangeError)
  assert.throws(() => fleet.craftAt(-1), RangeError)
  assert.throws(() => fleet.periodOf(fleet.count), RangeError)
  assert.throws(() => fleet.poseOf(fleet.count, 0), RangeError)
  const mutable = (o: unknown) => o as Record<string, unknown>
  assert.throws(() => { mutable(fleet).count = 0 }, TypeError)
  assert.throws(() => { mutable(TrackFleet.prototype).writePoses = () => null }, TypeError)
  for (const o of [fleet, TrackFleet, TrackFleet.prototype]) assert.ok(Object.isFrozen(o))
  assert.deepEqual(Object.keys(fleet), ['count', 'length'])
  // The same numbers scheduledPose gives, kind by kind, at an arbitrary clock.
  const buf = fleet.writePoses(123.456, new Float32Array(fleet.length))
  for (let i = 0; i < fleet.count; i += 97) {
    const c = fleet.craftAt(i)
    const p = scheduledPose(net.tracks[c.track], c.index, c.count, 123.456)
    assert.ok(Math.abs(p.x - field(buf, i, 'x')) < 1e-3 && Math.abs(p.z - field(buf, i, 'z')) < 1e-3 && p.y === field(buf, i, 'y'))
  }
})

test('VTOLs on the stream: a city given its boxes has them after the rest, clean for the audit over a lap, never under the hover over a roof, s and speed true', () => {
  const boxes = generateBuildings(1337).map((b) => b.box)
  const city = buildTrackNetwork(1337, boxes)
  const cf = new TrackFleet(city)
  const vt = city.tracks.filter((t) => t.kind === 'vtol')
  const VTOL = TRACK_KINDS.indexOf('vtol')
  assert.ok(vt.length >= 1 && VTOL === 4)
  assert.equal(cf.count, fleet.count + vt.length * TRACKS.vtol.craft)
  const buf = new Float32Array(cf.length), plain = new Float32Array(fleet.length)
  const craft = Array.from({ length: cf.count }, (_, i) => i).filter((i) => cf.craftAt(i).kind === VTOL)
  assert.equal(craft.length, vt.length * TRACKS.vtol.craft)
  assert.ok(craft.every((i) => i >= fleet.count), 'the VTOLs come after every other craft')
  const T = Math.max(...vt.map(lapSeconds))
  for (let t = 0; t <= T + 1; t += 0.5) {
    cf.writePoses(t, buf)
    assert.equal(auditCraft(buf), null, `clean at ${t} s`)
    // The craft before them are the plain network's, number for number.
    fleet.writePoses(t, plain)
    assert.deepEqual(Array.from(buf.subarray(0, fleet.length)), Array.from(plain))
    for (const i of craft) {
      const tr = city.tracks[field(buf, i, 'track')]
      assert.equal(tr.kind, 'vtol')
      assert.equal(field(buf, i, 'kind'), VTOL)
      const y = field(buf, i, 'y'), s = field(buf, i, 's'), speed = field(buf, i, 'speed')
      assert.ok(y >= TRACKS.vtol.floor + TRACKS.vtol.hover - 1e-3 && y <= tr.y + 1e-3, `y ${y}`)
      assert.ok(speed >= 0 && speed <= TRACKS.vtol.speed + 1e-3)
      const q = poseAt(tr, s)
      assert.ok(Math.abs(q.x - field(buf, i, 'x')) < 2e-3 && Math.abs(q.z - field(buf, i, 'z')) < 2e-3, 's places it')
      assert.equal(cf.periodOf(i), lapSeconds(tr))
      const p = cf.poseOf(i, t)
      assert.ok(Math.abs(p.y - y) < 1e-3 && Math.abs(p.heading - field(buf, i, 'heading')) < 1e-3)
    }
  }
})
