// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the local speech client (localSpeech.ts) and the operator's whole path to it.
 * Only a server on this machine is ever addressed. The request carries the text, the voice, the model only once one
 * is chosen, and asks for WAV; the audio comes back byte for byte however it is cut. Every way the server can fail is
 * one plain sentence, and so are no text, too much text and too much audio. The moment the signal aborts, the request
 * is cancelled. The settings are kept, and nothing is guessed: no voice, no request. Over a real socket, an abort
 * closes the connection. And from the console, through the gateway, to a real server and out through the soundscape's
 * contract: Rejected never reaches the server, the speech is placed at the person it is bound to, the tether breaking
 * mid-word stops it, the operator can stop it, and a server that is not running is a sentence.
 * What breaks if it is removed? Text could go off the machine, a voice keep speaking after the person was left behind,
 * or a stopped server crash the console, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { operatorBridge, SAY_CHARS, type SimControls, type SpeechClip, type SpeechOut, type Utterance } from '../07_Execute_Actions/operator.ts'
import type { RecruitView } from '../07_Execute_Actions/simProtocol.ts'
import type { TerminalBridge } from '../07_Execute_Actions/terminal/bridge.ts'
import { run as shell } from '../07_Execute_Actions/terminal/commands.ts'
import { TaskRouter, type SwarmSource } from '../08_Swarm/taskRouter.ts'
import { createLocalCompute, type FetchLike } from './localCompute.ts'
import {
  createLocalSpeech, DEFAULT_SPEECH_SERVER, elevenVoices, maskSpeechKey, SPEECH_BYTES, SPEECH_CHARS, SpeechError, speechVoices, synthesize, synthesizeEleven,
} from './localSpeech.ts'

// ---------------------------------------------------------------- helpers

/** A tiny mono 16-bit WAV: a 44-byte header and `samples` samples of a ramp. */
function wav(samples = 480, rate = 24000): Uint8Array {
  const b = new Uint8Array(44 + samples * 2)
  const v = new DataView(b.buffer)
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) b[at + i] = s.charCodeAt(i) }
  ascii(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); ascii(8, 'WAVE')
  ascii(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  ascii(36, 'data'); v.setUint32(40, samples * 2, true)
  for (let i = 0; i < samples; i++) v.setInt16(44 + i * 2, ((i * 97) % 2000) - 1000, true)
  return b
}

/** A response whose body delivers `bytes` cut at the given offsets (each piece its own chunk). */
function chunked(bytes: Uint8Array, cuts: readonly number[] = [], type = 'audio/wav'): Response {
  const bounds = [0, ...[...new Set(cuts)].filter((c) => c > 0 && c < bytes.length).sort((a, b) => a - b), bytes.length]
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i + 1 < bounds.length; i++) controller.enqueue(bytes.slice(bounds[i], bounds[i + 1]))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': type } })
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

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const within = <T,>(p: Promise<T>, ms = 2000): Promise<T> => Promise.race([p, sleep(ms).then((): never => { throw new Error(`still waiting after ${ms} ms`) })])

/**
 * Waits until the server has seen every request end (its last byte written, or the client gone), at most 2 s: a
 * socket's close can take a while to reach the server when the machine is busy (the whole suite runs at once).
 */
const ended = async (srv: { seen: readonly { ended: string | null }[] }): Promise<void> => {
  for (let t = 0; t < 2000 && srv.seen.some((r) => r.ended === 'open' || r.ended === null); t += 20) await sleep(20)
}
const REQ = { server: DEFAULT_SPEECH_SERVER, model: null, voice: 'v1', text: 'Over here.' }

/** What a synthesize over `reply` threw (it must throw a SpeechError). */
async function failure(reply: () => Response | Promise<Response>, req: Partial<typeof REQ> = {}): Promise<SpeechError> {
  try {
    await synthesize(fakeFetch(reply).f, { ...REQ, ...req })
  } catch (e) {
    assert.ok(e instanceof SpeechError, `not a SpeechError: ${String(e)}`)
    return e
  }
  throw new Error('it did not fail')
}

// ---------------------------------------------------------------- the client

