// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It turns shaders and fixed state into what a draw or a dispatch runs. A Lens is decoded
 * (from words) or copied through the binary form (from a module), and checked by verify(), so a back end only ever
 * sees a frozen, valid module. A render pipeline is checked whole: its vertex buffers and attributes against the
 * device's limits and against the inputs of its vertex lens, the values its vertex lens passes against the inputs of
 * its fragment lens, its colour outputs against the formats and the fragment lens's outputs, its blend, depth and
 * raster state, and every resource both lenses declare against the pipeline layout. A compute pipeline is checked
 * the same way for its one lens and its workgroup size. Each pipeline keeps what command recording checks a draw or
 * dispatch against: the sets its lenses read, the bytes each buffer binding must hold, its attachment formats, its
 * vertex buffers.
 * What breaks if it is removed? Nothing could be drawn or dispatched, and a shader could reach a back end reading a
 * binding the layout does not have, or an attribute no buffer feeds.
 *
 * Rules beyond the field-by-field ones:
 * - Every vertex lens input slot is fed by exactly one attribute, f32 formats feeding f32 inputs of the same width,
 *   u32 u32, i32 i32, and unorm8x4 an f32x4. Attributes no input reads are allowed; two on one slot are not.
 * - Every fragment lens input matches a vertex lens output of the same slot, type and flatness. The vertex lens
 *   passes at most `limits.interStage` values.
 * - A colour output with a write mask other than 0 needs a fragment lens output at its slot whose scalar kind is the
 *   format's (f32 for unorm and float, u32 for uint, i32 for sint) and whose width covers the format's channels.
 * - The colour outputs (every one, whatever its mask) take at most `limits.colorBytes` bytes per sample, counted slot
 *   by slot by colorBytes() in formats.ts, as WebGPU counts them (rgba8 and bgra8 cost 8, rgba32f 16).
 * - A blend whose operation is min or max takes the factor `one` on both sides, as WebGPU requires.
 * - A lens resource needs a layout entry at its set and binding that lists the lens's stage and is of the matching
 *   kind: uniform to uniform; writable storage to storage; read-only storage to storage or storage-read; an image to
 *   an image entry of the same sample kind and shape; a sampler to a sampler; a storage image to a storage-image
 *   entry of the same format. Constants need layout constants at least as large, listing the stage.
 * - A `sample` instruction whose image's entry is unfiltered needs a sampler entry with filtering false.
 * - A uniform block is at most `limits.uniformRange` bytes, the fixed part of a storage block at most
 *   `limits.storageRange`. A binding must hold at least the block (the fixed part of a storage block, whose final
 *   array may hold no elements at all); command recording checks that against what each set holds.
 */
import type {
  BlendFactor, BlendOp, BlendPart, ColorOutput, Compare, ComputePipeline, DepthState, Handle, Lens, RenderPipeline,
  RenderPipelineInfo, Topology, VertexAttribute, VertexBufferLayout, VertexFormat,
} from './api.ts'
import { decode, encode } from './binary.ts'
import { BindingLayoutImpl, PipelineLayoutImpl } from './bindings.ts'
import { fail, isFault } from './fault.ts'
import { FORMATS, FORMAT_NAMES, colorBytes, sampleKind } from './formats.ts'
import type { Format } from './formats.ts'
import { layoutBlock, scalarOf, widthOf } from './lens.ts'
import type { Block, Inst, LensModule, Stage, ValueType } from './lens.ts'
import { Base, choice, every, flag, labelOf, listOf, own, record, whole } from './sync.ts'
import type { Core } from './sync.ts'
import { verify } from './verify.ts'

export const TOPOLOGIES = every<Topology>({ triangles: true, 'triangle-strip': true })
export const COMPARES = every<Compare>({ never: true, less: true, equal: true, 'less-equal': true, greater: true, 'not-equal': true, 'greater-equal': true, always: true })
export const BLEND_OPS = every<BlendOp>({ add: true, subtract: true, 'reverse-subtract': true, min: true, max: true })
export const BLEND_FACTORS = every<BlendFactor>({
  zero: true, one: true, src: true, 'one-minus-src': true, 'src-alpha': true, 'one-minus-src-alpha': true, dst: true, 'one-minus-dst': true,
  'dst-alpha': true, 'one-minus-dst-alpha': true, 'src-alpha-saturated': true, constant: true, 'one-minus-constant': true,
})

