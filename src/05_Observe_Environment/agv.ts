/**
 * Why does this file exist? It is the product's own recording container, `.agv` version 1: a header
 * naming the codec and the decoder configuration, then one packet per encoded video frame carrying
 * that frame's telemetry JSON beside the chunk. Pure byte work — a multiplexer, a streaming demuxer
 * that tolerates any split point, and a one-shot reader — with no WebCodecs or DOM dependency, so the
 * format is testable in Node and a recording can be read back anywhere.
 * What breaks if it is removed? The recorder has nothing to write and no recording can be read.
 *
 * Layout (all integers little-endian):
 *   header: 'AGV1' · u32 jsonLen · json (AgvHeader; may carry trailing spaces so it can be rewritten
 *           in place with the frame count once the recording ends)
 *   packet: u32 telemetryLen · telemetry JSON (AgentTelemetry; 0 bytes = none) · u8 type (1 key, 0 delta)
 *           · u64 timestamp µs · u32 duration µs · u32 chunkLen · chunk bytes
 */

export interface AgvHeader {
  version: 1
  codec: string
  width: number
  height: number
  framerate: number
  source: 'canvas' | 'camera'
  /** ISO 8601 */
  startedAt: string
  frames?: number
  durationUs?: number
  /** The encoder's `decoderConfig` from its first chunk, so the file is decodable as it stands. */
  decoderConfig?: { codec: string; codedWidth: number; codedHeight: number; descriptionBase64?: string }
}

/** The telemetry envelope written beside every frame. `state` is the host's own record of the moment. */
export interface AgentTelemetry {
  intent: string
  markdown_log: string
  confidence: number
  spatial_coordinates: [number, number, number]
  state?: Record<string, unknown>
}

export interface AgvPacket {
  telemetry: AgentTelemetry
  type: 'key' | 'delta'
  /** Microseconds, as the encoder stamped the chunk (may exceed 2^32). */
  timestamp: number
  /** Microseconds; 0 when the encoder gave none. */
  duration: number
  data: Uint8Array
}

export const AGV_MAGIC = 'AGV1'
const MAGIC_BYTES = new Uint8Array([0x41, 0x47, 0x56, 0x31])
const PACKET_FIXED = 4 + 1 + 8 + 4 + 4
const MAX_U32 = 0xffffffff
const TIMESTAMP_MAX = Number.MAX_SAFE_INTEGER

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/** A packet with no telemetry reads as this (confidence 0: nothing was observed). */
export function emptyTelemetry(): AgentTelemetry {
  return { intent: '', markdown_log: '', confidence: 0, spatial_coordinates: [0, 0, 0] }
}

function checkU32(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0 || v > MAX_U32) throw new RangeError(`agv: ${name} must be a u32, got ${v}`)
}

/**
 * Magic, length prefix and the header JSON. `reserve` pads the JSON with trailing spaces up to that many
 * bytes (JSON.parse ignores them), so a recorder can rewrite the header in place at stop with the frame
 * count and duration added, as long as the sink can seek and the final JSON still fits.
 */
export function encodeHeader(h: AgvHeader, reserve = 0): Uint8Array {
  if (h.version !== 1) throw new RangeError(`agv: unsupported header version ${String(h.version)}`)
  const json = encoder.encode(JSON.stringify(h))
  const len = Math.max(json.byteLength, reserve)
  checkU32('header length', len)
  const out = new Uint8Array(8 + len)
  out.set(MAGIC_BYTES, 0)
  new DataView(out.buffer).setUint32(4, len, true)
  out.set(json, 8)
  out.fill(0x20, 8 + json.byteLength)
  return out
}

/** One buffer per packet: the chunk bytes are copied once (WebCodecs already copied them out of the encoder). */
export function encodePacket(p: AgvPacket): Uint8Array {
  const telemetry = encoder.encode(JSON.stringify(p.telemetry))
  checkU32('telemetry length', telemetry.byteLength)
  checkU32('chunk length', p.data.byteLength)
  checkU32('duration', p.duration)
  if (!Number.isInteger(p.timestamp) || p.timestamp < 0 || p.timestamp > TIMESTAMP_MAX) throw new RangeError(`agv: timestamp must be a non-negative safe integer, got ${p.timestamp}`)
  const out = new Uint8Array(PACKET_FIXED + telemetry.byteLength + p.data.byteLength)
  const view = new DataView(out.buffer)
  let o = 0
  view.setUint32(o, telemetry.byteLength, true); o += 4
  out.set(telemetry, o); o += telemetry.byteLength
  out[o++] = p.type === 'key' ? 1 : 0
  view.setBigUint64(o, BigInt(p.timestamp), true); o += 8
  view.setUint32(o, p.duration, true); o += 4
  view.setUint32(o, p.data.byteLength, true); o += 4
  out.set(p.data, o)
  return out
}

