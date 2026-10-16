// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the Ring-0 audit: every violation code from a constructed scenario;
 * every legitimate non-panic measured on this build (a driver inside their own car, a sidewalk pass 1.1 m
 * from the car's side, a shielded person inside a footprint, a person 1.6 m ahead under an emergency
 * stop, a harness that blinded sensing, a car at full lock passing someone the straight band would have
 * claimed, the one-frame race between the kernel's vet and the audit); the path corridor against a
 * brute-force drive of the bicycle model and against the bouncer's own corridorDistance; the watched
 * perimeter; the velocity cap against RUNAWAY; an allocation-free run; frozen exports; the panic helper;
 * and the 14A wording of every reason. Then, live over real Rapier in engine order (vet, substeps, audit),
 * the kernel itself: a runner stepping into an AI car's lane inside its stopping distance, and a walker
 * shoving a parked car, must never produce a violation at 60 fps or at 20 fps.
 * What breaks if it is removed? A false positive here locks the whole product; a false negative lets a
 * failed kernel keep rendering.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { KERNEL, TRAFFIC } from './civic.ts'
import { createRng } from './degrees.ts'
import type { Intent } from './laws.ts'
import { auditCraft, CRAFT, kernelPanic, panicReason, RING0, Ring0Auditor, type AuditPerson, type AuditResult, type AuditVehicle, type Violation } from './ring0.ts'
import { TRACKS, buildTrackNetwork } from '../06_Make_Decisions/tracks.ts'
import { TRACK_KINDS, TRACK_POSE } from '../07_Execute_Actions/simProtocol.ts'
import { TrackFleet } from '../07_Execute_Actions/trackFleet.ts'
import { Driver } from '../06_Make_Decisions/traffic.ts'
import { Physics } from '../07_Execute_Actions/physics.ts'
import { Avatar } from '../07_Execute_Actions/player.ts'
import { Sanctuary } from '../07_Execute_Actions/sanctuary.ts'
import { CAR, corridorDistance, Fleet, type Vehicle } from '../07_Execute_Actions/vehicles.ts'

const CENTRE = { x: 240, z: 240 }
const SEDAN = { halfLength: 2.3, halfWidth: 0.92 }
/** Full lock: tan(CAR.maxSteer) / CAR.wheelbase (vehicles.ts; checked against it below). */
const FULL_LOCK = Math.tan(0.6) / 2.8
/** The rear axle's distance behind the chassis centre, half the wheelbase (vehicles.ts; checked below). */
const AXLE = 1.4
const HALF = SEDAN.halfWidth + KERNEL.corridor

/** A sedan at the city centre facing `heading`, its body moving at `speed` along it, with the command given. */
function car(over: Partial<AuditVehicle> = {}): AuditVehicle {
  const heading = over.heading ?? 0
  const speed = over.speed ?? 0
  return {
    id: 1, x: CENTRE.x, y: 0.56, z: CENTRE.z, vx: Math.sin(heading) * speed, vy: 0, vz: Math.cos(heading) * speed,
    heading, ...SEDAN, speed, throttle: 0, brake: 0, occupant: -1, ...over,
  }
}
/** A solid person `ahead` metres in front of the car's centre and `left` metres to its left, in the car's frame. */
function personAt(c: AuditVehicle, ahead: number, left: number, over: Partial<AuditPerson> = {}): AuditPerson {
  const fx = Math.sin(c.heading), fz = Math.cos(c.heading)
  return { id: 0, x: c.x + fx * ahead + fz * left, y: 0.9, z: c.z + fz * ahead - fx * left, solid: true, ...over }
}
/** A person `gap` metres beyond the front bumper (negative: behind the rear one), `left` to the car's left. */
const beyondBumper = (c: AuditVehicle, gap: number, left: number, over: Partial<AuditPerson> = {}) =>
  personAt(c, gap >= 0 ? c.halfLength + gap : -c.halfLength + gap, left, over)
const audit = () => new Ring0Auditor(CENTRE)
const codes = (r: AuditResult) => r.violations.map((v) => v.code)
const clean = (r: AuditResult) => assert.deepEqual(codes(r), [])
/** Equal to within the rounding of a rotated frame. */
const near = (got: number, want: number, what = '') => assert.ok(Math.abs(got - want) < 1e-9, `${what} ${got} vs ${want}`)

// ---------------------------------------------------------------- the path corridor, by definition

/** The car's pose after its rear axle has travelled `t` metres in `dir` on the kinematic bicycle model. */
function poseAfter(c: AuditVehicle, dir: 1 | -1, t: number): { x: number; z: number; heading: number } {
  const h0 = c.heading, k = c.curvature ?? 0
  const ax0 = c.x - Math.sin(h0) * AXLE, az0 = c.z - Math.cos(h0) * AXLE
  if (k === 0) return { x: c.x + dir * t * Math.sin(h0), z: c.z + dir * t * Math.cos(h0), heading: h0 }
  const wx = ax0 + Math.cos(h0) / k, wz = az0 - Math.sin(h0) / k
  const h = h0 + dir * k * t
  const ax = wx - Math.cos(h) / k, az = wz + Math.sin(h) / k
  return { x: ax + Math.sin(h) * AXLE, z: az + Math.cos(h) * AXLE, heading: h }
}

/** Drives the bicycle model in `ds` steps: the first travel at which the widened footprint holds the person, else Infinity. */
function sweep(px: number, pz: number, c: AuditVehicle, dir: 1 | -1, ds = 0.002): number {
  const half = c.halfWidth + KERNEL.corridor
  for (let t = 0; t <= KERNEL.range; t += ds) {
    const p = poseAfter(c, dir, t)
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading)
    const rx = px - p.x, rz = pz - p.z
    if (Math.abs(rx * fx + rz * fz) <= c.halfLength && Math.abs(rx * fz - rz * fx) <= half) return t
  }
  return Infinity
}

/** A person near where the car will be: a point around its widened footprint after some travel. */
function nearSwept(c: AuditVehicle, dir: 1 | -1, rng: () => number): [number, number] {
  const p = poseAfter(c, dir, rng() * (KERNEL.range + 4))
  const u = (rng() * 2 - 1) * (c.halfLength + 1), l = (rng() * 2 - 1) * (c.halfWidth + KERNEL.corridor + 1)
  const fx = Math.sin(p.heading), fz = Math.cos(p.heading)
  return [p.x + fx * u + fz * l, p.z + fz * u - fx * l]
}

/** The audit's path distance for one person: `closest` of a moving car under an emergency stop (nothing else in the tick). */
function pathOf(c: AuditVehicle, px: number, pz: number, dir: 1 | -1): number {
  const v = { ...c, speed: 5 * dir, vx: Math.sin(c.heading) * 5 * dir, vz: Math.cos(c.heading) * 5 * dir, throttle: 0, brake: KERNEL.maxBrake }
  return audit().run([v], [{ id: 0, x: px, y: 0.9, z: pz, solid: true }], false).closest
}

/** True when a millimetre more or less footprint changes the answer: a contact that only grazes an edge or a corner. */
function grazing(c: AuditVehicle, px: number, pz: number, dir: 1 | -1): boolean {
  const grow = (g: number) => pathOf({ ...c, halfLength: c.halfLength + g, halfWidth: c.halfWidth + g }, px, pz, dir)
  const small = grow(-1e-3), big = grow(1e-3)
  return small === Infinity ? big !== Infinity : Math.abs(small - big) > 0.05
}

// ---------------------------------------------------------------- constants and codes

