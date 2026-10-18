// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves how long the local model client (localCompute.ts) waits and what it sends when
 * the operator chose nothing. A server that sends nothing is given up after the first-piece wait, and one that goes
 * quiet mid-answer after the stall wait, each as one 'timeout' sentence (over a real socket too, which is then closed),
 * while the operator's own stop keeps its own reason. In the chat format the placeholder model name means the first
 * model the server lists, asked once per server and again after the server says it has no such model (LM Studio,
 * which says which model is loaded: before every answer and at `ask` alone, and a slow answer to that is passed
 * over); a server not running is reported before anything is sent. With nobody bound, the prompt names no person and no expertise. A page
 * that is cross-origin isolated hears that a server refusing its origin looks the same as one not running.
 * What breaks if it is removed? A model too big for the machine could hold `ask` until the operator gives up, and a
 * server that serves several models refuse every answer for a name it does not know.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import type { Piece } from '../07_Execute_Actions/operator.ts'
import { ANY_MODEL, BASE_REALITY, CognitionError, chat, createLocalCompute, FIRST_PIECE_MS, generate, LIST_MS, localText, NO_ONE_BOUND, STALL_MS, systemPrompt, TIMEOUTS, type FetchLike } from './localCompute.ts'

const enc = new TextEncoder()
const ndjson = (...lines: object[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
const sse = (...events: object[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
const SHORT = { firstMs: 60, stallMs: 60 }
const SERVER = 'http://localhost:11434'

/** A request that never answers until its signal aborts (a real connection keeps the process alive meanwhile). */
const never = (init?: RequestInit): Promise<Response> => new Promise((_, reject) => {
  const open = setInterval(() => {}, 1000)
  const signal = init?.signal
  signal?.addEventListener('abort', () => { clearInterval(open); reject(signal.reason) }, { once: true })
})

/** A body that sends `first` and then nothing more until it is cancelled. */
const stalls = (first: string): Response => {
  let open: ReturnType<typeof setInterval> | undefined
  return new Response(new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(first))
      open = setInterval(() => {}, 1000)
    },
    cancel() { clearInterval(open) },
  }), { status: 200 })
}

test('the waits: five minutes for the first piece (a model loading from a slow disk), two once the answer has begun', () => {
  assert.equal(FIRST_PIECE_MS, 300_000)
  assert.equal(STALL_MS, 120_000)
  assert.equal(LIST_MS, 10_000)
  assert.deepEqual(TIMEOUTS, { firstMs: FIRST_PIECE_MS, stallMs: STALL_MS, listMs: LIST_MS })
  assert.ok(Object.isFrozen(TIMEOUTS))
})

test('a server that sends nothing is given up after the first-piece wait, in either format, as one timeout sentence', async () => {
  for (const speak of [generate, chat]) {
    const t0 = performance.now()
    const e = await speak((_u, init) => never(init), { server: SERVER, model: 'm', system: '', prompt: 'hi', timeouts: SHORT }, () => {}).then(() => null, (x: unknown) => x)
    assert.ok(e instanceof CognitionError, String(e))
    assert.equal(e.code, 'timeout')
    assert.equal(e.message, `the model server at ${SERVER} sent nothing for 0 s: it may still be loading the model (ask again), or the model is too big for this machine (ask model <name> for a smaller one)`)
    assert.ok(performance.now() - t0 < 3000)
  }
})

test('the real waits read in minutes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = generate((_u, init) => never(init), { server: SERVER, model: 'm', system: '', prompt: 'hi' }, () => {}).then(() => null, (x: unknown) => x)
  t.mock.timers.tick(FIRST_PIECE_MS)
  assert.match(String(((await first) as Error).message), /sent nothing for 5 minutes:/)
  const quiet = generate(async () => stalls(ndjson({ response: 'part', done: false })), { server: SERVER, model: 'm', system: '', prompt: 'hi' }, () => {}).then(() => null, (x: unknown) => x)
  for (let k = 0; k < 5; k++) await new Promise((r) => setImmediate(r))
  t.mock.timers.tick(STALL_MS)
  assert.match(String(((await quiet) as Error).message), /went quiet for 2 minutes in the middle/)
})

