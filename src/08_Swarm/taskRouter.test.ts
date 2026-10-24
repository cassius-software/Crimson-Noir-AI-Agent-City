// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the task gateway's contract (taskRouter.ts, P1–P10). The pure core is checked
 * exhaustively against brute force: the gate and the choice of tethers over every swarm of up to three people and
 * every requirement in a four-skill city (and seeded draws from the real one), and the lease's transition function
 * over every sequence of up to six events. The gateway itself is model-checked against a reference model written from
 * the contract alone, after every event of every interleaving of up to four events (new states that keep or break
 * the lease, uses, the task settling, the commit, closing), and fuzzed over longer seeded ones. Then the tether drops
 * in the middle of a real multi-stage task, before every stage and in every way it can break, for a task that heeds
 * its signal and one that ignores it; the drop lands between the task's return and its commit, and after it; the
 * signal's own listeners re-enter the gateway; the real Recruiter shows a lease broken before the state's events are
 * dispatched; the operator tier's scripts go through the real gateway from the console's own `run` (Rejected never
 * runs; the tether breaks between any two stages of a real script, in every way it can, and the console prints
 * Aborted at once while the city hears nothing more; a script deaf to its signal is cut off anyway); and end to end,
 * the physics realm itself breaks the tether when the operator walks away or drives off, both for a bare lease and
 * for a script typed at the console.
 * What breaks if it is removed? A race between a state and a task could let work count, or a script keep running,
 * after the person who had the skill was left behind, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createRng } from '../02_Define_The_Rules/degrees.ts'
import { MAX_CARS, type CrowdReadout, type CrowdSensor, type CrowdStepInput } from '../03_Spawn_Agents/crowdSensor.ts'
import { ACTIVITY, RECRUIT_SLOTS, SKILLS, skillsOf } from '../03_Spawn_Agents/skills.ts'
import type { RecruitHost } from '../07_Execute_Actions/engine.ts'
import { SimCore } from '../07_Execute_Actions/simCore.ts'
import { POSE, type RecruitView, type SimCommand, type SimEvent, type StepState } from '../07_Execute_Actions/simProtocol.ts'
import { operatorBridge, type Mind, type SimControls } from '../07_Execute_Actions/operator.ts'
import { run as shell } from '../07_Execute_Actions/terminal/commands.ts'
import type { OperatorBridge, TerminalBridge } from '../07_Execute_Actions/terminal/bridge.ts'
import { hudLine, Recruiter, type Clock } from './recruitment.ts'
import {
  activeTethers, advance, authorize, gatewayState, lostFrom, requirement, TaskRouter,
  type Lease, type LeaseEvent, type Outcome, type Phase, type SwarmSource, type TaskHandle, type Tether, type Verdict,
} from './taskRouter.ts'

// ---------------------------------------------------------------- helpers

/** One entry of the worker's list: Active (arrived) unless `active` is false. */
function entry(agent: number, serial: number, skills: string[], active = true): RecruitView {
  return { agent, serial, skill: skills[0], state: active ? 'Active' : 'Interviewing', arrived: active, skills, distance: 1.5, x: 0, z: 0, seconds: 10 }
}

// Four people over, in the order they joined: A and D know Rust, B and D know Go, C neither.
const A = entry(11, 1, ['Rust', 'Python'])
const B = entry(22, 2, ['Go', 'Data'])
const C = entry(33, 3, ['Audio', 'Design'])
const D = entry(44, 4, ['Rust', 'Go'])

const agentsOf = (ts: readonly Tether[]): number[] => ts.map((t) => t.agent)

