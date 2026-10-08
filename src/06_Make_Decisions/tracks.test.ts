// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the fixed track network and its zero-jam invariants in Node, with no
 * physics engine: the network is the same for the same seed, closed and arc-length true; car rings are lane
 * splines on Driver's own corner curve with a stop line at every intersection; INV-1, no two car rings come
 * within 4 m of each other and the train, drone and plane corridors meet no building and stay 6 m over the
 * cars; INV-2 and INV-3, a ring at capacity keeps every gap over a metre, never speeds, never enters on red
 * and every car laps, even behind a leader that brakes hard at random, and every throttle the follower opens
 * passes the Ring-0 bouncer without a ruling; INV-4, a stalled car changes nothing on any other ring; the
 * timetables are periodic and keep their spacing; slots are distinct and overflow throws; projection
 * round-trips. The follower here is the minimal one the map prescribes (followSpeed and Driver's throttle
 * gate) until 7.3b's TrackDriver replaces it.
 * What breaks if it is removed? A change to the rings, the timetable or the seating could put two tracks on
 * one point, seat cars inside a box, or let a ring jam, unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  TRACKS, assignSlots, buildTrackNetwork, capacity, cornerAhead, guideway, lapSeconds, nextStop, pieceAt, poseAt, projectOnto,
  ringGaps, roomToClear, scheduledCount, scheduledPose, seatable, seats, slotCount, slotStart, speedLimitAt, tangentAt, turnBezier, wrap,
  type Track,
} from './tracks.ts'
import { Driver, followSpeed } from './traffic.ts'
import { CITY, POLES, generateBuildings, streetFurniture, type Box } from '../01_Initialize_World/city.ts'
import { KERNEL, SIGNAL, TRAFFIC, signalFor, type Axis } from '../02_Define_The_Rules/civic.ts'
import { createRng } from '../02_Define_The_Rules/degrees.ts'
import { adjudicate } from '../02_Define_The_Rules/laws.ts'

const DT = 1 / 60
const WHEELBASE = 2.8
const HALF_LENGTH = 2.3
const HALF_WIDTH = 0.92
const ENTRY = 7.5
const SEEDS = [1337, 7, 42, 90210]

const net = buildTrackNetwork(1337)
const carTracks = net.tracks.filter((t) => t.kind === 'car')
const ofKind = (kind: Track['kind']) => net.tracks.filter((t) => t.kind === kind)

function dist(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

/** Shortest signed distance from a to b around a loop of length L. */
function around(a: number, b: number, L: number): number {
  const d = ((b - a) % L + L * 1.5) % L
  return d - L / 2
}

// ---------------------------------------------------------------- the minimal track follower

interface Pose { x: number; z: number; heading: number; speed: number }

/**
 * The map's minimal follower: projection onto its track, the signal hold of traffic.ts:172-180 with the
 * don't-block-the-box room, the following rule of traffic.ts:207 on followSpeed, pure pursuit and the throttle
 * gate of traffic.ts:225-232 verbatim. Its aim stays a metre past the straight's end until the corner (as
 * traffic.ts:187 does), so it does not cut the corner.
 */
class Follower {
  s: number
  holding = false
  stuckSeconds = 0
  /** Forced to stand still (a parked car, a First-Law hold). */
  stalled = false
  readonly #track: Track

  constructor(track: Track, s0: number) {
    this.#track = track
    this.s = s0
  }

  command(p: Pose, signalSeconds: number, gap: number, dt: number): { throttle: number; brake: number; steer: number; lateral: number; toStop: number; axis: Axis | null } {
    const track = this.#track
    const { s, lateral } = projectOnto(track, p.x, p.z, this.s)
    this.s = s
    const a = TRAFFIC.comfortableDecel
    let vTarget = speedLimitAt(track, s)
    let requiredDecel = 0
    const stop = nextStop(track, s)
    let toStop = Infinity
    if (stop) {
      toStop = stop.distance
      const light = signalFor(stop.axis, signalSeconds)
      if (light === 'green') this.holding = false
      else if (!this.holding && toStop > -0.5 && (light === 'red' || toStop > (p.speed * p.speed) / (2 * 4.5))) this.holding = true
      const blocked = toStop > -0.5 && gap < roomToClear(toStop)
      if (this.holding || blocked) {
        vTarget = Math.min(vTarget, toStop < 0.3 ? 0 : Math.sqrt(2 * a * toStop))
        requiredDecel = toStop > 0.3 ? (p.speed * p.speed) / (2 * toStop) : 6
      }
    }
    vTarget = Math.min(vTarget, gap < 3 ? 0 : Math.min((gap - 3) * 0.9, followSpeed(gap)))
    if (this.stalled) vTarget = 0

    const ahead = cornerAhead(track, s)
    const look = ahead === 0 ? Math.max(4.5, p.speed * 0.7) : Math.min(Math.max(6, p.speed * 0.9), ahead + 1)
    const aim = poseAt(track, s + look)
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading)
    const rx = -fz, rz = fx
    const tx = aim.x - p.x, tz = aim.z - p.z
    const ld = Math.max(Math.hypot(tx, tz), 1)
    const alpha = Math.atan2(tx * rx + tz * rz, tx * fx + tz * fz)
    const steer = Math.max(-0.6, Math.min(0.6, -Math.atan((2 * WHEELBASE * Math.sin(alpha)) / ld)))

    const err = vTarget - p.speed
    const stuck = vTarget > 2 && p.speed < 0.3 && gap > 6
    this.stuckSeconds = stuck ? this.stuckSeconds + dt : 0
    const axis = stop ? stop.axis : null
    if (err > 0 && requiredDecel < 1 && vTarget >= 0.1) return { throttle: Math.min(1, err * 0.5 + 0.1), brake: 0, steer, lateral, toStop, axis }
    const hold = vTarget < 0.1 && p.speed < 0.6 ? 3 : 0
    return { throttle: 0, brake: Math.min(8, Math.max(hold, requiredDecel * 1.15, -err * 2.2)), steer, lateral, toStop, axis }
  }
}

