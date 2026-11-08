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
import {
  BRIDGE_HZ, Calibrator, DelayBuffer, describeDomain, DOMAIN, FIT, FIT2, fitStep, fitStep2, gainsFor, gainsFor2, nominalShaping, pickFit, randomizeDomain, RoundTrip, SHAPING, step2, stepShaping,
  type ActuatorShaping, type JointToFit, type Sample, type StepFit2,
} from './actuatorFit.ts'
import { buildManifest, type Manifest } from './jointState.ts'

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
  assert.ok('samples' in s && s.samples.length > 10 && s.step.u0 === 0 && within(s.step.u1, 0.1, 1e-9), 'a fitted joint carries its recording and its step')
})

/** A second-order plant with dead time, y'' = ω²(K·u(t − L) − y) − 2ζω y', stepped at 0.5 ms with a sample every `every` ms. */
function sopdt(K: number, Lms: number, omega: number, zeta: number, u0: number, u1: number, o: { every?: number; untilMs?: number; noise?: number } = {}): Sample[] {
  const every = o.every ?? 10, until = o.untilMs ?? 3000
  const samples: Sample[] = [{ t: -every, y: K * u0 }, { t: 0, y: K * u0 }]
  let y = K * u0, v = 0, s = 7
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5 }
  const dt = 0.0005, per = Math.round(every / 1000 / dt)
  for (let k = 1, n = Math.round(until / 1000 / dt); k <= n; k++) {
    const u = (k - 1) * dt > Lms / 1000 ? u1 : u0
    v += (omega * omega * (K * u - y) - 2 * zeta * omega * v) * dt
    y += v * dt
    if (k % per === 0) samples.push({ t: Math.round(k * dt * 1000), y: y + (o.noise ?? 0) * rnd() })
  }
  return samples
}

test('a second-order plant with dead time is fitted back in every damping case, and Occam takes it over the first-order fit', () => {
  for (const [K, L, w, z] of [[1, 50, 2 * Math.PI, 0.5], [1, 0, 10, 1], [1, 100, 3, 0.3], [0.9, 20, 40, 0.7], [1, 30, 6, 1.5]] as const) {
    const s = sopdt(K, L, w, z, 0, 0.1)
    const first = fitStep(s, 0, 0.1), second = fitStep2(s, 0, 0.1)
    assert.ok(!('error' in second), 'error' in second ? second.error : '')
    // An over-damped plant is poorly identifiable: its slow pole, its fast pole and its dead time trade off along a
    // flat valley, so the tolerance is wider there; the fit's error is as small either way.
    const loose = z > 1 ? 5 : 1
    assert.ok(within(second.omega, w, 0.03 * loose), `ω ${second.omega} vs ${w} (ζ ${z})`)
    assert.ok(within(second.zeta, z, 0.05 * loose), `ζ ${second.zeta} vs ${z}`)
    assert.ok(within(second.deadTimeMs, L, 0.05 * loose, 3 * loose), `L ${second.deadTimeMs} vs ${L}`)
    assert.ok(within(second.gain, K, 0.01), `K ${second.gain} vs ${K}`)
    assert.ok(second.rmse < 0.002 * 0.1, `rmse ${second.rmse} on a step of 0.1 (0.2 % of the response is the floor pickFit uses)`)
    assert.equal(second.settled, !('error' in first) && first.settled, 'settled is the recording\'s verdict, shared by both fits (ζ 0.3 at ω 3 is still ringing at 3 s)')
    const pick = pickFit(first, second)
    assert.equal(pick.order, 2, `${JSON.stringify(pick)} for ζ ${z}`)
    assert.ok(pick.improvement > 0.5 && /second order: rmse \d+ % lower/.test(pick.why))
  }
  // Noise of 2 % of the step: the shape still comes back, within wider bounds.
  const noisy = fitStep2(sopdt(1, 50, 2 * Math.PI, 0.5, 0.2, 0.3, { noise: 0.002 }), 0.2, 0.3) as StepFit2
  assert.ok(within(noisy.omega, 2 * Math.PI, 0.08) && within(noisy.zeta, 0.5, 0.2) && within(noisy.deadTimeMs, 50, 0.3, 10), JSON.stringify(noisy))
  // A heavily over-damped plant is a first-order lag with a little more delay: the second-order fit is never worse than the first.
  const over = sopdt(1, 30, 8, 2, 0, 0.1)
  const f1 = fitStep(over, 0, 0.1) as { rmse: number }, f2 = fitStep2(over, 0, 0.1) as StepFit2
  assert.ok(f2.rmse <= f1.rmse * 1.001, `second ${f2.rmse} vs first ${f1.rmse}`)
})