/** Each vertex format's bytes and the lens input type it feeds. */
export const VERTEX_FORMATS: { readonly [K in VertexFormat]: { readonly bytes: number; readonly type: ValueType } } = Object.freeze({
  f32: { bytes: 4, type: 'f32' }, f32x2: { bytes: 8, type: 'f32x2' }, f32x3: { bytes: 12, type: 'f32x3' }, f32x4: { bytes: 16, type: 'f32x4' },
  u32: { bytes: 4, type: 'u32' }, u32x2: { bytes: 8, type: 'u32x2' }, u32x3: { bytes: 12, type: 'u32x3' }, u32x4: { bytes: 16, type: 'u32x4' },
  i32: { bytes: 4, type: 'i32' }, i32x2: { bytes: 8, type: 'i32x2' }, i32x3: { bytes: 12, type: 'i32x3' }, i32x4: { bytes: 16, type: 'i32x4' },
  unorm8x4: { bytes: 4, type: 'f32x4' },
})
const VERTEX_FORMAT_NAMES = Object.freeze(Object.keys(VERTEX_FORMATS) as VertexFormat[])

export class LensImpl extends Base implements Lens {
  readonly module: LensModule
  readonly stage: Stage
  readonly handle: Handle

  constructor(core: Core, module: LensModule, label: string, handle: Handle) {
    super(core, 'lens', label)
    this.module = module
    this.stage = module.stage
    this.handle = handle
  }

  override drop(): void {
    this.core.call(`${this.name} destroy`, () => this.core.backend.destroy(this.handle))
  }
}

export function createLens(core: Core, source: unknown, label: unknown, where: string): LensImpl {
  const name = labelOf(label, where)
  let module: LensModule
  try {
    if (source instanceof Uint32Array) {
      module = decode(source)
    } else {
      // Checked first for the clearest refusal, then carried through the binary form so the lens holds a frozen
      // copy no later change to the caller's object can reach, and checked again as the copy it keeps.
      verify(source as LensModule)
      module = decode(encode(source as LensModule))
    }
    verify(module)
  } catch (e) {
    if (isFault(e, 'lens')) fail('lens', `${where}: ${e.message}`)
    throw e
  }
  core.enter(where)
  const handle = core.call(where, () => core.backend.createLens(module))
  return new LensImpl(core, module, name, handle)
}

/** A binding a pipeline's lens reads, and the bytes a buffer bound there must hold (0 for anything but a buffer). */
export interface Use {
  readonly set: number
  readonly binding: number
  readonly minSize: number
}

/** A vertex buffer layout as a pipeline keeps it: defaults filled in, and the bytes one element's attributes reach. */
export interface VertexLayout extends VertexBufferLayout {
  readonly rate: 'vertex' | 'instance'
  /** The end of the last attribute byte within one element (0 with no attributes). */
  readonly reach: number
}

/** What a pipeline of either kind holds for recording to check against. */
abstract class Pipeline extends Base {
  readonly layout: PipelineLayoutImpl
  readonly handle: Handle
  readonly uses: readonly Use[]
  /** The set indices its lenses read, ascending. */
  readonly sets: readonly number[]

  constructor(core: Core, kind: string, label: string, layout: PipelineLayoutImpl, uses: readonly Use[], handle: Handle) {
    super(core, kind, label)
    this.layout = layout
    this.uses = uses
    this.sets = Object.freeze([...new Set(uses.map((u) => u.set))].sort((a, b) => a - b))
    this.handle = handle
  }

  override drop(): void {
    this.core.call(`${this.name} destroy`, () => this.core.backend.destroy(this.handle))
  }
}

export class RenderPipelineImpl extends Pipeline implements RenderPipeline {
  /** The descriptor with every default filled in, frozen: what the back end was given. */
  readonly info: RenderPipelineInfo
  readonly buffers: readonly VertexLayout[]
  /** The format each colour slot writes, or null. */
  readonly colors: readonly (Format | null)[]
  readonly depth: Format | null
  readonly samples: 1 | 4
  readonly writesDepth: boolean

