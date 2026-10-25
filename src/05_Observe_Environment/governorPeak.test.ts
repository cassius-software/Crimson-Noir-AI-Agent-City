// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves Peak, the tier above Ultra: who is measured for it, that the governor climbs into
 * it only on the GPU's own timings (under the cinema camera a fast and a slow GPU give the same animation frames), the
 * entry and stay rules, what a failure costs and how often it recurs, the in-page model's hold, the frame budgets, and
 * the readings it refuses. It does this on the frame loop engine.ts runs (vsync, the cinema camera's FramePacer, one
 * timing resolve in flight).
 * What breaks if it is removed? A change could probe Peak on every desktop and judge it by stutter alone, keep a
 * failing Peak cycling, or let junk timings admit it, silently.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  Governor, PEAK, PEAK_GOV, PEAK_TIER, TIERS, peakCandidate, profileDevice, tierRange, type DeviceHints,
} from './governor.ts'
import { holdTier } from '../09_Cognition/inPagePlan.ts'
import { CINEMA, FramePacer } from '../07_Execute_Actions/cinema.ts'

// ---------------------------------------------------------------------------------------------------
// Machines, as the page's globals describe them

const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
/** Safari on an iPad, which asks for the desktop site: a Mac user agent (the touch points tell it apart). */
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'

/** A 16-thread Windows desktop with 8 GB reported (Chromium caps deviceMemory at 8) and a 1080p screen. */
const base: DeviceHints = { adapter: '', userAgent: WIN, mobileHint: false, maxTouchPoints: 0, coarsePointer: false, cores: 16, memoryGb: 8, screenPixels: 1920 * 1080 }
const RTX_5090: DeviceHints = { ...base, adapter: 'nvidia / blackwell / NVIDIA GeForce RTX 5090' }
const IPAD: DeviceHints = { ...base, adapter: 'apple / metal-3', userAgent: MAC_SAFARI, memoryGb: undefined, maxTouchPoints: 5, coarsePointer: true }
const MALI: DeviceHints = { ...base, adapter: 'arm / bifrost', userAgent: ANDROID, memoryGb: 4, maxTouchPoints: 5, coarsePointer: true }

interface Url {
  /** ?quality: a pinned tier (absent: auto). */
  quality?: number
  /** ?fps: the frame the governor holds. */
  fps?: number
  /** ?cinema=0 turns the camera off. */
  cinema?: boolean
  /** ?peak=1|0. */
  peak?: boolean
  /** ?lite=1|0. */
  lite?: boolean
  /** Whether three writes GPU timestamps (Gpu.timestamps); true unless a test says. */
  timestamps?: boolean
}

/** Engine.create's quality set-up, step for step: the profile, the Peak candidacy where three writes timestamps, the
 *  range, ?fps, the camera unless ?cinema=0, and ?quality pinning a tier. */
function boot(h: DeviceHints, url: Url = {}) {
  const profile = profileDevice(h, url.lite)
  const peak = (url.timestamps ?? true) && peakCandidate(h, profile, url.peak)
  const range = tierRange(profile, peak)
  const targetMs = url.fps !== undefined && url.fps > 0 ? 1000 / url.fps : undefined
  const pacerMs = url.cinema === false ? undefined : 1000 / CINEMA.fps
  const governor = new Governor({ tier: url.quality ?? profile.startTier, auto: url.quality === undefined, targetMs, pacerMs, ...range })
  return { profile, peak, governor }
}

// ---------------------------------------------------------------------------------------------------
// The frame loop

const hz = (rate: number) => 1000 / rate
/** A frame that costs `cost` ms waits for the next vsync of a `rate` Hz display. */
const vsync = (rate: number, cost: number) => Math.max(1, Math.ceil(cost / hz(rate) - 1e-9)) * hz(rate)
/** Seeded uniform [0, 1). */
const lcg = (seed: number) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps
/** An animation frame the cinema camera does not draw, ms. */
const IDLE = 2.5
/** rAF timestamps sit on the vsync grid give or take this much, ms (deterministic). */
const JITTER = 0.5

interface Load {
  /** The display's refresh, Hz. */
  hz: number
  /** A drawn frame's GPU render time at a tier, ms, `t` seconds in: called exactly once per drawn frame. */
  gpu: (tier: number, t: number) => number
  /** A drawn frame's processor time, ms (default 6), or one per tier: the frame waits for the longer of the two. */
  cpu?: number | ((tier: number) => number)
  /** The camera's k-th drawn frame missed its slot: drawn, but not presented. */
  missed?: (k: number, tier: number) => boolean
}

/** GPU render times per tier (Minimal…Ultra, Peak), ±5 % of deterministic noise per frame. */
function table(costs: readonly number[], seed: number): (tier: number) => number {
  const rnd = lcg(seed)
  return (tier) => costs[tier] * (1 + 0.05 * (2 * rnd() - 1))
}
const FAST = [1.2, 1.5, 1.9, 2.4, 3.0, 6.5] as const
const SLOW = [3, 4, 5, 6.5, 8.0, 18] as const
const MARGINAL = [1.5, 2, 2.6, 3.4, 4.5, 15] as const
const at60 = (costs: readonly number[], seed = 7): Load => ({ hz: 60, gpu: table(costs, seed) })

interface Change { t: number; from: number; tier: number; reason: string }

