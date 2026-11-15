// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds who looks at the operator (talkGaze.ts) to its promises: nobody until the
 * operator talks to them; a head eased round to the operator and back, never snapped, at any frame rate the city
 * runs at (the phone's few frames a second among them); a slot freed only once its person has turned all the way
 * back; room for every recruit standing by and the person a conversation names at once; a newcomer who finds the
 * slots full waiting rather than taking one mid-turn; the reach and the floor a conversation holds across; and the
 * place the heads look at, the eye itself while it moves as a body moves, held through a cut when the eye goes into a
 * car's seat or jumps (up to a sky floor, across the street) so no head is swung round after it.
 * What breaks if it is removed? The slots could snap a head, leave someone looking after the conversation ended, or
 * let a person on the street below a sky floor's window be talked to, unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GAZE, gazeAt } from './humanoid.ts'
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

/** An eye at (x, y, z). */
const at = (x: number, y: number, z: number) => ({ x, y, z })

test('TalkGaze.look: the heads look at the eye itself while it moves as a body moves; with nobody turned a jump moves the place at once; an eye that is not a number moves nothing', () => {
  const g = new TalkGaze()
  g.look([], at(1, 2, 3), false, 1 / 60)
  assert.deepEqual([...g.eye], [1, 2, 3], 'the first eye is taken as it is')
  g.look([], at(50, 2, 3), false, 1 / 60)
  assert.deepEqual([...g.eye], [50, 2, 3], 'nobody turned: a jump shows on nobody')
  let x = 50
  for (let k = 0; k < 60; k++) { x += 5.2 / 60; g.look([7], at(x, 2, 3), false, 1 / 60) }
  assert.deepEqual([...g.eye], [x, 2, 3], 'a run is followed exactly')
  assert.equal(weightOf(g, 7), 1)
  for (let k = 0; k < 10; k++) { x += 5.2 * 0.1; g.look([7], at(x, 2, 3), false, 0.05) }
  assert.deepEqual([...g.eye], [x, 2, 3], 'even the longest step a frame can carry (RUN for engine.ts MAX_STEP_DT) is a body moving, not a jump')
  assert.equal(weightOf(g, 7), 1, 'and nobody turns away')
  assert.ok(5.2 * 0.1 < TALK.jump / 2, 'with room to spare')
  g.look([7], at(Number.NaN, 0, 0), false, 1 / 60)
  assert.deepEqual([...g.eye], [x, 2, 3], 'a broken eye moves nothing')
  for (let k = 0; k < 40; k++) g.look([], at(x, 2, 3), false, 0.05)
  assert.deepEqual([...g.who], Array(TALK.slots).fill(-1), 'the conversation over, everyone turned back')
})

test('TalkGaze.look: a jump of the eye while someone is turned to it is a cut: the place holds, every head turns back from there, the place moves, and whoever is still talked to turns round again', () => {
  for (const dt of [1 / 60, 0.05]) {
    const g = new TalkGaze()
    for (let k = 0; k < 40; k++) g.look([7], at(0, 1.6, 0), false, dt)
    assert.equal(weightOf(g, 7), 1)
    let frames = 0, rising = false, back = false
    let prev = 1
    for (; frames < 200; frames++) {
      g.look([7], at(3, 1.6, 0), false, dt)
      const w = weightOf(g, 7)
      if (w === 0) back = true
      if (!back) assert.deepEqual([...g.eye], [0, 1.6, 0], 'held while their head turns back, though they are still talked to')
      else assert.deepEqual([...g.eye], [3, 1.6, 0], 'once nobody is turned the place is the eye again')
      if (!back) assert.ok(w <= prev, 'turning back first')
      if (back && w > prev) rising = true
      if (w === 1 && rising) break
      prev = w
    }
    assert.ok(rising && weightOf(g, 7) === 1, 'round to the new place again')
    assert.ok(Math.abs(frames * dt - (TALK.easeOut + TALK.easeIn)) <= 3 * dt, `back and round again in about a second (${(frames * dt).toFixed(2)} s at dt ${dt.toFixed(3)})`)
  }
  const g = new TalkGaze()
  for (let k = 0; k < 40; k++) g.look([7], at(0, 1.6, 0), false, 0.05)
  assert.ok(Math.hypot(0.4, 1.6 - 1.15, 0.8) < TALK.jump, 'a seat nearer than a jump: only `away` can cut here')
  g.look([], at(0.4, 1.15, 0.8), true, 0.05)
  assert.deepEqual([...g.eye], [0, 1.6, 0], 'into a car\'s seat at the door: away, so the place holds')
  for (let k = 0; k < 20; k++) g.look([], at(0.4, 1.15, 0.8), true, 0.05)
  assert.deepEqual([...g.eye], [0.4, 1.15, 0.8], 'and with everyone turned back it is the seat')
  const h = new TalkGaze()
  for (let k = 0; k < 40; k++) h.look([7], at(0, 1.6, 0), false, 0.05)
  h.look([7], at(0.6, 1.6, 0), false, 0.05)
  assert.deepEqual([...h.eye], [0.6, 1.6, 0], 'a move shorter than a jump while talking: the view jumps with it and they go on looking at the operator')
  assert.equal(weightOf(h, 7), 1, 'no cut')
})

test('when the operator\'s eye jumps (into a car beside a recruit, up to a sky floor, a teleport away or to beside them or behind them, a long correction from the room) a recruit\'s head turning back turns no more than 0.03 rad a frame, at sixty frames a second and at five', () => {
  // A recruit at the origin facing +z (heading 0), the operator's eye 1.5 m in front of them (skills.ts INTERVIEW_DISTANCE).
  const neck: [number, number, number] = [0, 1.45, 0]
  const heading = 0
  const start = at(0, 1.6, 1.5)
  const turn = (a: { chest: number; head: number; pitch: number }, b: typeof a) => Math.abs(a.chest - b.chest) + Math.abs(a.head - b.head) + Math.abs(a.pitch - b.pitch)
  // Where the eye lands, whether the operator is then in a seat, and whether the recruit is still within reach (talked to).
  const jumps: [string, number, number, number, boolean, boolean][] = [
    ['the seat of a car beside them', 1.5, 1.15, 1.5, true, false], ['the seat of a car further off', 3.5, 1.15, 1.5, true, false],
    ['a seat behind them', -1, 1.15, -1.5, true, false], ['a sky floor overhead', 0, 61.6, 1.5, false, false], ['a teleport away', 40, 1.6, 0, false, false],
    ['a parked car\'s side behind them', -1.75, 1.6, -3.75, false, true], ['beside their shoulder', 1.3, 1.6, 0.1, false, true],
    ['a correction from the room past a jump', 1.4, 1.6, 2.2, false, true],
  ]
  let caught = 0
  for (const [where, jx, jy, jz, away, near] of jumps) {
    for (const dt of [1 / 60, 0.05]) {
      const g = new TalkGaze()
      for (let k = 0; k < 40; k++) g.look([7], start, false, dt)
      let prev = gazeAt(neck, heading, 0, 0, [g.eye[0], g.eye[1], g.eye[2]], weightOf(g, 7))
      const first = prev
      assert.ok(prev.pitch > 0.05, 'looking at the operator\'s eye to begin with')
      if (turn(first, gazeAt(neck, heading, 0, 0, [jx, jy, jz], weightOf(g, 7))) > 0.3) caught++
      let worst = 0, back = false
      for (let t = 0; t < TALK.easeOut + TALK.easeIn + 0.2; t += dt) {
        g.look(near ? [7] : [], at(jx, jy, jz), away, dt)
        const w = weightOf(g, 7)
        const now = gazeAt(neck, heading, 0, 0, [g.eye[0], g.eye[1], g.eye[2]], w)
        if (!back) worst = Math.max(worst, turn(prev, now))
        if (w === 0) back = true
        prev = now
      }
      assert.ok(back, `${where}: turned all the way back first`)
      assert.ok(worst <= 0.03, `${where} at dt ${dt.toFixed(3)}: turning back, the worst frame turned ${worst.toFixed(4)} rad`)
      if (near) assert.ok(weightOf(g, 7) === 1, `${where}: still talked to, so round to the new place again`)
      else assert.deepEqual([prev.chest, prev.head, prev.pitch], [0, 0, 0], `${where}: facing the front`)
    }
  }
  assert.ok(caught >= 8, `chasing the eye itself would have turned a head more than 0.3 rad in one frame in ${caught} of these`)
})
