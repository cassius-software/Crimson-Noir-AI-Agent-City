// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the cloud fallback throttle: the rolling frame rate (unknown
 * until the window holds enough frames, a single long frame deciding nothing), what counts as a complex prompt, and
 * the routing: to the cloud provider only when the frames are slow, a local provider is chosen, the prompt is complex
 * and a cloud provider exists; to the mind itself in every other case, pieces and answers passed through untouched.
 * It also drives the real cognition router (router.ts) behind the throttle, so an offloaded prompt is seen to reach
 * the Claude provider's gateway on this machine and nowhere else.
 * What breaks if it is removed? A prompt could leave for the cloud on one slow frame, or never leave at all.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FALLBACK, FrameRate, isComplex, LOCAL_PROVIDERS, withCloudFallback, type AnswerRequest } from './cloudFallback.ts'
import { CognitionError } from './localCompute.ts'
import { createMindRouter } from './router.ts'
import type { Answer, Mind, Piece } from '../07_Execute_Actions/operator.ts'

const tether = (agent: number) => ({ agent, serial: agent, skills: ['talk'] })
const request = (over: Partial<AnswerRequest> = {}): AnswerRequest => ({ tethers: [tether(1)], prompt: 'hello', signal: new AbortController().signal, ...over })

/** A rate fed `n` frames at a steady `fps`, ending at `end` ms. */
function steady(fps: number, n: number, end = 10_000): FrameRate {
  const r = new FrameRate()
  for (let k = n - 1; k >= 0; k--) r.push(end - (k * 1000) / fps)
  return r
}

test('the frame rate is unknown until the window holds FALLBACK.minFrames, then the rate over the window', () => {
  const r = new FrameRate()
  assert.equal(r.fps(), null, 'nothing pushed')
  for (let k = 0; k < FALLBACK.minFrames - 1; k++) r.push(k * 16)
  assert.equal(r.fps(), null, 'one frame short')
  r.push((FALLBACK.minFrames - 1) * 16)
  assert.ok(Math.abs(r.fps()! - 62.5) < 1e-9, `${r.fps()} fps`)
  assert.equal(r.slow, false)
  assert.equal(steady(60, 200).fps()!.toFixed(1), '60.0')
  assert.equal(steady(24, 100).fps()!.toFixed(1), '24.0')
  assert.equal(steady(24, 100).slow, true)
  assert.equal(steady(FALLBACK.fps, 100).slow, false, 'at the threshold is not below it')
  // Frames older than the window are ignored: a burst long ago does not count against a page that is fine now.
  const r2 = new FrameRate()
  for (let k = 0; k < 100; k++) r2.push(k * 50) // 20 fps up to 5 s
  for (let k = 0; k < 150; k++) r2.push(5000 + k * 16) // 62 fps for the next 2.4 s
  assert.ok(r2.fps()! > 55, `${r2.fps()} fps: the old slow frames have left the window`)
  // One long frame in a smooth run decides nothing.
  const r3 = steady(60, 100)
  r3.push(10_000 + 400)
  assert.ok(r3.fps()! > 40, `${r3.fps()} fps after one 400 ms frame`)
  assert.equal(r3.slow, false)
  // A non-finite time is ignored; the ring wraps without losing the newest frames.
  r3.push(NaN)
  const r4 = new FrameRate(8)
  for (let k = 0; k < 100; k++) r4.push(k * 10)
  assert.equal(r4.fps(), null, 'a ring of 8 never holds minFrames')
})

test('a complex intent: more than one person, a long prompt, or memories in it', () => {
  assert.equal(isComplex(request()), false)
  assert.equal(isComplex(request({ tethers: [tether(1), tether(1)] })), false, 'the same person twice is one person')
  assert.equal(isComplex(request({ tethers: [tether(1), tether(2)] })), true)
  assert.equal(isComplex(request({ prompt: 'x'.repeat(FALLBACK.promptChars) })), false)
  assert.equal(isComplex(request({ prompt: 'x'.repeat(FALLBACK.promptChars + 1) })), true)
  assert.equal(isComplex(request({ memories: [{ agent: 1, lines: [] }] })), false)
  assert.equal(isComplex(request({ memories: [{ agent: 1, lines: ['they asked my name'] }] })), true)
  assert.deepEqual([...LOCAL_PROVIDERS], ['ollama', 'llamacpp', 'openai'])
})

