/**
 * Why does this file exist? It proves the recorder pipeline against a fake encoder and track reader:
 * codec choice order, the header written with the first chunk (decoder config included), one packet per
 * chunk carrying that frame's telemetry, keyframes by counter, every frame closed, backpressure drops
 * counted, the bounded telemetry map, stop's flush → close → track stop → header rewrite → sink close
 * ordering (seekable and not), clean endings on encoder or sink failure and on a track that ends by
 * itself, start failures that abort the sink, `supported()` on a bare globalThis, the memory sink used
 * by the download fallback, and the wording of the per-frame markdown (real events only, no combat words).
 * What breaks if it is removed? A regression could leak frames, write an undecodable file, or throw out
 * of the frame loop; the browser would be the first to notice.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readAgv } from './agv.ts'
import {
  CODECS, MemorySink, RECORDER_DEFAULTS, Recorder, SnapshotTelemetry, TELEMETRY_HOLD_US, fileSink, markdownFor, pickCodec,
  type RecorderEnv, type RecorderSink,
} from './recorder.ts'
import type { SipocSnapshot } from './telemetry.ts'
import type { TrackProcessor, VideoEncoderLike, VideoFrameLike, VideoFrameReader } from '../04_Connect_Hardware/web-hardware.d.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const settle = () => sleep(5)
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await sleep(1)
  }
}

// ---------------------------------------------------------------------------------------------------
// Fakes

class FakeFrame implements VideoFrameLike {
  readonly timestamp: number
  closed = false
  constructor(timestamp: number) { this.timestamp = timestamp }
  close() { this.closed = true }
}

/** A track reader: frames pushed by the test, pending reads resolved as they arrive; cancel ends it. */
class FakeReader implements VideoFrameReader {
  private queue: FakeFrame[] = []
  private waiters: ((r: { value?: FakeFrame; done: boolean }) => void)[] = []
  private ended = false
  cancelled = false
  push(frame: FakeFrame) {
    if (this.ended) return
    const w = this.waiters.shift()
    if (w) w({ value: frame, done: false })
    else this.queue.push(frame)
  }
  end() {
    this.ended = true
    for (const w of this.waiters.splice(0)) w({ done: true })
  }
  read(): Promise<{ value?: FakeFrame; done: boolean }> {
    return new Promise((resolve) => {
      const f = this.queue.shift()
      if (f) resolve({ value: f, done: false })
      else if (this.ended) resolve({ done: true })
      else this.waiters.push(resolve)
    })
  }
  async cancel() {
    this.cancelled = true
    for (const f of this.queue.splice(0)) f.close() // the stream closes what it discards
    this.end()
  }
  releaseLock() {}
}

interface Job { ts: number; key: boolean }

/** A VideoEncoder: chunks come out synchronously in encode() ('sync') or when drained/flushed ('deferred'). */
class FakeEncoder implements VideoEncoderLike {
  state: CodecState = 'unconfigured'
  encodeQueueSize = 0
  config: VideoEncoderConfig | null = null
  readonly calls: string[] = []
  readonly onError: (e: DOMException) => void
  emitted = 0
  private readonly out: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => void
  private readonly mode: 'sync' | 'deferred'
  private readonly description: Uint8Array | undefined
  private readonly configureThrows: boolean
  private queued: Job[] = []
  constructor(init: VideoEncoderInit, mode: 'sync' | 'deferred', description: Uint8Array | undefined, configureThrows: boolean) {
    this.out = init.output
    this.onError = init.error
    this.mode = mode
    this.description = description
    this.configureThrows = configureThrows
  }
  configure(c: VideoEncoderConfig) {
    if (this.configureThrows) throw new DOMException('config rejected', 'NotSupportedError')
    this.config = c
    this.state = 'configured'
  }
  encode(frame: VideoFrameLike, options?: VideoEncoderEncodeOptions) {
    if (this.state !== 'configured') throw new DOMException('encoder is not configured', 'InvalidStateError')
    this.calls.push(`encode ${frame.timestamp}${options?.keyFrame ? ' key' : ''}`)
    const job = { ts: frame.timestamp, key: options?.keyFrame === true }
    if (this.mode === 'sync') this.emit(job)
    else {
      this.queued.push(job)
      this.encodeQueueSize = this.queued.length
    }
  }
  drain(n = Infinity) {
    while (this.queued.length && n-- > 0) {
      this.emit(this.queued.shift()!)
      this.encodeQueueSize = this.queued.length
    }
  }
  private emit(job: Job) {
    const data = new Uint8Array([job.key ? 0xaa : 0x55, job.ts & 0xff])
    const chunk: EncodedVideoChunk = {
      type: job.key ? 'key' : 'delta', timestamp: job.ts, duration: null, byteLength: data.byteLength,
      copyTo: (dst) => { (ArrayBuffer.isView(dst) ? new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength) : new Uint8Array(dst)).set(data) },
    }
    const first = this.emitted++ === 0
    const c = this.config!
    const decoderConfig: VideoDecoderConfig = { codec: c.codec, codedWidth: c.width, codedHeight: c.height, ...(this.description ? { description: this.description } : {}) }
    this.out(chunk, first ? { decoderConfig } : undefined)
  }
  async flush() {
    this.calls.push('flush')
    if (this.state !== 'configured') throw new DOMException('encoder is closed', 'InvalidStateError')
    this.drain()
  }
  close() {
    this.calls.push('close')
    this.state = 'closed'
    this.queued = []
    this.encodeQueueSize = 0
  }
}

