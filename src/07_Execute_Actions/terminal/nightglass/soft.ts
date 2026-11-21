// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the reference renderer as a back end: softBackend() reports one adapter, and the
 * device it opens keeps every byte on the host and runs every recorded command in TypeScript, in order, at the moment
 * it is submitted. It is the glue between the core's command lists and the reference renderer's parts: memory and
 * resources live here as byte arrays and image stores (texture.ts), shaders run through interp.ts, triangles through
 * raster.ts, and depth, blending and resolve through blend.ts. The tests draw with it, and so does a device whose
 * browser offers no GPU; the GPU back end's pictures are compared against what it draws.
 * What breaks if it is removed? Nightglass would have no back end inside the folder: no test could draw a picture or
 * run a dispatch end to end, and a browser without a GPU could draw nothing.
 *
 * Rules (pinned by soft.test.ts):
 * - THE ADAPTER. One adapter of kind `reference` named `Nightglass reference`, with SOFT_LIMITS (the spec's Limits),
 *   both features, two heaps of `heap` bytes each (heap 0 on the device, heap 1 on the host; default SOFT_HEAP), the
 *   memory kinds device, images (heap 0), upload, readback (heap 1) in that order, and one queue group of one queue
 *   that can draw, dispatch and copy.
 * - MEMORY. Device and images memory is one byte array. Upload and readback memory keeps two: the host's (what map()
 *   hands out) and the device's (what commands read and write). flush() copies a range from the host's to the
 *   device's, invalidate() from the device's to the host's, and nothing else moves bytes between them, so a forgotten
 *   flush or invalidate shows stale bytes. A buffer is a range of its memory's device bytes; an image's ImageStore
 *   reads and writes its memory's device bytes in place, from the offset it is bound at. destroy() of a memory lets
 *   both arrays go.
 * - SUBMIT. Every list runs in order, each command in order, and done() is called before submit returns. A Fault
 *   raised while running (a `bound` past the step budget) stops the submit: the work before it stays in memory, the
 *   rest never runs, done() is not called, and the device is lost from then on (lost() names the Fault), the way a
 *   GPU's watchdog resets a device whose work runs too long.
 * - BINDING STATE starts empty in every list and is cleared at each pass's start and end (the pinned binding-state
 *   rule): pipeline, sets with their dynamic offsets, vertex and index buffers, the blend constant (transparent black)
 *   and the inline constants, one block of LENS_LIMITS.constants bytes that starts zero and that `constants` commands
 *   write into. A pass also starts with the viewport and scissor covering its attachments, depth range 0 to 1.
 * - PASSES. A `clear` load writes the clear value into every texel and sample of the attachment view's level and
 *   layer when the pass begins; `keep` keeps the contents. The spec leaves the contents after an `any` load or store
 *   undefined; this renderer keeps them. Each resolve view takes the average of its four-sample attachment when the
 *   pass ends, whatever the attachment's store op.
 * - DRAWS run instance by instance, and within an instance triangle by triangle in the order raster.ts assembles
 *   them; each triangle is rasterised, shaded and written before the next. Vertices are shaded four draw positions
 *   at a time (positions 4k to 4k + 3). A vertex-rate attribute reads element `firstVertex + i`, or for an indexed
 *   draw `index + baseVertex`, with the index read little-endian from the index buffer; an instance-rate attribute
 *   reads element `firstInstance + instance`. An indexed triangle strip restarts, as WebGPU's always do, at index
 *   0xFFFF (u16 indices) or 0xFFFFFFFF (u32), compared before the base vertex is added: no triangle uses that
 *   position, and the strip begins again at the next one, its triangles counted from 0 there (for their order and
 *   flat vertex). A list, or a strip that is not indexed, has no restart. An attribute whose bytes would lie outside
 *   its buffer (possible for an indexed draw), or whose element is negative, reads zero in every component. The
 *   vertex-index builtin is that element and instance-index is `firstInstance + instance`, both wrapping to u32. A
 *   triangle with a vertex that wrote no position draws nothing.
 * - FRAGMENTS are shaded once per 2 x 2 quad the rasteriser hands out, all four lanes, lanes covering no sample as
 *   helpers; frag-coord is the quad's coord and front-facing its facing. After shading, for each covered sample of
 *   each lane that is not a helper (discarded lanes are): the depth test compares depthOf() of the fragment's depth
 *   with the stored depth by the pipeline's compare, writing the fragment's depth when the pipeline writes depth and
 *   the pass's depth attachment is not read-only; then, for the samples that passed, every colour slot with a
 *   non-zero write mask blends the fragment's output (missing colour components read 0, a missing alpha 1) with the
 *   stored colour by the pipeline's blend and mask and the pass's blend constant (blend.ts). With no depth attachment
 *   every covered sample passes. A pipeline without a fragment lens tests and writes depth only.
 * - INDIRECT draws and dispatches read their numbers from the device bytes of the buffer when they run. Numbers for
 *   which the same direct command would have been refused when recorded are skipped, and the command draws or
 *   dispatches nothing: vertex-rate or instance-rate ranges past the end of a vertex buffer, an index range past the
 *   end of the index buffer, more workgroups along an axis than the device's `groups` limit. An indirect draw whose
 *   first instance is not 0 draws nothing too, as WebGPU's do without its optional indirect-first-instance feature;
 *   a direct draw keeps its first instance.
 * - COMPUTE runs every workgroup and invocation through interp.ts's dispatch() (groups x fastest, then y, then z;
 *   invocations of one workgroup four at a time).
 * - COPIES, updates and zeroes move device bytes; buffer-to-image copies move whole rows of `width` texels, row r of
 *   the region at `offset + r * rowBytes` in the buffer, and bytes between rows are left as they were.
 * - THE STEP BUDGET. One submit may take `steps` steps (default SOFT_STEPS) across all its draws and dispatches: the
 *   steps interp.ts counts for every vertex, fragment and compute invocation; one more for each 2 x 2 quad the
 *   rasteriser's scan visits, covered or not (every quad of each triangle's bounding box within the attachment, the
 *   scissor and the viewport, charged before the scan begins, which covers the depth tests and writes of the quads
 *   it hands out); and one for each restart index an indexed strip passes. So a depth-only draw, a sliver whose box
 *   is large and a strip of restarts are bounded too. Past it the submit stops with a Fault of code `bound` that
 *   names the list and the command.
 */
