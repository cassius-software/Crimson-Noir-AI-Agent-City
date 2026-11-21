// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the first walk: six stages in a fixed order, each finished by the
 * reading or event that means it was done (a turn of the head and three metres; a goal, the microphone or the
 * captions; a car entered; a room entered; the wardrobe, a shop's card or a home's doorstep card put away after it was
 * open; the console open on the last stage, which passes the walk), the exit program's unlock passing it from any
 * stage, the console opened early passing nothing, the shops and the homes named only on a map that has them and in
 * the device's own words, a stage done early kept without a word, a stage the map or the page cannot offer passed over,
 * Sloane's line at every start, a hand lent after assistMs with nothing done on a stage (and withdrawn when the stage
 * moves on), one hint per stage after a quiet spell and never before the cooldown, and every spoken line plain, true to
 * the city, admissible under the conduct screen and never calling the walk a lesson.
 * What breaks if it is removed? A walk that skips a stage, nags, leaves a stalled visitor alone, or ends before the
 * console would ship unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { screen } from '../02_Define_The_Rules/conduct.ts'
import { FirstWalk, PROGRAM, STAGES, SWARM_ROLE, SWARM_SIZE, WALK, askFor, assistControlsOf, assistLine, assistTargetOf, available, cardFor, eli5Of, FIVE_WS, fiveWsOf, hintFor, inWords, passedBanner, passedLine, type FirstWalkOptions, type Stage, type WalkReading } from './firstWalk.ts'

const S = 1000
const KEYS: FirstWalkOptions = { family: 'keyboard', words: { move: 'W A S D', look: 'Mouse', interact: 'E', console: '~' }, city: { fleet: true, rooms: true } }
const PAD: FirstWalkOptions = { family: 'pad', words: { move: 'L', look: 'R', interact: 'A', console: '~' }, city: { fleet: true, rooms: true } }
const TOUCH: FirstWalkOptions = { family: 'touch', words: { move: 'Stick', look: 'Drag', interact: 'Enter car', console: 'Menu' }, city: { fleet: true, rooms: true } }
/** The same devices on a map with shops (the city's five, Lakefront Metro's). */
const shopping = (o: FirstWalkOptions): FirstWalkOptions => ({ ...o, city: { ...o.city, stores: true } })
/** The same devices on a map with homes for sale (the city's seven, Lakefront Metro's), and on one with shops and homes both. */
const homing = (o: FirstWalkOptions): FirstWalkOptions => ({ ...o, city: { ...o.city, homes: true } })
const everything = (o: FirstWalkOptions): FirstWalkOptions => shopping(homing(o))
/** A stage's five W's as the card shows them, one after another. */
const said = (ws: readonly { w: string; answer: string }[]): string => ws.map((w) => `${w.w}? ${w.answer}`).join(' ')
const still = (over: Partial<WalkReading> = {}): WalkReading => ({ x: 0, z: 0, yaw: 0, travelled: 0, driving: false, inside: false, consoleOpen: false, ...over })

/** A walk started at 0 with a first reading taken. */
function begun(o: FirstWalkOptions = KEYS): FirstWalk {
  const w = new FirstWalk(o)
  w.start(0)
  w.read(still(), 0)
  return w
}

test('the six stages in order, each finished by its reading or event; the console open on the last one passes the walk; Sloane speaks at every start and at the end', () => {
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
  assert.equal(w.stage, 'console')
  const last = w.tick(6.5 * S)
  assert.ok(last && last.kind === 'ask' && last.stage === 'console')
  assert.match(last.text, /~ key/)
  assert.equal(w.passed, false)
  // The console opens: the walk is passed at once.
  w.read(still({ yaw: 0.5, travelled: 40, consoleOpen: true }), 7 * S)
  assert.equal(w.passed, true)
  const end = w.tick(7 * S)
  assert.ok(end && end.kind === 'passed' && end.stage === 'console')
  assert.equal(end.text, passedLine())
  assert.equal(w.tick(8 * S), null)
  assert.equal(w.tick(1000 * S), null, 'nothing more, ever')
  assert.equal(w.done.size, STAGES.length)
  for (const s of STAGES) assert.ok(w.done.has(s), `${s} counts as done once passed`)
})

