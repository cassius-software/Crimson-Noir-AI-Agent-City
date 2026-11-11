// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the sky floors of the Penthouse and the Sky-Mansion (properties.ts skyFloor) to
 * the plan they were built from: for seed 1337 the floors at 193.8 m and 228 m, each headquarters tower cut into 35
 * boxes in its own place in the city's order (the tower below, a band of 16 clear panes and 16 rail boxes between the
 * glass's inner face at 7.832 m and its outer face at 7.982 m, the trim slab, the tower above), covering the old box
 * but the room and the ledge, the crown on top untouched; for every seed the band inside the tower, the floor on a
 * whole storey at least 3 m under the roof and above 60 m, and no floor on a lot without a tower; none with the homes
 * off and none on a region's homes; the realm's solids keep every piece as built; the realm's sky frames (rooms 7 and
 * 8) at the floor's height, and checkHomeBoxes on them measuring from the floor, inside the 20 by 20 plan and off the
 * arrival while a hall's answers stay as they were; and the margins that keep a person up there out of a car's reach
 * and out of earshot of the sidewalk.
 * What breaks if it is removed? A seed could put a floor through a tower's roof, leave a pane outside its tower, shift
 * every box after a tower in the order (and with it the VTOL pads and the track network), or let the realm refuse
 * every piece of furniture upstairs, and only a browser on that seed would show it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CITY, STYLE, cityPlan, generateBuildings, generateCity, type Box, type Building } from './city.ts'
import { toWorld } from './interiors.ts'
import { SKY_FLOOR, checkHomeBoxes, cityHomes, homeFrames, homesAt, skyFrames, type Home, type HomeFrame } from './properties.ts'
import { CELL, GRID_HALF, HOME_PIECES, SKY, backEdge, skyRoom } from '../02_Define_The_Rules/homeGrid.ts'
import { solidBoxes } from '../07_Execute_Actions/physics.ts'
import { ENTER_RANGE, PERSON } from '../07_Execute_Actions/simProtocol.ts'
import { AUDIBLE_RADIUS } from '../03_Spawn_Agents/skills.ts'

