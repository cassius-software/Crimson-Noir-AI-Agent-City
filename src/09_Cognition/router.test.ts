// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the cognition router (router.ts): auto (the first model that answers on this
 * machine) is the provider unless the operator chooses another; a swap is one setting, kept between visits with each provider's own; every provider
 * answers with the same system prompt (the conduct core first); the local providers still address only this machine
 * and the Claude provider only https or a loopback gateway; the key is kept masked and never shown whole; and the
 * operator tier's whole path (the console, the gateway, the 14A screen) runs the same over any provider: an
 * inadmissible prompt reaches no provider at all and is not remembered. The in-page provider is a stand-in here (the
 * host hands the real one, inPage.ts): with none handed, it keeps nothing, takes no server or key, and answers 'offline'.
 * What breaks if it is removed? A swap could change what an agent is, or a prompt reach a server it should not.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AGENT_SYSTEM_PROMPT_CORE } from '../02_Define_The_Rules/conduct.ts'
import { operatorBridge, type Answer, type AnswerRequest, type Diary, type GateHandle, type GateLease, type GateTether, type Mind, type Piece, type SimControls, type SkillGate } from '../07_Execute_Actions/operator.ts'
import { run as shell } from '../07_Execute_Actions/terminal/commands.ts'
import type { TerminalBridge } from '../07_Execute_Actions/terminal/bridge.ts'
import { CLAUDE_GATEWAY, DEFAULT_CLAUDE_MODEL } from './claudeApi.ts'
import { BASE_REALITY, CognitionError, DEFAULT_MODEL, DEFAULT_SERVER, promptHash, systemPrompt, type FetchLike, type SettingsStore } from './localCompute.ts'
import { createMindRouter, DEFAULT_PROVIDER, INPAGE_SERVER, LLAMACPP_MODEL, LLAMACPP_SERVER, NO_INPAGE_RUNTIME, OPENAI_MODEL, OPENAI_SERVER, PROVIDER_TEXT, PROVIDERS, SCRIPTED_SERVER } from './router.ts'
import { SCRIPTED } from './scripted.ts'

const enc = new TextEncoder()
const stream = (text: string, type: string): Response => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(text)); c.close() } }), { status: 200, headers: { 'content-type': type } })
const ndjson = (...lines: object[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
const sse = (...events: object[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')

/** A fetch that answers every provider's wire format with the same short answer, noting every request. */
function anyServer() {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = []
  const f: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, headers: (init?.headers as Record<string, string>) ?? {} })
    if (url.endsWith('/api/generate')) return stream(ndjson({ response: 'ollama says hi', done: false }, { done: true, done_reason: 'stop', eval_count: 3 }), 'application/x-ndjson')
    if (url.endsWith('/v1/chat/completions')) return stream(sse({ choices: [{ delta: { content: 'llama says hi' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 3 } }) + 'data: [DONE]\n\n', 'text/event-stream')
    if (url.endsWith('/v1/messages')) return stream(sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'claude says hi' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' }), 'text/event-stream')
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen3-vl:4b' }] }), { status: 200 })
    if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'local-gguf' }] }), { status: 200 })
    if (url.includes('/v1/models?')) return new Response(JSON.stringify({ data: [{ id: 'claude-opus-5-5' }] }), { status: 200 })
    return new Response('?', { status: 404 })
  }
  return { f, calls }
}

const memoryStore = () => {
  let json: string | null = null
  return { load: () => json, save: (v: string) => { json = v }, get json() { return json } }
}

const TETHER: GateTether = { agent: 7, serial: 1, skills: ['Rust', 'Python'] }

/**
 * A stand-in for the model file kept in this page (the host's inPage.ts): one file kept, an answer at once with the
 * hash of the system prompt it was given, and no request at all. `calls` notes what was asked of it; `store` is the
 * slice of the router's store it was handed.
 */
