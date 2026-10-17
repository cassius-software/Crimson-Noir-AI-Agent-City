// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It drives the device profile and the quality governor as the weakest phone the city is
 * asked to serve would: an entry-level Android handset (a MediaTek Helio G91 with a Mali-G52 MC2, Bifrost, 6 GB) in
 * Chrome, whose WebGPU adapter reads 'arm / bifrost' with the description withheld. Its hints are built exactly as
 * readDeviceHints reads them there (from stubbed globals), and the test proves the lite profile end to end: Lite at
 * the start, the Lite..Minimal automatic range, 2,500 pedestrians and 12 cars, ?lite=1 and ?lite=0, and that every
 * other class of device (Valhall and Adreno 6xx phones, an iPhone, a desktop, SwiftShader) keeps the profile it had.
 * What breaks if it is removed? A change to the profile could start this phone on Minimal again (5,000 pedestrians,
 * 36 cars, the post chain compiled at boot), or quietly move a capable phone or a desktop onto the lite boot.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CARS_DEFAULT, CROWD_DEFAULT, Governor, LITE, TIERS, defaultAgents, defaultCars, knobsOf, profileDevice, readDeviceHints, tierRange,
  type DeviceHints, type DeviceProfile,
} from './governor.ts'
import { CINEMA } from '../07_Execute_Actions/cinema.ts'

// ---------------------------------------------------------------------------------------------------
// The phone, as Chrome on Android describes it

/** Chrome on Android sends a reduced user agent: Android 10, model K, whatever the real release and handset. */
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'
const WIN_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const LINUX_HEADLESS = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36'

interface Device {
  /** world.ts's adapter line: vendor / architecture / description (Chrome withholds the description). */
  adapter: string
  userAgent: string
  /** navigator.userAgentData, Chromium only (absent in Safari). */
  uaData?: { mobile: boolean; platform: string }
  /** navigator.deviceMemory, Chromium only: powers of two, capped at 8 (a 6 GB phone reads 4 or 8). */
  memory?: number
  touchPoints: number
  coarse: boolean
  cores: number
  screen: { width: number; height: number }
}

/** The Ulefone Armor X32 in Chrome: Helio G91 (two A75 and six A55 cores), Mali-G52 MC2, 6 GB, 412 × 915 CSS pixels. */
const MALI_G52: Device = {
  adapter: 'arm / bifrost', userAgent: ANDROID_CHROME, uaData: { mobile: true, platform: 'Android' }, memory: 4,
  touchPoints: 5, coarse: true, cores: 8, screen: { width: 412, height: 915 },
}

const GLOBALS = ['navigator', 'screen', 'matchMedia', 'isTauri', '__TAURI_INTERNALS__'] as const

/** readDeviceHints against the device's globals; Node's own are put back afterwards (governorDesktop.test.ts hintsOf). */
function hintsOf(d: Device): DeviceHints {
  const saved = GLOBALS.map((k) => Object.getOwnPropertyDescriptor(globalThis, k))
  const set = (k: (typeof GLOBALS)[number], value: unknown) => Object.defineProperty(globalThis, k, { value, configurable: true, writable: true })
  try {
    set('navigator', {
      userAgent: d.userAgent,
      ...(d.uaData && { userAgentData: d.uaData }),
      ...(d.memory !== undefined && { deviceMemory: d.memory }),
      maxTouchPoints: d.touchPoints,
      hardwareConcurrency: d.cores,
    })
    set('screen', d.screen)
    set('matchMedia', (query: string) => ({ matches: d.coarse && query === '(pointer: coarse)', media: query }))
    return readDeviceHints(d.adapter)
  } finally {
    GLOBALS.forEach((k, i) => {
      const was = saved[i]
      if (was) Object.defineProperty(globalThis, k, was)
      else Reflect.deleteProperty(globalThis, k)
    })
  }
}

interface Boot { hints: DeviceHints; profile: DeviceProfile; agents: number; cars: number; governor: Governor }

/** Engine.create's set-up, step for step: the profile (with ?lite when given), the crowd, the fleet and the governor. */
function boot(d: Device, lite?: boolean): Boot {
  const hints = hintsOf(d)
  const profile = profileDevice(hints, lite)
  const governor = new Governor({ tier: profile.startTier, auto: true, pacerMs: 1000 / CINEMA.fps, lite: profile.lite, ...tierRange(profile) })
  return { hints, profile, agents: defaultAgents(profile), cars: defaultCars(profile), governor }
}