interface RigOptions {
  supported?: (c: VideoEncoderConfig) => boolean
  probe?: (c: VideoEncoderConfig) => Promise<{ supported?: boolean }>
  mode?: 'sync' | 'deferred'
  description?: Uint8Array
  configureThrows?: boolean
  noProcessor?: boolean
}

interface Rig { env: RecorderEnv; reader: FakeReader; encoders: FakeEncoder[]; clock: { now: number } }

/** A page with WebCodecs: by default only software AV1 is supported (like a headless browser). */
function rig(o: RigOptions = {}): Rig {
  const reader = new FakeReader()
  const encoders: FakeEncoder[] = []
  const clock = { now: 1000 }
  const supported = o.supported ?? ((c) => c.codec.startsWith('av01') && c.hardwareAcceleration === 'no-preference')
  class Encoder extends FakeEncoder {
    constructor(init: VideoEncoderInit) {
      super(init, o.mode ?? 'deferred', o.description, o.configureThrows === true)
      encoders.push(this)
    }
    static isConfigSupported(c: VideoEncoderConfig): Promise<VideoEncoderSupport> {
      return o.probe ? o.probe(c) : Promise.resolve({ supported: supported(c) })
    }
  }
  class Processor implements TrackProcessor {
    readonly readable = { getReader: () => reader }
    constructor(_init: { track: MediaStreamTrack }) {}
  }
  return { env: { VideoEncoder: Encoder, MediaStreamTrackProcessor: o.noProcessor ? undefined : Processor, now: () => clock.now }, reader, encoders, clock }
}

class FakeTrack {
  stopped = 0
  stop() { this.stopped++ }
  asTrack(): MediaStreamTrack { return this as unknown as MediaStreamTrack }
}

/** A sink over MemorySink that logs the call order; optionally not seekable, optionally failing one write. */
class LogSink implements RecorderSink {
  readonly log: string[] = []
  blob: Blob | null = null
  readonly mem = new MemorySink((blob) => { this.blob = blob })
  failOnWrite = -1
  seek?: (position: number) => void
  private n = 0
  constructor(seekable = true) {
    if (seekable) this.seek = (p) => { this.log.push(`seek ${p}`); this.mem.seek(p) }
  }
  write(b: Uint8Array) {
    if (this.n++ === this.failOnWrite) throw new Error('disk full')
    this.log.push(`write ${b.byteLength}`)
    this.mem.write(b)
  }
  close() { this.log.push('close'); this.mem.close() }
  abort() { this.log.push('abort'); this.mem.abort() }
  bytes() { return this.mem.snapshot() }
}

function counting(): { provider: () => ReturnType<SnapshotTelemetry['next']>; n: () => number } {
  let n = 0
  return {
    provider: () => ({ intent: 'walk', markdown_log: '', confidence: 1, spatial_coordinates: [n, 1.7, -n - 1], state: { n: n++ } }),
    n: () => n,
  }
}

async function started(o: RigOptions = {}, opts: Parameters<Recorder['start']>[3] = {}, seekable = true) {
  const r = rig(o)
  const c = counting()
  const rec = new Recorder(c.provider, r.env)
  const sink = new LogSink(seekable)
  const track = new FakeTrack()
  const ended: (string | null)[] = []
  rec.onEnd = (_s, e) => ended.push(e)
  const codec = await rec.start(track.asTrack(), 'canvas', sink, opts)
  return { r, rec, sink, track, ended, codec, enc: r.encoders[0], counter: c }
}

