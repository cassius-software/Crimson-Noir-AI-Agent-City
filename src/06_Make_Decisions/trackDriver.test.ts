/**
 * Why does this file exist? It proves the track follower in Node, with no physics engine: a TrackDriver never
 * enters an intersection on red, stands at red, keeps its lane and the limit, and draws nothing from the seeded
 * stream but its hazard roll; rings of real TrackDrivers keep the zero-jam invariants tracks.test.ts states
 * (INV-2 headway, INV-3 progress, INV-4 containment) with the gap a Fleet feeds them; the hazard episode it
 * shares with the street driver gives the same degrees, latencies and standoff hold as traffic.test.ts's scripted
 * rolls; and a car set down off its track steers back onto it at corner speed.
 * What breaks if it is removed? A change to the follower could run a red, cut a corner into the oncoming lane,
 * roll the Perception check twice, or leave a recovered car stranded, unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TrackDriver } from './trackDriver.ts'
import { TRACKS, buildTrackNetwork, capacity, pieceAt, poseAt, projectOnto, ringGaps, seats, slotCount, slotStart, type Track } from './tracks.ts'
import { CITY } from '../01_Initialize_World/city.ts'
import { DRIVER_REACTION, KERNEL, SIGNAL, TRAFFIC, signalFor, type Axis } from '../02_Define_The_Rules/civic.ts'
import { CRIT_FAILURE, CRIT_SUCCESS, FAILURE, SUCCESS, createRng } from '../02_Define_The_Rules/degrees.ts'
import { adjudicate } from '../02_Define_The_Rules/laws.ts'

const DT = 1 / 60
const WHEELBASE = 2.8
const HALF_LENGTH = 2.3
const HALF_WIDTH = 0.92
/**
 * What a Fleet's bonnet rays read on an empty city once the cars on rings are filtered out of them (vehicles.ts
 * #gapAhead): nothing. The driver's gap is then its ring gap alone.
 */
const RAY_CLEAR = Infinity

const net = buildTrackNetwork(1337)
const carTracks = net.tracks.filter((t) => t.kind === 'car')

interface Pose { x: number; z: number; heading: number; speed: number }

/** The kinematic bicycle model of traffic.test.ts: accel = throttle · 2.5 − brake. */
function advance(p: Pose, cmd: { throttle: number; brake: number; steer: number }): void {
  p.speed = Math.max(0, p.speed + (cmd.throttle * 2.5 - cmd.brake) * DT)
  p.heading += (p.speed * Math.tan(cmd.steer)) / WHEELBASE * DT
  p.x += Math.sin(p.heading) * p.speed * DT
  p.z += Math.cos(p.heading) * p.speed * DT
}

/** The intersection-box test of traffic.test.ts:42-48. */
function inBox(p: Pose): boolean {
  const ox = p.x - Math.round(p.x / CITY.pitch) * CITY.pitch
  const oz = p.z - Math.round(p.z / CITY.pitch) * CITY.pitch
  return Math.abs(ox) < CITY.roadHalf && Math.abs(oz) < CITY.roadHalf
}

/** A seed's ring and a seat on it. */
function seatOn(track: Track, k = 0): number {
  return slotStart(track, seats(track)[k])
}

/** The signal second at which the straight under `s` is green (ew green at 1, ns green at 17). */
function greenFor(track: Track, s: number): number {
  const piece = pieceAt(track, s)
  return piece.kind === 'line' && piece.axis === 'ns' ? 17 : 1
}

