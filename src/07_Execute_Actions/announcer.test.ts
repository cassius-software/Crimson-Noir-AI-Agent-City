// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the screen reader's lines (announcer.ts): nothing of the first
 * snapshot, a seat taken or left, a vehicle beside you with the right word for the controls, a district once held,
 * every new toast once, one line per gap with the rest queued and the oldest dropped past the queue's length, and
 * someone close enough to talk to: told only once the proposal has stood ANNOUNCE.talkHoldMs, at most once every
 * ANNOUNCE.talkGapMs, never while a conversation is open, with the way to start for the controls in use (the d-pad's
 * up for a left hand on a pad); a snapshot without the person near keeps every older line as it was. It also pins the
 * snapshot's HudTalk to the controller's TalkHud field for field (read as text), so the host hands hud() to the HUD as
 * it is.
 * What breaks if it is removed? A reader flooded at a district border, told of a car that was always there, or told
 * of every passer-by, or of someone to talk to while already talking.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ANNOUNCE, Announcer, enterWord, talkWord, type Announced } from './announcer.ts'

type Talk = NonNullable<Announced['supplier']['talk']>

const snap = (p: Partial<{ mode: 'foot' | 'vehicle'; near: boolean; district: string; toasts: { id: number; title: string; body: string }[]; glyphs: Announced['supplier']['glyphs']; touch: boolean; talk: Talk }> = {}): Announced => ({
  supplier: p.talk ? { glyphs: p.glyphs ?? 'keyboard', touch: p.touch ?? false, talk: p.talk } : { glyphs: p.glyphs ?? 'keyboard', touch: p.touch ?? false },
  input: { mode: p.mode ?? 'foot', nearVehicle: p.near ?? false },
  customer: { district: p.district ?? 'Old Town' },
  toasts: p.toasts ?? [],
})

test('the first snapshot is the baseline; a vehicle beside you, a seat taken and left, each said once, one line per gap', () => {
  const a = new Announcer()
  assert.equal(a.next(snap({ near: true, toasts: [{ id: 3, title: 'Network', body: 'joined' }] }), 0), null, 'what was already so is not news')
  assert.equal(a.next(snap({ near: true }), 100), null)
  assert.equal(a.next(snap({ near: false }), 200), null, 'a vehicle leaving is not said')
  assert.equal(a.next(snap({ near: true }), 300), 'A vehicle is beside you: E enters it.')
  assert.equal(a.next(snap({ near: true, mode: 'vehicle' }), 400), null, 'inside the gap: held')
  assert.equal(a.pending, 1)
  assert.equal(a.next(snap({ near: true, mode: 'vehicle' }), 300 + ANNOUNCE.gapMs), 'Driving.')
  assert.equal(a.next(snap({ near: true, mode: 'foot' }), 300 + 2 * ANNOUNCE.gapMs), 'On foot.')
  assert.equal(a.next(snap({ near: true, mode: 'foot' }), 300 + 3 * ANNOUNCE.gapMs), null, 'still beside it: said already')
})

test('a district is said once it has been held, and not again until another was; toasts are said once each, oldest first, beyond the queue the oldest go', () => {
  const a = new Announcer()
  a.next(snap({ district: 'Old Town' }), 0)
  assert.equal(a.next(snap({ district: 'Harbour' }), 1000), null, 'just crossed: held')
  assert.equal(a.next(snap({ district: 'Old Town' }), 2000), null, 'back over the border: the hold starts again')
  assert.equal(a.next(snap({ district: 'Harbour' }), 3000), null)
  assert.equal(a.next(snap({ district: 'Harbour' }), 3000 + ANNOUNCE.districtHoldMs - 1), null)
  assert.equal(a.next(snap({ district: 'Harbour' }), 3000 + ANNOUNCE.districtHoldMs), 'Now in Harbour.')
  assert.equal(a.next(snap({ district: 'Harbour' }), 20000), null, 'said once')
  const t = (id: number) => ({ id, title: `T${id}`, body: id % 2 ? 'odd' : '' })
  assert.equal(a.next(snap({ district: 'Harbour', toasts: [t(1), t(2)] }), 30000), 'T1: odd')
  assert.equal(a.next(snap({ district: 'Harbour', toasts: [t(1), t(2)] }), 30000 + ANNOUNCE.gapMs), 'T2', 'a toast without a body is its title')
  assert.equal(a.next(snap({ district: 'Harbour', toasts: [t(2)] }), 40000), null, 'nothing new')
  a.next(snap({ district: 'Harbour', toasts: [t(3), t(4), t(5), t(6), t(7), t(8)] }), 50000)
  assert.equal(a.pending, ANNOUNCE.queue - 1, 'one said, the queue holds its length, the oldest dropped')
  const rest: string[] = []
  for (let i = 1; i <= 6; i++) { const l = a.next(snap({ district: 'Harbour', toasts: [t(8)] }), 50000 + i * ANNOUNCE.gapMs); if (l) rest.push(l) }
  assert.deepEqual(rest, ['T6', 'T7: odd', 'T8'])
})

