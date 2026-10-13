// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the operator tier's isolation and its runner: the ScriptApi facade
 * is structurally free of every safety-layer member at any depth (no blindSensing, laws, bouncer,
 * sanctuary, apply, world), shares no object with the engine's SimControls, and is frozen through and
 * through, and so is the leased facade a gated script gets, every call of which goes through its lease;
 * `exec` captures console output, returns values, catches throws, supports `await`, times out, stops at once
 * when its signal aborts and never throws; `gatedExec` never runs a rejected script, starts an authorized one
 * in the same step and reports an abort at once; `gatedSay` never reaches the speech server when rejected, starts the
 * speech only through the lease at the first person bound, and cuts it the moment the tether breaks; the diary notes
 * every task for the people bound and answers carry what they remember; the API docs match the facade; the bridge
 * surface refuses everything while locked and runs every script, prompt and utterance through the gate. (The real
 * gateway, 08_Swarm/taskRouter.ts, is proven against this tier in 08_Swarm/taskRouter.test.ts.)
 * What breaks if it is removed? A member leaking an engine reference, or a script escaping the sandbox's
 * shape or its tether, would only be found by an operator.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_TIMEOUT_MS, SAY_CHARS, apiDoc, describe, exec, formatValue, gatedAsk, gatedExec, gatedSay, leasedApi, operatorBridge, scriptApi, speakable,
  type Answer, type Diary, type GateHandle, type GateLease, type GateTether, type GateVerdict, type Memories, type Mind, type Piece, type RunState,
  type ScriptApi, type SimControls, type SkillGate, type SpeechClip, type SpeechOut, type Utterance, type Voice,
} from './operator.ts'
import type { SipocSnapshot } from '../05_Observe_Environment/telemetry.ts'

/**
 * A stand-in for the capability gateway with its contract: it authorizes every request on one tether (agent 7) unless
 * told to reject, calls the task at once, refuses any use once the tether is dropped or the task has ended, and
 * `drop()` breaks the newest lease (state first, then the signal, then the verdict). `slip()` takes the tether out of
 * the newest copy of the swarm without a state saying so yet: like the real gateway's, the next `use` finds it gone,
 * breaks the lease there and then, and refuses.
 */
class FakeGate implements SkillGate {
  readonly requests: string[][] = []
  reject: string | null = null
  #drop: ((message: string) => void) | null = null
  #slip: (() => void) | null = null
  submit<T>(requires: readonly string[], task: (lease: GateLease) => T | PromiseLike<T>): GateHandle<T> {
    this.requests.push([...requires])
    if (this.reject !== null) {
      const message = this.reject
      return { state: 'Rejected', lease: null, verdict: Promise.resolve({ state: 'Rejected', message }) }
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
      bound: [{ agent: 7, serial: 1, skills: [...requires] }],
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
    return { get state() { return state }, lease, verdict }
  }
  drop(message = 'agent 7 (Rust): no longer tethered to the operator'): void {
    this.#drop?.(message)
  }
  slip(): void {
    this.#slip?.()
  }
}

/**
 * A stand-in for the local model with its contract (the real one, 09_Cognition/localCompute.ts, is proven there): the
 * test pushes pieces through the answer's own `onPiece` (`say`), finishes or fails it, and sees the signal it was
 * given; like the real one, it stops the moment the signal aborts.
 */
class FakeMind implements Mind {
  server = 'http://localhost:11434'
  model: string | null = 'test-model'
  readonly asked: { tethers: readonly GateTether[]; prompt: string }[] = []
  /** What the newest request carried of the bound people's memories. */
  memories: readonly Memories[] | undefined = undefined
  signal: AbortSignal | null = null
  #piece: ((p: Piece) => void) | null = null
  #finish: ((a: Answer) => void) | null = null
  #fail: ((e: unknown) => void) | null = null
  settings() {
    return { server: this.server, model: this.model }
  }
  setServer(url: string): string {
    if (!url.startsWith('http://localhost')) throw new Error(`the local model server must be on this machine, not '${url}'`)
    return (this.server = url)
  }
  setModel(name: string): string {
    return (this.model = name)
  }
  installed(): Promise<string[]> {
    return Promise.resolve(['a-model', 'test-model'])
  }
  answer(req: { tethers: readonly GateTether[]; prompt: string; signal: AbortSignal; memories?: readonly Memories[] }, onPiece: (p: Piece) => void): Promise<Answer> {
    this.asked.push({ tethers: req.tethers, prompt: req.prompt })
    this.memories = req.memories
    this.signal = req.signal
    return new Promise<Answer>((resolve, reject) => {
      this.#piece = onPiece
      this.#finish = resolve
      this.#fail = reject
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true })
    })
  }
  /** One piece through the answer's own onPiece; what it throws (a lease refusing) ends the answer, as in the real one. */
  say(kind: Piece['kind'], text: string): void {
    try {
      this.#piece?.({ kind, text })
    } catch (e) {
      this.#fail?.(e)
    }
  }
  finish(text: string, reason = 'stop'): void {
    this.#finish?.({ text, thinking: 0, tokens: 7, reason })
  }
  fail(e: unknown): void {
    this.#fail?.(e)
  }
}

interface FakeSim extends SimControls {
  calls: string[]
  /** Objects a real engine would hold behind these methods; none may be reachable from the facade. */
  secrets: object[]
  tune: Record<string, number>
  uniforms: Record<string, number>
}

function fakeSim(): FakeSim {
  const calls: string[] = []
  const rec = (s: string) => { calls.push(s) }
  const bouncer = { vet: () => 0, counts: { 1: 0, 2: 0, 3: 0 }, holding: () => false }
  const sanctuary = { guard: () => [], flips: 0 }
  const laws = [{ id: 1, title: 'x', text: 'y' }]
  const world = { step: () => {} }
  const fleet = { apply: () => {}, bouncer, setPersonHazards: () => {}, setAvatar: () => {} }
  const kernelStats = { law1: 1, law2: 0, law3: 0, sensorFlips: 2, shielded: false, last: 'First Law: person 3.0 m ahead', audit: { ticks: 0, perimeterBreaches: 0, velocityCaps: 0, closest: Infinity, panic: null } }
  const crowdStats = { drawnNear: 1, drawnFar: 2, nudges: 0, waiting: 0, crossing: 0, retreating: 0 }
  // The engine's own copy of where the crowd stands: the facade must hand scripts a copy of it, never this array.
  const crowdXZ = Float32Array.from([0, 0, 12.5, 5.75])
  const tune: Record<string, number> = { 'car.power': 1, 'car.drag': 1 }
  const uniforms: Record<string, number> = { 'light.haze': 1, 'volumetrics.strength': 1 }
  const sim: FakeSim = {
    calls, tune, uniforms,
    secrets: [bouncer, sanctuary, laws, world, fleet, kernelStats, crowdStats, tune, uniforms],
    clock: { hours: () => { rec('clock.hours'); return 17.5 }, set: (h) => rec(`clock.set ${h}`) },
    quality: {
      state: () => ({ tier: 3, label: 'High', auto: true, renderScale: 1, targetMs: 16.7 }),
      set: (t) => rec(`quality.set ${t}`),
    },
    avatar: {
      position: () => ({ x: 1, z: 2, heading: 3, feetY: 0 }),
      teleport: (x, z, yaw) => rec(`avatar.teleport ${x} ${z} ${yaw}`),
      interact: () => rec('avatar.interact'),
      walk: (vx, vz, ms) => rec(`avatar.walk ${vx} ${vz} ${ms}`),
    },
    vehicles: {
      count: () => 2,
      state: (i) => ({ x: i, z: 0, heading: 0, speed: 5, mode: 'ai', suv: false }),
      setMode: (i, m) => rec(`vehicles.setMode ${i} ${m}`),
      recover: (i, x, z, h) => rec(`vehicles.recover ${i} ${x} ${z} ${h}`),
      intent: (i, t, b, s) => rec(`vehicles.intent ${i} ${t} ${b} ${s}`),
      nearest: (x, z) => { rec(`vehicles.nearest ${x} ${z}`); return 1 },
    },
    physics: {
      tune: () => tune,
      set: (k, v) => { if (!Object.hasOwn(tune, k)) throw new Error(`unknown physics key '${k}'`); tune[k] = v },
    },
    shaders: {
      uniforms: () => uniforms,
      set: (k, v) => { if (!Object.hasOwn(uniforms, k)) throw new Error(`unknown shader key '${k}'`); uniforms[k] = v },
    },
    crowd: { stats: () => crowdStats, cull: (c) => rec(`crowd.cull ${JSON.stringify(c)}`), positions: () => crowdXZ },
    kernel: { stats: () => kernelStats, blindSensing: (on, ttl) => rec(`kernel.blindSensing ${on} ${ttl}`) },
    snapshot: () => ({ kernel: kernelStats, customer: { clock: '17:30' } } as unknown as SipocSnapshot),
  }
  // A careless engine could leave references hanging off its SimControls; the facade must not copy them.
  Object.assign(sim.kernel, { bouncer, sanctuary })
  Object.assign(sim.vehicles, { fleet, apply: fleet.apply })
  Object.assign(sim.physics, { world })
  Object.assign(sim, { laws, engine: { fleet, world } })
  return sim
}

