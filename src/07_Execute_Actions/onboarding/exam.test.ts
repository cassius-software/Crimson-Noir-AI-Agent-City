// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the first walk's exam over a fake host: the seal (0 unless the page is contained,
 * the realm standing and the four laws and fifteen checks all there; a nonzero hash salted by the page's nonce
 * otherwise, so no two page loads share one and a guess never matches); `verify_ring0` saying what it sealed and
 * telling the walk; `spawn_subagents` setting its swarm to work through the host's team runner from wherever the
 * player stands (nothing opened while the realm does not hold), answering with the lanes still running after their
 * first tick (never the number wished for, never an isolated lane), capped at the runner's cap, saying what it
 * replaced and which desks this map has no room for, and naming an unknown role; `unlock_city` opening the city only for this session's live seal and a swarm of one or more, refusing with a
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
import { TEAM_MAX } from '../../06_Make_Decisions/dispatch.ts'
import { EXAM_ROLES, SPAWN_MAX, createExam, fnv1a, heldWhy, sealOf, sealWhy, type ExamHost } from './exam.ts'

const LAWS = [{ id: 0, title: 'Protect humanity' }, { id: 1, title: 'Never harm' }, { id: 2, title: 'Obey' }, { id: 3, title: 'Preserve itself' }]
const CHECK_NAMES = CHECKS.map((c) => c.name)

/** The fake runner's answer: how many of the lanes it opens are isolated at once, the team it replaces, the desks this map has no room for. */
interface Runner { isolate: number; replaced: number; missing: number }
interface Rig { host: ExamHost; notes: string[]; swarms: { n: number; role: string }[]; runner: Runner; stage: { s: Stage | null }; flags: { contained: boolean; standing: boolean; on: boolean } }

/** A host where everything holds and a team runner that opens what it is asked for (up to its cap), `runner` saying what else it reports. */
function rig(over: Partial<ExamHost> = {}): Rig & { exam: ReturnType<typeof createExam> } {
  const notes: string[] = []
  const swarms: { n: number; role: string }[] = []
  const runner: Runner = { isolate: 0, replaced: 0, missing: 0 }
  const stage: { s: Stage | null } = { s: 'exam' }
  const flags = { contained: true, standing: true, on: true }
  const host: ExamHost = {
    contained: () => flags.contained,
    standing: () => flags.standing,
    laws: () => LAWS,
    checks: () => CHECK_NAMES,
    nonce: 0x1234abcd,
    swarm: (n, role) => {
      swarms.push({ n, role })
      // As the runner: the desks are the first n of the sixteen, and those this map has no room for are among them.
      const opened = Math.min(n, TEAM_MAX)
      const desks = Math.min(opened, 16)
      return { running: Math.max(0, opened - runner.isolate), opened, desks, replaced: runner.replaced, missing: Array.from({ length: Math.min(runner.missing, desks) }, (_, i) => `desk ${i}`) }
    },
    stage: () => stage.s,
    on: () => flags.on,
    note: (e) => { notes.push(e) },
    ...over,
  }
  return { host, notes, swarms, runner, stage, flags, exam: createExam(host) }
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
  assert.equal(sealOf({ ...parts(), checks: CHECK_NAMES.slice(0, -1) }), 0)
  assert.equal(sealWhy(parts()), null)
  assert.match(sealWhy({ ...parts(), contained: false })!, /not contained/)
  assert.match(sealWhy({ ...parts(), standing: false })!, /panicked/)
  assert.match(sealWhy({ ...parts(), laws: [] })!, /0 laws where four/)
  assert.match(sealWhy({ ...parts(), checks: [] })!, /0 checks where fifteen/)
  assert.equal(CHECK_NAMES.length, 15, 'the gate has fifteen checks (ring0Gate.ts CHECKS)')
})

