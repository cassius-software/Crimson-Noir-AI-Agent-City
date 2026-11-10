// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the page's keeper of the operator's progression and the console's side of it: a
 * round's three actions and reaction, a skill's minute of rest, the save after every change and the listeners told,
 * the reroll and the training through the keeper, the purchase gate saved in one write, a reset; which console
 * commands earn a check (doing something does, reading does not) and that a command with an error earns nothing; the
 * round clock run without a check; what the recruiter's events earn (an arrival, an understood spoken request); the
 * HUD chip's finished strings; the `progress` command's every form; a rest at home through the keeper (saved, told,
 * kept across a reload, said on every check, in `progress` and on the chip) and the home card's words for it; and the
 * text's rules (no upstream names, no scrubbed words, nothing about conditioning, no slash in the HUD's words, no
 * urgency in a rest's).
 * What breaks if it is removed? Reading `help` could earn credits, a failed command could pay, one recruit could pay
 * twice, a purchase could go unsaved, the HUD's pips could stay spent, or the progress text could drift into words
 * the product does not use.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CRIT_SUCCESS, FAILURE, SUCCESS } from '../02_Define_The_Rules/degrees.ts'
import {
  AT, HERO_MAX, MAX_LEVEL, OPERATOR_SKILLS, PURCHASE, REST_CHECKS, ROUND_MS, SKILL_REST_MS, STARTING_CREDITS, attempt, newRecord, reroll, seal,
} from '../02_Define_The_Rules/progression.ts'
import { PROGRESS_KEY, saveProgress } from '../05_Observe_Environment/progressStore.ts'
import type { ProfileStore } from '../05_Observe_Environment/profile.ts'
import {
  HUD_CUE_MS, checkLines, commandSkill, createProgress, cueOf, earnFromRecruiter, grouped, hudProgress, pips, progressBridge, restOffer, restTake,
  statusLines, tableLines, worthCue, type Progress, type ProgressCue,
} from './progress.ts'
import { run, type CommandResult } from './terminal/commands.ts'
import { offlineBridge, type TerminalBridge } from './terminal/bridge.ts'

const BRAND = { name: 'TESTBRAND', version: '9.8.7', host: 'testhost' }

function memory(): ProfileStore & { map: Map<string, string>; writes: number } {
  const map = new Map<string, string>()
  const s = { map, writes: 0, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { s.writes++; map.set(k, v) }, removeItem: (k: string) => { map.delete(k) } }
  return s
}

function keeper(store: ProfileStore | null = null): { p: Progress; t: { now: number } } {
  const t = { now: 0 }
  return { p: createProgress({ store, seed: () => 77, now: () => t.now }), t }
}

test('a round: three actions, then nothing until the next round; the reaction is apart', () => {
  const { p, t } = keeper()
  assert.ok(p.earn('computers'))
  assert.ok(p.earn('piloting'))
  assert.ok(p.earn('robotics'))
  assert.equal(p.earn('security'), null, 'no action left')
  assert.ok(p.earn('security', true), 'the reaction')
  assert.equal(p.earn('swarm', true), null)
  t.now += ROUND_MS
  assert.ok(p.earn('swarm'), 'a new round')
})

test('a skill rests a minute after its check; a refused check spends nothing', () => {
  const { p, t } = keeper()
  assert.ok(p.earn(0))
  assert.equal(p.earn(0), null)
  assert.equal(p.record[AT.actions] & 3, 2, 'the refusal spent no action')
  assert.equal(p.restFor(0), SKILL_REST_MS)
  t.now += SKILL_REST_MS - 1
  assert.equal(p.earn(0), null)
  t.now += 1
  assert.ok(p.earn(0))
  assert.equal(p.restFor(1), 0)
  assert.throws(() => p.earn('nothing' as never), /no skill 'nothing'/)
  assert.throws(() => p.earn(8), /no skill/)
})

test('every change is saved and told; a stored record is picked up again', () => {
  const s = memory()
  const { p } = keeper(s)
  const told: (number | null)[] = []
  const off = p.subscribe((c) => told.push(c ? c.skill : null))
  const c = p.earn('optics')!
  assert.deepEqual(told, [6])
  assert.ok(s.map.has(PROGRESS_KEY))
  assert.equal(p.buy('look', 3, 1, 10), PURCHASE.bought)
  assert.deepEqual(told, [6, null])
  assert.equal(p.buy('look', 3, 1, 10), PURCHASE.owned)
  assert.deepEqual(told, [6, null], 'a refused purchase changes nothing')
  off()
  p.earn('voice')
  assert.equal(told.length, 2)
  const again = createProgress({ store: s, now: () => 0 })
  assert.equal(again.owns('look', 3), true)
  assert.equal(again.record[AT.credits], STARTING_CREDITS + c.credits + (again.record[AT.earned] - c.credits) - 10)
  assert.equal(again.setAside(), null)
})

