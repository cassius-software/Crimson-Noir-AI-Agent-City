// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the microphone (microphone.ts): off until pressed on a first visit
 * (MIC_OPEN_BY_DEFAULT false) and open at boot only on the visitor's kept switch, the device opened with echo
 * cancellation and released by mute (the browser's indicator goes out: tracks stopped, the context closed), the
 * worklet path taken where the browser has one and the page's analyser poll where it has not, a refusal read in the
 * browser's own words, speech from the detector turning the pill and a barge-in raised only while the page speaks, an
 * open() overtaken by a mute() leaving nothing open, a device unplugged reading as an error, the pill's words and its
 * accessible name, and the console's lines. Nothing here is a browser: every object is a fake handed in.
 * What breaks if it is removed? A hot microphone at boot, a mute that keeps the device, or a pill that lies, with
 * every other test green.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  LEVELS, MIC_CONSTRAINTS, MIC_KEY, MIC_OPEN_BY_DEFAULT, Microphone, VOICE_DEFAULTS, isOpen, loadVoiceSettings, micEnv, opensAtBoot, phaseWord,
  pillLabel, pillWord, refusal, saveVoiceSettings, tapMeans, voiceStatus, type AnalyserLike, type ContextLike, type KeyStore, type MicEnv, type MicState,
  type NodeLike, type StreamLike, type TrackLike, type WorkletNodeLike,
} from './microphone.ts'
import { VAD, VAD_PROCESSOR, VadCore, type VadMessage } from './vad.ts'

function memoryStore(): KeyStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v) }, removeItem: (k) => { map.delete(k) } }
}

class FakeTrack implements TrackLike {
  enabled = true
  readyState = 'live'
  stopped = 0
  private onEnded: (() => void) | null = null
  stop(): void { this.stopped++; this.readyState = 'ended' }
  addEventListener(_type: 'ended', fn: () => void): void { this.onEnded = fn }
  unplug(): void { this.readyState = 'ended'; this.onEnded?.() }
}
class FakeStream implements StreamLike {
  readonly track = new FakeTrack()
  getTracks(): TrackLike[] { return [this.track] }
  getAudioTracks(): TrackLike[] { return [this.track] }
}

class FakeNode implements NodeLike {
  connected: NodeLike[] = []
  disconnected = 0
  connect(to: NodeLike): unknown { this.connected.push(to); return to }
  disconnect(): void { this.disconnected++ }
}
class FakeAnalyser extends FakeNode implements AnalyserLike {
  fftSize = 2048
  samples: Float32Array | null = null
  getFloatTimeDomainData(out: Float32Array): void { if (this.samples) out.set(this.samples.subarray(0, out.length)); else out.fill(0) }
}
class FakeWorklet extends FakeNode implements WorkletNodeLike {
  static made: FakeWorklet[] = []
  readonly name: string
  readonly options: unknown
  port = { onmessage: null as ((e: { data: VadMessage }) => void) | null, sent: [] as unknown[], postMessage(m: unknown) { this.sent.push(m) } }
  constructor(_ctx: ContextLike, name: string, o?: { processorOptions?: unknown }) { super(); this.name = name; this.options = o?.processorOptions; FakeWorklet.made.push(this) }
  /** The worklet speaks: a message from the audio thread. */
  say(m: VadMessage): void { this.port.onmessage?.({ data: m }) }
}
class FakeContext implements ContextLike {
  static made: FakeContext[] = []
  state = 'running'
  sampleRate = 48_000
  /** The context's clock; undefined for one that has none to read. */
  currentTime: number | undefined = 0
  closed = 0
  resumed = 0
  modules: string[] = []
  readonly source = new FakeNode()
  readonly analyser = new FakeAnalyser()
  audioWorklet?: { addModule(url: string): Promise<void> }
  readonly worklet: 'ok' | 'refuse' | 'none'
  constructor(worklet: 'ok' | 'refuse' | 'none' = 'ok') {
    this.worklet = worklet
    FakeContext.made.push(this)
    if (worklet !== 'none') this.audioWorklet = { addModule: async (url) => { this.modules.push(url); if (worklet === 'refuse') throw new Error('no worklet here') } }
  }
  createMediaStreamSource(): NodeLike { return this.source }
  createAnalyser(): AnalyserLike { return this.analyser }
  async resume(): Promise<void> { this.resumed++; this.state = 'running' }
  async close(): Promise<void> { this.closed++; this.state = 'closed' }
}

