// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the bench the core's tests stand on: a fake back end that records every call the
 * core makes of it and finishes submitted work at once or only when a test says so, an adapter report with the
 * limits of the specification, a rig that opens a device on it, a check that a call is refused with a given code
 * and sentence, and small makers for bound buffers and images and for the shaders the tests draw with. It holds no
 * test of its own; the test files import it.
 * What breaks if it is removed? Every core test would build its own fake back end, and the tests would disagree on
 * what a back end is told.
 */
import assert from 'node:assert/strict'
import type {
  AdapterReport, Backend, BackendDevice, BindingLayoutInfo, BoundEntry, Buffer, BufferInfo, BufferUse, Command, Device, Feature, Handle, Image, ImageInfo,
  Instance, Limits, MemoryKindName, Range, RenderPipelineInfo, View, ViewInfo, Wrap,
} from './api.ts'
import { arrayOf, lens } from './builder.ts'
import { isFault } from './fault.ts'
import type { Fault, FaultCode } from './fault.ts'
import { createInstance } from './instance.ts'
import type { ImageDims, LensModule, Stage } from './lens.ts'

/**
 * The limits of the specification: within WebGPU's defaults, below them for sets (3, not 4), bindings (16, not 1000) and
 * stageUniforms (11, not 12), the fourth set and one uniform binding of each stage being the GPU back end's own block.
 */
export const LIMITS: Limits = Object.freeze({
  imageSize: 8192, imageLayers: 256, sets: 3, bindings: 16, uniformRange: 65536, storageRange: 134217728, offsetAlign: 256,
  stageUniforms: 11, stageStorage: 8, stageImages: 16, stageSamplers: 16, stageStorageImages: 4, dynamicUniforms: 8, dynamicStorage: 4,
  vertexBuffers: 8, vertexAttributes: 16, vertexStride: 2048, interStage: 16, colorAttachments: 8, colorBytes: 32, constants: 128,
  groupInvocations: 256, groupSize: Object.freeze([256, 256, 64] as const), groups: 65535, bufferSize: 268435456, allocationSize: 268435456,
  allocations: 4096, copyRowAlign: 256, updateSize: 65536,
})

/** The index of each memory kind in the fake adapter. */
export const KIND = Object.freeze({ device: 0, images: 1, upload: 2, readback: 3 })
export const HEAP_DEVICE = 1 << 26
export const HEAP_HOST = 1 << 24

export function adapterReport(o: Partial<AdapterReport> = {}): AdapterReport {
  return {
    name: 'fake',
    kind: 'reference',
    limits: LIMITS,
    features: ['float32-filter', 'depth-unclipped'],
    heaps: [{ index: 0, size: HEAP_DEVICE, local: true }, { index: 1, size: HEAP_HOST, local: false }],
    kinds: [
      { index: 0, name: 'device', heap: 0, host: false },
      { index: 1, name: 'images', heap: 0, host: false },
      { index: 2, name: 'upload', heap: 1, host: true },
      { index: 3, name: 'readback', heap: 1, host: true },
    ],
    groups: [{ index: 0, graphics: true, compute: true, copy: true, count: 2 }, { index: 1, graphics: false, compute: false, copy: true, count: 1 }],
    ...o,
  }
}

export interface Call {
  readonly call: string
  readonly args: readonly unknown[]
}

/** A back end handle: what kind of object, and a serial number. */
export interface FakeHandle {
  readonly kind: string
  readonly n: number
  readonly bytes?: Uint8Array
}

/** A back end device that records every call and keeps submitted work until `finish()` when `auto` is false. */
export class FakeDevice implements BackendDevice {
  readonly calls: Call[] = []
  /** Finish each submission inside submit() (as the reference renderer does). */
  auto = true
  readonly waiting: (() => void)[] = []
  lostReason: string | null = null
  /** The next call of this name raises this error. */
  raise: { readonly name: string; readonly error: unknown } | null = null
  private n = 0

  private log(call: string, args: readonly unknown[]): void {
    if (this.raise !== null && this.raise.name === call) {
      const e = this.raise.error
      this.raise = null
      throw e
    }
    this.calls.push({ call, args })
  }

