// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the quality autoscaler (governor.ts) on the top of its range, the MAXIMUM
 * profile: a console-class desktop (8 cores / 16 threads, a discrete RDNA2-class GPU of about 10 TFLOPS, 16 GB or
 * more, a 4K display at 60 Hz or a 144 Hz monitor, no touch), in a browser tab and in the native Tauri v2 shell. The
 * profile is built from the very globals readDeviceHints reads, the governor as Engine.create builds it, and the frame
 * loop as engine.ts runs it (the cinema camera's own FramePacer decides which animation frames are drawn and
 * presented), on synthetic frame costs. It pins the starting tier and crowd; a steady Ultra at 60 and 144 Hz; the
 * README's overload walked down one tier at a time; the climb back with its cooldowns and back-offs; a load swinging
 * across the threshold; the camera's presented-frame rule; a pinned tier; and the ?fps targets. With
 * AUTOSCALER_TRACE=1 it also writes every scenario's tier, second by second, to docs/autoscaler/desktop.csv
 * (writeDesktopTrace); a plain `npm test` writes nothing.
 * What breaks if it is removed? Nothing would show that a machine of this class starts where the README says, holds
 * Ultra at 60 and 144 Hz without a spurious step, walks an overload down and climbs back without oscillating, or that
 * the camera's 24 frames drive its tier: a change to the profile's patterns or the governor's timing could cost the top
 * of the range its top tier, or flip it, silently.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CROWD_DEFAULT, Governor, TIERS, defaultAgents, profileDevice, readDeviceHints, tierRange, type DeviceHints, type DeviceProfile,
} from './governor.ts'
import type { SipocSnapshot } from './telemetry.ts'
import { CINEMA, FramePacer } from '../07_Execute_Actions/cinema.ts'

// ---------------------------------------------------------------------------------------------------
// The machine, as the page's globals describe it (readDeviceHints reads exactly these)

/** Chrome on Windows 11, which still reports NT 10.0. */
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
/** Edge, and the native shell's WebView2 (Edge's Chromium): the same string with an Edg/ token. */
const EDGE = `${CHROME} Edg/140.0.0.0`

/**
 * The GPU as world.ts hands it to the profile: "vendor / architecture / description" from WebGPU's adapter info. Stock
 * desktop Chromium (Chrome, Edge, WebView2) fills in the vendor and the architecture and withholds the description
 * unless WebGPU developer features are on.
 * - AMPERE: an NVIDIA card of this class (an RTX 30-series part, the RDNA2 generation's contemporary).
 * - RDNA2: the RDNA2 card itself.
 * - RDNA2_NAMED: the same card where a browser does expose the description (the 36-CU RX 6700, about 11 TFLOPS).
 */
const AMPERE = 'nvidia / ampere'
const RDNA2 = 'amd / rdna-2'
const RDNA2_NAMED = 'amd / rdna-2 / AMD Radeon RX 6700'

/**
 * screen.width × screen.height, in CSS pixels: the 4K panel at the operating system's recommended 150 % is 2560 × 1440
 * (3840 × 2160 at 100 %); the 144 Hz monitor is a 1440p panel at 100 %. The refresh rate is not a profile input: the
 * governor measures it from the frames.
 */
const SCREEN_4K = Object.freeze({ width: 2560, height: 1440 })
const SCREEN_4K_100 = Object.freeze({ width: 3840, height: 2160 })
const SCREEN_144 = Object.freeze({ width: 2560, height: 1440 })

interface Desk { adapter: string; userAgent: string; screen: { width: number; height: number }; native: boolean }

const TAB_4K: Desk = { adapter: AMPERE, userAgent: CHROME, screen: SCREEN_4K, native: false }
const NATIVE_4K: Desk = { ...TAB_4K, userAgent: EDGE, native: true }
const TAB_144: Desk = { ...TAB_4K, screen: SCREEN_144 }
const NATIVE_144: Desk = { ...TAB_144, userAgent: EDGE, native: true }

const GLOBALS = ['navigator', 'screen', 'matchMedia', 'isTauri', '__TAURI_INTERNALS__'] as const

/** readDeviceHints against this machine's globals; Node's own are put back afterwards. */
function hintsOf(d: Desk): DeviceHints {
  const saved = GLOBALS.map((k) => Object.getOwnPropertyDescriptor(globalThis, k))
  const set = (k: (typeof GLOBALS)[number], value: unknown) => Object.defineProperty(globalThis, k, { value, configurable: true, writable: true })
  try {
    set('navigator', {
      userAgent: d.userAgent,
      // Chromium's client hints: not a mobile device.
      userAgentData: { mobile: false, platform: 'Windows' },
      // No touch screen.
      maxTouchPoints: 0,
      // 8 cores / 16 threads: the logical count.
      hardwareConcurrency: 16,
      // 16 GB or more: Chromium reports powers of two capped at 8.
      deviceMemory: 8,
    })
    set('screen', d.screen)
    // A mouse: the primary pointer is fine.
    set('matchMedia', (query: string) => ({ matches: false, media: query }))
    if (d.native) {
      // What Tauri v2 injects before the page runs.
      set('isTauri', true)
      set('__TAURI_INTERNALS__', { invoke: () => Promise.resolve(null) })
    }
    return readDeviceHints(d.adapter)
  } finally {
    GLOBALS.forEach((k, i) => {
      const was = saved[i]
      if (was) Object.defineProperty(globalThis, k, was)
      else Reflect.deleteProperty(globalThis, k)
    })
  }
}

type Host = NonNullable<SipocSnapshot['process']['host']>
interface Url { quality?: 'auto' | number; fps?: number; cinema?: boolean }
interface Boot { hints: DeviceHints; profile: DeviceProfile; agents: number; host: Host; governor: Governor }

/**
 * Engine.create's quality set-up, step for step: the profile from the hints, the crowd unless ?crowd says, the host the
 * snapshot reports (process.host), the automatic range, ?fps as the target, the camera's period unless ?cinema=0, and
 * ?quality pinning a tier.
 */
