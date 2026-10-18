// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the governor's hold (hold()): the cap the in-page model puts on the city while it
 * works. The cap lowers the tier at once and stops the probes at it, and nothing under it counts against a tier (the
 * city is slower because the model has the device, not because the tier is too heavy). The release returns the tier
 * from before the hold after the usual cooldown, a manual tier is never moved, a lite profile stays at Lite, a cap
 * at the top of the range lowers nothing yet still keeps the steps under it from counting, and the frames sampled
 * under the hold are dropped. Frame streams are synthetic, as in governor.test.ts.
 * What breaks if it is removed? A change could let the model's work count against a tier (the city would come back
 * from every answer backed off for minutes), let probes climb back into the model's share of the GPU, strand the city
 * at the cap after the answer, or move the operator's manual tier.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Governor, LITE, TIERS, tierRange } from './governor.ts'

// ---------------------------------------------------------------------------------------------------
// Frame stream harness (governor.test.ts Clock)

interface Change { at: number; tier: number }

class Clock {
  now = 1000
  readonly changes: Change[] = []
  readonly g: Governor
  constructor(g: Governor) { this.g = g }
  /** Feeds frames for `seconds`; `frame` returns the next rAF interval given the current tier. */
  run(seconds: number, frame: number | ((tier: number) => number)): this {
    const end = this.now + seconds * 1000
    while (this.now < end) {
      const ms = typeof frame === 'number' ? frame : frame(this.g.tier)
      this.now += ms
      const r = this.g.sample(ms, this.now)
      if (r !== null) this.changes.push({ at: this.now, tier: r })
    }
    return this
  }
  after(at: number): Change[] { return this.changes.filter((x) => x.at > at) }
}

const hz = (rate: number) => 1000 / rate
/** 20 FPS: below 60 throughout, so 2.5 s of it steps down one tier. */
const SLOW = 50

/**
 * The governor's per-tier memory of step downs: how many, when, and the probe wait. It is private; the test reads it
 * because the hold's whole promise is to leave it as it was.
 */
function memory(g: Governor): number[][] {
  const m = g as unknown as { fails: Uint32Array; failedAt: Float64Array; blockedUntil: Float64Array }
  return [[...m.fails], [...m.failedAt], [...m.blockedUntil]]
}

/** A desktop governor warmed up for 3 s at 60 Hz (no probe yet: the first needs 5 s on target). */
function warm(tier: number, opts: { auto?: boolean; min?: number; max?: number; lite?: boolean } = {}): Clock {
  const c = new Clock(new Governor({ tier, auto: opts.auto ?? true, ...opts })).run(3, hz(60))
  assert.deepEqual(c.changes, [], 'warm-up changes nothing')
  return c
}

// ---------------------------------------------------------------------------------------------------
// 1. The cap

test('hold 1: a cap drops the automatic tier at once, records nothing against the tiers it left, and is reported like setTier', () => {
  const c = warm(3)
  const g = c.g
  const before = memory(g)
  g.hold(1, c.now)
  assert.equal(g.tier, 1, 'down to the cap at once, two tiers in one move')
  assert.equal(g.reason, 'held')
  assert.deepEqual(g.state(), { tier: 1, label: 'Low', auto: true, renderScale: TIERS[1].renderScale, targetMs: g.targetMs, held: 1 })
  assert.deepEqual(memory(g), before, 'no step down remembered, no back-off')
  // The engine applies the knobs right after hold returns; the next sample() reports the change once, as after setTier.
  c.run(0.05, hz(60))
  assert.deepEqual(c.changes.map((x) => x.tier), [1])
  c.run(1, hz(60))
  assert.equal(c.changes.length, 1)
})

