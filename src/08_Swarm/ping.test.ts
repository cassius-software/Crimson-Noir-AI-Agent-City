// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the ping (ping.ts) and the head's look ray (head.ts aimRay): the ray is the
 * camera's forward for any yaw and pitch (checked against a real three.js camera, so the two can never disagree);
 * the pick meets the nearest of overlapping people, cars and poles, falls back to the ground, respects PING_RANGE,
 * never picks the player's own row or a hidden row, and refuses a ray that is not a number; the board keeps its
 * lifetimes, its one-per-half-second rate and its bound; the rally plan asks only Active recruits to only sidewalk
 * points within RALLY_RANGE of the operator and says why not otherwise; and no string the module ships uses a
 * word the console forbids. It also pins the module's imports: the page's own numbers, nothing of the realm.
 * What breaks if it is removed? A ping could land beside what the user looked at, flood the board, send a recruit
 * into the road or beyond the tether, or ship a word the product does not use, unnoticed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PerspectiveCamera, Vector3 } from 'three/webgpu'
import { POLES, type Furniture } from '../01_Initialize_World/city.ts'
import { INTERVIEW_DISTANCE, onRoad, RELEASE_DISTANCE } from '../03_Spawn_Agents/skills.ts'
import { chassisBox } from '../07_Execute_Actions/car.ts'
import { aimRay, EYE_HEIGHT, HeadRig, type AimRay } from '../07_Execute_Actions/head.ts'
import { PERSON, POSE, type RecruitView } from '../07_Execute_Actions/simProtocol.ts'
import {
  PING_INTERVAL_S, PING_KINDS, PING_MAX, PING_RANGE, PING_TTL_S, PING_WORDS, PingBoard, pickPing, pingLine, RALLY_MARGIN, RALLY_RANGE, rallyPlan,
  type Pick, type PingKind, type PingWorld,
} from './ping.ts'

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps
/** Words the console forbids in anything it prints (commands.test.ts), and the combat words 14A has no use for. */
const FORBIDDEN = /\b(attack|kill|weapon|target|shoot|gun|violence|injur\w*|damage|hit|strike|fire)\b/i

const ray = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): AimRay => ({ ox, oy, oz, dx, dy, dz })
/** The look ray of a standing head at (x, EYE_HEIGHT, z) turned to yaw and pitch. */
const look = (x: number, z: number, yaw: number, pitch: number): AimRay => aimRay({ x, y: EYE_HEIGHT, z, yaw, pitch }, ray(0, 0, 0, 0, 0, 0))

/** A crowd render frame of `agents` rows, every row hidden (folded below the street) but the ones given as [row, x, y, z]. */
function frameOf(agents: number, rows: [number, number, number, number][]): Float32Array {
  const f = new Float32Array(4 * agents)
  for (let i = 0; i < agents; i++) f[4 * i + 1] = -100
  for (const [i, x, y, z] of rows) { f[4 * i] = x; f[4 * i + 1] = y; f[4 * i + 2] = z }
  return f
}

/** A pose buffer of cars at [x, y, z, heading] (chassis origin), and their SUV flags. */
function fleet(cars: [number, number, number, number][], suv: boolean[] = cars.map(() => false)): { poses: Float32Array; suv: boolean[] } {
  const poses = new Float32Array(POSE.stride * cars.length)
  cars.forEach(([x, y, z, h], i) => {
    const o = i * POSE.stride
    poses[o + POSE.x] = x; poses[o + POSE.y] = y; poses[o + POSE.z] = z; poses[o + POSE.heading] = h; poses[o + POSE.qw] = 1
  })
  return { poses, suv }
}

const NOTHING: Furniture = { lamps: [], trees: [], signals: [] }
const EMPTY = fleet([])
const world = (w: Partial<PingWorld> = {}): PingWorld => ({ frame: null, agents: 0, poses: EMPTY.poses, suv: EMPTY.suv, furniture: NOTHING, ...w })
const pick = (): Pick => ({ kind: 'point', index: -1, x: 0, y: 0, z: 0, distance: 0 })