// ---------------------------------------------------------------------------------------------------
// Support and codec choice

test('supported(): a bare globalThis (Node) says no with a reason; each missing piece is named', () => {
  const bare = Recorder.supported()
  assert.equal(bare.ok, false)
  assert.match(bare.reason, /VideoEncoder/)
  assert.deepEqual(Recorder.supported({}), bare)
  assert.deepEqual(Recorder.supported({ VideoEncoder: rig().env.VideoEncoder }), { ok: false, reason: 'MediaStreamTrackProcessor is not available in this browser' })
  assert.deepEqual(Recorder.supported(rig().env), { ok: true, reason: '' })
  assert.equal(Recorder.supported({ VideoEncoder: (() => {}) as unknown as RecorderEnv['VideoEncoder'] }).ok, false, 'no isConfigSupported')
})

test('pickCodec: hardware pass over AV1 → H.264 → VP9, then no-preference; a probe that throws is unsupported; nothing → throws', async () => {
  const asked: string[] = []
  const probe = (ok: (c: VideoEncoderConfig) => boolean) => async (c: VideoEncoderConfig) => { asked.push(`${c.codec} ${c.hardwareAcceleration}`); return { supported: ok(c) } }
  // AV1 unsupported everywhere, hardware H.264 available.
  let cfg = await pickCodec(probe((c) => c.codec.startsWith('avc1')), 1280, 720, 2_000_000, 30)
  assert.deepEqual(asked, ['av01.0.04M.08 prefer-hardware', 'avc1.42E01F prefer-hardware'])
  assert.deepEqual(cfg, { codec: 'avc1.42E01F', avc: { format: 'annexb' }, width: 1280, height: 720, bitrate: 2_000_000, framerate: 30, hardwareAcceleration: 'prefer-hardware', latencyMode: 'realtime' })
  // Only software VP9: the sixth and last try.
  asked.length = 0
  cfg = await pickCodec(probe((c) => c.codec.startsWith('vp09') && c.hardwareAcceleration === 'no-preference'), 640, 360, 1_000_000, 24)
  assert.equal(asked.length, 6)
  assert.deepEqual(asked.slice(3), ['av01.0.04M.08 no-preference', 'avc1.42E01F no-preference', 'vp09.00.10.08 no-preference'])
  assert.equal(cfg.codec, 'vp09.00.10.08')
  assert.equal(cfg.avc, undefined)
  assert.equal(cfg.width, 640)
  // Software AV1 beats nothing else; hardware anything beats software AV1.
  assert.equal((await pickCodec(probe((c) => c.hardwareAcceleration === 'no-preference'), 1280, 720, 2e6, 30)).codec, 'av01.0.04M.08')
  assert.equal((await pickCodec(probe((c) => c.codec.startsWith('vp09') || c.hardwareAcceleration === 'no-preference'), 1280, 720, 2e6, 30)).codec, 'vp09.00.10.08')
  assert.equal((await pickCodec(probe(() => true), 1280, 720, 2e6, 30)).codec, 'av01.0.04M.08')
  // Nothing at all.
  await assert.rejects(pickCodec(probe(() => false), 1280, 720, 2e6, 30), /no supported video encoder: tried av01\.0\.04M\.08 \(prefer-hardware\), .*vp09\.00\.10\.08 \(no-preference\)$/)
  // A throwing probe (older browser quirk) counts as unsupported rather than aborting the search.
  let n = 0
  cfg = await pickCodec(async (c) => { if (n++ < 2) throw new TypeError('bad config'); return { supported: c.codec.startsWith('vp09') } }, 1280, 720, 2e6, 30)
  assert.equal(cfg.codec, 'vp09.00.10.08')
  // The probe's answer must be exactly true.
  await assert.rejects(pickCodec(async () => ({}), 1280, 720, 2e6, 30), /no supported video encoder/)
  assert.deepEqual(CODECS.map((c) => c.codec), ['av01.0.04M.08', 'avc1.42E01F', 'vp09.00.10.08'])
})

// ---------------------------------------------------------------------------------------------------
// Telemetry wording

