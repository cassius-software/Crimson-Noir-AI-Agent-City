// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the environment probe's schedule (envProbe.ts): a bake on the first call, then one
 * each time the clock has moved more than the step (across midnight too), and every bake after the first rendering
 * into the first bake's target, so the scene's environment texture is one object for the whole session.
 * What breaks if it is removed? A later edit could take a fresh target per bake again, which re-keys every material
 * in the scene on a 12 s timer, the stall this schedule was written to remove.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ENV_PROBE_STEP_HOURS, EnvProbe, hoursApart } from './envProbe.ts'

class Target { readonly n: number; constructor(n: number) { this.n = n } }

const baker = () => {
  const log: (Target | null)[] = []
  let made = 0
  const bake = (reuse: Target | null): Target => { log.push(reuse); return reuse ?? new Target(++made) }
  return { bake, log, made: () => made }
}

test('the step is 0.2 h (12 game minutes: 12 s of real time at ?day=24)', () => {
  assert.equal(ENV_PROBE_STEP_HOURS, 0.2)
})

test('hoursApart takes the shorter way round the clock', () => {
  assert.ok(Math.abs(hoursApart(6, 6.1) - 0.1) < 1e-9)
  assert.ok(Math.abs(hoursApart(23.9, 0.1) - 0.2) < 1e-9)
  assert.equal(hoursApart(0, 12), 12)
  assert.equal(hoursApart(30, 6), 0)
})

test('the first refresh bakes into a fresh target; the next ones reuse it', () => {
  const b = baker()
  const probe = new EnvProbe<Target>(b.bake, { now: () => 0 })
  assert.ok(probe.target === null)
  assert.ok(probe.due(9))
  assert.equal(probe.refresh(9), true)
  const first = probe.target as Target | null
  assert.ok(first !== null && first.n === 1)
  assert.deepEqual(b.log, [null])
  // Less than a step on: nothing.
  assert.equal(probe.refresh(9.15), false)
  assert.equal(probe.refresh(9.2), false)
  assert.equal(b.made(), 1)
  // Past a step: a bake, into the same target.
  assert.equal(probe.refresh(9.21), true)
  assert.equal(probe.target, first)
  assert.equal(b.log[1], first)
  assert.equal(b.made(), 1, 'no second allocation')
  assert.equal(probe.bakes, 2)
  assert.equal(probe.bakedHours, 9.21)
})

test('the step is measured from the last bake, not from the last call', () => {
  const b = baker()
  const probe = new EnvProbe<Target>(b.bake, { now: () => 0 })
  probe.refresh(0)
  for (let h = 0.01; h < 0.2; h += 0.01) assert.equal(probe.refresh(h), false)
  assert.equal(probe.refresh(0.25), true)
  assert.equal(probe.bakes, 2)
})

test('midnight is not a long wait: 23.95 to 0.05 is 0.1 h, 23.9 to 0.15 is a step', () => {
  const b = baker()
  const probe = new EnvProbe<Target>(b.bake, { now: () => 0 })
  probe.refresh(23.95)
  assert.equal(probe.refresh(0.05), false)
  assert.equal(probe.refresh(0.16), true)
})

test('a baker that hands back a different target than it was given is a bug, and is said so', () => {
  let n = 0
  const probe = new EnvProbe<Target>(() => new Target(++n), { now: () => 0 })
  probe.refresh(1)
  assert.throws(() => probe.refresh(2), /render into the target it was given/)
})

test('onBake hears each bake and how long it took; a time-clock advance is a time-clock report', () => {
  const b = baker()
  const times: number[] = []
  let clock = 100
  const probe = new EnvProbe<Target>((r) => { clock += 7.5; return b.bake(r) }, { now: () => clock, onBake: (ms) => times.push(ms) })
  probe.refresh(3)
  probe.refresh(3.5)
  assert.deepEqual(times, [7.5, 7.5])
})

test('a custom step is honoured', () => {
  const b = baker()
  const probe = new EnvProbe<Target>(b.bake, { stepHours: 1, now: () => 0 })
  probe.refresh(0)
  assert.equal(probe.refresh(0.9), false)
  assert.equal(probe.refresh(1.01), true)
})