test('toasts as the HUD lists them (newest first) are all said, oldest first; the first toast of a session (id 0) is said too', () => {
  const a = new Announcer()
  a.next(snap(), 0)
  const t = (id: number) => ({ id, title: `T${id}`, body: '' })
  assert.equal(a.next(snap({ toasts: [t(0)] }), 1000), 'T0', 'id 0 is news after an empty start')
  const heard = [a.next(snap({ toasts: [t(3), t(2), t(1), t(0)] }), 1000 + ANNOUNCE.gapMs)]
  for (let i = 2; i <= 4; i++) { const l = a.next(snap({ toasts: [t(3), t(2), t(1)] }), 1000 + i * ANNOUNCE.gapMs); if (l) heard.push(l) }
  assert.deepEqual(heard, ['T1', 'T2', 'T3'], 'none lost to the order they arrived in')
  const b = new Announcer()
  b.next(snap({ toasts: [t(0)] }), 0)
  assert.equal(b.next(snap({ toasts: [t(0)] }), 5000), null, 'a toast already up at the first look is not news')
})

test('what enters a vehicle, for the controls in use', () => {
  assert.equal(enterWord('keyboard', false), 'E enters it')
  assert.equal(enterWord('abxy', false), 'the bottom face button enters it')
  assert.equal(enterWord('numbered', false), 'the bottom face button enters it')
  assert.equal(enterWord('touch', false), 'the Enter car button enters it')
  assert.equal(enterWord('keyboard', true), 'the Enter car button enters it')
  const a = new Announcer()
  a.next(snap({ glyphs: 'bayx' }), 0)
  assert.equal(a.next(snap({ glyphs: 'bayx', near: true }), 10), 'A vehicle is beside you: the bottom face button enters it.')
})

/** Someone offered (or talked with) under proposal `serial`. */
const near = (serial: number, label = 'Pedestrian 1234 (Rust)', state: Talk['state'] = 'near'): Talk => ({ state, label, serial })
const toldNear = (label: string, how: string) => `${label} is close enough to talk to: ${how}.`

test('how to start talking, for the controls in use: the key, the pad\'s button by its glyph, the Talk chip on touch', () => {
  assert.equal(talkWord('keyboard', false), 'press T')
  assert.equal(talkWord('abxy', false), 'press X', 'the west button of a pad lettered A at the south')
  assert.equal(talkWord('bayx', false), 'press Y', 'and of one lettered B there')
  assert.equal(talkWord('numbered', false), 'press the West button', 'a pad whose face buttons carry no letters: by position')
  assert.equal(talkWord('generic', false), 'press the West button')
  assert.equal(talkWord('touch', false), 'tap Talk at the foot of the screen')
  assert.equal(talkWord('keyboard', true), 'tap Talk at the foot of the screen', 'the touch overlay wins, as for a car\'s door')
  assert.equal(talkWord('abxy', true), 'tap Talk at the foot of the screen')
})