test('markdownFor: nothing happened → empty; real events only, singular and plural, joined in order', () => {
  assert.equal(markdownFor({}), '')
  assert.equal(markdownFor({ law1: 0, flips: 0, tier: undefined, panic: null }), '')
  assert.equal(markdownFor({ law1: -1 }), '', 'a counter going backwards is not an event')
  assert.equal(markdownFor({ law1: 1 }), '**First Law** held back a vehicle for a person')
  assert.equal(markdownFor({ law1: 3 }), '**First Law** held back 3 vehicles for a person')
  assert.equal(markdownFor({ flips: 1 }), '**Sanctuary** shielded a person (Solid to Sensor)')
  assert.equal(markdownFor({ flips: 2 }), '**Sanctuary** shielded 2 people (Solid to Sensor)')
  assert.equal(markdownFor({ tier: 'High' }), '**Quality** tier is now High')
  assert.equal(markdownFor({ panic: 'perimeter breached' }), '**Kernel panic** perimeter breached')
  const all = markdownFor({ law1: 2, flips: 1, tier: 'Low', panic: 'x' })
  assert.equal(all, '**First Law** held back 2 vehicles for a person · **Sanctuary** shielded a person (Solid to Sensor) · **Quality** tier is now Low · **Kernel panic** x')
  assert.doesNotMatch(all, /\b(attack|kill|weapon|target|shoot|gun|violence|injur\w*|damage|collision|crash|hit)\b/i)
})

function snapshot(over: { law1?: number; flips?: number; tier?: string; panic?: string | null; mode?: 'foot' | 'vehicle' } = {}): SipocSnapshot {
  return {
    kernel: {
      law1: over.law1 ?? 5, law2: 1, law3: 2, sensorFlips: over.flips ?? 4, shielded: false, last: 'First Law: person 3.2 m ahead',
      audit: { ticks: 100, perimeterBreaches: 0, velocityCaps: 1, closest: Infinity, panic: over.panic ?? null },
    },
    quality: { tier: 3, label: over.tier ?? 'High', auto: true, renderScale: 1, targetMs: 16.7 },
    input: { mode: over.mode ?? 'foot', nearVehicle: false },
    output: { fps: 59.6, frameMs: 16.7, p50Ms: 16, p95Ms: 18, cpuMs: 4, gpuRenderMs: 3, gpuComputeMs: 0, physicsMs: 1, rapierMs: 0.4 },
    customer: { name: 'Probe', clock: '17:05', daylight: 0.8, viewYaw: 0, district: 'Financial District · 3rd Ave & 4th St', speedKmh: 0, gear: 'N', x: 12.5, z: -3, heading: 1.2, signalEW: 'green', signalNS: 'red', signalRemaining: 10 },
  } as unknown as SipocSnapshot
}

test('SnapshotTelemetry: direct state, the eye as coordinates, the brief root or the mode as intent, events as deltas', () => {
  const t = new SnapshotTelemetry()
  const a = t.next(snapshot(), { x: 1, y: 1.7, z: 2 }, null)
  assert.equal(a.intent, 'Walking the Financial District')
  assert.equal(a.markdown_log, '', 'the first frame has no previous frame to compare with')
  assert.equal(a.confidence, 1)
  assert.deepEqual(a.spatial_coordinates, [1, 1.7, 2])
  assert.equal(a.state?.clock, '17:05')
  assert.equal(a.state?.tier, 'High')
  assert.equal(a.state?.mode, 'foot')
  assert.deepEqual(a.state?.kernel, { law1: 5, law2: 1, law3: 2, sensorFlips: 4, shielded: false, last: 'First Law: person 3.2 m ahead' })
  assert.deepEqual(a.state?.audit, { ticks: 100, perimeterBreaches: 0, velocityCaps: 1, closest: null, panic: null })
  assert.equal(a.state?.brief, null)
  assert.equal(JSON.parse(JSON.stringify(a)).state.audit.closest, null, 'Infinity does not survive JSON; null is written on purpose')
  // Nothing moved: no log line.
  assert.equal(t.next(snapshot(), { x: 1, y: 1.7, z: 2 }, null).markdown_log, '')
  // Two holds, one flip, a tier change and a panic since the previous frame.
  const b = t.next(snapshot({ law1: 7, flips: 5, tier: 'Low', panic: 'perimeter breached', mode: 'vehicle' }), { x: 0, y: 1.2, z: 0 }, 'You want the city at night.')
  assert.equal(b.intent, 'You want the city at night.')
  assert.equal(b.markdown_log, '**First Law** held back 2 vehicles for a person · **Sanctuary** shielded a person (Solid to Sensor) · **Quality** tier is now Low · **Kernel panic** perimeter breached')
  assert.equal(b.state?.brief, 'You want the city at night.')
  assert.equal(b.state?.mode, 'vehicle')
  // The same panic is not reported twice; driving reads as driving.
  const c = t.next(snapshot({ law1: 7, flips: 5, tier: 'Low', panic: 'perimeter breached', mode: 'vehicle' }), { x: 0, y: 1.2, z: 0 }, null)
  assert.equal(c.markdown_log, '')
  assert.equal(c.intent, 'Driving through the Financial District')
})