const SEEDS = Array.from({ length: 32 }, (_, i) => (i === 0 ? 1337 : (i * 2654435761 + 12345) >>> 0))
const close = (a: number, b: number, what: string, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${what}: ${a} is not ${b}`)
const volume = ([x0, y0, z0, x1, y1, z1]: Box) => (x1 - x0) * (y1 - y0) * (z1 - z0)
const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, i) => x === b[i])
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a[3], b[3]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[4], b[4]) - Math.max(a[1], b[1])) * Math.max(0, Math.min(a[5], b[5]) - Math.max(a[2], b[2]))

/** The tower a home's sky floor was cut from, in the city with the homes off: the box its first and last pieces span. */
function towerOf(plain: readonly Building[], home: Home): { at: number; tower: Building } {
  const first = home.sky!.boxes[0].box, last = home.sky!.boxes[home.sky!.boxes.length - 1].box
  const at = plain.findIndex(({ box: b }) => b[0] === first[0] && b[1] === first[1] && b[2] === first[2] && b[3] === last[3] && b[4] === last[4] && b[5] === last[5])
  return { at, tower: plain[at] }
}

test('seed 1337: the Penthouse floor at 193.8 m and the Sky-Mansion floor at 228.0 m, each tower cut into 35 boxes in its place', () => {
  const plain = generateBuildings(1337, { homes: false })
  const { buildings, homes } = cityPlan(1337)
  assert.equal(buildings.length, 2762, '68 boxes more than the city before its sky floors (2694)')
  const want = [
    { home: 3, cx: 300, cz: 380, F: 193.8, P: 9.839, top: 203.712, at: 1926, crown: 216.563 },
    { home: 6, cx: 300, cz: 300, F: 228, P: 8.45, top: 236.406, at: 1858, crown: 246.404 },
  ]
  assert.deepEqual(homes.filter((h) => h.sky).map((h) => h.home), [3, 6], 'only the two tower homes')
  for (const w of want) {
    const h = homes[w.home], sky = h.sky!, at = `home ${w.home}`
    assert.deepEqual([h.cx, h.cz], [w.cx, w.cz])
    close(sky.y, w.F, `${at}: the floor`, 1e-9)
    close(sky.y / 3.8, Math.round(sky.y / 3.8), `${at}: on a whole storey`, 1e-9)
    assert.equal(sky.boxes.length, 35)
    // In its place: the tower's own index, every piece in a row.
    assert.equal(buildings.indexOf(sky.boxes[0]), w.at, `${at}: the pieces where the tower stood`)
    assert.deepEqual(buildings.slice(w.at, w.at + 35), sky.boxes)
    const { tower } = towerOf(plain, h)
    assert.ok(tower, `${at}: cut from a tower of the city`)
    assert.equal(buildings.some((b) => same(b.box, tower.box)), false, 'the tower itself is gone')
    const [x0, p, z0, x1, top, z1] = tower.box
    close(p, w.P, `${at}: the podium's top`, 1e-3)
    close(top, w.top, `${at}: the tower's top`, 1e-3)
    // The tower below, the slab, the tower above: the tower's own footprint, its finish below and above.
    const lower = sky.boxes[0], slab = sky.boxes[33], upper = sky.boxes[34]
    assert.deepEqual(lower, { box: [x0, p, z0, x1, sky.y, z1], style: tower.style })
    assert.deepEqual(slab.box, [x0, sky.y + SKY_FLOOR.height, z0, x1, sky.y + SKY_FLOOR.height + SKY_FLOOR.slab, z1])
    assert.equal(slab.style, STYLE.trim, 'the slab in trim: a cornice outside')
    assert.deepEqual(upper, { box: [x0, sky.y + SKY_FLOOR.height + SKY_FLOOR.slab, z0, x1, top, z1], style: tower.style })
    assert.ok(upper.box[4] - upper.box[1] >= SKY_FLOOR.above, `${at}: ${(upper.box[4] - upper.box[1]).toFixed(2)} m of tower over the slab`)
    // The band: 16 clear panes and 16 rail boxes, from the floor to the slab, between the glass's two faces.
    const band = sky.boxes.slice(1, 33)
    assert.equal(band.filter((b) => b.style === STYLE.clear).length, 16)
    assert.equal(band.filter((b) => b.style === STYLE.rail).length, 16)
    close(SKY_FLOOR.inner, 7.832, 'the inner face', 1e-9)
    close(SKY_FLOOR.inner + SKY_FLOOR.band, 7.982, 'the outer face', 1e-9)
    for (const { box: b, style } of band) {
      assert.ok(b[1] === sky.y && b[4] === sky.y + SKY_FLOOR.height, `${at}: floor to slab`)
      const u = [b[0] - h.cx, b[3] - h.cx], v = [b[2] - h.cz, b[5] - h.cz]
      // Each box lies in the ring between the two faces: on one axis across it exactly, on the other inside it.
      const across = (a: number[]) => (close(Math.abs(a[0] + a[1]) / 2, 7.907, `${at}: the ring's middle`, 1e-9), close(a[1] - a[0], 0.15, `${at}: the band's thickness`, 1e-9))
      if (Math.abs(u[1] - u[0] - 0.15) < 1e-9 && Math.abs(Math.abs(u[0] + u[1]) / 2 - 7.907) < 1e-9) assert.ok(v[0] >= -7.982 - 1e-9 && v[1] <= 7.982 + 1e-9)
      else { across(v); assert.ok(u[0] >= -7.982 - 1e-9 && u[1] <= 7.982 + 1e-9) }
      if (style === STYLE.clear) close(Math.max(u[1] - u[0], v[1] - v[0]), 3.8035, `${at}: a pane's width`, 1e-9)
    }
    // Together the pieces fill the old box but the room and the ledge round the band, and no two overlap.
    for (let i = 0; i < 35; i++) for (let j = i + 1; j < 35; j++) assert.ok(overlap(sky.boxes[i].box, sky.boxes[j].box) < 1e-9, `${at}: pieces ${i} and ${j} overlap`)
    const ring = (2 * 7.982) ** 2 - (2 * 7.832) ** 2
    const open = SKY_FLOOR.height * ((x1 - x0) * (z1 - z0) - ring)
    close(sky.boxes.reduce((n, b) => n + volume(b.box), 0), volume(tower.box) - open, `${at}: the pieces' volume`, 1e-3)
    for (const b of sky.boxes) assert.ok(b.box[0] >= x0 && b.box[3] <= x1 && b.box[2] >= z0 && b.box[5] <= z1 && b.box[1] >= p, `${at}: inside the tower's footprint`)
    // The crown on top, as it was.
    const crown = plain.find((b) => b.box[1] === top && Math.abs((b.box[0] + b.box[3]) / 2 - h.cx) < 1e-6 && Math.abs((b.box[2] + b.box[5]) / 2 - h.cz) < 1e-6)
    assert.ok(crown && buildings.some((b) => same(b.box, crown.box) && b.style === crown.style), `${at}: the crown still stands`)
    close(crown!.box[4], w.crown, `${at}: the crown's top`, 1e-3)
  }
})