test('a damaged stored record is set aside and said; a new operator starts', () => {
  const s = memory()
  s.map.set(PROGRESS_KEY, '{"v":1,"words":[1,2,3]}')
  const p = createProgress({ store: s, now: () => 0, seed: () => 1 })
  assert.match(p.setAside()!, /does not have its words/)
  assert.equal(p.record[AT.level], 1)
  assert.ok(statusLines(p).some((l) => /set aside/.test(l)))
})

test('a new session tops the hero points up to one', () => {
  const s = memory()
  const r = newRecord(5)
  r[AT.hero] = 0
  seal(r)
  saveProgress(r, s)
  assert.equal(createProgress({ store: s }).record[AT.hero], 1)
})

test('train, reroll, spend and reset through the keeper', () => {
  const { p } = keeper()
  assert.throws(() => p.train('computers'), /no skill increase/)
  p.record[AT.increases] = 1
  seal(p.record)
  assert.equal(p.train('computers'), 'expert')
  assert.throws(() => p.reroll(), /no check to reroll/)
  const c = p.earn('computers')!
  if (c.degree < 3) assert.equal(p.reroll().reroll, true)
  assert.equal(p.spend(STARTING_CREDITS * 1000), false)
  assert.equal(p.spendResolve(100), false)
  assert.ok(p.spendResolve(1))
  p.reset()
  assert.equal(p.record[AT.level], 1)
  assert.equal(p.record[AT.ranks], 1)
  assert.equal(p.last(), null)
})

test('which commands earn: doing something does, reading the city does not', () => {
  const earns: [string, string[], number][] = [
    ['noir', ['print(1);'], 0], ['r0', ['1 2 + .'], 0], ['run', ['rust: 1'], 0],
    ['robot', ['set', 'arm', 'j1', '0.2'], 2], ['robot', ['demo'], 2],
    ['harness', ['run', 'sanctuary'], 3], ['act', ['gate'], 3], ['act', ['log', 'verify'], 3], ['swarm', ['audit verify'], 3],
    ['act', ['ok'], 4], ['swarm', ['run fix the build'], 4], ['recruit', ['rally', '12'], 4], ['ask', ['rust: why'], 4],
    ['ask', ['rust,go: why'], 4], ['ping', ['go'], 4],
    ['say', ['design: hello'], 5], ['sloane', ['say hello'], 5],
    ['rain', ['on'], 6], ['ghost', ['off'], 6], ['time', ['21:00'], 6], ['xr', ['vr'], 6], ['record', ['start'], 6],
    ['look', ['preset', 'navy', 'suit'], 7], ['look', ['random'], 7],
  ]
  for (const [name, args, skill] of earns) assert.equal(commandSkill(name, args), skill, `${name} ${args.join(' ')}`)
  const reads: [string, string[]][] = [
    ['noir', []], ['noir', ['reset']], ['noir', ['words']], ['noir', ['asm 1']], ['r0', ['reset']], ['run', []],
    ['robot', []], ['harness', ['list']], ['act', []], ['act', ['log']], ['act', ['list']], ['act', ['no']], ['swarm', ['status']], ['swarm', ['plan x']],
    ['swarm', ['audit']], ['recruit', []], ['recruit', ['stop']], ['recruit', ['dismiss']], ['recruit', ['install']],
    // The arrival earns Swarm command and an understood spoken request earns Acoustics and voice (earnFromRecruiter).
    ['recruit', ['rust']], ['recruit', ['listen']], ['ask', []], ['ask', ['provider claude']],
    ['ask', ['connect claude http://127.0.0.1:1']], ['ask', ['server http://127.0.0.1:11434']], ['ping', []], ['ping', ['clear']],
    ['say', ['voice anna']], ['sloane', ['voices']], ['rain', []], ['ghost', []], ['time', []], ['xr', []], ['xr', ['off']],
    ['record', ['stop']], ['look', []], ['look', ['show']], ['help', []], ['stats', []], ['progress', []], ['progress', ['reroll']],
    ['goal', ['fix the build']], ['operator', ['unlock']], ['map', ['city']], ['haptics', ['off']],
  ]
  for (const [name, args] of reads) assert.equal(commandSkill(name, args), -1, `${name} ${args.join(' ')}`)
})

