// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the joint bridge's calibration: how the city learns how a real actuator answers,
 * so its twin in the realm answers the same way. Three measurements and one mapping. The round trip: echoes by
 * sequence number, as a ping does, giving the link's delay (half of it one way, an assumption the manual states).
 * The step response: one joint is held, then asked to move a small way inside its limits, and what it does is
 * recorded and fitted as a first-order lag with dead time (the process-control textbook's model: dead time L,
 * time constant τ, gain K; the two-point rule from the 28.3 % and 63.2 % crossings gives the first guess and a
 * bounded search on the squared error refines it). The mapping: the twin's servo (articulated.ts) tracks a filtered
 * setpoint, a first-order lag of the same time constant τ, after a delay buffer has held every setpoint back by a
 * whole number of 60 Hz steps (a delayed actuator, as robot-learning simulators model it). The dead time the step
 * measured was seen across the link, so the link's return trip (the round-trip measurement) is taken out of it: what
 * is left is the actuator's own. It is a latency and response calibration: no load-side stiffness is measured. The
 * calibrator walks the joints one at a time and hands the caller the setpoints to send and, at the end, the gains.
 * The same recording can be fitted a second way (`fitStep2`): a second-order system with dead time (natural rate ω,
 * damping ζ, the closed forms for the under-, critically and over-damped cases), seeded from the first-order fit and
 * refined by the same shrinking search; `pickFit` takes the second-order model only when it lowers the error by a
 * tenth or more, the first otherwise. A second-order fit becomes an `ActuatorShaping`: the reference actuator the
 * twin runs in place of the first-order filter, stepped by `stepShaping` (a spring-damper toward the delayed setpoint
 * with a speed cap, Coulomb friction and a stiction band, integrated so it is stable at 60 Hz for any ω up to 1/h).
 * `randomizeDomain` is the domain randomization robot-learning transfer asks for: from one seed, every link's mass
 * ±20 % and inertia ±30 %, a friction per joint relative to its effort cap, and a jitter on every joint's shaping,
 * all from degrees.ts createRng alone, so a seed is a reproducible world.
 * Pure: the clock is an argument, only the rules' PRNG and the manifest's words are imported, so every fit, step and
 * draw is proved in Node against a plant of known numbers.
 * What breaks if it is removed? A twin follows a robot with a guessed rate and no delay, and never knows how far off.
 */
import { createRng } from '../02_Define_The_Rules/degrees.ts'
import { buildManifest, INERTIA_SCALE, type JointSpec, type Manifest } from './jointState.ts'

/** The realm's step rate the delay is counted in. */
export const BRIDGE_HZ = 60
export const FIT = Object.freeze({
  /** The step: this share of the joint's range, at most this far, at least this far (rad or m) or the joint is skipped. */
  stepShare: 0.05,
  stepMax: 0.1,
  stepMin: 0.001,
  /** Held still before the step, recorded after it, ms. */
  holdMs: 500,
  recordMs: 3000,
  /** Settled: within this share of the total change for this long, ms. */
  settleTol: 0.02,
  settleMs: 300,
  /** A response smaller than this share of the commanded step is no response. */
  minGain: 0.05,
  /** Longest delay the twin will model, steps (half a second). */
  maxDelaySteps: 30,
  /** Round-trip smoothing and how many echoes may be outstanding before the oldest counts as lost. */
  rttAlpha: 0.2,
  rttOutstanding: 64,
} as const)

/** Echoes by sequence number: the link's round trip, smoothed, with its best and its losses. */
export class RoundTrip {
  private readonly sent = new Map<number, number>()
  /** Newest sample, exponential average and the best seen, ms (NaN before the first echo). */
  lastMs = NaN
  meanMs = NaN
  minMs = NaN
  samples = 0
  lost = 0
  /** Records that `seq` left at `now`; the oldest outstanding beyond the bound counts as lost. */
  send(seq: number, now: number): void {
    this.sent.set(seq, now)
    while (this.sent.size > FIT.rttOutstanding) {
      const oldest = this.sent.keys().next().value as number
      this.sent.delete(oldest)
      this.lost++
    }
  }
  /** An echo of `seq` at `now`: the sample, or null for one never sent (or already answered). */
  echo(seq: number, now: number): number | null {
    const at = this.sent.get(seq)
    if (at === undefined) return null
    this.sent.delete(seq)
    const rtt = Math.max(0, now - at)
    this.lastMs = rtt
    this.meanMs = Number.isNaN(this.meanMs) ? rtt : this.meanMs + FIT.rttAlpha * (rtt - this.meanMs)
    this.minMs = Number.isNaN(this.minMs) ? rtt : Math.min(this.minMs, rtt)
    this.samples++
    return rtt
  }
  /** Drops echoes older than `ttlMs` as lost; how many. */
  expire(now: number, ttlMs: number): number {
    let n = 0
    for (const [seq, at] of this.sent) {
      if (now - at > ttlMs) { this.sent.delete(seq); n++ }
    }
    this.lost += n
    return n
  }
  /** One way, under the symmetry assumption: half the smoothed round trip (0 before any echo). */
  get oneWayMs(): number { return Number.isNaN(this.meanMs) ? 0 : this.meanMs / 2 }
  get outstanding(): number { return this.sent.size }
}

