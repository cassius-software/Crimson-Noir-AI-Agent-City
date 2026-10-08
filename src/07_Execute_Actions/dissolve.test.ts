// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the code dissolve's page-side half (dissolve.ts) and the identity scans it
 * takes from contact.ts: a touched slot is at 1 in the same frame, an untouched one falls to exactly 0 over
 * DISSOLVE.release, a slot touched every frame holds, a broken interval moves nothing, each passage counts once,
 * dirty ranges cover exactly the slots written and clear on clean(); the scans agree with a brute force over the
 * real city's furniture for thousands of probes, never report the avatar's own row, a hidden row or the driven car,
 * and honour their caps; and poleSlot maps the pole index onto the same instance order ghost.ts's proxies take.
 * What breaks if it is removed? A mesh could stay dissolved after the body is clear, a passage could count twice,
 * a lamp one cell over could be missed, or a pole could dissolve the wrong instance, unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InstancedMesh, Matrix4, StorageBufferAttribute, Vector3 } from 'three/webgpu'
import { POLES, streetFurniture } from '../01_Initialize_World/city.ts'
import { chassisBox } from './car.ts'
import { CONTACT, PoleIndex, boxGap, carsWithin, peopleWithin, peopleWithinBox } from './contact.ts'
import { DISSOLVE, DISSOLVE_COLOR, DISSOLVE_KINDS, DissolveBuffer, DissolveSet, poleSlot } from './dissolve.ts'
import { GHOST_COLOR, createGhost } from './ghost.ts'
import { PERSON, POSE } from './simProtocol.ts'

const near = (a: number, b: number, eps = 1e-5) => Math.abs(a - b) <= eps
const SLOTS = { lamps: 16, trees: 8, signals: 4, cars: 6, people: 32 } as const

test('the constants: a reach, a release, caps per kind; the inks are the ghost view\'s greens', () => {
  assert.ok(Object.isFrozen(DISSOLVE))
  assert.ok(DISSOLVE.reach > 0 && DISSOLVE.reach < 1)
  assert.ok(DISSOLVE.release > 0 && DISSOLVE.release < 2)
  assert.ok(DISSOLVE.maxPoles >= 1 && DISSOLVE.maxPeople >= 1 && DISSOLVE.maxCars >= 1)
  assert.deepEqual([...DISSOLVE_KINDS], ['lamps', 'trees', 'signals', 'cars', 'people'])
  assert.equal(DISSOLVE_COLOR.lamps, GHOST_COLOR.pole)
  assert.equal(DISSOLVE_COLOR.trees, GHOST_COLOR.pole)
  assert.equal(DISSOLVE_COLOR.signals, GHOST_COLOR.pole)
  assert.equal(DISSOLVE_COLOR.cars, GHOST_COLOR.vehicle)
  assert.equal(DISSOLVE_COLOR.people, GHOST_COLOR.person)
  for (const [r, g, b] of Object.values(DISSOLVE_COLOR)) assert.ok(g >= r && g >= b, 'green')
})

test('the envelope: at 1 the frame it is touched, down to exactly 0 over release, held while touched', () => {
  const d = new DissolveSet(SLOTS)
  const dt = 1 / 120
  d.touch('lamps', 3)
  assert.equal(d.lamps.values[3], 1, 'instantly dissolved, before any update')
  d.update(dt)
  assert.equal(d.lamps.values[3], 1, 'and still after the frame it was touched in')
  assert.equal(d.active, 1)
  assert.equal(d.count, 1)
  // Held while touched every frame.
  for (let i = 0; i < 200; i++) { d.touch('lamps', 3); d.update(dt) }
  assert.equal(d.lamps.values[3], 1, 'held while the body is inside')
  assert.equal(d.count, 1, 'one passage, one count')
  // Released: down to exactly 0 over `release` ± dt.
  let t = 0
  while (d.lamps.values[3] > 0 && t < 2) { d.update(dt); t += dt }
  assert.ok(near(t, DISSOLVE.release, dt + 1e-9), `reinstantiated after ${t.toFixed(3)} s`)
  assert.equal(d.lamps.values[3], 0, 'exactly 0, never a trace left')
  assert.equal(d.active, 0)
  for (let i = 0; i < 50; i++) d.update(dt)
  assert.equal(d.lamps.values[3], 0)
  for (const k of DISSOLVE_KINDS) for (const v of d[k].values) assert.ok(v >= 0 && v <= 1)
})

