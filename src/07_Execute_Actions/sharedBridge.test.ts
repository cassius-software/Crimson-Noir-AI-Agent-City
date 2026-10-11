// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the zero-copy bridge: the layout, the spinlock, a publish and a
 * read that round-trip every slot, a plain-buffer bridge that behaves the same, and a real worker thread writing
 * under the lock while this thread reads without ever blocking and never seeing a torn slot.
 * What breaks if it is removed? A torn read or a blocking main thread would ship unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { acquire, bridgeBytes, canShareMemory, HEADER, packAgents, packAvatars, packVehicles, PhysicsBridge, release, SLOT, READ_SPINS } from './sharedBridge.ts'
import { POSE } from './simProtocol.ts'

const COUNTS = { vehicles: 3, avatars: 2, agents: 5 }

test('the layout: a 16-word header, then one 4-word slot per vehicle, avatar and pedestrian', () => {
  assert.equal(bridgeBytes(COUNTS), 4 * (16 + 4 * 10))
  assert.equal(bridgeBytes({ vehicles: 0, avatars: 0, agents: 0 }), 64)
  assert.throws(() => bridgeBytes({ vehicles: -1, avatars: 0, agents: 0 }), RangeError)
  assert.throws(() => bridgeBytes({ vehicles: 1.5, avatars: 0, agents: 0 }), RangeError)
  const b = PhysicsBridge.create(COUNTS, true)
  assert.ok(b.shared)
  assert.equal(b.vehicles, HEADER.words)
  assert.equal(b.avatars, HEADER.words + 4 * 3)
  assert.equal(b.agents, HEADER.words + 4 * 5)
  assert.equal(b.header[HEADER.vehicles], 3)
  assert.equal(b.header[HEADER.agents], 5)
  assert.equal(b.seq, 0)
  assert.equal(b.driving(0), -1, 'nobody drives before a publish')
  assert.equal(b.f32.buffer, b.i32.buffer, 'the Float32 and Int32 views share the words')
})

test('canShareMemory asks for both SharedArrayBuffer and cross-origin isolation', () => {
  assert.equal(canShareMemory({ SharedArrayBuffer, crossOriginIsolated: true }), true)
  assert.equal(canShareMemory({ SharedArrayBuffer, crossOriginIsolated: false }), false)
  assert.equal(canShareMemory({ SharedArrayBuffer }), false)
  assert.equal(canShareMemory({ crossOriginIsolated: true }), false)
})

test('the spinlock: compareExchange takes it, a held lock refuses for every spin, store + notify frees it', () => {
  const lock = new Int32Array(new SharedArrayBuffer(64))
  assert.ok(acquire(lock, 1))
  assert.equal(lock[HEADER.lock], 1)
  assert.equal(acquire(lock, READ_SPINS), false, 'held: a reader gives up, never blocks')
  assert.equal(acquire(lock, 8, 1), false, 'held: a writer that waited 1 ms gives up too')
  release(lock)
  assert.equal(lock[HEADER.lock], 0)
  assert.ok(acquire(lock, 1))
  release(lock)
  // Over a plain buffer there is nothing to wait on: the wait is skipped, never thrown.
  const plain = new Int32Array(new ArrayBuffer(64))
  assert.ok(acquire(plain, 1))
  assert.equal(acquire(plain, 4, 5), false)
  release(plain)
})

test('open: the other side takes only a SharedArrayBuffer of the exact layout with the same counts in its header', () => {
  const b = PhysicsBridge.create(COUNTS, true)
  const other = PhysicsBridge.open(b.buffer, COUNTS)
  assert.ok(other)
  assert.equal(other!.buffer, b.buffer)
  assert.equal(PhysicsBridge.open(b.buffer, { ...COUNTS, agents: 6 }), null, 'a different size')
  const wrongHeader = new SharedArrayBuffer(bridgeBytes(COUNTS))
  assert.equal(PhysicsBridge.open(wrongHeader, COUNTS), null, 'the right size, no counts in the header')
  assert.equal(PhysicsBridge.open(new ArrayBuffer(bridgeBytes(COUNTS)), COUNTS), null, 'a plain buffer is never shared')
  assert.equal(PhysicsBridge.open(null, COUNTS), null)
  assert.equal(PhysicsBridge.open('buffer', COUNTS), null)
})

