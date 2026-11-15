// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It records work. A command arena hands out command lists; a list runs through the states
 * of api.ts (initial, recording, ready, pending, invalid), and every command is checked as it is recorded against
 * the list's state and what is bound: inside or outside a pass, the bound pipeline and the sets its lenses read, the
 * vertex and index buffers a draw reads and how far, the attachments a pipeline must match, the regions a copy
 * covers, the contents of a barrier. Each command is recorded twice: as the back end's Command, with back end
 * handles, and as a Recorded entry that names the core objects it touches and how, which the ordering checker reads
 * to find hazards and wrong layouts. A list also keeps every object it used, with the version it saw, so it knows it
 * is invalid once one of them is destroyed or a binding set it used is written again.
 * What breaks if it is removed? Nothing could be drawn, dispatched or copied, and a draw outside a pass, past the end
 * of a vertex buffer or with the wrong sets bound would reach a back end that trusts what it is given.
 *
 * THE RECORD. `list.records` holds one Recorded entry for each command that touches memory, in order; `at` is the
 * position of the matching back end command in `list.commands`. State-setting commands (pipeline, sets, vertex and
 * index buffers, viewport, scissor, blend constant, constants, groups) leave no entry of their own: each draw and
 * dispatch entry carries a snapshot of the state it ran with.
 * - `pass`: each colour attachment's view, load and store ops and resolve view, the depth attachment's view, ops and
 *   read-only flag, the pass's size and sample count. `end-pass` closes it.
 * - `draw`: the render pipeline; every set bound at an index of its layout that the layout's set there accepts, each
 *   with every binding it held when bound (dynamic offsets already added) and the binding's layout entry, which says
 *   its kind and stages; the vertex buffers of the pipeline's buffer slots with their offsets; the index buffer of an
 *   indexed draw; the indirect buffer and the bytes it reads for an indirect draw.
 * - `dispatch`: the compute pipeline, its sets as for a draw, and the indirect buffer of an indirect dispatch.
 * - `copy-buffer`, `copy-buffer-image`, `copy-image-buffer`, `copy-image`: source, destination and the regions with
 *   every default filled in. `update` and `zero`: the buffer and the byte range written.
 * - `barrier`: every memory, buffer and image barrier with every default filled in (access lists, ranges).
 *
 * Rules beyond the field-by-field ones (all pinned by commands.test.ts):
 * - A list begins only from `initial`; `reset()` needs a resettable arena and a list that is not pending.
 * - Binding state is cleared at beginPass and at endPass. A render pipeline, vertex and index buffers, the viewport,
 *   scissor and blend constant bind inside a pass; a compute pipeline outside one; sets and constants either side.
 * - A pass has at least one attachment; each is one level of one layer, attached once in the pass; all have one
 *   size and one sample count. A resolve view belongs to a four-sample colour attachment and is one-sample, of the
 *   same format and size, with color use, of a format that is not an integer one. A read-only depth attachment is
 *   loaded and stored with `keep`.
 * - A render pipeline binds only to a pass whose colour formats (slot by slot, an empty slot matching an empty one),
 *   depth format and sample count are its own, and one that writes depth never to a read-only depth attachment.
 * - A set binds at index i of a layout only when it was made from a binding layout compatible with the layout's set
 *   i, every binding of it is written and still alive. Offsets follow the dynamic bindings set by set, binding by
 *   binding.
 * - The usage scope (see Scope): within one pass, or one dispatch, a buffer or one level of one layer of an image is
 *   only read, or only written one way (storage, or attachment; a read-only depth attachment counts as one).
 * - A draw or dispatch needs a set bound, and compatible, at every index its lenses read, each buffer binding at
 *   least as large as the block read through it, and (for a draw) a vertex buffer at every buffer slot of the
 *   pipeline. Vertex-rate buffers are checked against the vertex range of a draw, instance-rate ones against the
 *   instance range of any draw; an indexed draw's index range is checked against the index buffer.
 * - Copies: buffer offsets and sizes are multiples of 4; a buffer's offset in an image copy is a multiple of the
 *   texel's bytes (and of 4 for a depth image), its rowBytes covers one row and (with more than one row) is a multiple of `limits.copyRowAlign`.
 *   Regions stay inside their resources and never overlap a region the same copy writes, nor (within one buffer or
 *   one image subresource) the region it reads. Four-sample images are never copied. Depth images are copied only
 *   into a buffer.
 * - A barrier holds at least one barrier; an image barrier never moves into `blank`, and two image barriers of one
 *   command never cover the same subresource.
 * - Groups nest: one begun inside a pass ends inside it, one begun outside ends outside, and end() needs none open.
 * - Commands that need a queue ability check the arena's group: a pass needs graphics, a compute pipeline compute,
 *   a copy, update or zero any of copy, graphics and compute.
 */
import type {
  Access, BarrierInfo, BindingEntry, BindingSet, Buffer, BufferCopy, BufferImageCopy, BufferUse, Command, CommandArena, CommandList,
  CommandListState, ComputePipeline, Image, ImageCopy, ImageLayout, ImageUse, LoadOp, PassInfo, PipeStage, PipelineLayout, Range,
  Rect, RenderPipeline, Sampler, StoreOp, View, Viewport,
} from './api.ts'
import { BindingSetImpl, PipelineLayoutImpl, compatible, heldBy } from './bindings.ts'
import { fail } from './fault.ts'
import { FORMATS } from './formats.ts'
import type { Format } from './formats.ts'
import type { MemoryImpl } from './memory.ts'
import { ComputePipelineImpl, RenderPipelineImpl } from './pipelines.ts'
import { BufferImpl, ImageImpl, ViewImpl } from './resources.ts'
import { Base, choice, every, finite, flag, guard, labelOf, listOf, names, own, record, span, whole, word } from './sync.ts'
import type { Core } from './sync.ts'
import { say } from './verify.ts'

export const LOAD_OPS = every<LoadOp>({ keep: true, clear: true, any: true })
export const STORE_OPS = every<StoreOp>({ keep: true, any: true })
export const PIPE_STAGES = every<PipeStage>({ top: true, indirect: true, 'vertex-input': true, vertex: true, fragment: true, depth: true, color: true, compute: true, copy: true, host: true, bottom: true, all: true })
export const ACCESSES = every<Access>({
  'indirect-read': true, 'index-read': true, 'vertex-read': true, 'uniform-read': true, 'shader-read': true, 'shader-write': true, 'color-read': true,
  'color-write': true, 'depth-read': true, 'depth-write': true, 'copy-read': true, 'copy-write': true, 'host-read': true, 'host-write': true, 'any-read': true, 'any-write': true,
})
export const IMAGE_LAYOUTS = every<ImageLayout>({ blank: true, general: true, color: true, depth: true, 'depth-read': true, 'shader-read': true, 'copy-src': true, 'copy-dst': true, present: true })

// ---------------------------------------------------------------------------------------------------
// The record (see the head of the file)

/** A rectangle of one level of one layer, every field filled in. */
export interface Region {
  readonly level: number
  readonly layer: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}
/** One region of a copy between a buffer and an image. */
export interface Rows {
  readonly offset: number
  readonly rowBytes: number
  readonly region: Region
}
/** One region of a copy between images: the source rectangle, and where its corner lands. */
export interface Placed {
  readonly from: Region
  readonly to: { readonly level: number; readonly layer: number; readonly x: number; readonly y: number }
}
export interface FullScope {
  readonly stages: readonly PipeStage[]
  readonly access: readonly Access[]
}
export interface FullMemoryBarrier {
  readonly before: FullScope
  readonly after: FullScope
}
export interface FullBufferBarrier extends FullMemoryBarrier {
  readonly buffer: Buffer
  readonly offset: number
  readonly size: number
}
export interface FullImageBarrier extends FullMemoryBarrier {
  readonly image: Image
  readonly from: ImageLayout
  readonly to: ImageLayout
  readonly levels: Range
  readonly layers: Range
}
export interface ColorUse {
  readonly view: View
  readonly load: LoadOp
  readonly store: StoreOp
  readonly resolve: View | null
}
export interface DepthUse {
  readonly view: View
  readonly load: LoadOp
  readonly store: StoreOp
  readonly readOnly: boolean
}
/** One binding of a bound set as a draw or dispatch saw it: its layout entry and what it held (dynamic offset added). */
export type BoundBinding =
  | { readonly entry: BindingEntry; readonly buffer: Buffer; readonly offset: number; readonly size: number }
  | { readonly entry: BindingEntry; readonly view: View }
  | { readonly entry: BindingEntry; readonly sampler: Sampler }
export interface BoundSet {
  readonly index: number
  readonly set: BindingSet
  readonly bindings: readonly BoundBinding[]
}
export interface VertexUse {
  readonly slot: number
  readonly buffer: Buffer
  readonly offset: number
}
export interface IndexUse {
  readonly buffer: Buffer
  readonly offset: number
  readonly type: 'u16' | 'u32'
}
export interface IndirectUse {
  readonly buffer: Buffer
  readonly offset: number
  readonly size: number
}

