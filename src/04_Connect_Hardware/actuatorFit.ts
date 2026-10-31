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
 * Pure: the clock is an argument, nothing is imported, so every fit is proved in Node against a plant of known numbers.
 * What breaks if it is removed? A twin follows a robot with a guessed rate and no delay, and never knows how far off.
 */

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

export type JointResult = { index: number; name: string; fit: StepFit } | { index: number; name: string; error: string }

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
      return this.finish(j, 'error' in fit ? { error: fit.error } : { fit })
    }
    return { targets, results: null }
  }

  private finish(j: JointToFit, r: { fit: StepFit } | { error: string }): { targets: number[] | null; results: readonly JointResult[] | null } {
    this.results.push('fit' in r ? { index: j.index, name: j.name, fit: r.fit } : { index: j.index, name: j.name, error: r.error })
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
