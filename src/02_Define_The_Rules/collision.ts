// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the 14A physics contract in one record: what may exchange contact in the realm's
 * Rapier world and what never does. Cars pass through cars (no vehicle-on-vehicle contact); the ragdoll balance
 * machine is wired to a few pedestrians near the operator (03_Spawn_Agents/ragdoll.ts over ragdollRig.ts, run by
 * 07_Execute_Actions/ragdollRealm.ts) and a vehicle is never a cause of it; there is no combat; street furniture is
 * sensors (the ghost-mode law, physics.ts); and people and cars meet only through the Sanctuary (sanctuary.ts), which
 * flips a person — an avatar's capsule or a rig's segment — to a sensor before a car can reach them; and on foot the
 * avatar walks through a car as through a lamp (the ghost-mode law: the capsule's groups drop every chassis pair, so
 * a parked car is passed, not pushed, and the mesh dissolves as the camera enters it). It also holds
 * the realm's group bit table and the packed interaction groups the fleet gives its chassis colliders and its wheel
 * rays (vehicles.ts) and the avatar gives its capsule (player.ts). It is pure — no Rapier import — so it runs in
 * Node without WASM and the page may import it; collision.test.ts is the structural guard that keeps the ragdoll's
 * importers to the realm and the bit table from drifting.
 * The same policy as one table: LAYER names what every collider is (terrain, structure, player, agent, vehicle, prop)
 * and canCollide() is the one rule over the table, branchless: contact is exchanged only where something that moves
 * (a player, an agent, a vehicle) meets the solid world (the ground, a structure), never between two things that
 * move and never with a prop. COLLIDERS lists every collider class the realm builds with its layer and the Rapier
 * words it carries, and collision.test.ts checks Rapier's pairing of those words against the rule for every pair, so
 * the words cannot say one thing and the table another. WALL_CONTACT is how a vehicle meets the solid world: a
 * contact solved by Rapier with a small restitution, a rebound and a slide; there is no damage model of any kind.
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
   * The avatar on foot passes through every car, parked or rolling, as through a lamp: its capsule and a chassis never
   * pair (AVATAR_GROUPS filters `vehicle` out), so there is no impulse either way, nothing to shove and nothing to be
   * shoved by; the car's mesh dissolves around the camera instead (07_Execute_Actions/dissolve.ts). The First Law is
   * untouched: the bouncer still brakes every car nobody sits in for the avatar in its corridor (the car a person sits
   * in passes through people instead, 07_Execute_Actions/vehicles.ts), and the Sanctuary still shields.
   */
  avatarThroughCars: true,
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
 * (ground, buildings) both tests pass, so a car is as solid as ever to the world; the avatar's capsule filters
 * `vehicle` out (AVATAR_GROUPS) and walks through it.
 */
export const VEHICLE_CHASSIS_GROUPS = interactionGroups(GROUP.vehicle, ALL_GROUPS & ~GROUP.vehicle)

/**
 * A wheel ray is a `query` that filters `vehicle` out: it finds the road (default groups) but never another
 * chassis, so a car cannot ride up on a car it passes through. The flags Fleet passes beside it (EXCLUDE_SENSORS |
 * EXCLUDE_KINEMATIC) keep the wheels off people; the groups are an addition to those flags, never a replacement.
 */
export const WHEEL_RAY_GROUPS = interactionGroups(GROUP.query, ALL_GROUPS & ~GROUP.vehicle)

/**
 * An avatar's capsule is a member of everything and filters `ragdoll` and `vehicle` out: a rig segment (membership
 * `ragdoll`) or a chassis (membership `vehicle`) and the avatar have no common bit in that direction, so the broad
 * phase never pairs them and the ghost-mode law holds for a promoted person and for a car alike (the avatar walks
 * through them, nobody and nothing is shoved). The character controller is given the same groups for its own sweeps
 * (player.ts), so a parked car is not an obstacle to it either. Against the ground and the buildings the avatar is as
 * solid as ever; a rig meets cars and the world exactly as it did, with the Sanctuary between it and every car.
 */
export const AVATAR_GROUPS = interactionGroups(ALL_GROUPS, ALL_GROUPS & ~(GROUP.ragdoll | GROUP.vehicle))