test('the console reported open (the event, not the reading) on the last stage passes too; opened on any earlier stage it passes nothing', () => {
  const w = new FirstWalk({ ...KEYS, done: ['move', 'voice', 'fleet', 'work', 'style'] })
  w.start(0)
  w.read(still(), 0)
  assert.equal(w.stage, 'console')
  w.note('console', 1 * S)
  assert.equal(w.passed, true)
  // Early: the console opens and closes on the first stage, and the walk carries on where it was.
  const v = begun()
  v.tick(0)
  v.note('console', 1 * S)
  v.read(still({ consoleOpen: true }), 1 * S)
  assert.equal(v.passed, false)
  assert.equal(v.stage, 'move')
  v.read(still(), 2 * S)
  assert.equal(v.tick(2 * S), null, 'and Sloane says nothing of it')
})

test('arriving at the last stage with the console already open is reaching it: passed at once, by a reading or by the event that finished the stage before', () => {
  // The console open while the look stage is finished (its opening put the wardrobe away): the walk passes on the spot.
  const w = new FirstWalk({ ...KEYS, done: ['move', 'voice', 'fleet', 'work'] })
  w.start(0)
  w.read(still(), 0)
  w.tick(0)
  w.read(still({ consoleOpen: true }), 1 * S)
  assert.equal(w.stage, 'style')
  assert.equal(w.passed, false)
  w.note('wardrobe', 1.1 * S)
  assert.equal(w.passed, true)
  assert.equal(w.tick(1.1 * S)?.kind, 'passed', 'no ask for a stage already reached')
  // The other order: the stage finished first, then the reading with the console open.
  const v = new FirstWalk({ ...KEYS, done: ['move', 'voice', 'fleet', 'work'] })
  v.start(0)
  v.read(still(), 0)
  v.note('wardrobe', 1 * S)
  assert.equal(v.stage, 'console')
  v.read(still({ consoleOpen: true }), 1.1 * S)
  assert.equal(v.passed, true)
  // A first reading with the console open on the last stage passes too (a reload with the console open).
  const u = new FirstWalk({ ...KEYS, done: ['move', 'voice', 'fleet', 'work', 'style'] })
  u.start(0)
  u.read(still({ consoleOpen: true }), 0)
  assert.equal(u.passed, true)
})

test('the exit program\'s unlock passes the walk from any stage; the seal and swarm doors are remembered whenever they are reported', () => {
  const w = begun()
  w.tick(0)
  w.note('seal', 1 * S)
  assert.equal(w.exam.seal, true)
  w.note('swarm', 2 * S)
  assert.deepEqual(w.exam, { seal: true, swarm: true })
  assert.equal(w.passed, false, 'the doors alone pass nothing')
  w.note('unlock', 3 * S)
  assert.equal(w.passed, true)
  assert.equal(w.tick(3 * S)?.kind, 'passed')
  w.note('unlock', 4 * S)
  assert.equal(w.tick(4 * S), null, 'passed once')
})

test('a later stage done early is kept, and said nothing of until its turn', () => {
  const w = begun()
  w.tick(0)
  // Into a car while still on the first stage: fleet is done, the card still says look and walk, Sloane is silent.
  w.read(still({ driving: true }), 1 * S)
  assert.equal(w.stage, 'move')
  assert.equal(w.tick(1 * S), null)
  assert.ok(w.done.has('fleet'))
  // The first stage done: the next undone is voice.
  w.read(still({ driving: true, yaw: 1, travelled: 5 }), 3 * S)
  assert.equal(w.stage, 'voice')
  assert.equal(w.tick(3 * S)?.stage, 'voice')
  w.note('goal', 4 * S)
  assert.equal(w.stage, 'work', 'fleet was done early')
  w.note('inside', 5 * S)
  assert.equal(w.stage, 'style')
  w.note('wardrobe', 6 * S)
  assert.equal(w.stage, 'console')
  // The wardrobe put away during an earlier stage counts the same way.
  const v = begun()
  v.note('wardrobe', 1 * S)
  assert.ok(v.done.has('style'))
  assert.equal(v.stage, 'move')
})