/** `p`, or a failure if it has not settled within `ms`: a stop or an abort that does not end anything must fail here, not hang the run. */
const within = <T,>(p: Promise<T>, ms = 2000): Promise<T> => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms))])

/** The engine calls a fake has seen so far (read through a call, so an earlier assertion cannot narrow the list away). */
const callsOf = (sim: FakeSim): string[] => sim.calls

/** Every object and function reachable through own properties (string and symbol keys), with the keys seen. */
function graph(root: unknown): { objects: Set<object>; keys: Set<string> } {
  const objects = new Set<object>()
  const keys = new Set<string>()
  const stack: unknown[] = [root]
  while (stack.length) {
    const v = stack.pop()
    if ((typeof v !== 'object' && typeof v !== 'function') || v === null || objects.has(v)) continue
    objects.add(v)
    for (const k of Reflect.ownKeys(v)) {
      keys.add(String(k))
      const d = Object.getOwnPropertyDescriptor(v, k)
      if (d && 'value' in d) stack.push(d.value)
      if (d?.get) stack.push(d.get)
      if (d?.set) stack.push(d.set)
    }
  }
  return { objects, keys }
}

const FORBIDDEN = [
  'blindSensing', 'laws', 'bouncer', 'sanctuary', 'apply', 'world', 'fleet', 'engine', 'guard', 'vet', 'adjudicate',
  'setPersonHazards', 'setAvatar', 'nudge', 'setSensor', 'body', 'collider', 'controller', 'compute', 'physicsWorld',
]

test('scriptApi: no safety-layer member at any depth, no prototype tricks, nothing shared with the engine', () => {
  const sim = fakeSim()
  const api = scriptApi(sim)
  const facade = graph(api)
  for (const name of FORBIDDEN) assert.ok(!facade.keys.has(name), `facade exposes '${name}'`)
  // Only plain objects and plain functions: no class instances, no custom prototypes.
  for (const o of facade.objects) {
    const proto = Object.getPrototypeOf(o)
    assert.ok(proto === Object.prototype || proto === Function.prototype, `unexpected prototype on a facade member`)
    if (typeof o === 'function') assert.ok(!Object.hasOwn(o, 'prototype'), 'a facade function has a prototype (not an arrow)')
  }
  // Nothing reachable from the facade is an object the engine holds (including the extras hung off SimControls).
  const engine = graph(sim)
  for (const s of sim.secrets) engine.objects.add(s)
  for (const o of facade.objects) assert.ok(!engine.objects.has(o), 'the facade shares an object with SimControls')
  assert.deepEqual(Object.keys(api).sort(), ['avatar', 'clock', 'crowd', 'kernel', 'physics', 'quality', 'shaders', 'snapshot', 'vehicles'])
  assert.deepEqual(Object.keys(api.kernel), ['stats'])
  assert.deepEqual(Object.keys(api.vehicles).sort(), ['count', 'intent', 'nearest', 'recover', 'setMode', 'state'])
  assert.equal((api.kernel as { blindSensing?: unknown }).blindSensing, undefined)
  assert.ok(!('blindSensing' in api.kernel))
})

test('scriptApi: frozen at every depth; members cannot be added, replaced, removed or decorated', () => {
  const api = scriptApi(fakeSim())
  for (const o of graph(api).objects) assert.ok(Object.isFrozen(o), 'a facade member is not frozen')
  const loose = api as unknown as Record<string, Record<string, unknown>>
  assert.throws(() => { loose.kernel.blindSensing = () => {} }, TypeError)
  assert.throws(() => { loose.clock.hours = () => 0 }, TypeError)
  assert.throws(() => { (loose as Record<string, unknown>).laws = [] }, TypeError)
  assert.throws(() => { delete loose.vehicles.intent }, TypeError)
  assert.throws(() => { Object.defineProperty(api.vehicles, 'apply', { value: 1 }) }, TypeError)
  assert.throws(() => { (api.clock.set as unknown as Record<string, unknown>).leak = 1 }, TypeError)
  assert.throws(() => { Object.setPrototypeOf(api.kernel, { blindSensing: () => {} }) }, TypeError)
  assert.equal(typeof (api.kernel as { blindSensing?: unknown }).blindSensing, 'undefined')
})

test('scriptApi forwards plain values, validates its inputs and hands back copies', () => {
  const sim = fakeSim()
  const api = scriptApi(sim)
  api.clock.set('9' as unknown as number)
  api.quality.set('auto')
  api.quality.set('2' as unknown as number)
  api.avatar.teleport(1, 2)
  api.avatar.teleport('3' as unknown as number, 4, 0.5)
  api.avatar.interact()
  api.vehicles.setMode(0, 'parked')
  api.vehicles.recover(1)
  api.vehicles.recover(1, 5, 6, 0)
  api.vehicles.intent('1' as unknown as number, '0.5' as unknown as number, 0, '0.1' as unknown as number)
  assert.equal(api.vehicles.nearest(7, 8), 1)
  api.crowd.cull({ density: 0.5, lodDistance: '20' as unknown as number, bogus: 1 } as { density: number })
  assert.equal(api.clock.hours(), 17.5)
  assert.deepEqual(sim.calls, [
    'clock.set 9', 'quality.set auto', 'quality.set 2', 'avatar.teleport 1 2 undefined', 'avatar.teleport 3 4 0.5', 'avatar.interact',
    'vehicles.setMode 0 parked', 'vehicles.recover 1 undefined undefined undefined', 'vehicles.recover 1 5 6 0',
    'vehicles.intent 1 0.5 0 0.1', 'vehicles.nearest 7 8', 'crowd.cull {"density":0.5,"lodDistance":20}', 'clock.hours',
  ])
  assert.throws(() => api.vehicles.setMode(0, 'player' as unknown as 'ai'), /mode must be 'ai' or 'parked'/)
  assert.throws(() => api.crowd.cull(null as unknown as { density: number }), TypeError)
  // Tuning writes reach the engine (which validates keys); reads are copies.
  api.physics.set('car.power', '2' as unknown as number)
  assert.equal(sim.tune['car.power'], 2)
  assert.throws(() => api.physics.set('car.nope', 1), /unknown physics key/)
  assert.throws(() => api.shaders.set('nope', 1), /unknown shader key/)
  const t = api.physics.tune()
  t['car.power'] = 99
  t.injected = 1
  assert.equal(sim.tune['car.power'], 2)
  assert.equal(sim.tune.injected, undefined)
  const k = api.kernel.stats()
  k.law1 = 999
  assert.equal(sim.kernel.stats().law1, 1)
  const c = api.crowd.stats()
  c.drawnNear = 999
  assert.equal(sim.crowd.stats().drawnNear, 1)
  assert.notEqual(api.quality.state(), api.quality.state())
  // Non-finite or non-numeric arguments never reach the engine, which does not guard every path
  // (NaN hours break the sun; a NaN pose puts a Rapier body or the avatar's head at NaN).
  const before = sim.calls.length
  assert.throws(() => api.clock.set(NaN), /^TypeError: hours must be a finite number$/)
  assert.throws(() => api.clock.set(Infinity), TypeError)
  assert.throws(() => api.clock.set(undefined as unknown as number), TypeError)
  assert.throws(() => api.clock.set(null as unknown as number), TypeError)
  assert.throws(() => api.clock.set('' as unknown as number), TypeError)
  assert.throws(() => api.clock.set(true as unknown as number), TypeError)
  assert.throws(() => api.quality.set(NaN), /tier .* must be a finite number/)
  assert.throws(() => api.avatar.teleport(1, 'far' as unknown as number), /z must be a finite number/)
  assert.throws(() => api.avatar.teleport(1, 2, NaN), /yaw must be a finite number/)
  assert.throws(() => api.vehicles.recover(0, 1, 2, -Infinity), /heading must be a finite number/)
  assert.throws(() => api.vehicles.intent(0, NaN, 0, 0), /throttle must be a finite number/)
  assert.throws(() => api.vehicles.state({} as unknown as number), /vehicle index must be a finite number/)
  assert.throws(() => api.vehicles.nearest([] as unknown as number, 0), TypeError)
  assert.throws(() => api.physics.set('car.power', NaN), /physics\.car\.power must be a finite number/)
  assert.throws(() => api.shaders.set('light.haze', undefined as unknown as number), TypeError)
  assert.throws(() => api.crowd.cull({ density: NaN }), /cull\.density must be a finite number/)
  assert.equal(sim.calls.length, before)
  assert.equal(sim.tune['car.power'], 2)
  // The snapshot nests: it is structured-cloned, so the engine's objects behind it are never the script's.
  const snap = api.snapshot()
  snap.kernel.law1 = 999
  assert.equal(sim.kernel.stats().law1, 1)
  assert.equal(api.snapshot().kernel.law1, 1)
  assert.notEqual(snap.kernel, sim.snapshot().kernel)
  assert.equal(snap.customer.clock, '17:30')
})