function boot(d: Desk, url: Url = {}): Boot {
  const hints = hintsOf(d)
  const profile = profileDevice(hints)
  const range = tierRange(profile)
  const fps = url.fps ?? 0
  const targetMs = fps > 0 ? 1000 / fps : undefined
  const pacerMs = url.cinema === false ? undefined : 1000 / CINEMA.fps
  const quality = url.quality ?? 'auto'
  const governor = quality === 'auto'
    ? new Governor({ tier: profile.startTier, auto: true, targetMs, pacerMs, ...range })
    : new Governor({ tier: quality, auto: false, targetMs, pacerMs, ...range })
  return { hints, profile, agents: defaultAgents(profile), host: hints.host ?? 'browser', governor }
}

// ---------------------------------------------------------------------------------------------------
// Synthetic load

const hz = (rate: number) => 1000 / rate
/** A frame that costs `cost` ms waits for the next vsync of a `rate` Hz display. */
const vsync = (rate: number, cost: number) => Math.max(1, Math.ceil(cost / hz(rate) - 1e-9)) * hz(rate)
/** Seeded uniform [0, 1). */
const lcg = (seed: number) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
const near = (x: number, y: number, eps = 1e-6) => Math.abs(x - y) <= eps

/**
 * A drawn frame's cost on this machine at the defaults (14,000 pedestrians, ?scale=1 on 2560 × 1440 CSS pixels), ms,
 * Minimal…Ultra: every tier inside one 60 Hz refresh; at 144 Hz Minimal to High inside one (144 FPS) and Ultra in two
 * (72 FPS, inside the band).
 */
const DEFAULTS = [3.4, 4.2, 5.3, 6.2, 9.4] as const
/**
 * The README's deliberate overload, 60,000 pedestrians at 2× pixels (?crowd=60000&scale=2), ms: the crowd's simulation
 * alone takes most of a 60 Hz frame and the tiers do not scale it, so even Minimal misses the 60 FPS floor ("only a
 * smaller crowd could help"). At 60 Hz: 20 FPS at High and Ultra, 30 below; at 144 Hz: 21 to 48 FPS.
 */
const OVERLOAD = [19, 23, 28, 36, 44] as const
/** The defaults at ?scale=1.5 (2.25× the pixels): Ultra takes three 144 Hz refreshes (48 FPS), High and Medium two. */
const SCALE_15 = [5.2, 6.5, 8.4, 10.5, 16] as const
/** An animation frame the cinema camera does not draw (input, the physics step request, haptics), ms. */
const IDLE = 2.5
/** rAF timestamps sit on the vsync grid give or take this much, ms (deterministic). */
const JITTER = 0.5

interface Load {
  /** The display's refresh, Hz: every frame waits for the next vsync. */
  hz: number
  /** A drawn frame's cost at a tier, ms, `t` seconds into the scenario: the next rAF comes that many refreshes later. */
  drawn: (tier: number, t: number) => number
  /** The camera's k-th drawn frame missed its slot: drawn, but not presented (governor.test.ts's camera behind). */
  missed?: (k: number, tier: number) => boolean
}

/** A cost table with ±`spread` deterministic noise per frame. */
function table(rate: number, costs: readonly number[], seed: number, spread = 0.05): Load {
  const rnd = lcg(seed)
  return { hz: rate, drawn: (tier) => costs[tier] * (1 + spread * (2 * rnd() - 1)) }
}
/** The defaults with a dropped frame now and then (one in 200 takes an extra refresh): steady, inside the budget. */
function steady(rate: number, seed = 3): Load {
  const rnd = lcg(seed), base = table(rate, DEFAULTS, seed + 1)
  return { hz: rate, drawn: (tier, t) => base.drawn(tier, t) + (rnd() < 0.005 ? hz(rate) : 0) }
}

export interface TraceRow { scenario: string; t: number; fps: number; camera: number | null; tier: number }
interface Change { t: number; from: number; tier: number; reason: string }

/**
 * The frame loop as engine.ts runs it: every animation frame feeds sample() its rAF interval; under the cinema camera
 * the engine's FramePacer decides which frames are drawn, and each drawn one is reported to present() unless the load
 * says the camera missed it. A drawn frame's cost sets when the next rAF comes (whole refreshes); an undrawn one costs
 * IDLE. Records every tier change, the phase starts, the presents, and one trace row per simulated second (the frames
 * and presents that ended in that second, and the tier at its end).
 */
class Loop {
  readonly name: string
  readonly g: Governor
  readonly changes: Change[] = []
  readonly rows: TraceRow[] = []
  /** When each run() began, s. */
  readonly phases: number[] = []
  /** When each present() was called, s. */
  readonly presented: number[] = []
  private readonly pacer: FramePacer | null
  private readonly rnd = lcg(29)
  private readonly start = 1000
  private now = 1000
  private offset = 0
  private nextMs = Number.NaN
  private k = 0
  private frames = 0
  private shown = 0
  private mark = 2000
  private last: number

  constructor(name: string, g: Governor) {
    this.name = name
    this.g = g
    this.last = g.tier
    this.pacer = g.pacer ? new FramePacer(CINEMA.fps) : null
    this.rows.push(this.row(0))
  }

  /** Seconds since the scenario began. */
  get t(): number { return (this.now - this.start) / 1000 }

  run(seconds: number, load: Load): this {
    this.phases.push(this.t)
    const end = this.now + seconds * 1000
    if (Number.isNaN(this.nextMs)) this.nextMs = hz(load.hz)
    while (this.now < end) {
      const ms = this.nextMs
      this.now += ms
      while (this.now > this.mark) {
        this.rows.push(this.row((this.mark - this.start) / 1000))
        this.frames = this.shown = 0
        this.mark += 1000
      }
      this.frames++
      const r = this.g.sample(ms, this.now)
      if (r !== null) {
        this.changes.push({ t: this.t, from: this.last, tier: r, reason: this.g.reason })
        this.last = r
      }
      let drawn = true
      if (this.pacer !== null) {
        drawn = this.pacer.tick(this.now)
        if (drawn && !(load.missed?.(this.k++, this.g.tier) ?? false)) {
          this.g.present(this.now)
          this.presented.push(this.t)
          this.shown++
        }
      }
      const jitter = JITTER * (2 * this.rnd() - 1)
      this.nextMs = vsync(load.hz, drawn ? load.drawn(this.g.tier, this.t) : IDLE) + jitter - this.offset
      this.offset = jitter
    }
    return this
  }