interface Fake { env: MicEnv; streams: FakeStream[]; asked: unknown[]; urls: string[]; revoked: number; timers: Map<unknown, () => void>; tick(): void }

function fake(o: { media?: 'ok' | 'refuse' | 'missing' | 'nodevice'; worklet?: 'ok' | 'refuse' | 'none'; workletNode?: boolean; context?: boolean; rate?: number; clock?: boolean } = {}): Fake {
  const streams: FakeStream[] = []
  const asked: unknown[] = []
  const urls: string[] = []
  const timers = new Map<unknown, () => void>()
  let id = 0
  const f: Fake = {
    streams, asked, urls, revoked: 0, timers,
    tick: () => { for (const fn of [...timers.values()]) fn() },
    env: {
      media: o.media === 'missing' ? null : {
        getUserMedia: async (c) => {
          asked.push(c)
          if (o.media === 'refuse') throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
          if (o.media === 'nodevice') throw Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' })
          const s = new FakeStream()
          streams.push(s)
          return s
        },
      },
      Context: o.context === false ? null : class extends FakeContext { constructor() { super(o.worklet ?? 'ok'); if (o.rate) this.sampleRate = o.rate; if (o.clock === false) this.currentTime = undefined } },
      WorkletNode: o.workletNode === false ? null : FakeWorklet,
      moduleUrl: (source) => { const url = `blob:fake/${urls.length}`; urls.push(source); return { url, revoke: () => { f.revoked++ } } },
      setInterval: (fn) => { const h = ++id; timers.set(h, fn); return h },
      clearInterval: (h) => { timers.delete(h) },
    },
  }
  return f
}

const events = (m: Microphone) => {
  const out: string[] = []
  m.addEventListener('change', (e) => out.push(`change:${(e as CustomEvent<{ phase: string }>).detail.phase}`))
  m.addEventListener('speech', (e) => out.push(`speech:${(e as CustomEvent<boolean>).detail}`))
  m.addEventListener('barge', () => out.push('barge'))
  return out
}

test('the settings: off by default (the one line is false), kept under one key, anything odd reads as the defaults; the boot follows the kept switch or the line', () => {
  assert.equal(MIC_OPEN_BY_DEFAULT, false, 'a first visit does not open the microphone until the owner says so')
  const store = memoryStore()
  assert.deepEqual(loadVoiceSettings(store), VOICE_DEFAULTS)
  saveVoiceSettings({ on: true }, store)
  assert.equal(store.map.get(MIC_KEY), '{"v":1,"on":true}')
  assert.deepEqual(loadVoiceSettings(store), { on: true })
  store.map.set(MIC_KEY, '{"v":2,"on":true}')
  assert.deepEqual(loadVoiceSettings(store), VOICE_DEFAULTS, 'another version')
  store.map.set(MIC_KEY, 'not json')
  assert.deepEqual(loadVoiceSettings(store), VOICE_DEFAULTS)
  store.map.set(MIC_KEY, JSON.stringify({ v: 1, on: 'yes' }))
  assert.deepEqual(loadVoiceSettings(store), VOICE_DEFAULTS, 'on must be the boolean true')
  assert.deepEqual(loadVoiceSettings(null), VOICE_DEFAULTS)
  assert.equal(opensAtBoot({ on: false }), false)
  assert.equal(opensAtBoot({ on: true }), true, 'the visitor left it on')
  assert.equal(opensAtBoot({ on: false }, true), true, 'the owner flipped the line')
})

test('the words: a word per phase, Speaking over an open microphone while the page talks, a tap opens or mutes, and the accessible name says state, action and key', () => {
  for (const p of ['off', 'opening', 'listening', 'speech', 'muted', 'blocked', 'unavailable', 'error'] as const) assert.ok(phaseWord(p).length > 0)
  assert.equal(pillWord('listening', true), 'Speaking')
  assert.equal(pillWord('speech', true), 'Speaking')
  assert.equal(pillWord('muted', true), 'Muted', 'the page speaking over a muted microphone is not the microphone\'s news')
  assert.equal(pillWord('off', false), 'Mic off')
  assert.deepEqual(['listening', 'speech'].map((p) => isOpen(p as never)), [true, true])
  assert.deepEqual(['off', 'opening', 'muted', 'blocked'].map((p) => isOpen(p as never)), [false, false, false, false])
  assert.equal(tapMeans('off'), 'open')
  assert.equal(tapMeans('muted'), 'open')
  assert.equal(tapMeans('blocked'), 'open', 'a refused permission is asked again on the next press')
  assert.equal(tapMeans('listening'), 'mute')
  assert.equal(tapMeans('opening'), 'mute', 'a press while the prompt is open withdraws')
  assert.equal(pillLabel('listening', false), 'Microphone: listening. Press to mute. Key V.')
  assert.equal(pillLabel('off', false), 'Microphone: off. Press to listen. Key V.')
  assert.equal(pillLabel('blocked', false, 'permission refused'), 'Microphone: blocked (permission refused). Press to listen. Key V.')
  assert.equal(pillLabel('listening', true), 'Microphone: speaking. Press to mute. Key V.')
})

