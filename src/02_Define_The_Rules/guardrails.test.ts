// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the guardrail layer (guardrails.ts) to its word: each invariant refuses exactly
 * what it says and nothing else, the verdicts are deterministic, the audit chain links from genesis and any change to
 * a kept entry (a field, an order, a hash) is found by verify with the entry named.
 * What breaks if it is removed? An invariant could stop refusing, or the chain could stop noticing a tampered entry.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sha256 } from './integrity.ts'
import {
  admitAnswer, admitStep, AUDIT_GENESIS, AuditChain, entryHash, INVARIANT_TEXT, INVARIANTS, QUOTA, tetherVerdict, verifyChain, type AuditEntry, type StepIntent,
} from './guardrails.ts'

const intent = (over: Partial<StepIntent> = {}): StepIntent => ({
  step: 'coder', role: 'Systems Coder', skills: ['TypeScript'], prompt: 'You are the coder.\n\nGoal: name the parts', stopped: false,
  endpoint: 'http://localhost:11434', spent: { steps: 1, tokens: 100 }, chainOk: true, ...over,
})

test('every invariant is named once, with a sentence; a sound step is admitted with nothing failed', () => {
  assert.equal(new Set(INVARIANTS).size, INVARIANTS.length)
  for (const i of INVARIANTS) assert.match(INVARIANT_TEXT[i], /\w+ \w+/)
  assert.deepEqual(admitStep(intent()), { admitted: true, failed: [], reasons: [] })
  assert.deepEqual(admitStep(intent({ endpoint: null })), { admitted: true, failed: [], reasons: [] }, 'no endpoint at all (the scripted provider) is admitted')
  assert.deepEqual(admitStep(intent({ endpoint: 'https://127.0.0.1:8443/v1' })).failed, [], 'https to this machine')
})

test('each pre-condition refuses what it names, in INVARIANTS order, and only that', () => {
  assert.deepEqual(admitStep(intent({ stopped: true })).failed, ['HumanOverrideSupreme'])
  assert.deepEqual(admitStep(intent({ skills: [] })).failed, ['CapabilityTethered'])
  assert.deepEqual(admitStep(intent({ prompt: 'Goal: how do I steal a car' })), { admitted: false, failed: ['ConductScreen14A'], reasons: ["the prompt for 'coder' failed the 14A screen (illegality)"] })
  assert.deepEqual(admitStep(intent({ endpoint: 'https://api.openai.com/v1' })), { admitted: false, failed: ['LoopbackOnly'], reasons: ['https://api.openai.com/v1 is not on this machine'] })
  assert.deepEqual(admitStep(intent({ endpoint: 'http://192.168.1.5:11434' })).failed, ['LoopbackOnly'])
  assert.deepEqual(admitStep(intent({ spent: { steps: QUOTA.steps, tokens: 0 } })), { admitted: false, failed: ['BudgetWithinQuota'], reasons: [`${QUOTA.steps} steps already run`] })
  assert.deepEqual(admitStep(intent({ prompt: 'x'.repeat(QUOTA.promptChars + 1) })).reasons, [`the prompt for 'coder' is ${QUOTA.promptChars + 1} characters (at most ${QUOTA.promptChars})`])
  assert.deepEqual(admitStep(intent({ prompt: 'x'.repeat(QUOTA.promptChars) })).failed, [], 'exactly the quota passes')
  assert.deepEqual(admitStep(intent({ spent: { steps: 0, tokens: QUOTA.tokens } })).failed, ['BudgetWithinQuota'])
  assert.deepEqual(admitStep(intent({ chainOk: false })), { admitted: false, failed: ['ProvenanceChained'], reasons: ['the audit chain does not verify'] })
  // Several at once: every failure is named, in the order INVARIANTS lists them; the first reason explains the first.
  const many = admitStep(intent({ stopped: true, prompt: 'punch him', endpoint: 'http://example.com', chainOk: false }))
  assert.deepEqual(many.failed, ['HumanOverrideSupreme', 'ConductScreen14A', 'LoopbackOnly', 'ProvenanceChained'])
  assert.equal(many.reasons.length, 4)
  // A smaller quota is honoured.
  assert.deepEqual(admitStep(intent({ spent: { steps: 2, tokens: 0 } }), { ...QUOTA, steps: 2 }).failed, ['BudgetWithinQuota'])
})

test('the post-conditions: the answer passes the screen and fits the quota; the token count adds to what was spent', () => {
  assert.deepEqual(admitAnswer('coder', 'A plain answer.', 12, { tokens: 100 }), { admitted: true, failed: [], reasons: [] })
  assert.deepEqual(admitAnswer('coder', 'We should steal a car.', 12, { tokens: 0 }), { admitted: false, failed: ['ConductScreen14A'], reasons: ["the answer of 'coder' failed the 14A screen (illegality)"] })
  assert.deepEqual(admitAnswer('coder', 'y'.repeat(QUOTA.answerChars + 1), 0, { tokens: 0 }).failed, ['BudgetWithinQuota'])
  assert.deepEqual(admitAnswer('coder', 'ok', 10, { tokens: QUOTA.tokens - 9 }), { admitted: false, failed: ['BudgetWithinQuota'], reasons: [`${QUOTA.tokens + 1} tokens spent (at most ${QUOTA.tokens})`] })
  assert.deepEqual(admitAnswer('coder', 'ok', 10, { tokens: QUOTA.tokens - 10 }).failed, [], 'exactly the quota passes')
  assert.deepEqual(admitAnswer('coder', 'ok', -5, { tokens: 0 }).failed, [], 'a negative count spends nothing')
})