/** A mind that records what it was asked and streams one piece. */
function fakeMind(name: string, provider?: string): Mind & { asked: AnswerRequest[]; provider?: string; cloud?: Mind; setProvider(p: string): string } {
  const asked: AnswerRequest[] = []
  const m = {
    asked,
    provider,
    settings: () => ({ server: `http://localhost:${name.length}`, model: name, ...(m.provider !== undefined && { provider: m.provider }) }),
    setServer: (url: string) => url,
    setModel: (n: string) => n,
    setProvider: (p: string) => { m.provider = p; return p },
    installed: async () => [name],
    answer: async (req: AnswerRequest, onPiece: (p: Piece) => void): Promise<Answer> => {
      asked.push(req)
      onPiece({ kind: 'text', text: `${name} says hi` })
      return { text: `${name} says hi`, thinking: 0, tokens: 3, reason: 'stop' }
    },
  }
  return m
}

test('routing: the cloud provider only when slow, local, complex and present; the mind otherwise; pieces and answers pass through', async () => {
  const cloud = fakeMind('cloud')
  const local = fakeMind('local', 'ollama')
  local.cloud = cloud
  const slow = steady(20, 100), fine = steady(60, 100), unknown = new FrameRate()
  const complex = request({ tethers: [tether(1), tether(2)] })
  const simple = request()
  const pieces: Piece[] = []
  const onPiece = (p: Piece) => { pieces.push(p) }

  const throttled = withCloudFallback(local, slow)
  assert.equal(throttled.fallback.throttled, true)
  const a = await throttled.answer(complex, onPiece)
  assert.equal(a.text, 'cloud says hi')
  assert.deepEqual(pieces, [{ kind: 'text', text: 'cloud says hi' }])
  assert.equal(cloud.asked.length, 1)
  assert.equal(cloud.asked[0], complex, 'the very request, tethers and all')
  assert.equal(local.asked.length, 0)
  assert.equal(throttled.fallback.offloaded, 1)
  await throttled.answer(simple, onPiece)
  assert.equal(local.asked.length, 1, 'a simple prompt stays local even when slow')
  assert.equal(throttled.fallback.offloaded, 1)
  assert.match(throttled.settings().fallback!, /^on: complex prompts go to the Claude API below 30 fps \(20 fps; 1 sent so far\)$/)

  // The frames are fine: nothing leaves.
  const calm = withCloudFallback(local, fine)
  await calm.answer(complex, onPiece)
  assert.equal(cloud.asked.length, 1)
  assert.equal(local.asked.length, 2)
  assert.equal(calm.fallback.throttled, false)
  assert.match(calm.settings().fallback!, /^off: .*\(60 fps; 0 sent so far\)$/)

  // The rate is not known yet: nothing leaves, and the line says so.
  const fresh = withCloudFallback(local, unknown)
  await fresh.answer(complex, onPiece)
  assert.equal(cloud.asked.length, 1)
  assert.match(fresh.settings().fallback!, /frame rate not yet known/)

  // The cloud provider is the chosen one already: nothing to fall back to, the mind answers.
  local.setProvider('claude')
  const already = withCloudFallback(local, slow)
  await already.answer(complex, onPiece)
  assert.equal(cloud.asked.length, 1)
  assert.equal(local.asked.length, 4)
  assert.equal(already.fallback.throttled, false)
  assert.match(already.settings().fallback!, /^off: the claude provider is not on this machine's compute$/)
  // A swap back at the console (the setter is the mind's own) turns the throttle on again, live.
  already.setProvider!('llamacpp')
  assert.equal(already.fallback.throttled, true)
  await already.answer(complex, onPiece)
  assert.equal(cloud.asked.length, 2)
  // An OpenAI-compatible server on this machine (LM Studio and the like) shares the GPU too, so it is spared the same way.
  already.setProvider!('openai')
  assert.equal(already.fallback.throttled, true)
  await already.answer(complex, onPiece)
  assert.equal(cloud.asked.length, 3)
  assert.equal(local.asked.length, 4)
  // The script asks no model at all: nothing to move, and the line says so rather than calling it remote.
  already.setProvider!('scripted')
  assert.equal(already.fallback.throttled, false)
  assert.equal(already.settings().fallback, 'off: the scripted provider asks no model, so there is nothing to move')
  // A model running in this page shares the frames too, but it is never moved (a phone has no gateway), and the line
  // says so in its own words rather than calling it remote; chosen, or found by auto.
  for (const how of [{ provider: 'inpage' }, { provider: 'auto', found: 'inpage' }]) {
    const page = { ...fakeMind('page'), cloud, settings: () => ({ server: 'this page', model: 'tiny.gguf', ...how }) }
    const kept = withCloudFallback(page, slow)
    assert.equal(kept.fallback.throttled, false, JSON.stringify(how))
    assert.equal(kept.settings().fallback, 'off: the model in this page is never moved to the gateway')
    const before: number = cloud.asked.length
    assert.equal((await kept.answer(complex, onPiece)).text, 'page says hi')
    assert.equal(cloud.asked.length, before, 'the complex prompt stayed in the page')
  }

  // No cloud provider at all: the throttle does nothing but say so.
  const alone = fakeMind('alone', 'ollama')
  const none = withCloudFallback(alone, slow)
  await none.answer(complex, onPiece)
  assert.equal(alone.asked.length, 1)
  assert.equal(none.fallback.throttled, false)
  assert.equal(none.settings().fallback, 'none: this mind has no cloud provider')
  assert.equal(none.settings().model, 'alone', 'the other settings are the mind\'s own')
  assert.deepEqual(await none.installed(), ['alone'])
  assert.ok(Object.isFrozen(none))
})

test('behind the throttle, the real router sends an offloaded prompt to the Claude gateway on this machine and nowhere else', async () => {
  const urls: string[] = []
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    urls.push(url)
    if (url.endsWith('/v1/messages')) {
      const body = JSON.parse(String(init?.body)) as { model: string; system: string }
      assert.equal(body.model, 'claude-opus-5-5')
      assert.match(body.system, /city simulation/)
      const sse = [
        'event: message_start', 'data: {"type":"message_start","message":{"usage":{"output_tokens":0}}}', '',
        'event: content_block_delta', 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"from the cloud"}}', '',
        'event: message_delta', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}', '',
        'event: message_stop', 'data: {"type":"message_stop"}', '',
      ].join('\n')
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    // The local server is never asked while the throttle is on.
    return new Response(JSON.stringify({ response: 'from the local model', done: true, done_reason: 'stop', eval_count: 4 }), { status: 200 })
  }
  const router = createMindRouter({ fetch: fetchFn })
  router.setProvider('ollama')
  const mind = withCloudFallback(router, steady(15, 100))
  const complex = request({ tethers: [tether(1), tether(2)] })
  const pieces: Piece[] = []
  const answer = await mind.answer(complex, (p) => { pieces.push(p) })
  assert.equal(answer.text, 'from the cloud')
  assert.deepEqual(pieces.map((p) => (p.kind === 'text' ? p.text : p.kind)), ['from the cloud'])
  assert.ok(answer.promptHash, 'the hash of the exact system prompt, as every provider gives')
  assert.deepEqual(urls, ['http://localhost:8089/v1/messages'], 'the Claude gateway on this machine, once')
  assert.equal(mind.fallback.offloaded, 1)
  // A simple prompt still goes to the local server.
  urls.length = 0
  const simple = await mind.answer(request(), () => {})
  assert.equal(simple.text, 'from the local model')
  assert.ok(urls.every((u) => u.startsWith('http://localhost:11434/')), urls.join(', '))
})