const view = (agent: number, arrived: boolean, x = NaN, z = NaN): RecruitView => ({
  agent, serial: agent, skill: 'rust', state: arrived ? 'Active' : 'Interviewing', arrived, skills: ['rust'], distance: NaN, x, z, seconds: 0,
})

// ---------------------------------------------------------------- the ray

test('aimRay is the head forward (−sin yaw·cos pitch, sin pitch, −cos yaw·cos pitch), and the camera\'s own forward', () => {
  const rig = new HeadRig(), cam = new PerspectiveCamera()
  const out = ray(0, 0, 0, 0, 0, 0)
  for (let yaw = -7; yaw <= 7; yaw += 0.53) {
    for (let pitch = -1.4; pitch <= 1.4; pitch += 0.35) {
      const r = aimRay({ x: 3, y: 1.7, z: -2, yaw, pitch }, out)
      assert.equal(r, out, 'written into out')
      assert.ok(near(r.dx, -Math.sin(yaw) * Math.cos(pitch)) && near(r.dy, Math.sin(pitch)) && near(r.dz, -Math.cos(yaw) * Math.cos(pitch)), `formula at ${yaw}, ${pitch}`)
      assert.ok(near(Math.hypot(r.dx, r.dy, r.dz), 1), 'unit')
      assert.deepEqual([r.ox, r.oy, r.oz], [3, 1.7, -2])
      rig.onFoot(cam, 3, 0, -2, yaw, pitch, 1 / 60)
      const f = cam.getWorldDirection(new Vector3())
      const want = aimRay(rig.pose, ray(0, 0, 0, 0, 0, 0))
      assert.ok(near(f.x, want.dx) && near(f.y, want.dy) && near(f.z, want.dz), `camera at ${yaw}, ${pitch}`)
      assert.ok(near(cam.position.x, want.ox) && near(cam.position.y, want.oy) && near(cam.position.z, want.oz))
    }
  }
})

test('aimRay: a non-finite angle looks straight ahead (0, 0, −1); a non-finite eye leaves the origin as it was', () => {
  const out = ray(1, 2, 3, 9, 9, 9)
  aimRay({ x: NaN, y: 1.7, z: 0, yaw: 0.4, pitch: 0.1 }, out)
  assert.deepEqual([out.ox, out.oy, out.oz], [1, 2, 3])
  assert.ok(near(out.dx, -Math.sin(0.4) * Math.cos(0.1)))
  aimRay({ x: 5, y: 6, z: 7, yaw: NaN, pitch: 0 }, out)
  assert.deepEqual([out.ox, out.oy, out.oz, out.dx, out.dy, out.dz], [5, 6, 7, 0, 0, -1])
  aimRay({ x: 5, y: 6, z: 7, yaw: 0, pitch: Infinity }, out)
  assert.deepEqual([out.dx, out.dy, out.dz], [0, 0, -1])
})

// ---------------------------------------------------------------- the pick

test('a person 5 m straight ahead is met as that row, at the front of their capsule', () => {
  const w = world({ frame: frameOf(8, [[5, 0, 0, -5]]), agents: 8 })
  const out = pick()
  assert.equal(pickPing(look(0, 0, 0, 0), w, out), true)
  assert.equal(out.kind, 'person')
  assert.equal(out.index, 5)
  // The body is 1.8 m tall: at eye height the ray meets the top cap (its sphere centred at 1.5 m), not the cylinder band.
  const cap = 5 - Math.sqrt(PERSON.radius ** 2 - (EYE_HEIGHT - PERSON.radius - 2 * PERSON.halfHeight) ** 2)
  assert.ok(near(out.distance, cap) && near(out.x, 0) && near(out.y, EYE_HEIGHT) && near(out.z, -cap))
  // Lower, the band: the front of the capsule is PERSON.radius before the row's centre.
  assert.equal(pickPing(ray(0, 1, 0, 0, 0, -1), w, out), true)
  assert.ok(near(out.distance, 5 - PERSON.radius) && near(out.y, 1))
  // Over the head (1.8 m) at 5 m: the ray clears the body.
  assert.equal(pickPing(ray(0, 2 * PERSON.radius + 2 * PERSON.halfHeight + 0.01, 0, 0, 0, -1), w, out), false)
})

