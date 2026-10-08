// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It drives the quality governor as the minimum phone it must serve would: the latest
 * flagship handset (an iPhone-class phone) in iOS Safari 26, WebGPU on its own mobile GPU, touch only, a 120 Hz
 * (ProMotion) panel, about 8 GB of memory of which a tab gets a tight share, devicePixelRatio 3, a narrow portrait
 * screen. The profile is built exactly as readDeviceHints reads it there (what Safari hides is left out the way
 * Safari leaves it out), and synthetic frame streams on 120 Hz vsync prove the phone's rules end to end: the starting
 * tier, the crowd, the Medium cap in auto mode, the 60 FPS floor at 120 Hz, the step down (more than 2 s below, one
 * tier at a time, inside the vsync tolerance, never below Minimal), a monotone descent while the phone heats, the
 * slow backed-off climb back, the cinema camera's own two rules, a pinned tier, and noise that must never step. With
 * AUTOSCALER_TRACE=1 it also writes every scenario's tier, second by second, to docs/autoscaler/phone.csv.
 * What breaks if it is removed? A change to the profile or to the governor could start this phone on desktop
 * settings, simulate a desktop crowd on it, promote it past Medium, let it oscillate as it heats, or step it on a
 * tab switch, and only a real handset in someone's hand would show it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CROWD_DEFAULT, Governor, TIERS, defaultAgents, degradeBudgetMs, profileDevice, tierRange, type DeviceHints,
} from './governor.ts'

// ---------------------------------------------------------------------------------------------------
// The device: what readDeviceHints reads on this phone in Safari 26

/**
 * Safari 26 on the phone (iPhone-class). Since Safari 26 the OS version in the user agent is frozen at 18_6;
 * Version/26.0 is the browser. profileDevice tells iOS from the device token in it, so the string is quoted whole.
 */
const SAFARI_26_PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'

/** The phone, field by field as governor.ts readDeviceHints builds it in iOS Safari 26. */
const PHONE: Readonly<DeviceHints> = Object.freeze({
  // world.ts joins GPUAdapterInfo's vendor / architecture / description. WebKit (GPUAdapterInfo.h, since August 2024)
  // answers all of them with the first word of the Metal device's name, lowercased: "Apple A19 GPU" → "apple".
  adapter: 'apple / apple / apple',
  userAgent: SAFARI_26_PHONE_UA,
  // navigator.userAgentData is Chromium only: Safari has none.
  mobileHint: undefined,
  // What Safari reports on the phone's touch screen.
  maxTouchPoints: 5,
  // (pointer: coarse) matches: touch only, no trackpad or mouse.
  coarsePointer: true,
  // WebKit NavigatorBase::hardwareConcurrency: fewer than 8 cores reads as 4 (the phone's six), 8 or more as 8.
  cores: 4,
  // navigator.deviceMemory is Chromium only: the 8 GB, and the tab's tight share of it, are invisible to the page.
  memoryGb: undefined,
  // screen.width × screen.height in CSS pixels, portrait (1206 × 2622 device pixels at devicePixelRatio 3). The pixel
  // ratio itself is no input: App.tsx renders at min(devicePixelRatio, 1) unless ?scale says otherwise.
  screenPixels: 402 * 874,
  // A browser tab, not a native shell.
  host: 'browser',
})

const PROFILE = profileDevice(PHONE)
const RANGE = tierRange(PROFILE)
/** The cinema camera's frame period (cinema.ts CINEMA.fps). */
const PACER = 1000 / 24

/**
 * The governor engine.ts builds for this phone: the profile's tier in auto mode, or the tier ?quality=N pins (auto
 * off), always with the profile's range; the cinema camera is on unless ?cinema=0; no ?fps, so no fixed target.
 */
function boot(cinema: boolean, quality?: number): Governor {
  const pacerMs = cinema ? PACER : undefined
  return quality === undefined
    ? new Governor({ tier: PROFILE.startTier, auto: true, pacerMs, ...RANGE })
    : new Governor({ tier: quality, auto: false, pacerMs, ...RANGE })
}

// ---------------------------------------------------------------------------------------------------
// Frames on the 120 Hz panel

const PERIOD = 1000 / 120
/** rAF interval for a frame costing `cost` ms on a panel refreshing every `period` ms: it waits for the next vsync. */
const vsyncAt = (period: number, cost: number) => Math.max(1, Math.ceil(cost / period - 1e-9)) * period
const vsync = (cost: number) => vsyncAt(PERIOD, cost)
/** Deterministic jitter in [-a, a] (governor.test.ts). */
const jitter = (i: number, a: number) => (((i * 7919) % 101) / 50 - 1) * a
const near = (x: number, y: number, eps = 1e-6) => Math.abs(x - y) <= eps

/**
 * What a drawn frame costs this phone, cool, ms, Minimal … Ultra. On the 120 Hz panel Minimal and Low make every
 * refresh (120 FPS), Medium and High every other (60 FPS), Ultra every third (40 FPS).
 */
const COOL = [4.5, 6.5, 9, 14, 21] as const