import type {
  AdapterReport, Backend, BackendDevice, BindingEntry, BindingLayoutInfo, BoundEntry, BufferInfo, ColorOutput, Command, Compare, Feature,
  Handle, ImageInfo, Limits, MemoryKindName, Range, Rect, RenderPipelineInfo, VertexFormat, Viewport, Wrap,
} from './api.ts'
import { FEATURES } from './api.ts'
import { blend, depthOf, passes, resolveInto } from './blend.ts'
import type { BlendState } from './blend.ts'
import { fail, isFault } from './fault.ts'
import { encodeTexel, fromUnorm } from './formats.ts'
import type { Format } from './formats.ts'
import { DEFAULT_BUDGET, LANES, compile, dispatch } from './interp.ts'
import type { Batch, BlockBinding, Bindings, ImageBinding, PortLayout, Program, Resources, RunResult } from './interp.ts'
import { LENS_LIMITS } from './lens.ts'
import type { ImageDims, LensModule, Resource, Stage } from './lens.ts'
import { Raster, assemble } from './raster.ts'
import type { ClipVertex, Quad, RasterState } from './raster.ts'
import { ImageStore } from './texture.ts'
import type { SamplerState, ViewRange } from './texture.ts'
import { say } from './verify.ts'

/** The limits the reference renderer reports, as docs/nightglass.md (Limits) pins them. */
export const SOFT_LIMITS: Limits = Object.freeze({
  imageSize: 8192, imageLayers: 256, sets: 3, bindings: 16, uniformRange: 65536, storageRange: 134217728, offsetAlign: 256,
  stageUniforms: 12, stageStorage: 8, stageImages: 16, stageSamplers: 16, stageStorageImages: 4, dynamicUniforms: 8, dynamicStorage: 4,
  vertexBuffers: 8, vertexAttributes: 16, vertexStride: 2048, interStage: 16, colorAttachments: 8, constants: 128, groupInvocations: 256,
  groupSize: Object.freeze([256, 256, 64] as const), groups: 65535, bufferSize: 268435456, allocationSize: 268435456, allocations: 4096,
  copyRowAlign: 256, updateSize: 65536,
})

/** The bytes of each of the two heaps when softBackend() is given none: 1 GiB. */
export const SOFT_HEAP = 2 ** 30
/** The steps one submit may take when softBackend() is given none: interp.ts's own default budget. */
export const SOFT_STEPS = DEFAULT_BUDGET

/** How softBackend() may be configured. */
export interface SoftOptions {
  /** The back end's name (default `reference`); an instance needs every back end it is given to have its own name. */
  readonly name?: string
  /** Bytes of each heap (default SOFT_HEAP). */
  readonly heap?: number
  /** Steps one submit may take (default SOFT_STEPS). */
  readonly steps?: number
}

const ADAPTER_NAME = 'Nightglass reference'

/** The inline constants a pass or binding state holds: the most any layout may declare. */
const CONSTANT_BYTES = LENS_LIMITS.constants

/** The back end of the reference renderer (see the head of the file). */
export function softBackend(opts?: SoftOptions): Backend {
  const { name, heap, steps } = optionsOf(opts)
  const report: AdapterReport = Object.freeze({
    name: ADAPTER_NAME,
    kind: 'reference',
    limits: SOFT_LIMITS,
    features: FEATURES,
    heaps: Object.freeze([Object.freeze({ index: 0, size: heap, local: true }), Object.freeze({ index: 1, size: heap, local: false })]),
    kinds: Object.freeze([
      Object.freeze({ index: 0, name: 'device', heap: 0, host: false }),
      Object.freeze({ index: 1, name: 'images', heap: 0, host: false }),
      Object.freeze({ index: 2, name: 'upload', heap: 1, host: true }),
      Object.freeze({ index: 3, name: 'readback', heap: 1, host: true }),
    ] as const),
    groups: Object.freeze([Object.freeze({ index: 0, graphics: true, compute: true, copy: true, count: 1 })]),
  })
  const adapters = Object.freeze([report])
  return Object.freeze({
    name,
    adapters: (): readonly AdapterReport[] => adapters,
    open: (adapter: number, _features: readonly Feature[], limits: Limits): BackendDevice => {
      if (adapter !== 0) fail('invalid', `reference renderer: open: it has one adapter, 0, not ${say(adapter)}`)
      if (typeof limits !== 'object' || limits === null || !Number.isSafeInteger(limits.groups)) fail('invalid', 'reference renderer: open: the limits are the device\'s Limits')
      return new SoftDevice(limits, steps)
    },
  })
}

/** Reads softBackend()'s options; anything malformed, or that raises as it is read, is refused with code `invalid`. */
function optionsOf(opts: unknown): { readonly name: string; readonly heap: number; readonly steps: number } {
  const where = 'softBackend'
  try {
    if (opts === undefined) return { name: 'reference', heap: SOFT_HEAP, steps: SOFT_STEPS }
    if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) fail('invalid', `${where}: the options are an object, not ${say(opts)}`)
    for (const k of Object.keys(opts)) if (k !== 'name' && k !== 'heap' && k !== 'steps') fail('invalid', `${where}: the options have no field ${say(k)}`)
    const o = opts as SoftOptions
    const name = o.name ?? 'reference'
    if (typeof name !== 'string' || name === '') fail('invalid', `${where}: the name is a string of at least one character, not ${say(name)}`)
    const heap = o.heap ?? SOFT_HEAP
    if (!Number.isSafeInteger(heap) || heap < 1) fail('invalid', `${where}: the heap size ${say(heap)} is not a whole number of bytes of at least 1`)
    const steps = o.steps ?? SOFT_STEPS
    if (!Number.isSafeInteger(steps) || steps < 0) fail('invalid', `${where}: the step budget ${say(steps)} is not a whole number of at least 0`)
    return { name, heap, steps }
  } catch (e) {
    if (isFault(e)) throw e
    return fail('invalid', `${where}: reading the options raised ${e instanceof Error ? `a ${e.name}` : say(e)}`)
  }
}

// ---------------------------------------------------------------------------------------------------
// The back end's objects

class SoftMemory {
  readonly kind: MemoryKindName
  readonly size: number
  /** What commands read and write. */
  device: Uint8Array
  /** What map() hands the host: a second array for upload and readback memory, none for the device kinds. */
  host: Uint8Array | null

  constructor(kind: MemoryKindName, size: number) {
    this.kind = kind
    this.size = size
    try {
      this.device = new Uint8Array(size)
      this.host = kind === 'upload' || kind === 'readback' ? new Uint8Array(size) : null
    } catch {
      fail('memory', `reference renderer: allocate: the host could not give ${size} bytes of ${kind} memory`)
    }
  }

  /** Lets the bytes go (destroy). The core destroys a memory only after everything bound into it. */
  release(): void {
    this.device = new Uint8Array(0)
    this.host = this.host === null ? null : new Uint8Array(0)
  }
}

class SoftBuffer {
  readonly memory: SoftMemory
  /** Where the buffer starts in its memory, and its bytes. */
  readonly offset: number
  readonly size: number

  constructor(memory: SoftMemory, offset: number, size: number) {
    this.memory = memory
    this.offset = offset
    this.size = size
  }
}

class SoftImage {
  /** The image's texels, read and written in place in its memory's device bytes. */
  readonly store: ImageStore

  constructor(store: ImageStore) {
    this.store = store
  }
}

