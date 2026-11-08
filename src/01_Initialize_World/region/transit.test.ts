// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? Lakefront Metro's transit (transit.ts) is laid over a street window that has dropped
 * streets, dead ends, water and a 554 m needle, and the physics worker lays it again from what the page sends. These
 * tests hold it to its promises on the real generated map (three seeds, the four land zones each): the elevated loop
 * rounds walkable streets with four stations and its columns stand clear of every lamp, tree, signal and the
 * carriageway; every train, drone, plane and VTOL piece clears every craft box as the city's INV-1 holds (same
 * envelopes); the racetrack stays inside the region and off The Spire; the network's craft audit clean on the realm's
 * clock and the core schedules them in a region; a zebra crossing on every walkable arm of every intersection; the
 * plazas as one rectangle per plaza lot, built on by nothing; the pier from the shore over the water, with the shore
 * wall opened for it and nowhere else new; the strip on open land clear of everything; and the page and the worker
 * calling the same function with the same arguments (a source pin).
 * What breaks if it is removed? A train could run into a tower, a column stand in a lane, the worker schedule craft the
 * page cannot draw (or the other way round), a pier end on land or a stripe lie on the lawn, and only a GPU would show it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { uniform } from 'three/tsl'
import { TRAFFIC } from '../../02_Define_The_Rules/civic.ts'
import { CRAFT, auditCraft } from '../../02_Define_The_Rules/ring0.ts'
import { TRACKS, guideway, poseAt } from '../../06_Make_Decisions/tracks.ts'
import { POSE, TRACK_POSE, type SimInit } from '../../07_Execute_Actions/simProtocol.ts'
import { TrackFleet } from '../../07_Execute_Actions/trackFleet.ts'
import { CITY, POLES, type Box } from '../city.ts'
import { FbmSet } from '../fbmTexture.ts'
import { ZONE, generateLakefront } from '../lakefront.ts'
import { packOf } from '../lakefrontPack.ts'
import { MACRO } from '../macroCity.ts'
import type { Pt, Rect } from './clip.ts'
import { polygonAt, polygonCount, roadAt, validatePack, type RegionPack } from './pack.ts'
import { SEG, hSeg, streetGridOf, vSeg, windowFurniture, type StreetGrid } from './streets.ts'
import { regionWorkplaceLots } from './workplaces.ts'
import {
  HIGH_BAND, MAX_CRAFT_BOXES, RACETRACK_REACH, TRANSIT, WALK_STREET_HALF, craftBoxesOf, crosswalks, droneCells, ferryBerth, ferryDock, needlesOf, padCells,
  regionTransit, stolStrip, trainRectangle, walkableRectangle, windowDroneCorridors, windowNetwork, windowPlaneCorridor, windowTrainLoop, windowVtolRoutes,
  type RegionTransit,
} from './transit.ts'

// Vite's `?raw` import, for Node: regionWorld.ts and the core take WGSL that way, so they are imported once the hook is in place.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { RegionPlaces, SHORE_WALL, SURFACE, hollowLots, layoutOf, regionMeshes, regionPhysics } = await import('./regionWorld.ts')
const { SimCore } = await import('../../07_Execute_Actions/simCore.ts')
const { createSimHost } = await import('../../07_Execute_Actions/simHost.ts')

const P = CITY.pitch
interface Window {
  seed: number; zone: string; pack: RegionPack; layout: ReturnType<typeof layoutOf>; start: { x: number; z: number }; g: StreetGrid
  boxes: Box[]; plan: Box[]; net: ReturnType<typeof windowNetwork>; transit: RegionTransit
}
const WINDOWS: Window[] = [1337, 7, 42].flatMap((seed) => {
  const map = generateLakefront(seed, 64)
  return Object.entries(ZONE).filter(([name]) => name !== 'lake').map(([zone, z]) => {
    const pack = packOf(map, z)
    const layout = layoutOf(pack)
    const start = new RegionPlaces(pack, layout).spawn({ x: layout.offset.x, z: layout.offset.z })
    const g = streetGridOf(pack, layout.offset, start)!
    const hollow = hollowLots(pack, layout, regionWorkplaceLots(pack, layout, g, start, seed))
    const transit = regionTransit(hollow.pack, layout, g)
    const plan = [...hollow.plan, ...transit.plan].map((b) => b.box)
    const boxes = craftBoxesOf(hollow.pack, layout.offset, g, plan)
    return { seed, zone, pack: hollow.pack, layout, start, g, boxes, plan, net: windowNetwork(seed, g, boxes, layout.bounds), transit }
  })
})
// The five zones of a seed share one map, and two of them (northRidge, grandRavine) the same window: fourteen distinct.
const name = (w: Window) => `seed ${w.seed} ${w.zone}`
const walk = (bits: number) => (bits & SEG.walk) !== 0
const kinds = (w: Window) => w.net.tracks.reduce<Record<string, number>>((n, t) => ({ ...n, [t.kind]: (n[t.kind] ?? 0) + 1 }), {})
/** Horizontal distance from (x, z) to a box, 0 inside its footprint. */
const boxDistance = (x: number, z: number, b: Box): number => Math.hypot(Math.max(b[0] - x, 0, x - b[3]), Math.max(b[2] - z, 0, z - b[5]))
const pointIn = (x: number, z: number, ring: readonly Pt[]): boolean => {
  let c = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j]
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c
  }
  return c
}
const waterRings = (w: Window): Pt[][] => {
  const out: Pt[][] = []
  for (let i = 0; i < polygonCount(w.pack.water); i++) for (const r of polygonAt(w.pack.water, i)) out.push(r.map(([x, z]) => [x + w.layout.offset.x, z + w.layout.offset.z] as Pt))
  return out
}
const inWater = (w: Window, x: number, z: number): boolean => { let c = false; for (const r of waterRings(w)) if (pointIn(x, z, r)) c = !c; return c }
const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0

