// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It runs every physics harness against a small kinematic fake of the city
 * (cars on a street grid with the signal cycle, a driver with a reaction delay, a First-Law floor, a
 * Sanctuary that flips and nudges) driven by the injected sleep, and shows each pass criterion
 * discriminates: with the matching protection switched off in the fake, the harness fails. It also pins
 * that the harnesses put the avatar and the borrowed car back and never throw.
 * What breaks if it is removed? A harness could pass vacuously, or wander off with the operator's car.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { harnesses, runHarness, type HarnessReport } from './harness.ts'
import type { SimControls } from './operator.ts'
import { CITY, CITY_SIZE } from '../01_Initialize_World/city.ts'
import { KERNEL, TRAFFIC, signalFor } from '../02_Define_The_Rules/civic.ts'
import { stoppingDistance } from '../02_Define_The_Rules/laws.ts'
import type { SipocSnapshot } from '../05_Observe_Environment/telemetry.ts'

const DT = 1 / 60
const HALF_LENGTH = 2.3
const HALF_WIDTH = 0.92
const PERSON_RADIUS = 0.3
const CRUISE = 11
/** Seconds the fake driver takes to notice a person in its path. */
const REACTION_S = 0.6
/** The fake's Sanctuary margin and where a nudged person ends up (metres off the car's centreline). */
const MARGIN = 0.25
const NUDGE_TO = HALF_WIDTH + PERSON_RADIUS + MARGIN + 0.05

interface Car {
  x: number; z: number; heading: number; speed: number
  mode: 'ai' | 'player' | 'parked'; suv: boolean
  cmd: { throttle: number; brake: number; steer: number }
  fresh: boolean
  law1Active: boolean
  hazardS: number
}

interface Faults {
  /** No First-Law floor: only the driver's own reaction stops a car. */
  kernel: boolean
  /** The driver never notices people. */
  blindDriver: boolean
  /** No Solid->Sensor flip: a car reaching the avatar takes an impact. */
  sanctuary: boolean
  /** Brakes capped at 2 m/s². */
  weakBrakes: boolean
  /** Drivers ignore the lights. */
  runsRed: boolean
}

const rel = (c: { x: number; z: number; heading: number }, px: number, pz: number) => {
  const dx = px - c.x, dz = pz - c.z, fx = Math.sin(c.heading), fz = Math.cos(c.heading)
  return { along: dx * fx + dz * fz, lateral: dx * fz - dz * fx }
}
const wrap = (v: number) => ((v % CITY_SIZE) + CITY_SIZE) % CITY_SIZE
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** A kinematic city: no collisions, no inertia beyond a 4 m/s² engine and a 0.3 m/s² coast-down. */
class FakeCity implements SimControls {
  readonly cars: Car[] = []
  readonly body = { x: 240, z: 250, heading: Math.PI, driving: false }
  readonly faults: Faults = { kernel: false, blindDriver: false, sanctuary: false, weakBrakes: false, runsRed: false }
  readonly calls: string[] = []
  time = 0
  law1 = 0
  flips = 0
  shieldedNow = false
  clearS = 0
  last = ''
  blindUntil = -1

  constructor() {
    // Eastbound on the street z = 40 (lane offset to its right, +z), northbound on x = 80 (lane to its right, -x),
    // 45 m apart so each has a clear road ahead; the last car alone on x = 200 (the harnesses borrow it).
    for (let k = 0; k < 4; k++) this.add(5 + 45 * k, CITY.pitch + TRAFFIC.laneOffset, Math.PI / 2)
    for (let k = 0; k < 3; k++) this.add(2 * CITY.pitch - TRAFFIC.laneOffset, 5 + 45 * k, 0)
    this.add(5 * CITY.pitch - TRAFFIC.laneOffset, 140, 0)
  }

  private add(x: number, z: number, heading: number): void {
    this.cars.push({ x, z, heading, speed: CRUISE, mode: 'ai', suv: false, cmd: { throttle: 0, brake: 0, steer: 0 }, fresh: false, law1Active: false, hazardS: 0 })
  }

