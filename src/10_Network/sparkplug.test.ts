// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the Sparkplug B codec (sparkplug.ts): the topic namespace (which types carry a
 * device id, the reserved characters, the host's STATE topic), the Protocol Buffers payload byte for byte from the
 * field numbers of Eclipse Tahu's sparkplug_b.proto (varints, the double's eight little-endian bytes, a nested
 * metric's length), every scalar value type round-tripped, a negative Int32 as the reference codecs carry it (two's
 * complement in the uint32 field), an unknown field skipped by wire type, truncation refused, the data types read
 * back as JavaScript values, the counters' wrap at 255, the STATE certificate, and the joint convention: a birth
 * with aliases read as a robot, data folded by alias into the last frame, targets written and read back, arming,
 * disarming, the CAPS body and the ack, a DCMD payload with no seq, and a null metric read as NaN (a frame that holds).
 * What breaks if it is removed? A broker's bytes could be read as the wrong joints, or an alias as the wrong one.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildManifest, checkFrame, type JointFrame, type Manifest } from '../04_Connect_Hardware/jointState.ts'
import {
  armMetrics, birthMetrics, commandMetrics, DATA_TYPE, dataMetrics, decodeMetric, decodePayload, disarmMetrics, encodeMetric, encodePayload, frameFromData, JOINT_METRICS, metric, metricValue, nextSeq,
  parseState, parseTopic, robotFromBirth, SPARKPLUG, stateJson, stateTopic, targetsFromCommand, topic, validElement, type Payload,
} from './sparkplug.ts'

const hex = (b: Uint8Array | number[]): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ')
const bytes = (s: string): Uint8Array => new Uint8Array(s.split(/\s+/).filter(Boolean).map((h) => parseInt(h, 16)))

test('topics: spBv1.0/<group>/<TYPE>/<node>[/<device>], a device id on the four device types alone, the reserved characters, STATE', () => {
  assert.equal(topic('g1', 'NBIRTH', 'n1'), 'spBv1.0/g1/NBIRTH/n1')
  assert.equal(topic('g1', 'DDATA', 'n1', 'arm'), 'spBv1.0/g1/DDATA/n1/arm')
  assert.throws(() => topic('g1', 'DBIRTH', 'n1'), /needs a device id/)
  assert.throws(() => topic('g1', 'NDATA', 'n1', 'd'), /carries no device id/)
  assert.throws(() => topic('g/1', 'NDATA', 'n1'), /not a Sparkplug topic element/)
  assert.equal(stateTopic('city'), 'spBv1.0/STATE/city')
  assert.deepEqual(parseTopic('spBv1.0/g1/DCMD/n1/arm'), { kind: 'device', group: 'g1', type: 'DCMD', node: 'n1', device: 'arm' })
  assert.deepEqual(parseTopic('spBv1.0/g1/NCMD/n1'), { kind: 'node', group: 'g1', type: 'NCMD', node: 'n1' })
  assert.deepEqual(parseTopic('spBv1.0/STATE/city'), { kind: 'state', host: 'city' })
  for (const t of ['spAv1.0/g/NBIRTH/n', 'spBv1.0/g/NBIRTH', 'spBv1.0/g/NBIRTH/n/d', 'spBv1.0/g/DDATA/n', 'spBv1.0/g/XDATA/n', 'spBv1.0/STATE', 'spBv1.0/STATE/a/b', 'spBv1.0//NDATA/n', 'spBv1.0/g+/NDATA/n']) assert.equal(parseTopic(t), null, t)
  assert.ok(validElement('Robot Cell 1') && validElement('n-1.é'))
  for (const e of ['', 'a+b', 'a/b', 'a#b', 'a\u0000b', 'a\tb', 42]) assert.equal(validElement(e), false, String(e))
  assert.equal(SPARKPLUG.rebirth, 'Node Control/Rebirth')
})

test('the payload byte for byte: timestamp 08, metric 12 with name 0a, timestamp 18, datatype 20, double 69 (little-endian), seq 18', () => {
  const p: Payload = { timestamp: 1, metrics: [metric('a', 'Double', 1.5, 3)], seq: 2 }
  const b = encodePayload(p)
  assert.equal(hex(b), '08 01 12 10 0a 01 61 18 03 20 0a 69 00 00 00 00 00 00 f8 3f 18 02')
  const back = decodePayload(b)
  assert.deepEqual(back, { timestamp: 1, metrics: [{ name: 'a', timestamp: 3, datatype: DATA_TYPE.Double, value: { kind: 'double', value: 1.5 } }], seq: 2 })
  const big = encodePayload({ timestamp: 1_700_000_000_000, metrics: [], seq: 255, uuid: 'u', body: bytes('ff') })
  assert.deepEqual(decodePayload(big), { timestamp: 1_700_000_000_000, metrics: [], seq: 255, uuid: 'u', body: bytes('ff') })
  assert.equal(hex(encodeMetric({ alias: 300 })), '10 ac 02', 'a two-byte varint')
})