test('a track driver never enters on red, stops at red, keeps its lane and its speed, and draws only its hazard roll', () => {
  let totalEntries = 0
  for (let seed = 1; seed <= 6; seed++) {
    const track = carTracks[(seed * 11) % carTracks.length]
    let draws = 0
    const rng = () => { draws++; return 0.5 }
    const s0 = seatOn(track, seed % seats(track).length)
    const driver = new TrackDriver(track, s0, rng)
    const q = poseAt(track, s0)
    const p: Pose = { x: q.x, z: q.z, heading: q.heading, speed: 0 }
    let inside = inBox(p)
    let approach: Axis = 'ew'
    let entries = 0, stoppedAtRed = 0, maxSpeed = 0, maxLateral = 0, laps = 0, lastS = s0
    for (let t = 0; t < 240; t += DT) {
      const cmd = driver.command(p, t, RAY_CLEAR, DT)
      advance(p, cmd)
      maxSpeed = Math.max(maxSpeed, p.speed)
      const s = driver.progress
      if (s < lastS - track.length / 2) laps++
      lastS = s
      const piece = pieceAt(track, s)
      if (piece.kind === 'line') approach = piece.axis
      maxLateral = Math.max(maxLateral, Math.abs(projectOnto(track, p.x, p.z, s).lateral))
      const nowInside = inBox(p)
      if (nowInside && !inside) {
        entries++
        assert.notEqual(signalFor(approach, t), 'red', `seed ${seed}: entered an intersection on red at t=${t.toFixed(1)}`)
      }
      inside = nowInside
      if (!nowInside && p.speed < 0.05 && signalFor(approach, t) === 'red') stoppedAtRed++
    }
    totalEntries += entries
    assert.ok(stoppedAtRed > 60, `seed ${seed}: never waited at a red light`)
    assert.ok(maxSpeed <= TRAFFIC.speedLimit + 0.05, `seed ${seed}: max speed ${maxSpeed}`)
    assert.ok(maxLateral < 0.6, `seed ${seed}: drifted ${maxLateral.toFixed(2)} m out of lane`)
    assert.ok(laps >= 1, `seed ${seed}: never lapped its ring`)
    assert.equal(draws, 0, 'a track driver picks no route: nothing is drawn from the stream without a person')
    assert.equal(driver.track, track.id)
  }
  assert.ok(totalEntries > 40, `only ${totalEntries} intersection entries: cars are not circulating`)
})

// ---------------------------------------------------------------- rings of TrackDrivers (INV-2 / INV-3 / INV-4)

interface Car { ring: number; driver: TrackDriver; p: Pose; laps: number; lastS: number; inside: boolean; approach: Axis; prevToStop: number; stalled: boolean }
interface RingSpec { track: Track; n: number; stall?: number; brakeBursts?: () => number }
interface RunStats {
  minGap: number; maxSpeed: number; maxLateral: number; maxStuck: number; redBoxEntries: number; rulings: number; throttles: number
  minCross: number; cars: Car[]; cornerWindows: number[][]; trace: Float64Array[]
}

/** Signed distance to the stop line a car at `s` answers to, for the red-line rule below. */
function toStopOf(track: Track, s: number): { d: number; axis: Axis } | null {
  let best: { d: number; axis: Axis } | null = null
  const behind = TRAFFIC.stopLine + CITY.roadHalf + 2 * HALF_LENGTH
  for (const stop of track.stops) {
    const d = ((stop.s - s + behind) % track.length + track.length) % track.length - behind
    if (best === null || d < best.d) best = { d, axis: stop.axis }
  }
  return best
}

/**
 * Every ring's cars driven by real TrackDrivers with the gap a Fleet feeds them: min(rays, ringGaps) with the rays
 * clear (the Fleet filters the cars on rings out of them). The same statistics as tracks.test.ts's simulate().
 */
