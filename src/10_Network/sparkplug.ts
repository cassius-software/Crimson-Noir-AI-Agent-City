// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is Sparkplug B (the Eclipse Sparkplug 3.0 specification over MQTT) as the robot
 * relay speaks it: the topic namespace (`spBv1.0/<group>/<TYPE>/<node>[/<device>]` and the host's own
 * `spBv1.0/STATE/<host>`), the nine message types and which carry a device id, the Google Protocol Buffers payload
 * written by hand (the Payload and Metric messages of Eclipse Tahu's sparkplug_b.proto, the scalar values and the
 * byte arrays; data sets, templates, metadata and property sets are skipped by wire type and never written), the
 * data types by number, the STATE certificates as JSON, the bdSeq and seq counters that wrap at 255, and the joint
 * bridge's own convention on top: a device is a robot when its DBIRTH carries a `Joints/Manifest` string and a
 * `Joints/<joint>/q`, `/qd` and `/tau` double per movable joint; its DDATA carries the changed ones (by alias when
 * the birth gave aliases, as the specification demands) and the relay folds them into the last frame; a robot that
 * declares `Joints/Seq`, `Joints/IssuedAt` and `Joints/TtlMs` accepts targets by DCMD, and one that declares
 * `Joints/Arm`, `Joints/Armed` and `Joints/Beat` can be armed and watched through the peripheral gate; `Joints/Caps`
 * carries the CAPS body the gate judges, `Joints/Ack` the seq of the last targets applied, and a null metric reads as
 * NaN so the frame is refused and the twin holds. Pure.
 * What breaks if it is removed? The relay cannot read a broker's robots or write their targets, and nothing proves
 * the bytes against the specification's own numbers.
 */
import { checkTargets, readManifest, type Checked, type JointFrame, type JointTargets, type Manifest } from '../04_Connect_Hardware/jointState.ts'

export const SPARKPLUG = Object.freeze({
  namespace: 'spBv1.0',
  state: 'STATE',
  /** Edge Node and Device message types; `STATE` is the host's and lives beside them. */
  types: Object.freeze(['NBIRTH', 'NDEATH', 'DBIRTH', 'DDEATH', 'NDATA', 'DDATA', 'NCMD', 'DCMD'] as const),
  deviceTypes: Object.freeze(['DBIRTH', 'DDEATH', 'DDATA', 'DCMD'] as const),
  /** The metric every NBIRTH carries, so a host can ask for the births again. */
  rebirth: 'Node Control/Rebirth',
  bdSeq: 'bdSeq',
} as const)
export type MessageType = (typeof SPARKPLUG.types)[number]

/** A topic element: UTF-8 without the reserved `+`, `/` and `#` (and no control characters). */
export function validElement(s: unknown): s is string {
  if (typeof s !== 'string' || s.length === 0) return false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 || c === 0x7f || c === 0x2b /* + */ || c === 0x2f /* / */ || c === 0x23 /* # */) return false
  }
  return true
}

export type Topic =
  | { kind: 'node'; group: string; type: Exclude<MessageType, 'DBIRTH' | 'DDEATH' | 'DDATA' | 'DCMD'>; node: string }
  | { kind: 'device'; group: string; type: 'DBIRTH' | 'DDEATH' | 'DDATA' | 'DCMD'; node: string; device: string }
  | { kind: 'state'; host: string }

/** The topic of an Edge Node or Device message. Throws RangeError on a reserved character or a type that needs or forbids a device. */
export function topic(group: string, type: MessageType, node: string, device?: string): string {
  for (const e of [group, node, device]) if (e !== undefined && !validElement(e)) throw new RangeError(`'${e}' is not a Sparkplug topic element`)
  const needsDevice = (SPARKPLUG.deviceTypes as readonly string[]).includes(type)
  if (needsDevice && device === undefined) throw new RangeError(`${type} needs a device id`)
  if (!needsDevice && device !== undefined) throw new RangeError(`${type} carries no device id`)
  return device === undefined ? `${SPARKPLUG.namespace}/${group}/${type}/${node}` : `${SPARKPLUG.namespace}/${group}/${type}/${node}/${device}`
}