test('the elevated loop: the city\'s corridor where the window has it, else the largest walkable rectangle; four mid-side stations on the 9 m deck', () => {
  for (const w of WINDOWS) {
    const r = trainRectangle(w.g)
    assert.ok(r, name(w))
    const [k0, m0, k1, m1] = r
    assert.ok(walkableRectangle(w.g, k0, m0, k1, m1), `${name(w)}: every side has a sidewalk`)
    assert.ok(k1 - k0 >= TRANSIT.loopMin && m1 - m0 >= TRANSIT.loopMin, `${name(w)}: ${k1 - k0} by ${m1 - m0} blocks`)
    // No walkable rectangle is larger (the search is exhaustive), and the city's corridor is taken whenever it is walkable.
    const B = w.g.blocks
    for (let a = 0; a <= B; a++) for (let b = 0; b <= B; b++) for (let c = a + TRANSIT.loopMin; c <= B; c++) for (let d = b + TRANSIT.loopMin; d <= B; d++) {
      if ((c - a) * (d - b) > (k1 - k0) * (m1 - m0)) assert.ok(!walkableRectangle(w.g, a, b, c, d), `${name(w)}: a larger walkable rectangle [${a},${b},${c},${d}]`)
    }
    const [lo, hi] = TRACKS.train.corridor
    if (walkableRectangle(w.g, lo, lo, hi, hi)) assert.deepEqual(r, [lo, lo, hi, hi], `${name(w)}: the city's own corridor`)
    const loop = windowTrainLoop(w.g)!
    assert.equal(loop.kind, 'train')
    assert.equal(loop.y, TRACKS.train.deck)
    assert.equal(loop.stations.length, 4)
    assert.equal(loop.pieces.filter((p) => p.kind === 'arc').length, 4, 'four corners')
    // Every station stands mid-block on a street line of the rectangle, on a segment with a sidewalk.
    for (const s of loop.stations) {
      const q = poseAt(loop, s)
      const onX = Math.abs(q.x / P - Math.round(q.x / P)) < 1e-6, onZ = Math.abs(q.z / P - Math.round(q.z / P)) < 1e-6
      assert.ok(onX !== onZ, `${name(w)}: a station on one street line, mid-block`)
      const k = Math.floor(q.x / P) - w.g.originX / P, m = Math.floor(q.z / P) - w.g.originZ / P
      const bits = onX ? vSeg(w.g, Math.round(q.x / P) - w.g.originX / P, m) : hSeg(w.g, k, Math.round(q.z / P) - w.g.originZ / P)
      assert.ok(walk(bits), `${name(w)}: the station's street has a sidewalk`)
    }
  }
  assert.deepEqual(trainRectangle({ ...WINDOWS[0].g, h: new Uint8Array(WINDOWS[0].g.h.length), v: new Uint8Array(WINDOWS[0].g.v.length) }), null, 'a window with no streets has no loop')
})

test('the guideway\'s columns stand at the window\'s own kerb, clear of every lamp, tree, signal pole, box and the two-lane carriageway', () => {
  for (const w of WINDOWS) {
    const loop = windowTrainLoop(w.g)!
    const { columns, beams } = guideway(loop, w.g.furniture)
    assert.ok(columns.length >= 2 * 4 * TRANSIT.loopMin && beams.length === columns.length / 2, `${name(w)}: ${columns.length} columns`)
    assert.ok(w.g.furniture - TRACKS.train.columnRadius >= w.g.roadHalf, 'a column at the window\'s furniture line clears its carriageway')
    const furniture = windowFurniture(w.g, w.seed)
    const poles: [number, number, number][] = [
      ...furniture.lamps.map(([x, z]): [number, number, number] => [x, z, POLES.lamp.radius]),
      ...furniture.trees.map(([x, z]): [number, number, number] => [x, z, POLES.tree.radius]),
      ...furniture.signals.map(([x, z]): [number, number, number] => [x, z, POLES.signal.radius]),
    ]
    for (const [x, z] of columns) {
      const off = Math.min(Math.abs(x - Math.round(x / P) * P), Math.abs(z - Math.round(z / P) * P))
      assert.ok(Math.abs(off - w.g.furniture) < 1e-6, `${name(w)}: column (${x}, ${z}) at the kerb`)
      for (const [px, pz, r] of poles) {
        const d = Math.hypot(px - x, pz - z)
        assert.ok(d >= TRACKS.train.columnRadius + r + 0.3, `${name(w)}: a column at (${x}, ${z}) is ${d.toFixed(2)} m from a pole at (${px}, ${pz})`)
      }
      assert.ok(!w.boxes.some((b) => boxDistance(x, z, b) < TRACKS.train.columnRadius), `${name(w)}: a column stands clear of every box`)
    }
  }
})