test('someone to talk to is told only once the proposal has stood 1.5 s, once, worded for the controls; a passer-by is not news', () => {
  assert.equal(ANNOUNCE.talkHoldMs, 1500)
  assert.equal(ANNOUNCE.talkGapMs, 15000)
  const a = new Announcer()
  assert.equal(a.next(snap(), 0), null)
  assert.equal(a.next(snap({ talk: near(1) }), 10000), null, 'just offered: held')
  assert.equal(a.next(snap({ talk: near(1) }), 10000 + ANNOUNCE.talkHoldMs - 1), null)
  assert.equal(a.pending, 0, 'nothing waits before the hold is over')
  assert.equal(a.next(snap({ talk: near(1) }), 10000 + ANNOUNCE.talkHoldMs), toldNear('Pedestrian 1234 (Rust)', 'press T'))
  for (const t of [12000, 20000, 40000, 90000]) assert.equal(a.next(snap({ talk: near(1) }), t), null, 'one proposal is told once, however long it stands')
  // A passer-by offered for less than the hold, then nobody, then someone else for less than the hold: nothing.
  const b = new Announcer()
  b.next(snap(), 0)
  assert.equal(b.next(snap({ talk: near(5) }), 1000), null)
  assert.equal(b.next(snap({ talk: near(5) }), 2000), null)
  assert.equal(b.next(snap(), 2400), null, 'gone before the hold was over')
  assert.equal(b.next(snap({ talk: near(5) }), 2500), null, 'offered again: the hold starts again')
  assert.equal(b.next(snap({ talk: near(6, 'Ada') }), 3500), null, 'replaced: the hold starts again for the new one')
  assert.equal(b.next(snap({ talk: near(6, 'Ada') }), 3500 + ANNOUNCE.talkHoldMs - 1), null)
  assert.equal(b.next(snap({ talk: near(6, 'Ada') }), 3500 + ANNOUNCE.talkHoldMs), toldNear('Ada', 'press T'), 'a hired agent by their roster name')
  // Worded for the pad and for touch.
  for (const [glyphs, touch, how] of [['bayx', false, 'press Y'], ['numbered', false, 'press the West button'], ['touch', true, 'tap Talk at the foot of the screen']] as const) {
    const c = new Announcer()
    c.next(snap({ glyphs, touch }), 0)
    c.next(snap({ glyphs, touch, talk: near(2) }), 100)
    assert.equal(c.next(snap({ glyphs, touch, talk: near(2) }), 100 + ANNOUNCE.talkHoldMs), toldNear('Pedestrian 1234 (Rust)', how), glyphs)
  }
})

test('a left hand on a pad is told the d-pad\'s up, the button it talks with; the keyboard, touch and the right hand are not changed', () => {
  assert.equal(talkWord('abxy', false, 'left'), 'press up on the d-pad')
  assert.equal(talkWord('numbered', false, 'left'), 'press up on the d-pad')
  assert.equal(talkWord('abxy', false, 'right'), 'press X')
  assert.equal(talkWord('keyboard', false, 'left'), 'press T')
  assert.equal(talkWord('abxy', true, 'left'), 'tap Talk at the foot of the screen')
  // The announcer reads the hand as it makes the line (the page's own, padNav.ts pageHand, unless one is handed in).
  let hand: 'both' | 'left' | 'right' = 'left'
  const a = new Announcer(() => hand)
  a.next(snap({ glyphs: 'abxy' }), 0)
  a.next(snap({ glyphs: 'abxy', talk: near(3) }), 100)
  assert.equal(a.next(snap({ glyphs: 'abxy', talk: near(3) }), 100 + ANNOUNCE.talkHoldMs), toldNear('Pedestrian 1234 (Rust)', 'press up on the d-pad'))
  hand = 'right'
  a.next(snap({ glyphs: 'abxy', talk: near(4) }), 20000)
  assert.equal(a.next(snap({ glyphs: 'abxy', talk: near(4) }), 20000 + ANNOUNCE.talkHoldMs), toldNear('Pedestrian 1234 (Rust)', 'press X'))
  // Node has no page: the default reads both hands.
  const b = new Announcer()
  b.next(snap({ glyphs: 'abxy' }), 0)
  b.next(snap({ glyphs: 'abxy', talk: near(5) }), 100)
  assert.equal(b.next(snap({ glyphs: 'abxy', talk: near(5) }), 100 + ANNOUNCE.talkHoldMs), toldNear('Pedestrian 1234 (Rust)', 'press X'))
})