/**
 * The frame loop as engine.ts runs it: every animation frame feeds sample() its rAF interval; under the cinema camera
 * the FramePacer decides which frames are drawn (without it every frame is), and each drawn one is presented unless the
 * load says the camera missed it. A drawn frame's next rAF waits for the longer of its processor and GPU time (whole
 * refreshes), an undrawn one costs IDLE. The GPU feed is the engine's one timing resolve in flight: a drawn frame lands
 * the reading started two drawn frames before (gpuSample), then starts one for itself while the governor wants it.
 */
class Loop {
  readonly g: Governor
  readonly changes: Change[] = []
  /** Every reading the feed passed to gpuSample, ms. */
  readonly fed: number[] = []
  private readonly samples: { t: number; ms: number; tier: number }[] = []
  private readonly pacer: FramePacer | null
  private readonly feed: boolean
  private readonly rnd = lcg(29)
  private readonly start = 1000
  private now = 1000
  private offset = 0
  private nextMs = Number.NaN
  /** The tier that drew the frame the next interval waits on. */
  private costTier: number
  /** Drawn frames so far. */
  private k = 0
  private inFlight: { ms: number; landsAt: number } | null = null
  private last: number

  constructor(g: Governor, opts: { feed?: boolean } = {}) {
    this.g = g
    this.feed = opts.feed ?? true
    this.last = this.costTier = g.tier
    this.pacer = g.pacer ? new FramePacer(CINEMA.fps) : null
  }

  /** Seconds since the loop began. */
  get t(): number { return (this.now - this.start) / 1000 }
  /** The clock sample() was last fed. */
  get nowMs(): number { return this.now }
  /** The tiers it went through, in order. */
  get path(): number[] { return this.changes.map((c) => c.tier) }

  /** Every sample() interval before `seconds`, ms. */
  intervals(seconds: number): number[] { return this.samples.filter((s) => s.t < seconds).map((s) => s.ms) }
  /** Every sample() interval a frame drawn at `tier` set, ms. */
  intervalsAt(tier: number): number[] { return this.samples.filter((s) => s.tier === tier).map((s) => s.ms) }

  run(seconds: number, load: Load): this { return this.until(() => false, seconds, load) }

  /** Runs for `seconds`, or until `done()` holds after a frame. */
  until(done: () => boolean, seconds: number, load: Load): this {
    const end = this.now + seconds * 1000
    if (Number.isNaN(this.nextMs)) this.nextMs = hz(load.hz)
    while (this.now < end) {
      const ms = this.nextMs
      this.now += ms
      this.samples.push({ t: this.t, ms, tier: this.costTier })
      const r = this.g.sample(ms, this.now)
      if (r !== null) {
        this.changes.push({ t: this.t, from: this.last, tier: r, reason: this.g.reason })
        this.last = r
      }
      let cost = IDLE
      if (this.pacer === null || this.pacer.tick(this.now)) {
        const k = this.k++
        const tier = this.g.tier
        if (this.pacer !== null && !(load.missed?.(k, tier) ?? false)) this.g.present(this.now)
        const gpu = load.gpu(tier, this.t)
        if (this.feed) {
          if (this.inFlight !== null && k >= this.inFlight.landsAt) {
            this.fed.push(this.inFlight.ms)
            this.g.gpuSample(this.inFlight.ms, this.now)
            this.inFlight = null
          }
          if (this.g.wantsGpu && this.inFlight === null) this.inFlight = { ms: gpu, landsAt: k + 2 }
        }
        cost = Math.max(typeof load.cpu === 'function' ? load.cpu(tier) : load.cpu ?? 6, gpu)
      }
      this.costTier = this.g.tier
      const jitter = JITTER * (2 * this.rnd() - 1)
      this.nextMs = vsync(load.hz, cost) + jitter - this.offset
      this.offset = jitter
      if (done()) break
    }
    return this
  }
}

/** The candidate's Peak state, which every test on a Peak range expects to be there. */
function peakOf(g: Governor): { gpuMs: number | null; limitMs: number; off: boolean } {
  const p = g.state().peak
  assert.ok(p !== undefined, 'a Peak range shows the Peak rule')
  return p
}

/** Feeds `ms` `n` times, every one stamped at the last sample()'s time. */
function feedAt(loop: Loop, ms: number, n: number): void {
  for (let i = 0; i < n; i++) loop.g.gpuSample(ms, loop.nowMs)
}

/** A loop booted from the RTX 5090 for a misjudged Peak (MARGINAL): Ultra's p90 under the entry limit, Peak's median
 *  over the stay limit. */
const marginal = () => new Loop(boot(RTX_5090).governor)

/** Peak always 15 ms; Ultra 2.0 ms, then 1.0 from 30 s, then 0.6 from 150 s: each step under the last tightened limit. */
function threeLosses(seconds: number): Loop {
  const load: Load = { hz: 60, gpu: (tier, t) => tier === PEAK_TIER ? 15 : tier === 4 ? (t < 30 ? 2.0 : t < 150 ? 1.0 : 0.6) : 1 }
  return new Loop(boot(RTX_5090).governor).run(seconds, load)
}

const DISCRETE = { mobile: false, lite: false, gpuClass: 'discrete' } as const

// ---------------------------------------------------------------------------------------------------
// Who is measured for Peak

