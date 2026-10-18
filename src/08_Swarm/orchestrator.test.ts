// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the swarm orchestrator (orchestrator.ts) to its word over a fake gated ask: the
 * plan is deterministic and a DAG; steps run in order, one at a time, each prompt carrying the goal and the answers
 * before it; every guardrail refusal, gateway verdict, server failure and operator stop ends the run where it says and
 * is written to the audit chain, which verifies afterwards; and the orchestrator itself never reaches a script, a
 * file or the network (it imports no module that could).
 * What breaks if it is removed? A step could run out of order, past a refusal, or without a record.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { QUOTA } from '../02_Define_The_Rules/guardrails.ts'
import type { AskResult, GatedAsk, GateTether, Piece } from '../07_Execute_Actions/operator.ts'
import { screen } from '../02_Define_The_Rules/conduct.ts'
import { createSwarm, cutAtWord, HANDOFF_CHARS, order, planSwarm, ROLES, roleOf, stepPrompt, type SwarmEvent } from './orchestrator.ts'

const TETHER: GateTether = { agent: 7, serial: 1, skills: ['Design', 'TypeScript', 'Testing', 'Security', 'Writing'] }

/** A fake gated ask: answers as told, piece by piece, a tick later; notes every prompt; stop ends the answer early. */
function fakeAsk(script: (skills: readonly string[], prompt: string, n: number) => { kind: 'answer'; text: string; tokens?: number; done?: string; standIn?: string } | { kind: 'reject' } | { kind: 'abort' } | { kind: 'fail'; error: string } | { kind: 'disengaged' } | { kind: 'throw'; error: string }) {
  const asked: { skills: string[]; prompt: string }[] = []
  let n = 0
  const ask = (skills: readonly string[], prompt: string): GatedAsk & { stop(): void } => {
    asked.push({ skills: [...skills], prompt })
    const how = script(skills, prompt, n++)
    if (how.kind === 'throw') throw new Error(how.error)
    if (how.kind === 'reject') {
      const reason = `nobody tethered to the operator has ${skills.join(', ')}`
      return { state: 'Rejected', bound: [], follow: () => () => {}, result: Promise.resolve({ state: 'Rejected', text: '', thinking: 0, reason, ms: 0 }), stop: () => {} }
    }
    const followers = new Set<(p: Piece) => void>()
    let stopped = false
    const result = new Promise<AskResult>((resolve) => setTimeout(() => {
      if (stopped) return resolve({ state: 'Authorized', text: 'partial', thinking: 0, error: 'stopped by the operator', stopped: true, ms: 1 })
      if (how.kind === 'abort') return resolve({ state: 'Aborted', text: 'half an', thinking: 0, reason: 'agent 7 (Design): no longer tethered to the operator', ms: 2 })
      if (how.kind === 'fail') return resolve({ state: 'Authorized', text: '', thinking: 0, error: how.error, ms: 3 })
      if (how.kind === 'disengaged') return resolve({ state: 'Authorized', text: '', thinking: 0, done: 'disengaged', tokens: 0, ms: 4, disengaged: true })
      for (const word of how.text.split(/(?<= )/)) for (const fn of followers) fn({ kind: 'text', text: word })
      resolve({ state: 'Authorized', text: how.text, thinking: 0, done: how.done ?? 'stop', tokens: how.tokens ?? 5, ms: 5, promptHash: 'a'.repeat(64), ...(how.standIn !== undefined && { standIn: how.standIn }) })
    }, 0))
    return { state: 'Authorized', bound: [TETHER], follow: (fn) => { followers.add(fn); return () => { followers.delete(fn) } }, result, stop: () => { stopped = true } }
  }
  return { ask, asked }
}

const answering = (text = 'A plain answer. ') => fakeAsk(() => ({ kind: 'answer', text }))

