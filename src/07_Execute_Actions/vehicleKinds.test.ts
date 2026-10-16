// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the eight kinds of vehicle (car.ts VEHICLE_KINDS) to the two chassis classes the
 * First Law was proven on: the one seeded draw that used to say "SUV or sedan" now says which kind, with the heavy
 * kinds on exactly the old SUV share, so every fleet a seed laid out before keeps the same chassis in every slot;
 * every silhouette fits inside its class's box plus the dissolve's reach, so the camera never enters a body the
 * dissolve has not yet taken; the plan, the fleet, the realm's meta and the page's view all carry the kind; and the
 * eight are all drawn by a fleet of a few hundred.
 * What breaks if it is removed? A ninth kind, or a silhouette longer than its box, could go in without a stopping
 * envelope of its own, and a seed's fleet could change class under a saved room.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { uniform } from 'three/tsl'
import { CAR, KIND, VEHICLE_KINDS, chassisBox, kindFromDraw, kindOf } from './car.ts'
import { planFleet } from './carRig.ts'
import { DISSOLVE } from './dissolve.ts'
import { Physics } from './physics.ts'
import { Fleet } from './vehicles.ts'
import { SimCore } from './simCore.ts'
import { POSE } from './simProtocol.ts'

// Vite's `?raw` import, for Node: fleetView.ts takes matrix mode, whose WGSL is imported that way.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { FleetView, PROFILES } = await import('./fleetView.ts')

const H = 1 / 60
const NO_FURNITURE = { lamps: [], trees: [], signals: [] }
/** Open ground off the street grid (simCore.test.ts spawns there too). */
const OPEN = { x: -600, z: 0 }

test('eight kinds, distinct ids and names, each a frozen record with a profile of its own', () => {
  assert.equal(VEHICLE_KINDS.length, 8)
  assert.equal(new Set(VEHICLE_KINDS.map((k) => k.id)).size, 8)
  assert.equal(new Set(VEHICLE_KINDS.map((k) => k.name)).size, 8)
  assert.ok(Object.isFrozen(VEHICLE_KINDS))
  for (const [i, k] of VEHICLE_KINDS.entries()) {
    assert.ok(Object.isFrozen(k) && Object.isFrozen(k.scale), k.id)
    assert.equal(KIND[k.id], i)
    assert.ok(PROFILES[k.id].length >= 8, `${k.id} has a profile`)
    assert.ok(k.scale.every((s) => s > 0.5 && s <= 1.5) && k.wheel > 0.5 && k.wheel <= 1.1, k.id)
    assert.ok(['none', 'interior', 'beacon'].includes(k.lights))
  }
  assert.equal(VEHICLE_KINDS.filter((k) => k.heavy).length, 4, 'four heavy, four light')
  assert.deepEqual(kindOf(-1), VEHICLE_KINDS[0])
  assert.deepEqual(kindOf(8), VEHICLE_KINDS[0])
  assert.deepEqual(kindOf(Number.NaN), VEHICLE_KINDS[0])
  assert.deepEqual(kindOf(KIND.coach), VEHICLE_KINDS[3])
})

test('kindFromDraw: the heavy kinds take exactly the old SUV share (u < 0.3), every kind is drawn, bad draws are the sedan', () => {
  const seen = new Set<number>()
  for (let i = 0; i <= 10_000; i++) {
    const u = i / 10_000
    if (u >= 1) continue
    const k = kindFromDraw(u)
    seen.add(k)
    assert.equal(VEHICLE_KINDS[k].heavy, u < 0.3, `u = ${u}`)
  }
  assert.equal(seen.size, 8, 'every kind is drawn somewhere in [0, 1)')
  for (const bad of [-0.1, 1, 1.5, Number.NaN, Infinity]) assert.equal(kindFromDraw(bad), KIND.sedan)
})

test('every silhouette fits its chassis class: within the box plus the dissolve reach, less the near plane, along and across', () => {
  const bevel = 0.06
  const slack = 0.1
  for (const k of VEHICLE_KINDS) {
    const box = chassisBox(k.heavy)
    const along = Math.max(...PROFILES[k.id].map(([x]) => Math.abs(x))) + bevel
    const across = (CAR.halfWidth * 2 - 0.12) / 2 + bevel
    assert.ok(along * k.scale[0] <= box.hx + DISSOLVE.reach - slack, `${k.id}: ${(along * k.scale[0]).toFixed(2)} m along, box ${box.hx} + reach ${DISSOLVE.reach}`)
    assert.ok(across * k.scale[2] <= box.hz + DISSOLVE.reach - slack, `${k.id}: ${(across * k.scale[2]).toFixed(2)} m across, box ${box.hz} + reach ${DISSOLVE.reach}`)
    assert.ok(PROFILES[k.id].every(([, y]) => y >= 0.3), `${k.id}: nothing below 0.3 m`)
  }
})