/** The rAF interval of the i-th frame, given the tier and the scenario's clock (s). */
type FrameFn = (tier: number, i: number, t: number) => number
/** Under the cinema camera: frames it does not draw (`idle`), frames after one it draws (`drawn`), and which of its
 *  frames it misses (drawn, but late: not presented). */
interface Scene { idle: FrameFn; drawn: FrameFn; drop?: (k: number, tier: number, t: number) => boolean }

/** The phone, cool: every tier costs what COOL says, give or take 0.4 ms. */
const cool: FrameFn = (tier, i) => vsync(COOL[tier] + jitter(i, 0.4))
/** Unbounded headroom: every frame makes the next refresh, whatever the tier. */
const free: FrameFn = () => PERIOD
/** A sustained overload, well above the 60 FPS budget: every frame takes four refreshes (30 FPS), whatever the tier. */
const thirty: FrameFn = () => vsync(30)

// ---------------------------------------------------------------------------------------------------
// Harness: the governor's clock, one row per simulated second

interface Change { at: number; ms: number; tier: number; why: string }
interface Row { t: number; fps: number; camera: number | null; tier: number }

const START = 1000
/** A frame ending this close after a whole second (float error in summed 1000 / 120 ms intervals) belongs to it. */
const EPS = 1e-3

class Sim {
  readonly name: string
  readonly g: Governor
  readonly from: number
  now = START
  readonly changes: Change[] = []
  readonly rows: Row[] = []
  /** When the camera presented a frame, on the governor's clock (ms). */
  readonly presented: number[] = []
  private i = 0
  private k = 0
  private due = START + PACER
  private drawnNext = false
  private mark = START + 1000
  private framesIn = 0
  private presentsIn = 0

  constructor(name: string, g: Governor) {
    this.name = name
    this.g = g
    this.from = g.tier
  }

  /** Seconds since the scenario began. */
  get t(): number { return (this.now - START) / 1000 }

  /** Frames for `seconds`: a frame function (every frame drawn, or the camera's frames cost the same), or a scene. */
  run(seconds: number, f: FrameFn | Scene): this {
    const scene: Scene = typeof f === 'function' ? { idle: f, drawn: f } : f
    const end = this.now + seconds * 1000
    while (this.now < end) this.frame((this.drawnNext ? scene.drawn : scene.idle)(this.g.tier, this.i, this.t), scene)
    return this
  }

  /** Single long frames (a hitch, a tab switch), then the frames go on as before. */
  hitch(...ms: number[]): this {
    for (const x of ms) this.frame(x, null)
    return this
  }

  /** Rows up to the last whole second. */
  done(): this {
    while (this.now >= this.mark - EPS) this.second()
    return this
  }

  /** One rAF callback, as engine.ts runs it: sample(), then (under the camera, when one is due) present(). */
  private frame(ms: number, scene: Scene | null): void {
    const end = this.now + ms
    while (end > this.mark + EPS) this.second()
    this.now = end
    this.i++
    this.framesIn++
    const r = this.g.sample(ms, end)
    if (r !== null) this.changes.push({ at: this.t, ms: end, tier: r, why: this.g.reason })
    this.drawnNext = false
    if (!this.g.pacer || this.now < this.due) return
    // The camera's pacer, simplified as in governor.test.ts runCinema: the first frame at or after a due time is drawn.
    if (!(scene?.drop?.(this.k, this.g.tier, this.t) ?? false)) {
      this.g.present(this.now)
      this.presented.push(this.now)
      this.presentsIn++
    }
    this.k++
    this.due += PACER * Math.max(1, Math.floor((this.now - this.due) / PACER) + 1)
    this.drawnNext = true
  }

  private second(): void {
    this.rows.push({ t: Math.round((this.mark - START) / 1000), fps: this.framesIn, camera: this.g.pacer ? this.presentsIn : null, tier: this.g.tier })
    this.framesIn = 0
    this.presentsIn = 0
    this.mark += 1000
  }
}

const tiersOf = (s: Sim) => s.changes.map((c) => c.tier)
const rowsIn = (s: Sim, from: number, to = Infinity) => s.rows.filter((r) => r.t > from && r.t <= to)
/** Camera frames presented in [toMs − windowMs, toMs]. */
const presentedIn = (s: Sim, toMs: number, windowMs = 5000) => s.presented.filter((p) => p >= toMs - windowMs && p <= toMs).length
/** The 97 % of the camera's frames a step up needs over 5 s: 116.4 of 120. */
const PRESENT_UP = (5000 / PACER) * 0.97

/** "Low → Medium (t=5.8 s, probe) → …, held at Medium". */
function sequence(s: Sim): string {
  const steps = s.changes.map((c) => `${TIERS[c.tier].label} (t=${c.at.toFixed(1)} s${c.why ? `, ${c.why}` : ''})`)
  return [TIERS[s.from].label, ...steps].join(' → ') + `, held at ${TIERS[s.g.tier].label} to t=${s.t.toFixed(0)} s`
}

const once = <T>(f: () => T): (() => T) => {
  let v: T | undefined
  return () => (v ??= f())
}

// ---------------------------------------------------------------------------------------------------
// Scenarios (deterministic; each runs once, shared by the assertions and the trace)