interface Car {
  ring: number
  follower: Follower
  p: Pose
  laps: number
  lastS: number
  inside: boolean
  approach: Axis
  prevToStop: number
  corners: number
}

/** `n` cars on `track`, seated as assignSlots would (its first n seats); `stall` is the index of a car that stands still. */
interface RingSpec { track: Track; n: number; stall?: number; brakeBursts?: () => number }

interface RunStats {
  minGap: number
  maxSpeed: number
  maxLateral: number
  maxStuck: number
  redBoxEntries: number
  redLineCrossings: number
  rulings: number
  throttles: number
  /** Least centre distance between cars of different rings. */
  minCross: number
  cars: Car[]
  /** Per ring: corner passages counted per 64 s window after the first. */
  cornerWindows: number[][]
  /** Per car: (x, z) every 10 s. */
  trace: Float64Array[]
}

/**
 * Drives every ring's cars with the kinematic bicycle model of traffic.test.ts (accel = throttle · 2.5 − brake).
 * Each car's gap is its ring gap (ringGaps): what a Fleet whose bonnet rays are filtered of tracked cars feeds a
 * TrackDriver (see 'a bonnet ray that counted tracked cars' below for why the rays must be). The least centre
 * distance between cars of different rings is recorded, so INV-1 is also checked with the cars' real lateral error.
 */
function simulate(specs: RingSpec[], seconds: number, adversarial = false): RunStats {
  const cars: Car[] = []
  specs.forEach((spec, ring) => {
    const seatsOf = seats(spec.track)
    assert.ok(spec.n <= seatsOf.length, `${spec.n} cars on a ring of ${seatsOf.length} seats`)
    for (let k = 0; k < spec.n; k++) {
      const s = slotStart(spec.track, seatsOf[k])
      const q = poseAt(spec.track, s)
      const follower = new Follower(spec.track, s)
      if (spec.stall === k) follower.stalled = true
      const piece = pieceAt(spec.track, s)
      const ox = q.x - Math.round(q.x / CITY.pitch) * CITY.pitch, oz = q.z - Math.round(q.z / CITY.pitch) * CITY.pitch
      cars.push({
        ring, follower, p: { x: q.x, z: q.z, heading: q.heading, speed: 0 }, laps: 0, lastS: s,
        inside: Math.abs(ox) < CITY.roadHalf && Math.abs(oz) < CITY.roadHalf,
        approach: piece.kind === 'line' ? piece.axis : 'ew', prevToStop: NaN, corners: 0,
      })
    }
  })
  const stats: RunStats = {
    minGap: Infinity, maxSpeed: 0, maxLateral: 0, maxStuck: 0, redBoxEntries: 0, redLineCrossings: 0, rulings: 0, throttles: 0, minCross: Infinity, cars,
    cornerWindows: specs.map(() => []), trace: cars.map(() => new Float64Array(2 * (Math.floor(seconds / 10) + 1))),
  }
  const order = specs.map((spec) => new Float64Array(spec.n))
  const byRing = specs.map((_, ring) => cars.map((c, i) => (c.ring === ring ? i : -1)).filter((i) => i >= 0))
  const burst = specs.map(() => 0)
  let frame = 0
  for (let t = 0; t < seconds; t += DT, frame++) {
    if (frame % 600 === 0) cars.forEach((c, i) => { stats.trace[i][2 * (frame / 600)] = c.p.x; stats.trace[i][2 * (frame / 600) + 1] = c.p.z })
    const window = Math.floor(t / 64)
    specs.forEach((spec, ring) => {
      const idx = byRing[ring].slice().sort((a, b) => cars[a].follower.s - cars[b].follower.s)
      idx.forEach((i, k) => { order[ring][k] = cars[i].follower.s })
      const gaps = ringGaps(order[ring], spec.track.length, 2 * HALF_LENGTH)
      if (spec.brakeBursts) burst[ring] = burst[ring] > 0 ? burst[ring] - DT : spec.brakeBursts() < 0.004 ? 2 : 0
      idx.forEach((i, k) => {
        const c = cars[i]
        const gap = gaps[k]
        if (specs.length > 1 && frame % 6 === 0) {
          for (const o of cars) if (o.ring !== c.ring) stats.minCross = Math.min(stats.minCross, dist(o.p, c.p))
        }
        if (k < gaps.length && gaps[k] < stats.minGap && !(spec.n === 1)) stats.minGap = Math.min(stats.minGap, gaps[k])
        let cmd = c.follower.command(c.p, t, gap, DT)
        if (adversarial && k === idx.length - 1 && burst[ring] > 0) cmd = { ...cmd, throttle: 0, brake: KERNEL.maxBrake }
        if (cmd.throttle > 0) {
          stats.throttles++
          const ruling = adjudicate(cmd, { source: 'ai', speed: c.p.speed, personAhead: Infinity, personBehind: Infinity, obstacleAhead: gap })
          if (ruling.law !== 0) stats.rulings++
        }
        stats.maxLateral = Math.max(stats.maxLateral, Math.abs(cmd.lateral))
        stats.maxStuck = Math.max(stats.maxStuck, c.follower.stuckSeconds)
        // A stop line crossed on red: the exact rule the in-page traffic-lights harness applies.
        if (cmd.axis && Number.isFinite(c.prevToStop) && c.prevToStop > 0 && cmd.toStop <= 0 && c.prevToStop - cmd.toStop < 15 && signalFor(cmd.axis, t) === 'red') stats.redLineCrossings++
        c.prevToStop = cmd.toStop

        const accel = cmd.throttle * 2.5 - cmd.brake
        c.p.speed = Math.max(0, c.p.speed + accel * DT)
        c.p.heading += (c.p.speed * Math.tan(cmd.steer)) / WHEELBASE * DT
        c.p.x += Math.sin(c.p.heading) * c.p.speed * DT
        c.p.z += Math.cos(c.p.heading) * c.p.speed * DT
        stats.maxSpeed = Math.max(stats.maxSpeed, c.p.speed)

        const s = c.follower.s
        if (s < c.lastS - spec.track.length / 2) c.laps++
        const before = pieceAt(spec.track, c.lastS), after = pieceAt(spec.track, s)
        if (after.kind === 'corner' && before !== after) {
          c.corners++
          if (window > 0) stats.cornerWindows[ring][window - 1] = (stats.cornerWindows[ring][window - 1] ?? 0) + 1
        }
        if (after.kind === 'line') c.approach = after.axis
        c.lastS = s
        // The intersection-box entry test of traffic.test.ts:42-48, with the approach street's axis.
        const ox = c.p.x - Math.round(c.p.x / CITY.pitch) * CITY.pitch, oz = c.p.z - Math.round(c.p.z / CITY.pitch) * CITY.pitch
        const nowInside = Math.abs(ox) < CITY.roadHalf && Math.abs(oz) < CITY.roadHalf
        if (nowInside && !c.inside && signalFor(c.approach, t) === 'red') stats.redBoxEntries++
        c.inside = nowInside
      })
    })
  }
  return stats
}