/** A mirror the test drives: emit replaces the copy and tells every listener at once, as recruitment.ts does. */
class Mirror implements SwarmSource {
  recruits: readonly RecruitView[]
  readonly listeners = new Set<(r: readonly RecruitView[]) => void>()
  constructor(list: readonly RecruitView[] = []) {
    this.recruits = list
  }
  onMirror(fn: (r: readonly RecruitView[]) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }
  emit(list: readonly RecruitView[]): void {
    this.recruits = list
    for (const fn of [...this.listeners]) fn(list)
  }
  /** The source goes away: one empty mirror, then silence. */
  close(): void {
    this.emit([])
    this.listeners.clear()
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(v: T): void
  reject(e: unknown): void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Lets every queued microtask, and every continuation they queue, run. */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

/** Rejects with the signal's reason once it aborts. */
function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

const never = (): Promise<never> => new Promise(() => {})
const named = (name: string) => (e: unknown): boolean => e instanceof DOMException && e.name === name

// ---------------------------------------------------------------- the pure core

test('a requirement names skills exactly, in any case, each once; anything else is kept (nobody has it); a malformed one throws', () => {
  assert.deepEqual(requirement('rust'), ['Rust'])
  assert.deepEqual(requirement([' go ', 'Go', 'c++', 'TYPESCRIPT']), ['Go', 'C++', 'TypeScript'])
  // No guessing: a phrase, two names in one string or a spoken alias is not a skill's name, so nobody has it.
  assert.deepEqual(requirement(['Rust, Go']), ['Rust, Go'])
  assert.deepEqual(requirement('rust developer'), ['rust developer'])
  assert.deepEqual(requirement('golang'), ['golang'])
  assert.deepEqual(requirement(['juggling', 'Rust']), ['juggling', 'Rust'])
  for (const bad of [[], '', '   ', ['Rust', ''], [1], null, undefined, {}, 42, ['Rust', null]]) {
    assert.throws(() => requirement(bad), TypeError, JSON.stringify(bad))
  }
})

test('the Active tethers are the worker\'s arrived entries in its order; anything malformed counts as absent', () => {
  assert.deepEqual(agentsOf(activeTethers([A, entry(55, 5, ['Go'], false), B, C])), [11, 22, 33])
  const [t] = activeTethers([A])
  assert.deepEqual(t, { agent: 11, serial: 1, skills: ['Rust', 'Python'] })
  assert.ok(Object.isFrozen(t) && Object.isFrozen(t.skills), 'a bound tether cannot be edited afterwards')
  const bad: unknown[] = [
    { ...A, state: 'Interviewing' }, { ...A, arrived: false }, { ...A, arrived: 1 }, { ...A, agent: 0 }, { ...A, agent: 1.5 },
    { ...A, agent: '11' }, { ...A, serial: 0 }, { ...A, serial: NaN }, { ...A, serial: undefined }, { ...A, skills: [] },
    { ...A, skills: 'Rust' }, { ...A, skills: ['Rust', 7] }, null, 7, 'A',
  ]
  for (const b of bad) assert.deepEqual(agentsOf(activeTethers([b, B])), [22], JSON.stringify(b))
  // The same person listed twice is not a list the worker sends: neither entry counts.
  assert.deepEqual(agentsOf(activeTethers([A, B, { ...A, serial: 9 }])), [22])
  // Not a list, or longer than the worker's slots: nothing counts.
  const full = Array.from({ length: RECRUIT_SLOTS }, (_, i) => entry(100 + i, 100 + i, ['Rust']))
  assert.equal(activeTethers(full).length, RECRUIT_SLOTS)
  for (const m of [undefined, null, {}, 'A', [...full, entry(200, 200, ['Go'])]]) assert.deepEqual(activeTethers(m), [])
})

/** Whether index list `a` comes before `b` (same length) in lexicographic order. */
const before = (a: number[], b: number[]): boolean => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return false
}

/** The gate by brute force: every subset of the tethers, the smallest covering one first, then lexicographic. */
function oracle(requires: readonly string[], tethers: readonly Tether[]): { ok: true; bound: number[] } | { ok: false; missing: string[] } {
  const have = new Set(tethers.flatMap((t) => t.skills))
  const missing = [...new Set(requires.filter((s) => !have.has(s)))]
  if (missing.length || !requires.length) return { ok: false, missing }
  let best: number[] | null = null
  for (let mask = 1; mask < 1 << tethers.length; mask++) {
    const pick = tethers.map((_, i) => i).filter((i) => mask & (1 << i))
    if (!requires.every((s) => pick.some((i) => tethers[i].skills.includes(s)))) continue
    if (best === null || pick.length < best.length || (pick.length === best.length && before(pick, best))) best = pick
  }
  return { ok: true, bound: best ?? [] }
}

/** Checks one gate decision against brute force: same answer, and the very same tether objects. */
function agrees(requires: readonly string[], swarm: readonly Tether[], label: string): boolean {
  const got = authorize(requires, swarm)
  const want = oracle(requires, swarm)
  if (!want.ok) {
    assert.deepEqual(got, want, label)
    return false
  }
  assert.ok(got.ok, label)
  if (got.ok) assert.deepEqual(got.bound.map((b) => swarm.indexOf(b)), want.bound, label)
  return true
}

test('the gate agrees with brute force over every swarm of up to three people and every requirement in a four-skill city (P1, P2)', () => {
  const U = ['a', 'b', 'c', 'd']
  const sets: string[][] = []
  for (let mask = 1; mask < 16; mask++) sets.push(U.filter((_, i) => mask & (1 << i)))
  const requirements = [...sets, ['a', 'z'], ['z'], ['b', 'b', 'c']]
  const swarms: Tether[][] = [[]]
  let layer: Tether[][] = [[]]
  for (let n = 1; n <= 3; n++) {
    layer = layer.flatMap((s) => sets.map((k) => [...s, Object.freeze({ agent: n, serial: n, skills: k })]))
    swarms.push(...layer)
  }
  let cases = 0, authorized = 0
  for (const swarm of swarms) {
    for (const req of requirements) {
      cases++
      if (agrees(req, swarm, `${JSON.stringify(req)} over ${JSON.stringify(swarm.map((t) => t.skills))}`)) authorized++
    }
  }
  assert.equal(cases, (1 + 15 + 15 ** 2 + 15 ** 3) * requirements.length)
  assert.ok(authorized > cases / 4, `${authorized} of ${cases} authorized`)
  // Nothing required is never authorized: nothing would bind it.
  assert.deepEqual(authorize([], activeTethers([A])), { ok: false, missing: [] })
})

test('on the city\'s own skills, with swarms as large as the slots allow, the gate agrees with brute force on 3000 seeded draws', () => {
  const rng = createRng(0x7e7e7)
  const pickInt = (n: number) => Math.floor(rng() * n)
  let authorized = 0
  for (let k = 0; k < 3000; k++) {
    const agents = new Set<number>()
    const size = pickInt(RECRUIT_SLOTS + 1)
    while (agents.size < size) agents.add(1 + pickInt(20000))
    const swarm = [...agents].map((agent, i) => Object.freeze({ agent, serial: i + 1, skills: Object.freeze([...skillsOf(agent)]) }))
    const need = new Set<string>()
    const count = 1 + pickInt(3)
    while (need.size < count) need.add(SKILLS[pickInt(SKILLS.length)])
    if (agrees([...need], swarm, `draw ${k}`)) authorized++
  }
  assert.ok(authorized > 300, `${authorized} authorized`)
})

test('a bound tether is held only by the same person under the same recruitment, still bringing its skills', () => {
  const bound = activeTethers([A, B])
  assert.deepEqual(lostFrom(bound, activeTethers([B, C, A])), [], 'order and company do not matter')
  assert.deepEqual(agentsOf(lostFrom(bound, activeTethers([B]))), [11])
  assert.deepEqual(agentsOf(lostFrom(bound, activeTethers([{ ...A, serial: 7 }, B]))), [11], 'asked over again: a new tether')
  assert.deepEqual(agentsOf(lostFrom(bound, activeTethers([{ ...A, skills: ['Rust'] }, B]))), [11], 'no longer bringing Python')
  assert.deepEqual(agentsOf(lostFrom(bound, activeTethers([A, { ...B, state: 'Interviewing', arrived: false }]))), [22])
  assert.deepEqual(agentsOf(lostFrom(bound, [])), [11, 22])
})

test('the lease\'s transition function, over every sequence of up to six events, decides at the first event that can and never again (P4, P6, P7, P9)', () => {
  const bound = activeTethers([A, B])
  const holding = activeTethers([A, B, C])
  const breaking = activeTethers([B, C])
  const outcome: Outcome<string> = { ok: true, value: 'v' }
  const events: Record<string, LeaseEvent<string>> = {
    hold: { e: 'mirror', tethers: holding },
    lose: { e: 'mirror', tethers: breaking },
    settleHold: { e: 'settled', tethers: holding, outcome },
    settleLose: { e: 'settled', tethers: breaking, outcome },
    close: { e: 'closed' },
  }
  const decides: Record<string, Phase<string>['kind']> = { lose: 'aborted', settleHold: 'completed', settleLose: 'aborted', close: 'aborted' }
  let sequences = 0
  const walk = (seq: string[]): void => {
    sequences++
    // The reference: the first event other than a holding mirror decides, and nothing after it counts.
    const first = seq.findIndex((n) => n !== 'hold')
    let phase = { kind: 'running' } as Phase<string>
    let decidedAt = -1
    for (const [i, n] of seq.entries()) {
      const next = advance(phase, bound, events[n])
      if (decidedAt >= 0) assert.equal(next, phase, 'a decided phase comes back as it is')
      else if (next !== phase) decidedAt = i
      else assert.equal(next.kind, 'running')
      phase = next
    }
    assert.equal(decidedAt, first, seq.join(' '))
    assert.equal(phase.kind, first < 0 ? 'running' : decides[seq[first]], seq.join(' '))
    if (phase.kind === 'aborted') {
      assert.deepEqual(agentsOf(phase.lost), seq[first] === 'close' ? [11, 22] : [11])
      assert.equal(phase.closed, seq[first] === 'close')
    }
    if (phase.kind === 'completed') assert.equal(phase.outcome, outcome)
    assert.equal(gatewayState(phase), phase.kind === 'aborted' ? 'Aborted' : 'Authorized')
    if (seq.length < 6) for (const n of Object.keys(events)) walk([...seq, n])
  }
  walk([])
  assert.equal(sequences, (5 ** 7 - 1) / 4)
  assert.equal(gatewayState({ kind: 'rejected', missing: ['Go'] }), 'Rejected')
})

// ---------------------------------------------------------------- the gateway

test('submit decides at once: Rejected never calls the task; Authorized calls it before submit returns, bound to the smallest cover (P1–P3)', async () => {
  const src = new Mirror([A, B, C])
  const router = new TaskRouter(src)
  assert.deepEqual(router.capabilities, ['Rust', 'Python', 'Go', 'Data', 'Audio', 'Design'])
  let called = 0
  const no = router.submit(['rust', 'Networking', 'juggling'], () => { called++ })
  assert.equal(called, 0)
  assert.deepEqual([no.state, no.done, no.lease], ['Rejected', true, null])
  assert.deepEqual(await no.verdict, {
    state: 'Rejected', task: 1, requires: ['Rust', 'Networking', 'juggling'], reason: 'InsufficientCapabilities',
    missing: ['Networking', 'juggling'], message: 'nobody tethered to the operator has Networking, juggling',
  })
  let inside: unknown = null
  const yes = router.submit(['Go', 'Rust'], (lease) => {
    called++
    inside = { held: lease.held, bound: agentsOf(lease.bound), running: router.running }
    return 'ran'
  })
  assert.equal(called, 1, 'called once, inside submit')
  assert.deepEqual(inside, { held: true, bound: [11, 22], running: 1 })
  assert.deepEqual([yes.state, yes.done], ['Authorized', false], 'the result is committed a microtask later')
  assert.deepEqual(await yes.verdict, { state: 'Authorized', task: 2, requires: ['Go', 'Rust'], bound: activeTethers([A, B]), outcome: { ok: true, value: 'ran' } })
  assert.deepEqual([yes.state, yes.done, router.running], ['Authorized', true, 0])
  // A verdict, and everything in it, is fixed once decided: nobody holding it can edit it.
  const nv = await no.verdict
  const yv = await yes.verdict
  assert.ok(nv.state === 'Rejected' && [nv, nv.requires, nv.missing].every((x) => Object.isFrozen(x)))
  assert.ok(yv.state === 'Authorized' && [yv, yv.requires, yv.bound, yv.outcome, ...yv.bound].every((x) => Object.isFrozen(x)))
  assert.ok(Object.isFrozen(yes.requires) && Object.isFrozen(yes.lease!.bound) && Object.isFrozen(yes.lease))
  // Someone who knows both: one tether is bound, not two.
  src.emit([A, B, D])
  assert.deepEqual(agentsOf(router.submit(['Rust', 'Go'], never).lease!.bound), [44])
  // A malformed request or task throws, and takes no task number.
  assert.throws(() => router.submit([], () => 0), TypeError)
  assert.throws(() => router.submit('Rust', 'run' as unknown as () => number), TypeError)
  assert.equal(router.submit('Data', () => 0).task, 4)
  router.dispose()
})

/** The events the model check interleaves. */
type Letter = 'hold' | 'dropA' | 'dropC' | 'stallB' | 'rehireA' | 'use' | 'resolve' | 'reject' | 'flush' | 'close' | 'sourceClose'
const LETTERS: Letter[] = ['hold', 'dropA', 'dropC', 'stallB', 'rehireA', 'use', 'resolve', 'reject', 'flush', 'close', 'sourceClose']
/** The new states: which list the worker sends, and which of the task's tethers (A and B) it no longer holds. */
const MIRRORS: Partial<Record<Letter, { list: RecruitView[]; lost: number[] }>> = {
  hold: { list: [A, B, C], lost: [] },
  dropC: { list: [A, B], lost: [] },
  dropA: { list: [B, C], lost: [11] },
  stallB: { list: [A, { ...B, state: 'Interviewing', arrived: false }, C], lost: [22] },
  rehireA: { list: [{ ...A, serial: 9 }, B, C], lost: [11] },
}
const FAILURE = new Error('the task failed')

/** The reference model, written from the contract alone, for a task that requires Rust and Go (bound to A and B). */
interface Model {
  phase: 'running' | 'completed' | 'aborted'
  lost: number[]
  /** The gateway hears no more states (it was disposed, or its source closed). */
  deaf: boolean
  /** The task's promise settled: committed at the next microtask checkpoint if it is still running then. */
  settled: Outcome<string> | null
  committed: boolean
  outcome: Outcome<string> | null
  effects: number[]
}

/** One event in the model; returns the name of what lease.use throws for 'use' (null: it ran, or no use). */
function model(m: Model, letter: Letter, k: number): string | null {
  const mirror = MIRRORS[letter]
  if (mirror) {
    if (!m.deaf && m.phase === 'running' && mirror.lost.length) { m.phase = 'aborted'; m.lost = mirror.lost }
    return null
  }
  switch (letter) {
    case 'use':
      if (m.phase === 'running') { m.effects.push(k); return null }
      return m.phase === 'aborted' ? 'AbortError' : 'InvalidStateError'
    case 'resolve':
      m.settled ??= { ok: true, value: 'value' }
      return null
    case 'reject':
      m.settled ??= { ok: false, error: FAILURE }
      return null
    case 'flush':
      if (m.settled && !m.committed) {
        m.committed = true
        if (m.phase === 'running') { m.phase = 'completed'; m.outcome = m.settled }
      }
      return null
    default: // close, sourceClose: whatever is still running loses both tethers
      if (!m.deaf && m.phase === 'running') { m.phase = 'aborted'; m.lost = [11, 22] }
      m.deaf = true
      return null
  }
}

/** Runs one sequence of events through a real gateway and the model, comparing everything observable after each. */
async function check(seq: readonly Letter[]): Promise<void> {
  const src = new Mirror([A, B, C])
  const router = new TaskRouter(src)
  const task = deferred<string>()
  let calls = 0
  const h = router.submit(['Rust', 'Go'], () => { calls++; return task.promise })
  const lease = h.lease!
  const effects: number[] = []
  const verdicts: Verdict<string>[] = []
  h.verdict.then((v) => verdicts.push(v), () => assert.fail('a verdict never rejects'))
  // P8: what the signal's own listener sees, read before it touches anything.
  const atAbort: unknown[] = []
  lease.signal.addEventListener('abort', () => atAbort.push({ state: h.state, done: h.done, held: lease.held, running: router.running }))
  const m: Model = { phase: 'running', lost: [], deaf: false, settled: null, committed: false, outcome: null, effects: [] }
  for (let k = 0; k < seq.length; k++) {
    const letter = seq[k]
    const at = `${seq.join(' ')} @${k}`
    let threw: string | null = null
    const mirror = MIRRORS[letter]
    if (mirror) src.emit(mirror.list)
    else if (letter === 'use') {
      try {
        lease.use(() => effects.push(k))
      } catch (e) {
        threw = (e as DOMException).name
      }
    } else if (letter === 'resolve') task.resolve('value')
    else if (letter === 'reject') task.reject(FAILURE)
    else if (letter === 'flush') await flush()
    else if (letter === 'close') router.dispose()
    else src.close()
    assert.equal(threw, model(m, letter, k), at)
    // P7, P8 and the running set, after every event.
    assert.equal(h.state, m.phase === 'aborted' ? 'Aborted' : 'Authorized', at)
    assert.equal(h.done, m.phase !== 'running', at)
    assert.equal(lease.signal.aborted, m.phase === 'aborted', at)
    assert.equal(lease.held, m.phase === 'running', at)
    assert.equal(router.running, m.phase === 'running' ? 1 : 0, at)
    assert.deepEqual(effects, m.effects, at)
  }
  await flush()
  model(m, 'flush', seq.length)
  const at = seq.join(' ')
  assert.equal(calls, 1, at)
  if (m.phase === 'running') {
    assert.deepEqual(verdicts, [], `${at}: undecided, no verdict yet`)
    return
  }
  assert.equal(verdicts.length, 1, at)
  const v = verdicts[0]
  if (m.phase === 'completed') {
    assert.deepEqual(v, { state: 'Authorized', task: 1, requires: ['Rust', 'Go'], bound: activeTethers([A, B]), outcome: m.outcome }, at)
  } else {
    assert.ok(v.state === 'Aborted' && v.reason === 'SpatialTetherLost', at)
    if (v.state === 'Aborted') assert.deepEqual(agentsOf(v.lost), m.lost, at)
    assert.ok(named('AbortError')(lease.signal.reason), at)
  }
  assert.deepEqual(atAbort, m.phase === 'aborted' ? [{ state: 'Aborted', done: true, held: false, running: 0 }] : [], `${at}: the signal fires once, after the state`)
}

test('model check: after every event of every interleaving of up to four events, the gateway is exactly where the model is (P4–P9)', async () => {
  let runs = 0
  const walk = async (seq: Letter[]): Promise<void> => {
    await check(seq)
    runs++
    if (seq.length < 4) for (const l of LETTERS) await walk([...seq, l])
  }
  await walk([])
  assert.equal(runs, 1 + 11 + 11 ** 2 + 11 ** 3 + 11 ** 4)
})

test('fuzz: 1500 seeded sequences of twelve events agree with the model after every event', async () => {
  const rng = createRng(20260928)
  for (let n = 0; n < 1500; n++) await check(Array.from({ length: 12 }, () => LETTERS[Math.floor(rng() * LETTERS.length)]))
})

// ---------------------------------------------------------------- mid-execution drops

const STAGES = 4
const effectsUpTo = (n: number): string[] => Array.from({ length: n }, (_, k) => `effect ${k}`)

/** Every way the tether under a task bound to A (Rust) can break, and which tethers the verdict names. */
const DROPS: { name: string; apply(src: Mirror, router: TaskRouter): void }[] = [
  { name: 'released (the operator walked away)', apply: (s) => s.emit([B, C]) },
  { name: 'listed, but not arrived', apply: (s) => s.emit([{ ...A, state: 'Interviewing', arrived: false }, B, C]) },
  { name: 'asked over again (a new tether)', apply: (s) => s.emit([{ ...A, serial: 99 }, B, C]) },
  { name: 'no longer bringing a skill it was bound with', apply: (s) => s.emit([{ ...A, skills: ['Rust'] }, B, C]) },
  { name: 'everyone released (the operator drove off)', apply: (s) => s.emit([]) },
  { name: 'a list the worker could not have sent', apply: (s) => s.emit([A, ...Array.from({ length: RECRUIT_SLOTS }, (_, i) => entry(200 + i, 200 + i, ['Go']))]) },
  { name: 'the source closed (the city halted)', apply: (s) => s.close() },
  { name: 'the gateway closed', apply: (_, r) => r.dispose() },
]

/** A task in STAGES steps: each waits for its gate (or for the lease to break), then does its one effect under the lease. */
function staged(gates: Deferred<void>[], log: string[], ending: { how?: string }): (lease: Lease) => Promise<string> {
  return async (lease) => {
    try {
      for (let k = 0; k < STAGES; k++) {
        await Promise.race([gates[k].promise, whenAborted(lease.signal)])
        lease.use(() => log.push(`effect ${k}`))
      }
      ending.how = 'returned'
      return 'done'
    } catch (e) {
      ending.how = (e as DOMException).name
      throw e
    }
  }
}

test('mid-execution: the tether breaks before each stage of a task that heeds its signal, in every way it can; the task stops there and its work never counts', async () => {
  for (const drop of DROPS) {
    for (let at = 0; at < STAGES; at++) {
      const label = `${drop.name}, after ${at} stage(s)`
      const src = new Mirror([A, B, C])
      const router = new TaskRouter(src)
      const gates = Array.from({ length: STAGES }, () => deferred<void>())
      const log: string[] = []
      const ending: { how?: string } = {}
      const h = router.submit('Rust', staged(gates, log, ending))
      const lease = h.lease!
      assert.deepEqual(agentsOf(lease.bound), [11])
      for (let k = 0; k < at; k++) {
        gates[k].resolve()
        await flush()
      }
      assert.deepEqual([log, h.state], [effectsUpTo(at), 'Authorized'], label)
      drop.apply(src, router)
      // At once, inside the drop: Aborted, the signal fired, nothing running, and no effect can happen any more.
      assert.equal(h.state, 'Aborted', label)
      assert.ok(lease.signal.aborted && !lease.held && router.running === 0, label)
      assert.throws(() => lease.use(() => log.push('too late')), named('AbortError'), label)
      // Every remaining gate opens: the task has already stopped.
      for (const g of gates) g.resolve()
      await flush()
      assert.deepEqual(log, effectsUpTo(at), label)
      assert.equal(ending.how, 'AbortError', label)
      const v = await h.verdict
      assert.ok(v.state === 'Aborted' && v.reason === 'SpatialTetherLost', label)
      if (v.state === 'Aborted') assert.deepEqual(agentsOf(v.lost), [11], label)
    }
  }
})

test('mid-execution: a task that ignores its signal is cut off anyway: every use after the drop is refused, and its late result never counts', async () => {
  for (let at = 0; at < STAGES; at++) {
    const src = new Mirror([A, B, C])
    const router = new TaskRouter(src)
    const gates = Array.from({ length: STAGES }, () => deferred<void>())
    const log: string[] = []
    let returned = false
    const h = router.submit('Rust', async (lease) => {
      for (let k = 0; k < STAGES; k++) {
        await gates[k].promise // deaf to the signal
        try {
          lease.use(() => log.push(`effect ${k}`))
        } catch {
          log.push(`refused ${k}`)
        }
      }
      returned = true
      return 'done anyway'
    })
    for (let k = 0; k < at; k++) {
      gates[k].resolve()
      await flush()
    }
    src.emit([B, C])
    for (const g of gates) g.resolve()
    await flush()
    assert.ok(returned)
    assert.deepEqual(log, [...effectsUpTo(at), ...Array.from({ length: STAGES - at }, (_, k) => `refused ${at + k}`)])
    assert.equal((await h.verdict).state, 'Aborted')
    assert.equal(h.state, 'Aborted')
  }
})

test('mid-execution: a drop after the task returned but before its result is committed discards the result; after the commit it changes nothing (P6, P7)', async () => {
  // The drop is queued from inside the task just before it returns (or throws), so it lands before the commit.
  for (const ends of ['returns', 'throws'] as const) {
    const src = new Mirror([A, B, C])
    const router = new TaskRouter(src)
    const h = router.submit('Rust', async (lease) => {
      lease.use(() => 0)
      queueMicrotask(() => src.emit([B, C]))
      if (ends === 'throws') throw new Error('late failure')
      return 'done'
    })
    assert.equal(h.state, 'Authorized')
    const v = await h.verdict
    assert.equal(v.state, 'Aborted', ends)
    assert.ok(!('outcome' in v), 'the result was discarded')
  }
  // After the commit: Authorized for good. A later drop fires nothing, and the lease is over.
  const src = new Mirror([A, B, C])
  const router = new TaskRouter(src)
  const h = router.submit('Rust', async () => 'done')
  const v = await h.verdict
  assert.deepEqual(v.state === 'Authorized' && v.outcome, { ok: true, value: 'done' })
  src.emit([])
  router.dispose()
  assert.equal(h.state, 'Authorized')
  assert.equal(h.lease!.signal.aborted, false)
  assert.equal(h.lease!.held, false)
  assert.throws(() => h.lease!.use(() => 0), named('InvalidStateError'))
})

test('whatever the task returns is committed a microtask later against the newest mirror: a value, a throw, a thenable (P3, P6)', async () => {
  const src = new Mirror([A])
  const router = new TaskRouter(src)
  const value = router.submit('Rust', () => 42)
  const thrown = router.submit('Rust', () => { throw new RangeError('bad input') })
  const thenable = router.submit('Rust', () => ({ then: (ok: (v: string) => void) => ok('from a thenable') }) as unknown as PromiseLike<string>)
  assert.deepEqual([value, thrown, thenable].map((h) => [h.state, h.done]), [['Authorized', false], ['Authorized', false], ['Authorized', false]])
  const [v1, v2, v3] = await Promise.all([value.verdict, thrown.verdict, thenable.verdict])
  assert.deepEqual(v1.state === 'Authorized' && v1.outcome, { ok: true, value: 42 })
  assert.ok(v2.state === 'Authorized' && !v2.outcome.ok && v2.outcome.error instanceof RangeError, 'a task that fails on its own is still Authorized')
  assert.deepEqual(v3.state === 'Authorized' && v3.outcome, { ok: true, value: 'from a thenable' })
  // A throw waits for its commit like a value: a drop before it wins.
  const late = router.submit('Rust', () => { throw new Error('x') })
  src.emit([])
  assert.equal((await late.verdict).state, 'Aborted')
})

test('a task submitted inside a settled task\'s .then, with a new state queued behind it, binds the tethers the first task had (a proposed city action\'s premise)', async () => {
  // The operator tier submits a proposed city action inside the ask's `result.then(...)`: the gateway settles a task
  // through `Promise.resolve(result).then(...)` (microtasks) and a state arrives by worker message (a macrotask), so
  // the proposal is authorized against the same list the answer was, before the state that would change it can land.
  const src = new Mirror([A, B, C])
  const router = new TaskRouter(src)
  const answer = deferred<string>()
  const ask = router.submit('Design', () => answer.promise)
  assert.deepEqual(agentsOf(ask.lease!.bound), [33])
  let proposal: TaskHandle<string> | null = null
  let atSubmit: unknown = null
  // Two hops, as the tier has them: the gateway's verdict, the ask's result built on it, then the proposal.
  const result = ask.verdict.then((v) => v)
  const chained = result.then((v) => {
    assert.equal(v.state, 'Authorized')
    proposal = router.submit('Design', never)
    atSubmit = { state: proposal.state, bound: proposal.lease && agentsOf(proposal.lease.bound), running: router.running }
  })
  // The answer settles and, in the same turn, the state that lets C go is queued behind it (a worker message).
  answer.resolve('ok')
  setImmediate(() => src.emit([A, B]))
  await chained
  assert.deepEqual(atSubmit, { state: 'Authorized', bound: [33], running: 1 }, 'bound to the same tether the answer had, before the new state landed')
  assert.deepEqual(proposal!.lease!.bound, ask.lease!.bound, 'the very tethers the answer was bound to')
  await flush()
  // The queued state then ends the proposal the gateway's way: it never ran under anyone else.
  assert.equal(proposal!.state, 'Aborted')
  const v = await proposal!.verdict
  assert.ok(v.state === 'Aborted' && agentsOf(v.lost).join() === '33' && v.message === 'agent 33 (Audio, Design): no longer tethered to the operator', JSON.stringify(v))
  assert.equal(router.running, 0)
  // Had the state landed first, nobody would have had Design: the same submit is Rejected, not re-bound to another person.
  const late = router.submit('Design', never)
  assert.deepEqual([late.state, late.lease], ['Rejected', null])
  router.dispose()
})

test('the commit and every use read the newest list themselves: a list that changed without a word still breaks the lease (P5, P6)', async () => {
  // The source replaces its list without telling anyone, as if the notification were late or lost.
  const src = new Mirror([A, B, C])
  const router = new TaskRouter(src)
  const task = deferred<string>()
  const h = router.submit('Rust', () => task.promise)
  src.recruits = [B, C]
  assert.equal(h.lease!.held, false, 'held reads the newest list')
  assert.equal(h.state, 'Authorized', 'nothing has told the gateway yet')
  task.resolve('done')
  const v = await h.verdict
  assert.ok(v.state === 'Aborted' && !('outcome' in v), 'the commit checked the newest list itself')
  // A use checks it too: aborted there and then, and the effect never happens.
  const src2 = new Mirror([A, B, C])
  const router2 = new TaskRouter(src2)
  const h2 = router2.submit('Rust', never)
  src2.recruits = [B, C]
  let ran = false
  assert.throws(() => h2.lease!.use(() => { ran = true }), named('AbortError'))
  assert.deepEqual([ran, h2.state, h2.lease!.signal.aborted, router2.running], [false, 'Aborted', true, 0])
})

// ---------------------------------------------------------------- listeners, independence, determinism

test('the signal\'s own listeners already see the task Aborted, and may submit or close the gateway from there (P8)', async () => {
  const src = new Mirror([A, B, C])
  const router = new TaskRouter(src)
  const one = router.submit('Rust', never)
  const two = router.submit('Go', never)
  const three = router.submit('Python', never)
  const seen: unknown[] = []
  one.lease!.signal.addEventListener('abort', () => {
    // Read first: anything that touches the gateway (a use, a submit) could otherwise mend what it had not yet set.
    seen.push({ state: one.state, done: one.done, held: one.lease!.held, running: router.running })
    let refused = ''
    try {
      one.lease!.use(() => 0)
    } catch (e) {
      refused = (e as DOMException).name
    }
    const again = router.submit('Rust', () => 0) // A is gone from the newest mirror
    const other = router.submit('Go', never) // B is still here
    seen.push({ refused, again: again.state, other: other.state, running: router.running })
    router.dispose() // and the gateway closes from inside the listener
    seen.push({ two: two.state, three: three.state, other: other.state, running: router.running })
  })
  src.emit([B, C])
  assert.deepEqual(seen, [
    { state: 'Aborted', done: true, held: false, running: 2 },
    { refused: 'AbortError', again: 'Rejected', other: 'Authorized', running: 3 },
    { two: 'Aborted', three: 'Aborted', other: 'Aborted', running: 0 },
  ])
  const v3 = await three.verdict
  assert.ok(v3.state === 'Aborted' && v3.message === 'the gateway closed: the tether can no longer be checked')
  assert.equal(router.submit('Go', () => 0).state, 'Rejected', 'a closed gateway rejects')
})

test('leases are independent: a drop aborts exactly the tasks bound to that tether, in the order submitted, and there is no failover', () => {
  const src = new Mirror([A, B, D])
  const router = new TaskRouter(src)
  const rust = router.submit('Rust', never) // A, who joined before D
  const go = router.submit('Go', never) // B
  const both = router.submit(['Rust', 'Go'], never) // D covers both alone
  const python = router.submit('Python', never) // A
  const tasks = [rust, go, both, python]
  const order: number[] = []
  for (const h of tasks) h.lease!.signal.addEventListener('abort', () => order.push(h.task))
  assert.deepEqual(tasks.map((h) => agentsOf(h.lease!.bound)), [[11], [22], [44], [11]])
  src.emit([B, D]) // A leaves: D still knows Rust, but the Rust task was bound to A
  assert.deepEqual(order, [1, 4])
  assert.deepEqual(tasks.map((h) => h.state), ['Aborted', 'Authorized', 'Authorized', 'Aborted'])
  src.emit([D, B]) // the same two in another order: nothing breaks
  assert.deepEqual(order, [1, 4])
  src.emit([B]) // D leaves
  assert.deepEqual(order, [1, 4, 3])
  assert.deepEqual([go.state, router.running], ['Authorized', 1])
  router.dispose()
})

test('the same requirement, states and settlements give the same verdicts, every time (P10)', async () => {
  const script = async (): Promise<string> => {
    const src = new Mirror([A, B, C, D])
    const router = new TaskRouter(src)
    const gate = deferred<void>()
    const handles = [
      router.submit(['Go', 'Rust'], async () => { await gate.promise; return 'go-rust' }),
      router.submit('Design', async (lease) => { await gate.promise; return lease.use(() => 'design') }),
      router.submit(['Data', 'Python'], never),
      router.submit('Networking', () => 'never runs'),
    ]
    src.emit([A, B, D])
    gate.resolve()
    await flush()
    src.emit([B, D])
    await flush()
    return JSON.stringify(await Promise.all(handles.slice(0, 2).map((h) => h.verdict)).then((v) => [...v, handles.map((h) => h.state)]))
  }
  const first = await script()
  assert.equal(await script(), first)
  assert.match(first, /"state":"Authorized".*"go-rust".*"state":"Aborted".*"SpatialTetherLost"/)
})

test('the gateway reads the worker\'s list and nothing else: no engine, no command, no clock, no randomness (the air gap, P10)', () => {
  const src = readFileSync(new URL('./taskRouter.ts', import.meta.url), 'utf8')
  assert.deepEqual([...src.matchAll(/^import .*$/gm)].map((m) => m[0]), [
    "import { RECRUIT_SLOTS, SKILLS } from '../03_Spawn_Agents/skills.ts'",
    "import type { RecruitView } from '../07_Execute_Actions/simProtocol.ts'",
  ])
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  for (const banned of [/\bsend\s*\(/, /postMessage/, /dismiss/, /\bwindow\b/, /\bdocument\b/, /setTimeout|setInterval|requestAnimationFrame/, /\bDate\b|performance\./, /Math\.random/]) {
    assert.doesNotMatch(code, banned)
  }
})

// ---------------------------------------------------------------- with the real Recruiter

/** The engine as recruitment sees it, driven by hand: `deliver` is one state from the worker. */
class Host implements RecruitHost {
  readonly agents = 64
  readonly listeners = new Set<(s: StepState) => void>()
  operator(): { x: number; z: number } {
    return { x: 0, z: 0 }
  }
  send(): void {}
  onState(fn: (s: StepState) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }
  cue(): boolean {
    return true
  }
  deliver(events: SimEvent[], recruits: RecruitView[] | undefined): void {
    const s = { crowdFrame: null, events, recruits } as unknown as StepState
    for (const l of [...this.listeners]) l(s)
  }
}
const STILL: Clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} }