test('hold 1: probes stop at the cap, and climb to it from below; an unheld twin climbs past it', () => {
  const at = warm(1)
  at.g.hold(1, at.now)
  at.run(120, hz(60))
  assert.deepEqual(at.changes, [], 'two minutes of headroom at the cap: no probe')
  assert.equal(at.g.state().held, 1)

  const below = warm(0)
  below.g.hold(2, below.now)
  assert.equal(below.g.tier, 0, 'a cap above the tier raises nothing')
  below.run(120, hz(60))
  assert.deepEqual(below.changes.map((x) => x.tier), [1, 2], 'probes reach the cap, one at a time, and stop')
  below.g.hold(null, below.now)
  assert.equal(below.g.tier, 2, 'the release keeps a tier the probes reached under the hold')

  const free = warm(0)
  free.run(120, hz(60))
  assert.deepEqual(free.changes.map((x) => x.tier), [1, 2, 3, 4])
})

// ---------------------------------------------------------------------------------------------------
// 2. Steps down under the hold

test('hold 2: a step down under the hold is taken but not remembered: no back-off, so the climb back starts after 5 s', () => {
  // The same slow spell (20 FPS for 6.5 s: two steps down) with and without a hold, then headroom.
  const held = warm(3)
  held.g.hold(3, held.now)
  const free = warm(3)
  const before = memory(held.g)
  for (const c of [held, free]) c.run(6.5, SLOW)
  assert.deepEqual(held.changes.map((x) => x.tier), [2, 1], 'the city still steps down while the model works')
  assert.deepEqual(free.changes.map((x) => x.tier), [2, 1])
  assert.equal(held.g.reason, 'frames below 60 FPS')
  assert.deepEqual(memory(held.g), before, 'neither step remembered')
  assert.notDeepEqual(memory(free.g), before, 'the unheld twin remembers both')

  const left = held.changes[1].at
  const freeLeft = free.changes[1].at
  for (const c of [held, free]) c.run(60, hz(60))
  const up = held.after(left)[0]
  const freeUp = free.after(freeLeft)[0]
  assert.equal(up?.tier, 2)
  assert.ok(up.at - left >= 6500 && up.at - left < 8000, `held: back to 2 after ${up.at - left} ms (cooldown and 5 s on target)`)
  assert.equal(freeUp?.tier, 2)
  assert.ok(freeUp.at - freeLeft >= 20000, `unheld: back to 2 after its back-off, ${freeUp.at - freeLeft} ms`)
  assert.equal(held.g.tier, 3, 'and on to the cap')
})

test('hold 2: a probe that fails under the hold is not a failed probe either', () => {
  // Tier 2 holds 60 Hz, tier 3 costs 20 ms: every probe to 3 is withdrawn.
  const cost = (tier: number) => (tier >= 3 ? hz(30) + 0.01 : hz(60))
  const c = warm(2)
  c.g.hold(3, c.now)
  const before = memory(c.g)
  c.run(120, cost)
  const ups = c.changes.filter((x) => x.tier === 3)
  assert.ok(ups.length >= 8, `${ups.length} probes in 2 min: no back-off grows under the hold`)
  assert.ok(c.changes.every((x) => x.tier === 2 || x.tier === 3), JSON.stringify(c.changes))
  assert.deepEqual(memory(c.g), before)
})

// ---------------------------------------------------------------------------------------------------
// 3. The release

test('hold 3: the release returns the tier from before the hold, then waits out the cooldown and 5 s on target before a probe', () => {
  const c = warm(3)
  c.g.hold(1, c.now)
  c.run(10, SLOW)                                   // the model works and the city crawls: 1 → 0, unremembered
  assert.equal(c.g.tier, 0)
  const before = memory(c.g)
  const released = c.now
  c.g.hold(null, released)
  assert.equal(c.g.tier, 3, 'back to the tier from before the hold at once')
  assert.equal(c.g.reason, 'released')
  assert.equal(c.g.state().held, undefined)
  assert.equal('held' in c.g.state(), false, 'absent, not undefined')
  c.run(1.4, SLOW)                                  // the last slow frames land inside the cooldown
  c.run(30, hz(60))
  const after = c.after(released)
  assert.equal(after[0]?.tier, 3, 'reported by the next sample')
  assert.ok(after[0].at - released <= SLOW, 'on the first frame after the release')
  const probe = after[1]
  assert.equal(probe?.tier, 4)
  assert.ok(probe.at - released >= 6500, `no probe storm: the first probe ${probe.at - released} ms after the release`)
  assert.equal(after.length, 2, JSON.stringify(after))
  assert.deepEqual(memory(c.g), before, 'the release records no step down')
})