test('exec: expression values, statement bodies with return, sim in scope', async () => {
  const api = scriptApi(fakeSim())
  assert.deepEqual(strip(await exec('1 + 1', api)), { value: '2', logs: [] })
  assert.equal((await exec('sim.clock.hours()', api)).value, '17.5')
  assert.equal((await exec('sim.avatar.position()', api)).value, '{"x":1,"z":2,"heading":3,"feetY":0}')
  assert.equal((await exec('const n = sim.vehicles.count(); return n * 10', api)).value, '20')
  assert.equal((await exec('let x = 1; x++', api)).value, 'undefined')
  assert.equal((await exec('', api)).value, 'undefined')
  assert.equal((await exec('   \n  ', api)).value, 'undefined')
  assert.equal((await exec('({ a: 1 })', api)).value, '{"a":1}')
  assert.equal((await exec('{ a: 1 }', api)).value, '{"a":1}')
  assert.equal((await exec('"text"', api)).value, 'text')
  assert.equal((await exec('[1, 2].map((v) => v * 2)', api)).value, '[2,4]')
  assert.equal((await exec('1 // trailing comment', api)).value, '1')
  const r = await exec('sim.clock.set(9)', api)
  assert.equal(r.error, undefined)
  assert.ok(Number.isFinite(r.ms) && r.ms >= 0)
  // No value is flagged `empty`; the string "undefined" (typeof, say) is a value and is not.
  assert.deepEqual(strip(r), { value: 'undefined', logs: [] })
  assert.equal(r.empty, true)
  assert.equal((await exec('undefined', api)).empty, true)
  assert.equal((await exec('let x = 1; x++', api)).empty, true)
  const typed = await exec('typeof sim.kernel.blindSensing', api)
  assert.equal(typed.value, 'undefined')
  assert.equal(typed.empty, undefined)
  assert.equal((await exec('"undefined"', api)).empty, undefined)
  assert.equal((await exec('null', api)).empty, undefined)
  assert.equal((await exec('throw new Error("x")', api)).empty, undefined)
})

test('exec: console is captured, throws and syntax errors are reported, never thrown', async () => {
  const api = scriptApi(fakeSim())
  const r = await exec('console.log("a", 1, { b: 2 }); console.warn("w"); console.error("e"); console.info(null); console.assert(false, "no"); return "done"', api)
  assert.deepEqual(r.logs, ['a 1 {"b":2}', 'warn: w', 'error: e', 'null', 'assert: no'])
  assert.equal(r.value, 'done')
  assert.equal(r.error, undefined)
  const thrown = await exec('console.log("before"); throw new RangeError("bad")', api)
  assert.deepEqual(strip(thrown), { value: '', logs: ['before'], error: 'RangeError: bad' })
  assert.match((await exec('nope()', api)).error ?? '', /^ReferenceError: nope is not defined$/)
  assert.match((await exec('return (', api)).error ?? '', /^SyntaxError: /)
  assert.match((await exec('let let = 1', api)).error ?? '', /^SyntaxError: /)
  assert.equal((await exec('throw "plain"', api)).error, 'plain')
  assert.equal((await exec('throw new Error("just a message")', api)).error, 'just a message')
  // Strict mode: no implicit globals.
  assert.match((await exec('undeclaredLeak = 1', api)).error ?? '', /ReferenceError/)
  // Bad inputs are coerced, not thrown.
  assert.equal((await exec(undefined as unknown as string, api)).value, 'undefined')
  assert.equal((await exec('1', null as unknown as ScriptApi)).value, '1')
})

test('exec: await is supported, and a script that overruns the timeout is abandoned with its sleeps cancelled', async () => {
  const api = scriptApi(fakeSim())
  assert.equal((await exec('await Promise.resolve(3)', api)).value, '3')
  assert.equal((await exec('await sleep(1); return await Promise.resolve(7)', api)).value, '7')
  assert.equal((await exec('await sleep(0); sim.clock.hours()', api)).value, 'undefined') // statements: no return
  assert.equal((await exec('await sleep("soon"); await sleep(-5); await sleep(NaN); return 4', api)).value, '4') // lenient: no wait
  const t0 = Date.now()
  const stuck = await exec('await new Promise(() => {})', api, 20)
  assert.match(stuck.error ?? '', /^TimeoutError: script timed out after 20 ms$/)
  assert.ok(Date.now() - t0 < 2000)
  // A long sleep must not keep the process (or the page) busy after the timeout: its timer is cleared.
  const slept = await exec('console.log("start"); await sleep(100000); console.log("never"); return 1', api, 20)
  assert.deepEqual(slept.logs, ['start'])
  assert.match(slept.error ?? '', /timed out/)
  // A rejected script promise after the timeout is swallowed, not an unhandled rejection.
  const late = await exec('await sleep(5); throw new Error("late")', api, 1)
  assert.match(late.error ?? '', /timed out/)
  await new Promise((r) => setTimeout(r, 15))
  assert.ok(DEFAULT_TIMEOUT_MS >= 1000)
  assert.equal((await exec('1', api, NaN)).value, '1')
  assert.equal((await exec('1', api, -5)).value, '1')
})

test('exec: the sandbox shape holds inside a script', async () => {
  const sim = fakeSim()
  const api = scriptApi(sim)
  assert.equal((await exec('typeof sim.kernel.blindSensing', api)).value, 'undefined')
  assert.equal((await exec('Object.keys(sim.kernel)', api)).value, '["stats"]')
  assert.match((await exec('sim.kernel.blindSensing = () => 1', api)).error ?? '', /TypeError/)
  assert.match((await exec('sim.vehicles.apply = () => 1', api)).error ?? '', /TypeError/)
  assert.equal((await exec('typeof sim.laws + typeof sim.engine + typeof sim.vehicles.fleet', api)).value, 'undefinedundefinedundefined')
  assert.equal((await exec('Object.isFrozen(sim) && Object.isFrozen(sim.vehicles.intent)', api)).value, 'true')
  // Bad arguments are the script's error, not the engine's problem.
  assert.equal((await exec('sim.clock.set(NaN)', api)).error, 'TypeError: hours must be a finite number')
  assert.equal((await exec('sim.avatar.teleport()', api)).error, 'TypeError: x must be a finite number')
  assert.equal((await exec('sim.vehicles.recover(0, 1, 2, "north")', api)).error, 'TypeError: heading must be a finite number')
  assert.deepEqual(sim.calls, [])
  // A vehicle intent from a script is just a forwarded, numeric intent (the engine vets it).
  await exec('sim.vehicles.intent(1, 1, 0, 0.2)', api)
  assert.deepEqual(sim.calls, ['vehicles.intent 1 1 0 0.2'])
  assert.deepEqual((sim.calls as string[]).filter((c) => c.startsWith('kernel.blindSensing')), [])
  // A script that mutates what it was handed changes nothing the engine holds.
  await exec('const s = sim.snapshot(); s.kernel.sensorFlips = 42; s.customer.clock = "00:00"', api)
  assert.equal(sim.kernel.stats().sensorFlips, 2)
  assert.equal(sim.snapshot().customer.clock, '17:30')
})