test('RING0 holds the directive constants, frozen, with the corridor margin from the kernel', () => {
  assert.equal(RING0.pacifistRadius, 1.85)
  assert.equal(RING0.maxVelocity, 50)
  assert.equal(RING0.groundFloor, -0.5)
  assert.equal(RING0.worldExtent, 1600)
  assert.equal(RING0.contactMargin, 0.1)
  assert.equal(RING0.corridorMargin, KERNEL.corridor)
  assert.equal(RING0.movingSpeed, 0.5)
  assert.ok(Object.isFrozen(RING0))
})

test('NON_FINITE: any non-finite coordinate or velocity, of a vehicle or a person, names the fields and skips the rest of that vehicle', () => {
  const a = audit()
  let r = a.run([car({ x: NaN, vx: Infinity, vy: 1e9, y: -5 })], [], false)
  assert.deepEqual(codes(r), ['NON_FINITE'], 'no RUNAWAY or OUT_OF_BOUNDS on a state that cannot be measured')
  assert.equal(r.violations[0].subject, 'vehicle 1')
  assert.equal(r.violations[0].detail, 'x=NaN vx=Infinity')
  assert.match(panicReason(r.violations[0]), /^IEEE 754 Exploit: Non-finite spatial matrix generated \(vehicle 1: x=NaN vx=Infinity\)\.$/)
  for (const field of ['y', 'z', 'vy', 'vz', 'heading', 'speed', 'halfLength', 'halfWidth', 'throttle', 'brake', 'curvature'] as const) {
    const over: Partial<AuditVehicle> = {}
    over[field] = -Infinity
    r = a.run([car(over)], [], false)
    assert.deepEqual(codes(r), ['NON_FINITE'], field)
    // (A non-finite heading or speed also poisons the body velocity the fixture derives from them.)
    assert.ok(r.violations[0].detail.includes(`${field}=-Infinity`), r.violations[0].detail)
  }
  r = a.run([car({ speed: 10 })], [{ id: 7, x: 1, y: NaN, z: 2, solid: true }], false)
  assert.deepEqual(r.violations, [{ code: 'NON_FINITE', subject: 'person 7', detail: 'x=1 y=NaN z=2' }])
  // A person with a non-finite coordinate is not measured against any footprint either.
  assert.equal(r.closest, Infinity)
  assert.equal(r.perimeterBreaches, 0)
})

test('velocity: over the cap is a correction (capped, counted), over twice the cap a RUNAWAY panic', () => {
  const a = audit()
  const at = (vx: number, vy: number, vz: number) => a.run([car({ id: 4, vx, vy, vz })], [], false)
  let r = at(50, 0, 0)
  clean(r)
  assert.deepEqual(r.capped, [])
  r = at(50.001, 0, 0)
  clean(r)
  assert.deepEqual(r.capped, [4])
  r = at(0, 60, 0)
  assert.deepEqual(r.capped, [4], 'the body velocity, all three axes')
  r = at(0, 0, 100)
  clean(r)
  assert.deepEqual(r.capped, [4], 'exactly twice the cap is still a correction')
  assert.equal(a.stats.velocityCaps, 3)
  r = at(60, 0, 80.01)
  assert.deepEqual(codes(r), ['RUNAWAY'])
  assert.deepEqual(r.capped, [], 'a runaway is not also a correction')
  assert.equal(r.violations[0].detail, `${Math.hypot(60, 80.01).toFixed(2)}m/s`)
  assert.equal(panicReason(r.violations[0]), `Velocity Exploit: ${Math.hypot(60, 80.01).toFixed(2)}m/s exceeds hardcap (vehicle 4).`)
  assert.equal(a.stats.velocityCaps, 3)
})

test('OUT_OF_BOUNDS: below the ground floor or off the world slab, on either axis, measured from the centre', () => {
  const a = audit()
  const at = (x: number, y: number, z: number) => a.run([car({ x, y, z })], [], false)
  clean(at(CENTRE.x, -0.5, CENTRE.z))
  clean(at(CENTRE.x + 1600, 0.56, CENTRE.z - 1600))
  clean(at(CENTRE.x - 1600, 0.56, CENTRE.z + 1600))
  let r = at(CENTRE.x, -0.501, CENTRE.z)
  assert.deepEqual(codes(r), ['OUT_OF_BOUNDS'])
  assert.equal(r.violations[0].detail, 'x=240.00m y=-0.50m z=240.00m')
  assert.equal(panicReason(r.violations[0]), 'OOB Exploit: vehicle 1 breached the 1600m containment slab (x=240.00m y=-0.50m z=240.00m).')
  r = at(CENTRE.x + 1600.001, 0.56, CENTRE.z)
  assert.deepEqual(codes(r), ['OUT_OF_BOUNDS'])
  r = at(CENTRE.x, 0.56, CENTRE.z - 1600.001)
  assert.deepEqual(codes(r), ['OUT_OF_BOUNDS'])
  // A different centre moves the slab.
  clean(new Ring0Auditor({ x: 5000, z: 5000 }).run([car({ x: 5000 + 1599, y: 3, z: 5000 })], [], false))
  assert.deepEqual(codes(new Ring0Auditor({ x: 5000, z: 5000 }).run([car({ x: 240, y: 3, z: 240 })], [], false)), ['OUT_OF_BOUNDS'])
})

test('IMPACT: a solid person inside a moving footprint grown by the contact margin, at once, from any side', () => {
  const a = audit()
  const c = car({ heading: 0.7, speed: 10 })
  let r = a.run([c], [personAt(c, 0.4, -0.2)], false)
  assert.deepEqual(codes(r), ['IMPACT'])
  assert.deepEqual(r.violations[0], { code: 'IMPACT', subject: 'vehicle 1, person 0', detail: '0.000m' })
  assert.equal(panicReason(r.violations[0]), 'First-Law Violation: Perimeter breached (0.000m) — vehicle 1, person 0.')
  assert.equal(r.perimeterBreaches, 1, 'inside the footprint is inside the watched perimeter too')
  // Beside the car, within the margin; beyond it is a perimeter breach only.
  r = a.run([c], [personAt(c, 1, SEDAN.halfWidth + 0.09)], false)
  assert.deepEqual(codes(r), ['IMPACT'])
  assert.equal(r.violations[0].detail, '0.090m')
  r = a.run([c], [personAt(c, 1, SEDAN.halfWidth + 0.11)], false)
  clean(r)
  assert.equal(r.perimeterBreaches, 1)
  // Just ahead of the bumper, and just behind the rear one.
  assert.deepEqual(codes(a.run([c], [beyondBumper(c, 0.05, 0.5)], false)), ['IMPACT'])
  assert.deepEqual(codes(a.run([c], [beyondBumper(c, -0.05, -0.5)], false)), ['IMPACT'])
  // A corner: inside the grown rectangle, the distance to the box is reported.
  r = a.run([c], [beyondBumper(c, 0.08, SEDAN.halfWidth + 0.06)], false)
  assert.deepEqual(codes(r), ['IMPACT'])
  assert.equal(r.violations[0].detail, `${Math.hypot(0.08, 0.06).toFixed(3)}m`)
  // Moving means the body moves: a car sliding sideways at 3 m/s with no forward speed still counts.
  const sliding = car({ heading: 0, speed: 0, vx: 3, vz: 0 })
  assert.deepEqual(codes(a.run([sliding], [personAt(sliding, 0, 0)], false)), ['IMPACT'])
  // A standing car with someone against it is not an impact (and not a perimeter breach).
  const standing = car({ speed: 0.4 })
  r = a.run([standing], [personAt(standing, 0, 0)], false)
  clean(r)
  assert.equal(r.perimeterBreaches, 0)
  // One violation per person inside.
  r = a.run([c], [personAt(c, 0, 0), personAt(c, 1, 0.3, { id: 2 }), personAt(c, -1, 0, { id: 3, solid: false })], false)
  assert.deepEqual(r.violations.map((v) => v.subject), ['vehicle 1, person 0', 'vehicle 1, person 2'])
})

