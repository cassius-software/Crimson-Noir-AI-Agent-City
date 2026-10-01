/**
 * Why does this file exist? It pins the code dissolve's wiring (Phase 7.2): the meshes carry their `dissolve`
 * amounts (one float per prop instance, per car body and per wheel slot, per pedestrian) and take the helper over
 * their own shading with the fleet's cabin mask kept; the engine gathers the people with the newest crowd frame
 * before it goes back to the worker, touches poles, cars and people every animation frame right after the contact
 * pulse, never the driven car, flushes the amounts in present() before the frame that reads them and reports them in
 * the snapshot; the copy to the GPU-side arrays covers exactly the dirty range (four per car for the wheels); two
 * cars passing through each other (7.1) are both found from their poses alone; and nothing of it crosses to the
 * physics realm or touches the buildings, whose walls stay solid by law.
 * What breaks if it is removed? A later edit could flush after the render (a frame late), dissolve the car the user
 * is sitting in, drop the fleet's cabin mask, write the amounts into the worker's protocol, or let a building
 * dissolve, unnoticed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { InstancedBufferAttribute, type InstancedMesh, type MeshStandardNodeMaterial } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { PROP_DISSOLVE_INK } from '../01_Initialize_World/world.ts'
import { chassisBox } from './car.ts'
import { DISSOLVE, DISSOLVE_COLOR, DissolveBuffer, DissolveSet, carsOverlapping, copyDirty } from './dissolve.ts'
import { FleetView } from './fleetView.ts'
import { POSE } from './simProtocol.ts'

// Vite's `?raw` import, for Node (crowdCompute.test.ts's hook): crowd.ts imports the crowd's WGSL that way.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { CrowdView, PEOPLE_DISSOLVE_INK } = await import('../03_Spawn_Agents/crowd.ts')

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from)
  assert.ok(a >= 0, `missing ${from}`)
  const b = src.indexOf(to, a)
  assert.ok(b > a, `missing ${to} after ${from}`)
  return src.slice(a, b)
}
const before = (s: string, first: string, second: string, why: string) => {
  const a = s.indexOf(first), b = s.indexOf(second)
  assert.ok(a >= 0, `missing ${first}`)
  assert.ok(b >= 0, `missing ${second}`)
  assert.ok(a < b, why)
}

type N = { getChildren?: () => Iterable<unknown>; isFrontFacingNode?: boolean }
/** The one node material an instanced mesh here is drawn with. */
const materialOf = (mesh: InstancedMesh): MeshStandardNodeMaterial => mesh.material as MeshStandardNodeMaterial
/** Every node `root` reads from, itself included (ghost.test.ts's walk). */
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

/** A pose buffer of `n` cars at rest, each at (x, z) facing `heading`. */
function poses(cars: [x: number, z: number, heading: number][]): Float32Array {
  const p = new Float32Array(cars.length * POSE.stride)
  cars.forEach(([x, z, h], i) => {
    const o = i * POSE.stride
    p[o + POSE.x] = x; p[o + POSE.z] = z; p[o + POSE.heading] = h; p[o + POSE.qw] = 1
  })
  return p
}

test('the inks the lower stages repeat are the ghost view\'s greens dissolve.ts hands out', () => {
  assert.deepEqual([...PROP_DISSOLVE_INK], [...DISSOLVE_COLOR.lamps])
  assert.deepEqual([...PROP_DISSOLVE_INK], [...DISSOLVE_COLOR.trees])
  assert.deepEqual([...PROP_DISSOLVE_INK], [...DISSOLVE_COLOR.signals])
  assert.deepEqual([...PEOPLE_DISSOLVE_INK], [...DISSOLVE_COLOR.people])
})