// ---------------------------------------------------------------- the network

test('the network is the same for the same seed, closed, arc-length true, and its ids are in order', () => {
  assert.deepEqual(buildTrackNetwork(1337), net)
  assert.notDeepEqual(buildTrackNetwork(7), net, 'another seed starts the rings elsewhere')
  assert.equal(net.seed, 1337)
  assert.deepEqual([...new Set(net.tracks.map((t) => t.kind))], ['car', 'train', 'drone', 'plane'])
  assert.equal(carTracks.length, (CITY.blocks / TRACKS.car.faceBlocks) ** 2, '64 car rings')
  assert.equal(ofKind('train').length, 1)
  assert.equal(ofKind('drone').length, 2 * (CITY.blocks / TRACKS.drone.faceBlocks) ** 2)
  assert.equal(ofKind('plane').length, 1)
  net.tracks.forEach((t, id) => assert.equal(t.id, id))
  assert.ok(Object.isFrozen(net) && Object.isFrozen(net.tracks) && net.tracks.every((t) => Object.isFrozen(t) && Object.isFrozen(t.pieces)))
  for (const t of net.tracks) {
    assert.ok(t.length > 0 && Number.isFinite(t.length))
    t.pieces.forEach((p, i) => { if (i > 0) assert.ok(Math.abs(p.s0 - (t.pieces[i - 1].s0 + t.pieces[i - 1].length)) < 1e-9, `${t.kind} ${t.id}: piece ${i} starts where ${i - 1} ends`) })
    assert.ok(dist(poseAt(t, t.length - 1e-7), poseAt(t, 0)) < 1e-5, `${t.kind} ${t.id} closes`)
    assert.ok(dist(poseAt(t, t.length), poseAt(t, 0)) < 1e-9 && dist(poseAt(t, -3), poseAt(t, t.length - 3)) < 1e-9, 'wrapped')
    for (const p of t.pieces) {
      if (p.kind === 'line') continue
      assert.ok(dist(poseAt(t, p.s0 - 1e-7), poseAt(t, p.s0)) < 1e-5, `${t.kind} ${t.id}: continuous into the curve at ${p.s0}`)
    }
    for (let s = 0; s < t.length; s += 0.37) {
      const a = poseAt(t, s), b = poseAt(t, s + 0.5)
      const d = dist(a, b)
      const straight = pieceAt(t, wrap(t, s)).kind === 'line' && pieceAt(t, wrap(t, s + 0.5)) === pieceAt(t, wrap(t, s))
      assert.ok(Math.abs(d - 0.5) < (straight ? 2e-3 : 5e-3), `${t.kind} ${t.id} at ${s}: 0.5 m of s is ${d} m`)
      assert.ok(Math.abs(Math.hypot(a.tangentX, a.tangentZ) - 1) < 1e-9 && a.heading === Math.atan2(a.tangentX, a.tangentZ))
      assert.equal(a.y, t.y)
      const [tx, tz] = tangentAt(t, s)
      assert.equal(tx, a.tangentX)
      assert.equal(tz, a.tangentZ)
      // The tangent is the direction of travel.
      const c = poseAt(t, s + 0.1)
      assert.ok(((c.x - a.x) * a.tangentX + (c.z - a.z) * a.tangentZ) / dist(a, c) > 0.9999, `${t.kind} ${t.id} at ${s}: tangent points along`)
    }
  }
})

