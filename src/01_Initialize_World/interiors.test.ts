// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The indoor workplaces are read by four things that must agree: the city's boxes (what
 * Rapier and the renderer take), the flow field (what a summoned person routes by), the crowd shader's uniform and
 * containment (what the workday walks), and the spatial audit (what counts as "inside a lot"). These tests hold the
 * geometry to its promises: six rooms on inner downtown lots from the seed alone; a doorway the flow field routes
 * through to every station and back out; a containment that lets nobody through a wall or a piece of furniture over
 * five thousand steps of five hundred jostled walkers commuting in and out; the uniform laid out as the shader reads
 * it; and the workday's dice at the share they promise.
 * What breaks if it is removed? A layout could put a desk across a route, a wall could open, the uniform could shift
 * under the shader, and only Julian's screen would show it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CITY, HERITAGE_COLUMNS, STYLE, districtOfLot, generateBuildings, type Box } from './city.ts'
import { createRng } from '../02_Define_The_Rules/degrees.ts'
import { cellAt, cellCentre, cityGrid, flowAt, nearestOpen, solveFlow, trace, UNREACHED } from '../06_Make_Decisions/flowField.ts'
import { EXIT_SIDE, exitPoint } from '../07_Execute_Actions/carRig.ts'
import { APPROACH_SECONDS, INTERVIEW_DISTANCE, OperatorTrail, RELEASE_DISTANCE, TETHER_PACE, TRAIL } from '../03_Spawn_Agents/skills.ts'
import { PERSON } from '../07_Execute_Actions/simProtocol.ts'
import { Physics } from '../07_Execute_Actions/physics.ts'
import { Avatar } from '../07_Execute_Actions/player.ts'
import {
  ROOM, ROOM_FLOATS, ROOMS_FLOATS, WORK, WORKPLACE_KINDS, workOneIn, containInRoom, crossesGlass, doorDir, doorFront, drawRooms, glassPanes, hitsBox, insideRoom, onDuty,
  packRooms, penetrates, routeIn, targetCorner, toLocal, toWorld, workerSlot, workplaceLots, workplaces, workplacesAt, type Workplace,
} from './interiors.ts'

const SEEDS = [1337, 7, 42, 2026]
const h = CITY.lotHalf

test('six rooms, one per kind, on six different inner downtown lots, from the seed alone', () => {
  for (const seed of SEEDS) {
    const lots = workplaceLots(seed)
    assert.deepEqual(lots.map((l) => l.kind), [...WORKPLACE_KINDS])
    assert.deepEqual(workplaceLots(seed), lots)
    assert.equal(new Set(lots.map((l) => `${l.k},${l.m}`)).size, 6, 'six different lots')
    for (const { k, m, side } of lots) {
      assert.equal(districtOfLot(k, m), 'downtown')
      assert.ok(k >= HERITAGE_COLUMNS && k < CITY.blocks && m >= 0 && m < CITY.blocks - 2, `${seed}: lot ${k},${m} is an inner downtown lot`)
      assert.ok([0, 1, 2, 3].includes(side))
    }
  }
  assert.notDeepEqual(workplaceLots(1337), workplaceLots(7), 'another seed, other lots')
})

test('the rooms are made from their lots alone: the seed picks the lots, workplacesAt builds the same six from them', () => {
  for (let seed = 0; seed <= 20; seed++) assert.deepEqual(workplacesAt(workplaceLots(seed)), workplaces(seed), `seed ${seed}`)
  // Lots handed in from elsewhere (a region's, region/workplaces.ts) give rooms on those lots, in that order, and fewer
  // than six lots give fewer rooms.
  const lots = [{ kind: 'clinic', k: 61, m: 57, side: 2 }, { kind: 'boardroom', k: 58, m: 60, side: 0 }] as const
  const rooms = workplacesAt(lots, () => 9)
  assert.deepEqual(rooms.map((r) => [r.kind, r.k, r.m, r.side, r.cx, r.cz]), [['clinic', 61, 57, 2, 61.5 * CITY.pitch, 57.5 * CITY.pitch], ['boardroom', 58, 60, 0, 58.5 * CITY.pitch, 60.5 * CITY.pitch]])
  assert.ok(rooms.every((r) => r.shell[5].box[4] === 9), 'the ceiling slab rises to the podium it was given')
})

test('the route in starts on the lane it is given: a region\'s 4.9 m lane puts the door front at u = 15.1, as the shader compiled for it does', () => {
  for (const room of workplaces(1337)) {
    for (let s = 0; s < ROOM.stations; s++) {
      assert.ok(Math.abs(toLocal(room, routeIn(room, s)[0].x, routeIn(room, s)[0].z).u - (CITY.pitch / 2 - CITY.lane)) < 1e-9, 'the city\'s own lane by default')
      const legs = routeIn(room, s, 4.9)
      const front = toLocal(room, legs[0].x, legs[0].z)
      assert.ok(Math.abs(front.u - 15.1) < 1e-9 && Math.abs(front.v) < 1e-9, `${room.kind} station ${s}: the door front at u ${front.u}`)
      assert.deepEqual(legs.slice(1), routeIn(room, s).slice(1), 'indoors the legs are the room\'s own')
    }
  }
})

test('the minimap draws each room near the view: the lot in the accent colour, its floor inside the walls, the doorway open on its street front', () => {
  type Fill = { style: string; x: number; z: number; w: number; h: number }
  const canvas = () => {
    const fills: Fill[] = []
    return { fills, ctx: { fillStyle: '', fillRect(x: number, z: number, w: number, h: number) { fills.push({ style: String(this.fillStyle), x, z, w, h }) } } }
  }
  const rooms = workplaces(42)
  const near = rooms[0]
  for (const dark of [false, true]) {
    const { fills, ctx } = canvas()
    drawRooms(ctx, rooms, near.cx + 20, near.cz - 30, dark)
    const drawn = rooms.filter((r) => Math.abs(r.cx - near.cx - 20) <= 150 && Math.abs(r.cz - near.cz + 30) <= 150)
    assert.ok(drawn.includes(near) && drawn.length < rooms.length, 'the test needs a room in view and one beyond it')
    assert.equal(fills.length, drawn.length * 3, 'three fills per room in view, none for a room beyond it')
    drawn.forEach((r, i) => {
      const [lot, floor, door] = fills.slice(3 * i, 3 * i + 3)
      assert.deepEqual([lot.x, lot.z, lot.w, lot.h], [r.cx - h, r.cz - h, 2 * h, 2 * h], `${r.kind}: the whole lot`)
      assert.ok(floor.x > lot.x && floor.x + floor.w < lot.x + lot.w && floor.z > lot.z && floor.z + floor.h < lot.z + lot.h && floor.style !== lot.style, `${r.kind}: the floor inside the walls`)
      assert.equal(door.style, floor.style, 'the doorway is cut in the floor\'s colour')
      const d = doorDir(r.side), mid = { x: door.x + door.w / 2, z: door.z + door.h / 2 }
      const l = toLocal(r, mid.x, mid.z)
      assert.ok(l.u > h - 2 && l.u < h && Math.abs(l.v) < 1e-9, `${r.kind}: the gap is on the doorway's wall`)
      assert.equal(d.x !== 0 ? door.h : door.w, ROOM.door * 2, `${r.kind}: as wide as the doorway`)
    })
    // A wider radius takes in the rest.
    const all = canvas()
    drawRooms(all.ctx, rooms, near.cx, near.cz, dark, 1e4)
    assert.equal(all.fills.length, rooms.length * 3)
  }
})

test('the room frame: u runs to the doorway, v across it, and the four sides are the four street fronts', () => {
  for (const side of [0, 1, 2, 3] as const) {
    const room = { cx: 100, cz: 200, side }
    const d = doorDir(side)
    const door = toWorld(room, h, 0)
    assert.deepEqual(door, { x: 100 + d.x * h, z: 200 + d.z * h }, `side ${side}: the doorway is on the lot's edge that way`)
    const p = toWorld(room, 3, -5)
    const back = toLocal(room, p.x, p.z)
    assert.ok(Math.abs(back.u - 3) < 1e-9 && Math.abs(back.v + 5) < 1e-9, 'toLocal inverts toWorld')
    const q = toWorld(room, 0, 1), r = toWorld(room, 1, 0)
    assert.ok(Math.abs((q.x - 100) * (r.x - 100) + (q.z - 200) * (r.z - 200)) < 1e-9, 'u and v are perpendicular')
  }
})

test('every layout: eight stations, at most the furniture the uniform holds, every station standing clear, every route leg straight and clear', () => {
  for (const seed of SEEDS) {
    for (const room of workplaces(seed)) {
      assert.equal(room.stations.length, ROOM.stations, room.kind)
      assert.ok(room.furniture.length > 0 && room.furniture.length <= ROOM.furniture, room.kind)
      for (const { box } of [...room.furniture, ...room.shell]) {
        assert.ok(box[0] >= room.cx - h && box[3] <= room.cx + h && box[2] >= room.cz - h && box[5] <= room.cz + h, `${room.kind}: ${box} inside its lot`)
        assert.ok(box[3] > box[0] && box[5] > box[2] && box[4] > box[1])
      }
      for (let s = 0; s < room.stations.length; s++) {
        const st = room.stations[s]
        assert.ok(!penetrates(room, st.x, st.z, ROOM.pad + 0.1), `${room.kind} station ${s} stands clear of the furniture`)
        assert.ok(insideRoom(room, st.x, st.z))
        const legs = routeIn(room, s)
        assert.equal(legs.length, 4)
        for (let l = 1; l + 1 < legs.length; l++) {
          const a = legs[l], b = legs[l + 1]
          const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.05)
          for (let i = 0; i <= n; i++) {
            const x = a.x + ((b.x - a.x) * i) / n, z = a.z + ((b.z - a.z) * i) / n
            assert.ok(!penetrates(room, x, z, ROOM.pad + 0.1), `${room.kind} station ${s} leg ${l} is clear at (${x.toFixed(2)}, ${z.toFixed(2)})`)
          }
        }
        // The first leg is the doorway: from the lane outside straight in along u at v = 0.
        const front = toLocal(room, legs[0].x, legs[0].z), hub = toLocal(room, legs[1].x, legs[1].z)
        assert.ok(Math.abs(front.v) < 1e-9 && Math.abs(hub.v) < 1e-9 && front.u > h && hub.u < h - ROOM.wall)
      }
    }
  }
})

test('the city is hollowed: each workplace lot has its glass walls, the doorway open, the ceiling slab and its furniture; nothing else moves', () => {
  for (const seed of SEEDS) {
    const list = generateBuildings(seed)
    const rooms = workplaces(seed)
    for (const room of rooms) {
      const mine = list.filter(({ box }) => Math.abs((box[0] + box[3]) / 2 - room.cx) < h && Math.abs((box[2] + box[5]) / 2 - room.cz) < h)
      // The shell's walls and the furniture exactly; the ceiling slab's top is the lot's own podium height (workplaces() was not told it).
      for (const b of [...room.shell.slice(0, 5), ...room.furniture]) assert.ok(mine.some((x) => x.style === b.style && x.box.every((v, i) => v === b.box[i])), `${room.kind}: ${b.box} is in the city`)
      const slab = mine.find(({ box }) => box[1] === ROOM.height && box[0] === room.cx - h && box[3] === room.cx + h && box[2] === room.cz - h && box[5] === room.cz + h)
      assert.ok(slab && slab.box[4] >= ROOM.height + 0.3 && slab.style === STYLE.mixed, `${room.kind}: the ceiling slab carries the podium`)
      assert.ok(!mine.some(({ box }) => box[1] === 0 && box[0] <= room.cx - h && box[3] >= room.cx + h && box[2] <= room.cz - h && box[5] >= room.cz + h), `${room.kind}: no solid podium is left`)
      // The doorway: no box at head height crosses the opening (a 4 m by 4.2 m gap in the wall on the door side).
      const door = room.door
      const inner = toWorld(room, h - ROOM.wall / 2, 0)
      for (const t of [-0.45, 0, 0.45]) {
        const a = doorDir(room.side)
        const px = inner.x + t * ROOM.door * 2 * a.z, pz = inner.z - t * ROOM.door * 2 * a.x
        assert.ok(!mine.some(({ box }) => box[1] < 1.8 && box[4] > 0.3 && px > box[0] && px < box[3] && pz > box[2] && pz < box[5]), `${room.kind}: the doorway at ${door.x},${door.z} is open`)
      }
    }
    // Every other box of the seed's city is the one generateBuildings gave before hollowing: the same count outside the six lots.
    const outside = list.filter(({ box }) => !rooms.some((r) => Math.abs((box[0] + box[3]) / 2 - r.cx) < h && Math.abs((box[2] + box[5]) / 2 - r.cz) < h))
    assert.ok(outside.length > 2000)
  }
})

test('the flow field routes through the doorway to every station, and back out of the room', () => {
  const seed = 1337
  const boxes: Box[] = generateBuildings(seed).map((b) => b.box)
  const grid = cityGrid(boxes)
  for (const room of workplaces(seed)) {
    const front = doorFront(room)
    const start = nearestOpen(grid, front.x, front.z)
    assert.ok(start >= 0)
    for (const st of room.stations) {
      const goal = nearestOpen(grid, st.x, st.z, 1)
      assert.ok(goal >= 0, `${room.kind}: the station's cell is open`)
      const { cost, dir } = solveFlow(grid, [goal])
      assert.ok(cost[start] < UNREACHED, `${room.kind}: the sidewalk reaches the station`)
      const path = trace(grid, dir, front.x, front.z)
      const end = path.at(-1)!
      assert.ok(Math.hypot(end.x - st.x, end.z - st.z) < 2 * grid.cell, `${room.kind}: the trace ends at the station`)
      // The trace crosses the wall band only in the doorway.
      for (const p of path) {
        const { u, v } = toLocal(room, p.x, p.z)
        const m = Math.max(Math.abs(u), Math.abs(v))
        if (m > h - ROOM.wall && m < h) assert.ok(u > 0 && Math.abs(v) < ROOM.door, `${room.kind}: the trace is in the doorway at (${p.x}, ${p.z})`)
      }
    }
    // And out: from the back of the room to the sidewalk, the first direction at the hub leads to the door.
    const out = solveFlow(grid, [start])
    const hub = toWorld(room, ROOM.hub, 0)
    assert.ok(out.cost[cellAt(grid, hub.x, hub.z)] < UNREACHED)
    const d = flowAt(grid, out.dir, hub.x, hub.z)
    const dd = doorDir(room.side)
    assert.ok(d.x * dd.x + d.z * dd.z > 0.5, `${room.kind}: at the hub the way out is through the doorway`)
  }
})

