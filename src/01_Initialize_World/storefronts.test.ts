// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the five storefronts (storefronts.ts) to what the player, the renderer and the
 * physics worker rely on: one shop per kind on a lot of its own quarter, never a workplace's lot nor another shop's,
 * for every seed; the lot's podium really gone from the city's boxes and the shop's shell and fixtures in its place;
 * every fixture inside the walls and out of the doorway; the walk from the street through the doorway to the fitting
 * spot, and the mirror camera's circle round it, clear of every fixture; and the real avatar (Rapier, its capsule and
 * autostep) walking in from the sidewalk to that spot.
 * What breaks if it is removed? A seed could put a shop on a workplace's lot (two shells on one lot), a fixture in the
 * doorway or in the camera's orbit, or a podium left standing inside a shop, and only a browser on that seed would show it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CITY, CITY_CENTER, HERITAGE_COLUMNS, STYLE, generateBuildings, type Box } from './city.ts'
import { ROOM, doorFront, insideRoom, penetrates, toLocal, toWorld, workplaceLots } from './interiors.ts'
import { SHOP, SHOP_INFO, SHOP_KINDS, drawShops, orbitEye, shopAt, shopLots, shops, shopsAt } from './storefronts.ts'
import { Physics } from '../07_Execute_Actions/physics.ts'
import { Avatar } from '../07_Execute_Actions/player.ts'

const SEEDS = Array.from({ length: 64 }, (_, i) => (i * 2654435761) >>> 0)
const key = ({ k, m }: { k: number; m: number }) => `${k},${m}`
const lake = CITY.blocks - 2

test('one shop per kind, each on a lot of its own quarter, never a workplace lot nor another shop\'s, for every seed', () => {
  for (const seed of SEEDS) {
    const lots = shopLots(seed)
    assert.deepEqual(lots.map((l) => l.kind), [...SHOP_KINDS])
    const work = new Set(workplaceLots(seed).map(key))
    const mine = new Set(lots.map(key))
    assert.equal(mine.size, SHOP_KINDS.length, `seed ${seed}: two shops on one lot`)
    for (const l of lots) {
      assert.ok(!work.has(key(l)), `seed ${seed}: the ${l.kind} took a workplace lot ${key(l)}`)
      assert.ok(l.k >= HERITAGE_COLUMNS && l.k < CITY.blocks && l.m >= 0 && l.m <= lake, `seed ${seed}: the ${l.kind} is off the downtown and lakefront lots`)
      assert.ok([0, 1, 2, 3].includes(l.side))
      if (l.kind === 'inkStudio' || l.kind === 'designHouse') {
        assert.equal(l.m, lake, 'the tattoo studio and the design house stand on the lakefront row')
        assert.equal(l.side, 0, 'facing the lake')
        // The row's west half for the studio, its east half for the design house.
        if (l.kind === 'inkStudio') assert.ok(l.k <= CITY.blocks / 2, `the studio at column ${l.k}`)
        else assert.ok(l.k > CITY.blocks / 2, `the design house at column ${l.k}`)
      } else assert.ok(l.m < lake, `the ${l.kind} stands downtown`)
      // The tailor in the northern downtown rows, the atelier in the southern ones above the lakefront row, both a
      // column in from the heritage quarter and the ring road.
      if (l.kind === 'tailor' || l.kind === 'prosthetics') assert.ok(l.k > HERITAGE_COLUMNS && l.k < CITY.blocks - 1, `the ${l.kind} at column ${l.k}`)
      if (l.kind === 'tailor') assert.ok(l.m >= 1 && l.m <= 5, `the tailor at row ${l.m}`)
      if (l.kind === 'prosthetics') assert.ok(l.m >= 8 && l.m < lake - 1, `the atelier at row ${l.m}`)
      if (l.kind === 'horology') {
        const d = Math.hypot((l.k + 0.5) * CITY.pitch - CITY_CENTER, (l.m + 0.5) * CITY.pitch - CITY_CENTER)
        assert.ok(d < CITY.pitch * 2.5, `the watch shop is in the Financial District (${d.toFixed(0)} m from the centre)`)
      }
    }
    assert.deepEqual(shopLots(seed), lots, 'the seed alone decides')
  }
})