/** As the phone heats: cool for 30 s, then every frame 1.8× slower over five minutes, then held there. */
const heat = (t: number) => 1 + 1.8 * Math.min(1, Math.max(0, (t - 30) / 300))
const HEAT_JITTER = 0.6
const thermal: FrameFn = (tier, i, t) => vsync(COOL[tier] * heat(t) + jitter(i, HEAT_JITTER))
/** When a tier's slowest (margin +HEAT_JITTER) or fastest (−HEAT_JITTER) frames first miss two refreshes (60 FPS), s. */
const heatsPast = (tier: number, margin: number) => 30 + (300 * ((2 * PERIOD - margin) / COOL[tier] - 1)) / 1.8

/** Medium too heavy for this phone (three refreshes, 40 FPS); Low makes every refresh. */
const heavyMedium: FrameFn = (tier, i) => vsync((tier >= 2 ? 18 : COOL[tier]) + jitter(i, 0.4))

/** Under the camera: frames it does not draw take one refresh; a drawn one costs what the tier costs. */
const light: Scene = { idle: () => PERIOD, drawn: cool }
/** A heavier scene: Medium misses one camera frame in three (16 a second), Low one in twelve (22 a second). */
const heavy: Scene = { idle: () => PERIOD, drawn: cool, drop: (k, tier) => (tier >= 2 ? k % 3 === 0 : k % 12 === 0) }
/** The camera misses one frame in three at any tier while the animation frames make every refresh. */
const behind: Scene = { idle: free, drawn: free, drop: (k) => k % 3 === 0 }
/** The first frames after an app resume: 60 ms each. */
const janky: FrameFn = () => 60

function pinned(n: number): Sim {
  return new Sim(`6-pinned-${n}`, boot(true, n))
    .run(10, light)
    .run(15, thirty)
    .run(10, behind)
    .hitch(5000)
    .run(10, free)
    .done()
}

function noisy(s: Sim, f: FrameFn | Scene): Sim {
  s.run(10, f)                                                  // boot: Low, probed to Medium
  for (const ms of [300, 600, 950]) s.hitch(ms).run(3, f)       // a single long frame, three times
  for (let k = 0; k < 4; k++) s.hitch(180).run(1.2, f)          // a GC pause now and then
  s.hitch(900, 600).run(3, f)                                   // two hitches in a row (1.5 s; more: the hitch-run test)
  s.hitch(5000).run(3, f)                                       // a tab switch: 5 s without a frame
  s.hitch(30000).run(0.3, janky).run(5, f)                      // the app backgrounded for 30 s, resumed with janky frames
  s.run(10, f)
  return s.done()
}

const S = {
  cap: once(() => new Sim('1-headroom-cap', boot(false)).run(180, free).done()),
  sixty: once(() => new Sim('1-sixty-fps-at-120hz', boot(false)).run(10, cool).run(590, (tier, i, t) => cool(tier, i, t) + jitter(3 * i, 0.5)).done()),
  overload: once(() => new Sim('2-overload', boot(false)).run(20, cool).run(40, thirty).done()),
  thermal: once(() => new Sim('3-thermal', boot(false)).run(400, thermal).done()),
  backoff: once(() => new Sim('4-recover-backoff', boot(false)).run(20, cool).run(8, thirty).run(62, free).done()),
  hold: once(() => new Sim('4-recover-hold', boot(false)).run(20, cool).run(40, thirty).run(40, free).done()),
  probes: once(() => new Sim('4-failed-probes', boot(false)).run(920, heavyMedium).done()),
  cinema: once(() => new Sim('5-cinema', boot(true)).run(20, light).run(30, heavy).run(30, light).done()),
  pinned: once(() => [0, 1, 2, 3, 4].map(pinned)),
  noise: once(() => noisy(new Sim('7-noise', boot(false)), cool)),
  noiseCinema: once(() => noisy(new Sim('7-noise-cinema', boot(true)), light)),
  hitchRun: once(() => new Sim('7-hitch-run-cinema', boot(true)).run(20, light).hitch(950, 950).run(60, light).done()),
}

/** Every auto-mode scenario. */
const autoRuns = () => [S.cap(), S.sixty(), S.overload(), S.thermal(), S.backoff(), S.hold(), S.probes(), S.cinema(), S.noise(), S.noiseCinema(), S.hitchRun()]

// ---------------------------------------------------------------------------------------------------
// 1. Recognised as a phone