/** One reading of the stepped joint: ms since the step was commanded, and its position. */
export interface Sample { t: number; y: number }

/** A first-order lag with dead time: y(t) = y0 + K·Δu·(1 − e^−(t−L)/τ) for t ≥ L. */
export interface StepFit {
  gain: number
  deadTimeMs: number
  timeConstantMs: number
  /** Root-mean-square error of the fit, in the joint's unit. */
  rmse: number
  /** The recording ended within the settle tolerance. */
  settled: boolean
  /** The position before and after. */
  y0: number
  yEnd: number
}

const model = (t: number, y0: number, dy: number, L: number, tau: number): number => (t <= L ? y0 : y0 + dy * (1 - Math.exp(-(t - L) / tau)))

function sse(samples: readonly Sample[], y0: number, dy: number, L: number, tau: number): number {
  let s = 0
  for (const p of samples) {
    const e = p.y - model(p.t, y0, dy, L, tau)
    s += e * e
  }
  return s
}

/** The first time the response crosses `level` of its total change, by linear interpolation; null if it never does. */
function crossing(samples: readonly Sample[], y0: number, dy: number, level: number): number | null {
  for (let i = 1; i < samples.length; i++) {
    const a = (samples[i - 1].y - y0) / dy, b = (samples[i].y - y0) / dy
    if (b >= level) {
      if (a >= level) return samples[i - 1].t
      const f = (level - a) / (b - a)
      return samples[i - 1].t + f * (samples[i].t - samples[i - 1].t)
    }
  }
  return null
}

/**
 * Fits the recording of a step from `u0` to `u1` commanded at t = 0. The samples are in time order; those at t ≤ 0
 * give the start. The two-point rule seeds (τ = 1.5 (t63 − t28), L = t63 − τ), then a shrinking search over L and τ
 * takes the squared error down, the gain solved for each pair.
 */
export function fitStep(samples: readonly Sample[], u0: number, u1: number): StepFit | { error: string } {
  const du = u1 - u0
  if (!(Math.abs(du) > 0)) return { error: 'the commanded step is zero' }
  if (samples.length < 4) return { error: `too few samples (${samples.length})` }
  for (let i = 1; i < samples.length; i++) if (!(samples[i].t >= samples[i - 1].t)) return { error: 'samples out of time order' }
  if (!samples.every((p) => Number.isFinite(p.t) && Number.isFinite(p.y))) return { error: 'a sample is not finite' }
  const before = samples.filter((p) => p.t <= 0)
  const y0 = before.length ? before.reduce((s, p) => s + p.y, 0) / before.length : samples[0].y
  const after = samples.filter((p) => p.t > 0)
  if (after.length < 3) return { error: 'too few samples after the step' }
  const tail = after.slice(Math.max(0, Math.floor(after.length * 0.9)))
  const yEnd = tail.reduce((s, p) => s + p.y, 0) / tail.length
  const dy = yEnd - y0
  if (Math.abs(dy) < FIT.minGain * Math.abs(du)) return { error: `no response: moved ${dy.toPrecision(3)} for a step of ${du.toPrecision(3)}` }
  const span = after[after.length - 1].t
  const settleFrom = after.findIndex((p) => p.t >= span - FIT.settleMs)
  const settled = settleFrom >= 0 && after.slice(settleFrom).every((p) => Math.abs(p.y - yEnd) <= FIT.settleTol * Math.abs(dy))
  const t28 = crossing(after, y0, dy, 0.283), t63 = crossing(after, y0, dy, 0.632)
  if (t28 === null || t63 === null) return { error: 'the response never reaches 63 % of its change' }
  let tau = Math.max(1, 1.5 * (t63 - t28)), L = Math.max(0, t63 - tau)
  // Refine on the squared error: a coordinate search whose step halves each round; the gain is re-solved per pair.
  const gainFor = (l: number, tc: number): number => {
    let num = 0, den = 0
    for (const p of after) {
      const r = model(p.t, 0, 1, l, tc)
      num += r * (p.y - y0)
      den += r * r
    }
    return den > 0 ? num / den : dy
  }
  let bestDy = gainFor(L, tau), best = sse(samples, y0, bestDy, L, tau)
  let stepL = Math.max(1, tau / 2), stepT = tau / 2
  for (let round = 0; round < 24; round++) {
    let moved = false
    for (const [dl, dt] of [[stepL, 0], [-stepL, 0], [0, stepT], [0, -stepT]] as const) {
      const l = Math.max(0, L + dl), tc = Math.max(1, tau + dt)
      const g = gainFor(l, tc)
      const e = sse(samples, y0, g, l, tc)
      if (e < best - 1e-12) { best = e; L = l; tau = tc; bestDy = g; moved = true }
    }
    if (!moved) { stepL /= 2; stepT /= 2 }
    if (stepT < 0.05 && stepL < 0.05) break
  }
  return { gain: bestDy / du, deadTimeMs: L, timeConstantMs: tau, rmse: Math.sqrt(best / samples.length), settled, y0, yEnd }
}

