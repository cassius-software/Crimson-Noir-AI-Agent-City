// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the calibration (actuatorFit.ts) against plants of known numbers: a
 * first-order lag with dead time sampled at 100 Hz gives back its dead time, time constant and gain within a few
 * percent, with and without noise; a critically damped second-order plant is fitted sensibly; no response and bad
 * recordings are refused with a reason; the gains mapping puts the twin's 63.2 % crossing where the robot's was and
 * counts the delay in whole steps, bounded; the delay buffer reads back what was pushed n pushes ago; the round
 * trip smooths echoes by sequence and counts losses; and the calibrator walks two joints of a simulated arm through
 * hold and step, stepping down from a joint near its top, and can be aborted. No robot here.
 * What breaks if it is removed? A twin could be given gains from a fit that is wrong, unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BRIDGE_HZ, Calibrator, DelayBuffer, FIT, fitStep, gainsFor, RoundTrip, type JointToFit, type Sample } from './actuatorFit.ts'

/** A first-order lag with dead time: y' = (K·u(t − L) − y) / τ, stepped at dt ms with a sample each `every` ms. */
function fopdt(K: number, Lms: number, tauMs: number, u0: number, u1: number, o: { every?: number; untilMs?: number; noise?: number; seed?: number } = {}): Sample[] {
  const every = o.every ?? 10, until = o.untilMs ?? 3000
  let s = o.seed ?? 1
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5 }
  const samples: Sample[] = [{ t: -every, y: K * u0 }, { t: 0, y: K * u0 }]
  let y = K * u0
  const dt = 1
  for (let t = dt; t <= until; t += dt) {
    const u = t - dt > Lms ? u1 : u0
    y += ((K * u - y) / tauMs) * dt
    if (t % every === 0) samples.push({ t, y: y + (o.noise ?? 0) * rnd() })
  }
  return samples
}

const within = (a: number, b: number, rel: number, abs = 0) => Math.abs(a - b) <= Math.max(abs, rel * Math.abs(b))

test('a first-order lag with dead time is fitted back: L, τ and K within a few percent, clean and with noise', () => {
  for (const [K, L, tau] of [[1, 40, 200], [0.8, 0, 500], [1.2, 120, 80], [1, 15, 1000]] as const) {
    const fit = fitStep(fopdt(K, L, tau, 0, 0.1, { untilMs: 6 * tau + L + 500 }), 0, 0.1)
    assert.ok(!('error' in fit), 'error' in fit ? fit.error : '')
    assert.ok(within(fit.gain, K, 0.03), `K ${fit.gain} vs ${K}`)
    assert.ok(within(fit.timeConstantMs, tau, 0.05, 5), `τ ${fit.timeConstantMs} vs ${tau}`)
    assert.ok(within(fit.deadTimeMs, L, 0.1, 10), `L ${fit.deadTimeMs} vs ${L}`)
    assert.ok(fit.rmse < 0.002, `rmse ${fit.rmse}`)
    assert.equal(fit.settled, true)
  }
  const noisy = fitStep(fopdt(1, 50, 300, 0.2, 0.3, { noise: 0.004, untilMs: 2500 }), 0.2, 0.3)
  assert.ok(!('error' in noisy))
  assert.ok(within(noisy.gain, 1, 0.06) && within(noisy.timeConstantMs, 300, 0.12) && within(noisy.deadTimeMs, 50, 0.3, 15), JSON.stringify(noisy))
  const down = fitStep(fopdt(1, 30, 150, 0.5, 0.4), 0.5, 0.4)
  assert.ok(!('error' in down) && within(down.gain, 1, 0.03) && within(down.timeConstantMs, 150, 0.05, 5), 'a step down fits the same')
})

test('a critically damped second-order plant: the fit lands near its 63 % crossing and reports a small residual', () => {
  const omega = 2 * Math.PI // rad/s: 63 % at 2.146/ω = 0.34 s
  const samples: Sample[] = [{ t: 0, y: 0 }]
  let y = 0, v = 0
  for (let t = 1; t <= 3000; t++) {
    const a = omega * omega * (0.1 - y) - 2 * omega * v
    v += a / 1000
    y += v / 1000
    if (t % 10 === 0) samples.push({ t, y })
  }
  const fit = fitStep(samples, 0, 0.1)
  assert.ok(!('error' in fit))
  const t63 = (2.146 / omega) * 1000 // a critically damped second-order step reaches 63.2 % at ωt = 2.146
  assert.ok(within(fit.deadTimeMs + fit.timeConstantMs, t63, 0.15), `63 % at ${fit.deadTimeMs + fit.timeConstantMs} vs ${t63}`)
  assert.ok(within(fit.gain, 1, 0.03))
  assert.ok(fit.rmse < 0.004, `rmse ${fit.rmse}`)
})