  /** The tiers it went through, in order. */
  get path(): number[] { return this.changes.map((c) => c.tier) }

  /** Changes from `from` s (inclusive) to `to` s. */
  between(from: number, to = Infinity): Change[] { return this.changes.filter((c) => c.t >= from && c.t < to) }

  /** Presents in the `seconds` before `t`, as a share of the camera's 24 a second. */
  cameraShare(t: number, seconds: number): number {
    return this.presented.filter((p) => p > t - seconds && p <= t).length / (seconds * CINEMA.fps)
  }

  private row(t: number): TraceRow {
    return { scenario: this.name, t, fps: this.frames, camera: this.pacer ? this.shown : null, tier: this.g.tier }
  }
}

// ---------------------------------------------------------------------------------------------------
// Scenarios (each deterministic, run once and shared by the tests and the trace)

/** The seconds each timed scenario's phases begin at. */
const OVERLOAD_60 = { on: 20, lift: 45, again: 150, liftAgain: 175, end: 300 } as const
const OVERLOAD_144 = { on: 20, lift: 80, end: 200 } as const

/**
 * The camera's phases at the defaults (the animation frames stay at the display's rate throughout): 20 s with all 24
 * presented; 30 s with one in every 12 missed at Ultra (22 a second, one in each half second, 91.7 %); 10 s with one in
 * every 6 missed at Ultra (20 a second, 83 %); 40 s with one in 24 missed at every tier (95.8 %: above the floor, under
 * the 97 % a step up needs), long enough for Ultra's 20 s back-off to run out inside it; 60 s with all presented again.
 */
function camera(name: string, d: Desk, rate: number): Loop {
  const base = table(rate, DEFAULTS, 41)
  const missing = (f: (k: number, tier: number) => boolean): Load => ({ ...base, missed: f })
  return new Loop(name, boot(d).governor)
    .run(20, base)
    .run(30, missing((k, tier) => tier === 4 && k % 12 === 0))
    .run(10, missing((k, tier) => tier === 4 && k % 6 === 0))
    .run(40, missing((k) => k % 24 === 0))
    .run(60, base)
}

/**
 * A load that swings across Ultra's threshold every 40 s for 10 minutes (a scene, the weather, traffic): at its peak
 * Ultra misses the 60 FPS floor, at its trough it holds it, and High holds it throughout.
 */
function oscillating(name: string, d: Desk, rate: number, costs: readonly number[], swing: number): Loop {
  const rnd = lcg(5)
  const load: Load = {
    hz: rate,
    drawn: (tier, t) => costs[tier] * (1 + swing * Math.sin((2 * Math.PI * t) / 40)) + 0.6 * (2 * rnd() - 1),
  }
  return new Loop(name, boot(d, { cinema: false }).governor).run(600, load)
}

const SCENARIOS = {
  // 1. Boot at the defaults (the camera on): the tier the profile picks, from the first frame.
  'boot-tab-4k60': () => new Loop('boot-tab-4k60', boot(TAB_4K).governor).run(30, table(60, DEFAULTS, 11)),
  'boot-native-4k60': () => new Loop('boot-native-4k60', boot(NATIVE_4K).governor).run(30, table(60, DEFAULTS, 11)),
  'boot-tab-144': () => new Loop('boot-tab-144', boot(TAB_144).governor).run(30, table(144, DEFAULTS, 11)),
  'boot-native-144': () => new Loop('boot-native-144', boot(NATIVE_144).governor).run(30, table(144, DEFAULTS, 11)),
  'boot-tab-rdna2-4k60': () => new Loop('boot-tab-rdna2-4k60', boot({ ...TAB_4K, adapter: RDNA2 }).governor).run(30, table(60, DEFAULTS, 11)),
  'boot-tab-4k100pct-60': () => new Loop('boot-tab-4k100pct-60', boot({ ...TAB_4K, screen: SCREEN_4K_100 }).governor).run(30, table(60, DEFAULTS, 11)),
  // 2. Steady frames inside the budget, 10 minutes, with and without the camera.
  'steady-60': () => new Loop('steady-60', boot(TAB_4K, { cinema: false }).governor).run(600, steady(60)),
  'steady-60-cinema': () => new Loop('steady-60-cinema', boot(TAB_4K).governor).run(600, steady(60)),
  'steady-144': () => new Loop('steady-144', boot(TAB_144, { cinema: false }).governor).run(600, steady(144)),
  'steady-144-cinema': () => new Loop('steady-144-cinema', boot(TAB_144).governor).run(600, steady(144)),
  'steady-144-cinema-scale1.5': () => new Loop('steady-144-cinema-scale1.5', boot(TAB_144).governor).run(600, table(144, SCALE_15, 13)),
  'scale1.5-144-nocinema': () => new Loop('scale1.5-144-nocinema', boot(TAB_144, { cinema: false }).governor).run(60, table(144, SCALE_15, 13)),
  // 3 and 4. The README's overload and the climb back; a repeat within the back-off's memory; a swinging load.
  'overload-60': () => {
    const o = OVERLOAD_60
    return new Loop('overload-60', boot(TAB_4K, { cinema: false }).governor)
      .run(o.on, table(60, DEFAULTS, 17))
      .run(o.lift - o.on, table(60, OVERLOAD, 19))
      .run(o.again - o.lift, table(60, DEFAULTS, 23))
      .run(o.liftAgain - o.again, table(60, OVERLOAD, 29))
      .run(o.end - o.liftAgain, table(60, DEFAULTS, 31))
  },
  'overload-144': () => {
    const o = OVERLOAD_144
    return new Loop('overload-144', boot(TAB_144, { cinema: false }).governor)
      .run(o.on, table(144, DEFAULTS, 17))
      .run(o.lift - o.on, table(144, OVERLOAD, 19))
      .run(o.end - o.lift, table(144, DEFAULTS, 23))
  },
  'oscillating-60': () => oscillating('oscillating-60', TAB_4K, 60, [7, 8.5, 10.5, 12.5, 15.2], 0.13),
  'oscillating-144': () => oscillating('oscillating-144', TAB_144, 144, [3.4, 4.2, 5.3, 6.2, 12.4], 0.16),
  // 5. The camera's presented-frame rule, the animation frames fine throughout.
  'camera-60': () => camera('camera-60', TAB_4K, 60),
  'camera-144': () => camera('camera-144', TAB_144, 144),
  // 6. A pinned tier (?quality) through overload, a camera behind, and headroom; the ?fps targets.
  'pinned-ultra': () => new Loop('pinned-ultra', boot(TAB_4K, { quality: 4 }).governor)
    .run(20, table(60, DEFAULTS, 37))
    .run(30, table(60, OVERLOAD, 43))
    .run(30, { ...table(60, DEFAULTS, 47), missed: (k) => k % 3 === 0 })
    .run(20, table(60, DEFAULTS, 53)),
  'pinned-minimal': () => new Loop('pinned-minimal', boot(TAB_4K, { quality: 0 }).governor).run(60, table(60, DEFAULTS, 59)),
  'fps60-144': () => new Loop('fps60-144', boot(TAB_144, { cinema: false, fps: 60 }).governor).run(180, table(144, DEFAULTS, 61)),
  'fps72-144': () => new Loop('fps72-144', boot(TAB_144, { cinema: false, fps: 72 }).governor).run(180, table(144, DEFAULTS, 61)),
  'fps75-144': () => new Loop('fps75-144', boot(TAB_144, { cinema: false, fps: 75 }).governor).run(180, table(144, DEFAULTS, 61)),
  'fps90-144': () => new Loop('fps90-144', boot(TAB_144, { cinema: false, fps: 90 }).governor).run(180, table(144, DEFAULTS, 61)),
  'fps90-144-cinema': () => new Loop('fps90-144-cinema', boot(TAB_144, { fps: 90 }).governor).run(180, table(144, DEFAULTS, 61)),
  'fps90-4k60': () => new Loop('fps90-4k60', boot(TAB_4K, { cinema: false, fps: 90 }).governor).run(60, table(60, DEFAULTS, 61)),
} satisfies Record<string, () => Loop>

