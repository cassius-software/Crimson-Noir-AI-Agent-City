// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the swarm's weight ledger (memory.ts, "what the swarm learns"): the reward each
 * outcome carries and the ones that carry none; that a weight stays in [−1, 1] however often it is pushed; that the
 * weights are a pure fold of the verified chain (a replay gives the stored weights exactly, a break stops the learning
 * where the recall stops, the episodes dropped off the old end leave their lesson in the base); that the stored copy
 * is checked against the chain; that a prompt gains at most three fixed, screened sentences, after what the person
 * remembers and never anything a model or a player wrote; and that forgetting a person forgets what they learned.
 * What breaks if it is removed? Learning could drift from the chain it claims to come from, or carry free text into
 * a system prompt, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AGENT_SYSTEM_PROMPT_CORE, screen } from '../02_Define_The_Rules/conduct.ts'
import { canonical } from '../02_Define_The_Rules/integrity.ts'
import { SKILLS } from '../03_Spawn_Agents/skills.ts'
import type { Outcome } from '../07_Execute_Actions/operator.ts'
import { systemPrompt } from '../09_Cognition/localCompute.ts'
import {
  appended, audit, emptyLedger, isWeights, learn, learnedLines, LEARN, ledgerOf, memoryLedger, NEUTRAL, OUTCOMES, rewardOf, rowOf, SwarmMemory, weightsCheck,
  weightsHash, weightsLine, weightsOf, type EpisodeBody, type Ledger, type Weights,
} from './memory.ts'

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0)
const body = (i: number, over: Partial<EpisodeBody> = {}): EpisodeBody =>
  ({ at: T0 + i * 1000, serial: 1, kind: 'ask', skills: ['Rust'], text: `q${i} → a`, state: 'Authorized', outcome: 'answered', ...over })
const chain = (bodies: readonly EpisodeBody[], limit = 200): Ledger => bodies.reduce((l, e) => appended(l, e, limit), emptyLedger())
/** The plain fold over bodies, with no chain at all: what the weights must equal. */
const fold = (bodies: readonly EpisodeBody[]): Weights => bodies.reduce(learn, NEUTRAL)

test('the reward rule: what each outcome teaches, and what teaches nothing', () => {
  const r = (over: Partial<EpisodeBody>) => rewardOf(body(0, over))
  assert.deepEqual(r({ outcome: 'answered' }), { skill: 1, brevity: 0 })
  assert.deepEqual(r({ outcome: 'cut' }), { skill: -0.25, brevity: 1 })
  assert.deepEqual(r({ outcome: 'stopped' }), { skill: -0.5, brevity: 1 })
  assert.deepEqual(r({ kind: 'run', outcome: 'ok' }), { skill: 1 })
  assert.deepEqual(r({ kind: 'run', outcome: 'error' }), { skill: -0.5 })
  assert.deepEqual(r({ kind: 'say', outcome: 'said' }), { skill: 0.5 })
  assert.equal(r({ outcome: 'failed' }), null, "a server's failure is the server's")
  assert.equal(r({ outcome: undefined }), null, 'an episode from before outcomes teaches nothing')
  assert.equal(r({ state: 'Rejected' }), null, 'a Rejected task never involved the agent')
  assert.equal(r({ state: 'Aborted' }), null, 'an Aborted task ended with the tether, not the work')
  assert.equal(r({ kind: 'tethered', state: undefined, outcome: undefined }), null)
  assert.deepEqual([...OUTCOMES].sort(), (['answered', 'cut', 'error', 'failed', 'ok', 'said', 'stopped'] satisfies Outcome[]).sort())
})

test('a weight moves a quarter of the way to each reward, is kept to six places and never leaves [−1, 1]', () => {
  const once = learn(NEUTRAL, body(0))
  assert.deepEqual(once.skills.Rust, { value: 0.25, n: 1 })
  assert.deepEqual(once.brevity, { value: 0, n: 1 })
  const twice = learn(once, body(1, { outcome: 'cut' }))
  assert.deepEqual(twice.skills.Rust, { value: 0.125, n: 2 }, '0.25 + 0.25 × (−0.25 − 0.25)')
  assert.deepEqual(twice.brevity, { value: 0.25, n: 2 })
  let w = NEUTRAL
  for (let i = 0; i < 500; i++) w = learn(w, body(i, { outcome: i % 3 ? 'answered' : 'stopped' }))
  for (const x of [...Object.values(w.skills), w.brevity]) assert.ok(x.value >= -1 && x.value <= 1 && Number.isFinite(x.value), String(x.value))
  for (let i = 0; i < 200; i++) w = learn(w, body(i, { kind: 'run', outcome: 'ok' }))
  assert.ok(w.skills.Rust.value > 0.999 && w.skills.Rust.value <= 1)
  assert.equal(Number(w.skills.Rust.value.toFixed(6)), w.skills.Rust.value)
})