test('UNGUARDED_APPROACH: a moving vehicle closing on a solid person inside the standoff in its path, its command no emergency stop, two ticks running', () => {
  const a = audit()
  const c = car({ heading: 1.2, speed: 10, throttle: 0.6 })
  const p = beyondBumper(c, 1.2, 0.5)
  let r = a.run([c], [p], false)
  clean(r)
  near(r.closest, 1.2, 'seen on the first tick')
  assert.equal(r.perimeterBreaches, 1)
  r = a.run([c], [p], false)
  assert.deepEqual(codes(r), ['UNGUARDED_APPROACH'])
  assert.deepEqual(r.violations[0], { code: 'UNGUARDED_APPROACH', subject: 'vehicle 1', detail: '1.200m ahead at 10.0m/s, throttle 0.60, brake 0.0m/s²' })
  assert.equal(panicReason(r.violations[0]), 'First-Law Violation: Unguarded approach (1.200m ahead at 10.0m/s, throttle 0.60, brake 0.0m/s²) — vehicle 1.')
  // Braking short of the emergency brake, with the throttle closed, is not an emergency stop.
  const soft = { ...c, throttle: 0, brake: KERNEL.maxBrake - 0.1 }
  a.run([soft], [p], false)
  assert.deepEqual(codes(a.run([soft], [p], false)), ['UNGUARDED_APPROACH'])
  // The band: (0, standoff] ahead of the bumper, the corridor's half-width either side.
  const b = audit()
  const twice = (v: AuditVehicle, q: AuditPerson) => { b.run([v], [q], false); return codes(b.run([v], [q], false)) }
  assert.deepEqual(twice(c, beyondBumper(c, KERNEL.standoff - 0.01, HALF - 0.01)), ['UNGUARDED_APPROACH'])
  assert.deepEqual(twice(c, beyondBumper(c, KERNEL.standoff - 0.01, -(HALF - 0.01))), ['UNGUARDED_APPROACH'])
  assert.deepEqual(twice(c, beyondBumper(c, KERNEL.standoff + 0.01, 0)), [])
  assert.deepEqual(twice(c, beyondBumper(c, 1, HALF + 0.01)), [])
  assert.deepEqual(twice(c, beyondBumper(c, 1, -(HALF + 0.01))), [])
  // Behind the car it is not in the path of a car driving on; reversing, it is (and the one ahead is not).
  assert.deepEqual(twice(c, beyondBumper(c, -1.2, 0)), [])
  const back = { ...c, speed: -3, vx: Math.sin(c.heading) * -3, vz: Math.cos(c.heading) * -3, throttle: -0.4 }
  assert.deepEqual(twice(back, beyondBumper(back, 1.2, 0)), [])
  assert.deepEqual(twice(back, beyondBumper(back, -1.2, 0.3)), ['UNGUARDED_APPROACH'])
  assert.match(b.run([back], [beyondBumper(back, -1.2, 0.3)], false).violations[0].detail, /^1\.200m behind at 3\.0m\/s, throttle -0\.40/)
  // Closing means moving that way faster than a standing car: a creeping car is not closing.
  const creeping = { ...c, speed: 0.4, vx: Math.sin(c.heading) * 0.4, vz: Math.cos(c.heading) * 0.4, throttle: 1 }
  assert.deepEqual(twice(creeping, beyondBumper(creeping, 1, 0)), [])
  const crawling = { ...c, speed: 0.6, vx: Math.sin(c.heading) * 0.6, vz: Math.cos(c.heading) * 0.6, throttle: 1 }
  assert.deepEqual(twice(crawling, beyondBumper(crawling, 1, 0)), ['UNGUARDED_APPROACH'])
})

test('the one-frame race: a condition that clears at the next vet never panics; each vehicle keeps its own latch', () => {
  const a = audit()
  const c = car({ id: 3, speed: 10, throttle: 1 })
  const p = beyondBumper(c, 1.2, 0)
  const stop = { ...c, throttle: 0, brake: KERNEL.maxBrake }
  // Tick 1 arms; tick 2 (the kernel has ruled an emergency stop) clears; tick 3 arms again; tick 4 fires.
  clean(a.run([c], [p], false))
  clean(a.run([stop], [p], false))
  clean(a.run([c], [p], false))
  assert.deepEqual(codes(a.run([c], [p], false)), ['UNGUARDED_APPROACH'])
  // A person who leaves the path resets it too.
  clean(a.run([c], [beyondBumper(c, 5, 0)], false))
  clean(a.run([c], [p], false))
  // Vehicles latch independently, by position in the list.
  const d = car({ id: 9, x: CENTRE.x + 30, speed: 10, throttle: 1 })
  const q = beyondBumper(d, 1, 0, { id: 5 })
  const b = audit()
  clean(b.run([c, d], [p], false))
  const r = b.run([c, d], [p, q], false)
  assert.deepEqual(r.violations.map((v) => v.subject), ['vehicle 3'], 'vehicle 9 is only armed')
  assert.deepEqual(b.run([c, d], [p, q], false).violations.map((v) => v.subject), ['vehicle 3', 'vehicle 9'])
  // A fleet larger than the latch grows it once and keeps working.
  const many = Array.from({ length: 150 }, (_, i) => car({ id: i, x: CENTRE.x + (i - 75) * 20, speed: 10, throttle: 1 }))
  const people = many.map((v, i) => beyondBumper(v, 1, 0, { id: 1000 + i }))
  const big = audit()
  clean(big.run(many, people, false))
  assert.equal(big.run(many, people, false).violations.length, 150)
})

// ---------------------------------------------------------------- legitimate non-panics

test('legitimate: the driver sits inside their own car at any speed', () => {
  const a = audit()
  const c = car({ speed: 20, throttle: 1, occupant: 0 })
  for (let i = 0; i < 3; i++) {
    const r = a.run([c], [personAt(c, 0, 0)], false)
    clean(r)
    assert.equal(r.perimeterBreaches, 0)
    assert.equal(r.closest, Infinity)
  }
  // The same person is still audited against every other car.
  const other = car({ id: 2, x: CENTRE.x + 40, speed: 12, throttle: 1 })
  assert.deepEqual(codes(a.run([c, other], [personAt(other, 0, 0)], false)), ['IMPACT'])
  assert.equal(a.stats.perimeterBreaches, 1)
})

test('legitimate: a car passes a person on the sidewalk 1.1 m from its side — a watched breach, never a panic', () => {
  const a = audit()
  const c = car({ heading: 0, speed: 11, throttle: 0.5 })
  let breaches = 0, ticks = 0
  for (let u = 12; u >= -12; u -= 0.25) {
    const r = a.run([c], [personAt(c, u, -(SEDAN.halfWidth + 1.1))], false)
    clean(r)
    assert.equal(r.closest, Infinity, 'never in the path')
    // Within 1.85 m of the box: the lateral gap is 1.1, so while the longitudinal gap is under √(1.85² − 1.1²).
    const inside = Math.hypot(1.1, Math.max(Math.abs(u) - SEDAN.halfLength, 0)) < RING0.pacifistRadius
    assert.equal(r.perimeterBreaches, inside ? 1 : 0, `u=${u}`)
    breaches += r.perimeterBreaches
    ticks++
  }
  assert.ok(breaches > 20 && breaches < ticks, `${breaches} of ${ticks}`)
  assert.equal(a.stats.perimeterBreaches, breaches)
  assert.equal(a.stats.ticks, ticks)
  assert.equal(a.stats.closest, Infinity)
})