// ---------------------------------------------------------------------------------------------------
// 1. The Mali-G52 phone is a lite profile

test('lite 1: the Mali-G52 in Chrome on Android, as readDeviceHints reads it', () => {
  for (const memory of [4, 8]) {
    const b = boot({ ...MALI_G52, memory })
    assert.deepEqual(b.hints, {
      adapter: 'arm / bifrost', userAgent: ANDROID_CHROME, mobileHint: true, maxTouchPoints: 5, coarsePointer: true,
      cores: 8, memoryGb: memory, screenPixels: 412 * 915, host: 'browser',
    })
    assert.deepEqual(b.profile, { mobile: true, gpuClass: 'mobile', startTier: -1, lite: true }, `${memory} GB`)
    assert.deepEqual(tierRange(b.profile), { min: -1, max: 0 }, 'Lite..Minimal: no tier that needs post or shadows')
    assert.equal(b.agents, 2500)
    assert.equal(b.agents, CROWD_DEFAULT.lite)
    assert.equal(b.cars, 12)
    assert.equal(b.cars, CARS_DEFAULT.lite)
    assert.equal(b.governor.tier, -1)
    assert.deepEqual(b.governor.state(), { tier: -1, label: 'Lite', auto: true, renderScale: 0.5, targetMs: b.governor.targetMs, lite: true })
    assert.equal(b.governor.knobs(), LITE)
  }
  // Without Chromium's client hints the user agent alone still says Android; a browser that names the model does too.
  assert.equal(boot({ ...MALI_G52, uaData: undefined }).profile.lite, true)
  assert.equal(boot({ ...MALI_G52, adapter: 'arm / bifrost / Mali-G52 MC2' }).profile.lite, true)
  assert.equal(boot({ ...MALI_G52, adapter: 'arm / / Mali-G52 MC2' }).profile.lite, true)
})

test('lite 1: the governor holds it inside Lite..Minimal, whatever the frames say', () => {
  const g = boot(MALI_G52).governor
  let now = 1000
  const seen = new Set<number>()
  // Headroom for a minute, a long overload, then headroom again: never above Minimal, never below Lite.
  for (const [seconds, ms] of [[60, 1000 / 60], [60, 50], [120, 1000 / 60]] as const) {
    for (const end = now + seconds * 1000; now < end;) {
      now += ms
      g.present(now)
      g.sample(ms, now)
      seen.add(g.tier)
    }
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [-1, 0])
  assert.equal(knobsOf(0), TIERS[0])
})

// ---------------------------------------------------------------------------------------------------
// 2. Every other class of device keeps the profile it had