test('micEnv reads the browser\'s objects, or nulls, and makes blob: URLs only where it can', () => {
  const none = micEnv({})
  assert.deepEqual([none.media, none.Context, none.WorkletNode, none.moduleUrl], [null, null, null, null])
  const made: unknown[] = []
  const g = {
    navigator: { mediaDevices: { getUserMedia: async () => new FakeStream() } },
    webkitAudioContext: FakeContext,
    AudioWorkletNode: FakeWorklet,
    Blob: class { constructor(parts: string[], o: { type: string }) { made.push([parts, o]) } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => { made.push('revoked') } },
  }
  const env = micEnv(g)
  assert.equal(env.media, g.navigator.mediaDevices)
  assert.equal(env.Context, FakeContext, 'the prefixed constructor stands in')
  assert.equal(env.WorkletNode, FakeWorklet)
  const m = env.moduleUrl!('source')
  assert.equal(m.url, 'blob:x')
  m.revoke()
  assert.equal(made.length, 2)
  assert.equal(micEnv({ navigator: { mediaDevices: {} } }).media, null, 'mediaDevices without getUserMedia')
})

test('a first visit: off at boot; listen() opens the device with echo cancellation, takes the worklet, keeps the switch and reads Listening', async () => {
  const f = fake()
  const store = memoryStore()
  const m = new Microphone(f.env, store)
  const log = events(m)
  assert.equal(m.phase, 'off')
  assert.equal(m.opensAtBoot(), false)
  const p = m.listen()
  assert.equal(m.phase, 'opening')
  const s = await p
  assert.deepEqual([s.phase, m.path], ['listening', 'worklet'])
  assert.deepEqual(f.asked, [MIC_CONSTRAINTS])
  assert.equal((f.asked[0] as { audio: { echoCancellation: boolean } }).audio.echoCancellation, true)
  assert.equal(f.urls.length, 1, 'the worklet module loaded once')
  assert.ok(f.urls[0].includes(`registerProcessor(${JSON.stringify(VAD_PROCESSOR)}`))
  assert.equal(f.revoked, 1, 'and its URL revoked')
  const ctx = FakeContext.made.at(-1)!
  const node = FakeWorklet.made.at(-1)!
  assert.equal(ctx.source.connected[0], node, 'the stream feeds the detector')
  assert.equal(node.connected.length, 0, 'and nothing reaches the speakers')
  assert.deepEqual(node.options, VAD)
  assert.deepEqual(node.port.sent, [{ speaking: false }])
  assert.deepEqual(loadVoiceSettings(store), { on: true })
  assert.equal(m.opensAtBoot(), true, 'the next visit opens it')
  assert.deepEqual(log, ['change:opening', 'change:listening'])
  assert.equal(m.word(), 'Listening')
  assert.deepEqual(await m.listen(), s, 'listening already: nothing more')
  assert.equal(f.asked.length, 1)
})

