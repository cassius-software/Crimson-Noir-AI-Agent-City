/**
 * Why does this file exist? It proves the AI driver obeys the signals: a kinematic bicycle-model car
 * driven by Driver.command() for several simulated minutes must never enter an intersection on red,
 * and must actually stop (not just slow) when the light is against it. It also proves the driver's
 * reaction to a person in its path: one Perception check per hazard episode, the latency its degree
 * sets, then a comfortable stop that leaves the standoff.
 * What breaks if it is removed? A driving-logic edit could send cars through red lights, or toward a
 * person, unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Driver, followSpeed } from './traffic.ts'
import { CITY } from '../01_Initialize_World/city.ts'
import { DRIVER_REACTION, KERNEL, signalFor, TRAFFIC } from '../02_Define_The_Rules/civic.ts'
import { CRIT_FAILURE, CRIT_SUCCESS, FAILURE, SUCCESS, createRng } from '../02_Define_The_Rules/degrees.ts'
import { adjudicate, stoppingDistance } from '../02_Define_The_Rules/laws.ts'

const DT = 1 / 60
const WHEELBASE = 2.8

function drive(seed: number, seconds: number) {
  const rng = createRng(seed)
  const from: [number, number] = [2 + Math.floor(rng() * 8), 2 + Math.floor(rng() * 8)]
  const dir: [number, number] = rng() < 0.5 ? [1, 0] : [0, 1]
  const start = Driver.lanePose(from, dir, 14)
  const driver = new Driver(from, dir, rng)
  const p = { x: start.x, z: start.z, heading: start.heading, speed: 0 }
  let inside = false
  const entries: { light: string; t: number }[] = []
  let stoppedAtRed = 0
  let maxSpeed = 0
  let laneError = 0
  for (let t = 0; t < seconds; t += DT) {
    const cmd = driver.command(p, t, Infinity, DT)
    const accel = cmd.throttle * 2.5 - cmd.brake
    p.speed = Math.max(0, p.speed + accel * DT)
    p.heading += (p.speed * Math.tan(cmd.steer)) / WHEELBASE * DT
    p.x += Math.sin(p.heading) * p.speed * DT
    p.z += Math.cos(p.heading) * p.speed * DT
    maxSpeed = Math.max(maxSpeed, p.speed)

    const ox = p.x - Math.round(p.x / CITY.pitch) * CITY.pitch
    const oz = p.z - Math.round(p.z / CITY.pitch) * CITY.pitch
    const nowInside = Math.abs(ox) < CITY.roadHalf && Math.abs(oz) < CITY.roadHalf
    if (nowInside && !inside) {
      const axis = Math.abs(Math.sin(p.heading)) > Math.abs(Math.cos(p.heading)) ? 'ew' : 'ns'
      entries.push({ light: signalFor(axis, t), t })
    }
    inside = nowInside
    if (!nowInside && p.speed < 0.05) {
      const axis = Math.abs(Math.sin(p.heading)) > Math.abs(Math.cos(p.heading)) ? 'ew' : 'ns'
      if (signalFor(axis, t) === 'red') stoppedAtRed++
    }
    // Mid-block, the car should hold its lane (centre 2 m right of the street centreline).
    const midBlock = Math.min(Math.abs(ox), Math.abs(oz)) < 4 && Math.max(Math.abs(ox), Math.abs(oz)) > 14
    if (midBlock) laneError = Math.max(laneError, Math.abs(Math.min(Math.abs(ox), Math.abs(oz)) - TRAFFIC.laneOffset))
  }
  return { entries, stoppedAtRed, maxSpeed, laneError }
}

test('AI drivers never enter an intersection on red', () => {
  let total = 0
  for (let seed = 1; seed <= 12; seed++) {
    const r = drive(seed, 240)
    total += r.entries.length
    for (const e of r.entries) assert.notEqual(e.light, 'red', `seed ${seed}: entered on red at t=${e.t.toFixed(1)}`)
  }
  assert.ok(total > 60, `only ${total} intersection entries — cars are not circulating`)
})

test('AI drivers come to a full stop for red lights, respect the limit, and keep their lane', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const r = drive(seed, 240)
    assert.ok(r.stoppedAtRed > 60, `seed ${seed}: never waited at a red light`)
    assert.ok(r.maxSpeed <= TRAFFIC.speedLimit + 0.05, `seed ${seed}: max speed ${r.maxSpeed}`)
    assert.ok(r.laneError < 0.6, `seed ${seed}: drifted ${r.laneError.toFixed(2)} m out of lane`)
  }
})

const HALF_LENGTH = 2.3
const FROM: [number, number] = [2, 5]
const EAST: [number, number] = [1, 0]
/** East-west green for the whole run. */
const GREEN = 1

