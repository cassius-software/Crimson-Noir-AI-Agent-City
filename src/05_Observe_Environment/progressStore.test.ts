// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins how the operator's progression is kept between visits: a record round-trips word
 * for word; nothing stored, no storage and storage that throws all read as a new operator and never throw; and every
 * stored value that is not a whole, sealed, in-range record of this layout is refused, moved aside under its own key
 * (so it is not lost without a trace) and reported with its reason. A record that fails validation is never written.
 * What breaks if it is removed? A damaged or hand-edited entry could become the operator, or a save could be lost silently.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AT, RECORD_WORDS, newRecord, seal } from '../02_Define_The_Rules/progression.ts'
import { PROGRESS_KEY, PROGRESS_RECORD_VERSION, PROGRESS_SET_ASIDE_KEY, clearProgress, loadProgress, saveProgress } from './progressStore.ts'
import type { ProfileStore } from './profile.ts'

function memory(): ProfileStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v) }, removeItem: (k) => { map.delete(k) } }
}
const throwing: ProfileStore = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => { throw new Error('denied') } }

test('a record round-trips word for word', () => {
  const s = memory()
  const r = newRecord(1234)
  r[AT.credits] = 98765
  r[AT.level] = 7
  seal(r)
  assert.ok(saveProgress(r, s))
  const raw = JSON.parse(s.map.get(PROGRESS_KEY)!) as { v: number; words: number[] }
  assert.equal(raw.v, PROGRESS_RECORD_VERSION)
  assert.equal(raw.words.length, RECORD_WORDS)
  const back = loadProgress(s)
  assert.ok(back.record)
  assert.deepEqual(Array.from(back.record), Array.from(r))
})

test('nothing stored, no storage, storage that throws: a new operator, never a throw', () => {
  assert.deepEqual(loadProgress(memory()), { record: null })
  assert.deepEqual(loadProgress(null), { record: null })
  assert.deepEqual(loadProgress(throwing), { record: null })
  assert.equal(saveProgress(newRecord(1), null), false)
  assert.equal(saveProgress(newRecord(1), throwing), false)
  clearProgress(throwing)
  clearProgress(null)
})

test('every stored value that is not a whole, sealed, in-range record is refused, set aside and explained', () => {
  const good = newRecord(9)
  const words = Array.from(good)
  const tampered = words.slice()
  tampered[AT.credits] = 999_999_999
  const outOfRange = newRecord(9)
  outOfRange[AT.level] = 40
  seal(outOfRange)
  const cases: [string, string, RegExp][] = [
    ['not json', '{', /not JSON/],
    ['array', '[1,2]', /not an object/],
    ['version', JSON.stringify({ v: 2, words }), /version 2/],
    ['short', JSON.stringify({ v: 1, words: words.slice(1) }), /does not have its words/],
    ['fraction', JSON.stringify({ v: 1, words: words.map((w, i) => (i === 3 ? 0.5 : w)) }), /does not have its words/],
    ['string', JSON.stringify({ v: 1, words: words.map((w, i) => (i === 3 ? '1' : w)) }), /does not have its words/],
    ['tampered', JSON.stringify({ v: 1, words: tampered }), /seal does not match/],
    ['out of range', JSON.stringify({ v: 1, words: Array.from(outOfRange) }), /level out of range/],
    ['huge', 'x'.repeat(5000), /too long/],
  ]
  for (const [name, raw, why] of cases) {
    const s = memory()
    s.map.set(PROGRESS_KEY, raw)
    const r = loadProgress(s)
    assert.equal(r.record, null, name)
    assert.match('why' in r ? r.why ?? '' : '', why, name)
    assert.equal(s.map.has(PROGRESS_KEY), false, `${name}: moved away`)
    assert.equal(s.map.get(PROGRESS_SET_ASIDE_KEY), raw.slice(0, 4096), `${name}: kept aside`)
  }
})

test('an invalid record is never written', () => {
  const s = memory()
  const r = newRecord(3)
  r[AT.credits] = -5
  seal(r)
  assert.equal(saveProgress(r, s), false)
  assert.equal(s.map.size, 0)
  const unsealed = newRecord(3)
  unsealed[AT.credits] = 7
  assert.equal(saveProgress(unsealed, s), false)
})

test('clear forgets the record', () => {
  const s = memory()
  saveProgress(newRecord(5), s)
  clearProgress(s)
  assert.equal(s.map.has(PROGRESS_KEY), false)
})