test('car rings are lane splines: straights on the lane, right-turn corners on the Driver\'s own curve, a stop at every intersection', () => {
  for (const t of carTracks) {
    assert.equal(t.pieces.length, 8, 'four straights, four corners')
    assert.equal(t.stops.length, 8, 'a stop at every intersection passed: four corners, four straight-through')
    assert.equal(t.y, 0)
    assert.equal(t.speedLimit, TRAFFIC.speedLimit)
    assert.equal(t.cornerSpeed, TRAFFIC.turnSpeed)
    assert.equal(t.slot, TRACKS.car.slot)
    for (let s = 0; s < t.length; s += 0.25) {
      const q = poseAt(t, s)
      const piece = pieceAt(t, s)
      const ox = q.x - Math.round(q.x / CITY.pitch) * CITY.pitch, oz = q.z - Math.round(q.z / CITY.pitch) * CITY.pitch
      if (piece.kind === 'line') {
        // spatial.test.ts:161-163: exactly laneOffset from a centreline, to the right of travel.
        const along = Math.abs(Math.sin(q.heading)) > 0.5 ? oz : ox
        assert.ok(Math.abs(Math.abs(along) - TRAFFIC.laneOffset) < 1e-9, `${t.id} at ${s}: ${along} m from its centreline`)
        const rx = -q.tangentZ, rz = q.tangentX
        assert.ok(Math.abs(ox * rx + oz * rz - TRAFFIC.laneOffset) < 1e-9, 'the right-hand lane')
        assert.ok(Math.abs(Math.abs(q.tangentX) + Math.abs(q.tangentZ) - 1) < 1e-12, 'along an axis')
      } else {
        assert.equal(piece.kind, 'corner')
        assert.ok(Math.max(Math.abs(ox), Math.abs(oz)) <= ENTRY + 1e-6, `${t.id} at ${s}: a corner sample within ENTRY of the intersection centre`)
        assert.ok(Math.min(Math.abs(ox), Math.abs(oz)) >= TRAFFIC.laneOffset - 1e-6, `${t.id} at ${s}: a right turn never crosses a centreline`)
      }
    }
    // Right turns only: at every corner the exit heading is the entry heading turned right (−π/2).
    for (const p of t.pieces) {
      if (p.kind !== 'corner') continue
      const a = poseAt(t, p.s0), b = poseAt(t, p.s0 + p.length - 1e-9)
      const turn = Math.atan2(Math.sin(b.heading - a.heading), Math.cos(b.heading - a.heading))
      assert.ok(Math.abs(turn + Math.PI / 2) < 1e-6, `${t.id}: turned ${turn}`)
    }
    // Stops: the car's centre TRAFFIC.stopLine + HALF_LENGTH before an intersection centre, axis of the approach.
    let prev = -Infinity
    for (const stop of t.stops) {
      assert.ok(stop.s > prev, 'in order')
      prev = stop.s
      const q = poseAt(t, stop.s)
      const piece = pieceAt(t, stop.s)
      assert.equal(piece.kind, 'line')
      assert.equal(stop.axis, piece.axis)
      const ahead = { x: q.x + q.tangentX * (TRAFFIC.stopLine + HALF_LENGTH), z: q.z + q.tangentZ * (TRAFFIC.stopLine + HALF_LENGTH) }
      const ox = ahead.x - Math.round(ahead.x / CITY.pitch) * CITY.pitch, oz = ahead.z - Math.round(ahead.z / CITY.pitch) * CITY.pitch
      assert.ok(Math.abs(stop.axis === 'ew' ? ox : oz) < 1e-6, `${t.id}: stop ${stop.s} is ${TRAFFIC.stopLine + HALF_LENGTH} m before an intersection centre`)
      assert.ok(Math.abs(q.heading - (stop.axis === 'ew' ? Math.sign(q.tangentX) * Math.PI / 2 : q.tangentZ > 0 ? 0 : Math.PI)) < 1e-9)
    }
    const n = nextStop(t, t.stops[0].s + 1)
    assert.ok(n && n.s === t.stops[0].s && Math.abs(n.distance + 1) < 1e-9, 'a stop just crossed stays current')
    const m = nextStop(t, t.stops[0].s + 18)
    assert.ok(m && m.s === t.stops[1].s, 'once the box is cleared the next stop is current')
    assert.equal(nextStop(ofKind('plane')[0], 5), null)
    // Speed: the corner speed inside a corner, the anticipation of traffic.ts:181 before it, the limit elsewhere.
    for (const p of t.pieces) {
      if (p.kind !== 'corner') continue
      assert.equal(speedLimitAt(t, p.s0 + p.length / 2), TRAFFIC.turnSpeed)
      assert.ok(Math.abs(speedLimitAt(t, p.s0 - 4) - Math.sqrt(TRAFFIC.turnSpeed ** 2 + 2 * TRAFFIC.comfortableDecel * 4)) < 1e-9)
      assert.equal(speedLimitAt(t, p.s0 - 30), TRAFFIC.speedLimit)
      assert.equal(cornerAhead(t, p.s0 - 30), 30)
    }
  }
  // The corner is Driver's own right turn: a Driver whose every draw picks 'right' rounds the corner at (6, 4).
  const { e } = turnBezier([6, 4], [1, 0], [0, 1], 'right')
  const ring = carTracks.find((t) => t.pieces.some((p) => p.kind === 'corner' && p.e[0] === e[0] && p.e[1] === e[1]))
  assert.ok(ring, 'a ring turns right at (6, 4) from the east-bound lane')
  const driver = new Driver([5, 4], [1, 0], () => 0.9)
  const start = Driver.lanePose([5, 4], [1, 0], 14)
  const p: Pose = { x: start.x, z: start.z, heading: start.heading, speed: 0 }
  let worst = 0, samples = 0
  for (let t = 0; t < 30; t += DT) {
    const cmd = driver.command(p, 5, Infinity, DT)
    p.speed = Math.max(0, p.speed + (cmd.throttle * 2.5 - cmd.brake) * DT)
    p.heading += (p.speed * Math.tan(cmd.steer)) / WHEELBASE * DT
    p.x += Math.sin(p.heading) * p.speed * DT
    p.z += Math.cos(p.heading) * p.speed * DT
    if (Math.max(Math.abs(p.x - 240), Math.abs(p.z - 160)) < ENTRY && p.x < 240 - TRAFFIC.laneOffset + 1 && p.z > 160) {
      worst = Math.max(worst, Math.abs(projectOnto(ring, p.x, p.z).lateral))
      samples++
    }
    if (p.z > 160 + ENTRY + 5) break
  }
  assert.ok(samples > 30, `${samples} samples inside the corner`)
  // The Driver's pure pursuit (4.5 m lookahead at turnSpeed) cuts its own curve by about 0.4 m; the ring's corner is that curve.
  assert.ok(worst < 0.5, `the Driver's corner is ${worst.toFixed(3)} m from the ring's`)
})

// ---------------------------------------------------------------- INV-1 separation

interface Sample { x: number; z: number; y: number; id: number }

function samplesOf(tracks: readonly Track[], step: number): Sample[] {
  const out: Sample[] = []
  for (const t of tracks) for (let s = 0; s < t.length; s += step) { const q = poseAt(t, s); out.push({ x: q.x, z: q.z, y: t.y, id: t.id }) }
  return out
}

