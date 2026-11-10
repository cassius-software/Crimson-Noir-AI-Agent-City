// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins where the kerbside bays are and who stands in them: every bay of a planned fleet
 * is on the sidewalk strip of its street (past the asphalt, short of the lots), on the kerb side of its lane's travel
 * direction, between the lamps and the tree of its block side, further off the ring than the order counts, facing
 * along the lane, one car per bay; the parked share is the last quarter of the plan and nothing else; and the plan
 * ahead of that share is the plan there was before bays existed (the same seats, kinds, drivers and paint from the
 * same stream), so saved rooms and the determinism goldens hold. In the realm: a bay car starts parked, the AI
 * traffic laps its ring without ever queueing behind it, and a player at a bay takes the car while a player beside
 * a car in traffic is refused and told.
 * What breaks if it is removed? A bay could drift onto the road, into a lamp or a lot, two cars could share one, the
 * parked share could move and change every seat after it, or a follower could sit behind a bay forever.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CITY, generateCity, streetFurniture } from '../01_Initialize_World/city.ts'
import { TRAFFIC } from '../02_Define_The_Rules/civic.ts'
import { buildTrackNetwork, poseAt, projectOnto, type TrackPose } from '../06_Make_Decisions/tracks.ts'
import { CAR } from './car.ts'
import { planFleet } from './carRig.ts'
import { BAY_OFF_LANE, BAYS, bayClear, bayNear, inBays } from './parking.ts'
import { Physics } from './physics.ts'
import { SimCore } from './simCore.ts'
import { MODES, POSE } from './simProtocol.ts'
import { Fleet, ON_LANE } from './vehicles.ts'

const SEED = 1337
const CARS = 36
const H = 1 / 60
const IDLE = { steer: 0, fwd: 0, back: 0, handbrake: false }
const STILL = { x: 0, z: 0, heading: 0 }
const STRIP = { inner: CITY.roadHalf, outer: CITY.pitch / 2 - CITY.lotHalf }

/** The street a pose stands beside: its axis, the centreline's grid line, and the pose's offsets along and across it. */
function street(p: { x: number; z: number; heading: number }) {
  const alongX = Math.abs(Math.sin(p.heading)) >= Math.abs(Math.cos(p.heading))
  const along = alongX ? p.x : p.z, cross = alongX ? p.z : p.x
  const line = Math.round(cross / CITY.pitch)
  return { alongX, along, lateral: cross - line * CITY.pitch, line }
}

test('the parked share is the last quarter of the plan, and the plan ahead of it is byte for byte the plan without bays', () => {
  const network = buildTrackNetwork(SEED)
  const boxes = generateCity(SEED)
  for (const count of [4, 12, 36, 48]) {
    const plain = planFleet(count, SEED, network).cars
    const withBays = planFleet(count, SEED, network, { boxes }).cars
    const quarter = Math.floor(count / BAYS.share)
    for (let i = 0; i < count; i++) {
      assert.equal(inBays(i, count), i >= count - quarter)
      const a = plain[i], b = withBays[i]
      assert.deepEqual([b.kind, b.suv, b.paint, b.track], [a.kind, a.suv, a.paint, a.track], `car ${i}: the stream is untouched`)
      if (!b.bay) assert.deepEqual(b.pose, a.pose, `car ${i} seated as before`)
      if (i < count - quarter) assert.equal(b.bay, false, `car ${i} is in traffic`)
    }
    assert.equal(plain.filter((c) => c.bay).length, 0, 'no bays asked, none laid')
    const bays = withBays.filter((c) => c.bay).length
    assert.ok(bays >= Math.max(1, quarter - 1) && bays <= quarter, `${bays} of ${quarter} bay seats taken for ${count} cars`)
  }
})