class SoftView implements ViewRange {
  readonly image: SoftImage
  readonly dims: ImageDims
  readonly levels: Range
  readonly layers: Range

  constructor(image: SoftImage, dims: ImageDims, levels: Range, layers: Range) {
    this.image = image
    this.dims = dims
    this.levels = levels
    this.layers = layers
  }
}

class SoftSampler implements SamplerState {
  readonly mag: SamplerState['mag']
  readonly min: SamplerState['min']
  readonly mip: SamplerState['mip']
  readonly wrap: readonly [Wrap, Wrap, Wrap]
  readonly lodMin: number
  readonly lodMax: number

  constructor(s: SamplerState) {
    this.mag = s.mag
    this.min = s.min
    this.mip = s.mip
    this.wrap = Object.freeze([s.wrap[0], s.wrap[1], s.wrap[2]] as const)
    this.lodMin = s.lodMin
    this.lodMax = s.lodMax
  }
}

class SoftBindingLayout {
  /** Sorted by binding number: the order a bindSets call's dynamic offsets follow. */
  readonly entries: readonly BindingEntry[]

  constructor(entries: readonly BindingEntry[]) {
    this.entries = Object.freeze([...entries].sort((a, b) => a.binding - b.binding))
  }
}

class SoftPipelineLayout {
  readonly constants: { readonly size: number; readonly stages: readonly Stage[] } | null

  constructor(constants: { readonly size: number; readonly stages: readonly Stage[] } | null) {
    this.constants = constants
  }
}

/** What one binding of a set holds, as handles of this back end. */
type Held =
  | { readonly buffer: SoftBuffer; readonly offset: number; readonly size: number }
  | { readonly view: SoftView }
  | { readonly sampler: SoftSampler }

class SoftSet {
  readonly layout: SoftBindingLayout
  /** By binding number; filled once the core has every binding (writeBindingSet). */
  held: ReadonlyMap<number, Held> = new Map()

  constructor(layout: SoftBindingLayout) {
    this.layout = layout
  }
}

class SoftLens {
  readonly module: LensModule
  readonly program: Program

  constructor(module: LensModule) {
    this.module = module
    this.program = compile(module)
  }
}

/** How each vertex format is read: components, bytes per component, and the reader of one component. */
interface VertexRead {
  readonly count: number
  readonly size: number
  readonly get: (data: DataView, at: number) => number
}

const f32At = (d: DataView, at: number): number => d.getFloat32(at, true)
const u32At = (d: DataView, at: number): number => d.getUint32(at, true)
const i32At = (d: DataView, at: number): number => d.getInt32(at, true)
const unormAt = (d: DataView, at: number): number => fromUnorm(d.getUint8(at), 8)
const reads = (count: number, size: number, get: VertexRead['get']): VertexRead => Object.freeze({ count, size, get })

const VERTEX_READS: { readonly [K in VertexFormat]: VertexRead } = Object.freeze({
  f32: reads(1, 4, f32At), f32x2: reads(2, 4, f32At), f32x3: reads(3, 4, f32At), f32x4: reads(4, 4, f32At),
  u32: reads(1, 4, u32At), u32x2: reads(2, 4, u32At), u32x3: reads(3, 4, u32At), u32x4: reads(4, 4, u32At),
  i32: reads(1, 4, i32At), i32x2: reads(2, 4, i32At), i32x3: reads(3, 4, i32At), i32x4: reads(4, 4, i32At),
  unorm8x4: reads(4, 1, unormAt),
})

/** One vertex input port and the attribute that feeds it. */
interface Input {
  /** The vertex buffer slot, the attribute's offset within an element, and how it is read. */
  readonly buffer: number
  readonly offset: number
  readonly read: VertexRead
  /** Where the port's numbers sit among a lane's inputs. */
  readonly to: number
}

/** One colour slot a pipeline writes: what it writes and the fragment output it writes from. */
interface ColorSlot {
  readonly slot: number
  readonly format: Format
  readonly blend: BlendState | null
  readonly mask: number
  readonly port: PortLayout
}

class SoftRender {
  readonly info: RenderPipelineInfo
  readonly layout: SoftPipelineLayout
  readonly vertex: SoftLens
  readonly fragment: SoftLens | null
  readonly inputs: readonly Input[]
  /** Per vertex buffer slot: its stride and rate, and the end of its last attribute byte within an element. */
  readonly buffers: readonly { readonly stride: number; readonly instance: boolean; readonly reach: number }[]
  /** Numbers each vertex hands the rasteriser: all of the vertex lens's outputs when a fragment lens reads them. */
  readonly varyings: number
  readonly flat: readonly boolean[]
  /** Each fragment input and the vertex output it takes its numbers from. */
  readonly feed: readonly { readonly from: number; readonly to: number; readonly n: number }[]
  readonly colors: readonly ColorSlot[]
  readonly depth: { readonly format: Format; readonly compare: Compare; readonly write: boolean; readonly unclipped: boolean } | null

  constructor(info: RenderPipelineInfo, layout: SoftPipelineLayout, vertex: SoftLens, fragment: SoftLens | null) {
    this.info = info
    this.layout = layout
    this.vertex = vertex
    this.fragment = fragment
    const layouts = info.vertex.buffers ?? []
    this.buffers = layouts.map((b) => ({
      stride: b.stride,
      instance: b.rate === 'instance',
      reach: b.attributes.reduce((m, a) => Math.max(m, a.offset + VERTEX_READS[a.format].count * VERTEX_READS[a.format].size), 0),
    }))
    this.inputs = vertex.program.inputs.map((p): Input => {
      for (let b = 0; b < layouts.length; b++) {
        const a = layouts[b].attributes.find((x) => x.slot === p.slot)
        if (a !== undefined) return { buffer: b, offset: a.offset, read: VERTEX_READS[a.format], to: p.offset }
      }
      return fail('invalid', `reference renderer: createRenderPipeline: no attribute feeds input slot ${p.slot} of the vertex lens`)
    })
    const outs = vertex.program.outputs
    this.varyings = fragment === null ? 0 : vertex.program.outputWidth
    this.flat = fragment === null ? [] : outs.flatMap((p) => Array.from({ length: p.size }, () => p.flat))
    this.feed = fragment === null ? [] : fragment.program.inputs.map((p) => {
      const q = outs.find((o) => o.slot === p.slot)
      if (q === undefined) fail('invalid', `reference renderer: createRenderPipeline: the vertex lens writes no output at slot ${p.slot}, which the fragment lens reads`)
      return { from: q.offset, to: p.offset, n: p.size }
    })
    const outputs: readonly (ColorOutput | null)[] = info.fragment?.outputs ?? []
    this.colors = outputs.flatMap((o, slot): ColorSlot[] => {
      const port = fragment?.program.outputs.find((p) => p.slot === slot)
      const mask = o?.mask ?? 15
      if (o === null || port === undefined || mask === 0) return []
      return [{ slot, format: o.format, blend: o.blend ?? null, mask, port }]
    })
    const d = info.depth
    this.depth = d === undefined ? null : { format: d.format, compare: d.compare ?? 'always', write: d.write === true, unclipped: d.unclipped === true }
  }
}