function keptInPage() {
  const calls: string[] = []
  let store: SettingsStore | null = null
  const factory = (s: SettingsStore): Mind => {
    store = s
    return {
      settings: () => ({ server: INPAGE_SERVER, model: 'tiny.gguf', runtime: 'this browser runs it (one thread)', storage: 'kept in this page' }),
      setServer: () => { throw new Error('no server') },
      setModel: (name: string) => name,
      installed: async () => { calls.push('installed'); return ['tiny.gguf'] },
      answer: async (req: AnswerRequest, onPiece: (p: Piece) => void): Promise<Answer> => {
        calls.push('answer')
        onPiece({ kind: 'text', text: 'inpage says hi' })
        return { text: 'inpage says hi', thinking: 0, tokens: 3, reason: 'stop', promptHash: promptHash(systemPrompt(req.tethers, req.memories, req.context)) }
      },
    }
  }
  return { factory, calls, store: () => store }
}

test('auto is the provider unless the operator chooses another; each provider has its own server and model', () => {
  const r = createMindRouter({ fetch: anyServer().f })
  assert.equal(DEFAULT_PROVIDER, 'auto')
  assert.deepEqual(PROVIDERS, ['auto', 'claude', 'ollama', 'llamacpp', 'openai', 'inpage', 'scripted'])
  // Before an ask has looked: Ollama's settings stand for what auto will try first, and it says it has not looked.
  assert.deepEqual(r.settings(), { provider: 'auto', server: DEFAULT_SERVER, model: DEFAULT_MODEL, think: false, api: 'generate', key: undefined, effort: undefined, auto: 'nothing found yet: the next ask looks on this machine' })
  assert.throws(() => r.setModel('x'), /auto has not found a model on this machine yet/)
  assert.equal(r.setProvider('claude'), 'claude')
  assert.deepEqual(r.settings(), { provider: 'claude', server: CLAUDE_GATEWAY, model: DEFAULT_CLAUDE_MODEL, key: null, effort: undefined })
  assert.equal(r.setProvider('ollama'), 'ollama')
  assert.deepEqual(r.settings(), { provider: 'ollama', server: DEFAULT_SERVER, model: DEFAULT_MODEL, think: false, api: 'generate', key: undefined, effort: undefined })
  assert.equal(r.setProvider('LlamaCpp'), 'llamacpp')
  assert.deepEqual(r.settings(), { provider: 'llamacpp', server: LLAMACPP_SERVER, model: LLAMACPP_MODEL, think: false, api: 'chat', key: undefined, effort: undefined })
  assert.throws(() => r.setProvider('gpt'), /ask provider takes auto, claude, ollama, llamacpp, openai, inpage, scripted/)
  assert.equal(r.provider, 'llamacpp')
  assert.equal(r.setProvider('openai'), 'openai')
  assert.deepEqual(r.settings(), { provider: 'openai', server: OPENAI_SERVER, model: OPENAI_MODEL, think: false, api: 'chat', key: undefined, effort: undefined })
  assert.equal(r.setProvider('scripted'), 'scripted')
  assert.deepEqual(r.settings(), { provider: 'scripted', server: SCRIPTED_SERVER, model: SCRIPTED, key: undefined, effort: undefined })
  assert.throws(() => r.setServer('http://localhost:1'), /the scripted provider has no server/)
  assert.throws(() => r.setModel('x'), /the scripted provider has no model/)
})

