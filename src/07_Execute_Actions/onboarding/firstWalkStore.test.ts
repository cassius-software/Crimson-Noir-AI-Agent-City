// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the first walk's switch and memory: on for a first run of the city
 * shell and off once passed; `?tutorial=0` off and `?tutorial=1` on whatever was saved; never in the console shell;
 * off on the expert path; the default in one constant; a pass kept under the package id and read back whole, a
 * damaged or foreign record read as none, and a store that throws read as none.
 * What breaks if it is removed? A visitor could be locked into the walk on every visit, or never see it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FIRST_WALK_DEFAULT, FIRST_WALK_KEY, clearFirstWalk, loadFirstWalk, needsFirstWalk, saveFirstWalkPassed } from './firstWalkStore.ts'
import type { KeyStore } from './script.ts'

function memory(): KeyStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v) }, removeItem: (k) => { map.delete(k) } }
}
const q = (s: string) => new URLSearchParams(s)
const passed = { v: 1 as const, passed: true as const, at: 1 }

test('on for a first run, off once passed, and the URL knobs: tutorial, onboarding, boot', () => {
  assert.equal(FIRST_WALK_DEFAULT, false, 'opt-in until the exit program is in NoirScript; then true, and mandatory on a first run as the brief asks')
  assert.equal(needsFirstWalk(q(''), null, true), true)
  assert.equal(needsFirstWalk(q(''), passed, true), false)
  assert.equal(needsFirstWalk(q(''), null), FIRST_WALK_DEFAULT)
  assert.equal(needsFirstWalk(q('tutorial=0'), null, true), false)
  assert.equal(needsFirstWalk(q('tutorial=off'), null, true), false)
  assert.equal(needsFirstWalk(q('tutorial=1'), passed), true, 'again, after a pass')
  assert.equal(needsFirstWalk(q('tutorial=on'), passed), true)
  assert.equal(needsFirstWalk(q('boot=tty'), null, true), false, 'no city in the console shell')
  assert.equal(needsFirstWalk(q('boot=tty&tutorial=1'), null, true), false)
  assert.equal(needsFirstWalk(q('onboarding=0'), null, true), false, 'the expert path: the smoke, the harnesses, a developer')
  assert.equal(needsFirstWalk(q('onboarding=off'), null, true), false)
  assert.equal(needsFirstWalk(q('onboarding=0&tutorial=1'), null, true), true, 'asked for outright, it shows on the expert path too')
  assert.equal(needsFirstWalk(q('onboarding=1'), passed, true), false, 'seeing the onboarding again is not the walk again')
  assert.equal(needsFirstWalk(q('tutorial=maybe'), null, true), true, 'an unknown value is no knob')
  // The default in one place: off, the walk is opt-in.
  assert.equal(needsFirstWalk(q(''), null, false), false)
  assert.equal(needsFirstWalk(q('tutorial=1'), null, false), true)
})

test('a pass is kept under the package id and read back; damaged, foreign or absent records read as none', () => {
  const s = memory()
  assert.equal(loadFirstWalk(s), null)
  saveFirstWalkPassed(1700000000000, s)
  assert.equal(FIRST_WALK_KEY, 'civic-simulation:first-walk:v1')
  assert.deepEqual(JSON.parse(s.map.get(FIRST_WALK_KEY)!), { v: 1, passed: true, at: 1700000000000 })
  assert.deepEqual(loadFirstWalk(s), { v: 1, passed: true, at: 1700000000000 })
  saveFirstWalkPassed(Number.NaN, s)
  assert.deepEqual(loadFirstWalk(s), { v: 1, passed: true, at: 0 })
  clearFirstWalk(s)
  assert.equal(loadFirstWalk(s), null)
  for (const raw of ['', 'true', '{}', '{"v":2,"passed":true}', '{"v":1,"passed":false}', '{"v":1}', 'not json', '['.padEnd(200, 'x')]) {
    s.map.set(FIRST_WALK_KEY, raw)
    assert.equal(loadFirstWalk(s), null, raw)
  }
  assert.equal(loadFirstWalk(null), null)
  const broken: KeyStore = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => { throw new Error('denied') } }
  assert.equal(loadFirstWalk(broken), null)
  assert.doesNotThrow(() => saveFirstWalkPassed(1, broken))
  assert.doesNotThrow(() => clearFirstWalk(broken))
})