function simulate(specs: RingSpec[], seconds: number, adversarial = false): RunStats {
  const cars: Car[] = []
  specs.forEach((spec, ring) => {
    const seatsOf = seats(spec.track)
    assert.ok(spec.n <= seatsOf.length)
    for (let k = 0; k < spec.n; k++) {
      const s = slotStart(spec.track, seatsOf[k])
      const q = poseAt(spec.track, s)
      const piece = pieceAt(spec.track, s)
      cars.push({
        ring, driver: new TrackDriver(spec.track, s, createRng(ring * 100 + k)), p: { x: q.x, z: q.z, heading: q.heading, speed: 0 }, laps: 0, lastS: s,
        inside: inBox({ x: q.x, z: q.z, heading: q.heading, speed: 0 }), approach: piece.kind === 'line' ? piece.axis : 'ew', prevToStop: NaN, stalled: spec.stall === k,
      })
    }
  })
  const stats: RunStats = {
    minGap: Infinity, maxSpeed: 0, maxLateral: 0, maxStuck: 0, redBoxEntries: 0, rulings: 0, throttles: 0, minCross: Infinity, cars,
    cornerWindows: specs.map(() => []), trace: cars.map(() => new Float64Array(2 * (Math.floor(seconds / 10) + 1))),
  }
  let redLineCrossings = 0
  const order = specs.map((spec) => new Float64Array(spec.n))
  const byRing = specs.map((_, ring) => cars.map((c, i) => (c.ring === ring ? i : -1)).filter((i) => i >= 0))
  const burst = specs.map(() => 0)
  let frame = 0
  for (let t = 0; t < seconds; t += DT, frame++) {
    if (frame % 600 === 0) cars.forEach((c, i) => { stats.trace[i][2 * (frame / 600)] = c.p.x; stats.trace[i][2 * (frame / 600) + 1] = c.p.z })
    const window = Math.floor(t / 64)
    specs.forEach((spec, ring) => {
      const idx = byRing[ring].slice().sort((a, b) => cars[a].driver.progress - cars[b].driver.progress)
      idx.forEach((i, k) => { order[ring][k] = cars[i].driver.progress })
      const gaps = ringGaps(order[ring], spec.track.length, 2 * HALF_LENGTH)
      if (spec.brakeBursts) burst[ring] = burst[ring] > 0 ? burst[ring] - DT : spec.brakeBursts() < 0.004 ? 2 : 0
      idx.forEach((i, k) => {
        const c = cars[i]
        const gap = Math.min(RAY_CLEAR, gaps[k])
        if (specs.length > 1 && frame % 6 === 0) {
          for (const o of cars) if (o.ring !== c.ring) stats.minCross = Math.min(stats.minCross, Math.hypot(o.p.x - c.p.x, o.p.z - c.p.z))
        }
        if (spec.n > 1) stats.minGap = Math.min(stats.minGap, gaps[k])
        c.driver.ringGap = gaps[k]
        let cmd = c.driver.command(c.p, t, gap, DT)
        if (c.stalled) cmd = { throttle: 0, brake: 8, steer: cmd.steer }
        if (adversarial && k === idx.length - 1 && burst[ring] > 0) cmd = { ...cmd, throttle: 0, brake: KERNEL.maxBrake }
        if (cmd.throttle > 0) {
          stats.throttles++
          const ruling = adjudicate(cmd, { source: 'ai', speed: c.p.speed, personAhead: Infinity, personBehind: Infinity, obstacleAhead: gap })
          if (ruling.law !== 0) stats.rulings++
        }
        stats.maxStuck = Math.max(stats.maxStuck, c.driver.stuckSeconds)
        const stop = toStopOf(spec.track, c.driver.progress)
        if (stop && Number.isFinite(c.prevToStop) && c.prevToStop > 0 && stop.d <= 0 && c.prevToStop - stop.d < 15 && signalFor(stop.axis, t) === 'red') redLineCrossings++
        c.prevToStop = stop ? stop.d : NaN

        advance(c.p, cmd)
        stats.maxSpeed = Math.max(stats.maxSpeed, c.p.speed)
        const s = c.driver.progress
        stats.maxLateral = Math.max(stats.maxLateral, Math.abs(projectOnto(spec.track, c.p.x, c.p.z, s).lateral))
        if (s < c.lastS - spec.track.length / 2) c.laps++
        const before = pieceAt(spec.track, c.lastS), after = pieceAt(spec.track, s)
        if (after.kind === 'corner' && before !== after && window > 0) stats.cornerWindows[ring][window - 1] = (stats.cornerWindows[ring][window - 1] ?? 0) + 1
        if (after.kind === 'line') c.approach = after.axis
        c.lastS = s
        const nowInside = inBox(c.p)
        if (nowInside && !c.inside && signalFor(c.approach, t) === 'red') stats.redBoxEntries++
        c.inside = nowInside
      })
    })
  }
  assert.equal(redLineCrossings, 0, 'no stop line is crossed on red')
  return stats
}

