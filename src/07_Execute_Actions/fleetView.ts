// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It draws the fleet on the page: the procedural bodies (one extruded side profile per kind
 * of vehicle, car.ts VEHICLE_KINDS: a sedan, a transit pod, a van, a coach, a courier robot, an SUV, a coupe and a
 * utility rig; shader-painted glass and lamps, metallic paint, a dark cabin shell seen from the driver's seat, brake
 * lights that follow the brake demand, a warm interior glow or an amber beacon where the kind has one) and the
 * wheels, from the pose buffer the physics worker sends every step (simProtocol.ts POSE). One InstancedMesh per kind
 * holds that kind's cars in compact slots (slotOf maps a vehicle to its mesh and slot), and one InstancedMesh holds
 * every wheel, four per vehicle. It holds no physics: numbers in, matrices out. (The crowd reads the cars in the
 * worker, from the fleet itself.) Every silhouette stays within DISSOLVE.reach of its chassis class's box, so the
 * dissolve (dissolve.ts) has the mesh before the camera does.
 * What breaks if it is removed? The cars simulate in the worker but are never seen.
 */
import {
  CylinderGeometry, DoubleSide, ExtrudeGeometry, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardNodeMaterial,
  Quaternion, Shape, Vector3, type UniformNode, type Vector4,
} from 'three/webgpu'
import { abs, attribute, float, frontFacing, length, normalGeometry, positionGeometry, positionLocal, select, sin, time, vec2, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { applyCodeDissolve } from '../01_Initialize_World/codeDissolve.ts'
import { applyMatrixMode } from '../01_Initialize_World/matrixMode.ts'
import { CAR, RIDE_HEIGHT, VEHICLE_KINDS, WHEELS, kindOf, type VehicleKind } from './car.ts'
import { DISSOLVE_COLOR } from './dissolve.ts'
import { POSE } from './simProtocol.ts'

/** A side profile: x along the length (front = +x), y height above the road, closed in order. */
export type Profile = readonly (readonly [number, number])[]

/**
 * The side profiles, one per kind, authored at the sedan's scale (the kind's scale in car.ts stretches them about the
 * chassis origin). Every one stays inside x ±2.34 (the sedan's bumpers) and above the road by at least 0.3 m.
 */
export const PROFILES: Readonly<Record<VehicleKind['id'], Profile>> = Object.freeze({
  sedan: [
    [-2.3, 0.3], [-2.33, 0.56], [-2.22, 0.84], [-1.3, 0.92], [-0.82, 1.38], [0.42, 1.42], [1.12, 0.98],
    [2.18, 0.8], [2.34, 0.56], [2.3, 0.3],
  ],
  // Bi-directional: the same nose at both ends, a glass canopy over the whole cabin.
  pod: [[-2.0, 0.3], [-2.1, 0.6], [-1.9, 1.1], [-1.4, 1.4], [1.4, 1.4], [1.9, 1.1], [2.1, 0.6], [2.0, 0.3]],
  // A short bonnet under a high cargo box.
  van: [[-2.3, 0.36], [-2.33, 0.6], [-2.3, 1.42], [-2.2, 1.5], [0.9, 1.5], [1.2, 1.42], [1.6, 1.0], [2.2, 0.85], [2.34, 0.56], [2.3, 0.36]],
  // A box on wheels, windows all along.
  coach: [[-2.3, 0.42], [-2.34, 0.7], [-2.3, 1.46], [-2.15, 1.55], [2.15, 1.55], [2.3, 1.46], [2.34, 0.7], [2.3, 0.42]],
  // A low rounded box: the sidewalk courier.
  courier: [[-2.0, 0.4], [-2.05, 0.7], [-1.9, 1.2], [-1.6, 1.3], [1.6, 1.3], [1.9, 1.2], [2.05, 0.7], [2.0, 0.4]],
  // The sedan with a squared tailgate and a longer roof.
  suv: [[-2.3, 0.3], [-2.33, 0.6], [-2.25, 1.0], [-2.1, 1.42], [-1.6, 1.46], [0.4, 1.44], [1.1, 1.02], [2.18, 0.84], [2.34, 0.56], [2.3, 0.3]],
  // Low roof, long bonnet.
  coupe: [[-2.3, 0.3], [-2.33, 0.56], [-2.2, 0.84], [-1.5, 0.9], [-0.9, 1.26], [0.1, 1.3], [0.9, 1.0], [1.4, 0.84], [2.2, 0.74], [2.34, 0.52], [2.3, 0.3]],
  // A cab forward of a flat bed.
  utility: [
    [-2.3, 0.4], [-2.33, 0.7], [-2.3, 1.0], [-2.25, 1.05], [-0.2, 1.05], [-0.2, 0.95], [0.2, 0.95], [0.3, 1.52], [0.5, 1.56],
    [1.5, 1.52], [1.9, 1.1], [2.2, 0.9], [2.34, 0.6], [2.3, 0.4],
  ],
})

/** The car body's geometry for `kind`: the chassis centre at the origin (RIDE_HEIGHT below its floor), the front along +x. The sedan's is also the network ghosts' car (netView.ts). */
export function carBodyGeometry(kind: VehicleKind['id'] = 'sedan'): ExtrudeGeometry {
  const pts = PROFILES[kind]
  const shape = new Shape()
  shape.moveTo(pts[0][0], pts[0][1])
  for (const [x, y] of pts.slice(1)) shape.lineTo(x, y)
  shape.closePath()
  const width = CAR.halfWidth * 2 - 0.12
  const g = new ExtrudeGeometry(shape, { depth: width, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 3, curveSegments: 1 })
  g.translate(0, -RIDE_HEIGHT, -width / 2)
  g.computeVertexNormals()
  return g
}

type B = Node<'bool'>

/** Where a kind's body is glass, from the vertex's geometry position (height above the road `y`) and normal. */
function glassOf(id: VehicleKind['id'], p: Node<'vec3'>, n: Node<'vec3'>, y: Node<'float'>): B {
  // Greenhouse between the beltline and the roof skin; the roof itself is painted.
  const greenhouse = y.greaterThan(0.96).and(y.lessThan(1.37).or(n.y.lessThan(0.8)))
  switch (id) {
    case 'pod': return y.greaterThan(0.7).and(n.y.lessThan(0.9))
    case 'van': return greenhouse.and(p.x.greaterThan(0.8))
    case 'coach': return y.greaterThan(1.0).and(y.lessThan(1.46)).and(abs(n.y).lessThan(0.8))
    case 'courier': return y.greaterThan(1.15).and(abs(n.y).lessThan(0.8))
    case 'utility': return greenhouse.and(p.x.greaterThan(0.2))
    default: return greenhouse
  }
}

/** The brightness of the amber beacon over time: a double flash a second. */
const beaconPulse = (): Node<'float'> => sin(time.mul(12.57)).mul(0.5).add(0.5).mul(sin(time.mul(1.57)).mul(0.5).add(0.5))

export class FleetView {
  /** One mesh per kind, in VEHICLE_KINDS order (an empty kind keeps one slot: WebGPU refuses a zero-sized binding). */
  readonly bodies: readonly InstancedMesh[]
  readonly wheels: InstancedMesh
  readonly count: number
  /**
   * The code dissolve's amounts (codeDissolve.ts; 0 solid, 1 gone): `bodies` is staged by vehicle index (one float per
   * vehicle; it is on no geometry) and flushDissolve() scatters it to each kind's own attribute; `wheels` has one per
   * wheel slot (wheel w of car i is slot i * 4 + w, so the four follow their car) and is read as it is. The engine
   * writes them when the user's body on foot is inside a car, or a car passes through another. View-only; the driven
   * car is never written.
   */
  readonly dissolve: { bodies: InstancedBufferAttribute; wheels: InstancedBufferAttribute }
  /** Per vehicle: its kind (an index into VEHICLE_KINDS) and its slot in that kind's mesh. */
  readonly kindOf: Uint8Array
  readonly slotOf: Int32Array
  private readonly kindDissolve: InstancedBufferAttribute[]
  private readonly brake: InstancedBufferAttribute[]
  private readonly m = new Matrix4()
  private readonly q = new Quaternion()
  private readonly q2 = new Quaternion()
  private readonly q3 = new Quaternion()
  private readonly v3 = new Vector3()
  private readonly v4 = new Vector3()
  private readonly s3 = new Vector3()
  private readonly up = new Vector3(0, 1, 0)
  private readonly axle = new Vector3(0, 0, 1)

  /**
   * `kinds`: kind index per vehicle (SimMeta.kind); `paint`: body colour per vehicle, 0xRRGGBB (sRGB); `night`: 0 by
   * day, 1 at night (lamp glow); `matrixMode`: the page's global-state uniform (01_Initialize_World/matrixMode.ts), or
   * null for a fleet without matrix mode.
   */
  constructor(kinds: readonly number[], paint: readonly number[], night: UniformNode<'float', number>, matrixMode: UniformNode<'vec4', Vector4> | null = null) {
    const count = kinds.length
    this.count = count
    this.kindOf = new Uint8Array(count)
    this.slotOf = new Int32Array(count)
    const perKind = new Array<number>(VEHICLE_KINDS.length).fill(0)
    for (let i = 0; i < count; i++) {
      const k = VEHICLE_KINDS.indexOf(kindOf(kinds[i]))
      this.kindOf[i] = k
      this.slotOf[i] = perKind[k]++
    }
    const slots = Math.max(1, count)
    this.dissolve = { bodies: new InstancedBufferAttribute(new Float32Array(slots), 1), wheels: new InstancedBufferAttribute(new Float32Array(slots * 4), 1) }
    this.kindDissolve = []
    this.brake = []
    const bodies: InstancedMesh[] = []
    for (let k = 0; k < VEHICLE_KINDS.length; k++) {
      const kind = VEHICLE_KINDS[k]
      const n = perKind[k]
      const kslots = Math.max(1, n)
      const geo = carBodyGeometry(kind.id)
      // Linear colour: the paint palette is authored in sRGB.
      const colour = new InstancedBufferAttribute(new Float32Array(kslots * 3), 3)
      for (let i = 0; i < count; i++) {
        if (this.kindOf[i] !== k) continue
        const c = paint[i] ?? 0x808080
        colour.setXYZ(this.slotOf[i], (((c >> 16) & 255) / 255) ** 2.2, (((c >> 8) & 255) / 255) ** 2.2, ((c & 255) / 255) ** 2.2)
      }
      geo.setAttribute('paint', colour)
      const dissolve = new InstancedBufferAttribute(new Float32Array(kslots), 1)
      geo.setAttribute('dissolve', dissolve)
      this.kindDissolve.push(dissolve)
      const brake = new InstancedBufferAttribute(new Float32Array(kslots), 1)
      geo.setAttribute('brake', brake)
      this.brake.push(brake)
      const mesh = new InstancedMesh(geo, this.bodyMaterial(kind, night, matrixMode), kslots)
      mesh.count = n
      mesh.name = `Cars:${kind.id}`
      bodies.push(mesh)
    }
    this.bodies = Object.freeze(bodies)

    const wheelGeo = new CylinderGeometry(CAR.wheelRadius, CAR.wheelRadius, 0.24, 18).rotateX(Math.PI / 2)
    const wheelMat = new MeshStandardNodeMaterial()
    const radial = length(vec2(positionGeometry.x, positionGeometry.y))
    const rim = abs(normalGeometry.z).greaterThan(0.9).and(radial.lessThan(0.22))
    wheelMat.colorNode = select(rim, vec3(0.62, 0.63, 0.65), vec3(0.03, 0.03, 0.03))
    wheelMat.metalnessNode = select(rim, float(0.9), float(0))
    wheelMat.roughnessNode = select(rim, float(0.3), float(0.85))
    wheelGeo.setAttribute('dissolve', this.dissolve.wheels)
    if (matrixMode) applyMatrixMode(wheelMat, matrixMode)
    applyCodeDissolve(wheelMat, attribute('dissolve', 'float'), positionLocal.mul(0), DISSOLVE_COLOR.cars)
    this.wheels = new InstancedMesh(wheelGeo, wheelMat, slots * 4)
    this.wheels.count = count * 4
    this.wheels.name = 'Wheels'
    for (const mesh of [...this.bodies, this.wheels]) {
      mesh.frustumCulled = false
      mesh.castShadow = true
      mesh.receiveShadow = true
    }
  }

  /** The body material of one kind: its glass, lamps, cabin shell and extra lights, then matrix mode and the dissolve over all of it. */
  private bodyMaterial(kind: VehicleKind, night: UniformNode<'float', number>, matrixMode: UniformNode<'vec4', Vector4> | null): MeshStandardNodeMaterial {
    const mat = new MeshStandardNodeMaterial()
    const p = positionGeometry
    const n = normalGeometry
    const y = p.y.add(RIDE_HEIGHT)
    const glass = glassOf(kind.id, p, n, y)
    const front = p.x.greaterThan(2.15).and(n.x.greaterThan(0.4))
    const rear = p.x.lessThan(-2.15).and(n.x.lessThan(-0.4))
    const lampBand = y.greaterThan(0.6).and(y.lessThan(0.8))
    const head = front.and(lampBand).and(abs(p.z).greaterThan(0.42))
    const tail = rear.and(lampBand).and(abs(p.z).greaterThan(0.38))
    const grille = front.and(y.lessThan(0.6)).and(y.greaterThan(0.36)).and(abs(p.z).lessThan(0.55))
    const bumper = y.lessThan(0.42)
    // The utility rig's bed is bare dark steel; the courier's shell is matte.
    const bed = kind.id === 'utility' ? p.x.lessThan(-0.2).and(y.greaterThanEqual(0.94)) : null
    const body = attribute('paint', 'vec3')
    let exterior = select(glass, vec3(0.02, 0.025, 0.03), select(head, vec3(0.9, 0.9, 0.88), select(tail, vec3(0.5, 0.03, 0.03), select(grille.or(bumper), vec3(0.03, 0.03, 0.035), body))))
    if (bed) exterior = select(bed, vec3(0.06, 0.06, 0.062), exterior)
    // First person from the driver's seat looks at the shell from inside. Inner faces are drawn as dark cabin
    // trim (a cowl over the bonnet, pillars, roof lining); inner glass is discarded so the windows stay clear.
    mat.side = DoubleSide
    mat.maskNode = frontFacing.or(glass.not())
    mat.colorNode = select(frontFacing, exterior, vec3(0.075, 0.07, 0.068))
    const dull = kind.id === 'courier' ? float(0.1) : float(0.55)
    mat.metalnessNode = select(frontFacing.not().or(glass).or(grille).or(bumper), float(0.2), dull)
    mat.roughnessNode = select(frontFacing.not(), float(0.85), select(glass, float(0.04), select(grille.or(bumper), float(0.6), kind.id === 'courier' ? float(0.6) : float(0.28))))
    const nightGlow = night.mul(0.9).add(0.1)
    // Brake lights: the tail lamps brighten with the brake demand the pose carries (0 or 1 per instance, sync()).
    const braking = attribute('brake', 'float')
    const tailGlow = vec3(1.0, 0.05, 0.03).mul(nightGlow.mul(3).add(braking.mul(6)))
    let lamps = select(head, vec3(1.0, 0.95, 0.85).mul(nightGlow.mul(6)), select(tail, tailGlow, vec3(0)))
    if (kind.lights === 'interior') {
      // A warm cabin light through the glass at night.
      lamps = select(glass, vec3(1.0, 0.75, 0.45).mul(night.mul(0.6)), lamps)
    } else if (kind.lights === 'beacon') {
      // An amber beacon on the cab roof, flashing.
      const beacon = y.greaterThan(1.5).and(abs(p.x.sub(0.9)).lessThan(0.3))
      lamps = select(beacon, vec3(1.0, 0.45, 0.05).mul(beaconPulse().mul(5).add(0.5)), lamps)
    }
    mat.emissiveNode = select(frontFacing, lamps, vec3(0))
    // Matrix mode (matrixMode.ts) over the shell's own colour, under the dissolve.
    if (matrixMode) applyMatrixMode(mat, matrixMode)
    // The code dissolve, over everything above: the amount per instance, the origin the instance's own (positionLocal
    // × 0), the cabin shell's mask kept and ANDed with the cells' survival.
    applyCodeDissolve(mat, attribute('dissolve', 'float'), positionLocal.mul(0), DISSOLVE_COLOR.cars)
    return mat
  }

  /** Scatters the staged body amounts (dissolve.bodies, by vehicle index) to each kind's attribute and marks them for upload. */
  flushDissolve(): void {
    const staged = this.dissolve.bodies.array as Float32Array
    for (let i = 0; i < this.count; i++) (this.kindDissolve[this.kindOf[i]].array as Float32Array)[this.slotOf[i]] = staged[i]
    for (const a of this.kindDissolve) a.needsUpdate = true
  }

  /** Instance matrices from one step's poses: the chassis, then each wheel steered, rolled and on its suspension; the brake lights. */
  sync(poses: Float32Array): void {
    const q = this.q
    for (let i = 0; i < this.count; i++) {
      const o = i * POSE.stride
      const x = poses[o + POSE.x], y = poses[o + POSE.y], z = poses[o + POSE.z]
      q.set(poses[o + POSE.qx], poses[o + POSE.qy], poses[o + POSE.qz], poses[o + POSE.qw])
      const k = this.kindOf[i], slot = this.slotOf[i]
      const kind = VEHICLE_KINDS[k]
      const [sx, sy, sz] = kind.scale
      this.s3.set(sx, sy, sz)
      this.m.compose(this.v3.set(x, y, z), q, this.s3)
      this.bodies[k].setMatrixAt(slot, this.m)
      const brake = this.brake[k].array as Float32Array
      const braking = poses[o + POSE.brake] > 0.5 ? 1 : 0
      if (brake[slot] !== braking) { brake[slot] = braking; this.brake[k].needsUpdate = true }
      // The drawn wheel follows the raycast wheel, scaled to the kind: in along the body and across the track with the
      // body, its radius by the kind's, its centre lowered so it still meets the road.
      const r = kind.wheel
      const drop = (1 - r) * CAR.wheelRadius
      for (let w = 0; w < 4; w++) {
        const [wx, wz] = WHEELS[w]
        const kk = o + POSE.wheels + 3 * w
        const susp = poses[kk], spin = poses[kk + 1], steer = poses[kk + 2]
        // Rapier's rolling angle decreases rolling forward about the chassis +z axle, as the mesh expects.
        this.q2.setFromAxisAngle(this.up, w < 2 ? steer : 0).multiply(this.q3.setFromAxisAngle(this.axle, spin % (Math.PI * 2)))
        this.q3.copy(q).multiply(this.q2)
        this.v3.set(wx * sx, -susp - drop, wz * sz).applyQuaternion(q).add(this.v4.set(x, y, z))
        this.m.compose(this.v3, this.q3, this.s3.set(r, r, 1))
        this.wheels.setMatrixAt(i * 4 + w, this.m)
      }
    }
    for (const mesh of this.bodies) mesh.instanceMatrix.needsUpdate = true
    this.wheels.instanceMatrix.needsUpdate = true
  }
}