test('at most one line about someone to talk to every 15 s, counted from when it was said; a proposal still standing then is told', () => {
  const a = new Announcer()
  a.next(snap(), 0)
  a.next(snap({ talk: near(1) }), 1000)
  assert.equal(a.next(snap({ talk: near(1) }), 2500), toldNear('Pedestrian 1234 (Rust)', 'press T'), 'said at 2.5 s')
  a.next(snap({ talk: near(2, 'Pedestrian 77 (Go)') }), 3000)
  assert.equal(a.next(snap({ talk: near(2, 'Pedestrian 77 (Go)') }), 6000), null, 'held long enough, but inside the gap')
  assert.equal(a.next(snap({ talk: near(2, 'Pedestrian 77 (Go)') }), 2500 + ANNOUNCE.talkGapMs - 1), null)
  assert.equal(a.pending, 0, 'nothing queued inside the gap, so nothing stale waits')
  assert.equal(a.next(snap({ talk: near(2, 'Pedestrian 77 (Go)') }), 2500 + ANNOUNCE.talkGapMs), toldNear('Pedestrian 77 (Go)', 'press T'), 'still offered when the gap is over')
  // One gone within the gap is never told.
  a.next(snap({ talk: near(3, 'Pedestrian 8 (C)') }), 20000)
  assert.equal(a.next(snap({ talk: near(3, 'Pedestrian 8 (C)') }), 25000), null)
  assert.equal(a.next(snap(), 26000), null)
  assert.equal(a.next(snap(), 40000), null, 'gone before the gap was over')
})

test('never while a conversation is open; a line still waiting when the conversation opens, or its person goes, is not said', () => {
  const a = new Announcer()
  a.next(snap(), 0)
  // Open at once (T pressed as the person was offered), and through the person's turns: nothing, however long.
  for (const [t, state] of [[100, 'near'], [200, 'open'], [2000, 'thinking'], [4000, 'speaking'], [9000, 'open']] as const) {
    assert.equal(a.next(snap({ talk: near(1, 'Pedestrian 1234 (Rust)', state) }), t), null, `${state} at ${t}`)
  }
  assert.equal(a.next(snap(), 9100), null, 'the conversation over (its toast says how)')
  // A toast is said, so the talk line, once held, waits in the queue for the gap: the conversation opens meanwhile.
  assert.equal(a.next(snap({ toasts: [{ id: 0, title: 'Network', body: 'joined' }] }), 20000), 'Network: joined')
  a.next(snap({ talk: near(2) }), 20100)
  assert.equal(a.next(snap({ talk: near(2) }), 20100 + ANNOUNCE.talkHoldMs), null, 'held long enough, waiting for the gap')
  assert.equal(a.pending, 1)
  assert.equal(a.next(snap({ talk: near(2, 'Pedestrian 1234 (Rust)', 'open') }), 22000), null)
  assert.equal(a.pending, 0, 'taken back as the conversation opened')
  assert.equal(a.next(snap({ talk: near(2, 'Pedestrian 1234 (Rust)', 'open') }), 30000), null)
  // The same when the person waiting to be told of goes, or another takes their place; other lines keep their order.
  const b = new Announcer()
  b.next(snap(), 0)
  assert.equal(b.next(snap({ toasts: [{ id: 0, title: 'A', body: '' }] }), 1000), 'A')
  b.next(snap({ talk: near(4) }), 1100)
  b.next(snap({ talk: near(4), district: 'Harbour' }), 1100 + ANNOUNCE.talkHoldMs)
  assert.equal(b.pending, 1)
  assert.equal(b.next(snap({ talk: near(5, 'Pedestrian 9 (Rust)'), district: 'Harbour', toasts: [{ id: 1, title: 'B', body: '' }] }), 3000), null)
  assert.equal(b.pending, 1, 'the line about the one replaced is taken back; the toast waits')
  assert.equal(b.next(snap({ talk: near(5, 'Pedestrian 9 (Rust)'), district: 'Harbour' }), 3500), 'B')
  assert.equal(b.next(snap({ talk: near(5, 'Pedestrian 9 (Rust)'), district: 'Harbour' }), 6000), toldNear('Pedestrian 9 (Rust)', 'press T'), 'the new one, held, is told: the gap runs from a line said, and the one taken back never was')
  // Pushed out of the queue by a flood of toasts like any oldest line: the same proposal is not told again.
  const c = new Announcer()
  c.next(snap(), 0)
  assert.equal(c.next(snap({ toasts: [{ id: 0, title: 'A', body: '' }] }), 1000), 'A')
  c.next(snap({ talk: near(7) }), 1100)
  c.next(snap({ talk: near(7) }), 1100 + ANNOUNCE.talkHoldMs)
  const flood = [1, 2, 3, 4].map((id) => ({ id, title: `T${id}`, body: '' }))
  assert.equal(c.next(snap({ talk: near(7), toasts: flood }), 2700), null)
  const heard: string[] = []
  for (let i = 1; i <= 6; i++) { const l = c.next(snap({ talk: near(7), toasts: flood }), 2700 + i * ANNOUNCE.gapMs); if (l) heard.push(l) }
  assert.deepEqual(heard, ['T1', 'T2', 'T3', 'T4'], 'the oldest went: the line about the person near')
})

