// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the autoscaler that keeps the frame rate in the 60–90 FPS band on every
 * device that runs WebGPU, from flagship phones to high-end desktop GPUs, in a browser tab or a native shell
 * (a Tauri v2 window: WebView2 on Windows 11). A pure device profile (GPU family, form factor, memory, screen)
 * picks the starting quality tier and, unless the page says, how many pedestrians to simulate; the governor
 * then watches the requestAnimationFrame intervals. Under the cinema camera it holds the camera's 24 frames a
 * second as well: the animation frames need only 60 FPS (input and physics), the camera must present all of its
 * frames, and a tier that cannot do both steps down. The operator's rule steps down: FPS below 60 for more than 2 s drops
 * one tier, and every step down thins the drawn crowd and (below High) lowers the procedural texture
 * resolution, along with render scale, shadows and post. Steps up are slow probes toward the 60–90
 * target, backed off harder after every failure. It is silent: a tier change raises no toast and needs
 * no settings menu. Below Minimal sits Lite (tier -1, outside the TIERS table so no existing index moves): only a
 * lite device profile (an entry-level phone GPU such as a Mali-G52, or ?lite=1) reaches it automatically, and the
 * same profile makes the boot itself lighter (engine.ts: fewer pedestrians and cars, no post chain compiled). While the
 * in-page model works the city can be held under a lower tier (hold()): the device is busy with the model, so nothing
 * that happens under the hold counts against a tier, and the release returns the tier the city had.
 * What breaks if it is removed? Quality is frozen at one tier: phones stutter at desktop settings,
 * desktops look like phones at phone settings, and the terminal's `quality` command drives nothing.
 */
import type { QualityState } from './telemetry.ts'

export interface QualityKnobs {
  label: string
  /** Multiplier on the base pixel ratio. */
  renderScale: number
  shadows: boolean
  /** Sun shadow map edge, texels (used while shadows are on). */
  shadowMapSize: number
  /** Bloom, vignette, explicit tone mapping and FXAA. */
  post: boolean
  /** Golden-hour sun shafts in the post chain (volumetrics.ts); needs `post`. Ultra only. */
  volumetrics: boolean
  /** Fraction of pedestrians beyond nearRadius that are drawn (0..1). */
  crowdDensity: number
  /** Pedestrians closer than this use the detailed mesh, m. */
  lodDistance: number
  /** Pedestrians closer than this are always drawn (their shadows fall into view), m. */
  nearRadius: number
  /** No pedestrian is drawn beyond this, m. */
  maxDistance: number
  /** Procedural (FBM) texture resolution, texels per edge; one of fbmTexture.ts FBM_SIZES. */
  textureSize: number
}

const frozen = (k: QualityKnobs): QualityKnobs => Object.freeze(k)

/** 0 = older phones … 4 = high-end desktop GPUs. Every step down removes real GPU work (pixels, shadow
 *  pass texels, crowd vertices) and culls the drawn crowd (the InstancedMesh draw counts), down to a few
 *  percent of Ultra's at Minimal; governor.test.ts models the GPU cull to hold that. High keeps the
 *  pre-governor look apart from a slightly thinner far crowd; below it every step also lowers the
 *  procedural texture resolution (256² → 192² → 128² → 64²). Ultra alone adds the golden-hour sun shafts. */
export const TIERS: readonly QualityKnobs[] = Object.freeze([
  frozen({ label: 'Minimal', renderScale: 0.65, shadows: false, shadowMapSize: 1024, post: false, volumetrics: false, crowdDensity: 0.2, lodDistance: 12, nearRadius: 10, maxDistance: 110, textureSize: 64 }),
  frozen({ label: 'Low', renderScale: 0.75, shadows: false, shadowMapSize: 1024, post: true, volumetrics: false, crowdDensity: 0.4, lodDistance: 18, nearRadius: 14, maxDistance: 180, textureSize: 128 }),
  frozen({ label: 'Medium', renderScale: 0.85, shadows: true, shadowMapSize: 1024, post: true, volumetrics: false, crowdDensity: 0.65, lodDistance: 24, nearRadius: 18, maxDistance: 300, textureSize: 192 }),
  frozen({ label: 'High', renderScale: 1, shadows: true, shadowMapSize: 2048, post: true, volumetrics: false, crowdDensity: 0.85, lodDistance: 30, nearRadius: 22, maxDistance: 450, textureSize: 256 }),
  frozen({ label: 'Ultra', renderScale: 1, shadows: true, shadowMapSize: 4096, post: true, volumetrics: true, crowdDensity: 1, lodDistance: 45, nearRadius: 30, maxDistance: 700, textureSize: 256 }),
])

/**
 * Lite, tier -1: below Minimal for entry-level phone GPUs (DeviceProfile.lite). It is not in TIERS, so ?quality=0…4, the
 * console's tier numbers and every index the governor's tests pin keep their meaning; knobsOf reads it. Half the base
 * pixel ratio's edge (a quarter of its pixels), no shadows or post, and a thinner, shorter crowd draw than Minimal.
 */