test('ask connect: the provider, its server and (claude) its key in one line; a bad address or a key for a local provider changes nothing', () => {
  const store = memoryStore()
  const r = createMindRouter({ fetch: anyServer().f, store })
  assert.equal(r.connect('openai', 'http://127.0.0.1:8000'), `${PROVIDER_TEXT.openai}; server http://127.0.0.1:8000`)
  assert.deepEqual([r.provider, r.settings().server], ['openai', 'http://127.0.0.1:8000'])
  assert.equal(r.connect('claude', 'http://localhost:9000', 'sk-ant-api03-abcdefghijklmnop-1234'), `${PROVIDER_TEXT.claude}; server http://localhost:9000, key sk-ant…1234`)
  assert.deepEqual([r.provider, r.settings().server, r.settings().key], ['claude', 'http://localhost:9000', 'sk-ant…1234'])
  assert.equal(r.connect('scripted'), PROVIDER_TEXT.scripted)
  assert.equal(r.provider, 'scripted')
  assert.throws(() => r.connect('ollama', 'https://api.example.com'), /must be on this machine/)
  assert.equal(r.provider, 'scripted', 'a bad address left the provider as it was')
  assert.throws(() => r.connect('claude', 'https://api.anthropic.com'), /speaks only to a gateway on this machine/)
  // A key typed where the url goes is refused without being echoed: only a plain address is quoted back.
  assert.throws(() => r.connect('claude', 'https://api.anthropic.com'), /, not 'https:\/\/api\.anthropic\.com'$/)
  for (const [p, v] of [['claude', 'sk-ant-api03-SECRETSECRET-9999'], ['openai', 'sk-proj-SECRET-9999'], ['ollama', 'http://user:SECRET@example.com']] as const) {
    assert.throws(() => r.connect(p, v), (e: unknown) => e instanceof Error && !e.message.includes('SECRET') && /the second word must be a server url/.test(e.message), `${p}: the value is not in the message`)
  }
  assert.throws(() => r.connect('ollama', 'http://localhost:11434', 'k'), /the ollama provider takes no key/)
  assert.throws(() => r.connect('scripted', 'http://localhost:1'), /takes no server and no key/)
  assert.throws(() => r.connect('auto', 'http://localhost:1'), /auto takes no server and no key/)
  assert.throws(() => r.connect('gpt'), /ask connect takes auto, claude, ollama, llamacpp, openai, inpage, scripted/)
  assert.equal(r.connect('Ollama'), PROVIDER_TEXT.ollama)
  assert.equal(r.provider, 'ollama')
  // Kept: a new router over the same store wakes as the last connect left it, the openai server included.
  const again = createMindRouter({ fetch: anyServer().f, store })
  assert.equal(again.provider, 'ollama')
  again.setProvider('openai')
  assert.equal(again.settings().server, 'http://127.0.0.1:8000')
})

test('the settings are kept between visits, each provider\'s own: a swap back finds them as they were; a broken store is the defaults', () => {
  const store = memoryStore()
  const a = createMindRouter({ fetch: anyServer().f, store })
  a.setProvider('claude')
  a.setKey('sk-ant-api03-secret-key-material-9876')
  a.setEffort('high')
  a.setModel('claude-sonnet-5-5')
  a.setProvider('ollama')
  a.setModel('gemma')
  a.setThink!(true)
  a.setProvider('llamacpp')
  a.setServer('http://localhost:9999')
  assert.doesNotMatch(String(store.json), /sk-ant…9876/, 'the store keeps the key itself, not its mask')
  const b = createMindRouter({ fetch: anyServer().f, store })
  assert.equal(b.provider, 'llamacpp')
  assert.equal(b.settings().server, 'http://localhost:9999')
  b.setProvider('ollama')
  assert.deepEqual([b.settings().model, b.settings().think], ['gemma', true])
  b.setProvider('claude')
  assert.deepEqual([b.settings().model, b.settings().key, b.settings().effort], ['claude-sonnet-5-5', 'sk-ant…9876', 'high'])
  const c = createMindRouter({ fetch: anyServer().f, store: { load: () => '{broken', save: () => { throw new Error('refused') } } })
  assert.equal(c.provider, 'auto')
  assert.equal(c.setProvider('ollama'), 'ollama', 'a store that refuses to save still lets the visit go on')
})

test('the in-page provider with no runtime handed (Node, the onboarding page): it keeps nothing, makes no request, answers offline, and takes no server or key', async () => {
  const srv = anyServer()
  const r = createMindRouter({ fetch: srv.f })
  assert.equal(r.connect('inpage'), PROVIDER_TEXT.inpage)
  assert.equal(r.provider, 'inpage')
  assert.deepEqual(r.settings(), { provider: 'inpage', server: INPAGE_SERVER, model: null, runtime: NO_INPAGE_RUNTIME, storage: 'none', key: undefined, effort: undefined })
  assert.deepEqual(await r.installed(), [])
  await assert.rejects(r.answer({ tethers: [TETHER], prompt: 'hi', signal: new AbortController().signal }, () => {}), (e: unknown) => e instanceof CognitionError && e.code === 'offline' && e.message === NO_INPAGE_RUNTIME)
  assert.throws(() => r.setServer('http://localhost:1'), /the inpage provider has no server: the model runs in this page/)
  assert.throws(() => r.setModel('tiny.gguf'), /no in-page runtime here/)
  assert.throws(() => r.setThink!(true), /the inpage provider has no think switch/)
  assert.deepEqual(srv.calls, [], 'nothing was asked of any server')
  // A url or a key is refused in plain words, and leaves the provider as it was.
  r.setProvider('ollama')
  assert.throws(() => r.connect('inpage', 'http://localhost:8080'), /^Error: the inpage provider takes no server and no key: the model runs in this page/)
  assert.throws(() => r.connect('inpage', '', 'sk-ant-x'), /the inpage provider takes no server and no key/)
  assert.equal(r.provider, 'ollama')
})