test('the plan: the first N roles as a chain (a DAG), deterministic; a bad goal or count is refused before anything runs', () => {
  const p = planSwarm('  Name   the parts ', 3)
  assert.equal(p.goal, 'Name the parts')
  assert.deepEqual(p.steps.map((s) => [s.id, s.role, [...s.needs]]), [['architect', 'architect', []], ['coder', 'coder', ['architect']], ['tester', 'tester', ['architect', 'coder']]])
  assert.deepEqual(planSwarm('x'), planSwarm('x'))
  assert.equal(planSwarm('x').steps.length, ROLES.length)
  assert.deepEqual(ROLES.map((r) => r.id), ['architect', 'coder', 'tester', 'auditor', 'verifier'])
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.steps) && Object.isFrozen(ROLES) && Object.isFrozen(roleOf('coder')))
  assert.throws(() => planSwarm(''), /state the goal/)
  assert.throws(() => planSwarm('   '), /state the goal/)
  assert.throws(() => planSwarm('g'.repeat(QUOTA.goalChars + 1)), new RegExp(`${QUOTA.goalChars + 1} characters; at most ${QUOTA.goalChars}`))
  for (const n of [0, 6, 2.5, Number.NaN]) assert.throws(() => planSwarm('x', n), RangeError, String(n))
  assert.throws(() => planSwarm('x', 3, { ...QUOTA, agents: 2 }), /--agents takes 1 to 2/)
  // Left out, the count is every role the quota allows, not every role there is.
  assert.equal(planSwarm('x', undefined, { ...QUOTA, agents: 3 }).agents, 3)
  assert.equal(createSwarm({ ask: answering().ask, endpoint: () => null, quota: { ...QUOTA, agents: 2 } }).plan('x').agents, 2)
  assert.equal(planSwarm('x').agents, ROLES.length)
})

test('order: a topological order, ties by plan order; a cycle or an unknown need is refused', () => {
  assert.deepEqual(order(planSwarm('x').steps), ['architect', 'coder', 'tester', 'auditor', 'verifier'])
  assert.deepEqual(order([{ id: 'a', role: 'architect', needs: ['b'] }, { id: 'b', role: 'coder', needs: [] }]), ['b', 'a'])
  assert.deepEqual(order([{ id: 'a', role: 'architect', needs: [] }, { id: 'b', role: 'coder', needs: [] }, { id: 'c', role: 'tester', needs: ['a', 'b'] }]), ['a', 'b', 'c'])
  assert.throws(() => order([{ id: 'a', role: 'architect', needs: ['b'] }, { id: 'b', role: 'coder', needs: ['a'] }]), /cycle/)
  assert.throws(() => order([{ id: 'a', role: 'architect', needs: ['z'] }]), /unknown step 'z'/)
})

test('a step\'s prompt: the role\'s brief, the goal, then each needed answer under its role, long ones cut with a note', () => {
  const p = planSwarm('Name the parts', 2)
  assert.equal(stepPrompt(p, p.steps[0], new Map()), `${roleOf('architect').brief}\n\nGoal: Name the parts`)
  assert.equal(stepPrompt(p, p.steps[1], new Map([['architect', 'Three parts.\n']])), `${roleOf('coder').brief}\n\nGoal: Name the parts\n\nFrom the Prime Architect:\nThree parts.`)
  assert.equal(stepPrompt(p, p.steps[1], new Map()), `${roleOf('coder').brief}\n\nGoal: Name the parts\n\nFrom the Prime Architect:\n(no answer)`)
  const long = stepPrompt(p, p.steps[1], new Map([['architect', 'word '.repeat(1000)]]))
  assert.match(long, /From the Prime Architect:\n(word ){299}word\n\[cut: 1499 of 4999 characters shown\]$/)
  assert.ok(long.length <= QUOTA.promptChars)
  // One word longer than the room is dropped whole rather than cut through.
  assert.ok(stepPrompt(p, p.steps[1], new Map([['architect', 'w'.repeat(5000)]])).endsWith('From the Prime Architect:\n\n[cut: 0 of 5000 characters shown]'))
  assert.ok(stepPrompt(planSwarm('x'), planSwarm('x').steps[4], new Map()).length <= QUOTA.promptChars, 'an empty hand-off fits the quota')
})

test('cutAtWord: never through a word, so a cut cannot make a fragment the 14A screen refuses', () => {
  assert.equal(cutAtWord('short', 10), 'short')
  assert.equal(cutAtWord('the method works', 8), 'the', "'the meth' would have been the cut")
  assert.equal(screen('the meth').admissible, false, 'the fragment is one the screen refuses')
  assert.equal(cutAtWord('the method works', 10), 'the method', 'a cut on a boundary keeps the whole word')
  assert.equal(cutAtWord('the method works', 11), 'the method')
  assert.equal(cutAtWord('unbroken', 4), '')
  assert.equal(cutAtWord('a b', 0), '')
})