test('a first-order plant keeps the first-order model: the floor on a near-perfect fit, Occam under noise; the errors', () => {
  const clean = fopdt(1, 40, 200, 0, 0.1)
  const c1 = fitStep(clean, 0, 0.1), c2 = fitStep2(clean, 0, 0.1)
  assert.ok(!('error' in c1) && !('error' in c2))
  const cp = pickFit(c1, c2)
  assert.equal(cp.order, 1)
  assert.match(cp.why, /already under 0 % of the response|lowers the rmse only/)
  const noisy = fopdt(1, 40, 200, 0, 0.1, { noise: 0.002 })
  const n1 = fitStep(noisy, 0, 0.1), n2 = fitStep2(noisy, 0, 0.1)
  const np = pickFit(n1, n2)
  assert.equal(np.order, 1, JSON.stringify(np))
  assert.ok(np.improvement < FIT2.occam)
  assert.match(np.why, /first order: second order lowers the rmse only \d+ % \(Occam asks 10 %\)/)
  assert.match((fitStep2(clean, 0.1, 0.1) as { error: string }).error, /no second-order fit without a first: the commanded step is zero/)
  assert.deepEqual(pickFit(c1, { error: 'x' }), { order: 1, why: 'first order (the second-order fit failed: x)', improvement: 0 })
  assert.equal(pickFit({ error: 'y' }, c2).order, 2)
  assert.equal(pickFit({ ...(c1 as Exclude<typeof c1, { error: string }>), rmse: 0 }, c2).order, 1, 'a perfect first-order fit is kept')
})

test('step2: the three closed forms meet at the critical band, start from rest and settle at one', () => {
  for (const w of [0.001, 0.02, 1]) {
    for (const t of [1, 50, 400, 3000]) {
      const crit = step2(t, w, 1)
      assert.ok(Math.abs(step2(t, w, 1 - 1e-7) - crit) < 1e-6 && Math.abs(step2(t, w, 1 + 1e-7) - crit) < 1e-6, `inside the band at ω ${w} t ${t}`)
      assert.ok(Math.abs(step2(t, w, 0.999) - crit) < 2e-3 && Math.abs(step2(t, w, 1.001) - crit) < 2e-3, `either side of 1 at ω ${w} t ${t}`)
    }
  }
  assert.equal(step2(0, 1, 0.5), 0)
  assert.equal(step2(-5, 1, 0.5), 0)
  assert.ok(step2(1e-3, 1, 0.5) < 1e-6, 'from rest: no slope at t = 0')
  for (const z of [0.2, 1, 3]) assert.ok(within(step2(1e4, 0.01, z), 1, 1e-6), `settles at one for ζ ${z}`)
  const peak = Math.max(...Array.from({ length: 2000 }, (_, i) => step2(i * 0.5, 0.02, 0.3)))
  assert.ok(within(peak - 1, Math.exp(-Math.PI * 0.3 / Math.sqrt(1 - 0.09)), 0.01), `ζ 0.3 overshoots ${((peak - 1) * 100).toFixed(1)} % (the textbook's 37 %)`)
})

const plain = (o: Partial<ActuatorShaping> = {}): ActuatorShaping => ({ omega: 10, zeta: 1, delaySteps: 0, gain: 1, velocityMax: 1e9, coulomb: 0, viscous: 0, stiction: 0, ...o })
const H = 1 / 60