test('the fleet: a dissolve amount per body slot and four per car for the wheels, the cabin mask kept under the dissolve', () => {
  const view = new FleetView([false, true, false], [0x808080, 0x101010, 0x204060], uniform(0))
  const bodies = view.bodies.geometry.getAttribute('dissolve') as InstancedBufferAttribute
  const wheels = view.wheels.geometry.getAttribute('dissolve') as InstancedBufferAttribute
  assert.ok(bodies instanceof InstancedBufferAttribute && wheels instanceof InstancedBufferAttribute)
  assert.equal(bodies, view.dissolve.bodies)
  assert.equal(wheels, view.dissolve.wheels)
  assert.equal(bodies.itemSize, 1)
  assert.equal(wheels.itemSize, 1)
  assert.equal(bodies.count, 3)
  assert.equal(wheels.count, 12, 'wheel w of car i is slot i * 4 + w')
  assert.ok([...(bodies.array as Float32Array)].every((v) => v === 0), 'every car solid at boot')
  // An empty fleet keeps its one slot (WebGPU refuses a zero-sized binding), as the paint attribute does.
  const empty = new FleetView([], [], uniform(0))
  assert.equal(empty.dissolve.bodies.count, 1)
  assert.equal(empty.dissolve.wheels.count, 4)
  for (const mesh of [view.bodies, view.wheels]) {
    const m = materialOf(mesh)
    assert.ok(m.positionNode && m.maskNode && m.emissiveNode && m.colorNode, `${mesh.name}: the helper set its nodes`)
  }
  // The cabin shell's mask (frontFacing.or(glass.not())) is still in the body material's mask graph.
  assert.ok([...reach(materialOf(view.bodies).maskNode)].some((n) => n.isFrontFacingNode === true), 'the body mask still reads frontFacing')
  assert.ok(![...reach(materialOf(view.wheels).maskNode)].some((n) => n.isFrontFacingNode === true), 'the wheels had no mask to keep')
})

test('the crowd: one amount per agent in a storage attribute named crowd.dissolve, read by every body material', () => {
  const view = new CrowdView(64)
  assert.equal(view.dissolve.name, 'crowd.dissolve')
  assert.equal(view.dissolve.count, 64)
  assert.equal(view.dissolve.itemSize, 1)
  assert.ok(view.dissolve.array instanceof Float32Array)
  assert.equal(view.meshes.length, 8)
  for (const mesh of view.meshes) {
    const m = materialOf(mesh)
    assert.ok(m.positionNode && m.castShadowPositionNode && m.maskNode && m.emissiveNode, `${mesh.name}: posed for the eye and the shadow, masked, inked`)
  }
  const crowd = read('../03_Spawn_Agents/crowd.ts')
  // Read in posed() by the agent's index, into the varying the fragment stage takes, in both passes; folded there too.
  const posed = between(crowd, 'const posed = (eye: boolean) =>', 'm.positionNode = posed(true)')
  assert.match(posed, /const dissolve = b\.dissolve\.element\(agentIndex\)/)
  before(posed, 'vDissolve.assign(dissolve)', 'if (!eye) return body', 'the shadow pass writes the varying too')
  assert.match(posed, /select\(inside\.or\(gone\), agent\.xyz, body\)/)
  assert.match(crowd, /applyCodeDissolve\(m, vDissolve, feet, PEOPLE_DISSOLVE_INK\)/)
  // The air gap: the worker's crowd module never binds it, the protocol never carries it.
  assert.doesNotMatch(read('../03_Spawn_Agents/crowd.wgsl'), /dissolve/i)
  assert.doesNotMatch(read('../03_Spawn_Agents/crowdCompute.ts'), /dissolve/i)
  assert.doesNotMatch(read('./simProtocol.ts'), /dissolve/i)
})

test('the props: a dissolve attribute on each of the three prop geometries, the helper on each material, never on the buildings', () => {
  const world = read('../01_Initialize_World/world.ts')
  const props = between(world, 'function furnitureMeshes(', '\nexport function buildWorld(')
  for (const geo of ['lampGeo', 'treeGeo', 'signalGeo']) assert.match(props, new RegExp(`${geo}\\.setAttribute\\('dissolve', dissolve\\.\\w+\\)`))
  for (const mat of ['lampMat', 'treeMat', 'signalMat']) assert.match(props, new RegExp(`applyCodeDissolve\\(${mat}, amount, origin, PROP_DISSOLVE_INK\\)`))
  // The tree's own position node (the sway) is set before the helper wraps it.
  before(props, 'treeMat.positionNode = Fn(', 'applyCodeDissolve(treeMat,', 'the sway is under the fold')
  assert.equal(world.match(/applyCodeDissolve\(/g)?.length, 3, 'three props, nothing else')
  assert.doesNotMatch(read('../01_Initialize_World/materials.ts'), /dissolve/i, 'the buildings\' material is untouched: walls are solid by law')
  assert.match(world, /dissolve: PropDissolve\n/)
  assert.match(world, /region: regionScene, dissolve, update \}/)
})

