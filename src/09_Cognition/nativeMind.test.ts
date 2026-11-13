// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the model the app runs itself as the page asks it (nativeMind.ts),
 * over a fake shell that speaks exactly the words native/llm/tests/wire.json holds (the runner's own test writes that
 * file from its types, so a renamed field fails one side or the other): what the app carries in every status, the
 * request, every event, ending and error.
 * - what it lists without asking for an answer: nothing with no runner, no model, or a shell without the command; the
 *   file it carries in every status but failed; a failed one named with its reason, under the runner's own code, the
 *   card told it, the model's file name taken out of both (it stays on ask's model row);
 * - an answer in a shell without the runner's commands, or in an app that carries no model: none, said before any
 *   channel is made;
 * - the request: exactly the fields the runner takes, the same two messages and system prompt every provider sends
 *   (the talk prompt for a conversation), the answer's cap, a fresh 32-bit id; the answer's hash and its ending;
 * - every event in wire.json to its phase line or its piece of text, and every ending and error as the router reads it
 *   (a full context is a cut answer, as the token cap is); nothing the runner sends after the answer settled;
 * - a Stop settling at once with the asker's own reason and stopping the runner by that id; a runner that goes quiet
 *   past the waits ending as 'timeout' and stopped, but never while it waits its turn (the file's check reported to
 *   it meanwhile included), and again once its turn has begun; a piece the asker refuses stopping it too;
 * - two answers at once: the city held until the last ends, the waiting line kept the queued answer's;
 * - a runner whose model would not load after a look found it, or that refuses this device when chosen with no look:
 *   failed for good, said as there being none with its reason, the card told, and every look and answer after it
 *   passing it over; a per-request failure while it stands loaded stays that answer's;
 * - whether the app's model is cold (still to be loaded) as last heard; never with no model.
 * What breaks if it is removed? The page could drift from the runner's words, keep waiting on a runner that went
 * quiet, leave it working after a Stop, or keep asking a runner that failed for good, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { AnswerRequest, Piece } from '../07_Execute_Actions/operator.ts'
import { WAITING } from './inPage.ts'
import { ANSWER_TOKENS, CognitionError, FIRST_PIECE_MS, promptHash, STALL_MS, systemFor, TALK_PROMPT } from './localCompute.ts'
import { ASK_MS, createNativeMind, LOADING_APP, NATIVE_MODEL, NATIVE_SERVER, NO_RUNNER, type GenRequest, type NativeHost } from './nativeMind.ts'

type Status = { state: string; [k: string]: unknown }
/** The runner's words, one of each, as native/llm/tests/wire.rs writes them. */
const WIRE = JSON.parse(readFileSync(new URL('../../native/llm/tests/wire.json', import.meta.url), 'utf8')) as {
  request: GenRequest
  events: { kind: string; [k: string]: unknown }[]
  done: { reason: string; tokens: number; [k: string]: unknown }[]
  errors: { code: string; message: string }[]
  statuses: Status[]
  models: { file: string; bytes: number; status: Status }[]
}

/** What `native_model` answers with the runner in `state`, exactly as wire.json holds it. */
const carrying = (state: string): { file: string; bytes: number; status: Status } => {
  const m = WIRE.models.find((x) => x.status.state === state)
  assert.ok(m, state)
  return m
}
/** The same, with its status changed to `status` (a case wire.json holds one of). */
const carried = (status: Status) => ({ ...carrying(status.state), status })
const FILE = WIRE.models[0].file

/**
 * A shell whose runner carries `model` (null: none) and answers each request with `script` (by default: wire.json's
 * text event, then its first ending). Notes every request and every stop.
 */