test('the reference actuator: near the closed form, bounded at and beyond the ω clamp, its speed capped, held by stiction, stopped short by Coulomb, never NaN', () => {
  const run = (s: ActuatorShaping, steps: number, r = 1): { x: number[]; worst: number } => {
    const st = { x: 0, xd: 0 }, x: number[] = []
    let worst = 0
    for (let i = 1; i <= steps; i++) {
      stepShaping(s, st, r, H)
      x.push(st.x)
      worst = Math.max(worst, Math.abs(st.x - r * s.gain * step2(i * H, Math.min(s.omega, SHAPING.omegaMax), s.zeta)))
    }
    return { x, worst }
  }
  assert.ok(run(plain(), 300).worst < 0.005, 'ω 10 ζ 1: within 0.5 % of the closed form')
  assert.ok(run(plain({ omega: 30, zeta: 0.5 }), 300).worst < 0.02, 'ω 30 ζ 0.5: within 2 %')
  assert.ok(run(plain({ omega: 60, zeta: 0.3 }), 300).worst < 0.06, 'at the clamp, ζ 0.3: within 6 %')
  assert.equal(SHAPING.omegaMax, 1 / H, 'the clamp is 1/h at 60 Hz')
  for (const w of [60, 600, 1e6]) {
    const { x } = run(plain({ omega: w, zeta: 0 }), 10_000)
    assert.ok(x.every((v) => Number.isFinite(v) && Math.abs(v) <= 2.02), `undamped at ω ${w}: bounded (max ${Math.max(...x.map(Math.abs))})`)
  }
  const capped = run(plain({ omega: 60, velocityMax: 1 }), 60).x
  assert.ok(capped[29] <= 0.5 + 1e-9 && capped[29] > 0.45, `a 1 unit step at 1 unit/s is half way at half a second (${capped[29]})`)
  assert.ok(within(run(plain({ gain: 0.8 }), 600).x[599], 0.8, 1e-3), 'the gain scales where it settles')
  // Stiction: a spring under it does not move the reference; over it, it does.
  const held = { x: 0, xd: 0 }
  for (let i = 0; i < 60; i++) stepShaping(plain({ stiction: 2 }), held, 0.01, H)
  assert.deepEqual(held, { x: 0, xd: 0 }, 'ω² · 0.01 = 1 is under a stiction of 2')
  for (let i = 0; i < 60; i++) stepShaping(plain({ stiction: 0.5 }), held, 0.01, H)
  assert.ok(held.x > 0.005, 'over a stiction of 0.5 it moves')
  // Coulomb: a dead band of coulomb / ω² short of the target, never past it.
  const rubbed = run(plain({ coulomb: 5 }), 600).x
  assert.ok(rubbed[599] >= 0.94 && rubbed[599] < 0.97 && rubbed.every((v) => v <= 1), `stops short, within the band of 0.05 and the step's own rounding (${rubbed[599]})`)
  // Viscous damping slows an under-damped reference's overshoot.
  const wet = run(plain({ omega: 10, zeta: 0.2, viscous: 10 }), 300).x, dry = run(plain({ omega: 10, zeta: 0.2 }), 300).x
  assert.ok(Math.max(...wet) < Math.max(...dry), 'viscous: less overshoot')
  const nan = { x: 0.3, xd: 0 }
  stepShaping(plain({ omega: NaN, zeta: NaN, coulomb: NaN, viscous: NaN, stiction: NaN, gain: NaN }), nan, NaN, H)
  assert.ok(Number.isFinite(nan.x) && Number.isFinite(nan.xd), 'non-finite fields count as 0')
})

test('gainsFor2: ω, ζ and the gain within the stepper\'s bounds, the delay as gainsFor counts it, the joint\'s own speed cap, no friction of its own', () => {
  const fit: StepFit2 = { gain: 0.97, deadTimeMs: 60, omega: 14.2, zeta: 0.93, rmse: 0.001, settled: true, y0: 0, yEnd: 0.097 }
  assert.deepEqual(gainsFor2(fit, 10, 4), { omega: 14.2, zeta: 0.93, delaySteps: 3, gain: 0.97, velocityMax: 4, coulomb: 0, viscous: 0, stiction: 0 })
  const wild = gainsFor2({ ...fit, omega: 1e4, zeta: 50, gain: 100 }, 0, 0)
  assert.deepEqual([wild.omega, wild.zeta, wild.gain, wild.velocityMax, wild.delaySteps], [SHAPING.omegaMax, SHAPING.zetaMax, SHAPING.gainMax, SHAPING.velocityDefault, 4])
  assert.equal(gainsFor2({ ...fit, deadTimeMs: 5000 }, 0, 1).delaySteps, FIT.maxDelaySteps)
  assert.equal(gainsFor2({ ...fit, omega: NaN, zeta: NaN, gain: NaN }, 0, 1).omega, SHAPING.omegaMax)
})

/** Two links of mass and one of none; a capped revolute joint and a continuous one without caps. */
function small(): Manifest {
  const m = buildManifest('small', [
    { name: 'base', mass: 4, shape: { kind: 'box', size: [0.2, 0.2, 0.1] } },
    { name: 'arm', mass: 1, shape: { kind: 'capsule', radius: 0.03, length: 0.3 } },
    { name: 'wheel', mass: 0, shape: { kind: 'none' } },
  ], [
    { name: 'shoulder', kind: 'revolute', parent: 'base', child: 'arm', axis: [0, 1, 0], lower: -1, upper: 1, effort: 40, velocity: 3 },
    { name: 'axle', kind: 'continuous', parent: 'base', child: 'wheel', axis: [0, 0, 1] },
  ])
  if (!m.ok) throw new Error(m.reason)
  return m.value
}

