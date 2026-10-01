/**
 * Why does this file exist? It is the page's share of the crowd: drawing, nothing else. The pedestrians are
 * simulated and sensed in the physics worker (crowdSim.ts); each render frame the worker sends lands here and
 * is written into three's storage buffers (pos, vel, pose). Every page frame the cull pass then picks who is
 * drawn for the current camera — the frustum, a near radius, a stable density lottery, the draw distance and
 * the level of detail — compacting them into the indirect draws, and a small readback reports what was drawn.
 * A few figures can be hidden (hide): the pedestrians the realm has promoted to a physical body, whose rig the
 * page draws in their place (07_Execute_Actions/rigView.ts); the mask only sinks their position in the render
 * copy below the cull's floor. Whatever happens here changes only what the page shows: the Bouncer reads the
 * worker's own buffers.
 * What breaks if it is removed? The pedestrians are simulated but never drawn.
 */
import {
  CULL_PASSES, CULL_READBACK_SIZE, crowdShader, packCullParams, PARAMS_SIZE, PASS_BINDINGS, sanitizeCull, VARIANTS,
  type CullInput, type CullSettings, type PassName, type SharedBuffers,
} from './crowdCompute.ts'

interface Staging { buffer: GPUBuffer; busy: boolean; frame: number }

/** Figures the page may hide at once (the realm's rig slots, simProtocol.ts RIG_SLOTS). */
export const MAX_HIDDEN = 8
/** A hidden figure's height in the render copy: below the floor the cull pass skips (crowd.wgsl cull: p.y < -50). */
const HIDDEN_Y = -100

export class CrowdCull {
  readonly agentCount: number
  /** Instances drawn per LOD this frame (after culling), from the newest readback. */
  readonly stats = { drawnNear: 0, drawnFar: 0 }
  /** GPU time of the cull pass in ms (only measured when profiling). */
  gpuMs = 0
  private readonly device: GPUDevice
  private readonly params: GPUBuffer
  private readonly shared: SharedBuffers
  private readonly drawTemplate: Uint32Array<ArrayBuffer>
  private readonly pipelines = new Map<PassName, { pipeline: GPUComputePipeline; group: GPUBindGroup }>()
  private readonly paramBytes = new ArrayBuffer(PARAMS_SIZE)
  private readonly paramF32 = new Float32Array(this.paramBytes)
  private readonly paramU32 = new Uint32Array(this.paramBytes)
  private readonly staging: Staging[] = []
  private cull: CullSettings = { lodDistance: 0, nearRadius: 0, density: 1, maxDistance: 1e6 }
  private frame = 0
  private readFrame = 0
  /** Until the first frame from the worker lands, the render buffers hold zeros: nobody is culled in (or drawn). */
  private uploaded = false
  /** The hide mask: agents whose figure is not drawn (a rig stands in their place), at most MAX_HIDDEN. */
  private readonly hiddenAgents: number[] = []
  private readonly sunk = new Float32Array([0, HIDDEN_Y, 0, 0])
  private timing: { set: GPUQuerySet; resolve: GPUBuffer; read: GPUBuffer; busy: boolean } | null = null

