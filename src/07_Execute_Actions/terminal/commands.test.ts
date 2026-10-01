/**
 * Why does this file exist? It pins the Ring-0 shell's behaviour against a fake bridge: parsing, every
 * command's output and argument validation, the synchronous device-pairing call, completion, the toggle
 * key, the air gap (a failing bridge never throws out of run(); while locked, nothing but the knobs, recruitment and
 * reading the swarm's memory is touched and the operator commands are refused), the recruit command (the microphone
 * and the model download requested inside the keydown, outcomes as lines), `say` and `memory`, the operator tier's
 * commands over a sandboxed fake simulation, the multi-line editing helpers, and the content rules for its text.
 * What breaks if it is removed? A console regression (a wrong tier, a picker opened outside the user
 * gesture, a script run while locked, a crash on a bad line) would only show up in the browser.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { HARNESS_NAMES, SKILL_ARGS, commonPrefix, complete, continuationPrompt, formatRecording, formatStats, isToggleKey, motd, recallsHistory, run, type CommandResult, type Line } from './commands.ts'
import {
  offlineBridge, ring0Stats, type AskResult, type GatedAsk, type GatedRun, type GatedSay, type HalDevice, type MemoryBridge, type OperatorBridge, type Piece,
  type RecordBridge, type RecruitBridge, type Ring0Stats, type SayResult, type TerminalBridge,
} from './bridge.ts'
import { SKILLS } from '../../03_Spawn_Agents/skills.ts'
import { apiDoc, exec, scriptApi, type SimControls } from '../operator.ts'
import { harnesses } from '../harness.ts'
import type { QualityState, RecordingState, SipocSnapshot } from '../../05_Observe_Environment/telemetry.ts'

const BRAND = { name: 'TESTBRAND', version: '9.8.7', host: 'testhost' }

const LAWS = [
  { id: 1, title: 'Protect people', text: 'Law one text.' },
  { id: 2, title: 'Follow instructions', text: 'Law two text.' },
  { id: 3, title: 'Preserve itself', text: 'Law three text.' },
] as const

const CORE_NAMES = ['help', 'stats', 'laws', 'kernel', 'quality', 'time', 'audio', 'ghost', 'hal', 'recruit', 'memory', 'clear', 'history', 'echo', 'uname', 'whoami', 'version', 'exit']
const OPERATOR_NAMES = ['operator', 'run', 'ask', 'say', 'api', 'get', 'set', 'harness', 'record', 'sim']

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
  mind: { server: string; model: string | null; think?: boolean; api?: string; provider?: string; key?: string | null; effort?: string }
  /** How a `say` ends: said, rejected, cut off by the tether, the server failing, the operator's stop. */
  speech: 'ok' | 'reject' | 'abort' | 'fail' | 'stopped'
  /** The ask's answer is said aloud as well (say auto on): how that ends. */
  speakAnswer: SayResult | null
  voice: { server: string; voice: string | null; model: string | null; auto: boolean }
}

/** The tether the fake gateway binds a script to. */
const TETHER = { agent: 7, serial: 1, skills: ['Rust', 'Python'] }

function fakeOperator(): FakeOp {
  const api = scriptApi(tinySim())
  const f: FakeOp = {
    opCalls: [],
    state: { unlocked: false },
    gate: 'open',
    unlock: () => { f.opCalls.push('unlock'); f.state.unlocked = true },
    lock: () => { f.opCalls.push('lock'); f.state.unlocked = false },
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
        const text = 'Grip scales\ntyre friction.'
        if (how === 'abort') resolve({ state: 'Aborted', text, thinking: 1, reason: 'agent 7 (Rust, Python): no longer tethered to the operator', ms: 900 })
        else if (how === 'fail') resolve({ state: 'Authorized', text: '', thinking: 0, error: 'no local model server is answering at http://localhost:11434: start it, or point ask at the right address (ask server <url>)', ms: 5 })
        else if (how === 'thinking') resolve({ state: 'Authorized', text: '', thinking: 24, done: 'length', tokens: 24, ms: 2700 })
        else resolve({ state: 'Authorized', text, thinking: 1, done: how === 'length' ? 'length' : 'stop', tokens: 9, ms: 1234, ...(f.speakAnswer && { speech: Promise.resolve(f.speakAnswer) }) })
      }, 0))
      return { state: 'Authorized', bound: [TETHER], follow: (fn) => { followers.add(fn); return () => { followers.delete(fn) } }, result }
    },
    askStatus: () => {
      f.opCalls.push('askStatus')
      return Promise.resolve({ ...f.mind, installed: ['a-model', 'test-model'] })
    },
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
}