test('an operator against a room\'s glass is given the flow goal on their own side of it, outside or in', () => {
  for (const seed of SEEDS) {
    const grid = cityGrid(generateBuildings(seed).map((b) => b.box))
    for (const room of workplaces(seed)) {
      // Standing on the sidewalk against each of the four faces (away from the doorway), the goal is outside.
      for (const [nu, nv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (const off of [-8, -5, 5, 8]) {
          for (const gap of [PERSON.radius + 0.05, 0.5, 0.65]) {
            const at = toWorld(room, nu * (h + gap) + Math.abs(nv) * off, nv * (h + gap) + Math.abs(nu) * off)
            const c = cellCentre(grid, nearestOpen(grid, at.x, at.z))
            const l = toLocal(room, c.x, c.z)
            assert.ok(Math.max(Math.abs(l.u), Math.abs(l.v)) > h, `${room.kind} seed ${seed}: the goal for (${at.x}, ${at.z}) is behind the glass`)
          }
        }
      }
      // Inside, against the doorway's wall either side of the opening, it is indoors.
      for (const off of [-6, 6]) {
        const at = toWorld(room, h - ROOM.wall - ROOM.pad, off)
        const c = cellCentre(grid, nearestOpen(grid, at.x, at.z))
        assert.ok(insideRoom(room, c.x, c.z), `${room.kind} seed ${seed}: the goal for an operator inside is inside`)
      }
    }
  }
})

/** The crowd's step, mirrored (crowd.wgsl simulate's last lines): a step towards `to` with a jostle, then the containment and the slide. */
function walk(room: Workplace, me: { x: number; z: number }, to: { x: number; z: number }, jostle: { x: number; z: number }, dt: number, mayEnter: boolean): { x: number; z: number } {
  const dx = to.x - me.x, dz = to.z - me.z
  const dist = Math.hypot(dx, dz)
  const pace = 1.3
  const vx = (dist > 1e-6 ? (dx / dist) * pace : 0) + jostle.x, vz = (dist > 1e-6 ? (dz / dist) * pace : 0) + jostle.z
  const next = { x: me.x + vx * dt, z: me.z + vz * dt }
  const held = mayEnter || insideRoom(room, me.x, me.z) ? containInRoom(room, me, next) : containOut(room, me, next)
  return held
}
/** A passer-by's containment: the doorway is shut to them (crowd.wgsl contain with mayEnter false, outside). */
function containOut(room: Workplace, from: { x: number; z: number }, to: { x: number; z: number }): { x: number; z: number } {
  const { u, v } = toLocal(room, to.x, to.z)
  const limOut = h + ROOM.pad
  if (Math.max(Math.abs(u), Math.abs(v)) >= limOut) return to
  // Outside the lot's pad on the shorter axis, as pushOut does.
  const uu = limOut - Math.abs(u) < limOut - Math.abs(v) ? (u >= 0 ? limOut : -limOut) : u
  const vv = uu === u ? (v >= 0 ? limOut : -limOut) : v
  void from
  return toWorld(room, uu, vv)
}

test('5,000 steps of 500 jostled walkers commuting in through the doorway to their stations and back out: zero penetrations, everyone arrives', () => {
  const rooms = workplaces(1337)
  const rng = createRng(99)
  const N = 500, STEPS = 5000, dt = 0.05
  const walkers = Array.from({ length: N }, (_, i) => {
    const room = rooms[i % rooms.length]
    const s = Math.floor(i / rooms.length) % ROOM.stations
    const legs = routeIn(room, s)
    const route = [...legs, ...[...legs].reverse().slice(1)]
    const front = legs[0]
    // Start on the sidewalk lane up to 6 m either side of the door front.
    const along = (rng() - 0.5) * 12
    const a = doorDir(room.side)
    const me = { x: front.x + along * a.z, z: front.z - along * a.x }
    return { room, s, route, leg: 0, me, from: me, arrived: false, out: false, dwell: 0 }
  })
  let penetrations = 0, moves = 0, maxCorrection = 0
  for (let step = 0; step < STEPS; step++) {
    for (const w of walkers) {
      if (w.out) continue
      const target = w.route[Math.min(w.leg, w.route.length - 1)]
      const jostle = { x: (rng() - 0.5) * 1.2, z: (rng() - 0.5) * 1.2 }
      const mayEnter = w.leg >= 1 || w.leg === w.route.length - 1
      const next = walk(w.room, w.me, target, jostle, dt, mayEnter)
      const wanted = { x: w.me.x + ((target.x - w.me.x) / Math.max(1e-6, Math.hypot(target.x - w.me.x, target.z - w.me.z))) * 1.3 * dt + jostle.x * dt, z: w.me.z + ((target.z - w.me.z) / Math.max(1e-6, Math.hypot(target.x - w.me.x, target.z - w.me.z))) * 1.3 * dt + jostle.z * dt }
      maxCorrection = Math.max(maxCorrection, Math.hypot(next.x - wanted.x, next.z - wanted.z))
      if (penetrates(w.room, next.x, next.z)) penetrations++
      w.me = next
      moves++
      if (Math.hypot(target.x - w.me.x, target.z - w.me.z) < 0.6) {
        if (w.leg === 3) {
          // At the station: work a while (the jostle keeps on), then leave.
          w.arrived = true
          if (++w.dwell < 40) continue
        }
        w.leg++
        if (w.leg >= w.route.length) w.out = true
      }
    }
  }
  assert.equal(penetrations, 0, `${penetrations} of ${moves} steps ended in a wall or a piece of furniture`)
  assert.ok(walkers.every((w) => w.arrived), `${walkers.filter((w) => !w.arrived).length} never reached their station`)
  assert.ok(walkers.every((w) => w.out), `${walkers.filter((w) => !w.out).length} never got back out`)
  for (const w of walkers) assert.ok(!insideRoom(w.room, w.me.x, w.me.z) && !penetrates(w.room, w.me.x, w.me.z), 'back on the sidewalk')
  // A correction is at most a step's reach plus the pad: nobody is thrown across a room.
  assert.ok(maxCorrection < ROOM.pad + 0.3, `largest correction ${maxCorrection.toFixed(3)} m`)
})

test('the doorway is shut to a passer-by jostled off the sidewalk, open only to whoever may enter; a step from inside never ends in a wall', () => {
  const room = workplaces(1337)[0]
  const front = doorFront(room)
  // Pushed straight at the doorway from the lane, a passer-by stops at the lot's pad; may they enter, they walk in.
  let me = front
  for (let i = 0; i < 200; i++) me = walk(room, me, toWorld(room, 0, 0), { x: 0, z: 0 }, 0.05, false)
  assert.ok(toLocal(room, me.x, me.z).u >= h + ROOM.pad - 1e-9 && !insideRoom(room, me.x, me.z), 'held at the doorway')
  me = front
  for (let i = 0; i < 200; i++) me = walk(room, me, toWorld(room, ROOM.hub, 0), { x: 0, z: 0 }, 0.05, true)
  assert.ok(insideRoom(room, me.x, me.z), 'walked in')
  // Inside, every direction over a long walk stays inside or leaves by the doorway, never through a wall.
  const rng = createRng(5)
  for (let trial = 0; trial < 64; trial++) {
    let p = toWorld(room, (rng() - 0.5) * 20, (rng() - 0.5) * 20)
    while (penetrates(room, p.x, p.z)) p = toWorld(room, (rng() - 0.5) * 20, (rng() - 0.5) * 20)
    const goal = toWorld(room, (rng() - 0.5) * 60, (rng() - 0.5) * 60)
    for (let i = 0; i < 400; i++) {
      const q = walk(room, p, goal, { x: (rng() - 0.5) * 0.8, z: (rng() - 0.5) * 0.8 }, 0.05, false)
      assert.ok(!penetrates(room, q.x, q.z), `trial ${trial}: step ${i} into a wall at (${q.x}, ${q.z})`)
      const l = toLocal(room, q.x, q.z)
      if (!insideRoom(room, q.x, q.z)) assert.ok(l.u > h - ROOM.wall && Math.abs(l.v) < ROOM.door, `trial ${trial}: left through the doorway`)
      p = q
    }
  }
})

type XZ = { x: number; z: number }
/** One step of a body (crowd.wgsl simulate's last lines): steer with the separation, mix, cap, contain, slide. */
function bodyStep(room: Workplace, b: { me: XZ; v: XZ }, desired: XZ, sep: XZ, dt: number): void {
  const k = Math.min(1, Math.max(0, dt * 5))
  let vx = b.v.x + (desired.x + sep.x * 0.8 - b.v.x) * k, vz = b.v.z + (desired.z + sep.z * 0.8 - b.v.z) * k
  const sp = Math.hypot(vx, vz)
  if (sp > 3) { vx *= 3 / sp; vz *= 3 / sp }
  const next = { x: b.me.x + vx * dt, z: b.me.z + vz * dt }
  const held = containInRoom(room, b.me, next)
  const rx = held.x - next.x, rz = held.z - next.z
  if (rx * rx + rz * rz > 1e-10) {
    const r = Math.hypot(rx, rz), into = (vx * rx + vz * rz) / r
    if (into < 0) { vx -= (rx / r) * into; vz -= (rz / r) * into }
  }
  b.me = held
  b.v = { x: vx, z: vz }
}
/** A workday leg's walk (crowd.wgsl): at the person's pace, easing in over the last 1.5 m. */
function legWalk(me: XZ, dest: XZ, pace: number): XZ {
  const dx = dest.x - me.x, dz = dest.z - me.z, dist = Math.hypot(dx, dz)
  if (dist <= 1e-3) return { x: 0, z: 0 }
  const s = (pace * Math.min(1, Math.max(0.3, dist / 1.5))) / dist
  return { x: dx * s, z: dz * s }
}
/** Seconds to walk `legs` (each reached within its radius), or Infinity when the walk stalls; penetrations counted. */
function walkLegs(room: Workplace, start: XZ, legs: readonly { at: XZ; arrive: number }[], pace: number, dt: number, limit: number): { t: number; penetrations: number; end: XZ } {
  const b = { me: start, v: { x: 0, z: 0 } }
  let leg = 0, penetrations = 0
  for (let t = 0; t < limit; t += dt) {
    if (Math.hypot(legs[leg].at.x - b.me.x, legs[leg].at.z - b.me.z) < legs[leg].arrive && ++leg === legs.length) return { t, penetrations, end: b.me }
    bodyStep(room, b, legWalk(b.me, legs[leg].at, pace), { x: 0, z: 0 }, dt)
    if (penetrates(room, b.me.x, b.me.z)) penetrations++
  }
  return { t: Infinity, penetrations, end: b.me }
}

test('anyone let go inside a room walks out along the nearer aisle, the hub and the doorway, from anywhere in every room; the straight line to the hub could stall', () => {
  for (const seed of SEEDS) {
    for (const room of workplaces(seed)) {
      // The aisles are clear from the back wall's pieces to the hub (nobody stands behind those: they touch the wall).
      for (const v of [-ROOM.aisle, ROOM.aisle]) {
        for (let u = -(h - ROOM.wall - ROOM.pad); u <= ROOM.hub; u += 0.25) {
          const p = toWorld(room, u, v)
          if (penetrates(room, p.x, p.z)) {
            const piece = room.furniture.find(({ box: [x0, , z0, x1, , z1] }) => p.x > x0 - ROOM.pad && p.x < x1 + ROOM.pad && p.z > z0 - ROOM.pad && p.z < z1 + ROOM.pad)!
            const corners = [[piece.box[0], piece.box[2]], [piece.box[3], piece.box[5]]].map(([x, z]) => toLocal(room, x, z).u)
            assert.ok(Math.min(...corners) < -(h - ROOM.wall - ROOM.pad), `${room.kind}: the aisle at v ${v} is blocked at u ${u} by a piece off the back wall`)
          }
        }
      }
      // From every free point inside, the shader's leaving legs (WORK_LEAVE_ROW → HUB → DOOR) reach the sidewalk.
      for (let u = -12; u <= 12; u += 1) {
        for (let v = -12; v <= 12; v += 1) {
          const start = toWorld(room, u, v)
          if (penetrates(room, start.x, start.z)) continue
          const legs = [
            { at: toWorld(room, ROOM.hub, v >= 0 ? ROOM.aisle : -ROOM.aisle), arrive: 0.6 },
            { at: toWorld(room, ROOM.hub, 0), arrive: 0.6 },
            { at: doorFront(room), arrive: 0.8 },
          ]
          const r = walkLegs(room, start, legs, 1.1, 0.05, 90)
          assert.ok(Number.isFinite(r.t), `${room.kind} seed ${seed}: let go at (${u}, ${v}), stalled at (${toLocal(room, r.end.x, r.end.z).u.toFixed(2)}, ${toLocal(room, r.end.x, r.end.z).v.toFixed(2)})`)
          assert.equal(r.penetrations, 0, `${room.kind} seed ${seed}: from (${u}, ${v})`)
        }
      }
    }
  }
  // Why the aisle: in the boardroom, from just behind the plinth on the room's axis, the straight line to the hub
  // presses on its back face and stays there.
  const boardroom = workplaces(1337).find((r) => r.kind === 'boardroom')!
  const straight = walkLegs(boardroom, toWorld(boardroom, 1, 0.2), [{ at: toWorld(boardroom, ROOM.hub, 0), arrive: 0.6 }], 1.1, 0.05, 90)
  assert.equal(straight.t, Infinity, 'the straight line to the hub stalls behind the plinth')
})

// The indoor legs' 0.6 m arrival sits inside the separation's equilibrium (about 0.62-0.65 m behind a worker at the
// desk, at the slower paces): with it, B stood behind A as a commuter until A's shift ended.
test('a second worker dealt an occupied station sits down beside the first: WORK.seat is wider than the separation lets them come', () => {
  const room = workplaces(1337)[0]
  const st = room.stations[0]
  const station = { x: st.x, z: st.z }
  const sepOf = (a: XZ, b: XZ): XZ => {
    const dx = a.x - b.x, dz = a.z - b.z, d2 = dx * dx + dz * dz
    return d2 > 1e-6 && d2 < 0.64 ? { x: dx / d2, z: dz / d2 } : { x: 0, z: 0 }
  }
  for (const dt of [1 / 60, 1 / 30, 0.05]) {
    for (const pace of [1.1, 1.2, 1.3, 1.4, 1.5]) {
      // A at work on the station (the working spring), B walking the last leg from the row's start.
      const a = { me: { ...station }, v: { x: 0, z: 0 } }
      const b = { me: toWorld(room, ROOM.hub, st.v), v: { x: 0, z: 0 } }
      let seated = false, closest = Infinity
      for (let t = 0; t < 40 && !seated; t += dt) {
        const was = { a: { ...a.me }, b: { ...b.me } }
        const dx = station.x - a.me.x, dz = station.z - a.me.z, da = Math.hypot(dx, dz)
        const hold = da > 1e-3 ? { x: (dx / da) * Math.min(da * 3, 1.3), z: (dz / da) * Math.min(da * 3, 1.3) } : { x: 0, z: 0 }
        bodyStep(room, a, hold, sepOf(was.a, was.b), dt)
        bodyStep(room, b, legWalk(b.me, station, pace), sepOf(was.b, was.a), dt)
        const db = Math.hypot(station.x - b.me.x, station.z - b.me.z)
        closest = Math.min(closest, db)
        seated = db < WORK.seat
      }
      assert.ok(seated, `pace ${pace}, dt ${dt.toFixed(3)}: B stalled ${closest.toFixed(3)} m from the station`)
    }
  }
})

/** Whether a car's chassis (CAR.halfLength 2.3 by halfWidth 0.92) at `car` facing `heading` overlaps a piece of a room's furniture. */
function chassisHits(room: Workplace, car: XZ, heading: number): boolean {
  const f = { x: Math.sin(heading), z: Math.cos(heading) }, l = { x: Math.cos(heading), z: -Math.sin(heading) }
  const corners = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => ({ x: car.x + f.x * a * 2.3 + l.x * b * 0.92, z: car.z + f.z * a * 2.3 + l.z * b * 0.92 }))
  return room.furniture.some(({ box: [x0, , z0, x1, , z1] }) => {
    if (Math.max(...corners.map((c) => c.x)) <= x0 || Math.min(...corners.map((c) => c.x)) >= x1) return false
    if (Math.max(...corners.map((c) => c.z)) <= z0 || Math.min(...corners.map((c) => c.z)) >= z1) return false
    const box = [[x0, z0], [x0, z1], [x1, z0], [x1, z1]]
    const pf = box.map(([x, z]) => (x - car.x) * f.x + (z - car.z) * f.z), pl = box.map(([x, z]) => (x - car.x) * l.x + (z - car.z) * l.z)
    return !(Math.max(...pf) <= -2.3 || Math.min(...pf) >= 2.3 || Math.max(...pl) <= -0.92 || Math.min(...pl) >= 0.92)
  })
}