/** The host application's STATE topic. */
export function stateTopic(host: string): string {
  if (!validElement(host)) throw new RangeError(`'${host}' is not a Sparkplug host id`)
  return `${SPARKPLUG.namespace}/${SPARKPLUG.state}/${host}`
}

/** A topic read; null for one that is not Sparkplug B's or is malformed. */
export function parseTopic(t: string): Topic | null {
  const p = t.split('/')
  if (p[0] !== SPARKPLUG.namespace) return null
  if (p[1] === SPARKPLUG.state) return p.length === 3 && validElement(p[2]) ? { kind: 'state', host: p[2] } : null
  if (p.length !== 4 && p.length !== 5) return null
  const [, group, type, node, device] = p
  if (!validElement(group) || !validElement(node) || !(SPARKPLUG.types as readonly string[]).includes(type)) return null
  const needsDevice = (SPARKPLUG.deviceTypes as readonly string[]).includes(type)
  if (needsDevice) return device !== undefined && validElement(device) ? { kind: 'device', group, type: type as 'DBIRTH', node, device } : null
  return device === undefined ? { kind: 'node', group, type: type as 'NBIRTH', node } : null
}

/** sparkplug_b.proto DataType. */
export const DATA_TYPE = Object.freeze({
  Unknown: 0, Int8: 1, Int16: 2, Int32: 3, Int64: 4, UInt8: 5, UInt16: 6, UInt32: 7, UInt64: 8, Float: 9, Double: 10, Boolean: 11,
  String: 12, DateTime: 13, Text: 14, UUID: 15, DataSet: 16, Bytes: 17, File: 18, Template: 19, PropertySet: 20, PropertySetList: 21,
  Int8Array: 22, Int16Array: 23, Int32Array: 24, Int64Array: 25, UInt8Array: 26, UInt16Array: 27, UInt32Array: 28, UInt64Array: 29,
  FloatArray: 30, DoubleArray: 31, BooleanArray: 32, StringArray: 33, DateTimeArray: 34,
} as const)
export type DataTypeName = keyof typeof DATA_TYPE

export type MetricValue =
  | { kind: 'int'; value: number }
  | { kind: 'long'; value: bigint }
  | { kind: 'float'; value: number }
  | { kind: 'double'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'string'; value: string }
  | { kind: 'bytes'; value: Uint8Array }

export interface Metric {
  name?: string
  alias?: number
  /** ms since the epoch. */
  timestamp?: number
  datatype?: number
  isHistorical?: boolean
  isTransient?: boolean
  isNull?: boolean
  value?: MetricValue
}

export interface Payload {
  timestamp?: number
  metrics: Metric[]
  seq?: number
  uuid?: string
  body?: Uint8Array
}

// Protocol Buffers: varints, tags and the four wire types the two messages use.
const WT = Object.freeze({ varint: 0, i64: 1, len: 2, i32: 5 } as const)
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

function varint(n: number | bigint): number[] {
  let x = typeof n === 'bigint' ? n : BigInt(Math.trunc(n))
  if (x < 0n) x += 1n << 64n
  if (x < 0n || x >= 1n << 64n) throw new RangeError('varint out of range')
  const out: number[] = []
  do {
    let b = Number(x & 0x7fn)
    x >>= 7n
    if (x > 0n) b |= 0x80
    out.push(b)
  } while (x > 0n)
  return out
}
const tag = (field: number, wt: number): number[] => varint((field << 3) | wt)
const lenField = (field: number, bytes: Uint8Array): number[] => [...tag(field, WT.len), ...varint(bytes.length), ...bytes]
const utf8enc = new TextEncoder()
const utf8dec = new TextDecoder('utf-8', { fatal: true })

