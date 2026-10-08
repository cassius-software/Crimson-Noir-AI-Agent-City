// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves a surveyed region in real Rapier, built the way the worker builds it
 * (physics.ts regionColliders from regionWorld.ts regionPhysics):
 * - the avatar stands on the region's 100 m ground tiles at its skin, far from the origin, and never sinks;
 * - a building's walls stop it, at any angle, from outside, and a courtyard's walls from inside;
 * - the lake's shoreline stops it, the region's edge stops it, and a street between buildings does not;
 * - the core audits a region against a slab that holds it, not the city's;
 * - the worker's door refuses a malformed region.
 * What breaks if it is removed? The avatar could walk through surveyed buildings, into the lake or off the map.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { layoutOf, regionPhysics } from '../01_Initialize_World/region/regionWorld.ts'
import { REGION_FORMAT, polygons, pushPolygon, type RegionPack } from '../01_Initialize_World/region/pack.ts'
import type { Pt } from '../01_Initialize_World/region/clip.ts'
import { Physics } from './physics.ts'
import { Avatar } from './player.ts'
import { SimCore } from './simCore.ts'
import { createSimHost } from './simHost.ts'

const H = 1 / 60

/** A small region: a 20 m square tower, a rotated block with a courtyard, a lake along the south, 400 × 300 m. */
function pack(): RegionPack {
  const buildings = { ...polygons(), height: [] as number[], kind: [] as number[] }
  const square = (cx: number, cz: number): Pt[] => [[cx - 10, cz - 10], [cx + 10, cz - 10], [cx + 10, cz + 10], [cx - 10, cz + 10]]
  pushPolygon(buildings, [square(0, 0)]); buildings.height.push(600); buildings.kind.push(0)
  const rot = (x: number, z: number): Pt => [100 + x * Math.cos(0.6) - z * Math.sin(0.6), 20 + x * Math.sin(0.6) + z * Math.cos(0.6)]
  const outer = [rot(-15, -15), rot(15, -15), rot(15, 15), rot(-15, 15)]
  const court = [rot(-6, -6), rot(-6, 6), rot(6, 6), rot(6, -6)]
  pushPolygon(buildings, [outer, court]); buildings.height.push(150); buildings.kind.push(0)
  const water = { ...polygons(), kind: [] as number[], name: [] as number[] }
  pushPolygon(water, [[[-150, 80], [150, 80], [150, 150], [-150, 150]]]); water.kind.push(0); water.name.push(0)
  return {
    format: REGION_FORMAT, name: 'Testmere', grid: { lon0: 0, lat0: 0, k0: 1 }, bounds: { x0: -200, z0: -150, x1: 200, z1: 150 },
    attribution: ['test'], names: [''], roads: { cls: [], lanes: [], flow: [], name: [], start: [0], xz: [] }, water, buildings,
  }
}

const p = pack()
const L = layoutOf(p)
const at = (x: number, z: number) => ({ x: x + L.offset.x, z: z + L.offset.z })

async function world(focus = at(0, 0)) {
  const physics = await Physics.create([], { lamps: [], trees: [], signals: [] }, regionPhysics(p, L))
  physics.streamAt(focus.x, focus.z)
  return physics
}

/** Walks an avatar from (x, z) in the pack's frame with velocity (vx, vz) for `seconds`; returns where it ends (pack frame). */
async function walk(x: number, z: number, vx: number, vz: number, seconds: number) {
  const physics = await world()
  const s = at(x, z)
  const a = new Avatar(physics, s.x, s.z)
  let feetMax = -Infinity, feetMin = Infinity
  for (let i = 0; i < seconds * 60; i++) {
    physics.step(H, (h) => a.move(vx, vz, h))
    const feet = a.body.translation().y - a.person.halfHeight - a.person.radius
    if (i > 20) { feetMax = Math.max(feetMax, feet); feetMin = Math.min(feetMin, feet) }
  }
  return { x: a.x - L.offset.x, z: a.z - L.offset.z, feetMin, feetMax, physics }
}

test('layout: the region sits clear of the procedural grid, its bounds shifted with it', () => {
  assert.deepEqual(L.bounds, { x0: 2000, z0: 2000, x1: 2400, z1: 2300 })
  const phys = regionPhysics(p, L)
  // Walls: 4 of the tower, 4 + 4 of the block and its courtyard, the lake's north, west and east shores (its south
  // side lies along the region's edge, which is no shore), and the region's four edges.
  assert.equal(phys.walls.length / 5, 4 + 8 + 3 + 4)
})

test('real Rapier: standing and walking on the region ground far from the origin, the feet stay at the skin', async () => {
  const r = await walk(-150, -100, 2, 0, 4)
  assert.ok(r.x > -143, `walked east: x ${r.x.toFixed(2)}`)
  assert.ok(r.feetMin > 0.012 && r.feetMax < 0.04, `feet ${r.feetMin.toFixed(3)}..${r.feetMax.toFixed(3)} m`)
  const c = r.physics.region!
  assert.ok(c.ground >= 6 && c.wallTiles >= 1 && c.walls === 19 && c.builtTiles === c.wallTiles && c.builtWalls >= 19, JSON.stringify(c))
})