test('only a server on this machine is ever addressed; nothing is sent for no text or too much of it', async () => {
  const { f, calls } = fakeFetch(() => chunked(wav()))
  for (const server of ['http://example.com', 'http://10.0.0.2:8880', 'http://localhost.example.com', 'http://user:pw@localhost:8880', 'ftp://localhost', 'not a url']) {
    await assert.rejects(synthesize(f, { ...REQ, server }), (e: unknown) => e instanceof SpeechError && e.code === 'refused', server)
    await assert.rejects(speechVoices(f, server), (e: unknown) => e instanceof SpeechError && e.code === 'refused', server)
  }
  for (const text of ['', '   \n ', 'x'.repeat(SPEECH_CHARS + 1)]) {
    await assert.rejects(synthesize(f, { ...REQ, text }), (e: unknown) => e instanceof SpeechError && e.code === 'text')
  }
  assert.equal(calls.length, 0, 'nothing was sent')
  await synthesize(f, { ...REQ, server: 'http://127.0.0.1:9', text: 'x'.repeat(SPEECH_CHARS) })
  await synthesize(f, { ...REQ, server: 'http://[::1]:9' })
  assert.deepEqual(calls.map((c) => c.url), ['http://127.0.0.1:9/v1/audio/speech', 'http://[::1]:9/v1/audio/speech'])
  assert.equal(SAY_CHARS, SPEECH_CHARS, "the operator tier's cut and the client's limit agree")
})

test('the request: the text, the voice, the model once chosen, WAV asked for; the audio comes back byte for byte however it is cut', async () => {
  const audio = wav(3000)
  const { f, calls } = fakeFetch(() => chunked(audio, [1, 44, 45, 3001]))
  const got = new Uint8Array(await synthesize(f, { ...REQ, text: '  Over here, by the lamp.  ' }))
  assert.deepEqual(got, audio)
  const c = calls[0]
  assert.equal(c.url, `${DEFAULT_SPEECH_SERVER}/v1/audio/speech`)
  assert.equal(c.init?.method, 'POST')
  assert.equal(c.init?.cache, 'no-store')
  assert.equal(c.init?.referrerPolicy, 'no-referrer')
  assert.deepEqual(JSON.parse(String(c.init?.body)), { input: 'Over here, by the lamp.', voice: 'v1', response_format: 'wav' }, 'no model until one is chosen')
  await synthesize(f, { ...REQ, model: 'open-tts' })
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { model: 'open-tts', input: 'Over here.', voice: 'v1', response_format: 'wav' })
  // One byte at a time, and a server that names no type: the same bytes.
  assert.deepEqual(new Uint8Array(await synthesize(fakeFetch(() => chunked(audio, Array.from({ length: audio.length }, (_, i) => i), '')).f, REQ)), audio)
  assert.deepEqual(new Uint8Array(await synthesize(fakeFetch(() => chunked(audio, [], 'application/octet-stream')).f, REQ)), audio)
})

test('every way the server can fail is one plain sentence', async () => {
  assert.equal((await failure(() => json(403, {}))).message, "the local speech server refused this page (403): allow this page's origin in its settings, or open the page from http://localhost")
  assert.equal((await failure(() => json(404, { detail: 'Not Found' }))).message, 'the server at this address has no /v1/audio/speech: is it a speech server? (say server <url>)')
  const voice = await failure(() => json(422, { detail: [{ msg: "Voice 'v1' not found" }] }))
  assert.deepEqual([voice.code, voice.message], ['voice', "the local speech server has no voice 'v1': type say to list the ones it has"])
  assert.equal((await failure(() => json(400, { error: { message: 'Unknown voice: v1' } }))).code, 'voice')
  assert.equal((await failure(() => json(500, { detail: 'CUDA out of memory.\nTraceback …' }))).message, 'the local speech server failed (500): CUDA out of memory.')
  assert.equal((await failure(() => json(503, { error: 'loading model' }))).message, 'the local speech server failed (503): loading model')
  assert.equal((await failure(() => new Response('<html>', { status: 502 }))).message, 'the local speech server failed (502)')
  const notAudio = await failure(() => json(200, { error: { message: 'input too long' } }))
  assert.deepEqual([notAudio.code, notAudio.message], ['unreadable', 'the local speech server answered with application/json, not audio: input too long'])
  assert.equal((await failure(() => chunked(new Uint8Array(0)))).message, 'the local speech server sent no audio')
  // More than one utterance's worth: cut off before it fills the page's memory. (The flood ends a few megabytes past
  // the limit, so a client that ignored it would finish, and fail here, rather than read forever.)
  const mb = new Uint8Array(1024 * 1024)
  let sent = 0
  const flood = new ReadableStream<Uint8Array>({ pull(c) { if (++sent > SPEECH_BYTES / mb.length + 4) c.close(); else c.enqueue(mb) } })
  const big = await failure(() => new Response(flood, { status: 200, headers: { 'content-type': 'audio/wav' } }))
  assert.equal(big.message, `the local speech server sent more than ${SPEECH_BYTES / 1024 / 1024} MB: not one utterance`)
  assert.ok(sent <= SPEECH_BYTES / mb.length + 2, 'it stopped reading')
})