function shell(model: unknown, script?: (req: GenRequest, send: (e: unknown) => void) => Promise<unknown>) {
  const sent: GenRequest[] = []
  const stopped: number[] = []
  const host: NativeHost = {
    model: async () => model,
    generate: async (req, send) => {
      sent.push(req)
      if (script) return script(req, send)
      send(WIRE.events.find((e) => e.kind === 'text'))
      return WIRE.done[0]
    },
    stop: async (id) => { stopped.push(id); return true },
  }
  return { host, sent, stopped }
}
const never = (): Promise<never> => new Promise(() => {})
const req = (o: Partial<AnswerRequest> = {}): AnswerRequest => ({ tethers: [{ agent: 7, serial: 1, skills: ['Rust'] }], prompt: 'hi', signal: new AbortController().signal, ...o })
const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 1))
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('wire.json holds the words this side reads: one request, every event, ending, error and status, and what the app carries in each status', () => {
  assert.deepEqual(Object.keys(WIRE.request).sort(), ['id', 'maxTokens', 'messages', 'think'])
  assert.deepEqual(WIRE.events.map((e) => e.kind), ['waiting', 'preparing', 'loading', 'read', 'text'])
  assert.deepEqual(WIRE.done.map((d) => d.reason), ['eog', 'maxTokens', 'stopped', 'context'])
  assert.deepEqual(WIRE.errors.map((e) => e.code), ['offline', 'refused', 'model'])
  assert.deepEqual(WIRE.statuses.map((s) => s.state), ['preparing', 'ready', 'loaded', 'failed'])
  assert.deepEqual(WIRE.models.map((m) => m.status.state), ['preparing', 'ready', 'loaded', 'failed'])
  assert.deepEqual(WIRE.models.map((m) => m.status), WIRE.statuses)
})

test('installed: nothing with no runner, no model or a shell without the command; the file in every status but failed', async () => {
  assert.deepEqual(await createNativeMind({ host: null }).installed(), [], 'a browser')
  assert.deepEqual(await createNativeMind({ host: shell(null).host }).installed(), [], 'the Windows app: the command answers null')
  const older: NativeHost = { ...shell(null).host, model: async () => { throw 'Command native_model not found' } }
  assert.deepEqual(await createNativeMind({ host: older }).installed(), [], 'an app built before the runner')
  assert.deepEqual(await createNativeMind({ host: shell({ file: FILE }).host }).installed(), [], 'an answer without a status is none')
  for (const model of WIRE.models.filter((m) => m.status.state !== 'failed')) {
    const told: (string | null)[] = []
    const m = createNativeMind({ host: shell(model).host, onFailed: (why) => told.push(why) })
    assert.deepEqual(m.settings(), { server: NATIVE_SERVER, model: NATIVE_MODEL }, 'before the app has said: no file named, nothing to choose')
    assert.deepEqual(await m.installed(), [FILE], model.status.state)
    assert.deepEqual(m.settings(), { server: NATIVE_SERVER, model: FILE })
    assert.deepEqual(told, [null], 'the card hears that it can start')
  }
})

test('installed: a model that cannot start is named with its reason, under the runner\'s own code; a runner that does not say is offline', async () => {
  const failed = carrying('failed').status
  // wire.json's failed status is this device's (its one flag set); the same status with that flag clear is the model's.
  // The flag is never named here, so a renamed one fails the first case.
  const flags = Object.keys(failed).filter((k) => typeof failed[k] === 'boolean')
  assert.equal(flags.length, 1, 'one flag: whether it is this device')
  for (const [status, code] of [[failed, 'refused'], [{ ...failed, [flags[0]]: false }, 'model']] as const) {
    const told: (string | null)[] = []
    const m = createNativeMind({ host: shell(carried(status)).host, onFailed: (why) => told.push(why) })
    await assert.rejects(m.installed(), (e: unknown) => e instanceof CognitionError && e.code === code && e.message === failed.reason)
    assert.deepEqual(told, [failed.reason])
  }
  // The runner names its file in some reasons; the card never names the model (a look's sentence reaches its details
  // too), so the reason goes without it everywhere, and the file stays on ask's model row.
  const named = `the app's model (${FILE}) ended after 1 of its 2 bytes`
  const told: (string | null)[] = []
  const cut = createNativeMind({ host: shell(carried({ ...failed, reason: named, [flags[0]]: false })).host, onFailed: (why) => told.push(why) })
  await assert.rejects(cut.installed(), (e: unknown) => e instanceof CognitionError && e.code === 'model' && e.message === 'the app\'s model ended after 1 of its 2 bytes')
  assert.deepEqual(told, ['the app\'s model ended after 1 of its 2 bytes'])
  assert.equal(cut.settings().model, FILE)
  const late: NativeHost = { ...shell(null).host, model: () => new Promise(() => { const open = setInterval(() => {}, 1000); setTimeout(() => clearInterval(open), 200) }) }
  assert.equal(ASK_MS, 5000)
  await assert.rejects(createNativeMind({ host: late, timeouts: { askMs: 20 } }).installed(), (e: unknown) => e instanceof CognitionError && e.code === 'offline' && e.message === 'the app did not say within 0.02 s whether the model it carries can start')
  // The look's own wait (its signal) is the look's to say.
  await assert.rejects(createNativeMind({ host: late }).installed(AbortSignal.timeout(10)), (e: unknown) => e instanceof DOMException && e.name === 'TimeoutError')
})

