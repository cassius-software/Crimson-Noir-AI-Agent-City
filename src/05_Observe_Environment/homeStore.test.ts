// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins how the seven homes' furnishing is kept between visits (homeStore.ts): a record
 * round-trips piece for piece and in order; nothing stored, no storage and storage that throws all read as nothing
 * furnished and never throw; a value too long, not JSON, of another version or without seven homes gives a fresh
 * record; a home that is not a home is forgotten while the others are kept; a piece that is not a piece is dropped
 * while its siblings are kept; whether a piece fits or is owned is never judged here; a save is checked first, so a
 * record that would not load back the same is never written and a throwing store makes a save return false; and a
 * home past 24 pieces, which the furnishing rules allow, is saved with its placed pieces first rather than refused.
 * The two sky floors (rooms 7 and 8) are kept under a key of their own, so the homes' key stays byte for byte as
 * before, and either key broken leaves the other's rooms.
 * What breaks if it is removed? A damaged or hand-edited entry could wipe every home, a piece with a line that does
 * not exist could reach the furnishing rules, or a save could be lost without the page knowing (one crowded home
 * could stop every home from saving).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEPTH, GRID, HOME_PIECES, ROOM_COUNT, SKY_HOMES } from '../02_Define_The_Rules/homeGrid.ts'
import { DEFAULT_FINISH, FLOORS, HOME_STAGING, SHAPE_IDS, SKY_FINISH, SKY_STAGING, WALLS, canPlace, finishDefault, fitLayout, type Piece } from '../02_Define_The_Rules/homeLayout.ts'
import { PROPERTY_KINDS } from '../01_Initialize_World/properties.ts'
import {
  HOME_COUNT, HOME_KEY, HOME_RECORD_VERSION, RAW_MAX, SAVED_MAX, SKY_KEY, clearHomes, finishOf, freshHomes, layoutOf, loadHomes, saveHomes, withHome,
  type HomeLayout, type HomeRecord,
} from './homeStore.ts'
import type { ProfileStore } from './profile.ts'

function memory(): ProfileStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v) }, removeItem: (k) => { map.delete(k) } }
}
const throwing: ProfileStore = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => { throw new Error('denied') } }

const piece = (id: number, c: number, r: number, rot: number): Piece => ({ id, c, r, rot })
/** A stored value with these homes. */
const stored = (homes: unknown, v: unknown = 1) => JSON.stringify({ v, homes })
/** A good stored home with one piece, for the homes around the one under test. */
const GOOD = [1, 2, [[163, 2, 24, 0]]]
const goodLayout: HomeLayout = { floor: 1, wall: 2, pieces: [piece(163, 2, 24, 0)] }
/** Nothing furnished: the seven halls and the two sky floors. */
const fresh = () => Array.from({ length: 9 }, () => null)

/** Loads a stored value from a store holding only it. */
function loaded(raw: string): HomeRecord {
  const s = memory()
  s.map.set(HOME_KEY, raw)
  return loadHomes(s)
}
/** The record as plain data, for deepEqual against literals. */
const plain = (r: HomeRecord) => JSON.parse(JSON.stringify(r)) as unknown

test('the key, the version and the sizes are shipped: seven homes by property index, 24 pieces each', () => {
  assert.equal(HOME_KEY, 'civic-simulation:home:v1')
  assert.equal(SKY_KEY, 'civic-simulation:home-sky:v1', 'the sky floors\' key of their own')
  assert.equal(ROOM_COUNT, HOME_COUNT + SKY_HOMES.length)
  assert.equal(ROOM_COUNT, 9, 'the record: seven halls, then two sky floors')
  assert.equal(HOME_RECORD_VERSION, 1)
  assert.equal(HOME_COUNT, 7)
  assert.equal(HOME_COUNT, PROPERTY_KINDS.length, 'one entry per home')
  assert.equal(HOME_COUNT, DEPTH.length)
  assert.equal(SAVED_MAX, 24)
  assert.equal(SAVED_MAX, HOME_PIECES + 8, 'the 16 placed and up to 8 not placed here')
  assert.equal(RAW_MAX, 4096)
  assert.deepEqual(freshHomes(), fresh())
  assert.ok(Object.isFrozen(freshHomes()))
})

