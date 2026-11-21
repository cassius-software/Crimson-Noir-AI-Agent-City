// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins how work reaches the device and how long it holds what it uses: a submit is
 * checked whole and changes nothing when refused; semaphores are signalled before they are waited on and taken once;
 * a fence waits on one submit and is signalled when it is done, calling back in order outside any refusal handling;
 * while work is in flight nothing it uses may be destroyed, written, reset or read back (unless checks are off); a
 * back end that refuses a submit gets it undone. It ends with the whole path, from an instance to a signalled fence.
 * What breaks if it is removed? An app could free a buffer the device is still reading, read memory before the work
 * that writes it is done, or wait on a semaphore nothing signals, with no test to say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CommandList, Fence, Semaphore } from './api.ts'
import { CommandListImpl } from './commands.ts'
import { Fault, isFault } from './fault.ts'
import { createInstance } from './instance.ts'
import type { MemoryImpl } from './memory.ts'
import { BufferImpl } from './resources.ts'
import { FenceImpl, SemaphoreImpl } from './sync.ts'
import { FakeBackend, KIND, adapterReport, buffer, computeLens, refuses, rig, texturedLens, vertexLens } from './harness.test.ts'
import type { FakeHandle } from './harness.test.ts'

/** A device and a list "l" that dispatches over a storage buffer and copies it into readback memory. */
function work(o: Parameters<typeof rig>[0] = {}) {
  const r = rig(o)
  const arena = r.device.createCommandArena({ label: 'frames' })
  const list = arena.allocate('l') as CommandListImpl
  const setLayout = r.device.createBindingLayout({ entries: [{ binding: 0, kind: 'storage', stages: ['compute'] }] })
  const layout = r.device.createPipelineLayout({ sets: [setLayout] })
  const pipeline = r.device.createComputePipeline({ layout, lens: r.device.createLens(computeLens()) })
  const data = buffer(r, 1024, ['storage', 'copy-src'])
  const readback = r.device.allocate({ size: 4096, kind: KIND.readback, label: 'readback' })
  const out = r.device.createBuffer({ size: 1024, use: ['copy-dst'] })
  r.device.bind(out, readback, 1024)
  const pool = r.device.createBindingPool({ sets: 4 })
  const set = pool.allocate(setLayout, 's')
  set.write([{ binding: 0, buffer: data }])
  list.begin()
  // The list runs again and again: everything its last run did is ordered before this run starts.
  list.barrier({ memory: [{ before: { stages: ['all'], access: ['any-write'] }, after: { stages: ['all'], access: ['any-read', 'any-write'] } }] })
  list.bindPipeline(pipeline)
  list.bindSets(layout, 0, [set])
  list.dispatch(4)
  list.barrier({ buffers: [{ before: { stages: ['compute'], access: ['shader-write'] }, after: { stages: ['copy'], access: ['copy-read'] }, buffer: data }] })
  list.copyBuffer(data, out, [{ from: 0, to: 0, size: 1024 }])
  list.barrier({ buffers: [{ before: { stages: ['copy'], access: ['copy-write'] }, after: { stages: ['host'], access: ['host-read'] }, buffer: out }] })
  list.end()
  return { r, arena, list, setLayout, layout, pipeline, data, readback, out, pool, set, queue: r.device.queue(0, 0), fence: r.device.createFence({ label: 'f' }) }
}

/** Another ready list on the same arena group, copying within its own buffer. */
function copyList(r: ReturnType<typeof rig>, group = 0, label?: string): CommandList {
  const list = r.device.createCommandArena({ group }).allocate(label)
  const b = buffer(r, 64, ['copy-src', 'copy-dst'])
  list.begin()
  list.copyBuffer(b, b, [{ from: 0, to: 32, size: 32 }])
  list.end()
  return list
}

const waiting = (f: Fence): boolean => (f as FenceImpl).waiting

