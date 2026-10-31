// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the joint buffer (jointBridge.ts): the layout's arithmetic, a publish and a
 * snapshot round trip over shared and plain memory, open() refusing anything but a SharedArrayBuffer of the exact
 * size, the slot view's bounds, and a real worker thread publishing under the lock while this thread snapshots
 * without ever blocking or reading a torn slot.
 * What breaks if it is removed? A layout drift between the realm's writer and the page's reader goes unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { JOINT_BYTES, JOINT_FLAG, JOINT_HEADER, JOINT_SLOT, JointBuffer, MAX_LINKS, slotView } from './jointBridge.ts'
import { MAX_JOINTS, MAX_ROBOTS } from '../04_Connect_Hardware/jointState.ts'

/** A slot's words for robot `id` with `n` joints and `links` links, every number a function of `mark`. */
function slot(id: number, n: number, links: number, mark: number): Float32Array {
  const s = new Float32Array(JOINT_SLOT.words)
  s[JOINT_SLOT.id] = id
  s[JOINT_SLOT.joints] = n
  s[JOINT_SLOT.links] = links
  s[JOINT_SLOT.flags] = JOINT_FLAG.holding
  s[JOINT_SLOT.ack] = mark
  for (let k = 0; k < n; k++) { s[JOINT_SLOT.q + k] = mark + k; s[JOINT_SLOT.qd + k] = -mark; s[JOINT_SLOT.tau + k] = 0.5 * mark }
  for (let l = 0; l < links * JOINT_SLOT.poseStride; l++) s[JOINT_SLOT.poses + l] = mark * 10 + l
  return s
}

test('the layout: a 16-word header, MAX_ROBOTS slots of 424 words, 64-byte aligned', () => {
  assert.equal(JOINT_HEADER.words, 16)
  assert.equal(JOINT_SLOT.words, 8 + 3 * MAX_JOINTS + 7 * MAX_LINKS)
  assert.equal(JOINT_SLOT.words, 424)
  assert.equal(JOINT_BYTES, 4 * (16 + MAX_ROBOTS * 424))
  assert.equal(JointBuffer.slot(0), 16)
  assert.equal(JointBuffer.slot(2), 16 + 2 * 424)
  assert.ok(JOINT_SLOT.q < JOINT_SLOT.qd && JOINT_SLOT.qd < JOINT_SLOT.tau && JOINT_SLOT.tau < JOINT_SLOT.poses)
  assert.equal(JOINT_SLOT.poses + MAX_LINKS * JOINT_SLOT.poseStride, JOINT_SLOT.words)
})

test('publish copies the slots in under the lock and stamps the header; snapshot copies them out; a view reads one back', () => {
  for (const shared of [true, false]) {
    const b = JointBuffer.create(shared)
    assert.equal(b.shared, shared)
    assert.equal(b.buffer.byteLength, JOINT_BYTES)
    assert.deepEqual([b.seq, b.step, b.robots, b.simTime], [0, 0, 0, 0])
    const two = new Float32Array(2 * JOINT_SLOT.words)
    two.set(slot(7, 3, 4, 1), 0)
    two.set(slot(9, 64, 32, 2), JOINT_SLOT.words)
    assert.equal(b.publish(12, 3.456, two), true)
    assert.deepEqual([b.seq, b.step, b.robots, b.simTime], [1, 12, 2, 3.456])
    const out = new Float32Array(MAX_ROBOTS * JOINT_SLOT.words)
    assert.equal(b.snapshot(out), 2)
    const v0 = slotView(out, 0)!, v1 = slotView(out, 1)!
    assert.deepEqual([v0.id, v0.joints, v0.links, v0.flags, v0.ack], [7, 3, 4, JOINT_FLAG.holding, 1])
    assert.deepEqual([...v0.q], [1, 2, 3])
    assert.deepEqual([...v0.qd], [-1, -1, -1])
    assert.deepEqual([...v0.tau], [0.5, 0.5, 0.5])
    assert.equal(v0.poses.length, 4 * 7)
    assert.equal(v0.poses[27], 10 + 27)
    assert.deepEqual([v1.id, v1.joints, v1.links, v1.q.length, v1.poses.length], [9, 64, 32, 64, 32 * 7])
    assert.equal(slotView(out, 2), null, 'an empty slot has no view')
    assert.equal(slotView(out, MAX_ROBOTS), null)
    // Fewer robots next time: the count drops, and old words past it are not read.
    assert.equal(b.publish(13, 4, slot(5, 1, 1, 3)), true)
    assert.equal(b.robots, 1)
    assert.equal(b.snapshot(out), 1)
    assert.equal(slotView(out, 0)!.id, 5)
    assert.equal(b.publish(14, 4, null), true)
    assert.equal(b.robots, 0)
    assert.equal(b.snapshot(out), 0)
    assert.throws(() => b.snapshot(new Float32Array(8)), /snapshot needs/)
  }
})

