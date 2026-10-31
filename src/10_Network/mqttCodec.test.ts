// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the MQTT 3.1.1 codec (mqttCodec.ts) against the specification's own numbers:
 * the Remaining Length at every boundary (Table 2.4), the CONNECT of section 3.1 byte for byte with a will, a user
 * name and a password, CONNACK's codes, PUBLISH at QoS 0 and 1 with its flags, the acknowledgements, the SUBSCRIBE
 * and SUBACK examples of sections 3.8 and 3.9, UNSUBSCRIBE, the three empty packets, every MUST a receiver checks
 * (reserved flags, QoS 3, a packet identifier of 0 or where none belongs, a malformed string, a reserved type), the
 * stream reader on bytes fed one at a time and two packets at once, and the topic filter match of section 4.7.
 * What breaks if it is removed? A broker could read the relay's bytes as something else, unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONNACK, decodePacket, decodeRemainingLength, encodePacket, encodeRemainingLength, encodeString, MQTT, PacketReader, SUBACK_FAILURE, topicMatches, TYPE, type Packet } from './mqttCodec.ts'

const hex = (b: Uint8Array | number[]): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ')
const bytes = (s: string): Uint8Array => new Uint8Array(s.split(/\s+/).filter(Boolean).map((h) => parseInt(h, 16)))
const roundTrip = (p: Packet): Packet => {
  const b = encodePacket(p)
  const r = new PacketReader()
  const out = r.feed(b)
  assert.equal(r.error, null, `decoding ${hex(b)}: ${r.error}`)
  assert.equal(out.length, 1)
  return out[0]
}

test('Remaining Length: one to four bytes at the boundaries of Table 2.4, incomplete is null, five bytes is malformed', () => {
  for (const [n, h] of [[0, '00'], [127, '7f'], [128, '80 01'], [16383, 'ff 7f'], [16384, '80 80 01'], [2097151, 'ff ff 7f'], [2097152, '80 80 80 01'], [268435455, 'ff ff ff 7f']] as const) {
    assert.equal(hex(encodeRemainingLength(n)), h, String(n))
    const d = decodeRemainingLength(bytes(h), 0)
    assert.deepEqual(d, { value: n, bytes: h.split(' ').length })
  }
  assert.throws(() => encodeRemainingLength(MQTT.maxRemaining + 1), RangeError)
  assert.equal(decodeRemainingLength(bytes('80 80'), 0), null, 'incomplete')
  assert.deepEqual(decodeRemainingLength(bytes('ff ff ff ff 7f'), 0), { error: 'malformed Remaining Length' })
  assert.deepEqual(decodeRemainingLength(bytes('10 7f'), 1), { value: 127, bytes: 1 }, 'read at an offset')
})

test('strings: two-byte big-endian length then UTF-8; no U+0000; at most 65,535 bytes', () => {
  assert.equal(hex(encodeString('MQTT')), '00 04 4d 51 54 54')
  assert.equal(hex(encodeString('é')), '00 02 c3 a9')
  assert.throws(() => encodeString('a\u0000b'), RangeError)
  assert.throws(() => encodeString('x'.repeat(65536)), RangeError)
  assert.equal(encodeString('x'.repeat(65535)).length, 65537)
})

