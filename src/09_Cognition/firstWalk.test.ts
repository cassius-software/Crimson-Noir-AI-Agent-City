// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the first walk: seven stages in a fixed order, each finished by the
 * reading or event that means it was done (a turn of the head and three metres; a goal, the microphone or the
 * captions; a car entered; a room entered; the wardrobe put away after it was open; a law line run at the console; the
 * city unlocked), a stage done early kept without a word, a stage the map or the page cannot offer passed over, Sloane's line at every start, one hint per stage
 * after a quiet spell and never before the cooldown, the exit finished by nothing but `unlock`, and every spoken
 * line plain, true to the city, admissible under the conduct screen and never calling the walk a lesson.
 * What breaks if it is removed? A walk that skips a stage, nags, or can be passed without the program would ship unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { screen } from '../02_Define_The_Rules/conduct.ts'
import { FirstWalk, PROGRAM, STAGES, SWARM_ROLE, SWARM_SIZE, WALK, askFor, available, cardFor, eli8Of, hintFor, inWords, lawLine, passedLine, whysOf, type FirstWalkOptions, type Stage, type WalkReading } from './firstWalk.ts'

const S = 1000
const KEYS: FirstWalkOptions = { family: 'keyboard', words: { move: 'W A S D', look: 'Mouse', interact: 'E', console: '~' }, city: { fleet: true, rooms: true } }
const PAD: FirstWalkOptions = { family: 'pad', words: { move: 'L', look: 'R', interact: 'A', console: '~' }, city: { fleet: true, rooms: true } }
const TOUCH: FirstWalkOptions = { family: 'touch', words: { move: 'Stick', look: 'Drag', interact: 'Enter car', console: 'Menu' }, city: { fleet: true, rooms: true } }
const still = (over: Partial<WalkReading> = {}): WalkReading => ({ x: 0, z: 0, yaw: 0, travelled: 0, driving: false, inside: false, consoleOpen: false, ...over })

/** A walk started at 0 with a first reading taken. */
function begun(o: FirstWalkOptions = KEYS): FirstWalk {
  const w = new FirstWalk(o)
  w.start(0)
  w.read(still(), 0)
  return w
}

test('the seven stages in order, each finished by its reading or event; the exit only by unlock; Sloane speaks at every start and at the end', () => {
  const w = begun()
  assert.equal(w.stage, 'move')
  const first = w.tick(0)
  assert.ok(first && first.kind === 'ask' && first.stage === 'move' && first.id === 1, 'the first stage is said at once')
  assert.equal(w.tick(1 * S), null, 'and only once')
  // A turn of the head alone is not enough, nor three metres alone: both.
  w.read(still({ yaw: 0.5 }), 2 * S)
  assert.equal(w.stage, 'move')
  w.read(still({ yaw: 0.5, travelled: 3.2 }), 3 * S)
  assert.equal(w.stage, 'voice')
  const second = w.tick(3 * S)
  assert.ok(second && second.kind === 'ask' && second.stage === 'voice' && second.id === 2)
  w.note('goal', 4 * S)
  assert.equal(w.stage, 'fleet')
  assert.equal(w.tick(4 * S)?.stage, 'fleet')
  w.read(still({ yaw: 0.5, travelled: 9, driving: true }), 5 * S)
  assert.equal(w.stage, 'work')
  assert.equal(w.tick(5 * S)?.stage, 'work')
  w.read(still({ yaw: 0.5, travelled: 40, inside: true }), 6 * S)
  assert.equal(w.stage, 'style')
  const style = w.tick(6 * S)
  assert.ok(style && style.kind === 'ask' && style.stage === 'style')
  assert.match(style.text, /Look/)
  w.note('wardrobe', 6.5 * S)
  assert.equal(w.stage, 'ring0')
  assert.equal(w.tick(6.5 * S)?.stage, 'ring0')
  w.note('console', 7 * S)
  assert.equal(w.stage, 'ring0', 'opening the console is not reading the laws')
  w.note('law', 8 * S)
  assert.equal(w.stage, 'exam')
  const exam = w.tick(8 * S)
  assert.ok(exam && exam.kind === 'ask' && exam.stage === 'exam')
  assert.match(exam.text, /verify_ring0/)
  // The exit: the seal and the swarm are the doors; only unlock passes.
  w.note('seal', 9 * S)
  w.note('swarm', 10 * S)
  assert.deepEqual(w.exam, { seal: true, swarm: true })
  assert.equal(w.passed, false)
  w.read(still({ yaw: 3, travelled: 500, driving: true, inside: true, consoleOpen: true }), 11 * S)
  assert.equal(w.passed, false, 'no reading passes the exit')
  w.note('unlock', 12 * S)
  assert.equal(w.passed, true)
  const last = w.tick(12 * S)
  assert.ok(last && last.kind === 'passed')
  assert.equal(w.tick(13 * S), null)
  assert.equal(w.tick(1000 * S), null, 'nothing more, ever')
  assert.deepEqual([...w.done], STAGES)
})