test('phone 1: Safari 26 on the phone profiles as a phone: Low start, Medium cap, the phone crowd', () => {
  assert.deepEqual(PROFILE, { mobile: true, gpuClass: 'mobile', startTier: 1 })
  assert.equal(TIERS[PROFILE.startTier].label, 'Low')
  assert.deepEqual(RANGE, { min: 0, max: 2 })
  assert.equal(TIERS[RANGE.max].label, 'Medium')
  assert.equal(defaultAgents(PROFILE), CROWD_DEFAULT.phone)
  assert.equal(CROWD_DEFAULT.phone, 8000)
  // However Safari describes the GPU (Dawn-style names, blank fields, no info object), the phone is the same phone.
  for (const adapter of ['apple / common-3', '', 'unknown adapter']) {
    const p = profileDevice({ ...PHONE, adapter })
    assert.equal(p.mobile, true, adapter)
    assert.equal(p.startTier, 1, adapter)
    assert.deepEqual(tierRange(p), RANGE, adapter)
    assert.equal(defaultAgents(p), CROWD_DEFAULT.phone, adapter)
  }
  // "Request Desktop Website" sends the desktop Safari user agent; the five touch points still tell the phone apart.
  const desktopSite = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
  assert.deepEqual(profileDevice({ ...PHONE, userAgent: desktopSite }), PROFILE)
  // The phone branch never reads the cores or the screen: device pixels for CSS pixels, a landscape screen, more
  // cores, a Chromium-style mobile hint or a reported 8 GB change nothing.
  for (const h of [{ cores: 2 }, { cores: 8 }, { screenPixels: 1206 * 2622 }, { screenPixels: 874 * 402 }, { mobileHint: true }, { memoryGb: 8 }] as Partial<DeviceHints>[]) {
    assert.deepEqual(profileDevice({ ...PHONE, ...h }), PROFILE, JSON.stringify(h))
  }
  // What would change it: a reported memory of 4 GB or less (Minimal and the smallest crowd). Safari reports none,
  // so the tab's tight share of the 8 GB cannot reach the profile.
  const small = profileDevice({ ...PHONE, memoryGb: 4 })
  assert.equal(small.startTier, 0)
  assert.equal(defaultAgents(small), CROWD_DEFAULT.minimal)
  // The governor engine.ts builds from it.
  for (const cinema of [false, true]) {
    const g = boot(cinema)
    assert.deepEqual([g.tier, g.auto, g.pacer], [1, true, cinema])
  }
})

test('phone 1: in auto mode no headroom promotes it past Medium (camera on or off); a manual tier is clamped back', () => {
  const s = S.cap()
  assert.deepEqual(tiersOf(s), [2], sequence(s))
  assert.equal(s.changes[0].why, 'probe')
  // The probe waits for the warm-up (0.75 s) and then 5 s of headroom.
  assert.ok(s.changes[0].at >= 5.75 && s.changes[0].at <= 6, `probed at ${s.changes[0].at} s`)
  assert.ok(s.rows.every((r) => r.tier <= 2) && s.rows.at(-1)?.tier === 2)
  assert.ok(rowsIn(s, 10).every((r) => r.fps === 120), 'Medium at a full 120 FPS for three minutes, never promoted')
  const film = new Sim('', boot(true)).run(180, free).done()
  assert.deepEqual(tiersOf(film), [2], 'under the camera too')
  // Asked for Ultra in auto mode it starts on Medium; a manual Ultra (the console) is clamped back when auto resumes.
  assert.equal(new Governor({ tier: 4, auto: true, ...RANGE }).tier, 2)
  const g = boot(false)
  g.setTier(4)
  assert.equal(g.tier, 4)
  g.setAuto(true)
  assert.equal(g.tier, 2)
})

test('phone 1: at 120 Hz it aims for 90 FPS but the 60 FPS floor rules the step down; 60 FPS holds for 10 minutes', () => {
  const s = S.sixty()
  assert.ok(near(s.g.targetMs, 1000 / 90, 1e-3), `target ${s.g.targetMs} ms`)
  assert.ok(near(degradeBudgetMs(s.g.targetMs, false), (1000 / 60) * 1.05), 'the budget is the 60 FPS floor plus 5 %, not the 90 FPS aim')
  assert.deepEqual(tiersOf(s), [2], `Medium at 60 FPS (every other refresh, ±0.5 ms) neither steps down nor up: ${sequence(s)}`)
  assert.ok(rowsIn(s, 10).every((r) => r.tier === 2 && r.fps >= 59 && r.fps <= 61))
  // Safari's default on this panel ("Prefer Page Rendering Updates near 60fps") runs rAF at 60: the aim is then 60 FPS,
  // the floor is the same, and the tiers that make 60 are the headroom a probe needs.
  const at60 = new Sim('', boot(false)).run(120, (tier, i) => vsyncAt(1000 / 60, COOL[tier] + jitter(i, 0.4))).done()
  assert.ok(near(at60.g.targetMs, 1000 / 60, 1e-3))
  assert.ok(near(degradeBudgetMs(at60.g.targetMs, false), degradeBudgetMs(s.g.targetMs, false)))
  assert.deepEqual(tiersOf(at60), [2])
})

// ---------------------------------------------------------------------------------------------------
// 2. Sustained overload

