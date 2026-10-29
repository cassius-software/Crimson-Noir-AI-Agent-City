// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the scored device resolver (devices.ts): the seventeen profiles and their
 * features, the CRC-16 fingerprint against its check value, every stage's candidate and score, the order the
 * stages win in (ids over a name over a headset's words over the standard mapping over a layout), the bus bonus,
 * that the family it reports is the one gamepad.ts reports for the same id, that a headset source resolves by its
 * target-ray mode, its hand or its mapping, and that nothing ever resolves to null, however empty or random the
 * clues. Also that the HAL puts the resolver's word on its rows and the console prints it.
 * What breaks if it is removed? A device could resolve to the wrong profile, or to none, unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BUS_BONUS, crc16, describeResolution, FINGERPRINT_NAMES, fingerprintOf, guessLayout, normalizeName, padClues, profileForFingerprint,
  profileForId, profileOf, PROFILES, resolveDevice, STAGE_SCORE, xrClues, type DeviceClues, type ProfileId,
} from './devices.ts'
import { padFamilyOf } from './gamepad.ts'
import { HalBus } from './hal.ts'
import type { GamepadLike, HardwareNavigator, XrInputSourceLike } from './web-hardware.d.ts'

const CHROMIUM_DS = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'
const FIREFOX_DS = '54c-ce6-DualSense Wireless Controller'
const SAFARI_DS = 'DualSense Wireless Controller'

const pad = (id: string, mapping = 'standard', axes = 4, buttons = 17): GamepadLike => ({
  id, index: 0, connected: true, mapping, timestamp: 0, axes: new Array(axes).fill(0), buttons: Array.from({ length: buttons }, () => ({ pressed: false, value: 0 })),
})

test('seventeen profiles, each id once, the fallback last and featureless', () => {
  assert.equal(PROFILES.length, 17)
  assert.equal(new Set(PROFILES.map((p) => p.id)).size, 17)
  assert.equal(PROFILES.at(-1)?.id, 'unknown')
  const u = profileOf('unknown')
  assert.deepEqual(Object.values(u.features).filter(Boolean), [], 'the city tries to drive nothing on an unknown device')
  for (const p of PROFILES) {
    assert.equal(profileOf(p.id), p)
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.features))
  }
  // No console maker's name on any profile (compliance.test.ts scrubs the source; this pins the names the HUD shows).
  for (const p of PROFILES) assert.doesNotMatch(p.name, /sony|microsoft|playstation/i, p.name)
  assert.ok(profileOf('dualsense-edge-usb').features.paddles && !profileOf('dualsense-usb').features.paddles)
  assert.ok(profileOf('xr-hand').features.hand && profileOf('xr-hand').features.tracked)
})

test('CRC-16/CCITT-FALSE: the check value, the empty string, and a table-free reference', () => {
  assert.equal(crc16(new TextEncoder().encode('123456789')), 0x29b1)
  assert.equal(crc16(new Uint8Array(0)), 0xffff)
  const slow = (bytes: Uint8Array) => {
    let c = 0xffff
    for (const b of bytes) {
      c ^= b << 8
      for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff
    }
    return c
  }
  for (let n = 0; n < 200; n++) {
    const bytes = Uint8Array.from({ length: n % 23 }, (_, i) => (i * 131 + n * 17) & 0xff)
    assert.equal(crc16(bytes), slow(bytes))
  }
})

test('one name under three browsers: the fingerprint is the same, and the table has no collisions', () => {
  assert.equal(normalizeName(CHROMIUM_DS), 'dualsense wireless controller')
  assert.equal(normalizeName(FIREFOX_DS), 'dualsense wireless controller')
  assert.equal(normalizeName('  DualSense   Wireless Controller '), 'dualsense wireless controller')
  assert.equal(fingerprintOf(CHROMIUM_DS), fingerprintOf(SAFARI_DS))
  const seen = new Map<number, ProfileId>()
  for (const { name, profile } of FINGERPRINT_NAMES) {
    const f = fingerprintOf(name)
    assert.ok(!seen.has(f) || seen.get(f) === profile, `${name} collides`)
    seen.set(f, profile)
    assert.equal(profileForFingerprint(f)?.id, profile)
  }
  assert.equal(profileForFingerprint(fingerprintOf('Wireless Controller')), null, 'a name several makers use names no profile')
  assert.equal(profileForFingerprint(0x1234), null)
})