type Name = keyof typeof SCENARIOS
const ran = new Map<Name, Loop>()
function scenario(name: Name): Loop {
  let loop = ran.get(name)
  if (!loop) {
    loop = SCENARIOS[name]()
    ran.set(name, loop)
  }
  return loop
}

/** Every scenario, run (once) in order: its name, tier changes ({ t s, from, tier, reason }) and per-second trace. */
export function desktopRuns(): { name: string; changes: readonly Change[]; rows: readonly TraceRow[] }[] {
  return (Object.keys(SCENARIOS) as Name[]).map((name) => {
    const loop = scenario(name)
    return { name, changes: loop.changes, rows: loop.rows }
  })
}

export const DESKTOP_TRACE = fileURLToPath(new URL('../../docs/autoscaler/desktop.csv', import.meta.url))
const HEADER = 'scenario,t_seconds,fps,camera_fps_or_blank,tier_index,tier_name'

/** Every scenario's trace as CSV, one row per simulated second. */
export function desktopTraceCsv(): string {
  const lines = [HEADER]
  for (const { rows } of desktopRuns()) {
    for (const r of rows) lines.push([r.scenario, r.t, r.fps, r.camera ?? '', r.tier, TIERS[r.tier].label].join(','))
  }
  return `${lines.join('\n')}\n`
}

/** Writes desktopTraceCsv() to docs/autoscaler/desktop.csv (the last test does, with AUTOSCALER_TRACE=1 only). */
export function writeDesktopTrace(path = DESKTOP_TRACE): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, desktopTraceCsv())
  return path
}

// ---------------------------------------------------------------------------------------------------
// 1. The profile: Ultra and the full crowd, in a tab and in the native shell

test('profile: the console-class desktop as its globals describe it — Ultra, 14,000 pedestrians, the whole range', () => {
  for (const [d, label] of [[TAB_4K, 'Chrome tab, 4K panel'], [{ ...TAB_4K, userAgent: EDGE }, 'Edge tab, 4K panel'], [TAB_144, 'Chrome tab, 144 Hz monitor']] as const) {
    const b = boot(d)
    assert.deepEqual(b.hints, {
      adapter: 'nvidia / ampere', userAgent: d.userAgent, mobileHint: false, maxTouchPoints: 0, coarsePointer: false,
      cores: 16, memoryGb: 8, screenPixels: 2560 * 1440, host: 'browser',
    }, label)
    assert.deepEqual(b.profile, { mobile: false, gpuClass: 'discrete', startTier: 4, lite: false }, label)
    assert.equal(TIERS[b.profile.startTier].label, 'Ultra')
    assert.deepEqual(tierRange(b.profile), { min: 0, max: 4 }, `${label}: the automatic range reaches Ultra`)
    assert.equal(b.agents, 14000, `${label}: the README's full crowd for a desktop GPU`)
    assert.equal(b.agents, CROWD_DEFAULT.full)
    assert.equal(b.host, 'browser')
    assert.equal(b.governor.tier, 4)
    assert.equal(b.governor.auto, true)
    assert.equal(b.governor.pacer, true, 'the cinema camera is on by default')
  }
  assert.equal(readDeviceHints('x').host, 'browser', "Node's own globals are back afterwards: no Tauri window")
})

