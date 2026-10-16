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
import { cellAt, cityGrid, flowAt, nearestOpen, solveFlow, trace, UNREACHED } from '../06_Make_Decisions/flowField.ts'
import {
  ROOM, ROOM_FLOATS, ROOMS_FLOATS, WORK, WORKPLACE_KINDS, workOneIn, containInRoom, doorDir, doorFront, insideRoom, onDuty, packRooms, penetrates, routeIn,
  targetCorner, toLocal, toWorld, workerSlot, workplaceLots, workplaces, type Workplace,
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

test('the uniform: six slots of a, b, furniture and stations as vec4s, zero where empty, and a region packs nothing', () => {
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
  for (const name of ['fn containRoom(', 'fn contain(', 'fn roomOf(', 'fn workerSlot(', 'fn onDuty(', 'fn towardCorner(', 'fn targetCorner(', 'fn doorFront(', 'rooms: array<Room, ROOM_SLOTS>']) {
    assert.ok(src.includes(name), name)
  }
  assert.ok(src.includes('let held = contain(me, next, 0.35, mayEnter || asked);'), 'every step is contained, the doorway open to the workday and the summons')
  assert.ok(src.includes('if (into < 0.0) { nv -= wallN * into; }'), 'the refused part of a step leaves the velocity: the slide')
  assert.equal(STYLE.glass, 10)
})
