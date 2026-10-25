// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the keeper of proposed city actions (acts.ts) one row of its state machine at a
 * time: a proposal is read only from the console's ask and only from a whole answer (a cut, stopped or failed answer,
 * the script standing in, an agent who did not engage and a swarm step keep their text); a line that cannot be read, a
 * lock typed during the stream, the gateway's Rejected and a binding that is not the proposer's are refusals with the
 * right tag and no proposal; a valid line bound as the answer was waits, and nothing runs before the OK; allow runs it
 * once through the lease and notes a run episode, a second allow runs nothing; refuse, `ask stop` and `operator lock`
 * end it with HumanOverrideSupreme and a moment; a tether lost while it waits or at `use` ends it in the gateway's
 * words with nothing run; a facade throw is a failure the proposer is told of; the chain verifies after every path,
 * a replaced entry does not, and every step entry has exactly one follower; who is named as the roster names them.
 * What breaks if it is removed? A proposal could run without the OK, twice, under the wrong person, past a lock or
 * past a lost tether, or leave no trace, and only an operator would notice.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { screen } from '../02_Define_The_Rules/conduct.ts'
import { AUDIT_GENESIS, verifyChain, type AuditEntry } from '../02_Define_The_Rules/guardrails.ts'
import { sha256 } from '../02_Define_The_Rules/integrity.ts'
import { TIERS } from '../05_Observe_Environment/governor.ts'
import { catalogueLines, MORE_THAN_ONE, NOT_ALONE, type CityKnobs } from '../06_Make_Decisions/actions.ts'
import { createActs, NOTHING_WAITING, PROPOSAL_WAITING, sameBinding, TIER_LOCKED, type Acts } from './acts.ts'
import {
  leasedApi, operatorBridge, scriptApi,
  type ActBy, type ActEvent, type ActsBridge, type Answer, type AskResult, type Diary, type GatedAsk, type GateHandle, type GateLease, type GateTether, type GateVerdict,
  type Memories, type Mind, type Piece, type RunState, type SimControls, type SkillGate,
} from './operator.ts'
import type { SipocSnapshot } from '../05_Observe_Environment/telemetry.ts'

// ---------------------------------------------------------------- fakes

/**
 * The capability gateway's contract (operator.test.ts's stand-in, plus a serial the test can change): it authorizes
 * every request on one tether (agent 7, recruitment `serial`) unless told to reject, calls the task at once, refuses
 * any use once the tether is dropped or the task has ended; `drop()` breaks the newest lease (state first, then the
 * signal, then the verdict) and `slip()` takes the tether out of the newest copy of the swarm without a state saying
 * so yet, so the next `use` finds it gone, breaks the lease there and then, and refuses.
 */
class FakeGate implements SkillGate {
  readonly requests: string[][] = []
  readonly handles: GateHandle<unknown>[] = []
  reject: string | null = null
  /** The recruitment the next lease binds: 2 is the same person, recruited again. */
  serial = 1
  /** More tethers the next lease binds beside agent 7: the gateway binds two people when the skills need two. */
  extra: GateTether[] = []
  #drop: ((message: string) => void) | null = null
  #slip: (() => void) | null = null
  submit<T>(requires: readonly string[], task: (lease: GateLease) => T | PromiseLike<T>): GateHandle<T> {
    this.requests.push([...requires])
    if (this.reject !== null) {
      const message = this.reject
      const handle: GateHandle<T> = { state: 'Rejected', lease: null, verdict: Promise.resolve({ state: 'Rejected', message }) }
      this.handles.push(handle)
      return handle
    }
    const controller = new AbortController()
    let state: RunState = 'Authorized'
    let ended = false
    let decide: (v: GateVerdict<T>) => void = () => {}
    const verdict = new Promise<GateVerdict<T>>((resolve) => { decide = resolve })
    let gone = false
    const drop = (message: string): void => {
      if (state !== 'Authorized' || ended) return
      state = 'Aborted'
      controller.abort(new DOMException(`Spatial tether lost: ${message}`, 'AbortError'))
      decide({ state: 'Aborted', message })
    }
    const lease: GateLease = {
      signal: controller.signal,
      bound: [{ agent: 7, serial: this.serial, skills: [...requires] }, ...this.extra],
      get held() { return state === 'Authorized' && !ended && !gone },
      use: (act) => {
        if (gone) drop('agent 7 (Rust): no longer tethered to the operator')
        if (state === 'Aborted') throw controller.signal.reason
        if (ended) throw new DOMException('the lease ended with its task', 'InvalidStateError')
        return act()
      },
    }
    this.#drop = drop
    this.#slip = () => { gone = true }
    const settle = (outcome: { ok: true; value: T } | { ok: false; error: unknown }): void => {
      if (state !== 'Authorized' || ended) return
      ended = true
      decide({ state: 'Authorized', outcome })
    }
    let result: T | PromiseLike<T>
    try {
      result = task(lease)
    } catch (error) {
      result = Promise.reject(error)
    }
    Promise.resolve(result).then((value) => settle({ ok: true, value }), (error: unknown) => settle({ ok: false, error }))
    const handle: GateHandle<T> = { get state() { return state }, lease, verdict }
    this.handles.push(handle)
    return handle
  }
  drop(message = 'agent 7 (Rust): no longer tethered to the operator'): void {
    this.#drop?.(message)
  }
  slip(): void {
    this.#slip?.()
  }
}

/** The local model's contract: the test pushes pieces through `say`, then finishes or fails the answer. */
class FakeMind implements Mind {
  server = 'http://localhost:11434'
  model: string | null = 'test-model'
  readonly asked: { tethers: readonly GateTether[]; prompt: string }[] = []
  #piece: ((p: Piece) => void) | null = null
  #finish: ((a: Answer) => void) | null = null
  #fail: ((e: unknown) => void) | null = null
  settings() {
    return { server: this.server, model: this.model }
  }
  setServer(url: string): string { return (this.server = url) }
  setModel(name: string): string { return (this.model = name) }
  installed(): Promise<string[]> { return Promise.resolve(['test-model']) }
  answer(req: { tethers: readonly GateTether[]; prompt: string; signal: AbortSignal; memories?: readonly Memories[] }, onPiece: (p: Piece) => void): Promise<Answer> {
    this.asked.push({ tethers: req.tethers, prompt: req.prompt })
    return new Promise<Answer>((resolve, reject) => {
      this.#piece = onPiece
      this.#finish = resolve
      this.#fail = reject
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true })
    })
  }
  say(kind: Piece['kind'], text: string): void {
    try {
      this.#piece?.({ kind, text })
    } catch (e) {
      this.#fail?.(e)
    }
  }
  finish(text: string, reason = 'stop', standIn?: string): void {
    this.#finish?.({ text, thinking: 0, tokens: 7, reason, ...(standIn !== undefined && { standIn }) })
  }
  fail(e: unknown): void {
    this.#fail?.(e)
  }
}

