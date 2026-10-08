// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is what both halves of the crowd agree on. The simulation and the First-Law
 * hazard sensing run in the physics worker on its own GPU device (crowdSim.ts); the culling that picks who is
 * drawn runs on the page's render device (crowdCull.ts). Both compile the same crowd.wgsl module, assembled
 * here with the constants the CPU mirrors, and fill the same Params uniform, packed here. The byte layouts of
 * the worker's readback (counters, flags, hazard slots, then every pedestrian's render state) and of the
 * render frame the page receives are defined here too. Pure: no GPU calls.
 * What breaks if it is removed? The two devices would disagree about the shader, the uniform and the frame.
 */
import { KERNEL, SIGNAL, WALK_START, YIELD_SAVE } from '../02_Define_The_Rules/civic.ts'
import { cityWgsl, CITY_SIZE } from '../01_Initialize_World/city.ts'
import crowdSource from './crowd.wgsl?raw'
import { MAX_CARS, type CrowdStepInput } from './crowdSensor.ts'
import { ACTIVITY, INTERVIEW_DISTANCE, RECRUIT_SLOTS, SUMMON_ACCEPT, TETHER_PACE } from './skills.ts'

export { MAX_CARS }
export const VARIANTS = 4
export const PLAYER_INDEX = 0
/** `flags` bit: simulate computed a non-finite pedestrian position, velocity, heading or walk phase (the Ring-0 audit's NON_FINITE). */
export const FLAG_NON_FINITE = 1

const GRID_CELL = 2
const GRID_ORIGIN = -8
const GRID_DIM = Math.ceil((CITY_SIZE - GRID_ORIGIN * 2) / GRID_CELL)
export const GRID_CELLS = GRID_DIM * GRID_DIM
export const GRID_CAP = 8

// Byte layout of struct Params (crowd.wgsl).
const PARAMS_PLANES = 80
const PARAMS_CARS = PARAMS_PLANES + 6 * 16
/** struct Summon { at: vec2f, agent: u32, flags: u32 } × RECRUIT_SLOTS, after the cars; agent 0 is an empty slot. */
const PARAMS_SUMMONS = PARAMS_CARS + MAX_CARS * 32
export const PARAMS_SIZE = PARAMS_SUMMONS + RECRUIT_SLOTS * 16

/** Axle spacing, m (vehicles.ts CAR.wheelbase): the axles sit this far apart about the chassis centre. */
const WHEELBASE = 2.8

// First-Law hazard slots (u32 centimetres): [0, MAX_CARS) ahead, [MAX_CARS, 2·MAX_CARS) behind.
export const HAZARD_SLOTS = 2 * MAX_CARS
export const HAZARD_NONE = 0xffffffff
/** Largest draw distance sent to the GPU (WGSL leaves Infinity undefined). */
const FAR = 1e6
/** A camera distance the shader can compare against: clamped to [0, FAR], `nan` for NaN. */
const metres = (x: number, nan: number): number => (x >= 0 ? Math.min(FAR, x) : Number.isNaN(x) ? nan : 0)

// The stats words (crowd.wgsl `stats`): nudges (cumulative), waiting, crossing, retreating (reset every
// frame), flags (sticky until read back), three spare; 32 bytes keeps the buffer 16-byte aligned.
const STATS_WORDS = 8
export const STATS_SIZE = STATS_WORDS * 4
export const STATS_FLAGS = 4

/** One pedestrian's render state: pos (x, y, z, heading), vel (vx, vz, walk phase, speed), pose (tilt, bend, push angle, -). */
export const RENDER_FLOATS = 12
/** Floats in one render frame: every pos, then every vel, then every pose (the page's three storage buffers, in order). */
export const renderFrameLength = (agentCount: number): number => agentCount * RENDER_FLOATS

