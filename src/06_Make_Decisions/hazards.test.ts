// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the hazard table (hazards.ts) to the state machine it replaced: a plain,
 * branching reference of HazardEpisode as traffic.ts had it (no episode → rolled → reacted → clear countdown → no
 * episode) is run beside the table's mask arithmetic over seeded streams of distances and time steps, flickers and
 * long clear stretches among them, and the two must agree on every answer, every reported latency, every `reacted`,
 * and the identity of the check object for the whole episode; rows stay independent of each other as the table
 * grows past its first allocation; and the transition's masks hold on the edge values (a distance exactly at the
 * range, a step of zero, a NaN distance, which is nobody).
 * What breaks if it is removed? The branchless transition could drift from the semantics the drivers' tests pin.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DRIVER_REACTION, KERNEL } from '../02_Define_The_Rules/civic.ts'
import { createRng, rollCheck, type CheckResult } from '../02_Define_The_Rules/degrees.ts'
import { forAll } from '../02_Define_The_Rules/property.ts'
import { EPISODE_CLEAR, HAZARDS, HazardTable, PERSON_STOP, REACTION_SLACK } from './hazards.ts'

/** The state machine as traffic.ts wrote it before the table: the reference. */
class Reference {
  hazard: CheckResult | null = null
  hazardSeconds = 0
  clearSeconds = 0
  readonly rng: () => number
  constructor(rng: () => number) {
    this.rng = rng
  }
  get reactionLatency(): number {
    return this.hazard ? DRIVER_REACTION.latency[this.hazard.degree] : Infinity
  }
  get reacted(): boolean {
    return this.hazard !== null && this.hazardSeconds >= this.reactionLatency - REACTION_SLACK
  }
  perceive(personAhead: number, dt: number): number {
    const present = personAhead < KERNEL.range
    if (present && !this.hazard) {
      this.hazard = rollCheck(DRIVER_REACTION.modifier, DRIVER_REACTION.dc, this.rng)
      // The frame the person is first seen is a frame of looking at them.
      this.hazardSeconds = dt
      this.clearSeconds = 0
    } else if (this.hazard) {
      this.hazardSeconds += dt
      this.clearSeconds = present ? 0 : this.clearSeconds + dt
      if (this.clearSeconds >= EPISODE_CLEAR) {
        this.hazard = null
        this.hazardSeconds = 0
        this.clearSeconds = 0
      }
    }
    return present && this.reacted ? personAhead - PERSON_STOP : Infinity
  }
}

/** A distance stream: runs of a person near, far, flickering, exactly at the range, or not a number. */
const distance = (g: { int: (a: number, b: number) => number; float: (a: number, b: number) => number; bool: (p?: number) => boolean }, mode: number): number => {
  switch (mode) {
    case 0: return g.float(0, KERNEL.range)
    case 1: return Infinity
    case 2: return g.bool() ? g.float(0, 12) : g.float(KERNEL.range, 200)
    case 3: return KERNEL.range
    case 4: return Number.NaN
    default: return g.float(KERNEL.range - 1, KERNEL.range + 1)
  }
}

test('the table answers as the reference state machine does, step for step, on seeded streams of distances', () => {
  forAll('hazard table', { seed: 0x4a2a, runs: 400 }, (g, i) => {
    const steps: { d: number; dt: number }[] = []
    let mode = g.int(0, 5)
    for (let k = 0; k < g.int(1, 300); k++) {
      if (g.bool(0.08)) mode = g.int(0, 5)
      steps.push({ d: distance(g, mode), dt: g.pick([0, 1 / 60, 1 / 30, 0.1, 0.25, g.float(0, 1.2)]) })
    }
    return { seed: 1000 + i, steps }
  }, ({ seed, steps }) => {
    const table = new HazardTable()
    const row = table.add(createRng(seed))
    const ref = new Reference(createRng(seed))
    let sameCheck: CheckResult | null = null
    for (const [k, { d, dt }] of steps.entries()) {
      const a = table.perceive(row, d, dt)
      const b = ref.perceive(d, dt)
      assert.equal(a, b, `step ${k}: room`)
      assert.equal(table.reactionLatency(row), ref.reactionLatency, `step ${k}: latency`)
      assert.equal(table.reacted(row), ref.reacted, `step ${k}: reacted`)
      assert.deepEqual(table.check(row), ref.hazard, `step ${k}: the check`)
      // The same object for the whole episode: a new one only when the reference rolled anew.
      if (table.check(row) !== null && ref.hazard === sameCheck) assert.equal(table.check(row), sameCheck, `step ${k}: the episode's check`)
      sameCheck = table.check(row)
      if (ref.hazard !== null && sameCheck === null) sameCheck = ref.hazard
    }
  })
})