test('what is refused: a zero step, too few samples, disorder, no response; a recording that ends still moving is fitted but unsettled', () => {
  const s = fopdt(1, 10, 100, 0, 0.1)
  assert.deepEqual(fitStep(s, 0.1, 0.1), { error: 'the commanded step is zero' })
  assert.match((fitStep(s.slice(0, 3), 0, 0.1) as { error: string }).error, /too few samples/)
  assert.match((fitStep([s[0], s[2], s[1], s[3], s[4]], 0, 0.1) as { error: string }).error, /out of time order/)
  assert.match((fitStep(fopdt(0.01, 10, 100, 0, 0.1), 0, 0.1) as { error: string }).error, /no response/)
  const slow = fitStep(fopdt(1, 0, 5000, 0, 0.1, { untilMs: 1000 }), 0, 0.1)
  assert.ok(!('error' in slow) && slow.settled === false, 'a robot still moving when the recording ends: a fit, marked unsettled')
  const never = fitStep([{ t: 0, y: 0 }, { t: 10, y: 0.05 }, { t: 20, y: 0.02 }, { t: 30, y: 0.05 }, { t: 40, y: 0.02 }, { t: 50, y: 0.05 }, { t: 60, y: 0.02 }, { t: 70, y: 0.05 }, { t: 80, y: 0.02 }, { t: 90, y: 0.05 }, { t: 100, y: 0.02 }], 0, 1)
  assert.ok('error' in never && /no response|never reaches/.test(never.error), JSON.stringify(never))
  assert.match((fitStep([{ t: 0, y: 0 }, { t: 1, y: NaN }, { t: 2, y: 0 }, { t: 3, y: 0 }], 0, 1) as { error: string }).error, /not finite/)
})

test('gainsFor: the fitted τ, and the dead time less the return trip in whole steps, bounded', () => {
  const fit = { gain: 1, deadTimeMs: 60, timeConstantMs: 200, rmse: 0, settled: true, y0: 0, yEnd: 0.1 }
  const g = gainsFor(fit, 10)
  assert.deepEqual(g, { tauMs: 200, delaySteps: 3 }, '60 − 10 ms at 60 Hz is three steps')
  assert.equal(gainsFor({ ...fit, deadTimeMs: 5000 }, 0).delaySteps, FIT.maxDelaySteps)
  assert.equal(gainsFor({ ...fit, deadTimeMs: 0 }, 0).delaySteps, 0)
  assert.equal(gainsFor(fit, 100).delaySteps, 0, 'a return trip longer than the dead time: no delay, never a negative one')
  assert.equal(gainsFor(fit, NaN).delaySteps, 4, 'no return trip measured: the dead time as seen')
  assert.equal(gainsFor(fit, 0, 100).delaySteps, 6, 'another rate counts its own steps')
  assert.equal(gainsFor({ ...fit, timeConstantMs: 0 }, 0).tauMs, 0)
  assert.equal(gainsFor({ ...fit, timeConstantMs: -5 }, 0).tauMs, 0)
  // The mapping holds: a setpoint filter y += (u − y)(1 − e^(−h/τ)) stepped at 60 Hz reaches 63.2 % near t = τ.
  let y = 0, t63 = NaN
  const alpha = 1 - Math.exp(-1000 / 60 / g.tauMs)
  for (let i = 1; i <= 600; i++) {
    y += (0.1 - y) * alpha
    if (Number.isNaN(t63) && y >= 0.0632) t63 = i * 1000 / 60
  }
  assert.ok(within(t63, 200, 17), `63 % at ${t63} ms`)
  assert.equal(BRIDGE_HZ, 60)
})

test('DelayBuffer reads back what was pushed n pushes ago; beyond what it holds, the oldest; cleared, nothing', () => {
  const d = new DelayBuffer<number>(3)
  assert.equal(d.read(0), undefined)
  d.push(1)
  assert.equal(d.read(0), 1)
  assert.equal(d.read(2), 1, 'only one pushed: the oldest')
  d.push(2); d.push(3); d.push(4)
  assert.deepEqual([d.read(0), d.read(1), d.read(2), d.read(3)], [4, 3, 2, 1])
  d.push(5)
  assert.deepEqual([d.read(0), d.read(3), d.read(9)], [5, 2, 2], 'the ring holds capacity + 1 values')
  d.clear()
  assert.equal(d.read(0), undefined)
  assert.equal(new DelayBuffer<number>(0).capacity, 2, 'a zero delay still needs the newest and the one before')
})