/** What the twin is told: the time constant of its setpoint filter (ms), and how many steps every setpoint is held back. */
export interface TwinGains { tauMs: number; delaySteps: number }

/**
 * The twin's gains from a fit: the filter's time constant is the fitted one, and the delay is the fitted dead time
 * less the link's return trip (the step was timed from the page, so the link is in the measurement twice), as whole
 * steps at `hz`, never below 0 and never above FIT.maxDelaySteps.
 */
export function gainsFor(fit: StepFit, returnTripMs: number, hz: number = BRIDGE_HZ): TwinGains {
  const tauMs = Number.isFinite(fit.timeConstantMs) && fit.timeConstantMs > 0 ? fit.timeConstantMs : 0
  const lag = Number.isFinite(returnTripMs) && returnTripMs > 0 ? fit.deadTimeMs - returnTripMs : fit.deadTimeMs
  const delaySteps = Math.min(FIT.maxDelaySteps, Math.max(0, Math.round(lag * hz / 1000)))
  return { tauMs, delaySteps }
}

// ---- the second-order fit ---------------------------------------------------------------------------------------

export const FIT2 = Object.freeze({
  /** The second-order model is taken only when it lowers the first-order fit's rmse by this share (Occam). */
  occam: 0.1,
  /** A first-order fit already within this share of the response is not improved on: there is nothing left to fit. */
  floor: 0.002,
  /** How many of the best seeds the search descends from (a fit of 300 samples is about 20 ms a start). */
  starts: 4,
  /** The search's bounds: ω in rad/ms (1e-5 is a time constant of 100 s; 10 is a rise faster than any sample), ζ. */
  omegaMin: 1e-5,
  omegaMax: 10,
  zetaMin: 0.05,
  zetaMax: 20,
  /** A damping within this of 1 takes the critically damped form (the over-damped one divides by ζ² − 1 there). */
  criticalBand: 1e-6,
} as const)

/** A second-order system with dead time: y(t) = y0 + K·Δu·s(t − L), s the unit step response of ω, ζ. */
export interface StepFit2 {
  gain: number
  deadTimeMs: number
  /** Natural rate, rad/s, and damping ratio (under 1: overshoot; 1: critical; over 1: two real poles). */
  omega: number
  zeta: number
  rmse: number
  settled: boolean
  y0: number
  yEnd: number
}

/**
 * The unit step response of a second-order system at t (the same unit as 1/ω) for t ≥ 0: the three closed forms.
 * Near ζ = 1 the over-damped form loses digits (its two poles meet), so the critical form takes that band.
 */
export function step2(t: number, omega: number, zeta: number): number {
  if (!(t > 0)) return 0
  const wt = omega * t
  if (Math.abs(zeta - 1) < FIT2.criticalBand) return 1 - Math.exp(-wt) * (1 + wt)
  if (zeta < 1) {
    const d = Math.sqrt(1 - zeta * zeta)
    return 1 - Math.exp(-zeta * wt) * (Math.cos(d * wt) + (zeta / d) * Math.sin(d * wt))
  }
  const s = Math.sqrt(zeta * zeta - 1)
  const p1 = zeta - s, p2 = zeta + s
  return 1 - (p2 * Math.exp(-p1 * wt) - p1 * Math.exp(-p2 * wt)) / (p2 - p1)
}

/**
 * Fits the same recording as `fitStep` with a second-order model. The first-order fit seeds it (ω = 1/τ, ζ = 1, its
 * L; and a critically damped start whose 63.2 % crossing is the first-order fit's); a shrinking coordinate search
 * over (L, ω, ζ), the gain re-solved by least squares at every point, takes the squared error down. ω and ζ move by
 * a factor (their scale is unknown), L by a step; the factor and the step halve when no move helps.
 */
