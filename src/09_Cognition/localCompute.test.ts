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
 * a server that is not running is reported, not thrown. Ollama's list with each model's size and where a loaded model
 * sits (/api/ps, with the context Ollama runs it at) are read from this machine only, and a big model's first-piece
 * wait may grow but never shrink. A larger context reaches the generate format alone, with a quarter of it as the
 * answer cap, and anything but a whole number from 8,192 to 32,768 sends today's body byte for byte. A chat-format
 * refusal in SGLang's or vLLM's own words (the prompt and the answer cap longer than the window) is asked once more
 * with one token under the room the server says is left, from 255 to 2,047 tokens, under the same stop and watch;
 * anything else is as it was.
 * What breaks if it is removed? A prompt could go off the machine, an answer keep streaming after the person who
 * could give it was left behind, or a stopped server crash the console, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { AGENT_SYSTEM_PROMPT_CORE } from '../02_Define_The_Rules/conduct.ts'
import { createRng } from '../02_Define_The_Rules/degrees.ts'
import { ACTION_RULES } from '../06_Make_Decisions/actions.ts'
import { operatorBridge, type Answer, type GateTether, type Piece, type SimControls } from '../07_Execute_Actions/operator.ts'
import type { RecruitView } from '../07_Execute_Actions/simProtocol.ts'
import type { TerminalBridge } from '../07_Execute_Actions/terminal/bridge.ts'
import { run as shell } from '../07_Execute_Actions/terminal/commands.ts'
import { TaskRouter, type SwarmSource } from '../08_Swarm/taskRouter.ts'
import {
  ANSWER_MIN_TOKENS, ANSWER_TOKENS, BASE_REALITY, BYTES_MAX, CONTEXT_MAX, CONTEXT_TOKENS, CognitionError, chat, contextOf, createLocalCompute, DEFAULT_API, DEFAULT_MODEL, DEFAULT_SERVER, generate, installedModels, installedSizes, loopbackServer,
  placementOf, promptHash, sentence, systemFor, systemPrompt, TALK_PROMPT, type FetchLike,
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

test('the operator\'s steering lines sit after the expertise and before the memories; none given, the prompt is as it was', () => {
  const bound = [{ agent: 17, serial: 1, skills: ['Rust', 'Python'] }]
  const plain = systemPrompt(bound)
  assert.equal(systemPrompt(bound, [], [], []), plain)
  const steered = systemPrompt(bound, [{ agent: 17, lines: ['just now: you were asked over for Rust'] }], [], ['Steering: gently drive slowly and smoothly; speed is never the point.', 'Steering: hold frame health at 80%.'])
  assert.equal(steered, [
    BASE_REALITY,
    'You are answering for agent 17 (Rust, Python).',
    'Your expertise is exactly: Rust, Python.',
    'Steering: gently drive slowly and smoothly; speed is never the point.',
    'Steering: hold frame health at 80%.',
    'Agent 17 remembers, oldest first:',
    '- just now: you were asked over for Rust',
  ].join('\n'))
  assert.notEqual(steered, plain, 'the prompt, and so its hash, carries the steering')
  // Nobody bound: the guide's prompt, steering or not.
  assert.equal(systemPrompt([], [], [], ['Steering: anything.']), systemPrompt([]))
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

test('a conversation\'s prompt is the 14A core and the guide\'s line only: no expertise rule and no city actions, under half the guide\'s prompt', () => {
  assert.equal(TALK_PROMPT, `${AGENT_SYSTEM_PROMPT_CORE}\nNo one is tethered for this request: you speak as the city's guide, in conversation.`)
  assert.ok(TALK_PROMPT.startsWith(AGENT_SYSTEM_PROMPT_CORE), 'the 14A core opens it, as it opens every prompt')
  for (const rule of ACTION_RULES) assert.ok(!TALK_PROMPT.includes(rule), 'a conversation never acts, so it is never told how')
  assert.doesNotMatch(TALK_PROMPT, /ACTION|expertise|remember/)
  // A phone reading the prompt on one thread pays for every token before the first word (inPagePlan.ts PHONE_BATCH).
  assert.ok(TALK_PROMPT.length * 2 < systemPrompt([]).length, `${TALK_PROMPT.length} against ${systemPrompt([]).length} characters`)
  // talk: true wins over whatever else the request carries; without it, the prompt is exactly as it was.
  const bound: GateTether[] = [{ agent: 17, serial: 1, skills: ['Rust'] }]
  const memories = [{ agent: 17, lines: ['met the operator at the pier'] }]
  assert.equal(systemFor({ tethers: bound, memories, steering: ['Steering: anything.'], talk: true }), TALK_PROMPT)
  assert.equal(systemFor({ tethers: [], talk: true }), TALK_PROMPT)
  assert.equal(systemFor({ tethers: bound, memories, steering: ['Steering: anything.'] }), systemPrompt(bound, memories, [], ['Steering: anything.']))
  assert.equal(systemFor({ tethers: [], talk: false }), systemPrompt([]))
  assert.notEqual(promptHash(TALK_PROMPT), promptHash(systemPrompt([])), 'the audit tells a conversation from the guide')
})

test('a server on this machine is sent the talk prompt for a conversation, and the hash of what it was sent', async () => {
  const { f, calls } = fakeFetch(() => streamed(SAMPLE))
  const mind = createLocalCompute({ fetch: f })
  const a = await mind.answer({ tethers: [], prompt: 'how is it going', signal: new AbortController().signal, talk: true }, () => {})
  assert.equal(JSON.parse(String(calls[0].init?.body)).system, TALK_PROMPT)
  assert.equal(a.promptHash, promptHash(TALK_PROMPT))
  await mind.answer({ tethers: [], prompt: 'make it night', signal: new AbortController().signal }, () => {})
  assert.equal(JSON.parse(String(calls[1].init?.body)).system, systemPrompt([]), 'not a conversation: as it was')
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
  // Ollama with OLLAMA_NO_CLOUD, asked for a cloud model (server/routes.go, Ollama 0.40.3): its words, not the origin's.
  const noCloud = await failure(() => json(403, { error: 'ollama cloud is disabled: remote model is unavailable' }))
  assert.deepEqual([noCloud.code, noCloud.message], ['model', 'the local model server runs no cloud models (403: ollama cloud is disabled: remote model is unavailable): choose one on this machine (type ask to list them)'])
  assert.equal((await failure(() => json(403, { error: 'origin not allowed' }))).code, 'refused')
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

test('installedSizes: Ollama\'s list with each model\'s weight bytes and whether it writes text; its cloud models dropped; a size out of bounds is unknown; the same request as installedModels', async () => {
  const tags = {
    models: [
      { name: 'b:7b', size: 4.7e9, capabilities: ['completion'] },
      { name: 'a:1b', size: 1.1e9 },
      { name: 'nomic-embed-text', size: 274_302_450, capabilities: ['embedding'] },
      { name: 'w', size: -1, capabilities: ['completion', 'embedding'] },
      { name: 'big', size: 2 ** 51 },
      { name: 'v', size: 2e9, capabilities: ['vision'] },
      { name: 'gpt-oss:120b-cloud', size: 384, remote_host: 'https://ollama.com:443', remote_model: 'gpt-oss:120b' },
      { size: 3 },
    ],
  }
  const { f, calls } = fakeFetch(() => json(200, tags))
  const sizes = await installedSizes(f, 'http://localhost:11434/')
  assert.deepEqual(sizes, [
    { name: 'a:1b', bytes: 1.1e9, text: true },
    { name: 'b:7b', bytes: 4.7e9, text: true },
    { name: 'big', bytes: null, text: true },
    { name: 'nomic-embed-text', bytes: 274_302_450, text: false },
    { name: 'v', bytes: 2e9, text: false },
    { name: 'w', bytes: null, text: false },
  ])
  assert.equal(2 ** 51 > BYTES_MAX, true)
  assert.deepEqual(calls.map((c) => c.url), ['http://localhost:11434/api/tags'])
  // The same request, and the same names, as the list `ask` shows on this machine.
  const names = await installedModels(f, 'http://localhost:11434/', undefined, 'generate', true, true)
  assert.deepEqual(sizes.map((m) => m.name), names)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].init, calls[1].init)
  assert.deepEqual(calls[0].init, { signal: undefined, cache: 'no-store', referrerPolicy: 'no-referrer' })
  // Its failures are the list's, and nothing is asked off this machine.
  await assert.rejects(installedSizes(fakeFetch(() => json(200, { nope: 1 })).f, DEFAULT_SERVER), (e: unknown) => e instanceof CognitionError && e.code === 'unreadable')
  await assert.rejects(installedSizes(async () => { throw new TypeError('Failed to fetch') }, DEFAULT_SERVER), (e: unknown) => e instanceof CognitionError && e.code === 'offline')
  const off = fakeFetch(() => json(200, tags))
  await assert.rejects(installedSizes(off.f, 'http://example.com:11434'), (e: unknown) => e instanceof CognitionError && e.code === 'refused')
  assert.equal(off.calls.length, 0)
  // A malformed entry (null) is skipped by both readers alike, so a look and `ask` alone agree on what Ollama lists.
  const odd = fakeFetch(() => json(200, { models: [null, { name: 'gemma:2b', size: 1.7e9 }] }))
  assert.deepEqual((await installedSizes(odd.f, DEFAULT_SERVER)).map((m) => m.name), ['gemma:2b'])
  assert.deepEqual(await installedModels(odd.f, DEFAULT_SERVER, undefined, 'generate', true, true), ['gemma:2b'])
  assert.deepEqual(await installedModels(odd.f, DEFAULT_SERVER), ['gemma:2b'])
})

test('placementOf: Ollama\'s /api/ps for the model by name or name:latest; bytes checked; null for anything else, and nothing asked off this machine', async () => {
  const ps = {
    models: [
      { name: 'qwen3-vl:4b', model: 'qwen3-vl:4b', size: 5e9, size_vram: 5e9 },
      { name: 'llama3:latest', model: 'llama3:latest', size: 6e9, size_vram: 2e9 },
      { name: 'over:1b', size: 1e9, size_vram: 2e9 },
      { name: 'cpu:1b', size: 1e9, size_vram: 0 },
      { name: 'novram:1b', size: 1e9 },
      { name: 'negative:1b', size: 1e9, size_vram: -1 },
      { name: 'huge:1b', size: 2 ** 51, size_vram: 0 },
      { name: 'empty:1b', size: 0, size_vram: 0 },
    ],
  }
  const { f, calls } = fakeFetch(() => json(200, ps))
  assert.deepEqual(await placementOf(f, 'http://localhost:11434/', 'qwen3-vl:4b'), { loaded: 5e9, gpu: 5e9 })
  assert.deepEqual(calls.map((c) => [c.url, c.init?.cache, c.init?.referrerPolicy]), [['http://localhost:11434/api/ps', 'no-store', 'no-referrer']])
  assert.deepEqual(await placementOf(f, DEFAULT_SERVER, 'llama3'), { loaded: 6e9, gpu: 2e9 }, 'the default tag shown')
  assert.deepEqual(await placementOf(f, DEFAULT_SERVER, 'llama3:latest'), { loaded: 6e9, gpu: 2e9 })
  assert.deepEqual(await placementOf(f, DEFAULT_SERVER, 'over:1b'), { loaded: 1e9, gpu: 1e9 }, 'never more on the GPU than in all')
  assert.deepEqual(await placementOf(f, DEFAULT_SERVER, 'cpu:1b'), { loaded: 1e9, gpu: 0 })
  for (const model of ['novram:1b', 'negative:1b', 'huge:1b', 'empty:1b', 'gone:1b', 'qwen3-vl']) assert.equal(await placementOf(f, DEFAULT_SERVER, model), null, model)
  // Every failure is null, never a throw.
  const signal = AbortSignal.timeout(2000)
  assert.equal(await placementOf(fakeFetch(() => json(500, { error: 'busy' })).f, DEFAULT_SERVER, 'qwen3-vl:4b', signal), null)
  assert.equal(await placementOf(async () => { throw new TypeError('Failed to fetch') }, DEFAULT_SERVER, 'qwen3-vl:4b'), null)
  assert.equal(await placementOf(fakeFetch(() => new Response('not json', { status: 200 })).f, DEFAULT_SERVER, 'qwen3-vl:4b'), null)
  assert.equal(await placementOf(fakeFetch(() => json(200, { models: 'none' })).f, DEFAULT_SERVER, 'qwen3-vl:4b'), null)
  assert.equal(await placementOf(fakeFetch(() => json(200, null)).f, DEFAULT_SERVER, 'qwen3-vl:4b'), null)
  // The signal given is the one sent.
  const seen = fakeFetch(() => json(200, ps))
  await placementOf(seen.f, DEFAULT_SERVER, 'qwen3-vl:4b', signal)
  assert.equal(seen.calls[0].init?.signal, signal)
  // Off this machine: null, and nothing asked at all.
  const off = fakeFetch(() => json(200, ps))
  assert.equal(await placementOf(off.f, 'http://example.com:11434', 'qwen3-vl:4b'), null)
  assert.equal(off.calls.length, 0)
})

test('pace: tokens a second from Ollama\'s own eval_count and eval_duration; absent when it does not say', async () => {
  const say = (done: object) => generate(fakeFetch(() => streamed(ndjson({ response: 'ok', done: false }, { response: '', done: true, done_reason: 'stop', ...done }))).f, { server: DEFAULT_SERVER, model: 'm', system: '', prompt: '' }, () => {})
  assert.deepEqual(await say({ eval_count: 64, eval_duration: 8e9 }), { text: 'ok', thinking: 0, tokens: 64, reason: 'stop', pace: 8 })
  for (const done of [{ eval_count: 64, eval_duration: 0 }, { eval_count: 64 }, { eval_count: 0, eval_duration: 8e9 }, { eval_count: 64, eval_duration: '8e9' }, { eval_count: 64, eval_duration: -1 }]) {
    const a = await say(done)
    assert.equal('pace' in a, false, JSON.stringify(done))
    assert.equal(a.tokens, done.eval_count === 64 ? 64 : 0)
  }
  // SAMPLE carries no eval_duration: the answer is as it always was.
  assert.deepEqual(await generate(fakeFetch(() => streamed(SAMPLE)).f, { server: DEFAULT_SERVER, model: 'm', system: '', prompt: '' }, () => {}), { text: 'Grip scales tyre friction — naïve 東京.', thinking: 2, tokens: 42, reason: 'stop' })
})

test('coldWait lengthens a model\'s first-piece wait and never shortens it', async () => {
  /** A server whose first line, a whole answer, comes `ms` after the request (100 ms unless said). */
  const lateBy = (ms: number): FetchLike => async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setTimeout(() => {
          try {
            controller.enqueue(enc.encode(SAMPLE))
            controller.close()
          } catch {
            // cancelled already
          }
        }, ms)
      },
      cancel() { clearTimeout(timer) },
    }), { status: 200 })
  }
  const late = lateBy(100)
  const asked: string[] = []
  const ask = (wait: number) => createLocalCompute({
    fetch: late, timeouts: { firstMs: 50, stallMs: 50 }, coldWait: (model) => { asked.push(model); return wait },
  }).answer({ tethers: [], prompt: 'hi', signal: new AbortController().signal }, () => {}).then((a) => a.reason, (e: unknown) => e)
  assert.equal(await within(ask(150)), 'stop', 'a longer wait: the late first line arrives in time')
  assert.deepEqual(asked, [DEFAULT_MODEL], 'asked for the model the answer sends')
  for (const wait of [10, 0, -1, Number.NaN, Infinity]) {
    const e = await within(ask(wait))
    assert.ok(e instanceof CognitionError && e.code === 'timeout', `${wait}: the wait as it was`)
  }
  // Never shorter: a first line at 25 ms still arrives within the client's own 50 ms, whatever shorter wait is given.
  for (const wait of [10, 1, 0, -1, Number.NaN]) {
    const soon = createLocalCompute({ fetch: lateBy(25), timeouts: { firstMs: 50, stallMs: 50 }, coldWait: () => wait })
    assert.equal(await within(soon.answer({ tethers: [], prompt: 'hi', signal: new AbortController().signal }, () => {}).then((a) => a.reason, (e: unknown) => e)), 'stop', `${wait}: not shortened`)
  }
  // Only the first-piece wait: an answer that goes quiet after its first piece is cut off at the stall wait as before.
  const quiet: FetchLike = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(enc.encode('{"response":"a","done":false}\n')) },
  }), { status: 200 })
  const t0 = performance.now()
  const stalled = await within(createLocalCompute({ fetch: quiet, timeouts: { firstMs: 50, stallMs: 50 }, coldWait: () => 5000 }).answer({ tethers: [], prompt: 'hi', signal: new AbortController().signal }, () => {}).catch((e: unknown) => e))
  assert.ok(stalled instanceof CognitionError && stalled.code === 'timeout' && /went quiet/.test(stalled.message), String(stalled))
  assert.ok(performance.now() - t0 < 1500, 'the stall wait, not the longer first wait')
  // Without the option the wait is the client's own.
  const plain = await within(createLocalCompute({ fetch: late, timeouts: { firstMs: 50, stallMs: 50 } }).answer({ tethers: [], prompt: 'hi', signal: new AbortController().signal }, () => {}).catch((e: unknown) => e))
  assert.ok(plain instanceof CognitionError && plain.code === 'timeout')
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
  const noCloud = await collectChat(json(403, { error: { message: 'ollama cloud is disabled: remote model is unavailable', type: 'api_error' } }))
  assert.ok(noCloud.error instanceof CognitionError && noCloud.error.code === 'model' && noCloud.error.message.startsWith('the local model server runs no cloud models (403'))
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