class SoftCompute {
  readonly layout: SoftPipelineLayout
  readonly lens: SoftLens

  constructor(layout: SoftPipelineLayout, lens: SoftLens) {
    this.layout = layout
    this.lens = lens
  }
}

/** A handle of one of this back end's classes; anything else is refused. */
function the<T>(x: Handle, cls: abstract new (...args: never[]) => T, what: string, where: string): T {
  if (!(x instanceof cls)) fail('invalid', `${where}: ${what} is not one the reference renderer made, but ${say(x)}`)
  return x
}

// ---------------------------------------------------------------------------------------------------
// The device

class SoftDevice implements BackendDevice {
  private readonly limits: Limits
  private readonly steps: number
  /** Why the device is lost: set when a submit stops part way. */
  private gone: string | null = null

  constructor(limits: Limits, steps: number) {
    this.limits = limits
    this.steps = steps
  }

  allocate(kind: MemoryKindName, size: number): Handle {
    if (kind !== 'device' && kind !== 'images' && kind !== 'upload' && kind !== 'readback') fail('invalid', `reference renderer: allocate: ${say(kind)} is not a memory kind`)
    if (!Number.isSafeInteger(size) || size < 1) fail('invalid', `reference renderer: allocate: ${say(size)} is not a whole number of bytes of at least 1`)
    return new SoftMemory(kind, size)
  }

  hostBytes(memory: Handle): Uint8Array {
    const m = the(memory, SoftMemory, 'the memory', 'reference renderer: hostBytes')
    if (m.host === null) fail('memory', `reference renderer: hostBytes: ${m.kind} memory is not seen by the host`)
    return m.host
  }

  flush(memory: Handle, offset: number, size: number): void {
    const m = this.hostRange(memory, offset, size, 'flush')
    m.device.set((m.host as Uint8Array).subarray(offset, offset + size), offset)
  }

  invalidate(memory: Handle, offset: number, size: number): void {
    const m = this.hostRange(memory, offset, size, 'invalidate')
    ;(m.host as Uint8Array).set(m.device.subarray(offset, offset + size), offset)
  }

  /** Host-visible memory and a range of it that lies inside it. */
  private hostRange(memory: Handle, offset: number, size: number, call: string): SoftMemory {
    const where = `reference renderer: ${call}`
    const m = the(memory, SoftMemory, 'the memory', where)
    if (m.host === null) fail('memory', `${where}: ${m.kind} memory is not seen by the host`)
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > m.device.length) {
      fail('invalid', `${where}: bytes ${say(offset)} to ${say(offset + size)} are not inside the ${m.device.length} bytes of the memory`)
    }
    return m
  }

  createBuffer(info: BufferInfo, memory: Handle, offset: number): Handle {
    const m = the(memory, SoftMemory, 'the memory', 'reference renderer: createBuffer')
    return new SoftBuffer(m, offset, info.size)
  }

  createImage(info: Required<ImageInfo>, memory: Handle, offset: number): Handle {
    const m = the(memory, SoftMemory, 'the memory', 'reference renderer: createImage')
    const desc = { format: info.format, width: info.width, height: info.height, layers: info.layers, levels: info.levels, samples: info.samples }
    return new SoftImage(new ImageStore(desc, m.device.subarray(offset)))
  }

  createView(image: Handle, dims: ImageDims, levels: Range, layers: Range): Handle {
    const img = the(image, SoftImage, 'the image', 'reference renderer: createView')
    return new SoftView(img, dims, Object.freeze({ base: levels.base, count: levels.count }), Object.freeze({ base: layers.base, count: layers.count }))
  }

  createSampler(info: SamplerState): Handle {
    return new SoftSampler(info)
  }

  createBindingLayout(info: BindingLayoutInfo): Handle {
    return new SoftBindingLayout(info.entries)
  }

  createPipelineLayout(_sets: readonly Handle[], constants: { readonly size: number; readonly stages: readonly Stage[] } | null): Handle {
    return new SoftPipelineLayout(constants)
  }

  createBindingSet(layout: Handle): Handle {
    return new SoftSet(the(layout, SoftBindingLayout, 'the binding layout', 'reference renderer: createBindingSet'))
  }

  writeBindingSet(set: Handle, entries: readonly BoundEntry[]): void {
    const where = 'reference renderer: writeBindingSet'
    const s = the(set, SoftSet, 'the set', where)
    const held = new Map<number, Held>()
    for (const e of entries) {
      if ('buffer' in e) held.set(e.binding, { buffer: the(e.buffer, SoftBuffer, 'a buffer', where), offset: e.offset, size: e.size })
      else if ('view' in e) held.set(e.binding, { view: the(e.view, SoftView, 'a view', where) })
      else held.set(e.binding, { sampler: the(e.sampler, SoftSampler, 'a sampler', where) })
    }
    s.held = held
  }

  createLens(module: LensModule): Handle {
    return new SoftLens(module)
  }

  createRenderPipeline(info: RenderPipelineInfo, layout: Handle, vertex: Handle, fragment: Handle | null): Handle {
    const where = 'reference renderer: createRenderPipeline'
    const l = the(layout, SoftPipelineLayout, 'the layout', where)
    const v = the(vertex, SoftLens, 'the vertex lens', where)
    return new SoftRender(info, l, v, fragment === null ? null : the(fragment, SoftLens, 'the fragment lens', where))
  }

  createComputePipeline(layout: Handle, lens: Handle): Handle {
    const where = 'reference renderer: createComputePipeline'
    return new SoftCompute(the(layout, SoftPipelineLayout, 'the layout', where), the(lens, SoftLens, 'the lens', where))
  }

  submit(lists: readonly (readonly Command[])[], done: () => void): void {
    const runner = new Runner(this.limits, this.steps)
    try {
      lists.forEach((list, i) => runner.list(list, i))
    } catch (e) {
      // Part of the work may have run, so nothing about memory can be trusted: the device is lost from here on.
      this.gone = `a submit stopped part way: ${e instanceof Error ? e.message : say(e)}`
      throw e
    }
    done()
  }

  destroy(handle: Handle): void {
    if (handle instanceof SoftMemory) handle.release()
  }

  lost(): string | null {
    return this.gone
  }
}

// ---------------------------------------------------------------------------------------------------
// Running commands

/** One level of one layer of an image, as a pass draws into it or resolves into it. */
interface Attachment {
  readonly store: ImageStore
  readonly level: number
  readonly layer: number
}