test('every value type round-trips; a negative Int32 travels as two\'s complement in the uint32 field; Int64 as a varint; floats as four bytes', () => {
  const ms = [
    metric('i8', 'Int8', -5, 1), metric('i16', 'Int16', -300, 1), metric('i32', 'Int32', -70000, 1), metric('i64', 'Int64', -7, 1),
    metric('u8', 'UInt8', 200, 1), metric('u32', 'UInt32', 4_000_000_000, 1), metric('u64', 'UInt64', 2n ** 40n, 1), metric('dt', 'DateTime', 1_700_000_000_000, 1),
    metric('f', 'Float', 0.5, 1), metric('d', 'Double', -2.25, 1), metric('b', 'Boolean', true, 1), metric('s', 'String', 'héllo', 1), metric('t', 'Text', 'x', 1), metric('u', 'UUID', 'u', 1),
  ]
  const back = decodePayload(encodePayload({ metrics: ms })).metrics
  assert.deepEqual(back.map(metricValue), [-5, -300, -70000, -7, 200, 4_000_000_000, 2 ** 40, 1_700_000_000_000, 0.5, -2.25, true, 'héllo', 'x', 'u'])
  assert.equal(hex(encodeMetric({ value: { kind: 'int', value: (-5 >>> 0) } })), '50 fb ff ff ff 0f', 'uint32 two\'s complement of −5')
  assert.equal(hex(encodeMetric({ value: { kind: 'long', value: -1n } })), '58 ff ff ff ff ff ff ff ff ff 01', 'a 64-bit two\'s complement varint, ten bytes')
  assert.equal(hex(encodeMetric({ value: { kind: 'float', value: 0.5 } })), '65 00 00 00 3f')
  const bytesMetric = decodeMetric(encodeMetric({ name: 'raw', datatype: DATA_TYPE.Bytes, value: { kind: 'bytes', value: bytes('01 02 03') } }))
  assert.deepEqual(metricValue(bytesMetric), bytes('01 02 03'))
  const arr = new Uint8Array(16)
  new DataView(arr.buffer).setFloat64(0, 1.5, true)
  new DataView(arr.buffer).setFloat64(8, -2, true)
  assert.deepEqual(metricValue({ datatype: DATA_TYPE.DoubleArray, value: { kind: 'bytes', value: arr } }), [1.5, -2])
  assert.equal(metricValue({ datatype: DATA_TYPE.Double, isNull: true, value: { kind: 'double', value: 1 } }), undefined, 'is_null')
  assert.equal(metricValue({ value: { kind: 'double', value: 4 } }), 4, 'no datatype (a DATA message): the raw scalar')
  assert.equal(metricValue({ datatype: DATA_TYPE.Boolean, value: { kind: 'int', value: 1 } }), undefined, 'a value of the wrong kind for its type')
  assert.throws(() => metric('x', 'DataSet', 1, 1), /not built here/)
})

test('unknown fields are skipped by wire type (metadata, properties, a data set); truncation and a ten-byte-plus varint are refused', () => {
  // metric: name "a" (0a 01 61), then field 8 (metadata, LEN) with two bytes, field 9 (properties, LEN) empty, then a double.
  const withUnknown = bytes('0a 01 61 42 02 08 01 4a 00 69 00 00 00 00 00 00 f8 3f')
  assert.deepEqual(decodeMetric(withUnknown), { name: 'a', value: { kind: 'double', value: 1.5 } })
  // payload: an unknown field 7 as a fixed32 (wire type 5) and field 6 as a varint, then seq.
  assert.deepEqual(decodePayload(bytes('3d 01 02 03 04 30 07 18 05')), { metrics: [], seq: 5 })
  assert.throws(() => decodePayload(bytes('12 05 0a 01')), /length past the end|truncated/)
  assert.throws(() => decodeMetric(bytes('69 00 00')), /truncated/)
  assert.throws(() => decodeMetric(bytes('10 ff ff ff ff ff ff ff ff ff ff 01')), /ten bytes/)
  assert.throws(() => decodeMetric(bytes('a4 01')), /wire type 4/)
})

