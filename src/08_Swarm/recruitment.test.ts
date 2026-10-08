// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins recruitment on the page against a fake engine host, a fake recogniser and a
 * manual clock: the main-thread match (the nearest idle person within earshot on this side of the street with the
 * skill becomes Interviewing and the worker is asked, nothing is sent when nobody qualifies), the worker's answer
 * deciding (its own pick, a refusal, silence), the page's position copy, the parser on transcripts, and the
 * microphone: on-device only (a recogniser that cannot promise it is never started), continuous, restarted when a
 * session ends, stopped for good when permission is refused, and the model installed only on command.
 * What breaks if it is removed? A regression could send a voice to a server, summon on every word, or leave the
 * page believing someone is coming who is not.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CITY } from '../01_Initialize_World/city.ts'
import { AUDIBLE_RADIUS, RALLY_RANGE, skillsOf, type Skill } from '../03_Spawn_Agents/skills.ts'
import type { RecruitHost } from '../07_Execute_Actions/engine.ts'
import type { RecruitView, SimCommand, SimEvent, StepState } from '../07_Execute_Actions/simProtocol.ts'
import { hudLine, recruitBridge, Recruiter, SPEECH_LANG, type Clock, type RecruitOutcome, type SpeechEnv } from './recruitment.ts'

const N = 64
/** The operator on a sidewalk mid-block, 5.8 m east of a north-south street. */
const OP = { x: 2 * CITY.pitch + CITY.lane, z: 3 * CITY.pitch + 20 }