test('a person already offered at the first look is not news; a snapshot without the person near keeps the old lines', () => {
  const a = new Announcer()
  assert.equal(a.next(snap({ talk: near(9) }), 0), null, 'what was already so is not news')
  assert.equal(a.next(snap({ talk: near(9) }), 5000), null)
  a.next(snap({ talk: near(10) }), 6000)
  assert.equal(a.next(snap({ talk: near(10) }), 6000 + ANNOUNCE.talkHoldMs), toldNear('Pedestrian 1234 (Rust)', 'press T'), 'the next one is')
  // The same run of snapshots with and without a person near gives the same older lines at the same times.
  const run = (talk: Talk | undefined): (string | null)[] => {
    const b = new Announcer()
    const out: (string | null)[] = []
    const step = (p: Parameters<typeof snap>[0], t: number) => out.push(b.next(snap({ ...p, ...(talk ? { talk: { ...talk, state: 'open' as const } } : {}) }), t))
    step({}, 0)
    step({ near: true }, 100)
    step({ near: true, mode: 'vehicle' }, 200)
    step({ near: true, mode: 'vehicle' }, 100 + ANNOUNCE.gapMs)
    step({ district: 'Harbour' }, 6000)
    step({ district: 'Harbour', toasts: [{ id: 0, title: 'T', body: 'b' }] }, 6000 + ANNOUNCE.districtHoldMs)
    step({ district: 'Harbour' }, 6000 + ANNOUNCE.districtHoldMs + ANNOUNCE.gapMs)
    return out
  }
  const plain = run(undefined)
  assert.deepEqual(plain, [null, 'A vehicle is beside you: E enters it.', null, 'Driving.', 'On foot.', 'Now in Harbour.', 'T: b'])
  assert.deepEqual(run(near(3)), plain, 'a conversation open all along changes nothing else')
})

test('the snapshot\'s HudTalk is the controller\'s TalkHud, field for field, so the host hands hud() over as it is', () => {
  const fields = (src: string, head: string): string[] => {
    const at = src.indexOf(head)
    assert.ok(at >= 0, head)
    const body = src.slice(src.indexOf('{', at) + 1, src.indexOf('\n}', at))
    return body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('/') && !l.startsWith('*'))
      .map((l) => l.replace(/^readonly\s+/, '')).sort()
  }
  const hud = fields(readFileSync(new URL('../05_Observe_Environment/telemetry.ts', import.meta.url), 'utf8'), 'export interface HudTalk {')
  const ctl = fields(readFileSync(new URL('./talk.ts', import.meta.url), 'utf8'), 'export interface TalkHud {')
  assert.deepEqual(hud, ctl)
  assert.deepEqual(hud.map((l) => l.split(':')[0]), ['arrow', 'label', 'line', 'metres', 'serial', 'state', 'word'])
  assert.match(readFileSync(new URL('../05_Observe_Environment/telemetry.ts', import.meta.url), 'utf8'), /^ {4}talk\?: HudTalk$/m, 'an optional field of the supplier')
})
