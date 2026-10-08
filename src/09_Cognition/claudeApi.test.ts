// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the Claude API provider (claudeApi.ts): only a gateway on this machine (http or
 * https to a loopback address) is ever addressed, and nothing is sent without a key; the request is the one the API takes (the version and key
 * headers, the browser-access header, streaming, the system prompt, the prompt as a user message, adaptive thinking,
 * the refusal fallback); the server-sent events stream piece by piece, thinking apart from text, however the bytes are
 * cut; the stop reason and the tokens are read; a refusal ends as 'refusal'; every failure is one plain sentence; the
 * moment the signal aborts the request is cancelled; and the models are listed by id.
 * What breaks if it is removed? A prompt could go to a server the provider may not speak to, or a key be sent to it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRng } from '../02_Define_The_Rules/degrees.ts'
import type { Answer } from '../07_Execute_Actions/operator.ts'
import { ANTHROPIC_BETAS, ANTHROPIC_VERSION, CLAUDE_GATEWAY, CLAUDE_ANSWER_TOKENS, claudeAnswer, claudeModels, claudeServer, DEFAULT_CLAUDE_MODEL, EFFORTS, maskKey } from './claudeApi.ts'
import { loopbackServer } from '../02_Define_The_Rules/airgap.ts'
import { CognitionError, type FetchLike } from './localCompute.ts'

const enc = new TextEncoder()
const sse = (...events: object[]): string => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')

/** An answer as the API streams it: a thinking summary, text in two deltas with multi-byte characters, then the stop. */
const SAMPLE = sse(
  { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: 40, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Grip first…' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'ping' },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Grip scales ' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'tyre friction — naïve 東京.' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 42 } },
  { type: 'message_stop' },
)

function streamed(text: string, cuts: readonly number[] = []): Response {
  const bytes = enc.encode(text)
  const bounds = [0, ...[...new Set(cuts)].filter((c) => c > 0 && c < bytes.length).sort((a, b) => a - b), bytes.length]
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i + 1 < bounds.length; i++) controller.enqueue(bytes.slice(bounds[i], bounds[i + 1]))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function fakeFetch(reply: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = []
  const f: FetchLike = async (url, init) => {
    calls.push({ url, init })
    return reply(url, init)
  }
  return { f, calls }
}

const REQ = { server: CLAUDE_GATEWAY, key: 'sk-ant-test-0123456789', model: DEFAULT_CLAUDE_MODEL, system: 'SYSTEM', prompt: 'how does grip work?' }