  constructor(core: Core, info: RenderPipelineInfo, layout: PipelineLayoutImpl, buffers: readonly VertexLayout[], uses: readonly Use[], handle: Handle) {
    super(core, 'render pipeline', info.label ?? '', layout, uses, handle)
    this.info = info
    this.buffers = buffers
    this.colors = Object.freeze((info.fragment?.outputs ?? []).map((o) => (o === null ? null : o.format)))
    this.depth = info.depth === undefined ? null : info.depth.format
    this.samples = info.samples ?? 1
    this.writesDepth = info.depth?.write === true
  }
}

export class ComputePipelineImpl extends Pipeline implements ComputePipeline {
  readonly lens: LensImpl

  constructor(core: Core, layout: PipelineLayoutImpl, lens: LensImpl, label: string, uses: readonly Use[], handle: Handle) {
    super(core, 'compute pipeline', label, layout, uses, handle)
    this.lens = lens
  }
}

/** A lens of one stage, made by this device and alive. */
function lensOf(core: Core, x: unknown, stage: Stage, where: string): LensImpl {
  const lens = own(core, LensImpl, x, where, `the ${stage} lens`, 'Lens')
  if (lens.stage !== stage) fail('mismatch', `${where}: ${lens.name} is a ${lens.stage} lens, not a ${stage} one`)
  return lens
}

function vertexBuffers(core: Core, x: unknown, lens: LensImpl, where: string): readonly VertexLayout[] {
  const list = x === undefined ? [] : listOf(x, where, 'the vertex buffers', (n) => {
    if (n > core.limits.vertexBuffers) fail('limit', `${where}: ${n} vertex buffers is more than the device allows, ${core.limits.vertexBuffers}`)
  })
  // Slots are below `limits.vertexAttributes` and fed once, so the attributes in all never pass that limit either.
  const fed = new Map<number, VertexFormat>()
  const layouts = list.map((b, i): VertexLayout => {
    const at = `${where}: vertex buffer ${i}`
    const o = record(b, ['stride', 'rate', 'attributes'], at, 'the buffer layout')
    const stride = whole(o.stride, at, 'the stride')
    if (stride % 4 !== 0) fail('invalid', `${at}: the stride ${stride} is not a multiple of 4`)
    if (stride > core.limits.vertexStride) fail('limit', `${at}: the stride ${stride} is more than the device allows, ${core.limits.vertexStride}`)
    const rate = choice(['vertex', 'instance'] as const, o.rate, at, 'the rate', 'vertex')
    const room = stride === 0 ? core.limits.vertexStride : stride
    let reach = 0
    const attrs = listOf(o.attributes, at, 'the attributes').map((a, j): VertexAttribute => {
      const aat = `${at} attribute ${j}`
      const ao = record(a, ['slot', 'format', 'offset'], aat, 'the attribute')
      const slot = whole(ao.slot, aat, 'the slot')
      if (slot >= core.limits.vertexAttributes) fail('limit', `${aat}: slot ${slot} is past the device's highest, ${core.limits.vertexAttributes - 1}`)
      if (fed.has(slot)) fail('invalid', `${aat}: slot ${slot} is fed by two attributes`)
      const format = choice(VERTEX_FORMAT_NAMES, ao.format, aat, 'the format')
      const offset = whole(ao.offset, aat, 'the offset')
      if (offset % 4 !== 0) fail('invalid', `${aat}: offset ${offset} is not a multiple of 4`)
      const end = offset + VERTEX_FORMATS[format].bytes
      if (end > room) fail('invalid', `${aat}: a ${format} at offset ${offset} ends at byte ${end}, past the ${room} bytes of ${stride === 0 ? 'the largest stride' : 'the stride'}`)
      fed.set(slot, format)
      reach = Math.max(reach, end)
      return Object.freeze({ slot, format, offset })
    })
    return Object.freeze({ stride, rate, attributes: Object.freeze(attrs), reach })
  })
  for (const p of lens.module.inputs) {
    const f = fed.get(p.slot)
    if (f === undefined) fail('mismatch', `${where}: ${lens.name} reads input slot ${p.slot}, which no attribute feeds`)
    if (VERTEX_FORMATS[f].type !== p.type) fail('mismatch', `${where}: input slot ${p.slot} of ${lens.name} is ${p.type}, but its attribute is ${f}, which gives ${VERTEX_FORMATS[f].type}`)
  }
  return Object.freeze(layouts)
}