export const LITE: QualityKnobs = frozen({ label: 'Lite', renderScale: 0.5, shadows: false, shadowMapSize: 1024, post: false, volumetrics: false, crowdDensity: 0.15, lodDistance: 8, nearRadius: 6, maxDistance: 80, textureSize: 64 })
/** Lite's tier index: the lowest a manual choice may pin, and the automatic floor of a lite profile (tierRange). */
export const LITE_TIER = -1

/** The knobs of tier `t`, from LITE_TIER (Lite) to TIERS.length - 1 (Ultra). Every read of a tier's knobs goes here. */
export function knobsOf(t: number): QualityKnobs {
  return t < 0 ? LITE : TIERS[t]
}

const TOP = TIERS.length - 1
const clampTier = (t: number, lo = 0, hi = TOP) => Math.min(hi, Math.max(lo, Math.round(t)))

// ---------------------------------------------------------------------------------------------------
// Device profile

export interface DeviceHints {
  /** world.ts adapter string: "vendor / architecture / description" or 'unknown adapter'. */
  adapter: string
  userAgent: string
  /** navigator.userAgentData.mobile (Chromium only). */
  mobileHint: boolean | undefined
  maxTouchPoints: number
  /** Primary pointer is coarse (a finger). */
  coarsePointer: boolean
  /** Logical CPU cores. */
  cores: number
  /** navigator.deviceMemory (Chromium only; powers of two, capped at 8). */
  memoryGb: number | undefined
  /** Screen area in CSS pixels: what a full-screen canvas renders at pixel ratio 1. */
  screenPixels: number
  /** 'native': the page runs in a native shell (Tauri v2, whose WebView2 on Windows 11 is desktop Chromium). */
  host?: 'browser' | 'native'
}

/**
 * `lite`: an entry-level phone GPU (or ?lite=1): the profile starts at Lite, the governor's automatic range is
 * Lite..Minimal, and the boot takes the lighter world (engine.ts Engine.create).
 */
export interface DeviceProfile { mobile: boolean; gpuClass: 'mobile' | 'integrated' | 'discrete' | 'unknown'; startTier: number; lite: boolean }

/** Browser only; degrades to neutral values where an API is missing. */
export function readDeviceHints(adapter: string): DeviceHints {
  const nav = (typeof navigator === 'undefined' ? {} : navigator) as Partial<Navigator> & {
    userAgentData?: { mobile?: unknown }; deviceMemory?: unknown
  }
  const mobile = nav.userAgentData?.mobile
  const memory = nav.deviceMemory
  return {
    adapter,
    userAgent: nav.userAgent ?? '',
    mobileHint: typeof mobile === 'boolean' ? mobile : undefined,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    coarsePointer: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
    cores: nav.hardwareConcurrency || 4,
    memoryGb: typeof memory === 'number' && memory > 0 ? memory : undefined,
    screenPixels: typeof screen === 'undefined' ? 0 : screen.width * screen.height,
    host: nativeHost(globalThis) ? 'native' : 'browser',
  }
}

/** A Tauri v2 window: its IPC bridge (`__TAURI_INTERNALS__`) and the `isTauri` flag are injected before the page runs. */
export function nativeHost(g: object): boolean {
  const w = g as { isTauri?: unknown; __TAURI_INTERNALS__?: unknown }
  return w.isTauri === true || (typeof w.__TAURI_INTERNALS__ === 'object' && w.__TAURI_INTERNALS__ !== null)
}

/** Pure. GPU family from WebGPU adapter info (Dawn's vendor / architecture names, plus the description
 *  when a browser exposes it), form factor from the user agent, then a conservative starting tier:
 *  a start that is too high costs about a second of late frames, one too low costs several seconds of
 *  lower quality per tier while the governor probes upward. `lite` is the page's ?lite: true makes any device a lite
 *  profile, false keeps every device off it, absent lets the hints decide. */