// The worker's readback: the stats words, the hazard slots, then the render frame (pos, vel, pose).
export const SIM_READ_HAZARDS = STATS_SIZE
export const SIM_READ_RENDER = SIM_READ_HAZARDS + HAZARD_SLOTS * 4
export const simReadbackSize = (agentCount: number): number => SIM_READ_RENDER + agentCount * RENDER_FLOATS * 4
// The page's readback: every indirect draw's args (their instance counts are what was drawn).
export const CULL_READBACK_SIZE = VARIANTS * 2 * 20

export interface CrowdStats {
  /** Instances drawn per LOD this frame (after culling, on the page). */
  drawnNear: number
  drawnFar: number
  /** The crowd's own counters (from the physics worker). */
  nudges: number
  waiting: number
  crossing: number
  retreating: number
}

export interface CarState {
  x: number
  z: number
  /** Forward = (sin heading, cos heading) in (x, z). */
  heading: number
  /** Chassis-forward speed, m/s (negative when reversing). */
  speed: number
  halfWidth: number
  halfLength: number
  /** Path curvature tan(steer) / wheelbase, 1/m, signed like steer: positive = turning left. */
  curvature: number
}

/** What the page's cull pass needs each frame. */
export interface CullInput {
  camera: { x: number; y: number; z: number }
  /** Six frustum planes as [nx, ny, nz, constant]; inside when n·p + c ≥ 0. */
  planes: Float32Array
}

/** A plane as a camera frustum gives it (three's Plane, or anything shaped like it). */
export interface PlaneLike {
  normal: { x: number; y: number; z: number }
  constant: number
}

/** Packs six frustum planes into CullInput.planes' layout ([nx, ny, nz, constant] × 6) in `out` (24 floats). */
export function packFrustumPlanes(planes: readonly PlaneLike[], out: Float32Array): Float32Array {
  if (planes.length !== 6 || out.length < 24) throw new Error('six planes into 24 floats')
  for (let i = 0; i < 6; i++) {
    const p = planes[i], o = i * 4
    out[o] = p.normal.x; out[o + 1] = p.normal.y; out[o + 2] = p.normal.z; out[o + 3] = p.constant
  }
  return out
}

/** The page's render buffers (three's storage attributes): the pedestrians' state, and the indirect draws. */
export interface SharedBuffers {
  pos: GPUBuffer
  vel: GPUBuffer
  pose: GPUBuffer
  drawArgs: GPUBuffer
  drawLists: GPUBuffer
  /** The look word per agent (look.ts; crowd.ts CrowdView.look): the cull reads the body to draw from it. */
  look: GPUBuffer
}

export interface CullSettings {
  /** Detailed bodies inside this camera distance, distant bodies beyond it. */
  lodDistance: number
  /** Everyone inside this camera distance is drawn, even outside the frustum (their shadows land in view). */
  nearRadius: number
  /** 0..1 fraction of agents beyond nearRadius that are drawn — a stable per-agent hash so the same people stay visible. */
  density: number
  /** No agent is drawn beyond this camera distance. */
  maxDistance: number
}

export function agentQuota(agentCount: number): number {
  return Math.ceil(agentCount / VARIANTS)
}

/**
 * Metres from a car's centre beyond which nobody is in its First-Law corridor, driving on or reversing
 * (the shader skips both corridor tests past it). Every footprint point lies within |(halfLength, half)|
 * of the centre and, over KERNEL.range of travel, moves at most min(2ρ, ρ·k·range) (a chord is never
 * longer than its arc or the diameter), ρ ≤ ρmax its distance from the turn centre; straight, the
 * footprint just slides KERNEL.range along its axis. Plus a centimetre for f32.
 */
export function corridorReach(c: CarState): number {
  const half = c.halfWidth + KERNEL.corridor
  const k = Number.isFinite(c.curvature) ? Math.abs(c.curvature) : 0
  if (k < 1e-6) return Math.hypot(c.halfLength + KERNEL.range, half) + 0.01
  const rhoK = Math.hypot((c.halfLength + WHEELBASE / 2) * k, 1 + half * k) // k·ρmax
  return Math.hypot(c.halfLength, half) + Math.min((2 * rhoK) / k, KERNEL.range * rhoK) + 0.01
}