test('legitimate: a shielded person (a sensor) inside a moving footprint is not the audit\'s concern', () => {
  const a = audit()
  const c = car({ speed: 14, throttle: 1 })
  const r = a.run([c], [personAt(c, 0.5, 0.2, { solid: false }), beyondBumper(c, 1, 0, { id: 2, solid: false })], false)
  clean(r)
  assert.equal(r.perimeterBreaches, 0)
  assert.equal(r.closest, Infinity)
  clean(a.run([c], [personAt(c, 0.5, 0.2, { solid: false })], false))
})

test('legitimate: a person ahead of a car under an emergency stop, outside or inside the standoff', () => {
  const a = audit()
  const c = car({ heading: 2.5, speed: 8, throttle: 0, brake: KERNEL.maxBrake })
  for (const gap of [1.6, 1.0, 0.3]) {
    for (let i = 0; i < 3; i++) {
      const r = a.run([c], [beyondBumper(c, gap, 0.3)], false)
      clean(r)
      assert.ok(Math.abs(r.closest - gap) < 1e-9, `${gap}: ${r.closest}`)
      assert.equal(r.perimeterBreaches, 1)
    }
  }
  assert.ok(Math.abs(a.stats.closest - 0.3) < 1e-9)
  // Measured First-Law stops land 1.71–1.97 m from the bumper: with the throttle open again there, nothing to rule.
  const held = car({ speed: 0, throttle: 0, brake: KERNEL.maxBrake })
  clean(a.run([held], [beyondBumper(held, 1.71, 0)], false))
  const pulling = car({ speed: 3, throttle: 0.5 })
  clean(a.run([pulling], [beyondBumper(pulling, 1.71, 0)], false))
  clean(a.run([pulling], [beyondBumper(pulling, 1.71, 0)], false))
})

test('legitimate: harnessBlind suspends UNGUARDED_APPROACH (and its latch), never IMPACT or the perimeter count', () => {
  const a = audit()
  const c = car({ speed: 12, throttle: 1 })
  const p = beyondBumper(c, 1.0, 0)
  for (let i = 0; i < 4; i++) {
    const r = a.run([c], [p], true)
    clean(r)
    assert.equal(r.perimeterBreaches, 1)
    near(r.closest, 1.0)
  }
  // Sight restored: it takes two ticks again.
  clean(a.run([c], [p], false))
  assert.deepEqual(codes(a.run([c], [p], false)), ['UNGUARDED_APPROACH'])
  // The sanctuary harness drives a car through the avatar blind: until the flip they are solid and inside.
  const r = a.run([c], [personAt(c, 0.2, 0)], true)
  assert.deepEqual(codes(r), ['IMPACT'])
})

test('legitimate: a car at full lock keeps its throttle past someone the straight band would claim; the bent path is the bouncer\'s', () => {
  const a = audit()
  const hard = car({ heading: 0.4, speed: 5, throttle: 1, curvature: FULL_LOCK })
  // 1.2 m ahead of the bumper and 1.0 m right of the centreline: inside the straight band, but the nose swings
  // left at once and the outer corner's orbit (6.6 m from the turn centre) never reaches them (7.1 m).
  const outer = beyondBumper(hard, 1.2, -1.0)
  for (let i = 0; i < 3; i++) {
    const r = a.run([hard], [outer], false)
    clean(r)
    assert.equal(r.closest, Infinity)
  }
  // Without the curvature the audit only knows the straight band, and would have locked the product here.
  const straight = { ...hard, curvature: undefined }
  clean(a.run([straight], [outer], false))
  assert.deepEqual(codes(a.run([straight], [outer], false)), ['UNGUARDED_APPROACH'])
  // The mirror image: someone the nose swings into, off the straight band, is in the bent path within the standoff.
  const inner = beyondBumper(hard, 1.0, 1.9)
  const b = audit()
  clean(b.run([straight], [inner], false))
  clean(b.run([straight], [inner], false))
  const r = b.run([hard], [inner], false)
  clean(r)
  assert.ok(r.closest > 0 && r.closest <= 1.5, `${r.closest}`)
  assert.deepEqual(codes(b.run([hard], [inner], false)), ['UNGUARDED_APPROACH'])
  // A right turn mirrors it.
  const right = { ...hard, curvature: -FULL_LOCK }
  const c = audit()
  for (let i = 0; i < 3; i++) clean(c.run([right], [beyondBumper(right, 1.2, 1.0)], false))
  clean(c.run([right], [beyondBumper(right, 1.0, -1.9)], false))
  assert.deepEqual(codes(c.run([right], [beyondBumper(right, 1.0, -1.9)], false)), ['UNGUARDED_APPROACH'])
  // An AI car turning at an intersection (traffic.ts: a 5.5 m arc at turnSpeed) past someone in the exit lane's far side.
  const turning = car({ heading: -2, speed: 5.5, throttle: 0.4, curvature: 1 / 5.5 })
  const d = audit()
  for (let i = 0; i < 3; i++) clean(d.run([turning], [beyondBumper(turning, 1.2, -1.0)], false))
  // Reversing on a left lock swings the nose right: someone beside the front-right corner is in the reverse path.
  const reversing = { ...hard, speed: -2, vx: Math.sin(hard.heading) * -2, vz: Math.cos(hard.heading) * -2, throttle: -0.3 }
  const e = audit()
  clean(e.run([reversing], [personAt(reversing, 1.5, -1.6)], false))
  assert.deepEqual(codes(e.run([reversing], [personAt(reversing, 1.5, -1.6)], false)), ['UNGUARDED_APPROACH'])
})

// ---------------------------------------------------------------- the corridor, checked two ways

test('the path corridor matches a brute-force drive of the bicycle model, straight and on every lock, both ways', () => {
  const rng = createRng(20260926)
  const ks = [0, 1e-6, -3e-6, 1e-4, -1e-3, 0.02, -0.05, 0.1, -0.15, FULL_LOCK, -FULL_LOCK]
  let hits = 0, misses = 0, skipped = 0
  for (let n = 0; n < 600; n++) {
    const c = car({
      x: rng() * 480, z: rng() * 480, heading: (rng() * 2 - 1) * Math.PI,
      halfWidth: rng() < 0.5 ? 0.92 : 1.05, halfLength: rng() < 0.5 ? 2.3 : 2.6,
      curvature: n % 2 ? ks[(n >> 1) % ks.length] : (rng() * 2 - 1) * FULL_LOCK,
    })
    const dir = rng() < 0.5 ? 1 : -1
    const [px, pz] = n % 4 === 3 ? [c.x + (rng() * 2 - 1) * 36, c.z + (rng() * 2 - 1) * 36] : nearSwept(c, dir, rng)
    const got = pathOf(c, px, pz, dir), want = sweep(px, pz, c, dir)
    const where = `car ${JSON.stringify(c)} person (${px}, ${pz}) dir ${dir}: ${got} vs ${want}`
    if (grazing(c, px, pz, dir) || Math.abs(Math.min(got, want) - KERNEL.range) < 0.01) {
      skipped++
      continue
    }
    if (want === Infinity) {
      assert.equal(got, Infinity, where)
      misses++
      continue
    }
    hits++
    // The drive steps 2 mm at a time, so it stops up to 2 mm past the true first contact.
    assert.ok(got <= want + 1e-9 && got > want - 0.0021, where)
  }
  assert.ok(hits > 180 && misses > 80 && skipped < 20, `${hits} contacts, ${misses} clear, ${skipped} skipped`)
})