/** Logs to the bridge's shared `calls` (as 'recruit <verb>'), so the air-gap sweep sees every use. */
function fakeRecruit(calls: string[]): FakeRecruit {
  const r: FakeRecruit = {
    askResult: { ok: true, message: 'Rust: someone 3.0 m away is coming over' },
    ask: (skill) => { calls.push(`recruit ask ${skill}`); return Promise.resolve(r.askResult) },
    listen: () => { calls.push('recruit listen'); return Promise.resolve('listening · on-device en-US: say "recruit" and a skill') },
    stop: () => { calls.push('recruit stop'); return 'off' },
    install: () => { calls.push('recruit install'); return Promise.resolve("off · on-device en-US speech model installed: run 'recruit listen'") },
    dismiss: () => { calls.push('recruit dismiss'); return 'letting 2 people go' },
    status: () => { calls.push('recruit status'); return ['mic       off', 'recruit   nobody asked over'] },
    skills: () => SKILLS,
  }
  return r
}

interface Fake extends TerminalBridge {
  calls: string[]
  recruit: FakeRecruit
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
    render: (arg) => { f.calls.push(`render ${arg}`); return arg ?? 'on' },
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
  }
  f.recruit = fakeRecruit(f.calls)
  f.memory = fakeMemory(f.calls)
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
  assert.match(all, /quality \[auto\|0-4\]/)
  assert.match(all, /time \[HH\[:MM\]\]/)
  assert.match(all, /audio \[on\|off\|0-100\]/)
  assert.match(all, /hal \[pair hid\|serial\|ble\]/)
  assert.match(all, /operator \[unlock\|lock\|status\]/)
  assert.match(all, /run <skill>\[,<skill>\.\.\.\]: <js\.\.\.>/)
  assert.match(all, /ask \[<skill>\[,<skill>\.\.\.\]: <prompt\.\.\.>\|provider <name>\|model <name>\|server <url>\|key <key>\|effort <level>\|think on\|off\|api <format>\|stop\]/)
  assert.match(all, /harness \[list\|run <name>\]/)
  assert.match(all, /record \[start \[canvas\|camera\]\|stop\|status\]/)
  assert.match(all, /recruit \[<skill>\|listen\|stop\|install\|dismiss\]/)
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
  assert.deepEqual(b.calls, ['quality undefined', 'quality 2', 'quality auto', 'quality 0', 'quality 4'])
  b.calls.length = 0
  for (const bad of ['5', '-1', '1.5', '02', 'max', '3 4', '']) {
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
  const everything = ['help', 'stats', 'laws', 'kernel', 'quality', 'time', 'audio', 'hal', 'version', 'uname -a', 'api', 'harness', 'record', 'sim', 'operator']
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
    'operator', 'operator unlock', 'operator lock', 'run 1 + 1', 'run rust: 1 + 1', 'ask', 'ask rust: hi', 'ask model m', 'ask stop', 'say', 'say rust: hi',
    'say voice v', 'say stop', 'memory', 'memory 7', 'memory forget 7', 'api', 'api clock', 'get', 'set physics.car.power 1', 'harness', 'harness list', 'harness run sanctuary', 'sim',
    'record', 'record status', 'record start', 'record start camera', 'record stop']) {
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
  const thrower = fake()
  thrower.stats = () => { throw new TypeError('boom') }
  assert.deepEqual(run('stats', thrower, []).lines, [{ kind: 'err', text: 'stats: boom' }])
  // A bridge from before the operator tier (no `operator`): the operator commands say so.
  const old = fake()
  Object.assign(old, { operator: undefined })
  for (const c of ['operator', 'run 1', 'ask', 'ask rust: hi', 'say', 'say rust: hi', 'memory forget 7', 'api', 'get', 'set physics.x 1', 'harness']) {
    assert.match(only(run(c, old, [])).text, /operator tier not available/, c)
  }
  // A bridge from before the swarm's memory (no `memory`): the memory command says so.
  const forgetful = fake()
  Object.assign(forgetful, { memory: undefined })
  for (const c of ['memory', 'memory 7', 'memory forget all']) assert.match(only(run(c, forgetful, [])).text, /memory not available/, c)
  assert.match(texts(run('sim', old, [])).at(-1) ?? '', /^operator {2}locked/)
  // A bridge from before the recorder (no `record`): likewise.
  const older = fake()
  Object.assign(older, { record: undefined })
  for (const c of ['record', 'record status', 'record start', 'record stop']) {
    assert.match(only(run(c, older, [])).text, /recorder not available/, c)
  }
})

