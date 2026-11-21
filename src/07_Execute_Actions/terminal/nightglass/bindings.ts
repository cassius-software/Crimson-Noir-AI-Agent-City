// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is how resources reach shaders: binding layouts (what kind of resource sits at each
 * binding number of a set, and which stages see it), pipeline layouts (up to the device's number of sets plus a block
 * of inline constants), pools that hand out sets, and the sets themselves with their writes. Every entry, layout and
 * write is checked against the device's limits and against the resource written: its use, its range and alignment,
 * the shape and sample kind of an image view, whether its format can be filtered, a sampler's filters. A set records
 * which bindings hold what, so a command list can snapshot it and later learn that it was written again.
 * What breaks if it is removed? No shader could be handed a buffer, an image or a sampler, and a back end could be
 * given a binding past the end of its buffer or an image its shader reads as the wrong kind.
 *
 * Rules beyond the field-by-field ones:
 * - Entries are kept sorted by binding number, with every default filled in for the entry's kind (dynamic false;
 *   sample float, dims 2d, unfiltered false; filtering true). A field that belongs to another kind is refused.
 * - Two binding layouts are compatible when they are the same object or their sorted, filled-in entries are equal.
 * - Per-stage counts and dynamic counts are checked over one binding layout and again over a whole pipeline layout.
 * - `storage` and `storage-image` entries never list the vertex stage (it writes nothing); `storage-read` may.
 * - A storage-image entry takes a view of one level and one layer (`2d`): a shader's put names no level or layer.
 * - A buffer binding's size defaults to the rest of the buffer; with the offset it is a multiple of 4 and stays in
 *   the buffer, the offset a multiple of `limits.offsetAlign`, the size at most the uniform or storage range.
 * - A pool hands out at most `sets` sets between resets. `reset()` (and `destroy()`) destroys every set it handed
 *   out, refused while queued work holds one of them (when the instance checks).
 * - A set is complete once every binding of its layout has been written. Only then does the back end hear of its
 *   bindings, with all of them, and again after each later write. A write while queued work holds the set is
 *   refused (when the instance checks), and every write raises the set's version, so a command list recorded with
 *   the set before the write is invalid.
 */
import type { BindingEntry, BindingKind, BindingLayout, BindingPool, BindingSet, BindingWrite, BoundEntry, BufferUse, Handle, Limits, PipelineLayout } from './api.ts'
import { fail } from './fault.ts'
import { FORMATS, isFormat, sampleKind } from './formats.ts'
import type { Format } from './formats.ts'
import { IMAGE_DIMS, SAMPLE_KINDS, STAGES } from './lens.ts'
import type { Stage } from './lens.ts'
import { BufferImpl, SamplerImpl, ViewImpl } from './resources.ts'
import { Base, an, choice, every, flag, guard, isObj, labelOf, listOf, names, own, record, whole } from './sync.ts'
import type { Core, Obj } from './sync.ts'
import { say } from './verify.ts'

export const BINDING_KINDS = every<BindingKind>({ uniform: true, storage: true, 'storage-read': true, image: true, sampler: true, 'storage-image': true })

/** The formats the `float32-filter` feature lets a linear filter read. */
const FLOAT32 = new Set<Format>(['r32f', 'rg32f', 'rgba32f'])

type CountLimit = 'stageUniforms' | 'stageStorage' | 'stageImages' | 'stageSamplers' | 'stageStorageImages'

/** The per-stage limit each kind of binding counts against. */
const STAGE_LIMIT: { readonly [K in BindingKind]: CountLimit } = {
  uniform: 'stageUniforms',
  storage: 'stageStorage',
  'storage-read': 'stageStorage',
  image: 'stageImages',
  sampler: 'stageSamplers',
  'storage-image': 'stageStorageImages',
}

const ENTRY_FIELDS = ['binding', 'kind', 'stages', 'dynamic', 'sample', 'dims', 'unfiltered', 'format', 'filtering']

/** The fields that belong to only some kinds of entry. */
const KIND_FIELDS: readonly (readonly [string, readonly BindingKind[]])[] = [
  ['dynamic', ['uniform', 'storage', 'storage-read']],
  ['sample', ['image']],
  ['dims', ['image']],
  ['unfiltered', ['image']],
  ['format', ['storage-image']],
  ['filtering', ['sampler']],
]

export function isBufferKind(kind: BindingKind): boolean {
  return kind === 'uniform' || kind === 'storage' || kind === 'storage-read'
}