test('every name is the shop\'s own: no real place, nothing scrubbed, one line each', () => {
  for (const kind of SHOP_KINDS) {
    const { name, arcade, line } = SHOP_INFO[kind]
    for (const text of [name, arcade, line]) {
      assert.ok(text.length > 0)
      assert.doesNotMatch(text, /\b(?:Toronto|Ontario|Harbourfront|Yonge|Queens? Quay|Lake ?Shore|Domus|Chronos|Sovereign Threads?)\b/i)
      assert.doesNotMatch(text, /matrix/i)
    }
  }
})

test('the city\'s boxes: each shop\'s podium gone, its shell and fixtures in its place, and nothing else standing inside its walls', () => {
  for (const seed of SEEDS.slice(0, 16)) {
    const boxes = generateBuildings(seed)
    const list = shops(seed)
    for (const s of list) {
      const h = CITY.lotHalf
      const podium = boxes.find(({ box: [x0, y0, z0, x1, , z1] }) => y0 === 0 && x0 === s.cx - h && x1 === s.cx + h && z0 === s.cz - h && z1 === s.cz + h)
      assert.equal(podium, undefined, `seed ${seed}: the ${s.kind}'s podium still stands`)
      // Every box below the ceiling whose footprint reaches inside the walls is one of the shop's own (its glass, its
      // fixtures): nothing of the old building is left in the way.
      const own = new Set([...s.shell, ...s.furniture].map(({ box }) => box.join(',')))
      const inner = h - ROOM.wall
      for (const { box } of boxes) {
        const [x0, y0, z0, x1, , z1] = box
        if (y0 >= ROOM.height - 1e-6) continue
        const reaches = x1 > s.cx - inner && x0 < s.cx + inner && z1 > s.cz - inner && z0 < s.cz + inner
        if (reaches) assert.ok(own.has(box.join(',')), `seed ${seed}: a box not the ${s.kind}'s stands inside it: ${box.map((v) => v.toFixed(1)).join(', ')}`)
      }
      // The shell is the glass and the slab, the slab in the podium's own finish (never glass).
      assert.equal(s.shell.length, 6)
      assert.ok(s.shell.slice(0, 5).every((b) => b.style === STYLE.glass))
    }
  }
})

test('every fixture is inside the walls and clear of the doorway; the walk in and the mirror camera\'s circle are clear', () => {
  const pad = ROOM.pad
  for (const seed of SEEDS.slice(0, 8)) {
    for (const s of shops(seed)) {
      const inner = CITY.lotHalf - ROOM.wall
      for (const { box } of s.furniture) {
        const [x0, y0, z0, x1, y1, z1] = box
        const a = toLocal(s, x0, z0), b = toLocal(s, x1, z1)
        const u0 = Math.min(a.u, b.u), u1 = Math.max(a.u, b.u), v0 = Math.min(a.v, b.v), v1 = Math.max(a.v, b.v)
        assert.ok(u0 >= -inner - 1e-6 && u1 <= inner + 1e-6 && v0 >= -inner - 1e-6 && v1 <= inner + 1e-6, `${s.kind}: a fixture through the wall`)
        assert.ok(y0 >= 0 && y1 <= ROOM.height && y1 > y0, `${s.kind}: a fixture through the floor or the ceiling`)
      }
      // The walk from the doorway along the axis to the fitting spot: every point clear of every fixture by a reach.
      for (let u = CITY.lotHalf + 1; u >= SHOP.fitting.u; u -= 0.1) {
        const p = toWorld(s, u, 0)
        assert.ok(!penetrates(s, p.x, p.z, pad), `${s.kind}: the walk in is blocked at u = ${u.toFixed(1)}`)
      }
      // The circle about the fitting spot (the camera's orbit inside it), sampled finely.
      for (let r = 0; r <= SHOP.clear; r += 0.2) {
        for (let k = 0; k < 64; k++) {
          const t = (k / 64) * 2 * Math.PI
          const p = toWorld(s, SHOP.fitting.u + Math.cos(t) * r, SHOP.fitting.v + Math.sin(t) * r)
          assert.ok(!penetrates(s, p.x, p.z, pad), `${s.kind}: a fixture within ${SHOP.clear} m of the fitting spot`)
        }
      }
      assert.ok(SHOP.orbit.radius + pad < SHOP.clear + pad, 'the orbit is inside the clear circle')
    }
  }
})