test('peak: candidacy over the adapter table; every start tier and gpuClass as before, none of them Peak', () => {
  const rows: [string, Partial<DeviceHints>, string, number, boolean][] = [
    ['nvidia / lovelace', {}, 'discrete', 4, true],
    ['amd / rdna-3', {}, 'discrete', 3, true],
    ['amd / rdna-2', {}, 'discrete', 3, true],
    ['amd / rdna-3 / AMD Radeon RX 7900 XTX', {}, 'discrete', 4, true],
    ['amd / rdna-4 / AMD Radeon RX 9070 XT', { userAgent: LINUX }, 'discrete', 4, true],
    ['nvidia', { userAgent: LINUX, cores: 32 }, 'discrete', 3, true],
    ['nvidia / blackwell / NVIDIA GeForce RTX 5090', {}, 'discrete', 4, true],
    ['nvidia / pascal', {}, 'discrete', 3, true],
    ['apple / metal-3', { userAgent: MAC, cores: 12 }, 'integrated', 3, true],
    ['apple / metal-3', { userAgent: MAC_SAFARI, memoryGb: undefined, maxTouchPoints: 5, coarsePointer: true }, 'mobile', 1, false],
    ['google / swiftshader', { userAgent: LINUX }, 'unknown', 0, false],
    ['amd / rdna-3 / AMD Radeon 780M Graphics', {}, 'integrated', 2, false],
    ['nvidia / ampere', { cores: 4 }, 'discrete', 3, false],
    ['nvidia / lovelace', { memoryGb: 4 }, 'discrete', 3, false],
    ['intel / xe-lpg', {}, 'integrated', 2, false],
    ['arm / bifrost', { userAgent: ANDROID, memoryGb: 4, maxTouchPoints: 5, coarsePointer: true }, 'mobile', -1, false],
  ]
  for (const [adapter, overrides, gpuClass, start, candidate] of rows) {
    const h: DeviceHints = { ...base, adapter, ...overrides }
    const p = profileDevice(h)
    const label = `${adapter} ${JSON.stringify(overrides)}`
    assert.equal(p.gpuClass, gpuClass, label)
    assert.equal(p.startTier, start, label)
    assert.equal(peakCandidate(h, p), candidate, label)
    assert.ok(p.startTier <= TIERS.length - 1, `${label}: no profile starts on Peak`)
  }
  assert.equal(profileDevice(MALI).lite, true, 'the Mali row is the lite profile')
})

test('peak: ?peak=1 makes any desktop-class profile a candidate and ?peak=0 none; never a phone or a lite profile', () => {
  for (const [adapter, overrides] of [
    ['google / swiftshader', { userAgent: LINUX }],
    ['amd / rdna-3 / AMD Radeon 780M Graphics', {}],
    ['intel / xe-lpg', {}],
    ['nvidia / ampere', { cores: 4 }],
    ['nvidia / lovelace', { memoryGb: 4 }],
  ] as const) {
    const h: DeviceHints = { ...base, adapter, ...overrides }
    assert.equal(peakCandidate(h, profileDevice(h)), false, `${adapter}: not by itself`)
    assert.equal(peakCandidate(h, profileDevice(h), true), true, `${adapter} with ?peak=1`)
  }
  assert.equal(peakCandidate(IPAD, profileDevice(IPAD), true), false, 'an iPad, whatever ?peak says')
  assert.equal(peakCandidate(MALI, profileDevice(MALI), true), false, 'a lite phone, whatever ?peak says')
  assert.equal(peakCandidate(MALI, profileDevice(MALI, false), true), false, 'a phone off the lite profile is still a phone')
  assert.equal(peakCandidate(RTX_5090, profileDevice(RTX_5090), false), false, 'the biggest card with ?peak=0')
  assert.equal(peakCandidate(base, profileDevice(base, true), true), false, '?lite=1 on a desktop: a lite profile')
})

test('peak: tierRange reaches Peak only for a candidate; every one-argument range is unchanged', () => {
  const p = profileDevice(RTX_5090)
  assert.deepEqual(tierRange(p), { min: 0, max: 4 })
  assert.deepEqual(tierRange(p, false), { min: 0, max: 4 })
  assert.deepEqual(tierRange(p, true), { min: 0, max: PEAK_TIER })
  assert.deepEqual(tierRange(profileDevice(IPAD), true), { min: 0, max: 2 })
  assert.deepEqual(tierRange(profileDevice(MALI), true), { min: -1, max: 0 })
  // Without timestamps the candidate's range is the one it always had.
  assert.equal(boot(RTX_5090, { timestamps: false }).peak, false)
  assert.equal(boot(RTX_5090).peak, true)
})

// ---------------------------------------------------------------------------------------------------
// The climb, on the GPU's own timings

test('peak: vsync blindness: a 3 ms and an 8 ms Ultra give the same animation frames, and only the fast one takes Peak', () => {
  const fast = new Loop(boot(RTX_5090).governor), slow = new Loop(boot(RTX_5090).governor)
  fast.run(5, at60(FAST, 13))
  slow.run(5, at60(SLOW, 13))
  assert.equal(fast.g.pacer && slow.g.pacer, true, 'the cinema camera runs')
  assert.ok(fast.intervals(5).length > 250)
  assert.deepEqual(fast.intervals(5), slow.intervals(5), 'the frame rate cannot tell them apart')
  fast.run(595, at60(FAST, 13))
  slow.run(595, at60(SLOW, 13))
  assert.deepEqual(fast.path, [5], JSON.stringify(fast.changes))
  assert.deepEqual(slow.path, [], JSON.stringify(slow.changes))
})