export function fitStep2(samples: readonly Sample[], u0: number, u1: number): StepFit2 | { error: string } {
  const first = fitStep(samples, u0, u1)
  if ('error' in first) return { error: `no second-order fit without a first: ${first.error}` }
  const du = u1 - u0
  const y0 = first.y0
  const after = samples.filter((p) => p.t > 0)
  const gainFor = (l: number, w: number, z: number): number => {
    let num = 0, den = 0
    for (const p of after) {
      const r = step2(p.t - l, w, z)
      num += r * (p.y - y0)
      den += r * r
    }
    return den > 0 ? num / den : first.yEnd - y0
  }
  const sseFor = (l: number, w: number, z: number, dy: number): number => {
    let s = 0
    for (const p of samples) {
      const e = p.y - (y0 + dy * step2(p.t - l, w, z))
      s += e * e
    }
    return s
  }
  const clampW = (w: number): number => Math.min(FIT2.omegaMax, Math.max(FIT2.omegaMin, w))
  const clampZ = (z: number): number => Math.min(FIT2.zetaMax, Math.max(FIT2.zetaMin, z))
  const tau = Math.max(1, first.timeConstantMs), L1 = first.deadTimeMs
  // The seeds: the brief's (ω = 1/τ, ζ = 1 at the first-order delay); critically damped starts that put the 63.2 %
  // crossing (ωt = 2.146) where the first-order fit had it, with the delay partly given back to the rise; and heavily
  // damped starts whose slow pole ω/2ζ is the first-order fit's 1/τ, which answer like the first-order fit itself, so
  // the search never starts worse than the model it must beat.
  type Point = { L: number; omega: number; zeta: number; dy: number; sse: number }
  const at = (l: number, w: number, z: number): Point => {
    const dy = gainFor(l, w, z)
    return { L: l, omega: w, zeta: z, dy, sse: sseFor(l, w, z, dy) }
  }
  const seeds: Point[] = [at(L1, clampW(1 / tau), 1)]
  for (const l of [L1, Math.max(0, L1 - tau / 2), 0]) {
    for (const [w, z] of [[1 / tau, 0.5], [1 / tau, 2], [2.146 / Math.max(1, L1 + tau - l), 1], [2.146 / Math.max(1, L1 + tau - l), 0.5], [3 / tau, 1.5], [6 / tau, 3], [20 / tau, 10]] as const) {
      seeds.push(at(l, clampW(w), clampZ(z)))
    }
  }
  seeds.sort((a, b) => a.sse - b.sse)
  // The descent from one start. Along each axis; along the diagonals of (ω, ζ), since ω and ζ up together keep the
  // slow pole and speed the fast one, a valley the axis moves alone cannot follow; and that diagonal with the delay
  // moved the other way, since a faster fast pole looks like less dead time. The step and the factor halve when no
  // move helps. Several starts (the best seeds) because the valley has local minima the first-order-like end of it.
  const descend = (start: Point): Point => {
    let p = start
    let stepL = Math.max(1, tau / 2), factor = 1.5
    for (let round = 0; round < 60; round++) {
      let moved = false
      const { L, omega, zeta } = p
      const up = clampW(omega * factor), down = clampW(omega / factor), more = clampZ(zeta * factor), less = clampZ(zeta / factor)
      const moves: [number, number, number][] = [
        [L + stepL, omega, zeta], [Math.max(0, L - stepL), omega, zeta],
        [L, up, zeta], [L, down, zeta], [L, omega, more], [L, omega, less],
        [L, up, more], [L, down, less], [L, up, less], [L, down, more],
        [Math.max(0, L - stepL), up, more], [L + stepL, down, less],
      ]
      for (const [l, w, z] of moves) {
        const q = at(l, w, z)
        if (q.sse < p.sse - 1e-14) { p = q; moved = true }
      }
      if (!moved) { stepL /= 2; factor = Math.sqrt(factor) }
      if (stepL < 0.05 && factor < 1.0005) break
    }
    return p
  }
  let best = seeds[0]
  for (const s of seeds.slice(0, FIT2.starts)) {
    const p = descend(s)
    if (p.sse < best.sse) best = p
  }
  return { gain: best.dy / du, deadTimeMs: best.L, omega: best.omega * 1000, zeta: best.zeta, rmse: Math.sqrt(best.sse / samples.length), settled: first.settled, y0, yEnd: first.yEnd }
}

/** Which model the twin takes, and why in a sentence. */
export interface FitChoice { order: 1 | 2; why: string; improvement: number }

/**
 * Occam: the second-order model only when its rmse is at least FIT2.occam (10 %) under the first-order fit's. A
 * second-order fit that failed, a first-order rmse of zero, or one already under FIT2.floor of the response (two
 * tenths of a percent: below any encoder's noise, so a lower rmse there is fitting the recording's arithmetic, not
 * the actuator) keeps the first.
 */
export function pickFit(first: StepFit | { error: string }, second: StepFit2 | { error: string }): FitChoice {
  const pct = (x: number): string => `${Math.round(x * 100)} %`
  if ('error' in second) return { order: 1, why: `first order (the second-order fit failed: ${second.error})`, improvement: 0 }
  if ('error' in first) return { order: 2, why: `second order (the first-order fit failed: ${first.error})`, improvement: 1 }
  if (first.rmse <= FIT2.floor * Math.abs(first.yEnd - first.y0)) return { order: 1, why: `first order: its rmse is already under ${pct(FIT2.floor)} of the response`, improvement: 0 }
  const improvement = first.rmse > 0 ? 1 - second.rmse / first.rmse : 0
  if (improvement >= FIT2.occam) return { order: 2, why: `second order: rmse ${pct(improvement)} lower (Occam asks ${pct(FIT2.occam)})`, improvement }
  return { order: 1, why: `first order: second order lowers the rmse only ${pct(Math.max(0, improvement))} (Occam asks ${pct(FIT2.occam)})`, improvement }
}