test('wiring: the people are gathered before the upload, the touches follow the contact pulse, the flush precedes the render, the snapshot reports it', () => {
  const src = read('./engine.ts')
  const received = between(src, '  private received(', '    for (const ev of s.events) {')
  before(received, 'this.contactScan(s)', 'this.crowd.upload(', 'the frame is read before it goes back to the worker')
  const scan = between(src, '  private contactScan(', '  /** What the user\'s body is passing through now')
  assert.match(scan, /this\.peopleCount = peopleWithin\(frame, n, s\.avatar\.x, s\.avatar\.z, PERSON\.radius \+ DISSOLVE\.reach, this\.peopleOut\)/)
  assert.match(scan, /this\.peopleCount = peopleWithinBox\(frame, n, [^\n]*c\.hx \+ DISSOLVE\.reach, c\.hz \+ DISSOLVE\.reach, this\.peopleOut\)/)
  const frame = between(src, '  frame(nowMs: number): void {', '  /** One drawn frame')
  before(frame, 'this.contactPulse.update(this.contactNow(st), realDt / 1000)', 'this.dissolveNow(st)', 'touched right after the contact pulse')
  before(frame, 'this.dissolveNow(st)', 'this.dissolve.update(realDt / 1000)', 'the envelope runs after the touches, on the wall clock')
  before(frame, 'this.dissolve.update(realDt / 1000)', 'this.present(', 'before the drawn frame reads it')
  const present = between(src, '  private present(', '  /** "Region')
  before(present, 'this.flushDissolve()', 'this.post.render()', 'flushed before the post chain draws')
  before(present, 'this.flushDissolve()', 'this.gpu.renderer.render(this.world.scene, cam)', 'flushed before the direct draw')
  const now = between(src, '  private dissolveNow(', '  private flushDissolve(')
  // The driven car never dissolves: cars are scanned on foot only, and it is skipped in the pass-through scan.
  const onFoot = now.slice(now.indexOf('} else {'))
  assert.ok(now.indexOf('carsWithin(') > now.indexOf('} else {') && onFoot.includes('carsWithin(st.poses, suv, x, z, pad, this.carOut)'), 'cars on foot only')
  assert.match(now, /carsOverlapping\(st\.poses, suv, DISSOLVE\.reach, this\.overlapOut, d\)/)
  assert.match(now, /this\.poles\.withinBox\(/)
  assert.match(now, /this\.poles\.within\(x, z, pad, this\.poleOut\)/)
  assert.match(now, /set\.touch\('people', this\.peopleOut\[i\]\)/)
  const flush = between(src, '  private flushDissolve(', '  /**\n   * The cinema camera')
  assert.match(flush, /this\.gpu\.device\.queue\.writeBuffer\(this\.crowdDissolve, people\.dirtyStart \* 4, people\.values, people\.dirtyStart, people\.dirtyEnd - people\.dirtyStart\)/)
  assert.match(flush, /copyDirty\(set\.cars, fleet\.wheels\.array as Float32Array, 4\)/)
  assert.match(src, /crowdDissolve: gpuBufferOf\(gpu\.renderer, view0\.dissolve\)/)
  assert.match(src, /dissolve: \{ active: this\.dissolve\.active, count: this\.dissolve\.count \}/)
  assert.match(read('../05_Observe_Environment/telemetry.ts'), /dissolve\?: \{ active: number; count: number \}/)
})

test('copyDirty: exactly the dirty range, `stride` floats per slot, nothing when clean, bounded by the array', () => {
  const b = new DissolveBuffer(6)
  const one = new Float32Array(6).fill(-1)
  assert.equal(copyDirty(b, one), 0, 'a clean buffer writes nothing')
  assert.ok([...one].every((v) => v === -1))
  b.values[2] = 1; b.mark(2)
  b.values[4] = 0.5; b.mark(4)
  assert.equal(copyDirty(b, one), 3, 'slots 2..4')
  assert.deepEqual([...one], [-1, -1, 1, 0, 0.5, -1])
  const four = new Float32Array(24).fill(-1)
  assert.equal(copyDirty(b, four, 4), 12)
  assert.deepEqual([...four.slice(8, 20)], [1, 1, 1, 1, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5])
  assert.ok([...four.slice(0, 8), ...four.slice(20)].every((v) => v === -1), 'other cars untouched')
  // A short array bounds the copy; a broken stride copies nothing.
  const short = new Float32Array(3)
  assert.equal(copyDirty(b, short), 1)
  assert.equal(short[2], 1)
  assert.equal(copyDirty(b, four, 0), 0)
  assert.equal(copyDirty(b, four, Number.NaN), 0)
  b.clean()
  assert.equal(copyDirty(b, one), 0)
})

test('carsOverlapping: two cars whose footprints cross are both found, from the poses alone; apart, neither', () => {
  const hz = chassisBox(false).hz, hx = chassisBox(false).hx
  const out = new Int32Array(8)
  // Side by side, just clear of each other (no pad): nothing. Nudged into each other: both.
  assert.equal(carsOverlapping(poses([[0, 0, 0], [2 * hz + 0.05, 0, 0]]), [false, false], 0, out), 0)
  assert.equal(carsOverlapping(poses([[0, 0, 0], [2 * hz - 0.05, 0, 0]]), [false, false], 0, out), 2)
  assert.deepEqual([...out.slice(0, 2)], [0, 1])
  // The pad grows the footprints: the clear pair overlaps once grown by the reach.
  assert.equal(carsOverlapping(poses([[0, 0, 0], [2 * hz + 0.05, 0, 0]]), [false, false], DISSOLVE.reach, out), 2)
  // Nose to tail along the heading: clear at 2 hx + a hair, overlapping a hair closer.
  assert.equal(carsOverlapping(poses([[0, 0, 0], [0, 2 * hx + 0.02, 0]]), [false, false], 0, out), 0)
  assert.equal(carsOverlapping(poses([[0, 0, 0], [0, 2 * hx - 0.02, 0]]), [false, false], 0, out), 2)
  // A T: one across the other's nose. Its side sits hz past the first's nose: clear; closer: both.
  assert.equal(carsOverlapping(poses([[0, 0, 0], [0, hx + hz + 0.02, Math.PI / 2]]), [false, false], 0, out), 0)
  assert.equal(carsOverlapping(poses([[0, 0, 0], [0, hx + hz - 0.02, Math.PI / 2]]), [false, false], 0, out), 2)
  // Diagonal corners: the bounding circles touch but the boxes do not (the separating axis sees it).
  assert.equal(carsOverlapping(poses([[0, 0, 0], [2 * hz + 0.3, 2 * hx - 0.5, 0]]), [false, false], 0, out), 0)
  // One pair among others: only the pair.
  const p = poses([[0, 0, 0], [40, 0, 1], [40.5, 0.2, 1.2], [-30, 10, 2]])
  assert.equal(carsOverlapping(p, [false, true, false, true], 0, out), 2)
  assert.deepEqual([...out.slice(0, 2)], [1, 2])
  // The driven car is never reported, but the car passing through it is.
  assert.equal(carsOverlapping(p, [false, true, false, true], 0, out, 1), 1)
  assert.equal(out[0], 2)
  // The cap and a short pose buffer.
  assert.equal(carsOverlapping(p, [false, true, false, true], 0, new Int32Array(1)), 1)
  assert.equal(carsOverlapping(p.slice(0, 2 * POSE.stride), [false, true, false, true], 0, out), 0, 'a short buffer ends the scan')
  assert.equal(carsOverlapping(p, [false, true, false, true], Number.NaN, out), 0)
  assert.equal(carsOverlapping(p, [false, true, false, true], 0, new Int32Array(0)), 0)
})

test('the envelope end to end: a touched car and its wheels flush once, fall back, and the set is clean after', () => {
  const set = new DissolveSet({ lamps: 0, trees: 0, signals: 0, cars: 3, people: 0 })
  const bodies = new Float32Array(3), wheels = new Float32Array(12)
  set.touch('cars', 1)
  assert.equal(copyDirty(set.cars, bodies), 1)
  assert.equal(copyDirty(set.cars, wheels, 4), 4)
  set.cars.clean()
  assert.deepEqual([...bodies], [0, 1, 0])
  assert.deepEqual([...wheels.slice(4, 8)], [1, 1, 1, 1])
  assert.equal(set.active, 1)
  assert.equal(set.count, 1)
  for (let i = 0; i < 30; i++) set.update(DISSOLVE.release / 10)
  assert.equal(set.cars.values[1], 0, 'back to solid')
  assert.ok(set.cars.dirty, 'the fall is flushed too')
  copyDirty(set.cars, bodies)
  set.cars.clean()
  assert.deepEqual([...bodies], [0, 0, 0])
  assert.equal(set.active, 0)
  assert.ok(!set.cars.dirty)
})