test('a server that goes quiet mid-answer is given up after the stall wait; what arrived before still arrived', async () => {
  const pieces: string[] = []
  const e = await generate(async () => stalls(ndjson({ response: 'part', done: false })), { server: SERVER, model: 'm', system: '', prompt: 'hi', timeouts: SHORT }, (p: Piece) => { pieces.push(p.text) }).then(() => null, (x: unknown) => x)
  assert.ok(e instanceof CognitionError)
  assert.equal(e.code, 'timeout')
  assert.match(e.message, /^the model server at http:\/\/localhost:11434 went quiet for 0 s in the middle of the answer$/)
  assert.deepEqual(pieces, ['part'])
  // The chat format too, with a first-piece wait long enough that only the stall wait can end it.
  const cp: string[] = []
  const c = await chat(async () => stalls(sse({ choices: [{ delta: { content: 'part' } }] })), { server: SERVER, model: 'm', system: '', prompt: 'hi', timeouts: { firstMs: 60_000, stallMs: 60 } }, (p: Piece) => { cp.push(p.text) }).then(() => null, (x: unknown) => x)
  assert.ok(c instanceof CognitionError && c.code === 'timeout')
  assert.match(c.message, /^the model server at http:\/\/localhost:11434 went quiet for 0 s in the middle of the answer$/)
  assert.deepEqual(cp, ['part'])
})

test('a steady answer slower than the first-piece wait in total is not cut: the stall wait starts again with every line', async () => {
  const lines = Array.from({ length: 6 }, (_, i) => ndjson({ response: `w${i} `, done: false }))
  let i = 0
  let timer: ReturnType<typeof setInterval> | undefined
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      timer = setInterval(() => {
        if (i < lines.length) c.enqueue(enc.encode(lines[i++]))
        else { clearInterval(timer); c.enqueue(enc.encode(ndjson({ done: true, done_reason: 'stop', eval_count: 6 }))); c.close() }
      }, 30)
    },
    cancel() { clearInterval(timer) },
  })
  const a = await generate(async () => new Response(body, { status: 200 }), { server: SERVER, model: 'm', system: '', prompt: 'hi', timeouts: { firstMs: 100, stallMs: 100 } }, () => {})
  assert.equal(a.text, 'w0 w1 w2 w3 w4 w5 ')
})

test('the operator\'s stop keeps its own reason, and a finished answer leaves no timer behind', async () => {
  const ctl = new AbortController()
  const asked = generate((_u, init) => never(init), { server: SERVER, model: 'm', system: '', prompt: 'hi', signal: ctl.signal, timeouts: { firstMs: 60_000, stallMs: 60_000 } }, () => {})
  ctl.abort(new Error('stopped by the operator'))
  await assert.rejects(asked, /^Error: stopped by the operator$/)
  // Finished well inside a long wait: the process is not held open by a timer (the test would not end).
  const a = await generate(async () => new Response(ndjson({ response: 'ok', done: true, done_reason: 'stop', eval_count: 1 }), { status: 200 }), { server: SERVER, model: 'm', system: '', prompt: 'hi', timeouts: { firstMs: 600_000, stallMs: 600_000 } }, () => {})
  assert.equal(a.text, 'ok')
})

