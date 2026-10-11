// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It draws the promoted pedestrians' rigs on the page: the realm's rig stream
 * (simProtocol.ts RIG_POSE, one slice per slot) gives each rig's thirteen shape poses, and this view poses one
 * instanced capsule per shape (simProtocol.ts RIG_SEGMENTS, the page's copy of the rig's own shapes) in the colour
 * the crowd gives that person's own figure (03_Spawn_Agents/crowd.ts attireColour), where the hidden figure stood.
 * It holds no physics and loads no Rapier: numbers in, matrices out, exactly as fleetView.ts does for the cars. Who
 * is promoted, and where their rig stands, is the realm's alone.
 * What breaks if it is removed? A promoted person's figure is hidden and nothing stands in their place.
 */
import { CapsuleGeometry, Color, InstancedMesh, Matrix4, MeshStandardNodeMaterial, Quaternion, Vector3, type UniformNode, type Vector4 } from 'three/webgpu'
import { applyMatrixMode } from '../01_Initialize_World/matrixMode.ts'
import { attireColour } from '../03_Spawn_Agents/crowd.ts'
import { RIG_POSE, RIG_SEGMENTS } from './simProtocol.ts'

/** An empty slot's shapes are scaled to nothing: no triangle is rasterised. */
const NOTHING = new Vector3(0, 0, 0)
const ONE = new Vector3(1, 1, 1)

export class RigView {
  /** One instanced mesh per shape (RIG_SEGMENTS order), `slots` instances each. */
  readonly meshes: readonly InstancedMesh[]
  readonly slots: number
  /** The agents promoted in the newest stream, in slot order: the crowd hides their figures (CrowdCull.hide). */
  readonly hidden: number[] = []
  /** Per slot: the agent coloured into it (−1: none yet). */
  private readonly coloured: Int32Array
  private readonly m = new Matrix4()
  private readonly q = new Quaternion()
  private readonly v = new Vector3()
  private readonly c = new Color()

  /** `matrixMode`: the page's global-state uniform (01_Initialize_World/matrixMode.ts), or null for rigs without matrix mode. */
  constructor(slots: number, matrixMode: UniformNode<'vec4', Vector4> | null = null) {
    this.slots = Math.max(0, Math.floor(slots))
    // WebGPU refuses a zero-sized binding: a realm without rigs still gets one (never drawn) instance.
    const count = Math.max(1, this.slots)
    this.coloured = new Int32Array(count).fill(-1)
    const material = new MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 })
    if (matrixMode) applyMatrixMode(material, matrixMode)
    this.meshes = RIG_SEGMENTS.map(([name, halfHeight, radius]) => {
      const geometry = new CapsuleGeometry(radius, 2 * halfHeight, 3, 10)
      // A foot lies along its lower leg's z (the realm's flat foot), not up its y.
      if (name === 'footL' || name === 'footR') geometry.rotateX(Math.PI / 2)
      const mesh = new InstancedMesh(geometry, material, count)
      mesh.name = `Rig ${name}`
      mesh.frustumCulled = false
      mesh.castShadow = true
      mesh.receiveShadow = true
      for (let s = 0; s < count; s++) {
        mesh.setMatrixAt(s, this.m.compose(this.v.set(0, 0, 0), this.q.identity(), NOTHING))
        mesh.setColorAt(s, this.c.setRGB(0.5, 0.5, 0.5))
      }
      mesh.count = count
      return mesh
    })
  }

  /**
   * Instance matrices and colours from one step's stream (null, or a buffer of the wrong length, empties every slot):
   * each listed slot's shapes posed as the realm has them, each empty slot's scaled to nothing.
   */
  sync(rigs: Float32Array | null): void {
    const list = this.hidden
    list.length = 0
    const valid = rigs instanceof Float32Array && rigs.length >= this.slots * RIG_POSE.stride
    for (let s = 0; s < Math.max(1, this.slots); s++) {
      const o = s * RIG_POSE.stride
      const agent = valid && s < this.slots ? rigs[o + RIG_POSE.agent] : -1
      const live = Number.isInteger(agent) && agent >= 0
      if (live) {
        list.push(agent)
        if (this.coloured[s] !== agent) {
          this.coloured[s] = agent
          const [r, g, b] = attireColour(agent)
          for (const mesh of this.meshes) mesh.setColorAt(s, this.c.setRGB(r, g, b))
        }
      }
      this.meshes.forEach((mesh, j) => {
        if (live) {
          const b = o + RIG_POSE.segments + j * RIG_POSE.segmentStride
          this.q.set(rigs![b + 3], rigs![b + 4], rigs![b + 5], rigs![b + 6])
          this.m.compose(this.v.set(rigs![b], rigs![b + 1], rigs![b + 2]), this.q, ONE)
        } else {
          this.m.compose(this.v.set(0, 0, 0), this.q.identity(), NOTHING)
        }
        mesh.setMatrixAt(s, this.m)
      })
    }
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
  }
}