/**
 * A rig segment is a member of `ragdoll` and filters `ragdoll`, `vehicle` and `query` out: segments never meet each
 * other (the joints hold a rig together); a chassis (membership `vehicle`) and a wheel ray (membership `query`) have no
 * bit a segment lets in, so the broad phase never pairs a fallen person with a car's body or a wheel. A ragdoll is out
 * of the vehicle layer: a car that reaches one exchanges no impulse and never rides up on it, so a fallen person is
 * neither shoved by traffic nor a jam it piles up behind. The Sanctuary still shields every segment before a car can
 * reach it, and the Ring-0 audit still halts the realm if one does: this removes the contact, not the law. Against
 * the ground and the buildings (default groups) a segment is as solid as ever, and the avatar still passes through it
 * (AVATAR_GROUPS filters `ragdoll` out). ragdollRig.ts gives every segment and foot these groups.
 */
export const RAGDOLL_GROUPS = interactionGroups(GROUP.ragdoll, ALL_GROUPS & ~(GROUP.ragdoll | GROUP.vehicle | GROUP.query))

/**
 * A robot's links (07_Execute_Actions/articulated.ts, the joint bridge): the same bits as a promoted pedestrian's rig,
 * on purpose. The avatar passes through a robot as through a rig (a servo arm is never a wall the operator is pushed
 * by), no car and no wheel ray meets one, the Ring-0 audit sees neither a vehicle nor a pedestrian in it, and the
 * ground and the furniture hold it up. Two robots pass through each other, as two rigs do.
 */
export const ROBOT_GROUPS = RAGDOLL_GROUPS

/** Rapier's default words: every bit in both. What the ground, the buildings and the furniture carry. */
export const DEFAULT_GROUPS = interactionGroups(ALL_GROUPS, ALL_GROUPS)

/**
 * The realm's contact layers: what each collider is, for the one rule below (canCollide). A layer is one bit, so a
 * mask of layers is their OR. They are the names of the policy; the Rapier words above are its mechanism, and
 * COLLIDERS ties each collider class to both.
 */
export const LAYER = Object.freeze({
  none: 0,
  /** What everything stands on: the ground tiles, a region's tiles, the pier's deck. */
  terrain: 1 << 0,
  /** What never moves and never breaks: buildings, walls, the seawall and its railings, a region's walls. */
  structure: 1 << 1,
  /** An avatar's capsule on foot (07_Execute_Actions/player.ts). */
  player: 1 << 2,
  /** A pedestrian's promoted rig (03_Spawn_Agents/ragdollRig.ts) or a robot's links (07_Execute_Actions/articulated.ts). */
  agent: 1 << 3,
  /** A chassis (07_Execute_Actions/carRig.ts): a car, and every kind drawn over its two chassis classes. */
  vehicle: 1 << 4,
  /** Street furniture: lamps, trees and signal poles, in the world as sensors (physics.ts). */
  prop: 1 << 5,
} as const)

/** The solid world: what a body may be stopped by. */
export const SOLID_WORLD = LAYER.terrain | LAYER.structure
/** What moves: a player, an agent, a vehicle. */
export const ACTORS = LAYER.player | LAYER.agent | LAYER.vehicle

/** 1 when any bit of `v` (a 32-bit integer) is set, else 0, without a branch: the sign bit of v | −v. */
const any = (v: number): number => (v | -v) >>> 31

/**
 * The 14A contact rule, branchless: every bit set (−1) when one of the two layers is an actor and the other the solid
 * world, 0 for every other pair. So a player, an agent and a vehicle each meet the ground and the structures and
 * nothing else: not each other (a car never shoves a person or another car, a player never shoves anyone), and not a
 * prop (a lamp stops nobody). Two pieces of the world never meet (neither moves), and a prop meets nothing.
 */
export function canCollide(layerA: number, layerB: number): number {
  const aActs = any(layerA & ACTORS), bActs = any(layerB & ACTORS)
  const aSolid = any(layerA & SOLID_WORLD), bSolid = any(layerB & SOLID_WORLD)
  return -((aActs & bSolid) | (bActs & aSolid)) | 0
}

/** How a collider class lives in Rapier: fixed (never moves), kinematic (moved by hand) or dynamic (solved). */
export type BodyKind = 'fixed' | 'kinematic' | 'dynamic'

