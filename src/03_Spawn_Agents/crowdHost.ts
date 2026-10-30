// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the GPU crowd (crowdSim.ts) run on the CPU: the same crowd.wgsl, compiled to
 * JavaScript by wgslHost.ts, over the same buffers in the same byte layouts, stepped in the same substeps with the
 * same uniform (packSimParams), the counters and hazard slots reset the same way, and read back into the same
 * CrowdReadout. SimCore takes it through the CrowdFactory exactly as it takes the GPU one, so a Node test drives
 * the whole realm (the Rapier fleet, the Sanctuary, the Ring-0 audit and the shipped pedestrians together) for
 * thousands of ticks: the agent-and-car soaks (crowdSoak.test.ts). A reading can be held back `latency` steps, as
 * the GPU's readback lands a frame or more after its dispatch. The pedestrians' buffers are open to the test
 * (`state`), which the GPU's never are. Nothing here is imported by the page or the worker.
 * What breaks if it is removed? The realm can only be soaked against a stand-in crowd that never pushes anyone,
 * so a pedestrian pinned on a car, or a car held by a pedestrian, is found by a player and not by a test.
 */
import {
  crowdShader, decodeHazard, geometryOf, GRID_CAP, GRID_CELLS, HAZARD_NONE, HAZARD_SLOTS, MAX_CARS, packSimParams, PARAMS_SIZE, RENDER_FLOATS, STATS_FLAGS,
  STATS_SIZE,
} from './crowdCompute.ts'
import { AGENTS_RANGE, type CrowdReadout, type CrowdSensor, type CrowdStepInput } from './crowdSensor.ts'
import { CROWD_SUBSTEP } from './crowdSim.ts'
import { OperatorTrail } from './skills.ts'
import { compileWgsl, hostBuffer, type HostBuffer, type HostModule, type HostTexture } from './wgslHost.ts'
import { cpuFlowSolver, nearestOpen, type FlowGrid, type FlowSolver } from '../06_Make_Decisions/flowField.ts'
import { packStreets, type StreetGrid } from '../01_Initialize_World/region/streets.ts'
import { packRooms, type Workplace } from '../01_Initialize_World/interiors.ts'
import { packRoutes } from '../01_Initialize_World/region/workplaces.ts'

export interface CrowdHostOptions {
  /** Steps a reading takes to reach the realm (the GPU's readback lands later than its dispatch); 0 lands at once. */
  latency?: number
}

/** One step's reading, held until its turn. */
interface Snapshot {
  seq: number
  time: number
  stats: Uint32Array
  hazards: Uint32Array
  frame: Float32Array
}

export class CrowdHost implements CrowdSensor {
  readonly agentCount: number
  readonly lagMs = 0
  readonly #module: HostModule
  readonly #params: HostBuffer
  readonly #pos: HostBuffer
  readonly #vel: HostBuffer
  readonly #pose: HostBuffer
  readonly #brain: HostBuffer
  readonly #stats: HostBuffer
  readonly #hazards: HostBuffer
  readonly #flow: HostTexture
  readonly #grid: FlowGrid | null
  readonly #solver: FlowSolver | null
  #goal = -1
  readonly #streets: Uint32Array | undefined
  readonly #rooms: Float32Array | undefined
  readonly #routes: Uint32Array | undefined
  readonly #trail = new OperatorTrail()
  readonly #latency: number
  readonly #queue: Snapshot[] = []
  readonly #readout: CrowdReadout
  #haveReadout = false
  #frame = 0
  #flags = 0
  #pendingFrame: Float32Array | null = null
  readonly #pool: ArrayBuffer[] = []

