// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The car as plain numbers: dimensions, powertrain constants, tuning bounds, wheel layout
 * and the eight kinds of vehicle the fleet is drawn from (VEHICLE_KINDS). Both realms read it: the physics worker
 * builds and drives the Rapier vehicles from it (vehicles.ts), and the main thread draws them and maps the player's
 * controls with it (fleetView.ts, engine.ts). It imports nothing, so the page's own bundle never pulls in Rapier.
 * The kinds are two chassis classes under eight silhouettes: a light class (the sedan's box, mass and power) and a
 * heavy class (the SUV's), each proven once in vehicles.test.ts against the First Law's stopping envelope; a kind
 * picks a class and a body (its profile and scale in fleetView.ts, within DISSOLVE.reach of the class's box, so the
 * dissolve still has the mesh before the camera does). A silhouette longer than its box, a full coach or an
 * articulated bus, would need a stopping envelope of its own and is not one of these.
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

/** How a kind of vehicle is drawn and lit (fleetView.ts); its physics is its chassis class (`heavy`). */
export interface VehicleKind {
  /** Stable id, the profile's name in fleetView.ts. */
  readonly id: 'sedan' | 'pod' | 'van' | 'coach' | 'courier' | 'suv' | 'coupe' | 'utility'
  /** What the HUD calls it. */
  readonly name: string
  /** The heavy chassis class: the SUV's box (chassisBox(true)), mass, power and drag. False: the sedan's. */
  readonly heavy: boolean
  /** The body profile scaled about the chassis origin: along the car, up, across. */
  readonly scale: readonly [number, number, number]
  /** Wheel radius as a fraction of CAR.wheelRadius (the drawn wheel; the raycast wheel is the class's). */
  readonly wheel: number
  /** Extra lights: 'none', a warm 'interior' glow through the glass at night, or an amber roof 'beacon'. */
  readonly lights: 'none' | 'interior' | 'beacon'
}

/**
 * The eight kinds, in the order a kind index names them (SimMeta.kind, Vehicle.kind). The mix a fleet draws is
 * kindFromDraw below: three in ten heavy, as the fleet has always been.
 */
export const VEHICLE_KINDS: readonly VehicleKind[] = Object.freeze([
  { id: 'sedan', name: 'Executive sedan', heavy: false, scale: [1, 1, 1], wheel: 1, lights: 'none' },
  { id: 'pod', name: 'Transit pod', heavy: false, scale: [0.9, 1.08, 1], wheel: 0.85, lights: 'interior' },
  { id: 'van', name: 'Logistics van', heavy: true, scale: [1, 1.3, 1.03], wheel: 1, lights: 'none' },
  { id: 'coach', name: 'Transit coach', heavy: true, scale: [1, 1.4, 1.06], wheel: 1.05, lights: 'interior' },
  { id: 'courier', name: 'Courier robot', heavy: false, scale: [0.6, 0.75, 0.7], wheel: 0.6, lights: 'none' },
  { id: 'suv', name: 'Security SUV', heavy: true, scale: [1, 1.16, 1.03], wheel: 1.08, lights: 'none' },
  { id: 'coupe', name: 'Gullwing coupe', heavy: false, scale: [1, 0.88, 1], wheel: 1, lights: 'none' },
  { id: 'utility', name: 'Utility rig', heavy: true, scale: [1, 1.28, 1.04], wheel: 1.08, lights: 'beacon' },
].map((k) => Object.freeze({ ...k, scale: Object.freeze(k.scale) }) as VehicleKind))

/** The kind index of `id`. */
export const KIND = Object.freeze(Object.fromEntries(VEHICLE_KINDS.map((k, i) => [k.id, i])) as Record<VehicleKind['id'], number>)

/**
 * The kind one draw `u` (0 ≤ u < 1 from the fleet's seeded stream) picks. Heavy kinds take u < 0.3, light kinds the
 * rest, so `VEHICLE_KINDS[kindFromDraw(u)].heavy === u < 0.3`: the one draw that used to decide "SUV or sedan" now
 * decides the kind, and every fleet a seed laid out before keeps the same chassis class in every slot. Out of range
 * (NaN, ≥ 1, negative) is the sedan.
 */
export function kindFromDraw(u: number): number {
  if (!(u >= 0 && u < 1)) return KIND.sedan
  if (u < 0.3) return u < 0.12 ? KIND.suv : u < 0.2 ? KIND.van : u < 0.26 ? KIND.coach : KIND.utility
  return u < 0.66 ? KIND.sedan : u < 0.78 ? KIND.pod : u < 0.86 ? KIND.courier : KIND.coupe
}

/** The kind's record, the sedan's for an index that is not one. */
export function kindOf(kind: number): VehicleKind {
  return VEHICLE_KINDS[Number.isInteger(kind) && kind >= 0 && kind < VEHICLE_KINDS.length ? kind : 0]
}

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