test('the drone corridors ride the window\'s walkable 4-block cells at 40 and 46 m; the racetrack flies at 400 m inside the region and clear of The Spire', () => {
  for (const w of WINDOWS) {
    const cells = droneCells(w.g)
    for (const [k0, m0, k1, m1] of cells) assert.ok(walkableRectangle(w.g, k0, m0, k1, m1) && k1 - k0 === TRACKS.drone.faceBlocks)
    const drones = windowDroneCorridors(w.g)
    assert.equal(drones.length, 2 * cells.length, name(w))
    assert.deepEqual([...new Set(drones.map((t) => t.y))].sort((a, b) => a - b), cells.length > 0 ? [...TRACKS.drone.altitude] : [])
    const plane = windowPlaneCorridor(w.g, w.boxes, w.layout.bounds)!
    assert.ok(plane && plane.kind === 'plane' && plane.y === TRACKS.plane.altitude, name(w))
    const needles = needlesOf(w.boxes)
    assert.ok(needles.length >= 1 && needles.some((b) => b[4] > 500), `${name(w)}: The Spire is a needle`)
    const b = w.layout.bounds
    for (let s = 0; s < plane.length; s += 2) {
      const q = poseAt(plane, s)
      assert.ok(q.x >= b.x0 - 1e-6 && q.x <= b.x1 + 1e-6 && q.z >= b.z0 - 1e-6 && q.z <= b.z1 + 1e-6, `${name(w)}: the racetrack stays inside the region at s ${s}`)
      for (const n of needles) assert.ok(boxDistance(q.x, q.z, n) >= TRACKS.plane.halfLength + TRANSIT.needleMargin - 1e-6, `${name(w)}: the racetrack clears a needle at s ${s}`)
    }
    // The region is wider than the racetrack both ways, so it is held, never shrunk.
    assert.ok(b.x1 - b.x0 >= 2 * RACETRACK_REACH.along && b.z1 - b.z0 >= 2 * RACETRACK_REACH.across)
  }
  // Without bounds the racetrack sits on the window's middle; a needle on it moves it by whole blocks.
  const w = WINDOWS[0]
  const free = windowPlaneCorridor(w.g, [])!
  const [cx, cz] = [w.g.originX + (w.g.blocks * P) / 2, w.g.originZ + (w.g.blocks * P) / 2]
  const xs = Array.from({ length: 50 }, (_, i) => poseAt(free, (i / 50) * free.length).x)
  assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - cx) < 1 && Math.abs(poseAt(free, 0).z - (cz - TRACKS.plane.fillet)) < 1e-6)
  const spire: Box = [cx - 10, 0, cz - TRACKS.plane.fillet - 10, cx + 10, 554, cz - TRACKS.plane.fillet + 10]
  const moved = windowPlaneCorridor(w.g, [spire])!
  assert.ok(moved, 'a middle a few blocks away clears it')
  for (let s = 0; s < moved.length; s += 1) assert.ok(boxDistance(poseAt(moved, s).x, poseAt(moved, s).z, spire) >= TRACKS.plane.halfLength + TRANSIT.needleMargin - 1e-6)
})

test('INV-1 for the window: every train, drone, plane and VTOL piece clears every craft box by the city\'s envelopes, and the VTOL routes land on roofs of their band', () => {
  const envelope = {
    train: { half: TRACKS.train.halfWidth, low: 0, high: TRACKS.train.height },
    drone: { half: TRACKS.drone.halfSize, low: -TRACKS.drone.halfSize, high: TRACKS.drone.halfSize },
    plane: { half: TRACKS.plane.halfLength, low: -TRACKS.plane.halfHeight, high: TRACKS.plane.halfHeight },
    vtol: { half: TRACKS.vtol.halfSize, low: -TRACKS.vtol.halfHeight - TRACKS.vtol.clearance, high: TRACKS.vtol.halfHeight },
  } as const
  let withVtol = 0
  for (const w of WINDOWS) {
    const cell = P
    const hash = new Map<string, Box[]>()
    for (const b of w.boxes) {
      for (let i = Math.floor(b[0] / cell); i <= Math.floor(b[3] / cell); i++) for (let j = Math.floor(b[2] / cell); j <= Math.floor(b[5] / cell); j++) {
        const k = `${i},${j}`
        const list = hash.get(k)
        if (list) list.push(b); else hash.set(k, [b])
      }
    }
    const sky = w.net.tracks.filter((t) => t.kind !== 'car')
    for (const t of sky) {
      const env = envelope[t.kind as keyof typeof envelope]
      assert.ok(t.y + env.low - TRACKS.car.height >= 6, `${name(w)}: ${t.kind} ${t.id} at ${t.y} m is not 6 m over a car`)
      const y0 = t.y + env.low, y1 = t.y + env.high
      for (let s = 0; s < t.length; s += 0.5) {
        const q = poseAt(t, s)
        const cx = Math.floor(q.x / cell), cz = Math.floor(q.z / cell)
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
          for (const b of hash.get(`${cx + i},${cz + j}`) ?? []) {
            if (b[4] <= y0 || b[1] >= y1) continue
            const d = boxDistance(q.x, q.z, b)
            assert.ok(d >= env.half, `${name(w)}: ${t.kind} ${t.id} at s ${s.toFixed(1)} (${q.x.toFixed(1)}, ${q.z.toFixed(1)}) is ${d.toFixed(2)} m from box ${b.map((v) => v.toFixed(1))}`)
          }
        }
      }
    }
    const vtols = sky.filter((t) => t.kind === 'vtol')
    if (vtols.length > 0) withVtol++
    for (const t of vtols) {
      assert.equal(t.stations.length, 4)
      const band = t.y >= HIGH_BAND.cruise[0] ? HIGH_BAND : TRACKS.vtol
      assert.ok((band.cruise as readonly number[]).includes(t.y), `${name(w)}: a VTOL cruise of its band`)
      for (const [i, s] of t.stations.entries()) {
        const q = poseAt(t, s), pad = t.pads[i]
        assert.ok(pad >= band.floor && pad <= band.ceiling, `${name(w)}: pad ${pad} m in the band ${band.floor}..${band.ceiling}`)
        assert.ok(w.boxes.some((b) => Math.abs(b[4] - pad) < 1e-6 && boxDistance(q.x, q.z, b) === 0), `${name(w)}: the pad is a roof among the craft boxes`)
      }
    }
    // Every pad of the high band is a roof over the city's ceiling: no roof is in both bands.
    assert.equal(HIGH_BAND.floor, TRACKS.vtol.ceiling)
    assert.ok(HIGH_BAND.ceiling + TRACKS.vtol.halfHeight + TRACKS.vtol.clearance <= HIGH_BAND.cruise[0], 'the tallest high pad stays under the lower high cruise')
    assert.ok(HIGH_BAND.cruise[1] < TRACKS.plane.altitude - TRACKS.plane.halfHeight && HIGH_BAND.cruise[0] > TRACKS.drone.altitude[1] + TRACKS.drone.halfSize)
  }
  // A generated map's houses are 10 m and its towers 60 m and more, so the city's band rarely serves; the high band
  // finds a loop round a hub's towers on twelve of the fifteen windows (seed 7's east bluffs and its north ridge, the
  // grand ravine's window too, have no tower in theirs).
  assert.ok(withVtol >= 11, `${withVtol} windows with a VTOL route`)
  assert.deepEqual(WINDOWS.filter((w) => !kinds(w).vtol).map(name), ['seed 7 eastBluffs', 'seed 7 northRidge', 'seed 7 grandRavine'])
  assert.deepEqual(windowVtolRoutes(WINDOWS[0].g, []), [], 'no boxes, no routes')
})