async function collect(res: Response, req = REQ): Promise<{ pieces: string[]; answer: Answer | null; error: unknown }> {
  const pieces: string[] = []
  try {
    const answer = await claudeAnswer(fakeFetch(() => res).f, req, (p) => pieces.push(`${p.kind}:${p.text}`))
    return { pieces, answer, error: null }
  } catch (error) {
    return { pieces, answer: null, error }
  }
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('the provider speaks only to a gateway on this machine (http or https to loopback, no credentials); the gateway port is the default; the API itself is refused', () => {
  assert.equal(CLAUDE_GATEWAY, 'http://localhost:8089')
  assert.equal(claudeServer(CLAUDE_GATEWAY), 'http://localhost:8089')
  assert.equal(claudeServer('http://localhost:4000'), 'http://localhost:4000')
  assert.equal(claudeServer('http://127.0.0.1:4000/x'), 'http://127.0.0.1:4000')
  assert.equal(claudeServer('https://[::1]:8443/v1/'), 'https://[::1]:8443')
  for (const bad of ['https://api.anthropic.com', 'https://gateway.example.com/v1/', 'http://api.anthropic.com', 'http://192.168.1.2:4000', 'https://user:pw@localhost:8089', 'ws://localhost:8089', 'ftp://localhost', 'not a url', '', 42, null, undefined]) {
    assert.equal(claudeServer(bad), null, String(bad))
  }
  assert.equal(claudeServer, loopbackServer, 'the gate itself, under this name')
  for (const url of ['http://localhost:8089', 'https://api.anthropic.com', 'http://user@localhost']) assert.equal(claudeServer(url), loopbackServer(url), url)
  assert.equal(DEFAULT_CLAUDE_MODEL, 'claude-opus-5-5')
  assert.deepEqual(EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max'])
})

test('a key is shown masked: its first six and last four characters, never the whole; a short one only as dots', () => {
  assert.equal(maskKey('sk-ant-api03-abcdefghijklmnop-1234'), 'sk-ant…1234')
  assert.equal(maskKey('short'), '••••')
  assert.equal(maskKey(''), null)
  assert.equal(maskKey(null), null)
})

test('the request is the one the API takes: headers, streaming, the system prompt, the prompt as a user message, adaptive thinking, the fallback, the effort', async () => {
  const { f, calls } = fakeFetch(() => streamed(SAMPLE))
  await claudeAnswer(f, { ...REQ, effort: 'low' }, () => {})
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://localhost:8089/v1/messages')
  const init = calls[0].init!
  assert.equal(init.method, 'POST')
  const h = init.headers as Record<string, string>
  assert.equal(h['x-api-key'], REQ.key)
  assert.equal(h['anthropic-version'], ANTHROPIC_VERSION)
  assert.equal(h['anthropic-beta'], ANTHROPIC_BETAS)
  assert.equal(h['anthropic-dangerous-direct-browser-access'], 'true')
  assert.equal(init.referrerPolicy, 'no-referrer')
  const body = JSON.parse(String(init.body))
  assert.deepEqual(body, {
    model: DEFAULT_CLAUDE_MODEL, max_tokens: CLAUDE_ANSWER_TOKENS, stream: true, system: 'SYSTEM',
    messages: [{ role: 'user', content: 'how does grip work?' }],
    thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'low' }, fallbacks: 'default',
  })
  const { calls: plain } = await (async () => {
    const ff = fakeFetch(() => streamed(SAMPLE))
    await claudeAnswer(ff.f, REQ, () => {})
    return ff
  })()
  assert.equal('output_config' in JSON.parse(String(plain[0].init!.body)), false, 'no effort: the API\'s default')
})

test('an answer streams piece by piece, thinking apart from text; the stop reason and the tokens are read', async () => {
  const r = await collect(streamed(SAMPLE))
  assert.equal(r.error, null)
  assert.deepEqual(r.pieces, ['thinking:Grip first…', 'text:Grip scales ', 'text:tyre friction — naïve 東京.'])
  assert.deepEqual(r.answer, { text: 'Grip scales tyre friction — naïve 東京.', thinking: 1, tokens: 42, reason: 'stop' })
})

test('however the bytes arrive (every single cut, 300 seeded pairs, one byte at a time), the answer is the same', async () => {
  const whole = await collect(streamed(SAMPLE))
  const n = enc.encode(SAMPLE).length
  for (let c = 1; c < n; c++) assert.deepEqual(await collect(streamed(SAMPLE, [c])), whole, `cut at ${c}`)
  const rng = createRng(7)
  for (let i = 0; i < 300; i++) {
    const cuts = [Math.floor(rng() * n), Math.floor(rng() * n)]
    assert.deepEqual(await collect(streamed(SAMPLE, cuts)), whole, `cuts at ${cuts.join(',')}`)
  }
  assert.deepEqual(await collect(streamed(SAMPLE, Array.from({ length: n }, (_, i) => i))), whole, 'byte by byte')
})

test('max_tokens ends as length; a refusal (whichever model ran) ends as refusal with what came before; a stop without message_stop is still done', async () => {
  const length = sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } }, { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 3 } }, { type: 'message_stop' })
  assert.deepEqual((await collect(streamed(length))).answer, { text: 'a', thinking: 0, tokens: 3, reason: 'length' })
  const refusal = sse({ type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 0 } }, { type: 'message_stop' })
  assert.deepEqual((await collect(streamed(refusal))).answer, { text: '', thinking: 0, tokens: 0, reason: 'refusal' })
  const noStop = sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
  assert.deepEqual((await collect(streamed(noStop))).answer, { text: 'a', thinking: 0, tokens: 1, reason: 'stop' })
})