test('peak: a fast desktop probes into Peak once calm and holds it for 10 minutes', () => {
  const loop = new Loop(boot(RTX_5090).governor).run(600, at60(FAST))
  assert.equal(loop.changes.length, 1, JSON.stringify(loop.changes))
  const [c] = loop.changes
  assert.equal(c.tier, 5)
  assert.equal(c.reason, 'probe')
  assert.ok(c.t >= 5.5 && c.t <= 7.5, `Peak at ${c.t.toFixed(2)} s`)
  assert.equal(loop.g.knobs(), PEAK)
})

test('peak: no timings, no climb: a range that reaches Peak without readings stays on Ultra for 10 minutes', () => {
  const g = new Governor({ tier: 4, auto: true, pacerMs: 1000 / CINEMA.fps, min: 0, max: PEAK_TIER })
  const loop = new Loop(g, { feed: false }).run(600, at60(FAST))
  assert.deepEqual(loop.changes, [])
  assert.equal(g.tier, 4)
  assert.equal(peakOf(g).gpuMs, null)
})

test('peak: entry reads the p90: Ultra slow in one frame in seven never probes; slow in one in twenty-one does', () => {
  // The feed samples every second drawn frame, so an odd period puts its slow frames on 1 reading in `period`.
  const slowEvery = (period: number): Load => {
    let calls = 0
    return { hz: 60, gpu: (tier) => (calls++ % period === 0 ? 9 : tier === PEAK_TIER ? 6.5 : 3) }
  }
  const share = (loop: Loop) => loop.fed.filter((ms) => ms === 9).length / loop.fed.length
  const seven = new Loop(boot(RTX_5090).governor).run(120, slowEvery(7))
  assert.deepEqual(seven.changes, [], `1 in 7 slow keeps Ultra: ${JSON.stringify(seven.changes)}`)
  assert.ok(share(seven) >= 0.13 && share(seven) <= 0.16, `1 in 7: ${share(seven).toFixed(3)} of the readings slow`)
  const twentyOne = new Loop(boot(RTX_5090).governor).run(120, slowEvery(21))
  assert.equal(twentyOne.changes[0]?.tier, 5, JSON.stringify(twentyOne.changes))
  assert.ok(twentyOne.changes[0].t <= 10, `Peak at ${twentyOne.changes[0].t.toFixed(2)} s`)
  assert.ok(share(twentyOne) >= 0.04 && share(twentyOne) <= 0.06, `1 in 21: ${share(twentyOne).toFixed(3)} of the readings slow`)
})

test('peak: stay reads the median: one heavy frame in five at Peak does not step down', () => {
  const loop = new Loop(boot(RTX_5090).governor)
  loop.until(() => loop.g.tier === 5, 30, at60(FAST))
  assert.equal(loop.g.tier, 5)
  const arrived = loop.changes.length
  let calls = 0
  loop.run(120, { hz: 60, gpu: (tier) => (calls++ % 5 === 0 ? 15 : tier === PEAK_TIER ? 6 : 3) })
  assert.equal(loop.changes.length, arrived, JSON.stringify(loop.changes))
  assert.equal(loop.g.tier, 5)
  assert.ok(loop.fed.slice(-100).filter((ms) => ms === 15).length >= 15, 'heavy frames were fed')
})

// ---------------------------------------------------------------------------------------------------
// What a failure costs

test('peak: a misjudged probe steps down with gpu busy within 4 s, tightens the entry to 0.75 of its p90, and never recurs at that load', () => {
  const loop = marginal()
  const load = at60(MARGINAL)
  loop.until(() => loop.g.tier === 5, 30, load)
  const arrived = loop.changes.at(-1)
  assert.ok(arrived !== undefined && arrived.tier === 5 && arrived.reason === 'probe', JSON.stringify(loop.changes))
  loop.until(() => loop.g.tier === 4, 30, load)
  const down = loop.changes.at(-1)
  assert.ok(down !== undefined && down.tier === 4, JSON.stringify(loop.changes))
  assert.equal(down.reason, 'gpu busy')
  assert.ok(down.t - arrived.t <= 4.0, `down ${(down.t - arrived.t).toFixed(2)} s after it arrived`)
  const limit = peakOf(loop.g).limitMs
  assert.ok(limit >= 0.75 * 4.5 * 0.95 && limit <= 0.75 * 4.5 * 1.05, `entry limit ${limit.toFixed(3)} ms`)
  loop.run(1800 - loop.t, load)
  assert.deepEqual(loop.path.slice(0, 2), [5, 4])
  assert.equal(loop.path.filter((t) => t === 5).length, 1, JSON.stringify(loop.changes))
  const late = loop.intervalsAt(5).filter((ms) => ms > hz(60) + 2 * JITTER + 1e-9)
  assert.deepEqual(late, [], 'no frame was late at Peak: only its GPU time told')
})