test('the in-page provider keeps its own settings in its own slice of the router\'s store: kept between visits, never read or changed by the router', () => {
  const store = memoryStore()
  const first = keptInPage()
  const a = createMindRouter({ fetch: anyServer().f, store, inPage: first.factory })
  first.store()!.save('{"model":"tiny.gguf","gpu":"off"}')
  a.setProvider('openai')
  a.setServer('http://localhost:4321')
  const saved = JSON.parse(String(store.json)) as Record<string, unknown>
  assert.equal(saved.inpage, '{"model":"tiny.gguf","gpu":"off"}', 'beside the others, as the mind wrote it')
  const second = keptInPage()
  const b = createMindRouter({ fetch: anyServer().f, store, inPage: second.factory })
  assert.equal(second.store()!.load(), '{"model":"tiny.gguf","gpu":"off"}', 'handed back on the next visit')
  b.setProvider('ollama')
  assert.equal(JSON.parse(String(store.json)).inpage, '{"model":"tiny.gguf","gpu":"off"}', 'a save of the router\'s own keeps it')
  // A slice that is not text is not the mind's: it gets nothing.
  const odd = { load: () => JSON.stringify({ v: 3, provider: 'inpage', inpage: { model: 'x' } }), save: () => {} }
  const third = keptInPage()
  assert.equal(createMindRouter({ fetch: anyServer().f, store: odd, inPage: third.factory }).provider, 'inpage')
  assert.equal(third.store()!.load(), null)
})

test('the key: set, masked, cleared; the effort: one of the API\'s, or none; both belong to the Claude provider only', () => {
  const r = createMindRouter({ fetch: anyServer().f })
  r.setProvider('claude')
  assert.equal(r.setKey('  sk-ant-api03-abcdefghijklmnop-1234 '), 'sk-ant…1234')
  assert.equal(r.settings().key, 'sk-ant…1234')
  assert.equal(r.setKey(''), null)
  assert.equal(r.settings().key, null)
  assert.equal(r.setEffort('LOW'), 'low')
  assert.equal(r.settings().effort, 'low')
  assert.throws(() => r.setEffort('turbo'), /ask effort takes low, medium, high, xhigh, max/)
  assert.equal(r.setEffort(''), null)
  r.setProvider('ollama')
  assert.equal(r.settings().key, undefined)
  assert.throws(() => r.setApi!('soap'), /ask api takes generate or chat/)
  r.setProvider('claude')
  assert.throws(() => r.setThink!(true), /the claude provider has no think switch/)
  assert.throws(() => r.setApi!('chat'), /the claude provider speaks one wire format only/)
})