// ---------------------------------------------------------------------------------------------------
// The pipeline

test('pipeline: header with the first chunk, a packet per chunk with that frame\'s telemetry, keyframes by counter, frames closed, stop order', async () => {
  const { r, rec, sink, track, ended, codec, enc } = await started({ description: new Uint8Array([1, 2, 3]) }, { keyframeInterval: 3 })
  assert.equal(codec, 'av01.0.04M.08')
  assert.deepEqual(rec.state, { active: true, source: 'canvas', seconds: 0, frames: 0, bytes: 0, dropped: 0, codec: 'av01.0.04M.08' })
  assert.equal(enc.config?.latencyMode, 'realtime')
  assert.equal(enc.config?.width, RECORDER_DEFAULTS.width)
  const frames = [0, 1, 2, 3, 4].map((i) => new FakeFrame(i * 33_333))
  r.clock.now += 5000
  for (const f of frames) r.reader.push(f)
  await until(() => enc.calls.length === 5)
  assert.deepEqual(enc.calls, ['encode 0 key', 'encode 33333', 'encode 66666', 'encode 99999 key', 'encode 133332'])
  assert.ok(frames.every((f) => f.closed), 'every frame is closed after encode')
  assert.equal(rec.state.seconds, 5, 'elapsed time is kept up to date as frames arrive')
  await settle()
  assert.deepEqual(sink.log, [], 'nothing is written before the encoder returns a chunk (the header needs its decoder config)')
  enc.drain(2)
  await until(() => sink.log.length === 3)
  assert.match(sink.log[0], /^write \d+$/)
  assert.equal(rec.state.frames, 2)
  assert.equal(rec.state.bytes, sink.bytes().byteLength)
  enc.drain()
  await until(() => rec.state.frames === 5)
  const st = await rec.stop()
  assert.equal(st, rec.state, 'the same object, mutated in place')
  assert.equal(st.active, false)
  assert.equal(st.frames, 5)
  assert.equal(st.dropped, 0)
  assert.equal(st.seconds, 5)
  assert.equal(track.stopped, 1)
  assert.ok(r.reader.cancelled)
  assert.deepEqual(enc.calls.slice(5), ['flush', 'close'])
  assert.deepEqual(sink.log.slice(-3), ['seek 0', sink.log[0], 'close'], 'the header is rewritten at the same length, then the sink closes')
  assert.equal(st.bytes, sink.bytes().byteLength)
  assert.equal(sink.blob?.size, st.bytes)
  const file = readAgv(sink.bytes())
  assert.equal(file.header.codec, 'av01.0.04M.08')
  assert.equal(file.header.source, 'canvas')
  assert.equal(file.header.width, 1280)
  assert.equal(file.header.framerate, 30)
  assert.ok(!Number.isNaN(Date.parse(file.header.startedAt)))
  assert.equal(file.header.frames, 5)
  assert.equal(file.header.durationUs, 133_332, 'last − first timestamp (+ the last duration, 0 here)')
  assert.deepEqual(file.header.decoderConfig, { codec: 'av01.0.04M.08', codedWidth: 1280, codedHeight: 720, descriptionBase64: 'AQID' })
  assert.equal(file.packets.length, 5)
  assert.deepEqual(file.packets.map((p) => p.type), ['key', 'delta', 'delta', 'key', 'delta'])
  assert.deepEqual(file.packets.map((p) => p.timestamp), [0, 33_333, 66_666, 99_999, 133_332])
  assert.deepEqual(file.packets.map((p) => p.duration), [0, 0, 0, 0, 0], 'a null chunk duration is written as 0')
  assert.deepEqual(file.packets.map((p) => p.telemetry.state?.n), [0, 1, 2, 3, 4], 'telemetry captured at encode time travels with its chunk')
  assert.deepEqual(file.packets.map((p) => p.telemetry.spatial_coordinates[0]), [0, 1, 2, 3, 4])
  assert.deepEqual(Array.from(file.packets[0].data), [0xaa, 0])
  assert.deepEqual(Array.from(file.packets[1].data), [0x55, 33_333 & 0xff])
  assert.deepEqual(ended, [null])
  assert.equal(rec.error, null)
  // Stopping again is a no-op that reports the same state.
  assert.equal(await rec.stop(), st)
  assert.equal(track.stopped, 1)
})