test('placementOf: Ollama\'s context_length as ctx when it is a whole number from 1 to 2^24; without one the placement is as it was', async () => {
  const at = async (context_length: unknown) => placementOf(fakeFetch(() => json(200, { models: [{ name: 'qwen3-vl:4b', size: 5e9, size_vram: 5e9, context_length }] })).f, DEFAULT_SERVER, 'qwen3-vl:4b')
  assert.deepEqual(await at(8192), { loaded: 5e9, gpu: 5e9, ctx: 8192 })
  assert.deepEqual(await at(1), { loaded: 5e9, gpu: 5e9, ctx: 1 })
  assert.deepEqual(await at(2 ** 24), { loaded: 5e9, gpu: 5e9, ctx: 2 ** 24 })
  for (const odd of [0, -1, 1.5, '8192', 2 ** 24 + 1, 2 ** 53, Number.NaN, Infinity, null, undefined, true]) {
    const p = await at(odd)
    assert.deepEqual(p, { loaded: 5e9, gpu: 5e9 }, String(odd))
    assert.equal(p !== null && 'ctx' in p, false, String(odd))
  }
})

test('generate: a larger context asks for a quarter of it as the answer; anything but a whole number from 8,192 to 32,768 sends today\'s body byte for byte', async () => {
  const body = async (context?: unknown): Promise<string> => {
    const { f, calls } = fakeFetch(() => streamed(SAMPLE))
    await generate(f, { server: DEFAULT_SERVER, model: 'm', system: 'S', prompt: 'P', ...(context !== undefined && { context: context as number }) }, () => {})
    return String(calls[0].init?.body)
  }
  const today = await body()
  assert.equal(today, '{"model":"m","system":"S","prompt":"P","stream":true,"think":false,"options":{"num_ctx":8192,"num_predict":2048}}')
  for (const [ctx, want] of [[16384, [16384, 4096]], [12288, [12288, 3072]], [32768, [32768, 8192]], [8192, [8192, 2048]], [8193, [8193, 2048]]] as const) {
    assert.deepEqual(JSON.parse(await body(ctx)).options, { num_ctx: want[0], num_predict: want[1] }, String(ctx))
  }
  for (const odd of [4096, 8191, 32769, 40000, 16384.5, Number.NaN, Infinity, -16384, '16384', null]) assert.equal(await body(odd), today, String(odd))
  assert.equal(CONTEXT_MAX, 32768)
  assert.equal(contextOf(undefined), CONTEXT_TOKENS)
  assert.equal(contextOf(CONTEXT_MAX), CONTEXT_MAX)
})