test('formatValue and describe', () => {
  assert.equal(formatValue(undefined), 'undefined')
  assert.equal(formatValue(null), 'null')
  assert.equal(formatValue('str'), 'str')
  assert.equal(formatValue(5), '5')
  assert.equal(formatValue(true), 'true')
  assert.equal(formatValue(NaN), 'NaN')
  assert.equal(formatValue({ a: Infinity, b: -Infinity, c: NaN }), '{"a":"Infinity","b":"-Infinity","c":"NaN"}')
  assert.equal(formatValue([1, undefined, () => {}]), '[1,null,"[Function anonymous]"]')
  assert.equal(formatValue(function named() {}), '[Function named]')
  assert.equal(formatValue(10n), '10n')
  assert.equal(formatValue({ n: 10n }), '{"n":"10n"}')
  assert.equal(formatValue(Symbol('s')), 'Symbol(s)')
  assert.equal(formatValue(new TypeError('x')), 'TypeError: x')
  assert.equal(formatValue(new Error('x')), 'x')
  const cyc: Record<string, unknown> = {}
  cyc.self = cyc
  assert.equal(formatValue(cyc), '[object Object]')
  const long = formatValue('x'.repeat(20_000))
  assert.equal(long.length, 16_385)
  assert.ok(long.endsWith('…'))
  assert.equal(describe('s'), 's')
  assert.equal(describe(new RangeError('r')), 'RangeError: r')
  assert.equal(describe(new Error('')), 'Error')
})

test('apiDoc matches the facade leaf for leaf, plus the helpers in scope; entries are fresh copies', () => {
  const api = scriptApi(fakeSim())
  const docs = apiDoc()
  const leaves: string[] = []
  const walk = (o: object, path: string) => {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'function') leaves.push(`${path}.${k}`)
      else walk(v as object, `${path}.${k}`)
    }
  }
  walk(api, 'sim')
  const documented = docs.filter((d) => d.path.startsWith('sim.')).map((d) => d.path)
  assert.deepEqual(documented.sort(), leaves.sort())
  assert.deepEqual(docs.filter((d) => !d.path.startsWith('sim.')).map((d) => d.path), ['console.log', 'sleep', 'signal'])
  for (const d of docs) {
    assert.ok(d.signature.startsWith(d.path), `${d.path}: signature does not start with its path`)
    assert.ok(d.summary.length > 10 && d.summary.endsWith('.'), `${d.path}: summary`)
    assert.doesNotMatch(`${d.signature} ${d.summary}`, /\b(attack|kill|weapon|target|shoot|gun|violence|injur\w*|damage)\b/i)
  }
  docs[0].summary = 'changed'
  assert.notEqual(apiDoc()[0].summary, 'changed')
})

test('operatorBridge: locked by default; scripts, tuning keys and harnesses refuse until unlock; every script goes through the gate; one harness at a time', async () => {
  const sim = fakeSim()
  const slept: number[] = []
  const gate = new FakeGate()
  const op = operatorBridge(sim, gate, new FakeMind(), async (ms) => { slept.push(ms) })
  assert.ok(Object.isFrozen(op))
  assert.deepEqual(Object.keys(op).sort(), ['api', 'ask', 'askSet', 'askStatus', 'askStop', 'exec', 'harness', 'harnesses', 'lock', 'say', 'saySet', 'sayStatus', 'sayStop', 'tune', 'tuning', 'unlock', 'unlocked'])
  assert.equal(op.unlocked(), false)
  assert.throws(() => op.exec(['Rust'], '1'), /^Error: run: locked; type 'operator unlock' first$/)
  assert.throws(() => op.tuning(), /^Error: get: locked/)
  assert.throws(() => op.tune('physics', 'car.power', 2), /^Error: set: locked/)
  assert.throws(() => op.harness('kernel-stop'), /harness: locked/)
  assert.deepEqual(gate.requests, [], 'nothing reached the gate while locked')
  assert.equal(op.api().length, apiDoc().length)
  assert.deepEqual(op.harnesses().map((h) => h.name), ['kernel-stop', 'first-law-floor', 'sanctuary', 'brake-distance', 'traffic-lights', 'spatial'])
  assert.deepEqual(sim.calls, [])
  op.unlock()
  assert.equal(op.unlocked(), true)
  // A script names its skills and goes through the gate, which decides; nothing else runs one.
  const hours = op.exec(['Rust'], 'sim.clock.hours()')
  assert.deepEqual([hours.state, hours.bound.map((t) => t.agent)], ['Authorized', [7]])
  assert.deepEqual(await hours.result, { value: '17.5', logs: [], ms: (await hours.result).ms, state: 'Authorized' })
  assert.equal((await op.exec(['Rust'], 'typeof sim.kernel.blindSensing').result).value, 'undefined')
  gate.reject = 'nobody tethered to the operator has Networking'
  const no = op.exec(['Networking'], 'sim.clock.set(1)')
  assert.deepEqual([no.state, (await no.result).reason], ['Rejected', 'nobody tethered to the operator has Networking'])
  assert.deepEqual(gate.requests, [['Rust'], ['Rust'], ['Networking']])
  assert.ok(!callsOf(sim).includes('clock.set 1'), 'a rejected script never ran')
  // The tuning keys: read and written through the facade (validated; the engine clamps), no script involved.
  assert.deepEqual(op.tuning(), { physics: { 'car.power': 1, 'car.drag': 1 }, shaders: { 'light.haze': 1, 'volumetrics.strength': 1 } })
  assert.equal(op.tune('physics', 'car.power', 1.5), 1.5)
  assert.equal(op.tune('shaders', 'light.haze', 0.25), 0.25)
  assert.throws(() => op.tune('physics', 'nope', 1), /unknown physics key 'nope'/)
  assert.throws(() => op.tune('physics', 'car.power', Number.NaN), /must be a finite number/)
  assert.throws(() => op.tune('laws' as 'physics', 'x', 1), /no tuning table 'laws'/)
  assert.equal(gate.requests.length, 3, 'get and set never go through a script')
  const first = op.harness('kernel-stop')
  assert.throws(() => op.harness('sanctuary'), /'kernel-stop' is still running/)
  const report = await first
  assert.equal(report.name, 'kernel-stop')
  assert.equal(report.pass, false) // the trivial fake never offers a suitable car
  assert.ok(slept.length > 0)
  const unknown = await op.harness('nope')
  assert.equal(unknown.pass, false)
  assert.match(unknown.lines[0], /unknown harness 'nope'/)
  op.lock()
  assert.equal(op.unlocked(), false)
  assert.throws(() => op.exec(['Rust'], '1'), /locked/)
  assert.throws(() => op.tuning(), /locked/)
})

test('gatedAsk: Rejected never asks the model; Authorized asks at once for the bound tethers; pieces reach followers only while the lease holds', async () => {
  const gate = new FakeGate()
  const mind = new FakeMind()
  gate.reject = 'nobody tethered to the operator has Networking'
  const no = gatedAsk(gate, mind, ['Networking'], 'how do the lights work?')
  assert.deepEqual([no.state, no.bound], ['Rejected', []])
  const nr = await no.result
  assert.deepEqual([nr.state, nr.reason, nr.text], ['Rejected', 'nobody tethered to the operator has Networking', ''])
  assert.deepEqual(mind.asked, [], 'the model was never asked')
  gate.reject = null
  const seen: string[] = []
  const yes = gatedAsk(gate, mind, ['Rust'], 'how does car.grip work?')
  yes.follow((p) => seen.push(`${p.kind}:${p.text}`))
  assert.deepEqual([yes.state, yes.bound.map((t) => t.agent)], ['Authorized', [7]])
  assert.deepEqual(mind.asked, [{ tethers: yes.bound, prompt: 'how does car.grip work?' }], 'asked in the same step, for the bound tethers')
  mind.say('thinking', 'hmm')
  mind.say('text', 'Grip scales ')
  mind.say('text', 'tyre friction.')
  mind.finish('Grip scales tyre friction.')
  const y = await yes.result
  // Text is shown a whole word at a time (each screened first); the last word once the answer has ended.
  assert.deepEqual(seen, ['thinking:hmm', 'text:Grip scales ', 'text:tyre ', 'text:friction.'])
  assert.deepEqual([y.state, y.text, y.thinking, y.done, y.tokens, y.error], ['Authorized', 'Grip scales tyre friction.', 1, 'stop', 7, undefined])
  // The tether breaks mid-answer: Aborted at once with the text before; the model's signal aborted; nothing more shown.
  seen.length = 0
  const cut = gatedAsk(gate, mind, ['Rust'], 'and brakes?')
  cut.follow((p) => seen.push(p.text))
  mind.say('text', 'Brakes ')
  gate.drop()
  assert.equal(mind.signal?.aborted, true, 'the request was cancelled with the lease')
  mind.say('text', 'scale too.')
  const c = await within(cut.result)
  assert.deepEqual([c.state, c.text, c.reason], ['Aborted', 'Brakes ', 'agent 7 (Rust): no longer tethered to the operator'])
  assert.deepEqual(seen, ['Brakes '])
  // The operator's own stop: the tether held, so Authorized, with what arrived and why it ended.
  const stopped = gatedAsk(gate, mind, ['Rust'], 'a long one')
  mind.say('text', 'Once ')
  stopped.stop()
  const s = await within(stopped.result)
  assert.deepEqual([s.state, s.text, s.error, s.stopped], ['Authorized', 'Once ', 'stopped by the operator', true])
  // The server fails: Authorized (the tether held) with its sentence.
  const failed = gatedAsk(gate, mind, ['Rust'], 'anything')
  mind.fail(new Error('no local model server is answering at http://localhost:11434'))
  const f = await within(failed.result)
  assert.deepEqual([f.state, f.error], ['Authorized', 'no local model server is answering at http://localhost:11434'])
})