test('air gap: while locked, across every command and completion, the only knobs touched are clock, quality, audio, ghost view, pairing and recruitment', () => {
  const b = fake()
  const lines = complete('').flatMap((c) => [c, ...complete(`${c} `), ...complete(`${c} `).flatMap((a) => complete(`${a} `))])
  // `operator unlock` is the one line that changes the lock state; every other line runs against the locked tier.
  assert.ok(lines.includes('operator unlock'))
  const sweep = [...lines.filter((l) => l !== 'operator unlock'), 'time 8', 'time 08:15', 'run 1 + 1', 'run rust: 1 + 1', 'get physics', 'set physics.car.power 2', 'harness run kernel-stop']
  for (const l of sweep) void run(l, b, ['help'])
  const touched = new Set(b.calls.map((c) => c.split(' ')[0]))
  assert.deepEqual([...touched].sort(), ['audio', 'ghost', 'memory', 'pair', 'quality', 'recruit', 'setClock', 'stats'])
  // The swarm's memory is only ever read while locked: nobody's ledger is erased.
  const reads = new Set(b.calls.filter((c) => c.startsWith('memory ')).map((c) => c.split(' ')[1]))
  assert.deepEqual([...reads].sort(), ['status'])
  // Recruitment only ever asks (the physics worker decides), and only through its own surface.
  const verbs = new Set(b.calls.filter((c) => c.startsWith('recruit ')).map((c) => c.split(' ')[1]))
  assert.deepEqual([...verbs].sort(), ['ask', 'dismiss', 'install', 'listen', 'status', 'stop'])
  // The operator surface saw at most `lock` (harmless); no script ran, no harness started.
  assert.deepEqual(b.operator.opCalls.filter((c) => c !== 'lock'), [])
  // The recorder was only ever read: no recording started or stopped, no picker requested.
  assert.ok(b.record.recCalls.length > 0 && b.record.recCalls.every((c) => c === 'status'), JSON.stringify(b.record.recCalls))
  for (const l of ['run 1 + 1', 'run sim.clock.set(3)', 'run rust: sim.clock.set(3)', 'run rust, go: 1', 'ask', 'ask rust: hi', 'ask model m', 'ask server http://localhost:1', 'ask stop',
    'say', 'say rust: over here', 'say voice v', 'say model m', 'say server http://localhost:1', 'say auto on', 'say stop', 'memory forget 7', 'memory forget all',
    'get', 'get physics', 'set physics.car.power 2', 'harness run kernel-stop', 'harness run sanctuary', 'record start', 'record start camera', 'record stop']) {
    const r = run(l, b, [])
    assert.ok(isErr(r), `${l} should be refused while locked`)
    assert.match(texts(r)[0], /^\w+: locked; type 'operator unlock' first$/)
    assert.equal(r.pending, undefined)
  }
  // Documentation is readable while locked.
  assert.ok(texts(run('api', b, [])).length > 10)
  assert.ok(texts(run('harness list', b, [])).length === harnesses().length + 1)
  assert.deepEqual(b.operator.opCalls.filter((c) => c !== 'lock'), [])
})

test('air gap: the terminal files reach nothing at runtime beyond React, the brand and each other', () => {
  const allowedTypes = ['../../02_Define_The_Rules/laws.ts', '../../04_Connect_Hardware/hal.ts', '../../05_Observe_Environment/telemetry.ts', '../../05_Observe_Environment/recorder.ts', '../operator.ts', '../harness.ts']
  const allowedRuntime = ['react', '../../brand.ts', './bridge.ts', './commands.ts']
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
    assert.deepEqual(texts(no), ['ask: name the skill the answer needs first, e.g. ask rust: how does car.grip work?', 'usage: ask [<skill>[,<skill>...]: <prompt...>|provider <name>|model <name>|server <url>|key <key>|effort <level>|think on|off|api <format>|stop]'], line)
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
      'usage: say [<skill>[,<skill>...]: <text...>|voice <name>|model <name>|server <url>|auto on|off|stop]',
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
  const printed = [...complete('').map((c) => c), 'help', 'help stats', 'help record', 'laws', 'kernel', 'stats', 'api', 'api vehicles', 'harness', 'record', 'record status', 'sim', 'operator lock', 'operator unlock']
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
  assert.deepEqual(complete('s'), ['say', 'set', 'sim', 'stats'])
  assert.deepEqual(complete('zz'), [])
  assert.equal(complete('').length, CORE_NAMES.length + OPERATOR_NAMES.length)
  assert.deepEqual(complete('hal '), ['hal pair'])
  assert.deepEqual(complete('hal p'), ['hal pair'])
  assert.deepEqual(complete('hal pair '), ['hal pair ble', 'hal pair hid', 'hal pair serial'])
  assert.deepEqual(complete('hal pair s'), ['hal pair serial'])
  assert.deepEqual(complete('quality a'), ['quality auto'])
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
  assert.deepEqual(complete('re'), ['record', 'recruit'])
  assert.deepEqual(complete('recruit l'), ['recruit listen'])
  assert.deepEqual(complete('recruit r'), ['recruit robotics', 'recruit rust'])
  assert.deepEqual(complete('recruit c'), ['recruit c++'])
  assert.equal(complete('recruit ').length, SKILL_ARGS.length + 4)
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
  assert.equal(complete('ask ').length, SKILL_ARGS.length + 8)
  assert.deepEqual(complete('ask m'), ['ask model'])
  assert.deepEqual(complete('ask provider '), ['ask provider claude', 'ask provider llamacpp', 'ask provider ollama'])
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