// ---- the reference actuator ------------------------------------------------------------------------------------

/**
 * The reference actuator a twin runs in place of its first-order filter (jointRealm.ts, `filter` mode with a
 * shaping): a second-order system the servo then tracks. SI units: rad or m, seconds. The friction terms are the
 * reference's own, per unit of its inertia (the reference has none of its own): Coulomb and stiction are
 * decelerations (rad/s² or m/s²), viscous a rate (1/s). The realm's physical joint friction is a separate thing
 * (JointFriction, in N·m or N): a domain sends friction there and leaves these at 0, so nothing is counted twice.
 */
export interface ActuatorShaping {
  /** Natural rate, rad/s (clamped to 1/h when stepped: 60 rad/s at 60 Hz), and damping ratio (0 or more). */
  omega: number
  zeta: number
  /** Whole realm steps every setpoint is held back. */
  delaySteps: number
  /** The reference settles at gain · setpoint (a step test's response over its command). */
  gain: number
  /** The reference's speed cap, rad/s or m/s. */
  velocityMax: number
  coulomb: number
  viscous: number
  stiction: number
}

export const SHAPING = Object.freeze({
  /**
   * ω·h may not exceed this: ω is clamped to 1/h, 60 rad/s at 60 Hz (a rise faster than the step, which a 60 Hz
   * recording could not have resolved). The stepper is semi-implicit Euler with the damping taken implicitly, run
   * in `substeps` sub-steps: the spring is stable while ω·h_sub < 2 for any ζ ≥ 0 (the Schur conditions on its 2×2
   * update), and at the clamp ω·h_sub = 0.25, where the discrete response is within 2 % of the closed form at ζ = 0.5
   * and within 6 % at ζ = 0.3 (the test pins both).
   */
  omegaStep: 1,
  substeps: 4,
  omegaMax: 60,
  zetaMax: 10,
  gainMin: 0.05,
  gainMax: 10,
  /** A reference moving slower than this is at rest, where stiction can hold it (rad/s or m/s). */
  restRate: 1e-6,
  /** The speed cap a shaping gets when its joint has none. */
  velocityDefault: 100,
} as const)

/** The reference's state: where it stands and how fast it moves. */
export interface ShapingState { x: number; xd: number }

/**
 * One realm step of `h` seconds toward the (already delayed) setpoint `r`, in SHAPING.substeps sub-steps. In each:
 * the spring ω²(gain·r − x) is explicit, the damping 2ζω and the viscous term implicit in the new velocity, so the
 * scheme is stable for ω·h ≤ 1 (ω clamped there) and any ζ ≥ 0. Stiction: at rest, the reference stays until the
 * spring exceeds it. Coulomb: a deceleration toward rest that never crosses it. The speed cap clips the new
 * velocity; the position takes the new velocity. Never NaN: a non-finite field counts as 0.
 */
export function stepShaping(s: ActuatorShaping, st: ShapingState, r: number, h: number): ShapingState {
  const fin = (v: number): number => (Number.isFinite(v) ? v : 0)
  const omega = Math.min(Math.max(0, fin(s.omega)), SHAPING.omegaStep / h)
  const zeta = Math.max(0, fin(s.zeta))
  const damping = 2 * zeta * omega + Math.max(0, fin(s.viscous))
  const coulomb = Math.max(0, fin(s.coulomb)), stiction = Math.max(0, fin(s.stiction))
  const target = fin(s.gain) * fin(r)
  const cap = s.velocityMax > 0 ? s.velocityMax : SHAPING.velocityDefault
  const dt = h / SHAPING.substeps
  for (let k = 0; k < SHAPING.substeps; k++) {
    const spring = omega * omega * (target - st.x)
    if (Math.abs(st.xd) <= SHAPING.restRate && Math.abs(spring) <= stiction) { st.xd = 0; continue }
    let xd = (st.xd + dt * spring) / (1 + dt * damping)
    if (xd > 0) xd = Math.max(0, xd - coulomb * dt)
    else if (xd < 0) xd = Math.min(0, xd + coulomb * dt)
    if (xd > cap) xd = cap
    else if (xd < -cap) xd = -cap
    st.xd = xd
    st.x += xd * dt
  }
  return st
}

/**
 * A second-order fit as the twin's shaping: ω and ζ as fitted (within the stepper's bounds), the gain as fitted
 * (within 0.05..10), the delay as gainsFor counts it (the dead time less the link's return trip, in whole steps),
 * the joint's own speed cap, and no friction of the reference's own.
 */