test('padCells: quarters at the medians when every quarter holds a pad, else strips across the longer axis, else null', () => {
  const pad = (x: number, z: number, y = 100) => ({ x, z, y })
  assert.equal(padCells([pad(10, 10), pad(50, 10), pad(50, 50)]), null, 'fewer than four')
  // A hub's square of towers: a quarter each.
  const q = padCells([pad(10, 10), pad(90, 10), pad(90, 90), pad(10, 90)])!
  assert.deepEqual(q, [[0, 2, 0, 2], [2, 3, 0, 2], [2, 3, 2, 3], [0, 2, 2, 3]])
  // A row of towers along x: four strips, in order along x.
  const row = padCells([pad(10, 10), pad(50, 12), pad(90, 10), pad(130, 12), pad(170, 10)])!
  assert.deepEqual(row, [[0, 1, 0, 1], [1, 2, 0, 1], [2, 3, 0, 1], [3, 5, 0, 1]])
  // Four towers in one block column: no cut leaves every cell a pad.
  assert.equal(padCells([pad(10, 10), pad(12, 11), pad(14, 12), pad(16, 13)]), null)
})

test('windowNetwork: the car rings first then the loop, the corridors, the racetrack and the VTOL routes, ids in order; the same inputs give the same network; its craft audit clean on the realm\'s clock', () => {
  for (const w of WINDOWS) {
    const ids = w.net.tracks.map((t) => t.id)
    assert.deepEqual(ids, ids.map((_, i) => i), name(w))
    const order = w.net.tracks.map((t) => t.kind)
    const firstSky = order.indexOf('train')
    assert.ok(firstSky > 0 && order.slice(0, firstSky).every((k) => k === 'car') && order.slice(firstSky).every((k) => k !== 'car'), `${name(w)}: the car rings first`)
    assert.equal(w.net.tracks.filter((t) => t.kind === 'train').length, 1)
    assert.equal(w.net.tracks.filter((t) => t.kind === 'plane').length, 1)
    assert.ok(w.net.tracks.filter((t) => t.kind === 'drone').length >= 6, `${name(w)}: ${kinds(w).drone} drone corridors`)
    assert.deepEqual(windowNetwork(w.seed, w.g, w.boxes, w.layout.bounds), w.net, `${name(w)}: deterministic`)
    const fleet = new TrackFleet(w.net)
    assert.ok(fleet.count > 0, `${name(w)}: ${fleet.count} craft`)
    for (const t of [0, 37.5, 600]) {
      const craft = fleet.writePoses(t, new Float32Array(fleet.count * TRACK_POSE.stride))
      assert.equal(auditCraft(craft), null, `${name(w)}: clean at ${t} s`)
      for (let i = 0; i < fleet.count; i++) assert.ok(craft[i * TRACK_POSE.stride + TRACK_POSE.y] >= CRAFT.floor[craft[i * TRACK_POSE.stride + TRACK_POSE.kind]])
    }
  }
})

test('craftBoxesOf: the standing rectangular buildings of the window and its ring, every needle, then the plan; under the worker\'s cap; the same every time', () => {
  for (const w of WINDOWS) {
    assert.ok(w.boxes.length > 100 && w.boxes.length <= MAX_CRAFT_BOXES, `${name(w)}: ${w.boxes.length} boxes`)
    for (const b of w.boxes) assert.ok(b[1] >= 0 && b[4] > b[1] && b[0] < b[3] && b[2] < b[5], `${name(w)}: a standing box with its low corner first`)
    for (const b of w.boxes.slice(0, w.boxes.length - w.plan.length)) assert.equal(b[1], 0, `${name(w)}: a building stands on the ground`)
    const B = w.g.blocks, k0 = w.g.originX / P, m0 = w.g.originZ / P
    const needle = TRACKS.plane.altitude - TRACKS.plane.halfHeight
    const planFrom = w.boxes.length - w.plan.length
    for (const [i, b] of w.boxes.entries()) {
      if (i >= planFrom) { assert.deepEqual(b, w.plan[i - planFrom]); continue }
      const kc = ((b[0] + b[3]) / 2) / P, mc = ((b[2] + b[5]) / 2) / P
      const onWindow = kc >= k0 - 1 && kc < k0 + B + 1 && mc >= m0 - 1 && mc < m0 + B + 1
      assert.ok(onWindow || b[4] > needle, `${name(w)}: a box off the window and its ring is a needle`)
    }
    assert.deepEqual(craftBoxesOf(w.pack, w.layout.offset, w.g, w.plan), w.boxes)
  }
})