test('no answer at all: the server is down, or up but refusing this page; an opaque look tells which, and says so', async () => {
  const down: FetchLike = async () => { throw new TypeError('Failed to fetch') }
  await assert.rejects(synthesize(down, REQ), { code: 'offline', message: `no local speech server is answering at ${DEFAULT_SPEECH_SERVER}: start it, or point say at the right address (say server <url>)` })
  const looks: RequestInit[] = []
  const refusing: FetchLike = async (_url, init) => {
    if (init?.mode === 'no-cors') { looks.push(init); return new Response(null, { status: 200 }) }
    throw new TypeError('Failed to fetch')
  }
  await assert.rejects(synthesize(refusing, REQ), (e: unknown) => e instanceof SpeechError && e.code === 'refused' && /running but refused this page/.test(e.message) && /'null'/.test(e.message))
  assert.equal(looks.length, 1)
  await assert.rejects(speechVoices(down, DEFAULT_SPEECH_SERVER), { code: 'offline' })
})

test('the moment the signal aborts, the request rejects with its reason and the body is cancelled', async () => {
  // Before it is sent.
  const early = new AbortController()
  early.abort(new DOMException('Spatial tether lost: agent 7', 'AbortError'))
  const refused: FetchLike = async (_u, init) => { init?.signal?.throwIfAborted(); return chunked(wav()) }
  await assert.rejects(synthesize(refused, { ...REQ, signal: early.signal }), { name: 'AbortError', message: 'Spatial tether lost: agent 7' })
  // Mid-body: the audio trickles in, the lease breaks between two chunks.
  const c = new AbortController()
  let cancelled = false
  let pulls = 0
  // It trickles for about a second, then ends: a client that ignored the abort would finish (and fail here) instead
  // of reading forever.
  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      pulls++
      await sleep(5)
      if (pulls > 150) ctl.close()
      else ctl.enqueue(new Uint8Array(100))
    },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })
  const p = synthesize(fakeFetch(() => new Response(body, { status: 200, headers: { 'content-type': 'audio/wav' } })).f, { ...REQ, signal: c.signal })
  await sleep(30)
  c.abort(new DOMException('Spatial tether lost: agent 7', 'AbortError'))
  await assert.rejects(within(p), { name: 'AbortError', message: 'Spatial tether lost: agent 7' })
  await sleep(20)
  assert.ok(cancelled, 'the body was cancelled')
  const at = pulls
  await sleep(40)
  assert.equal(pulls, at, 'nothing more was read')
})

test('the voices the server lists, however it lists them; none kept is null, not an error', async () => {
  const list = (body: unknown) => speechVoices(fakeFetch(() => json(200, body)).f, DEFAULT_SPEECH_SERVER)
  assert.deepEqual(await list({ voices: ['v2', 'v1', 'v2'] }), ['v1', 'v2'])
  assert.deepEqual(await list(['b', 'a']), ['a', 'b'])
  assert.deepEqual(await list({ voices: [{ id: 'x' }, { name: 'y' }, { id: '' }, 7, null] }), ['x', 'y'])
  assert.equal(await speechVoices(fakeFetch(() => json(404, { detail: 'Not Found' })).f, DEFAULT_SPEECH_SERVER), null)
  await assert.rejects(list({ nope: true }), { code: 'unreadable' })
  await assert.rejects(speechVoices(fakeFetch(() => new Response('not json', { status: 200 })).f, DEFAULT_SPEECH_SERVER), { code: 'unreadable' })
  await assert.rejects(speechVoices(fakeFetch(() => json(500, { detail: 'boom' })).f, DEFAULT_SPEECH_SERVER), { message: 'the local speech server failed (500): boom' })
  const { f, calls } = fakeFetch(() => json(200, []))
  await speechVoices(f, 'http://127.0.0.1:8880/some/path')
  assert.equal(calls[0].url, 'http://127.0.0.1:8880/v1/audio/voices')
})