test('a submit is checked whole: each list ready, once, of the queue\'s group, of this device', () => {
  const { r, list, queue, fence } = work()
  const faults = r.faults.length
  refuses(() => queue.submit('all' as never), 'invalid', /^queue 0\.0 submit: the submissions is a list, not "all"$/)
  refuses(() => queue.submit([{ lists: [list], priority: 1 }] as never), 'invalid', /submissions\[0\]: the submission has no field "priority"/)
  refuses(() => queue.submit([{}] as never), 'invalid', /submissions\[0\]: the lists is a list, not undefined/)
  refuses(() => queue.submit([{ lists: [{}] }] as never), 'invalid', /submissions\[0\] lists\[0\]: the list is not a CommandList, but an object/)
  const fresh = r.device.createCommandArena().allocate('fresh')
  refuses(() => queue.submit([{ lists: [fresh] }]), 'state', /submissions\[0\] lists\[0\]: command list "fresh" is initial, not ready/)
  fresh.begin()
  refuses(() => queue.submit([{ lists: [list, fresh] }]), 'state', /lists\[1\]: command list "fresh" is recording, not ready/)
  refuses(() => queue.submit([{ lists: [list, list] }]), 'state', /lists\[1\]: command list "l" is submitted twice/)
  refuses(() => queue.submit([{ lists: [list] }, { lists: [list] }]), 'state', /submissions\[1\] lists\[0\]: command list "l" is submitted twice/)
  const copier = copyList(r, 1, 'copier')
  refuses(() => queue.submit([{ lists: [copier] }]), 'mismatch', /command list "copier" was recorded for queue group 1, and this queue is of group 0/)
  refuses(() => r.device.queue(1, 0).submit([{ lists: [list] }]), 'mismatch', /^queue 1\.0 submit: .*command list "l" was recorded for queue group 0, and this queue is of group 1/)
  refuses(() => queue.submit([{ lists: [copyList(rig())] }]), 'mismatch', /belongs to another device/)
  refuses(() => queue.submit([{ lists: [list] }], {} as never), 'invalid', /the fence is not a Fence, but an object/)
  refuses(() => queue.submit([{ lists: [list] }], r.device.createFence({ signalled: true, label: 'up' })), 'state', /fence "up" is signalled; reset it first/)
  assert.equal(r.faults.length, faults + 13)
  // Nothing changed.
  assert.equal(r.fake.named('submit').length, 0)
  assert.deepEqual([list.state, list.pending, fence.signalled, waiting(fence)], ['ready', 0, false, false])
  queue.submit([{ lists: [list] }], fence)
  assert.deepEqual(r.fake.last('submit').args, [[list.commands]])
  assert.deepEqual([list.state, list.pending, fence.signalled, waiting(fence)], ['ready', 0, true, false])
  // A copy-only queue takes the lists of its group; an empty submit still signals its fence.
  r.device.queue(1, 0).submit([{ lists: [copier] }])
  const empty = r.device.createFence()
  queue.submit([], empty)
  assert.equal(empty.signalled, true)
  assert.deepEqual(r.fake.last('submit').args, [[]])
})

test('a list named twice is found through a set, so a submit of many lists costs about their number to check', () => {
  const r = rig()
  const arena = r.device.createCommandArena()
  // 80,000 empty lists: asking every list whether it was named before took about 3.2 billion steps (seconds).
  const lists = Array.from({ length: 80000 }, () => {
    const l = arena.allocate()
    l.begin()
    l.end()
    return l
  })
  const queue = r.device.queue(0, 0)
  refuses(() => queue.submit([{ lists: lists.slice(0, 40000) }, { lists: [...lists.slice(40000), lists[39999]] }]), 'state', /^queue 0\.0 submit: submissions\[1\] lists\[40000\]: command list \d+ is submitted twice$/)
  assert.equal(r.fake.named('submit').length, 0)
  queue.submit([{ lists: lists.slice(0, 40000) }, { lists: lists.slice(40000) }])
  assert.equal((r.fake.last('submit').args[0] as unknown[]).length, 80000)
  assert.ok(lists.every((l) => l.state === 'ready'))
})