test('an answer in a shell without the runner\'s commands (the Windows app, an app built before the runner): none, said before any channel is made', async () => {
  let generated = 0
  const older: NativeHost = {
    model: async () => { throw 'Command native_model not found' },
    generate: async () => { generated++; throw 'Command native_generate not found' },
    stop: async () => { throw 'Command native_stop not found' },
  }
  const m = createNativeMind({ host: older })
  for (let i = 0; i < 2; i++) {
    await assert.rejects(m.answer(req(), () => {}), (e: unknown) => e instanceof CognitionError && e.code === 'offline' && e.message === NO_RUNNER)
  }
  assert.equal(generated, 0, 'no answer was asked, so no channel was made')
  assert.equal(m.cold(), false, 'nothing to load')
  // Once a look has found the shell has none, an answer asks nothing more.
  let asked = 0
  const looked = createNativeMind({ host: { ...older, model: async () => { asked++; throw 'Command native_model not found' } } })
  assert.deepEqual(await looked.installed(), [])
  await assert.rejects(looked.answer(req(), () => {}), (e: unknown) => e instanceof CognitionError && e.code === 'offline' && e.message === NO_RUNNER)
  assert.deepEqual([asked, generated], [1, 0])
})

test('the request: exactly the runner\'s fields, the same two messages every provider sends, the talk prompt for a conversation, the cap, a 32-bit id; the hash of what was sent', async () => {
  const s = shell(carrying('ready'))
  const m = createNativeMind({ host: s.host, maxTokens: () => 512 })
  const a = await m.answer(req({ talk: true }), () => {})
  const r = s.sent[0]
  assert.deepEqual(Object.keys(r).sort(), Object.keys(WIRE.request).sort(), 'no field the runner would refuse')
  assert.deepEqual(r.messages, [{ role: 'system', content: TALK_PROMPT }, { role: 'user', content: 'hi' }])
  assert.deepEqual([r.maxTokens, r.think], [512, false], 'the models carried have no thinking mode')
  assert.ok(Number.isInteger(r.id) && r.id >= 0 && r.id < 2 ** 32, String(r.id))
  assert.deepEqual(a, { text: 'Hello', thinking: 0, tokens: 9, reason: 'stop', promptHash: promptHash(TALK_PROMPT) })
  const b = createNativeMind({ host: s.host })
  const q = req()
  assert.equal((await b.answer(q, () => {})).promptHash, promptHash(systemFor(q)))
  assert.deepEqual(s.sent[1].messages, [{ role: 'system', content: systemFor(q) }, { role: 'user', content: 'hi' }])
  assert.equal(s.sent[1].maxTokens, ANSWER_TOKENS, 'the usual cap without the host\'s')
  await createNativeMind({ host: s.host, maxTokens: () => 512.5 }).answer(req(), () => {})
  assert.equal(s.sent[2].maxTokens, ANSWER_TOKENS, 'and in place of one the runner could not read')
  assert.notEqual(s.sent[0].id, s.sent[1].id)
  await assert.rejects(createNativeMind({ host: null }).answer(req(), () => {}), (e: unknown) => e instanceof CognitionError && e.code === 'offline' && e.message === NO_RUNNER)
})