  private constructor(device: GPUDevice, shared: SharedBuffers, drawTemplate: Uint32Array<ArrayBuffer>, agentCount: number, settings: CullSettings) {
    this.device = device
    this.agentCount = agentCount
    this.shared = shared
    this.drawTemplate = drawTemplate
    this.setCull(settings)
    this.params = device.createBuffer({ label: 'crowd.cullParams', size: PARAMS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    for (let i = 0; i < 3; i++) {
      this.staging.push({
        buffer: device.createBuffer({ label: `crowd.drawn${i}`, size: CULL_READBACK_SIZE, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
        busy: false, frame: 0,
      })
    }
    const resources: Record<number, GPUBuffer> = { 0: this.params, 1: shared.pos, 10: shared.drawArgs, 11: shared.drawLists, 13: shared.look }
    const module = device.createShaderModule({ label: 'crowd.wgsl', code: crowdShader(agentCount) })
    for (const name of CULL_PASSES) {
      const pipeline = device.createComputePipeline({ label: `crowd.${name}`, layout: 'auto', compute: { module, entryPoint: name } })
      const group = device.createBindGroup({
        label: `crowd.${name}`,
        layout: pipeline.getBindGroupLayout(0),
        entries: PASS_BINDINGS[name].map((binding) => ({ binding, resource: { buffer: resources[binding] } })),
      })
      this.pipelines.set(name, { pipeline, group })
    }
  }

  /** Builds the cull pipeline and surfaces WGSL compile errors instead of failing silently later. */
  static async create(device: GPUDevice, shared: SharedBuffers, drawTemplate: Uint32Array<ArrayBuffer>, agentCount: number, settings: CullSettings): Promise<CrowdCull> {
    device.pushErrorScope('validation')
    const crowd = new CrowdCull(device, shared, drawTemplate, agentCount, settings)
    const error = await device.popErrorScope()
    if (error) throw new Error(`crowd.wgsl cull pipeline validation failed: ${error.message}`)
    return crowd
  }

  enableProfiling(): void {
    if (!this.device.features.has('timestamp-query')) return
    this.timing = {
      set: this.device.createQuerySet({ type: 'timestamp', count: 2 }),
      resolve: this.device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
      read: this.device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      busy: false,
    }
  }

  /** Draw distances and crowd density (the quality governor's knobs); takes effect on the next step(). */
  setCull(s: CullSettings): void {
    this.cull = sanitizeCull(s)
  }

  /**
   * Writes one render frame from the physics worker into the render buffers: every pos, every vel, every pose.
   * A frame of the wrong length is refused (false) and nothing is written.
   */
  upload(frame: Float32Array): boolean {
    const n = this.agentCount * 4
    if (!(frame instanceof Float32Array) || frame.length !== 3 * n) return false
    const q = this.device.queue
    q.writeBuffer(this.shared.pos, 0, frame, 0, n)
    q.writeBuffer(this.shared.vel, 0, frame, n, n)
    q.writeBuffer(this.shared.pose, 0, frame, 2 * n, n)
    this.uploaded = true
    for (const agent of this.hiddenAgents) this.sink(agent)
    return true
  }

  /**
   * Hides the figures of these agents (and shows every other hidden one again at the next upload): their position
   * in the render copy is sunk below the floor the cull pass skips, so they are never drawn. View-only: the worker's
   * crowd, and its sensing, never see it. More than MAX_HIDDEN, a non-index or the player's own figure are ignored.
   */
  hide(agents: readonly number[]): void {
    const list = this.hiddenAgents
    const next: number[] = []
    for (const a of agents) {
      if (next.length >= MAX_HIDDEN) break
      if (Number.isInteger(a) && a > 0 && a < this.agentCount && !next.includes(a)) next.push(a)
    }
    if (this.uploaded) for (const a of next) if (!list.includes(a)) this.sink(a)
    list.length = 0
    list.push(...next)
  }

  /** The agents hidden now. */
  get hidden(): readonly number[] {
    return this.hiddenAgents
  }

  private sink(agent: number): void {
    this.device.queue.writeBuffer(this.shared.pos, agent * 16, this.sunk)
  }

  /** Culls for this camera: resets the indirect draws, compacts who is drawn, and reads the counts back. */
  step(input: CullInput): void {
    this.frame++
    packCullParams(this.paramF32, this.paramU32, this.frame, this.agentCount, this.cull, input)
    const queue = this.device.queue
    queue.writeBuffer(this.params, 0, this.paramBytes)
    // Indirect draws start every frame at zero instances; the cull pass counts them back up.
    queue.writeBuffer(this.shared.drawArgs, 0, this.drawTemplate)
    const enc = this.device.createCommandEncoder({ label: 'crowd.cull' })
    const timing = this.timing && !this.timing.busy ? this.timing : null
    const pass = enc.beginComputePass({
      label: 'crowd.cull',
      timestampWrites: timing ? { querySet: timing.set, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } : undefined,
    })
    if (this.uploaded) {
      const p = this.pipelines.get('cull')!
      pass.setPipeline(p.pipeline)
      pass.setBindGroup(0, p.group)
      pass.dispatchWorkgroups(Math.ceil(this.agentCount / 128))
    }
    pass.end()
    if (timing) {
      enc.resolveQuerySet(timing.set, 0, 2, timing.resolve, 0)
      enc.copyBufferToBuffer(timing.resolve, 0, timing.read, 0, 16)
    }
    const free = this.staging.find((s) => !s.busy) ?? null
    if (free) enc.copyBufferToBuffer(this.shared.drawArgs, 0, free.buffer, 0, CULL_READBACK_SIZE)
    queue.submit([enc.finish()])
    if (timing) {
      timing.busy = true
      timing.read.mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigUint64Array(timing.read.getMappedRange())
        const ms = Number(t[1] - t[0]) / 1e6
        timing.read.unmap()
        timing.busy = false
        if (ms > 0 && ms < 1000) this.gpuMs = this.gpuMs * 0.9 + ms * 0.1
      }, () => { timing.busy = false })
    }
    if (free) {
      free.busy = true
      free.frame = this.frame
      free.buffer.mapAsync(GPUMapMode.READ).then(() => this.readback(free), () => { free.busy = false })
    }
  }

  private readback(slot: Staging): void {
    if (slot.frame > this.readFrame) {
      this.readFrame = slot.frame
      const u = new Uint32Array(slot.buffer.getMappedRange())
      let near = 0, far = 0
      for (let v = 0; v < VARIANTS; v++) {
        near += u[v * 5 + 1]
        far += u[(VARIANTS + v) * 5 + 1]
      }
      this.stats.drawnNear = near
      this.stats.drawnFar = far
    }
    slot.buffer.unmap()
    slot.busy = false
  }
}