interface FakeSim extends SimControls {
  /** Every facade leaf reached, by name (writes with their argument where it is short). */
  readonly calls: string[]
  hours: number
  /** When set, the clock refuses with this message: the one failure a facade can hand back. */
  refuse: string | null
}

/** A recording SimControls: the clock keeps what is set (so the done line reads it back), car 1 is being driven. */
function fakeSim(): FakeSim {
  const calls: string[] = []
  const uniforms: Record<string, number> = { 'light.haze': 1, 'light.exposure': 1, 'light.sun': 1, 'light.fill': 1, 'volumetrics.strength': 1 }
  const tune: Record<string, number> = { 'car.power': 1 }
  let tier: number | 'auto' = 3
  const sim: FakeSim = {
    calls, hours: 12, refuse: null,
    clock: {
      hours: () => { calls.push('clock.hours'); return sim.hours },
      set: (h) => {
        calls.push('clock.set')
        if (sim.refuse !== null) throw new Error(sim.refuse)
        sim.hours = h
      },
    },
    quality: {
      state: () => ({ tier: tier === 'auto' ? 3 : tier, label: tier === 'auto' ? 'High' : tier < 0 ? 'Lite' : TIERS[tier].label, auto: tier === 'auto', renderScale: 1, targetMs: 16.7 }),
      set: (t) => { calls.push(`quality.set ${t}`); tier = t },
    },
    avatar: { position: () => ({ x: 0, z: 0, heading: 0, feetY: 0 }), teleport: () => calls.push('avatar.teleport'), interact: () => calls.push('avatar.interact'), walk: () => calls.push('avatar.walk') },
    vehicles: {
      count: () => 3,
      state: (i) => ({ x: i, z: 0, heading: 0, speed: 0, mode: i === 1 ? 'player' : 'ai', suv: false }),
      setMode: (i, m) => { calls.push(`vehicles.setMode ${i} ${m}`) },
      recover: () => calls.push('vehicles.recover'),
      intent: () => calls.push('vehicles.intent'),
      nearest: () => 0,
    },
    physics: { tune: () => tune, set: (k, v) => { tune[k] = v } },
    shaders: { uniforms: () => uniforms, set: (k, v) => { calls.push(`shaders.set ${k} ${v}`); uniforms[k] = v } },
    crowd: {
      stats: () => ({ drawnNear: 0, drawnFar: 0, nudges: 0, waiting: 0, crossing: 0, retreating: 0 }),
      cull: (c) => { calls.push(`crowd.cull ${JSON.stringify(c)}`) },
      positions: () => new Float32Array(0),
    },
    kernel: { stats: () => ({ law1: 0, law2: 0, law3: 0, sensorFlips: 0, shielded: false, last: '', audit: { ticks: 0, perimeterBreaches: 0, velocityCaps: 0, closest: Infinity, panic: null } }), blindSensing: () => {} },
    snapshot: () => ({ customer: { clock: '12:00' } } as unknown as SipocSnapshot),
  }
  return sim
}

/** The two city knobs, recording. */
function fakeCity(): CityKnobs & { readonly calls: string[] } {
  const calls: string[] = []
  return { calls, rain: (on) => { calls.push(`rain ${on}`) }, audio: (level) => { calls.push(`audio ${level}`) } }
}

const NOW = 1_700_000_000_000
const HASH = sha256('the system prompt')
const TETHER: GateTether = Object.freeze({ agent: 7, serial: 1, skills: Object.freeze(['Rust']) })

/** A finished console ask as `askThrough` hands it to the keeper: Authorized, answered, bound to `bound`. */
function answered(text: string, bound: readonly GateTether[] = [TETHER], extra: Partial<AskResult> = {}): { a: GatedAsk; r: AskResult } {
  const r: AskResult = { state: 'Authorized', text, thinking: 0, done: 'stop', tokens: 3, ms: 12, promptHash: HASH, ...extra }
  const a: GatedAsk = Object.freeze({ state: 'Authorized', bound, follow: () => () => {}, result: Promise.resolve(r) })
  return { a, r }
}

const eventText = (ev: ActEvent): string =>
  ev.kind === 'proposed' ? `proposed ${ev.act.seq}` : ev.kind === 'allowed' ? `allowed ${ev.act.seq} ${ev.by}` : `ended ${ev.act.seq} ${ev.end.state} ${ev.by}: ${ev.end.line}`

/** One keeper over the fakes, with every write it makes recorded as one line. */
function rig(opts: { unlocked?: boolean; nameOf?: (agent: number) => string | null; city?: boolean } = {}) {
  const gate = new FakeGate()
  const sim = fakeSim()
  const api = scriptApi(sim)
  const city = fakeCity()
  const notes: string[] = []
  const moments: string[] = []
  const events: string[] = []
  let unlocked = opts.unlocked ?? true
  const acts: Acts = createActs({
    gate,
    facade: (lease) => leasedApi(api, lease),
    city: opts.city === false ? undefined : city,
    note: (bound, skills, text, state, began, outcome) => { notes.push(`${bound.map((t) => `${t.agent}#${t.serial}`).join('+')} run [${skills.join(',')}] ${text} (${state}) ${outcome ?? '-'} @${began}`) },
    awareness: { context: () => null, remember: (agent, who, what) => { moments.push(`${agent} ${who}: ${what}`) } },
    ...(opts.nameOf && { nameOf: opts.nameOf }),
    now: () => NOW,
    unlocked: () => unlocked,
  })
  acts.follow((ev) => events.push(eventText(ev)))
  const propose = (text: string, bound: readonly GateTether[] = [TETHER], skills: readonly string[] = ['Rust']) => {
    const { a, r } = answered(text, bound)
    return acts.onAnswer(a, r, skills)
  }
  return { gate, sim, city, notes, moments, events, acts, propose, lock: () => { unlocked = false }, unlock: () => { unlocked = true } }
}

/** The chain as rows: kind, step, tags, note. */
const rows = (acts: Pick<ActsBridge, 'log'>): string[] => acts.log().map((e) => `${e.kind} ${e.step} [${e.failed.join(',')}] ${e.note}`)

/**
 * Every `step` entry is followed by exactly one later entry that ends it (an `end`, a `refusal` or a `stop` with the same
 * step field): a proposal has one end. An `answer` with that step is the decision on the way to it, at most one; a
 * second `step` with it would be the same proposal shown twice.
 */
function oneFollowerEach(entries: readonly AuditEntry[]): void {
  entries.forEach((e, i) => {
    if (e.kind !== 'step') return
    const later = entries.slice(i + 1).filter((f) => f.step === e.step)
    assert.equal(later.filter((f) => f.kind === 'end' || f.kind === 'refusal' || f.kind === 'stop').length, 1, `${e.step} has one follower that ends it`)
    assert.ok(later.filter((f) => f.kind === 'answer').length <= 1, `${e.step} was allowed at most once`)
    assert.ok(later.every((f) => f.kind !== 'step'), `${e.step} was proposed once`)
  })
}

const ticks = async (n = 8): Promise<void> => { for (let i = 0; i < n; i++) await Promise.resolve() }
const within = <T,>(p: Promise<T>, ms = 2000): Promise<T> => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms))])