class ManualClock implements Clock {
  t = 1000
  readonly timers = new Map<number, { at: number; fn: () => void }>()
  #next = 1
  now(): number { return this.t }
  setTimeout(fn: () => void, ms: number): unknown { const id = this.#next++; this.timers.set(id, { at: this.t + ms, fn }); return id }
  clearTimeout(h: unknown): void { this.timers.delete(h as number) }
  advance(ms: number): void {
    this.t += ms
    for (const [id, x] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) {
      if (x.at <= this.t && this.timers.delete(id)) x.fn()
    }
  }
}

class FakeHost implements RecruitHost {
  readonly agents = N
  operatorAt: { x: number; z: number } | null = { ...OP }
  readonly sent: SimCommand[] = []
  readonly cues: [number, number][] = []
  listeners = new Set<(s: StepState) => void>()
  operator() { return this.operatorAt }
  send(cmd: Extract<SimCommand, { c: 'recruit' | 'dismiss' | 'rally' }>) { this.sent.push(cmd) }
  onState(fn: (s: StepState) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  cue(x: number, z: number) { this.cues.push([x, z]); return true }
  /** Everyone at `xz` (NaN: not placed) in a render frame, with these events and this recruits list. */
  deliver(xz: Map<number, [number, number]>, events: SimEvent[] = [], recruits: RecruitView[] = [], withFrame = true) {
    let frame: Float32Array | null = null
    if (withFrame) {
      frame = new Float32Array(12 * N).fill(NaN)
      for (const [a, [x, z]] of xz) { frame[4 * a] = x; frame[4 * a + 2] = z }
    }
    const s = { crowdFrame: frame, events, recruits } as unknown as StepState
    for (const l of this.listeners) l(s)
  }
}

const withSkill = (k: Skill) => Array.from({ length: N - 1 }, (_, i) => i + 1).filter((a) => skillsOf(a).includes(k))
const view = (agent: number, skill: string, arrived = false): RecruitView => ({
  agent, serial: agent, skill, state: arrived ? 'Active' : 'Interviewing', arrived, skills: [skill, ...skillsOf(agent).filter((x) => x !== skill)],
  distance: 2, x: OP.x, z: OP.z + 2, seconds: 1,
})

function rig() {
  const host = new FakeHost()
  const clock = new ManualClock()
  const r = new Recruiter(host, { Recognition: null, Phrase: null }, clock)
  const seen: { type: string; detail: unknown }[] = []
  for (const type of ['heard', 'recruit', 'refused', 'active', 'released', 'rally', 'mic']) r.addEventListener(type, (e) => seen.push({ type, detail: (e as CustomEvent).detail }))
  return { host, clock, r, seen }
}

test('the page\'s copy of the worker\'s list is replaced before a state\'s events are dispatched; every mirror listener hears it, even past one that throws', () => {
  const { host, r } = rig()
  const heard: string[] = []
  const errors: unknown[] = []
  const error = console.error
  console.error = (e: unknown) => { errors.push(e) }
  try {
    r.onMirror(() => { throw new Error('a broken listener') })
    const off = r.onMirror((list) => heard.push(`mirror ${list.map((x) => x.agent).join(',')}`))
    r.addEventListener('released', () => heard.push(`released, list ${r.recruits.map((x) => x.agent).join(',')}`))
    host.deliver(new Map(), [{ e: 'released', agent: 5, skill: 'Rust', reason: 'dismissed' }], [view(7, 'Go', true)])
    assert.deepEqual(heard, ['mirror 7', 'released, list 7'], 'the listeners first, then the events, which see the new list')
    assert.equal(errors.length, 1, 'the broken listener is reported and the next one still runs')
    // Disposed: one empty list, then nothing more.
    r.dispose()
    assert.equal(heard.at(-1), 'mirror ')
    host.deliver(new Map(), [], [view(7, 'Go', true)])
    assert.equal(heard.at(-1), 'mirror ')
    off()
  } finally {
    console.error = error
  }
})

test('the nearest idle person within earshot, on this side of the street, with the skill, becomes Interviewing and the worker is asked', async () => {
  const { host, clock, r, seen } = rig()
  const [a, b, c] = withSkill('Rust')
  const xz = new Map<number, [number, number]>([
    [a, [OP.x, OP.z + 4]], // 4 m up the sidewalk
    [b, [OP.x, OP.z - 2]], // 2 m: the nearest
    [c, [OP.x - 2 * CITY.lane, OP.z]], // the far kerb
  ])
  host.deliver(xz)
  const p = r.recruit('rust')
  assert.equal(r.stateOf(b), 'Interviewing', 'at once, on the main thread')
  assert.equal(r.stateOf(a), 'Idle')
  assert.deepEqual(host.sent, [{ c: 'recruit', id: 1, skill: 'Rust', agent: b }])
  const matched = seen.find((e) => e.type === 'recruit')!.detail as { agent: number; skill: string; distance: number }
  assert.deepEqual([matched.agent, matched.skill], [b, 'Rust'])
  assert.ok(Math.abs(matched.distance - 2) < 1e-4, 'measured from the operator in the page copy (f32)')
  // The worker confirms: resolved, a cue where they stand, still Interviewing on its list.
  host.deliver(xz, [{ e: 'recruit', id: 1, ok: true, agent: b, skill: 'Rust', distance: 2 }], [view(b, 'Rust')])
  const o = await p
  assert.deepEqual({ ok: o.ok, agent: o.agent, skill: o.skill }, { ok: true, agent: b, skill: 'Rust' })
  assert.match(o.message, /coming over/)
  assert.deepEqual(host.cues, [[Math.fround(OP.x), Math.fround(OP.z - 2)]])
  // The next request skips them (busy) and takes the next nearest.
  clock.advance(300)
  void r.recruit('Rust')
  assert.deepEqual(host.sent.at(-1), { c: 'recruit', id: 2, skill: 'Rust', agent: a })
  // Arrived: Active, tethered, their skills on the HUD; the other one still coming over.
  const bSkills = view(b, 'Rust', true).skills
  host.deliver(xz, [{ e: 'active', agent: b, skill: 'Rust', skills: bSkills }], [view(b, 'Rust', true), view(a, 'Rust')])
  assert.deepEqual(seen.find((e) => e.type === 'active')!.detail, { agent: b, skill: 'Rust', skills: bSkills })
  assert.equal(r.stateOf(b), 'Active')
  assert.equal(r.stateOf(a), 'Interviewing')
  assert.deepEqual(r.swarmSkills, bSkills)
  assert.deepEqual(hudLine(r), { listening: false, line: `Active swarm 1: [${bSkills.join(', ')}] · coming over · Rust` })
  // Both Active: every skill once, in the order they joined.
  host.deliver(xz, [], [view(b, 'Rust', true), view(a, 'Rust', true)])
  const both = [...new Set([...bSkills, ...view(a, 'Rust', true).skills])]
  assert.deepEqual(hudLine(r).line, `Active swarm 2: [${both.join(', ')}]`)
  assert.ok(recruitBridge(r).status().includes(`swarm     ${both.join(", ")}`), "the console lists the swarm's skills")
  // The tether breaks: Idle again, and the HUD drops their skills.
  host.deliver(xz, [{ e: 'released', agent: b, skill: 'Rust', reason: 'the operator walked away' }], [view(a, 'Rust', true)])
  assert.equal(r.stateOf(b), 'Idle')
  assert.equal(r.stateOf(a), 'Active')
  assert.match(r.last, /walked away/)
  assert.deepEqual(hudLine(r).line, `Active swarm 1: [${view(a, 'Rust', true).skills.join(', ')}]`)
})

test('the worker decides: its own pick replaces the page\'s, a refusal or silence leaves everyone Idle', async () => {
  const { host, clock, r } = rig()
  const [a, b] = withSkill('Design')
  const xz = new Map<number, [number, number]>([[a, [OP.x, OP.z + 1]], [b, [OP.x, OP.z + 3]]])
  host.deliver(xz)
  let p: Promise<RecruitOutcome> = r.recruit('design')
  host.deliver(xz, [{ e: 'recruit', id: 1, ok: true, agent: b, skill: 'Design', distance: 3 }], [view(b, 'Design')])
  assert.equal((await p).agent, b)
  assert.equal(r.stateOf(a), 'Idle', 'the page\'s pick no longer qualified on the worker\'s reading')
  assert.equal(r.stateOf(b), 'Interviewing')
  p = r.recruit('design')
  host.deliver(xz, [{ e: 'recruit', id: 2, ok: false, skill: 'Design', reason: 'nobody within 5 m on this side of the street knows Design' }], [view(b, 'Design')])
  assert.equal((await p).ok, false)
  assert.equal(r.stateOf(a), 'Idle')
  // No answer at all: given up after 30 states from the worker (its answer comes one or two states after the request).
  host.deliver(xz, [], [])
  p = r.recruit('design')
  assert.equal(r.stateOf(a), 'Interviewing')
  let settled = false
  void p.then(() => { settled = true })
  for (let k = 0; k < 29; k++) host.deliver(xz, [], [])
  await Promise.resolve()
  assert.equal(settled, false, 'still waiting after 29 states')
  host.deliver(xz, [], [])
  const o = await p
  assert.equal(o.ok, false)
  assert.match(o.message, /did not answer/)
  assert.equal(r.stateOf(a), 'Idle')
  // An answer to a request nobody is waiting for (not one of the page's) changes nothing.
  const before = host.sent.length
  host.deliver(xz, [{ e: 'recruit', id: 77, ok: true, agent: a, skill: 'Design', distance: 1 }], [])
  assert.equal(r.stateOf(a), 'Idle')
  assert.equal(host.sent.length, before)
  void clock
})

test('a request the page gave up on is withdrawn if the worker accepts it later; a hidden page (no states) keeps waiting', async () => {
  const { host, clock, r } = rig()
  const [a] = withSkill('Security')
  const xz = new Map<number, [number, number]>([[a, [OP.x, OP.z + 2]]])
  host.deliver(xz)
  // Hidden: requestAnimationFrame stops, no step is sent, no state comes back. However long that lasts, the request has
  // not been made yet, so the operator is not told it failed.
  const p = r.recruit('security')
  let settled = false
  void p.then(() => { settled = true })
  clock.advance(60_000)
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(r.stateOf(a), 'Interviewing')
  // Given up (the answer was lost), the operator told nobody is coming...
  for (let k = 0; k < 30; k++) host.deliver(xz, [], [])
  assert.equal((await p).ok, false)
  // ...then the worker's acceptance turns up after all: the person is let go at once, never a silent summons.
  host.deliver(xz, [{ e: 'recruit', id: 1, ok: true, agent: a, skill: 'Security', distance: 2 }], [view(a, 'Security')])
  assert.deepEqual(host.sent.at(-1), { c: 'dismiss', agent: a })
  assert.equal(host.cues.length, 0, 'no cue for someone being let go')
  // Only once: a second copy of that answer sends nothing more.
  const n = host.sent.length
  host.deliver(xz, [{ e: 'recruit', id: 1, ok: true, agent: a, skill: 'Security', distance: 2 }], [])
  assert.equal(host.sent.length, n)
})

test('nothing is sent when nobody qualifies: an unknown skill, at the wheel, in the road, before the crowd is seen, nobody in earshot', async () => {
  const { host, clock, r } = rig()
  const [a] = withSkill('Python')
  assert.match((await r.recruit('python')).message, /not been seen/)
  host.deliver(new Map([[a, [OP.x, OP.z + AUDIBLE_RADIUS + 0.2]]]))
  assert.match((await r.recruit('juggling')).message, /unknown skill 'juggling'/)
  assert.match((await r.recruit(42 as unknown as string)).message, /unknown skill/)
  assert.equal((await r.recruit('python')).message, 'Python: nobody within 5 m on this side of the street knows Python')
  host.operatorAt = null
  assert.match((await r.recruit('python')).message, /on foot/)
  host.operatorAt = { x: 2 * CITY.pitch, z: OP.z }
  assert.match((await r.recruit('python')).message, /sidewalk/)
  assert.deepEqual(host.sent, [])
  // The page's copy refreshes at most every 250 ms: a nearer position inside that window is not seen yet.
  host.operatorAt = { ...OP }
  clock.advance(100)
  host.deliver(new Map([[a, [OP.x, OP.z + 1]]]))
  assert.equal((await r.recruit('python')).ok, false)
  clock.advance(200)
  host.deliver(new Map([[a, [OP.x, OP.z + 1]]]))
  void r.recruit('python')
  assert.deepEqual(host.sent, [{ c: 'recruit', id: 1, skill: 'Python', agent: a }])
  // A state without a frame keeps the copy.
  host.deliver(new Map(), [], [], false)
  assert.equal(r.stateOf(a), 'Interviewing')
})

test('rally: the page checks an Active recruit and the point on its own copy, sends the command, and the worker\'s event answers', async () => {
  const { host, r, seen } = rig()
  const [a, b] = withSkill('Rust')
  const xz = new Map<number, [number, number]>([[a, [OP.x, OP.z + 2]], [b, [OP.x, OP.z - 2]]])
  host.deliver(xz, [], [view(a, 'Rust', true), view(b, 'Rust')])
  assert.equal(r.stateOf(a), 'Active')
  assert.equal(r.stateOf(b), 'Interviewing')
  // Still walking over: not sent anywhere; nothing reaches the worker.
  assert.equal((await r.rally(b, OP.x, OP.z + 4)).message, 'rally: only an Active recruit is sent to a rally point')
  assert.deepEqual(host.sent, [])
  // An Active recruit, a sidewalk point 4 m up: sent as is, answered by the event.
  const at = { x: OP.x, z: OP.z + 4 }
  const p = r.rally(a, at.x, at.z)
  assert.deepEqual(host.sent, [{ c: 'rally', agent: a, x: at.x, z: at.z }])
  // A second one for the same person while the first is unanswered waits its turn.
  assert.match((await r.rally(a, at.x, at.z + 1)).message, /not been answered yet/)
  assert.equal(host.sent.length, 1)
  host.deliver(xz, [{ e: 'rally', agent: a, ok: true }], [{ ...view(a, 'Rust', true), rally: at }, view(b, 'Rust')])
  const o = await p
  assert.deepEqual(o, { ok: true, message: `rally: someone is walking to (${at.x.toFixed(1)}, ${at.z.toFixed(1)})` })
  assert.equal(r.last, o.message)
  assert.deepEqual(seen.filter((e) => e.type === 'rally').at(-1)!.detail, { agent: a, x: at.x, z: at.z, ok: true, reason: '' })
  assert.deepEqual(r.recruits.find((v) => v.agent === a)!.rally, at, "the worker's view carries the point while it is in force")
  // The worker refuses on its own reading: the page's answer is its reason.
  const q = r.rally(a, at.x, at.z + 1)
  host.deliver(xz, [{ e: 'rally', agent: a, ok: false, reason: 'no sidewalk from where they stand to the rally point' }], [view(a, 'Rust', true)])
  assert.deepEqual(await q, { ok: false, message: 'rally: no sidewalk from where they stand to the rally point' })
  // An answer for a rally the page never sent changes nothing.
  const sent = host.sent.length
  host.deliver(xz, [{ e: 'rally', agent: b, ok: true }], [view(a, 'Rust', true)])
  assert.equal(host.sent.length, sent)
  // Silence: given up after ANSWER_STATES states, like a request.
  const lost = r.rally(a, at.x, at.z)
  let settled = false
  void lost.then(() => { settled = true })
  for (let k = 0; k < 29; k++) host.deliver(xz, [], [view(a, 'Rust', true)])
  await Promise.resolve()
  assert.equal(settled, false)
  host.deliver(xz, [], [view(a, 'Rust', true)])
  assert.match((await lost).message, /did not answer/)
  // The console surface returns the same outcome; dispose answers a waiting rally.
  const bridge = recruitBridge(r)
  const viaBridge = bridge.rally(a, at.x, at.z)
  assert.deepEqual(host.sent.at(-1), { c: 'rally', agent: a, x: at.x, z: at.z })
  r.dispose()
  assert.deepEqual(await viaBridge, { ok: false, message: 'the city stopped' })
  assert.deepEqual(await r.rally(a, at.x, at.z), { ok: false, message: 'rally: the city is not running' })
})

test('rally: nothing is sent for a road point, a point too far, no sidewalk path, a stranger, at the wheel, a bad number or before the crowd is seen', async () => {
  const { host, clock, r } = rig()
  const [a] = withSkill('Go')
  assert.match((await r.rally(a, OP.x, OP.z + 2)).message, /only an Active recruit/)
  host.deliver(new Map(), [], [view(a, 'Go', true)], false)
  assert.match((await r.rally(a, OP.x, OP.z + 2)).message, /not been seen yet/)
  host.deliver(new Map([[a, [OP.x, OP.z + 2]]]), [], [view(a, 'Go', true)])
  assert.equal((await r.rally(a, 2 * CITY.pitch, OP.z + 2)).message, 'rally: nobody is sent into the road: pick a sidewalk point')
  assert.equal((await r.rally(a, OP.x, OP.z + RALLY_RANGE + 0.1)).message, `rally: the rally point is too far: within ${RALLY_RANGE} m of the operator`)
  const edge = r.rally(a, OP.x, OP.z + RALLY_RANGE)
  assert.deepEqual(host.sent, [{ c: 'rally', agent: a, x: OP.x, z: OP.z + RALLY_RANGE }], 'exactly RALLY_RANGE is in range')
  host.deliver(new Map([[a, [OP.x, OP.z + 2]]]), [{ e: 'rally', agent: a, ok: true }], [view(a, 'Go', true)])
  assert.equal((await edge).ok, true)
  // Across the street as the page's copy has them (refreshed after the copy interval): a point beside the operator has
  // no sidewalk path from there.
  clock.advance(300)
  host.deliver(new Map([[a, [OP.x - 2 * CITY.lane, OP.z]]]), [], [view(a, 'Go', true)])
  assert.match((await r.rally(a, OP.x, OP.z + 2)).message, /no sidewalk from where they stand/)
  // Bad numbers, a stranger, the wheel.
  for (const [agent, x, z] of [[1.5, OP.x, OP.z], [-1, OP.x, OP.z], [0, OP.x, OP.z], [a, NaN, OP.z], [a, OP.x, Infinity], [a, '3' as unknown as number, OP.z]] as const) {
    assert.equal((await r.rally(agent, x, z)).ok, false, `${agent} ${x} ${z}`)
  }
  assert.match((await r.rally(a + 1, OP.x, OP.z + 2)).message, /only an Active recruit/)
  host.operatorAt = null
  assert.match((await r.rally(a, OP.x, OP.z + 2)).message, /on foot/)
  assert.deepEqual(host.sent.map((c) => c.c), ['rally'], 'only the one in-range rally reached the worker')
})

test('transcripts: a request needs a request word and a skill; what was heard is reported either way', () => {
  const { host, r, seen } = rig()
  const [a] = withSkill('Security')
  host.deliver(new Map([[a, [OP.x, OP.z + 2]]]))
  assert.equal(r.hear('security is tight today'), null)
  assert.equal(r.hear('  '), null)
  assert.deepEqual(host.sent, [])
  assert.ok(r.hear('I need someone who knows security') instanceof Promise)
  assert.deepEqual(host.sent, [{ c: 'recruit', id: 1, skill: 'Security', agent: a }])
  assert.deepEqual(seen.filter((e) => e.type === 'heard').map((e) => e.detail), [{ transcript: 'security is tight today' }, { transcript: 'I need someone who knows security' }])
  assert.equal(r.heard, 'I need someone who knows security')
})

// ---------------------------------------------------------------- the microphone

interface FakeRec {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number; processLocally: boolean; phrases?: unknown
  onresult: ((e: unknown) => void) | null; onerror: ((e: unknown) => void) | null; onend: (() => void) | null; onstart: (() => void) | null
  started: number; aborted: number
  start(): void; stop(): void; abort(): void
}

function speech(opts: { local?: boolean; available?: string | null; install?: boolean } = {}) {
  const made: FakeRec[] = []
  const calls: string[] = []
  class Rec implements FakeRec {
    lang = ''; continuous = false; interimResults = true; maxAlternatives = 1; processLocally = false; phrases?: unknown
    onresult: ((e: unknown) => void) | null = null; onerror: ((e: unknown) => void) | null = null; onend: (() => void) | null = null; onstart: (() => void) | null = null
    started = 0; aborted = 0
    constructor() { made.push(this) }
    start() { this.started++ }
    stop() {}
    abort() { this.aborted++ }
    static available?: (o: unknown) => Promise<string>
    static install?: (o: unknown) => Promise<boolean>
  }
  if (opts.local === false) {
    // A recogniser with no on-device switch: the property is simply not there.
    delete (Rec.prototype as { processLocally?: unknown }).processLocally
  } else {
    Object.defineProperty(Rec.prototype, 'processLocally', { get() { return (this as { _pl?: boolean })._pl ?? false }, set(v: boolean) { (this as { _pl?: boolean })._pl = v }, configurable: true })
  }
  if (opts.available !== null) Rec.available = (o) => { calls.push(`available ${JSON.stringify(o)}`); return Promise.resolve(opts.available ?? 'available') }
  Rec.install = (o) => { calls.push(`install ${JSON.stringify(o)}`); return Promise.resolve(opts.install ?? true) }
  class Phrase {
    readonly phrase: string
    readonly boost: number
    constructor(phrase: string, boost: number) { this.phrase = phrase; this.boost = boost }
  }
  const env = { Recognition: Rec, Phrase } as unknown as SpeechEnv
  return { env, made, calls }
}

function micRig(opts: Parameters<typeof speech>[0] = {}) {
  const host = new FakeHost()
  const clock = new ManualClock()
  const sp = speech(opts)
  const r = new Recruiter(host, sp.env, clock)
  return { host, clock, r, ...sp }
}

/** A recognition result event: final results, each with its alternatives. */
const said = (...finals: string[][]) => ({
  resultIndex: 0,
  results: Object.assign(finals.map((alts) => Object.assign(alts.map((transcript) => ({ transcript })), { isFinal: true })), {}),
})

test('the microphone is on-device only: without that promise, or without recognition at all, nothing starts', async () => {
  const none = new Recruiter(new FakeHost(), { Recognition: null, Phrase: null }, new ManualClock())
  assert.equal((await none.listen()).state, 'unavailable')
  const cloud = micRig({ local: false })
  const m = await cloud.r.listen()
  assert.equal(m.state, 'unavailable')
  assert.match(m.detail, /leave the device/)
  assert.equal(cloud.made.length, 0, 'never constructed, never started')
  assert.deepEqual(cloud.calls, [])
})

test('the model must be installed first; install is its own command, for the on-device model of the one language', async () => {
  const { r, made, calls } = micRig({ available: 'downloadable' })
  const m = await r.listen()
  assert.equal(m.state, 'needs-model')
  assert.match(m.detail, /recruit install/)
  assert.equal(made.length, 0)
  const i = await r.install()
  assert.equal(i.state, 'off')
  assert.deepEqual(calls, [`available {"langs":["${SPEECH_LANG}"],"processLocally":true}`, `install {"langs":["${SPEECH_LANG}"],"processLocally":true}`])
  const declined = micRig({ install: false })
  assert.equal((await declined.r.install()).state, 'needs-model')
})

/** Lets the awaited model check inside listen() finish (a few microtasks and a macrotask). */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

/** listen(), then the session opening: resolves with what listen() reported. */
async function open(m: ReturnType<typeof micRig>) {
  const p = m.r.listen()
  await flush()
  m.made.at(-1)!.onstart!()
  return p
}

test('listening: continuous, final results only, on-device, biased to the skill words; a request is heard and asked', async () => {
  const { host, r, made } = micRig()
  const [a] = withSkill('Writing')
  host.deliver(new Map([[a, [OP.x, OP.z - 3]]]))
  const p = r.listen()
  await flush()
  assert.equal(r.mic.state, 'starting', 'waiting for the microphone')
  assert.equal(made.length, 1)
  const rec = made[0]
  assert.deepEqual([rec.lang, rec.continuous, rec.interimResults, rec.processLocally, rec.started], [SPEECH_LANG, true, false, true, 1])
  assert.ok(Array.isArray(rec.phrases) && (rec.phrases as { phrase: string }[]).some((x) => x.phrase === 'rust'))
  rec.onstart!()
  assert.equal((await p).state, 'listening', 'listen() reports the outcome, not the attempt')
  assert.equal(r.mic.state, 'listening')
  assert.deepEqual(hudLine(r).listening, true)
  // The alternative that makes a request wins over a likelier one that does not.
  rec.onresult!(said(['I need a rider', 'I need a writer']))
  assert.deepEqual(host.sent, [{ c: 'recruit', id: 1, skill: 'Writing', agent: a }])
  // Asking again while listening changes nothing.
  assert.equal((await r.listen()).state, 'listening')
  assert.equal(made.length, 1)
})

test('a session that ends restarts; one that keeps ending, or a refused permission, stops for good; stop closes it', async () => {
  const m0 = micRig()
  const { clock, r, made } = m0
  await open(m0)
  made[0].onerror!({ error: 'no-speech' })
  made[0].onend!()
  assert.equal(made.length, 1)
  clock.advance(260)
  assert.equal(made.length, 2, 'restarted')
  made[1].onstart!()
  assert.equal(r.mic.state, 'listening')
  // Ending over and over: given up.
  const state = (): string => r.mic.state // read fresh (assert.equal narrows a property path)
  for (let k = 0; k < 25 && state() !== 'error'; k++) { made.at(-1)!.onend!(); clock.advance(260) }
  assert.equal(r.mic.state, 'error')
  assert.match(r.mic.detail, /keeps stopping/)
  const count = made.length
  clock.advance(5000)
  assert.equal(made.length, count, 'no more restarts')
  // Permission refused: listen() reports it, the HUD line says so, and it is never restarted.
  const b = micRig()
  const pb = b.r.listen()
  await flush()
  b.made[0].onerror!({ error: 'not-allowed' })
  assert.equal((await pb).state, 'blocked')
  b.made[0].onend!()
  b.clock.advance(1000)
  assert.equal(b.r.mic.state, 'blocked')
  assert.equal(b.made.length, 1)
  assert.match(hudLine(b.r).line, /^voice: microphone permission was refused/)
  // A missing model reported by the session itself (no availability check in this browser).
  const c = micRig({ available: null })
  const pc = c.r.listen()
  c.made[0].onerror!({ error: 'language-not-supported' })
  assert.equal((await pc).state, 'needs-model')
  // A browser prompt left open: listen() reports 'starting' after its wait, and the session still opens later.
  const e = micRig()
  const pe = e.r.listen()
  await flush()
  e.clock.advance(8001)
  assert.equal((await pe).state, 'starting')
  e.made[0].onstart!()
  assert.equal(e.r.mic.state, 'listening')
  // stop: aborted, off, and its late events are ignored.
  const d = micRig()
  await open(d)
  assert.equal(d.r.stop().state, 'off')
  assert.equal(d.made[0].aborted, 1)
  d.clock.advance(1000)
  assert.equal(d.made.length, 1)
})

test('install is refused while the microphone is open or opening: the state never hides a live microphone', async () => {
  const m = micRig()
  await open(m)
  const i = await m.r.install()
  assert.equal(i.state, 'listening')
  assert.match(i.detail, /recruit stop/)
  assert.deepEqual([m.r.mic.state, hudLine(m.r).listening], ['listening', true])
  assert.ok(!m.calls.some((c) => c.startsWith('install')), 'nothing downloaded')
  assert.equal(m.made[0].aborted, 0, 'the session is untouched')
  // Opening (the model check or the prompt in progress): refused as well.
  const o = micRig()
  const p = o.r.listen()
  assert.match((await o.r.install()).detail, /recruit stop/)
  await flush()
  o.made[0].onstart!()
  assert.equal((await p).state, 'listening')
  // Stopped: allowed.
  m.r.stop()
  assert.equal((await m.r.install()).state, 'off')
  assert.ok(m.calls.some((c) => c.startsWith('install')))
})

test('never two sessions: a new one aborts the old, whose results are then ignored; phrase biasing is dropped if refused', async () => {
  const m = micRig()
  const [a] = withSkill('Robotics')
  m.host.deliver(new Map([[a, [OP.x, OP.z + 2]]]))
  await open(m)
  // The session ends and restarts: the old recogniser is gone before the new one exists.
  const first = m.made[0]
  first.onerror!({ error: 'phrases-not-supported' })
  first.onend!()
  m.clock.advance(260)
  assert.equal(m.made.length, 2)
  assert.equal(m.made[1].phrases, undefined, 'the restart asks for no biasing the browser refused')
  assert.equal(m.r.mic.state, 'listening', 'restarting, not failed: the indicator stays on across the restart')
  m.made[1].onstart!()
  // A late result from the replaced session asks nobody over.
  first.onresult?.(said(['recruit a robotics engineer']))
  assert.deepEqual(m.host.sent, [])
  m.made[1].onresult!(said(['recruit a robotics engineer']))
  assert.deepEqual(m.host.sent, [{ c: 'recruit', id: 1, skill: 'Robotics', agent: a }])
  // stop, then listen again at once: the first listen's pending model check starts nothing.
  const s = micRig()
  const p1 = s.r.listen()
  s.r.stop()
  const p2 = s.r.listen()
  await flush()
  assert.equal(s.made.length, 1, 'one session, from the second listen')
  s.made[0].onstart!()
  assert.equal((await p2).state, 'listening')
  assert.notEqual((await p1).state, 'error')
})

test('dispose closes the microphone, answers every waiting request, and stops listening to the city', async () => {
  const m = micRig()
  const { host, r, made } = m
  const [a] = withSkill('Data')
  host.deliver(new Map([[a, [OP.x, OP.z + 1]]]))
  await open(m)
  const p = r.recruit('data')
  r.dispose()
  assert.equal(made[0].aborted, 1)
  assert.equal((await p).ok, false)
  assert.equal(host.listeners.size, 0)
  assert.equal(r.stateOf(a), 'Idle')
  assert.equal((await r.recruit('data')).ok, false)
  assert.equal(host.sent.length, 1)
})

test('the console surface: status lines, asking, dismissing', async () => {
  const { host, r } = rig()
  const b = recruitBridge(r)
  assert.ok(Object.isFrozen(b))
  const lines = b.status()
  assert.equal(lines[0], 'mic       off')
  assert.equal(lines[1], 'recruit   nobody asked over')
  assert.match(lines.at(-1)!, /earshot   5 m, this side of the street/)
  assert.equal(b.dismiss(), 'nobody to dismiss')
  const [a] = withSkill('Networking')
  host.deliver(new Map([[a, [OP.x, OP.z + 2]]]))
  const p = b.ask('networking')
  host.deliver(new Map(), [{ e: 'recruit', id: 1, ok: true, agent: a, skill: 'Networking', distance: 2 }], [view(a, 'Networking')])
  assert.deepEqual(await p, { ok: true, message: 'Networking: someone 2.0 m away is coming over' })
  assert.match(b.status()[1], /^recruit   Networking\s+coming over\s+2\.0 m {2}1 s$/)
  host.deliver(new Map(), [], [view(a, 'Networking', true)])
  const brings = view(a, 'Networking', true).skills.join(', ')
  assert.equal(b.status()[1], `recruit   ${'Networking'.padEnd(14)}${'tethered'.padEnd(14)}${'2.0 m'.padStart(7)}  1 s  [${brings}]`)
  assert.equal(b.status()[2], `swarm     ${brings}`)
  assert.equal(b.dismiss(), 'letting 1 person go')
  assert.deepEqual(host.sent.at(-1), { c: 'dismiss' })
})

test('a download the browser reports (not one this page started) never wedges the microphone: listen asks again', async () => {
  let availability = 'downloading'
  const m = micRig()
  const R = m.env.Recognition as unknown as { available: (o: unknown) => Promise<string> }
  R.available = () => Promise.resolve(availability)
  const first = await m.r.listen()
  assert.equal(first.state, 'installing')
  assert.match(first.detail, /still downloading/)
  // Finished downloading: the next listen checks again and opens the microphone.
  availability = 'available'
  const p = m.r.listen()
  await flush()
  assert.equal(m.made.length, 1)
  m.made[0].onstart!()
  assert.equal((await p).state, 'listening')
  // install is not blocked by that state either (only by an install of its own in flight, or an open microphone).
  m.r.stop()
  assert.equal((await m.r.install()).state, 'off')
})

test('a microphone failure leaves the HUD once voice works again', async () => {
  const m = micRig()
  const p = m.r.listen()
  await flush()
  m.made[0].onerror!({ error: 'not-allowed' })
  await p
  assert.match(hudLine(m.r).line, /^voice: microphone permission was refused/)
  // Permission granted on a second try.
  await open(m)
  assert.deepEqual(hudLine(m.r), { listening: true, line: '' })
  // A missing model, then installed: the HUD no longer says it is missing.
  const n = micRig({ available: 'downloadable' })
  await n.r.listen()
  assert.match(hudLine(n.r).line, /not installed/)
  await n.r.install()
  assert.equal(hudLine(n.r).line, '')
  // A recruitment outcome is not cleared by the microphone.
  const k = rig()
  await k.r.recruit('juggling')
  const before = hudLine(k.r).line
  assert.match(before, /unknown skill/)
})