test('the settings: a server on this machine, a chosen voice, an optional model and auto, kept between visits; no voice, no request', async () => {
  let kept: string | null = null
  const store = { load: () => kept, save: (s: string) => { kept = s } }
  const { f, calls } = fakeFetch(() => chunked(wav()))
  const v = createLocalSpeech({ fetch: f, store })
  assert.deepEqual(v.settings(), { server: DEFAULT_SPEECH_SERVER, model: null, voice: null, auto: false, provider: 'local', key: null })
  await assert.rejects(v.synthesize('hello', new AbortController().signal), { code: 'voice', message: 'choose a voice first: say voice <name> (type say to list them)' })
  assert.equal(calls.length, 0, 'no voice, no request')
  assert.throws(() => v.setServer('http://example.com:8880'), /must be on this machine/)
  assert.throws(() => v.setVoice('  '), /name the voice/)
  assert.throws(() => v.setModel('a\nb'), /name the model/)
  assert.equal(v.setServer('http://127.0.0.1:5000/docs'), 'http://127.0.0.1:5000')
  assert.equal(v.setVoice(' v1 '), 'v1')
  assert.equal(v.setModel('open-tts'), 'open-tts')
  assert.equal(v.setAuto(true), true)
  assert.deepEqual(JSON.parse(kept ?? ''), { v: 2, provider: 'local', auto: true, local: { server: 'http://127.0.0.1:5000', model: 'open-tts', voice: 'v1' }, elevenlabs: { server: 'http://localhost:8090', model: 'eleven_turbo_v2_5', voice: null, key: null } })
  await v.synthesize('hello', new AbortController().signal)
  assert.equal(calls[0].url, 'http://127.0.0.1:5000/v1/audio/speech')
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { model: 'open-tts', input: 'hello', voice: 'v1', response_format: 'wav' })
  // The next visit: the same settings. A saved server off the machine, or unreadable storage: the defaults. A record
  // the first version wrote (the local server alone) still reads.
  const local = { provider: 'local', key: null }
  assert.deepEqual(createLocalSpeech({ fetch: f, store }).settings(), { server: 'http://127.0.0.1:5000', model: 'open-tts', voice: 'v1', auto: true, ...local })
  kept = JSON.stringify({ v: 1, server: 'http://example.com', voice: 'v9', auto: 'yes' })
  assert.deepEqual(createLocalSpeech({ fetch: f, store }).settings(), { server: DEFAULT_SPEECH_SERVER, model: null, voice: 'v9', auto: false, ...local })
  kept = JSON.stringify({ v: 1, server: 'http://localhost:7000', voice: 'v9', model: 'm', auto: true })
  assert.deepEqual(createLocalSpeech({ fetch: f, store }).settings(), { server: 'http://localhost:7000', model: 'm', voice: 'v9', auto: true, ...local })
  kept = '{not json'
  assert.deepEqual(createLocalSpeech({ fetch: f, store }).settings(), { server: DEFAULT_SPEECH_SERVER, model: null, voice: null, auto: false, ...local })
  const broken = { load: () => { throw new Error('denied') }, save: () => { throw new Error('denied') } }
  const b = createLocalSpeech({ fetch: f, store: broken })
  assert.equal(b.setVoice('v1'), 'v1', 'storage refused: the setting lasts for the visit')
})

// ---------------------------------------------------------------- a real socket

interface Seen { path: string; body: { input?: string; voice?: string; model?: string } | null; ended: 'complete' | 'client-gone' | null }