/** Least distance between samples of different tracks, through a grid hash of `cell` metres. */
function minSeparation(samples: Sample[], cell: number): number {
  const hash = new Map<string, number[]>()
  const key = (x: number, z: number) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`
  samples.forEach((p, i) => { const k = key(p.x, p.z); const list = hash.get(k); if (list) list.push(i); else hash.set(k, [i]) })
  let best = Infinity
  for (const p of samples) {
    const cx = Math.floor(p.x / cell), cz = Math.floor(p.z / cell)
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const q of hash.get(`${cx + i},${cz + j}`) ?? []) {
        const o = samples[q]
        if (o.id === p.id) continue
        best = Math.min(best, Math.hypot(o.x - p.x, o.z - p.z, o.y - p.y))
      }
    }
  }
  return best
}

/** Horizontal distance from (x, z) to a box, 0 inside its footprint. */
function boxDistance(x: number, z: number, b: Box): number {
  const dx = Math.max(b[0] - x, 0, x - b[3]), dz = Math.max(b[2] - z, 0, z - b[5])
  return Math.hypot(dx, dz)
}

test('INV-1 separation: car rings never come within 4 m of each other; trains, drones and planes clear every box and the cars', () => {
  const carSamples = samplesOf(carTracks, 0.5)
  const sep = minSeparation(carSamples, 4)
  assert.ok(sep >= 4 - 1e-6, `two car rings come within ${sep} m`)
  const droneSep = minSeparation(samplesOf(ofKind('drone'), 0.5), 4)
  assert.ok(droneSep >= 4 - 1e-6, `two drone corridors come within ${droneSep} m`)
  // Every (segment, direction) belongs to one ring: no two rings share a straight sample.
  const lanes = new Map<string, number>()
  for (const t of carTracks) for (const p of t.pieces) {
    if (p.kind !== 'line') continue
    for (let local = 0; local < p.length; local += 5) {
      const k = `${(p.x0 + p.dx * local).toFixed(3)},${(p.z0 + p.dz * local).toFixed(3)},${p.dx},${p.dz}`
      assert.ok(!lanes.has(k), `rings ${lanes.get(k)} and ${t.id} share ${k}`)
      lanes.set(k, t.id)
    }
  }
  const envelope = {
    train: { half: TRACKS.train.halfWidth, low: 0, high: TRACKS.train.height },
    drone: { half: TRACKS.drone.halfSize, low: -TRACKS.drone.halfSize, high: TRACKS.drone.halfSize },
    plane: { half: TRACKS.plane.halfLength, low: -TRACKS.plane.halfHeight, high: TRACKS.plane.halfHeight },
  } as const
  const sky = net.tracks.filter((t) => t.kind !== 'car')
  for (const t of sky) {
    const env = envelope[t.kind as keyof typeof envelope]
    assert.ok(t.y + env.low - TRACKS.car.height >= 6, `${t.kind} ${t.id} at ${t.y} m is not 6 m over a car`)
    assert.ok(t.y >= (t.kind === 'train' ? TRACKS.train.deck : t.kind === 'drone' ? TRACKS.drone.altitude[0] : TRACKS.plane.altitude))
  }
  for (const seed of SEEDS) {
    const boxes = generateBuildings(seed).map((b) => b.box)
    const cell = CITY.pitch
    const hash = new Map<string, Box[]>()
    for (const b of boxes) {
      for (let i = Math.floor(b[0] / cell); i <= Math.floor(b[3] / cell); i++) for (let j = Math.floor(b[2] / cell); j <= Math.floor(b[5] / cell); j++) {
        const k = `${i},${j}`
        const list = hash.get(k)
        if (list) list.push(b); else hash.set(k, [b])
      }
    }
    for (const t of sky) {
      const env = envelope[t.kind as keyof typeof envelope]
      const y0 = t.y + env.low, y1 = t.y + env.high
      for (let s = 0; s < t.length; s += 0.5) {
        const q = poseAt(t, s)
        const cx = Math.floor(q.x / cell), cz = Math.floor(q.z / cell)
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
          for (const b of hash.get(`${cx + i},${cz + j}`) ?? []) {
            if (b[4] <= y0 || b[1] >= y1) continue
            const d = boxDistance(q.x, q.z, b)
            assert.ok(d >= env.half, `seed ${seed}: ${t.kind} ${t.id} at s ${s.toFixed(1)} (${q.x.toFixed(1)}, ${q.z.toFixed(1)}) is ${d.toFixed(2)} m from box ${b.map((v) => v.toFixed(1))}`)
          }
        }
      }
    }
    // The guideway's columns stand at the curb, clear of every lamp, tree and signal pole, and of the car lanes.
    const train = ofKind('train')[0]
    const { columns, beams } = guideway(train)
    assert.ok(columns.length > 100 && beams.length === columns.length / 2)
    const furniture = streetFurniture(seed)
    const poles: [number, number, number][] = [
      ...furniture.lamps.map(([x, z]): [number, number, number] => [x, z, POLES.lamp.radius]),
      ...furniture.trees.map(([x, z]): [number, number, number] => [x, z, POLES.tree.radius]),
      ...furniture.signals.map(([x, z]): [number, number, number] => [x, z, POLES.signal.radius]),
    ]
    for (const [x, z] of columns) {
      const off = Math.min(Math.abs(x - Math.round(x / CITY.pitch) * CITY.pitch), Math.abs(z - Math.round(z / CITY.pitch) * CITY.pitch))
      assert.ok(Math.abs(off - CITY.furniture) < 1e-6, `column (${x}, ${z}) at the curb`)
      for (const [px, pz, r] of poles) {
        const d = Math.hypot(px - x, pz - z)
        assert.ok(d >= TRACKS.train.columnRadius + r + 0.3, `seed ${seed}: a column at (${x}, ${z}) is ${d.toFixed(2)} m from a pole at (${px}, ${pz})`)
      }
      assert.ok(!boxes.some((b) => boxDistance(x, z, b) < TRACKS.train.columnRadius), 'a column stands clear of every box')
    }
    const carHash = new Map<string, Sample[]>()
    for (const p of carSamples) { const k = `${Math.floor(p.x / 4)},${Math.floor(p.z / 4)}`; const l = carHash.get(k); if (l) l.push(p); else carHash.set(k, [p]) }
    for (const [x, z] of columns) {
      const cx = Math.floor(x / 4), cz = Math.floor(z / 4)
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const p of carHash.get(`${cx + i},${cz + j}`) ?? []) {
        assert.ok(Math.hypot(p.x - x, p.z - z) >= CITY.furniture - TRAFFIC.laneOffset - 1e-6, 'a column is no nearer a car lane than a lamp')
      }
    }
  }
})

// ---------------------------------------------------------------- INV-2 / INV-3 / INV-4

test('INV-2 and INV-3: a ring at capacity keeps every gap, holds every red, never speeds, and every car laps', () => {
  const smallest = carTracks.reduce((a, b) => (b.length < a.length ? b : a))
  assert.ok(capacity(smallest) >= 12, `capacity ${capacity(smallest)}`)
  const cases: [Track, number][] = [[smallest, capacity(smallest)], [carTracks[27], 8]]
  for (const [track, n] of cases) {
    const L = track.length
    assert.ok(n <= slotCount(track) - 1 && L - 2 * HALF_LENGTH * n >= n * TRACKS.car.headway + track.slot, 'INV-3: the gaps sum to more than n headways and a slot')
    const seconds = 480
    const r = simulate([{ track, n }], seconds)
    assert.ok(r.minGap >= 1.0, `ring ${track.id} with ${n} cars: gap fell to ${r.minGap.toFixed(2)} m`)
    assert.equal(r.redBoxEntries, 0, `ring ${track.id} with ${n} cars: entered an intersection on red`)
    assert.equal(r.redLineCrossings, 0, `ring ${track.id} with ${n} cars: crossed a stop line on red`)
    assert.ok(r.maxSpeed <= TRAFFIC.speedLimit + 0.05, `max speed ${r.maxSpeed}`)
    assert.ok(r.maxLateral < 0.6, `lateral error ${r.maxLateral.toFixed(2)} m`)
    assert.ok(r.maxStuck < 8, `a car was stuck for ${r.maxStuck.toFixed(1)} s`)
    assert.equal(r.rulings, 0, 'every throttle passes the bouncer as law 0')
    assert.ok(r.throttles > 1000)
    const bound = L / 4.5 + 4 * SIGNAL.cycle * (1 + n)
    assert.ok(seconds <= bound)
    for (const c of r.cars) assert.ok(c.laps >= 1, `ring ${track.id} with ${n} cars: car ${c.follower.s.toFixed(0)} never lapped in ${seconds} s (bound ${bound.toFixed(0)} s)`)
    const windows = r.cornerWindows[0]
    assert.ok(windows.length >= Math.floor(seconds / 64) - 1)
    for (let w = 0; w < Math.floor(seconds / 64) - 1; w++) assert.ok((windows[w] ?? 0) >= 1, `ring ${track.id} with ${n} cars: no corner passed in window ${w + 1}`)
  }
})

test('INV-2 under an adversarial leader: hard random braking never closes a gap below a metre, and no throttle needs the Third Law', () => {
  const track = carTracks[10]
  const rng = createRng(3)
  const r = simulate([{ track, n: 8, brakeBursts: rng }], 240, true)
  assert.ok(r.minGap >= 1.0, `gap fell to ${r.minGap.toFixed(2)} m`)
  assert.equal(r.rulings, 0, 'every throttle > 0 passes adjudicate() as law 0 with obstacleAhead = gap')
  assert.ok(r.throttles > 1000)
  assert.equal(r.redLineCrossings, 0)
  assert.ok(r.maxSpeed <= TRAFFIC.speedLimit + 0.05)
})

test('INV-4 containment: a stalled car delays only its own ring; every other ring\'s trajectory is identical', () => {
  // Ring 27 (cell 3, 3) and the four rings sharing its streets: west, east, north and south neighbours.
  const cells = CITY.blocks / TRACKS.car.faceBlocks
  const ids = [27, 26, 28, 27 - cells, 27 + cells]
  const rings = ids.map((id) => carTracks[id])
  // The stalled car sits on the second block of its first straight: seated as a fleet would seat it, and beyond
  // the reach of a neighbouring ring's bonnet rays (they look up to 19 m past a shared corner into the lane that
  // continues); the two cars queued behind it stay beyond that reach as well.
  const stallTrack = rings[0]
  const line = stallTrack.pieces[0]
  const stallSlot = seats(stallTrack).findIndex((k) => slotStart(stallTrack, k) > line.s0 + line.length / 2)
  assert.equal(stallSlot, 2)
  const specs = (stall: number | undefined) => rings.map((track, i) => ({ track, n: i === 0 ? 3 : 6, stall: i === 0 ? stall : undefined }))
  const seconds = 300
  const clear = simulate(specs(undefined), seconds)
  const stalled = simulate(specs(stallSlot), seconds)
  const first = (r: RunStats) => r.cars.filter((c) => c.ring === 0)
  assert.ok(first(stalled).every((c) => c.laps === 0), 'the stalled ring stops circulating')
  assert.ok(first(stalled).every((c) => c.p.speed < 0.05), 'and stands')
  assert.ok(first(clear).every((c) => c.laps >= 1), 'unperturbed, it circulates')
  clear.cars.forEach((c, i) => {
    if (c.ring === 0) return
    const o = stalled.cars[i]
    assert.deepEqual(o.p, c.p, `ring ${ids[c.ring]}: a car's final pose differs`)
    assert.deepEqual(stalled.trace[i], clear.trace[i], `ring ${ids[c.ring]}: a car's trajectory differs`)
    assert.equal(o.laps, c.laps)
    assert.ok(c.laps >= 1)
  })
  assert.equal(stalled.redLineCrossings, 0)
  assert.equal(stalled.rulings, 0)
  for (const r of [clear, stalled]) assert.ok(r.minCross >= 2 * HALF_WIDTH + 1, `cars of different rings came within ${r.minCross.toFixed(2)} m of each other`)
})