test('lite 2: Valhall, Adreno 6xx and an iPhone are not lite; nor are a desktop or the SwiftShader adapter', () => {
  const cases: [string, Device, DeviceProfile][] = [
    ['Mali-G57 (Valhall), 4 GB', { ...MALI_G52, adapter: 'arm / valhall' }, { mobile: true, gpuClass: 'mobile', startTier: 0, lite: false }],
    ['Mali-G57 (Valhall), 8 GB', { ...MALI_G52, adapter: 'arm / valhall', memory: 8 }, { mobile: true, gpuClass: 'mobile', startTier: 1, lite: false }],
    ['Adreno 6xx', { ...MALI_G52, adapter: 'qualcomm / adreno-6xx' }, { mobile: true, gpuClass: 'mobile', startTier: 0, lite: false }],
    ['Immortalis', { ...MALI_G52, adapter: 'arm / valhall / Immortalis-G715', memory: 8 }, { mobile: true, gpuClass: 'mobile', startTier: 1, lite: false }],
    ['Xclipse, 8 GB', { ...MALI_G52, adapter: 'samsung / rdna-2', memory: 8 }, { mobile: true, gpuClass: 'mobile', startTier: 1, lite: false }],
    ['iPhone in Safari', { ...MALI_G52, adapter: 'apple / common-3', userAgent: IPHONE_SAFARI, uaData: undefined, memory: undefined, cores: 4 }, { mobile: true, gpuClass: 'mobile', startTier: 1, lite: false }],
    ['desktop', { adapter: 'nvidia / ampere', userAgent: WIN_CHROME, uaData: { mobile: false, platform: 'Windows' }, memory: 8, touchPoints: 0, coarse: false, cores: 16, screen: { width: 2560, height: 1440 } }, { mobile: false, gpuClass: 'discrete', startTier: 4, lite: false }],
    ['SwiftShader (headless Chrome)', { adapter: 'google / swiftshader', userAgent: LINUX_HEADLESS, uaData: { mobile: false, platform: 'Linux' }, memory: 8, touchPoints: 0, coarse: false, cores: 4, screen: { width: 800, height: 600 } }, { mobile: false, gpuClass: 'unknown', startTier: 0, lite: false }],
    // A software adapter stays at Minimal on a phone too, even one short of memory: it is not a phone GPU.
    ['SwiftShader under phone emulation', { ...MALI_G52, adapter: 'google / swiftshader', memory: 2 }, { mobile: true, gpuClass: 'unknown', startTier: 0, lite: false }],
  ]
  for (const [label, d, want] of cases) {
    const b = boot(d)
    assert.deepEqual(b.profile, want, label)
    assert.equal(b.cars, 36, label)
    assert.notEqual(b.agents, CROWD_DEFAULT.lite, label)
    assert.equal(tierRange(b.profile).min, 0, `${label}: never walks into Lite`)
    assert.equal(b.governor.state().lite, undefined, label)
  }
})

test('lite 2: the other entry-level families are lite too: Midgard, PowerVR, Adreno 5xx and older, and any phone with 2 GB or less', () => {
  for (const adapter of ['arm / midgard', 'arm / / Mali-T830 MP2', 'arm / / Mali-G31 MP2', 'img-tec / rogue', 'imagination / / PowerVR Rogue GE8320', 'qualcomm / adreno-5xx', 'qualcomm / / Adreno (TM) 506', 'qualcomm / adreno-4xx']) {
    assert.equal(boot({ ...MALI_G52, adapter }).profile.lite, true, adapter)
  }
  for (const adapter of ['qualcomm / adreno-6xx', 'qualcomm / / Adreno (TM) 619', 'qualcomm / adreno-7xx', 'arm / / Mali-G57 MC2', 'arm / valhall']) {
    assert.equal(boot({ ...MALI_G52, adapter }).profile.lite, false, adapter)
  }
  assert.equal(boot({ ...MALI_G52, adapter: 'qualcomm / adreno-7xx', memory: 2 }).profile.lite, true, '2 GB: lite whatever the GPU')
  assert.equal(boot({ ...MALI_G52, adapter: 'arm / valhall', memory: 4 }).profile.lite, false, '4 GB on its own is not')
})

// ---------------------------------------------------------------------------------------------------
// 3. ?lite=1 and ?lite=0

test('lite 3: ?lite=1 makes any device a lite profile; ?lite=0 gives the Mali-G52 back the profile it had before', () => {
  const desk = boot({ adapter: 'nvidia / ampere', userAgent: WIN_CHROME, uaData: { mobile: false, platform: 'Windows' }, memory: 8, touchPoints: 0, coarse: false, cores: 16, screen: { width: 2560, height: 1440 } }, true)
  assert.deepEqual(desk.profile, { mobile: false, gpuClass: 'discrete', startTier: -1, lite: true })
  assert.deepEqual(tierRange(desk.profile), { min: -1, max: 0 })
  assert.deepEqual([desk.agents, desk.cars, desk.governor.tier], [2500, 12, -1])
  // Off on the phone: Minimal, the phone range, 5,000 pedestrians and 36 cars, as before this profile existed.
  const off = boot(MALI_G52, false)
  assert.deepEqual(off.profile, { mobile: true, gpuClass: 'mobile', startTier: 0, lite: false })
  assert.deepEqual(tierRange(off.profile), { min: 0, max: 2 })
  assert.deepEqual([off.agents, off.cars, off.governor.tier], [5000, 36, 0])
  // Absent, the hints decide.
  assert.equal(boot(MALI_G52, undefined).profile.lite, true)
})
