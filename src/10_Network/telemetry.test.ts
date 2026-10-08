// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the telemetry pipeline (telemetry.ts) where it must not move: the Process
 * kernel's vectors (the same numbers the hosted runtime's telemetry.rs and telemetry.wgsl pin, so edge, fog and
 * cloud agree word for word), the ledger's admission rules (a digest the fog and the edge disagree on is refused,
 * a duplicate is answered and not chained, a frame ahead of its turn waits and lands in order, a frame past the
 * window is refused), the chain's verification from genesis, and the edge's resend and desync detection.
 * What breaks if it is removed? The kernel could drift from its twins, or the ledger admit what it must refuse.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sha256 } from '../02_Define_The_Rules/integrity.ts'
import { EdgeNode, FRAME_WORDS, GENESIS, Ledger, RESEND_AFTER, VECTORS, VECTORS_CHAIN, WINDOW, chain, frame, frameDigest, link, mix32, process } from './telemetry.ts'

test('the Process kernel gives the pinned vectors, and the chain folds them to the pinned head', () => {
  for (const v of VECTORS) assert.equal(frameDigest(v.words), v.digest)
  let head = 0
  VECTORS.forEach((v, i) => { head = chain(head, v.digest, i) })
  assert.equal(head, VECTORS_CHAIN)
  assert.equal(mix32(0), 0)
  assert.throws(() => frameDigest([1, 2, 3]), RangeError)
  assert.throws(() => frame(0, 0, 0, [1]), RangeError)
})

test('a frame carries its words and the edge digest; one bit flipped changes the digest', () => {
  const f = frame(3, 9, 100, [1, 2, 3, 4, 5])
  assert.equal(f.words.length, FRAME_WORDS)
  assert.deepEqual([...f.words], [3, 9, 100, 1, 2, 3, 4, 5])
  const g = frame(3, 9, 100, [1, 2, 3, 4, 5 ^ 1])
  assert.notEqual(f.digest, g.digest)
  assert.equal(f.digest, frameDigest(f.words))
})

test('the ledger admits in order, chains with SHA-256 links and verifies from genesis', () => {
  const L = new Ledger()
  const a = frame(1, 0, 10, [1, 1, 1, 1, 1])
  const b = frame(1, 1, 11, [2, 2, 2, 2, 2])
  const [pa, pb] = process([a, b])
  const ack0 = L.admit(pa)
  assert.deepEqual(ack0, { node: 1, next: 1, head: chain(0, a.digest, 0), refused: null })
  const ack1 = L.admit(pb)
  assert.equal(ack1.next, 2)
  assert.equal(ack1.head, chain(ack0.head, b.digest, 1))
  assert.equal(L.entries.length, 2)
  assert.equal(L.entries[0].hash, link([1, 0, 10, a.digest], GENESIS))
  assert.equal(L.entries[0].hash, sha256(`[1,0,10,${a.digest}]` + GENESIS))
  assert.equal(L.entries[1].hash, link([1, 1, 11, b.digest], L.entries[0].hash))
  assert.equal(L.state(1).hash, L.entries[1].hash)
  assert.equal(L.verify(), true)
})

test('a frame the fog and the edge disagree on, or whose words do not match its digest, is refused and never chained', () => {
  const L = new Ledger()
  const a = frame(2, 0, 0, [9, 9, 9, 9, 9])
  const stale = L.admit({ frame: a, fogDigest: a.digest ^ 0x10 })
  assert.equal(stale.refused, 'digest')
  assert.equal(L.entries.length, 0)
  const forged = { ...a, digest: a.digest ^ 1 }
  assert.equal(L.admit({ frame: forged, fogDigest: forged.digest }).refused, 'digest')
  assert.equal(L.refusedDigest, 2)
  assert.equal(L.admit(process([a])[0]).refused, null)
  assert.equal(L.entries.length, 1)
})

test('a duplicate is answered with the current acknowledgement; a frame ahead waits and lands in order; past the window it is refused', () => {
  const L = new Ledger()
  const frames = Array.from({ length: 4 }, (_, i) => frame(5, i, i, [i, i, i, i, i]))
  const p = process(frames)
  assert.equal(L.admit(p[2]).next, 0, 'seq 2 waits for 0 and 1')
  assert.equal(L.admit(p[0]).next, 1)
  const ack = L.admit(p[1])
  assert.equal(ack.next, 3, 'seq 1 releases the waiting seq 2')
  assert.equal(L.entries.map((e) => e.seq).join(), '0,1,2')
  const dup = L.admit(p[0])
  assert.equal(dup.refused, 'stale')
  assert.equal(dup.next, 3)
  assert.equal(L.duplicates, 1)
  const far = frame(5, 3 + WINDOW, 0, [0, 0, 0, 0, 0])
  assert.equal(L.admit(process([far])[0]).refused, 'window')
  assert.equal(L.admit(p[3]).next, 4)
  assert.equal(L.verify(), true)
  // A tampered entry no longer verifies.
  ;(L.entries[1] as { digest: number }).digest ^= 1
  assert.equal(L.verify(), false)
})

test('the edge re-sends what is not acknowledged after RESEND_AFTER ticks, and drops what is', () => {
  const e = new EdgeNode(7)
  e.sample(0, [1, 2, 3, 4, 5])
  e.sample(0, [1, 2, 3, 4, 6])
  assert.equal(e.due(0).length, 2)
  assert.equal(e.due(1).length, 0)
  assert.equal(e.due(RESEND_AFTER).length, 2)
  assert.equal(e.resends, 2)
  const L = new Ledger()
  const [first] = process([e.due(RESEND_AFTER * 2)[0]])
  e.acknowledge(L.admit(first), RESEND_AFTER * 2)
  assert.equal(e.acked, 1)
  assert.equal(e.inFlight, 1)
  assert.equal(e.head, L.state(7).head)
  assert.equal(e.desyncs, 0)
})

test('the edge detects a head that is not its own fold (a desync) and re-sends from the acknowledged point', () => {
  const e = new EdgeNode(1)
  const f = e.sample(0, [1, 1, 1, 1, 1])
  e.due(0)
  e.acknowledge({ node: 1, next: 1, head: chain(0, f.digest, 0) ^ 1, refused: null }, 1)
  assert.equal(e.desyncs, 1)
  assert.equal(e.acked, 1)
  // An acknowledgement for another node is ignored; a window refusal re-queues everything in flight.
  e.sample(2, [2, 2, 2, 2, 2])
  e.due(2)
  e.acknowledge({ node: 9, next: 99, head: 0, refused: null }, 2)
  assert.equal(e.acked, 1)
  e.acknowledge({ node: 1, next: 1, head: 0, refused: 'window' }, 3)
  assert.equal(e.due(3).length, 1)
})