test('a record round-trips piece for piece, in order, in the documented format', () => {
  const s = memory()
  const loft = layoutOf(1, 3, [piece(163, 0, 20, 0), piece(164, 0, 21, 3)], [piece(168, 30, 30, 2)])
  const r = withHome(withHome(freshHomes(), 0, loft), 6, layoutOf(2, 5, [piece(162, 10, 10, 1)]))
  assert.ok(saveHomes(r, s))
  assert.equal(s.map.get(HOME_KEY), '{"v":1,"homes":[[1,3,[[163,0,20,0],[164,0,21,3],[168,30,30,2]]],null,null,null,null,null,[2,5,[[162,10,10,1]]]]}')
  assert.equal(s.map.get(SKY_KEY), '{"v":1,"homes":[null,null]}')
  const back = loadHomes(s)
  assert.deepEqual(plain(back), plain(r))
  assert.deepEqual(back[0]?.pieces.map((p) => p.id), [163, 164, 168], 'placed first, then the stored, as saved')
  assert.ok(Object.isFrozen(back) && Object.isFrozen(back[0]) && Object.isFrozen(back[0]?.pieces) && Object.isFrozen(back[0]?.pieces[0]), 'a read record cannot be changed in place')
  // A record with every home empty but furnished (finishes only) keeps each home's finishes.
  const finishes = Array.from({ length: ROOM_COUNT }, (_, i) => layoutOf(i % FLOORS.length, i % WALLS.length, []))
  assert.ok(saveHomes(finishes, s))
  assert.deepEqual(plain(loadHomes(s)), plain(finishes))
  // The show homes' layouts are records this store keeps as they are.
  const staged = [...HOME_STAGING, ...SKY_STAGING].map((pieces, i) => layoutOf(finishDefault(i)!.floor, finishDefault(i)!.wall, pieces))
  assert.equal(staged.length, ROOM_COUNT)
  assert.ok(saveHomes(staged, s))
  assert.deepEqual(plain(loadHomes(s)), plain(staged))
})

test('the longest record fits RAW_MAX, and anything longer is not a record', () => {
  const s = memory()
  const most = layoutOf(FLOORS.length - 1, WALLS.length - 1, Array.from({ length: SAVED_MAX }, () => piece(Math.max(...SHAPE_IDS), GRID - 1, GRID - 1, 3)))
  const r = Array.from({ length: ROOM_COUNT }, () => most)
  assert.ok(saveHomes(r, s), 'seven homes and two sky floors of 24 pieces with the widest numbers are written')
  const raw = s.map.get(HOME_KEY) ?? ''
  assert.ok(raw.length <= RAW_MAX && raw.length > 2000, `${raw.length} characters`)
  assert.ok((s.map.get(SKY_KEY) ?? '').length < raw.length, 'the sky floors\' two rooms in less')
  assert.deepEqual(plain(loadHomes(s)), plain(r))
  // A stored value over RAW_MAX is refused whole, even when it would parse.
  const padded = `${raw.slice(0, -1)}${' '.repeat(RAW_MAX - raw.length + 1)}}`
  assert.equal(padded.length, RAW_MAX + 1)
  assert.deepEqual(JSON.parse(padded), JSON.parse(raw), 'the same record, padded')
  assert.deepEqual(loaded(padded), fresh())
  assert.deepEqual(plain(loaded(padded.slice(0, -2) + '}').slice(0, HOME_COUNT)), plain(r.slice(0, HOME_COUNT)), 'at RAW_MAX it still reads')
})