  constructor(agentCount: number, grid: FlowGrid | null = null, streets: StreetGrid | null = null, rooms: readonly Workplace[] | null = null, opts: CrowdHostOptions = {}) {
    const [lo, hi] = AGENTS_RANGE
    if (!(Number.isInteger(agentCount) && agentCount >= lo && agentCount <= hi)) throw new Error(`agents must be ${lo}–${hi}, got ${agentCount}`)
    this.agentCount = agentCount
    this.#grid = grid
    this.#latency = Math.max(0, Math.floor(opts.latency ?? 0))
    this.#streets = streets ? packStreets(streets) : undefined
    this.#rooms = rooms && rooms.length > 0 ? packRooms(rooms) : undefined
    this.#routes = streets && rooms && rooms.length > 0 ? packRoutes(rooms, streets) : undefined
    const placement = grid ? { originX: grid.originX, originZ: grid.originZ, cell: grid.cell } : undefined
    this.#module = compileWgsl(crowdShader(agentCount, placement, streets ? geometryOf(streets) : undefined))
    this.#params = hostBuffer(PARAMS_SIZE)
    this.#pos = hostBuffer(agentCount * 16)
    this.#vel = hostBuffer(agentCount * 16)
    this.#pose = hostBuffer(agentCount * 16)
    this.#brain = hostBuffer(agentCount * 64)
    const gridCount = hostBuffer(GRID_CELLS * 4)
    const gridSlots = hostBuffer(GRID_CELLS * GRID_CAP * 16)
    this.#stats = hostBuffer(STATS_SIZE)
    this.#hazards = hostBuffer(HAZARD_SLOTS * 4)
    this.#hazards.u.fill(HAZARD_NONE)
    // The flow texture (flowFieldGpu.ts rg32float): one direction per cell, zero until a route is asked for.
    this.#flow = { width: grid?.width ?? 1, height: grid?.height ?? 1, channels: 2, data: new Float32Array((grid?.width ?? 1) * (grid?.height ?? 1) * 2) }
    const m = this.#module
    m.bind('P', this.#params)
    m.bind('pos', this.#pos); m.bind('vel', this.#vel); m.bind('pose', this.#pose); m.bind('brain', this.#brain)
    m.bind('gridCountW', gridCount); m.bind('gridSlotsW', gridSlots); m.bind('gridCountR', gridCount); m.bind('gridSlotsR', gridSlots)
    m.bind('stats', this.#stats); m.bind('hazards', this.#hazards); m.bind('flowField', this.#flow)
    this.#solver = grid ? cpuFlowSolver(grid, (solution) => { this.#flow.data.set(solution.dir) }) : null
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
    this.#spawn()
    Object.freeze(this)
  }

  /** The pedestrians' own buffers as the shader keeps them (pos: x, y, z, heading; vel: vx, vz, phase, speed; pose; brain), live. */
  get state(): { pos: Float32Array; vel: Float32Array; pose: Float32Array; brain: Float32Array } {
    return { pos: this.#pos.f, vel: this.#vel.f, pose: this.#pose.f, brain: this.#brain.f }
  }

  /** The generated JavaScript of the compiled shader. */
  get js(): string {
    return this.#module.js
  }

  get readout(): CrowdReadout | null {
    return this.#haveReadout ? this.#readout : null
  }

  get lost(): string | null {
    return null
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

  place(agent: number, x: number, z: number, heading: number): void {
    if (!(Number.isInteger(agent) && agent > 0 && agent < this.agentCount)) return
    if (![x, z, heading].every(Number.isFinite)) return
    this.#pos.f.set([x, 0, z, heading], agent * 4)
    this.#vel.f.fill(0, agent * 4, agent * 4 + 4)
  }

  routeTo(x: number, z: number): void {
    const grid = this.#grid, solver = this.#solver
    if (!grid || !solver || !Number.isFinite(x) || !Number.isFinite(z)) return
    const goal = nearestOpen(grid, x, z)
    if (goal < 0 || goal === this.#goal) return
    this.#goal = goal
    // The CPU solver lands the field synchronously (the promise only reports it).
    void solver.solve([goal])
  }

  #spawn(): void {
    const p = this.#params
    packSimParams(p.f, p.u, 0, this.agentCount, { seq: 0, dt: 0, time: 0, player: { x: 0, z: 0, heading: 0, speed: 0, visible: false }, cars: [], summons: [] }, this.#streets, this.#rooms, this.#routes)
    this.#module.dispatch('spawn', Math.ceil(this.agentCount / 128))
  }

  /** One crowd step of `input.dt` in substeps of at most CROWD_SUBSTEP, each with its own uniform, as crowdSim.ts steps. */
  step(input: CrowdStepInput): void {
    const dt = input.dt > 0 ? input.dt : 0
    const k = Math.max(1, Math.ceil(dt / CROWD_SUBSTEP - 1e-9))
    const h = dt / k
    const p = this.#params
    this.#trail.update(input.player.x, input.player.z, input.player.visible)
    for (let sub = 1; sub <= k; sub++) {
      this.#frame++
      packSimParams(p.f, p.u, this.#frame, this.agentCount, { ...input, dt: h, time: input.time - dt + h * sub }, this.#streets, this.#rooms, this.#routes, this.#trail)
      // stats[0] (safety nudges) is cumulative and stats[4] (the Ring-0 flags) sticky; the per-step counters between
      // them, and the working count after them, are reset. Every car starts the step seeing nobody.
      this.#stats.u.fill(0, 1, 4)
      this.#stats.u[5] = 0
      this.#hazards.u.fill(HAZARD_NONE)
      this.#module.dispatch('clearGrid', Math.ceil(GRID_CELLS / 256))
      this.#module.dispatch('binAgents', Math.ceil(this.agentCount / 128))
      this.#module.dispatch('simulate', Math.ceil(this.agentCount / 128))
    }
    // The reading is stamped with the last substep's start, as the GPU's is; the flags leave with it and are cleared.
    const n = this.agentCount * 4
    const frame = new Float32Array(this.#pool.pop() ?? new ArrayBuffer(this.agentCount * RENDER_FLOATS * 4))
    frame.set(this.#pos.f, 0)
    frame.set(this.#vel.f, n)
    frame.set(this.#pose.f, 2 * n)
    const stats = this.#stats.u.slice()
    if (stats[STATS_FLAGS] !== 0) this.#stats.u[STATS_FLAGS] = 0
    this.#queue.push({ seq: input.seq, time: input.time - h, stats, hazards: this.#hazards.u.slice(), frame })
    // The first reading lands at once (the realm primes on it, as on the GPU's first readback); later ones wait their turn.
    while (this.#queue.length > this.#latency || !this.#haveReadout) this.#deliver(this.#queue.shift()!)
  }

  #deliver(s: Snapshot): void {
    const r = this.#readout
    r.seq = s.seq
    r.time = s.time
    r.stats.nudges = s.stats[0]
    r.stats.waiting = s.stats[1]
    r.stats.crossing = s.stats[2]
    r.stats.retreating = s.stats[3]
    r.stats.working = s.stats[5]
    this.#flags |= s.stats[STATS_FLAGS]
    for (let j = 0; j < MAX_CARS; j++) {
      r.hazardsAhead[j] = decodeHazard(s.hazards[j])
      r.hazardsBehind[j] = decodeHazard(s.hazards[MAX_CARS + j])
    }
    const frame = s.frame, pose = 8 * this.agentCount
    for (let i = 0; i < this.agentCount; i++) {
      r.xz[2 * i] = frame[4 * i]
      r.xz[2 * i + 1] = frame[4 * i + 2]
      r.heading![i] = frame[4 * i + 3]
      r.activity[i] = frame[pose + 4 * i + 3]
    }
    this.#haveReadout = true
    if (this.#pendingFrame) this.recycle(this.#pendingFrame.buffer as ArrayBuffer)
    this.#pendingFrame = frame
  }
}

Object.freeze(CrowdHost.prototype)
Object.freeze(CrowdHost)
