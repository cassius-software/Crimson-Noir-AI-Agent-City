// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves who builds the post chain's ambient occlusion (governor.ts aoCandidate): every
 * desktop-class profile unless the page says ?ao=0, the software rasterizer and an integrated GPU included (built is
 * not running: only a tier with aoTaps runs it), and never a phone, a tablet or a lite profile, whatever ?ao says.
 * What breaks if it is removed? A change could build it on phones (two pipelines and two targets for a tier they never
 * reach), or leave it out of the desktops that climb to Ultra, silently.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aoCandidate, profileDevice, type DeviceHints } from './governor.ts'

const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'

const base: DeviceHints = { adapter: '', userAgent: WIN, mobileHint: false, maxTouchPoints: 0, coarsePointer: false, cores: 16, memoryGb: 8, screenPixels: 1920 * 1080 }
const DESKTOPS: DeviceHints[] = [
  { ...base, adapter: 'nvidia / blackwell / NVIDIA GeForce RTX 5090' },
  { ...base, adapter: 'nvidia / turing / NVIDIA GeForce RTX 2070' },
  { ...base, adapter: 'amd / rdna-2 / AMD Radeon(TM) Graphics' },
  { ...base, adapter: 'intel / gen-12lp' },
  { ...base, adapter: 'google / swiftshader' },
]
const PHONES: DeviceHints[] = [
  { ...base, adapter: 'apple / metal-3', userAgent: MAC_SAFARI, memoryGb: undefined, maxTouchPoints: 5, coarsePointer: true },
  { ...base, adapter: 'qualcomm / adreno-7xx', userAgent: ANDROID, maxTouchPoints: 5, coarsePointer: true },
  { ...base, adapter: 'arm / bifrost', userAgent: ANDROID, memoryGb: 4, maxTouchPoints: 5, coarsePointer: true },
]

test('aoCandidate: every desktop builds it unless ?ao=0, whatever its GPU (only Ultra and Peak run it)', () => {
  for (const h of DESKTOPS) {
    const p = profileDevice(h)
    assert.equal(p.mobile || p.lite, false, `${h.adapter} is a desktop profile`)
    assert.equal(aoCandidate(p), true, h.adapter)
    assert.equal(aoCandidate(p, true), true, `${h.adapter} with ?ao=1`)
    assert.equal(aoCandidate(p, false), false, `${h.adapter} with ?ao=0`)
  }
})

test('aoCandidate: never a phone, a tablet or a lite profile, even with ?ao=1', () => {
  for (const h of PHONES) {
    assert.equal(aoCandidate(profileDevice(h)), false, h.adapter)
    assert.equal(aoCandidate(profileDevice(h), true), false, `${h.adapter} with ?ao=1`)
  }
  assert.equal(aoCandidate(profileDevice(DESKTOPS[0], true), true), false, '?lite=1 on a desktop')
})