// ---------------------------------------------------------------- the rows of the state machine

test('no line, or ACTION: none: nothing is proposed, nothing is written, nothing reaches the gate; the text is the answer with the line stripped', async () => {
  const x = rig()
  assert.deepEqual(await x.propose('It will be dark soon.'), { text: 'It will be dark soon.' })
  assert.deepEqual(await x.propose('ok\nACTION: none'), { text: 'ok' })
  assert.deepEqual(await x.propose('ACTION: nothing'), { text: '' })
  assert.equal(x.acts.pending(), null)
  assert.deepEqual([x.acts.log(), x.events, x.notes, x.moments, x.gate.requests], [[], [], [], [], []])
  assert.deepEqual(x.acts.verify(), { ok: true, length: 0, head: AUDIT_GENESIS })
})

test('a parse refusal: one untagged refusal entry, the agent is told next time (a moment from the city), nothing is submitted', async () => {
  const x = rig()
  const two = [TETHER, { agent: 9, serial: 3, skills: ['Go'] }]
  const glued = await x.propose('I set the clock for you. ACTION: time 21:00', two)
  assert.deepEqual(glued, { text: 'I set the clock for you. ACTION: time 21:00', act: { kind: 'refused', reason: NOT_ALONE, told: 7 } })
  const double = await x.propose('ACTION: rain on\nSure.\nACTION: time 12:00', two)
  assert.deepEqual(double, { text: 'Sure.', act: { kind: 'refused', reason: MORE_THAN_ONE, line: 'ACTION: time 12:00', told: 7 } })
  const verb = await x.propose('ACTION: teleport 10 20')
  assert.equal(verb.act?.kind, 'refused')
  assert.equal(verb.act?.reason, "no city action called 'teleport' (time, rain, light, quality, cars, crowd, sound, or none)")
  assert.deepEqual(rows(x.acts), [
    `refusal act- [] not run: ${NOT_ALONE}`,
    `refusal act- [] not run: ${MORE_THAN_ONE}`,
    "refusal act- [] not run: no city action called 'teleport' (time, rain, light, quality, cars, crowd, sound, or none)",
  ])
  const [a, b, c] = x.acts.log()
  assert.deepEqual([a.inputHash, b.inputHash, c.inputHash], ['', sha256('ACTION: time 12:00'), sha256('ACTION: teleport 10 20')], 'the raw line when there is one')
  assert.deepEqual([a.outputHash, a.promptHash, a.role, a.at], ['', HASH, 'agent 7 (Rust)', NOW])
  assert.deepEqual(x.moments, [
    `7 the city: could not read your action line: ${NOT_ALONE}; nothing was proposed`,
    `9 the city: could not read your action line: ${NOT_ALONE}; nothing was proposed`,
    `7 the city: could not read your action line: ${MORE_THAN_ONE}; nothing was proposed`,
    `9 the city: could not read your action line: ${MORE_THAN_ONE}; nothing was proposed`,
    "7 the city: could not read your action line: no city action called 'teleport' (time, rain, light, quality, cars, crowd, sound, or none); nothing was proposed",
  ], 'every person the answer was bound to is told')
  assert.deepEqual([x.acts.pending(), x.events, x.notes, x.gate.requests], [null, [], [], []])
  assert.equal(x.acts.verify().ok, true)
})

test('a valid line while the tier is locked (a lock typed during the stream): a lone HumanOverrideSupreme refusal, nothing reaches the gate, nobody is told', async () => {
  const x = rig({ unlocked: false })
  const o = await x.propose('ok\nACTION: time 22:00')
  assert.deepEqual(o, { text: 'ok', act: { kind: 'refused', reason: TIER_LOCKED, line: 'ACTION: time 22:00' } })
  assert.deepEqual(rows(x.acts), [`refusal act- [HumanOverrideSupreme] not run: ${TIER_LOCKED}`])
  const [e] = x.acts.log()
  assert.deepEqual([e.inputHash, e.outputHash, e.promptHash], [sha256('ACTION: time 22:00'), '', HASH])
  assert.deepEqual([x.acts.pending(), x.events, x.notes, x.moments, x.gate.requests, x.sim.calls], [null, [], [], [], [], []])
})

test("Rejected by the gate: the gateway's wording through tetherVerdict, a CapabilityTethered refusal, nobody told, nothing pending", async () => {
  const x = rig()
  x.gate.reject = 'nobody tethered to the operator has Rust'
  const o = await x.propose('ok\nACTION: cars park')
  assert.deepEqual(o, { text: 'ok', act: { kind: 'refused', reason: 'Rejected (Insufficient Capabilities): nobody tethered to the operator has Rust', line: 'ACTION: cars park' } })
  assert.deepEqual(rows(x.acts), ['refusal act- [CapabilityTethered] not run: Rejected (Insufficient Capabilities): nobody tethered to the operator has Rust'])
  assert.deepEqual([x.acts.log()[0].inputHash, x.acts.log()[0].promptHash], [sha256('ACTION: cars park'), HASH])
  assert.deepEqual([x.gate.requests, x.acts.pending(), x.events, x.moments, x.sim.calls], [[['Rust']], null, [], [], []])
})