test('the envelope: a broken interval moves nothing, a long one is clamped; a touch mid-release jumps back to 1', () => {
  const d = new DissolveSet(SLOTS)
  d.touch('people', 7)
  d.update(1 / 60)
  d.update(1 / 60)
  const v = d.people.values[7]
  assert.ok(v > 0 && v < 1)
  d.update(Number.NaN)
  d.update(-1)
  d.update(0)
  assert.equal(d.people.values[7], v, 'nothing moves on a broken interval')
  d.touch('people', 7)
  assert.equal(d.people.values[7], 1, 'back at once')
  d.update(1 / 60)
  d.update(10)
  assert.ok(near(d.people.values[7], Math.max(0, 1 - 0.25 / DISSOLVE.release), 1e-6), 'a long interval is clamped to 0.25 s (float32 storage)')
})

test('count: once per passage; a new passage after a release counts again; the same frame\'s touches count once', () => {
  const d = new DissolveSet(SLOTS)
  d.touch('cars', 1)
  d.touch('cars', 1)
  d.touch('cars', 1)
  assert.equal(d.count, 1, 'several touches in one frame are one passage')
  d.update(1 / 60)
  d.touch('cars', 1)
  assert.equal(d.count, 1, 'the next frame continues it')
  for (let i = 0; i < 60; i++) d.update(1 / 60)
  assert.equal(d.cars.values[1], 0)
  d.touch('cars', 1)
  assert.equal(d.count, 2, 'a new passage')
  d.update(1 / 60)
  d.update(1 / 60)
  d.touch('cars', 1)
  assert.equal(d.count, 3, 'leaving and coming back during the release is another passage')
  d.touch('trees', 0)
  d.touch('signals', 2)
  assert.equal(d.count, 5)
  assert.equal(d.active, 3)
  // Out of range, not whole, or of a kind with no slots: ignored.
  d.touch('signals', 99)
  d.touch('signals', -1)
  d.touch('signals', 1.5)
  d.touch('signals', Number.NaN)
  assert.equal(d.count, 5)
  assert.equal(d.active, 3)
  const empty = new DissolveSet({ lamps: 0, trees: 0, signals: 0, cars: 0, people: 0 })
  empty.touch('lamps', 0)
  empty.update(1 / 60)
  assert.equal(empty.active, 0)
  assert.equal(empty.count, 0)
})

test('buffers: only the touched slots are written, the dirty range covers exactly them, clean() clears it', () => {
  const d = new DissolveSet(SLOTS)
  assert.equal(d.lamps.values.length, SLOTS.lamps)
  assert.equal(d.people.values.length, SLOTS.people)
  assert.equal(d.lamps.dirty, false)
  d.touch('lamps', 5)
  d.touch('lamps', 9)
  assert.equal(d.lamps.dirty, true)
  assert.equal(d.lamps.dirtyStart, 5)
  assert.equal(d.lamps.dirtyEnd, 10)
  assert.equal(d.trees.dirty, false, 'another mesh untouched')
  const written = [...d.lamps.values].map((v, i) => (v !== 0 ? i : -1)).filter((i) => i >= 0)
  assert.deepEqual(written, [5, 9])
  d.lamps.clean()
  assert.equal(d.lamps.dirty, false)
  d.update(1 / 60)
  assert.equal(d.lamps.dirty, false, 'held slots are not rewritten')
  d.update(1 / 60)
  assert.equal(d.lamps.dirty, true, 'releasing slots are')
  assert.equal(d.lamps.dirtyStart, 5)
  assert.equal(d.lamps.dirtyEnd, 10)
  d.lamps.clean()
  d.touch('lamps', 2)
  d.update(1 / 60)
  assert.equal(d.lamps.dirtyStart, 2, 'the range grows down to a new slot')
  assert.equal(d.lamps.dirtyEnd, 10)
  assert.equal(d.buffer('lamps'), d.lamps)
  // The live list stays consistent through releases in any order.
  const b = new DissolveBuffer(4)
  b.activate(2); b.activate(0); b.activate(3)
  assert.equal(b.active, 3)
  b.deactivate(2)
  assert.equal(b.active, 2)
  assert.deepEqual([...b.live.subarray(0, 2)].sort(), [0, 3])
  b.deactivate(2)
  assert.equal(b.active, 2)
  assert.equal(new DissolveBuffer(Number.NaN).values.length, 0)
})