/** One entry, checked, with the defaults of its kind filled in. */
/** Named stages in the one order STAGES gives, so two layouts that name the same stages compare equal. */
function stagesOf(x: unknown, where: string, what: string): readonly Stage[] {
  const named = names(STAGES, x, where, what)
  return Object.freeze(STAGES.filter((stage) => named.includes(stage)))
}

function entryOf(core: Core, x: unknown, where: string): BindingEntry {
  const e = record(x, ENTRY_FIELDS, where, 'the entry')
  const binding = whole(e.binding, where, 'the binding')
  if (binding >= core.limits.bindings) fail('limit', `${where}: binding ${binding} is past the device's highest, ${core.limits.bindings - 1}`)
  const kind = choice(BINDING_KINDS, e.kind, where, 'the kind')
  const stages = stagesOf(e.stages, where, 'the stages')
  for (const [field, kinds] of KIND_FIELDS) {
    if (e[field] !== undefined && !kinds.includes(kind)) fail('invalid', `${where}: ${field} belongs to ${kinds.join(' and ')} entries, not to ${an(kind)} entry`)
  }
  if ((kind === 'storage' || kind === 'storage-image') && stages.includes('vertex')) fail('invalid', `${where}: a ${kind} entry is written by its shader, and the vertex stage writes nothing`)
  switch (kind) {
    case 'uniform': case 'storage': case 'storage-read':
      return Object.freeze({ binding, kind, stages, dynamic: flag(e.dynamic, where, 'dynamic', false) })
    case 'image': {
      const sample = choice(SAMPLE_KINDS, e.sample, where, 'the sample kind', 'float')
      const dims = choice(IMAGE_DIMS, e.dims, where, 'the shape', '2d')
      const unfiltered = flag(e.unfiltered, where, 'unfiltered', false)
      if (unfiltered && sample !== 'float') fail('invalid', `${where}: only a float image entry is unfiltered, not a ${sample} one`)
      return Object.freeze({ binding, kind, stages, sample, dims, unfiltered })
    }
    case 'sampler':
      return Object.freeze({ binding, kind, stages, filtering: flag(e.filtering, where, 'filtering', true) })
    case 'storage-image': {
      // Read once: a getter could hand the checks one format and the entry another.
      const format = e.format
      if (format === undefined) fail('invalid', `${where}: a storage-image entry names its format`)
      if (!isFormat(format)) fail('invalid', `${where}: ${say(format)} is not a format`)
      if (!FORMATS[format].storage) fail('invalid', `${where}: ${format} cannot be a storage image`)
      return Object.freeze({ binding, kind, stages, format })
    }
  }
}

/** Refuses sets whose entries, together, pass a per-stage limit or a dynamic-binding limit. */
function countRule(limits: Limits, sets: readonly (readonly BindingEntry[])[], where: string): void {
  const all = sets.flat()
  for (const stage of STAGES) {
    const counts = new Map<CountLimit, number>()
    for (const e of all) if (e.stages.includes(stage)) counts.set(STAGE_LIMIT[e.kind], (counts.get(STAGE_LIMIT[e.kind]) ?? 0) + 1)
    for (const [limit, n] of counts) if (n > limits[limit]) fail('limit', `${where}: the ${stage} stage would see ${n} bindings that count against ${limit}; the device allows ${limits[limit]}`)
  }
  const dynamic = (kinds: readonly BindingKind[]): number => all.filter((e) => e.dynamic === true && kinds.includes(e.kind)).length
  const du = dynamic(['uniform'])
  if (du > limits.dynamicUniforms) fail('limit', `${where}: ${du} dynamic uniform bindings is more than the device allows, ${limits.dynamicUniforms}`)
  const ds = dynamic(['storage', 'storage-read'])
  if (ds > limits.dynamicStorage) fail('limit', `${where}: ${ds} dynamic storage bindings is more than the device allows, ${limits.dynamicStorage}`)
}

export class BindingLayoutImpl extends Base implements BindingLayout {
  /** Sorted by binding number, defaults filled in. */
  readonly entries: readonly BindingEntry[]
  readonly handle: Handle
  /** Equal for two layouts exactly when they are compatible. */
  readonly key: string

  constructor(core: Core, entries: readonly BindingEntry[], label: string, handle: Handle) {
    super(core, 'binding layout', label)
    this.entries = entries
    this.handle = handle
    this.key = JSON.stringify(entries)
  }

  /** The entries of dynamic bindings, in binding order: the order a bindSets call's offsets follow. */
  get dynamic(): readonly BindingEntry[] {
    return this.entries.filter((e) => e.dynamic === true)
  }

  override drop(): void {
    this.core.call(`${this.name} destroy`, () => this.core.backend.destroy(this.handle))
  }
}