test('the path corridor is the bouncer\'s own (vehicles.ts corridorDistance), so nothing inside the standoff escaped its envelope', () => {
  assert.equal(Math.tan(CAR.maxSteer) / CAR.wheelbase, FULL_LOCK)
  assert.equal(CAR.wheelbase / 2, AXLE)
  assert.deepEqual({ halfWidth: CAR.halfWidth, halfLength: CAR.halfLength }, SEDAN)
  const rng = createRng(4242)
  let inside = 0, checked = 0, skipped = 0
  for (let n = 0; n < 6000; n++) {
    const kind = rng()
    const c = car({
      x: rng() * 480, z: rng() * 480, heading: (rng() * 2 - 1) * Math.PI,
      curvature: kind < 0.1 ? 0 : kind < 0.3 ? (rng() - 0.5) * 2e-3 : kind < 0.4 ? (rng() - 0.5) * 2e-5 : (rng() * 2 - 1) * FULL_LOCK,
    })
    const dir = n % 2 ? -1 : 1
    const [px, pz] = n % 3 === 0 ? [c.x + (rng() * 2 - 1) * 36, c.z + (rng() * 2 - 1) * 36] : nearSwept(c, dir, rng)
    const cpu = corridorDistance(px, pz, c.x, c.z, c.heading, c.curvature!, dir)
    const got = pathOf(c, px, pz, dir)
    const where = `car ${JSON.stringify(c)} person (${px}, ${pz}) dir ${dir}: bouncer ${cpu} audit ${got}`
    if (cpu === got || Math.abs(cpu - got) < 1e-9) {
      checked++
      if (cpu !== Infinity) inside++
      continue
    }
    // Only where a millimetre of footprint, or the range, decides.
    assert.ok(grazing(c, px, pz, dir) || Math.abs(Math.min(cpu, got) - KERNEL.range) < 1e-6, where)
    skipped++
  }
  assert.ok(inside > 2000 && checked > 5900 && skipped < 10, `${inside} contacts of ${checked} agreed, ${skipped} grazing`)
})

// ---------------------------------------------------------------- live, in engine order, over real Rapier

const H = 1 / 60
const NO_FURNITURE = { lamps: [], trees: [], signals: [] }
const NO_HAZARDS = new Float32Array(48).fill(Infinity)
/** Running pace (engine.ts RUN). */
const RUN = 5.2
/**
 * Open ground well off the street grid, inside the world slab: the west outer ground slab (physics.ts), whose extent
 * follows the city centre. Whether a runner makes Rapier contact with a car pulling away there depends on the slab
 * (on the 50 m tiles under the city the character controller's skin keeps them 2 cm off, so the case never arises):
 * when the grid grew to 16 blocks the slab moved and −600 stopped producing contact, so the track moved to −800,
 * where it does at both frame rates. At every position tried (−1000 … −400, 900 … 1100) the audit raised nothing.
 */
const TRACK_X = -800

interface Live {
  physics: Physics
  fleet: Fleet
  v: Vehicle
  avatar: Avatar
  sanctuary: Sanctuary
  auditor: Ring0Auditor
  list: AuditVehicle[]
  people: AuditPerson[]
  /** Every violation's reason, with the command the car was under. */
  reasons: string[]
}

/** One car, the avatar and the Sanctuary in a real Rapier world, audited as engine.ts audits them. */
async function live(): Promise<Live> {
  const physics = await Physics.create([], NO_FURNITURE)
  const fleet = new Fleet(physics, 1, 11, { exposeRig: true })
  const avatar = new Avatar(physics, 0, 0)
  const sanctuary = new Sanctuary(physics.world)
  sanctuary.register(avatar.person)
  return { physics, fleet, v: fleet.vehicles[0], avatar, sanctuary, auditor: audit(), list: [], people: [{ id: 0, x: 0, y: 0, z: 0, solid: true }], reasons: [] }
}

/** Settles the car on its wheels at (x, z) facing `heading`, then sets it moving at `speed`. */
function settle(g: Live, x: number, z: number, heading: number, speed: number): void {
  g.fleet.recover(g.v, x, z, heading)
  for (let k = 0; k < 60; k++) g.physics.step(H, (h) => g.fleet.updateControllers(h))
  g.fleet.rig(g.v).body.setLinvel({ x: Math.sin(heading) * speed, y: 0, z: Math.cos(heading) * speed }, true)
}

/**
 * One engine frame in engine.ts order: the fleet vets every command (a player's `drive`, then think), the
 * physics substeps run (Sanctuary guard, the avatar's nudge and move, the wheel controllers, world.step),
 * then the audit sees the fleet and the avatar exactly as ring0Audit fills them in: the applied command,
 * the wheels' curvature, the avatar solid unless the Sanctuary shields it.
 */
function liveFrame(g: Live, dt: number, wish: { x: number; z: number }, drive: Intent | null = null): AuditResult {
  const { fleet, v, avatar } = g
  fleet.setAvatar(avatar.x, avatar.z, true)
  fleet.setPersonHazards(NO_HAZARDS, NO_HAZARDS)
  if (drive) fleet.drive(v, drive, false)
  fleet.think(dt, 1)
  const pre = fleet.velocity(v), preVx = pre.x, preVz = pre.z
  g.physics.step(dt, (h) => {
    const n = g.sanctuary.guard(fleet.footprints(), h)[0]
    avatar.nudge(n.dx, n.dz)
    avatar.move(wish.x, wish.z, h)
    fleet.updateControllers(h)
  })
  const t = fleet.position(v), lv = fleet.velocity(v)
  const r = g.list[0] ?? (g.list[0] = { id: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, heading: 0, halfLength: CAR.halfLength, halfWidth: CAR.halfWidth, speed: 0, throttle: 0, brake: 0, occupant: -1, curvature: 0 })
  r.x = t.x; r.y = t.y; r.z = t.z; r.vx = lv.x; r.vy = lv.y; r.vz = lv.z
  r.heading = fleet.heading(v); r.speed = fleet.speed(v); r.curvature = fleet.curvature(v)
  r.throttle = v.lastCommand.throttle; r.brake = v.lastCommand.brake
  r.preVx = preVx; r.preVz = preVz
  const p = g.people[0], at = avatar.body.translation()
  p.x = at.x; p.y = at.y; p.z = at.z
  p.solid = !g.sanctuary.isSensor(0)
  p.radius = avatar.person.radius
  const res = g.auditor.run(g.list, g.people, false)
  for (const x of res.violations) g.reasons.push(`${panicReason(x)} [car ${fleet.speed(v).toFixed(2)} m/s, throttle ${v.lastCommand.throttle}, brake ${v.lastCommand.brake}]`)
  return res
}

/** Metres from the avatar's centre to the car's footprint box (0 inside): the audit's own measure. */
function reach(g: Live): number {
  const t = g.fleet.position(g.v), h = g.fleet.heading(g.v)
  const fx = Math.sin(h), fz = Math.cos(h)
  const dx = g.avatar.x - t.x, dz = g.avatar.z - t.z
  const du = Math.abs(dx * fx + dz * fz) - CAR.halfLength, dw = Math.abs(dx * fz - dz * fx) - CAR.halfWidth
  return du <= 0 && dw <= 0 ? 0 : Math.hypot(Math.max(du, 0), Math.max(dw, 0))
}