/** An rng whose first draw picks a straight run through the next intersection and whose second is a d20 roll of `natural`. */
function scripted(natural: number): { rng: () => number; draws: () => number } {
  const queue = [0.1, (natural - 0.5) / 20]
  let n = 0
  return { rng: () => { n++; return queue.shift() ?? 0.5 }, draws: () => n }
}

/** A car at 40 km/h meets a person standing in its lane, `personS` metres along the street. */
function approach(natural: number, personS = 32) {
  const { rng } = scripted(natural)
  const driver = new Driver(FROM, EAST, rng)
  const start = Driver.lanePose(FROM, EAST, 0)
  const p = { x: start.x, z: start.z, heading: start.heading, speed: TRAFFIC.speedLimit }
  const personX = FROM[0] * CITY.pitch + personS
  let reactedAt = -1, minGap = Infinity, peakBrakeMoving = 0
  for (let t = 0; t < 15; t += DT) {
    const gap = personX - p.x - HALF_LENGTH
    const cmd = driver.command(p, GREEN, Infinity, DT, gap)
    if (reactedAt < 0 && cmd.brake > 0.5) reactedAt = t
    if (p.speed > 2) peakBrakeMoving = Math.max(peakBrakeMoving, cmd.brake)
    p.speed = Math.max(0, p.speed + (cmd.throttle * 2.5 - cmd.brake) * DT)
    p.heading += (p.speed * Math.tan(cmd.steer)) / WHEELBASE * DT
    p.x += Math.sin(p.heading) * p.speed * DT
    p.z += Math.cos(p.heading) * p.speed * DT
    minGap = Math.min(minGap, personX - p.x - HALF_LENGTH)
  }
  return { driver, reactedAt, minGap, finalGap: personX - p.x - HALF_LENGTH, finalSpeed: p.speed, peakBrakeMoving }
}

test('a person in the path: the degree of the Perception check sets the reaction latency', () => {
  const cases: [number, number][] = [[1, CRIT_FAILURE], [3, FAILURE], [10, SUCCESS], [18, CRIT_SUCCESS]]
  for (const [natural, degree] of cases) {
    const r = approach(natural)
    assert.equal(r.driver.check?.degree, degree, `natural ${natural}`)
    const latency = DRIVER_REACTION.latency[degree]
    assert.ok(Math.abs(r.reactedAt - latency) <= 2 * DT, `natural ${natural}: reacted at ${r.reactedAt.toFixed(3)} s, latency ${latency} s`)
  }
})

test('after reacting the driver plans a comfortable stop that leaves the standoff', () => {
  for (const natural of [1, 3, 10, 18]) {
    const r = approach(natural)
    assert.ok(r.finalSpeed < 0.05, `natural ${natural}: still moving at ${r.finalSpeed.toFixed(2)} m/s`)
    assert.ok(r.minGap >= KERNEL.standoff + 0.3, `natural ${natural}: came within ${r.minGap.toFixed(2)} m`)
    assert.ok(r.finalGap <= KERNEL.standoff + 1.2, `natural ${natural}: stopped ${r.finalGap.toFixed(2)} m short, too early`)
    // Even the slowest reaction (a critical failure) leaves a comfortable stop from 30 m at 40 km/h.
    assert.ok(r.peakBrakeMoving <= 5, `natural ${natural}: braked at ${r.peakBrakeMoving.toFixed(1)} m/s²`)
  }
})

