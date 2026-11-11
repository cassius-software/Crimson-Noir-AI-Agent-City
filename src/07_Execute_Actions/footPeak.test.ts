// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the HUD foot's latch (footPeak.ts): the highest foot seen holds
 * while the window keeps its size, so captions coming and going never lower it, and a new size lets it go.
 * What breaks if it is removed? A latch that followed the captions down would flip the first walk's layout on a phone.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextFootPeak } from './footPeak.ts'

test('the latch rises with the foot and never falls while the window keeps its size', () => {
  let l = nextFootPeak(null, '844x390', 59)
  assert.deepEqual(l, { size: '844x390', peak: 59 })
  l = nextFootPeak(l, '844x390', 82) // a car adds a caption line
  assert.equal(l.peak, 82)
  const held = nextFootPeak(l, '844x390', 59) // the line expires
  assert.equal(held, l, 'the same latch, unchanged')
  assert.equal(nextFootPeak(held, '844x390', 0).peak, 82, 'the chips gone altogether')
})

test('a new window size lets the latch go and starts it from the foot of that moment', () => {
  const sideways = nextFootPeak(nextFootPeak(null, '844x390', 120), '844x390', 40)
  assert.equal(sideways.peak, 120)
  assert.deepEqual(nextFootPeak(sideways, '390x844', 40), { size: '390x844', peak: 40 })
  assert.deepEqual(nextFootPeak(sideways, '844x356', 0), { size: '844x356', peak: 0 }, 'a browser bar coming in is a new size too')
})

test('a foot that is not a number counts as none', () => {
  assert.equal(nextFootPeak(null, '1x1', Number.NaN).peak, 0)
  assert.equal(nextFootPeak(null, '1x1', -5).peak, 0)
})