test('following on a ring: real TrackDrivers at capacity keep every gap, hold every red, never speed, and every car laps (INV-2, INV-3)', () => {
  const smallest = carTracks.reduce((a, b) => (b.length < a.length ? b : a))
  const n = capacity(smallest)
  assert.ok(n >= 12 && n <= slotCount(smallest) - 1)
  const seconds = 480
  const r = simulate([{ track: smallest, n }], seconds)
  assert.ok(r.minGap >= 1.0, `gap fell to ${r.minGap.toFixed(2)} m`)
  assert.equal(r.redBoxEntries, 0)
  assert.ok(r.maxSpeed <= TRAFFIC.speedLimit + 0.05, `max speed ${r.maxSpeed}`)
  assert.ok(r.maxLateral < 0.6, `lateral error ${r.maxLateral.toFixed(2)} m`)
  assert.ok(r.maxStuck < 8)
  assert.equal(r.rulings, 0, 'every throttle passes the bouncer as law 0 with the fed gap as obstacleAhead')
  assert.ok(r.throttles > 1000)
  const bound = smallest.length / 4.5 + 4 * SIGNAL.cycle * (1 + n)
  assert.ok(seconds <= bound)
  for (const c of r.cars) assert.ok(c.laps >= 1, `car at ${c.driver.progress.toFixed(0)} never lapped`)
  for (let w = 0; w < Math.floor(seconds / 64) - 1; w++) assert.ok((r.cornerWindows[0][w] ?? 0) >= 1, `no corner passed in window ${w + 1}`)
})

test('following an adversarial leader: hard random braking never closes a gap below a metre, and no throttle needs the Third Law', () => {
  const r = simulate([{ track: carTracks[10], n: 8, brakeBursts: createRng(3) }], 240, true)
  assert.ok(r.minGap >= 1.0, `gap fell to ${r.minGap.toFixed(2)} m`)
  assert.equal(r.rulings, 0)
  assert.ok(r.throttles > 1000)
  assert.ok(r.maxSpeed <= TRAFFIC.speedLimit + 0.05)
})

test('containment (INV-4): a car held on one ring delays only that ring; every neighbouring ring drives the same trajectory', () => {
  const cells = CITY.blocks / TRACKS.car.faceBlocks
  const ids = [27, 26, 28, 27 - cells, 27 + cells]
  const rings = ids.map((id) => carTracks[id])
  const line = rings[0].pieces[0]
  const stallSlot = seats(rings[0]).findIndex((k) => slotStart(rings[0], k) > line.s0 + line.length / 2)
  assert.ok(stallSlot >= 0)
  const specs = (stall: number | undefined) => rings.map((track, i) => ({ track, n: i === 0 ? 3 : 6, stall: i === 0 ? stall : undefined }))
  const seconds = 240
  const clear = simulate(specs(undefined), seconds)
  const stalled = simulate(specs(stallSlot), seconds)
  const first = (r: RunStats) => r.cars.filter((c) => c.ring === 0)
  assert.ok(first(stalled).every((c) => c.laps === 0 && c.p.speed < 0.05), 'the held ring stands')
  assert.ok(first(clear).every((c) => c.laps >= 1), 'unperturbed, it circulates')
  clear.cars.forEach((c, i) => {
    if (c.ring === 0) return
    assert.deepEqual(stalled.cars[i].p, c.p, `ring ${ids[c.ring]}: a car's final pose differs`)
    assert.deepEqual(stalled.trace[i], clear.trace[i], `ring ${ids[c.ring]}: a car's trajectory differs`)
    assert.ok(c.laps >= 1)
  })
  assert.equal(stalled.rulings, 0)
  for (const r of [clear, stalled]) assert.ok(r.minCross >= 2 * HALF_WIDTH + 1, `cars of different rings came within ${r.minCross.toFixed(2)} m`)
})

// ---------------------------------------------------------------- the shared hazard episode

/** An rng whose first (and only scripted) draw is a d20 roll of `natural`: a track driver draws no turn. */
function scripted(natural: number): { rng: () => number; draws: () => number } {
  const queue = [(natural - 0.5) / 20]
  let n = 0
  return { rng: () => { n++; return queue.shift() ?? 0.5 }, draws: () => n }
}

