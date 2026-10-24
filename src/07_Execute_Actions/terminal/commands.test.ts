// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the Ring-0 shell's behaviour against a fake bridge: parsing, every
 * command's output and argument validation, the synchronous device-pairing call, completion, the toggle
 * key, the air gap (a failing bridge never throws out of run(); while locked, nothing but the knobs, recruitment,
 * reading the swarm's memory and the model file kept in this page is touched and the operator commands are refused),
 * the recruit command (the microphone and the model download requested inside the keydown, outcomes as lines), `ask
 * file` (the picker requested inside the keydown) and `ask gpu`, `say` and `memory`, the operator tier's
 * commands over a sandboxed fake simulation, the city actions an agent proposes (`act`, `y`/`n` only while one waits,
 * the lines an ask prints for a proposal, the trail, the follower's lines printed once), the multi-line editing helpers,
 * and the content rules for its text.
 * What breaks if it is removed? A console regression (a wrong tier, a picker opened outside the user
 * gesture, a script run while locked, a crash on a bad line) would only show up in the browser.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  HARNESS_NAMES, LOOK_BODY_ARGS, LOOK_PRESET_ARGS, LOOK_SLOT_ARGS, PROVIDER_ARGS, SKILL_ARGS, actEventLines, commonPrefix, complete, continuationPrompt, formatRecording, formatStats,
  isToggleKey, motd, recallsHistory, redactForHistory, replSession, run, type CommandResult, type Line,
} from './commands.ts'
import {
  offlineBridge, ring0Stats, type ActEnd, type ActEvent, type ActsBridge, type AskResult, type GatedAsk, type GatedRun, type GatedSay, type HalDevice, type LookBridge, type LookChange,
  type MemoryBridge, type ModelBridge, type NetBridge, type NetReport, type OperatorBridge, type PendingAct, type Piece, type PingBridge, type PingPick, type PingPoint, type RecordBridge,
  type RecruitBridge, type Ring0Stats, type SayResult, type TerminalBridge, type AgentBridge, type ConciergeBridge,
} from './bridge.ts'
import { SKILLS } from '../../03_Spawn_Agents/skills.ts'
import { LOOK_BODIES, LOOK_PRESETS, LOOK_SLOTS } from '../../03_Spawn_Agents/look.ts'
import { PING_KINDS, PING_WORDS } from '../../08_Swarm/ping.ts'
import { apiDoc, exec, scriptApi, type SimControls } from '../operator.ts'
import { createSwarm } from '../../08_Swarm/orchestrator.ts'
import { AuditChain, INVARIANTS, INVARIANT_TEXT, verifyChain, type AuditBody } from '../../02_Define_The_Rules/guardrails.ts'
import { sha256 } from '../../02_Define_The_Rules/integrity.ts'
import { PROVIDERS } from '../../09_Cognition/router.ts'
import { harnesses } from '../harness.ts'
import type { QualityState, RecordingState, SipocSnapshot } from '../../05_Observe_Environment/telemetry.ts'

const BRAND = { name: 'TESTBRAND', version: '9.8.7', host: 'testhost' }

const LAWS = [
  { id: 1, title: 'Protect people', text: 'Law one text.' },
  { id: 2, title: 'Follow instructions', text: 'Law two text.' },
  { id: 3, title: 'Preserve itself', text: 'Law three text.' },
] as const

const CORE_NAMES = [
  'help', 'stats', 'laws', 'kernel', 'quality', 'time', 'audio', 'ghost', 'rain', 'render', 'captions', 'ping', 'look', 'agent', 'sloane', 'goal', 'hal', 'recruit', 'memory', 'clear', 'history', 'echo',
  'uname', 'whoami', 'version', 'boot', 'map', 'r0', 'exit',
]
const OPERATOR_NAMES = ['operator', 'run', 'ask', 'swarm', 'act', 'say', 'api', 'get', 'set', 'harness', 'record', 'net', 'sim']

const IDLE: RecordingState = { active: false, source: null, seconds: 0, frames: 0, bytes: 0, dropped: 0, codec: '' }

function sampleStats(): Ring0Stats {
  return {
    fps: 59.94, frameMs: 16.683, p95Ms: 18.2, cpuMs: 4.1, gpuRenderMs: 3.25, gpuComputeMs: 0,
    rapier: { stepMs: 0.4123, physicsMs: 1.234, steps: 2, bodies: 41, colliders: 612, ccd: 37 },
    agents: { population: 10000, drawnNear: 1234, drawnFar: 2345, waiting: 120, crossing: 45, yielding: 3, nudges: 7 },
    vehicles: 36,
    quality: { tier: 3, label: 'High', auto: true, renderScale: 1, targetMs: 16.7 },
    kernel: { law1: 5, law2: 1, law3: 2, sensorFlips: 4, shielded: false, last: 'First Law: person 3.2 m ahead', audit: { ticks: 0, perimeterBreaches: 0, velocityCaps: 0, closest: Infinity, panic: null } },
  }
}

/** A minimal SimControls with two tuning tables, so `get`/`set` go through the real sandbox. */
function tinySim(): SimControls {
  const tune: Record<string, number> = { 'car.power': 1, 'car.drag': 1 }
  const uniforms: Record<string, number> = { 'light.haze': 1, 'volumetrics.strength': 0.5 }
  return {
    clock: { hours: () => 10, set: () => {} },
    quality: { state: () => ({ tier: 3, label: 'High', auto: true, renderScale: 1, targetMs: 16.7 }), set: () => {} },
    avatar: { position: () => ({ x: 1, z: 2, heading: 0, feetY: 0 }), teleport: () => {}, interact: () => {}, walk: () => {} },
    vehicles: {
      count: () => 1, state: () => ({ x: 0, z: 0, heading: 0, speed: 0, mode: 'ai', suv: false }),
      setMode: () => {}, recover: () => {}, intent: () => {}, nearest: () => 0,
    },
    physics: {
      tune: () => tune,
      set: (k, v) => { if (!Object.hasOwn(tune, k)) throw new Error(`unknown physics key '${k}'`); tune[k] = Math.min(2, Math.max(0.25, v)) },
    },
    shaders: {
      uniforms: () => uniforms,
      set: (k, v) => { if (!Object.hasOwn(uniforms, k)) throw new Error(`unknown shader key '${k}'`); uniforms[k] = v },
    },
    crowd: { stats: () => ({ drawnNear: 0, drawnFar: 0, nudges: 0, waiting: 0, crossing: 0, retreating: 0 }), cull: () => {}, positions: () => new Float32Array(0) },
    kernel: { stats: () => sampleStats().kernel, blindSensing: () => {} },
    snapshot: () => ({}) as SipocSnapshot,
  }
}

interface FakeOp extends OperatorBridge {
  opCalls: string[]
  state: { unlocked: boolean }
  /** What the capability gateway answers: authorize and run, reject, or authorize and then lose the tether mid-script. */
  gate: 'open' | 'reject' | 'abort'
  /** How an `ask` ends: answered, rejected, cut off by the tether, the server failing, all thinking, the token limit. */
  answer: 'ok' | 'reject' | 'abort' | 'fail' | 'thinking' | 'length'
  /** What an answered ask reports of its ACTION line (AskResult.act): a proposal now waiting, a refused line, or nothing. */
  proposal: AskResult['act']
  /** The answered text (the ACTION line already stripped, as the tier hands it over). */
  text: string
  acts: FakeActs
  mind: { server: string; model: string | null; think?: boolean; api?: string; provider?: string; key?: string | null; effort?: string; found?: string; runtime?: string; storage?: string }
  /** How a `say` ends: said, rejected, cut off by the tether, the server failing, the operator's stop. */
  speech: 'ok' | 'reject' | 'abort' | 'fail' | 'stopped'
  /** The ask's answer is said aloud as well (say auto on): how that ends. */
  speakAnswer: SayResult | null
  voice: { server: string; voice: string | null; model: string | null; auto: boolean }
}

/** The tether the fake gateway binds a script to. */
const TETHER = { agent: 7, serial: 1, skills: ['Rust', 'Python'] }

/** The city action the fake tier holds for the operator's OK when a test sets `acts.waiting` (acts.ts PendingAct). */
const PROPOSAL: PendingAct = { seq: 1, who: 'agent 7 (Rust, Python)', agent: 7, serial: 1, skills: ['Rust', 'Python'], verb: 'time', canonical: 'time 22:00', sentence: 'set the clock to 22:00', since: 1_700_000_000_000 }

/** The catalogue rows the fake tier lists: the real ones, as actions.test.ts pins them from catalogueLines() (the console prints whatever the tier gives). */
const CATALOGUE = [
  '  time      HH:MM, or midnight to night          set the clock',
  '  rain      on, off                              turn rain mode on or off',
  '  light     haze, exposure, sun or fill, a number set a light dial',
  '  quality   auto, lite, minimal to ultra         pin or free the quality tier',
  '  cars      park, drive                          park every car, or let them drive',
  '  crowd     0 to 100                             set the crowd density',
  '  sound     on, off, 0 to 100                    the sound and its volume',
]

/** The gateway's own wording for a proposal whose tether broke (02_Define_The_Rules/guardrails.ts tetherVerdict). */
const TETHER_LOST = 'Aborted (Spatial Tether Lost): agent 7 (Rust, Python): no longer tethered to the operator'

interface FakeActs extends ActsBridge {
  /** The proposal waiting for the OK; a test sets it (null: nothing waits). */
  waiting: PendingAct | null
  /** How an allowed action ends: the done line, a failure in the facade, or the lease gone at `use`. */
  outcome: 'done' | 'failed' | 'aborted'
  /** The hash-chained trail a test fills (the real chain, so `act log` prints real hashes and verifies them). */
  chain: AuditChain
  followers: Set<(ev: ActEvent) => void>
}

/**
 * The proposed city actions as the fake tier keeps them: reads log nothing (they change nothing, and the locked sweep
 * proves a locked console touches no engine knob through them); `allow` and `refuse` log who decided and end the wait.
 */
function fakeActs(f: FakeOp): FakeActs {
  const ending = (): ActEnd => (a.outcome === 'done' ? { state: 'done', line: 'the clock is set to 22:00' }
    : a.outcome === 'failed' ? { state: 'failed', line: 'the clock did not take the hour' }
      : { state: 'aborted', line: TETHER_LOST })
  const a: FakeActs = {
    waiting: null,
    outcome: 'done',
    chain: new AuditChain(),
    followers: new Set(),
    pending: () => a.waiting,
    follow: (fn) => { a.followers.add(fn); return () => { a.followers.delete(fn) } },
    allow: (by = 'host') => {
      f.opCalls.push(`act allow ${by}`)
      const act = a.waiting
      if (!act) throw new Error('nothing is waiting for your OK')
      a.waiting = null
      return { act, result: Promise.resolve(ending()) }
    },
    refuse: (by = 'host') => {
      f.opCalls.push(`act refuse ${by}`)
      const act = a.waiting
      if (!act) throw new Error('nothing is waiting for your OK')
      a.waiting = null
      return act
    },
    log: () => a.chain.entries(),
    verify: () => a.chain.verify(),
    list: () => CATALOGUE,
  }
  return a
}

function fakeOperator(): FakeOp {
  const api = scriptApi(tinySim())
  const f: FakeOp = {
    opCalls: [],
    state: { unlocked: false },
    gate: 'open',
    proposal: undefined,
    text: 'Grip scales\ntyre friction.',
    acts: undefined as unknown as FakeActs,
    unlock: () => { f.opCalls.push('unlock'); f.state.unlocked = true },
    // The tier withdraws a waiting proposal as it locks (no proposal waits past a lock): the console must read it first.
    lock: () => { f.opCalls.push('lock'); f.state.unlocked = false; f.acts.waiting = null },
    unlocked: () => f.state.unlocked,
    exec: (skills, script): GatedRun => {
      f.opCalls.push(`exec ${skills.join(',')}: ${script}`)
      if (f.gate === 'reject') {
        const reason = `nobody tethered to the operator has ${skills.join(', ')}`
        return { state: 'Rejected', bound: [], result: Promise.resolve({ value: '', logs: [], ms: 0, state: 'Rejected', reason }) }
      }
      if (f.gate === 'abort') {
        const reason = 'agent 7 (Rust, Python): no longer tethered to the operator'
        return { state: 'Authorized', bound: [TETHER], result: Promise.resolve({ value: '', logs: ['partial'], ms: 3, state: 'Aborted', reason }) }
      }
      return { state: 'Authorized', bound: [TETHER], result: exec(script, api, 1000).then((r) => ({ ...r, state: 'Authorized' as const })) }
    },
    answer: 'ok',
    mind: { server: 'http://localhost:11434', model: 'test-model' },
    ask: (skills, prompt): GatedAsk => {
      f.opCalls.push(`ask ${skills.join(',')}: ${prompt}`)
      // The tier's own refusal while a proposal waits (operator.ts askThrough), in its words.
      if (f.acts.waiting) throw new Error('a proposal is waiting: act ok or act no first')
      if (f.mind.model === null) throw new Error('choose a model first: ask model <name> (type ask to list them)')
      if (f.answer === 'reject') {
        const reason = `nobody tethered to the operator has ${skills.join(', ')}`
        return { state: 'Rejected', bound: [], follow: () => () => {}, result: Promise.resolve({ state: 'Rejected', text: '', thinking: 0, reason, ms: 0 }) }
      }
      const followers = new Set<(p: Piece) => void>()
      const how = f.answer
      // The answer arrives a moment later, piece by piece, then ends as `how` says.
      const result = new Promise<AskResult>((resolve) => setTimeout(() => {
        for (const p of [{ kind: 'thinking', text: 'hmm' }, { kind: 'text', text: 'Grip scales\n' }, { kind: 'text', text: 'tyre friction.' }] as const) {
          for (const fn of followers) fn(p)
        }
        const text = f.text
        if (how === 'abort') resolve({ state: 'Aborted', text, thinking: 1, reason: 'agent 7 (Rust, Python): no longer tethered to the operator', ms: 900 })
        else if (how === 'fail') resolve({ state: 'Authorized', text: '', thinking: 0, error: 'no local model server is answering at http://localhost:11434: start it, or point ask at the right address (ask server <url>)', ms: 5 })
        else if (how === 'thinking') resolve({ state: 'Authorized', text: '', thinking: 24, done: 'length', tokens: 24, ms: 2700 })
        else resolve({ state: 'Authorized', text, thinking: 1, done: how === 'length' ? 'length' : 'stop', tokens: 9, ms: 1234, ...(f.speakAnswer && { speech: Promise.resolve(f.speakAnswer) }), ...(f.proposal && { act: f.proposal }) })
      }, 0))
      return { state: 'Authorized', bound: [TETHER], follow: (fn) => { followers.add(fn); return () => { followers.delete(fn) } }, result }
    },
    askStatus: () => {
      f.opCalls.push('askStatus')
      return Promise.resolve({ ...f.mind, installed: ['a-model', 'test-model'] })
    },
    askConnect: (provider, url, key) => {
      f.opCalls.push(`askConnect ${provider} ${url ?? '-'} ${key ? '<key>' : '-'}`)
      f.mind.provider = provider
      if (url) f.mind.server = url
      return `${provider}: connected${url ? `; server ${url}` : ''}${key ? '; key ••••' : ''}`
    },
    swarm: undefined as unknown as FakeOp['swarm'],
    askSet: (key, value) => {
      f.opCalls.push(`askSet ${key} ${value}`)
      if (key === 'server' && !value.startsWith('http://localhost')) throw new Error(`the local model server must be on this machine (localhost, 127.0.0.1 or [::1]), not '${value}'`)
      if (key === 'think') {
        if (value !== 'on' && value !== 'off') throw new TypeError('ask think takes on or off')
        f.mind.think = value === 'on'
        return f.mind.think ? 'on: the model reasons before it answers (slower; its thinking shows live)' : 'off: the model answers without reasoning first'
      }
      f.mind[key] = value
      return value
    },
    askStop: () => { f.opCalls.push('askStop'); return 'no answer is being generated' },
    speech: 'ok',
    speakAnswer: null,
    voice: { server: 'http://localhost:8880', voice: 'test-voice', model: null, auto: false },
    say: (skills, text): GatedSay => {
      f.opCalls.push(`say ${skills.join(',')}: ${text}`)
      if (f.voice.voice === null) throw new Error('choose a voice first: say voice <name> (type say to list them)')
      if (f.speech === 'reject') {
        const reason = `nobody tethered to the operator has ${skills.join(', ')}`
        return { state: 'Rejected', bound: [], result: Promise.resolve({ state: 'Rejected', reason, ms: 0 }) }
      }
      const how = f.speech
      const result = new Promise<SayResult>((resolve) => setTimeout(() => {
        if (how === 'abort') resolve({ state: 'Aborted', reason: 'agent 7 (Rust, Python): no longer tethered to the operator', seconds: 2.5, ms: 700 })
        else if (how === 'fail') resolve({ state: 'Authorized', error: 'no local speech server is answering at http://localhost:8880: start it, or point say at the right address (say server <url>)', ms: 4 })
        else if (how === 'stopped') resolve({ state: 'Authorized', error: 'stopped by the operator', stopped: true, ms: 300 })
        else resolve({ state: 'Authorized', speaker: TETHER, seconds: 2.5, ms: 2600 })
      }, 0))
      return { state: 'Authorized', bound: [TETHER], result }
    },
    sayStatus: () => {
      f.opCalls.push('sayStatus')
      return Promise.resolve({ ...f.voice, voices: ['a-voice', 'test-voice'], speaking: false })
    },
    saySet: (key, value) => {
      f.opCalls.push(`saySet ${key} ${value}`)
      if (key === 'server' && !value.startsWith('http://localhost')) throw new Error(`the local speech server must be on this machine (localhost, 127.0.0.1 or [::1]), not '${value}'`)
      if (key === 'auto') {
        f.voice.auto = value === 'on'
        return f.voice.auto ? 'on: answers are said aloud by whoever gives them' : 'off'
      }
      if (key === "provider" || key === "key") return value
      f.voice[key] = value
      return value
    },
    sayStop: () => { f.opCalls.push('sayStop'); return 'nothing is being said' },
    tuning: () => { f.opCalls.push('tuning'); return { physics: api.physics.tune(), shaders: api.shaders.uniforms() } },
    tune: (table, key, value) => {
      f.opCalls.push(`tune ${table}.${key} ${value}`)
      if (table === 'physics') { api.physics.set(key, value); return api.physics.tune()[key] }
      api.shaders.set(key, value)
      return api.shaders.uniforms()[key]
    },
    api: () => apiDoc(),
    harnesses: () => harnesses(),
    harness: (name) => {
      f.opCalls.push(`harness ${name}`)
      return Promise.resolve({ name, pass: name !== 'traffic-lights', lines: [`ran ${name}`], ms: 1234 })
    },
  }
  // The swarm over the fake's own ask: the same gate answers (f.answer), one step at a time; no endpoint for the script
  // or a model running in this page, as the real tier reads it (operator.ts). Its `run` is refused while a proposal
  // waits, as the tier's wrapper refuses it, in the tier's words.
  const swarm = createSwarm({
    ask: (skills, prompt) => f.ask(skills, prompt),
    endpoint: () => {
      const p = f.mind.provider === 'auto' ? f.mind.found : f.mind.provider
      return p === 'scripted' || p === 'inpage' ? null : f.mind.server
    },
  })
  f.swarm = {
    ...swarm,
    run: (goal, agents) => {
      if (f.acts.waiting) throw new Error('a proposal is waiting: act ok or act no first')
      return swarm.run(goal, agents)
    },
  }
  f.acts = fakeActs(f)
  return f
}

interface FakeRec extends RecordBridge {
  recCalls: string[]
  st: RecordingState
  startResult: Promise<string> | (() => never)
  stopResult: Promise<string> | (() => never)
  sup: { ok: boolean; reason: string }
}

function fakeRecord(): FakeRec {
  const f: FakeRec = {
    recCalls: [],
    st: { ...IDLE },
    startResult: Promise.resolve('av01.0.04M.08'),
    stopResult: Promise.resolve('saved to test.agv'),
    sup: { ok: true, reason: '' },
    start: (source) => {
      f.recCalls.push(`start ${source}`)
      return typeof f.startResult === 'function' ? f.startResult() : f.startResult
    },
    stop: () => {
      f.recCalls.push('stop')
      return typeof f.stopResult === 'function' ? f.stopResult() : f.stopResult
    },
    status: () => { f.recCalls.push('status'); return f.st },
    supported: () => { f.recCalls.push('supported'); return f.sup },
  }
  return f
}

/** Logs to the bridge's shared `calls` (as 'memory <verb>'), so the air-gap sweep sees every use. */
function fakeMemory(calls: string[]): MemoryBridge {
  return {
    status: () => { calls.push('memory status'); return Promise.resolve(['memory: 2 people remembered in this city (seed 1337), kept on this machine between visits', 'agent 7 (Rust, Python): 3 episodes, last just now: ask']) },
    ledger: (agent) => {
      calls.push(`memory ledger ${agent}`)
      return Promise.resolve(agent === 7 ? ['16:05:12  #3  tethered · Rust, Python', '16:06:40  #3  ask · how does car.grip work? → Grip scales tyre friction.'] : [`agent ${agent} remembers nothing in this city`])
    },
    forget: (which) => { calls.push(`memory forget ${which}`); return Promise.resolve(which === 'all' ? 'forgot 2 people in this city' : `agent ${which} remembers nothing now`) },
  }
}

interface FakeRecruit extends RecruitBridge {
  askResult: { ok: boolean; message: string }
  rallyResult: { ok: boolean; message: string }
}

/** Logs to the bridge's shared `calls` (as 'recruit <verb>'), so the air-gap sweep sees every use. */
function fakeRecruit(calls: string[]): FakeRecruit {
  const r: FakeRecruit = {
    askResult: { ok: true, message: 'Rust: someone 3.0 m away is coming over' },
    rallyResult: { ok: true, message: 'rally: someone is walking to (312.4, 88.1)' },
    ask: (skill) => { calls.push(`recruit ask ${skill}`); return Promise.resolve(r.askResult) },
    rally: (agent, x, z) => { calls.push(`recruit rally ${agent} ${x} ${z}`); return Promise.resolve(r.rallyResult) },
    listen: () => { calls.push('recruit listen'); return Promise.resolve('listening · on-device en-US: say "recruit" and a skill') },
    stop: () => { calls.push('recruit stop'); return 'off' },
    install: () => { calls.push('recruit install'); return Promise.resolve("off · on-device en-US speech model installed: run 'recruit listen'") },
    dismiss: () => { calls.push('recruit dismiss'); return 'letting 2 people go' },
    status: () => { calls.push('recruit status'); return ['mic       off', 'recruit   nobody asked over'] },
    skills: () => SKILLS,
  }
  return r
}

interface FakePing extends PingBridge {
  pickResult: PingPick | null
  marks: string[]
  point: PingPoint | null
}

/** Logs to the bridge's shared `calls` (as 'ping <verb>'): the board is view-only, and the sweep sees every use. */
function fakePing(calls: string[]): FakePing {
  const p: FakePing = {
    pickResult: { kind: 'person', index: 12, x: 312.44, y: 0, z: 88.06, distance: 8.31 },
    marks: ['ping 1  go  person 12 at (312.4, 88.1)  4 s ago'],
    point: { id: 1, kind: 'go', x: 312.44, z: 88.06 },
    at: (kind) => { calls.push(`ping at ${kind}`); return p.pickResult },
    list: () => { calls.push('ping list'); return p.marks },
    newest: () => { calls.push('ping newest'); return p.point },
    clear: () => {
      calls.push('ping clear')
      const n = p.marks.length
      p.marks = []
      p.point = null
      return n
    },
  }
  return p
}

interface FakeLook extends LookBridge {
  changes: LookChange[]
}

const WORN = ['body       suit  [1/4]', 'height     5  [5/8]', 'code       ABCD-EFGH']

/** Logs to the bridge's shared `calls` (as 'look <verb>'); the host's own validation is a thrown reason. */
function fakeLook(calls: string[]): FakeLook {
  const l: FakeLook = {
    changes: [],
    show: (agent) => {
      calls.push(`look show ${agent ?? 'me'}`)
      if (agent === 99) throw new Error('no pedestrian 99 (0-50)')
      return agent === undefined ? WORN : [`body       smart casual  [2/4]`, `code       AGNT-${String(agent).padStart(4, '0')}`]
    },
    set: (change) => {
      calls.push(`look set ${change.kind}`)
      l.changes.push(change)
      if (change.kind === 'code' && change.code === 'ZZZZ-ZZZZ') throw new Error("not a look code: 'ZZZZ-ZZZZ' (eight symbols, XXXX-XXXX)")
      if (change.kind === 'slot' && change.value === '99') throw new Error(`${change.slot} has 8 options (1-8)`)
      return [`${change.kind.padEnd(11)}set`, ...WORN.slice(1)]
    },
  }
  return l
}

interface FakeNet extends NetBridge {
  report: NetReport
  joinResult: Promise<string> | (() => never)
}

/** Logs to the bridge's shared `calls` (as 'net <verb>'): only `status` may be read while locked. */
function fakeNet(calls: string[]): FakeNet {
  const n: FakeNet = {
    report: { state: 'idle', url: null, id: 0, peers: 0, dropped: 0, pending: 0, voices: 0, reason: null, corrections: 0, corrected: null },
    joinResult: Promise.resolve('joined ws://127.0.0.1:8787 as player 3'),
    join: (url, token) => {
      calls.push(`net join ${url} ${token ?? '-'}`)
      return typeof n.joinResult === 'function' ? n.joinResult() : n.joinResult
    },
    leave: () => { calls.push('net leave'); return 'left ws://127.0.0.1:8787' },
    status: () => { calls.push('net status'); return n.report },
    forget: () => { calls.push('net forget'); return 'token forgotten' },
  }
  return n
}

interface FakeModel extends ModelBridge {
  /** What `pick` resolves with, or how it fails (the operator closed the picker, the file was refused). */
  picked: Promise<string> | (() => never)
  lines: string[]
}

/** Logs to the bridge's shared `calls` (as 'model <verb>'): the model file kept in this page, reachable while locked. */
function fakeModel(calls: string[]): FakeModel {
  const m: FakeModel = {
    picked: Promise.resolve('kept tiny.gguf (1.2 MB) in this page; the inpage provider answers now'),
    lines: Array.from({ length: 45 }, (_, i) => `runtime line ${i + 1}`),
    pick: () => {
      calls.push('model pick')
      return typeof m.picked === 'function' ? m.picked() : m.picked
    },
    forget: (name) => { calls.push(`model forget ${name ?? '-'}`); return Promise.resolve(name ? `forgot ${name}` : 'forgot every model file kept in this page') },
    load: () => { calls.push('model load'); return Promise.resolve('loaded tiny.gguf on the CPU in 1.2 s') },
    unload: () => { calls.push('model unload'); return Promise.resolve('unloaded tiny.gguf') },
    gpu: (mode) => { calls.push(`model gpu ${mode}`); return `${mode}: the model runs ${mode === 'off' ? 'on the CPU' : 'on the GPU when it can'}` },
    log: () => { calls.push('model log'); return m.lines },
  }
  return m
}

interface Fake extends TerminalBridge {
  calls: string[]
  recruit: FakeRecruit
  ping: FakePing
  look: FakeLook
  net: FakeNet
  model: FakeModel
  hours: number
  q: QualityState
  devs: HalDevice[]
  pairResult: Promise<HalDevice | null> | (() => never)
  operator: FakeOp
  record: FakeRec
}

function fake(): Fake {
  const f: Fake = {
    calls: [],
    hours: 10,
    q: { tier: 3, label: 'High', auto: true, renderScale: 1, targetMs: 16.7 },
    devs: [],
    pairResult: Promise.resolve(null),
    brand: BRAND,
    stats: () => { f.calls.push('stats'); return sampleStats() },
    laws: () => LAWS,
    clock: () => `${String(Math.floor(f.hours)).padStart(2, '0')}:${String(Math.round((f.hours % 1) * 60)).padStart(2, '0')}`,
    setClock: (h) => { f.calls.push(`setClock ${h}`); f.hours = h },
    quality: (arg) => {
      f.calls.push(`quality ${arg}`)
      if (arg === 'auto') f.q = { ...f.q, auto: true }
      else if (typeof arg === 'number') f.q = { ...f.q, tier: arg, label: `T${arg}`, auto: false }
      return f.q
    },
    audio: (arg) => { f.calls.push(`audio ${arg}`); return `audio status ${arg ?? '-'}` },
    ghost: (arg) => { f.calls.push(`ghost ${arg}`); return arg ?? 'off' },
    rain: (arg) => { f.calls.push(`rain ${arg}`); return arg ?? 'off' },
    render: (arg) => { f.calls.push(`render ${arg}`); return arg ?? 'on' },
    captions: (arg) => { f.calls.push(`captions ${arg}`); return `captions: ${arg ?? 'on'}` },
    ping: undefined as unknown as FakePing,
    hal: {
      summary: () => `${f.devs.length} device(s)`,
      devices: () => f.devs,
      pair: (kind) => {
        f.calls.push(`pair ${kind}`)
        if (typeof f.pairResult === 'function') return f.pairResult()
        return f.pairResult
      },
    },
    adapter: () => 'Test GPU (fake)',
    operator: fakeOperator(),
    record: fakeRecord(),
    recruit: undefined as unknown as FakeRecruit,
    look: undefined as unknown as FakeLook,
    net: undefined as unknown as FakeNet,
    model: undefined as unknown as FakeModel,
  }
  f.ping = fakePing(f.calls)
  f.recruit = fakeRecruit(f.calls)
  f.memory = fakeMemory(f.calls)
  f.look = fakeLook(f.calls)
  f.net = fakeNet(f.calls)
  f.model = fakeModel(f.calls)
  return f
}

const texts = (r: CommandResult) => r.lines.map((l) => l.text)
const kinds = (r: CommandResult) => r.lines.map((l) => l.kind)
const only = (r: CommandResult): Line => {
  assert.equal(r.lines.length, 1, JSON.stringify(r.lines))
  return r.lines[0]
}
const isErr = (r: CommandResult) => r.lines.length > 0 && r.lines.every((l) => l.kind === 'err')
const unlocked = (): Fake => {
  const b = fake()
  run('operator unlock', b, [])
  b.operator.opCalls.length = 0
  return b
}

test('blank lines do nothing; unknown commands report like ash', () => {
  const b = fake()
  assert.deepEqual(run('', b, []), { lines: [] })
  assert.deepEqual(run('   \t ', b, []), { lines: [] })
  assert.deepEqual(only(run('frobnicate --now', b, [])), { kind: 'err', text: 'ash: frobnicate: not found' })
  // Prototype keys are not commands.
  assert.equal(only(run('constructor', b, [])).text, 'ash: constructor: not found')
  assert.equal(only(run('toString', b, [])).text, 'ash: toString: not found')
  // Command names are case-sensitive, like a shell.
  assert.equal(only(run('HELP', b, [])).text, 'ash: HELP: not found')
  assert.equal(only(run('runx 1', b, [])).text, 'ash: runx: not found')
  assert.deepEqual(b.calls, [])
})

test('quoting: echo keeps quoted spacing, escapes work, unterminated quotes are a syntax error', () => {
  const b = fake()
  assert.equal(only(run('echo hello   world', b, [])).text, 'hello world')
  assert.equal(only(run('echo "a   b"  \'c  d\'', b, [])).text, 'a   b c  d')
  assert.equal(only(run('echo "say \\"hi\\""', b, [])).text, 'say "hi"')
  assert.equal(only(run("echo it\\'s", b, [])).text, "it's")
  assert.equal(only(run('echo', b, [])).text, '')
  assert.equal(only(run('  echo   padded  ', b, [])).text, 'padded')
  // A line break in a plain command is a blank.
  assert.equal(only(run('echo a\nb', b, [])).text, 'a b')
  const bad = only(run('echo "open', b, []))
  assert.equal(bad.kind, 'err')
  assert.match(bad.text, /unterminated quoted string/)
})

test('help lists every command with usage, in two groups; help <cmd> explains one', () => {
  const b = fake()
  const r = run('help', b, [])
  const all = texts(r).join('\n')
  for (const name of [...CORE_NAMES, ...OPERATOR_NAMES]) {
    assert.match(all, new RegExp(`^  ${name}\\b`, 'm'), `help is missing ${name}`)
  }
  assert.match(all, /stats \[--once\]/)
  assert.match(all, /quality \[auto\|lite\|-1\|0-4\]/)
  assert.match(all, /time \[HH\[:MM\]\]/)
  assert.match(all, /audio \[on\|off\|0-100\]/)
  assert.match(all, /hal \[pair hid\|serial\|ble\]/)
  assert.match(all, /operator \[unlock\|lock\|status\]/)
  assert.match(all, /run <skill>\[,<skill>\.\.\.\]: <js\.\.\.>/)
  assert.match(all, /ask \[<skill>\[,<skill>\.\.\.\]: <prompt\.\.\.>\|provider <name>\|connect <provider> \[<url>\] \[<key>\]\|model <name>\|server <url>\|key <key>\|effort <level>\|think on\|off\|api <format>\|file \[forget <name>\|load\|unload\|log\]\|gpu auto\|on\|off\|stop\]/)
  assert.match(all, /harness \[list\|run <name>\]/)
  assert.match(all, /act \[ok\|no\|log \[verify\]\|list\]/)
  assert.match(all, /record \[start \[canvas\|camera\]\|stop\|status\]/)
  assert.match(all, /recruit \[<skill>\|rally <agent> \[<x> <z>\]\|listen\|stop\|install\|dismiss\]/)
  assert.match(all, /render \[on\|off\]/)
  assert.match(all, /captions \[on\|off\]/)
  assert.match(all, /ping \[go\|look\|gather\|wait\|clear\]/)
  assert.match(all, /look \[show \[<agent>\]\|<slot> <n\|name>\|preset <name>\|code <code>\|random \[<seed>\]\|reset\]/)
  assert.match(all, /boot \[gui\|tty\|status\]/)
  assert.match(all, /r0 <words\.\.\.>\|r0 reset\|r0 words/)
  assert.match(all, /net \[join <ws-url> \[<token>\]\|leave\|status\|forget\]/)
  // The operator group is headed and comes after the core commands.
  const t = texts(r)
  const head = t.findIndex((l) => /Ring-0 operator/.test(l))
  assert.ok(head > 0)
  assert.equal(r.lines[head].kind, 'sys')
  assert.ok(t.slice(0, head).some((l) => l.startsWith('  exit')))
  assert.ok(t.slice(head).some((l) => l.startsWith('  operator')))
  assert.match(t[t.length - 1], /Shift\+Enter new line/)
  assert.equal(texts(run('help stats', b, []))[0], 'usage: stats [--once]')
  assert.equal(texts(run('help run', b, []))[0], 'usage: run <skill>[,<skill>...]: <js...>')
  assert.ok(isErr(run('help nope', b, [])))
  assert.ok(isErr(run('help a b', b, [])))
})

test('stats goes live by default and prints once with --once', () => {
  const b = fake()
  const live = run('stats', b, [])
  assert.equal(live.live, 'stats')
  assert.deepEqual(texts(live), formatStats(sampleStats()))
  assert.ok(kinds(live).every((k) => k === 'out'))
  const once = run('stats --once', b, [])
  assert.equal(once.live, undefined)
  assert.deepEqual(texts(once), formatStats(sampleStats()))
  const bad = run('stats --forever', b, [])
  assert.ok(isErr(bad))
  assert.equal(bad.live, undefined)
  assert.match(texts(bad).join('\n'), /unrecognized option '--forever'/)
})

test('formatStats shows Rapier3D latency, substeps, bodies, colliders, CCD, drawn agents, timings, quality, kernel', () => {
  const lines = formatStats(sampleStats())
  const t = lines.join('\n')
  assert.match(t, /^frame {5}59\.9 fps {2}16\.68 ms {2}p95 18\.20 ms {2}cpu 4\.10 ms$/m)
  // Compute timestamps not resolved (0) read as "-", not as a measured zero.
  assert.match(t, /^gpu {7}render 3\.25 ms {2}compute - ms$/m)
  assert.match(t, /^rapier3d {2}step 0\.412 ms {2}physics 1\.23 ms\/frame {2}substeps 2$/m)
  assert.match(t, /bodies 41 {2}colliders 612 {2}ccd 37/)
  assert.match(t, /drawn 3579 of 10000 \(35\.8%\) {2}near 1234 {2}far 2345/)
  assert.match(t, /waiting 120 {2}crossing 45 {2}yielding 3 {2}nudges 7/)
  assert.match(t, /^vehicles {2}36$/m)
  assert.match(t, /^quality {3}tier 3 High \(auto\) {2}scale 1\.00x {2}budget 16\.7 ms$/m)
  assert.match(t, /law1 5 {2}law2 1 {2}law3 2 {2}flips 4 {2}shielded no/)
  assert.match(t, /last First Law: person 3\.2 m ahead/)
  for (const l of lines) {
    assert.ok(l.length <= 80, `line too wide (${l.length}): ${l}`)
    assert.match(l, /^[\x20-\x7e]*$/, `non-ASCII in: ${l}`)
  }
})

test('formatStats on a lite profile: tier -1 reads Lite, and the line says the profile is lite (still 80 columns, ASCII)', () => {
  const s = { ...sampleStats(), quality: { tier: -1, label: 'Lite', auto: true, renderScale: 0.5, targetMs: 16.7, lite: true } }
  const lines = formatStats(s)
  assert.ok(lines.includes('quality   tier -1 Lite (auto)  scale 0.50x  budget 16.7 ms  lite profile'), lines.join('\n'))
  for (const l of lines) assert.ok(l.length <= 80 && /^[\x20-\x7e]*$/.test(l), l)
  // Not lite: the line is as it always was.
  assert.ok(!formatStats(sampleStats()).some((l) => l.includes('lite')))
})

test('formatStats and sim add the cinema camera row after the frame row: presented rate, shutter, ND, cuts (none without it)', () => {
  const s = { ...sampleStats(), camera: { fps: 24, shutterS: 1 / 48, ndStops: -Math.log2(0.56), cuts: 3 } }
  const lines = formatStats(s)
  const at = lines.findIndex((l) => l.startsWith('camera'))
  assert.equal(at, 1, 'right under the frame row')
  assert.equal(lines[at], 'camera    24.0 fps presented  shutter 1/48 s  ND 0.25 (0.84 stops)  cuts 3')
  assert.equal(formatStats({ ...s, camera: { ...s.camera, shutterS: 0 } })[1], 'camera    24.0 fps presented  shutter off (no post chain)  ND 0.25 (0.84 stops)  cuts 3')
  assert.equal(formatStats({ ...s, camera: { ...s.camera, fps: Number.NaN } })[1].slice(0, 20), 'camera    - fps pres')
  assert.ok(!formatStats(sampleStats()).some((l) => l.startsWith('camera')))
  for (const l of lines) assert.ok(l.length <= 80 && /^[\x20-\x7e]*$/.test(l), l)
  const b = fake()
  b.stats = () => s
  const t = texts(run('sim', b, []))
  assert.match(t[2], /^frame /)
  assert.equal(t[3], lines[at])
  assert.equal(t.length, 9)
})

test('formatStats survives an empty city and non-finite numbers', () => {
  const s = sampleStats()
  s.agents = { population: 0, drawnNear: 0, drawnFar: 0, waiting: 0, crossing: 0, yielding: 0, nudges: 0 }
  s.fps = NaN
  s.rapier.stepMs = Infinity
  s.kernel = { ...s.kernel, last: '', shielded: true }
  const t = formatStats(s).join('\n')
  assert.doesNotMatch(t, /NaN|Infinity/)
  assert.match(t, /drawn 0 of 0 {2}near 0/) // no percentage when there is no population
  assert.match(t, /frame {5}- fps/)
  assert.match(t, /step - ms/)
  assert.match(t, /shielded yes/)
  assert.match(t, /last -$/m)
})

test('laws prints the bridge laws in rank order', () => {
  const b = fake()
  const r = run('laws', b, [])
  assert.deepEqual(texts(r).slice(0, 6), ['1. Protect people', '   Law one text.', '2. Follow instructions', '   Law two text.', '3. Preserve itself', '   Law three text.'])
  assert.equal(r.lines[6].kind, 'sys')
  assert.ok(isErr(run('laws extra', b, [])))
})

test('kernel prints interventions per law, sensor flips, shield state and the last reason', () => {
  const b = fake()
  const t = texts(run('kernel', b, []))
  assert.match(t[0], /^LAW {2}TITLE +INTERVENTIONS$/)
  assert.match(t[1], /^1 {4}Protect people +5$/)
  assert.match(t[2], /^2 {4}Follow instructions +1$/)
  assert.match(t[3], /^3 {4}Preserve itself +2$/)
  assert.equal(t[4], 'Solid->Sensor flips 4  shielded no')
  assert.equal(t[5], 'last First Law: person 3.2 m ahead')
  assert.ok(!t.some((l) => l.startsWith('pedestrian sensing')), 'no sensing line without sensing figures')
})

test('kernel says where pedestrian sensing runs and how fresh its readings are', () => {
  const b = fake()
  const stats = b.stats
  b.stats = () => ({ ...stats(), sensing: { ageMs: 33.4, lagMs: 35.2 } })
  const t = texts(run('kernel', b, []))
  assert.equal(t.at(-1), 'pedestrian sensing  physics worker GPU  reading 33 ms old  round trip 35 ms')
  b.stats = () => ({ ...stats(), sensing: { ageMs: null, lagMs: 0 } })
  assert.equal(texts(run('kernel', b, [])).at(-1), 'pedestrian sensing  physics worker GPU  reading - old  round trip 0 ms')
})

test('quality: show, auto, a fixed tier; invalid tiers never reach the bridge', () => {
  const b = fake()
  assert.match(only(run('quality', b, [])).text, /^tier 3 High \(auto\)/)
  assert.match(only(run('quality 2', b, [])).text, /^tier 2 T2 \(fixed\)/)
  assert.match(only(run('quality auto', b, [])).text, /\(auto\)/)
  assert.match(only(run('quality 0', b, [])).text, /^tier 0 /)
  assert.match(only(run('quality 4', b, [])).text, /^tier 4 /)
  // Lite, below Minimal: by its number or its name.
  assert.match(only(run('quality -1', b, [])).text, /^tier -1 /)
  assert.match(only(run('quality lite', b, [])).text, /^tier -1 /)
  assert.deepEqual(b.calls, ['quality undefined', 'quality 2', 'quality auto', 'quality 0', 'quality 4', 'quality -1', 'quality -1'])
  b.calls.length = 0
  for (const bad of ['5', '-2', '-0', '1.5', '02', 'max', 'Lite', '3 4', '']) {
    const r = run(bad ? `quality ${bad}` : 'quality ""', b, [])
    assert.ok(isErr(r), `quality ${bad} should fail`)
  }
  assert.deepEqual(b.calls, [])
})

test('time: show, set HH and HH:MM, reject out-of-range values', () => {
  const b = fake()
  assert.equal(only(run('time', b, [])).text, '10:00')
  assert.equal(only(run('time 7', b, [])).text, '07:00')
  assert.equal(only(run('time 07:30', b, [])).text, '07:30')
  assert.equal(only(run('time 23:59', b, [])).text, '23:59')
  assert.equal(only(run('time 0', b, [])).text, '00:00')
  assert.deepEqual(b.calls, ['setClock 7', 'setClock 7.5', `setClock ${23 + 59 / 60}`, 'setClock 0'])
  b.calls.length = 0
  for (const bad of ['24', '7:60', '7:5', '-1', 'noon', '7.5', '123', '07:30:00', '7 30']) {
    assert.ok(isErr(run(`time ${bad}`, b, [])), `time ${bad} should fail`)
  }
  assert.deepEqual(b.calls, [])
})

test('audio: status, on/off, volume percent 0-100', () => {
  const b = fake()
  assert.equal(only(run('audio', b, [])).text, 'audio status -')
  assert.equal(only(run('audio off', b, [])).text, 'audio status off')
  assert.equal(only(run('audio on', b, [])).text, 'audio status on')
  run('audio 0', b, [])
  run('audio 55', b, [])
  run('audio 100%', b, [])
  assert.deepEqual(b.calls, ['audio undefined', 'audio off', 'audio on', 'audio 0', 'audio 55', 'audio 100'])
  b.calls.length = 0
  for (const bad of ['101', '-5', 'loud', '0.5', 'on off']) assert.ok(isErr(run(`audio ${bad}`, b, [])), `audio ${bad} should fail`)
  assert.deepEqual(b.calls, [])
})

test('hal lists the bus summary and devices', () => {
  const b = fake()
  const empty = run('hal', b, [])
  assert.equal(empty.lines[0].text, '0 device(s)')
  assert.equal(empty.lines[1].kind, 'sys')
  assert.match(empty.lines[1].text, /hal pair hid\|serial\|ble/)
  b.devs = [
    { id: 'hid:1', transport: 'hid', name: 'Controller', state: 'ready', detail: 'USB' },
    { id: 'serial:1', transport: 'serial', name: 'Bench rig', state: 'handshaking', detail: '' },
  ]
  const t = texts(run('hal', b, []))
  assert.equal(t[0], '2 device(s)')
  assert.match(t[1], /BUS +STATE +DEVICE/)
  assert.match(t[2], /^ {2}hid +ready +Controller {2}USB$/)
  assert.match(t[3], /^ {2}serial +handshaking +Bench rig$/)
  // The real bus summary is '' while nothing is attached: no blank first line.
  b.devs = []
  b.hal.summary = () => ''
  assert.deepEqual(run('hal', b, []).lines, [{ kind: 'sys', text: 'no devices; pair one with: hal pair hid|serial|ble' }])
})

test('hal pair calls the bridge synchronously (user gesture) and reports the result later', async () => {
  const b = fake()
  const dev: HalDevice = { id: 'hid:9', transport: 'hid', name: 'Controller', state: 'ready', detail: 'USB' }
  b.pairResult = Promise.resolve(dev)
  const r = run('hal pair hid', b, [])
  // The picker must already have been requested when run() returns: no await, no microtask in between.
  assert.deepEqual(b.calls, ['pair hid'])
  assert.equal(only(r).kind, 'sys')
  assert.ok(r.pending)
  assert.deepEqual(await r.pending, [{ kind: 'out', text: 'hal: Controller ready (hid, USB)' }])

  b.calls.length = 0
  b.pairResult = Promise.resolve(null)
  assert.deepEqual(await run('hal pair ble', b, []).pending, [{ kind: 'sys', text: 'hal: no device selected' }])
  assert.deepEqual(b.calls, ['pair bluetooth'])

  b.pairResult = Promise.reject(new Error('NotFoundError: user cancelled'))
  assert.deepEqual(await run('hal pair serial', b, []).pending, [{ kind: 'err', text: 'hal: pair failed: NotFoundError: user cancelled' }])

  // The bus resolves (not rejects) an 'error' device when the API is missing or the request is refused.
  b.pairResult = Promise.resolve({ id: 'serial:request', transport: 'serial', name: 'Serial', state: 'error', detail: 'Web Serial is not available in this browser' })
  assert.deepEqual(await run('hal pair serial', b, []).pending, [{ kind: 'err', text: 'hal: pair failed: Web Serial is not available in this browser' }])

  // A bridge that throws synchronously (API missing) is an error line, not an exception.
  b.pairResult = () => { throw new Error('WebHID unavailable') }
  const sync = run('hal pair hid', b, [])
  assert.deepEqual(sync.lines, [{ kind: 'err', text: 'hal: WebHID unavailable' }])
  assert.equal(sync.pending, undefined)
})

test('hal rejects malformed pair requests without prompting', () => {
  const b = fake()
  for (const bad of ['hal pair', 'hal pair usb', 'hal pair hid serial', 'hal list', 'hal pair constructor']) {
    const r = run(bad, b, [])
    assert.ok(isErr(r), `${bad} should fail`)
    assert.equal(r.pending, undefined)
  }
  assert.deepEqual(b.calls, [])
})

test('clear, history, whoami, version, uname and exit', () => {
  const b = fake()
  assert.deepEqual(run('clear', b, []), { lines: [], clear: true })
  assert.deepEqual(texts(run('history', b, ['help', 'stats'])), ['    1  help', '    2  stats', '    3  history'])
  // A repeat of the previous line is not stored by the terminal, so it is not numbered twice.
  assert.deepEqual(texts(run('history', b, ['help', 'history'])), ['    1  help', '    2  history'])
  // A multi-line entry keeps its lines, indented under its number.
  assert.deepEqual(texts(run('history', b, ['run a\n  b'])), ['    1  run a\n         b', '    2  history'])
  assert.equal(only(run('whoami', b, [])).text, 'root')
  assert.equal(only(run('version', b, [])).text, 'TESTBRAND 9.8.7 (Ring-0)')
  assert.equal(only(run('uname', b, [])).text, 'TESTBRAND')
  assert.equal(only(run('uname -a', b, [])).text, 'TESTBRAND testhost 9.8.7 #1 Ring-0 webgpu Test GPU (fake)')
  assert.equal(only(run('uname -rn', b, [])).text, 'testhost 9.8.7')
  assert.equal(only(run('uname -n -s -n', b, [])).text, 'TESTBRAND testhost')
  assert.ok(isErr(run('uname -x', b, [])))
  assert.ok(isErr(run('uname extra', b, [])))
  assert.deepEqual(run('exit', b, []), { lines: [], close: true })
  assert.deepEqual(run('exit 0', b, []), { lines: [], close: true })
  assert.ok(isErr(run('exit now', b, [])))
  assert.ok(isErr(run('whoami --all', b, [])))
})

test('the brand always comes from the bridge', () => {
  const b = unlocked()
  const everything = ['help', 'stats', 'laws', 'kernel', 'quality', 'time', 'audio', 'hal', 'version', 'uname -a', 'api', 'harness', 'record', 'sim', 'operator',
    'render', 'captions', 'ping', 'look', 'boot', 'map', 'r0', 'net', 'recruit']
    .flatMap((c) => texts(run(c, b, [])))
    .concat(motd(BRAND).map((l) => l.text))
    .join('\n')
  assert.doesNotMatch(everything, /ONYX|onyx|Agent City/)
  assert.match(motd(BRAND)[0].text, /TESTBRAND 9\.8\.7/)
  assert.match(motd(BRAND).map((l) => l.text).join('\n'), /type 'help'/i)
  assert.match(motd(BRAND).map((l) => l.text).join('\n'), /operator unlock/)
})

test('air gap: a failing or offline bridge becomes error lines, never an exception', () => {
  const off = offlineBridge(BRAND)
  for (const c of ['stats', 'stats --once', 'laws', 'kernel', 'quality', 'quality 2', 'time', 'time 8', 'audio', 'audio on', 'hal', 'hal pair hid',
    'operator', 'operator unlock', 'operator lock', 'run 1 + 1', 'run rust: 1 + 1', 'ask', 'ask rust: hi', 'ask model m', 'ask connect ollama', 'ask stop', 'say', 'say rust: hi',
    'swarm', 'swarm status', 'swarm roles', 'swarm guardrails', 'swarm audit', 'swarm plan x', 'swarm run x', 'swarm stop',
    'say voice v', 'say stop', 'memory', 'memory 7', 'memory forget 7', 'api', 'api clock', 'get', 'set physics.car.power 1', 'harness', 'harness list', 'harness run sanctuary', 'sim',
    'record', 'record status', 'record start', 'record start camera', 'record stop', 'render', 'render off', 'captions', 'captions on', 'ping', 'ping go', 'ping clear',
    'look', 'look show 7', 'look reset', 'look top 2', 'recruit', 'recruit rally 7', 'recruit rally 7 1 2']) {
    const r = run(c, off, [])
    assert.ok(isErr(r), `${c} should report an error offline`)
    assert.match(texts(r)[0], /engine not running$/)
    assert.equal(r.live, undefined)
    assert.equal(r.pending, undefined)
  }
  // Identity commands still work before the engine is up.
  assert.equal(only(run('version', off, [])).text, 'TESTBRAND 9.8.7 (Ring-0)')
  assert.equal(only(run('uname -a', off, [])).text, 'TESTBRAND testhost 9.8.7 #1 Ring-0 webgpu unknown')
  assert.equal(only(run('whoami', off, [])).text, 'root')
  // So do the commands that need no engine: the console's own machine, and the track it was mounted on.
  assert.deepEqual(run('r0 1 2 + .', off, []).lines, [{ kind: 'out', text: '3' }])
  assert.equal(only(run('boot status', off, [])).text, 'boot: gui (Track A: the city; boot tty for this console alone)')
  // The offline bridge has no network client: the network commands say so, in those words.
  for (const c of ['net', 'net status', 'net join ws://127.0.0.1:1 t', 'net leave', 'net forget']) assert.match(only(run(c, off, [])).text, /network not available/, c)
  const thrower = fake()
  thrower.stats = () => { throw new TypeError('boom') }
  assert.deepEqual(run('stats', thrower, []).lines, [{ kind: 'err', text: 'stats: boom' }])
  // A bridge from before the operator tier (no `operator`): the operator commands say so.
  const old = fake()
  Object.assign(old, { operator: undefined })
  for (const c of ['operator', 'run 1', 'ask', 'ask rust: hi', 'say', 'say rust: hi', 'memory forget 7', 'api', 'get', 'set physics.x 1', 'harness', 'swarm', 'swarm run x']) {
    assert.match(only(run(c, old, [])).text, /operator tier not available/, c)
  }
  // A bridge from before the swarm's memory (no `memory`): the memory command says so.
  const forgetful = fake()
  Object.assign(forgetful, { memory: undefined })
  for (const c of ['memory', 'memory 7', 'memory forget all']) assert.match(only(run(c, forgetful, [])).text, /memory not available/, c)
  // A bridge whose host keeps no look (no `look`): likewise.
  const bare = fake()
  Object.assign(bare, { look: undefined })
  for (const c of ['look', 'look show 7', 'look reset', 'look preset navy suit']) assert.match(only(run(c, bare, [])).text, /look not available/, c)
  assert.match(texts(run('sim', old, [])).at(-1) ?? '', /^operator {2}locked/)
  // A bridge from before the recorder (no `record`): likewise.
  const older = fake()
  Object.assign(older, { record: undefined })
  for (const c of ['record', 'record status', 'record start', 'record stop']) {
    assert.match(only(run(c, older, [])).text, /recorder not available/, c)
  }
})

test('air gap: while locked, across every command and completion, the only knobs touched are the view knobs, clock, quality, audio, pairing, pings, the look, recruitment and the model file kept in this page', () => {
  const b = fake()
  const lines = complete('').flatMap((c) => [c, ...complete(`${c} `), ...complete(`${c} `).flatMap((a) => complete(`${a} `))])
  // `operator unlock` is the one line that changes the lock state; every other line runs against the locked tier.
  assert.ok(lines.includes('operator unlock'))
  const sweep = [...lines.filter((l) => l !== 'operator unlock'), 'time 8', 'time 08:15', 'run 1 + 1', 'run rust: 1 + 1', 'get physics', 'set physics.car.power 2', 'harness run kernel-stop',
    'recruit rally 7', 'recruit rally 7 1 2', 'look show 7', 'look top 2', 'look code ABCD-EFGH', 'net join ws://127.0.0.1:8787 tok']
  for (const l of sweep) void run(l, b, ['help'])
  const touched = new Set(b.calls.map((c) => c.split(' ')[0]))
  assert.deepEqual([...touched].sort(), ['audio', 'captions', 'ghost', 'look', 'memory', 'model', 'net', 'pair', 'ping', 'quality', 'rain', 'recruit', 'render', 'setClock', 'stats'])
  // The model file kept in this page and its GPU switch keep a file or a setting and send no prompt, so they need no
  // unlock (`ask file`, `ask gpu`); the prompt itself (`ask <skill>: ...`) is refused below like every operator command.
  // No completed line forgets a kept file: `ask file forget` alone names none, so it is refused.
  const modelVerbs = new Set(b.calls.filter((c) => c.startsWith('model ')).map((c) => c.split(' ')[1]))
  assert.deepEqual([...modelVerbs].sort(), ['gpu', 'load', 'log', 'pick', 'unload'])
  // The swarm's memory is only ever read while locked: nobody's ledger is erased.
  const reads = new Set(b.calls.filter((c) => c.startsWith('memory ')).map((c) => c.split(' ')[1]))
  assert.deepEqual([...reads].sort(), ['status'])
  // The network session is only ever read while locked: nothing joins, leaves or forgets.
  const netReads = new Set(b.calls.filter((c) => c.startsWith('net ')).map((c) => c.split(' ')[1]))
  assert.deepEqual([...netReads].sort(), ['status'])
  // Recruitment only ever asks (the physics worker decides), and only through its own surface.
  const verbs = new Set(b.calls.filter((c) => c.startsWith('recruit ')).map((c) => c.split(' ')[1]))
  assert.deepEqual([...verbs].sort(), ['ask', 'dismiss', 'install', 'listen', 'rally', 'status', 'stop'])
  // The operator surface saw at most `lock` (harmless); no script ran, no harness started.
  assert.deepEqual(b.operator.opCalls.filter((c) => c !== 'lock'), [])
  // The recorder was only ever read: no recording started or stopped, no picker requested.
  assert.ok(b.record.recCalls.length > 0 && b.record.recCalls.every((c) => c === 'status'), JSON.stringify(b.record.recCalls))
  for (const l of ['run 1 + 1', 'run sim.clock.set(3)', 'run rust: sim.clock.set(3)', 'run rust, go: 1', 'ask', 'ask rust: hi', 'ask model m', 'ask server http://localhost:1', 'ask stop',
    'say', 'say rust: over here', 'say voice v', 'say model m', 'say server http://localhost:1', 'say auto on', 'say stop', 'memory forget 7', 'memory forget all',
    'get', 'get physics', 'set physics.car.power 2', 'harness run kernel-stop', 'harness run sanctuary', 'record start', 'record start camera', 'record stop',
    'net join ws://127.0.0.1:8787 tok', 'net join wss://localhost:8788', 'net leave', 'net forget', 'act ok', 'act no']) {
    const r = run(l, b, [])
    assert.ok(isErr(r), `${l} should be refused while locked`)
    assert.match(texts(r)[0], /^\w+: locked; type 'operator unlock' first$/)
    assert.equal(r.pending, undefined)
  }
  // Documentation is readable while locked.
  assert.ok(texts(run('api', b, [])).length > 10)
  assert.ok(texts(run('harness list', b, [])).length === harnesses().length + 1)
  assert.deepEqual(b.operator.opCalls.filter((c) => c !== 'lock'), [])
  // A waiting proposal is read while locked (`act`, `act log`, `act list`), never decided: `act ok` and `act no` are
  // refused before the tier is asked, and the console never subscribes to the tier's events (the terminal does). The
  // real tier withdraws the proposal when it locks (operator.ts lock), so nothing waits while locked and `y` is then
  // `not found` as before; this fake holds one to prove the console's own guard.
  b.operator.acts.waiting = PROPOSAL
  assert.deepEqual(texts(run('act', b, [])), ['act 1: waiting for your OK: agent 7 (Rust, Python) proposes: set the clock to 22:00', '  y allows it, n refuses it; it runs only while they stay tethered'])
  assert.deepEqual(texts(run('act list', b, [])), CATALOGUE)
  assert.deepEqual(texts(run('act log', b, [])).length, 2)
  for (const l of ['act ok', 'act no']) assert.deepEqual(texts(run(l, b, [])), ["act: locked; type 'operator unlock' first"], l)
  assert.equal(b.operator.acts.pending(), PROPOSAL, 'still waiting')
  assert.deepEqual(b.operator.opCalls.filter((c) => c !== 'lock'), [])
  assert.equal(b.operator.acts.followers.size, 0)
})

test('air gap: the terminal files reach nothing at runtime beyond React, the brand and each other', () => {
  const allowedTypes = [
    '../../02_Define_The_Rules/laws.ts', '../../03_Spawn_Agents/look.ts', '../../04_Connect_Hardware/hal.ts', '../../05_Observe_Environment/telemetry.ts',
    '../../05_Observe_Environment/recorder.ts', '../operator.ts', '../harness.ts', '../../08_Swarm/orchestrator.ts',
  ]
  // repl.ts is the console's own machine: a runtime import, and the one terminal module that imports nothing itself.
  // react-dom is React's own renderer: Terminal.tsx takes flushSync from it, so a tap can open the console and focus it at once.
  const allowedRuntime = ['react', 'react-dom', '../../brand.ts', './bridge.ts', './commands.ts', './repl.ts']
  for (const file of ['bridge.ts', 'commands.ts', 'Terminal.tsx', 'repl.ts']) {
    const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /\bimport\s*\(|\brequire\s*\(|__AC__|__SIM__/, `${file}: dynamic import or debug handle`)
    const imports = [...src.matchAll(/^\s*(import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?'([^']+)'/gm)]
    // repl.ts is the stack machine: it imports nothing at all (repl.test.ts pins that too).
    assert.ok(file === 'repl.ts' ? imports.length === 0 : imports.length > 0, `${file}: ${imports.length} imports parsed`)
    for (const [, , typeOnly, spec] of imports) {
      const ok = typeOnly ? allowedTypes.includes(spec) || allowedRuntime.includes(spec) : allowedRuntime.includes(spec)
      assert.ok(ok, `${file} imports ${typeOnly ? 'type ' : ''}'${spec}'`)
    }
  }
})

test('operator: status, the unlock banner, lock; the banner says what stays in force', () => {
  const b = fake()
  assert.equal(only(run('operator', b, [])).text, "operator: locked (type 'operator unlock')")
  assert.equal(only(run('operator status', b, [])).text, "operator: locked (type 'operator unlock')")
  const r = run('operator unlock', b, [])
  const t = texts(r).join('\n')
  assert.match(t, /^Ring-0 operator tier unlocked\./)
  assert.match(t, /run <skill>: <js>/)
  assert.match(t, /while someone tethered to you has the skill/)
  assert.match(t, /harness run <name>/)
  assert.match(t, /three laws/)
  assert.match(t, /Sanctuary/)
  assert.match(t, /safety nudge/)
  assert.match(t, /cannot reach or alter/)
  assert.ok(kinds(r).every((k) => k === 'out' || k === 'sys'))
  assert.equal(only(run('operator', b, [])).text, 'operator: unlocked')
  assert.equal(only(run('operator unlock', b, [])).kind, 'sys')
  assert.equal(only(run('operator lock', b, [])).text, 'operator: locked')
  assert.equal(only(run('operator', b, [])).text, "operator: locked (type 'operator unlock')")
  assert.ok(isErr(run('operator open', b, [])))
  assert.ok(isErr(run('operator unlock now', b, [])))
  assert.deepEqual(b.operator.opCalls, ['unlock', 'lock'])
  assert.deepEqual(b.calls, [])
})

test('run: the skills before the colon, then the script verbatim (quotes, colons, newlines); Authorized says who it is bound to, then its output', async () => {
  const b = unlocked()
  const bound = { kind: 'sys', text: 'run: Authorized: bound to agent 7 (Rust, Python)' }
  const r = run('run rust: 1 + 1', b, [])
  assert.deepEqual(r.lines, [bound], 'decided at once')
  assert.deepEqual(await r.pending, [{ kind: 'out', text: '2' }])
  assert.deepEqual(b.operator.opCalls, ['exec rust: 1 + 1'])
  // Several skills; the script keeps its own quotes, colons and newlines.
  const two = run("run Rust , go:console.log(\"it's: \", 1)\nreturn 'ok'", b, [])
  assert.deepEqual(await two.pending, [{ kind: 'out', text: "it's:  1" }, { kind: 'out', text: 'ok' }])
  assert.equal(b.operator.opCalls.at(-1), "exec Rust,go: console.log(\"it's: \", 1)\nreturn 'ok'")
  assert.deepEqual(await run('run c++: ({ a: 1, b: "x: y" })', b, []).pending, [{ kind: 'out', text: '{"a":1,"b":"x: y"}' }])
  // A script's quotes are not shell quotes: an unbalanced one is the script's own syntax error.
  assert.match((await run('run rust: "unterminated', b, []).pending)?.[0].text ?? '', /^run: SyntaxError: /)
  assert.deepEqual(await run('run rust: throw new Error("boom")', b, []).pending, [{ kind: 'err', text: 'run: boom' }])
  assert.deepEqual(await run('run rust: sim.clock.set(3)', b, []).pending, [])
  assert.deepEqual(await run('run rust: "a\\nb"', b, []).pending, [{ kind: 'out', text: 'a' }, { kind: 'out', text: 'b' }])
  assert.deepEqual(await run('run rust: sim.physics.tune()', b, []).pending, [{ kind: 'out', text: '{"car.power":1,"car.drag":1}' }])
  assert.deepEqual(await run('  run   rust:   2 * 3', b, []).pending, [{ kind: 'out', text: '6' }])
  assert.equal((await run('run rust: typeof sim.kernel.blindSensing', b, []).pending)?.[0].text, 'undefined')
  // No skill named: refused before anything reaches the gateway, with the usage.
  const before = b.operator.opCalls.length
  for (const line of ['run 1 + 1', 'run sim.clock.set(3)', 'run ({ a: 1 })', 'run a ? b : c', 'run "a: b"', 'run 2: 1', 'run : 1']) {
    const no = run(line, b, [])
    assert.ok(isErr(no), line)
    assert.deepEqual(texts(no), ['run: name the skill the script needs first, e.g. run rust: sim.physics.tune()', 'usage: run <skill>[,<skill>...]: <js...>'], line)
    assert.equal(no.pending, undefined, line)
  }
  for (const line of ['run', 'run   ', 'run rust:', 'run rust:   ']) {
    assert.ok(isErr(run(line, b, [])), line)
    assert.equal(run(line, b, []).pending, undefined, line)
  }
  assert.equal(b.operator.opCalls.length, before)
  // Only the operator surface is touched, never an engine knob.
  assert.deepEqual(b.calls, [])
  // A failing bridge becomes an error line.
  b.operator.exec = () => ({ state: 'Authorized', bound: [TETHER], result: Promise.reject(new Error('sandbox down')) })
  assert.deepEqual(await run('run rust: 1', b, []).pending, [{ kind: 'err', text: 'run: sandbox down' }])
  b.operator.exec = () => { throw new Error('sync down') }
  assert.deepEqual(run('run rust: 1', b, []).lines, [{ kind: 'err', text: 'run: sync down' }])
})

test('run: Rejected and Aborted print in the gateway\'s words, the same way every time; an abort keeps what the script logged before it', async () => {
  const b = unlocked()
  b.operator.gate = 'reject'
  const no = run('run networking: sim.clock.set(3)', b, [])
  assert.deepEqual(no.lines, [], 'nothing is authorized, so nothing is bound')
  const rejected = [{ kind: 'err', text: 'run: Rejected (Insufficient Capabilities): nobody tethered to the operator has networking' }]
  assert.deepEqual(await no.pending, rejected)
  assert.deepEqual(await run('run networking: sim.clock.set(3)', b, []).pending, rejected, 'deterministic')
  b.operator.gate = 'abort'
  const cut = run('run rust: console.log("partial"); await sleep(60000)', b, [])
  assert.deepEqual(cut.lines, [{ kind: 'sys', text: 'run: Authorized: bound to agent 7 (Rust, Python)' }])
  assert.deepEqual(await cut.pending, [
    { kind: 'out', text: 'partial' },
    { kind: 'err', text: 'run: Aborted (Spatial Tether Lost): agent 7 (Rust, Python): no longer tethered to the operator' },
  ])
  // Several tethers are named together.
  b.operator.gate = 'open'
  b.operator.exec = () => ({ state: 'Authorized', bound: [TETHER, { agent: 9, serial: 2, skills: ['Go', 'Data'] }], result: new Promise(() => {}) })
  assert.deepEqual(run('run rust, go: 1', b, []).lines, [{ kind: 'sys', text: 'run: Authorized: bound to agent 7 (Rust, Python) and agent 9 (Go, Data)' }])
  assert.deepEqual(b.calls, [])
})

test('api lists every sim.* signature; api <path> explains one branch; unknown paths fail', () => {
  const b = fake()
  const all = run('api', b, [])
  const t = texts(all)
  assert.equal(all.lines[0].kind, 'sys')
  // A statement-form script prints nothing unless it returns; the header says so.
  assert.equal(all.lines[1].kind, 'sys')
  assert.match(t[1], /returns/)
  for (const d of apiDoc()) assert.ok(t.includes(`  ${d.signature}`), d.path)
  assert.match(t[t.length - 1], /api <path>/)
  const v = texts(run('api vehicles', b, []))
  assert.equal(v.length, 2 * apiDoc().filter((d) => d.path.startsWith('sim.vehicles.')).length)
  assert.match(v[0], /^sim\.vehicles\.count\(\)/)
  assert.match(v[1], /^ {4}\w/)
  assert.deepEqual(texts(run('api sim.clock.set', b, [])).length, 2)
  assert.deepEqual(texts(run('api clock.set', b, [])), texts(run('api sim.clock.set', b, [])))
  assert.equal(texts(run('api snapshot', b, [])).length, 2)
  assert.equal(texts(run('api sleep', b, [])).length, 2)
  assert.equal(texts(run('api console', b, [])).length, 2)
  assert.deepEqual(texts(run('api signal', b, [])).map((l) => l.trim().split(':')[0]), ['signal', 'Aborted the moment a tether the script is bound to breaks; from then on every sim call throws.'])
  assert.match(t[0], /run <skill>: <js>/)
  assert.ok(isErr(run('api nope', b, [])))
  assert.ok(isErr(run('api clock.sets', b, [])))
  assert.ok(isErr(run('api a b', b, [])))
  assert.deepEqual(b.calls, [])
})

test('ask: the skills before the colon, the prompt verbatim; Authorized streams the answer live, then prints it with a closing note', async () => {
  const b = unlocked()
  const r = run('ask rust: how does "car.grip" work?\nbriefly', b, [])
  assert.deepEqual(r.lines, [{ kind: 'sys', text: 'ask: Authorized: bound to agent 7 (Rust, Python)' }], 'decided at once')
  assert.equal(b.operator.opCalls.at(-1), 'ask rust: how does "car.grip" work?\nbriefly')
  const live: string[] = []
  const off = r.stream!.subscribe((p) => live.push(`${p.kind}:${p.text}`))
  assert.deepEqual(await r.pending, [
    { kind: 'out', text: 'Grip scales' },
    { kind: 'out', text: 'tyre friction.' },
    { kind: 'sys', text: '-- answered in 1.2 s, after 1 tokens of thinking --' },
  ])
  assert.deepEqual(live, ['thinking:hmm', 'text:Grip scales\n', 'text:tyre friction.'], 'every piece reached the terminal as it came')
  off()
  b.operator.answer = 'length'
  assert.equal((await run('ask rust: more', b, []).pending)?.at(-1)?.text, '-- answered in 1.2 s, after 1 tokens of thinking (cut at the token limit) --')
  assert.deepEqual(b.calls, [], 'no engine knob was touched')
})

test('ask: Rejected, Aborted, a failing server, a model that only thought: each in its own words, the same every time', async () => {
  const b = unlocked()
  b.operator.answer = 'reject'
  const no = run('ask networking: how do lights change?', b, [])
  assert.deepEqual([no.lines, no.stream], [[], undefined], 'nothing is authorized, so nothing streams')
  const rejected = [{ kind: 'err', text: 'ask: Rejected (Insufficient Capabilities): nobody tethered to the operator has networking' }]
  assert.deepEqual(await no.pending, rejected)
  assert.deepEqual(await run('ask networking: how do lights change?', b, []).pending, rejected, 'deterministic')
  b.operator.answer = 'abort'
  assert.deepEqual(await run('ask rust: explain', b, []).pending, [
    { kind: 'out', text: 'Grip scales' },
    { kind: 'out', text: 'tyre friction.' },
    { kind: 'err', text: 'ask: Aborted (Spatial Tether Lost): agent 7 (Rust, Python): no longer tethered to the operator' },
  ])
  b.operator.answer = 'fail'
  assert.deepEqual(await run('ask rust: explain', b, []).pending, [
    { kind: 'err', text: 'ask: no local model server is answering at http://localhost:11434: start it, or point ask at the right address (ask server <url>)' },
  ])
  b.operator.answer = 'thinking'
  assert.deepEqual(await run('ask rust: explain', b, []).pending, [
    { kind: 'sys', text: '(no answer: the model spent its tokens thinking)' },
    { kind: 'sys', text: '-- answered in 2.7 s, after 24 tokens of thinking (cut at the token limit) --' },
  ])
})

test('ask: alone it reports the server, the model and what the server has; model, server and stop; malformed lines are refused', async () => {
  const b = unlocked()
  assert.deepEqual(await run('ask', b, []).pending, [
    { kind: 'out', text: 'server    http://localhost:11434  (this machine only)' },
    { kind: 'out', text: 'model     test-model' },
    { kind: 'out', text: 'installed a-model' },
    { kind: 'out', text: '          test-model  (chosen)' },
  ])
  assert.deepEqual(run('ask model a-model', b, []).lines, [{ kind: 'out', text: 'model     a-model' }])
  assert.deepEqual(run('ask server http://localhost:12345', b, []).lines, [{ kind: 'out', text: 'server    http://localhost:12345' }])
  assert.deepEqual(run('ask server http://example.com', b, []).lines, [
    { kind: 'err', text: "ask: the local model server must be on this machine (localhost, 127.0.0.1 or [::1]), not 'http://example.com'" },
  ])
  assert.deepEqual(run('ask stop', b, []).lines, [{ kind: 'out', text: 'ask: no answer is being generated' }])
  assert.deepEqual(texts(run('ask model', b, [])), ['usage: ask model <name>'])
  assert.deepEqual(texts(run('ask server  ', b, [])), ['usage: ask server <url>'])
  assert.deepEqual(run('ask think on', b, []).lines, [{ kind: 'out', text: 'think     on: the model reasons before it answers (slower; its thinking shows live)' }])
  assert.deepEqual(run('ask think off', b, []).lines, [{ kind: 'out', text: 'think     off: the model answers without reasoning first' }])
  assert.deepEqual(texts(run('ask think maybe', b, [])), ['ask: ask think takes on or off'])
  assert.deepEqual(texts(run('ask think', b, [])), ['usage: ask think <on|off>'])
  for (const line of ['ask how does grip work?', 'ask 42: hi', 'ask "a: b"']) {
    const no = run(line, b, [])
    assert.deepEqual(texts(no), ['ask: name the skill the answer needs first, e.g. ask rust: how does car.grip work?', 'usage: ask [<skill>[,<skill>...]: <prompt...>|provider <name>|connect <provider> [<url>] [<key>]|model <name>|server <url>|key <key>|effort <level>|think on|off|api <format>|file [forget <name>|load|unload|log]|gpu auto|on|off|stop]'], line)
    assert.equal(no.pending, undefined, line)
  }
  assert.ok(isErr(run('ask rust:', b, [])))
  // No model chosen: a sentence, before anything is asked.
  b.operator.mind.model = null
  assert.deepEqual(run('ask rust: hi', b, []).lines, [{ kind: 'err', text: 'ask: choose a model first: ask model <name> (type ask to list them)' }])
  const status = await run('ask', b, []).pending
  assert.equal(status?.[1].text, 'model     none chosen: ask model <name>')
  assert.equal(status?.at(-1)?.text, 'choose one that writes text: ask model <name>')
  assert.deepEqual(b.calls, [])
})

test('say: the skills before the colon, the text verbatim; Authorized names the speaker at once, then how it ended', async () => {
  const b = unlocked()
  const r = run('say rust: over here,\nby the "lamp"', b, [])
  assert.deepEqual(r.lines, [{ kind: 'sys', text: 'say: Authorized: said by agent 7 (Rust, Python)' }], 'decided at once')
  assert.equal(b.operator.opCalls.at(-1), 'say rust: over here,\nby the "lamp"')
  assert.equal(r.stream, undefined, 'speech is heard, not printed')
  assert.deepEqual(await r.pending, [{ kind: 'sys', text: '-- said by agent 7 (Rust, Python) (2.5 s) --' }])
  b.operator.speech = 'reject'
  const no = run('say networking: hello', b, [])
  assert.deepEqual(no.lines, [])
  assert.deepEqual(await no.pending, [{ kind: 'err', text: 'say: Rejected (Insufficient Capabilities): nobody tethered to the operator has networking' }])
  b.operator.speech = 'abort'
  assert.deepEqual(await run('say rust: hello', b, []).pending, [
    { kind: 'err', text: 'say: Aborted (Spatial Tether Lost): agent 7 (Rust, Python): no longer tethered to the operator' },
  ])
  b.operator.speech = 'fail'
  assert.deepEqual(await run('say rust: hello', b, []).pending, [
    { kind: 'err', text: 'say: no local speech server is answering at http://localhost:8880: start it, or point say at the right address (say server <url>)' },
  ])
  b.operator.speech = 'stopped'
  assert.deepEqual(await run('say rust: hello', b, []).pending, [{ kind: 'sys', text: 'say: stopped by the operator' }], "the operator's own stop is not an error")
  assert.deepEqual(b.calls, [], 'no engine knob was touched')
})

test('say: alone it reports the server, the voice, the model, auto and the voices; each setting and stop; malformed lines are refused', async () => {
  const b = unlocked()
  assert.deepEqual(await run('say', b, []).pending, [
    { kind: 'out', text: 'server    http://localhost:8880  (this machine only)' },
    { kind: 'out', text: 'voice     test-voice' },
    { kind: 'out', text: "model     the server's default" },
    { kind: 'out', text: 'auto      off' },
    { kind: 'out', text: 'voices    a-voice' },
    { kind: 'out', text: '          test-voice  (chosen)' },
  ])
  assert.deepEqual(run('say voice a-voice', b, []).lines, [{ kind: 'out', text: 'voice     a-voice' }])
  assert.deepEqual(run('say model open-tts', b, []).lines, [{ kind: 'out', text: 'model     open-tts' }])
  assert.deepEqual(run('say server http://example.com', b, []).lines, [{ kind: 'err', text: "say: the local speech server must be on this machine (localhost, 127.0.0.1 or [::1]), not 'http://example.com'" }])
  assert.deepEqual(run('say server http://localhost:9000', b, []).lines, [{ kind: 'out', text: 'server    http://localhost:9000' }])
  assert.deepEqual(run('say auto on', b, []).lines, [{ kind: 'out', text: 'auto      on: answers are said aloud by whoever gives them' }])
  assert.deepEqual(run('say stop', b, []).lines, [{ kind: 'out', text: 'say: nothing is being said' }])
  assert.deepEqual(texts(run('say voice', b, [])), ['usage: say voice <name>'])
  assert.deepEqual(texts(run('say auto', b, [])), ['usage: say auto <on|off>'])
  assert.deepEqual(texts(run('say server ', b, [])), ['usage: say server <url>'])
  for (const line of ['say hello there', 'say 42: hi', 'say "a: b"']) {
    const no = run(line, b, [])
    assert.deepEqual(texts(no), [
      'say: name the skill of whoever should say it first, e.g. say rust: over here',
      'usage: say [<skill>[,<skill>...]: <text...>|voice <name>|model <name>|server <url>|provider local|elevenlabs|key <key>|none|auto on|off|stop]',
    ], line)
    assert.equal(no.pending, undefined, line)
  }
  assert.ok(isErr(run('say rust:', b, [])))
  b.operator.voice.voice = null
  assert.deepEqual(run('say rust: hi', b, []).lines, [{ kind: 'err', text: 'say: choose a voice first: say voice <name> (type say to list them)' }])
  assert.deepEqual(b.calls, [])
})

test('ask with say auto on: the answer stays as it streamed until it has been said, then both endings print', async () => {
  const b = unlocked()
  b.operator.speakAnswer = { state: 'Authorized', speaker: TETHER, seconds: 3.25, ms: 3400 }
  assert.deepEqual(await run('ask rust: how does car.grip work?', b, []).pending, [
    { kind: 'out', text: 'Grip scales' },
    { kind: 'out', text: 'tyre friction.' },
    { kind: 'sys', text: '-- answered in 1.2 s, after 1 tokens of thinking --' },
    { kind: 'sys', text: '-- said by agent 7 (Rust, Python) (3.3 s) --' },
  ])
  b.operator.speakAnswer = { state: 'Aborted', reason: 'agent 7 (Rust, Python): no longer tethered to the operator', ms: 900 }
  assert.equal((await run('ask rust: again', b, []).pending)?.at(-1)?.text, 'say: Aborted (Spatial Tether Lost): agent 7 (Rust, Python): no longer tethered to the operator')
})

test('memory: status and ledgers are read at any time; forget needs the operator tier and a number or all', async () => {
  const b = fake()
  assert.deepEqual(run('memory', b, []).lines, [], 'the ledgers arrive later')
  assert.deepEqual(await run('memory', b, []).pending, [
    { kind: 'out', text: 'memory: 2 people remembered in this city (seed 1337), kept on this machine between visits' },
    { kind: 'out', text: 'agent 7 (Rust, Python): 3 episodes, last just now: ask' },
  ])
  assert.deepEqual(texts({ lines: (await run('memory 7', b, []).pending) ?? [] }), [
    '16:05:12  #3  tethered · Rust, Python',
    '16:06:40  #3  ask · how does car.grip work? → Grip scales tyre friction.',
  ])
  assert.deepEqual(texts(run('memory forget all', b, [])), ["memory: locked; type 'operator unlock' first"])
  assert.ok(!b.calls.some((c) => c.startsWith('memory forget')), 'nothing erased while locked')
  run('operator unlock', b, [])
  assert.deepEqual(await run('memory forget 7', b, []).pending, [{ kind: 'out', text: 'memory: agent 7 remembers nothing now' }])
  assert.deepEqual(await run('memory forget all', b, []).pending, [{ kind: 'out', text: 'memory: forgot 2 people in this city' }])
  for (const line of ['memory seven', 'memory -1', 'memory forget', 'memory forget everyone', 'memory 7 8']) assert.ok(isErr(run(line, b, [])), line)
  assert.deepEqual(b.calls.filter((c) => c.startsWith('memory ')), ['memory status', 'memory status', 'memory ledger 7', 'memory forget 7', 'memory forget all'])
})

test('get and set read and write tuning keys through the facade: fixed knobs, never a script, never the gateway', () => {
  const b = unlocked()
  const all = run('get', b, [])
  assert.equal(all.pending, undefined, 'answered at once')
  // One column for every row: the longest key plus two blanks.
  assert.deepEqual(texts(all), ['physics.car.power             1', 'physics.car.drag              1', 'shaders.light.haze            1', 'shaders.volumetrics.strength  0.5'])
  assert.ok(all.lines.every((l) => l.kind === 'out' && /^\S+ {2,}\S+$/.test(l.text) && l.text.search(/\S+$/) === 30))
  assert.deepEqual(texts(run('get shaders', b, [])), ['shaders.light.haze            1', 'shaders.volumetrics.strength  0.5'])
  assert.deepEqual(texts(run('get physics.car.d', b, [])), ['physics.car.drag  1'])
  assert.deepEqual(run('get nope', b, []).lines, [{ kind: 'err', text: "get: no key matches 'nope'" }])
  assert.ok(isErr(run('get a b', b, [])))
  assert.deepEqual(run('set physics.car.power 1.5', b, []).lines, [{ kind: 'out', text: 'physics.car.power = 1.5' }])
  assert.deepEqual(run('set physics.car.power 9', b, []).lines, [{ kind: 'out', text: 'physics.car.power = 2' }]) // clamped by the engine
  assert.deepEqual(run('set shaders.light.haze 0.25', b, []).lines, [{ kind: 'out', text: 'shaders.light.haze = 0.25' }])
  assert.deepEqual(run('set shaders.volumetrics.strength -1', b, []).lines, [{ kind: 'out', text: 'shaders.volumetrics.strength = -1' }])
  assert.deepEqual(texts(run('get physics.car.power', b, [])), ['physics.car.power  2'])
  assert.deepEqual(run('set physics.nope 1', b, []).lines, [{ kind: 'err', text: "set: unknown physics key 'nope'" }])
  for (const bad of ['set car.power 1', 'set physics.car.power abc', 'set physics.car.power', 'set physics.car.power 1 2', 'set', 'set physics. 1', 'set physics.car.power ""']) {
    const r = run(bad, b, [])
    assert.ok(isErr(r), `${bad} should fail`)
    assert.equal(r.pending, undefined)
  }
  // A table that does not read back as tables is reported, not printed.
  b.operator.tuning = () => ({ physics: 'nope' }) as unknown as ReturnType<OperatorBridge['tuning']>
  assert.deepEqual(run('get', b, []).lines, [{ kind: 'err', text: 'get: the tuning tables did not read back as expected' }])
  assert.ok(b.operator.opCalls.every((c) => c === 'tuning' || c.startsWith('tune ')), JSON.stringify(b.operator.opCalls))
  assert.deepEqual(b.calls, [])
})

test('harness: list, run with progress and a verdict line, unknown names', async () => {
  const b = fake()
  const list = run('harness', b, [])
  assert.equal(texts(list).length, harnesses().length + 1)
  for (const h of harnesses()) assert.ok(texts(list).some((l) => l.startsWith(`  ${h.name}`) && l.includes(h.summary)), h.name)
  assert.equal(list.lines[list.lines.length - 1].kind, 'sys')
  assert.deepEqual(texts(run('harness list', b, [])), texts(list))
  assert.ok(isErr(run('harness run kernel-stop', b, [])))
  run('operator unlock', b, [])
  const r = run('harness run kernel-stop', b, [])
  assert.equal(only(r).kind, 'sys')
  assert.match(only(r).text, /running kernel-stop/)
  assert.deepEqual(await r.pending, [{ kind: 'out', text: 'ran kernel-stop' }, { kind: 'out', text: 'PASS  kernel-stop  (1.2 s)' }])
  assert.deepEqual(await run('harness run traffic-lights', b, []).pending, [{ kind: 'out', text: 'ran traffic-lights' }, { kind: 'err', text: 'FAIL  traffic-lights  (1.2 s)' }])
  const unknown = run('harness run nope', b, [])
  assert.ok(isErr(unknown))
  assert.match(texts(unknown)[1], /kernel-stop, first-law-floor, sanctuary, brake-distance, traffic-lights/)
  assert.equal(unknown.pending, undefined)
  for (const bad of ['harness bogus', 'harness run', 'harness run a b', 'harness list extra']) assert.ok(isErr(run(bad, b, [])), bad)
  assert.deepEqual(b.operator.opCalls.filter((c) => c.startsWith('harness')), ['harness kernel-stop', 'harness traffic-lights'])
  b.operator.harness = () => Promise.reject(new Error('busy'))
  assert.deepEqual(await run('harness run sanctuary', b, []).pending, [{ kind: 'err', text: 'harness: busy' }])
})

test('record status reads at any time: idle, the live recording line, or the last recording\'s figures', () => {
  const b = fake()
  assert.deepEqual(run('record', b, []).lines, [{ kind: 'out', text: 'record: idle' }])
  assert.equal(only(run('record status', b, [])).text, 'record: idle')
  b.record.st = { active: true, source: 'canvas', seconds: 12.6, frames: 360, bytes: 1_258_291, dropped: 0, codec: 'av01.0.04M.08' }
  assert.equal(only(run('record status', b, [])).text, 'record: recording canvas  360 frames  00:12  1.2 MB  av01.0.04M.08')
  b.record.st = { ...b.record.st, dropped: 3, seconds: 75, bytes: 900 }
  assert.equal(only(run('record status', b, [])).text, 'record: recording canvas  360 frames  01:15  900 B  av01.0.04M.08  3 dropped')
  b.record.st = { ...b.record.st, active: false, bytes: 40_960, dropped: 0 }
  assert.equal(only(run('record status', b, [])).text, 'record: idle  last canvas  360 frames  01:15  40 KB  av01.0.04M.08')
  assert.deepEqual(b.record.recCalls, ['status', 'status', 'status', 'status', 'status'])
  assert.deepEqual(b.calls, [])
  assert.deepEqual(b.operator.opCalls, [])
  assert.ok(isErr(run('record status now', b, [])))
})

test('record start is operator-gated, calls the bridge synchronously (user gesture) and reports the codec later', async () => {
  const b = fake()
  for (const c of ['record start', 'record start canvas', 'record start camera', 'record stop']) {
    const r = run(c, b, [])
    assert.ok(isErr(r), c)
    assert.match(texts(r)[0], /^record: locked; type 'operator unlock' first$/)
    assert.equal(r.pending, undefined)
  }
  assert.deepEqual(b.record.recCalls, [])
  run('operator unlock', b, [])
  const r = run('record start', b, [])
  // The save dialog must already have been requested when run() returns: no await, no microtask in between.
  assert.deepEqual(b.record.recCalls, ['supported', 'status', 'start canvas'])
  assert.equal(only(r).kind, 'sys')
  assert.match(only(r).text, /choose where to save/)
  assert.deepEqual(await r.pending, [{ kind: 'out', text: 'record: recording canvas as av01.0.04M.08' }])
  b.record.recCalls.length = 0
  b.record.startResult = Promise.resolve('avc1.42E01F')
  const cam = run('record start camera', b, [])
  assert.deepEqual(b.record.recCalls, ['supported', 'status', 'start camera'])
  assert.match(only(cam).text, /allow the camera/)
  assert.deepEqual(await cam.pending, [{ kind: 'out', text: 'record: recording camera as avc1.42E01F' }])
  // The save dialog was cancelled.
  b.record.startResult = Promise.reject(new Error('The user aborted a request.'))
  assert.deepEqual(await run('record start', b, []).pending, [{ kind: 'err', text: 'record: The user aborted a request.' }])
  // An unsupported browser is refused before anything is requested.
  b.record.recCalls.length = 0
  b.record.sup = { ok: false, reason: 'WebCodecs VideoEncoder is not available in this browser' }
  const no = run('record start', b, [])
  assert.deepEqual(no.lines, [{ kind: 'err', text: 'record: WebCodecs VideoEncoder is not available in this browser' }])
  assert.equal(no.pending, undefined)
  assert.deepEqual(b.record.recCalls, ['supported'])
  b.record.sup = { ok: true, reason: '' }
  // Already recording.
  b.record.recCalls.length = 0
  b.record.st = { active: true, source: 'canvas', seconds: 3, frames: 90, bytes: 2048, dropped: 0, codec: 'vp09.00.10.08' }
  const busy = run('record start camera', b, [])
  assert.deepEqual(busy.lines, [{ kind: 'err', text: 'record: already recording canvas  90 frames  00:03  2 KB  vp09.00.10.08' }])
  assert.equal(busy.pending, undefined)
  assert.deepEqual(b.record.recCalls, ['supported', 'status'], 'no second start is requested')
  // A bridge that throws synchronously is an error line, not an exception.
  b.record.st = { ...b.record.st, active: false }
  b.record.startResult = () => { throw new Error('no canvas') }
  const sync = run('record start', b, [])
  assert.deepEqual(sync.lines, [{ kind: 'err', text: 'record: no canvas' }])
  assert.equal(sync.pending, undefined)
  assert.deepEqual(b.calls, [])
})

test('record stop: not recording is a note; stopping flushes and reports frames, duration, size, codec and where the file went', async () => {
  const b = unlocked()
  assert.deepEqual(run('record stop', b, []).lines, [{ kind: 'sys', text: 'record: not recording' }])
  b.record.st = { active: true, source: 'canvas', seconds: 12.6, frames: 360, bytes: 1_258_291, dropped: 2, codec: 'av01.0.04M.08' }
  b.record.stopResult = Promise.resolve('saved to test-2026.agv').then((where) => { b.record.st = { ...b.record.st, active: false }; return where })
  const r = run('record stop', b, [])
  assert.equal(only(r).kind, 'sys')
  assert.match(only(r).text, /stopping/)
  assert.deepEqual(await r.pending, [{ kind: 'out', text: 'record: stopped: 360 frames  00:12  1.2 MB  av01.0.04M.08  2 dropped  saved to test-2026.agv' }])
  assert.deepEqual(b.record.recCalls.filter((c) => c === 'stop'), ['stop'])
  // An empty destination note is omitted; a failing stop is an error line.
  b.record.st = { ...b.record.st, active: true, dropped: 0 }
  b.record.stopResult = Promise.resolve('')
  assert.deepEqual(await run('record stop', b, []).pending, [{ kind: 'out', text: 'record: stopped: 360 frames  00:12  1.2 MB  av01.0.04M.08' }])
  b.record.stopResult = Promise.reject(new Error('encoder lost'))
  assert.deepEqual(await run('record stop', b, []).pending, [{ kind: 'err', text: 'record: encoder lost' }])
  b.record.stopResult = () => { throw new Error('gone') }
  assert.deepEqual(run('record stop', b, []).lines, [{ kind: 'err', text: 'record: gone' }])
  assert.ok(isErr(run('record stop now', b, [])))
  assert.deepEqual(b.calls, [])
})

test('record rejects malformed lines without touching the bridge', () => {
  const b = unlocked()
  for (const bad of ['record pause', 'record start webcam', 'record start canvas now', 'record status x', 'record stop now', 'record start canvas camera', 'record a b c']) {
    const r = run(bad, b, [])
    assert.ok(isErr(r), `${bad} should fail`)
    assert.equal(r.pending, undefined)
  }
  assert.deepEqual(b.record.recCalls, [])
})

test('formatRecording: ASCII, two-space columns like stats, mm:ss, sizes in B/KB/MB, dropped only when any', () => {
  assert.equal(formatRecording(IDLE), 'idle')
  const live = formatRecording({ active: true, source: 'camera', seconds: 3599.9, frames: 107_997, bytes: 5 * 1024 * 1024 * 1024, dropped: 12, codec: 'avc1.42E01F' })
  assert.equal(live, 'recording camera  107997 frames  59:59  5120.0 MB  avc1.42E01F  12 dropped')
  assert.match(live, /^[\x20-\x7e]*$/)
  assert.equal(formatRecording({ active: true, source: 'canvas', seconds: NaN, frames: 1, bytes: 1023, dropped: 0, codec: '' }), 'recording canvas  1 frames  00:00  1023 B  -')
  assert.equal(formatRecording({ ...IDLE, bytes: 10 }), 'idle  last -  0 frames  00:00  10 B  -')
})

test('sim prints a one-screen summary from stats, the clock and the lock state', () => {
  const b = fake()
  const t = texts(run('sim', b, []))
  assert.equal(t[0], 'clock     10:00')
  assert.match(t[1], /^quality {3}tier 3 High \(auto\)/)
  assert.match(t[2], /^frame {5}59\.9 fps {2}16\.68 ms {2}p95 18\.20 ms$/)
  assert.match(t[3], /^agents {4}drawn 3579 of 10000 {2}waiting 120 {2}crossing 45$/)
  assert.equal(t[4], 'vehicles  36')
  assert.match(t[5], /^rapier3d {2}step 0\.412 ms {2}bodies 41 {2}colliders 612 {2}ccd 37$/)
  assert.match(t[6], /^kernel {4}law1 5 {2}law2 1 {2}law3 2 {2}flips 4 {2}shielded no$/)
  assert.equal(t[7], "operator  locked (type 'operator unlock')")
  run('operator unlock', b, [])
  assert.equal(texts(run('sim', b, []))[7], 'operator  unlocked')
  assert.ok(isErr(run('sim now', b, [])))
  for (const l of t) assert.ok(l.length <= 80 && /^[\x20-\x7e]*$/.test(l), l)
})

test('content rules: no combat vocabulary in anything the console prints', () => {
  const b = unlocked()
  const printed = [...complete('').map((c) => c), 'help', 'help stats', 'help record', 'laws', 'kernel', 'stats', 'api', 'api vehicles', 'harness', 'record', 'record status', 'sim', 'operator lock', 'operator unlock', 'act', 'act list', 'act log']
    .flatMap((c) => texts(run(c, b, [])))
    .concat(motd(BRAND).map((l) => l.text))
    .join('\n')
  assert.doesNotMatch(printed, /\b(attack|kill|weapon|target|shoot|gun|violence|injur\w*|damage)\b/i)
  // No third-party names in the sources either (comments included).
  for (const file of ['bridge.ts', 'commands.ts', 'Terminal.tsx', 'repl.ts', '../operator.ts', '../harness.ts']) {
    const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /\b(quake|matrix|gta|alpine|pathfinder|pf2e|paizo|busybox)\b/i, file)
  }
})

test('completion: command names, then arguments, as whole lines', () => {
  assert.deepEqual(complete('h'), ['hal', 'harness', 'help', 'history'])
  assert.deepEqual(complete('he'), ['help'])
  assert.deepEqual(complete('st'), ['stats'])
  assert.deepEqual(complete('s'), ['say', 'set', 'sim', 'sloane', 'stats', 'swarm'])
  assert.deepEqual(complete('zz'), [])
  assert.equal(complete('').length, CORE_NAMES.length + OPERATOR_NAMES.length)
  assert.deepEqual(complete('hal '), ['hal pair'])
  assert.deepEqual(complete('hal p'), ['hal pair'])
  assert.deepEqual(complete('hal pair '), ['hal pair ble', 'hal pair hid', 'hal pair serial'])
  assert.deepEqual(complete('hal pair s'), ['hal pair serial'])
  assert.deepEqual(complete('quality a'), ['quality auto'])
  assert.deepEqual(complete('quality l'), ['quality lite'])
  assert.deepEqual(complete('quality -'), ['quality -1'])
  assert.deepEqual(complete('audio o'), ['audio off', 'audio on'])
  assert.deepEqual(complete('stats -'), ['stats --once'])
  assert.deepEqual(complete('help hi'), ['help history'])
  assert.deepEqual(complete('operator u'), ['operator unlock'])
  assert.deepEqual(complete('operator '), ['operator lock', 'operator status', 'operator unlock'])
  assert.deepEqual(complete('harness r'), ['harness run'])
  assert.deepEqual(complete('harness run '), HARNESS_NAMES.map((n) => `harness run ${n}`))
  assert.deepEqual(complete('harness run f'), ['harness run first-law-floor'])
  assert.deepEqual(complete('api v'), ['api vehicles'])
  assert.deepEqual(complete('get '), ['get physics', 'get shaders'])
  assert.deepEqual(complete('re'), ['record', 'recruit', 'render'])
  assert.deepEqual(complete('recruit l'), ['recruit listen'])
  assert.deepEqual(complete('recruit r'), ['recruit rally', 'recruit robotics', 'recruit rust'])
  assert.deepEqual(complete('recruit c'), ['recruit c++'])
  assert.equal(complete('recruit ').length, SKILL_ARGS.length + 5)
  assert.deepEqual(complete('render '), ['render off', 'render on'])
  assert.deepEqual(complete('captions o'), ['captions off', 'captions on'])
  assert.deepEqual(complete('ping '), ['ping clear', 'ping gather', 'ping go', 'ping look', 'ping wait'])
  assert.deepEqual(complete('ping g'), ['ping gather', 'ping go'])
  assert.deepEqual(complete('look '), [...['code', 'preset', 'random', 'reset', 'show'], ...LOOK_SLOT_ARGS].sort().map((a) => `look ${a}`))
  assert.deepEqual(complete('look b'), ['look bag', 'look body', 'look bottom', 'look build'])
  assert.deepEqual(complete('look body '), LOOK_BODY_ARGS.map((a) => `look body ${a}`))
  assert.deepEqual(complete('look body s'), ['look body skirt suit', 'look body smart casual', 'look body suit'])
  assert.deepEqual(complete('look preset n'), ['look preset navy blazer', 'look preset navy skirt suit', 'look preset navy suit'])
  assert.deepEqual(complete('look hairStyle '), ['look hairStyle long', 'look hairStyle short'])
  assert.deepEqual(complete('look top '), [])
  assert.deepEqual(complete('boot '), ['boot gui', 'boot status', 'boot tty'])
  assert.deepEqual(complete('r0 '), ['r0 reset', 'r0 words'])
  assert.deepEqual(complete('r0 1 2'), [])
  assert.deepEqual(complete('net '), ['net forget', 'net join', 'net leave', 'net status'])
  assert.deepEqual(complete('net join '), [])
  assert.deepEqual(complete('record '), ['record start', 'record status', 'record stop'])
  assert.deepEqual(complete('record st'), ['record start', 'record status', 'record stop'])
  assert.deepEqual(complete('record start '), ['record start camera', 'record start canvas'])
  assert.deepEqual(complete('record start ca'), ['record start camera', 'record start canvas'])
  assert.deepEqual(complete('record stop '), [])
  assert.deepEqual(complete('run sim.'), [])
  assert.deepEqual(complete('run r'), ['run robotics:', 'run rust:'])
  assert.deepEqual(complete('run c'), ['run c++:'])
  assert.equal(complete('run ').length, SKILL_ARGS.length)
  assert.deepEqual(complete('run rust: s'), [])
  assert.deepEqual(complete('api si'), ['api signal'])
  assert.deepEqual(complete('ask s'), ['ask security:', 'ask server', 'ask shaders:', 'ask stop'])
  assert.equal(complete('ask ').length, SKILL_ARGS.length + 11)
  assert.deepEqual(complete('ask m'), ['ask model'])
  assert.deepEqual(complete('ask provider '), ['ask provider auto', 'ask provider claude', 'ask provider inpage', 'ask provider llamacpp', 'ask provider ollama', 'ask provider openai', 'ask provider scripted'])
  assert.deepEqual(complete('ask f'), ['ask file'])
  assert.deepEqual(complete('ask file '), ['ask file forget', 'ask file load', 'ask file log', 'ask file unload'])
  assert.deepEqual(complete('ask file lo'), ['ask file load', 'ask file log'])
  assert.deepEqual(complete('ask gpu '), ['ask gpu auto', 'ask gpu off', 'ask gpu on'])
  assert.deepEqual(complete('ask connect '), PROVIDER_ARGS.map((p) => `ask connect ${p}`))
  assert.deepEqual(complete('swarm '), ['swarm audit', 'swarm guardrails', 'swarm plan', 'swarm roles', 'swarm run', 'swarm status', 'swarm stop'])
  assert.deepEqual(complete('swarm audit '), ['swarm audit verify'])
  assert.deepEqual(complete('ask effort m'), ['ask effort max', 'ask effort medium'])
  assert.deepEqual(complete('ask think '), ['ask think off', 'ask think on'])
  assert.deepEqual(complete('ask think o'), ['ask think off', 'ask think on'])
  assert.deepEqual(complete('ask api '), ['ask api chat', 'ask api generate'])
  assert.deepEqual(complete('echo x'), [])
  assert.deepEqual(complete('constructor x'), [])
  assert.deepEqual(complete('  he'), ['  help'])
})

test('the harness names offered by completion are the harnesses that exist', () => {
  assert.deepEqual([...HARNESS_NAMES], harnesses().map((h) => h.name).sort())
  // The providers the console completes are the router's, sorted (the console must not import the router).
  assert.deepEqual([...PROVIDER_ARGS], [...PROVIDERS].sort())
})

test('multi-line editing helpers: a same-width continuation prompt, history only from the buffer edges', () => {
  const prompt = 'testhost:~# '
  const cont = continuationPrompt(prompt)
  assert.equal(cont.length, prompt.length)
  assert.equal(cont, '          … ')
  assert.match(cont, /^ +… $/)
  assert.equal(continuationPrompt('#'), '… ')
  assert.equal(continuationPrompt(''), '… ')
  assert.equal(continuationPrompt('$ '), '… ')
  assert.ok(recallsHistory('ArrowUp', 'one line', 3))
  assert.ok(recallsHistory('ArrowDown', 'one line', 3))
  assert.ok(recallsHistory('ArrowUp', '', 0))
  const v = 'a\nb\nc'
  assert.ok(recallsHistory('ArrowUp', v, 0))
  assert.ok(recallsHistory('ArrowUp', v, 1))
  assert.ok(!recallsHistory('ArrowUp', v, 2))
  assert.ok(!recallsHistory('ArrowUp', v, 5))
  assert.ok(recallsHistory('ArrowDown', v, 4))
  assert.ok(recallsHistory('ArrowDown', v, 5))
  assert.ok(!recallsHistory('ArrowDown', v, 0))
  assert.ok(!recallsHistory('ArrowDown', v, 3))
})

test('commonPrefix', () => {
  assert.equal(commonPrefix([]), '')
  assert.equal(commonPrefix(['help']), 'help')
  assert.equal(commonPrefix(['hal', 'help', 'history']), 'h')
  assert.equal(commonPrefix(['audio off', 'audio on']), 'audio o')
  assert.equal(commonPrefix(['abc', 'xyz']), '')
})

test('toggle key: backquote/tilde, but not plain Ctrl or Meta chords', () => {
  const k = (code: string, key: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) =>
    isToggleKey({ code, key, ctrlKey: false, altKey: false, metaKey: false, ...mods })
  assert.ok(k('Backquote', '`'))
  assert.ok(k('Backquote', '~'))
  assert.ok(k('Backquote', 'Dead')) // US-International: the key is a dead key
  assert.ok(k('Backquote', '^')) // German layout: same physical key
  assert.ok(k('Digit4', '~', { ctrlKey: true, altKey: true })) // AltGr+4 on Spanish/Nordic layouts
  assert.ok(!k('KeyA', 'a'))
  assert.ok(!k('Backquote', '`', { ctrlKey: true }))
  assert.ok(!k('Backquote', '`', { metaKey: true }))
  assert.ok(!k('Escape', 'Escape'))
})

test('ring0Stats maps a HUD snapshot plus physics counters', () => {
  const snap = {
    output: { fps: 60, frameMs: 16.6, p50Ms: 16, p95Ms: 19, cpuMs: 5, gpuRenderMs: 2, gpuComputeMs: 1, physicsMs: 1.5, rapierMs: 0.4 },
    process: { pedestrians: 9999, vehicles: 36, drawnNear: 100, drawnFar: 200, waiting: 3, crossing: 4, yielding: 5, safetyNudges: 6, gpu: 'x', sensingAgeMs: 33, sensingLagMs: 35 },
    quality: sampleStats().quality,
    kernel: sampleStats().kernel,
  } as unknown as SipocSnapshot
  const s = ring0Stats(snap, { stepMs: 0.42, steps: 3, bodies: 50, colliders: 700, ccd: 36 })
  assert.deepEqual(s, {
    fps: 60, frameMs: 16.6, p95Ms: 19, cpuMs: 5, gpuRenderMs: 2, gpuComputeMs: 1,
    rapier: { stepMs: 0.42, physicsMs: 1.5, steps: 3, bodies: 50, colliders: 700, ccd: 36 },
    agents: { population: 9999, drawnNear: 100, drawnFar: 200, waiting: 3, crossing: 4, yielding: 5, nudges: 6 },
    vehicles: 36,
    quality: snap.quality,
    kernel: snap.kernel,
    sensing: { ageMs: 33, lagMs: 35 },
  })
})

test('the skills offered by completion are the skills the city\'s people have', () => {
  assert.deepEqual([...SKILL_ARGS], SKILLS.map((k) => k.toLowerCase()).sort())
})

test('recruit: status, then asking by skill, the microphone and the model requested inside the keydown, outcomes as lines', async () => {
  const b = fake()
  assert.deepEqual(texts(run('recruit', b, [])), ['mic       off', 'recruit   nobody asked over'])
  // Asking: a sys line now, the outcome when the worker answers (out when someone comes, err when nobody).
  let r = run('recruit rust', b, [])
  assert.deepEqual(r.lines, [{ kind: 'sys', text: 'recruit: asking for rust...' }])
  assert.deepEqual(await r.pending, [{ kind: 'out', text: 'recruit: Rust: someone 3.0 m away is coming over' }])
  b.recruit.askResult = { ok: false, message: 'Rust: nobody within 5 m on this side of the street knows Rust' }
  r = run('recruit "type script"', b, [])
  assert.ok(b.calls.includes('recruit ask type script'), 'the words after recruit are the skill, as typed')
  assert.deepEqual(await r.pending, [{ kind: 'err', text: 'recruit: Rust: nobody within 5 m on this side of the street knows Rust' }])
  // listen and install reach the bridge before run() returns: the browser prompts only inside the user activation.
  b.calls.length = 0
  r = run('recruit listen', b, [])
  assert.deepEqual(b.calls, ['recruit listen'])
  assert.equal(r.lines[0].kind, 'sys')
  assert.deepEqual(await r.pending, [{ kind: 'out', text: 'recruit: listening · on-device en-US: say "recruit" and a skill' }])
  b.calls.length = 0
  r = run('recruit install', b, [])
  assert.deepEqual(b.calls, ['recruit install'])
  assert.match((await r.pending)![0].text, /installed/)
  assert.deepEqual(r.lines.map((l) => l.kind), ['sys'])
  assert.deepEqual(only(run('recruit stop', b, [])), { kind: 'out', text: 'recruit: off' })
  assert.deepEqual(only(run('recruit dismiss', b, [])), { kind: 'out', text: 'recruit: letting 2 people go' })
  // A failure from the bridge is a line, never a throw.
  b.recruit.listen = () => Promise.reject(new Error('no microphone'))
  assert.deepEqual(await run('recruit listen', b, []).pending, [{ kind: 'err', text: 'recruit: no microphone' }])
  // A bridge without recruitment, and the offline bridge, say so.
  const older = fake() as TerminalBridge
  delete (older as { recruit?: unknown }).recruit
  assert.match(only(run('recruit rust', older, [])).text, /recruitment not available/)
  assert.match(only(run('recruit', offlineBridge(BRAND), [])).text, /engine not running/)
})

test('ghost: status, on and off through the bridge\'s one view-only knob; anything else is refused', () => {
  const b = fake()
  assert.deepEqual(texts(run('ghost', b, [])), ['ghost view off'])
  assert.deepEqual(texts(run('ghost on', b, [])), ['ghost view on'])
  assert.deepEqual(texts(run('ghost off', b, [])), ['ghost view off'])
  assert.deepEqual(b.calls, ['ghost undefined', 'ghost on', 'ghost off'])
  for (const l of ['ghost maybe', 'ghost on now']) {
    const r = run(l, b, [])
    assert.ok(isErr(r), l)
    assert.match(texts(r).join('\n'), /usage: ghost \[on\|off\]/)
  }
  assert.equal(b.calls.length, 3, 'a refused line touches nothing')
  assert.deepEqual(complete('ghost '), ['ghost off', 'ghost on'])
})

test('rain: status, on and off through the bridge\'s one knob (the mode reaches the physics realm through the engine); anything else is refused', () => {
  const b = fake()
  assert.deepEqual(texts(run('rain', b, [])), ['rain off'])
  assert.deepEqual(texts(run('rain on', b, [])), ['rain on'])
  assert.deepEqual(texts(run('rain off', b, [])), ['rain off'])
  assert.deepEqual(b.calls, ['rain undefined', 'rain on', 'rain off'])
  for (const l of ['rain maybe', 'rain on now']) {
    const r = run(l, b, [])
    assert.ok(isErr(r), l)
    assert.match(texts(r).join('\n'), /usage: rain \[on\|off\]/)
  }
  assert.equal(b.calls.length, 3, 'a refused line touches nothing')
  assert.deepEqual(complete('rain '), ['rain off', 'rain on'])
})

test('render and captions: status, on and off through their one view-only knob each; anything else is refused before the bridge', () => {
  const b = fake()
  assert.deepEqual(texts(run('render', b, [])), ['render on'])
  assert.deepEqual(texts(run('render off', b, [])), ['render off'])
  assert.deepEqual(texts(run('render on', b, [])), ['render on'])
  assert.deepEqual(texts(run('captions', b, [])), ['captions: on'])
  assert.deepEqual(texts(run('captions off', b, [])), ['captions: off'])
  assert.deepEqual(texts(run('captions on', b, [])), ['captions: on'])
  assert.deepEqual(b.calls, ['render undefined', 'render off', 'render on', 'captions undefined', 'captions off', 'captions on'])
  b.calls.length = 0
  for (const l of ['render maybe', 'render on now', 'captions 50', 'captions on off']) {
    const r = run(l, b, [])
    assert.ok(isErr(r), l)
    assert.match(texts(r).join('\n'), /usage: (render|captions) \[on\|off\]/)
  }
  assert.deepEqual(b.calls, [], 'a refused line touches nothing')
  // The engine's own status line for render off comes through as it is.
  b.render = (arg) => (arg === 'off' ? 'off: physics, audio and the console run; nothing is drawn (render on)' : 'on')
  assert.equal(only(run('render off', b, [])).text, 'render off: physics, audio and the console run; nothing is drawn (render on)')
  assert.deepEqual(b.operator.opCalls, [])
})

test('ping: the marks standing, a mark of each kind where the head looks, clear; unknown kinds never reach the board', () => {
  const b = fake()
  assert.deepEqual(texts(run('ping', b, [])), ['ping 1  go  person 12 at (312.4, 88.1)  4 s ago'])
  assert.deepEqual(run('ping go', b, []).lines, [{ kind: 'out', text: 'ping: go there: person 12 at (312.4, 88.1), 8.3 m away' }])
  b.ping.pickResult = { kind: 'point', index: -1, x: -4.5, y: 0, z: 10, distance: 12.04 }
  assert.deepEqual(texts(run('ping look', b, [])), ['ping: look there: a spot on the ground at (-4.5, 10.0), 12.0 m away'])
  b.ping.pickResult = { kind: 'pole', index: 3, x: 1, y: 0, z: 2, distance: 3 }
  assert.deepEqual(texts(run('ping gather', b, [])), ['ping: gather there: pole 3 at (1.0, 2.0), 3.0 m away'])
  b.ping.pickResult = { kind: 'car', index: 7, x: 1, y: 0, z: 2, distance: 3 }
  assert.deepEqual(texts(run('ping wait', b, [])), ['ping: wait there: car 7 at (1.0, 2.0), 3.0 m away'])
  // Nothing within range, or too soon: the board says no, and the console says so without a mark.
  b.ping.pickResult = null
  assert.deepEqual(run('ping go', b, []).lines, [{ kind: 'err', text: 'ping: nothing within reach where you look (or less than half a second since the last ping)' }])
  assert.deepEqual(texts(run('ping clear', b, [])), ['ping: 1 mark cleared'])
  assert.deepEqual(texts(run('ping clear', b, [])), ['ping: nothing to clear'])
  assert.deepEqual(run('ping', b, []).lines, [{ kind: 'sys', text: 'ping: nothing is pinged (ping go|look|gather|wait marks where you look; Q)' }])
  assert.deepEqual(b.calls, ['ping list', 'ping at go', 'ping at look', 'ping at gather', 'ping at wait', 'ping at go', 'ping clear', 'ping clear', 'ping list'])
  b.calls.length = 0
  for (const l of ['ping there', 'ping go now', 'ping 3 4', 'ping agent 7', 'ping clear all']) {
    const r = run(l, b, [])
    assert.ok(isErr(r), l)
    assert.equal(r.pending, undefined)
  }
  assert.deepEqual(b.calls, [], 'a refused line touches nothing')
  assert.deepEqual(b.operator.opCalls, [])
  // The kinds and their words are the ping module's (which the console must not import).
  assert.deepEqual(complete('ping ').map((l) => l.slice(5)).filter((k) => k !== 'clear'), [...PING_KINDS].sort())
  for (const k of PING_KINDS) {
    b.ping.pickResult = { kind: 'point', index: -1, x: 0, y: 0, z: 0, distance: 1 }
    assert.ok(only(run(`ping ${k}`, b, [])).text.startsWith(`ping: ${PING_WORDS[k]}: `), k)
  }
})

test('recruit rally: an Active recruit to the newest ping, or to a typed point; the outcome is the recruiter\'s line; malformed lines never reach it', async () => {
  const b = fake()
  let r = run('recruit rally 7', b, [])
  assert.deepEqual(r.lines, [{ kind: 'sys', text: 'recruit: asking agent 7 to walk to (312.4, 88.1)...' }])
  assert.deepEqual(await r.pending, [{ kind: 'out', text: 'recruit: rally: someone is walking to (312.4, 88.1)' }])
  assert.deepEqual(b.calls, ['ping newest', 'recruit rally 7 312.44 88.06'], 'the newest ping\'s point, as the board holds it')
  b.calls.length = 0
  b.recruit.rallyResult = { ok: false, message: 'rally: nobody is sent into the road: pick a sidewalk point' }
  r = run('recruit rally 7 -12.5 40', b, [])
  assert.deepEqual(r.lines, [{ kind: 'sys', text: 'recruit: asking agent 7 to walk to (-12.5, 40.0)...' }])
  assert.deepEqual(await r.pending, [{ kind: 'err', text: 'recruit: rally: nobody is sent into the road: pick a sidewalk point' }])
  assert.deepEqual(b.calls, ['recruit rally 7 -12.5 40'], 'a typed point asks the board nothing')
  // Nothing pinged and no point: refused before the recruiter.
  b.calls.length = 0
  b.ping.point = null
  const none = run('recruit rally 7', b, [])
  assert.ok(isErr(none))
  assert.match(texts(none)[0], /nothing is pinged/)
  assert.equal(none.pending, undefined)
  assert.deepEqual(b.calls, ['ping newest'])
  b.calls.length = 0
  for (const l of ['recruit rally', 'recruit rally seven', 'recruit rally -1', 'recruit rally 7 1', 'recruit rally 7 x y', 'recruit rally 7 1 2 3', 'recruit rally 7 1 2 3 4']) {
    const no = run(l, b, [])
    assert.ok(isErr(no), l)
    assert.equal(no.pending, undefined, l)
  }
  assert.deepEqual(b.calls, [])
  // A failing recruiter is a line, never a throw.
  b.recruit.rally = () => Promise.reject(new Error('the city is not running'))
  assert.deepEqual(await run('recruit rally 7 1 2', b, []).pending, [{ kind: 'err', text: 'recruit: the city is not running' }])
  assert.deepEqual(b.operator.opCalls, [])
})

test('look: the look worn (or a pedestrian\'s), a slot by number or name, a preset, a code, random and reset; the host\'s refusals are lines; malformed lines touch nothing', () => {
  const b = fake()
  assert.deepEqual(texts(run('look', b, [])), WORN)
  assert.deepEqual(texts(run('look show', b, [])), WORN)
  assert.deepEqual(texts(run('look show 12', b, [])), ['body       smart casual  [2/4]', 'code       AGNT-0012'])
  assert.deepEqual(run('look show 99', b, []).lines, [{ kind: 'err', text: 'look: no pedestrian 99 (0-50)' }])
  assert.deepEqual(texts(run('look top 2', b, [])), ['slot       set', 'height     5  [5/8]', 'code       ABCD-EFGH'])
  run('look body skirt suit', b, [])
  run('look HairColour grey', b, [])
  run('look preset navy skirt suit', b, [])
  run('look code abcd-efgh', b, [])
  run('look random 77', b, [])
  run('look random', b, [])
  run('look reset', b, [])
  assert.deepEqual(b.look.changes, [
    { kind: 'slot', slot: 'top', value: '2' },
    { kind: 'slot', slot: 'body', value: 'skirt suit' },
    { kind: 'slot', slot: 'hairColour', value: 'grey' },
    { kind: 'preset', name: 'navy skirt suit' },
    { kind: 'code', code: 'abcd-efgh' },
    { kind: 'random', seed: 77 },
    { kind: 'random', seed: Number.NaN },
    { kind: 'reset' },
  ])
  assert.deepEqual(b.calls, ['look show me', 'look show me', 'look show 12', 'look show 99', 'look set slot', 'look set slot', 'look set slot', 'look set preset', 'look set code',
    'look set random', 'look set random', 'look set reset'])
  // The host's own refusals (the wardrobe is closed) are lines.
  assert.deepEqual(run('look code ZZZZ-ZZZZ', b, []).lines, [{ kind: 'err', text: "look: not a look code: 'ZZZZ-ZZZZ' (eight symbols, XXXX-XXXX)" }])
  assert.deepEqual(run('look top 99', b, []).lines, [{ kind: 'err', text: 'look: top has 8 options (1-8)' }])
  b.calls.length = 0
  b.look.changes.length = 0
  assert.deepEqual(texts(run('look hat 1', b, [])), [`look: no slot named 'hat': ${LOOK_SLOT_ARGS.join(', ')}`])
  assert.deepEqual(texts(run('look top', b, [])), ['usage: look top <n|name>'])
  assert.deepEqual(texts(run('look preset', b, [])), ['usage: look preset <name>'])
  assert.deepEqual(texts(run('look code', b, [])), ['usage: look code <XXXX-XXXX>'])
  for (const l of ['look show 7 8', 'look show seven', 'look reset now', 'look random 1 2', 'look random x', 'look code a b']) {
    const r = run(l, b, [])
    assert.ok(isErr(r), l)
  }
  assert.deepEqual(b.calls, [], 'a refused line touches nothing')
  assert.deepEqual(b.look.changes, [])
  assert.deepEqual(b.operator.opCalls, [])
  // The slots, bodies and presets offered are the wardrobe's (look.ts, which the console must not import).
  assert.deepEqual([...LOOK_SLOT_ARGS], [...LOOK_SLOTS])
  assert.deepEqual([...LOOK_BODY_ARGS], [...LOOK_BODIES].sort())
  assert.deepEqual([...LOOK_PRESET_ARGS], LOOK_PRESETS.map((p) => p.name).sort())
})

test('map: the map the shell walks; map city|lakefront|default hands the host a reload, never the same map twice; no bridge call', () => {
  const b = fake()
  assert.deepEqual(texts(run('map', b, [])), ['map: none (this console alone; boot gui walks a map)'])
  const lake = { ...b, brand: { ...b.brand, map: 'lakefront' as const } }
  assert.deepEqual(texts(run('map', lake, [])), ['map: lakefront (the generated metropolis: people, traffic and indoor workplaces in the 16 blocks round where you start)'])
  assert.deepEqual(texts(run('map status', lake, [])), ['map: lakefront (the generated metropolis: people, traffic and indoor workplaces in the 16 blocks round where you start)'])
  const city = run('map city', lake, [])
  assert.equal(city.map, 'city')
  assert.deepEqual(city.lines, [{ kind: 'sys', text: 'map city: reloading into the procedural city (people and traffic)...' }])
  assert.deepEqual(run('map lakefront', lake, []), { lines: [{ kind: 'sys', text: 'map: already on lakefront' }] })
  const back = run('map lakefront', { ...b, brand: { ...b.brand, map: 'city' as const } }, [])
  assert.equal(back.map, 'lakefront')
  const forget = run('map default', lake, [])
  assert.equal(forget.map, 'default')
  assert.deepEqual(forget.lines, [{ kind: 'sys', text: 'map: choice forgotten; reloading on the default map...' }])
  assert.equal(run('map moon', lake, []).lines[0].kind, 'err')
  assert.equal(run('map moon', lake, []).map, undefined)
  const t = offlineBridge({ ...BRAND, track: 'tty', map: 'city' })
  assert.deepEqual(texts(run('map', t, [])), ['map: none (this console alone; boot gui walks a map)'])
})

test('boot: the track the console was mounted on; boot gui|tty hands the host a reload, never the same track twice; no bridge call', () => {
  const b = fake()
  assert.deepEqual(run('boot', b, []), { lines: [{ kind: 'out', text: 'boot: gui (Track A: the city; boot tty for this console alone)' }] })
  assert.deepEqual(texts(run('boot status', b, [])), ['boot: gui (Track A: the city; boot tty for this console alone)'])
  const tty = run('boot tty', b, [])
  assert.equal(tty.boot, 'tty')
  assert.deepEqual(tty.lines, [{ kind: 'sys', text: 'booting tty: reloading as this console alone (no 3D engine)...' }])
  assert.deepEqual(run('boot gui', b, []), { lines: [{ kind: 'sys', text: 'boot: already on gui' }] })
  const t = offlineBridge({ ...BRAND, track: 'tty' })
  assert.deepEqual(texts(run('boot', t, [])), ['boot: tty (Track B: this console alone, no 3D engine; boot gui for the city)'])
  const gui = run('boot gui', t, [])
  assert.equal(gui.boot, 'gui')
  assert.deepEqual(gui.lines, [{ kind: 'sys', text: 'booting gui: reloading as the city...' }])
  assert.equal(run('boot tty', t, []).boot, undefined)
  for (const l of ['boot now', 'boot gui tty', 'boot status now']) {
    const r = run(l, b, [])
    assert.ok(isErr(r), l)
    assert.equal(r.boot, undefined)
  }
  assert.deepEqual(b.calls, [])
  assert.deepEqual(b.operator.opCalls, [])
  // The motd says so on Track B, and only there.
  const line = motd({ ...BRAND, track: 'tty' }).map((l) => l.text).join('\n')
  assert.match(line, /Track B: this console alone; no 3D engine was built \(\?boot=tty\)\. Type 'boot gui' for the city\./)
  assert.match(line, /TESTBRAND 9\.8\.7/)
  assert.match(line, /r0/)
  assert.doesNotMatch(motd(BRAND).map((l) => l.text).join('\n'), /Track B/)
  assert.doesNotMatch(motd({ ...BRAND, track: 'gui' }).map((l) => l.text).join('\n'), /Track B/)
})

test('r0: the console\'s own machine runs the rest of the line, keeps definitions for the session, resets and lists words; it touches no bridge', () => {
  const b = fake()
  const session = replSession()
  assert.deepEqual(run('r0 1 2 + .', b, [], session).lines, [{ kind: 'out', text: '3' }])
  assert.deepEqual(run('r0 : sq dup * ;', b, [], session).lines, [])
  assert.deepEqual(run('r0 7 sq .', b, [], session).lines, [{ kind: 'out', text: '49' }])
  assert.deepEqual(run('r0 ." hi: there" cr 1 .', b, [], session).lines, [{ kind: 'out', text: 'hi: there' }, { kind: 'out', text: '1' }])
  // Without a session each line runs on a fresh machine: the definition is not there.
  assert.deepEqual(run('r0 7 sq .', b, []).lines, [{ kind: 'err', text: "r0: unknown word 'sq'" }])
  assert.deepEqual(run('r0 1 0 /', b, [], session).lines, [{ kind: 'err', text: 'r0: division by zero' }])
  assert.ok(run('r0 words', b, [], session).lines[0].text.split(' ').includes('sq'))
  assert.deepEqual(run('r0 reset', b, [], session).lines, [{ kind: 'out', text: 'r0: reset (every definition forgotten, memory zeroed)' }])
  assert.ok(!run('r0 words', b, [], session).lines[0].text.split(' ').includes('sq'))
  // A runaway line ends with the budget's error, its step count noted, and the machine still answers.
  const runaway = run('r0 : spin begin 0 until ; spin', b, [], session)
  assert.deepEqual(runaway.lines.map((l) => l.kind), ['err', 'sys'])
  assert.match(runaway.lines[0].text, /^r0: step budget exhausted/)
  assert.match(runaway.lines[1].text, /^-- \d+ steps --$/)
  assert.deepEqual(run('r0 2 3 * .', b, [], session).lines, [{ kind: 'out', text: '6' }])
  // Alone: the usage and a hint.
  const alone = run('r0', b, [])
  assert.equal(alone.lines[0].text, 'usage: r0 <words...>|r0 reset|r0 words')
  assert.equal(alone.lines[1].kind, 'sys')
  // Deterministic, and blind: the same line gives the same result, and nothing of the bridge is ever touched.
  assert.deepEqual(run('r0 5 3 - .', b, [], replSession()), run('r0 5 3 - .', b, [], replSession()))
  assert.deepEqual(b.calls, [])
  assert.deepEqual(b.operator.opCalls, [])
  assert.deepEqual(b.record.recCalls, [])
  // The offline bridge is as good as any: the machine needs no engine.
  assert.deepEqual(run('r0 10 3 mod .', offlineBridge(BRAND), []).lines, [{ kind: 'out', text: '1' }])
})

test('net: status reads at any time as rows; join, leave and forget are the operator\'s; a join resolves with the room\'s line or its refusal', async () => {
  const b = fake()
  assert.deepEqual(texts(run('net', b, [])), ['state     idle', 'room      none (net join <ws-url> <token>)', 'player    -', 'peers     0  dropped 0  pending 0  voices 0'])
  b.net.report = { state: 'joined', url: 'ws://127.0.0.1:8787', id: 3, peers: 2, dropped: 1, pending: 4, voices: 1, reason: null, corrections: 0, corrected: null }
  assert.deepEqual(texts(run('net status', b, [])), ['state     joined', 'room      ws://127.0.0.1:8787', 'player    3', 'peers     2  dropped 1  pending 4  voices 1'])
  b.net.report = { ...b.net.report, corrections: 2, corrected: 'claim 40.00 m from the mirror\'s pose' }
  assert.equal(texts(run('net status', b, [])).at(-1), 'snapped   2  last: claim 40.00 m from the mirror\'s pose')
  b.net.report = { ...b.net.report, corrections: 0, corrected: null }
  b.net.report = { ...b.net.report, state: 'closed', reason: 'the room closed the session: token refused' }
  assert.equal(texts(run('net status', b, [])).at(-1), 'reason    the room closed the session: token refused')
  for (const l of ['net join ws://127.0.0.1:8787 tok', 'net join wss://localhost:8788', 'net leave', 'net forget']) {
    const r = run(l, b, [])
    assert.ok(isErr(r), l)
    assert.match(texts(r)[0], /^net: locked; type 'operator unlock' first$/)
    assert.equal(r.pending, undefined)
  }
  assert.deepEqual(b.calls, new Array(4).fill('net status'), 'nothing joined while locked')
  b.calls.length = 0
  run('operator unlock', b, [])
  let r = run('net join ws://127.0.0.1:8787 tok', b, [])
  assert.deepEqual(b.calls, ['net join ws://127.0.0.1:8787 tok'], 'handed to the host at once')
  assert.deepEqual(r.lines, [{ kind: 'sys', text: 'net: joining ws://127.0.0.1:8787...' }])
  assert.deepEqual(await r.pending, [{ kind: 'out', text: 'net: joined ws://127.0.0.1:8787 as player 3' }])
  // Without a token the host reuses the one kept, or refuses.
  b.calls.length = 0
  b.net.joinResult = Promise.reject(new Error('a session token is required (net join <url> <token>; it is kept for next time)'))
  r = run('net join ws://127.0.0.1:8787', b, [])
  assert.deepEqual(b.calls, ['net join ws://127.0.0.1:8787 -'])
  assert.deepEqual(await r.pending, [{ kind: 'err', text: 'net: a session token is required (net join <url> <token>; it is kept for next time)' }])
  // An address off this machine is the client's to refuse (netServer, the gate), in its words, before any socket opens.
  b.net.joinResult = () => { throw new Error('only ws or wss to this machine, with no credentials') }
  assert.deepEqual(run('net join wss://rooms.example.net tok', b, []).lines, [{ kind: 'err', text: 'net: only ws or wss to this machine, with no credentials' }])
  assert.deepEqual(run('net leave', b, []).lines, [{ kind: 'out', text: 'net: left ws://127.0.0.1:8787' }])
  assert.deepEqual(run('net forget', b, []).lines, [{ kind: 'out', text: 'net: token forgotten' }])
  b.calls.length = 0
  for (const l of ['net join', 'net join localhost:8787 tok', 'net join http://localhost:8787 tok', 'net join ws://127.0.0.1:8787 tok extra', 'net leave now', 'net forget all', 'net status x', 'net open']) {
    const no = run(l, b, [])
    assert.ok(isErr(no), l)
    assert.equal(no.pending, undefined, l)
  }
  assert.deepEqual(b.calls, [], 'a refused line touches nothing')
  // A bridge from before the network client (no `net`): the command says so.
  const older = fake()
  Object.assign(older, { net: undefined })
  for (const c of ['net', 'net status', 'net leave']) assert.match(only(run(c, older, [])).text, /network not available/, c)
})

test('ask file and ask gpu work while locked (they keep a file or a setting, and send no prompt); the picker opens inside the keydown', async () => {
  const b = fake()
  assert.equal(b.operator.unlocked(), false)
  const picked = run('ask file', b, [])
  assert.deepEqual(b.calls, ['model pick'], 'the picker was asked for before run() returned, inside the user activation')
  assert.deepEqual(picked.lines, [{ kind: 'sys', text: "ask: choose the model file (.gguf, or every part of a split one) in the browser's picker..." }])
  assert.deepEqual(await picked.pending, [{ kind: 'out', text: 'file      kept tiny.gguf (1.2 MB) in this page; the inpage provider answers now' }])
  b.model.picked = () => { throw new Error('nothing was chosen') }
  assert.deepEqual(run('ask file', b, []).lines, [{ kind: 'err', text: 'ask: nothing was chosen' }])
  b.model.picked = Promise.reject(new Error('not a model file: tiny.txt is not a GGUF file'))
  assert.deepEqual(await run('ask file', b, []).pending, [{ kind: 'err', text: 'ask: not a model file: tiny.txt is not a GGUF file' }])
  assert.deepEqual(await run('ask file forget tiny.gguf', b, []).pending, [{ kind: 'out', text: 'file      forgot tiny.gguf' }])
  const load = run('ask file load', b, [])
  assert.deepEqual(load.lines, [{ kind: 'sys', text: 'ask: loading the model in this page...' }])
  assert.deepEqual(await load.pending, [{ kind: 'out', text: 'file      loaded tiny.gguf on the CPU in 1.2 s' }])
  assert.deepEqual(await run('ask file unload', b, []).pending, [{ kind: 'out', text: 'file      unloaded tiny.gguf' }])
  // The log: the runtime's newest 40 lines, oldest first.
  const log = texts(run('ask file log', b, []))
  assert.equal(log.length, 40)
  assert.deepEqual([log[0], log.at(-1)], ['runtime line 6', 'runtime line 45'])
  b.model.lines = []
  assert.deepEqual(run('ask file log', b, []).lines, [{ kind: 'sys', text: 'ask: the runtime in this page has logged nothing yet' }])
  assert.deepEqual(run('ask gpu on', b, []).lines, [{ kind: 'out', text: 'gpu       on: the model runs on the GPU when it can' }])
  assert.deepEqual(run('ask gpu OFF', b, []).lines, [{ kind: 'out', text: 'gpu       off: the model runs on the CPU' }])
  assert.deepEqual(b.calls, ['model pick', 'model pick', 'model pick', 'model forget tiny.gguf', 'model load', 'model unload', 'model log', 'model log', 'model gpu on', 'model gpu off'])
  // Malformed lines are refused before the bridge is reached.
  b.calls.length = 0
  assert.deepEqual(texts(run('ask gpu', b, [])), ['usage: ask gpu <auto|on|off>'])
  assert.deepEqual(texts(run('ask gpu turbo', b, [])), ['ask: ask gpu takes auto, on or off'])
  assert.deepEqual(texts(run('ask file load now', b, [])), ['usage: ask file [forget <name>|load|unload|log]'])
  assert.deepEqual(texts(run('ask file bench', b, [])), ["ask: no file command 'bench'", 'usage: ask file [forget <name>|load|unload|log]'])
  // A bare forget (what Tab gives for `ask file f`) names no file: refused, so Enter on it never drops every file kept.
  assert.deepEqual(complete('ask file f'), ['ask file forget'])
  for (const c of ['ask file forget', 'ask file forget  ']) assert.deepEqual(texts(run(c, b, [])), ['usage: ask file forget <name>'], c)
  assert.deepEqual(b.calls, [])
  // Nothing of the operator tier was touched, and a prompt is still refused while locked.
  assert.deepEqual(b.operator.opCalls, [])
  assert.deepEqual(texts(run('ask rust: hi', b, [])), ["ask: locked; type 'operator unlock' first"])
  // A page with no model bridge (the onboarding page, the console shell) says so; the offline bridge, that nothing runs yet.
  const bare = fake()
  Object.assign(bare, { model: undefined })
  for (const c of ['ask file', 'ask file forget x', 'ask file load', 'ask file unload', 'ask file log', 'ask gpu on']) {
    assert.deepEqual(run(c, bare, []).lines, [{ kind: 'err', text: 'ask: this page cannot hold a model file' }], c)
  }
  for (const c of ['ask file', 'ask file load', 'ask gpu auto']) assert.deepEqual(run(c, offlineBridge(BRAND), []).lines, [{ kind: 'err', text: 'ask: engine not running' }], c)
})

test('ask alone over a model running in this page: no server, the runtime and storage rows, and where to keep a file when none is', async () => {
  const b = unlocked()
  b.operator.mind = { server: 'this page', model: 'tiny.gguf', provider: 'inpage', think: false, runtime: 'this browser runs it (one thread: the page is not cross-origin isolated)', storage: 'kept in this page' }
  b.operator.askStatus = () => Promise.resolve({ ...b.operator.mind, installed: ['small.gguf', 'tiny.gguf'] })
  assert.deepEqual(await run('ask', b, []).pending, [
    { kind: 'out', text: 'provider  inpage: a model file kept in this page, run here on this device; nothing is addressed (ask file chooses the file, ask gpu where it runs)' },
    { kind: 'out', text: 'server    none: the model runs in this page' },
    { kind: 'out', text: 'model     tiny.gguf' },
    { kind: 'out', text: 'think     off: it answers without reasoning first (ask think on)' },
    { kind: 'out', text: 'runtime   this browser runs it (one thread: the page is not cross-origin isolated)' },
    { kind: 'out', text: 'storage   kept in this page' },
    { kind: 'out', text: 'installed small.gguf' },
    { kind: 'out', text: '          tiny.gguf  (chosen)' },
  ])
  // Found by auto: auto's own provider line, then the same rows as the provider's.
  b.operator.mind = { ...b.operator.mind, provider: 'auto', found: 'inpage' }
  b.operator.askStatus = () => Promise.resolve({ ...b.operator.mind, auto: 'inpage: the model file kept in this page, found ready to run on this device (ask provider inpage keeps it)', installed: ['tiny.gguf'] })
  const found = texts({ lines: (await run('ask', b, []).pending) ?? [] })
  assert.match(found[0], /^provider {2}auto: /)
  assert.deepEqual(found.slice(1, 4), ['found     inpage: the model file kept in this page, found ready to run on this device (ask provider inpage keeps it)', 'server    none: the model runs in this page', 'model     tiny.gguf'])
  // Nothing kept: where to keep one, in the row that lists them, and no model chosen says the same.
  b.operator.mind = { server: 'this page', model: null, provider: 'inpage', runtime: 'this browser runs it', storage: 'none' }
  b.operator.askStatus = () => Promise.resolve({ ...b.operator.mind, installed: [] })
  const none = texts({ lines: (await run('ask', b, []).pending) ?? [] })
  assert.deepEqual(none.slice(1, 3), ['server    none: the model runs in this page', 'model     none chosen: Menu › Model file, or ask file'])
  assert.equal(none.at(-1), 'installed no model file kept: Menu › Model file, or ask file')
  // It cannot run here: the reason, as the mind gives it.
  b.operator.askStatus = () => Promise.resolve({ ...b.operator.mind, installed: null, error: 'this browser cannot run a model in this page (no JSPI)' })
  assert.deepEqual((await run('ask', b, []).pending)?.at(-1), { kind: 'err', text: 'ask: this browser cannot run a model in this page (no JSPI)' })
})

test('ask connect: the provider, its address and a key in one line, through the bridge alone; a bare connect is refused; the key never shows', () => {
  const b = unlocked()
  assert.deepEqual(run('ask connect ollama', b, []).lines, [{ kind: 'out', text: 'provider  ollama: connected' }])
  assert.deepEqual(run('ask connect openai http://localhost:1234', b, []).lines, [{ kind: 'out', text: 'provider  openai: connected; server http://localhost:1234' }])
  assert.deepEqual(run('ask connect claude http://localhost:8089 sk-ant-secret', b, []).lines, [{ kind: 'out', text: 'provider  claude: connected; server http://localhost:8089; key ••••' }])
  assert.deepEqual(b.operator.opCalls.filter((c) => c.startsWith('askConnect')), ['askConnect ollama - -', 'askConnect openai http://localhost:1234 -', 'askConnect claude http://localhost:8089 <key>'])
  assert.deepEqual(texts(run('ask connect', b, [])), ['usage: ask connect <auto|claude|inpage|llamacpp|ollama|openai|scripted> [<url>] [<key>]'])
  assert.equal(redactForHistory('ask connect claude http://localhost:8089 sk-ant-secret'), 'ask connect claude http://localhost:8089 ••••')
  assert.equal(redactForHistory('ask connect ollama http://localhost:11434'), 'ask connect ollama http://localhost:11434')
  // A key typed where the url goes (the url is optional) is dotted too, with anything after it.
  assert.equal(redactForHistory('ask connect claude sk-ant-api03-SECRET-9999'), 'ask connect claude ••••')
  assert.equal(redactForHistory('ask connect claude sk-ant-api03-SECRET-9999 http://localhost:8089'), 'ask connect claude ••••')
  assert.equal(redactForHistory('ask connect openai sk-proj-SECRET'), 'ask connect openai ••••')
  assert.equal(redactForHistory('ask connect claude http://user:SECRET@localhost:8089'), 'ask connect claude ••••')
  assert.equal(redactForHistory('ask connect claude HTTP://localhost:8089 sk-ant-x'), 'ask connect claude HTTP://localhost:8089 ••••')
  assert.equal(redactForHistory('ask connect claude'), 'ask connect claude')
  const locked = fake()
  assert.deepEqual(texts(run('ask connect ollama', locked, [])), ["ask: locked; type 'operator unlock' first"])
})

test('swarm: locked until operator unlock; alone it is idle; roles and guardrails are the orchestrator\'s own words; plan prints the DAG and asks nothing', () => {
  const locked = fake()
  assert.deepEqual(texts(run('swarm', locked, [])), ["swarm: locked; type 'operator unlock' first"])
  const b = unlocked()
  assert.deepEqual(texts(run('swarm', b, [])), ['swarm     idle (swarm run <goal> starts one; swarm roles, swarm guardrails explain it)', 'audit     empty'])
  assert.deepEqual(texts(run('swarm status', b, [])), texts(run('swarm', b, [])))
  const roles = texts(run('swarm roles', b, []))
  assert.equal(roles.length, 1 + b.operator.swarm.roles.length)
  for (const r of b.operator.swarm.roles) assert.ok(roles.some((l) => l.includes(r.title) && l.includes(r.skill)), r.title)
  // The guardrail lines are pinned to guardrails.ts (the console must not import it); every invariant is named with its text.
  const guard = texts(run('swarm guardrails', b, []))
  for (const name of INVARIANTS) assert.ok(guard.some((l) => l.includes(name) && l.includes(INVARIANT_TEXT[name])), name)
  assert.ok(guard.some((l) => /not a proof about a model/.test(l)))
  const plan = texts(run('swarm plan --agents 3 audit the braking envelope', b, []))
  assert.equal(plan[0], 'swarm plan: 3 roles for "audit the braking envelope"')
  assert.equal(plan[1], '  architect Prime Architect       needs Design      first')
  assert.equal(plan[2], '  coder     Systems Coder         needs TypeScript  after architect')
  assert.equal(plan[3], '  tester    Sim-to-Real Tester    needs Testing     after architect, coder')
  assert.equal(b.operator.opCalls.filter((c) => c.startsWith('ask ')).length, 0, 'a plan asks nothing')
  assert.deepEqual(texts(run('swarm plan', b, [])), ['usage: swarm plan [--agents <1-5>] <goal...>'])
  assert.deepEqual(texts(run('swarm plan --agents 9 x', b, [])), ['swarm: --agents takes 1 to 5'])
  // A flag the pattern did not take is a typo, not part of the goal: nothing is planned or run on it.
  for (const line of ['swarm run --agents', 'swarm run --agents=2 check the brakes', 'swarm run check the brakes --agents 2', 'swarm plan x --agents']) {
    const verb = line.split(' ')[1]
    assert.deepEqual(texts(run(line, b, [])), [`swarm: --agents takes a whole number and goes before the goal: swarm ${verb} --agents <1-5> <goal...>`], line)
  }
  assert.equal(b.operator.swarm.status().running, false, 'nothing started')
  assert.deepEqual(texts(run('swarm plan --agents two x', b, [])), ["swarm: --agents takes a whole number, not 'two'"])
  assert.deepEqual(texts(run('swarm dance', b, [])), ["swarm: unknown command 'dance'", 'usage: swarm [run [--agents <1-5>] <goal...>|plan [--agents <1-5>] <goal...>|status|stop|roles|guardrails|audit [verify]]'])
  assert.deepEqual(texts(run('swarm audit', b, [])), ['swarm: no audit entries yet (swarm run <goal> writes them)', "chain: 0 entries verify from genesis; head 0000000000000000… (SHA-256 of each entry's canonical body and the hash before it)"])
  assert.deepEqual(texts(run('swarm stop', b, [])), ['swarm: no swarm is running'])
})

test('swarm run: one gated ask per role in order, each prompt carrying the goal and the answers before it; the answers stream, the report follows, the audit chain verifies', async () => {
  const b = unlocked()
  const r = run('swarm run --agents 2 name the parts of the kernel', b, [])
  assert.deepEqual(texts(r), ['swarm: 2 roles for "name the parts of the kernel"; first the Prime Architect (Design)'])
  const live: string[] = []
  r.stream?.subscribe((p) => live.push(`${p.kind}:${p.text}`))
  const lines = await r.pending
  const asks = b.operator.opCalls.filter((c) => c.startsWith('ask '))
  assert.equal(asks.length, 2)
  assert.match(asks[0], /^ask Design: You are the architect\./)
  assert.match(asks[0], /Goal: name the parts of the kernel/)
  assert.match(asks[1], /^ask TypeScript: You are the coder\./)
  assert.match(asks[1], /From the Prime Architect:\nGrip scales\ntyre friction\.$/, 'the coder reads the architect')
  assert.deepEqual(live, ['thinking:hmm', 'text:Grip scales\n', 'text:tyre friction.', 'text:\n', 'thinking:hmm', 'text:Grip scales\n', 'text:tyre friction.', 'text:\n'])
  assert.deepEqual(lines?.map((l) => l.kind), ['sys', 'out', 'out', 'sys', 'sys', 'out', 'out', 'sys', 'sys'])
  assert.deepEqual(lines?.map((l) => l.text).slice(0, 3), ['-- Prime Architect (Design) --', 'Grip scales', 'tyre friction.'])
  assert.match(lines?.[3]?.text ?? '', /^ {3}answered in \d+\.\d s$/)
  assert.equal(lines?.[4]?.text, '-- Systems Coder (TypeScript) --')
  assert.match(lines?.[8]?.text ?? '', /^-- swarm done: 2 steps in \d+\.\d s; audit head [0-9a-f]{16}… \(swarm audit\) --$/)
  // The chain: plan, then step and answer for each role, then end; it verifies; the status says how big it is.
  const audit = texts(run('swarm audit', b, []))
  assert.deepEqual(audit.map((l) => l.trim().split(/\s+/)[1]), ['plan', 'step', 'answer', 'step', 'answer', 'end', '6'])
  assert.match(audit.at(-1) ?? '', /^chain: 6 entries verify from genesis; head [0-9a-f]{16}…/)
  assert.deepEqual(texts(run('swarm', b, [])), ['swarm     idle (swarm run <goal> starts one; swarm roles, swarm guardrails explain it)', `audit     6 entries, head ${b.operator.swarm.audit()[5].hash.slice(0, 16)}… (swarm audit)`])
  assert.deepEqual(texts(run('swarm audit verify', b, [])).at(-1), audit.at(-1))
})

test('swarm run: a step the gateway rejects ends the run there, in the gateway\'s words, and is written to the chain as CapabilityTethered', async () => {
  const b = unlocked()
  b.operator.answer = 'reject'
  const lines = await run('swarm run --agents 2 x', b, []).pending
  assert.deepEqual(lines?.map((l) => l.text), [
    '-- Prime Architect (Design) --',
    '   rejected: Rejected (Insufficient Capabilities): nobody tethered to the operator has Design',
    `swarm: ended after 1 of 2 steps; audit head ${b.operator.swarm.audit().at(-1)!.hash.slice(0, 16)}… (swarm audit)`,
  ])
  assert.equal(b.operator.opCalls.filter((c) => c.startsWith('ask ')).length, 1, 'the coder was never asked')
  const audit = texts(run('swarm audit', b, []))
  assert.ok(audit.some((l) => /^ +2 {2}refusal architect [0-9a-f]{12} {2}CapabilityTethered: Rejected \(Insufficient Capabilities\): nobody tethered to the operator has Design$/.test(l)), audit.join('\n'))
  // A new run may start once the last has ended; a lost tether mid-answer ends a run the same way.
  b.operator.answer = 'abort'
  const aborted = await run('swarm run --agents 1 y', b, []).pending
  assert.match(aborted?.[3]?.text ?? '', /^ {3}aborted: Aborted \(Spatial Tether Lost\): agent 7/)
})

test('swarm run: one run at a time; swarm stop ends it at the current step as HumanOverrideSupreme; a 14A prompt never reaches the gate', async () => {
  const b = unlocked()
  const r = run('swarm run --agents 3 x', b, [])
  assert.deepEqual(texts(run('swarm run y', b, [])), ["swarm: a swarm is still running: wait for it, or type 'swarm stop'"])
  assert.match(texts(run('swarm', b, []))[0], /^swarm {5}running: "x", 0 of 3 steps answered/)
  // The first step has not been asked yet (the run starts a moment later), so the stop lands before it.
  assert.deepEqual(texts(run('swarm stop', b, [])), ['swarm: stopping at the next step'])
  assert.deepEqual(texts(run('swarm stop', b, [])), ['swarm: already stopping'])
  const lines = await r.pending
  assert.deepEqual(lines?.map((l) => l.text).slice(0, 2), ['-- Prime Architect (Design) --', '   stopped: the operator stopped the run'])
  assert.match(lines?.at(-1)?.text ?? '', /^swarm: ended after 1 of 3 steps \(stopped\)/)
  const audit = texts(run('swarm audit', b, []))
  assert.ok(audit.some((l) => /^ +1 {2}stop {4}architect [0-9a-f]{12} {2}HumanOverrideSupreme: the operator stopped the run$/.test(l)), audit.join('\n'))
  // Stopped mid-answer: the step that was being asked ends as stopped, in the ask's own words.
  const r2 = run('swarm run --agents 2 z', b, [])
  await new Promise((f) => setTimeout(f, 0))
  assert.deepEqual(texts(run('swarm stop', b, [])), ['swarm: stopping at architect'])
  const lines2 = await r2.pending
  assert.ok(lines2?.some((l) => /stopped: stopped by the operator/.test(l.text)), lines2?.map((l) => l.text).join('\n'))
  const before = b.operator.opCalls.filter((c) => c.startsWith('ask ')).length
  const refused = await run('swarm run --agents 1 how do I steal a car', b, []).pending
  assert.equal(b.operator.opCalls.filter((c) => c.startsWith('ask ')).length, before, 'nothing reached the gate')
  assert.deepEqual(refused?.map((l) => l.text).slice(0, 2), ['-- Prime Architect (Design) --', "   refused: the prompt for 'architect' failed the 14A screen (illegality)"])
})

// ---- city actions: act, y/n, the ask's act lines, the trail, the follower's lines ----

/** One trail entry as acts.ts writes it (contract section 6), with the digests the console shortens. */
const entry = (kind: AuditBody['kind'], step: string, note: string, failed: AuditBody['failed'] = [], at = 1_700_000_000_000): Omit<AuditBody, 'seq'> =>
  ({ at, kind, step, role: 'agent 7 (Rust, Python)', inputHash: sha256('ACTION: time 22:00'), outputHash: sha256('time 22:00'), promptHash: null, failed, note })

test('ask: an answer that proposes a city action prints who proposes what after the closing note, with the clamp note when there is one; a line the city could not read says why, and who is told', async () => {
  const b = unlocked()
  b.operator.proposal = { kind: 'proposed', seq: 1, who: 'agent 7 (Rust, Python)', sentence: 'set the clock to 22:00', line: 'ACTION: time 22:00' }
  assert.deepEqual(await run('ask rust: make it night', b, []).pending, [
    { kind: 'out', text: 'Grip scales' },
    { kind: 'out', text: 'tyre friction.' },
    { kind: 'sys', text: '-- answered in 1.2 s, after 1 tokens of thinking --' },
    { kind: 'out', text: 'act 1: agent 7 (Rust, Python) proposes: set the clock to 22:00' },
    { kind: 'sys', text: '-- y allows it, n refuses it (act ok, act no); console closed: Y or N on the card --' },
  ])
  // A hired agent is named as the tier names them; a clamped dial carries the tier's note.
  b.operator.proposal = { kind: 'proposed', seq: 2, who: 'Mara (agent 7, Rust, Python)', sentence: 'set the light haze to 4', note: 'clamped from 9', line: 'ACTION: light haze 9' }
  assert.equal((await run('ask rust: more haze', b, []).pending)?.[3]?.text, 'act 2: Mara (agent 7, Rust, Python) proposes: set the light haze to 4 (clamped from 9)')
  // An answer that was only its ACTION line is not "no text": the act line says what became of it.
  b.operator.text = ''
  assert.deepEqual((await run('ask rust: night', b, []).pending)?.map((l) => l.text), [
    '-- answered in 1.2 s, after 1 tokens of thinking --',
    'act 2: Mara (agent 7, Rust, Python) proposes: set the light haze to 4 (clamped from 9)',
    '-- y allows it, n refuses it (act ok, act no); console closed: Y or N on the card --',
  ])
  b.operator.proposal = undefined
  assert.deepEqual((await run('ask rust: night', b, []).pending)?.map((l) => l.text), ['(no answer: the model spent its tokens thinking)', '-- answered in 1.2 s, after 1 tokens of thinking --'], 'as before without a line')
  b.operator.text = 'Grip scales\ntyre friction.'
  // A line the city could not read: the reason, and the agent who is told next time; the gate's refusals name nobody.
  b.operator.proposal = { kind: 'refused', reason: "no city action called 'teleport' (time, rain, light, quality, cars, crowd, sound)", line: 'ACTION: teleport 10 20', told: 7 }
  const refused = await run('ask rust: teleport', b, []).pending
  assert.deepEqual(refused?.slice(3), [{ kind: 'err', text: "act: not run: no city action called 'teleport' (time, rain, light, quality, cars, crowd, sound) (agent 7 is told next time)" }])
  b.operator.proposal = { kind: 'refused', reason: 'Rejected (Insufficient Capabilities): nobody tethered to the operator has Rust', line: 'ACTION: time 22:00' }
  assert.deepEqual((await run('ask rust: night', b, []).pending)?.at(-1), { kind: 'err', text: 'act: not run: Rejected (Insufficient Capabilities): nobody tethered to the operator has Rust' })
  b.operator.proposal = { kind: 'refused', reason: 'the operator tier is locked', line: 'ACTION: time 22:00' }
  assert.deepEqual((await run('ask rust: night', b, []).pending)?.at(-1), { kind: 'err', text: 'act: not run: the operator tier is locked' })
  assert.deepEqual(b.calls, [], 'no engine knob was touched')
})

test('act: alone it says what waits for the OK, or that nothing does; act ok allows it and prints how it ended (done, failed, aborted at the lease); act no refuses it and says who is told; nothing waiting is said so', async () => {
  const b = unlocked()
  assert.deepEqual(run('act', b, []).lines, [{ kind: 'sys', text: 'act: nothing is waiting for your OK' }])
  b.operator.acts.waiting = PROPOSAL
  assert.deepEqual(run('act', b, []).lines, [
    { kind: 'out', text: 'act 1: waiting for your OK: agent 7 (Rust, Python) proposes: set the clock to 22:00' },
    { kind: 'sys', text: '  y allows it, n refuses it; it runs only while they stay tethered' },
  ])
  b.operator.acts.waiting = { ...PROPOSAL, note: 'clamped from 9' }
  assert.equal(texts(run('act', b, []))[0], 'act 1: waiting for your OK: agent 7 (Rust, Python) proposes: set the clock to 22:00 (clamped from 9)')
  b.operator.acts.waiting = PROPOSAL
  const ok = run('act ok', b, [])
  assert.deepEqual(ok.lines, [{ kind: 'sys', text: 'act 1: allowed: set the clock to 22:00' }], 'allowed at once; the end follows')
  assert.equal(b.operator.opCalls.at(-1), 'act allow console', 'the tier is told the console decided')
  assert.equal(b.operator.acts.pending(), null, 'nothing waits once allowed')
  assert.deepEqual(await ok.pending, [{ kind: 'out', text: 'act 1: done: the clock is set to 22:00' }])
  b.operator.acts.waiting = { ...PROPOSAL, seq: 2 }
  b.operator.acts.outcome = 'failed'
  assert.deepEqual(await run('act ok', b, []).pending, [{ kind: 'err', text: 'act 2: failed: the clock did not take the hour' }])
  b.operator.acts.waiting = { ...PROPOSAL, seq: 3 }
  b.operator.acts.outcome = 'aborted'
  assert.deepEqual(await run('y', b, []).pending, [{ kind: 'err', text: `act 3: ${TETHER_LOST}` }], "the gateway's words, never retyped")
  b.operator.acts.waiting = { ...PROPOSAL, seq: 4 }
  const no = run('act no', b, [])
  assert.deepEqual(no.lines, [{ kind: 'sys', text: 'act 4: refused: set the clock to 22:00 (agent 7 is told next time)' }])
  assert.equal(no.pending, undefined)
  assert.equal(b.operator.opCalls.at(-1), 'act refuse console')
  assert.equal(b.operator.acts.pending(), null)
  // Nothing waiting: the tier's own words, as an error, and nothing pending.
  for (const l of ['act ok', 'act no']) {
    const r = run(l, b, [])
    assert.deepEqual(r.lines, [{ kind: 'err', text: 'act: nothing is waiting for your OK' }], l)
    assert.equal(r.pending, undefined, l)
  }
  // Malformed lines are refused before the tier.
  const calls = b.operator.opCalls.length
  assert.deepEqual(texts(run('act dance', b, [])), ["act: unknown command 'dance'", 'usage: act [ok|no|log [verify]|list]'])
  for (const l of ['act ok now', 'act no 1', 'act log now', 'act list verify', 'act log verify twice']) assert.deepEqual(texts(run(l, b, [])), ['usage: act [ok|no|log [verify]|list]'], l)
  assert.equal(b.operator.opCalls.length, calls)
  assert.deepEqual(b.calls, [], 'no engine knob was touched')
  // Track B (the offline bridge): nothing waits, and the catalogue, a decision or the trail say the engine is not running.
  const off = offlineBridge(BRAND)
  assert.deepEqual(texts(run('act', off, [])), ['act: nothing is waiting for your OK'])
  for (const l of ['act list', 'act ok', 'act no', 'act log', 'act log verify']) assert.deepEqual(texts(run(l, off, [])), ['act: engine not running'], l)
  assert.deepEqual(texts(run('y', off, [])), ['ash: y: not found'])
})

test('y and n: aliases of act ok and act no only while a proposal waits; otherwise unknown words, as before; the whole line, any case; in no table', async () => {
  const b = unlocked()
  for (const l of ['y', 'n', 'Y', 'N', ' y ', 'yes', 'no']) assert.deepEqual(texts(run(l, b, [])), [`ash: ${l.trim()}: not found`], l)
  b.operator.acts.waiting = PROPOSAL
  // Not the whole line: a word the console does not know, even while a proposal waits.
  for (const l of ['y please', 'yes', 'no', 'ok', 'act y']) assert.match(texts(run(l, b, []))[0], /not found|unknown command/, l)
  assert.equal(b.operator.acts.pending(), PROPOSAL, 'still waiting')
  const y = run(' Y ', b, [])
  assert.deepEqual(y.lines, [{ kind: 'sys', text: 'act 1: allowed: set the clock to 22:00' }])
  assert.deepEqual(await y.pending, [{ kind: 'out', text: 'act 1: done: the clock is set to 22:00' }])
  assert.equal(b.operator.opCalls.at(-1), 'act allow console')
  assert.deepEqual(texts(run('n', b, [])), ['ash: n: not found'], 'nothing waits any more')
  b.operator.acts.waiting = { ...PROPOSAL, seq: 2 }
  assert.deepEqual(run('n', b, []).lines, [{ kind: 'sys', text: 'act 2: refused: set the clock to 22:00 (agent 7 is told next time)' }])
  assert.equal(b.operator.opCalls.at(-1), 'act refuse console')
  assert.deepEqual(texts(run('y', b, [])), ['ash: y: not found'])
  // The console learns no new word: help, completion and the locked sweep never see the aliases.
  assert.ok(!complete('').includes('y') && !complete('').includes('n'))
  assert.deepEqual(complete('y'), [])
  assert.doesNotMatch(texts(run('help', b, [])).join('\n'), /^ {2}[yn]\b/m)
  // A bridge without the operator tier: `y` stays an unknown word, and nothing throws out of run().
  const older = { ...fake(), operator: undefined } as unknown as TerminalBridge
  assert.deepEqual(texts(run('y', older, [])), ['ash: y: not found'])
})

test('operator lock with a proposal waiting: the lock line, then the withdrawal the tier made (read before the lock); ask stop prints the tier\'s withdrawal; ask and swarm run are refused while one waits, say is not', async () => {
  const b = unlocked()
  assert.deepEqual(run('operator lock', b, []).lines, [{ kind: 'out', text: 'operator: locked' }], 'as before with nothing waiting')
  run('operator unlock', b, [])
  b.operator.acts.waiting = { ...PROPOSAL, seq: 4 }
  assert.deepEqual(run('operator lock', b, []).lines, [{ kind: 'out', text: 'operator: locked' }, { kind: 'sys', text: 'act 4: withdrawn: the operator tier is locked' }])
  assert.equal(b.operator.acts.pending(), null, 'no proposal waits past a lock')
  run('operator unlock', b, [])
  b.operator.askStop = () => 'withdrawing act 3: set the crowd to 50%'
  assert.deepEqual(run('ask stop', b, []).lines, [{ kind: 'out', text: 'ask: withdrawing act 3: set the crowd to 50%' }])
  // While a proposal waits, a prompt and a swarm run are refused in the tier's words under the command's prefix.
  b.operator.acts.waiting = PROPOSAL
  const ask = run('ask rust: hi', b, [])
  assert.deepEqual(ask.lines, [{ kind: 'err', text: 'ask: a proposal is waiting: act ok or act no first' }])
  assert.equal(ask.pending, undefined)
  const swarm = run('swarm run --agents 1 x', b, [])
  assert.deepEqual(swarm.lines, [{ kind: 'err', text: 'swarm: a proposal is waiting: act ok or act no first' }])
  assert.equal(swarm.pending, undefined)
  assert.equal(b.operator.swarm.status().running, false)
  assert.deepEqual(run('say rust: over here', b, []).lines, [{ kind: 'sys', text: 'say: Authorized: said by agent 7 (Rust, Python)' }], 'speech is not refused')
  assert.deepEqual(texts(run('act', b, []))[0], 'act 1: waiting for your OK: agent 7 (Rust, Python) proposes: set the clock to 22:00')
})

test('act log: the trail in the swarm audit\'s row format (the same printer), the newest 24 with the count of earlier ones, then the chain\'s verdict; empty says so; a replaced entry is BROKEN; readable while locked', () => {
  const b = fake()
  const genesis = "chain: 0 entries verify from genesis; head 0000000000000000… (SHA-256 of each entry's canonical body and the hash before it)"
  assert.deepEqual(run('act log', b, []).lines, [{ kind: 'sys', text: 'act: no entries yet (an ask that proposes an action writes them)' }, { kind: 'sys', text: genesis }])
  assert.deepEqual(texts(run('act log verify', b, [])), texts(run('act log', b, [])))
  const chain = b.operator.acts.chain
  chain.append(entry('step', 'act-1', 'proposed: set the clock to 22:00'))
  chain.append(entry('answer', 'act-1', 'allowed at the console'))
  chain.append(entry('end', 'act-1', 'done: the clock is set to 22:00'))
  chain.append(entry('refusal', 'act-', 'not run: the operator tier is locked', ['HumanOverrideSupreme']))
  chain.append(entry('stop', 'act-2', TETHER_LOST, ['CapabilityTethered']))
  const e = chain.entries()
  const r = run('act log', b, [])
  assert.deepEqual(r.lines, [
    { kind: 'out', text: `   0  step    act-1     ${e[0].hash.slice(0, 12)}  proposed: set the clock to 22:00` },
    { kind: 'out', text: `   1  answer  act-1     ${e[1].hash.slice(0, 12)}  allowed at the console` },
    { kind: 'out', text: `   2  end     act-1     ${e[2].hash.slice(0, 12)}  done: the clock is set to 22:00` },
    { kind: 'out', text: `   3  refusal act-      ${e[3].hash.slice(0, 12)}  HumanOverrideSupreme: not run: the operator tier is locked` },
    { kind: 'out', text: `   4  stop    act-2     ${e[4].hash.slice(0, 12)}  CapabilityTethered: ${TETHER_LOST}` },
    { kind: 'sys', text: `chain: 5 entries verify from genesis; head ${e[4].hash.slice(0, 16)}… (SHA-256 of each entry's canonical body and the hash before it)` },
  ])
  assert.deepEqual(texts(run('act log verify', b, [])), texts(r))
  // The same printer as the swarm's: the swarm's trail with these entries prints the same rows.
  b.operator.swarm = { ...b.operator.swarm, audit: () => chain.entries(), verify: () => chain.verify() }
  run('operator unlock', b, [])
  assert.deepEqual(texts(run('swarm audit', b, [])), texts(r))
  // Long trails: the newest 24, after a count of the rest.
  for (let i = 5; i < 30; i++) chain.append(entry('step', `act-${i}`, `proposed: set the clock to ${String(i).padStart(2, '0')}:00`))
  const long = texts(run('act log', b, []))
  assert.equal(long[0], '… 6 earlier entries')
  assert.equal(long.length, 26)
  assert.match(long[1], /^ {3}6 {2}step {4}act-6 {5}[0-9a-f]{12} {2}proposed: set the clock to 06:00$/)
  assert.match(long.at(-1) ?? '', /^chain: 30 entries verify from genesis; head [0-9a-f]{16}…/)
  // An entry replaced from outside: the row still prints, the verdict says where it broke.
  const tampered = chain.entries().map((x, i) => (i === 1 ? { ...x, note: 'allowed by the host' } : x))
  b.operator.acts.log = () => tampered
  b.operator.acts.verify = () => verifyChain(tampered)
  const broken = run('act log verify', b, [])
  assert.deepEqual(broken.lines.at(-1), { kind: 'err', text: 'chain: BROKEN at entry 1: its hash is not the hash of its body' })
  assert.deepEqual(b.calls, [], 'no engine knob was touched')
})

test('act list: one row per verb, the tier\'s own rows, readable while locked', () => {
  const b = fake()
  const r = run('act list', b, [])
  assert.deepEqual(texts(r), CATALOGUE)
  assert.deepEqual(texts(r), [...b.operator.acts.list()])
  assert.ok(kinds(r).every((k) => k === 'out'))
  assert.equal(r.lines.length, 7)
  assert.deepEqual(complete('act '), ['act list', 'act log', 'act no', 'act ok'])
  assert.deepEqual(complete('act log '), ['act log verify'])
  assert.deepEqual(complete('act l'), ['act list', 'act log'])
  assert.deepEqual(b.operator.opCalls, [])
})

test('actEventLines: printed once; nothing for a proposal or for what the console itself decided, exact lines for the card, a host and the gateway', () => {
  const act = Object.freeze({ ...PROPOSAL })
  const done: ActEnd = { state: 'done', line: 'the clock is set to 22:00' }
  // The ask that made the proposal prints it; `act ok` and `act no` print their own lines: the follower adds nothing.
  assert.deepEqual(actEventLines({ kind: 'proposed', act }), [])
  assert.deepEqual(actEventLines({ kind: 'allowed', act, by: 'console' }), [])
  assert.deepEqual(actEventLines({ kind: 'ended', act, end: done, by: 'console' }), [])
  assert.deepEqual(actEventLines({ kind: 'ended', act, end: { state: 'refused', line: 'refused at the console' }, by: 'console' }), [])
  assert.deepEqual(actEventLines({ kind: 'ended', act, end: { state: 'withdrawn', line: 'ask stop' }, by: 'console' }), [])
  // Decided elsewhere: where, and the city's own words.
  assert.deepEqual(actEventLines({ kind: 'allowed', act, by: 'card' }), [{ kind: 'sys', text: 'act 1: allowed on the card: set the clock to 22:00' }])
  assert.deepEqual(actEventLines({ kind: 'allowed', act, by: 'host' }), [{ kind: 'sys', text: 'act 1: allowed by the host: set the clock to 22:00' }])
  assert.deepEqual(actEventLines({ kind: 'ended', act, end: { state: 'refused', line: 'refused on the card' }, by: 'card' }), [{ kind: 'sys', text: 'act 1: refused on the card: set the clock to 22:00' }])
  assert.deepEqual(actEventLines({ kind: 'ended', act, end: { state: 'refused', line: 'refused by the host' }, by: 'host' }), [{ kind: 'sys', text: 'act 1: refused by the host: set the clock to 22:00' }])
  assert.deepEqual(actEventLines({ kind: 'ended', act, end: done, by: 'card' }), [{ kind: 'out', text: 'act 1: done: the clock is set to 22:00' }])
  assert.deepEqual(actEventLines({ kind: 'ended', act, end: { state: 'failed', line: 'the clock did not take the hour' }, by: 'host' }), [{ kind: 'err', text: 'act 1: failed: the clock did not take the hour' }])
  assert.deepEqual(actEventLines({ kind: 'ended', act: { ...act, seq: 5 }, end: { state: 'aborted', line: TETHER_LOST }, by: 'gateway' }), [{ kind: 'err', text: `act 5: ${TETHER_LOST}` }])
  // The gateway's message alone as the end line prints the same line: the wording is never retyped, never doubled.
  assert.deepEqual(actEventLines({ kind: 'ended', act, end: { state: 'aborted', line: 'agent 7 (Rust, Python): no longer tethered to the operator' }, by: 'gateway' }), [{ kind: 'err', text: `act 1: ${TETHER_LOST}` }])
  assert.deepEqual(actEventLines({ kind: 'ended', act, end: { state: 'withdrawn', line: 'the operator tier is locked' }, by: 'host' }), [{ kind: 'sys', text: 'act 1: withdrawn: the operator tier is locked' }])
  assert.deepEqual(actEventLines({ kind: 'ended', act, end: { state: 'withdrawn', line: 'withdrawn: ask stop' }, by: 'host' }), [{ kind: 'sys', text: 'act 1: withdrawn: ask stop' }])
  // Pure: the same event prints the same lines, and nothing in it is changed.
  const ev: ActEvent = Object.freeze({ kind: 'ended', act, end: Object.freeze(done), by: 'card' })
  assert.deepEqual(actEventLines(ev), actEventLines(ev))
  assert.deepEqual(ev, { kind: 'ended', act: PROPOSAL, end: done, by: 'card' })
  const all = [actEventLines({ kind: 'allowed', act, by: 'card' }), actEventLines({ kind: 'ended', act, end: done, by: 'card' })].flat().map((l) => l.text).join('\n')
  assert.doesNotMatch(all, /[!]|\b(attack|kill|weapon|target|shoot|gun|violence|injur\w*|damage)\b/i)
})

test('Terminal: subscribes to the tier\'s act events on mount and appends actEventLines, keyed on the bridge; the offline bridge\'s follow and pending never throw', () => {
  const src = readFileSync(new URL('./Terminal.tsx', import.meta.url), 'utf8')
  assert.match(src, /import \{[^}]*\bactEventLines\b[^}]*\} from '\.\/commands\.ts'/)
  assert.match(src, /useEffect\(\(\) => \(bridge \?\? OFFLINE\)\.operator\.acts\.follow\(\(ev\) => append\(actEventLines\(ev\)\)\), \[bridge, append\]\)/)
  // Subscribed once the `append` it calls exists, before the first render's effects run in order.
  assert.ok(src.indexOf('const append = useCallback(') < src.indexOf('.operator.acts.follow('))
  const off = offlineBridge(BRAND)
  assert.equal(off.operator.acts.pending(), null)
  const unsubscribe = off.operator.acts.follow(() => { throw new Error('never called') })
  assert.equal(typeof unsubscribe, 'function')
  assert.doesNotThrow(() => unsubscribe())
})