test("an answer's context reaches the generate format only: the chat body and an answer without one are as they were", async () => {
  const gen = fakeFetch(() => streamed(SAMPLE))
  await createLocalCompute({ fetch: gen.f }).answer({ tethers: [], prompt: 'hi', signal: new AbortController().signal }, () => {}, 16384)
  assert.deepEqual(JSON.parse(String(gen.calls[0].init?.body)).options, { num_ctx: 16384, num_predict: 4096 })
  // Without one: today's body.
  const plain = fakeFetch(() => streamed(SAMPLE))
  await createLocalCompute({ fetch: plain.f }).answer({ tethers: [], prompt: 'hi', signal: new AbortController().signal }, () => {})
  assert.match(String(plain.calls[0].init?.body), /,"options":\{"num_ctx":8192,"num_predict":2048\}\}$/)
  // The chat format: the body carries today's answer cap and no context.
  const c = fakeFetch(() => streamed(CHAT))
  await createLocalCompute({ fetch: c.f, defaults: { api: 'chat', model: 'm' } }).answer({ tethers: [], prompt: 'hi', signal: new AbortController().signal }, () => {}, 16384)
  const sentChat = JSON.parse(String(c.calls[0].init?.body)) as Record<string, unknown>
  assert.equal(sentChat.max_tokens, ANSWER_TOKENS)
  assert.equal('options' in sentChat, false)
})