test('by id: the vendor and product from a Chromium or Firefox name, the bus from WebHID', () => {
  const chrome = resolveDevice({ id: CHROMIUM_DS, mapping: 'standard', axes: 4, buttons: 17 })
  assert.equal(chrome.profile.id, 'dualsense-usb')
  assert.equal(chrome.stage, 'id')
  assert.equal(chrome.score, STAGE_SCORE.id)
  assert.equal(chrome.bus, 'usb', 'the Gamepad API hides the bus: the USB profile stands in')
  assert.deepEqual([chrome.vendorId, chrome.productId], [0x054c, 0x0ce6])
  assert.deepEqual(chrome.candidates.map((c) => [c.stage, c.score]), [['id', 100], ['fingerprint', 80], ['standard', 60], ['fallback', 0]])
  assert.equal(resolveDevice({ id: FIREFOX_DS }).profile.id, 'dualsense-usb')
  const bt = resolveDevice({ id: 'Wireless Controller', vendorId: 0x054c, productId: 0x0ce6, bus: 'bluetooth' })
  assert.equal(bt.profile.id, 'dualsense-bluetooth')
  assert.equal(bt.score, STAGE_SCORE.id + BUS_BONUS, 'a bus-specific profile on its bus')
  assert.equal(bt.bus, 'bluetooth')
  assert.equal(resolveDevice({ vendorId: 0x054c, productId: 0x0df2, bus: 'usb' }).profile.id, 'dualsense-edge-usb')
  assert.equal(resolveDevice({ vendorId: 0x054c, productId: 0x0df2, bus: 'bluetooth' }).profile.id, 'dualsense-edge-bluetooth')
  assert.equal(resolveDevice({ id: '54c-df2-DualSense Edge Wireless Controller' }).profile.id, 'dualsense-edge-usb')
  for (const pid of [0x05c4, 0x09cc, 0x0ba0]) assert.equal(resolveDevice({ vendorId: 0x054c, productId: pid }).profile.id, 'dualshock4')
  assert.equal(resolveDevice({ id: 'Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)' }).profile.id, 'letters-a-south')
  assert.equal(resolveDevice({ id: '45e-2ea-Controller' }).profile.id, 'letters-a-south', 'any product of the vendor')
  assert.equal(resolveDevice({ id: 'Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)' }).profile.id, 'letters-b-south')
  assert.equal(resolveDevice({ id: '28de-1205-Steam Deck' }).profile.id, 'valve-pad')
  assert.equal(resolveDevice({ id: 'Steam Virtual Gamepad (STANDARD GAMEPAD Vendor: 28de Product: 11ff)' }).profile.id, 'valve-pad')
  for (const pid of [0xc216, 0xc21d, 0xc219, 0xc21f]) assert.equal(resolveDevice({ vendorId: 0x046d, productId: pid }).profile.id, 'logitech-pad')
  const wheel = resolveDevice({ id: 'G29 Driving Force Racing Wheel (STANDARD GAMEPAD Vendor: 046d Product: c24f)', mapping: 'standard' })
  assert.equal(wheel.profile.id, 'standard-pad', 'the vendor\'s wheels are not its pads')
  assert.equal(wheel.stage, 'standard')
  assert.equal(profileForId(0x1234, 0x0001, 'usb'), null)
  assert.equal(profileForId(0x054c, 0x0ce6, 'unknown')?.busMatched, false)
})