test('crosswalks: one on every walkable arm of every node where two or more meet, in the city\'s band from the centre, six stripes across a car street and three across a pedestrian one, inside the carriageway', () => {
  const [near, far] = TRAFFIC.crosswalk
  for (const w of WINDOWS) {
    const B = w.g.blocks
    let expected = 0
    for (let m = 0; m <= B; m++) for (let k = 0; k <= B; k++) {
      const arms = [hSeg(w.g, k, m), hSeg(w.g, k - 1, m), vSeg(w.g, k, m), vSeg(w.g, k, m - 1)].filter(walk).length
      if (arms >= 2) expected += arms
    }
    const walks = crosswalks(w.g)
    assert.equal(walks.length, expected, name(w))
    assert.ok(expected > 500, `${name(w)}: ${expected} crossings`)
    for (const c of walks) {
      const car = c.half === w.g.roadHalf
      assert.ok(car || c.half === WALK_STREET_HALF)
      assert.equal(c.stripes.length, car ? 6 : 3)
      for (const s of c.stripes) {
        const along = c.dir[0] !== 0 ? [(s.x0 - c.x) * c.dir[0], (s.x1 - c.x) * c.dir[0]] : [(s.z0 - c.z) * c.dir[1], (s.z1 - c.z) * c.dir[1]]
        assert.ok(Math.min(...along) >= near - 1e-9 && Math.max(...along) <= far + 1e-9, 'in the band')
        const across = c.dir[0] !== 0 ? [s.z0 - c.z, s.z1 - c.z] : [s.x0 - c.x, s.x1 - c.x]
        assert.ok(Math.min(...across) >= -c.half + TRANSIT.crosswalk.inset - 1e-9 && Math.max(...across) <= c.half - TRANSIT.crosswalk.inset + 1e-9, 'inside the carriageway')
        assert.ok(Math.abs(across[1] - across[0] - TRANSIT.crosswalk.stripe) < 1e-9)
      }
    }
    assert.equal(w.transit.markings.length, walks.reduce((n, c) => n + c.stripes.length, 0) + (w.transit.strip?.markings.length ?? 0))
  }
  assert.ok(SURFACE.marking > SURFACE.roadJunction && SURFACE.marking - SURFACE.roadJunction > 0.0049, 'the paint lies over the junction asphalt')
})

test('plazas: one rectangle per plaza lot of the generated map, inside the lot, built on by nothing; the pack validates with them and without', () => {
  const side = P - 2 * MACRO.bandHalf
  for (const w of WINDOWS) {
    const plazas = w.pack.plazas!
    assert.ok(plazas && polygonCount(plazas) > 10, name(w))
    for (let i = 0; i < polygonCount(plazas); i++) {
      const rings = polygonAt(plazas, i)
      assert.equal(rings.length, 1)
      const xs = rings[0].map((p) => p[0]), zs = rings[0].map((p) => p[1])
      const r: Rect = { x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs) }
      assert.ok(Math.abs(r.x1 - r.x0 - side) < 1e-6 && Math.abs(r.z1 - r.z0 - side) < 1e-6, `${name(w)}: a lot's built square`)
      assert.ok(r.x0 >= w.pack.bounds.x0 && r.x1 <= w.pack.bounds.x1 && r.z0 >= w.pack.bounds.z0 && r.z1 <= w.pack.bounds.z1)
      for (let j = 0; j < polygonCount(w.pack.buildings); j++) {
        if (!(w.pack.buildings.height[j] > 0)) continue
        const o = polygonAt(w.pack.buildings, j)[0]
        const bx = o.map((p) => p[0]), bz = o.map((p) => p[1])
        assert.ok(!overlaps(r, { x0: Math.min(...bx), z0: Math.min(...bz), x1: Math.max(...bx), z1: Math.max(...bz) }), `${name(w)}: nothing is built on a plaza`)
      }
    }
    assert.equal(polygonCount(validatePack(JSON.parse(JSON.stringify(w.pack))).plazas!), polygonCount(plazas))
    const { plazas: _none, ...without } = w.pack
    assert.equal(validatePack(JSON.parse(JSON.stringify(without))).plazas, undefined, 'a surveyed pack has none')
    assert.throws(() => validatePack(JSON.parse(JSON.stringify({ ...w.pack, plazas: { ...plazas, xz: plazas.xz.slice(1) } }))), /plazas/)
  }
})