/** A room's glass in its own frame, [u0, v0, u1, v1]: the back wall, the two side walls, the doorway wall either side of the opening. */
function glassOf(): number[][] {
  const w = ROOM.wall, d = ROOM.door
  return [[-h, -h, -h + w, h], [-h, h - w, h, h], [-h, -h, h, -h + w], [h - w, d, h, h], [h - w, -h, h, -d]]
}
/** Whether a car's chassis at `car` facing `heading` overlaps the room's glass (separating axes, in the room's frame). */
function chassisInGlass(room: Workplace, car: XZ, heading: number): boolean {
  const c = toLocal(room, car.x, car.z), f = toLocal(room, room.cx + Math.sin(heading), room.cz + Math.cos(heading))
  const corners = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => ({ u: c.u + f.u * a * 2.3 - f.v * b * 0.92, v: c.v + f.v * a * 2.3 + f.u * b * 0.92 }))
  return glassOf().some(([u0, v0, u1, v1]) => {
    if (Math.max(...corners.map((p) => p.u)) <= u0 || Math.min(...corners.map((p) => p.u)) >= u1) return false
    if (Math.max(...corners.map((p) => p.v)) <= v0 || Math.min(...corners.map((p) => p.v)) >= v1) return false
    const box = [[u0, v0], [u0, v1], [u1, v0], [u1, v1]]
    const pf = box.map(([u, v]) => (u - c.u) * f.u + (v - c.v) * f.v), pl = box.map(([u, v]) => -(u - c.u) * f.v + (v - c.v) * f.u)
    return !(Math.max(...pf) <= -2.3 || Math.min(...pf) >= 2.3 || Math.max(...pl) <= -0.92 || Math.min(...pl) >= 0.92)
  })
}
/** Whether the line from a to b passes through the room's glass (a slab test per pane, in the room's frame). */
function throughGlass(room: Workplace, a: XZ, b: XZ): boolean {
  const p = toLocal(room, a.x, a.z), q = toLocal(room, b.x, b.z), du = q.u - p.u, dv = q.v - p.v
  return glassOf().some(([u0, v0, u1, v1]) => {
    let t0 = 0, t1 = 1
    for (const [o, d, lo, hi] of [[p.u, du, u0, u1], [p.v, dv, v0, v1]]) {
      if (Math.abs(d) < 1e-12) { if (o <= lo || o >= hi) return false; continue }
      const ta = (lo - o) / d, tb = (hi - o) / d
      t0 = Math.max(t0, Math.min(ta, tb)); t1 = Math.min(t1, Math.max(ta, tb))
    }
    return t0 < t1
  })
}

test('a car left in a room or across its doorway puts its driver where they fit: indoors clear of glass and furniture, or out on the street from the doorway; outside, the rule is unchanged', () => {
  const lim = h - ROOM.wall
  let indoorPoses = 0, doorPoses = 0, swung = 0, squeezed = 0
  const check = (rooms: readonly Workplace[], room: Workplace, car: XZ, heading: number, indoor: boolean, at: string) => {
    const p = exitPoint(car.x, car.z, heading, rooms)
    assert.ok(Math.abs(Math.hypot(p.x - car.x, p.z - car.z) - EXIT_SIDE) < 1e-9, `${at}: EXIT_SIDE from the car`)
    // Clear of the chassis's side by a person's radius, but where the car is wedged in (nowhere beside it is free).
    const side = (p.x - car.x) * Math.cos(heading) - (p.z - car.z) * Math.sin(heading)
    if (Math.abs(side) < 0.92 + PERSON.radius - 1e-9) squeezed++
    else if (Math.abs(side) < EXIT_SIDE - 1e-9) swung++
    const l = toLocal(room, p.x, p.z)
    const inRoom = insideRoom(room, p.x, p.z) && !penetrates(room, p.x, p.z, PERSON.radius - 1e-6)
    const street = Math.max(Math.abs(l.u), Math.abs(l.v)) >= h + PERSON.radius
    assert.ok(indoor ? inRoom : inRoom || street, `${at}: into the glass or a piece of furniture, at (${l.u.toFixed(2)}, ${l.v.toFixed(2)})`)
    assert.ok(!throughGlass(room, car, p), `${at}: out through the glass, to (${l.u.toFixed(2)}, ${l.v.toFixed(2)})`)
  }
  for (const seed of [1337, 42]) {
    const rooms = workplaces(seed)
    for (const room of rooms) {
      const ahead = doorDir(room.side), out = Math.atan2(ahead.x, ahead.z)
      // Parked anywhere inside (hugging the walls and the furniture), every way round.
      for (let u = -lim; u <= lim; u += 0.5) {
        for (let v = -lim; v <= lim; v += 0.5) {
          for (const turn of [0, 0.5, Math.PI / 2, 2.2, Math.PI, 4.1, (3 * Math.PI) / 2]) {
            const car = toWorld(room, u, v), heading = out + turn
            const corners = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => toLocal(room, car.x + Math.sin(heading) * a * 2.3 + Math.cos(heading) * b * 0.92, car.z + Math.cos(heading) * a * 2.3 - Math.sin(heading) * b * 0.92))
            if (corners.some((c) => Math.max(Math.abs(c.u), Math.abs(c.v)) >= lim) || chassisHits(room, car, heading)) continue
            indoorPoses++
            check(rooms, room, car, heading, true, `${room.kind} seed ${seed}: out of a car at (${u}, ${v}) turned ${turn.toFixed(2)}`)
          }
        }
      }
      // Standing across the doorway, any way round it fits between the jambs: the glass beside it either way. The
      // across-grid takes in v = ±0.8 and ±0.95, where a car turned 22.5 to 39 degrees into the room puts its left
      // side's point just past a jamb's inner corner.
      for (let u = lim - 2.3; u <= h + 2.3; u += 0.1) {
        for (const v of [-1.5, -1.25, -1, -0.95, -0.8, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 0.8, 0.95, 1, 1.25, 1.5]) {
          for (let k = 0; k < 32; k++) {
            const turn = (k * Math.PI) / 16, car = toWorld(room, u, v), heading = out + turn
            if (chassisInGlass(room, car, heading) || chassisHits(room, car, heading)) continue
            doorPoses++
            const c = toLocal(room, car.x, car.z)
            check(rooms, room, car, heading, Math.max(Math.abs(c.u), Math.abs(c.v)) < lim, `${room.kind} seed ${seed}: out of a car across the doorway at (${u.toFixed(2)}, ${v}) turned ${turn.toFixed(2)}`)
          }
        }
      }
    }
    // On the street, the left side unless that is in a lot: what it always was.
    for (const [x, z, hd] of [[CITY.pitch * 3, CITY.pitch * 4 + 3, 0], [CITY.pitch * 6 + 2, CITY.pitch * 5 + 20, Math.PI / 2], [CITY.pitch * 8 + 20, CITY.pitch * 8 + 2, 1.1]]) {
      assert.deepEqual(exitPoint(x, z, hd, rooms), exitPoint(x, z, hd))
    }
  }
  assert.ok(indoorPoses > 10000 && doorPoses > 100 && swung > 0, `${indoorPoses} poses indoors, ${doorPoses} across a doorway, ${swung} swung`)
  assert.ok(squeezed < (indoorPoses + doorPoses) / 250, `${squeezed} of ${indoorPoses + doorPoses} wedged in`)
})

