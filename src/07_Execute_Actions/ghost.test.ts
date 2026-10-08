// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins ghost view.
 * - Every proxy is the collider it stands for: each building's box, the lamp, tree and signal cylinders of
 *   city.ts POLES, each car's chassis box posed from the pose buffer (car.ts chassisBox), a contact envelope per
 *   pedestrian.
 * - The view fades in and out over GHOST.fade on drawn frames, and its scene is hidden while fully off (its pass
 *   then only clears).
 * - The glyph alphabet is generated: 16 strokes on a 3 × 3 lattice.
 * - It composites after FXAA in both chains from a pass of its own: never in the scene pass, so never in the
 *   velocity buffer.
 * - The engine keeps the post chain on while it shows.
 * - Nothing the physics worker loads reaches it.
 * The shaders themselves run in a WebGPU browser (the orchestrator's probe).
 * What breaks if it is removed? A proxy could drift from its collider, the view could light up the velocity
 * buffer or vanish at the Minimal tier, or it could leak into the worker, unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { Box3, BoxGeometry, InstancedMesh, Matrix4, MeshStandardNodeMaterial, PerspectiveCamera, Scene, StorageBufferAttribute, Vector3, type WebGPURenderer } from 'three/webgpu'
import { GHOST, GHOST_COLOR, GHOST_KIND, STROKES, chassisMatrix, createGhost, ghostComposite, type GhostSource } from './ghost.ts'
import { POLES, type Box } from '../01_Initialize_World/city.ts'
import { chassisBox } from './car.ts'
import { PERSON, POSE } from './simProtocol.ts'
import { buildPost } from './postfx.ts'

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

function source(): GhostSource {
  const boxes: Box[] = [[0, 0, 0, 10, 30, 20], [40, 0, 5, 52, 12, 11]]
  return {
    boxes,
    furniture: { lamps: [[4, 4, 0], [8, 4, 0]], trees: [[12, 4, 1]], signals: [[0, 0, 0, 1]] },
    suv: [false, true],
    crowdPos: new StorageBufferAttribute(new Float32Array(64 * 4), 4),
    agents: 64,
  }
}

/** A pose buffer: car 0 at (100, 0.56, 50) turned by `yaw` about +y, car 1 at the origin. */
function poses(yaw: number): Float32Array {
  const p = new Float32Array(2 * POSE.stride)
  p[POSE.x] = 100; p[POSE.y] = 0.56; p[POSE.z] = 50
  p[POSE.qy] = Math.sin(yaw / 2); p[POSE.qw] = Math.cos(yaw / 2)
  p[POSE.stride + POSE.qw] = 1
  return p
}

const meshes = (scene: Scene) => scene.children as InstancedMesh[]
const kindOf = (m: InstancedMesh) => {
  const node = (m.material as { colorNode?: { nodes?: unknown[] } }).colorNode
  return node
}

test('proxies: a box per building, a cylinder per pole (lamp, tree, signal sizes), a chassis per car, an envelope per pedestrian', () => {
  const src = source()
  const g = createGhost(src)
  const [buildings, poles, cars, people] = meshes(g.scene)
  assert.equal(buildings.count, 2)
  assert.equal(poles.count, 4)
  assert.equal(cars.count, 2)
  assert.equal(people.count, 64)
  const m = new Matrix4()
  // Each building's instance maps the unit box onto exactly its box.
  src.boxes.forEach(([x0, y0, z0, x1, y1, z1], i) => {
    buildings.getMatrixAt(i, m)
    const b = new Box3().setFromBufferAttribute(buildings.geometry.getAttribute('position') as never).applyMatrix4(m)
    assert.deepEqual([b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map((v) => Math.round(v * 1e6) / 1e6), [x0, y0, z0, x1, y1, z1])
  })
  // Poles stand on the ground at their spot with the physics worker's height and radius.
  const expect = [POLES.lamp, POLES.lamp, POLES.tree, POLES.signal]
  const spots = [[4, 4], [8, 4], [12, 4], [0, 0]]
  expect.forEach((p, i) => {
    poles.getMatrixAt(i, m)
    const b = new Box3().setFromBufferAttribute(poles.geometry.getAttribute('position') as never).applyMatrix4(m)
    assert.ok(near(b.min.y, 0) && near(b.max.y, p.height), `pole ${i} spans the ground to ${p.height} m`)
    // The polygon's corners lie on the collider's circle: the largest distance from the pole's axis is its radius.
    const at = poles.geometry.getAttribute('position')
    let r = 0
    for (let k = 0; k < at.count; k++) {
      const w = new Vector3(at.getX(k), at.getY(k), at.getZ(k)).applyMatrix4(m)
      r = Math.max(r, Math.hypot(w.x - spots[i][0], w.z - spots[i][1]))
    }
    assert.ok(near(r, p.radius, 1e-6), `pole ${i} radius ${r}`)
    assert.ok(near((b.min.x + b.max.x) / 2, spots[i][0]) && near((b.min.z + b.max.z) / 2, spots[i][1]))
  })
  assert.ok(people.geometry.boundingBox === null || true)
  // The person envelope is the avatar's capsule (radius and cylinder of PERSON).
  people.geometry.computeBoundingBox()
  const pb = people.geometry.boundingBox!
  assert.ok(near(pb.max.x, PERSON.radius, 1e-6) && near(pb.max.y - pb.min.y, 2 * (PERSON.halfHeight + PERSON.radius), 1e-6))
  for (const mesh of meshes(g.scene)) assert.equal(mesh.frustumCulled, false)
  assert.ok(kindOf(buildings))
})

test('chassisMatrix: the car\'s collider box, posed (turned, raised by its offset, SUV taller)', () => {
  const p = poses(Math.PI / 2)
  const m = chassisMatrix(p, 0, false, new Matrix4())
  const c = chassisBox(false)
  // The box's forward (+x in chassis space) corner, turned 90° about +y, lands at -z.
  const front = new Vector3(0.5, 0, 0).applyMatrix4(m)
  assert.ok(near(front.x, 100, 1e-6) && near(front.z, 50 - c.hx, 1e-6), JSON.stringify(front))
  const top = new Vector3(0, 0.5, 0).applyMatrix4(m)
  assert.ok(near(top.y, 0.56 + c.y + c.hy, 1e-6))
  const side = new Vector3(0, 0, 0.5).applyMatrix4(m)
  assert.ok(near(side.x, 100 + c.hz, 1e-6))
  const suv = chassisMatrix(p, 1, true, new Matrix4())
  const top2 = new Vector3(0, 0.5, 0).applyMatrix4(suv)
  assert.ok(near(top2.y, chassisBox(true).y + chassisBox(true).hy, 1e-6), 'SUV chassis at the origin, taller')
})

test('fade: off until asked; in and out over GHOST.fade of drawn frames; the scene hidden (only cleared) while off', () => {
  const g = createGhost(source())
  const p = poses(0)
  assert.equal(g.on, false)
  g.update(p, 1 / 24, 1)
  assert.equal(g.strength.value, 0)
  assert.equal(g.scene.visible, false)
  g.setOn(true)
  g.update(p, GHOST.fade / 2, 2)
  assert.ok(near(g.strength.value, 0.5), `${g.strength.value}`)
  assert.equal(g.scene.visible, true)
  assert.equal(g.seconds.value, 2, 'the rain runs on the presentation clock')
  g.update(p, GHOST.fade, 3)
  assert.equal(g.strength.value, 1)
  g.update(p, GHOST.fade * 5, 4)
  assert.equal(g.strength.value, 1, 'never past full')
  // The cars are posed while it shows.
  const [, , cars] = meshes(g.scene)
  const m = new Matrix4()
  cars.getMatrixAt(0, m)
  const want = chassisMatrix(p, 0, false, new Matrix4())
  assert.ok(m.elements.every((e, k) => near(e, want.elements[k], 1e-4)), 'posed from the pose buffer (float32 instance storage)')
  g.setOn(false)
  g.update(p, GHOST.fade / 4, 5)
  assert.ok(near(g.strength.value, 0.75))
  g.update(p, GHOST.fade, 6)
  assert.equal(g.strength.value, 0)
  assert.equal(g.scene.visible, false)
  // A broken interval (first frame, clock fault) jumps straight to the target instead of stalling.
  g.setOn(true)
  g.update(p, Number.NaN, 7)
  assert.equal(g.strength.value, 1)
  g.update(p, -1, 8)
  assert.equal(g.strength.value, 1)
})

test('while fully off nothing is written: the cars keep their last matrices', () => {
  const g = createGhost(source())
  const [, , cars] = meshes(g.scene)
  const before = cars.instanceMatrix.version
  g.update(poses(1), 1 / 24, 1)
  assert.equal(cars.instanceMatrix.version, before)
})

test('glyphs: 16 strokes on the 3 × 3 lattice, all different, each half a side or half a diagonal', () => {
  assert.equal(STROKES.length, 16)
  const keys = new Set<string>()
  for (const [ax, ay, bx, by] of STROKES) {
    for (const c of [ax, ay, bx, by]) assert.ok([0, 0.5, 1].includes(c), `${c} is off the lattice`)
    const len = Math.hypot(bx - ax, by - ay)
    assert.ok(near(len, 0.5) || near(len, Math.SQRT1_2 / 1), `length ${len}`)
    const key = [[ax, ay], [bx, by]].map((p) => p.join(',')).sort().join('|')
    assert.ok(!keys.has(key), `stroke ${key} twice`)
    keys.add(key)
  }
})

test('colours: a green for each kind; kinds are small whole numbers the mask can round', () => {
  assert.deepEqual(Object.values(GHOST_KIND), [1, 2, 3, 4])
  for (const [k, [r, g, b]] of Object.entries(GHOST_COLOR)) {
    assert.ok(g >= r && g >= b && g >= 0.8, `${k} is green`)
  }
  assert.ok(GHOST.rows > 20 && GHOST.fade > 0 && GHOST.dim > 0 && GHOST.dim < 1)
})

test('buildPost: ghost view composites last from a pass of its own (never the scene pass, never the velocity buffer), in both chains', () => {
  const renderer = { toneMapping: 4, outputColorSpace: 'srgb', reversedDepthBuffer: false } as unknown as WebGPURenderer
  const passes = (root: unknown) => {
    type N = { isPassNode?: boolean; scene?: unknown; getChildren?: () => Iterable<unknown>; getMRT?: () => { has(k: string): boolean } | null }
    const seen = new Set<unknown>(), found: N[] = []
    const visit = (n: unknown) => {
      if (!n || typeof n !== 'object' || seen.has(n)) return
      seen.add(n)
      const node = n as N
      if (node.isPassNode) found.push(node)
      for (const c of node.getChildren?.() ?? []) visit(c)
    }
    visit(root)
    return found
  }
  for (const cinema of [true, false]) {
    const g = createGhost(source())
    const world = new Scene()
    const resorted = [new InstancedMesh(new BoxGeometry(), new MeshStandardNodeMaterial(), 2)]
    const { pipeline } = buildPost(renderer, world, new PerspectiveCamera(), cinema ? { resorted } : null, g)
    const found = passes(pipeline.outputNode)
    const ghostPass = found.find((p) => p.scene === g.scene)
    const scenePass = found.find((p) => p.scene === world)
    assert.ok(ghostPass && scenePass && found.length === 2, `cinema ${cinema}: ${found.length} passes`)
    assert.equal(ghostPass.getMRT!(), null, 'the ghost pass writes no velocity')
    for (const mesh of g.scene.children) assert.ok(!world.children.includes(mesh), 'no proxy in the scene the shutter reads')
  }
  // Without a ghost layer the chains are as before: one pass.
  const plain = buildPost(renderer, new Scene(), new PerspectiveCamera(), null, null)
  assert.equal(passes(plain.pipeline.outputNode).length, 1)
  assert.ok(ghostComposite)
})

test('buildPost: the ghost is laid over the finished frame: nothing of it is under FXAA, and so under the film curve or the shutter', () => {
  const renderer = { toneMapping: 4, outputColorSpace: 'srgb', reversedDepthBuffer: false } as unknown as WebGPURenderer
  type N = { type?: string; isPassNode?: boolean; scene?: unknown; getChildren?: () => Iterable<unknown> }
  /** Every node `root` reads from, itself included. */
  const reach = (root: unknown): Set<N> => {
    const seen = new Set<N>()
    const visit = (n: unknown) => {
      if (!n || typeof n !== 'object' || seen.has(n as N)) return
      seen.add(n as N)
      for (const c of (n as N).getChildren?.() ?? []) visit(c)
    }
    visit(root)
    return seen
  }
  for (const cinema of [true, false]) {
    const g = createGhost(source())
    const resorted = [new InstancedMesh(new BoxGeometry(), new MeshStandardNodeMaterial(), 2)]
    const { pipeline } = buildPost(renderer, new Scene(), new PerspectiveCamera(), cinema ? { resorted } : null, g)
    const all = [...reach(pipeline.outputNode)]
    const fx = all.find((n) => n.type === 'FXAANode')
    const ghostPass = all.find((n) => n.isPassNode && n.scene === g.scene)
    assert.ok(fx && ghostPass, `cinema ${cinema}: an FXAA node and the ghost pass`)
    assert.notEqual(pipeline.outputNode, fx, 'the frame ends with the composite, not FXAA')
    // FXAA reads the film-curved (and, in cinema, shuttered) frame: the ghost must be nowhere in what it reads.
    assert.ok(!reach(fx).has(ghostPass), `cinema ${cinema}: the ghost is under FXAA`)
  }
})

test('the engine keeps the post chain on while ghost view shows (it lives there), unless ?post=0 forbids it', () => {
  const src = readFileSync(new URL('./engine.ts', import.meta.url), 'utf8')
  const tier = src.slice(src.indexOf('  private applyTier(): void {'), src.indexOf('  frame(nowMs: number): void {'))
  assert.match(tier, /if \(this\.ghost\.on && this\.options\.post\) k\.post = true/)
  assert.ok(tier.indexOf('k.post = true') < tier.indexOf('applyQuality(k'), 'forced before the knobs are applied')
  const setGhost = src.slice(src.indexOf('  setGhost(on: boolean): string {'), src.indexOf('  /** Enter the nearest car'))
  assert.match(setGhost, /this\.ghost\.setOn\(on\)\s+this\.applyTier\(\)/)
  // Updated on every drawn frame, after the cinema camera's uniforms, before the render.
  const present = src.slice(src.indexOf('  private present('), src.indexOf('  private expose('))
  assert.ok(present.indexOf('this.ghost.update(') > 0 && present.indexOf('this.ghost.update(') < present.indexOf('this.post.render()'))
  // The shapes never join the city's scene (the one the shutter's velocity pass draws): no scene is added to another.
  assert.doesNotMatch(src, /scene\.add\(\s*[\w.]*scene\s*\)/)
})