test('over a real socket: a server that sends its headers and then nothing is given the first-piece wait, then given up, and the connection is closed', async () => {
  let closed = false
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.flushHeaders() })
    res.on('close', () => { closed = true })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    // A short stall wait and a longer first-piece wait: headers alone do not start the stall wait (a server may send
    // them at once and only then load the model and read the prompt).
    const m = createLocalCompute({ fetch: (u, init) => fetch(u, init), timeouts: { firstMs: 400, stallMs: 50 } })
    m.setServer(url)
    const t0 = performance.now()
    const e = await m.answer({ tethers: [], prompt: 'hi', signal: new AbortController().signal }, () => {}).then(() => null, (x: unknown) => x)
    assert.ok(e instanceof CognitionError && e.code === 'timeout', String(e))
    assert.match(e.message, /sent nothing for 0 s: it may still be loading the model/)
    assert.ok(performance.now() - t0 >= 350, 'the whole first-piece wait, not the stall wait')
    for (let t = 0; t < 2000 && !closed; t += 20) await new Promise((r) => setTimeout(r, 20))
    assert.equal(closed, true, 'the server saw the client go')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('the chat format with no model chosen sends the first model the server lists that writes text, asked once per server and again after it says no such model', async () => {
  const calls: { url: string; model?: string }[] = []
  let models = ['all-minilm-l6-v2', 'b-model', 'a-model']
  let missing = false
  const f: FetchLike = async (url, init) => {
    // Not LM Studio: its own list of loaded models is not found here (see the LM Studio test below).
    if (url.endsWith('/api/v0/models')) return new Response('Not Found', { status: 404 })
    const body = init?.body ? (JSON.parse(String(init.body)) as { model: string }) : null
    calls.push({ url, ...(body && { model: body.model }) })
    if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), { status: 200 })
    if (missing) return new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 })
    return new Response(sse({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n', { status: 200 })
  }
  const m = createLocalCompute({ fetch: f, defaults: { server: 'http://localhost:1234', model: ANY_MODEL, api: 'chat' } })
  const q = () => ({ tethers: [], prompt: 'hi', signal: new AbortController().signal })
  await m.answer(q(), () => {})
  await m.answer(q(), () => {})
  assert.deepEqual(calls, [
    { url: 'http://localhost:1234/v1/models' },
    { url: 'http://localhost:1234/v1/chat/completions', model: 'b-model' },
    { url: 'http://localhost:1234/v1/chat/completions', model: 'b-model' },
  ], 'in the server\'s own order, past the embedding model, and asked once')
  assert.equal(m.settings().resolved, 'b-model', 'the settings name the model the placeholder stood for')
  // The model went away: the server says so, and the next answer asks again.
  missing = true
  await assert.rejects(m.answer(q(), () => {}), (e: unknown) => e instanceof CognitionError && e.code === 'model')
  missing = false
  models = ['c-model']
  calls.length = 0
  await m.answer(q(), () => {})
  assert.deepEqual(calls.map((c) => c.model ?? c.url), ['http://localhost:1234/v1/models', 'c-model'])
  // A new server is asked for its own list.
  m.setServer('http://localhost:1235')
  calls.length = 0
  await m.answer(q(), () => {})
  assert.deepEqual(calls.map((c) => c.url), ['http://localhost:1235/v1/models', 'http://localhost:1235/v1/chat/completions'])
  // A name the operator chose is sent as it is, with no list asked for.
  m.setModel('mine')
  calls.length = 0
  await m.answer(q(), () => {})
  assert.deepEqual(calls, [{ url: 'http://localhost:1235/v1/chat/completions', model: 'mine' }])
})