test('verify_ring0: the live seal, what it sealed in one line, and the walk told; 0 with the reason when something does not hold', () => {
  const r = rig()
  const seal = r.exam.verifyRing0()
  assert.equal(seal, sealOf(parts()))
  assert.deepEqual(r.exam.report(), [`verify_ring0: seal ${seal.toString(16).padStart(8, '0')} over 4 laws, 15 checks, contained, realm standing`])
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

test('spawn_subagents: the swarm set to work through the team runner from wherever the player stands; the lanes still running, never how many were wished for', () => {
  const r = rig()
  assert.equal(r.exam.spawnSubagents(24, 'sim2real_workplaces'), 24)
  assert.deepEqual(r.swarms, [{ n: 24, role: 'sim2real_workplaces' }], 'one call to the runner, for the whole swarm')
  assert.deepEqual(r.exam.report(), ['spawn_subagents: 24 of 24 sub-agents at work for sim2real_workplaces, one lane each across 16 workplaces; anyone within earshot with a desk’s skill is asked over too while you are on foot (lanes shows them)'])
  assert.deepEqual(r.notes, ['swarm'])
  // Isolated at once: only the running lanes count; all isolated is 0, said so, and the walk not told.
  const some = rig()
  some.runner.isolate = 5
  assert.equal(some.exam.spawnSubagents(24, 'sim2real_workplaces'), 19)
  assert.match(some.exam.report()[0]!, /^spawn_subagents: 19 of 24 sub-agents at work for sim2real_workplaces, one lane each across 16 workplaces; 5 isolated at once \(lanes ledger says why\);/)
  const dead = rig()
  dead.runner.isolate = 99
  assert.equal(dead.exam.spawnSubagents(24, 'sim2real_workplaces'), 0)
  assert.deepEqual(dead.exam.report(), ['spawn_subagents: 0 of 24 set to work for sim2real_workplaces: 24 opened and every one isolated at once (lanes ledger says why)'])
  assert.deepEqual(dead.notes, [])
  // What it replaced, and the desks this map has no room for: some (a map with fewer rooms), or all of them (a surveyed
  // region), where nobody is asked over and the line says so rather than promising people.
  const more = rig()
  more.runner.replaced = 2
  more.runner.missing = 1
  assert.equal(more.exam.spawnSubagents(3, 'sim2real_workplaces'), 3)
  assert.deepEqual(more.exam.report(), ['spawn_subagents: 3 of 3 sub-agents at work for sim2real_workplaces, one lane each across 2 workplaces; it replaces the team of 2 that was at work; this map has no room for one desk, whose lanes read around where you started; anyone within earshot with a desk’s skill is asked over too while you are on foot (lanes shows them)'])
  more.runner.missing = 99
  assert.equal(more.exam.spawnSubagents(24, 'sim2real_workplaces'), 24)
  assert.deepEqual(more.exam.report(), ['spawn_subagents: 24 of 24 sub-agents at work for sim2real_workplaces, reading the city around where you started (this map has no workplaces, so nobody is asked over); it replaces the team of 2 that was at work (lanes shows them)'])
  const single = rig()
  single.exam.spawnSubagents(1, 'sim2real_workplaces')
  assert.match(single.exam.report()[0]!, /^spawn_subagents: 1 of 1 sub-agents at work for sim2real_workplaces, one lane each across 1 workplace; /)
  // The cap is the runner's: asked for more, the runner is asked for its cap and the line says so.
  assert.equal(SPAWN_MAX, TEAM_MAX, 'the exam never asks the runner for more than it opens')
  const all = rig()
  assert.equal(all.exam.spawnSubagents(1000, 'sim2real_workplaces'), SPAWN_MAX)
  assert.deepEqual(all.swarms, [{ n: SPAWN_MAX, role: 'sim2real_workplaces' }])
  assert.match(all.exam.report()[0]!, new RegExp(`^spawn_subagents: ${SPAWN_MAX} of 1000 sub-agents at work for sim2real_workplaces, one lane each across 16 workplaces; a team holds at most ${SPAWN_MAX};`))
  assert.equal(all.exam.spawnSubagents(2.9, 'sim2real_workplaces'), 2, 'a fraction is the whole sub-agents in it')
  // The realm not holding: nothing opened (the gate would isolate every lane), the reason said, the walk not told.
  for (const [flag, why] of [['contained', heldWhy({ contained: false, standing: true })], ['standing', heldWhy({ contained: true, standing: false })]] as const) {
    const held = rig()
    held.flags[flag] = false
    assert.equal(held.exam.spawnSubagents(24, 'sim2real_workplaces'), 0)
    assert.deepEqual(held.swarms, [], 'the runner is never asked')
    assert.deepEqual(held.exam.report(), [`spawn_subagents: 0 of 24 set to work for sim2real_workplaces: ${why}; nothing was opened`])
    assert.deepEqual(held.notes, [])
  }
  // No swarm asked for, and an unknown role.
  const zero = rig()
  assert.equal(zero.exam.spawnSubagents(0, 'sim2real_workplaces'), 0)
  assert.equal(zero.exam.spawnSubagents(-5, 'sim2real_workplaces'), 0)
  assert.equal(zero.exam.spawnSubagents(Number.NaN, 'sim2real_workplaces'), 0)
  assert.equal(zero.exam.spawnSubagents(0.5, 'sim2real_workplaces'), 0)
  assert.deepEqual(zero.swarms, [])
  assert.deepEqual(zero.exam.report(), ['spawn_subagents: nobody asked for (0 is not a swarm)', 'spawn_subagents: nobody asked for (-5 is not a swarm)', 'spawn_subagents: nobody asked for (NaN is not a swarm)', 'spawn_subagents: nobody asked for (0.5 is not a swarm)'])
  assert.deepEqual(EXAM_ROLES, ['sim2real_workplaces'])
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
    'unlock_city: refused, a swarm of 0: no sub-agent is at work; run spawn_subagents again (lanes says why)',
    'unlock_city: refused, a swarm of 0: no sub-agent is at work; run spawn_subagents again (lanes says why)',
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
  assert.deepEqual(r.swarms, [])
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
  const b = rig(); b.exam.spawnSubagents(24, 'sim2real_workplaces'); say(b); b.exam.spawnSubagents(0, 'sim2real_workplaces'); say(b); b.exam.spawnSubagents(1000, 'sim2real_workplaces'); say(b)
  const c = rig(); c.runner.isolate = 99; c.exam.spawnSubagents(5, 'sim2real_workplaces'); say(c)
  const c2 = rig(); c2.runner.isolate = 2; c2.runner.replaced = 24; c2.runner.missing = 2; c2.exam.spawnSubagents(24, 'sim2real_workplaces'); c2.runner.missing = 16; c2.exam.spawnSubagents(24, 'sim2real_workplaces'); say(c2)
  const c3 = rig(); c3.flags.contained = false; c3.exam.spawnSubagents(24, 'sim2real_workplaces'); c3.flags.contained = true; c3.flags.standing = false; c3.exam.spawnSubagents(24, 'sim2real_workplaces'); say(c3)
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