test('every event in wire.json goes to its phase line or its piece; the HUD hears the same, cleared at the end; the city is held meanwhile', async () => {
  const phases: (string | null)[] = []
  const hud: (string | null)[] = []
  const busy: boolean[] = []
  const pieces: Piece[] = []
  const s = shell(carrying('ready'), async (_r, send) => {
    for (const e of WIRE.events) send(e)
    // A progress report after the answer began is nothing to show; an odd event is no piece.
    send({ kind: 'read', done: 187, total: 187 })
    send({ kind: 'text', text: '' })
    send(null)
    return WIRE.done[0]
  })
  const m = createNativeMind({ host: s.host, onPhase: (t) => hud.push(t), busy: (on) => busy.push(on) })
  const a = await m.answer(req({ onPhase: (p) => phases.push(p) }), (p) => pieces.push(p))
  const expected = [WAITING, 'preparing the model in the app 1%', LOADING_APP, 'reading the prompt 64%', null]
  assert.deepEqual(phases, expected, '4,194,304 of 397,808,192 bytes is 1%; 120 of 187 tokens is 64%')
  assert.deepEqual(hud, expected)
  assert.deepEqual(pieces, [{ kind: 'text', text: 'Hello' }])
  assert.deepEqual(busy, [true, false])
  assert.equal(a.text, 'Hello')
})

test('every ending in wire.json: the reason as the router reads it (a full context cuts the answer, as the cap does), the tokens, and the cost on the runtime row', async () => {
  const reasons: string[] = []
  for (const done of WIRE.done) {
    const m = createNativeMind({ host: shell(carrying('loaded'), async () => done).host })
    const a = await m.answer(req(), () => {})
    reasons.push(a.reason)
    assert.equal(a.tokens, done.tokens)
    assert.equal(m.settings().runtime, 'the app itself, on the processor, 4 threads, 4096 tokens of context; last answer: 187 prompt tokens (120 kept from the one before) read in 0.3 s, 9 written in 0.8 s (11.0 a second)')
  }
  assert.deepEqual(reasons, ['stop', 'length', 'stopped', 'length'], 'eog, maxTokens, stopped, context: \'length\' is what the operator reads as cut')
  // An ending it cannot read: the pieces counted, a plain stop, no runtime row.
  const odd = createNativeMind({ host: shell(carrying('loaded'), async (_r, send) => { send({ kind: 'text', text: 'a' }); return null }).host })
  assert.deepEqual(await odd.answer(req(), () => {}), { text: 'a', thinking: 0, tokens: 1, reason: 'stop', promptHash: promptHash(systemFor(req())) })
  assert.equal(odd.settings().runtime, undefined)
})

test('every error in wire.json keeps its code and its words; anything else the runner throws is a server failure', async () => {
  for (const err of WIRE.errors) {
    const m = createNativeMind({ host: shell(carrying('ready'), async () => { throw err }).host })
    await assert.rejects(m.answer(req(), () => {}), (e: unknown) => e instanceof CognitionError && e.code === err.code && e.message === err.message)
  }
  const m = createNativeMind({ host: shell(carrying('ready'), async () => { throw 'the channel closed' }).host })
  await assert.rejects(m.answer(req(), () => {}), (e: unknown) => e instanceof CognitionError && e.code === 'server' && e.message === 'the model inside this app failed (the channel closed)')
})

test('nothing the runner sends after the answer settled reaches it: no piece, no phase, no wait', async () => {
  let late!: (e: unknown) => void
  const s = shell(carrying('ready'), async (_r, send) => {
    late = send
    send({ kind: 'text', text: 'Hel' })
    return WIRE.done[0]
  })
  const pieces: Piece[] = []
  const phases: (string | null)[] = []
  const a = await createNativeMind({ host: s.host, timeouts: { stallMs: 20 } }).answer(req({ onPhase: (p) => phases.push(p) }), (p) => pieces.push(p))
  assert.equal(a.text, 'Hel')
  // Each late event is handled at once, so a wait it armed would be a setTimeout call made inside it.
  const real = globalThis.setTimeout
  let armed = 0
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => { armed++; return real(...args) }) as typeof setTimeout
  try {
    late({ kind: 'text', text: 'lo' })
    late({ kind: 'read', done: 1, total: 2 })
  } finally {
    globalThis.setTimeout = real
  }
  assert.deepEqual(pieces, [{ kind: 'text', text: 'Hel' }])
  assert.equal(armed, 0, 'no wait armed after it ended')
  // Before any text, a late progress report would be a phase.
  let late2!: (e: unknown) => void
  const quiet = shell(carrying('ready'), async (_r, send) => { late2 = send; return WIRE.done[0] })
  await createNativeMind({ host: quiet.host }).answer(req({ onPhase: (p) => phases.push(p) }), () => {})
  late2({ kind: 'loading', fraction: 0.5 })
  assert.deepEqual(phases, [], 'the answer\'s phase never changed after it ended')
})