test('peak: frames below 60 at Peak and the camera behind are losses too', () => {
  // (a) Peak's render passes inside the stay share, but its frames slip: the rest of a refresh (the crowd's compute, the
  // frame's encoding) is not in the reading. The frame rule takes it down, and it is a failed probe like any other.
  const slip = new Loop(boot(RTX_5090).governor).run(60, { ...at60(FAST), cpu: (tier) => (tier === PEAK_TIER ? 18 : 6) })
  assert.deepEqual(slip.path.slice(0, 2), [5, 4], JSON.stringify(slip.changes))
  assert.equal(slip.changes[1].reason, 'frames below 60 FPS')
  assert.ok(peakOf(slip.g).limitMs < 5.0, `tightened: ${peakOf(slip.g).limitMs.toFixed(3)} ms`)
  // Peak at 18 ms on the GPU slips its frames too, but its own rule reads that first: its window needs 2 s of readings,
  // the frame rule's oldest slice a little more.
  const heavy = new Loop(boot(RTX_5090).governor).run(60, at60([1.2, 1.5, 1.9, 2.4, 3.0, 18]))
  assert.deepEqual(heavy.path.slice(0, 2), [5, 4], JSON.stringify(heavy.changes))
  assert.equal(heavy.changes[1].reason, 'gpu busy')
  assert.ok(peakOf(heavy.g).limitMs < 5.0)
  // (b) The camera behind at Peak (one of its frames in four missed), the animation frames and the GPU time fine.
  const cam = new Loop(boot(RTX_5090).governor).run(60, { ...at60(FAST), missed: (k, tier) => tier === PEAK_TIER && k % 4 === 0 })
  assert.deepEqual(cam.path.slice(0, 2), [5, 4], JSON.stringify(cam.changes))
  assert.equal(cam.changes[1].reason, 'camera behind')
  assert.ok(peakOf(cam.g).limitMs < 5.0, `tightened: ${peakOf(cam.g).limitMs.toFixed(3)} ms`)
})

test('peak: heat after 100 s: one gpu busy step down, no tightening, and Peak back after the load ends', () => {
  const fast = table(FAST, 7)
  const loop = new Loop(boot(RTX_5090).governor)
  const load: Load = { hz: 60, gpu: (tier, t) => (t >= 100 && t < 160 ? (tier === PEAK_TIER ? 15 : 7) : fast(tier)) }
  loop.run(130, load)
  assert.ok(near(peakOf(loop.g).limitMs, 1000 / 60 * 0.3), `untightened at 130 s: ${peakOf(loop.g).limitMs} ms`)
  loop.run(470, load)
  const c = loop.changes
  assert.equal(c.length, 3, JSON.stringify(c))
  assert.ok(c[0].tier === 5 && c[0].reason === 'probe' && c[0].t >= 5.5 && c[0].t <= 7.5, JSON.stringify(c[0]))
  assert.ok(c[1].tier === 4 && c[1].reason === 'gpu busy' && c[1].t >= 100 && c[1].t <= 103, JSON.stringify(c[1]))
  assert.ok(c[2].tier === 5 && c[2].reason === 'probe' && c[2].t >= 160 && c[2].t <= 170, JSON.stringify(c[2]))
})

test('peak: the third loss in a visit turns Peak off until reload, even for setAuto after a manual Peak', () => {
  const loop = threeLosses(600)
  const ups = loop.changes.filter((c) => c.tier === 5)
  assert.equal(ups.length, 3, JSON.stringify(loop.changes))
  assert.ok(ups.every((c) => c.reason === 'probe'))
  assert.equal(peakOf(loop.g).off, true)
  assert.equal(loop.g.wantsGpu, false)
  assert.equal(loop.g.tier, 4)
  loop.g.setTier(5)
  assert.equal(loop.g.tier, 5, 'a manual Peak is still the operator\'s')
  loop.g.setAuto(true)
  assert.equal(loop.g.tier, 4, 'auto stops at Ultra once Peak is off')
})

// ---------------------------------------------------------------------------------------------------
// The in-page model's hold

test('peak: the in-page model\'s hold on the GPU lowers Peak to Ultra; the release keeps Ultra and Peak is earned back after a quiet 40, 80, 160 and 300 s; holds are never losses', () => {
  const cap = holdTier(DISCRETE, true)
  assert.equal(cap, TIERS.length - 1)
  if (cap === null) return
  const loop = new Loop(boot(RTX_5090).governor)
  const g = loop.g
  const fast = at60(FAST)
  const to = (t: number, load: Load = fast) => loop.run(t - loop.t, load)
  to(30)
  assert.equal(g.tier, 5, 'at Peak before the first hold')
  g.hold(cap, loop.nowMs)
  assert.equal(g.tier, 4)
  assert.equal(g.reason, 'held')
  assert.equal(g.state().held, 4)
  assert.equal(g.wantsGpu, false)
  to(60, { hz: 60, gpu: (tier) => (tier === 4 ? 15 : FAST[tier]) })
  g.hold(null, loop.nowMs)
  assert.equal(g.tier, 4, 'the release keeps Ultra')
  assert.equal(g.state().held, undefined)
  assert.equal(peakOf(g).off, false)
  /** The release at `release` s left Ultra in place, and the next change was the probe back to Peak, in [lo, hi] s. */
  const backAfter = (release: number, from: number, lo: number, hi: number) => {
    const after = loop.changes.slice(from)
    assert.equal(after.length, 1, `after the release at ${release} s: ${JSON.stringify(after)}`)
    const [next] = after
    assert.ok(next.tier === 5 && next.reason === 'probe', JSON.stringify(next))
    assert.ok(next.t >= lo && next.t <= hi, `Peak back at ${next.t.toFixed(2)} s, not in [${lo}, ${hi}]`)
  }
  let from = loop.changes.length
  to(102)
  backAfter(60, from, 100, 101.5)
  for (const [hold, release, lo, hi, until] of [[110, 120, 200, 201.5, 205], [210, 220, 380, 381.5, 385], [390, 400, 700, 701.5, 705]] as const) {
    to(hold)
    assert.equal(g.tier, 5, `at Peak before the hold at ${hold} s`)
    g.hold(cap, loop.nowMs)
    assert.equal(g.tier, 4)
    to(release)
    from = loop.changes.length
    g.hold(null, loop.nowMs)
    assert.equal(g.tier, 4)
    assert.equal(peakOf(g).off, false)
    to(until)
    backAfter(release, from, lo, hi)
  }
  assert.equal(peakOf(g).off, false, 'four holds took Peak away and none of them counted as a loss')
  assert.ok(loop.changes.every((c) => c.reason !== 'gpu busy' && c.reason !== 'frames below 60 FPS'))
  // So a real loss after them is the visit's first, and Peak stays on.
  to(720)
  loop.run(10, { hz: 60, gpu: (tier) => (tier === PEAK_TIER ? 15 : FAST[tier]) })
  assert.equal(loop.changes.at(-1)?.reason, 'gpu busy', JSON.stringify(loop.changes.at(-1)))
  assert.equal(peakOf(g).off, false, 'one loss in the visit: Peak is still on')
})