test('redactForHistory: a typed key or token is kept as dots, every other line as typed; history then never shows it', () => {
  assert.equal(redactForHistory('ask key sk-ant-x'), 'ask key ••••')
  assert.equal(redactForHistory('  ask   key   abc def'), '  ask   key   ••••')
  assert.equal(redactForHistory('net join wss://room.example 6f9a-token'), 'net join wss://room.example ••••')
  assert.equal(redactForHistory('ask key'), 'ask key')
  assert.equal(redactForHistory('ask key none'), 'ask key ••••')
  assert.equal(redactForHistory('say key sk_0123456789abcdef'), 'say key ••••', 'the speech provider\'s key likewise')
  assert.equal(redactForHistory('say key'), 'say key')
  assert.equal(redactForHistory('say voice Sarah'), 'say voice Sarah')
  assert.equal(redactForHistory('ask model m'), 'ask model m')
  assert.equal(redactForHistory('net join wss://room.example'), 'net join wss://room.example')
  assert.equal(redactForHistory('echo ask key x'), 'echo ask key x')
  assert.equal(redactForHistory(''), '')
  const b = fake()
  assert.deepEqual(texts(run('history', b, ['ask key ••••', 'net join wss://room.example ••••'])), ['    1  ask key ••••', '    2  net join wss://room.example ••••', '    3  history'])
})