test('nothing stored, no storage, storage that throws: nothing furnished, never a throw', () => {
  assert.deepEqual(loadHomes(memory()), fresh())
  assert.deepEqual(loadHomes(null), fresh())
  assert.deepEqual(loadHomes(throwing), fresh())
  assert.equal(saveHomes(freshHomes(), null), false)
  assert.equal(saveHomes(freshHomes(), throwing), false, 'a throwing store makes save return false')
  const full: ProfileStore = { getItem: () => null, setItem: () => { throw new DOMException('quota', 'QuotaExceededError') }, removeItem: () => {} }
  assert.equal(saveHomes(withHome(freshHomes(), 2, goodLayout), full), false, 'a full store too')
  clearHomes(throwing)
  clearHomes(null)
  const s = memory()
  assert.ok(saveHomes(withHome(freshHomes(), 2, goodLayout), s))
  assert.ok(s.map.has(SKY_KEY), 'both keys are written')
  clearHomes(s)
  assert.equal(s.map.has(HOME_KEY), false)
  assert.equal(s.map.has(SKY_KEY), false, 'and both forgotten')
  assert.deepEqual(loadHomes(s), fresh())
  // The default store: Node has no localStorage, so nothing is read and nothing written.
  assert.deepEqual(loadHomes(), fresh())
  assert.equal(saveHomes(freshHomes()), false)
  clearHomes()
})

test('a value that is not this record gives a fresh record: bad JSON, a wrong v, homes that are not seven', () => {
  const homes = [GOOD, null, null, null, null, null, null]
  assert.ok(loaded(stored(homes))[0], 'the control case reads')
  for (const [name, raw] of [
    ['not json', '{"v":1,"homes":['],
    ['empty', ''],
    ['a number', '7'],
    ['null', 'null'],
    ['an array', JSON.stringify([1, homes])],
    ['version 2', stored(homes, 2)],
    ['version as text', stored(homes, '1')],
    ['no version', JSON.stringify({ homes })],
    ['no homes', JSON.stringify({ v: 1 })],
    ['homes an object', stored({ 0: GOOD })],
    ['six homes', stored(homes.slice(1))],
    ['eight homes', stored([...homes, null])],
    ['too long', 'x'.repeat(RAW_MAX + 1)],
  ] as const) {
    assert.deepEqual(loaded(raw), fresh(), name)
  }
})

test('a home that is not a home becomes null, and the others are kept', () => {
  const bad: [string, unknown][] = [
    ['a number', 3],
    ['an object', { floor: 1, wall: 2, pieces: [] }],
    ['too short', [1, 2]],
    ['too long', [1, 2, [], 0]],
    ['floor out of range', [FLOORS.length, 0, []]],
    ['floor negative', [-1, 0, []]],
    ['floor a fraction', [0.5, 0, []]],
    ['floor as text', ['1', 0, []]],
    ['wall out of range', [0, WALLS.length, []]],
    ['wall null', [0, null, []]],
    ['pieces not a list', [0, 0, { 0: [163, 0, 24, 0] }]],
    ['pieces null', [0, 0, null]],
    ['more than 24 pieces', [0, 0, Array.from({ length: SAVED_MAX + 1 }, () => [164, 0, 20, 0])]],
  ]
  for (const [name, home] of bad) {
    const r = loaded(stored([GOOD, home, null, GOOD, null, null, GOOD]))
    assert.equal(r[1], null, name)
    for (const i of [0, 3, 6]) assert.deepEqual(plain([r[i] ?? null]), plain([goodLayout]), `${name}: home ${i} kept`)
    assert.equal(r.length, ROOM_COUNT)
    assert.deepEqual(r.slice(HOME_COUNT), [null, null], `${name}: the sky floors null while only the homes' key is stored`)
  }
  // The edges that are allowed: the last floor and wall, an empty list, exactly 24 pieces.
  assert.ok(loaded(stored([[FLOORS.length - 1, WALLS.length - 1, []], null, null, null, null, null, null]))[0])
  assert.equal(loaded(stored([[0, 0, Array.from({ length: SAVED_MAX }, () => [164, 0, 20, 0])], null, null, null, null, null, null]))[0]?.pieces.length, SAVED_MAX)
})