export function gainsFor2(fit: StepFit2, returnTripMs: number, velocityMax: number, hz: number = BRIDGE_HZ): ActuatorShaping {
  const { delaySteps } = gainsFor({ gain: fit.gain, deadTimeMs: fit.deadTimeMs, timeConstantMs: 0, rmse: fit.rmse, settled: fit.settled, y0: fit.y0, yEnd: fit.yEnd }, returnTripMs, hz)
  const clamp = (v: number, lo: number, hi: number, dflt: number): number => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt)
  return {
    omega: clamp(fit.omega, 1e-3, SHAPING.omegaMax, SHAPING.omegaMax), zeta: clamp(fit.zeta, 0, SHAPING.zetaMax, 1), delaySteps,
    gain: clamp(fit.gain, SHAPING.gainMin, SHAPING.gainMax, 1), velocityMax: Number.isFinite(velocityMax) && velocityMax > 0 ? velocityMax : SHAPING.velocityDefault,
    coulomb: 0, viscous: 0, stiction: 0,
  }
}

// ---- domain randomization ----------------------------------------------------------------------------------------

/** A joint's physical friction in the realm: N·m or N for Coulomb and stiction, N·m·s/rad or N·s/m for viscous. */
export interface JointFriction { coulomb: number; viscous: number; stiction: number }

/**
 * The spread a seed draws from. Mass and inertia are the plan's (±20 %, ±30 %). Friction is relative to each
 * joint's own caps, so one table fits a 6 N·m wrist and a 2 kN table: Coulomb up to 5 % of the effort cap (a geared
 * servo's running friction is a few percent of its rated torque), stiction one to two times the Coulomb level
 * (breakaway sits above running friction and rarely doubles it), and viscous damping that costs at most 10 % of
 * the effort at the joint's speed cap, so the joint can still reach that speed with nine tenths of its torque. The
 * shaping jitter moves ω and ζ by up to a quarter, the gain by 2 % and the delay by up to one extra step; a joint
 * with no fitted shaping starts from the nominal (a 20 rad/s critically damped servo: a rise of about 0.1 s).
 */
export const DOMAIN = Object.freeze({
  mass: 0.2,
  inertia: 0.3,
  /** Shares of the effort cap. */
  coulomb: Object.freeze([0, 0.05]) as readonly [number, number],
  /** Share of the effort cap spent at the velocity cap. */
  viscous: Object.freeze([0, 0.1]) as readonly [number, number],
  /** Times the Coulomb level. */
  stiction: Object.freeze([1, 2]) as readonly [number, number],
  shaping: Object.freeze({ omega: 0.25, zeta: 0.25, delaySteps: 1, gain: 0.02, nominal: Object.freeze({ omega: 20, zeta: 1, delaySteps: 0, gain: 1 }) }),
  /** The caps a joint without any gets (articulated.ts ROBOT.defaultEffort and defaultVelocity say the same). */
  capDefault: Object.freeze({ effort: 10, velocity: 10 }),
} as const)

export interface DomainFactor { link: string; mass: number; inertia: number }
export interface Domain {
  seed: number
  /** The manifest with every link's mass and inertiaScale scaled (a link of no mass keeps none: the realm's default). */
  manifest: Manifest
  factors: DomainFactor[]
  /** Per movable joint, in q order. */
  friction: JointFriction[]
  shaping: ActuatorShaping[]
}

/** The caps a joint carries, or the defaults for one without. */
const capsOf = (j: JointSpec): { effort: number; velocity: number } => ({ effort: j.effort > 0 ? j.effort : DOMAIN.capDefault.effort, velocity: j.velocity > 0 ? j.velocity : DOMAIN.capDefault.velocity })

/** The shaping a joint starts from when nothing was fitted: the nominal servo at the joint's own speed cap. */
export function nominalShaping(j: JointSpec): ActuatorShaping {
  const n = DOMAIN.shaping.nominal
  return { omega: n.omega, zeta: n.zeta, delaySteps: n.delaySteps, gain: n.gain, velocityMax: capsOf(j).velocity, coulomb: 0, viscous: 0, stiction: 0 }
}

/**
 * One seed, one world: the manifest's masses and inertia scales, a friction per movable joint and a shaping per
 * movable joint (jittered from `base[i]` when given, else the nominal), drawn in a fixed order from createRng(seed)
 * and nothing else, so the same seed gives the same domain on any machine. The manifest goes back through
 * buildManifest, so the copy is as judged as the original (a scale is clamped into the manifest's bounds).
 */
