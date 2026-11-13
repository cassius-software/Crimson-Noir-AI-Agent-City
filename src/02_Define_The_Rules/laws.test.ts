// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the Ring-0 bouncer's ranking: the First Law stop envelope forward and
 * in reverse, the player's instruction outranking self-preservation (Second Law), an AI driver protecting
 * its vehicle (Third Law), rising-edge counting per vehicle, and — over a grid of speeds, distances and
 * throttles — that no ruling ever lets a car nobody sits in throttle toward a person inside its stopping
 * envelope; and the one car ruled apart, the one a person is seated in (source 'seated'), which passes through
 * people and is ruled exactly by the Second and the Third Law's rules with the people left out, never anything else.
 * What breaks if it is removed? A kernel edit could let a car drive into a person unnoticed, or let the seated
 * driver's exception reach a car nobody sits in.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adjudicate, Bouncer, LAW_NAMES, LAWS, stoppingDistance, THREE_LAWS, ZEROTH_LAW, type Intent, type Situation } from './laws.ts'
import { KERNEL } from './civic.ts'

const CLEAR: Situation = { source: 'ai', speed: 0, personAhead: Infinity, personBehind: Infinity, obstacleAhead: Infinity }
const at = (s: Partial<Situation>): Situation => ({ ...CLEAR, ...s })
const go = (throttle: number, brake = 0, steer = 0): Intent => ({ throttle, brake, steer })
const envelope = (speed: number) => stoppingDistance(speed) + KERNEL.standoff

test('the three laws are ranked 1, 2, 3 with original wording', () => {
  assert.deepEqual(THREE_LAWS.map((l) => l.id), [1, 2, 3])
  for (const l of THREE_LAWS) assert.ok(l.title.length > 0 && l.text.length > 0)
})

test('the Zeroth Law stands above the three: LAWS is ranked 0 to 3, each named the way the kernel names it, and every entry is frozen', () => {
  assert.deepEqual(LAWS.map((l) => l.id), [0, 1, 2, 3])
  assert.equal(LAWS[0], ZEROTH_LAW)
  assert.deepEqual(LAWS.slice(1), [...THREE_LAWS], 'the three keep their wording and their places')
  assert.match(ZEROTH_LAW.text, /never harm the city/)
  assert.match(ZEROTH_LAW.text, /no lower law overrides this one/)
  assert.deepEqual(LAW_NAMES, { 0: 'Zeroth Law', 1: 'First Law', 2: 'Second Law', 3: 'Third Law' })
  for (const o of [LAWS, THREE_LAWS, ZEROTH_LAW, LAW_NAMES, ...LAWS]) assert.ok(Object.isFrozen(o))
})

test('stopping distance: sensing latency plus v²/2d, never negative', () => {
  assert.equal(stoppingDistance(0), 0)
  assert.equal(stoppingDistance(-8), 0)
  const v = 10
  assert.ok(Math.abs(stoppingDistance(v) - (v * KERNEL.sensingLatency + (v * v) / (2 * KERNEL.emergencyDecel))) < 1e-12)
  assert.ok(Math.abs(stoppingDistance(v, 5, 0) - 10) < 1e-12)
  // Monotonic in speed.
  for (let s = 0; s < 30; s += 0.5) assert.ok(stoppingDistance(s + 0.5) > stoppingDistance(s))
})

test('First Law, forward: a person inside the envelope stops the car, one just outside does not', () => {
  for (const speed of [2, 8, 14]) {
    const edge = envelope(speed)
    const inside = adjudicate(go(1), at({ speed, personAhead: edge - 0.01 }))
    assert.equal(inside.law, 1)
    assert.deepEqual(inside.command, { throttle: 0, brake: KERNEL.maxBrake, steer: 0 })
    assert.match(inside.reason, /First Law: person .* ahead/)
    const onEdge = adjudicate(go(1), at({ speed, personAhead: edge }))
    assert.equal(onEdge.law, 1, 'the envelope boundary itself is inside')
    const outside = adjudicate(go(1), at({ speed, personAhead: edge + 0.01 }))
    assert.equal(outside.law, 0)
    assert.deepEqual(outside.command, go(1))
  }
})