test('a prompt carrying the last moments with someone is complex too', () => {
  const ctx = (recent: number) => [{ agent: 1, surroundings: null, recent: Array.from({ length: recent }, (_, i) => ({ who: 'the player', what: `said ${i}`, where: '', at: i, clock: '17:00' })) }]
  assert.equal(isComplex(request({ context: ctx(0) })), false, 'surroundings alone are cheap')
  assert.equal(isComplex(request({ context: ctx(1) })), true)
})

test('a gateway that is not there: the local model answers after all, prompts stay local for FALLBACK.retryMs, then the gateway is tried again', async () => {
  assert.equal(FALLBACK.retryMs, 60_000)
  const cloud = fakeMind('cloud')
  let up = false
  const realCloud = cloud.answer
  cloud.answer = async (req, onPiece) => {
    if (!up) { cloud.asked.push(req); throw new CognitionError('offline', 'no gateway to the Claude API is answering') }
    return realCloud(req, onPiece)
  }
  const local = fakeMind('local', 'ollama')
  local.cloud = cloud
  let t = 1_000_000
  const mind = withCloudFallback(local, steady(20, 100), () => t)
  const complex = request({ tethers: [tether(1), tether(2)] })
  const pieces: Piece[] = []
  const a = await mind.answer(complex, (p) => { pieces.push(p) })
  assert.equal(a.text, 'local says hi', 'the operator hears an answer, from the model they chose')
  assert.deepEqual(pieces, [{ kind: 'text', text: 'local says hi' }])
  assert.deepEqual([cloud.asked.length, local.asked.length], [1, 1])
  assert.deepEqual({ ...mind.fallback, fps: null }, { fps: null, throttled: false, offloaded: 1, missed: 1 })
  assert.match(mind.settings().fallback!, /^off: .*\(20 fps; 1 sent so far; 1 of them unanswered there, so answered here, and prompts stay here for a minute\)$/)
  // Inside the window the gateway is not asked again.
  t += FALLBACK.retryMs - 1
  await mind.answer(complex, () => {})
  assert.deepEqual([cloud.asked.length, local.asked.length], [1, 2])
  // After it, the gateway is tried again, and now it answers.
  t += 1
  up = true
  assert.equal((await mind.answer(complex, () => {})).text, 'cloud says hi')
  assert.equal(mind.fallback.offloaded, 2)
  assert.match(mind.settings().fallback!, /^on: .*2 sent so far; 1 of them unanswered there, so answered here\)$/)
})

