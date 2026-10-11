// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It runs flowField.wgsl on a GPU device (the physics worker's own, beside the crowd) and
 * lands the direction field straight in the crowd's flow texture, so the whole route from "the operator moved" to
 * "every pedestrian knows which way to walk" happens on the GPU: the host seeds the cost field (0 at the goal cells,
 * UNREACHED elsewhere), dispatches `relax` passes in batches, ping-ponging two cost buffers, reads one word back
 * (how many cells the batch changed) and stops at the first batch that changed nothing, then dispatches `direction`
 * into the flow texture. A pipeline that fails validation (a device without the features, a broken
 * shader) makes `create` reject, and the crowd falls back to the CPU solver (flowField.ts solveFlow + writeFlowTexture),
 * which computes the same field. One solve runs at a time; a goal asked for while one runs is solved next, and a
 * goal asked for twice while waiting is solved once.
 * What breaks if it is removed? The field is solved on the worker's CPU; nothing else changes.
 */
import flowSource from './flowField.wgsl?raw'
import { seedCost, type FlowGrid, type FlowSolution, type FlowSolver } from './flowField.ts'

/** Relax passes between two readbacks of the change counter: a batch is one submit, a readback is one map. */
export const RELAX_BATCH = 32
/** Workgroup size of both entry points (flowField.wgsl @workgroup_size). */
export const FLOW_WORKGROUP = 64
/** Bindings of flowField.wgsl, by name. */
export const FLOW_BINDINGS = Object.freeze({ grid: 0, weight: 1, costIn: 2, costOut: 3, flow: 4, changed: 5 } as const)

/** The shader source (a test reads the constants and bindings out of it). */
export const flowShader = (): string => flowSource

/** The most relax passes a solve spends: four sweeps of the grid's perimeter reach every cell of any city plan. */
export const relaxLimit = (grid: FlowGrid): number => 4 * (grid.width + grid.height)

/** The texture format of the field: two floats per cell, written by the shader and read by the crowd. */
export const FLOW_FORMAT: GPUTextureFormat = 'rg32float'

/** The crowd's flow texture for a grid (or a one-texel one, all zero, for no grid), usable by both shaders and a CPU write. */
export function createFlowTexture(device: GPUDevice, grid: FlowGrid | null): GPUTexture {
  return device.createTexture({
    label: 'crowd.flow',
    size: { width: grid?.width ?? 1, height: grid?.height ?? 1 },
    format: FLOW_FORMAT,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST,
  })
}

/** The CPU solver's landing: the direction field written into the texture, one row at a time of width × 8 bytes. */
export function writeFlowTexture(device: GPUDevice, texture: GPUTexture, grid: FlowGrid, solution: FlowSolution): void {
  device.queue.writeTexture({ texture }, solution.dir, { bytesPerRow: grid.width * 8, rowsPerImage: grid.height }, { width: grid.width, height: grid.height })
}

interface Groups { relaxAB: GPUBindGroup; relaxBA: GPUBindGroup; directionA: GPUBindGroup; directionB: GPUBindGroup }

export class FlowFieldGpu implements FlowSolver {
  readonly grid: FlowGrid
  readonly #device: GPUDevice
  readonly #costA: GPUBuffer
  readonly #costB: GPUBuffer
  readonly #changed: GPUBuffer
  readonly #staging: GPUBuffer
  readonly #relax: GPUComputePipeline
  readonly #direction: GPUComputePipeline
  readonly #groups: Groups
  readonly #zero = new Uint32Array(1)
  readonly #seed: Int32Array
  #running: Promise<void> | null = null
  #next: readonly number[] | null = null
  /** Relax passes the last solve took (a console readout; −1 before one). */
  passes = -1