test('the hand-offs share the prompt quota: the last of five roles fits it whatever the four before it answered, and a short answer leaves its room to the long ones', () => {
  const plan = planSwarm('audit the fleet braking envelope')
  const verifier = plan.steps[4]
  // The review's case: four answers of 1,679 characters used to make a 6,478-character verifier prompt.
  const answer = 'The braking envelope holds at the posted limits. '.repeat(35).slice(0, 1679)
  const four = new Map(verifier.needs.map((id) => [id, answer]))
  const p = stepPrompt(plan, verifier, four)
  assert.ok(p.length <= QUOTA.promptChars, `${p.length} characters`)
  assert.equal(p.match(/\[cut: \d+ of 1679 characters shown\]/g)?.length, 4)
  assert.equal(screen(p).admissible, true)
  for (const n of [0, 900, 1500, 3000, QUOTA.answerChars]) {
    const each = new Map(verifier.needs.map((id) => [id, 'word '.repeat(Math.ceil(n / 5)).slice(0, n)]))
    assert.ok(stepPrompt(plan, verifier, each).length <= QUOTA.promptChars, `answers of ${n}`)
  }
  // A short answer is shown whole; the long ones share what it left, each up to HANDOFF_CHARS.
  const mixed = new Map<string, string>([['architect', 'Two parts.'], ['coder', 'code '.repeat(2000)], ['tester', 'test '.repeat(2000)], ['auditor', 'Nothing found.']])
  const q = stepPrompt(plan, verifier, mixed)
  assert.ok(q.includes('From the Prime Architect:\nTwo parts.\n') && q.endsWith(`From the ${roleOf('auditor').title}:\nNothing found.`))
  const shown = [...q.matchAll(/\[cut: (\d+) of 9999 characters shown\]/g)].map((m) => Number(m[1]))
  assert.equal(shown.length, 2)
  for (const n of shown) assert.ok(n > 1200 && n <= HANDOFF_CHARS, `${n} shown`)
  // A smaller quota is honoured the same way.
  assert.ok(stepPrompt(plan, verifier, four, { ...QUOTA, promptChars: 2500 }).length <= 2500)
})

test('a five-role run with long answers finishes: every step answered, the verifier included', async () => {
  const f = fakeAsk(() => ({ kind: 'answer', text: 'The braking envelope holds at the posted limits. '.repeat(40) }))
  const s = createSwarm({ ask: f.ask, endpoint: () => 'http://localhost:11434' })
  const r = await s.run('audit the fleet braking envelope').result
  assert.deepEqual(r.steps.map((st) => st.state), ['answered', 'answered', 'answered', 'answered', 'answered'])
  assert.equal(r.ok, true)
  for (const a of f.asked) assert.ok(a.prompt.length <= QUOTA.promptChars)
})