function parseJson(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes))
  } catch (e) {
    throw new Error(`agv: ${what} is not valid JSON (${e instanceof Error ? e.message : String(e)})`)
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asHeader(v: unknown): AgvHeader {
  if (!isRecord(v)) throw new Error('agv: header is not an object')
  if (v.version !== 1) throw new Error(`agv: unsupported version ${String(v.version)}`)
  if (typeof v.codec !== 'string' || typeof v.width !== 'number' || typeof v.height !== 'number') throw new Error('agv: header lacks codec or dimensions')
  return v as unknown as AgvHeader
}

function asTelemetry(v: unknown): AgentTelemetry {
  if (!isRecord(v)) throw new Error('agv: telemetry is not an object')
  const c = v.spatial_coordinates
  const coords: [number, number, number] = Array.isArray(c) && c.length === 3 && c.every((n) => typeof n === 'number')
    ? [c[0], c[1], c[2]]
    : [0, 0, 0]
  const t: AgentTelemetry = {
    intent: typeof v.intent === 'string' ? v.intent : '',
    markdown_log: typeof v.markdown_log === 'string' ? v.markdown_log : '',
    confidence: typeof v.confidence === 'number' ? v.confidence : 0,
    spatial_coordinates: coords,
  }
  if (isRecord(v.state)) t.state = v.state
  return t
}

/**
 * Streaming demuxer: push bytes as they arrive (any split point, even mid-integer), read `header`
 * once it is known and drain `packets()` as they complete. Malformed input throws from push().
 */
export class AgvReader {
  header: AgvHeader | null = null
  private buf = new Uint8Array(0)
  private ready: AgvPacket[] = []

  push(bytes: Uint8Array): void {
    if (bytes.byteLength) {
      const joined = new Uint8Array(this.buf.byteLength + bytes.byteLength)
      joined.set(this.buf, 0)
      joined.set(bytes, this.buf.byteLength)
      this.buf = joined
    }
    let o = 0
    if (!this.header) {
      if (this.buf.byteLength < 8) return
      for (let i = 0; i < 4; i++) if (this.buf[i] !== MAGIC_BYTES[i]) throw new Error('agv: not an AGV1 file')
      const len = new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(4, true)
      if (this.buf.byteLength < 8 + len) return
      this.header = asHeader(parseJson(this.buf.subarray(8, 8 + len), 'header'))
      o = 8 + len
    }
    const view = new DataView(this.buf.buffer, this.buf.byteOffset)
    for (;;) {
      if (this.buf.byteLength - o < 4) break
      const tLen = view.getUint32(o, true)
      if (this.buf.byteLength - o < PACKET_FIXED + tLen) break
      const cLenAt = o + 4 + tLen + 1 + 8 + 4
      const cLen = view.getUint32(cLenAt, true)
      const total = PACKET_FIXED + tLen + cLen
      if (this.buf.byteLength - o < total) break
      const telemetry = tLen ? asTelemetry(parseJson(this.buf.subarray(o + 4, o + 4 + tLen), 'telemetry')) : emptyTelemetry()
      let p = o + 4 + tLen
      const typeByte = this.buf[p++]
      if (typeByte > 1) throw new Error(`agv: bad packet type ${typeByte}`)
      const timestamp = Number(view.getBigUint64(p, true)); p += 8
      const duration = view.getUint32(p, true); p += 4
      p += 4
      this.ready.push({ telemetry, type: typeByte === 1 ? 'key' : 'delta', timestamp, duration, data: this.buf.slice(p, p + cLen) })
      o += total
    }
    if (o) this.buf = this.buf.slice(o)
  }

  /** Bytes pushed but not yet forming a whole packet. */
  get pending(): number {
    return this.buf.byteLength
  }

  /** The packets completed so far; each call returns only what arrived since the last. */
  packets(): AgvPacket[] {
    const out = this.ready
    this.ready = []
    return out
  }
}

/** Reads a whole recording. Throws if the header is missing or malformed; trailing partial bytes are ignored. */
export function readAgv(bytes: Uint8Array): { header: AgvHeader; packets: AgvPacket[] } {
  const r = new AgvReader()
  r.push(bytes)
  if (!r.header) throw new Error('agv: incomplete header')
  return { header: r.header, packets: r.packets() }
}

/** Standard base64 of raw bytes (the decoder `description`), without the DOM's btoa. */
export function toBase64(bytes: Uint8Array): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let s = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    s += A[n >> 18] + A[(n >> 12) & 63] + A[(n >> 6) & 63] + A[n & 63]
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8)
    s += A[n >> 18] + A[(n >> 12) & 63] + (i + 1 < bytes.length ? A[(n >> 6) & 63] : '=') + '='
  }
  return s
}

export function fromBase64(s: string): Uint8Array {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let acc = 0, bits = 0, n = 0
  for (const ch of clean) {
    acc = (acc << 6) | A.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[n++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, n)
}