/** A speech server on a loopback port: /v1/audio/voices, and /v1/audio/speech answering with `audio`, trickled out. */
async function speechServer(opts: { audio?: Uint8Array; chunk?: number; gapMs?: number; voices?: string[] } = {}) {
  const audio = opts.audio ?? wav(24000)
  const seen: Seen[] = []
  const server = createServer((req: IncomingMessage, res) => {
    let raw = ''
    req.on('data', (d) => { raw += d })
    req.on('end', () => {
      const entry: Seen = { path: req.url ?? '', body: raw ? JSON.parse(raw) : null, ended: null }
      seen.push(entry)
      res.setHeader('access-control-allow-origin', '*')
      if (req.url === '/v1/audio/voices') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ voices: opts.voices ?? ['v1', 'v2'] }))
        entry.ended = 'complete'
        return
      }
      res.writeHead(200, { 'content-type': 'audio/wav' })
      const chunk = opts.chunk ?? 4096
      let at = 0
      const timer = setInterval(() => {
        res.write(audio.subarray(at, at + chunk))
        at += chunk
        if (at < audio.length) return
        clearInterval(timer)
        entry.ended = 'complete'
        res.end()
      }, opts.gapMs ?? 5)
      res.on('close', () => {
        clearInterval(timer)
        if (entry.ended !== 'complete') entry.ended = 'client-gone'
      })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, seen, audio, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }) }
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

test('over a real socket: the whole WAV arrives; an abort mid-audio closes the connection before the server has finished', async () => {
  const srv = await speechServer({ gapMs: 10, chunk: 2048 })
  try {
    assert.deepEqual(new Uint8Array(await synthesize(netFetch, { ...REQ, server: srv.url })), srv.audio)
    assert.deepEqual(await speechVoices(netFetch, srv.url), ['v1', 'v2'])
    const c = new AbortController()
    const p = synthesize(netFetch, { ...REQ, server: srv.url, signal: c.signal })
    await sleep(40)
    c.abort(new DOMException('Spatial tether lost', 'AbortError'))
    await assert.rejects(within(p), { name: 'AbortError' })
    await ended(srv)
    assert.equal(srv.seen.at(-1)?.ended, 'client-gone')
  } finally {
    await srv.close()
  }
})

// ---------------------------------------------------------------- the whole path, from the console

const entry = (agent: number, serial: number, skills: string[], x = 3, z = 4): RecruitView => ({
  agent, serial, skill: skills[0], state: 'Active', arrived: true, skills, distance: 1.5, x, z, seconds: 10,
})
const A = entry(11, 1, ['Rust', 'Python'])
const B = entry(22, 2, ['Go', 'Data'])

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

/**
 * The soundscape's contract, recorded: what was decoded, who it was played at, and whether it was stopped. An
 * utterance lasts until the test ends it (or it is stopped).
 */
class Soundscape implements SpeechOut {
  readonly decoded: number[] = []
  readonly played: { agent: number; seconds: number }[] = []
  stops = 0
  #end: (() => void) | null = null
  async decode(bytes: ArrayBuffer): Promise<SpeechClip> {
    this.decoded.push(bytes.byteLength)
    return { seconds: (bytes.byteLength - 44) / 48000 }
  }
  play(clip: SpeechClip, agent: number): Utterance {
    this.played.push({ agent, seconds: clip.seconds })
    let end: () => void = () => {}
    const ended = new Promise<void>((r) => { end = r })
    this.#end = end
    return { ended, stop: () => { this.stops++; end() } }
  }
  /** The clip plays out. */
  finish(): void {
    this.#end?.()
  }
}

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

/** The console, unlocked, over the real operator tier, gateway and speech client, pointed at `server` with voice v1. */
function operatorConsole(src: Mirror, server: string) {
  const router = new TaskRouter(src)
  const out = new Soundscape()
  const voice = createLocalSpeech({ fetch: netFetch })
  const term = { operator: operatorBridge(CITY, router, createLocalCompute({ fetch: netFetch }), undefined, { voice, speech: out, contained: () => true }) } as unknown as TerminalBridge
  shell('operator unlock', term, [])
  shell(`say server ${server}`, term, [])
  shell('say voice v1', term, [])
  return { router, term, out }
}

