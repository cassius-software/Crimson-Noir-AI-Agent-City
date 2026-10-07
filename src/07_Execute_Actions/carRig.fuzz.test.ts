/**
 * Why does this file exist? It is the property-based fuzzing of the car rules the page and the room share
 * (carRig.ts), seeded and replayable (02_Define_The_Rules/property.ts): the Ring-0 speed clamp never speeds a car up,
 * never leaves one past the cap, keeps its direction and leaves one under the cap untouched, whatever the velocity
 * (a non-number included: it is the audit's to name, never the clamp's to invent); the exit rule always puts the
 * driver EXIT_SIDE beside the chassis, on the left unless the left is a building lot; a chassis heading survives its
 * own quaternion; and Ackermann steering turns the inner wheel tighter, symmetric left and right, inside a right
 * angle. These are the rules the room checks a door against, so they are fuzzed where they are written.
 * What breaks if it is removed? A heading or a velocity nobody tried could put a driver somewhere the room's check
 * does not expect, or a clamp could add speed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CITY_SIZE, inLot } from '../01_Initialize_World/city.ts'
import { forAll, nastyNumber } from '../02_Define_The_Rules/property.ts'
import { ackermann, clampSpeed, EXIT_SIDE, exitPoint, headingOf, yawQuat } from './carRig.ts'

test('the speed clamp never adds speed, never leaves a car past the cap, keeps its direction, and leaves one under it alone', () => {
  forAll('clamp', { seed: 0xc1a, runs: 30_000 }, (g) => {
    const v = { x: g.bool(0.05) ? nastyNumber(g) : g.float(-120, 120), y: g.float(-5, 5), z: g.float(-120, 120) }
    return { v, max: g.pick([50, g.float(0, 60)]) }
  }, ({ v, max }) => {
    let set: { x: number; y: number; z: number } | null = null
    const body = { linvel: () => ({ ...v }), setLinvel: (u: { x: number; y: number; z: number }) => { set = u } }
    const capped = clampSpeed(body as never, max)
    const before = Math.hypot(v.x, v.y, v.z)
    if (!(before > max) || !Number.isFinite(before)) {
      assert.equal(capped, false)
      assert.equal(set, null, 'a car under the cap, or a velocity that is not a number, is not touched')
      return
    }
    assert.equal(capped, true)
    const u = set as unknown as { x: number; y: number; z: number }
    const after = Math.hypot(u.x, u.y, u.z)
    assert.ok(after <= max * (1 + 1e-12) && after <= before, `${before} → ${after} (cap ${max})`)
    // The same direction: the unit vectors agree (each scaled on its own, so a velocity near the largest double does
    // not overflow the comparison).
    const off = Math.hypot(u.x / after - v.x / before, u.y / after - v.y / before, u.z / after - v.z / before)
    assert.ok(off < 1e-9, `direction kept (${off})`)
  })
})

test('the exit rule: EXIT_SIDE beside the chassis, on the driver\'s left unless that is a building lot', () => {
  forAll('exit', { seed: 0xe21, runs: 30_000 }, (g) => ({ x: g.float(0, CITY_SIZE), z: g.float(0, CITY_SIZE), heading: g.float(-Math.PI * 4, Math.PI * 4) }), ({ x, z, heading }) => {
    const p = exitPoint(x, z, heading)
    assert.ok(Math.abs(Math.hypot(p.x - x, p.z - z) - EXIT_SIDE) < 1e-9)
    const left = { x: x + Math.cos(heading) * EXIT_SIDE, z: z - Math.sin(heading) * EXIT_SIDE }
    const onLeft = Math.hypot(p.x - left.x, p.z - left.z) < 1e-9
    // Perpendicular to the way the car faces (forward is (sin h, cos h)).
    assert.ok(Math.abs((p.x - x) * Math.sin(heading) + (p.z - z) * Math.cos(heading)) < 1e-9)
    if (!onLeft) assert.ok(inLot(left.x, left.z, 0.4), 'the right side only when the left is a lot')
    // Deterministic: the room computes the same point from the same chassis.
    assert.deepEqual(exitPoint(x, z, heading), p)
  })
})

test('a chassis heading survives its quaternion; Ackermann turns the inner wheel tighter, symmetric, inside a right angle', () => {
  forAll('heading', { seed: 0x4ead, runs: 30_000 }, (g) => ({ h: g.float(-Math.PI, Math.PI), steer: g.float(-0.6, 0.6) }), ({ h, steer }) => {
    // The chassis faces +x of its own frame: its yaw is the heading less a quarter turn.
    const back = headingOf(yawQuat(h - Math.PI / 2))
    const d = Math.atan2(Math.sin(back - h), Math.cos(back - h))
    assert.ok(Math.abs(d) < 1e-12, `heading ${h} → ${back}`)
    const l = ackermann(steer, 1), r = ackermann(steer, -1)
    assert.ok(Math.abs(l) < Math.PI / 2 && Math.abs(r) < Math.PI / 2)
    assert.ok(Math.abs(ackermann(-steer, 1) + r) < 1e-12, 'symmetric left and right')
    if (steer > 1e-6) assert.ok(l > steer && r < steer && r > 0, 'a left turn: the left (inner) wheel tighter')
    if (steer === 0) assert.deepEqual([l, r], [0, 0])
  })
})