test('by name: a browser that prints no ids (Safari) still finds the pad, above the standard mapping', () => {
  const r = resolveDevice({ id: SAFARI_DS, mapping: 'standard', axes: 4, buttons: 17 })
  assert.equal(r.profile.id, 'dualsense-usb')
  assert.equal(r.stage, 'fingerprint')
  assert.equal(r.score, STAGE_SCORE.fingerprint)
  assert.deepEqual([r.vendorId, r.productId], [-1, -1])
  assert.equal(r.fingerprint, fingerprintOf(SAFARI_DS))
  assert.equal(resolveDevice({ id: 'DUALSHOCK 4 Wireless Controller' }).profile.id, 'dualshock4')
  assert.equal(resolveDevice({ id: 'Pro Controller' }).profile.id, 'letters-b-south')
  assert.equal(resolveDevice({ id: 'Logitech Gamepad F310', mapping: 'standard' }).profile.id, 'logitech-pad')
  assert.equal(resolveDevice({ id: 'DualSense Edge Wireless Controller' }).profile.id, 'dualsense-edge-usb')
})

test('the standard mapping alone: a standard pad of no known make', () => {
  const r = resolveDevice({ id: 'USB Gamepad', mapping: 'standard', axes: 4, buttons: 12 })
  assert.equal(r.profile.id, 'standard-pad')
  assert.equal(r.stage, 'standard')
  assert.equal(r.score, 60)
  assert.equal(r.family, 'generic')
  assert.equal(r.name, 'USB Gamepad')
  assert.equal(resolveDevice({ id: 'Controller (XInput STANDARD GAMEPAD)', mapping: 'standard' }).family, 'abxy', 'the family is gamepad.ts\'s word')
  assert.equal(resolveDevice({ id: '8BitDo SN30 Pro (STANDARD GAMEPAD Vendor: 2dc8 Product: 6101)', mapping: 'standard' }).family, 'generic')
})

test('by position: a pad without the standard mapping, by the layout GenericPads found or a guess from its axes', () => {
  assert.deepEqual(resolveDevice({ id: 'Throttle Quadrant', mapping: '', axes: 6, buttons: 8, layout: 'evdev' }).profile.id, 'generic-evdev')
  assert.equal(resolveDevice({ id: 'x', mapping: '', axes: 6, buttons: 8, layout: 'evdev' }).score, STAGE_SCORE.layout)
  assert.equal(resolveDevice({ id: 'x', mapping: '', axes: 4, buttons: 8, layout: 'four-axis' }).profile.id, 'generic-four-axis')
  assert.equal(resolveDevice({ id: 'x', mapping: '', axes: 2, buttons: 8, layout: 'stick-only' }).profile.id, 'generic-stick-only')
  const guess = resolveDevice({ id: 'x', mapping: '', axes: 4, buttons: 8 })
  assert.equal(guess.profile.id, 'generic-four-axis')
  assert.equal(guess.score, STAGE_SCORE.layout - 5, 'a guess before GenericPads has watched the pad scores a little under a layout seen')
  assert.equal(resolveDevice({ id: 'x', mapping: '', axes: 6, buttons: 8 }).profile.id, 'generic-stick-only', 'six axes read stick-only until the kernel\'s order shows')
  assert.equal(guessLayout(4, 4), 'four-axis')
  assert.equal(guessLayout(3, 4), 'stick-only')
  assert.equal(guessLayout(1, 4), null)
  assert.equal(guessLayout(4, 2), null)
  assert.equal(resolveDevice({ id: 'Pedals', mapping: '', axes: 1, buttons: 0 }).profile.id, 'unknown', 'no stick: no pad')
})