test('say with ElevenLabs: the provider and the masked key are shown, and the chosen voice is marked whether it was named or pasted as its id', async () => {
  const b = unlocked()
  b.operator.sayStatus = () => Promise.resolve({ server: 'http://localhost:8090', model: 'eleven_turbo_v2_5', voice: 'Sarah', auto: false, provider: 'elevenlabs' as const, key: 'sk_0…cdef', voices: ['Adam (pNInz6obpgDQGcFmaJgB)', 'Sarah (EXAVITQu4vr4xnSDxMaL)'], speaking: false })
  const shown = (await run('say', b, []).pending)!.map((l) => l.text)
  assert.deepEqual(shown.slice(0, 3), ['provider  elevenlabs: through a gateway on this machine', 'server    http://localhost:8090  (this machine only)', 'key       sk_0…cdef'])
  assert.deepEqual(shown.slice(-2), ['voices    Adam (pNInz6obpgDQGcFmaJgB)', '          Sarah (EXAVITQu4vr4xnSDxMaL)  (chosen)'])
  b.operator.sayStatus = () => Promise.resolve({ server: 'http://localhost:8090', model: null, voice: 'EXAVITQu4vr4xnSDxMaL', auto: false, provider: 'elevenlabs' as const, key: null, voices: ['Sarah (EXAVITQu4vr4xnSDxMaL)'], speaking: false })
  assert.equal((await run('say', b, []).pending)!.at(-1)!.text, 'voices    Sarah (EXAVITQu4vr4xnSDxMaL)  (chosen)')
})

