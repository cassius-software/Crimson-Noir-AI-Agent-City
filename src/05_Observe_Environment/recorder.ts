// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the .agv recorder: a MediaStreamTrack (the simulation canvas, or the
 * camera on explicit request) read frame by frame through MediaStreamTrackProcessor, encoded with a
 * WebCodecs VideoEncoder (hardware first, then AV1 → H.264 → VP9 in software), each chunk multiplexed
 * with that frame's real telemetry into the product's own container (agv.ts) and written to a sink the
 * host picked — a local file or an in-memory buffer for a download. Nothing here reaches a network.
 * The pipeline never throws into the frame loop: every failure ends the recording cleanly and keeps
 * what was captured.
 * What breaks if it is removed? The console's `record` command and the HUD's REC chip have no recorder.
 */
import { emptyTelemetry, encodeHeader, encodePacket, toBase64, type AgentTelemetry, type AgvHeader } from './agv.ts'
import type { RecordingState, SipocSnapshot } from './telemetry.ts'
import type { RecorderGlobals, TrackProcessor, VideoEncoderLike, VideoFrameReader } from '../04_Connect_Hardware/web-hardware.d.ts'

export type RecorderSource = 'canvas' | 'camera'

/**
 * Where the bytes go. `seek` lets the header be rewritten at stop with the frame count and duration
 * (FileSystemWritableFileStream has it; so does MemorySink). `abort` discards a file nothing was written
 * to (the recorder failed before its first frame); without it, `close` is used.
 */
export interface RecorderSink {
  write(bytes: Uint8Array): Promise<void> | void
  seek?(position: number): Promise<void> | void
  close(): Promise<void> | void
  abort?(): Promise<void> | void
}

export interface RecorderOptions {
  width?: number
  height?: number
  framerate?: number
  bitrate?: number
  /** Every n-th frame sent to the encoder is a keyframe (by counter: timestamps are microseconds). */
  keyframeInterval?: number
  /** A frame arriving while more than this many are queued in the encoder is dropped (and counted). */
  maxQueue?: number
}

/** What the recorder needs from the page; defaults to globalThis. Tests pass fakes. */
export interface RecorderEnv {
  readonly VideoEncoder?: RecorderGlobals['VideoEncoder']
  readonly MediaStreamTrackProcessor?: RecorderGlobals['MediaStreamTrackProcessor']
  now?(): number
}

export const RECORDER_DEFAULTS = {
  width: 1280, height: 720, framerate: 30, bitrate: 2_000_000, keyframeInterval: 60, maxQueue: 5,
} as const

/** Telemetry remembered for a frame the encoder has not returned yet is dropped after this long. */
export const TELEMETRY_HOLD_US = 2_000_000
/** Spare bytes in the header JSON so it can be rewritten in place with `frames` and `durationUs`. */
const HEADER_SLACK = 64

/**
 * The codecs, in preference order. H.264 is level 3.1 (`…1F`): level 3.0 (`…1E`, the usual example
 * string) does not cover 1280×720 at 30 fps and Chromium rejects it at that size. Annex B keeps the
 * parameter sets inside the keyframes, so the file needs no out-of-band description.
 */
export const CODECS: readonly Pick<VideoEncoderConfig, 'codec' | 'avc'>[] = [
  { codec: 'av01.0.04M.08' },
  { codec: 'avc1.42E01F', avc: { format: 'annexb' } },
  { codec: 'vp09.00.10.08' },
]

/**
 * Chooses the encoder configuration by asking `isSupported` (VideoEncoder.isConfigSupported) in order:
 * every codec with a hardware encoder first — for a live capture, any hardware codec beats software
 * AV1 competing with the simulation for the CPU — then the same list with no preference. A probe that
 * throws counts as unsupported. Throws when nothing is supported.
 */
export async function pickCodec(
  isSupported: (c: VideoEncoderConfig) => Promise<{ supported?: boolean }>, w: number, h: number, bitrate: number, framerate: number,
): Promise<VideoEncoderConfig> {
  const tried: string[] = []
  for (const hardwareAcceleration of ['prefer-hardware', 'no-preference'] as const) {
    for (const c of CODECS) {
      const config: VideoEncoderConfig = { ...c, width: w, height: h, bitrate, framerate, hardwareAcceleration, latencyMode: 'realtime' }
      let ok = false
      try {
        ok = (await isSupported(config)).supported === true
      } catch {
        ok = false
      }
      if (ok) return config
      tried.push(`${c.codec} (${hardwareAcceleration})`)
    }
  }
  throw new Error(`no supported video encoder: tried ${tried.join(', ')}`)
}