test('phone 2: a sustained overload (30 FPS) steps down one tier at a time, the first more than 2 s in, to Minimal and no further', () => {
  const s = S.overload()
  assert.deepEqual(tiersOf(s), [2, 1, 0], sequence(s))
  const [probe, d1, d2] = s.changes
  assert.equal(probe.why, 'probe')
  for (const d of [d1, d2]) assert.equal(d.why, 'frames below 60 FPS')
  const first = d1.at - 20
  assert.ok(first > 2 && first <= 2.5, `first step ${first.toFixed(3)} s after the frames fell to 30 FPS`)
  const gap = d2.at - d1.at
  assert.ok(gap >= 3.45 && gap <= 4, `the next one ${gap.toFixed(3)} s later (1.5 s cooldown, then more than 2 s below)`)
  const after = rowsIn(s, Math.ceil(d2.at))
  assert.ok(after.length >= 30 && after.every((r) => r.tier === 0 && r.fps === 30), 'Minimal holds, still at 30 FPS, for 30 s')
  assert.equal(s.g.tier, 0)
})

test('phone 2: the vsync tolerance at 120 Hz: a dropped refresh in 20 (58.5 FPS) holds; one in 4 (53 FPS) steps after 2 s; 2 s dips never do, 2.5 s does', () => {
  // Medium is reached first (the boot probe); a late frame on this panel takes three refreshes (25 ms) instead of two.
  const late = (every: number): FrameFn => (tier, i, t) => (tier >= 2 && i % every === 0 ? vsync(17) : cool(tier, i, t))
  const ok = new Sim('', boot(false)).run(10, cool).run(600, late(20)).done()
  assert.deepEqual(tiersOf(ok), [2], '58.5 FPS is within the tolerance: 10 minutes without a step')
  const slow = new Sim('', boot(false)).run(10, cool).run(5, late(4)).done()
  assert.equal(slow.changes[1]?.tier, 1, sequence(slow))
  assert.ok(slow.changes[1].at - 10 > 2, `${(slow.changes[1].at - 10).toFixed(3)} s`)
  for (const dip of [1, 1.5, 2]) {
    const d = new Sim('', boot(false)).run(10, cool)
    for (let k = 0; k < 20; k++) d.run(dip, thirty).run(0.5 + k * 0.011, cool)
    assert.deepEqual(tiersOf(d), [2], `${dip} s dips to 30 FPS, half a second apart`)
  }
  const d = new Sim('', boot(false)).run(10, cool).run(2.5, thirty).run(1, cool)
  assert.equal(d.changes[1]?.tier, 1)
})

test('phone 2 (observation, not a defect): Safari halves rAF in Low Power Mode (30 Hz here), and that reads as overload: Low → Minimal, held', () => {
  // WebKit throttles rAF to half speed in Low Power Mode and under aggressive thermal mitigation (AnimationFrameRate.cpp).
  // The page cannot tell a throttled rAF from load ("the browser exposes no thermal state, so frame time is the proxy"):
  // the phone walks to Minimal and stays there while the mode is on, and cannot fall further.
  for (const cinema of [false, true]) {
    const s = new Sim('', boot(cinema)).run(60, () => 1000 / 30).done()
    assert.deepEqual(tiersOf(s), [0], sequence(s))
    assert.equal(s.changes[0].why, 'frames below 60 FPS')
    assert.ok(s.changes[0].at < 4, `at ${s.changes[0].at} s`)
  }
})

// ---------------------------------------------------------------------------------------------------
// 3. Heat

test('phone 3: as the phone heats over minutes the descent is monotone: Medium → Low → Minimal, never back up, no oscillation', () => {
  const s = S.thermal()
  assert.deepEqual(tiersOf(s), [2, 1, 0], sequence(s))
  const [up, d1, d2] = s.changes
  assert.equal(up.why, 'probe')
  for (const d of [d1, d2]) assert.equal(d.why, 'frames below 60 FPS')
  // Each step comes once that tier's frames have missed the 60 FPS frame for more than 2 s, and no later than 2.6 s
  // after every one of them does.
  for (const [d, tier] of [[d1, 2], [d2, 1]] as const) {
    const lo = heatsPast(tier, HEAT_JITTER) + 2, hi = heatsPast(tier, -HEAT_JITTER) + 2.6
    assert.ok(d.at > lo && d.at < hi, `${TIERS[tier].label} left at ${d.at.toFixed(1)} s, expected between ${lo.toFixed(1)} and ${hi.toFixed(1)} s`)
  }
  assert.ok(d2.at - d1.at > 60, 'minutes apart, as the heat builds')
  // Monotone from the peak: no probe back up once the descent began, though Medium's 20 s back-off ran out long before
  // (Low makes 60 FPS on this panel: inside the band, not the headroom a probe needs).
  const peak = s.rows.findIndex((r) => r.tier === 2)
  for (let k = peak + 1; k < s.rows.length; k++) assert.ok(s.rows[k].tier <= s.rows[k - 1].tier, `rose at t=${s.rows[k].t} s`)
  assert.ok(rowsIn(s, Math.ceil(d2.at)).every((r) => r.tier === 0 && r.fps === 60), 'Minimal holds 60 FPS at full heat')
})

// ---------------------------------------------------------------------------------------------------
// 4. Recovery: hold, cooldown, back-off, the cap

