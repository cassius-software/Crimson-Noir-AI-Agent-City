// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the folding card's numbers (walkFold.ts): the short card shows the
 * lines its band has room for, between two and six, and says whether it then fits whole (only a card that fits lets
 * touches through its words).
 * What breaks if it is removed? A cut that ignored the band would slice the card's button on a short phone.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FOLD_METRES, LINES_MAX, LINES_MIN, UNMEASURED, fitLines } from './walkFold.ts'

/** The short card but its line: 0.75 rem padding twice, the 0.5 rem gap, a 2.25 rem button, a 1 px border twice. */
const REST = 12 + 12 + 8 + 36 + 2
const LINE = 20

test('the short card shows the lines its band has room for, never fewer than two nor more than six', () => {
  // A 360 x 552 page on foot: 131 px between Sloane's chip and the buttons.
  assert.deepEqual(fitLines(131, REST, LINE, 9 * LINE), { lines: 3, whole: true })
  // Beside a car the band is the 7 rem under the minimap's row: two lines, and the button is not cut.
  assert.deepEqual(fitLines(112, REST, LINE, 9 * LINE), { lines: 2, whole: true })
  // A tall phone has room for the whole of most lines; six at most, More has the rest.
  assert.deepEqual(fitLines(423, REST, LINE, 9 * LINE), { lines: LINES_MAX, whole: true })
  assert.equal(LINES_MIN, 2)
  assert.equal(LINES_MAX, 6)
  for (let room = 1; room < 600; room += 7) {
    const { lines } = fitLines(room, REST, LINE, 9 * LINE)
    assert.ok(lines >= LINES_MIN && lines <= LINES_MAX, `${lines} lines in ${room} px`)
    if (lines > LINES_MIN) assert.ok(REST + lines * LINE <= room, 'more than the least only where they fit')
  }
})

test('a band too short for two lines keeps two and is not whole: that card scrolls and keeps its touches', () => {
  assert.deepEqual(fitLines(71, REST, LINE, 9 * LINE), { lines: LINES_MIN, whole: false })
  assert.deepEqual(fitLines(REST + 2 * LINE - 1, REST, LINE, 9 * LINE), { lines: LINES_MIN, whole: false })
  assert.deepEqual(fitLines(REST + 2 * LINE, REST, LINE, 9 * LINE), { lines: LINES_MIN, whole: true })
})

test('a line shorter than its share takes only its own height', () => {
  // One line of text in a band with room for one line and the rest: whole, though two lines would not fit.
  assert.deepEqual(fitLines(REST + LINE, REST, LINE, LINE), { lines: LINES_MIN, whole: true })
  // Buttons wrapped to a second row count in the rest.
  assert.deepEqual(fitLines(131, REST + 44, LINE, 9 * LINE), { lines: LINES_MIN, whole: false })
})

test('a card not laid out yet is unmeasured: three lines, not whole', () => {
  for (const [room, rest, line, text] of [[Number.NaN, REST, LINE, 100], [0, REST, LINE, 100], [131, Number.NaN, LINE, 100], [131, REST, 0, 100], [131, REST, Number.NaN, 100], [131, REST, LINE, Number.NaN]]) {
    assert.equal(fitLines(room, rest, line, text), UNMEASURED)
  }
  assert.deepEqual(UNMEASURED, { lines: 3, whole: false })
  assert.ok(Object.isFrozen(UNMEASURED))
})

test('an open card folds once the visitor has covered three metres', () => {
  assert.equal(FOLD_METRES, 3)
})
