// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the active ragdoll's balance machine and promotion pool without a physics
 * world: every transition of the table is reachable and none outside it ever happens, the machine is deterministic,
 * a vehicle (or any cause it does not know) can never push a person into a ragdoll, and the pool keeps its capacity,
 * radius and eviction rules (never taking a rig from someone mid-step or sitting down).
 * What breaks if it is removed? A machine that livelocks, a car that turns a person into a ragdoll instead of halting
 * the kernel, or a pool that grows past its rigs could land unnoticed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  CATCH_OFFSET, classifyPerturbation, GAINS, KINEMATIC, MAX_CATCH_STEPS, PERTURBATION_CAUSES, PERTURBED_MAX, physicalWeight,
  POOL_CAPACITY, PROMOTE_IMPULSE, PROMOTE_RADIUS, DEMOTE_RADIUS, RagdollPool, RISE_TIME, rigWanted, SEATED_HEIGHT, SEATED_TIME, SETTLE_BLEND,
  SETTLE_TIME, SIT_TILT, SIT_TIME_MAX, STEP_TIME, stepBalance, TRANSITIONS,
  type BalanceInputs, type BalanceMachine, type BalanceState, type Candidate, type Reading,
} from './ragdoll.ts'

const DT = 1 / 60
const STILL: BalanceInputs = { tilt: 0.01, tiltRate: 0.05, comOffset: 0.02, pelvisHeight: 0.95 }
const SHOVE = { cause: 'shove' as const, impulse: 60 }

/** Steps until the state changes (or `limit` s pass); returns the new machine. */
function until(m: BalanceMachine, inp: BalanceInputs, limit = 10): BalanceMachine {
  for (let t = 0; t < limit; t += DT) {
    const next = stepBalance(m, inp, DT)
    if (next.state !== m.state) return next
    m = next
  }
  return m
}

const pushed = (): BalanceMachine => stepBalance(KINEMATIC, { ...STILL, push: SHOVE }, DT)

test('every transition of the table is reachable, by the rule the header names', () => {
  const seen = new Set<string>()
  const note = (from: BalanceMachine, to: BalanceMachine) => seen.add(`${from.state}>${to.state}`)

  const p = pushed()
  assert.equal(p.state, 'perturbed')
  note(KINEMATIC, p)
  const settled = until(p, STILL)
  assert.equal(settled.state, 'recovering')
  assert.equal(settled.blend, SETTLE_BLEND)
  note(p, settled)
  const home = until(settled, STILL)
  assert.equal(home.state, 'kinematic')
  note(settled, home)

  const leaning = { ...STILL, comOffset: CATCH_OFFSET + 0.05 }
  const step = until(pushed(), leaning)
  assert.equal(step.state, 'catchStep')
  note(p, step)
  const back = until(step, STILL)
  assert.equal(back.state, 'perturbed')
  assert.equal(back.steps, 1)
  note(step, back)

  // Still past the support after every step: catchStep → catchStep (the same state, so `until` runs on) → sit down.
  const m = until(step, leaning)
  assert.equal(m.state, 'sittingDown', 'too many catch steps: sit down')
  assert.equal(m.steps, MAX_CATCH_STEPS)
  note(step, m)
  const over = until(pushed(), { ...STILL, tilt: SIT_TILT + 0.1 })
  assert.equal(over.state, 'sittingDown', 'too far over: sit down at once')
  note(p, over)

  const seated = until(m, { ...STILL, pelvisHeight: SEATED_HEIGHT - 0.1 })
  assert.equal(seated.state, 'seated')
  note(m, seated)
  const rise = until(seated, STILL)
  assert.equal(rise.state, 'recovering')
  assert.equal(rise.blend, RISE_TIME)
  note(seated, rise)

  assert.deepEqual([...seen].sort(), TRANSITIONS.map(([a, b]) => `${a}>${b}`).sort())
})

