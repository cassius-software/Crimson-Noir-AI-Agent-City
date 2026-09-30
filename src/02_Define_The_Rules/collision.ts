/**
 * Why does this file exist? It is the 14A physics contract in one record: what may exchange contact in the realm's
 * Rapier world and what never does. Cars pass through cars (no vehicle-on-vehicle contact), no ragdoll is wired into
 * the realm, there is no combat, street furniture is sensors (the ghost-mode law, physics.ts), and people and cars
 * meet only through the Sanctuary (sanctuary.ts), which flips a person to a sensor before a car can reach them. It
 * also holds the realm's group bit table and the packed interaction groups the fleet gives its chassis colliders and
 * its wheel rays (vehicles.ts). It is pure — no Rapier import — so it runs in Node without WASM and the page may
 * import it; collision.test.ts is the structural guard that keeps the ragdoll unwired and the bit table from drifting.
 * What breaks if it is removed? Two cars could exchange impulses again (a car pushed into a person's path by
 * another car), a wheel could ride up on a car it passes through, and nothing would say in one place what the
 * realm's contact policy is.
 */

/** The contact policy of the realm, beside CIVIC's `violence: false` (civic.ts). Frozen: policy, not tuning. */
export const COLLISION = Object.freeze({
  /** Chassis never exchange contact with chassis; cars pass through cars. */
  vehicleOnVehicle: false,
  /** No ragdoll is wired into the realm (03_Spawn_Agents/ragdoll*.ts is scaffolding nothing imports). */
  ragdoll: false,
  /** There is no combat: no module, no rule, no vocabulary. */
  combat: false,
  /** Lamps, trees and signal poles are in the world as sensors: found by queries, never solid. */
  furniture: 'sensor',
  /** People and cars meet only through the Sanctuary's Solid -> Sensor flip and its nudge. */
  peopleAndCars: 'sanctuary',
} as const)

/**
 * The realm's group bits (one 16-bit membership word, one 16-bit filter word per collider). Rapier's rule: two
 * colliders interact iff (a.membership & b.filter) != 0 and (b.membership & a.filter) != 0. Everything the realm
 * does not name (ground, buildings, seawall, pier, the avatar capsule, furniture) keeps Rapier's default of all
 * bits in both words, so it meets everything that lets it.
 */
export const GROUP = Object.freeze({
  /** A ray or query that is not a body: a wheel ray. */
  query: 0x0001,
  /** A vehicle chassis. */
  vehicle: 0x0002,
  /** Reserved for the ragdoll scaffold's segments (ragdollRig.ts RAGDOLL_GROUP); the realm never sets it. */
  ragdoll: 0x0004,
} as const)

/** Rapier's default membership and filter: every bit. */
export const ALL_GROUPS = 0xffff

/** Packs a membership word and a filter word the way Rapier reads them: (membership << 16) | filter, as a u32. */
export function interactionGroups(membership: number, filter: number): number {
  return (((membership & 0xffff) << 16) | (filter & 0xffff)) >>> 0
}

/**
 * A chassis is a member of `vehicle` and filters `vehicle` out: chassis vs chassis has no common bit in either
 * direction, so the broad phase never pairs them (no contact, no impulse). Against anything with default groups
 * (ground, buildings, the avatar) both tests pass, so a car is as solid as ever to the world and to people.
 */
export const VEHICLE_CHASSIS_GROUPS = interactionGroups(GROUP.vehicle, ALL_GROUPS & ~GROUP.vehicle)

/**
 * A wheel ray is a `query` that filters `vehicle` out: it finds the road (default groups) but never another
 * chassis, so a car cannot ride up on a car it passes through. The flags Fleet passes beside it (EXCLUDE_SENSORS |
 * EXCLUDE_KINEMATIC) keep the wheels off people; the groups are an addition to those flags, never a replacement.
 */
export const WHEEL_RAY_GROUPS = interactionGroups(GROUP.query, ALL_GROUPS & ~GROUP.vehicle)