test('every seed: the band fits inside the tower, the floor sits at least 3 m under the roof and above 60 m, and no fallback lot has a floor', () => {
  for (const seed of SEEDS) {
    const plain = generateBuildings(seed, { homes: false })
    const { homes } = cityPlan(seed)
    for (const h of homes) {
      const at = `seed ${seed} home ${h.home}`
      if (skyRoom(h.home) < 0) { assert.equal(h.sky, null, `${at}: only the two tower homes`); continue }
      // A floor only where a headquarters tower stands on the lot's own podium, centred on it.
      const tower = plain.find(({ box: [x0, y0, z0, x1, y1, z1] }) => y0 > 0 && y1 - y0 >= 70 && Math.abs((x0 + x1) / 2 - h.cx) < 1e-9 && Math.abs((z0 + z1) / 2 - h.cz) < 1e-9)
      if (!tower) { assert.equal(h.sky, null, `${at}: no tower, no floor`); continue }
      assert.ok(h.sky, `${at}: a tower, and its floor`)
      const sky = h.sky!, [x0, , z0, x1, top, z1] = tower.box
      assert.equal(towerOf(plain, h).tower, tower)
      assert.ok(sky.y > 60, `${at}: the floor at ${sky.y.toFixed(1)} m`)
      close(sky.y / 3.8, Math.round(sky.y / 3.8), `${at}: a whole storey`, 1e-9)
      assert.ok(top - (sky.y + SKY_FLOOR.height + SKY_FLOOR.slab) >= SKY_FLOOR.above - 1e-9, `${at}: ${(top - sky.y).toFixed(2)} m under the roof`)
      const outer = SKY_FLOOR.inner + SKY_FLOOR.band
      assert.ok(Math.min(h.cx - x0, x1 - h.cx, h.cz - z0, z1 - h.cz) >= outer, `${at}: the band inside the tower`)
      assert.equal(sky.boxes.length, 35)
    }
  }
})

test('no sky floor with homes off, and none on a region home', () => {
  for (const seed of SEEDS.slice(0, 8)) {
    assert.equal(generateBuildings(seed, { homes: false }).filter((b) => b.style === STYLE.clear).length, 0, `seed ${seed}`)
    assert.equal(generateBuildings(seed).filter((b) => b.style === STYLE.clear).length, cityHomes(seed).filter((h) => h.sky).length * 16, `seed ${seed}: 16 panes a floor`)
  }
  // A region's homes (homesAt, from its lots) have none, whatever their kind: a region's slabs carry no tower.
  const region = homesAt([0, 1, 2, 3, 4, 5, 6].map((home) => ({ home, k: 6, m: 6, side: 0 as const })))
  assert.ok(region.every((h) => h.sky === null))
  assert.deepEqual(skyFrames(region), [null, null])
  assert.deepEqual(skyFrames([]), [null, null])
})

test('solidBoxes keeps every sky piece as built', () => {
  for (const seed of [1337, 7]) {
    const boxes = generateCity(seed)
    const solid = solidBoxes(boxes)
    for (const h of cityHomes(seed).filter((x) => x.sky)) {
      for (const b of h.sky!.boxes) {
        const i = boxes.findIndex((x) => same(x, b.box))
        assert.ok(i >= 0, `seed ${seed} home ${h.home}: a piece in the city`)
        assert.deepEqual(solid[i], b.box, `seed ${seed} home ${h.home}: piece ${h.sky!.boxes.indexOf(b)} as built`)
      }
    }
  }
})

test('skyFrames: rooms 7 and 8 at the floor\'s height with the back at -7.78; [null, null] for a region; homeFrames as before', () => {
  const homes = cityHomes(1337)
  const frames = skyFrames(homes)
  assert.equal(frames.length, 2)
  for (const [i, f] of frames.entries()) {
    const h = homes[[3, 6][i]]
    assert.deepEqual(f, { home: 7 + i, cx: h.cx, cz: h.cz, side: h.side, back: backEdge(7 + i), y: h.sky!.y })
    close(f!.back, -7.78, 'the sky plan\'s back edge', 1e-9)
    assert.ok(Object.isFrozen(f))
  }
  // The halls' frames as they were: one per home, at the street's height (no y).
  const halls = homeFrames(homes)
  assert.equal(halls.length, 7)
  for (const [i, f] of halls.entries()) {
    assert.deepEqual(f, { home: i, cx: homes[i].cx, cz: homes[i].cz, side: homes[i].side, back: backEdge(i) })
    assert.equal('y' in f!, false)
  }
})

/** A room-frame box as a city box for frame `f`: u, v and y ranges. */
function box(f: HomeFrame, u0: number, v0: number, u1: number, v1: number, y0: number, y1: number): number[] {
  const a = toWorld(f, u0, v0), b = toWorld(f, u1, v1)
  return [Math.min(a.x, b.x), y0, Math.min(a.z, b.z), Math.max(a.x, b.x), y1, Math.max(a.z, b.z)]
}
const refusal = (f: HomeFrame, flat: number[]): string => {
  try { checkHomeBoxes(f, flat); return '' } catch (e) { return (e as Error).message }
}