export function profileDevice(h: DeviceHints, lite?: boolean): DeviceProfile {
  const ua = h.userAgent
  const a = h.adapter.toLowerCase()
  const c = a.replace(/[^a-z0-9]+/g, '')
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && h.maxTouchPoints > 1)
  const desktopOs = !ios && /Windows NT|Macintosh|CrOS/.test(ua)
  // Dawn names the vendor 'google' (SwiftShader), 'microsoft' (WARP) or 'mesa' (llvmpipe / lavapipe) for CPU
  // rasterizers. Only a leading 'mesa' is the vendor: Mesa's hardware drivers report the GPU's own vendor,
  // and a driver description may still mention Mesa.
  const software = /swiftshader|llvmpipe|lavapipe|softpipe|\bwarp\b|basic render|\bgoogle\b|\bmicrosoft\b|^mesa\b/.test(a)
  const mobileGpu = /qualcomm|adreno|\barm\b|mali|immortalis|valhall|bifrost|midgard|img-?tec|imagination|powervr|rogue|samsung|xclipse|mediatek|maleoon|huawei|tegra/.test(a)
  const apple = /\bapple\b/.test(a)
  const nvidia = /nvidia|geforce|quadro|\brtx\b|\bgtx\b/.test(a) && !/tegra/.test(a)
  const amd = /\bamd\b|\bati\b|radeon/.test(a)
  const intel = /intel/.test(a)
  const qualcomm = /qualcomm|adreno/.test(a)
  const amdApu = amd && /radeon(\(tm\))? graphics|vega \d+ graphics|\b\d{3}m\b|\bapu\b/.test(a)
  const intelDiscrete = intel && (/gen12hp|xehpg|xe2hpg|dg2/.test(c) || /\barc(\(tm\))? [ab]\d{3}/.test(a))
  const mobile = h.mobileHint === true || ios || /Android|Mobi/i.test(ua) ||
    (!desktopOs && (mobileGpu || (h.coarsePointer && h.maxTouchPoints > 0)))

  let gpuClass: DeviceProfile['gpuClass'] = 'unknown'
  if (software || a === '' || a === 'unknown adapter') gpuClass = 'unknown'
  else if (nvidia) gpuClass = 'discrete'
  else if (amd) gpuClass = amdApu ? 'integrated' : 'discrete'
  else if (intel) gpuClass = intelDiscrete ? 'discrete' : 'integrated'
  else if (apple) gpuClass = mobile ? 'mobile' : 'integrated'
  else if (qualcomm && desktopOs) gpuClass = 'integrated'   // Windows on Snapdragon: a laptop part
  else if (mobileGpu) gpuClass = 'mobile'

  let start: number
  let weak = false
  if (software) start = 0
  else if (mobile) {
    const flagship = apple || /adreno[789]|immortalis|gen5|xclipse|samsung/.test(c) ||
      (/valhall/.test(a) && (h.memoryGb ?? 0) >= 8) || (gpuClass === 'unknown' && ios)
    start = flagship ? 1 : 0
    if (h.memoryGb !== undefined && h.memoryGb <= 4) start = 0
    // Entry-level phone GPUs: Mali's Bifrost and Midgard generations (Chrome names only the architecture, so a G52 MC2
    // reads the same as a G76; a browser that gives the description names the model), Imagination's older and smaller
    // parts, and Adreno 5xx or older. Valhall, Immortalis, Adreno 6xx and newer, Xclipse and Apple are not. A phone that
    // says it has 2 GB or less is short of memory for the city whatever its GPU.
    // Imagination by its vendor alone is not enough: Dawn names every one 'img-tec', the current D-Series flagship parts
    // too, so only Rogue, Furian and B-Series (by architecture or description) count, or a bare vendor on 4 GB or less.
    const imgEntry = /rogue|furian|b-?series|powervr ?(?:sgx|g[em]\d)/.test(a) ||
      (/^(?:img-?tec|imagination)[\s/]*$/.test(a) && h.memoryGb !== undefined && h.memoryGb <= 4)
    const entryGpu = /bifrost|midgard|mali-?g(?:31|51|52|71|72|76)\b|mali-?t\d{3}\b/.test(a) || imgEntry ||
      /adreno(?:tm)?[1-5](?:\d\d|xx)/.test(c)
    weak = (!flagship && entryGpu) || (h.memoryGb !== undefined && h.memoryGb <= 2)
  } else {
    if (gpuClass === 'discrete') {
      const highEnd = h.cores >= 8 && ((nvidia && /ampere|lovelace|blackwell|rtx ?[345]0[6-9]0/.test(a)) ||
        (amd && /rdna[234]/.test(c) && /\brx\b|radeon pro/.test(a)))
      start = highEnd ? 4 : 3
    } else if (gpuClass === 'integrated') {
      if (apple) start = 3
      else if (intel) start = /gen12lp|xelpg|xe2lpg|xe3lpg|irisrxe|irisxe/.test(c) ? 2 : 1
      else start = 2                                          // Radeon APUs, Snapdragon X
    } else start = gpuClass === 'mobile' ? 1 : 2               // ARM Chromebooks; unknown adapters
    if (h.screenPixels > 6e6) start--                          // 4K at 100 % scaling
    else if (gpuClass !== 'discrete' && h.screenPixels > 3.2e6) start--
    if (h.memoryGb !== undefined && h.memoryGb <= 4) start--
    if (h.cores > 0 && h.cores < 4) start--
  }
  const isLite = lite ?? weak
  return { mobile, gpuClass, startTier: isLite ? LITE_TIER : clampTier(start), lite: isLite }
}

/**
 * Pedestrians to simulate when the page does not say (?crowd): the whole crowd wherever the profile starts at Medium
 * or above; fewer where simulating it would itself cost the frame (phones, and the weakest GPUs and software
 * rasterizers, which start at Minimal), and fewest on a lite profile. The simulation size is fixed at boot (the GPU
 * buffers are sized for it); the governor then scales how many of them are drawn.
 */
export const CROWD_DEFAULT = Object.freeze({ full: 14000, phone: 8000, minimal: 5000, lite: 2500 })
export function defaultAgents(p: DeviceProfile): number {
  if (p.lite) return CROWD_DEFAULT.lite
  if (p.startTier <= 0) return CROWD_DEFAULT.minimal
  if (p.mobile) return CROWD_DEFAULT.phone
  return CROWD_DEFAULT.full
}