// ---------------------------------------------------------------------------------------------------
// Identity

const furnitureAll = (f: ReturnType<typeof streetFurniture>): [number, number, number][] => [
  ...f.lamps.map(([x, z]) => [x, z, POLES.lamp.radius] as [number, number, number]),
  ...f.trees.map(([x, z]) => [x, z, POLES.tree.radius] as [number, number, number]),
  ...f.signals.map(([x, z]) => [x, z, POLES.signal.radius] as [number, number, number]),
]

test('PoleIndex.within: exactly the poles a brute force over the real city finds the disc inside, for thousands of probes', () => {
  const f = streetFurniture(1337)
  const index = new PoleIndex(f)
  const all = furnitureAll(f)
  let seed = 11
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
  const out = new Int32Array(DISSOLVE.maxPoles)
  let hits = 0
  for (let k = 0; k < 4000; k++) {
    const [px, pz] = all[Math.floor(rnd() * all.length)]
    const x = k % 2 ? px + (rnd() - 0.5) * 1.2 : rnd() * 700 - 30
    const z = k % 2 ? pz + (rnd() - 0.5) * 1.2 : rnd() * 700 - 30
    const pad = rnd() < 0.5 ? PERSON.radius : PERSON.radius + DISSOLVE.reach
    const brute = all.map(([ax, az, r], i) => (Math.hypot(ax - x, az - z) - r - pad < 0 ? i : -1)).filter((i) => i >= 0)
    const n = index.within(x, z, pad, out)
    assert.deepEqual([...out.subarray(0, n)].sort((a, b) => a - b), brute, `(${x.toFixed(2)}, ${z.toFixed(2)}) pad ${pad}`)
    for (let j = 0; j < n; j++) {
      const i = out[j]
      // Never a pole outside the 3 × 3 cells around the point.
      assert.ok(Math.abs(Math.floor(all[i][0] / CONTACT.cell) - Math.floor(x / CONTACT.cell)) <= 1)
      assert.ok(Math.abs(Math.floor(all[i][1] / CONTACT.cell) - Math.floor(z / CONTACT.cell)) <= 1)
    }
    hits += n
  }
  assert.ok(hits > 500, `${hits} hits across the probes`)
  assert.equal(index.within(Number.NaN, 0, 1, out), 0)
  assert.equal(index.within(-5000, -5000, 1, out), 0, 'nothing out in the lake')
  assert.equal(index.within(all[0][0], all[0][1], 1, new Int32Array(0)), 0, 'no room, nothing reported')
  // The cap: between the two nearest poles, a pad reaching both reports at most out.length.
  let bestD = Infinity, pa = 0, pb = 0
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const dd = Math.hypot(all[i][0] - all[j][0], all[i][1] - all[j][1])
      if (dd < bestD) { bestD = dd; pa = i; pb = j }
    }
  }
  // Each of the pair is within a cell edge of their midpoint, so the 3 × 3 scan around it reaches both.
  assert.ok(bestD / 2 <= CONTACT.cell, `the nearest pair stands ${bestD.toFixed(2)} m apart`)
  const mx = (all[pa][0] + all[pb][0]) / 2, mz = (all[pa][1] + all[pb][1]) / 2
  assert.equal(index.within(mx, mz, bestD / 2 + 0.5, new Int32Array(1)), 1)
  assert.ok(index.within(mx, mz, bestD / 2 + 0.5, new Int32Array(64)) >= 2)
})