test('the ferry dock: a pier from the shore nearest the window, its deck from the quay out over the water, railed, the berth facing open water; the shore wall opened for it alone', () => {
  const { halfWidth, length, deck, rail, platform, berth } = TRANSIT.pier
  for (const w of WINDOWS) {
    const dock = ferryDock(w.pack, w.layout, w.g)
    assert.ok(dock, name(w))
    assert.deepEqual(ferryBerth(w.g, w.pack, w.layout), dock.berth)
    const { shore: e, normal: n, quay, root } = dock
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-9 && (n[0] === 0 || n[1] === 0), 'the pier runs along an axis')
    assert.deepEqual(root, [e[0] + n[0] * quay, e[1] + n[1] * quay])
    assert.ok(quay >= 0 && quay <= TRANSIT.pier.quayReach + 4 + 2.2, `${name(w)}: the quay ${quay} m out`)
    // The shore point is on the lake's edge (land a metre in, water a metre out), the deck and the platform over the water.
    assert.ok(!inWater(w, e[0] - n[0] * 1.5, e[1] - n[1] * 1.5) && inWater(w, e[0] + n[0] * 1.5, e[1] + n[1] * 1.5), `${name(w)}: the shore point parts land and water`)
    const end = quay + length + platform.length
    for (const a of [quay + 1, quay + length / 2, quay + length - 1, quay + length + 1, end - 1]) assert.ok(inWater(w, e[0] + n[0] * a, e[1] + n[1] * a), `${name(w)}: over the water ${a.toFixed(0)} m out`)
    assert.deepEqual([dock.berth.x, dock.berth.z], [e[0] + n[0] * end, e[1] + n[1] * end])
    assert.equal(dock.berth.length, berth)
    assert.ok(Math.abs(Math.sin(dock.berth.heading) - n[0]) < 1e-9 && Math.abs(Math.cos(dock.berth.heading) - n[1]) < 1e-9, 'the berth faces out over the water')
    // Nine boxes: the deck, the platform, two side rails, two platform rails, two steps between them, the end rail.
    assert.equal(dock.boxes.length, 9)
    const decks = dock.boxes.filter((b) => b.box[4] === deck), rails = dock.boxes.filter((b) => b.box[4] === deck + rail)
    assert.equal(decks.length, 2)
    assert.equal(rails.length, 7)
    const deckBox = decks[0].box
    assert.ok(Math.abs(Math.max(deckBox[3] - deckBox[0], deckBox[5] - deckBox[2]) - length) < 1e-6 && Math.abs(Math.min(deckBox[3] - deckBox[0], deckBox[5] - deckBox[2]) - 2 * halfWidth) < 1e-6)
    assert.ok(deck <= 0.3, 'a step the avatar takes')
    // The shore wall: a wall of SHORE_WALL height crosses the pier's line before the opening, none after; every other wall is as it was.
    const crossing = (walls: Float32Array): number => {
      let n = 0
      const a = dock.opening.a, b = dock.opening.b
      for (let i = 0; i < walls.length; i += 5) {
        if (Math.abs(walls[i + 4] - SHORE_WALL) > 1e-6) continue // a 32-bit 1.2 is not the double
        const p: Pt = [walls[i], walls[i + 1]], q: Pt = [walls[i + 2], walls[i + 3]]
        const o = (u: Pt, v: Pt, r: Pt) => Math.sign((v[0] - u[0]) * (r[1] - u[1]) - (v[1] - u[1]) * (r[0] - u[0]))
        if (o(a, b, p) !== o(a, b, q) && o(p, q, a) !== o(p, q, b)) n++
      }
      return n
    }
    const before = regionPhysics(w.pack, w.layout), after = regionPhysics(w.pack, w.layout, w.transit.openings)
    assert.ok(crossing(before.walls) >= 1, `${name(w)}: the shore wall stood across the pier`)
    assert.equal(crossing(after.walls), 0, `${name(w)}: the opening`)
    const others = (walls: Float32Array) => { const s = new Set<string>(); for (let i = 0; i < walls.length; i += 5) if (Math.abs(walls[i + 4] - SHORE_WALL) > 1e-6) s.add(Array.from(walls.subarray(i, i + 5)).join(',')); return s }
    assert.deepEqual(others(after.walls), others(before.walls), 'every other wall as it was')
    assert.ok(after.walls.length < before.walls.length + 5 * 4, 'the cut adds at most the pieces either side')
  }
  assert.equal(ferryDock({ ...WINDOWS[0].pack, water: { ...WINDOWS[0].pack.water, polyStart: [0], ringStart: [0], xz: [], kind: [], name: [] } }, WINDOWS[0].layout, WINDOWS[0].g), null, 'no lake, no pier')
})