test('the worklet speaks: levels fill the meter, speech turns the pill, a barge-in only while the page is speaking', async () => {
  const f = fake()
  const m = new Microphone(f.env, memoryStore())
  await m.listen()
  const log = events(m)
  const node = FakeWorklet.made.at(-1)!
  node.say({ rms: 0.2, t: 1 })
  node.say({ rms: 0.4, t: 1.1 })
  assert.equal(m.level, 0.4)
  assert.ok(Math.abs(m.levels[0] - 0.2) < 1e-6 && Math.abs(m.levels[1] - 0.4) < 1e-6, 'the ring holds the readings (float32)')
  assert.equal(m.head, 2)
  node.say({ rms: 0.5, speech: true, t: 1.2 })
  assert.equal(m.phase, 'speech')
  assert.equal(m.word(), 'Hearing you')
  node.say({ rms: 0.5, speech: true, t: 1.3 })
  node.say({ rms: 0.1, speech: false, t: 2 })
  assert.equal(m.phase, 'listening')
  assert.deepEqual(log, ['speech:true', 'change:speech', 'speech:false', 'change:listening'], 'a repeated boundary is nothing')
  log.length = 0
  m.setSpeaking(true)
  assert.deepEqual(node.port.sent.at(-1), { speaking: true }, 'the detector is told')
  assert.equal(m.word(), 'Speaking')
  node.say({ rms: 0.6, speech: true, t: 3 })
  assert.deepEqual(log, ['speech:true', 'barge', 'change:speech'])
  m.newLine()
  assert.deepEqual(node.port.sent.at(-1), { line: true }, 'a line that cuts the one still playing: the detector learns afresh')
  m.setSpeaking(false)
  m.setSpeaking(false)
  assert.equal(node.port.sent.filter((x) => (x as { speaking?: boolean }).speaking === false).length, 2, 'told once per change (the first was the open)')
  const sent = node.port.sent.length
  m.newLine()
  assert.equal(node.port.sent.length, sent, 'nothing while she is quiet')
  node.say({ rms: 2, t: 4 })
  assert.equal(m.level, 1, 'the meter is clamped')
  node.say({ rms: Number.NaN, t: 4 })
  assert.equal(m.level, 0)
  for (let i = 0; i < LEVELS + 3; i++) node.say({ rms: 0.1, t: 5 })
  assert.equal(m.head, (2 + 4 + 2 + LEVELS + 3) % LEVELS, 'a ring')
})

test('mute releases the device: tracks stopped, the graph torn down, the context closed, the switch off, the pill Muted; the next press opens again', async () => {
  const f = fake()
  const store = memoryStore()
  const m = new Microphone(f.env, store, () => 1000)
  await m.listen()
  const ctx = FakeContext.made.at(-1)!
  const node = FakeWorklet.made.at(-1)!
  node.say({ rms: 0.3, t: 1 })
  const s = m.mute()
  assert.deepEqual([s.phase, m.open, m.path, m.level, m.speech], ['muted', false, 'none', 0, false])
  assert.equal(f.streams[0].track.stopped, 1)
  assert.equal(ctx.closed, 1)
  assert.equal(node.disconnected, 1)
  assert.equal(ctx.source.disconnected, 1)
  assert.equal(node.port.onmessage, null, 'a late message from the old worklet reaches nothing')
  assert.deepEqual(loadVoiceSettings(store), { on: false })
  assert.equal(m.opensAtBoot(), false, 'muted: the next visit starts off')
  assert.equal(m.word(), 'Muted')
  await m.listen()
  assert.equal(m.phase, 'listening')
  assert.equal(f.streams.length, 2, 'a fresh stream')
  assert.equal(FakeContext.made.at(-1) !== ctx, true, 'a fresh context')
})

test('toggle: open when closed, mute when open, blocked asked again; two presses within the debounce are one', async () => {
  const f = fake()
  let now = 0
  const m = new Microphone(f.env, memoryStore(), () => now)
  await m.toggle()
  assert.equal(m.phase, 'listening')
  now += 50
  assert.equal((m.toggle() as MicState).phase, 'listening', 'the double-fire of a touch is one press')
  now += 500
  assert.equal((m.toggle() as MicState).phase, 'muted')
  now += 500
  await m.toggle()
  assert.equal(m.phase, 'listening')
})

