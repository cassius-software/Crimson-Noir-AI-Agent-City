// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the realm's packed street furniture (physics.ts furnitureColliders: one compound
 * sensor per FURNITURE_TILE square) to the world it replaced, one sensor cylinder per lamp, tree and signal pole, built
 * here the old way as the reference:
 * - a query that includes sensors finds the same poles at the same distances (to Rapier's own ray-cast tolerance)
 *   along thousands of seeded rays, and finds every pole just inside its rim and its top and nothing just outside them;
 * - every pole is in exactly one compound, every compound is a sensor on the fixed body, and the solid world (ground
 *   and buildings) answers every solid query exactly as before;
 * - the city's world holds a hundred tiles in place of 4,599 colliders.
 * It also holds a home's slot of furniture (setHome, enableHome): new boxes are built off, a box sent again keeps its
 * very collider as it was (a piece that stayed put stays solid through an edit), the others go, and an empty set takes
 * the slot's body away.
 * What breaks if it is removed? The packing could drop, move or resize a pole, or make one solid, and nothing would say.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CITY, POLES, generateCity, streetFurniture, type Box, type Furniture } from '../01_Initialize_World/city.ts'
import { createRng } from '../02_Define_The_Rules/degrees.ts'
import { FURNITURE_TILE, GROUND_COLLIDERS, Physics, RAPIER } from './physics.ts'

const SEED = 11
const NONE: Furniture = { lamps: [], trees: [], signals: [] }

/** The furniture as physics.ts built it before the packing: one sensor cylinder per pole, verbatim. */
function referencePoles(world: RAPIER.World, furniture: Furniture): void {
  const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  const pole = (x: number, z: number, h: number, r: number) =>
    world.createCollider(RAPIER.ColliderDesc.cylinder(h / 2, r).setTranslation(x, h / 2, z).setSensor(true), fixed)
  for (const [x, z] of furniture.lamps) pole(x, z, POLES.lamp.height, POLES.lamp.radius)
  for (const [x, z] of furniture.trees) pole(x, z, POLES.tree.height, POLES.tree.radius)
  for (const [x, z] of furniture.signals) pole(x, z, POLES.signal.height, POLES.signal.radius)
  world.step()
}

/** Both worlds over the city's boxes: the packed one as Physics builds it, the reference with the poles one by one. */
async function worlds(): Promise<{ packed: Physics; reference: Physics; furniture: Furniture }> {
  const boxes = generateCity(SEED), furniture = streetFurniture(SEED)
  const packed = await Physics.create(boxes, furniture)
  const reference = Physics.build(boxes, NONE)
  referencePoles(reference.world, furniture)
  return { packed, reference, furniture }
}

const onlySensors = (c: RAPIER.Collider) => c.isSensor()
const SENSORS_ONLY = RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC

/** The distance to the first sensor along a ray, or null: what a query that wants the furniture would see. */
function sensorToi(world: RAPIER.World, ray: RAPIER.Ray, maxToi: number): number | null {
  const hit = world.castRay(ray, maxToi, true, SENSORS_ONLY, undefined, undefined, undefined, onlySensors)
  return hit ? hit.timeOfImpact : null
}

/** How many sensors contain a point. */
function sensorsAt(world: RAPIER.World, x: number, y: number, z: number): number {
  let n = 0
  world.intersectionsWithPoint({ x, y, z }, () => { n++; return true }, SENSORS_ONLY, undefined, undefined, undefined, onlySensors)
  return n
}

/**
 * How close a ray comes to the rim of the pole nearest a point on it, m: the smaller of its closest approach to that
 * pole's axis less the radius, and the point's height from the pole's base or top. Rapier casts a ray at a cylinder by
 * an iterative support-map search that stops within a fraction of a millimetre, and where it stops depends on the frame
 * the cylinder is described in (the world's origin before, its tile's centre now): a hit moves by up to about
 * three-quarters of a millimetre, and where a ray only grazes the surface (a tangent, the corner at the base) by a few millimetres or to a
 * miss.
 */