test('the nearest of overlapping candidates wins: a car before a person, a pole before both, the nearer of two people', () => {
  const frame = frameOf(8, [[2, 0, 0, -5], [3, 0, 0, -9]])
  const car = fleet([[0, 0.56, -3, 0]])
  const out = pick()
  // The car's chassis (its near face at z = −3 + hx) in front of row 2; the ray is at y = 1 to pass under the roof line.
  assert.equal(pickPing(ray(0, 1, 0, 0, 0, -1), world({ frame, agents: 8, ...car }), out), true)
  assert.equal(out.kind, 'car')
  assert.equal(out.index, 0)
  assert.ok(near(out.distance, 3 - chassisBox(false).hx))
  // A lamp closer still.
  const furniture: Furniture = { lamps: [[0, -0.6, 0]], trees: [], signals: [] }
  assert.equal(pickPing(ray(0, 1, 0, 0, 0, -1), world({ frame, agents: 8, ...car, furniture }), out), true)
  assert.equal(out.kind, 'pole')
  assert.equal(out.index, 0)
  assert.ok(near(out.distance, 0.6 - POLES.lamp.radius))
  // Nobody in front: the nearer person, not the first row.
  assert.equal(pickPing(look(0, 0, 0, 0), world({ frame: frameOf(8, [[3, 0, 0, -9], [6, 0, 0, -4]]), agents: 8 }), out), true)
  assert.equal(out.index, 6)
})

test('poles: lamps, then trees, then signals by index; missed beyond their radius; a ray over the top misses', () => {
  const furniture: Furniture = { lamps: [[30, 30, 0], [0, -8, 0]], trees: [[0, -12, 1]], signals: [[0, -16, 0, 0]] }
  const out = pick()
  assert.equal(pickPing(look(0, 0, 0, 0), world({ furniture }), out), true)
  assert.equal(out.kind, 'pole')
  assert.equal(out.index, 1, 'the second lamp')
  assert.ok(near(out.distance, 8 - POLES.lamp.radius))
  // Just past the lamp's edge: the tree behind it.
  const edge = POLES.lamp.radius + 0.01
  assert.equal(pickPing(ray(edge, 1.7, 0, 0, 0, -1), world({ furniture }), out), true)
  assert.equal(out.index, 2, 'the tree')
  assert.equal(pickPing(ray(POLES.tree.radius + 0.01, 1.7, 0, 0, 0, -1), world({ furniture }), out), false, 'nothing: a level ray meets no ground')
  // A signal pole counts after every lamp and tree.
  const signalOnly: Furniture = { lamps: [[30, 30, 0]], trees: [[31, 31, 1]], signals: [[0, -16, 0, 0]] }
  assert.equal(pickPing(look(0, 0, 0, 0), world({ furniture: signalOnly }), out), true)
  assert.equal(out.index, 2, 'the signal')
  assert.ok(near(out.distance, 16 - POLES.signal.radius))
  // Over the lamp's top (6.2 m) at 8 m: pitched up enough to clear it, and the sky beyond.
  assert.equal(pickPing(look(0, 0, 0, Math.atan2(POLES.lamp.height + 0.5 - EYE_HEIGHT, 8)), world({ furniture }), out), false)
})

test('the ground is the fallback: looking down lands on y = 0 where the ray crosses it', () => {
  const out = pick()
  assert.equal(pickPing(look(0, 0, 0, -Math.PI / 4), world(), out), true)
  assert.equal(out.kind, 'point')
  assert.equal(out.index, -1)
  assert.ok(near(out.x, 0) && near(out.y, 0) && near(out.z, -EYE_HEIGHT) && near(out.distance, EYE_HEIGHT * Math.SQRT2))
  // Turned: yaw π/2 looks along −x.
  assert.equal(pickPing(look(10, 5, Math.PI / 2, -Math.PI / 4), world(), out), true)
  assert.ok(near(out.x, 10 - EYE_HEIGHT) && near(out.z, 5))
  // A person standing where the ground would be met is nearer than the ground.
  assert.equal(pickPing(look(0, 0, 0, -Math.PI / 4), world({ frame: frameOf(4, [[1, 0, 0, -1.7]]), agents: 4 }), out), true)
  assert.equal(out.kind, 'person')
})

