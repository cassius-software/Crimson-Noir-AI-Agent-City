// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins every record-time rule of a command list: its states, passes and their
 * attachments, binding pipelines, sets, vertex and index buffers, the draw and dispatch checks, copies, updates,
 * barriers and groups, which queue group may run what, and the record each accepted command leaves for the ordering
 * checker, down to the position of its back end command. It also pins that a refused command leaves no trace, and
 * that a ready list turns invalid when something it recorded is destroyed or written.
 * What breaks if it is removed? A draw past the end of a vertex buffer, a copy that overlaps itself or a pipeline
 * bound to a pass it does not fit could reach a back end, and the ordering checker could read a record that lies.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BindingSet, Buffer, Command, Image, PipelineLayout, RenderPipeline, VertexBufferLayout, View, Viewport } from './api.ts'
import { BindingSetImpl } from './bindings.ts'
import { arrayOf, lens } from './builder.ts'
import { COPY_REGIONS, CommandListImpl } from './commands.ts'
import type { Recorded } from './commands.ts'
import type { Format } from './formats.ts'
import type { LensModule } from './lens.ts'
import type { MemoryImpl } from './memory.ts'
import { ComputePipelineImpl, RenderPipelineImpl } from './pipelines.ts'
import { BufferImpl, ImageImpl, ViewImpl } from './resources.ts'
import { KIND, buffer, computeLens, fragmentLens, image, imageView, refuses, rig, vertexLens } from './harness.test.ts'
import type { Rig } from './harness.test.ts'

const POS = { slot: 0, format: 'f32x2', offset: 0 } as const
const COLOR = { slot: 1, format: 'f32x4', offset: 8 } as const
const BUFFERS: readonly VertexBufferLayout[] = [{ stride: 24, attributes: [POS, COLOR] }]

interface Scene {
  readonly r: Rig
  readonly list: CommandListImpl
  readonly canvas: View
  readonly layout: PipelineLayout
  readonly pipeline: RenderPipeline
  /** Three vertices of 24 bytes. */
  readonly vbuf: Buffer
  readonly vertexStage: { readonly lens: ReturnType<Rig['device']['createLens']>; readonly buffers: readonly VertexBufferLayout[] }
  readonly fragmentStage: { readonly lens: ReturnType<Rig['device']['createLens']>; readonly outputs: readonly { readonly format: 'rgba8' }[] }
}

/** A device, a list labelled "l" from a graphics arena, a 64 x 32 rgba8 canvas and a pipeline that draws into it. */
function scene(o: Parameters<typeof rig>[0] = {}): Scene {
  const r = rig(o)
  const list = r.device.createCommandArena({ label: 'main' }).allocate('l') as CommandListImpl
  const canvas = imageView(r, { format: 'rgba8', width: 64, height: 32, use: ['color', 'copy-src'] })
  const layout = r.device.createPipelineLayout({ sets: [] })
  const vertexStage = { lens: r.device.createLens(vertexLens()), buffers: BUFFERS }
  const fragmentStage = { lens: r.device.createLens(fragmentLens()), outputs: [{ format: 'rgba8' }] as const }
  const pipeline = r.device.createRenderPipeline({ layout, vertex: vertexStage, fragment: fragmentStage })
  return { r, list, canvas, layout, pipeline, vbuf: buffer(r, 72, ['vertex']), vertexStage, fragmentStage }
}

const pass = (s: Scene): void => s.list.beginPass({ colors: [{ view: s.canvas, load: 'clear', store: 'keep' }] })

/** A compute pipeline over a dynamic storage binding at set 0, and a set "s" holding 256 bytes of a 1024-byte buffer. */
function computeScene(o: Parameters<typeof rig>[0] = {}) {
  const r = rig(o)
  const list = r.device.createCommandArena().allocate() as CommandListImpl
  const setLayout = r.device.createBindingLayout({ entries: [{ binding: 0, kind: 'storage', stages: ['compute'], dynamic: true }] })
  const layout = r.device.createPipelineLayout({ sets: [setLayout] })
  const pipeline = r.device.createComputePipeline({ layout, lens: r.device.createLens(computeLens()) })
  const data = buffer(r, 1024, ['storage', 'copy-src', 'indirect'])
  const pool = r.device.createBindingPool({ sets: 8 })
  const set = pool.allocate(setLayout, 's')
  set.write([{ binding: 0, buffer: data, size: 256 }])
  return { r, list, setLayout, layout, pipeline, data, pool, set }
}

const viewHandle = (v: View): unknown => (v as ViewImpl).handle
const bufferHandle = (b: Buffer): unknown => (b as BufferImpl).handle('test')
const lastCommand = (list: CommandListImpl): Command => list.commands[list.commands.length - 1]

function lastRecord<K extends Recorded['r']>(list: CommandListImpl, r: K): Extract<Recorded, { readonly r: K }> {
  const all = list.records.filter((x): x is Extract<Recorded, { readonly r: K }> => x.r === r)
  assert.ok(all.length > 0, `no ${r} record`)
  return all[all.length - 1]
}

const MATCH: { readonly [K in Recorded['r']]: readonly Command['c'][] } = {
  pass: ['pass'], 'end-pass': ['end-pass'], draw: ['draw', 'draw-indexed', 'draw-indirect'], dispatch: ['dispatch', 'dispatch-indirect'],
  'copy-buffer': ['copy-buffer'], 'copy-buffer-image': ['copy-buffer-image'], 'copy-image-buffer': ['copy-image-buffer'], 'copy-image': ['copy-image'],
  update: ['update'], zero: ['zero'], barrier: ['barrier'],
}
const STATE_ONLY: readonly Command['c'][] = ['pipeline', 'sets', 'vertices', 'indices', 'viewport', 'scissor', 'blend-constant', 'constants', 'group', 'end-group']

/** Every record points, in order, at a back end command of its kind, and every command that touches memory has one. */
function consistent(list: CommandListImpl): void {
  let last = -1
  for (const rec of list.records) {
    assert.ok(rec.at > last, `record ${rec.r} at ${rec.at} is out of order`)
    last = rec.at
    assert.ok(MATCH[rec.r].includes(list.commands[rec.at].c), `record ${rec.r} points at a ${list.commands[rec.at].c} command`)
  }
  assert.equal(list.records.length, list.commands.filter((c) => !STATE_ONLY.includes(c.c)).length)
}

test('a list runs initial, recording, ready; begin takes an initial list; end needs no open pass or group', () => {
  const s = scene()
  const { list, r } = s
  assert.equal(list.state, 'initial')
  refuses(() => list.end(), 'state', /^command list "l" end: the list is initial; commands are recorded between begin\(\) and end\(\)$/)
  refuses(() => list.zeroBuffer(s.vbuf, 0, 4), 'state', /the list is initial/)
  refuses(() => list.begin({ twice: true } as never), 'invalid', /the begin info has no field "twice"/)
  refuses(() => list.begin({ once: 1 } as never), 'invalid', /once is true or false, not 1/)
  list.begin()
  assert.equal(list.state, 'recording')
  refuses(() => list.begin(), 'state', /the list is recording; begin\(\) takes an initial list \(reset it first\)/)
  pass(s)
  refuses(() => list.end(), 'state', /a pass is still open; end it first/)
  list.endPass()
  list.beginGroup('g')
  refuses(() => list.end(), 'state', /1 group is still open/)
  list.beginGroup('h')
  refuses(() => list.end(), 'state', /2 groups are still open/)
  list.endGroup()
  list.endGroup()
  list.end()
  assert.equal(list.state, 'ready')
  assert.ok(Object.isFrozen(list.commands) && Object.isFrozen(list.records))
  assert.deepEqual(list.commands.map((c) => c.c), ['pass', 'end-pass', 'group', 'group', 'end-group', 'end-group'])
  consistent(list)
  refuses(() => list.end(), 'state', /the list is ready/)
  refuses(() => list.begin(), 'state', /the list is ready; begin\(\) takes an initial list/)
  list.reset()
  assert.equal(list.state, 'initial')
  assert.deepEqual([list.commands.length, list.records.length, list.uses.size], [0, 0, 0])
  list.begin({ once: true })
  list.end()
  assert.equal(list.state, 'ready')
  // A list of an arena that is not resettable resets only with the whole arena.
  const whole = r.device.createCommandArena({ resettable: false })
  const a = whole.allocate()
  const b = whole.allocate('b')
  a.begin()
  a.end()
  b.begin()
  refuses(() => a.reset(), 'state', /resets its lists only all together/)
  whole.reset()
  assert.deepEqual([a.state, b.state], ['initial', 'initial'])
  refuses(() => r.device.createCommandArena({ group: 2 }), 'invalid', /the device opened no queue of group 2/)
  refuses(() => r.device.createCommandArena({ resettable: 1 } as never), 'invalid', /resettable is true or false/)
  refuses(() => whole.allocate(7 as never), 'invalid', /the label is a string, not 7/)
  a.destroy()
  refuses(() => a.begin(), 'lifetime', /is destroyed/)
  // Destroying the arena destroys the lists it still holds.
  whole.destroy()
  assert.equal(b.destroyed, true)
  refuses(() => whole.allocate(), 'lifetime', /is destroyed/)
  refuses(() => b.reset(), 'lifetime', /command list "b" reset: command list "b" is destroyed/)
})

test('a pass: at least one attachment, each one level of one layer with the use it needs, attached once, one size', () => {
  const s = scene()
  const { r, list, canvas } = s
  list.begin()
  const begin = (colors: readonly unknown[], depth?: unknown): void => list.beginPass({ colors, depth, label: 'main pass' } as never)
  const keep = (view: View): unknown => ({ view, load: 'keep', store: 'keep' })
  refuses(() => begin([]), 'invalid', /^command list "l" beginPass: a pass has at least one attachment$/)
  refuses(() => begin([null, null]), 'invalid', /a pass has at least one attachment/)
  refuses(() => begin(Array.from({ length: 9 }, () => null)), 'limit', /9 colour attachments is more than the device allows, 8/)
  refuses(() => list.beginPass({ colors: [], extra: 1 } as never), 'invalid', /the pass info has no field "extra"/)
  refuses(() => list.beginPass(undefined as never), 'invalid', /the pass info is an object, not undefined/)
  const sampled = imageView(r, { format: 'rgba8', width: 64, height: 32, use: ['sampled'] })
  refuses(() => begin([keep(sampled)]), 'mismatch', /colors\[0\]: image \d+ has no color use, which a color attachment needs/)
  const mips = image(r, { format: 'rgba8', width: 64, height: 32, levels: 2, use: ['color'] })
  refuses(() => begin([keep(r.device.createView(mips))]), 'invalid', /covers 2 levels and 1 layers; an attachment is one level of one layer/)
  refuses(() => begin([{ view: canvas, load: 'load', store: 'keep' }]), 'invalid', /the load op "load" is not one of keep, clear, any/)
  refuses(() => begin([{ view: canvas, load: 'keep', store: 'discard' }]), 'invalid', /the store op "discard" is not one of keep, any/)
  refuses(() => begin([{ view: canvas, load: 'clear', store: 'keep', clear: [1, 0, 0] }]), 'invalid', /colors\[0\]: the clear colour is four numbers, not a list/)
  refuses(() => begin([{ view: canvas, load: 'clear', store: 'keep', clear: [1, 0, 0, Number.NaN] }]), 'invalid', /the clear colour channel 3 NaN is not a finite number/)
  refuses(() => begin([{ view: {}, load: 'keep', store: 'keep' }]), 'invalid', /the view is not a View, but an object/)
  refuses(() => begin([keep(canvas), keep(r.device.createView(canvas.image))]), 'invalid', /colors\[1\]: level 0 layer 0 of image \d+ is attached twice in the pass/)
  const small = imageView(r, { format: 'rgba8', width: 32, height: 32, use: ['color'] })
  refuses(() => begin([keep(canvas), keep(small)]), 'mismatch', /colors\[1\]: view \d+ is 32 x 32, and view \d+ is 64 x 32; the attachments of a pass are one size/)
  const four = imageView(r, { format: 'rgba8', width: 64, height: 32, samples: 4, use: ['color'] })
  refuses(() => begin([keep(canvas), keep(four)]), 'mismatch', /view \d+ has 4 samples, and view \d+ has 1; the attachments of a pass have one sample count/)
  refuses(() => begin([keep(canvas), keep(r.device.createView(sampled.image))]), 'mismatch', /has no color use/)
  assert.equal(list.commands.length, 0)
  // A level of a mip-mapped image attaches at that level's size; an empty slot is allowed between attachments.
  const level = r.device.createView(mips, { levels: { base: 1, count: 1 } })
  const half = imageView(r, { format: 'rgba8', width: 32, height: 16, use: ['color'] })
  begin([{ view: level, load: 'any', store: 'keep' }, null, { view: half, load: 'keep', store: 'any' }])
  assert.deepEqual(lastCommand(list), {
    c: 'pass',
    colors: [{ view: viewHandle(level), load: 'any', store: 'keep', clear: [0, 0, 0, 0], resolve: null }, null, { view: viewHandle(half), load: 'keep', store: 'any', clear: [0, 0, 0, 0], resolve: null }],
    depth: null,
    width: 32,
    height: 16,
  })
  refuses(() => pass(s), 'state', /a pass is already open; end it first/)
  list.endPass()
  refuses(() => list.endPass(), 'state', /this command sits inside a pass, and no pass is open/)
  consistent(list)
})

