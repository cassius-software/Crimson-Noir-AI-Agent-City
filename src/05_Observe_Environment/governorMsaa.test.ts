// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves who draws the scene 4x multisampled (governor.ts msaaCandidate): automatically only
 * a high-end discrete desktop that starts at Ultra on a screen up to 2560 × 1440 drawing pixels, ?msaa deciding on any
 * other desktop, and never a phone or a lite profile; and that it stays out of the tier table (the boot decides it).
 * What breaks if it is removed? A change could multisample every desktop (an integrated GPU paying four samples a
 * pixel), a 4K screen, or a phone that asked with ?msaa=1, or make it a tier knob that rebuilds every pipeline, silently.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LITE, MSAA, PEAK, TIERS, msaaCandidate, profileDevice, type DeviceHints } from './governor.ts'

const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
/** Safari on an iPad, which asks for the desktop site: a Mac user agent (the touch points tell it apart). */
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'

/** A 16-thread Windows desktop with 8 GB reported (Chromium caps deviceMemory at 8) and a 1080p screen. */
const base: DeviceHints = { adapter: '', userAgent: WIN, mobileHint: false, maxTouchPoints: 0, coarsePointer: false, cores: 16, memoryGb: 8, screenPixels: 1920 * 1080 }
const RTX_5090: DeviceHints = { ...base, adapter: 'nvidia / blackwell / NVIDIA GeForce RTX 5090' }
const RX_7800: DeviceHints = { ...base, adapter: 'amd / rdna-3 / AMD Radeon RX 7800 XT' }
const TURING: DeviceHints = { ...base, adapter: 'nvidia / turing / NVIDIA GeForce RTX 2070' }
const APPLE_M: DeviceHints = { ...base, adapter: 'apple / metal-3', userAgent: MAC }
const IRIS_XE: DeviceHints = { ...base, adapter: 'intel / gen-12lp' }
const RADEON_APU: DeviceHints = { ...base, adapter: 'amd / rdna-2 / AMD Radeon(TM) Graphics' }
const SWIFTSHADER: DeviceHints = { ...base, adapter: 'google / swiftshader' }
const IPAD: DeviceHints = { ...base, adapter: 'apple / metal-3', userAgent: MAC_SAFARI, memoryGb: undefined, maxTouchPoints: 5, coarsePointer: true }
const ADRENO: DeviceHints = { ...base, adapter: 'qualcomm / adreno-7xx', userAgent: ANDROID, maxTouchPoints: 5, coarsePointer: true }
const MALI: DeviceHints = { ...base, adapter: 'arm / bifrost', userAgent: ANDROID, memoryGb: 4, maxTouchPoints: 5, coarsePointer: true }

/** Engine.create's decision: the profile (?lite), then the rule with ?msaa and ?scale. */
const msaa = (h: DeviceHints, url: { msaa?: boolean; lite?: boolean; scale?: number } = {}) =>
  msaaCandidate(h, profileDevice(h, url.lite), url.msaa, url.scale)

test('msaaCandidate: a high-end discrete desktop starting at Ultra multisamples at 1080p and 1440p, not at 4K or past the cap with ?scale', () => {
  assert.equal(profileDevice(RTX_5090).startTier, 4, 'the 5090 starts at Ultra')
  assert.equal(msaa(RTX_5090), true)
  assert.equal(msaa({ ...RTX_5090, screenPixels: 2560 * 1440 }), true, 'the cap is inclusive')
  assert.equal(msaa({ ...RTX_5090, screenPixels: 3840 * 2160 }), false, '4K: the profile marks it down from Ultra, and it is over the cap')
  assert.equal(msaa(RTX_5090, { scale: 2 }), false, '?scale=2 at 1080p draws 8.3 million pixels')
  assert.equal(msaa(RTX_5090, { scale: 1.5 }), false, '?scale=1.5 at 1080p draws 4.7 million pixels: the scale counts squared')
  const UW = { ...RTX_5090, screenPixels: 3440 * 1440 }
  assert.equal(profileDevice(UW).startTier, 4, 'an ultrawide 1440p screen still starts at Ultra')
  assert.equal(msaa(UW), false, '3440 × 1440 draws 5 million pixels, over the cap')
  assert.equal(msaa(UW, { scale: 0.75 }), true, '?scale=0.75 draws 2.8 million of them')
  assert.equal(msaa(RX_7800), true, 'a high-end Radeon where the browser names the card')
  assert.equal(msaa({ ...base, adapter: 'amd / rdna-3' }), false, 'stock Chromium names no AMD card: it starts on High, so ?msaa=1 asks')
})

test('msaaCandidate: everything else waits for ?msaa=1: a desktop that starts below Ultra, an Apple computer, an integrated GPU, a software rasterizer', () => {
  for (const h of [TURING, APPLE_M, IRIS_XE, RADEON_APU, SWIFTSHADER]) {
    assert.equal(msaa(h), false, h.adapter)
    assert.equal(msaa(h, { msaa: true }), true, `${h.adapter} with ?msaa=1`)
  }
  assert.equal(msaa({ ...RTX_5090, cores: 6 }), false, 'fewer than 8 threads: not a Peak candidate')
  assert.equal(msaa({ ...RTX_5090, memoryGb: 4 }), false, 'under 8 GB: not a Peak candidate')
})

test('msaaCandidate: ?msaa=0 turns it off on the biggest card, ?msaa=1 turns it on past the screen cap', () => {
  assert.equal(msaa(RTX_5090, { msaa: false }), false)
  assert.equal(msaa({ ...RTX_5090, screenPixels: 3840 * 2160 }, { msaa: true }), true, 'the page asked: the cap is the automatic rule\'s alone')
})

test('msaaCandidate: never a phone, a tablet or a lite profile, even with ?msaa=1', () => {
  for (const h of [IPAD, ADRENO, MALI]) {
    assert.equal(msaa(h), false, h.adapter)
    assert.equal(msaa(h, { msaa: true }), false, `${h.adapter} with ?msaa=1`)
  }
  assert.equal(profileDevice(MALI).lite, true, 'the Mali-G52 is a lite profile')
  assert.equal(msaa(RTX_5090, { lite: true, msaa: true }), false, '?lite=1 on a desktop')
})

test('MSAA: four samples, and no tier carries a knob for it (the boot decides it, so no tier change rebuilds a pipeline)', () => {
  assert.equal(MSAA.samples, 4)
  assert.equal(MSAA.maxPixels, 2560 * 1440)
  assert.ok(Object.isFrozen(MSAA))
  for (const k of [...TIERS, LITE, PEAK]) {
    assert.ok(!Object.keys(k).some((key) => /msaa|sample/i.test(key)), `${k.label}: ${Object.keys(k).join(', ')}`)
  }
})
