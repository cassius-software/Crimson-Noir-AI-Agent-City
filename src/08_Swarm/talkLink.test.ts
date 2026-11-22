// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins who the player can talk to and when a conversation holds (talkLink.ts). The scan
 * never offers the player's own body, a fallen person wearing a rig, a hidden row, a row that is not a number,
 * someone on another floor or anyone past TALK_REACH. It returns at most TALK_POOL people, nearest first, in the
 * caller's own arrays, and it is safe with no people and with short arrays. The score puts straight ahead before the
 * screen's edge. The link is held to every transition, one table row each: a nominee is shown only after two scans,
 * replaced only by one clearly better on two, kept between TALK_REACH and TALK_KEEP, not offered again for two
 * seconds after a conversation with them, and never offered to a running player. An open conversation never changes
 * partner and closes for the right reason (walked, gone, away, or the one it was given), and only a conversation's
 * closing gives a reason. A seeded fuzz of 20,000 steps holds the same rules on any order of events, and the file is
 * pinned pure (no three, no DOM, no clock, contact.ts's own HIDDEN_Y).
 * What breaks if it is removed? The label could flicker between two people, offer someone behind a wall, upstairs
 * or the player's own body, switch partner in the middle of a reply, or close a conversation with no reason to toast,
 * unnoticed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createRng } from '../02_Define_The_Rules/degrees.ts'
import { GAZE } from '../03_Spawn_Agents/humanoid.ts'
import { WARDROBE } from '../03_Spawn_Agents/look.ts'
import { RELEASE_DISTANCE, SUMMON_ACCEPT } from '../03_Spawn_Agents/skills.ts'
import { HIDDEN_Y } from '../07_Execute_Actions/contact.ts'
import { RUN, WALK } from '../07_Execute_Actions/simProtocol.ts'
import {
  blankScan, CHEST_AT, HEAD_AT, LABEL_ABOVE, linkStep, LINK_OFF, nearestPeople, TALK_AGAIN_MS, TALK_CONFIRM, TALK_FLOOR, TALK_JUMP, TALK_KEEP, TALK_POOL,
  TALK_REACH, TALK_RELEASE, TALK_RUN, TALK_SCAN_MS, TALK_SWITCH, TALK_WALL_CHECKS, TALK_WALLED_MS, talkScore,
  type TalkEnd, type TalkEvent, type TalkEye, type TalkLink, type TalkScan, type TalkStep,
} from './talkLink.ts'

const SOURCE = readFileSync(new URL('./talkLink.ts', import.meta.url), 'utf8')
/** The source without its comments (a line comment starts at // not preceded by a colon, as in URLs). */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const ENDS: readonly TalkEnd[] = ['done', 'bye', 'walked', 'gone', 'away', 'idle', 'sloane', 'dispose']

/** A pose copy of `agents` rows (x, feet y, z, heading), every row hidden below the street but the ones given as [row, x, y, z]. */
function poseOf(agents: number, people: readonly (readonly [number, number, number, number])[]): Float32Array {
  const pose = new Float32Array(4 * agents)
  for (let i = 0; i < agents; i++) pose[4 * i + 1] = -100
  for (const [row, x, y, z] of people) pose.set([x, y, z, 0], 4 * row)
  return pose
}
const eyeAt = (x: number, z: number, feetY = 0): TalkEye => ({ x, z, feetY, yaw: 0, speed: 0 })
/** nearestPeople into a fresh pool: the rows found and their distances, nearest first. */
function nearest(pose: Float32Array, n: number, eye: TalkEye, skip: readonly number[] = []): { rows: number[]; dists: number[] } {
  const rows = new Int32Array(TALK_POOL), dists = new Float32Array(TALK_POOL)
  const k = nearestPeople(pose, n, eye, skip, rows, dists)
  return { rows: [...rows.subarray(0, k)], dists: [...dists.subarray(0, k)] }
}
const rowsNear = (pose: Float32Array, n: number, eye: TalkEye, skip: readonly number[] = []): number[] => nearest(pose, n, eye, skip).rows

/** A scan event at `now`: no nominee and no row followed unless given; idle and walking unless said. */
const scan = (s: Partial<TalkScan> = {}, now = 0, o: { idle?: boolean; running?: boolean } = {}): TalkEvent =>
  ({ e: 'scan', s: { ...blankScan(), ...s }, idle: o.idle ?? true, running: o.running ?? false, now })
/** The followed row at `d` m: there, unwalled, on screen with a score of `d`. */
const at = (d: number, more: Partial<TalkScan> = {}): Partial<TalkScan> => ({ curD: d, curWalls: 0, curScore: d, curGone: false, curX: d, curZ: 0, ...more })
const press: TalkEvent = { e: 'press' }
const blocked: TalkEvent = { e: 'blocked' }
const end = (why: TalkEnd): TalkEvent => ({ e: 'end', why })