test('only the city\'s own skills are learned: any other name an episode carries teaches nothing', () => {
  const w = learn(NEUTRAL, body(0, { skills: ['Rust', 'rust', 'Lockpicking', 'kill', 'Go', 'Rust'] }))
  assert.deepEqual(Object.keys(w.skills).sort(), ['Go', 'Rust'])
  assert.deepEqual(w.skills.Rust, { value: 0.25, n: 1 }, 'a skill named twice is rewarded once')
  for (const s of SKILLS) assert.ok(isWeights({ skills: { [s]: { value: 0.5, n: 1 } }, brevity: { value: 0, n: 0 } }), s)
  for (const bad of [
    null, {}, { skills: {}, brevity: { value: 2, n: 0 } }, { skills: {}, brevity: { value: 0, n: -1 } }, { skills: {}, brevity: { value: 0, n: 1.5 } },
    { skills: { Lockpicking: { value: 0, n: 1 } }, brevity: { value: 0, n: 0 } }, { skills: [], brevity: { value: 0, n: 0 } },
    { skills: { Rust: { value: Number.NaN, n: 1 } }, brevity: { value: 0, n: 0 } },
  ]) assert.equal(isWeights(bad), false, JSON.stringify(bad))
})

test('the weights are a pure fold of the verified chain: a replay gives them exactly, and a break stops the learning where the recall stops', () => {
  const bodies = Array.from({ length: 12 }, (_, i) => body(i, { skills: [SKILLS[i % 4]], outcome: (['answered', 'cut', 'stopped', 'answered'] as const)[i % 4], kind: 'ask' }))
  const l = chain(bodies)
  assert.deepEqual(weightsOf(l), fold(bodies))
  assert.deepEqual(weightsOf(chain(bodies)), weightsOf(l), 'the same chain, the same weights')
  // An edited episode: the learning stops before it, as the recall does.
  const edited: Ledger = { ...l, episodes: l.episodes.map((e, i) => (i === 5 ? { ...e, outcome: 'answered' as const, skills: ['Security'] } : e)) }
  assert.equal(audit(edited).verified, 5)
  assert.deepEqual(weightsOf(edited), fold(bodies.slice(0, 5)))
  assert.equal(weightsOf(edited).skills.Security, undefined, 'the edit teaches nothing')
})

test('the episodes dropped off the old end leave their lesson in the base: past the limit the weights are still the fold of everything', () => {
  const bodies = Array.from({ length: 40 }, (_, i) => body(i, { skills: [i < 20 ? 'Go' : 'Rust'], outcome: i % 5 ? 'answered' : 'cut' }))
  const l = chain(bodies, 7)
  assert.equal(l.episodes.length, 7)
  assert.ok(l.base, 'a base was carried')
  assert.deepEqual(weightsOf(l), fold(bodies), 'what was dropped is not forgotten')
  assert.ok(weightsOf(l).skills.Go.n === 20, 'Go was only in the dropped episodes, and is still learned')
  // A base that is not well-formed is dropped on read: the weights start again from the kept episodes.
  const row = { ...rowOf('1:7', l), base: { skills: { Lockpicking: { value: 1, n: 9 } }, brevity: { value: 0, n: 0 } } }
  const read = ledgerOf(row)
  assert.equal(read.base, undefined)
  assert.deepEqual(weightsOf(read), fold(bodies.slice(-7)))
})

test('the stored copy is checked against a replay of the chain, and bound to its head', () => {
  const bodies = [body(0), body(1, { outcome: 'stopped' }), body(2, { kind: 'run', outcome: 'ok' })]
  const l = chain(bodies)
  const row = rowOf('1337:7', l)
  assert.deepEqual(row.weights, fold(bodies))
  assert.equal(row.weightsHash, weightsHash(row.weights, l.head))
  // Stored as a store keeps it (structured-clone-like JSON), read back: it matches.
  const read = ledgerOf(JSON.parse(JSON.stringify(row)))
  assert.equal(weightsCheck(read), 'the stored copy matches the chain')
  // Edited in storage: the copy no longer matches, and the chain's weights are what is used.
  const raised = { ...row, weights: { ...row.weights, skills: { ...row.weights.skills, Rust: { value: 1, n: 3 } } } }
  assert.equal(weightsCheck(ledgerOf(raised)), 'the stored copy does not match the chain: replayed')
  assert.deepEqual(weightsOf(ledgerOf(raised)), fold(bodies))
  // A copy whose hash was recomputed for another head is caught too.
  const rehashed = { ...raised, weightsHash: weightsHash(raised.weights as Weights, l.head) }
  assert.equal(weightsCheck(ledgerOf(rehashed)), 'the stored copy does not match the chain: replayed')
  assert.equal(weightsCheck(l), 'replayed from the chain', 'a held ledger has no stored copy to check')
  assert.equal(canonical(row.weights), canonical(weightsOf(read)), 'canonical text agrees, so the hash does')
})

