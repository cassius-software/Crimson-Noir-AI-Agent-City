// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the player's presence in the shared physics space: a Rapier
 * kinematic character controller on foot (slides along walls, steps curbs, snaps to the ground), and the
 * person the sanctuary shields (sanctuary.ts flips its collider to a sensor and nudges it clear of a car).
 * It lives in the physics worker with the rest of the Rapier world; the camera's head is head.ts, on the page. The
 * network's authoritative mirror (10_Network/mirror.node.ts) runs this same class on its server, in mirror mode, so a
 * client's prediction (the page's realm) and the server's truth are one controller's arithmetic.
 * What breaks if it is removed? The player cannot walk, and nobody is there for the kernel to protect.
 */
import { AVATAR_GROUPS } from '../02_Define_The_Rules/collision.ts'
import { RAPIER, type Physics } from './physics.ts'
import type { PersonBody } from './sanctuary.ts'
import { PERSON } from './simProtocol.ts'

const RADIUS = PERSON.radius
const HALF_HEIGHT = PERSON.halfHeight
/** The controller's skin: the capsule rests this far above what it stands on, m. */
const SKIN = 0.02
/** The deepest sink the ground guard repairs (the autostep height), m; anything deeper is left to the controller. */
const MAX_LIFT = 0.35
/**
 * A sensor (a shielded person) is never an obstacle; Rapier's character controller treats sensors as
 * solid unless told otherwise.
 */
const SOLIDS = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS
/** While shielded, vehicles are not obstacles either: every dynamic body in this world is a vehicle chassis. */
const PASS_VEHICLES = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS | RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC
/**
 * A ghost (player 1 in a network room) and the network's mirror: only fixed geometry is an obstacle. No vehicle, no
 * other player (kinematic capsules), no sensor. The same flags on both sides, so the page's move and the server's
 * replay search the same set of colliders.
 */
const GHOST = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS | RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC

/** How an avatar lives in its world. */
export interface AvatarOptions {
  /**
   * The network's authoritative mirror (10_Network/mirror.node.ts): a ghost for good (see setGhost), in a world that
   * is never stepped (nothing in it moves on its own).
   */
  mirror?: boolean
}

/** Everything a move reads and leaves, to put an avatar back exactly as it was (the mirror's trials). */
export interface AvatarSnapshot { x: number; y: number; z: number; fall: number; grounded: boolean; heading: number; speed: number }

export class Avatar {
  readonly body: RAPIER.RigidBody
  readonly collider: RAPIER.Collider
  /** The avatar as a person for the sanctuary to register. */
  readonly person: PersonBody
  heading = 0
  speed = 0
  private readonly controller: RAPIER.KinematicCharacterController
  private readonly physics: Physics
  private readonly mirror: boolean
  /** A ghost: only fixed geometry stops it, and each move puts it in place at once (setGhost). */
  private ghost = false
  private fall = 0
  /** Whether the last move ended on the ground (the controller's own verdict, kept so a snapshot can restore it). */
  private grounded = false
  private nudgeX = 0
  private nudgeZ = 0
  private readonly desired = { x: 0, y: 0, z: 0 }
  private readonly next = { x: 0, y: 0, z: 0 }
  private readonly at = { x: 0, y: 0, z: 0 }
  private readonly moved = { x: 0, y: 0, z: 0 }

