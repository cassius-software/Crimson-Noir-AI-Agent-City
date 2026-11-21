// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the way in and the bytes underneath: createInstance and its checks, the order
 * of adapters and the checks on what a back end reports, opening a device with features, limits and queues, the
 * device's own calls and its teardown, memory (allocation against limits and heaps, map, flush, invalidate), what
 * a resource needs of memory and binding it there, and the guard every public call runs in (the report callback,
 * no TypeError escaping a call given junk, one call at a time and its latch let go whatever escapes, only objects
 * the core made taken, and each list read once).
 * What breaks if it is removed? A change could let a device open with a feature its adapter lacks, overdraw a heap,
 * bind two resources over one byte, or let an error other than a Fault escape a public call, and no test would say.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AdapterReport, Buffer, Device, Image, Limits, Memory } from './api.ts'
import { isFault } from './fault.ts'
import { CommandListImpl } from './commands.ts'
import { HEAP_DEVICE, HEAP_HOST, KIND, LIMITS, FakeBackend, adapterReport, buffer, imageView, refuses, rig, vertexLens } from './harness.test.ts'
import { createInstance } from './instance.ts'

// First in the file, while the guard's code is not yet optimised: once it is, its calls merge into fewer frames and a
// stack overflow no longer lands inside its catch, so a later place would not test what it says.
test('the latch is let go whatever escapes a call, even a stack overflow while the guard describes a refusal', () => {
  const r = rig()
  const d = r.device
  const once = (): void => {
    try {
      d.createBuffer({ size: 3, use: ['vertex'] })
    } catch {
      // Refused, or out of stack.
    }
  }
  const pad = (j: number): void => {
    if (j > 0) pad(j - 1)
    else once()
  }
  // Down to the end of the stack, then on the way back up the refusal is made from each of the last 1000 levels,
  // through 0 to 15 frames more, so it runs out of stack at every point of guard() in turn, its catch included.
  let fromBottom = 0
  const dive = (): void => {
    try {
      dive()
    } catch {
      fromBottom = 0
    }
    if (fromBottom < 1000) {
      for (let j = 0; j < 16; j++) {
        try {
          pad(j)
        } catch {
          // Out of stack.
        }
      }
    }
    fromBottom++
  }
  for (let sweep = 0; sweep < 2; sweep++) {
    dive()
    // A plain call afterwards is taken.
    d.createFence()
  }
  // So is one on a new instance.
  const other = createInstance({ backends: [new FakeBackend('other', [adapterReport()])] })
  other.open(other.adapters()[0]).createFence()
})

test('createInstance refuses malformed info, reporting each refusal to the callback', () => {
  const faults: unknown[] = []
  const report = (f: unknown): void => {
    faults.push(f)
  }
  const ok = new FakeBackend('a', [adapterReport()])
  refuses(() => createInstance(null as never), 'invalid', /the instance info is an object/)
  refuses(() => createInstance({ backends: [ok], report: 3 as never }), 'invalid', /report is a function/)
  refuses(() => createInstance({ backends: 'x' as never, report }), 'invalid', /back ends is a list/)
  refuses(() => createInstance({ backends: [{ name: 'b' }] as never, report }), 'invalid', /a back end has a name, adapters\(\) and open\(\)/)
  refuses(() => createInstance({ backends: [ok, new FakeBackend('a', [])], report }), 'invalid', /two back ends are named "a"/)
  refuses(() => createInstance({ backends: [ok], app: 7 as never, report }), 'invalid', /app is a string/)
  refuses(() => createInstance({ backends: [ok], checks: 'yes' as never, report }), 'invalid', /checks is true or false/)
  refuses(() => createInstance({ backends: [ok], extra: 1 } as never), 'invalid', /has no field "extra"/)
  // The callback hears every refusal made once it could be read: not the first two, nor the one given none.
  assert.equal(faults.length, 5)
  assert.ok(faults.every((f) => isFault(f, 'invalid')))
  const inst = createInstance({ backends: [ok] })
  assert.equal(inst.app, '')
  assert.equal(inst.checks, true)
  assert.equal(createInstance({ app: 'x', backends: [ok], checks: false }).checks, false)
})

test('adapters are ordered by kind, then back end, then report order, and are frozen copies', () => {
  const a = new FakeBackend('first', [adapterReport({ name: 'a-ref', kind: 'reference' }), adapterReport({ name: 'a-gpu', kind: 'gpu' }), adapterReport({ name: 'a-soft', kind: 'software' })])
  const b = new FakeBackend('second', [adapterReport({ name: 'b-int', kind: 'integrated' }), adapterReport({ name: 'b-gpu', kind: 'gpu' }), adapterReport({ name: 'b-gpu2', kind: 'gpu' })])
  const inst = createInstance({ backends: [a, b] })
  const list = inst.adapters()
  assert.deepEqual(list.map((x) => x.name), ['a-gpu', 'b-gpu', 'b-gpu2', 'b-int', 'a-soft', 'a-ref'])
  assert.deepEqual(list.map((x) => x.index), [0, 1, 2, 3, 4, 5])
  assert.deepEqual(list.map((x) => x.backend), ['first', 'second', 'second', 'second', 'first', 'first'])
  assert.ok(Object.isFrozen(list) && Object.isFrozen(list[0]) && Object.isFrozen(list[0].limits) && Object.isFrozen(list[0].heaps[0]))
  assert.equal(inst.adapters(), list)
  // Opening an adapter opens it at its position in its own back end's list.
  inst.open(list[0])
  inst.open(list[2])
  assert.deepEqual(a.opened.map((o) => o.adapter), [1])
  assert.deepEqual(b.opened.map((o) => o.adapter), [2])
})

