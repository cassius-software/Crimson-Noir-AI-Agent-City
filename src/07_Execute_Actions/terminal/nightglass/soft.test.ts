// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the reference renderer as a back end, end to end, through the public API only:
 * an instance over softBackend(), a device opened on its adapter, memory, resources, pipelines and command lists,
 * submitted with the barriers and layouts the ordering checker asks for, and the pixels and bytes read back through
 * readback memory. Every expectation is worked out from the rules of docs/nightglass.md (which pixel centres a
 * triangle holds, what a linear filter blends, which mip level a rate of change picks, what a blend or a resolve
 * stores), never taken from a run of the code.
 * What breaks if it is removed? The back end the tests draw with could cover the wrong pixels, read the wrong memory
 * copy, skip a barrier's worth of state, or run past its budget, and nothing would notice until the GPU back end's
 * pictures were compared against it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type {
  BindingEntry, BindingLayout, BindingSet, BindingWrite, Buffer, BufferUse, ColorAttachment, ColorOutput, CommandArena, CommandList,
  DepthAttachment, DepthState, Device, Image, ImageInfo, ImageLayout, Limits, PipelineLayout, Queue, Rect, RenderPipeline, Scope, VertexBufferLayout, View,
} from './api.ts'
import { arrayOf, lens } from './builder.ts'
import { isFault } from './fault.ts'
import type { Fault, FaultCode } from './fault.ts'
import { FORMATS } from './formats.ts'
import type { Format } from './formats.ts'
import { createInstance } from './instance.ts'
import { compile, dispatch } from './interp.ts'
import type { LensModule } from './lens.ts'
import { SOFT_HEAP, SOFT_LIMITS, SOFT_STEPS, softBackend } from './soft.ts'
import type { SoftOptions } from './soft.ts'

// ---------------------------------------------------------------------------------------------------
// The bench

const KIND = Object.freeze({ device: 0, images: 1, upload: 2, readback: 3 })
const FULL: Scope = { stages: ['all'], access: ['any-read', 'any-write'] }
const WRITES: Scope = { stages: ['all'], access: ['any-write'] }

/** A seeded linear congruential generator: the same numbers on every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function refuses(f: () => unknown, code: FaultCode, pattern?: RegExp): Fault {
  let caught: unknown = null
  try {
    f()
  } catch (e) {
    caught = e
  }
  assert.ok(isFault(caught), `expected a Fault of code ${code}, got ${caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)}`)
  assert.equal(caught.code, code, caught.message)
  if (pattern !== undefined) assert.match(caught.message, pattern)
  return caught
}

interface Pictured {
  readonly image: Image
  readonly view: View
}

/**
 * A device on the reference renderer and the chores of a test: bound resources, lists submitted with the barriers
 * the ordering checker needs (a full barrier at each end of every list, and image moves on request, with the layout
 * of each image tracked here), and images read back through readback memory.
 */
class Bench {
  readonly device: Device
  readonly queue: Queue
  private readonly arena: CommandArena
  private readonly layouts = new Map<Image, ImageLayout>()

  constructor(opts: SoftOptions = {}) {
    const instance = createInstance({ app: 'soft tests', backends: [softBackend(opts)] })
    this.device = instance.open(instance.adapters()[0], { features: ['float32-filter', 'depth-unclipped'] })
    this.queue = this.device.queue(0, 0)
    this.arena = this.device.createCommandArena()
  }

  buffer(size: number, use: readonly BufferUse[], kind: number = KIND.device): Buffer {
    const b = this.device.createBuffer({ size, use })
    const memory = this.device.allocate({ size: this.device.needs(b).size, kind })
    this.device.bind(b, memory, 0)
    return b
  }

  /** A device buffer filled with the bytes given (padded to a multiple of 4), by an update. */
  filled(use: readonly BufferUse[], data: ArrayBufferView): Buffer {
    const size = Math.ceil(data.byteLength / 4) * 4
    const b = this.buffer(size, [...use, 'copy-dst'])
    const bytes = new Uint8Array(size)
    bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    for (let at = 0; at < size; at += 65536) this.submit((l) => l.updateBuffer(b, at, bytes.subarray(at, Math.min(size, at + 65536))))
    return b
  }

  vertices(data: readonly number[]): Buffer {
    return this.filled(['vertex'], new Float32Array(data))
  }

  image(info: ImageInfo): Image {
    const img = this.device.createImage(info)
    const memory = this.device.allocate({ size: this.device.needs(img).size, kind: KIND.images })
    this.device.bind(img, memory, 0)
    this.layouts.set(img, 'blank')
    return img
  }

  /** An image to draw into, and a view of it. */
  picture(width: number, height: number, format: Format = 'rgba8', samples: 1 | 4 = 1): Pictured {
    const use: ImageInfo['use'] = samples === 4 ? [FORMATS[format].depth ? 'depth' : 'color'] : [FORMATS[format].depth ? 'depth' : 'color', 'copy-src', 'copy-dst']
    const image = this.image({ format, width, height, samples, use })
    return { image, view: this.device.createView(image) }
  }

  /** A full memory barrier, moving each image named to a layout (from the one it is in). */
  sync(l: CommandList, moves: readonly (readonly [Image, ImageLayout])[] = []): void {
    const images = moves.filter(([img, to]) => this.layouts.get(img) !== to).map(([image, to]) => {
      const from = this.layouts.get(image) ?? 'blank'
      this.layouts.set(image, to)
      return { before: WRITES, after: FULL, image, from, to }
    })
    l.barrier({ memory: [{ before: WRITES, after: FULL }], images })
  }

  /** Records a list with a full barrier at each end and submits it; the fence is signalled when submit returns. */
  submit(record: (l: CommandList) => void): void {
    const l = this.arena.allocate()
    l.begin({ once: true })
    this.sync(l)
    record(l)
    this.sync(l)
    l.end()
    const fence = this.device.createFence()
    this.queue.submit([{ lists: [l] }], fence)
    assert.ok(fence.signalled)
  }

  /** The texels of one level and layer of an image, row after row, read back through readback memory. */
  read(img: Image, level = 0, layer = 0): Uint8Array {
    const w = Math.max(1, img.width >> level)
    const h = Math.max(1, img.height >> level)
    const texel = FORMATS[img.format].bytes
    const rowBytes = Math.ceil((w * texel) / 256) * 256
    const rb = this.buffer(rowBytes * h, ['copy-dst'], KIND.readback)
    this.submit((l) => {
      this.sync(l, [[img, 'copy-src']])
      l.copyImageToBuffer(img, rb, [{ offset: 0, rowBytes, region: { level, layer, width: w, height: h } }])
    })
    const memory = rb.memory as NonNullable<Buffer['memory']>
    memory.invalidate()
    const bytes = memory.map()
    const out = new Uint8Array(w * h * texel)
    for (let y = 0; y < h; y++) out.set(bytes.subarray(y * rowBytes, y * rowBytes + w * texel), y * w * texel)
    return out
  }

  /** A buffer's bytes, read back through readback memory. */
  readBuffer(b: Buffer, offset = 0, size = b.size - offset): Uint8Array {
    const rb = this.buffer(size, ['copy-dst'], KIND.readback)
    this.submit((l) => l.copyBuffer(b, rb, [{ from: offset, to: 0, size }]))
    const memory = rb.memory as NonNullable<Buffer['memory']>
    memory.invalidate()
    return memory.map().slice()
  }

  /** Writes texels (rows packed one after another) into a level and layer through upload memory, and moves the image to `to`. */
  upload(img: Image, texels: Uint8Array, level = 0, layer = 0, to: ImageLayout = 'shader-read'): void {
    const w = Math.max(1, img.width >> level)
    const h = Math.max(1, img.height >> level)
    const row = w * FORMATS[img.format].bytes
    const rowBytes = Math.ceil(row / 256) * 256
    const src = this.buffer(Math.ceil((rowBytes * (h - 1) + row) / 4) * 4, ['copy-src'], KIND.upload)
    const memory = src.memory as NonNullable<Buffer['memory']>
    const host = memory.map()
    for (let y = 0; y < h; y++) host.set(texels.subarray(y * row, (y + 1) * row), y * rowBytes)
    memory.flush()
    this.submit((l) => {
      this.sync(l, [[img, 'copy-dst']])
      l.copyBufferToImage(src, img, [{ offset: 0, rowBytes, region: { level, layer, width: w, height: h } }])
      this.sync(l, [[img, to]])
    })
  }

  /** Moves an image to a layout in a list of its own. */
  move(img: Image, to: ImageLayout): void {
    this.submit((l) => this.sync(l, [[img, to]]))
  }

  layout(sets: readonly BindingLayout[] = [], constants?: { readonly size: number; readonly stages: readonly ('vertex' | 'fragment' | 'compute')[] }): PipelineLayout {
    return this.device.createPipelineLayout({ sets, constants })
  }

  pipeline(o: {
    readonly vertex?: LensModule
    readonly fragment?: LensModule | null
    readonly outputs?: readonly (ColorOutput | null)[]
    readonly buffers?: readonly VertexBufferLayout[]
    readonly layout?: PipelineLayout
    readonly topology?: 'triangles' | 'triangle-strip'
    readonly cull?: 'none' | 'front' | 'back'
    readonly front?: 'ccw' | 'cw'
    readonly depth?: DepthState
    readonly samples?: 1 | 4
  } = {}): RenderPipeline {
    const fragment = o.fragment === null ? undefined : { lens: this.device.createLens(o.fragment ?? colorFragment()), outputs: o.outputs ?? [{ format: 'rgba8' as const }] }
    return this.device.createRenderPipeline({
      layout: o.layout ?? this.layout(),
      vertex: { lens: this.device.createLens(o.vertex ?? colorVertex()), buffers: o.buffers ?? COLOR_BUFFERS },
      fragment,
      topology: o.topology,
      cull: o.cull,
      front: o.front,
      depth: o.depth,
      samples: o.samples,
    })
  }

  /** A binding layout and one set of it, written. */
  set(entries: readonly BindingEntry[], writes: readonly BindingWrite[]): { readonly layout: BindingLayout; readonly set: BindingSet } {
    const layout = this.device.createBindingLayout({ entries })
    const set = this.device.createBindingPool({ sets: 1 }).allocate(layout)
    set.write(writes)
    return { layout, set }
  }
}

function color(view: View, load: ColorAttachment['load'] = 'clear', clear: readonly [number, number, number, number] = [0, 0, 0, 0]): ColorAttachment {
  return { view, load, store: 'keep', clear }
}

function depthOf(view: View, o: Partial<DepthAttachment> = {}): DepthAttachment {
  return { view, load: 'clear', store: 'keep', clear: 1, ...o }
}

/** The four bytes of an rgba8 texel. */
function px(bytes: Uint8Array, width: number, x: number, y: number): number[] {
  return Array.from(bytes.subarray((y * width + x) * 4, (y * width + x) * 4 + 4))
}

/** Every texel of a picture as `f` says, row after row, in the layout read() hands back. */
function picture(width: number, height: number, f: (x: number, y: number) => readonly number[]): number[] {
  const out: number[] = []
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out.push(...f(x, y))
  return out
}

function floats(bytes: Uint8Array): number[] {
  return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4))
}

/** The byte a unorm8 channel stores for a value: round to nearest, as the spec says unorm writes do. */
const unorm8 = (v: number): number => Math.floor(Math.min(1, Math.max(0, v)) * 255 + 0.5)

// ---------------------------------------------------------------------------------------------------
// Shaders and geometry

/** Clip position (slot 0) and colour (slot 1) in, the colour out at slot 0. */
function colorVertex(flat = false): LensModule {
  const b = lens('vertex')
  const pos = b.input(0, 'f32x4')
  const c = b.input(1, 'f32x4')
  b.position(pos)
  b.out(b.output(0, 'f32x4', { flat }), c)
  return b.finish()
}

function colorFragment(flat = false): LensModule {
  const b = lens('fragment')
  b.out(b.output(0, 'f32x4'), b.input(0, 'f32x4', { flat }))
  return b.finish()
}