test('a stale list is refused: lifetime when what it recorded is destroyed, state when a set it recorded is written; a once list runs once', () => {
  const { r, list, queue, set, data, arena } = work()
  set.write([{ binding: 0, buffer: data, size: 512 }])
  refuses(() => queue.submit([{ lists: [list] }]), 'state', /lists\[0\]: binding set "s" was written after command list "l" recorded it; record the list again/)
  const other = copyList(r, 0, 'other')
  const first = (other as CommandListImpl).records[0]
  assert.ok(first.r === 'copy-buffer')
  first.dst.destroy()
  refuses(() => queue.submit([{ lists: [other] }]), 'lifetime', /lists\[0\]: buffer \d+, which command list "other" recorded, is destroyed; record the list again/)
  const once = arena.allocate('once')
  const b = buffer(r, 64, ['copy-src', 'copy-dst'])
  // Each zero writes over the last one, so it waits for it.
  const rewrite = { buffers: [{ before: { stages: ['copy'], access: ['copy-write'] }, after: { stages: ['copy'], access: ['copy-write'] }, buffer: b }] } as const
  once.begin({ once: true })
  once.zeroBuffer(b, 0, 64)
  once.end()
  queue.submit([{ lists: [once] }])
  assert.equal(once.state, 'invalid')
  assert.equal((once as CommandListImpl).stale(), null)
  refuses(() => queue.submit([{ lists: [once] }]), 'state', /command list "once" ran once and must be reset and recorded again/)
  once.reset()
  once.begin({ once: true })
  once.barrier(rewrite)
  once.zeroBuffer(b, 0, 64)
  once.end()
  queue.submit([{ lists: [once] }])
  // A list that is not `once` runs as often as it is submitted.
  const again = arena.allocate()
  again.begin()
  again.barrier(rewrite)
  again.zeroBuffer(b, 0, 64)
  again.end()
  queue.submit([{ lists: [again] }])
  queue.submit([{ lists: [again] }, { lists: [copyList(r)] }])
  assert.equal(again.state, 'ready')
})

test('while work is in flight, what it uses cannot be destroyed, written, reset or read back', () => {
  const w = work()
  const { r, list, arena, queue, fence, data, out, readback, set, pool, pipeline, layout } = w
  r.fake.auto = false
  queue.submit([{ lists: [list] }], fence)
  assert.deepEqual([list.state, waiting(fence), fence.signalled], ['pending', true, false])
  assert.deepEqual([(data as BufferImpl).pending, (out as BufferImpl).pending, (readback as MemoryImpl).writers], [1, 1, 1])
  refuses(() => queue.submit([{ lists: [list] }]), 'state', /command list "l" is pending, not ready/)
  refuses(() => queue.submit([{ lists: [copyList(r)] }], fence), 'state', /fence "f" already waits on submitted work/)
  refuses(() => list.reset(), 'state', /command list "l" reset: the list is pending; reset it once its work is done/)
  refuses(() => arena.reset(), 'state', /command arena "frames" reset: command list "l" is pending; reset the arena once its work is done/)
  refuses(() => arena.destroy(), 'lifetime', /queued work still runs command list "l"; wait for its fence first/)
  refuses(() => list.destroy(), 'lifetime', /command list "l" destroy: queued work still uses it; wait for its fence first/)
  refuses(() => data.destroy(), 'lifetime', /buffer \d+ destroy: queued work still uses it/)
  refuses(() => pipeline.destroy(), 'lifetime', /queued work still uses it/)
  refuses(() => set.write([{ binding: 0, buffer: data }]), 'lifetime', /binding set "s" write: queued work still uses binding set "s"; wait for its fence before writing it/)
  refuses(() => pool.reset(), 'lifetime', /queued work still uses binding set "s"; wait for its fence first/)
  refuses(() => pool.destroy(), 'lifetime', /queued work still uses binding set "s"/)
  refuses(() => readback.invalidate(), 'hazard', /memory "readback" invalidate: queued work still writes into memory "readback"; invalidate once its fence is signalled/)
  refuses(() => r.device.destroy(), 'lifetime', /submitted work is still in flight; wait for its fences first/)
  refuses(() => fence.reset(), 'state', /fence "f" reset: the fence waits on submitted work/)
  refuses(() => fence.destroy(), 'lifetime', /fence "f" destroy: queued work still uses it/)
  // What the work does not use is free to go (a pipeline layout is read only when recording); host memory still flushes.
  buffer(r, 64, ['vertex']).destroy()
  layout.destroy()
  readback.flush()
  const calls: string[] = []
  fence.onSignal(() => calls.push('first'))
  fence.onSignal(() => calls.push('second'))
  const done = r.fake.waiting[0]
  r.fake.finish()
  assert.deepEqual(calls, ['first', 'second'])
  assert.deepEqual([list.state, waiting(fence), fence.signalled], ['ready', false, true])
  assert.deepEqual([(data as BufferImpl).pending, (out as BufferImpl).pending, (readback as MemoryImpl).writers, list.pending], [0, 0, 0, 0])
  // done a second time does nothing.
  done()
  assert.deepEqual([(data as BufferImpl).pending, list.pending, calls.length], [0, 0, 2])
  readback.invalidate()
  set.write([{ binding: 0, buffer: data }])
  assert.equal(list.state, 'invalid')
  list.reset()
  arena.reset()
  pool.reset()
  fence.reset()
  assert.equal(fence.signalled, false)
  r.device.destroy()
  assert.equal(data.destroyed, true)
})