  private car(i: number): Car {
    const c = this.cars[i]
    if (!c) throw new Error(`no vehicle ${i}`)
    return c
  }

  /** The injected sleep: advances the city by `ms` in 60 Hz ticks and resolves at once. */
  readonly sleep = async (ms: number): Promise<void> => {
    const n = Math.max(1, Math.round(ms / (1000 / 60)))
    for (let i = 0; i < n; i++) this.tick()
  }

  private tick(): void {
    this.time += DT
    const blind = this.time < this.blindUntil
    const a = this.body
    const sensed = !a.driving && !blind
    let near = false
    for (const c of this.cars) {
      // Metres from the front bumper to the person in the corridor ahead, as the fleet would sense it.
      let personAhead = Infinity
      if (sensed) {
        const r = rel(c, a.x, a.z)
        if (Math.abs(r.lateral) <= HALF_WIDTH + KERNEL.corridor + PERSON_RADIUS) {
          const gap = r.along - HALF_LENGTH - PERSON_RADIUS
          if (Math.abs(r.along) <= HALF_LENGTH) personAhead = 0
          else if (gap >= 0 && gap <= KERNEL.range) personAhead = gap
        }
      }
      const cmd = c.cmd
      if (c.mode === 'parked') {
        cmd.throttle = 0
        cmd.brake = 4
      } else if (c.mode === 'player') {
        if (!c.fresh) {
          cmd.throttle = 0
          cmd.brake = 0
        }
        c.fresh = false
      } else this.drive(c, personAhead)
      // The First-Law floor: throttle closed and full brake inside the envelope, counted on the rising edge.
      if (!this.faults.kernel) {
        const inEnvelope = personAhead <= stoppingDistance(c.speed) + KERNEL.standoff && (c.speed > 0.05 || cmd.throttle > 0)
        if (inEnvelope) {
          cmd.throttle = 0
          cmd.brake = KERNEL.maxBrake
          if (!c.law1Active) {
            this.law1++
            this.last = `First Law: person ${personAhead.toFixed(1)} m ahead`
          }
        }
        c.law1Active = inEnvelope
      }
      const cap = this.faults.weakBrakes ? 2 : 9
      if (cmd.brake > 0) c.speed = Math.max(0, c.speed - Math.min(cmd.brake, cap) * DT)
      else c.speed = Math.max(0, c.speed + (cmd.throttle * 4 - 0.3) * DT)
      // The Sanctuary: a moving footprint about to reach the person flips them and nudges them to the car's right.
      if (!a.driving && c.speed > 0.1) {
        const r = rel(c, a.x, a.z)
        const sweep = Math.abs(r.lateral) <= HALF_WIDTH + PERSON_RADIUS + MARGIN
          && r.along >= -HALF_LENGTH - PERSON_RADIUS && r.along <= HALF_LENGTH + PERSON_RADIUS + c.speed * 2 * DT + MARGIN
        const overlap = Math.abs(r.lateral) < HALF_WIDTH + PERSON_RADIUS && Math.abs(r.along) < HALF_LENGTH + PERSON_RADIUS
        if (sweep) {
          near = true
          if (this.faults.sanctuary) {
            if (overlap) c.speed *= 0.5 // an impact
          } else {
            if (!this.shieldedNow) {
              this.shieldedNow = true
              this.flips++
            }
            if (Math.abs(r.lateral) < NUDGE_TO) {
              const step = Math.min(6 * DT, NUDGE_TO - Math.abs(r.lateral))
              a.x += -Math.cos(c.heading) * step
              a.z += Math.sin(c.heading) * step
            }
          }
        } else if (Math.abs(r.lateral) <= HALF_WIDTH + PERSON_RADIUS + 0.6 && Math.abs(r.along) <= HALF_LENGTH + 0.6) near = true
      }
      const nx = c.x + Math.sin(c.heading) * c.speed * DT, nz = c.z + Math.cos(c.heading) * c.speed * DT
      c.x = c.mode === 'ai' ? wrap(nx) : nx
      c.z = c.mode === 'ai' ? wrap(nz) : nz
    }
    if (this.shieldedNow) {
      if (near) this.clearS = 0
      else if ((this.clearS += DT) >= 0.3) {
        this.shieldedNow = false
        this.clearS = 0
      }
    }
  }