test('a publish writes every slot and the header under the lock, and a read gives them back', () => {
  const poses = new Float32Array(COUNTS.vehicles * POSE.stride)
  for (let i = 0; i < COUNTS.vehicles; i++) {
    const o = i * POSE.stride
    poses[o + POSE.x] = 10 + i; poses[o + POSE.y] = 0.5; poses[o + POSE.z] = -2 * i; poses[o + POSE.mode] = i % 3
  }
  const avatars = [{ x: 1, y: 2, z: 3, enabled: true, sensor: false }, { x: 4, y: 5, z: 6, enabled: false, sensor: true }]
  const frame = new Float32Array(COUNTS.agents * 12)
  for (let i = 0; i < COUNTS.agents; i++) { frame[4 * i] = 100 + i; frame[4 * i + 1] = 0; frame[4 * i + 2] = 200 + i; frame[4 * i + 3] = 1.5 }
  const activity = new Uint8Array([0, 1, 2, 3, 4])
  for (const shared of [true, false]) {
    const b = PhysicsBridge.create(COUNTS, shared)
    assert.equal(b.shared, shared)
    const ok = b.publish(42, 12.3456, [1, -1], (f32, i32, bridge) => {
      packVehicles(f32, i32, bridge.vehicles, poses, COUNTS.vehicles, POSE.stride, POSE.mode)
      packAvatars(f32, i32, bridge.avatars, avatars, COUNTS.avatars)
      packAgents(f32, i32, bridge.agents, frame, COUNTS.agents, activity)
    })
    assert.ok(ok)
    assert.equal(b.seq, 1)
    assert.equal(b.step, 42)
    assert.equal(b.simTime, 12.346)
    assert.equal(b.driving(0), 1)
    assert.equal(b.driving(1), -1)
    assert.equal(b.driving(2), -1, 'players not listed are on foot')
    assert.equal(b.header[HEADER.lock], 0, 'the lock is free again')
    const got = b.read((f32, i32, br) => ({
      v: Array.from({ length: COUNTS.vehicles }, (_, i) => [f32[br.vehicles + 4 * i + SLOT.x], f32[br.vehicles + 4 * i + SLOT.z] + 0, i32[br.vehicles + 4 * i + SLOT.state]]),
      a: Array.from({ length: COUNTS.avatars }, (_, k) => [f32[br.avatars + 4 * k + SLOT.x], f32[br.avatars + 4 * k + SLOT.y], i32[br.avatars + 4 * k + SLOT.state]]),
      p: Array.from({ length: COUNTS.agents }, (_, i) => [f32[br.agents + 4 * i + SLOT.x], f32[br.agents + 4 * i + SLOT.z], i32[br.agents + 4 * i + SLOT.state]]),
    }))
    assert.deepEqual(got, {
      v: [[10, 0, 0], [11, -2, 1], [12, -4, 2]],
      a: [[1, 2, 1], [4, 5, 2]],
      p: [[100, 200, 0], [101, 201, 1], [102, 202, 2], [103, 203, 3], [104, 204, 4]],
    })
    const xz = new Float32Array(2 * COUNTS.agents)
    assert.ok(b.agentXZ(xz))
    assert.deepEqual(Array.from(xz), [100, 200, 101, 201, 102, 202, 103, 203, 104, 204])
    assert.throws(() => b.agentXZ(new Float32Array(3)), RangeError)
    // A frame too short for the count writes nothing; a missing activity gives state 0.
    const b2 = PhysicsBridge.create(COUNTS, shared)
    b2.publish(1, 0, [], (f32, i32, br) => packAgents(f32, i32, br.agents, new Float32Array(4), COUNTS.agents, null))
    assert.equal(b2.f32[b2.agents], 0)
  }
})