test('with the real Recruiter: a state that releases the tether aborts the lease before that state\'s events are dispatched', async () => {
  const host = new Host()
  const r = new Recruiter(host, { Recognition: null, Phrase: null }, STILL)
  const router = new TaskRouter(r)
  host.deliver([{ e: 'active', agent: 11, skill: 'Rust', skills: ['Rust', 'Python'] }], [A, B])
  assert.deepEqual(router.capabilities, ['Rust', 'Python', 'Go', 'Data'])
  const h = router.submit('Rust', (lease) => whenAborted(lease.signal))
  let heard: unknown = null
  r.addEventListener('released', () => {
    heard = { state: h.state, aborted: h.lease!.signal.aborted, rust: router.submit('Rust', () => 0).state, go: router.submit('Go', () => 0).state }
  })
  host.deliver([{ e: 'released', agent: 11, skill: 'Rust', reason: 'the operator walked away' }], [B])
  assert.deepEqual(heard, { state: 'Aborted', aborted: true, rust: 'Rejected', go: 'Authorized' })
  // A state that carries no list at all: nobody is tethered.
  const g = router.submit('Go', (lease) => whenAborted(lease.signal))
  host.deliver([], undefined)
  assert.equal(g.state, 'Aborted')
  // The recruiter going away (a halt, or the page closing) aborts every lease; the gateway then rejects.
  host.deliver([], [B])
  const last = router.submit('Go', (lease) => whenAborted(lease.signal))
  assert.equal(last.state, 'Authorized')
  r.dispose()
  assert.equal(last.state, 'Aborted')
  assert.equal(router.submit('Go', () => 0).state, 'Rejected')
  await flush()
})