test('First Law, reverse: a person behind stops a reversing car; one ahead does not', () => {
  const speed = -4
  const behind = adjudicate(go(-1), at({ speed, personBehind: envelope(4) - 0.01 }))
  assert.equal(behind.law, 1)
  assert.equal(behind.command.throttle, 0)
  assert.equal(behind.command.brake, KERNEL.maxBrake)
  assert.match(behind.reason, /behind/)
  // Moving away from a person ahead is not a First Law matter.
  assert.equal(adjudicate(go(-1), at({ speed, personAhead: 0.5 })).law, 0)
  // Moving forward, a person behind is not in the direction of travel.
  assert.equal(adjudicate(go(1), at({ speed: 4, personBehind: 0.5 })).law, 0)
})

test('First Law at a standstill: pulling away toward a person inside the standoff is refused either way', () => {
  const near = KERNEL.standoff - 0.1
  assert.equal(adjudicate(go(0.3), at({ speed: 0, personAhead: near })).law, 1)
  assert.equal(adjudicate(go(-0.3), at({ speed: 0, personBehind: near })).law, 1)
  // Throttling away from the person is allowed.
  assert.equal(adjudicate(go(0.3), at({ speed: 0, personBehind: near })).law, 0)
  assert.equal(adjudicate(go(-0.3), at({ speed: 0, personAhead: near })).law, 0)
  // Standing still with no throttle needs no intervention.
  assert.equal(adjudicate(go(0, 2), at({ speed: 0, personAhead: near, personBehind: near })).law, 0)
})

test('First Law keeps the steering and outranks a person\'s instruction to a car nobody sits in', () => {
  const r = adjudicate(go(1, 0, 0.3), at({ source: 'player', speed: 10, personAhead: 3 }))
  assert.equal(r.law, 1)
  assert.deepEqual(r.command, { throttle: 0, brake: KERNEL.maxBrake, steer: 0.3 })
})

test('Second Law: a player instruction stands where the Third Law would have intervened', () => {
  const s = at({ source: 'player', speed: 10, obstacleAhead: 5 })
  const r = adjudicate(go(1, 0, 0.1), s)
  assert.equal(r.law, 2)
  assert.deepEqual(r.command, go(1, 0, 0.1), 'the instruction passes unchanged')
  assert.match(r.reason, /Second Law/)
  // No self-risk: nothing to rule on.
  assert.equal(adjudicate(go(1), at({ source: 'player', speed: 10 })).law, 0)
  // Braking toward an obstacle is not a risk to the vehicle.
  assert.equal(adjudicate(go(0, 6), s).law, 0)
})

test('Third Law: an AI driver does not throttle into an obstacle it cannot stop for', () => {
  // v²/2d to 1 m short of the obstacle: 100 / 18 ≈ 5.6 m/s², below the ceiling, so the formula itself shows.
  const speed = 10, obstacle = 10
  const r = adjudicate(go(1, 0, -0.2), at({ speed, obstacleAhead: obstacle }))
  assert.equal(r.law, 3)
  assert.equal(r.command.throttle, 0)
  assert.equal(r.command.steer, -0.2)
  const room = obstacle - 1
  assert.ok((speed * speed) / (2 * room) < KERNEL.maxBrake, 'setup: the case must not be clamped')
  assert.ok(Math.abs(r.command.brake - (speed * speed) / (2 * room)) < 1e-12)
  assert.match(r.reason, /Third Law: obstacle 10\.0 m ahead/)
  // The brake never drops below what the driver already asked for, and never exceeds the ceiling.
  assert.equal(adjudicate(go(1), at({ speed, obstacleAhead: 6 })).command.brake, KERNEL.maxBrake)
  assert.equal(adjudicate(go(1), at({ speed: 6, obstacleAhead: 2 })).command.brake, KERNEL.maxBrake)
  assert.equal(adjudicate(go(1, 5), at({ speed: 2, obstacleAhead: 1.5 })).command.brake, 5)
  // Beyond the self-preservation distance there is nothing to rule on.
  const far = stoppingDistance(speed, KERNEL.selfDecel) + 1 + 0.01
  assert.equal(adjudicate(go(1), at({ speed, obstacleAhead: far })).law, 0)
})