test('counters wrap at 255 and the STATE certificate is JSON with online and timestamp', () => {
  assert.equal(nextSeq(0), 1)
  assert.equal(nextSeq(254), 255)
  assert.equal(nextSeq(255), 0)
  assert.equal(new TextDecoder().decode(stateJson(true, 5)), '{"online":true,"timestamp":5}')
  assert.deepEqual(parseState(stateJson(false, 7)), { online: false, timestamp: 7 })
  assert.equal(parseState(bytes('7b')), null)
  assert.equal(parseState(new TextEncoder().encode('{"online":"yes","timestamp":1}')), null)
})

function arm(): Manifest {
  const r = buildManifest('arm', [{ name: 'base' }, { name: 'l1', mass: 1 }, { name: 'l2', mass: 1 }, { name: 'tool' }], [
    { name: 'shoulder', kind: 'revolute', parent: 'base', child: 'l1', axis: [0, 0, 1], lower: -1, upper: 1, effort: 10, velocity: 2 },
    { name: 'elbow', kind: 'revolute', parent: 'l1', child: 'l2', axis: [0, 0, 1], lower: 0, upper: 2, effort: 5, velocity: 2 },
    { name: 'wrist', kind: 'fixed', parent: 'l2', child: 'tool' },
  ])
  assert.ok(r.ok)
  return r.value
}

test('the joint convention: a birth with aliases is a robot; data by alias folds into the last frame; targets and arming go out by alias and read back', () => {
  const m = arm()
  const frame0: JointFrame = { stamp: 100, seq: 0, q: [0.1, 0.2], qd: [0, 0], tau: [1, 2] }
  const birth = birthMetrics(m, frame0, 100, { aliases: true, armable: true })
  assert.equal(birth[0].name, JOINT_METRICS.manifest)
  assert.deepEqual(birth.slice(1, 4).map((x) => x.name), ['Joints/shoulder/q', 'Joints/shoulder/qd', 'Joints/shoulder/tau'])
  assert.deepEqual(birth.map((x) => x.alias), birth.map((_, i) => i + 1), 'aliases 1..n')
  // Over the wire and back: a real host sees the decoded birth.
  const decodedBirth = decodePayload(encodePayload({ timestamp: 100, metrics: birth, seq: 0 })).metrics
  const read = robotFromBirth(decodedBirth)
  assert.ok(read && read.ok, read && !read.ok ? read.reason : 'no manifest')
  const robot = read.value
  assert.deepEqual(robot.manifest, m)
  assert.ok(robot.acceptsTargets && robot.armable)
  assert.equal(robot.byAlias.get(2), 'Joints/shoulder/q')
  assert.equal(robot.aliasOf.get(JOINT_METRICS.arm), 11)
  // DATA by alias alone: positions and one effort changed; the rest of the frame is kept from before.
  const data = dataMetrics(robot, { stamp: 150, seq: 1, q: [0.3, 0.4], qd: [], tau: [] }, { beat: 7 })
  assert.ok(data.every((x) => x.name === undefined && x.alias !== undefined && x.datatype === undefined), 'DATA carries aliases and no datatype')
  const folded = frameFromData(robot, decodePayload(encodePayload({ timestamp: 150, metrics: data, seq: 1 })), frame0, 42, 999)
  assert.deepEqual(folded.frame, { stamp: 150, seq: 42, q: [0.3, 0.4], qd: [0, 0], tau: [1, 2] })
  assert.equal(folded.beat, 7)
  assert.equal(folded.armed, undefined)
  assert.equal(folded.unknownAliases, 0)
  const stranger = frameFromData(robot, { metrics: [{ alias: 99, value: { kind: 'double', value: 1 } }] }, folded.frame, 43, 1000)
  assert.equal(stranger.unknownAliases, 1, 'an alias the birth never declared: a rebirth is due')
  assert.deepEqual(stranger.frame.q, [0.3, 0.4], 'and nothing moved')
  assert.equal(stranger.frame.stamp, 1000, 'no payload timestamp: the relay\'s clock')
  const first = frameFromData(robot, { timestamp: 5, metrics: [] }, null, 0, 0)
  assert.deepEqual(first.frame.q, [0, 0], 'no previous frame: zeros')
  // Targets out as a DCMD, and read back by a device.
  const cmd = commandMetrics(robot, { seq: 9, issuedAt: 5000, ttlMs: 100, q: [0.5, 1], qd: [], tau: [1, 1] }, 5001)
  assert.ok(cmd)
  assert.deepEqual(cmd.map((x) => x.alias), [8, 9, 10, 2, 4, 5, 7])
  const got = targetsFromCommand(robot, decodePayload(encodePayload({ timestamp: 5001, metrics: cmd })))
  assert.ok(got.ok, got.ok ? '' : got.reason)
  assert.deepEqual(got.value, { seq: 9, issuedAt: 5000, ttlMs: 100, q: [0.5, 1], qd: [], tau: [1, 1] })
  const armCmd = armMetrics(robot, 'n0nce', 1)
  assert.deepEqual(armCmd, [{ alias: 11, timestamp: 1, value: { kind: 'string', value: 'n0nce' } }])
  const echoed = frameFromData(robot, { metrics: dataMetrics(robot, folded.frame, { armed: 'n0nce' }) }, folded.frame, 44, 1)
  assert.equal(echoed.armed, 'n0nce')
})