// ---------------------------------------------------------------- the operator tier through the gateway

/** The city as the operator tier sees it (SimControls), recording every hour it is set to; `onSet` runs inside the call. */
function citySim(onSet: (hours: number) => void = () => {}): SimControls & { sets: number[] } {
  const sets: number[] = []
  return {
    sets,
    clock: { hours: () => 10, set: (h) => { sets.push(h); onSet(h) } },
    quality: { state: () => ({ tier: 3, label: 'High', auto: true, renderScale: 1, targetMs: 16.7 }), set: () => {} },
    avatar: { position: () => ({ x: 0, z: 0, heading: 0, feetY: 0 }), teleport: () => {}, interact: () => {}, walk: () => {} },
    vehicles: {
      count: () => 0, state: () => ({ x: 0, z: 0, heading: 0, speed: 0, mode: 'ai', suv: false }),
      setMode: () => {}, recover: () => {}, intent: () => {}, nearest: () => -1,
    },
    physics: { tune: () => ({ 'car.power': 1 }), set: () => {} },
    shaders: { uniforms: () => ({ 'light.haze': 1 }), set: () => {} },
    crowd: { stats: () => ({ drawnNear: 0, drawnFar: 0, nudges: 0, waiting: 0, crossing: 0, retreating: 0 }), cull: () => {}, positions: () => new Float32Array(0) },
    kernel: {
      stats: () => ({ law1: 0, law2: 0, law3: 0, sensorFlips: 0, shielded: false, last: '', audit: { ticks: 0, perimeterBreaches: 0, velocityCaps: 0, closest: Infinity, panic: null } }),
      blindSensing: () => {},
    },
    snapshot: () => ({}) as unknown as ReturnType<SimControls['snapshot']>,
  }
}