test('a new serial is Refused (Proposer Not Bound): the identity check compares agent and serial as sets, submits once, writes no step, runs nothing', async () => {
  const x = rig()
  x.gate.serial = 2
  const o = await x.propose('ok\nACTION: time 22:00')
  assert.deepEqual(o, { text: 'ok', act: { kind: 'refused', reason: 'Refused (Proposer Not Bound): the gate now binds agent 7 (Rust) under a new recruitment, not agent 7 (Rust)', line: 'ACTION: time 22:00' } })
  assert.deepEqual(rows(x.acts), ['refusal act- [CapabilityTethered] not run: Refused (Proposer Not Bound): the gate now binds agent 7 (Rust) under a new recruitment, not agent 7 (Rust)'])
  // Another person altogether (the ask was bound to agent 9; the gate binds agent 7 now).
  x.gate.serial = 1
  const other = await x.propose('ok\nACTION: time 22:00', [{ agent: 9, serial: 1, skills: ['Rust'] }])
  assert.equal(other.act?.kind === 'refused' ? other.act.reason : '', 'Refused (Proposer Not Bound): the gate now binds agent 7 (Rust), not agent 9 (Rust)')
  assert.deepEqual([x.gate.requests, x.acts.pending(), x.events, x.notes, x.moments, x.sim.calls], [[['Rust'], ['Rust']], null, [], [], [], []])
  assert.ok(x.acts.log().every((e) => e.kind !== 'step'), 'no step entry')
  // The tasks the gate ran resolved unbound at once, under their own verdict.
  for (const h of x.gate.handles) assert.deepEqual(await h.verdict, { state: 'Authorized', outcome: { ok: true, value: 'unbound' } })
  // The rule itself: a set over { agent, serial }, in any order; a subset, a superset or a new serial is a difference.
  const t = (agent: number, serial: number): GateTether => ({ agent, serial, skills: ['x'] })
  assert.equal(sameBinding([t(1, 1), t(2, 2)], [t(2, 2), t(1, 1)]), true)
  assert.equal(sameBinding([t(1, 1)], [t(1, 2)]), false)
  assert.equal(sameBinding([t(1, 1)], [t(1, 1), t(2, 1)]), false)
  assert.equal(sameBinding([t(1, 1), t(2, 1)], [t(1, 1)]), false)
  assert.equal(sameBinding([], []), true)
})

test('a valid line bound as the answer was: pending with its seq, the step entry, the proposed event; nothing runs before allow', async () => {
  const x = rig()
  const o = await x.propose('It will be dark soon.\nACTION: time 22:00')
  assert.deepEqual(o, { text: 'It will be dark soon.', act: { kind: 'proposed', seq: 1, who: 'agent 7 (Rust)', sentence: 'set the clock to 22:00', line: 'ACTION: time 22:00' } })
  assert.deepEqual(x.acts.pending(), { seq: 1, who: 'agent 7 (Rust)', agent: 7, serial: 1, skills: ['Rust'], verb: 'time', canonical: 'time 22:00', sentence: 'set the clock to 22:00', since: NOW })
  assert.ok(Object.isFrozen(x.acts.pending()))
  assert.deepEqual(rows(x.acts), ['step act-1 [] proposed: set the clock to 22:00'])
  const [e] = x.acts.log()
  assert.deepEqual([e.inputHash, e.outputHash, e.promptHash, e.role, e.at, e.seq], [sha256('ACTION: time 22:00'), sha256('time 22:00'), HASH, 'agent 7 (Rust)', NOW, 0])
  assert.deepEqual(x.events, ['proposed 1'])
  assert.deepEqual([x.sim.calls, x.city.calls, x.notes, x.moments, x.gate.requests], [[], [], [], [], [['Rust']]], 'nothing runs, nothing is noted, before the OK')
  assert.equal(x.sim.hours, 12)
  // A clamped dial carries its note everywhere: the act, the pending proposal and the step entry.
  const y = rig()
  const c = await y.propose('ACTION: light haze 9')
  assert.deepEqual(c.act, { kind: 'proposed', seq: 1, who: 'agent 7 (Rust)', sentence: 'set the light haze to 4', note: 'clamped from 9', line: 'ACTION: light haze 9' })
  assert.equal(y.acts.pending()?.note, 'clamped from 9')
  assert.deepEqual(rows(y.acts), ['step act-1 [] proposed: set the light haze to 4 (clamped from 9)'])
})

test('allow at the console: pending is null first, the run comes a step later, once, through the lease; a run episode with ok, the moment, proposed → allowed → ended; a second allow runs nothing', async () => {
  const x = rig()
  await x.propose('ok\nACTION: time 22:00')
  const { act, result } = x.acts.allow('console')
  assert.equal(act.seq, 1)
  assert.equal(x.acts.pending(), null, 'nulled before anything else')
  assert.throws(() => x.acts.allow('console'), new RegExp(`^Error: ${NOTHING_WAITING}$`), 'a second OK has nothing to allow')
  assert.deepEqual(x.sim.calls, [], 'the run is a step later than the OK')
  assert.deepEqual(await within(result), { state: 'done', line: 'the clock is set to 22:00' })
  assert.deepEqual(x.sim.calls, ['clock.set', 'clock.hours'], 'one call, then the done line read back')
  assert.equal(Math.floor(x.sim.hours), 22)
  assert.deepEqual(rows(x.acts), [
    'step act-1 [] proposed: set the clock to 22:00',
    'answer act-1 [] allowed at the console',
    'end act-1 [] done: the clock is set to 22:00',
  ])
  const [, answer, end] = x.acts.log()
  assert.deepEqual([answer.inputHash, answer.outputHash, answer.promptHash], [sha256('time 22:00'), '', null])
  assert.deepEqual([end.inputHash, end.outputHash, end.promptHash], [sha256('time 22:00'), sha256('the clock is set to 22:00'), null])
  assert.deepEqual(x.events, ['proposed 1', 'allowed 1 console', 'ended 1 done console: the clock is set to 22:00'])
  assert.deepEqual(x.notes, [`7#1 run [Rust] city action: set the clock to 22:00 (Authorized) ok @${NOW}`])
  assert.deepEqual(x.moments, ['7 the player: allowed your proposal and the city did it: the clock is set to 22:00'])
  assert.throws(() => x.acts.allow('console'), new RegExp(`^Error: ${NOTHING_WAITING}$`))
  assert.throws(() => x.acts.refuse('console'), new RegExp(`^Error: ${NOTHING_WAITING}$`))
  assert.equal(x.sim.calls.filter((c) => c === 'clock.set').length, 1, 'nothing ran twice')
  assert.equal(x.acts.verify().ok, true)
  oneFollowerEach(x.acts.log())
  // The proposal's task settled Authorized with the run done.
  assert.deepEqual(await x.gate.handles[0].verdict, { state: 'Authorized', outcome: { ok: true, value: 'done' } })
})

test('allow on the card, by the host, and by a host that names the gateway: the chain says where, the ended event carries the same by, and the city knobs are reached', async () => {
  const x = rig()
  await x.propose('ACTION: rain on')
  assert.deepEqual(await within(x.acts.allow('card').result), { state: 'done', line: 'rain mode is on' })
  await x.propose('ACTION: sound off')
  assert.deepEqual(await within(x.acts.allow().result), { state: 'done', line: 'the sound is off' })
  await x.propose('ACTION: crowd 50')
  assert.deepEqual(await within(x.acts.allow('gateway' as ActBy).result), { state: 'done', line: 'the crowd is at 50% until the quality tier next changes' })
  assert.deepEqual(rows(x.acts).filter((r) => r.startsWith('answer')), ['answer act-1 [] allowed on the card', 'answer act-2 [] allowed by the host', 'answer act-3 [] allowed by the host'])
  assert.deepEqual(x.events, [
    'proposed 1', 'allowed 1 card', 'ended 1 done card: rain mode is on',
    'proposed 2', 'allowed 2 host', 'ended 2 done host: the sound is off',
    'proposed 3', 'allowed 3 host', 'ended 3 done host: the crowd is at 50% until the quality tier next changes',
  ])
  assert.deepEqual(x.city.calls, ['rain true', 'audio off'])
  assert.deepEqual(x.sim.calls, ['crowd.cull {"density":0.5}'])
  assert.equal(x.acts.verify().ok, true)
  oneFollowerEach(x.acts.log())
})

