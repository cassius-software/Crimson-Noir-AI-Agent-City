// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the MQTT 3.1.1 wire format (OASIS mqtt-v3.1.1-os), as bytes in and packets out
 * and back: the fixed header with its control type, flags and Remaining Length (one to four bytes, seven bits each,
 * least significant first), the length-prefixed UTF-8 strings (no U+0000, at most 65,535 bytes), and the twelve
 * packets a Sparkplug host needs: CONNECT (with a Will, a user name and a password), CONNACK, PUBLISH at QoS 0 and 1,
 * PUBACK (and the QoS 2 acknowledgements read, so a broker that sends one does not break the stream), SUBSCRIBE,
 * SUBACK, UNSUBSCRIBE, UNSUBACK, PINGREQ, PINGRESP and DISCONNECT. It checks what the specification says a receiver
 * MUST check (reserved flags, a QoS of 3, a packet identifier where none belongs or none where one must be, a
 * malformed string) and stops at the first bad byte, so the caller closes the connection as the specification asks.
 * It is pure (no socket, no clock, no import) and the same on Node and the page, though only the robot relay
 * (robotRelay.node.ts) speaks it: the page's air gap keeps every broker off this machine behind that relay.
 * What breaks if it is removed? The relay has no way to reach a Sparkplug broker, and nothing proves the bytes.
 */

export const MQTT = Object.freeze({
  protocolName: 'MQTT',
  protocolLevel: 4,
  /** The Remaining Length field's largest value. */
  maxRemaining: 268_435_455,
  maxString: 65_535,
})

/** Control packet types (byte 1, bits 7 to 4). */
export const TYPE = Object.freeze({
  connect: 1, connack: 2, publish: 3, puback: 4, pubrec: 5, pubrel: 6, pubcomp: 7,
  subscribe: 8, suback: 9, unsubscribe: 10, unsuback: 11, pingreq: 12, pingresp: 13, disconnect: 14,
} as const)

export type QoS = 0 | 1 | 2

export interface Will { topic: string; payload: Uint8Array; qos: QoS; retain: boolean }

export type Packet =
  | { type: 'connect'; clientId: string; keepAlive: number; cleanSession: boolean; will?: Will; username?: string; password?: Uint8Array; protocolLevel: number }
  | { type: 'connack'; sessionPresent: boolean; code: number }
  | { type: 'publish'; topic: string; payload: Uint8Array; qos: QoS; retain: boolean; dup: boolean; packetId?: number }
  | { type: 'puback' | 'pubrec' | 'pubrel' | 'pubcomp' | 'unsuback'; packetId: number }
  | { type: 'subscribe'; packetId: number; topics: { filter: string; qos: QoS }[] }
  | { type: 'suback'; packetId: number; codes: number[] }
  | { type: 'unsubscribe'; packetId: number; topics: string[] }
  | { type: 'pingreq' | 'pingresp' | 'disconnect' }

/** CONNACK return codes (3.2.2.3). */
export const CONNACK = Object.freeze({ accepted: 0, protocol: 1, identifier: 2, unavailable: 3, credentials: 4, unauthorized: 5 } as const)
export const CONNACK_TEXT: readonly string[] = Object.freeze([
  'connection accepted', 'unacceptable protocol version', 'identifier rejected', 'server unavailable', 'bad user name or password', 'not authorized',
])
/** SUBACK's failure code. */
export const SUBACK_FAILURE = 0x80

const utf8enc = new TextEncoder()
const utf8dec = new TextDecoder('utf-8', { fatal: true })

export function encodeRemainingLength(n: number): number[] {
  if (!Number.isInteger(n) || n < 0 || n > MQTT.maxRemaining) throw new RangeError(`remaining length ${n} out of range`)
  const out: number[] = []
  let x = n
  do {
    let b = x % 128
    x = Math.floor(x / 128)
    if (x > 0) b |= 128
    out.push(b)
  } while (x > 0)
  return out
}