test('births without aliases, without command metrics, without a manifest, or with a bad one', () => {
  const m = arm()
  const plain = robotFromBirth(birthMetrics(m, null, 1))
  assert.ok(plain && plain.ok)
  assert.equal(plain.value.aliasOf.size, 0)
  assert.equal(plain.value.acceptsTargets, false)
  assert.equal(commandMetrics(plain.value, { seq: 1, issuedAt: 1, ttlMs: 1, q: [0, 0], qd: [], tau: [] }, 2), null, 'no Joints/Seq: no targets')
  assert.equal(armMetrics(plain.value, 'x', 1), null)
  const byName = dataMetrics(plain.value, { stamp: 1, seq: 1, q: [1, 2], qd: [3, 4], tau: [5, 6] })
  assert.ok(byName.every((x) => x.name !== undefined && x.alias === undefined), 'no aliases: DATA carries names')
  const folded = frameFromData(plain.value, { metrics: byName }, null, 1, 1)
  assert.deepEqual([folded.frame.q, folded.frame.qd, folded.frame.tau], [[1, 2], [3, 4], [5, 6]])
  const targetsOnly = robotFromBirth(birthMetrics(m, null, 1, { targets: true }))
  assert.ok(targetsOnly && targetsOnly.ok && targetsOnly.value.acceptsTargets && !targetsOnly.value.armable)
  assert.equal(robotFromBirth([metric('Temperature', 'Double', 20, 1)]), null, 'an ordinary device is not a robot')
  const bad = robotFromBirth([metric(JOINT_METRICS.manifest, 'String', '{"robot":"r"}', 1)])
  assert.ok(bad && !bad.ok && /links and joints/.test(bad.reason))
  const notString = robotFromBirth([metric(JOINT_METRICS.manifest, 'Double', 1, 1)])
  assert.ok(notString && !notString.ok && /not a string metric/.test(notString.reason))
  const missingQ = robotFromBirth([birthMetrics(m, null, 1)[0]])
  assert.ok(missingQ && !missingQ.ok && /declares no Joints\/shoulder\/q/.test(missingQ.reason))
  const twice = birthMetrics(m, null, 1, { aliases: true })
  const dup = robotFromBirth([...twice, { ...twice[1], name: 'Joints/elbow/tau', alias: 2 }])
  assert.ok(dup && !dup.ok && /alias 2 is used twice/.test(dup.reason))
  const partial = targetsFromCommand(plain.value, { metrics: [metric('Joints/shoulder/q', 'Double', 1, 1)] })
  assert.ok(!partial.ok, 'targets without seq, issuedAt, ttl and every q are refused')
})