test('a run: every step in order, one at a time, each prompt carrying the goal and what came before; pieces stream; the report and the chain agree', async () => {
  const { ask, asked } = answering()
  const s = createSwarm({ ask, endpoint: () => 'http://localhost:11434', now: (() => { let t = 1000; return () => (t += 10) })() })
  const events: string[] = []
  const run = s.run('Name the parts of the kernel', 3)
  run.follow((ev: SwarmEvent) => events.push(ev.kind === 'piece' ? `piece ${ev.step}:${ev.piece.text}` : ev.kind === 'step' ? `step ${ev.step.id} ${ev.step.state}` : `end ok=${ev.report.ok}`))
  assert.equal(asked.length, 0, 'nothing is asked until the run starts, a moment later')
  assert.match(JSON.stringify(s.status()), /"running":true,"goal":"Name the parts of the kernel","step":null,"done":0,"total":3/)
  const report = await run.result
  assert.deepEqual(asked.map((a) => a.skills), [['Design'], ['TypeScript'], ['Testing']])
  assert.ok(asked[0].prompt.startsWith(roleOf('architect').brief), 'the brief opens the prompt')
  assert.ok(asked[1].prompt.includes('From the Prime Architect:\nA plain answer.'), 'the coder reads the architect')
  assert.ok(asked[2].prompt.includes('From the Prime Architect:') && asked[2].prompt.includes('From the Systems Coder:'), 'the tester reads both')
  assert.deepEqual(events, [
    'piece architect:A ', 'piece architect:plain ', 'piece architect:answer. ', 'step architect answered',
    'piece coder:A ', 'piece coder:plain ', 'piece coder:answer. ', 'step coder answered',
    'piece tester:A ', 'piece tester:plain ', 'piece tester:answer. ', 'step tester answered',
    'end ok=true',
  ])
  assert.equal(report.ok, true)
  assert.equal(report.stopped, false)
  assert.deepEqual(report.steps.map((st) => [st.id, st.state, st.text, st.tokens, st.promptHash]), [['architect', 'answered', 'A plain answer. ', 5, 'a'.repeat(64)], ['coder', 'answered', 'A plain answer. ', 5, 'a'.repeat(64)], ['tester', 'answered', 'A plain answer. ', 5, 'a'.repeat(64)]])
  assert.equal(report.head, s.verify().ok ? (s.verify() as { head: string }).head : '')
  // The chain: plan, (step, answer) three times, end; the answer entries carry the model's prompt hash and the answer's hash.
  const audit = s.audit()
  assert.deepEqual(audit.map((e) => `${e.kind}:${e.step}`), ['plan:', 'step:architect', 'answer:architect', 'step:coder', 'answer:coder', 'step:tester', 'answer:tester', 'end:'])
  assert.ok(audit.every((e, i) => e.at > 1000 && (i === 0 || e.at > audit[i - 1].at)), 'stamped by the clock handed in, in order')
  assert.equal(audit[2].promptHash, 'a'.repeat(64))
  assert.equal(audit[2].outputHash, audit[4].outputHash, 'the same answer hashes the same')
  assert.notEqual(audit[1].inputHash, audit[3].inputHash, 'different prompts')
  assert.equal(audit[0].note, '3 roles: architect → coder → tester')
  assert.equal(audit[7].note, 'every step answered; 15 tokens')
  assert.deepEqual(s.verify(), { ok: true, length: 8, head: report.head })
  assert.deepEqual(s.status(), { running: false, goal: null, step: null, done: 0, total: 0, stopped: false, spent: { steps: 0, tokens: 0 }, audit: 8, head: report.head })
  assert.equal(s.stop(), 'no swarm is running')
})

test('one run at a time; the run after it starts a new section of the same chain', async () => {
  const s = createSwarm({ ask: answering().ask, endpoint: () => null })
  const first = s.run('one', 1)
  assert.throws(() => s.run('two', 1), /a swarm is still running/)
  await first.result
  const second = await s.run('two', 1).result
  assert.equal(second.ok, true)
  assert.equal(s.audit().length, 8, 'plan, step, answer, end, twice')
  assert.equal(s.verify().ok, true)
})