/**
 * AI cars when the page does not say (?cars): the fleet a default network room runs (mirror.node.ts MIRROR.cars), or a
 * third of it on a lite profile, where each car's Rapier wheel rays and the crowd shader's per-car loop are a real
 * share of the frame. Fixed at boot like the crowd: the pose buffers and the fleet's meshes are sized for it.
 */
export const CARS_DEFAULT = Object.freeze({ full: 36, lite: 12 })
export function defaultCars(p: DeviceProfile): number {
  return p.lite ? CARS_DEFAULT.lite : CARS_DEFAULT.full
}

/**
 * Why a lite page's network join may have timed out: its fleet came from the profile (no ?cars), so its world names
 * fewer cars than a default room runs, and the room refuses it without a word (replication.ts 'join: world') until the
 * host's join deadline closes it. Empty when the page chose its fleet or runs the full one. The wording says "if":
 * a bad token or a full room also ends in a join timeout.
 */
export function liteJoinHint(lite: boolean, carsDefaulted: boolean, cars: number): string {
  if (!lite || !carsDefaulted || cars === CARS_DEFAULT.full) return ''
  return ` (this lite page runs ${cars} cars; if the room runs the default ${CARS_DEFAULT.full}, open the page with ?cars=${CARS_DEFAULT.full} to join it)`
}

/** The governor's automatic range for a device: phones and tablets stop at Medium (heat and battery
 *  bite long before the frame rate does), and a lite profile at Minimal, below every tier that needs post or shadows
 *  (neither is compiled at its boot); manual `setTier` may still go anywhere. */
export function tierRange(p: DeviceProfile): { min: number; max: number } {
  if (p.lite) return { min: LITE_TIER, max: 0 }
  return { min: 0, max: p.mobile ? 2 : TOP }
}

// ---------------------------------------------------------------------------------------------------
// Refresh estimate

const RATES = [60, 72, 75, 90, 100, 120, 144, 165, 180, 240, 360] as const

function snapRefresh(hz: number): number {
  let best = hz, err = 0.07
  for (const r of RATES) {
    const e = Math.abs(hz - r) / r
    if (e <= err) { err = e; best = r }
  }
  // Below ~57 Hz the first frames were slow, not the display: assume the common 60 Hz.
  return best < 57 ? 60 : best
}

/** Display refresh (Hz) from rAF intervals: the given percentile (median by default; vsync-paced frames
 *  cannot beat the refresh period), snapped to a standard rate within 7 %. Sorts `scratch` in place when
 *  given (allocation-free), otherwise a copy. */
export function estimateRefreshHz(intervals: ArrayLike<number>, percentile = 0.5, scratch?: Float32Array): number {
  const s = scratch ?? new Float32Array(intervals.length)
  let n = 0
  for (let i = 0; i < intervals.length && n < s.length; i++) {
    const x = intervals[i]
    if (x > 0 && Number.isFinite(x)) s[n++] = x
  }
  if (n === 0) return 60
  const sorted = s.subarray(0, n).sort()
  return snapRefresh(1000 / sorted[Math.floor((n - 1) * percentile)])
}

// ---------------------------------------------------------------------------------------------------
// Governor

const FLOOR_MS = 1000 / 60
const RING = 4096
/** Presented frames remembered (over 5 s at 24 fps). */
const PRESENT_RING = 256
/**
 * The camera's frames are counted in slices this long over the step-down window plus one slice (as the animation
 * frames' window has one at each end: a slowdown must span more than the 2 s), and short in every slice is "behind".
 */
const PRESENT_SLICE_MS = 500
const PRESENT_WINDOW_MS = 2000 + PRESENT_SLICE_MS