test('a malformed adapter report is the back end\'s fault (code device)', () => {
  const bad = (o: Partial<AdapterReport> | Record<string, unknown>, pattern: RegExp): void => {
    refuses(() => createInstance({ backends: [new FakeBackend('x', [adapterReport(o as Partial<AdapterReport>)])] }), 'device', pattern)
  }
  bad({ name: 3 } as never, /the name is a string/)
  bad({ kind: 'cpu' } as never, /the kind "cpu" is not one of gpu, integrated, software, reference/)
  bad({ limits: { ...LIMITS, sets: 0 } }, /the limit sets 0 is not a whole number of at least 1/)
  bad({ limits: { ...LIMITS, groupSize: [1, 2] as never } }, /groupSize is three whole numbers/)
  const missing: Record<string, unknown> = { ...LIMITS }
  delete missing.updateSize
  bad({ limits: missing as never }, /the limit updateSize undefined/)
  bad({ limits: { ...LIMITS, speed: 1 } as never }, /the limits has no field "speed"/)
  bad({ features: ['warp-drive'] as never }, /the features entry "warp-drive"/)
  bad({ heaps: [{ index: 1, size: 4, local: true }] }, /heap 0: an entry is an object whose index is its position/)
  bad({ kinds: [{ index: 0, name: 'device', heap: 5, host: false }] }, /there is no heap 5/)
  bad({ kinds: [{ index: 0, name: 'upload', heap: 0, host: false }] }, /upload memory is seen by the host/)
  bad({ kinds: [{ index: 0, name: 'device', heap: 0, host: true }] }, /device memory is not seen by the host/)
  bad({ groups: [] }, /at least one queue group/)
  bad({ groups: [{ index: 0, graphics: true, compute: true, copy: true, count: 0 }] }, /the count 0 is not a whole number of at least 1/)
  const throwing = new FakeBackend('t', [])
  throwing.adapters = () => {
    throw new Error('no GPU here')
  }
  refuses(() => createInstance({ backends: [throwing] }), 'device', /the back end raised Error: no GPU here/)
})