export type Recorded =
  | { readonly r: 'pass'; readonly at: number; readonly label: string; readonly colors: readonly (ColorUse | null)[]; readonly depth: DepthUse | null; readonly width: number; readonly height: number; readonly samples: 1 | 4 }
  | { readonly r: 'end-pass'; readonly at: number }
  | { readonly r: 'draw'; readonly at: number; readonly pipeline: RenderPipeline; readonly sets: readonly BoundSet[]; readonly vertices: readonly VertexUse[]; readonly indices: IndexUse | null; readonly indirect: IndirectUse | null }
  | { readonly r: 'dispatch'; readonly at: number; readonly pipeline: ComputePipeline; readonly sets: readonly BoundSet[]; readonly indirect: IndirectUse | null }
  | { readonly r: 'copy-buffer'; readonly at: number; readonly src: Buffer; readonly dst: Buffer; readonly regions: readonly BufferCopy[] }
  | { readonly r: 'copy-buffer-image'; readonly at: number; readonly src: Buffer; readonly dst: Image; readonly regions: readonly Rows[] }
  | { readonly r: 'copy-image-buffer'; readonly at: number; readonly src: Image; readonly dst: Buffer; readonly regions: readonly Rows[] }
  | { readonly r: 'copy-image'; readonly at: number; readonly src: Image; readonly dst: Image; readonly regions: readonly Placed[] }
  | { readonly r: 'update'; readonly at: number; readonly dst: Buffer; readonly offset: number; readonly size: number }
  | { readonly r: 'zero'; readonly at: number; readonly dst: Buffer; readonly offset: number; readonly size: number }
  | { readonly r: 'barrier'; readonly at: number; readonly memory: readonly FullMemoryBarrier[]; readonly buffers: readonly FullBufferBarrier[]; readonly images: readonly FullImageBarrier[] }

// ---------------------------------------------------------------------------------------------------
// Arenas

export class CommandArenaImpl extends Base implements CommandArena {
  readonly group: number
  readonly resettable: boolean
  /** The live lists it handed out. */
  readonly lists = new Set<CommandListImpl>()

  constructor(core: Core, group: number, resettable: boolean, label: string) {
    super(core, 'command arena', label)
    this.group = group
    this.resettable = resettable
  }

  allocate(label?: string): CommandList {
    const where = `${this.name} allocate`
    return guard(this.core.report, where, () => {
      this.alive(where)
      const list = new CommandListImpl(this.core, this, labelOf(label, where))
      this.lists.add(list)
      return list
    })
  }

  reset(): void {
    const where = `${this.name} reset`
    guard(this.core.report, where, () => {
      this.alive(where)
      for (const l of this.lists) if (l.state === 'pending') fail('state', `${where}: ${l.name} is pending; reset the arena once its work is done`)
      for (const l of this.lists) if (l.held) fail('state', `${where}: ${l.name} is in the middle of a call; reset the arena after it returns`)
      for (const l of this.lists) l.clear()
    })
  }

  protected override check(where: string): void {
    for (const l of this.lists) if (l.held) fail('state', `${where}: ${l.name} is in the middle of a call; destroy the arena after it returns`)
    if (!this.core.checks) return
    for (const l of this.lists) if (l.state === 'pending') fail('lifetime', `${where}: queued work still runs ${l.name}; wait for its fence first`)
  }