test('a shop\'s card put away finishes the look stage as the wardrobe does, at its turn or kept silently before it', () => {
  const w = new FirstWalk({ ...shopping(KEYS), done: ['move', 'voice', 'fleet', 'work'] })
  w.start(0)
  w.read(still(), 0)
  assert.equal(w.stage, 'style')
  assert.match(w.tick(0)?.text ?? '', /shops on the street/)
  w.note('store', 1 * S)
  assert.equal(w.stage, 'console')
  assert.equal(w.tick(1 * S)?.stage, 'console')
  // Out shopping on the first stage: the look stage is done, and Sloane says nothing of it until its turn would have come.
  const v = begun(shopping(KEYS))
  v.tick(0)
  v.note('store', 1 * S)
  assert.ok(v.done.has('style'))
  assert.equal(v.stage, 'move')
  assert.equal(v.tick(1 * S), null)
})

test('a home\'s doorstep card put away finishes the look stage as a shop\'s card does, at its turn or kept silently before it', () => {
  const w = new FirstWalk({ ...everything(KEYS), done: ['move', 'voice', 'fleet', 'work'] })
  w.start(0)
  w.read(still(), 0)
  assert.equal(w.stage, 'style')
  const said = w.tick(0)?.text ?? ''
  assert.match(said, /shops on the street/)
  assert.match(said, /a home for sale/)
  w.note('home', 1 * S)
  assert.equal(w.stage, 'console')
  assert.equal(w.tick(1 * S)?.stage, 'console')
  // Into a home on the first stage: the look stage is done, and Sloane says nothing of it until its turn would have come.
  const v = begun(homing(KEYS))
  v.tick(0)
  v.note('home', 1 * S)
  assert.ok(v.done.has('style'))
  assert.equal(v.stage, 'move')
  assert.equal(v.tick(1 * S), null)
  // Nothing else of the walk hears it: the last stage stays the console's.
  const x = new FirstWalk({ ...homing(KEYS), done: ['move', 'voice', 'fleet', 'work', 'style'] })
  x.start(0)
  x.read(still(), 0)
  x.note('home', 1 * S)
  assert.equal(x.stage, 'console')
  assert.equal(x.passed, false)
})

test('a stage the map or the page cannot offer is passed over: no cars, no rooms, no wardrobe; the console never is', () => {
  const w = new FirstWalk({ ...KEYS, city: { fleet: false, rooms: false, wardrobe: false }, done: ['console'] })
  assert.ok(w.done.has('fleet') && w.done.has('work') && w.done.has('style'))
  assert.equal(w.done.has('console'), false, 'done may not name the console')
  w.start(0)
  w.read(still(), 0)
  w.read(still({ yaw: 1, travelled: 4 }), 1 * S)
  w.note('goal', 2 * S)
  assert.equal(w.stage, 'console')
  assert.equal(available('fleet', { fleet: false, rooms: true }), false)
  assert.equal(available('work', { fleet: true, rooms: false }), false)
  assert.equal(available('style', { fleet: true, rooms: true, wardrobe: false }), false)
  assert.equal(available('style', { fleet: true, rooms: true }), true, 'a page that does not say has the wardrobe card')
  assert.equal(available('style', { fleet: true, rooms: true, wardrobe: false, stores: true }), true, 'the shops alone carry the look stage')
  assert.equal(available('style', { fleet: true, rooms: true, wardrobe: false, stores: false }), false)
  assert.equal(available('style', { fleet: true, rooms: true, wardrobe: false, homes: true }), true, 'the homes alone carry the look stage')
  assert.equal(available('style', { fleet: true, rooms: true, wardrobe: false, stores: false, homes: false }), false)
  for (const s of STAGES) if (s !== 'fleet' && s !== 'work') assert.equal(available(s, { fleet: false, rooms: false }), true, s)
  // A reload mid-walk picks up where it was.
  const r = new FirstWalk({ ...KEYS, done: ['move', 'voice', 'fleet'] })
  assert.equal(r.stage, 'work')
})