class Reader {
  at = 0
  readonly buf: Uint8Array
  constructor(buf: Uint8Array) { this.buf = buf }
  get left(): number { return this.buf.length - this.at }
  varint(): bigint {
    let x = 0n, shift = 0n
    for (;;) {
      if (this.at >= this.buf.length) throw new Error('protobuf: truncated varint')
      const b = this.buf[this.at++]
      x |= BigInt(b & 0x7f) << shift
      if ((b & 0x80) === 0) return x
      shift += 7n
      if (shift > 63n) throw new Error('protobuf: varint over ten bytes')
    }
  }
  bytes(n: number): Uint8Array {
    if (this.at + n > this.buf.length) throw new Error('protobuf: truncated field')
    const b = this.buf.subarray(this.at, this.at + n)
    this.at += n
    return b
  }
  len(): Uint8Array {
    const n = this.varint()
    if (n > BigInt(this.left)) throw new Error('protobuf: length past the end')
    return this.bytes(Number(n))
  }
  skip(wt: number): void {
    if (wt === WT.varint) this.varint()
    else if (wt === WT.i64) this.bytes(8)
    else if (wt === WT.len) this.len()
    else if (wt === WT.i32) this.bytes(4)
    else throw new Error(`protobuf: wire type ${wt} is not read here`)
  }
}

const toNumber = (b: bigint, what: string): number => {
  if (b > MAX_SAFE) throw new Error(`${what} above 2^53 is not represented`)
  return Number(b)
}
const f32 = (v: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return b }
const f64 = (v: number): Uint8Array => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return b }
const readF32 = (b: Uint8Array): number => new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true)
const readF64 = (b: Uint8Array): number => new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true)
const u32 = (n: number, what: string): number => {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError(`${what} ${n} is not a uint32`)
  return n
}

export function encodeMetric(m: Metric): Uint8Array {
  const out: number[] = []
  if (m.name !== undefined) out.push(...lenField(1, utf8enc.encode(m.name)))
  if (m.alias !== undefined) out.push(...tag(2, WT.varint), ...varint(m.alias))
  if (m.timestamp !== undefined) out.push(...tag(3, WT.varint), ...varint(m.timestamp))
  if (m.datatype !== undefined) out.push(...tag(4, WT.varint), ...varint(u32(m.datatype, 'datatype')))
  if (m.isHistorical !== undefined) out.push(...tag(5, WT.varint), m.isHistorical ? 1 : 0)
  if (m.isTransient !== undefined) out.push(...tag(6, WT.varint), m.isTransient ? 1 : 0)
  if (m.isNull !== undefined) out.push(...tag(7, WT.varint), m.isNull ? 1 : 0)
  const v = m.value
  if (v) {
    switch (v.kind) {
      case 'int': out.push(...tag(10, WT.varint), ...varint(u32(v.value, 'int_value'))); break
      case 'long': out.push(...tag(11, WT.varint), ...varint(v.value)); break
      case 'float': out.push(...tag(12, WT.i32), ...f32(v.value)); break
      case 'double': out.push(...tag(13, WT.i64), ...f64(v.value)); break
      case 'boolean': out.push(...tag(14, WT.varint), v.value ? 1 : 0); break
      case 'string': out.push(...lenField(15, utf8enc.encode(v.value))); break
      case 'bytes': out.push(...lenField(16, v.value)); break
    }
  }
  return new Uint8Array(out)
}

export function encodePayload(p: Payload): Uint8Array {
  const out: number[] = []
  if (p.timestamp !== undefined) out.push(...tag(1, WT.varint), ...varint(p.timestamp))
  for (const m of p.metrics) out.push(...lenField(2, encodeMetric(m)))
  if (p.seq !== undefined) out.push(...tag(3, WT.varint), ...varint(p.seq))
  if (p.uuid !== undefined) out.push(...lenField(4, utf8enc.encode(p.uuid)))
  if (p.body !== undefined) out.push(...lenField(5, p.body))
  return new Uint8Array(out)
}