/** One collider class the realm builds: its layer, the packed Rapier words it carries, its body kind, and whether it is a sensor. */
export interface ColliderClass {
  readonly layer: number
  readonly groups: number
  readonly body: BodyKind
  readonly sensor: boolean
}

/**
 * Every collider class the realm builds, with its layer and the Rapier words it is built with (physics.ts for the
 * fixed ones, player.ts, ragdollRig.ts, articulated.ts and carRig.ts for the rest). collision.test.ts takes every
 * pair and checks that Rapier's own pairing of the words (and its rules that a sensor exchanges no contact and that two
 * fixed or two kinematic bodies never meet) says exactly what canCollide says of the layers.
 */
export const COLLIDERS: Readonly<Record<'ground' | 'building' | 'avatar' | 'rig' | 'robot' | 'chassis' | 'furniture', ColliderClass>> = Object.freeze({
  ground: Object.freeze({ layer: LAYER.terrain, groups: DEFAULT_GROUPS, body: 'fixed' as const, sensor: false }),
  building: Object.freeze({ layer: LAYER.structure, groups: DEFAULT_GROUPS, body: 'fixed' as const, sensor: false }),
  avatar: Object.freeze({ layer: LAYER.player, groups: AVATAR_GROUPS, body: 'kinematic' as const, sensor: false }),
  rig: Object.freeze({ layer: LAYER.agent, groups: RAGDOLL_GROUPS, body: 'dynamic' as const, sensor: false }),
  robot: Object.freeze({ layer: LAYER.agent, groups: ROBOT_GROUPS, body: 'dynamic' as const, sensor: false }),
  chassis: Object.freeze({ layer: LAYER.vehicle, groups: VEHICLE_CHASSIS_GROUPS, body: 'dynamic' as const, sensor: false }),
  furniture: Object.freeze({ layer: LAYER.prop, groups: DEFAULT_GROUPS, body: 'fixed' as const, sensor: true }),
})

/**
 * Rapier's own pairing rule over two packed words: a and b interact iff (a.membership & b.filter) != 0 and
 * (b.membership & a.filter) != 0. Pure, for the test and for anyone reading the table.
 */
export function rapierPairs(a: number, b: number): boolean {
  return ((a >>> 16) & b & 0xffff) !== 0 && ((b >>> 16) & a & 0xffff) !== 0
}

/**
 * Whether Rapier would exchange contact between two collider classes: the words pair, neither is a sensor, and the
 * two are not both fixed or both kinematic (Rapier solves no contact between two bodies it never moves itself; the
 * character controller's own sweeps exclude kinematic bodies too, player.ts PASS_VEHICLES). What collision.test.ts
 * holds equal to canCollide over the layers, pair by pair.
 */
export function rapierContact(a: ColliderClass, b: ColliderClass): boolean {
  if (a.sensor || b.sensor) return false
  if (a.body === 'fixed' && b.body === 'fixed') return false
  if (a.body === 'kinematic' && b.body === 'kinematic') return false
  return rapierPairs(a.groups, b.groups)
}

/**
 * How a vehicle meets the solid world (the only contact a chassis ever exchanges): Rapier's contact solver with this
 * restitution and friction on the chassis collider (carRig.ts buildCarRig), so a car driven into a wall stops dead
 * at it and slides along it, and the wall does not move. A sedan at 25 m/s stops inside 0.15 m, stays on its
 * wheels and reverses away (wallContact.test.ts). There is no damage model of any kind: no deformation, no fire, no
 * breakdown, no health, no event; a car that ends on its side or roof is set back on its wheels (vehicles.ts
 * recover: an AI car rights itself, the console's `recover` rights the one you drive). The restitution is zero on
 * purpose: a bounce is paid out of the contact solver's warm-start impulses, state no setter reaches, so a car rebuilt
 * from a room correction (carRig.ts rebuildCarRig) would leave a wall on a different path from the room's own and
 * the replay would never again agree (mirror.node.test.ts, "a correction carries the car"). Frozen: policy, not tuning.
 */
export const WALL_CONTACT = Object.freeze({
  /** Coefficient of restitution of a chassis against the solid world: a dead stop, so a replay can copy it. */
  restitution: 0,
  /** Friction of a chassis sliding along a wall. */
  friction: 0.4,
} as const)
