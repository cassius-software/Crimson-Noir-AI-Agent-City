// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It draws the fleet on the page: the procedural bodies (extruded profile,
 * shader-painted glass and lamps, metallic paint, a dark cabin shell seen from the driver's seat) and the
 * wheels, from the pose buffer the physics worker sends every step (simProtocol.ts POSE). It holds no
 * physics: numbers in, matrices out. (The crowd reads the cars in the worker, from the fleet itself.)
 * What breaks if it is removed? The cars simulate in the worker but are never seen.
 */
import {
  CylinderGeometry, DoubleSide, ExtrudeGeometry, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardNodeMaterial,
  Quaternion, Shape, Vector3, type UniformNode,
} from 'three/webgpu'
import { abs, attribute, float, frontFacing, length, normalGeometry, positionGeometry, positionLocal, select, vec2, vec3 } from 'three/tsl'
import { applyCodeDissolve } from '../01_Initialize_World/codeDissolve.ts'
import { CAR, RIDE_HEIGHT, WHEELS } from './car.ts'
import { DISSOLVE_COLOR } from './dissolve.ts'
import { POSE } from './simProtocol.ts'

/** The car body's geometry: the chassis centre at the origin (RIDE_HEIGHT below its floor), the front along +x. Also the network ghosts' car (netView.ts). */
export function carBodyGeometry(): ExtrudeGeometry {
  // Side profile, x along the length (front = +x), y height above the ground.
  const pts: [number, number][] = [
    [-2.3, 0.3], [-2.33, 0.56], [-2.22, 0.84], [-1.3, 0.92], [-0.82, 1.38], [0.42, 1.42], [1.12, 0.98],
    [2.18, 0.8], [2.34, 0.56], [2.3, 0.3],
  ]
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

export class FleetView {
  readonly bodies: InstancedMesh
  readonly wheels: InstancedMesh
  readonly count: number
  /**
   * The code dissolve's amounts (codeDissolve.ts; 0 solid, 1 gone), one float per body slot and one per wheel slot
   * (wheel w of car i is slot i * 4 + w, so the four follow their car): the engine writes them when the user's body on
   * foot is inside a car, or a car passes through another. View-only; the driven car is never written.
   */
  readonly dissolve: { bodies: InstancedBufferAttribute; wheels: InstancedBufferAttribute }
  private readonly suv: readonly boolean[]
  private readonly m = new Matrix4()
  private readonly q = new Quaternion()
  private readonly q2 = new Quaternion()
  private readonly q3 = new Quaternion()
  private readonly v3 = new Vector3()
  private readonly v4 = new Vector3()
  private readonly s3 = new Vector3()
  private readonly up = new Vector3(0, 1, 0)
  private readonly axle = new Vector3(0, 0, 1)

  /** `paint`: body colour per vehicle, 0xRRGGBB (sRGB); `night`: 0 by day, 1 at night (lamp glow). */
  constructor(suv: readonly boolean[], paint: readonly number[], night: UniformNode<'float', number>) {
    const count = suv.length
    this.count = count
    this.suv = suv
    const bodyGeo = carBodyGeometry()
    // An empty fleet (a region has no traffic yet) still gets one slot: WebGPU refuses a zero-sized binding.
    const slots = Math.max(1, count)
    const colour = new InstancedBufferAttribute(new Float32Array(slots * 3), 3)
    // Linear colour: the paint palette is authored in sRGB.
    for (let i = 0; i < count; i++) {
      const c = paint[i] ?? 0x808080
      colour.setXYZ(i, (((c >> 16) & 255) / 255) ** 2.2, (((c >> 8) & 255) / 255) ** 2.2, ((c & 255) / 255) ** 2.2)
    }
    bodyGeo.setAttribute('paint', colour)
    const mat = new MeshStandardNodeMaterial()
    const p = positionGeometry
    const n = normalGeometry
    const y = p.y.add(RIDE_HEIGHT)
    // Greenhouse between the beltline and the roof skin is glass; the roof itself is painted.
    const glass = y.greaterThan(0.96).and(y.lessThan(1.37).or(n.y.lessThan(0.8)))
    const front = p.x.greaterThan(2.15).and(n.x.greaterThan(0.4))
    const rear = p.x.lessThan(-2.15).and(n.x.lessThan(-0.4))
    const lampBand = y.greaterThan(0.6).and(y.lessThan(0.8))
    const head = front.and(lampBand).and(abs(p.z).greaterThan(0.42))
    const tail = rear.and(lampBand).and(abs(p.z).greaterThan(0.38))
    const grille = front.and(y.lessThan(0.6)).and(y.greaterThan(0.36)).and(abs(p.z).lessThan(0.55))
    const bumper = y.lessThan(0.42)
    const body = attribute('paint', 'vec3')
    const exterior = select(glass, vec3(0.02, 0.025, 0.03), select(head, vec3(0.9, 0.9, 0.88), select(tail, vec3(0.5, 0.03, 0.03), select(grille.or(bumper), vec3(0.03, 0.03, 0.035), body))))
    // First person from the driver's seat looks at the shell from inside. Inner faces are drawn as dark cabin
    // trim (a cowl over the bonnet, pillars, roof lining); inner glass is discarded so the windows stay clear.
    mat.side = DoubleSide
    mat.maskNode = frontFacing.or(glass.not())
    mat.colorNode = select(frontFacing, exterior, vec3(0.075, 0.07, 0.068))
    mat.metalnessNode = select(frontFacing.not().or(glass).or(grille).or(bumper), float(0.2), float(0.55))
    mat.roughnessNode = select(frontFacing.not(), float(0.85), select(glass, float(0.04), select(grille.or(bumper), float(0.6), float(0.28))))
    const nightGlow = night.mul(0.9).add(0.1)
    const lamps = select(head, vec3(1.0, 0.95, 0.85).mul(nightGlow.mul(6)), select(tail, vec3(1.0, 0.05, 0.03).mul(nightGlow.mul(3)), vec3(0)))
    mat.emissiveNode = select(frontFacing, lamps, vec3(0))
    // The code dissolve, over everything above: the amount per instance, the origin the instance's own (positionLocal
    // × 0 maps to the chassis centre, or the wheel's), the cabin shell's mask kept and ANDed with the cells' survival.
    const amount = attribute('dissolve', 'float')
    const origin = positionLocal.mul(0)
    this.dissolve = { bodies: new InstancedBufferAttribute(new Float32Array(slots), 1), wheels: new InstancedBufferAttribute(new Float32Array(slots * 4), 1) }
    bodyGeo.setAttribute('dissolve', this.dissolve.bodies)
    applyCodeDissolve(mat, amount, origin, DISSOLVE_COLOR.cars)
    this.bodies = new InstancedMesh(bodyGeo, mat, slots)
    this.bodies.count = count
    this.bodies.name = 'Cars'

    const wheelGeo = new CylinderGeometry(CAR.wheelRadius, CAR.wheelRadius, 0.24, 18).rotateX(Math.PI / 2)
    const wheelMat = new MeshStandardNodeMaterial()
    const radial = length(vec2(positionGeometry.x, positionGeometry.y))
    const rim = abs(normalGeometry.z).greaterThan(0.9).and(radial.lessThan(0.22))
    wheelMat.colorNode = select(rim, vec3(0.62, 0.63, 0.65), vec3(0.03, 0.03, 0.03))
    wheelMat.metalnessNode = select(rim, float(0.9), float(0))
    wheelMat.roughnessNode = select(rim, float(0.3), float(0.85))
    wheelGeo.setAttribute('dissolve', this.dissolve.wheels)
    applyCodeDissolve(wheelMat, amount, origin, DISSOLVE_COLOR.cars)
    this.wheels = new InstancedMesh(wheelGeo, wheelMat, slots * 4)
    this.wheels.count = count * 4
    this.wheels.name = 'Wheels'
    for (const mesh of [this.bodies, this.wheels]) {
      mesh.frustumCulled = false
      mesh.castShadow = true
      mesh.receiveShadow = true
    }
  }

  /** Instance matrices from one step's poses: the chassis, then each wheel steered, rolled and on its suspension. */
  sync(poses: Float32Array): void {
    const q = this.q
    for (let i = 0; i < this.count; i++) {
      const o = i * POSE.stride
      const x = poses[o + POSE.x], y = poses[o + POSE.y], z = poses[o + POSE.z]
      q.set(poses[o + POSE.qx], poses[o + POSE.qy], poses[o + POSE.qz], poses[o + POSE.qw])
      const suv = this.suv[i]
      this.s3.set(1, suv ? 1.16 : 1, suv ? 1.03 : 1)
      this.m.compose(this.v3.set(x, y, z), q, this.s3)
      this.bodies.setMatrixAt(i, this.m)
      for (let w = 0; w < 4; w++) {
        const [wx, wz] = WHEELS[w]
        const k = o + POSE.wheels + 3 * w
        const susp = poses[k], spin = poses[k + 1], steer = poses[k + 2]
        // Rapier's rolling angle decreases rolling forward about the chassis +z axle, as the mesh expects.
        this.q2.setFromAxisAngle(this.up, w < 2 ? steer : 0).multiply(this.q3.setFromAxisAngle(this.axle, spin % (Math.PI * 2)))
        this.q3.copy(q).multiply(this.q2)
        this.v3.set(wx, -susp, wz).applyQuaternion(q).add(this.v4.set(x, y, z))
        this.m.compose(this.v3, this.q3, this.s3.set(1, 1, 1))
        this.wheels.setMatrixAt(i * 4 + w, this.m)
      }
    }
    this.bodies.instanceMatrix.needsUpdate = true
    this.wheels.instanceMatrix.needsUpdate = true
  }
}