test('planFleet: each car carries its kind, suv is the kind\'s class, and the classes are what the same seeds drew before', () => {
  for (const seed of [11, 1337, 7]) {
    const { cars } = planFleet(64, seed, null)
    for (const c of cars) {
      assert.ok(Number.isInteger(c.kind) && c.kind >= 0 && c.kind < 8)
      assert.equal(c.suv, VEHICLE_KINDS[c.kind].heavy)
    }
    const kinds = new Set(cars.map((c) => c.kind))
    assert.ok(kinds.size >= 7, `seed ${seed}: ${kinds.size} kinds in 64 cars`)
    const heavy = cars.filter((c) => c.suv).length
    assert.ok(heavy >= 10 && heavy <= 30, `seed ${seed}: ${heavy} heavy of 64 (three in ten expected)`)
  }
  // The seed the pass-through tests use laid out "both sedans and SUVs" in 8 cars before; it still does.
  const eight = planFleet(8, 11, null).cars
  assert.ok(eight.some((c) => c.suv) && eight.some((c) => !c.suv))
})

test('the fleet and the realm carry the kind: Vehicle.kind, SimMeta.kind beside suv, the entered event', async () => {
  const physics = await Physics.create([], { lamps: [], trees: [], signals: [] })
  const fleet = new Fleet(physics, 6, 11)
  for (const v of fleet.vehicles) {
    assert.equal(v.suv, VEHICLE_KINDS[v.kind].heavy)
    assert.equal(v.mass, v.suv ? CAR.suvMass : CAR.mass, 'the mass is the class\'s')
  }
  const sim = await SimCore.create({ seed: 11, cars: 6, agents: 0, boxes: [], furniture: NO_FURNITURE, spawn: { x: OPEN.x, z: OPEN.z }, debug: true })
  assert.equal(sim.meta.kind.length, 6)
  assert.deepEqual(sim.meta.suv, sim.meta.kind.map((k) => VEHICLE_KINDS[k].heavy))
  assert.deepEqual(sim.meta.kind, fleet.vehicles.map((v) => v.kind), 'the same seed, the same kinds')
  // Park car 0 beside the avatar and take its wheel: the event names the kind.
  const poses = new Float32Array(sim.meta.count * POSE.stride)
  const step = (cmds: Parameters<typeof sim.step>[0]['cmds'] = []) => sim.step({ dt: H, foot: { x: 0, z: 0, heading: 0 }, drive: { steer: 0, fwd: 0, back: 0, handbrake: false }, cmds }, poses)
  step([{ c: 'dbgMode', i: 0, mode: 'parked' }, { c: 'recover', i: 0, x: OPEN.x + 3.5, z: OPEN.z, heading: 0 }])
  for (let i = 0; i < 60; i++) step()
  const s = step([{ c: 'interact' }])
  const entered = s.events.find((e) => e.e === 'entered')
  assert.ok(entered && entered.e === 'entered')
  assert.equal(entered.kind, sim.meta.kind[0])
  assert.equal(entered.suv, VEHICLE_KINDS[sim.meta.kind[0]].heavy)
})

test('FleetView: one mesh per kind with compact slots, the kind\'s scale on its matrices, brake lights from the pose', () => {
  const kinds = [0, 1, 2, 3, 4, 5, 6, 7, 0, 3]
  const view = new FleetView(kinds, kinds.map(() => 0x808080), uniform(0))
  assert.equal(view.bodies.length, 8)
  assert.deepEqual(view.bodies.map((m) => m.count), [2, 1, 1, 2, 1, 1, 1, 1])
  assert.deepEqual(view.bodies.map((m) => m.name), VEHICLE_KINDS.map((k) => `Cars:${k.id}`))
  assert.deepEqual([...view.slotOf], [0, 0, 0, 0, 0, 0, 0, 0, 1, 1])
  assert.equal(view.wheels.count, 40)
  // Poses: car i at x = 10 i, upright, heading 0, braking on the odd ones.
  const poses = new Float32Array(kinds.length * POSE.stride)
  for (let i = 0; i < kinds.length; i++) {
    const o = i * POSE.stride
    poses[o + POSE.x] = 10 * i
    poses[o + POSE.qw] = 1
    poses[o + POSE.brake] = i % 2 ? 3 : 0
  }
  view.sync(poses)
  // The instance transform of car 3 (a coach, slot 0 of its mesh): scale (1, 1.4, 1.06) about the chassis origin at x = 30.
  const coach = view.bodies[3]
  const e = (coach.instanceMatrix.array as Float32Array).slice(0, 16)
  const [sx, sy, sz] = VEHICLE_KINDS[3].scale
  assert.ok(Math.abs(e[0] - sx) < 1e-6 && Math.abs(e[5] - sy) < 1e-6 && Math.abs(e[10] - sz) < 1e-6, 'the coach is scaled by its kind')
  assert.ok(Math.abs(e[12] - 30) < 1e-6, 'and stands where its pose says')
  const brake = (k: number) => [...(view.bodies[k].geometry.getAttribute('brake').array as Float32Array)]
  assert.deepEqual(brake(0), [0, 0], 'cars 0 and 8: not braking')
  assert.deepEqual(brake(3), [1, 1], 'cars 3 and 9 brake')
  assert.deepEqual(brake(1), [1])
})