test('checkHomeBoxes on a sky frame: heights from the floor, the 20 x 20 plan, off the arrival; every hall answer unchanged', () => {
  const homes = cityHomes(1337)
  const [sky] = skyFrames(homes), F = sky!.y!
  // The Sky-Mansion's hall: the whole grid deep, so its back corners are a hall's alone.
  const hall = homeFrames(homes)[6]!
  // Sound, upstairs: a sofa-sized box on the floor in the room; and the most boxes a room takes.
  assert.equal(checkHomeBoxes(sky!, box(sky!, 0, -1, 1.5, 1, F, F + 0.85)).length, 1)
  assert.equal(checkHomeBoxes(sky!, Array.from({ length: HOME_PIECES }, (_, i) => box(sky!, -7 + i * 0.4, -7, -6.8 + i * 0.4, -6, F, F + 1)).flat()).length, HOME_PIECES)
  // Heights from the floor: at the street's height, under the floor or into the ceiling, refused.
  assert.equal(refusal(sky!, box(sky!, 0, -1, 1.5, 1, 0, 0.85)), 'home: a box must start on the floor')
  assert.equal(refusal(sky!, box(sky!, 0, -1, 1.5, 1, F - 0.1, F + 0.85)), 'home: a box must start on the floor')
  assert.equal(refusal(sky!, box(sky!, 0, -1, 1.5, 1, F, F + 4.2)), 'home: a box must stay under 4.15 m')
  // The 20 x 20 plan: past any of its edges (a hall's plan reaches further), refused.
  const edge = -GRID_HALF + (SKY.r1 + 1) * CELL
  assert.equal(refusal(sky!, box(sky!, -8.5, -1, -7, 1, F, F + 1)), "home: a box must stand inside the home's floor plan", 'behind the far glass')
  assert.equal(refusal(sky!, box(sky!, 0, edge - 0.5, 1, edge + 0.5, F, F + 1)), "home: a box must stand inside the home's floor plan", 'past the side glass')
  assert.equal(refusal(sky!, box(sky!, 0, -edge - 0.5, 1, -edge + 0.5, F, F + 1)), "home: a box must stand inside the home's floor plan")
  assert.equal(refusal(sky!, box(sky!, 7.5, 3, 8.5, 4, F, F + 1)), "home: a box must stand inside the home's floor plan", 'out through the near glass')
  assert.equal(refusal(sky!, box(sky!, 0, -1, 1.5, 1, F, F + 0.85)), '')
  // Off the arrival, in its own words; up to its edge is fine.
  assert.equal(refusal(sky!, box(sky!, 5, -0.5, 6, 0.5, F, F + 1)), 'home: a box must keep off the arrival')
  assert.equal(refusal(sky!, box(sky!, 5, 2.4, 6, 3.4, F, F + 1)), '', 'beside it')
  assert.equal(refusal(sky!, box(sky!, 3.6, -0.5, 4.6, 0.5, F, F + 1)), '', 'in front of it')
  // A hall's answers as they were: its plan to the doorway wall, its apron, heights from the street.
  assert.equal(refusal(hall, box(hall, 10, -0.5, 11, 0.5, 0, 1)), 'home: a box must keep off the apron in front of the doorway')
  assert.equal(refusal(hall, box(hall, 12, 4, 13, 5, 0, 1)), "home: a box must stand inside the home's floor plan")
  assert.equal(refusal(hall, box(hall, 2, -1, 4, 1, -0.1, 1)), 'home: a box must start on the floor')
  assert.equal(refusal(hall, box(hall, 2, -1, 4, 1, 0, 4.2)), 'home: a box must stay under 4.15 m')
  assert.equal(refusal(hall, box(hall, 2, -1, 4, 1, 0, 0.85)), '')
  assert.equal(refusal(hall, box(hall, -11, 10, -10, 11, 0, 1)), '', 'a corner a sky floor does not have')
  assert.equal(refusal(hall, box(hall, 2, -1, 4, 1, F, F + 0.85)), 'home: a box must stay under 4.15 m', 'a hall\'s ceiling is its own')
})

test('the margins: a capsule on the sky floor is out of car reach and out of earshot of the sidewalk', () => {
  // The capsule's centre can come no nearer the lot's edge than the glass's inner face less its radius: past a car's
  // door reach of the kerb (the lot's edge and the 0.88 m to the parking lane's door) ...
  const nearest = SKY_FLOOR.inner - PERSON.radius
  close(nearest, 7.532, 'the nearest the centre comes to the lot\'s edge', 1e-9)
  assert.ok(SKY_FLOOR.inner - PERSON.radius + ENTER_RANGE < CITY.lotHalf + 0.88, 'no car door within reach')
  // ... and, from someone on the sidewalk just outside the lot, further than a call carries.
  assert.ok(CITY.lotHalf + PERSON.radius - nearest > AUDIBLE_RADIUS, 'out of earshot of the sidewalk')
})