test('a Stop settles the answer at once with the asker\'s own reason and stops the runner by the id it sent; a refused piece stops it too', async () => {
  const s = shell(carrying('ready'), () => never())
  const ctl = new AbortController()
  const p = createNativeMind({ host: s.host }).answer(req({ signal: ctl.signal }), () => {})
  await until(() => s.sent.length > 0)
  const why = new Error('stopped by the operator')
  ctl.abort(why)
  await assert.rejects(p, (e: unknown) => e === why)
  await until(() => s.stopped.length > 0)
  assert.deepEqual(s.stopped, [s.sent[0].id])
  // Stopped before it began: nothing is sent.
  const done = new AbortController()
  const already = new Error('already')
  done.abort(already)
  await assert.rejects(createNativeMind({ host: s.host }).answer(req({ signal: done.signal }), () => {}), (e: unknown) => e === already)
  assert.equal(s.sent.length, 1)
  // The asker refuses a piece (the 14A screen, a reply long enough): that error, and the runner is stopped.
  const t = shell(carrying('ready'), async (_r, send) => { send({ kind: 'text', text: 'no' }); return never() })
  const screened = new Error('the screen stopped it')
  await assert.rejects(createNativeMind({ host: t.host }).answer(req(), () => { throw screened }), (e: unknown) => e === screened)
  await until(() => t.stopped.length > 0)
  assert.deepEqual(t.stopped, [t.sent[0].id])
})

test('the waits: a runner quiet past the first wait, or past the stall wait once it has begun, is a timeout and is stopped; never while it waits its turn', async () => {
  assert.deepEqual([FIRST_PIECE_MS, STALL_MS], [300_000, 120_000])
  const q = shell(carrying('ready'), () => never())
  await assert.rejects(createNativeMind({ host: q.host, timeouts: { firstMs: 20 } }).answer(req(), () => {}), (e: unknown) => e instanceof CognitionError && e.code === 'timeout' && e.message === 'the model inside this app wrote nothing for 0.02 s')
  await until(() => q.stopped.length > 0)
  assert.deepEqual(q.stopped, [q.sent[0].id], 'a wait that ran out stops the runner too')
  const mid = shell(carrying('ready'), async (_r, send) => { send({ kind: 'text', text: 'Hel' }); return never() })
  await assert.rejects(createNativeMind({ host: mid.host, timeouts: { stallMs: 20 } }).answer(req(), () => {}), (e: unknown) => e instanceof CognitionError && e.code === 'timeout' && e.message === 'the model inside this app went quiet for 0.02 s in the middle of the answer')
  const reading = shell(carrying('ready'), async (_r, send) => { send({ kind: 'read', done: 1, total: 2 }); return never() })
  await assert.rejects(createNativeMind({ host: reading.host, timeouts: { stallMs: 20 } }).answer(req(), () => {}), (e: unknown) => e instanceof CognitionError && e.code === 'timeout' && e.message === 'the model inside this app went quiet for 0.02 s before its answer began')
  // Its turn behind another answer: no wait runs out, however long; once it begins, the waits run again.
  const queued = shell(carrying('ready'), async (_r, send) => {
    send({ kind: 'waiting' })
    await sleep(60)
    send({ kind: 'text', text: 'my turn' })
    return WIRE.done[0]
  })
  const a = await createNativeMind({ host: queued.host, timeouts: { firstMs: 20, stallMs: 20 } }).answer(req(), () => {})
  assert.equal(a.text, 'my turn')
  assert.deepEqual(queued.stopped, [])
  // The file's check is reported to every answer waiting its turn (engine.rs prepare): its share on the line, then
  // waiting again, and still no wait runs until its own turn begins.
  const phases: (string | null)[] = []
  const checked = shell(carrying('preparing'), async (_r, send) => {
    send({ kind: 'waiting' })
    send({ kind: 'preparing', done: 1, total: 2 })
    send({ kind: 'preparing', done: 2, total: 2 })
    await sleep(60)
    send({ kind: 'read', done: 187, total: 187 })
    send({ kind: 'text', text: 'my turn' })
    return WIRE.done[0]
  })
  const c = await createNativeMind({ host: checked.host, timeouts: { firstMs: 20, stallMs: 20 } }).answer(req({ onPhase: (p) => phases.push(p) }), () => {})
  assert.equal(c.text, 'my turn')
  assert.deepEqual(checked.stopped, [])
  assert.deepEqual(phases, [WAITING, 'preparing the model in the app 50%', WAITING, 'reading the prompt 100%', null])
  // Its turn begun (the runner reads the prompt first), a runner that goes quiet again is a timeout and is stopped.
  const stuck = shell(carrying('ready'), async (_r, send) => {
    send({ kind: 'waiting' })
    await sleep(60)
    send({ kind: 'read', done: 0, total: 187 })
    return never()
  })
  await assert.rejects(createNativeMind({ host: stuck.host, timeouts: { firstMs: 20, stallMs: 20 } }).answer(req(), () => {}), (e: unknown) => e instanceof CognitionError && e.code === 'timeout' && e.message === 'the model inside this app went quiet for 0.02 s before its answer began')
  await until(() => stuck.stopped.length > 0)
  assert.deepEqual(stuck.stopped, [stuck.sent[0].id])
})

