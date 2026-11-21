// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the opened device: the one object every other is made from. Each of its calls
 * runs inside the guard of sync.ts and hands the descriptor to the file that knows its rules (memory.ts,
 * resources.ts, bindings.ts, pipelines.ts, commands.ts, sync.ts), so a refusal always reaches the instance's report
 * callback and always names the device call. It holds the queues the device opened with, and it is what tearing the
 * device down frees.
 * What breaks if it is removed? An app could open an adapter and do nothing with it: no memory, no resource, no
 * shader, no pipeline, no command list and no queue would exist.
 *
 * Rules beyond what the other files check:
 * - `queue(group, index)` hands back the one queue object of a queue the device opened; any other is refused.
 * - A command arena records for a queue group the device opened queues in (default 0); lists are resettable one by
 *   one unless `resettable` is false.
 * - `destroy()` is refused while submitted work is in flight (when the instance checks). It then frees every object
 *   the device made, newest first and memory last, so nothing is freed before what is bound into it, and refuses
 *   every later call on the device or on anything it made.
 */
import type {
  Adapter, BindingLayout, BindingLayoutInfo, BindingPool, BindingPoolInfo, Buffer, BufferInfo, CommandArena, CommandArenaInfo, ComputePipeline,
  ComputePipelineInfo, Device, Feature, Fence, Image, ImageInfo, Lens, Limits, Memory, MemoryInfo, Needs, PipelineLayout,
  PipelineLayoutInfo, Queue, RenderPipeline, RenderPipelineInfo, Sampler, SamplerInfo, Semaphore, View, ViewInfo,
} from './api.ts'
import { createBindingLayout, createBindingPool, createPipelineLayout } from './bindings.ts'
import { CommandArenaImpl } from './commands.ts'
import { fail } from './fault.ts'
import type { LensModule } from './lens.ts'
import { MemoryImpl, allocate, bind, needs } from './memory.ts'
import { createComputePipeline, createLens, createRenderPipeline } from './pipelines.ts'
import { QueueImpl } from './queue.ts'
import { createBuffer, createImage, createSampler, createView } from './resources.ts'
import { Base, FenceImpl, SemaphoreImpl, flag, guard, labelOf, record, whole } from './sync.ts'
import type { Core } from './sync.ts'

export class DeviceImpl extends Base implements Device {
  /** The queues it opened, by group. */
  private readonly queues: ReadonlyMap<number, readonly QueueImpl[]>

  constructor(core: Core, label: string, queues: readonly { readonly group: number; readonly count: number }[]) {
    super(core, 'device', label)
    this.queues = new Map(queues.map((q) => [q.group, Array.from({ length: q.count }, (_, i) => new QueueImpl(core, q.group, i))] as const))
  }

  get adapter(): Adapter {
    return this.core.adapter
  }

  get limits(): Limits {
    return this.core.limits
  }

  get features(): readonly Feature[] {
    return this.core.features
  }

  /** Runs one device call: the device must be alive. */
  private call<T>(method: string, f: (where: string) => T): T {
    const where = `${this.name} ${method}`
    return guard(this.core.report, where, () => {
      this.alive(where)
      return f(where)
    })
  }

  queue(group: number, index: number): Queue {
    return this.call('queue', (where) => {
      const g = whole(group, where, 'the group')
      const i = whole(index, where, 'the index')
      const list = this.queues.get(g)
      if (list === undefined) fail('invalid', `${where}: the device opened no queue of group ${g}`)
      if (i >= list.length) fail('invalid', `${where}: the device opened ${list.length} queue${list.length === 1 ? '' : 's'} of group ${g}, so it has no queue ${i}`)
      return list[i]
    })
  }

  allocate(info: MemoryInfo): Memory {
    return this.call('allocate', (where) => allocate(this.core, info, where))
  }

  createBuffer(info: BufferInfo): Buffer {
    return this.call('createBuffer', (where) => createBuffer(this.core, info, where))
  }

  createImage(info: ImageInfo): Image {
    return this.call('createImage', (where) => createImage(this.core, info, where))
  }

  needs(resource: Buffer | Image): Needs {
    return this.call('needs', (where) => needs(this.core, resource, where))
  }

  bind(resource: Buffer | Image, memory: Memory, offset: number): void {
    this.call('bind', (where) => bind(this.core, resource, memory, offset, where))
  }

  createView(image: Image, info?: ViewInfo): View {
    return this.call('createView', (where) => createView(this.core, image, info, where))
  }

  createSampler(info?: SamplerInfo): Sampler {
    return this.call('createSampler', (where) => createSampler(this.core, info, where))
  }

  createBindingLayout(info: BindingLayoutInfo): BindingLayout {
    return this.call('createBindingLayout', (where) => createBindingLayout(this.core, info, where))
  }

  createPipelineLayout(info: PipelineLayoutInfo): PipelineLayout {
    return this.call('createPipelineLayout', (where) => createPipelineLayout(this.core, info, where))
  }

  createBindingPool(info: BindingPoolInfo): BindingPool {
    return this.call('createBindingPool', (where) => createBindingPool(this.core, info, where))
  }

  createLens(source: Uint32Array | LensModule, label?: string): Lens {
    return this.call('createLens', (where) => createLens(this.core, source, label, where))
  }

  createRenderPipeline(info: RenderPipelineInfo): RenderPipeline {
    return this.call('createRenderPipeline', (where) => createRenderPipeline(this.core, info, where))
  }

  createComputePipeline(info: ComputePipelineInfo): ComputePipeline {
    return this.call('createComputePipeline', (where) => createComputePipeline(this.core, info, where))
  }

  createCommandArena(info?: CommandArenaInfo): CommandArena {
    return this.call('createCommandArena', (where) => {
      const o = record(info, ['group', 'resettable', 'label'], where, 'the arena info', true)
      const group = o.group === undefined ? 0 : whole(o.group, where, 'the group')
      if (!this.queues.has(group)) fail('invalid', `${where}: the device opened no queue of group ${group}`)
      return new CommandArenaImpl(this.core, group, flag(o.resettable, where, 'resettable', true), labelOf(o.label, where))
    })
  }

  createFence(info?: { readonly signalled?: boolean; readonly label?: string }): Fence {
    return this.call('createFence', (where) => {
      const o = record(info, ['signalled', 'label'], where, 'the fence info', true)
      return new FenceImpl(this.core, flag(o.signalled, where, 'signalled', false), labelOf(o.label, where))
    })
  }

  createSemaphore(info?: { readonly label?: string }): Semaphore {
    return this.call('createSemaphore', (where) => {
      const o = record(info, ['label'], where, 'the semaphore info', true)
      return new SemaphoreImpl(this.core, labelOf(o.label, where))
    })
  }

  lost(): string | null {
    return this.call('lost', (where) => this.core.call(where, () => this.core.backend.lost()))
  }

  protected override check(where: string): void {
    if (this.core.checks && this.core.inFlight > 0) fail('lifetime', `${where}: submitted work is still in flight; wait for its fences first`)
  }

  override drop(): void {
    const others = [...this.core.live].filter((x) => x !== this).reverse()
    for (const x of [...others.filter((o) => !(o instanceof MemoryImpl)), ...others.filter((o) => o instanceof MemoryImpl)]) {
      if (x.destroyed) continue
      x.drop()
      x.retire()
    }
    this.core.closed = true
  }
}