test('every way the API can fail is one plain sentence: no key, a bad address, 401, 403, no such model, 429, 529, 400, an error event, unreadable, cut short, the network', async () => {
  const fail = async (res: Response | (() => Promise<Response>), req = REQ): Promise<CognitionError> => {
    const r = await collect(typeof res === 'function' ? await res() : res, req)
    assert.ok(r.error instanceof CognitionError, `expected a CognitionError, got ${String(r.error)}`)
    return r.error
  }
  // No key in the page: the request still goes to the gateway on this machine, with no key header (the gateway adds it).
  const keyless = fakeFetch(() => streamed(SAMPLE))
  await claudeAnswer(keyless.f, { ...REQ, key: '' }, () => {})
  assert.equal(keyless.calls[0].url, 'http://localhost:8089/v1/messages')
  assert.equal('x-api-key' in (keyless.calls[0].init!.headers as Record<string, string>), false, 'no key header at all')
  const off = await fail(streamed(SAMPLE), { ...REQ, server: 'https://api.anthropic.com' })
  assert.equal(off.code, 'refused')
  assert.equal(off.message, "the Claude provider speaks only to a gateway on this machine (localhost, 127.0.0.1 or [::1]), not 'https://api.anthropic.com'")
  const e401 = await fail(json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }))
  assert.deepEqual([e401.code, e401.message], ['refused', 'the Claude API did not accept the key (401): invalid x-api-key; set it in the gateway on this machine, or with ask key <key>'])
  const e403 = await fail(json(403, { type: 'error', error: { type: 'permission_error', message: 'nope' } }))
  assert.deepEqual([e403.code, e403.message], ['refused', 'the Claude API refused this request (403): nope'])
  const e404 = await fail(json(404, { type: 'error', error: { type: 'not_found_error', message: 'model: x' } }))
  assert.deepEqual([e404.code, e404.message], ['model', `the Claude API has no model '${DEFAULT_CLAUDE_MODEL}': choose one it lists (type ask)`])
  const e429 = await fail(json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }))
  assert.deepEqual([e429.code, e429.message], ['server', 'the Claude API is rate limiting this key (429): slow down; try again in a moment'])
  const e529 = await fail(json(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))
  assert.deepEqual([e529.code, e529.message], ['server', 'the Claude API is overloaded (529); try again in a moment'])
  const e400 = await fail(json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens too large\nsecond line' } }))
  assert.deepEqual([e400.code, e400.message], ['server', 'the Claude API failed (400): max_tokens too large'])
  const e500 = await fail(new Response('boom', { status: 500 }))
  assert.deepEqual([e500.code, e500.message], ['server', 'the Claude API failed (500)'])
  const mid = await fail(streamed(sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })))
  assert.deepEqual([mid.code, mid.message], ['server', 'the Claude API failed mid-answer: Overloaded'])
  const unreadable = await fail(streamed('data: {not json\n\n'))
  assert.deepEqual([unreadable.code, unreadable.message], ['unreadable', "the Claude API's answer could not be read"])
  const short = await fail(streamed(sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } })))
  assert.equal(short.code, 'unreadable')
  const pieces: string[] = []
  const net = await claudeAnswer(async () => { throw new TypeError('fetch failed') }, REQ, (p) => pieces.push(p.text)).then(() => null, (e: unknown) => e)
  assert.ok(net instanceof CognitionError)
  assert.deepEqual([net.code, net.message], ['offline', 'no gateway to the Claude API is answering at http://localhost:8089: start one on this machine (ask server <url>), or ask provider ollama for a model on this machine'])
})

test('the moment the signal aborts mid-answer, the answer rejects with its reason and nothing more arrives', async () => {
  let release: () => void = () => {}
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first ' } })))
      release = () => {
        // The reader was cancelled by the abort, so the stream may already be closed: what matters is that nothing arrives.
        try {
          controller.enqueue(enc.encode(sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'never' } })))
          controller.close()
        } catch {
          // already closed
        }
      }
    },
  })
  const ctrl = new AbortController()
  const pieces: string[] = []
  const p = claudeAnswer(fakeFetch(() => new Response(body, { status: 200 })).f, { ...REQ, signal: ctrl.signal }, (piece) => pieces.push(piece.text))
  await new Promise((r) => setTimeout(r, 10))
  const reason = new DOMException('tether lost', 'AbortError')
  ctrl.abort(reason)
  await assert.rejects(p, (e: unknown) => e === reason)
  release()
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(pieces, ['first '])
  const early = new AbortController()
  early.abort(new Error('already'))
  await assert.rejects(claudeAnswer(async () => { throw new DOMException('aborted', 'AbortError') }, { ...REQ, signal: early.signal }, () => {}), /already/)
})

test('the models the API lists, by id, sorted; its failures in the same plain words; no key in the page sends none', async () => {
  const { f, calls } = fakeFetch(() => json(200, { data: [{ id: 'claude-sonnet-5-5', type: 'model' }, { id: 'claude-opus-5-5', type: 'model' }, { nope: 1 }], has_more: false }))
  assert.deepEqual(await claudeModels(f, CLAUDE_GATEWAY, 'k'), ['claude-opus-5-5', 'claude-sonnet-5-5'])
  assert.equal(calls[0].url, 'http://localhost:8089/v1/models?limit=100')
  assert.equal((calls[0].init!.headers as Record<string, string>)['x-api-key'], 'k')
  assert.deepEqual(await claudeModels(f, CLAUDE_GATEWAY, ''), ['claude-opus-5-5', 'claude-sonnet-5-5'])
  assert.equal('x-api-key' in (calls[1].init!.headers as Record<string, string>), false, 'the gateway adds the key')
  await assert.rejects(claudeModels(f, 'https://api.anthropic.com', 'k'), (e: CognitionError) => e.code === 'refused')
  assert.equal(calls.length, 2, 'nothing was sent off this machine')
  await assert.rejects(claudeModels(fakeFetch(() => json(401, { type: 'error', error: { type: 'authentication_error', message: 'bad' } })).f, CLAUDE_GATEWAY, 'k'), (e: CognitionError) => e.code === 'refused')
  await assert.rejects(claudeModels(fakeFetch(() => json(200, { nope: [] })).f, CLAUDE_GATEWAY, 'k'), (e: CognitionError) => e.code === 'unreadable')
  await assert.rejects(claudeModels(fakeFetch(() => new Response('<html>', { status: 200 })).f, CLAUDE_GATEWAY, 'k'), (e: CognitionError) => e.code === 'unreadable')
})