function rimDistance(poles: readonly (readonly [number, number, number, number])[], ray: RAPIER.Ray, t: number): number {
  const hx = ray.origin.x + ray.dir.x * t, hy = ray.origin.y + ray.dir.y * t, hz = ray.origin.z + ray.dir.z * t
  let best = 0, bd = Infinity
  for (let k = 0; k < poles.length; k++) {
    const d = (poles[k][0] - hx) ** 2 + (poles[k][1] - hz) ** 2
    if (d < bd) { bd = d; best = k }
  }
  const [px, pz, h, r] = poles[best]
  const l = Math.hypot(ray.dir.x, ray.dir.z)
  const axis = l > 0 ? Math.abs(((px - ray.origin.x) * ray.dir.z - (pz - ray.origin.z) * ray.dir.x) / l) : Math.hypot(px - hx, pz - hz)
  return Math.min(Math.abs(axis - r), Math.abs(hy), Math.abs(hy - h))
}

test('the packed furniture finds the same poles at the same distances as one sensor per pole, along 4,000 seeded rays', async () => {
  const { packed, reference, furniture } = await worlds()
  const sized = [
    ...furniture.lamps.map(([x, z]) => [x, z, POLES.lamp.height, POLES.lamp.radius] as const),
    ...furniture.trees.map(([x, z]) => [x, z, POLES.tree.height, POLES.tree.radius] as const),
    ...furniture.signals.map(([x, z]) => [x, z, POLES.signal.height, POLES.signal.radius] as const),
  ]
  const rng = createRng(0xf0e1)
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })
  let hits = 0, flips = 0, worst = 0
  for (let i = 0; i < 4000; i++) {
    // Origins over the city and its outer streets, at the heights a pole spans and a little above; mostly level rays
    // (a bonnet's, a ping's), some steep (a look down from a tower).
    ray.origin.x = -60 + rng() * (CITY.blocks * CITY.pitch + 120)
    ray.origin.y = rng() * 8
    ray.origin.z = -60 + rng() * (CITY.blocks * CITY.pitch + 120)
    let yaw = rng() * 2 * Math.PI
    let pitch = (rng() < 0.8 ? 0.15 : 1.2) * (rng() * 2 - 1)
    if (i % 2 === 0) {
      // Every other ray is aimed within 0.3 m of a pole's axis from up to 30 m away, below the shortest pole's top:
      // centre hits, grazes and near misses all come.
      const [px, pz] = sized[Math.floor(rng() * sized.length)]
      const back = 2 + rng() * 28, aim = rng() * 2 * Math.PI
      ray.origin.x = px - Math.cos(aim) * back
      ray.origin.y = rng() * 3
      ray.origin.z = pz - Math.sin(aim) * back
      yaw = aim + (rng() * 2 - 1) * (0.3 / back)
      pitch = (rng() * 2 - 1) * (0.1 / back)
    }
    ray.dir.x = Math.cos(yaw) * Math.cos(pitch)
    ray.dir.y = Math.sin(pitch)
    ray.dir.z = Math.sin(yaw) * Math.cos(pitch)
    const a = sensorToi(packed.world, ray, 60), b = sensorToi(reference.world, ray, 60)
    if (a === null && b === null) continue
    // Where it touched: within 6 mm of the rim is a graze.
    const graze = rimDistance(sized, ray, (a ?? b) as number) < 0.006
    if (a === null || b === null) {
      assert.ok(graze, `ray ${i}: packed ${a}, reference ${b}: a hit and a miss away from any rim`)
      flips++
      continue
    }
    hits++
    const d = Math.abs(a - b)
    assert.ok(d < (graze ? 5e-3 : 1e-3), `ray ${i}: packed ${a}, reference ${b}${graze ? ' (a graze)' : ''}`)
    worst = Math.max(worst, graze ? 0 : d)
  }
  assert.ok(hits > 1000, `the rays met poles (${hits} of 4000)`)
  assert.ok(flips <= 4, `${flips} grazes hit in one world and missed in the other`)
  if (process.env.FURNITURE_WORST) console.log(`hits ${hits}, flips ${flips}, worst away from a rim ${worst} m`)
})