test('backpressure: a frame arriving with more than maxQueue queued is dropped, counted and closed', async () => {
  const { r, rec, sink, enc } = await started({}, { maxQueue: 2 })
  const frames = [0, 1, 2, 3, 4, 5].map((i) => new FakeFrame(1_000_000 + i * 40_000))
  for (const f of frames) r.reader.push(f)
  await until(() => frames.every((f) => f.closed))
  assert.equal(enc.calls.length, 3, 'queue 0, 1, 2 admit; 3 > 2 refuses')
  assert.equal(enc.encodeQueueSize, 3)
  assert.equal(rec.state.dropped, 3)
  enc.drain()
  await rec.stop()
  assert.equal(rec.state.dropped, 3)
  assert.equal(rec.state.frames, 3)
  assert.equal(readAgv(sink.bytes()).packets.length, 3)
  // maxQueue 0 admits only when the encoder is idle.
  const strict = await started({}, { maxQueue: 0 })
  const two = [new FakeFrame(0), new FakeFrame(40_000)]
  for (const f of two) strict.r.reader.push(f)
  await until(() => two.every((f) => f.closed))
  assert.equal(strict.enc.calls.length, 1)
  assert.equal(strict.rec.state.dropped, 1)
  await strict.rec.stop()
})

test('pending telemetry is bounded: an entry the encoder has not returned within 2 s is dropped; the chunk then takes the latest', async () => {
  const { r, rec, sink, enc } = await started()
  const a = new FakeFrame(0), b = new FakeFrame(TELEMETRY_HOLD_US + 1)
  r.reader.push(a)
  await until(() => enc.calls.length === 1)
  r.reader.push(b)
  await until(() => enc.calls.length === 2)
  enc.drain()
  await rec.stop()
  const p = readAgv(sink.bytes()).packets
  assert.deepEqual(p.map((x) => x.timestamp), [0, TELEMETRY_HOLD_US + 1])
  assert.deepEqual(p.map((x) => x.telemetry.state?.n), [1, 1], 'frame 0 lost its own entry; it carries the newest instead of nothing')
  // A provider that throws never reaches the frame loop: the frame is still encoded, with empty telemetry.
  const bad = rig()
  let calls = 0
  const rec2 = new Recorder(() => { calls++; throw new Error('snapshot failed') }, bad.env)
  const sink2 = new LogSink()
  await rec2.start(new FakeTrack().asTrack(), 'camera', sink2)
  const f = new FakeFrame(5)
  bad.reader.push(f)
  await until(() => f.closed)
  assert.equal(calls, 1)
  bad.encoders[0].drain()
  await rec2.stop()
  const file = readAgv(sink2.bytes())
  assert.equal(file.header.source, 'camera')
  assert.deepEqual(file.packets[0].telemetry, { intent: '', markdown_log: '', confidence: 0, spatial_coordinates: [0, 0, 0] })
})

test('a sink without seek gets no header rewrite; the file is still complete and readable', async () => {
  const { r, rec, sink, enc } = await started({}, {}, false)
  const f = new FakeFrame(10)
  r.reader.push(f)
  await until(() => enc.calls.length === 1)
  enc.drain()
  await until(() => sink.log.length === 2)
  await rec.stop()
  assert.deepEqual(sink.log.filter((l) => l.startsWith('seek')), [])
  assert.equal(sink.log.at(-1), 'close')
  const file = readAgv(sink.bytes())
  assert.equal(file.header.frames, undefined)
  assert.equal(file.packets.length, 1)
})

test('an encoder error ends the recording cleanly: what was written is kept, the sink closed, the track stopped, the error reported', async () => {
  const { r, rec, sink, track, ended, enc } = await started()
  for (const ts of [0, 33_333]) r.reader.push(new FakeFrame(ts))
  await until(() => enc.calls.length === 2)
  enc.drain()
  await until(() => sink.log.length === 3)
  enc.onError(new DOMException('encoder lost', 'EncodingError'))
  await until(() => !rec.state.active)
  assert.equal(rec.error, 'encoder lost')
  assert.deepEqual(ended, ['encoder lost'])
  assert.equal(track.stopped, 1)
  assert.ok(!enc.calls.includes('flush'), 'no flush after a fatal error')
  assert.equal(enc.calls.at(-1), 'close')
  assert.equal(sink.log.at(-1), 'close')
  assert.ok(!sink.log.includes('abort'))
  assert.equal(readAgv(sink.bytes()).packets.length, 2)
  // A late frame after the failure is closed, not encoded.
  const late = new FakeFrame(66_666)
  r.reader.push(late)
  await settle()
  assert.equal(enc.calls.filter((c) => c.startsWith('encode')).length, 2)
  // stop() afterwards is a no-op; the next start() clears the error.
  assert.equal((await rec.stop()).active, false)
  await rec.start(new FakeTrack().asTrack(), 'canvas', new LogSink())
  assert.equal(rec.error, null)
  assert.equal(rec.state.frames, 0)
  await rec.stop()
})