// ---------------------------------------------------------------------------------------------------
// The frame budgets

test('peak: ?fps and a fast display without the camera tighten the limits; ?fps=30 never loosens them', () => {
  const at144 = (ultra: number): Load => ({ hz: 144, gpu: table([1.2, 1.5, 1.9, 2.4, ultra, 6.5], 17) })
  // ?fps=90 at 144 Hz, the camera on.
  const ninety = new Loop(boot(RTX_5090, { fps: 90 }).governor).run(3, at144(3.0))
  assert.ok(near(peakOf(ninety.g).limitMs, 1000 / 90 * 0.3), `?fps=90: ${peakOf(ninety.g).limitMs} ms`)
  ninety.run(117, at144(3.0))
  assert.equal(ninety.changes[0]?.tier, 5, JSON.stringify(ninety.changes))
  const ninetySlow = new Loop(boot(RTX_5090, { fps: 90 }).governor).run(120, at144(3.6))
  assert.deepEqual(ninetySlow.changes, [], 'Ultra at 3.6 ms is over 30 % of a 90 FPS frame')
  // ?cinema=0 at 144 Hz: the governor holds 90 FPS, so 30 % of 11.1 ms.
  const plain = new Loop(boot(RTX_5090, { cinema: false }).governor).run(3, at144(3.0))
  assert.ok(near(peakOf(plain.g).limitMs, 1000 / 90 * 0.3), `?cinema=0 at 144 Hz: ${peakOf(plain.g).limitMs} ms`)
  plain.run(117, at144(3.0))
  assert.equal(plain.changes[0]?.tier, 5, JSON.stringify(plain.changes))
  // ?fps=30 at 60 Hz: the budget stays the 60 FPS floor's.
  const thirty = new Loop(boot(RTX_5090, { fps: 30 }).governor).run(3, at60([1.2, 1.5, 1.9, 2.4, 6.0, 12]))
  assert.ok(near(peakOf(thirty.g).limitMs, 1000 / 60 * 0.3), `?fps=30: ${peakOf(thirty.g).limitMs} ms`)
  thirty.run(117, at60([1.2, 1.5, 1.9, 2.4, 6.0, 12]))
  assert.deepEqual(thirty.changes, [], JSON.stringify(thirty.changes))
})

// ---------------------------------------------------------------------------------------------------
// Manual tiers, readings, and the state the console shows

test('peak: manual Peak on any device; setTier(9) is Peak; setAuto from Peak lands at the range top', () => {
  const g = new Governor({ tier: 3, auto: false, max: 4 })
  g.setTier(5)
  assert.equal(g.tier, 5)
  assert.equal(g.knobs(), PEAK)
  const loop = new Loop(g).run(20, at60(SLOW))
  assert.deepEqual(loop.changes.map((c) => [c.tier, c.reason]), [[5, 'manual']], 'only setTier, reported by the first sample()')
  assert.equal(g.tier, 5)
  assert.equal(g.wantsGpu, false)
  assert.equal(g.state().peak, undefined)
  g.setAuto(true)
  assert.equal(g.tier, 4)
  const c = new Governor({ tier: 4, auto: true, max: 5 })
  c.setTier(5)
  c.setAuto(true)
  assert.equal(c.tier, 5, 'auto keeps a pinned Peak on a Peak range')
  c.setTier(9)
  assert.equal(c.tier, 5)
})