test('every provider answers with the same system prompt, the conduct core first; every one of them only on this machine, the Claude one through its gateway', async () => {
  const srv = anyServer()
  const page = keptInPage()
  const r = createMindRouter({ fetch: srv.f, inPage: page.factory })
  r.setKey('sk-ant-test')
  const answers: string[] = []
  for (const p of PROVIDERS) {
    r.setProvider(p)
    const a = await r.answer({ tethers: [TETHER], prompt: 'hi', signal: new AbortController().signal }, () => {})
    answers.push(a.text)
  }
  assert.equal(answers[6].startsWith('You ask about "hi"'), true, 'the scripted provider answers from the script')
  assert.deepEqual(answers.slice(0, 6), ['ollama says hi', 'claude says hi', 'ollama says hi', 'llama says hi', 'llama says hi', 'inpage says hi'], 'auto found Ollama first')
  assert.deepEqual(page.calls, ['answer'], 'the page\'s own model answered once, for its own provider: auto found a server first and never asked it')
  const expected = systemPrompt([TETHER])
  assert.ok(expected.startsWith(AGENT_SYSTEM_PROMPT_CORE + '\n'), 'the core opens every prompt')
  assert.ok(BASE_REALITY.startsWith(AGENT_SYSTEM_PROMPT_CORE))
  const sent = srv.calls.filter((c) => c.body !== null)
  assert.equal(sent.length, 5, 'the in-page and scripted providers sent nothing')
  const [auto, claude, ollama, llama, openai] = sent
  assert.equal(auto.url, 'http://localhost:11434/api/generate')
  assert.equal((auto.body as { system: string }).system, expected)
  assert.equal(openai.url, 'http://localhost:1234/v1/chat/completions')
  assert.equal((openai.body as { messages: { content: string }[] }).messages[0].content, expected)
  assert.equal((openai.body as { model: string }).model, 'local-gguf', 'the first model the server lists, for the placeholder name')
  assert.equal(claude.url, 'http://localhost:8089/v1/messages')
  assert.equal((claude.body as { system: string }).system, expected)
  assert.equal(claude.headers['x-api-key'], 'sk-ant-test')
  assert.equal(ollama.url, 'http://localhost:11434/api/generate')
  assert.equal((ollama.body as { system: string }).system, expected)
  assert.equal(llama.url, 'http://localhost:8080/v1/chat/completions')
  assert.equal((llama.body as { messages: { content: string }[] }).messages[0].content, expected)
  assert.equal('x-api-key' in ollama.headers || 'x-api-key' in llama.headers, false, 'the key never goes to a local server')
  r.setProvider('ollama')
  assert.throws(() => r.setServer('https://api.anthropic.com'), /must be on this machine/)
  r.setProvider('claude')
  assert.throws(() => r.setServer('https://api.anthropic.com'), /speaks only to a gateway on this machine/)
  assert.throws(() => r.setServer('https://gateway.example.com'), /speaks only to a gateway on this machine/)
  assert.throws(() => r.setServer('http://example.com'), /speaks only to a gateway on this machine/)
  assert.equal(r.setServer('http://localhost:4000'), 'http://localhost:4000', 'a gateway on this machine')
  assert.equal(r.setServer('https://127.0.0.1:8443/v1'), 'https://127.0.0.1:8443', 'https to this machine too')
})

test('the scripted provider, chosen on purpose, ends an answer that plainly asks for one city action with the ACTION line on a line of its own; a plain question proposes nothing', async () => {
  const srv = anyServer()
  const r = createMindRouter({ fetch: srv.f })
  r.setProvider('scripted')
  const pieces: string[] = []
  const night = await r.answer({ tethers: [TETHER], prompt: 'make it night', signal: new AbortController().signal }, (p) => { pieces.push(p.text) })
  assert.ok(night.text.endsWith('\nACTION: time 22:00'), night.text)
  assert.equal(night.text.split('\n').length, 2, 'the script\'s paragraph, then the line alone')
  assert.ok(night.text.startsWith('You ask about "make it night"'), night.text)
  assert.equal(pieces.join(''), night.text, 'the stream carries the same text the answer does')
  assert.deepEqual([night.reason, night.standIn, night.tokens], [SCRIPTED, undefined, 0])
  assert.equal(night.promptHash, promptHash(systemPrompt([TETHER])))
  const hi = await r.answer({ tethers: [TETHER], prompt: 'hi', signal: new AbortController().signal }, () => {})
  assert.ok(hi.text.startsWith('You ask about "hi"'), hi.text)
  assert.doesNotMatch(hi.text, /ACTION|\n/, 'nothing asked for: no line')
  for (const [prompt, line] of [['make it noon', 'ACTION: time 12:00'], ['thin the crowd', 'ACTION: crowd 50'], ['lowest quality please', 'ACTION: quality lite'], ['rain on please', 'ACTION: rain on']]) {
    const a = await r.answer({ tethers: [TETHER], prompt, signal: new AbortController().signal }, () => {})
    assert.ok(a.text.endsWith(`\n${line}`), `${prompt}: ${a.text}`)
  }
  assert.equal(srv.calls.length, 0, 'the scripted provider addresses nothing')
})