/** Events since the previous frame, as counts or the new value. Anything missing or zero did not happen. */
export interface FrameEvents { law1?: number; flips?: number; tier?: string; panic?: string | null }

/** One markdown line naming only what really happened this frame; '' when nothing did. */
export function markdownFor(e: FrameEvents): string {
  const parts: string[] = []
  if (e.law1 && e.law1 > 0) parts.push(`**First Law** held back ${e.law1 === 1 ? 'a vehicle' : `${e.law1} vehicles`} for a person`)
  if (e.flips && e.flips > 0) parts.push(`**Sanctuary** shielded ${e.flips === 1 ? 'a person' : `${e.flips} people`} (Solid to Sensor)`)
  if (e.tier) parts.push(`**Quality** tier is now ${e.tier}`)
  if (e.panic) parts.push(`**Kernel panic** ${e.panic}`)
  return parts.join(' · ')
}

/**
 * Builds each frame's telemetry from the HUD snapshot: direct state only (confidence 1), the eye
 * position as the coordinates, the Concierge's brief root (or the current mode) as the intent, and a
 * markdown line from the counters that moved since the previous frame.
 */
export class SnapshotTelemetry {
  private prev: { law1: number; flips: number; tier: string; panic: string | null } | null = null

  next(s: SipocSnapshot, eye: { x: number; y: number; z: number }, briefRoot: string | null): AgentTelemetry {
    const k = s.kernel, c = s.customer, a = k.audit
    const cur = { law1: k.law1, flips: k.sensorFlips, tier: s.quality.label, panic: a.panic }
    const p = this.prev
    const events: FrameEvents = p
      ? { law1: cur.law1 - p.law1, flips: cur.flips - p.flips, tier: cur.tier !== p.tier ? cur.tier : undefined, panic: cur.panic && cur.panic !== p.panic ? cur.panic : null }
      : {}
    this.prev = cur
    const district = c.district.split(' · ')[0]
    const mode = s.input.mode === 'vehicle' ? `Driving through the ${district}` : `Walking the ${district}`
    return {
      intent: briefRoot || mode,
      markdown_log: markdownFor(events),
      confidence: 1,
      spatial_coordinates: [eye.x, eye.y, eye.z],
      state: {
        clock: c.clock, tier: s.quality.label, tierIndex: s.quality.tier, mode: s.input.mode, district: c.district,
        x: c.x, z: c.z, heading: c.heading, speedKmh: c.speedKmh, fps: Math.round(s.output.fps),
        kernel: { law1: k.law1, law2: k.law2, law3: k.law3, sensorFlips: k.sensorFlips, shielded: k.shielded, last: k.last },
        audit: { ticks: a.ticks, perimeterBreaches: a.perimeterBreaches, velocityCaps: a.velocityCaps, closest: Number.isFinite(a.closest) ? a.closest : null, panic: a.panic },
        brief: briefRoot,
      },
    }
  }
}

/** Everything one recording holds; dropped as a whole when it ends. */
interface Run {
  readonly encoder: VideoEncoderLike
  readonly reader: VideoFrameReader
  readonly track: MediaStreamTrack
  readonly sink: RecorderSink
  readonly keyframeInterval: number
  readonly maxQueue: number
  readonly startedMs: number
  header: AgvHeader
  /** Byte length of the header as written (0 until the first chunk); the JSON is padded to `headerReserve`. */
  headerBytes: number
  headerReserve: number
  /** Telemetry captured at encode time, keyed by frame timestamp, until the chunk comes back. */
  readonly pending: Map<number, AgentTelemetry>
  latest: AgentTelemetry | null
  sent: number
  firstTs: number | null
  lastTs: number
  lastDuration: number
  /** Serialized sink writes; never rejects (a failure is recorded in `error`). */
  writes: Promise<void>
  pumping: Promise<void>
  stopping: boolean
  stopPromise: Promise<RecordingState> | null
  error: string | null
  /** Set once a write failed: nothing more goes to the sink. */
  broken: boolean
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const settle = (v: Promise<void> | void): Promise<void> => Promise.resolve(v)

export class Recorder {
  /** Mutated in place: the host's snapshot reads it every tick. */
  readonly state: RecordingState = { active: false, source: null, seconds: 0, frames: 0, bytes: 0, dropped: 0, codec: '' }
  /** Called once when a recording ends, however it ended (`error` is null after a clean stop). */
  onEnd: ((state: RecordingState, error: string | null) => void) | null = null
  private readonly telemetry: () => AgentTelemetry
  private readonly env: RecorderEnv
  private run: Run | null = null
  private generation = 0
  private lastError: string | null = null