/** A local model that is never asked here (`run` does not use it): any use is a failure of the test. */
const NO_MIND: Mind = {
  settings: () => ({ server: 'http://localhost:11434', model: null }),
  setServer: () => { throw new Error('no model in this test') },
  setModel: () => { throw new Error('no model in this test') },
  installed: () => Promise.reject(new Error('no model in this test')),
  answer: () => Promise.reject(new Error('no model in this test')),
}

/** The Ring-0 console over one operator surface (the only part of the bridge `run` touches). */
const consoleOver = (operator: OperatorBridge): TerminalBridge => ({ operator }) as unknown as TerminalBridge

/** A console, unlocked, over the real operator tier bound to the real gateway over `src`. */
function operatorConsole(src: Mirror, onSet?: (hours: number) => void) {
  const router = new TaskRouter(src)
  const city = citySim(onSet)
  const term = consoleOver(operatorBridge(city, router, NO_MIND))
  shell('operator unlock', term, [])
  return { router, city, term }
}

test('through the real gateway, the console decides every script by the swarm: Rejected never runs, Authorized names who it is bound to, the same way every time', async () => {
  const src = new Mirror([A, B, C])
  const { router, city, term } = operatorConsole(src)
  const rejected = [{ kind: 'err', text: 'run: Rejected (Insufficient Capabilities): nobody tethered to the operator has Networking' }]
  const no = shell('run networking: sim.clock.set(1)', term, [])
  assert.deepEqual(no.lines, [])
  assert.deepEqual(await no.pending, rejected)
  assert.deepEqual(await shell('run networking: sim.clock.set(1)', term, []).pending, rejected, 'deterministic')
  assert.deepEqual(city.sets, [], 'a rejected script never ran')
  const yes = shell('run rust, go: sim.clock.set(2); return sim.clock.hours()', term, [])
  assert.deepEqual(yes.lines, [{ kind: 'sys', text: 'run: Authorized: bound to agent 11 (Rust, Python) and agent 22 (Go, Data)' }])
  assert.deepEqual(city.sets, [2], 'it began inside the decision')
  assert.deepEqual(await yes.pending, [{ kind: 'out', text: '10' }])
  // Someone who knows both joins: one tether is enough.
  src.emit([A, B, C, D])
  assert.deepEqual(shell('run go, rust: 1', term, []).lines, [{ kind: 'sys', text: 'run: Authorized: bound to agent 44 (Rust, Go)' }])
  await flush()
  assert.equal(router.running, 0)
})