test('the gateway failing once its answer has begun is that answer\'s failure, and the operator\'s stop is not a miss', async () => {
  const cloud = fakeMind('cloud')
  cloud.answer = async (_req, onPiece) => {
    onPiece({ kind: 'text', text: 'half' })
    throw new CognitionError('server', 'the Claude API failed (529)')
  }
  const local = fakeMind('local', 'llamacpp')
  local.cloud = cloud
  const mind = withCloudFallback(local, steady(20, 100))
  await assert.rejects(mind.answer(request({ tethers: [tether(1), tether(2)] }), () => {}), /529/)
  assert.equal(local.asked.length, 0)
  assert.equal(mind.fallback.missed, 0)

  const ctl = new AbortController()
  const slowCloud = fakeMind('cloud')
  slowCloud.answer = async (req) => {
    ctl.abort(new Error('stopped by the operator'))
    throw req.signal.reason
  }
  const local2 = fakeMind('local', 'ollama')
  local2.cloud = slowCloud
  const stopped = withCloudFallback(local2, steady(20, 100))
  await assert.rejects(stopped.answer(request({ tethers: [tether(1), tether(2)], signal: ctl.signal }), () => {}), /stopped by the operator/)
  assert.equal(local2.asked.length, 0)
  assert.equal(stopped.fallback.missed, 0)
})

test('under the auto provider the throttle follows what auto found: a local server is spared, the gateway is not moved, nothing found is said', async () => {
  const cloud = fakeMind('cloud')
  const auto = fakeMind('auto', 'auto') as ReturnType<typeof fakeMind> & { found?: string }
  const settings = auto.settings
  auto.settings = () => ({ ...settings(), ...(auto.found !== undefined && { found: auto.found }) })
  auto.cloud = cloud
  const mind = withCloudFallback(auto, steady(20, 100))
  assert.equal(mind.settings().fallback, 'off: no model has been found on this machine yet')
  assert.equal(mind.fallback.throttled, false)
  auto.found = 'ollama'
  assert.equal(mind.fallback.throttled, true)
  await mind.answer(request({ tethers: [tether(1), tether(2)] }), () => {})
  assert.equal(cloud.asked.length, 1)
  auto.found = 'claude'
  assert.equal(mind.settings().fallback, 'off: the claude provider is not on this machine\'s compute')
})