test('profile: the same machine in the native Tauri v2 shell is recognised (process.host) and profiles as the desktop it is', () => {
  for (const [native, tab] of [[NATIVE_4K, TAB_4K], [NATIVE_144, TAB_144]] as const) {
    const n = boot(native), b = boot(tab)
    assert.equal(n.hints.host, 'native', 'what Tauri injects is recognised')
    assert.equal(n.host, 'native', 'the snapshot says so (engine.ts: process.host = hints.host)')
    assert.equal(n.hints.userAgent, EDGE, 'WebView2: desktop Chromium')
    assert.deepEqual(n.profile, b.profile, 'the same profile as the tab')
    assert.deepEqual(n.profile, { mobile: false, gpuClass: 'discrete', startTier: 4, lite: false })
    assert.equal(n.agents, 14000)
    assert.deepEqual(tierRange(n.profile), tierRange(b.profile))
  }
  // Either marker alone is enough, as nativeHost reads them.
  const only = (k: 'isTauri' | '__TAURI_INTERNALS__', v: unknown) => {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
    try { return readDeviceHints(AMPERE).host } finally { Reflect.deleteProperty(globalThis, k) }
  }
  assert.equal(only('isTauri', true), 'native')
  assert.equal(only('__TAURI_INTERNALS__', {}), 'native')
  assert.equal(only('isTauri', 'yes'), 'browser')
})

test('profile: the RDNA2 card starts on Ultra where the browser names it, on High (full crowd) where not, and the governor climbs to Ultra', () => {
  for (const [adapter, start] of [[RDNA2, 3], [RDNA2_NAMED, 4]] as const) {
    for (const d of [{ ...TAB_4K, adapter }, { ...NATIVE_4K, adapter }, { ...TAB_144, adapter }]) {
      const b = boot(d)
      // Stock Chrome, Edge and WebView2 report "amd / rdna-2" alone. Without the description an AMD card cannot be
      // told from an APU of its architecture, so High is the profile's conservative start for every unnamed AMD part
      // (RDNA3 included: governor.test.ts pins 'amd / rdna-3' at High). Where the browser names the card
      // (RDNA2_NAMED), it starts on Ultra like its NVIDIA Ampere peers of the same 2020 generation (this test found
      // profileDevice's AMD pattern was /rdna[34]/; it is /rdna[234]/, and the \brx\b|radeon pro guard still keeps
      // the RDNA2 APUs out).
      assert.deepEqual(b.profile, { mobile: false, gpuClass: 'discrete', startTier: start, lite: false }, `${adapter} (${d.native ? 'native' : 'tab'})`)
      assert.equal(b.agents, 14000, 'the full crowd either way (Medium or above)')
      assert.deepEqual(tierRange(b.profile), { min: 0, max: 4 })
    }
  }
  // The APU of the same architecture stays integrated, with or without the fix.
  assert.equal(profileDevice({ ...boot(TAB_4K).hints, adapter: 'amd / rdna-2 / AMD Radeon 680M' }).gpuClass, 'integrated')
  // At the defaults the first probe reaches Ultra about 6 s after boot (warm-up, refresh, then 5 s of headroom).
  const climb = scenario('boot-tab-rdna2-4k60')
  assert.equal(climb.rows[0].tier, 3)
  assert.deepEqual(climb.path, [4], JSON.stringify(climb.changes))
  assert.ok(climb.changes[0].t >= 5.5 && climb.changes[0].t <= 7, `Ultra at ${climb.changes[0].t.toFixed(2)} s`)
  assert.equal(climb.changes[0].reason, 'probe')
})

test('profile: the 4K panel at 100 % scaling (3840 × 2160 CSS pixels) starts one tier lower, as governor.ts documents', () => {
  const b = boot({ ...TAB_4K, screen: SCREEN_4K_100 })
  assert.equal(b.hints.screenPixels, 3840 * 2160)
  assert.deepEqual(b.profile, { mobile: false, gpuClass: 'discrete', startTier: 3, lite: false }, '"4K at 100 % scaling": High')
  assert.equal(b.agents, 14000)
  const climb = scenario('boot-tab-4k100pct-60')
  assert.deepEqual(climb.path, [4], 'the first probe takes it to Ultra')
  assert.ok(climb.changes[0].t <= 7)
})

test('boot: Ultra from the first frame for 30 s, in a tab and in the native shell, at 60 and 144 Hz', () => {
  for (const name of ['boot-tab-4k60', 'boot-native-4k60', 'boot-tab-144', 'boot-native-144'] as const) {
    const loop = scenario(name)
    assert.deepEqual(loop.changes, [], name)
    assert.ok(loop.rows.length === 31 && loop.rows.every((r) => r.tier === 4), `${name}: Ultra at every second`)
    // Past the first second, the camera presents its 24.
    assert.ok(loop.rows.slice(2).every((r) => r.camera !== null && Math.abs(r.camera - 24) <= 1), `${name}: ${loop.rows.map((r) => r.camera).join(' ')}`)
  }
  assert.deepEqual(scenario('boot-native-4k60').rows.map((r) => r.tier), scenario('boot-tab-4k60').rows.map((r) => r.tier))
})

// ---------------------------------------------------------------------------------------------------
// 2. Steady frames inside the budget: Ultra held indefinitely at 60 and 144 Hz

test('steady: 10 minutes of frames inside the budget at 60 and 144 Hz hold Ultra, with and without the camera', () => {
  for (const name of ['steady-60', 'steady-60-cinema', 'steady-144', 'steady-144-cinema'] as const) {
    const loop = scenario(name)
    assert.deepEqual(loop.changes, [], `${name}: no spurious step`)
    assert.equal(loop.rows.length, 601)
    assert.ok(loop.rows.every((r) => r.tier === 4), name)
  }
  const fps = (name: Name) => scenario(name).rows.slice(5).map((r) => r.fps)
  // A second holding two or three of the rare drops reads 57–58: the governor rightly ignores it.
  assert.ok(fps('steady-60').every((f) => f >= 56 && f <= 61), 'every frame drawn, at 60 FPS give or take a rare drop')
  assert.ok(fps('steady-144').every((f) => f >= 70 && f <= 73), 'Ultra takes two 144 Hz refreshes: 72 FPS, inside the band')
  assert.ok(near(scenario('steady-60').g.targetMs, hz(60), 1e-3))
  assert.ok(near(scenario('steady-144').g.targetMs, hz(72), 1e-3), `the refresh read from Ultra's own frames: ${scenario('steady-144').g.targetMs}`)
  for (const name of ['steady-60-cinema', 'steady-144-cinema'] as const) {
    const cam = scenario(name).rows.slice(2).map((r) => r.camera ?? 0)
    assert.ok(cam.every((c) => c >= 23 && c <= 25), `${name}: 24 presented every second (${Math.min(...cam)}–${Math.max(...cam)})`)
  }
})