test('a piece that is not a piece is dropped, and its siblings are kept', () => {
  const bad: [string, unknown][] = [
    ['no such line', [159, 0, 24, 0]],
    ['the line after the last', [Math.max(...SHAPE_IDS) + 1, 0, 24, 0]],
    ['a deed, not furniture', [224, 0, 24, 0]],
    ['id a fraction', [163.5, 0, 24, 0]],
    ['id as text', ['163', 0, 24, 0]],
    ['column negative', [163, -1, 24, 0]],
    ['column off the grid', [163, GRID, 24, 0]],
    ['row off the grid', [163, 0, GRID, 0]],
    ['row a fraction', [163, 0, 24.5, 0]],
    ['turn 4', [163, 0, 24, 4]],
    ['turn negative', [163, 0, 24, -1]],
    ['turn null', [163, 0, 24, null]],
    ['three numbers', [163, 0, 24]],
    ['five numbers', [163, 0, 24, 0, 0]],
    ['an object', { id: 163, c: 0, r: 24, rot: 0 }],
    ['null', null],
  ]
  for (const [name, p] of bad) {
    const r = loaded(stored([[1, 2, [[164, 0, 20, 0], p, [168, 31, 31, 3]]], GOOD, null, null, null, null, null]))
    assert.deepEqual(plain([r[0]]), plain([layoutOf(1, 2, [piece(164, 0, 20, 0), piece(168, 31, 31, 3)])]), name)
    assert.deepEqual(plain([r[1]]), plain([goodLayout]), `${name}: the next home kept`)
  }
  // Every furniture line, every turn and the grid's corners are pieces.
  const every = SHAPE_IDS.flatMap((id, k) => [0, 1, 2, 3].map((rot) => [id, (k * 7 + rot) % GRID, rot === 3 ? GRID - 1 : rot * 5, rot]))
  const many = loaded(stored([[0, 0, every.slice(0, 24)], [0, 0, every.slice(24)], null, null, null, null, null]))
  assert.equal((many[0]?.pieces.length ?? 0) + (many[1]?.pieces.length ?? 0), SHAPE_IDS.length * 4)
})

test('whether a piece fits or is owned is not judged when it loads', () => {
  // Outside the micro-loft's 12 rows, in the apron, on top of each other: kept, for fitLayout to place or store.
  const r = loaded(stored([[0, 0, [[163, 0, 0, 0], [163, 14, 29, 0], [164, 3, 25, 0], [164, 3, 25, 0]]], null, null, null, null, null, null]))
  assert.equal(r[0]?.pieces.length, 4)
})