export function decodeMetric(bytes: Uint8Array): Metric {
  const r = new Reader(bytes)
  const m: Metric = {}
  while (r.left > 0) {
    const key = r.varint()
    const field = Number(key >> 3n), wt = Number(key & 7n)
    switch (field) {
      case 1: m.name = utf8dec.decode(r.len()); break
      case 2: m.alias = toNumber(r.varint(), 'alias'); break
      case 3: m.timestamp = toNumber(r.varint(), 'metric timestamp'); break
      case 4: m.datatype = Number(r.varint() & 0xffffffffn); break
      case 5: m.isHistorical = r.varint() !== 0n; break
      case 6: m.isTransient = r.varint() !== 0n; break
      case 7: m.isNull = r.varint() !== 0n; break
      case 10: m.value = { kind: 'int', value: Number(r.varint() & 0xffffffffn) }; break
      case 11: m.value = { kind: 'long', value: r.varint() }; break
      case 12: m.value = { kind: 'float', value: readF32(r.bytes(4)) }; break
      case 13: m.value = { kind: 'double', value: readF64(r.bytes(8)) }; break
      case 14: m.value = { kind: 'boolean', value: r.varint() !== 0n }; break
      case 15: m.value = { kind: 'string', value: utf8dec.decode(r.len()) }; break
      case 16: m.value = { kind: 'bytes', value: new Uint8Array(r.len()) }; break
      default: r.skip(wt) // metadata (8), properties (9), data sets (17), templates (18), extensions (19)
    }
  }
  return m
}

export function decodePayload(bytes: Uint8Array): Payload {
  const r = new Reader(bytes)
  const p: Payload = { metrics: [] }
  while (r.left > 0) {
    const key = r.varint()
    const field = Number(key >> 3n), wt = Number(key & 7n)
    switch (field) {
      case 1: p.timestamp = toNumber(r.varint(), 'payload timestamp'); break
      case 2: p.metrics.push(decodeMetric(r.len())); break
      case 3: p.seq = toNumber(r.varint(), 'seq'); break
      case 4: p.uuid = utf8dec.decode(r.len()); break
      case 5: p.body = new Uint8Array(r.len()); break
      default: r.skip(wt)
    }
  }
  return p
}

/** The value of a metric as a plain JavaScript value by its datatype; undefined for a null metric or a type not read here. */
export function metricValue(m: Metric): number | boolean | string | Uint8Array | number[] | undefined {
  if (m.isNull || !m.value) return undefined
  const v = m.value
  const asNumber = (): number | undefined => {
    switch (v.kind) {
      case 'int': return v.value
      case 'long': return Number(v.value)
      case 'float': case 'double': return v.value
      default: return undefined
    }
  }
  switch (m.datatype) {
    case DATA_TYPE.Int8: return v.kind === 'int' ? (v.value << 24) >> 24 : asNumber()
    case DATA_TYPE.Int16: return v.kind === 'int' ? (v.value << 16) >> 16 : asNumber()
    case DATA_TYPE.Int32: return v.kind === 'int' ? v.value | 0 : asNumber()
    case DATA_TYPE.Int64: return v.kind === 'long' ? Number(BigInt.asIntN(64, v.value)) : asNumber()
    case DATA_TYPE.UInt8: case DATA_TYPE.UInt16: case DATA_TYPE.UInt32: case DATA_TYPE.UInt64: case DATA_TYPE.DateTime:
    case DATA_TYPE.Float: case DATA_TYPE.Double:
      return asNumber()
    case DATA_TYPE.Boolean: return v.kind === 'boolean' ? v.value : undefined
    case DATA_TYPE.String: case DATA_TYPE.Text: case DATA_TYPE.UUID: return v.kind === 'string' ? v.value : undefined
    case DATA_TYPE.Bytes: case DATA_TYPE.File: return v.kind === 'bytes' ? v.value : undefined
    case DATA_TYPE.DoubleArray: {
      if (v.kind !== 'bytes' || v.value.length % 8 !== 0) return undefined
      const out: number[] = []
      const dv = new DataView(v.value.buffer, v.value.byteOffset, v.value.length)
      for (let i = 0; i < v.value.length; i += 8) out.push(dv.getFloat64(i, true))
      return out
    }
    default:
      // No datatype (a DATA message) or one not read here: the raw scalar, if it is one.
      if (v.kind === 'boolean') return v.value
      if (v.kind === 'string') return v.value
      if (v.kind === 'bytes') return v.value
      return asNumber()
  }
}