/** Two binding layouts that sets made from one may be bound where the other is expected. */
export function compatible(a: BindingLayoutImpl, b: BindingLayoutImpl): boolean {
  return a === b || a.key === b.key
}

export function createBindingLayout(core: Core, info: unknown, where: string): BindingLayoutImpl {
  const o = record(info, ['entries', 'label'], where, 'the binding layout info')
  const entries = listOf(o.entries, where, 'the entries').map((e, i) => entryOf(core, e, `${where}: entries[${i}]`))
  const seen = new Set<number>()
  for (const e of entries) {
    if (seen.has(e.binding)) fail('invalid', `${where}: binding ${e.binding} has two entries`)
    seen.add(e.binding)
  }
  countRule(core.limits, [entries], where)
  const sorted = Object.freeze([...entries].sort((a, b) => a.binding - b.binding))
  const label = labelOf(o.label, where)
  core.enter(where)
  const handle = core.call(where, () => core.backend.createBindingLayout({ entries: sorted, label }))
  return new BindingLayoutImpl(core, sorted, label, handle)
}

export type Constants = { readonly size: number; readonly stages: readonly Stage[] }

export class PipelineLayoutImpl extends Base implements PipelineLayout {
  readonly sets: readonly BindingLayoutImpl[]
  readonly constants: Constants | null
  readonly handle: Handle

  constructor(core: Core, sets: readonly BindingLayoutImpl[], constants: Constants | null, label: string, handle: Handle) {
    super(core, 'pipeline layout', label)
    this.sets = sets
    this.constants = constants
    this.handle = handle
  }

  override drop(): void {
    this.core.call(`${this.name} destroy`, () => this.core.backend.destroy(this.handle))
  }
}

export function createPipelineLayout(core: Core, info: unknown, where: string): PipelineLayoutImpl {
  const o = record(info, ['sets', 'constants', 'label'], where, 'the pipeline layout info')
  const sets = Object.freeze(listOf(o.sets, where, 'the sets').map((s, i) => own(core, BindingLayoutImpl, s, where, `sets[${i}]`, 'BindingLayout')))
  if (sets.length > core.limits.sets) fail('limit', `${where}: ${sets.length} sets is more than the device allows, ${core.limits.sets}`)
  let constants: Constants | null = null
  if (o.constants !== undefined) {
    const c = record(o.constants, ['size', 'stages'], where, 'the constants')
    const size = whole(c.size, where, 'the constants size', 1)
    if (size % 4 !== 0) fail('invalid', `${where}: the constants size ${size} is not a multiple of 4`)
    if (size > core.limits.constants) fail('limit', `${where}: ${size} bytes of constants is more than the device allows, ${core.limits.constants}`)
    constants = Object.freeze({ size, stages: stagesOf(c.stages, where, 'the constants stages') })
  }
  countRule(core.limits, sets.map((s) => s.entries), where)
  const label = labelOf(o.label, where)
  core.enter(where)
  const handle = core.call(where, () => core.backend.createPipelineLayout(sets.map((s) => s.handle), constants))
  return new PipelineLayoutImpl(core, sets, constants, label, handle)
}

// ---------------------------------------------------------------------------------------------------
// Pools and sets

/** What one binding of a set holds. */
export type Bound =
  | { readonly entry: BindingEntry; readonly buffer: BufferImpl; readonly offset: number; readonly size: number }
  | { readonly entry: BindingEntry; readonly view: ViewImpl }
  | { readonly entry: BindingEntry; readonly sampler: SamplerImpl }

/** The resource a binding holds. */
export function heldBy(b: Bound): BufferImpl | ViewImpl | SamplerImpl {
  return 'buffer' in b ? b.buffer : 'view' in b ? b.view : b.sampler
}

export class BindingPoolImpl extends Base implements BindingPool {
  readonly capacity: number
  /** The live sets it handed out. */
  readonly sets = new Set<BindingSetImpl>()
  /** Sets handed out since the last reset. */
  private handed = 0

  constructor(core: Core, capacity: number, label: string) {
    super(core, 'binding pool', label)
    this.capacity = capacity
  }

  allocate(layout: BindingLayout, label?: string): BindingSet {
    const where = `${this.name} allocate`
    return guard(this.core.report, where, () => {
      this.alive(where)
      const l = own(this.core, BindingLayoutImpl, layout, where, 'the layout', 'BindingLayout')
      const name = labelOf(label, where)
      if (this.handed >= this.capacity) fail('limit', `${where}: the pool has handed out its ${this.capacity} sets; reset it first`)
      this.core.enter(where)
      const handle = this.core.call(where, () => this.core.backend.createBindingSet(l.handle))
      // A layout with no entries makes a set that is complete from the start: the back end hears it written once.
      if (l.entries.length === 0) this.core.call(where, () => this.core.backend.writeBindingSet(handle, []))
      this.handed++
      const set = new BindingSetImpl(this.core, this, l, name, handle)
      this.sets.add(set)
      return set
    })
  }