const GOV = {
  /** Longer frames are tab switches, GC pauses or compile hitches, not load… */
  outlierMs: 250,
  /** …unless this many arrive in a row: a device that slow must still step down. */
  outlierRun: 4,
  /** A frame this long, or a run of hitches together this long, is a tab switch or an app resume: the step-down
   *  window starts afresh after it. */
  gapMs: 1000,
  /** Start-up frames ignored: at least warmupMs, and warmupFrames or warmupMaxMs, whichever is first. */
  warmupMs: 750,
  warmupFrames: 20,
  warmupMaxMs: 2000,
  /** Frames that estimate the refresh (or refreshMaxMs with at least refreshMinFrames). */
  refreshFrames: 60,
  refreshMaxMs: 1500,
  refreshMinFrames: 10,
  evalMs: 100,
  /** The operator's rule: FPS below 60 for more than degradeHoldMs steps down one tier. FPS is read per
   *  slice (a quarter second: the mean of the frames that ended in it) and must be below in every slice of
   *  a window of degradeHoldMs plus one slice at each end, the two a slowdown may only partly fill, so slow
   *  frames span more than 2 s. A slice no frame ended in reads as below if it was observed (a long frame
   *  covered it), not if it lies before the last tier change or gap. A lone hitch, a dip that recovers, or
   *  a few dropped frames never add up to a step. On a very slow device the window stretches to the last
   *  minFrames frames. */
  degradeHoldMs: 2000,
  sliceMs: 250,
  minFrames: 5,
  /** Budget = 1000 / 60 × (1 + tolerance) for an estimated target, i.e. below ~57 FPS: rAF jitter on a
   *  60 Hz display stays inside it, and 72 FPS on 144 Hz or 60 on 120 Hz never reads as slow. The 60 FPS
   *  floor, not the refresh, is what is held. An explicit targetMs is held as given: × (1 + tolerance). */
  tolerance: 0.05,
  /** Step up after this long without a hitch and with the p97 on target (target × (1 + headroom) + slack). */
  upgradeHoldMs: 5000,
  minUpgradeFrames: 30,
  headroom: 0.06,
  headroomSlackMs: 0.3,
  /** Samples ignored after every change while pipelines, render targets and caches settle; with the
   *  2 s rule, consecutive steps down are about 4 s apart. */
  cooldownMs: 1500,
  /** A step down this soon after a step up means the probe failed. */
  probeMs: 12000,
  /** Step downs from a tier are remembered this long after the last one. A marginal tier (hovering about
   *  57 FPS) holds for a minute or two and then trips; forgetting that after a short hold would flip it,
   *  and the shadows with it, every minute or two for the whole session. */
  forgetMs: 600000,
  /** Wait before re-probing a tier: backoffMs after its first remembered step down, doubled per further
   *  one and once more when it was a failed probe (a first failed probe waits 40 s, then 80 s, …). */
  backoffMs: 20000,
  maxBackoffMs: 300000,
  /**
   * Under the cinema camera: fewer than this share of its frames presented in every half second of the step-down
   * window (under about 10.8 of 12: two frames missed in each) steps down; a step up needs at least presentUp of them
   * over the upgrade window.
   */
  presentFloor: 0.9,
  presentUp: 0.97,
} as const

/** A tier's index in the governor's per-tier arrays: Lite (-1) is slot 0. */
const slot = (t: number) => t - LITE_TIER

/** p-th percentile of n samples is above a threshold when this many samples exceed it (the same
 *  floor-index convention as FrameClock). */
const above = (over: number, n: number, p: number) => over >= n - Math.floor(n * p)

/** Slices in the step-down window: degradeHoldMs of them plus the partly filled one at either end. */
const SLICES = GOV.degradeHoldMs / GOV.sliceMs + 2
const WINDOW_MS = SLICES * GOV.sliceMs

/** Mean frame time over which a slice of the step-down window counts as "below 60 FPS", ms: the 60 FPS
 *  floor (or an explicit target) plus the vsync-jitter tolerance. */
export function degradeBudgetMs(targetMs: number, fixedTarget: boolean): number {
  return (fixedTarget ? targetMs : FLOOR_MS) * (1 + GOV.tolerance)
}

export class Governor {
  private current: number
  private adaptive: boolean
  private holdMs: number
  private readonly fixedTarget: boolean
  private readonly min: number
  private readonly max: number
  private refreshHz = 60
  private reported: number
  private readonly times = new Float64Array(RING)
  private readonly frames = new Float32Array(RING)
  private readonly scratch = new Float32Array(RING)
  private readonly sliceFrames = new Uint16Array(SLICES)
  private readonly sliceMs = new Float64Array(SLICES)
  private head = 0
  private count = 0
  private phase: 'warmup' | 'refresh' | 'run' = 'warmup'
  private firstMs = -1
  private seen = 0
  private outliers = 0
  /** When the current run of hitches began (the start of its first frame). */
  private runStart = 0
  /** Start of the step-down window's observation: the last reset or long gap. */
  private since = 0
  /** Start of the current hitch-free stretch, which a step up needs upgradeHoldMs of. */
  private calm = 0
  private coolUntil = -Infinity
  private nextEval = -Infinity
  private lastNow = 0
  private arrivedAt = 0
  private refineAfter = 0
  private lastChange: 'none' | 'up' | 'down' | 'manual' | 'hold' = 'none'
  /** Why the tier last changed, in a few words (for the console and the probes). */
  private why = ''
  /** The hold's ceiling (hold()), inside the automatic range; null when nothing holds the city. */
  private cap: number | null = null
  /** The automatic tier a release returns to: the tier when the hold began, or the one auto would have taken when it
   *  was turned back on under the hold. Null under a manual tier and whenever nothing holds the city. */
  private restore: number | null = null
  /** Per tier, at index tier - LITE_TIER (Lite has a slot of its own): step downs remembered, when, and the probe wait. */
  private readonly fails = new Uint32Array(TIERS.length + 1)
  private readonly failedAt = new Float64Array(TIERS.length + 1).fill(-Infinity)
  private readonly blockedUntil = new Float64Array(TIERS.length + 1)
  /** The device profile's lite flag, shown with the tier (state()). */
  private readonly lite: boolean
  /** The cinema camera's frame period, ms (0: no camera, every animation frame is drawn). */
  private readonly pacerMs: number
  private readonly presents = new Float64Array(PRESENT_RING)
  private presentHead = 0
  private presentCount = 0
  private readonly presentSlices = new Uint16Array(PRESENT_WINDOW_MS / PRESENT_SLICE_MS)