/** A metric with a name, a type, a value and a time (and an alias, for a birth). */
export function metric(name: string, type: DataTypeName, value: number | boolean | string | bigint, timestamp: number, alias?: number): Metric {
  const m: Metric = { name, datatype: DATA_TYPE[type], timestamp }
  if (alias !== undefined) m.alias = alias
  switch (type) {
    case 'Int8': case 'Int16': case 'Int32':
      m.value = { kind: 'int', value: Number(value) >>> 0 }
      break
    case 'UInt8': case 'UInt16': case 'UInt32':
      m.value = { kind: 'int', value: Number(value) }
      break
    case 'Int64': case 'UInt64': case 'DateTime':
      m.value = { kind: 'long', value: typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value))) }
      break
    case 'Float': m.value = { kind: 'float', value: Number(value) }; break
    case 'Double': m.value = { kind: 'double', value: Number(value) }; break
    case 'Boolean': m.value = { kind: 'boolean', value: Boolean(value) }; break
    case 'String': case 'Text': case 'UUID': m.value = { kind: 'string', value: String(value) }; break
    default: throw new RangeError(`metric(): ${type} is not built here`)
  }
  return m
}

/** The next bdSeq or seq: one more, and 0 after 255. */
export const nextSeq = (n: number): number => (n + 1) & 255

/** The host's STATE certificate (JSON, QoS 1, retained): online or not, and its timestamp. */
export function stateJson(online: boolean, timestamp: number): Uint8Array {
  return utf8enc.encode(JSON.stringify({ online, timestamp }))
}
export function parseState(bytes: Uint8Array): { online: boolean; timestamp: number } | null {
  try {
    const o = JSON.parse(utf8dec.decode(bytes)) as { online?: unknown; timestamp?: unknown }
    return typeof o.online === 'boolean' && typeof o.timestamp === 'number' && Number.isFinite(o.timestamp) ? { online: o.online, timestamp: o.timestamp } : null
  } catch {
    return null
  }
}

// The joint bridge's convention on Sparkplug B (docs/joint-bridge-spec.md).
export const JOINT_METRICS = Object.freeze({
  manifest: 'Joints/Manifest',
  /** `Joints/<joint>/<field>`. */
  prefix: 'Joints/',
  fields: Object.freeze(['q', 'qd', 'tau'] as const),
  /** Declared by a robot that accepts targets (DCMD); all three Int64. */
  seq: 'Joints/Seq',
  issuedAt: 'Joints/IssuedAt',
  ttlMs: 'Joints/TtlMs',
  /** Declared by a robot that can be armed: the host writes the nonce to Arm (String), the device echoes it in Armed (String) and counts Beat (Int64). */
  arm: 'Joints/Arm',
  armed: 'Joints/Armed',
  beat: 'Joints/Beat',
  /** The CAPS body (String; docs/hal-peripherals-spec.md §3), so the relay's gate judges a broker's robot like a serial one. */
  caps: 'Joints/Caps',
  /** The seq of the last targets the device applied (Int64), as a HAL/1 `JA` line says it. */
  ack: 'Joints/Ack',
} as const)
export type JointField = (typeof JOINT_METRICS.fields)[number]
/** Where a metric name lands: a joint field, or one of the gate's words. */
export type MetricField = JointField | 'seq' | 'issuedAt' | 'ttlMs' | 'arm' | 'armed' | 'beat' | 'caps' | 'ack'
const WORDS: readonly (readonly [string, Exclude<MetricField, JointField>])[] = Object.freeze([
  [JOINT_METRICS.seq, 'seq'], [JOINT_METRICS.issuedAt, 'issuedAt'], [JOINT_METRICS.ttlMs, 'ttlMs'], [JOINT_METRICS.arm, 'arm'],
  [JOINT_METRICS.armed, 'armed'], [JOINT_METRICS.beat, 'beat'], [JOINT_METRICS.caps, 'caps'], [JOINT_METRICS.ack, 'ack'],
] as const)

/** A robot as a DBIRTH described it: the manifest and where each joint field lives (by name, and by alias when given). */
export interface SparkplugRobot {
  readonly manifest: Manifest
  /** `${field}:${movable index}` by metric name. */
  readonly byName: ReadonlyMap<string, { field: MetricField; index: number }>
  /** The same by alias; empty when the birth gave no aliases. */
  readonly byAlias: ReadonlyMap<number, string>
  /** The alias of a metric name, when the birth gave one (DATA and CMD then carry aliases only). */
  readonly aliasOf: ReadonlyMap<string, number>
  readonly acceptsTargets: boolean
  readonly armable: boolean
  /** The CAPS body the birth carried in `Joints/Caps`, or null: a robot without one is a sensor to the gate. */
  readonly caps: string | null
}

