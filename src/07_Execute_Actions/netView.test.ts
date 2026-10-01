/**
 * Why does this file exist? It proves the network ghosts' view (netView.ts) in Node over the real three graph: a pose
 * on foot becomes an instance of the crowd's business-casual body with its feet at the pose and its front turned
 * the realm's way (sin h, 0, cos h); a pose faster than anyone runs becomes the car body, its chassis RIDE_HEIGHT up
 * and its nose turned the same way; empty lists hide both meshes, non-finite poses are skipped, the room's peer
 * bound caps each mesh, and nothing of it is a body anywhere (plain matrices only).
 * What breaks if it is removed? A remote player could be drawn facing the wrong way, standing in the ground, or in the
 * wrong body, and the view could grow past the room's bound unnoticed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Matrix4, Vector3 } from 'three/webgpu'
import { LIMITS } from '../10_Network/replication.ts'
import { RIDE_HEIGHT } from './car.ts'
import { RUN } from './simProtocol.ts'

// Vite's `?raw` import, for Node (crowdCompute.test.ts's hook): crowd.ts imports the crowd's WGSL that way.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { NET_VIEW, NetView, bodyOf } = await import('./netView.ts')
const { VARIANT_NAMES } = await import('../03_Spawn_Agents/crowd.ts')

const pose = (id: number, x: number, y: number, z: number, heading: number, speed = 0) => ({ id, name: `p${id}`, x, y, z, heading, speed })

/** The instance's position and the world direction of one of its local axes. */
function placed(mesh: { getMatrixAt(i: number, m: Matrix4): void }, i: number, axis: [number, number, number]): { at: Vector3; dir: Vector3 } {
  const m = new Matrix4()
  mesh.getMatrixAt(i, m)
  const at = new Vector3().setFromMatrixPosition(m)
  const dir = new Vector3(...axis).transformDirection(m)
  return { at, dir }
}

const near = (v: Vector3, x: number, y: number, z: number, what: string) => assert.ok(Math.hypot(v.x - x, v.y - y, v.z - z) < 1e-6, `${what}: (${v.x}, ${v.y}, ${v.z})`)

test('bodyOf: a person up to a run, a car beyond it, a person for anything that is not a number', () => {
  assert.equal(bodyOf(0), 'person')
  assert.equal(bodyOf(RUN), 'person')
  assert.equal(bodyOf(RUN + 0.01), 'car')
  assert.equal(bodyOf(Number.NaN), 'person')
  assert.equal(bodyOf(Number.POSITIVE_INFINITY), 'person')
})

test('the view holds the room\'s bound of each body, starts hidden, and wears a business-casual variant', () => {
  assert.equal(NET_VIEW.max, LIMITS.peers)
  assert.ok(NET_VIEW.variant >= 0 && NET_VIEW.variant < VARIANT_NAMES.length)
  const v = new NetView()
  assert.equal(v.people.count, 0)
  assert.equal(v.cars.count, 0)
  assert.equal(v.people.visible, false)
  assert.equal(v.cars.visible, false)
  assert.equal(v.people.castShadow, false, 'a ghost casts no shadow')
  assert.equal(v.cars.castShadow, false)
  assert.equal(v.people.frustumCulled, false)
  assert.ok(v.people.geometry.getAttribute('position').count > 100, 'the crowd\'s body, not a placeholder')
  assert.ok(v.cars.geometry.getAttribute('position').count > 100, 'the fleet\'s car body')
  v.dispose()
})

test('a pose on foot: the body at the pose, feet on the ground, front along (sin h, 0, cos h); at a run\'s pace still a person', () => {
  const v = new NetView()
  const h = 0.7
  assert.equal(v.update([pose(3, 10, 0.25, -4, h, RUN)]), 1)
  assert.equal(v.people.count, 1)
  assert.equal(v.people.visible, true)
  assert.equal(v.cars.count, 0)
  assert.equal(v.cars.visible, false)
  assert.ok(v.people.instanceMatrix.version > 0, 'marked for upload')
  const { at, dir } = placed(v.people, 0, [0, 0, 1])
  near(at, 10, 0.25, -4, 'feet at the pose')
  near(dir, Math.sin(h), 0, Math.cos(h), 'the front turned the realm\'s way')
  v.dispose()
})

test('a pose faster than a run: the car body, its chassis RIDE_HEIGHT above the pose, its nose along (sin h, 0, cos h)', () => {
  const v = new NetView()
  const h = -2.1
  assert.equal(v.update([pose(5, 1, 0, 2, h, RUN * 4)]), 1)
  assert.equal(v.cars.count, 1)
  assert.equal(v.cars.visible, true)
  assert.equal(v.people.count, 0)
  assert.equal(v.people.visible, false)
  const { at, dir } = placed(v.cars, 0, [1, 0, 0])
  near(at, 1, RIDE_HEIGHT, 2, 'the chassis centre over the pose')
  near(dir, Math.sin(h), 0, Math.cos(h), 'the nose turned the realm\'s way')
  v.dispose()
})

test('mixed lists are split by body, an empty list hides both, a non-finite pose is skipped, the bound holds', () => {
  const v = new NetView()
  const list = [pose(1, 0, 0, 0, 0), pose(2, 1, 0, 0, 0, RUN * 2), pose(3, Number.NaN, 0, 0, 0), pose(4, 2, 0, 0, Number.POSITIVE_INFINITY), pose(5, 3, 0, 0, 1)]
  assert.equal(v.update(list), 3)
  assert.equal(v.people.count, 2)
  assert.equal(v.cars.count, 1)
  assert.equal(placed(v.people, 1, [0, 0, 1]).at.x, 3, 'the skipped poses take no slot')
  assert.equal(v.update([]), 0)
  assert.equal(v.people.visible, false)
  assert.equal(v.cars.visible, false)
  assert.equal(v.people.count, 0)
  const many = []
  for (let i = 0; i < NET_VIEW.max + 5; i++) many.push(pose(i, i, 0, 0, 0), pose(100 + i, i, 0, 0, 0, RUN * 2))
  assert.equal(v.update(many), NET_VIEW.max * 2)
  assert.equal(v.people.count, NET_VIEW.max)
  assert.equal(v.cars.count, NET_VIEW.max)
  v.dispose()
})
