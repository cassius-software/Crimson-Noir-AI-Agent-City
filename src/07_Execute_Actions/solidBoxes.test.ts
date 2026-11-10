// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins physics.ts solidBoxes: the collision world holds no two solids with the same face,
 * so a car sliding along a wall exchanges one contact with it, and the page and a network room's replay of that car
 * (garage.node.ts) agree to the bit however much traffic passes beside it. Without the clip, the city's buildings
 * raised from the street inside their lot's plinth hand a scraping chassis two identical contacts, and Rapier's split
 * between them depends on which other proxies share the broad phase's cell: the same car in a world with thirty-five
 * cars standing on the lane drifted from one without them by a float32 step a frame (15 µm at 150 m), 13 mm after
 * ten seconds, and the room put an honest driver back every frame of the scrape (authority.node.test.ts).
 * What breaks if it is removed? A kerbside bay's car scraping its lot wall would be put back by the room while traffic
 * passes, and a replay that is meant to be bit-exact would not be.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateCity, type Box } from '../01_Initialize_World/city.ts'
import { CAR } from './car.ts'
import { AUTHORED, buildCarRig, carState, carSubstep, type CarRig } from './carRig.ts'
import { Physics, RAPIER, solidBoxes } from './physics.ts'

const NO_FURNITURE = { lamps: [], trees: [], signals: [] }
const H = 1 / 60

/** Ordered pairs (a, b) of `boxes` where b stands inside a's footprint from below a's top. */
function nested(boxes: readonly Box[]): number {
  let n = 0
  for (const b of boxes) {
    for (const a of boxes) {
      if (a === b) continue
      if (a[0] <= b[0] && b[3] <= a[3] && a[2] <= b[2] && b[5] <= a[5] && a[1] <= b[1] && b[1] < a[4]) n++
    }
  }
  return n
}

test('solidBoxes: a box standing inside another is clipped to the part above it; on top, beside, straddling or wholly inside are left as they are or left out', () => {
  const plinth: Box = [0, 0, 0, 30, 4.6, 30]
  const tower: Box = [10, 0, 0, 20, 12, 10]
  const onTop: Box = [2, 4.6, 2, 8, 9, 8]
  const beside: Box = [30, 0, 0, 40, 6, 10]
  const straddling: Box = [25, 0, 12, 35, 6, 18]
  const inside: Box = [12, 1, 12, 14, 3, 14]
  const twoDeep: Box = [11, 0, 1, 19, 20, 9]
  const out = solidBoxes([plinth, tower, onTop, beside, straddling, inside, twoDeep])
  assert.deepEqual(out, [plinth, [10, 4.6, 0, 20, 12, 10], onTop, beside, straddling, [11, 12, 1, 19, 20, 9]], 'the tower from the plinth top, the box inside the tower from the tower top, the one wholly inside gone, the order kept')
  assert.equal(out[0], plinth, 'an unchanged box is the same array')
  assert.equal(out[2], onTop)
  assert.equal(nested(out), 0)
  assert.deepEqual(solidBoxes([]), [])
  const odd: Box = [NaN, 0, 0, 1, 1, 1]
  assert.deepEqual(solidBoxes([odd, plinth]), [odd, plinth], 'a box that is not finite is passed through for boxColliders to drop')
})

test('solidBoxes: the city\'s buildings raised inside their lot\'s plinth are clipped, hundreds of them, and nothing else moves', () => {
  for (const seed of [1337, 7]) {
    const boxes = generateCity(seed)
    const before = nested(boxes)
    const solid = solidBoxes(boxes)
    assert.ok(before > 300, `${before} boxes stand inside another in seed ${seed}'s city`)
    assert.equal(nested(solid), 0, 'none after')
    assert.equal(solid.length, boxes.length, 'no city box is wholly inside another')
    let clipped = 0
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i], b = solid[i]
      if (a === b) continue
      clipped++
      assert.deepEqual([b[0], b[2], b[3], b[4], b[5]], [a[0], a[2], a[3], a[4], a[5]], 'only the bottom moves')
      assert.ok(b[1] > a[1] && b[1] < b[4], 'raised, and still a box')
    }
    assert.equal(clipped, before, 'every nested box clipped once (no box stands inside two at once in the city)')
  }
})

test('one face, one contact: a car scraping a plinth with a tower raised inside it replays to the bit beside thirty-five cars on the lane', async () => {
  await RAPIER.init()
  // A lot's plinth to y 4.6 and a tower standing inside it from the street, the way city.ts builds a heritage lot: the
  // street face z = 7 would be two faces from the street up to 4.6 m. The car starts on the kerbside strip leaning
  // 0.1 rad into the wall with a slow weave on the wheel, reaches the wall after three seconds and works its corner
  // along it for over a second before the weave carries it away. The same run on the two unclipped boxes: the worlds
  // differ from the first frame of the touch, 345.6 µm at worst (and a steady slide along the doubled face scrubbed
  // the car to half the distance of one face, two frictions for one wall).
  const lot: Box[] = [[-20, 0, 7, 400, 4.6, 33], [10, 0, 7, 400, 12, 20]]
  const alone = Physics.build(lot, NO_FURNITURE), busy = Physics.build(lot, NO_FURNITURE)
  const parked = { throttle: 0, brake: 4, steer: 0 }
  const others: CarRig[] = []
  for (let i = 0; i < 35; i++) others.push(buildCarRig(busy.world, -20 + i * 12, 2, Math.PI / 2, i % 3 === 0))
  const a = buildCarRig(alone.world, 0, 5.2, Math.PI / 2 - 0.1, false), b = buildCarRig(busy.world, 0, 5.2, Math.PI / 2 - 0.1, false)
  let worst = 0, touched = 0
  for (let k = 0; k < 600; k++) {
    const cmd = { throttle: 0.7, brake: 0, steer: Math.sin(k / 40) * 0.15 }
    carSubstep(a, cmd, false, 'player', AUTHORED, H)
    alone.world.step()
    for (const o of others) carSubstep(o, parked, false, 'ai', AUTHORED, H)
    carSubstep(b, cmd, false, 'player', AUTHORED, H)
    busy.world.step()
    const sa = carState(a), sb = carState(b)
    worst = Math.max(worst, Math.hypot(sa.x - sb.x, sa.y - sb.y, sa.z - sb.z))
    // The chassis corner nearest the face: at the face (a contact) when it reaches z 7, less a hair of the solver's slack.
    const fx = 1 - 2 * (sa.qy * sa.qy + sa.qz * sa.qz), fz = 2 * (sa.qx * sa.qz - sa.qw * sa.qy)
    if (sa.z + Math.abs(fz) * CAR.halfLength + Math.abs(fx) * CAR.halfWidth >= 6.99) touched++
  }
  assert.ok(touched >= 50, `the corner against the wall for ${touched} frames`)
  assert.equal(worst, 0, `the two worlds differ by ${worst} m`)
})