export function randomizeDomain(seed: number, m: Manifest, base: readonly (ActuatorShaping | null)[] | null = null): Domain {
  const rng = createRng(seed)
  const span = (lo: number, hi: number): number => lo + (hi - lo) * rng()
  const about = (jitter: number): number => span(1 - jitter, 1 + jitter)
  const factors: DomainFactor[] = []
  const links = m.links.map((l) => {
    const fm = about(DOMAIN.mass), fi = about(DOMAIN.inertia)
    factors.push({ link: l.name, mass: fm, inertia: fi })
    const inertiaScale = Math.min(INERTIA_SCALE.max, Math.max(INERTIA_SCALE.min, (l.inertiaScale ?? 1) * fi))
    return { ...l, mass: l.mass > 0 ? l.mass * fm : 0, inertiaScale }
  })
  const friction: JointFriction[] = []
  const shaping: ActuatorShaping[] = []
  m.movable.forEach((ji, i) => {
    const j = m.joints[ji]
    const { effort, velocity } = capsOf(j)
    const coulomb = effort * span(DOMAIN.coulomb[0], DOMAIN.coulomb[1])
    const viscous = (effort / velocity) * span(DOMAIN.viscous[0], DOMAIN.viscous[1])
    const stiction = coulomb * span(DOMAIN.stiction[0], DOMAIN.stiction[1])
    friction.push({ coulomb, viscous, stiction })
    const b = base?.[i] ?? nominalShaping(j)
    const s = DOMAIN.shaping
    shaping.push({
      omega: Math.min(SHAPING.omegaMax, Math.max(1e-3, b.omega * about(s.omega))),
      zeta: Math.min(SHAPING.zetaMax, Math.max(0, b.zeta * about(s.zeta))),
      delaySteps: Math.min(FIT.maxDelaySteps, b.delaySteps + Math.floor(span(0, s.delaySteps + 1))),
      gain: Math.min(SHAPING.gainMax, Math.max(SHAPING.gainMin, b.gain * about(s.gain))),
      velocityMax: b.velocityMax > 0 ? b.velocityMax : velocity,
      coulomb: 0, viscous: 0, stiction: 0,
    })
  })
  const judged = buildManifest(m.robot, links, m.joints)
  if (!judged.ok) throw new Error(`randomizeDomain: ${judged.reason}`)
  return { seed, manifest: judged.value, factors, friction, shaping }
}

const f3 = (v: number, d = 3): string => (Number.isFinite(v) ? Number(v.toFixed(d)).toString() : 'nan')

/** The console's table of a domain: a header, the links' factors, the joints' friction and shaping. */
export function describeDomain(d: Domain): string[] {
  const m = d.manifest
  const lines = [`domain seed ${d.seed}: mass ±${Math.round(DOMAIN.mass * 100)} %, inertia ±${Math.round(DOMAIN.inertia * 100)} %, friction up to ${Math.round(DOMAIN.coulomb[1] * 100)} % of the effort cap`]
  lines.push(`  ${'LINK'.padEnd(18)}${'MASS'.padEnd(12)}${'INERTIA'.padEnd(10)}KG`)
  d.factors.forEach((f, i) => {
    const l = m.links[i]
    lines.push(`  ${f.link.padEnd(18)}${`×${f3(f.mass, 2)}`.padEnd(12)}${`×${f3(f.inertia, 2)}`.padEnd(10)}${l.mass > 0 ? f3(l.mass) : 'default (unscaled)'}`)
  })
  lines.push(`  ${'JOINT'.padEnd(18)}${'COULOMB'.padEnd(10)}${'VISCOUS'.padEnd(10)}${'STICTION'.padEnd(10)}${'ω'.padEnd(7)}${'ζ'.padEnd(6)}${'DELAY'.padEnd(7)}${'GAIN'.padEnd(6)}VMAX`)
  m.movable.forEach((ji, i) => {
    const j = m.joints[ji], f = d.friction[i], s = d.shaping[i]
    const u = j.kind === 'prismatic' ? 'N' : 'N·m'
    lines.push(`  ${j.name.padEnd(18)}${`${f3(f.coulomb)} ${u}`.padEnd(10)}${`${f3(f.viscous)}`.padEnd(10)}${`${f3(f.stiction)} ${u}`.padEnd(10)}${f3(s.omega, 1).padEnd(7)}${f3(s.zeta, 2).padEnd(6)}${String(s.delaySteps).padEnd(7)}${f3(s.gain, 2).padEnd(6)}${f3(s.velocityMax, 1)}`)
  })
  return lines
}

/** A ring of the last `capacity` values; read(d) is the value pushed d pushes ago (the oldest kept when d is beyond it). */
export class DelayBuffer<T> {
  private readonly ring: (T | undefined)[]
  private head = 0
  private count = 0
  readonly capacity: number
  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity)) + 1
    this.ring = new Array<T | undefined>(this.capacity).fill(undefined)
  }
  push(v: T): void {
    this.ring[this.head] = v
    this.head = (this.head + 1) % this.capacity
    if (this.count < this.capacity) this.count++
  }
  /** The value pushed `delay` pushes ago (0 = the newest); undefined before anything was pushed. */
  read(delay: number): T | undefined {
    if (this.count === 0) return undefined
    const d = Math.min(Math.max(0, Math.floor(delay)), this.count - 1)
    return this.ring[(this.head - 1 - d + this.capacity) % this.capacity]
  }
  clear(): void { this.head = 0; this.count = 0; this.ring.fill(undefined) }
}