test('mid-script, through the console: the tether breaks between any two stages of a real script, in every way it can; Aborted prints at once and the city hears nothing more', async () => {
  const script = 'run rust: for (let k = 0; k < 4; k++) { sim.clock.set(k); console.log("stage " + k); await sleep(0) } return "done"'
  const stages = (n: number) => Array.from({ length: n }, (_, k) => ({ kind: 'out', text: `stage ${k}` }))
  // Nobody leaves: every stage, then the value.
  const calm = operatorConsole(new Mirror([A, B, C]))
  assert.deepEqual(await shell(script, calm.term, []).pending, [...stages(4), { kind: 'out', text: 'done' }])
  assert.deepEqual(calm.city.sets, [0, 1, 2, 3])
  for (const drop of DROPS) {
    for (let at = 0; at < 4; at++) {
      const label = `${drop.name}, during stage ${at}`
      const src = new Mirror([A, B, C])
      // The drop lands as a new state does, in a task of its own: queued as the script finishes stage `at`, so it
      // arrives while the script sleeps.
      const { router, city, term } = operatorConsole(src, (h) => { if (h === at) setTimeout(() => drop.apply(src, router), 0) })
      const r = shell(script, term, [])
      assert.deepEqual(r.lines, [{ kind: 'sys', text: 'run: Authorized: bound to agent 11 (Rust, Python)' }], label)
      const reason = drop.name === 'the gateway closed' ? 'the gateway closed: the tether can no longer be checked' : 'agent 11 (Rust, Python): no longer tethered to the operator'
      assert.deepEqual(await r.pending, [...stages(at + 1), { kind: 'err', text: `run: Aborted (Spatial Tether Lost): ${reason}` }], label)
      await new Promise((res) => setTimeout(res, 5))
      assert.deepEqual(city.sets, Array.from({ length: at + 1 }, (_, k) => k), label)
      assert.equal(router.running, 0, label)
    }
  }
})