test('the round clock runs without a check: round() refills after ROUND_MS, says how long until then, and neither saves nor tells', () => {
  const s = memory()
  const { p, t } = keeper(s)
  assert.ok(p.earn('computers'))
  assert.ok(p.earn('piloting'))
  assert.ok(p.earn('robotics', true))
  assert.equal(pips(p.record), '◆◇◇')
  const writes = s.writes
  let told = 0
  p.subscribe(() => { told++ })
  t.now = 1000
  assert.equal(p.round(), ROUND_MS - 1000)
  assert.equal(pips(p.record), '◆◇◇', 'not yet')
  t.now = ROUND_MS - 1
  assert.equal(p.round(), 1)
  t.now = ROUND_MS
  assert.equal(p.round(), ROUND_MS, 'a new round began just now')
  assert.equal(pips(p.record), '◆◆◆ ↺')
  assert.equal(p.round(), ROUND_MS, 'and only one')
  assert.deepEqual([s.writes, told], [writes, 0], 'a new round is neither saved nor told')
  // The console's `progress` runs it too, so its pips agree with the HUD's after a quiet spell.
  assert.ok(p.earn('security'))
  assert.match(statusLines(p)[0], /actions ◆◆◇ ↺$/)
  t.now += ROUND_MS
  assert.match(statusLines(p)[0], /actions ◆◆◆ ↺$/)
  // Its summary of what earns says what the city really pays: the boarding alone, and a request understood.
  const lines = statusLines(p)
  assert.ok(lines.some((l) => /^ {2}piloting .*boarding a parked car with the door key(?: \(rests \d+ s\))?$/.test(l)), 'Piloting: the door key\'s boarding')
  assert.ok(lines.some((l) => /^ {2}voice .*a spoken request understood(?: \(rests \d+ s\))?$/.test(l)), 'voice: a spoken request understood')
  assert.ok(lines.every((l) => !/\bdriving\b|\blistening\b/.test(l)), 'driving and opening the microphone earn nothing')
})

test('the recruiter: an arrival earns Swarm command from the reaction, an understood request Acoustics and voice; once each, nothing while resting, nothing once unsubscribed', () => {
  const { p, t } = keeper()
  const feed = new EventTarget()
  const told: number[] = []
  p.subscribe((c) => { if (c) told.push(c.skill) })
  const arrived = () => new CustomEvent('active', { detail: { agent: 7, skill: 'Rust', skills: ['Rust', 'Go'] } })
  const understood = () => new CustomEvent('understood', { detail: { transcript: 'recruit a rust developer', skill: 'Rust' } })
  const off = earnFromRecruiter(p, feed)
  feed.dispatchEvent(arrived())
  assert.deepEqual(told, [4])
  assert.equal(p.record[AT.actions], 3, 'the reaction spent, the three actions kept')
  feed.dispatchEvent(understood())
  assert.deepEqual(told, [4, 5])
  assert.equal(p.record[AT.actions], 2, 'an action spent')
  // Whatever else the recruiter says earns nothing.
  for (const type of ['heard', 'recruit', 'refused', 'released', 'rally', 'mic']) feed.dispatchEvent(new CustomEvent(type, { detail: {} }))
  assert.deepEqual(told, [4, 5])
  // A new round, but both skills rest: nothing earned, nothing spent.
  t.now += ROUND_MS
  feed.dispatchEvent(arrived())
  feed.dispatchEvent(understood())
  assert.deepEqual(told, [4, 5])
  assert.equal(p.record[AT.actions], 3 | 4)
  // Rested: once each again.
  t.now += SKILL_REST_MS
  feed.dispatchEvent(arrived())
  feed.dispatchEvent(understood())
  assert.deepEqual(told, [4, 5, 4, 5])
  off()
  t.now += SKILL_REST_MS
  feed.dispatchEvent(arrived())
  feed.dispatchEvent(understood())
  assert.deepEqual(told, [4, 5, 4, 5], 'unsubscribed')
})

/** A level-3 operator with 420 XP, 1,250 credits and two hero points. */
function standing(): { p: Progress; t: { now: number } } {
  const k = keeper()
  const r = k.p.record
  r[AT.level] = 3
  r[AT.xp] = 420
  r[AT.credits] = 1250
  r[AT.hero] = 2
  seal(r)
  return k
}

test('the HUD chip: the standing as finished strings and in full words; the same object while nothing changed; the pips refill on their own', () => {
  const { p, t } = standing()
  const h = hudProgress(p, null, 0)
  assert.equal(h.text, 'Level 3 · 420 of 1,000 XP · 1,250 credits · hero 2 · ◆◆◆ ↺')
  assert.equal(h.label, 'Level 3, 420 of 1,000 experience points, 1,250 credits, 2 hero points, 3 of 3 actions left this round, reaction ready')
  assert.equal(h.pips, '◆◆◆ ↺')
  assert.deepEqual([h.cue, h.cueText, h.delta, h.cueAt, h.cueAge], [null, '', '', -1, Infinity])
  assert.ok(Object.isFrozen(h))
  assert.equal(hudProgress(p, null, 100), h, 'nothing new: the same object, no strings built')
  assert.ok(p.earn('computers'))
  assert.ok(p.earn('piloting', true))
  const spent = hudProgress(p, null, 200)
  assert.notEqual(spent, h)
  assert.match(spent.text, / · ◆◆◇$/)
  assert.match(spent.label, /, 2 of 3 actions left this round, reaction spent$/)
  t.now += ROUND_MS
  assert.match(hudProgress(p, null, 300).text, / · ◆◆◆ ↺$/, 'the round refilled without a check')
  // One of everything reads in the singular; the top level shows no XP to go.
  p.record[AT.credits] = 1
  p.record[AT.hero] = 1
  p.record[AT.level] = MAX_LEVEL
  seal(p.record)
  const top = hudProgress(p, null, 400)
  assert.equal(top.text, `Level ${MAX_LEVEL} · top level · 1 credit · hero 1 · ◆◆◆ ↺`)
  assert.equal(top.label, `Level ${MAX_LEVEL}, the top level, 1 credit, 1 hero point, 3 of 3 actions left this round, reaction ready`)
})