test('PING_RANGE: nothing beyond it, the sky never, and the range argument moves the limit', () => {
  const out = pick()
  assert.equal(PING_RANGE, 60)
  assert.equal(pickPing(look(0, 0, 0, 0.3), world(), out), false, 'the sky')
  assert.equal(pickPing(look(0, 0, 0, 0), world(), out), false, 'level, nothing')
  const far = world({ frame: frameOf(4, [[1, 0, 0, -70]]), agents: 4 })
  assert.equal(pickPing(look(0, 0, 0, 0), far, out), false)
  assert.equal(pickPing(look(0, 0, 0, 0), far, out, 80), true)
  assert.equal(pickPing(look(0, 0, 0, 0), world({ frame: frameOf(4, [[1, 0, 0, -59]]), agents: 4 }), out), true)
  // The ground 61 m out is beyond the range; 59 m out is not.
  assert.equal(pickPing(look(0, 0, 0, -Math.atan2(EYE_HEIGHT, 61)), world(), out), false)
  assert.equal(pickPing(look(0, 0, 0, -Math.atan2(EYE_HEIGHT, 59)), world(), out), true)
  assert.ok(out.distance < PING_RANGE)
})

test('row 0 (the player), hidden rows, a capsule the eye is inside, and rows with no numbers are never picked', () => {
  const out = pick()
  assert.equal(pickPing(look(0, 0, 0, 0), world({ frame: frameOf(4, [[0, 0, 0, -5]]), agents: 4 }), out), false, 'row 0')
  // The eye at y −48.8: a row with feet at −50.5 is hidden (folded below −50); feet at −49.9 are not.
  assert.equal(pickPing(ray(0, -48.8, 0, 0, 0, -1), world({ frame: frameOf(4, [[1, 0, -50.5, -5]]), agents: 4 }), out), false, 'hidden')
  assert.equal(pickPing(ray(0, -48.8, 0, 0, 0, -1), world({ frame: frameOf(4, [[1, 0, -49.9, -5]]), agents: 4 }), out), true)
  // Passing through someone (ghost mode): the one behind them is met.
  assert.equal(pickPing(look(0, 0, 0, 0), world({ frame: frameOf(4, [[1, 0.1, 0, 0], [2, 0, 0, -6]]), agents: 4 }), out), true)
  assert.equal(out.index, 2)
  assert.equal(pickPing(look(0, 0, 0, 0), world({ frame: frameOf(4, [[1, NaN, 0, -5]]), agents: 4 }), out), false)
  // Only `agents` rows count, whatever the frame's length.
  assert.equal(pickPing(look(0, 0, 0, 0), world({ frame: frameOf(4, [[3, 0, 0, -5]]), agents: 3 }), out), false)
})

test('cars: the chassis box of a sedan or an SUV at its pose and heading; a car with no numbers is skipped', () => {
  const out = pick()
  // Heading π/2: forward +x, so the box is long along x and 2·hz wide across z; the ray along −z meets its side.
  const c = chassisBox(true)
  const w = world({ ...fleet([[0, 0.56, -6, Math.PI / 2]], [true]) })
  assert.equal(pickPing(ray(1.5, 0.9, 0, 0, 0, -1), w, out), true)
  assert.equal(out.kind, 'car')
  assert.ok(near(out.distance, 6 - c.hz))
  assert.equal(pickPing(ray(c.hx + 0.1, 0.9, 0, 0, 0, -1), w, out), false, 'past its nose')
  assert.equal(pickPing(ray(1.5, 0.56 + c.y + c.hy + 0.05, 0, 0, 0, -1), w, out), false, 'over its roof')
  assert.equal(pickPing(ray(0, 0.9, 0, 0, 0, -1), world({ ...fleet([[0, NaN, -6, 0]]) }), out), false)
})