test('every pole is found a centimetre inside its rim on all four sides and under its top, and not a centimetre outside them, in the packed world as in the reference', async () => {
  const { packed, reference, furniture } = await worlds()
  const kinds = [[furniture.lamps, POLES.lamp], [furniture.trees, POLES.tree], [furniture.signals, POLES.signal]] as const
  const EDGE = 0.01
  let poles = 0, alone = 0
  for (const [list, size] of kinds) {
    const { height: h, radius: r } = size
    for (const [x, z] of list) {
      poles++
      const at = `the pole at (${x}, ${z})`
      // Inside: a centimetre in from the rim east, west, north and south at mid-height, under the top, over the base.
      const inside: [number, number, number][] = [
        [x + r - EDGE, h / 2, z], [x - r + EDGE, h / 2, z], [x, h / 2, z + r - EDGE], [x, h / 2, z - r + EDGE],
        [x, h - EDGE, z], [x, EDGE, z],
      ]
      for (const [px, py, pz] of inside) assert.ok(sensorsAt(packed.world, px, py, pz) >= 1, `${at}: (${px}, ${py}, ${pz}) is inside it`)
      // Outside: a centimetre out past the rim on the same four sides, and over the top. Another pole may stand there,
      // so each answer is the reference's.
      const outside: [number, number, number][] = [
        [x + r + EDGE, h / 2, z], [x - r - EDGE, h / 2, z], [x, h / 2, z + r + EDGE], [x, h / 2, z - r - EDGE], [x, h + EDGE, z],
      ]
      let clear = true
      for (const [px, py, pz] of outside) {
        const p = sensorsAt(packed.world, px, py, pz) > 0, ref = sensorsAt(reference.world, px, py, pz) > 0
        assert.equal(p, ref, `${at}: (${px}, ${py}, ${pz}) just outside it`)
        if (ref) clear = false
      }
      if (clear) alone++
    }
  }
  assert.equal(poles, furniture.lamps.length + furniture.trees.length + furniture.signals.length)
  assert.ok(alone > poles * 0.9, `most poles stand alone (${alone} of ${poles})`)
})

test('every pole is in one compound sensor on the fixed body, one per tile, and the city has a hundred tiles in place of 4,599 colliders', async () => {
  const { packed, furniture } = await worlds()
  const tiles = new Set<string>()
  for (const [x, z] of [...furniture.lamps, ...furniture.trees, ...furniture.signals]) tiles.add(`${Math.floor(x / FURNITURE_TILE)},${Math.floor(z / FURNITURE_TILE)}`)
  let compounds = 0, parts = 0
  packed.world.colliders.forEach((c) => {
    if (c.shape.type !== RAPIER.ShapeType.Compound) return
    compounds++
    assert.ok(c.isSensor(), 'a furniture compound is a sensor')
    assert.ok(c.parent()?.isFixed(), 'on the fixed body')
    const shape = c.shape as RAPIER.Compound
    for (const s of shape.shapes) assert.equal(s.type, RAPIER.ShapeType.Cylinder)
    parts += shape.shapes.length
  })
  const total = furniture.lamps.length + furniture.trees.length + furniture.signals.length
  assert.equal(total, 4599, 'the city of seed 11 has 2,211 lamps, 1,232 trees and 1,156 signals')
  assert.equal(parts, total, 'every pole is one cylinder of one compound')
  assert.equal(compounds, tiles.size, 'one compound per tile that has a pole')
  assert.equal(compounds, 100, 'the city and its outer streets make 10 × 10 tiles')
  assert.equal(packed.world.colliders.len(), GROUND_COLLIDERS + generateCity(SEED).length + tiles.size)
})

