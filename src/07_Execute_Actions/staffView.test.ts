// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the posted agents' figures (staffView.ts) to what the Staff tab promises: an empty
 * list hides them; each figure is a plain mesh of the crowd's body in the agent's variant, colour and height, standing
 * where homeView.ts says, facing the screen and leaning a little toward it, never casting a shadow; the meshes and the
 * bodies are made once and reused; at most twelve (the roster's limit) are drawn and a figure that is not a number is
 * skipped; and disposing empties the group. The source never reaches for instancing.
 * What breaks if it is removed? A posted agent could stand facing the wall, in someone else's body or colour, cast a
 * shadow over the workstation, or leak a mesh on every post, and only a browser would show it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Vector3, type BufferGeometry, type Mesh, type MeshStandardNodeMaterial } from 'three/webgpu'
import { ROSTER_MAX } from '../08_Swarm/roster.ts'
import type { StaffFigure } from './homeView.ts'

// Vite's `?raw` import, for Node (netView.test.ts's hook): crowd.ts imports the crowd's WGSL that way.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { STAFF_VIEW, StaffView } = await import('./staffView.ts')

type Figure = Mesh<BufferGeometry, MeshStandardNodeMaterial>
const figure = (over: Partial<StaffFigure> = {}): StaffFigure => ({ x: 175.7, y: 0.015, z: 136.1, yaw: Math.PI / 2, body: 2, ink: 0x7c3aed, scale: 1.05, ...over })
const kids = (v: InstanceType<typeof StaffView>) => v.group.children as Figure[]

test('an empty list hides the group; a list stands one plain mesh per figure where it is told, facing the screen and leaning toward it', () => {
  const view = new StaffView()
  assert.equal(view.group.name, 'StaffPeople')
  assert.equal(view.group.visible, false, 'hidden until someone is posted')
  assert.equal(view.set([]), 0)
  assert.equal(view.group.visible, false)
  assert.equal(view.set([figure(), figure({ x: 170, yaw: 0, body: 0, ink: 0x112233, scale: 0.9 })]), 2)
  assert.equal(view.group.visible, true)
  const [a, b] = kids(view)
  assert.equal(a.name, 'StaffPerson')
  assert.equal((a as unknown as { isInstancedMesh?: boolean }).isInstancedMesh, undefined, 'a plain mesh')
  assert.deepEqual(a.position.toArray(), [175.7, 0.015, 136.1])
  assert.deepEqual(a.scale.toArray(), [1.05, 1.05, 1.05])
  assert.equal(a.rotation.order, 'YXZ')
  assert.equal(a.rotation.x, STAFF_VIEW.lean, 'leaning toward the screen')
  // The figure's forward (+z in its own frame) turned by yaw: (sin yaw, cos yaw).
  const ahead = new Vector3(0, 0, 1).applyEuler(a.rotation.clone().set(0, a.rotation.y, 0, 'YXZ'))
  assert.ok(Math.abs(ahead.x - 1) < 1e-9 && Math.abs(ahead.z) < 1e-9, 'yaw π/2 faces +x')
  assert.equal(a.castShadow, false, 'never darkens the workstation it faces')
  assert.equal(a.receiveShadow, true)
  assert.equal(a.material.color.getHex(), 0x7c3aed)
  assert.equal(b.material.color.getHex(), 0x112233)
  assert.notEqual(a.geometry, b.geometry, 'each in their own body')
  // Fewer figures hide the rest; none hides the group.
  assert.equal(view.set([figure()]), 1)
  assert.equal(b.visible, false)
  assert.equal(view.set([]), 0)
  assert.equal(view.group.visible, false)
  view.dispose()
})

test('meshes and bodies are made once and reused; a body that is not 0..3 is the second, a colour that is not a number dark steel', () => {
  const view = new StaffView()
  view.set([figure({ body: 1 }), figure({ body: 3 })])
  const [a, b] = kids(view)
  const bodyOne = a.geometry, materials = [a.material, b.material]
  view.set([figure({ body: 3, ink: 0xffffff }), figure({ body: 9, ink: Number.NaN })])
  assert.equal(kids(view).length, 2, 'no new mesh')
  assert.equal(kids(view)[0], a, 'the same mesh, re-dressed')
  assert.deepEqual([a.material, b.material], materials, 'the same materials, recoloured')
  assert.equal(b.geometry, bodyOne, 'variant 9 wears body 1, made once')
  assert.equal(a.material.color.getHex(), 0xffffff)
  assert.equal(b.material.color.getHex(), 0x3f4652)
  view.dispose()
})

test('at most twelve, a figure that is not a number skipped; STAFF_VIEW.max is the roster\'s limit; dispose empties the group', () => {
  assert.equal(STAFF_VIEW.max, ROSTER_MAX)
  const view = new StaffView()
  const list = [figure({ x: Number.NaN }), figure({ scale: Number.POSITIVE_INFINITY }), ...Array.from({ length: 14 }, (_, i) => figure({ x: i }))]
  assert.equal(view.set(list), 12)
  assert.equal(kids(view).length, 12)
  assert.deepEqual(kids(view).map((m) => m.position.x), Array.from({ length: 12 }, (_, i) => i), 'the bad ones skipped, the first twelve good ones drawn')
  view.dispose()
  assert.equal(view.group.children.length, 0)
  const src = readFileSync(new URL('./staffView.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /matri|Instanced/i, 'plain meshes, never instancing')
})