test('a ray that is not a number, or has no direction, picks nothing and leaves out alone; a long direction is normalised', () => {
  const out = pick()
  const w = world({ frame: frameOf(4, [[1, 0, 0, -5]]), agents: 4 })
  for (const r of [ray(NaN, 1.7, 0, 0, 0, -1), ray(0, 1.7, 0, NaN, 0, -1), ray(0, 1.7, 0, 0, 0, 0), ray(0, Infinity, 0, 0, 0, -1)]) {
    assert.equal(pickPing(r, w, out), false)
    assert.deepEqual(out, pick())
  }
  assert.equal(pickPing(ray(0, 1, 0, 0, 0, -7), w, out), true)
  assert.ok(near(out.distance, 5 - PERSON.radius))
})

// ---------------------------------------------------------------- the board

test('the board: ids in order, one ping per PING_INTERVAL_S, each kind\'s lifetime, snapshot and clear', () => {
  const b = new PingBoard()
  const p = pick()
  const a = b.place('go', p, 0)
  assert.ok(a && a.id === 1 && a.kind === 'go' && a.until === PING_TTL_S.go)
  assert.equal(b.place('look', p, 0.3), null, 'too soon')
  assert.equal(b.place('look', p, PING_INTERVAL_S)?.id, 2)
  assert.equal(PING_INTERVAL_S, 0.5)
  assert.deepEqual(b.alive(1).map((q) => q.id), [1, 2])
  assert.deepEqual(b.alive(PING_TTL_S.look + 0.5).map((q) => q.id), [1], 'the look expired')
  assert.deepEqual(b.alive(PING_TTL_S.go - 0.001).map((q) => q.id), [1])
  assert.deepEqual(b.alive(PING_TTL_S.go), [], 'the go expired')
  assert.equal(b.newest(PING_TTL_S.go), null)
  const c = b.place('gather', { ...p, kind: 'person', index: 12, x: 3, y: 0.2, z: -4 }, 20)
  assert.ok(c)
  assert.deepEqual(b.snapshot(24), [{ id: 3, kind: 'gather', pick: 'person', index: 12, x: 3, z: -4, age: 4, left: PING_TTL_S.gather - 4 }])
  assert.equal(b.newest(24)?.id, 3)
  assert.equal(b.clear(), 1)
  assert.equal(b.size, 0)
  assert.equal(b.clear(), 0)
  for (const k of PING_KINDS) assert.ok(PING_TTL_S[k] > 0 && PING_WORDS[k].length > 0)
})

test('the board is bounded to PING_MAX, oldest dropped, and refuses an unknown kind or a number that is not one', () => {
  const b = new PingBoard()
  const p = pick()
  for (let i = 0; i < PING_MAX + 4; i++) assert.ok(b.place('wait', p, i))
  assert.equal(b.size, PING_MAX)
  assert.deepEqual(b.alive(PING_MAX + 4).map((q) => q.id), Array.from({ length: PING_MAX }, (_, i) => i + 5))
  assert.equal(b.place('stop' as PingKind, p, 100), null)
  assert.equal(b.place('go', p, NaN), null)
  assert.equal(b.place('go', { ...p, x: NaN }, 100), null)
  assert.equal(b.place('go', { ...p, index: 1.5 }, 100), null)
  assert.equal(b.size, PING_MAX, 'nothing placed')
  // A clock that went back (a reset) is not a rate limit.
  assert.ok(b.place('go', p, 100))
  assert.ok(b.place('go', p, 1))
  assert.ok(Object.isFrozen(b.newest(1)))
})