test('PoleIndex.withinBox: the poles standing in a chassis footprint, as a brute force finds them', () => {
  const f = streetFurniture(1337)
  const index = new PoleIndex(f)
  const all = furnitureAll(f)
  const c = chassisBox(true)
  let seed = 23
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
  const out = new Int32Array(DISSOLVE.maxPoles)
  let hits = 0
  for (let k = 0; k < 3000; k++) {
    const [px, pz] = all[Math.floor(rnd() * all.length)]
    const x = k % 2 ? px + (rnd() - 0.5) * 5 : rnd() * 700 - 30
    const z = k % 2 ? pz + (rnd() - 0.5) * 5 : rnd() * 700 - 30
    const h = rnd() * Math.PI * 2
    const brute = all.map(([ax, az, r], i) => (boxGap(ax - x, az - z, h, c.hx, c.hz) - r < 0 ? i : -1)).filter((i) => i >= 0)
    const n = index.withinBox(x, z, h, c.hx, c.hz, out)
    assert.deepEqual([...out.subarray(0, n)].sort((a, b) => a - b), brute, `(${x.toFixed(2)}, ${z.toFixed(2)}) heading ${h.toFixed(2)}`)
    hits += n
  }
  assert.ok(hits > 300, `${hits} hits across the probes`)
  assert.equal(index.withinBox(Number.NaN, 0, 0, c.hx, c.hz, out), 0)
  assert.equal(index.withinBox(0, 0, Number.NaN, c.hx, c.hz, out), 0)
  assert.equal(index.withinBox(all[0][0], all[0][1], 0, c.hx, c.hz, new Int32Array(0)), 0)
  // A footprint wider than one cell still finds every pole in it (gapToBox refuses it; within does not).
  const wide = new Int32Array(64)
  const n = index.withinBox(all[0][0], all[0][1], 0, 12, 12, wide)
  const brute = all.filter(([ax, az, r]) => boxGap(ax - all[0][0], az - all[0][1], 0, 12, 12) - r < 0).length
  assert.equal(n, Math.min(brute, 64))
  assert.ok(n > 1)
})

/** A crowd render frame: pos (x, y, z, heading) per person first. */
function frame(people: [number, number, number][]): Float32Array {
  const f = new Float32Array(people.length * 12)
  people.forEach(([x, y, z], i) => { f[4 * i] = x; f[4 * i + 1] = y; f[4 * i + 2] = z })
  return f
}

test('peopleWithin: every body the disc is inside, never row 0, never a hidden row; the cap and the agent count hold', () => {
  // Row 0 stands on the point; row 1 is hidden on it; rows 2 and 4 are inside; row 3 is clear; row 5 just outside.
  const pad = PERSON.radius + DISSOLVE.reach
  const reach = PERSON.radius + pad
  const f = frame([[10, 0, 10], [10.1, -100, 10], [10.3, 0, 10], [12, 0, 10], [10, 0, 10.5], [10 + reach + 0.01, 0, 10]])
  const out = new Int32Array(8)
  let n = peopleWithin(f, 6, 10, 10, pad, out)
  assert.deepEqual([...out.subarray(0, n)], [2, 4])
  n = peopleWithin(f, 3, 10, 10, pad, out)
  assert.deepEqual([...out.subarray(0, n)], [2], 'agents limits the scan')
  assert.equal(peopleWithin(f, 6, 10, 10, pad, new Int32Array(1)), 1, 'capped')
  assert.equal(peopleWithin(f, 6, 10, 10, pad, new Int32Array(0)), 0)
  assert.equal(peopleWithin(null, 6, 10, 10, pad, out), 0)
  assert.equal(peopleWithin(f, 6, Number.NaN, 10, pad, out), 0)
  assert.equal(peopleWithin(frame([[10, 0, 10]]), 1, 10, 10, pad, out), 0, 'alone: nobody')
  // A frame shorter than the count says is read only as far as it goes.
  assert.equal(peopleWithin(f.subarray(0, 12), 99, 10, 10, pad, out), 1)
  // Brute force over a random crowd.
  let seed = 5
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
  const people: [number, number, number][] = []
  for (let i = 0; i < 400; i++) people.push([rnd() * 20, rnd() < 0.2 ? -100 : 0, rnd() * 20])
  const big = frame(people)
  const wide = new Int32Array(400)
  for (let k = 0; k < 500; k++) {
    const x = rnd() * 20, z = rnd() * 20
    const brute = people.map(([px, py, pz], i) => (i > 0 && py > -50 && Math.hypot(px - x, pz - z) - PERSON.radius - pad < 0 ? i : -1)).filter((i) => i >= 0)
    const got = peopleWithin(big, 400, x, z, pad, wide)
    assert.deepEqual([...wide.subarray(0, got)], brute)
  }
})