  private constructor(device: GPUDevice, grid: FlowGrid, flow: GPUTexture) {
    this.grid = grid
    this.#device = device
    const cells = grid.width * grid.height
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    const gridWords = device.createBuffer({ label: 'flow.grid', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(gridWords, 0, new Uint32Array([grid.width, grid.height, cells, 0]))
    const weight = device.createBuffer({ label: 'flow.weight', size: cells * 4, usage: storage })
    device.queue.writeBuffer(weight, 0, Uint32Array.from(grid.weight))
    this.#costA = device.createBuffer({ label: 'flow.costA', size: cells * 4, usage: storage })
    this.#costB = device.createBuffer({ label: 'flow.costB', size: cells * 4, usage: storage })
    this.#changed = device.createBuffer({ label: 'flow.changed', size: 4, usage: storage | GPUBufferUsage.COPY_SRC })
    this.#staging = device.createBuffer({ label: 'flow.readback', size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    this.#seed = new Int32Array(cells)
    const module = device.createShaderModule({ label: 'flowField.wgsl', code: flowSource })
    this.#relax = device.createComputePipeline({ label: 'flow.relax', layout: 'auto', compute: { module, entryPoint: 'relax' } })
    this.#direction = device.createComputePipeline({ label: 'flow.direction', layout: 'auto', compute: { module, entryPoint: 'direction' } })
    const group = (label: string, pipeline: GPUComputePipeline, costIn: GPUBuffer, costOut: GPUBuffer): GPUBindGroup =>
      device.createBindGroup({
        label,
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: FLOW_BINDINGS.grid, resource: { buffer: gridWords } },
          { binding: FLOW_BINDINGS.weight, resource: { buffer: weight } },
          { binding: FLOW_BINDINGS.costIn, resource: { buffer: costIn } },
          { binding: FLOW_BINDINGS.costOut, resource: { buffer: costOut } },
          { binding: FLOW_BINDINGS.flow, resource: flow.createView({ label: 'flow.direction.out' }) },
          { binding: FLOW_BINDINGS.changed, resource: { buffer: this.#changed } },
        ],
      })
    this.#groups = {
      relaxAB: group('flow.relax.ab', this.#relax, this.#costA, this.#costB),
      relaxBA: group('flow.relax.ba', this.#relax, this.#costB, this.#costA),
      directionA: group('flow.direction.a', this.#direction, this.#costA, this.#costB),
      directionB: group('flow.direction.b', this.#direction, this.#costB, this.#costA),
    }
  }

  /**
   * Builds the pipelines over `flow`, the crowd's flow texture (createFlowTexture for this grid). Rejects when the
   * device refuses the shader (validation), so the caller can fall back to the CPU solver.
   */
  static async create(device: GPUDevice, grid: FlowGrid, flow: GPUTexture): Promise<FlowFieldGpu> {
    device.pushErrorScope('validation')
    const solver = new FlowFieldGpu(device, grid, flow)
    const error = await device.popErrorScope()
    if (error) throw new Error(`flowField.wgsl pipeline validation failed: ${error.message}`)
    return solver
  }

  /** True while a solve is on the device. */
  get busy(): boolean {
    return this.#running !== null
  }

  /**
   * Solves the field for `goals` and lands it in the flow texture; resolves when it has landed. While a solve runs, the
   * goals are kept for the next one (the newest wins) and this call resolves with it.
   */
  solve(goals: readonly number[]): Promise<void> {
    if (this.#running) {
      this.#next = goals
      return this.#running
    }
    this.#running = this.#run(goals).finally(() => {
      this.#running = null
      const next = this.#next
      this.#next = null
      if (next) void this.solve(next)
    })
    return this.#running
  }

  async #run(goals: readonly number[]): Promise<void> {
    const device = this.#device, queue = device.queue
    const cells = this.grid.width * this.grid.height
    const groups = Math.ceil(cells / FLOW_WORKGROUP)
    seedCost(this.grid, goals, this.#seed)
    queue.writeBuffer(this.#costA, 0, this.#seed)
    // The field ping-pongs A -> B -> A …; `inA` says which buffer holds the newest costs.
    let inA = true
    let passes = 0
    const limit = relaxLimit(this.grid)
    while (passes < limit) {
      queue.writeBuffer(this.#changed, 0, this.#zero)
      const enc = device.createCommandEncoder({ label: 'flow.relax' })
      const pass = enc.beginComputePass({ label: 'flow.relax' })
      pass.setPipeline(this.#relax)
      const batch = Math.min(RELAX_BATCH, limit - passes)
      for (let k = 0; k < batch; k++) {
        pass.setBindGroup(0, inA ? this.#groups.relaxAB : this.#groups.relaxBA)
        pass.dispatchWorkgroups(groups)
        inA = !inA
      }
      pass.end()
      enc.copyBufferToBuffer(this.#changed, 0, this.#staging, 0, 4)
      queue.submit([enc.finish()])
      passes += batch
      await this.#staging.mapAsync(GPUMapMode.READ)
      const changed = new Uint32Array(this.#staging.getMappedRange())[0]
      this.#staging.unmap()
      if (changed === 0) break
    }
    this.passes = passes
    const enc = device.createCommandEncoder({ label: 'flow.direction' })
    const pass = enc.beginComputePass({ label: 'flow.direction' })
    pass.setPipeline(this.#direction)
    pass.setBindGroup(0, inA ? this.#groups.directionA : this.#groups.directionB)
    pass.dispatchWorkgroups(groups)
    pass.end()
    queue.submit([enc.finish()])
  }
}