test('the ruling is pure: the same intent and situation always rule the same way', () => {
  const s = at({ source: 'player', speed: 7, personAhead: 6, obstacleAhead: 4 })
  assert.deepEqual(adjudicate(go(1), s), adjudicate(go(1), s))
})

test('Bouncer counts rising edges per law and per vehicle, not frames', () => {
  const b = new Bouncer()
  const person = at({ speed: 10, personAhead: 3 })
  const clear = at({ speed: 10 })
  const obstacle = at({ speed: 10, obstacleAhead: 5 })
  for (let i = 0; i < 30; i++) b.vet(1, go(1), person)
  assert.equal(b.counts[1], 1, 'staying under the First Law is one intervention')
  assert.ok(b.holding(1))
  assert.match(b.last, /First Law/)
  // A second vehicle has its own edges.
  b.vet(2, go(1), person)
  assert.equal(b.counts[1], 2)
  assert.ok(b.holding(2))
  // Released, then caught again: a new edge.
  b.vet(1, go(1), clear)
  assert.equal(b.holding(1), false)
  b.vet(1, go(1), person)
  assert.equal(b.counts[1], 3)
  // Switching laws is an edge for the new law.
  b.vet(1, go(1), obstacle)
  assert.equal(b.counts[3], 1)
  assert.equal(b.holding(1), false, 'holding() is only the First Law')
  assert.match(b.last, /Third Law/)
  b.vet(1, go(1), obstacle)
  assert.equal(b.counts[3], 1)
  // The player's overridden self-preservation is counted under the Second Law.
  b.vet(3, go(1), { ...obstacle, source: 'player' })
  b.vet(3, go(1), { ...obstacle, source: 'player' })
  assert.equal(b.counts[2], 1)
  assert.deepEqual(b.counts, { 1: 3, 2: 1, 3: 1 })
  // A clean ruling returns the intent untouched and leaves `last` alone.
  const last = b.last
  assert.deepEqual(b.vet(4, go(0.5, 0, 0.1), clear), go(0.5, 0, 0.1))
  assert.equal(b.last, last)
  assert.equal(b.holding(99), false, 'an unknown vehicle is not held')
})

