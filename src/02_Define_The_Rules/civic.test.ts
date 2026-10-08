// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The signal cycle is implemented twice (here and in crowd.wgsl) and read by
 * both drivers and pedestrians; these tests pin the safety property that matters: nobody is told to go
 * into a conflicting flow.
 * What breaks if it is removed? A timing edit could put walking pedestrians in front of green traffic.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SIGNAL, signalFor, walkAllowed } from './civic.ts'

const samples = Array.from({ length: SIGNAL.cycle * 20 }, (_, i) => i / 20)

test('exactly one axis is ever non-red', () => {
  for (const t of samples) {
    const ew = signalFor('ew', t), ns = signalFor('ns', t)
    assert.ok(ew === 'red' || ns === 'red', `t=${t}: ew=${ew} ns=${ns}`)
    assert.ok(ew !== 'red' || ns !== 'red', `t=${t}: all red`)
  }
})

test('pedestrians only walk alongside green traffic, never across it', () => {
  for (const t of samples) {
    if (walkAllowed('ew', t)) assert.equal(signalFor('ew', t), 'green', `t=${t}`)
    if (walkAllowed('ns', t)) assert.equal(signalFor('ns', t), 'green', `t=${t}`)
    assert.ok(!(walkAllowed('ew', t) && walkAllowed('ns', t)))
  }
})

test('walk ends at least 2 s before amber so late starters clear the crossing', () => {
  for (const t of samples) {
    const p = t % SIGNAL.cycle
    if (walkAllowed('ew', t)) assert.ok(p < SIGNAL.ewGreen - 2, `t=${t}`)
    if (walkAllowed('ns', t)) assert.ok(p < SIGNAL.nsGreen - 2, `t=${t}`)
  }
})

test('cycle repeats and handles negative time', () => {
  assert.equal(signalFor('ew', 5), signalFor('ew', 5 + SIGNAL.cycle * 7))
  assert.equal(signalFor('ns', -1), 'amber')
})
