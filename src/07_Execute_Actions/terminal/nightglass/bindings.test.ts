// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins every rule of binding layouts, pipeline layouts, pools and set writes: entry
 * fields and their defaults, the per-stage and dynamic limits over one layout and over a pipeline layout, the
 * compatibility of two layouts, a pool's capacity and reset, and each write against its entry (kind, use, range and
 * alignment, view shape and sample kind, filtering, storage-image format, sampler filters), with the back end told of
 * a set's bindings only once the set is complete.
 * What breaks if it is removed? A shader could be handed a buffer past its end or an image of the wrong kind, and a
 * layout past the device's limits could reach a back end, with no test to say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BindingEntry, BindingLayout, BoundEntry } from './api.ts'
import { BindingLayoutImpl, BindingSetImpl, compatible } from './bindings.ts'
import { KIND, buffer, imageView, refuses, rig } from './harness.test.ts'
import type { FakeHandle, Rig } from './harness.test.ts'

const layout = (r: Rig, entries: readonly BindingEntry[]): BindingLayout => r.device.createBindingLayout({ entries })

test('binding layout entries: binding numbers, kinds, stages, and fields that belong to other kinds', () => {
  const r = rig()
  const bad = (e: unknown, code: 'invalid' | 'limit', pattern: RegExp): void => {
    refuses(() => r.device.createBindingLayout({ entries: [e as BindingEntry] }), code, pattern)
  }
  bad({ binding: 16, kind: 'uniform', stages: ['vertex'] }, 'limit', /binding 16 is past the device's highest, 15/)
  bad({ binding: -1, kind: 'uniform', stages: ['vertex'] }, 'invalid', /entries\[0\]: the binding -1/)
  bad({ binding: 0, kind: 'texture', stages: ['vertex'] }, 'invalid', /the kind "texture" is not one of uniform, storage, storage-read, image, sampler, storage-image/)
  bad({ binding: 0, kind: 'uniform', stages: [] }, 'invalid', /the stages is empty/)
  bad({ binding: 0, kind: 'uniform', stages: ['geometry'] }, 'invalid', /the stages entry "geometry"/)
  bad({ binding: 0, kind: 'uniform', stages: ['vertex', 'vertex'] }, 'invalid', /names vertex twice/)
  bad({ binding: 0, kind: 'image', stages: ['fragment'], dynamic: true }, 'invalid', /dynamic belongs to uniform and storage and storage-read entries, not to an image entry/)
  bad({ binding: 0, kind: 'uniform', stages: ['fragment'], sample: 'float' }, 'invalid', /sample belongs to image entries/)
  bad({ binding: 0, kind: 'storage-image', stages: ['fragment'], format: 'rgba8', dims: '2d' }, 'invalid', /dims belongs to image entries/)
  bad({ binding: 0, kind: 'sampler', stages: ['fragment'], unfiltered: true }, 'invalid', /unfiltered belongs to image entries/)
  bad({ binding: 0, kind: 'image', stages: ['fragment'], format: 'rgba8' }, 'invalid', /format belongs to storage-image entries/)
  bad({ binding: 0, kind: 'image', stages: ['fragment'], filtering: true }, 'invalid', /filtering belongs to sampler entries/)
  bad({ binding: 0, kind: 'storage', stages: ['vertex', 'fragment'] }, 'invalid', /a storage entry is written by its shader, and the vertex stage writes nothing/)
  bad({ binding: 0, kind: 'storage-image', stages: ['vertex'], format: 'rgba8' }, 'invalid', /a storage-image entry is written/)
  bad({ binding: 0, kind: 'image', stages: ['fragment'], sample: 'uint', unfiltered: true }, 'invalid', /only a float image entry is unfiltered, not a uint one/)
  bad({ binding: 0, kind: 'image', stages: ['fragment'], sample: 'half' }, 'invalid', /the sample kind "half"/)
  bad({ binding: 0, kind: 'image', stages: ['fragment'], dims: '3d' }, 'invalid', /the shape "3d"/)
  bad({ binding: 0, kind: 'storage-image', stages: ['fragment'] }, 'invalid', /a storage-image entry names its format/)
  bad({ binding: 0, kind: 'storage-image', stages: ['fragment'], format: 'rgb9' }, 'invalid', /"rgb9" is not a format/)
  bad({ binding: 0, kind: 'storage-image', stages: ['fragment'], format: 'rgba8-srgb' }, 'invalid', /rgba8-srgb cannot be a storage image/)
  bad({ binding: 0, kind: 'uniform', stages: ['vertex'], dynamic: 1 }, 'invalid', /dynamic is true or false/)
  bad({ binding: 0, kind: 'uniform', stages: ['vertex'], size: 4 }, 'invalid', /the entry has no field "size"/)
  refuses(() => r.device.createBindingLayout({ entries: [{ binding: 1, kind: 'uniform', stages: ['vertex'] }, { binding: 1, kind: 'sampler', stages: ['fragment'] }] }), 'invalid', /binding 1 has two entries/)
  refuses(() => r.device.createBindingLayout({} as never), 'invalid', /the entries is a list/)
})

test('a storage-image entry\'s format is read once for its checks and its entry: a getter cannot swap it after', () => {
  const r = rig()
  let reads = 0
  const entry = { binding: 0, kind: 'storage-image', stages: ['compute'], get format() { return ++reads < 5 ? 'rgba8' : 'not-a-format' } }
  const layout = r.device.createBindingLayout({ entries: [entry as never] }) as BindingLayoutImpl
  assert.equal(layout.entries[0].format, 'rgba8')
  const sent = r.fake.last('createBindingLayout').args[0] as { readonly entries: readonly BindingEntry[] }
  assert.deepEqual(sent.entries.map((e) => e.format), ['rgba8'])
})

test('binding layout entries are sorted by binding with the defaults of their kind filled in', () => {
  const r = rig()
  const l = layout(r, [
    { binding: 5, kind: 'sampler', stages: ['fragment'] },
    { binding: 2, kind: 'image', stages: ['fragment'] },
    { binding: 0, kind: 'uniform', stages: ['vertex', 'fragment'] },
    { binding: 3, kind: 'storage-read', stages: ['vertex'], dynamic: true },
    { binding: 4, kind: 'storage-image', stages: ['compute'], format: 'r32f' },
  ])
  assert.deepEqual(l.entries, [
    { binding: 0, kind: 'uniform', stages: ['vertex', 'fragment'], dynamic: false },
    { binding: 2, kind: 'image', stages: ['fragment'], sample: 'float', dims: '2d', unfiltered: false },
    { binding: 3, kind: 'storage-read', stages: ['vertex'], dynamic: true },
    { binding: 4, kind: 'storage-image', stages: ['compute'], format: 'r32f' },
    { binding: 5, kind: 'sampler', stages: ['fragment'], filtering: true },
  ])
  assert.ok(Object.isFrozen(l.entries) && Object.isFrozen(l.entries[0]))
  assert.deepEqual(r.fake.last('createBindingLayout').args[0], { entries: l.entries, label: '' })
  // An empty layout is allowed: it fills a set index a pipeline does not read.
  assert.deepEqual(layout(r, []).entries, [])
})

test('per-stage and dynamic limits hold over one binding layout and over a whole pipeline layout', () => {
  const r = rig()
  const uniforms = (n: number, first = 0): BindingEntry[] => Array.from({ length: n }, (_, i) => ({ binding: first + i, kind: 'uniform' as const, stages: ['fragment' as const] }))
  layout(r, uniforms(12))
  refuses(() => layout(r, [...uniforms(12), { binding: 12, kind: 'uniform', stages: ['vertex', 'fragment'] }]), 'limit', /the fragment stage would see 13 bindings that count against stageUniforms; the device allows 12/)
  const storage = Array.from({ length: 5 }, (_, i): BindingEntry => ({ binding: i, kind: i % 2 === 0 ? 'storage' : 'storage-read', stages: ['compute'] }))
  layout(r, storage)
  const nine = Array.from({ length: 9 }, (_, i): BindingEntry => ({ binding: i, kind: 'storage-read', stages: ['vertex'] }))
  refuses(() => layout(r, nine), 'limit', /vertex stage would see 9 bindings that count against stageStorage; the device allows 8/)
  const images = Array.from({ length: 5 }, (_, i): BindingEntry => ({ binding: i, kind: 'storage-image', stages: ['compute'], format: 'rgba8' }))
  refuses(() => layout(r, images), 'limit', /stageStorageImages; the device allows 4/)
  const dynU = Array.from({ length: 9 }, (_, i): BindingEntry => ({ binding: i, kind: 'uniform', stages: i < 5 ? ['vertex'] : ['compute'], dynamic: true }))
  refuses(() => layout(r, dynU), 'limit', /9 dynamic uniform bindings is more than the device allows, 8/)
  const dynS = Array.from({ length: 5 }, (_, i): BindingEntry => ({ binding: i, kind: i < 3 ? 'storage' : 'storage-read', stages: ['compute'], dynamic: true }))
  refuses(() => layout(r, dynS), 'limit', /5 dynamic storage bindings is more than the device allows, 4/)
  // Over a pipeline layout: two sets that fit alone, but not together.
  const a = layout(r, uniforms(8))
  const b = layout(r, uniforms(8))
  refuses(() => r.device.createPipelineLayout({ sets: [a, b] }), 'limit', /fragment stage would see 16 bindings that count against stageUniforms/)
  const c = layout(r, Array.from({ length: 3 }, (_, i): BindingEntry => ({ binding: i, kind: 'storage', stages: ['compute'], dynamic: true })))
  refuses(() => r.device.createPipelineLayout({ sets: [c, c] }), 'limit', /6 dynamic storage bindings/)
  r.device.createPipelineLayout({ sets: [a, layout(r, uniforms(4))] })
})

test('createPipelineLayout: up to the device\'s sets, constants a multiple of 4 within the limit', () => {
  const r = rig()
  const l = layout(r, [{ binding: 0, kind: 'uniform', stages: ['vertex'] }])
  refuses(() => r.device.createPipelineLayout({ sets: [l, l, l, l] }), 'limit', /4 sets is more than the device allows, 3/)
  refuses(() => r.device.createPipelineLayout({ sets: [{}] } as never), 'invalid', /sets\[0\] is not a BindingLayout/)
  refuses(() => r.device.createPipelineLayout({ sets: [], constants: { size: 6, stages: ['vertex'] } }), 'invalid', /the constants size 6 is not a multiple of 4/)
  refuses(() => r.device.createPipelineLayout({ sets: [], constants: { size: 0, stages: ['vertex'] } }), 'invalid', /the constants size 0/)
  refuses(() => r.device.createPipelineLayout({ sets: [], constants: { size: 132, stages: ['vertex'] } }), 'limit', /132 bytes of constants is more than the device allows, 128/)
  refuses(() => r.device.createPipelineLayout({ sets: [], constants: { size: 16, stages: [] } }), 'invalid', /the constants stages is empty/)
  refuses(() => r.device.createPipelineLayout({ sets: [], constants: { size: 16 } } as never), 'invalid', /the constants stages is a list/)
  const p = r.device.createPipelineLayout({ sets: [l, l], constants: { size: 128, stages: ['vertex', 'fragment'] }, label: 'main' })
  assert.deepEqual(p.sets, [l, l])
  assert.deepEqual(p.constants, { size: 128, stages: ['vertex', 'fragment'] })
  assert.equal(r.device.createPipelineLayout({ sets: [] }).constants, null)
  const call = r.fake.named('createPipelineLayout')[0].args
  assert.equal((call[0] as unknown[]).length, 2)
  assert.deepEqual(call[1], { size: 128, stages: ['vertex', 'fragment'] })
  l.destroy()
  refuses(() => r.device.createPipelineLayout({ sets: [l] }), 'lifetime', /is destroyed/)
  // A pipeline layout made before keeps working.
  assert.equal(p.sets[0], l)
})

test('two binding layouts are compatible when they are one object or their filled-in entries are equal', () => {
  const r = rig()
  const a = layout(r, [{ binding: 1, kind: 'image', stages: ['fragment'] }, { binding: 0, kind: 'uniform', stages: ['fragment'] }])
  const b = layout(r, [{ binding: 0, kind: 'uniform', stages: ['fragment'], dynamic: false }, { binding: 1, kind: 'image', stages: ['fragment'], sample: 'float', dims: '2d' }])
  const c = layout(r, [{ binding: 0, kind: 'uniform', stages: ['fragment'], dynamic: true }, { binding: 1, kind: 'image', stages: ['fragment'] }])
  const d = layout(r, [{ binding: 0, kind: 'uniform', stages: ['vertex', 'fragment'] }, { binding: 1, kind: 'image', stages: ['fragment'] }])
  assert.ok(a instanceof BindingLayoutImpl && b instanceof BindingLayoutImpl && c instanceof BindingLayoutImpl && d instanceof BindingLayoutImpl)
  assert.ok(compatible(a, a))
  assert.ok(compatible(a, b))
  assert.ok(!compatible(a, c))
  assert.ok(!compatible(a, d))
})

test('a pool hands out its sets, then refuses until reset; reset destroys every set it handed out', () => {
  const r = rig()
  const l = layout(r, [])
  refuses(() => r.device.createBindingPool({ sets: 0 }), 'invalid', /the set count 0/)
  const pool = r.device.createBindingPool({ sets: 2, label: 'p' })
  const a = pool.allocate(l, 'a')
  const b = pool.allocate(l)
  assert.equal(a.layout, l)
  assert.equal(a.label, 'a')
  refuses(() => pool.allocate(l), 'limit', /binding pool "p" allocate: the pool has handed out its 2 sets; reset it first/)
  refuses(() => pool.allocate({} as never), 'invalid', /the layout is not a BindingLayout/)
  refuses(() => pool.allocate(l, 4 as never), 'invalid', /the label is a string/)
  b.destroy()
  // Capacity counts sets handed out since the reset, destroyed or not.
  refuses(() => pool.allocate(l), 'limit')
  pool.reset()
  assert.ok(a.destroyed)
  refuses(() => a.write([]), 'lifetime')
  pool.allocate(l)
  pool.allocate(l)
  const sets = r.fake.named('createBindingSet').length
  assert.equal(sets, 4)
  pool.destroy()
  refuses(() => pool.allocate(l), 'lifetime')
  const p2 = r.device.createBindingPool({ sets: 1 })
  l.destroy()
  refuses(() => p2.allocate(l), 'lifetime', /binding layout \d+ is destroyed/)
})

test('set writes: each checked against its entry before anything changes', () => {
  const r = rig()
  const l = layout(r, [
    { binding: 0, kind: 'uniform', stages: ['fragment'] },
    { binding: 1, kind: 'storage-read', stages: ['fragment'] },
    { binding: 2, kind: 'image', stages: ['fragment'] },
    { binding: 3, kind: 'sampler', stages: ['fragment'], filtering: false },
    { binding: 4, kind: 'storage-image', stages: ['fragment'], format: 'rgba8' },
  ])
  const set = r.device.createBindingPool({ sets: 4 }).allocate(l, 's')
  const uni = buffer(r, 1024, ['uniform'], KIND.device, 'u')
  const sto = buffer(r, 1024, ['storage'], KIND.device, 'st')
  const vtx = buffer(r, 64, ['vertex'], KIND.device, 'vx')
  refuses(() => set.write([]), 'invalid', /the writes are empty/)
  refuses(() => set.write('x' as never), 'invalid', /the writes is a list/)
  refuses(() => set.write([7] as never), 'invalid', /writes\[0\]: a write is an object/)
  refuses(() => set.write([{ binding: 9, buffer: uni }]), 'invalid', /binding layout \d+ has no binding 9/)
  refuses(() => set.write([{ binding: 0, buffer: uni }, { binding: 0, buffer: uni }]), 'invalid', /writes\[1\]: binding 0 is written twice in one call/)
  refuses(() => set.write([{ binding: 0, buffer: uni, view: {} } as never]), 'invalid', /exactly one of buffer, view and sampler/)
  refuses(() => set.write([{ binding: 0 } as never]), 'invalid', /exactly one of/)
  refuses(() => set.write([{ binding: 0, buffer: uni, extra: 1 } as never]), 'invalid', /the write has no field "extra"/)
  // Buffers.
  refuses(() => set.write([{ binding: 2, buffer: uni }]), 'mismatch', /binding 2 is an image binding; a buffer goes to a uniform or storage binding/)
  refuses(() => set.write([{ binding: 0, buffer: vtx }]), 'mismatch', /buffer "vx" has no uniform use, which a uniform binding needs/)
  refuses(() => set.write([{ binding: 1, buffer: uni }]), 'mismatch', /has no storage use, which a storage-read binding needs/)
  // A good write in a refused call is not kept either.
  refuses(() => set.write([{ binding: 1, buffer: sto }, { binding: 0, buffer: vtx }]), 'mismatch', /writes\[1\]: buffer "vx" has no uniform use/)
  refuses(() => set.write([{ binding: 0, buffer: r.device.createBuffer({ size: 256, use: ['uniform'], label: 'free' }) }]), 'state', /buffer "free" is not bound to memory yet/)
  refuses(() => set.write([{ binding: 0, buffer: uni, offset: 128 }]), 'invalid', /offset 128 is not a multiple of 256/)
  refuses(() => set.write([{ binding: 0, buffer: uni, offset: 1024 }]), 'invalid', /offset 1024 is not inside buffer "u" \(1024 bytes\)/)
  refuses(() => set.write([{ binding: 0, buffer: uni, size: 6 }]), 'invalid', /the size 6 is not a multiple of 4/)
  refuses(() => set.write([{ binding: 0, buffer: uni, size: 0 }]), 'invalid', /the size 0/)
  refuses(() => set.write([{ binding: 0, buffer: uni, offset: 768, size: 512 }]), 'invalid', /bytes 768 to 1279 run past the end of buffer "u"/)
  refuses(() => set.write([{ binding: 0, view: {} } as never]), 'mismatch', /a view goes to an image or storage-image binding/)
  refuses(() => set.write([{ binding: 0, sampler: {} } as never]), 'mismatch', /a sampler goes to a sampler binding/)
  refuses(() => set.write([{ binding: 0, buffer: {} } as never]), 'invalid', /the buffer is not a Buffer/)
  // Nothing was written, so the back end heard nothing.
  assert.equal(r.fake.named('writeBindingSet').length, 0)
  assert.ok(set instanceof BindingSetImpl && !set.complete)
  assert.match(set.unusable() ?? '', /binding 0 of binding set "s" was never written/)
})

test('buffer ranges: the default size is the rest of the buffer, and a binding stays within its kind\'s range', () => {
  const r = rig()
  const l = layout(r, [{ binding: 0, kind: 'uniform', stages: ['vertex'] }, { binding: 1, kind: 'storage', stages: ['compute'] }])
  const set = r.device.createBindingPool({ sets: 1 }).allocate(l)
  const big = buffer(r, 65536 + 256, ['uniform', 'storage'])
  refuses(() => set.write([{ binding: 0, buffer: big }]), 'limit', /65792 bytes is more than a uniform binding may cover, 65536 \(give a size\)/)
  refuses(() => set.write([{ binding: 0, buffer: big, size: 65540 }]), 'limit', /65540 bytes is more than a uniform binding may cover, 65536$/)
  set.write([{ binding: 0, buffer: big, offset: 256 }, { binding: 1, buffer: big }])
  const entries = r.fake.last('writeBindingSet').args[1] as readonly BoundEntry[]
  assert.deepEqual(entries.map((e) => ('buffer' in e ? [e.binding, e.offset, e.size] : null)), [[0, 256, 65536], [1, 0, 65792]])
})

test('view writes: sampled or storage use, shape, sample kind, filtering and the storage-image rules', () => {
  const r = rig({ features: [] })
  const l = layout(r, [
    { binding: 0, kind: 'image', stages: ['fragment'] },
    { binding: 1, kind: 'image', stages: ['fragment'], dims: '2d-array' },
    { binding: 2, kind: 'image', stages: ['fragment'], sample: 'depth' },
    { binding: 3, kind: 'image', stages: ['fragment'], unfiltered: true },
    { binding: 4, kind: 'image', stages: ['fragment'], sample: 'uint' },
    { binding: 5, kind: 'storage-image', stages: ['compute'], format: 'rgba8' },
  ])
  const set = r.device.createBindingPool({ sets: 1 }).allocate(l)
  const tex = imageView(r, { format: 'rgba8', width: 4, height: 4, use: ['sampled', 'storage'], label: 'tex' })
  const noSample = imageView(r, { format: 'rgba8', width: 4, height: 4, use: ['color'], label: 'rt' })
  const arr = imageView(r, { format: 'rgba8', width: 4, height: 4, layers: 2, use: ['sampled'] })
  const depth = imageView(r, { format: 'depth32f', width: 4, height: 4, use: ['sampled', 'depth'] })
  const f32 = imageView(r, { format: 'rgba32f', width: 4, height: 4, use: ['sampled'] })
  const u32 = imageView(r, { format: 'r32u', width: 4, height: 4, use: ['sampled'] })
  const mips = imageView(r, { format: 'rgba8', width: 4, height: 4, levels: 2, use: ['storage'] })
  const r32 = imageView(r, { format: 'r32f', width: 4, height: 4, use: ['storage'] })
  refuses(() => set.write([{ binding: 0, view: noSample }]), 'mismatch', /image "rt" has no sampled use, which an image binding needs/)
  refuses(() => set.write([{ binding: 0, view: arr }]), 'mismatch', /is 2d-array; binding 0 takes 2d/)
  refuses(() => set.write([{ binding: 1, view: tex }]), 'mismatch', /is 2d; binding 1 takes 2d-array/)
  refuses(() => set.write([{ binding: 0, view: depth }]), 'mismatch', /depth32f hands a shader depth values; binding 0 takes float/)
  refuses(() => set.write([{ binding: 2, view: tex }]), 'mismatch', /rgba8 hands a shader float values; binding 2 takes depth/)
  refuses(() => set.write([{ binding: 0, view: u32 }]), 'mismatch', /r32u hands a shader uint values/)
  refuses(() => set.write([{ binding: 0, view: f32 }]), 'mismatch', /rgba32f cannot be filtered; bind it to an unfiltered entry or open the device with float32-filter/)
  refuses(() => set.write([{ binding: 5, view: tex }, { binding: 0, view: u32 }]), 'mismatch')
  refuses(() => set.write([{ binding: 5, view: arr }]), 'mismatch', /has no storage use, which a storage-image binding needs/)
  refuses(() => set.write([{ binding: 5, view: r32 }]), 'mismatch', /is r32f; binding 5 takes rgba8/)
  refuses(() => set.write([{ binding: 5, view: mips }]), 'mismatch', /a storage-image binding takes a 2d view of one level/)
  set.write([{ binding: 0, view: tex }, { binding: 1, view: arr }, { binding: 2, view: depth }, { binding: 3, view: f32 }, { binding: 4, view: u32 }])
  assert.equal(r.fake.named('writeBindingSet').length, 0)
  set.write([{ binding: 5, view: r.device.createView(mips.image, { levels: { base: 1, count: 1 } }) }])
  assert.equal(r.fake.named('writeBindingSet').length, 1)
  // With float32-filter, rgba32f may be filtered.
  const r2 = rig({ features: ['float32-filter'] })
  const l2 = layout(r2, [{ binding: 0, kind: 'image', stages: ['fragment'] }])
  r2.device.createBindingPool({ sets: 1 }).allocate(l2).write([{ binding: 0, view: imageView(r2, { format: 'rgba32f', width: 4, height: 4, use: ['sampled'] }) }])
  // r32u is never filterable whatever the device: it is not a float format.
  const l3 = layout(r2, [{ binding: 0, kind: 'image', stages: ['fragment'] }])
  refuses(() => r2.device.createBindingPool({ sets: 1 }).allocate(l3).write([{ binding: 0, view: imageView(r2, { format: 'r32u', width: 4, height: 4, use: ['sampled'] }) }]), 'mismatch', /uint values/)
})

test('sampler writes: a non-filtering entry takes only an all-nearest sampler', () => {
  const r = rig()
  const l = layout(r, [{ binding: 0, kind: 'sampler', stages: ['fragment'], filtering: false }, { binding: 1, kind: 'sampler', stages: ['fragment'] }])
  const set = r.device.createBindingPool({ sets: 1 }).allocate(l)
  const linear = r.device.createSampler({ mip: 'linear', label: 'lin' })
  const nearest = r.device.createSampler()
  refuses(() => set.write([{ binding: 0, sampler: linear }]), 'mismatch', /binding 0 takes a sampler that never filters linearly, and sampler "lin" does/)
  refuses(() => set.write([{ binding: 0, sampler: {} } as never]), 'invalid', /the sampler is not a Sampler/)
  set.write([{ binding: 0, sampler: nearest }, { binding: 1, sampler: linear }])
  const entries = r.fake.last('writeBindingSet').args[1] as readonly BoundEntry[]
  assert.deepEqual(entries.map((e) => e.binding), [0, 1])
})

test('the back end hears of a set once it is complete, then after every write; each write raises the version', () => {
  const r = rig()
  const l = layout(r, [{ binding: 3, kind: 'sampler', stages: ['fragment'] }, { binding: 1, kind: 'uniform', stages: ['fragment'] }])
  const set = r.device.createBindingPool({ sets: 1 }).allocate(l) as BindingSetImpl
  const s1 = r.device.createSampler()
  const s2 = r.device.createSampler()
  const u = buffer(r, 256, ['uniform'])
  const v0 = set.version
  set.write([{ binding: 3, sampler: s1 }])
  assert.equal(set.version, v0 + 1)
  assert.equal(r.fake.named('writeBindingSet').length, 0)
  set.write([{ binding: 1, buffer: u, size: 64 }])
  assert.ok(set.complete)
  assert.equal(set.unusable(), null)
  const first = r.fake.last('writeBindingSet').args[1] as readonly BoundEntry[]
  assert.deepEqual(first.map((e) => e.binding), [1, 3])
  const head = first[0] as { readonly binding: number; readonly buffer: FakeHandle; readonly offset: number; readonly size: number }
  assert.deepEqual([head.binding, head.buffer.kind, head.offset, head.size], [1, 'buffer', 0, 64])
  set.write([{ binding: 3, sampler: s2 }])
  assert.equal(r.fake.named('writeBindingSet').length, 2)
  assert.equal(set.version, v0 + 3)
  assert.equal(set.bindings.length, 2)
  // A resource destroyed under a set makes it unusable until that binding is written again.
  s2.destroy()
  assert.match(set.unusable() ?? '', /binding 3 of binding set \d+ holds sampler \d+, which is destroyed/)
  refuses(() => set.write([{ binding: 1, buffer: u }]), 'lifetime', /binding 3 holds sampler \d+, which is destroyed; write it again/)
  set.write([{ binding: 3, sampler: s1 }])
  assert.equal(set.unusable(), null)
  refuses(() => set.write([{ binding: 3, sampler: s2 }]), 'lifetime', /sampler \d+ is destroyed/)
})

test('stages compare in one order, and a set of an empty layout reaches the back end written', () => {
  const r = rig()
  const a = layout(r, [{ binding: 0, kind: 'uniform', stages: ['fragment', 'vertex'] }]) as BindingLayoutImpl
  const b = layout(r, [{ binding: 0, kind: 'uniform', stages: ['vertex', 'fragment'] }]) as BindingLayoutImpl
  assert.deepEqual(a.entries[0].stages, ['vertex', 'fragment'])
  assert.ok(compatible(a, b))
  const p = r.device.createPipelineLayout({ sets: [], constants: { size: 16, stages: ['compute', 'fragment', 'vertex'] } })
  assert.deepEqual(r.fake.last('createPipelineLayout').args[1], { size: 16, stages: ['vertex', 'fragment', 'compute'] })
  assert.ok(p)
  const empty = layout(r, []) as BindingLayoutImpl
  const before = r.fake.named('writeBindingSet').length
  const set = r.device.createBindingPool({ sets: 1 }).allocate(empty, 'e') as BindingSetImpl
  const calls = r.fake.named('writeBindingSet')
  assert.equal(calls.length, before + 1)
  assert.equal((calls[calls.length - 1].args[0] as FakeHandle), set.handle)
  assert.deepEqual(calls[calls.length - 1].args[1], [])
  assert.equal(set.unusable(), null)
})