test('open checks features, limits and queues against the adapter', () => {
  const backend = new FakeBackend('fake', [adapterReport({ features: ['float32-filter'] })])
  const faults: unknown[] = []
  const inst = createInstance({ backends: [backend], report: (f) => faults.push(f) })
  const adapter = inst.adapters()[0]
  refuses(() => inst.open({ ...adapter }), 'invalid', /not one of this instance's adapters/)
  refuses(() => inst.open(adapter, { features: ['depth-unclipped'] }), 'feature', /does not offer the feature depth-unclipped/)
  refuses(() => inst.open(adapter, { features: ['nope'] as never }), 'invalid', /features entry "nope"/)
  refuses(() => inst.open(adapter, { features: ['float32-filter', 'float32-filter'] }), 'invalid', /names float32-filter twice/)
  refuses(() => inst.open(adapter, { limits: { imageSize: 16384 } }), 'limit', /imageSize 16384 is more than the adapter allows, 8192/)
  refuses(() => inst.open(adapter, { limits: { imageSize: 0 } }), 'invalid', /imageSize 0 is not a whole number of at least 1/)
  refuses(() => inst.open(adapter, { limits: { offsetAlign: 128 } }), 'limit', /alignment offsetAlign 128 is not a multiple of the adapter's, 256/)
  refuses(() => inst.open(adapter, { limits: { copyRowAlign: 300 } }), 'limit', /copyRowAlign 300/)
  refuses(() => inst.open(adapter, { limits: { groupSize: [512, 1, 1] } }), 'limit', /groupSize x 512 is more than the adapter allows, 256/)
  refuses(() => inst.open(adapter, { limits: { warp: 1 } as never }), 'invalid', /the limits has no field "warp"/)
  refuses(() => inst.open(adapter, { queues: [{ group: 9, count: 1 }] }), 'invalid', /has no queue group 9/)
  refuses(() => inst.open(adapter, { queues: [{ group: 0, count: 3 }] }), 'limit', /queue group 0 has 2 queues, not 3/)
  refuses(() => inst.open(adapter, { queues: [{ group: 0, count: 0 }] }), 'invalid', /the count 0/)
  refuses(() => inst.open(adapter, { queues: [] }), 'invalid', /at least one queue/)
  refuses(() => inst.open(adapter, { queues: [{ group: 0, count: 1 }, { group: 0, count: 1 }] }), 'invalid', /queue group 0 is named twice/)
  refuses(() => inst.open(adapter, { label: 5 } as never), 'invalid', /the label is a string/)
  assert.equal(faults.length, 16)
  const device = inst.open(adapter, { features: ['float32-filter'], limits: { imageSize: 1024, offsetAlign: 512, groupSize: [64, 64, 64] }, label: 'main' })
  assert.equal(device.label, 'main')
  assert.deepEqual(device.features, ['float32-filter'])
  assert.equal(device.limits.imageSize, 1024)
  assert.equal(device.limits.offsetAlign, 512)
  assert.deepEqual(device.limits.groupSize, [64, 64, 64])
  assert.equal(device.limits.sets, 3)
  assert.equal(device.adapter, adapter)
  const opened = backend.opened[0]
  assert.deepEqual(opened.features, ['float32-filter'])
  assert.equal(opened.limits.imageSize, 1024)
  // The device is held to the lower limits it asked for.
  refuses(() => device.createImage({ format: 'rgba8', width: 2048, height: 4, use: ['sampled'] }), 'limit', /largest image, 1024 x 1024/)
  // Default queues: one of group 0.
  const d2 = inst.open(adapter)
  assert.equal(d2.queue(0, 0).group, 0)
  refuses(() => d2.queue(0, 1), 'invalid', /opened 1 queue of group 0, so it has no queue 1/)
  refuses(() => d2.queue(1, 0), 'invalid', /opened no queue of group 1/)
  refuses(() => d2.queue(-1, 0), 'invalid', /the group -1/)
  assert.equal(d2.queue(0, 0), d2.queue(0, 0))
})

test('a back end that raises when opening is refused with code device; a Fault it raises passes through', () => {
  const backend = new FakeBackend('fake', [adapterReport()])
  const inst = createInstance({ backends: [backend] })
  backend.open = () => {
    throw new TypeError('bad')
  }
  refuses(() => inst.open(inst.adapters()[0]), 'device', /the back end raised TypeError: bad/)
  backend.open = () => null as never
  refuses(() => inst.open(inst.adapters()[0]), 'device', /opened no device/)
})

test('allocate checks the kind, the size, the allocation limit and the heap', () => {
  const r = rig({ limits: { allocations: 3, allocationSize: HEAP_HOST } })
  const d = r.device
  refuses(() => d.allocate({ size: 256, kind: 4 }), 'invalid', /no memory kind 4; it has 4/)
  refuses(() => d.allocate({ size: 0, kind: 0 }), 'invalid', /the size 0 is not a whole number of at least 1/)
  refuses(() => d.allocate({ size: 1.5, kind: 0 }), 'invalid', /the size 1.5/)
  refuses(() => d.allocate({ size: HEAP_HOST + 4, kind: 0 }), 'limit', /largest allocation/)
  refuses(() => d.allocate({ kind: 0 } as never), 'invalid', /the size undefined/)
  refuses(() => d.allocate({ size: 4, kind: 0, flags: 1 } as never), 'invalid', /has no field "flags"/)
  const a = d.allocate({ size: HEAP_HOST - 1024, kind: KIND.upload, label: 'staging' })
  assert.equal(a.size, HEAP_HOST - 1024)
  assert.equal(a.kind.name, 'upload')
  assert.equal(a.label, 'staging')
  refuses(() => d.allocate({ size: 2048, kind: KIND.readback }), 'memory', /heap 1 has 1024 bytes left, not 2048/)
  const b = d.allocate({ size: 1024, kind: KIND.readback })
  const c = d.allocate({ size: 4, kind: KIND.device })
  refuses(() => d.allocate({ size: 4, kind: KIND.device }), 'limit', /already holds 3 allocations/)
  a.destroy()
  b.destroy()
  // Destroying frees the heap and the allocation count.
  d.allocate({ size: HEAP_HOST, kind: KIND.upload })
  c.destroy()
  assert.deepEqual(r.fake.named('allocate').map((x) => x.args), [['upload', HEAP_HOST - 1024], ['readback', 1024], ['device', 4], ['upload', HEAP_HOST]])
  assert.equal(r.fake.named('destroy').length, 3)
  refuses(() => a.destroy(), 'lifetime', /memory "staging" destroy: memory "staging" is destroyed/)
  assert.ok(HEAP_DEVICE > HEAP_HOST)
})

test('map, flush and invalidate: host kinds only, ranges inside, invalidate not while queued work writes', () => {
  const r = rig()
  const d = r.device
  const dev = d.allocate({ size: 256, kind: KIND.device })
  refuses(() => dev.map(), 'memory', /device memory, which the host cannot see/)
  refuses(() => dev.flush(), 'memory')
  refuses(() => dev.invalidate(), 'memory')
  const up = d.allocate({ size: 256, kind: KIND.upload })
  const bytes = up.map()
  assert.equal(bytes.length, 256)
  assert.equal(up.map(), bytes)
  up.flush()
  up.flush(16, 32)
  up.flush(252)
  assert.deepEqual(r.fake.named('flush').map((c) => c.args.slice(1)), [[0, 256], [16, 32], [252, 4]])
  refuses(() => up.flush(256), 'invalid', /offset 256 is not inside/)
  refuses(() => up.flush(0, 0), 'invalid', /the size 0/)
  refuses(() => up.flush(250, 8), 'invalid', /bytes 250 to 257 run past the end/)
  refuses(() => up.flush(-4), 'invalid', /the offset -4/)
  const rb = d.allocate({ size: 256, kind: KIND.readback })
  rb.invalidate(0, 128)
  assert.deepEqual(r.fake.last('invalidate').args.slice(1), [0, 128])
  refuses(() => rb.invalidate(128, 256), 'invalid')
  up.destroy()
  refuses(() => up.map(), 'lifetime', /is destroyed/)
  r.fake.lostReason = 'the GPU went away'
  refuses(() => rb.invalidate(), 'device', /the device is lost \(the GPU went away\)/)
})

test('needs gives the spec\'s size, alignment and memory kinds', () => {
  const r = rig()
  const d = r.device
  const needs = (b: Buffer | Image): readonly [number, number, readonly number[]] => {
    const n = d.needs(b)
    assert.ok(Object.isFrozen(n) && Object.isFrozen(n.kinds))
    return [n.size, n.align, n.kinds]
  }
  assert.deepEqual(needs(d.createBuffer({ size: 64, use: ['vertex'] })), [64, 4, [0]])
  assert.deepEqual(needs(d.createBuffer({ size: 64, use: ['index', 'copy-dst'] })), [64, 4, [0]])
  assert.deepEqual(needs(d.createBuffer({ size: 64, use: ['uniform'] })), [64, 256, [0]])
  assert.deepEqual(needs(d.createBuffer({ size: 64, use: ['storage', 'copy-src'] })), [64, 256, [0]])
  assert.deepEqual(needs(d.createBuffer({ size: 64, use: ['indirect'] })), [64, 256, [0]])
  assert.deepEqual(needs(d.createBuffer({ size: 64, use: ['copy-src'] })), [64, 4, [0, 2]])
  assert.deepEqual(needs(d.createBuffer({ size: 64, use: ['copy-dst'] })), [64, 4, [0, 3]])
  assert.deepEqual(needs(d.createBuffer({ size: 64, use: ['copy-src', 'copy-dst'] })), [64, 4, [0]])
  // Images: every level and layer, samples and texel bytes, rounded up to 4.
  assert.deepEqual(needs(d.createImage({ format: 'rgba8', width: 4, height: 4, use: ['sampled'] })), [64, 256, [1]])
  assert.deepEqual(needs(d.createImage({ format: 'rgba8', width: 4, height: 4, levels: 3, layers: 2, use: ['sampled'] })), [(16 + 4 + 1) * 4 * 2, 256, [1]])
  assert.deepEqual(needs(d.createImage({ format: 'r8', width: 3, height: 3, use: ['sampled'] })), [12, 256, [1]])
  assert.deepEqual(needs(d.createImage({ format: 'depth16', width: 5, height: 2, samples: 4, use: ['depth'] })), [80, 256, [1]])
  assert.deepEqual(needs(d.createImage({ format: 'rgba32f', width: 8, height: 1, levels: 4, use: ['sampled'] })), [(8 + 4 + 2 + 1) * 16, 256, [1]])
  refuses(() => d.needs({} as never), 'invalid', /the resource is a Buffer or an Image/)
})

test('bind: once, a kind the resource may use, an aligned offset inside the memory, no overlap', () => {
  const r = rig()
  const d = r.device
  const mem = d.allocate({ size: 1024, kind: KIND.device, label: 'pool' })
  const uniform = d.createBuffer({ size: 256, use: ['uniform'], label: 'u' })
  refuses(() => d.bind(uniform, mem, 4), 'invalid', /offset 4 is not a multiple of 256, the alignment buffer "u" needs/)
  refuses(() => d.bind(uniform, mem, 1024), 'invalid', /needs 256 bytes at offset 1024, past the end of memory "pool" \(1024 bytes\)/)
  refuses(() => d.bind(uniform, mem, -256), 'invalid', /the offset -256/)
  refuses(() => d.bind(uniform, {} as never, 0), 'invalid', /the memory is not a Memory/)
  refuses(() => d.bind(uniform, d.allocate({ size: 256, kind: KIND.images }), 0), 'mismatch', /cannot live in memory \d+, of kind 1 \(images\); it may live in memory kinds 0/)
  refuses(() => d.bind(uniform, d.allocate({ size: 256, kind: KIND.upload }), 0), 'mismatch', /of kind 2 \(upload\)/)
  d.bind(uniform, mem, 256)
  assert.equal(uniform.memory, mem)
  assert.equal(uniform.offset, 256)
  refuses(() => d.bind(uniform, mem, 512), 'state', /buffer "u" is already bound to memory "pool"; a resource is bound once/)
  const v = d.createBuffer({ size: 300, use: ['vertex'], label: 'v' })
  refuses(() => d.bind(v, mem, 0), 'invalid', /bytes 0 to 299 overlap buffer "u", bound at 256 to 511; resources never share memory/)
  refuses(() => d.bind(v, mem, 508), 'invalid', /overlap buffer "u"/)
  d.bind(v, mem, 512)
  const img = d.createImage({ format: 'rgba8', width: 4, height: 4, use: ['sampled'] })
  refuses(() => d.bind(img, mem, 0), 'mismatch', /may live in memory kinds 1/)
  const created = r.fake.last('createBuffer').args
  assert.deepEqual(created[0], { size: 300, use: ['vertex'], label: 'v' })
  assert.equal(created[2], 512)
  // A resource of another device is refused.
  const other = rig().device.createBuffer({ size: 4, use: ['vertex'] })
  refuses(() => d.bind(other, mem, 0), 'mismatch', /belongs to another device/)
  // Destroying a resource frees its bytes.
  uniform.destroy()
  d.bind(d.createBuffer({ size: 256, use: ['uniform'] }), mem, 256)
})

test('bind on an adapter with no memory kind for a resource says so', () => {
  const r = rig({ report: { kinds: [{ index: 0, name: 'images', heap: 0, host: false }] } })
  const b = r.device.createBuffer({ size: 4, use: ['vertex'] })
  const m = r.device.allocate({ size: 256, kind: 0 })
  refuses(() => r.device.bind(b, m, 0), 'mismatch', /it may live in no memory kind of this adapter/)
})

test('memory is destroyed only after the resources bound into it', () => {
  const r = rig()
  const d = r.device
  const mem = d.allocate({ size: 1024, kind: KIND.device })
  const b = d.createBuffer({ size: 64, use: ['vertex'], label: 'v' })
  d.bind(b, mem, 0)
  refuses(() => mem.destroy(), 'lifetime', /buffer "v" is still bound into it/)
  b.destroy()
  mem.destroy()
  assert.ok(mem.destroyed && b.destroyed)
  // An unbound resource destroys without telling the back end.
  const before = r.fake.named('destroy').length
  d.createBuffer({ size: 4, use: ['vertex'] }).destroy()
  assert.equal(r.fake.named('destroy').length, before)
})

test('the guard: every refusal is reported once, and junk never raises anything but a Fault', () => {
  const r = rig()
  const d = r.device
  const n = r.faults.length
  refuses(() => d.createBuffer({ size: 3, use: ['vertex'] }), 'invalid')
  assert.equal(r.faults.length, n + 1)
  const hostile = new Proxy({}, {
    get() {
      throw new RangeError('trap')
    },
    ownKeys() {
      throw new RangeError('trap')
    },
  })
  const calls: (() => unknown)[] = [
    () => d.createBuffer(hostile as never),
    () => d.createBuffer(undefined as never),
    () => d.createImage(hostile as never),
    () => d.allocate(7 as never),
    () => d.createView(null as never),
    () => d.createSampler(hostile as never),
    () => d.createBindingLayout({ entries: [hostile] } as never),
    () => d.createPipelineLayout({ sets: [null] } as never),
    () => d.createRenderPipeline({} as never),
    () => d.createComputePipeline(hostile as never),
    () => d.createLens(hostile as never),
    () => d.createLens({} as never),
    () => d.createCommandArena(hostile as never),
    () => d.createFence(hostile as never),
    () => d.queue(0, 0).submit(hostile as never),
    () => d.queue(0, 0).submit([hostile] as never),
    () => d.bind(null as never, null as never, null as never),
  ]
  for (const call of calls) {
    let caught: unknown = null
    try {
      call()
    } catch (e) {
      caught = e
    }
    assert.ok(isFault(caught), String(caught))
  }
  assert.equal(r.faults.length, n + 1 + calls.length)
  assert.ok(r.faults.some((f) => /reading the arguments raised a RangeError/.test(f.message)))
})

test('a report callback sees the Fault before it is thrown', () => {
  const order: string[] = []
  const backend = new FakeBackend('fake', [adapterReport()])
  const inst = createInstance({ backends: [backend], report: (f) => order.push(`report ${f.code}`) })
  const d = inst.open(inst.adapters()[0])
  try {
    d.createBuffer({ size: 0, use: ['vertex'] })
  } catch (e) {
    order.push(`caught ${isFault(e) ? e.code : '?'}`)
  }
  assert.deepEqual(order, ['report invalid', 'caught invalid'])
})

test('a back end error that is not a Fault becomes one of code device; a Fault from it passes through', () => {
  const r = rig()
  r.fake.raise = { name: 'allocate', error: new Error('out of luck') }
  refuses(() => r.device.allocate({ size: 4, kind: 0 }), 'device', /the back end raised Error: out of luck/)
  r.fake.raise = { name: 'allocate', error: 'a string' }
  refuses(() => r.device.allocate({ size: 4, kind: 0 }), 'device', /the back end raised "a string"/)
  const own = refuses(() => {
    r.fake.raise = { name: 'allocate', error: refuses(() => r.device.createBuffer({ size: 1, use: [] }), 'invalid') }
    r.device.allocate({ size: 4, kind: 0 })
  }, 'invalid')
  assert.match(own.message, /size 1 is not a multiple of 4/)
  // A refused allocation leaves the books as they were.
  r.fake.raise = { name: 'allocate', error: new Error('x') }
  refuses(() => r.device.allocate({ size: HEAP_DEVICE, kind: 0 }), 'device')
  r.device.allocate({ size: HEAP_DEVICE, kind: 0 })
})

test('a lost device refuses calls that reach the back end with code device', () => {
  const r = rig()
  assert.equal(r.device.lost(), null)
  r.fake.lostReason = 'reset'
  assert.equal(r.device.lost(), 'reset')
  refuses(() => r.device.allocate({ size: 4, kind: 0 }), 'device', /the device is lost \(reset\)/)
  refuses(() => r.device.createSampler(), 'device')
  // Calls that only read or record on the host still work.
  const b = r.device.createBuffer({ size: 4, use: ['vertex'] })
  assert.equal(b.size, 4)
})

test('device destroy frees every object, newest first and memory last, and refuses later calls', () => {
  const r = rig()
  const d: Device = r.device
  const mem: Memory = d.allocate({ size: 4096, kind: KIND.device })
  const b = d.createBuffer({ size: 64, use: ['vertex'] })
  d.bind(b, mem, 0)
  const s = d.createSampler()
  const fence = d.createFence()
  const queue = d.queue(0, 0)
  d.destroy()
  assert.ok(d.destroyed && mem.destroyed && b.destroyed && s.destroyed && fence.destroyed)
  const destroyed = r.fake.named('destroy').map((c) => (c.args[0] as { readonly kind: string }).kind)
  assert.deepEqual(destroyed, ['sampler', 'buffer', 'memory'])
  refuses(() => d.createBuffer({ size: 4, use: ['vertex'] }), 'lifetime', /device 1 createBuffer: device 1 is destroyed/)
  refuses(() => d.queue(0, 0), 'lifetime', /device 1 queue: device 1 is destroyed/)
  refuses(() => queue.submit([]), 'lifetime', /queue 0.0 submit: the device is destroyed/)
  refuses(() => b.destroy(), 'lifetime')
  refuses(() => d.destroy(), 'lifetime')
})

test('labels name objects in refusals; objects without one are named by serial number', () => {
  const r = rig()
  const b = r.device.createBuffer({ size: 4, use: ['vertex'], label: 'verts' })
  assert.equal(b.label, 'verts')
  const u = r.device.createBuffer({ size: 4, use: ['vertex'] })
  assert.equal(u.label, '')
  refuses(() => r.device.createBuffer({ size: 4, use: ['vertex'], label: 1 } as never), 'invalid', /the label is a string/)
  const m = r.device.allocate({ size: 4, kind: 0 })
  refuses(() => r.device.bind(u, m, 4), 'invalid', /^device 1 bind: buffer \d+ needs 4 bytes at offset 4, past the end of memory \d+ \(4 bytes\)$/)
  refuses(() => r.device.bind(b, m, 4), 'invalid', /buffer "verts" needs 4 bytes/)
})

test('limits a device asks for are what its calls are held to', () => {
  const asked: Partial<Limits> = { bufferSize: 1024, allocations: 1 }
  const r = rig({ limits: asked })
  refuses(() => r.device.createBuffer({ size: 2048, use: ['vertex'] }), 'limit', /largest buffer, 1024 bytes/)
  buffer(r, 1024, ['vertex'])
  refuses(() => r.device.allocate({ size: 4, kind: 0 }), 'limit')
})

test('the guard turns whatever a getter raises into a reported Fault, even a value that cannot be described', () => {
  const r = rig()
  const { proxy: revoked, revoke } = Proxy.revocable({}, {})
  revoke()
  const unnamed = new Error('x')
  Object.defineProperty(unnamed, 'name', { get() { throw new RangeError('no name') } })
  const symbolic = new Error('x')
  Object.defineProperty(symbolic, 'name', { value: Symbol('s') })
  const thrown: unknown[] = [revoked, new Proxy({}, { getPrototypeOf() { throw 'raw string' } }), unnamed, symbolic]
  for (const value of thrown) {
    const n = r.faults.length
    const fault = refuses(() => r.device.createBuffer({ get size(): number { throw value }, use: ['vertex'] } as never), 'invalid', /^device 1 createBuffer: reading the arguments raised /)
    assert.deepEqual(r.faults.slice(n), [fault])
  }
  assert.match(r.faults[r.faults.length - 1].message, /raised a value that cannot be described$/)
})

test('only objects the core made are taken: a copy or a Proxy of one is refused before any of its code runs', () => {
  const r = rig()
  const d = r.device
  const mem = d.allocate({ size: HEAP_DEVICE, kind: KIND.device, label: 'whole' })
  // A copy's destroy is refused, so it frees nothing of the real memory's books.
  refuses(() => Object.create(mem).destroy(), 'invalid', /^memory "whole" destroy: the object is a copy or wrapper of one Nightglass made, not one it made$/)
  refuses(() => d.allocate({ size: 4, kind: KIND.device }), 'memory', /heap 0 has 0 bytes left/)
  assert.equal(r.fake.named('destroy').length, 0)
  // A Proxy of a buffer is refused by bind before any of its traps runs, so nothing can land between the checks.
  const a = d.createBuffer({ size: 256, use: ['copy-dst'], label: 'a' })
  let traps = 0
  const wrapped = new Proxy(a, { get: (t, k) => { traps++; return Reflect.get(t, k) }, getPrototypeOf: (t) => { traps++; return Reflect.getPrototypeOf(t) } })
  refuses(() => d.bind(wrapped, mem, 0), 'invalid', /^device 1 bind: the resource is a Buffer or an Image, not an object$/)
  refuses(() => d.bind(Object.create(a), mem, 0), 'invalid', /the resource is a Buffer or an Image/)
  refuses(() => d.bind(a, Object.create(mem), 0), 'invalid', /the memory is not a Memory, but an object/)
  refuses(() => d.needs(wrapped), 'invalid', /the resource is a Buffer or an Image/)
  assert.equal(traps, 0)
  assert.equal(a.memory, null)
  d.bind(a, mem, 0)
  assert.equal(a.memory, mem)
  const img = d.createImage({ format: 'rgba8', width: 4, height: 4, use: ['sampled'] })
  refuses(() => d.createView(Object.create(img)), 'invalid', /the image is not an Image, but an object/)
})

test('allocate runs as one call: a label getter that allocates again cannot overdraw the heap or the allocation limit', () => {
  const r = rig({ limits: { allocations: 2 } })
  const d = r.device
  let depth = 0
  const info = (): MemoryInfoLike => ({
    size: HEAP_DEVICE,
    kind: KIND.device,
    get label() {
      if (depth < 4) {
        depth++
        d.allocate(info() as never)
      }
      return 'x'
    },
  })
  const n = r.faults.length
  refuses(() => d.allocate(info() as never), 'state', /^device 1 allocate: called from inside another Nightglass call \(device 1 allocate\)/)
  assert.equal(depth, 1)
  // The refusal is reported once, though it passed through two guards.
  assert.equal(r.faults.length, n + 1)
  assert.equal(r.fake.named('allocate').length, 0)
  d.allocate({ size: HEAP_DEVICE, kind: KIND.device })
  refuses(() => d.allocate({ size: 4, kind: KIND.device }), 'memory', /heap 0 has 0 bytes left/)
  d.allocate({ size: 4, kind: KIND.upload })
  refuses(() => d.allocate({ size: 4, kind: KIND.upload }), 'limit', /already holds 2 allocations/)
})

test('the report callback runs once the call has let go, and may call Nightglass; so does the report of a call refused inside another', () => {
  const seen: string[] = []
  const backend = new FakeBackend('fake', [adapterReport()])
  let device: Device | null = null
  const inst = createInstance({
    backends: [backend],
    report: (f) => {
      // A call from the report callback is taken: the call that failed has let go.
      seen.push(`${f.code} ${String(device?.lost())}`)
    },
  })
  device = inst.open(inst.adapters()[0])
  const d = device
  refuses(() => d.createBuffer({ size: 3, use: ['vertex'] }), 'invalid')
  assert.deepEqual(seen, ['invalid null'])
  // A getter that swallows the refusal of a call it makes: the outer call goes on, and the refusal is reported after it.
  let inner: unknown = null
  const b = d.createBuffer({
    size: 4,
    use: ['vertex'],
    get label() {
      try {
        d.createFence()
      } catch (e) {
        inner = e
      }
      return 'outer'
    },
  })
  assert.equal(b.label, 'outer')
  assert.ok(isFault(inner, 'state'))
  assert.match((inner as Error).message, /^device 1 createFence: called from inside another Nightglass call \(device 1 createBuffer\)/)
  assert.deepEqual(seen, ['invalid null', 'state null'])
})

test('the instance\'s app, a back end\'s name and an adapter\'s name are read once: the checked value is the one kept', () => {
  const reads = { app: 0, backend: 0, adapter: 0, heap: 0 }
  const base = adapterReport()
  const heap = { get index() { return ++reads.heap === 1 ? 0 : 5 }, size: base.heaps[0].size, local: true }
  const report = { ...base, heaps: [heap, base.heaps[1]], get name() { return ++reads.adapter === 1 ? 'card' : 7 } }
  const backend = new FakeBackend('fake', [report as never])
  const named = { adapters: () => backend.adapters(), open: (a: number, f: never, l: never) => backend.open(a, f, l), get name() { return ++reads.backend <= 2 ? 'mine' : 3 } }
  const inst = createInstance({ backends: [named as never], get app() { return ++reads.app === 1 ? 'tests' : 9 } } as never)
  assert.equal(inst.app, 'tests')
  const adapter = inst.adapters()[0]
  assert.deepEqual([adapter.name, adapter.backend], ['card', 'mine'])
  assert.deepEqual(adapter.heaps.map((h) => h.index), [0, 1])
  assert.deepEqual(reads, { app: 1, backend: 1, adapter: 1, heap: 1 })
})

test('a report that raises for a refusal the app caught inside a call leaves that call be: what it made is handed back', () => {
  const backend = new FakeBackend('fake', [adapterReport()])
  let rethrow = false
  const inst = createInstance({
    backends: [backend],
    report: (f) => {
      if (rethrow) throw new Error(`the app's own, for ${f.code}`)
    },
  })
  const d = inst.open(inst.adapters()[0])
  rethrow = true
  let inner: unknown = null
  const b = d.createBuffer({
    size: 256,
    use: ['vertex'],
    get label() {
      try {
        d.createFence()
      } catch (e) {
        inner = e
      }
      return 'made'
    },
  })
  // The getter had the Fault; what the report raised after the call let go goes nowhere.
  assert.ok(isFault(inner, 'state'))
  assert.equal(b.label, 'made')
  b.destroy()
  // What a report raises still replaces a Fault that comes out of the call: the inner refusal, or the call's own.
  assert.throws(() => d.createBuffer({ size: 256, use: ['vertex'], get label(): string { d.createFence(); return 'x' } }), /^Error: the app's own, for state$/)
  assert.throws(() => d.createBuffer({ size: 3, use: ['vertex'] }), /^Error: the app's own, for invalid$/)
})

test('a list is read once, its length and each entry: a Proxy cannot answer the checks one way and the use another', () => {
  // A list whose length reads `first` once and its true length after.
  const lying = <T>(items: T[], first: number): T[] => {
    let reads = 0
    return new Proxy(items, { get: (t, k, receiver) => (k === 'length' ? (++reads === 1 ? first : t.length) : Reflect.get(t, k, receiver)) })
  }
  const r = rig()
  const d = r.device
  // A use that reads as one entry, then none: the one entry read is a hole, and refused.
  refuses(() => d.createBuffer({ size: 256, use: [] }), 'invalid', /the use is empty/)
  refuses(() => d.createBuffer({ size: 256, use: lying([], 1) as never }), 'invalid', /the use entry undefined is not one of/)
  const unsized = new Proxy([], { get: (t, k, receiver) => (k === 'length' ? 'two' : Reflect.get(t, k, receiver)) })
  refuses(() => d.createBuffer({ size: 256, use: unsized as never }), 'invalid', /^device 1 createBuffer: the use has a length of "two"$/)
  // Nine vertex buffers that first read as one: one is checked, and one is what the back end is handed.
  const layout = d.createPipelineLayout({ sets: [] })
  const lens = d.createLens(vertexLens())
  const most = d.limits.vertexBuffers
  const many = [{ stride: 24, attributes: [{ slot: 0, format: 'f32x2', offset: 0 }, { slot: 1, format: 'f32x4', offset: 8 }] }, ...Array.from({ length: most }, () => ({ stride: 4, attributes: [] }))]
  refuses(() => d.createRenderPipeline({ layout, vertex: { lens, buffers: many as never } }), 'limit', new RegExp(`${most + 1} vertex buffers is more than the device allows, ${most}`))
  d.createRenderPipeline({ layout, vertex: { lens, buffers: lying(many, 1) as never } })
  const handed = r.fake.last('createRenderPipeline').args[0] as { readonly vertex: { readonly buffers: readonly unknown[] } }
  assert.equal(handed.vertex.buffers.length, 1)
  // Colour attachments past the limit that first read as one: one is recorded.
  const colors = Array.from({ length: d.limits.colorAttachments + 1 }, () => ({ view: imageView(r, { format: 'rgba8', width: 4, height: 4, use: ['color'] }), load: 'clear' as const, store: 'keep' as const }))
  const list = d.createCommandArena().allocate('l') as CommandListImpl
  list.begin()
  refuses(() => list.beginPass({ colors }), 'limit', /colour attachments is more than the device allows/)
  list.beginPass({ colors: lying(colors, 1) })
  const pass = list.commands.find((c) => c.c === 'pass') as { readonly colors: readonly unknown[] }
  assert.equal(pass.colors.length, 1)
  list.endPass()
  // A colour of two channels that reads as four, and one with holes, are refused: every channel is read.
  refuses(() => list.beginPass({ colors: [{ ...colors[0], clear: lying([0, 0], 4) as never }] }), 'invalid', /colors\[0\]: the clear colour channel 2 undefined is not a finite number/)
  list.beginPass({ colors: [colors[0]] })
  refuses(() => list.setBlendConstant(lying([1, 1], 4) as never), 'invalid', /the blend constant channel 2 undefined is not a finite number/)
  const holed: number[] = []
  holed[0] = 1
  holed[3] = 1
  refuses(() => list.setBlendConstant(holed as never), 'invalid', /the blend constant channel 1 undefined is not a finite number/)
  assert.equal(list.commands.filter((c) => c.c === 'blend-constant').length, 0)
  // A device's groupSize limit of two axes that reads as three is refused, and never reaches the back end.
  const opened = r.backend.opened.length
  refuses(() => r.instance.open(r.instance.adapters()[0], { limits: { groupSize: lying([256, 256], 3) as never } }), 'invalid', /the limit groupSize z undefined is not a whole number/)
  assert.equal(r.backend.opened.length, opened)
})

/** A memory info whose label may be a getter. */
type MemoryInfoLike = { readonly size: number; readonly kind: number; readonly label: string }