test('two answers at once: the city is held until the last ends; the first never clears the line of the one waiting its turn', async () => {
  const hud: (string | null)[] = []
  const busy: boolean[] = []
  let release!: () => void
  const turn = new Promise<void>((r) => { release = r })
  let first!: (e: unknown) => void
  let endFirst!: () => void
  const firstEnds = new Promise<void>((r) => { endFirst = r })
  const s = shell(carrying('ready'), async (_r, send) => {
    if (s.sent.length === 1) {
      first = send
      send({ kind: 'loading', fraction: 0.5 })
      await firstEnds
      return WIRE.done[0]
    }
    send({ kind: 'waiting' })
    await turn
    send({ kind: 'text', text: 'second' })
    return WIRE.done[0]
  })
  const m = createNativeMind({ host: s.host, onPhase: (t) => hud.push(t), busy: (on) => busy.push(on) })
  const a = m.answer(req(), () => {})
  await until(() => s.sent.length === 1)
  const b = m.answer(req(), () => {})
  await until(() => s.sent.length === 2)
  assert.deepEqual(hud, [LOADING_APP, WAITING])
  first({ kind: 'text', text: 'first' })
  endFirst()
  assert.equal((await a).text, 'first')
  assert.deepEqual(hud, [LOADING_APP, WAITING], 'the waiting line stays the queued answer\'s')
  assert.deepEqual(busy, [true], 'held while the second still runs')
  release()
  assert.equal((await b).text, 'second')
  assert.deepEqual(hud, [LOADING_APP, WAITING, null])
  assert.deepEqual(busy, [true, false])
})

/** A runner whose look finds it ready, and whose model then fails to load at the first answer, for good (engine.rs fail). */
function failsToLoad(why: string) {
  let status: Status = carrying('ready').status
  const s = shell(null, async () => {
    status = { ...carrying('failed').status, reason: why, refused: false }
    throw { code: 'model', message: why }
  })
  const host: NativeHost = { ...s.host, model: async () => ({ ...carrying('ready'), status }) }
  return { host, sent: s.sent }
}