test('a sink write failure ends the recording with the error; no header rewrite is attempted', async () => {
  const { r, rec, sink, ended, enc } = await started()
  sink.failOnWrite = 1 // the first packet
  for (const ts of [0, 33_333, 66_666]) r.reader.push(new FakeFrame(ts))
  await until(() => enc.calls.length === 3)
  enc.drain()
  await until(() => !rec.state.active)
  assert.equal(rec.error, 'disk full')
  assert.deepEqual(ended, ['disk full'])
  assert.deepEqual(sink.log.filter((l) => !l.startsWith('write')), ['close'])
  assert.equal(sink.log.filter((l) => l.startsWith('write')).length, 1, 'only the header reached the sink')
  await assert.doesNotReject(rec.stop())
})

test('a track that ends by itself (camera unplugged) finishes the file like stop()', async () => {
  const { r, rec, sink, track, ended, enc } = await started({ mode: 'sync' })
  const frames = [0, 33_333, 66_666].map((ts) => new FakeFrame(ts))
  for (const f of frames) r.reader.push(f)
  await until(() => rec.state.frames === 3)
  r.reader.end()
  await until(() => !rec.state.active)
  assert.deepEqual(ended, [null])
  assert.equal(rec.error, null)
  assert.equal(track.stopped, 1)
  assert.deepEqual(enc.calls.slice(3), ['flush', 'close'])
  assert.equal(sink.log.at(-1), 'close')
  const file = readAgv(sink.bytes())
  assert.equal(file.header.frames, 3)
  assert.equal(file.packets.length, 3)
})

test('stop() while frames are queued in the encoder flushes them into the file first', async () => {
  const { r, rec, sink, enc } = await started()
  const frames = [0, 33_333, 66_666, 99_999].map((ts) => new FakeFrame(ts))
  for (const f of frames) r.reader.push(f)
  await until(() => enc.calls.length === 4)
  assert.equal(enc.encodeQueueSize, 4)
  const [a, b] = await Promise.all([rec.stop(), rec.stop()])
  assert.equal(a, b)
  assert.equal(readAgv(sink.bytes()).packets.length, 4)
  assert.equal(rec.state.frames, 4)
})

test('start failures reject with the reason, stop the track and abort (not close) the sink', async () => {
  const tel = counting().provider
  const cases: [RigOptions, RegExp][] = [
    [{ noProcessor: true }, /MediaStreamTrackProcessor/],
    [{ supported: () => false }, /no supported video encoder/],
    [{ configureThrows: true }, /config rejected/],
  ]
  for (const [o, why] of cases) {
    const r = rig(o)
    const rec = new Recorder(tel, r.env)
    const sink = new LogSink()
    const track = new FakeTrack()
    await assert.rejects(rec.start(track.asTrack(), 'canvas', sink), why)
    assert.equal(track.stopped, 1, String(why))
    assert.deepEqual(sink.log, ['abort'], String(why))
    assert.equal(rec.state.active, false)
    assert.equal(rec.state.codec, '')
  }
  // Without WebCodecs at all (a bare globalThis) the same clean failure, and a sink without abort is closed.
  const plain = new Recorder(tel, {})
  const closable: RecorderSink & { log: string[] } = { log: [], write() {}, close() { this.log.push('close') } }
  await assert.rejects(plain.start(new FakeTrack().asTrack(), 'canvas', closable), /VideoEncoder/)
  assert.deepEqual(closable.log, ['close'])
  // A second start while one runs.
  const { rec, sink } = await started()
  const other = new LogSink()
  await assert.rejects(rec.start(new FakeTrack().asTrack(), 'camera', other), /already recording/)
  assert.equal(rec.state.source, 'canvas')
  assert.deepEqual(other.log, [], 'the refused start leaves its sink alone')
  await rec.stop()
  assert.deepEqual(sink.log, ['abort'], 'stopped before any frame was encoded: the untouched file is discarded, not left empty')
  // stop() while the codec probe is still pending cancels the start.
  let release: (() => void) | null = null
  const r = rig({ probe: () => new Promise((res) => { release = () => res({ supported: true }) }) })
  const rec2 = new Recorder(tel, r.env)
  const track2 = new FakeTrack()
  const sink2 = new LogSink()
  const p = rec2.start(track2.asTrack(), 'canvas', sink2)
  await until(() => release !== null)
  await rec2.stop()
  release!()
  await assert.rejects(p, /cancelled before it started/)
  assert.equal(track2.stopped, 1)
  assert.deepEqual(sink2.log, ['abort'])
  assert.equal(r.encoders.length, 0)
})

