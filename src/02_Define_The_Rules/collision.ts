/**
 * Why does this file exist? It is the 14A physics contract in one record: what may exchange contact in the realm's
 * Rapier world and what never does. Cars pass through cars (no vehicle-on-vehicle contact); the ragdoll balance
 * machine is wired to a few pedestrians near the operator (03_Spawn_Agents/ragdoll.ts over ragdollRig.ts, run by
 * 07_Execute_Actions/ragdollRealm.ts) and a vehicle is never a cause of it; there is no combat; street furniture is
 * sensors (the ghost-mode law, physics.ts); and people and cars meet only through the Sanctuary (sanctuary.ts), which
 * flips a person — an avatar's capsule or a rig's segment — to a sensor before a car can reach them. It also holds
 * the realm's group bit table and the packed interaction groups the fleet gives its chassis colliders and its wheel
 * rays (vehicles.ts) and the avatar gives its capsule (player.ts). It is pure — no Rapier import — so it runs in
 * Node without WASM and the page may import it; collision.test.ts is the structural guard that keeps the ragdoll's
 * importers to the realm and the bit table from drifting.
 * What breaks if it is removed? Two cars could exchange impulses again (a car pushed into a person's path by
 * another car), a wheel could ride up on a car it passes through, an avatar could shove a fallen person, and nothing
 * would say in one place what the realm's contact policy is.
 */

/** The contact policy of the realm, beside CIVIC's `violence: false` (civic.ts). Frozen: policy, not tuning. */
export const COLLISION = Object.freeze({
  /** Chassis never exchange contact with chassis; cars pass through cars. */
  vehicleOnVehicle: false,
  /**
   * The ragdoll balance machine is wired: pedestrians within 25 m of the operator may be promoted to a Rapier rig by a
   * shove in a dense crowd, a kerb trip or a slip (07_Execute_Actions/ragdollRealm.ts over 03_Spawn_Agents/ragdoll.ts).
   * A vehicle is never a cause: the pool refuses it by name (ragdoll.ts PERTURBATION_CAUSES), the Sanctuary shields
   * every segment of a rig as it shields an avatar, and the Ring-0 audit halts the realm if a car reaches one.
   */
  ragdoll: true,
  /** There is no combat: no module, no rule, no vocabulary. */
  combat: false,
  /** Lamps, trees and signal poles are in the world as sensors: found by queries, never solid. */
  furniture: 'sensor',
  /** People and cars meet only through the Sanctuary's Solid -> Sensor flip and its nudge. */
  peopleAndCars: 'sanctuary',
  /**
   * No rail vehicle runs on the street plane: no surface tram, no level crossing. Trains ride the elevated loop
   * (06_Make_Decisions/tracks.ts TRACKS.train.deck, 9 m), timetabled and never a vehicle a person can meet, and the
   * Ring-0 audit halts the realm if one reads below that deck (ring0.ts CRAFT, OFF_CORRIDOR). A surface train would
   * be a vehicle that cannot stop inside the First Law's envelope; it is ruled out, not deferred.
   */
  surfaceRail: false,
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
  /** A promoted pedestrian's rig segments (ragdollRig.ts RAGDOLL_GROUP sets it; the realm builds them). */
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

/**
 * An avatar's capsule is a member of everything and filters `ragdoll` out: a rig segment (membership `ragdoll`) and
 * the avatar have no common bit in that direction, so the broad phase never pairs them and the ghost-mode law holds
 * for a promoted person too (the avatar walks through them, nobody is shoved). The character controller is given the
 * same groups for its own sweeps (player.ts). Against cars, the ground and the buildings the avatar is as solid as
 * ever; a rig meets cars and the world exactly as it did, with the Sanctuary between it and every car.
 */
export const AVATAR_GROUPS = interactionGroups(ALL_GROUPS, ALL_GROUPS & ~GROUP.ragdoll)