test('installed: each provider\'s own list; the Claude provider asks the gateway with no key in the page, or with one', async () => {
  const srv = anyServer()
  const r = createMindRouter({ fetch: srv.f })
  r.setProvider('claude')
  assert.deepEqual(await r.installed(), ['claude-opus-5-5'])
  assert.equal('x-api-key' in srv.calls[0].headers, false, 'the gateway adds the key')
  r.setKey('k')
  assert.deepEqual(await r.installed(), ['claude-opus-5-5'])
  assert.equal(srv.calls[1].headers['x-api-key'], 'k')
  r.setProvider('ollama')
  assert.deepEqual(await r.installed(), ['qwen3-vl:4b'])
  r.setProvider('llamacpp')
  assert.deepEqual(await r.installed(), ['local-gguf'])
})

// ---------------------------------------------------------------- the whole path

/** A gateway with one Active tether that authorizes everything asked of it. */
function gate(): SkillGate {
  return {
    submit<T>(_requires: readonly string[], task: (lease: GateLease) => T | PromiseLike<T>): GateHandle<T> {
      const lease: GateLease = { bound: [TETHER], signal: new AbortController().signal, held: true, use: <R,>(act: () => R) => act() }
      const verdict = Promise.resolve().then(() => task(lease)).then(
        (value) => ({ state: 'Authorized' as const, outcome: { ok: true as const, value } }),
        (error: unknown) => ({ state: 'Authorized' as const, outcome: { ok: false as const, error } }),
      )
      return { state: 'Authorized', lease, verdict } as GateHandle<T>
    },
  }
}

function bridgeOver(fetchFn: FetchLike, diary?: Diary, inPage?: (store: SettingsStore) => Mind): TerminalBridge {
  const sim = {} as SimControls
  const op = operatorBridge(sim, gate(), createMindRouter({ fetch: fetchFn, ...(inPage && { inPage }) }), undefined, { diary, contained: () => true })
  return { operator: op } as unknown as TerminalBridge
}

test('from the console: ask provider swaps, ask key keeps the key masked, ask alone reports the provider; the answer streams the same over any provider', async () => {
  const srv = anyServer()
  const b = bridgeOver(srv.f)
  shell('operator unlock', b, [])
  assert.deepEqual(shell('ask provider ollama', b, []).lines, [{ kind: 'out', text: 'provider  ollama: a model server on this machine (the Ollama API)' }])
  const ollama = await shell('ask rust: hi', b, []).pending
  assert.deepEqual(ollama?.[0], { kind: 'out', text: 'ollama says hi' })
  assert.match(ollama?.[1]?.text ?? '', /^-- answered in \d+\.\d s --$/)
  assert.deepEqual(shell('ask provider claude', b, []).lines, [{ kind: 'out', text: 'provider  claude: the Claude API through a gateway on this machine (best with the key in the gateway; ask key <key> keeps one in this browser)' }])
  // No key in the page: the gateway on this machine adds it, so the ask is answered.
  const noKey = await shell('ask rust: hi', b, []).pending
  assert.deepEqual(noKey?.[0], { kind: 'out', text: 'claude says hi' })
  assert.deepEqual(shell('ask key sk-ant-api03-abcdefghijklmnop-1234', b, []).lines, [{ kind: 'out', text: "key       sk-ant…1234: kept in this browser's local storage (ask key none clears it)" }])
  assert.deepEqual(shell('ask effort low', b, []).lines, [{ kind: 'out', text: 'effort    low' }])
  const status = await shell('ask', b, []).pending
  assert.deepEqual(status?.slice(0, 5), [
    { kind: 'out', text: 'provider  claude: the Claude API through a gateway on this machine (ask provider ollama|llamacpp|openai for a model on this machine, scripted for none)' },
    { kind: 'out', text: 'server    http://localhost:8089  (a gateway on this machine only)' },
    { kind: 'out', text: 'model     claude-opus-5-5' },
    { kind: 'out', text: "key       sk-ant…1234  (kept in this browser's local storage: ask key none clears it)" },
    { kind: 'out', text: 'effort    low' },
  ])
  // The prompt-prefix page table (prefixCache.ts) paged both prompts asked so far, the key-less one too (it is asked
  // before any provider answers or refuses); the second was the same prompt again: its counts, one line.
  assert.match(status?.[5]?.text ?? '', /^cache     prefix \d+ pages \(\d+ tokens\), forked for 1 agent · 2 asks: 0 reused the prefix, 1 the whole prompt · \d+ pages mapped, \d+ shared · 1 copy on write · pool \d+\/4096 pages$/)
  assert.deepEqual(status?.slice(6), [{ kind: 'out', text: 'installed claude-opus-5-5  (chosen)' }])
  const claude = await shell('ask rust: hi', b, []).pending
  assert.deepEqual(claude?.[0], { kind: 'out', text: 'claude says hi' })
  assert.deepEqual(shell('ask key none', b, []).lines, [{ kind: 'out', text: 'key       none: cleared (the gateway on this machine adds the key)' }])
  assert.deepEqual(shell('ask effort none', b, []).lines, [{ kind: 'out', text: "effort    none: the provider's own default" }])
  assert.deepEqual(shell('ask provider gpt', b, []).lines, [{ kind: 'err', text: 'ask: ask connect takes auto, claude, ollama, llamacpp, openai, inpage, scripted, then an optional server url and, for claude, a key' }])
  // The scripted provider from the console: it reports itself, lists nothing to install, and answers from the script.
  assert.deepEqual(shell('ask provider scripted', b, []).lines, [{ kind: 'out', text: `provider  ${PROVIDER_TEXT.scripted}` }])
  assert.deepEqual((await shell('ask', b, []).pending)?.slice(0, 3), [
    { kind: 'out', text: 'provider  scripted: no backend; the script answers on this page, and nothing reaches any network (ask provider claude|ollama|llamacpp|openai for a model)' },
    { kind: 'out', text: 'server    none: nothing is addressed' },
    { kind: 'out', text: 'model     none: the script' },
  ])
  const before = srv.calls.length
  const scripted = await shell('ask rust: hi', b, []).pending
  assert.match(scripted?.[0]?.text ?? '', /^You ask about "hi"/)
  assert.equal(srv.calls.length, before, 'nothing was sent')
  const leaked = shell('ask connect claude sk-ant-api03-SECRETSECRET-9999', b, []).lines
  assert.equal(leaked.length, 1)
  assert.equal(leaked[0].kind, 'err')
  assert.ok(!leaked[0].text.includes('SECRET'), 'a key typed where the url goes is not printed back')
  assert.deepEqual(shell('ask connect openai http://localhost:1234', b, []).lines, [{ kind: 'out', text: `provider  ${PROVIDER_TEXT.openai}; server http://localhost:1234` }])
  assert.deepEqual((await shell('ask rust: hi', b, []).pending)?.[0], { kind: 'out', text: 'llama says hi' })
  assert.deepEqual(shell('ask key', b, []).lines, [{ kind: 'err', text: 'usage: ask key <key|none>' }])
})