test('the HUD chip: a fresh success and a fresh critical success say which and what they paid; a stale cue or a failure shows none', () => {
  const { p } = standing()
  const ok: ProgressCue = { degree: SUCCESS, skill: 1, xp: 40, credits: 150, hero: 0, at: 1000 }
  const s = hudProgress(p, ok, 1250)
  assert.deepEqual([s.cue, s.cueText, s.delta, s.cueAt, s.cueAge], ['success', 'Success in Piloting', '+40 XP, +150 credits', 1000, 250])
  assert.equal(s.text, 'Level 3 · 420 of 1,000 XP · 1,250 credits · hero 2 · ◆◆◆ ↺', 'the standing is unchanged by the cue')
  assert.match(s.label, /, reaction ready\. Success in Piloting: 40 experience points, 150 credits$/)
  const later = hudProgress(p, ok, 1300)
  assert.equal(later.cueAge, 300, 'the age moves on')
  assert.equal(later.delta, s.delta)
  assert.equal(hudProgress(p, ok, 1000 + HUD_CUE_MS - 1).cue, 'success')
  const stale = hudProgress(p, ok, 1000 + HUD_CUE_MS)
  assert.deepEqual([stale.cue, stale.cueText, stale.delta, stale.cueAt, stale.cueAge], [null, '', '', -1, Infinity], 'no longer fresh')
  assert.equal(stale.label, hudProgress(p, null, 0).label)
  const crit: ProgressCue = { degree: CRIT_SUCCESS, skill: 6, xp: 60, credits: 1500, hero: 1, at: 2000 }
  const c = hudProgress(p, crit, 2000)
  assert.deepEqual([c.cue, c.cueText, c.delta, c.cueAt, c.cueAge], ['critical', 'Critical success in Optics and cinema', '+60 XP, +1,500 credits, +1 hero point', 2000, 0])
  assert.match(c.label, /\. Critical success in Optics and cinema: 60 experience points, 1,500 credits, 1 hero point$/)
  assert.equal(hudProgress(p, { ...crit, degree: FAILURE }, 2000).cue, null, 'a failure is no cue')
  // The cue the host keeps comes straight from the check.
  const check = p.earn('optics')!
  const kept = cueOf(check, 5)
  assert.deepEqual(kept, { degree: check.degree, skill: 6, xp: check.xp, credits: check.credits, hero: check.hero, at: 5 })
  assert.ok(Object.isFrozen(kept))
  assert.equal(hudProgress(p, kept, 5).cue, check.degree === CRIT_SUCCESS ? 'critical' : check.degree === SUCCESS ? 'success' : null)
})

test('worthCue: a success or a critical success is cued, and a hero point\'s reroll only when it climbed to one', () => {
  const rec = newRecord(5)
  const seen = new Set<string>()
  // Every reroll the rules can make, of every degree but a critical success: cued exactly when it reached a success
  // above the first roll. A reroll that stayed a success pays nothing, so it is not cued again.
  for (let i = 0; i < 400; i++) {
    const first = attempt(rec, i % OPERATOR_SKILLS.length)
    assert.equal(worthCue(first), first.degree >= SUCCESS, 'a first roll: any success')
    if (first.degree === CRIT_SUCCESS) continue
    rec[AT.hero] = 1
    const second = reroll(rec, first)
    const climbed = second.degree >= SUCCESS && second.degree > first.degree
    assert.equal(worthCue(second), climbed, `${first.degree} then ${second.degree}`)
    seen.add(`${first.degree}>${second.degree}`)
  }
  assert.ok(seen.has('2>2'), 'a success that stayed one was tried')
  assert.ok([...seen].some((k) => k.endsWith('>2') && !k.startsWith('2')), 'and a miss that climbed to a success')
  assert.equal(worthCue(null), false)
})

/** The offline bridge with a progression and a few knobs that succeed. */
function bridge(p: Progress): TerminalBridge {
  return { ...offlineBridge(BRAND), rain: (a?: 'on' | 'off') => a ?? 'off', ghost: (a?: 'on' | 'off') => a ?? 'off', progress: progressBridge(p) }
}
const texts = (r: CommandResult) => r.lines.map((l) => l.text)