/** Ring 0's first straight: its start, and a pose on it `along` metres in. */
const straight = carTracks[0].pieces[0]
assert.equal(straight.kind, 'line')
const S0 = straight.s0
const GREEN = greenFor(carTracks[0], S0)
function onStraight(along: number, speed: number): Pose {
  const q = poseAt(carTracks[0], S0 + along)
  return { x: q.x, z: q.z, heading: q.heading, speed }
}
const alongOf = (p: Pose) => (p.x - straight.x0) * straight.dx + (p.z - straight.z0) * straight.dz

/** A car at 40 km/h meets a person standing in its lane, `personS` metres along the straight: traffic.test.ts's approach(). */
function approach(natural: number, personS = 32) {
  const { rng } = scripted(natural)
  const driver = new TrackDriver(carTracks[0], S0, rng)
  const p = onStraight(0, TRAFFIC.speedLimit)
  let reactedAt = -1, minGap = Infinity, peakBrakeMoving = 0
  for (let t = 0; t < 15; t += DT) {
    const gap = personS - alongOf(p) - HALF_LENGTH
    const cmd = driver.command(p, GREEN, Infinity, DT, gap)
    if (reactedAt < 0 && cmd.brake > 0.5) reactedAt = t
    if (p.speed > 2) peakBrakeMoving = Math.max(peakBrakeMoving, cmd.brake)
    advance(p, cmd)
    minGap = Math.min(minGap, personS - alongOf(p) - HALF_LENGTH)
  }
  return { driver, reactedAt, minGap, finalGap: personS - alongOf(p) - HALF_LENGTH, finalSpeed: p.speed, peakBrakeMoving }
}

test('the hazard episode is shared: the same degrees, latencies and comfortable stop as the street driver', () => {
  const cases: [number, number][] = [[1, CRIT_FAILURE], [3, FAILURE], [10, SUCCESS], [18, CRIT_SUCCESS]]
  for (const [natural, degree] of cases) {
    const r = approach(natural)
    assert.equal(r.driver.check?.degree, degree, `natural ${natural}`)
    const latency = DRIVER_REACTION.latency[degree]
    assert.equal(r.driver.reactionLatency, latency)
    assert.ok(Math.abs(r.reactedAt - latency) <= 2 * DT, `natural ${natural}: reacted at ${r.reactedAt.toFixed(3)} s, latency ${latency} s`)
    assert.ok(r.finalSpeed < 0.05, `natural ${natural}: still moving at ${r.finalSpeed.toFixed(2)} m/s`)
    assert.ok(r.minGap >= KERNEL.standoff + 0.3, `natural ${natural}: came within ${r.minGap.toFixed(2)} m`)
    assert.ok(r.finalGap <= KERNEL.standoff + 1.2, `natural ${natural}: stopped ${r.finalGap.toFixed(2)} m short, too early`)
    assert.ok(r.peakBrakeMoving <= 5, `natural ${natural}: braked at ${r.peakBrakeMoving.toFixed(1)} m/s²`)
  }
})

test('one roll per hazard episode on a track too: a flicker keeps the roll, a clear second ends the episode', () => {
  const { rng, draws } = scripted(10)
  const driver = new TrackDriver(carTracks[0], S0, rng)
  const p = onStraight(0, 0)
  const step = (seconds: number, person: number) => {
    for (let t = 0; t < seconds; t += DT) driver.command(p, GREEN, Infinity, DT, person)
  }
  step(0.5, Infinity)
  assert.equal(driver.check, null)
  assert.equal(draws(), 0, 'no person, no roll; no route either')
  step(2, 12)
  const first = driver.check
  assert.ok(first)
  assert.equal(draws(), 1, 'exactly one roll')
  assert.ok(driver.reacted)
  step(0.5, Infinity)
  step(0.5, 12)
  assert.equal(driver.check, first, 'a flicker is the same episode')
  assert.equal(draws(), 1)
  step(0.5, KERNEL.range + 5)
  assert.equal(driver.check, first)
  step(0.6, Infinity)
  assert.equal(driver.check, null, 'clear for a second: the episode is over')
  step(DT, 20)
  assert.notEqual(driver.check, first)
  assert.equal(draws(), 2, 'a new episode rolls again')
  assert.equal(driver.reacted, false)
})