test('unlock before the exit is reached does nothing; the seal and swarm doors are remembered whenever they are reported', () => {
  const w = begun()
  w.note('unlock', 1 * S)
  assert.equal(w.passed, false)
  assert.equal(w.stage, 'move')
  w.note('seal', 2 * S)
  assert.equal(w.exam.seal, true)
})

test('a later stage done early is kept, and said nothing of until its turn', () => {
  const w = begun()
  w.tick(0)
  // Into a car while still on the first stage: fleet is done, the card still says look and walk, Sloane is silent.
  w.read(still({ driving: true }), 1 * S)
  assert.equal(w.stage, 'move')
  assert.equal(w.tick(1 * S), null)
  assert.ok(w.done.has('fleet'))
  w.note('law', 2 * S)
  assert.ok(w.done.has('ring0'))
  // The first stage done: the next undone is voice.
  w.read(still({ driving: true, yaw: 1, travelled: 5 }), 3 * S)
  assert.equal(w.stage, 'voice')
  assert.equal(w.tick(3 * S)?.stage, 'voice')
  w.note('goal', 4 * S)
  assert.equal(w.stage, 'work', 'fleet was done early')
  w.note('inside', 5 * S)
  assert.equal(w.stage, 'style')
  w.note('wardrobe', 6 * S)
  assert.equal(w.stage, 'exam', 'ring0 was done early')
  // The wardrobe put away during an earlier stage counts the same way.
  const v = begun()
  v.note('wardrobe', 1 * S)
  assert.ok(v.done.has('style'))
  assert.equal(v.stage, 'move')
})

test('a stage the map or the page cannot offer is passed over: no cars, no rooms, no wardrobe; the exit never is', () => {
  const w = new FirstWalk({ ...KEYS, city: { fleet: false, rooms: false, wardrobe: false }, done: ['exam'] })
  assert.ok(w.done.has('fleet') && w.done.has('work') && w.done.has('style'))
  assert.equal(w.done.has('exam'), false, 'done may not name the exit')
  w.start(0)
  w.read(still(), 0)
  w.read(still({ yaw: 1, travelled: 4 }), 1 * S)
  w.note('goal', 2 * S)
  assert.equal(w.stage, 'ring0')
  assert.equal(available('fleet', { fleet: false, rooms: true }), false)
  assert.equal(available('work', { fleet: true, rooms: false }), false)
  assert.equal(available('style', { fleet: true, rooms: true, wardrobe: false }), false)
  assert.equal(available('style', { fleet: true, rooms: true }), true, 'a page that does not say has the wardrobe card')
  for (const s of STAGES) if (s !== 'fleet' && s !== 'work') assert.equal(available(s, { fleet: false, rooms: false }), true, s)
  // A reload mid-walk picks up where it was.
  const r = new FirstWalk({ ...KEYS, done: ['move', 'voice', 'fleet'] })
  assert.equal(r.stage, 'work')
})

test('one hint per stage, after hintMs with no progress and not before the cooldown since the last line; progress restarts the wait', () => {
  const w = begun()
  w.tick(0)
  for (let t = 1; t < 45; t++) assert.equal(w.tick(t * S), null, `patient at ${t}s`)
  const hint = w.tick(45 * S)
  assert.ok(hint && hint.kind === 'hint' && hint.stage === 'move')
  assert.match(hint.text, /drag/)
  assert.equal(w.tick(100 * S), null, 'one hint per stage')
  // The next stage: the ask comes at once (it is pending, not timed), and its hint waits for the cooldown too.
  w.read(still({ yaw: 1, travelled: 4 }), 101 * S)
  assert.equal(w.tick(101 * S)?.kind, 'ask')
  w.note('look', 120 * S) // activity: the quiet spell restarts
  assert.equal(w.tick(150 * S), null)
  assert.equal(w.tick(164 * S), null)
  assert.equal(w.tick(165 * S)?.kind, 'hint')
  // Shorter timings for the hook's tests.
  const q = new FirstWalk({ ...KEYS, hintMs: 1000, cooldownMs: 500 })
  q.start(0)
  q.read(still(), 0)
  q.tick(0)
  assert.equal(q.tick(999), null)
  assert.equal(q.tick(1000)?.kind, 'hint')
  assert.equal(WALK.hintMs, 45_000)
  assert.equal(WALK.cooldownMs, 45_000)
})