// ---------------------------------------------------------------- the chat format's answer cap from the server's own refusal

/**
 * SGLang's refusal, verbatim: raised at
 * https://raw.githubusercontent.com/sgl-project/sglang/main/python/sglang/srt/managers/tokenizer_manager.py:1439-1446
 * (read 2026-11-11), sent before the stream starts as HTTP 400 (python/sglang/srt/entrypoints/openai/serving_chat.py:2368-2374)
 * in the shape of serving_base.py create_error_response (:205-221) and protocol.py ErrorResponse (:141-146). Main
 * refuses a total over the window; v0.5.10 (tokenizer_manager.py:811-835, its 400 from serving_chat.py:604-620) and
 * every release before it refuse one equal to the window too (`>=`).
 */
const sglangRefusal = (window: number, input: number, completion: number) => ({
  object: 'error',
  message: `Requested token count exceeds the model's maximum context length of ${window} tokens. You requested a total of ${input + completion} tokens: ${input} tokens from the input messages and ${completion} tokens for the completion. Please reduce the number of tokens in the input messages or the completion to fit within the limit.`,
  type: 'BadRequestError', param: null, code: 400,
})
/**
 * vLLM's refusal, verbatim: raised at
 * https://raw.githubusercontent.com/vllm-project/vllm/v0.13.0/vllm/entrypoints/openai/serving_engine.py:1027-1034
 * (read 2026-11-11), sent by serving_chat.py:254-256 as f"{e} {e.__cause__}" (so " None" follows), in the shape of
 * serving_engine.py create_error_response (:743-757) and protocol.py ErrorResponse (:123-131), with the status
 * error.code (api_server.py:504-507).
 */