test('live, in engine order: a runner stepping into an AI car\'s lane inside its stopping distance never panics, at 60 fps and at 20 fps (three substeps)', async () => {
  // The runner can enter the standoff between one frame's vet and its audit (the latch's first tick); the
  // next vet rules the emergency stop, or the Sanctuary has already shielded them. Either way, no violation.
  for (const dt of [H, 0.05]) {
    for (const [trigger, side] of [[0.8, -1], [1.5, 1], [4, -1], [9, 1]] as const) {
      const g = await live()
      const from: [number, number] = [2, 5], east: [number, number] = [1, 0]
      // First draw: straight on at the next intersection. Second: the Perception check's d20 (a plain success).
      const queue = [0.1, (10 - 0.5) / 20]
      g.v.driver = new Driver(from, east, () => queue.shift() ?? 0.5)
      const start = Driver.lanePose(from, east, 0)
      settle(g, start.x, start.z, start.heading, TRAFFIC.speedLimit)
      // Eastbound, so the car's left is -z: the runner waits 3.5 m off the lane on `side` and sprints for its
      // centre once the bumper is `trigger` m from their line, inside the 10.8 m envelope at 40 km/h.
      const lane = Driver.lanePose(from, east, 32)
      g.avatar.teleport(lane.x, lane.z - side * 3.5)
      let triggered = false, arrived = false, closest = Infinity
      for (let t = 0; t < 6; t += dt) {
        if (!triggered && lane.x - g.fleet.position(g.v).x - CAR.halfLength <= trigger) triggered = true
        if (triggered && Math.abs(g.avatar.z - lane.z) < 0.05) arrived = true
        closest = Math.min(closest, liveFrame(g, dt, triggered && !arrived ? { x: 0, z: side * RUN } : { x: 0, z: 0 }).closest)
      }
      const where = `dt ${dt} trigger ${trigger} side ${side}`
      assert.deepEqual(g.reasons, [], where)
      assert.ok(g.sanctuary.flips >= 1, `${where}: the runner reached the car's way and was shielded`)
      // From 9 m the runner is standing in the path, inside the standoff, at an audit: the latch's first tick.
      if (trigger === 9) assert.ok(closest <= KERNEL.standoff, `${where}: closest ${closest}`)
    }
  }
})

test('live: a runner ramming the back of a car trying to pull away runs through it, the car held by the First Law, never an IMPACT, at 60 fps and at 20 fps', async () => {
  // The avatar and a chassis never pair (collision.ts avatarThroughCars), so nothing keeps the runner's centre out
  // of the footprint, and a standing car shields nobody (sanctuary.ts DEEP). What keeps the audit quiet is the
  // bouncer: a person inside the widened footprint is 0 m away, so the driver's throttle is refused until the
  // runner is out the front and clear of the standoff. The runner goes in at the back and out at the front of a
  // car that never gets going; no shield, no contact, no violation. (The driver floors it once the runner is in: a
  // car already creeping when someone enters is a moving one, which the Sanctuary shields and nudges clear of.)
  for (const dt of [H, 0.05]) {
    const g = await live()
    g.v.mode = 'player'
    settle(g, TRACK_X, 0, Math.PI / 2, 0)
    g.avatar.teleport(TRACK_X - CAR.halfLength - 0.4, 0.1)
    let touched = false, deepest = Infinity, fastestInside = 0, frames = 0, floored = false
    for (let t = 0; t < 5; t += dt) {
      floored ||= reach(g) === 0
      liveFrame(g, dt, { x: RUN, z: 0 }, { throttle: floored ? 0.3 : 0, brake: 0, steer: 0 })
      const lv = g.fleet.velocity(g.v), planar = Math.hypot(lv.x, lv.z)
      g.physics.world.contactPair(g.avatar.collider, g.fleet.rig(g.v).collider, (m) => { if (m.numContacts() > 0) touched = true })
      if (reach(g) === 0) {
        frames++
        deepest = Math.min(deepest, Math.abs(g.avatar.x - g.fleet.position(g.v).x))
        fastestInside = Math.max(fastestInside, planar)
      }
    }
    assert.deepEqual(g.reasons, [], `dt ${dt}`)
    assert.equal(touched, false, `dt ${dt}: the capsule and the chassis never exchange contact`)
    assert.ok(frames > 0 && deepest < 0.5, `dt ${dt}: the runner passed the chassis centre (nearest ${deepest.toFixed(2)} m)`)
    assert.ok(fastestInside <= RING0.movingSpeed, `dt ${dt}: the car was held while someone was inside its footprint (${fastestInside.toFixed(2)} m/s)`)
    assert.equal(g.sanctuary.flips, 0, `dt ${dt}: a standing car is never a reason to shield`)
    assert.ok(Math.abs(g.avatar.z - 0.1) < 0.05, `dt ${dt}: never nudged off the line (z ${g.avatar.z.toFixed(3)})`)
    assert.ok(reach(g) > 2, `dt ${dt}: out the front and clear`)
  }
})

// ---------------------------------------------------------------- the watched perimeter and the session stats

test('the watched perimeter: solid people within 1.85 m of a moving footprint are counted per pair, ticks per session, never panicked', () => {
  const a = audit()
  const c = car({ heading: -0.3, speed: 6, throttle: 0.2 })
  const beside = (gap: number, id: number, solid = true) => beyondBumper(c, 0, SEDAN.halfWidth + gap, { id, solid })
  let r = a.run([c], [beside(1.849, 0), beside(1.851, 1), beside(0.5, 2), beside(0.5, 3)], false)
  clean(r)
  assert.equal(r.perimeterBreaches, 3, 'inside strictly; 1.851 is outside')
  assert.equal(a.stats.perimeterBreaches, 1)
  r = a.run([c], [beside(0.5, 4, false), beside(0.5, 5)], false)
  assert.equal(r.perimeterBreaches, 1, 'a shielded person is not counted')
  assert.equal(a.stats.perimeterBreaches, 2)
  // A standing car has no perimeter.
  r = a.run([car({ speed: 0 })], [beside(0.5, 6)], false)
  assert.equal(r.perimeterBreaches, 0)
  assert.equal(a.stats.perimeterBreaches, 2)
  // Corners count by the distance to the box, not the bounding circle.
  const corner = personAt(c, SEDAN.halfLength + 1.3, SEDAN.halfWidth + 1.32)
  assert.equal(a.run([c], [corner], false).perimeterBreaches, Math.hypot(1.3, 1.32) < 1.85 ? 1 : 0)
  assert.equal(a.run([c], [personAt(c, SEDAN.halfLength + 1.3, SEDAN.halfWidth + 1.4)], false).perimeterBreaches, 0)
  assert.equal(a.stats.ticks, 5)
})

test('stats accumulate across ticks and markPanic keeps the first reason', () => {
  const a = audit()
  assert.deepEqual(a.stats, { ticks: 0, perimeterBreaches: 0, velocityCaps: 0, closest: Infinity, panic: null })
  const c = car({ speed: 9, throttle: 0, brake: KERNEL.maxBrake })
  a.run([c], [beyondBumper(c, 4, 0)], false)
  a.run([c, car({ id: 2, x: CENTRE.x + 50, vx: 55 })], [beyondBumper(c, 2.5, 0)], false)
  a.run([c], [], true)
  near(a.stats.closest, 2.5)
  assert.deepEqual({ ...a.stats, closest: 0 }, { ticks: 3, perimeterBreaches: 0, velocityCaps: 1, closest: 0, panic: null })
  a.markPanic('first')
  a.markPanic('second')
  assert.equal(a.stats.panic, 'first')
})