test('Perception to the frame: at 60 Hz each degree reacts on frame round(latency × 60), counting the frame the person is first seen', () => {
  for (const [degree, latency] of DRIVER_REACTION.latency.entries()) {
    // A seed whose first roll lands on this degree.
    let seed = 1
    while (rollCheck(DRIVER_REACTION.modifier, DRIVER_REACTION.dc, createRng(seed)).degree !== degree) seed++
    const table = new HazardTable()
    const r = table.add(createRng(seed))
    let frame = 0
    while (!table.reacted(r) && frame < 1000) {
      frame++
      table.perceive(r, 5, 1 / 60)
    }
    assert.equal(table.check(r)!.degree, degree)
    assert.equal(frame, Math.round(latency * 60), `degree ${degree}: ${latency} s is ${Math.round(latency * 60)} frames, reacted on frame ${frame}`)
  }
})

test('rows are independent, and stay so as the table grows past its first allocation', () => {
  const table = new HazardTable()
  const rows = 100
  const refs: Reference[] = []
  for (let r = 0; r < rows; r++) {
    assert.equal(table.add(createRng(r)), r)
    refs.push(new Reference(createRng(r)))
  }
  assert.equal(table.rows, rows)
  const g = createRng(7)
  for (let t = 0; t < 2000; t++) {
    const r = Math.floor(g() * rows)
    const d = g() < 0.5 ? g() * KERNEL.range : Infinity
    const dt = 1 / 30
    assert.equal(table.perceive(r, d, dt), refs[r].perceive(d, dt), `tick ${t} row ${r}`)
    assert.equal(table.reacted(r), refs[r].reacted)
  }
  for (let r = 0; r < rows; r++) {
    assert.deepEqual(table.check(r), refs[r].hazard, `row ${r} at the end`)
  }
})

test('the shared table is the one the drivers draw rows from, and a step of zero neither starts nor ends anything by itself', () => {
  const before = HAZARDS.rows
  const r = HAZARDS.add(createRng(3))
  assert.equal(r, before)
  assert.equal(HAZARDS.perceive(r, Infinity, 0), Infinity)
  assert.equal(HAZARDS.check(r), null)
  // A person: one roll, nothing reacted yet at zero seconds.
  assert.equal(HAZARDS.perceive(r, 5, 0), Infinity)
  const first = HAZARDS.check(r)
  assert.ok(first)
  assert.equal(HAZARDS.reacted(r), false)
  // Time passes with the person there: the reaction lands at the degree's latency, and the room is the standoff.
  const latency = DRIVER_REACTION.latency[first.degree]
  assert.equal(HAZARDS.perceive(r, 5, latency), 5 - PERSON_STOP)
  assert.equal(HAZARDS.check(r), first)
  // Clear for less than EPISODE_CLEAR: the same episode; for EPISODE_CLEAR: over.
  assert.equal(HAZARDS.perceive(r, Infinity, EPISODE_CLEAR / 2), Infinity)
  assert.equal(HAZARDS.check(r), first)
  assert.equal(HAZARDS.perceive(r, Infinity, EPISODE_CLEAR / 2), Infinity)
  assert.equal(HAZARDS.check(r), null)
  assert.equal(HAZARDS.reactionLatency(r), Infinity)
})