test('CONNECT: the variable header of section 3.1.2 (MQTT, level 4, flags 0xCE, keep alive 10) and the payload in order', () => {
  const p: Packet = { type: 'connect', clientId: 'c1', keepAlive: 10, cleanSession: true, protocolLevel: 4, will: { topic: 'w', payload: bytes('01'), qos: 1, retain: false }, username: 'u', password: bytes('70') }
  const b = encodePacket(p)
  assert.equal(hex(b), '10 1a 00 04 4d 51 54 54 04 ce 00 0a 00 02 63 31 00 01 77 00 01 01 00 01 75 00 01 70')
  assert.deepEqual(roundTrip(p), p)
  const plain: Packet = { type: 'connect', clientId: 'relay', keepAlive: 60, cleanSession: true, protocolLevel: 4 }
  assert.equal(hex(encodePacket(plain)).slice(0, 29), '10 11 00 04 4d 51 54 54 04 02', 'flags: clean session alone')
  assert.deepEqual(roundTrip(plain), plain)
  const retained: Packet = { type: 'connect', clientId: 'h', keepAlive: 0, cleanSession: true, protocolLevel: 4, will: { topic: 'spBv1.0/STATE/h', payload: bytes('7b 7d'), qos: 1, retain: true } }
  assert.equal(encodePacket(retained)[9], 0x2e, 'will retain (0x20) + will QoS 1 (0x08) + will (0x04) + clean (0x02)')
  assert.deepEqual(roundTrip(retained), retained)
  assert.throws(() => encodePacket({ type: 'connect', clientId: 'c', keepAlive: 1, cleanSession: true, protocolLevel: 4, password: bytes('00') }), /password needs a user name/)
  assert.throws(() => encodePacket({ type: 'connect', clientId: 'c', keepAlive: 70000, cleanSession: true, protocolLevel: 4 }), RangeError)
  // What a receiver refuses: a reserved flag, a will QoS without a will, a protocol name that is not MQTT, an empty id without clean session.
  const body = (flags: number, id = '00 01 63') => bytes(`00 04 4d 51 54 54 04 ${flags.toString(16).padStart(2, '0')} 00 0a ${id}`)
  assert.throws(() => decodePacket(TYPE.connect << 4, body(0x03)), /reserved flag/)
  assert.throws(() => decodePacket(TYPE.connect << 4, body(0x0a)), /without a will/)
  assert.throws(() => decodePacket(TYPE.connect << 4, body(0x1e)), /QoS 3/)
  assert.throws(() => decodePacket(TYPE.connect << 4, body(0x42)), /password without a user name/)
  assert.throws(() => decodePacket(TYPE.connect << 4, body(0x00, '00 00')), /empty client identifier needs clean session/)
  assert.throws(() => decodePacket(TYPE.connect << 4, bytes('00 04 4d 51 54 53 04 02 00 0a 00 00')), /not MQTT/)
  assert.throws(() => decodePacket((TYPE.connect << 4) | 1, body(0x02)), /reserved flags/)
  const level = decodePacket(TYPE.connect << 4, bytes('00 04 4d 51 54 54 03 02 00 0a 00 00'))
  assert.ok(level.type === 'connect' && level.protocolLevel === 3, 'an unknown level is read, for the CONNACK 0x01 answer')
})

test('CONNACK: session present and the six return codes; reserved bits and codes refused', () => {
  assert.equal(hex(encodePacket({ type: 'connack', sessionPresent: false, code: CONNACK.accepted })), '20 02 00 00')
  assert.deepEqual(roundTrip({ type: 'connack', sessionPresent: true, code: CONNACK.unauthorized }), { type: 'connack', sessionPresent: true, code: 5 })
  assert.throws(() => decodePacket(TYPE.connack << 4, bytes('02 00')), /reserved bits/)
  assert.throws(() => decodePacket(TYPE.connack << 4, bytes('00 06')), /reserved/)
  assert.throws(() => decodePacket(TYPE.connack << 4, bytes('00 00 00')), /left over/)
})