test('a save is checked first: a record that would not load back the same is never written, and the last good save stays', () => {
  const s = memory()
  const good = withHome(freshHomes(), 2, goodLayout)
  assert.ok(saveHomes(good, s))
  const kept = s.map.get(HOME_KEY), keptSky = s.map.get(SKY_KEY)
  const bad: [string, unknown][] = [
    ['a room short', fresh().slice(1)],
    ['a room too many', [...fresh(), null]],
    ['the seven homes without the sky floors', fresh().slice(0, HOME_COUNT)],
    ['not a list', { 0: goodLayout }],
    ['null', null],
    ['a floor that does not exist', withHome(freshHomes(), 0, layoutOf(FLOORS.length, 0, []))],
    ['a wall that is a fraction', withHome(freshHomes(), 0, layoutOf(0, 1.5, []))],
    ['a line that does not exist', withHome(freshHomes(), 0, layoutOf(0, 0, [piece(170, 0, 20, 0)]))],
    ['a turn of 4', withHome(freshHomes(), 0, layoutOf(0, 0, [piece(163, 0, 20, 4)]))],
    ['a cell off the grid', withHome(freshHomes(), 0, layoutOf(0, 0, [piece(163, 0, 32, 0)]))],
    ['NaN', withHome(freshHomes(), 0, layoutOf(0, 0, [piece(163, Number.NaN, 20, 0)]))],
    ['a home without pieces', withHome(freshHomes(), 0, { floor: 0, wall: 0 } as unknown as HomeLayout)],
    ['a piece that is null', withHome(freshHomes(), 0, { floor: 0, wall: 0, pieces: [null] } as unknown as HomeLayout)],
  ]
  for (const [name, r] of bad) {
    assert.equal(saveHomes(r as HomeRecord, s), false, name)
    assert.equal(s.map.get(HOME_KEY), kept, `${name}: the last good save stays`)
    assert.equal(s.map.get(SKY_KEY), keptSky, `${name}: and the sky floors' too`)
  }
  // Fields a piece carries beyond its four are not saved, and do not stop the save.
  const extra = withHome(freshHomes(), 1, layoutOf(0, 0, [{ ...piece(163, 0, 20, 0), note: 'x' } as Piece]))
  assert.ok(saveHomes(extra, s))
  assert.deepEqual(plain([loadHomes(s)[1]]), plain([layoutOf(0, 0, [piece(163, 0, 20, 0)])]))
})

test('a home past 24 pieces keeps its placed pieces and the first not placed here, and never stops the record saving', () => {
  // The rules allow it: sixteen pieces placed, a progress reset stores them all, and the lines bought since fill the
  // floor again, every placement 'ok'.
  const home = 5
  const every = (ids: readonly number[]) => {
    const out: Piece[] = []
    for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) for (const id of ids) for (const rot of [0, 1, 2, 3]) out.push(piece(id, c, r, rot))
    return out
  }
  const before: Piece[] = []
  for (const p of every([168, 164, 160])) { if (before.length === HOME_PIECES) break; if (canPlace(home, before, p) === 'ok') before.push(p) }
  const bought = (id: number) => [161, 162, 163, 165, 166, 167].includes(id)
  const fit = fitLayout(home, before, bought)
  const stored = fit.stored
  let placed = fit.placed
  assert.deepEqual([placed.length, stored.length], [0, HOME_PIECES])
  const s = memory()
  let r = withHome(freshHomes(), 1, layoutOf(1, 1, [piece(163, 4, 24, 0)]))
  for (const p of every([161, 162, 163, 165, 166, 167])) {
    if (placed.length === 12) break
    if (canPlace(home, placed, p, null, bought) !== 'ok') continue
    placed = [...placed, p]
    r = withHome(r, home, layoutOf(0, 0, placed, stored))
    assert.ok(saveHomes(r, s), `${placed.length} placed and ${stored.length} not placed here: saved`)
  }
  assert.equal(placed.length, 12)
  // The record in hand is the one a reload brings back: the 12 placed, then the first 12 not placed here.
  assert.deepEqual(r[home]?.pieces, [...placed, ...stored.slice(0, SAVED_MAX - 12)])
  assert.deepEqual(plain(loadHomes(s)), plain(r))
  // An edit to another home still saves.
  r = withHome(r, 1, layoutOf(2, 4, [piece(163, 4, 24, 0)]))
  assert.ok(saveHomes(r, s))
  assert.deepEqual(finishOf(loadHomes(s), 1), { floor: 2, wall: 4 })
  // A home put together past 24 without layoutOf is saved with its first 24; the other homes as they are.
  const crowded: HomeLayout = { floor: 1, wall: 0, pieces: [...placed, ...stored] }
  assert.equal(crowded.pieces.length, 28)
  assert.ok(saveHomes(withHome(r, home, crowded), s))
  const back = loadHomes(s)
  assert.deepEqual(back[home]?.pieces, crowded.pieces.slice(0, SAVED_MAX))
  assert.deepEqual(plain([back[1]]), plain([r[1]]))
  // Trimming never hides a bad piece among the first 24: that record is still refused, and the last good save stays.
  const kept = s.map.get(HOME_KEY)
  assert.equal(saveHomes(withHome(r, home, { floor: 0, wall: 0, pieces: [piece(170, 0, 20, 0), ...crowded.pieces] }), s), false)
  assert.equal(s.map.get(HOME_KEY), kept)
})