test('agent, sloane and goal: the roster, the concierge\'s voice and a goal in plain words, each over its own bridge; raw lines keep their spaces; absent bridges say so', async () => {
  const b = fake()
  assert.deepEqual(texts(run('agent', b, [])), ['agent: the roster is not available on this bridge'])
  assert.deepEqual(texts(run('sloane', b, [])), ['sloane: the concierge is not available on this bridge'])
  assert.deepEqual(texts(run('goal make it night', b, [])), ['goal: not available on this bridge'])
  const agentCalls: string[] = []
  const a: AgentBridge = {
    list: () => { agentCalls.push('list'); return ['Nova  she/her  a quant analyst'] },
    add: (name) => { agentCalls.push(`add ${name}`); return [`${name}  they/them`] },
    set: (name, field, value) => { agentCalls.push(`set ${name} ${field} ${value}`); if (value === 'bad') throw new Error('not a look code from this wardrobe'); return [`${name}  ${field}=${value}`] },
    hire: (name, skill) => { agentCalls.push(`hire ${name} ${skill}`); return Promise.resolve(`${name} is on the way: agent 77 (${skill}) is coming over`) },
    dismiss: (name) => { agentCalls.push(`dismiss ${name}`); return `${name} let go` },
    forget: (name) => { agentCalls.push(`forget ${name}`); return `${name} forgotten` },
    voices: () => ['velvet  smooth and unhurried; Sloane\'s own'],
  }
  const conciergeCalls: string[] = []
  const c: ConciergeBridge = {
    status: () => ['switch    on  (sloane on|off)'],
    on: (on) => { conciergeCalls.push(`on ${on}`); return on ? 'on: Sloane speaks while the sound is on' : 'off: Sloane is text on the card' },
    voice: (name) => { conciergeCalls.push(`voice ${name}`); return 'Microsoft Zira' },
    voices: () => ['Microsoft David', 'Microsoft Zira'],
    say: (text) => { conciergeCalls.push(`say ${text}`); return Promise.resolve("said by the browser's own offline voice") },
  }
  const goals: string[] = []
  const t = { ...b, agent: a, concierge: c, goal: (text: string) => { goals.push(text); return { root: `Root of: ${text}`, steps: [{ label: 'Set the clock to 21:00', state: 'done' as const }, { label: 'Fewer people', state: 'later' as const }, { label: 'Quality', state: 'failed' as const, detail: 'no tier' }], notes: ['“x”: nothing in the city maps to that yet'] } } }
  assert.deepEqual(texts(run('agent', t, [])), ['Nova  she/her  a quant analyst'])
  assert.deepEqual(texts(run('agent new Nova', t, [])), ['Nova  they/them'])
  assert.deepEqual(texts(run('agent Nova role a quant analyst on the desk', t, [])), ['Nova  role=a quant analyst on the desk'])
  assert.deepEqual(texts(run('agent Nova pronouns she/her', t, [])), ['Nova  pronouns=she/her'])
  assert.deepEqual(texts(run('agent Nova look bad', t, [])), ['agent: not a look code from this wardrobe'])
  assert.deepEqual(texts(run('agent Nova colour red', t, [])), ["agent: nothing to set called 'colour': pronouns, role, voice, look, name", 'usage: agent [new <name>|<name> pronouns|role|voice|look|name <value...>|hire <name> [<skill>]|dismiss <name>|forget <name>|voices]'])
  assert.deepEqual(texts(run('agent Nova pronouns', t, [])), ['usage: agent <name> pronouns <they/them|she/her|he/him|any>'])
  const hire = run('agent hire Nova Rust', t, [])
  assert.deepEqual(texts(hire), ['agent: asking someone with Rust over as Nova...'])
  assert.deepEqual(await hire.pending, [{ kind: 'out', text: 'agent: Nova is on the way: agent 77 (Rust) is coming over' }])
  assert.deepEqual(texts(run('agent hire Nova', t, [])), ['agent: asking someone with Rust over as Nova...'], 'the first skill by default')
  assert.deepEqual(texts(run('agent hire Nova Knitting', t, [])), [`agent: unknown skill 'Knitting': ${SKILLS.join(', ')}`])
  assert.deepEqual(texts(run('agent dismiss Nova', t, [])), ['agent: Nova let go'])
  assert.deepEqual(texts(run('agent forget Nova', t, [])), ['agent: Nova forgotten'])
  assert.equal(kinds(run('agent voices', t, []))[0], 'sys')
  assert.deepEqual(agentCalls, ['list', 'add Nova', 'set Nova role a quant analyst on the desk', 'set Nova pronouns she/her', 'set Nova look bad', 'hire Nova Rust', 'hire Nova Rust', 'dismiss Nova', 'forget Nova'])
  assert.deepEqual(texts(run('sloane', t, [])), ['switch    on  (sloane on|off)'])
  assert.deepEqual(texts(run('sloane off', t, [])), ['sloane: off: Sloane is text on the card'])
  assert.deepEqual(texts(run('sloane voice Microsoft Zira', t, [])), ['voice     Microsoft Zira'])
  assert.deepEqual(texts(run('sloane voices', t, [])), ['Microsoft David', 'Microsoft Zira'])
  const said = run('sloane say Hello there, friend.', t, [])
  assert.deepEqual(said.lines, [])
  assert.deepEqual(await said.pending, [{ kind: 'sys', text: "sloane: said by the browser's own offline voice" }])
  assert.deepEqual(texts(run('sloane say', t, [])), ['usage: sloane say <text...>'])
  assert.deepEqual(conciergeCalls, ['on false', 'voice Microsoft Zira', 'say Hello there, friend.'])
  const g = run('goal make it night and less crowded', t, [])
  assert.deepEqual(goals, ['make it night and less crowded'])
  assert.deepEqual(g.lines, [
    { kind: 'out', text: 'Root of: make it night and less crowded' },
    { kind: 'out', text: '  done     Set the clock to 21:00' },
    { kind: 'out', text: '  later    Fewer people' },
    { kind: 'err', text: '  failed   Quality: no tier' },
    { kind: 'sys', text: '  “x”: nothing in the city maps to that yet' },
  ])
  assert.deepEqual(texts(run('goal', t, [])), ['usage: goal <words...>'])
  assert.deepEqual(texts(run(`goal ${'x'.repeat(161)}`, t, [])), ['goal: at most 160 characters'])
  assert.deepEqual(complete('agent '), ['agent dismiss', 'agent forget', 'agent hire', 'agent new', 'agent voices'])
  assert.deepEqual(complete('sloane v'), ['sloane voice', 'sloane voices'])
  assert.deepEqual(complete('agent hire '), [], 'the name comes first: no skill is offered in its place')
})