test('peak: readings that are not a frame are dropped; a clock running backwards clears the readings but keeps the limit, the losses and off', () => {
  const loop = new Loop(boot(RTX_5090).governor, { feed: false }).run(10, at60(FAST))
  assert.equal(loop.g.tier, 4)
  assert.equal(loop.g.wantsGpu, true)
  for (const junk of [Number.NaN, -1, 0, 0.2, 0.49, 1000, 5000, Infinity]) feedAt(loop, junk, 30)
  assert.equal(peakOf(loop.g).gpuMs, null, 'none of the 240 counted')
  feedAt(loop, 3, 23)
  assert.equal(peakOf(loop.g).gpuMs, null, '23 good readings are one short')
  feedAt(loop, 3, 1)
  assert.equal(peakOf(loop.g).gpuMs, 3)
  loop.g.gpuSample(3, Number.NaN)
  assert.equal(peakOf(loop.g).gpuMs, 3, 'a reading without a time is dropped too')
  // After a misjudged probe's loss: the readings go with the old time origin, the tightened limit stays.
  const m = marginal()
  m.run(30, at60(MARGINAL))
  assert.deepEqual(m.path, [5, 4], JSON.stringify(m.changes))
  const tight = peakOf(m.g).limitMs
  assert.ok(tight < 5.0)
  assert.notEqual(peakOf(m.g).gpuMs, null, 'Ultra\'s readings are there before the clock runs back')
  m.g.sample(16.7, 10)
  assert.equal(peakOf(m.g).gpuMs, null)
  assert.equal(peakOf(m.g).limitMs, tight)
  // After the third loss: off stays off.
  const off = threeLosses(200)
  assert.equal(peakOf(off.g).off, true)
  off.g.sample(16.7, 10)
  assert.equal(peakOf(off.g).off, true)
  assert.equal(off.g.wantsGpu, false)
  // Two losses, then the clock runs back: the visit's count stays, so the next loss is the third and turns Peak off.
  const losses = (l: Loop) => l.changes.filter((c) => c.from === PEAK_TIER && c.tier === 4).length
  // threeLosses' load: each loss tightens the entry, and Ultra gets quicker in time for the next probe.
  const load: Load = { hz: 60, gpu: (tier, t) => tier === PEAK_TIER ? 15 : tier === 4 ? (t < 30 ? 2.0 : t < 150 ? 1.0 : 0.6) : 1 }
  const two = new Loop(boot(RTX_5090).governor)
  two.until(() => losses(two) === 2, 600, load)
  assert.equal(losses(two), 2, JSON.stringify(two.changes))
  assert.equal(peakOf(two.g).off, false)
  two.g.sample(16.7, 10)
  two.until(() => losses(two) === 3, 600, load)
  assert.equal(losses(two), 3, JSON.stringify(two.changes))
  assert.equal(peakOf(two.g).off, true, 'the third loss of the visit, across the new time origin')
  assert.equal(two.g.wantsGpu, false)
})

test('peak: wantsGpu only at Ultra or Peak, in auto, unheld, on a Peak range, not off', () => {
  assert.equal(new Governor({ tier: 3, auto: true, max: 5 }).wantsGpu, false, 'at High')
  const g = new Governor({ tier: 4, auto: true, max: 5 })
  assert.equal(g.wantsGpu, true, 'at Ultra in auto')
  g.hold(4, 0)
  assert.equal(g.wantsGpu, false, 'held')
  g.hold(null, 0)
  assert.equal(g.wantsGpu, true, 'released')
  const p = new Governor({ tier: 4, auto: true, max: 5 })
  p.setTier(5)
  p.setAuto(true)
  assert.equal(p.wantsGpu, true, 'at Peak in auto')
  assert.equal(new Governor({ tier: 4, auto: false, max: 5 }).wantsGpu, false, 'a manual Ultra')
  assert.equal(new Governor({ tier: 4, auto: true, max: 4 }).wantsGpu, false, 'not a Peak range')
  assert.equal(threeLosses(200).g.wantsGpu, false, 'Peak off')
})

test('peak: state().peak: absent below a Peak range; p90 and the entry limit at Ultra, median and the stay limit at Peak, null without enough readings', () => {
  assert.equal(new Governor({ tier: 4, auto: true }).state().peak, undefined)
  assert.equal(boot(RTX_5090, { timestamps: false }).governor.state().peak, undefined, 'a candidate whose three writes no timestamps')
  const ultra = new Loop(boot(RTX_5090).governor, { feed: false }).run(10, at60(FAST))
  for (let ms = 1; ms <= 23; ms++) feedAt(ultra, ms, 1)
  assert.equal(peakOf(ultra.g).gpuMs, null, '23 readings are one short')
  assert.equal(peakOf(ultra.g).off, false)
  assert.ok(near(peakOf(ultra.g).limitMs, 1000 / 60 * 0.3), `${peakOf(ultra.g).limitMs} ms`)
  feedAt(ultra, 24, 1)
  assert.equal(peakOf(ultra.g).gpuMs, 21, 'the p90 of 1…24 ms (index 20)')
  // At Peak in auto: the median of the stay window, against 80 % of the frame.
  const peak = new Loop(boot(RTX_5090).governor, { feed: false }).run(5, at60(FAST))
  peak.g.setTier(5)
  peak.g.setAuto(true)
  peak.run(3, at60(FAST))
  assert.equal(peak.g.tier, 5)
  for (let ms = 1; ms <= 11; ms++) feedAt(peak, ms, 1)
  assert.equal(peakOf(peak.g).gpuMs, null, '11 readings are one short')
  for (let ms = 12; ms <= 13; ms++) feedAt(peak, ms, 1)
  assert.equal(peakOf(peak.g).gpuMs, 7, 'the median of 1…13 ms')
  assert.ok(near(peakOf(peak.g).limitMs, 1000 / 60 * 0.8), `${peakOf(peak.g).limitMs} ms`)
  // The whole 5 s entry window on the fastest display, without the camera: 1800 readings, the older half slower.
  const wide = new Loop(boot(RTX_5090, { cinema: false }).governor, { feed: false }).run(10, at60(FAST))
  assert.equal(wide.g.tier, 4)
  const end = wide.nowMs
  for (let i = 0; i < 1800; i++) wide.g.gpuSample(i < 900 ? 6 : 3, end - 4900 + (4900 * i) / 1799)
  assert.equal(peakOf(wide.g).gpuMs, 6, `the p90 of all 1800 (index 1619), in a ring of ${PEAK_GOV.ring}`)
})