interface PassRun {
  readonly width: number
  readonly height: number
  readonly colors: readonly ({ readonly att: Attachment; readonly resolve: Attachment | null } | null)[]
  readonly depth: { readonly att: Attachment; readonly readOnly: boolean } | null
}

/** A draw's numbers, direct or read from an indirect buffer. */
interface DrawNumbers {
  /** Vertices, or indices for an indexed draw. */
  readonly count: number
  readonly instances: number
  /** The first vertex, or the first index for an indexed draw. */
  readonly first: number
  readonly baseVertex: number
  readonly firstInstance: number
  readonly indexed: boolean
}

type DrawCommand = Extract<Command, { readonly c: 'draw' | 'draw-indexed' | 'draw-indirect' }>

/** The attachment a view names: the store, and the level and layer its range starts at. */
function attachmentOf(view: Handle, where: string): Attachment {
  const v = the(view, SoftView, 'the attachment view', where)
  return { store: v.image.store, level: v.levels.base, layer: v.layers.base }
}

/** Writes one value into every texel and sample of an attachment. */
function fillLayer(att: Attachment, value: ArrayLike<number>): void {
  const st = att.store
  const texel = st.texelBytes
  const start = st.offset(att.level, att.layer, 0, 0, 0)
  const size = st.levelWidth(att.level) * st.levelHeight(att.level) * st.samples * texel
  encodeTexel(st.format, value, st.bytes, start)
  for (let done = texel; done < size; done *= 2) st.bytes.copyWithin(start + done, start, start + Math.min(done, size - done))
}

/** Runs the lists of one submit, holding the binding state and the step budget they share. */
class Runner {
  private readonly limits: Limits
  private readonly total: number
  /** Steps left. */
  private left: number
  /** Names the command being run, for refusals. */
  private where = ''
  private pass: PassRun | null = null
  private pipeline: SoftRender | SoftCompute | null = null
  private sets: ({ readonly set: SoftSet; readonly dynamic: ReadonlyMap<number, number> } | undefined)[] = []
  private vertices: ({ readonly buffer: SoftBuffer; readonly offset: number } | undefined)[] = []
  private indices: { readonly buffer: SoftBuffer; readonly offset: number; readonly type: 'u16' | 'u32' } | null = null
  private viewport: Required<Viewport> = { x: 0, y: 0, width: 0, height: 0, near: 0, far: 1 }
  private scissor: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private blendConstant: readonly [number, number, number, number] = [0, 0, 0, 0]
  private readonly constants = new Uint8Array(CONSTANT_BYTES)

  constructor(limits: Limits, steps: number) {
    this.limits = limits
    this.total = steps
    this.left = steps
  }

  /** Runs one list from an empty binding state. */
  list(commands: readonly Command[], index: number): void {
    this.pass = null
    this.clearState()
    commands.forEach((cmd, i) => {
      this.where = `reference renderer: list ${index} command ${i} (${cmd.c})`
      try {
        this.command(cmd)
      } catch (e) {
        if (isFault(e, 'bound')) fail('bound', `${this.where}: the work ran past this submit's budget of ${this.total} steps (a step is one instruction or loop iteration of one invocation, one 2 x 2 quad the rasteriser scans, or one strip restart)`)
        if (isFault(e)) throw e
        fail('device', `${this.where}: the reference renderer raised ${e instanceof Error ? `${e.name}: ${e.message}` : say(e)}`)
      }
    })
  }

  /** Takes steps from the budget, stopping the work when there are not enough. */
  charge(steps: number): void {
    if (steps > this.left) fail('bound', `${this.where}: past the budget`)
    this.left -= steps
  }

  /** Runs one batch of a program on what is left of the budget, and takes the steps it used. */
  run(program: Program, batch: Batch, bindings: Bindings): RunResult {
    const result = program.run(batch, bindings, this.left)
    this.left -= result.steps
    return result
  }

  private command(cmd: Command): void {
    const where = this.where
    switch (cmd.c) {
      case 'pass': this.beginPass(cmd); break
      case 'end-pass': this.endPass(); break
      case 'pipeline': this.pipeline = cmd.compute ? the(cmd.pipeline, SoftCompute, 'the pipeline', where) : the(cmd.pipeline, SoftRender, 'the pipeline', where); break
      case 'sets': this.bindSets(cmd); break
      case 'vertices':
        cmd.buffers.forEach((b, i) => {
          this.vertices[cmd.first + i] = { buffer: the(b.buffer, SoftBuffer, 'a vertex buffer', where), offset: b.offset }
        })
        break
      case 'indices': this.indices = { buffer: the(cmd.buffer, SoftBuffer, 'the index buffer', where), offset: cmd.offset, type: cmd.type }; break
      case 'viewport': this.viewport = { x: cmd.x, y: cmd.y, width: cmd.width, height: cmd.height, near: cmd.near, far: cmd.far }; break
      case 'scissor': this.scissor = { x: cmd.x, y: cmd.y, width: cmd.width, height: cmd.height }; break
      case 'blend-constant': this.blendConstant = cmd.rgba; break
      case 'constants':
        if (cmd.offset + cmd.bytes.length > CONSTANT_BYTES) fail('invalid', `${where}: bytes ${cmd.offset} to ${cmd.offset + cmd.bytes.length - 1} run past the ${CONSTANT_BYTES} bytes of inline constants`)
        this.constants.set(cmd.bytes, cmd.offset)
        break
      case 'draw': case 'draw-indexed': case 'draw-indirect': this.drawCommand(cmd); break
      case 'dispatch': this.dispatch(cmd.x, cmd.y, cmd.z); break
      case 'dispatch-indirect': {
        const [x, y, z] = this.words(cmd.buffer, cmd.offset, 3)
        if (x <= this.limits.groups && y <= this.limits.groups && z <= this.limits.groups) this.dispatch(x, y, z)
        break
      }
      case 'copy-buffer': {
        const src = the(cmd.src, SoftBuffer, 'the source', where)
        const dst = the(cmd.dst, SoftBuffer, 'the destination', where)
        for (const r of cmd.regions) dst.memory.device.set(src.memory.device.subarray(src.offset + r.from, src.offset + r.from + r.size), dst.offset + r.to)
        break
      }
      case 'copy-buffer-image': {
        const src = the(cmd.src, SoftBuffer, 'the source', where)
        const img = the(cmd.dst, SoftImage, 'the destination', where).store
        for (const r of cmd.regions) {
          const g = r.region
          const row = g.width * img.texelBytes
          for (let y = 0; y < g.height; y++) {
            const from = src.offset + r.offset + y * r.rowBytes
            img.bytes.set(src.memory.device.subarray(from, from + row), img.offset(g.level ?? 0, g.layer ?? 0, g.x ?? 0, (g.y ?? 0) + y))
          }
        }
        break
      }
      case 'copy-image-buffer': {
        const img = the(cmd.src, SoftImage, 'the source', where).store
        const dst = the(cmd.dst, SoftBuffer, 'the destination', where)
        for (const r of cmd.regions) {
          const g = r.region
          const row = g.width * img.texelBytes
          for (let y = 0; y < g.height; y++) {
            const from = img.offset(g.level ?? 0, g.layer ?? 0, g.x ?? 0, (g.y ?? 0) + y)
            dst.memory.device.set(img.bytes.subarray(from, from + row), dst.offset + r.offset + y * r.rowBytes)
          }
        }
        break
      }
      case 'copy-image': {
        const src = the(cmd.src, SoftImage, 'the source', where).store
        const dst = the(cmd.dst, SoftImage, 'the destination', where).store
        for (const r of cmd.regions) {
          const f = r.from
          const t = r.to
          const row = f.width * src.texelBytes
          for (let y = 0; y < f.height; y++) {
            const from = src.offset(f.level ?? 0, f.layer ?? 0, f.x ?? 0, (f.y ?? 0) + y)
            dst.bytes.set(src.bytes.subarray(from, from + row), dst.offset(t.level ?? 0, t.layer ?? 0, t.x ?? 0, (t.y ?? 0) + y))
          }
        }
        break
      }
      case 'update': {
        const dst = the(cmd.dst, SoftBuffer, 'the destination', where)
        dst.memory.device.set(cmd.bytes, dst.offset + cmd.offset)
        break
      }
      case 'zero': {
        const dst = the(cmd.dst, SoftBuffer, 'the destination', where)
        dst.memory.device.fill(0, dst.offset + cmd.offset, dst.offset + cmd.offset + cmd.size)
        break
      }
      case 'barrier': case 'group': case 'end-group': break
    }
  }

