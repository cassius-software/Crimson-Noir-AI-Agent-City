// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the solar model to known geometry for the simulated site.
 * What breaks if it is removed? A sign error could put the noon sun in the north or at night.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SITE, sunAt } from './solar.ts'

test('solar noon: due south at 90° − latitude + declination', () => {
  const s = sunAt(12)
  assert.ok(Math.abs(s.elevationDeg - (90 - SITE.latitude + SITE.declination)) < 1e-6)
  assert.ok(Math.abs(s.azimuthDeg - 180) < 1e-6)
  assert.ok(s.z > 0.6 && Math.abs(s.x) < 1e-9, 'south is +z')
  assert.equal(s.daylight, 1)
})

test('morning sun is in the east, evening sun in the west', () => {
  assert.ok(sunAt(9).x > 0.3)
  assert.ok(sunAt(15).x < -0.3)
})

test('near the equinox the sun rises about 06:00 and midnight is dark', () => {
  assert.ok(sunAt(5.8).elevationDeg < 0 && sunAt(6.4).elevationDeg > 0)
  assert.equal(sunAt(0).daylight, 0)
})

test('direction is a unit vector', () => {
  for (let h = 0; h < 24; h += 0.5) {
    const s = sunAt(h)
    assert.ok(Math.abs(Math.hypot(s.x, s.y, s.z) - 1) < 1e-9)
  }
})
