/**
 * Why does this file exist? It draws the other players of a network session (10_Network/replication.ts: the poses
 * the page's client reconciled from the room's snapshots) as pose-only ghosts: one InstancedMesh of the crowd's
 * business-casual body for a pose on foot and one of the car body for a pose faster than anyone runs, placed by
 * plain numbers (x, y, z, heading) in the ghost view's ink, translucent, casting no shadow. Nothing here is a body
 * in the physics realm: a remote player is never a collider, never in a step request, never sensed by the crowd;
 * the kernel stays single. It knows nothing of sockets: the engine hands it whatever poses it read this frame, and
 * an empty list hides both meshes. Pure three on the page: matrices in, nothing out.
 * What breaks if it is removed? The room's other players are received but never seen; the session is unchanged.
 */
import { Color, InstancedMesh, Matrix4, MeshStandardNodeMaterial, Quaternion, Vector3, type BufferGeometry } from 'three/webgpu'
import { bodyGeometry } from '../03_Spawn_Agents/crowd.ts'
import { RIDE_HEIGHT } from './car.ts'
import { carBodyGeometry } from './fleetView.ts'
import { GHOST_COLOR } from './ghost.ts'
import { RUN } from './simProtocol.ts'

/** A remote player's pose as the view draws it (the engine's NetPeer, 10_Network's RemotePlayer): plain floats. */
export interface RemotePose {
  id: number
  name: string
  x: number
  y: number
  z: number
  /** Facing, rad: forward is (sin heading, 0, cos heading), the realm's convention for people and cars alike. */
  heading: number
  /** Over the ground, m/s. */
  speed: number
}

export const NET_VIEW = Object.freeze({
  /** Instances each mesh holds: the room's bound on peers (10_Network/replication.ts LIMITS.peers; netWiring.test.ts pins them equal). */
  max: 32,
  /** How solid a ghost is drawn. */
  opacity: 0.55,
  /** The body variant every remote on foot wears (crowd.ts VARIANT_NAMES: smart casual). */
  variant: 1,
})

/** What a pose is drawn as: a person, or a car when it moves faster than anyone runs (the room caps a walker at RUN). */
export const bodyOf = (speed: number): 'person' | 'car' => (Number.isFinite(speed) && speed > RUN ? 'car' : 'person')

const UP = new Vector3(0, 1, 0)

function ghostMaterial(ink: readonly [number, number, number]): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial()
  m.color = new Color(ink[0], ink[1], ink[2])
  m.emissive = new Color(ink[0] * 0.35, ink[1] * 0.35, ink[2] * 0.35)
  m.roughness = 0.6
  m.metalness = 0
  m.transparent = true
  m.opacity = NET_VIEW.opacity
  return m
}

function ghostMesh(geometry: BufferGeometry, ink: readonly [number, number, number], name: string): InstancedMesh {
  const mesh = new InstancedMesh(geometry, ghostMaterial(ink), NET_VIEW.max)
  mesh.count = 0
  mesh.visible = false
  mesh.frustumCulled = false
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.name = name
  return mesh
}

export class NetView {
  /** Remote players on foot: the crowd's smart-casual body, feet at the pose's y. */
  readonly people: InstancedMesh
  /** Remote players at a wheel: the car body, its chassis centre RIDE_HEIGHT above the pose's y. */
  readonly cars: InstancedMesh
  private readonly m = new Matrix4()
  private readonly q = new Quaternion()
  private readonly p = new Vector3()
  private readonly one = new Vector3(1, 1, 1)

  constructor() {
    this.people = ghostMesh(bodyGeometry(NET_VIEW.variant), GHOST_COLOR.person, 'NetPeople')
    this.cars = ghostMesh(carBodyGeometry(), GHOST_COLOR.vehicle, 'NetCars')
  }

  /**
   * Places every pose (at most NET_VIEW.max of each kind; a pose with a non-finite number is skipped) and returns how
   * many instances stand. A mesh with none is hidden; the instance matrices are marked for upload only when one moved.
   */
  update(poses: readonly RemotePose[]): number {
    let people = 0, cars = 0
    for (const r of poses) {
      if (!Number.isFinite(r.x + r.y + r.z + r.heading)) continue
      if (bodyOf(r.speed) === 'car') {
        if (cars >= NET_VIEW.max) continue
        // The car body's front is along +x; a yaw of (heading − π/2) turns it to the realm's forward (sin h, 0, cos h).
        this.q.setFromAxisAngle(UP, r.heading - Math.PI / 2)
        this.p.set(r.x, r.y + RIDE_HEIGHT, r.z)
        this.cars.setMatrixAt(cars++, this.m.compose(this.p, this.q, this.one))
      } else {
        if (people >= NET_VIEW.max) continue
        // The body's front is along +z: a yaw of the heading itself faces it the realm's way.
        this.q.setFromAxisAngle(UP, r.heading)
        this.p.set(r.x, r.y, r.z)
        this.people.setMatrixAt(people++, this.m.compose(this.p, this.q, this.one))
      }
    }
    this.show(this.people, people)
    this.show(this.cars, cars)
    return people + cars
  }

  private show(mesh: InstancedMesh, count: number): void {
    mesh.count = count
    mesh.visible = count > 0
    if (count > 0) mesh.instanceMatrix.needsUpdate = true
  }

  dispose(): void {
    for (const mesh of [this.people, this.cars]) {
      mesh.geometry.dispose()
      ;(mesh.material as MeshStandardNodeMaterial).dispose()
      mesh.dispose()
    }
  }
}