test('a facade throw gives failed, an error episode and the moment; a knob the host did not hand in fails the same way', async () => {
  const x = rig()
  x.sim.refuse = 'the clock is stuck'
  await x.propose('ok\nACTION: time 22:00')
  assert.deepEqual(await within(x.acts.allow('console').result), { state: 'failed', line: 'the clock is stuck' })
  assert.deepEqual(rows(x.acts).at(-1), 'end act-1 [] failed: the clock is stuck')
  const end = x.acts.log().at(-1)!
  assert.deepEqual([end.inputHash, end.outputHash, end.promptHash], [sha256('time 22:00'), sha256('the clock is stuck'), null])
  assert.deepEqual(x.events.at(-1), 'ended 1 failed console: the clock is stuck')
  assert.deepEqual(x.notes, [`7#1 run [Rust] city action: set the clock to 22:00 (Authorized) error @${NOW}`])
  assert.deepEqual(x.moments, ['7 the player: allowed your proposal but the city could not: set the clock to 22:00 (the clock is stuck)'])
  assert.equal(x.sim.hours, 12)
  const y = rig({ city: false })
  await y.propose('ACTION: rain on')
  assert.deepEqual(await within(y.acts.allow('card').result), { state: 'failed', line: 'rain mode is not reachable from here' })
  assert.deepEqual(y.events.at(-1), 'ended 1 failed card: rain mode is not reachable from here')
  assert.equal(x.acts.verify().ok && y.acts.verify().ok, true)
  oneFollowerEach(x.acts.log())
})

test('refuse at the console, on the card, by the host: a HumanOverrideSupreme refusal that says where, the moment, the task settles, nothing ran', async () => {
  const x = rig()
  await x.propose('ACTION: time 22:00')
  assert.equal(x.acts.refuse('console').seq, 1)
  assert.equal(x.acts.pending(), null)
  assert.throws(() => x.acts.refuse('console'), new RegExp(`^Error: ${NOTHING_WAITING}$`))
  await x.propose('ACTION: rain on')
  assert.equal(x.acts.refuse('card').seq, 2)
  await x.propose('ACTION: crowd 0')
  assert.equal(x.acts.refuse().seq, 3)
  assert.deepEqual(rows(x.acts).filter((r) => r.startsWith('refusal')), [
    'refusal act-1 [HumanOverrideSupreme] refused at the console',
    'refusal act-2 [HumanOverrideSupreme] refused on the card',
    'refusal act-3 [HumanOverrideSupreme] refused by the host',
  ])
  for (const e of x.acts.log().filter((e) => e.kind === 'refusal')) assert.deepEqual([e.inputHash, e.outputHash, e.promptHash], [sha256(e.step === 'act-1' ? 'time 22:00' : e.step === 'act-2' ? 'rain on' : 'crowd 0'), '', null])
  assert.deepEqual(x.moments, [
    '7 the player: refused your proposal: set the clock to 22:00',
    '7 the player: refused your proposal: turn rain mode on',
    '7 the player: refused your proposal: set the crowd to 0%',
  ])
  assert.deepEqual(x.events, [
    'proposed 1', 'ended 1 refused console: set the clock to 22:00',
    'proposed 2', 'ended 2 refused card: turn rain mode on',
    'proposed 3', 'ended 3 refused host: set the crowd to 0%',
  ])
  assert.deepEqual([x.sim.calls, x.city.calls, x.notes], [[], [], []], 'nothing ran, no episode')
  for (const h of x.gate.handles) assert.deepEqual(await within(h.verdict), { state: 'Authorized', outcome: { ok: true, value: 'refused' } })
  assert.equal(x.acts.verify().ok, true)
  oneFollowerEach(x.acts.log())
})

test('withdraw: ask stop and operator lock end a waiting proposal with a HumanOverrideSupreme stop, the moment and an ended event by the console; nothing waiting is null', async () => {
  const x = rig()
  assert.equal(x.acts.withdraw('ask stop'), null)
  await x.propose('ACTION: time 22:00')
  assert.equal(x.acts.withdraw('ask stop')?.sentence, 'set the clock to 22:00')
  assert.equal(x.acts.pending(), null)
  assert.equal(x.acts.withdraw('ask stop'), null)
  await x.propose('ACTION: quality lite')
  assert.equal(x.acts.withdraw('operator lock')?.seq, 2)
  assert.deepEqual(rows(x.acts), [
    'step act-1 [] proposed: set the clock to 22:00',
    'stop act-1 [HumanOverrideSupreme] withdrawn: ask stop',
    'step act-2 [] proposed: set the quality to Lite',
    `stop act-2 [HumanOverrideSupreme] withdrawn: ${TIER_LOCKED}`,
  ])
  for (const e of x.acts.log().filter((e) => e.kind === 'stop')) assert.deepEqual([e.outputHash, e.promptHash], ['', null])
  assert.equal(x.acts.log()[1].inputHash, sha256('time 22:00'))
  assert.deepEqual(x.moments, ['7 the player: withdrew your proposal: set the clock to 22:00 (ask stop)', '7 the player: withdrew your proposal: set the quality to Lite (operator lock)'])
  assert.deepEqual(x.events, ['proposed 1', 'ended 1 withdrawn console: ask stop', 'proposed 2', `ended 2 withdrawn console: ${TIER_LOCKED}`])
  assert.deepEqual([x.sim.calls, x.notes], [[], []])
  for (const h of x.gate.handles) assert.deepEqual(await within(h.verdict), { state: 'Authorized', outcome: { ok: true, value: 'withdrawn' } })
  assert.equal(x.acts.verify().ok, true)
  oneFollowerEach(x.acts.log())
})

