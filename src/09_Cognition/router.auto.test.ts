// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the router's auto provider (router.ts), the default: at an ask it finds the
 * first model server answering on this machine in AUTO_ORDER (Ollama, llama.cpp, an OpenAI-compatible server such as
 * LM Studio, then a model file kept in this page, then the Claude gateway) and answers with it; it asks the newer
 * default addresses with them (llama-server's 9931, vLLM's 8000, SGLang's 30000), never past an address the operator
 * set that is not one of the known ones, and uses them only when none answers at its own address, keeping the one
 * found as that provider's; it passes over a
 * server that is down, hangs, refuses this page or has no model that writes text, and says why; it gives an Ollama
 * without the default model the first text model it has; it looks again when the one it found stops answering, but
 * never once its answer has begun; the page's own model is only listed by a look (never answered or loaded), named
 * only when a file is kept, found only when one is chosen, and never taken for a server refusing the page; and with
 * nothing answering it fails the way the script stands in for, so the operator hears canned words labelled as such.
 * What breaks if it is removed? A fresh machine with a model server running could still get only the script, or an
 * answer from a server the operator never meant to use.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { operatorBridge, type Answer, type AnswerRequest, type Diary, type GateHandle, type GateLease, type Mind, type Piece, type SimControls, type SkillGate } from '../07_Execute_Actions/operator.ts'
import type { TerminalBridge } from '../07_Execute_Actions/terminal/bridge.ts'
import { run as shell } from '../07_Execute_Actions/terminal/commands.ts'
import { CognitionError, DEFAULT_MODEL, DEFAULT_SERVER, type FetchLike } from './localCompute.ts'
import { AUTO_ORDER, createMindRouter, INPAGE_SERVER, KNOWN_SERVERS, LLAMACPP_SERVER, OPENAI_SERVER, PROVIDER_TEXT, VLLM_SERVER } from './router.ts'
import { SCRIPTED, withScriptedFallback } from './scripted.ts'

const enc = new TextEncoder()
const stream = (text: string, type: string): Response => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(text)); c.close() } }), { status: 200, headers: { 'content-type': type } })
const ndjson = (...lines: object[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
const sse = (...events: object[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')

/**
 * How a server on one port behaves: not listening, listening but refusing this page's origin, never answering, a web
 * server that is no model server (every path 404, any origin allowed), or answering with these models.
 */
type Server = 'down' | 'refuses' | 'hangs' | 'web' | readonly string[]

/** A machine of model servers by port (11434 Ollama, 8080 llama.cpp, 1234 LM Studio, 8089 the Claude gateway), noting every request. */
function machine(servers: Record<string, Server>) {
  const calls: { url: string; body: { model?: string } | null }[] = []
  const f: FetchLike = async (url, init) => {
    const port = new URL(url).port
    const s = servers[port] ?? 'down'
    if (init?.mode === 'no-cors') {
      // The browser's opaque probe reaches a server whatever its origin rules: it fails only if nothing listens.
      if (s === 'down') throw new TypeError('Failed to fetch')
      return new Response(null, { status: 200 })
    }
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (s === 'down' || s === 'refuses') throw new TypeError('Failed to fetch')
    if (s === 'hangs') {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal
        if (signal?.aborted) return reject(signal.reason)
        // An open connection keeps the process alive, as a real socket would (AbortSignal.timeout's own timer does not).
        const open = setInterval(() => {}, 1000)
        signal?.addEventListener('abort', () => { clearInterval(open); reject(signal.reason) }, { once: true })
      })
    }
    if (s === 'web') return new Response('Not Found', { status: 404 })
    const said = `${port} says hi`
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: s.map((name) => ({ name })) }), { status: 200 })
    if (url.endsWith('/v1/models') || url.includes('/v1/models?')) return new Response(JSON.stringify({ data: s.map((id) => ({ id })) }), { status: 200 })
    if (url.endsWith('/api/generate')) return stream(ndjson({ response: said, done: false }, { done: true, done_reason: 'stop', eval_count: 3 }), 'application/x-ndjson')
    if (url.endsWith('/v1/chat/completions')) return stream(sse({ choices: [{ delta: { content: said } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n', 'text/event-stream')
    if (url.endsWith('/v1/messages')) return stream(sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: said } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' }), 'text/event-stream')
    return new Response('?', { status: 404 })
  }
  return { f, calls, servers }
}

/**
 * The model file kept in this page, as the host's in-page mind (inPage.ts) presents it: `kept` is the file kept (null:
 * none), `why` the reason this browser cannot run it (absent: it can). It notes every call, a load included (the
 * look must never make one), and answers with `fail` when one is set.
 */
function page(kept: string | null, why?: string) {
  const calls: string[] = []
  const state: { fail: Error | null } = { fail: null }
  const mind: Mind & { load(): Promise<string> } = {
    settings: () => ({ server: INPAGE_SERVER, model: kept, runtime: why ?? 'this browser runs it (one thread)', storage: kept === null ? 'none' : 'kept in this page' }),
    setServer: () => { throw new Error('no server') },
    setModel: (name: string) => name,
    installed: async () => {
      calls.push('installed')
      if (why !== undefined) throw new CognitionError('offline', why)
      return kept === null ? [] : [kept]
    },
    answer: async (_req: AnswerRequest, onPiece: (p: Piece) => void): Promise<Answer> => {
      calls.push('answer')
      if (state.fail) throw state.fail
      onPiece({ kind: 'text', text: 'inpage says hi' })
      return { text: 'inpage says hi', thinking: 0, tokens: 3, reason: 'stop' }
    },
    load: async () => { calls.push('load'); return 'loaded' },
  }
  return { factory: () => mind, calls, state }
}

const req = (signal = new AbortController().signal): AnswerRequest => ({ tethers: [{ agent: 7, serial: 1, skills: ['Rust'] }], prompt: 'hi', signal })
const ask = async (r: { answer(q: AnswerRequest, on: (p: Piece) => void): Promise<{ text: string }> }, q = req()): Promise<string> => (await r.answer(q, () => {})).text

test('auto looks in AUTO_ORDER: the servers on this machine at once, the first in that order that answers with a model wins, and it is kept', async () => {
  assert.deepEqual([...AUTO_ORDER], ['ollama', 'llamacpp', 'openai', 'inpage', 'claude'])
  const m = machine({ 11434: [DEFAULT_MODEL], 8080: ['local.gguf'], 1234: ['lm-model'], 8089: ['claude-opus-5-5'] })
  const r = createMindRouter({ fetch: m.f })
  assert.equal(await ask(r), '11434 says hi')
  const s = r.settings()
  assert.equal(s.provider, 'auto', 'auto stays the choice; what it found is said beside it')
  assert.equal(s.found, 'ollama')
  assert.equal(s.auto, `ollama at ${DEFAULT_SERVER}, found answering on this machine (ask provider ollama keeps it)`)
  assert.equal(s.server, DEFAULT_SERVER)
  assert.equal(s.key, undefined, 'no key row while a local model answers')
  // The look asked the three lists on this machine, with the second round's three newer default addresses (called off
  // once Ollama answered), not the gateway's (which asks the Claude API); the next ask goes straight to the one found.
  assert.deepEqual(m.calls.map((c) => c.url), [`${DEFAULT_SERVER}/api/tags`, `${LLAMACPP_SERVER}/v1/models`, `${OPENAI_SERVER}/v1/models`,
    'http://localhost:9931/v1/models', `${VLLM_SERVER}/v1/models`, 'http://localhost:30000/v1/models', `${DEFAULT_SERVER}/api/generate`])
  m.calls.length = 0
  assert.equal(await ask(r), '11434 says hi')
  assert.deepEqual(m.calls.map((c) => c.url), [`${DEFAULT_SERVER}/api/generate`])

  // Only llama.cpp: found, and the model it lists is sent (it refuses no name, but LM Studio would).
  const only = machine({ 8080: ['local.gguf'] })
  const l = createMindRouter({ fetch: only.f })
  assert.equal(await ask(l), '8080 says hi')
  assert.equal(l.settings().found, 'llamacpp')
  assert.equal(only.calls.find((c) => c.url.endsWith('/v1/chat/completions'))?.body?.model, 'local.gguf')

  // Only LM Studio's port, which always lists its embedding model too: the same, in the chat format, and the prompt
  // goes to the model that writes text.
  const studio = machine({ 1234: ['text-embedding-nomic-embed-text-v1.5', 'zai-org/glm-4.6v-flash'] })
  const lm = createMindRouter({ fetch: studio.f })
  assert.equal(await ask(lm), '1234 says hi')
  assert.equal(lm.settings().found, 'openai')
  assert.equal(lm.settings().server, OPENAI_SERVER)
  assert.equal(studio.calls.find((c) => c.url.endsWith('/v1/chat/completions'))?.body?.model, 'zai-org/glm-4.6v-flash')

  // Only the Claude gateway: asked only once the servers on this machine have all said no, at their own addresses and
  // at the newer default ones asked with them (llama-server's 9931, vLLM's 8000, SGLang's 30000), found last, and its
  // key and effort rows come back.
  const lone = machine({ 8089: ['claude-opus-5-5'] })
  const gw = createMindRouter({ fetch: lone.f })
  assert.equal(await ask(gw), '8089 says hi')
  assert.equal(gw.settings().found, 'claude')
  assert.equal(gw.settings().key, null)
  assert.deepEqual(lone.calls.map((c) => new URL(c.url).port), ['11434', '8080', '1234', '9931', '8000', '30000', '8089', '8089'])
})

test('an Ollama without the default model is given the first model it has that writes text; a chosen model is left alone', async () => {
  const m = machine({ 11434: ['all-minilm', 'gemma3:1b', 'nomic-embed-text'] })
  const r = createMindRouter({ fetch: m.f })
  assert.equal(await ask(r), '11434 says hi')
  assert.equal(r.settings().model, 'gemma3:1b', 'not an embedding model')
  assert.equal(m.calls.find((c) => c.url.endsWith('/api/generate'))?.body?.model, 'gemma3:1b')

  // The operator chose a model: auto does not second-guess it (the server says itself if it lacks it).
  const chosen = createMindRouter({ fetch: machine({ 11434: ['gemma3:1b'] }).f })
  chosen.setProvider('ollama')
  chosen.setModel('llama3.2')
  chosen.setProvider('auto')
  await ask(chosen)
  assert.equal(chosen.settings().model, 'llama3.2')
})

test('the model auto chose is kept between visits as auto\'s own: chosen again when it goes, left alone once the operator chooses one', async () => {
  let json: string | null = null
  const store = { load: () => json, save: (v: string) => { json = v } }
  const m = machine({ 11434: ['llama3.2:3b'] })
  const first = createMindRouter({ fetch: m.f, store })
  await ask(first)
  assert.equal(first.settings().model, 'llama3.2:3b')
  // Next visit: that model was removed and another pulled. Auto chooses again rather than asking for the old one.
  m.servers[11434] = ['gemma3:4b']
  m.calls.length = 0
  const second = createMindRouter({ fetch: m.f, store })
  assert.equal(await ask(second), '11434 says hi')
  assert.equal(m.calls.find((c) => c.url.endsWith('/api/generate'))?.body?.model, 'gemma3:4b')
  const sent = (): string | undefined => m.calls.find((c) => c.url.endsWith('/api/generate'))?.body?.model
  // Auto's own pick stays while the server lists it, even once it has the default too...
  m.servers[11434] = ['gemma3:4b', DEFAULT_MODEL]
  m.calls.length = 0
  await ask(createMindRouter({ fetch: m.f, store }))
  assert.equal(sent(), 'gemma3:4b')
  // ...and when it goes, the default is preferred to the first other model.
  m.servers[11434] = ['aya:8b', DEFAULT_MODEL]
  m.calls.length = 0
  await ask(createMindRouter({ fetch: m.f, store }))
  assert.equal(sent(), DEFAULT_MODEL)
  const picked = (): unknown => (JSON.parse(json ?? '{}') as { picked?: unknown }).picked
  assert.equal(picked(), DEFAULT_MODEL, "still auto's own")
  // The operator chooses one (under auto, it goes to the Ollama found), even the very one auto had chosen: from then
  // on it is theirs, kept when the server no longer lists it.
  m.servers[11434] = ['gemma3:4b']
  const chooser = createMindRouter({ fetch: m.f, store })
  await ask(chooser)
  assert.equal(picked(), 'gemma3:4b')
  chooser.setModel('gemma3:4b')
  assert.equal(picked(), null, "kept as the operator's")
  m.servers[11434] = ['aya:8b']
  m.calls.length = 0
  await ask(createMindRouter({ fetch: m.f, store }))
  assert.equal(sent(), 'gemma3:4b', 'sent as chosen, though the server lists only aya:8b')
  chooser.setModel('qwen3:8b')
  const third = createMindRouter({ fetch: m.f, store })
  m.calls.length = 0
  await ask(third)
  assert.equal(sent(), 'qwen3:8b')
  assert.equal(third.settings().model, 'qwen3:8b')
  // Choosing the default by name is a choice too: kept while the operator pulls it, never swapped for another.
  third.setProvider('ollama')
  third.setModel(DEFAULT_MODEL)
  third.setProvider('auto')
  assert.equal(picked(), null)
  m.servers[11434] = ['gemma3:1b']
  m.calls.length = 0
  await ask(createMindRouter({ fetch: m.f, store }))
  assert.equal(sent(), DEFAULT_MODEL)
})

test("a model the operator chose before auto ever chose one is theirs, the default by name included", async () => {
  for (const name of ['qwen3-vl:2b', DEFAULT_MODEL]) {
    let json: string | null = null
    const store = { load: () => json, save: (v: string) => { json = v } }
    const m = machine({ 11434: ['gemma3:1b'] })
    const r = createMindRouter({ fetch: m.f, store })
    r.setProvider('ollama')
    r.setModel(name)
    r.setProvider('auto')
    await ask(createMindRouter({ fetch: m.f, store }))
    assert.equal(m.calls.find((c) => c.url.endsWith('/api/generate'))?.body?.model, name, 'sent as chosen, though the server lists only gemma3:1b')
  }
})

test('on a cross-origin isolated page, nothing seen running may be a server refusing the origin, and auto\'s sentence says so', async () => {
  const g = globalThis as { crossOriginIsolated?: boolean }
  const was = g.crossOriginIsolated
  // On an isolated page the opaque probe cannot reach a server that sends no resource policy: refusing looks like down.
  const isolated: FetchLike = async () => { throw new TypeError('Failed to fetch') }
  try {
    g.crossOriginIsolated = true
    await assert.rejects(ask(createMindRouter({ fetch: isolated, lookMs: 50 })), /\(looked for .*\); one that is running may be refusing this page's origin, which looks the same from here \(Ollama: add this page's origin to OLLAMA_ORIGINS; vLLM 0\.32 and later: start it with --allowed-origins naming that origin\): start one/)
    // Every server at its own address answers with no text model: Ollama's fix is not named, only vLLM's, since
    // nothing answered at vLLM's address; and once vLLM answers there (with no text model either), neither is.
    const running = { 11434: ['nomic-embed-text'], 8080: ['nomic-embed-text-v1.5.Q4_K_M.gguf'], 1234: ['text-embedding-nomic-embed-text-v1.5'] }
    await assert.rejects(ask(createMindRouter({ fetch: machine(running).f, lookMs: 50 })),
      /has no model that writes text on this machine; one that is running may be refusing this page's origin, which looks the same from here \(vLLM 0\.32 and later: start it with --allowed-origins naming that origin\): start one/)
    await assert.rejects(ask(createMindRouter({ fetch: machine({ ...running, 8000: ['BAAI/bge-m3-embedding'] }).f, lookMs: 50 })), (e: unknown) => !/refusing this page's origin/.test((e as Error).message))
    // vLLM at the OpenAI-compatible provider's own address (kept from an earlier visit): its flag is named too.
    const v = createMindRouter({ fetch: isolated, lookMs: 50 })
    v.connect!('openai', VLLM_SERVER)
    v.setProvider('auto')
    await assert.rejects(ask(v), /openai at http:\/\/localhost:8000 \(also :1234 and :30000\).*\(Ollama: add this page's origin to OLLAMA_ORIGINS; vLLM 0\.32 and later: start it with --allowed-origins naming that origin\): start one/)
    // Beside another server's reason too (an embedding model under llama.cpp), not instead of it.
    await assert.rejects(ask(createMindRouter({ fetch: machine({ 8080: ['nomic-embed-text-v1.5.Q4_K_M.gguf'] }).f, lookMs: 50 })),
      /; the llamacpp server at http:\/\/localhost:8080 is running but has no model that writes text on this machine; one that is running may be refusing this page's origin/)
    g.crossOriginIsolated = false
    await assert.rejects(ask(createMindRouter({ fetch: isolated, lookMs: 50 })), (e: unknown) => !/OLLAMA_ORIGINS/.test((e as Error).message))
  } finally {
    if (was === undefined) delete g.crossOriginIsolated
    else g.crossOriginIsolated = was
  }
})

test('passed over and said why: a server that is down, hangs past the look, refuses this page, or has only models that write no text', async () => {
  // Down, hanging and refusing ahead of a working one: the working one answers, inside the look's short wait.
  const m = machine({ 11434: 'hangs', 8080: 'refuses', 1234: ['lm-model'] })
  const r = createMindRouter({ fetch: m.f, lookMs: 50 })
  const t0 = performance.now()
  assert.equal(await ask(r), '1234 says hi')
  assert.ok(performance.now() - t0 < 5000, 'a hanging server holds the look only for lookMs')
  assert.equal(r.settings().found, 'openai')

  // Nothing usable: one 'offline' sentence naming where it looked, and every reason worth fixing, in the order looked.
  const none = createMindRouter({ fetch: machine({ 11434: ['nomic-embed-text', 'gpt-oss:120b-cloud'], 8080: 'refuses', 1234: 'hangs' }).f, lookMs: 50 })
  await assert.rejects(ask(none), (e: unknown) => {
    assert.ok(e instanceof CognitionError)
    assert.equal(e.code, 'offline')
    assert.equal(e.message, `no model is answering on this machine (looked for ollama at ${DEFAULT_SERVER}, llamacpp at ${LLAMACPP_SERVER} (also :9931), openai at ${OPENAI_SERVER} (also :8000 and :30000), claude at http://localhost:8089)`
      + `; the ollama server at ${DEFAULT_SERVER} is running but has no model that writes text on this machine (ollama pull qwen3-vl:4b)`
      + `; the local model server at ${LLAMACPP_SERVER} is running but refused this page: allow this page's origin in its settings (a page opened from a file sends 'null'), or open the page from http://localhost`
      + `; the openai server at ${OPENAI_SERVER} did not list its models within 0.05 s (busy, or the browser is asking whether this page may reach it: allow it, then ask again)`
      + ': start one, or choose one with ask provider <name>')
    return true
  })
  assert.match(none.settings().auto!, /^nothing found yet: the next ask looks on this machine; the ollama server .* has no model that writes text on this machine/)
  assert.equal(none.settings().found, undefined)
  // A second look says the same: each look names only the addresses it asked.
  const again = async (): Promise<string> => { try { await ask(none) } catch (e) { return (e as Error).message } return 'answered' }
  assert.equal(await again(), await again())
})

test('Ollama\'s cloud models are never chosen for you: a prompt to one would leave the machine', async () => {
  const m = machine({ 11434: ['deepseek-v3.1:671b-cloud', 'kimi-k3:cloud', 'llama3.2:3b'] })
  const r = createMindRouter({ fetch: m.f })
  await ask(r)
  assert.equal(m.calls.find((c) => c.url.endsWith('/api/generate'))?.body?.model, 'llama3.2:3b')
  // The same in the chat format (Ollama's own /v1/models lists them too).
  const chat = machine({ 1234: ['gpt-oss:120b-cloud', 'qwen3:4b'] })
  const c = createMindRouter({ fetch: chat.f })
  await ask(c)
  assert.equal(chat.calls.find((x) => x.url.endsWith('/v1/chat/completions'))?.body?.model, 'qwen3:4b')
})

test('Ollama\'s own list marks its cloud models, whatever they are called: those are never chosen for you either', async () => {
  const sent: string[] = []
  const tags = [
    { name: 'gemini-3-pro-preview:latest', remote_model: 'gemini-3-pro-preview', remote_host: 'https://ollama.com:443' },
    { name: 'my-assistant:latest', remote_model: 'qwen3-coder:480b' },
    { name: 'llama3.2:3b', remote_host: '' },
  ]
  const f: FetchLike = async (url, init) => {
    if (!url.startsWith(DEFAULT_SERVER)) throw new TypeError('Failed to fetch')
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: tags }), { status: 200 })
    sent.push((JSON.parse(String(init?.body)) as { model: string }).model)
    return stream(ndjson({ response: 'hi', done: false }, { done: true, done_reason: 'stop', eval_count: 1 }), 'application/x-ndjson')
  }
  const r = createMindRouter({ fetch: f, lookMs: 50 })
  await ask(r)
  assert.deepEqual(sent, ['llama3.2:3b'])
  // `ask` alone still lists them all: one can be chosen by name.
  r.setProvider('ollama')
  assert.deepEqual(await r.installed(), ['gemini-3-pro-preview:latest', 'llama3.2:3b', 'my-assistant:latest'])
  // Only cloud models: none for auto, and it says so.
  tags.pop()
  await assert.rejects(ask(createMindRouter({ fetch: f, lookMs: 50 })), /the ollama server at http:\/\/localhost:11434 is running but has no model that writes text on this machine/)
})

test('a server whose list fails is said to be running, not told to start', async () => {
  const f: FetchLike = async (url) => {
    const port = new URL(url).port
    if (port === '8080') return new Response('boom', { status: 500 })
    if (port === '8089') return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), { status: 529 })
    if (port === '1234') return new Response('<html>a web page</html>', { status: 200 })
    throw new TypeError('Failed to fetch')
  }
  await assert.rejects(ask(createMindRouter({ fetch: f, lookMs: 50 })), (e: unknown) => {
    const said = (e as Error).message
    assert.match(said, /; the llamacpp server at http:\/\/localhost:8080 is running but did not give its list of models \(the local model server failed \(500\)/)
    assert.match(said, /; the openai server at http:\/\/localhost:1234 is running but did not give its list of models \(the local model server's list of models could not be read\)/)
    assert.match(said, /; the claude server at http:\/\/localhost:8089 is running but did not give its list of models \(the Claude API is overloaded \(529\)/)
    return true
  })
})

test('with nothing answering the script stands in, says why, and the next ask looks again and finds a server started since', async () => {
  const m = machine({})
  const r = withScriptedFallback(createMindRouter({ fetch: m.f, lookMs: 50 }))
  const a = await r.answer(req(), () => {})
  assert.equal(a.reason, SCRIPTED)
  assert.match(a.standIn ?? '', /^no model is answering on this machine/)
  m.servers[8080] = ['local.gguf']
  const b = await r.answer(req(), () => {})
  assert.equal(b.text, '8080 says hi')
  assert.equal(b.standIn, undefined)
  assert.equal(r.settings().found, 'llamacpp')
})

test('the one found stops answering: one more look before any of the answer, and whatever answers now; never once the answer has begun', async () => {
  const m = machine({ 11434: [DEFAULT_MODEL], 8080: ['local.gguf'] })
  const r = createMindRouter({ fetch: m.f, lookMs: 50 })
  assert.equal(await ask(r), '11434 says hi')
  m.servers[11434] = 'down'
  assert.equal(await ask(r), '8080 says hi', 'Ollama went away: llama.cpp answers this very ask')
  assert.equal(r.settings().found, 'llamacpp')

  // The answer had begun when the server failed, even as 'offline': that failure is the answer's, and no other server
  // is asked (llama.cpp is up and would answer). The router has found Ollama already, so only that guard stops a look.
  let n = 0
  let failing = false
  const midway: FetchLike = async (url, init) => {
    if (url.endsWith('/api/generate') && failing) {
      n++
      let sent = false
      return new Response(new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent) return c.error(new CognitionError('offline', 'connection reset'))
          sent = true
          c.enqueue(enc.encode(ndjson({ response: 'half', done: false })))
        },
      }), { status: 200 })
    }
    return m.f(url, init)
  }
  m.servers[11434] = [DEFAULT_MODEL]
  const begun = createMindRouter({ fetch: midway, lookMs: 50 })
  assert.equal(await ask(begun), '11434 says hi')
  failing = true
  m.calls.length = 0
  const pieces: string[] = []
  await assert.rejects(begun.answer(req(), (p) => { pieces.push(p.text) }), /connection reset/)
  assert.deepEqual(pieces, ['half'], 'not half an answer from one server and a whole one from another')
  assert.equal(n, 1)
  assert.deepEqual(m.calls.map((c) => c.url), [], 'no list was asked for')
  assert.equal(begun.settings().found, 'ollama')

  // The operator stopped it while the server it found was answering, with a reason a look would act on: no look.
  const hanging = machine({ 11434: [DEFAULT_MODEL], 8080: ['local.gguf'] })
  const stopped = createMindRouter({ fetch: hanging.f, lookMs: 50 })
  await ask(stopped)
  hanging.servers[11434] = 'hangs'
  hanging.calls.length = 0
  const ctl = new AbortController()
  const asked = stopped.answer(req(ctl.signal), () => {})
  await new Promise((r) => setTimeout(r, 10))
  ctl.abort(new CognitionError('offline', 'stopped by the operator'))
  await assert.rejects(asked, /stopped by the operator/)
  assert.deepEqual(hanging.calls.map((c) => c.url), [`${DEFAULT_SERVER}/api/generate`], 'no list was asked for')
  assert.equal(stopped.settings().found, 'ollama')
})

test('ask alone under auto looks again and lists what the one found has; settings go to the one found, and auto takes no server or key', async () => {
  const m = machine({ 8080: ['local.gguf'] })
  const r = createMindRouter({ fetch: m.f, lookMs: 50 })
  assert.throws(() => r.setServer('http://localhost:9000'), /auto has not found a model on this machine yet: type ask to look/)
  assert.deepEqual(await r.installed(), ['local.gguf'])
  assert.equal(r.settings().found, 'llamacpp')
  m.servers[11434] = ['gemma3:1b']
  assert.deepEqual(await r.installed(), ['gemma3:1b'], 'a server started since is found by the next look')
  assert.equal(r.setModel('gemma3:4b'), 'gemma3:4b')
  r.setProvider('ollama')
  assert.equal(r.settings().model, 'gemma3:4b', 'the setting went to the provider auto found')
  assert.equal(r.connect!('auto'), PROVIDER_TEXT.auto)
  assert.equal(r.provider, 'auto')
  assert.throws(() => r.connect!('auto', 'http://localhost:1'), /auto takes no server and no key/)
  assert.throws(() => r.connect!('auto', '', 'sk-ant-x'), /auto takes no server and no key/)
})

test('a model file kept in this page is found after the servers on this machine and before the gateway, which is then not asked; it never stands ahead of a server', async () => {
  const m = machine({ 8089: ['claude-opus-5-5'] })
  const p = page('tiny.gguf')
  const r = createMindRouter({ fetch: m.f, lookMs: 50, inPage: p.factory })
  assert.equal(await ask(r), 'inpage says hi')
  const s = r.settings()
  assert.equal(s.found, 'inpage')
  assert.equal(s.auto, 'inpage: the model file kept in this page, found ready to run on this device (ask provider inpage keeps it)')
  assert.deepEqual([s.server, s.model, s.runtime, s.storage, s.key], [INPAGE_SERVER, 'tiny.gguf', 'this browser runs it (one thread)', 'kept in this page', undefined])
  assert.deepEqual(m.calls.map((c) => new URL(c.url).port), ['11434', '8080', '1234', '9931', '8000', '30000'], 'the servers on this machine were asked, at their own addresses and then the newer default ones; the gateway never was')
  assert.deepEqual(p.calls, ['installed', 'answer'])
  // The next ask goes straight to it: no list is asked of anyone.
  m.calls.length = 0
  assert.equal(await ask(r), 'inpage says hi')
  assert.deepEqual([m.calls, p.calls], [[], ['installed', 'answer', 'answer']])
  // A server earlier in the order answers: it wins, and the page's own model is not even listed.
  m.servers[8080] = ['local.gguf']
  const q = page('tiny.gguf')
  const l = createMindRouter({ fetch: m.f, lookMs: 50, inPage: q.factory })
  assert.equal(await ask(l), '8080 says hi')
  assert.deepEqual(q.calls, [])
})

test('a look only lists the model file kept in this page: it never answers with it and never loads it', async () => {
  const m = machine({})
  const p = page('tiny.gguf')
  const r = createMindRouter({ fetch: m.f, lookMs: 50, inPage: p.factory })
  // `ask` alone looks again and lists what the one found has: the file kept.
  assert.deepEqual(await r.installed(), ['tiny.gguf'])
  assert.deepEqual(await r.installed(), ['tiny.gguf'])
  assert.deepEqual(p.calls, ['installed', 'installed', 'installed', 'installed'], 'listed by each look and each list; never answered, never loaded')
  assert.ok(m.calls.every((c) => new URL(c.url).port !== '8089'), 'the gateway was never asked')
  // A look that finds nothing (the file cannot run here) asks it nothing more either.
  const q = page('tiny.gguf', 'a load failed earlier in this visit: ask file load tries again')
  await assert.rejects(ask(createMindRouter({ fetch: m.f, lookMs: 50, inPage: q.factory })), /; inpage: a load failed earlier in this visit: ask file load tries again: start one/)
  assert.deepEqual(q.calls, ['installed'])
})

test('a model file kept in this page that this browser cannot run is passed over with its reason, and never taken for a server refusing the page', async () => {
  const g = globalThis as { crossOriginIsolated?: boolean }
  const was = g.crossOriginIsolated
  try {
    g.crossOriginIsolated = true
    // Every server answers, with nothing that writes text, vLLM's address among them, and the gateway is down: nothing
    // but the page's own model could have raised the hint about a server refusing this page's origin (nothing listening
    // on 9931 and 30000 is the second round's usual case, and goes unsaid).
    const m = machine({ 11434: ['nomic-embed-text'], 8080: ['nomic-embed-text-v1.5.Q4_K_M.gguf'], 1234: ['text-embedding-nomic-embed-text-v1.5'], 8000: ['BAAI/bge-m3-embedding'] })
    const why = 'this browser cannot run a model in this page (no JSPI): the script answers instead'
    const p = page('tiny.gguf', why)
    await assert.rejects(ask(createMindRouter({ fetch: m.f, lookMs: 50, inPage: p.factory })), (e: unknown) => {
      assert.ok(e instanceof CognitionError)
      assert.equal(e.code, 'offline')
      assert.equal(e.message, `no model is answering on this machine (looked for ollama at ${DEFAULT_SERVER}, llamacpp at ${LLAMACPP_SERVER} (also :9931), openai at ${OPENAI_SERVER} (also :8000 and :30000), the model file kept in this page, claude at http://localhost:8089)`
        + `; the ollama server at ${DEFAULT_SERVER} is running but has no model that writes text on this machine (ollama pull qwen3-vl:4b)`
        + `; the llamacpp server at ${LLAMACPP_SERVER} is running but has no model that writes text on this machine`
        + `; the openai server at ${OPENAI_SERVER} is running but has no model that writes text on this machine`
        + `; the openai server at ${VLLM_SERVER} is running but has no model that writes text on this machine`
        + `; inpage: ${why}`
        + ': start one, or choose one with ask provider <name>')
      return true
    })
    assert.deepEqual(p.calls, ['installed'], 'listed, never answered or loaded')
    // With no file kept, the same refusal goes unsaid: the sentence reads as it would with no model in the page at all.
    const none = page(null, why)
    const plain = page(null)
    const said = async (f: ReturnType<typeof page>): Promise<string> => {
      try {
        await ask(createMindRouter({ fetch: m.f, lookMs: 50, inPage: f.factory }))
      } catch (e) {
        return (e as Error).message
      }
      return 'answered'
    }
    const quiet = await said(none)
    assert.equal(quiet, await said(plain))
    assert.doesNotMatch(quiet, /inpage|this page/)
  } finally {
    if (was === undefined) delete g.crossOriginIsolated
    else g.crossOriginIsolated = was
  }
})

test('the model in this page failing to load or run is that answer\'s failure: no second look, so no second load', async () => {
  const m = machine({})
  const p = page('tiny.gguf')
  const r = createMindRouter({ fetch: m.f, lookMs: 50, inPage: p.factory })
  assert.equal(await ask(r), 'inpage says hi')
  p.state.fail = new CognitionError('model', 'the model file could not be loaded: not a GGUF file')
  m.calls.length = 0
  await assert.rejects(ask(r), /not a GGUF file/)
  assert.deepEqual(p.calls, ['installed', 'answer', 'answer'], 'listed once, at the first look')
  assert.deepEqual(m.calls, [], 'no list was asked of any server')
  assert.equal(r.settings().found, 'inpage')
})

test('a provider the operator chose is never looked past: nothing else is asked when it is down', async () => {
  const m = machine({ 8080: ['local.gguf'] })
  const r = createMindRouter({ fetch: m.f })
  r.setProvider('ollama')
  await assert.rejects(ask(r), (e: unknown) => e instanceof CognitionError && e.code === 'offline')
  assert.ok(m.calls.every((c) => c.url.startsWith(DEFAULT_SERVER)), m.calls.map((c) => c.url).join(', '))
})

/** A gateway with one Active tether that authorizes everything asked of it. */
function gate(): SkillGate {
  return {
    submit<T>(_requires: readonly string[], task: (lease: GateLease) => T | PromiseLike<T>): GateHandle<T> {
      const lease: GateLease = { bound: [{ agent: 7, serial: 1, skills: ['Rust'] }], signal: new AbortController().signal, held: true, use: <R,>(act: () => R) => act() }
      const verdict = Promise.resolve().then(() => task(lease)).then(
        (value) => ({ state: 'Authorized' as const, outcome: { ok: true as const, value } }),
        (error: unknown) => ({ state: 'Authorized' as const, outcome: { ok: false as const, error } }),
      )
      return { state: 'Authorized', lease, verdict } as GateHandle<T>
    },
  }
}

test('from the console: the script standing in is said under its words and not remembered; ask alone says what auto found', async () => {
  const m = machine({})
  const notes: string[] = []
  const diary: Diary = { recall: () => [], note: (_b, kind, _s, text) => { notes.push(`${kind}: ${text}`) } }
  const op = operatorBridge({} as SimControls, gate(), withScriptedFallback(createMindRouter({ fetch: m.f, lookMs: 50 })), undefined, { diary, contained: () => true })
  const b = { operator: op } as unknown as TerminalBridge
  shell('operator unlock', b, [])
  const canned = await shell('ask rust: hi', b, []).pending
  assert.match(canned?.[0]?.text ?? '', /^You ask about "hi"/)
  assert.equal(canned?.[1]?.kind, 'err')
  assert.match(canned?.[1]?.text ?? '', /^ask: no model answered, so the script spoke instead: no model is answering on this machine \(looked for ollama at /)
  assert.deepEqual(notes, [], 'the script\'s words are not remembered as something a person said')
  const before = await shell('ask', b, []).pending
  assert.deepEqual(before?.slice(0, 2), [
    { kind: 'out', text: 'provider  auto: the first model that answers on this machine, kept until it stops answering; ask alone looks again (ask provider ollama|llamacpp|openai|claude to choose one)' },
    { kind: 'out', text: 'found     nothing found yet: the next ask looks on this machine' },
  ])
  assert.match(before?.at(-1)?.text ?? '', /^ask: no model is answering on this machine/)
  m.servers[8080] = ['local.gguf']
  const status = await shell('ask', b, []).pending
  assert.deepEqual(status?.slice(0, 4), [
    { kind: 'out', text: 'provider  auto: the first model that answers on this machine, kept until it stops answering; ask alone looks again (ask provider ollama|llamacpp|openai|claude to choose one)' },
    { kind: 'out', text: `found     llamacpp at ${LLAMACPP_SERVER}, found answering on this machine (ask provider llamacpp keeps it)` },
    { kind: 'out', text: `server    ${LLAMACPP_SERVER}  (this machine only)` },
    { kind: 'out', text: 'model     default: the model the server has loaded, else the first it lists that writes text, asked at the next answer (ask model <name> to choose)' },
  ])
  assert.deepEqual(status?.at(-1), { kind: 'out', text: 'installed local.gguf' })
  const real = await shell('ask rust: hi', b, []).pending
  assert.deepEqual(real?.[0], { kind: 'out', text: '8080 says hi' })
  assert.match(real?.[1]?.text ?? '', /^-- answered in \d+\.\d s --$/)
  assert.deepEqual(notes, ['ask: hi → 8080 says hi'])
  // After an answer, the row names the model that answered, and the list marks it, though it sorts last.
  m.servers[8080] = ['local.gguf', 'all-minilm-l6']
  const after = await shell('ask', b, []).pending
  assert.deepEqual(after?.find((l) => l.text.startsWith('model')), { kind: 'out', text: 'model     local.gguf  (the model the server has loaded, else the first it lists that writes text; ask model <name> to choose)' })
  assert.deepEqual(after?.slice(-2), [{ kind: 'out', text: 'installed all-minilm-l6' }, { kind: 'out', text: '          local.gguf  (chosen)' }])
})

test('model files kept in this page with none chosen: auto passes them over with how to choose one, and the console never sends the operator to keep another', async () => {
  const m = machine({})
  const calls: string[] = []
  let model: string | null = null
  const mind: Mind = {
    settings: () => ({ server: INPAGE_SERVER, model, runtime: 'this browser runs it (one thread)', storage: 'kept in this page' }),
    setServer: () => { throw new Error('no server') },
    setModel: (name: string) => (model = name),
    installed: async () => { calls.push('installed'); return ['small.gguf', 'tiny.gguf'] },
    answer: async (_q: AnswerRequest, onPiece: (p: Piece) => void): Promise<Answer> => {
      calls.push(`answer ${model}`)
      onPiece({ kind: 'text', text: 'inpage says hi' })
      return { text: 'inpage says hi', thinking: 0, tokens: 3, reason: 'stop' }
    },
  }
  const r = createMindRouter({ fetch: m.f, lookMs: 50, inPage: () => mind })
  // auto never runs a file nobody chose: the look says how to choose one, and the page's model is named in it.
  await assert.rejects(ask(r), (e: unknown) => {
    assert.ok(e instanceof CognitionError)
    assert.equal(e.code, 'offline')
    assert.match(e.message, /\(looked for ollama at .*, openai at http:\/\/localhost:1234 \(also :8000 and :30000\), the model file kept in this page, claude at http:\/\/localhost:8089\)/)
    assert.match(e.message, /; inpage: 2 model files are kept in this page but none is chosen \(ask provider inpage, then ask model <name>\): start one/)
    return true
  })
  assert.deepEqual(calls, ['installed'], 'listed, never answered')
  assert.equal(r.settings().found, undefined)
  // From the console, as the note says: the rows and the refusal both point at the files kept, not at keeping another.
  const op = operatorBridge({} as SimControls, gate(), r, undefined, { contained: () => true })
  const b = { operator: op } as unknown as TerminalBridge
  shell('operator unlock', b, [])
  shell('ask provider inpage', b, [])
  const rows = (await shell('ask', b, []).pending)?.map((l) => l.text) ?? []
  assert.equal(rows.find((t) => t.startsWith('model')), 'model     none chosen: ask model <name>')
  assert.deepEqual(rows.slice(-3), ['installed small.gguf', '          tiny.gguf', 'choose one of the files kept: ask model <name>'])
  assert.deepEqual(shell('ask rust: hi', b, []).lines, [{ kind: 'err', text: 'ask: choose a model first: Menu › Model file, or ask file (or ask model <name> for a file already kept: type ask to list them)' }])
  shell('ask model tiny.gguf', b, [])
  assert.deepEqual((await shell('ask rust: hi', b, []).pending)?.[0], { kind: 'out', text: 'inpage says hi' })
  // Chosen, it is what auto finds.
  shell('ask provider auto', b, [])
  assert.equal(await ask(r), 'inpage says hi')
  assert.equal(r.settings().found, 'inpage')
  assert.deepEqual(calls.filter((c) => c.startsWith('answer')), ['answer tiny.gguf', 'answer tiny.gguf'])
})

// The second round: the newer default addresses (router.ts KNOWN_SERVERS), asked only when the servers at their own
// addresses gave nothing usable, and never on a phone.
const port = (url: string): string => new URL(url).port
const LISTS = /\/v1\/models$|\/api\/tags$/

test('a llama-server built since b11521, alone on 9931: found in the second round and kept as the llama.cpp address; the next visit asks it first, and one back on 8080 is found there', async () => {
  let json: string | null = null
  const store = { load: () => json, save: (v: string) => { json = v } }
  const m = machine({ 9931: ['local.gguf'] })
  const r = createMindRouter({ fetch: m.f, store, lookMs: 50 })
  assert.equal(await ask(r), '9931 says hi')
  const s = r.settings()
  assert.deepEqual([s.provider, s.found, s.server], ['auto', 'llamacpp', 'http://localhost:9931'])
  assert.equal(s.auto, 'llamacpp at http://localhost:9931, found answering on this machine (ask provider llamacpp keeps it)')
  // The first round at the three addresses at once, then the second at the three newer ones at once, then the answer.
  assert.deepEqual(m.calls.filter((c) => LISTS.test(c.url)).slice(0, 6).map((c) => port(c.url)), ['11434', '8080', '1234', '9931', '8000', '30000'])
  assert.equal(m.calls.find((c) => c.url.endsWith('/v1/chat/completions'))?.url, 'http://localhost:9931/v1/chat/completions')
  assert.equal(m.calls.find((c) => c.url.endsWith('/v1/chat/completions'))?.body?.model, 'local.gguf')
  // The next ask goes straight to it.
  m.calls.length = 0
  assert.equal(await ask(r), '9931 says hi')
  assert.ok(m.calls.every((c) => port(c.url) === '9931'), m.calls.map((c) => c.url).join(', '))

  // The next visit: llama.cpp's address is 9931 now, asked in the first round and found there; the second round asks
  // its old default instead (the last list is the one the answer reads to name the model the server has).
  m.calls.length = 0
  const next = createMindRouter({ fetch: m.f, store, lookMs: 50 })
  assert.equal(await ask(next), '9931 says hi')
  assert.deepEqual(m.calls.filter((c) => LISTS.test(c.url)).map((c) => port(c.url)), ['11434', '9931', '1234', '8080', '8000', '30000', '9931'])
  assert.equal(next.settings().server, 'http://localhost:9931')

  // Started again with --port 8080: 9931 says nothing, and the second round finds it at its old default, kept again.
  m.servers[9931] = 'down'
  m.servers[8080] = ['local.gguf']
  m.calls.length = 0
  const back = createMindRouter({ fetch: m.f, store, lookMs: 50 })
  assert.equal(await ask(back), '8080 says hi')
  assert.equal(back.settings().server, LLAMACPP_SERVER)
  assert.deepEqual(m.calls.filter((c) => LISTS.test(c.url)).slice(0, 6).map((c) => port(c.url)), ['11434', '9931', '1234', '8080', '8000', '30000'])
  assert.equal(JSON.parse(JSON.parse(json ?? '{}').llamacpp).server, LLAMACPP_SERVER)
})

test('vLLM on 8000 and SGLang on 30000 are found as the OpenAI-compatible provider, in that order, after a llama-server on 9931', async () => {
  assert.deepEqual(KNOWN_SERVERS, { llamacpp: [LLAMACPP_SERVER, 'http://localhost:9931'], openai: [OPENAI_SERVER, VLLM_SERVER, 'http://localhost:30000'] })
  const found = async (servers: Record<string, Server>): Promise<[string, unknown, unknown, string | undefined]> => {
    const m = machine(servers)
    const r = createMindRouter({ fetch: m.f, lookMs: 50 })
    const said = await ask(r)
    return [said, r.settings().found, r.settings().server, m.calls.find((c) => c.url.endsWith('/v1/chat/completions'))?.body?.model]
  }
  assert.deepEqual(await found({ 8000: ['Qwen/Qwen3-32B'] }), ['8000 says hi', 'openai', VLLM_SERVER, 'Qwen/Qwen3-32B'])
  assert.deepEqual(await found({ 30000: ['meta-llama/Llama-3.3-70B-Instruct'] }), ['30000 says hi', 'openai', 'http://localhost:30000', 'meta-llama/Llama-3.3-70B-Instruct'])
  assert.deepEqual(await found({ 8000: ['vllm-model'], 30000: ['sglang-model'] }), ['8000 says hi', 'openai', VLLM_SERVER, 'vllm-model'])
  assert.deepEqual(await found({ 9931: ['local.gguf'], 8000: ['vllm-model'] }), ['9931 says hi', 'llamacpp', 'http://localhost:9931', 'local.gguf'])
  // An embedding model alone there is passed over, as in the first round.
  assert.deepEqual(await found({ 8000: ['BAAI/bge-m3-embedding'], 30000: ['sglang-model'] }), ['30000 says hi', 'openai', 'http://localhost:30000', 'sglang-model'])
})

test('the second round is read only when the first found nothing usable: a server that answers wins; one with no text model does not stop it', async () => {
  // LM Studio answers at its own address, and a llama-server on 9931 too: LM Studio wins, and llama.cpp is not moved.
  const up = machine({ 1234: ['lm-model'], 9931: ['local.gguf'] })
  const u = createMindRouter({ fetch: up.f, lookMs: 50 })
  assert.equal(await ask(u), '1234 says hi')
  u.setProvider('llamacpp')
  assert.equal(u.settings().server, LLAMACPP_SERVER)
  // llama.cpp on 8080 has only an embedding model: nothing usable, so 9931 answers.
  const embed = machine({ 8080: ['nomic-embed-text-v1.5.Q4_K_M.gguf'], 9931: ['local.gguf'] })
  const r = createMindRouter({ fetch: embed.f, lookMs: 50 })
  assert.equal(await ask(r), '9931 says hi')
  assert.equal(r.settings().server, 'http://localhost:9931')
})

/** Waits until every one of `ports` has been asked (at most 2 s, then fails with what was asked). */
async function askedAll(m: ReturnType<typeof machine>, ports: readonly string[]): Promise<void> {
  const all = (): boolean => ports.every((p) => m.calls.some((c) => port(c.url) === p))
  for (let i = 0; i < 2000 && !all(); i++) await new Promise((r) => setTimeout(r, 1))
  assert.ok(all(), `asked ${m.calls.map((c) => port(c.url)).join(', ')}, not all of ${ports.join(', ')}`)
}

test('the second round goes out with the first, so it adds no wait: all six addresses are asked while every one still hangs', async () => {
  const m = machine({ 11434: 'hangs', 8080: 'hangs', 1234: 'hangs', 9931: 'hangs', 8000: 'hangs', 30000: 'hangs' })
  const r = createMindRouter({ fetch: m.f, lookMs: 60_000 })
  const ctl = new AbortController()
  const asked = ask(r, req(ctl.signal))
  try {
    await askedAll(m, ['11434', '8080', '1234', '9931', '8000', '30000'])
  } finally {
    ctl.abort(new Error('stopped by the operator'))
    await assert.rejects(asked, /stopped by the operator/)
  }
})

test('two looks at once (an answer and ask alone) both find the llama-server on 9931: the later one neither misses it nor takes the gateway', async () => {
  // Ollama holds both looks' first round open, so both are under way when the first one moves llama.cpp to 9931.
  const m = machine({ 11434: 'hangs', 9931: ['local.gguf'], 8089: ['claude-opus-5-5'] })
  const r = createMindRouter({ fetch: m.f, lookMs: 100 })
  const [said, listed] = await Promise.all([ask(r), r.installed()])
  assert.equal(said, '9931 says hi')
  assert.deepEqual(listed, ['local.gguf'])
  assert.deepEqual([r.settings().found, r.settings().server], ['llamacpp', 'http://localhost:9931'])
  assert.ok(m.calls.every((c) => port(c.url) !== '8089'), 'the gateway was never asked')
})

test('an address set while a look runs is left as it is: the look finds that provider there and does not move it', async () => {
  const m = machine({ 11434: 'hangs', 30000: ['sglang-model'] })
  const r = createMindRouter({ fetch: m.f, lookMs: 100 })
  const asked = ask(r).catch((e: unknown) => e)
  await askedAll(m, ['30000'])
  // The operator points the OpenAI-compatible provider elsewhere before the look reads its second round.
  r.connect!('openai', 'http://localhost:9000')
  r.setProvider('auto')
  await asked
  r.setProvider('openai')
  assert.equal(r.settings().server, 'http://localhost:9000')
})

test('an address the operator set is theirs: a provider at any other address is never asked elsewhere, and a model kept for it that a server lacks keeps it from moving there', async () => {
  // The OpenAI-compatible provider at 9000: only llama.cpp, still at its default, gets a second round.
  const m = machine({ 8000: ['vllm-model'], 30000: ['sglang-model'] })
  const r = createMindRouter({ fetch: m.f, lookMs: 50 })
  r.connect!('openai', 'http://localhost:9000')
  r.setProvider('auto')
  await assert.rejects(ask(r), /\(looked for ollama at http:\/\/localhost:11434, llamacpp at http:\/\/localhost:8080 \(also :9931\), openai at http:\/\/localhost:9000, claude at http:\/\/localhost:8089\)/)
  assert.ok(m.calls.every((c) => !['8000', '30000'].includes(port(c.url))), m.calls.map((c) => c.url).join(', '))

  // A model kept for the OpenAI-compatible provider (chosen for LM Studio): vLLM on 8000 lacks it, so it stays at 1234
  // and the sentence says how to move it; SGLang on 30000 lists it, so it moves there with the model kept.
  const kept = machine({ 8000: ['vllm-model'] })
  const k = createMindRouter({ fetch: kept.f, lookMs: 50 })
  k.setProvider('openai')
  k.setModel('lm-model')
  k.setProvider('auto')
  await assert.rejects(ask(k), /; the openai server at http:\/\/localhost:8000 is running but does not list lm-model, the model kept for openai \(ask connect openai http:\/\/localhost:8000, then ask model <name>\): start one/)
  k.setProvider('openai')
  assert.equal(k.settings().server, OPENAI_SERVER)
  kept.servers[30000] = ['sglang-model', 'lm-model']
  k.setProvider('auto')
  assert.equal(await ask(k), '30000 says hi')
  assert.deepEqual([k.settings().server, k.settings().model], ['http://localhost:30000', 'lm-model'])
  assert.equal(kept.calls.find((c) => c.url.endsWith('/v1/chat/completions'))?.body?.model, 'lm-model')
})

test('the second round says only what is worth fixing: a server there with no text model, or refusing this page (vLLM\'s flag named on 8000); nothing listening, a hang, or a web server that is no model server goes unsaid', async () => {
  const said = async (servers: Record<string, Server>): Promise<string> => {
    try {
      await ask(createMindRouter({ fetch: machine(servers).f, lookMs: 50 }))
    } catch (e) {
      return (e as Error).message
    }
    return 'answered'
  }
  const where = `(looked for ollama at ${DEFAULT_SERVER}, llamacpp at ${LLAMACPP_SERVER} (also :9931), openai at ${OPENAI_SERVER} (also :8000 and :30000), claude at http://localhost:8089)`
  assert.equal(await said({ 9931: ['nomic-embed-text-v1.5.Q4_K_M.gguf'], 8000: 'refuses', 30000: 'hangs' }), `no model is answering on this machine ${where}`
    + '; the llamacpp server at http://localhost:9931 is running but has no model that writes text on this machine'
    + `; something at ${VLLM_SERVER} is running but refused this page (if it is vLLM 0.32 or later, start it with --allowed-origins naming this page's origin)`
    + ': start one, or choose one with ask provider <name>')
  assert.match(await said({ 30000: 'refuses' }), /; something at http:\/\/localhost:30000 is running but refused this page \(if it is a model server, allow this page's origin in its settings\): start one/)
  // A web app on 8000 (every path 404), nothing on the rest: the sentence is the plain one.
  assert.equal(await said({ 8000: 'web', 30000: 'hangs' }), `no model is answering on this machine ${where}: start one, or choose one with ask provider <name>`)
})

test('a stop during the second round ends the look at once, and nothing it heard is kept', async () => {
  // 9931 answers with a model at once; 30000 holds the round open until the stop.
  const m = machine({ 9931: ['local.gguf'], 30000: 'hangs' })
  const r = createMindRouter({ fetch: m.f, lookMs: 60_000 })
  const ctl = new AbortController()
  const asked = ask(r, req(ctl.signal))
  // The first round fails at once (nothing listens); the second waits on 30000.
  let t0 = 0
  try {
    await askedAll(m, ['30000'])
  } finally {
    t0 = performance.now()
    ctl.abort(new Error('stopped by the operator'))
    await assert.rejects(asked, /stopped by the operator/)
  }
  assert.ok(performance.now() - t0 < 1000, 'not held for the look\'s wait')
  assert.equal(r.settings().found, undefined)
  r.setProvider('llamacpp')
  assert.equal(r.settings().server, LLAMACPP_SERVER, 'the address heard before the stop was not kept')
})

test('an address the first round already asked is not asked again in the second', async () => {
  // The OpenAI-compatible provider set to 9931 (not one of its known addresses): llama.cpp's second round would ask
  // 9931 too, and does not.
  const m = machine({})
  const r = createMindRouter({ fetch: m.f, lookMs: 50 })
  r.connect!('openai', 'http://localhost:9931')
  r.setProvider('auto')
  await assert.rejects(ask(r), /\(looked for ollama at http:\/\/localhost:11434, llamacpp at http:\/\/localhost:8080, openai at http:\/\/localhost:9931, claude at http:\/\/localhost:8089\)/)
  assert.deepEqual(m.calls.map((c) => port(c.url)), ['11434', '8080', '9931', '8089'])

  // The Claude gateway set to 8000: the second round never takes it for vLLM. It is asked once, last, as the gateway.
  const g = machine({ 8000: ['claude-opus-5-5'] })
  const gw = createMindRouter({ fetch: g.f, lookMs: 50 })
  gw.connect!('claude', 'http://localhost:8000')
  gw.setProvider('auto')
  assert.equal(await ask(gw), '8000 says hi')
  assert.equal(gw.settings().found, 'claude')
  assert.deepEqual(g.calls.map((c) => port(c.url)), ['11434', '8080', '1234', '9931', '30000', '8000', '8000'])
  gw.setProvider('openai')
  assert.equal(gw.settings().server, OPENAI_SERVER)
})
