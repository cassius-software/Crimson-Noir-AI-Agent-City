// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It runs the furnishing view's visit (furnishVisit.ts) the way the card drives it, with a
 * shopkeeper and an engine of its own: a piece picked up goes back to its place when the card closes or another line
 * is taken, even where a stored piece would take its spot or where the home is full; a right press on no cell removes
 * nothing, and one on a piece removes that piece; the left stick moves once, again after 300 ms and then every 120 ms,
 * and a diagonal held with the stick's own noise moves no faster; Enter and Space press a button reached with Tab, and
 * place over one a mouse left focused (homeCard.test.ts holds the card to wiring these, and the browser smoke test
 * clicks View with a real mouse and presses Enter).
 * What breaks if it is removed? Closing the card could leave a different layout from the one the owner had, a right
 * click on a wall could remove some other piece, a diagonal could race the cursor across the room, and Enter after a
 * click could press Remove again instead of placing, with nothing to say so but a person furnishing.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEPTH, GRID, HOME_PIECES } from '../02_Define_The_Rules/homeGrid.ts'
import { canPlace, fitLayout, type Piece } from '../02_Define_The_Rules/homeLayout.ts'
import { freshHomes, layoutOf, withHome, type HomeRecord } from '../05_Observe_Environment/homeStore.ts'
import { FocusOrigin, STICK, Visit, stickStep, type FurnishHooks, type StickState } from './furnishVisit.ts'
import type { Shopkeeper } from './shopkeeper.ts'
import { GATE } from './storeCatalog.ts'

const BOOKCASE = 164, SOFA = 163, TABLE = 162

/** A visit to home `home` over `record`, with the lines in `owned` owned; what it hands the host is kept in `sent`. */
function visitOf(home: number, record: HomeRecord, owned: Iterable<number>) {
  const lines = new Set(owned)
  const sent: HomeRecord[] = []
  const drafts: unknown[] = []
  const keeper = {
    owns: (id: number) => lines.has(id),
    buy: (id: number) => { lines.add(id); return { verdict: GATE.bought, message: 'Bought' } },
  } as unknown as Shopkeeper
  const hooks: FurnishHooks = {
    refusal: () => null, begin: () => {}, setDraft: (d) => { drafts.push(d) }, blocked: () => new Uint8Array(GRID * GRID),
    pickCell: () => null, canvas: () => null,
  }
  const v = new Visit(home, record, { keeper, onRecord: (r) => sent.push(r), hooks, onClose: () => {}, changed: () => {} })
  const owns = (id: number) => lines.has(id)
  /** The home's layout as the engine draws it now: what stands here and what does not. */
  const drawn = () => fitLayout(home, v.record[home]?.pieces ?? [], owns)
  return { v, sent, drafts, owns, drawn }
}

const key = (p: Piece) => `${p.id}@${p.c},${p.r}/${p.rot}`
const keys = (list: readonly Piece[]) => list.map(key)

test('a piece picked up goes back to its place on closing or taking another line, even where a stored piece would take its spot', () => {
  // The loft: a bookcase against the back wall, and a sofa saved on the same cells that fits only while it is gone
  // (saved while its line was not owned, say): the sofa stands stored behind the bookcase.
  const home = 0
  const B: Piece = { id: BOOKCASE, c: 4, r: 20, rot: 0 }, S: Piece = { id: SOFA, c: 4, r: 20, rot: 0 }
  const owns = () => true
  assert.deepEqual(keys(fitLayout(home, [B, S], owns).placed), [key(B)], 'the bookcase stands, the sofa does not')
  assert.deepEqual(keys(fitLayout(home, [S], owns).placed), [key(S)], 'the sofa fits once the bookcase is gone')
  const record = withHome(freshHomes(), home, layoutOf(0, 1, [B], [S]))

  for (const end of ['close', 'another line', 'undo'] as const) {
    const { v, sent, drafts, drawn } = visitOf(home, record, [BOOKCASE, SOFA])
    // Place with the sofa in hand over the bookcase: it does not fit, so the bookcase under the cursor is picked up.
    v.moveTo(B.c, B.r)
    v.run('place')
    assert.equal(v.lifted && key(v.lifted), key(B), `${end}: the bookcase in hand`)
    assert.equal(sent.length, 1, 'the pickup is a committed edit')
    if (end === 'close') v.settle()
    else if (end === 'another line') v.run({ pick: SOFA })
    else v.run('undo')
    assert.equal(v.lifted, null)
    assert.deepEqual(keys(drawn().placed), [key(B)], `${end}: the bookcase back where it was`)
    assert.deepEqual(keys(drawn().stored), [key(S)], `${end}: the sofa stored as before`)
    assert.deepEqual(keys(v.record[home]!.pieces), [key(B), key(S)], `${end}: the saved order as before`)
    if (end === 'close') assert.equal(drafts.at(-1), null, 'and the draft taken away')
  }
})