function header(agentCount: number): string {
  const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`)
  const quota = agentQuota(agentCount)
  return [
    cityWgsl(),
    `const GRID_CELL: f32 = ${f(GRID_CELL)};`,
    `const GRID_ORIGIN: f32 = ${f(GRID_ORIGIN)};`,
    `const GRID_DIM: i32 = ${GRID_DIM};`,
    `const GRID_CELLS: u32 = ${GRID_CELLS}u;`,
    `const GRID_CAP: u32 = ${GRID_CAP}u;`,
    `const MAX_CARS: u32 = ${MAX_CARS}u;`,
    `const HAZARD_SLOTS: u32 = ${HAZARD_SLOTS}u;`,
    `const VARIANTS: u32 = ${VARIANTS}u;`,
    `const AGENT_QUOTA: u32 = ${quota}u;`,
    `const LIST_LOD_STRIDE: u32 = ${quota * VARIANTS}u;`,
    `const PLAYER_INDEX: u32 = ${PLAYER_INDEX}u;`,
    `const SIGNAL_CYCLE: f32 = ${f(SIGNAL.cycle)};`,
    `const SIGNAL_EW_AMBER: f32 = ${f(SIGNAL.ewAmber)};`,
    `const SIGNAL_WALK: f32 = ${f(SIGNAL.walkSeconds)};`,
    `const YIELD_MOD: i32 = ${YIELD_SAVE.modifier};`,
    `const YIELD_DC: i32 = ${YIELD_SAVE.baseDc};`,
    `const YIELD_DC_BONUS: f32 = ${f(YIELD_SAVE.maxDcBonus)};`,
    `const YIELD_LOOKAHEAD: f32 = ${f(YIELD_SAVE.lookahead)};`,
    `const WALK_MOD: i32 = ${WALK_START.modifier};`,
    `const WALK_DC: i32 = ${WALK_START.dc};`,
    ...WALK_START.delay.map((d, k) => `const WALK_DELAY_${k}: f32 = ${f(d)};`),
    `const KERNEL_CORRIDOR: f32 = ${f(KERNEL.corridor)};`,
    `const KERNEL_RANGE: f32 = ${f(KERNEL.range)};`,
    `const CAR_AXLE: f32 = ${f(WHEELBASE / 2)};`,
    `const FLAG_NON_FINITE: u32 = ${FLAG_NON_FINITE}u;`,
    `const SUMMON_SLOTS: u32 = ${RECRUIT_SLOTS}u;`,
    `const SUMMON_STOP: f32 = ${f(INTERVIEW_DISTANCE)};`,
    `const SUMMON_ACCEPT: f32 = ${f(SUMMON_ACCEPT)};`,
    `const TETHER_PACE: f32 = ${f(TETHER_PACE)};`,
    ...Object.entries(ACTIVITY).map(([k, v]) => `const ACT_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}: f32 = ${f(v)};`),
    '',
  ].join('\n')
}

/** The complete WGSL module: shared constants from the CPU, then crowd.wgsl. */
export function crowdShader(agentCount: number): string {
  return header(agentCount) + crowdSource
}

export type PassName = 'clearGrid' | 'binAgents' | 'spawn' | 'simulate' | 'cull'

/**
 * Bindings each entry point statically uses; `layout: 'auto'` gives each pipeline exactly these, so
 * listing one a pass does not use (or missing one it does) fails bind group validation.
 */
export const PASS_BINDINGS: Readonly<Record<PassName, readonly number[]>> = {
  clearGrid: [5],
  binAgents: [0, 1, 2, 5, 6],
  spawn: [0, 1, 2, 3, 4],
  simulate: [0, 1, 2, 3, 4, 7, 8, 9, 12],
  cull: [0, 1, 10, 11, 13],
}
/** The passes the physics worker runs (simulation and First-Law sensing), and the one the page runs (drawing). */
export const SIM_PASSES: readonly PassName[] = ['clearGrid', 'binAgents', 'spawn', 'simulate']
export const CULL_PASSES: readonly PassName[] = ['cull']

/** A copy of cull settings the shader can use: distances clamped to [0, FAR], density to [0, 1], NaN made harmless. */
export function sanitizeCull(s: CullSettings): CullSettings {
  return {
    lodDistance: metres(s.lodDistance, 0),
    nearRadius: metres(s.nearRadius, 0),
    // NaN counts as "draw everyone" rather than silently emptying the street.
    density: s.density >= 0 ? Math.min(1, s.density) : Number.isNaN(s.density) ? 1 : 0,
    maxDistance: metres(s.maxDistance, FAR),
  }
}

/** The Params words the simulation reads (the cull fields stay zero: the worker draws nothing). */
export function packSimParams(f: Float32Array, u: Uint32Array, frame: number, agentCount: number, input: CrowdStepInput): void {
  packCrowdParams(f, u, frame, agentCount, input)
  // Whoever the operator asked over. Only a real pedestrian (never the player's own body, never out of range) at a
  // finite spot takes a slot, each once; anything else leaves the slot empty (agent 0), and so the person's day alone.
  const summons = input.summons ?? []
  let slot = 0
  for (let k = 0; k < summons.length && slot < RECRUIT_SLOTS; k++) {
    const m = summons[k]
    if (!(Number.isInteger(m.agent) && m.agent > PLAYER_INDEX && m.agent < agentCount)) continue
    if (!(Number.isFinite(m.x) && Number.isFinite(m.z) && Number.isFinite(Math.fround(m.x)) && Number.isFinite(Math.fround(m.z)))) continue
    let dup = false
    for (let j = 0; j < slot; j++) if (u[PARAMS_SUMMONS / 4 + j * 4 + 2] === m.agent) dup = true
    if (dup) continue
    const o = PARAMS_SUMMONS / 4 + slot * 4
    // flags: bit 0 a summons, bit 1 tethered (Active).
    f[o] = m.x; f[o + 1] = m.z; u[o + 2] = m.agent; u[o + 3] = m.tethered === true ? 3 : 1
    slot++
  }
}

function packCrowdParams(f: Float32Array, u: Uint32Array, frame: number, agentCount: number, input: CrowdStepInput): void {
  f.fill(0)
  const cars = Math.min(input.cars.length, MAX_CARS)
  f[0] = input.dt
  f[1] = input.time
  u[2] = frame
  u[3] = agentCount
  u[4] = cars
  f[5] = input.time
  f[8] = input.player.x; f[9] = input.player.z; f[10] = input.player.heading; f[11] = input.player.speed
  f[12] = input.player.visible ? 1 : 0
  for (let j = 0; j < cars; j++) {
    const c = input.cars[j]
    const o = PARAMS_CARS / 4 + j * 8
    f[o] = c.x; f[o + 1] = c.z; f[o + 2] = c.heading; f[o + 3] = c.speed
    // A missing, NaN or infinite curvature would bend the First-Law corridor unpredictably (WGSL leaves
    // non-finite values undefined); sense a straight path instead.
    f[o + 4] = c.halfWidth; f[o + 5] = c.halfLength; f[o + 6] = Number.isFinite(c.curvature) ? c.curvature : 0
    f[o + 7] = corridorReach(c)
  }
}

/** The Params words the cull pass reads: draw distances, density, the camera and its frustum. */
export function packCullParams(f: Float32Array, u: Uint32Array, frame: number, agentCount: number, cull: CullSettings, input: CullInput): void {
  f.fill(0)
  u[2] = frame
  u[3] = agentCount
  f[6] = cull.lodDistance
  f[7] = cull.nearRadius
  f[13] = cull.density; f[14] = cull.maxDistance
  f[16] = input.camera.x; f[17] = input.camera.y; f[18] = input.camera.z
  f.set(input.planes.subarray(0, 24), PARAMS_PLANES / 4)
}

/** One hazard slot to metres: HAZARD_NONE is nobody (Infinity), otherwise whole centimetres. */
export const decodeHazard = (cm: number): number => (cm === HAZARD_NONE ? Infinity : cm / 100)