/** A joint the calibrator may step: its index in q, its range (null for an unlimited one). */
export interface JointToFit { index: number; name: string; lower: number | null; upper: number | null }

/** A fitted joint carries its recording and the step it answered, so a second fit (fitStep2) can be run on the same data. */
export type JointResult =
  | { index: number; name: string; fit: StepFit; samples: readonly Sample[]; step: { u0: number; u1: number } }
  | { index: number; name: string; error: string }

type Phase = 'hold' | 'step' | 'done'

/**
 * Steps the joints one at a time: holds the robot where it stands, steps one joint a small way inside its limits,
 * records the response, fits it, and moves to the next. tick() takes the clock and the newest frame and gives the
 * targets to send now (the caller passes them through the gate) and, once every joint is done, the results.
 */
export class Calibrator {
  readonly joints: readonly JointToFit[]
  readonly results: JointResult[] = []
  private at = 0
  private phase: Phase = 'hold'
  private phaseStart = NaN
  private hold: number[] | null = null
  private stepTo = 0
  private samples: Sample[] = []
  private aborted = false
  constructor(joints: readonly JointToFit[]) {
    this.joints = joints
    if (joints.length === 0) this.phase = 'done'
  }
  get done(): boolean { return this.phase === 'done' }
  /** Which joint is being fitted now, or null. */
  get current(): JointToFit | null { return this.phase === 'done' ? null : this.joints[this.at] }
  abort(): void { this.aborted = true; this.phase = 'done' }

  /**
   * The step for a joint standing at `q`: a small way toward the farther of its limits, so it never runs at a stop
   * (a continuous joint steps FIT.stepMax, up); `q` itself when the range is too short to resolve a step.
   */
  static stepFrom(j: JointToFit, q: number): number {
    if (j.lower === null || j.upper === null) return q + FIT.stepMax
    const range = j.upper - j.lower
    const d = Math.min(FIT.stepMax, FIT.stepShare * range)
    if (!(d >= FIT.stepMin)) return q
    return j.upper - q >= q - j.lower ? Math.min(j.upper, q + d) : Math.max(j.lower, q - d)
  }

  /** One tick: the positions to command now (null when done), and the results once they are complete. */
  tick(now: number, q: readonly number[]): { targets: number[] | null; results: readonly JointResult[] | null } {
    if (this.phase === 'done') return { targets: null, results: this.results }
    const j = this.joints[this.at]
    if (this.hold === null) { this.hold = [...q]; this.phaseStart = now }
    if (this.phase === 'hold') {
      if (now - this.phaseStart >= FIT.holdMs) {
        this.hold = [...q]
        this.stepTo = Calibrator.stepFrom(j, q[j.index])
        this.phase = 'step'
        this.phaseStart = now
        this.samples = [{ t: 0, y: q[j.index] }]
        if (this.stepTo === q[j.index]) return this.finish(j, { error: 'the joint has no room to step' })
      }
      return { targets: [...this.hold], results: null }
    }
    const t = now - this.phaseStart
    this.samples.push({ t, y: q[j.index] })
    const targets = [...this.hold]
    targets[j.index] = this.stepTo
    const dy = this.stepTo - this.hold[j.index]
    const settledFrom = this.samples.findIndex((p) => p.t >= t - FIT.settleMs)
    const settledNow = t >= 2 * FIT.settleMs && settledFrom > 0
      && this.samples.slice(settledFrom).every((p) => Math.abs(p.y - this.samples[this.samples.length - 1].y) <= FIT.settleTol * Math.abs(dy))
      && Math.abs(this.samples[this.samples.length - 1].y - this.hold[j.index]) > FIT.minGain * Math.abs(dy)
    if (t >= FIT.recordMs || settledNow) {
      const fit = fitStep(this.samples, this.hold[j.index], this.stepTo)
      return this.finish(j, 'error' in fit ? { error: fit.error } : { fit, samples: this.samples, step: { u0: this.hold[j.index], u1: this.stepTo } })
    }
    return { targets, results: null }
  }

  private finish(j: JointToFit, r: { fit: StepFit; samples: readonly Sample[]; step: { u0: number; u1: number } } | { error: string }): { targets: number[] | null; results: readonly JointResult[] | null } {
    this.results.push('fit' in r ? { index: j.index, name: j.name, fit: r.fit, samples: r.samples, step: r.step } : { index: j.index, name: j.name, error: r.error })
    this.at++
    this.hold = null
    this.samples = []
    if (this.at >= this.joints.length || this.aborted) {
      this.phase = 'done'
      return { targets: null, results: this.results }
    }
    this.phase = 'hold'
    return { targets: null, results: null }
  }
}