test('a pass\'s colour attachments take at most limits.colorBytes bytes per sample, counted slot by slot as WebGPU counts them', () => {
  const r = rig()
  const list = r.device.createCommandArena().allocate('l') as CommandListImpl
  const keep = (format: Format): unknown => ({ view: imageView(r, { format, width: 4, height: 4, use: ['color'] }), load: 'keep', store: 'keep' })
  const begin = (colors: readonly unknown[]): void => list.beginPass({ colors } as never)
  const many = (n: number, format: Format): unknown[] => Array.from({ length: n }, () => keep(format))
  list.begin()
  // rgba32f costs 16 bytes, so three take 48; rgba8 and bgra8 cost 8 (WebGPU's cost, not their 4 texel bytes).
  refuses(() => begin(many(3, 'rgba32f')), 'limit', /^command list "l" beginPass: the colour attachments take 48 bytes per sample, more than the device allows, 32$/)
  refuses(() => begin(many(5, 'rgba8')), 'limit', /the colour attachments take 40 bytes per sample/)
  refuses(() => begin(many(8, 'bgra8')), 'limit', /the colour attachments take 64 bytes per sample/)
  refuses(() => begin(many(5, 'rgba16f')), 'limit', /the colour attachments take 40 bytes per sample/)
  // The count rounds up to each format's alignment first: r8 then two rgba32f take 4 + 16 + 16.
  refuses(() => begin([keep('r8'), ...many(2, 'rgba32f')]), 'limit', /the colour attachments take 36 bytes per sample/)
  assert.equal(list.commands.length, 0)
  // Exactly 32 fits, and an empty slot adds nothing.
  begin([keep('rgba32f'), null, keep('rgba32f')])
  list.endPass()
  begin([keep('rgba8'), keep('rgba8-srgb'), keep('bgra8'), keep('bgra8-srgb')])
  list.endPass()
  begin([keep('rgba32f'), keep('rg32f'), keep('r32u'), keep('r32i')])
  list.endPass()
  list.end()
  consistent(list)
  // A device may ask for less, and is held to what it asked for; never more than the adapter's.
  refuses(() => rig({ limits: { colorBytes: 64 } }), 'limit', /the limit colorBytes 64 is more than the adapter allows, 32/)
  const low = rig({ limits: { colorBytes: 16 } })
  assert.equal(low.device.limits.colorBytes, 16)
  const l2 = low.device.createCommandArena().allocate() as CommandListImpl
  const view = (format: Format): unknown => ({ view: imageView(low, { format, width: 4, height: 4, use: ['color'] }), load: 'keep', store: 'keep' })
  l2.begin()
  refuses(() => l2.beginPass({ colors: [view('rgba8'), view('rgba8'), view('r8')] } as never), 'limit', /take 17 bytes per sample, more than the device allows, 16/)
  l2.beginPass({ colors: [view('rgba8'), view('rgba8')] } as never)
})

test('depth attachments and resolve views', () => {
  const s = scene()
  const { r, list, canvas } = s
  list.begin()
  const begin = (colors: readonly unknown[], depth?: unknown): void => list.beginPass({ colors, depth, label: 'main pass' } as never)
  const depth = imageView(r, { format: 'depth16', width: 64, height: 32, use: ['depth'] })
  refuses(() => begin([{ view: depth, load: 'keep', store: 'keep' }]), 'mismatch', /colors\[0\]: image \d+ has no color use/)
  refuses(() => begin([], { view: canvas, load: 'keep', store: 'keep' }), 'mismatch', /depth: image \d+ has no depth use, which a depth attachment needs/)
  refuses(() => begin([], { view: depth, load: 'clear', store: 'keep', clear: 2 }), 'invalid', /depth: the clear depth 2 is outside 0 to 1/)
  refuses(() => begin([], { view: depth, load: 'clear', store: 'keep', clear: 'far' }), 'invalid', /the clear depth "far" is not a finite number/)
  refuses(() => begin([], { view: depth, load: 'clear', store: 'keep', readOnly: true }), 'invalid', /a read-only depth attachment is loaded and stored with keep, not clear and keep/)
  refuses(() => begin([], { view: depth, load: 'keep', store: 'any', readOnly: true }), 'invalid', /not keep and any/)
  refuses(() => begin([], { view: depth, load: 'keep', store: 'keep', readOnly: 'yes' }), 'invalid', /readOnly is true or false, not "yes"/)
  refuses(() => begin([], { view: depth, load: 'keep', store: 'keep', stencil: 0 }), 'invalid', /the depth attachment has no field "stencil"/)
  const smallDepth = imageView(r, { format: 'depth16', width: 32, height: 32, use: ['depth'] })
  refuses(() => begin([{ view: canvas, load: 'keep', store: 'keep' }], { view: smallDepth, load: 'keep', store: 'keep' }), 'mismatch', /depth: view \d+ is 32 x 32/)
  // A depth-only pass is a pass.
  begin([], { view: depth, load: 'keep', store: 'keep', readOnly: true })
  assert.deepEqual(lastCommand(list), { c: 'pass', colors: [], depth: { view: viewHandle(depth), load: 'keep', store: 'keep', clear: 1, readOnly: true }, width: 64, height: 32 })
  list.endPass()
  begin([{ view: canvas, load: 'clear', store: 'keep', clear: [0, 0, 0, 1] }], { view: depth, load: 'clear', store: 'any', clear: 0.5 })
  const at = list.commands.length - 1
  assert.deepEqual(list.commands[at], {
    c: 'pass',
    colors: [{ view: viewHandle(canvas), load: 'clear', store: 'keep', clear: [0, 0, 0, 1], resolve: null }],
    depth: { view: viewHandle(depth), load: 'clear', store: 'any', clear: 0.5, readOnly: false },
    width: 64,
    height: 32,
  })
  assert.deepEqual(lastRecord(list, 'pass'), {
    r: 'pass', at, label: 'main pass', colors: [{ view: canvas, load: 'clear', store: 'keep', resolve: null }], depth: { view: depth, load: 'clear', store: 'any', readOnly: false }, width: 64, height: 32, samples: 1,
  })
  list.endPass()
  // Resolve views.
  const four = imageView(r, { format: 'rgba8', width: 64, height: 32, samples: 4, use: ['color'] })
  const fourMore = imageView(r, { format: 'rgba8', width: 64, height: 32, samples: 4, use: ['color'] })
  const resolveInto = (view: View, resolve: View): void => begin([{ view, load: 'clear', store: 'any', resolve }])
  const other = imageView(r, { format: 'rgba8', width: 64, height: 32, use: ['color'] })
  refuses(() => resolveInto(canvas, other), 'invalid', /only a four-sample attachment is resolved, and image \d+ has one sample/)
  refuses(() => resolveInto(four, fourMore), 'mismatch', /the resolve view view \d+ has 4 samples; it has one/)
  refuses(() => resolveInto(four, imageView(r, { format: 'rgba16f', width: 64, height: 32, use: ['color'] })), 'mismatch', /the resolve view is rgba16f, and the attachment is rgba8/)
  refuses(() => resolveInto(four, imageView(r, { format: 'rgba8', width: 32, height: 32, use: ['color'] })), 'mismatch', /the resolve view is 32 x 32, and the attachment is 64 x 32/)
  refuses(() => resolveInto(four, imageView(r, { format: 'rgba8', width: 64, height: 32, use: ['sampled'] })), 'mismatch', /has no color use/)
  // An integer image never has four samples (resources.ts refuses it), so no resolve averages integers.
  refuses(() => imageView(r, { format: 'r32u', width: 64, height: 32, samples: 4, use: ['color'] }), 'invalid', /r32u cannot take four samples/)
  refuses(() => begin([{ view: four, load: 'clear', store: 'any', resolve: canvas }, { view: canvas, load: 'keep', store: 'keep' }]), 'invalid', /colors\[1\]: level 0 layer 0 of image \d+ is attached twice/)
  resolveInto(four, canvas)
  const c = lastCommand(list)
  assert.ok(c.c === 'pass')
  assert.equal(c.colors[0]?.resolve, viewHandle(canvas))
  const rec = lastRecord(list, 'pass')
  assert.equal(rec.colors[0]?.resolve, canvas)
  assert.equal(rec.samples, 4)
  list.endPass()
  consistent(list)
})

