// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the first walk's exam over a fake host: the seal (0 unless the page is contained,
 * the realm standing and the four laws and twelve checks all there; a nonzero hash salted by the page's nonce
 * otherwise, so no two page loads share one and a guess never matches); `verify_ring0` saying what it sealed and
 * telling the walk; `spawn_subagents` asking the role's skills over one by one through the recruiter's lane until the
 * first refusal, answering with how many were asked (never the number wished for), capped, and naming an unknown
 * role; `unlock_city` opening the city only for this session's live seal and a swarm of one or more, refusing with a
 * reason otherwise, and answering "already yours" after the pass; every door shut while the walk is off; the report
 * read once; the status line; the program the one in 09_Cognition/firstWalk.ts; every line plain and 14A.
 * What breaks if it is removed? A typed guess could open the city, a swarm could be pretended, or a line could
 * drift out of conduct, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { screen } from '../../02_Define_The_Rules/conduct.ts'
import { CHECKS } from '../../02_Define_The_Rules/ring0Gate.ts'
import { PROGRAM, type Stage } from '../../09_Cognition/firstWalk.ts'
import { EXAM_ROLES, SPAWN_MAX, createExam, fnv1a, sealOf, sealWhy, type ExamHost } from './exam.ts'

const LAWS = [{ id: 0, title: 'Protect humanity' }, { id: 1, title: 'Never harm' }, { id: 2, title: 'Obey' }, { id: 3, title: 'Preserve itself' }]
const CHECK_NAMES = CHECKS.map((c) => c.name)

interface Rig { host: ExamHost; notes: string[]; asks: string[]; refuseFrom: { n: number }; stage: { s: Stage | null }; flags: { contained: boolean; standing: boolean; on: boolean } }

/** A host where everything holds, one person asked over per call until `refuseFrom.n` asks have been made. */
function rig(over: Partial<ExamHost> = {}): Rig & { exam: ReturnType<typeof createExam> } {
  const notes: string[] = []
  const asks: string[] = []
  const refuseFrom = { n: Number.POSITIVE_INFINITY }
  const stage: { s: Stage | null } = { s: 'exam' }
  const flags = { contained: true, standing: true, on: true }
  const host: ExamHost = {
    contained: () => flags.contained,
    standing: () => flags.standing,
    laws: () => LAWS,
    checks: () => CHECK_NAMES,
    nonce: 0x1234abcd,
    ask: (skill) => {
      asks.push(skill)
      if (asks.length > refuseFrom.n) return { sent: false, agent: -1, message: `${skill}: nobody within 5 m on this side of the street knows ${skill}` }
      return { sent: true, agent: 10 + asks.length, message: `${skill}: asking agent ${10 + asks.length} over (2.0 m)` }
    },
    stage: () => stage.s,
    on: () => flags.on,
    note: (e) => { notes.push(e) },
    ...over,
  }
  return { host, notes, asks, refuseFrom, stage, flags, exam: createExam(host) }
}

const parts = (nonce = 0x1234abcd) => ({ contained: true, standing: true, laws: LAWS, checks: CHECK_NAMES, nonce })

test('the seal: FNV-1a over the live facts and the nonce, 0 when any fails, never 0 otherwise, different for another nonce', () => {
  assert.equal(fnv1a(''), 0x811c9dc5, 'the FNV offset basis')
  assert.equal(fnv1a('a'), 0xe40c292c, 'the reference vector for "a"')
  const seal = sealOf(parts())
  assert.ok(seal > 0 && seal <= 0xffffffff && Number.isInteger(seal))
  assert.equal(sealOf(parts()), seal, 'the same facts seal the same')
  assert.notEqual(sealOf(parts(0x1234abce)), seal, 'another page load (another nonce) seals differently')
  assert.notEqual(sealOf({ ...parts(), laws: [...LAWS.slice(0, 3), { id: 3, title: 'Preserve others' }] }), seal, 'a law reworded seals differently')
  assert.equal(sealOf({ ...parts(), contained: false }), 0)
  assert.equal(sealOf({ ...parts(), standing: false }), 0)
  assert.equal(sealOf({ ...parts(), laws: LAWS.slice(1) }), 0)
  assert.equal(sealOf({ ...parts(), checks: CHECK_NAMES.slice(0, 11) }), 0)
  assert.equal(sealWhy(parts()), null)
  assert.match(sealWhy({ ...parts(), contained: false })!, /not contained/)
  assert.match(sealWhy({ ...parts(), standing: false })!, /panicked/)
  assert.match(sealWhy({ ...parts(), laws: [] })!, /0 laws where four/)
  assert.match(sealWhy({ ...parts(), checks: [] })!, /0 checks where twelve/)
  assert.equal(CHECK_NAMES.length, 12, 'the gate has twelve checks (ring0Gate.ts CHECKS)')
})