test('phone 4: headroom back right after a walk down: Low is re-probed only when its 20 s back-off ends, Medium 6.5 s later, then held', () => {
  const s = S.backoff()
  assert.deepEqual(tiersOf(s), [2, 1, 0, 1, 2], sequence(s))
  const [, d1, d2, u1, u2] = s.changes
  assert.ok(28 < d2.at + 5, 'headroom was back within 5 s of reaching Minimal')
  assert.ok(u1.at - d2.at >= 20 && u1.at - d2.at <= 20.2, `Low re-probed ${(u1.at - d2.at).toFixed(2)} s after it was left (back-off 20 s)`)
  assert.ok(u1.at - d1.at >= 20, 'Medium\'s own back-off had run out')
  assert.ok(u2.at - u1.at >= 6.5 && u2.at - u1.at <= 6.7, `Medium ${(u2.at - u1.at).toFixed(2)} s later (1.5 s cooldown, 5 s hold)`)
  assert.equal(u1.why, 'probe')
  assert.equal(u2.why, 'probe')
  assert.ok(rowsIn(s, Math.ceil(u2.at)).every((r) => r.tier === 2 && r.fps === 120), 'held at the phone cap with unbounded headroom')
})

test('phone 4: headroom back long after the back-off: the climb waits for 5 s of on-target frames, then one tier per 6.5 s', () => {
  const s = S.hold()
  assert.deepEqual(tiersOf(s), [2, 1, 0, 1, 2], sequence(s))
  const [, , d2, u1, u2] = s.changes
  assert.ok(60 - d2.at > 20, 'the back-off had long run out')
  // The 5 s hold is hitch-free time (that began at the step down) with the p97 of the last 5 s of frames on target.
  // The p97 is counted per frame: 120 fresh frames a second soon outnumber the 30 stale ones, so the probe comes once
  // fewer than 3 % of the window's frames are slow, about 4.5 s after the headroom returned (none before 4 s).
  const wait = u1.at - 60
  assert.ok(wait >= 4 && wait <= 5.2, `Low re-probed ${wait.toFixed(2)} s after the headroom returned`)
  assert.ok(u2.at - u1.at >= 6.5 && u2.at - u1.at <= 6.7)
  assert.ok(rowsIn(s, Math.ceil(u2.at)).every((r) => r.tier === 2))
})

test('phone 4: a Medium this phone cannot hold is re-probed ever more rarely (40, 80, 160, then 300 s and no more): no oscillation', () => {
  const s = S.probes()
  const ups = s.changes.filter((c) => c.tier === 2)
  const downs = s.changes.filter((c) => c.tier === 1)
  assert.ok(s.changes.every((c) => c.tier === 1 || c.tier === 2), `never below the tier that holds, never above the cap: ${sequence(s)}`)
  assert.equal(ups.length, 6)
  assert.equal(downs.length, 6)
  for (let k = 0; k < downs.length; k++) {
    const held = downs[k].at - ups[k].at
    assert.ok(held >= 3.45 && held <= 4, `probe ${k + 1} withdrawn after ${held.toFixed(2)} s`)
    assert.equal(downs[k].why, 'frames below 60 FPS')
  }
  const waits = ups.slice(1).map((u, k) => u.at - downs[k].at)
  const want = [40, 80, 160, 300, 300]
  for (let k = 0; k < want.length; k++) assert.ok(waits[k] >= want[k] && waits[k] <= want[k] + 0.2, `waits ${waits.map((w) => w.toFixed(1)).join(', ')} s`)
})

test('phone 4: no auto-mode scenario ever leaves Minimal … Medium: never High, never Ultra', () => {
  for (const s of autoRuns()) {
    assert.ok(s.rows.every((r) => r.tier >= 0 && r.tier <= 2), s.name)
    assert.ok(s.changes.every((c) => c.tier <= 2), s.name)
    assert.ok(s.g.auto, s.name)
  }
})

// ---------------------------------------------------------------------------------------------------
// 5. The cinema camera at 24 fps

test('phone 5: under the camera the animation frames are held at the 60 FPS floor on the 120 Hz panel', () => {
  const s = S.cinema()
  assert.equal(s.g.pacer, true)
  assert.ok(near(s.g.targetMs, 1000 / 60, 1e-3), `target ${s.g.targetMs} ms (not the 90 FPS aim of the camera-off governor)`)
})