test('nothing before start, nothing after the pass, and the first reading only anchors the head and the odometer', () => {
  const w = new FirstWalk(KEYS)
  assert.equal(w.tick(0), null)
  w.note('goal', 0)
  w.read(still({ yaw: 2, travelled: 50 }), 0)
  assert.equal(w.stage, 'move')
  w.start(1 * S)
  w.read(still({ yaw: 2, travelled: 50 }), 1 * S)
  w.read(still({ yaw: 2.1, travelled: 51 }), 2 * S)
  assert.equal(w.stage, 'move', 'a reading is measured from the first one after start')
  w.start(5 * S)
  assert.equal(w.said, 1, 'start twice is start once')
})

test('the exit program is the three lines, in order, with the role and the swarm the whys name', () => {
  assert.deepEqual(PROGRAM, ['let seal = verify_ring0();', 'let swarm = spawn_subagents(24, "sim2real_workplaces");', 'unlock_city(seal, swarm);'])
  assert.equal(SWARM_ROLE, 'sim2real_workplaces')
  assert.equal(SWARM_SIZE, 24)
  assert.equal(inWords(24), 'twenty-four')
  assert.equal(inWords(6), 'six')
  assert.equal(inWords(99), '99')
})

test('the law lines: laws, kernel, act gate, act list, ring0 and ring0 status; nothing else', () => {
  for (const l of ['laws', ' laws ', 'LAWS', 'kernel', 'act gate', 'act  gate', 'act list', 'ring0', 'ring0 status']) assert.ok(lawLine(l), l)
  for (const l of ['law', 'help laws', 'act ok', 'ring0 unlock --elite x', 'stats', 'noir print(1);', '']) assert.equal(lawLine(l), false, l)
})

test('every spoken line is plain words, admissible, true to the device, and never calls the walk a lesson', () => {
  // (The brand scrub itself, compliance.test.ts, already reads every line here for the words it bans.)
  const banned = /tutorial|lesson|step \d|toronto|cn tower/i
  const check = (text: string, label: string) => {
    assert.ok(text.length > 20 && text.length < 420, `${label}: ${text.length} chars`)
    assert.doesNotMatch(text, banned, `${label}: ${text}`)
    assert.equal(screen(text).admissible, true, `${label}: ${text}`)
  }
  for (const o of [KEYS, PAD, TOUCH, { ...KEYS, name: 'Dana' }, { ...TOUCH, place: () => ({ name: 'the clinic', metres: 120.4, bearing: 'north' }) }]) {
    for (const s of STAGES) {
      const ask = askFor(s, o), hint = hintFor(s, o)
      check(ask.text, `${o.family} ${s} ask`)
      check(hint.text, `${o.family} ${s} hint`)
      for (const k of [...ask.keep, ...hint.keep]) assert.ok(ask.text.includes(k) || hint.text.includes(k), `${s}: keeps '${k}'`)
      check(eli8Of(s), `${s} eli8`)
      const whys = whysOf(s)
      assert.equal(whys.length, 5, `${s}: five whys`)
      for (const w of whys) { check(w, `${s} why`); assert.match(w, /^Why .*\? Because /, w) }
      const card = cardFor(s, o)
      assert.equal(card.index, STAGES.indexOf(s) + 1)
      assert.equal(card.count, 7)
      assert.ok(card.title && card.show && card.ask === ask.text)
    }
  }
  check(passedLine(), 'passed')
  check(passedLine('Dana'), 'passed named')
  assert.match(passedLine('Dana'), /Dana/)
  // The device's words reach the lines.
  assert.match(askFor('move', KEYS).text, /W A S D/)
  assert.match(askFor('move', PAD).text, /the R stick/)
  assert.match(askFor('move', TOUCH).text, /stick in the corner/)
  assert.match(askFor('fleet', TOUCH).text, /tap Enter car/)
  assert.match(askFor('fleet', PAD).text, /press A/)
  assert.match(askFor('ring0', TOUCH).text, /Menu/)
  assert.match(askFor('ring0', KEYS).text, /~ key/)
  assert.match(askFor('style', TOUCH).text, /Tap Look/)
  assert.match(askFor('style', KEYS).text, /Click Look/)
  assert.deepEqual([...askFor('style', PAD).keep], ['Look', 'Done'])
  assert.match(askFor('style', { ...KEYS, name: 'Dana' }).text, /how you look, Dana/)
  assert.match(askFor('move', { ...KEYS, name: 'Dana' }).text, /Welcome in, Dana/)
  assert.match(hintFor('work', { ...KEYS, place: () => ({ name: 'the clinic', metres: 120.4, bearing: 'north' }) }).text, /the clinic, about 120 metres to the north/)
  assert.match(hintFor('work', KEYS).text, /wide open doorway/)
  // The exam's words name the three doors.
  const e = askFor('exam', KEYS)
  assert.deepEqual([...e.keep], ['verify_ring0', 'spawn_subagents', 'unlock_city'])
  assert.match(e.text, /twenty-four sub-agents/)
  const stages: Stage[] = ['move', 'voice', 'fleet', 'work', 'style', 'ring0', 'exam']
  assert.deepEqual([...STAGES], stages)
})