test('refusals end the run where they happen and are written to the chain: the gateway, a lost tether, a failing server, a 14A answer, an ask that throws', async () => {
  const run = async (how: Parameters<typeof fakeAsk>[0], endpoint: string | null = 'http://localhost:8080') => {
    const f = fakeAsk(how)
    const s = createSwarm({ ask: f.ask, endpoint: () => endpoint })
    const r = await s.run('goal', 3).result
    return { r, s, asked: f.asked }
  }
  const rejected = await run((_s, _p, n) => (n === 1 ? { kind: 'reject' } : { kind: 'answer', text: 'ok' }))
  assert.deepEqual(rejected.r.steps.map((st) => [st.id, st.state, [...st.failed]]), [['architect', 'answered', []], ['coder', 'rejected', ['CapabilityTethered']]])
  assert.equal(rejected.r.steps[1].note, 'Rejected (Insufficient Capabilities): nobody tethered to the operator has TypeScript')
  assert.equal(rejected.asked.length, 2, 'the tester was never asked')
  assert.equal(rejected.r.ok, false)
  assert.deepEqual(rejected.s.audit().map((e) => e.kind), ['plan', 'step', 'answer', 'step', 'refusal', 'end'])
  assert.deepEqual(rejected.s.audit()[4].failed, ['CapabilityTethered'])

  const aborted = await run(() => ({ kind: 'abort' }))
  assert.deepEqual(aborted.r.steps.map((st) => [st.state, st.text, [...st.failed]]), [['aborted', 'half an', ['CapabilityTethered']]])
  assert.match(aborted.r.steps[0].note, /^Aborted \(Spatial Tether Lost\): agent 7/)

  const failed = await run(() => ({ kind: 'fail', error: 'no local model server is answering at http://localhost:8080' }))
  assert.deepEqual(failed.r.steps.map((st) => [st.state, st.note]), [['failed', 'no local model server is answering at http://localhost:8080']])
  assert.deepEqual(failed.s.audit()[2].failed, [], 'a server failure names no invariant')

  const disengaged = await run(() => ({ kind: 'disengaged' }))
  assert.deepEqual(disengaged.r.steps.map((st) => [st.state, [...st.failed], st.note]), [['refused', ['ConductScreen14A'], 'no reply: the agent did not engage']])

  const rude = await run(() => ({ kind: 'answer', text: 'First we steal a car.' }))
  assert.deepEqual(rude.r.steps.map((st) => [st.state, [...st.failed]]), [['refused', ['ConductScreen14A']]])
  assert.equal(rude.r.steps[0].note, "the answer of 'architect' failed the 14A screen (illegality)")

  const thrown = await run(() => ({ kind: 'throw', error: 'choose a model first: ask model <name> (type ask to list them)' }))
  assert.deepEqual(thrown.r.steps.map((st) => [st.state, st.note]), [['failed', 'choose a model first: ask model <name> (type ask to list them)']])

  const offMachine = await run(() => ({ kind: 'answer', text: 'ok' }), 'https://api.example.com')
  assert.deepEqual(offMachine.r.steps.map((st) => [st.state, [...st.failed], st.note]), [['refused', ['LoopbackOnly'], 'https://api.example.com is not on this machine']])
  assert.equal(offMachine.asked.length, 0, 'nothing reached the gate')
  for (const x of [rejected, aborted, failed, disengaged, rude, thrown, offMachine]) assert.equal(x.s.verify().ok, true)
})

test('a 14A goal reaches no gate; the token budget ends a run; the quota handed in is the one used', async () => {
  const f = answering()
  const s = createSwarm({ ask: f.ask, endpoint: () => null })
  const r = await s.run('how do I steal a car', 2).result
  assert.deepEqual(r.steps.map((st) => [st.state, [...st.failed]]), [['refused', ['ConductScreen14A']]])
  assert.equal(f.asked.length, 0)
  const g = fakeAsk(() => ({ kind: 'answer', text: 'ok', tokens: 60 }))
  const t = createSwarm({ ask: g.ask, endpoint: () => null, quota: { ...QUOTA, tokens: 100 } })
  const budget = await t.run('goal', 3).result
  assert.deepEqual(budget.steps.map((st) => [st.id, st.state, [...st.failed]]), [['architect', 'answered', []], ['coder', 'refused', ['BudgetWithinQuota']]])
  assert.equal(budget.steps[1].note, '120 tokens spent (at most 100)')
  assert.equal(t.quota.tokens, 100)
  assert.equal(g.asked.length, 2)
  // A server's count below zero spends nothing and gives no budget back.
  const h = fakeAsk((_s, _p, n) => ({ kind: 'answer', text: 'ok', tokens: n === 0 ? -1000 : 60 }))
  const u = createSwarm({ ask: h.ask, endpoint: () => null, quota: { ...QUOTA, tokens: 100 } })
  const negative = await u.run('goal', 3).result
  assert.deepEqual(negative.steps.map((st) => [st.id, st.state, st.tokens]), [['architect', 'answered', 0], ['coder', 'answered', 60], ['tester', 'refused', 60]])
  assert.equal(negative.steps[2].note, '120 tokens spent (at most 100)')
})