test('the chat format with no model chosen: a server that is not running is reported before anything is sent; one that lists nothing gets the placeholder', async () => {
  const sent: string[] = []
  const down: FetchLike = async (url) => { sent.push(url); throw new TypeError('Failed to fetch') }
  const m = createLocalCompute({ fetch: down, defaults: { server: 'http://localhost:8080', model: ANY_MODEL, api: 'chat' } })
  await assert.rejects(m.answer({ tethers: [], prompt: 'hi', signal: new AbortController().signal }, () => {}), (e: unknown) => e instanceof CognitionError && e.code === 'offline')
  assert.ok(sent.every((u) => !u.endsWith('/v1/chat/completions')), sent.join(', '))

  const bodies: string[] = []
  const empty: FetchLike = async (url, init) => {
    if (url.endsWith('/api/v0/models')) return new Response('Not Found', { status: 404 })
    if (url.endsWith('/v1/models')) return new Response('not json', { status: 200 })
    bodies.push(String(init?.body))
    return new Response(sse({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }), { status: 200 })
  }
  const e = createLocalCompute({ fetch: empty, defaults: { server: 'http://localhost:8080', model: ANY_MODEL, api: 'chat' } })
  assert.equal((await e.answer({ tethers: [], prompt: 'hi', signal: new AbortController().signal }, () => {})).text, 'hi')
  assert.equal((JSON.parse(bodies[0]) as { model: string }).model, ANY_MODEL, 'llama.cpp serves its one model whatever the name')
})

test('with nobody bound the prompt names no person and no expertise: the guide speaks, and the expertise rule is lifted', () => {
  assert.equal(systemPrompt([]), `${BASE_REALITY}\n${NO_ONE_BOUND}`)
  assert.doesNotMatch(systemPrompt([]), /You are answering for/)
  assert.doesNotMatch(systemPrompt([]), /Your expertise is exactly/)
  assert.doesNotMatch(systemPrompt([{ agent: 1, serial: 1, skills: ['Rust'] }]), new RegExp(NO_ONE_BOUND))
})

test('on a cross-origin isolated page, a server that cannot be reached may be refusing the origin, and the sentence says so', async () => {
  const g = globalThis as { crossOriginIsolated?: boolean }
  const was = g.crossOriginIsolated
  const down: FetchLike = async () => { throw new TypeError('Failed to fetch') }
  try {
    g.crossOriginIsolated = true
    const e = await generate(down, { server: SERVER, model: 'm', system: '', prompt: 'hi' }, () => {}).then(() => null, (x: unknown) => x)
    assert.ok(e instanceof CognitionError && e.code === 'offline')
    assert.match(e.message, /; if it is running, it may be refusing this page's origin, which looks the same from here \(Ollama: add this page's origin to OLLAMA_ORIGINS\)$/)
    g.crossOriginIsolated = false
    const plain = await generate(down, { server: SERVER, model: 'm', system: '', prompt: 'hi' }, () => {}).then(() => null, (x: unknown) => x)
    assert.doesNotMatch((plain as Error).message, /OLLAMA_ORIGINS/)
  } finally {
    if (was === undefined) delete g.crossOriginIsolated
    else g.crossOriginIsolated = was
  }
})

test('a model is judged by its own name: a llama.cpp server lists a file path, and the folders on it decide nothing', () => {
  assert.equal(localText('/home/bgeorge/models/qwen2.5-7b-instruct-q4_k_m.gguf'), true)
  assert.equal(localText('C:\\Users\\bgerber\\embeddings\\llama-3.2-3b.gguf'), true)
  assert.equal(localText('/opt/embedded-ai/qwen.gguf'), true)
  assert.equal(localText('/models/nomic-embed-text-v1.5.Q4_K_M.gguf'), false)
  assert.equal(localText('bge-m3'), false)
  assert.equal(localText('gpt-oss:120b-cloud'), false)
  assert.equal(localText('kimi-k3:cloud'), false)
  assert.equal(localText('qwen3:4b'), true)
  // Sentence-embedding models whose names say nothing of embedding (Ollama's library has the first).
  for (const name of ['paraphrase-multilingual:latest', 'multilingual-e5-large', 'e5-mistral-7b-instruct', 'gte-large', 'Alibaba-NLP/gte-Qwen2-7B-instruct']) assert.equal(localText(name), false, name)
  for (const name of ['gemma3n:e4b', 'gemma3n:e2b', 'qwen2.5-7b-instruct-q5_k_m.gguf', 'magtech-7b', 'phi4-mini']) assert.equal(localText(name), true, name)
})