// ---------------------------------------------------------------------------------------------------
// Sinks

test('MemorySink: appends, seeks and overwrites in place across parts, appends past the end, hands over a Blob at close', async () => {
  const handed: [Blob, number][] = []
  const m = new MemorySink((blob, bytes) => handed.push([blob, bytes]))
  m.write(new Uint8Array([1, 2, 3]))
  m.write(new Uint8Array([4, 5, 6, 7]))
  assert.equal(m.bytes, 7)
  assert.deepEqual(Array.from(m.snapshot()), [1, 2, 3, 4, 5, 6, 7])
  m.seek(2)
  m.write(new Uint8Array([9, 9, 9]))
  assert.deepEqual(Array.from(m.snapshot()), [1, 2, 9, 9, 9, 6, 7], 'spans the boundary between parts')
  assert.equal(m.bytes, 7)
  m.write(new Uint8Array([8]))
  assert.deepEqual(Array.from(m.snapshot()), [1, 2, 9, 9, 9, 8, 7], 'the cursor stays where the write ended, like a file')
  m.seek(6)
  m.write(new Uint8Array([0, 11, 12]))
  assert.deepEqual(Array.from(m.snapshot()), [1, 2, 9, 9, 9, 8, 0, 11, 12], 'past the end appends')
  assert.equal(m.bytes, 9)
  m.write(new Uint8Array([13]))
  assert.deepEqual(Array.from(m.snapshot()), [1, 2, 9, 9, 9, 8, 0, 11, 12, 13])
  m.seek(100)
  m.write(new Uint8Array([14]))
  assert.equal(m.bytes, 11, 'a seek past the end clamps to the end')
  m.close()
  assert.equal(handed.length, 1)
  assert.equal(handed[0][1], 11)
  assert.equal(handed[0][0].size, 11)
  assert.equal(handed[0][0].type, 'application/octet-stream')
  assert.deepEqual(Array.from(new Uint8Array(await handed[0][0].arrayBuffer())), [1, 2, 9, 9, 9, 8, 0, 11, 12, 13, 14])
  m.abort()
  assert.equal(m.bytes, 0)
  assert.equal(m.snapshot().byteLength, 0)
})

test('fileSink forwards write, seek, close and abort to the writable stream', async () => {
  const log: string[] = []
  const w = {
    write: async (b: Uint8Array) => { log.push(`write ${b.byteLength}`) },
    seek: async (p: number) => { log.push(`seek ${p}`) },
    close: async () => { log.push('close') },
    abort: async () => { log.push('abort') },
  } as unknown as FileSystemWritableFileStream
  const s = fileSink(w)
  await s.write(new Uint8Array(3))
  await s.seek!(0)
  await s.close()
  await s.abort!()
  assert.deepEqual(log, ['write 3', 'seek 0', 'close', 'abort'])
})

test('the recorder writes the memory sink like a file: the download fallback gets a finalized header', async () => {
  const r = rig()
  const blobs: Blob[] = []
  const mem = new MemorySink((blob) => blobs.push(blob))
  const rec = new Recorder(counting().provider, r.env)
  await rec.start(new FakeTrack().asTrack(), 'canvas', mem)
  for (const ts of [0, 33_333]) r.reader.push(new FakeFrame(ts))
  await until(() => r.encoders[0].calls.length === 2)
  r.encoders[0].drain()
  await rec.stop()
  assert.equal(blobs.length, 1)
  const file = readAgv(new Uint8Array(await blobs[0].arrayBuffer()))
  assert.equal(file.header.frames, 2)
  assert.equal(file.packets.length, 2)
  assert.equal(blobs[0].size, rec.state.bytes)
})