/** The Remaining Length at `at`; null while incomplete; a reason when malformed (more than four bytes). */
export function decodeRemainingLength(buf: Uint8Array, at: number): { value: number; bytes: number } | null | { error: string } {
  let multiplier = 1, value = 0, i = at
  for (;;) {
    if (i >= buf.length) return null
    const b = buf[i++]
    value += (b & 127) * multiplier
    // Errata 01: the bound is checked before the multiplier grows, so a four-byte length passes and a fifth byte fails.
    if (multiplier > 128 * 128 * 128) return { error: 'malformed Remaining Length' }
    if ((b & 128) === 0) return { value, bytes: i - at }
    multiplier *= 128
  }
}

export function encodeString(s: string): Uint8Array {
  if (s.includes('\u0000')) throw new RangeError('an MQTT string cannot contain U+0000')
  const bytes = utf8enc.encode(s)
  if (bytes.length > MQTT.maxString) throw new RangeError(`an MQTT string is at most ${MQTT.maxString} bytes`)
  const out = new Uint8Array(2 + bytes.length)
  out[0] = bytes.length >> 8
  out[1] = bytes.length & 255
  out.set(bytes, 2)
  return out
}

const be16 = (n: number): [number, number] => [(n >> 8) & 255, n & 255]
const bytesWithLength = (b: Uint8Array): Uint8Array => {
  if (b.length > MQTT.maxString) throw new RangeError('binary data is at most 65,535 bytes')
  const out = new Uint8Array(2 + b.length)
  out[0] = b.length >> 8
  out[1] = b.length & 255
  out.set(b, 2)
  return out
}
const concat = (parts: readonly (Uint8Array | readonly number[])[]): Uint8Array => {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
const packetId = (id: number): [number, number] => {
  if (!Number.isInteger(id) || id < 1 || id > 65_535) throw new RangeError(`packet identifier ${id} out of range (1 to 65535)`)
  return be16(id)
}
const isQos = (q: unknown): q is QoS => q === 0 || q === 1 || q === 2

function frame(typeAndFlags: number, body: Uint8Array): Uint8Array {
  return concat([[typeAndFlags], encodeRemainingLength(body.length), body])
}

/** One packet as its bytes. Throws RangeError on a packet that cannot be encoded (an id or a string out of range). */
export function encodePacket(p: Packet): Uint8Array {
  switch (p.type) {
    case 'connect': {
      if (p.will && !isQos(p.will.qos)) throw new RangeError('will QoS must be 0, 1 or 2')
      if (!Number.isInteger(p.keepAlive) || p.keepAlive < 0 || p.keepAlive > 65_535) throw new RangeError('keep alive is 0 to 65535 s')
      const flags = (p.username !== undefined ? 0x80 : 0) | (p.password !== undefined ? 0x40 : 0)
        | (p.will ? (p.will.retain ? 0x20 : 0) | (p.will.qos << 3) | 0x04 : 0) | (p.cleanSession ? 0x02 : 0)
      if (p.password !== undefined && p.username === undefined) throw new RangeError('a password needs a user name [MQTT-3.1.2-22]')
      const parts: Uint8Array[] = [encodeString(MQTT.protocolName), new Uint8Array([p.protocolLevel, flags, ...be16(p.keepAlive)]), encodeString(p.clientId)]
      if (p.will) parts.push(encodeString(p.will.topic), bytesWithLength(p.will.payload))
      if (p.username !== undefined) parts.push(encodeString(p.username))
      if (p.password !== undefined) parts.push(bytesWithLength(p.password))
      return frame(TYPE.connect << 4, concat(parts))
    }
    case 'connack':
      return frame(TYPE.connack << 4, new Uint8Array([p.sessionPresent ? 1 : 0, p.code]))
    case 'publish': {
      if (!isQos(p.qos)) throw new RangeError('QoS must be 0, 1 or 2')
      if (p.qos === 0 && p.packetId !== undefined) throw new RangeError('a QoS 0 PUBLISH carries no packet identifier [MQTT-2.3.1-5]')
      if (p.qos > 0 && p.packetId === undefined) throw new RangeError('a QoS 1 or 2 PUBLISH needs a packet identifier')
      if (/[+#]/.test(p.topic) || p.topic.length === 0) throw new RangeError('a PUBLISH topic has at least one character and no wildcard')
      const flags = (p.dup ? 0x08 : 0) | (p.qos << 1) | (p.retain ? 0x01 : 0)
      const parts: Uint8Array[] = [encodeString(p.topic)]
      if (p.qos > 0) parts.push(new Uint8Array(packetId(p.packetId!)))
      parts.push(p.payload)
      return frame((TYPE.publish << 4) | flags, concat(parts))
    }
    case 'puback': return frame(TYPE.puback << 4, new Uint8Array(packetId(p.packetId)))
    case 'pubrec': return frame(TYPE.pubrec << 4, new Uint8Array(packetId(p.packetId)))
    case 'pubrel': return frame((TYPE.pubrel << 4) | 0x02, new Uint8Array(packetId(p.packetId)))
    case 'pubcomp': return frame(TYPE.pubcomp << 4, new Uint8Array(packetId(p.packetId)))
    case 'subscribe': {
      if (p.topics.length === 0) throw new RangeError('a SUBSCRIBE names at least one topic filter [MQTT-3.8.3-3]')
      const parts: Uint8Array[] = [new Uint8Array(packetId(p.packetId))]
      for (const t of p.topics) {
        if (!isQos(t.qos)) throw new RangeError('a requested QoS is 0, 1 or 2')
        if (t.filter.length === 0) throw new RangeError('a topic filter has at least one character')
        parts.push(encodeString(t.filter), new Uint8Array([t.qos]))
      }
      return frame((TYPE.subscribe << 4) | 0x02, concat(parts))
    }
    case 'suback': return frame(TYPE.suback << 4, concat([packetId(p.packetId), p.codes]))
    case 'unsubscribe': {
      if (p.topics.length === 0) throw new RangeError('an UNSUBSCRIBE names at least one topic filter')
      return frame((TYPE.unsubscribe << 4) | 0x02, concat([new Uint8Array(packetId(p.packetId)), ...p.topics.map(encodeString)]))
    }
    case 'unsuback': return frame(TYPE.unsuback << 4, new Uint8Array(packetId(p.packetId)))
    case 'pingreq': return new Uint8Array([TYPE.pingreq << 4, 0])
    case 'pingresp': return new Uint8Array([TYPE.pingresp << 4, 0])
    case 'disconnect': return new Uint8Array([TYPE.disconnect << 4, 0])
  }
}

/** A cursor over one packet's body. */
class Body {
  at = 0
  readonly buf: Uint8Array
  constructor(buf: Uint8Array) { this.buf = buf }
  get left(): number { return this.buf.length - this.at }
  byte(): number {
    if (this.at >= this.buf.length) throw new Error('packet too short')
    return this.buf[this.at++]
  }
  u16(): number { return (this.byte() << 8) | this.byte() }
  bytes(n: number): Uint8Array {
    if (this.at + n > this.buf.length) throw new Error('packet too short')
    const b = this.buf.subarray(this.at, this.at + n)
    this.at += n
    return b
  }
  binary(): Uint8Array { return this.bytes(this.u16()) }
  string(): string {
    const b = this.binary()
    let s: string
    try { s = utf8dec.decode(b) } catch { throw new Error('a string that is not well-formed UTF-8 [MQTT-1.5.3-1]') }
    if (s.includes('\u0000')) throw new Error('a string with U+0000 [MQTT-1.5.3-2]')
    return s
  }
  id(): number {
    const id = this.u16()
    if (id === 0) throw new Error('a packet identifier of 0 [MQTT-2.3.1-1]')
    return id
  }
  rest(): Uint8Array { return this.bytes(this.left) }
  done(): void { if (this.left !== 0) throw new Error(`${this.left} bytes left over`) }
}

/** One complete packet from its type-and-flags byte and its body. Throws on a malformed one. */
export function decodePacket(first: number, body: Uint8Array): Packet {
  const type = first >> 4, flags = first & 15
  const b = new Body(body)
  const flagsZero = (what: string) => { if (flags !== 0) throw new Error(`${what} with reserved flags ${flags} [MQTT-2.2.2-2]`) }
  const flagsTwo = (what: string) => { if (flags !== 2) throw new Error(`${what} with flags ${flags}, not 2 [MQTT-2.2.2-1]`) }
  switch (type) {
    case TYPE.connect: {
      flagsZero('CONNECT')
      const name = b.string()
      if (name !== MQTT.protocolName) throw new Error(`protocol name '${name}' is not MQTT [MQTT-3.1.2-1]`)
      const protocolLevel = b.byte()
      const f = b.byte()
      if (f & 1) throw new Error('CONNECT reserved flag set [MQTT-3.1.2-3]')
      const keepAlive = b.u16()
      const willFlag = (f & 4) !== 0, willQos = (f >> 3) & 3, willRetain = (f & 0x20) !== 0
      if (!willFlag && (willQos !== 0 || willRetain)) throw new Error('will QoS or retain without a will [MQTT-3.1.2-13/15]')
      if (willQos === 3) throw new Error('will QoS 3 [MQTT-3.1.2-14]')
      const hasUser = (f & 0x80) !== 0, hasPass = (f & 0x40) !== 0
      if (hasPass && !hasUser) throw new Error('a password without a user name [MQTT-3.1.2-22]')
      const clientId = b.string()
      if (clientId.length === 0 && !(f & 2)) throw new Error('an empty client identifier needs clean session [MQTT-3.1.3-7]')
      const p: Extract<Packet, { type: 'connect' }> = { type: 'connect', clientId, keepAlive, cleanSession: (f & 2) !== 0, protocolLevel }
      if (willFlag) p.will = { topic: b.string(), payload: b.binary(), qos: willQos as QoS, retain: willRetain }
      if (hasUser) p.username = b.string()
      if (hasPass) p.password = b.binary()
      b.done()
      return p
    }
    case TYPE.connack: {
      flagsZero('CONNACK')
      const ack = b.byte()
      if (ack & 0xfe) throw new Error('CONNACK acknowledge flags reserved bits set [MQTT-3.2.2-1]')
      const code = b.byte()
      if (code > 5) throw new Error(`CONNACK return code ${code} is reserved`)
      b.done()
      return { type: 'connack', sessionPresent: (ack & 1) !== 0, code }
    }
    case TYPE.publish: {
      const qos = (flags >> 1) & 3
      if (qos === 3) throw new Error('PUBLISH with QoS 3 [MQTT-3.3.1-4]')
      const topic = b.string()
      if (topic.length === 0 || /[+#]/.test(topic)) throw new Error('PUBLISH topic empty or with a wildcard [MQTT-3.3.2-1/2]')
      const p: Extract<Packet, { type: 'publish' }> = { type: 'publish', topic, payload: new Uint8Array(0), qos: qos as QoS, retain: (flags & 1) !== 0, dup: (flags & 8) !== 0 }
      if (qos > 0) p.packetId = b.id()
      else if (p.dup) throw new Error('DUP set on a QoS 0 PUBLISH [MQTT-3.3.1-2]')
      p.payload = b.rest()
      return p
    }
    case TYPE.puback: case TYPE.pubrec: case TYPE.pubcomp: case TYPE.unsuback: {
      const name = type === TYPE.puback ? 'puback' : type === TYPE.pubrec ? 'pubrec' : type === TYPE.pubcomp ? 'pubcomp' : 'unsuback'
      flagsZero(name.toUpperCase())
      const id = b.id()
      b.done()
      return { type: name, packetId: id }
    }
    case TYPE.pubrel: {
      flagsTwo('PUBREL')
      const id = b.id()
      b.done()
      return { type: 'pubrel', packetId: id }
    }
    case TYPE.subscribe: {
      flagsTwo('SUBSCRIBE')
      const id = b.id()
      const topics: { filter: string; qos: QoS }[] = []
      while (b.left > 0) {
        const filter = b.string()
        if (filter.length === 0) throw new Error('an empty topic filter [MQTT-4.7.3-1]')
        const q = b.byte()
        if (q > 2) throw new Error(`requested QoS ${q} [MQTT-3-8.3-4]`)
        topics.push({ filter, qos: q as QoS })
      }
      if (topics.length === 0) throw new Error('SUBSCRIBE with no topic filter [MQTT-3.8.3-3]')
      return { type: 'subscribe', packetId: id, topics }
    }
    case TYPE.suback: {
      flagsZero('SUBACK')
      const id = b.id()
      const codes = [...b.rest()]
      if (codes.length === 0) throw new Error('SUBACK with no return code')
      for (const c of codes) if (c !== 0 && c !== 1 && c !== 2 && c !== SUBACK_FAILURE) throw new Error(`SUBACK return code ${c} is reserved [MQTT-3.9.3-2]`)
      return { type: 'suback', packetId: id, codes }
    }
    case TYPE.unsubscribe: {
      flagsTwo('UNSUBSCRIBE')
      const id = b.id()
      const topics: string[] = []
      while (b.left > 0) topics.push(b.string())
      if (topics.length === 0) throw new Error('UNSUBSCRIBE with no topic filter [MQTT-3.10.3-2]')
      return { type: 'unsubscribe', packetId: id, topics }
    }
    case TYPE.pingreq: flagsZero('PINGREQ'); b.done(); return { type: 'pingreq' }
    case TYPE.pingresp: flagsZero('PINGRESP'); b.done(); return { type: 'pingresp' }
    case TYPE.disconnect: flagsZero('DISCONNECT'); b.done(); return { type: 'disconnect' }
    default:
      throw new Error(`control packet type ${type} is reserved [MQTT-2.2.1]`)
  }
}

/**
 * A stream of bytes into packets. feed() returns every whole packet the bytes complete; the first malformed one
 * sets `error` and nothing is read after it (the connection is to be closed [MQTT-4.8]).
 */
export class PacketReader {
  private pending: Uint8Array = new Uint8Array(0)
  error: string | null = null
  readonly maxPacket: number
  constructor(maxPacket = 1 << 20) { this.maxPacket = maxPacket }
  feed(bytes: Uint8Array): Packet[] {
    if (this.error) return []
    this.pending = this.pending.length === 0 ? bytes : concat([this.pending, bytes])
    const out: Packet[] = []
    for (;;) {
      if (this.pending.length < 2) break
      const len = decodeRemainingLength(this.pending, 1)
      if (len === null) break
      if ('error' in len) { this.fail(len.error); break }
      if (len.value > this.maxPacket) { this.fail(`a packet of ${len.value} bytes (at most ${this.maxPacket})`); break }
      const total = 1 + len.bytes + len.value
      if (this.pending.length < total) break
      const first = this.pending[0]
      const body = this.pending.slice(1 + len.bytes, total)
      this.pending = this.pending.subarray(total)
      try {
        out.push(decodePacket(first, body))
      } catch (e) {
        this.fail(e instanceof Error ? e.message : String(e))
        break
      }
    }
    return out
  }
  private fail(why: string): void {
    this.error = why
    this.pending = new Uint8Array(0)
  }
}

/** The MQTT topic-filter match (4.7.1): `+` one level, `#` the rest, and a `$` topic never matched by a leading wildcard. */
export function topicMatches(filter: string, topic: string): boolean {
  if (topic.startsWith('$') && (filter.startsWith('+') || filter.startsWith('#'))) return false
  const f = filter.split('/'), t = topic.split('/')
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return i === f.length - 1
    if (i >= t.length) return false
    if (f[i] !== '+' && f[i] !== t[i]) return false
  }
  return f.length === t.length
}
