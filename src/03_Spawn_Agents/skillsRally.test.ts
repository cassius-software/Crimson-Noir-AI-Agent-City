// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? A rally (an Active recruit asked to walk to a sidewalk point instead of to the operator)
 * is only as safe as its rule: the point must be off the carriageway, near enough that the tether it rides on never
 * breaks on arrival, and reachable from where the recruit stands without a step into the road. The page and the
 * physics worker both run the rule (skills.ts whyNotRally), so it is pinned here once, with the range it rests on.
 * What breaks if it is removed? A regression could send someone into a street, or past the tether's reach.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CITY } from '../01_Initialize_World/city.ts'
import { INTERVIEW_DISTANCE, RALLY_RANGE, RELEASE_DISTANCE, whyNotRally } from './skills.ts'

/** A sidewalk mid-block: 5.8 m east of a north-south street, 20 m from the cross streets. */
const OP = { x: 2 * CITY.pitch + CITY.lane, z: 3 * CITY.pitch + 20 }
const field = (n = 16) => new Float32Array(2 * n).fill(NaN)
const put = (xz: Float32Array, agent: number, x: number, z: number) => { xz[2 * agent] = x; xz[2 * agent + 1] = z }

test('the rally range sits a metre inside the tether: a recruit stopped short of the farthest point is still within RELEASE_DISTANCE', () => {
  assert.equal(RALLY_RANGE, RELEASE_DISTANCE - INTERVIEW_DISTANCE - 1)
  assert.ok(RALLY_RANGE > INTERVIEW_DISTANCE, 'a point farther than where they would stop anyway')
  assert.ok(RALLY_RANGE + INTERVIEW_DISTANCE < RELEASE_DISTANCE, 'arriving never breaks the tether')
})

test('a rally point must be finite, off the road, within range of the operator, with a sidewalk path from where they stand', () => {
  const xz = field()
  put(xz, 3, OP.x, OP.z + 2)
  assert.equal(whyNotRally(OP, xz, 3, OP.x, OP.z + 5), null)
  assert.equal(whyNotRally(OP, xz, 3, OP.x, OP.z - 4), null, 'back down the sidewalk, past the operator')
  assert.equal(whyNotRally(OP, xz, 3, OP.x, OP.z + RALLY_RANGE), null, 'exactly the range')
  // Nowhere, or the operator nowhere / at the wheel.
  assert.equal(whyNotRally(null, xz, 3, OP.x, OP.z), 'rallying works on foot')
  assert.equal(whyNotRally({ x: NaN, z: OP.z }, xz, 3, OP.x, OP.z), 'rallying works on foot')
  assert.equal(whyNotRally(OP, xz, 3, NaN, OP.z), 'the rally point is nowhere')
  assert.equal(whyNotRally(OP, xz, 3, OP.x, Infinity), 'the rally point is nowhere')
  // In the carriageway: the street's centreline, and the kerb's inner edge.
  assert.equal(whyNotRally(OP, xz, 3, 2 * CITY.pitch, OP.z), 'nobody is sent into the road: pick a sidewalk point')
  assert.match(whyNotRally(OP, xz, 3, 2 * CITY.pitch + CITY.roadHalf - 0.01, OP.z)!, /into the road/)
  // Inside a building lot behind the sidewalk (the crowd never enters one): refused like the road.
  assert.equal(whyNotRally(OP, xz, 3, OP.x + 2, OP.z), 'nobody is sent into a building: pick a sidewalk point')
  assert.equal(whyNotRally(OP, xz, 3, 2 * CITY.pitch + CITY.pitch / 2 - CITY.lotHalf - 0.1, OP.z + 2), null, 'the far edge of the sidewalk, just short of the lot')
  // Too far, measured from the operator (not from the recruit).
  assert.equal(whyNotRally(OP, xz, 3, OP.x, OP.z + RALLY_RANGE + 0.01), `the rally point is too far: within ${RALLY_RANGE} m of the operator`)
  put(xz, 4, OP.x, OP.z + 8)
  assert.match(whyNotRally(OP, xz, 4, OP.x, OP.z + 10)!, /too far/, '2 m from the recruit, but 10 m from the operator')
  // Nobody by that number: the player's own body, a negative or fractional index, past the field, not yet seen.
  for (const bad of [0, -1, 1.5, 16, 99]) assert.equal(whyNotRally(OP, xz, bad, OP.x, OP.z + 2), 'nobody by that number', String(bad))
  assert.equal(whyNotRally(OP, xz, 5, OP.x, OP.z + 2), 'they have not been seen yet')
  // No sidewalk path: the recruit stands on the far kerb (the point is fine for someone on this side).
  put(xz, 6, OP.x - 2 * CITY.lane, OP.z)
  assert.equal(whyNotRally(OP, xz, 6, OP.x, OP.z + 2), 'no sidewalk from where they stand to the rally point')
  assert.equal(whyNotRally(OP, xz, 3, OP.x, OP.z + 2), null)
  // Around a corner, clipping the cross street's carriageway: refused for the recruit whose straight walk crosses it.
  const corner = { x: 2 * CITY.pitch + CITY.lane, z: 3 * CITY.pitch + CITY.roadHalf + 0.5 }
  put(xz, 7, corner.x, corner.z)
  const across = { x: corner.x + 1, z: 3 * CITY.pitch - CITY.roadHalf - 0.5 }
  assert.ok(Math.hypot(across.x - corner.x, across.z - corner.z) < RALLY_RANGE, 'in range, so the path is what refuses it')
  assert.equal(whyNotRally(corner, xz, 7, across.x, across.z), 'no sidewalk from where they stand to the rally point')
})

test('the rule is pure: the same inputs give the same answer, and the field is never written', () => {
  const xz = field()
  put(xz, 3, OP.x, OP.z + 2)
  const copy = Float32Array.from(xz)
  const a = whyNotRally(OP, xz, 3, OP.x, OP.z + 5)
  const b = whyNotRally(OP, xz, 3, OP.x, OP.z + 5)
  assert.equal(a, b)
  assert.deepEqual(xz, copy)
})

test('round a block\'s corner the straight walk would cut through the building lot: refused (pushOut would hold them against its face)', () => {
  const xz = field()
  // The lot of the block east of x = 2·pitch and north of z = 3·pitch starts lotHalf short of its centre.
  const lot = { x: 2 * CITY.pitch + CITY.pitch / 2 - CITY.lotHalf, z: 3 * CITY.pitch + CITY.pitch / 2 - CITY.lotHalf }
  const corner = { x: 2 * CITY.pitch + CITY.lane, z: 3 * CITY.pitch + CITY.lane }
  put(xz, 3, corner.x, lot.z + 2.5) // up the west face of the lot
  const round = { x: lot.x + 2.5, z: corner.z } // along the south face, round the corner
  assert.equal(whyNotRally(corner, xz, 3, round.x, round.z), 'no sidewalk from where they stand to the rally point')
  // The same recruit sent to the corner itself, or along their own face, walks the sidewalk.
  assert.equal(whyNotRally(corner, xz, 3, corner.x, corner.z), null)
  assert.equal(whyNotRally(corner, xz, 3, corner.x, lot.z + 6), null)
  // Someone already at the corner may be sent round it.
  put(xz, 4, corner.x, corner.z)
  assert.equal(whyNotRally(corner, xz, 4, round.x, round.z), null)
})