/** Every step of a run of events from `link`. */
function run(link: TalkLink, events: readonly TalkEvent[]): TalkStep[] {
  const steps: TalkStep[] = []
  for (const ev of events) {
    const step = linkStep(link, ev)
    steps.push(step)
    link = step.link
  }
  return steps
}
/** The last step of a run. */
const after = (link: TalkLink, events: readonly TalkEvent[]): TalkStep => run(link, events).at(-1) ?? assert.fail('no events')
/** The link at a glance: off, or the mode and the row. */
const shape = (link: TalkLink): string => (link.mode === 'off' ? 'off' : `${link.mode} ${link.row}`)
/** Every step at a glance: the link's shape, and the reason when one closed. */
const shapes = (steps: readonly TalkStep[]): string[] => steps.map((s) => (s.ended ? `${shape(s.link)} (${s.ended})` : shape(s.link)))
/** The link showing `row`, reached the only way it can be: two scans of them as the nominee from off. */
const nearTo = (row: number, now = 0): TalkLink => after(LINK_OFF, [scan({ best: row, bestScore: 2 }, now - TALK_SCAN_MS), scan({ best: row, bestScore: 2 }, now)]).link
/** A conversation with `row`, opened from their being shown. */
const openWith = (row: number, now = 0): TalkLink => linkStep(nearTo(row, now), press).link

test('the reaches nest: offered within TALK_REACH, inside the gaze reach; kept within TALK_KEEP (SUMMON_ACCEPT); released past TALK_RELEASE (RELEASE_DISTANCE)', () => {
  assert.equal(TALK_REACH, 4)
  assert.ok(TALK_REACH < GAZE.reach, 'a person offered can turn their head to the player')
  assert.equal(TALK_KEEP, SUMMON_ACCEPT)
  assert.equal(TALK_KEEP, 6)
  assert.equal(TALK_RELEASE, RELEASE_DISTANCE)
  assert.equal(TALK_RELEASE, 12)
  assert.ok(TALK_REACH < TALK_KEEP && TALK_KEEP < TALK_RELEASE)
  assert.equal(TALK_FLOOR, 1.2)
  assert.equal(TALK_POOL, 8)
  assert.equal(TALK_WALL_CHECKS, 3)
  assert.ok(TALK_WALL_CHECKS <= TALK_POOL)
  assert.equal(TALK_SWITCH, 0.75)
  assert.equal(TALK_CONFIRM, 2)
  assert.equal(TALK_AGAIN_MS, 2000)
  assert.equal(TALK_WALLED_MS, 1500)
  assert.equal(TALK_SCAN_MS, 250)
  assert.equal(TALK_JUMP, 4)
  assert.equal(TALK_RUN, 2.5)
  assert.ok(WALK < TALK_RUN && TALK_RUN < RUN, 'a walk is offered people, a run is not')
  assert.equal(HEAD_AT, 1.7)
  assert.equal(CHEST_AT, 1.2)
  assert.ok(CHEST_AT < HEAD_AT && HEAD_AT <= WARDROBE.stature.max)
  assert.equal(LABEL_ABOVE, 2.2)
  assert.ok(LABEL_ABOVE > WARDROBE.stature.max, 'the label clears the tallest head')
})

test('nearestPeople never offers row 0, the player\'s own body', () => {
  const pose = poseOf(4, [[0, 0, 0, 0], [1, 3, 0, 0]])
  assert.deepEqual(rowsNear(pose, 4, eyeAt(0, 0)), [1])
})

test('nearestPeople skips the rows it is told to (the fallen, who wear rigs), looked up only for rows in reach', () => {
  const pose = poseOf(8, [[1, 1, 0, 0], [2, 1.5, 0, 0], [3, 2, 0, 0], [4, 9, 0, 0]])
  assert.deepEqual(rowsNear(pose, 8, eyeAt(0, 0), [2]), [1, 3])
  assert.deepEqual(rowsNear(pose, 8, eyeAt(0, 0), [1, 2, 3]), [])
  assert.deepEqual(rowsNear(pose, 8, eyeAt(0, 0), [4, 6]), [1, 2, 3], 'a skip list naming nobody in reach changes nothing')
})

test('nearestPeople skips a row that is not a number in any coordinate', () => {
  const pose = poseOf(6, [[1, Number.NaN, 0, 0], [2, 0, 0, Number.NaN], [3, 0, Number.NaN, 1], [4, Infinity, 0, 0], [5, 2, 0, 0]])
  assert.deepEqual(rowsNear(pose, 6, eyeAt(0, 0)), [5])
})