test('property: no ruling for a car nobody sits in ever throttles toward a person inside the stopping envelope', () => {
  const STILL = 0.05
  // A 0.25 m/s grid plus both edges of the standstill band, where direction of travel is decided by the throttle.
  const speeds: number[] = [-STILL - 0.01, -STILL, -STILL + 0.01, STILL - 0.01, STILL, STILL + 0.01]
  for (let speed = -12; speed <= 20; speed += 0.25) speeds.push(speed)
  let checked = 0, stops = 0
  for (const source of ['ai', 'player'] as const) {
    for (const speed of speeds) {
      for (let d = 0; d <= 40; d += 0.25) {
        for (const throttle of [-1, -0.4, 0, 0.4, 1]) {
          for (const [personAhead, personBehind] of [[d, Infinity], [Infinity, d], [d, d]]) {
            for (const obstacleAhead of [Infinity, d]) {
              const s: Situation = { source, speed, personAhead, personBehind, obstacleAhead }
              const r = adjudicate(go(throttle, 0.5, 0.1), s)
              // Toward the person ahead: any forward throttle unless the car is already reversing away.
              if (speed >= -STILL && personAhead <= envelope(speed)) {
                assert.ok(r.command.throttle <= 0, `forward throttle ${r.command.throttle} at ${speed} m/s, person ${personAhead} m ahead (${source})`)
              }
              // Toward the person behind: any reverse throttle unless the car is already driving away.
              if (speed <= STILL && personBehind <= envelope(-speed)) {
                assert.ok(r.command.throttle >= 0, `reverse throttle ${r.command.throttle} at ${speed} m/s, person ${personBehind} m behind (${source})`)
              }
              // Moving toward a person inside the envelope always means a full First Law stop.
              if ((speed > STILL && personAhead <= envelope(speed)) || (speed < -STILL && personBehind <= envelope(-speed))) {
                assert.equal(r.law, 1)
                assert.equal(r.command.brake, KERNEL.maxBrake)
                stops++
              }
              checked++
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 100_000 && stops > 10_000, `grid too small: ${checked} rulings, ${stops} stops`)
})

test('property: a reckless full-throttle driver still stops short of a person sensed at or beyond the envelope', () => {
  const dt = 1 / 60
  for (const source of ['ai', 'player'] as const) {
    for (let v0 = 2; v0 <= 20; v0 += 1) {
      for (const extra of [0, 0.37, 3, 12]) {
        // Point-mass car (4 m/s² at full throttle; brakes deliver only the emergency deceleration), 60 Hz
        // frames, and a sensor that reports the gap one frame late.
        let speed = v0, gap = envelope(v0) + extra, sensed = gap
        for (let t = 0; t < 20 && speed > 0; t += dt) {
          const cmd = adjudicate(go(1), at({ source, speed, personAhead: sensed })).command
          const accel = cmd.throttle * 4 - Math.min(cmd.brake, KERNEL.emergencyDecel)
          sensed = gap
          const next = Math.max(0, speed + accel * dt)
          gap -= ((speed + next) / 2) * dt
          speed = next
        }
        assert.equal(speed, 0, `${source} at ${v0} m/s (+${extra} m) never stopped`)
        assert.ok(gap >= KERNEL.standoff, `${source} at ${v0} m/s (+${extra} m) stopped ${gap.toFixed(2)} m from the person`)
      }
    }
  }
})

test('the car a person is seated in is not held for people: their instruction stands, the Second Law still counted, the Third never', () => {
  // A person 1 m ahead at 10 m/s, and someone inside the footprint behind: an AI's car or a script's would stop.
  const s = at({ source: 'seated', speed: 10, personAhead: 1, personBehind: 0 })
  assert.equal(adjudicate(go(1, 0, 0.3), at({ ...s, source: 'player' })).law, 1, 'a script\'s car: the First Law')
  assert.equal(adjudicate(go(1, 0, 0.3), at({ ...s, source: 'ai' })).law, 1, 'an AI\'s car: the First Law')
  const r = adjudicate(go(1, 0, 0.3), s)
  assert.equal(r.law, 0)
  assert.deepEqual(r.command, go(1, 0, 0.3), 'the instruction passes unchanged')
  // Reverse into the person behind, and forward throttle while still rolling back toward the person ahead.
  assert.deepEqual(adjudicate(go(-1), at({ ...s, speed: -2 })).command, go(-1))
  assert.deepEqual(adjudicate(go(1), at({ ...s, speed: -2 })).command, go(1))
  // Readings that are not numbers fail toward nobody: the people are not read at all.
  assert.deepEqual(adjudicate(go(1), at({ ...s, personAhead: NaN, personBehind: NaN })).command, go(1))
  // A wall: the Second Law, as for any person's instruction; never the Third Law's brake.
  const wall = adjudicate(go(1, 0, 0.1), at({ ...s, obstacleAhead: 5 }))
  assert.equal(wall.law, 2)
  assert.deepEqual(wall.command, go(1, 0, 0.1))
  assert.match(wall.reason, /Second Law/)
  // The car's own speed must still be a number: one that is not stops it, as the First Law stops any car.
  for (const speed of [NaN, Infinity, -Infinity]) {
    const bad = adjudicate(go(1), at({ ...s, speed }))
    assert.equal(bad.law, 1, `speed ${speed}`)
    assert.deepEqual(bad.command, { throttle: 0, brake: KERNEL.maxBrake, steer: 0 })
  }
  // Only that exact word: anything else is the strictest reading (an AI's car).
  for (const source of ['Seated', 'seat', '', 'seated ', undefined] as unknown as Situation['source'][]) {
    assert.equal(adjudicate(go(1), at({ ...s, source })).law, 1, `source ${JSON.stringify(source)}`)
  }
})

test('property: the seated driver\'s ruling is the person-free ruling of a person\'s instruction, whatever the people', () => {
  let checked = 0
  for (let speed = -12; speed <= 20; speed += 0.5) {
    for (const d of [0, 0.5, 1.5, 4, 12, 40, Infinity, NaN]) {
      for (const throttle of [-1, -0.4, 0, 0.4, 1]) {
        for (const obstacleAhead of [Infinity, 30, 6, 1]) {
          const intent = go(throttle, 0.5, 0.1)
          const seated = adjudicate(intent, { source: 'seated', speed, personAhead: d, personBehind: d, obstacleAhead })
          const free = adjudicate(intent, { source: 'player', speed, personAhead: Infinity, personBehind: Infinity, obstacleAhead })
          assert.deepEqual(seated.command, free.command, `at ${speed} m/s, people ${d} m, obstacle ${obstacleAhead} m`)
          assert.equal(seated.law, free.law)
          assert.notEqual(seated.law, 1)
          assert.notEqual(seated.law, 3)
          checked++
        }
      }
    }
  }
  assert.ok(checked > 10_000, `${checked}`)
})

test('the Bouncer never holds the car a person is seated in, and lets go of a hold it carried from before they sat down', () => {
  const b = new Bouncer()
  const person = at({ speed: 10, personAhead: 3 })
  assert.deepEqual(b.vet(0, go(1), { ...person, source: 'player' }), { throttle: 0, brake: KERNEL.maxBrake, steer: 0 })
  assert.equal(b.holding(0), true)
  assert.equal(b.counts[1], 1)
  assert.deepEqual(b.vet(0, go(1), { ...person, source: 'seated' }), go(1))
  assert.equal(b.holding(0), false, 'seated: no longer held')
  for (let i = 0; i < 10; i++) b.vet(0, go(1), { ...person, personAhead: 0, source: 'seated' })
  assert.equal(b.counts[1], 1, 'no new First-Law ruling')
  assert.equal(b.holding(0), false)
  // The seat lapses: the very next vet of a car nobody sits in is held again.
  assert.deepEqual(b.vet(0, go(1), { ...person, source: 'player' }), { throttle: 0, brake: KERNEL.maxBrake, steer: 0 })
  assert.equal(b.counts[1], 2)
})

test('the First Law guards the direction the throttle points, even while the car still rolls the other way', () => {
  // Rolling backwards at 2 m/s, forward throttle, a person 1 m in front: the car must not head for them.
  const front = adjudicate(go(1), at({ source: 'player', speed: -2, personAhead: 1 }))
  assert.equal(front.law, 1)
  assert.equal(front.command.throttle, 0)
  // Rolling forwards, reverse throttle, a person 1 m behind.
  const back = adjudicate(go(-1), at({ source: 'player', speed: 2, personBehind: 1 }))
  assert.equal(back.law, 1)
  assert.equal(back.command.throttle, 0)
  // Nobody there: the instruction stands.
  assert.equal(adjudicate(go(1), at({ source: 'player', speed: -2 })).law, 0)
})
