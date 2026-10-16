// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the cognition router (router.ts): the Claude API is the provider unless the
 * operator chooses another; a swap is one setting, kept between visits with each provider's own; every provider
 * answers with the same system prompt (the conduct core first); the local providers still address only this machine
 * and the Claude provider only https or a loopback gateway; the key is kept masked and never shown whole; and the
 * operator tier's whole path (the console, the gateway, the 14A screen) runs the same over any provider: an
 * inadmissible prompt reaches no provider at all and is not remembered.
 * What breaks if it is removed? A swap could change what an agent is, or a prompt reach a server it should not.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AGENT_SYSTEM_PROMPT_CORE } from '../02_Define_The_Rules/conduct.ts'
import { operatorBridge, type Diary, type GateHandle, type GateLease, type GateTether, type SimControls, type SkillGate } from '../07_Execute_Actions/operator.ts'
import { run as shell } from '../07_Execute_Actions/terminal/commands.ts'
import type { TerminalBridge } from '../07_Execute_Actions/terminal/bridge.ts'
import { CLAUDE_GATEWAY, DEFAULT_CLAUDE_MODEL } from './claudeApi.ts'
import { BASE_REALITY, DEFAULT_MODEL, DEFAULT_SERVER, promptHash, systemPrompt, type FetchLike } from './localCompute.ts'
import { createMindRouter, DEFAULT_PROVIDER, LLAMACPP_MODEL, LLAMACPP_SERVER, OPENAI_MODEL, OPENAI_SERVER, PROVIDER_TEXT, PROVIDERS, SCRIPTED_SERVER } from './router.ts'
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

test('the Claude API is the provider unless the operator chooses another; each provider has its own server and model', () => {
  const r = createMindRouter({ fetch: anyServer().f })
  assert.equal(DEFAULT_PROVIDER, 'claude')
  assert.deepEqual(PROVIDERS, ['claude', 'ollama', 'llamacpp', 'openai', 'scripted'])
  assert.deepEqual(r.settings(), { provider: 'claude', server: CLAUDE_GATEWAY, model: DEFAULT_CLAUDE_MODEL, key: null, effort: undefined })
  assert.equal(r.setProvider('ollama'), 'ollama')
  assert.deepEqual(r.settings(), { provider: 'ollama', server: DEFAULT_SERVER, model: DEFAULT_MODEL, think: false, api: 'generate', key: undefined, effort: undefined })
  assert.equal(r.setProvider('LlamaCpp'), 'llamacpp')
  assert.deepEqual(r.settings(), { provider: 'llamacpp', server: LLAMACPP_SERVER, model: LLAMACPP_MODEL, think: false, api: 'chat', key: undefined, effort: undefined })
  assert.throws(() => r.setProvider('gpt'), /ask provider takes claude, ollama, llamacpp, openai, scripted/)
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
  assert.throws(() => r.connect('ollama', 'http://localhost:11434', 'k'), /the ollama provider takes no key/)
  assert.throws(() => r.connect('scripted', 'http://localhost:1'), /takes no server and no key/)
  assert.throws(() => r.connect('gpt'), /ask connect takes claude, ollama, llamacpp, openai, scripted/)
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
  assert.equal(c.provider, 'claude')
  assert.equal(c.setProvider('ollama'), 'ollama', 'a store that refuses to save still lets the visit go on')
})

test('the key: set, masked, cleared; the effort: one of the API\'s, or none; both belong to the Claude provider only', () => {
  const r = createMindRouter({ fetch: anyServer().f })
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
  const r = createMindRouter({ fetch: srv.f })
  r.setKey('sk-ant-test')
  const answers: string[] = []
  for (const p of PROVIDERS) {
    r.setProvider(p)
    const a = await r.answer({ tethers: [TETHER], prompt: 'hi', signal: new AbortController().signal }, () => {})
    answers.push(a.text)
  }
  assert.equal(answers[4].startsWith('You ask about "hi"'), true, 'the scripted provider answers from the script')
  assert.deepEqual(answers.slice(0, 4), ['claude says hi', 'ollama says hi', 'llama says hi', 'llama says hi'])
  const expected = systemPrompt([TETHER])
  assert.ok(expected.startsWith(AGENT_SYSTEM_PROMPT_CORE + '\n'), 'the core opens every prompt')
  assert.ok(BASE_REALITY.startsWith(AGENT_SYSTEM_PROMPT_CORE))
  const sent = srv.calls.filter((c) => c.body !== null)
  assert.equal(sent.length, 4, 'the scripted provider sent nothing')
  const [claude, ollama, llama, openai] = sent
  assert.equal(openai.url, 'http://localhost:1234/v1/chat/completions')
  assert.equal((openai.body as { messages: { content: string }[] }).messages[0].content, expected)
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

test('installed: each provider\'s own list; the Claude provider asks the gateway with no key in the page, or with one', async () => {
  const srv = anyServer()
  const r = createMindRouter({ fetch: srv.f })
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

function bridgeOver(fetchFn: FetchLike, diary?: Diary): TerminalBridge {
  const sim = {} as SimControls
  const op = operatorBridge(sim, gate(), createMindRouter({ fetch: fetchFn }), undefined, { diary })
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
  assert.deepEqual(shell('ask provider gpt', b, []).lines, [{ kind: 'err', text: 'ask: ask connect takes claude, ollama, llamacpp, openai, scripted, then an optional server url and, for claude, a key' }])
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
  assert.deepEqual(shell('ask connect openai http://localhost:1234', b, []).lines, [{ kind: 'out', text: `provider  ${PROVIDER_TEXT.openai}; server http://localhost:1234` }])
  assert.deepEqual((await shell('ask rust: hi', b, []).pending)?.[0], { kind: 'out', text: 'llama says hi' })
  assert.deepEqual(shell('ask key', b, []).lines, [{ kind: 'err', text: 'usage: ask key <key|none>' }])
})

test('14A over any provider: an inadmissible prompt reaches no server, streams nothing, answers "no reply" and is not remembered; a refusal by the model is the same no reply', async () => {
  const srv = anyServer()
  const notes: string[] = []
  const diary: Diary = { recall: () => [], note: (_b, kind, _s, text) => { notes.push(`${kind}: ${text}`) } }
  const b = bridgeOver(srv.f, diary)
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
  shell('ask provider llamacpp', b, [])
  const fine = await shell('ask rust: how does grip work?', b, []).pending
  assert.equal(fine?.[0]?.text, 'llama says hi')
  assert.deepEqual(notes, ['ask: how does grip work? → llama says hi'])
  // The model's own refusal (the Claude API's stop reason) is the agent not engaging too.
  const refusing: FetchLike = async () => stream(sse({ type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 0 } }, { type: 'message_stop' }), 'text/event-stream')
  const c = bridgeOver(refusing, diary)
  shell('operator unlock', c, [])
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
  const r = createMindRouter({ fetch: srv.f })
  const expected = promptHash(systemPrompt([TETHER]))
  for (const p of PROVIDERS) {
    r.setProvider(p)
    const a = await r.answer({ tethers: [TETHER], prompt: 'hi', signal: new AbortController().signal }, () => {})
    assert.equal(a.promptHash, expected, p)
  }
})