test('operatorBridge ask: locked, one answer at a time, a model must be chosen; status, settings and stop', async () => {
  const gate = new FakeGate()
  const mind = new FakeMind()
  const op = operatorBridge(fakeSim(), gate, mind)
  assert.throws(() => op.ask(['Rust'], 'hi'), /^Error: ask: locked/)
  assert.throws(() => op.askStatus(), /^Error: ask: locked/)
  assert.throws(() => op.askSet('model', 'x'), /^Error: ask: locked/)
  assert.throws(() => op.askStop(), /^Error: ask: locked/)
  assert.deepEqual(mind.asked, [])
  op.unlock()
  assert.deepEqual(await op.askStatus(), { server: 'http://localhost:11434', model: 'test-model', installed: ['a-model', 'test-model'] })
  assert.equal(op.askSet('model', 'a-model'), 'a-model')
  assert.throws(() => op.askSet('server', 'http://example.com'), /must be on this machine/)
  assert.equal(op.askSet('server', 'http://localhost:12345'), 'http://localhost:12345')
  assert.throws(() => op.askSet('laws' as 'model', 'x'), /nothing to set called 'laws'/)
  assert.equal(op.askStop(), 'no answer is being generated')
  const first = op.ask(['Rust'], 'first')
  assert.throws(() => op.ask(['Rust'], 'second'), /an answer is still coming/)
  assert.equal(op.askStop(), 'stopping the answer')
  assert.equal((await within(first.result)).stopped, true)
  // Free again once the first has ended.
  const again = op.ask(['Rust'], 'again')
  mind.finish('ok')
  assert.equal((await again.result).state, 'Authorized')
  // No model chosen: refused before the gate is asked.
  mind.model = null
  const before = gate.requests.length
  assert.throws(() => op.ask(['Rust'], 'hi'), /choose a model first/)
  assert.equal(gate.requests.length, before)
  // The server did not answer: the status says so instead of failing.
  mind.installed = () => Promise.reject(new Error('no local model server is answering at http://localhost:12345'))
  assert.deepEqual(await op.askStatus(), { server: 'http://localhost:12345', model: null, installed: null, error: 'no local model server is answering at http://localhost:12345' })
})

test('leasedApi: the facade\'s shape, no safety member at any depth, frozen, plain arrows; every call goes through the lease, none once it refuses', () => {
  const sim = fakeSim()
  const api = scriptApi(sim)
  let open = true
  let uses = 0
  const leased = leasedApi(api, {
    use: <R>(act: () => R): R => {
      uses++
      if (!open) throw new DOMException('Spatial tether lost: agent 7 (Rust): no longer tethered to the operator', 'AbortError')
      return act()
    },
  })
  const g = graph(leased)
  for (const name of FORBIDDEN) assert.ok(!g.keys.has(name), `the leased facade exposes '${name}'`)
  for (const o of g.objects) {
    assert.ok(Object.isFrozen(o), 'a leased member is not frozen')
    const proto = Object.getPrototypeOf(o)
    assert.ok(proto === Object.prototype || proto === Function.prototype, 'unexpected prototype on a leased member')
    if (typeof o === 'function') assert.ok(!Object.hasOwn(o, 'prototype'), 'a leased function is not an arrow')
  }
  // Leaf for leaf the same members as the facade, and nothing reachable is the facade's or the engine's.
  const leaves = (o: object, path: string): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === 'function' ? [`${path}.${k}`] : leaves(v as object, `${path}.${k}`)))
  assert.deepEqual(leaves(leased, 'sim'), leaves(api, 'sim'))
  const inner = graph(api)
  const engine = graph(sim)
  for (const o of g.objects) assert.ok(!inner.objects.has(o) && !engine.objects.has(o), 'the leased facade shares an object')
  // Every call goes through the lease, and then through the facade's own validation.
  assert.equal(leased.clock.hours(), 17.5)
  leased.clock.set(9)
  assert.throws(() => leased.clock.set(Number.NaN), /hours must be a finite number/)
  assert.deepEqual(leased.avatar.position(), { x: 1, z: 2, heading: 3, feetY: 0 })
  assert.equal(uses, 4)
  // Once the lease refuses, no call reaches the city, whatever it is.
  open = false
  const before = [...sim.calls]
  for (const call of [() => leased.clock.set(3), () => leased.vehicles.intent(0, 1, 0, 0), () => leased.avatar.teleport(0, 0), () => leased.snapshot()]) {
    assert.throws(call, (e: unknown) => e instanceof DOMException && e.name === 'AbortError')
  }
  assert.deepEqual(sim.calls, before)
})

test('exec with a signal: an abort stops the script at once (sleeps reject, a wait that never ends is left behind), keeping the lines logged before', async () => {
  const api = scriptApi(fakeSim())
  const reason = new DOMException('Spatial tether lost: agent 7 (Rust): no longer tethered to the operator', 'AbortError')
  const started = Date.now()
  const sleeping = new AbortController()
  const slept = exec('console.log("before"); await sleep(60000); console.log("after"); return 1', api, 60_000, sleeping.signal)
  await new Promise((r) => setTimeout(r, 5))
  sleeping.abort(reason)
  const a = await slept
  assert.deepEqual([a.logs, a.error, a.value], [['before'], `AbortError: ${reason.message}`, ''])
  // Not a sleep: a promise that never settles. The result does not wait for it.
  const waiting = new AbortController()
  const forever = exec('console.log("waiting"); await new Promise(() => {})', api, 60_000, waiting.signal)
  waiting.abort(reason)
  const b = await forever
  assert.deepEqual([b.logs, b.error], [['waiting'], `AbortError: ${reason.message}`])
  // The lines are what was logged by then: a script that keeps going after the abort adds nothing to the result.
  const going = new AbortController()
  const keeps = exec('console.log("one"); await new Promise((r) => setTimeout(r, 1)); console.log("two"); return 2', api, 60_000, going.signal)
  going.abort(reason)
  const c = await keeps
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(c.logs, ['one'])
  assert.ok(Date.now() - started < 1000, 'nothing waited for the 60 s sleep or the timeout')
  // The sleeping script is itself woken with the reason (so it can clean up), not left in a sleep that never ends.
  const woken: string[] = []
  const probe = { ...api, clock: { ...api.clock, set: (h: number) => { woken.push(`set ${h}`) } } } as ScriptApi
  const cleanup = new AbortController()
  const tidy = exec('try { await sleep(60000) } catch (e) { sim.clock.set(e.name === "AbortError" ? 1 : 0) }', probe, 60_000, cleanup.signal)
  cleanup.abort(reason)
  await tidy
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(woken, ['set 1'])
  // Already aborted: nothing is compiled or run (a syntax error is not even noticed).
  const done = new AbortController()
  done.abort(reason)
  assert.deepEqual(await exec('this is not javascript (', api, 1000, done.signal), { value: '', logs: [], error: `AbortError: ${reason.message}`, ms: 0 })
  // A signal that never aborts changes nothing.
  assert.equal((await exec('await sleep(1); return 5', api, 1000, new AbortController().signal)).value, '5')
})

