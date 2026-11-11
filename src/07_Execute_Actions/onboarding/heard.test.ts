// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for what Sloane takes of spoken words (heard.ts): the whole line while
 * a question or the goal prompt is open, else only a line that names Sloane first (or "Sloan"), with the name taken
 * off; the room's talk, a possessive, a name alone and nothing at all are null; a long line is cut to the field's
 * length; nothing is taken while she speaks or just after.
 * What breaks if it is removed? Every word near the microphone could become a goal.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HEARD_MAX, HEARD_QUIET_MS, heardGoal, heardNow } from './heard.ts'

test('a line that names Sloane first is a goal without the name, open or not; small words before the name and the pause after it are allowed', () => {
  assert.equal(heardGoal('Sloane, make it night', false), 'make it night')
  assert.equal(heardGoal('sloane make it night', false), 'make it night')
  assert.equal(heardGoal('Hey Sloane, take me to the harbour.', false), 'take me to the harbour.')
  assert.equal(heardGoal('ok so sloane: fewer people please', false), 'fewer people please')
  assert.equal(heardGoal('  Sloane   make   it   night  ', true), 'make it night')
  assert.equal(heardGoal('Sloane', false), null, 'the name alone asks nothing')
  assert.equal(heardGoal('Sloane?', true), null)
})

test('the room\'s talk is nobody\'s goal unless the dialogue is open; nothing and not-a-string are null; long lines are cut', () => {
  assert.equal(heardGoal('is there a problem with the network', false), null)
  assert.equal(heardGoal('is there a problem with the network', true), 'is there a problem with the network', 'the open prompt takes the whole line')
  assert.equal(heardGoal('tell Sloane I said hi', false), null, 'the name later in the line is not an address')
  assert.equal(heardGoal('', true), null)
  assert.equal(heardGoal('   ', true), null)
  assert.equal(heardGoal(undefined as unknown as string, true), null)
  const long = `Sloane, ${'night '.repeat(80)}`
  assert.equal(heardGoal(long, false)?.length, HEARD_MAX)
  assert.equal(heardGoal('x'.repeat(HEARD_MAX + 5), true)?.length, HEARD_MAX)
})

test('the recogniser\'s "Sloan" is her name too; a possessive is talk about her, not to her', () => {
  assert.equal(heardGoal('Sloan, make it night', false), 'make it night')
  assert.equal(heardGoal('hey sloan take me home', false), 'take me home')
  assert.equal(heardGoal("Sloane's going to love this", false), null)
  assert.equal(heardGoal('Sloane’s car is outside', false), null)
  assert.equal(heardGoal('Sloanes', false), null, 'another word')
})

test('nothing heard is the visitor\'s while Sloane speaks or within the quiet tail after her line', () => {
  assert.equal(heardNow(true, 10_000, 0), false, 'while she speaks')
  assert.equal(heardNow(false, 10_000, 10_000 - HEARD_QUIET_MS + 1), false, 'just after her line')
  assert.equal(heardNow(false, 10_000, 10_000 - HEARD_QUIET_MS), true, 'the tail has passed')
  assert.equal(heardNow(false, 10_000, 0), true, 'she has not spoken')
})