  /** The binding state a list, a pass's start and a pass's end begin with. */
  private clearState(): void {
    this.pipeline = null
    this.sets = []
    this.vertices = []
    this.indices = null
    this.blendConstant = [0, 0, 0, 0]
    this.constants.fill(0)
    const w = this.pass === null ? 0 : this.pass.width
    const h = this.pass === null ? 0 : this.pass.height
    this.viewport = { x: 0, y: 0, width: w, height: h, near: 0, far: 1 }
    this.scissor = { x: 0, y: 0, width: w, height: h }
  }

  private beginPass(cmd: Extract<Command, { readonly c: 'pass' }>): void {
    const colors = cmd.colors.map((c) => {
      if (c === null) return null
      const att = attachmentOf(c.view, this.where)
      if (c.load === 'clear') fillLayer(att, c.clear)
      return { att, resolve: c.resolve === null ? null : attachmentOf(c.resolve, this.where) }
    })
    let depth: PassRun['depth'] = null
    if (cmd.depth !== null) {
      const att = attachmentOf(cmd.depth.view, this.where)
      if (cmd.depth.load === 'clear') fillLayer(att, [cmd.depth.clear, 0, 0, 0])
      depth = { att, readOnly: cmd.depth.readOnly }
    }
    this.pass = { width: cmd.width, height: cmd.height, colors, depth }
    this.clearState()
  }

  private endPass(): void {
    const pass = this.pass
    if (pass !== null) for (const c of pass.colors) if (c !== null && c.resolve !== null) resolveInto(c.att.store, c.resolve.store, c.resolve.level, c.resolve.layer)
    this.pass = null
    this.clearState()
  }

  private bindSets(cmd: Extract<Command, { readonly c: 'sets' }>): void {
    let k = 0
    cmd.sets.forEach((h, i) => {
      const set = the(h, SoftSet, 'a binding set', this.where)
      const dynamic = new Map<number, number>()
      for (const e of set.layout.entries) {
        if (e.dynamic !== true) continue
        dynamic.set(e.binding, cmd.offsets[k] ?? 0)
        k++
      }
      this.sets[cmd.first + i] = { set, dynamic }
    })
  }

