// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the shape of Nightglass, the product's own explicit GPU interface: the objects an
 * app holds (instance, adapter, device, queue, memory, buffers, images, views, samplers, binding layouts and sets,
 * shaders, pipelines, command lists, fences, semaphores), the descriptors it creates them from, the commands it
 * records, the rules of ordering it states with barriers, and the contract a back end fulfils (the GPU back end over
 * the browser's WebGPU, and the reference renderer in this folder). Apps, the console and the back ends all agree on
 * this one file.
 * What breaks if it is removed? Every caller and both back ends would lose the types they meet at, and the app layer
 * of the console would have nothing to draw through.
 */
import type { Fault } from './fault.ts'
import type { Format } from './formats.ts'
import type { ImageDims, LensModule, SampleKind, Stage } from './lens.ts'

// ---------------------------------------------------------------------------------------------------
// Adapters

/** What kind of device an adapter is: a discrete or an integrated GPU, a software GPU, or the reference renderer. */
export type AdapterKind = 'gpu' | 'integrated' | 'software' | 'reference'

/** Optional abilities a device opens with only when asked. */
export const FEATURES = Object.freeze(['float32-filter', 'depth-unclipped'] as const)
/**
 * `float32-filter`: r32f, rg32f and rgba32f images may be read through a linear filter.
 * `depth-unclipped`: a pipeline may set `depth.unclipped`, so geometry past the near and far planes is kept and its
 * depth clamped instead of being cut away.
 */
export type Feature = (typeof FEATURES)[number]

/** The most a device allows. A device opens with the adapter's limits unless it asks for less. */
export interface Limits {
  /** Widest and tallest image. */
  readonly imageSize: number
  /** Layers of one image. */
  readonly imageLayers: number
  /** Binding sets in one pipeline layout. */
  readonly sets: number
  /** Highest binding number in a set, plus one. */
  readonly bindings: number
  /** Bytes one uniform binding may cover, and one storage binding. */
  readonly uniformRange: number
  readonly storageRange: number
  /** The multiple a uniform or storage binding's offset (and a dynamic offset) must be. */
  readonly offsetAlign: number
  /** Per stage: uniform buffers, storage buffers, sampled images, samplers and storage images it may read. */
  readonly stageUniforms: number
  readonly stageStorage: number
  readonly stageImages: number
  readonly stageSamplers: number
  readonly stageStorageImages: number
  /** Dynamic uniform and dynamic storage bindings in one pipeline layout. */
  readonly dynamicUniforms: number
  readonly dynamicStorage: number
  /** Vertex buffers a pipeline reads, attributes in all, and the largest stride. */
  readonly vertexBuffers: number
  readonly vertexAttributes: number
  readonly vertexStride: number
  /** Values passed from the vertex stage to the fragment stage. */
  readonly interStage: number
  /** Colour attachments of one pass. */
  readonly colorAttachments: number
  /** Bytes of inline constants. */
  readonly constants: number
  /** Invocations of one workgroup, its largest size along x, y and z, and workgroups along each axis of a dispatch. */
  readonly groupInvocations: number
  readonly groupSize: readonly [number, number, number]
  readonly groups: number
  /** Largest buffer, and largest memory allocation. */
  readonly bufferSize: number
  readonly allocationSize: number
  /** Memory allocations alive at once. */
  readonly allocations: number
  /** The multiple a buffer row must be in a copy between a buffer and an image. */
  readonly copyRowAlign: number
  /** Bytes one `updateBuffer` command may carry. */
  readonly updateSize: number
}

/** A memory heap: a pool of bytes, on the device (`local`) or on the host. */
export interface MemoryHeap {
  readonly index: number
  readonly size: number
  readonly local: boolean
}

/**
 * The kinds of memory. `device`: on the device, for every kind of buffer. `images`: on the device, for images.
 * `upload`: seen by the host, for buffers that are only copied from (staging); the host writes through `map()` and
 * hands the bytes over with `flush()`. `readback`: seen by the host, for buffers that are only copied to; the host
 * takes the bytes with `invalidate()` once the work that wrote them is done.
 */
export type MemoryKindName = 'device' | 'images' | 'upload' | 'readback'

export interface MemoryKind {
  readonly index: number
  readonly name: MemoryKindName
  readonly heap: number
  /** The host can map it. */
  readonly host: boolean
}

/** A family of queues with the same abilities. */
export interface QueueGroup {
  readonly index: number
  readonly graphics: boolean
  readonly compute: boolean
  readonly copy: boolean
  readonly count: number
}

/** A device the instance can open, as a back end reports it. */
export interface AdapterReport {
  readonly name: string
  readonly kind: AdapterKind
  readonly limits: Limits
  readonly features: readonly Feature[]
  readonly heaps: readonly MemoryHeap[]
  readonly kinds: readonly MemoryKind[]
  readonly groups: readonly QueueGroup[]
}

export interface Adapter extends AdapterReport {
  /** Position in `instance.adapters()`. */
  readonly index: number
  /** The back end that reported it. */
  readonly backend: string
}

// ---------------------------------------------------------------------------------------------------
// Instance and device

export interface InstanceInfo {
  /** The app's name, for labels and reports. */
  readonly app?: string
  /** The back ends to offer adapters from, in order of preference. */
  readonly backends: readonly Backend[]
  /**
   * Check every call against the rules (default true). Off, only the checks that keep the back ends sound remain:
   * ordering (hazards), layouts and lifetimes are no longer checked, and a mistake there draws wrongly instead of
   * being refused.
   */
  readonly checks?: boolean
  /** Called with each Fault before it is thrown. */
  readonly report?: (fault: Fault) => void
}

export interface Instance {
  readonly app: string
  readonly checks: boolean
  /** Every adapter of every back end: GPUs first, then integrated, software and the reference renderer. */
  adapters(): readonly Adapter[]
  /** Opens a device on an adapter. */
  open(adapter: Adapter, info?: DeviceInfo): Device
}

export interface DeviceInfo {
  readonly features?: readonly Feature[]
  /** Lower limits to hold the device to (each at most the adapter's). */
  readonly limits?: Partial<Limits>
  /** Queues to open in each group (default: one queue of group 0). */
  readonly queues?: readonly { readonly group: number; readonly count: number }[]
  readonly label?: string
}

/** What every Nightglass object has. */
export interface Thing {
  readonly label: string
  readonly destroyed: boolean
  /** Frees the object. Refused while queued work still uses it. */
  destroy(): void
}

export interface Device extends Thing {
  readonly adapter: Adapter
  readonly limits: Limits
  readonly features: readonly Feature[]
  /** A queue opened with the device. */
  queue(group: number, index: number): Queue
  /** Allocates memory of a kind (an index into `adapter.kinds`). */
  allocate(info: MemoryInfo): Memory
  createBuffer(info: BufferInfo): Buffer
  createImage(info: ImageInfo): Image
  /** The size, alignment and memory kinds a buffer or image needs before it can be bound to memory. */
  needs(resource: Buffer | Image): Needs
  /** Binds a buffer or an image to memory at an offset. A resource is bound once and stays bound. */
  bind(resource: Buffer | Image, memory: Memory, offset: number): void
  createView(image: Image, info?: ViewInfo): View
  createSampler(info?: SamplerInfo): Sampler
  createBindingLayout(info: BindingLayoutInfo): BindingLayout
  createPipelineLayout(info: PipelineLayoutInfo): PipelineLayout
  createBindingPool(info: BindingPoolInfo): BindingPool
  /** Checks a shader (a Lens binary or a module) and makes it ready for pipelines. */
  createLens(source: Uint32Array | LensModule, label?: string): Lens
  createRenderPipeline(info: RenderPipelineInfo): RenderPipeline
  createComputePipeline(info: ComputePipelineInfo): ComputePipeline
  createCommandArena(info?: CommandArenaInfo): CommandArena
  createFence(info?: { readonly signalled?: boolean; readonly label?: string }): Fence
  createSemaphore(info?: { readonly label?: string }): Semaphore
  /** The reason the device was lost, or null while it works. */
  lost(): string | null
}

// ---------------------------------------------------------------------------------------------------
// Memory and resources

export interface MemoryInfo {
  readonly size: number
  /** Index into `adapter.kinds`. */
  readonly kind: number
  readonly label?: string
}

export interface Memory extends Thing {
  readonly size: number
  readonly kind: MemoryKind
  /** The host's view of host-visible memory (the same bytes every call). Refused for device memory. */
  map(): Uint8Array
  /** Hands the host's writes in a range to the device. Work submitted after a flush sees them. */
  flush(offset?: number, size?: number): void
  /** Takes the device's writes in a range into the host's view. Allowed once the work that wrote them is done. */
  invalidate(offset?: number, size?: number): void
}

/** What a buffer or image needs of memory. `kinds` are the indices of the memory kinds it may be bound to. */
export interface Needs {
  readonly size: number
  readonly align: number
  readonly kinds: readonly number[]
}

export type BufferUse = 'vertex' | 'index' | 'uniform' | 'storage' | 'indirect' | 'copy-src' | 'copy-dst'

export interface BufferInfo {
  /** Bytes, a multiple of 4. */
  readonly size: number
  readonly use: readonly BufferUse[]
  readonly label?: string
}

export interface Buffer extends Thing {
  readonly size: number
  readonly use: readonly BufferUse[]
  /** The memory and offset it is bound to, or null before `device.bind`. */
  readonly memory: Memory | null
  readonly offset: number
}

export type ImageUse = 'sampled' | 'storage' | 'color' | 'depth' | 'copy-src' | 'copy-dst'

export interface ImageInfo {
  readonly format: Format
  readonly width: number
  readonly height: number
  /** Layers (default 1). */
  readonly layers?: number
  /** Mip levels (default 1). */
  readonly levels?: number
  /** Samples per pixel (default 1); 4 only for colour and depth attachments of one level and one layer. */
  readonly samples?: 1 | 4
  readonly use: readonly ImageUse[]
  readonly label?: string
}

export interface Image extends Thing {
  readonly format: Format
  readonly width: number
  readonly height: number
  readonly layers: number
  readonly levels: number
  readonly samples: 1 | 4
  readonly use: readonly ImageUse[]
  readonly memory: Memory | null
}

/** A range of mip levels or of layers. */
export interface Range {
  readonly base: number
  readonly count: number
}

export interface ViewInfo {
  /** Default `2d` for one layer, `2d-array` for more. */
  readonly dims?: ImageDims
  readonly levels?: Range
  readonly layers?: Range
  readonly label?: string
}

export interface View extends Thing {
  readonly image: Image
  readonly dims: ImageDims
  readonly levels: Range
  readonly layers: Range
}

export type Filter = 'nearest' | 'linear'
export type Wrap = 'clamp' | 'repeat' | 'mirror'

export interface SamplerInfo {
  readonly mag?: Filter
  readonly min?: Filter
  readonly mip?: Filter
  /** One mode for every axis, or one each for u, v and w. */
  readonly wrap?: Wrap | readonly [Wrap, Wrap, Wrap]
  readonly lodMin?: number
  readonly lodMax?: number
  readonly label?: string
}

export interface Sampler extends Thing {
  readonly mag: Filter
  readonly min: Filter
  readonly mip: Filter
  readonly wrap: readonly [Wrap, Wrap, Wrap]
  readonly lodMin: number
  readonly lodMax: number
}

// ---------------------------------------------------------------------------------------------------
// Bindings

/** `storage` may be written by the shader, `storage-read` only read. */
export type BindingKind = 'uniform' | 'storage' | 'storage-read' | 'image' | 'sampler' | 'storage-image'

export interface BindingEntry {
  readonly binding: number
  readonly kind: BindingKind
  readonly stages: readonly Stage[]
  /** A buffer binding whose offset is given when the set is bound (uniform and storage kinds). */
  readonly dynamic?: boolean
  /** What a sampled image hands the shader (default float), and its view's shape (default 2d). */
  readonly sample?: SampleKind
  readonly dims?: ImageDims
  /** A float image that is never filtered: any float format may be bound, and only non-filtering samplers read it. */
  readonly unfiltered?: boolean
  /** A storage image's format. */
  readonly format?: Format
  /** A sampler that may filter linearly (default true); a non-filtering one pairs with float images it cannot filter. */
  readonly filtering?: boolean
}

export interface BindingLayoutInfo {
  readonly entries: readonly BindingEntry[]
  readonly label?: string
}

export interface BindingLayout extends Thing {
  readonly entries: readonly BindingEntry[]
}

export interface PipelineLayoutInfo {
  readonly sets: readonly BindingLayout[]
  /** Inline constants: bytes (a multiple of 4, at most `limits.constants`) and the stages that read them. */
  readonly constants?: { readonly size: number; readonly stages: readonly Stage[] }
  readonly label?: string
}

export interface PipelineLayout extends Thing {
  readonly sets: readonly BindingLayout[]
  readonly constants: { readonly size: number; readonly stages: readonly Stage[] } | null
}

export interface BindingPoolInfo {
  /** Sets the pool can hand out before it is reset. */
  readonly sets: number
  readonly label?: string
}

export interface BindingPool extends Thing {
  /** A new set of a layout; every binding empty until written. */
  allocate(layout: BindingLayout, label?: string): BindingSet
  /** Returns every set the pool handed out; they are destroyed. Refused while queued work uses one. */
  reset(): void
}

export type BindingWrite =
  | { readonly binding: number; readonly buffer: Buffer; readonly offset?: number; readonly size?: number }
  | { readonly binding: number; readonly view: View }
  | { readonly binding: number; readonly sampler: Sampler }

export interface BindingSet extends Thing {
  readonly layout: BindingLayout
  /** Fills bindings. A command list recorded with this set before the write must be recorded again. */
  write(writes: readonly BindingWrite[]): void
}

// ---------------------------------------------------------------------------------------------------
// Shaders and pipelines

export interface Lens extends Thing {
  readonly module: LensModule
  readonly stage: Stage
}

export type Topology = 'triangles' | 'triangle-strip'
export type VertexFormat = 'f32' | 'f32x2' | 'f32x3' | 'f32x4' | 'u32' | 'u32x2' | 'u32x3' | 'u32x4' | 'i32' | 'i32x2' | 'i32x3' | 'i32x4' | 'unorm8x4'

export interface VertexAttribute {
  readonly slot: number
  readonly format: VertexFormat
  readonly offset: number
}

export interface VertexBufferLayout {
  /** Bytes from one vertex (or instance) to the next, a multiple of 4. */
  readonly stride: number
  /** Advance per vertex (default) or per instance. */
  readonly rate?: 'vertex' | 'instance'
  readonly attributes: readonly VertexAttribute[]
}

export type BlendFactor = 'zero' | 'one' | 'src' | 'one-minus-src' | 'src-alpha' | 'one-minus-src-alpha' | 'dst' | 'one-minus-dst' | 'dst-alpha' | 'one-minus-dst-alpha' | 'src-alpha-saturated' | 'constant' | 'one-minus-constant'
export type BlendOp = 'add' | 'subtract' | 'reverse-subtract' | 'min' | 'max'

export interface BlendPart {
  readonly src: BlendFactor
  readonly dst: BlendFactor
  readonly op?: BlendOp
}

export interface ColorOutput {
  readonly format: Format
  readonly blend?: { readonly color: BlendPart; readonly alpha: BlendPart }
  /** Channels written: bit 1 red, 2 green, 4 blue, 8 alpha (default 15). */
  readonly mask?: number
}

export type Compare = 'never' | 'less' | 'equal' | 'less-equal' | 'greater' | 'not-equal' | 'greater-equal' | 'always'

export interface DepthState {
  readonly format: Format
  /** Write depth (default false). */
  readonly write?: boolean
  /** Keep a fragment when this holds of its depth and the stored one (default always). */
  readonly compare?: Compare
  /** Keep geometry past the near and far planes (needs the `depth-unclipped` feature). */
  readonly unclipped?: boolean
}

export interface RenderPipelineInfo {
  readonly layout: PipelineLayout
  readonly vertex: { readonly lens: Lens; readonly buffers?: readonly VertexBufferLayout[] }
  /** Absent: a pipeline that writes depth only. */
  readonly fragment?: { readonly lens: Lens; readonly outputs: readonly (ColorOutput | null)[] }
  readonly topology?: Topology
  readonly cull?: 'none' | 'front' | 'back'
  /** Which winding faces the viewer, in framebuffer coordinates (default ccw). */
  readonly front?: 'ccw' | 'cw'
  readonly depth?: DepthState
  readonly samples?: 1 | 4
  readonly label?: string
}

export interface RenderPipeline extends Thing {
  readonly layout: PipelineLayout
  readonly info: RenderPipelineInfo
}

export interface ComputePipelineInfo {
  readonly layout: PipelineLayout
  readonly lens: Lens
  readonly label?: string
}

export interface ComputePipeline extends Thing {
  readonly layout: PipelineLayout
  readonly lens: Lens
}

// ---------------------------------------------------------------------------------------------------
// Ordering: layouts, stages, access and barriers

/**
 * The layout an image (one level of one layer) is in. Every use needs a layout: `color` and `depth` for attachments,
 * `depth-read` for a depth attachment that is only tested or a depth image that is sampled, `shader-read` for
 * sampling, `general` for a storage image (and any use, more slowly on a real GPU), `copy-src` and `copy-dst` for
 * copies, `present` for a surface's image handed to the screen. `blank` is where every image starts: its contents
 * are undefined, and moving out of it keeps nothing.
 */
export type ImageLayout = 'blank' | 'general' | 'color' | 'depth' | 'depth-read' | 'shader-read' | 'copy-src' | 'copy-dst' | 'present'

/** The stages of the work a command does, in the order the device runs them. */
export type PipeStage = 'top' | 'indirect' | 'vertex-input' | 'vertex' | 'fragment' | 'depth' | 'color' | 'compute' | 'copy' | 'host' | 'bottom' | 'all'

/** The kinds of memory access a stage makes. `any-read` and `any-write` stand for every read and every write. */
export type Access = 'indirect-read' | 'index-read' | 'vertex-read' | 'uniform-read' | 'shader-read' | 'shader-write' | 'color-read' | 'color-write' | 'depth-read' | 'depth-write' | 'copy-read' | 'copy-write' | 'host-read' | 'host-write' | 'any-read' | 'any-write'

/** Stages, and what they access, on one side of a barrier. */
export interface Scope {
  readonly stages: readonly PipeStage[]
  readonly access?: readonly Access[]
}

/** Work in `before` (and its writes) finishes before work in `after` starts (and sees them). */
export interface MemoryBarrier {
  readonly before: Scope
  readonly after: Scope
}

export interface BufferBarrier extends MemoryBarrier {
  readonly buffer: Buffer
  readonly offset?: number
  readonly size?: number
}

export interface ImageBarrier extends MemoryBarrier {
  readonly image: Image
  /** The layout the range is in now (`blank` throws the contents away), and the layout it moves to. */
  readonly from: ImageLayout
  readonly to: ImageLayout
  readonly levels?: Range
  readonly layers?: Range
}

export interface BarrierInfo {
  readonly memory?: readonly MemoryBarrier[]
  readonly buffers?: readonly BufferBarrier[]
  readonly images?: readonly ImageBarrier[]
}

// ---------------------------------------------------------------------------------------------------
// Commands

/** `keep` the attachment's contents, `clear` them, or start from `any` contents (undefined). */
export type LoadOp = 'keep' | 'clear' | 'any'
/** `keep` what the pass drew, or leave the contents undefined (`any`). */
export type StoreOp = 'keep' | 'any'

export interface ColorAttachment {
  readonly view: View
  readonly load: LoadOp
  readonly store: StoreOp
  /** The colour a `clear` load writes (default transparent black). */
  readonly clear?: readonly [number, number, number, number]
  /** A one-sample view the four-sample attachment is resolved into when the pass ends. */
  readonly resolve?: View
}

export interface DepthAttachment {
  readonly view: View
  readonly load: LoadOp
  readonly store: StoreOp
  /** The depth a `clear` load writes (default 1). */
  readonly clear?: number
  /** The pass only tests depth (the image is in `depth-read`); pipelines may not write it. */
  readonly readOnly?: boolean
}

export interface PassInfo {
  /** Colour attachments by output slot; null leaves a slot empty. */
  readonly colors: readonly (ColorAttachment | null)[]
  readonly depth?: DepthAttachment
  readonly label?: string
}

export interface BufferCopy {
  readonly from: number
  readonly to: number
  readonly size: number
}

/** A rectangle of one level of one layer. */
export interface ImageRegion {
  readonly level?: number
  readonly layer?: number
  readonly x?: number
  readonly y?: number
  readonly width: number
  readonly height: number
}

export interface BufferImageCopy {
  /** Where the first row starts in the buffer. */
  readonly offset: number
  /** Bytes from one row to the next in the buffer (a multiple of `limits.copyRowAlign` when more than one row). */
  readonly rowBytes: number
  readonly region: ImageRegion
}

export interface ImageCopy {
  readonly from: ImageRegion
  readonly to: { readonly level?: number; readonly layer?: number; readonly x?: number; readonly y?: number }
}

export interface Viewport {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** Depth range (default 0 to 1). */
  readonly near?: number
  readonly far?: number
}

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type CommandListState = 'initial' | 'recording' | 'ready' | 'pending' | 'invalid'

/**
 * A list of commands recorded on the host and run by a queue. Binding state (pipelines, sets, vertex and index
 * buffers, constants, viewport, scissor, blend constant) lasts until the next `beginPass` or `endPass`: draws bind
 * inside a pass, dispatches outside one. A pass starts with the viewport and scissor covering its attachments.
 */
export interface CommandList extends Thing {
  readonly state: CommandListState
  /** Starts recording. `once`: the list is submitted once, then must be reset. */
  begin(info?: { readonly once?: boolean }): void
  end(): void
  /** Back to `initial` (the arena must allow it). */
  reset(): void
  beginPass(info: PassInfo): void
  endPass(): void
  bindPipeline(pipeline: RenderPipeline | ComputePipeline): void
  bindSets(layout: PipelineLayout, first: number, sets: readonly BindingSet[], offsets?: readonly number[]): void
  bindVertices(first: number, buffers: readonly { readonly buffer: Buffer; readonly offset?: number }[]): void
  bindIndices(buffer: Buffer, offset: number, type: 'u16' | 'u32'): void
  setViewport(viewport: Viewport): void
  setScissor(rect: Rect): void
  setBlendConstant(rgba: readonly [number, number, number, number]): void
  /** Writes inline constants at a byte offset; bytes never written read as zero. */
  setConstants(layout: PipelineLayout, offset: number, data: ArrayBufferView): void
  draw(vertices: number, instances?: number, firstVertex?: number, firstInstance?: number): void
  drawIndexed(indices: number, instances?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number): void
  /** The draw's numbers come from the buffer: 4 u32 (vertices, instances, first vertex, first instance). */
  drawIndirect(buffer: Buffer, offset: number): void
  /** 5 words: indices, instances, first index, base vertex (i32), first instance. */
  drawIndexedIndirect(buffer: Buffer, offset: number): void
  dispatch(x: number, y?: number, z?: number): void
  /** 3 u32: workgroups along x, y and z. */
  dispatchIndirect(buffer: Buffer, offset: number): void
  copyBuffer(src: Buffer, dst: Buffer, regions: readonly BufferCopy[]): void
  copyBufferToImage(src: Buffer, dst: Image, regions: readonly BufferImageCopy[]): void
  copyImageToBuffer(src: Image, dst: Buffer, regions: readonly BufferImageCopy[]): void
  copyImage(src: Image, dst: Image, regions: readonly ImageCopy[]): void
  /** Writes up to `limits.updateSize` bytes, carried in the list itself. */
  updateBuffer(dst: Buffer, offset: number, data: ArrayBufferView): void
  zeroBuffer(dst: Buffer, offset: number, size: number): void
  barrier(info: BarrierInfo): void
  beginGroup(label: string): void
  endGroup(): void
}

export interface CommandArenaInfo {
  /** The queue group its lists run on (default 0). */
  readonly group?: number
  /** Lists may be reset one by one (default true); otherwise only the whole arena resets. */
  readonly resettable?: boolean
  readonly label?: string
}

export interface CommandArena extends Thing {
  allocate(label?: string): CommandList
  /** Resets every list it handed out. Refused while one is pending. */
  reset(): void
}

// ---------------------------------------------------------------------------------------------------
// Queues and synchronisation

/** Set from the device when submitted work finishes; read and reset by the host. */
export interface Fence extends Thing {
  readonly signalled: boolean
  /** Back to unsignalled. Refused while it waits on submitted work. */
  reset(): void
  /** Calls back once when the fence is signalled (at once if it already is). */
  onSignal(callback: () => void): void
}

/** Orders one submission after another on the device: one signals it, one later waits on it. */
export type Semaphore = Thing

export interface Submission {
  readonly lists: readonly CommandList[]
  /** Semaphores to wait on before the work's given stages run. */
  readonly wait?: readonly { readonly semaphore: Semaphore; readonly stages: readonly PipeStage[] }[]
  /** Semaphores to signal when the work is done. */
  readonly signal?: readonly Semaphore[]
}

export interface Queue {
  readonly group: number
  readonly index: number
  /** Queues the work; signals the fence when every submission is done. */
  submit(submissions: readonly Submission[], fence?: Fence): void
}

// ---------------------------------------------------------------------------------------------------
// The back end contract

/** A back end's own object for a Nightglass object. Only the back end that made it reads it. */
export type Handle = unknown

/** The commands a back end runs, as the core recorded and checked them. Every object is the back end's handle. */
export type Command =
  | {
      readonly c: 'pass'
      readonly colors: readonly ({ readonly view: Handle; readonly load: LoadOp; readonly store: StoreOp; readonly clear: readonly [number, number, number, number]; readonly resolve: Handle | null } | null)[]
      readonly depth: { readonly view: Handle; readonly load: LoadOp; readonly store: StoreOp; readonly clear: number; readonly readOnly: boolean } | null
      readonly width: number
      readonly height: number
    }
  | { readonly c: 'end-pass' }
  | { readonly c: 'pipeline'; readonly pipeline: Handle; readonly compute: boolean }
  | { readonly c: 'sets'; readonly first: number; readonly sets: readonly Handle[]; readonly offsets: readonly number[] }
  | { readonly c: 'vertices'; readonly first: number; readonly buffers: readonly { readonly buffer: Handle; readonly offset: number }[] }
  | { readonly c: 'indices'; readonly buffer: Handle; readonly offset: number; readonly type: 'u16' | 'u32' }
  | { readonly c: 'viewport'; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly near: number; readonly far: number }
  | { readonly c: 'scissor'; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  | { readonly c: 'blend-constant'; readonly rgba: readonly [number, number, number, number] }
  | { readonly c: 'constants'; readonly offset: number; readonly bytes: Uint8Array }
  | { readonly c: 'draw'; readonly vertices: number; readonly instances: number; readonly firstVertex: number; readonly firstInstance: number }
  | { readonly c: 'draw-indexed'; readonly indices: number; readonly instances: number; readonly firstIndex: number; readonly baseVertex: number; readonly firstInstance: number }
  | { readonly c: 'draw-indirect'; readonly buffer: Handle; readonly offset: number; readonly indexed: boolean }
  | { readonly c: 'dispatch'; readonly x: number; readonly y: number; readonly z: number }
  | { readonly c: 'dispatch-indirect'; readonly buffer: Handle; readonly offset: number }
  | { readonly c: 'copy-buffer'; readonly src: Handle; readonly dst: Handle; readonly regions: readonly BufferCopy[] }
  | { readonly c: 'copy-buffer-image'; readonly src: Handle; readonly dst: Handle; readonly regions: readonly Required<BufferImageCopy>[] }
  | { readonly c: 'copy-image-buffer'; readonly src: Handle; readonly dst: Handle; readonly regions: readonly Required<BufferImageCopy>[] }
  | { readonly c: 'copy-image'; readonly src: Handle; readonly dst: Handle; readonly regions: readonly ImageCopy[] }
  | { readonly c: 'update'; readonly dst: Handle; readonly offset: number; readonly bytes: Uint8Array }
  | { readonly c: 'zero'; readonly dst: Handle; readonly offset: number; readonly size: number }
  | { readonly c: 'barrier' }
  | { readonly c: 'group'; readonly label: string }
  | { readonly c: 'end-group' }

/** A set's bindings as a back end receives them: every binding of its layout, each filled. */
export type BoundEntry =
  | { readonly binding: number; readonly buffer: Handle; readonly offset: number; readonly size: number }
  | { readonly binding: number; readonly view: Handle }
  | { readonly binding: number; readonly sampler: Handle }

/** A source of adapters: the GPU back end over WebGPU, or the reference renderer. */
export interface Backend {
  readonly name: string
  adapters(): readonly AdapterReport[]
  /** Opens a device on one of its adapters (by position in `adapters()`). */
  open(adapter: number, features: readonly Feature[], limits: Limits): BackendDevice
}

/**
 * A device as the core drives it. Every call has passed the core's checks, so a back end trusts its arguments; what
 * it may still refuse (the GPU lost, memory exhausted) it refuses with a Fault of code `device` or `memory`. A
 * submit either refuses before any of its work runs (nothing changed, and the device goes on) or, if it stops part
 * way, reports the device lost from then on through lost() before it raises: the core cannot undo work that ran.
 */
export interface BackendDevice {
  allocate(kind: MemoryKindName, size: number): Handle
  /** The host's bytes of host-visible memory (the same array every call). */
  hostBytes(memory: Handle): Uint8Array
  flush(memory: Handle, offset: number, size: number): void
  invalidate(memory: Handle, offset: number, size: number): void
  createBuffer(info: BufferInfo, memory: Handle, offset: number): Handle
  createImage(info: Required<ImageInfo>, memory: Handle, offset: number): Handle
  createView(image: Handle, dims: ImageDims, levels: Range, layers: Range): Handle
  createSampler(info: Required<Omit<SamplerInfo, 'wrap' | 'label'>> & { readonly wrap: readonly [Wrap, Wrap, Wrap]; readonly label: string }): Handle
  createBindingLayout(info: BindingLayoutInfo): Handle
  createPipelineLayout(sets: readonly Handle[], constants: { readonly size: number; readonly stages: readonly Stage[] } | null): Handle
  createBindingSet(layout: Handle): Handle
  /** Replaces a set's bindings: called with every binding once the set is complete, again after each write, and with none at once for a set whose layout has no entries. */
  writeBindingSet(set: Handle, entries: readonly BoundEntry[]): void
  createLens(module: LensModule): Handle
  createRenderPipeline(info: RenderPipelineInfo, layout: Handle, vertex: Handle, fragment: Handle | null): Handle
  createComputePipeline(layout: Handle, lens: Handle): Handle
  /** Runs the work in order; calls `done` once all of it has finished and readback memory can be invalidated. */
  submit(lists: readonly (readonly Command[])[], done: () => void): void
  destroy(handle: Handle): void
  lost(): string | null
}