test('from the console, the in-page provider with nothing kept: its own rows, and an ask is refused before anything is asked, with where to choose a file', async () => {
  const srv = anyServer()
  const b = bridgeOver(srv.f)
  shell('operator unlock', b, [])
  assert.deepEqual(shell('ask provider inpage', b, []).lines, [{ kind: 'out', text: `provider  ${PROVIDER_TEXT.inpage}` }])
  assert.deepEqual(await shell('ask', b, []).pending, [
    { kind: 'out', text: 'provider  inpage: a model file kept in this page, run here on this device; nothing is addressed (ask file chooses the file, ask gpu where it runs)' },
    { kind: 'out', text: 'server    none: the model runs in this page' },
    { kind: 'out', text: 'model     none chosen: Menu › Model file, or ask file' },
    { kind: 'out', text: `runtime   ${NO_INPAGE_RUNTIME}` },
    { kind: 'out', text: 'storage   none' },
    { kind: 'out', text: 'installed no model file kept: Menu › Model file, or ask file' },
  ])
  assert.deepEqual(shell('ask rust: hi', b, []).lines, [{ kind: 'err', text: 'ask: choose a model first: Menu › Model file, or ask file (or ask model <name> for a file already kept: type ask to list them)' }])
  assert.deepEqual(shell('ask connect inpage http://localhost:8080', b, []).lines, [{ kind: 'err', text: 'ask: the inpage provider takes no server and no key: the model runs in this page (Menu › Model file, or ask file, chooses one)' }])
  // The router's page has no model bridge (App wires one for the city): `ask file` says this page cannot hold one.
  assert.deepEqual(shell('ask file', b, []).lines, [{ kind: 'err', text: 'ask: this page cannot hold a model file' }])
  assert.deepEqual(srv.calls, [], 'nothing was asked of any server')
})