test('nearestPeople skips hidden rows at contact.ts\'s HIDDEN_Y exactly, even with the player down there too', () => {
  assert.equal(HIDDEN_Y, -50)
  // The player's feet beside the fold, so the floor test passes and only the hidden test decides.
  const eye = eyeAt(0, 0, HIDDEN_Y + 0.5)
  const pose = poseOf(4, [[1, 1, HIDDEN_Y, 0], [2, 2, HIDDEN_Y + 0.001, 0], [3, 1.5, HIDDEN_Y - 0.5, 0]])
  assert.deepEqual(rowsNear(pose, 4, eye), [2])
})

test('nearestPeople keeps to the player\'s floor: feet within TALK_FLOOR, on the street and on a sky floor', () => {
  const pose = poseOf(8, [[1, 1, 1.19, 0], [2, 1.2, -1.19, 0], [3, 1.4, 1.21, 0], [4, 1.6, -1.21, 0], [5, 1.8, 30, 0], [6, 2, 30.5, 0]])
  assert.deepEqual(rowsNear(pose, 8, eyeAt(0, 0)), [1, 2])
  assert.deepEqual(rowsNear(pose, 8, eyeAt(0, 0, 30)), [5, 6], 'upstairs, the street below is nobody')
})

test('nearestPeople reaches TALK_REACH over the ground and no farther', () => {
  const pose = poseOf(8, [[1, 3.99, 0, 0], [2, 4.01, 0, 0], [3, 2.8, 0, 2.8], [4, 2.9, 0, 2.9], [5, 0, 0, -3.9], [6, 13, 0, 0]])
  const found = nearest(pose, 8, eyeAt(0, 0))
  assert.deepEqual(found.rows, [5, 3, 1])
  for (const [i, row] of found.rows.entries()) {
    const o = 4 * row
    assert.ok(Math.abs(found.dists[i] - Math.hypot(pose[o], pose[o + 2])) < 1e-5, 'the distance over the ground comes back with the row')
  }
  // Measured from wherever the player stands, not from the origin.
  assert.deepEqual(rowsNear(pose, 8, eyeAt(13, 1)), [6])
})

test('nearestPeople returns at most TALK_POOL, nearest first, and equal distances keep row order', () => {
  // Twenty people in reach, in a scrambled order of rows.
  const people: [number, number, number, number][] = []
  for (let k = 0; k < 20; k++) people.push([1 + ((k * 7) % 20), 0.15 + 0.18 * k, 0, 0])
  const found = nearest(poseOf(32, people), 32, eyeAt(0, 0))
  assert.equal(found.rows.length, TALK_POOL)
  assert.deepEqual(found.rows, people.slice(0, TALK_POOL).map((p) => p[0]))
  for (let i = 1; i < found.dists.length; i++) assert.ok(found.dists[i - 1] <= found.dists[i], 'nearest first')
  // Ties: the lower row first, whichever way round they sit.
  const tied = poseOf(10, [[7, 2, 0, 0], [3, 0, 0, 2], [5, -2, 0, 0], [9, 1, 0, 0]])
  assert.deepEqual(rowsNear(tied, 10, eyeAt(0, 0)), [9, 3, 5, 7])
  // The pool fills and the nearest still win when they come last.
  const late: [number, number, number, number][] = []
  for (let r = 1; r <= 12; r++) late.push([r, 4 - 0.25 * r, 0, 0])
  assert.deepEqual(rowsNear(poseOf(16, late), 16, eyeAt(0, 0)), [12, 11, 10, 9, 8, 7, 6, 5])
})

test('nearestPeople writes into the caller\'s arrays and nothing else, so one pair serves every scan', () => {
  const rows = new Int32Array(TALK_POOL), dists = new Float32Array(TALK_POOL)
  const pose = poseOf(10, [[1, 1, 0, 0], [2, 2, 0, 0], [3, 3, 0, 0]])
  const poseBefore = [...pose], skip = [8]
  assert.equal(nearestPeople(pose, 10, eyeAt(0, 0), skip, rows, dists), 3)
  assert.deepEqual([...rows.subarray(0, 3)], [1, 2, 3])
  assert.deepEqual([...dists.subarray(0, 3)], [1, 2, 3])
  assert.deepEqual([...pose], poseBefore, 'the pose copy is read, never written')
  assert.deepEqual(skip, [8], 'the skip list is read, never written')
  // A later scan with fewer people overwrites the front of the same arrays and says how many are fresh.
  assert.equal(nearestPeople(poseOf(10, [[7, 0.5, 0, 0]]), 10, eyeAt(0, 0), skip, rows, dists), 1)
  assert.equal(rows[0], 7)
  assert.equal(dists[0], 0.5)
  // And the scan allocates nothing: no new arrays, objects, closures or spreads in its body.
  const body = CODE.slice(CODE.indexOf('export function nearestPeople('), CODE.indexOf('export function talkScore('))
  assert.ok(body.length > 0)
  // (An empty array literal, not a type such as `number[]`: the character before it is no word or closing bracket.)
  assert.doesNotMatch(body, /\bnew\b|=>|\.\.\.|\.(?:map|filter|slice|subarray|concat|push|sort|from)\(|(?:^|[^\w\])])\[\s*\]|\{\s*\}/)
})

