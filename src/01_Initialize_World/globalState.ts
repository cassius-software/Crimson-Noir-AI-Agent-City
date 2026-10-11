// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? Matrix mode's one global state, as numbers: the four floats every pipeline that takes the
 * mode reads (x = time, y = matrix mode, z and w = the floating origin), the physics layers and the mask the crowd's
 * compute shader applies (03_Spawn_Agents/crowd.wgsl physicsMaskFor mirrors physicsMaskFor here), the origin's snap,
 * and the one packer both uniforms go through (matrixMode.ts for the materials' vec4, 03_Spawn_Agents/crowdCompute.ts
 * for the crowd's Params.global), so the page's materials and the physics worker's crowd cannot disagree about what
 * the mode is or where the origin sits. Pure and three-free: the physics worker (crowdSim.ts through crowdCompute.ts)
 * imports it, and the worker never loads three.
 * What breaks if it is removed? The crowd's Params has no global word to pack and the materials' uniform no layout.
 */
/** The global state, as the shaders read it (one vec4f, GLOBAL_STATE_FLOATS wide). */
export interface GlobalState {
  /** Seconds on the clock both pipelines share (the physics realm's). */
  time: number
  /** Matrix mode on. */
  on: boolean
  /** The floating origin, metres: the camera's (x, z) snapped (floatingOrigin). */
  originX: number
  originZ: number
}

/** Floats in the packed state: x = time, y = mode, z = origin x, w = origin z. */
export const GLOBAL_STATE_FLOATS = 4

/** The look and the numbers. Frozen: policy, not tuning. */
export const MATRIX_MODE = Object.freeze({
  /** The origin snaps to whole multiples of this, m: a multiple of the code's cell (0.1 m), so the pattern's cell ids stay whole numbers. */
  originSnap: 1,
  /** Origins are kept inside ±this, m (2^24: the shaders add origin × 10 back as a whole number, exact in f32 below 2^24). */
  originLimit: 1_600_000,
})

/**
 * The physics layers a pedestrian's mask selects (crowd.wgsl simulate), one bit each. The static world (the ground
 * that holds everyone at y = 0, the lots' boxes that pushOut keeps everyone out of, the city's edge) is bit 0; the
 * other pedestrians are bit 1; the cars are bit 2.
 */
export const PHYSICS_LAYER = Object.freeze({ world: 0x1, body: 0x2, vehicle: 0x4 })

/** The mask: every layer, or (matrix mode) the static world alone, so non-building objects phase through each other but stay grounded. */
export const PHYSICS_MASK = Object.freeze({ all: 0xffffffff, matrix: 0x00000001 })

/** The mask a pedestrian carries this tick, from the global state's y (the shader computes the same: crowd.wgsl physicsMaskFor). */
export const physicsMaskFor = (on: boolean): number => (on ? PHYSICS_MASK.matrix : PHYSICS_MASK.all)

/** A finite number, or `fallback`. */
const finite = (x: number, fallback: number): number => (Number.isFinite(x) ? x : fallback)

/**
 * The floating origin for a camera at (x, z): snapped down to a whole multiple of MATRIX_MODE.originSnap, held inside
 * ±originLimit, 0 for a non-finite camera. The shaders subtract it before their fract() terms and add it back (times
 * ten, a whole number) into the cell id, so the pattern is the same wherever the camera stands and nothing slides as
 * the origin steps.
 */
export function floatingOrigin(x: number, z: number): { x: number; z: number } {
  const snap = MATRIX_MODE.originSnap, lim = MATRIX_MODE.originLimit
  const at = (v: number) => Math.max(-lim, Math.min(lim, Math.floor(finite(v, 0) / snap) * snap))
  return { x: at(x), z: at(z) }
}

/** Packs the state into `out` at `offset` (four floats) the way both shaders read it; non-finite numbers become 0. */
export function packGlobalState(out: Float32Array, offset: number, s: GlobalState | undefined): void {
  out[offset] = s ? finite(s.time, 0) : 0
  out[offset + 1] = s?.on ? 1 : 0
  out[offset + 2] = s ? finite(s.originX, 0) : 0
  out[offset + 3] = s ? finite(s.originZ, 0) : 0
}