test('a piece picked up in a full home goes back to its place: the piece kept out only because the home was full stays out', () => {
  // The Sky-Mansion with 16 pieces, and an owned holo table saved after them that fits but for the count.
  const home = 6
  const owns = () => true
  const first = GRID - DEPTH[home]
  const candidates: Piece[] = []
  for (const id of [168, 163, 160, 161, 166, 164]) for (let r = first; r < GRID; r++) for (let c = 0; c < GRID; c++) candidates.push({ id, c, r, rot: 0 })
  const placed: Piece[] = []
  for (const p of candidates) {
    if (placed.length >= HOME_PIECES) break
    if (canPlace(home, placed, p, null, owns) === 'ok') placed.push(p)
  }
  assert.equal(placed.length, HOME_PIECES)
  const last = placed[HOME_PIECES - 1]
  const extra = candidates.map((p) => ({ ...p, id: TABLE })).find((q) => canPlace(home, placed, q, null, owns) === 'full' && canPlace(home, placed.slice(0, -1), q, null, owns) === 'ok')
  assert.ok(extra, 'a holo table that fits but for the count')
  const record = withHome(freshHomes(), home, layoutOf(0, 0, placed, [extra]))
  assert.deepEqual(keys(fitLayout(home, record[home]!.pieces, owns).stored), [key(extra)])

  for (const end of ['close', 'another line'] as const) {
    const { v, drawn } = visitOf(home, record, [160, 161, 162, 163, 164, 165, 166, 167, 168])
    v.sel = null
    v.moveTo(last.c, last.r)
    v.run('place')
    assert.equal(v.lifted && key(v.lifted), key(last), `${end}: the last piece in hand`)
    if (end === 'close') v.settle()
    else v.run({ pick: TABLE })
    assert.deepEqual(keys(drawn().placed), keys(placed), `${end}: the 16 pieces as they were`)
    assert.deepEqual(keys(drawn().stored), [key(extra)], `${end}: the holo table still not placed here`)
  }
})

test('a right press on no cell removes nothing (as a left press there does nothing); on a piece it removes that piece', () => {
  const home = 0
  const B: Piece = { id: BOOKCASE, c: 4, r: 20, rot: 0 }, S: Piece = { id: SOFA, c: 8, r: 23, rot: 0 }
  const record = withHome(freshHomes(), home, layoutOf(0, 1, [B, S]))
  const { v, sent, drawn } = visitOf(home, record, [BOOKCASE, SOFA])
  assert.deepEqual(keys(drawn().placed), [key(B), key(S)])
  v.moveTo(9, 23) // the cursor rests on the sofa
  // pickCell's null (the ray past the floor: the top of a tall piece, a wall, the glass) or the plan's doorway band.
  v.run({ removeAt: null })
  v.run({ press: null })
  assert.equal(sent.length, 0, 'nothing committed')
  assert.deepEqual(keys(drawn().placed), [key(B), key(S)], 'both pieces still stand')
  assert.deepEqual(v.cursor, { c: 9, r: 23 }, 'and the cursor stays')
  // A right press on the bookcase removes the bookcase, not the sofa under the cursor.
  v.run({ removeAt: { c: 5, r: 20 } })
  assert.deepEqual(keys(drawn().placed), [key(S)], 'the piece pressed is the piece removed')
  assert.equal(v.said, 'Bookcase removed')
  // Remove (Delete, X, the pad's X, the button) takes the piece under the cursor, as before.
  v.moveTo(9, 23)
  v.run('remove')
  assert.deepEqual(keys(drawn().placed), [])
})

/** The cursor's moves from the left stick held at (x, y) for `ms` (polled at 60 Hz from t = 0), by direction. */
function held(s: StickState, at: (frame: number) => readonly [number, number], ms = 1000): number[] {
  const moves: number[] = []
  for (let f = 0; f * 1000 / 60 <= ms; f++) {
    const [x, y] = at(f)
    const dir = stickStep(s, x, y, f * 1000 / 60)
    if (dir >= 0) moves.push(dir)
  }
  return moves
}
const armed = (): StickState => ({ armed: true, dir: -1, next: 0 })