test('a render pipeline binds inside a pass whose colour formats, depth and samples are its own', () => {
  const s = scene()
  const { r, list, pipeline, canvas, layout, vertexStage, fragmentStage } = s
  list.begin()
  refuses(() => list.bindPipeline(pipeline), 'state', /a render pipeline binds inside a pass/)
  refuses(() => list.bindPipeline({} as never), 'invalid', /the pipeline is a RenderPipeline or a ComputePipeline, not an object/)
  const second = imageView(r, { format: 'rgba8', width: 64, height: 32, use: ['color'] })
  list.beginPass({ colors: [{ view: canvas, load: 'keep', store: 'keep' }, { view: second, load: 'keep', store: 'keep' }] })
  refuses(() => list.bindPipeline(pipeline), 'mismatch', /colour slot 1: render pipeline \d+ writes nothing, and the pass holds rgba8/)
  list.endPass()
  const depth = imageView(r, { format: 'depth16', width: 64, height: 32, use: ['depth'] })
  list.beginPass({ colors: [{ view: canvas, load: 'keep', store: 'keep' }], depth: { view: depth, load: 'keep', store: 'keep', readOnly: true } })
  refuses(() => list.bindPipeline(pipeline), 'mismatch', /render pipeline \d+ has no depth, and the pass has depth16 depth attachment/)
  const writer = r.device.createRenderPipeline({ layout, vertex: vertexStage, fragment: fragmentStage, depth: { format: 'depth16', write: true, compare: 'less' } })
  refuses(() => list.bindPipeline(writer), 'mismatch', /render pipeline \d+ writes depth, and the pass's depth attachment is read-only/)
  const tester = r.device.createRenderPipeline({ layout, vertex: vertexStage, fragment: fragmentStage, depth: { format: 'depth16', compare: 'less' } })
  list.bindPipeline(tester)
  const deeper = r.device.createRenderPipeline({ layout, vertex: vertexStage, fragment: fragmentStage, depth: { format: 'depth32f' } })
  refuses(() => list.bindPipeline(deeper), 'mismatch', /has depth32f depth, and the pass has depth16 depth attachment/)
  list.endPass()
  pass(s)
  refuses(() => list.bindPipeline(writer), 'mismatch', /has depth16 depth, and the pass has no depth attachment/)
  refuses(() => list.bindPipeline(r.device.createRenderPipeline({ layout, vertex: vertexStage, fragment: fragmentStage, samples: 4 })), 'mismatch', /draws 4 samples, and the pass's attachments have 1/)
  const wide = r.device.createRenderPipeline({ layout, vertex: vertexStage, fragment: { lens: fragmentStage.lens, outputs: [{ format: 'rgba16f' }] } })
  refuses(() => list.bindPipeline(wide), 'mismatch', /colour slot 0: render pipeline \d+ writes rgba16f, and the pass holds rgba8/)
  const storage = r.device.createBindingLayout({ entries: [{ binding: 0, kind: 'storage', stages: ['compute'] }] })
  const comp = r.device.createComputePipeline({ layout: r.device.createPipelineLayout({ sets: [storage] }), lens: r.device.createLens(computeLens()) })
  refuses(() => list.bindPipeline(comp), 'state', /this command sits outside a pass; end the pass first/)
  refuses(() => list.bindPipeline(scene().pipeline), 'mismatch', /belongs to another device/)
  list.bindPipeline(pipeline)
  assert.deepEqual(lastCommand(list), { c: 'pipeline', pipeline: (pipeline as RenderPipelineImpl).handle, compute: false })
  list.endPass()
  list.bindPipeline(comp)
  assert.deepEqual(lastCommand(list), { c: 'pipeline', pipeline: (comp as ComputePipelineImpl).handle, compute: true })
  assert.ok(list.uses.has(pipeline as RenderPipelineImpl) && list.uses.has(comp as ComputePipelineImpl))
  wide.destroy()
  pass(s)
  refuses(() => list.bindPipeline(wide), 'lifetime', /render pipeline \d+ is destroyed/)
  list.endPass()
  // The copy-only queue group records copies but no pass and no compute work.
  const copier = r.device.createCommandArena({ group: 1 }).allocate() as CommandListImpl
  copier.begin()
  refuses(() => copier.beginPass({ colors: [{ view: canvas, load: 'keep', store: 'keep' }] }), 'invalid', /queue group 1, which command arena \d+ records for, has no graphics ability/)
  refuses(() => copier.bindPipeline(comp), 'invalid', /queue group 1, which command arena \d+ records for, has no compute ability/)
  const src = buffer(r, 64, ['copy-src', 'copy-dst'])
  copier.copyBuffer(src, src, [{ from: 0, to: 32, size: 32 }])
  copier.updateBuffer(src, 0, new Uint32Array(4))
  copier.zeroBuffer(src, 0, 64)
  copier.barrier({ buffers: [{ before: { stages: ['copy'], access: ['copy-write'] }, after: { stages: ['host'], access: ['host-read'] }, buffer: src }] })
  copier.end()
  assert.deepEqual(copier.commands.map((c) => c.c), ['copy-buffer', 'update', 'zero', 'barrier'])
  consistent(copier)
})

test('bindSets: compatible, complete, living sets, and one aligned offset per dynamic binding that stays inside its buffer', () => {
  const { r, list, layout, set, setLayout, data, pool } = computeScene()
  list.begin()
  refuses(() => list.bindSets(layout, 0, []), 'invalid', /the sets are empty/)
  refuses(() => list.bindSets(layout, 1, [set], [0]), 'invalid', /sets 1 to 1 run past the 1 set of pipeline layout \d+/)
  refuses(() => list.bindSets(layout, 0, [set, set], [0, 0]), 'invalid', /sets 0 to 1 run past the 1 set of/)
  refuses(() => list.bindSets({} as never, 0, [set]), 'invalid', /the layout is not a PipelineLayout, but an object/)
  refuses(() => list.bindSets(layout, -1, [set]), 'invalid', /the first set -1 is not a whole number of at least 0/)
  refuses(() => list.bindSets(layout, 0, [setLayout as never]), 'invalid', /sets\[0\]: the set is not a BindingSet/)
  const plain = r.device.createBindingLayout({ entries: [{ binding: 0, kind: 'uniform', stages: ['compute'] }] })
  refuses(() => list.bindSets(layout, 0, [pool.allocate(plain)]), 'mismatch', /sets\[0\]: binding set \d+ was made from binding layout \d+, which does not match binding layout \d+, set 0 of pipeline layout \d+/)
  // A set made from an equal binding layout fits; until each binding is written it cannot be bound.
  const twin = r.device.createBindingLayout({ entries: [{ binding: 0, kind: 'storage', stages: ['compute'], dynamic: true }] })
  const twinSet = pool.allocate(twin)
  refuses(() => list.bindSets(layout, 0, [twinSet], [0]), 'state', /sets\[0\]: binding 0 of binding set \d+ was never written/)
  twinSet.write([{ binding: 0, buffer: data, size: 256 }])
  list.bindSets(layout, 0, [twinSet], [0])
  refuses(() => list.bindSets(layout, 0, [set]), 'invalid', /the sets hold 1 dynamic binding, and 0 offsets were given/)
  refuses(() => list.bindSets(layout, 0, [set], [0, 0]), 'invalid', /and 2 offsets were given/)
  refuses(() => list.bindSets(layout, 0, [set], [100]), 'invalid', /dynamic offset 100 is not a multiple of 256/)
  refuses(() => list.bindSets(layout, 0, [set], [-256]), 'invalid', /dynamic offset 0 -256 is not a whole number/)
  refuses(() => list.bindSets(layout, 0, [set], 0 as never), 'invalid', /the dynamic offsets is a list/)
  refuses(() => list.bindSets(layout, 0, [set], [1024]), 'invalid', /dynamic offset 1024 puts binding 0 of binding set "s" at bytes 1024 to 1279, past the end of buffer \d+ \(1024 bytes\)/)
  list.bindSets(layout, 0, [set], [768])
  assert.deepEqual(lastCommand(list), { c: 'sets', first: 0, sets: [(set as BindingSetImpl).handle], offsets: [768] })
  // A set holding a destroyed buffer is refused with lifetime.
  const doomed = buffer(r, 256, ['storage'])
  const held = pool.allocate(setLayout)
  held.write([{ binding: 0, buffer: doomed }])
  doomed.destroy()
  refuses(() => list.bindSets(layout, 0, [held], [0]), 'lifetime', /sets\[0\]: binding 0 of binding set \d+ holds buffer \d+, which is destroyed/)
  // Sets bind inside a pass as well, and two sets take their offsets in order.
  const two = r.device.createPipelineLayout({ sets: [setLayout, twin] })
  const canvas = imageView(r, { format: 'rgba8', width: 8, height: 8, use: ['color'] })
  list.beginPass({ colors: [{ view: canvas, load: 'keep', store: 'keep' }] })
  refuses(() => list.bindSets(two, 0, [set, twinSet], [256]), 'invalid', /the sets hold 2 dynamic bindings, and 1 offset was given/)
  list.bindSets(two, 0, [set, twinSet], [256, 512])
  assert.deepEqual(lastCommand(list), { c: 'sets', first: 0, sets: [(set as BindingSetImpl).handle, (twinSet as BindingSetImpl).handle], offsets: [256, 512] })
  list.bindSets(two, 1, [set], [0])
  list.endPass()
  // Storage bindings are written by the work that reads them.
  assert.ok(list.written.has((data as BufferImpl).memory as MemoryImpl))
  assert.ok(list.uses.has(set as BindingSetImpl) && list.uses.has(data as BufferImpl))
})

test('a draw needs a pass, a render pipeline and each vertex buffer it reads, and stays inside them', () => {
  const s = scene()
  const { r, list, pipeline, vbuf } = s
  list.begin()
  refuses(() => list.draw(3), 'state', /this command sits inside a pass, and no pass is open/)
  pass(s)
  refuses(() => list.draw(3), 'state', /no render pipeline is bound/)
  list.bindPipeline(pipeline)
  refuses(() => list.draw(3), 'state', /render pipeline \d+ reads vertex buffer 0, and none is bound there/)
  refuses(() => list.bindVertices(0, []), 'invalid', /the buffers are empty/)
  refuses(() => list.bindVertices(7, [{ buffer: vbuf }, { buffer: vbuf }]), 'limit', /slots 7 to 8 run past the device's 8 vertex buffers/)
  const indices = buffer(r, 12, ['index'])
  refuses(() => list.bindVertices(0, [{ buffer: indices }]), 'mismatch', /buffers\[0\]: buffer \d+ has no vertex use/)
  refuses(() => list.bindVertices(0, [{ buffer: vbuf, offset: 2 }]), 'invalid', /buffers\[0\]: offset 2 is not a multiple of 4/)
  refuses(() => list.bindVertices(0, [{ buffer: vbuf, offset: 76 }]), 'invalid', /offset 76 is past the end of buffer \d+ \(72 bytes\)/)
  refuses(() => list.bindVertices(0, [{ buffer: vbuf, stride: 4 }] as never), 'invalid', /the vertex buffer has no field "stride"/)
  refuses(() => list.bindVertices(0, [{ buffer: r.device.createBuffer({ size: 64, use: ['vertex'] }) }]), 'state', /is not bound to memory yet/)
  list.bindVertices(0, [{ buffer: vbuf }])
  assert.deepEqual(lastCommand(list), { c: 'vertices', first: 0, buffers: [{ buffer: bufferHandle(vbuf), offset: 0 }] })
  list.draw(3)
  const first = list.commands.length - 1
  list.draw(2, 1, 1)
  list.draw(0, 5, 100)
  refuses(() => list.draw(4), 'invalid', /the draw reads 96 bytes of vertex buffer 0 past offset 0, and buffer \d+ holds 72/)
  refuses(() => list.draw(1, 1, 3), 'invalid', /reads 96 bytes of vertex buffer 0/)
  refuses(() => list.draw(-1), 'invalid', /the vertex count -1 is not a whole number from 0 to 4294967295/)
  refuses(() => list.draw(1, 1.5), 'invalid', /the instance count 1.5 is not a whole number/)
  refuses(() => list.draw(1, 1, 2 ** 32), 'invalid', /the first vertex 4294967296/)
  refuses(() => list.draw(1, 1, 0, -2), 'invalid', /the first instance -2/)
  list.bindVertices(0, [{ buffer: vbuf, offset: 24 }])
  refuses(() => list.draw(3), 'invalid', /the draw reads 72 bytes of vertex buffer 0 past offset 24, and buffer \d+ holds 48/)
  list.draw(2, 1000)
  assert.deepEqual(list.commands[first], { c: 'draw', vertices: 3, instances: 1, firstVertex: 0, firstInstance: 0 })
  const draws = list.records.filter((x) => x.r === 'draw')
  assert.equal(draws.length, 4)
  assert.deepEqual(draws[0], { r: 'draw', at: first, pipeline, sets: [], vertices: [{ slot: 0, buffer: vbuf, offset: 0 }], indices: null, indirect: null })
  assert.deepEqual(lastRecord(list, 'draw').vertices, [{ slot: 0, buffer: vbuf, offset: 24 }])
  // Binding state ends with the pass.
  list.endPass()
  pass(s)
  refuses(() => list.draw(3), 'state', /no render pipeline is bound/)
  list.bindPipeline(pipeline)
  refuses(() => list.draw(3), 'state', /reads vertex buffer 0, and none is bound there/)
  list.endPass()
  list.end()
  consistent(list)
})

test('instance-rate buffers follow the instances of every draw; indexed draws stay inside the index buffer; indirect draws', () => {
  const s = scene()
  const { r, list, layout, vertexStage, fragmentStage } = s
  const perInstance = r.device.createRenderPipeline({
    layout,
    vertex: { lens: vertexStage.lens, buffers: [{ stride: 8, attributes: [POS] }, { stride: 16, rate: 'instance', attributes: [{ slot: 1, format: 'f32x4', offset: 0 }] }] },
    fragment: fragmentStage,
  })
  const verts = buffer(r, 24, ['vertex'])
  const each = buffer(r, 32, ['vertex'])
  const ib = buffer(r, 12, ['index'])
  const ind = buffer(r, 32, ['indirect'])
  list.begin()
  pass(s)
  list.bindPipeline(perInstance)
  list.bindVertices(0, [{ buffer: verts }, { buffer: each }])
  list.draw(3, 2)
  refuses(() => list.draw(3, 3), 'invalid', /the draw reads 48 bytes of vertex buffer 1 past offset 0, and buffer \d+ holds 32/)
  refuses(() => list.draw(3, 1, 0, 2), 'invalid', /vertex buffer 1/)
  refuses(() => list.drawIndexed(3), 'state', /no index buffer is bound/)
  refuses(() => list.drawIndexedIndirect(ind, 0), 'state', /no index buffer is bound/)
  refuses(() => list.bindIndices(ib, 1, 'u16'), 'invalid', /offset 1 is not a multiple of 2, the size of a u16 index/)
  refuses(() => list.bindIndices(ib, 2, 'u32'), 'invalid', /offset 2 is not a multiple of 4, the size of a u32 index/)
  refuses(() => list.bindIndices(ib, 0, 'u8' as never), 'invalid', /the index type "u8" is not one of u16, u32/)
  refuses(() => list.bindIndices(each, 0, 'u16'), 'mismatch', /has no index use/)
  refuses(() => list.bindIndices(ib, 16, 'u16'), 'invalid', /offset 16 is past the end of buffer \d+ \(12 bytes\)/)
  list.bindIndices(ib, 0, 'u16')
  assert.deepEqual(lastCommand(list), { c: 'indices', buffer: bufferHandle(ib), offset: 0, type: 'u16' })
  list.drawIndexed(6)
  // The vertices an indexed draw reads are not known, so only instance-rate buffers are checked.
  list.drawIndexed(6, 2, 0, -100)
  assert.deepEqual(lastCommand(list), { c: 'draw-indexed', indices: 6, instances: 2, firstIndex: 0, baseVertex: -100, firstInstance: 0 })
  refuses(() => list.drawIndexed(4, 1, 3), 'invalid', /indices 3 to 6 need 14 bytes past offset 0, and buffer \d+ holds 12/)
  refuses(() => list.drawIndexed(6, 3), 'invalid', /vertex buffer 1/)
  refuses(() => list.drawIndexed(1, 1, 0, 2 ** 31), 'invalid', /the base vertex 2147483648 is not a whole number in the range of i32/)
  refuses(() => list.drawIndexed(1, 1, 0, 0.5), 'invalid', /the base vertex 0.5/)
  list.drawIndexed(0, 1, 100)
  list.bindIndices(ib, 4, 'u32')
  list.drawIndexed(2)
  refuses(() => list.drawIndexed(3), 'invalid', /need 12 bytes past offset 4, and buffer \d+ holds 8/)
  assert.deepEqual(lastRecord(list, 'draw').indices, { buffer: ib, offset: 4, type: 'u32' })
  // Indirect draws: 16 bytes, or 20 for an indexed one, inside an indirect buffer.
  refuses(() => list.drawIndirect(verts, 0), 'mismatch', /the indirect buffer|buffer \d+ has no indirect use/)
  refuses(() => list.drawIndirect(ind, 2), 'invalid', /offset 2 is not a multiple of 4/)
  refuses(() => list.drawIndirect(ind, 20), 'invalid', /the 16 bytes at offset 20 run past the end of buffer \d+ \(32 bytes\)/)
  refuses(() => list.drawIndexedIndirect(ind, 16), 'invalid', /the 20 bytes at offset 16 run past the end/)
  list.drawIndirect(ind, 16)
  assert.deepEqual(lastCommand(list), { c: 'draw-indirect', buffer: bufferHandle(ind), offset: 16, indexed: false })
  let rec = lastRecord(list, 'draw')
  assert.deepEqual([rec.indices, rec.indirect], [null, { buffer: ind, offset: 16, size: 16 }])
  list.drawIndexedIndirect(ind, 12)
  assert.deepEqual(lastCommand(list), { c: 'draw-indirect', buffer: bufferHandle(ind), offset: 12, indexed: true })
  rec = lastRecord(list, 'draw')
  assert.deepEqual([rec.indices, rec.indirect], [{ buffer: ib, offset: 4, type: 'u32' }, { buffer: ind, offset: 12, size: 20 }])
  assert.deepEqual(rec.vertices, [{ slot: 0, buffer: verts, offset: 0 }, { slot: 1, buffer: each, offset: 0 }])
  list.endPass()
  refuses(() => list.drawIndirect(ind, 0), 'state', /sits inside a pass/)
  list.end()
  consistent(list)
})

test('viewport, scissor and blend constant sit inside a pass; constants fit the layout\'s block', () => {
  const s = scene()
  const { r, list } = s
  list.begin()
  refuses(() => list.setViewport({ x: 0, y: 0, width: 1, height: 1 }), 'state', /sits inside a pass/)
  refuses(() => list.setScissor({ x: 0, y: 0, width: 1, height: 1 }), 'state', /sits inside a pass/)
  refuses(() => list.setBlendConstant([0, 0, 0, 0]), 'state', /sits inside a pass/)
  pass(s)
  refuses(() => list.setViewport({ x: 0, y: 0, width: 0, height: 10 }), 'invalid', /the viewport is 0 x 10; its size is positive/)
  refuses(() => list.setViewport({ x: -20000, y: 0, width: 10, height: 10 }), 'invalid', /the viewport runs outside -16384 to 16383, twice the device's largest image/)
  refuses(() => list.setViewport({ x: 16380, y: 0, width: 10, height: 10 }), 'invalid', /runs outside -16384 to 16383/)
  // WebGPU's rules: at most the largest image wide and tall, and the far edge at most twice that minus one.
  refuses(() => list.setViewport({ x: -16000, y: 0, width: 20000, height: 8 }), 'limit', /the viewport is 20000 x 8, larger than the device's largest image, 8192 x 8192/)
  refuses(() => list.setViewport({ x: 0, y: -8192, width: 8, height: 8192.5 }), 'limit', /the viewport is 8 x 8192.5, larger than the device's largest image/)
  refuses(() => list.setViewport({ x: 16374, y: 0, width: 10, height: 8 }), 'invalid', /runs outside -16384 to 16383/)
  refuses(() => list.setViewport({ x: 0, y: 16374, width: 8, height: 10 }), 'invalid', /runs outside -16384 to 16383/)
  refuses(() => list.setViewport({ x: -16384.5, y: 0, width: 8, height: 8 }), 'invalid', /runs outside -16384 to 16383/)
  refuses(() => list.setViewport({ x: 0, y: 0, width: 10, height: 10, near: 2 }), 'invalid', /the depth range 2 to 1 is outside 0 to 1/)
  refuses(() => list.setViewport({ x: 0, y: 0, width: 10, height: 10, far: -1 }), 'invalid', /the depth range 0 to -1/)
  refuses(() => list.setViewport({ x: 0, y: 0, width: 64, height: 32, near: 1, far: 0 }), 'invalid', /the depth range 1 to 0 runs backwards; near is at most far/)
  refuses(() => list.setViewport({ x: 0, y: 0, width: 64, height: 32, near: 0.5, far: 0.25 }), 'invalid', /the depth range 0.5 to 0.25 runs backwards/)
  refuses(() => list.setViewport({ x: Number.NaN, y: 0, width: 10, height: 10 }), 'invalid', /x NaN is not a finite number/)
  refuses(() => list.setViewport({ x: 0, y: 0, width: 10, height: 10, depth: 1 } as never), 'invalid', /the viewport has no field "depth"/)
  list.setViewport({ x: -8, y: 4.5, width: 100, height: 50 })
  assert.deepEqual(lastCommand(list), { c: 'viewport', x: -8, y: 4.5, width: 100, height: 50, near: 0, far: 1 })
  list.setViewport({ x: 0, y: 0, width: 64, height: 32, near: 0.75 })
  list.setViewport({ x: 0, y: 0, width: 64, height: 32, near: 0.5, far: 0.5 })
  assert.deepEqual(lastCommand(list), { c: 'viewport', x: 0, y: 0, width: 64, height: 32, near: 0.5, far: 0.5 })
  list.setViewport({ x: -16384, y: -16384, width: 8192, height: 8192 })
  list.setViewport({ x: 16373, y: 8191, width: 10, height: 8192 })
  assert.deepEqual(lastCommand(list), { c: 'viewport', x: 16373, y: 8191, width: 10, height: 8192, near: 0, far: 1 })
  refuses(() => list.setScissor({ x: 0, y: 0, width: 65, height: 32 }), 'invalid', /the scissor 0,0 65 x 32 runs outside the pass's 64 x 32/)
  refuses(() => list.setScissor({ x: 60, y: 30, width: 4, height: 3 }), 'invalid', /the scissor 60,30 4 x 3/)
  refuses(() => list.setScissor({ x: 0.5, y: 0, width: 1, height: 1 }), 'invalid', /x 0.5 is not a whole number/)
  list.setScissor({ x: 32, y: 16, width: 32, height: 16 })
  assert.deepEqual(lastCommand(list), { c: 'scissor', x: 32, y: 16, width: 32, height: 16 })
  refuses(() => list.setBlendConstant([1, 1, 1] as never), 'invalid', /the blend constant is four numbers, not a list/)
  refuses(() => list.setBlendConstant(undefined as never), 'invalid', /the blend constant is four numbers/)
  refuses(() => list.setBlendConstant([1, 1, 1, Number.POSITIVE_INFINITY]), 'invalid', /the blend constant channel 3 Infinity is not a finite number/)
  list.setBlendConstant([0.25, 0.5, 0.75, 1])
  assert.deepEqual(lastCommand(list), { c: 'blend-constant', rgba: [0.25, 0.5, 0.75, 1] })
  refuses(() => list.setConstants(s.layout, 0, new Float32Array(1)), 'mismatch', /pipeline layout \d+ has no inline constants/)
  const withConstants = r.device.createPipelineLayout({ sets: [], constants: { size: 16, stages: ['vertex'] } })
  refuses(() => list.setConstants(withConstants, 2, new Float32Array(1)), 'invalid', /offset 2 is not a multiple of 4/)
  refuses(() => list.setConstants(withConstants, 0, [1, 2] as never), 'invalid', /the data is a typed array or a DataView, not a list/)
  refuses(() => list.setConstants(withConstants, 0, new Uint8Array(3)), 'invalid', /the data holds 3 bytes; it holds a positive multiple of 4/)
  refuses(() => list.setConstants(withConstants, 0, new Uint8Array(0)), 'invalid', /the data holds 0 bytes/)
  refuses(() => list.setConstants(withConstants, 12, new Float32Array(2)), 'invalid', /bytes 12 to 19 run past the 16 bytes of constants of pipeline layout \d+/)
  const source = new Float32Array([1, 2, 3, 4])
  list.setConstants(withConstants, 0, source)
  source[0] = 9
  assert.deepEqual(lastCommand(list), { c: 'constants', offset: 0, bytes: new Uint8Array(new Float32Array([1, 2, 3, 4]).buffer) })
  // A view into a larger buffer passes only its own bytes.
  list.setConstants(withConstants, 8, new DataView(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer, 4, 4))
  assert.deepEqual(lastCommand(list), { c: 'constants', offset: 8, bytes: new Uint8Array([5, 6, 7, 8]) })
  list.endPass()
  list.setConstants(withConstants, 4, new Uint32Array([7]))
  list.end()
  assert.equal(list.records.length, 2)
  consistent(list)
})

test('a viewport is held to the device\'s own largest image, as WebGPU holds it to its largest 2D texture', () => {
  const s = scene({ limits: { imageSize: 64 } })
  const { list } = s
  list.begin()
  pass(s)
  refuses(() => list.setViewport({ x: 0, y: 0, width: 65, height: 8 }), 'limit', /the viewport is 65 x 8, larger than the device's largest image, 64 x 64/)
  refuses(() => list.setViewport({ x: 100, y: 0, width: 28, height: 8 }), 'invalid', /the viewport runs outside -128 to 127, twice the device's largest image/)
  refuses(() => list.setViewport({ x: 0, y: -129, width: 8, height: 8 }), 'invalid', /runs outside -128 to 127/)
  list.setViewport({ x: 63, y: -128, width: 64, height: 64 })
  assert.deepEqual(lastCommand(list), { c: 'viewport', x: 63, y: -128, width: 64, height: 64, near: 0, far: 1 })
  list.endPass()
  list.end()
})

/** A compute lens reading a 16-byte uniform block at set 0 binding 1, writing storage at binding 0. */
function scaleLens(): LensModule {
  const b = lens('compute', { group: [1, 1, 1] })
  const data = b.storage(0, 0, { items: arrayOf('f32') }, { writable: true })
  const k = b.uniform(0, 1, { scale: 'f32x4' })
  b.write(data, ['items', 0], b.pick(b.read(k, 'scale'), 'x'))
  return b.finish()
}

test('a dispatch needs a compute pipeline outside a pass, every set it reads bound and large enough, and counts within the limit', () => {
  const { r, list, pipeline, layout, set, setLayout, data, pool } = computeScene()
  list.begin()
  refuses(() => list.dispatch(1), 'state', /no compute pipeline is bound/)
  list.bindPipeline(pipeline)
  refuses(() => list.dispatch(1), 'state', /compute pipeline \d+ reads set 0, and no set is bound there/)
  const plain = r.device.createBindingLayout({ entries: [{ binding: 0, kind: 'storage', stages: ['compute'] }] })
  const plainSet = pool.allocate(plain)
  plainSet.write([{ binding: 0, buffer: data }])
  list.bindSets(r.device.createPipelineLayout({ sets: [plain] }), 0, [plainSet])
  refuses(() => list.dispatch(1), 'mismatch', /binding set \d+, bound at set 0, does not match set 0 of pipeline layout \d+, which compute pipeline \d+ reads/)
  list.bindSets(layout, 0, [set], [256])
  refuses(() => list.dispatch(65536), 'limit', /65536 workgroups along x is more than the device allows, 65535/)
  refuses(() => list.dispatch(1, 1, 70000), 'limit', /70000 workgroups along z/)
  refuses(() => list.dispatch(-1), 'invalid', /x -1 is not a whole number from 0 to 4294967295/)
  list.dispatch(4, 2)
  assert.deepEqual(lastCommand(list), { c: 'dispatch', x: 4, y: 2, z: 1 })
  const rec = lastRecord(list, 'dispatch')
  assert.deepEqual(rec, { r: 'dispatch', at: list.commands.length - 1, pipeline, sets: [{ index: 0, set, bindings: [{ entry: setLayout.entries[0], buffer: data, offset: 256, size: 256 }] }], indirect: null })
  // The record keeps what it saw: binding the set again later does not change it.
  list.bindSets(layout, 0, [set], [0])
  const binding = rec.sets[0].bindings[0]
  assert.ok('buffer' in binding && binding.offset === 256)
  refuses(() => list.dispatchIndirect(data, 1016), 'invalid', /the 12 bytes at offset 1016 run past the end of buffer \d+ \(1024 bytes\)/)
  refuses(() => list.dispatchIndirect(buffer(r, 64, ['storage']), 0), 'mismatch', /has no indirect use/)
  // The bound set writes `data` as storage, so the same dispatch cannot read its arguments from it (usage scope).
  refuses(() => list.dispatchIndirect(data, 1012), 'invalid', /is written as storage through binding 0 of set 0 and read as indirect arguments in one dispatch/)
  const args = buffer(r, 1024, ['indirect'])
  list.dispatchIndirect(args, 1012)
  assert.deepEqual(lastCommand(list), { c: 'dispatch-indirect', buffer: bufferHandle(args), offset: 1012 })
  assert.deepEqual(lastRecord(list, 'dispatch').indirect, { buffer: args, offset: 1012, size: 12 })
  const canvas = imageView(r, { format: 'rgba8', width: 8, height: 8, use: ['color'] })
  list.beginPass({ colors: [{ view: canvas, load: 'keep', store: 'keep' }] })
  refuses(() => list.dispatch(1), 'state', /this command sits outside a pass/)
  refuses(() => list.dispatchIndirect(data, 0), 'state', /this command sits outside a pass/)
  list.endPass()
  refuses(() => list.dispatch(1), 'state', /no compute pipeline is bound/)
  list.end()
  consistent(list)
})

test('a buffer binding smaller than the block a pipeline reads through it is refused at the dispatch', () => {
  const r = rig()
  const list = r.device.createCommandArena().allocate() as CommandListImpl
  const setLayout = r.device.createBindingLayout({ entries: [{ binding: 0, kind: 'storage', stages: ['compute'] }, { binding: 1, kind: 'uniform', stages: ['compute'] }] })
  const layout = r.device.createPipelineLayout({ sets: [setLayout] })
  const p = r.device.createComputePipeline({ layout, lens: r.device.createLens(scaleLens()) })
  assert.deepEqual((p as ComputePipelineImpl).uses, [{ set: 0, binding: 0, minSize: 0 }, { set: 0, binding: 1, minSize: 16 }])
  const set = r.device.createBindingPool({ sets: 1 }).allocate(setLayout)
  const u = buffer(r, 256, ['uniform'])
  set.write([{ binding: 0, buffer: buffer(r, 64, ['storage']) }, { binding: 1, buffer: u, size: 8 }])
  list.begin()
  list.bindPipeline(p)
  list.bindSets(layout, 0, [set])
  refuses(() => list.dispatch(1), 'mismatch', /binding 1 of set 0 holds 8 bytes, and compute pipeline \d+ reads a block of 16/)
  set.write([{ binding: 1, buffer: u, size: 16 }])
  refuses(() => list.dispatch(1), 'mismatch', /holds 8 bytes/)
  list.bindSets(layout, 0, [set])
  list.dispatch(1)
  list.end()
  // The set was written after this list first recorded it, so the list must be recorded again.
  assert.equal(list.state, 'invalid')
  list.reset()
  list.begin()
  list.bindPipeline(p)
  list.bindSets(layout, 0, [set])
  list.dispatch(1)
  list.end()
  assert.equal(list.state, 'ready')
})

test('copyBuffer: aligned regions inside both buffers that never overlap what the copy writes', () => {
  const r = rig()
  const list = r.device.createCommandArena().allocate() as CommandListImpl
  const a = buffer(r, 1024, ['copy-src', 'copy-dst'])
  const b = buffer(r, 256, ['copy-dst'])
  const v = buffer(r, 256, ['vertex'])
  const one = [{ from: 0, to: 0, size: 4 }]
  list.begin()
  refuses(() => list.copyBuffer(a, b, []), 'invalid', /the regions are empty/)
  refuses(() => list.copyBuffer(a, b, 'all' as never), 'invalid', /the regions is a list, not "all"/)
  refuses(() => list.copyBuffer(v, b, one), 'mismatch', /buffer \d+ has no copy-src use/)
  refuses(() => list.copyBuffer(a, v, one), 'mismatch', /buffer \d+ has no copy-dst use/)
  refuses(() => list.copyBuffer(b, a, one), 'mismatch', /has no copy-src use/)
  refuses(() => list.copyBuffer(a, b, [{ from: 2, to: 0, size: 4 }]), 'invalid', /regions\[0\]: from 2 is not a multiple of 4/)
  refuses(() => list.copyBuffer(a, b, [{ from: 0, to: 6, size: 4 }]), 'invalid', /regions\[0\]: to 6 is not a multiple of 4/)
  refuses(() => list.copyBuffer(a, b, [{ from: 0, to: 0, size: 6 }]), 'invalid', /regions\[0\]: the size 6 is not a multiple of 4/)
  refuses(() => list.copyBuffer(a, b, [{ from: 0, to: 0, size: 0 }]), 'invalid', /the size 0 is not a whole number of at least 1/)
  refuses(() => list.copyBuffer(a, b, [{ from: 1020, to: 0, size: 8 }]), 'invalid', /bytes 1020 to 1027 run past the end of buffer \d+ \(1024 bytes\)/)
  refuses(() => list.copyBuffer(a, b, [{ from: 0, to: 252, size: 8 }]), 'invalid', /bytes 252 to 259 run past the end of buffer \d+ \(256 bytes\)/)
  refuses(() => list.copyBuffer(a, a, [{ from: 0, to: 4, size: 8 }]), 'invalid', /regions\[0\] reads and writes overlapping bytes of buffer \d+/)
  refuses(() => list.copyBuffer(a, b, [{ from: 0, to: 0, size: 16 }, { from: 64, to: 8, size: 16 }]), 'invalid', /regions\[0\] and regions\[1\] write overlapping bytes of buffer \d+/)
  refuses(() => list.copyBuffer(a, a, [{ from: 0, to: 512, size: 16 }, { from: 64, to: 8, size: 16 }]), 'invalid', /regions\[1\] writes bytes of buffer \d+ that regions\[0\] reads/)
  refuses(() => list.copyBuffer(a, a, [{ from: 64, to: 8, size: 16 }, { from: 0, to: 512, size: 16 }]), 'invalid', /regions\[0\] writes bytes of buffer \d+ that regions\[1\] reads/)
  refuses(() => list.copyBuffer(a, b, [{ from: 0, to: 0, size: 4, extra: 1 }] as never), 'invalid', /the region has no field "extra"/)
  refuses(() => list.copyBuffer(a, r.device.createBuffer({ size: 64, use: ['copy-dst'] }), one), 'state', /is not bound to memory yet/)
  assert.deepEqual([list.commands.length, list.uses.size, list.written.size], [0, 0, 0])
  list.copyBuffer(a, a, [{ from: 0, to: 512, size: 256 }, { from: 256, to: 768, size: 256 }])
  // Two regions may read the same bytes, and touching regions do not overlap.
  list.copyBuffer(a, b, [{ from: 0, to: 0, size: 16 }, { from: 0, to: 16, size: 16 }])
  assert.deepEqual(lastCommand(list), { c: 'copy-buffer', src: bufferHandle(a), dst: bufferHandle(b), regions: [{ from: 0, to: 0, size: 16 }, { from: 0, to: 16, size: 16 }] })
  assert.deepEqual(lastRecord(list, 'copy-buffer'), { r: 'copy-buffer', at: 1, src: a, dst: b, regions: [{ from: 0, to: 0, size: 16 }, { from: 0, to: 16, size: 16 }] })
  assert.deepEqual([...list.written], [(a as BufferImpl).memory, (b as BufferImpl).memory])
  const canvas = imageView(r, { format: 'rgba8', width: 8, height: 8, use: ['color'] })
  list.beginPass({ colors: [{ view: canvas, load: 'keep', store: 'keep' }] })
  refuses(() => list.copyBuffer(a, b, one), 'state', /this command sits outside a pass; end the pass first/)
  refuses(() => list.updateBuffer(b, 0, new Uint32Array(1)), 'state', /sits outside a pass/)
  refuses(() => list.zeroBuffer(b, 0, 4), 'state', /sits outside a pass/)
  list.endPass()
  list.end()
  consistent(list)
})

test('copies between buffers and images: texel-aligned offsets, rows that fit and align, regions inside the image', () => {
  const r = rig()
  const list = r.device.createCommandArena().allocate() as CommandListImpl
  const img = image(r, { format: 'rgba8', width: 64, height: 32, levels: 2, layers: 2, use: ['copy-dst', 'copy-src', 'sampled'] })
  const up = buffer(r, 16384, ['copy-src', 'copy-dst'])
  const into = (region: unknown, offset = 0, rowBytes = 256): void => list.copyBufferToImage(up, img, [{ offset, rowBytes, region } as never])
  list.begin()
  refuses(() => into({ width: 64, height: 1 }, 2), 'invalid', /regions\[0\]: the buffer offset 2 is not a multiple of 4, the bytes of one rgba8 texel/)
  refuses(() => into({ width: 32, height: 1 }, 0, 100), 'invalid', /rowBytes 100 is less than one row of the region, 128 bytes/)
  refuses(() => into({ width: 32, height: 2 }, 0, 128), 'invalid', /rowBytes 128 is not a multiple of 256, which a copy of more than one row needs/)
  refuses(() => into({ width: 64, height: 2 }, 16128), 'invalid', /the rows reach byte 16640, past the end of buffer \d+ \(16384 bytes\)/)
  refuses(() => into({ x: 60, width: 8, height: 1 }), 'invalid', /the image region 60,0 8 x 1 runs outside level 0 of image \d+ \(64 x 32\)/)
  refuses(() => into({ level: 1, width: 64, height: 1 }), 'invalid', /the image region 0,0 64 x 1 runs outside level 1 of image \d+ \(32 x 16\)/)
  refuses(() => into({ level: 2, width: 1, height: 1 }), 'invalid', /image \d+ has no level 2; it has 2/)
  refuses(() => into({ layer: 2, width: 1, height: 1 }), 'invalid', /image \d+ has no layer 2; it has 2/)
  refuses(() => into({ width: 0, height: 1 }), 'invalid', /the image region width 0 is not a whole number of at least 1/)
  refuses(() => into({ width: 1, height: 1, depth: 1 }), 'invalid', /the image region has no field "depth"/)
  refuses(() => list.copyBufferToImage(up, img, [{ offset: 0, rowBytes: 256, region: { width: 16, height: 2 } }, { offset: 0, rowBytes: 256, region: { x: 8, y: 1, width: 8, height: 1 } }]), 'invalid', /regions\[0\] and regions\[1\] write overlapping texels of image \d+/)
  assert.equal(list.commands.length, 0)
  // One row needs no row alignment.
  into({ width: 32, height: 1 }, 4, 128)
  list.copyBufferToImage(up, img, [{ offset: 0, rowBytes: 256, region: { width: 64, height: 32 } }, { offset: 0, rowBytes: 256, region: { layer: 1, width: 64, height: 32 } }])
  const full = { level: 0, x: 0, y: 0, width: 64, height: 32 }
  const regions = [{ offset: 0, rowBytes: 256, region: { ...full, layer: 0 } }, { offset: 0, rowBytes: 256, region: { ...full, layer: 1 } }]
  assert.deepEqual(lastCommand(list), { c: 'copy-buffer-image', src: bufferHandle(up), dst: (img as ImageImpl).handle('test'), regions })
  assert.deepEqual(lastRecord(list, 'copy-buffer-image'), { r: 'copy-buffer-image', at: 1, src: up, dst: img, regions })
  // Depth images go only into buffers; four-sample images have no copy use at all.
  const depth = image(r, { format: 'depth16', width: 16, height: 16, use: ['depth', 'copy-src', 'copy-dst'] })
  refuses(() => list.copyBufferToImage(up, depth, [{ offset: 0, rowBytes: 256, region: { width: 16, height: 16 } }]), 'invalid', /image \d+ is depth16; a depth image is copied only into a buffer/)
  list.copyImageToBuffer(depth, up, [{ offset: 4, rowBytes: 32, region: { width: 16, height: 1 } }])
  refuses(() => list.copyImageToBuffer(depth, up, [{ offset: 1, rowBytes: 32, region: { width: 16, height: 1 } }]), 'invalid', /the buffer offset 1 is not a multiple of 2, the bytes of one depth16 texel/)
  refuses(() => list.copyImageToBuffer(depth, up, [{ offset: 2, rowBytes: 32, region: { width: 16, height: 1 } }]), 'invalid', /the buffer offset 2 is not a multiple of 4, which a copy of a depth image needs/)
  const ms = image(r, { format: 'rgba8', width: 16, height: 16, samples: 4, use: ['color'] })
  refuses(() => list.copyImageToBuffer(ms, up, [{ offset: 0, rowBytes: 256, region: { width: 16, height: 16 } }]), 'mismatch', /image \d+ has no copy-src use/)
  const loose = r.device.createImage({ format: 'rgba8', width: 4, height: 4, use: ['copy-dst'] })
  refuses(() => list.copyBufferToImage(up, loose, [{ offset: 0, rowBytes: 16, region: { width: 4, height: 1 } }]), 'state', /is not bound to memory yet/)
  refuses(() => list.copyBufferToImage(buffer(r, 64, ['copy-dst']), img, [{ offset: 0, rowBytes: 16, region: { width: 4, height: 1 } }]), 'mismatch', /has no copy-src use/)
  // Two regions read out of an image never write the same bytes of the buffer.
  refuses(() => list.copyImageToBuffer(img, up, [{ offset: 0, rowBytes: 256, region: { width: 64, height: 2 } }, { offset: 256, rowBytes: 256, region: { y: 4, width: 64, height: 1 } }]), 'invalid', /regions\[0\] and regions\[1\] write overlapping bytes of buffer \d+/)
  list.copyImageToBuffer(img, up, [{ offset: 0, rowBytes: 256, region: { width: 64, height: 2 } }, { offset: 512, rowBytes: 256, region: { y: 4, width: 64, height: 1 } }])
  assert.deepEqual(lastRecord(list, 'copy-image-buffer').regions, [
    { offset: 0, rowBytes: 256, region: { level: 0, layer: 0, x: 0, y: 0, width: 64, height: 2 } },
    { offset: 512, rowBytes: 256, region: { level: 0, layer: 0, x: 0, y: 4, width: 64, height: 1 } },
  ])
  // Rows that interleave in the gaps between each other's rows are apart; one shared byte is not.
  list.copyImageToBuffer(img, up, [{ offset: 0, rowBytes: 256, region: { width: 32, height: 4 } }, { offset: 128, rowBytes: 256, region: { x: 32, width: 32, height: 4 } }])
  list.copyImageToBuffer(img, up, [{ offset: 0, rowBytes: 512, region: { width: 16, height: 3 } }, { offset: 128, rowBytes: 256, region: { y: 8, width: 16, height: 5 } }])
  refuses(() => list.copyImageToBuffer(img, up, [{ offset: 0, rowBytes: 512, region: { width: 16, height: 3 } }, { offset: 488, rowBytes: 256, region: { y: 8, width: 16, height: 5 } }]), 'invalid', /regions\[0\] and regions\[1\] write overlapping bytes/)
  refuses(() => list.copyImageToBuffer(img, up, [{ offset: 0, rowBytes: 256, region: { width: 32, height: 4 } }, { offset: 124, rowBytes: 256, region: { x: 32, width: 32, height: 4 } }]), 'invalid', /regions\[0\] and regions\[1\] write overlapping bytes/)
  refuses(() => list.copyImageToBuffer(img, up, [{ offset: 896, rowBytes: 256, region: { width: 1, height: 1 } }, { offset: 128, rowBytes: 256, region: { x: 32, width: 32, height: 4 } }]), 'invalid', /regions\[0\] and regions\[1\] write overlapping bytes/)
  list.end()
  consistent(list)
})

test('copyImage keeps the format, refuses depth, and keeps regions inside and apart', () => {
  const r = rig()
  const list = r.device.createCommandArena().allocate() as CommandListImpl
  const a = image(r, { format: 'rgba8', width: 64, height: 32, layers: 2, use: ['copy-src', 'copy-dst'] })
  const b = image(r, { format: 'rgba16f', width: 64, height: 32, use: ['copy-dst'] })
  const square = { width: 8, height: 8 }
  list.begin()
  refuses(() => list.copyImage(a, b, [{ from: square, to: {} }]), 'mismatch', /image \d+ is rgba8 and image \d+ is rgba16f; a copy between images keeps the format/)
  const d1 = image(r, { format: 'depth16', width: 16, height: 16, use: ['depth', 'copy-src'] })
  const d2 = image(r, { format: 'depth16', width: 16, height: 16, use: ['depth', 'copy-dst'] })
  refuses(() => list.copyImage(d1, d2, [{ from: square, to: {} }]), 'invalid', /depth16 is a depth format; a depth image is copied only into a buffer/)
  refuses(() => list.copyImage(b, a, [{ from: square, to: {} }]), 'mismatch', /has no copy-src use/)
  refuses(() => list.copyImage(a, a, [{ from: square, to: { x: 4, y: 4 } }]), 'invalid', /regions\[0\]: the region reads and writes overlapping texels of image \d+/)
  refuses(() => list.copyImage(a, a, [{ from: square, to: { x: 60 } }]), 'invalid', /the destination region 60,0 8 x 8 runs outside level 0 of image \d+ \(64 x 32\)/)
  refuses(() => list.copyImage(a, a, [{ from: { x: 60, ...square }, to: { layer: 1 } }]), 'invalid', /the source region 60,0 8 x 8 runs outside/)
  refuses(() => list.copyImage(a, a, [{ from: square, to: { layer: 2 } }]), 'invalid', /has no layer 2; it has 2/)
  refuses(() => list.copyImage(a, a, [{ from: square, to: { layer: 1 } }, { from: { x: 16, ...square }, to: { layer: 1, x: 4 } }]), 'invalid', /regions\[0\] and regions\[1\] write overlapping texels of image \d+/)
  refuses(() => list.copyImage(a, a, [{ from: square, to: { x: 32 } }, { from: { x: 16, ...square }, to: { x: 4 } }]), 'invalid', /regions\[1\] writes texels of image \d+ that regions\[0\] reads/)
  refuses(() => list.copyImage(a, a, [{ from: square, to: { x: 16, extra: 0 } }] as never), 'invalid', /the destination corner has no field "extra"/)
  assert.equal(list.commands.length, 0)
  list.copyImage(a, a, [{ from: { width: 64, height: 32 }, to: { layer: 1 } }])
  const placed = [{ from: { level: 0, layer: 0, x: 0, y: 0, width: 64, height: 32 }, to: { level: 0, layer: 1, x: 0, y: 0 } }]
  assert.deepEqual(lastCommand(list), { c: 'copy-image', src: (a as ImageImpl).handle('test'), dst: (a as ImageImpl).handle('test'), regions: placed })
  assert.deepEqual(lastRecord(list, 'copy-image'), { r: 'copy-image', at: 0, src: a, dst: a, regions: placed })
  list.copyImage(a, a, [{ from: square, to: { x: 8 } }, { from: { x: 32, ...square }, to: { x: 48, y: 8 } }])
  list.end()
  consistent(list)
})

test('a copy carries at most COPY_REGIONS regions, and its byte checks sort and sweep instead of comparing every pair', () => {
  const r = rig()
  const list = r.device.createCommandArena().allocate() as CommandListImpl
  const a = buffer(r, 65536, ['copy-src', 'copy-dst'])
  const b = buffer(r, 65536, ['copy-dst'])
  const img = image(r, { format: 'rgba8', width: 1024, height: 2048, use: ['copy-src', 'copy-dst'] })
  const each = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i))
  list.begin()
  assert.equal(COPY_REGIONS, 1024)
  refuses(() => list.copyBuffer(a, b, each(1025, (i) => ({ from: 4 * i, to: 4 * i, size: 4 }))), 'limit', /copyBuffer: 1025 regions is more than one copy carries, 1024/)
  refuses(() => list.copyBufferToImage(a, img, each(1025, (i) => ({ offset: 0, rowBytes: 4, region: { x: i % 1024, y: i >> 10, width: 1, height: 1 } }))), 'limit', /copyBufferToImage: 1025 regions/)
  refuses(() => list.copyImageToBuffer(img, b, each(1025, (i) => ({ offset: 4 * i, rowBytes: 4, region: { width: 1, height: 1 } }))), 'limit', /copyImageToBuffer: 1025 regions/)
  refuses(() => list.copyImage(img, img, each(1025, () => ({ from: { width: 1, height: 1 }, to: { x: 1 } }))), 'limit', /copyImage: 1025 regions/)
  list.copyBuffer(a, b, each(COPY_REGIONS, (i) => ({ from: 4 * i, to: 4 * i, size: 4 })))
  // The one clash among many writes is found, the lower region named first (the writes run backwards here).
  const backwards = each(1023, (i) => ({ from: 0, to: 64 * (1022 - i), size: 4 }))
  list.copyBuffer(a, b, backwards)
  refuses(() => list.copyBuffer(a, b, [...backwards, { from: 0, to: 316, size: 8 }]), 'invalid', /copyBuffer: regions\[1017\] and regions\[1023\] write overlapping bytes of buffer \d+/)
  // Within one buffer, a write that meets another region's read is found too.
  const halves = each(1023, (i) => ({ from: 32768 + 16 * i, to: 16 * i, size: 16 }))
  list.copyBuffer(a, a, halves)
  refuses(() => list.copyBuffer(a, a, [...halves, { from: 49136, to: 32848, size: 16 }]), 'invalid', /regions\[1023\] writes bytes of buffer \d+ that regions\[5\] reads/)
  refuses(() => list.copyBuffer(a, a, [...halves, { from: 20000, to: 20008, size: 16 }]), 'invalid', /regions\[1023\] reads and writes overlapping bytes of buffer \d+/)
  // 1024 one-texel columns of 2048 rows whose spans all meet and whose rows interleave: every pair compared row by row
  // took about a billion steps; the sweep takes about two million.
  const columns = each(COPY_REGIONS, (i) => ({ offset: 4 * i, rowBytes: 4096, region: { x: i, width: 1, height: 2048 } }))
  const wide = buffer(r, 4096 * 2048, ['copy-dst'])
  list.copyImageToBuffer(img, wide, columns)
  refuses(() => list.copyImageToBuffer(img, wide, [...columns.slice(0, 1023), { offset: 12, rowBytes: 4096, region: { x: 1023, width: 1, height: 2048 } }]), 'invalid', /regions\[3\] and regions\[1023\] write overlapping bytes of buffer \d+/)
  // A clash past a region in between, and runs of regions whose spans meet apart from each other.
  const rows = (offset: number, width: number, height: number, rowBytes = 256): unknown => ({ offset, rowBytes, region: { width, height } })
  list.copyImageToBuffer(img, wide, [rows(0, 16, 4), rows(64, 16, 4), rows(760, 2, 1), rows(8192, 16, 4), rows(8256, 16, 4)] as never)
  refuses(() => list.copyImageToBuffer(img, wide, [rows(0, 16, 4), rows(64, 16, 4), rows(764, 2, 1)] as never), 'invalid', /regions\[0\] and regions\[2\] write overlapping bytes/)
  refuses(() => list.copyImageToBuffer(img, wide, [rows(0, 16, 4), rows(8192, 16, 4), rows(64, 16, 4), rows(8240, 16, 4)] as never), 'invalid', /regions\[1\] and regions\[3\] write overlapping bytes/)
  list.end()
  consistent(list)
})

test('updateBuffer carries a few aligned bytes; zeroBuffer clears an aligned range', () => {
  const r = rig({ limits: { updateSize: 16 } })
  const list = r.device.createCommandArena({ group: 1 }).allocate() as CommandListImpl
  const b = buffer(r, 64, ['copy-dst'])
  list.begin()
  refuses(() => list.updateBuffer(b, 2, new Uint8Array(4)), 'invalid', /offset 2 is not a multiple of 4/)
  refuses(() => list.updateBuffer(b, 0, new Uint8Array(20)), 'limit', /20 bytes is more than one update may carry, 16/)
  refuses(() => list.updateBuffer(b, 56, new Uint8Array(16)), 'invalid', /bytes 56 to 71 run past the end of buffer \d+ \(64 bytes\)/)
  refuses(() => list.updateBuffer(b, 0, 'abcd' as never), 'invalid', /the data is a typed array or a DataView, not "abcd"/)
  refuses(() => list.updateBuffer(buffer(r, 64, ['copy-src']), 0, new Uint8Array(4)), 'mismatch', /has no copy-dst use/)
  const data = new Uint32Array([1, 2])
  list.updateBuffer(b, 8, data)
  data[0] = 5
  assert.deepEqual(lastCommand(list), { c: 'update', dst: bufferHandle(b), offset: 8, bytes: new Uint8Array([1, 0, 0, 0, 2, 0, 0, 0]) })
  assert.deepEqual(lastRecord(list, 'update'), { r: 'update', at: 0, dst: b, offset: 8, size: 8 })
  refuses(() => list.zeroBuffer(b, 2, 8), 'invalid', /the offset 2 and size 8 are not both multiples of 4/)
  refuses(() => list.zeroBuffer(b, 0, 6), 'invalid', /the offset 0 and size 6 are not both multiples of 4/)
  refuses(() => list.zeroBuffer(b, 0, 0), 'invalid', /the size 0 is not a whole number of at least 1/)
  refuses(() => list.zeroBuffer(b, 32, 64), 'invalid', /bytes 32 to 95 run past the end of buffer \d+ \(64 bytes\)/)
  list.zeroBuffer(b, 32, 32)
  assert.deepEqual(lastCommand(list), { c: 'zero', dst: bufferHandle(b), offset: 32, size: 32 })
  assert.deepEqual(lastRecord(list, 'zero'), { r: 'zero', at: 1, dst: b, offset: 32, size: 32 })
  list.end()
  consistent(list)
})

test('a barrier: at least one, names it knows, ranges inside their resources, never into blank, image barriers apart', () => {
  const r = rig()
  const list = r.device.createCommandArena().allocate() as CommandListImpl
  const buf = buffer(r, 1024, ['storage', 'copy-dst'])
  const img = image(r, { format: 'rgba8', width: 16, height: 16, levels: 3, layers: 2, use: ['sampled', 'copy-dst'] })
  const step = { before: { stages: ['copy'], access: ['copy-write'] }, after: { stages: ['fragment'], access: ['shader-read'] } } as const
  const upload = { ...step, image: img, from: 'blank', to: 'copy-dst' } as const
  list.begin()
  refuses(() => list.barrier({}), 'invalid', /the barrier holds no barrier/)
  refuses(() => list.barrier({ memory: [] }), 'invalid', /the barrier holds no barrier/)
  refuses(() => list.barrier(undefined as never), 'invalid', /the barrier info is an object, not undefined/)
  refuses(() => list.barrier({ memory: [{ before: { stages: ['raster'] }, after: step.after }] } as never), 'invalid', /memory\[0\]: the before stages entry "raster" is not one of top, indirect/)
  refuses(() => list.barrier({ memory: [{ before: { stages: [] }, after: step.after }] }), 'invalid', /memory\[0\]: the before stages is empty; it names at least one of/)
  refuses(() => list.barrier({ memory: [{ before: { stages: ['copy', 'copy'] }, after: step.after }] }), 'invalid', /the before stages names copy twice/)
  refuses(() => list.barrier({ memory: [{ before: { stages: ['copy'], access: ['copy-erase'] }, after: step.after }] } as never), 'invalid', /the before access entry "copy-erase"/)
  refuses(() => list.barrier({ memory: [{ before: step.before }] } as never), 'invalid', /the after scope is an object, not undefined/)
  refuses(() => list.barrier({ buffers: [{ ...step, buffer: buf, offset: 1024 }] }), 'invalid', /buffers\[0\]: offset 1024 is not inside buffer \d+ \(1024 bytes\)/)
  refuses(() => list.barrier({ buffers: [{ ...step, buffer: buf, offset: 512, size: 1024 }] }), 'invalid', /bytes 512 to 1535 run past the end of buffer \d+/)
  refuses(() => list.barrier({ buffers: [{ ...step, buffer: img }] } as never), 'invalid', /the buffer is not a Buffer, but an object/)
  refuses(() => list.barrier({ buffers: [{ ...step, buffer: r.device.createBuffer({ size: 16, use: ['storage'] }) }] }), 'state', /is not bound to memory yet/)
  refuses(() => list.barrier({ images: [{ ...upload, to: 'blank' }] }), 'invalid', /images\[0\]: nothing moves into blank/)
  refuses(() => list.barrier({ images: [{ ...upload, from: 'nowhere' }] } as never), 'invalid', /from "nowhere" is not one of blank, general/)
  refuses(() => list.barrier({ images: [{ ...upload, levels: { base: 2, count: 2 } }] }), 'invalid', /the levels 2 to 3 run past the 3 there are/)
  refuses(() => list.barrier({ images: [{ ...upload, layers: { base: 0, count: 3 } }] }), 'invalid', /the layers 0 to 2 run past the 2 there are/)
  refuses(() => list.barrier({ images: [{ ...upload, levels: { base: 0, count: 2 } }, { ...upload, levels: { base: 1, count: 1 }, layers: { base: 1, count: 1 } }] }), 'invalid', /images\[0\] and images\[1\] cover the same levels and layers of image \d+/)
  assert.deepEqual([list.commands.length, list.uses.size], [0, 0])
  list.barrier({ images: [{ ...upload, layers: { base: 0, count: 1 } }, { ...upload, layers: { base: 1, count: 1 } }] })
  list.barrier({
    memory: [{ before: { stages: ['compute'] }, after: { stages: ['indirect'], access: ['indirect-read'] } }],
    buffers: [{ ...step, buffer: buf }],
    images: [{ ...step, image: img, from: 'copy-dst', to: 'shader-read' }],
  })
  assert.deepEqual(lastCommand(list), { c: 'barrier' })
  assert.deepEqual(lastRecord(list, 'barrier'), {
    r: 'barrier',
    at: 1,
    memory: [{ before: { stages: ['compute'], access: [] }, after: { stages: ['indirect'], access: ['indirect-read'] } }],
    buffers: [{ ...step, buffer: buf, offset: 0, size: 1024 }],
    images: [{ ...step, image: img, from: 'copy-dst', to: 'shader-read', levels: { base: 0, count: 3 }, layers: { base: 0, count: 2 } }],
  })
  assert.ok(list.uses.has(buf as BufferImpl) && list.uses.has(img as ImageImpl))
  assert.equal(list.written.size, 0)
  const canvas = imageView(r, { format: 'rgba8', width: 8, height: 8, use: ['color'] })
  list.beginPass({ colors: [{ view: canvas, load: 'keep', store: 'keep' }] })
  refuses(() => list.barrier({ buffers: [{ ...step, buffer: buf }] }), 'state', /this command sits outside a pass/)
  list.endPass()
  list.end()
  consistent(list)
})

test('image barriers are kept apart by sorting each image\'s layer ranges level by level, not by comparing every pair', () => {
  const r = rig()
  const list = r.device.createCommandArena().allocate() as CommandListImpl
  const step = { before: { stages: ['copy'] }, after: { stages: ['copy'] } } as const
  const stack = (): Image => image(r, { format: 'r8', width: 1, height: 1, layers: 256, use: ['copy-src'] })
  const each = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i))
  const stacks = each(128, stack)
  // One barrier per layer of 128 images of 256 layers: 32,768 barriers, every pair of which was compared (about half
  // a billion comparisons, seconds); the sweep sorts 128 lists of 256.
  const layers = stacks.flatMap((img) => each(256, (l) => ({ ...step, image: img, from: 'blank', to: 'copy-src', layers: { base: l, count: 1 } }) as const))
  list.begin()
  list.barrier({ images: layers })
  // The one clash among them is found, the lower barrier named first.
  refuses(() => list.barrier({ images: [...layers, { ...layers[300], layers: { base: 40, count: 8 } }] }), 'invalid', /^command list \d+ barrier: images\[296\] and images\[32768\] cover the same levels and layers of image \d+$/)
  refuses(() => list.barrier({ images: [{ ...layers[0], layers: { base: 2, count: 2 } }, { ...layers[0], layers: { base: 0, count: 3 } }] }), 'invalid', /images\[0\] and images\[1\] cover the same levels/)
  // Levels are swept one by one: a clash is found at the one level two barriers share, and the same layers at other
  // levels, or of another image, are apart.
  const mips = image(r, { format: 'rgba8', width: 4, height: 4, levels: 3, layers: 4, use: ['sampled'] })
  const at = (levels: { base: number; count: number }, layers: { base: number; count: number }) => ({ ...step, image: mips, from: 'blank', to: 'shader-read', levels, layers }) as const
  list.barrier({ images: [at({ base: 0, count: 1 }, { base: 0, count: 4 }), at({ base: 1, count: 1 }, { base: 0, count: 4 }), at({ base: 2, count: 1 }, { base: 2, count: 2 }), at({ base: 2, count: 1 }, { base: 0, count: 2 })] })
  refuses(() => list.barrier({ images: [at({ base: 1, count: 2 }, { base: 0, count: 2 }), at({ base: 0, count: 1 }, { base: 0, count: 4 }), at({ base: 2, count: 1 }, { base: 1, count: 3 })] }), 'invalid', /images\[0\] and images\[2\] cover the same levels and layers of image \d+/)
  list.barrier({ images: [at({ base: 1, count: 2 }, { base: 0, count: 2 }), at({ base: 0, count: 1 }, { base: 0, count: 4 }), at({ base: 2, count: 1 }, { base: 2, count: 2 }), { ...layers[0], layers: { base: 0, count: 4 } }] })
  assert.equal(list.commands.length, 3)
  list.end()
  consistent(list)
})

test('groups nest, inside a pass or outside it, and end where they began', () => {
  const s = scene()
  const { list } = s
  list.begin()
  refuses(() => list.beginGroup(3 as never), 'invalid', /the label is a string, not 3/)
  refuses(() => list.endGroup(), 'state', /no group is open/)
  list.beginGroup('frame')
  pass(s)
  refuses(() => list.endGroup(), 'state', /the group was begun outside a pass and ends inside one/)
  list.beginGroup('inner')
  refuses(() => list.endPass(), 'state', /a group begun inside the pass is still open/)
  list.endGroup()
  list.endPass()
  list.endGroup()
  list.end()
  assert.deepEqual(list.commands.map((c) => c.c), ['group', 'pass', 'group', 'end-group', 'end-pass', 'end-group'])
  assert.deepEqual([list.commands[0], list.commands[2]], [{ c: 'group', label: 'frame' }, { c: 'group', label: 'inner' }])
  consistent(list)
})

test('a refused command leaves no trace; a ready list turns invalid once what it recorded is destroyed or written', () => {
  const { r, list, pipeline, layout, set, data, pool, setLayout } = computeScene()
  const dst = buffer(r, 256, ['copy-dst'])
  list.begin()
  list.bindPipeline(pipeline)
  list.bindSets(layout, 0, [set], [0])
  const uses = [...list.uses]
  const written = [...list.written]
  const count = list.commands.length
  const faults = r.faults.length
  refuses(() => list.copyBuffer(data, dst, [{ from: 0, to: 0, size: 4 }, { from: 0, to: 2, size: 4 }]), 'invalid')
  refuses(() => list.bindSets(layout, 0, [pool.allocate(setLayout)], [0]), 'state')
  assert.equal(list.commands.length, count)
  assert.deepEqual([...list.uses], uses)
  assert.deepEqual([...list.written], written)
  assert.equal(r.faults.length, faults + 2)
  assert.equal(r.faults[r.faults.length - 1].code, 'state')
  list.copyBuffer(data, dst, [{ from: 0, to: 0, size: 16 }])
  assert.ok(list.uses.has(dst as BufferImpl) && list.written.has((dst as BufferImpl).memory as MemoryImpl))
  assert.equal(list.uses.get(set as BindingSetImpl), (set as BindingSetImpl).version)
  list.dispatch(1)
  list.end()
  assert.equal(list.state, 'ready')
  assert.equal(list.stale(), null)
  // Writing a set the list recorded leaves it invalid, code state.
  set.write([{ binding: 0, buffer: data, size: 512 }])
  assert.equal(list.state, 'invalid')
  const changed = list.stale()
  assert.equal(changed?.code, 'state')
  assert.match(changed?.message ?? '', /^binding set "s" was written after command list \d+ recorded it; record the list again$/)
  refuses(() => list.dispatch(1), 'state', /the list is invalid; commands are recorded between begin\(\) and end\(\)/)
  refuses(() => list.begin(), 'state', /the list is invalid; begin\(\) takes an initial list/)
  list.reset()
  assert.equal(list.state, 'initial')
  // Destroying an object it recorded leaves it invalid, code lifetime.
  list.begin()
  list.copyBuffer(data, dst, [{ from: 0, to: 0, size: 16 }])
  list.end()
  dst.destroy()
  assert.equal(list.state, 'invalid')
  const gone = list.stale()
  assert.equal(gone?.code, 'lifetime')
  assert.match(gone?.message ?? '', /^buffer \d+, which command list \d+ recorded, is destroyed; record the list again$/)
  // A list still recording stays recording; what it used is refused from then on.
  const other = r.device.createCommandArena().allocate() as CommandListImpl
  other.begin()
  other.bindPipeline(pipeline)
  pipeline.destroy()
  assert.equal(other.state, 'recording')
  refuses(() => other.bindPipeline(pipeline), 'lifetime', /compute pipeline \d+ is destroyed/)
  refuses(() => other.dispatch(1), 'state', /reads set 0, and no set is bound there/)
  const noted: BindingSet = set
  assert.ok(noted instanceof BindingSetImpl)
})

test('a getter in a call cannot record into, end, reset or begin the same list, nor reset its arena', () => {
  const s = scene()
  const { list } = s
  list.begin()
  pass(s)
  const sneaky = (f: () => void): Viewport => {
    const v = { x: 0, y: 0, width: 8, height: 8, near: 0, far: 1 }
    return new Proxy(v, { get: (t, k) => { if (k === 'width') f(); return Reflect.get(t, k) } })
  }
  refuses(() => list.setViewport(sneaky(() => list.zeroBuffer(s.vbuf, 0, 4))), 'state', /zeroBuffer: called while another call on the list is still reading its arguments/)
  refuses(() => list.setViewport(sneaky(() => list.end())), 'state', /end: called while another call/)
  refuses(() => list.setViewport(sneaky(() => list.reset())), 'state', /reset: called while another call/)
  const arena = s.r.device.createCommandArena({ label: 'a' })
  const other = arena.allocate('o') as CommandListImpl
  other.begin()
  other.beginPass({ colors: [{ view: s.canvas, load: 'clear', store: 'keep' }] })
  refuses(() => other.setViewport(sneaky(() => arena.reset())), 'state', /"o" is in the middle of a call; reset the arena after it returns/)
  assert.equal(list.held, false)
  assert.equal(other.held, false)
  refuses(() => other.setViewport(sneaky(() => arena.destroy())), 'state', /"o" is in the middle of a call; destroy the arena after it returns/)
  list.setViewport({ x: 0, y: 0, width: 8, height: 8, near: 0, far: 1 })
  list.endPass()
  list.end()
  assert.equal(list.state, 'ready')
  assert.equal(list.commands.filter((c) => c.c === 'zero').length, 0)
  assert.equal(list.commands.filter((c) => c.c === 'viewport').length, 1)
})

test('the usage scope: in one pass a buffer is only read or only written as storage, across draws; a refused draw adds nothing', () => {
  const s = scene()
  const { r, list } = s
  const setLayout = r.device.createBindingLayout({ entries: [{ binding: 0, kind: 'storage', stages: ['fragment'] }, { binding: 1, kind: 'storage', stages: ['fragment'] }] })
  const layout = r.device.createPipelineLayout({ sets: [setLayout] })
  const pipe = r.device.createRenderPipeline({ layout, vertex: s.vertexStage, fragment: s.fragmentStage })
  const both = buffer(r, 1024, ['storage', 'vertex'], KIND.device, 'both')
  const other = buffer(r, 1024, ['storage', 'vertex'], KIND.device, 'other')
  const pool = r.device.createBindingPool({ sets: 8 })
  const writing = (b: Buffer): BindingSet => {
    const set = pool.allocate(setLayout)
    set.write([{ binding: 0, buffer: b }, { binding: 1, buffer: b }])
    return set
  }
  const draw = (vertices: Buffer, set: BindingSet): void => {
    list.bindPipeline(pipe)
    list.bindVertices(0, [{ buffer: vertices }])
    list.bindSets(layout, 0, [set])
    list.draw(3)
  }
  list.begin()
  pass(s)
  // Within one draw: two storage bindings of one buffer are fine; storage beside a vertex read is not.
  refuses(() => draw(both, writing(both)), 'invalid', /draw: buffer "both" is written as storage through binding 0 of set 0 and read as vertex buffer 0 in one pass; a resource there is only read, or written one way/)
  // That refusal added nothing: `both` may still be read here, and `other` written.
  draw(both, writing(other))
  // Across draws: `both` was read, so no later draw of the pass may write it.
  refuses(() => draw(s.vbuf, writing(both)), 'invalid', /buffer "both" is read as vertex buffer 0 and written as storage through binding 0 of set 0 in one pass/)
  refuses(() => draw(other, writing(buffer(r, 256, ['storage']))), 'invalid', /buffer "other" is written as storage through binding 0 of set 0 and read as vertex buffer 0 in one pass/)
  list.endPass()
  // A new pass is a new scope.
  pass(s)
  draw(s.vbuf, writing(both))
  list.endPass()
  list.end()
  consistent(list)
  assert.equal(list.commands.filter((c) => c.c === 'draw').length, 2)
})