  /**
   * `pacerMs`: the cinema camera's frame period (1000 / 24) when it runs. The animation frames are then held at the
   * 60 FPS floor whatever the display's refresh (input and physics; the pictures come 24 a second), and the camera's
   * presented frames (present()) must keep up too.
   */
  constructor(opts: { tier: number; auto: boolean; targetMs?: number; min?: number; max?: number; pacerMs?: number; lite?: boolean }) {
    this.pacerMs = Number.isFinite(opts.pacerMs) && (opts.pacerMs as number) > 0 ? opts.pacerMs as number : 0
    // The automatic range reaches Lite only when the caller asks (tierRange of a lite profile); by default it stops at
    // Minimal, so no other device ever walks down into it.
    this.min = clampTier(Number.isFinite(opts.min) ? opts.min as number : 0, LITE_TIER)
    this.max = clampTier(Number.isFinite(opts.max) ? opts.max as number : TOP, this.min)
    this.adaptive = opts.auto
    this.lite = opts.lite === true
    const t = Number.isFinite(opts.tier) ? opts.tier : 3
    this.current = opts.auto ? clampTier(t, this.min, this.max) : clampTier(t, LITE_TIER)
    this.reported = this.current
    // Infinity (1000 / 0 from an unset FPS option) or NaN means "not given", not "never late".
    const target = Number.isFinite(opts.targetMs) && (opts.targetMs as number) > 0 ? opts.targetMs as number : 0
    this.fixedTarget = target > 0
    this.holdMs = target || FLOOR_MS
  }

  get tier(): number { return this.current }
  get auto(): boolean { return this.adaptive }
  /** Whether the cinema camera's presented frames are held too. */
  get pacer(): boolean { return this.pacerMs > 0 }
  /** Why the tier last changed: 'frames below 60 FPS' ('frames below target' under ?fps), 'camera behind', 'probe',
   *  'manual', 'held' (a hold lowered it), 'released' (a hold let it back up), or '' (never). */
  get reason(): string { return this.why }

  /** One frame the cinema camera presented, at `nowMs` (the same clock as sample()). Ignored without a camera. */
  present(nowMs: number): void {
    if (!(this.pacerMs > 0) || !Number.isFinite(nowMs)) return
    this.presents[this.presentHead] = nowMs
    this.presentHead = (this.presentHead + 1) % PRESENT_RING
    if (this.presentCount < PRESENT_RING) this.presentCount++
  }

  /** The camera fell behind throughout the step-down window: fewer than presentFloor of its frames in every slice. */
  private presentsBehind(now: number): boolean {
    const floor = (PRESENT_SLICE_MS / this.pacerMs) * GOV.presentFloor
    const slices = this.presentSlices
    slices.fill(0)
    for (let i = 0, j = this.presentHead; i < this.presentCount; i++) {
      j = (j - 1 + PRESENT_RING) % PRESENT_RING
      const age = now - this.presents[j]
      if (age >= PRESENT_WINDOW_MS) break
      if (age >= 0) slices[Math.floor(age / PRESENT_SLICE_MS)]++
    }
    for (let k = 0; k < slices.length; k++) if (slices[k] >= floor) return false
    return true
  }

  /**
   * Presented frames at or after `from`. (The upgrade gate asks only once calm has held for its whole window, and
   * calm is never earlier than the last change or gap, so that window never reaches back past one.)
   */
  private presentsSince(from: number): number {
    let n = 0
    for (let i = 0, j = this.presentHead; i < this.presentCount; i++) {
      j = (j - 1 + PRESENT_RING) % PRESENT_RING
      if (this.presents[j] < from) break
      n++
    }
    return n
  }
  /** Frame time the governor holds, ms: 1000 / clamp(refresh, 60, 90) once the refresh is known. */
  get targetMs(): number { return this.holdMs }

  knobs(): QualityKnobs { return knobsOf(this.current) }

  state(): QualityState {
    const k = knobsOf(this.current)
    return {
      tier: this.current, label: k.label, auto: this.adaptive, renderScale: k.renderScale, targetMs: this.holdMs,
      ...(this.lite && { lite: true }), ...(this.cap !== null && { held: this.cap }),
    }
  }