  reset(): void {
    const where = `${this.name} reset`
    guard(this.core.report, where, () => {
      this.alive(where)
      this.check(where)
      this.drop()
    })
  }

  protected override check(where: string): void {
    if (!this.core.checks) return
    for (const s of this.sets) if (s.pending > 0) fail('lifetime', `${where}: queued work still uses ${s.name}; wait for its fence first`)
  }

  override drop(): void {
    for (const s of this.sets) {
      s.drop()
      s.retire()
    }
    this.handed = 0
  }
}

export class BindingSetImpl extends Base implements BindingSet {
  readonly pool: BindingPoolImpl
  readonly layout: BindingLayoutImpl
  readonly handle: Handle
  /** What each entry of the layout holds, by entry position; undefined until written. */
  private held: readonly (Bound | undefined)[]

  constructor(core: Core, pool: BindingPoolImpl, layout: BindingLayoutImpl, label: string, handle: Handle) {
    super(core, 'binding set', label)
    this.pool = pool
    this.layout = layout
    this.handle = handle
    this.held = layout.entries.map(() => undefined)
  }

  /** Every binding is written. */
  get complete(): boolean {
    return this.held.every((b) => b !== undefined)
  }

  /** What each binding holds, in binding order (only once complete). */
  get bindings(): readonly Bound[] {
    return this.held.filter((b) => b !== undefined)
  }

  /** The first binding never written, or one whose resource has since been destroyed; null when the set can be used. */
  unusable(): string | null {
    for (let i = 0; i < this.held.length; i++) {
      const b = this.held[i]
      if (b === undefined) return `binding ${this.layout.entries[i].binding} of ${this.name} was never written`
      if (heldBy(b).destroyed) return `binding ${b.entry.binding} of ${this.name} holds ${heldBy(b).name}, which is destroyed`
    }
    return null
  }

  write(writes: readonly BindingWrite[]): void {
    const where = `${this.name} write`
    guard(this.core.report, where, () => {
      this.alive(where)
      if (this.core.checks && this.pending > 0) fail('lifetime', `${where}: queued work still uses ${this.name}; wait for its fence before writing it`)
      const list = listOf(writes, where, 'the writes')
      if (list.length === 0) fail('invalid', `${where}: the writes are empty`)
      const next = [...this.held]
      const seen = new Set<number>()
      list.forEach((w, i) => {
        const at = `${where}: writes[${i}]`
        if (!isObj(w)) fail('invalid', `${at}: a write is an object, not ${say(w)}`)
        const binding = whole(w.binding, at, 'the binding')
        const index = this.layout.entries.findIndex((e) => e.binding === binding)
        if (index < 0) fail('invalid', `${at}: ${this.layout.name} has no binding ${binding}`)
        if (seen.has(binding)) fail('invalid', `${at}: binding ${binding} is written twice in one call`)
        seen.add(binding)
        next[index] = writeOne(this.core, this.layout.entries[index], w, at)
      })
      this.core.enter(where)
      if (next.every((b) => b !== undefined)) {
        for (const b of next) if (heldBy(b).destroyed) fail('lifetime', `${where}: binding ${b.entry.binding} holds ${heldBy(b).name}, which is destroyed; write it again`)
        const entries = next.map(boundEntry)
        this.core.call(where, () => this.core.backend.writeBindingSet(this.handle, entries))
      }
      this.held = Object.freeze(next)
      this.version++
    })
  }

  override drop(): void {
    this.pool.sets.delete(this)
    this.core.call(`${this.name} destroy`, () => this.core.backend.destroy(this.handle))
  }
}

/** A binding as the back end receives it. */
function boundEntry(b: Bound): BoundEntry {
  if ('buffer' in b) return { binding: b.entry.binding, buffer: b.buffer.handle('writeBindingSet'), offset: b.offset, size: b.size }
  if ('view' in b) return { binding: b.entry.binding, view: b.view.handle }
  return { binding: b.entry.binding, sampler: b.sampler.handle }
}

/** True when a float format may be read through a linear filter on this device. */
export function filterable(core: Core, format: Format): boolean {
  return FORMATS[format].filter || (FLOAT32.has(format) && core.features.includes('float32-filter'))
}