const COLOR_BUFFERS: readonly VertexBufferLayout[] = [{ stride: 32, attributes: [{ slot: 0, format: 'f32x4', offset: 0 }, { slot: 1, format: 'f32x4', offset: 16 }] }]

type Rgba = readonly [number, number, number, number]

/** One vertex for colorVertex: clip x, y, z, w, then the colour. */
function vtx(x: number, y: number, c: Rgba, z = 0, w = 1): number[] {
  return [x, y, z, w, ...c]
}

/** Two triangles covering pixels [x0, x1) x [y0, y1) of a width x height picture, at depth z. */
function rect(width: number, height: number, x0: number, y0: number, x1: number, y1: number, c: Rgba, z = 0): number[] {
  const nx = (x: number): number => (2 * x) / width - 1
  const ny = (y: number): number => 1 - (2 * y) / height
  const a = vtx(nx(x0), ny(y0), c, z)
  const b = vtx(nx(x1), ny(y0), c, z)
  const d = vtx(nx(x0), ny(y1), c, z)
  const e = vtx(nx(x1), ny(y1), c, z)
  return [...a, ...b, ...d, ...d, ...b, ...e]
}

const RED: Rgba = [1, 0, 0, 1]
const GREEN: Rgba = [0, 1, 0, 1]
const BLUE: Rgba = [0, 0, 1, 1]
const CLEAR: Rgba = [0, 0, 0, 0]

/** Draws `data` (colorVertex vertices) in one pass onto a cleared picture. */
function drawOnce(b: Bench, pic: Pictured, pipe: RenderPipeline, data: readonly number[], clear: Rgba = CLEAR): void {
  const vb = b.vertices(data)
  b.submit((l) => {
    b.sync(l, [[pic.image, 'color']])
    l.beginPass({ colors: [color(pic.view, 'clear', clear)] })
    l.bindPipeline(pipe)
    l.bindVertices(0, [{ buffer: vb }])
    l.draw(data.length / 8)
    l.endPass()
  })
}

// ---------------------------------------------------------------------------------------------------
// The adapter and the back end

test('the back end reports one reference adapter: the spec limits, both features, two heaps, four memory kinds in order, one queue', () => {
  const backend = softBackend()
  assert.equal(backend.name, 'reference')
  assert.deepEqual(backend.adapters(), [{
    name: 'Nightglass reference',
    kind: 'reference',
    limits: {
      imageSize: 8192, imageLayers: 256, sets: 3, bindings: 16, uniformRange: 65536, storageRange: 134217728, offsetAlign: 256,
      stageUniforms: 11, stageStorage: 8, stageImages: 16, stageSamplers: 16, stageStorageImages: 4, dynamicUniforms: 8, dynamicStorage: 4,
      vertexBuffers: 8, vertexAttributes: 16, vertexStride: 2048, interStage: 16, colorAttachments: 8, colorBytes: 32, constants: 128,
      groupInvocations: 256, groupSize: [256, 256, 64], groups: 65535, bufferSize: 268435456, allocationSize: 268435456, allocations: 4096,
      copyRowAlign: 256, updateSize: 65536,
    },
    features: ['float32-filter', 'depth-unclipped'],
    heaps: [{ index: 0, size: 2 ** 30, local: true }, { index: 1, size: 2 ** 30, local: false }],
    kinds: [
      { index: 0, name: 'device', heap: 0, host: false },
      { index: 1, name: 'images', heap: 0, host: false },
      { index: 2, name: 'upload', heap: 1, host: true },
      { index: 3, name: 'readback', heap: 1, host: true },
    ],
    groups: [{ index: 0, graphics: true, compute: true, copy: true, count: 1 }],
  }])
  assert.equal(SOFT_HEAP, 2 ** 30)
  assert.equal(SOFT_STEPS, 2 ** 30)
  assert.deepEqual(backend.adapters()[0].limits, SOFT_LIMITS)
  assert.ok(Object.isFrozen(SOFT_LIMITS) && Object.isFrozen(backend.adapters()[0]))
  // Through an instance: named, sized, and opened with both features.
  const instance = createInstance({ backends: [softBackend({ name: 'soft', heap: 1 << 20 })] })
  const a = instance.adapters()[0]
  assert.equal(a.backend, 'soft')
  assert.deepEqual(a.heaps.map((h) => h.size), [1 << 20, 1 << 20])
  const device = instance.open(a, { features: ['float32-filter', 'depth-unclipped'] })
  assert.deepEqual(device.limits, SOFT_LIMITS)
  assert.equal(device.lost(), null)
  // The heap is real: the core refuses an allocation past what is left of it.
  device.allocate({ size: 1 << 19, kind: KIND.device })
  refuses(() => device.allocate({ size: (1 << 19) + 4, kind: KIND.images }), 'memory', /heap 0 has 524288 bytes left/)
  device.destroy()
})

/**
 * WebGPU's default limits, each under the name of the limit here that matches it (maxBindGroups is `sets`,
 * maxBindingsPerBindGroup `bindings`, maxUniformBuffersPerShaderStage `stageUniforms`, and so on). The inline constants,
 * allocations, copy rows and `updateBuffer` are Nightglass's own and have no WebGPU default.
 */
const WEBGPU_DEFAULTS: { readonly [K in keyof Limits]?: number } = {
  imageSize: 8192, imageLayers: 256, sets: 4, bindings: 1000, uniformRange: 65536, storageRange: 134217728, offsetAlign: 256,
  stageUniforms: 12, stageStorage: 8, stageImages: 16, stageSamplers: 16, stageStorageImages: 4, dynamicUniforms: 8, dynamicStorage: 4,
  vertexBuffers: 8, vertexAttributes: 16, vertexStride: 2048, interStage: 16, colorAttachments: 8, colorBytes: 32,
  groupInvocations: 256, groups: 65535, bufferSize: 268435456,
}