test('a person the track driver has noticed holds the car at the standoff, and it moves off once they leave', () => {
  const { rng } = scripted(18)
  const driver = new TrackDriver(carTracks[0], S0, rng)
  const p = onStraight(0, 0)
  const personS = 20
  const run = (seconds: number, present: boolean) => {
    for (let t = 0; t < seconds; t += DT) {
      const gap = personS - alongOf(p) - HALF_LENGTH
      advance(p, driver.command(p, GREEN, Infinity, DT, present ? gap : Infinity))
    }
  }
  run(20, true)
  assert.ok(p.speed < 0.05)
  const held = personS - alongOf(p) - HALF_LENGTH
  assert.ok(held >= KERNEL.standoff && held <= KERNEL.standoff + 1.2, `held ${held.toFixed(2)} m back`)
  run(3, false)
  assert.ok(p.speed > 3, 'drives on once the person has left the path')
})

// ---------------------------------------------------------------- rejoining

test('a recovered car rejoins its ring: set down 12 m off the track it is back in its lane inside 15 s, never over corner speed, then drives on', () => {
  for (const [id, side] of [[5, 1], [40, -1]] as const) {
    const track = carTracks[id]
    const s0 = seatOn(track)
    const driver = new TrackDriver(track, s0, createRng(1))
    const q = poseAt(track, s0)
    // Beside the track, `side` · 12 m to the right of travel, facing along it.
    const p: Pose = { x: q.x - q.tangentZ * 12 * side, z: q.z + q.tangentX * 12 * side, heading: q.heading, speed: 0 }
    let rejoinedAt = -1, maxSpeedBefore = 0, sawRejoining = false
    let t = 0
    for (; t < 15; t += DT) {
      const cmd = driver.command(p, t, Infinity, DT)
      sawRejoining ||= driver.rejoining
      advance(p, cmd)
      const { lateral } = projectOnto(track, p.x, p.z, driver.progress)
      if (rejoinedAt < 0) {
        maxSpeedBefore = Math.max(maxSpeedBefore, p.speed)
        if (Math.abs(lateral) <= 0.8) rejoinedAt = t
      }
    }
    assert.ok(sawRejoining, `ring ${id}: the driver noticed it was off its track`)
    assert.ok(rejoinedAt >= 0, `ring ${id}: still off the track after 15 s`)
    assert.ok(maxSpeedBefore <= track.cornerSpeed + 0.05, `ring ${id}: ${maxSpeedBefore.toFixed(2)} m/s on the way back`)
    assert.equal(driver.rejoining, false)
    // Back in its lane it drives the ring as any car does: on through a whole signal cycle (a red may hold it first).
    const before = driver.progress
    let maxLateral = 0, maxSpeed = 0
    for (const end = t + SIGNAL.cycle + 10; t < end; t += DT) {
      advance(p, driver.command(p, t, Infinity, DT))
      maxLateral = Math.max(maxLateral, Math.abs(projectOnto(track, p.x, p.z, driver.progress).lateral))
      maxSpeed = Math.max(maxSpeed, p.speed)
    }
    const gained = ((driver.progress - before) % track.length + track.length) % track.length
    assert.ok(gained > 60, `ring ${id}: only ${gained.toFixed(1)} m on in a cycle`)
    assert.ok(maxSpeed > track.cornerSpeed + 1, `ring ${id}: back up to road speed`)
    assert.ok(maxLateral < 0.8, `ring ${id}: ${maxLateral.toFixed(2)} m off the lane after rejoining`)
  }
})

test('locate re-projects a standing car without driving it', () => {
  const track = carTracks[3]
  const s0 = seatOn(track, 2)
  const driver = new TrackDriver(track, s0, createRng(2))
  const q = poseAt(track, s0 + 30)
  const r = driver.locate(q.x - q.tangentZ * 0.4, q.z + q.tangentX * 0.4)
  assert.ok(Math.abs(r.s - (s0 + 30)) < 1e-3 && Math.abs(r.lateral - 0.4) < 1e-3)
  assert.ok(Math.abs(driver.progress - (s0 + 30)) < 1e-3)
  assert.equal(driver.stuckSeconds, 0)
})