test('nearestPeople is safe with nobody, no rows to consider and short arrays', () => {
  const pose = poseOf(10, [[1, 1, 0, 0], [2, 2, 0, 0], [3, 3, 0, 0]])
  const rows = new Int32Array(TALK_POOL), dists = new Float32Array(TALK_POOL)
  assert.equal(nearestPeople(pose, 0, eyeAt(0, 0), [], rows, dists), 0)
  assert.equal(nearestPeople(pose, -5, eyeAt(0, 0), [], rows, dists), 0)
  assert.equal(nearestPeople(pose, Number.NaN, eyeAt(0, 0), [], rows, dists), 0)
  assert.equal(nearestPeople(new Float32Array(0), 100, eyeAt(0, 0), [], rows, dists), 0)
  // More rows asked for than the copy holds, or a copy cut short mid-row: held to the whole rows it has.
  assert.deepEqual(rowsNear(pose, 1e6, eyeAt(0, 0)), [1, 2, 3])
  assert.deepEqual(rowsNear(pose.subarray(0, 4 * 3 + 2), 10, eyeAt(0, 0)), [1, 2])
  // Short or empty result arrays: held to the shorter of the two.
  const two = new Int32Array(2), twoD = new Float32Array(2)
  assert.equal(nearestPeople(pose, 10, eyeAt(0, 0), [], two, twoD), 2)
  assert.deepEqual([...two], [1, 2])
  assert.equal(nearestPeople(pose, 10, eyeAt(0, 0), [], rows, new Float32Array(1)), 1)
  assert.equal(nearestPeople(pose, 10, eyeAt(0, 0), [], new Int32Array(0), dists), 0)
  // A player whose position is not a number has nobody near.
  assert.equal(nearestPeople(pose, 10, eyeAt(Number.NaN, 0), [], rows, dists), 0)
  assert.equal(nearestPeople(pose, 10, eyeAt(0, 0, Number.NaN), [], rows, dists), 0)
})

test('talkScore puts straight ahead before the screen\'s edge, the same either side, and off screen last', () => {
  assert.equal(talkScore(3, 0.5), 3, 'the middle adds nothing')
  assert.equal(talkScore(3, 0), 3 * 1.75)
  assert.equal(talkScore(3, 1), 3 * 1.75)
  assert.ok(Math.abs(talkScore(2, 0.2) - talkScore(2, 0.8)) < 1e-12, 'the same on either side')
  assert.ok(talkScore(3, 0.5) < talkScore(2.5, 0.02), 'three metres ahead beats two and a half at the edge')
  assert.ok(talkScore(2, 0.5) < talkScore(3, 0.5), 'nearer wins at the same place on screen')
  assert.ok(talkScore(2, 0.6) < talkScore(2, 0.7) && talkScore(2, 0.4) < talkScore(2, 0.3), 'the farther out, the worse')
  assert.equal(talkScore(2, Number.NaN), Infinity, 'off screen (screenPoint.ts gives NaN)')
  assert.equal(talkScore(Number.NaN, 0.5), Infinity)
  assert.equal(talkScore(Infinity, 0.5), Infinity)
})

test('blankScan leaves no nominee and no row followed, in place or new', () => {
  const s = blankScan()
  assert.deepEqual(s, { best: -1, bestScore: Infinity, curD: Number.NaN, curWalls: 0, curScore: Infinity, curGone: true, curX: Number.NaN, curZ: Number.NaN })
  const out: TalkScan = { best: 4, bestScore: 1, curD: 2, curWalls: 1, curScore: 2, curGone: false, curX: 1, curZ: 1 }
  assert.equal(blankScan(out), out, 'reset in place')
  assert.deepEqual(out, s)
  assert.ok(Object.isFrozen(LINK_OFF))
  assert.deepEqual(LINK_OFF, { mode: 'off', pend: -1, pendN: 0, last: -1, lastAt: Number.NaN })
})

test('linkStep, off + scan: a nominee is shown only after TALK_CONFIRM scans in a row', () => {
  const five = (now: number) => scan({ best: 5, bestScore: 2 }, now)
  const six = (now: number) => scan({ best: 6, bestScore: 2 }, now)
  assert.deepEqual(shapes(run(LINK_OFF, [five(0), five(250)])), ['off', 'near 5'])
  const first = linkStep(LINK_OFF, five(0)).link
  assert.equal(first.mode, 'off')
  assert.equal(first.mode === 'off' && first.pend, 5)
  assert.equal(first.mode === 'off' && first.pendN, 1)
  // Interrupted by someone else or by nobody: the count starts again.
  assert.deepEqual(shapes(run(LINK_OFF, [five(0), six(250), five(500), five(750)])), ['off', 'off', 'off', 'near 5'])
  assert.deepEqual(shapes(run(LINK_OFF, [five(0), scan({}, 250), five(500), five(750)])), ['off', 'off', 'off', 'near 5'])
  // Nobody at all stays off.
  assert.deepEqual(shapes(run(LINK_OFF, [scan({}, 0), scan({}, 250)])), ['off', 'off'])
  // Shown: the count is spent.
  const shown = nearTo(5)
  assert.equal(shown.mode === 'near' && shown.pend, -1)
  assert.equal(shown.mode === 'near' && shown.pendN, 0)
})