test('the whole path: from the console through the gateway to a real local server and out at the person bound; Rejected never reaches it', async () => {
  const srv = await speechServer()
  try {
    const { router, term, out } = operatorConsole(new Mirror([A, B]), srv.url)
    assert.deepEqual(await shell('say', term, []).pending, [
      { kind: 'out', text: 'provider  local: a speech server on this machine' },
      { kind: 'out', text: `server    ${srv.url}  (this machine only)` },
      { kind: 'out', text: 'voice     v1' },
      { kind: 'out', text: "model     the server's default" },
      { kind: 'out', text: 'auto      off' },
      { kind: 'out', text: 'voices    v1  (chosen)' },
      { kind: 'out', text: '          v2' },
    ])
    const no = shell('say networking: over here', term, [])
    assert.deepEqual(await no.pending, [{ kind: 'err', text: 'say: Rejected (Insufficient Capabilities): nobody tethered to the operator has Networking' }])
    assert.deepEqual(srv.seen.map((r) => r.path), ['/v1/audio/voices'], 'a rejected text never reached the server')
    const r = shell('say go: over here, by the lamp', term, [])
    assert.deepEqual(r.lines, [{ kind: 'sys', text: 'say: Authorized: said by agent 22 (Go, Data)' }])
    while (!out.played.length) await sleep(5)
    assert.deepEqual(out.played, [{ agent: 22, seconds: 1 }], 'played at the head of the person it is bound to')
    assert.deepEqual(out.decoded, [srv.audio.length])
    assert.deepEqual(srv.seen[1].body, { input: 'over here, by the lamp', voice: 'v1', response_format: 'wav' })
    assert.equal(shell('say go: again', term, []).lines[0].text, "say: something is still being said: wait for it, or type 'say stop'", 'one at a time')
    out.finish()
    assert.deepEqual(await within(r.pending!), [{ kind: 'sys', text: '-- said by agent 22 (Go, Data) (1.0 s) --' }])
    assert.equal(router.running, 0)
  } finally {
    await srv.close()
  }
})

test('the whole path: the tether breaks mid-word and the speech stops; mid-download and the request is cut; the operator can stop it; a stopped server is a sentence', async () => {
  const srv = await speechServer()
  try {
    // Mid-word: the person is left behind while speaking.
    const src = new Mirror([A, B])
    const s1 = operatorConsole(src, srv.url)
    const r = shell('say rust: follow me', s1.term, [])
    while (!s1.out.played.length) await sleep(5)
    src.emit([B])
    assert.deepEqual(await within(r.pending!), [{ kind: 'err', text: 'say: Aborted (Spatial Tether Lost): agent 11 (Rust, Python): no longer tethered to the operator' }])
    assert.equal(s1.out.stops, 1, 'the speech was cut the moment the tether broke')
    // Mid-download: the audio never plays, and the connection is closed.
    const slow = await speechServer({ gapMs: 20, chunk: 1024 })
    try {
      const src2 = new Mirror([A])
      const s2 = operatorConsole(src2, slow.url)
      const d = shell('say rust: follow me', s2.term, [])
      await sleep(60)
      src2.emit([])
      assert.equal((await within(d.pending!))[0].kind, 'err')
      await ended(slow)
      assert.equal(slow.seen.at(-1)?.ended, 'client-gone', 'the request was cut before the server finished')
      assert.deepEqual(s2.out.played, [], 'nothing was said')
    } finally {
      await slow.close()
    }
    // The operator's own stop: the tether held, so Authorized, and it says so.
    const s3 = operatorConsole(new Mirror([A]), srv.url)
    const st = shell('say rust: follow me', s3.term, [])
    while (!s3.out.played.length) await sleep(5)
    assert.deepEqual(shell('say stop', s3.term, []).lines, [{ kind: 'out', text: 'say: stopping the speech' }])
    assert.deepEqual(await within(st.pending!), [{ kind: 'sys', text: 'say: stopped by the operator' }])
    assert.equal(s3.out.stops, 1)
    // Not running at all: Authorized (the tether held) and one sentence, nothing thrown.
    const off = await closedPort()
    const s4 = operatorConsole(new Mirror([A]), off)
    const down = shell('say rust: hello?', s4.term, [])
    assert.deepEqual(down.lines, [{ kind: 'sys', text: 'say: Authorized: said by agent 11 (Rust, Python)' }])
    assert.deepEqual(await down.pending, [{ kind: 'err', text: `say: no local speech server is answering at ${off}: start it, or point say at the right address (say server <url>)` }])
  } finally {
    await srv.close()
  }
})