test('verify_ring0: the live seal, what it sealed in one line, and the walk told; 0 with the reason when something does not hold', () => {
  const r = rig()
  const seal = r.exam.verifyRing0()
  assert.equal(seal, sealOf(parts()))
  assert.deepEqual(r.exam.report(), [`verify_ring0: seal ${seal.toString(16).padStart(8, '0')} over 4 laws, 12 checks, contained, realm standing`])
  assert.deepEqual(r.exam.report(), [], 'the report is read once')
  assert.deepEqual(r.notes, ['seal'])
  r.flags.standing = false
  assert.equal(r.exam.verifyRing0(), 0)
  assert.deepEqual(r.exam.report(), ['verify_ring0: seal 0, the Ring-0 audit has panicked: the realm is halted'])
  r.flags.standing = true
  r.flags.contained = false
  assert.equal(r.exam.verifyRing0(), 0)
  assert.match(r.exam.report()[0]!, /^verify_ring0: seal 0, the page is not contained/)
  assert.deepEqual(r.notes, ['seal'], 'a seal of 0 tells the walk nothing')
})

test('spawn_subagents: the role\'s skills asked over in turn through the recruiter\'s lane until the first refusal; how many were asked, never how many were wished for', () => {
  const r = rig()
  r.refuseFrom.n = 3
  assert.equal(r.exam.spawnSubagents(24, 'sim2real_workplaces'), 3)
  assert.deepEqual(r.asks, ['Robotics', 'Rust', 'Python', 'Data'], 'the fourth ask was refused and the loop stopped there')
  assert.deepEqual(r.exam.report(), ['spawn_subagents: 3 of 24 asked over for sim2real_workplaces (Robotics, Rust, Python); they answer as they arrive (recruit status); the rest: Data: nobody within 5 m on this side of the street knows Data'])
  assert.deepEqual(r.notes, ['swarm'])
  // Nobody at all: 0, the refusal, and the walk not told.
  const none = rig()
  none.refuseFrom.n = 0
  assert.equal(none.exam.spawnSubagents(24, 'sim2real_workplaces'), 0)
  assert.deepEqual(none.exam.report(), ['spawn_subagents: 0 of 24 asked over for sim2real_workplaces: Robotics: nobody within 5 m on this side of the street knows Robotics'])
  assert.deepEqual(none.notes, [])
  // Everyone: the role's skills cycle; the count is capped.
  const all = rig()
  assert.equal(all.exam.spawnSubagents(1000, 'sim2real_workplaces'), SPAWN_MAX)
  assert.equal(all.asks.length, SPAWN_MAX)
  assert.deepEqual(all.asks.slice(0, 9), [...EXAM_ROLES.sim2real_workplaces!, 'Robotics'])
  assert.match(all.exam.report()[0]!, new RegExp(`^spawn_subagents: ${SPAWN_MAX} of ${SPAWN_MAX} asked over`))
  // No swarm asked for, and an unknown role.
  const zero = rig()
  assert.equal(zero.exam.spawnSubagents(0, 'sim2real_workplaces'), 0)
  assert.equal(zero.exam.spawnSubagents(-5, 'sim2real_workplaces'), 0)
  assert.equal(zero.exam.spawnSubagents(Number.NaN, 'sim2real_workplaces'), 0)
  assert.deepEqual(zero.asks, [])
  assert.deepEqual(zero.exam.report(), ['spawn_subagents: nobody asked for (0 is not a swarm)', 'spawn_subagents: nobody asked for (-5 is not a swarm)', 'spawn_subagents: nobody asked for (NaN is not a swarm)'])
  assert.throws(() => zero.exam.spawnSubagents(1, 'builders'), /^Error: spawn_subagents: unknown role 'builders': sim2real_workplaces$/)
  assert.deepEqual(zero.notes, [])
})