test('a bonnet ray that counted tracked cars would see the cross street\'s queue head from a right turn: the Fleet must filter them', () => {
  // Cell (3, 3) turns right at V = (6, 6) in the quadrant x > V, z > V; the cell to its west turns there in the
  // quadrant x < V, z > V, and its queue head waits at the stop line of the street our car turns onto, on the
  // opposite lane: 4 m across and 11.1 m up. Three rays from the bumper at lateral −0.6, 0 and +0.6 (the Fleet's
  // gapAhead) sweep past that car's body while the turning car's heading passes 45°.
  const V: [number, number] = [6 * CITY.pitch, 6 * CITY.pitch]
  const turning = carTracks[27 - 1]
  const corner = turning.pieces.find((p) => p.kind === 'corner' && Math.abs(p.c[0] - (V[0] - TRAFFIC.laneOffset)) < 1e-9 && Math.abs(p.c[1] - (V[1] + TRAFFIC.laneOffset)) < 1e-9)
  assert.ok(corner, 'the west neighbour turns right at V from the east-bound lane')
  const queued = carTracks[27]
  const stop = queued.stops.find((st) => { const q = poseAt(queued, st.s); return Math.abs(q.x - (V[0] + TRAFFIC.laneOffset)) < 1e-9 && Math.abs(q.z - (V[1] + TRAFFIC.stopLine + HALF_LENGTH)) < 1e-9 })
  assert.ok(stop, 'cell (3, 3) holds at V on the lane heading −z, 11.1 m up the street')
  const head = poseAt(queued, stop.s)
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [head.x + a * HALF_WIDTH, head.z + b * HALF_LENGTH])
  let nearest = Infinity
  for (let local = 0; local < corner.length; local += 0.1) {
    const q = poseAt(turning, corner.s0 + local)
    const bx = q.x + q.tangentX * HALF_LENGTH, bz = q.z + q.tangentZ * HALF_LENGTH
    const rx = -q.tangentZ, rz = q.tangentX
    // The body's extent across each ray: a ray at lateral `lat` meets the body if the body's lateral span covers it.
    const framed = corners.map(([x, z]) => ({ along: (x - bx) * q.tangentX + (z - bz) * q.tangentZ, lat: (x - bx) * rx + (z - bz) * rz }))
    const latMin = Math.min(...framed.map((f) => f.lat)), latMax = Math.max(...framed.map((f) => f.lat))
    const alongMin = Math.min(...framed.map((f) => f.along))
    for (const lat of [-0.6, 0, 0.6]) if (lat >= latMin && lat <= latMax && alongMin > 0 && alongMin <= 22) nearest = Math.min(nearest, alongMin)
  }
  const envelope = TRAFFIC.turnSpeed * KERNEL.sensingLatency + (TRAFFIC.turnSpeed * TRAFFIC.turnSpeed) / (2 * KERNEL.selfDecel) + 1
  assert.ok(nearest < envelope, `the rays reach the queue head at ${nearest.toFixed(2)} m, inside the Third Law's ${envelope.toFixed(2)} m at turn speed`)
  assert.ok(nearest > KERNEL.standoff, `the bodies never meet: ${nearest.toFixed(2)} m of road stays between them (INV-1); only the sensing crosses`)
})