test('the STOL strip: 300 by 24 m on open land nearest the window, inside the region, off the window, clear of every building, road ribbon, water polygon and plaza by its margin; its bars and centreline inside it', () => {
  const { length, width, margin, threshold } = TRANSIT.strip
  for (const w of WINDOWS) {
    const strip = stolStrip(w.pack, w.layout, w.g)
    assert.ok(strip, name(w))
    assert.deepEqual(w.transit.strip, strip)
    const r = strip.rect, kept: Rect = { x0: r.x0 - margin, z0: r.z0 - margin, x1: r.x1 + margin, z1: r.z1 + margin }
    assert.ok(Math.abs(Math.max(r.x1 - r.x0, r.z1 - r.z0) - length) < 1e-9 && Math.abs(Math.min(r.x1 - r.x0, r.z1 - r.z0) - width) < 1e-9)
    assert.ok(strip.heading === 0 || strip.heading === Math.PI / 2)
    const b = w.layout.bounds
    assert.ok(kept.x0 >= b.x0 && kept.x1 <= b.x1 && kept.z0 >= b.z0 && kept.z1 <= b.z1, `${name(w)}: inside the region`)
    const win: Rect = { x0: w.g.originX, z0: w.g.originZ, x1: w.g.originX + w.g.blocks * P, z1: w.g.originZ + w.g.blocks * P }
    assert.ok(!overlaps(kept, win), `${name(w)}: off the window`)
    const o = w.layout.offset
    for (let i = 0; i < polygonCount(w.pack.buildings); i++) {
      if (!(w.pack.buildings.height[i] > 0)) continue
      const ring = polygonAt(w.pack.buildings, i)[0]
      const xs = ring.map((p) => p[0] + o.x), zs = ring.map((p) => p[1] + o.z)
      assert.ok(!overlaps(kept, { x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs) }), `${name(w)}: clear of building ${i}`)
    }
    for (let i = 0; i < polygonCount(w.pack.water); i++) for (const ring of polygonAt(w.pack.water, i)) {
      const xs = ring.map((p) => p[0] + o.x), zs = ring.map((p) => p[1] + o.z)
      assert.ok(!overlaps(kept, { x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs) }), `${name(w)}: clear of the water`)
    }
    for (let i = 0; i < polygonCount(w.pack.plazas!); i++) {
      const ring = polygonAt(w.pack.plazas!, i)[0]
      const xs = ring.map((p) => p[0] + o.x), zs = ring.map((p) => p[1] + o.z)
      assert.ok(!overlaps(kept, { x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs) }), `${name(w)}: clear of a plaza`)
    }
    // Every road's centreline keeps its half-width and the margin from the strip (a conservative bound on the ribbon).
    for (let i = 0; i < w.pack.roads.cls.length; i++) {
      const pts = roadAt(w.pack, i)
      for (let k = 0; k + 1 < pts.length; k++) {
        const ax = pts[k][0] + o.x, az = pts[k][1] + o.z, bx = pts[k + 1][0] + o.x, bz = pts[k + 1][1] + o.z
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 2))
        for (let t = 0; t <= steps; t++) {
          const x = ax + ((bx - ax) * t) / steps, z = az + ((bz - az) * t) / steps
          assert.ok(!(x > r.x0 - 1 && x < r.x1 + 1 && z > r.z0 - 1 && z < r.z1 + 1), `${name(w)}: road ${i} crosses the strip at (${x.toFixed(0)}, ${z.toFixed(0)})`)
        }
      }
    }
    assert.equal(strip.markings.filter((m) => Math.abs(Math.min(m.x1 - m.x0, m.z1 - m.z0) - threshold.width) < 1e-9).length, 2 * 2 * threshold.offsets.length, 'the threshold bars at both ends')
    for (const m of strip.markings) assert.ok(m.x0 >= r.x0 && m.x1 <= r.x1 && m.z0 >= r.z0 && m.z1 <= r.z1, 'paint inside the paving')
    assert.ok(strip.markings.length > 2 * 2 * threshold.offsets.length, 'and a centreline')
    assert.deepEqual([strip.paving.half, Math.hypot(strip.paving.b[0] - strip.paving.a[0], strip.paving.b[1] - strip.paving.a[1])], [width / 2, length])
  }
})

test('the region draws every marking at SURFACE.marking in one mesh of one material, the strip as a road ribbon, the plazas as pavement; none of it without transit', () => {
  const w = WINDOWS[0]
  const fbm = new FbmSet(1, [64])
  const scene = regionMeshes(w.pack, w.layout, fbm, uniform(0), null, w.transit)
  const by = new Map(scene.meshes.map((m) => [m.name, m]))
  const marks = by.get('RegionMarkings')!
  assert.ok(marks, 'drawn')
  const pos = marks.geometry.getAttribute('position')
  assert.equal(pos.count, w.transit.markings.length * 4, 'four vertices a quad')
  for (let i = 0; i < pos.count; i++) assert.ok(Math.abs(pos.getY(i) - SURFACE.marking) < 1e-6, `every vertex at ${SURFACE.marking} m`)
  assert.equal(marks.geometry.getIndex()!.count, w.transit.markings.length * 6)
  assert.ok(scene.meshes.filter((m) => m.material === marks.material).length === 1, 'one material, the markings\' own')
  const has = (name: string, x: number, z: number): boolean => {
    const p = by.get(name)!.geometry.getAttribute('position')
    for (let i = 0; i < p.count; i++) if (Math.abs(p.getX(i) - x) < 1e-3 && Math.abs(p.getZ(i) - z) < 1e-3) return true
    return false
  }
  const r = w.transit.strip!.rect
  assert.ok(has('RegionRoads', r.x0, r.z0) && has('RegionRoads', r.x1, r.z1) && has('RegionRoads', r.x0, r.z1), 'the strip\'s corners are vertices of the asphalt')
  const plaza = polygonAt(w.pack.plazas!, 0)[0].map(([x, z]) => [x + w.layout.offset.x, z + w.layout.offset.z] as const)
  assert.ok(plaza.every(([x, z]) => has('RegionSidewalks', x, z)), 'a plaza\'s corners are vertices of the pavement')
  const bare = new Map(regionMeshes(w.pack, w.layout, fbm, uniform(0)).meshes.map((m) => [m.name, m]))
  assert.equal(bare.get('RegionMarkings'), undefined, 'a surveyed region paints nothing')
  assert.ok(bare.get('RegionRoads')!.geometry.getAttribute('position').count < by.get('RegionRoads')!.geometry.getAttribute('position').count, 'the strip is more asphalt')
})

test('regionTransit gathers the crossings, the dock and the strip: the markings, the plan (the pier\'s boxes) and the openings the page and the worker take', () => {
  for (const w of WINDOWS) {
    const t = w.transit
    assert.ok(t.dock && t.strip)
    assert.deepEqual(t.plan, t.dock.boxes)
    assert.deepEqual(t.openings, [t.dock.opening])
    assert.ok(t.markings.every((r) => r.x0 < r.x1 && r.z0 < r.z1))
    assert.deepEqual(regionTransit(w.pack, w.layout, w.g), t, 'deterministic')
  }
})