  constructor(telemetry: () => AgentTelemetry, env: RecorderEnv = globalThis as RecorderEnv) {
    this.telemetry = telemetry
    this.env = env
  }

  static supported(env: RecorderEnv = globalThis as RecorderEnv): { ok: boolean; reason: string } {
    const ve = env.VideoEncoder
    if (typeof ve !== 'function' || typeof ve.isConfigSupported !== 'function') return { ok: false, reason: 'WebCodecs VideoEncoder is not available in this browser' }
    if (typeof env.MediaStreamTrackProcessor !== 'function') return { ok: false, reason: 'MediaStreamTrackProcessor is not available in this browser' }
    return { ok: true, reason: '' }
  }

  /** Why the last recording ended early, or null. Cleared by the next start(). */
  get error(): string | null {
    return this.lastError
  }

  /**
   * Chooses the codec (see pickCodec) and starts reading the track. Resolves with the codec string once
   * the encoder is configured; rejects, having stopped the track and aborted the sink, if no codec is
   * supported or the pipeline cannot be built. The header is written with the first encoded chunk,
   * when the encoder reports its decoder configuration.
   */
  async start(track: MediaStreamTrack, source: RecorderSource, sink: RecorderSink, opts: RecorderOptions = {}): Promise<string> {
    if (this.run) throw new Error('already recording')
    const gen = ++this.generation
    const o = { ...RECORDER_DEFAULTS, ...opts }
    const abandon = async (why: string): Promise<never> => {
      try { track.stop() } catch { /* already ended */ }
      try { await settle(sink.abort ? sink.abort() : sink.close()) } catch { /* nothing was written */ }
      throw new Error(why)
    }
    const support = Recorder.supported(this.env)
    if (!support.ok) return abandon(support.reason)
    const VideoEncoderCtor = this.env.VideoEncoder!, Processor = this.env.MediaStreamTrackProcessor!
    let config: VideoEncoderConfig
    try {
      config = await pickCodec((c) => VideoEncoderCtor.isConfigSupported(c), o.width, o.height, o.bitrate, o.framerate)
    } catch (e) {
      return abandon(message(e))
    }
    // stop() or another start() came in while the codec probe was pending.
    if (gen !== this.generation || this.run) return abandon('recording cancelled before it started')

    const run: Run = {
      encoder: null as unknown as VideoEncoderLike, reader: null as unknown as VideoFrameReader, track, sink,
      keyframeInterval: Math.max(1, Math.floor(o.keyframeInterval)), maxQueue: Math.max(0, o.maxQueue), startedMs: this.now(),
      header: { version: 1, codec: config.codec, width: o.width, height: o.height, framerate: o.framerate, source, startedAt: new Date().toISOString() },
      headerBytes: 0, headerReserve: 0, pending: new Map(), latest: null, sent: 0, firstTs: null, lastTs: 0, lastDuration: 0,
      writes: Promise.resolve(), pumping: Promise.resolve(), stopping: false, stopPromise: null, error: null, broken: false,
    }
    let encoder: VideoEncoderLike | null = null
    let processor: TrackProcessor
    try {
      encoder = new VideoEncoderCtor({ output: (chunk, meta) => this.onChunk(run, chunk, meta), error: (e) => this.fail(run, e) })
      encoder.configure(config)
      processor = new Processor({ track })
    } catch (e) {
      try { encoder?.close() } catch { /* never configured */ }
      return abandon(message(e))
    }
    Object.assign(run, { encoder, reader: processor.readable.getReader() })
    this.run = run
    this.lastError = null
    const st = this.state
    st.active = true; st.source = source; st.seconds = 0; st.frames = 0; st.bytes = 0; st.dropped = 0; st.codec = config.codec
    run.pumping = this.pump(run)
    return config.codec
  }