  private make(kind: string, bytes?: Uint8Array): FakeHandle {
    this.n++
    return Object.freeze(bytes === undefined ? { kind, n: this.n } : { kind, n: this.n, bytes })
  }

  allocate(kind: MemoryKindName, size: number): Handle {
    this.log('allocate', [kind, size])
    return this.make('memory', kind === 'upload' || kind === 'readback' ? new Uint8Array(size) : undefined)
  }

  hostBytes(memory: Handle): Uint8Array {
    this.log('hostBytes', [memory])
    return (memory as FakeHandle).bytes as Uint8Array
  }

  flush(memory: Handle, offset: number, size: number): void {
    this.log('flush', [memory, offset, size])
  }

  invalidate(memory: Handle, offset: number, size: number): void {
    this.log('invalidate', [memory, offset, size])
  }

  createBuffer(info: BufferInfo, memory: Handle, offset: number): Handle {
    this.log('createBuffer', [info, memory, offset])
    return this.make('buffer')
  }

  createImage(info: Required<ImageInfo>, memory: Handle, offset: number): Handle {
    this.log('createImage', [info, memory, offset])
    return this.make('image')
  }

  createView(image: Handle, dims: ImageDims, levels: Range, layers: Range): Handle {
    this.log('createView', [image, dims, levels, layers])
    return this.make('view')
  }

  createSampler(info: { readonly mag: string; readonly min: string; readonly mip: string; readonly wrap: readonly [Wrap, Wrap, Wrap]; readonly lodMin: number; readonly lodMax: number; readonly label: string }): Handle {
    this.log('createSampler', [info])
    return this.make('sampler')
  }

  createBindingLayout(info: BindingLayoutInfo): Handle {
    this.log('createBindingLayout', [info])
    return this.make('binding layout')
  }

  createPipelineLayout(sets: readonly Handle[], constants: { readonly size: number; readonly stages: readonly Stage[] } | null): Handle {
    this.log('createPipelineLayout', [sets, constants])
    return this.make('pipeline layout')
  }

  createBindingSet(layout: Handle): Handle {
    this.log('createBindingSet', [layout])
    return this.make('set')
  }

  writeBindingSet(set: Handle, entries: readonly BoundEntry[]): void {
    this.log('writeBindingSet', [set, entries])
  }

  createLens(module: LensModule): Handle {
    this.log('createLens', [module])
    return this.make('lens')
  }

  createRenderPipeline(info: RenderPipelineInfo, layout: Handle, vertex: Handle, fragment: Handle | null): Handle {
    this.log('createRenderPipeline', [info, layout, vertex, fragment])
    return this.make('render pipeline')
  }

  createComputePipeline(layout: Handle, lensHandle: Handle): Handle {
    this.log('createComputePipeline', [layout, lensHandle])
    return this.make('compute pipeline')
  }

  submit(lists: readonly (readonly Command[])[], done: () => void): void {
    this.log('submit', [lists])
    if (this.auto) done()
    else this.waiting.push(done)
  }

  destroy(handle: Handle): void {
    this.log('destroy', [handle])
  }

  lost(): string | null {
    return this.lostReason
  }

  /** Finishes every submission held so far, oldest first. */
  finish(): void {
    for (const done of this.waiting.splice(0)) done()
  }

  /** The calls of one name. */
  named(call: string): readonly Call[] {
    return this.calls.filter((c) => c.call === call)
  }

  last(call: string): Call {
    const all = this.named(call)
    assert.ok(all.length > 0, `no ${call} call`)
    return all[all.length - 1]
  }
}

export class FakeBackend implements Backend {
  readonly name: string
  readonly reports: readonly AdapterReport[]
  readonly opened: { readonly adapter: number; readonly features: readonly Feature[]; readonly limits: Limits; readonly device: FakeDevice }[] = []

  constructor(name: string, reports: readonly AdapterReport[]) {
    this.name = name
    this.reports = reports
  }

  adapters(): readonly AdapterReport[] {
    return this.reports
  }

  open(adapter: number, features: readonly Feature[], limits: Limits): BackendDevice {
    const device = new FakeDevice()
    this.opened.push({ adapter, features, limits, device })
    return device
  }
}

