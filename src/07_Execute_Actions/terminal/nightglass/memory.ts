// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is where bytes come from. It allocates memory of one of the adapter's kinds against
 * the device's limits and the room left on each heap, maps host-visible memory, hands host writes over with flush and
 * takes device writes back with invalidate, says what a buffer or image needs of memory (the spec's sizes, alignments
 * and kinds), and binds a resource into memory, which is when the back end makes its object for it. It keeps the
 * books the rules need: bytes used per heap, allocations alive, and the resources bound into each memory and where;
 * it also counts the submissions in flight that write into each memory.
 * What breaks if it is removed? No buffer or image could be given bytes, a heap could be overdrawn, two resources
 * could be bound over the same bytes, and the host could read back memory the device is still writing.
 *
 * Rules beyond the field-by-field ones:
 * - Memory is destroyed only once every resource bound into it is (a resource stays bound for its whole life).
 * - Resources never share bytes: a bind whose range overlaps a live resource in the same memory is refused.
 * - `invalidate` is refused (when the instance checks) while a submission in flight writes a buffer bound in the
 *   range, and while the last write to one is not visible to the host: the ordering checker's rule (order.ts
 *   hostRead). In-flight work that writes only other bytes of the memory does not refuse it.
 * - `flush` and `invalidate` take a range of at least one byte: the offset defaults to 0 and the size to the rest.
 */
import type { Handle, MemoryKind, Memory, Needs } from './api.ts'
import { fail } from './fault.ts'
import { FORMATS } from './formats.ts'
import { hostRead } from './order.ts'
import { Bindable, BufferImpl, ImageImpl } from './resources.ts'
import { Base, guard, labelOf, mine, own, record, whole } from './sync.ts'
import type { Core } from './sync.ts'
import { say } from './verify.ts'

/** Alignment of a buffer that a shader or an indirect draw reads (uniform, storage, indirect), and of an image. */
export const BIG_ALIGN = 256
/** Alignment of any other buffer. */
export const SMALL_ALIGN = 4

export class MemoryImpl extends Base implements Memory {
  readonly size: number
  readonly kind: MemoryKind
  readonly handle: Handle
  /** The live resources bound into it. */
  readonly bound = new Set<Bindable>()
  /** Submissions in flight that write a resource bound into it. */
  writers = 0

  constructor(core: Core, size: number, kind: MemoryKind, label: string, handle: Handle) {
    super(core, 'memory', label)
    this.size = size
    this.kind = kind
    this.handle = handle
  }

  map(): Uint8Array {
    const where = `${this.name} map`
    return guard(this.core.report, where, () => {
      this.host(where)
      return this.core.call(where, () => this.core.backend.hostBytes(this.handle))
    })
  }

  flush(offset?: number, size?: number): void {
    const where = `${this.name} flush`
    guard(this.core.report, where, () => {
      this.host(where)
      const [at, n] = this.range(offset, size, where)
      this.core.call(where, () => this.core.backend.flush(this.handle, at, n))
    })
  }

  invalidate(offset?: number, size?: number): void {
    const where = `${this.name} invalidate`
    guard(this.core.report, where, () => {
      this.host(where)
      const [at, n] = this.range(offset, size, where)
      hostRead(this, at, n, where)
      this.core.call(where, () => this.core.backend.invalidate(this.handle, at, n))
    })
  }

  /** Refuses a destroyed memory, a destroyed or lost device, and memory the host cannot see. */
  private host(where: string): void {
    this.alive(where)
    this.core.enter(where)
    if (!this.kind.host) fail('memory', `${where}: ${this.name} is ${this.kind.name} memory, which the host cannot see`)
  }

  private range(offset: unknown, size: unknown, where: string): [number, number] {
    const at = offset === undefined ? 0 : whole(offset, where, 'the offset')
    if (at >= this.size) fail('invalid', `${where}: offset ${at} is not inside ${this.name} (${this.size} bytes)`)
    const n = size === undefined ? this.size - at : whole(size, where, 'the size', 1)
    if (at + n > this.size) fail('invalid', `${where}: bytes ${at} to ${at + n - 1} run past the end of ${this.name} (${this.size} bytes)`)
    return [at, n]
  }

  protected override check(where: string): void {
    for (const r of this.bound) fail('lifetime', `${where}: ${r.name} is still bound into it; destroy the resources bound into a memory first`)
  }

  override drop(): void {
    this.core.call(`${this.name} destroy`, () => this.core.backend.destroy(this.handle))
    this.core.heapUsed[this.kind.heap] -= this.size
    this.core.allocations--
  }
}

