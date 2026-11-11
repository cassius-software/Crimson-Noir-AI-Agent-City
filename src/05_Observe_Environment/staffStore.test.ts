// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins how the player's own agents stay posted at their homes' workstations between visits
 * (staffStore.ts): a record round-trips exactly; nothing stored, no storage, storage that throws, junk and another
 * version all read as nobody posted and never throw; each entry is checked on its own (a bad one dropped, the rest
 * kept), the first post for a name (any case) and for a workstation wins, and at most twelve are kept, the roster's
 * own limit; a post moves an agent, frees the workstation's agent and lets go of names no longer on the roster, while a
 * load never drops a well-formed post; every record is frozen; and every storage call sits inside a try.
 * What breaks if it is removed? A hand-edited or damaged entry could throw at boot or post a name the roster never
 * screened, two agents could share a workstation, or a save could be lost without the page knowing.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ROSTER_MAX } from '../08_Swarm/roster.ts'
import type { ProfileStore } from './profile.ts'
import {
  NO_STAFF, RAW_MAX, STAFF_KEY, STAFF_MAX, STAFF_VERSION, clearStaff, loadStaff, postAt, postOf, postTo, saveStaff, standDownAt, type StaffRecord,
} from './staffStore.ts'

function memory(): ProfileStore & { map: Map<string, string>; sets: number } {
  const map = new Map<string, string>()
  const m = { map, sets: 0, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { m.sets++; map.set(k, v) }, removeItem: (k: string) => { map.delete(k) } }
  return m
}
const throwing: ProfileStore = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => { throw new Error('denied') } }
/** A store holding `value` under the key. */
const holding = (value: string) => { const m = memory(); m.map.set(STAFF_KEY, value); return m }
const stored = (posts: unknown, v: unknown = 1) => JSON.stringify({ v, posts })
const names = (rec: StaffRecord) => rec.map((p) => `${p.name}@${p.home}:${p.c},${p.r}`)

test('loads nobody from nothing, from junk, from another version and from storage that throws', () => {
  assert.equal(loadStaff(null), NO_STAFF, 'no storage')
  assert.equal(loadStaff(memory()), NO_STAFF, 'nothing saved')
  assert.equal(loadStaff(throwing), NO_STAFF, 'storage that throws')
  for (const raw of ['', 'x'.repeat(RAW_MAX + 1), '{', '[]', '[["Mara",1,10,20]]', 'null', '7', '"text"', JSON.stringify({ v: 1 }), stored('Mara'), stored([['Mara', 1, 10, 20]], 2), stored([['Mara', 1, 10, 20]], 0), stored([['Mara', 1, 10, 20]], '1')]) {
    assert.deepEqual(loadStaff(holding(raw)), NO_STAFF, `nobody from ${raw.slice(0, 40)}`)
  }
  assert.equal(STAFF_VERSION, 1)
  assert.equal(STAFF_KEY, 'civic-simulation:staff:v1')
})

test('a record round-trips exactly, and a save writes only what reads back the same', () => {
  const store = memory()
  const rec = postTo(NO_STAFF, 'Mara', 1, 10, 20, ['Mara'])
  assert.equal(saveStaff(rec, store), true)
  assert.equal(store.map.get(STAFF_KEY), '{"v":1,"posts":[["Mara",1,10,20]]}')
  assert.deepEqual(loadStaff(store), rec)
  const two = postTo(rec, 'Theo', 6, 4, 0, ['Mara', 'Theo'])
  assert.equal(saveStaff(two, store), true)
  assert.deepEqual(names(loadStaff(store)), ['Mara@1:10,20', 'Theo@6:4,0'])
  // A record that would not load back the same (a name the store refuses) is never written; nor without storage, nor
  // when the store throws.
  const before = store.sets
  assert.equal(saveStaff([{ name: 'Two words', home: 1, c: 2, r: 20 }], store), false)
  assert.equal(store.sets, before, 'nothing written')
  assert.equal(saveStaff(rec, null), false)
  assert.equal(saveStaff(rec, throwing), false)
  clearStaff(store)
  assert.equal(loadStaff(store), NO_STAFF, 'clear forgets every post')
  clearStaff(null)
  clearStaff(throwing)
})