test('one roll per hazard episode: a flicker keeps the roll, a clear path for a second ends the episode', () => {
  const { rng, draws } = scripted(10)
  const driver = new Driver(FROM, EAST, rng)
  const start = Driver.lanePose(FROM, EAST, 0)
  const p = { x: start.x, z: start.z, heading: start.heading, speed: 0 }
  const step = (seconds: number, person: number) => {
    for (let t = 0; t < seconds; t += DT) driver.command(p, GREEN, Infinity, DT, person)
  }
  const before = draws()
  step(0.5, Infinity)
  assert.equal(driver.check, null)
  assert.equal(draws(), before, 'no person, no roll')

  step(2, 12)
  const first = driver.check
  assert.ok(first, 'a person inside the range starts an episode')
  assert.equal(draws(), before + 1, 'exactly one roll')
  assert.ok(driver.reacted)

  step(0.5, Infinity)
  step(0.5, 12)
  assert.equal(driver.check, first, 'a person who flickers out of the corridor for 0.5 s is the same episode')
  assert.equal(draws(), before + 1)
  assert.ok(driver.reacted, 'the driver stays alert through the flicker')

  step(0.5, KERNEL.range + 5)
  assert.equal(driver.check, first, 'beyond the sensing range counts as clear, but only after a full second')
  step(0.6, Infinity)
  assert.equal(driver.check, null, 'clear for a second: the episode is over')
  step(DT, 20)
  assert.notEqual(driver.check, first)
  assert.equal(draws(), before + 2, 'a new episode rolls again')
  assert.equal(driver.reacted, false, 'and the new latency starts over')
})

test('a person the driver has noticed holds the car at the standoff, and it moves off once they leave', () => {
  const { rng } = scripted(18)
  const driver = new Driver(FROM, EAST, rng)
  const start = Driver.lanePose(FROM, EAST, 0)
  const p = { x: start.x, z: start.z, heading: start.heading, speed: 0 }
  const personX = FROM[0] * CITY.pitch + 20
  const run = (seconds: number, present: boolean) => {
    for (let t = 0; t < seconds; t += DT) {
      const gap = personX - p.x - HALF_LENGTH
      const cmd = driver.command(p, GREEN, Infinity, DT, present ? gap : Infinity)
      p.speed = Math.max(0, p.speed + (cmd.throttle * 2.5 - cmd.brake) * DT)
      p.x += Math.sin(p.heading) * p.speed * DT
      p.z += Math.cos(p.heading) * p.speed * DT
    }
  }
  run(20, true)
  assert.ok(p.speed < 0.05)
  const held = personX - p.x - HALF_LENGTH
  assert.ok(held >= KERNEL.standoff && held <= KERNEL.standoff + 1.2, `held ${held.toFixed(2)} m back`)
  run(3, false)
  assert.ok(p.speed > 3, 'drives on once the person has left the path')
})

test('a following driver never throttles into the Third Law envelope, nor when it means to stand still', () => {
  for (let gap = 2; gap <= 40; gap += 2) {
    const v = followSpeed(gap)
    assert.ok(Math.abs(stoppingDistance(v, KERNEL.selfDecel) + 1.5 - gap) < 1e-9, `gap ${gap}`)
  }
  assert.equal(followSpeed(1), 0)
  const start = Driver.lanePose(FROM, EAST, 5)
  for (let gap = 0; gap <= 40; gap += 0.25) {
    for (let speed = -0.05; speed <= TRAFFIC.speedLimit; speed += 0.1) {
      const driver = new Driver(FROM, EAST, createRng(1))
      const cmd = driver.command({ x: start.x, z: start.z, heading: start.heading, speed }, GREEN, gap, DT)
      if (cmd.throttle <= 0) continue
      const ruling = adjudicate(cmd, { source: 'ai', speed, personAhead: Infinity, personBehind: Infinity, obstacleAhead: gap })
      assert.equal(ruling.law, 0, `gap ${gap} m at ${speed.toFixed(2)} m/s: ${ruling.reason}`)
    }
  }
})