test('a headset: by its target-ray mode, its hand, or its xr-standard gamepad', () => {
  const src = (over: Partial<XrInputSourceLike>): XrInputSourceLike => ({ handedness: 'right', targetRayMode: 'tracked-pointer', profiles: [], ...over })
  const pinch = resolveDevice(xrClues(src({ targetRayMode: 'transient-pointer', profiles: ['generic-trigger'], gamepad: { mapping: '', axes: [], buttons: [{ pressed: false, value: 0 }] } })))
  assert.equal(pinch.profile.id, 'xr-transient-pointer')
  assert.equal(pinch.stage, 'xr')
  assert.equal(pinch.score, STAGE_SCORE.xr)
  assert.equal(pinch.name, 'Gaze and pinch')
  const hand = resolveDevice(xrClues(src({ handedness: 'left', profiles: ['generic-hand'], hand: {} })))
  assert.equal(hand.profile.id, 'xr-hand')
  const stick = resolveDevice(xrClues(src({ profiles: ['oculus-touch-v3', 'generic-trigger-squeeze-thumbstick'], gamepad: { mapping: 'xr-standard', axes: [0, 0, 0, 0], buttons: [] } })))
  assert.equal(stick.profile.id, 'xr-controller')
  assert.equal(stick.profile.layout, 'xr-standard')
  const gaze = resolveDevice(xrClues(src({ handedness: 'none', targetRayMode: 'gaze', gamepad: null })))
  assert.equal(gaze.profile.id, 'unknown', 'a gaze source with no gamepad and no hand is nothing the city reads')
  assert.equal(gaze.stage, 'fallback')
  // Odd shapes never throw.
  assert.equal(resolveDevice(xrClues({ handedness: 7 as unknown as string, targetRayMode: undefined as unknown as string, profiles: ['a', 3 as unknown as string] })).profile.kind, 'unknown')
})

test('never null: no clues at all is the unknown profile at score 0', () => {
  const r = resolveDevice({})
  assert.equal(r.profile.id, 'unknown')
  assert.equal(r.stage, 'fallback')
  assert.equal(r.score, 0)
  assert.deepEqual(r.candidates.map((c) => c.stage), ['fallback'])
  assert.equal(r.name, 'Unknown device')
  assert.equal(r.bus, 'unknown')
})

test('the family agrees with gamepad.ts for every pad id, so a HUD hint and a hal line never disagree', () => {
  const ids = [
    CHROMIUM_DS, FIREFOX_DS, SAFARI_DS, '54c-df2-DualSense Edge Wireless Controller', 'Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
    '45e-b13-Wireless Controller', 'Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)', 'L+R (STANDARD GAMEPAD Vendor: 057e Product: 200e)',
    'Controller (XInput STANDARD GAMEPAD)', 'Steam Virtual Gamepad (STANDARD GAMEPAD Vendor: 28de Product: 11ff)', '28de-1205-Steam Deck',
    'DUALSHOCK 4 Wireless Controller', 'DualSense Edge (HID)', 'Wireless Controller', 'Input Controller', '8BitDo SN30 Pro (STANDARD GAMEPAD Vendor: 2dc8 Product: 6101)',
    'USB Gamepad', '', 'Pro Controller', 'Logitech Gamepad F710',
  ]
  for (const id of ids) {
    for (const mapping of ['standard', '']) assert.equal(resolveDevice({ id, mapping, axes: 4, buttons: 8 }).family, padFamilyOf(id), `${id} (${mapping || 'no mapping'})`)
  }
})