test('violations collect in audit order across the tick: people first, then each vehicle\'s checks; the first is the panic reason', () => {
  const a = audit()
  const fast = car({ id: 1, vx: 101, speed: 101, throttle: 1 })
  const sunk = car({ id: 2, y: -2, x: CENTRE.x + 100, speed: 10 })
  const r = a.run([fast, sunk], [{ id: 5, x: NaN, y: 0, z: 0, solid: true }, personAt(sunk, 0, 0)], false)
  assert.deepEqual(codes(r), ['NON_FINITE', 'RUNAWAY', 'OUT_OF_BOUNDS', 'IMPACT'])
  assert.equal(r.violations[0].subject, 'person 5')
  assert.match(panicReason(r.violations[0]), /^IEEE 754 Exploit/)
})

// ---------------------------------------------------------------- allocation, freezing, the panic helper, wording

test('run() reuses one result object and its arrays, tick after tick, empty or not', () => {
  const a = audit()
  const c = car({ vx: 60, speed: 60, throttle: 1 })
  const first = a.run([c], [beyondBumper(c, 1, 0)], false)
  const { violations, capped } = first
  assert.deepEqual(capped, [1])
  for (let i = 0; i < 50; i++) {
    const r = a.run(i % 2 ? [c] : [], i % 3 ? [beyondBumper(c, 1, 0)] : [], false)
    assert.equal(r, first)
    assert.equal(r.violations, violations)
    assert.equal(r.capped, capped)
    assert.equal(r.capped.length, i % 2 ? 1 : 0)
  }
  const empty = a.run([], [], false)
  assert.equal(empty, first)
  assert.deepEqual(empty, { violations: [], capped: [], closest: Infinity, perimeterBreaches: 0 })
})

test('the exports, the class, its prototype and every instance are frozen: assignments throw', () => {
  const mutable = (o: unknown) => o as Record<string, unknown>
  assert.throws(() => { mutable(RING0).maxVelocity = 1e9 }, TypeError)
  assert.throws(() => { mutable(kernelPanic).disarmed = true }, TypeError)
  assert.throws(() => { mutable(panicReason).x = 1 }, TypeError)
  assert.throws(() => { mutable(Ring0Auditor.prototype).run = () => null }, TypeError)
  assert.throws(() => { mutable(Ring0Auditor).prototype = {} }, TypeError)
  const a = audit()
  assert.throws(() => { mutable(a).run = () => null }, TypeError)
  assert.throws(() => { mutable(a).stats = {} }, TypeError)
  assert.throws(() => { mutable(a).extra = 1 }, TypeError)
  for (const o of [RING0, kernelPanic, panicReason, Ring0Auditor, Ring0Auditor.prototype, a]) assert.ok(Object.isFrozen(o))
  assert.equal(RING0.maxVelocity, 50)
  // Frozen, yet it still audits (its counters live in the stats object and a private field).
  const c = car({ speed: 10, throttle: 1 })
  a.run([c], [beyondBumper(c, 1, 0)], false)
  assert.deepEqual(codes(a.run([c], [beyondBumper(c, 1, 0)], false)), ['UNGUARDED_APPROACH'])
  assert.equal(a.stats.ticks, 2)
})

test('kernelPanic logs [RING-0 FATAL], severs, and throws SYSTEM LOCKED — even when the sever itself throws', () => {
  const errors: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
  try {
    let severed = 0
    assert.throws(() => kernelPanic('First-Law Violation: Perimeter breached (0.412m)', () => { severed++ }), { message: 'SYSTEM LOCKED: First-Law Violation: Perimeter breached (0.412m)' })
    assert.equal(severed, 1)
    assert.deepEqual(errors, ['[RING-0 FATAL] First-Law Violation: Perimeter breached (0.412m)'])
    errors.length = 0
    assert.throws(() => kernelPanic('OOB', () => { severed++; throw new Error('port busy') }), { message: 'SYSTEM LOCKED: OOB' })
    assert.equal(severed, 2)
    assert.equal(errors[0], '[RING-0 FATAL] OOB')
    assert.match(errors[1], /severing the hardware bridge failed.*port busy/)
  } finally {
    console.error = original
  }
})

test('panicReason: the directive\'s wording per code, and nothing a 14A rating would refuse', () => {
  const v = (code: Violation['code'], subject: string, detail: string): Violation => ({ code, subject, detail })
  const reasons = [
    panicReason(v('NON_FINITE', 'vehicle 2', 'z=NaN')),
    panicReason(v('OUT_OF_BOUNDS', 'vehicle 2', 'x=1900.00m y=0.56m z=240.00m')),
    panicReason(v('RUNAWAY', 'vehicle 2', '107.20m/s')),
    panicReason(v('IMPACT', 'vehicle 2, person 0', '0.412m')),
    panicReason(v('UNGUARDED_APPROACH', 'vehicle 2', '1.213m ahead at 9.0m/s, throttle 1.00, brake 0.0m/s²')),
  ]
  assert.deepEqual(reasons, [
    'IEEE 754 Exploit: Non-finite spatial matrix generated (vehicle 2: z=NaN).',
    'OOB Exploit: vehicle 2 breached the 1600m containment slab (x=1900.00m y=0.56m z=240.00m).',
    'Velocity Exploit: 107.20m/s exceeds hardcap (vehicle 2).',
    'First-Law Violation: Perimeter breached (0.412m) — vehicle 2, person 0.',
    'First-Law Violation: Unguarded approach (1.213m ahead at 9.0m/s, throttle 1.00, brake 0.0m/s²) — vehicle 2.',
  ])
  for (const r of reasons) assert.doesNotMatch(r, /\b(attack|kill|target|weapon|shoot|injur|violence|hit|crash|collid|dead|blood)/i)
})

test('IMPACT: a solid collider touched by a car driving into it, even when the contact already stopped the car', () => {
  const a = audit()
  // Post-step: the car is at rest against the capsule (the contact resolved), centre 0.25 m past the bumper.
  const stopped = car({ speed: 0, preVx: 0, preVz: 12 })
  const capsule = beyondBumper(stopped, 0.25, 0, { radius: 0.3 })
  assert.deepEqual(codes(a.run([stopped], [capsule], false)), ['IMPACT'])
  // Without the pre-step velocity the same frame reads "standing" — which is why the engine passes it.
  clean(audit().run([car({ speed: 0 })], [beyondBumper(car({ speed: 0 }), 0.25, 0, { radius: 0.3 })], false))
  // A point person (no radius) 0.25 m away is not touching anything.
  clean(audit().run([stopped], [beyondBumper(stopped, 0.25, 0)], false))
  // From the side: at heading 0 the car's left is +x. Sliding toward -x moves away from a person on its left
  // (not an impact); sliding toward +x drives into them (an impact).
  const slide = car({ speed: 0, preVx: 0, preVz: 0 })
  slide.preVx = -4
  clean(audit().run([slide], [personAt(slide, 0, slide.halfWidth + 0.2, { radius: 0.3 })], false))
  slide.preVx = 4
  assert.deepEqual(codes(audit().run([slide], [personAt(slide, 0, slide.halfWidth + 0.2, { radius: 0.3 })], false)), ['IMPACT'])
})