test('steady: at 144 Hz under the camera the animation frames are held at the 60 FPS floor, not the 90 a 144 Hz display would get', () => {
  const film = scenario('steady-144-cinema')
  assert.ok(near(film.g.targetMs, hz(60), 1e-3), `the 60 FPS floor (got ${film.g.targetMs.toFixed(3)} ms)`)
  assert.ok(film.rows.slice(5).every((r) => r.fps >= 110), 'yet the animation frames still run near the display rate (input, physics)')
  // So a tier whose drawn frames take three 144 Hz refreshes (?scale=1.5: Ultra at 48 FPS when every frame is drawn)
  // keeps Ultra under the camera for 10 minutes, where without it the same frames step down.
  const heavy = scenario('steady-144-cinema-scale1.5')
  assert.deepEqual(heavy.changes, [])
  assert.ok(near(heavy.g.targetMs, hz(60), 1e-3))
  assert.ok(heavy.rows.slice(2).every((r) => r.camera !== null && r.camera >= 23), 'the camera presents its 24')
  const plain = scenario('scale1.5-144-nocinema')
  assert.equal(plain.changes[0]?.tier, 3, JSON.stringify(plain.changes))
  assert.equal(plain.changes[0].reason, 'frames below 60 FPS')
  assert.ok(plain.changes[0].t > 2, 'after more than 2 s below 60')
})

// ---------------------------------------------------------------------------------------------------
// 3. The README's overload, walked down one tier at a time

test('overload: 60,000 pedestrians at 2× pixels walks Ultra → High → Medium → Low → Minimal, one tier per window, never below', () => {
  for (const [name, on, lift] of [['overload-60', 1, 2], ['overload-144', 1, 2]] as const) {
    const loop = scenario(name)
    const onset = loop.phases[on], end = loop.phases[lift]
    const down = loop.between(onset, end)
    assert.deepEqual(down.map((c) => c.tier), [3, 2, 1, 0], `${name}: ${JSON.stringify(down)}`)
    assert.ok(down.every((c) => c.reason === 'frames below 60 FPS'))
    const first = down[0].t - onset
    assert.ok(first > 2 && first <= 2.5, `${name}: first step ${first.toFixed(2)} s after the frames fell below 60`)
    for (let i = 1; i < down.length; i++) {
      const gap = down[i].t - down[i - 1].t
      // The 1.5 s cooldown, then more than 2 s below 60 judged at the new tier.
      assert.ok(gap >= 3.45 && gap <= 4, `${name}: step ${i + 1} ${gap.toFixed(2)} s after the one before`)
    }
    // Held at Minimal for the rest of the overload, every second of it.
    const atMin = loop.rows.filter((r) => r.t > down[3].t + 1 && r.t <= end)
    assert.ok(atMin.length >= 10 && atMin.every((r) => r.tier === 0), `${name}: ${atMin.length} s at Minimal`)
    assert.ok(loop.rows.every((r) => r.tier >= 0 && r.tier <= 4))
    assert.ok(atMin.every((r) => r.fps < 57), `${name}: Minimal still misses 60 (only a smaller crowd could help)`)
  }
  // The second overload, 105 s later, walks down the same way.
  const again = scenario('overload-60')
  const down = again.between(again.phases[3], again.phases[4])
  assert.deepEqual(down.map((c) => c.tier), [3, 2, 1, 0])
  assert.ok(down[0].t - again.phases[3] > 2 && down[0].t - again.phases[3] <= 2.5)
})

// ---------------------------------------------------------------------------------------------------
// 4. The climb back: one tier at a time, after the headroom hold, the cooldown and the back-off

/** When the scenario last stepped down from `tier` before `t`. */
const leftAt = (loop: Loop, tier: number, t: number) => loop.changes.filter((c) => c.t < t && c.from === tier && c.tier === tier - 1).at(-1)?.t ?? -Infinity

test('recovery: the load lifts and it climbs back one tier at a time to Ultra, after the headroom hold, cooldowns and back-offs', () => {
  const cases = [
    // [scenario, lift phase, next phase or end, back-off: 20 s after a tier's first step down, 40 s after a second within 10 minutes]
    ['overload-60', 2, 3, 20],
    ['overload-60', 4, 5, 40],
    ['overload-144', 2, 3, 20],
  ] as const
  for (const [name, liftPhase, nextPhase, backoff] of cases) {
    const loop = scenario(name)
    const lift = loop.phases[liftPhase], next = loop.phases[nextPhase] ?? Infinity
    const up = loop.between(lift, next)
    const label = `${name} from ${lift.toFixed(1)} s`
    assert.deepEqual(up.map((c) => c.tier), [1, 2, 3, 4], `${label}: ${JSON.stringify(up)}`)
    assert.ok(up.every((c) => c.reason === 'probe'))
    // The headroom hold: a step up needs 5 s whose 97th percentile is on target, so the first comes once the slow
    // frames are (all but 3 % of) out of that window.
    assert.ok(up[0].t - lift >= 4.5, `${label}: first step up ${(up[0].t - lift).toFixed(2)} s after the load lifted`)
    for (let i = 0; i < up.length; i++) {
      // The cooldown and a fresh 5 s hold after each step.
      if (i > 0) assert.ok(up[i].t - up[i - 1].t >= 6.5, `${label}: ${(up[i].t - up[i - 1].t).toFixed(2)} s between steps up`)
      // The back-off: never back to a tier sooner than this after it was left.
      const left = leftAt(loop, up[i].tier, up[i].t)
      assert.ok(up[i].t - left >= backoff, `${label}: back to ${TIERS[up[i].tier].label} ${(up[i].t - left).toFixed(1)} s after leaving it`)
    }
    const until = Number.isFinite(next) ? next : loop.t
    assert.ok(loop.rows.filter((r) => r.t > up[3].t + 1 && r.t <= until).every((r) => r.tier === 4), `${label}: Ultra held afterwards`)
  }
  // Where the back-off is the longer wait, it decides: the first climb at 60 Hz starts 20 s after Low was left,
  // not 5 s after the lift.
  const o = scenario('overload-60')
  const first = o.between(o.phases[2])[0]
  assert.ok(near(first.t - leftAt(o, 1, first.t), 20, 0.15), `${(first.t - leftAt(o, 1, first.t)).toFixed(2)} s`)
  const repeat = o.between(o.phases[4])[0]
  assert.ok(near(repeat.t - leftAt(o, 1, repeat.t), 40, 0.15), `the repeat waits twice as long: ${(repeat.t - leftAt(o, 1, repeat.t)).toFixed(2)} s`)
})