test('linkStep, near + scan: someone else replaces the person shown only below TALK_SWITCH of their score, on two scans in a row', () => {
  const shown = nearTo(5)
  // The person shown scores 3; 6 scores 2.3, not below 0.75 × 3 = 2.25: never a switch.
  const close = (now: number) => scan({ ...at(3), best: 6, bestScore: 2.3 }, now)
  const clear = (now: number) => scan({ ...at(3), best: 6, bestScore: 2.2 }, now)
  assert.deepEqual(shapes(run(shown, [close(250), close(500), close(750), close(1000)])), ['near 5', 'near 5', 'near 5', 'near 5'])
  assert.deepEqual(shapes(run(shown, [clear(250), clear(500)])), ['near 5', 'near 6'])
  // Clearly better once, then not: the count starts again.
  assert.deepEqual(shapes(run(shown, [clear(250), close(500), clear(750), clear(1000)])), ['near 5', 'near 5', 'near 5', 'near 6'])
  // The person shown as the nominee themselves: nothing to switch to.
  assert.deepEqual(shapes(run(shown, [scan({ ...at(3), best: 5, bestScore: 3 }, 250), scan({ ...at(3), best: 5, bestScore: 3 }, 500)])), ['near 5', 'near 5'])
  // Off screen, the person shown scores Infinity: anyone on screen replaces them after two scans.
  const unseen = (now: number) => scan({ ...at(3, { curScore: Infinity }), best: 6, bestScore: 3.9 }, now)
  assert.deepEqual(shapes(run(shown, [unseen(250), unseen(500)])), ['near 5', 'near 6'])
})

test('linkStep, near + scan: the person shown stays while there, within TALK_KEEP and unwalled, past TALK_REACH too', () => {
  const shown = nearTo(5)
  // Beyond the reach they were offered at, still within TALK_KEEP and off screen: kept.
  assert.deepEqual(shapes(run(shown, [scan(at(4.5), 250), scan(at(5.9, { curScore: Infinity }), 500), scan(at(TALK_KEEP), 750)])), ['near 5', 'near 5', 'near 5'])
  // Past TALK_KEEP, walled, gone, or not a number: off.
  assert.deepEqual(shapes([linkStep(shown, scan(at(6.1), 250))]), ['off'])
  assert.deepEqual(shapes([linkStep(shown, scan(at(2, { curWalls: 1 }), 250))]), ['off'])
  assert.deepEqual(shapes([linkStep(shown, scan(at(2, { curGone: true }), 250))]), ['off'])
  assert.deepEqual(shapes([linkStep(shown, scan(at(Number.NaN), 250))]), ['off'])
  // Dropped with a nominee already counted once: the nominee confirmed by this scan is shown instead.
  const counted = linkStep(shown, scan({ ...at(3), best: 6, bestScore: 1 }, 250)).link
  assert.equal(shape(counted), 'near 5')
  assert.equal(shape(linkStep(counted, scan({ ...at(7), best: 6, bestScore: 1 }, 500)).link), 'near 6')
  // Dropped with a nominee seen for the first time: off, and shown on the next scan.
  assert.deepEqual(shapes(run(shown, [scan({ ...at(7), best: 6, bestScore: 3 }, 250), scan({ best: 6, bestScore: 3 }, 500)])), ['off', 'near 6'])
  // No step that is not the end of a conversation gives a reason.
  for (const s of run(shown, [scan(at(7), 250), scan({}, 500)])) assert.equal(s.ended, null)
})