// ---------------------------------------------------------------- the ElevenLabs provider (through a gateway on this machine)

test('elevenlabs: off by default; chosen, the request goes to the gateway on this machine with the text, the model, MP3 asked for, and the key only when one is kept; a name is looked up in the list', async () => {
  let kept: string | null = null
  const store = { load: () => kept, save: (s: string) => { kept = s } }
  const mp3 = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3])
  const { f, calls } = fakeFetch((url) => {
    if (url.endsWith('/v1/voices')) return json(200, { voices: [{ voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah' }, { voice_id: 'short', name: 'Bad' }, { name: 'nameless' }] })
    return chunked(mp3, [2], 'audio/mpeg')
  })
  const v = createLocalSpeech({ fetch: f, store })
  assert.equal(v.settings().provider, 'local', 'the local server is the voice until the operator says otherwise')
  assert.equal(v.setProvider!('ElevenLabs'), 'elevenlabs')
  assert.deepEqual(v.settings(), { server: 'http://localhost:8090', model: 'eleven_turbo_v2_5', voice: null, auto: false, provider: 'elevenlabs', key: null })
  assert.throws(() => v.setProvider!('openai'), /no speech provider called 'openai'/)
  assert.throws(() => v.setServer('https://api.elevenlabs.io'), /gateway must be on this machine/)
  assert.deepEqual(await v.voices(), ['Sarah (EXAVITQu4vr4xnSDxMaL)'], 'ids the API issues only, by name')
  assert.equal(calls[0].url, 'http://localhost:8090/v1/voices')
  assert.deepEqual(calls[0].init?.headers, {}, 'no key kept: none sent (the gateway adds its own)')
  // No key, no voice: nothing is sent.
  await assert.rejects(v.synthesize('hello', new AbortController().signal), { code: 'voice' })
  assert.equal(v.setVoice('Sarah'), 'Sarah')
  const audio = new Uint8Array(await v.synthesize('hello', new AbortController().signal))
  assert.deepEqual([...audio], [...mp3], 'the audio comes back byte for byte however it is cut')
  assert.equal(calls[1].url, 'http://localhost:8090/v1/voices', 'a name is looked up first')
  assert.equal(calls[2].url, 'http://localhost:8090/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL?output_format=mp3_44100_128')
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), { text: 'hello', model_id: 'eleven_turbo_v2_5' })
  assert.deepEqual(calls[2].init?.headers, { 'content-type': 'application/json', accept: 'audio/mpeg' })
  // A key kept on the page rides the header, masked everywhere it is shown; an id needs no lookup.
  assert.equal(v.setKey!('sk_0123456789abcdef'), 'sk_0…cdef')
  assert.throws(() => v.setKey!('two words'), /one word/)
  assert.equal(v.setVoice('EXAVITQu4vr4xnSDxMaL'), 'EXAVITQu4vr4xnSDxMaL')
  await v.synthesize('again', new AbortController().signal)
  assert.equal(calls[3].url, 'http://localhost:8090/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL?output_format=mp3_44100_128')
  assert.equal(((calls[3].init?.headers ?? {}) as Record<string, string>)['xi-api-key'], 'sk_0123456789abcdef')
  assert.equal(v.settings().key, 'sk_0…cdef')
  assert.doesNotMatch(JSON.stringify(v.settings()), /sk_0123456789abcdef/, 'never whole in the settings')
  // Kept between visits, each provider's own settings; the local server's untouched.
  assert.deepEqual(JSON.parse(kept ?? ''), { v: 2, provider: 'elevenlabs', auto: false, local: { server: DEFAULT_SPEECH_SERVER, model: null, voice: null }, elevenlabs: { server: 'http://localhost:8090', model: 'eleven_turbo_v2_5', voice: 'EXAVITQu4vr4xnSDxMaL', key: 'sk_0123456789abcdef' } })
  const again = createLocalSpeech({ fetch: f, store })
  assert.equal(again.settings().provider, 'elevenlabs')
  assert.equal(again.setKey!('none'), null)
  assert.equal(again.setProvider!('local'), 'local')
  assert.deepEqual(again.settings(), { server: DEFAULT_SPEECH_SERVER, model: null, voice: null, auto: false, provider: 'local', key: null })
  // A hired agent's own voice overrides the chosen one for that utterance alone.
  again.setVoice('v1')
  await again.synthesize('mine', new AbortController().signal, 'v2')
  assert.deepEqual(JSON.parse(String(calls[calls.length - 1].init?.body)), { input: 'mine', voice: 'v2', response_format: 'wav' })
  assert.equal(again.settings().voice, 'v1')
})