test('PUBLISH: QoS 0 without an identifier, QoS 1 with one, the DUP and RETAIN flags, and what is refused', () => {
  const q0: Packet = { type: 'publish', topic: 'a/b', payload: new TextEncoder().encode('hello'), qos: 0, retain: false, dup: false }
  assert.equal(hex(encodePacket(q0)), '30 0a 00 03 61 2f 62 68 65 6c 6c 6f')
  assert.deepEqual(roundTrip(q0), q0)
  const q1: Packet = { type: 'publish', topic: 'a/b', payload: new TextEncoder().encode('hello'), qos: 1, retain: true, dup: false, packetId: 10 }
  assert.equal(hex(encodePacket(q1)), '33 0c 00 03 61 2f 62 00 0a 68 65 6c 6c 6f')
  assert.deepEqual(roundTrip(q1), q1)
  const dup = roundTrip({ ...q1, dup: true })
  assert.ok(dup.type === 'publish' && dup.dup && dup.qos === 1 && dup.retain)
  const empty = roundTrip({ type: 'publish', topic: 't', payload: new Uint8Array(0), qos: 0, retain: false, dup: false })
  assert.ok(empty.type === 'publish' && empty.payload.length === 0)
  assert.throws(() => encodePacket({ ...q0, packetId: 1 }), /QoS 0 PUBLISH carries no packet identifier/)
  assert.throws(() => encodePacket({ ...q1, packetId: undefined }), /needs a packet identifier/)
  assert.throws(() => encodePacket({ ...q0, topic: 'a/+' }), /no wildcard/)
  assert.throws(() => encodePacket({ ...q1, packetId: 0 }), RangeError)
  assert.throws(() => decodePacket((TYPE.publish << 4) | 0x06, bytes('00 01 74')), /QoS 3/)
  assert.throws(() => decodePacket((TYPE.publish << 4) | 0x08, bytes('00 01 74')), /DUP set on a QoS 0/)
  assert.throws(() => decodePacket((TYPE.publish << 4) | 0x02, bytes('00 01 74 00 00')), /identifier of 0/)
  assert.throws(() => decodePacket(TYPE.publish << 4, bytes('00 01 23')), /wildcard/)
  assert.throws(() => decodePacket(TYPE.publish << 4, bytes('00 00')), /empty/)
  assert.throws(() => decodePacket(TYPE.publish << 4, bytes('00 02 c3 28')), /not well-formed UTF-8/)
  assert.throws(() => decodePacket(TYPE.publish << 4, bytes('00 01 00')), /U\+0000/)
})

test('the acknowledgements: PUBACK, PUBREC, PUBCOMP and UNSUBACK with flags 0, PUBREL with flags 2', () => {
  assert.equal(hex(encodePacket({ type: 'puback', packetId: 10 })), '40 02 00 0a')
  assert.equal(hex(encodePacket({ type: 'pubrel', packetId: 10 })), '62 02 00 0a')
  assert.equal(hex(encodePacket({ type: 'unsuback', packetId: 10 })), 'b0 02 00 0a')
  for (const t of ['puback', 'pubrec', 'pubrel', 'pubcomp', 'unsuback'] as const) assert.deepEqual(roundTrip({ type: t, packetId: 65535 }), { type: t, packetId: 65535 })
  assert.throws(() => decodePacket(TYPE.pubrel << 4, bytes('00 0a')), /flags 0, not 2/)
  assert.throws(() => decodePacket((TYPE.puback << 4) | 2, bytes('00 0a')), /reserved flags/)
  assert.throws(() => decodePacket(TYPE.puback << 4, bytes('00 00')), /identifier of 0/)
  assert.throws(() => decodePacket(TYPE.puback << 4, bytes('00')), /too short/)
})

test('SUBSCRIBE and SUBACK as sections 3.8 and 3.9 show them; UNSUBSCRIBE; the empty packets', () => {
  const sub: Packet = { type: 'subscribe', packetId: 10, topics: [{ filter: 'a/b', qos: 2 }, { filter: 'c/d', qos: 1 }] }
  assert.equal(hex(encodePacket(sub)), '82 0e 00 0a 00 03 61 2f 62 02 00 03 63 2f 64 01')
  assert.deepEqual(roundTrip(sub), sub)
  const ack: Packet = { type: 'suback', packetId: 10, codes: [0, 2, SUBACK_FAILURE] }
  assert.equal(hex(encodePacket(ack)), '90 05 00 0a 00 02 80')
  assert.deepEqual(roundTrip(ack), ack)
  const unsub: Packet = { type: 'unsubscribe', packetId: 10, topics: ['a/b', 'c/d'] }
  assert.equal(hex(encodePacket(unsub)), 'a2 0c 00 0a 00 03 61 2f 62 00 03 63 2f 64')
  assert.deepEqual(roundTrip(unsub), unsub)
  assert.throws(() => encodePacket({ type: 'subscribe', packetId: 1, topics: [] }), /at least one/)
  assert.throws(() => encodePacket({ type: 'subscribe', packetId: 1, topics: [{ filter: 'a', qos: 3 as never }] }), /requested QoS/)
  assert.throws(() => decodePacket(TYPE.subscribe << 4, bytes('00 0a 00 01 61 00')), /flags 0, not 2/)
  assert.throws(() => decodePacket((TYPE.subscribe << 4) | 2, bytes('00 0a')), /no topic filter/)
  assert.throws(() => decodePacket((TYPE.subscribe << 4) | 2, bytes('00 0a 00 01 61 03')), /requested QoS 3/)
  assert.throws(() => decodePacket((TYPE.subscribe << 4) | 2, bytes('00 0a 00 00 00')), /empty topic filter/)
  assert.throws(() => decodePacket(TYPE.suback << 4, bytes('00 0a 03')), /return code 3/)
  assert.throws(() => decodePacket(TYPE.suback << 4, bytes('00 0a')), /no return code/)
  assert.throws(() => decodePacket((TYPE.unsubscribe << 4) | 2, bytes('00 0a')), /no topic filter/)
  assert.equal(hex(encodePacket({ type: 'pingreq' })), 'c0 00')
  assert.equal(hex(encodePacket({ type: 'pingresp' })), 'd0 00')
  assert.equal(hex(encodePacket({ type: 'disconnect' })), 'e0 00')
  for (const t of ['pingreq', 'pingresp', 'disconnect'] as const) assert.deepEqual(roundTrip({ type: t }), { type: t })
  assert.throws(() => decodePacket(TYPE.pingreq << 4, bytes('00')), /left over/)
  assert.throws(() => decodePacket(0x00, new Uint8Array(0)), /reserved/)
  assert.throws(() => decodePacket(0xf0, new Uint8Array(0)), /reserved/)
})