test('LM Studio says which model is loaded: that one is sent, not the first it has downloaded, and asked again at every answer; any other server is asked its usual list', async () => {
  const urls: string[] = []
  const sent: string[] = []
  const studio = (v0: () => Response | null): FetchLike => async (url, init) => {
    urls.push(url)
    if (url.endsWith('/api/v0/models')) return v0() ?? new Response('Not Found', { status: 404 })
    if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'gemma-3-27b' }, { id: 'qwen3-8b' }] }), { status: 200 })
    sent.push((JSON.parse(String(init?.body)) as { model: string }).model)
    return new Response(sse({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n', { status: 200 })
  }
  const q = () => ({ tethers: [], prompt: 'hi', signal: new AbortController().signal })
  const v0 = (...data: object[]) => new Response(JSON.stringify({ object: 'list', data }), { status: 200 })
  let loaded = 'qwen3-8b'
  let answering = true
  const lm = createLocalCompute({ fetch: studio(() => answering ? v0(
    { id: 'text-embedding-nomic-embed-text-v1.5', type: 'embeddings', state: 'loaded' },
    { id: 'gemma-3-27b', type: 'vlm', state: loaded === 'gemma-3-27b' ? 'loaded' : 'not-loaded' },
    { id: 'qwen3-8b', type: 'llm', state: loaded === 'qwen3-8b' ? 'loaded' : 'not-loaded' },
  ) : null), defaults: { server: 'http://localhost:1234', model: ANY_MODEL, api: 'chat' } })
  await lm.answer(q(), () => {})
  assert.equal(lm.settings().resolved, 'qwen3-8b')
  // The operator ejects it and loads another in LM Studio: `ask` alone names that one, and the next answer sends it,
  // not the old one (which LM Studio would load again beside it rather than refuse).
  loaded = 'gemma-3-27b'
  await lm.installed()
  assert.equal(lm.settings().resolved, 'gemma-3-27b')
  await lm.answer(q(), () => {})
  assert.deepEqual(sent, ['qwen3-8b', 'gemma-3-27b'])
  assert.equal(urls.filter((u) => u.endsWith('/api/v0/models')).length, 3, 'asked at every answer and at ask alone')
  // Its own list stops answering: the model last seen loaded is still sent.
  answering = false
  await lm.answer(q(), () => {})
  assert.deepEqual(sent, ['qwen3-8b', 'gemma-3-27b', 'gemma-3-27b'])
  assert.equal(urls.filter((u) => u.endsWith('/v1/models')).length, 1, "ask alone's own list only")
  // Nothing loaded: the first that writes text, by kind (the embedding model is passed over by its type).
  sent.length = 0
  const idle = createLocalCompute({ fetch: studio(() => v0({ id: 'text-embedding-x', type: 'embeddings', state: 'not-loaded' }, { id: 'gemma-3-27b', type: 'vlm', state: 'not-loaded' })), defaults: { server: 'http://localhost:1234', model: ANY_MODEL, api: 'chat' } })
  await idle.answer(q(), () => {})
  assert.deepEqual(sent, ['gemma-3-27b'])
  // Not LM Studio (a 404, or a body without the states): the OpenAI-compatible list, in the server's order, asked once.
  for (const other of [() => null, () => v0({ id: 'qwen3-8b' })]) {
    sent.length = 0
    urls.length = 0
    const s = createLocalCompute({ fetch: studio(other), defaults: { server: 'http://localhost:8080', model: ANY_MODEL, api: 'chat' } })
    await s.answer(q(), () => {})
    await s.answer(q(), () => {})
    assert.deepEqual(sent, ['gemma-3-27b', 'gemma-3-27b'])
    assert.equal(urls.filter((u) => u.endsWith('/v1/models')).length, 1)
    assert.equal(urls.filter((u) => u.endsWith('/api/v0/models')).length, 1)
  }
})