test('a model that would not load after a look found it has failed for good: said as there being none with its reason, the card told, every look and answer after it passing it over', async () => {
  const why = `the app's model (${FILE}) could not be loaded (out of memory)`
  const unnamedWhy = 'the app\'s model could not be loaded (out of memory)'
  const f = failsToLoad(why)
  const told: (string | null)[] = []
  const m = createNativeMind({ host: f.host, onFailed: (w) => told.push(w) })
  assert.deepEqual(await m.installed(), [FILE])
  assert.equal(m.cold(), true, 'ready, not loaded: an answer now would load it')
  await assert.rejects(m.answer(req(), () => {}), (e: unknown) => e instanceof CognitionError && e.code === 'offline' && e.message === unnamedWhy)
  assert.deepEqual(told, [null, 'the app\'s model could not be loaded (out of memory)'], 'the card hears why, without the file')
  assert.equal(m.cold(), false, 'nothing to load any more')
  // From then on: the next answer asks the runner nothing, and a look names it with its reason.
  await assert.rejects(m.answer(req(), () => {}), (e: unknown) => e instanceof CognitionError && e.code === 'offline' && e.message === unnamedWhy)
  assert.equal(f.sent.length, 1, 'one answer was asked of the runner')
  await assert.rejects(m.installed(), (e: unknown) => e instanceof CognitionError && e.code === 'model' && e.message === unnamedWhy)
  assert.deepEqual(told.at(-1), 'the app\'s model could not be loaded (out of memory)')
  // A per-request failure while the runner stands loaded (a conversation too long for its context) stays that answer's.
  const per = shell(carrying('loaded'), async () => { throw { code: 'model', message: 'the conversation is longer than the model\'s context' } })
  const told2: (string | null)[] = []
  const p = createNativeMind({ host: per.host, onFailed: (w) => told2.push(w) })
  for (let i = 0; i < 2; i++) {
    await assert.rejects(p.answer(req(), () => {}), (e: unknown) => e instanceof CognitionError && e.code === 'model' && e.message === 'the conversation is longer than the model\'s context')
  }
  assert.equal(per.sent.length, 2, 'asked again: nothing failed for good')
  assert.deepEqual(told2, [])
  assert.deepEqual(await p.installed(), [FILE])
})

test('cold: whether an answer now would load the app\'s model, as last heard', async () => {
  assert.equal(createNativeMind({ host: null }).cold(), false, 'no runner, nothing to load')
  const ready = createNativeMind({ host: shell(carrying('ready')).host })
  assert.equal(ready.cold(), true, 'not heard yet: cold until the app says it is loaded')
  await ready.installed()
  assert.equal(ready.cold(), true)
  await ready.answer(req(), () => {})
  assert.equal(ready.cold(), false, 'an answer that ended loaded it')
  const loaded = createNativeMind({ host: shell(carrying('loaded')).host })
  await loaded.installed()
  assert.equal(loaded.cold(), false)
  const stopped = createNativeMind({ host: shell(carrying('ready'), async () => WIRE.done.find((d) => d.reason === 'stopped')).host })
  await stopped.installed()
  await stopped.answer(req(), () => {})
  assert.equal(stopped.cold(), true, 'a job stopped before any load is answered untouched: still to be loaded')
  // An app with the runner that carries no model has nothing to load, whether a look or an answer heard so.
  const none = createNativeMind({ host: shell(null).host })
  assert.equal(none.cold(), true, 'not heard yet')
  assert.deepEqual(await none.installed(), [])
  assert.equal(none.cold(), false, 'it carries no model: nothing to load')
  const offline = WIRE.errors.find((e) => e.code === 'offline')
  const carriesNone = shell(null, async () => { throw offline })
  const asked = createNativeMind({ host: carriesNone.host })
  await assert.rejects(asked.answer(req(), () => {}), (e: unknown) => e instanceof CognitionError && e.code === 'offline' && e.message === NO_RUNNER)
  assert.equal(asked.cold(), false, 'heard at the answer too')
  await assert.rejects(none.answer(req(), () => {}), (e: unknown) => e instanceof CognitionError && e.code === 'offline' && e.message === NO_RUNNER)
  assert.equal(carriesNone.sent.length, 0, 'an app that carries no model is asked for no answer, so no channel is made')
})

test('chosen with ask provider native on a device the runner refuses (no look): failed for good, the card told why, a look after it under the runner\'s own code', async () => {
  const failed = carrying('failed')
  const s = shell(failed, async () => { throw { code: 'refused', message: failed.status.reason } })
  const told: (string | null)[] = []
  const m = createNativeMind({ host: s.host, onFailed: (w) => told.push(w) })
  for (let i = 0; i < 2; i++) {
    await assert.rejects(m.answer(req(), () => {}), (e: unknown) => e instanceof CognitionError && e.code === 'offline' && e.message === failed.status.reason)
  }
  assert.equal(s.sent.length, 1, 'the second answer asked the runner nothing')
  assert.deepEqual(told, [failed.status.reason])
  assert.equal(m.settings().model, FILE, 'ask\'s model row names the file the app said it carries')
  await assert.rejects(m.installed(), (e: unknown) => e instanceof CognitionError && e.code === 'refused' && e.message === failed.status.reason)
})