  override drop(): void {
    for (const l of this.lists) {
      l.drop()
      l.retire()
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Lists

interface PassState {
  readonly width: number
  readonly height: number
  readonly samples: 1 | 4
  readonly colors: readonly (Format | null)[]
  readonly depth: Format | null
  readonly readOnly: boolean
}

interface BindState {
  pipeline: RenderPipelineImpl | ComputePipelineImpl | null
  readonly sets: (BoundSet & { readonly set: BindingSetImpl })[]
  readonly vertices: { readonly buffer: BufferImpl; readonly offset: number }[]
  indices: { readonly buffer: BufferImpl; readonly offset: number; readonly type: 'u16' | 'u32' } | null
}

const freshBinding = (): BindState => ({ pipeline: null, sets: [], vertices: [], indices: null })

/** Half-open ranges [a0, a1) and [b0, b1) share a point. */
const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1

/**
 * Two buffer layouts of image rows that share a byte. Rows are checked one by one (only when the whole spans meet), so
 * regions whose rows interleave in the gaps between each other's rows are apart.
 */
function rowsOverlap(a: Rows, b: Rows, texel: number): boolean {
  const wa = a.region.width * texel
  const wb = b.region.width * texel
  const endA = a.offset + a.rowBytes * (a.region.height - 1) + wa
  const endB = b.offset + b.rowBytes * (b.region.height - 1) + wb
  if (!overlaps(a.offset, endA, b.offset, endB)) return false
  const [p, q, wp, wq] = a.region.height <= b.region.height ? [a, b, wa, wb] : [b, a, wb, wa]
  for (let r = 0; r < p.region.height; r++) {
    const x0 = p.offset + r * p.rowBytes
    const x1 = x0 + wp
    // The rows k of q that start before x1 and end after x0: q.offset + k q.rowBytes < x1 and that + wq > x0.
    const lo = Math.max(0, Math.floor((x0 - wq - q.offset) / q.rowBytes) + 1)
    const hi = Math.min(q.region.height - 1, Math.ceil((x1 - q.offset) / q.rowBytes) - 1)
    if (lo <= hi) return true
  }
  return false
}

function rectsOverlap(a: Region, b: Region): boolean {
  return a.level === b.level && a.layer === b.layer && overlaps(a.x, a.x + a.width, b.x, b.x + b.width) && overlaps(a.y, a.y + a.height, b.y, b.y + b.height)
}

function rangesOverlap(a: Range, b: Range): boolean {
  return overlaps(a.base, a.base + a.count, b.base, b.base + b.count)
}

const INDIRECT_BYTES = { draw: 16, indexed: 20, dispatch: 12 } as const

/** How a pass or a dispatch uses a buffer, or one level of one layer of an image. */
interface Use {
  readonly resource: BufferImpl | ImageImpl
  readonly level: number
  readonly layer: number
  readonly kind: 'read' | 'storage' | 'attachment'
  /** The use in words, as a refusal says it ("written as storage through binding 0 of set 1"). */
  readonly how: string
}

interface UseRecord {
  read: string | null
  write: { readonly kind: 'storage' | 'attachment'; readonly how: string } | null
}

/**
 * The usage scope: what one pass (all its attachments and all its draws) or one dispatch uses, and how. Within it a
 * buffer, or one level of one layer of an image, is only read, or only written one way (as storage, or as an
 * attachment): the uses inside one scope run in no order a barrier could set, so a write beside any other use races.
 * Buffers count whole, whatever range a binding holds.
 */
class Scope {
  private readonly recs = new Map<BufferImpl | ImageImpl, Map<number, UseRecord>>()

  /** Refuses the uses when one conflicts with the scope or with another of them; adds them all when none does. */
  take(uses: readonly Use[], where: string, unit: string): void {
    const next = new Map<BufferImpl | ImageImpl, Map<number, UseRecord>>()
    for (const u of uses) {
      const sub = u.level * 0x10000 + u.layer
      let m = next.get(u.resource)
      if (m === undefined) {
        m = new Map()
        next.set(u.resource, m)
      }
      let r = m.get(sub)
      if (r === undefined) {
        const old = this.recs.get(u.resource)?.get(sub)
        r = { read: old?.read ?? null, write: old?.write ?? null }
        m.set(sub, r)
      }
      const name = u.resource instanceof BufferImpl ? u.resource.name : `level ${u.level} layer ${u.layer} of ${u.resource.name}`
      const clash = (first: string): never => fail('invalid', `${where}: ${name} is ${first} and ${u.how} in one ${unit}; a resource there is only read, or written one way`)
      if (u.kind === 'read') {
        if (r.write !== null) clash(r.write.how)
        r.read ??= u.how
      } else {
        if (r.read !== null) clash(r.read)
        if (r.write !== null && r.write.kind !== u.kind) clash(r.write.how)
        r.write ??= { kind: u.kind, how: u.how }
      }
    }
    for (const [resource, m] of next) {
      let into = this.recs.get(resource)
      if (into === undefined) {
        into = new Map()
        this.recs.set(resource, into)
      }
      for (const [sub, r] of m) into.set(sub, r)
    }
  }
}

/** Every level and layer a view covers, used one way. */
function viewUses(v: ViewImpl, kind: Use['kind'], how: string): Use[] {
  const out: Use[] = []
  for (let level = v.levels.base; level < v.levels.base + v.levels.count; level++) {
    for (let layer = v.layers.base; layer < v.layers.base + v.layers.count; layer++) out.push({ resource: v.image, level, layer, kind, how })
  }
  return out
}

/** What the bindings of the sets a draw or dispatch sees use. */
function bindingUses(sets: readonly BoundSet[]): Use[] {
  const out: Use[] = []
  for (const s of sets) {
    for (const b of s.bindings) {
      const through = `through binding ${b.entry.binding} of set ${s.index}`
      if ('buffer' in b) {
        const resource = b.buffer as BufferImpl
        if (b.entry.kind === 'storage') out.push({ resource, level: 0, layer: 0, kind: 'storage', how: `written as storage ${through}` })
        else out.push({ resource, level: 0, layer: 0, kind: 'read', how: `read as ${b.entry.kind === 'uniform' ? 'a uniform block' : 'read-only storage'} ${through}` })
      } else if ('view' in b) {
        const v = b.view as ViewImpl
        if (b.entry.kind === 'storage-image') out.push(...viewUses(v, 'storage', `written as a storage image ${through}`))
        else out.push(...viewUses(v, 'read', `sampled ${through}`))
      }
    }
  }
  return out
}

export class CommandListImpl extends Base implements CommandList {
  readonly arena: CommandArenaImpl
  private st: CommandListState = 'initial'
  private once = false
  private cmds: Command[] = []
  private recs: Recorded[] = []
  private deps = new Map<Base, number>()
  private writes = new Set<MemoryImpl>()
  /** What the command being recorded touches and writes, kept only once the whole command is accepted. */
  private staged: Base[] = []
  private stagedWrites: MemoryImpl[] = []
  /** Set while a call on the list runs, so a getter of its arguments cannot call into the list (see exclusive). */
  private busy = false
  private pass: PassState | null = null
  /** The open pass's usage scope (see Scope). */
  private scope = new Scope()
  private bound: BindState = freshBinding()
  /** Open groups, each true when it was begun inside a pass. */
  private groups: boolean[] = []

  constructor(core: Core, arena: CommandArenaImpl, label: string) {
    super(core, 'command list', label)
    this.arena = arena
  }

  /** `ready` reads `invalid` once an object the list recorded was destroyed or a set it recorded was written. */
  get state(): CommandListState {
    return this.st === 'ready' && this.stale() !== null ? 'invalid' : this.st
  }

  /** The back end's commands, in order. */
  get commands(): readonly Command[] {
    return this.cmds
  }

  /** The record of what each command touches (see the head of the file). */
  get records(): readonly Recorded[] {
    return this.recs
  }

  /** Every object the recorded commands use, with the version each had when first used. */
  get uses(): ReadonlyMap<Base, number> {
    return this.deps
  }

  /** The memory a run of the list may write into. */
  get written(): ReadonlySet<MemoryImpl> {
    return this.writes
  }

  /** Why the list cannot run: an object it recorded was destroyed (`lifetime`) or changed (`state`); null when it can. */
  stale(): { readonly code: 'lifetime' | 'state'; readonly message: string } | null {
    for (const [x, v] of this.deps) {
      if (x.destroyed) return { code: 'lifetime', message: `${x.name}, which ${this.name} recorded, is destroyed; record the list again` }
      if (x.version !== v) return { code: 'state', message: `${x.name} was written after ${this.name} recorded it; record the list again` }
    }
    return null
  }

  /** The queue marks the list pending and every object it uses held. */
  hold(): void {
    this.st = 'pending'
    this.pending++
    for (const x of this.deps.keys()) x.pending++
    for (const m of this.writes) m.writers++
  }

  /** The queue lets the list go: ready again, or invalid when a `once` list has run (`ran`). */
  release(ran: boolean): void {
    this.pending--
    for (const x of this.deps.keys()) x.pending--
    for (const m of this.writes) m.writers--
    this.st = ran && this.once ? 'invalid' : 'ready'
  }

  override drop(): void {
    this.arena.lists.delete(this)
  }

  /** Back to `initial`, holding nothing. */
  clear(): void {
    this.st = 'initial'
    this.once = false
    this.cmds = []
    this.recs = []
    this.deps = new Map()
    this.writes = new Set()
    this.pass = null
    this.bound = freshBinding()
    this.groups = []
  }

  begin(info?: { readonly once?: boolean }): void {
    const where = `${this.name} begin`
    guard(this.core.report, where, () => {
      this.exclusive(where, () => {
        this.alive(where)
        if (this.st !== 'initial') fail('state', `${where}: the list is ${this.state}; begin() takes an initial list (reset it first)`)
        const o = record(info, ['once'], where, 'the begin info', true)
        const once = flag(o.once, where, 'once', false)
        this.clear()
        this.once = once
        this.st = 'recording'
      })
    })
  }

  end(): void {
    this.rec('end', (where) => {
      if (this.pass !== null) fail('state', `${where}: a pass is still open; end it first`)
      if (this.groups.length > 0) fail('state', `${where}: ${this.groups.length} group${this.groups.length === 1 ? ' is' : 's are'} still open`)
      this.st = 'ready'
      Object.freeze(this.cmds)
      Object.freeze(this.recs)
    })
  }

  reset(): void {
    const where = `${this.name} reset`
    guard(this.core.report, where, () => {
      this.exclusive(where, () => {
        this.alive(where)
        if (!this.arena.resettable) fail('state', `${where}: ${this.arena.name} resets its lists only all together`)
        if (this.st === 'pending') fail('state', `${where}: the list is pending; reset it once its work is done`)
        this.clear()
      })
    })
  }

  // -------------------------------------------------------------------------------------------------
  // Passes and state

  beginPass(info: PassInfo): void {
    this.rec('beginPass', (where) => {
      if (this.pass !== null) fail('state', `${where}: a pass is already open; end it first`)
      this.able('graphics', where)
      const o = record(info, ['colors', 'depth', 'label'], where, 'the pass info')
      const list = listOf(o.colors, where, 'the colour attachments')
      if (list.length > this.core.limits.colorAttachments) fail('limit', `${where}: ${list.length} colour attachments is more than the device allows, ${this.core.limits.colorAttachments}`)
      const claimed: ViewImpl[] = []
      /** The first attachment's size and sample count, which every other one must share. */
      const fit: { first: ViewImpl | null } = { first: null }
      const take = (v: ViewImpl, at: string, sized: boolean): void => {
        const twice = claimed.find((c) => c.image === v.image && c.levels.base === v.levels.base && c.layers.base === v.layers.base)
        if (twice !== undefined) fail('invalid', `${at}: level ${v.levels.base} layer ${v.layers.base} of ${v.image.name} is attached twice in the pass`)
        claimed.push(v)
        if (!sized) return
        const f = fit.first
        if (f === null) fit.first = v
        else if (f.width !== v.width || f.height !== v.height) fail('mismatch', `${at}: ${v.name} is ${v.width} x ${v.height}, and ${f.name} is ${f.width} x ${f.height}; the attachments of a pass are one size`)
        else if (f.image.samples !== v.image.samples) fail('mismatch', `${at}: ${v.name} has ${v.image.samples} samples, and ${f.name} has ${f.image.samples}; the attachments of a pass have one sample count`)
      }
      const clears: (readonly [number, number, number, number] | null)[] = []
      const colors = list.map((c, i): ColorUse | null => {
        clears.push(null)
        if (c === null) return null
        const at = `${where}: colors[${i}]`
        const co = record(c, ['view', 'load', 'store', 'clear', 'resolve'], at, 'the colour attachment')
        const view = this.attachment(co.view, 'color', at, 'the view')
        const load = choice(LOAD_OPS, co.load, at, 'the load op')
        const store = choice(STORE_OPS, co.store, at, 'the store op')
        clears[i] = rgba(co.clear, at, 'the clear colour')
        take(view, at, true)
        if (co.resolve === undefined) return Object.freeze({ view, load, store, resolve: null })
        if (view.image.samples !== 4) fail('invalid', `${at}: only a four-sample attachment is resolved, and ${view.image.name} has one sample`)
        const resolve = this.attachment(co.resolve, 'color', at, 'the resolve view')
        const img = resolve.image
        if (img.samples !== 1) fail('mismatch', `${at}: the resolve view ${resolve.name} has ${img.samples} samples; it has one`)
        if (img.format !== view.image.format) fail('mismatch', `${at}: the resolve view is ${img.format}, and the attachment is ${view.image.format}`)
        if (resolve.width !== view.width || resolve.height !== view.height) fail('mismatch', `${at}: the resolve view is ${resolve.width} x ${resolve.height}, and the attachment is ${view.width} x ${view.height}`)
        take(resolve, `${at} resolve`, false)
        return Object.freeze({ view, load, store, resolve })
      })
      let depth: (DepthUse & { readonly view: ViewImpl; readonly clear: number }) | null = null
      if (o.depth !== undefined) {
        const at = `${where}: depth`
        const d = record(o.depth, ['view', 'load', 'store', 'clear', 'readOnly'], at, 'the depth attachment')
        const view = this.attachment(d.view, 'depth', at, 'the view')
        const load = choice(LOAD_OPS, d.load, at, 'the load op')
        const store = choice(STORE_OPS, d.store, at, 'the store op')
        const clear = d.clear === undefined ? 1 : finite(d.clear, at, 'the clear depth')
        if (clear < 0 || clear > 1) fail('invalid', `${at}: the clear depth ${clear} is outside 0 to 1`)
        const readOnly = flag(d.readOnly, at, 'readOnly', false)
        if (readOnly && (load !== 'keep' || store !== 'keep')) fail('invalid', `${at}: a read-only depth attachment is loaded and stored with keep, not ${load} and ${store}`)
        take(view, at, true)
        depth = { view, load, store, readOnly, clear }
      }
      const label = labelOf(o.label, where)
      const first = fit.first
      if (first === null) fail('invalid', `${where}: a pass has at least one attachment`)
      const { width, height } = first
      const samples = first.image.samples
      for (const v of claimed) this.wrote(v.image)
      const scope = new Scope()
      const attached: Use[] = claimed.map((v) => {
        // A read-only depth attachment counts as an attachment too (the stricter rule; see docs/nightglass.md).
        const readOnly = depth !== null && depth.readOnly && v === depth.view
        return { resource: v.image, level: v.levels.base, layer: v.layers.base, kind: 'attachment', how: readOnly ? 'attached as read-only depth' : 'drawn into as an attachment' }
      })
      scope.take(attached, where, 'pass')
      const at = this.emit({
        c: 'pass',
        colors: colors.map((c, i) => (c === null ? null : { view: (c.view as ViewImpl).handle, load: c.load, store: c.store, clear: clears[i] ?? [0, 0, 0, 0], resolve: c.resolve === null ? null : (c.resolve as ViewImpl).handle })),
        depth: depth === null ? null : { view: depth.view.handle, load: depth.load, store: depth.store, clear: depth.clear, readOnly: depth.readOnly },
        width,
        height,
      })
      const depthUse = depth === null ? null : Object.freeze({ view: depth.view, load: depth.load, store: depth.store, readOnly: depth.readOnly })
      this.note({ r: 'pass', at, label, colors: Object.freeze(colors), depth: depthUse, width, height, samples })
      this.pass = Object.freeze({
        width,
        height,
        samples,
        colors: colors.map((c) => (c === null ? null : c.view.image.format)),
        depth: depth === null ? null : depth.view.image.format,
        readOnly: depth !== null && depth.readOnly,
      })
      this.scope = scope
      this.bound = freshBinding()
    })
  }

  endPass(): void {
    this.rec('endPass', (where) => {
      this.inPass(where)
      if (this.groups.length > 0 && this.groups[this.groups.length - 1]) fail('state', `${where}: a group begun inside the pass is still open`)
      const at = this.emit({ c: 'end-pass' })
      this.note({ r: 'end-pass', at })
      this.pass = null
      this.scope = new Scope()
      this.bound = freshBinding()
    })
  }

  bindPipeline(pipeline: RenderPipeline | ComputePipeline): void {
    this.rec('bindPipeline', (where) => {
      if (pipeline instanceof RenderPipelineImpl) {
        own(this.core, RenderPipelineImpl, pipeline, where, 'the pipeline', 'RenderPipeline')
        const pass = this.pass
        if (pass === null) fail('state', `${where}: a render pipeline binds inside a pass`)
        const p = pipeline
        const n = Math.max(p.colors.length, pass.colors.length)
        for (let i = 0; i < n; i++) {
          const a = p.colors[i] ?? null
          const b = pass.colors[i] ?? null
          if (a !== b) fail('mismatch', `${where}: colour slot ${i}: ${p.name} writes ${a ?? 'nothing'}, and the pass holds ${b ?? 'nothing'}`)
        }
        if (p.depth !== pass.depth) fail('mismatch', `${where}: ${p.name} has ${p.depth ?? 'no'} depth, and the pass has ${pass.depth ?? 'no'} depth attachment`)
        if (p.samples !== pass.samples) fail('mismatch', `${where}: ${p.name} draws ${p.samples} samples, and the pass's attachments have ${pass.samples}`)
        if (p.writesDepth && pass.readOnly) fail('mismatch', `${where}: ${p.name} writes depth, and the pass's depth attachment is read-only`)
      } else if (pipeline instanceof ComputePipelineImpl) {
        own(this.core, ComputePipelineImpl, pipeline, where, 'the pipeline', 'ComputePipeline')
        this.outside(where)
        this.able('compute', where)
      } else {
        fail('invalid', `${where}: the pipeline is a RenderPipeline or a ComputePipeline, not ${say(pipeline)}`)
      }
      this.touch(pipeline)
      this.bound.pipeline = pipeline
      this.emit({ c: 'pipeline', pipeline: pipeline.handle, compute: pipeline instanceof ComputePipelineImpl })
    })
  }

  bindSets(layout: PipelineLayout, first: number, sets: readonly BindingSet[], offsets?: readonly number[]): void {
    this.rec('bindSets', (where) => {
      const l = own(this.core, PipelineLayoutImpl, layout, where, 'the layout', 'PipelineLayout')
      const start = whole(first, where, 'the first set')
      const list = listOf(sets, where, 'the sets')
      if (list.length === 0) fail('invalid', `${where}: the sets are empty`)
      if (start + list.length > l.sets.length) fail('invalid', `${where}: sets ${start} to ${start + list.length - 1} run past the ${l.sets.length} set${l.sets.length === 1 ? '' : 's'} of ${l.name}`)
      const chosen = list.map((s, i) => {
        const at = `${where}: sets[${i}]`
        const set = own(this.core, BindingSetImpl, s, at, 'the set', 'BindingSet')
        const want = l.sets[start + i]
        if (!compatible(set.layout, want)) fail('mismatch', `${at}: ${set.name} was made from ${set.layout.name}, which does not match ${want.name}, set ${start + i} of ${l.name}`)
        const why = set.unusable()
        if (why !== null) fail(set.complete ? 'lifetime' : 'state', `${at}: ${why}`)
        return set
      })
      const offs = offsets === undefined ? [] : listOf(offsets, where, 'the dynamic offsets').map((x, k) => whole(x, where, `dynamic offset ${k}`))
      const dynamic = chosen.reduce((n, s) => n + s.layout.dynamic.length, 0)
      if (offs.length !== dynamic) fail('invalid', `${where}: the sets hold ${dynamic} dynamic binding${dynamic === 1 ? '' : 's'}, and ${offs.length} offset${offs.length === 1 ? ' was' : 's were'} given`)
      const align = this.core.limits.offsetAlign
      let k = 0
      const snaps = chosen.map((set, i) => {
        const bindings = set.bindings.map((b): BoundBinding => {
          if (!('buffer' in b)) return b
          if (b.entry.dynamic !== true) return b
          const extra = offs[k]
          k++
          if (extra % align !== 0) fail('invalid', `${where}: dynamic offset ${extra} is not a multiple of ${align}`)
          const end = b.offset + extra + b.size
          if (end > b.buffer.size) fail('invalid', `${where}: dynamic offset ${extra} puts binding ${b.entry.binding} of ${set.name} at bytes ${b.offset + extra} to ${end - 1}, past the end of ${b.buffer.name} (${b.buffer.size} bytes)`)
          return Object.freeze({ entry: b.entry, buffer: b.buffer, offset: b.offset + extra, size: b.size })
        })
        return Object.freeze({ index: start + i, set, bindings: Object.freeze(bindings) })
      })
      for (const s of snaps) {
        this.touch(s.set)
        for (const b of s.set.bindings) {
          const held = heldBy(b)
          this.touch(held)
          if (b.entry.kind === 'storage' && held instanceof BufferImpl) this.wrote(held)
          if (b.entry.kind === 'storage-image' && held instanceof ViewImpl) this.wrote(held.image)
        }
        this.bound.sets[s.index] = s
      }
      this.emit({ c: 'sets', first: start, sets: chosen.map((s) => s.handle), offsets: Object.freeze(offs) })
    })
  }

  bindVertices(first: number, buffers: readonly { readonly buffer: Buffer; readonly offset?: number }[]): void {
    this.rec('bindVertices', (where) => {
      this.inPass(where)
      const start = whole(first, where, 'the first slot')
      const list = listOf(buffers, where, 'the buffers')
      if (list.length === 0) fail('invalid', `${where}: the buffers are empty`)
      if (start + list.length > this.core.limits.vertexBuffers) fail('limit', `${where}: slots ${start} to ${start + list.length - 1} run past the device's ${this.core.limits.vertexBuffers} vertex buffers`)
      const chosen = list.map((x, i) => {
        const at = `${where}: buffers[${i}]`
        const o = record(x, ['buffer', 'offset'], at, 'the vertex buffer')
        const buffer = this.buffer(o.buffer, 'vertex', at, 'the buffer')
        const offset = o.offset === undefined ? 0 : whole(o.offset, at, 'the offset')
        if (offset % 4 !== 0) fail('invalid', `${at}: offset ${offset} is not a multiple of 4`)
        if (offset > buffer.size) fail('invalid', `${at}: offset ${offset} is past the end of ${buffer.name} (${buffer.size} bytes)`)
        return Object.freeze({ buffer, offset })
      })
      chosen.forEach((c, i) => {
        this.bound.vertices[start + i] = c
      })
      this.emit({ c: 'vertices', first: start, buffers: chosen.map((c) => ({ buffer: c.buffer.handle(where), offset: c.offset })) })
    })
  }

  bindIndices(buffer: Buffer, offset: number, type: 'u16' | 'u32'): void {
    this.rec('bindIndices', (where) => {
      this.inPass(where)
      const b = this.buffer(buffer, 'index', where, 'the buffer')
      const t = choice(['u16', 'u32'] as const, type, where, 'the index type')
      const at = whole(offset, where, 'the offset')
      const bytes = t === 'u16' ? 2 : 4
      if (at % bytes !== 0) fail('invalid', `${where}: offset ${at} is not a multiple of ${bytes}, the size of a ${t} index`)
      if (at > b.size) fail('invalid', `${where}: offset ${at} is past the end of ${b.name} (${b.size} bytes)`)
      this.bound.indices = Object.freeze({ buffer: b, offset: at, type: t })
      this.emit({ c: 'indices', buffer: b.handle(where), offset: at, type: t })
    })
  }

  setViewport(viewport: Viewport): void {
    this.rec('setViewport', (where) => {
      this.inPass(where)
      const o = record(viewport, ['x', 'y', 'width', 'height', 'near', 'far'], where, 'the viewport')
      const x = finite(o.x, where, 'x')
      const y = finite(o.y, where, 'y')
      const width = finite(o.width, where, 'the width')
      const height = finite(o.height, where, 'the height')
      if (width <= 0 || height <= 0) fail('invalid', `${where}: the viewport is ${width} x ${height}; its size is positive`)
      const reach = 2 * this.core.limits.imageSize
      if (x < -reach || y < -reach || x + width > reach || y + height > reach) fail('invalid', `${where}: the viewport runs outside -${reach} to ${reach}, twice the device's largest image`)
      const near = o.near === undefined ? 0 : finite(o.near, where, 'near')
      const far = o.far === undefined ? 1 : finite(o.far, where, 'far')
      if (near < 0 || near > 1 || far < 0 || far > 1) fail('invalid', `${where}: the depth range ${near} to ${far} is outside 0 to 1`)
      this.emit({ c: 'viewport', x, y, width, height, near, far })
    })
  }

  setScissor(rect: Rect): void {
    this.rec('setScissor', (where) => {
      const pass = this.inPass(where)
      const o = record(rect, ['x', 'y', 'width', 'height'], where, 'the scissor')
      const x = whole(o.x, where, 'x')
      const y = whole(o.y, where, 'y')
      const width = whole(o.width, where, 'the width')
      const height = whole(o.height, where, 'the height')
      if (x + width > pass.width || y + height > pass.height) fail('invalid', `${where}: the scissor ${x},${y} ${width} x ${height} runs outside the pass's ${pass.width} x ${pass.height}`)
      this.emit({ c: 'scissor', x, y, width, height })
    })
  }

  setBlendConstant(value: readonly [number, number, number, number]): void {
    this.rec('setBlendConstant', (where) => {
      this.inPass(where)
      if (value === undefined) fail('invalid', `${where}: the blend constant is four numbers`)
      this.emit({ c: 'blend-constant', rgba: rgba(value, where, 'the blend constant') })
    })
  }

  setConstants(layout: PipelineLayout, offset: number, data: ArrayBufferView): void {
    this.rec('setConstants', (where) => {
      const l = own(this.core, PipelineLayoutImpl, layout, where, 'the layout', 'PipelineLayout')
      if (l.constants === null) fail('mismatch', `${where}: ${l.name} has no inline constants`)
      const at = whole(offset, where, 'the offset')
      if (at % 4 !== 0) fail('invalid', `${where}: offset ${at} is not a multiple of 4`)
      const bytes = bytesOf(data, where)
      if (at + bytes.length > l.constants.size) fail('invalid', `${where}: bytes ${at} to ${at + bytes.length - 1} run past the ${l.constants.size} bytes of constants of ${l.name}`)
      this.emit({ c: 'constants', offset: at, bytes })
    })
  }

  // -------------------------------------------------------------------------------------------------
  // Draws and dispatches

  draw(vertices: number, instances?: number, firstVertex?: number, firstInstance?: number): void {
    this.rec('draw', (where) => {
      const d = this.drawable(where)
      const count = word(vertices, where, 'the vertex count', 0)
      const inst = word(instances, where, 'the instance count', 1)
      const fv = word(firstVertex, where, 'the first vertex', 0)
      const fi = word(firstInstance, where, 'the first instance', 0)
      this.reach(d.p, where, [fv, count], [fi, inst])
      this.drawScope(d, null, null, where)
      const at = this.emit({ c: 'draw', vertices: count, instances: inst, firstVertex: fv, firstInstance: fi })
      this.noteDraw(d, at, null, null)
    })
  }

  drawIndexed(indices: number, instances?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number): void {
    this.rec('drawIndexed', (where) => {
      const d = this.drawable(where)
      const ib = this.bound.indices
      if (ib === null) fail('state', `${where}: no index buffer is bound`)
      const count = word(indices, where, 'the index count', 0)
      const inst = word(instances, where, 'the instance count', 1)
      const first = word(firstIndex, where, 'the first index', 0)
      const base = baseVertex === undefined ? 0 : baseVertex
      if (typeof base !== 'number' || !Number.isInteger(base) || base < -0x80000000 || base > 0x7fffffff) fail('invalid', `${where}: the base vertex ${say(base)} is not a whole number in the range of i32`)
      const fi = word(firstInstance, where, 'the first instance', 0)
      const bytes = ib.type === 'u16' ? 2 : 4
      const need = (first + count) * bytes
      if (count > 0 && ib.offset + need > ib.buffer.size) fail('invalid', `${where}: indices ${first} to ${first + count - 1} need ${need} bytes past offset ${ib.offset}, and ${ib.buffer.name} holds ${ib.buffer.size - ib.offset}`)
      this.reach(d.p, where, null, [fi, inst])
      this.drawScope(d, ib, null, where)
      const at = this.emit({ c: 'draw-indexed', indices: count, instances: inst, firstIndex: first, baseVertex: base, firstInstance: fi })
      this.noteDraw(d, at, ib, null)
    })
  }

  drawIndirect(buffer: Buffer, offset: number): void {
    this.rec('drawIndirect', (where) => this.indirectDraw(buffer, offset, false, where))
  }

  drawIndexedIndirect(buffer: Buffer, offset: number): void {
    this.rec('drawIndexedIndirect', (where) => this.indirectDraw(buffer, offset, true, where))
  }

  dispatch(x: number, y?: number, z?: number): void {
    this.rec('dispatch', (where) => {
      const { p, sets } = this.dispatchable(where)
      const counts = [word(x, where, 'x', 0), word(y, where, 'y', 1), word(z, where, 'z', 1)]
      const most = this.core.limits.groups
      counts.forEach((n, i) => {
        if (n > most) fail('limit', `${where}: ${n} workgroups along ${'xyz'[i]} is more than the device allows, ${most}`)
      })
      new Scope().take(bindingUses(sets), where, 'dispatch')
      const at = this.emit({ c: 'dispatch', x: counts[0], y: counts[1], z: counts[2] })
      this.note({ r: 'dispatch', at, pipeline: p, sets, indirect: null })
    })
  }

  dispatchIndirect(buffer: Buffer, offset: number): void {
    this.rec('dispatchIndirect', (where) => {
      const { p, sets } = this.dispatchable(where)
      const use = this.indirect(buffer, offset, INDIRECT_BYTES.dispatch, where)
      const uses = bindingUses(sets)
      uses.push({ resource: use.buffer as BufferImpl, level: 0, layer: 0, kind: 'read', how: 'read as indirect arguments' })
      new Scope().take(uses, where, 'dispatch')
      const at = this.emit({ c: 'dispatch-indirect', buffer: (use.buffer as BufferImpl).handle(where), offset: use.offset })
      this.note({ r: 'dispatch', at, pipeline: p, sets, indirect: use })
    })
  }

  // -------------------------------------------------------------------------------------------------
  // Copies

  copyBuffer(src: Buffer, dst: Buffer, regions: readonly BufferCopy[]): void {
    this.rec('copyBuffer', (where) => {
      this.transfer(where)
      const s = this.buffer(src, 'copy-src', where, 'the source')
      const d = this.buffer(dst, 'copy-dst', where, 'the destination')
      const list = this.regions(regions, where).map((x, i): BufferCopy => {
        const at = `${where}: regions[${i}]`
        const o = record(x, ['from', 'to', 'size'], at, 'the region')
        const from = whole(o.from, at, 'from')
        const to = whole(o.to, at, 'to')
        const size = whole(o.size, at, 'the size', 1)
        for (const [n, what] of [[from, 'from'], [to, 'to'], [size, 'the size']] as const) if (n % 4 !== 0) fail('invalid', `${at}: ${what} ${n} is not a multiple of 4`)
        if (from + size > s.size) fail('invalid', `${at}: bytes ${from} to ${from + size - 1} run past the end of ${s.name} (${s.size} bytes)`)
        if (to + size > d.size) fail('invalid', `${at}: bytes ${to} to ${to + size - 1} run past the end of ${d.name} (${d.size} bytes)`)
        return Object.freeze({ from, to, size })
      })
      list.forEach((r, i) => {
        if (s === d && overlaps(r.from, r.from + r.size, r.to, r.to + r.size)) fail('invalid', `${where}: regions[${i}] reads and writes overlapping bytes of ${s.name}`)
        list.forEach((q, j) => {
          if (j > i && overlaps(r.to, r.to + r.size, q.to, q.to + q.size)) fail('invalid', `${where}: regions[${i}] and regions[${j}] write overlapping bytes of ${d.name}`)
          if (j !== i && s === d && overlaps(r.from, r.from + r.size, q.to, q.to + q.size)) fail('invalid', `${where}: regions[${j}] writes bytes of ${s.name} that regions[${i}] reads`)
        })
      })
      this.wrote(d)
      const frozen = Object.freeze(list)
      const at = this.emit({ c: 'copy-buffer', src: s.handle(where), dst: d.handle(where), regions: frozen })
      this.note({ r: 'copy-buffer', at, src: s, dst: d, regions: frozen })
    })
  }

  copyBufferToImage(src: Buffer, dst: Image, regions: readonly BufferImageCopy[]): void {
    this.rec('copyBufferToImage', (where) => {
      this.transfer(where)
      const s = this.buffer(src, 'copy-src', where, 'the source')
      const d = this.image(dst, 'copy-dst', where, 'the destination')
      if (FORMATS[d.format].depth) fail('invalid', `${where}: ${d.name} is ${d.format}; a depth image is copied only into a buffer`)
      const list = this.regions(regions, where).map((x, i) => this.rows(d, s, x, `${where}: regions[${i}]`))
      this.apart(list.map((r) => r.region), d, where)
      this.wrote(d)
      const frozen = Object.freeze(list)
      const at = this.emit({ c: 'copy-buffer-image', src: s.handle(where), dst: d.handle(where), regions: frozen })
      this.note({ r: 'copy-buffer-image', at, src: s, dst: d, regions: frozen })
    })
  }

  copyImageToBuffer(src: Image, dst: Buffer, regions: readonly BufferImageCopy[]): void {
    this.rec('copyImageToBuffer', (where) => {
      this.transfer(where)
      const s = this.image(src, 'copy-src', where, 'the source')
      const d = this.buffer(dst, 'copy-dst', where, 'the destination')
      const list = this.regions(regions, where).map((x, i) => this.rows(s, d, x, `${where}: regions[${i}]`))
      const texel = FORMATS[s.format].bytes
      list.forEach((a, i) => list.forEach((b, j) => {
        if (j > i && rowsOverlap(a, b, texel)) fail('invalid', `${where}: regions[${i}] and regions[${j}] write overlapping bytes of ${d.name}`)
      }))
      this.wrote(d)
      const frozen = Object.freeze(list)
      const at = this.emit({ c: 'copy-image-buffer', src: s.handle(where), dst: d.handle(where), regions: frozen })
      this.note({ r: 'copy-image-buffer', at, src: s, dst: d, regions: frozen })
    })
  }

  copyImage(src: Image, dst: Image, regions: readonly ImageCopy[]): void {
    this.rec('copyImage', (where) => {
      this.transfer(where)
      const s = this.image(src, 'copy-src', where, 'the source')
      const d = this.image(dst, 'copy-dst', where, 'the destination')
      if (s.format !== d.format) fail('mismatch', `${where}: ${s.name} is ${s.format} and ${d.name} is ${d.format}; a copy between images keeps the format`)
      if (FORMATS[s.format].depth) fail('invalid', `${where}: ${s.format} is a depth format; a depth image is copied only into a buffer`)
      const list = this.regions(regions, where).map((x, i): Placed => {
        const at = `${where}: regions[${i}]`
        const o = record(x, ['from', 'to'], at, 'the region')
        const from = regionOf(s, o.from, at, 'the source region')
        const t = record(o.to, ['level', 'layer', 'x', 'y'], at, 'the destination corner')
        const to = regionOf(d, { level: t.level, layer: t.layer, x: t.x, y: t.y, width: from.width, height: from.height }, at, 'the destination region')
        if (s === d && rectsOverlap(from, to)) fail('invalid', `${at}: the region reads and writes overlapping texels of ${s.name}`)
        return Object.freeze({ from, to: Object.freeze({ level: to.level, layer: to.layer, x: to.x, y: to.y }) })
      })
      const writes = list.map((r) => ({ ...r.to, width: r.from.width, height: r.from.height }))
      this.apart(writes, d, where)
      if (s === d) {
        list.forEach((r, i) => writes.forEach((w, j) => {
          if (j !== i && rectsOverlap(r.from, w)) fail('invalid', `${where}: regions[${j}] writes texels of ${s.name} that regions[${i}] reads`)
        }))
      }
      this.wrote(d)
      const frozen = Object.freeze(list)
      const at = this.emit({ c: 'copy-image', src: s.handle(where), dst: d.handle(where), regions: frozen })
      this.note({ r: 'copy-image', at, src: s, dst: d, regions: frozen })
    })
  }

  updateBuffer(dst: Buffer, offset: number, data: ArrayBufferView): void {
    this.rec('updateBuffer', (where) => {
      this.transfer(where)
      const d = this.buffer(dst, 'copy-dst', where, 'the destination')
      const at = whole(offset, where, 'the offset')
      if (at % 4 !== 0) fail('invalid', `${where}: offset ${at} is not a multiple of 4`)
      const bytes = bytesOf(data, where)
      if (bytes.length > this.core.limits.updateSize) fail('limit', `${where}: ${bytes.length} bytes is more than one update may carry, ${this.core.limits.updateSize}`)
      if (at + bytes.length > d.size) fail('invalid', `${where}: bytes ${at} to ${at + bytes.length - 1} run past the end of ${d.name} (${d.size} bytes)`)
      this.wrote(d)
      const n = this.emit({ c: 'update', dst: d.handle(where), offset: at, bytes })
      this.note({ r: 'update', at: n, dst: d, offset: at, size: bytes.length })
    })
  }

  zeroBuffer(dst: Buffer, offset: number, size: number): void {
    this.rec('zeroBuffer', (where) => {
      this.transfer(where)
      const d = this.buffer(dst, 'copy-dst', where, 'the destination')
      const at = whole(offset, where, 'the offset')
      const n = whole(size, where, 'the size', 1)
      if (at % 4 !== 0 || n % 4 !== 0) fail('invalid', `${where}: the offset ${at} and size ${n} are not both multiples of 4`)
      if (at + n > d.size) fail('invalid', `${where}: bytes ${at} to ${at + n - 1} run past the end of ${d.name} (${d.size} bytes)`)
      this.wrote(d)
      const i = this.emit({ c: 'zero', dst: d.handle(where), offset: at, size: n })
      this.note({ r: 'zero', at: i, dst: d, offset: at, size: n })
    })
  }

  // -------------------------------------------------------------------------------------------------
  // Barriers and groups

  barrier(info: BarrierInfo): void {
    this.rec('barrier', (where) => {
      this.outside(where)
      const o = record(info, ['memory', 'buffers', 'images'], where, 'the barrier info')
      const items = (x: unknown, what: string): readonly unknown[] => (x === undefined ? [] : listOf(x, where, what))
      const memory = items(o.memory, 'the memory barriers').map((m, i): FullMemoryBarrier => {
        const at = `${where}: memory[${i}]`
        const mo = record(m, ['before', 'after'], at, 'the memory barrier')
        return Object.freeze({ before: scope(mo.before, at, 'before'), after: scope(mo.after, at, 'after') })
      })
      const buffers = items(o.buffers, 'the buffer barriers').map((b, i): FullBufferBarrier => {
        const at = `${where}: buffers[${i}]`
        const bo = record(b, ['before', 'after', 'buffer', 'offset', 'size'], at, 'the buffer barrier')
        const before = scope(bo.before, at, 'before')
        const after = scope(bo.after, at, 'after')
        const buffer = own(this.core, BufferImpl, bo.buffer, at, 'the buffer', 'Buffer')
        buffer.handle(at)
        const offset = bo.offset === undefined ? 0 : whole(bo.offset, at, 'the offset')
        if (offset >= buffer.size) fail('invalid', `${at}: offset ${offset} is not inside ${buffer.name} (${buffer.size} bytes)`)
        const size = bo.size === undefined ? buffer.size - offset : whole(bo.size, at, 'the size', 1)
        if (offset + size > buffer.size) fail('invalid', `${at}: bytes ${offset} to ${offset + size - 1} run past the end of ${buffer.name} (${buffer.size} bytes)`)
        this.touch(buffer)
        return Object.freeze({ before, after, buffer, offset, size })
      })
      const images = items(o.images, 'the image barriers').map((x, i): FullImageBarrier => {
        const at = `${where}: images[${i}]`
        const io = record(x, ['before', 'after', 'image', 'from', 'to', 'levels', 'layers'], at, 'the image barrier')
        const before = scope(io.before, at, 'before')
        const after = scope(io.after, at, 'after')
        const image = own(this.core, ImageImpl, io.image, at, 'the image', 'Image')
        image.handle(at)
        const from = choice(IMAGE_LAYOUTS, io.from, at, 'from')
        const to = choice(IMAGE_LAYOUTS, io.to, at, 'to')
        if (to === 'blank') fail('invalid', `${at}: nothing moves into blank; it is only where an image starts, or a from that throws contents away`)
        const levels = span(io.levels, image.levels, at, 'the levels')
        const layers = span(io.layers, image.layers, at, 'the layers')
        this.touch(image)
        return Object.freeze({ before, after, image, from, to, levels, layers })
      })
      images.forEach((a, i) => images.forEach((b, j) => {
        if (j > i && a.image === b.image && rangesOverlap(a.levels, b.levels) && rangesOverlap(a.layers, b.layers)) fail('invalid', `${where}: images[${i}] and images[${j}] cover the same levels and layers of ${(a.image as ImageImpl).name}`)
      }))
      if (memory.length + buffers.length + images.length === 0) fail('invalid', `${where}: the barrier holds no barrier`)
      const at = this.emit({ c: 'barrier' })
      this.note({ r: 'barrier', at, memory: Object.freeze(memory), buffers: Object.freeze(buffers), images: Object.freeze(images) })
    })
  }

  beginGroup(label: string): void {
    this.rec('beginGroup', (where) => {
      if (typeof label !== 'string') fail('invalid', `${where}: the label is a string, not ${say(label)}`)
      this.groups.push(this.pass !== null)
      this.emit({ c: 'group', label })
    })
  }

  endGroup(): void {
    this.rec('endGroup', (where) => {
      if (this.groups.length === 0) fail('state', `${where}: no group is open`)
      const inside = this.groups[this.groups.length - 1]
      if (inside !== (this.pass !== null)) fail('state', `${where}: the group was begun ${inside ? 'inside' : 'outside'} a pass and ends ${inside ? 'outside' : 'inside'} one`)
      this.groups.pop()
      this.emit({ c: 'end-group' })
    })
  }

  // -------------------------------------------------------------------------------------------------
  // Helpers

  /** Runs one recording call: the list must be alive and recording. */
  private rec(method: string, f: (where: string) => void): void {
    const where = `${this.name} ${method}`
    guard(this.core.report, where, () => {
      this.exclusive(where, () => {
        this.alive(where)
        if (this.st !== 'recording') fail('state', `${where}: the list is ${this.state}; commands are recorded between begin() and end()`)
        this.staged = []
        this.stagedWrites = []
        f(where)
        for (const x of this.staged) if (!this.deps.has(x)) this.deps.set(x, x.version)
        for (const m of this.stagedWrites) this.writes.add(m)
      })
    })
  }

  /** True while a call on the list runs. */
  get held(): boolean {
    return this.busy
  }

  /**
   * Runs one call with the list held. A descriptor's getter that records, begins, ends or resets the same list while
   * the call is still reading its arguments is refused, so one call's checks and bookkeeping never interleave with
   * another's (an inner call would otherwise drop the outer command's dependencies).
   */
  private exclusive(where: string, f: () => void): void {
    if (this.busy) fail('state', `${where}: called while another call on the list is still reading its arguments`)
    this.busy = true
    try {
      f()
    } finally {
      this.busy = false
    }
  }

  private emit(command: Command): number {
    this.cmds.push(command)
    return this.cmds.length - 1
  }

  private note(entry: Recorded): void {
    this.recs.push(Object.freeze(entry))
  }

  private touch(x: Base): void {
    this.staged.push(x)
  }

  private wrote(r: BufferImpl | ImageImpl): void {
    if (r.memory !== null) this.stagedWrites.push(r.memory)
  }

  private inPass(where: string): PassState {
    if (this.pass === null) fail('state', `${where}: this command sits inside a pass, and no pass is open`)
    return this.pass
  }

  private outside(where: string): void {
    if (this.pass !== null) fail('state', `${where}: this command sits outside a pass; end the pass first`)
  }

  /** Refuses a command the queue group of the list's arena cannot run. */
  private able(ability: 'graphics' | 'compute' | 'copy', where: string): void {
    const g = this.core.adapter.groups[this.arena.group]
    const ok = ability === 'copy' ? g.copy || g.graphics || g.compute : g[ability]
    if (!ok) fail('invalid', `${where}: queue group ${g.index}, which ${this.arena.name} records for, has no ${ability} ability`)
  }

  /** A copy, update or zero: outside a pass, on a group that can copy. */
  private transfer(where: string): void {
    this.outside(where)
    this.able('copy', where)
  }

  private buffer(x: unknown, use: BufferUse, where: string, what: string): BufferImpl {
    const b = own(this.core, BufferImpl, x, where, what, 'Buffer')
    b.handle(where)
    if (!b.use.includes(use)) fail('mismatch', `${where}: ${b.name} has no ${use} use`)
    this.touch(b)
    return b
  }

  private image(x: unknown, use: ImageUse, where: string, what: string): ImageImpl {
    const img = own(this.core, ImageImpl, x, where, what, 'Image')
    img.handle(where)
    if (!img.use.includes(use)) fail('mismatch', `${where}: ${img.name} has no ${use} use`)
    if (img.samples !== 1) fail('invalid', `${where}: ${img.name} has four samples, and a four-sample image is never copied`)
    this.touch(img)
    return img
  }

  private attachment(x: unknown, use: 'color' | 'depth', where: string, what: string): ViewImpl {
    const v = own(this.core, ViewImpl, x, where, what, 'View')
    const img = v.image
    if (!img.use.includes(use)) fail('mismatch', `${where}: ${img.name} has no ${use} use, which a ${use} attachment needs`)
    if (v.levels.count !== 1 || v.layers.count !== 1) fail('invalid', `${where}: ${v.name} covers ${v.levels.count} levels and ${v.layers.count} layers; an attachment is one level of one layer`)
    this.touch(v)
    return v
  }

  private regions(x: unknown, where: string): readonly unknown[] {
    const list = listOf(x, where, 'the regions')
    if (list.length === 0) fail('invalid', `${where}: the regions are empty`)
    return list
  }

  private rows(img: ImageImpl, buf: BufferImpl, x: unknown, at: string): Rows {
    const o = record(x, ['offset', 'rowBytes', 'region'], at, 'the region')
    const region = regionOf(img, o.region, at, 'the image region')
    const texel = FORMATS[img.format].bytes
    const offset = whole(o.offset, at, 'the buffer offset')
    if (offset % texel !== 0) fail('invalid', `${at}: the buffer offset ${offset} is not a multiple of ${texel}, the bytes of one ${img.format} texel`)
    if (FORMATS[img.format].depth && offset % 4 !== 0) fail('invalid', `${at}: the buffer offset ${offset} is not a multiple of 4, which a copy of a depth image needs`)
    const row = region.width * texel
    const rowBytes = whole(o.rowBytes, at, 'rowBytes')
    if (rowBytes < row) fail('invalid', `${at}: rowBytes ${rowBytes} is less than one row of the region, ${row} bytes`)
    const align = this.core.limits.copyRowAlign
    if (region.height > 1 && rowBytes % align !== 0) fail('invalid', `${at}: rowBytes ${rowBytes} is not a multiple of ${align}, which a copy of more than one row needs`)
    const end = offset + rowBytes * (region.height - 1) + row
    if (end > buf.size) fail('invalid', `${at}: the rows reach byte ${end}, past the end of ${buf.name} (${buf.size} bytes)`)
    return Object.freeze({ offset, rowBytes, region })
  }

  /** Refuses two regions a copy writes that share a texel. */
  private apart(writes: readonly Region[], img: ImageImpl, where: string): void {
    writes.forEach((a, i) => writes.forEach((b, j) => {
      if (j > i && rectsOverlap(a, b)) fail('invalid', `${where}: regions[${i}] and regions[${j}] write overlapping texels of ${img.name}`)
    }))
  }

  private indirect(x: unknown, offset: unknown, size: number, where: string): IndirectUse {
    const b = this.buffer(x, 'indirect', where, 'the indirect buffer')
    const at = whole(offset, where, 'the offset')
    if (at % 4 !== 0) fail('invalid', `${where}: offset ${at} is not a multiple of 4`)
    if (at + size > b.size) fail('invalid', `${where}: the ${size} bytes at offset ${at} run past the end of ${b.name} (${b.size} bytes)`)
    return Object.freeze({ buffer: b, offset: at, size })
  }

  private indirectDraw(buffer: unknown, offset: unknown, indexed: boolean, where: string): void {
    const d = this.drawable(where)
    const ib = this.bound.indices
    if (indexed && ib === null) fail('state', `${where}: no index buffer is bound`)
    const use = this.indirect(buffer, offset, indexed ? INDIRECT_BYTES.indexed : INDIRECT_BYTES.draw, where)
    this.drawScope(d, indexed ? ib : null, use, where)
    const at = this.emit({ c: 'draw-indirect', buffer: (use.buffer as BufferImpl).handle(where), offset: use.offset, indexed })
    this.noteDraw(d, at, indexed ? ib : null, use)
  }

  /** The bound render pipeline, inside a pass, with its vertex buffers in place, and the sets it draws with. */
  private drawable(where: string): { readonly p: RenderPipelineImpl; readonly sets: readonly BoundSet[] } {
    this.inPass(where)
    const p = this.bound.pipeline
    if (!(p instanceof RenderPipelineImpl)) fail('state', `${where}: no render pipeline is bound`)
    p.buffers.forEach((_, i) => {
      if (this.bound.vertices[i] === undefined) fail('state', `${where}: ${p.name} reads vertex buffer ${i}, and none is bound there`)
    })
    return { p, sets: this.setsFor(p, where) }
  }

  /** The bound compute pipeline, outside a pass, and the sets it dispatches with. */
  private dispatchable(where: string): { readonly p: ComputePipelineImpl; readonly sets: readonly BoundSet[] } {
    this.outside(where)
    const p = this.bound.pipeline
    if (!(p instanceof ComputePipelineImpl)) fail('state', `${where}: no compute pipeline is bound`)
    return { p, sets: this.setsFor(p, where) }
  }

  /**
   * Refuses a draw or dispatch whose pipeline reads a set that is not bound, or not compatible, or a buffer binding
   * smaller than its block. Returns the snapshot of every bound set its layout accepts.
   */
  private setsFor(p: RenderPipelineImpl | ComputePipelineImpl, where: string): readonly BoundSet[] {
    for (const s of p.sets) {
      const b = this.bound.sets[s]
      if (b === undefined) fail('state', `${where}: ${p.name} reads set ${s}, and no set is bound there`)
      if (!compatible(b.set.layout, p.layout.sets[s])) fail('mismatch', `${where}: ${b.set.name}, bound at set ${s}, does not match set ${s} of ${p.layout.name}, which ${p.name} reads`)
    }
    for (const u of p.uses) {
      if (u.minSize === 0) continue
      const b = this.bound.sets[u.set].bindings.find((x) => x.entry.binding === u.binding)
      if (b !== undefined && 'buffer' in b && b.size < u.minSize) fail('mismatch', `${where}: binding ${u.binding} of set ${u.set} holds ${b.size} bytes, and ${p.name} reads a block of ${u.minSize}`)
    }
    return Object.freeze(p.layout.sets.flatMap((l, i) => {
      const b = this.bound.sets[i]
      return b !== undefined && compatible(b.set.layout, l) ? [b] : []
    }))
  }

  /** Refuses a draw that reads past a vertex buffer: vertex-rate ones over `vertex` (unknown for an indexed draw), instance-rate ones over `instance`. */
  private reach(p: RenderPipelineImpl, where: string, vertex: readonly [number, number] | null, instance: readonly [number, number]): void {
    p.buffers.forEach((layout, i) => {
      const range = layout.rate === 'vertex' ? vertex : instance
      if (range === null || range[1] === 0 || layout.reach === 0) return
      const [first, count] = range
      const need = layout.stride === 0 ? layout.reach : (first + count - 1) * layout.stride + layout.reach
      const b = this.bound.vertices[i]
      if (b.offset + need > b.buffer.size) fail('invalid', `${where}: the draw reads ${need} bytes of vertex buffer ${i} past offset ${b.offset}, and ${b.buffer.name} holds ${b.buffer.size - b.offset}`)
    })
  }

  /** Adds what a draw uses to the pass's usage scope, refusing the draw when a use conflicts (see Scope). */
  private drawScope(d: { readonly p: RenderPipelineImpl; readonly sets: readonly BoundSet[] }, indices: BindState['indices'], indirect: IndirectUse | null, where: string): void {
    const uses = bindingUses(d.sets)
    d.p.buffers.forEach((_, slot) => uses.push({ resource: this.bound.vertices[slot].buffer, level: 0, layer: 0, kind: 'read', how: `read as vertex buffer ${slot}` }))
    if (indices !== null) uses.push({ resource: indices.buffer as BufferImpl, level: 0, layer: 0, kind: 'read', how: 'read as indices' })
    if (indirect !== null) uses.push({ resource: indirect.buffer as BufferImpl, level: 0, layer: 0, kind: 'read', how: 'read as indirect arguments' })
    this.scope.take(uses, where, 'pass')
  }

  private noteDraw(d: { readonly p: RenderPipelineImpl; readonly sets: readonly BoundSet[] }, at: number, indices: BindState['indices'], indirect: IndirectUse | null): void {
    const vertices = d.p.buffers.map((_, slot) => {
      const b = this.bound.vertices[slot]
      return Object.freeze({ slot, buffer: b.buffer, offset: b.offset })
    })
    this.note({ r: 'draw', at, pipeline: d.p, sets: d.sets, vertices: Object.freeze(vertices), indices, indirect })
  }
}

// ---------------------------------------------------------------------------------------------------
// Shared readers

/** Four finite numbers (transparent black when absent). */
function rgba(x: unknown, where: string, what: string): readonly [number, number, number, number] {
  if (x === undefined) return Object.freeze([0, 0, 0, 0] as const)
  if (!Array.isArray(x) || x.length !== 4) fail('invalid', `${where}: ${what} is four numbers, not ${say(x)}`)
  const [r, g, b, a] = (x as unknown[]).map((v, i) => finite(v, where, `${what} channel ${i}`))
  return Object.freeze([r, g, b, a] as const)
}

/** A copy of the bytes of a typed array or DataView: at least 4 of them, a multiple of 4. */
function bytesOf(data: unknown, where: string): Uint8Array {
  if (!ArrayBuffer.isView(data)) fail('invalid', `${where}: the data is a typed array or a DataView, not ${say(data)}`)
  if (data.byteLength === 0 || data.byteLength % 4 !== 0) fail('invalid', `${where}: the data holds ${data.byteLength} bytes; it holds a positive multiple of 4`)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
}

/** A rectangle of one level of one layer of an image, every default filled in, inside the image. */
function regionOf(img: ImageImpl, x: unknown, where: string, what: string): Region {
  const o = record(x, ['level', 'layer', 'x', 'y', 'width', 'height'], where, what)
  const level = o.level === undefined ? 0 : whole(o.level, where, `${what} level`)
  if (level >= img.levels) fail('invalid', `${where}: ${img.name} has no level ${level}; it has ${img.levels}`)
  const layer = o.layer === undefined ? 0 : whole(o.layer, where, `${what} layer`)
  if (layer >= img.layers) fail('invalid', `${where}: ${img.name} has no layer ${layer}; it has ${img.layers}`)
  const x0 = o.x === undefined ? 0 : whole(o.x, where, `${what} x`)
  const y0 = o.y === undefined ? 0 : whole(o.y, where, `${what} y`)
  const width = whole(o.width, where, `${what} width`, 1)
  const height = whole(o.height, where, `${what} height`, 1)
  const w = img.levelWidth(level)
  const h = img.levelHeight(level)
  if (x0 + width > w || y0 + height > h) fail('invalid', `${where}: ${what} ${x0},${y0} ${width} x ${height} runs outside level ${level} of ${img.name} (${w} x ${h})`)
  return Object.freeze({ level, layer, x: x0, y: y0, width, height })
}

function scope(x: unknown, where: string, what: string): FullScope {
  const o = record(x, ['stages', 'access'], where, `the ${what} scope`)
  const stages = names(PIPE_STAGES, o.stages, where, `the ${what} stages`)
  const access = o.access === undefined ? Object.freeze([] as Access[]) : names(ACCESSES, o.access, where, `the ${what} access`, true)
  return Object.freeze({ stages, access })
}