/** Checks one write against its entry and returns what the binding will hold. */
function writeOne(core: Core, entry: BindingEntry, o: Obj, at: string): Bound {
  const forms = ['buffer', 'view', 'sampler'].filter((k) => Object.hasOwn(o, k))
  if (forms.length !== 1) fail('invalid', `${at}: a write holds exactly one of buffer, view and sampler`)
  const kind = entry.kind
  if (forms[0] === 'buffer') {
    record(o, ['binding', 'buffer', 'offset', 'size'], at, 'the write')
    if (!isBufferKind(kind)) fail('mismatch', `${at}: binding ${entry.binding} is ${an(kind)} binding; a buffer goes to a uniform or storage binding`)
    const buffer = own(core, BufferImpl, o.buffer, at, 'the buffer', 'Buffer')
    buffer.handle(at)
    const need: BufferUse = kind === 'uniform' ? 'uniform' : 'storage'
    if (!buffer.use.includes(need)) fail('mismatch', `${at}: ${buffer.name} has no ${need} use, which a ${kind} binding needs`)
    const offset = o.offset === undefined ? 0 : whole(o.offset, at, 'the offset')
    if (offset % core.limits.offsetAlign !== 0) fail('invalid', `${at}: offset ${offset} is not a multiple of ${core.limits.offsetAlign}`)
    if (offset >= buffer.size) fail('invalid', `${at}: offset ${offset} is not inside ${buffer.name} (${buffer.size} bytes)`)
    const size = o.size === undefined ? buffer.size - offset : whole(o.size, at, 'the size', 1)
    if (size % 4 !== 0) fail('invalid', `${at}: the size ${size} is not a multiple of 4`)
    if (offset + size > buffer.size) fail('invalid', `${at}: bytes ${offset} to ${offset + size - 1} run past the end of ${buffer.name} (${buffer.size} bytes)`)
    const range = kind === 'uniform' ? core.limits.uniformRange : core.limits.storageRange
    if (size > range) fail('limit', `${at}: ${size} bytes is more than a ${kind} binding may cover, ${range}${o.size === undefined ? ' (give a size)' : ''}`)
    return Object.freeze({ entry, buffer, offset, size })
  }
  if (forms[0] === 'view') {
    record(o, ['binding', 'view'], at, 'the write')
    if (kind !== 'image' && kind !== 'storage-image') fail('mismatch', `${at}: binding ${entry.binding} is ${an(kind)} binding; a view goes to an image or storage-image binding`)
    const view = own(core, ViewImpl, o.view, at, 'the view', 'View')
    const img = view.image
    if (kind === 'image') {
      if (!img.use.includes('sampled')) fail('mismatch', `${at}: ${img.name} has no sampled use, which an image binding needs`)
      if (view.dims !== entry.dims) fail('mismatch', `${at}: ${view.name} is ${view.dims}; binding ${entry.binding} takes ${entry.dims}`)
      const sk = sampleKind(img.format)
      if (sk !== entry.sample) fail('mismatch', `${at}: ${img.format} hands a shader ${sk} values; binding ${entry.binding} takes ${entry.sample}`)
      if (sk === 'float' && entry.unfiltered !== true && !filterable(core, img.format)) {
        fail('mismatch', `${at}: ${img.format} cannot be filtered; bind it to an unfiltered entry${FLOAT32.has(img.format) ? ' or open the device with float32-filter' : ''}`)
      }
    } else {
      if (!img.use.includes('storage')) fail('mismatch', `${at}: ${img.name} has no storage use, which a storage-image binding needs`)
      if (img.format !== entry.format) fail('mismatch', `${at}: ${img.name} is ${img.format}; binding ${entry.binding} takes ${String(entry.format)}`)
      if (view.levels.count !== 1 || view.dims !== '2d') fail('mismatch', `${at}: a storage-image binding takes a 2d view of one level, and ${view.name} is not one`)
    }
    return Object.freeze({ entry, view })
  }
  record(o, ['binding', 'sampler'], at, 'the write')
  if (kind !== 'sampler') fail('mismatch', `${at}: binding ${entry.binding} is ${an(kind)} binding; a sampler goes to a sampler binding`)
  const sampler = own(core, SamplerImpl, o.sampler, at, 'the sampler', 'Sampler')
  if (entry.filtering === false && !sampler.nearest) fail('mismatch', `${at}: binding ${entry.binding} takes a sampler that never filters linearly, and ${sampler.name} does`)
  return Object.freeze({ entry, sampler })
}

export function createBindingPool(core: Core, info: unknown, where: string): BindingPoolImpl {
  const o = record(info, ['sets', 'label'], where, 'the pool info')
  return new BindingPoolImpl(core, whole(o.sets, where, 'the set count', 1), labelOf(o.label, where))
}
