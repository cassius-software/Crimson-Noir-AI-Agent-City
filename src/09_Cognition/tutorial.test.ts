// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for Wren's quiet watch: nothing is said for thirty seconds, one line
 * then, the next only after the cooldown and another quiet spell, in the fixed order, skipping what the visitor has
 * already found (by a reading or an event) and what their device cannot do, never the same line twice, and nothing
 * after five minutes. Every line is plain words that never call it a lesson, and keeps the word a rewording must.
 * What breaks if it is removed? A nagging, repeating or mistimed Wren would ship unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DISCOVERIES, Mentor, WATCH, available, lineFor, type Discovery, type Reading } from './tutorial.ts'

const spire = { name: 'The Spire', x: 1000, z: 1000 }
const still = (over: Partial<Reading> = {}): Reading => ({ x: 0, z: 0, yaw: 0, travelled: 0, mode: false, hour: 17, ...over })
const S = 1000

test('nothing for thirty quiet seconds, then one line; the next only after the cooldown and a fresh quiet spell; the order is fixed', () => {
  const m = new Mentor({ landmark: spire, people: true, family: 'keyboard' })
  m.start(0)
  m.read(still(), 0)
  for (let t = 1; t < 30; t++) assert.equal(m.tick(t * S), null, `quiet at ${t}s`)
  const first = m.tick(30 * S)
  assert.ok(first && first.discovery === 'look', 'looking around comes first')
  assert.equal(first.id, 1)
  // Said once is done: nothing again until the cooldown has passed, and then the next thing.
  for (let t = 31; t < 30 + WATCH.cooldownMs / S; t++) assert.equal(m.tick(t * S), null, `cooling at ${t}s`)
  const second = m.tick((30 + WATCH.cooldownMs / S) * S)
  assert.ok(second && second.discovery === 'spire' && second.id === 2)
  assert.deepEqual([...m.discovered], ['look', 'spire'])
  assert.deepEqual(m.pending, ['talk', 'mode', 'clock'])
})

test('doing things resets the quiet timer, and some things are discoveries: a turn of the head, falling code, the clock, standing under the landmark, talking', () => {
  const m = new Mentor({ landmark: spire, people: true, family: 'keyboard' })
  m.start(0)
  m.read(still(), 0)
  // A key at 20 s: the clock restarts, nothing at 30 s, a line at 50 s.
  m.note('move', 20 * S)
  assert.equal(m.tick(30 * S), null)
  assert.equal(m.tick(49 * S), null)
  assert.ok(m.tick(50 * S))
  // A turn of the head is looking around; it was already said, so nothing changes; walking to the landmark is found.
  m.read(still({ yaw: 0.5 }), 51 * S)
  m.read(still({ x: 990, z: 1010, yaw: 0.5 }), 52 * S)
  assert.ok(m.discovered.has('spire'))
  // The M key and the clock keys, as readings and as events.
  m.read(still({ x: 990, z: 1010, yaw: 0.5, mode: true }), 53 * S)
  assert.ok(m.discovered.has('mode'))
  m.note('clock', 54 * S)
  assert.ok(m.discovered.has('clock'))
  m.note('talk', 55 * S)
  assert.deepEqual(m.pending, [])
  assert.equal(m.tick(200 * S), null, 'everything found: nothing to say')
  assert.equal(m.over, true)
  // The day's own drift is not the clock turned.
  const n = new Mentor({ landmark: null, people: false, family: 'keyboard' })
  n.start(0)
  n.read(still({ hour: 17 }), 0)
  n.read(still({ hour: 17.01 }), S)
  assert.ok(!n.discovered.has('clock'))
  n.read(still({ hour: 17.6 }), 2 * S)
  assert.ok(n.discovered.has('clock'))
  n.read(still({ hour: 23.9 }), 3 * S)
  n.read(still({ hour: 0.1 }), 4 * S)
  assert.equal(n.tick(40 * S) !== null, true, 'midnight passing is not activity: still quiet since 2 s')
})