const vllmRefusal = (window: number, input: number, maxTokens: number) => ({
  error: {
    message: `'max_tokens' or 'max_completion_tokens' is too large: ${maxTokens}. This model's maximum context length is ${window} tokens and your request has ${input} input tokens (${maxTokens} > ${window} - ${input}). None`,
    type: 'BadRequestError', param: null, code: 400,
  },
})
/**
 * vLLM's refusal up to 0.10.0, verbatim: raised at
 * https://raw.githubusercontent.com/vllm-project/vllm/v0.10.0/vllm/entrypoints/openai/serving_engine.py:625-632
 * (read 2026-11-11; the same words and check back to v0.5.5), sent by serving_chat.py:201-204 as f"{e} {e.__cause__}"
 * (" None" follows; v0.8.5 and before send str(e)), in the shape of serving_engine.py create_error_response (:409-416)
 * and protocol.py ErrorResponse (:80-85), its message at the top, with the status its code (api_server.py:646-648).
 */
const vllmOldRefusal = (window: number, input: number, maxTokens: number) => ({
  object: 'error',
  message: `This model's maximum context length is ${window} tokens. However, you requested ${input + maxTokens} tokens (${input} in the messages, ${maxTokens} in the completion). Please reduce the length of the messages or completion. None`,
  type: 'BadRequestError', param: null, code: 400,
})
const REFUSALS = [['SGLang', sglangRefusal], ['vLLM to 0.10.0', vllmOldRefusal], ['vLLM', vllmRefusal]] as const
/** The chat body as sent with answer cap `cap`, byte for byte. */
const chatBody = (cap: number): string => `{"model":"mock","messages":[{"role":"system","content":"S"},{"role":"user","content":"P"}],"stream":true,"max_tokens":${cap},"stream_options":{"include_usage":true}}`
/** The text of a whole answer from chatServer. */
const WORDS = Array.from({ length: 20 }, (_, i) => `w${i} `).join('')