// The summons across a room's glass, mirrored from crowd.wgsl (simulate's summoned arm, summonWay, walled, the step).
const STOP = INTERVIEW_DISTANCE
const lotC = (p: XZ): XZ => ({ x: (Math.floor(p.x / CITY.pitch) + 0.5) * CITY.pitch, z: (Math.floor(p.z / CITY.pitch) + 0.5) * CITY.pitch })
const roomAt = (rooms: readonly Workplace[], p: XZ) => { const c = lotC(p); return rooms.findIndex((r) => Math.abs(c.x - r.cx) < 0.5 && Math.abs(c.z - r.cz) < 0.5) }
const strictlyIn = (r: Workplace, p: XZ) => { const l = toLocal(r, p.x, p.z); return Math.max(Math.abs(l.u), Math.abs(l.v)) < h - ROOM.wall }
const indoorsOf = (rooms: readonly Workplace[], p: XZ) => { const r = roomAt(rooms, p); return r >= 0 && strictlyIn(rooms[r], p) ? r : -1 }
/** crowd.wgsl glassBetween: the room whose glass stands between p and q (the line crosses a pane of the room whose lot either stands in), or -1. */
const glassBetween = (rooms: readonly Workplace[], p: XZ, q: XZ, pad = 0) => {
  const a = roomAt(rooms, p)
  if (a >= 0 && crossesGlass(rooms[a], p, q, pad)) return a
  const b = roomAt(rooms, q)
  if (b >= 0 && b !== a && crossesGlass(rooms[b], p, q, pad)) return b
  return -1
}
const walled = (rooms: readonly Workplace[], p: XZ, q: XZ) => glassBetween(rooms, p, q) >= 0
const dirTo = (a: XZ, b: XZ): XZ => { const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz); return l > 1e-4 ? { x: dx / l, z: dz / l } : { x: 0, z: 0 } }
/** crowd.wgsl arriveAt: dirTo, slowing to a stop within ARRIVE of b. */
const arriveAt = (a: XZ, b: XZ): XZ => { const d = dirTo(a, b), k = Math.min(1, Math.hypot(b.x - a.x, b.z - a.z) / 0.25); return { x: d.x * k, z: d.z * k } }
/** hitsBox in city coordinates (its u, v are x, z here). */
const hits = (a: XZ, b: XZ, lo: XZ, hi: XZ) => hitsBox({ u: a.x, v: a.z }, { u: b.x - a.x, v: b.z - a.z }, { u: lo.x, v: lo.z }, { u: hi.x, v: hi.z })
function clearOfFurniture(room: Workplace, a: XZ, b: XZ, pad: number): boolean {
  for (const { box: [x0, , z0, x1, , z1] } of room.furniture) {
    if (hits(a, b, { x: x0 - pad, z: z0 - pad }, { x: x1 + pad, z: z1 + pad })) return false
  }
  return true
}
function offFurniture(room: Workplace, p: XZ): XZ {
  const g = ROOM.pad + 0.05, m = h - ROOM.wall - ROOM.pad - 1e-3
  let q = p
  for (const { box: [x0, , z0, x1, , z1] } of room.furniture) {
    const lo = { x: x0 - g, z: z0 - g }, hi = { x: x1 + g, z: z1 + g }
    if (q.x <= lo.x || q.z <= lo.z || q.x >= hi.x || q.z >= hi.z) continue
    let best = 1e9, spot = q
    for (const e of [{ x: lo.x, z: q.z }, { x: hi.x, z: q.z }, { x: q.x, z: lo.z }, { x: q.x, z: hi.z }]) {
      const c = { x: Math.min(room.cx + m, Math.max(room.cx - m, e.x)), z: Math.min(room.cz + m, Math.max(room.cz - m, e.z)) }, d = Math.hypot(c.x - q.x, c.z - q.z)
      if (c.x > lo.x && c.z > lo.z && c.x < hi.x && c.z < hi.z) continue
      if (d < best) { best = d; spot = c }
    }
    q = spot
  }
  return q
}
/** The operator's trail as the uniform carries it (skills.ts OperatorTrail): newest first. */
type Trail = Readonly<OperatorTrail>
const trailSpot = (room: Workplace, trail: Trail, k: number): XZ => offFurniture(room, { x: trail.xz[2 * k], z: trail.xz[2 * k + 1] })
function roomWay(rooms: readonly Workplace[], room: Workplace, me: XZ, to: XZ, trail: Trail | null, there: boolean): XZ {
  const clear = ROOM.pad - 0.05, held = ROOM.pad - 1e-3
  const goal = offFurniture(room, to)
  if (clearOfFurniture(room, me, goal, held)) return dirTo(me, goal)
  if (trail) {
    let next = goal
    for (let k = 0; k < Math.min(trail.count, TRAIL.points); k++) {
      const t = trailSpot(room, trail, k)
      if ((k > 0 || there) && (!clearOfFurniture(room, t, next, 0) || walled(rooms, t, next))) break
      if (clearOfFurniture(room, me, t, held) && !walled(rooms, me, t)) {
        const on = Math.hypot(next.x - me.x, next.z - me.z) <= Math.hypot(next.x - t.x, next.z - t.z) && clearOfFurniture(room, me, next, 0) && !walled(rooms, me, next)
        return dirTo(me, on ? next : t)
      }
      next = t
    }
  }
  const reach = h - ROOM.wall - ROOM.pad, g = ROOM.pad + ROOM.round
  let best = 1e9, aim = toWorld(room, ROOM.hub, toLocal(room, me.x, me.z).v >= 0 ? ROOM.aisle : -ROOM.aisle)
  for (const { box: [x0, , z0, x1, , z1] } of room.furniture) {
    for (let c = 0; c < 4; c++) {
      const q = { x: c & 1 ? x1 + g : x0 - g, z: c & 2 ? z1 + g : z0 - g }, l = toLocal(room, q.x, q.z)
      const cost = Math.hypot(q.x - me.x, q.z - me.z) + Math.hypot(goal.x - q.x, goal.z - q.z)
      if (Math.max(Math.abs(l.u), Math.abs(l.v)) >= reach || cost >= best) continue
      if (!clearOfFurniture(room, q, q, ROOM.pad) || !clearOfFurniture(room, me, q, clear) || !clearOfFurniture(room, q, goal, clear)) continue
      best = cost
      aim = q
    }
  }
  const leg = { x: goal.x - aim.x, z: goal.z - aim.z }, along = Math.min(1, Math.max(0, ((me.x - aim.x) * leg.x + (me.z - aim.z) * leg.z) / Math.max(leg.x * leg.x + leg.z * leg.z, 1e-6)))
  if (best < 1e9 && Math.hypot(aim.x + leg.x * along - me.x, aim.z + leg.z * along - me.z) < ROOM.round) return dirTo(me, goal)
  return dirTo(me, aim)
}
/** crowd.wgsl pushOut: out of the lot square under p, grown by pad, along the shorter way. */
function pushOut(p: XZ, pad: number): XZ {
  const c = lotC(p), lx = p.x - c.x, lz = p.z - c.z, lim = h + pad
  if (Math.abs(lx) >= lim || Math.abs(lz) >= lim) return p
  return lim - Math.abs(lx) < lim - Math.abs(lz) ? { x: c.x + (lx >= 0 ? lim : -lim), z: p.z } : { x: p.x, z: c.z + (lz >= 0 ? lim : -lim) }
}
function offLot(rooms: readonly Workplace[], p: XZ): XZ {
  const g = ROOM.pad + 0.05
  const r = roomAt(rooms, p)
  if (r < 0) return pushOut(p, ROOM.pad)
  let { u, v } = toLocal(rooms[r], p.x, p.z)
  for (const [u0, v0, u1, v1] of glassPanes()) {
    const lo = { u: u0 - g, v: v0 - g }, hi = { u: u1 + g, v: v1 + g }
    if (u <= lo.u || v <= lo.v || u >= hi.u || v >= hi.v) continue
    const dlo = { u: u - lo.u, v: v - lo.v }, dhi = { u: hi.u - u, v: hi.v - v }
    if (Math.min(dlo.u, dhi.u) < Math.min(dlo.v, dhi.v)) u = dlo.u < dhi.u ? lo.u : hi.u
    else v = dlo.v < dhi.v ? lo.v : hi.v
  }
  return toWorld(rooms[r], u, v)
}
function lotCut(rooms: readonly Workplace[], p: XZ, a: XZ, b: XZ, pad: number): boolean {
  const r = roomAt(rooms, p)
  if (r >= 0) return crossesGlass(rooms[r], a, b, pad)
  const c = lotC(p), lim = h + pad
  return hits(a, b, { x: c.x - lim, z: c.z - lim }, { x: c.x + lim, z: c.z + lim })
}
function summonWay(grid: ReturnType<typeof cityGrid>, dir: Float32Array, rooms: readonly Workplace[], me: XZ, at: XZ, dist: number, pane: number, trail: Trail | null = null, lane: number = CITY.lane): XZ {
  const mine = indoorsOf(rooms, me), theirs = indoorsOf(rooms, at)
  const follow = trail !== null && trail.count > 0 && Math.hypot(trail.xz[0] - at.x, trail.xz[1] - at.z) < TRAIL.near ? trail : null
  if (mine >= 0 && mine === theirs) return roomWay(rooms, rooms[mine], me, at, follow, true)
  let flow = flowAt(grid, dir, me.x, me.z)
  const offGlass = () => {
    const here = roomAt(rooms, me)
    if (here >= 0) {
      const q = rooms[here], k = toLocal(q, me.x, me.z)
      const n = Math.abs(k.u) >= Math.abs(k.v) ? { u: Math.sign(k.u), v: 0 } : { u: 0, v: Math.sign(k.v) }
      const o = toWorld(q, k.u + n.u * grid.cell, k.v + n.v * grid.cell)
      flow = flowAt(grid, dir, o.x, o.z)
    }
  }
  if (mine !== theirs || pane >= 0) {
    const ri = mine >= 0 ? mine : theirs >= 0 ? theirs : pane, r = rooms[ri]
    // The door front's u is the compiled CITY_LANE's: the city's 5.8 m lane, a region window's 4.9 m one.
    const l = toLocal(r, me.x, me.z), front = CITY.pitch / 2 - lane
    if (Math.abs(l.v) < ROOM.door + 1.5 && l.u > h - ROOM.wall - 1.5 && l.u < front + 1 && (mine !== theirs || l.u < h)) return dirTo(me, toWorld(r, mine < 0 && theirs === ri ? ROOM.hub : front, 0))
    if (mine >= 0) return roomWay(rooms, r, me, toWorld(r, ROOM.hub + 1, l.v >= 0 ? ROOM.aisle : -ROOM.aisle), follow, false)
    if (flow.x * flow.x + flow.z * flow.z <= 0.5) offGlass()
    if (flow.x * flow.x + flow.z * flow.z > 0.5) return flow
  }
  const goal = offLot(rooms, at), pad = ROOM.pad - 1e-3, onto = roomAt(rooms, at) < 0 ? pushOut(at, ROOM.pad - 0.25) : goal
  const inward = flow.x * flow.x + flow.z * flow.z > 0.5 && roomAt(rooms, me) < 0 && lotC(me).x === lotC(goal).x && lotC(me).z === lotC(goal).z && lotCut(rooms, me, me, { x: me.x + flow.x * 2, z: me.z + flow.z * 2 }, pad)
  if (dist <= 4 * STOP || inward) {
    if (!lotCut(rooms, me, me, goal, pad) && !lotCut(rooms, goal, me, goal, pad)) return arriveAt(me, onto)
    const r = roomAt(rooms, me)
    if (r >= 0 && r === roomAt(rooms, goal)) {
      let best = 1e9, aim = goal
      for (const s of [-1, 1]) {
        const c = toWorld(rooms[r], h + ROOM.pad + 0.05, s * (ROOM.door - ROOM.pad - 0.05))
        const cost = Math.hypot(c.x - me.x, c.z - me.z) + Math.hypot(goal.x - c.x, goal.z - c.z)
        if (cost < best && !crossesGlass(rooms[r], me, c, pad) && !crossesGlass(rooms[r], c, goal, pad)) { best = cost; aim = c }
      }
      if (best < 1e9) return dirTo(me, aim)
    }
    const p = lotCut(rooms, me, me, goal, pad) ? me : goal
    if (roomAt(rooms, p) < 0) {
      const c = lotC(p), g = h + ROOM.pad + 0.05, face = h + ROOM.pad, l = { x: me.x - c.x, z: me.z - c.z }
      const clampF = (x: number) => Math.min(face, Math.max(-face, x))
      const own = Math.abs(l.x) >= Math.abs(l.z) ? { x: c.x + Math.sign(l.x) * face, z: c.z + clampF(at.z - c.z) } : { x: c.x + clampF(at.x - c.x), z: c.z + Math.sign(l.z) * face }
      if (Math.hypot(own.x - at.x, own.z - at.z) < STOP && !lotCut(rooms, me, me, own, pad) && !lotCut(rooms, goal, me, own, pad)) return dirTo(me, own)
      let best = 1e9, aim = goal
      for (let k = 0; k < 4; k++) {
        const q = { x: c.x + (k & 1 ? g : -g), z: c.z + (k & 2 ? g : -g) }
        const cost = Math.hypot(q.x - me.x, q.z - me.z) + Math.hypot(goal.x - q.x, goal.z - q.z)
        if (cost < best && (Math.hypot(q.x - at.x, q.z - at.z) <= 4 * STOP || Math.hypot(goal.x - at.x, goal.z - at.z) < STOP) && !lotCut(rooms, me, me, q, pad) && !lotCut(rooms, goal, me, q, pad) && !lotCut(rooms, me, q, goal, pad) && !lotCut(rooms, goal, q, goal, pad)) { best = cost; aim = q }
      }
      if (best < 1e9) return dirTo(me, aim)
    }
  }
  if (flow.x * flow.x + flow.z * flow.z <= 0.5) offGlass()
  return flow.x * flow.x + flow.z * flow.z > 0.5 ? flow : arriveAt(me, onto)
}
function containAny(rooms: readonly Workplace[], was: XZ, to: XZ): XZ {
  const r = roomAt(rooms, to)
  if (r >= 0) return containInRoom(rooms[r], was, to)
  const c = lotC(to), lx = to.x - c.x, lz = to.z - c.z, lim = h + ROOM.pad
  if (Math.abs(lx) >= lim || Math.abs(lz) >= lim) return to
  return lim - Math.abs(lx) < lim - Math.abs(lz) ? { x: c.x + (lx >= 0 ? lim : -lim), z: to.z } : { x: to.x, z: c.z + (lz >= 0 ? lim : -lim) }
}
/**
 * Seconds until someone asked over at `from` arrives (talking, SUMMON_STOP from the operator, who stands at `op` or
 * walks it as a function of time), or Infinity; and where they end.
 */
function summon(grid: ReturnType<typeof cityGrid>, dir: Float32Array, rooms: readonly Workplace[], from: XZ, op: XZ | ((t: number) => XZ), pace: number, dt: number, limit: number): { t: number; end: XZ } {
  const a = { me: from, v: { x: 0, z: 0 } }, trail = new OperatorTrail()
  for (let t = 0; t < limit; t += dt) {
    const at = typeof op === 'function' ? op(t) : op
    trail.update(at.x, at.z, true)
    const dist = Math.hypot(at.x - a.me.x, at.z - a.me.z), pane = glassBetween(rooms, a.me, at), glass = pane >= 0
    const seen = glassBetween(rooms, a.me, offLot(rooms, at), ROOM.pad - 0.05) < 0
    if (dist <= STOP && seen) return { t, end: a.me }
    const far = glass ? Math.max(dist, STOP + 2) : dist
    const k = pace * Math.min(1, Math.max(0.25, far - STOP)), way = summonWay(grid, dir, rooms, a.me, at, dist, pane, trail)
    const m = Math.min(1, dt * 5)
    let nv = { x: a.v.x + (way.x * k - a.v.x) * m, z: a.v.z + (way.z * k - a.v.z) * m }
    const sp = Math.hypot(nv.x, nv.z)
    if (sp > 3) nv = { x: (nv.x * 3) / sp, z: (nv.z * 3) / sp }
    if (seen && dist > 1e-4 && dist < STOP) {
      const ux = (at.x - a.me.x) / dist, uz = (at.z - a.me.z) / dist, inward = nv.x * ux + nv.z * uz
      if (inward > 0) nv = { x: nv.x - ux * inward, z: nv.z - uz * inward }
    }
    const next = { x: a.me.x + nv.x * dt, z: a.me.z + nv.z * dt }
    const held = containAny(rooms, a.me, next)
    const rx = held.x - next.x, rz = held.z - next.z
    if (rx * rx + rz * rz > 1e-10) {
      const r = Math.hypot(rx, rz), into = (nv.x * rx + nv.z * rz) / r
      if (into < 0) nv = { x: nv.x - (rx / r) * into, z: nv.z - (rz / r) * into }
    }
    a.me = held
    a.v = nv
  }
  return { t: Infinity, end: a.me }
}

test('someone asked over across a room\'s glass comes round by the doorway and arrives on the operator\'s side, never pinned on a jamb or the glass', () => {
  let runs = 0
  for (const seed of SEEDS) {
    const grid = cityGrid(generateBuildings(seed).map((b) => b.box))
    const rooms = workplaces(seed)
    for (const room of rooms) {
      // The operator inside, by each wall and by the doorway; and outside, on the sidewalk by each face.
      const operators: { at: XZ; inside: boolean }[] = []
      for (const [u, v] of [[9, -1.5], [11.5, 6], [-11.5, 3], [2, 11.5], [-4, -11.5], [6, 0]]) operators.push({ at: toWorld(room, u, v), inside: true })
      for (const [u, v] of [[14, -4], [13.8, 6], [-14, 2], [3, 14], [-6, -14]]) operators.push({ at: toWorld(room, u, v), inside: false })
      for (const op of operators) {
        if (penetrates(room, op.at.x, op.at.z)) continue
        const dir = solveFlow(grid, [nearestOpen(grid, op.at.x, op.at.z)]).dir
        // Recruits within earshot (6 m) on the other side of the glass: outside on the sidewalk, or inside the room.
        for (let du = -6; du <= 6; du += 1.5) {
          for (let dv = -6; dv <= 6; dv += 1.5) {
            const l = toLocal(room, op.at.x, op.at.z)
            const from = toWorld(room, l.u + du, l.v + dv)
            const fl = toLocal(room, from.x, from.z), m = Math.max(Math.abs(fl.u), Math.abs(fl.v))
            const ok = op.inside ? m > h + ROOM.pad + 0.05 && m < h + 2.2 : m < h - ROOM.wall - ROOM.pad - 0.05 && !penetrates(room, from.x, from.z)
            if (!ok || Math.hypot(from.x - op.at.x, from.z - op.at.z) > 6) continue
            runs++
            const r = summon(grid, dir, rooms, from, op.at, 1.1, 1 / 30, 150)
            const e = toLocal(room, r.end.x, r.end.z)
            assert.ok(Number.isFinite(r.t), `${room.kind} seed ${seed}: from (${fl.u.toFixed(1)}, ${fl.v.toFixed(1)}) to the operator at (${l.u.toFixed(1)}, ${l.v.toFixed(1)}): still coming at (${e.u.toFixed(2)}, ${e.v.toFixed(2)})`)
          }
        }
      }
    }
  }
  assert.ok(runs > 1000, `${runs} runs`)
  // A metre or two away through the glass is no last stretch: the way round is walked at full pace, inside the time
  // a recruit has to arrive (the operator stepped in or out by the doorway while they were coming).
  const rooms = workplaces(1337), room = rooms[0], grid = cityGrid(generateBuildings(1337).map((b) => b.box))
  for (const [op, from] of [[[13.5, 3], [12, 7.5]], [[12.2, 8], [13.4, 8]]]) {
    const at = toWorld(room, op[0], op[1])
    const dir = solveFlow(grid, [nearestOpen(grid, at.x, at.z)]).dir
    const r = summon(grid, dir, rooms, toWorld(room, from[0], from[1]), at, 1.1, 1 / 60, 60)
    assert.ok(r.t < APPROACH_SECONDS, `from (${from}) round to the operator at (${op}): ${r.t.toFixed(1)} s`)
  }
})