test('every bay is on the sidewalk strip, kerb side, between the lamps and the tree, off the ring\'s order, facing along the lane, one car each', () => {
  const network = buildTrackNetwork(SEED)
  const boxes = generateCity(SEED)
  const furniture = streetFurniture(SEED)
  const { cars } = planFleet(48, SEED, network, { boxes })
  const taken = new Set<string>()
  assert.ok(BAY_OFF_LANE > ON_LANE, 'a bay is outside the ring\'s order')
  assert.equal(BAYS.lateral - TRAFFIC.laneOffset, BAY_OFF_LANE)
  let seen = 0
  for (const c of cars) {
    if (!c.bay) continue
    seen++
    const s = street(c.pose)
    // On the strip: the whole car past the asphalt and short of the lot edge.
    assert.ok(Math.abs(s.lateral) - CAR.halfWidth >= STRIP.inner, `car ${cars.indexOf(c)} over the road at ${s.lateral.toFixed(2)} m`)
    assert.ok(Math.abs(s.lateral) + CAR.halfWidth <= STRIP.outer, `car ${cars.indexOf(c)} in a lot at ${s.lateral.toFixed(2)} m`)
    assert.ok(Math.abs(Math.abs(s.lateral) - BAYS.lateral) < 1e-9)
    // At a station of its block side.
    const inBlock = s.along - Math.floor(s.along / CITY.pitch) * CITY.pitch
    assert.ok((BAYS.stations as readonly number[]).includes(inBlock), `car ${cars.indexOf(c)} at ${inBlock} m along its block`)
    // Clear of every lamp, tree and signal by more than the car's own half-length (the furniture is on the kerb line).
    for (const [lx, lz] of furniture.lamps) assert.ok(Math.hypot(lx - c.pose.x, lz - c.pose.z) > CAR.halfLength + 0.3, 'a lamp inside a bay')
    for (const [tx, tz] of furniture.trees) assert.ok(Math.hypot(tx - c.pose.x, tz - c.pose.z) > CAR.halfLength + 0.3, 'a tree inside a bay')
    for (const [sx, sz] of furniture.signals) assert.ok(Math.hypot(sx - c.pose.x, sz - c.pose.z) > CAR.halfLength + 0.3, 'a signal inside a bay')
    // Kerb side of its own ring, off the lane by BAY_OFF_LANE, facing along it.
    const track = network.tracks[c.track]
    const pr = projectOnto(track, c.pose.x, c.pose.z)
    assert.ok(Math.abs(pr.lateral - BAY_OFF_LANE) < 0.05, `car ${cars.indexOf(c)} is ${pr.lateral.toFixed(2)} m right of its lane`)
    const lane = poseAt(track, pr.s)
    let dh = c.pose.heading - lane.heading
    dh = Math.atan2(Math.sin(dh), Math.cos(dh))
    assert.ok(Math.abs(dh) < 1e-6, 'facing along the lane')
    // One car per bay.
    const key = `${c.pose.x.toFixed(3)},${c.pose.z.toFixed(3)}`
    assert.ok(!taken.has(key), `two cars in the bay at ${key}`)
    taken.add(key)
    // Nothing solid in it.
    assert.ok(bayClear({ ...c.pose, y: 0, key }, boxes))
  }
  assert.ok(seen >= 11, `${seen} bay cars of 12`)
})

test('bayNear: the kerb of each travel direction on each axis, the nearest free station first, a region\'s own origin', () => {
  const pose = (x: number, z: number, tx: number, tz: number): TrackPose => ({ x, y: 0, z, heading: Math.atan2(tx, tz), tangentX: tx, tangentZ: tz })
  const used = new Set<string>()
  // Along +x on the street z = 80 (the lane at z = 82): the kerb is +z; the seat at 13 m along snaps to 15.
  const east = bayNear(pose(3 * CITY.pitch + 13, 2 * CITY.pitch + TRAFFIC.laneOffset, 1, 0), used)!
  assert.deepEqual([east.x, east.z, east.heading], [3 * CITY.pitch + 15, 2 * CITY.pitch + BAYS.lateral, Math.atan2(1, 0)])
  // Along −x on the same street (the lane at z = 78): the kerb is −z; 29 m along snaps to 25.
  const west = bayNear(pose(3 * CITY.pitch + 29, 2 * CITY.pitch - TRAFFIC.laneOffset, -1, 0), used)!
  assert.deepEqual([west.x, west.z], [3 * CITY.pitch + 25, 2 * CITY.pitch - BAYS.lateral])
  // Along +z on the street x = 200: the kerb is −x; along −z it is +x.
  const south = bayNear(pose(5 * CITY.pitch - TRAFFIC.laneOffset, 7 * CITY.pitch + 20, 0, 1), used)!
  assert.deepEqual([south.x, south.z], [5 * CITY.pitch - BAYS.lateral, 7 * CITY.pitch + 15])
  const north = bayNear(pose(5 * CITY.pitch + TRAFFIC.laneOffset, 7 * CITY.pitch + 20, 0, -1), used)!
  assert.deepEqual([north.x, north.z], [5 * CITY.pitch + BAYS.lateral, 7 * CITY.pitch + 15])
  // The same bay asked twice: the other station, then none.
  used.add(east.key)
  const second = bayNear(pose(3 * CITY.pitch + 13, 2 * CITY.pitch + TRAFFIC.laneOffset, 1, 0), used)!
  assert.equal(second.x, 3 * CITY.pitch + 25)
  used.add(second.key)
  assert.equal(bayNear(pose(3 * CITY.pitch + 13, 2 * CITY.pitch + TRAFFIC.laneOffset, 1, 0), used), null)
  // A street window elsewhere: the same geometry about its own corner.
  const origin = { x: 1200, z: -400 }
  const far = bayNear(pose(origin.x + 3 * CITY.pitch + 13, origin.z + 2 * CITY.pitch + TRAFFIC.laneOffset, 1, 0), new Set(), origin)!
  assert.deepEqual([far.x, far.z], [origin.x + 3 * CITY.pitch + 15, origin.z + 2 * CITY.pitch + BAYS.lateral])
  // A box on the strip (a region's wall to the kerb) refuses the bay; one on the far side of the street does not.
  assert.equal(bayClear(east, [[east.x - 1, 0, east.z - 1, east.x + 1, 3, east.z + 1]]), false)
  assert.equal(bayClear(east, [[east.x - 1, 0, east.z - 12, east.x + 1, 3, east.z - 10]]), true)
  assert.equal(bayClear(east, [[east.x - 1, 2, east.z - 1, east.x + 1, 3, east.z + 1]]), true, 'a canopy over a car\'s height is no obstacle')
})