test('a reader that finds the lock held keeps its last reading rather than blocking; a writer that cannot take it skips the step', () => {
  const b = PhysicsBridge.create(COUNTS, true)
  assert.ok(acquire(b.header, 1), 'someone else holds the lock')
  assert.equal(b.read(() => 'read'), undefined)
  assert.equal(b.agentXZ(new Float32Array(2 * COUNTS.agents)), false)
  const t0 = performance.now()
  assert.equal(b.publish(1, 0, [], () => { throw new Error('fill must not run without the lock') }), false)
  assert.ok(performance.now() - t0 < 100, 'the writer waited at most a couple of milliseconds')
  assert.equal(b.seq, 0, 'nothing was published')
  release(b.header)
  assert.equal(b.read(() => 'read'), 'read')
})

test('a fill that throws leaves the lock free', () => {
  const b = PhysicsBridge.create(COUNTS, false)
  assert.throws(() => b.publish(1, 0, [], () => { throw new Error('boom') }), /boom/)
  assert.equal(b.header[HEADER.lock], 0)
  assert.equal(b.seq, 0)
})

/**
 * A worker thread publishes as fast as it can for a while: each publish writes every slot of every section with the
 * same marker (x = y = z = state = the step), so a torn read would show two markers in one reading. This thread reads
 * meanwhile without ever blocking, and must see only whole publishes and a seq that only grows.
 */
test('a real worker writes under the lock while the main thread reads: never torn, never blocked, seq only grows', async () => {
  const counts = { vehicles: 8, avatars: 4, agents: 64 }
  const b = PhysicsBridge.create(counts, true)
  const source = `
    const { workerData, parentPort } = require('node:worker_threads')
    const { buffer, words, stride, slots, spins, waitMs, lockAt, seqAt, stepAt } = workerData
    const h = new Int32Array(buffer, 0, words), f = new Float32Array(buffer), i32 = new Int32Array(buffer)
    let step = 0, skipped = 0
    const until = Date.now() + 150
    while (Date.now() < until) {
      step++
      let got = false
      for (let i = 0; i < spins && !got; i++) got = Atomics.compareExchange(h, lockAt, 0, 1) === 0
      if (!got) { Atomics.wait(h, lockAt, 1, waitMs); got = Atomics.compareExchange(h, lockAt, 0, 1) === 0 }
      if (!got) { skipped++; continue }
      for (let s = 0, o = words; s < slots; s++, o += stride) { f[o] = step; f[o + 1] = step; f[o + 2] = step; i32[o + 3] = step }
      h[stepAt] = step
      Atomics.add(h, seqAt, 1)
      Atomics.store(h, lockAt, 0)
      Atomics.notify(h, lockAt, 1)
    }
    parentPort.postMessage({ step, skipped })
  `
  const slots = counts.vehicles + counts.avatars + counts.agents
  const worker = new Worker(source, {
    eval: true,
    workerData: { buffer: b.buffer, words: HEADER.words, stride: SLOT.stride, slots, spins: 256, waitMs: 2, lockAt: HEADER.lock, seqAt: HEADER.seq, stepAt: HEADER.step },
  })
  const done = new Promise<{ step: number; skipped: number }>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject) })
  let reads = 0, whole = 0, contended = 0, lastSeq = 0, longest = 0
  const until = Date.now() + 150
  while (Date.now() < until) {
    const t0 = performance.now()
    const r = b.read((f32, i32) => {
      const marker = f32[HEADER.words]
      for (let s = 0, o = HEADER.words; s < slots; s++, o += SLOT.stride) {
        if (f32[o] !== marker || f32[o + 1] !== marker || f32[o + 2] !== marker || i32[o + 3] !== marker) return false
      }
      return true
    })
    longest = Math.max(longest, performance.now() - t0)
    reads++
    if (r === undefined) contended++
    else if (r) whole++
    else assert.fail('a torn reading')
    const seq = b.seq
    assert.ok(seq >= lastSeq, 'seq only grows')
    lastSeq = seq
  }
  const w = await done
  await worker.terminate()
  assert.ok(w.step > 100, `the worker published ${w.step} steps`)
  assert.ok(b.seq >= w.step - w.skipped - 1, 'every publish moved seq')
  assert.ok(whole > 0, 'the main thread read whole publishes')
  assert.ok(longest < 50, `the longest read took ${longest.toFixed(2)} ms: the main thread never blocked`)
  assert.equal(reads, whole + contended)
})