test('semaphores: signalled before they are waited on, each signal taken by one wait; the back end gets the lists in order', () => {
  const r = rig()
  const queue = r.device.queue(0, 0)
  const other = r.device.queue(0, 1)
  const s = r.device.createSemaphore({ label: 's' })
  const t = r.device.createSemaphore({ label: 't' })
  const [a, b, c] = [copyList(r, 0, 'a'), copyList(r, 0, 'b'), copyList(r, 0, 'c')]
  const wait = (sem: Semaphore): { readonly semaphore: Semaphore; readonly stages: readonly ['copy'] } => ({ semaphore: sem, stages: ['copy'] })
  refuses(() => queue.submit([{ lists: [a], wait: [wait(s)] }]), 'state', /submissions\[0\] wait\[0\]: no earlier submission signals semaphore "s" that a wait has not already taken/)
  refuses(() => queue.submit([{ lists: [a], wait: [wait(s)], signal: [s] }]), 'state', /no earlier submission signals semaphore "s"/)
  refuses(() => queue.submit([{ lists: [a], signal: [s] }, { lists: [b], signal: [s] }]), 'state', /submissions\[1\] signal\[0\]: semaphore "s" is already signalled and no wait has taken that signal/)
  refuses(() => queue.submit([{ lists: [a], wait: [{ semaphore: s, stages: [] }] }]), 'invalid', /wait\[0\]: the stages is empty/)
  refuses(() => queue.submit([{ lists: [a], wait: [{ semaphore: s, stages: ['raster'] }] }] as never), 'invalid', /the stages entry "raster"/)
  refuses(() => queue.submit([{ lists: [a], wait: [{ semaphore: {}, stages: ['copy'] }] }] as never), 'invalid', /the semaphore is not a Semaphore/)
  refuses(() => queue.submit([{ lists: [a], signal: [rig().device.createSemaphore()] }]), 'mismatch', /belongs to another device/)
  // A refused submit leaves every semaphore as it was.
  refuses(() => queue.submit([{ lists: [a], signal: [s] }, { lists: [b], wait: [wait(t)] }]), 'state', /semaphore "t"/)
  assert.equal((s as SemaphoreImpl).armed, false)
  queue.submit([{ lists: [a], signal: [s] }, { lists: [b], wait: [wait(s)], signal: [t] }, { lists: [c], wait: [wait(t)] }])
  assert.deepEqual(r.fake.last('submit').args, [[a, b, c].map((l) => (l as CommandListImpl).commands)])
  assert.deepEqual([(s as SemaphoreImpl).armed, (t as SemaphoreImpl).armed], [false, false])
  // A signal in one submit is taken by a wait in a later one, on any queue, once.
  queue.submit([{ lists: [a], signal: [s] }])
  assert.equal((s as SemaphoreImpl).armed, true)
  refuses(() => queue.submit([{ lists: [b], signal: [s] }]), 'state', /is already signalled/)
  other.submit([{ lists: [b], wait: [wait(s)] }])
  refuses(() => other.submit([{ lists: [c], wait: [wait(s)] }]), 'state', /no earlier submission signals semaphore "s"/)
  // A submission with no lists may still signal and wait.
  queue.submit([{ lists: [], signal: [s] }, { lists: [], wait: [wait(s)] }])
  // A semaphore held by work in flight is not destroyed.
  r.fake.auto = false
  queue.submit([{ lists: [a], signal: [s] }])
  refuses(() => s.destroy(), 'lifetime', /semaphore "s" destroy: queued work still uses it/)
  r.fake.finish()
  queue.submit([{ lists: [b], wait: [wait(s)] }])
  r.fake.finish()
  s.destroy()
  refuses(() => queue.submit([{ lists: [a], signal: [s] }]), 'lifetime', /semaphore "s" is destroyed/)
})