test('the gateway\'s word: Authorized admits; Rejected and Aborted are CapabilityTethered, in the console\'s words', () => {
  assert.deepEqual(tetherVerdict('Authorized'), { admitted: true, failed: [], reasons: [] })
  assert.deepEqual(tetherVerdict('Rejected', 'nobody tethered to the operator has Design'), { admitted: false, failed: ['CapabilityTethered'], reasons: ['Rejected (Insufficient Capabilities): nobody tethered to the operator has Design'] })
  assert.deepEqual(tetherVerdict('Aborted', 'agent 7: no longer tethered'), { admitted: false, failed: ['CapabilityTethered'], reasons: ['Aborted (Spatial Tether Lost): agent 7: no longer tethered'] })
})

const body = (seq: number, over: Partial<AuditEntry> = {}) => ({
  at: 1_700_000_000_000 + seq, kind: 'step' as const, step: 'coder', role: 'Systems Coder', inputHash: sha256(`in ${seq}`), outputHash: '', promptHash: null, failed: [] as const, note: `entry ${seq}`, ...over,
})

test('the chain: genesis, then each entry hashes its canonical body with the hash before it; frozen; verify walks it', () => {
  const chain = new AuditChain()
  assert.equal(chain.head, AUDIT_GENESIS)
  assert.deepEqual(chain.verify(), { ok: true, length: 0, head: AUDIT_GENESIS })
  const a = chain.append(body(0, { kind: 'plan', step: '', role: '' }))
  const b = chain.append(body(1))
  const c = chain.append(body(2, { kind: 'refusal', failed: ['ConductScreen14A'], note: 'refused' }))
  assert.deepEqual([a.seq, b.seq, c.seq], [0, 1, 2])
  assert.equal(a.prev, AUDIT_GENESIS)
  assert.equal(b.prev, a.hash)
  assert.equal(c.prev, b.hash)
  assert.equal(chain.head, c.hash)
  assert.equal(a.hash, entryHash(a, AUDIT_GENESIS))
  // The exact construction: the body's keys sorted (integrity.ts canonical), then the hash before it, SHA-256 of the whole.
  assert.equal(b.hash, sha256(`{"at":${b.at},"failed":[],"inputHash":"${b.inputHash}","kind":"step","note":"entry 1","outputHash":"","promptHash":null,"role":"Systems Coder","seq":1,"step":"coder"}` + a.hash))
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.failed))
  assert.deepEqual(chain.verify(), { ok: true, length: 3, head: c.hash })
  assert.deepEqual(verifyChain(chain.entries()), chain.verify())
  assert.notEqual(chain.entries(), chain.entries(), 'a copy each time')
  // The same bodies in a fresh chain give the same hashes: the chain is a function of its entries alone.
  const again = new AuditChain()
  again.append(body(0, { kind: 'plan', step: '', role: '' }))
  again.append(body(1))
  again.append(body(2, { kind: 'refusal', failed: ['ConductScreen14A'], note: 'refused' }))
  assert.equal(again.head, chain.head)
})

test('verify names the first entry that was changed, dropped, reordered or forged', () => {
  const chain = new AuditChain()
  for (let i = 0; i < 4; i++) chain.append(body(i))
  const good = chain.entries()
  const edited = good.map((e, i) => (i === 2 ? { ...e, note: 'entry 2 (edited)' } : e))
  assert.deepEqual(verifyChain(edited), { ok: false, at: 2, why: 'its hash is not the hash of its body' })
  const rehashed = good.map((e, i) => (i === 2 ? { ...e, note: 'edited', hash: entryHash({ ...e, note: 'edited' }, e.prev) } : e))
  assert.deepEqual(verifyChain(rehashed), { ok: false, at: 3, why: 'does not link to the entry before it' }, 'a rehashed entry breaks the link after it')
  assert.deepEqual(verifyChain([good[0], good[2], good[3]]), { ok: false, at: 1, why: 'numbered 2, expected 1' })
  assert.deepEqual(verifyChain([good[1], good[0]]), { ok: false, at: 0, why: 'numbered 1, expected 0' })
  assert.deepEqual(verifyChain([{ ...good[0], prev: 'f'.repeat(64) }]), { ok: false, at: 0, why: 'does not link to the entry before it' })
  assert.deepEqual(verifyChain([{ ...good[0], kind: 'wish' as 'step' }]), { ok: false, at: 0, why: "unknown kind 'wish'" })
  assert.deepEqual(verifyChain([{ ...good[0], failed: ['Luck' as 'LoopbackOnly'] }]), { ok: false, at: 0, why: 'names an unknown invariant' })
  assert.deepEqual(verifyChain([{ ...good[0], at: Number.NaN }]), { ok: false, at: 0, why: 'no time' })
  assert.deepEqual(verifyChain([null as unknown as AuditEntry]), { ok: false, at: 0, why: 'not an entry' })
  assert.deepEqual(verifyChain(good), { ok: true, length: 4, head: chain.head })
  // The chain's own entries cannot be edited in place (frozen), so verify over the kept chain stays true.
  assert.throws(() => { (chain.entries()[0] as { note: string }).note = 'x' }, TypeError)
  assert.equal(chain.verify().ok, true)
})