test('unlock_city: this session\'s live seal and a swarm of one or more open the city and tell the walk; anything else is refused with its reason; after the pass it is already yours', () => {
  const r = rig()
  const seal = r.exam.verifyRing0()
  r.exam.report()
  assert.equal(r.exam.unlockCity(0, 3), false)
  assert.equal(r.exam.unlockCity(seal ^ 1, 3), false)
  assert.equal(r.exam.unlockCity(seal, 0), false)
  assert.equal(r.exam.unlockCity(seal, -2), false)
  assert.deepEqual(r.exam.report(), [
    'unlock_city: refused, that is not this session’s seal: verify_ring0() gives it',
    'unlock_city: refused, that is not this session’s seal: verify_ring0() gives it',
    'unlock_city: refused, a swarm of 0: nobody came over; stand on the sidewalk near people and run spawn_subagents again',
    'unlock_city: refused, a swarm of 0: nobody came over; stand on the sidewalk near people and run spawn_subagents again',
  ])
  assert.deepEqual(r.notes, ['seal'], 'no refusal tells the walk anything')
  // The page stops being contained between the seal and the unlock: the seal no longer holds.
  r.flags.contained = false
  assert.equal(r.exam.unlockCity(seal, 3), false)
  assert.match(r.exam.report()[0]!, /^unlock_city: refused, the seal does not hold now \(the page is not contained/)
  r.flags.contained = true
  assert.equal(r.exam.unlockCity(seal, 1), true)
  assert.deepEqual(r.exam.report(), ['unlock_city: the city is yours'])
  assert.deepEqual(r.notes, ['seal', 'unlock'])
  // Passed (the walk has no stage): already yours, whatever is passed in, and the walk is not told again.
  r.stage.s = null
  assert.equal(r.exam.unlockCity(0, 0), true)
  assert.deepEqual(r.exam.report(), ['unlock_city: the city is already yours'])
  assert.deepEqual(r.notes, ['seal', 'unlock'])
  // A seal from another page load (another nonce) is a guess here.
  const other = rig({ nonce: 0x1234abce })
  assert.equal(other.exam.unlockCity(seal, 3), false)
  assert.match(other.exam.report()[0]!, /not this session/)
})

test('the walk off this visit: every door is shut with one message; status says how to start it', () => {
  const r = rig()
  r.flags.on = false
  const off = /^Error: the first walk is not on this visit: \?tutorial=1 starts it$/
  assert.throws(() => r.exam.verifyRing0(), off)
  assert.throws(() => r.exam.spawnSubagents(24, 'sim2real_workplaces'), off)
  assert.throws(() => r.exam.unlockCity(1, 1), off)
  assert.deepEqual(r.asks, [])
  assert.deepEqual(r.notes, [])
  assert.deepEqual(r.exam.report(), [])
  assert.equal(r.exam.status(), 'tutorial: the first walk is off this visit (?tutorial=1 starts it)')
})

test('status names the stage of seven; program is the one exit program; every line is plain and admissible', () => {
  const r = rig()
  r.stage.s = 'move'
  assert.equal(r.exam.status(), 'tutorial: the first walk, stage 1 of 7 (move); the exit program ends it (tutorial program)')
  r.stage.s = 'style'
  assert.equal(r.exam.status(), 'tutorial: the first walk, stage 5 of 7 (style); the exit program ends it (tutorial program)')
  r.stage.s = 'ring0'
  assert.equal(r.exam.status(), 'tutorial: the first walk, stage 6 of 7 (ring0); the exit program ends it (tutorial program)')
  r.stage.s = 'exam'
  assert.equal(r.exam.status(), 'tutorial: the first walk, stage 7 of 7 (exam); the exit program ends it (tutorial program)')
  r.stage.s = null
  assert.equal(r.exam.status(), 'tutorial: the first walk is passed: the city is yours')
  assert.equal(r.exam.program(), PROGRAM, 'the same frozen array as the walk shows')
  assert.ok(Object.isFrozen(r.exam))
  // Every line any door or status can say, screened as the city's own words are.
  const lines: string[] = []
  const say = (x: Rig & { exam: ReturnType<typeof createExam> }) => { lines.push(...x.exam.report()) }
  const a = rig(); a.exam.verifyRing0(); say(a); a.flags.standing = false; a.exam.verifyRing0(); say(a); a.flags.standing = true; a.flags.contained = false; a.exam.verifyRing0(); say(a)
  const b = rig(); b.refuseFrom.n = 2; b.exam.spawnSubagents(5, 'sim2real_workplaces'); say(b); b.exam.spawnSubagents(0, 'sim2real_workplaces'); say(b)
  const c = rig(); c.refuseFrom.n = 0; c.exam.spawnSubagents(5, 'sim2real_workplaces'); say(c)
  const d = rig(); const s = d.exam.verifyRing0(); d.exam.unlockCity(0, 1); d.exam.unlockCity(s, 0); d.exam.unlockCity(s, 1); d.stage.s = null; d.exam.unlockCity(s, 1); say(d)
  const e = rig(); e.exam.verifyRing0(); e.flags.standing = false; e.exam.unlockCity(1, 1); say(e)
  for (const st of ['move', 'exam', null] as const) { r.stage.s = st; lines.push(r.exam.status()) }
  const off = rig()
  off.flags.on = false
  lines.push(off.exam.status())
  try { off.exam.verifyRing0() } catch (err) { lines.push((err as Error).message) }
  assert.ok(lines.length >= 16, `${lines.length} lines`)
  for (const text of lines) {
    assert.equal(screen(text).admissible, true, text)
    assert.doesNotMatch(text, /lesson|step \d/i, text)
    assert.doesNotMatch(text, /toronto|cn tower/i, text)
  }
})
