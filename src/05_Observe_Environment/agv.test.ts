// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the .agv container: header and packet layout byte for byte, the
 * round trip through the streaming demuxer at every split size (including 5 bytes at a time), u64
 * timestamps beyond 2^32, empty and absent telemetry, the decoder description in base64, the padded
 * header that a recorder rewrites in place, and the errors for foreign or damaged input.
 * What breaks if it is removed? A layout change could silently make every recording unreadable.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgvReader, emptyTelemetry, encodeHeader, encodePacket, fromBase64, readAgv, toBase64, type AgentTelemetry, type AgvHeader, type AgvPacket } from './agv.ts'

const HEADER: AgvHeader = { version: 1, codec: 'av01.0.04M.08', width: 1280, height: 720, framerate: 30, source: 'canvas', startedAt: '2026-09-26T10:00:00.000Z' }

const telemetry = (n: number): AgentTelemetry => ({
  intent: `Walking the Financial District ${n}`,
  markdown_log: n % 3 === 0 ? '**First Law** held back a vehicle for a person' : '',
  confidence: 1,
  spatial_coordinates: [n * 1.5, 1.7, -n - 1],
  state: { clock: '10:0' + n, tier: 'High', kernel: { law1: n } },
})

const packet = (n: number, extra: Partial<AgvPacket> = {}): AgvPacket => ({
  telemetry: telemetry(n),
  type: n % 4 === 0 ? 'key' : 'delta',
  timestamp: 33_333 * n,
  duration: 33_333,
  data: new Uint8Array(Array.from({ length: 10 + n }, (_, i) => (i * 7 + n) & 0xff)),
  ...extra,
})

const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint32(o, true)
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.byteLength }
  return out
}

test('header: magic, little-endian length, JSON; optional padding keeps the JSON parseable', () => {
  const h = encodeHeader(HEADER)
  assert.equal(String.fromCharCode(...h.subarray(0, 4)), 'AGV1')
  const json = JSON.stringify(HEADER)
  assert.equal(u32(h, 4), json.length)
  assert.equal(h.byteLength, 8 + json.length)
  assert.equal(new TextDecoder().decode(h.subarray(8)), json)
  const padded = encodeHeader(HEADER, 300)
  assert.equal(u32(padded, 4), 300)
  assert.equal(padded.byteLength, 308)
  assert.ok(padded.subarray(8 + json.length).every((b) => b === 0x20))
  assert.deepEqual(readAgv(padded).header, HEADER)
  // A reserve smaller than the JSON is simply ignored.
  assert.equal(encodeHeader(HEADER, 10).byteLength, h.byteLength)
  assert.throws(() => encodeHeader({ ...HEADER, version: 2 as unknown as 1 }), /version/)
})

test('packet layout: u32 telemetryLen, JSON, u8 type, u64 timestamp, u32 duration, u32 chunkLen, chunk', () => {
  const p = packet(4, { timestamp: 0x1_0000_0005, duration: 40_000 })
  const b = encodePacket(p)
  const json = JSON.stringify(p.telemetry)
  const view = new DataView(b.buffer)
  let o = 0
  assert.equal(view.getUint32(o, true), json.length); o += 4
  assert.equal(new TextDecoder().decode(b.subarray(o, o + json.length)), json); o += json.length
  assert.equal(b[o], 1, 'key = 1'); o += 1
  assert.equal(view.getBigUint64(o, true), 0x1_0000_0005n); o += 8
  assert.equal(view.getUint32(o, true), 40_000); o += 4
  assert.equal(view.getUint32(o, true), p.data.byteLength); o += 4
  assert.deepEqual(b.subarray(o), p.data)
  assert.equal(b.byteLength, o + p.data.byteLength)
  assert.equal(encodePacket(packet(1))[4 + JSON.stringify(telemetry(1)).length], 0, 'delta = 0')
  // One allocation per packet: the chunk is copied, not aliased.
  p.data[0] = 0xff
  assert.notEqual(b[o], 0xff)
})

test('round trip through readAgv: header, every packet, type, timestamps, duration and bytes', () => {
  const packets = Array.from({ length: 9 }, (_, i) => packet(i))
  const file = concat([encodeHeader(HEADER), ...packets.map(encodePacket)])
  const r = readAgv(file)
  assert.deepEqual(r.header, HEADER)
  assert.equal(r.packets.length, 9)
  for (let i = 0; i < 9; i++) {
    const got = r.packets[i], want = packets[i]
    assert.deepEqual(got.telemetry, want.telemetry)
    assert.equal(got.type, want.type)
    assert.equal(got.timestamp, want.timestamp)
    assert.equal(got.duration, want.duration)
    assert.deepEqual(got.data, want.data)
  }
})

