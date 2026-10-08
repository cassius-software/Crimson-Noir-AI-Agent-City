// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the property-based fuzzing of the Ring-0 kernel's rules (Phase 13), seeded and
 * replayable (property.ts): the Three Laws' adjudication (laws.ts) is bounded (a command inside the bouncer's bounds
 * comes out inside them), puts the First Law first whoever drives (a person inside the stopping envelope, ahead or
 * behind, always gets a full stop with the steer kept), fails toward the person on a reading that is not a number,
 * leaves a person's instruction alone otherwise (the Second Law), is monotone (a person nearer never turns a stop
 * into a go) and pure; the Bouncer counts an intervention once per vehicle each time it enters it; and the Ring-0
 * auditor (ring0.ts) names every non-finite state, caps every car between the velocity cap and twice it, panics on
 * one beyond, contains every chassis to the slab and above the ground floor, finds an IMPACT for every solid person
 * inside a moving footprint and never for a sensor, and finds nothing in a clean tick.
 * What breaks if it is removed? A situation nobody tried could let a car drive on into a person, or an audit pass a
 * state it should have halted on.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { KERNEL } from './civic.ts'
import { adjudicate, Bouncer, stoppingDistance, type Intent, type Situation } from './laws.ts'
import { forAll, nastyNumber, type Gen } from './property.ts'
import { RING0, Ring0Auditor, type AuditVehicle } from './ring0.ts'

const MAX_STEER = 0.6
const intentOf = (g: Gen): Intent => ({ throttle: g.float(-1, 1), brake: g.bool(0.3) ? g.float(0, KERNEL.maxBrake) : 0, steer: g.float(-MAX_STEER, MAX_STEER) })
const distance = (g: Gen): number => (g.bool(0.3) ? Infinity : g.float(0, 60))
const situationOf = (g: Gen): Situation => ({
  source: g.bool() ? 'ai' : 'player', speed: g.float(-12, 50), personAhead: distance(g), personBehind: distance(g), obstacleAhead: distance(g),
})

test('the First Law first, for anyone at the wheel: a person in the envelope ahead or behind gets a full stop, the steer kept', () => {
  forAll('first law', { seed: 0x1a3, runs: 50_000 }, (g) => ({ intent: intentOf(g), s: situationOf(g) }), ({ intent, s }) => {
    const r = adjudicate(intent, s)
    const forward = s.speed > 0.05 || intent.throttle > 0
    const reverse = s.speed < -0.05 || intent.throttle < 0
    const ahead = forward && s.personAhead <= stoppingDistance(s.speed) + KERNEL.standoff
    const behind = reverse && s.personBehind <= stoppingDistance(-s.speed) + KERNEL.standoff
    if (ahead || behind) {
      assert.equal(r.law, 1)
      assert.deepEqual(r.command, { throttle: 0, brake: KERNEL.maxBrake, steer: intent.steer })
    } else {
      assert.notEqual(r.law, 1, 'never a stop without a person in the envelope')
    }
    // Bounded: a command inside the bouncer's bounds comes out inside them.
    assert.ok(Math.abs(r.command.throttle) <= 1 && r.command.brake >= 0 && r.command.brake <= KERNEL.maxBrake && Math.abs(r.command.steer) <= MAX_STEER)
    // The Second Law: a person's instruction is theirs unless the First Law spoke.
    if (s.source === 'player' && r.law !== 1) assert.deepEqual(r.command, intent)
    // The Third Law never opens the throttle.
    if (r.law === 3) assert.ok(r.command.throttle === 0 && r.command.brake >= intent.brake)
    // Pure.
    assert.deepEqual(adjudicate(intent, s), r)
  })
})

test('monotone: a person nearer never turns a stop into a go', () => {
  forAll('monotone', { seed: 0x2b4, runs: 20_000 }, (g) => ({ intent: intentOf(g), s: situationOf(g), nearer: g.float(0, 1) }), ({ intent, s, nearer }) => {
    const far = adjudicate(intent, s)
    if (far.law !== 1) return
    const ahead = adjudicate(intent, { ...s, personAhead: s.personAhead * nearer })
    const behind = adjudicate(intent, { ...s, personBehind: s.personBehind * nearer })
    assert.equal(ahead.law, 1)
    assert.equal(behind.law, 1)
  })
})

test('a reading that is not a number fails toward the person: the car under throttle stops', () => {
  forAll('nan', { seed: 0x3c5, runs: 20_000 }, (g) => {
    const s = situationOf(g)
    const field = g.pick(['speed', 'personAhead', 'personBehind'] as const)
    return { intent: { ...intentOf(g), throttle: field === 'personBehind' ? -g.float(0.01, 1) : g.float(0.01, 1) }, s: { ...s, [field]: Number.NaN }, field }
  }, ({ intent, s }) => {
    const r = adjudicate(intent, s)
    assert.equal(r.law, 1, `a NaN reading under throttle ${intent.throttle.toFixed(2)}`)
    assert.equal(r.command.throttle, 0)
  })
})