test('open: only a SharedArrayBuffer of exactly the buffer\'s size; a plain buffer or another size is null', () => {
  assert.ok(JointBuffer.open(new SharedArrayBuffer(JOINT_BYTES)))
  assert.equal(JointBuffer.open(new SharedArrayBuffer(JOINT_BYTES + 4)), null)
  assert.equal(JointBuffer.open(new ArrayBuffer(JOINT_BYTES)), null)
  assert.equal(JointBuffer.open(null), null)
  assert.equal(JointBuffer.open({ byteLength: JOINT_BYTES }), null)
  const shared = JointBuffer.create(true)
  const other = JointBuffer.open(shared.buffer)!
  shared.publish(1, 1, slot(3, 2, 2, 4))
  assert.equal(other.robots, 1, 'the two views share the words')
})

test('a worker publishes under the lock while the main thread snapshots: never torn, never blocked, seq only grows', async () => {
  const b = JointBuffer.create(true)
  const source = `
    const { workerData, parentPort } = require('node:worker_threads')
    const { buffer, words, stride, robots, spins, waitMs, lockAt, seqAt, stepAt, robotsAt } = workerData
    const h = new Int32Array(buffer, 0, words), f = new Float32Array(buffer)
    let step = 0, skipped = 0
    const until = Date.now() + 120
    while (Date.now() < until) {
      step++
      let got = false
      for (let i = 0; i < spins && !got; i++) got = Atomics.compareExchange(h, lockAt, 0, 1) === 0
      if (!got) { Atomics.wait(h, lockAt, 1, waitMs); got = Atomics.compareExchange(h, lockAt, 0, 1) === 0 }
      if (!got) { skipped++; continue }
      for (let s = 0, o = words; s < robots; s++, o += stride) for (let k = 0; k < stride; k++) f[o + k] = step
      h[robotsAt] = robots
      h[stepAt] = step
      Atomics.add(h, seqAt, 1)
      Atomics.store(h, lockAt, 0)
      Atomics.notify(h, lockAt, 1)
    }
    parentPort.postMessage({ step, skipped })
  `
  const worker = new Worker(source, {
    eval: true,
    workerData: { buffer: b.buffer, words: JOINT_HEADER.words, stride: JOINT_SLOT.words, robots: MAX_ROBOTS, spins: 256, waitMs: 2, lockAt: JOINT_HEADER.lock, seqAt: JOINT_HEADER.seq, stepAt: JOINT_HEADER.step, robotsAt: JOINT_HEADER.robots },
  })
  let finished = false
  const done = new Promise<{ step: number; skipped: number }>((resolve, reject) => { worker.once('message', (m) => { finished = true; resolve(m) }); worker.once('error', reject) })
  const out = new Float32Array(MAX_ROBOTS * JOINT_SLOT.words)
  let whole = 0, contended = 0, lastSeq = 0, longest = 0
  // Until the worker has published its fill (it starts when the thread is up, which may take a while on a busy
  // machine), with a far deadline so a worker that never starts fails the test rather than hanging it.
  const deadline = Date.now() + 5000
  while (!finished && Date.now() < deadline) {
    await new Promise<void>((r) => setImmediate(r))
    const t0 = performance.now()
    const n = b.snapshot(out)
    longest = Math.max(longest, performance.now() - t0)
    if (n < 0) { contended++; continue }
    if (n === 0) continue
    const marker = out[0]
    for (let i = 0; i < n * JOINT_SLOT.words; i++) if (out[i] !== marker) assert.fail(`a torn snapshot at word ${i}`)
    whole++
    const seq = b.seq
    assert.ok(seq >= lastSeq, 'seq only grows')
    lastSeq = seq
  }
  const w = await done
  await worker.terminate()
  assert.ok(w.step > 50, `the worker published ${w.step} steps`)
  assert.ok(whole > 0, 'whole snapshots were read')
  assert.ok(longest < 50, `no snapshot blocked (${longest.toFixed(1)} ms; ${contended} contended)`)
})