function interStage(core: Core, vertex: LensImpl, fragment: LensImpl, where: string): void {
  const outs = vertex.module.outputs
  if (outs.length > core.limits.interStage) fail('limit', `${where}: ${vertex.name} passes ${outs.length} values to the fragment stage; the device allows ${core.limits.interStage}`)
  for (const p of fragment.module.inputs) {
    const o = outs.find((q) => q.slot === p.slot)
    if (o === undefined) fail('mismatch', `${where}: ${fragment.name} reads slot ${p.slot}, which ${vertex.name} does not write`)
    if (o.type !== p.type || (o.flat === true) !== (p.flat === true)) {
      fail('mismatch', `${where}: slot ${p.slot} is ${o.type}${o.flat === true ? ' flat' : ''} from ${vertex.name} but ${p.type}${p.flat === true ? ' flat' : ''} in ${fragment.name}`)
    }
  }
}

function blendPart(x: unknown, where: string, what: string): Required<BlendPart> {
  const o = record(x, ['src', 'dst', 'op'], where, what)
  const src = choice(BLEND_FACTORS, o.src, where, `the ${what} source factor`)
  const dst = choice(BLEND_FACTORS, o.dst, where, `the ${what} destination factor`)
  const op = choice(BLEND_OPS, o.op, where, `the ${what} operation`, 'add')
  if ((op === 'min' || op === 'max') && (src !== 'one' || dst !== 'one')) fail('invalid', `${where}: a ${op} ${what} takes the factor one on both sides, not ${src} and ${dst}`)
  return Object.freeze({ src, dst, op })
}

/** The scalar a shader writes into a format. */
function scalarFor(format: Format): 'f32' | 'u32' | 'i32' {
  const k = sampleKind(format)
  return k === 'uint' ? 'u32' : k === 'sint' ? 'i32' : 'f32'
}

function colorOutputs(core: Core, x: unknown, lens: LensImpl, where: string): readonly (ColorOutput | null)[] {
  const list = listOf(x, where, 'the colour outputs', (n) => {
    if (n > core.limits.colorAttachments) fail('limit', `${where}: ${n} colour outputs is more than the device allows, ${core.limits.colorAttachments}`)
  })
  const outputs = list.map((c, s): ColorOutput | null => {
    if (c === null) return null
    const at = `${where}: output ${s}`
    const o = record(c, ['format', 'blend', 'mask'], at, 'the colour output')
    const format = choice(FORMAT_NAMES, o.format, at, 'the format')
    const f = FORMATS[format]
    if (!f.color) fail('invalid', `${at}: ${format} cannot be a colour attachment`)
    const mask = o.mask === undefined ? 15 : whole(o.mask, at, 'the write mask')
    if (mask > 15) fail('invalid', `${at}: the write mask ${mask} has bits past the four channels (0 to 15)`)
    if (mask !== 0) {
      const port = lens.module.outputs.find((p) => p.slot === s)
      if (port === undefined) fail('mismatch', `${at}: the output writes ${format}, but ${lens.name} has no output at slot ${s}`)
      const want = scalarFor(format)
      if (scalarOf(port.type) !== want || widthOf(port.type) < f.channels) fail('mismatch', `${at}: ${format} takes ${want} values of at least ${f.channels} channel${f.channels === 1 ? '' : 's'}, and ${lens.name} writes ${port.type} at slot ${s}`)
    }
    if (o.blend === undefined) return Object.freeze({ format, mask })
    if (!f.blend) fail('invalid', `${at}: ${format} cannot be blended into`)
    const b = record(o.blend, ['color', 'alpha'], at, 'the blend')
    return Object.freeze({ format, mask, blend: Object.freeze({ color: blendPart(b.color, at, 'colour blend'), alpha: blendPart(b.alpha, at, 'alpha blend') }) })
  })
  const bytes = colorBytes(outputs.map((c) => (c === null ? null : c.format)))
  if (bytes > core.limits.colorBytes) fail('limit', `${where}: the colour outputs take ${bytes} bytes per sample, more than the device allows, ${core.limits.colorBytes}`)
  return Object.freeze(outputs)
}

function depthState(core: Core, x: unknown, where: string): DepthState | null {
  if (x === undefined) return null
  const o = record(x, ['format', 'write', 'compare', 'unclipped'], where, 'the depth state')
  const format = choice(FORMAT_NAMES, o.format, where, 'the depth format')
  if (!FORMATS[format].depth) fail('invalid', `${where}: ${format} is not a depth format`)
  const write = flag(o.write, where, 'depth write', false)
  const compare = choice(COMPARES, o.compare, where, 'the depth compare', 'always')
  const unclipped = flag(o.unclipped, where, 'unclipped', false)
  if (unclipped && !core.features.includes('depth-unclipped')) fail('feature', `${where}: unclipped depth needs the depth-unclipped feature, which the device was not opened with`)
  return Object.freeze({ format, write, compare, unclipped })
}