test('a back end that refuses a submit gets it undone; a back end Fault passes through; a lost or destroyed device takes no work', () => {
  const { r, list, queue, fence, data } = work()
  const s = r.device.createSemaphore()
  r.fake.raise = { name: 'submit', error: new Error('gpu gone') }
  refuses(() => queue.submit([{ lists: [list], signal: [s] }], fence), 'device', /^queue 0\.0 submit: the back end raised Error: gpu gone$/)
  assert.deepEqual([list.state, list.pending, (data as BufferImpl).pending, waiting(fence), fence.signalled, (s as SemaphoreImpl).armed, (s as SemaphoreImpl).pending], ['ready', 0, 0, false, false, false, 0])
  const own = new Fault('memory', 'the back end ran out of memory')
  r.fake.raise = { name: 'submit', error: own }
  const caught = refuses(() => queue.submit([{ lists: [list] }], fence), 'memory')
  assert.equal(caught, own)
  assert.equal(r.faults[r.faults.length - 1], own)
  // The device can still be destroyed: nothing is in flight.
  queue.submit([{ lists: [list], signal: [s] }], fence)
  assert.equal(fence.signalled, true)
  r.fake.lostReason = 'reset by the driver'
  refuses(() => queue.submit([{ lists: [list] }]), 'device', /queue 0\.0 submit: the device is lost \(reset by the driver\)/)
  r.fake.lostReason = null
  r.device.destroy()
  refuses(() => queue.submit([{ lists: [list] }]), 'lifetime', /queue 0\.0 submit: the device is destroyed/)
})

test('fence callbacks run in order once the work is done, outside any refusal handling', () => {
  const { r, list, queue, fence } = work()
  refuses(() => fence.onSignal('soon' as never), 'invalid', /fence "f" onSignal: the callback is a function, not "soon"/)
  const calls: string[] = []
  fence.onSignal(() => calls.push('a'))
  fence.onSignal(() => {
    calls.push('b')
    throw new Error('the app\'s own')
  })
  fence.onSignal(() => calls.push('c'))
  const faults = r.faults.length
  // The back end finishes inside submit; the callbacks run after it returns, and what one raises is the app's.
  let raised: unknown = null
  try {
    queue.submit([{ lists: [list] }], fence)
  } catch (e) {
    raised = e
  }
  assert.ok(raised instanceof Error && !isFault(raised) && raised.message === 'the app\'s own')
  assert.deepEqual(calls, ['a', 'b'])
  assert.equal(r.faults.length, faults)
  assert.deepEqual([list.state, fence.signalled], ['ready', true])
  // A callback added to a signalled fence runs at once, and its error is its own as well.
  fence.onSignal(() => calls.push('now'))
  assert.deepEqual(calls, ['a', 'b', 'now'])
  assert.throws(() => fence.onSignal(() => { throw new RangeError('mine') }), RangeError)
  // Callbacks are taken once: a reset fence signalled again calls only what was added since.
  fence.reset()
  r.fake.auto = false
  fence.onSignal(() => calls.push('later'))
  queue.submit([{ lists: [list] }], fence)
  assert.deepEqual(calls, ['a', 'b', 'now'])
  r.fake.finish()
  assert.deepEqual(calls, ['a', 'b', 'now', 'later'])
  // A fence destroyed with callbacks waiting never calls them.
  const lone = r.device.createFence()
  lone.onSignal(() => calls.push('never'))
  lone.destroy()
  refuses(() => lone.onSignal(() => calls.push('never')), 'lifetime', /fence \d+ is destroyed/)
  refuses(() => queue.submit([{ lists: [list] }], lone), 'lifetime', /fence \d+ is destroyed/)
  assert.equal(calls.includes('never'), false)
  refuses(() => r.device.createFence({ signalled: 'yes' } as never), 'invalid', /signalled is true or false/)
})

test('with checks off, work in flight no longer guards what it uses; staleness and list states are still checked', () => {
  const { r, list, arena, queue, fence, data, readback, set, pool } = work({ checks: false })
  r.fake.auto = false
  queue.submit([{ lists: [list] }], fence)
  refuses(() => list.reset(), 'state', /the list is pending/)
  refuses(() => arena.reset(), 'state', /is pending/)
  refuses(() => fence.reset(), 'state', /waits on submitted work/)
  refuses(() => queue.submit([{ lists: [list] }]), 'state', /is pending, not ready/)
  readback.invalidate()
  set.write([{ binding: 0, buffer: data }])
  pool.reset()
  assert.equal(set.destroyed, true)
  data.destroy()
  r.device.destroy()
  r.fake.finish()
  assert.equal(fence.signalled, true)
  // Even unchecked, a list that recorded what was destroyed is not run again.
  const r2 = rig({ checks: false })
  const other = copyList(r2, 0, 'other')
  const rec = (other as CommandListImpl).records[0]
  assert.ok(rec.r === 'copy-buffer')
  rec.src.destroy()
  refuses(() => r2.device.queue(0, 0).submit([{ lists: [other] }]), 'lifetime', /record the list again/)
})

