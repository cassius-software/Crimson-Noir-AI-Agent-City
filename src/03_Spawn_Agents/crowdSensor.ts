// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the contract between the physics realm's simulation (simCore.ts) and the
 * GPU pedestrian sensor that lives beside it in the worker (crowdSim.ts): what the simulation hands the crowd
 * each step (the cars, the avatar, the clock, and whoever the operator has asked over), and what the crowd
 * reports back — every car's First-Law hazard distances, the Ring-0 flags, the crowd's counters, where every
 * pedestrian stands and what they are doing (the worker's own copy, for recruitment), and the pedestrians'
 * render state for the page. Types and constants only (no WGSL, no GPU), so the node tests can drive SimCore
 * with a stand-in sensor.
 * What breaks if it is removed? SimCore could only talk to one concrete GPU class, and nothing could test it.
 */
import type { CarState } from './crowdCompute.ts'

/** Cars the GPU senses (hazard slots): the fleet is never larger, so no car drives unsensed. */
export const MAX_CARS = 48
/** Pedestrians the crowd simulates (the page's ?crowd bounds, enforced again in the worker). */
export const AGENTS_RANGE: readonly [number, number] = [256, 60000]

/**
 * Fastest a pedestrian can move, m/s: simulate caps every velocity at 3 m/s (crowd.wgsl, `if (sp > 3.0)`). A
 * stale hazard reading is shortened by how far the person can have walked toward the car since it was taken.
 */
export const PEDESTRIAN_MAX_SPEED = 3.0

/** The crowd's counters from one readback. */
export interface CrowdSimStats {
  /** Safety nudges since the start (a car touched someone and pushed them clear). */
  nudges: number
  /** Pedestrians waiting at a kerb for the walk signal, crossing on it, and stepping back from a car, this step. */
  waiting: number
  crossing: number
  retreating: number
}

/** One person the operator has asked over (skills.ts): they walk to (x, z), the operator, and stop there. */
export interface Summon {
  /** Pedestrian index, 1…agentCount − 1 (0 is the player's own body and is never summoned). */
  agent: number
  x: number
  z: number
  /** Active: they have arrived once and follow the operator, hurrying at TETHER_PACE when they fall behind. */
  tethered?: boolean
}

/** What one crowd step is given: this realm's cars, the avatar as the player's own body, its clock, and the summons. */
export interface CrowdStepInput {
  /** The caller's number for this step, echoed by its readback (so the caller knows exactly which step it measured). */
  seq: number
  dt: number
  /** Simulation seconds on the physics realm's clock: the signals the cars obey, and the crowd's dice. */
  time: number
  player: { x: number; z: number; heading: number; speed: number; visible: boolean }
  cars: readonly CarState[]
  /** At most RECRUIT_SLOTS (skills.ts); an invalid one is left out of the uniform. */
  summons: readonly Summon[]
}

/** The newest decoded readback. */
export interface CrowdReadout {
  /** The `seq` of the step this readback measured. */
  seq: number
  /**
   * The physics realm's clock at the positions this readback measured, s: the start of the last crowd substep
   * (simulate senses each pedestrian before moving it). SimCore ages the reading from here.
   */
  time: number
  /** Per car: metres before its widened footprint reaches the nearest pedestrian, ahead and reversing (Infinity: nobody). */
  hazardsAhead: Float32Array
  hazardsBehind: Float32Array
  stats: CrowdSimStats
  /** Every pedestrian's (x, z) where this readback measured them, 2 floats per agent: the worker's own copy. */
  xz: Float32Array
  /** Every pedestrian's ACTIVITY (skills.ts) in this readback. */
  activity: Uint8Array
  /** Every pedestrian's facing (pos.w, radians, atan2(x, z)) in this readback; absent from a sensor that has none. */
  heading?: Float32Array
}

/** The GPU pedestrian sensor as SimCore sees it. */
export interface CrowdSensor {
  readonly agentCount: number
  /** Dispatches one crowd step; its readback resolves later, between steps. */
  step(input: CrowdStepInput): void
  /** The newest readback, or null before the first has resolved. */
  readonly readout: CrowdReadout | null
  /** Ring-0 flags raised since the last call (FLAG_NON_FINITE …), then cleared: none is ever lost between two audits. */
  takeFlags(): number
  /** The newest pedestrian render state not yet taken (pos, vel, pose: 12 floats per agent), or null. */
  takeFrame(): Float32Array | null
  /** A render frame's buffer handed back (by the page, through the host) for the next readback to fill. */
  recycle(buffer: ArrayBuffer): void
  /** Why the sensor stopped working for good (device lost), or null. */
  readonly lost: string | null
  /**
   * Puts pedestrian `agent` at (x, z) facing `heading`, standing, before the next step (a ragdoll handed back where its
   * rig stood: ragdollRealm.ts). Absent from a sensor that cannot be written.
   */
  place?(agent: number, x: number, z: number, heading: number): void
  /**
   * Routes the pedestrians asked over towards (x, z): the flow field (06_Make_Decisions/flowField.ts) is solved for
   * the cell under that point and lands before a later step. Absent from a sensor that has no field.
   */
  routeTo?(x: number, z: number): void
}
