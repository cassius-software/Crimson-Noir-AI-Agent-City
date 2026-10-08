// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The car as plain numbers: dimensions, powertrain constants, tuning bounds and
 * wheel layout. Both realms read it: the physics worker builds and drives the Rapier vehicles from it
 * (vehicles.ts), and the main thread draws them and maps the player's controls with it (fleetView.ts,
 * engine.ts). It imports nothing, so the page's own bundle never pulls in Rapier.
 * What breaks if it is removed? The two realms would each need their own copy of the car, and could drift.
 */

export const CAR = {
  halfLength: 2.3,
  halfWidth: 0.92,
  /** Kerb mass, kg. */
  mass: 1300,
  suvMass: 1700,
  wheelRadius: 0.34,
  suspension: 0.3,
  /** Axle spacing and track between wheel centres, m. */
  wheelbase: 2.8,
  track: 1.6,
  /** Drive force per driven (rear) wheel at full throttle, N, until the power limit takes over (SUV ×1.25). */
  engine: 2600,
  /** Peak power at the wheels, W: drive force is capped at power / speed. */
  power: 90_000,
  suvPower: 120_000,
  maxSteer: 0.6,
  /** Aerodynamic drag coefficient and frontal area (m²). */
  dragCoefficient: 0.3,
  frontalArea: 2.2,
  suvDragCoefficient: 0.38,
  suvFrontalArea: 2.8,
  /** Rolling resistance coefficient, passenger tyre on asphalt. */
  rollingResistance: 0.013,
  /** Engine braking in gear with the throttle closed, N per m/s. */
  engineBraking: 12,
  /** Tyre friction slip: the peak tyre-road friction coefficient on dry asphalt. */
  frictionSlip: 1.0,
  /** Deceleration the handbrake alone gives through the rear wheels, m/s². */
  handbrake: 3.7,
} as const

/**
 * The chassis collider in chassis space: a cuboid of half extents (hx along the car, hy up, hz across), raised y
 * above the chassis origin. The physics worker builds each car's collider from it (vehicles.ts); the page's ghost
 * view draws the same box (ghost.ts).
 */
export interface ChassisBox { readonly hx: number; readonly hy: number; readonly hz: number; readonly y: number }

/** The two boxes, frozen and shared: every per-frame scan (contact.ts, dissolve.ts) reads them without allocating. */
const CHASSIS: readonly [ChassisBox, ChassisBox] = Object.freeze([
  Object.freeze({ hx: CAR.halfLength - 0.05, hy: 0.38, hz: CAR.halfWidth - 0.04, y: 0.3 }),
  Object.freeze({ hx: CAR.halfLength - 0.05, hy: 0.48, hz: CAR.halfWidth - 0.04, y: 0.38 }),
])

export function chassisBox(suv: boolean): ChassisBox {
  return CHASSIS[suv ? 1 : 0]
}

/** Wheel centres in chassis space: +x forward, +z to the car's right. Front-right, front-left, rear-right, rear-left. */
export const WHEELS: readonly (readonly [number, number])[] = [
  [CAR.wheelbase / 2, CAR.track / 2], [CAR.wheelbase / 2, -CAR.track / 2],
  [-CAR.wheelbase / 2, CAR.track / 2], [-CAR.wheelbase / 2, -CAR.track / 2],
]
/** Origin height of a settled chassis above the ground (measured in calibration). */
export const RIDE_HEIGHT = 0.56

export type DriveMode = 'ai' | 'player' | 'parked'

/**
 * Scale factors the Ring-0 operator may set on the fleet (1 = the authored car). The bounds keep the First
 * Law's stopping envelope honest: grip and brakes can only be made stronger, never weaker, so no tuning can
 * lengthen a stop past what laws.ts assumes.
 */
export interface CarTuning {
  /** Engine peak force and power. */
  power: number
  /** Aerodynamic drag. */
  drag: number
  /** Tyre friction (≥ 1). */
  grip: number
  /** Service and hand brake strength (≥ 1). */
  brake: number
}
export const CAR_TUNE_RANGE: Readonly<Record<keyof CarTuning, readonly [number, number]>> = {
  power: [0.25, 2], drag: [0.5, 3], grip: [1, 1.5], brake: [1, 1.5],
}

/** Clamps a tuning value into CAR_TUNE_RANGE; a non-finite value resets to the authored 1. */
export function clampTuning(key: keyof CarTuning, value: number): number {
  const [lo, hi] = CAR_TUNE_RANGE[key]
  return Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : 1
}