test('one hint per stage, after hintMs with no progress and not before the cooldown since the last line; progress restarts the wait', () => {
  const w = begun()
  w.tick(0)
  for (let t = 1; t < 20; t++) assert.equal(w.tick(t * S), null, `patient at ${t}s`)
  const hint = w.tick(20 * S)
  assert.ok(hint && hint.kind === 'hint' && hint.stage === 'move')
  assert.match(hint.text, /drag/)
  assert.equal(w.tick(100 * S), null, 'one hint per stage')
  // The next stage: the ask comes at once (it is pending, not timed), and its hint waits for the cooldown too.
  w.read(still({ yaw: 1, travelled: 4 }), 101 * S)
  assert.equal(w.tick(101 * S)?.kind, 'ask')
  w.read(still({ yaw: 1, travelled: 4, driving: true }), 110 * S) // a car entered early (fleet done, kept): progress, the quiet spell restarts
  assert.equal(w.stage, 'voice')
  assert.equal(w.tick(129 * S), null)
  assert.equal(w.tick(130 * S)?.kind, 'hint')
  // Shorter timings for the hook's tests.
  const q = new FirstWalk({ ...KEYS, hintMs: 1000, cooldownMs: 500 })
  q.start(0)
  q.read(still(), 0)
  q.tick(0)
  assert.equal(q.tick(999), null)
  assert.equal(q.tick(1000)?.kind, 'hint')
  // The cooldown is what holds a hint back when the quiet spell is long enough but her last line is recent.
  const c = new FirstWalk({ ...KEYS, hintMs: 1000, cooldownMs: 5000 })
  c.start(0)
  c.read(still(), 0)
  assert.equal(c.tick(0)?.kind, 'ask')
  assert.equal(c.tick(1500), null, 'quiet for longer than hintMs, but the ask was said 1.5 s ago')
  assert.equal(c.tick(4999), null)
  assert.equal(c.tick(5000)?.kind, 'hint', 'said once the cooldown is over')
  assert.equal(WALK.hintMs, 20_000)
  assert.equal(WALK.cooldownMs, 20_000)
})

test('a hand is lent after assistMs with nothing done on the stage, withdrawn when the stage moves on, and never before start or after the pass', () => {
  const w = begun()
  assert.equal(w.assisting, false)
  w.tick(0)
  w.tick(7.9 * S)
  assert.equal(w.assisting, false, 'patient for eight seconds')
  w.tick(8 * S)
  assert.equal(w.assisting, true)
  // Looking around is progress on the first stage: the hand is withdrawn at the next tick, and lent again after another quiet spell.
  w.read(still({ yaw: 1 }), 9 * S)
  w.tick(9 * S)
  assert.equal(w.assisting, false)
  w.tick(16.9 * S)
  assert.equal(w.assisting, false)
  w.tick(17 * S)
  assert.equal(w.assisting, true)
  // The stage done: withdrawn at once, and the next stage gets its own eight seconds.
  w.read(still({ yaw: 1, travelled: 4 }), 18 * S)
  assert.equal(w.stage, 'voice')
  assert.equal(w.assisting, false)
  w.tick(18 * S)
  w.tick(25.9 * S)
  assert.equal(w.assisting, false)
  w.tick(26 * S)
  assert.equal(w.assisting, true)
  // On a later stage, walking about is no progress on it (the car is still to be found): the hand stays.
  w.note('goal', 27 * S)
  w.tick(27 * S)
  w.read(still({ yaw: 1, travelled: 30 }), 36 * S)
  w.tick(36 * S)
  assert.equal(w.stage, 'fleet')
  assert.equal(w.assisting, true)
  // Passed: no hand.
  w.note('unlock', 37 * S)
  assert.equal(w.assisting, false)
  w.tick(100 * S)
  assert.equal(w.assisting, false)
  // Not before start; shorter timing for the hook's tests.
  const v = new FirstWalk({ ...KEYS, assistMs: 500 })
  v.tick(10 * S)
  assert.equal(v.assisting, false)
  v.start(0)
  v.tick(499)
  assert.equal(v.assisting, false)
  v.tick(500)
  assert.equal(v.assisting, true)
  assert.equal(WALK.assistMs, 8_000)
  assert.ok(WALK.assistMs < WALK.hintMs, 'the hand comes before the spoken hint')
})