test('entries are checked one by one: a bad one is dropped, the rest kept; the first per name and per workstation wins; at most twelve', () => {
  const good = ['Mara', 1, 10, 20]
  const bad: unknown[] = [
    ['Two words', 1, 2, 20], [' Mara2', 1, 2, 20], ['Ma​ra', 1, 2, 20], [7, 1, 2, 20], ['', 1, 2, 20],
    ['Theo', -1, 2, 20], ['Theo', 7, 2, 20], ['Theo', 1.5, 2, 20], ['Theo', 1, 32, 20], ['Theo', 1, 2, 1.5], ['Theo', 1, -1, 20], ['Theo', 1, 2, '20'],
    ['Theo', 1, 2], ['Theo', 1, 2, 20, 0], { name: 'Theo' }, null, 'Theo',
  ]
  for (const entry of bad) {
    assert.deepEqual(names(loadStaff(holding(stored([entry, good])))), ['Mara@1:10,20'], `dropped: ${JSON.stringify(entry)}`)
  }
  // The first for a name in any case, and the first for a workstation.
  assert.deepEqual(names(loadStaff(holding(stored([good, ['MARA', 2, 4, 20], ['Theo', 1, 10, 20], ['Theo', 1, 4, 20]])))), ['Mara@1:10,20', 'Theo@1:4,20'])
  // At most twelve, the roster's own limit.
  assert.equal(STAFF_MAX, ROSTER_MAX)
  const many = Array.from({ length: 15 }, (_, i) => [`Agent${i}`, i % 7, i, 30])
  const kept = loadStaff(holding(stored(many)))
  assert.equal(kept.length, STAFF_MAX)
  assert.deepEqual(names(kept).at(-1), 'Agent11@4:11,30')
})

test('a post moves an agent, frees the workstation\'s agent and lets go of names off the roster; a stand-down frees one workstation', () => {
  const roster = ['Mara', 'Theo', 'Ines']
  let rec = postTo(NO_STAFF, 'Mara', 1, 10, 20, roster)
  rec = postTo(rec, 'Theo', 1, 4, 20, roster)
  assert.deepEqual(names(rec), ['Mara@1:10,20', 'Theo@1:4,20'])
  rec = postTo(rec, 'mara', 2, 4, 24, roster)
  assert.deepEqual(names(rec), ['Theo@1:4,20', 'mara@2:4,24'], 'moved: one post per name, in any case')
  rec = postTo(rec, 'Ines', 1, 4, 20, roster)
  assert.deepEqual(names(rec), ['mara@2:4,24', 'Ines@1:4,20'], 'Theo freed from the workstation Ines takes')
  assert.equal(postOf(rec, 'MARA')?.home, 2)
  assert.equal(postOf(rec, 'Theo'), null)
  assert.equal(postAt(rec, 1, 4, 20)?.name, 'Ines')
  assert.equal(postAt(rec, 1, 10, 20), null)
  // A load never drops a well-formed post whose name left the roster; the next post does.
  const store = memory()
  saveStaff(postTo(postTo(NO_STAFF, 'Old', 1, 10, 20, ['Old']), 'Theo', 1, 4, 20, ['Old', 'Theo']), store)
  const loaded = loadStaff(store)
  assert.deepEqual(names(loaded), ['Old@1:10,20', 'Theo@1:4,20'], 'kept on load')
  assert.deepEqual(names(postTo(loaded, 'Mara', 2, 4, 24, ['Theo', 'Mara'])), ['Theo@1:4,20', 'Mara@2:4,24'], 'let go on the next post')
  // A stand-down frees that one workstation; one nobody stands at changes nothing.
  assert.deepEqual(names(standDownAt(rec, 1, 4, 20)), ['mara@2:4,24'])
  assert.deepEqual(names(standDownAt(rec, 3, 0, 0)), names(rec))
})

test('every record is frozen, down to each post', () => {
  const rec = postTo(postTo(NO_STAFF, 'Mara', 1, 10, 20, ['Mara', 'Theo']), 'Theo', 1, 4, 20, ['Mara', 'Theo'])
  for (const r of [NO_STAFF, rec, standDownAt(rec, 1, 4, 20), loadStaff(holding(stored([['Mara', 1, 10, 20]])))]) {
    assert.ok(Object.isFrozen(r))
    for (const p of r) assert.ok(Object.isFrozen(p))
  }
})

test('the store imports only the grid and the profile\'s name rule, has no banned word, and every storage call sits inside a try', () => {
  const src = readFileSync(new URL('./staffStore.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /matri/i)
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  assert.deepEqual(imports, ['../02_Define_The_Rules/homeGrid.ts', './profile.ts'])
  assert.match(src, /function browserStore\(\): ProfileStore \| null \{\n\s+try \{ return \(globalThis as \{ localStorage\?: ProfileStore \}\)\.localStorage \?\? null \} catch \{ return null \}/)
  const calls = src.split('\n').filter((l) => /store\.(getItem|setItem|removeItem)\(/.test(l))
  assert.equal(calls.length, 3)
  for (const l of calls) assert.match(l, /^\s+try \{ /, l)
})