test('recovery: a load swinging across the threshold every 40 s for 10 minutes does not swing the tier', () => {
  for (const name of ['oscillating-60', 'oscillating-144'] as const) {
    const loop = scenario(name)
    const n = loop.changes.length
    // Unchecked it would flip twice a cycle: 30 times in 10 minutes, shadows and textures with it.
    assert.ok(n >= 2 && n <= 10, `${name}: ${n} transitions in 10 minutes: ${loop.changes.map((c) => `${c.t.toFixed(1)}→${c.tier}`).join(' ')}`)
    assert.ok(loop.rows.every((r) => r.tier >= 3), `${name}: never below High, which holds throughout`)
    assert.ok(loop.changes.every((c, i) => i === 0 || Math.abs(c.tier - loop.changes[i - 1].tier) === 1))
    // Each return to Ultra waits longer than the one before (the back-off doubles, to its 5-minute cap).
    const ups = loop.changes.filter((c) => c.tier === 4).map((c) => c.t)
    const waits = ups.map((t) => t - leftAt(loop, 4, t))
    for (let i = 1; i < waits.length; i++) assert.ok(waits[i] >= waits[i - 1] * 1.5 || waits[i] >= 280, `${name}: waits ${waits.map((w) => w.toFixed(0)).join(', ')} s`)
    const last = loop.rows.slice(-120)
    assert.ok(new Set(last.map((r) => r.tier)).size <= 2 && loop.between(480).length <= 2, `${name}: settled by the last 2 minutes`)
  }
})

// ---------------------------------------------------------------------------------------------------
// 5. The camera's presented frames drive the tier, while the animation frames are fine

test('camera: under 90 % of its frames in every half second for more than 2 s steps down; 97 % for 5 s steps back up', () => {
  for (const name of ['camera-60', 'camera-144'] as const) {
    const loop = scenario(name)
    const [, oneMissed, twoMissed, between, back] = loop.phases
    const rate = name === 'camera-60' ? 60 : 144
    // The animation frames are fine throughout: every second at the display's rate (or Ultra's 120 at 144 Hz).
    assert.ok(loop.rows.slice(2).every((r) => r.fps >= (rate === 60 ? 58 : 110)), `${name}: animation frames fine`)
    // All 24, then one missed in each half second (22 a second, 91.7 %): Ultra held.
    assert.deepEqual(loop.between(0, twoMissed), [], `${name}: 22 a second holds`)
    assert.ok(loop.rows.filter((r) => r.t > oneMissed + 1 && r.t <= twoMissed).every((r) => r.camera === 22 && r.tier === 4))
    // Two missed in each (20 a second, 83 %): High, more than 2 s later, for the camera's sake alone.
    const down = loop.between(twoMissed, between)
    assert.deepEqual(down.map((c) => c.tier), [3], `${name}: ${JSON.stringify(down)}`)
    assert.equal(down[0].reason, 'camera behind')
    const dt = down[0].t - twoMissed
    assert.ok(dt > 2 && dt <= 3, `${name}: ${dt.toFixed(2)} s after the camera fell behind`)
    // 23 a second at every tier (95.8 %): above the floor, under the 97 % a step up needs. High holds, though Ultra's
    // back-off has long passed and the animation frames have the headroom.
    assert.deepEqual(loop.between(between, back), [], `${name}: no probe at 95.8 %`)
    assert.ok(back - (down[0].t + 20) >= 20, `${name}: Ultra's 20 s back-off ran out ${(back - down[0].t - 20).toFixed(1)} s before the phase ended`)
    // All 24 again: back to Ultra once the last 5 s hold 97 % of the camera's frames, and not before.
    const up = loop.between(back)
    assert.deepEqual(up.map((c) => c.tier), [4], `${name}: ${JSON.stringify(up)}`)
    assert.equal(up[0].reason, 'probe')
    assert.ok(loop.cameraShare(up[0].t, 5) >= 0.97, `${name}: ${(100 * loop.cameraShare(up[0].t, 5)).toFixed(1)} % at the probe`)
    assert.ok(loop.cameraShare(up[0].t - 0.15, 5) < 0.975, 'it came as soon as the 5 s share allowed')
    for (let t = between + 5; t < up[0].t - 0.2; t += 0.5) assert.ok(loop.cameraShare(t, 5) < 0.97, `${name}: under 97 % at ${t} s`)
    assert.ok(loop.rows.filter((r) => r.t > up[0].t + 1).every((r) => r.tier === 4))
  }
})