  /**
   * Cancels the reader, flushes and closes the encoder, stops the track (the camera goes off), rewrites
   * the header with the frame count when the sink can seek, closes the sink, and resolves with the final
   * state. A second call while stopping returns the same promise; with nothing running it returns the
   * state as is. Rejects after the cleanup when the recording had failed before or during it.
   */
  stop(): Promise<RecordingState> {
    const run = this.run
    if (!run) {
      this.generation++ // cancels a start() still probing codecs
      return Promise.resolve(this.state)
    }
    run.stopPromise ??= this.teardown(run)
    return run.stopPromise
  }

  private now(): number {
    return this.env.now ? this.env.now() : typeof performance !== 'undefined' ? performance.now() : Date.now()
  }

  private async pump(run: Run): Promise<void> {
    const { reader, encoder } = run
    for (;;) {
      let result: Awaited<ReturnType<VideoFrameReader['read']>>
      try {
        result = await reader.read()
      } catch {
        break // cancelled
      }
      if (result.done) break
      const frame = result.value
      if (!frame) continue
      try {
        if (run.stopping || run.error || encoder.state !== 'configured') continue
        if (encoder.encodeQueueSize > run.maxQueue) {
          this.state.dropped++
          continue
        }
        this.remember(run, frame.timestamp)
        encoder.encode(frame, { keyFrame: run.sent % run.keyframeInterval === 0 })
        run.sent++
        this.state.seconds = (this.now() - run.startedMs) / 1000
      } catch (e) {
        this.fail(run, e)
      } finally {
        frame.close()
      }
    }
    // The track ended on its own (camera unplugged, canvas gone): finish the file.
    if (!run.stopping) void this.stop().catch(() => {})
  }

  private remember(run: Run, timestamp: number): void {
    let t: AgentTelemetry
    try {
      t = this.telemetry()
    } catch {
      t = emptyTelemetry()
    }
    run.pending.set(timestamp, t)
    run.latest = t
    const floor = timestamp - TELEMETRY_HOLD_US
    for (const k of run.pending.keys()) if (k < floor) run.pending.delete(k)
  }