test('the console: a command that earns prints its check after its own lines; an error or a read earns nothing', () => {
  const { p } = keeper()
  const b = bridge(p)
  const r = run('rain on', b, [])
  assert.equal(texts(r)[0], 'rain on')
  assert.match(texts(r)[1], /^Optics and cinema: \d+ \+4 = \d+ vs DC 13, (critical failure|failure|success|critical success)/)
  assert.equal(p.last()?.skill, 6)
  const checks = p.record[AT.checks]
  assert.deepEqual(texts(run('rain', b, [])), ['rain off'], 'a status line earns nothing')
  assert.deepEqual(texts(run('rain on', b, [])), ['rain on'], 'optics rests')
  run('help', b, [])
  run('stats --once', b, [])
  assert.equal(p.record[AT.checks], checks)
  // An error earns nothing.
  const failing = { ...b, ghost: () => { throw new Error('no') } }
  assert.ok(run('ghost on', failing, []).lines.every((l) => l.kind === 'err'))
  assert.equal(p.record[AT.checks], checks)
  // NoirScript runs offline: computers.
  const noir = run('noir print(1 + 1);', b, [])
  assert.equal(texts(noir)[0], '2')
  assert.match(texts(noir)[1], /^Computers: /)
})

test('the console: a host without a progression is untouched by it, and `progress` says why', () => {
  const off = offlineBridge(BRAND)
  assert.deepEqual(texts(run('noir print(3);', off, [])), ['3'])
  assert.deepEqual(texts(run('progress', off, [])), ['progress: not available on this page'])
  assert.deepEqual(texts(run('progress', offlineBridge({ ...BRAND, track: 'tty' }), [])), ['progress: kept by the city: boot gui to see it'])
})

test('the console: `progress` and its forms', () => {
  const { p } = keeper()
  const b = bridge(p)
  const status = texts(run('progress', b, []))
  assert.match(status[0], /^level 1 · 0\/1000 XP · 150 credits · hero 1\/3 · resolve 6\/6 · actions ◆◆◆ ↺$/)
  assert.match(status[1], /STR \+1 {2}DEX \+1 {2}CON \+1 {2}INT \+1 {2}WIS \+1 {2}CHA \+1/)
  for (const name of OPERATOR_SKILLS) assert.ok(status.some((l) => l.trimStart().startsWith(name)), name)
  assert.ok(status.some((l) => /next check DC 13 \(easy\)/.test(l)))
  const table = texts(run('progress table', b, []))
  assert.equal(table.length, 1 + 20 + 5)
  assert.match(table[1], /^\s+1\s+13\s+150\s+1,750$/)
  assert.match(table[20], /^\s+20\s+38\s+400,000\s+4,900,000$/)
  assert.deepEqual(texts(run('progress train computers', b, [])), ['progress: no skill increase to spend: one comes with every level from 2'])
  p.record[AT.increases] = 1
  seal(p.record)
  assert.deepEqual(texts(run('progress train computers', b, [])), ['Computers is expert now (+6)'])
  assert.deepEqual(texts(run('progress train flying', b, [])), ["progress: no skill 'flying': computers, piloting, robotics, security, swarm, voice, optics, commerce"])
  assert.deepEqual(texts(run('progress reroll', b, [])), ['progress: no check to reroll yet'])
  assert.match(texts(run('progress reset', b, []))[0], /progress reset --yes starts a new operator/)
  assert.equal(p.record[AT.ranks], 2, 'not reset without --yes')
  assert.match(texts(run('progress reset --yes', b, []))[0], /^a new operator: level 1, 150 credits/)
  assert.equal(p.record[AT.ranks], 1)
  for (const bad of ['progress table x', 'progress train', 'progress train a b', 'progress reroll x', 'progress reset now', 'progress fly']) {
    assert.ok(run(bad, b, []).lines.every((l) => l.kind === 'err'), bad)
  }
})