test('elevenlabs: every way the gateway can fail is one plain sentence: a refused key, no such voice, not audio, down', async () => {
  const failure = (p: Promise<ArrayBuffer>): Promise<SpeechError> => p.then(() => assert.fail('it should have failed'), (e: unknown) => e as SpeechError)
  const req = { server: 'http://localhost:8090', key: null, model: 'eleven_turbo_v2_5', voice: 'EXAVITQu4vr4xnSDxMaL', text: 'hi' }
  const e401 = await failure(synthesizeEleven(fakeFetch(() => json(401, { detail: { status: 'invalid_api_key', message: 'nope' } })).f, req))
  assert.equal(e401.code, 'refused')
  assert.match(e401.message, /refused the key \(401\)/)
  const noVoice = await failure(synthesizeEleven(fakeFetch(() => json(200, { voices: [] })).f, { ...req, voice: 'Nobody' }))
  assert.equal(noVoice.code, 'voice')
  assert.match(noVoice.message, /no voice 'Nobody'/)
  const html = await failure(synthesizeEleven(fakeFetch(() => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })).f, req))
  assert.equal(html.code, 'unreadable')
  const down = await failure(synthesizeEleven(fakeFetch(() => { throw new TypeError('fetch failed') }).f, req))
  assert.equal(down.code, 'offline')
  assert.match(down.message, /no ElevenLabs gateway is answering at http:\/\/localhost:8090/, 'the gateway named, not a local speech server')
  const gone = await failure(synthesizeEleven(fakeFetch(() => json(404, { detail: { status: 'voice_not_found', message: 'A voice with the voice_id was not found.' } })).f, req))
  assert.equal(gone.code, 'voice', 'an id the account does not have is a voice, not a missing path')
  assert.match(gone.message, /ElevenLabs has no voice 'EXAVITQu4vr4xnSDxMaL'/)
  const notGateway = await failure(synthesizeEleven(fakeFetch(() => new Response('Not Found', { status: 404 })).f, req))
  assert.equal(notGateway.code, 'server')
  assert.match(notGateway.message, /no \/v1\/text-to-speech: is it the ElevenLabs gateway\?/)
  assert.doesNotMatch(notGateway.message, /audio\/speech/)
  // A voice as say lists it, 'Name (id)': the id, with no lookup.
  const listed = fakeFetch(() => new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }))
  await synthesizeEleven(listed.f, { ...req, voice: 'Sarah (EXAVITQu4vr4xnSDxMaL)' })
  assert.deepEqual(listed.calls.map((c) => c.url), ['http://localhost:8090/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL?output_format=mp3_44100_128'])
  const direct = fakeFetch(() => json(200, {}))
  await assert.rejects(synthesizeEleven(direct.f, { ...req, server: 'https://api.elevenlabs.io', key: 'sk_0123456789abcdef' }), { code: 'refused' })
  assert.equal(direct.calls.length, 0, 'ElevenLabs itself is off this machine: nothing is sent, the key least of all')
  await assert.rejects(elevenVoices(fakeFetch(() => json(200, { nope: 1 })).f, 'http://localhost:8090', null), { code: 'unreadable' })
  assert.equal(maskSpeechKey(null), null)
  assert.equal(maskSpeechKey('short'), '****')
})