test('shopAt: the fitting spot is in its own shop, the street outside in none; the mirror camera circles the body at its radius', () => {
  for (const seed of SEEDS.slice(0, 8)) {
    const list = shops(seed)
    list.forEach((s, i) => {
      assert.equal(shopAt(list, s.fitting.x, s.fitting.z), i)
      assert.ok(insideRoom(s, s.door.x, s.door.z), 'the doorway counts as in the shop')
      const out = doorFront(s)
      assert.equal(shopAt(list, out.x, out.z), -1, 'the sidewalk outside is in no shop')
      // The fitting spot faces the doorway.
      const ahead = { x: s.fitting.x + Math.sin(s.fitting.yaw) * 5, z: s.fitting.z + Math.cos(s.fitting.yaw) * 5 }
      assert.ok(toLocal(s, ahead.x, ahead.z).u > SHOP.fitting.u + 4.9)
    })
    assert.equal(shopAt(list, Number.NaN, 0), -1)
  }
  for (const angle of [0, 1, 2.5, -3]) {
    const { eye, at } = orbitEye(10, 0.3, -4, angle)
    assert.ok(Math.abs(Math.hypot(eye.x - 10, eye.z + 4) - SHOP.orbit.radius) < 1e-9)
    assert.ok(Math.abs(eye.y - (0.3 + SHOP.orbit.height)) < 1e-9 && Math.abs(at.y - (0.3 + SHOP.orbit.aim)) < 1e-9)
  }
})

test('drawShops: each shop within reach drawn as its lot, its floor and its doorway; the far ones not at all', () => {
  const list = shops(7)
  const rects: number[][] = []
  const ctx = { fillStyle: '' as string | object, fillRect: (x: number, y: number, w: number, h: number) => { rects.push([x, y, w, h]) } }
  drawShops(ctx, list, list[0].cx, list[0].cz, false, 1)
  assert.equal(rects.length, 3, 'the one shop under the point: lot, floor, doorway')
  rects.length = 0
  drawShops(ctx, list, list[0].cx, list[0].cz, true, 1e6)
  assert.equal(rects.length, 3 * list.length)
})

test('the real avatar walks in from the sidewalk through the doorway to the fitting spot, in every shop', async () => {
  for (const s of shops(11)) {
    const boxes: Box[] = [...s.shell, ...s.furniture].map((b) => b.box)
    const physics = await Physics.create(boxes, { lamps: [], trees: [], signals: [] })
    const start = doorFront(s)
    const a = new Avatar(physics, start.x, start.z)
    const way = [toWorld(s, CITY.lotHalf - 1, 0), { x: s.fitting.x, z: s.fitting.z }]
    const h = 1 / 60, speed = 1.4
    let k = 0
    for (let t = 0; t < 30 && k < way.length; t += h) {
      const goal = way[k], dx = goal.x - a.x, dz = goal.z - a.z, d = Math.hypot(dx, dz)
      if (d < 0.08) { k++; continue }
      physics.step(h, (hh) => a.move((speed * dx) / d, (speed * dz) / d, hh))
    }
    assert.equal(k, way.length, `${s.kind}: the avatar did not reach the fitting spot (stood at ${a.x.toFixed(2)}, ${a.z.toFixed(2)})`)
    assert.ok(insideRoom(s, a.x, a.z))
  }
})

test('shopsAt keeps the podium\'s finish on the ceiling slab and lifts a low podium over the room', () => {
  const [s] = shopsAt([{ kind: 'tailor', k: 8, m: 3, side: 2 }], () => ({ top: 2, style: STYLE.condo }))
  const slab = s.shell[5]
  assert.equal(slab.style, STYLE.condo)
  assert.ok(slab.box[4] >= ROOM.height + 0.3 - 1e-9, 'never below the room')
})