test('the lent hand: the control lit, the keys shown and the offer, per stage and device', () => {
  assert.deepEqual(STAGES.map((s) => assistTargetOf(s, 'touch')), ['stick', 'chip', 'enter', null, 'look', 'menu'])
  assert.deepEqual(STAGES.map((s) => assistTargetOf(s, 'keyboard')), [null, 'chip', null, null, 'look', null])
  assert.deepEqual(STAGES.map((s) => assistTargetOf(s, 'pad')), [null, 'chip', null, null, 'look', null])
  assert.deepEqual(STAGES.map((s) => [...assistControlsOf(s)]), [['look', 'move'], [], ['interact'], [], [], ['console']])
  for (const family of ['keyboard', 'pad', 'touch'] as const) {
    for (const s of STAGES) {
      const line = assistLine(s, { family })
      assert.match(line, /^Want a hand\? /, `${family} ${s}`)
      assert.match(line, family === 'touch' ? /tap the button below/i : /use the button below/i, `${family} ${s}`)
      assert.doesNotMatch(line, /tutorial|lesson|step \d/i)
      assert.equal(screen(line).admissible, true, line)
    }
  }
  assert.match(assistLine('fleet', { family: 'keyboard' }), /Follow the marker to a parked car/)
  assert.match(assistLine('work', { family: 'touch' }), /Follow the marker to a doorway/)
  assert.match(assistLine('move', { family: 'touch' }), /^Want a hand\? Tap the button below and I’ll do it for you\.$/)
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

test('the exit program is the three lines, in order, with the role and the swarm it asks for', () => {
  assert.deepEqual(PROGRAM, ['let seal = verify_ring0();', 'let swarm = spawn_subagents(24, "sim2real_workplaces");', 'unlock_city(seal, swarm);'])
  assert.equal(SWARM_ROLE, 'sim2real_workplaces')
  assert.equal(SWARM_SIZE, 24)
  assert.equal(inWords(24), 'twenty-four')
  assert.equal(inWords(6), 'six')
  assert.equal(inWords(99), '99')
})

test('the banner the console prints when the walk is passed: Sloane\'s line, then where to go from here', () => {
  assert.deepEqual([...passedBanner()], [`Sloane: ${passedLine()}`, 'The city is open: nothing is held back any more. Esc closes the console; help lists every command.'])
  assert.match(passedBanner('Dana')[0]!, /The city is yours, Dana\./)
  assert.equal(passedBanner('', 'touch')[1], 'The city is open: nothing is held back any more. Close puts the console away; help lists every command.', 'touch has the console\'s Close button, no Esc')
  assert.equal(passedBanner('', 'pad')[1], passedBanner()[1])
  for (const l of [...passedBanner('Dana'), ...passedBanner('Dana', 'touch')]) { assert.doesNotMatch(l, /tutorial|lesson|step \d/i); assert.equal(screen(l).admissible, true, l) }
})

test('every spoken line is plain words, admissible, true to the device, and never calls the walk a lesson', () => {
  // (The brand scrub itself, compliance.test.ts, already reads every line here for the words it bans.)
  const banned = /tutorial|lesson|step \d|toronto|cn tower/i
  const check = (text: string, label: string) => {
    assert.ok(text.length > 20 && text.length < 420, `${label}: ${text.length} chars`)
    assert.doesNotMatch(text, banned, `${label}: ${text}`)
    assert.equal(screen(text).admissible, true, `${label}: ${text}`)
  }
  for (const o of [KEYS, PAD, TOUCH, { ...KEYS, name: 'Dana' }, { ...TOUCH, place: () => ({ name: 'the clinic', metres: 120.4, bearing: 'north' }) }, shopping(KEYS), shopping(PAD), shopping(TOUCH), homing(KEYS), homing(PAD), homing(TOUCH), everything({ ...KEYS, name: 'Dana' }), everything(PAD), everything({ ...TOUCH, name: 'Dana' })]) {
    for (const s of STAGES) {
      const ask = askFor(s, o), hint = hintFor(s, o)
      check(ask.text, `${o.family} ${s} ask`)
      check(hint.text, `${o.family} ${s} hint`)
      for (const k of [...ask.keep, ...hint.keep]) assert.ok(ask.text.includes(k) || hint.text.includes(k), `${s}: keeps '${k}'`)
      check(eli5Of(s, o.city), `${s} eli5`)
      const ws = fiveWsOf(s, o.city)
      assert.deepEqual(ws.map((w) => w.w), ['Who', 'What', 'When', 'Where', 'Why'], `${s}: the five W's, in order`)
      for (const w of ws) check(`${w.w}? ${w.answer}`, `${s} ${w.w}`)
      assert.match(ws[4]!.answer, /^Because /, `${s}: why is answered with a because`)
      const card = cardFor(s, o)
      assert.equal(card.index, STAGES.indexOf(s) + 1)
      assert.equal(card.count, 6)
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
  assert.match(askFor('console', TOUCH).text, /Open the Menu in the corner and tap Console/)
  assert.match(askFor('console', KEYS).text, /Press the ~ key to open the console/)
  const padMenu: FirstWalkOptions = { ...PAD, words: { ...PAD.words, console: 'Menu' } }
  assert.match(askFor('console', padMenu).text, /the button on this card, or press Menu and choose Console: [^.]*, on keys that rise with it\./, 'a pad has no ~ key: its own menu')
  assert.match(hintFor('console', padMenu).text, /so does Menu, then Console, with keys that rise with it\. On a keyboard it is the key left of 1, under Esc\./)
  assert.match(askFor('console', { ...KEYS, name: 'Dana' }).text, /^Last one, Dana, and then the city is yours\./)
  assert.match(hintFor('console', KEYS).text, /the one left of 1, under Esc/)
  assert.deepEqual([...askFor('console', TOUCH).keep], ['Menu', 'Console'])
  assert.match(askFor('style', TOUCH).text, /Tap Look/)
  assert.match(askFor('style', KEYS).text, /Click Look/)
  assert.deepEqual([...askFor('style', PAD).keep], ['Look', 'Done'])
  assert.match(askFor('style', { ...KEYS, name: 'Dana' }).text, /how you look, Dana/)
  assert.match(askFor('style', KEYS).text, /Look at the end of my chip/)
  // The shops, only on a map that has them, in the device's words for opening a shop's card.
  for (const o of [KEYS, PAD, TOUCH]) {
    assert.doesNotMatch(askFor('style', o).text + hintFor('style', o).text + eli5Of('style', o.city) + said(fiveWsOf('style', o.city)), /shop/i, `${o.family}: no shops on a map without them`)
    assert.deepEqual([...askFor('style', shopping(o)).keep], ['Look', 'Done'], 'the shops add no word the rewording must keep')
  }
  assert.match(askFor('style', shopping(KEYS)).text, /press B to try its lines on; trying on is free/)
  assert.match(askFor('style', shopping(PAD)).text, /press A to try/)
  assert.match(askFor('style', shopping(TOUCH)).text, /tap Browse to try/)
  assert.match(hintFor('style', shopping(TOUCH)).text, /A shop works too: walk in, tap Browse/)
  assert.match(eli5Of('style', shopping(KEYS).city), /trying them on is free/)
  assert.match(cardFor('style', shopping(KEYS)).eli5, /Shops on the street sell clothes too/)
  const shopWs = fiveWsOf('style', shopping(KEYS).city)
  assert.match(shopWs[4]!.answer, /no typed word, no shared code and no shop can dress anyone in anything else/)
  assert.match(shopWs[3]!.answer, /circles you like a mirror \(not in a headset or a shared room\)/)
  assert.match(fiveWsOf('style')[0]!.answer, /all ten skin tones, with freckles on some and vitiligo on a few/)
  assert.match(fiveWsOf('style')[4]!.answer, /no typed word and no shared code can dress anyone/)
  // The homes, only on a map that has them, in the device's words for opening a home's doorstep card.
  for (const o of [KEYS, PAD, TOUCH, shopping(KEYS), shopping(PAD), shopping(TOUCH)]) {
    assert.doesNotMatch(askFor('style', o).text + hintFor('style', o).text + eli5Of('style', o.city) + said(fiveWsOf('style', o.city)), /\bhomes?\b|deed/i, `${o.family}: no homes on a map without them`)
  }
  for (const o of [KEYS, PAD, TOUCH]) {
    assert.deepEqual([...askFor('style', homing(o)).keep], ['Look', 'Done'], 'the homes add no word the rewording must keep')
    assert.deepEqual([...hintFor('style', everything(o)).keep], ['Look', 'Done'])
    assert.doesNotMatch(askFor('style', homing(o)).text, /shop/i, `${o.family}: homes without shops name no shop`)
  }
  assert.match(askFor('style', homing(KEYS)).text, /a home for sale, a glass room on its own lot, and press B to read its deed; the smallest is free to claim/)
  assert.match(askFor('style', homing(PAD)).text, /press A to read its deed/)
  assert.match(askFor('style', homing(TOUCH)).text, /tap For sale to read its deed/)
  assert.match(hintFor('style', homing(TOUCH)).text, /So does a home: step inside, tap For sale, and press Done when you have read its deed/)
  assert.match(hintFor('style', homing(KEYS)).text, /So does a home: step inside, press B,/)
  assert.match(askFor('style', everything(KEYS)).text, /trying on is free\. Or step into a home for sale/, 'with both, the shops come first and the homes after')
  assert.match(eli5Of('style', homing(KEYS).city), /the homes on the street are for sale, and the smallest one is free/)
  assert.match(cardFor('style', homing(KEYS)).eli5, /You can even have a home/)
  const homeWs = fiveWsOf('style', homing(KEYS).city)
  assert.match(homeWs[3]!.answer, /Inside a home for sale, its doorstep card shows the deed/)
  assert.match(homeWs[4]!.answer, /its deed is one line in the city’s catalogue, kept in one place/)
  assert.doesNotMatch(said(homeWs), /shop|circles you like a mirror/i, 'the homes bring no shop\'s line with them')
  assert.match(askFor('move', { ...KEYS, name: 'Dana' }).text, /Welcome in, Dana/)
  assert.match(hintFor('work', { ...KEYS, place: () => ({ name: 'the clinic', metres: 120.4, bearing: 'north' }) }).text, /the clinic, about 120 metres to the north/)
  assert.match(hintFor('work', KEYS).text, /wide open doorway/)
  // The last stage's W's say what the console is, and where its language lives, by its whole name.
  assert.match(fiveWsOf('console')[4]!.answer, /four laws in rank order/)
  assert.match(fiveWsOf('console')[1]!.answer, /its own language too, Crimson Noir Script: type noir and a line to try it/)
  assert.deepEqual([...FIVE_WS], ['Who', 'What', 'When', 'Where', 'Why'])
  // Sloane's own questions are a few, not a fixed five, and the card asks the five W's, never five whys.
  assert.match(askFor('voice', KEYS).text, /I may ask a few questions to be sure what you mean/)
  for (const o of [KEYS, everything(TOUCH)]) for (const s of STAGES) assert.doesNotMatch(eli5Of(s, o.city) + said(fiveWsOf(s, o.city)) + askFor(s, o).text, /five whys|why five times|eight-year-old/i)
  const stages: Stage[] = ['move', 'voice', 'fleet', 'work', 'style', 'console']
  assert.deepEqual([...STAGES], stages)
})