test('layoutOf, withHome and finishOf: saved order, a copy, and the defaults for a home never furnished', () => {
  const a = piece(163, 0, 20, 0), b = piece(164, 0, 21, 0), c = piece(168, 4, 24, 0)
  assert.deepEqual(layoutOf(1, 1, [a, b], [c]).pieces, [a, b, c], 'placed, then stored')
  assert.deepEqual(layoutOf(1, 1, [a]).pieces, [a])
  const placed = Array.from({ length: HOME_PIECES }, (_, i) => piece(168, i, 20, 0))
  const kept = Array.from({ length: 12 }, (_, i) => piece(164, i, 30, 0))
  assert.deepEqual(layoutOf(1, 1, placed, kept).pieces, [...placed, ...kept.slice(0, SAVED_MAX - HOME_PIECES)], 'at most 24: the last not placed here let go')
  const r = freshHomes()
  const one = withHome(r, 4, goodLayout)
  assert.deepEqual(r, fresh(), 'the old record is left as it was')
  assert.equal(one[4], goodLayout)
  assert.equal(withHome(one, 4, null)[4], null, 'null forgets it')
  assert.equal(withHome(one, 0, null)[4], goodLayout, 'the other homes are kept')
  assert.equal(withHome([] as HomeRecord, 3, goodLayout).length, ROOM_COUNT, 'always nine entries: the homes and the sky floors')
  assert.equal(withHome(r, 8, goodLayout)[8], goodLayout, 'a sky floor is a room of the record')
  assert.throws(() => withHome(r, 9, null), RangeError)
  assert.throws(() => withHome(r, -1, null), RangeError)
  assert.throws(() => withHome(r, 0.5, null), RangeError)
  for (let i = 0; i < 7; i++) assert.deepEqual(finishOf(r, i), DEFAULT_FINISH[i], `home ${i}: its defaults`)
  for (let i = 7; i < 9; i++) assert.deepEqual(finishOf(r, i), SKY_FINISH[i - 7], `sky floor ${i}: its defaults`)
  assert.deepEqual(finishOf(one, 4), { floor: 1, wall: 2 }, 'the record\'s once furnished')
  assert.deepEqual(finishOf(r, 1), { floor: 1, wall: 1 }, 'the brownstone: oak boards and brick')
  assert.deepEqual(finishOf(r, 2), { floor: 1, wall: 2 }, 'the timber loft: oak boards and oak panelling')
  assert.throws(() => finishOf(r, 9), RangeError)
  assert.throws(() => finishOf(r, -1), RangeError)
})