test('hold 3: frames sampled under the hold never read as a slowdown after the release', () => {
  // 2 s of slow frames under the hold is not yet a step; 1 s more after the release would be, were the window kept.
  const c = warm(2)
  c.g.hold(2, c.now)
  c.run(2, SLOW)
  assert.deepEqual(c.changes, [])
  const released = c.now
  c.g.hold(null, released)
  assert.equal(c.g.tier, 2)
  c.run(3, SLOW)
  assert.deepEqual(c.changes, [], 'the window starts afresh after the cooldown')
  c.run(2, SLOW)
  const down = c.after(released)[0]
  assert.ok(down?.tier === 1 && down.at - released >= 3500, 'a slowdown that outlasts the hold still steps down, as after any change')
})

test('hold 3: hold(null) without a hold, and a cap that is not a number, change nothing', () => {
  // Two governors fed the same frames; one gets the calls midway through a slowdown. A reset would delay its step.
  const a = warm(2)
  const b = warm(2)
  for (const c of [a, b]) c.run(1.5, SLOW)
  const state = b.g.state()
  b.g.hold(null, b.now)
  b.g.hold(NaN, b.now)
  b.g.hold(Infinity, b.now)
  assert.deepEqual(b.g.state(), state)
  assert.equal(b.g.reason, '')
  for (const c of [a, b]) c.run(5, SLOW)
  assert.deepEqual(b.changes, a.changes)
  assert.ok(b.changes.length > 0)
})

// ---------------------------------------------------------------------------------------------------
// 4. A manual tier wins

test('hold 4: a manual tier is never moved; the cap is recorded and shown', () => {
  const c = warm(4, { auto: false })
  c.g.hold(1, c.now)
  assert.equal(c.g.tier, 4)
  assert.deepEqual(c.g.state(), { tier: 4, label: 'Ultra', auto: false, renderScale: 1, targetMs: c.g.targetMs, held: 1 })
  c.run(10, SLOW)
  c.g.hold(null, c.now)
  c.run(10, hz(60))
  assert.deepEqual(c.changes, [])
  assert.equal(c.g.state().held, undefined)

  // setTier under a hold: the operator's tier stands, and the release leaves it.
  const s = warm(3)
  s.g.hold(1, s.now)
  s.g.setTier(4)
  assert.equal(s.g.tier, 4)
  assert.equal(s.g.state().held, 1)
  s.g.hold(0, s.now)
  assert.equal(s.g.tier, 4, 'a second hold leaves it too')
  s.g.hold(null, s.now)
  assert.equal(s.g.tier, 4)
  assert.equal(s.g.auto, false)
})

test('hold 4: auto turned back on under a hold lands under the cap; the release returns what auto would have taken', () => {
  const c = warm(4, { auto: false })
  c.g.hold(1, c.now)
  c.g.setAuto(true)
  assert.equal(c.g.tier, 1)
  c.run(30, hz(60))
  assert.equal(c.g.tier, 1, 'no probe past the cap')
  c.g.hold(null, c.now)
  assert.equal(c.g.tier, 4, 'the manual 4, which auto keeps without a hold')

  // The operator's own lower tier replaces the one from before the hold.
  const s = warm(3)
  s.g.hold(1, s.now)
  s.g.setTier(0)
  s.g.setAuto(true)
  assert.equal(s.g.tier, 0)
  s.g.hold(null, s.now)
  assert.equal(s.g.tier, 0)

  // Auto off and on again under the hold keeps the tier from before it.
  const t = warm(3)
  t.g.hold(1, t.now)
  t.g.setAuto(false)
  t.g.setAuto(true)
  assert.equal(t.g.tier, 1)
  t.g.hold(null, t.now)
  assert.equal(t.g.tier, 3)
})