test('real Rapier: the tower\'s wall stops the avatar at its face; the rotated block\'s walls and courtyard too', async () => {
  const west = await walk(-30, 0, 2, 0, 12)
  assert.ok(west.x > -10.5 && west.x < -10.2, `stopped at the west face (x = −10): ${west.x.toFixed(3)}`)
  // Into the rotated block along +x at z = 20: its surface there is at some x < 100; the avatar must stop outside.
  const block = await walk(60, 20, 2, 0, 20)
  const insideBlock = (x: number, z: number) => {
    const dx = x - 100, dz = z - 20
    const u = dx * Math.cos(0.6) + dz * Math.sin(0.6), v = -dx * Math.sin(0.6) + dz * Math.cos(0.6)
    return Math.max(Math.abs(u), Math.abs(v)) < 15
  }
  assert.ok(!insideBlock(block.x, block.z), `never entered the block: (${block.x.toFixed(2)}, ${block.z.toFixed(2)})`)
  assert.ok(block.x > 75, `reached the block: x ${block.x.toFixed(2)}`)
  // From inside the courtyard it cannot walk out through the walls.
  const court = await walk(100, 20, 1.5, 0.4, 12)
  const dx = court.x - 100, dz = court.z - 20
  const u = dx * Math.cos(0.6) + dz * Math.sin(0.6), v = -dx * Math.sin(0.6) + dz * Math.cos(0.6)
  assert.ok(Math.max(Math.abs(u), Math.abs(v)) < 6, `still in the courtyard: (${u.toFixed(2)}, ${v.toFixed(2)})`)
})

test('real Rapier: the lake\'s shore and the region\'s edge stop the avatar; open ground between does not', async () => {
  const shore = await walk(-100, 40, 0, 2, 30)
  assert.ok(shore.z < 80 && shore.z > 79.3, `stopped at the shoreline (z = 80): ${shore.z.toFixed(3)}`)
  const north = await walk(-100, -120, 0, -2, 30)
  assert.ok(north.z > -150 && north.z < -149.3, `stopped at the region's edge (z = −150): ${north.z.toFixed(3)}`)
  const street = await walk(-100, 0, 2, 0, 20)
  assert.ok(Math.abs(street.x - -60) < 1, `open ground, 40 m in 20 s: ${street.x.toFixed(2)}`)
})

test('streaming: only the wall tiles around the player exist; walking to a far wall builds its tile before it is reached', async () => {
  // Two walls 3 km apart across a long region, each a north–south wall 20 m long at z 1000..1020.
  const walls = new Float32Array([1100, 1000, 1100, 1020, 10, 4100, 1000, 4100, 1020, 10])
  const physics = await Physics.create([], { lamps: [], trees: [], signals: [] }, { bounds: { x0: 1000, z0: 900, x1: 4200, z1: 1100 }, walls })
  physics.streamAt(1050, 1010)
  assert.deepEqual([physics.region!.wallTiles, physics.region!.builtTiles, physics.region!.builtWalls], [2, 1, 1], 'the far wall is not built')
  // Teleported near the far wall, the next step's stream builds it; walking into it then stops the avatar.
  const a = new Avatar(physics, 4080, 1010)
  let x = 0
  for (let i = 0; i < 20 * 60; i++) {
    physics.streamAt(a.x, a.z)
    physics.step(H, (h) => a.move(2, 0, h))
    x = a.x
  }
  assert.equal(physics.region!.builtTiles, 2)
  assert.ok(x < 4100 && x > 4099.5, `stopped at the far wall: x ${x.toFixed(3)}`)
})

test('the core audits a region against its own slab, and the worker refuses a malformed region', async () => {
  const phys = regionPhysics(p, L)
  const s = at(-150, -100)
  const core = await SimCore.create({ seed: 1, cars: 0, agents: 256, boxes: [], furniture: { lamps: [], trees: [], signals: [] }, spawn: s, debug: false, region: phys }, null)
  const idle = { steer: 0, fwd: 0, back: 0, handbrake: false }
  let st = core.step({ dt: H, foot: { x: 0, z: 0, heading: 0 }, drive: idle, cmds: [] }, new Float32Array(0))
  for (let i = 0; i < 30; i++) st = core.step({ dt: H, foot: { x: 0, z: 0, heading: 0 }, drive: idle, cmds: [] }, new Float32Array(0))
  assert.ok(Math.abs(st.avatar.x - s.x) < 0.1 && Math.abs(st.avatar.z - s.z) < 0.1, 'the avatar stands where the region put it')
  assert.equal(core.halted, false)
  const posts: unknown[] = []
  const handle = createSimHost((m: unknown) => posts.push(m), async (o) => SimCore.create(o, null))
  await handle({ t: 'init', seed: 1, cars: 0, agents: 256, boxes: [], furniture: { lamps: [], trees: [], signals: [] }, spawn: s, debug: false, region: { bounds: { x0: 5, z0: 0, x1: 1, z1: 9 }, walls: [] } })
  assert.match(JSON.stringify(posts.at(-1)), /a region needs finite bounds and walls in fives/)
})
