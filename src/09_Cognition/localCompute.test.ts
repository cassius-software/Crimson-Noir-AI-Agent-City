// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the local model client (localCompute.ts) and the operator's whole path to it.
 * Only a server on this machine is ever addressed. The system prompt is the bound people's skills and what they (and
 * only they) remember. An answer streams
 * piece by piece, thinking apart from text, however its bytes are cut (every single cut, seeded pairs, byte by byte,
 * through lines and multi-byte characters). Every failure the real server was seen to give (no such model, not a
 * model that writes text, out of memory) and every other (refused, unreadable, cut short, an error mid-answer, not
 * running at all, running but refusing this page) is one plain sentence. The moment the signal aborts, the request is
 * cancelled. Over a real socket: pieces arrive as they are written, and an abort closes the connection before the
 * server has finished. And from the console, through the gateway, to a real server and back: Rejected never reaches
 * the server, an answer streams live, the tether breaking mid-answer cuts the request, the operator can stop it, and
 * a server that is not running is reported, not thrown.
 * What breaks if it is removed? A prompt could go off the machine, an answer keep streaming after the person who
 * could give it was left behind, or a stopped server crash the console, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createRng } from '../02_Define_The_Rules/degrees.ts'
import { operatorBridge, type Answer, type GateTether, type Piece, type SimControls } from '../07_Execute_Actions/operator.ts'
import type { RecruitView } from '../07_Execute_Actions/simProtocol.ts'
import type { TerminalBridge } from '../07_Execute_Actions/terminal/bridge.ts'
import { run as shell } from '../07_Execute_Actions/terminal/commands.ts'
import { TaskRouter, type SwarmSource } from '../08_Swarm/taskRouter.ts'
import {
  ANSWER_TOKENS, BASE_REALITY, CONTEXT_TOKENS, CognitionError, chat, createLocalCompute, DEFAULT_API, DEFAULT_MODEL, DEFAULT_SERVER, generate, installedModels, loopbackServer, systemPrompt,
  type FetchLike,
} from './localCompute.ts'

// ---------------------------------------------------------------- helpers