// ---------------------------------------------------------------- timetables, slots, projection

test('scheduledPose: periodic, evenly spaced drones and planes, train sets that dwell at every station and keep their distance', () => {
  for (const t of net.tracks.filter((t) => t.kind !== 'car')) {
    const n = scheduledCount(t)
    assert.ok(n >= 1)
    const T = lapSeconds(t)
    for (const time of [0, 17.3, 400.9, 3599.5]) {
      for (let i = 0; i < n; i++) {
        const a = scheduledPose(t, i, n, time), b = scheduledPose(t, i, n, time + T)
        assert.ok(dist(a, b) < 1e-6 && Math.abs(a.heading - b.heading) < 1e-9, `${t.kind} ${t.id}: periodic in ${T} s`)
        assert.ok([a.x, a.y, a.z, a.heading].every(Number.isFinite))
        assert.equal(a.y, t.y)
      }
    }
    if (t.kind === 'train') continue
    assert.ok(Math.abs(T - t.length / t.speedLimit) < 1e-9)
    for (const time of [0, 1.5, 123.4, 7000]) {
      const ss = Array.from({ length: n }, (_, i) => projectOnto(t, scheduledPose(t, i, n, time).x, scheduledPose(t, i, n, time).z).s).sort((a, b) => a - b)
      for (let i = 0; i < n; i++) {
        const gap = (i + 1 < n ? ss[i + 1] : ss[0] + t.length) - ss[i]
        assert.ok(Math.abs(gap - t.length / n) < 1e-3, `${t.kind} ${t.id}: spacing ${gap} at t ${time}`)
      }
    }
  }
  const train = ofKind('train')[0]
  assert.equal(train.stations.length, 4)
  assert.equal(scheduledCount(train), TRACKS.train.sets)
  for (const s of train.stations) {
    assert.equal(pieceAt(train, s).kind, 'line', 'a platform on a straight')
    const q = poseAt(train, s)
    const along = Math.abs(q.tangentX) > 0.5 ? q.x : q.z
    assert.ok(Math.abs(along - (Math.floor(along / CITY.pitch) + 0.5) * CITY.pitch) < 1e-6, `station at ${s}: mid-block`)
  }
  const T = lapSeconds(train)
  const n = TRACKS.train.sets
  let minSpacing = Infinity
  for (let time = 0; time < 3600; time += 0.5) {
    const ss = Array.from({ length: n }, (_, i) => projectOnto(train, scheduledPose(train, i, n, time).x, scheduledPose(train, i, n, time).z).s).sort((a, b) => a - b)
    for (let i = 0; i < n; i++) minSpacing = Math.min(minSpacing, (i + 1 < n ? ss[i + 1] : ss[0] + train.length) - ss[i])
  }
  assert.ok(minSpacing >= TRACKS.train.length + 50, `train sets came within ${minSpacing.toFixed(1)} m`)
  // Set 0 dwells `dwell` seconds at every station once per lap, and never exceeds its speed.
  const step = 0.1
  const dwell = train.stations.map(() => 0)
  let prev = projectOnto(train, scheduledPose(train, 0, n, 0).x, scheduledPose(train, 0, n, 0).z).s
  let maxSpeed = 0
  for (let time = step; time <= T + 1e-9; time += step) {
    const q = scheduledPose(train, 0, n, time)
    const s = projectOnto(train, q.x, q.z, prev).s
    maxSpeed = Math.max(maxSpeed, around(prev, s, train.length) / step)
    prev = s
    train.stations.forEach((st, i) => { if (Math.abs(around(s, st, train.length)) < 1e-3) dwell[i] += step })
  }
  for (const d of dwell) assert.ok(Math.abs(d - TRACKS.train.dwell) <= 2 * step, `dwelt ${d.toFixed(1)} s`)
  assert.ok(maxSpeed <= TRACKS.train.speed + 0.05, `train speed ${maxSpeed}`)
})