/** Reads a DBIRTH's metrics as a robot; null when it carries no manifest (an ordinary Sparkplug device); a reason when the manifest is bad. */
export function robotFromBirth(metrics: readonly Metric[]): Checked<SparkplugRobot> | null {
  const man = metrics.find((m) => m.name === JOINT_METRICS.manifest)
  if (!man) return null
  const text = metricValue(man)
  if (typeof text !== 'string') return { ok: false, reason: `${JOINT_METRICS.manifest} is not a string metric` }
  const read = readManifest(text)
  if (!read.ok) return read
  const manifest = read.value
  const byName = new Map<string, { field: MetricField; index: number }>()
  const aliasOf = new Map<string, number>()
  const byAlias = new Map<number, string>()
  const names = new Set(metrics.map((m) => m.name))
  manifest.movable.forEach((ji, i) => {
    for (const f of JOINT_METRICS.fields) byName.set(`${JOINT_METRICS.prefix}${manifest.joints[ji].name}/${f}`, { field: f, index: i })
  })
  for (const [key, field] of WORDS) byName.set(key, { field, index: -1 })
  for (const m of metrics) {
    if (m.name === undefined || !byName.has(m.name)) continue
    if (m.alias !== undefined) {
      if (byAlias.has(m.alias)) return { ok: false, reason: `alias ${m.alias} is used twice in the birth` }
      byAlias.set(m.alias, m.name)
      aliasOf.set(m.name, m.alias)
    }
  }
  for (const ji of manifest.movable) {
    const q = `${JOINT_METRICS.prefix}${manifest.joints[ji].name}/q`
    if (!names.has(q)) return { ok: false, reason: `the birth declares no ${q}` }
  }
  const acceptsTargets = names.has(JOINT_METRICS.seq) && names.has(JOINT_METRICS.issuedAt) && names.has(JOINT_METRICS.ttlMs)
  const armable = acceptsTargets && names.has(JOINT_METRICS.arm) && names.has(JOINT_METRICS.armed) && names.has(JOINT_METRICS.beat)
  const capsMetric = metrics.find((m) => m.name === JOINT_METRICS.caps)
  const caps = capsMetric ? metricValue(capsMetric) : undefined
  return { ok: true, value: { manifest, byName, byAlias, aliasOf, acceptsTargets, armable, caps: typeof caps === 'string' ? caps : null } }
}

/** What a DDATA changed: the frame after it (report by exception: metrics it leaves out keep their last value) and the gate's words. */
export interface DataRead {
  frame: JointFrame
  /** `Joints/Armed`'s string, when the message carried it. */
  armed?: string
  /** `Joints/Beat`, when carried. */
  beat?: number
  /** `Joints/Ack`, when carried (the frame carries it too). */
  ack?: number
  /** Metrics by alias the birth never declared: a rebirth is due. */
  unknownAliases: number
}