test('peopleWithinBox: the people standing in a chassis footprint, never row 0 or a hidden row', () => {
  const c = chassisBox(false)
  // Car at (100, 50) facing +z. Row 1 is a metre clear of the side; row 2 stands at the bumper, inside; row 3 is hidden inside; row 4 is at the centre.
  const f = frame([[100, 0, 50], [100 + c.hz + PERSON.radius + 1, 0, 50], [100, 0, 50 + c.hx], [100, -100, 50], [100, 0, 50]])
  const out = new Int32Array(8)
  let n = peopleWithinBox(f, 5, 100, 50, 0, c.hx, c.hz, out)
  assert.deepEqual([...out.subarray(0, n)], [2, 4])
  n = peopleWithinBox(f, 5, 100, 50, 0, c.hx, c.hz, new Int32Array(1))
  assert.equal(n, 1, 'capped')
  assert.equal(peopleWithinBox(null, 5, 100, 50, 0, c.hx, c.hz, out), 0)
  assert.equal(peopleWithinBox(f, 5, Number.NaN, 50, 0, c.hx, c.hz, out), 0)
  assert.equal(peopleWithinBox(f, 5, 100, 50, Number.NaN, c.hx, c.hz, out), 0)
  // Turned a quarter: the long side now runs along x, so the bumper row is clear and row 1 (beside the old side,
  // within a half length) is inside.
  n = peopleWithinBox(f, 5, 100, 50, Math.PI / 2, c.hx, c.hz, out)
  assert.deepEqual([...out.subarray(0, n)], [1, 4])
  // Brute force over a random crowd, random poses.
  let seed = 9
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
  const people: [number, number, number][] = []
  for (let i = 0; i < 300; i++) people.push([rnd() * 20, rnd() < 0.2 ? -100 : 0, rnd() * 20])
  const big = frame(people)
  const wide = new Int32Array(300)
  for (let k = 0; k < 300; k++) {
    const x = rnd() * 20, z = rnd() * 20, h = rnd() * 7
    const brute = people.map(([px, py, pz], i) => (i > 0 && py > -50 && boxGap(px - x, pz - z, h, c.hx, c.hz) - PERSON.radius < 0 ? i : -1)).filter((i) => i >= 0)
    const got = peopleWithinBox(big, 300, x, z, h, c.hx, c.hz, wide)
    assert.deepEqual([...wide.subarray(0, got)], brute)
  }
})