export function allocate(core: Core, info: unknown, where: string): MemoryImpl {
  const o = record(info, ['size', 'kind', 'label'], where, 'the memory info')
  const index = whole(o.kind, where, 'the memory kind')
  const kinds = core.adapter.kinds
  if (index >= kinds.length) fail('invalid', `${where}: the adapter has no memory kind ${index}; it has ${kinds.length}`)
  const kind = kinds[index]
  const size = whole(o.size, where, 'the size', 1)
  if (size > core.limits.allocationSize) fail('limit', `${where}: ${size} bytes is more than the device's largest allocation, ${core.limits.allocationSize}`)
  if (core.allocations >= core.limits.allocations) fail('limit', `${where}: the device already holds ${core.allocations} allocations, its limit`)
  const heap = core.adapter.heaps[kind.heap]
  const left = heap.size - core.heapUsed[kind.heap]
  if (size > left) fail('memory', `${where}: heap ${heap.index} has ${left} bytes left, not ${size}`)
  const label = labelOf(o.label, where)
  core.enter(where)
  const handle = core.call(where, () => core.backend.allocate(kind.name, size))
  core.heapUsed[kind.heap] += size
  core.allocations++
  return new MemoryImpl(core, size, kind, label, handle)
}

/** The indices of the adapter's memory kinds of one name. */
function kindsNamed(core: Core, name: MemoryKind['name']): number[] {
  return core.adapter.kinds.filter((k) => k.name === name).map((k) => k.index)
}

/** A buffer or an image, made by this device and alive. */
function resourceOf(core: Core, x: unknown, where: string): BufferImpl | ImageImpl {
  if (!(x instanceof BufferImpl) && !(x instanceof ImageImpl)) fail('invalid', `${where}: the resource is a Buffer or an Image, not ${say(x)}`)
  mine(core, x, where)
  return x
}

/** What a resource needs of memory, by the rules of the spec (see `Needs` in api.ts). */
export function needsOf(core: Core, resource: BufferImpl | ImageImpl): Needs {
  if (resource instanceof BufferImpl) {
    const shader = resource.use.some((u) => u === 'uniform' || u === 'storage' || u === 'indirect')
    const only = (u: string): boolean => resource.use.length === 1 && resource.use[0] === u
    const kinds = [...kindsNamed(core, 'device'), ...(only('copy-src') ? kindsNamed(core, 'upload') : []), ...(only('copy-dst') ? kindsNamed(core, 'readback') : [])]
    return Object.freeze({ size: Math.ceil(resource.size / 4) * 4, align: shader ? BIG_ALIGN : SMALL_ALIGN, kinds: Object.freeze(kinds.sort((a, b) => a - b)) })
  }
  let size = 0
  for (let level = 0; level < resource.levels; level++) {
    size += resource.levelWidth(level) * resource.levelHeight(level) * resource.layers * resource.samples * FORMATS[resource.format].bytes
  }
  return Object.freeze({ size: Math.ceil(size / 4) * 4, align: BIG_ALIGN, kinds: Object.freeze(kindsNamed(core, 'images')) })
}

export function needs(core: Core, resource: unknown, where: string): Needs {
  return needsOf(core, resourceOf(core, resource, where))
}

export function bind(core: Core, resource: unknown, memory: unknown, offset: unknown, where: string): void {
  const r = resourceOf(core, resource, where)
  if (r.memory !== null) fail('state', `${where}: ${r.name} is already bound to ${r.memory.name}; a resource is bound once`)
  const mem = own(core, MemoryImpl, memory, where, 'the memory', 'Memory')
  const need = needsOf(core, r)
  if (!need.kinds.includes(mem.kind.index)) {
    const may = need.kinds.length === 0 ? 'no memory kind of this adapter' : `memory kinds ${need.kinds.join(', ')}`
    fail('mismatch', `${where}: ${r.name} cannot live in ${mem.name}, of kind ${mem.kind.index} (${mem.kind.name}); it may live in ${may}`)
  }
  const at = whole(offset, where, 'the offset')
  if (at % need.align !== 0) fail('invalid', `${where}: offset ${at} is not a multiple of ${need.align}, the alignment ${r.name} needs`)
  if (at + need.size > mem.size) fail('invalid', `${where}: ${r.name} needs ${need.size} bytes at offset ${at}, past the end of ${mem.name} (${mem.size} bytes)`)
  for (const other of mem.bound) {
    if (at < other.offset + other.extent && other.offset < at + need.size) {
      fail('invalid', `${where}: bytes ${at} to ${at + need.size - 1} overlap ${other.name}, bound at ${other.offset} to ${other.offset + other.extent - 1}; resources never share memory`)
    }
  }
  core.enter(where)
  const handle = core.call(where, () => r instanceof BufferImpl
    ? core.backend.createBuffer({ size: r.size, use: r.use, label: r.label }, mem.handle, at)
    : core.backend.createImage({ format: r.format, width: r.width, height: r.height, layers: r.layers, levels: r.levels, samples: r.samples, use: r.use, label: r.label }, mem.handle, at))
  r.place(mem, at, need.size, handle)
  mem.bound.add(r)
}