test('random clues never throw, always name one of the seventeen, and score within the stages', () => {
  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]
  const ids = [CHROMIUM_DS, SAFARI_DS, 'USB Gamepad', '', 'x'.repeat(300), '‮ evil', 'Pro Controller', '(STANDARD GAMEPAD Vendor: zz Product: 0001)']
  for (let i = 0; i < 2000; i++) {
    const c: DeviceClues = {
      id: rnd() < 0.8 ? pick(ids) : undefined,
      mapping: rnd() < 0.7 ? pick(['standard', '', 'xr-standard']) : undefined,
      axes: rnd() < 0.7 ? Math.floor(rnd() * 10) : undefined,
      buttons: rnd() < 0.7 ? Math.floor(rnd() * 20) : undefined,
      vendorId: rnd() < 0.5 ? pick([-1, 0x054c, 0x045e, 0x046d, 0xffff, NaN]) : undefined,
      productId: rnd() < 0.5 ? pick([-1, 0x0ce6, 0x0df2, 0xc216, 0, NaN]) : undefined,
      bus: rnd() < 0.5 ? pick(['usb', 'bluetooth', 'unknown']) : undefined,
      layout: rnd() < 0.5 ? pick(['evdev', 'four-axis', 'stick-only', null]) : undefined,
      xr: rnd() < 0.3 ? { handedness: pick(['left', 'right', 'none']), targetRayMode: pick(['gaze', 'tracked-pointer', 'transient-pointer', 'screen', '']), profiles: [], mapping: pick(['xr-standard', '', null]), hand: rnd() < 0.5 } : undefined,
    }
    const r = resolveDevice(c)
    assert.ok(PROFILES.includes(r.profile))
    assert.ok(r.score >= 0 && r.score <= STAGE_SCORE.id + BUS_BONUS)
    assert.ok(r.candidates.length >= 1 && r.candidates[0].profile === r.profile)
    for (let k = 1; k < r.candidates.length; k++) assert.ok(r.candidates[k - 1].score >= r.candidates[k].score, 'best first')
    assert.equal(typeof describeResolution(r), 'string')
  }
})

test('describeResolution: the profile, the score and how it was found', () => {
  assert.equal(describeResolution(resolveDevice({ id: 'Wireless Controller', vendorId: 0x054c, productId: 0x0ce6, bus: 'bluetooth' })), 'dualsense-bluetooth 105 (by id, bluetooth 054c:0ce6)')
  assert.equal(describeResolution(resolveDevice({ id: CHROMIUM_DS })), 'dualsense-usb 100 (by id, usb 054c:0ce6)')
  assert.match(describeResolution(resolveDevice({ id: SAFARI_DS })), /^dualsense-usb 80 \(by name, crc16 [0-9a-f]{4}\)$/)
  assert.equal(describeResolution(resolveDevice({ id: 'USB Gamepad', mapping: 'standard' })), 'standard-pad 60 (standard mapping)')
  assert.equal(describeResolution(resolveDevice({ id: 'x', mapping: '', axes: 4, buttons: 8, layout: 'four-axis' })), 'generic-four-axis 40 (by position)')
  assert.equal(describeResolution(resolveDevice({})), 'unknown 0 (nothing recognised)')
  assert.equal(describeResolution(resolveDevice(xrClues({ handedness: 'right', targetRayMode: 'transient-pointer', profiles: [] }))), 'xr-transient-pointer 70 (by the headset)')
})

test('padClues reads a pad; the HAL puts the resolver\'s word on every pad row', async () => {
  const p = pad(CHROMIUM_DS)
  assert.deepEqual(padClues(p, 'evdev', 'usb'), { id: CHROMIUM_DS, mapping: 'standard', axes: 4, buttons: 17, vendorId: 0x054c, productId: 0x0ce6, bus: 'usb', layout: 'evdev' })
  assert.deepEqual(padClues(pad('USB Gamepad', '')).vendorId, -1)
  const pads: (GamepadLike | null)[] = [p, { ...pad('Throttle Quadrant', '', 6, 8), index: 1 }]
  const nav: HardwareNavigator = { getGamepads: () => pads }
  const bus = new HalBus({ navigator: nav })
  bus.readPads()
  assert.deepEqual(bus.devices().map((d) => [d.name, d.profile]), [
    ['DualSense Wireless Controller', 'dualsense-usb 100 (by id, usb 054c:0ce6)'],
    ['Throttle Quadrant', 'generic-stick-only 35 (by position)'],
  ])
  await bus.dispose()
})