test('a script deaf to its signal is cut off anyway: the console reports the abort without waiting for it, and its later calls never reach the city', async () => {
  const src = new Mirror([A, B, C])
  const { city, term } = operatorConsole(src, (h) => { if (h === 1) setTimeout(() => src.emit([B, C]), 0) })
  // It waits on a timer of its own (not sleep), so nothing wakes it early; then it logs and calls the city again.
  const r = shell('run rust: sim.clock.set(1); await new Promise((res) => setTimeout(res, 20)); console.log("woke"); sim.clock.set(2); return "late"', term, [])
  assert.deepEqual(await r.pending, [{ kind: 'err', text: 'run: Aborted (Spatial Tether Lost): agent 11 (Rust, Python): no longer tethered to the operator' }])
  await new Promise((res) => setTimeout(res, 40))
  assert.deepEqual(city.sets, [1])
})

// ---------------------------------------------------------------- end to end: the physics realm breaks the tether

const AGENTS = 256
/** A sidewalk on open ground: 5.8 m east of a north-south street's centreline, mid-block (as in simCore.test.ts). */
const WALK_AT = { x: -600 + 5.8, z: 20 }

/**
 * The GPU crowd's contract, with nobody moving unless the test moves them: every step reads back at once, and the
 * render frame carries each person's position where the page reads it (x and z at 4i and 4i + 2).
 */
class StillCrowd implements CrowdSensor {
  readonly agentCount = AGENTS
  readonly lost = null
  readonly xz = new Float32Array(AGENTS * 2).fill(NaN)
  readonly activity = new Uint8Array(AGENTS)
  readout: CrowdReadout | null = null
  #frame: Float32Array | null = null
  step(input: CrowdStepInput): void {
    this.readout = {
      seq: input.seq, time: input.time - input.dt,
      hazardsAhead: new Float32Array(MAX_CARS).fill(Infinity), hazardsBehind: new Float32Array(MAX_CARS).fill(Infinity),
      stats: { nudges: 0, waiting: 0, crossing: 0, retreating: 0, working: 0 }, xz: Float32Array.from(this.xz), activity: Uint8Array.from(this.activity),
    }
    const frame = new Float32Array(AGENTS * 12).fill(NaN)
    for (let i = 0; i < AGENTS; i++) {
      frame[4 * i] = this.xz[2 * i]
      frame[4 * i + 2] = this.xz[2 * i + 1]
    }
    this.#frame = frame
  }
  takeFlags(): number {
    return 0
  }
  takeFrame(): Float32Array | null {
    const f = this.#frame
    this.#frame = null
    return f
  }
  recycle(): void {}
}

/**
 * The physics realm (SimCore, with the crowd's contract standing in for the GPU), the page's recruiter over it and the
 * gateway over the recruiter, wired as the page wires them. The operator stands on a sidewalk; one person who knows
 * Rust stands 3 m up it. `hire()` asks them over and walks them in until the worker reports them Active; `releaseBy`
 * steps with `cmds` until the worker lets them go for `reason`, calling `holds()` on each state before and `broke()`
 * on that one.
 */