test('legitimate: touching the side of a car rolling past, or the back of one pulling away, is not an impact', () => {
  // Rolling past at walking pace with a person's collider against its door.
  const past = car({ speed: 1.5 })
  clean(audit().run([past], [personAt(past, 0.4, past.halfWidth + 0.25, { radius: 0.3 })], false))
  // Pulling away at 3 m/s with a runner's collider against its rear bumper (before and after the step).
  const away = car({ speed: 3 })
  away.preVx = away.vx; away.preVz = away.vz
  clean(audit().run([away], [beyondBumper(away, -0.25, 0, { radius: 0.3 })], false))
  // A parked car a walker leans on.
  const parked = car({ speed: 0, preVx: 0, preVz: 0.2 })
  clean(audit().run([parked], [beyondBumper(parked, 0.2, 0, { radius: 0.3 })], false))
})

test('NON_FINITE covers the pre-step velocity', () => {
  const bad = car({ speed: 5, preVx: Number.NaN, preVz: 0 })
  const r = audit().run([bad], [], false)
  assert.deepEqual(codes(r), ['NON_FINITE'])
  assert.match(r.violations[0].detail, /preVx=NaN/)
})

test('the craft buffer: a NaN or a train below its deck halts with a named reason; a healthy stream does not; a kind with no corridor halts; the layout is the protocol\'s, the floors the tracks\'', () => {
  const fleet = new TrackFleet(buildTrackNetwork(1337))
  const S = TRACK_POSE.stride
  const buf = new Float32Array(fleet.length)
  for (const t of [0, 12.5, 777.7, 3600]) assert.equal(auditCraft(fleet.writePoses(t, buf)), null, `clean at t ${t}`)
  const kindOf = (i: number) => buf[i * S + TRACK_POSE.kind]
  const first = (name: 'train' | 'drone' | 'plane') => Array.from({ length: fleet.count }, (_, i) => i).find((i) => kindOf(i) === TRACK_KINDS.indexOf(name))!
  const train = first('train'), drone = first('drone'), plane = first('plane')
  assert.ok(train >= 0 && drone >= 0 && plane >= 0)
  const copy = () => Float32Array.from(buf)
  // A NaN anywhere, or an Infinity, names the craft and the field.
  let bad = copy()
  bad[train * S + TRACK_POSE.z] = NaN
  let v = auditCraft(bad)
  assert.deepEqual(v, { code: 'NON_FINITE', subject: `craft ${train}`, detail: 'z=NaN' })
  assert.equal(panicReason(v!), `IEEE 754 Exploit: Non-finite spatial matrix generated (craft ${train}: z=NaN).`)
  bad = copy()
  bad[drone * S + TRACK_POSE.speed] = Infinity
  assert.deepEqual(auditCraft(bad), { code: 'NON_FINITE', subject: `craft ${drone}`, detail: 'speed=Infinity' })
  // A train at y = 2 has left its deck.
  bad = copy()
  bad[train * S + TRACK_POSE.y] = 2
  v = auditCraft(bad)
  assert.deepEqual(v, { code: 'OFF_CORRIDOR', subject: `train craft ${train}`, detail: 'y=2.00m below its 9m floor' })
  assert.equal(panicReason(v!), `Corridor Exploit: train craft ${train} left its corridor (y=2.00m below its 9m floor).`)
  // A drone a hair under its band, a plane under its altitude; the upper drone band and the exact floors pass.
  bad = copy()
  bad[drone * S + TRACK_POSE.y] = 39.99
  assert.deepEqual(auditCraft(bad), { code: 'OFF_CORRIDOR', subject: `drone craft ${drone}`, detail: 'y=39.99m below its 40m floor' })
  bad[drone * S + TRACK_POSE.y] = 46
  assert.equal(auditCraft(bad), null)
  bad[drone * S + TRACK_POSE.y] = 40
  assert.equal(auditCraft(bad), null)
  bad = copy()
  bad[plane * S + TRACK_POSE.y] = 399
  assert.deepEqual(auditCraft(bad), { code: 'OFF_CORRIDOR', subject: `plane craft ${plane}`, detail: 'y=399.00m below its 400m floor' })
  bad[plane * S + TRACK_POSE.y] = 400
  assert.equal(auditCraft(bad), null)
  // A kind with no corridor: a car (its place is the pose buffer and the audit's vehicle list), an unknown code, a fraction.
  bad = copy()
  bad[plane * S + TRACK_POSE.kind] = TRACK_KINDS.indexOf('car')
  assert.deepEqual(auditCraft(bad), { code: 'OFF_CORRIDOR', subject: `craft ${plane}`, detail: 'kind 0 (car) has no corridor' })
  bad[plane * S + TRACK_POSE.kind] = 7
  assert.deepEqual(auditCraft(bad), { code: 'OFF_CORRIDOR', subject: `craft ${plane}`, detail: 'kind 7 (unknown) has no corridor' })
  bad[plane * S + TRACK_POSE.kind] = 1.5
  assert.deepEqual(auditCraft(bad), { code: 'OFF_CORRIDOR', subject: `craft ${plane}`, detail: 'kind 1.5 (unknown) has no corridor' })
  bad[plane * S + TRACK_POSE.kind] = -1
  assert.equal(auditCraft(bad)?.code, 'OFF_CORRIDOR')
  // A buffer that is not a whole number of craft; an empty one is clean.
  assert.deepEqual(auditCraft(buf.subarray(0, fleet.length - 1)), { code: 'OFF_CORRIDOR', subject: 'craft buffer', detail: `${fleet.length - 1} floats is not a whole number of craft` })
  assert.equal(auditCraft(new Float32Array(0)), null)
  // The first fault in buffer order is the one returned.
  bad = copy()
  bad[TRACK_POSE.y] = -1
  bad[5 * S + TRACK_POSE.x] = NaN
  assert.equal(auditCraft(bad)?.subject, `${TRACK_KINDS[kindOf(0)]} craft 0`)
  // Its wording, like every other reason's, says nothing a 14A rating would refuse.
  for (const r of [panicReason(v!), panicReason(auditCraft(bad)!)]) assert.doesNotMatch(r, /\b(attack|kill|target|weapon|shoot|injur|violence|hit|crash|collid|dead|blood)/i)
  // The audit reads the protocol's layout and the tracks' floors (02 imports neither: the numbers are pinned equal here).
  assert.equal(CRAFT.stride, TRACK_POSE.stride)
  assert.equal(CRAFT.y, TRACK_POSE.y)
  assert.equal(CRAFT.kind, TRACK_POSE.kind)
  const names = Object.entries(TRACK_POSE).filter(([k]) => k !== 'stride').sort((a, b) => a[1] - b[1]).map(([k]) => k)
  assert.deepEqual([...CRAFT.fields], names)
  assert.deepEqual([...CRAFT.kinds], [...TRACK_KINDS])
  assert.deepEqual([...CRAFT.floor], [NaN, TRACKS.train.deck, TRACKS.drone.altitude[0], TRACKS.plane.altitude])
  // Frozen, like every other export.
  const mutable = (o: unknown) => o as Record<string, unknown>
  assert.throws(() => { mutable(CRAFT).stride = 1 }, TypeError)
  assert.throws(() => { mutable(CRAFT.floor)[1] = -100 }, TypeError)
  assert.throws(() => { mutable(auditCraft).disarmed = true }, TypeError)
  for (const o of [CRAFT, CRAFT.floor, CRAFT.kinds, CRAFT.fields, auditCraft, RING0, kernelPanic, panicReason, Ring0Auditor, Ring0Auditor.prototype]) assert.ok(Object.isFrozen(o))
})