test('linkStep: nobody is offered while the player runs, and the person shown is not replaced', () => {
  const runScan = (s: Partial<TalkScan>, now: number) => scan(s, now, { running: true })
  assert.deepEqual(shapes(run(LINK_OFF, [runScan({ best: 5, bestScore: 2 }, 0), runScan({ best: 5, bestScore: 2 }, 250), runScan({ best: 5, bestScore: 2 }, 500)])), ['off', 'off', 'off'])
  // Running counts for nothing: two walking scans after it are needed.
  assert.deepEqual(shapes(run(LINK_OFF, [runScan({ best: 5, bestScore: 2 }, 0), scan({ best: 5, bestScore: 2 }, 250), scan({ best: 5, bestScore: 2 }, 500)])), ['off', 'off', 'near 5'])
  const shown = nearTo(5)
  assert.deepEqual(shapes(run(shown, [runScan({ ...at(3), best: 6, bestScore: 0.5 }, 250), runScan({ ...at(3), best: 6, bestScore: 0.5 }, 500)])), ['near 5', 'near 5'], 'held while it holds')
  assert.deepEqual(shapes(run(shown, [runScan({ ...at(7), best: 6, bestScore: 0.5 }, 250), runScan({ best: 6, bestScore: 0.5 }, 500)])), ['off', 'off'], 'dropped, and nobody else')
})

test('linkStep: the partner of a conversation that just closed is not offered again for TALK_AGAIN_MS, anyone else is', () => {
  const closed = linkStep(openWith(5, 0), end('done'))
  assert.equal(closed.ended, 'done')
  assert.equal(closed.link.mode, 'off')
  assert.equal(closed.link.mode === 'off' && closed.link.last, 5)
  assert.ok(closed.link.mode === 'off' && Number.isNaN(closed.link.lastAt), 'an ending carries no time: the next scan stamps it')
  // The first scan after the closing stamps 1000; five is not counted until 3000, and shown at 3250.
  const again = (now: number) => scan({ best: 5, bestScore: 1 }, now)
  const steps = run(closed.link, [1000, 1250, 2000, 2750, 2999, 3000, 3250].map(again))
  assert.deepEqual(shapes(steps), ['off', 'off', 'off', 'off', 'off', 'off', 'near 5'])
  const stamped = steps[0].link
  assert.equal(stamped.mode === 'off' && stamped.lastAt, 1000)
  const forgotten = steps[5].link
  assert.equal(forgotten.mode === 'off' && forgotten.last, -1, 'forgotten once the time has passed')
  // Someone else is offered at once.
  assert.deepEqual(shapes(run(closed.link, [scan({ best: 6, bestScore: 1 }, 1000), scan({ best: 6, bestScore: 1 }, 1250)])), ['off', 'near 6'])
  // Closed by a scan (they walked on): stamped with that scan's time.
  const walked = linkStep(openWith(5, 0), scan(at(13), 400))
  assert.equal(walked.ended, 'walked')
  assert.equal(walked.link.mode === 'off' && walked.link.lastAt, 400)
  assert.deepEqual(shapes(run(walked.link, [again(2150), again(2399), again(2400), again(2650)])), ['off', 'off', 'off', 'near 5'])
  // The rule holds while someone else is shown, too: they are never replaced by the last partner.
  const other = after(closed.link, [scan({ best: 6, bestScore: 3 }, 1000), scan({ best: 6, bestScore: 3 }, 1250)]).link
  assert.deepEqual(shapes(run(other, [scan({ ...at(3), best: 5, bestScore: 0.5 }, 1500), scan({ ...at(3), best: 5, bestScore: 0.5 }, 1750)])), ['near 6', 'near 6'])
})

test('linkStep, press: near opens with the person shown; off and open change nothing', () => {
  const opened = linkStep(nearTo(5), press)
  assert.equal(shape(opened.link), 'open 5')
  assert.equal(opened.ended, null)
  assert.ok(opened.link.mode === 'open' && Number.isNaN(opened.link.walledSince), 'no wall yet')
  const nothing = linkStep(LINK_OFF, press)
  assert.equal(nothing.link, LINK_OFF, 'press in off is a no-op')
  assert.equal(nothing.ended, null)
  const talking = openWith(5)
  const again = linkStep(talking, press)
  assert.equal(again.link, talking, 'while open, what a press means is the controller\'s to decide')
  assert.equal(again.ended, null)
})

test('linkStep, open + scan: it never switches partner, whoever else is near and however much better', () => {
  const talking = openWith(5)
  const lure = (now: number, running = false) => scan({ ...at(3, { curScore: Infinity }), best: 6, bestScore: 0.1 }, now, { running, idle: false })
  const steps = run(talking, [lure(250), lure(500), lure(750, true), lure(1000), lure(1250)])
  assert.deepEqual(shapes(steps), ['open 5', 'open 5', 'open 5', 'open 5', 'open 5'])
  for (const s of steps) assert.equal(s.ended, null)
})