  /** The AI driver: cruise, stop at the line on red (or amber with room), stop short of a person once noticed. */
  private drive(c: Car, personAhead: number): void {
    const cmd = c.cmd
    let vTarget = CRUISE
    let required = 0
    const fx = Math.sin(c.heading), fz = Math.cos(c.heading)
    const axis = Math.abs(fx) > 0.5 ? 'ew' : 'ns'
    const light = signalFor(axis, this.time)
    const along = (axis === 'ew' ? c.x * Math.sign(fx) : c.z * Math.sign(fz)) + HALF_LENGTH
    const toStop = CITY.pitch - (((along % CITY.pitch) + CITY.pitch) % CITY.pitch) - TRAFFIC.stopLine
    if (!this.faults.runsRed && light !== 'green' && toStop > -0.5 && (light === 'red' || toStop > (c.speed * c.speed) / 9)) {
      vTarget = Math.min(vTarget, toStop < 0.3 ? 0 : Math.sqrt(2 * 3 * toStop))
      required = toStop > 0.3 ? (c.speed * c.speed) / (2 * toStop) : 6
    }
    const present = personAhead < KERNEL.range && !this.faults.blindDriver
    c.hazardS = present ? c.hazardS + DT : 0
    if (present && c.hazardS >= REACTION_S) {
      const room = personAhead - (KERNEL.standoff + 0.5)
      vTarget = Math.min(vTarget, room < 0.3 ? 0 : Math.sqrt(2 * 3 * room))
      required = Math.max(required, room > 0.3 ? (c.speed * c.speed) / (2 * room) : 6)
    }
    const err = vTarget - c.speed
    if (err > 0 && required < 1 && vTarget >= 0.1) {
      cmd.throttle = Math.min(1, err * 0.5 + 0.1)
      cmd.brake = 0
    } else {
      const hold = vTarget < 0.1 && c.speed < 0.6 ? 3 : 0
      cmd.throttle = 0
      cmd.brake = Math.min(8, Math.max(hold, required * 1.15, -err * 2.2))
    }
  }