test('someone asked over inside a room comes round its furniture to the operator, standing anywhere or walking past the pieces', () => {
  let runs = 0
  for (const seed of [1337, 42]) {
    const grid = cityGrid(generateBuildings(seed).map((b) => b.box))
    const silent = new Float32Array(grid.width * grid.height * 2)
    const rooms = workplaces(seed)
    for (const room of rooms) {
      // Free floor on a 3 m lattice: the operators on it, the recruits on the same lattice shifted by 1.5 m.
      const lim = h - ROOM.wall - ROOM.pad - 0.05
      const free = (o: number) => {
        const out: { u: number; v: number; at: XZ }[] = []
        for (let u = -lim + o; u <= lim; u += 3) for (let v = -lim + o; v <= lim; v += 3) {
          const at = toWorld(room, u, v)
          if (!penetrates(room, at.x, at.z, ROOM.pad + 0.05)) out.push({ u, v, at })
        }
        return out
      }
      const recruits = free(1.5)
      for (const op of free(0)) {
        for (const r of recruits) {
          const d = Math.hypot(r.at.x - op.at.x, r.at.z - op.at.z)
          if (d <= STOP || d > 12) continue
          runs++
          const end = summon(grid, silent, rooms, r.at, op.at, TETHER_PACE, 1 / 30, 60)
          const e = toLocal(room, end.end.x, end.end.z)
          assert.ok(Number.isFinite(end.t), `${room.kind} seed ${seed}: from (${r.u.toFixed(1)}, ${r.v.toFixed(1)}) to the operator at (${op.u.toFixed(1)}, ${op.v.toFixed(1)}): still coming at (${e.u.toFixed(2)}, ${e.v.toFixed(2)})`)
        }
      }
    }
  }
  assert.ok(runs > 5000, `${runs} runs`)
  // An operator walking round the pieces with a recruit in tow (the walks that pinned them behind a pedestal, a
  // conveyor and, past the last 6 m, on the conveyor's back face): seed 1337, from just inside the doorway.
  const rooms = workplaces(1337)
  const grid = cityGrid(generateBuildings(1337).map((b) => b.box))
  const walk = (pts: number[][], speed: number) => (t: number): XZ => {
    let left = t * speed
    for (let k = 1; k < pts.length; k++) {
      const [ax, az] = pts[k - 1], [bx, bz] = pts[k], len = Math.hypot(bx - ax, bz - az)
      if (left <= len) return { x: ax + ((bx - ax) * left) / len, z: az + ((bz - az) * left) / len }
      left -= len
    }
    const [x, z] = pts[pts.length - 1]
    return { x, z }
  }
  for (const [kind, pts, speed] of [
    ['roboticsLab', [[11, 0], [8, -10.5], [1, -10.5], [1, -4.6], [3, -4.6]], 2],
    ['warehouse', [[11, 0], [7, 8], [-11.3, 8], [-11.3, 4.6], [-5, 4.6]], 2],
    ['warehouse', [[11, 0], [7, 8], [-11.3, 8], [-11.3, 2], [-8, -2.75]], 3],
  ] as const) {
    const room = rooms.find((r) => r.kind === kind)!
    const path = pts.map(([u, v]) => { const p = toWorld(room, u, v); return [p.x, p.z] })
    const end = summon(grid, new Float32Array(grid.width * grid.height * 2), rooms, toWorld(room, 12, 1.5), walk(path, speed), TETHER_PACE, 1 / 60, 90)
    const e = toLocal(room, end.end.x, end.end.z)
    assert.ok(Number.isFinite(end.t), `${kind}: following the operator round the pieces, stuck at (${e.u.toFixed(2)}, ${e.v.toFixed(2)})`)
  }
})

test('on the street, someone asked over beyond the last stretch follows the field\'s arrow round a lot\'s corner', () => {
  // Seed 1337: the operator 6.2 m off the street line by the lot at (540, 620), whose building stands back from its
  // edge, so the field's column along that edge is open, its cell centres 0.35 m inside the lot's containment. Aiming
  // at those centres pinned the recruit on the lot's face; the arrow takes them round.
  const grid = cityGrid(generateBuildings(1337).map((b) => b.box)), rooms = workplaces(1337)
  const at = { x: 526.2, z: 613 }
  const dir = solveFlow(grid, [nearestOpen(grid, at.x, at.z)]).dir
  for (const pace of [1.1, 1.3, TETHER_PACE]) {
    const r = summon(grid, dir, rooms, { x: 526.5, z: 605 }, at, pace, 1 / 60, 30)
    assert.ok(Number.isFinite(r.t), `pace ${pace}: still coming at (${r.end.x.toFixed(2)}, ${r.end.z.toFixed(2)})`)
  }
})

test('nobody talks through a doorway\'s jamb: the glass stands between two people unless the line between them passes through the opening', () => {
  const room = workplaces(1337)[0], rooms = [room]
  const at = (u: number, v: number) => toWorld(room, u, v)
  // Through the opening, inside to outside and back, and both in the doorway's band: no glass.
  for (const [a, b] of [[[12, 0], [13.4, 0.5]], [[12.1, 1.5], [13.35, 1.9]], [[11, -1], [14, -1.8]], [[12.7, 1], [13.3, -1]]]) {
    assert.equal(walled(rooms, at(a[0], a[1]), at(b[0], b[1])), false, `(${a}) to (${b})`)
    assert.equal(walled(rooms, at(b[0], b[1]), at(a[0], a[1])), false, `(${b}) to (${a})`)
  }
  // The reviewer's pair (the recruit inside beside the jamb, the operator outside by the opening), the jamb's far
  // side, and the side and back walls: glass.
  for (const [a, b] of [[[12.09, 2.76], [13.35, 1.95]], [[12, 2.5], [13.4, 1.96]], [[12, 3], [13.5, 3]], [[0, 12], [0, 13.6]], [[-12, 0], [-13.5, 0]]]) {
    assert.equal(walled(rooms, at(a[0], a[1]), at(b[0], b[1])), true, `(${a}) to (${b})`)
    assert.equal(walled(rooms, at(b[0], b[1]), at(a[0], a[1])), true, `(${b}) to (${a})`)
  }
})

// The summoned arm in full, mirrored from crowd.wgsl simulate (no cars): the talking state and its hysteresis, the
// tether's pace, the talking distance, the kerb, the crowd's separation from people standing by, the containment and
// the slide. `summon` above stops at the first arrival; this runs on, for what happens after it.
const offsets = (p: XZ): XZ => ({ x: p.x - Math.round(p.x / CITY.pitch) * CITY.pitch, z: p.z - Math.round(p.z / CITY.pitch) * CITY.pitch })
const onRoad = (p: XZ) => { const o = offsets(p); return Math.abs(o.x) < CITY.roadHalf || Math.abs(o.z) < CITY.roadHalf }
const curbwards = (p: XZ): XZ => { const o = offsets(p); return Math.abs(o.z) < Math.abs(o.x) ? { x: 0, z: o.z >= 0 ? 1 : -1 } : { x: o.x >= 0 ? 1 : -1, z: 0 } }
/** A walk through `pts` (city metres) at `speed`, standing at the last one: the operator's position at time t. */
const walkPath = (pts: readonly XZ[], speed: number) => (t: number): XZ => {
  let left = t * speed
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k], len = Math.hypot(b.x - a.x, b.z - a.z)
    if (left <= len) return { x: a.x + ((b.x - a.x) * left) / len, z: a.z + ((b.z - a.z) * left) / len }
    left -= len
  }
  return pts[pts.length - 1]
}
/**
 * The operator walking through room-local `pts` as the real avatar does (Rapier, its capsule and autostep, among the
 * room's glass and furniture) at `speed`: steering at each waypoint until there or held, then the next. Their position
 * at time t, as `walkPath` gives it.
 */
async function avatarPath(room: Workplace, pts: readonly (readonly [number, number])[], speed: number, limit: number): Promise<(t: number) => XZ> {
  const physics = await Physics.create([...room.shell, ...room.furniture].map((b) => b.box), { lamps: [], trees: [], signals: [] })
  const way = pathIn(room, pts), h = 1 / 60, out: XZ[] = []
  const a = new Avatar(physics, way[0].x, way[0].z)
  let k = 1, held = 0
  for (let t = 0; t < limit; t += h) {
    const goal = way[Math.min(k, way.length - 1)], dx = goal.x - a.x, dz = goal.z - a.z, d = Math.hypot(dx, dz), go = k < way.length && d > 0.05
    const was = { x: a.x, z: a.z }
    physics.step(h, (hh) => a.move(go ? (speed * dx) / d : 0, go ? (speed * dz) / d : 0, hh))
    out.push({ x: a.x, z: a.z })
    if (!go) { if (k < way.length) k++; continue }
    held = Math.hypot(a.x - was.x, a.z - was.z) < speed * h * 0.05 ? held + h : 0
    if (held > 0.5) { k++; held = 0 }
  }
  return (t) => out[Math.min(out.length - 1, Math.max(0, Math.round(t / h)))]
}
/** The flow field as CrowdSim keeps it: solved again whenever the operator stands in another cell. */
function fieldFor(grid: ReturnType<typeof cityGrid>): (at: XZ) => Float32Array {
  const cache = new Map<number, Float32Array>()
  return (at) => {
    const goal = nearestOpen(grid, at.x, at.z)
    let dir = cache.get(goal)
    if (!dir) cache.set(goal, (dir = solveFlow(grid, [goal]).dir))
    return dir
  }
}
interface Followed { talking: boolean[]; glass: boolean[]; me: XZ[]; at: XZ[]; end: XZ; broke: number; firstTalk: number }
/**
 * Someone asked over at `from`, the operator at `op` (standing, or walking it as a function of time), for `limit`
 * seconds: tethered (Active, hurrying at TETHER_PACE when behind) or not, at their own pace `base`, with people standing
 * still at `by`. Per frame, whether they are talking and whether the glass stands between them; when the tether
 * breaks (the operator more than RELEASE_DISTANCE away), and when they first talk. With `f32`, where they stand and
 * their velocity are kept in 32-bit floats from step to step, as the crowd buffer keeps them.
 */
function follow(grid: ReturnType<typeof cityGrid>, field: (at: XZ) => Float32Array, rooms: readonly Workplace[], from: XZ, op: XZ | ((t: number) => XZ), o: { limit: number; tethered?: boolean; base?: number; dt?: number; by?: readonly XZ[]; trail?: boolean; f32?: boolean }): Followed {
  const dt = o.dt ?? 1 / 60, base = o.base ?? 1.2, tethered = o.tethered ?? true
  let me = from, v = { x: 0, z: 0 }, w = 1, broke = -1, firstTalk = -1
  const out: Followed = { talking: [], glass: [], me: [], at: [], end: from, broke: -1, firstTalk: -1 }
  const trail = new OperatorTrail()
  for (let t = 0; t < o.limit; t += dt) {
    const at = typeof op === 'function' ? op(t) : op
    trail.update(at.x, at.z, true)
    const road = onRoad(me)
    const dist = Math.hypot(at.x - me.x, at.z - me.z), pane = glassBetween(rooms, me, at), glass = pane >= 0
    const seen = glassBetween(rooms, me, offLot(rooms, at), ROOM.pad - 0.05) < 0
    if (w < 1.5 && dist <= STOP && seen) w = 2
    else if (w > 1.5 && (dist > STOP * 1.5 || glass)) w = 1
    let desired: XZ
    if (w > 1.5) {
      const gap = dist - STOP, k = Math.abs(gap) > 0.2 ? Math.min(0.6, Math.max(-2.4, gap * 4)) : 0, d = dirTo(me, at)
      desired = { x: d.x * k, z: d.z * k }
    } else {
      const far = glass ? Math.max(dist, STOP + 2) : dist
      const pace = tethered ? Math.max(base, TETHER_PACE * Math.min(1, Math.max(0, (far - STOP) / 2))) : base
      const k = pace * Math.min(1, Math.max(0.25, far - STOP)), way = summonWay(grid, field(at), rooms, me, at, dist, pane, o.trail === false ? null : trail)
      desired = { x: way.x * k, z: way.z * k }
    }
    if (road) desired = { x: curbwards(me).x * base, z: curbwards(me).z * base }
    else {
      if (onRoad({ x: me.x + desired.x * 0.5, z: me.z })) desired = { x: 0, z: desired.z }
      if (onRoad({ x: me.x, z: me.z + desired.z * 0.5 })) desired = { x: desired.x, z: 0 }
    }
    let sx = 0, sz = 0
    for (const b of o.by ?? []) {
      const dx = me.x - b.x, dz = me.z - b.z, d2 = dx * dx + dz * dz
      if (d2 > 1e-6 && d2 < 0.64) { sx += dx / d2; sz += dz / d2 }
    }
    const m = Math.min(1, dt * 5)
    let nv = { x: v.x + (desired.x + sx * 0.8 - v.x) * m, z: v.z + (desired.z + sz * 0.8 - v.z) * m }
    const sp = Math.hypot(nv.x, nv.z)
    if (sp > 3) nv = { x: (nv.x * 3) / sp, z: (nv.z * 3) / sp }
    if (seen && dist > 1e-4 && dist < STOP) {
      const ux = (at.x - me.x) / dist, uz = (at.z - me.z) / dist, inward = nv.x * ux + nv.z * uz
      if (inward > 0) nv = { x: nv.x - ux * inward, z: nv.z - uz * inward }
    }
    if (!road) {
      if (onRoad({ x: me.x + nv.x * dt, z: me.z })) nv = { x: 0, z: nv.z }
      if (onRoad({ x: me.x, z: me.z + nv.z * dt })) nv = { x: nv.x, z: 0 }
    }
    const next = { x: me.x + nv.x * dt, z: me.z + nv.z * dt }
    const held = containAny(rooms, me, next)
    const rx = held.x - next.x, rz = held.z - next.z
    if (rx * rx + rz * rz > 1e-10) {
      const r = Math.hypot(rx, rz), into = (nv.x * rx + nv.z * rz) / r
      if (into < 0) nv = { x: nv.x - (rx / r) * into, z: nv.z - (rz / r) * into }
    }
    me = o.f32 ? { x: Math.fround(held.x), z: Math.fround(held.z) } : held
    v = o.f32 ? { x: Math.fround(nv.x), z: Math.fround(nv.z) } : nv
    out.talking.push(w > 1.5); out.glass.push(glass); out.me.push(me); out.at.push(at)
    if (w > 1.5 && firstTalk < 0) firstTalk = t
    if (broke < 0 && Math.hypot(at.x - me.x, at.z - me.z) > RELEASE_DISTANCE) broke = t
  }
  return { ...out, end: me, broke, firstTalk }
}
/** Talking/coming changes over the last `frames` frames. */
const flips = (f: Followed, frames: number) => f.talking.slice(-frames).reduce((n, x, k, a) => n + (k > 0 && x !== a[k - 1] ? 1 : 0), 0)
/** Room r's local waypoints in the city. */
const pathIn = (room: Workplace, pts: readonly (readonly [number, number])[]): XZ[] => pts.map(([u, v]) => toWorld(room, u, v))

test('real Rapier: the operator stands on an AGV dock (it autosteps the 0.3 m) and rests in a table\'s corner inside its 0.30 m band', async () => {
  const room = workplaces(1337).find((r) => r.kind === 'warehouse')!, board = workplaces(1337).find((r) => r.kind === 'boardroom')!
  const physics = await Physics.create([...room.shell, ...room.furniture, ...board.shell, ...board.furniture].map((b) => b.box), { lamps: [], trees: [], signals: [] })
  const walkTo = (a: Avatar, goal: XZ, seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 60) {
      const dx = goal.x - a.x, dz = goal.z - a.z, d = Math.hypot(dx, dz)
      physics.step(1 / 60, (hh) => a.move(d > 1e-3 ? (2 * dx) / d : 0, d > 1e-3 ? (2 * dz) / d : 0, hh))
    }
    for (let k = 0; k < 30; k++) physics.step(1 / 60, (hh) => a.move(0, 0, hh))
  }
  const docker = new Avatar(physics, toWorld(room, -5, 8).x, toWorld(room, -5, 8).z)
  walkTo(docker, toWorld(room, -5, 10), 2)
  const d = toLocal(room, docker.x, docker.z), feet = docker.body.translation().y - docker.person.halfHeight - docker.person.radius
  assert.ok(Math.abs(d.u + 5) < 0.05 && d.v > 9.8 && feet > 0.28, `on the dock: (${d.u.toFixed(3)}, ${d.v.toFixed(3)}), feet ${feet.toFixed(3)}`)
  const leaner = new Avatar(physics, toWorld(board, -0.5, 2.05).x, toWorld(board, -0.5, 2.05).z)
  walkTo(leaner, toWorld(board, -1.765, 2.05), 2)
  const c = toLocal(board, leaner.x, leaner.z)
  const off = { u: c.u + 2, v: c.v - 1.8 }
  assert.ok(off.u > 0 && off.u < 0.3 && off.v > 0 && off.v < 0.3 && Math.hypot(off.u, off.v) > PERSON.radius, `in the table's corner band: (${c.u.toFixed(3)}, ${c.v.toFixed(3)})`)
})