test('gatedExec: Rejected never compiles or runs; Authorized starts in the same step on the leased facade; a drop reports Aborted at once and the city hears nothing more', async () => {
  const sim = fakeSim()
  const api = scriptApi(sim)
  const gate = new FakeGate()
  gate.reject = 'nobody tethered to the operator has Networking'
  const no = gatedExec(gate, ['Networking'], 'sim.clock.set(1); this is not javascript (', api)
  assert.deepEqual([no.state, no.bound], ['Rejected', []])
  assert.deepEqual(await no.result, { value: '', logs: [], ms: 0, state: 'Rejected', reason: 'nobody tethered to the operator has Networking' })
  assert.deepEqual(sim.calls, [])
  gate.reject = null
  const yes = gatedExec(gate, ['Rust'], 'sim.clock.set(9); return sim.clock.hours()', api)
  assert.deepEqual(sim.calls, ['clock.set 9', 'clock.hours'], 'the script began inside the decision')
  assert.deepEqual([yes.state, yes.bound.map((t) => t.agent)], ['Authorized', [7]])
  const y = await yes.result
  assert.deepEqual([y.state, y.value, y.reason], ['Authorized', '17.5', undefined])
  // The tether breaks while the script sleeps: Aborted at once, with the reason and the lines before; nothing after.
  sim.calls.length = 0
  const mid = gatedExec(gate, ['Rust'], 'console.log("start"); sim.clock.set(1); await sleep(60000); sim.clock.set(2); return "done"', api)
  gate.drop()
  const m = await mid.result
  assert.deepEqual([m.state, m.logs, m.reason, m.value], ['Aborted', ['start'], 'agent 7 (Rust): no longer tethered to the operator', ''])
  // A script deaf to its signal keeps going on its own, and every sim call it makes is refused.
  const deaf = gatedExec(gate, ['Rust'], 'for (let i = 0; i < 50; i++) await null; sim.clock.set(3); return "late"', api)
  gate.drop()
  assert.equal((await deaf.result).state, 'Aborted')
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(sim.calls, ['clock.set 1'])
  // A script's own error under a held lease is Authorized: the gate authorized it; the script failed on its own.
  const own = await gatedExec(gate, ['Rust'], 'throw new RangeError("bad input")', api).result
  assert.deepEqual([own.state, own.error], ['Authorized', 'RangeError: bad input'])
  // The timeout still ends a script, and with it the lease: the abandoned script cannot reach the city afterwards.
  const slow = await gatedExec(gate, ['Rust'], 'await new Promise((r) => setTimeout(r, 30)); sim.clock.set(4)', api, 5).result
  assert.deepEqual([slow.state, slow.error], ['Authorized', 'TimeoutError: script timed out after 5 ms'])
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(!callsOf(sim).includes('clock.set 4'), 'a timed-out script was cut off with its lease')
  assert.deepEqual(gate.requests, [['Networking'], ['Rust'], ['Rust'], ['Rust'], ['Rust'], ['Rust']])
})

/** The comparable part of an ExecResult (ms varies). */
function strip(r: { value: string; logs: string[]; error?: string }): { value: string; logs: string[]; error?: string } {
  return r.error === undefined ? { value: r.value, logs: r.logs } : { value: r.value, logs: r.logs, error: r.error }
}

// ---------------------------------------------------------------------------------------------------
// Speech and memory