test('assignSlots: distinct seats on car tracks only, clear of the boxes, at least a headway apart; overflow throws', () => {
  const seatsOf = assignSlots(net, 48, createRng(11))
  assert.equal(seatsOf.length, 48)
  const keys = new Set(seatsOf.map((s) => `${s.track}:${s.s}`))
  assert.equal(keys.size, 48, 'distinct (track, slot) pairs')
  const byTrack = new Map<number, number[]>()
  for (const { track, s } of seatsOf) {
    const t = net.tracks[track]
    assert.equal(t.kind, 'car')
    assert.ok(Math.abs(((s - t.slot / 2) / t.slot) - Math.round((s - t.slot / 2) / t.slot)) < 1e-9, 'a slot start')
    assert.ok(seatable(t, s), `seat ${s} on ${track} stands clear of the intersections`)
    assert.equal(pieceAt(t, s).kind, 'line')
    const list = byTrack.get(track) ?? []
    list.push(s)
    byTrack.set(track, list)
  }
  for (const [track, list] of byTrack) {
    const t = net.tracks[track]
    assert.ok(list.length <= capacity(t))
    const sorted = Float64Array.from(list.sort((a, b) => a - b))
    for (const g of ringGaps(sorted, t.length, 2 * HALF_LENGTH)) assert.ok(g >= TRACKS.car.headway - 1e-9, `gap ${g} on ${track}`)
  }
  assert.ok(byTrack.size > 20, 'spread over the rings')
  assert.deepEqual(assignSlots(net, 48, createRng(11)), seatsOf, 'the same rng, the same seats')
  const total = carTracks.reduce((n, t) => n + capacity(t), 0)
  const slots = carTracks.reduce((n, t) => n + slotCount(t), 0)
  assert.ok(total > 48 * 10 && total < slots * 0.75, `${total} seats of ${slots} slots: the rest lie within a box or past a stop line`)
  assert.throws(() => assignSlots(net, total + 1, createRng(1)), /exceed/)
  assert.equal(assignSlots(net, total, createRng(1)).length, total)
  for (const t of carTracks) {
    assert.equal(slotCount(t), Math.floor(t.length / t.slot))
    assert.equal(capacity(t), seats(t).length)
    assert.ok(capacity(t) < slotCount(t) - 1 && capacity(t) >= 12)
    assert.ok(seats(t).every((k) => seatable(t, slotStart(t, k))))
    assert.equal(slotStart(t, 3), 3 * t.slot + t.slot / 2)
  }
  assert.deepEqual([...ringGaps(Float64Array.from([10]), 100, 4.6)], [Infinity])
  assert.deepEqual([...ringGaps(Float64Array.from([10, 30, 90]), 100, 4.6)], [15.4, 55.4, 15.4])
})

test('projectOnto round-trips beside the track with a hint, and a stale hint half a lap off still converges', () => {
  const rng = createRng(5)
  for (const t of net.tracks) {
    for (let i = 0; i < 40; i++) {
      const s = rng() * t.length
      const q = poseAt(t, s)
      const x = q.x + 0.4 * -q.tangentZ, z = q.z + 0.4 * q.tangentX
      const hinted = projectOnto(t, x, z, s + (rng() * 8 - 4))
      assert.ok(Math.abs(around(s, hinted.s, t.length)) < 1e-3, `${t.kind} ${t.id} at ${s}: hinted ${hinted.s}`)
      assert.ok(Math.abs(hinted.lateral - 0.4) < 1e-3, `lateral ${hinted.lateral}`)
      const stale = projectOnto(t, x, z, s + t.length / 2)
      assert.ok(Math.abs(around(s, stale.s, t.length)) < 1e-3, `${t.kind} ${t.id} at ${s}: stale hint gave ${stale.s}`)
      const cold = projectOnto(t, x, z)
      assert.ok(Math.abs(around(s, cold.s, t.length)) < 1e-3, `${t.kind} ${t.id} at ${s}: no hint gave ${cold.s}`)
      const leftSide = projectOnto(t, q.x - 1.2 * -q.tangentZ, q.z - 1.2 * q.tangentX, s)
      assert.ok(Math.abs(leftSide.lateral + 1.2) < 1e-3, 'negative to the left')
    }
  }
  // A car recovered 12 m off its ring is found by the global search, not by the hint.
  const t = carTracks[3]
  const q = poseAt(t, 20)
  const far = projectOnto(t, q.x + 12 * -q.tangentZ, q.z + 12 * q.tangentX, 20)
  assert.ok(Math.abs(around(20, far.s, t.length)) < 1e-3 && Math.abs(far.lateral - 12) < 1e-3)
})