  /** Feed one frame: `frameMs` is the rAF interval, `nowMs` a monotonic clock. Returns the tier when it
   *  changed since the last call (including setTier / setAuto / hold changes, so knobs can be applied in one
   *  place), else null. Allocation-free. */
  sample(frameMs: number, nowMs: number): number | null {
    if (!Number.isFinite(nowMs)) return this.report()
    if (nowMs < this.lastNow) {
      // Clock went backwards (a new time origin): windows, deadlines and the warm-up start are meaningless.
      this.blockedUntil.fill(0)
      this.fails.fill(0)
      this.failedAt.fill(-Infinity)
      this.refineAfter = 0
      if (this.phase === 'warmup') { this.firstMs = -1; this.seen = 0 }
      this.arrivedAt = nowMs
      this.reset(nowMs, 0)
    }
    this.lastNow = nowMs
    if (!(frameMs > 0) || !Number.isFinite(frameMs)) return this.report()

    if (this.phase === 'warmup') {
      if (this.firstMs < 0) this.firstMs = nowMs
      this.seen++
      const age = nowMs - this.firstMs
      if (age < GOV.warmupMs || (this.seen < GOV.warmupFrames && age < GOV.warmupMaxMs)) return this.report()
      this.phase = this.fixedTarget ? 'run' : 'refresh'
      this.arrivedAt = nowMs
      this.reset(nowMs, 0)
    }
    if (nowMs < this.coolUntil) return this.report()

    let ms = frameMs
    if (ms > GOV.outlierMs) {
      if (++this.outliers < GOV.outlierRun) {
        // A tab switch or app resume leaves a long hole whose slices would read as below 60 (and the cinema
        // camera's as behind), so janky frames after it would look sustained: the window starts afresh. So does
        // a run of hitches as long, which the camera would otherwise read as frames missed. A shorter hitch
        // stays in it (it was below 60, and alone it never fills a window), so a jittery device at a few FPS
        // still steps.
        if (this.outliers === 1) this.runStart = nowMs - ms
        if (nowMs - this.runStart > GOV.gapMs && this.since < nowMs) this.since = nowMs
        if (this.calm < nowMs) this.calm = nowMs
        return this.report()
      }
      ms = GOV.outlierMs
    } else this.outliers = 0

    this.times[this.head] = nowMs
    this.frames[this.head] = ms
    this.head = (this.head + 1) % RING
    if (this.count < RING) this.count++

    if (this.phase === 'refresh') {
      const n = this.count
      if (n < GOV.refreshFrames && !(nowMs - this.since >= GOV.refreshMaxMs && n >= GOV.refreshMinFrames)) return this.report()
      this.setRefresh(estimateRefreshHz(this.window(n), 0.5, this.scratch))
      this.phase = 'run'
    }
    if (this.adaptive && nowMs >= this.nextEval) {
      this.nextEval = nowMs + GOV.evalMs
      this.evaluate(nowMs)
    }
    return this.report()
  }

  setAuto(auto: boolean): void {
    if (auto === this.adaptive) return
    this.adaptive = auto
    if (!auto) return
    const from = this.current
    const free = clampTier(from, this.min, this.max)
    // Under a hold the city waits below the cap, and the tier auto would have taken is the one the release returns to.
    if (this.cap !== null) this.restore = Math.max(this.restore ?? free, free)
    this.current = Math.min(free, this.ceiling())
    this.lastChange = 'manual'
    this.arrivedAt = this.lastNow
    this.reset(this.lastNow, this.current === from ? 0 : GOV.cooldownMs)
  }

  /** Manual choice of any tier (-1…4, Lite to Ultra, not limited to the automatic range); turns auto off. */
  setTier(tier: number): void {
    if (!Number.isFinite(tier)) return
    this.adaptive = false
    // The operator's choice replaces the tier a release would have returned to.
    this.restore = null
    const t = clampTier(tier, LITE_TIER)
    if (t === this.current) return
    this.current = t
    this.lastChange = 'manual'
    this.why = 'manual'
    this.arrivedAt = this.lastNow
    this.reset(this.lastNow, GOV.cooldownMs)
  }

  /**
   * Holds the automatic tier at or below `cap` while something else needs the device, or releases it (null). The
   * in-page model is that something: while it works the city is slower because the model has the GPU or the cores, not
   * because the tier is too heavy, so nothing under the hold counts against a tier. A tier above the cap drops to it at
   * once, probes stop at it, and a step down under it is taken but not remembered (no back-off, no failed probe). The
   * cap is clamped into the automatic range: a lite profile stops at Lite, and no other device walks into it. The
   * release returns to the tier from before the hold (or the higher one a probe reached under it) with the usual
   * cooldown, and drops the frames sampled under the hold, so they never read as a slowdown afterwards. A second hold
   * moves the cap the same way: down at once, or up as far as the tier from before the hold. A manual tier wins: the cap
   * is recorded (state() shows it) and the tier left alone; turning auto back on lands under the cap. `nowMs` is the
   * clock sample() is fed. Like setTier, a tier change is reported by the next sample(); the caller applies the knobs.
   */
  hold(cap: number | null, nowMs: number): void {
    if (cap !== null && !Number.isFinite(cap)) return
    if (cap === null && this.cap === null) return
    const now = Number.isFinite(nowMs) ? nowMs : this.lastNow
    if (this.cap === null) this.restore = this.adaptive ? this.current : null
    this.cap = cap === null ? null : clampTier(cap, this.min, this.max)
    const from = this.current
    if (this.adaptive) this.current = Math.min(Math.max(from, this.restore ?? from), this.ceiling())
    if (this.current !== from) {
      this.why = this.current < from ? 'held' : 'released'
      this.lastChange = 'hold'
      this.arrivedAt = now
    }
    if (this.current !== from || this.cap === null) this.reset(now, GOV.cooldownMs)
    if (this.cap === null) this.restore = null
  }

  /** The highest tier the automatic governor may take: its range's max, or the hold's cap while held. */
  private ceiling(): number {
    return this.cap ?? this.max
  }

  private report(): number | null {
    if (this.current === this.reported) return null
    this.reported = this.current
    return this.current
  }