test('the timers: settle, step, sit and rise take the time their constants say', () => {
  const settle = pushed()
  let t = 0, m = settle
  while (m.state === 'perturbed') { m = stepBalance(m, STILL, DT); t += DT }
  assert.ok(Math.abs(t - SETTLE_TIME) < 2 * DT, `settled after ${t}`)

  m = until(pushed(), { ...STILL, comOffset: 1 })
  t = 0
  const first = m
  while (m === first || (m.state === 'catchStep' && m.steps === first.steps)) { m = stepBalance(m, { ...STILL, comOffset: 1 }, DT); t += DT }
  assert.ok(Math.abs(t - STEP_TIME) < 2 * DT, `a catch step took ${t}`)

  // Sitting down with the pelvis never low enough ends at SIT_TIME_MAX; seated stillness at SEATED_TIME.
  m = until(pushed(), { ...STILL, tilt: 1 })
  t = 0
  while (m.state === 'sittingDown') { m = stepBalance(m, STILL, DT); t += DT }
  assert.ok(Math.abs(t - SIT_TIME_MAX) < 2 * DT)
  t = 0
  while (m.state === 'seated') { m = stepBalance(m, STILL, DT); t += DT }
  assert.ok(Math.abs(t - SEATED_TIME) < 2 * DT)

  // A person who never settles and never passes the support still sits down at PERTURBED_MAX: no livelock.
  m = pushed()
  t = 0
  const wobble = { ...STILL, tiltRate: 1 }
  while (m.state === 'perturbed') { m = stepBalance(m, wobble, DT); t += DT }
  assert.equal(m.state, 'sittingDown')
  assert.ok(Math.abs(t - PERTURBED_MAX) < 2 * DT)
})