test('carsWithin: every car whose footprint holds the disc; the driven car is skipped; a short pose buffer ends the scan', () => {
  const c = chassisBox(false)
  const poses = new Float32Array(3 * POSE.stride)
  // Cars 0 and 1 both stand at (100, 50) (cars pass through cars); car 2 is far away.
  poses[POSE.x] = 100; poses[POSE.z] = 50
  poses[POSE.stride + POSE.x] = 100; poses[POSE.stride + POSE.z] = 50; poses[POSE.stride + POSE.heading] = 1
  poses[2 * POSE.stride + POSE.x] = -500; poses[2 * POSE.stride + POSE.z] = -500
  const suv = [false, true, false]
  const out = new Int32Array(DISSOLVE.maxCars)
  let n = carsWithin(poses, suv, 100, 50, PERSON.radius, out)
  assert.deepEqual([...out.subarray(0, n)], [0, 1])
  n = carsWithin(poses, suv, 100, 50, PERSON.radius, out, 0)
  assert.deepEqual([...out.subarray(0, n)], [1], 'the driven car is never reported')
  n = carsWithin(poses, suv, 100, 50 + c.hx + 1, 0.3, out)
  assert.equal(n, 0, 'a metre clear of the bumper')
  n = carsWithin(poses, suv, 100, 50 + c.hx + 0.2, 0.3, out)
  assert.deepEqual([...out.subarray(0, n)], [0], 'the disc reaches the bumper of the car facing +z only')
  assert.equal(carsWithin(poses, suv, -500, -500, 0, out), 1)
  assert.equal(carsWithin(poses.subarray(0, POSE.stride), suv, -500, -500, 0, out), 0, 'a short pose buffer ends the scan before car 2')
  assert.equal(carsWithin(poses, suv, Number.NaN, 50, 0.3, out), 0)
  assert.equal(carsWithin(poses, suv, 100, 50, 0.3, new Int32Array(1)), 1, 'capped')
  assert.equal(carsWithin(poses, suv, 100, 50, 0.3, new Int32Array(0)), 0)
})

test('poleSlot: the pole index is the lamps, then the trees, then the signals, in the order ghost.ts\'s proxies and the furniture lists take', () => {
  const f = streetFurniture(1337)
  const total = f.lamps.length + f.trees.length + f.signals.length
  assert.equal(new PoleIndex(f).count, total)
  // Against the ghost view's proxies built from the same furniture: instance i of its poles mesh stands where the
  // slot's list entry does.
  const g = createGhost({ boxes: [], furniture: f, suv: [false], crowdPos: new StorageBufferAttribute(new Float32Array(16), 4), agents: 4 })
  const poles = g.scene.children[1] as InstancedMesh
  assert.equal(poles.count, total)
  const m = new Matrix4(), p = new Vector3()
  const heights = { lamps: POLES.lamp.height, trees: POLES.tree.height, signals: POLES.signal.height }
  for (let i = 0; i < total; i += 7) {
    const slot = poleSlot(i, f)
    assert.ok(slot, `pole ${i} has a slot`)
    const entry = f[slot.list][slot.index]
    poles.getMatrixAt(i, m)
    p.setFromMatrixPosition(m)
    assert.ok(near(p.x, entry[0], 1e-4) && near(p.z, entry[1], 1e-4), `pole ${i} is ${slot.list}[${slot.index}]`)
    assert.ok(near(p.y, heights[slot.list] / 2, 1e-4), `pole ${i} has a ${slot.list} height`)
  }
  assert.deepEqual(poleSlot(0, f), { list: 'lamps', index: 0 })
  assert.deepEqual(poleSlot(f.lamps.length, f), { list: 'trees', index: 0 })
  assert.deepEqual(poleSlot(f.lamps.length + f.trees.length, f), { list: 'signals', index: 0 })
  assert.deepEqual(poleSlot(total - 1, f), { list: 'signals', index: f.signals.length - 1 })
  assert.equal(poleSlot(total, f), null)
  assert.equal(poleSlot(-1, f), null)
  assert.equal(poleSlot(1.5, f), null)
  assert.equal(poleSlot(Number.NaN, f), null)
  // The index's own slot order: the PoleIndex reports the lamp at list position 0 as pole 0.
  const index = new PoleIndex(f)
  const out = new Int32Array(4)
  const n = index.within(f.lamps[0][0], f.lamps[0][1], 0.01, out)
  assert.ok(n >= 1 && out[0] === 0)
  const t = index.within(f.trees[3][0], f.trees[3][1], 0.01, out)
  assert.ok(t >= 1)
  assert.deepEqual(poleSlot(out[0], f), { list: 'trees', index: 3 })
})