  /** What a module's resources are bound to now, as interp.ts asks for them. */
  private resources(layout: SoftPipelineLayout, module: LensModule): Resources {
    const held = (r: Resource | undefined): { readonly held: Held; readonly extra: number } | null => {
      if (r === undefined || r.kind === 'constants') return null
      const s = this.sets[r.set]
      const h = s?.set.held.get(r.binding)
      return s === undefined || h === undefined ? null : { held: h, extra: s.dynamic.get(r.binding) ?? 0 }
    }
    return {
      block: (res: number): BlockBinding | null => {
        const r = module.resources[res]
        if (r?.kind === 'constants') return { bytes: this.constants, offset: 0, size: layout.constants === null ? 0 : layout.constants.size }
        const b = held(r)
        if (b === null || !('buffer' in b.held)) return null
        const { buffer, offset, size } = b.held
        return { bytes: buffer.memory.device, offset: buffer.offset + offset + b.extra, size }
      },
      image: (res: number): ImageBinding | null => imageOf(held(module.resources[res])),
      storageImage: (res: number): ImageBinding | null => imageOf(held(module.resources[res])),
      sampler: (res: number): SamplerState | null => {
        const b = held(module.resources[res])
        return b !== null && 'sampler' in b.held ? b.held.sampler : null
      },
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Draws

  private drawCommand(cmd: DrawCommand): void {
    const p = the(this.pipeline, SoftRender, 'the bound pipeline', this.where)
    if (cmd.c === 'draw') {
      this.draw(p, { count: cmd.vertices, instances: cmd.instances, first: cmd.firstVertex, baseVertex: 0, firstInstance: cmd.firstInstance, indexed: false })
    } else if (cmd.c === 'draw-indexed') {
      this.draw(p, { count: cmd.indices, instances: cmd.instances, first: cmd.firstIndex, baseVertex: cmd.baseVertex, firstInstance: cmd.firstInstance, indexed: true })
    } else if (cmd.indexed) {
      const [count, instances, first, base, firstInstance] = this.words(cmd.buffer, cmd.offset, 5)
      const n = { count, instances, first, baseVertex: base | 0, firstInstance, indexed: true }
      if (firstInstance === 0 && this.indicesFit(n) && this.verticesFit(p, null, [firstInstance, instances])) this.draw(p, n)
    } else {
      const [count, instances, first, firstInstance] = this.words(cmd.buffer, cmd.offset, 4)
      if (firstInstance === 0 && this.verticesFit(p, [first, count], [firstInstance, instances])) this.draw(p, { count, instances, first, baseVertex: 0, firstInstance, indexed: false })
    }
  }

  /** Little-endian u32 words of a buffer's device bytes, from an offset in the buffer. */
  private words(buffer: Handle, offset: number, n: number): number[] {
    const b = the(buffer, SoftBuffer, 'the indirect buffer', this.where)
    const bytes = b.memory.device
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return Array.from({ length: n }, (_, i) => data.getUint32(b.offset + offset + 4 * i, true))
  }

  /** What recording checks of a direct draw: each vertex buffer holds the elements its rate reads (vertex range null: not known). */
  private verticesFit(p: SoftRender, vertex: readonly [number, number] | null, instance: readonly [number, number]): boolean {
    return p.buffers.every((layout, i) => {
      const range = layout.instance ? instance : vertex
      if (range === null || range[1] === 0 || layout.reach === 0) return true
      const need = layout.stride === 0 ? layout.reach : (range[0] + range[1] - 1) * layout.stride + layout.reach
      const vb = this.vertices[i]
      return vb !== undefined && vb.offset + need <= vb.buffer.size
    })
  }

  /** What recording checks of a direct indexed draw: the index buffer holds the indices it reads. */
  private indicesFit(n: DrawNumbers): boolean {
    const ib = this.indices
    if (ib === null) return false
    return n.count === 0 || ib.offset + (n.first + n.count) * (ib.type === 'u16' ? 2 : 4) <= ib.buffer.size
  }

  private draw(p: SoftRender, n: DrawNumbers): void {
    const pass = this.pass
    if (pass === null) fail('state', `${this.where}: a draw runs inside a pass`)
    const topology = p.info.topology ?? 'triangles'
    if (n.instances === 0 || assemble(topology, n.count).next().done === true) return
    const state: RasterState = {
      width: pass.width,
      height: pass.height,
      viewport: this.viewport,
      scissor: this.scissor,
      cull: p.info.cull ?? 'none',
      front: p.info.front ?? 'ccw',
      samples: p.info.samples ?? 1,
      unclipped: p.depth !== null && p.depth.unclipped,
    }
    const raster = new Raster(state, p.varyings, p.flat, (quads) => this.charge(quads))
    const vertices = new VertexStage(this, p, n, p.vertex.program.bind(this.resources(p.layout, p.vertex.module)))
    const pixels = new PixelStage(this, p, pass, p.fragment === null ? null : p.fragment.program.bind(this.resources(p.layout, p.fragment.module)), this.blendConstant)
    const restart = n.indexed && topology === 'triangle-strip' ? (i: number): boolean => this.restarts(n, i) : null
    for (let instance = 0; instance < n.instances; instance++) {
      vertices.begin(instance)
      for (const t of assemble(topology, n.count, restart)) {
        const a = vertices.vertex(t.a)
        const b = vertices.vertex(t.b)
        const c = vertices.vertex(t.c)
        if (!a.positioned || !b.positioned || !c.positioned) continue
        raster.triangle(a, b, c, vertices.vertex(t.provoking), pixels.emit)
      }
    }
  }

  private dispatch(x: number, y: number, z: number): void {
    const p = the(this.pipeline, SoftCompute, 'the bound pipeline', this.where)
    const program = p.lens.program
    const used = dispatch(program, program.bind(this.resources(p.layout, p.lens.module)), [x, y, z], this.left)
    this.left -= used
  }

  /** The element an indexed draw's vertex-rate attributes read at draw position i: its index plus the base vertex. */
  indexed(n: DrawNumbers, i: number): number {
    return this.index(n, i) + n.baseVertex
  }

  /** Whether draw position i of an indexed strip is its restart index (all ones in the index type); each costs a step. */
  private restarts(n: DrawNumbers, i: number): boolean {
    if (this.index(n, i) !== (this.indices?.type === 'u16' ? 0xffff : 0xffffffff)) return false
    this.charge(1)
    return true
  }

  /** The index at draw position i of an indexed draw, as the index buffer holds it. */
  private index(n: DrawNumbers, i: number): number {
    const ib = this.indices
    if (ib === null) fail('state', `${this.where}: an indexed draw needs an index buffer bound`)
    const bytes = ib.buffer.memory.device
    const size = ib.type === 'u16' ? 2 : 4
    const at = ib.buffer.offset + ib.offset + (n.first + i) * size
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return size === 2 ? data.getUint16(at, true) : data.getUint32(at, true)
  }

  /** A bound vertex buffer, or undefined. */
  vertexBuffer(slot: number): { readonly buffer: SoftBuffer; readonly offset: number } | undefined {
    return this.vertices[slot]
  }
}

/** What a sampled or storage image binding holds, as interp.ts takes it. */
function imageOf(b: { readonly held: Held } | null): ImageBinding | null {
  return b !== null && 'view' in b.held ? { store: b.held.view.image.store, view: b.held.view } : null
}

/** One vertex as the vertex stage left it. */
interface Shaded extends ClipVertex {
  readonly pos: Float64Array
  readonly vary: Float64Array
  positioned: boolean
}

/** Where one input reads from in this draw: its buffer's bytes, element 0's attribute, and the buffer's end. */
interface Feed {
  readonly input: Input
  readonly data: DataView
  readonly base: number
  readonly end: number
  readonly stride: number
  readonly instance: boolean
}

/**
 * The vertex stage of one draw: it reads attributes, shades draw positions four at a time, and keeps the last two
 * batches it shaded. A triangle's vertices lie within three consecutive positions and triangles come in order, so two
 * batches always hold every vertex a triangle needs and nothing is shaded twice within an instance.
 */
class VertexStage {
  private readonly runner: Runner
  private readonly program: Program
  private readonly bindings: Bindings
  private readonly n: DrawNumbers
  private readonly varyings: number
  private readonly feeds: readonly Feed[]
  private readonly batches: { k: number; readonly v: readonly Shaded[] }[]
  private readonly inputs: Float64Array
  private readonly vertexIndex = new Float64Array(LANES)
  private readonly instanceIndex = new Float64Array(LANES)
  private readonly batch: { lanes: number; readonly inputs: Float64Array; readonly builtins: { readonly 'vertex-index': Float64Array; readonly 'instance-index': Float64Array } }
  private instance = 0

  constructor(runner: Runner, p: SoftRender, n: DrawNumbers, bindings: Bindings) {
    this.runner = runner
    this.program = p.vertex.program
    this.bindings = bindings
    this.n = n
    this.varyings = p.varyings
    this.feeds = p.inputs.map((input): Feed => {
      const layout = p.buffers[input.buffer]
      const vb = runner.vertexBuffer(input.buffer)
      if (vb === undefined) fail('state', `reference renderer: draw: no vertex buffer is bound at slot ${input.buffer}`)
      const bytes = vb.buffer.memory.device
      return {
        input,
        data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        base: vb.buffer.offset + vb.offset + input.offset,
        end: vb.buffer.offset + vb.buffer.size,
        stride: layout.stride,
        instance: layout.instance,
      }
    })
    const shaded = (): Shaded => ({ pos: new Float64Array(4), vary: new Float64Array(p.varyings), positioned: false })
    this.batches = [0, 1].map(() => ({ k: -1, v: Array.from({ length: LANES }, shaded) }))
    this.inputs = new Float64Array(LANES * this.program.inputWidth)
    this.batch = { lanes: LANES, inputs: this.inputs, builtins: { 'vertex-index': this.vertexIndex, 'instance-index': this.instanceIndex } }
  }

  /** Starts an instance: nothing shaded yet. */
  begin(instance: number): void {
    this.instance = instance
    for (const b of this.batches) b.k = -1
  }

  /** The vertex at draw position i, shading its batch when it is not one of the two kept. */
  vertex(i: number): Shaded {
    const k = Math.floor(i / LANES)
    const [b0, b1] = this.batches
    let batch = b0.k === k ? b0 : b1.k === k ? b1 : null
    if (batch === null) {
      batch = b0.k < b1.k ? b0 : b1
      this.shade(batch, k)
    }
    return batch.v[i - k * LANES]
  }

  private shade(batch: { k: number; readonly v: readonly Shaded[] }, k: number): void {
    const first = k * LANES
    const lanes = Math.min(LANES, this.n.count - first)
    const instance = this.n.firstInstance + this.instance
    const width = this.program.inputWidth
    for (let l = 0; l < lanes; l++) {
      const element = this.n.indexed ? this.runner.indexed(this.n, first + l) : this.n.first + first + l
      this.vertexIndex[l] = element
      this.instanceIndex[l] = instance
      for (const f of this.feeds) this.attribute(f, f.instance ? instance : element, l * width + f.input.to)
    }
    this.batch.lanes = lanes
    const result = this.runner.run(this.program, this.batch, this.bindings)
    const ow = this.program.outputWidth
    for (let l = 0; l < lanes; l++) {
      const v = batch.v[l]
      v.positioned = ((result.positioned >> l) & 1) === 1
      for (let c = 0; c < 4; c++) v.pos[c] = result.position[l * 4 + c]
      for (let c = 0; c < this.varyings; c++) v.vary[c] = result.outputs[l * ow + c]
    }
    batch.k = k
  }

  /** Reads one attribute of an element into the inputs at `to`; bytes outside the buffer read zero. */
  private attribute(f: Feed, element: number, to: number): void {
    const r = f.input.read
    const at = f.base + element * f.stride
    const inside = element >= 0 && at + r.count * r.size <= f.end
    for (let c = 0; c < r.count; c++) this.inputs[to + c] = inside ? r.get(f.data, at + c * r.size) : 0
  }
}

/**
 * The fragment stage and the output merger of one draw: `emit` takes each quad the rasteriser hands out, shades it,
 * tests depth sample by sample and writes the samples that pass.
 */
class PixelStage {
  private readonly runner: Runner
  private readonly p: SoftRender
  private readonly pass: PassRun
  private readonly bindings: Bindings | null
  private readonly constant: readonly [number, number, number, number]
  private readonly samples: number
  private readonly writesDepth: boolean
  private readonly inputs: Float64Array
  private readonly front = new Float64Array(LANES)
  private readonly batch: { lanes: number; helpers: number; readonly inputs: Float64Array; readonly builtins: { 'frag-coord': ArrayLike<number>; readonly 'front-facing': Float64Array } }
  private readonly texel = [0, 0, 0, 0]
  private readonly src = [0, 0, 0, 0]
  private readonly out = [0, 0, 0, 0]

  constructor(runner: Runner, p: SoftRender, pass: PassRun, bindings: Bindings | null, constant: readonly [number, number, number, number]) {
    this.runner = runner
    this.p = p
    this.pass = pass
    this.bindings = bindings
    this.constant = constant
    this.samples = p.info.samples ?? 1
    this.writesDepth = p.depth !== null && p.depth.write && pass.depth !== null && !pass.depth.readOnly
    this.inputs = new Float64Array(LANES * (p.fragment === null ? 0 : p.fragment.program.inputWidth))
    this.batch = { lanes: LANES, helpers: 0, inputs: this.inputs, builtins: { 'frag-coord': new Float64Array(4 * LANES), 'front-facing': this.front } }
  }

  /** Takes one quad; its step was charged when the rasteriser's scan of it began. */
  readonly emit = (quad: Quad): void => {
    const result = this.shade(quad)
    const dropped = result === null ? 0 : result.helpers
    for (let l = 0; l < LANES; l++) {
      const covered = quad.mask[l]
      if (covered === 0 || ((dropped >> l) & 1) === 1) continue
      const x = quad.x + (l & 1)
      const y = quad.y + (l >> 1)
      const passed = this.depth(quad, l, x, y, covered)
      if (passed !== 0 && result !== null) this.color(result, l, x, y, passed)
    }
  }

  /** Runs the fragment lens on a quad; null for a pipeline without one. */
  private shade(quad: Quad): RunResult | null {
    const f = this.p.fragment
    if (f === null || this.bindings === null) return null
    const fw = f.program.inputWidth
    const vw = this.p.varyings
    let helpers = 0
    for (let l = 0; l < LANES; l++) {
      if (quad.mask[l] === 0) helpers |= 1 << l
      for (const m of this.p.feed) for (let c = 0; c < m.n; c++) this.inputs[l * fw + m.to + c] = quad.vary[l * vw + m.from + c]
    }
    this.front.fill(quad.front ? 1 : 0)
    this.batch.helpers = helpers
    this.batch.builtins['frag-coord'] = quad.coord
    return this.runner.run(f.program, this.batch, this.bindings)
  }

  /** The depth test of a lane's covered samples; returns the mask of those that pass, writing their depth when it should. */
  private depth(quad: Quad, lane: number, x: number, y: number, covered: number): number {
    const d = this.pass.depth
    const state = this.p.depth
    if (d === null || state === null) return covered
    const { store, level, layer } = d.att
    let passed = 0
    for (let s = 0; s < this.samples; s++) {
      if (((covered >> s) & 1) === 0) continue
      const z = depthOf(state.format, quad.depth[lane * this.samples + s])
      store.read(level, layer, x, y, s, this.texel)
      if (!passes(state.compare, z, this.texel[0])) continue
      passed |= 1 << s
      if (this.writesDepth) {
        this.out[0] = z
        store.write(level, layer, x, y, s, this.out)
      }
    }
    return passed
  }

  /** Blends a lane's outputs into every colour attachment, at the samples that passed. */
  private color(result: RunResult, lane: number, x: number, y: number, passed: number): void {
    const ow = (this.p.fragment as SoftLens).program.outputWidth
    for (const slot of this.p.colors) {
      const attached = this.pass.colors[slot.slot]
      if (attached === null || attached === undefined) continue
      const { store, level, layer } = attached.att
      for (let c = 0; c < 4; c++) this.src[c] = c < slot.port.size ? result.outputs[lane * ow + slot.port.offset + c] : c === 3 ? 1 : 0
      for (let s = 0; s < this.samples; s++) {
        if (((passed >> s) & 1) === 0) continue
        store.read(level, layer, x, y, s, this.texel)
        blend(slot.format, slot.blend, slot.mask, this.src, this.texel, this.constant, this.out)
        store.write(level, layer, x, y, s, this.out)
      }
    }
  }
}