/** A tiny deterministic generator. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let z = s
    z = Math.imul(z ^ (z >>> 15), z | 1)
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61)
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296
  }
}

function randomRun(seed: number): BalanceMachine[] {
  const r = rng(seed)
  let m: BalanceMachine = KINEMATIC
  const out: BalanceMachine[] = []
  for (let i = 0; i < 3000; i++) {
    // Chaotic stretches, and calm ones in which a person can settle.
    const calm = Math.floor(i / 150) % 2 === 1
    const inp: BalanceInputs = calm
      ? { tilt: r() * 0.07, tiltRate: r() * 0.35, comOffset: r() * 0.12, pelvisHeight: 0.9 + r() * 0.1 }
      : {
          tilt: r() * 1.2,
          tiltRate: r() * 2,
          comOffset: r() * 0.5,
          pelvisHeight: r() * 1.1,
          push: r() < 0.02 ? { cause: 'slip', impulse: r() * 100 } : null,
        }
    if (r() < 0.01) inp.tilt = NaN
    m = stepBalance(m, inp, r() < 0.01 ? 0 : DT * (0.5 + r()))
    out.push(m)
  }
  return out
}

test('random inputs: no transition outside the table, and the same inputs always give the same machines', () => {
  const allowed = new Set(TRANSITIONS.map(([a, b]) => `${a}>${b}`))
  const visited = new Set<BalanceState>()
  for (let seed = 1; seed <= 25; seed++) {
    const run = randomRun(seed)
    assert.deepEqual(run, randomRun(seed), `seed ${seed} is deterministic`)
    let prev: BalanceState = 'kinematic'
    for (const m of run) {
      visited.add(m.state)
      if (m.state !== prev) assert.ok(allowed.has(`${prev}>${m.state}`), `${prev}>${m.state}`)
      assert.ok(Number.isFinite(m.t) && m.t >= 0 && Object.isFrozen(m))
      prev = m.state
    }
  }
  assert.equal(visited.size, 6, `every state visited: ${[...visited]}`)
})

test('inputs that are not finite, and a dt that is not positive, change nothing but the clock', () => {
  const p = pushed()
  const nan = stepBalance(p, { ...STILL, tilt: NaN }, DT)
  assert.equal(nan.state, 'perturbed')
  assert.ok(nan.t > p.t)
  assert.equal(stepBalance(p, STILL, 0), p)
  assert.equal(stepBalance(p, STILL, -1), p)
  assert.equal(stepBalance(p, STILL, NaN), p)
  assert.equal(stepBalance(KINEMATIC, { ...STILL, push: { cause: 'shove', impulse: PROMOTE_IMPULSE - 1 } }, DT).state, 'kinematic', 'the crowd absorbs a light push')
})

test('a vehicle is never a cause: refused by name, by the pool, and absent from the causes', () => {
  assert.ok(!(PERTURBATION_CAUSES as readonly string[]).includes('vehicle'))
  assert.deepEqual(classifyPerturbation({ cause: 'vehicle', impulse: 500 }), { ok: false, reason: 'vehicle' })
  assert.deepEqual(classifyPerturbation({ cause: 'car', impulse: 50 }), { ok: false, reason: 'unknownCause' })
  assert.deepEqual(classifyPerturbation({ cause: 7, impulse: 50 }), { ok: false, reason: 'unknownCause' })
  for (const impulse of [NaN, -1, Infinity, '50']) assert.deepEqual(classifyPerturbation({ cause: 'slip', impulse }), { ok: false, reason: 'invalidImpulse' })
  for (const cause of PERTURBATION_CAUSES) assert.equal(classifyPerturbation({ cause, impulse: 50 }).ok, true)

  const pool = new RagdollPool()
  assert.deepEqual(pool.offer(candidate(1, 3, { cause: 'vehicle', impulse: 900 })), { kind: 'refused', reason: 'vehicle' })
  assert.equal(pool.size, 0)
  // Nor may a member already on a rig take a push from one.
  pool.offer(candidate(2, 3))
  assert.deepEqual(pool.offer(candidate(2, 3, { cause: 'vehicle', impulse: 900 })), { kind: 'refused', reason: 'vehicle' })
  assert.deepEqual(pool.step(DT, new Map()).pushes, [{ id: 2, push: SHOVE }], 'only the promoting shove reaches the rig')
})

function candidate(id: number, distance: number, perturbation: Candidate['perturbation'] = SHOVE): Candidate {
  return { id, distance, perturbation, x: id, y: 0, z: -id, vx: 1.2, vy: 0, vz: 0.3, heading: 0.5 }
}

const reading = (distance: number, inp: BalanceInputs = STILL): Reading => ({ ...inp, distance })

test('the pool promotes near the operator with continuity, absorbs light pushes, and refuses what it cannot trust', () => {
  const pool = new RagdollPool()
  assert.deepEqual(pool.offer(candidate(1, PROMOTE_RADIUS + 1)), { kind: 'tooFar' })
  assert.deepEqual(pool.offer(candidate(1, 3, { cause: 'shove', impulse: PROMOTE_IMPULSE - 1 })), { kind: 'absorbed' })
  assert.deepEqual(pool.offer({ ...candidate(1, 3), vx: NaN }), { kind: 'refused', reason: 'notFinite' })
  assert.equal(pool.size, 0)
  assert.deepEqual(pool.offer(candidate(1, 3)), { kind: 'promoted', id: 1, evicted: null })
  assert.deepEqual(pool.get(1)!.spawn, { x: 1, y: 0, z: -1, vx: 1.2, vy: 0, vz: 0.3, heading: 0.5 }, 'the rig starts where and as the crowd had them')
  assert.deepEqual(pool.offer(candidate(1, 3, { cause: 'kerbTrip', impulse: 10 })), { kind: 'pushed', id: 1 }, 'a member with a rig takes any push')
  const ev = pool.step(DT, new Map([[1, reading(3)]]))
  assert.deepEqual(ev.build, [1])
  assert.deepEqual(ev.pushes.map((p) => p.push.cause), ['shove', 'kerbTrip'])
  assert.deepEqual([ev.remove, ev.released], [[], []])
  assert.deepEqual(pool.step(DT, new Map([[1, reading(3)]])).build, [], 'built once')
})

test('a full pool evicts only the farthest member standing on its own, never one stepping or sitting down', () => {
  const pool = new RagdollPool()
  for (let id = 1; id <= POOL_CAPACITY; id++) pool.offer(candidate(id, 2 + id))
  assert.equal(pool.rigs, POOL_CAPACITY)
  assert.deepEqual(pool.offer(candidate(99, 20)), { kind: 'full' }, 'nobody is farther than the newcomer')
  pool.step(DT, new Map())

  // The farthest member (8) is mid catch step: the next farthest standing one (7) goes instead.
  const readings = new Map<number, Reading>()
  for (let id = 1; id <= POOL_CAPACITY; id++) readings.set(id, reading(2 + id, id === 8 ? { ...STILL, comOffset: 1 } : { ...STILL, tiltRate: 1 }))
  pool.step(DT, readings)
  assert.equal(pool.get(8)!.machine.state, 'catchStep')
  assert.deepEqual(pool.offer(candidate(50, 1)), { kind: 'promoted', id: 50, evicted: 7 })
  assert.equal(pool.get(7)!.machine.state, 'recovering')
  assert.equal(pool.rigs, POOL_CAPACITY, 'the evicted member blends back without a rig')
  assert.equal(pool.size, POOL_CAPACITY + 1)
  const ev = pool.step(DT, readings)
  assert.deepEqual([ev.build, ev.remove], [[50], [7]])

  // Blend done: released, slot free.
  let released: number[] = []
  for (let t = 0; t < SETTLE_BLEND + 0.1; t += DT) released = released.concat(pool.step(DT, readings).released)
  assert.deepEqual(released, [7])
  assert.equal(pool.get(7), undefined)
})

test('members that settle, or that the operator leaves behind, hand their rig back and are released after the blend', () => {
  const pool = new RagdollPool()
  pool.offer(candidate(1, 3))
  pool.offer(candidate(2, 3))
  const removed: number[] = [], released: number[] = []
  for (let t = 0; t < 3; t += DT) {
    const ev = pool.step(DT, new Map([[1, reading(3)], [2, reading(DEMOTE_RADIUS + 5, { ...STILL, tiltRate: 1 })]]))
    removed.push(...ev.remove)
    released.push(...ev.released)
  }
  assert.deepEqual(removed.sort(), [1, 2], 'a settled member (1) and one left far behind while standing (2)')
  assert.deepEqual(released.sort(), [1, 2])
  assert.equal(pool.size, 0)
  assert.equal(pool.rigs, 0)
})

test('gains: no rig while kinematic or blending back; full assist while balancing; less support to sit down', () => {
  for (const s of ['kinematic', 'recovering'] as const) {
    assert.equal(rigWanted(s), false)
    assert.deepEqual({ ...GAINS[s] }, { stiffness: 0, damping: 0, assist: 0, support: 0 })
  }
  for (const s of ['perturbed', 'catchStep', 'sittingDown', 'seated'] as const) assert.equal(rigWanted(s), true)
  assert.equal(GAINS.perturbed.support, 1)
  assert.ok(GAINS.sittingDown.support < GAINS.catchStep.support && GAINS.sittingDown.assist === 1, 'the trunk is held while lowering')
  assert.equal(GAINS.seated.support, 0)
  for (const g of Object.values(GAINS)) assert.ok(g.damping >= 0 && g.damping <= 1, 'a servo closes at most the whole gap per tick')
})

test('the drawn pose: all rig while physical, blending linearly back to the crowd while recovering', () => {
  assert.equal(physicalWeight(KINEMATIC), 0)
  assert.equal(physicalWeight(pushed()), 1)
  let m = until(pushed(), STILL)
  assert.equal(physicalWeight(m), 1)
  m = stepBalance(m, STILL, SETTLE_BLEND / 2)
  assert.ok(Math.abs(physicalWeight(m) - 0.5) < 1e-9)
})

test('balance wording only: no word of harm in either ragdoll source', () => {
  const words = /\b(attack|damage|weapon|kill|combat|target|shoot|gun|injur\w*|violen\w*|hit|crash\w*|collid\w*|collision|dead|death|die|blood|maim|wound|smash)\b/i
  for (const f of ['ragdoll.ts', 'ragdollRig.ts']) {
    // Rapier's own names for a body's shape are the only exception.
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8').replace(/\b(ColliderDesc|createCollider)\b/g, '')
    assert.doesNotMatch(src, words, f)
  }
})