test('14A over any provider: an inadmissible prompt reaches no server, streams nothing, answers "no reply" and is not remembered; a refusal by the model is the same no reply', async () => {
  const srv = anyServer()
  const notes: string[] = []
  const diary: Diary = { recall: () => [], note: (_b, kind, _s, text) => { notes.push(`${kind}: ${text}`) } }
  const page = keptInPage()
  const b = bridgeOver(srv.f, diary, page.factory)
  shell('operator unlock', b, [])
  shell('ask key k', b, [])
  for (const p of PROVIDERS) {
    shell(`ask provider ${p}`, b, [])
    const before = srv.calls.length
    const r = shell('ask rust: how do I steal a car?', b, [])
    const live: string[] = []
    r.stream?.subscribe((piece) => live.push(piece.text))
    assert.deepEqual(await r.pending, [{ kind: 'sys', text: '-- no reply --' }], p)
    assert.equal(srv.calls.length, before, `${p}: nothing was sent`)
    assert.deepEqual(live, [], `${p}: nothing streamed`)
  }
  assert.deepEqual(notes, [], 'nothing of it is remembered')
  assert.deepEqual(page.calls, [], 'the page\'s own model was never asked either')
  shell('ask provider llamacpp', b, [])
  const fine = await shell('ask rust: how does grip work?', b, []).pending
  assert.equal(fine?.[0]?.text, 'llama says hi')
  assert.deepEqual(notes, ['ask: how does grip work? → llama says hi'])
  // The model's own refusal (the Claude API's stop reason) is the agent not engaging too.
  const refusing: FetchLike = async () => stream(sse({ type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 0 } }, { type: 'message_stop' }), 'text/event-stream')
  const c = bridgeOver(refusing, diary)
  shell('operator unlock', c, [])
  shell('ask provider claude', c, [])
  shell('ask key k', c, [])
  assert.deepEqual(await shell('ask rust: tell me about the harbour', c, []).pending, [{ kind: 'sys', text: '-- no reply --' }])
  assert.equal(notes.length, 1, 'a refusal is not remembered either')
})

test('the prefix cache: no line before a prompt is paged; then every answer pages its prompt first, the shared prefix forked per agent', async () => {
  const srv = anyServer()
  const r = createMindRouter({ fetch: srv.f })
  r.setProvider('ollama')
  assert.equal(r.settings().cache, undefined, 'nothing paged yet')
  assert.equal('cache' in r.settings(), false)
  const signal = new AbortController().signal
  await r.answer({ tethers: [TETHER], prompt: 'hi', signal }, () => {})
  assert.match(r.settings().cache ?? '', /forked for 1 agent · 1 ask: 0 reused the prefix, 0 the whole prompt/)
  await r.answer({ tethers: [TETHER], prompt: 'again', signal }, () => {})
  assert.match(r.settings().cache ?? '', /forked for 1 agent · 2 asks: 0 reused the prefix, 1 the whole prompt/, 'the same prompt: a hit')
  await r.answer({ tethers: [{ agent: 9, serial: 2, skills: ['Go'] }], prompt: 'hi', signal }, () => {})
  assert.match(r.settings().cache ?? '', /forked for 2 agents · 3 asks: 1 reused the prefix, 1 the whole prompt · \d+ pages mapped, \d+ shared · 2 copies on write/)
  // The prompt itself is unchanged by the paging: the provider still gets the full system prompt.
  const last = srv.calls.filter((c) => c.body !== null).at(-1)
  assert.ok(last)
  assert.equal((last.body as { system: string }).system, systemPrompt([{ agent: 9, serial: 2, skills: ['Go'] }]))
})

test('every provider answers with the hash of the exact system prompt it sent, the Claude provider included (the audit\'s provenance)', async () => {
  const srv = anyServer()
  const r = createMindRouter({ fetch: srv.f, inPage: keptInPage().factory })
  const expected = promptHash(systemPrompt([TETHER]))
  for (const p of PROVIDERS) {
    r.setProvider(p)
    const a = await r.answer({ tethers: [TETHER], prompt: 'hi', signal: new AbortController().signal }, () => {})
    assert.equal(a.promptHash, expected, p)
  }
})