/** Folds a DDATA (or a DBIRTH's own values) into `prev`; `seq` is the relay's own count for the frame. */
export function frameFromData(robot: SparkplugRobot, p: Payload, prev: JointFrame | null, seq: number, now: number): DataRead {
  const n = robot.manifest.movable.length
  const q = prev ? [...prev.q] : new Array<number>(n).fill(0)
  const qd = prev ? [...prev.qd] : new Array<number>(n).fill(0)
  const tau = prev ? [...prev.tau] : new Array<number>(n).fill(0)
  if (q.length !== n) q.length = n
  let armed: string | undefined, beat: number | undefined, ack: number | undefined
  let unknownAliases = 0
  let stamp = p.timestamp ?? now
  for (const m of p.metrics) {
    const name = m.name ?? (m.alias !== undefined ? robot.byAlias.get(m.alias) : undefined)
    if (name === undefined) {
      if (m.alias !== undefined) unknownAliases++
      continue
    }
    const where = robot.byName.get(name)
    if (!where) continue
    const v = metricValue(m)
    if (m.timestamp !== undefined && m.timestamp > stamp) stamp = m.timestamp
    // A null metric is a reading the device no longer has: it reads as NaN, which checkFrame refuses, which holds,
    // until the device reports that joint again.
    const num = (): number | undefined => (m.isNull ? Number.NaN : typeof v === 'number' ? v : undefined)
    switch (where.field) {
      case 'q': { const x = num(); if (x !== undefined) q[where.index] = x; break }
      case 'qd': { const x = num(); if (x !== undefined) qd[where.index] = x; break }
      case 'tau': { const x = num(); if (x !== undefined) tau[where.index] = x; break }
      case 'armed': if (typeof v === 'string') armed = v; break
      case 'beat': if (typeof v === 'number') beat = v; break
      case 'ack': if (typeof v === 'number') ack = v; break
      default: break
    }
  }
  const base = { stamp, seq, q: Object.freeze(q), qd: Object.freeze(qd), tau: Object.freeze(tau) }
  const frame: JointFrame = Object.freeze(ack === undefined ? base : { ...base, ack })
  const out: DataRead = { frame, unknownAliases }
  if (armed !== undefined) out.armed = armed
  if (beat !== undefined) out.beat = beat
  if (ack !== undefined) out.ack = ack
  return out
}

/** A metric named `name` as the robot's birth declared it: by alias alone when the birth gave one (the specification's rule for DATA and CMD). */
function named(robot: SparkplugRobot, name: string, type: DataTypeName, value: number | string | bigint, timestamp: number): Metric {
  const alias = robot.aliasOf.get(name)
  const m = metric(name, type, value, timestamp)
  delete m.datatype
  if (alias !== undefined) {
    delete m.name
    m.alias = alias
  }
  return m
}

/** The DBIRTH metrics of a robot: for a device that speaks the convention (the relay's fake and the simulated arm use it; a real device writes its own). */
export function birthMetrics(manifest: Manifest, frame: JointFrame | null, timestamp: number, o: { aliases?: boolean; targets?: boolean; armable?: boolean; caps?: string } = {}): Metric[] {
  let alias = 1
  const next = (): number | undefined => (o.aliases ? alias++ : undefined)
  const out: Metric[] = [metric(JOINT_METRICS.manifest, 'String', JSON.stringify({ robot: manifest.robot, links: manifest.links, joints: manifest.joints }), timestamp, next())]
  manifest.movable.forEach((ji, i) => {
    const name = manifest.joints[ji].name
    out.push(metric(`${JOINT_METRICS.prefix}${name}/q`, 'Double', frame?.q[i] ?? 0, timestamp, next()))
    out.push(metric(`${JOINT_METRICS.prefix}${name}/qd`, 'Double', frame?.qd[i] ?? 0, timestamp, next()))
    out.push(metric(`${JOINT_METRICS.prefix}${name}/tau`, 'Double', frame?.tau[i] ?? 0, timestamp, next()))
  })
  if (o.targets || o.armable) {
    out.push(metric(JOINT_METRICS.seq, 'Int64', 0, timestamp, next()), metric(JOINT_METRICS.issuedAt, 'Int64', 0, timestamp, next()), metric(JOINT_METRICS.ttlMs, 'Int64', 0, timestamp, next()))
  }
  if (o.armable) {
    out.push(metric(JOINT_METRICS.arm, 'String', '', timestamp, next()), metric(JOINT_METRICS.armed, 'String', '', timestamp, next()), metric(JOINT_METRICS.beat, 'Int64', 0, timestamp, next()))
  }
  // After the gate's words, so the aliases a birth without them gives stay as they were.
  if (o.targets || o.armable) out.push(metric(JOINT_METRICS.ack, 'Int64', frame?.ack ?? 0, timestamp, next()))
  if (o.caps !== undefined) out.push(metric(JOINT_METRICS.caps, 'String', o.caps, timestamp, next()))
  return out
}