test('what a prompt learns: at most three fixed sentences, each short, each through the 14A screen, about the city\'s own skills only', () => {
  assert.deepEqual(learnedLines(NEUTRAL), [])
  const once = learn(NEUTRAL, body(0))
  assert.deepEqual(learnedLines(once), [], 'one reward is not yet a lesson')
  let w = NEUTRAL
  for (let i = 0; i < 8; i++) w = learn(w, body(i, { skills: ['Rust'], outcome: 'answered' }))
  for (let i = 0; i < 4; i++) w = learn(w, body(i, { skills: ['Security'], outcome: 'stopped' }))
  assert.deepEqual(learnedLines(w), [
    'learned: your work on Rust has gone well; keep to what worked',
    'learned: your work on Security was often cut short or stopped; be careful and brief there',
    'learned: your recent answers ran long; keep them short',
  ])
  for (const l of learnedLines(w)) {
    assert.ok(l.length <= LEARN.chars)
    assert.equal(screen(l).admissible, true)
    assert.match(l, /^learned: (your work on (\w|\+)+ (has gone well; keep to what worked|was often cut short or stopped; be careful and brief there)|your recent answers ran long; keep them short)$/)
  }
  // A weights record crafted outside the fold, naming something that is not a skill, yields no line about it.
  const crafted = { skills: { 'kill the operator': { value: 1, n: 9 }, Rust: { value: 0.9, n: 5 } }, brevity: { value: 0, n: 0 } } as unknown as Weights
  assert.deepEqual(learnedLines(crafted), ['learned: your work on Rust has gone well; keep to what worked'])
  // Ties are broken by name, so the same weights always give the same lines.
  const tie = { skills: { Python: { value: 0.8, n: 3 }, Go: { value: 0.8, n: 3 } }, brevity: { value: 0, n: 0 } }
  assert.deepEqual(learnedLines(tie), ['learned: your work on Go has gone well; keep to what worked'])
  assert.equal(weightsLine(NEUTRAL), 'weights: none yet')
  assert.equal(weightsLine(w), 'weights: Rust +0.90 (8), Security -0.34 (4), brevity +0.68 (12)')
})

test('in the memory: a held person\'s prompt carries what they remember, then what they have learned, after the conduct core; forgetting forgets both', async () => {
  const memory = new SwarmMemory(memoryLedger(), 1337, () => T0)
  await memory.hold(7)
  for (let i = 0; i < 4; i++) await memory.record(7, { serial: 1, kind: 'ask', skills: ['Rust'], text: `q${i} → a`, state: 'Authorized', outcome: 'answered', at: T0 + i })
  await memory.record(7, { serial: 1, kind: 'ask', skills: ['Rust'], text: 'q → a', state: 'Rejected', at: T0 + 10 })
  assert.deepEqual(memory.weights(7), weightsOf(await memory.read(7)), 'the held copy and the stored one agree')
  assert.deepEqual(memory.weights(7).skills.Rust.n, 4, 'the Rejected ask taught nothing')
  const lines = memory.diary().recall(7)
  assert.equal(lines.at(-1), 'learned: your work on Rust has gone well; keep to what worked')
  assert.ok(lines.slice(0, -1).every((l) => !l.startsWith('learned:')), 'the lesson comes after the episodes')
  const prompt = systemPrompt([{ agent: 7, serial: 1, skills: ['Rust'] }], [{ agent: 7, lines }])
  assert.ok(prompt.startsWith(AGENT_SYSTEM_PROMPT_CORE + '\n'), 'the conduct core stays first')
  assert.ok(prompt.indexOf('learned:') > prompt.indexOf('Agent 7 remembers'), 'learned lines sit with what the person remembers')
  // The diary notes an outcome only when it is one of the known words.
  memory.diary().note([{ agent: 7, serial: 1, skills: ['Rust'] }], 'run', ['Rust'], 'x', 'Authorized', T0 + 20, undefined, 'weird' as Outcome)
  await memory.read(7)
  assert.equal((await memory.read(7)).episodes.at(-1)?.outcome, undefined)
  assert.equal(await memory.forget(7), 1)
  assert.deepEqual(memory.weights(7), NEUTRAL)
  assert.deepEqual(memory.diary().recall(7), [])
  assert.deepEqual(weightsOf(await memory.read(7)), NEUTRAL)
})