test('a refusal reads in the browser\'s own words and the pill offers another press; no media at all is unavailable', async () => {
  const refused = new Microphone(fake({ media: 'refuse' }).env, memoryStore())
  const s = await refused.listen()
  assert.equal(s.phase, 'blocked')
  assert.match(s.detail, /permission was refused/)
  assert.equal(tapMeans(refused.phase), 'open')
  assert.match(refused.label(), /^Microphone: blocked \(microphone permission was refused/)
  assert.equal(refused.opensAtBoot(), false, 'a refusal keeps no switch')
  const gone = await new Microphone(fake({ media: 'nodevice' }).env, memoryStore()).listen()
  assert.deepEqual([gone.phase, gone.detail], ['unavailable', 'no microphone found'])
  const none = await new Microphone(fake({ media: 'missing' }).env, memoryStore()).listen()
  assert.equal(none.phase, 'unavailable')
  assert.match(none.detail, /secure page/)
  assert.deepEqual(refusal({ name: 'NotReadableError' }), ['error', 'the microphone is in use by another program'])
  assert.deepEqual(refusal({ name: 'SecurityError' })[0], 'unavailable')
  assert.deepEqual(refusal({ name: 'OverconstrainedError' })[0], 'error')
  assert.deepEqual(refusal(new Error('boom')), ['error', 'the microphone could not be opened: boom'])
  assert.deepEqual(refusal('odd')[0], 'error')
})

test('the detector\'s frame follows the context\'s rate (96 kHz: 1024 samples, as long as 512 at 48 kHz) in the worklet and the poll; the poll feeds the samples since the last one by the clock, or the latest frame with no clock', async () => {
  // The sixth review's case: at 96 kHz a 512-sample frame is 5.3 ms, so every time in VAD (the 1.5 s learning, the
  // 32 ms knock) was half as long.
  const w = fake({ rate: 96_000 })
  const wm = new Microphone(w.env, memoryStore())
  await wm.listen()
  assert.equal(wm.path, 'worklet')
  assert.equal((FakeWorklet.made.at(-1)!.options as { frame: number }).frame, 1024, 'the worklet gets the frame for 96 kHz')
  assert.equal((FakeWorklet.made.at(-1)!.options as { onsetFrames: number }).onsetFrames, VAD.onsetFrames, 'and the rest of the tuning')
  wm.mute()
  const p = fake({ worklet: 'refuse', rate: 96_000 })
  const pm = new Microphone(p.env, memoryStore())
  await pm.listen()
  const pc = FakeContext.made.at(-1)!
  assert.deepEqual([pm.path, pc.analyser.fftSize], ['page', 1024 * 8])
  // A voice at 96 kHz, polled with the clock 2.5 frames on each time: an onset of four frames takes two polls.
  const n = 1024 * 8, voice = new Float32Array(n)
  for (let i = 0; i < n; i++) { let v = 0; for (let h = 1; h <= 8; h++) v += Math.sin((2 * Math.PI * 140 * h * i) / 96_000 + h) / h; voice[i] = v * 0.05 }
  pc.analyser.samples = voice
  const fed: number[] = []
  const feed = pm.feed.bind(pm)
  pm.feed = (x: Float32Array) => { fed.push(x.length); feed(x) }
  for (let i = 0; i < 2; i++) { pc.currentTime = (pc.currentTime ?? 0) + (2.5 * 1024) / 96_000; p.tick() }
  assert.deepEqual(fed, [2560, 2560], 'the samples since the last poll')
  assert.equal(pm.phase, 'speech', 'five frames of 1024: past the onset')
  pc.currentTime = (pc.currentTime ?? 0) + 60
  p.tick()
  assert.equal(fed.at(-1), n, 'a poll a minute late feeds what the analyser holds')
  pm.mute()
  // A context with no clock to read: the latest frame, once a poll.
  const q = fake({ worklet: 'refuse', clock: false })
  const qm = new Microphone(q.env, memoryStore())
  await qm.listen()
  const sizes: number[] = []
  const qfeed = qm.feed.bind(qm)
  qm.feed = (x: Float32Array) => { sizes.push(x.length); qfeed(x) }
  q.tick()
  q.tick()
  assert.deepEqual(sizes, [VAD.frame, VAD.frame])
  qm.mute()
  assert.equal(new VadCore({ ...VAD, frame: 1024 }).frame, 1024)
})

test('without a worklet the page polls an analyser through the same detector; without Web Audio the device is open with no meter', async () => {
  const f = fake({ worklet: 'refuse' })
  const m = new Microphone(f.env, memoryStore())
  await m.listen()
  assert.deepEqual([m.phase, m.path], ['listening', 'page'])
  const ctx = FakeContext.made.at(-1)!
  assert.equal(ctx.analyser.fftSize, VAD.frame * 8, 'room for eight frames')
  assert.equal(ctx.source.connected.at(-1), ctx.analyser)
  assert.equal(f.timers.size, 1, 'one poll')
  // A voice through the poll: a 140 Hz harmonic signal, loud enough; each poll the clock has moved one frame on.
  const voice = (n: number, rate: number): Float32Array => {
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) { let v = 0; for (let h = 1; h <= 8; h++) v += Math.sin((2 * Math.PI * 140 * h * i) / rate + h) / h; out[i] = v * 0.05 }
    return out
  }
  const frame = voice(VAD.frame, 48_000)
  const log = events(m)
  ctx.analyser.samples = voice(VAD.frame * 8, 48_000)
  f.tick()
  assert.equal(m.phase, 'listening', 'the clock has not moved: nothing new to feed')
  for (let i = 0; i < VAD.onsetFrames; i++) { ctx.currentTime = (ctx.currentTime ?? 0) + VAD.frame / 48_000; f.tick() }
  assert.equal(m.phase, 'speech', 'one frame a poll: speech after the onset frames')
  assert.ok(m.level > 0.01)
  assert.deepEqual(log, ['speech:true', 'change:speech'])
  m.mute()
  assert.equal(f.timers.size, 0, 'the poll stops with the device')
  const g = fake({ worklet: 'none', workletNode: false })
  const n = new Microphone(g.env, memoryStore())
  await n.listen()
  assert.equal(n.path, 'page', 'no AudioWorkletNode constructor: the page path too')
  const h = fake({ context: false })
  const o = new Microphone(h.env, memoryStore())
  const s = await o.listen()
  assert.deepEqual([s.phase, o.path], ['listening', 'none'])
  assert.match(s.detail, /no Web Audio/)
  o.feed(frame)
  assert.equal(o.phase, 'listening', 'no detector, no speech state')
})