/** A DDATA's metrics for a frame (every movable joint's three fields), as the robot's birth named or aliased them. */
export function dataMetrics(robot: SparkplugRobot, frame: JointFrame, extra: { armed?: string; beat?: number; ack?: number } = {}): Metric[] {
  const out: Metric[] = []
  const m = robot.manifest
  m.movable.forEach((ji, i) => {
    const name = m.joints[ji].name
    out.push(named(robot, `${JOINT_METRICS.prefix}${name}/q`, 'Double', frame.q[i] ?? 0, frame.stamp))
    if (frame.qd.length) out.push(named(robot, `${JOINT_METRICS.prefix}${name}/qd`, 'Double', frame.qd[i], frame.stamp))
    if (frame.tau.length) out.push(named(robot, `${JOINT_METRICS.prefix}${name}/tau`, 'Double', frame.tau[i], frame.stamp))
  })
  if (extra.armed !== undefined) out.push(named(robot, JOINT_METRICS.armed, 'String', extra.armed, frame.stamp))
  if (extra.beat !== undefined) out.push(named(robot, JOINT_METRICS.beat, 'Int64', extra.beat, frame.stamp))
  const ack = extra.ack ?? frame.ack
  if (ack !== undefined) out.push(named(robot, JOINT_METRICS.ack, 'Int64', ack, frame.stamp))
  return out
}

/** A DCMD's metrics for targets (positions, and speeds and efforts where given), plus the gate's three words; null for a robot that declared no command metrics. */
export function commandMetrics(robot: SparkplugRobot, t: JointTargets, now: number): Metric[] | null {
  if (!robot.acceptsTargets) return null
  const m = robot.manifest
  const out: Metric[] = [
    named(robot, JOINT_METRICS.seq, 'Int64', t.seq, now),
    named(robot, JOINT_METRICS.issuedAt, 'Int64', t.issuedAt, now),
    named(robot, JOINT_METRICS.ttlMs, 'Int64', t.ttlMs, now),
  ]
  m.movable.forEach((ji, i) => {
    const name = m.joints[ji].name
    out.push(named(robot, `${JOINT_METRICS.prefix}${name}/q`, 'Double', t.q[i], now))
    if (t.qd.length) out.push(named(robot, `${JOINT_METRICS.prefix}${name}/qd`, 'Double', t.qd[i], now))
    if (t.tau.length) out.push(named(robot, `${JOINT_METRICS.prefix}${name}/tau`, 'Double', t.tau[i], now))
  })
  return out
}

/** The DCMD that arms a robot: the nonce written to `Joints/Arm`; null for one that cannot be armed. */
export function armMetrics(robot: SparkplugRobot, nonce: string, now: number): Metric[] | null {
  return robot.armable ? [named(robot, JOINT_METRICS.arm, 'String', nonce, now)] : null
}

/** The DCMD that disarms a robot: `DISARM <cause>` written to `Joints/Arm` (the HAL/1 word, so one firmware rule serves both doors); null for one that cannot be armed. */
export function disarmMetrics(robot: SparkplugRobot, cause: string, now: number): Metric[] | null {
  return robot.armable ? [named(robot, JOINT_METRICS.arm, 'String', `DISARM ${cause}`, now)] : null
}

/** Targets as a device would read them back out of a DCMD (the simulated arm and the tests). */
export function targetsFromCommand(robot: SparkplugRobot, p: Payload): Checked<JointTargets> {
  const n = robot.manifest.movable.length
  const q = new Array<number | undefined>(n).fill(undefined), qd: number[] = [], tau: number[] = []
  let seq: number | undefined, issuedAt: number | undefined, ttlMs: number | undefined
  for (const m of p.metrics) {
    const name = m.name ?? (m.alias !== undefined ? robot.byAlias.get(m.alias) : undefined)
    const where = name === undefined ? undefined : robot.byName.get(name)
    if (!where) continue
    const v = metricValue(m)
    if (typeof v !== 'number') continue
    switch (where.field) {
      case 'q': q[where.index] = v; break
      case 'qd': qd[where.index] = v; break
      case 'tau': tau[where.index] = v; break
      case 'seq': seq = v; break
      case 'issuedAt': issuedAt = v; break
      case 'ttlMs': ttlMs = v; break
      default: break
    }
  }
  return checkTargets(n, { seq, issuedAt, ttlMs, q: q.every((v) => v !== undefined) ? q : [], qd: qd.length === n ? qd : [], tau: tau.length === n ? tau : [] })
}