const enc = new TextEncoder()
const ndjson = (...lines: object[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'

/** An answer as the server streams it: two pieces of thinking, text with multi-byte characters, then done. */
const SAMPLE = ndjson(
  { model: 'm', response: '', thinking: 'Hmm, ', done: false },
  { model: 'm', response: '', thinking: 'grip…', done: false },
  { model: 'm', response: 'Grip scales ', done: false },
  { model: 'm', response: 'tyre friction — naïve 東京.', done: false },
  { model: 'm', response: '', done: true, done_reason: 'stop', eval_count: 42, context: [1, 2, 3] },
)

/** A response whose body delivers `text` as bytes, cut at the given offsets (each piece its own chunk). */
function streamed(text: string, cuts: readonly number[] = []): Response {
  const bytes = enc.encode(text)
  const bounds = [0, ...[...new Set(cuts)].filter((c) => c > 0 && c < bytes.length).sort((a, b) => a - b), bytes.length]
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i + 1 < bounds.length; i++) controller.enqueue(bytes.slice(bounds[i], bounds[i + 1]))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}

/** A fetch that answers with `reply`, noting every call. */
function fakeFetch(reply: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = []
  const f: FetchLike = async (url, init) => {
    calls.push({ url, init })
    return reply(url, init)
  }
  return { f, calls }
}

/** One generate over `res`: every piece, and the answer (or what it threw). */
async function collect(res: Response): Promise<{ pieces: string[]; answer: Answer | null; error: unknown }> {
  const pieces: string[] = []
  try {
    const answer = await generate(fakeFetch(() => res).f, { server: DEFAULT_SERVER, model: 'm', system: '', prompt: '' }, (p) => pieces.push(`${p.kind}:${p.text}`))
    return { pieces, answer, error: null }
  } catch (error) {
    return { pieces, answer: null, error }
  }
}

/** What a generate over `reply` threw (it must throw a CognitionError). */
async function failure(reply: () => Response | Promise<Response>): Promise<CognitionError> {
  const r = await collect(await reply())
  assert.ok(r.error instanceof CognitionError, `expected a CognitionError, got ${String(r.error)}`)
  return r.error
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** p, or a failure if it has not settled within ms: an abort that does not stop anything must fail here, not hang the run. */
const within = <T,>(p: Promise<T>, ms = 2000): Promise<T> => Promise.race([p, sleep(ms).then((): never => { throw new Error(`still waiting after ${ms} ms`) })])

/**
 * Waits until the server has seen every request end (its last byte written, or the client gone), at most 2 s: a
 * socket's close can take a while to reach the server when the machine is busy (the whole suite runs at once).
 */
const ended = async (srv: { seen: readonly { ended: string | null }[] }): Promise<void> => {
  for (let t = 0; t < 2000 && srv.seen.some((r) => r.ended === 'open' || r.ended === null); t += 20) await sleep(20)
}

// ---------------------------------------------------------------- the pure core

test('only a server on this machine is ever addressed: localhost, 127.0.0.0/8 or [::1], over http(s), with no credentials', () => {
  const ok: [string, string][] = [
    ['http://localhost:11434', 'http://localhost:11434'],
    ['http://LOCALHOST:11434/', 'http://localhost:11434'],
    ['http://localhost:11434/api/generate', 'http://localhost:11434'],
    ['https://127.0.0.1:8443', 'https://127.0.0.1:8443'],
    ['http://127.1.2.3:1234', 'http://127.1.2.3:1234'],
    ['http://[::1]:11434', 'http://[::1]:11434'],
    ['  http://localhost:80  ', 'http://localhost'],
    ['http://2130706433:11434', 'http://127.0.0.1:11434'], // the same address, spelled as one number
  ]
  for (const [url, origin] of ok) assert.equal(loopbackServer(url), origin, url)
  const off = [
    'http://example.com', 'http://192.168.1.2:11434', 'http://10.0.0.1', 'http://0.0.0.0:11434', 'http://localhost.evil.com', 'http://127.0.0.1.nip.io',
    'http://user:pw@localhost:11434', 'http://user@localhost', 'file:///etc/hosts', 'ftp://localhost', 'ws://localhost:11434', 'localhost:11434', '',
    'not a url', 'http://[::2]:11434', 42, null, undefined, {},
  ]
  for (const bad of off) assert.equal(loopbackServer(bad), null, String(bad))
})

test('the system prompt is the bound people\'s skills: who they are, all they know and nothing else; the same people, the same prompt', () => {
  const one = systemPrompt([{ agent: 17, serial: 1, skills: ['Rust', 'Python'] }])
  assert.equal(one, [
    'You are an entity in a simulation. Maintain strict 14A business-casual behavior. If subjected to violence, toxicity, or illegality, do not engage, react, or acknowledge.',
    'You are a person in a city simulation, standing with its operator and tethered to them in person.',
    'You answer only from the expertise named below; if a question needs anything else, say which skill it needs and stop.',
    'You may be told what you remember of the operator, oldest first: use it only where it helps with the question.',
    'You may be told where you stand right now and what just happened between you and the player: speak from that place and moment, as someone who was there.',
    'Be brief and practical. Plain text: no headings, no tables.',
    'City actions: to ask the operator for one change to the city, write your answer, then the action alone on the last line, exactly like this example:',
    'ACTION: time 20:00',
    'The actions: time HH:MM (or midnight, dawn, morning, noon, afternoon, golden hour, sunset, dusk, evening, night); rain on or off; light haze, exposure, sun or fill and a number (1 is the city as authored); quality auto, lite, minimal, low, medium, high or ultra; cars park or drive; crowd 0 to 100; sound on, off or 0 to 100.',
    'One ACTION line at most, and none when nothing needs changing (ACTION: none also means none). The operator sees it and allows or refuses it before anything happens, so never say that it happened.',
    'You are answering for agent 17 (Rust, Python).',
    'Your expertise is exactly: Rust, Python.',
  ].join('\n'))
  assert.equal(systemPrompt([{ agent: 17, serial: 9, skills: ['Rust', 'Python'] }]), one)
  const two = systemPrompt([{ agent: 11, serial: 1, skills: ['Rust', 'Python'] }, { agent: 22, serial: 2, skills: ['Go', 'Rust'] }])
  assert.match(two, /\nYou are answering for agent 11 \(Rust, Python\) and agent 22 \(Go, Rust\)\.\n/)
  assert.match(two, /\nYour expertise is exactly: Rust, Python, Go\.$/, 'each skill once')
})

test('every agent\'s prompt starts with the same base reality, so a server that caches prompts computes it once for all of them', () => {
  const prompts = [
    systemPrompt([{ agent: 3, serial: 1, skills: ['Go'] }]),
    systemPrompt([{ agent: 4, serial: 2, skills: ['Rust'] }], [{ agent: 4, lines: ['just now: you were asked over for Rust'] }]),
    systemPrompt([{ agent: 5, serial: 3, skills: ['Python', 'Go'] }, { agent: 6, serial: 4, skills: ['Rust'] }]),
  ]
  const common = (a: string, b: string) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i }
  for (const p of prompts) assert.ok(p.startsWith(`${BASE_REALITY}\nYou are answering for agent `), p)
  for (let i = 1; i < prompts.length; i++) {
    const shared = common(prompts[0], prompts[i])
    assert.equal(prompts[0].slice(0, shared), `${BASE_REALITY}\nYou are answering for agent `, 'they part only where the person does')
  }
  assert.doesNotMatch(BASE_REALITY, /agent \d|Rust|Python|remembers,/, 'nothing of any one agent in it')
})

test('the system prompt carries what each bound person remembers, oldest first, and nothing of anyone else', () => {
  const bound = [{ agent: 11, serial: 1, skills: ['Rust', 'Python'] }, { agent: 22, serial: 2, skills: ['Go'] }]
  const plain = systemPrompt(bound)
  assert.equal(systemPrompt(bound, []), plain)
  assert.equal(systemPrompt(bound, [{ agent: 11, lines: [] }]), plain, 'nothing remembered: the same prompt')
  const p = systemPrompt(bound, [
    { agent: 22, lines: ['just now: you were asked over for Go and joined the operator'] },
    { agent: 99, lines: ['someone else entirely'] },
    { agent: 11, lines: ['2 h ago: you were asked over for Rust and joined the operator', '5 min ago: the operator asked you about Rust: q → a'] },
  ])
  assert.equal(p, [
    BASE_REALITY,
    'You are answering for agent 11 (Rust, Python) and agent 22 (Go).',
    'Your expertise is exactly: Rust, Python, Go.',
    'Agent 22 remembers, oldest first:',
    '- just now: you were asked over for Go and joined the operator',
    'Agent 11 remembers, oldest first:',
    '- 2 h ago: you were asked over for Rust and joined the operator',
    '- 5 min ago: the operator asked you about Rust: q → a',
  ].join('\n'))
})

test('an answer streams piece by piece, thinking apart from text, and the request asks for a bounded context and answer', async () => {
  const { f, calls } = fakeFetch(() => streamed(SAMPLE))
  const pieces: string[] = []
  const stopper = new AbortController()
  const signal = stopper.signal
  const a = await generate(f, { server: 'http://localhost:11434/', model: 'm', system: 'S', prompt: 'P', signal }, (p) => pieces.push(`${p.kind}:${p.text}`))
  assert.deepEqual(pieces, ['thinking:Hmm, ', 'thinking:grip…', 'text:Grip scales ', 'text:tyre friction — naïve 東京.'])
  assert.deepEqual(a, { text: 'Grip scales tyre friction — naïve 東京.', thinking: 2, tokens: 42, reason: 'stop' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://localhost:11434/api/generate')
  const init = calls[0].init!
  assert.deepEqual([init.method, init.referrerPolicy, init.cache], ['POST', 'no-referrer', 'no-store'])
  // The request's signal is the caller's with the timeouts beside it: it aborts the moment the caller's does.
  assert.ok(init.signal instanceof AbortSignal && !init.signal.aborted)
  stopper.abort(new Error('stop'))
  assert.equal(init.signal.aborted, true)
  assert.deepEqual(JSON.parse(String(init.body)), { model: 'm', system: 'S', prompt: 'P', stream: true, think: false, options: { num_ctx: CONTEXT_TOKENS, num_predict: ANSWER_TOKENS } })
  // Not a server on this machine: nothing is sent at all.
  const none = fakeFetch(() => streamed(SAMPLE))
  await assert.rejects(generate(none.f, { server: 'http://example.com', model: 'm', system: '', prompt: '' }, () => {}), (e: unknown) => e instanceof CognitionError && e.code === 'refused')
  assert.equal(none.calls.length, 0)
})

test('however the bytes arrive (every single cut, 400 seeded pairs of cuts, one byte at a time, through lines and multi-byte characters), the answer is the same', async () => {
  const want = await collect(streamed(SAMPLE))
  assert.equal(want.error, null)
  const n = enc.encode(SAMPLE).length
  for (let c = 1; c < n; c++) assert.deepEqual(await collect(streamed(SAMPLE, [c])), want, `cut at byte ${c}`)
  const rng = createRng(11)
  for (let k = 0; k < 400; k++) {
    const cuts = [1 + Math.floor(rng() * (n - 1)), 1 + Math.floor(rng() * (n - 1))]
    assert.deepEqual(await collect(streamed(SAMPLE, cuts)), want, `cuts at ${cuts.join(', ')}`)
  }
  assert.deepEqual(await collect(streamed(SAMPLE, Array.from({ length: n - 1 }, (_, i) => i + 1))), want, 'one byte at a time')
  // The last line with no line break after it is read too.
  assert.deepEqual(await collect(streamed(SAMPLE.trimEnd())), want)
})

test('every way the server can fail is one plain sentence (the first three are what the real server said)', async () => {
  // Seen from the real server: an unknown model, a model that does not write text, and a model too large for memory.
  const missing = await failure(() => json(404, { error: "model 'no-such-model:1b' not found" }))
  assert.deepEqual([missing.code, missing.message], ['model', "the local model server has no model 'm': type ask to list the ones it has"])
  // The default model missing: what to do about it, in the same sentence.
  let noDefault: unknown = null
  try {
    await generate(fakeFetch(() => json(404, { error: `model '${DEFAULT_MODEL}' not found` })).f, { server: DEFAULT_SERVER, model: DEFAULT_MODEL, system: '', prompt: '' }, () => {})
  } catch (e) {
    noDefault = e
  }
  assert.ok(noDefault instanceof CognitionError && noDefault.code === 'model')
  assert.equal(noDefault.message, "the local model server does not have the default model 'qwen3-vl:4b': pull it into the server, or choose one it has (ask model <name>; type ask to list them)")
  const unthinking = await failure(() => json(400, { error: '"some-model" does not support thinking' }))
  assert.deepEqual([unthinking.code, unthinking.message], ['model', "the model 'm' does not think before it answers: ask think off"])
  const embed = await failure(() => json(400, { error: '"nomic-embed-text:latest" does not support generate' }))
  assert.deepEqual([embed.code, embed.message], ['model', "the model 'm' does not write text: choose another (type ask to list them)"])
  const oom = await failure(() => json(500, {
    error: 'llama-server startup failed after projector CPU offload retry: llama-server reported out-of-memory during startup: ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 20535312384\nalloc_tensor_range: failed to allocate CPU buffer of size 20535312384',
  }))
  assert.equal(oom.code, 'server')
  assert.match(oom.message, /^the local model server failed \(500\): llama-server startup failed after projector CPU offload retry: .*…$/)
  assert.ok(!oom.message.includes('\n') && oom.message.length <= 'the local model server failed (500): '.length + 161, 'one line, cut short')
  // And every other way.
  const refused = await failure(() => json(403, {}))
  assert.equal(refused.code, 'refused')
  const bad = await failure(() => new Response('Bad Gateway', { status: 502 }))
  assert.deepEqual([bad.code, bad.message], ['server', 'the local model server failed (502)'])
  const garbled = await failure(() => streamed('{"response":"a","done":false}\nnot json\n'))
  assert.deepEqual([garbled.code, garbled.message], ['unreadable', "the local model server's answer could not be read"])
  const short = await failure(() => streamed(ndjson({ response: 'a', done: false })))
  assert.deepEqual([short.code, short.message], ['unreadable', 'the local model server stopped before the answer was done'])
  const mid = await failure(() => streamed(ndjson({ response: 'a', done: false }, { error: 'the model runner crashed' })))
  assert.deepEqual([mid.code, mid.message], ['server', 'the local model server failed: the model runner crashed'])
  const empty = await failure(() => new Response(null, { status: 200 }))
  assert.equal(empty.code, 'unreadable')
})

test('no answer at all: the server is down, or up but refusing this page; an opaque look tells which, and says so', async () => {
  const down: FetchLike = async () => { throw new TypeError('Failed to fetch') }
  const d = await generate(down, { server: DEFAULT_SERVER, model: 'm', system: '', prompt: '' }, () => {}).catch((e: unknown) => e)
  assert.ok(d instanceof CognitionError)
  assert.deepEqual([d.code, d.message], ['offline', 'no local model server is answering at http://localhost:11434: start it, or point ask at the right address (ask server <url>)'])
  // Up, but refusing this page's origin: the browser hides the refusal as a failed request; a no-cors look gets through.
  const looks: { url: string; init?: RequestInit }[] = []
  const refusing: FetchLike = async (url, init) => {
    looks.push({ url, init })
    if (init?.mode === 'no-cors') return new Response(null, { status: 200 })
    throw new TypeError('Failed to fetch')
  }
  const r = await generate(refusing, { server: DEFAULT_SERVER, model: 'm', system: '', prompt: '' }, () => {}).catch((e: unknown) => e)
  assert.ok(r instanceof CognitionError)
  assert.equal(r.code, 'refused')
  assert.match(r.message, /^the local model server at http:\/\/localhost:11434 is running but refused this page: allow this page's origin in its settings \(a page opened from a file sends 'null'\), or open the page from http:\/\/localhost$/)
  assert.deepEqual(looks.map((l) => [l.url, l.init?.mode]), [['http://localhost:11434/api/generate', undefined], ['http://localhost:11434/api/version', 'no-cors']])
  // Aborted before the server answered: the signal's reason, and no look.
  const c = new AbortController()
  const reason = new DOMException('Spatial tether lost', 'AbortError')
  const hanging: FetchLike = (_url, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
  const p = generate(hanging, { server: DEFAULT_SERVER, model: 'm', system: '', prompt: '', signal: c.signal }, () => {})
  c.abort(reason)
  assert.equal(await within(p.catch((e: unknown) => e)), reason)
})

test('the moment the signal aborts mid-answer, the answer rejects with its reason, the body is cancelled, and nothing more arrives', async () => {
  const c = new AbortController()
  const reason = new DOMException('Spatial tether lost: agent 17 (Rust, Python): no longer tethered to the operator', 'AbortError')
  let cancelled = false
  let push: ((line: object) => void) | null = null
  // A body that never errors on its own (the answer must not depend on the fetch erroring it).
  const f: FetchLike = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      push = (line) => controller.enqueue(enc.encode(ndjson(line)))
    },
    cancel() {
      cancelled = true
    },
  }))
  const pieces: string[] = []
  const p = generate(f, { server: DEFAULT_SERVER, model: 'm', system: '', prompt: '', signal: c.signal }, (piece) => pieces.push(piece.text))
  await sleep(1)
  push!({ response: 'first ', done: false })
  await sleep(1)
  c.abort(reason)
  assert.equal(await within(p.catch((e: unknown) => e)), reason)
  assert.ok(cancelled, 'the body was cancelled')
  assert.throws(() => push!({ response: 'late', done: false }), TypeError, 'a late piece has nowhere to go: the body is closed')
  await sleep(1)
  assert.deepEqual(pieces, ['first '])
  // A piece the caller refuses (a lease that no longer holds) ends the answer there, with that refusal.
  const refusal = new DOMException('Spatial tether lost', 'AbortError')
  const seen: string[] = []
  const refused = await generate(fakeFetch(() => streamed(SAMPLE)).f, { server: DEFAULT_SERVER, model: 'm', system: '', prompt: '' }, (piece) => {
    seen.push(piece.kind)
    if (piece.kind === 'text') throw refusal
  }).catch((e: unknown) => e)
  assert.equal(refused, refusal)
  assert.deepEqual(seen, ['thinking', 'thinking', 'text'], 'it stopped at the refused piece')
})

test('the settings: a server on this machine and a model, kept between visits; the default is the local open-weights model', async () => {
  const saved: string[] = []
  const { f, calls } = fakeFetch(() => streamed(SAMPLE))
  const mind = createLocalCompute({ fetch: f, store: { load: () => JSON.stringify({ v: 1, server: 'http://127.0.0.1:9999', model: 'kept' }), save: (s) => saved.push(s) } })
  assert.deepEqual(mind.settings(), { server: 'http://127.0.0.1:9999', model: 'kept', think: false, api: 'generate' })
  // A kept server off this machine is not used; unreadable or missing settings are the defaults: this machine's
  // server and the default open-weights model.
  assert.equal(DEFAULT_MODEL, 'qwen3-vl:4b')
  assert.deepEqual(createLocalCompute({ fetch: f, store: { load: () => JSON.stringify({ server: 'http://example.com', model: 'x', think: true }), save: () => {} } }).settings(), { server: DEFAULT_SERVER, model: 'x', think: true, api: 'generate' })
  for (const load of [() => null, () => 'not json', () => '42', () => JSON.stringify({ v: 1, server: DEFAULT_SERVER, model: null }), () => JSON.stringify({ v: 1, server: DEFAULT_SERVER, model: '   ' }), () => { throw new Error('storage refused') }]) {
    assert.deepEqual(createLocalCompute({ fetch: f, store: { load, save: () => {} } }).settings(), { server: DEFAULT_SERVER, model: DEFAULT_MODEL, think: false, api: DEFAULT_API })
  }
  assert.throws(() => mind.setServer('http://example.com:11434'), /must be on this machine \(localhost, 127\.0\.0\.1 or \[::1\]\), not 'http:\/\/example\.com:11434'/)
  assert.equal(mind.setServer('http://localhost:11434/api/generate'), 'http://localhost:11434')
  assert.throws(() => mind.setModel('   '), /name the model/)
  assert.equal(mind.setModel(' qwen3-vl:4b '), 'qwen3-vl:4b')
  assert.deepEqual(saved.map((s) => JSON.parse(s)), [{ v: 1, server: 'http://localhost:11434', model: 'kept', think: false, api: 'generate' }, { v: 1, server: 'http://localhost:11434', model: 'qwen3-vl:4b', think: false, api: 'generate' }])
  // Thinking: off unless turned on; kept; sent with every request.
  assert.equal(mind.setThink!(true), true)
  assert.deepEqual(JSON.parse(saved.at(-1)!), { v: 1, server: 'http://localhost:11434', model: 'qwen3-vl:4b', think: true, api: 'generate' })
  assert.equal(mind.setThink!(false), false)
  assert.equal(createLocalCompute({ fetch: f, store: { load: () => null, save: () => { throw new Error('quota') } } }).setModel('m'), 'm', 'a store that refuses: the settings hold for this visit')
  // Nothing chosen, nothing kept: the default model answers, from this machine's server.
  const tethers: GateTether[] = [{ agent: 17, serial: 1, skills: ['Rust', 'Python'] }]
  const fresh = createLocalCompute({ fetch: f })
  await fresh.answer({ tethers, prompt: 'hi', signal: new AbortController().signal }, () => {})
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${DEFAULT_SERVER}/api/generate`)
  assert.equal(JSON.parse(String(calls[0].init?.body)).model, DEFAULT_MODEL)
  calls.length = 0
  // Chosen: the settings' server and model, the tethers' system prompt, the operator's prompt as typed.
  const a = await mind.answer({ tethers, prompt: 'how does grip work?', signal: new AbortController().signal }, () => {})
  assert.equal(a.reason, 'stop')
  assert.equal(calls[0].url, 'http://localhost:11434/api/generate')
  const body = JSON.parse(String(calls[0].init?.body))
  assert.deepEqual([body.model, body.system, body.prompt, body.think], ['qwen3-vl:4b', systemPrompt(tethers), 'how does grip work?', false])
  // Thinking turned on reaches the next request.
  mind.setThink!(true)
  await mind.answer({ tethers, prompt: 'and brakes?', signal: new AbortController().signal }, () => {})
  assert.equal(JSON.parse(String(calls[1].init?.body)).think, true)
})

test('the models the server has, sorted; its failures in the same plain words', async () => {
  const { f, calls } = fakeFetch(() => json(200, { models: [{ name: 'zeta:1b' }, { name: 'alpha:7b' }, { size: 3 }] }))
  assert.deepEqual(await installedModels(f, 'http://localhost:11434/'), ['alpha:7b', 'zeta:1b'])
  assert.equal(calls[0].url, 'http://localhost:11434/api/tags')
  await assert.rejects(installedModels(fakeFetch(() => json(200, { nope: 1 })).f, DEFAULT_SERVER), (e: unknown) => e instanceof CognitionError && e.code === 'unreadable')
  await assert.rejects(installedModels(async () => { throw new TypeError('Failed to fetch') }, DEFAULT_SERVER), (e: unknown) => e instanceof CognitionError && e.code === 'offline')
  await assert.rejects(installedModels(f, 'http://example.com'), (e: unknown) => e instanceof CognitionError && e.code === 'refused')
})

// ---------------------------------------------------------------- over a real socket

interface Request { path: string; body: { model?: string; system?: string; prompt?: string } | null; ended: 'complete' | 'client-gone' | 'open' }

/** A local model server with the real wire format on a free loopback port: streams `lines`, one every `gapMs`. */
async function modelServer(opts: { lines?: object[]; gapMs?: number; fail?: { status: number; error: string } } = {}) {
  const seen: Request[] = []
  const lines = opts.lines ?? Array.from({ length: 40 }, (_, i) => ({ response: `w${i} `, done: false })).concat([{ response: '', done: true, done_reason: 'stop', eval_count: 40 } as never])
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d: Buffer) => { raw += d.toString() })
    req.on('end', () => {
      const entry: Request = { path: req.url ?? '', body: raw ? JSON.parse(raw) : null, ended: 'open' }
      seen.push(entry)
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ models: [{ name: 'mock' }] }))
        entry.ended = 'complete'
        return
      }
      if (opts.fail) {
        res.writeHead(opts.fail.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: opts.fail.error }))
        entry.ended = 'complete'
        return
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      let i = 0
      // One line per gap; the last one ends the response in the same step, as the real server does.
      const timer = setInterval(() => {
        res.write(`${JSON.stringify(lines[i++])}\n`)
        if (i < lines.length) return
        clearInterval(timer)
        entry.ended = 'complete'
        res.end()
      }, opts.gapMs ?? 15)
      res.on('close', () => {
        clearInterval(timer)
        if (entry.ended !== 'complete') entry.ended = 'client-gone'
      })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, seen, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }) }
}

/** A loopback address nothing listens on. */
async function closedPort(): Promise<string> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
  await new Promise<void>((r) => s.close(() => r()))
  return url
}

const netFetch: FetchLike = (url, init) => fetch(url, init)

test('over a real socket: pieces arrive as the server writes them, not all at the end', async () => {
  const srv = await modelServer({ gapMs: 25, lines: [...Array.from({ length: 8 }, (_, i) => ({ response: `w${i} `, done: false })), { response: '', done: true, done_reason: 'stop', eval_count: 8 }] })
  try {
    const t0 = Date.now()
    const times: number[] = []
    const a = await generate(netFetch, { server: srv.url, model: 'mock', system: 'S', prompt: 'P' }, () => times.push(Date.now() - t0))
    assert.equal(a.text, 'w0 w1 w2 w3 w4 w5 w6 w7 ')
    assert.equal(times.length, 8)
    assert.ok(times[7] - times[0] >= 100, `the pieces were spread over the stream (${times.join(', ')} ms)`)
    assert.deepEqual(srv.seen.map((r) => [r.path, r.ended]), [['/api/generate', 'complete']])
  } finally {
    await srv.close()
  }
})

test('over a real socket: aborting mid-answer closes the connection; the server sees the client go before it has finished', async () => {
  const srv = await modelServer()
  try {
    const c = new AbortController()
    const reason = new DOMException('Spatial tether lost', 'AbortError')
    const pieces: string[] = []
    const p = generate(netFetch, { server: srv.url, model: 'mock', system: 'S', prompt: 'P', signal: c.signal }, (piece) => {
      pieces.push(piece.text)
      if (pieces.length === 3) c.abort(reason)
    })
    assert.equal(await within(p.catch((e: unknown) => e)), reason)
    await ended(srv)
    assert.deepEqual(srv.seen.map((r) => r.ended), ['client-gone'])
    assert.equal(pieces.length, 3)
  } finally {
    await srv.close()
  }
})

test('over a real socket: a server that is not running is reported as not running; the server\'s own failure in its words', async () => {
  const off = await closedPort()
  const e = await generate(netFetch, { server: off, model: 'mock', system: '', prompt: '' }, () => {}).catch((x: unknown) => x)
  assert.ok(e instanceof CognitionError)
  assert.deepEqual([e.code, e.message], ['offline', `no local model server is answering at ${off}: start it, or point ask at the right address (ask server <url>)`])
  const srv = await modelServer({ fail: { status: 500, error: 'out of memory' } })
  try {
    const f = await generate(netFetch, { server: srv.url, model: 'mock', system: '', prompt: '' }, () => {}).catch((x: unknown) => x)
    assert.ok(f instanceof CognitionError)
    assert.deepEqual([f.code, f.message], ['server', 'the local model server failed (500): out of memory'])
  } finally {
    await srv.close()
  }
})

// ---------------------------------------------------------------- the whole path, from the console

/** One entry of the worker's list, Active. */
const entry = (agent: number, serial: number, skills: string[]): RecruitView => ({
  agent, serial, skill: skills[0], state: 'Active', arrived: true, skills, distance: 1.5, x: 0, z: 0, seconds: 10,
})
const A = entry(11, 1, ['Rust', 'Python'])
const B = entry(22, 2, ['Go', 'Data'])

/** The page's copy of the worker's list, driven by the test. */
class Mirror implements SwarmSource {
  recruits: readonly RecruitView[]
  readonly listeners = new Set<(r: readonly RecruitView[]) => void>()
  constructor(list: readonly RecruitView[]) {
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
}

/** The city as the operator tier sees it (only the tuning tables and a clock matter here). */
const CITY: SimControls = {
  clock: { hours: () => 10, set: () => {} },
  quality: { state: () => ({ tier: 3, label: 'High', auto: true, renderScale: 1, targetMs: 16.7 }), set: () => {} },
  avatar: { position: () => ({ x: 0, z: 0, heading: 0, feetY: 0 }), teleport: () => {}, interact: () => {}, walk: () => {} },
  vehicles: { count: () => 0, state: () => ({ x: 0, z: 0, heading: 0, speed: 0, mode: 'ai', suv: false }), setMode: () => {}, recover: () => {}, intent: () => {}, nearest: () => -1 },
  physics: { tune: () => ({}), set: () => {} },
  shaders: { uniforms: () => ({}), set: () => {} },
  crowd: { stats: () => ({ drawnNear: 0, drawnFar: 0, nudges: 0, waiting: 0, crossing: 0, retreating: 0 }), cull: () => {}, positions: () => new Float32Array(0) },
  kernel: { stats: () => ({ law1: 0, law2: 0, law3: 0, sensorFlips: 0, shielded: false, last: '', audit: { ticks: 0, perimeterBreaches: 0, velocityCaps: 0, closest: Infinity, panic: null } }), blindSensing: () => {} },
  snapshot: () => ({}) as unknown as ReturnType<SimControls['snapshot']>,
}

/** The console, unlocked, over the real operator tier, gateway and client, pointed at `server` with model 'mock'. */
function operatorConsole(src: Mirror, server: string) {
  const router = new TaskRouter(src)
  const term = { operator: operatorBridge(CITY, router, createLocalCompute({ fetch: netFetch }), undefined, { contained: () => true }) } as unknown as TerminalBridge
  shell('operator unlock', term, [])
  shell(`ask server ${server}`, term, [])
  shell('ask model mock', term, [])
  return { router, term }
}

test('the whole path: from the console through the gateway to a real local server and back; Rejected never reaches it; the answer streams in live', async () => {
  const srv = await modelServer({ lines: [{ response: '', thinking: 'hmm', done: false }, { response: 'Grip scales\n', done: false }, { response: 'tyre friction.', done: false }, { response: '', done: true, done_reason: 'stop', eval_count: 3 }] })
  try {
    const { router, term } = operatorConsole(new Mirror([A, B]), srv.url)
    assert.deepEqual(await shell('ask', term, []).pending, [
      { kind: 'out', text: `server    ${srv.url}  (this machine only)` },
      { kind: 'out', text: 'model     mock' },
      { kind: 'out', text: 'api       generate: /api/generate (ask api chat for /v1/chat/completions)' },
      { kind: 'out', text: 'think     off: it answers without reasoning first (ask think on)' },
      { kind: 'out', text: 'installed mock  (chosen)' },
    ])
    const no = shell('ask networking: how do lights change?', term, [])
    assert.deepEqual(await no.pending, [{ kind: 'err', text: 'ask: Rejected (Insufficient Capabilities): nobody tethered to the operator has Networking' }])
    assert.deepEqual(srv.seen.map((r) => r.path), ['/api/tags'], 'a rejected prompt never reached the server')
    const r = shell('ask rust: how does grip work?', term, [])
    assert.deepEqual(r.lines, [{ kind: 'sys', text: 'ask: Authorized: bound to agent 11 (Rust, Python)' }])
    const live: Piece[] = []
    r.stream!.subscribe((p) => live.push(p))
    const lines = await r.pending
    assert.deepEqual(live.map((p) => `${p.kind}:${p.text}`), ['thinking:hmm', 'text:Grip scales\n', 'text:tyre ', 'text:friction.'], 'a whole word at a time, each screened (14A)')
    assert.deepEqual(lines?.slice(0, 2), [{ kind: 'out', text: 'Grip scales' }, { kind: 'out', text: 'tyre friction.' }])
    assert.match(lines?.[2].text ?? '', /^-- answered in \d+\.\d s, after 1 tokens of thinking --$/)
    const asked = srv.seen[1]
    assert.deepEqual([asked.path, asked.body?.model, asked.body?.prompt, asked.body?.system], ['/api/generate', 'mock', 'how does grip work?', systemPrompt([{ agent: 11, serial: 1, skills: ['Rust', 'Python'] }])])
    assert.equal(router.running, 0)
  } finally {
    await srv.close()
  }
})

test('the whole path: the tether breaks mid-answer and the request is cut; the operator can stop one; a server that is not running is a sentence', async () => {
  const srv = await modelServer()
  try {
    // The operator walks away while it answers: the drop lands between two pieces, as a new state does. A microtask,
    // not a timer: a timer runs after any I/O already queued, so on a machine slow enough to have the next piece in
    // hand it landed a word late (a laptop under the whole suite showed 'w0 w1 w2 w3').
    const src = new Mirror([A, B])
    const { term } = operatorConsole(src, srv.url)
    const r = shell('ask rust: explain everything', term, [])
    const live: string[] = []
    r.stream!.subscribe((p) => {
      live.push(p.text)
      if (live.length === 3) queueMicrotask(() => src.emit([B]))
    })
    assert.deepEqual(await within(r.pending!), [{ kind: 'out', text: 'w0 w1 w2' }, { kind: 'err', text: 'ask: Aborted (Spatial Tether Lost): agent 11 (Rust, Python): no longer tethered to the operator' }])
    await ended(srv)
    assert.deepEqual(srv.seen.map((q) => [q.path, q.ended]), [['/api/generate', 'client-gone']], 'the request was cut before the server finished')
    assert.equal(live.length, 3, 'nothing after the drop reached the console')
    // The operator stops one: the tether held, so Authorized, with what arrived and why it ended.
    const src2 = new Mirror([A, B])
    const s = operatorConsole(src2, srv.url)
    const stopped = shell('ask rust: explain everything', s.term, [])
    let n = 0
    stopped.stream!.subscribe(() => { if (++n === 2) queueMicrotask(() => shell('ask stop', s.term, [])) })
    const sl = await within(stopped.pending!)
    assert.deepEqual(sl?.at(-1), { kind: 'err', text: 'ask: stopped by the operator' })
    assert.deepEqual(sl?.slice(0, -1), [{ kind: 'out', text: 'w0 w1' }])
    await ended(srv)
    assert.equal(srv.seen.at(-1)?.ended, 'client-gone')
    // Not running at all: Authorized (the tether held) and one sentence, nothing thrown.
    const off = await closedPort()
    const o = operatorConsole(new Mirror([A]), off)
    const down = shell('ask rust: hello?', o.term, [])
    assert.deepEqual(down.lines, [{ kind: 'sys', text: 'ask: Authorized: bound to agent 11 (Rust, Python)' }])
    assert.deepEqual(await down.pending, [{ kind: 'err', text: `ask: no local model server is answering at ${off}: start it, or point ask at the right address (ask server <url>)` }])
    assert.deepEqual(await shell('ask', o.term, []).pending, [
      { kind: 'out', text: `server    ${off}  (this machine only)` },
      { kind: 'out', text: 'model     mock' },
      { kind: 'out', text: 'api       generate: /api/generate (ask api chat for /v1/chat/completions)' },
      { kind: 'out', text: 'think     off: it answers without reasoning first (ask think on)' },
      { kind: 'err', text: `ask: no local model server is answering at ${off}: start it, or point ask at the right address (ask server <url>)` },
    ])
  } finally {
    await srv.close()
  }
})

// ---------------------------------------------------------------- the chat format (OpenAI-compatible)

const sse = (...events: (object | string)[]): string => events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
const delta = (d: object, finish: string | null = null) => ({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: d, finish_reason: finish }] })

/** A chat answer as servers stream it: thinking under both names, a comment and an event name, text, the finish, usage. */
const CHAT = ': keep-alive\n\n' + 'event: message\n' + sse(
  delta({ role: 'assistant', content: '' }),
  delta({ reasoning_content: 'Hmm, ' }),
  delta({ reasoning: 'grip…' }),
  delta({ content: 'Grip scales ' }),
  delta({ content: 'tyre friction — naïve 東京.' }),
  delta({}, 'stop'),
  { id: 'c', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 9, completion_tokens: 42, total_tokens: 51 } },
  '[DONE]',
)

/** One chat over `res`: every piece, and the answer (or what it threw). */
async function collectChat(res: Response): Promise<{ pieces: string[]; answer: Answer | null; error: unknown }> {
  const pieces: string[] = []
  try {
    const answer = await chat(fakeFetch(() => res).f, { server: DEFAULT_SERVER, model: 'm', system: '', prompt: '' }, (p) => pieces.push(`${p.kind}:${p.text}`))
    return { pieces, answer, error: null }
  } catch (error) {
    return { pieces, answer: null, error }
  }
}

test('chat: server-sent events stream piece by piece, thinking under either name apart from text; the request is a system and a user message', async () => {
  const { f, calls } = fakeFetch(() => streamed(CHAT))
  const pieces: string[] = []
  const stopper = new AbortController()
  const signal = stopper.signal
  const a = await chat(f, { server: 'http://127.0.0.1:8080/v1', model: 'm', system: 'S', prompt: 'P', signal, think: true }, (p) => pieces.push(`${p.kind}:${p.text}`))
  assert.deepEqual(pieces, ['thinking:Hmm, ', 'thinking:grip…', 'text:Grip scales ', 'text:tyre friction — naïve 東京.'])
  assert.deepEqual(a, { text: 'Grip scales tyre friction — naïve 東京.', thinking: 2, tokens: 42, reason: 'stop' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://127.0.0.1:8080/v1/chat/completions', 'the path is added to the origin')
  const init = calls[0].init!
  assert.deepEqual([init.method, init.referrerPolicy, init.cache], ['POST', 'no-referrer', 'no-store'])
  // The request's signal is the caller's with the timeouts beside it: it aborts the moment the caller's does.
  assert.ok(init.signal instanceof AbortSignal && !init.signal.aborted)
  stopper.abort(new Error('stop'))
  assert.equal(init.signal.aborted, true)
  assert.equal((init.headers as Record<string, string>).accept, 'text/event-stream')
  assert.deepEqual(JSON.parse(String(init.body)), {
    model: 'm', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'P' }],
    stream: true, max_tokens: ANSWER_TOKENS, stream_options: { include_usage: true },
  }, 'no context window and no think: the server decides both')
  // Not a server on this machine: nothing is sent at all.
  const none = fakeFetch(() => streamed(CHAT))
  for (const server of ['https://api.example.com', 'http://10.0.0.2:8080', 'http://user:pw@localhost:8080']) {
    await assert.rejects(chat(none.f, { server, model: 'm', system: '', prompt: '' }, () => {}), (e: unknown) => e instanceof CognitionError && e.code === 'refused')
  }
  assert.equal(none.calls.length, 0)
})

test('chat: however the bytes arrive (every single cut, one byte at a time), the answer is the same', async () => {
  const want = await collectChat(streamed(CHAT))
  assert.equal(want.error, null)
  const n = enc.encode(CHAT).length
  for (let c = 1; c < n; c++) assert.deepEqual(await collectChat(streamed(CHAT, [c])), want, `cut at byte ${c}`)
  assert.deepEqual(await collectChat(streamed(CHAT, Array.from({ length: n - 1 }, (_, i) => i + 1))), want, 'one byte at a time')
  // Line breaks as carriage return + line feed.
  assert.deepEqual(await collectChat(streamed(CHAT.replaceAll('\n', '\r\n'))), want)
})

test('chat: done at [DONE], or at the finish reason if the server closes without it; cut short, an error mid-answer, a refusal: one sentence', async () => {
  const noDone = await collectChat(streamed(sse(delta({ content: 'ok' }), delta({}, 'length'))))
  assert.deepEqual(noDone.answer, { text: 'ok', thinking: 0, tokens: 0, reason: 'length' })
  const short = await collectChat(streamed(sse(delta({ content: 'half' }))))
  assert.ok(short.error instanceof CognitionError && short.error.code === 'unreadable')
  assert.equal(short.error.message, 'the local model server stopped before the answer was done')
  const mid = await collectChat(streamed(sse(delta({ content: 'a' }), { error: { message: 'model crashed\nstack…', type: 'server_error' } })))
  assert.ok(mid.error instanceof CognitionError)
  assert.deepEqual([mid.error.code, mid.error.message], ['server', 'the local model server failed: model crashed'])
  const bad = await collectChat(streamed('data: {not json\n\n'))
  assert.ok(bad.error instanceof CognitionError && bad.error.code === 'unreadable')
  // HTTP failures in the chat servers' own shape.
  const missing = await collectChat(json(404, { error: { message: 'model "m" not found', type: 'invalid_request_error' } }))
  assert.ok(missing.error instanceof CognitionError)
  assert.deepEqual([missing.error.code, missing.error.message], ['model', "the local model server has no model 'm': type ask to list the ones it has"])
  const oom = await collectChat(json(500, { error: { message: 'failed to allocate KV cache' } }))
  assert.ok(oom.error instanceof CognitionError)
  assert.deepEqual([oom.error.code, oom.error.message], ['server', 'the local model server failed (500): failed to allocate KV cache'])
  const refused = await collectChat(json(403, { error: 'origin not allowed' }))
  assert.ok(refused.error instanceof CognitionError && refused.error.code === 'refused')
})

test('chat: the moment the signal aborts mid-answer, it rejects with the reason and the body is cancelled', async () => {
  const c = new AbortController()
  const reason = new DOMException('Spatial tether lost', 'AbortError')
  let cancelled = false
  let push: ((e: object) => void) | null = null
  const f: FetchLike = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { push = (e) => controller.enqueue(enc.encode(sse(e))) },
    cancel() { cancelled = true },
  }))
  const pieces: string[] = []
  const p = chat(f, { server: DEFAULT_SERVER, model: 'm', system: '', prompt: '', signal: c.signal }, (piece) => pieces.push(piece.text))
  await sleep(1)
  push!(delta({ content: 'first ' }))
  await sleep(1)
  c.abort(reason)
  assert.equal(await within(p.catch((e: unknown) => e)), reason)
  assert.ok(cancelled, 'the body was cancelled')
  assert.deepEqual(pieces, ['first '])
})

test('chat: the models the server lists at /v1/models, by id, sorted; the setting kept and used; anything else refused', async () => {
  const { f, calls } = fakeFetch((url) => (url.endsWith('/v1/models')
    ? json(200, { object: 'list', data: [{ id: 'zeta' }, { id: 'alpha', owned_by: 'me' }, { object: 'model' }] })
    : streamed(CHAT)))
  assert.deepEqual(await installedModels(f, 'http://localhost:8080', undefined, 'chat'), ['alpha', 'zeta'])
  assert.equal(calls[0].url, 'http://localhost:8080/v1/models')
  await assert.rejects(installedModels(fakeFetch(() => json(200, { models: [{ name: 'x' }] })).f, DEFAULT_SERVER, undefined, 'chat'), (e: unknown) => e instanceof CognitionError && e.code === 'unreadable')
  calls.length = 0
  const saved: string[] = []
  const mind = createLocalCompute({ fetch: f, store: { load: () => null, save: (x) => saved.push(x) } })
  assert.equal(DEFAULT_API, 'generate')
  assert.throws(() => mind.setApi!('openai'), /ask api takes generate or chat/)
  assert.throws(() => mind.setApi!(''), TypeError)
  assert.equal(mind.setApi!('chat'), 'chat')
  assert.deepEqual(JSON.parse(saved.at(-1)!).api, 'chat')
  mind.setServer('http://127.0.0.1:8080')
  assert.deepEqual(await mind.installed(), ['alpha', 'zeta'])
  const a = await mind.answer({ tethers: [{ agent: 3, serial: 1, skills: ['Go'] }], prompt: 'hi', signal: new AbortController().signal }, () => {})
  assert.equal(a.text, 'Grip scales tyre friction — naïve 東京.')
  assert.deepEqual(calls.map((c) => c.url), ['http://127.0.0.1:8080/v1/models', 'http://127.0.0.1:8080/v1/chat/completions'])
  assert.equal(JSON.parse(String(calls[1].init?.body)).messages[0].content, systemPrompt([{ agent: 3, serial: 1, skills: ['Go'] }]))
  // Kept between visits; an unknown kept format is the default.
  assert.equal(createLocalCompute({ fetch: f, store: { load: () => saved.at(-1)!, save: () => {} } }).settings().api, 'chat')
  assert.equal(createLocalCompute({ fetch: f, store: { load: () => JSON.stringify({ api: 'remote' }), save: () => {} } }).settings().api, 'generate')
})

test('chat, the whole path over a real socket: ask api chat from the console; pieces arrive as written; an abort closes the connection', async () => {
  const seen: { path: string; ended: string }[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d: Buffer) => { raw += d.toString() })
    req.on('end', () => {
      const entry = { path: req.url ?? '', ended: 'open' }
      seen.push(entry)
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock' }] }))
        entry.ended = 'complete'
        return
      }
      const events = [...Array.from({ length: 30 }, (_, i) => delta({ content: `w${i} ` })), delta({}, 'stop'), '[DONE]']
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let i = 0
      const timer = setInterval(() => {
        res.write(sse(events[i++]))
        if (i < events.length) return
        clearInterval(timer)
        entry.ended = 'complete'
        res.end()
      }, 15)
      res.on('close', () => {
        clearInterval(timer)
        if (entry.ended !== 'complete') entry.ended = 'client-gone'
      })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const { term } = operatorConsole(new Mirror([A]), url)
    assert.deepEqual(shell('ask api chat', term, []).lines, [{ kind: 'out', text: 'api       chat: /v1/chat/completions (the chat-completions format most local servers speak)' }])
    assert.deepEqual(shell('ask api remote', term, []).lines, [{ kind: 'err', text: 'ask: ask api takes generate or chat' }])
    const status = await shell('ask', term, []).pending
    assert.deepEqual(status?.slice(2, 5), [
      { kind: 'out', text: 'api       chat: /v1/chat/completions (ask api generate for /api/generate)' },
      { kind: 'out', text: 'think     not sent in the chat format: the server decides' },
      { kind: 'out', text: 'installed mock  (chosen)' },
    ])
    const r = shell('ask rust: hi', term, [])
    const live: number[] = []
    const t0 = Date.now()
    r.stream!.subscribe(() => live.push(Date.now() - t0))
    const lines = await r.pending
    assert.equal(lines?.[0].text.trim(), Array.from({ length: 30 }, (_, i) => `w${i}`).join(' '), 'all thirty words, in order')
    assert.ok(live.length === 30 && live[29] - live[0] >= 200, `pieces spread over the stream (${live[0]}..${live[29]} ms)`)
    assert.deepEqual(seen.map((x) => [x.path, x.ended]), [['/v1/models', 'complete'], ['/v1/chat/completions', 'complete']])
    // Stopped by the operator mid-answer: the connection closes before the server has finished.
    const s2 = shell('ask rust: again', term, [])
    await sleep(60)
    shell('ask stop', term, [])
    await within(Promise.resolve(s2.pending))
    for (let t = 0; t < 2000 && seen.at(-1)!.ended === 'open'; t += 20) await sleep(20)
    assert.equal(seen.at(-1)!.ended, 'client-gone')
  } finally {
    await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) })
  }
})

test('the system prompt ends with where each bound person stands and what just happened to them, under one heading each, after the memories, and nothing of anyone else', () => {
  const bound = [{ agent: 11, serial: 1, skills: ['Rust'] }, { agent: 22, serial: 2, skills: ['Go'] }]
  const plain = systemPrompt(bound)
  assert.equal(systemPrompt(bound, [], []), plain)
  assert.equal(systemPrompt(bound, [], [{ agent: 11, surroundings: null, recent: [] }]), plain, 'nothing known: the same prompt')
  const moment = { who: 'the player', what: 'asked "hi" and you answered "hello"', where: 'Aurel St & 3rd Ave', at: 5, clock: '17:01' }
  const p = systemPrompt(bound, [{ agent: 11, lines: ['2 h ago: you were asked over for Rust and joined the operator'] }], [
    { agent: 22, surroundings: 'Standing at Lakefront Metro.', recent: [] },
    { agent: 99, surroundings: 'somewhere else', recent: [moment] },
    { agent: 11, surroundings: 'Standing near The Spire in Lakefront Metro at 17:02.', recent: [moment] },
  ])
  assert.equal(p, [
    BASE_REALITY,
    'You are answering for agent 11 (Rust) and agent 22 (Go).',
    'Your expertise is exactly: Rust, Go.',
    'Agent 11 remembers, oldest first:',
    '- 2 h ago: you were asked over for Rust and joined the operator',
    'Agent 22, right now:',
    '- Standing at Lakefront Metro.',
    'Agent 11, right now:',
    '- Standing near The Spire in Lakefront Metro at 17:02.',
    'Just before this, oldest first:',
    '- 17:01 Aurel St & 3rd Ave: the player asked "hi" and you answered "hello"',
  ].join('\n'))
  assert.ok(p.startsWith(plain), 'the here and now comes last, so the cached prefix is untouched')
})