test('the whole path: an instance, a device, memory, resources, a pipeline, a recorded list, a submit and a signalled fence', () => {
  const backend = new FakeBackend('fake', [adapterReport()])
  const faults: Fault[] = []
  const instance = createInstance({ app: 'path', backends: [backend], report: (f) => faults.push(f) })
  const [adapter] = instance.adapters()
  const device = instance.open(adapter, { features: ['float32-filter'], queues: [{ group: 0, count: 1 }] })
  const fake = backend.opened[0].device
  // Memory: device-local for the buffers and images the GPU reads, host memory to upload into and read back from.
  const local = device.allocate({ size: 1 << 20, kind: KIND.device, label: 'local' })
  const images = device.allocate({ size: 1 << 20, kind: KIND.images, label: 'images' })
  const upload = device.allocate({ size: 1 << 16, kind: KIND.upload, label: 'upload' })
  const readback = device.allocate({ size: 1 << 16, kind: KIND.readback, label: 'readback' })
  const place = (res: Parameters<typeof device.bind>[0], memory: Parameters<typeof device.bind>[1], offset: number): void => {
    const n = device.needs(res)
    assert.ok(n.kinds.includes(memory.kind.index) && offset % n.align === 0)
    device.bind(res, memory, offset)
  }
  const vertices = device.createBuffer({ size: 72, use: ['vertex', 'copy-dst'], label: 'vertices' })
  place(vertices, local, 0)
  const uniforms = device.createBuffer({ size: 256, use: ['uniform', 'copy-dst'], label: 'uniforms' })
  place(uniforms, local, 256)
  const staging = device.createBuffer({ size: 4096, use: ['copy-src'], label: 'staging' })
  place(staging, upload, 0)
  const result = device.createBuffer({ size: 64 * 32 * 4, use: ['copy-dst'], label: 'result' })
  place(result, readback, 0)
  const texture = device.createImage({ format: 'rgba8', width: 4, height: 4, use: ['sampled', 'copy-dst'], label: 'texture' })
  place(texture, images, 0)
  const canvas = device.createImage({ format: 'rgba8', width: 64, height: 32, use: ['color', 'copy-src'], label: 'canvas' })
  place(canvas, images, 256 * 1024)
  // Fill the staging buffer on the host: three vertices, a tint and a 4 x 4 texture.
  const bytes = upload.map()
  new Float32Array(bytes.buffer, 0, 18).set([-1, -1, 1, 0, 0, 1, 3, -1, 0, 1, 0, 1, -1, 3, 0, 0, 1, 1])
  new Float32Array(bytes.buffer, 256, 4).set([1, 1, 1, 1])
  bytes.fill(255, 512, 512 + 64)
  upload.flush(0, 1024)
  // Shaders, layouts and the pipeline.
  const setLayout = device.createBindingLayout({
    entries: [{ binding: 0, kind: 'uniform', stages: ['fragment'] }, { binding: 1, kind: 'image', stages: ['fragment'] }, { binding: 2, kind: 'sampler', stages: ['fragment'] }],
  })
  const layout = device.createPipelineLayout({ sets: [setLayout] })
  const pipeline = device.createRenderPipeline({
    layout,
    vertex: { lens: device.createLens(vertexLens(), 'vertex'), buffers: [{ stride: 24, attributes: [{ slot: 0, format: 'f32x2', offset: 0 }, { slot: 1, format: 'f32x4', offset: 8 }] }] },
    fragment: { lens: device.createLens(texturedLens(), 'textured'), outputs: [{ format: 'rgba8' }] },
    label: 'draw',
  })
  const set = device.createBindingPool({ sets: 1 }).allocate(setLayout, 'material')
  set.write([{ binding: 0, buffer: uniforms, size: 16 }, { binding: 1, view: device.createView(texture) }, { binding: 2, sampler: device.createSampler({ mag: 'linear', min: 'linear' }) }])
  const view = device.createView(canvas, { label: 'canvas view' })
  // Record: upload, move the texture to shader-read, draw, copy the canvas out, hand it to the host.
  const list = device.createCommandArena().allocate('frame')
  const copyIn = { before: { stages: ['copy'], access: ['copy-write'] }, after: { stages: ['vertex-input', 'fragment'], access: ['vertex-read', 'uniform-read'] } } as const
  list.begin({ once: true })
  list.beginGroup('upload')
  list.barrier({ images: [{ before: { stages: ['top'] }, after: { stages: ['copy'], access: ['copy-write'] }, image: texture, from: 'blank', to: 'copy-dst' }] })
  list.copyBuffer(staging, vertices, [{ from: 0, to: 0, size: 72 }])
  list.copyBuffer(staging, uniforms, [{ from: 256, to: 0, size: 16 }])
  list.copyBufferToImage(staging, texture, [{ offset: 512, rowBytes: 256, region: { width: 4, height: 4 } }])
  list.barrier({
    buffers: [{ ...copyIn, buffer: vertices }, { ...copyIn, buffer: uniforms }],
    images: [
      { before: { stages: ['copy'], access: ['copy-write'] }, after: { stages: ['fragment'], access: ['shader-read'] }, image: texture, from: 'copy-dst', to: 'shader-read' },
      { before: { stages: ['top'] }, after: { stages: ['color'], access: ['color-write'] }, image: canvas, from: 'blank', to: 'color' },
    ],
  })
  list.endGroup()
  list.beginPass({ colors: [{ view, load: 'clear', store: 'keep', clear: [0, 0, 0, 1] }], label: 'main' })
  list.bindPipeline(pipeline)
  list.bindSets(layout, 0, [set])
  list.bindVertices(0, [{ buffer: vertices }])
  list.setViewport({ x: 0, y: 0, width: 64, height: 32 })
  list.draw(3)
  list.endPass()
  list.barrier({ images: [{ before: { stages: ['color'], access: ['color-write'] }, after: { stages: ['copy'], access: ['copy-read'] }, image: canvas, from: 'color', to: 'copy-src' }] })
  list.copyImageToBuffer(canvas, result, [{ offset: 0, rowBytes: 256, region: { width: 64, height: 32 } }])
  list.barrier({ buffers: [{ before: { stages: ['copy'], access: ['copy-write'] }, after: { stages: ['host'], access: ['host-read'] }, buffer: result }] })
  list.end()
  assert.deepEqual(list.state, 'ready')
  const impl = list as CommandListImpl
  assert.deepEqual(impl.records.map((x) => x.r), ['barrier', 'copy-buffer', 'copy-buffer', 'copy-buffer-image', 'barrier', 'pass', 'draw', 'end-pass', 'barrier', 'copy-image-buffer', 'barrier'])
  const drawn = impl.records[6]
  assert.ok(drawn.r === 'draw')
  assert.deepEqual(drawn.sets.map((s) => [s.index, s.set, s.bindings.length]), [[0, set, 3]])
  // Submit with a fence and read the result back once it is signalled.
  fake.auto = false
  const fence = device.createFence({ label: 'frame done' })
  const seen: number[] = []
  fence.onSignal(() => {
    readback.invalidate()
    seen.push(readback.map().length)
  })
  device.queue(0, 0).submit([{ lists: [list] }], fence)
  assert.deepEqual([list.state, fence.signalled, seen], ['pending', false, []])
  refuses(() => readback.invalidate(), 'hazard')
  fake.finish()
  assert.deepEqual([list.state, fence.signalled, seen], ['invalid', true, [1 << 16]])
  const submitted = fake.last('submit').args[0] as readonly (readonly { readonly c: string }[])[]
  assert.deepEqual(submitted[0].map((c) => c.c), [
    'group', 'barrier', 'copy-buffer', 'copy-buffer', 'copy-buffer-image', 'barrier', 'end-group',
    'pass', 'pipeline', 'sets', 'vertices', 'viewport', 'draw', 'end-pass', 'barrier', 'copy-image-buffer', 'barrier',
  ])
  assert.deepEqual(fake.last('invalidate').args.slice(1), [0, 1 << 16])
  // The device's destroy frees every back end object it made, each once.
  const made = fake.calls.filter((c) => c.call.startsWith('create') || c.call === 'allocate').length
  device.destroy()
  const freed = fake.named('destroy').map((c) => (c.args[0] as FakeHandle).n)
  assert.equal(freed.length, made)
  assert.equal(new Set(freed).size, made)
  assert.deepEqual(faults.map((f) => f.code), ['hazard'])
  assert.ok(isFault(faults[0], 'hazard'))
})