test('the watch ends after five minutes; a visitor who does nothing hears at most one line per cooldown, each a different thing', () => {
  const m = new Mentor({ landmark: spire, people: true, family: 'keyboard' })
  m.start(0)
  m.read(still(), 0)
  const said: Discovery[] = []
  for (let t = 0; t <= 400; t++) {
    const n = m.tick(t * S)
    if (n) said.push(n.discovery)
  }
  assert.deepEqual(said, ['look', 'spire', 'talk', 'mode', 'clock'].slice(0, said.length))
  assert.equal(new Set(said).size, said.length, 'never the same line twice')
  assert.ok(said.length <= Math.ceil(WATCH.watchMs / WATCH.cooldownMs) + 1)
  assert.equal(m.over, true)
  assert.equal(m.tick(401 * S), null)
  const short = new Mentor({ landmark: null, people: false, family: 'keyboard', watchMs: 60 * S, quietMs: 5 * S, cooldownMs: 10 * S })
  short.start(0)
  short.read(still(), 0)
  assert.ok(short.tick(5 * S))
  assert.equal(short.tick(14 * S), null)
  assert.ok(short.tick(15 * S))
  assert.equal(short.tick(61 * S), null)
  assert.equal(short.over, true)
})

test('what the device cannot do, and what is already known, is skipped: no landmark, a touch screen, a reload', () => {
  assert.equal(available('spire', { landmark: null, people: false, family: 'keyboard' }), false)
  assert.equal(available('mode', { landmark: null, people: false, family: 'touch' }), false)
  assert.equal(available('clock', { landmark: null, people: false, family: 'touch' }), false)
  assert.equal(available('talk', { landmark: null, people: false, family: 'touch' }), true)
  const touch = new Mentor({ landmark: null, people: false, family: 'touch' })
  assert.deepEqual(touch.pending, ['look', 'talk'])
  const back = new Mentor({ landmark: spire, people: true, family: 'keyboard', done: ['look', 'spire'] })
  assert.deepEqual(back.pending, ['talk', 'mode', 'clock'])
  const idle = new Mentor({ landmark: spire, people: true, family: 'keyboard' })
  assert.equal(idle.tick(10_000 * S), null, 'never started: never speaks')
  idle.note('move', 0)
  idle.read(still(), 0)
  assert.equal(idle.started, false)
})

test('every line is plain words in the shape of a why and a how, never a lesson, never the film\'s phrases, and keeps the word a rewording must', () => {
  for (const family of ['keyboard', 'pad', 'touch'] as const) {
    for (const people of [true, false]) {
      for (const d of DISCOVERIES) {
        const { text, keep } = lineFor(d, { landmark: spire, people, family, name: 'Sam' })
        assert.ok(text.includes('?'), `${d}: asks why first (${text})`)
        assert.ok(text.length <= 260, `${d}: short enough (${text.length})`)
        assert.doesNotMatch(text, /tutorial|lesson|step \d|toronto|cn tower/i, text)
        for (const k of keep) assert.ok(text.toLowerCase().includes(k.toLowerCase()), `${d} keeps "${k}"`)
      }
    }
  }
  assert.match(lineFor('spire', { landmark: spire, people: false, family: 'keyboard' }).text, /The Spire/)
  assert.match(lineFor('spire', { landmark: null, people: false, family: 'keyboard' }).text, /the tallest tower/)
  assert.match(lineFor('talk', { landmark: null, people: true, family: 'keyboard' }).text, /recruit Rust/)
  assert.match(lineFor('talk', { landmark: null, people: false, family: 'keyboard' }).text, /tell me a goal/)
  assert.match(lineFor('talk', { landmark: null, people: true, family: 'touch' }).text, /tell me a goal/, 'no console on a touch screen')
  assert.match(lineFor('look', { landmark: null, people: false, family: 'keyboard', name: 'Sam' }).text, /, Sam\?/)
  assert.doesNotMatch(lineFor('look', { landmark: null, people: false, family: 'keyboard', name: '  ' }).text, /,\s*\?/)
})