test('linkStep, open + scan: walked past TALK_RELEASE always, past TALK_KEEP only when idle', () => {
  const talking = openWith(5)
  const busy = (d: number) => scan(at(d), 250, { idle: false })
  const idle = (d: number) => scan(at(d), 250, { idle: true })
  assert.deepEqual(shapes([linkStep(talking, busy(11.9))]), ['open 5'])
  assert.deepEqual(shapes([linkStep(talking, busy(TALK_RELEASE))]), ['open 5'])
  assert.deepEqual(shapes([linkStep(talking, busy(12.1))]), ['off (walked)'])
  assert.deepEqual(shapes([linkStep(talking, busy(Infinity))]), ['off (walked)'])
  assert.deepEqual(shapes([linkStep(talking, busy(6.1))]), ['open 5'], 'a reply in progress holds to TALK_RELEASE')
  assert.deepEqual(shapes([linkStep(talking, idle(6.1))]), ['off (walked)'])
  assert.deepEqual(shapes([linkStep(talking, idle(TALK_KEEP))]), ['open 5'])
  assert.deepEqual(shapes([linkStep(talking, idle(5.9))]), ['open 5'])
})

test('linkStep, open + scan: a wall for TALK_WALLED_MS closes with walked; a clear sight resets the count', () => {
  const talking = openWith(5)
  const walled = (now: number) => scan(at(2, { curWalls: 1 }), now, { idle: false })
  const clear = (now: number) => scan(at(2), now, { idle: false })
  const steps = run(talking, [walled(0), walled(750), walled(1499), walled(1500)])
  assert.deepEqual(shapes(steps), ['open 5', 'open 5', 'open 5', 'off (walked)'])
  assert.equal(steps[0].link.mode === 'open' && steps[0].link.walledSince, 0)
  assert.equal(steps[2].link.mode === 'open' && steps[2].link.walledSince, 0)
  const reset = run(talking, [walled(0), walled(1000), clear(1250), walled(1500), walled(2750), walled(3000)])
  assert.deepEqual(shapes(reset), ['open 5', 'open 5', 'open 5', 'open 5', 'open 5', 'off (walked)'])
  assert.ok(reset[2].link.mode === 'open' && Number.isNaN(reset[2].link.walledSince), 'cleared')
  // Two walls count as one.
  assert.deepEqual(shapes(run(talking, [scan(at(2, { curWalls: 2 }), 0), scan(at(2, { curWalls: 2 }), 1500)])), ['open 5', 'off (walked)'])
})

test('linkStep, open + scan: gone closes with gone, and the partner is remembered', () => {
  const talking = openWith(5)
  const gone = linkStep(talking, scan(at(2, { curGone: true }), 900, { idle: false }))
  assert.equal(gone.ended, 'gone')
  assert.deepEqual(gone.link, { mode: 'off', pend: -1, pendN: 0, last: 5, lastAt: 900 })
  assert.equal(linkStep(talking, scan(at(Number.NaN), 900)).ended, 'gone', 'a partner who is not a number is gone')
  // Gone wins over walked: a respawn far away is not someone who walked on.
  assert.equal(linkStep(talking, scan(at(40, { curGone: true }), 900)).ended, 'gone')
})

test('linkStep, blocked: from open it closes with away; from near or off it gives no reason and clears the count', () => {
  const fromOpen = linkStep(openWith(5), blocked)
  assert.equal(fromOpen.ended, 'away')
  assert.equal(shape(fromOpen.link), 'off')
  assert.equal(fromOpen.link.mode === 'off' && fromOpen.link.last, 5)
  const fromNear = linkStep(nearTo(5), blocked)
  assert.equal(fromNear.ended, null)
  assert.equal(shape(fromNear.link), 'off')
  const counting = linkStep(LINK_OFF, scan({ best: 5, bestScore: 2 }, 0)).link
  const fromOff = linkStep(counting, blocked)
  assert.equal(fromOff.ended, null)
  assert.deepEqual(fromOff.link, LINK_OFF, 'the count starts again after a block')
  // And the next scan after a block counts once, not twice.
  assert.deepEqual(shapes(run(counting, [blocked, scan({ best: 5, bestScore: 2 }, 250), scan({ best: 5, bestScore: 2 }, 500)])), ['off', 'off', 'near 5'])
})

test('linkStep, end: open closes with the reason given; near and off give none', () => {
  for (const why of ENDS) {
    const step = linkStep(openWith(5), end(why))
    assert.equal(step.ended, why)
    assert.equal(shape(step.link), 'off')
    assert.equal(step.link.mode === 'off' && step.link.last, 5)
  }
  const fromNear = linkStep(nearTo(5), end('dispose'))
  assert.equal(fromNear.ended, null)
  assert.equal(shape(fromNear.link), 'off')
  assert.equal(linkStep(LINK_OFF, end('away')).ended, null)
})