test('the core schedules a region\'s craft on the window\'s network from the boxes it was sent, audited clean; the worker refuses malformed craft boxes', async () => {
  const w = WINDOWS[0]
  const region = regionPhysics(w.pack, w.layout, w.transit.openings)
  const furniture = { lamps: [], trees: [], signals: [] }
  const core = await SimCore.create({ seed: w.seed, cars: 0, agents: 256, boxes: w.plan, furniture, spawn: w.start, debug: false, region, streets: w.g, tracks: true, craftBoxes: w.boxes }, null)
  const expected = new TrackFleet(w.net).count
  assert.equal(core.meta.craft, expected)
  assert.ok(expected > 50, `${expected} craft`)
  const craft = new Float32Array(expected * TRACK_POSE.stride)
  const input = { dt: 1 / 60, foot: { x: 0, z: 0, heading: 0 }, drive: { steer: 0, fwd: 0, back: 0, handbrake: false }, cmds: [] }
  let st = core.step(input, new Float32Array(core.meta.count * POSE.stride), craft)
  for (let i = 0; i < 20; i++) st = core.step(input, new Float32Array(core.meta.count * POSE.stride), craft)
  assert.equal(st.craft, craft)
  assert.equal(auditCraft(craft), null)
  assert.equal(core.halted, false)
  assert.deepEqual(Array.from(craft), Array.from(new TrackFleet(w.net).writePoses(st.simTime, new Float32Array(craft.length))), 'the page\'s network places every craft where the realm does')
  // Without craft boxes the window still has its loop, corridors and racetrack: only the VTOL routes need roofs.
  const bare = await SimCore.create({ seed: w.seed, cars: 0, agents: 256, boxes: [], furniture, spawn: w.start, debug: false, region, streets: w.g, tracks: true }, null)
  assert.equal(bare.meta.craft, new TrackFleet(windowNetwork(w.seed, w.g, [], w.layout.bounds)).count)
  assert.ok(bare.meta.craft > 0 && bare.meta.craft < expected)
  // A surveyed region (no window) schedules none, as before.
  const surveyed = await SimCore.create({ seed: w.seed, cars: 0, agents: 256, boxes: [], furniture, spawn: w.start, debug: false, region, tracks: true }, null)
  assert.equal(surveyed.meta.craft, 0)
  // The worker's door.
  const init = (craftBoxes: unknown, streets: StreetGrid | null = w.g): SimInit => ({ t: 'init', seed: w.seed, cars: 0, agents: 256, boxes: [], furniture, spawn: w.start, debug: false, region, streets, craftBoxes } as unknown as SimInit)
  const refused = async (boxes: unknown, why: RegExp, streets: StreetGrid | null = w.g) => {
    const posts: unknown[] = []
    const handle = createSimHost((m: unknown) => posts.push(m), async (o) => SimCore.create(o, null))
    await handle(init(boxes, streets))
    assert.match(JSON.stringify(posts.at(-1)), why)
  }
  await refused([[1, 2, 3]], /a craft box is six finite numbers/)
  await refused([[0, 0, 0, 1, Number.NaN, 1]], /a craft box is six finite numbers/)
  await refused([[5, 0, 0, 1, 10, 1]], /a craft box has its low corner first/)
  await refused(7, /craft boxes are a list of at most 4096/)
  await refused(Array.from({ length: MAX_CRAFT_BOXES + 1 }, () => [0, 0, 0, 1, 1, 1]), /at most 4096/)
  await refused([[0, 0, 0, 1, 1, 1]], /craft boxes need a region's street window/, null)
  const posts: unknown[] = []
  const handle = createSimHost((m: unknown) => posts.push(m), async (o) => SimCore.create(o, null))
  await handle(init(w.boxes.slice(0, 50)))
  assert.equal((posts.at(-1) as { t: string }).t, 'ready')
})

test('the page and the worker build the same network from the same arguments, and the page sends what the worker needs (a source pin)', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
  const engine = src('../../07_Execute_Actions/engine.ts'), core = src('../../07_Execute_Actions/simCore.ts'), host = src('../../07_Execute_Actions/simHost.ts')
  assert.match(core, /windowNetwork\(o\.seed, streets, o\.craftBoxes \?\? \[\], r \?\? null\)/)
  assert.match(engine, /windowNetwork\(options\.seed, streets, craftBoxes, layout\.bounds\)/)
  assert.match(engine, /craftBoxesOf\(hollow\.pack, layout\.offset, streets, world\.boxes\)/)
  assert.match(engine, /\.\.\.\(craftBoxes && craftBoxes\.length > 0 && \{ craftBoxes \}\)/)
  assert.match(engine, /regionPhysics\(hollow\.pack, layout, transit\?\.openings \?\? \[\]\)/)
  assert.match(engine, /plan = hollow \? \[\.\.\.hollow\.plan, \.\.\.\(transit\?\.plan \?\? \[\]\)\] : \[\]/)
  assert.match(engine, /new CraftView\(network, sim\.meta\.craft, world\.night, world\.matrixMode\.globalState, streets \? streets\.furniture : undefined\)/)
  assert.match(core, /this\.#craft = network && \(streets \|\| !r\) && o\.craft !== false \? new TrackFleet\(network\) : null/)
  assert.match(host, /craftBoxesOf\(init\.craftBoxes, region \? streets : null\)/)
  const world = src('../world.ts')
  assert.match(world, /regionMeshes\(region\.pack, region\.layout, fbm, night, matrixMode\.globalState, region\.transit \?\? null\)/)
  const smoke = src('../../../tools/browser/smoke.mjs')
  assert.match(smoke, /c\.kinds\.train === 1 && c\.kinds\.drone > 0 && c\.kinds\.plane === 1/)
  assert.match(smoke, /m\.name === 'RegionMarkings'/)
})