test('the stream reader: bytes one at a time, two packets in one buffer, the first malformed packet stops it, a bound on size', () => {
  const a = encodePacket({ type: 'publish', topic: 't', payload: bytes('01 02'), qos: 0, retain: false, dup: false })
  const b = encodePacket({ type: 'pingresp' })
  const r = new PacketReader()
  const got: Packet[] = []
  for (const byte of [...a, ...b]) got.push(...r.feed(new Uint8Array([byte])))
  assert.deepEqual(got.map((p) => p.type), ['publish', 'pingresp'])
  const both = new Uint8Array([...a, ...b, ...a])
  assert.deepEqual(new PacketReader().feed(both).map((p) => p.type), ['publish', 'pingresp', 'publish'])
  const bad = new PacketReader()
  const out = bad.feed(new Uint8Array([...a, 0x00, 0x00, ...b]))
  assert.deepEqual(out.map((p) => p.type), ['publish'], 'what came before is delivered')
  assert.match(bad.error ?? '', /reserved/)
  assert.deepEqual(bad.feed(b), [], 'nothing is read after an error')
  const small = new PacketReader(4)
  small.feed(a)
  assert.match(small.error ?? '', /at most 4/)
  const huge = new PacketReader()
  huge.feed(bytes('30 ff ff ff ff 7f'))
  assert.match(huge.error ?? '', /malformed Remaining Length/)
  const partial = new PacketReader()
  assert.deepEqual(partial.feed(bytes('30')), [])
  assert.deepEqual(partial.feed(bytes('80')), [], 'a length still incomplete')
  assert.equal(partial.error, null)
})

test('topic filters (4.7): + is one level, # the rest, a $ topic is not matched by a leading wildcard', () => {
  const yes: [string, string][] = [['a/b', 'a/b'], ['a/+', 'a/b'], ['a/+/c', 'a/b/c'], ['a/#', 'a'], ['a/#', 'a/b/c'], ['#', 'a/b'], ['+/+', 'a/b'], ['spBv1.0/#', 'spBv1.0/g/NBIRTH/n'], ['+/b', '/b'], ['$SYS/#', '$SYS/x']]
  const no: [string, string][] = [['a/+', 'a/b/c'], ['a/+', 'a'], ['a/b', 'a/c'], ['+', 'a/b'], ['#', '$SYS/x'], ['+/x', '$SYS/x'], ['a/#/b', 'a/x/b'], ['a/b', 'a/b/']]
  for (const [f, t] of yes) assert.equal(topicMatches(f, t), true, `${f} ~ ${t}`)
  for (const [f, t] of no) assert.equal(topicMatches(f, t), false, `${f} !~ ${t}`)
})
