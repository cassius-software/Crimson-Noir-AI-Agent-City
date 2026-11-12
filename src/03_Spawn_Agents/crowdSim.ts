// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It runs the pedestrians and the First-Law hazard sensing on the physics worker's
 * own GPU device, where nothing on the page can reach them: crowd.wgsl's spawn, clearGrid, binAgents and
 * simulate passes over buffers only this class holds (every pedestrian's state, brains, the hash grid, the
 * counters and the hazard slots). Each step it takes the realm's own cars, avatar and clock, resets the
 * per-step counters and hazard slots, dispatches, and reads back one consistent frame: the counters, the
 * Ring-0 flags (sticky on the GPU until reported), every car's hazard distances, and the pedestrians' render
 * state, which the page receives as a copy to draw; it keeps its own copy of where everyone stands and what they
 * are doing, so the realm checks a recruitment request against its own readings, never the page's. The operator's
 * summons ride in each step's uniform. A lost device is recorded so the simulation can halt; one lost while the
 * crowd is built (the driver took the GPU down compiling a kernel) is a KernelLostError naming the kernel, which the
 * page remembers so its next start asks this GPU for a lighter one (crowdKernelMemory.ts).
 * What breaks if it is removed? Nobody walks, and the Ring-0 Bouncer is blind to pedestrians.
 */
import {
  CROWD_KERNELS, CROWD_WORKGROUP, crowdShader, decodeHazard, FLOW_BINDING, geometryOf, GRID_CAP, GRID_CELLS, HAZARD_NONE, HAZARD_SLOTS, KERNEL_WORDS, MAX_CARS, packSimParams, PARAMS_SIZE,
  PASS_BINDINGS, RENDER_FLOATS, SIM_PASSES, SIM_READ_HAZARDS, SIM_READ_RENDER, simReadbackSize, STATS_FLAGS, STATS_SIZE,
  type CrowdKernel, type PassName,
} from './crowdCompute.ts'
import { compilePasses, DeviceLostError, lossOf, scopedMessage, ShaderRefusedError, withErrorScopes, type CompiledPasses } from '../01_Initialize_World/gpuPipelines.ts'
import { AGENTS_RANGE, type CrowdReadout, type CrowdSensor, type CrowdStepInput } from './crowdSensor.ts'
import { OperatorTrail } from './skills.ts'
import { cpuFlowSolver, nearestOpen, type FlowGrid, type FlowSolver } from '../06_Make_Decisions/flowField.ts'
import { createFlowTexture, FlowFieldGpu, writeFlowTexture } from '../06_Make_Decisions/flowFieldGpu.ts'
import { packStreets, type StreetGrid } from '../01_Initialize_World/region/streets.ts'
import { packRooms, type Workplace } from '../01_Initialize_World/interiors.ts'
import { packRoutes } from '../01_Initialize_World/region/workplaces.ts'

/**
 * Longest crowd substep, s. The stagger springs in simulate (K_TILT 120, C_TILT 15, semi-implicit Euler) diverge
 * above about 0.096 s; the page's frames never carried more than 0.05, and a worker step may carry 0.1.
 */
export const CROWD_SUBSTEP = 0.05

interface Staging { buffer: GPUBuffer; busy: boolean; frame: number; seq: number; time: number; sent: number }

const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now())
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
/** The module's label by kernel: what a refusal names (gpuPipelines.ts ShaderRefusedError) and what the pipelines' labels stem from. */
const KERNEL_LABEL: Readonly<Record<CrowdKernel, string>> = Object.freeze({ full: 'crowd.wgsl', narrow: 'crowd.wgsl (narrow workgroups)', lite: 'crowd.wgsl (light kernel)' })

/** What the ladder is doing with a rung: about to compile it, refused by the GPU, or the crowd stands on it. */
export type KernelStep = 'trying' | 'refused' | 'running'