test('the left stick: once past the dead zone, again after 300 ms, then every 120 ms; a diagonal held with the stick\'s noise no faster', () => {
  assert.deepEqual([STICK.dead, STICK.first, STICK.repeat], [0.5, 300, 120], 'section 7 of the homes plan')
  // Held one second: at 0, 300, 420, 540, 660, 780 and 900 ms.
  assert.deepEqual(held(armed(), () => [0.9, 0]), [1, 1, 1, 1, 1, 1, 1], 'to +c')
  assert.deepEqual(held(armed(), () => [0, -0.9]), [0, 0, 0, 0, 0, 0, 0], 'toward the back')
  // A diagonal: the same seven moves, along one axis, steady or with noise either way of 45 degrees.
  for (const noise of [0, 0.005, 0.02, 0.05]) {
    const moves = held(armed(), (f) => {
      const n = f % 2 ? noise : -noise
      return [0.705 + n, 0.705 - n]
    })
    assert.equal(moves.length, 7, `noise ${noise}: ${moves.length} moves in a second`)
    assert.equal(new Set(moves).size, 1, `noise ${noise}: one direction`)
  }
  // A real turn moves at once: right for half a second, then up.
  const s = armed()
  const turned = held(s, (f) => (f < 30 ? [0.9, 0.1] : [0.1, -0.9]))
  assert.deepEqual(turned.slice(0, 3), [1, 1, 1], 'right at 0, 300 and 420 ms')
  assert.equal(turned[3], 0, 'up as soon as the stick turns (500 ms)')
  assert.deepEqual(turned.slice(3), [0, 0, 0], 'then up at 500, 800 and 920 ms')
  // Held as the view opens: nothing until it has rested inside the dead zone.
  const late: StickState = { armed: false, dir: -1, next: 0 }
  assert.deepEqual(held(late, () => [0.9, 0], 500), [], 'a stick held as the view opens')
  assert.equal(stickStep(late, 0.1, 0, 600), -1)
  assert.equal(stickStep(late, 0.9, 0, 620), 1, 'counted once let go')
  // Let go and pushed again: it moves at once.
  assert.equal(stickStep(late, 0, 0, 640), -1)
  assert.equal(stickStep(late, 0.9, 0, 660), 1)
})

test('Enter and Space press a button reached with Tab, and stay Place over a button a mouse or a finger left focused', () => {
  const button = () => ({ tagName: 'BUTTON' }) as unknown as EventTarget
  const card = { tagName: 'ASIDE' } as unknown as EventTarget
  const o = new FocusOrigin()
  assert.equal(o.byKeys(card), false, 'the card itself: Place')
  // A mouse click on Remove (the focus was on the card): the focus it brings is the pointer's, whatever the keys do next.
  const remove = button()
  o.pointerDown(null)
  o.focusIn(remove)
  o.click()
  o.key('ArrowDown')
  assert.equal(o.byKeys(remove), false, 'Enter after a click on Remove places, and never presses Remove again')
  // Tab on: the next button is the keyboard's, and so is Remove reached back with Shift+Tab.
  const undo = button()
  o.key('Tab')
  o.focusIn(undo)
  assert.equal(o.byKeys(undo), true, 'a button reached with Tab keeps Enter')
  o.key('Tab')
  o.focusIn(remove)
  assert.equal(o.byKeys(remove), true, 'and one reached back with Shift+Tab')
  // Clicked once it has the focus (no focusin follows): the pointer's again.
  o.pointerDown(remove)
  o.click()
  assert.equal(o.byKeys(remove), false, 'clicked after Tab: the pointer\'s')
  // The window left and come back: the focus returns to Remove with a focusin of its own, and it stays the pointer's.
  o.blur()
  o.focusIn(remove)
  assert.equal(o.byKeys(remove), false, 'back from another window, still the pointer\'s')
  // A finger's tap focuses only once it lifts, after a held key's repeats: still the pointer's.
  const rotate = button()
  o.pointerDown(null)
  o.key('KeyW')
  o.focusIn(rotate)
  o.click()
  assert.equal(o.byKeys(rotate), false, 'a tap\'s focus')
  // A press that ended before the focus moved (the page moved it): the keyboard's.
  const view = button()
  o.focusIn(view)
  assert.equal(o.byKeys(view), true, 'a focus no press brought')
  // A press that Tab cut short: the focus Tab moves is the keyboard's.
  const done = button()
  o.pointerDown(null)
  o.key('Tab')
  o.focusIn(done)
  assert.equal(o.byKeys(done), true, 'Tab during a press')
})