test('RoundTrip: echoes by sequence, smoothed with the best kept, unknown echoes ignored, losses counted', () => {
  const r = new RoundTrip()
  assert.equal(r.oneWayMs, 0)
  r.send(1, 1000)
  r.send(2, 1010)
  assert.equal(r.echo(2, 1030), 20)
  assert.equal(r.echo(2, 1031), null, 'answered once')
  assert.equal(r.echo(7, 1031), null, 'never sent')
  assert.equal(r.echo(1, 1040), 40)
  assert.deepEqual([r.lastMs, r.minMs, r.samples], [40, 20, 2])
  assert.ok(within(r.meanMs, 20 + FIT.rttAlpha * 20, 1e-9))
  assert.ok(within(r.oneWayMs, r.meanMs / 2, 1e-9))
  r.send(3, 2000)
  assert.equal(r.expire(2500, 400), 1)
  assert.equal(r.lost, 1)
  for (let i = 0; i < FIT.rttOutstanding + 5; i++) r.send(100 + i, 3000 + i)
  assert.equal(r.outstanding, FIT.rttOutstanding)
  assert.equal(r.lost, 6, 'the oldest beyond the bound count as lost')
  assert.equal(r.echo(100, 4000), null, 'evicted')
})

test('the calibrator holds, steps a joint inside its limits (down from near the top), records until settled, fits, and moves on; abort ends it', () => {
  const joints: JointToFit[] = [{ index: 0, name: 'shoulder', lower: -1, upper: 1 }, { index: 1, name: 'elbow', lower: 0, upper: 2 }]
  assert.ok(within(Calibrator.stepFrom(joints[0], 0), FIT.stepMax, 1e-12), '5 % of 2 rad is 0.1: the cap')
  assert.ok(within(Calibrator.stepFrom(joints[1], 1.95), 1.85, 1e-12), 'near the top: down')
  assert.equal(Calibrator.stepFrom({ index: 0, name: 'x', lower: 0, upper: 0 }, 0), 0, 'no range: no step')
  assert.ok(within(Calibrator.stepFrom({ index: 0, name: 'wheel', lower: null, upper: null }, 3), 3.1, 1e-12))
  const c = new Calibrator(joints)
  // A plant of two first-order joints (τ 150 ms, L 20 ms) that follows the last targets, ticked every 10 ms.
  const q = [0, 1.95], v = [0, 1.95]
  const queue: { at: number; t: number[] }[] = []
  let now = 10_000, lastTargets: number[] | null = null
  let out = c.tick(now, q)
  assert.deepEqual(out.targets, [0, 1.95], 'the hold commands where it stands')
  const sent: number[][] = []
  for (let i = 0; i < 2000 && !c.done; i++) {
    now += 10
    if (out.targets) { queue.push({ at: now + 20, t: out.targets }); sent.push(out.targets) }
    while (queue.length && queue[0].at <= now) lastTargets = queue.shift()!.t
    if (lastTargets) for (let j = 0; j < 2; j++) { v[j] += ((lastTargets[j] - v[j]) / 150) * 10; q[j] = v[j] }
    out = c.tick(now, q)
  }
  assert.ok(c.done)
  assert.ok(out.results && out.results.length === 2)
  const [s, e] = out.results!
  assert.ok('fit' in s && 'fit' in e, JSON.stringify(out.results))
  assert.ok(within(s.fit.timeConstantMs, 150, 0.1, 10), `shoulder τ ${s.fit.timeConstantMs}`)
  assert.ok(within(s.fit.deadTimeMs, 20, 0.5, 15), `shoulder L ${s.fit.deadTimeMs}`)
  assert.ok(within(s.fit.gain, 1, 0.05))
  assert.ok(within(e.fit.y0, 1.95, 1e-6) && e.fit.yEnd < 1.9, 'the elbow stepped down')
  assert.ok(sent.some((t) => within(t[0], 0.1, 1e-9) && within(t[1], 1.95, 1e-9)), 'the shoulder stepped while the elbow was held')
  assert.ok(now - 10_000 < 2 * (FIT.holdMs + FIT.recordMs), 'settled early: well under the full recording')
  const empty = new Calibrator([])
  assert.ok(empty.done && empty.tick(0, []).results?.length === 0)
  const ab = new Calibrator(joints)
  ab.tick(0, [0, 0])
  ab.abort()
  assert.ok(ab.done && ab.current === null)
  assert.deepEqual(ab.tick(1, [0, 0]), { targets: null, results: [] })
})