  private onChunk(run: Run, chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void {
    if (run.broken) return
    try {
      const telemetry = run.pending.get(chunk.timestamp) ?? run.latest ?? emptyTelemetry()
      run.pending.delete(chunk.timestamp)
      if (!run.headerBytes) {
        const dc = meta?.decoderConfig
        if (dc) {
          const description = dc.description ? toBase64(bytesOf(dc.description)) : undefined
          run.header = { ...run.header, decoderConfig: { codec: dc.codec, codedWidth: dc.codedWidth ?? run.header.width, codedHeight: dc.codedHeight ?? run.header.height, ...(description ? { descriptionBase64: description } : {}) } }
        }
        run.headerReserve = encodeHeader(run.header).byteLength - 8 + HEADER_SLACK
        const bytes = encodeHeader(run.header, run.headerReserve)
        run.headerBytes = bytes.byteLength
        this.enqueue(run, bytes)
      }
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      const duration = chunk.duration ?? 0
      const packet = encodePacket({ telemetry, type: chunk.type, timestamp: chunk.timestamp, duration, data })
      run.firstTs ??= chunk.timestamp
      run.lastTs = chunk.timestamp
      run.lastDuration = duration
      this.state.frames++
      this.enqueue(run, packet)
    } catch (e) {
      this.fail(run, e)
    }
  }

  private enqueue(run: Run, bytes: Uint8Array): void {
    run.writes = run.writes.then(async () => {
      if (run.broken) return
      try {
        await settle(run.sink.write(bytes))
        this.state.bytes += bytes.byteLength
      } catch (e) {
        run.broken = true
        this.fail(run, e)
      }
    })
  }

  /** First failure wins; the recording is then ended, keeping what was written. */
  private fail(run: Run, e: unknown): void {
    if (run.error) return
    run.error = message(e)
    this.lastError = run.error
    void this.stop().catch(() => {})
  }

  private async teardown(run: Run): Promise<RecordingState> {
    run.stopping = true
    try { await run.reader.cancel() } catch { /* already released */ }
    await run.pumping
    const enc = run.encoder
    if (!run.error && enc.state === 'configured') {
      try { await enc.flush() } catch (e) { run.error ??= message(e) }
    }
    if (enc.state !== 'closed') {
      try { enc.close() } catch { /* already closed */ }
    }
    try { run.track.stop() } catch { /* already ended */ }
    await run.writes
    this.state.seconds = (this.now() - run.startedMs) / 1000
    if (run.headerBytes && run.sink.seek && !run.broken) {
      const durationUs = run.firstTs === null ? 0 : run.lastTs - run.firstTs + run.lastDuration
      const final = encodeHeader({ ...run.header, frames: this.state.frames, durationUs }, run.headerReserve)
      // Same length as the header on disk, or the rewrite would spill into the first packet.
      if (final.byteLength === run.headerBytes) {
        try {
          await settle(run.sink.seek(0))
          await settle(run.sink.write(final))
        } catch (e) {
          run.error ??= message(e)
        }
      }
    }
    // Nothing encoded (no header on disk): the untouched file is discarded rather than left empty.
    try {
      await settle(run.headerBytes || !run.sink.abort ? run.sink.close() : run.sink.abort())
    } catch (e) {
      run.error ??= message(e)
    }
    this.run = null
    this.state.active = false
    this.lastError = run.error
    this.onEnd?.(this.state, run.error)
    if (run.error) throw new Error(run.error)
    return this.state
  }
}

function bytesOf(b: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b)
}

/**
 * The download fallback's sink: the whole recording stays in memory (seekable, so the header is
 * finalized like a file's) and is handed over as a Blob at close. `abort` drops it silently.
 */
export class MemorySink implements RecorderSink {
  private parts: Uint8Array<ArrayBuffer>[] = []
  private size = 0
  /** Byte position of the next write; null appends. */
  private cursor: number | null = null
  private readonly onClose: (blob: Blob, bytes: number) => void

  constructor(onClose: (blob: Blob, bytes: number) => void) {
    this.onClose = onClose
  }

  get bytes(): number {
    return this.size
  }

  write(bytes: Uint8Array): void {
    const src = bytes as Uint8Array<ArrayBuffer>
    if (this.cursor === null || this.cursor >= this.size) {
      this.parts.push(src)
      this.size += src.byteLength
      this.cursor = null
      return
    }
    // Overwrite in place across the parts; anything past the end appends.
    let pos = this.cursor, from = 0
    let at = 0
    for (const part of this.parts) {
      if (from >= src.byteLength) break
      const end = at + part.byteLength
      if (pos < end) {
        const n = Math.min(end - pos, src.byteLength - from)
        part.set(src.subarray(from, from + n), pos - at)
        from += n
        pos += n
      }
      at = end
    }
    if (from < src.byteLength) {
      const rest = src.slice(from)
      this.parts.push(rest)
      this.size += rest.byteLength
      pos = this.size
    }
    this.cursor = pos >= this.size ? null : pos
  }

  seek(position: number): void {
    this.cursor = Math.max(0, Math.min(position, this.size))
  }

  close(): void {
    this.onClose(new Blob(this.parts, { type: 'application/octet-stream' }), this.size)
  }

  abort(): void {
    this.parts = []
    this.size = 0
  }

  /** The bytes so far, joined (tests and the reader). */
  snapshot(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.size)
    let o = 0
    for (const p of this.parts) {
      out.set(p, o)
      o += p.byteLength
    }
    return out
  }
}

/** A FileSystemWritableFileStream (showSaveFilePicker → createWritable) as a seekable sink. */
export function fileSink(w: FileSystemWritableFileStream): RecorderSink {
  return {
    write: (bytes) => w.write(bytes as Uint8Array<ArrayBuffer>),
    seek: (position) => w.seek(position),
    close: () => w.close(),
    abort: () => w.abort(),
  }
}