test('phone 5: the camera missing its frames steps down while the animation frames look fine; the climb back waits for 97 % over 5 s', () => {
  const s = S.cinema()
  assert.deepEqual(tiersOf(s), [2, 1, 2], sequence(s))
  const [probe, down, back] = s.changes
  assert.equal(probe.why, 'probe')
  // 20 s: the scene gets heavier, and Medium presents 16 of its 24 frames.
  assert.equal(down.why, 'camera behind')
  const dt = down.at - 20
  assert.ok(dt > 2 && dt <= 3, `stepped down ${dt.toFixed(3)} s after the camera fell behind`)
  assert.ok(down.at - probe.at > 12, 'long after the probe: a plain step down (20 s back-off), not a failed probe (40 s)')
  const behindRows = rowsIn(s, 20, Math.floor(down.at))
  assert.ok(behindRows.every((r) => r.camera !== null && Math.abs(r.camera - 16) <= 1 && r.fps >= 90), `meanwhile the animation frames ran at 90 FPS or more: ${JSON.stringify(behindRows)}`)
  // The same frames with every camera frame presented never step: it was the camera's rule, not the 60 FPS one.
  const control = new Sim('', boot(true)).run(20, light).run(30, { ...heavy, drop: undefined }).done()
  assert.deepEqual(tiersOf(control), [2])
  // At Low the camera presents 22 of 24 (91.7 %): above its 90 % floor (no step down), short of 97 % (no probe), up to
  // 50 s, past Medium's 20 s back-off (over at down.at + 20), while the animation frames run at a full 120 FPS.
  assert.ok(down.at + 20 < 50 - 5, 'the back-off ran out well before the scene lightened')
  const low = rowsIn(s, Math.ceil(down.at), 50)
  assert.ok(low.length >= 25 && low.every((r) => r.tier === 1 && r.camera !== null && Math.abs(r.camera - 22) <= 1 && r.fps === 120), JSON.stringify(low))
  // 50 s: the scene is light again. The probe comes once the last 5 s hold 97 % of the camera's frames, and not before.
  assert.equal(back.why, 'probe')
  assert.ok(presentedIn(s, START + 50000) < PRESENT_UP, 'short of 97 % when the scene lightened')
  assert.ok(presentedIn(s, back.ms) >= PRESENT_UP, `${presentedIn(s, back.ms)} presented over the 5 s before the probe`)
  assert.ok(presentedIn(s, back.ms - 100) < PRESENT_UP, 'and short of it a moment (one evaluation) earlier')
  assert.ok(back.at - 50 > 3 && back.at - 50 <= 5.5, `probed ${(back.at - 50).toFixed(2)} s after the scene lightened`)
  assert.ok(rowsIn(s, Math.ceil(back.at)).every((r) => r.tier === 2 && r.camera !== null && r.camera >= 23), 'Medium presents all 24 again and holds')
})

test('phone 5: 95 % of the camera\'s frames never earns a probe, however fast the animation frames; 98 % does', () => {
  const held = new Sim('', boot(true)).run(120, { idle: free, drawn: free, drop: (k) => k % 20 === 0 }).done()
  assert.deepEqual(held.changes, [], '23 of 24 a second (95 %) for two minutes: held at Low')
  assert.ok(held.rows.every((r) => r.fps === 120))
  const probed = new Sim('', boot(true)).run(10, { idle: free, drawn: free, drop: (k) => k % 60 === 0 }).done()
  assert.equal(probed.changes[0]?.tier, 2, '59 of 60 (98.3 %): the usual probe')
  assert.ok(probed.changes[0].at >= 5.75 && probed.changes[0].at <= 6.5)
})

// ---------------------------------------------------------------------------------------------------
// 6. A pinned tier

test('phone 6: ?quality=N pins the tier: overload, a camera behind, a tab switch and headroom never move it', () => {
  for (const s of S.pinned()) {
    const n = Number(s.name.slice(-1))
    assert.equal(s.g.auto, false)
    assert.equal(s.g.tier, n, s.name)
    assert.deepEqual(s.changes, [], s.name)
    assert.ok(s.rows.length >= 50 && s.rows.every((r) => r.tier === n), s.name)
  }
  // A pinned High or Ultra on a phone stays pinned (the console may leave the auto range); with the camera off as well.
  for (const n of [0, 1, 2, 3, 4]) {
    const s = new Sim('', boot(false, n)).run(10, free).run(15, thirty).hitch(5000).run(10, free).done()
    assert.deepEqual(s.changes, [], `?quality=${n}&cinema=0`)
    assert.equal(s.g.tier, n)
  }
})

// ---------------------------------------------------------------------------------------------------
// 7. Noise

test('phone 7: noise never steps: single long frames, GC pauses, two hitches in a row, a tab switch, an app resume', () => {
  for (const s of [S.noise(), S.noiseCinema()]) {
    assert.deepEqual(tiersOf(s), [2], `${s.name}: the boot probe only: ${sequence(s)}`)
    assert.ok(s.changes[0].at < 7, s.name)
    assert.ok(rowsIn(s, 10).every((r) => r.tier === 2), s.name)
    assert.ok(rowsIn(s, 10).some((r) => r.fps === 0), `${s.name}: the trace shows the seconds without a frame`)
  }
  // A single frame of any length, alone, at Medium and at Low, camera on or off.
  for (const ms of [260, 400, 700, 999, 1001, 3000, 60000]) {
    for (const cinema of [false, true]) {
      const f = cinema ? light : cool
      const s = new Sim('', boot(cinema)).run(20, f).hitch(ms).run(10, f).done()
      assert.deepEqual(tiersOf(s), [2], `${ms} ms, camera ${cinema ? 'on' : 'off'}`)
    }
  }
})