test('a recruit in tow reaches the operator who stops on an AGV dock or in a piece\'s corner, never turned back to the hub', () => {
  const rooms = workplaces(1337), grid = cityGrid(generateBuildings(1337).map((b) => b.box)), field = fieldFor(grid)
  for (const [kind, pts] of [
    ['warehouse', [[11, 0], [6, 8], [-5, 8], [-5, 9.97]]],
    ['boardroom', [[11, 0], [5, 3], [-0.5, 2.05], [-1.765, 2.05]]],
    ['boardroom', [[11, 0], [5, 3], [-0.5, 2.05], [-1.748, 2.05]]],
  ] as const) {
    const room = rooms.find((r) => r.kind === kind)!
    for (const dt of [1 / 30, 1 / 60, 1 / 120]) {
      const f = follow(grid, field, rooms, toWorld(room, 12, 1.5), walkPath(pathIn(room, pts), 2), { limit: 30, dt })
      const e = toLocal(room, f.end.x, f.end.z)
      assert.ok(f.broke < 0 && f.talking.at(-1), `${kind} to (${pts.at(-1)}), dt ${dt.toFixed(3)}: ${f.broke >= 0 ? `the tether broke at ${f.broke.toFixed(1)} s` : 'not talking'}, at (${e.u.toFixed(2)}, ${e.v.toFixed(2)})`)
    }
  }
})

test('a recruit in tow follows the operator into a dead end and round the end of a long piece, where no one corner opens', () => {
  const rooms = workplaces(1337), grid = cityGrid(generateBuildings(1337).map((b) => b.box)), field = fieldFor(grid)
  for (const [kind, pts, speed] of [
    ['warehouse', [[11, 0], [5, 8], [-3.2, 8.3], [-3.18, 9.57]], 5.2],
    ['roboticsLab', [[11, 0], [5.8, 11.1], [-11.75, 11.1], [-11.75, 8.6], [-10.5, 7.5]], 2],
  ] as const) {
    const room = rooms.find((r) => r.kind === kind)!
    const f = follow(grid, field, rooms, toWorld(room, 12.8, 0.3), walkPath(pathIn(room, pts), speed), { limit: 40 })
    const e = toLocal(room, f.end.x, f.end.z)
    assert.ok(f.broke < 0 && f.talking.at(-1), `${kind}: ${f.broke >= 0 ? `the tether broke at ${f.broke.toFixed(1)} s` : 'not talking'}, at (${e.u.toFixed(2)}, ${e.v.toFixed(2)})`)
  }
})

test('a recruit on a piece\'s face is never held on it by a line the containment refuses: the operator leaning on the next face', () => {
  const rooms = workplaces(1337), grid = cityGrid(generateBuildings(1337).map((b) => b.box)), field = fieldFor(grid)
  const room = rooms.find((r) => r.kind === 'boardroom')!
  // Walking there with the recruit behind, and standing there with the recruit coming from the table's far side.
  for (const [op, from] of [[walkPath(pathIn(room, [[-1.7, 9], [-1.68, 0.57]]), 2), [-2.8, 11.5]], [toWorld(room, -1.68, 0.57), [-2.85, 10.65]]] as const) {
    const f = follow(grid, field, rooms, toWorld(room, from[0], from[1]), op, { limit: 20 })
    const e = toLocal(room, f.end.x, f.end.z)
    assert.ok(f.talking.at(-1), `from (${from}): still coming at (${e.u.toFixed(3)}, ${e.v.toFixed(3)})`)
  }
})

test('a recruit in the doorway\'s band is judged the same a millimetre either side of its inner face: no talking through the jamb, no flip-flop', () => {
  const rooms = workplaces(1337), room = rooms[0], grid = cityGrid(generateBuildings(1337).map((b) => b.box)), field = fieldFor(grid)
  const op = toWorld(room, 13.4, -2.5)
  const inner = walled(rooms, toWorld(room, 12.499, -1.416), op), band = walled(rooms, toWorld(room, 12.501, -1.416), op)
  // One person standing still in the doorway; the recruit tethered from inside.
  const f = follow(grid, field, rooms, toWorld(room, 10, -1), op, { limit: 20, base: 1.1, by: [toWorld(room, 12.6, -0.9)] })
  const through = f.talking.filter((x, k) => x && throughGlass(room, f.me[k], f.at[k])).length
  assert.ok(inner && band && flips(f, 600) <= 2 && through === 0, `glass ${inner} inside the band's inner face, ${band} in the band; ${flips(f, 600)} flips in the last 10 s, ${through} frames talking through the jamb`)
})

test('an operator in the doorway\'s band is not talked to through the jamb\'s corner: the recruit outside comes round into the opening', () => {
  const rooms = workplaces(1337), room = rooms[0], grid = cityGrid(generateBuildings(1337).map((b) => b.box)), field = fieldFor(grid)
  // The reviewer's case: the recruit outside beside the jamb, the operator in the band 0.4 m inside the opening's edge.
  const f = follow(grid, field, rooms, toWorld(room, 13.5, -4), toWorld(room, 12.6, -1.6), { limit: 15 })
  const through = f.talking.filter((x, k) => x && throughGlass(room, f.me[k], f.at[k])).length
  assert.ok(through === 0 && f.talking.at(-1), `${through} frames talking through the jamb; talking at the end: ${f.talking.at(-1)}`)
  // By either jamb, the operator anywhere in the band a body fits (|v| up to the opening's 2 m less its 0.3 m radius),
  // and the other way round: the recruit in the band, the operator outside beside the jamb. Every one comes round the
  // jamb's corner into the opening, and nobody talks through it.
  const fails: string[] = []
  let runs = 0
  for (const s of [1, -1]) {
    for (const [bu, bv] of [[12.55, 0.5], [12.6, 1.2], [12.6, 1.6], [12.75, 1.7], [12.95, 1.65]]) {
      for (const [ou, ov] of [[13.5, 4], [13.4, 2.6], [14.2, 3], [13.4, 6], [15, 2.2]]) {
        for (const operatorInBand of [true, false]) {
          const band = toWorld(room, bu, bv * s), out = toWorld(room, ou, ov * s)
          const g = follow(grid, field, rooms, operatorInBand ? out : band, operatorInBand ? band : out, { limit: 15 })
          const n = g.talking.filter((x, k) => x && throughGlass(room, g.me[k], g.at[k])).length
          runs++
          if (n > 0 || !g.talking.at(-1)) {
            const e = toLocal(room, g.end.x, g.end.z)
            fails.push(`${operatorInBand ? 'operator' : 'recruit'} in the band at (${bu}, ${bv * s}), the other at (${ou}, ${ov * s}): ${n} frames through the jamb, ${g.talking.at(-1) ? 'talking' : 'still coming'} at (${e.u.toFixed(2)}, ${e.v.toFixed(2)})`)
          }
        }
      }
    }
  }
  assert.equal(fails.length, 0, `${fails.length} of ${runs}: ${fails.slice(0, 6).join('; ')}`)
})

test('a recruit who ran behind comes round the lot\'s corner to the operator standing against the room\'s side wall', () => {
  let runs = 0, pinned = 0
  const fails: string[] = []
  for (const seed of [1337, 42]) {
    const rooms = workplaces(seed), grid = cityGrid(generateBuildings(seed).map((b) => b.box)), field = fieldFor(grid)
    for (const room of rooms) {
      for (const side of [1, -1]) {
        for (const stopU of [5, 8.5, 12]) {
          for (const sv of [13.3, 13.35, 13.5]) {
            const pts = pathIn(room, [[10, 0], [12.75, 0], [14.2, 0], [14.2, 14.2 * side], [stopU, sv * side]])
            const f = follow(grid, field, rooms, toWorld(room, 9, side), walkPath(pts, 5.2), { limit: 40 })
            runs++
            if (!f.talking.at(-1)) { pinned++; const e = toLocal(room, f.end.x, f.end.z); fails.push(`${room.kind} seed ${seed} to (${stopU}, ${sv * side}): at (${e.u.toFixed(2)}, ${e.v.toFixed(2)})`) }
          }
        }
      }
    }
  }
  assert.equal(pinned, 0, `${pinned} of ${runs} pinned: ${fails.slice(0, 6).join('; ')}`)
})

test('a recruit the corner way brings to a piece\'s corner goes on from it: from there the straight line brushes the piece inside the containment\'s reach, the corner\'s own leg on does not', () => {
  // The reviewer's spots, every room kind: the operator standing still (room-local u, v), the recruit in tow from where
  // the crowd stands, at their own pace and step. Each stood on the corner for good, the way on refused at `held`.
  const cases = [
    [1337, 'roboticsLab', [1.175, 5.234], [6.476, 11.967], 1 / 30, 1.29],
    [1337, 'warehouse', [-0.66, 11.369], [2.474, 4.542], 1 / 30, 1.344],
    [1337, 'clinic', [-3.809, -5.303], [3.043, -10.247], 1 / 60, 1.201],
    [2026, 'roboticsLab', [4.788, 7.24], [5.394, 1.133], 1 / 30, 1.328],
    [2026, 'warehouse', [2.037, 9.089], [11.193, 6.486], 1 / 30, 1.498],
    [2026, 'warehouse', [-0.235, 11.058], [0.951, 1.265], 1 / 30, 1.365],
    [42, 'roboticsLab', [5.287, 10.718], [5.108, 0.048], 1 / 30, 1.192],
    [42, 'legalChambers', [1.125, -7.72], [7.006, -5.341], 1 / 60, 1.34],
    [42, 'telemetryCommand', [-1.622, -8.107], [-3.948, -3.243], 1 / 30, 1.208],
    [7, 'boardroom', [3.869, -1.476], [-1.684, 6.21], 1 / 60, 1.431],
    [2026, 'telemetryCommand', [-7.477, 5.177], [-9.493, 8.13], 1 / 30, 1.347],
    [42, 'telemetryCommand', [-2.399, -11.08], [5.895, -6.355], 1 / 30, 1.382],
    [7, 'legalChambers', [-3.415, -5.262], [-0.962, -11.131], 1 / 30, 1.45],
    [7, 'legalChambers', [-11.01, -5.466], [-3.601, -3.007], 1 / 30, 1.35],
  ] as const
  const worlds = new Map<number, { rooms: Workplace[]; grid: ReturnType<typeof cityGrid>; field: (at: XZ) => Float32Array }>()
  const fails: string[] = []
  for (const [seed, kind, [ou, ov], [ru, rv], dt, base] of cases) {
    let w = worlds.get(seed)
    if (!w) {
      const grid = cityGrid(generateBuildings(seed).map((b) => b.box))
      worlds.set(seed, (w = { rooms: workplaces(seed), grid, field: fieldFor(grid) }))
    }
    const room = w.rooms.find((r) => r.kind === kind)!
    const f = follow(w.grid, w.field, w.rooms, toWorld(room, ru, rv), toWorld(room, ou, ov), { limit: 40, dt, base })
    const e = toLocal(room, f.end.x, f.end.z)
    if (f.broke >= 0 || !f.talking.at(-1)) fails.push(`${seed} ${kind} (${ru}, ${rv}) to (${ou}, ${ov}): ${f.broke >= 0 ? 'the tether broke' : 'still coming'} at (${e.u.toFixed(2)}, ${e.v.toFixed(2)})`)
  }
  assert.equal(fails.length, 0, `${fails.length} of ${cases.length}: ${fails.slice(0, 6).join('; ')}`)
})

test('a recruit in tow never takes the operator\'s trail over an AGV dock: the operator steps over one, or walks along the row, and the recruit goes round', () => {
  // The operator autosteps the docks' 0.3 m (the Rapier test above); the crowd's containment holds everyone off them.
  // The reviewer's walks in the warehouse: over dock 3 and stopping behind it, along the row and away (stopping at
  // three points on the way), and over dock 2 and on behind the row.
  const fails: string[] = []
  let runs = 0
  for (const seed of [1337, 7]) {
    const rooms = workplaces(seed), grid = cityGrid(generateBuildings(seed).map((b) => b.box)), field = fieldFor(grid)
    const room = rooms.find((r) => r.kind === 'warehouse')!
    for (const pts of [
      [[14, 0], [12, 0], [6, 8], [3, 8], [3, 11.5]],
      [[12, 0], [6, 8], [5.5, 9.9], [-3, 9.9], [-3, 8]],
      [[12, 0], [6, 8], [5.5, 9.9], [-3, 9.9], [-3, 8], [-6.5, 8.5]],
      [[12, 0], [6, 8], [5.5, 9.9], [-3, 9.9], [-3, 8], [-9.69, 6.72]],
      [[12, 0], [6, 8], [-1, 8], [-1, 11.6], [-3, 11.6]],
    ] as const) {
      for (const dt of [1 / 30, 1 / 60]) {
        const f = follow(grid, field, rooms, toWorld(room, 14.5, 1.2), walkPath(pathIn(room, pts), 2), { limit: 40, dt })
        runs++
        if (f.broke >= 0 || !f.talking.at(-1)) {
          const e = toLocal(room, f.end.x, f.end.z)
          fails.push(`seed ${seed} to (${pts.at(-1)}), dt ${dt.toFixed(3)}: ${f.broke >= 0 ? `the tether broke at ${f.broke.toFixed(1)} s` : 'still coming'} at (${e.u.toFixed(2)}, ${e.v.toFixed(2)})`)
        }
      }
    }
  }
  assert.equal(fails.length, 0, `${fails.length} of ${runs}: ${fails.slice(0, 6).join('; ')}`)
})

test('the trail still leads round the end of a long piece the operator rounds close: a body goes round a corner on an arc, its trail cuts the corner', () => {
  // The operator's capsule slides round the end of the robotics lab's rack and of the warehouse's conveyor 0.32 m off
  // it; the trail's line between the spots either side cuts the corner's square grown 0.30 m, though not the piece.
  const fails: string[] = []
  let runs = 0
  for (const seed of [1337, 7]) {
    const rooms = workplaces(seed), grid = cityGrid(generateBuildings(seed).map((b) => b.box)), field = fieldFor(grid)
    for (const [kind, pts] of [
      ['roboticsLab', [[11, 0], [5.8, 11.2], [-11.32, 11.2], [-11.32, 9.6], [-11.23, 9.37], [-11, 9.28], [-10.5, 8]]],
      ['warehouse', [[11, 0], [0, 4.9], [-10, 4.9], [-10.23, 4.97], [-10.32, 5.2], [-10.32, 6.4], [-10.23, 6.63], [-10, 6.72], [-9, 7.2]]],
    ] as const) {
      const room = rooms.find((r) => r.kind === kind)!
      for (const dt of [1 / 30, 1 / 60, 1 / 120]) {
        const f = follow(grid, field, rooms, toWorld(room, 12.8, 0.3), walkPath(pathIn(room, pts), 2), { limit: 40, dt })
        runs++
        if (f.broke >= 0 || !f.talking.at(-1)) {
          const e = toLocal(room, f.end.x, f.end.z)
          fails.push(`${kind} seed ${seed}, dt ${dt.toFixed(3)}: ${f.broke >= 0 ? `the tether broke at ${f.broke.toFixed(1)} s` : 'still coming'} at (${e.u.toFixed(2)}, ${e.v.toFixed(2)})`)
        }
      }
    }
  }
  assert.equal(fails.length, 0, `${fails.length} of ${runs}: ${fails.slice(0, 6).join('; ')}`)
})