  // ---- SimControls ----
  clock = { hours: () => 17, set: (h: number) => { this.calls.push(`clock.set ${h}`) } }
  quality = { state: () => ({ tier: 3, label: 'High', auto: true, renderScale: 1, targetMs: 16.7 }), set: () => {} }
  avatar = {
    position: () => ({ x: this.body.x, z: this.body.z, heading: this.body.heading, feetY: 0 }),
    teleport: (x: number, z: number, yaw?: number) => {
      this.calls.push('avatar.teleport')
      this.body.driving = false
      this.body.x = x
      this.body.z = z
      if (yaw !== undefined) this.body.heading = yaw + Math.PI
    },
    interact: () => { this.calls.push('avatar.interact') },
    walk: () => { this.calls.push('avatar.walk') },
  }
  vehicles = {
    count: () => this.cars.length,
    state: (i: number) => {
      const c = this.car(i)
      return { x: c.x, z: c.z, heading: c.heading, speed: c.speed, mode: c.mode, suv: c.suv }
    },
    setMode: (i: number, mode: 'ai' | 'parked') => {
      this.calls.push(`vehicles.setMode ${i} ${mode}`)
      this.car(i).mode = mode
    },
    recover: (i: number, x?: number, z?: number, heading?: number) => {
      const c = this.car(i)
      this.calls.push(`vehicles.recover ${i}`)
      c.x = x ?? c.x
      c.z = z ?? c.z
      c.heading = heading ?? c.heading
      c.speed = 0
    },
    intent: (i: number, throttle: number, brake: number, steer: number) => {
      const c = this.car(i)
      if (c.mode === 'ai') c.mode = 'player'
      c.cmd.throttle = clamp(throttle, -1, 1)
      c.cmd.brake = clamp(brake, 0, KERNEL.maxBrake)
      c.cmd.steer = steer
      c.fresh = true
    },
    nearest: (x: number, z: number) => {
      let best = -1, d = Infinity
      this.cars.forEach((c, i) => { const e = Math.hypot(c.x - x, c.z - z); if (e < d) { d = e; best = i } })
      return best
    },
  }
  physics = { tune: () => ({}), set: () => { throw new Error('no tuning keys') } }
  shaders = { uniforms: () => ({}), set: () => { throw new Error('no uniforms') } }
  crowd = { stats: () => ({ drawnNear: 0, drawnFar: 0, nudges: 0, waiting: 0, crossing: 0, retreating: 0 }), cull: () => {}, positions: () => new Float32Array(0) }
  kernel = {
    stats: () => ({ law1: this.law1, law2: 0, law3: 0, sensorFlips: this.flips, shielded: this.shieldedNow, last: this.last, audit: { ticks: 0, perimeterBreaches: 0, velocityCaps: 0, closest: Infinity, panic: null } }),
    blindSensing: (on: boolean, ttlMs = 5000) => {
      this.calls.push(`kernel.blindSensing ${on}`)
      this.blindUntil = on ? this.time + ttlMs / 1000 : -1
    },
  }
  snapshot = () => ({
    customer: { signalEW: signalFor('ew', this.time), signalNS: signalFor('ns', this.time), clock: '17:00' },
    kernel: this.kernel.stats(),
    input: { mode: this.body.driving ? 'vehicle' : 'foot', nearVehicle: false },
  } as unknown as SipocSnapshot)
}

async function runOn(name: string, faults: Partial<Faults> = {}): Promise<{ report: HarnessReport; city: FakeCity }> {
  const city = new FakeCity()
  Object.assign(city.faults, faults)
  const report = await runHarness(name, city, city.sleep)
  return { report, city }
}

const checkShape = (r: HarnessReport, name: string) => {
  assert.equal(r.name, name)
  assert.equal(typeof r.pass, 'boolean')
  assert.ok(Array.isArray(r.lines) && r.lines.every((l) => typeof l === 'string'))
  assert.ok(Number.isFinite(r.ms) && r.ms >= 0)
  assert.ok(r.lines.some((l) => l.startsWith('pass:')) || !r.pass, `${name}: a report should spell out its pass criteria`)
}

test('harnesses(): the six scenarios, fresh copies, no combat vocabulary', () => {
  const list = harnesses()
  assert.deepEqual(list.map((h) => h.name), ['kernel-stop', 'first-law-floor', 'sanctuary', 'brake-distance', 'traffic-lights', 'spatial'])
  for (const h of list) {
    assert.ok(h.summary.length > 20, h.name)
    assert.doesNotMatch(`${h.name} ${h.summary}`, /\b(attack|kill|weapon|target|shoot|gun|violence|injur\w*|damage|crash|hit)\b/i)
  }
  list[0].name = 'x'
  assert.equal(harnesses()[0].name, 'kernel-stop')
})

test('kernel-stop: the driver stops for a person 18 m ahead; passes, restores the avatar, and fails with no driver and no kernel', async () => {
  const { report, city } = await runOn('kernel-stop')
  checkShape(report, 'kernel-stop')
  assert.ok(report.pass, report.lines.join('\n'))
  assert.match(report.lines[0], /person placed 15\.7 m ahead of its bumper \(outside the First-Law envelope\)/)
  assert.match(report.lines[1], /closest bumper gap \d+\.\d\d m, speed after 6 s 0\.00 m\/s, First-Law holds \+\d+, sensor flips \+0/)
  // The avatar is back where it stood, facing the same way; no harness but 'sanctuary' blinds the sensing.
  assert.deepEqual(city.avatar.position(), { x: 240, z: 250, heading: Math.PI, feetY: 0 })
  assert.ok(!city.calls.some((c) => c.startsWith('kernel.blindSensing')))
  const broken = await runOn('kernel-stop', { kernel: true, blindDriver: true })
  assert.equal(broken.report.pass, false)
  assert.match(broken.report.lines[1], /sensor flips \+[1-9]/)
})