  private reset(now: number, cooldown: number): void {
    this.count = 0
    this.outliers = 0
    this.coolUntil = now + cooldown
    this.since = this.calm = now + cooldown
    this.nextEval = this.since
  }

  private setRefresh(hz: number): void {
    this.refreshHz = hz
    // Under the cinema camera the frames the eye sees are its 24: the rest need only the 60 FPS floor, so a fast
    // display's extra refreshes are not bought with fidelity.
    if (!this.fixedTarget) this.holdMs = this.pacerMs > 0 ? FLOOR_MS : 1000 / Math.min(90, Math.max(60, hz))
  }

  /** Copies the newest n samples into scratch (oldest first) and returns that view. */
  private window(n: number): Float32Array {
    for (let i = 0, j = (this.head - n + RING) % RING; i < n; i++, j = (j + 1) % RING) this.scratch[i] = this.frames[j]
    return this.scratch.subarray(0, n)
  }

  private evaluate(now: number): void {
    const budget = degradeBudgetMs(this.holdMs, this.fixedTarget)
    const onTarget = this.holdMs * (1 + GOV.headroom) + GOV.headroomSlackMs
    const fast = (1000 / this.refreshHz) * 0.88
    let n1 = 0, n5 = 0, miss5 = 0, fast5 = 0
    this.sliceFrames.fill(0)
    this.sliceMs.fill(0)
    for (let i = 0, j = this.head; i < this.count; i++) {
      j = (j - 1 + RING) % RING
      const age = now - this.times[j]
      // The newest minFrames frames always count, however old: below ~1 FPS, 5 s holds fewer than that.
      if (age > GOV.upgradeHoldMs && n5 >= GOV.minFrames) break
      const ms = this.frames[j]
      n5++
      if (ms > onTarget) miss5++
      if (ms < fast) fast5++
      if (age < WINDOW_MS || n5 <= GOV.minFrames) {
        const s = Math.min(SLICES - 1, Math.floor(age / GOV.sliceMs))
        n1++
        this.sliceFrames[s]++
        this.sliceMs[s] += ms
      }
    }
    // Below 60 FPS throughout the window: every slice's frames averaged over budget, or, with no frame
    // ending in it, the slice was observed in full (a long frame covered it).
    let below = true
    for (let s = 0; s < SLICES; s++) {
      const n = this.sliceFrames[s]
      if (n > 0 ? this.sliceMs[s] <= budget * n : now - (s + 1) * GOV.sliceMs < this.since) below = false
    }
    const span = now - this.since

    if (below && span >= GOV.degradeHoldMs && n1 >= GOV.minFrames && this.current > this.min) {
      this.why = this.fixedTarget ? 'frames below target' : 'frames below 60 FPS'
      this.step(now, -1)
      return
    }
    // The cinema camera behind throughout a window observed in full (from its start, not from a change or a gap).
    if (this.pacerMs > 0 && span >= PRESENT_WINDOW_MS && this.current > this.min && this.presentsBehind(now)) {
      this.why = 'camera behind'
      this.step(now, -1)
      return
    }
    if (now - this.calm < GOV.upgradeHoldMs || n5 < GOV.minUpgradeFrames) return
    if (this.pacerMs > 0 && this.presentsSince(now - GOV.upgradeHoldMs) < (GOV.upgradeHoldMs / this.pacerMs) * GOV.presentUp) return
    // Frames beating the assumed refresh: the display is faster than the start-up frames suggested.
    if (!this.fixedTarget && now >= this.refineAfter && fast5 * 4 >= n5) {
      this.refineAfter = now + GOV.upgradeHoldMs
      const hz = estimateRefreshHz(this.window(n5), 0.2, this.scratch)
      if (hz > this.refreshHz * 1.15) {
        this.setRefresh(hz)
        return
      }
    }
    if (this.current < this.ceiling() && now >= this.blockedUntil[slot(this.current + 1)] && !above(miss5, n5, 0.97)) {
      this.why = 'probe'
      this.step(now, 1)
    }
  }

  /** One tier at a time, both ways: a failed probe returns to the tier it came from, which just held the
   *  target, and a slow device walks down step by step, each step culling crowd and texture detail. */
  private step(now: number, delta: 1 | -1): void {
    const from = this.current
    const to = clampTier(from + delta, this.min, this.max)
    if (to === from) return
    if (to < from) {
      // Under a hold the device is busy with something else: the step is taken, but not remembered against the tier.
      if (this.cap === null) {
        const failed = this.lastChange === 'up' && now - this.arrivedAt < GOV.probeMs
        const i = slot(from)
        if (now - this.failedAt[i] >= GOV.forgetMs) this.fails[i] = 0
        this.fails[i]++
        this.failedAt[i] = now
        const wait = Math.min(GOV.maxBackoffMs, GOV.backoffMs * 2 ** (this.fails[i] - (failed ? 0 : 1)))
        this.blockedUntil[i] = Math.max(this.blockedUntil[i], now + wait)
      }
      this.lastChange = 'down'
    } else this.lastChange = 'up'
    this.current = to
    this.arrivedAt = now
    this.reset(now, GOV.cooldownMs)
  }
}