/** The local speech server's contract: the texts it was sent (with their signals); the test decides how each ends. */
class FakeVoice implements Voice {
  voice: string | null = 'v1'
  model: string | null = null
  auto = false
  readonly sent: { text: string; signal: AbortSignal }[] = []
  #reply: { ok: (b: ArrayBuffer) => void; fail: (e: unknown) => void } | null = null
  voicesReply: Promise<string[] | null> = Promise.resolve(['v1', 'v2'])
  settings() {
    return { server: 'http://localhost:8880', model: this.model, voice: this.voice, auto: this.auto }
  }
  setServer(url: string): string {
    if (!url.startsWith('http://localhost')) throw new Error(`the local speech server must be on this machine, not '${url}'`)
    return url
  }
  setModel(name: string): string { return (this.model = name) }
  setVoice(name: string): string { return (this.voice = name) }
  setAuto(on: boolean): boolean { return (this.auto = on) }
  voices(): Promise<string[] | null> { return this.voicesReply }
  synthesize(text: string, signal: AbortSignal): Promise<ArrayBuffer> {
    this.sent.push({ text, signal })
    return new Promise<ArrayBuffer>((ok, fail) => {
      this.#reply = { ok, fail }
      signal.addEventListener('abort', () => fail(signal.reason), { once: true })
    })
  }
  /** The server sends `seconds` of audio (48 000 bytes a second). */
  audio(seconds = 2): void { this.#reply?.ok(new ArrayBuffer(Math.round(seconds * 48000))) }
  fail(e: unknown): void { this.#reply?.fail(e) }
}

/** The soundscape's contract: what it decoded and played, at whom, with which words (for the captions), and every stop. */
class FakeOut implements SpeechOut {
  readonly played: number[] = []
  readonly texts: (string | undefined)[] = []
  stops = 0
  refuse: string | null = null
  #end: (() => void) | null = null
  decode(bytes: ArrayBuffer): Promise<SpeechClip> {
    return this.refuse ? Promise.reject(new Error(this.refuse)) : Promise.resolve({ seconds: bytes.byteLength / 48000 })
  }
  play(_clip: SpeechClip, agent: number, text?: string): Utterance {
    this.played.push(agent)
    this.texts.push(text)
    let end: () => void = () => {}
    const ended = new Promise<void>((r) => { end = r })
    this.#end = end
    return { ended, stop: () => { this.stops++; end() } }
  }
  finish(): void { this.#end?.() }
}

/** Lets pending promise callbacks run. */
const ticks = async (n = 5): Promise<void> => { for (let i = 0; i < n; i++) await Promise.resolve() }

test('gatedSay: Rejected never reaches the speech server; Authorized is said by the first person bound, from where they stand, to the end', async () => {
  const gate = new FakeGate()
  const voice = new FakeVoice()
  const out = new FakeOut()
  gate.reject = 'nobody tethered to the operator has Networking'
  const no = gatedSay(gate, voice, out, ['Networking'], 'over here')
  assert.deepEqual([no.state, no.bound], ['Rejected', []])
  const nr = await no.result
  assert.deepEqual([nr.state, nr.reason], ['Rejected', 'nobody tethered to the operator has Networking'])
  assert.equal(voice.sent.length, 0, 'nothing was sent')
  gate.reject = null
  const yes = gatedSay(gate, voice, out, ['Rust'], 'over here, by the lamp')
  assert.deepEqual([yes.state, yes.bound.map((t) => t.agent)], ['Authorized', [7]])
  assert.deepEqual(voice.sent.map((x) => x.text), ['over here, by the lamp'], 'sent in the same step')
  voice.audio(2.5)
  await ticks()
  assert.deepEqual(out.played, [7], 'played at agent 7')
  assert.deepEqual(out.texts, ['over here, by the lamp'], 'the screened words travel with the clip, for the captions')
  out.finish()
  const y = await within(yes.result)
  assert.deepEqual([y.state, y.speaker?.agent, y.seconds, y.error], ['Authorized', 7, 2.5, undefined])
  assert.equal(out.stops, 0)
})

test('gatedSay: the tether breaks while it downloads (never played) or mid-word (cut at once); the operator stops it; failures are sentences', async () => {
  const gate = new FakeGate()
  const voice = new FakeVoice()
  const out = new FakeOut()
  // While the audio is on its way: the request is cancelled and nothing is said.
  const a = gatedSay(gate, voice, out, ['Rust'], 'one')
  gate.drop()
  assert.equal(voice.sent[0].signal.aborted, true, 'the request was cancelled with the lease')
  const ar = await within(a.result)
  assert.deepEqual([ar.state, ar.reason], ['Aborted', 'agent 7 (Rust): no longer tethered to the operator'])
  assert.deepEqual(out.played, [])
  // Mid-word: the speech stops in the same step as the drop.
  const b = gatedSay(gate, voice, out, ['Rust'], 'two')
  voice.audio()
  await ticks()
  assert.deepEqual(out.played, [7])
  gate.drop()
  assert.equal(out.stops, 1, 'cut the moment the tether broke')
  const br = await within(b.result)
  assert.deepEqual([br.state, br.seconds], ['Aborted', 2])
  // The operator's own stop, mid-word: the tether held, so Authorized, and stopped.
  const c = gatedSay(gate, voice, out, ['Rust'], 'three')
  voice.audio()
  await ticks()
  c.stop()
  assert.equal(out.stops, 2)
  const cr = await within(c.result)
  assert.deepEqual([cr.state, cr.error, cr.stopped], ['Authorized', 'stopped by the operator', true])
  // The server fails; the soundscape cannot sound: Authorized, with the sentence.
  const d = gatedSay(gate, voice, out, ['Rust'], 'four')
  voice.fail(new Error('no local speech server is answering at http://localhost:8880'))
  const dr = await within(d.result)
  assert.deepEqual([dr.state, dr.error], ['Authorized', 'no local speech server is answering at http://localhost:8880'])
  out.refuse = "the city's sound is off: type audio on"
  const e = gatedSay(gate, voice, out, ['Rust'], 'five')
  voice.audio()
  assert.equal((await within(e.result)).error, "the city's sound is off: type audio on")
  assert.equal(out.played.length, 2, 'nothing more was played')
})

test('gatedSay: speech starts only through the lease: a tether already gone from the newest copy of the swarm is never spoken for', async () => {
  const gate = new FakeGate()
  const voice = new FakeVoice()
  const out = new FakeOut()
  const s = gatedSay(gate, voice, out, ['Rust'], 'over here')
  voice.audio()
  // The audio is decoding; the person is no longer tethered, and no state has said so yet.
  gate.slip()
  const r = await within(s.result)
  assert.deepEqual(out.played, [], 'the check and the start are one step: nothing was said')
  assert.deepEqual([r.state, r.reason], ['Aborted', 'agent 7 (Rust): no longer tethered to the operator'])
})

test('operatorBridge say: locked, no speech on the page, no voice, one at a time; status, settings (auto on|off only) and stop', async () => {
  const gate = new FakeGate()
  const voice = new FakeVoice()
  const out = new FakeOut()
  const none = operatorBridge(fakeSim(), gate, new FakeMind())
  none.unlock()
  assert.throws(() => none.say(['Rust'], 'hi'), /speech is not available on this page/)
  const op = operatorBridge(fakeSim(), gate, new FakeMind(), undefined, { voice, speech: out })
  for (const call of [() => op.say(['Rust'], 'hi'), () => op.sayStatus(), () => op.saySet('voice', 'v2'), () => op.sayStop()]) assert.throws(call, /^Error: say: locked/)
  assert.equal(voice.sent.length, 0)
  op.unlock()
  assert.deepEqual(await op.sayStatus(), { server: 'http://localhost:8880', model: null, voice: 'v1', auto: false, speaking: false, voices: ['v1', 'v2'] })
  assert.equal(op.saySet('voice', 'v2'), 'v2')
  assert.equal(op.saySet('model', 'open-tts'), 'open-tts')
  assert.equal(op.saySet('auto', 'on'), 'on: answers are said aloud by whoever gives them')
  assert.equal(op.saySet('auto', 'off'), 'off')
  assert.throws(() => op.saySet('auto', 'yes'), /say auto takes on or off/)
  assert.throws(() => op.saySet('server', 'http://example.com'), /must be on this machine/)
  assert.throws(() => op.saySet('laws' as 'voice', 'x'), /nothing to set called 'laws'/)
  assert.equal(op.sayStop(), 'nothing is being said')
  const first = op.say(['Rust'], 'first')
  assert.throws(() => op.say(['Rust'], 'second'), /something is still being said/)
  assert.equal((await op.sayStatus()).speaking, true)
  assert.equal(op.sayStop(), 'stopping the speech')
  assert.equal((await within(first.result)).stopped, true)
  const again = op.say(['Rust'], 'again')
  voice.audio()
  await ticks()
  out.finish()
  assert.equal((await within(again.result)).state, 'Authorized')
  voice.voice = null
  const before = gate.requests.length
  assert.throws(() => op.say(['Rust'], 'hi'), /choose a voice first/)
  assert.equal(gate.requests.length, before, 'refused before the gate is asked')
  voice.voicesReply = Promise.reject(new Error('no local speech server is answering at http://localhost:8880'))
  assert.equal((await op.sayStatus()).error, 'no local speech server is answering at http://localhost:8880')
})

test('the diary: every run, ask and say is noted for the people it was bound to, as they name their skills; an answer carries what they remember', async () => {
  const gate = new FakeGate()
  const mind = new FakeMind()
  const voice = new FakeVoice()
  const out = new FakeOut()
  const notes: string[] = []
  const diary: Diary = {
    recall: (agent) => (agent === 7 ? ['2 h ago: you were asked over for Rust and joined the operator'] : []),
    note: (bound, kind, skills, text, state) => notes.push(`${bound.map((t) => `${t.agent}#${t.serial}`).join('+')} ${kind} [${skills.join(',')}] ${text} (${state})`),
  }
  const op = operatorBridge(fakeSim(), gate, mind, undefined, { voice, speech: out, diary })
  op.unlock()
  await op.exec(['rust'], 'sim.clock.hours()\n// second line').result
  const asked = op.ask(['RUST'], 'how does grip work?\nbriefly')
  assert.deepEqual(mind.memories, [{ agent: 7, lines: ['2 h ago: you were asked over for Rust and joined the operator'] }])
  mind.say('text', 'Grip scales tyre friction.')
  mind.finish('Grip scales tyre friction.')
  await asked.result
  const said = op.say(['rust'], 'over here')
  gate.drop()
  await said.result
  gate.reject = 'nobody tethered to the operator has Go'
  await op.exec(['Go'], '1').result
  await ticks()
  // The fake gate binds agent 7 with exactly the skills asked for, so they name them as asked.
  assert.deepEqual(notes, [
    '7#1 run [rust] sim.clock.hours() (Authorized)',
    '7#1 ask [RUST] how does grip work? → Grip scales tyre friction. (Authorized)',
    '7#1 say [rust] over here (Aborted)',
    ' run [Go] 1 (Rejected)',
  ])
})

test('the diary is told how each task ended (what the memory learns from), and a line the 14A screen kept unsaid is not noted at all', async () => {
  const gate = new FakeGate()
  const mind = new FakeMind()
  const voice = new FakeVoice()
  const out = new FakeOut()
  const notes: string[] = []
  const diary: Diary = {
    recall: () => [],
    note: (_bound, kind, _skills, text, state, _at, _hash, outcome) => notes.push(`${kind} ${text} (${state}) ${outcome ?? '-'}`),
  }
  const op = operatorBridge(fakeSim(), gate, mind, undefined, { voice, speech: out, diary })
  op.unlock()
  await op.exec(['rust'], '1 + 1').result
  await op.exec(['rust'], 'throw new Error("no")').result
  const answered = op.ask(['rust'], 'q1')
  mind.say('text', 'A.')
  mind.finish('A.')
  await answered.result
  const cut = op.ask(['rust'], 'q2')
  mind.say('text', 'B')
  mind.finish('B', 'length')
  await cut.result
  const failed = op.ask(['rust'], 'q3')
  mind.fail(new Error('the local model server failed (500)'))
  await failed.result
  const said = op.say(['rust'], 'over here')
  voice.audio()
  await ticks()
  out.finish()
  await said.result
  const refused = op.say(['rust'], 'shut up, idiot')
  const r = await refused.result
  assert.equal(r.silent, true)
  gate.reject = 'nobody tethered to the operator has Go'
  await op.exec(['Go'], '1').result
  await ticks()
  assert.deepEqual(notes, [
    'run 1 + 1 (Authorized) ok',
    'run throw new Error("no") (Authorized) error',
    'ask q1 → A. (Authorized) answered',
    'ask q2 → B (Authorized) cut',
    'ask q3 →  (Authorized) failed',
    'say over here (Authorized) said',
    'run 1 (Rejected) -',
  ], 'the refused line is not among them')
  assert.deepEqual(voice.sent.map((x) => x.text), ['over here'], 'and it never reached the speech server')
})

test('say auto on: a whole answer is said aloud by whoever gave it, through the gate again; not an error, not over something being said', async () => {
  const gate = new FakeGate()
  const mind = new FakeMind()
  const voice = new FakeVoice()
  const out = new FakeOut()
  const op = operatorBridge(fakeSim(), gate, mind, undefined, { voice, speech: out })
  op.unlock()
  const quiet = op.ask(['Rust'], 'q')
  mind.say('text', 'An answer.')
  mind.finish('An answer.')
  assert.equal((await quiet.result).speech, undefined, 'auto is off')
  voice.auto = true
  const loud = op.ask(['Rust'], 'q')
  mind.say('text', 'Grip   scales\ntyre friction.')
  mind.finish('Grip   scales\ntyre friction.')
  const r = await loud.result
  assert.ok(r.speech)
  assert.deepEqual(voice.sent.map((x) => x.text), ['Grip scales tyre friction.'])
  assert.equal(gate.requests.length, 3, 'the speech went through the gate on its own')
  voice.audio()
  await ticks()
  out.finish()
  const said = await within(r.speech)
  assert.deepEqual([said.state, out.played], ['Authorized', [7]])
  const failed = op.ask(['Rust'], 'q')
  mind.fail(new Error('the local model server failed (500)'))
  assert.equal((await failed.result).speech, undefined, 'no answer, nothing said')
  // Half an answer, then the server fails: not a whole answer, so nothing is said.
  const half = op.ask(['Rust'], 'q')
  mind.say('text', 'Grip scales with')
  mind.fail(new Error('the local model server failed (500)'))
  const h = await half.result
  assert.deepEqual([h.text, h.error, h.speech], ['Grip scales with', 'the local model server failed (500)', undefined])
  op.say(['Rust'], 'still talking')
  const meanwhile = op.ask(['Rust'], 'q')
  mind.say('text', 'Another answer.')
  mind.finish('Another answer.')
  assert.equal((await meanwhile.result).speech, undefined, 'never over something being said')
  assert.equal(voice.sent.length, 2)
  op.sayStop()
})

test('14A on the way out: an answer is screened as it streams; a refused word is never shown, said or remembered, even split across pieces', async () => {
  const gate = new FakeGate()
  const mind = new FakeMind()
  const voice = new FakeVoice()
  voice.auto = true
  const out = new FakeOut()
  const notes: string[] = []
  const diary: Diary = { recall: () => [], note: (_b, kind, _s, text) => notes.push(`${kind} ${text}`) }
  const op = operatorBridge(fakeSim(), gate, mind, undefined, { voice, speech: out, diary })
  op.unlock()
  const seen: string[] = []
  const a = op.ask(['Rust'], 'what now?')
  a.follow((p) => seen.push(p.text))
  mind.say('text', 'You should ')
  mind.say('text', 'go and k')
  mind.say('text', 'ill the')
  assert.equal(mind.signal?.aborted, true, 'the model is stopped the moment the answer fails the screen')
  mind.say('text', ' engine.')
  const r = await within(a.result)
  assert.deepEqual([r.state, r.text, r.disengaged, r.done, r.speech], ['Authorized', '', true, 'disengaged', undefined])
  assert.deepEqual(seen, ['You should ', 'go and '], 'nothing of the refused word reached the terminal')
  assert.ok(!seen.join('').includes('k'), 'not even its first letter')
  // A phrase that only forms across many pieces, long after the screen's window began.
  const long = op.ask(['Rust'], 'and then?')
  for (let k = 0; k < 40; k++) mind.say('text', `fine words ${k} `)
  mind.say('text', 'beat them ')
  mind.say('text', 'up')
  mind.finish('…')
  const l = await within(long.result)
  assert.equal(l.disengaged, true, 'the last word completes the phrase: refused at the end')
  // A model's own refusal with some text before it: shown as no reply, never said aloud, never noted.
  const refusal = op.ask(['Rust'], 'something odd')
  mind.say('text', 'I would rather not. ')
  mind.finish('I would rather not.', 'refusal')
  const f = await within(refusal.result)
  assert.deepEqual([f.disengaged, f.speech], [true, undefined])
  // A clean answer is shown whole, said and noted as before.
  const fine = op.ask(['Rust'], 'grip?')
  mind.say('text', 'Grip scales ')
  mind.say('text', 'tyre friction.')
  mind.finish('Grip scales tyre friction.')
  const g = await within(fine.result)
  assert.equal(g.text, 'Grip scales tyre friction.')
  assert.ok(g.speech)
  await ticks()
  assert.deepEqual(voice.sent.map((x) => x.text), ['Grip scales tyre friction.'], 'only the clean answer reached the speech server')
  assert.deepEqual(notes, ['ask grip? → Grip scales tyre friction.'], 'only the clean answer is remembered')
  op.sayStop()
})

test('14A on the way out keeps up with a long stream: each piece screens a bounded window, not the whole answer again', async () => {
  // A stream of n pieces, timed. The claim is the window: the work per piece does not grow with the answer, so four
  // times the pieces cost about four times the milliseconds (sixteen if every piece screened, or searched, the whole
  // answer: windowStart did, until it walked back from the reach). The ratio holds on any machine; the absolute bound
  // is loose on purpose (a laptop running the suite in parallel took 2.4 s for 4,000 pieces that take 80 ms here).
  const stream = async (n: number): Promise<number> => {
    const gate = new FakeGate()
    const mind = new FakeMind()
    const a = gatedAsk(gate, mind, ['Rust'], 'tell me everything')
    let shown = ''
    a.follow((p) => { shown += p.text })
    const t0 = performance.now()
    for (let k = 0; k < n; k++) mind.say('text', `token${k % 97} `)
    const ms = performance.now() - t0
    mind.finish('')
    const r = await within(a.result)
    assert.equal(r.disengaged, undefined)
    assert.equal(shown, r.text, 'every word shown, in order, once')
    return ms
  }
  const short = await stream(1000)
  const long = await stream(4000)
  assert.ok(long < 8 * Math.max(short, 5), `1,000 pieces in ${short.toFixed(0)} ms, 4,000 in ${long.toFixed(0)} ms: the window is not bounded`)
  assert.ok(long < 4000, `4,000 pieces screened in ${long.toFixed(0)} ms`)
})

test('speakable: white space folded; a long answer ends on its last whole sentence, or word, within SAY_CHARS', () => {
  assert.equal(speakable('  Grip\n\nscales   tyre friction. '), 'Grip scales tyre friction.')
  const sentences = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} is here.`).join(' ')
  const s = speakable(sentences)
  assert.ok(s.length <= SAY_CHARS && s.endsWith('.') && sentences.startsWith(s), s.slice(-40))
  const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ')
  const w = speakable(words)
  assert.ok(w.length <= SAY_CHARS + 1 && w.endsWith('…') && words.startsWith(w.slice(0, -1)), w.slice(-20))
  assert.equal(speakable('x'.repeat(SAY_CHARS + 10)), 'x'.repeat(SAY_CHARS), 'one unbroken run is cut at the limit')
})

test('the facade walks the avatar with finite numbers only, and hands a script a copy of where the crowd stands', () => {
  const sim = fakeSim()
  const api = scriptApi(sim)
  api.avatar.walk(1, -2, 500)
  assert.equal(sim.calls.at(-1), 'avatar.walk 1 -2 500')
  api.avatar.walk('3' as unknown as number, 0)
  assert.equal(sim.calls.at(-1), 'avatar.walk 3 0 undefined', 'a numeric string is a number; the time is optional')
  for (const bad of [[Number.NaN, 0], [0, Number.POSITIVE_INFINITY], [1, 0, Number.NaN]] as const) {
    assert.throws(() => api.avatar.walk(bad[0], bad[1], bad[2]), TypeError)
  }
  const a = api.crowd.positions()
  const b = api.crowd.positions()
  assert.deepEqual([...a], [0, 0, 12.5, 5.75])
  assert.notEqual(a, b)
  a[2] = 999
  assert.equal(api.crowd.positions()[2], 12.5, "a copy: the engine's own array is untouched")
})

test("operatorBridge ask think: on or off only, through the mind's own switch; a mind without one says so", () => {
  const mind = new FakeMind()
  let think = false
  Object.assign(mind, { setThink: (on: boolean) => (think = on) })
  const op = operatorBridge(fakeSim(), new FakeGate(), mind)
  assert.throws(() => op.askSet('think', 'on'), /^Error: ask: locked/)
  op.unlock()
  assert.equal(op.askSet('think', 'on'), 'on: the model reasons before it answers (slower; its thinking shows live)')
  assert.equal(think, true)
  assert.equal(op.askSet('think', 'off'), 'off: the model answers without reasoning first')
  assert.equal(think, false)
  assert.throws(() => op.askSet('think', 'maybe'), /ask think takes on or off/)
  const plain = operatorBridge(fakeSim(), new FakeGate(), new FakeMind())
  plain.unlock()
  assert.throws(() => plain.askSet('think', 'on'), /this model server has no think switch/)
})