test('a recruit in tow is never led into a gap\'s mouth on a line the containment refuses: the operator rounds a table into a 1 m gap, or the conveyor\'s end', async () => {
  // The trail round the table's corner passes through no piece, so it leads; the straight line on from the gap's mouth
  // runs 0.32 m off the table's side, which the containment's 0.35 m will not let anyone walk.
  const fails: string[] = []
  let runs = 0
  for (const seed of [1337, 42]) {
    const rooms = workplaces(seed), grid = cityGrid(generateBuildings(seed).map((b) => b.box)), field = fieldFor(grid)
    for (const [kind, pts] of [
      ['roboticsLab', [[11, 0], [11, 3.6], [-11, 3.6], [-11, 4.4], [-7.18, 7.3]]],
      ['warehouse', [[11, 0], [11, 3], [-10.49, 5.22], [-9.45, 4.56], [-10.29, 7.44]]],
    ] as const) {
      const room = rooms.find((r) => r.kind === kind)!, op = await avatarPath(room, pts, 2, 50)
      for (const dt of [1 / 30, 1 / 60]) {
        const f = follow(grid, field, rooms, toWorld(room, 12.8, 0.3), op, { limit: 50, dt })
        runs++
        if (f.broke >= 0 || !f.talking.at(-1)) {
          const e = toLocal(room, f.end.x, f.end.z), o = toLocal(room, f.at.at(-1)!.x, f.at.at(-1)!.z)
          fails.push(`${kind} seed ${seed}, dt ${dt.toFixed(3)}: ${f.broke >= 0 ? 'the tether broke' : 'still coming'} at (${e.u.toFixed(2)}, ${e.v.toFixed(2)}), the operator at (${o.u.toFixed(2)}, ${o.v.toFixed(2)})`)
        }
      }
    }
  }
  assert.equal(fails.length, 0, `${fails.length} of ${runs}: ${fails.slice(0, 6).join('; ')}`)
})

test('a recruit in tow comes to an operator in the nook between a piece\'s end and the glass, where the spot off the piece level with them is past the floor\'s reach', async () => {
  // The legal chambers' long piece stands 0.2 m off the back glass; the operator's capsule rests 0.32 m off both.
  const fails: string[] = []
  let runs = 0
  for (const seed of [1337, 42]) {
    const rooms = workplaces(seed), grid = cityGrid(generateBuildings(seed).map((b) => b.box)), field = fieldFor(grid)
    const room = rooms.find((r) => r.kind === 'legalChambers')!
    for (const s of [1, -1]) {
      for (const d of [0.05, 0.25]) {
        const op = await avatarPath(room, [[11, 0], [11, 4.6 * s], [-9, 6.5 * s], [-12.6, 6.5 * s], [-12.6, (4 + d) * s]], 2, 40)
        const f = follow(grid, field, rooms, toWorld(room, 12.8, 0.3), op, { limit: 40 })
        runs++
        if (f.broke >= 0 || !f.talking.at(-1)) {
          const e = toLocal(room, f.end.x, f.end.z), o = toLocal(room, f.at.at(-1)!.x, f.at.at(-1)!.z)
          fails.push(`seed ${seed}, side ${s}, ${d} m: ${f.broke >= 0 ? 'the tether broke' : 'still coming'} at (${e.u.toFixed(2)}, ${e.v.toFixed(2)}), the operator at (${o.u.toFixed(2)}, ${o.v.toFixed(2)})`)
        }
      }
    }
  }
  assert.equal(fails.length, 0, `${fails.length} of ${runs}: ${fails.slice(0, 6).join('; ')}`)
})

test('by a lot with nothing on it, a recruit talks from the face its containment holds them on: an operator up to 1.149 m inside it, straight in or by a corner', () => {
  const rooms = workplaces(1337), grid = cityGrid(generateBuildings(1337).map((b) => b.box)), field = fieldFor(grid)
  const fails: string[] = []
  let runs = 0
  for (const k of [3, 8]) {
    const c = { x: (k + 0.5) * CITY.pitch, z: (CITY.blocks - 0.5) * CITY.pitch }
    for (const [sx, sz, swap] of [[1, 1, false], [-1, -1, false], [1, 1, true], [-1, 1, true]] as const) {
      const at = (x: number, z: number): XZ => (swap ? { x: c.x + sx * z, z: c.z + sz * x } : { x: c.x + sx * x, z: c.z + sz * z })
      const local = (p: XZ) => (swap ? { x: (p.z - c.z) * sz, z: (p.x - c.x) * sx } : { x: (p.x - c.x) * sx, z: (p.z - c.z) * sz })
      const walks: [string, XZ, (t: number) => XZ, number][] = []
      // Straight in from the east lane, mid-face, 1.10 to 1.149 m: the face 1.499 m from them at the deepest, so the
      // recruit has to come right onto it, never easing to a stop a few millimetres short where a step at 120 or 144
      // frames a second is less than a 32-bit float's spacing.
      for (const d of [1.1, 1.12, 1.14]) walks.push([`${d} m in`, at(14.2, -11.5), walkPath([at(14.2, -9), at(14.2, -3), at(13 - d, -3)], 2), 1 / 60])
      for (const d of [1.146, 1.149]) for (const hz of [60, 120, 144]) walks.push([`${d} m in at ${hz} Hz`, at(14.2, -11.5), walkPath([at(14.2, -9), at(14.2, -3), at(13 - d, -3)], 2), 1 / hz])
      // By the corner, 1.10 to 1.125 m in from the east face and a little less from the south one.
      for (const [x, z] of [[11.9, 12], [11.875, 11.9]]) walks.push([`(${x}, ${z})`, at(14.2, 3.5), walkPath([at(14.2, 6), at(14.2, 12), at(x, z)], 2), 1 / 60])
      for (const [name, from, op, dt] of walks) {
        for (const tethered of [false, true]) {
          const f = follow(grid, field, rooms, from, op, { limit: 25, tethered, base: 1.1, dt, f32: true })
          runs++
          if (f.firstTalk < 0 || f.firstTalk > APPROACH_SECONDS) fails.push(`lot ${k} (${sx}, ${sz})${swap ? ' turned' : ''} ${name}${tethered ? ' in tow' : ''}: ${f.firstTalk < 0 ? 'never talked' : `talked at ${f.firstTalk.toFixed(1)} s`}, at (${local(f.end).x.toFixed(3)}, ${local(f.end).z.toFixed(3)})`)
        }
      }
      // Out of reach 5.6 m inside, the recruit held on the face at the last stretch's 6 m stands still.
      for (const d of [5.6, 5.63, 5.65]) {
        const f = follow(grid, field, rooms, at(14.2, -11.5), walkPath([at(14.2, -9), at(14.2, -3), at(13 - d, -3)], 2), { limit: 30 })
        runs++
        const tail = f.me.slice(-300)
        let reversals = 0
        for (let i = 2; i < tail.length; i++) {
          const a = { x: tail[i - 1].x - tail[i - 2].x, z: tail[i - 1].z - tail[i - 2].z }, b = { x: tail[i].x - tail[i - 1].x, z: tail[i].z - tail[i - 1].z }
          if (Math.hypot(a.x, a.z) > 1e-4 && Math.hypot(b.x, b.z) > 1e-4 && a.x * b.x + a.z * b.z < 0) reversals++
        }
        if (reversals > 3) fails.push(`lot ${k} (${sx}, ${sz})${swap ? ' turned' : ''} ${d} m in: ${reversals} reversals in the last 5 s`)
      }
    }
  }
  assert.equal(fails.length, 0, `${fails.length} of ${runs}: ${fails.slice(0, 6).join('; ')}`)
})

test('by a lot with nothing on it, a recruit goes round its corner to an operator in reach of the far face, or walking back to the near one, whatever the distance', () => {
  const rooms = workplaces(2026), grid = cityGrid(generateBuildings(2026).map((b) => b.box)), field = fieldFor(grid)
  const fails: string[] = []
  let runs = 0
  for (const k of [3, 8, 11]) {
    const c = { x: (k + 0.5) * CITY.pitch, z: (CITY.blocks - 0.5) * CITY.pitch }
    for (const [sx, sz, swap] of [[1, 1, false], [-1, -1, false], [1, 1, true], [-1, 1, true]] as const) {
      const at = (x: number, z: number): XZ => (swap ? { x: c.x + sx * z, z: c.z + sz * x } : { x: c.x + sx * x, z: c.z + sz * z })
      const local = (p: XZ) => (swap ? { x: (p.z - c.z) * sz, z: (p.x - c.x) * sx } : { x: (p.x - c.x) * sx, z: (p.z - c.z) * sz })
      // The operator 0.4 m inside the far face, its shared corner just over the last stretch's 6 m from them.
      for (const [x, z] of [[7.4, 12.6], [7.45, 12.5]]) {
        const f = follow(grid, field, rooms, at(14.2, 6), at(x, z), { limit: 30 })
        runs++
        if (!f.talking.at(-1)) fails.push(`lot ${k} (${sx}, ${sz})${swap ? ' turned' : ''} to (${x}, ${z}): ${f.broke >= 0 ? 'the tether broke' : 'still coming'} at (${local(f.end).x.toFixed(2)}, ${local(f.end).z.toFixed(2)})`)
      }
      // The operator in by a corner, a few metres towards the side face, then back along the face they came in by.
      for (const [ax, bz, x2] of [[9.5, 4, -3], [9.5, 4, 0], [8, 6, -3]]) {
        const f = follow(grid, field, rooms, at(-12.6, 15), walkPath([at(-11.2, 14.6), at(-11.2, 12.9), at(-ax, bz), at(-5, 12.7), at(x2, 12.6)], 2), { limit: 30 })
        runs++
        if (!f.talking.at(-1)) fails.push(`lot ${k} (${sx}, ${sz})${swap ? ' turned' : ''} in to (-${ax}, ${bz}) and back to (${x2}, 12.6): ${f.broke >= 0 ? 'the tether broke' : 'still coming'} at (${local(f.end).x.toFixed(2)}, ${local(f.end).z.toFixed(2)})`)
      }
    }
  }
  assert.equal(fails.length, 0, `${fails.length} of ${runs}: ${fails.slice(0, 6).join('; ')}`)
})

test('the last stretch by a lot with nothing on it talks from the recruit\'s own face when the operator is in reach of it, and never shuffles at its 6 m edge', () => {
  const rooms = workplaces(1337), grid = cityGrid(generateBuildings(1337).map((b) => b.box)), field = fieldFor(grid)
  const fails: string[] = []
  let runs = 0
  for (const k of [3, 8, 13]) {
    const c = { x: (k + 0.5) * CITY.pitch, z: (CITY.blocks - 0.5) * CITY.pitch }
    for (const [sx, sz, swap] of [[1, 1, false], [-1, -1, false], [1, 1, true], [-1, 1, true]] as const) {
      const at = (x: number, z: number): XZ => (swap ? { x: c.x + sx * z, z: c.z + sz * x } : { x: c.x + sx * x, z: c.z + sz * z })
      const local = (p: XZ) => (swap ? { x: (p.z - c.z) * sz, z: (p.x - c.x) * sx } : { x: (p.x - c.x) * sx, z: (p.z - c.z) * sz })
      // The reviewer's walk: the operator asks someone 2.5 m along the east lane, walks on round the corner and stops
      // in the park a metre in from both faces, a little nearer the far one. Asked fresh, at the slowest own pace, the
      // recruit talks from the east face inside the summons' time; in tow, as soon.
      for (const [stopX, stopZ] of [[11.97, 12.2], [12.1, 12.25], [12.25, 12.4]]) {
        for (const tethered of [false, true]) {
          const f = follow(grid, field, rooms, at(14.2, 3.5), walkPath([at(14.2, 6), at(14.2, 12.2), at(stopX, stopZ)], 2), { limit: 25, tethered, base: 1.1 })
          runs++
          if (f.firstTalk < 0 || f.firstTalk > (tethered ? 10 : APPROACH_SECONDS)) {
            const e = local(f.end)
            fails.push(`lot ${k} (${sx}, ${sz})${swap ? ' turned' : ''} to (${stopX}, ${stopZ})${tethered ? ' in tow' : ''}: ${f.firstTalk < 0 ? 'never talked' : `talked at ${f.firstTalk.toFixed(1)} s`}, at (${e.x.toFixed(2)}, ${e.z.toFixed(2)})`)
          }
        }
      }
      // The operator 4-5 m inside the park, out of reach of every face: the recruit stands still on the face, as
      // before, never turning back and forth between the corner and the field's arrow at the last stretch's 6 m.
      for (const [stopX, stopZ] of [[8, 10], [8.5, 9.5], [9, 10.5]]) {
        const f = follow(grid, field, rooms, at(14.2, -6.5), walkPath([at(14.2, -4), at(14.2, 10), at(stopX, stopZ)], 2), { limit: 30 })
        runs++
        const tail = f.me.slice(-300)
        let reversals = 0
        for (let i = 2; i < tail.length; i++) {
          const a = { x: tail[i - 1].x - tail[i - 2].x, z: tail[i - 1].z - tail[i - 2].z }, b = { x: tail[i].x - tail[i - 1].x, z: tail[i].z - tail[i - 1].z }
          if (Math.hypot(a.x, a.z) > 1e-4 && Math.hypot(b.x, b.z) > 1e-4 && a.x * b.x + a.z * b.z < 0) reversals++
        }
        if (reversals > 3) fails.push(`lot ${k} (${sx}, ${sz})${swap ? ' turned' : ''} to (${stopX}, ${stopZ}): ${reversals} reversals in the last 5 s at (${local(f.end).x.toFixed(3)}, ${local(f.end).z.toFixed(3)}), ${Math.hypot(f.end.x - f.at.at(-1)!.x, f.end.z - f.at.at(-1)!.z).toFixed(3)} m away`)
      }
    }
  }
  assert.equal(fails.length, 0, `${fails.length} of ${runs}: ${fails.slice(0, 6).join('; ')}`)
})

test('on the street, the last stretch round a lot with nothing on it goes by its corner: the field walks across a park, the containment holds everyone out of it', () => {
  // The reviewer's walk by park lot (8, 15) at (340, 620): along the lot's east lane and into the park just past its
  // corner, the recruit tethered behind. The same at every corner of every park lot of seed 1337, both ways round.
  const rooms = workplaces(1337), grid = cityGrid(generateBuildings(1337).map((b) => b.box)), field = fieldFor(grid)
  const fails: string[] = []
  let runs = 0
  for (let k = 0; k < CITY.blocks; k++) {
    const c = { x: (k + 0.5) * CITY.pitch, z: (CITY.blocks - 0.5) * CITY.pitch }
    assert.equal(districtOfLot(k, CITY.blocks - 1), 'park')
    for (const [sx, sz, swap] of [[1, 1, false], [1, -1, false], [-1, 1, false], [-1, -1, false], [1, 1, true], [1, -1, true], [-1, 1, true], [-1, -1, true]] as const) {
      const at = (x: number, z: number): XZ => (swap ? { x: c.x + sx * z, z: c.z + sz * x } : { x: c.x + sx * x, z: c.z + sz * z })
      const f = follow(grid, field, rooms, at(14.2, -3.5), walkPath([at(14.2, -2), at(14.2, 9), at(11.91, 11.98)], 2), { limit: 30 })
      runs++
      if (f.broke >= 0 || !f.talking.at(-1)) fails.push(`lot ${k} corner (${sx}, ${sz})${swap ? ' turned' : ''}: ${f.broke >= 0 ? 'the tether broke' : 'still coming'} at (${(f.end.x - c.x).toFixed(2)}, ${(f.end.z - c.z).toFixed(2)})`)
    }
  }
  assert.equal(fails.length, 0, `${fails.length} of ${runs}: ${fails.slice(0, 6).join('; ')}`)
})