test('the sky record: its own key and two rooms, each read on its own; the hall key byte for byte as before; either key broken leaves the other', () => {
  const s = memory()
  const pent = layoutOf(1, 0, [piece(163, 13, 9, 0)]), crown = layoutOf(2, 0, [piece(166, 21, 18, 0)], [piece(168, 30, 30, 2)])
  const r = withHome(withHome(withHome(freshHomes(), 1, goodLayout), 7, pent), 8, crown)
  assert.ok(saveHomes(r, s))
  assert.equal(s.map.get(HOME_KEY), '{"v":1,"homes":[null,[1,2,[[163,2,24,0]]],null,null,null,null,null]}', 'the homes\' key as an older build wrote it')
  assert.equal(s.map.get(SKY_KEY), '{"v":1,"homes":[[1,0,[[163,13,9,0]]],[2,0,[[166,21,18,0],[168,30,30,2]]]]}', 'rooms 7 and 8 in the homes\' form')
  assert.deepEqual(plain(loadHomes(s)), plain(r))
  // An older build's store: the homes' key alone loads with rooms 7 and 8 null, their default finishes.
  const old = memory()
  old.map.set(HOME_KEY, s.map.get(HOME_KEY)!)
  const back = loadHomes(old)
  assert.equal(back.length, ROOM_COUNT)
  assert.deepEqual(plain(back.slice(0, HOME_COUNT)), plain(r.slice(0, HOME_COUNT)))
  assert.deepEqual([back[7], back[8]], [null, null])
  assert.deepEqual([finishOf(back, 7), finishOf(back, 8)], [...SKY_FINISH])
  // Either key broken leaves only its own rooms empty.
  for (const broken of ['{"v":1,"homes":[', stored([null]), stored([null, null, null]), stored([null, null], 2), 'x'.repeat(RAW_MAX + 1)]) {
    const a = memory()
    a.map.set(HOME_KEY, s.map.get(HOME_KEY)!)
    a.map.set(SKY_KEY, broken)
    assert.deepEqual(plain(loadHomes(a)), plain(withHome(withHome(r, 7, null), 8, null)), `the sky key ${broken.slice(0, 24)}: the homes kept`)
    const b = memory()
    b.map.set(HOME_KEY, broken)
    b.map.set(SKY_KEY, s.map.get(SKY_KEY)!)
    assert.deepEqual(plain(loadHomes(b)), plain(withHome(r, 1, null)), `the homes' key ${broken.slice(0, 24)}: the sky floors kept`)
  }
  // A sky room that is not a room becomes null, and the other is kept.
  const one = memory()
  one.map.set(SKY_KEY, stored([[FLOORS.length, 0, []], [2, 0, [[166, 21, 18, 0]]]]))
  assert.deepEqual(plain(loadHomes(one).slice(HOME_COUNT)), plain([null, layoutOf(2, 0, [piece(166, 21, 18, 0)])]))
  // A sky key that cannot be written fails the save, while the homes' key is still written.
  const halls = new Map<string, string>()
  const noSky: ProfileStore = { getItem: (k) => halls.get(k) ?? null, setItem: (k, v) => { if (k === SKY_KEY) throw new DOMException('quota', 'QuotaExceededError'); halls.set(k, v) }, removeItem: () => {} }
  assert.equal(saveHomes(r, noSky), false)
  assert.equal(halls.get(HOME_KEY), s.map.get(HOME_KEY), 'one failing does not stop the other')
  // A sky floor that would not load back the same is refused on its own: its last good save stays.
  const keptSky = s.map.get(SKY_KEY)
  assert.equal(saveHomes(withHome(withHome(r, 1, layoutOf(2, 4, [])), 7, layoutOf(0, 0, [piece(170, 13, 9, 0)])), s), false)
  assert.equal(s.map.get(SKY_KEY), keptSky)
  assert.equal(s.map.get(HOME_KEY), '{"v":1,"homes":[null,[2,4,[]],null,null,null,null,null]}', 'the homes still saved')
})

test('the store has no banned word, and only the shapes, the grid and the guarded storage behind it', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./homeStore.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /matri/i)
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  assert.deepEqual(imports, ['../02_Define_The_Rules/homeGrid.ts', '../02_Define_The_Rules/homeLayout.ts', './profile.ts'])
  assert.match(src, /function browserStore\(\): ProfileStore \| null \{\n\s+try \{ return \(globalThis as \{ localStorage\?: ProfileStore \}\)\.localStorage \?\? null \} catch \{ return null \}/)
  // Every storage call sits inside a try, so no store can make load, save or clear throw.
  const calls = src.split('\n').filter((l) => /store\.(getItem|setItem|removeItem)\(/.test(l))
  assert.equal(calls.length, 3)
  for (const l of calls) assert.match(l, /^\s+try \{ /, l)
})