// ---------------------------------------------------------------------------------------------------
// 5. The range: Lite, phones, a second cap

test('hold 5: a lite profile is held at Lite and never below it; other devices never walk into Lite', () => {
  const lite = tierRange({ mobile: true, gpuClass: 'mobile', startTier: -1, lite: true })
  const c = warm(0, { ...lite, lite: true })
  c.g.hold(-1, c.now)
  assert.equal(c.g.tier, -1)
  assert.equal(c.g.knobs(), LITE)
  assert.deepEqual(c.g.state(), { tier: -1, label: 'Lite', auto: true, renderScale: 0.5, targetMs: c.g.targetMs, lite: true, held: -1 })
  c.g.hold(-5, c.now)
  assert.equal(c.g.state().held, -1, 'a cap below the range is clamped to its floor')
  c.run(30, SLOW).run(30, hz(60))
  assert.ok(c.changes.every((x) => x.tier === -1), JSON.stringify(c.changes))
  c.g.hold(null, c.now)
  assert.equal(c.g.tier, 0, 'released to Minimal, where it was')

  const phone = tierRange({ mobile: true, gpuClass: 'mobile', startTier: 1, lite: false })
  const p = warm(1, phone)
  p.g.hold(-1, p.now)
  assert.equal(p.g.tier, 0, 'Lite is not in a phone\'s automatic range: held at Minimal')
  assert.equal(p.g.state().held, 0)
  p.g.hold(9, p.now)
  assert.equal(p.g.state().held, 2, 'a cap above the range is clamped to its top')
  assert.equal(p.g.tier, 1, 'and lets it back to the tier from before the hold')
})

test('hold 5: a cap at the top of the range (a discrete desktop\'s) lowers nothing, yet nothing under it is remembered', () => {
  // The in-page model on a discrete GPU (inPagePlan.ts holdTier): no cap on the city, but the model has the GPU.
  const c = warm(4)
  const free = warm(4)
  const before = memory(c.g)
  c.g.hold(4, c.now)
  assert.equal(c.g.tier, 4, 'no tier change')
  assert.equal(c.g.reason, '')
  assert.equal(c.g.state().held, 4)
  for (const x of [c, free]) x.run(6.5, SLOW)
  assert.deepEqual(c.changes.map((x) => x.tier), [3, 2], 'the city still steps down while the model works')
  assert.deepEqual(free.changes.map((x) => x.tier), [3, 2])
  assert.deepEqual(memory(c.g), before, 'neither step remembered')
  assert.notDeepEqual(memory(free.g), before, 'the unheld twin remembers both')
  c.g.hold(null, c.now)
  assert.equal(c.g.tier, 4, 'the release returns the tier from before the hold')
  assert.equal(c.g.state().held, undefined)
  assert.deepEqual(memory(c.g), before)
  // Above the top it is clamped to it, the same hold.
  const over = warm(4)
  over.g.hold(99, over.now)
  assert.equal(over.g.tier, 4)
  assert.equal(over.g.state().held, 4)
})

test('hold 5: a second hold moves the cap: a lower one drops at once, a higher one lets it back up as far as before', () => {
  const c = warm(4)
  const before = memory(c.g)
  c.g.hold(2, c.now)
  assert.equal(c.g.tier, 2)
  c.g.hold(1, c.now)
  assert.equal(c.g.tier, 1, 'lower: down at once')
  assert.equal(c.g.state().held, 1)
  c.g.hold(3, c.now)
  assert.equal(c.g.tier, 3, 'higher: back up as far as the cap')
  assert.equal(c.g.reason, 'released')
  c.run(30, hz(60))
  assert.equal(c.g.tier, 3, 'and no probe past it')
  c.g.hold(null, c.now)
  assert.equal(c.g.tier, 4, 'the release returns to the tier from before the first hold')
  assert.deepEqual(memory(c.g), before)
})