test('first-law-floor: inside the envelope only the floor saves it; a driver alone (kernel off) is too late', async () => {
  const { report } = await runOn('first-law-floor')
  checkShape(report, 'first-law-floor')
  assert.ok(report.pass, report.lines.join('\n'))
  assert.match(report.lines[0], /0\.5 m inside the First-Law envelope/)
  assert.match(report.lines[1], /First-Law holds \+[1-9]\d*, sensor flips \+0, last: First Law: person/)
  const broken = await runOn('first-law-floor', { kernel: true })
  assert.equal(broken.report.pass, false)
  assert.match(broken.report.lines[1], /First-Law holds \+0/)
})

test('sanctuary: sensing blinded, the flip carries no impact and nudges the avatar clear; everything is put back', async () => {
  const { report, city } = await runOn('sanctuary')
  checkShape(report, 'sanctuary')
  assert.ok(report.pass, report.lines.join('\n'))
  assert.match(report.lines[0], /sensing blinded; car 7 driven north through the avatar at 1[12]\.\d\d m\/s/)
  assert.match(report.lines[1], /sensor flips \+1, shielded during the pass: yes, passed through: yes/)
  assert.match(report.lines[2], /lowest speed within 6 m of the person 1[12]\.\d\d m\/s, avatar 1\.[5-9]\d m off the car's path after, collider solid again: yes/)
  // Blinded only for the trial, then released; the borrowed car is back on its street with its AI driver; the avatar is home.
  const blinds = city.calls.filter((c) => c.startsWith('kernel.blindSensing'))
  assert.deepEqual(blinds, ['kernel.blindSensing true', 'kernel.blindSensing false'])
  assert.ok(city.calls.indexOf('kernel.blindSensing false') > city.calls.indexOf('kernel.blindSensing true'))
  const c7 = city.vehicles.state(7)
  assert.equal(c7.mode, 'ai')
  assert.ok(Math.abs(c7.x - (5 * CITY.pitch - TRAFFIC.laneOffset)) < 1e-9 && Math.abs(c7.z - 140) < 1e-9, JSON.stringify(c7))
  assert.deepEqual(city.avatar.position(), { x: 240, z: 250, heading: Math.PI, feetY: 0 })
  assert.equal(city.blindUntil, -1)
  const broken = await runOn('sanctuary', { sanctuary: true })
  assert.equal(broken.report.pass, false)
  assert.match(broken.report.lines[1], /sensor flips \+0, shielded during the pass: no/)
  assert.equal(broken.city.vehicles.state(7).mode, 'ai')
})

test('brake-distance: a stop from 40 km/h fits the envelope; weak brakes fail; the car is put back', async () => {
  const { report, city } = await runOn('brake-distance')
  checkShape(report, 'brake-distance')
  assert.ok(report.pass, report.lines.join('\n'))
  assert.match(report.lines[0], /car 7 reached 4[01] km\/h, then braked at 8 m\/s2: stopped in \d\.\d\d m/)
  assert.match(report.lines[1], /First-Law envelope 9\.\d\d m \+ standoff 1\.5 m = 1[01]\.\d\d m; ideal 7\.\d\d m/)
  assert.equal(city.vehicles.state(7).mode, 'ai')
  assert.deepEqual(city.avatar.position(), { x: 240, z: 250, heading: Math.PI, feetY: 0 })
  assert.ok(!city.calls.some((c) => c.startsWith('kernel.blindSensing') || c === 'avatar.teleport'))
  const broken = await runOn('brake-distance', { weakBrakes: true })
  assert.equal(broken.report.pass, false)
  assert.match(broken.report.lines[0], /stopped in [23]\d\.\d\d m/)
  // An AI car is borrowed ahead of a parked one; the parked car is left standing where it was.
  const park = (c: Car) => { c.mode = 'parked'; c.speed = 0 }
  const some = new FakeCity()
  park(some.cars[7])
  const r6 = await runHarness('brake-distance', some, some.sleep)
  assert.ok(r6.pass, r6.lines.join('\n'))
  assert.match(r6.lines[0], /^car 6 reached/)
  assert.deepEqual(some.vehicles.state(7), { x: 5 * CITY.pitch - TRAFFIC.laneOffset, z: 140, heading: 0, speed: 0, mode: 'parked', suv: false })
  assert.equal(some.vehicles.state(6).mode, 'ai')
  // Only parked cars left: one is handed to its driver for the trial (a parked car ignores intents) and parked again after.
  const lot = new FakeCity()
  lot.cars.forEach(park)
  const r7 = await runHarness('brake-distance', lot, lot.sleep)
  assert.ok(r7.pass, r7.lines.join('\n'))
  assert.match(r7.lines[0], /^car 7 reached 4[01] km\/h/)
  assert.deepEqual(lot.calls.filter((c) => c.startsWith('vehicles.setMode')), ['vehicles.setMode 7 ai', 'vehicles.setMode 7 parked'])
  assert.ok(lot.cars.every((c) => c.mode === 'parked'))
})

test('traffic-lights: cars hold at red and none enters on red; light-runners fail', async () => {
  const { report } = await runOn('traffic-lights')
  checkShape(report, 'traffic-lights')
  assert.ok(report.pass, report.lines.join('\n'))
  assert.match(report.lines[0], /^200 samples over 20 s across 8 cars: [1-8] held at a red light, 0 entered on red$/)
  const broken = await runOn('traffic-lights', { runsRed: true })
  assert.equal(broken.report.pass, false)
  assert.match(broken.report.lines[0], /[1-9]\d* entered on red$/)
})

test('unknown names and a failing sim become failed reports, never rejections', async () => {
  const city = new FakeCity()
  const unknown = await runHarness('nope', city, city.sleep)
  assert.deepEqual({ ...unknown, ms: 0 }, { name: 'nope', pass: false, lines: ["unknown harness 'nope'; 'harness list' names the 6 available"], ms: 0 })
  const proto = await runHarness('constructor', city, city.sleep)
  assert.equal(proto.pass, false)
  city.vehicles.count = () => { throw new TypeError('count exploded') }
  for (const name of harnesses().map((h) => h.name)) {
    const r = await runHarness(name, city, city.sleep)
    assert.equal(r.pass, false, name)
    assert.ok(r.lines.some((l) => /^error: /.test(l) || /no spare car|no suitable car/.test(l)), `${name}: ${r.lines.join(' | ')}`)
  }
  // An empty city: the trials that need a car say so.
  const empty = new FakeCity()
  empty.cars.length = 0
  assert.match((await runHarness('sanctuary', empty, empty.sleep)).lines[0], /no spare car/)
  assert.match((await runHarness('kernel-stop', empty, empty.sleep)).lines[0], /no suitable car/)
  assert.equal((await runHarness('traffic-lights', empty, empty.sleep)).pass, false)
})

test('content rules: no combat vocabulary in any report line', async () => {
  const lines: string[] = []
  for (const name of harnesses().map((h) => h.name)) {
    for (const faults of [{}, { kernel: true, blindDriver: true, sanctuary: true, weakBrakes: true, runsRed: true }]) {
      lines.push(...(await runOn(name, faults)).report.lines)
    }
  }
  assert.ok(lines.length >= 10)
  assert.doesNotMatch(lines.join('\n'), /\b(attack|kill|weapon|target|shoot|gun|violence|injur\w*|damage|crash|collide|collision)\b/i)
})