test('pingLine is one ASCII line without the words the console forbids', () => {
  const b = new PingBoard()
  const a = b.place('go', { kind: 'person', index: 12, x: 312.44, y: 0, z: 88.06, distance: 4 }, 10)!
  const line = pingLine(a, 14.2)
  assert.equal(line, 'ping 1  go  person 12 at (312.4, 88.1)  4 s ago')
  const g = b.place('look', { kind: 'point', index: -1, x: -1.26, y: 0, z: 0.04, distance: 4 }, 11)!
  assert.equal(pingLine(g, 11), 'ping 2  look  point at (-1.3, 0.0)  0 s ago')
  for (const l of [line, pingLine(g, NaN)]) {
    assert.ok(l.length <= 80 && /^[\x20-\x7e]+$/.test(l))
    assert.doesNotMatch(l, FORBIDDEN)
  }
})

// ---------------------------------------------------------------- the rally

/** The sidewalk south of the street along z = 0: the band 4 < z < 7 (city.ts roadHalf, lotHalf), mid-block in x. */
const OP = { x: 20, z: 5.5 }
const at = (x: number, z: number): Pick => ({ kind: 'point', index: -1, x, y: 0, z, distance: 5 })

test('RALLY_RANGE keeps a rallied recruit inside the tether measured from the operator, with the standoff and a margin', () => {
  assert.equal(RALLY_RANGE, 9)
  assert.ok(RALLY_RANGE < RELEASE_DISTANCE - INTERVIEW_DISTANCE)
  assert.ok(RALLY_RANGE > INTERVIEW_DISTANCE)
  assert.ok(RALLY_MARGIN >= 1 && near(RALLY_MARGIN, RELEASE_DISTANCE - INTERVIEW_DISTANCE - RALLY_RANGE))
  assert.ok(!onRoad(OP.x, OP.z) && !onRoad(OP.x + 6, OP.z) && onRoad(OP.x, 0), 'the fixture stands on the sidewalk by a road')
})

test('rallyPlan asks the earliest-joined Active recruit, or the one named, to a sidewalk point within range', () => {
  const b = new PingBoard()
  b.place('go', at(OP.x + 6, OP.z), 1)
  const recruits = [view(7, false), view(12, true, OP.x - 1, OP.z), view(15, true, OP.x + 1, OP.z)]
  assert.deepEqual(rallyPlan(b, recruits, OP, 2), { request: { agent: 12, x: OP.x + 6, z: OP.z }, reason: null })
  assert.deepEqual(rallyPlan(b, recruits, OP, 2, 15), { request: { agent: 15, x: OP.x + 6, z: OP.z }, reason: null })
  assert.ok(Object.isFrozen(rallyPlan(b, recruits, OP, 2).request))
  // A gather ping is a walk too; a person ping sends them to that person's spot; a pole's base is a place to stand.
  b.place('gather', { kind: 'person', index: 40, x: OP.x + 3, y: 1, z: OP.z + 0.5, distance: 3 }, 2)
  assert.deepEqual(rallyPlan(b, recruits, OP, 3), { request: { agent: 12, x: OP.x + 3, z: OP.z + 0.5 }, reason: null })
  b.place('go', { kind: 'pole', index: 2, x: OP.x - 4, y: 2, z: OP.z - 1, distance: 3 }, 3)
  assert.equal(rallyPlan(b, recruits, OP, 4).request?.agent, 12)
  // A recruit whose position is not measured yet is still asked: the realm re-checks the path on its own reading.
  assert.equal(rallyPlan(b, [view(9, true)], OP, 4).request?.agent, 9)
  // The newest ping counts, even once the older walk ping would still stand.
  b.place('look', at(OP.x + 2, OP.z), 5)
  assert.equal(rallyPlan(b, recruits, OP, 6).request, null)
})