/**
 * A chat-format server on a free loopback port that answers its POSTs in turn: a refusal (its status and JSON body,
 * or a string as it is, after afterMs if given), 'answer', twenty words one every 15 ms, or 'silent', nothing at all;
 * one past the list answers. Notes each body as sent and how each request ended.
 */
async function chatServer(replies: readonly ({ status: number; body: unknown; afterMs?: number } | 'answer' | 'silent')[]) {
  const seen: { path: string; body: string; ended: 'complete' | 'client-gone' | 'open' }[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d: Buffer) => { raw += d.toString() })
    req.on('end', () => {
      const entry: (typeof seen)[number] = { path: req.url ?? '', body: raw, ended: 'open' }
      seen.push(entry)
      const reply = replies[seen.length - 1] ?? 'answer'
      if (reply === 'silent') {
        res.on('close', () => { entry.ended = 'client-gone' })
        return
      }
      if (reply !== 'answer') {
        const refuse = (): void => {
          res.writeHead(reply.status, { 'content-type': 'application/json' })
          res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body))
          entry.ended = 'complete'
        }
        if (reply.afterMs === undefined) refuse()
        else setTimeout(refuse, reply.afterMs)
        return
      }
      const events = [...WORDS.trim().split(' ').map((w) => delta({ content: `${w} ` })), delta({}, 'stop'), '[DONE]']
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
  return { url, seen, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }) }
}
/** One chat to `url` as the tests send it: the answer, or what it threw. */
const chatTo = (url: string, signal?: AbortSignal, onPiece: (p: Piece) => void = () => {}): Promise<Answer | unknown> =>
  chat(netFetch, { server: url, model: 'mock', system: 'S', prompt: 'P', ...(signal && { signal }) }, onPiece).catch((e: unknown) => e)

test("chat: refused in SGLang's or vLLM's own words as longer than the window, it asks once more with one token under the window less the prompt as the cap; the body otherwise byte for byte, and a 200 as it was", async () => {
  for (const [name, refusal] of REFUSALS) {
    const srv = await chatServer([{ status: 400, body: refusal(4096, 3000, ANSWER_TOKENS) }, 'answer'])
    try {
      const a = await chatTo(srv.url)
      assert.deepEqual(a, { text: WORDS, thinking: 0, tokens: 0, reason: 'stop' }, name)
      assert.deepEqual(srv.seen.map((r) => [r.path, r.body]), [['/v1/chat/completions', chatBody(ANSWER_TOKENS)], ['/v1/chat/completions', chatBody(1095)]], name)
    } finally {
      await srv.close()
    }
  }
  // An answer the server gives at once: one request, today's body byte for byte.
  const ok = await chatServer(['answer'])
  try {
    assert.deepEqual(await chatTo(ok.url), { text: WORDS, thinking: 0, tokens: 0, reason: 'stop' })
    assert.deepEqual(ok.seen.map((r) => r.body), ['{"model":"mock","messages":[{"role":"system","content":"S"},{"role":"user","content":"P"}],"stream":true,"max_tokens":2048,"stream_options":{"include_usage":true}}'])
  } finally {
    await ok.close()
  }
})

test('chat: the retry cap runs from 2,047 down to one under ANSWER_MIN_TOKENS: 256 tokens of room asks again with 255; 255 is one sentence naming the prompt and the window, and nothing more is sent', async () => {
  // The highest: SGLang up to 0.5.10.post1 refuses 2,048 of room (a total equal to the window), so it asks with 2,047.
  const top = await chatServer([{ status: 400, body: sglangRefusal(4096, 2048, ANSWER_TOKENS) }, 'answer'])
  try {
    assert.equal((await chatTo(top.url) as Answer).text, WORDS)
    assert.deepEqual(top.seen.map((r) => r.body), [chatBody(ANSWER_TOKENS), chatBody(2047)])
  } finally {
    await top.close()
  }
  assert.equal(ANSWER_MIN_TOKENS, 256)
  for (const [name, refusal] of REFUSALS) {
    const at = await chatServer([{ status: 400, body: refusal(4096, 3840, ANSWER_TOKENS) }, 'answer'])
    try {
      assert.equal((await chatTo(at.url) as Answer).text, WORDS, name)
      assert.deepEqual(at.seen.map((r) => r.body), [chatBody(ANSWER_TOKENS), chatBody(255)], name)
    } finally {
      await at.close()
    }
    const under = await chatServer([{ status: 400, body: refusal(4096, 3841, ANSWER_TOKENS) }, 'answer'])
    try {
      const e = await chatTo(under.url)
      assert.ok(e instanceof CognitionError, name)
      assert.deepEqual([e.code, e.message], ['server', "the prompt (3841 tokens) leaves no room for an answer in the model's window of 4096 tokens: ask with fewer people tethered or a shorter question, or start the server with a larger window"], name)
      assert.equal(under.seen.length, 1, name)
    } finally {
      await under.close()
    }
  }
})