test('the script standing in for a server (or a model in this page) that did not answer ends the run; the scripted provider chosen on purpose does not', async () => {
  const canned = () => ({ kind: 'answer' as const, text: 'You ask about the goal.', done: 'scripted', tokens: 0 })
  const f = fakeAsk(canned)
  const s = createSwarm({ ask: f.ask, endpoint: () => 'http://localhost:11434' })
  const r = await s.run('goal', 3).result
  assert.deepEqual(r.steps.map((st) => [st.id, st.state, st.note]), [['architect', 'failed', 'no backend was answering at http://localhost:11434: the script stood in, so the run stops here']])
  assert.equal(r.ok, false)
  assert.equal(f.asked.length, 1)
  assert.deepEqual(s.audit().map((e) => e.kind), ['plan', 'step', 'refusal', 'end'])
  // The script says why no model answered (the auto provider looked at several servers): the note gives that reason.
  const why = fakeAsk(() => ({ ...canned(), standIn: 'no model is answering on this machine (looked for ollama at http://localhost:11434, llamacpp at http://localhost:8080)' }))
  const looked = await createSwarm({ ask: why.ask, endpoint: () => 'http://localhost:11434' }).run('goal', 3).result
  assert.deepEqual(looked.steps.map((st) => st.note), ['no model answered, so the script stood in and the run stops here: no model is answering on this machine (looked for ollama at http://localhost:11434, llamacpp at http://localhost:8080)'])
  const g = fakeAsk(canned)
  const chosen = await createSwarm({ ask: g.ask, endpoint: () => null }).run('goal', 3).result
  assert.deepEqual(chosen.steps.map((st) => st.state), ['answered', 'answered', 'answered'])
  assert.match(chosen.steps[0].note, /\(scripted: the chosen provider is the script\)$/)
  // A model running in this page has no endpoint either, but when it cannot run the script stands in and says why:
  // that is a failure to answer, not the script chosen on purpose, so the run stops there.
  const page = fakeAsk(() => ({ ...canned(), standIn: 'this browser cannot run a model in this page (no JSPI)' }))
  const s2 = createSwarm({ ask: page.ask, endpoint: () => null })
  const stood = await s2.run('goal', 3).result
  assert.deepEqual(stood.steps.map((st) => [st.id, st.state, st.note]), [['architect', 'failed', 'no model answered, so the script stood in and the run stops here: this browser cannot run a model in this page (no JSPI)']])
  assert.equal(stood.ok, false)
  assert.equal(page.asked.length, 1)
  assert.deepEqual(s2.audit().map((e) => e.kind), ['plan', 'step', 'refusal', 'end'])
})

test('stop: before the first step it refuses the step as HumanOverrideSupreme; mid-answer it stops the ask and ends the run; what came before is kept', async () => {
  const f = answering()
  const s = createSwarm({ ask: f.ask, endpoint: () => null })
  const early = s.run('goal', 2)
  assert.equal(s.stop(), 'stopping at the next step')
  assert.equal(s.stop(), 'already stopping')
  const r1 = await early.result
  assert.deepEqual(r1.steps.map((st) => [st.id, st.state, [...st.failed], st.note]), [['architect', 'stopped', ['HumanOverrideSupreme'], 'the operator stopped the run']])
  assert.equal(r1.stopped, true)
  assert.equal(f.asked.length, 0)
  assert.deepEqual(s.audit().map((e) => e.kind), ['plan', 'stop', 'end'])
  const late = s.run('goal', 3)
  await new Promise((fin) => setTimeout(fin, 0))
  assert.equal(s.status().step, 'architect')
  assert.equal(s.stop(), 'stopping at architect')
  const r2 = await late.result
  assert.deepEqual(r2.steps.map((st) => [st.id, st.state, st.text, [...st.failed], st.note]), [['architect', 'stopped', 'partial', ['HumanOverrideSupreme'], 'stopped by the operator']])
  assert.equal(f.asked.length, 1)
  assert.equal(s.verify().ok, true)
})

test('air gap: the orchestrator imports only the rules, the integrity hash and types; no script runner, no fetch, no storage', () => {
  const src = readFileSync(new URL('./orchestrator.ts', import.meta.url), 'utf8')
  const imports = [...src.matchAll(/^\s*import\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?'([^']+)'/gm)].map(([, t, spec]) => `${t ? 'type ' : ''}${spec}`)
  assert.deepEqual(imports.sort(), ['../02_Define_The_Rules/guardrails.ts', '../02_Define_The_Rules/integrity.ts', 'type ../07_Execute_Actions/operator.ts'])
  assert.doesNotMatch(src, /\bfetch\b|\bWebSocket\b|localStorage|indexedDB|\bexec\(|\bimport\s*\(|new Function|\beval\b/)
})