test('camera: the README\'s "(two frames missed in each)": one missed in every half second is 11 of 12 (91.7 %) and holds', () => {
  // The 90 % floor in half-second slices: one missed leaves 11 of 12 (91.7 %), above the floor, and holds (as
  // governor.test.ts also pins at 22 a second); it takes two missed in every slice (10 of 12) to step down. (This test
  // found the README and GOV.presentFloor's comment glossing it as "a frame missed in each"; both now say two.)
  const loop = scenario('camera-60')
  const [, oneMissed, twoMissed] = loop.phases
  assert.deepEqual(loop.between(oneMissed, twoMissed), [])
  assert.ok(near(loop.cameraShare(twoMissed, 10), 22 / 24, 0.01))
  assert.ok(Math.ceil((500 / (1000 / CINEMA.fps)) * 0.9) === 11, 'the floor in a half-second slice: 11 of 12')
})

// ---------------------------------------------------------------------------------------------------
// 6. A pinned tier never moves; ?fps targets are held as given

test('pinned: ?quality=0…4 never moves — not for the overload, a camera behind, or headroom', () => {
  const ultra = scenario('pinned-ultra')
  assert.deepEqual(ultra.changes, [])
  assert.ok(ultra.rows.every((r) => r.tier === 4))
  assert.equal(ultra.g.auto, false)
  assert.ok(ultra.rows.some((r) => r.fps <= 21) && ultra.rows.some((r) => r.camera !== null && r.camera <= 16), 'it was overloaded and the camera behind')
  const minimal = scenario('pinned-minimal')
  assert.deepEqual(minimal.changes, [], 'no probe up from a pinned Minimal')
  assert.ok(minimal.rows.every((r) => r.tier === 0))
  for (let q = 0; q <= 4; q++) {
    for (const d of [TAB_4K, NATIVE_144]) {
      const loop = new Loop(`pinned-${q}`, boot(d, { quality: q }).governor)
        .run(10, table(d.screen === SCREEN_4K ? 60 : 144, DEFAULTS, 67))
        .run(20, table(60, OVERLOAD, 71))
        .run(20, { ...table(60, DEFAULTS, 73), missed: (k) => k % 3 === 0 })
        .run(30, table(60, DEFAULTS, 79))
      assert.deepEqual(loop.changes, [], `?quality=${q}`)
      assert.ok(loop.rows.every((r) => r.tier === q))
    }
  }
})

test('?fps: a target in 60–90 is held as given — where the frames meet it within 5 % the tier holds, where not it steps down', () => {
  for (const [fps, tier] of [[60, 4], [72, 4], [75, 4], [90, 3]] as const) {
    const loop = scenario(`fps${fps}-144`)
    assert.ok(near(loop.g.targetMs, 1000 / fps, 1e-9), `?fps=${fps}: ${loop.g.targetMs} ms held, never re-estimated`)
    // Ultra's 72 FPS meets 60, 72 and 75 (within the 5 % tolerance); 90 needs High's 144.
    assert.equal(loop.rows.at(-1)?.tier, tier, `?fps=${fps}: ${JSON.stringify(loop.changes)}`)
  }
  for (const fps of [60, 72, 75] as const) assert.deepEqual(scenario(`fps${fps}-144`).changes, [])
  const ninety = scenario('fps90-144')
  assert.equal(ninety.changes[0].tier, 3)
  assert.ok(ninety.changes[0].t > 2, 'more than 2 s below the target')
  assert.ok(ninety.rows.slice(1, 3).every((r) => r.fps >= 70 && r.tier === 4), 'Ultra ran at 72 FPS before it')
  // The step names the target held: the frames ran at 72 FPS, short of the explicit 90 alone (this test found every
  // frame-rate step labelled 'frames below 60 FPS').
  assert.equal(ninety.changes[0].reason, 'frames below target')
  assert.ok(ninety.changes.length <= 6 && ninety.rows.filter((r) => r.tier === 3).length >= 150, `probes of Ultra back off: ${JSON.stringify(ninety.changes)}`)
  // An explicit target wins over the camera's 60 FPS floor; under the camera only 24 frames a second are drawn, so
  // Ultra meets 90 there.
  const film = scenario('fps90-144-cinema')
  assert.ok(near(film.g.targetMs, hz(90), 1e-9))
  assert.deepEqual(film.changes, [])
  // A target the display cannot reach is held as given too: ?fps=90 on the 60 Hz 4K panel walks to Minimal and stays.
  const blind = scenario('fps90-4k60')
  assert.deepEqual(blind.path, [3, 2, 1, 0])
  assert.ok(near(blind.g.targetMs, hz(90), 1e-9))
  // Without ?fps the target is estimated and held within 60–90.
  assert.ok(near(scenario('steady-60').g.targetMs, hz(60), 1e-3))
  assert.ok(near(scenario('overload-144').g.targetMs, hz(90), 1e-3), `144 Hz, once frames reach it: ${scenario('overload-144').g.targetMs}`)
})

// ---------------------------------------------------------------------------------------------------
// The trace

test('trace: one CSV row per simulated second of every scenario (written only with AUTOSCALER_TRACE=1)', () => {
  const csv = desktopTraceCsv()
  const lines = csv.trimEnd().split('\n')
  assert.equal(lines[0], HEADER)
  const runs = desktopRuns()
  assert.equal(lines.length - 1, runs.reduce((n, r) => n + r.rows.length, 0))
  for (const line of lines.slice(1)) {
    const [name, t, fps, cam, tier, label] = line.split(',')
    assert.ok(name in SCENARIOS && Number.isInteger(Number(t)) && Number.isInteger(Number(fps)), line)
    assert.ok(cam === '' || Number.isInteger(Number(cam)), line)
    assert.equal(TIERS[Number(tier)].label, label, line)
  }
  assert.ok(lines.some((l) => l.startsWith('steady-60,') && l.split(',')[3] === ''), 'blank camera column without the camera')
})

if (process.env.AUTOSCALER_TRACE === '1') {
  test('trace: AUTOSCALER_TRACE=1 writes docs/autoscaler/desktop.csv', () => {
    const path = writeDesktopTrace()
    assert.equal(readFileSync(path, 'utf8'), desktopTraceCsv())
  })
}