test("chat: exactly one retry: a second refusal is the answer, in the words a refusal has always had, whatever room it says is left; a 403 is the server's failure in a 403's words, and any other failure keeps its own code", async () => {
  // No such model (404) is 'model' as ever, which createLocalCompute reads to look the models up again.
  const gone = await chatServer([{ status: 400, body: sglangRefusal(4096, 3000, ANSWER_TOKENS) }, { status: 404, body: { error: { message: 'model not found' } } }])
  try {
    const e = await chatTo(gone.url)
    assert.ok(e instanceof CognitionError)
    assert.deepEqual([e.code, e.message], ['model', "the local model server has no model 'mock': type ask to list the ones it has"])
    assert.equal(gone.seen.length, 2)
  } finally {
    await gone.close()
  }
  // Refused this page (403): 'server', as a retry that cannot reach the server is, so auto looks nowhere after it.
  const forbidden = await chatServer([{ status: 400, body: vllmRefusal(4096, 3000, ANSWER_TOKENS) }, { status: 403, body: {} }])
  try {
    const e = await chatTo(forbidden.url)
    assert.ok(e instanceof CognitionError)
    assert.deepEqual([e.code, e.message], ['server', "the local model server refused this page (403): allow this page's origin in its settings, or open the page from http://localhost"])
    assert.equal(forbidden.seen.length, 2)
  } finally {
    await forbidden.close()
  }
  for (const [name, refusal] of REFUSALS) {
    const second = refusal(4096, 3500, 1095)
    const srv = await chatServer([{ status: 400, body: refusal(4096, 3000, ANSWER_TOKENS) }, { status: 400, body: second }, 'answer'])
    try {
      const e = await chatTo(srv.url)
      assert.ok(e instanceof CognitionError, name)
      // SGLang's shape carries its message at the top, which the sentence has never read; vLLM's is cut as ever.
      const said = 'error' in second ? `: ${sentence(second.error.message)}` : ''
      assert.deepEqual([e.code, e.message], ['server', `the local model server failed (400)${said}`], name)
      assert.deepEqual(srv.seen.map((r) => r.body), [chatBody(ANSWER_TOKENS), chatBody(1095)], name)
    } finally {
      await srv.close()
    }
  }
})

test('chat: a stop during the retry ends it at once and closes its connection; a stop that came with the refusal sends no retry', async () => {
  const srv = await chatServer([{ status: 400, body: vllmRefusal(4096, 3000, ANSWER_TOKENS) }, 'answer'])
  try {
    const c = new AbortController()
    const reason = new DOMException('Spatial tether lost', 'AbortError')
    const pieces: string[] = []
    const e = await within(Promise.resolve(chatTo(srv.url, c.signal, (p) => {
      pieces.push(p.text)
      if (pieces.length === 3) c.abort(reason)
    })))
    assert.equal(e, reason)
    assert.deepEqual(pieces, ['w0 ', 'w1 ', 'w2 '])
    await ended(srv)
    assert.deepEqual(srv.seen.map((r) => [r.body, r.ended]), [[chatBody(ANSWER_TOKENS), 'complete'], [chatBody(1095), 'client-gone']])
  } finally {
    await srv.close()
  }
  const c = new AbortController()
  const reason = new DOMException('Spatial tether lost', 'AbortError')
  const { f, calls } = fakeFetch(() => { c.abort(reason); return json(400, sglangRefusal(4096, 3000, ANSWER_TOKENS)) })
  assert.equal(await chat(f, { server: DEFAULT_SERVER, model: 'm', system: '', prompt: '', signal: c.signal }, () => {}).catch((x: unknown) => x), reason)
  assert.equal(calls.length, 1)
  // A stop that came with any other 400 leaves that 400's sentence as it was.
  const c2 = new AbortController()
  const other = await chat(fakeFetch(() => { c2.abort(reason); return json(400, { error: { message: 'bad request' } }) }).f, { server: DEFAULT_SERVER, model: 'm', system: '', prompt: '', signal: c2.signal }, () => {}).catch((x: unknown) => x)
  assert.ok(other instanceof CognitionError, String(other))
  assert.equal(other.message, 'the local model server failed (400): bad request')
})

test("chat: a retry the server never answers is under the answer's one watch and stop: what is left of the first-piece wait ends it as 'timeout', and a stop ends it, closing its connection either way", async () => {
  // The refusal takes 600 ms of the 1 s first-piece wait: the retry gets the rest, neither a wait of its own (done at
  // 1.6 s at the soonest) nor the 5 s wait of an answer that has begun.
  const quiet = await chatServer([{ status: 400, body: sglangRefusal(4096, 3000, ANSWER_TOKENS), afterMs: 600 }, 'silent'])
  try {
    const t0 = performance.now()
    const e = await within(chat(netFetch, { server: quiet.url, model: 'mock', system: 'S', prompt: 'P', timeouts: { firstMs: 1000, stallMs: 5000 } }, () => {}).catch((x: unknown) => x), 8000)
    const took = performance.now() - t0
    assert.ok(e instanceof CognitionError, String(e))
    assert.deepEqual([e.code, e.message], ['timeout', `the model server at ${quiet.url} sent nothing for 1 s: it may still be loading the model (ask again), or the model is too big for this machine (ask model <name> for a smaller one)`])
    assert.ok(took < 1450, `settled after ${Math.round(took)} ms, not when the answer's first-piece wait ran out`)
    await ended(quiet)
    assert.deepEqual(quiet.seen.map((r) => [r.body, r.ended]), [[chatBody(ANSWER_TOKENS), 'complete'], [chatBody(1095), 'client-gone']])
  } finally {
    await quiet.close()
  }
  const stopped = await chatServer([{ status: 400, body: vllmRefusal(4096, 3000, ANSWER_TOKENS) }, 'silent'])
  try {
    const c = new AbortController()
    const reason = new DOMException('Spatial tether lost', 'AbortError')
    const p = chatTo(stopped.url, c.signal)
    for (let t = 0; t < 2000 && stopped.seen.length < 2; t += 10) await sleep(10)
    c.abort(reason)
    assert.equal(await within(Promise.resolve(p)), reason)
    await ended(stopped)
    assert.deepEqual(stopped.seen.map((r) => [r.body, r.ended]), [[chatBody(ANSWER_TOKENS), 'complete'], [chatBody(1095), 'client-gone']])
  } finally {
    await stopped.close()
  }
})