/** How create() starts its ladder, and who hears it move. */
export interface CrowdStart {
  /**
   * The first rung asked of this GPU (crowdCompute.ts CROWD_KERNELS), 'full' by default: a rung further down where
   * the page remembers that a kernel above it was refused here, or took the GPU down (crowdKernelMemory.ts).
   */
  from?: CrowdKernel
  /**
   * Hears each rung before it is compiled, when it is refused (with the browser's words for the refusal: the page
   * keeps a refusal unless they name memory, crowdKernelMemory.ts), and once the crowd is built on it.
   */
  note?: (rung: CrowdKernel, step: KernelStep, words?: string) => void
}

/**
 * The crowd's device was lost while kernel `rung` was built: compiled, or given its buffers, bind groups and flow
 * field. Whether the kernel did it cannot be known from here (a driver that crashed in its compiler and a phone
 * that took the GPU back look the same); the page decides (crowdKernelMemory.ts). `refused`: the rungs this GPU's
 * compiler had refused before, in words, '' for none.
 */
export class KernelLostError extends Error {
  readonly rung: CrowdKernel
  readonly loss: DeviceLostError
  readonly refused: string
  constructor(rung: CrowdKernel, loss: DeviceLostError, refused = '') {
    super(`crowd.wgsl: ${loss.message}${refused ? ` (before that this GPU refused ${refused})` : ''}`)
    this.name = 'KernelLostError'
    this.rung = rung
    this.loss = loss
    this.refused = refused
  }
}

export class CrowdSim implements CrowdSensor {
  readonly agentCount: number
  /**
   * The kernel this crowd runs (crowdCompute.ts CrowdKernel): 'full'; 'narrow' or 'lite' where this GPU's own shader
   * compiler refused the full simulate pass and a kernel further down the ladder compiled in its place (create).
   */
  readonly kernel: CrowdKernel
  /** Wall time from a step's dispatch to its readback, ms (EMA): how old the freshest reading is when it lands. */
  lagMs = 0
  readonly #device: GPUDevice
  /** Workgroups a dispatch of an agent pass takes: the crowd over the kernel's workgroup width. */
  readonly #groups: number
  readonly #params: GPUBuffer
  readonly #statsBuffer: GPUBuffer
  readonly #hazardBuffer: GPUBuffer
  readonly #pos: GPUBuffer
  readonly #vel: GPUBuffer
  readonly #pose: GPUBuffer
  readonly #pipelines = new Map<PassName, { pipeline: GPUComputePipeline; group: GPUBindGroup }>()
  readonly #paramBytes = new ArrayBuffer(PARAMS_SIZE)
  readonly #paramF32 = new Float32Array(this.#paramBytes)
  readonly #paramU32 = new Uint32Array(this.#paramBytes)
  readonly #zeroStats = new Uint32Array(3)
  readonly #zeroWorking = new Uint32Array(1)
  readonly #zeroFlags = new Uint32Array(1)
  readonly #clearHazards = new Uint32Array(HAZARD_SLOTS).fill(HAZARD_NONE)
  readonly #staging: Staging[] = []
  readonly #readout: CrowdReadout
  #haveReadout = false
  #frame = 0
  /** Frame of the newest readback applied; an older one that resolves late is ignored. */
  #readFrame = 0
  #flags = 0
  #pendingFrame: Float32Array | null = null
  /** Render-frame buffers handed back by the page, reused so a frame is not an allocation. */
  readonly #pool: ArrayBuffer[] = []
  #lost: string | null = null
  /** The flow field's grid (06_Make_Decisions/flowField.ts) and its texture, sampled by simulate (binding 14). */
  readonly #grid: FlowGrid | null
  readonly #flowTexture: GPUTexture
  /** Who solves the field: the GPU (flowField.wgsl) once its pipelines validated, else the CPU; null with no grid. */
  #solver: FlowSolver | null = null
  /** The goal cell the field was last asked for (−1: none yet), so standing still asks for nothing. */
  #goal = -1
  /** The street window's bit field (streets.ts packStreets), packed into Params every step; undefined: the city's. */
  readonly #streets: Uint32Array | undefined
  /** The indoor workplaces' block (interiors.ts packRooms), packed into Params every step; undefined: none. */
  readonly #rooms: Float32Array | undefined
  /**
   * The commute's route table over the street window to each room (region/workplaces.ts packRoutes), packed into Params
   * every step; undefined without a window or without rooms: the procedural city's commute, the greedy walk.
   */
  readonly #routes: Uint32Array | undefined
  /** The operator's way on foot (skills.ts OperatorTrail), from the avatar every step: what a recruit follows across a room. */
  readonly #trail = new OperatorTrail()