test('rallyPlan refuses, with a reason, everything the tether and the road forbid', () => {
  const b = new PingBoard()
  const active = [view(12, true, OP.x - 1, OP.z)]
  const reasons: string[] = []
  const refuse = (plan: ReturnType<typeof rallyPlan>, why: RegExp) => {
    assert.equal(plan.request, null)
    assert.ok(plan.reason && why.test(plan.reason), `${plan.reason} ~ ${why}`)
    reasons.push(plan.reason!)
  }
  refuse(rallyPlan(b, active, null, 1), /on foot/)
  refuse(rallyPlan(b, active, { x: NaN, z: 0 }, 1), /nowhere/)
  refuse(rallyPlan(b, active, OP, 1), /nothing is pinged/)
  b.place('look', at(OP.x + 2, OP.z), 1)
  refuse(rallyPlan(b, active, OP, 2), /look ping asks nobody/)
  b.place('wait', at(OP.x + 2, OP.z), 2)
  refuse(rallyPlan(b, active, OP, 3), /wait ping asks nobody/)
  b.place('go', at(OP.x + 2, OP.z), 3)
  refuse(rallyPlan(b, [], OP, 4), /nobody is tethered/)
  refuse(rallyPlan(b, [view(7, false)], OP, 4), /nobody is tethered/)
  refuse(rallyPlan(b, [view(7, false), ...active], OP, 4, 7), /agent 7 is still walking over/)
  refuse(rallyPlan(b, active, OP, 4, 99), /agent 99 is not tethered/)
  refuse(rallyPlan(b, active, OP, PING_TTL_S.go + 3), /nothing is pinged/)
  b.place('go', at(OP.x, 0), 20)
  refuse(rallyPlan(b, active, OP, 21), /into the road/)
  b.place('go', at(OP.x + RALLY_RANGE + 0.01, OP.z), 21)
  refuse(rallyPlan(b, active, OP, 22), new RegExp(`within ${RALLY_RANGE} m`))
  b.place('go', at(OP.x + RALLY_RANGE - 0.01, OP.z), 22)
  assert.equal(rallyPlan(b, active, OP, 23).request?.agent, 12, 'just inside the range')
  // Across the street from where the recruit stands, though within range of the operator: no sidewalk path.
  b.place('go', at(OP.x, OP.z), 23)
  refuse(rallyPlan(b, [view(12, true, OP.x, -OP.z)], OP, 24), /no sidewalk/)
  b.place('go', { kind: 'car', index: 0, x: OP.x + 2, y: 1, z: OP.z, distance: 3 }, 24)
  refuse(rallyPlan(b, active, OP, 25), /not a place to stand/)
  for (const r of reasons) {
    assert.doesNotMatch(r, FORBIDDEN)
    assert.ok(/^[\x20-\x7e]+$/.test(r), `ascii: ${r}`)
  }
})

// ---------------------------------------------------------------- the module

test('ping.ts reads the page\'s own numbers and nothing else: pinned imports, no engine, no command, no clock, no randomness, no forbidden word', () => {
  const src = readFileSync(new URL('./ping.ts', import.meta.url), 'utf8')
  assert.deepEqual([...src.matchAll(/^import .*$/gm)].map((m) => m[0]), [
    "import { POLES, type Furniture } from '../01_Initialize_World/city.ts'",
    "import { INTERVIEW_DISTANCE, onRoad, RELEASE_DISTANCE, sidewalkPath } from '../03_Spawn_Agents/skills.ts'",
    "import { chassisBox } from '../07_Execute_Actions/car.ts'",
    "import type { AimRay } from '../07_Execute_Actions/head.ts'",
    "import { PERSON, POSE, type RecruitView } from '../07_Execute_Actions/simProtocol.ts'",
  ])
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  for (const banned of [/\bsend\s*\(/, /postMessage/, /dismiss/, /\bwindow\b/, /\bdocument\b/, /setTimeout|setInterval|requestAnimationFrame/, /\bDate\b|performance\./, /Math\.random/]) {
    assert.doesNotMatch(code, banned)
  }
  assert.doesNotMatch(src, /target/i, 'not even in a comment')
  for (const s of src.matchAll(/'([^'\n]*)'|`([^`\n]*)`/g)) assert.doesNotMatch(s[1] ?? s[2], FORBIDDEN, s[0])
  for (const w of Object.values(PING_WORDS)) assert.doesNotMatch(w, FORBIDDEN)
  assert.match(src, /^ \* Why does this file exist\?/m)
  assert.match(src, /^ \* What breaks if it is removed\?/m)
})