test('an open() overtaken by a mute() leaves nothing open; the device unplugged reads as an error; close and dispose keep the switch', async () => {
  const gate: { release: ((s: StreamLike) => void) | null } = { release: null }
  const stream = new FakeStream()
  const f = fake()
  f.env.media = { getUserMedia: () => new Promise<StreamLike>((resolve) => { gate.release = resolve }) }
  const store = memoryStore()
  const m = new Microphone(f.env, store)
  const p = m.listen()
  assert.equal(m.phase, 'opening')
  m.mute()
  gate.release!(stream)
  const s = await p
  assert.equal(s.phase, 'muted')
  assert.equal(stream.track.stopped, 1, 'the late stream is stopped at once')
  assert.equal(m.open, false)
  // Unplugged.
  const g = fake()
  const n = new Microphone(g.env, store)
  await n.listen()
  g.streams[0].track.unplug()
  assert.equal(n.phase, 'error')
  assert.match(n.state.detail, /went away/)
  assert.equal(FakeContext.made.at(-1)!.closed, 1)
  // Close (the city going away, a halt), then dispose (the shell unmounting).
  const h = fake()
  const o = new Microphone(h.env, store)
  await o.listen()
  assert.deepEqual(loadVoiceSettings(store), { on: true })
  assert.equal(o.close().phase, 'off')
  assert.deepEqual([o.phase, h.streams[0].track.stopped, o.open], ['off', 1, false])
  assert.deepEqual(loadVoiceSettings(store), { on: true }, 'the city going away is not the visitor muting')
  assert.equal(o.opensAtBoot(), true)
  assert.equal(o.close().phase, 'off', 'closed twice: nothing more')
  await o.listen()
  assert.equal(o.phase, 'listening', 'and it opens again')
  o.dispose()
  assert.deepEqual([o.phase, h.streams[1].track.stopped], ['off', 1])
  assert.equal((await o.listen()).phase, 'off', 'disposed: nothing opens')
  o.mute()
  assert.equal(o.phase, 'muted', 'but a mute still records the choice')
})

test('resume wakes a context the browser started asleep; the console lines say the phase, the pill, the detector, the boot rule and the words', async () => {
  const f = fake()
  const m = new Microphone(f.env, memoryStore())
  m.resume()
  await m.listen()
  const ctx = FakeContext.made.at(-1)!
  ctx.state = 'suspended'
  m.resume()
  assert.equal(ctx.resumed, 1)
  m.resume()
  assert.equal(ctx.resumed, 1, 'running: nothing to do')
  const lines = voiceStatus(m, false, 'on-device recognition: none in this browser')
  assert.equal(lines.length, 5)
  assert.match(lines[0], /^mic {7}listening/)
  assert.match(lines[1], /^pill {6}Listening/)
  assert.match(lines[2], /^detector {2}audio worklet · the room/)
  assert.match(lines[3], /^boot {6}opens at boot {2}\(kept switch on; the default off\)/)
  assert.match(lines[4], /^words {5}on-device recognition: none/)
  m.mute()
  assert.match(voiceStatus(m, true, '')[1], /^pill {6}Muted/)
  assert.match(voiceStatus(m, true, '')[3], /off until pressed {2}\(kept switch off/)
})