test('linkStep, a seeded fuzz of 20,000 steps: a reason only on leaving open, always one that fits, and open never changes partner', () => {
  const rng = createRng(0x7a1c_5eed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]
  const seen = new Set<string>(), reasons = new Set<TalkEnd>()
  let link: TalkLink = LINK_OFF, now = 0, best = -1
  for (let i = 0; i < 20000; i++) {
    const r = rng()
    let ev: TalkEvent
    if (r < 0.04) ev = blocked
    else if (r < 0.16) ev = press
    else if (r < 0.2) ev = end(pick(ENDS))
    else {
      now += pick([0, 40, 250, 250, 250, 400, 900])
      // The nominee mostly holds from one scan to the next, as people do.
      if (rng() < 0.3) best = pick([-1, -1, 1, 2, 3, 7])
      const s: TalkScan = {
        best, bestScore: best >= 0 ? rng() * 6 : Infinity, curD: pick([0.5, 3, 4.5, 5.9, 6.5, 11, 13, Number.NaN]), curWalls: pick([0, 0, 0, 0, 1, 2]),
        curScore: rng() < 0.2 ? Infinity : rng() * 6, curGone: rng() < 0.04, curX: rng() * 10, curZ: rng() * 10,
      }
      ev = { e: 'scan', s, idle: rng() < 0.5, running: rng() < 0.1, now }
    }
    const { link: next, ended } = linkStep(link, ev)
    const where: string = `step ${i}: ${shape(link)} + ${ev.e} → ${shape(next)}`
    seen.add(`${link.mode}>${next.mode}`)
    if (link.mode === 'open' && next.mode !== 'open') {
      // Leaving open: always off, always a reason, and the one that fits the event.
      assert.equal(next.mode, 'off', where)
      assert.ok(ended !== null && ENDS.includes(ended), where)
      const fits: readonly TalkEnd[] = ev.e === 'end' ? [ev.why] : ev.e === 'blocked' ? ['away'] : ev.e === 'scan' ? ['gone', 'walked'] : []
      assert.ok(fits.includes(ended), `${where}: ${ended}`)
      assert.equal(next.last, link.row, `${where}: the partner is remembered`)
      reasons.add(ended)
    } else {
      assert.equal(ended, null, `${where}: a reason only on leaving open`)
    }
    if (link.mode === 'open' && next.mode === 'open') assert.equal(next.row, link.row, `${where}: open never changes partner`)
    if (next.mode === 'open' && link.mode !== 'open') {
      assert.ok(link.mode === 'near' && ev.e === 'press' && next.row === link.row, `${where}: open only by a press on the person shown`)
    }
    if (next.mode === 'near' && (link.mode !== 'near' || next.row !== link.row)) {
      assert.ok(ev.e === 'scan' && !ev.running && next.row === ev.s.best, `${where}: shown only as a walking scan's nominee`)
    }
    if (next.mode !== 'open') assert.ok(next.pendN >= 0 && next.pendN < TALK_CONFIRM, `${where}: a count never rests at the confirm`)
    if (next.mode !== 'off') assert.ok(next.row >= 1, where)
    assert.ok(Object.isFrozen(next), `${where}: links are frozen`)
    link = next
  }
  // The fuzz really walked the graph: every move between modes and every reason a conversation can close for.
  for (const move of ['off>off', 'off>near', 'near>near', 'near>off', 'near>open', 'open>open', 'open>off']) assert.ok(seen.has(move), `the fuzz saw ${move}`)
  assert.deepEqual([...reasons].sort(), [...ENDS].sort())
})

test('talkLink.ts is pure and opens as every source does: no three, no DOM, no clock, contact.ts\'s own HIDDEN_Y', () => {
  const sibling = readFileSync(new URL('./roster.ts', import.meta.url), 'utf8')
  assert.deepEqual(SOURCE.split('\n').slice(0, 3), sibling.split('\n').slice(0, 3), 'the licence header, line for line')
  assert.match(SOURCE.split('\n')[3], /^\/\*\*$/)
  assert.match(SOURCE, /Why does this file exist\?/)
  assert.match(SOURCE, /What breaks if it is removed\?/)
  const specifiers = [...CODE.matchAll(/\bfrom\s+'([^']+)'|\bimport\s*\(/g)].map((m) => m[1] ?? 'dynamic import')
  assert.deepEqual(specifiers, ['../03_Spawn_Agents/skills.ts', '../07_Execute_Actions/contact.ts'])
  assert.match(CODE, /import \{ HIDDEN_Y \} from '\.\.\/07_Execute_Actions\/contact\.ts'/)
  assert.doesNotMatch(CODE, /\bHIDDEN_Y\s*=|-\s*50\b/, 'no copy of the fold that could drift')
  assert.doesNotMatch(CODE, /\b(?:document|window|globalThis|performance|Date|setTimeout|setInterval|requestAnimationFrame|localStorage)\b|Math\.random/)
  assert.doesNotMatch(CODE, /\benum\b|\bclass\b|;\s*$/m, 'no enums, no classes, no semicolons')
  // No combat words and no word the console forbids, comments included.
  assert.doesNotMatch(SOURCE, /\b(?:target|attack|kill|weapon|shoot|gun|violence|injur\w*|damage|hit|strike|fire|ragdoll|perform)\b/i)
})