/** The bytes a binding must hold for a block: all of it, or a storage block's fixed part when its final array has no length. */
function minimumSize(block: Block, space: 'uniform' | 'storage'): number {
  const layout = layoutBlock(block, space)
  const last = block.fields[block.fields.length - 1].type
  return typeof last !== 'string' && 'array' in last && last.len === 0 ? layout.offsets[layout.offsets.length - 1] : layout.size
}

/** Every `sample` instruction of a body, nested ones included. */
function samples(body: readonly Inst[], out: { readonly image: number; readonly sampler: number }[]): void {
  for (const inst of body) {
    if (inst.op === 'sample') out.push({ image: inst.image, sampler: inst.sampler })
    else if (inst.op === 'if') {
      samples(inst.then, out)
      samples(inst.else, out)
    } else if (inst.op === 'loop') samples(inst.body, out)
  }
}

/** Checks a lens's resources against a pipeline layout and returns the bindings it reads. */
function resourceUses(core: Core, layout: PipelineLayoutImpl, lens: LensImpl, where: string): Use[] {
  const stage = lens.stage
  const uses: Use[] = []
  const entries = lens.module.resources.map((r, i) => {
    const at = `${where}: resource ${i} of ${lens.name} (${r.kind}${r.kind === 'constants' ? '' : ` at set ${r.set} binding ${r.binding}`})`
    if (r.kind === 'constants') {
      const size = layoutBlock(r.block, 'uniform').size
      const c = layout.constants
      if (c === null) fail('mismatch', `${at}: ${layout.name} has no inline constants`)
      if (size > c.size) fail('mismatch', `${at}: the block takes ${size} bytes, and ${layout.name} has ${c.size} bytes of constants`)
      if (!c.stages.includes(stage)) fail('mismatch', `${at}: the constants of ${layout.name} are not read by the ${stage} stage`)
      return null
    }
    if (r.set >= layout.sets.length) fail('mismatch', `${at}: ${layout.name} has ${layout.sets.length} set${layout.sets.length === 1 ? '' : 's'}`)
    const set: BindingLayoutImpl = layout.sets[r.set]
    const e = set.entries.find((x) => x.binding === r.binding)
    if (e === undefined) fail('mismatch', `${at}: ${set.name} has no binding ${r.binding}`)
    if (!e.stages.includes(stage)) fail('mismatch', `${at}: the entry does not list the ${stage} stage`)
    const kindRule = (ok: boolean, wants: string): void => {
      if (!ok) fail('mismatch', `${at}: the lens wants ${wants}, and the entry is ${e.kind}${e.kind === 'image' ? ` (${e.sample}, ${e.dims})` : e.kind === 'storage-image' ? ` (${String(e.format)})` : ''}`)
    }
    let minSize = 0
    switch (r.kind) {
      case 'uniform': {
        kindRule(e.kind === 'uniform', 'a uniform entry')
        minSize = minimumSize(r.block, 'uniform')
        if (minSize > core.limits.uniformRange) fail('limit', `${at}: the block takes ${minSize} bytes, more than a uniform binding may cover, ${core.limits.uniformRange}`)
        break
      }
      case 'storage': {
        kindRule(r.writable ? e.kind === 'storage' : e.kind === 'storage' || e.kind === 'storage-read', r.writable ? 'a storage entry (it writes)' : 'a storage or storage-read entry')
        minSize = minimumSize(r.block, 'storage')
        if (minSize > core.limits.storageRange) fail('limit', `${at}: the block takes ${minSize} bytes, more than a storage binding may cover, ${core.limits.storageRange}`)
        break
      }
      case 'image': kindRule(e.kind === 'image' && e.sample === r.sample && e.dims === r.dims, `an image entry (${r.sample}, ${r.dims})`); break
      case 'sampler': kindRule(e.kind === 'sampler', 'a sampler entry'); break
      case 'storage-image': kindRule(e.kind === 'storage-image' && e.format === r.format, `a storage-image entry (${r.format})`); break
    }
    uses.push({ set: r.set, binding: r.binding, minSize })
    return e
  })
  const pairs: { readonly image: number; readonly sampler: number }[] = []
  samples(lens.module.body, pairs)
  for (const p of pairs) {
    const img = entries[p.image]
    const smp = entries[p.sampler]
    if (img !== null && smp !== null && img.unfiltered === true && smp.filtering !== false) {
      fail('mismatch', `${where}: ${lens.name} samples resource ${p.image}, an unfiltered image, through resource ${p.sampler}, whose entry may filter; give that sampler entry filtering false`)
    }
  }
  return uses
}