test('a server slow to give LM Studio\'s list is asked its usual one; only the operator\'s stop ends the answer there', async () => {
  const sent: string[] = []
  const slow: FetchLike = async (url, init) => {
    if (url.endsWith('/api/v0/models')) return never(init)
    if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen3-8b' }] }), { status: 200 })
    sent.push((JSON.parse(String(init?.body)) as { model: string }).model)
    return new Response(sse({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n', { status: 200 })
  }
  const s = createLocalCompute({ fetch: slow, defaults: { server: 'http://localhost:1234', model: ANY_MODEL, api: 'chat' }, timeouts: { ...SHORT, listMs: 50 } })
  const a = await s.answer({ tethers: [], prompt: 'hi', signal: new AbortController().signal }, () => {})
  assert.equal(a.text, 'hi')
  assert.deepEqual(sent, ['qwen3-8b'])
  // LM Studio busy at the first answer (its list late, the usual one sent the first model it has downloaded) and
  // answering at the next: then the model it has loaded is sent.
  let late = true
  const busy: string[] = []
  const studio: FetchLike = async (url, init) => {
    if (url.endsWith('/api/v0/models')) {
      if (late) return never(init)
      return new Response(JSON.stringify({ data: [{ id: 'gemma-3-27b', type: 'vlm', state: 'not-loaded' }, { id: 'qwen3-8b', type: 'llm', state: 'loaded' }] }), { status: 200 })
    }
    if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'gemma-3-27b' }, { id: 'qwen3-8b' }] }), { status: 200 })
    busy.push((JSON.parse(String(init?.body)) as { model: string }).model)
    return new Response(sse({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n', { status: 200 })
  }
  const lm = createLocalCompute({ fetch: studio, defaults: { server: 'http://localhost:1234', model: ANY_MODEL, api: 'chat' }, timeouts: { ...SHORT, listMs: 50 } })
  const q = () => ({ tethers: [], prompt: 'hi', signal: new AbortController().signal })
  await lm.answer(q(), () => {})
  late = false
  await lm.answer(q(), () => {})
  assert.deepEqual(busy, ['gemma-3-27b', 'qwen3-8b'])
  // A server that is late with that list twice is taken for one that is not LM Studio: no answer waits on it again.
  let asked = 0
  const proxy: FetchLike = async (url, init) => {
    if (url.endsWith('/api/v0/models')) { asked++; return never(init) }
    return slow(url, init)
  }
  const p = createLocalCompute({ fetch: proxy, defaults: { server: 'http://localhost:1234', model: ANY_MODEL, api: 'chat' }, timeouts: { ...SHORT, listMs: 50 } })
  for (let i = 0; i < 4; i++) await p.answer(q(), () => {})
  assert.equal(asked, 2)
  // The usual list late too: the placeholder is sent, and the server says itself what it makes of it.
  const placeholder: string[] = []
  const silent = createLocalCompute({ fetch: async (url, init) => {
    if (url.endsWith('/models')) return never(init)
    placeholder.push((JSON.parse(String(init?.body)) as { model: string }).model)
    return new Response(sse({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n', { status: 200 })
  }, defaults: { server: 'http://localhost:8080', model: ANY_MODEL, api: 'chat' }, timeouts: { ...SHORT, listMs: 50 } })
  await silent.answer(q(), () => {})
  assert.deepEqual(placeholder, [ANY_MODEL])
  // The operator stops while that list is asked: the stop's own reason, not a list's.
  const before = sent.length
  const halt = new AbortController()
  const stopped = createLocalCompute({ fetch: slow, defaults: { server: 'http://localhost:1234', model: ANY_MODEL, api: 'chat' }, timeouts: { ...SHORT, listMs: 60_000 } })
  const pending = stopped.answer({ tethers: [], prompt: 'hi', signal: halt.signal }, () => {})
  halt.abort(new Error('the operator stopped it'))
  await assert.rejects(pending, /the operator stopped it/)
  assert.equal(sent.length, before, 'nothing sent')
})
