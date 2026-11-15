// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It makes the things a shader and a copy read and write: buffers, images, the views a
 * shader or a pass sees an image through, and samplers. Each descriptor is checked whole before anything is made
 * (sizes, the device's limits, known names, use lists, what each image format may be used for, which shape a view may
 * take, a sampler's level range), and each object keeps what later calls check against: a buffer's size and use, an
 * image's levels and layers, a view's range. A buffer or image has no back end object until it is bound to memory
 * (memory.ts), because the back end makes one only where its bytes live.
 * What breaks if it is removed? Nothing could be drawn into, copied or sampled, and a malformed size or format would
 * reach a back end that trusts what it is given.
 *
 * Rules beyond the field-by-field ones:
 * - A four-sample image is only ever an attachment: its use is `color` or `depth` (and nothing else), with one level
 *   and one layer, since no copy, sampled read or storage write takes four samples.
 * - An image's use asks the format for the matching ability: `color` needs a colour format, `depth` a depth format,
 *   `storage` a format a storage image may have. Every format may be sampled and copied.
 * - A view needs its image bound to memory (the back end's view is of the back end's image). A `2d` view has one layer.
 *   A view of a four-sample image is `2d` (WebGPU gives a multisampled texture only 2d views).
 * - An image is destroyed only once its views are; a view of a destroyed image could never be used.
 */
import type { Buffer, BufferUse, Filter, Handle, Image, ImageUse, Range, Sampler, View, Wrap } from './api.ts'
import { fail } from './fault.ts'
import { FORMATS, FORMAT_NAMES } from './formats.ts'
import type { Format } from './formats.ts'
import type { ImageDims } from './lens.ts'
import type { MemoryImpl } from './memory.ts'
import { Base, choice, every, finite, labelOf, names, own, record, span, whole } from './sync.ts'
import type { Core } from './sync.ts'
import { levelSize } from './texture.ts'
import { say } from './verify.ts'
import { IMAGE_DIMS } from './lens.ts'

export const BUFFER_USES = every<BufferUse>({ vertex: true, index: true, uniform: true, storage: true, indirect: true, 'copy-src': true, 'copy-dst': true })
export const IMAGE_USES = every<ImageUse>({ sampled: true, storage: true, color: true, depth: true, 'copy-src': true, 'copy-dst': true })
export const FILTERS = every<Filter>({ nearest: true, linear: true })
export const WRAPS = every<Wrap>({ clamp: true, repeat: true, mirror: true })

/** The largest level of detail a sampler may name. */
export const LOD_MAX = 32

/** What binding gives a buffer or image: where it lives, how many bytes it holds there, and the back end's object. */
interface Placed {
  readonly memory: MemoryImpl
  readonly offset: number
  readonly extent: number
  readonly handle: Handle
}

/** A buffer or an image: unbound until device.bind() places it in memory, bound for the rest of its life. */
export abstract class Bindable extends Base {
  private placed: Placed | null = null

  get memory(): MemoryImpl | null {
    return this.placed === null ? null : this.placed.memory
  }

  get offset(): number {
    return this.placed === null ? 0 : this.placed.offset
  }

  /** The bytes it takes in its memory (needs().size), 0 while unbound. */
  get extent(): number {
    return this.placed === null ? 0 : this.placed.extent
  }

  /** Called once by memory.ts when the resource is bound. */
  place(memory: MemoryImpl, offset: number, extent: number, handle: Handle): void {
    this.placed = { memory, offset, extent, handle }
  }

  /** The back end's object, refused while the resource is not bound to memory. */
  handle(where: string): Handle {
    if (this.placed === null) fail('state', `${where}: ${this.name} is not bound to memory yet`)
    return this.placed.handle
  }

  override drop(): void {
    if (this.placed === null) return
    const { memory, handle } = this.placed
    memory.bound.delete(this)
    this.core.call(`${this.name} destroy`, () => this.core.backend.destroy(handle))
  }
}

export class BufferImpl extends Bindable implements Buffer {
  readonly size: number
  readonly use: readonly BufferUse[]

  constructor(core: Core, size: number, use: readonly BufferUse[], label: string) {
    super(core, 'buffer', label)
    this.size = size
    this.use = use
  }
}

export class ImageImpl extends Bindable implements Image {
  readonly format: Format
  readonly width: number
  readonly height: number
  readonly layers: number
  readonly levels: number
  readonly samples: 1 | 4
  readonly use: readonly ImageUse[]
  /** Its live views. */
  readonly views = new Set<ViewImpl>()

  constructor(core: Core, info: { readonly format: Format; readonly width: number; readonly height: number; readonly layers: number; readonly levels: number; readonly samples: 1 | 4; readonly use: readonly ImageUse[] }, label: string) {
    super(core, 'image', label)
    this.format = info.format
    this.width = info.width
    this.height = info.height
    this.layers = info.layers
    this.levels = info.levels
    this.samples = info.samples
    this.use = info.use
  }

  /** The width and height of one of its levels. */
  levelWidth(level: number): number {
    return levelSize(this.width, level)
  }

  levelHeight(level: number): number {
    return levelSize(this.height, level)
  }

  protected override check(where: string): void {
    for (const v of this.views) fail('lifetime', `${where}: ${v.name} of it is still alive; destroy an image's views first`)
  }
}

export class ViewImpl extends Base implements View {
  readonly image: ImageImpl
  readonly dims: ImageDims
  readonly levels: Range
  readonly layers: Range
  readonly handle: Handle

  constructor(core: Core, image: ImageImpl, dims: ImageDims, levels: Range, layers: Range, label: string, handle: Handle) {
    super(core, 'view', label)
    this.image = image
    this.dims = dims
    this.levels = levels
    this.layers = layers
    this.handle = handle
    image.views.add(this)
  }

  /** The size of its first level, which is what a pass attaching it draws into. */
  get width(): number {
    return this.image.levelWidth(this.levels.base)
  }

  get height(): number {
    return this.image.levelHeight(this.levels.base)
  }

  override drop(): void {
    this.image.views.delete(this)
    this.core.call(`${this.name} destroy`, () => this.core.backend.destroy(this.handle))
  }
}

export class SamplerImpl extends Base implements Sampler {
  readonly mag: Filter
  readonly min: Filter
  readonly mip: Filter
  readonly wrap: readonly [Wrap, Wrap, Wrap]
  readonly lodMin: number
  readonly lodMax: number
  readonly handle: Handle

  constructor(core: Core, info: { readonly mag: Filter; readonly min: Filter; readonly mip: Filter; readonly wrap: readonly [Wrap, Wrap, Wrap]; readonly lodMin: number; readonly lodMax: number }, label: string, handle: Handle) {
    super(core, 'sampler', label)
    this.mag = info.mag
    this.min = info.min
    this.mip = info.mip
    this.wrap = info.wrap
    this.lodMin = info.lodMin
    this.lodMax = info.lodMax
    this.handle = handle
  }

  /** Every filter is nearest, so it may read a float image that cannot be filtered. */
  get nearest(): boolean {
    return this.mag === 'nearest' && this.min === 'nearest' && this.mip === 'nearest'
  }

  override drop(): void {
    this.core.call(`${this.name} destroy`, () => this.core.backend.destroy(this.handle))
  }
}

// ---------------------------------------------------------------------------------------------------
// Creation

export function createBuffer(core: Core, info: unknown, where: string): BufferImpl {
  const o = record(info, ['size', 'use', 'label'], where, 'the buffer info')
  const size = whole(o.size, where, 'the size', 1)
  if (size % 4 !== 0) fail('invalid', `${where}: the size ${size} is not a multiple of 4`)
  if (size > core.limits.bufferSize) fail('limit', `${where}: the size ${size} is more than the device's largest buffer, ${core.limits.bufferSize} bytes`)
  const use = names(BUFFER_USES, o.use, where, 'the use')
  return new BufferImpl(core, size, use, labelOf(o.label, where))
}

/** The most mip levels an image of this size has: down to 1 x 1. */
export function levelChain(width: number, height: number): number {
  return 32 - Math.clz32(Math.max(width, height))
}

export function createImage(core: Core, info: unknown, where: string): ImageImpl {
  const o = record(info, ['format', 'width', 'height', 'layers', 'levels', 'samples', 'use', 'label'], where, 'the image info')
  const format = choice(FORMAT_NAMES, o.format, where, 'the format')
  const width = whole(o.width, where, 'the width', 1)
  const height = whole(o.height, where, 'the height', 1)
  const max = core.limits.imageSize
  if (width > max || height > max) fail('limit', `${where}: ${width} x ${height} is larger than the device's largest image, ${max} x ${max}`)
  const layers = o.layers === undefined ? 1 : whole(o.layers, where, 'the layer count', 1)
  if (layers > core.limits.imageLayers) fail('limit', `${where}: ${layers} layers is more than the device allows, ${core.limits.imageLayers}`)
  const levels = o.levels === undefined ? 1 : whole(o.levels, where, 'the level count', 1)
  const chain = levelChain(width, height)
  if (levels > chain) fail('invalid', `${where}: ${levels} levels is more than a ${width} x ${height} image has, ${chain}`)
  const samples = o.samples === undefined ? 1 : o.samples
  if (samples !== 1 && samples !== 4) fail('invalid', `${where}: the sample count ${say(samples)} is not 1 or 4`)
  const use = names(IMAGE_USES, o.use, where, 'the use')
  const f = FORMATS[format]
  if (use.includes('color') && !f.color) fail('invalid', `${where}: ${format} cannot be a colour attachment, so an image of it has no color use`)
  if (use.includes('depth') && !f.depth) fail('invalid', `${where}: ${format} is not a depth format, so an image of it has no depth use`)
  if (use.includes('storage') && !f.storage) fail('invalid', `${where}: ${format} cannot be a storage image, so an image of it has no storage use`)
  if (samples === 4) {
    if (!f.multisample) fail('invalid', `${where}: ${format} cannot take four samples; a 32-bit float or integer image has one`)
    const other = use.find((u) => u !== 'color' && u !== 'depth')
    if (other !== undefined) fail('invalid', `${where}: a four-sample image is only an attachment; its use cannot hold ${other}`)
    if (!use.includes('color') && !use.includes('depth')) fail('invalid', `${where}: a four-sample image is an attachment; its use holds color or depth`)
    if (levels !== 1 || layers !== 1) fail('invalid', `${where}: a four-sample image has one level and one layer, not ${levels} and ${layers}`)
  }
  return new ImageImpl(core, { format, width, height, layers, levels, samples, use }, labelOf(o.label, where))
}

export function createView(core: Core, image: unknown, info: unknown, where: string): ViewImpl {
  const img = own(core, ImageImpl, image, where, 'the image', 'Image')
  const o = record(info, ['dims', 'levels', 'layers', 'label'], where, 'the view info', true)
  const handleOfImage = img.handle(where)
  const levels = span(o.levels, img.levels, where, 'the levels')
  const layers = span(o.layers, img.layers, where, 'the layers')
  const dims = choice(IMAGE_DIMS, o.dims, where, 'the shape', layers.count === 1 ? '2d' : '2d-array')
  if (dims === '2d' && layers.count !== 1) fail('invalid', `${where}: a 2d view has one layer, not ${layers.count}`)
  if (img.samples === 4 && dims !== '2d') fail('invalid', `${where}: a view of a four-sample image is 2d, not ${dims}`)
  const label = labelOf(o.label, where)
  core.enter(where)
  const handle = core.call(where, () => core.backend.createView(handleOfImage, dims, levels, layers))
  return new ViewImpl(core, img, dims, levels, layers, label, handle)
}

export function createSampler(core: Core, info: unknown, where: string): SamplerImpl {
  const o = record(info, ['mag', 'min', 'mip', 'wrap', 'lodMin', 'lodMax', 'label'], where, 'the sampler info', true)
  const mag = choice(FILTERS, o.mag, where, 'the mag filter', 'nearest')
  const min = choice(FILTERS, o.min, where, 'the min filter', 'nearest')
  const mip = choice(FILTERS, o.mip, where, 'the mip filter', 'nearest')
  // Read once: a getter could hand the checks one value and the copy another.
  const wrapIn = o.wrap
  let wrap: readonly [Wrap, Wrap, Wrap]
  if (wrapIn === undefined || typeof wrapIn === 'string') {
    const w = choice(WRAPS, wrapIn, where, 'the wrap mode', 'clamp')
    wrap = Object.freeze([w, w, w] as const)
  } else {
    if (!Array.isArray(wrapIn) || wrapIn.length !== 3) fail('invalid', `${where}: the wrap is one mode or a list of three, not ${say(wrapIn)}`)
    const [u, v, w] = [wrapIn[0], wrapIn[1], wrapIn[2]].map((m: unknown, i) => choice(WRAPS, m, where, `wrap mode ${i}`))
    wrap = Object.freeze([u, v, w] as const)
  }
  const lodMin = o.lodMin === undefined ? 0 : finite(o.lodMin, where, 'lodMin')
  const lodMax = o.lodMax === undefined ? LOD_MAX : finite(o.lodMax, where, 'lodMax')
  if (!(lodMin >= 0 && lodMin <= lodMax && lodMax <= LOD_MAX)) fail('invalid', `${where}: the levels of detail ${lodMin} to ${lodMax} do not keep 0 <= lodMin <= lodMax <= ${LOD_MAX}`)
  const label = labelOf(o.label, where)
  const state = { mag, min, mip, wrap, lodMin, lodMax }
  core.enter(where)
  const handle = core.call(where, () => core.backend.createSampler({ ...state, label }))
  return new SamplerImpl(core, state, label, handle)
}