  constructor(physics: Physics, x: number, z: number, o: AvatarOptions = {}) {
    const world = physics.world
    this.physics = physics
    this.mirror = o.mirror === true
    this.ghost = this.mirror
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, HALF_HEIGHT + RADIUS, z))
    // The ghost-mode law for a promoted pedestrian too: the capsule's groups (collision.ts AVATAR_GROUPS) drop every
    // pair with a physical person's segments, so the avatar walks through them and shoves nobody.
    this.collider = world.createCollider(RAPIER.ColliderDesc.capsule(HALF_HEIGHT, RADIUS).setCollisionGroups(AVATAR_GROUPS), this.body)
    this.controller = world.createCharacterController(SKIN)
    this.controller.setUp({ x: 0, y: 1, z: 0 })
    this.controller.setSlideEnabled(true)
    this.controller.enableAutostep(0.35, 0.2, false)
    this.controller.enableSnapToGround(0.4)
    this.controller.setMaxSlopeClimbAngle(0.8)
    // The player can shove a parked car a little; cars cannot shove the player through walls.
    this.controller.setApplyImpulsesToDynamicBodies(true)
    this.person = { body: this.body, collider: this.collider, radius: RADIUS, halfHeight: HALF_HEIGHT }
    if (this.mirror) world.propagateModifiedBodyPositionsToColliders()
  }

  get x(): number { return this.body.translation(this.at).x }
  get z(): number { return this.body.translation(this.at).z }

  /** The sanctuary's safety nudge: added to the next move() displacement, still stopped by walls. */
  nudge(dx: number, dz: number): void {
    this.nudgeX += dx
    this.nudgeZ += dz
  }

  /**
   * Moves by a desired horizontal velocity plus any pending nudge; `speed` is the achieved walking speed
   * (a nudge carries the avatar without adding to it).
   */
  move(vx: number, vz: number, dt: number): void {
    this.fall = this.grounded ? 0 : Math.max(-20, this.fall - 9.81 * dt)
    const want = this.desired
    want.x = vx * dt + this.nudgeX
    want.y = this.fall * dt
    want.z = vz * dt + this.nudgeZ
    this.nudgeX = 0
    this.nudgeZ = 0
    // Shielded (a sensor): cars pass through, so they must not block, trap or be shoved by the avatar. A ghost meets
    // only fixed geometry.
    const flags = this.ghost ? GHOST : this.collider.isSensor() ? PASS_VEHICLES : SOLIDS
    this.controller.computeColliderMovement(this.collider, want, flags, AVATAR_GROUPS)
    this.grounded = this.controller.computedGrounded()
    const d = this.controller.computedMovement(this.moved)
    const t = this.body.translation(this.at)
    const next = this.next
    next.x = t.x + d.x
    next.y = t.y + d.y
    next.z = t.z + d.z
    // Ground guard. On a very large ground box the controller's snap-to-ground shape casts lose precision and
    // sink the capsule 0.1–0.3 m into the road (on 50 m tiles they do not); the first-person eye rides on the
    // feet, so it would show at once. An exact ray to the fixed geometry lifts the capsule back to its skin —
    // never down, and never out of anything deeper than a step (a ray starting inside a box reads 0).
    const toi = this.physics.castRay(next.x, next.y, next.z, 0, -1, 0, HALF_HEIGHT + RADIUS + MAX_LIFT, undefined, true)
    if (toi !== null) {
      const lift = HALF_HEIGHT + RADIUS + SKIN - toi
      if (lift > 0 && lift <= MAX_LIFT) {
        next.y += lift
        this.fall = 0
      }
    }
    this.place(next)
    this.speed = Math.min(Math.hypot(d.x, d.z), Math.hypot(vx, vz) * dt) / Math.max(dt, 1e-4)
    if (Math.hypot(vx, vz) > 0.1) {
      const target = Math.atan2(vx, vz)
      let diff = target - this.heading
      diff -= Math.PI * 2 * Math.floor((diff + Math.PI) / (Math.PI * 2))
      this.heading += diff * Math.min(1, dt * 12)
    }
  }

  /** Takes the avatar out of its world for good (the mirror, when a peer leaves): its controller, body and capsule. */
  dispose(): void {
    this.physics.world.removeCharacterController(this.controller)
    this.physics.world.removeRigidBody(this.body)
  }

  /**
   * Player 1 in a network room (simCore.ts `room`), and the mirror always: only fixed geometry is an obstacle (no
   * vehicle, no other player), and each move puts the capsule where the controller says at once (the body's
   * translation set, which also sets its next kinematic translation, and its collider updated), so a world step never
   * moves it and the next move reads exactly where this one left it. The page's realm and the server's mirror then run
   * the same arithmetic on the same fixed geometry, to the bit (mirror.node.test.ts). The Sanctuary keeps a ghost a
   * sensor (sanctuary.ts ghost), so no vehicle ever touches it.
   */
  setGhost(on: boolean): void {
    this.ghost = on === true || this.mirror
  }

  get isGhost(): boolean {
    return this.ghost
  }

  setEnabled(on: boolean): void {
    this.collider.setEnabled(on)
    this.nudgeX = 0
    this.nudgeZ = 0
  }

  teleport(x: number, z: number): void {
    this.body.setTranslation({ x, y: HALF_HEIGHT + RADIUS + 0.05, z }, true)
    // The collider follows at once (a move right after reads the collider, not the body): the first step after a
    // teleport starts where the teleport put the avatar, in the realm as in the mirror.
    this.physics.world.propagateModifiedBodyPositionsToColliders()
    if (!this.ghost) this.body.setNextKinematicTranslation({ x, y: HALF_HEIGHT + RADIUS + 0.05, z })
    // Put down in the air: the next move starts falling from rest, whatever the last one ended on (so a client's realm
    // and the mirror, teleported to the same point, take the same next step).
    this.fall = 0
    this.grounded = false
    this.nudgeX = 0
    this.nudgeZ = 0
  }

  /** Where the capsule is and how it was moving: everything the next move reads. */
  state(): AvatarSnapshot {
    const t = this.body.translation(this.at)
    return { x: t.x, y: t.y, z: t.z, fall: this.fall, grounded: this.grounded, heading: this.heading, speed: this.speed }
  }

  /** Puts the avatar back exactly as `s` found it (a trial the mirror did not keep). */
  restore(s: AvatarSnapshot): void {
    const at = { x: s.x, y: s.y, z: s.z }
    this.body.setTranslation(at, false)
    this.physics.world.propagateModifiedBodyPositionsToColliders()
    if (!this.ghost) this.body.setNextKinematicTranslation(at)
    this.fall = s.fall
    this.grounded = s.grounded
    this.heading = s.heading
    this.speed = s.speed
    this.nudgeX = 0
    this.nudgeZ = 0
  }

  /** The move's end: the next step reaches it (the realm), or the capsule is put there now (a ghost, the mirror). */
  private place(next: { x: number; y: number; z: number }): void {
    if (!this.ghost) {
      this.body.setNextKinematicTranslation(next)
      return
    }
    this.body.setTranslation(next, false)
    this.physics.world.propagateModifiedBodyPositionsToColliders()
  }
}