async function realm() {
  const crowd = new StillCrowd()
  const sim = await SimCore.create(
    { seed: 11, cars: 2, agents: AGENTS, boxes: [], furniture: { lamps: [], trees: [], signals: [] }, spawn: { x: -600, z: 0 }, debug: true },
    async () => crowd,
  )
  const poses = new Float32Array(sim.meta.count * POSE.stride)
  const listeners = new Set<(s: StepState) => void>()
  const queue: SimCommand[] = []
  let state: StepState | null = null
  const host: RecruitHost = {
    agents: AGENTS,
    operator: () => (state && state.driving < 0 ? { x: state.avatar.x, z: state.avatar.z } : null),
    send: (cmd) => { queue.push(cmd) },
    onState: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    cue: () => true,
  }
  /** One worker step carrying the page's queued commands (and any given here); its state is delivered to the page. */
  let steps = 0
  const tick = (cmds: SimCommand[] = []): StepState => {
    const drive = { steer: 0, fwd: 0, back: 0, handbrake: false }
    const s: StepState = { t: 'state', id: ++steps, ...sim.step({ dt: 1 / 60, foot: { x: 0, z: 0, heading: 0 }, drive, cmds: [...queue.splice(0), ...cmds] }, poses) }
    state = s
    for (const l of [...listeners]) l(s)
    return s
  }
  let now = 0
  const r = new Recruiter(host, { Recognition: null, Phrase: null }, { now: () => (now += 1000), setTimeout: () => 0, clearTimeout: () => {} })
  const router = new TaskRouter(r)

  tick([{ c: 'teleport', x: WALK_AT.x, z: WALK_AT.z }])
  for (let k = 0; k < 30; k++) tick()
  const person = Array.from({ length: AGENTS - 1 }, (_, k) => k + 1).find((a) => skillsOf(a).includes('Rust'))!
  crowd.xz[2 * person] = WALK_AT.x
  crowd.xz[2 * person + 1] = WALK_AT.z + 3 // 3 m up the operator's own sidewalk
  tick()
  tick()

  const hire = async (): Promise<void> => {
    const asked = r.recruit('Rust')
    tick() // the request rides this step, and the answer comes back with its state
    const o = await asked
    assert.ok(o.ok && o.agent === person, o.message)
    crowd.activity[person] = ACTIVITY.coming
    tick()
    tick()
    crowd.activity[person] = ACTIVITY.interviewing
    tick()
    tick()
    assert.equal(r.stateOf(person), 'Active')
  }
  const releaseBy = (cmds: SimCommand[], reason: string, holds: () => void, broke: () => void): void => {
    for (let k = 0; k < 10; k++) {
      const s = tick(k === 0 ? cmds : [])
      const released = s.events.find((e): e is Extract<SimEvent, { e: 'released' }> => e.e === 'released')
      if (!released) {
        holds()
        continue
      }
      assert.equal(released.reason, reason)
      broke()
      return
    }
    assert.fail(`the worker never released the recruit: ${reason}`)
  }
  const dispose = (): void => {
    router.dispose()
    r.dispose()
  }
  return { tick, crowd, r, router, person, hire, releaseBy, dispose }
}

/** The skills a tether on `agent` brings when they were asked for `skill`: that one first. */
const broughtBy = (agent: number, skill: string): string => [skill, ...skillsOf(agent).filter((s) => s !== skill)].join(', ')

test('end to end: the physics realm breaks the tether when the operator walks away or drives off, and the lease is aborted in that very state', async () => {
  const { tick, crowd, router, person, hire, releaseBy, dispose } = await realm()
  await hire()
  const walked = router.submit('Rust', (lease) => whenAborted(lease.signal))
  assert.deepEqual([walked.state, agentsOf(walked.lease!.bound)], ['Authorized', [person]])
  tick([{ c: 'teleport', x: WALK_AT.x, z: WALK_AT.z + 6 }]) // a few metres: the tether holds
  assert.equal(walked.state, 'Authorized')
  const holding = (h: TaskHandle<unknown>) => () => assert.equal(h.state, 'Authorized', 'still tethered: the lease holds')
  const broken = (h: TaskHandle<unknown>) => () => assert.equal(h.state, 'Aborted', 'aborted by the very state that carried the release')
  releaseBy([{ c: 'teleport', x: WALK_AT.x, z: WALK_AT.z + 20 }], 'the operator walked away', holding(walked), broken(walked))
  const v = await walked.verdict
  assert.ok(v.state === 'Aborted' && v.lost[0].agent === person)

  // Back, and the same person asked over again: a new tether, with a new serial.
  tick([{ c: 'teleport', x: WALK_AT.x, z: WALK_AT.z }])
  crowd.activity[person] = ACTIVITY.routine
  tick()
  tick()
  await hire()
  const drove = router.submit('Rust', (lease) => whenAborted(lease.signal))
  assert.notEqual(drove.lease!.bound[0].serial, walked.lease!.bound[0].serial, 'a new recruitment of the same person is a new tether')
  // A parked car beside the operator; getting in drives off.
  tick([{ c: 'dbgMode', i: 0, mode: 'parked' }, { c: 'recover', i: 0, x: WALK_AT.x + 3.5, z: WALK_AT.z, heading: 0 }])
  for (let k = 0; k < 30; k++) tick()
  assert.equal(drove.state, 'Authorized', 'a car parked nearby changes nothing')
  releaseBy([{ c: 'interact' }], 'the operator drove off', holding(drove), broken(drove))
  assert.equal(tick().driving, 0)
  assert.equal(router.submit('Rust', () => 0).state, 'Rejected', 'at the wheel, nobody is tethered')
  dispose()
})

test('end to end through the console: Rejected with nobody tethered, Authorized once the person has arrived (the HUD counts it), Aborted in the very state the worker lets them go', async () => {
  const { r, router, person, hire, releaseBy, dispose } = await realm()
  const city = citySim()
  const term = consoleOver(operatorBridge(city, router, NO_MIND))
  shell('operator unlock', term, [])
  assert.deepEqual(await shell('run rust: sim.clock.set(1)', term, []).pending, [
    { kind: 'err', text: 'run: Rejected (Insufficient Capabilities): nobody tethered to the operator has Rust' },
  ])
  await hire()
  const bound = `agent ${person} (${broughtBy(person, 'Rust')})`
  const script = shell('run rust: console.log("bound"); sim.clock.set(2); await sleep(60000); sim.clock.set(3); return 1', term, [])
  assert.deepEqual(script.lines, [{ kind: 'sys', text: `run: Authorized: bound to ${bound}` }])
  assert.match(hudLine(r, router.running).line, /^Active swarm 1: \[.*\] · 1 task bound$/)
  let printed: unknown = null
  void script.pending!.then((lines) => { printed = lines })
  releaseBy([{ c: 'teleport', x: WALK_AT.x, z: WALK_AT.z + 20 }], 'the operator walked away', () => assert.equal(router.running, 1), () => assert.equal(router.running, 0))
  await flush()
  assert.deepEqual(printed, [
    { kind: 'out', text: 'bound' },
    { kind: 'err', text: `run: Aborted (Spatial Tether Lost): ${bound}: no longer tethered to the operator` },
  ])
  assert.deepEqual(city.sets, [2], 'the city heard the script only while the tether held')
  assert.doesNotMatch(hudLine(r, router.running).line, /bound/)
  dispose()
})