test('the solid world answers every solid query exactly as it did with one sensor per pole', async () => {
  const { packed, reference } = await worlds()
  const rng = createRng(0x501d)
  for (let i = 0; i < 2000; i++) {
    const ox = -60 + rng() * (CITY.blocks * CITY.pitch + 120), oy = 0.3 + rng() * 30, oz = -60 + rng() * (CITY.blocks * CITY.pitch + 120)
    const yaw = rng() * 2 * Math.PI, pitch = -rng() * 1.5
    const dx = Math.cos(yaw) * Math.cos(pitch), dy = Math.sin(pitch), dz = Math.sin(yaw) * Math.cos(pitch)
    // castRay(…, true): ground, buildings, seawall; no vehicle, person or furniture.
    assert.equal(packed.castRay(ox, oy, oz, dx, dy, dz, 200, undefined, true), reference.castRay(ox, oy, oz, dx, dy, dz, 200, undefined, true), `ray ${i}`)
  }
})

test("a home's slot: new boxes are built off, a box sent again keeps its very collider (on stays on), the rest go, and an empty set takes the body away", async () => {
  const p = await Physics.create([], NONE)
  const colliders = p.world.colliders.len(), bodies = p.world.bodies.len()
  const before = new Set<number>()
  p.world.colliders.forEach((c) => before.add(c.handle))
  /** The slots' colliders: handle, centre x and whether on, by centre x. */
  const slots = () => {
    const out: { handle: number; x: number; on: boolean }[] = []
    p.world.colliders.forEach((c) => { if (!before.has(c.handle)) out.push({ handle: c.handle, x: c.translation().x, on: c.isEnabled() }) })
    return out.sort((a, b) => a.x - b.x || a.handle - b.handle)
  }
  const a: Box = [1, 0, 1, 2, 1, 2], b: Box = [3, 0, 3, 4, 1, 4], c: Box = [5, 0, 5, 6, 1, 6]
  assert.deepEqual(p.setHome(0, [a, b]), [a, b], 'both new: both off')
  assert.deepEqual(slots().map((s) => [s.x, s.on]), [[1.5, false], [3.5, false]])
  assert.equal(p.world.bodies.len(), bodies + 1, 'one fixed body for the slot')
  p.enableHome(0, true)
  const kept = slots()[1]
  assert.ok(kept.on)
  // b again with c: b's own collider, still on; a's gone; c built off. Only c is reported off.
  assert.deepEqual(p.setHome(0, [c, b]), [c])
  assert.deepEqual(slots(), [{ ...kept }, { handle: slots()[1].handle, x: 5.5, on: false }])
  assert.equal(p.world.bodies.len(), bodies + 1, 'the same body')
  // b twice: one keeps b's collider, the other is new and off; c goes.
  assert.deepEqual(p.setHome(0, [b, b]), [b])
  assert.deepEqual(slots().map((s) => [s.x, s.on]), [[3.5, true], [3.5, false]])
  assert.ok(slots().some((s) => s.handle === kept.handle && s.on))
  // All off, then the same set: kept as it is, both reported off.
  p.enableHome(0, false)
  assert.deepEqual(p.setHome(0, [b, b]), [b, b])
  assert.ok(slots().some((s) => s.handle === kept.handle && !s.on))
  // Another slot is its own; malformed boxes are no collider.
  assert.deepEqual(p.setHome(1, [a, [9, 0, 9, 9, 1, 10], [Number.NaN, 0, 0, 1, 1, 1]]), [a])
  assert.equal(p.world.bodies.len(), bodies + 2)
  assert.equal(p.world.colliders.len(), colliders + 3)
  // Empty: the slot's body and every collider on it go at once; the other slot stays.
  assert.deepEqual(p.setHome(0, []), [])
  assert.deepEqual(slots().map((s) => [s.x, s.on]), [[1.5, false]])
  assert.equal(p.world.bodies.len(), bodies + 1)
  p.enableHome(0, true)
  assert.deepEqual(p.setHome(1, [[9, 0, 9, 9, 1, 10]]), [], 'nothing sound: nothing left')
  assert.deepEqual({ colliders: p.world.colliders.len(), bodies: p.world.bodies.len() }, { colliders, bodies })
})