test('caps and ack: a birth with Joints/Caps is a robot with a CAPS body; Joints/Ack rides data and the frame; DISARM <cause> goes to Joints/Arm; a DCMD payload carries no seq', () => {
  const m = arm()
  const capsBody = '{"class":"actuator","actuation":["servo"]}'
  const birth = birthMetrics(m, { stamp: 1, seq: 0, q: [0, 0], qd: [], tau: [], ack: 3 }, 1, { aliases: true, armable: true, caps: capsBody })
  assert.equal(JOINT_METRICS.caps, 'Joints/Caps')
  assert.equal(JOINT_METRICS.ack, 'Joints/Ack')
  // The words a birth without caps or ack gave keep their aliases: ack and caps come after beat.
  assert.deepEqual(birth.slice(-2).map((x) => [x.name, x.alias]), [[JOINT_METRICS.ack, 14], [JOINT_METRICS.caps, 15]])
  assert.deepEqual(metricValue(birth.at(-2)!), 3, 'the birth carries the last ack')
  const read = robotFromBirth(decodePayload(encodePayload({ timestamp: 1, metrics: birth, seq: 0 })).metrics)
  assert.ok(read && read.ok)
  const robot = read.value
  assert.equal(robot.caps, capsBody)
  assert.equal(robot.aliasOf.get(JOINT_METRICS.arm), 11, 'the arm alias is where it was')
  assert.equal(robot.byAlias.get(14), JOINT_METRICS.ack)
  const plain = robotFromBirth(birthMetrics(m, null, 1))
  assert.ok(plain && plain.ok)
  assert.equal(plain.value.caps, null, 'no Joints/Caps: a sensor to the gate')
  // The ack rides DATA by alias and lands on the read and the frame (so checkFrame passes it through).
  const data = dataMetrics(robot, { stamp: 5, seq: 1, q: [0.1, 0.2], qd: [], tau: [] }, { ack: 9 })
  assert.deepEqual(data.at(-1), { alias: 14, timestamp: 5, value: { kind: 'long', value: 9n } })
  const folded = frameFromData(robot, decodePayload(encodePayload({ timestamp: 5, metrics: data, seq: 1 })), null, 1, 5)
  assert.equal(folded.ack, 9)
  assert.deepEqual(folded.frame, { stamp: 5, seq: 1, q: [0.1, 0.2], qd: [0, 0], tau: [0, 0], ack: 9 })
  const fromFrame = dataMetrics(robot, { stamp: 6, seq: 2, q: [0, 0], qd: [], tau: [], ack: 10 })
  assert.equal(metricValue(fromFrame.at(-1)!), 10, 'a frame\'s own ack is written when no extra one is given')
  const checked = checkFrame(2, folded.frame)
  assert.ok(checked.ok && checked.value.ack === 9)
  // Disarm: the HAL/1 word in Joints/Arm; a robot that cannot be armed gets none.
  assert.deepEqual(disarmMetrics(robot, 'page-gone', 7), [{ alias: 11, timestamp: 7, value: { kind: 'string', value: 'DISARM page-gone' } }])
  assert.equal(disarmMetrics(plain.value, 'page-gone', 7), null)
  // A DCMD's payload: a timestamp and metrics, no seq (commandMetrics writes none and encodePayload omits an undefined one).
  const cmd = commandMetrics(robot, { seq: 4, issuedAt: 100, ttlMs: 100, q: [0.5, 1], qd: [], tau: [] }, 101)
  assert.ok(cmd)
  const dcmd = decodePayload(encodePayload({ timestamp: 101, metrics: cmd }))
  assert.equal(dcmd.seq, undefined)
  assert.ok(!('seq' in dcmd))
  assert.deepEqual(dcmd.metrics.map((x) => x.alias), [8, 9, 10, 2, 5])
})

test('a null metric reads as NaN: the folded frame is refused by checkFrame (the twin holds) until the joint is reported again', () => {
  const m = arm()
  const read = robotFromBirth(birthMetrics(m, { stamp: 1, seq: 0, q: [0.1, 0.2], qd: [0, 0], tau: [0, 0] }, 1, { aliases: true }))
  assert.ok(read && read.ok)
  const robot = read.value
  const prev: JointFrame = { stamp: 1, seq: 0, q: [0.1, 0.2], qd: [0, 0], tau: [0, 0] }
  const nulled = frameFromData(robot, { timestamp: 2, metrics: [{ alias: 2, isNull: true }] }, prev, 1, 2)
  assert.ok(Number.isNaN(nulled.frame.q[0]))
  assert.equal(nulled.frame.q[1], 0.2, 'the other joint keeps its last value')
  const refused = checkFrame(2, nulled.frame)
  assert.ok(!refused.ok && /q\[0\] is not a finite number/.test(refused.reason))
  // Report by exception: a data message without that joint keeps the NaN; one with it heals the frame.
  const still = frameFromData(robot, { timestamp: 3, metrics: [{ alias: 5, value: { kind: 'double', value: 0.3 } }] }, nulled.frame, 2, 3)
  assert.ok(Number.isNaN(still.frame.q[0]) && still.frame.q[1] === 0.3)
  const healed = frameFromData(robot, { timestamp: 4, metrics: [{ alias: 2, value: { kind: 'double', value: 0.15 } }] }, still.frame, 3, 4)
  assert.ok(checkFrame(2, healed.frame).ok)
  assert.deepEqual(healed.frame.q, [0.15, 0.3])
})