test("drop while pending: the gateway ends it in its own words, a CapabilityTethered stop follows the step, no facade call, no moment, no episode; the gateway closing reads the same way", async () => {
  const x = rig()
  await x.propose('ACTION: time 22:00')
  x.gate.drop()
  await ticks()
  assert.equal(x.acts.pending(), null)
  assert.throws(() => x.acts.allow('console'), new RegExp(`^Error: ${NOTHING_WAITING}$`))
  assert.deepEqual(rows(x.acts), [
    'step act-1 [] proposed: set the clock to 22:00',
    'stop act-1 [CapabilityTethered] Aborted (Spatial Tether Lost): agent 7 (Rust): no longer tethered to the operator',
  ])
  assert.deepEqual([x.acts.log()[1].inputHash, x.acts.log()[1].outputHash, x.acts.log()[1].promptHash], [sha256('time 22:00'), '', null])
  assert.deepEqual(x.events, ['proposed 1', 'ended 1 aborted gateway: Aborted (Spatial Tether Lost): agent 7 (Rust): no longer tethered to the operator'])
  assert.deepEqual([x.sim.calls, x.notes, x.moments], [[], [], []])
  await x.propose('ACTION: sound 40')
  x.gate.drop('the gateway closed: the tether can no longer be checked')
  await ticks()
  assert.deepEqual(rows(x.acts).at(-1), 'stop act-2 [CapabilityTethered] Aborted (Spatial Tether Lost): the gateway closed: the tether can no longer be checked')
  assert.deepEqual(x.events.at(-1), 'ended 2 aborted gateway: Aborted (Spatial Tether Lost): the gateway closed: the tether can no longer be checked')
  assert.deepEqual([x.acts.pending(), x.city.calls], [null, []])
  // Dropped twice, or dropped after it ended: nothing more is written.
  x.gate.drop()
  await ticks()
  assert.equal(x.acts.log().length, 4)
  assert.equal(x.acts.verify().ok, true)
  oneFollowerEach(x.acts.log())
})

test('slip then allow is Aborted, api untouched: the run never reaches the facade or the city knobs, the episode is Aborted with no outcome, no moment, the ended event is by the one who allowed', async () => {
  // A city knob first: not a facade leaf, so only `lease.use` around `perform` stands between the OK and the engine.
  const x = rig()
  await x.propose('ACTION: rain on')
  x.gate.slip()
  const { result } = x.acts.allow('card')
  assert.deepEqual(await within(result), { state: 'aborted', line: 'Aborted (Spatial Tether Lost): agent 7 (Rust): no longer tethered to the operator' })
  assert.deepEqual([x.city.calls, x.sim.calls], [[], []], 'nothing ran')
  assert.deepEqual(rows(x.acts), [
    'step act-1 [] proposed: turn rain mode on',
    'answer act-1 [] allowed on the card',
    'stop act-1 [CapabilityTethered] Aborted (Spatial Tether Lost): agent 7 (Rust): no longer tethered to the operator',
  ])
  assert.deepEqual(x.events, ['proposed 1', 'allowed 1 card', 'ended 1 aborted card: Aborted (Spatial Tether Lost): agent 7 (Rust): no longer tethered to the operator'])
  assert.deepEqual(x.notes, [`7#1 run [Rust] city action: turn rain mode on (Aborted) - @${NOW}`], 'an allowed action that never ran: Aborted, no outcome')
  assert.deepEqual(x.moments, [])
  assert.equal(x.acts.pending(), null)
  // A facade leaf the same way, allowed at the console.
  const y = rig()
  await y.propose('ACTION: time 22:00')
  y.gate.slip()
  assert.equal((await within(y.acts.allow('console').result)).state, 'aborted')
  assert.deepEqual([y.sim.calls, y.sim.hours, y.moments], [[], 12, []])
  assert.deepEqual(y.events.at(-1), 'ended 1 aborted console: Aborted (Spatial Tether Lost): agent 7 (Rust): no longer tethered to the operator')
  assert.equal(x.acts.verify().ok && y.acts.verify().ok, true)
  oneFollowerEach(x.acts.log())
  oneFollowerEach(y.acts.log())
})

test("locked: allow and refuse throw the lock line first; unlocked with nothing waiting they say so; withdraw works locked (lock itself withdraws)", async () => {
  const x = rig({ unlocked: false })
  assert.throws(() => x.acts.allow('console'), /^Error: act: locked; type 'operator unlock' first$/)
  assert.throws(() => x.acts.refuse('card'), /^Error: act: locked; type 'operator unlock' first$/)
  assert.equal(x.acts.withdraw('operator lock'), null)
  x.unlock()
  assert.throws(() => x.acts.allow('console'), new RegExp(`^Error: ${NOTHING_WAITING}$`))
  assert.throws(() => x.acts.refuse('console'), new RegExp(`^Error: ${NOTHING_WAITING}$`))
  await x.propose('ACTION: time 22:00')
  x.lock()
  assert.throws(() => x.acts.allow('console'), /^Error: act: locked/)
  assert.equal(x.acts.withdraw('operator lock')?.seq, 1, 'the tier withdraws on lock; the keeper refuses the OK meanwhile')
  assert.deepEqual([x.acts.pending(), x.sim.calls], [null, []])
  assert.deepEqual(x.acts.log().length, 2)
})

test('the chain verifies after every path, every step has one follower that ends it, and a replaced entry fails verify; every line the keeper writes passes the screen and carries no exclamation mark', async () => {
  const x = rig({ nameOf: (agent) => (agent === 7 ? 'Mara' : null) })
  await x.propose('ACTION: time 22:00')
  await within(x.acts.allow('console').result)
  await x.propose('ACTION: rain on')
  x.acts.refuse('card')
  await x.propose('ACTION: crowd 50')
  x.acts.withdraw('ask stop')
  await x.propose('ACTION: quality lite')
  x.gate.drop()
  await ticks()
  await x.propose('ACTION: teleport 1 2')
  await x.propose('ACTION: sound 40')
  x.gate.slip()
  await within(x.acts.allow('host').result)
  x.sim.refuse = 'the clock is stuck'
  await x.propose('ACTION: time 06:00')
  await within(x.acts.allow('console').result)
  x.gate.reject = 'nobody tethered to the operator has Rust'
  await x.propose('ACTION: cars drive')
  x.gate.reject = null
  x.lock()
  await x.propose('ACTION: cars drive')
  x.unlock()
  await x.propose('ACTION: light fill 2')
  const entries = x.acts.log()
  assert.deepEqual(entries.map((e) => e.kind), ['step', 'answer', 'end', 'step', 'refusal', 'step', 'stop', 'step', 'stop', 'refusal', 'step', 'answer', 'stop', 'step', 'answer', 'end', 'refusal', 'refusal', 'step'])
  assert.deepEqual(entries.map((e) => e.seq), entries.map((_, i) => i))
  assert.ok(entries.every((e) => e.at === NOW && e.role === 'agent 7 (Rust)' && /^[0-9a-f]{64}$/.test(e.hash)))
  assert.ok(entries.every((e) => e.failed.every((f) => f === 'HumanOverrideSupreme' || f === 'CapabilityTethered')))
  assert.deepEqual(x.acts.verify(), { ok: true, length: entries.length, head: entries.at(-1)!.hash })
  assert.equal(x.acts.pending()?.seq, 7, 'the last step is still pending: its follower is yet to come')
  oneFollowerEach(entries.slice(0, -1))
  assert.equal(entries.filter((e) => e.step === 'act-7').length, 1, 'the pending step alone has none yet')
  // The log is a copy of frozen entries: nothing a reader does to it reaches the chain, and an edited copy does not verify.
  assert.ok(entries.every((e) => Object.isFrozen(e)))
  const edited = entries.with(1, { ...entries[1], note: 'allowed by nobody' })
  assert.deepEqual(verifyChain(edited), { ok: false, at: 1, why: 'its hash is not the hash of its body' })
  const relinked = entries.with(2, { ...entries[2], prev: entries[0].hash })
  assert.deepEqual(verifyChain(relinked), { ok: false, at: 2, why: 'does not link to the entry before it' })
  assert.notEqual(x.acts.log(), entries)
  assert.equal(x.acts.verify().ok, true)
  // Content: notes, moments, event lines, sentences and the who all pass the 14A screen, with no exclamation mark.
  const spoken = [...entries.map((e) => e.note), ...x.moments, ...x.events, x.acts.pending()!.who, x.acts.pending()!.sentence]
  for (const s of spoken) {
    assert.equal(screen(s).admissible, true, s)
    assert.doesNotMatch(s, /!/, s)
  }
})