export interface Rig {
  readonly backend: FakeBackend
  readonly instance: Instance
  readonly device: Device
  readonly fake: FakeDevice
  /** Every Fault the report callback was handed. */
  readonly faults: Fault[]
}

/** An instance over one fake back end, and a device opened on its one adapter. */
export function rig(o: { readonly checks?: boolean; readonly features?: readonly Feature[]; readonly limits?: Partial<Limits>; readonly report?: Partial<AdapterReport> } = {}): Rig {
  const faults: Fault[] = []
  const backend = new FakeBackend('fake', [adapterReport(o.report)])
  const instance = createInstance({ app: 'tests', backends: [backend], checks: o.checks, report: (f) => faults.push(f) })
  const device = instance.open(instance.adapters()[0], { features: o.features ?? ['float32-filter', 'depth-unclipped'], limits: o.limits, queues: [{ group: 0, count: 2 }, { group: 1, count: 1 }] })
  return { backend, instance, device, fake: backend.opened[0].device, faults }
}

/** Runs f and checks that it is refused with a Fault of the code (and a message matching the pattern). */
export function refuses(f: () => unknown, code: FaultCode, pattern?: RegExp): Fault {
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

/** A buffer bound at offset 0 of its own memory of a kind. */
export function buffer(r: Rig, size: number, use: readonly BufferUse[], kind: number = KIND.device, label?: string): Buffer {
  const b = r.device.createBuffer({ size, use, label })
  const memory = r.device.allocate({ size: Math.max(256, r.device.needs(b).size), kind })
  r.device.bind(b, memory, 0)
  return b
}

/** An image bound at offset 0 of its own images memory. */
export function image(r: Rig, info: ImageInfo): Image {
  const img = r.device.createImage(info)
  const memory = r.device.allocate({ size: r.device.needs(img).size, kind: KIND.images })
  r.device.bind(img, memory, 0)
  return img
}

/** A bound image and a view of it. */
export function imageView(r: Rig, info: ImageInfo, view?: ViewInfo): View {
  return r.device.createView(image(r, info), view)
}

// ---------------------------------------------------------------------------------------------------
// Shaders

/** A vertex lens: position (f32x2) at slot 0, colour (f32x4) at slot 1, passing the colour on at slot 0. */
export function vertexLens(): LensModule {
  const b = lens('vertex')
  const pos = b.input(0, 'f32x2')
  const color = b.input(1, 'f32x4')
  const out = b.output(0, 'f32x4')
  b.position(b.make('f32x4', pos, 0, 1))
  b.out(out, color)
  return b.finish()
}

/** A fragment lens writing its slot-0 input to output slot 0. */
export function fragmentLens(): LensModule {
  const b = lens('fragment')
  const color = b.input(0, 'f32x4')
  b.out(b.output(0, 'f32x4'), color)
  return b.finish()
}

/** A fragment lens that tints a sampled image: uniform at 0.0, image at 0.1, sampler at 0.2. */
export function texturedLens(opts: { readonly sample?: 'float' | 'depth'; readonly dims?: ImageDims } = {}): LensModule {
  const b = lens('fragment')
  const color = b.input(0, 'f32x4')
  const out = b.output(0, 'f32x4')
  const params = b.uniform(0, 0, { tint: 'f32x4' })
  const tex = b.image(0, 1, { sample: opts.sample ?? 'float', dims: opts.dims ?? '2d' })
  const smp = b.sampler(0, 2)
  const t = (opts.sample ?? 'float') === 'float' ? b.sample(tex, smp, b.pick(color, 'xy'), opts.dims === '2d-array' ? { layer: 0 } : undefined) : b.make('f32x4', b.texel(tex, b.u32x2(0, 0)), 0, 0, 1)
  b.out(out, b.mul(t, b.read(params, 'tint')))
  return b.finish()
}

/** A compute lens doubling the f32 items of a writable storage block at set 0 binding 0. */
export function computeLens(group: readonly [number, number, number] = [64, 1, 1]): LensModule {
  const b = lens('compute', { group })
  const data = b.storage(0, 0, { items: arrayOf('f32') }, { writable: true })
  const i = b.pick(b.builtin('global-id'), 'x')
  b.write(data, ['items', i], b.mul(b.read(data, 'items', i), 2))
  return b.finish()
}