  private constructor(device: GPUDevice, agentCount: number, grid: FlowGrid | null, streets: StreetGrid | null, rooms: readonly Workplace[] | null, compiled: CompiledPasses<PassName>, kernel: CrowdKernel) {
    this.#device = device
    this.agentCount = agentCount
    this.kernel = kernel
    this.#groups = Math.ceil(agentCount / CROWD_WORKGROUP[kernel])
    this.#grid = grid
    this.#streets = streets ? packStreets(streets) : undefined
    this.#rooms = rooms && rooms.length > 0 ? packRooms(rooms) : undefined
    this.#routes = streets && rooms && rooms.length > 0 ? packRoutes(rooms, streets) : undefined
    this.#flowTexture = createFlowTexture(device, grid)
    this.#readout = {
      seq: 0,
      time: -Infinity,
      hazardsAhead: new Float32Array(MAX_CARS).fill(Infinity),
      hazardsBehind: new Float32Array(MAX_CARS).fill(Infinity),
      stats: { nudges: 0, waiting: 0, crossing: 0, retreating: 0, working: 0 },
      xz: new Float32Array(agentCount * 2).fill(NaN),
      activity: new Uint8Array(agentCount),
      heading: new Float32Array(agentCount).fill(NaN),
    }
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    this.#params = device.createBuffer({ label: 'crowd.params', size: PARAMS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.#pos = device.createBuffer({ label: 'crowd.pos', size: agentCount * 16, usage: storage | GPUBufferUsage.COPY_SRC })
    this.#vel = device.createBuffer({ label: 'crowd.vel', size: agentCount * 16, usage: storage | GPUBufferUsage.COPY_SRC })
    this.#pose = device.createBuffer({ label: 'crowd.pose', size: agentCount * 16, usage: storage | GPUBufferUsage.COPY_SRC })
    const brain = device.createBuffer({ label: 'crowd.brain', size: agentCount * 64, usage: storage })
    const gridCount = device.createBuffer({ label: 'crowd.gridCount', size: GRID_CELLS * 4, usage: storage })
    const gridSlots = device.createBuffer({ label: 'crowd.gridSlots', size: GRID_CELLS * GRID_CAP * 16, usage: storage })
    this.#statsBuffer = device.createBuffer({ label: 'crowd.stats', size: STATS_SIZE, usage: storage | GPUBufferUsage.COPY_SRC })
    this.#hazardBuffer = device.createBuffer({ label: 'crowd.hazards', size: HAZARD_SLOTS * 4, usage: storage | GPUBufferUsage.COPY_SRC })
    // Zero would read as "someone at the bumper"; start from "nobody".
    device.queue.writeBuffer(this.#hazardBuffer, 0, this.#clearHazards)
    const readSize = simReadbackSize(agentCount)
    for (let i = 0; i < 3; i++) {
      this.#staging.push({
        buffer: device.createBuffer({ label: `crowd.readback${i}`, size: readSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
        busy: false, frame: 0, seq: 0, time: 0, sent: 0,
      })
    }
    const resources: Record<number, GPUBuffer> = {
      0: this.#params, 1: this.#pos, 2: this.#vel, 3: this.#pose, 4: brain, 5: gridCount, 6: gridSlots,
      7: gridCount, 8: gridSlots, 9: this.#statsBuffer, 12: this.#hazardBuffer,
    }
    const flowView = this.#flowTexture.createView({ label: 'crowd.flow' })
    for (const name of SIM_PASSES) {
      const pipeline = compiled.pipelines.get(name)!
      const group = device.createBindGroup({
        label: `crowd.${name}`,
        layout: pipeline.getBindGroupLayout(0),
        entries: PASS_BINDINGS[name].map((binding) => ({ binding, resource: binding === FLOW_BINDING ? flowView : { buffer: resources[binding] } })),
      })
      this.#pipelines.set(name, { pipeline, group })
    }
    // A lost device can no longer see anyone: say so, and let the simulation decide (it halts).
    const lost = (device as Partial<Pick<GPUDevice, 'lost'>>).lost
    void lost?.then((info) => { this.#lost = `GPU device lost (${info.reason}): ${info.message || 'no message'}` })
  }

  /**
   * Compiles the passes (gpuPipelines.ts compilePasses: the browser's own words for a refusal, the module's compiler
   * messages with them), builds the buffers and places every pedestrian. A pass WebGPU's validation refuses is the
   * WGSL's fault, or a browser's, and fails the crowd with those words. Any other refusal of the full kernel (this
   * GPU's own shader compiler would not build it, as some phones' will not: an internal error in Chrome, one Safari
   * reports as validation; a pipeline rule) is tried again down the ladder of kernels (crowdCompute.ts
   * CROWD_KERNELS): the same module at half the workgroup, then the light kernel (crowdWayLite.wgsl): the same
   * sensing, containment and contact, a simpler way for someone asked over; `kernel` says which runs. Every rung
   * refused, the crowd fails with all the refusals. The ladder starts at `start.from` and tells `start.note` each
   * step. A device lost under a rung (gpuPipelines.ts DeviceLostError: the GPU process gone as the driver compiled,
   * or as the buffers and the flow field were made) ends the ladder there as a KernelLostError: a dead device
   * refuses every kernel at once, which is no verdict on any of them.
   * With a flow grid, the field's solver too: the GPU's (flowFieldGpu.ts) when its pipelines validate on this device,
   * else the CPU's, the same field. With a street window (streets.ts: a generated region's), the shader is compiled
   * for the window's corner and street widths and the window's segments are what the people walk; without one, the
   * procedural city's. With `rooms` (the indoor workplaces, interiors.ts: the city's, or a generated region's on lots
   * of its window), one person in WORK.oneIn has a station in one and commutes to it; over a window, by the route
   * table to each room.
   */
  static async create(device: GPUDevice, agentCount: number, grid: FlowGrid | null = null, streets: StreetGrid | null = null, rooms: readonly Workplace[] | null = null, start: CrowdStart = {}): Promise<CrowdSim> {
    const [lo, hi] = AGENTS_RANGE
    if (!(Number.isInteger(agentCount) && agentCount >= lo && agentCount <= hi)) throw new Error(`agents must be ${lo}–${hi}, got ${agentCount}`)
    const placement = grid ? { originX: grid.originX, originZ: grid.originZ, cell: grid.cell } : undefined
    const geometry = streets ? geometryOf(streets) : undefined
    const compile = (kernel: CrowdKernel) => compilePasses(device, KERNEL_LABEL[kernel], crowdShader(agentCount, placement, geometry, kernel), SIM_PASSES)
    let compiled: CompiledPasses<PassName> | null = null
    const first = Math.max(0, CROWD_KERNELS.indexOf(start.from ?? 'full'))
    let kernel: CrowdKernel = CROWD_KERNELS[first]
    const refusals: { rung: CrowdKernel; error: ShaderRefusedError }[] = []
    const refused = (): string => refusals.map((r) => `${KERNEL_WORDS[r.rung]} (${r.error.message})`).join(', ')
    for (const rung of CROWD_KERNELS.slice(first)) {
      // A device already lost before a rung is asked of it was not lost under that rung (a device born into a GPU
      // process that had just gone, as after a restart that follows a crash): a plain loss, no kernel's.
      const gone = await lossOf(device)
      if (gone) throw new DeviceLostError(`about to build ${KERNEL_WORDS[rung]}`, gone.reason, gone.message)
      start.note?.(rung, 'trying')
      try {
        compiled = await compile(rung)
        kernel = rung
        break
      } catch (e) {
        // The device went as this rung compiled: no rung below is asked of a dead device (it would refuse them all).
        if (e instanceof DeviceLostError) throw new KernelLostError(rung, e, refused())
        if (!(e instanceof ShaderRefusedError)) throw new Error(`crowd.wgsl pipeline validation failed: ${messageOf(e)}`)
        refusals.push({ rung, error: e })
        start.note?.(rung, 'refused', e.message)
        // A refusal carrying the module's own WGSL errors is the module's fault, the same on every rung: it ends here.
        // Any other (the GPU's own compiler, reported as internal by Chrome and as validation by Safari; a pipeline
        // rule) is tried a rung down, and every refusal stays in the record.
        if (e.wgslErrors) break
      }
    }
    const words = refused()
    if (!compiled) {
      throw new Error(refusals.some((r) => r.error.reason === 'internal')
        ? `crowd.wgsl pipeline compilation failed: the GPU's own compiler refused ${words}`
        : `crowd.wgsl pipeline validation failed: WebGPU refused ${words}`)
    }
    if (refusals.length) console.warn(`[crowd] ${KERNEL_WORDS[kernel]} runs: refused ${words}`)
    // The buffers, the bind groups and the spawn under every error scope: a buffer refused for memory or a bind group
    // refused by validation is a failure with its own words, not a first step that dispatches nothing.
    const lostUnder = (e: unknown): never => { throw e instanceof DeviceLostError ? new KernelLostError(kernel, e, words) : e }
    const { value: crowd, errors } = await withErrorScopes(device, () => {
      const c = new CrowdSim(device, agentCount, grid, streets, rooms, compiled, kernel)
      c.#spawn()
      return c
    }, `setting up ${KERNEL_WORDS[kernel]}`).catch(lostUnder)
    if (errors.length) {
      throw new Error(errors.every((e) => e.filter === 'validation')
        ? `crowd.wgsl pipeline validation failed: ${scopedMessage(errors)}`
        : `crowd.wgsl could not be set up on this GPU: ${scopedMessage(errors)}`)
    }
    if (grid) {
      try {
        crowd.#solver = await FlowFieldGpu.create(device, grid, crowd.#flowTexture)
      } catch (e) {
        // A field the GPU refuses is solved on the CPU; a device lost under it leaves no crowd to solve one for.
        if (e instanceof DeviceLostError) lostUnder(e)
        console.warn(`[crowd] the flow field is solved on the CPU: ${e instanceof Error ? e.message : String(e)}`)
        crowd.#solver = cpuFlowSolver(grid, (solution) => writeFlowTexture(device, crowd.#flowTexture, grid, solution))
      }
    }
    start.note?.(kernel, 'running')
    return crowd
  }

  /** Where the field is solved: 'gpu', 'cpu', or null with no grid (a console readout). */
  get flowSolver(): 'gpu' | 'cpu' | null {
    return this.#solver === null ? null : this.#solver instanceof FlowFieldGpu ? 'gpu' : 'cpu'
  }

  /**
   * Routes the summoned towards (x, z): the field is solved for the nearest open cell to the point, once per change
   * of that cell, and lands in the flow texture before a later step (the summoned walk the old field until then).
   */
  routeTo(x: number, z: number): void {
    const grid = this.#grid, solver = this.#solver
    if (!grid || !solver || this.#lost !== null || !Number.isFinite(x) || !Number.isFinite(z)) return
    const goal = nearestOpen(grid, x, z)
    if (goal < 0 || goal === this.#goal) return
    this.#goal = goal
    solver.solve([goal]).catch((e: unknown) => { console.warn(`[crowd] flow field: ${e instanceof Error ? e.message : String(e)}`) })
  }

  get readout(): CrowdReadout | null {
    return this.#haveReadout ? this.#readout : null
  }

  get lost(): string | null {
    return this.#lost
  }

  takeFlags(): number {
    const f = this.#flags
    this.#flags = 0
    return f
  }

  takeFrame(): Float32Array | null {
    const f = this.#pendingFrame
    this.#pendingFrame = null
    return f
  }

  recycle(buffer: ArrayBuffer): void {
    if (buffer instanceof ArrayBuffer && buffer.byteLength === this.agentCount * RENDER_FLOATS * 4 && this.#pool.length < 4) this.#pool.push(buffer)
  }

  /**
   * A ragdoll handed back (ragdollRealm.ts): pedestrian `agent` put where its rig's pelvis stood, facing as it faced,
   * standing (velocity, walk phase and speed zero), before the next step. The one coordinate the CPU ever writes, and
   * only for someone the realm had promoted: never the player's figure (index 0), never a non-finite value.
   */
  place(agent: number, x: number, z: number, heading: number): void {
    if (this.#lost !== null) return
    if (!(Number.isInteger(agent) && agent > 0 && agent < this.agentCount)) return
    if (![x, z, heading].every(Number.isFinite)) return
    const queue = this.#device.queue
    queue.writeBuffer(this.#pos, agent * 16, new Float32Array([x, 0, z, heading]))
    queue.writeBuffer(this.#vel, agent * 16, new Float32Array(4))
  }

  /** GPU-side placement of every pedestrian at boot. */
  #spawn(): void {
    packSimParams(this.#paramF32, this.#paramU32, 0, this.agentCount, { seq: 0, dt: 0, time: 0, player: { x: 0, z: 0, heading: 0, speed: 0, visible: false }, cars: [], summons: [] }, this.#streets, this.#rooms, this.#routes)
    this.#device.queue.writeBuffer(this.#params, 0, this.#paramBytes)
    const enc = this.#device.createCommandEncoder({ label: 'crowd.spawn' })
    const pass = enc.beginComputePass()
    this.#dispatch(pass, 'spawn', this.#groups)
    pass.end()
    this.#device.queue.submit([enc.finish()])
  }

  /**
   * One crowd step of `input.dt`, in substeps of at most CROWD_SUBSTEP, each with its own uniform (dt, time, frame)
   * and its own submit: writes and submits run in order on the queue. Then one readback of the last substep.
   */
  step(input: CrowdStepInput): void {
    if (this.#lost !== null) return
    const dt = input.dt > 0 ? input.dt : 0
    const k = Math.max(1, Math.ceil(dt / CROWD_SUBSTEP - 1e-9))
    const h = dt / k
    const queue = this.#device.queue
    this.#trail.update(input.player.x, input.player.z, input.player.visible)
    for (let sub = 1; sub <= k; sub++) {
      this.#frame++
      packSimParams(this.#paramF32, this.#paramU32, this.#frame, this.agentCount, { ...input, dt: h, time: input.time - dt + h * sub }, this.#streets, this.#rooms, this.#routes, this.#trail)
      queue.writeBuffer(this.#params, 0, this.#paramBytes)
      // stats[0] (safety nudges) is cumulative and stats[4] (the Ring-0 flags) sticky; the per-step counters
      // between them, and the working count after them, are reset.
      queue.writeBuffer(this.#statsBuffer, 4, this.#zeroStats)
      queue.writeBuffer(this.#statsBuffer, 20, this.#zeroWorking)
      // Every car starts the step seeing nobody; simulate lowers each slot with atomicMin.
      queue.writeBuffer(this.#hazardBuffer, 0, this.#clearHazards)
      const enc = this.#device.createCommandEncoder({ label: 'crowd.step' })
      const pass = enc.beginComputePass({ label: 'crowd' })
      this.#dispatch(pass, 'clearGrid', Math.ceil(GRID_CELLS / 256))
      this.#dispatch(pass, 'binAgents', this.#groups)
      this.#dispatch(pass, 'simulate', this.#groups)
      pass.end()
      if (sub < k) queue.submit([enc.finish()])
      // simulate senses each pedestrian where it stood when the substep began (it moves them after), so the
      // reading is stamped with that time: its age then counts the last substep's walking too.
      else this.#readbackAndSubmit(enc, input.seq, input.time - h)
    }
  }

  /** Copies the last substep's counters, hazard slots and render state into a free staging buffer, submits, maps. */
  #readbackAndSubmit(enc: GPUCommandEncoder, seq: number, time: number): void {
    const queue = this.#device.queue
    let free: Staging | null = null
    for (const s of this.#staging) {
      if (!s.busy) { free = s; break }
    }
    if (free) {
      const n = this.agentCount * 16
      enc.copyBufferToBuffer(this.#statsBuffer, 0, free.buffer, 0, STATS_SIZE)
      enc.copyBufferToBuffer(this.#hazardBuffer, 0, free.buffer, SIM_READ_HAZARDS, HAZARD_SLOTS * 4)
      enc.copyBufferToBuffer(this.#pos, 0, free.buffer, SIM_READ_RENDER, n)
      enc.copyBufferToBuffer(this.#vel, 0, free.buffer, SIM_READ_RENDER + n, n)
      enc.copyBufferToBuffer(this.#pose, 0, free.buffer, SIM_READ_RENDER + 2 * n, n)
    }
    queue.submit([enc.finish()])
    if (free) {
      const slot = free
      slot.busy = true
      slot.frame = this.#frame
      slot.seq = seq
      slot.time = time
      slot.sent = now()
      slot.buffer.mapAsync(GPUMapMode.READ).then(() => this.#read(slot), () => { slot.busy = false })
    }
  }

  /** Decodes one mapped readback: the counters, the Ring-0 flags, every car's hazard distances, the render frame. */
  #read(slot: Staging): void {
    if (slot.frame > this.#readFrame) {
      this.#readFrame = slot.frame
      const bytes = slot.buffer.getMappedRange()
      const u = new Uint32Array(bytes, 0, SIM_READ_RENDER / 4)
      const r = this.#readout
      r.seq = slot.seq
      r.time = slot.time
      r.stats.nudges = u[0]
      r.stats.waiting = u[1]
      r.stats.crossing = u[2]
      r.stats.retreating = u[3]
      r.stats.working = u[5]
      // Reported: accumulated until the audit takes it, and cleared on the GPU (a readback already in flight
      // may report it once more).
      const flags = u[STATS_FLAGS]
      if (flags !== 0) {
        this.#flags |= flags
        this.#device.queue.writeBuffer(this.#statsBuffer, STATS_FLAGS * 4, this.#zeroFlags)
      }
      const h = SIM_READ_HAZARDS / 4
      for (let j = 0; j < MAX_CARS; j++) {
        r.hazardsAhead[j] = decodeHazard(u[h + j])
        r.hazardsBehind[j] = decodeHazard(u[h + MAX_CARS + j])
      }
      this.#haveReadout = true
      // A copy the page can own (the mapped range is gone at unmap), into a buffer the page handed back if any.
      const n = this.agentCount * RENDER_FLOATS
      const frame = new Float32Array(this.#pool.pop() ?? new ArrayBuffer(n * 4))
      frame.set(new Float32Array(bytes, SIM_READ_RENDER, n))
      // This realm's own copy of where everyone stands (pos.xz) and what they are doing (pose.w), for recruitment.
      const xz = r.xz, activity = r.activity, heading = r.heading!, pose = 8 * this.agentCount
      for (let i = 0; i < this.agentCount; i++) {
        xz[2 * i] = frame[4 * i]
        xz[2 * i + 1] = frame[4 * i + 2]
        heading[i] = frame[4 * i + 3]
        activity[i] = frame[pose + 4 * i + 3]
      }
      if (this.#pendingFrame) this.recycle(this.#pendingFrame.buffer as ArrayBuffer)
      this.#pendingFrame = frame
      const lag = now() - slot.sent
      this.lagMs = this.lagMs === 0 ? lag : this.lagMs * 0.9 + lag * 0.1
    }
    slot.buffer.unmap()
    slot.busy = false
  }

  #dispatch(pass: GPUComputePassEncoder, name: PassName, groups: number): void {
    const p = this.#pipelines.get(name)!
    pass.setPipeline(p.pipeline)
    pass.setBindGroup(0, p.group)
    pass.dispatchWorkgroups(groups)
  }
}

Object.freeze(CrowdSim.prototype)
Object.freeze(CrowdSim)
