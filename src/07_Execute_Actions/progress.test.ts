// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the page's keeper of the operator's progression and the console's side of it: a
 * round's three actions and reaction, a skill's minute of rest, the save after every change and the listeners told,
 * the reroll and the training through the keeper, the purchase gate saved in one write, a reset; which console
 * commands earn a check (doing something does, reading does not) and that a command with an error earns nothing; the
 * `progress` command's every form; and the text's rules (no upstream names, no scrubbed words, nothing about conditioning).
 * What breaks if it is removed? Reading `help` could earn credits, a failed command could pay, a purchase could go
 * unsaved, or the console's progress text could drift into words the product does not use.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { AT, OPERATOR_SKILLS, PURCHASE, ROUND_MS, SKILL_REST_MS, STARTING_CREDITS, newRecord, seal } from '../02_Define_The_Rules/progression.ts'
import { PROGRESS_KEY, saveProgress } from '../05_Observe_Environment/progressStore.ts'
import type { ProfileStore } from '../05_Observe_Environment/profile.ts'
import { checkLines, commandSkill, createProgress, grouped, pips, progressBridge, statusLines, tableLines, type Progress } from './progress.ts'
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
    ['act', ['ok'], 4], ['swarm', ['run fix the build'], 4], ['recruit', ['rust'], 4], ['recruit', ['rally', '12'], 4], ['ask', ['rust: why'], 4],
    ['ask', ['rust,go: why'], 4], ['ping', ['go'], 4],
    ['say', ['design: hello'], 5], ['sloane', ['say hello'], 5], ['recruit', ['listen'], 5],
    ['rain', ['on'], 6], ['ghost', ['off'], 6], ['time', ['21:00'], 6], ['xr', ['vr'], 6], ['record', ['start'], 6],
    ['look', ['preset', 'navy', 'suit'], 7], ['look', ['random'], 7],
  ]
  for (const [name, args, skill] of earns) assert.equal(commandSkill(name, args), skill, `${name} ${args.join(' ')}`)
  const reads: [string, string[]][] = [
    ['noir', []], ['noir', ['reset']], ['noir', ['words']], ['noir', ['asm 1']], ['r0', ['reset']], ['run', []],
    ['robot', []], ['harness', ['list']], ['act', []], ['act', ['log']], ['act', ['list']], ['act', ['no']], ['swarm', ['status']], ['swarm', ['plan x']],
    ['swarm', ['audit']], ['recruit', []], ['recruit', ['stop']], ['recruit', ['dismiss']], ['ask', []], ['ask', ['provider claude']],
    ['ask', ['connect claude http://127.0.0.1:1']], ['ask', ['server http://127.0.0.1:11434']], ['ping', []], ['ping', ['clear']],
    ['say', ['voice anna']], ['sloane', ['voices']], ['rain', []], ['ghost', []], ['time', []], ['xr', []], ['xr', ['off']],
    ['record', ['stop']], ['look', []], ['look', ['show']], ['help', []], ['stats', []], ['progress', []], ['progress', ['reroll']],
    ['goal', ['fix the build']], ['operator', ['unlock']], ['map', ['city']],
  ]
  for (const [name, args] of reads) assert.equal(commandSkill(name, args), -1, `${name} ${args.join(' ')}`)
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
  assert.equal(table.length, 1 + 20 + 4)
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
  const text = lines.join('\n')
  assert.doesNotMatch(text, /matrix|pathfinder|pf2e|paizo|golarion|pavlov|dopamine|addict|condition|jackpot|loot|gacha/i)
  for (const file of ['./progress.ts', '../02_Define_The_Rules/progression.ts', '../05_Observe_Environment/progressStore.ts']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /\b(matrix|pathfinder|pf2e|paizo|pavlov\w*|dopamine|addict\w*)\b/i, file)
  }
})