test('peak: a model on the processor holds the city without lowering Peak: Peak kept, nothing remembered, no quiet time', () => {
  const cpuCap = holdTier(DISCRETE, false)
  assert.equal(cpuCap, PEAK_TIER)
  assert.equal(holdTier(DISCRETE, true), TIERS.length - 1)
  if (cpuCap === null) return
  const loop = new Loop(boot(RTX_5090).governor)
  const g = loop.g
  const fast = table(FAST, 7)
  let heatFrom = Infinity
  const load: Load = { hz: 60, gpu: (tier, t) => (tier === PEAK_TIER && t >= heatFrom && t < heatFrom + 10 ? 15 : fast(tier)) }
  loop.until(() => g.tier === 5, 7.5, load)
  assert.equal(g.tier, 5, 'at Peak by 7.5 s')
  loop.run(30 - loop.t, load)
  // Three answers at Peak: none moves the tier, counts as a loss (three would turn Peak off) or starts a quiet time.
  for (let i = 0; i < 3; i++) {
    const before = loop.changes.length
    g.hold(cpuCap, loop.nowMs)
    assert.equal(g.tier, 5)
    assert.equal(g.state().held, 5)
    assert.equal(g.wantsGpu, false)
    loop.run(20, load)
    assert.equal(loop.changes.length, before, 'nothing moved under the hold')
    g.hold(null, loop.nowMs)
    assert.equal(g.tier, 5)
    assert.equal(g.state().held, undefined)
    assert.equal(g.wantsGpu, true)
    loop.run(10, load)
  }
  assert.equal(loop.changes.length, 1, JSON.stringify(loop.changes))
  assert.equal(peakOf(g).off, false, 'three answers are not three losses')
  // Then real heat at Peak for 10 s: one loss, untightened (Peak had been there for minutes), and Peak back after the
  // back-off of a first loss (20 s), not after the quiet time a release that took Peak away would have started.
  heatFrom = loop.t + 1
  loop.until(() => loop.changes.length === 2, 30, load)
  const c = loop.changes
  assert.ok(c.length === 2 && c[1].tier === 4 && c[1].reason === 'gpu busy' && c[1].t >= heatFrom && c[1].t <= heatFrom + 3, JSON.stringify(c))
  assert.ok(near(peakOf(g).limitMs, 1000 / 60 * 0.3), `untightened: ${peakOf(g).limitMs} ms`)
  loop.run(600 - loop.t, load)
  assert.equal(c.length, 3, JSON.stringify(c))
  assert.ok(c[2].tier === 5 && c[2].reason === 'probe' && c[2].t - c[1].t >= 20 && c[2].t - c[1].t <= 25, JSON.stringify(c[2]))
  assert.equal(peakOf(g).off, false)
  // A desktop that is not a Peak candidate is held at Ultra by the same cap, as it was before Peak.
  const plain = new Governor({ tier: 4, auto: true })
  plain.hold(cpuCap, 0)
  assert.equal(plain.state().held, 4)
  assert.equal(plain.tier, 4)
})

test('peak: a model on the processor that starts at Ultra keeps Ultra until the release: no Peak on readings from before the hold', () => {
  const cpuCap = holdTier(DISCRETE, false)
  assert.equal(cpuCap, PEAK_TIER)
  if (cpuCap === null) return
  for (const [name, costs] of [['FAST', FAST], ['MARGINAL', MARGINAL]] as const) {
    // A hold from 3 s: Ultra's readings from before it would fill the entry window by the first probe (about 6 s).
    const loop = new Loop(boot(RTX_5090).governor)
    const g = loop.g
    const load = at60(costs)
    loop.run(3, load)
    assert.equal(g.tier, 4, name)
    g.hold(cpuCap, loop.nowMs)
    assert.equal(g.state().held, 5, name)
    assert.equal(g.wantsGpu, false, name)
    loop.run(30, load)
    assert.equal(loop.changes.length, 0, `${name}: nothing under the hold, ${JSON.stringify(loop.changes)}`)
    assert.equal(peakOf(g).limitMs, 1000 / 60 * 0.3, `${name}: nothing tightened`)
    const release = loop.t
    g.hold(null, loop.nowMs)
    loop.run(30, load)
    const c = loop.changes
    assert.ok(c.length >= 1 && c[0].tier === 5 && c[0].reason === 'probe', `${name}: ${JSON.stringify(c)}`)
    assert.ok(c[0].t - release >= 5 && c[0].t - release <= 7.5, `${name}: Peak on readings taken after the release, ${JSON.stringify(c[0])}`)
  }
})
