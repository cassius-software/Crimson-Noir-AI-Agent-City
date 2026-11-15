// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds who looks at the operator (talkGaze.ts) to its promises: nobody until the
 * operator talks to them; a head eased round to the operator and back, never snapped, at any frame rate the city
 * runs at (the phone's few frames a second among them); a slot freed only once its person has turned all the way
 * back; room for every recruit standing by and the person a conversation names at once; a newcomer who finds the
 * slots full waiting rather than taking one mid-turn; and the reach and the floor a conversation holds across.
 * What breaks if it is removed? The slots could snap a head, leave someone looking after the conversation ended, or
 * let a person on the street below a sky floor's window be talked to, unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GAZE } from './humanoid.ts'
import { RECRUIT_SLOTS } from './skills.ts'
import { TALK, TalkGaze, talkWeight, withinTalk } from './talkGaze.ts'

const weightOf = (g: TalkGaze, agent: number) => talkWeight(agent, g.who, g.weight)

test('TalkGaze: nobody to start with; a person talked to eases from 0 to 1 over TALK.easeIn and back to 0 over TALK.easeOut, smoothly, then leaves their slot', () => {
  const g = new TalkGaze()
  assert.deepEqual([...g.who], Array(TALK.slots).fill(-1), 'every slot empty')
  assert.deepEqual([...g.weight], Array(TALK.slots).fill(0))
  g.step([], 0.1)
  assert.deepEqual([...g.who], Array(TALK.slots).fill(-1), 'nobody talked to, nobody looks')
  const dt = 1 / 60
  const up: number[] = []
  for (let t = 0; t < TALK.easeIn + 0.1; t += dt) { g.step([42], dt); up.push(weightOf(g, 42)) }
  assert.ok(up[0] > 0 && up[0] < 0.01, 'the first frame barely starts the turn')
  for (let k = 1; k < up.length; k++) assert.ok(up[k] >= up[k - 1], 'rising')
  assert.equal(up.at(-1), 1, 'whole once easeIn has passed')
  const reached = up.findIndex((w) => w === 1)
  assert.ok(Math.abs(reached * dt - TALK.easeIn) <= 2 * dt, `whole after easeIn (${(reached * dt).toFixed(3)} s)`)
  const steps = up.slice(1).map((w, k) => w - up[k])
  assert.ok(Math.max(...steps) <= 1.5 * dt / TALK.easeIn + 1e-9, 'no frame turns more than one and a half times the even share: no snap')
  assert.ok(steps[0] < steps[Math.floor(steps.length / 2)], 'a gentle start')
  const down: number[] = []
  for (let t = 0; t < TALK.easeOut + 0.1; t += dt) { g.step([], dt); down.push(weightOf(g, 42)) }
  for (let k = 1; k < down.length; k++) assert.ok(down[k] <= down[k - 1], 'falling')
  assert.equal(down.at(-1), 0)
  assert.deepEqual([...g.who], Array(TALK.slots).fill(-1), 'the slot is free again once they have turned all the way back')
})

test('TalkGaze: a conversation that stops half way turns back from where the head is; one that starts again turns round from there; repeats and anything not an index are ignored', () => {
  const g = new TalkGaze()
  for (let k = 0; k < 6; k++) g.step([7, 7, -3, 2.5, Number.NaN], 0.03)
  const w = weightOf(g, 7)
  assert.ok(w > 0.2 && w < 0.8, `part way round (${w.toFixed(3)})`)
  assert.equal([...g.who].filter((a) => a >= 0).length, 1, 'one slot, for person 7 alone')
  g.step([], 0.03)
  const back = weightOf(g, 7)
  assert.ok(back < w && back > w - 0.15, 'turning back from where the head was, not from the end')
  g.step([7], 0.03)
  assert.ok(weightOf(g, 7) > back, 'and round again from there')
})

test('TalkGaze: a dropped frame turns a head at most a quarter of a second\'s worth; a frame of no time or of a broken clock turns nothing', () => {
  const g = new TalkGaze()
  g.step([3], 5)
  assert.ok(weightOf(g, 3) < 1, 'a five-second stall is a quarter second of turn')
  const after = weightOf(g, 3)
  g.step([3], 0)
  assert.equal(weightOf(g, 3), after)
  g.step([3], Number.NaN)
  assert.equal(weightOf(g, 3), after)
  g.step([3], -1)
  assert.equal(weightOf(g, 3), after)
})

test('TalkGaze: at the phone\'s five frames a second (the engine\'s step capped at 50 ms) a head still turns by steps no larger than at sixty', () => {
  const g = new TalkGaze()
  let prev = 0, worst = 0
  for (let k = 0; k < 40; k++) { g.step([11], 0.05); const w = weightOf(g, 11); worst = Math.max(worst, w - prev); prev = w }
  assert.equal(prev, 1)
  assert.ok(worst <= 1.5 * 0.05 / TALK.easeIn + 1e-9, `the largest step ${worst.toFixed(3)}`)
})

test('TalkGaze: every recruit a summons can hold standing by and the person a conversation names all look at once, whoever came first', () => {
  assert.ok(TALK.slots >= RECRUIT_SLOTS + 1, 'a slot for each recruit and one for the person named')
  const recruits = Array.from({ length: RECRUIT_SLOTS }, (_, i) => 10 + i)
  const g = new TalkGaze()
  for (let k = 0; k < 30; k++) g.step(recruits, 0.05)
  for (let k = 0; k < 30; k++) g.step([99, ...recruits], 0.05)
  for (const a of [99, ...recruits]) assert.equal(talkWeight(a, g.who, g.weight), 1, `${a} whole: the person named came last and still looks`)
  // One recruit dismissed and another called while the named person stays: the slots still hold everyone.
  for (let k = 0; k < 4; k++) g.step([99, ...recruits.slice(1), 50], 0.05)
  assert.ok(weightOf(g, 50) > 0 && weightOf(g, 10) > 0, 'the newcomer turning round while the dismissed one turns back')
})

test('TalkGaze: a newcomer who finds every slot taken waits until one has turned all the way back, and nobody already turning is cut short', () => {
  const g = new TalkGaze()
  const full = Array.from({ length: TALK.slots }, (_, i) => 100 + i)
  for (let k = 0; k < 30; k++) g.step(full, 0.05)
  for (const a of full) assert.equal(weightOf(g, a), 1, `${a} whole`)
  g.step([...full.slice(1), 999], 0.05)
  assert.equal(weightOf(g, 999), 0, 'the newcomer waits')
  assert.ok(weightOf(g, 100) > 0.9, 'the one let go eases back, not cut')
  let waited = 1
  while (weightOf(g, 999) === 0 && waited < 100) { g.step([...full.slice(1), 999], 0.05); waited++ }
  assert.ok(Math.abs(waited * 0.05 - TALK.easeOut) <= 0.1, `the newcomer took the slot once its person turned back (${(waited * 0.05).toFixed(2)} s)`)
  assert.equal(weightOf(g, 100), 0)
  assert.ok(g.who.includes(999) && !g.who.includes(100))
})

test('talkWeight: the weight of the slot that holds the person, 0 when none does, never over 1', () => {
  const who = [4, -1, 9, -1, -1, -1, -1, -1, -1, -1, -1, -1], weight = [0.5, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  assert.equal(talkWeight(4, who, weight), 0.5)
  assert.equal(talkWeight(9, who, weight), 1)
  assert.equal(talkWeight(5, who, weight), 0)
  assert.equal(talkWeight(4, [4, 4, -1, -1, -1, -1, -1, -1], [0.7, 0.7, 0, 0, 0, 0, 0, 0]), 1)
})

test('withinTalk: within the leash across the ground and on the eye\'s own floor; null without a reading', () => {
  const pose = new Float32Array([0, 0, 0, 0, 3, 0, 4, 0.5, 0, 0, 8.4, 0, 0, 60, 2, 0, 0, Number.NaN, 0, 0])
  const eye = { x: 0, y: 1.7, z: 0 }
  assert.equal(TALK.leash, GAZE.reach, 'the leash is where the gaze has let go already')
  assert.equal(withinTalk(pose, 1, eye), true, '5 m off, on the street')
  assert.equal(withinTalk(pose, 2, eye), true, '8.4 m off, inside the leash')
  assert.equal(withinTalk(pose, 2, { x: 0, y: 1.7, z: -0.2 }), false, '8.6 m off, past it')
  assert.equal(withinTalk(pose, 3, eye), false, 'sixty metres up: another floor')
  assert.equal(withinTalk(pose, 1, { x: 0, y: 61.7, z: 0 }), false, 'the eye at a sky floor\'s window, the person on the street below')
  assert.equal(withinTalk(pose, 1, { x: 0, y: 0.5, z: 0 }), true, 'crouched, still the same floor')
  assert.equal(withinTalk(pose, 4, eye), null, 'not a number: no reading')
  assert.equal(withinTalk(pose, 5, eye), null, 'past the copy: no reading')
  assert.equal(withinTalk(new Float32Array(0), 1, eye), null, 'no copy yet')
  assert.equal(withinTalk(pose, 1.5, eye), null, 'not an index')
  assert.equal(withinTalk(pose, -1, eye), null)
})