test("chat: a retry that cannot reach the server is the server's failure, in the words it would have had, so nothing looks again after it", async () => {
  for (const [probe, said] of [['down', `no local model server is answering at ${DEFAULT_SERVER}: start it, or point ask at the right address (ask server <url>)`], ['up', `the local model server at ${DEFAULT_SERVER} is running but refused this page: allow this page's origin in its settings (a page opened from a file sends 'null'), or open the page from http://localhost`]] as const) {
    let posts = 0
    const { f, calls } = fakeFetch((_url, init) => {
      if (init?.mode === 'no-cors') {
        if (probe === 'down') throw new TypeError('Failed to fetch')
        return new Response(null, { status: 200 })
      }
      if (++posts === 1) return json(400, sglangRefusal(4096, 3000, ANSWER_TOKENS))
      throw new TypeError('Failed to fetch')
    })
    const e = await chat(f, { server: DEFAULT_SERVER, model: 'm', system: '', prompt: '' }, () => {}).catch((x: unknown) => x)
    assert.ok(e instanceof CognitionError, probe)
    assert.deepEqual([e.code, e.message], ['server', said], probe)
    assert.deepEqual(calls.map((c) => c.url), [`${DEFAULT_SERVER}/v1/chat/completions`, `${DEFAULT_SERVER}/v1/chat/completions`, `${DEFAULT_SERVER}/api/version`], probe)
  }
})

test('chat: a 400 with any other body, or the same words at another status, at another place or with numbers that would raise the cap, is as it was: one request, one sentence', async () => {
  const s4096 = vllmRefusal(4096, 3000, ANSWER_TOKENS).error.message
  const cases: [string, number, unknown, string][] = [
    // SGLang's other refusal (tokenizer_manager.py:1416-1419 at the same ref): its shape has never been read.
    ['sglang input', 400, { object: 'error', message: "The input (5000 tokens) is longer than the model's context length (4096 tokens).", type: 'BadRequestError', param: null, code: 400 }, ''],
    // vLLM's other refusal (v0.13.0 serving_engine.py:1019-1025).
    ['vllm input', 400, { error: { message: "This model's maximum context length is 4096 tokens. However, your request has 5000 input tokens. Please reduce the length of the input messages. None", type: 'BadRequestError', param: null, code: 400 } },
      ": This model's maximum context length is 4096 tokens. However, your request has 5000 input tokens. Please reduce the length of the input messages. None"],
    ['at 500', 500, vllmRefusal(4096, 3000, ANSWER_TOKENS), `: ${sentence(s4096)}`],
    ['at 422', 422, vllmRefusal(4096, 3000, ANSWER_TOKENS), `: ${sentence(s4096)}`],
    ['sglang at 500', 500, sglangRefusal(4096, 3000, ANSWER_TOKENS), ''],
    ['not at the start', 400, { error: { message: `upstream: ${s4096}` } }, `: ${sentence(`upstream: ${s4096}`)}`],
    ['sglang not at the start', 400, { object: 'error', message: `upstream: ${sglangRefusal(4096, 3000, ANSWER_TOKENS).message}` }, ''],
    ['a string error', 400, { error: s4096 }, `: ${sentence(s4096)}`],
    ['room past the cap', 400, vllmRefusal(100000, 10, ANSWER_TOKENS), `: ${sentence(vllmRefusal(100000, 10, ANSWER_TOKENS).error.message)}`],
    ['a cap of 2,048', 400, sglangRefusal(5049, 3000, ANSWER_TOKENS), ''],
    ['not JSON', 400, 'Bad Request', ''],
    // windowOf reads every 400 of both formats: a null error is no refusal, and no TypeError either.
    ['a null error', 400, { error: null }, ''],
  ]
  for (const [name, status, body, said] of cases) {
    const srv = await chatServer([{ status, body }, 'answer'])
    try {
      const e = await chatTo(srv.url)
      assert.ok(e instanceof CognitionError, name)
      assert.deepEqual([e.code, e.message], ['server', `the local model server failed (${status})${said}`], name)
      assert.equal(srv.seen.length, 1, name)
    } finally {
      await srv.close()
    }
  }
})