test('in the realm: bay cars start parked and stay put while the traffic laps past them; no follower queues behind one', async () => {
  const physics = await Physics.create(generateCity(SEED), streetFurniture(SEED))
  const network = buildTrackNetwork(SEED)
  const fleet = new Fleet(physics, CARS, SEED, { network, bays: { boxes: generateCity(SEED) } })
  const bayCars = fleet.vehicles.filter((v) => v.bay)
  assert.ok(bayCars.length >= 8, `${bayCars.length} bay cars`)
  for (const v of bayCars) assert.equal(v.mode, 'parked')
  for (const v of fleet.vehicles) if (!v.bay) assert.equal(v.mode, 'ai')
  const start = bayCars.map((v) => fleet.position(v))
  let clock = 0
  const standing = new Float64Array(CARS)
  let longest = 0
  for (let k = 0; k < 1800; k++) {
    clock += H
    fleet.think(H, clock)
    physics.step(H, (h) => fleet.updateControllers(h))
    for (const v of fleet.vehicles) {
      if (v.bay) continue
      // A follower standing within a few metres behind a bay car's ring position would be a queue: none forms.
      const at = fleet.position(v)
      const near = bayCars.some((b) => Math.hypot(b.bay!.x - at.x, b.bay!.z - at.z) < 8)
      standing[v.index] = near && Math.abs(fleet.speed(v)) < 0.3 ? standing[v.index] + H : 0
      longest = Math.max(longest, standing[v.index])
    }
  }
  for (let i = 0; i < bayCars.length; i++) {
    const p = fleet.position(bayCars[i])
    assert.ok(Math.hypot(p.x - start[i].x, p.z - start[i].z) < 0.05, `bay car ${bayCars[i].index} moved ${Math.hypot(p.x - start[i].x, p.z - start[i].z).toFixed(3)} m`)
    assert.equal(bayCars[i].mode, 'parked')
  }
  assert.ok(longest < 3, `a car stood ${longest.toFixed(1)} s beside a bay (a queue behind a parked car)`)
})

test('a player takes a bay car; beside a car in traffic the door is refused and the refusal names a driver', async () => {
  const boxes = generateCity(SEED), furniture = streetFurniture(SEED)
  const network = buildTrackNetwork(SEED)
  const { cars } = planFleet(CARS, SEED, network, { boxes })
  const bay = cars.findIndex((c) => c.bay)
  assert.ok(bay >= 0)
  const sim = await SimCore.create({ seed: SEED, cars: CARS, agents: 64, boxes, furniture, spawn: { x: 320, z: 320 }, debug: false, tracks: true }, null)
  const poses = new Float32Array(sim.meta.count * POSE.stride)
  const step = (cmds: Parameters<typeof sim.step>[0]['cmds'] = []) => sim.step({ dt: H, foot: STILL, drive: IDLE, cmds }, poses)
  const mode = (i: number) => MODES[poses[i * POSE.stride + POSE.mode]]
  step()
  assert.equal(mode(bay), 'parked')
  // Beside a car in traffic (the road side of it): refused, said, and the car keeps its driver.
  const traffic = cars.findIndex((c) => !c.bay)
  const t = { x: poses[traffic * POSE.stride + POSE.x], z: poses[traffic * POSE.stride + POSE.z] }
  let s = step([{ c: 'teleport', x: t.x + 1.5, z: t.z }])
  const rejected = s.rejected
  s = step([{ c: 'interact' }])
  assert.equal(s.driving, -1)
  assert.equal(s.rejected, rejected + 1)
  const why = s.events.find((e) => e.e === 'rejected')
  assert.ok(why && why.e === 'rejected' && why.reason === 'that car has a driver', JSON.stringify(s.events))
  assert.equal(mode(traffic), 'ai')
  // A scripted intent on it is refused the same way.
  s = step([{ c: 'intent', i: traffic, throttle: 1, brake: 0, steer: 0 }])
  assert.equal(s.rejected, rejected + 2)
  assert.equal(mode(traffic), 'ai')
  // Beside the bay car, on its road side: taken; the event names it.
  const b = cars[bay].pose
  const left = { x: b.x + Math.cos(b.heading) * 2.2, z: b.z - Math.sin(b.heading) * 2.2 }
  s = step([{ c: 'teleport', x: left.x, z: left.z }])
  s = step([{ c: 'interact' }])
  assert.equal(s.driving, bay, JSON.stringify(s.events))
  assert.equal(mode(bay), 'player')
  // Out again: parked where it stands, and the minimap's word for it is the mode the page reads.
  s = step([{ c: 'interact' }])
  assert.equal(s.driving, -1)
  assert.equal(mode(bay), 'parked')
})
