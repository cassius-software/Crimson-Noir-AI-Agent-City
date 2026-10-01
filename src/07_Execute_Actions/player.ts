/**
 * Why does this file exist? It is the player's presence in the shared physics space: a Rapier
 * kinematic character controller on foot (slides along walls, steps curbs, snaps to the ground), and the
 * person the sanctuary shields (sanctuary.ts flips its collider to a sensor and nudges it clear of a car).
 * It lives in the physics worker with the rest of the Rapier world; the camera's head is head.ts, on the page.
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

export class Avatar {
  readonly body: RAPIER.RigidBody
  readonly collider: RAPIER.Collider
  /** The avatar as a person for the sanctuary to register. */
  readonly person: PersonBody
  heading = 0
  speed = 0
  private readonly controller: RAPIER.KinematicCharacterController
  private readonly physics: Physics
  private fall = 0
  private nudgeX = 0
  private nudgeZ = 0
  private readonly desired = { x: 0, y: 0, z: 0 }
  private readonly next = { x: 0, y: 0, z: 0 }
  private readonly at = { x: 0, y: 0, z: 0 }
  private readonly moved = { x: 0, y: 0, z: 0 }

  constructor(physics: Physics, x: number, z: number) {
    const world = physics.world
    this.physics = physics
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
    this.fall = this.controller.computedGrounded() ? 0 : Math.max(-20, this.fall - 9.81 * dt)
    const want = this.desired
    want.x = vx * dt + this.nudgeX
    want.y = this.fall * dt
    want.z = vz * dt + this.nudgeZ
    this.nudgeX = 0
    this.nudgeZ = 0
    // Shielded (a sensor): cars pass through, so they must not block, trap or be shoved by the avatar.
    this.controller.computeColliderMovement(this.collider, want, this.collider.isSensor() ? PASS_VEHICLES : SOLIDS, AVATAR_GROUPS)
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
    this.body.setNextKinematicTranslation(next)
    this.speed = Math.min(Math.hypot(d.x, d.z), Math.hypot(vx, vz) * dt) / Math.max(dt, 1e-4)
    if (Math.hypot(vx, vz) > 0.1) {
      const target = Math.atan2(vx, vz)
      let diff = target - this.heading
      diff -= Math.PI * 2 * Math.floor((diff + Math.PI) / (Math.PI * 2))
      this.heading += diff * Math.min(1, dt * 12)
    }
  }

  setEnabled(on: boolean): void {
    this.collider.setEnabled(on)
    this.nudgeX = 0
    this.nudgeZ = 0
  }

  teleport(x: number, z: number): void {
    this.body.setTranslation({ x, y: HALF_HEIGHT + RADIUS + 0.05, z }, true)
    this.body.setNextKinematicTranslation({ x, y: HALF_HEIGHT + RADIUS + 0.05, z })
    this.fall = 0
    this.nudgeX = 0
    this.nudgeZ = 0
  }
}