test("who: the roster's name when there is one, else the gateway's words; agent, serial and skills from the ask's first tether; the chain's role stays the gateway's; everyone bound remembers", async () => {
  const named = rig({ nameOf: (agent) => (agent === 7 ? 'Mara' : null) })
  const one = [{ agent: 7, serial: 1, skills: ['Design', 'Rust'] }]
  const o = await named.propose('ACTION: time 22:00', one, ['Design'])
  assert.equal(o.act?.kind === 'proposed' ? o.act.who : '', 'Mara (agent 7, Design, Rust)')
  assert.deepEqual(named.acts.pending(), { seq: 1, who: 'Mara (agent 7, Design, Rust)', agent: 7, serial: 1, skills: ['Design', 'Rust'], verb: 'time', canonical: 'time 22:00', sentence: 'set the clock to 22:00', since: NOW })
  assert.equal(named.acts.log()[0].role, 'agent 7 (Design, Rust)', 'the chain names them as the gateway does')
  named.acts.refuse('console')
  // The identity line names both sides the same way; the same person under a new recruitment is said to be.
  named.gate.serial = 2
  const again = await named.propose('ACTION: time 22:00', one, ['Design'])
  assert.equal(again.act?.kind === 'refused' ? again.act.reason : '', 'Refused (Proposer Not Bound): the gate now binds Mara (agent 7, Design) under a new recruitment, not Mara (agent 7, Design, Rust)')
  // Nobody hired: the gateway's words.
  const plain = rig()
  const p = await plain.propose('ACTION: time 22:00', one, ['Design'])
  assert.equal(p.act?.kind === 'proposed' ? p.act.who : '', 'agent 7 (Design, Rust)')
  plain.acts.refuse('card')
  // Two people answered (the skills needed two): the gate binds both again, who is the first, and both remember the end.
  const two = [{ agent: 7, serial: 1, skills: ['Design'] }, { agent: 9, serial: 4, skills: ['Go'] }]
  plain.gate.extra = [{ agent: 9, serial: 4, skills: ['Go'] }]
  const both = await plain.propose('ACTION: rain on', two, ['Design', 'Go'])
  assert.equal(both.act?.kind === 'proposed' ? both.act.who : '', 'agent 7 (Design)')
  assert.deepEqual([plain.acts.pending()?.agent, plain.acts.pending()?.serial, plain.acts.pending()?.skills], [7, 1, ['Design']])
  plain.acts.refuse('card')
  assert.deepEqual(plain.moments, [
    '7 the player: refused your proposal: set the clock to 22:00',
    '7 the player: refused your proposal: turn rain mode on',
    '9 the player: refused your proposal: turn rain mode on',
  ])
  assert.deepEqual(plain.notes, [])
  // One of the two gone from the gate's binding (or one more there) is not the proposer either.
  plain.gate.extra = []
  const fewer = await plain.propose('ACTION: rain on', two, ['Design', 'Go'])
  assert.equal(fewer.act?.kind === 'refused' ? fewer.act.reason : '', 'Refused (Proposer Not Bound): the gate now binds agent 7 (Design, Go), not agent 7 (Design)')
  assert.equal(plain.acts.pending(), null)
})

test("followers: every event reaches every follower, a follower's own throw stops nothing, and unsubscribing stops the delivery", async () => {
  const x = rig()
  const seen: string[] = []
  const off = x.acts.follow((ev) => seen.push(`a ${eventText(ev)}`))
  x.acts.follow(() => { throw new Error('a careless follower') })
  x.acts.follow((ev) => seen.push(`b ${eventText(ev)}`))
  await x.propose('ACTION: time 22:00')
  assert.deepEqual(seen, ['a proposed 1', 'b proposed 1'])
  off()
  await within(x.acts.allow('console').result)
  assert.deepEqual(seen, ['a proposed 1', 'b proposed 1', 'b allowed 1 console', 'b ended 1 done console: the clock is set to 22:00'])
  assert.deepEqual(x.events.length, 3, 'the rig follower saw all three')
})

test('list is the catalogue, readable any time; the keeper is frozen', () => {
  const x = rig({ unlocked: false })
  assert.deepEqual(x.acts.list(), catalogueLines())
  assert.equal(x.acts.list().length, 7)
  assert.ok(Object.isFrozen(x.acts))
  assert.deepEqual(x.acts.log(), [])
})

// ---------------------------------------------------------------- through the tier (operator.ts): what reaches the keeper

/** The real tier over the fakes: the bridge's `ask` is the console's; the swarm's steps are not. */
function tier() {
  const gate = new FakeGate()
  const mind = new FakeMind()
  const sim = fakeSim()
  const city = fakeCity()
  const notes: string[] = []
  const moments: string[] = []
  const diary: Diary = { recall: () => [], note: (_b, kind, _s, text, state, _at, _h, outcome) => { notes.push(`${kind} ${text} (${state}) ${outcome ?? '-'}`) } }
  const op = operatorBridge(sim, gate, mind, undefined, { diary, awareness: { context: () => null, remember: (agent, who, what) => { moments.push(`${agent} ${who}: ${what}`) } }, city })
  op.unlock()
  return { gate, mind, sim, city, notes, moments, op }
}

const LINE = 'ok\nACTION: time 22:00'