test('lengths are UTF-8 byte counts, not string lengths: non-ASCII header and telemetry round-trip at every split', () => {
  const h: AgvHeader = { ...HEADER, codec: 'avc1.42E01F', startedAt: '2026-09-26T10:00:00.000Z', decoderConfig: { codec: 'avc1.42E01F', codedWidth: 1280, codedHeight: 720 } }
  const t: AgentTelemetry = { ...telemetry(1), intent: 'Walking · Financial District — 7th Ave & 7th St', state: { district: 'Zoë’s Café 🚸' } }
  const header = encodeHeader({ ...h, source: 'camera' })
  const one = encodePacket(packet(1, { telemetry: t }))
  const json = JSON.stringify(t)
  assert.ok(new TextEncoder().encode(json).byteLength > json.length, 'the fixture is non-ASCII')
  assert.equal(u32(one, 0), new TextEncoder().encode(json).byteLength)
  const file = concat([header, one, encodePacket(packet(2))])
  const whole = readAgv(file)
  assert.deepEqual(whole.packets[0].telemetry, t)
  assert.deepEqual(whole.packets[1].telemetry, telemetry(2))
  for (const step of [1, 3, 7]) {
    const r = new AgvReader()
    const got: AgvPacket[] = []
    for (let o = 0; o < file.byteLength; o += step) {
      r.push(file.subarray(o, Math.min(file.byteLength, o + step)))
      got.push(...r.packets())
    }
    assert.deepEqual(got, whole.packets, `step ${step}`)
    assert.equal(r.pending, 0)
  }
})

test('streaming demux: identical result for every split size, 5 bytes at a time included', () => {
  const packets = Array.from({ length: 7 }, (_, i) => packet(i))
  const file = concat([encodeHeader(HEADER, 200), ...packets.map(encodePacket)])
  const whole = readAgv(file)
  for (const step of [1, 2, 3, 5, 7, 13, 64, 1000, file.byteLength]) {
    const r = new AgvReader()
    const got: AgvPacket[] = []
    let sawHeaderAt = -1
    for (let o = 0; o < file.byteLength; o += step) {
      r.push(file.subarray(o, Math.min(file.byteLength, o + step)))
      if (r.header && sawHeaderAt < 0) sawHeaderAt = o + step
      got.push(...r.packets())
    }
    assert.deepEqual(r.header, whole.header, `step ${step}`)
    assert.ok(sawHeaderAt >= 208 && sawHeaderAt < 208 + step, `header known as soon as it is complete (step ${step}, at ${sawHeaderAt})`)
    assert.deepEqual(got, whole.packets, `step ${step}`)
    assert.equal(r.pending, 0)
    assert.deepEqual(r.packets(), [], 'packets() drains')
  }
})

test('a packet is only released once it is whole; a trailing partial packet stays pending', () => {
  const r = new AgvReader()
  const one = encodePacket(packet(2))
  r.push(encodeHeader(HEADER))
  r.push(one.subarray(0, one.byteLength - 1))
  assert.deepEqual(r.packets(), [])
  assert.equal(r.pending, one.byteLength - 1)
  r.push(one.subarray(one.byteLength - 1))
  assert.equal(r.packets().length, 1)
  assert.equal(r.pending, 0)
  // readAgv ignores an incomplete tail rather than failing the whole file.
  const file = concat([encodeHeader(HEADER), one, one.subarray(0, 20)])
  assert.equal(readAgv(file).packets.length, 1)
})

test('u64 timestamps beyond 2^32 and up to 2^53 - 1 survive; bad values are rejected before writing', () => {
  for (const ts of [0, 1, 0xffff_ffff, 0x1_0000_0000, 2 ** 40 + 12345, Number.MAX_SAFE_INTEGER]) {
    const r = readAgv(concat([encodeHeader(HEADER), encodePacket(packet(1, { timestamp: ts }))]))
    assert.equal(r.packets[0].timestamp, ts)
  }
  assert.throws(() => encodePacket(packet(1, { timestamp: -1 })), /timestamp/)
  assert.throws(() => encodePacket(packet(1, { timestamp: 1.5 })), /timestamp/)
  assert.throws(() => encodePacket(packet(1, { timestamp: 2 ** 53 })), /timestamp/)
  assert.throws(() => encodePacket(packet(1, { duration: 2 ** 32 })), /duration/)
  assert.throws(() => encodePacket(packet(1, { duration: -5 })), /duration/)
})

