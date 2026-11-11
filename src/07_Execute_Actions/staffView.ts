// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It draws the player's own agents posted at their homes' workstations (homeView.ts
 * staffFigures): each a plain mesh of the crowd's business-casual body (crowd.ts bodyGeometry) in the body their look
 * wears, in their top's colour, scaled to their height, standing at the station and leaning a little toward the
 * screen. Like the network room's ghosts (netView.ts) nothing here is a body in the physics realm: a posted agent is
 * never a collider, never in the crowd and never sensed by it; the page alone draws them, and like those ghosts they
 * keep their plain material in rain mode. At most STAFF_VIEW.max, made on first need and kept; an empty list hides
 * them all. Plain three on the page: numbers in, nothing out.
 * What breaks if it is removed? A posted agent is kept and listed but never seen at the workstation.
 */
import { Group, Mesh, MeshStandardNodeMaterial, type BufferGeometry } from 'three/webgpu'
import { bodyGeometry } from '../03_Spawn_Agents/crowd.ts'
import type { StaffFigure } from './homeView.ts'

export type { StaffFigure }

export const STAFF_VIEW = Object.freeze({
  /** Figures drawn at most: one per roster agent (roster.ts ROSTER_MAX; staffView.test.ts holds them equal). */
  max: 12,
  /** The lean toward the screen, rad (about 4 degrees), about the figure's own feet. */
  lean: 0.07,
})

/** One figure as drawn: a plain mesh with a material of its own, recoloured to the agent's top. */
type Figure = Mesh<BufferGeometry, MeshStandardNodeMaterial>

export class StaffView {
  /** Every figure, named for the frame's debugger and the shader tests. Hidden while empty. */
  readonly group = new Group()
  /** The body geometries by variant (0..3), made on first need. */
  private readonly bodies = new Map<number, BufferGeometry>()

  constructor() {
    this.group.name = 'StaffPeople'
    this.group.visible = false
  }

  /**
   * Places every figure (a non-finite one is skipped, at most STAFF_VIEW.max) and returns how many stand. The meshes
   * are kept and reused: each takes the figure's body (0..3, anything else the second) and colour (0xRRGGBB, anything
   * else dark steel); the rest are hidden. Never a shadow caster, so a figure never darkens the workstation it faces.
   */
  set(list: readonly StaffFigure[]): number {
    const kids = this.group.children as Figure[]
    let n = 0
    for (const f of list) {
      if (n >= STAFF_VIEW.max || !Number.isFinite(f.x + f.y + f.z + f.yaw + f.scale)) continue
      const v = Number.isInteger(f.body) && f.body >= 0 && f.body <= 3 ? f.body : 1
      let body = this.bodies.get(v)
      if (!body) this.bodies.set(v, (body = bodyGeometry(v)))
      let m = kids[n]
      if (!m) {
        m = new Mesh(body, new MeshStandardNodeMaterial({ roughness: 0.7 }))
        m.name = 'StaffPerson'
        m.receiveShadow = true
        m.rotation.order = 'YXZ'
        this.group.add(m)
      }
      m.geometry = body
      m.material.color.setHex(Number.isInteger(f.ink) ? f.ink & 0xffffff : 0x3f4652)
      m.position.set(f.x, f.y, f.z)
      m.rotation.set(STAFF_VIEW.lean, f.yaw, 0)
      m.scale.setScalar(f.scale)
      m.visible = true
      n++
    }
    for (let i = n; i < kids.length; i++) kids[i].visible = false
    this.group.visible = n > 0
    return n
  }

  dispose(): void {
    for (const g of this.bodies.values()) g.dispose()
    for (const m of this.group.children as Figure[]) m.material.dispose()
    this.bodies.clear()
    this.group.clear()
  }
}