test('the spec\'s Limits section names every limit that is not WebGPU\'s default, with both numbers, and each lies within it', () => {
  const spec = readFileSync(new URL('../../../../docs/nightglass.md', import.meta.url), 'utf8')
  const from = spec.indexOf('\n## Limits\n')
  const section = spec.slice(from, spec.indexOf('\n## ', from + 1)).replace(/\s+/g, ' ')
  const limits = SOFT_LIMITS as unknown as { readonly [name: string]: number }
  const differ = Object.entries(WEBGPU_DEFAULTS).filter(([k, v]) => limits[k] !== v)
  const claimed = [...section.matchAll(/`(\w+)`, (\d+) where WebGPU's is (\d+)/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`)
  assert.deepEqual(claimed.sort(), differ.map(([k, v]) => `${k} ${limits[k]} ${v}`).sort())
  // Each is below WebGPU's default, so a device opened with the default limits gives every one of them.
  for (const [k, v] of differ) assert.ok(limits[k] < v, k)
  assert.deepEqual(SOFT_LIMITS.groupSize, [256, 256, 64])
})

test('softBackend refuses malformed options with code invalid, and its open() only adapter 0', () => {
  refuses(() => softBackend(5 as unknown as SoftOptions), 'invalid', /softBackend: the options are an object, not 5/)
  refuses(() => softBackend([] as unknown as SoftOptions), 'invalid', /the options are an object/)
  refuses(() => softBackend({ nme: 'x' } as unknown as SoftOptions), 'invalid', /the options have no field "nme"/)
  refuses(() => softBackend({ name: '' }), 'invalid', /the name is a string of at least one character/)
  refuses(() => softBackend({ name: 7 as unknown as string }), 'invalid', /the name/)
  for (const heap of [0, -1, 1.5, NaN, Infinity, 2 ** 53]) refuses(() => softBackend({ heap }), 'invalid', /the heap size .* is not a whole number of bytes of at least 1/)
  for (const steps of [-1, 0.5, NaN, Infinity]) refuses(() => softBackend({ steps }), 'invalid', /the step budget .* is not a whole number of at least 0/)
  const hostile = Object.defineProperty({}, 'heap', { enumerable: true, get: () => { throw new RangeError('no') } })
  refuses(() => softBackend(hostile), 'invalid', /softBackend: reading the options raised a RangeError/)
  assert.equal(softBackend({ steps: 0, heap: 4 }).adapters()[0].heaps[1].size, 4)
  const backend = softBackend()
  refuses(() => backend.open(1, [], SOFT_LIMITS), 'invalid', /it has one adapter, 0, not 1/)
  refuses(() => backend.open(0, [], null as unknown as typeof SOFT_LIMITS), 'invalid', /the limits are the device's Limits/)
  const device = backend.open(0, [], SOFT_LIMITS)
  assert.equal(device.lost(), null)
  // The device's own calls refuse what is not theirs, as Faults.
  refuses(() => device.allocate('vram' as never, 16), 'invalid', /"vram" is not a memory kind/)
  refuses(() => device.allocate('device', 0), 'invalid', /0 is not a whole number of bytes/)
  const dev = device.allocate('device', 16)
  refuses(() => device.hostBytes(dev), 'memory', /device memory is not seen by the host/)
  refuses(() => device.flush(dev, 0, 4), 'memory', /device memory is not seen by the host/)
  refuses(() => device.createView({}, '2d', { base: 0, count: 1 }, { base: 0, count: 1 }), 'invalid', /createView: the image is not one the reference renderer made/)
  const up = device.allocate('upload', 16)
  refuses(() => device.flush(up, 8, 12), 'invalid', /bytes 8 to 20 are not inside the 16 bytes/)
  // destroy() lets the bytes go: the host's array is empty afterwards and no range lies inside it.
  assert.equal(device.hostBytes(up).length, 16)
  device.destroy(up)
  assert.equal(device.hostBytes(up).length, 0)
  refuses(() => device.invalidate(up, 0, 4), 'invalid', /not inside the 0 bytes/)
})

test('host-visible memory is not coherent: unflushed writes and uninvalidated reads are stale, ranges move only their bytes', () => {
  const b = new Bench()
  const up = b.buffer(16, ['copy-src'], KIND.upload)
  const rb = b.buffer(16, ['copy-dst'], KIND.readback)
  const upMemory = up.memory as NonNullable<Buffer['memory']>
  const rbMemory = rb.memory as NonNullable<Buffer['memory']>
  const host = upMemory.map()
  assert.equal(host, upMemory.map(), 'map() hands out the same bytes every call')
  host.set(Array.from({ length: 16 }, (_, i) => i + 1))
  const copy = (): void => b.submit((l) => l.copyBuffer(up, rb, [{ from: 0, to: 0, size: 16 }]))
  copy()
  rbMemory.invalidate()
  assert.deepEqual(Array.from(rbMemory.map()), new Array(16).fill(0), 'never flushed: the device copied its own zeros')
  upMemory.flush(0, 8)
  copy()
  assert.deepEqual(Array.from(rbMemory.map()), new Array(16).fill(0), 'not invalidated: the host still sees the old bytes')
  rbMemory.invalidate(0, 4)
  assert.deepEqual(Array.from(rbMemory.map()), [1, 2, 3, 4, ...new Array(12).fill(0)])
  rbMemory.invalidate()
  assert.deepEqual(Array.from(rbMemory.map()), [1, 2, 3, 4, 5, 6, 7, 8, ...new Array(8).fill(0)])
  // A host write after the flush stays on the host until the next flush.
  host[0] = 99
  upMemory.flush(4, 12)
  copy()
  rbMemory.invalidate()
  assert.deepEqual(Array.from(rbMemory.map()), Array.from({ length: 16 }, (_, i) => i + 1))
})

// ---------------------------------------------------------------------------------------------------
// Passes

test('a clear load fills every texel of the view\'s level and layer; keep and any keep the contents', () => {
  const b = new Bench()
  const img = b.image({ format: 'rgba8', width: 8, height: 4, levels: 2, layers: 2, use: ['color', 'copy-src'] })
  const view = b.device.createView(img, { levels: { base: 1, count: 1 }, layers: { base: 1, count: 1 } })
  const wide = b.picture(3, 2, 'rgba16f')
  const ints = b.picture(3, 2, 'r32u')
  const depth = b.picture(3, 2, 'depth32f')
  const pipe = b.pipeline({ outputs: [{ format: 'rgba16f' }], fragment: colorFragment() })
  b.submit((l) => {
    b.sync(l, [[img, 'color'], [wide.image, 'color'], [ints.image, 'color'], [depth.image, 'depth']])
    l.beginPass({ colors: [color(view, 'clear', [1, 0.5, 0.25, 0])] })
    l.endPass()
    l.beginPass({ colors: [color(wide.view, 'clear', [0.5, -2, 65504, 1e6])] })
    l.endPass()
    l.beginPass({ colors: [color(ints.view, 'clear', [4000000000, 0, 0, 0])] })
    l.endPass()
    l.beginPass({ colors: [], depth: depthOf(depth.view, { clear: 0.75 }) })
    l.endPass()
  })
  assert.deepEqual(Array.from(b.read(img, 1, 1)), picture(4, 2, () => [255, 128, 64, 0]))
  assert.deepEqual(Array.from(b.read(img, 1, 0)), new Array(4 * 2 * 4).fill(0), 'another layer is untouched')
  assert.deepEqual(Array.from(b.read(img, 0, 1)), new Array(8 * 4 * 4).fill(0), 'another level is untouched')
  // Half floats: 0.5, -2 and 65504 exactly, and 1e6 past the largest half: infinity.
  assert.deepEqual(Array.from(new Uint16Array(b.read(wide.image).buffer)), picture(3, 2, () => [0x3800, 0xc000, 0x7bff, 0x7c00]))
  assert.deepEqual(Array.from(new Uint32Array(b.read(ints.image).buffer)), new Array(6).fill(4000000000))
  assert.deepEqual(floats(b.read(depth.image)), new Array(6).fill(0.75))
  // keep and any keep what was there; a draw then covers only part of the picture.
  const vb = b.vertices(rect(3, 2, 0, 0, 1, 2, [0.25, 0.25, 0.25, 1]))
  b.submit((l) => {
    b.sync(l, [[wide.image, 'color']])
    l.beginPass({ colors: [{ view: wide.view, load: 'keep', store: 'any' }] })
    l.endPass()
    b.sync(l)
    l.beginPass({ colors: [{ view: wide.view, load: 'any', store: 'keep' }] })
    l.bindPipeline(pipe)
    l.bindVertices(0, [{ buffer: vb }])
    l.draw(6)
    l.endPass()
  })
  assert.deepEqual(Array.from(new Uint16Array(b.read(wide.image).buffer)), picture(3, 2, (x) => (x === 0 ? [0x3400, 0x3400, 0x3400, 0x3c00] : [0x3800, 0xc000, 0x7bff, 0x7c00])))
})

test('a flat triangle covers exactly the pixels whose centres are inside, and two triangles sharing an edge cover each pixel once', () => {
  const b = new Bench()
  const pic = b.picture(8, 8)
  const a: Rgba = [1, 0.5, 0.25, 1]
  const c: Rgba = [0, 0.25, 1, 1]
  // Below the diagonal y = x (in framebuffer pixels) and above it. The diagonal is a right edge of the first and a
  // left edge of the second, so a centre on it (x = y) belongs to the second only.
  const lower = [...vtx(-1, -1, a), ...vtx(1, -1, a), ...vtx(-1, 1, a)]
  const upper = [...vtx(1, -1, c), ...vtx(1, 1, c), ...vtx(-1, 1, c)]
  const add = { color: { src: 'one', dst: 'one' }, alpha: { src: 'one', dst: 'one' } } as const
  drawOnce(b, pic, b.pipeline({ outputs: [{ format: 'rgba8', blend: add }] }), [...lower, ...upper])
  const A = [255, 128, 64, 255]
  const C = [0, 64, 255, 255]
  assert.deepEqual(Array.from(b.read(pic.image)), picture(8, 8, (x, y) => (y > x ? A : C)))
  // Only the lower triangle: 28 pixels, the clear colour elsewhere.
  drawOnce(b, pic, b.pipeline(), lower)
  const got = b.read(pic.image)
  assert.deepEqual(Array.from(got), picture(8, 8, (x, y) => (y > x ? A : [0, 0, 0, 0])))
  assert.equal(picture(8, 8, (x, y) => [y > x ? 1 : 0]).reduce((s, v) => s + v, 0), 28)
})

test('facing: counter-clockwise as seen faces the viewer by default, front-facing tells the shader, and cull drops a side', () => {
  const b = new Bench()
  const pic = b.picture(8, 8)
  const f = lens('fragment')
  f.input(0, 'f32x4')
  f.out(f.output(0, 'f32x4'), f.choose(f.builtin('front-facing'), f.make('f32x4', 0, 1, 0, 1), f.make('f32x4', 1, 0, 0, 1)))
  const facing = f.finish()
  // The lower triangle wound clockwise as seen; the upper one counter-clockwise.
  const lower = [...vtx(-1, -1, RED), ...vtx(-1, 1, RED), ...vtx(1, -1, RED)]
  const upper = [...vtx(1, -1, RED), ...vtx(1, 1, RED), ...vtx(-1, 1, RED)]
  const both = [...lower, ...upper]
  const G = [0, 255, 0, 255]
  const R = [255, 0, 0, 255]
  const N = [0, 0, 0, 0]
  const cases: readonly [Parameters<Bench['pipeline']>[0], (x: number, y: number) => number[]][] = [
    [{ fragment: facing }, (x, y) => (y > x ? R : G)],
    [{ fragment: facing, front: 'cw' }, (x, y) => (y > x ? G : R)],
    [{ fragment: facing, cull: 'back' }, (x, y) => (y > x ? N : G)],
    [{ fragment: facing, cull: 'front' }, (x, y) => (y > x ? R : N)],
    [{ fragment: facing, cull: 'back', front: 'cw' }, (x, y) => (y > x ? G : N)],
  ]
  for (const [opts, want] of cases) {
    drawOnce(b, pic, b.pipeline(opts), both)
    assert.deepEqual(Array.from(b.read(pic.image)), picture(8, 8, want), JSON.stringify(opts))
  }
})

test('values are interpolated across a clipped triangle; frag-coord holds the pixel centre, depth and 1/w; two outputs write two attachments', () => {
  const b = new Bench()
  const uv = b.picture(8, 8, 'rgba32f')
  const coord = b.picture(8, 8, 'rgba32f')
  const f = lens('fragment')
  const c = f.input(0, 'f32x4')
  f.out(f.output(0, 'f32x4'), c)
  f.out(f.output(1, 'f32x4'), f.builtin('frag-coord'))
  const pipe = b.pipeline({ fragment: f.finish(), outputs: [{ format: 'rgba32f' }, { format: 'rgba32f' }] })
  // A triangle twice the picture's size, clipped to it; each value is linear in the framebuffer: u = x / 16, v = y / 16.
  const vb = b.vertices([...vtx(-1, -1, [0, 0.5, 0.25, 1], 0.5), ...vtx(3, -1, [1, 0.5, 0.25, 1], 0.5), ...vtx(-1, 3, [0, -0.5, 0.25, 1], 0.5)])
  b.submit((l) => {
    b.sync(l, [[uv.image, 'color'], [coord.image, 'color']])
    l.beginPass({ colors: [color(uv.view), color(coord.view)] })
    l.bindPipeline(pipe)
    l.bindVertices(0, [{ buffer: vb }])
    l.draw(3)
    l.endPass()
  })
  assert.deepEqual(floats(b.read(uv.image)), picture(8, 8, (x, y) => [(x + 0.5) / 16, (y + 0.5) / 16, 0.25, 1]))
  assert.deepEqual(floats(b.read(coord.image)), picture(8, 8, (x, y) => [x + 0.5, y + 0.5, 0.5, 1]))
})

test('triangle strips alternate their order and take flat values from the first vertex of each triangle', () => {
  const b = new Bench()
  const pic = b.picture(8, 8)
  const pipe = b.pipeline({ vertex: colorVertex(true), fragment: colorFragment(true), topology: 'triangle-strip', cull: 'back' })
  // Top left, bottom left, top right, bottom right. Triangle 1 is (v2, v1, v3), so it keeps the strip's winding (both
  // survive the cull) and takes v1's flat colour. The shared diagonal x + y = 8 is a left edge of triangle 1 only.
  drawOnce(b, pic, pipe, [...vtx(-1, 1, RED), ...vtx(-1, -1, GREEN), ...vtx(1, 1, BLUE), ...vtx(1, -1, [1, 1, 1, 1])])
  assert.deepEqual(Array.from(b.read(pic.image)), picture(8, 8, (x, y) => (x + y <= 6 ? [255, 0, 0, 255] : [0, 255, 0, 255])))
})

test('the viewport maps clip space onto its rectangle and depth range, the scissor cuts, and both reset when a pass begins', () => {
  const b = new Bench()
  const pic = b.picture(8, 8)
  const depth = b.picture(8, 8, 'depth32f')
  const pipe = b.pipeline({ depth: { format: 'depth32f', write: true, compare: 'always' } })
  const vb = b.vertices(rect(2, 2, 0, 0, 2, 2, GREEN, 1))
  b.submit((l) => {
    b.sync(l, [[pic.image, 'color'], [depth.image, 'depth']])
    l.beginPass({ colors: [color(pic.view)], depth: depthOf(depth.view) })
    l.bindPipeline(pipe)
    l.bindVertices(0, [{ buffer: vb }])
    l.setViewport({ x: 2, y: 1, width: 4, height: 4, near: 0.25, far: 0.75 })
    l.setScissor({ x: 3, y: 0, width: 5, height: 3 })
    l.draw(6)
    l.endPass()
  })
  const inside = (x: number, y: number): boolean => x >= 3 && x < 6 && y >= 1 && y < 3
  assert.deepEqual(Array.from(b.read(pic.image)), picture(8, 8, (x, y) => (inside(x, y) ? [0, 255, 0, 255] : [0, 0, 0, 0])))
  assert.deepEqual(floats(b.read(depth.image)), picture(8, 8, (x, y) => [inside(x, y) ? 0.75 : 1]))
  // A new pass covers its attachments again.
  b.submit((l) => {
    b.sync(l, [[pic.image, 'color'], [depth.image, 'depth']])
    l.beginPass({ colors: [color(pic.view)], depth: depthOf(depth.view) })
    l.bindPipeline(pipe)
    l.bindVertices(0, [{ buffer: vb }])
    l.draw(6)
    l.endPass()
  })
  assert.deepEqual(Array.from(b.read(pic.image)), picture(8, 8, () => [0, 255, 0, 255]))
  assert.deepEqual(floats(b.read(depth.image)), new Array(64).fill(1))
})

// ---------------------------------------------------------------------------------------------------
// Textures

function uvVertex(): LensModule {
  const b = lens('vertex')
  const pos = b.input(0, 'f32x2')
  const uv = b.input(1, 'f32x2')
  b.position(b.make('f32x4', pos, 0, 1))
  b.out(b.output(0, 'f32x2'), uv)
  return b.finish()
}

function textureFragment(): LensModule {
  const b = lens('fragment')
  const uv = b.input(0, 'f32x2')
  b.out(b.output(0, 'f32x4'), b.sample(b.image(0, 0), b.sampler(0, 1), uv))
  return b.finish()
}

const UV_BUFFERS: readonly VertexBufferLayout[] = [{ stride: 16, attributes: [{ slot: 0, format: 'f32x2', offset: 0 }, { slot: 1, format: 'f32x2', offset: 8 }] }]
const TEXTURE_ENTRIES: readonly BindingEntry[] = [{ binding: 0, kind: 'image', stages: ['fragment'] }, { binding: 1, kind: 'sampler', stages: ['fragment'] }]

/** An indexed quad over the whole picture: corners top left, top right, bottom left, bottom right, uv 0 to `s`. */
function quad(b: Bench, s: number): { readonly vertices: Buffer; readonly indices: Buffer } {
  return {
    vertices: b.vertices([-1, 1, 0, 0, 1, 1, s, 0, -1, -1, 0, s, 1, -1, s, s]),
    indices: b.filled(['index'], new Uint16Array([0, 1, 2, 2, 1, 3])),
  }
}

/** Draws the indexed quad with the texture pipeline into a picture, sampling `view` through `sampler`. */
function drawTextured(b: Bench, pic: Pictured, view: View, sampler: Parameters<Device['createSampler']>[0], s = 1, format: Format = 'rgba8'): Uint8Array {
  const { layout, set } = b.set(TEXTURE_ENTRIES, [{ binding: 0, view }, { binding: 1, sampler: b.device.createSampler(sampler) }])
  const pl = b.layout([layout])
  const pipe = b.pipeline({ vertex: uvVertex(), fragment: textureFragment(), buffers: UV_BUFFERS, layout: pl, outputs: [{ format }] })
  const q = quad(b, s)
  b.submit((l) => {
    b.sync(l, [[pic.image, 'color']])
    l.beginPass({ colors: [color(pic.view)] })
    l.bindPipeline(pipe)
    l.bindSets(pl, 0, [set])
    l.bindVertices(0, [{ buffer: q.vertices }])
    l.bindIndices(q.indices, 0, 'u16')
    l.drawIndexed(6)
    l.endPass()
  })
  return b.read(pic.image)
}

test('an indexed textured quad samples a 4 x 4 image with nearest and linear filters, repeating and clamping', () => {
  const b = new Bench()
  // Texel (i, j) of the marked image is (64 i, 64 j, 32, 255), so a swapped axis or a flipped row shows.
  const marked = b.image({ format: 'rgba8', width: 4, height: 4, use: ['sampled', 'copy-dst'] })
  b.upload(marked, new Uint8Array(picture(4, 4, (i, j) => [64 * i, 64 * j, 32, 255])))
  const markedView = b.device.createView(marked)
  const pic = b.picture(8, 8)
  // uv 0 to 1 over 8 pixels: each texel covers 2 x 2 pixels.
  assert.deepEqual(Array.from(drawTextured(b, pic, markedView, { wrap: 'repeat' })), picture(8, 8, (x, y) => [64 * (x >> 1), 64 * (y >> 1), 32, 255]))
  // uv 0 to 2 with repeat: the image twice across, one texel per pixel.
  assert.deepEqual(Array.from(drawTextured(b, pic, markedView, { wrap: 'repeat' }, 2)), picture(8, 8, (x, y) => [64 * (x & 3), 64 * (y & 3), 32, 255]))
  // uv 0 to 2 with clamp: the edge texel past u = 1.
  assert.deepEqual(Array.from(drawTextured(b, pic, markedView, { wrap: 'clamp' }, 2)), picture(8, 8, (x, y) => [64 * Math.min(x, 3), 64 * Math.min(y, 3), 32, 255]))
  // A black and white checker through a linear filter, into floats: the bilinear blend of the four texels around
  // (u W - 0.5, v H - 0.5), each index wrapped by the mode. Every weight here is a multiple of 1/16, so it is exact.
  const checker = b.image({ format: 'rgba8', width: 4, height: 4, use: ['sampled', 'copy-dst'] })
  b.upload(checker, new Uint8Array(picture(4, 4, (i, j) => ((i + j) & 1) === 1 ? [255, 255, 255, 255] : [0, 0, 0, 255])))
  const checkerView = b.device.createView(checker)
  const floatPic = b.picture(8, 8, 'rgba32f')
  for (const wrap of ['repeat', 'clamp'] as const) {
    const t = (i: number, j: number): number => {
      const w = (k: number): number => (wrap === 'repeat' ? ((k % 4) + 4) % 4 : Math.min(3, Math.max(0, k)))
      return (w(i) + w(j)) & 1
    }
    const want = picture(8, 8, (x, y) => {
      const tx = ((x + 0.5) / 8) * 4 - 0.5
      const ty = ((y + 0.5) / 8) * 4 - 0.5
      const i = Math.floor(tx)
      const j = Math.floor(ty)
      const fx = tx - i
      const fy = ty - j
      const v = (1 - fx) * (1 - fy) * t(i, j) + fx * (1 - fy) * t(i + 1, j) + (1 - fx) * fy * t(i, j + 1) + fx * fy * t(i + 1, j + 1)
      return [v, v, v, 1]
    })
    assert.deepEqual(floats(drawTextured(b, floatPic, checkerView, { mag: 'linear', min: 'linear', wrap }, 1, 'rgba32f')), want, wrap)
  }
})

test('minification picks the mip level the rate of change names, counted from the view and held to the sampler\'s range', () => {
  const b = new Bench()
  const img = b.image({ format: 'rgba8', width: 16, height: 16, levels: 5, use: ['sampled', 'copy-dst'] })
  const shade = (l: number): number[] => [50 * l, 200 - 40 * l, 7, 255]
  for (let l = 0; l < 5; l++) {
    const n = 16 >> l
    b.upload(img, new Uint8Array(picture(n, n, () => shade(l))), l)
  }
  const all = b.device.createView(img)
  const fromOne = b.device.createView(img, { levels: { base: 1, count: 4 } })
  // A picture of S pixels across steps 16 / S texels per pixel: level log2(16 / S); at or below level 0 it magnifies.
  const cases: readonly [number, View, Parameters<Device['createSampler']>[0], number][] = [
    [16, all, {}, 0], [8, all, {}, 1], [4, all, {}, 2], [2, all, {}, 3], [1, all, {}, 4],
    [8, fromOne, {}, 1], [2, fromOne, {}, 3],
    [16, all, { lodMin: 2 }, 2], [2, all, { lodMax: 1 }, 1], [4, all, { mip: 'linear' }, 2],
  ]
  for (const [size, view, sampler, level] of cases) {
    const pic = b.picture(size, size)
    assert.deepEqual(Array.from(drawTextured(b, pic, view, sampler)), picture(size, size, () => shade(level)), `${size} pixels, ${JSON.stringify(sampler)}`)
  }
})

// ---------------------------------------------------------------------------------------------------
// Depth, blending and resolve

test('the depth test keeps the nearer of two overlapping quads whichever is drawn first; always lets the last win', () => {
  const b = new Bench()
  const pic = b.picture(8, 8)
  const depth = b.picture(8, 8, 'depth32f')
  const far = rect(8, 8, 0, 0, 6, 8, RED, 0.5)
  const near = rect(8, 8, 2, 0, 8, 8, GREEN, 0.25)
  const run = (compare: 'less' | 'always', write: boolean, data: readonly number[]): void => {
    const pipe = b.pipeline({ depth: { format: 'depth32f', write, compare } })
    const vb = b.vertices(data)
    b.submit((l) => {
      b.sync(l, [[pic.image, 'color'], [depth.image, 'depth']])
      l.beginPass({ colors: [color(pic.view)], depth: depthOf(depth.view) })
      l.bindPipeline(pipe)
      l.bindVertices(0, [{ buffer: vb }])
      l.draw(12)
      l.endPass()
    })
  }
  const R = [255, 0, 0, 255]
  const G = [0, 255, 0, 255]
  for (const data of [[...far, ...near], [...near, ...far]]) {
    run('less', true, data)
    assert.deepEqual(Array.from(b.read(pic.image)), picture(8, 8, (x) => (x < 2 ? R : G)))
    assert.deepEqual(floats(b.read(depth.image)), picture(8, 8, (x) => [x < 2 ? 0.5 : 0.25]))
  }
  run('always', false, [...far, ...near])
  assert.deepEqual(Array.from(b.read(pic.image)), picture(8, 8, (x) => (x < 2 ? R : G)))
  run('always', false, [...near, ...far])
  assert.deepEqual(Array.from(b.read(pic.image)), picture(8, 8, (x) => (x < 6 ? R : G)))
  assert.deepEqual(floats(b.read(depth.image)), new Array(64).fill(1), 'without depth writes the cleared depth stays')
})

test('depth16 holds 16-bit depth, equal meets a surface drawn again, and a read-only depth pass tests but never writes', () => {
  const b = new Bench()
  const pic = b.picture(4, 4)
  const depth = b.picture(4, 4, 'depth16')
  const first = rect(4, 4, 0, 0, 4, 4, RED, 0.3)
  const again = rect(4, 4, 0, 0, 2, 4, BLUE, 0.3)
  const vb = b.vertices([...first, ...again])
  const write = b.pipeline({ depth: { format: 'depth16', write: true, compare: 'less' } })
  const equal = b.pipeline({ depth: { format: 'depth16', write: false, compare: 'equal' } })
  b.submit((l) => {
    b.sync(l, [[pic.image, 'color'], [depth.image, 'depth']])
    l.beginPass({ colors: [color(pic.view)], depth: depthOf(depth.view) })
    l.bindPipeline(write)
    l.bindVertices(0, [{ buffer: vb }])
    l.draw(6)
    l.bindPipeline(equal)
    l.bindVertices(0, [{ buffer: vb }])
    l.draw(6, 1, 6)
    l.endPass()
  })
  assert.deepEqual(Array.from(b.read(pic.image)), picture(4, 4, (x) => (x < 2 ? [0, 0, 255, 255] : [255, 0, 0, 255])))
  const stored = Math.floor(Math.fround(0.3) * 65535 + 0.5)
  assert.deepEqual(Array.from(new Uint16Array(b.read(depth.image).buffer)), new Array(16).fill(stored))
  // Read-only: a quad at 0.25 passes `less` everywhere, is drawn, and leaves the depth as it was.
  const ro = b.pipeline({ depth: { format: 'depth16', compare: 'less' } })
  const near = b.vertices(rect(4, 4, 1, 1, 3, 3, GREEN, 0.25))
  b.submit((l) => {
    b.sync(l, [[pic.image, 'color'], [depth.image, 'depth-read']])
    l.beginPass({ colors: [color(pic.view, 'keep')], depth: depthOf(depth.view, { load: 'keep', store: 'keep', readOnly: true }) })
    l.bindPipeline(ro)
    l.bindVertices(0, [{ buffer: near }])
    l.draw(6)
    l.endPass()
  })
  const inner = (x: number, y: number): boolean => x >= 1 && x < 3 && y >= 1 && y < 3
  assert.deepEqual(Array.from(b.read(pic.image)), picture(4, 4, (x, y) => (inner(x, y) ? [0, 255, 0, 255] : x < 2 ? [0, 0, 255, 255] : [255, 0, 0, 255])))
  assert.deepEqual(Array.from(new Uint16Array(b.read(depth.image).buffer)), new Array(16).fill(stored))
})

test('unclipped depth keeps geometry past the depth planes and clamps its depth; clipped, the same triangle draws nothing', () => {
  const b = new Bench()
  const pic = b.picture(4, 4)
  const depth = b.picture(4, 4, 'depth32f')
  const behind = rect(4, 4, 0, 0, 4, 4, GREEN, -0.5)
  for (const unclipped of [false, true]) {
    const pipe = b.pipeline({ depth: { format: 'depth32f', write: true, compare: 'less', unclipped } })
    const vb = b.vertices(behind)
    b.submit((l) => {
      b.sync(l, [[pic.image, 'color'], [depth.image, 'depth']])
      l.beginPass({ colors: [color(pic.view)], depth: depthOf(depth.view) })
      l.bindPipeline(pipe)
      l.bindVertices(0, [{ buffer: vb }])
      l.draw(6)
      l.endPass()
    })
    assert.deepEqual(Array.from(b.read(pic.image)), picture(4, 4, () => (unclipped ? [0, 255, 0, 255] : [0, 0, 0, 0])))
    assert.deepEqual(floats(b.read(depth.image)), new Array(16).fill(unclipped ? 0 : 1))
  }
})

test('blending: source alpha over a background, then the blend constant through a write mask', () => {
  const b = new Bench()
  const pic = b.picture(4, 4)
  const over = { color: { src: 'src-alpha', dst: 'one-minus-src-alpha' }, alpha: { src: 'one', dst: 'one-minus-src-alpha' } } as const
  const constant = { color: { src: 'constant', dst: 'zero' }, alpha: { src: 'one', dst: 'zero' } } as const
  const glass = b.pipeline({ outputs: [{ format: 'rgba8', blend: over }] })
  const masked = b.pipeline({ outputs: [{ format: 'rgba8', blend: constant, mask: 1 | 4 }] })
  const vb = b.vertices([...rect(4, 4, 0, 0, 4, 4, [1, 0, 0, 0.5]), ...rect(4, 4, 2, 0, 4, 4, [1, 1, 1, 0.5])])
  b.submit((l) => {
    b.sync(l, [[pic.image, 'color']])
    l.beginPass({ colors: [color(pic.view, 'clear', [0, 0, 1, 1])] })
    l.bindPipeline(glass)
    l.bindVertices(0, [{ buffer: vb }])
    l.draw(6)
    l.bindPipeline(masked)
    l.bindVertices(0, [{ buffer: vb }])
    l.setBlendConstant([0.25, 0.5, 0.75, 0])
    l.draw(6, 1, 6)
    l.endPass()
  })
  // Over: r = 1 * 0.5 + 0 * 0.5, b = 0 * 0.5 + 1 * 0.5, a = 0.5 + 1 * 0.5. Masked: the white source times the
  // constant reaches red and blue only; green and alpha keep what the first draw stored.
  const glassPx = [unorm8(0.5), 0, unorm8(0.5), 255]
  assert.deepEqual(glassPx, [128, 0, 128, 255])
  assert.deepEqual(Array.from(b.read(pic.image)), picture(4, 4, (x) => (x < 2 ? glassPx : [unorm8(0.25), 0, unorm8(0.75), 255])))
})

test('a four-sample attachment covers samples at the standard positions and resolves to their average when the pass ends', () => {
  const b = new Bench()
  const ms = b.picture(4, 4, 'rgba8', 4)
  const one = b.picture(4, 4)
  const pipe = b.pipeline({ samples: 4 })
  // From x = 0.5 and y = 0.25 (pixels) to the far corner: in pixel 0 of each row the samples right of x = 0.5 (1 and
  // 3) are covered; in row 0 only those below y = 0.25 (1, 2 and 3).
  const vb = b.vertices(rect(4, 4, 0.5, 0.25, 4, 4, [1, 1, 1, 1]))
  b.submit((l) => {
    b.sync(l, [[ms.image, 'color'], [one.image, 'color']])
    l.beginPass({ colors: [{ view: ms.view, load: 'clear', store: 'any', clear: [0, 0, 0, 1], resolve: one.view }] })
    l.bindPipeline(pipe)
    l.bindVertices(0, [{ buffer: vb }])
    l.draw(6)
    l.endPass()
  })
  const covered = (x: number, y: number): number => {
    const pos = [[0.375, 0.125], [0.875, 0.375], [0.125, 0.625], [0.625, 0.875]]
    return pos.filter(([sx, sy]) => x + sx > 0.5 && y + sy > 0.25).length
  }
  assert.equal(covered(0, 0), 2)
  assert.equal(covered(1, 0), 3)
  assert.equal(covered(0, 1), 2)
  assert.deepEqual(Array.from(b.read(one.image)), picture(4, 4, (x, y) => {
    const v = unorm8(covered(x, y) / 4)
    return [v, v, v, 255]
  }))
})

// ---------------------------------------------------------------------------------------------------
// Vertices

test('instancing: an instance-rate buffer offsets each instance, instance-index counts from the first instance', () => {
  const b = new Bench()
  const pic = b.picture(8, 8)
  const v = lens('vertex')
  const pos = v.input(0, 'f32x2')
  const off = v.input(1, 'f32x2')
  const i = v.cast(v.builtin('instance-index'), 'f32')
  v.position(v.make('f32x4', v.add(pos, off), 0, 1))
  v.out(v.output(0, 'f32x4'), v.make('f32x4', v.mul(i, 0.25), 0, 0, 1))
  const pipe = b.pipeline({
    vertex: v.finish(),
    buffers: [{ stride: 8, attributes: [{ slot: 0, format: 'f32x2', offset: 0 }] }, { stride: 8, rate: 'instance', attributes: [{ slot: 1, format: 'f32x2', offset: 0 }] }],
  })
  // A square over pixels [0, 2) x [0, 2), and instance k moved 2k pixels right and down.
  const square = b.vertices([-1, 1, -0.5, 1, -1, 0.5, -1, 0.5, -0.5, 1, -0.5, 0.5])
  const offsets = b.vertices([0, 0, 0.5, -0.5, 1, -1, 1.5, -1.5])
  b.submit((l) => {
    b.sync(l, [[pic.image, 'color']])
    l.beginPass({ colors: [color(pic.view)] })
    l.bindPipeline(pipe)
    l.bindVertices(0, [{ buffer: square }, { buffer: offsets }])
    l.draw(6, 3, 0, 1)
    l.endPass()
  })
  assert.deepEqual(Array.from(b.read(pic.image)), picture(8, 8, (x, y) => {
    const k = x >> 1
    return k === y >> 1 && k >= 1 ? [unorm8(0.25 * k), 0, 0, 255] : [0, 0, 0, 0]
  }))
})

test('vertex formats: unorm8x4, u32 and i32 attributes reach the shaders exactly, and integer outputs write integer attachments', () => {
  const b = new Bench()
  const rgba = b.picture(4, 4)
  const u = b.picture(4, 4, 'r32u')
  const s = b.picture(4, 4, 'r32i')
  const v = lens('vertex')
  v.position(v.make('f32x4', v.input(0, 'f32x2'), 0, 1))
  v.out(v.output(0, 'f32x4'), v.input(1, 'f32x4'))
  v.out(v.output(1, 'u32'), v.input(2, 'u32'))
  v.out(v.output(2, 'i32'), v.input(3, 'i32'))
  const f = lens('fragment')
  f.out(f.output(0, 'f32x4'), f.input(0, 'f32x4'))
  f.out(f.output(1, 'u32'), f.input(1, 'u32'))
  f.out(f.output(2, 'i32'), f.input(2, 'i32'))
  const pipe = b.pipeline({
    vertex: v.finish(),
    fragment: f.finish(),
    outputs: [{ format: 'rgba8' }, { format: 'r32u' }, { format: 'r32i' }],
    buffers: [{ stride: 20, attributes: [{ slot: 0, format: 'f32x2', offset: 0 }, { slot: 1, format: 'unorm8x4', offset: 8 }, { slot: 2, format: 'u32', offset: 12 }, { slot: 3, format: 'i32', offset: 16 }] }],
  })
  const data = new DataView(new ArrayBuffer(60))
  ;[[-1, -1], [3, -1], [-1, 3]].forEach(([x, y], k) => {
    data.setFloat32(k * 20, x, true)
    data.setFloat32(k * 20 + 4, y, true)
    ;[10, 20, 30, 40].forEach((c, i) => data.setUint8(k * 20 + 8 + i, c))
    data.setUint32(k * 20 + 12, 4000000000 + k, true)
    data.setInt32(k * 20 + 16, -123456 - k, true)
  })
  const vb = b.filled(['vertex'], data)
  b.submit((l) => {
    b.sync(l, [[rgba.image, 'color'], [u.image, 'color'], [s.image, 'color']])
    l.beginPass({ colors: [color(rgba.view), color(u.view), color(s.view)] })
    l.bindPipeline(pipe)
    l.bindVertices(0, [{ buffer: vb }])
    l.draw(3)
    l.endPass()
  })
  assert.deepEqual(Array.from(b.read(rgba.image)), picture(4, 4, () => [10, 20, 30, 40]))
  // Integer ports are flat: the first vertex's values everywhere.
  assert.deepEqual(Array.from(new Uint32Array(b.read(u.image).buffer)), new Array(16).fill(4000000000))
  assert.deepEqual(Array.from(new Int32Array(b.read(s.image).buffer)), new Array(16).fill(-123456))
})

test('indexed draws add the base vertex; an attribute past the end of its buffer reads zero', () => {
  const b = new Bench()
  const pic = b.picture(8, 8)
  const pipe = b.pipeline({
    vertex: colorVertex(true),
    fragment: colorFragment(true),
    buffers: [{ stride: 16, attributes: [{ slot: 0, format: 'f32x4', offset: 0 }] }, { stride: 16, attributes: [{ slot: 1, format: 'f32x4', offset: 0 }] }],
  })
  // Positions 0, 1 and 3 make the lower-left triangle; the colour buffer holds only three colours, so vertex 3, the
  // first of the triangle and the one its flat colour comes from, reads (0, 0, 0, 0).
  const positions = b.vertices([-1, -1, 0, 1, 1, -1, 0, 1, 0, 0, 0, 1, -1, 1, 0, 1])
  const colors = b.vertices([...RED, ...GREEN, ...BLUE])
  const indices = b.filled(['index'], new Uint32Array([4, 1, 2, 1, 2, 3]))
  const draw = (first: number, count: number): void => b.submit((l) => {
    b.sync(l, [[pic.image, 'color']])
    l.beginPass({ colors: [color(pic.view, 'clear', [0.5, 0.5, 0.5, 0.5])] })
    l.bindPipeline(pipe)
    l.bindVertices(0, [{ buffer: positions }, { buffer: colors }])
    l.bindIndices(indices, 0, 'u32')
    l.drawIndexed(count, 1, first, -1)
    l.endPass()
  })
  draw(0, 3)
  assert.deepEqual(Array.from(b.read(pic.image)), picture(8, 8, (x, y) => (y > x ? [0, 0, 0, 0] : [128, 128, 128, 128])))
  // Indices 1, 2, 3 less one are vertices 0, 1, 2: the triangle (0, 8), (8, 8), (4, 4) in pixels, red from vertex 0.
  // Its left edge x + y = 8 holds the centres on it and its right edge y = x does not (the top-left rule).
  draw(3, 3)
  assert.deepEqual(Array.from(b.read(pic.image)), picture(8, 8, (x, y) => (x + y >= 7 && y > x ? [255, 0, 0, 255] : [128, 128, 128, 128])))
})

test('an index is read little-endian from every one of its bytes, u16 and u32', () => {
  const b = new Bench()
  const pic = b.picture(8, 8)
  const pipe = b.pipeline()
  const vb = b.vertices([...vtx(-1, -1, RED), ...vtx(1, -1, RED), ...vtx(-1, 1, RED)])
  const draw = (type: 'u16' | 'u32', base: number): number[] => {
    // Indices base, base + 1 and base + 2, less the base vertex, are vertices 0, 1 and 2.
    const ib = b.filled(['index'], type === 'u16' ? new Uint16Array([base, base + 1, base + 2]) : new Uint32Array([base, base + 1, base + 2]))
    b.submit((l) => {
      b.sync(l, [[pic.image, 'color']])
      l.beginPass({ colors: [color(pic.view)] })
      l.bindPipeline(pipe)
      l.bindVertices(0, [{ buffer: vb }])
      l.bindIndices(ib, 0, type)
      l.drawIndexed(3, 1, 0, -base)
      l.endPass()
    })
    return Array.from(b.read(pic.image))
  }
  const drawn = picture(8, 8, (x, y) => (y > x ? [255, 0, 0, 255] : [0, 0, 0, 0]))
  assert.deepEqual(draw('u16', 0xa1b2), drawn)
  assert.deepEqual(draw('u32', 0x01a2b3c4), drawn)
})

test('an indexed strip restarts at 0xFFFF (u16) or 0xFFFFFFFF (u32), as WebGPU\'s do; a list, and 0xFFFF among u32 indices, do not', () => {
  const b = new Bench()
  const pic = b.picture(8, 8)
  // The vertex whose vertex-index is a restart value would sit at the top right corner, white, if a triangle used it.
  const v = lens('vertex')
  const vi = v.builtin('vertex-index')
  const stop = v.lor(v.eq(vi, v.lit('u32', 0xffff)), v.eq(vi, v.lit('u32', 0xffffffff)))
  v.position(v.choose(stop, v.lit('f32x4', 1, 1, 0, 1), v.input(0, 'f32x4')))
  v.out(v.output(0, 'f32x4', { flat: true }), v.choose(stop, v.lit('f32x4', 1, 1, 1, 1), v.input(1, 'f32x4')))
  const vertex = v.finish()
  const strip = b.pipeline({ vertex, fragment: colorFragment(true), topology: 'triangle-strip', cull: 'back' })
  const list = b.pipeline({ vertex, fragment: colorFragment(true), cull: 'back' })
  // In pixels: v0 (0, 0), v1 (0, 4), v2 (4, 0) at the top left; v3 (0, 4), v4 (0, 8), v5 (4, 4), v6 (4, 8) below it.
  // Only the first vertex of each triangle gives its (flat) colour.
  const vb = b.vertices([...vtx(-1, 1, RED), ...vtx(-1, 0, CLEAR), ...vtx(0, 1, CLEAR), ...vtx(-1, 0, GREEN), ...vtx(-1, -1, BLUE), ...vtx(0, 0, CLEAR), ...vtx(0, -1, CLEAR)])
  const draw = (pipe: RenderPipeline, type: 'u16' | 'u32', indices: readonly number[], baseVertex = 0): Uint8Array => {
    const ib = b.filled(['index'], type === 'u16' ? new Uint16Array(indices) : new Uint32Array(indices))
    b.submit((l) => {
      b.sync(l, [[pic.image, 'color']])
      l.beginPass({ colors: [color(pic.view)] })
      l.bindPipeline(pipe)
      l.bindVertices(0, [{ buffer: vb }])
      l.bindIndices(ib, 0, type)
      l.drawIndexed(indices.length, 1, 0, baseVertex)
      l.endPass()
    })
    return b.read(pic.image)
  }
  // Triangle (v0, v1, v2) is red; two restarts; then the strip begins again at position 5: (v3, v4, v5) in the strip's
  // order (position 5 is odd, but the first of its piece, so the back-face cull keeps it), green from v3, and
  // (v5, v4, v6), blue from v4. Their shared diagonal x + y = 8 is a left edge of the second only. Nothing is white.
  const restarted = picture(8, 8, (x, y) => (y < 4 ? (x + y <= 2 ? [255, 0, 0, 255] : [0, 0, 0, 0]) : x >= 4 ? [0, 0, 0, 0] : x + y <= 6 ? [0, 255, 0, 255] : [0, 0, 255, 255]))
  const R16 = 0xffff
  const R32 = 0xffffffff
  assert.deepEqual(Array.from(draw(strip, 'u16', [0, 1, 2, R16, R16, 3, 4, 5, 6])), restarted)
  assert.deepEqual(Array.from(draw(strip, 'u32', [0, 1, 2, R32, R32, 3, 4, 5, 6])), restarted)
  // The index is compared before the base vertex is added.
  assert.deepEqual(Array.from(draw(strip, 'u16', [1, 2, 3, R16, R16, 4, 5, 6, 7], -1)), restarted)
  // Among u32 indices 0xFFFF is an ordinary vertex, so the strip runs on through it: (white, v3, v4) is drawn white and
  // the strip's next two triangles face away. A list never restarts: its second triangle is (white, v3, v4) too.
  const through = draw(strip, 'u32', [0, 1, 2, R16, R16, 3, 4, 5, 6])
  assert.deepEqual(px(through, 8, 1, 5), [255, 255, 255, 255])
  assert.deepEqual(px(through, 8, 3, 7), [0, 0, 0, 0])
  const listed = draw(list, 'u16', [0, 1, 2, R16, 3, 4])
  assert.deepEqual(px(listed, 8, 0, 0), [255, 0, 0, 255])
  assert.deepEqual(px(listed, 8, 1, 5), [255, 255, 255, 255])
})

test('a vertex that writes no position makes its triangles draw nothing', () => {
  const b = new Bench()
  const pic = b.picture(8, 8)
  const v = lens('vertex')
  const pos = v.input(0, 'f32x4')
  const c = v.input(1, 'f32x4')
  v.if(v.ne(v.builtin('vertex-index'), 4), () => v.position(pos))
  v.out(v.output(0, 'f32x4'), c)
  const pipe = b.pipeline({ vertex: v.finish() })
  // Draw positions 0 to 5 are vertices 3 to 8: vertex 4 is the second vertex of the left rectangle's first triangle.
  const data = [...rect(8, 8, 0, 0, 4, 8, RED), ...rect(8, 8, 4, 0, 8, 8, GREEN)]
  const vb = b.vertices([...new Array(24).fill(0), ...data])
  b.submit((l) => {
    b.sync(l, [[pic.image, 'color']])
    l.beginPass({ colors: [color(pic.view)] })
    l.bindPipeline(pipe)
    l.bindVertices(0, [{ buffer: vb }])
    l.draw(12, 1, 3)
    l.endPass()
  })
  // The left rectangle's first triangle is (0, 0), (4, 0), (0, 8): its centres have x + 0.5 < 4 - (y + 0.5) / 2; the
  // second triangle (0, 8), (4, 0), (4, 8) holds the rest of the left half, and its shared edge is its left edge.
  assert.deepEqual(Array.from(b.read(pic.image)), picture(8, 8, (x, y) => (x >= 4 ? [0, 255, 0, 255] : 2 * (x + 0.5) + (y + 0.5) >= 8 ? [255, 0, 0, 255] : [0, 0, 0, 0])))
})

// ---------------------------------------------------------------------------------------------------
// Constants, bindings and fragments

test('inline constants: zero until written, written between draws, cleared when a pass begins', () => {
  const b = new Bench()
  const pic = b.picture(8, 2)
  const f = lens('fragment')
  f.input(0, 'f32x4')
  f.out(f.output(0, 'f32x4'), f.read(f.constants({ shade: 'f32x4' }), 'shade'))
  const layout = b.layout([], { size: 16, stages: ['fragment'] })
  const pipe = b.pipeline({ fragment: f.finish(), layout })
  const vb = b.vertices([0, 2, 4, 6].flatMap((x) => rect(8, 2, x, 0, x + 2, 2, CLEAR)))
  b.submit((l) => {
    b.sync(l, [[pic.image, 'color']])
    l.beginPass({ colors: [color(pic.view, 'clear', [0.5, 0.5, 0.5, 0.5])] })
    l.bindPipeline(pipe)
    l.bindVertices(0, [{ buffer: vb }])
    l.draw(6)
    l.setConstants(layout, 0, new Float32Array([1, 0, 0, 1]))
    l.draw(6, 1, 6)
    l.setConstants(layout, 8, new Float32Array([1, 1]))
    l.draw(6, 1, 12)
    l.endPass()
    b.sync(l)
    l.beginPass({ colors: [color(pic.view, 'keep')] })
    l.bindPipeline(pipe)
    l.bindVertices(0, [{ buffer: vb }])
    l.draw(6, 1, 18)
    l.endPass()
  })
  const stripes = [[0, 0, 0, 0], [255, 0, 0, 255], [255, 0, 255, 255], [0, 0, 0, 0]]
  assert.deepEqual(Array.from(b.read(pic.image)), picture(8, 2, (x) => stripes[x >> 1]))
})

test('a dynamic uniform binding reads at the offset each bindSets gives', () => {
  const b = new Bench()
  const pic = b.picture(4, 2)
  const f = lens('fragment')
  f.input(0, 'f32x4')
  f.out(f.output(0, 'f32x4'), f.read(f.uniform(0, 0, { shade: 'f32x4' }), 'shade'))
  const bytes = new Float32Array(128)
  bytes.set([0, 0, 1, 1], 0)
  bytes.set([1, 1, 0, 1], 64)
  const ub = b.filled(['uniform'], bytes)
  const { layout, set } = b.set([{ binding: 0, kind: 'uniform', stages: ['fragment'], dynamic: true }], [{ binding: 0, buffer: ub, size: 16 }])
  const pl = b.layout([layout])
  const pipe = b.pipeline({ fragment: f.finish(), layout: pl })
  const vb = b.vertices([...rect(4, 2, 0, 0, 2, 2, CLEAR), ...rect(4, 2, 2, 0, 4, 2, CLEAR)])
  b.submit((l) => {
    b.sync(l, [[pic.image, 'color']])
    l.beginPass({ colors: [color(pic.view)] })
    l.bindPipeline(pipe)
    l.bindVertices(0, [{ buffer: vb }])
    l.bindSets(pl, 0, [set], [0])
    l.draw(6)
    l.bindSets(pl, 0, [set], [256])
    l.draw(6, 1, 6)
    l.endPass()
  })
  assert.deepEqual(Array.from(b.read(pic.image)), picture(4, 2, (x) => (x < 2 ? [0, 0, 255, 255] : [255, 255, 0, 255])))
})

test('discard keeps a fragment from writing colour or depth', () => {
  const b = new Bench()
  const pic = b.picture(8, 2)
  const depth = b.picture(8, 2, 'depth32f')
  const f = lens('fragment')
  const c = f.input(0, 'f32x4')
  f.if(f.lt(f.pick(f.builtin('frag-coord'), 'x'), 4), () => f.discard())
  f.out(f.output(0, 'f32x4'), c)
  const pipe = b.pipeline({ fragment: f.finish(), depth: { format: 'depth32f', write: true, compare: 'less' } })
  const vb = b.vertices(rect(8, 2, 0, 0, 8, 2, GREEN, 0.5))
  b.submit((l) => {
    b.sync(l, [[pic.image, 'color'], [depth.image, 'depth']])
    l.beginPass({ colors: [color(pic.view)], depth: depthOf(depth.view) })
    l.bindPipeline(pipe)
    l.bindVertices(0, [{ buffer: vb }])
    l.draw(6)
    l.endPass()
  })
  assert.deepEqual(Array.from(b.read(pic.image)), picture(8, 2, (x) => (x < 4 ? [0, 0, 0, 0] : [0, 255, 0, 255])))
  assert.deepEqual(floats(b.read(depth.image)), picture(8, 2, (x) => [x < 4 ? 1 : 0.5]))
})

// ---------------------------------------------------------------------------------------------------
// Compute

function counterLens(): LensModule {
  const b = lens('compute', { group: [8, 1, 1] })
  const data = b.storage(0, 0, { items: arrayOf('u32') }, { writable: true })
  const i = b.pick(b.builtin('global-id'), 'x')
  b.write(data, ['items', i], b.add(b.mul(i, 3), 1))
  return b.finish()
}

test('a compute shader writes a storage buffer, copied to readback memory and invalidated once the fence signals', () => {
  const b = new Bench()
  const store = b.buffer(128, ['storage', 'copy-src'])
  const rb = b.buffer(128, ['copy-dst'], KIND.readback)
  const { layout, set } = b.set([{ binding: 0, kind: 'storage', stages: ['compute'] }], [{ binding: 0, buffer: store }])
  const pl = b.layout([layout])
  const pipe = b.device.createComputePipeline({ layout: pl, lens: b.device.createLens(counterLens()) })
  const arena = b.device.createCommandArena()
  const l = arena.allocate()
  l.begin()
  l.bindPipeline(pipe)
  l.bindSets(pl, 0, [set])
  l.dispatch(4)
  l.barrier({ buffers: [{ buffer: store, before: { stages: ['compute'], access: ['shader-write'] }, after: { stages: ['copy'], access: ['copy-read'] } }] })
  l.copyBuffer(store, rb, [{ from: 0, to: 0, size: 128 }])
  l.barrier({ buffers: [{ buffer: rb, before: { stages: ['copy'], access: ['copy-write'] }, after: { stages: ['host'], access: ['host-read'] } }] })
  l.end()
  const fence = b.device.createFence()
  let values: number[] = []
  fence.onSignal(() => {
    const memory = rb.memory as NonNullable<Buffer['memory']>
    memory.invalidate()
    values = Array.from(new Uint32Array(memory.map().buffer, 0, 32))
  })
  b.queue.submit([{ lists: [l] }], fence)
  assert.deepEqual(values, Array.from({ length: 32 }, (_, i) => 3 * i + 1))
})

test('a compute shader writes a storage image through put, one invocation per texel', () => {
  const b = new Bench()
  const img = b.image({ format: 'r32u', width: 4, height: 4, use: ['storage', 'copy-src'] })
  const c = lens('compute', { group: [2, 2, 1] })
  const out = c.storageImage(0, 0, 'r32u')
  const id = c.builtin('global-id')
  const xy = c.pick(id, 'xy')
  c.put(out, xy, c.make('u32x4', c.add(c.lane(id, 0), c.mul(c.lane(id, 1), 10)), 0, 0, 0))
  const { layout, set } = b.set([{ binding: 0, kind: 'storage-image', stages: ['compute'], format: 'r32u' }], [{ binding: 0, view: b.device.createView(img) }])
  const pl = b.layout([layout])
  const pipe = b.device.createComputePipeline({ layout: pl, lens: b.device.createLens(c.finish()) })
  b.submit((l) => {
    b.sync(l, [[img, 'general']])
    l.bindPipeline(pipe)
    l.bindSets(pl, 0, [set])
    l.dispatch(2, 2)
  })
  assert.deepEqual(Array.from(new Uint32Array(b.read(img).buffer)), picture(4, 4, (x, y) => [x + 10 * y]))
})

// ---------------------------------------------------------------------------------------------------
// Indirect work

test('indirect draws and dispatches read their numbers from the buffer when they run, and skip numbers a direct call could not have', () => {
  const b = new Bench()
  const pic = b.picture(8, 8)
  const pipe = b.pipeline()
  const lower = [...vtx(-1, -1, RED), ...vtx(1, -1, RED), ...vtx(-1, 1, RED)]
  const vb = b.vertices(lower)
  const ib = b.filled(['index'], new Uint16Array([2, 0, 1, 0]))
  // Words 0-3: a draw of 3 vertices. 4-8: an indexed draw of 3 indices. 9-12: a draw reaching vertex 4 (past the
  // buffer). 13-17: an indexed draw of indices 2 to 5 (past the index buffer).
  const args = b.filled(['indirect'], new Uint32Array([3, 1, 0, 0, 3, 1, 0, 0, 0, 3, 1, 2, 0, 3, 1, 2, 0, 0]))
  const run = (record: (l: CommandList) => void): Uint8Array => {
    b.submit((l) => {
      b.sync(l, [[pic.image, 'color']])
      l.beginPass({ colors: [color(pic.view)] })
      l.bindPipeline(pipe)
      l.bindVertices(0, [{ buffer: vb }])
      l.bindIndices(ib, 0, 'u16')
      record(l)
      l.endPass()
    })
    return b.read(pic.image)
  }
  const drawn = picture(8, 8, (x, y) => (y > x ? [255, 0, 0, 255] : [0, 0, 0, 0]))
  const blank = new Array(256).fill(0)
  assert.deepEqual(Array.from(run((l) => l.drawIndirect(args, 0))), drawn)
  assert.deepEqual(Array.from(run((l) => l.drawIndexedIndirect(args, 16))), drawn)
  assert.deepEqual(Array.from(run((l) => l.drawIndirect(args, 36))), blank)
  assert.deepEqual(Array.from(run((l) => l.drawIndexedIndirect(args, 52))), blank)
  // The numbers are read when the list runs: rewriting them changes what the same recorded command draws.
  const arena = b.device.createCommandArena()
  const list = arena.allocate()
  list.begin()
  b.sync(list, [[pic.image, 'color']])
  list.beginPass({ colors: [color(pic.view)] })
  list.bindPipeline(pipe)
  list.bindVertices(0, [{ buffer: vb }])
  list.drawIndirect(args, 0)
  list.endPass()
  b.sync(list)
  list.end()
  b.submit((l) => l.updateBuffer(args, 0, new Uint32Array([0])))
  b.queue.submit([{ lists: [list] }])
  assert.deepEqual(Array.from(b.read(pic.image)), blank)
  // Dispatches: 4 workgroups from the buffer; 70000 along x is past the device's 65535 and runs nothing.
  const store = b.buffer(128, ['storage', 'copy-src', 'copy-dst'])
  const { layout, set } = b.set([{ binding: 0, kind: 'storage', stages: ['compute'] }], [{ binding: 0, buffer: store }])
  const pl = b.layout([layout])
  const cp = b.device.createComputePipeline({ layout: pl, lens: b.device.createLens(counterLens()) })
  const groups = b.filled(['indirect'], new Uint32Array([4, 1, 1, 70000, 1, 1]))
  const dispatchAt = (offset: number): number[] => {
    b.submit((l) => {
      l.zeroBuffer(store, 0, 128)
      b.sync(l)
      l.bindPipeline(cp)
      l.bindSets(pl, 0, [set])
      l.dispatchIndirect(groups, offset)
    })
    return Array.from(new Uint32Array(b.readBuffer(store).buffer))
  }
  assert.deepEqual(dispatchAt(0), Array.from({ length: 32 }, (_, i) => 3 * i + 1))
  assert.deepEqual(dispatchAt(12), new Array(32).fill(0))
})

test('an indirect draw whose first instance is not 0 draws nothing, as WebGPU\'s do without indirect-first-instance; a direct draw keeps it', () => {
  const b = new Bench()
  const pic = b.picture(8, 8)
  const pipe = b.pipeline()
  const vb = b.vertices([...vtx(-1, -1, RED), ...vtx(1, -1, RED), ...vtx(-1, 1, RED)])
  const ib = b.filled(['index'], new Uint16Array([0, 1, 2, 0]))
  // Words 0-3: a draw of 3 vertices from instance 1; 4-7: the same from instance 0. 8-12: an indexed draw of 3 indices
  // from instance 1; 13-17: the same from instance 0.
  const args = b.filled(['indirect'], new Uint32Array([3, 1, 0, 1, 3, 1, 0, 0, 3, 1, 0, 0, 1, 3, 1, 0, 0, 0]))
  const run = (record: (l: CommandList) => void): number[] => {
    b.submit((l) => {
      b.sync(l, [[pic.image, 'color']])
      l.beginPass({ colors: [color(pic.view)] })
      l.bindPipeline(pipe)
      l.bindVertices(0, [{ buffer: vb }])
      l.bindIndices(ib, 0, 'u16')
      record(l)
      l.endPass()
    })
    return Array.from(b.read(pic.image))
  }
  const drawn = picture(8, 8, (x, y) => (y > x ? [255, 0, 0, 255] : [0, 0, 0, 0]))
  const blank = new Array(256).fill(0)
  assert.deepEqual(run((l) => l.drawIndirect(args, 0)), blank)
  assert.deepEqual(run((l) => l.drawIndirect(args, 16)), drawn)
  assert.deepEqual(run((l) => l.drawIndexedIndirect(args, 32)), blank)
  assert.deepEqual(run((l) => l.drawIndexedIndirect(args, 52)), drawn)
  assert.deepEqual(run((l) => l.draw(3, 1, 0, 1)), drawn)
  assert.deepEqual(run((l) => l.drawIndexed(3, 1, 0, 0, 1)), drawn)
})

// ---------------------------------------------------------------------------------------------------
// Copies

test('buffer and image copies round trip through padded rows, leaving the bytes between rows as they were', () => {
  const b = new Bench()
  const next = lcg(7)
  const source = new Uint8Array(1536).map(() => Math.floor(next() * 256))
  const src = b.filled(['copy-src'], source)
  const img = b.image({ format: 'rgba8', width: 5, height: 3, use: ['copy-src', 'copy-dst'] })
  const dst = b.filled(['copy-src'], new Uint8Array(2048).fill(0xab))
  b.submit((l) => {
    b.sync(l, [[img, 'copy-dst']])
    l.copyBufferToImage(src, img, [{ offset: 512, rowBytes: 256, region: { width: 5, height: 3 } }])
    b.sync(l, [[img, 'copy-src']])
    l.copyImageToBuffer(img, dst, [{ offset: 256, rowBytes: 512, region: { width: 5, height: 3 } }])
  })
  const want = new Uint8Array(2048).fill(0xab)
  for (let y = 0; y < 3; y++) want.set(source.subarray(512 + 256 * y, 512 + 256 * y + 20), 256 + 512 * y)
  assert.deepEqual(Array.from(b.readBuffer(dst)), Array.from(want))
  // A sub-rectangle of a level and layer, then an image-to-image copy onto another level and layer.
  const layered = b.image({ format: 'rgba8', width: 8, height: 8, levels: 2, layers: 2, use: ['copy-src', 'copy-dst'] })
  b.submit((l) => {
    b.sync(l, [[img, 'copy-src'], [layered, 'copy-dst']])
    l.copyImage(img, layered, [{ from: { x: 1, y: 1, width: 3, height: 2 }, to: { level: 1, layer: 1, x: 1, y: 2 } }])
    l.copyBufferToImage(src, layered, [{ offset: 0, rowBytes: 4, region: { x: 6, y: 7, width: 1, height: 1 } }])
  })
  const level1 = b.read(layered, 1, 1)
  const image = b.read(img)
  assert.deepEqual(Array.from(level1), picture(4, 4, (x, y) => (x >= 1 && x < 4 && y >= 2 && y < 4 ? px(image, 5, x, y - 1) : [0, 0, 0, 0])))
  const level0 = b.read(layered, 0, 0)
  assert.deepEqual(px(level0, 8, 6, 7), Array.from(source.subarray(0, 4)))
  assert.equal(level0.reduce((s, v) => s + v, 0), source.subarray(0, 4).reduce((s, v) => s + v, 0))
})

test('random copies into and out of an image agree with a model of its bytes (seeded)', () => {
  const b = new Bench()
  const next = lcg(2026)
  const W = 13
  const H = 7
  const img = b.image({ format: 'rgba8', width: W, height: H, layers: 2, use: ['copy-src', 'copy-dst'] })
  const model = [new Uint8Array(W * H * 4), new Uint8Array(W * H * 4)]
  const src = b.filled(['copy-src'], new Uint8Array(8192).map(() => Math.floor(next() * 256)))
  const bytes = b.readBuffer(src)
  const pick = (n: number): number => Math.floor(next() * n)
  for (let k = 0; k < 24; k++) {
    const width = 1 + pick(W)
    const height = 1 + pick(H)
    const x = pick(W - width + 1)
    const y = pick(H - height + 1)
    const layer = pick(2)
    const rowBytes = height === 1 ? width * 4 + 4 * pick(4) : 256 * (1 + pick(2))
    const offset = 4 * pick(256)
    b.submit((l) => {
      b.sync(l, [[img, 'copy-dst']])
      l.copyBufferToImage(src, img, [{ offset, rowBytes, region: { layer, x, y, width, height } }])
    })
    for (let r = 0; r < height; r++) model[layer].set(bytes.subarray(offset + r * rowBytes, offset + r * rowBytes + width * 4), ((y + r) * W + x) * 4)
  }
  for (const layer of [0, 1]) assert.deepEqual(Array.from(b.read(img, 0, layer)), Array.from(model[layer]), `layer ${layer}`)
  // And out: rows of random sub-rectangles into a buffer of a pattern.
  for (let k = 0; k < 12; k++) {
    const width = 1 + pick(W)
    const height = 1 + pick(H)
    const x = pick(W - width + 1)
    const y = pick(H - height + 1)
    const layer = pick(2)
    const out = b.filled(['copy-src'], new Uint8Array(2048).fill(k))
    b.submit((l) => {
      b.sync(l, [[img, 'copy-src']])
      l.copyImageToBuffer(img, out, [{ offset: 16, rowBytes: height === 1 ? width * 4 : 256, region: { layer, x, y, width, height } }])
    })
    const want = new Uint8Array(2048).fill(k)
    for (let r = 0; r < height; r++) want.set(model[layer].subarray(((y + r) * W + x) * 4, ((y + r) * W + x + width) * 4), 16 + r * 256)
    assert.deepEqual(Array.from(b.readBuffer(out)), Array.from(want), `copy ${k}`)
  }
})

// ---------------------------------------------------------------------------------------------------
// Order of drawing (property)

test('random rectangles: one draw paints them in order, and with depth the nearest wins (seeded)', () => {
  const b = new Bench()
  const next = lcg(99)
  const W = 16
  const H = 12
  const n = 40
  const pick = (k: number): number => Math.floor(next() * k)
  const order = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = pick(i + 1)
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  const rects = Array.from({ length: n }, (_, i) => {
    const x0 = pick(W)
    const y0 = pick(H)
    const bytes = [pick(256), pick(256), pick(256)]
    return { x0, y0, x1: x0 + 1 + pick(W - x0), y1: y0 + 1 + pick(H - y0), bytes, z: (order[i] + 1) / 64 }
  })
  const data = rects.flatMap((r) => rect(W, H, r.x0, r.y0, r.x1, r.y1, [r.bytes[0] / 255, r.bytes[1] / 255, r.bytes[2] / 255, 1], r.z))
  const inside = (r: (typeof rects)[number], x: number, y: number): boolean => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1
  const painted = b.picture(W, H)
  drawOnce(b, painted, b.pipeline(), data)
  assert.deepEqual(Array.from(b.read(painted.image)), picture(W, H, (x, y) => {
    const top = rects.filter((r) => inside(r, x, y)).pop()
    return top === undefined ? [0, 0, 0, 0] : [...top.bytes, 255]
  }))
  const tested = b.picture(W, H)
  const depth = b.picture(W, H, 'depth32f')
  const pipe = b.pipeline({ depth: { format: 'depth32f', write: true, compare: 'less' } })
  const vb = b.vertices(data)
  b.submit((l) => {
    b.sync(l, [[tested.image, 'color'], [depth.image, 'depth']])
    l.beginPass({ colors: [color(tested.view)], depth: depthOf(depth.view) })
    l.bindPipeline(pipe)
    l.bindVertices(0, [{ buffer: vb }])
    l.draw(6 * n)
    l.endPass()
  })
  assert.deepEqual(Array.from(b.read(tested.image)), picture(W, H, (x, y) => {
    const hits = rects.filter((r) => inside(r, x, y)).sort((p, q) => p.z - q.z)
    return hits.length === 0 ? [0, 0, 0, 0] : [...hits[0].bytes, 255]
  }))
})

// ---------------------------------------------------------------------------------------------------
// The step budget

function spinLens(rounds: number): LensModule {
  const b = lens('compute', { group: [4, 1, 1] })
  const data = b.storage(0, 0, { items: arrayOf('u32') }, { writable: true })
  const i = b.pick(b.builtin('global-id'), 'x')
  const n = b.var('u32', 0)
  b.loop(() => {
    b.if(b.ge(b.get(n), rounds), () => b.break())
    b.set(n, b.add(b.get(n), 1))
  })
  b.write(data, ['items', i], b.get(n))
  return b.finish()
}

test('the step budget is shared by a submit\'s work: exactly enough runs, one step less stops the submit with bound', () => {
  const module = spinLens(50)
  // The steps the interpreter counts for two workgroups of this shader, measured on its own.
  const program = compile(module)
  const bytes = new Uint8Array(64)
  const bindings = program.bind({ block: () => ({ bytes, offset: 0, size: 64 }), image: () => null, sampler: () => null, storageImage: () => null })
  const steps = dispatch(program, bindings, [2, 1, 1])
  assert.ok(steps > 400)
  const attempt = (budget: number, twice: boolean): { readonly b: Bench; readonly store: Buffer; readonly run: () => void; readonly record: (l: CommandList) => void } => {
    const b = new Bench({ steps: budget })
    const store = b.buffer(64, ['storage', 'copy-src'])
    const { layout, set } = b.set([{ binding: 0, kind: 'storage', stages: ['compute'] }], [{ binding: 0, buffer: store }])
    const pl = b.layout([layout])
    const pipe = b.device.createComputePipeline({ layout: pl, lens: b.device.createLens(module) })
    const record = (l: CommandList): void => {
      l.bindPipeline(pipe)
      l.bindSets(pl, 0, [set])
      l.dispatch(2)
      if (twice) {
        b.sync(l)
        l.dispatch(2)
      }
    }
    return { b, store, record, run: () => b.submit(record) }
  }
  const ok = attempt(steps, false)
  ok.run()
  assert.deepEqual(Array.from(new Uint32Array(ok.b.readBuffer(ok.store).buffer)).slice(0, 8), new Array(8).fill(50))
  refuses(attempt(steps - 1, false).run, 'bound', /^reference renderer: list 0 command 3 \(dispatch\): the work ran past this submit's budget of \d+ steps/)
  attempt(2 * steps, true).run()
  const second = refuses(attempt(2 * steps - 1, true).run, 'bound', /list 0 command 5 \(dispatch\)/)
  assert.match(second.message, new RegExp(`budget of ${2 * steps - 1} steps`))
  // A submit that stops part way signals nothing and loses the device: work may have run, so none is taken after it,
  // and everything can still be destroyed.
  const late = attempt(10, false)
  const fence = late.b.device.createFence()
  const l = late.b.device.createCommandArena().allocate()
  l.begin()
  late.record(l)
  l.end()
  assert.equal(late.b.device.lost(), null)
  refuses(() => late.b.queue.submit([{ lists: [l] }], fence), 'bound')
  assert.equal(fence.signalled, false)
  assert.match(late.b.device.lost() ?? '', /^a submit stopped part way: reference renderer: list 0 command \d+ \(dispatch\): the work ran past/)
  refuses(() => late.b.queue.submit([{ lists: [l] }], fence), 'device', /the device is lost \(a submit stopped part way/)
  refuses(() => late.b.device.createBindingLayout({ entries: [] }), 'device', /the device is lost/)
  late.b.device.destroy()
})

test('draws are bounded too: the vertex and fragment invocations and each quad rasterised count against the budget', () => {
  const draw = (steps: number): void => {
    const b = new Bench({ steps })
    const pic = b.picture(8, 8)
    drawOnce(b, pic, b.pipeline(), rect(8, 8, 0, 0, 8, 8, RED))
  }
  draw(10_000)
  refuses(() => draw(20), 'bound', /reference renderer: list 0 command \d+ \(draw\): the work ran past this submit's budget of 20 steps/)
  // A depth-only pipeline runs no fragment invocations; its quads still count.
  const b = new Bench({ steps: 40 })
  const depth = b.picture(8, 8, 'depth32f')
  const pipe = b.pipeline({ fragment: null, depth: { format: 'depth32f', write: true, compare: 'always' } })
  const vb = b.vertices(rect(8, 8, 0, 0, 8, 8, RED, 0.5))
  refuses(() => b.submit((l) => {
    b.sync(l, [[depth.image, 'depth']])
    l.beginPass({ colors: [], depth: depthOf(depth.view) })
    l.bindPipeline(pipe)
    l.bindVertices(0, [{ buffer: vb }])
    l.draw(6)
    l.endPass()
  }), 'bound', /\(draw\)/)
})

/** The steps the interpreter counts for one batch of three vertices of colorVertex(), measured on its own. */
function colorVertexSteps(): number {
  const program = compile(colorVertex())
  const none = { block: () => null, image: () => null, sampler: () => null, storageImage: () => null }
  return program.run({ lanes: 3, inputs: new Float64Array(3 * program.inputWidth) }, program.bind(none), 1e6).steps
}

test('a sliver whose box is large is bounded: each sample point of each 2 x 2 quad the scan visits counts, covered or not, within the scissor', () => {
  // A wedge just below the line y = x - 0.125 across a 64 x 64 picture holds no pixel centre and none of the four
  // sample positions, but its box is the whole picture, 32 x 32 quads: four steps each (one per pixel's sample point)
  // beside the vertex steps, and no fragment runs.
  const W = 64
  const vertexSteps = colorVertexSteps()
  const cx = (x: number): number => (2 * x) / W - 1
  const cy = (y: number): number => 1 - (2 * y) / W
  const sliver = [...vtx(cx(0.125), cy(0), RED), ...vtx(cx(W), cy(W - 0.125), RED), ...vtx(cx(W), cy(W - 0.125 - 1 / 64), RED)]
  const draw = (steps: number, instances: number, scissor?: Rect, samples: 1 | 4 = 1): Uint8Array | null => {
    const b = new Bench({ steps })
    const pic = b.picture(W, W, 'rgba8', samples)
    const pipe = b.pipeline({ samples })
    const vb = b.vertices(sliver)
    b.submit((l) => {
      b.sync(l, [[pic.image, 'color']])
      l.beginPass({ colors: [color(pic.view)] })
      if (scissor !== undefined) l.setScissor(scissor)
      l.bindPipeline(pipe)
      l.bindVertices(0, [{ buffer: vb }])
      l.draw(3, instances)
      l.endPass()
    })
    return samples === 1 ? b.read(pic.image) : null
  }
  const per = vertexSteps + 32 * 32 * 4
  assert.deepEqual(Array.from(draw(per, 1) ?? []), new Array(W * W * 4).fill(0))
  refuses(() => draw(per - 1, 1), 'bound', /\(draw\): the work ran past this submit's budget of \d+ steps \(a step is .*one sample point of a 2 x 2 quad the rasteriser scans/)
  // Every instance scans again.
  draw(2 * per, 2)
  refuses(() => draw(2 * per - 1, 2), 'bound', /\(draw\)/)
  // The scan is clipped to the scissor first: pixels [0, 8) x [0, 8) are 4 x 4 quads.
  draw(vertexSteps + 16 * 4, 1, { x: 0, y: 0, width: 8, height: 8 })
  refuses(() => draw(vertexSteps + 16 * 4 - 1, 1, { x: 0, y: 0, width: 8, height: 8 }), 'bound', /\(draw\)/)
  // With four samples the scan tests four points of each pixel, so a quad is sixteen steps.
  draw(vertexSteps + 32 * 32 * 16, 1, undefined, 4)
  refuses(() => draw(vertexSteps + 32 * 32 * 16 - 1, 1, undefined, 4), 'bound', /\(draw\)/)
  // An indexed strip of nothing but restarts shades nothing and draws nothing, yet each restart index is a step.
  const restarts = (steps: number): void => {
    const b = new Bench({ steps })
    const pic = b.picture(8, 8)
    const pipe = b.pipeline({ topology: 'triangle-strip' })
    const vb = b.vertices(sliver)
    const ib = b.filled(['index'], new Uint16Array(64).fill(0xffff))
    b.submit((l) => {
      b.sync(l, [[pic.image, 'color']])
      l.beginPass({ colors: [color(pic.view)] })
      l.bindPipeline(pipe)
      l.bindVertices(0, [{ buffer: vb }])
      l.bindIndices(ib, 0, 'u16')
      l.drawIndexed(64, 2)
      l.endPass()
    })
  }
  restarts(128)
  refuses(() => restarts(127), 'bound', /\(draw-indexed\)/)
})

test('a clipped triangle is charged for the scan of each triangle of its fan, whose boxes overlap: the full-screen triangle twice', () => {
  // The usual full-screen triangle, drawn depth-only on a 16 x 16 depth attachment, is clipped to the view square and
  // drawn as a fan of two triangles. Each one's box is the whole attachment, 8 x 8 quads, so the scan charges
  // 2 x 64 quads of 4 steps each beside the vertex steps, though the attachment holds only 64 quads.
  const vertexSteps = colorVertexSteps()
  const draw = (steps: number): number[] => {
    const b = new Bench({ steps })
    const depth = b.picture(16, 16, 'depth32f')
    const pipe = b.pipeline({ fragment: null, depth: { format: 'depth32f', write: true, compare: 'always' } })
    const vb = b.vertices([...vtx(-1, -1, RED, 0.5), ...vtx(3, -1, RED, 0.5), ...vtx(-1, 3, RED, 0.5)])
    b.submit((l) => {
      b.sync(l, [[depth.image, 'depth']])
      l.beginPass({ colors: [], depth: depthOf(depth.view) })
      l.bindPipeline(pipe)
      l.bindVertices(0, [{ buffer: vb }])
      l.draw(3)
      l.endPass()
    })
    return floats(b.read(depth.image))
  }
  const steps = vertexSteps + 2 * 64 * 4
  assert.deepEqual(draw(steps), new Array(16 * 16).fill(0.5))
  refuses(() => draw(steps - 1), 'bound', /\(draw\)/)
})