test('phone 7: under the camera, a run of sub-second hitches as long as a gap is a gap, as with the camera off', () => {
  // GOV.outlierMs: frames over 250 ms are "tab switches, GC pauses or compile hitches, not load… unless [outlierRun = 4]
  // arrive in a row". The 60 FPS rule honours it. The camera rule is gated on `span = now - this.since`, and `since`
  // once moved only on one frame over gapMs, so the camera frames a run of ignored hitches swallowed read as behind in
  // every half-second slice, and the tier stepped down about 2.2 s later (found by this test). sample() now treats a
  // run of ignored hitches longer than gapMs as a gap, as one frame that long is: the camera rule ignores them too.
  for (const run of [[950, 950], [600, 600, 600], [800, 800, 800]]) {
    const name = `${run.join(' + ')} ms`
    const film = new Sim('', boot(true)).run(20, light).hitch(...run).run(6, light).done()
    assert.deepEqual(film.changes.map((c) => [c.tier, c.why]), [[2, 'probe']], `${name}: ${sequence(film)}`)
    const plain = new Sim('', boot(false)).run(20, cool).hitch(...run).run(6, cool).done()
    assert.deepEqual(tiersOf(plain), [2], `${name}, camera off: the same hitches are noise`)
    const gap = new Sim('', boot(true)).run(20, light).hitch(run.reduce((a, b) => a + b)).run(6, light).done()
    assert.deepEqual(tiersOf(gap), [2], `${name} as one frame (a gap), camera on: noise`)
  }
  // The trace's run: Medium holds through the hitches.
  const s = S.hitchRun()
  assert.deepEqual(s.changes.map((c) => [c.tier, c.why]), [[2, 'probe']], sequence(s))
})

test('phone 7 (observation, not a defect): under the camera a 180 ms stall every half second for 3 s misses a frame in every slice: one step down', () => {
  // The camera's documented rule ("short of 90 % of them in every slice for more than 2 s, a frame missed in each"):
  // each stall costs the camera about 4 of a half-second's 12 frames. The 60 FPS rule's quarter-second slices see the
  // clean ones between the stalls, so with the camera off nothing steps. 180 ms is under the 250 ms hitch cutoff:
  // these are slow frames, not hitches, and the hitch-run gap rule above leaves this as it is.
  const film = new Sim('', boot(true)).run(20, light)
  for (let k = 0; k < 6; k++) film.hitch(180).run(0.5, light)
  film.run(5, light).done()
  assert.deepEqual(film.changes.map((c) => [c.tier, c.why]), [[2, 'probe'], [1, 'camera behind']], sequence(film))
  const plain = new Sim('', boot(false)).run(20, cool)
  for (let k = 0; k < 6; k++) plain.hitch(180).run(0.5, cool)
  plain.run(5, cool).done()
  assert.deepEqual(tiersOf(plain), [2])
})

// ---------------------------------------------------------------------------------------------------
// Trace

const CSV_HEADER = 'scenario,t_seconds,fps,camera_fps_or_blank,tier_index,tier_name'
const traced = () => [S.cap(), S.sixty(), S.overload(), S.thermal(), S.backoff(), S.hold(), S.probes(), S.cinema(), ...S.pinned(), S.noise(), S.noiseCinema(), S.hitchRun()]

/** Every scenario's trace as CSV, one row per scenario per simulated second: the frames and the camera's frames in
 *  that second, and the tier at its end. Pure: the scenarios are deterministic. */
export function phoneTraceCsv(): string {
  const lines = [CSV_HEADER]
  for (const s of traced()) for (const r of s.rows) lines.push([s.name, r.t, r.fps, r.camera ?? '', r.tier, TIERS[r.tier].label].join(','))
  return `${lines.join('\n')}\n`
}

/** The trace's file: docs/autoscaler/phone.csv at the repository root. */
export const PHONE_TRACE_FILE = fileURLToPath(new URL('../../docs/autoscaler/phone.csv', import.meta.url))

/** Writes phoneTraceCsv() to `file` and returns each scenario's tier sequence. Run by the test below only with
 *  AUTOSCALER_TRACE=1, so `npm test` writes nothing. */
export function writePhoneTrace(file = PHONE_TRACE_FILE): string[] {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, phoneTraceCsv())
  return traced().map((s) => `${s.name}: ${sequence(s)}`)
}

test('trace: one row per scenario per simulated second (written to docs/autoscaler/phone.csv only with AUTOSCALER_TRACE=1)', (t) => {
  const lines = phoneTraceCsv().trimEnd().split('\n')
  assert.equal(lines[0], CSV_HEADER)
  const rows = lines.slice(1).map((l) => l.split(','))
  assert.ok(rows.every((r) => r.length === 6))
  const names = traced().map((s) => s.name)
  assert.equal(new Set(names).size, names.length, 'scenario names are unique')
  for (const name of names) {
    const mine = rows.filter((r) => r[0] === name)
    assert.ok(mine.length >= 50, `${name}: ${mine.length} rows`)
    mine.forEach((r, k) => {
      assert.equal(Number(r[1]), k + 1, `${name}: every second once, in order`)
      assert.equal(TIERS[Number(r[4])].label, r[5])
      assert.equal(r[3] === '', !name.includes('cinema') && !name.startsWith('5-') && !name.startsWith('6-'), `${name}: camera column`)
    })
  }
  if (process.env.AUTOSCALER_TRACE === '1') {
    for (const line of writePhoneTrace()) t.diagnostic(line)
    t.diagnostic(`wrote ${PHONE_TRACE_FILE}`)
  }
})
