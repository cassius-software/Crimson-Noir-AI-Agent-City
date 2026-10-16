// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the swarm's short-term memory: a ring of three moments per person,
 * oldest dropped first and nobody else's seen; the surroundings sentence built from whatever the host measured, in
 * plain words; the prompt section under one heading, the newest moments surviving a tight budget; and the paint words.
 * What breaks if it is removed? A ring that grows without bound, or a prompt that grows with it, would ship unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONTEXT_BUDGET, SHORT_TERM, ShortTermMemory, clipLine, contextLines, contextSection, describeSurroundings, momentLine, nearWord, paintWord, type Interaction,
} from './shortTerm.ts'

const moment = (n: number, who = 'the player'): Interaction => ({ who, what: `said thing ${n}`, where: 'Aurel St & 3rd Ave', at: n * 10, clock: `17:0${n}` })

test('the ring keeps the last three moments per person, oldest first, drops the oldest, and nobody sees anyone else\'s', () => {
  const m = new ShortTermMemory()
  assert.equal(SHORT_TERM, 3)
  assert.deepEqual(m.recent(7), [])
  for (let n = 1; n <= 5; n++) m.remember(7, moment(n))
  m.remember(8, moment(9, 'agent 7'))
  assert.deepEqual(m.recent(7).map((i) => i.what), ['said thing 3', 'said thing 4', 'said thing 5'])
  assert.deepEqual(m.recent(8).map((i) => i.who), ['agent 7'])
  assert.equal(m.people, 2)
  m.forget(7)
  assert.deepEqual(m.recent(7), [])
  assert.equal(m.recent(8).length, 1)
  m.forget()
  assert.equal(m.people, 0)
  m.remember(-1, moment(1))
  m.remember(1.5, moment(1))
  assert.equal(m.people, 0, 'no such person')
  assert.throws(() => new ShortTermMemory(0), RangeError)
})

test('what is remembered is one clipped line each; the copy handed out cannot change the ring', () => {
  const m = new ShortTermMemory(2)
  m.remember(1, { ...moment(1), what: `x\n${'y'.repeat(400)}` })
  const [kept] = m.recent(1)
  assert.ok(kept.what.length <= 160 && kept.what.endsWith('…') && !kept.what.includes('\n'))
  const out = m.recent(1) as Interaction[]
  out.push(moment(2))
  assert.equal(m.recent(1).length, 1)
  assert.equal(clipLine('  a   b  '), 'a b')
})

test('the surroundings sentence: the place, the landmark, the car, the people and the clock in plain words; nothing known gives null', () => {
  assert.equal(describeSurroundings({}), null)
  assert.equal(describeSurroundings({ place: 'Lakefront Metro' }), 'Standing at Lakefront Metro.')
  assert.equal(
    describeSurroundings({ place: 'Lakefront Metro · Aurel St & 3rd Ave', landmark: { name: 'The Spire', metres: 40 }, clock: '17:02', daylight: 'day', car: { colour: 'dark red', metres: 6 }, people: 2 }),
    'Standing near The Spire in Lakefront Metro · Aurel St & 3rd Ave at 17:02, looking at a dark red car a few steps away, with 2 people close by.',
  )
  const far = describeSurroundings({ landmark: { name: 'The Spire', metres: 1200 }, clock: '22:10', daylight: 'night', withPlayer: true, people: 1 })
  assert.equal(far, 'Standing with The Spire about 1200 m away at 22:10, after dark, with the player beside them, with one other person close by.')
  assert.equal(describeSurroundings({ people: 0 }), 'Standing in the city.')
  assert.equal(nearWord(1), 'right here')
  assert.equal(nearWord(50), 'just down the street')
  assert.equal(nearWord(Number.NaN), 'somewhere near')
})

test('the paint words: each of the fleet\'s colours has one, and an unknown colour takes the nearest', () => {
  assert.equal(paintWord(0x7a1a1f), 'dark red')
  assert.equal(paintWord(0xf2f2f0), 'white')
  assert.equal(paintWord(0x800000), 'dark red')
  assert.equal(paintWord(0x1d2f55), 'navy blue')
  assert.equal(paintWord(Number.NaN), 'grey')
})

test('the prompt section: one heading per person, the surroundings then the moments oldest first, within the budget with the newest kept', () => {
  const recent = [moment(1), moment(2), moment(3)]
  const lines = contextLines({ agent: 17, surroundings: 'Standing at Lakefront Metro.', recent })
  assert.deepEqual(lines, [
    'Agent 17, right now:',
    '- Standing at Lakefront Metro.',
    'Just before this, oldest first:',
    '- 17:01 Aurel St & 3rd Ave: the player said thing 1',
    '- 17:02 Aurel St & 3rd Ave: the player said thing 2',
    '- 17:03 Aurel St & 3rd Ave: the player said thing 3',
  ])
  assert.equal(momentLine({ ...moment(4), where: '' }), '17:04: the player said thing 4')
  assert.deepEqual(contextLines({ agent: 1, surroundings: null, recent: [] }), [], 'nothing known: no heading')
  const long = contextLines({ agent: 2, surroundings: 'S'.repeat(300), recent: [moment(1), moment(2), moment(3)] }, 240)
  const total = long.reduce((n, l) => n + l.length + 1, 0)
  assert.ok(total <= 240, `within the budget (${total})`)
  assert.ok(long[1].length <= 122 && long[1].endsWith('…'), 'the surroundings take at most half')
  assert.ok(long.some((l) => l.includes('thing 3')), 'the newest moment survives')
  assert.ok(!long.some((l) => l.includes('thing 1')), 'the oldest goes first')
  const everything = contextLines({ agent: 3, surroundings: 'Standing in the city.', recent }, CONTEXT_BUDGET)
  assert.equal(everything.length, 6)
  // Only the people bound, only those with something to say.
  const section = contextSection([17, 18], [{ agent: 17, surroundings: 'Standing in the city.', recent: [] }, { agent: 99, surroundings: 'elsewhere', recent: [] }, { agent: 18, surroundings: null, recent: [] }])
  assert.deepEqual(section, ['Agent 17, right now:', '- Standing in the city.'])
  assert.deepEqual(contextSection([1], undefined), [])
})

test('a hired agent\'s identity comes first in their section, under the heading, and alone is enough for a heading', () => {
  const lines = contextLines({ agent: 17, identity: 'You go by Nova (she/her), a quant analyst.', surroundings: 'Standing at Lakefront Metro.', recent: [] })
  assert.deepEqual(lines, ['Agent 17, right now:', '- You go by Nova (she/her), a quant analyst.', '- Standing at Lakefront Metro.'])
  assert.deepEqual(contextLines({ agent: 1, identity: 'You go by Kai.', surroundings: null, recent: [] }), ['Agent 1, right now:', '- You go by Kai.'])
  assert.deepEqual(contextLines({ agent: 1, identity: '  ', surroundings: null, recent: [] }), [], 'a blank identity is none')
  assert.deepEqual(contextLines({ agent: 1, identity: null, surroundings: null, recent: [] }), [])
})
