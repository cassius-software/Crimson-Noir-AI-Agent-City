// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the router's auto provider (router.ts), the default: at an ask it finds the
 * first model server answering on this machine in AUTO_ORDER (Ollama, llama.cpp, an OpenAI-compatible server such as
 * LM Studio, then the Claude gateway) and answers with it; it passes over a server that is down, hangs, refuses this
 * page or has no model that writes text, and says why; it gives an Ollama without the default model the first text
 * model it has; it looks again when the one it found stops answering, but never once its answer has begun; and with
 * nothing answering it fails the way the script stands in for, so the operator hears canned words labelled as such.
 * What breaks if it is removed? A fresh machine with a model server running could still get only the script, or an
 * answer from a server the operator never meant to use.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { operatorBridge, type AnswerRequest, type Diary, type GateHandle, type GateLease, type Piece, type SimControls, type SkillGate } from '../07_Execute_Actions/operator.ts'
import type { TerminalBridge } from '../07_Execute_Actions/terminal/bridge.ts'
import { run as shell } from '../07_Execute_Actions/terminal/commands.ts'
import { CognitionError, DEFAULT_MODEL, DEFAULT_SERVER, type FetchLike } from './localCompute.ts'
import { AUTO_ORDER, createMindRouter, LLAMACPP_SERVER, OPENAI_SERVER, PROVIDER_TEXT } from './router.ts'
import { SCRIPTED, withScriptedFallback } from './scripted.ts'

const enc = new TextEncoder()
const stream = (text: string, type: string): Response => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(text)); c.close() } }), { status: 200, headers: { 'content-type': type } })
const ndjson = (...lines: object[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
const sse = (...events: object[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')

/** How a server on one port behaves: not listening, listening but refusing this page's origin, never answering, or answering with these models. */
type Server = 'down' | 'refuses' | 'hangs' | readonly string[]

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

const req = (signal = new AbortController().signal): AnswerRequest => ({ tethers: [{ agent: 7, serial: 1, skills: ['Rust'] }], prompt: 'hi', signal })
const ask = async (r: { answer(q: AnswerRequest, on: (p: Piece) => void): Promise<{ text: string }> }, q = req()): Promise<string> => (await r.answer(q, () => {})).text

test('auto looks in AUTO_ORDER: the servers on this machine at once, the first in that order that answers with a model wins, and it is kept', async () => {
  assert.deepEqual([...AUTO_ORDER], ['ollama', 'llamacpp', 'openai', 'claude'])
  const m = machine({ 11434: [DEFAULT_MODEL], 8080: ['local.gguf'], 1234: ['lm-model'], 8089: ['claude-opus-5-5'] })
  const r = createMindRouter({ fetch: m.f })
  assert.equal(await ask(r), '11434 says hi')
  const s = r.settings()
  assert.equal(s.provider, 'auto', 'auto stays the choice; what it found is said beside it')
  assert.equal(s.found, 'ollama')
  assert.equal(s.auto, `ollama at ${DEFAULT_SERVER}, found answering on this machine (ask provider ollama keeps it)`)
  assert.equal(s.server, DEFAULT_SERVER)
  assert.equal(s.key, undefined, 'no key row while a local model answers')
  // The look asked the three lists on this machine, not the gateway's (which asks the Claude API); the next ask goes
  // straight to the one found.
  assert.deepEqual(m.calls.map((c) => c.url), [`${DEFAULT_SERVER}/api/tags`, `${LLAMACPP_SERVER}/v1/models`, `${OPENAI_SERVER}/v1/models`, `${DEFAULT_SERVER}/api/generate`])
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

  // Only the Claude gateway: asked only once the servers on this machine have all said no, found last, and its key and
  // effort rows come back.
  const lone = machine({ 8089: ['claude-opus-5-5'] })
  const gw = createMindRouter({ fetch: lone.f })
  assert.equal(await ask(gw), '8089 says hi')
  assert.equal(gw.settings().found, 'claude')
  assert.equal(gw.settings().key, null)
  assert.deepEqual(lone.calls.map((c) => new URL(c.url).port), ['11434', '8080', '1234', '8089', '8089'])
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
    await assert.rejects(ask(createMindRouter({ fetch: isolated, lookMs: 50 })), /\(looked for .*\); one that is running may be refusing this page's origin, which looks the same from here \(Ollama: add this page's origin to OLLAMA_ORIGINS\): start one/)
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
    assert.equal(e.message, `no model is answering on this machine (looked for ollama at ${DEFAULT_SERVER}, llamacpp at ${LLAMACPP_SERVER}, openai at ${OPENAI_SERVER}, claude at http://localhost:8089)`
      + `; the ollama server at ${DEFAULT_SERVER} is running but has no model that writes text on this machine (ollama pull qwen3-vl:4b)`
      + `; the local model server at ${LLAMACPP_SERVER} is running but refused this page: allow this page's origin in its settings (a page opened from a file sends 'null'), or open the page from http://localhost`
      + `; the openai server at ${OPENAI_SERVER} did not list its models within 0.05 s (busy, or the browser is asking whether this page may reach it: allow it, then ask again)`
      + ': start one, or choose one with ask provider <name>')
    return true
  })
  assert.match(none.settings().auto!, /^nothing found yet: the next ask looks on this machine; the ollama server .* has no model that writes text on this machine/)
  assert.equal(none.settings().found, undefined)
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
  const op = operatorBridge({} as SimControls, gate(), withScriptedFallback(createMindRouter({ fetch: m.f, lookMs: 50 })), undefined, { diary })
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