test('a cut answer never proposes; nor does a stopped or failed one, or an agent who did not engage: their text is untouched and the keeper is never asked', async () => {
  const t = tier()
  const cut = t.op.ask(['Rust'], 'hi')
  t.mind.say('text', LINE)
  t.mind.finish(LINE, 'length')
  const c = await within(cut.result)
  assert.deepEqual([c.text, c.act, c.done], [LINE, undefined, 'length'])
  const stopped = t.op.ask(['Rust'], 'hi')
  t.mind.say('text', LINE)
  assert.equal(t.op.askStop(), 'stopping the answer')
  const st = await within(stopped.result)
  assert.deepEqual([st.text, st.act, st.stopped], [LINE, undefined, true])
  const failed = t.op.ask(['Rust'], 'hi')
  t.mind.say('text', LINE)
  t.mind.fail(new Error('the local model server failed (500)'))
  const f = await within(failed.result)
  assert.deepEqual([f.text, f.act, f.error], [LINE, undefined, 'the local model server failed (500)'])
  const refusal = t.op.ask(['Rust'], 'hi')
  t.mind.say('text', 'ACTION: time 22:00')
  t.mind.finish('ACTION: time 22:00', 'refusal')
  const d = await within(refusal.result)
  assert.deepEqual([d.text, d.act, d.disengaged], ['ACTION: time 22:00', undefined, true])
  assert.deepEqual([t.op.acts.pending(), t.op.acts.log(), t.sim.calls], [null, [], []])
  assert.deepEqual(t.notes, [`ask hi → ${LINE} (Authorized) cut`, `ask hi → ${LINE} (Authorized) stopped`, `ask hi → ${LINE} (Authorized) failed`], 'noted as they came, nothing proposed')
  assert.equal(t.gate.requests.length, 4, 'the four asks; no proposal')
  // A whole answer, by contrast, proposes: the line is read, stripped and noted.
  const whole = t.op.ask(['Rust'], 'hi')
  t.mind.say('text', LINE)
  t.mind.finish(LINE)
  const w = await within(whole.result)
  assert.deepEqual([w.text, w.act?.kind, t.op.acts.pending()?.sentence], ['ok', 'proposed', 'set the clock to 22:00'])
  assert.equal(t.notes.at(-1), 'ask hi → ok (proposed: set the clock to 22:00) (Authorized) answered')
  assert.equal(t.gate.requests.length, 6, 'the ask and its proposal')
})

test("the stand-in never proposes: the script answering in a model's place keeps its line, is noted nowhere and the keeper is never asked; the scripted provider chosen on purpose does propose", async () => {
  const t = tier()
  const standIn = t.op.ask(['Rust'], 'hi')
  t.mind.say('text', LINE)
  t.mind.finish(LINE, 'scripted', 'no model is answering on this machine')
  const s = await within(standIn.result)
  assert.deepEqual([s.text, s.act, s.standIn], [LINE, undefined, 'no model is answering on this machine'])
  assert.deepEqual([t.op.acts.pending(), t.op.acts.log(), t.sim.calls, t.notes, t.moments], [null, [], [], [], []])
  assert.equal(t.gate.requests.length, 1, 'the ask alone')
  // The scripted provider chosen on purpose answers with the same reason and no stand-in: a whole answer, read as one.
  const chosen = t.op.ask(['Rust'], 'hi')
  t.mind.say('text', LINE)
  t.mind.finish(LINE, 'scripted')
  const w = await within(chosen.result)
  assert.deepEqual([w.text, w.act?.kind, t.op.acts.pending()?.sentence], ['ok', 'proposed', 'set the clock to 22:00'])
  assert.equal(t.notes.at(-1), 'ask hi → ok (proposed: set the clock to 22:00) (Authorized) answered')
})

test("a swarm step's line is text: the orchestrator's ask never proposes, the step keeps its line, the keeper writes nothing", async () => {
  const t = tier()
  const run = t.op.swarm.run('name the parts', 1)
  for (let i = 0; i < 50 && !t.mind.asked.length; i++) await ticks()
  assert.equal(t.mind.asked.length, 1)
  t.mind.say('text', 'The parts are three.\nACTION: time 22:00')
  t.mind.finish('The parts are three.\nACTION: time 22:00')
  const r = await within(run.result)
  assert.deepEqual(r.steps.map((s) => [s.state, s.text]), [['answered', 'The parts are three.\nACTION: time 22:00']])
  assert.deepEqual([t.op.acts.pending(), t.op.acts.log(), t.sim.calls], [null, [], []])
  assert.equal(t.gate.requests.length, 1, 'one task: the step; no proposal')
  // The step's moment is the answer as it came, line and all (what every ask remembers); nothing of a proposal.
  assert.equal(t.moments.length, 1)
  assert.ok(t.moments[0].endsWith('and you answered "The parts are three.\nACTION: time 22:00"'), t.moments[0])
  assert.doesNotMatch(t.moments[0], /propos/)
  assert.deepEqual(t.notes.filter((n) => n.startsWith('run')), [], 'no run episode either')
})

test('no proposal waits past a lock: lock withdraws it in the chain and the memory, the OK is refused as locked, and nothing ran', async () => {
  const t = tier()
  const a = t.op.ask(['Rust'], 'hi')
  t.mind.say('text', 'ok\nACTION: quality lite')
  t.mind.finish('ok\nACTION: quality lite')
  assert.equal((await within(a.result)).act?.kind, 'proposed')
  assert.equal(t.op.acts.pending()?.sentence, 'set the quality to Lite')
  t.op.lock()
  assert.deepEqual([t.op.unlocked(), t.op.acts.pending()], [false, null])
  assert.deepEqual(rows(t.op.acts), ['step act-1 [] proposed: set the quality to Lite', `stop act-1 [HumanOverrideSupreme] withdrawn: ${TIER_LOCKED}`])
  assert.deepEqual(t.moments.at(-1), '7 the player: withdrew your proposal: set the quality to Lite (operator lock)')
  assert.throws(() => t.op.acts.allow('console'), /^Error: act: locked; type 'operator unlock' first$/)
  assert.deepEqual(t.sim.calls, [])
  // Locked with nothing waiting: lock is idempotent, the log is readable, the catalogue too.
  t.op.lock()
  assert.equal(t.op.acts.log().length, 2)
  assert.equal(t.op.acts.list().length, 7)
  // Unlocked again, the floor is free: a new ask proposes act 2.
  t.op.unlock()
  const b = t.op.ask(['Rust'], 'hi')
  t.mind.say('text', LINE)
  t.mind.finish(LINE)
  assert.equal((await within(b.result)).act?.kind === 'proposed' ? t.op.acts.pending()?.seq : 0, 2)
  assert.throws(() => t.op.ask(['Rust'], 'again'), new RegExp(`^Error: ${PROPOSAL_WAITING}$`))
})