test('the text: pips, grouping, every check line, the table; no upstream names, scrubbed words or conditioning talk', () => {
  const { p } = keeper()
  assert.equal(pips(p.record), '◆◆◆ ↺')
  p.earn(0)
  assert.equal(pips(p.record), '◆◆◇ ↺')
  assert.equal(grouped(4_900_000), '4,900,000')
  assert.equal(grouped(150), '150')
  const lines = [...statusLines(p), ...tableLines(), ...checkLines(p.last()!, 1)]
  for (let s = 0; s < 8; s++) lines.push(...checkLines({ ...p.last()!, skill: s, guarded: true, overdrive: true, reroll: s % 2 === 0, levels: [{ level: 5, increase: true, boosts: ['INT +2'] }] }, 1))
  // The HUD's words, for every skill and both degrees: no slash either, since the HUD's text never uses one.
  const hud: string[] = []
  for (let s = 0; s < 8; s++) {
    for (const degree of [SUCCESS, CRIT_SUCCESS]) {
      const h = hudProgress(p, { degree, skill: s, xp: 40, credits: 1500, hero: degree === CRIT_SUCCESS ? 1 : 0, at: 0 }, 0)
      hud.push(h.text, h.label, h.pips, h.cueText, h.delta)
    }
  }
  hud.push(...Object.values(hudProgress(p, null, 0)).filter((v): v is string => typeof v === 'string'))
  // Prepared: the chip's words, a check's line and `progress`'s; and every sentence the home card's Rest tab can say.
  const { p: q, t } = standing()
  q.restAtHome(2)
  const prepared = hudProgress(q, null, 0)
  hud.push(prepared.text, prepared.label)
  t.now += SKILL_REST_MS
  const rest = [...checkLines(q.earn('optics')!, 1), ...statusLines(q).filter((l) => /prepared|rest/.test(l)), ...tableLines().filter((l) => /rest/.test(l)), ...restSentences()]
  const { p: z } = keeper()
  z.restAtHome(0)
  rest.push(...statusLines(z).filter((l) => /rest/.test(l)))
  assert.ok(rest.some((l) => /\+2 prepared = /.test(l)) && rest.some((l) => /^ {2}prepared: /.test(l)) && rest.some((l) => /^ {2}rested at home: /.test(l)) && rest.some((l) => /^ {2}rest at a home you own/.test(l)))
  assert.doesNotMatch(hud.join('\n'), /\//, 'no slash in the HUD')
  assert.doesNotMatch([...rest, prepared.text, prepared.label].join('\n'), /!/, 'nothing exclaimed')
  assert.doesNotMatch([...rest, prepared.text, prepared.label].join('\n'), /\b(hurry|expir\w*|lose|losing|lost|streak|daily|come back|countdown|last chance|don'?t miss|status effect)\b/i, 'no urgency, nothing to come back for')
  lines.push(...hud, ...rest)
  const text = lines.join('\n')
  assert.doesNotMatch(text, /matrix|pathfinder|pf2e|paizo|golarion|pavlov|dopamine|addict|condition|jackpot|loot|gacha|slot machine|drop token/i)
  for (const file of ['./progress.ts', '../02_Define_The_Rules/progression.ts', '../05_Observe_Environment/progressStore.ts']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /\b(matrix|pathfinder|pf2e|paizo|pavlov\w*|dopamine|addict\w*)\b/i, file)
  }
})

// ---------------------------------------------------------------------------------------------------
// A rest at home

/** Every sentence the home card's Rest tab and its reason line can say, from each home and each state. */
function restSentences(): string[] {
  const out: string[] = []
  for (const hero of [1, 2, 3]) {
    for (const level of [1, 3, 6, 10, 14, 17, 20]) {
      for (const kinds of [0, 1, 2, 4, 9]) {
        const { p } = keeper()
        p.record[AT.hero] = hero
        seal(p.record)
        out.push(...restOffer(p, level, kinds).lines, restTake(p, level, kinds))
        // Running now: what each home says, and refuses with or takes in place of it.
        for (const [l2, k2] of [[1, 0], [3, 1], [10, 4], [20, 9]] as const) out.push(...restOffer(p, l2, k2).lines)
        out.push(restTake(p, 20, 9), ...restOffer(p, 20, 9).lines)
      }
    }
  }
  return [...new Set(out)]
}

test('a rest at home through the keeper: saved and told once, the round clock started again with the full round, refused while one lasts unless a home gives more; reset ends it', () => {
  const s = memory()
  const { p, t } = keeper(s)
  assert.ok(p.earn('computers'))
  assert.ok(p.earn('piloting', true))
  t.now = 2500
  assert.equal(p.round(), ROUND_MS - 2500)
  const told: (number | null)[] = []
  p.subscribe((c) => told.push(c ? c.skill : null))
  const writes = s.writes
  const hero = p.record[AT.hero]
  assert.equal(p.restAtHome(1), 1, 'one hero point')
  assert.deepEqual(told, [null], 'told once, with no check (so no cue)')
  assert.equal(s.writes, writes + 1, 'saved once')
  const saved = JSON.parse(s.map.get(PROGRESS_KEY)!) as { words: number[] }
  assert.equal(saved.words[40], 121)
  assert.equal(p.record[AT.hero], hero + 1)
  assert.equal(pips(p.record), '◆◆◆ ↺', 'the full round')
  assert.equal(p.round(), ROUND_MS, 'the round clock started again')
  // While it lasts: an equal or lower rest is refused, neither saved nor told.
  assert.throws(() => p.restAtHome(1), /a rest at home lasts 30 more checks, unless a home adds more/)
  assert.throws(() => p.restAtHome(0), /lasts 30 more checks/)
  assert.deepEqual([told.length, s.writes], [1, writes + 1])
  // A home that gives more takes its place.
  assert.equal(p.restAtHome(2), 1)
  assert.equal(p.record[AT.prepared], 122)
  assert.deepEqual(told, [null, null])
  // A new operator has no rest.
  p.reset()
  assert.equal(p.record[AT.prepared], 0)
  assert.equal(p.restAtHome(0), 1)
})

test('while prepared every check says so, progress says how much and for how many checks, the table states the rule, and the chip shows prepared +N until the last of the 30 checks', () => {
  const { p, t } = standing()
  const before = hudProgress(p, null, 0)
  assert.doesNotMatch(before.text + before.label, /prepared/)
  assert.equal(p.restAtHome(2), 1)
  const chip = hudProgress(p, null, 0)
  assert.notEqual(chip, before, 'rebuilt when the rest starts')
  assert.equal(chip.text, 'Level 3 · 420 of 1,000 XP · 1,250 credits · hero 3 · ◆◆◆ ↺ · prepared +2')
  assert.equal(chip.label, 'Level 3, 420 of 1,000 experience points, 1,250 credits, 3 hero points, 3 of 3 actions left this round, reaction ready, prepared: 2 added to every check')
  assert.equal(hudProgress(p, null, 50), chip, 'the same object while nothing changed')
  assert.ok(statusLines(p).includes('  prepared: +2 to every check for 30 more checks (a rest at home)'))
  for (let i = 0; i < REST_CHECKS; i++) {
    t.now += SKILL_REST_MS
    const c = p.earn(i % OPERATOR_SKILLS.length)
    assert.ok(c, `check ${i + 1}`)
    assert.equal(c.item, 2)
    assert.equal(c.total, c.natural + c.modifier)
    const mod = c.modifier - 2
    assert.ok(checkLines(c, p.record[AT.hero])[0].includes(` ${mod < 0 ? mod : `+${mod}`} +2 prepared = ${c.total} vs DC `), checkLines(c)[0])
    const left = REST_CHECKS - 1 - i
    if (left > 0) {
      assert.match(hudProgress(p, null, t.now).text, / · prepared \+2$/)
      assert.ok(statusLines(p).includes(`  prepared: +2 to every check for ${left} more check${left === 1 ? '' : 's'} (a rest at home)`), `${left} left`)
    }
    if (left === 1) {
      assert.equal(restOffer(p, 3, 1).lines[0], 'You are prepared: +2 to every check for 1 more check. Rest again after it, or in a home that adds more.')
      assert.equal(restOffer(p, 3, 1).why, 'a rest at home lasts 1 more check, unless a home adds more')
    }
  }
  const last = hudProgress(p, null, t.now)
  assert.doesNotMatch(last.text + last.label, /prepared/, 'the word drops off the chip, nothing announced')
  assert.ok(!statusLines(p).some((l) => /prepared|rested at home/.test(l)))
  t.now += SKILL_REST_MS
  const after = p.earn('optics')!
  assert.equal(after.item, 0)
  assert.doesNotMatch(checkLines(after)[0], /prepared/)
  // The table states the rule.
  assert.ok(tableLines().includes("  rest at a home you own (its card's Rest tab): a hero point, a new round, and on the next 30 checks the lower of the home's bonus (+1 from a level 3 deed, +2 from 9, +3 from 17) and its comfort's (+1 from 1 kind of furniture standing there, +2 from 3, +3 from 5)"))
  // A +0 rest says so in `progress`, and nothing on the chip.
  const { p: z } = keeper()
  const plain = hudProgress(z, null, 0)
  assert.equal(z.restAtHome(0), 1)
  assert.ok(statusLines(z).includes('  rested at home: another rest after 30 more checks, or in a home that adds to checks'))
  const zchip = hudProgress(z, null, 0)
  assert.notEqual(zchip, plain)
  assert.doesNotMatch(zchip.text + zchip.label, /prepared/)
})

test('a rest at home survives a reload: the word is saved, a new session leaves it, the next check still carries it', () => {
  const s = memory()
  const t = { now: 0 }
  const a = createProgress({ store: s, seed: () => 5, now: () => t.now })
  a.restAtHome(1)
  t.now += SKILL_REST_MS
  assert.equal(a.earn('optics')!.item, 1)
  assert.equal(a.record[AT.prepared], (29 << 2) | 1)
  const b = createProgress({ store: s, now: () => 0 })
  assert.equal(b.setAside(), null)
  assert.equal(b.record[AT.prepared], (29 << 2) | 1, 'a new session leaves it')
  assert.throws(() => b.restAtHome(1), /lasts 29 more checks/, 'and the gate holds')
  assert.match(statusLines(b).join('\n'), /prepared: \+1 to every check for 29 more checks/)
  const c = b.earn('optics')!
  assert.equal(c.item, 1)
  assert.equal(b.record[AT.prepared], (28 << 2) | 1)
  assert.match(hudProgress(b, null, 0).text, / · prepared \+1$/)
})

test('restOffer and restTake: the words for each home and each state, from the numbers alone', () => {
  const COMFORT = 'Furniture adds +1 from 1 kind, +2 from 3 and +3 from 5'
  const fresh = (hero = 1) => {
    const { p } = keeper()
    p.record[AT.hero] = hero
    seal(p.record)
    return p
  }
  // The Micro-Loft (a level 1 deed): a hero point and a round, no bonus, and no comfort line.
  const p = fresh()
  for (const kinds of [0, 1, 4, 9]) {
    assert.deepEqual(restOffer(p, 1, kinds), { bonus: 0, why: null, lines: ['Rest here: a hero point and a new round. A home adds to checks from a level 3 deed.'] })
  }
  assert.deepEqual(restOffer(p, 3, 1).lines, ['Rest here: a hero point, a new round, and +1 to every check for the next 30 checks.', `Comfort: 1 kind of furniture stands here. ${COMFORT}; this home allows up to +1.`])
  assert.deepEqual(restOffer(p, 3, 0).lines, ['Rest here: a hero point and a new round. No bonus on checks yet: furniture standing here adds one.', `Comfort: no furniture stands here yet. ${COMFORT}; this home allows up to +1.`])
  assert.deepEqual(restOffer(p, 10, 4).lines, ['Rest here: a hero point, a new round, and +2 to every check for the next 30 checks.', `Comfort: 4 kinds of furniture stand here. ${COMFORT}; this home allows up to +2.`])
  assert.deepEqual(restOffer(p, 10, 1).lines[0], 'Rest here: a hero point, a new round, and +1 to every check for the next 30 checks.')
  assert.deepEqual(restOffer(p, 20, 9).lines, ['Rest here: a hero point, a new round, and +3 to every check for the next 30 checks.', `Comfort: 9 kinds of furniture stand here. ${COMFORT}; this home allows up to +3.`])
  assert.deepEqual([restOffer(p, 20, 4).bonus, restOffer(p, 20, 9).bonus, restOffer(p, 10, 9).bonus], [2, 3, 2])
  // Hero points full: no hero point offered, and the card says why.
  const full = fresh(HERO_MAX)
  assert.equal(restOffer(full, 10, 4).lines[0], 'Rest here: a new round, and +2 to every check for the next 30 checks. Your hero points are full (3 of 3).')
  assert.equal(restOffer(full, 1, 0).lines[0], 'Rest here: a new round. A home adds to checks from a level 3 deed. Your hero points are full (3 of 3).')
  assert.equal(restOffer(full, 10, 0).lines[0], 'Rest here: a new round. No bonus on checks yet: furniture standing here adds one. Your hero points are full (3 of 3).')
  assert.equal(restTake(full, 10, 4), 'Rested: a new round, and +2 to every check for the next 30 checks (hero points already 3 of 3).')
  assert.equal(restTake(fresh(HERO_MAX), 1, 0), 'Rested: a new round (hero points already 3 of 3).')
  // Rest, then the running states: refused where a home gives no more (nothing changes), taken in place where it gives more.
  assert.equal(restTake(p, 10, 4), 'Rested: hero 2 of 3, a new round, and +2 to every check for the next 30 checks.')
  const running = 'You are prepared: +2 to every check for 30 more checks. Rest again after them, or in a home that adds more.'
  for (const [level, kinds] of [[1, 0], [3, 1], [10, 4], [20, 4]] as const) {
    const o = restOffer(p, level, kinds)
    assert.equal(o.lines[0], running, `level ${level}, ${kinds} kinds`)
    assert.equal(o.why, 'a rest at home lasts 30 more checks, unless a home adds more')
    assert.equal(restTake(p, level, kinds), running)
  }
  assert.deepEqual([p.record[AT.hero], p.record[AT.prepared]], [2, 122], 'a refused rest changes nothing')
  assert.equal(restOffer(p, 20, 9).lines[0], 'Rest here: a hero point, a new round, and +3 to every check for the next 30 checks, in place of your +2.')
  assert.equal(restTake(p, 20, 9), 'Rested: hero 3 of 3, a new round, and +3 to every check for the next 30 checks.')
  assert.equal(restOffer(p, 20, 9).lines[0], 'You are prepared: +3 to every check for 30 more checks. Rest again after them, or in a home that adds more.')
  // A +0 rest: then a second waits, but a home that adds to checks may.
  const z = fresh()
  assert.equal(restTake(z, 1, 4), 'Rested: hero 2 of 3 and a new round.')
  assert.equal(restOffer(z, 1, 4).lines[0], 'You have rested: rest again after 30 more checks, or in a home that adds to checks.')
  assert.equal(restOffer(z, 10, 0).lines[0], 'You have rested: rest again after 30 more checks, or in a home that adds to checks.')
  assert.equal(restTake(z, 1, 4), 'You have rested: rest again after 30 more checks, or in a home that adds to checks.')
  assert.equal(z.record[AT.hero], 2, 'no hero point on demand')
  assert.equal(restOffer(z, 3, 1).lines[0], 'Rest here: a hero point, a new round, and +1 to every check for the next 30 checks.')
  assert.equal(restTake(z, 3, 1), 'Rested: hero 3 of 3, a new round, and +1 to every check for the next 30 checks.')
  // Every offer is frozen, and not computed in the card (the card shows these lines as they come).
  assert.ok(Object.isFrozen(restOffer(z, 3, 1)) && Object.isFrozen(restOffer(z, 3, 1).lines))
})