test('the Bouncer counts an intervention once per vehicle each time it enters it, never per frame it stays', () => {
  forAll('bouncer', { seed: 0x4d6, runs: 300 }, (g) => Array.from({ length: g.int(1, 200) }, () => ({ id: g.int(0, 4), intent: intentOf(g), s: situationOf(g) })), (frames) => {
    const b = new Bouncer()
    const last = new Map<number, number>()
    const want = { 1: 0, 2: 0, 3: 0 }
    for (const f of frames) {
      const law = adjudicate(f.intent, f.s).law
      b.vet(f.id, f.intent, f.s)
      if (law !== 0 && law !== (last.get(f.id) ?? 0)) want[law]++
      last.set(f.id, law)
    }
    assert.deepEqual({ ...b.counts }, want)
  })
})

// ---------------------------------------------------------------- the auditor

const C = { x: 320, z: 320 }
function vehicleOf(g: Gen, id: number): AuditVehicle {
  const heading = g.float(-Math.PI, Math.PI)
  const speed = g.pick([0, g.float(-10, 10), g.float(40, 49.9), g.float(50.1, 99.9), g.float(100.1, 200)])
  return {
    id, x: C.x + g.float(-1700, 1700), y: g.pick([0.56, g.float(-1, 2)]), z: C.z + g.float(-1700, 1700),
    vx: Math.sin(heading) * speed, vy: 0, vz: Math.cos(heading) * speed, heading, halfLength: 2.25, halfWidth: 0.95, speed,
    throttle: g.float(-1, 1), brake: g.float(0, 8), occupant: -1,
  }
}

test('the auditor names every non-finite state, caps every car between the cap and twice it, panics past that, and contains every chassis', () => {
  forAll('audit', { seed: 0x5e7, runs: 5000 }, (g) => {
    const vehicles = Array.from({ length: g.int(1, 8) }, (_, i) => vehicleOf(g, i))
    // Now and then a field that is not a number.
    for (const v of vehicles) if (g.bool(0.1)) (v as unknown as Record<string, number>)[g.pick(['x', 'y', 'z', 'vx', 'vy', 'vz', 'heading', 'speed'])] = nastyNumber(g, 1) * (g.bool() ? Number.NaN : Infinity)
    return vehicles
  }, (vehicles) => {
    const a = new Ring0Auditor(C)
    const r = a.run(vehicles, [], false)
    for (const v of vehicles) {
      const values = [v.x, v.y, v.z, v.vx, v.vy, v.vz, v.heading, v.speed]
      const named = (code: string) => r.violations.some((x) => x.code === code && x.subject === `vehicle ${v.id}`)
      if (!values.every(Number.isFinite)) {
        assert.ok(named('NON_FINITE'), `vehicle ${v.id} non-finite`)
        assert.ok(!r.capped.includes(v.id))
        continue
      }
      const body = Math.hypot(v.vx, v.vy, v.vz)
      assert.equal(r.capped.includes(v.id), body > RING0.maxVelocity && body <= 2 * RING0.maxVelocity, `capped at ${body}`)
      assert.equal(named('RUNAWAY'), body > 2 * RING0.maxVelocity, `runaway at ${body}`)
      const out = v.y < RING0.groundFloor || Math.abs(v.x - C.x) > RING0.worldExtent || Math.abs(v.z - C.z) > RING0.worldExtent
      assert.equal(named('OUT_OF_BOUNDS'), out)
    }
  })
})

test('an IMPACT for every solid person inside a moving footprint, never for a sensor; a clean tick finds nothing', () => {
  forAll('impact', { seed: 0x6f8, runs: 5000 }, (g) => {
    const v = { ...vehicleOf(g, 0), x: C.x + g.float(-500, 500), y: 0.56, z: C.z + g.float(-500, 500) }
    const speed = g.float(1, 40)
    v.vx = Math.sin(v.heading) * speed
    v.vz = Math.cos(v.heading) * speed
    v.speed = speed
    const u = g.float(-v.halfLength, v.halfLength), l = g.float(-v.halfWidth, v.halfWidth)
    const fx = Math.sin(v.heading), fz = Math.cos(v.heading)
    return { v, person: { id: 9, x: v.x + u * fx + l * fz, y: 0.95, z: v.z + u * fz - l * fx, solid: g.bool(0.7) } }
  }, ({ v, person }) => {
    const r = new Ring0Auditor(C).run([v], [person], false)
    assert.equal(r.violations.some((x) => x.code === 'IMPACT'), person.solid)
    // The same car alone, at rest, in bounds and finite: a clean tick.
    const clean = new Ring0Auditor(C).run([{ ...v, vx: 0, vz: 0, speed: 0 }], [], false)
    assert.deepEqual([clean.violations, clean.capped], [[], []])
  })
})