test('empty telemetry: an empty envelope round-trips; a zero-length telemetry field reads as emptyTelemetry()', () => {
  const empty: AgentTelemetry = { intent: '', markdown_log: '', confidence: 0, spatial_coordinates: [0, 0, 0] }
  const r = readAgv(concat([encodeHeader(HEADER), encodePacket(packet(1, { telemetry: empty }))]))
  assert.deepEqual(r.packets[0].telemetry, empty)
  assert.equal(r.packets[0].telemetry.state, undefined)
  // Hand-built packet with telemetryLen = 0.
  const data = new Uint8Array([1, 2, 3])
  const raw = new Uint8Array(4 + 1 + 8 + 4 + 4 + 3)
  const v = new DataView(raw.buffer)
  v.setUint32(0, 0, true); raw[4] = 1; v.setBigUint64(5, 77n, true); v.setUint32(13, 0, true); v.setUint32(17, 3, true); raw.set(data, 21)
  const p = readAgv(concat([encodeHeader(HEADER), raw])).packets[0]
  assert.deepEqual(p.telemetry, emptyTelemetry())
  assert.equal(p.type, 'key')
  assert.equal(p.timestamp, 77)
  assert.equal(p.duration, 0)
  assert.deepEqual(p.data, data)
  // Foreign telemetry shapes are normalized rather than trusted.
  const odd = { intent: 5, spatial_coordinates: [1, 2], state: 'nope', extra: true }
  const oddLen = JSON.stringify(odd).length
  const raw2 = new Uint8Array(4 + oddLen + 1 + 8 + 4 + 4)
  const v2 = new DataView(raw2.buffer)
  v2.setUint32(0, oddLen, true); raw2.set(new TextEncoder().encode(JSON.stringify(odd)), 4)
  const t = readAgv(concat([encodeHeader(HEADER), raw2])).packets[0].telemetry
  assert.deepEqual(t, emptyTelemetry())
})

test('decoder description travels as base64 in the header; base64 helpers round-trip every length', () => {
  const description = new Uint8Array([1, 100, 0, 255, 21, 22, 23])
  const h: AgvHeader = { ...HEADER, codec: 'avc1.42E01F', decoderConfig: { codec: 'avc1.42E01F', codedWidth: 1280, codedHeight: 720, descriptionBase64: toBase64(description) } }
  const r = readAgv(encodeHeader(h))
  assert.equal(r.header.decoderConfig?.descriptionBase64, 'AWQA/xUWFw==')
  assert.deepEqual(fromBase64(r.header.decoderConfig!.descriptionBase64!), description)
  for (let n = 0; n < 20; n++) {
    const bytes = new Uint8Array(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff))
    const b64 = toBase64(bytes)
    assert.equal(b64, Buffer.from(bytes).toString('base64'), `length ${n}`)
    assert.deepEqual(fromBase64(b64), bytes, `length ${n}`)
  }
})

test('the header can be rewritten in place with frames and duration when it was padded', () => {
  const reserve = encodeHeader(HEADER).byteLength - 8 + 64
  const start = encodeHeader(HEADER, reserve)
  const file = concat([start, encodePacket(packet(0)), encodePacket(packet(1))])
  const final = encodeHeader({ ...HEADER, frames: 2, durationUs: 66_666 }, reserve)
  assert.equal(final.byteLength, start.byteLength)
  file.set(final, 0)
  const r = readAgv(file)
  assert.equal(r.header.frames, 2)
  assert.equal(r.header.durationUs, 66_666)
  assert.equal(r.packets.length, 2)
})

test('foreign or damaged input fails loudly: wrong magic, bad JSON, unknown version, bad packet type', () => {
  assert.throws(() => readAgv(new TextEncoder().encode('RIFF....webm')), /not an AGV1 file/)
  assert.throws(() => readAgv(new Uint8Array([0x41, 0x47, 0x56, 0x31, 2, 0, 0, 0, 0x7b, 0x7d])), /version/)
  const badJson = new Uint8Array([0x41, 0x47, 0x56, 0x31, 3, 0, 0, 0, 0x7b, 0x21, 0x7d])
  assert.throws(() => readAgv(badJson), /header is not valid JSON/)
  assert.throws(() => readAgv(new Uint8Array([0x41, 0x47, 0x56])), /incomplete header/)
  const p = encodePacket(packet(1))
  p[4 + JSON.stringify(telemetry(1)).length] = 7
  assert.throws(() => readAgv(concat([encodeHeader(HEADER), p])), /bad packet type/)
  const r = new AgvReader()
  assert.throws(() => r.push(new TextEncoder().encode('AGV2....')), /not an AGV1 file/)
  // Pushing nothing is harmless.
  const ok = new AgvReader()
  ok.push(new Uint8Array(0))
  assert.equal(ok.header, null)
})