test('the commute: the workplace corner is on the doorway street, on the room\'s block, and the door front lies along its lane', () => {
  for (const seed of SEEDS) {
    for (const room of workplaces(seed)) {
      const c = targetCorner(room)
      const front = doorFront(room)
      const alongX = room.side === 0 || room.side === 1
      assert.ok(alongX ? Math.abs(c.z - front.z) < 1e-9 : Math.abs(c.x - front.x) < 1e-9, `${room.kind}: the corner and the door front share the lane`)
      // The corner is on the room's own block: between the lot's streets on the other axis.
      const k = Math.floor(room.cx / CITY.pitch), m = Math.floor(room.cz / CITY.pitch)
      assert.ok(alongX ? c.x > k * CITY.pitch && c.x < (k + 1) * CITY.pitch : c.z > m * CITY.pitch && c.z < (m + 1) * CITY.pitch)
      // And on the doorway's street.
      const d = doorDir(room.side)
      const street = alongX ? (d.z > 0 ? m + 1 : m) * CITY.pitch : (d.x > 0 ? k + 1 : k) * CITY.pitch
      assert.ok(Math.abs((alongX ? Math.abs(c.z - street) : Math.abs(c.x - street)) - CITY.lane) < 1e-9)
    }
  }
})

test('the uniform: six slots of a, b, furniture and stations as vec4s, zero where a slot is empty, all zero with no rooms', () => {
  const rooms = workplaces(42)
  const f = packRooms(rooms)
  assert.equal(f.length, ROOMS_FLOATS)
  assert.equal(ROOM_FLOATS, 8 + 4 * ROOM.furniture + 4 * ROOM.stations)
  rooms.forEach((room, r) => {
    const o = r * ROOM_FLOATS
    assert.deepEqual([...f.subarray(o, o + 6)], [room.cx, room.cz, room.side, 1, ROOM.hub, room.furniture.length])
    room.furniture.forEach(({ box }, i) => assert.deepEqual([...f.subarray(o + 8 + i * 4, o + 12 + i * 4)], [box[0], box[2], box[3], box[5]].map(Math.fround)))
    for (let i = room.furniture.length; i < ROOM.furniture; i++) assert.ok(f.subarray(o + 8 + i * 4, o + 12 + i * 4).every((v) => v === 0))
    room.stations.forEach((s, i) => {
      const at = o + 8 + ROOM.furniture * 4 + i * 4
      assert.deepEqual([...f.subarray(at, at + 4)].map(Math.fround), [s.u, s.v, s.yaw, 1].map(Math.fround))
    })
  })
  assert.ok(packRooms([]).every((v) => v === 0))
  assert.ok(packRooms(rooms.slice(0, 2)).subarray(2 * ROOM_FLOATS).every((v) => v === 0))
  assert.throws(() => packRooms([...rooms, rooms[0]]), RangeError)
})

test('the workday\'s dice: a share of the crowd that gives each station about WORK.perStation people, spread over every slot; on shift WORK.shift of every WORK.cycle', () => {
  const stations = ROOM.slots * ROOM.stations
  for (const N of [256, 4096, 14000, 60000]) {
    const oneIn = workOneIn(N)
    assert.ok(Number.isInteger(oneIn) && oneIn >= WORK.minOneIn)
    let workers = 0
    for (let i = 1; i < N; i++) {
      const s = workerSlot(i, N)
      if (s < 0) continue
      workers++
      assert.ok(s >= 0 && s < stations)
    }
    const share = workers / N
    assert.ok(share > 0.6 / oneIn && share < 1.5 / oneIn, `${N}: ${workers} workers, one in ${oneIn}`)
    // Never a crowded room: at most about two people per station over the day (so about one at once), whatever the crowd.
    assert.ok(workers <= 2.2 * stations, `${N}: ${workers} workers for ${stations} stations`)
    if (N >= 4096) assert.ok(workers >= 0.9 * stations, `${N}: ${workers} workers fill the ${stations} stations`)
  }
  // Dealt, not drawn: with at least as many workers as stations, every station has somebody, and none has two more
  // than another; the player's own body (index 0) never works.
  for (const N of [4096, 14000, 60000]) {
    const per = new Array<number>(stations).fill(0)
    for (let i = 0; i < N; i++) { const s = workerSlot(i, N); if (s >= 0) per[s]++ }
    assert.ok(Math.min(...per) >= 1 && Math.max(...per) - Math.min(...per) <= 1, `${N}: ${per.join(' ')}`)
  }
  assert.equal(workerSlot(0, 14000), -1)
  // An odd stride: the workers wear every one of the crowd's four bodies (cull: i % 4).
  const bodies = new Set<number>()
  for (let i = 0; i < 14000; i++) if (workerSlot(i, 14000) >= 0) bodies.add(i % 4)
  assert.equal(bodies.size, 4)
  let on = 0
  const T = 2000
  for (let i = 1; i < 400; i++) for (let t = 0; t < T; t += 10) if (onDuty(i, t)) on++
  const duty = on / (399 * (T / 10))
  assert.ok(Math.abs(duty - WORK.shift / WORK.cycle) < 0.05, `on duty ${(duty * 100).toFixed(1)} %`)
  assert.equal(workerSlot(7, 14000), workerSlot(7, 14000), 'the same person, the same station')
})

test('the shader carries the same numbers: ROOM_*, WORK_* and the workday in crowd.wgsl', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../03_Spawn_Agents/crowd.wgsl', import.meta.url), 'utf8')
  for (const name of ['fn containRoom(', 'fn contain(', 'fn roomOf(', 'fn workerSlot(', 'fn onDuty(', 'fn towardCorner(', 'fn commuteCorner(', 'fn targetCorner(', 'fn doorFront(', 'rooms: array<Room, ROOM_SLOTS>', 'routes: array<vec4u, ROUTE_VEC4S>']) {
    assert.ok(src.includes(name), name)
  }
  assert.ok(src.includes('let held = contain(me, next, 0.35, mayEnter || asked);'), 'every step is contained, the doorway open to the workday and the summons')
  assert.ok(src.includes('if (into < 0.0) { nv -= wallN * into; }'), 'the refused part of a step leaves the velocity: the slide')
  // Someone inside a room on the corner graph walks out first, before the shift's dice can start a commute (a worker
  // let go indoors on shift would otherwise walk the corner graph into the glass for good), along the nearer aisle.
  const rescue = src.indexOf('let here = indoors(me);')
  assert.ok(rescue > 0 && rescue < src.indexOf('if (phase < 0.5 && duty && (!routed(room) || routeWay(room, nearestLines(b.a.xy)) != 0u)) { phase = WORK_COMMUTE; }'), 'the indoor exit runs before the duty promotion')
  assert.ok(src.includes('if (phase < 1.5) {') && src.includes('row = select(-ROOM_AISLE, ROOM_AISLE, roomLocal(room, me).y >= 0.0);'))
  assert.ok(src.includes('dest = roomWorld(room, vec2f(P.rooms[room].b.x, row));'), 'the leaving row is the one carried in b.d.z')
  assert.ok(src.includes('b.d = vec4f(phase, f32(room), row, 0.0);'))
  assert.ok(src.includes('if (phase > 4.5 && phase < 6.5) { dest = station; arrive = WORK_SEAT; }'), 'the station is reached at WORK.seat')
  // A recruit comes round a room's furniture, and round by its doorway when its glass stands between them and the
  // operator, never talking through it: the lines the summons mirror above copies.
  for (const line of [
    'let pane = glassBetween(me, at, 0.0);',
    'glass = pane >= 0;',
    'seen = glassBetween(me, offLot(at), ROOM_PAD - 0.05) < 0;',
    'if (b.b.w < 1.5 && dist <= SUMMON_STOP && seen) {',
    '} else if (b.b.w > 1.5 && (dist > SUMMON_STOP * 1.5 || glass)) {',
    'let far = select(dist, max(dist, SUMMON_STOP + 2.0), glass);',
    'desired = summonWay(me, at, dist, pane) * pace * clamp(far - SUMMON_STOP, 0.25, 1.0);',
    'if (asked && seen) {',
    'case 0u: { return vec4f(-h, -h, -i, h); }',
    'case 1u: { return vec4f(-i, -h, i, -i); }',
    'case 2u: { return vec4f(-i, i, i, h); }',
    'case 3u: { return vec4f(i, -h, h, -ROOM_DOOR); }',
    'default: { return vec4f(i, ROOM_DOOR, h, h); }',
    'if (hitsBox(p, d, g.xy - pad, g.zw + pad)) { return true; }',
    'if (a >= 0 && crossesGlass(u32(a), p, q, pad)) { return a; }',
    'if (b >= 0 && b != a && crossesGlass(u32(b), p, q, pad)) { return b; }',
    'fn walled(p: vec2f, q: vec2f) -> bool { return glassBetween(p, q, 0.0) >= 0; }',
    'let follow = P.trailCount > 0u && distance(P.trail[0].xy, at) < TRAIL_NEAR;',
    'if (mine >= 0 && mine == theirs) { return roomWay(u32(mine), me, at, follow, true); }',
    'if (mine != theirs || pane >= 0) {',
    'let r = u32(select(select(pane, theirs, theirs >= 0), mine, mine >= 0));',
    'if (abs(l.y) < ROOM_DOOR + 1.5 && l.x > CITY_LOT_HALF - ROOM_WALL - 1.5 && l.x < front + 1.0 && (mine != theirs || l.x < CITY_LOT_HALF)) {',
    'return dirTo(me, roomWorld(r, vec2f(select(front, P.rooms[r].b.x, mine < 0 && theirs == i32(r)), 0.0)));',
    'if (mine >= 0) { return roomWay(r, me, roomWorld(r, vec2f(P.rooms[r].b.x + 1.0, select(-ROOM_AISLE, ROOM_AISLE, l.y >= 0.0))), follow, false); }',
    'if (here >= 0) { flow = flowAt(me + offGlass(u32(here), me) / FLOW_INV_CELL); }',
    'let goal = offLot(at);',
    'let onto = select(goal, pushOut(at, ROOM_PAD - 0.25), roomOf(at) < 0);',
    'let pad = ROOM_PAD - 1e-3;',
    'if (!lotCut(me, me, goal, pad) && !lotCut(goal, me, goal, pad)) { return arriveAt(me, onto); }',
    'fn arriveAt(a: vec2f, b: vec2f) -> vec2f { return dirTo(a, b) * min(distance(a, b) * 4.0, 1.0); }',
    'let c = roomWorld(u32(r), vec2f(CITY_LOT_HALF + ROOM_PAD + 0.05, s * (ROOM_DOOR - ROOM_PAD - 0.05)));',
    'if (cost < best && !crossesGlass(u32(r), me, c, pad) && !crossesGlass(u32(r), c, goal, pad)) {',
    'let p = select(goal, me, lotCut(me, me, goal, pad));',
    'if (roomOf(p) < 0) {',
    'let g = CITY_LOT_HALF + ROOM_PAD + 0.05;',
    'let q = c + vec2f(select(-g, g, (k & 1u) != 0u), select(-g, g, (k & 2u) != 0u));',
    'let own = c + select(vec2f(clamp(at.x - c.x, -face, face), sign(l.y) * face), vec2f(sign(l.x) * face, clamp(at.y - c.y, -face, face)), abs(l.x) >= abs(l.y));',
    'if (distance(own, at) < SUMMON_STOP && !lotCut(me, me, own, pad) && !lotCut(goal, me, own, pad)) { return dirTo(me, own); }',
    'if (cost < best && (distance(q, at) <= 4.0 * SUMMON_STOP || distance(goal, at) < SUMMON_STOP) && !lotCut(me, me, q, pad) && !lotCut(goal, me, q, pad) && !lotCut(me, q, goal, pad) && !lotCut(goal, q, goal, pad)) {',
    'let inward = dot(flow, flow) > 0.5 && roomOf(me) < 0 && all(abs(lotCenter(me) - lotCenter(goal)) < vec2f(0.5)) && lotCut(me, me, me + flow * 2.0, pad);',
    'if (dist <= 4.0 * SUMMON_STOP || inward) {',
    'return select(arriveAt(me, onto), flow, dot(flow, flow) > 0.5);',
    'if (r >= 0) { return crossesGlass(u32(r), a, b, pad); }',
    'return hitsBox(a, b - a, c - (CITY_LOT_HALF + pad), c + (CITY_LOT_HALF + pad));',
    'let clear = ROOM_PAD - 0.05;',
    'let goal = offFurniture(r, to);',
    'let held = ROOM_PAD - 1e-3;',
    'if (clearOfFurniture(r, me, goal, held)) { return dirTo(me, goal); }',
    'var next = goal;',
    'if ((k > 0u || there) && (!clearOfFurniture(r, t, next, 0.0) || walled(t, next))) { break; }',
    'if (clearOfFurniture(r, me, t, held) && !walled(me, t)) {',
    'let on = distance(me, next) <= distance(t, next) && clearOfFurniture(r, me, next, 0.0) && !walled(me, next);',
    'return dirTo(me, select(t, next, on));',
    'next = t;',
    'let q = select(box.xy - (ROOM_PAD + ROOM_ROUND), box.zw + (ROOM_PAD + ROOM_ROUND), vec2<bool>((c & 1u) != 0u, (c & 2u) != 0u));',
    'if (max(abs(l.x), abs(l.y)) >= reach || cost >= best) { continue; }',
    'if (!clearOfFurniture(r, q, q, ROOM_PAD) || !clearOfFurniture(r, me, q, clear) || !clearOfFurniture(r, q, goal, clear)) { continue; }',
    'let leg = goal - aim;',
    'let along = clamp(dot(me - aim, leg) / max(dot(leg, leg), 1e-6), 0.0, 1.0);',
    'if (best < 1e9 && distance(me, aim + leg * along) < ROOM_ROUND) { return dirTo(me, goal); }',
    'let g = ROOM_PAD + 0.05;',
    'let c = clamp(e, P.rooms[r].a.xy - m, P.rooms[r].a.xy + m);',
    'if (all(c > lo) && all(c < hi)) { continue; }',
    'if (r < 0) { return pushOut(p, ROOM_PAD); }',
    'if (m.x < m.y) { l.x = select(hi.x, lo.x, dlo.x < dhi.x); } else { l.y = select(hi.y, lo.y, dlo.y < dhi.y); }',
  ]) assert.ok(src.includes(line), line)
  assert.equal(STYLE.glass, 10)
})