test('randomizeDomain: the same seed is the same world, the spreads hold over many seeds, friction follows each joint\'s caps, the shaping jitters about the base or the nominal, the table reads', () => {
  const m = small()
  assert.deepEqual(randomizeDomain(42, m), randomizeDomain(42, m))
  assert.notDeepEqual(randomizeDomain(42, m).factors, randomizeDomain(43, m).factors)
  for (let seed = 0; seed < 300; seed++) {
    const d = randomizeDomain(seed, m)
    assert.equal(d.seed, seed)
    for (const f of d.factors) assert.ok(f.mass >= 1 - DOMAIN.mass && f.mass <= 1 + DOMAIN.mass && f.inertia >= 1 - DOMAIN.inertia && f.inertia <= 1 + DOMAIN.inertia, JSON.stringify(f))
    assert.ok(within(d.manifest.links[0].mass, 4 * d.factors[0].mass, 1e-12) && within(d.manifest.links[1].mass, 1 * d.factors[1].mass, 1e-12))
    assert.equal(d.manifest.links[2].mass, 0, 'a link of no mass keeps none')
    assert.ok(d.manifest.links.every((l, i) => within(l.inertiaScale!, d.factors[i].inertia, 1e-12)))
    assert.deepEqual(d.manifest.joints, m.joints)
    const [sh, ax] = d.friction
    assert.ok(sh.coulomb >= 0 && sh.coulomb <= 0.05 * 40 && sh.stiction >= sh.coulomb && sh.stiction <= 2 * sh.coulomb + 1e-12 && sh.viscous >= 0 && sh.viscous <= 0.1 * 40 / 3 + 1e-12, JSON.stringify(sh))
    assert.ok(ax.coulomb <= 0.05 * DOMAIN.capDefault.effort && ax.viscous <= 0.1 * DOMAIN.capDefault.effort / DOMAIN.capDefault.velocity + 1e-12, 'a joint without caps draws against the defaults')
    const [s0, s1] = d.shaping
    const n = DOMAIN.shaping.nominal
    assert.ok(s0.omega >= n.omega * 0.75 && s0.omega <= n.omega * 1.25 && s0.zeta >= 0.75 && s0.zeta <= 1.25 && (s0.delaySteps === 0 || s0.delaySteps === 1) && s0.gain >= 0.98 && s0.gain <= 1.02, JSON.stringify(s0))
    assert.equal(s0.velocityMax, 3)
    assert.equal(s1.velocityMax, DOMAIN.capDefault.velocity)
    assert.deepEqual([s0.coulomb, s0.viscous, s0.stiction], [0, 0, 0], 'the reference carries no friction of its own: the realm\'s is physical')
  }
  // About a fitted base: ω near 8, ζ near 0.6, the base's delay plus at most one step, its own speed cap kept.
  const base = { omega: 8, zeta: 0.6, delaySteps: 3, gain: 0.95, velocityMax: 2, coulomb: 0, viscous: 0, stiction: 0 }
  const d = randomizeDomain(5, m, [base, null])
  assert.ok(d.shaping[0].omega >= 6 && d.shaping[0].omega <= 10 && d.shaping[0].zeta >= 0.45 && d.shaping[0].zeta <= 0.75 && (d.shaping[0].delaySteps === 3 || d.shaping[0].delaySteps === 4) && d.shaping[0].velocityMax === 2, JSON.stringify(d.shaping[0]))
  assert.deepEqual(nominalShaping(m.joints[1]), { omega: 20, zeta: 1, delaySteps: 0, gain: 1, velocityMax: 10, coulomb: 0, viscous: 0, stiction: 0 })
  // A scale already at the bound stays inside it.
  const heavy = { ...m, links: m.links.map((l) => ({ ...l, inertiaScale: 10 })) } as Manifest
  assert.ok(randomizeDomain(1, heavy).manifest.links.every((l) => l.inertiaScale! <= 10))
  const lines = describeDomain(randomizeDomain(7, m))
  assert.equal(lines.length, 1 + 1 + 3 + 1 + 2)
  assert.match(lines[0], /^domain seed 7: mass ±20 %, inertia ±30 %, friction up to 5 % of the effort cap$/)
  assert.match(lines[1], /^\s+LINK\s+MASS\s+INERTIA\s+KG$/)
  assert.match(lines[2], /^\s+base\s+×[\d.]+\s+×[\d.]+\s+[\d.]+$/)
  assert.match(lines[4], /wheel.*default \(unscaled\)$/)
  assert.match(lines[5], /^\s+JOINT\s+COULOMB\s+VISCOUS\s+STICTION\s+ω\s+ζ\s+DELAY\s+GAIN\s+VMAX$/)
  assert.match(lines[6], /^\s+shoulder\s+[\d.]+ N·m\s+[\d.]+\s+[\d.]+ N·m\s+[\d.]+\s+[\d.]+\s+[01]\s+[\d.]+\s+3$/)
  assert.match(lines[7], /^\s+axle\s+/)
})