export function createRenderPipeline(core: Core, info: unknown, where: string): RenderPipelineImpl {
  const o = record(info, ['layout', 'vertex', 'fragment', 'topology', 'cull', 'front', 'depth', 'samples', 'label'], where, 'the pipeline info')
  const layout = own(core, PipelineLayoutImpl, o.layout, where, 'the layout', 'PipelineLayout')
  const v = record(o.vertex, ['lens', 'buffers'], where, 'the vertex stage')
  const vertex = lensOf(core, v.lens, 'vertex', where)
  const buffers = vertexBuffers(core, v.buffers, vertex, where)
  let fragment: { readonly lens: LensImpl; readonly outputs: readonly (ColorOutput | null)[] } | null = null
  if (o.fragment !== undefined) {
    const f = record(o.fragment, ['lens', 'outputs'], where, 'the fragment stage')
    const lens = lensOf(core, f.lens, 'fragment', where)
    interStage(core, vertex, lens, where)
    fragment = Object.freeze({ lens, outputs: colorOutputs(core, f.outputs, lens, where) })
  }
  const topology = choice(TOPOLOGIES, o.topology, where, 'the topology', 'triangles')
  const cull = choice(['none', 'front', 'back'] as const, o.cull, where, 'the cull mode', 'none')
  const front = choice(['ccw', 'cw'] as const, o.front, where, 'the front winding', 'ccw')
  const samples = o.samples === undefined ? 1 : o.samples
  if (samples !== 1 && samples !== 4) fail('invalid', `${where}: the sample count ${String(samples)} is not 1 or 4`)
  const depth = depthState(core, o.depth, where)
  const uses = [...resourceUses(core, layout, vertex, where), ...(fragment === null ? [] : resourceUses(core, layout, fragment.lens, where))]
  const label = labelOf(o.label, where)
  const normal: RenderPipelineInfo = Object.freeze({
    layout,
    vertex: Object.freeze({ lens: vertex, buffers: buffers.map((b) => Object.freeze({ stride: b.stride, rate: b.rate, attributes: b.attributes })) }),
    ...(fragment === null ? {} : { fragment }),
    topology,
    cull,
    front,
    ...(depth === null ? {} : { depth }),
    samples,
    label,
  })
  core.enter(where)
  const handle = core.call(where, () => core.backend.createRenderPipeline(normal, layout.handle, vertex.handle, fragment === null ? null : fragment.lens.handle))
  return new RenderPipelineImpl(core, normal, layout, buffers, Object.freeze(uses), handle)
}

export function createComputePipeline(core: Core, info: unknown, where: string): ComputePipelineImpl {
  const o = record(info, ['layout', 'lens', 'label'], where, 'the pipeline info')
  const layout = own(core, PipelineLayoutImpl, o.layout, where, 'the layout', 'PipelineLayout')
  const lens = lensOf(core, o.lens, 'compute', where)
  const group = lens.module.group
  const limit = core.limits.groupSize
  for (let i = 0; i < 3; i++) {
    if (group[i] > limit[i]) fail('limit', `${where}: ${lens.name} has a workgroup ${group[i]} wide along ${'xyz'[i]}; the device allows ${limit[i]}`)
  }
  const n = group[0] * group[1] * group[2]
  if (n > core.limits.groupInvocations) fail('limit', `${where}: ${lens.name} has ${n} invocations per workgroup; the device allows ${core.limits.groupInvocations}`)
  const uses = resourceUses(core, layout, lens, where)
  const label = labelOf(o.label, where)
  core.enter(where)
  const handle = core.call(where, () => core.backend.createComputePipeline(layout.handle, lens.handle))
  return new ComputePipelineImpl(core, layout, lens, label, Object.freeze(uses), handle)
}
