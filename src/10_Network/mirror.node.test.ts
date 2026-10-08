// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the headless Ring-0 mirror (mirror.node.ts) is the authority the room needs: that
 * an honest client's prediction (the page's own physics realm, SimCore, as the worker runs it, in a network room) and
 * the mirror's truth agree to the bit for the same inputs, through the seeded city's walls, at every substep count a
 * frame can bring, on foot and at the wheel of the fleet's cars, through doors and corrections; and that every lie a
 * client can tell about where it is (a speed hack, a velocity past a run, a wall walked through, a car that is not
 * where it says, a chassis off the room's car, an exit point off the room's, a mode without a door, a hop from car to
 * car) is refused, with the truth left exactly as it was on foot and the room's car kept as the truth at the wheel. It
 * also pins the Ring-0 person audit, the spawns, a departure, and what a move costs.
 * What breaks if it is removed? The room could snap honest players for nothing, or keep a cheater's word, unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CITY, CITY_SIZE, generateCity, inLot, streetFurniture } from '../01_Initialize_World/city.ts'
import { RING0, Ring0Auditor } from '../02_Define_The_Rules/ring0.ts'
import { poseAt, projectOnto } from '../06_Make_Decisions/tracks.ts'
import { EXIT_SIDE, HELD_CARS } from '../07_Execute_Actions/carRig.ts'
import { SimCore } from '../07_Execute_Actions/simCore.ts'
import { doorOf, ENTER_RANGE, footWish, MODES, POSE, RUN, type CarBodyState, type DriveControls, type FootControls, type SimCommand, type StepState } from '../07_Execute_Actions/simProtocol.ts'
import { GARAGE } from './garage.node.ts'
import { carViolation, Mirror, MIRROR, personViolation, substeps, worldOf, type MirrorPose, type MoveInput } from './mirror.node.ts'
import { LIMITS } from './replication.ts'

const SEED = 1337
const IDLE = { steer: 0, fwd: 0, back: 0, handbrake: false }
const C = CITY_SIZE / 2

let shared: Mirror | null = null
/** One mirror for the tests that only judge (building the city takes a few hundred milliseconds). */
async function mirror(): Promise<Mirror> {
  shared ??= await Mirror.create(SEED)
  return shared
}

/** A deterministic stream of numbers in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
}

/**
 * The page's realm as an honest client runs it in a network room (player 1 a ghost, simCore.ts 'room'; the city of the
 * seed, no traffic), put where the mirror spawned peer `id` (the room's welcome is a teleport), and a step that also
 * says what the client would send: the run of substeps (the walking velocity as the realm clamps it), and the claim.
 */
async function client(m: Mirror, id: number) {
  const start = m.join(id)
  const sim = await SimCore.create({ seed: SEED, cars: 0, agents: 256, boxes: generateCity(SEED), furniture: streetFurniture(SEED), spawn: m.spawnOf(id), debug: false }, null)
  const poses = new Float32Array(Math.max(1, sim.meta.count) * POSE.stride)
  let cmds: SimCommand[] = [{ c: 'room', on: true }, { c: 'teleport', x: start.x, z: start.z }]
  const step = (dt: number, foot: FootControls): MoveInput & { n: number } => {
    const st = sim.step({ dt, foot, drive: IDLE, cmds }, poses)
    cmds = []
    const n = st.physics.steps
    const w = footWish(foot.x, foot.z)
    return { mode: 'foot', segs: [[w.x, w.z, n]], heading: foot.heading, claim: { x: st.avatar.x, y: st.avatar.y, z: st.avatar.z }, n }
  }
  return { start, step, snap: (p: MirrorPose) => { cmds = [{ c: 'teleport', x: p.x, z: p.z }] } }
}

/**
 * The page's realm in a network room with the room's whole fleet on the track network, joined to mirror `m` as peer
 * `id`, and a step that reports what the engine reports (engine.ts netMoveOf): the step's door (simProtocol.ts doorOf:
 * never one a correction made or forced), then the runs in the mode the step ended in (the walking velocity as
 * the realm clamps it, or the wheel command the bouncer let through), and the claim (the capsule, or the chassis).
 */
async function roomPage(m: Mirror, id: number) {
  const start = m.join(id)
  const sim = await SimCore.create({ seed: SEED, cars: m.garage.cars, agents: 256, boxes: generateCity(SEED), furniture: streetFurniture(SEED), spawn: start, debug: false, tracks: true }, null)
  const poses = new Float32Array(sim.meta.count * POSE.stride)
  let cmds: SimCommand[] = [{ c: 'room', on: true }, { c: 'teleport', x: start.x, z: start.z }]
  const step = (o: { dt?: number; foot?: FootControls; drive?: DriveControls; cmds?: SimCommand[] } = {}): { st: StepState; input: MoveInput } => {
    const foot = o.foot ?? { x: 0, z: 0, heading: 0 }
    const st = { ...sim.step({ dt: o.dt ?? 1 / 60, foot, drive: o.drive ?? IDLE, cmds: [...cmds, ...(o.cmds ?? [])] }, poses), t: 'state' as const, id: 0 }
    cmds = []
    const n = st.physics.steps
    // The engine's own rule (simProtocol.ts doorOf): a door a correction made or forced is no door of the player's.
    const door = doorOf(st.events)
    let input: MoveInput
    if (st.driving >= 0) {
      const w = st.wheels!, o2 = st.driving * POSE.stride
      input = { mode: 'drive', segs: [[w.throttle, w.brake, w.steer, w.handbrake ? 1 : 0, n]], heading: poses[o2 + POSE.heading], claim: { x: poses[o2 + POSE.x], y: poses[o2 + POSE.y], z: poses[o2 + POSE.z] } }
    } else {
      const w = footWish(foot.x, foot.z)
      input = { mode: 'foot', segs: [[w.x, w.z, n]], heading: foot.heading, claim: { x: st.avatar.x, y: st.avatar.y, z: st.avatar.z } }
    }
    return { st, input: door ? { ...input, door } : input }
  }
  /** The room's correction, as the engine applies it: at the wheel the car in the room's state, on foot a teleport. */
  const correct = (p: MirrorPose): void => {
    cmds = p.car ? [{ c: 'netCar', i: p.car.index, state: p.car.state }] : [{ c: 'teleport', x: p.x, z: p.z }]
  }
  const chassis = (i: number) => ({ x: poses[i * POSE.stride + POSE.x], y: poses[i * POSE.stride + POSE.y], z: poses[i * POSE.stride + POSE.z], heading: poses[i * POSE.stride + POSE.heading] })
  return { start, step, correct, chassis }
}

const offOf = (p: MirrorPose, c: { x: number; y: number; z: number }) => Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z)

const same = (a: MirrorPose, b: MirrorPose) => assert.deepEqual(a, b)

test('the mirror builds the page\'s city from the seed: its world name, one fixed body, a body per peer, gone on leave', async () => {
  const m = await Mirror.create(SEED)
  assert.equal(m.world, worldOf(SEED))
  assert.equal(m.world, 'city/1337/36')
  assert.equal((await Mirror.create(SEED, 12)).world, 'city/1337/12')
  assert.equal(m.bodies, 1, 'the city is one fixed body')
  const p = m.join(1)
  m.join(2)
  assert.equal(m.bodies, 3)
  assert.equal(m.peers, 2)
  assert.throws(() => m.join(1), /already/)
  // Put down standing, the way the page is told to (a teleport).
  assert.ok(Math.abs(p.y - 0.95) < 1e-6, `y ${p.y}`)
  assert.equal(p.driving, false)
  m.leave(2)
  m.leave(2)
  assert.equal(m.bodies, 2)
  assert.throws(() => m.pose(2), /not in the mirror/)
})

test('spawns: the page\'s own spawn sidewalk, a step apart per peer, cycling, never inside a lot', async () => {
  const m = await mirror()
  assert.deepEqual(m.spawnOf(1), { x: C + CITY.lane, z: C + 12 })
  for (let id = 1; id <= 40; id++) {
    const s = m.spawnOf(id)
    assert.ok(!inLot(s.x, s.z), `peer ${id} at ${s.x}, ${s.z}`)
    assert.deepEqual(s, m.spawnOf(id + MIRROR.spawnSlots))
  }
  assert.equal(m.spawnOf(2).z - m.spawnOf(1).z, MIRROR.spawnGap)
})

test('prediction is the truth: the page\'s realm in a room and the mirror agree to the bit, walls and every substep count included', async () => {
  const m = await Mirror.create(SEED)
  const c = await client(m, 1)
  const r = rng(7)
  // Frames of 1/144 s (often no substep) to 50 ms (three), a run, a walk and a stand, past a run (the clamp), and
  // headings that keep turning into the buildings beside the spawn sidewalk.
  const dts = [1 / 144, 1 / 60, 2 / 60, 0.05]
  let worst = 0, blocked = 0, substepsSeen = 0, zero = 0
  for (let k = 0; k < 700; k++) {
    const a = Math.floor(k / 50) * 1.3 + r() * 0.4
    const speed = [0, 2, RUN, 9][Math.floor(r() * 4)]
    const foot = { x: Math.sin(a) * speed, z: Math.cos(a) * speed, heading: a }
    const before = m.pose(1)
    const input = c.step(dts[Math.floor(r() * dts.length)], foot)
    const v = m.judge(1, input)
    assert.ok(v.ok, `step ${k}: ${v.ok ? '' : v.reason}`)
    const off = Math.hypot(v.pose.x - input.claim.x, v.pose.y - input.claim.y, v.pose.z - input.claim.z)
    worst = Math.max(worst, off)
    substepsSeen += input.n
    if (input.n === 0) zero++
    // A wall: the body went less than half as far as the clamped velocity asks.
    const w = footWish(foot.x, foot.z)
    const want = Math.hypot(w.x, w.z) * input.n * MIRROR.h
    if (want > 0.05 && Math.hypot(v.pose.x - before.x, v.pose.z - before.z) < want / 2) blocked++
  }
  // In a room the realm walks player 1 as the mirror does (a ghost, put where the controller says): no world step
  // lands it through a velocity, so no last bit rounds the other way.
  assert.equal(worst, 0, `the realm and the mirror differ by ${worst} m`)
  assert.ok(zero > 0 && substepsSeen > 700, `${zero} frames without a substep, ${substepsSeen} substeps`)
  assert.ok(blocked > 20, `walls met: ${blocked} frames`)
})

test('a claim off the truth is refused and the truth stays exactly as it was: a teleport, a speed hack, a wall walked through; one off by less than the drift bound is kept as replayed', async () => {
  const m = await Mirror.create(SEED)
  const c = await client(m, 1)
  // Warm up: the welcome's teleport, a few honest frames.
  for (let k = 0; k < 10; k++) assert.ok(m.judge(1, c.step(1 / 60, { x: 0, z: 1, heading: 0 })).ok)
  const honest = c.step(1 / 60, { x: 0, z: RUN, heading: 0 })
  const before = m.pose(1)
  // Memory written: the claim 40 m along.
  const teleport = m.judge(1, { ...honest, claim: { ...honest.claim, z: honest.claim.z + 40 } })
  assert.ok(!teleport.ok && /claim 40\.\d\d m from the mirror's pose/.test(teleport.reason), JSON.stringify(teleport))
  same(teleport.pose, before)
  same(m.pose(1), before)
  // Just past the tolerance and within MIRROR.drift: the input is kept as the mirror replayed it (the honest frame
  // after every refusal above: they all put the body back exactly), and the page is to be put back; the claim moved
  // nothing.
  const nudge = m.judge(1, { ...honest, claim: { ...honest.claim, x: honest.claim.x + MIRROR.tolerance + 0.01 } })
  assert.ok(nudge.ok && nudge.resync !== undefined, JSON.stringify(nudge))
  assert.equal(offOf(nudge.pose, honest.claim), 0, 'the replay, not the claim')
  // A micrometre is the tolerance: a claim two off is kept as replayed and put back, never adopted.
  const next = c.step(1 / 60, { x: 0, z: 1, heading: 0 })
  const two = m.judge(1, { ...next, claim: { ...next.claim, z: next.claim.z + 2e-6 } })
  assert.ok(two.ok && two.resync !== undefined)
  assert.equal(offOf(two.pose, next.claim), 0)

  // A speed hack: a client that moves at three runs and says so. The mirror clamps the velocity to a run (footWish).
  const fast = { x: 0, z: 3 * RUN, heading: 0 }
  const at = m.pose(1)
  const hacked: MoveInput = { mode: 'foot', segs: [[fast.x, fast.z, 4]], heading: 0, claim: { x: at.x, y: at.y, z: at.z + 3 * RUN * 4 * MIRROR.h } }
  const sped = m.judge(1, hacked)
  assert.ok(!sped.ok, 'three runs refused')
  same(m.pose(1), at)

  // A wall: east of the spawn sidewalk is a building lot. Walk into it for two seconds, claiming the straight line.
  const m2 = await Mirror.create(SEED)
  const c2 = await client(m2, 1)
  const start = m2.pose(1)
  let claimed = { x: start.x, y: start.y, z: start.z }
  let refused = 0
  for (let k = 0; k < 120; k++) {
    const honestStep = c2.step(1 / 60, { x: RUN, z: 0, heading: Math.PI / 2 })
    claimed = { x: claimed.x + RUN * honestStep.n * MIRROR.h, y: claimed.y, z: claimed.z }
    const v = m2.judge(1, { ...honestStep, claim: claimed })
    if (!v.ok) {
      refused++
      // The room snaps the client: both take the next step from the truth.
      c2.snap(m2.settle(1))
      claimed = { x: m2.pose(1).x, y: m2.pose(1).y, z: m2.pose(1).z }
    }
  }
  const end = m2.pose(1)
  assert.ok(refused > 0, 'walking through the wall was refused')
  assert.ok(end.x < start.x + 2, `the truth stopped at the wall: x ${start.x.toFixed(2)} → ${end.x.toFixed(2)}`)
  assert.ok(inLot(start.x + 3, start.z), 'there is a lot to walk into')
})

test('after a snap the client and the mirror take the same next steps: both put down at the truth, standing', async () => {
  const m = await Mirror.create(SEED)
  const c = await client(m, 1)
  for (let k = 0; k < 30; k++) assert.ok(m.judge(1, c.step(1 / 60, { x: 1, z: RUN, heading: 0 })).ok)
  // The client lies once; the room refuses it and snaps it to the truth.
  const lie = c.step(1 / 60, { x: 1, z: RUN, heading: 0 })
  assert.ok(!m.judge(1, { ...lie, claim: { ...lie.claim, z: lie.claim.z + 5 } }).ok)
  c.snap(m.settle(1))
  // From here every honest frame is the truth again, to the bit.
  for (let k = 0; k < 120; k++) {
    const input = c.step(k % 3 === 0 ? 0.05 : 1 / 60, { x: Math.sin(k / 20) * RUN, z: Math.cos(k / 20) * RUN, heading: 0 })
    const v = m.judge(1, input)
    const off = offOf(v.pose, input.claim)
    assert.ok(v.ok && off === 0, `frame ${k} after the snap: ${v.ok ? `${off} m` : v.reason}`)
  }
})

test('at the wheel the room replays the car: an honest page\'s doors, drive and return are kept to the bit; a correction carries the car', async () => {
  const m = await Mirror.create(SEED)
  const page = await roomPage(m, 1)
  const r = rng(11)
  for (let k = 0; k < 120; k++) assert.ok(m.judge(1, page.step().input).ok, `standing, frame ${k}`)
  // The room and the page put the player 2.5 m beside car 5 (a correction does that on both sides).
  const i = 5
  const c = page.chassis(i)
  const at = { x: c.x + Math.cos(c.heading) * 2.5, z: c.z - Math.sin(c.heading) * 2.5 }
  page.correct(m.place(1, at.x, at.z))
  assert.ok(m.judge(1, page.step().input).ok)
  // Into the car: the door is checked against the room's pose and the car's ring, then its first run replayed.
  const into = page.step({ cmds: [{ c: 'interact' }] })
  assert.deepEqual(into.input.door && 'enter' in into.input.door && into.input.door.enter.car, i)
  const v0 = m.judge(1, into.input)
  assert.ok(v0.ok && v0.pose.driving, JSON.stringify(v0))
  assert.equal(offOf(v0.pose, into.input.claim), 0)
  let worst = 0, frames = 0
  const drive = (n: number): void => {
    for (let k = 0; k < n; k++) {
      const dt = [1 / 144, 1 / 60, 2 / 60, 0.05][Math.floor(r() * 4)]
      const { input } = page.step({ dt, drive: { steer: (r() - 0.5) * 1.6, fwd: r() < 0.85 ? r() : 0, back: r() < 0.08 ? r() : 0, handbrake: r() < 0.02 } })
      const v = m.judge(1, input)
      assert.ok(v.ok, `frame ${frames}: ${v.ok ? '' : v.reason}`)
      worst = Math.max(worst, offOf(v.pose, input.claim))
      frames++
    }
  }
  drive(300)
  assert.equal(worst, 0)
  // A chassis claim a centimetre off (within MIRROR.drift): kept as the room replayed it, the page to be put back. Two
  // metres off: a lie, refused. Either way the room's car stays the truth: the replay of the honest run stands. The
  // correction carries the car; the page builds its car again in exactly that state, and from there both replay the
  // same car again.
  const lie = page.step({ drive: { steer: 0, fwd: 0.5, back: 0, handbrake: false } }).input
  const drifted = m.judge(1, { ...lie, claim: { ...lie.claim, x: lie.claim.x + 0.01 } })
  assert.ok(drifted.ok && drifted.resync === `chassis claim 0.01 m from the room's car`, JSON.stringify(drifted))
  assert.ok(drifted.pose.driving && offOf(drifted.pose, lie.claim) === 0, 'the replay of the honest run stands')
  const lie2 = page.step({ drive: { steer: 0, fwd: 0.5, back: 0, handbrake: false } }).input
  const refused = m.judge(1, { ...lie2, claim: { ...lie2.claim, x: lie2.claim.x + 2 } })
  assert.ok(!refused.ok && /chassis claim 2\.00 m from the room's car/.test(refused.reason), JSON.stringify(refused))
  assert.ok(refused.pose.driving && offOf(refused.pose, lie2.claim) === 0, 'the replay of the honest run stands')
  const fix = m.settle(1)
  assert.ok(fix.car && fix.car.index === i && fix.driving)
  page.correct(fix)
  drive(200)
  assert.equal(worst, 0, 'after the correction')
  // Out: the exit point is the room's own; the walk after it is replayed from there.
  const out = page.step({ cmds: [{ c: 'interact' }] })
  assert.ok(out.input.door && 'exit' in out.input.door, 'a door out')
  const v1 = m.judge(1, out.input)
  assert.ok(v1.ok && !v1.pose.driving, JSON.stringify(v1))
  assert.equal(offOf(v1.pose, out.input.claim), 0)
  for (let k = 0; k < 60; k++) assert.ok(m.judge(1, page.step({ foot: { x: 0.5, z: 0.5, heading: 0 } }).input).ok)
  // Back into the car the room holds, where it was left; driven again, and out again.
  const left = m.garage.parkedAt(1, i)!
  const near = { x: left.x + 1.6, z: left.z }
  page.correct(m.place(1, near.x, near.z))
  assert.ok(m.judge(1, page.step().input).ok)
  const back = page.step({ cmds: [{ c: 'interact' }] })
  const v2 = m.judge(1, back.input)
  assert.ok(v2.ok && v2.pose.driving, JSON.stringify(v2))
  drive(200)
  assert.equal(worst, 0, 'after the return')
  assert.ok(frames >= 700)
  assert.equal(m.garage.worlds, 1)
  m.leave(1)
  assert.equal(m.garage.worlds, 0, 'the drive world goes with the player')
})

test('every lie about a car is refused: a car out of the door\'s reach or off its ring, an exit point off the room\'s, a mode without its door', async () => {
  const m = await Mirror.create(SEED)
  const page = await roomPage(m, 1)
  for (let k = 0; k < 120; k++) assert.ok(m.judge(1, page.step().input).ok)
  const i = 9
  const c = page.chassis(i)
  const at = { x: c.x + Math.cos(c.heading) * 2.5, z: c.z - Math.sin(c.heading) * 2.5 }
  page.correct(m.place(1, at.x, at.z))
  assert.ok(m.judge(1, page.step().input).ok)
  const into = page.step({ cmds: [{ c: 'interact' }] }).input
  const door = into.door as { enter: { car: number; state: CarBodyState } }
  const st = door.enter.state
  const before = m.pose(1)
  // A car whose ring runs nowhere near this one.
  const other = m.garage.plan.findIndex((p) => Math.abs(projectOnto(m.garage.network.tracks[p.track], st.x, st.z).lateral) > 5)
  assert.ok(other >= 0)
  const lies: [string, MoveInput, RegExp][] = [
    // A car the player is not beside: the same car's state 4 m further from the player.
    ['out of the door', { ...into, door: { enter: { car: i, state: { ...st, x: st.x - Math.cos(c.heading) * 4, z: st.z + Math.sin(c.heading) * 4 } } } }, /from the room's pose/],
    // Another car's index for this car's state: its ring runs elsewhere.
    ['another ring', { ...into, door: { enter: { car: other, state: st } } }, /off its ring's lane/],
    // The car claimed at 30 m/s along its heading, past its ring's limit; launched upward; sliding sideways.
    ['too fast', { ...into, door: { enter: { car: i, state: { ...st, vx: Math.sin(c.heading) * 30, vz: Math.cos(c.heading) * 30 } } } }, /past its ring's/],
    ['launched', { ...into, door: { enter: { car: i, state: { ...st, vy: 12 } } } }, /moving up at 12\.0 m\/s/],
    ['sideways', { ...into, door: { enter: { car: i, state: { ...st, vx: Math.cos(c.heading) * 8, vz: -Math.sin(c.heading) * 8 } } } }, /sliding sideways/],
    // At a wheel with no door; on foot claiming a door out of a car it never took.
    ['no door', { ...into, door: undefined }, /at a wheel without taking one/],
    ['no car to leave', { mode: 'foot', segs: [[0, 0, 1]], heading: 0, claim: before, door: { exit: { x: before.x, z: before.z } } }, /exit: not at a wheel/],
  ]
  for (const [name, input, why] of lies) {
    const v = m.judge(1, input)
    assert.ok(!v.ok && why.test(v.reason), `${name}: ${JSON.stringify(v)}`)
    same(m.pose(1), before)
  }
  assert.equal(m.garage.driving(1), -1, 'no lie seated the player')
  // The honest door, then a drive, then an exit point 0.6 m off the room's: refused, the player still at the wheel.
  assert.ok(m.judge(1, into).ok)
  for (let k = 0; k < 60; k++) assert.ok(m.judge(1, page.step({ drive: { steer: 0.1, fwd: 0.6, back: 0, handbrake: false } }).input).ok)
  const out = page.step({ cmds: [{ c: 'interact' }] }).input
  const ex = (out.door as { exit: { x: number; z: number } }).exit
  const bad = m.judge(1, { ...out, door: { exit: { x: ex.x + 0.6, z: ex.z } } })
  assert.ok(!bad.ok && /exit: 0\.60 m from where the car lets its driver out/.test(bad.reason), JSON.stringify(bad))
  assert.ok(m.pose(1).driving)
  // On foot without leaving: refused too. The room's correction puts the page back in its car, in the room's state.
  assert.match((m.judge(1, { ...out, door: undefined }) as { reason: string }).reason, /on foot without leaving the car/)
  const fix = m.settle(1)
  assert.ok(fix.car && fix.car.index === i)
  page.correct(fix)
  const again = page.step({ drive: { steer: 0, fwd: 0.4, back: 0, handbrake: false } })
  assert.equal(again.st.driving, i, 'the page is at the wheel again')
  const v = m.judge(1, again.input)
  assert.ok(v.ok && offOf(v.pose, again.input.claim) === 0, JSON.stringify(v))
  // An exit point off by less than the door is answered with the room's own: the walk is replayed from there, so a
  // claim from the lie is refused and the player stands at the room's exit point, out of the car.
  const out2 = page.step({ cmds: [{ c: 'interact' }] }).input
  const ex2 = (out2.door as { exit: { x: number; z: number } }).exit
  const shifted = m.judge(1, { ...out2, door: { exit: { x: ex2.x + 0.4, z: ex2.z } }, claim: { ...out2.claim, x: out2.claim.x + 0.4 } })
  assert.ok(!shifted.ok && /claim .* from the mirror's pose/.test(shifted.reason), JSON.stringify(shifted))
  assert.ok(!m.pose(1).driving && Math.hypot(m.pose(1).x - ex2.x, m.pose(1).z - ex2.z) < 0.05, 'out, at the room\'s exit point')
})

test('a hop from car to car carries a player no further than a door and an exit: the bound on doors as transport', async () => {
  const m = await Mirror.create(SEED)
  m.join(1)
  // Start on the kerb 2.5 m beside the ring the most cars were seated on (the spawn sidewalk is 15 m from the nearest).
  const seated = new Map<number, number>()
  for (const c of m.garage.plan) seated.set(c.track, (seated.get(c.track) ?? 0) + 1)
  const busiest = [...seated].sort((a, b) => b[1] - a[1])[0]
  assert.ok(busiest[1] >= 2, 'a ring with two cars or more')
  const lane = poseAt(m.garage.network.tracks[busiest[0]], 0)
  m.place(1, lane.x + lane.tangentZ * 2.5, lane.z - lane.tangentX * 2.5)
  // A cheater claims the nearest car on every ring lane it can reach, then leaves it, again and again, heading one way.
  // Every enter is within the door (ENTER_RANGE) of the room's pose and every exit is where the room's chassis puts
  // it (EXIT_SIDE beside it), so a pair moves the truth at most ENTER_RANGE + EXIT_SIDE, whatever the claims say.
  const bound = ENTER_RANGE + GARAGE.enterSlack + EXIT_SIDE
  let pairs = 0, worst = 0
  for (let k = 0; k < 40; k++) {
    const p = m.pose(1)
    let best: { car: number; x: number; z: number; heading: number } | null = null
    for (let i = 0; i < m.garage.cars; i++) {
      // A car this player left is held where it was left (garage.node.ts): no use for a hop.
      if (m.garage.parkedAt(1, i)) continue
      const track = m.garage.network.tracks[m.garage.plan[i].track]
      // The lane point nearest the player, pushed toward +x (the way the cheater wants to go) along the ring.
      for (let s = 0; s < track.length; s += 1) {
        const q = poseAt(track, s)
        const d = Math.hypot(q.x - p.x, q.z - p.z)
        if (d <= ENTER_RANGE && (!best || q.x > best.x)) best = { car: i, x: q.x, z: q.z, heading: q.heading }
      }
    }
    if (!best) break
    const yaw = best.heading - Math.PI / 2
    // The numbers a page reads back from Rapier: 32-bit.
    const f = Math.fround
    const state = { x: f(best.x), y: f(0.56), z: f(best.z), qx: 0, qy: f(Math.sin(yaw / 2)), qz: 0, qw: f(Math.cos(yaw / 2)), vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 }
    const enter = m.judge(1, { mode: 'drive', segs: [[0, 0, 0, 0, 0]], heading: 0, claim: state, door: { enter: { car: best.car, state } } })
    assert.ok(enter.ok, `pair ${k}: ${enter.ok ? '' : enter.reason}`)
    const ex = m.garage.exitPoint(1)!
    const exit = m.judge(1, { mode: 'foot', segs: [[0, 0, 0]], heading: 0, claim: { x: f(ex.x), y: f(0.95), z: f(ex.z) }, door: { exit: ex } })
    const after = m.pose(1)
    worst = Math.max(worst, Math.hypot(after.x - p.x, after.z - p.z))
    assert.ok(exit.ok, `pair ${k}: ${exit.ok ? '' : exit.reason}`)
    pairs++
  }
  assert.ok(pairs >= 2, `${pairs} door pairs taken`)
  assert.ok(worst <= bound, `a pair moved the truth ${worst.toFixed(2)} m (bound ${bound.toFixed(2)})`)
  // The room's door bucket (replication.ts LIMITS.doorsPerSecond) then caps the rate: at most doorsPerSecond / 2 pairs
  // a second, so a hop chain alone is no faster than a run (replication.test.ts drives every mix through the room).
  assert.ok((worst * LIMITS.doorsPerSecond) / 2 <= RUN, `hopping at most ${((worst * LIMITS.doorsPerSecond) / 2).toFixed(2)} m/s`)
  assert.ok((bound * LIMITS.doorsPerSecond) / 2 <= RUN, `the bound: ${((bound * LIMITS.doorsPerSecond) / 2).toFixed(2)} m/s`)
})

test('a car the room does not hold goes back to its ring\'s traffic: one parked before the session, one a correction took the player out of, and the oldest past HELD_CARS', async () => {
  const CARS = HELD_CARS + 3
  const m = await Mirror.create(SEED, CARS)
  const sim = await SimCore.create({ seed: SEED, cars: CARS, agents: 64, boxes: generateCity(SEED), furniture: streetFurniture(SEED), spawn: { x: C, z: C }, debug: false, tracks: true }, null)
  const poses = new Float32Array(Math.max(1, sim.meta.count) * POSE.stride)
  const still = { x: 0, z: 0, heading: 0 }
  const step = (cmds: SimCommand[] = []) => sim.step({ dt: 1 / 60, foot: still, drive: IDLE, cmds }, poses)
  const car = (i: number) => ({ x: poses[i * POSE.stride + POSE.x], z: poses[i * POSE.stride + POSE.z], mode: MODES[poses[i * POSE.stride + POSE.mode]] })
  const offLane = (i: number): number => {
    const c = car(i)
    return Math.abs(projectOnto(m.garage.network.tracks[m.garage.plan[i].track], c.x, c.z).lateral)
  }
  /** Player 1 put beside car `i` and through its door: the car the realm says it entered (or -1). */
  const enter = (i: number): number => {
    const c = car(i)
    const st = step([{ c: 'teleport', x: c.x + 1.5, z: c.z }, { c: 'interact' }])
    return st.events.find((e) => e.e === 'entered')?.index ?? -1
  }
  step()
  // Out of a room: car 0 taken, set down 8 m off its lane, left there (parked where it stands).
  assert.equal(enter(0), 0)
  const at = car(0)
  step([{ c: 'recover', i: 0, x: at.x + 8, z: at.z + 8 }])
  step([{ c: 'interact' }])
  for (let k = 0; k < 30; k++) step()
  assert.equal(car(0).mode, 'parked')
  assert.ok(offLane(0) > 4, `left ${offLane(0).toFixed(2)} m off its lane`)
  // A session starts: the room holds no car for the player, so car 0 goes back to its lane as traffic.
  step([{ c: 'room', on: true }])
  for (let k = 0; k < 30; k++) step()
  assert.equal(car(0).mode, 'ai')
  assert.ok(offLane(0) < 0.5, `back on its lane (${offLane(0).toFixed(2)} m)`)
  // In the room: a correction takes the player out of a car (a teleport while driving): that car goes back too.
  const taken = enter(1)
  assert.ok(taken >= 0)
  step([{ c: 'teleport', x: C, z: C }])
  for (let k = 0; k < 30; k++) step()
  assert.equal(car(taken).mode, 'ai', 'a car the room took the player out of is traffic again')
  // Cars left in the room are held where they stop, HELD_CARS of them; the oldest is let go past that.
  const left: number[] = []
  for (let i = 0; i < CARS && left.length <= HELD_CARS; i++) {
    const got = enter(i)
    if (got < 0 || left.includes(got)) {
      if (got >= 0) step([{ c: 'interact' }])
      continue
    }
    step([{ c: 'interact' }])
    left.push(got)
  }
  assert.equal(left.length, HELD_CARS + 1, `${left.length} cars left`)
  step()
  assert.equal(car(left[0]).mode, 'ai', 'the oldest held car went back to traffic')
  for (const i of left.slice(1)) assert.equal(car(i).mode, 'parked', `car ${i} still held`)
})

test('a correction goes ahead of what the player queued: an E pressed while the truth was on its way acts on the truth, and no door out of a car the room never had is reported', async () => {
  const sim = await SimCore.create({ seed: SEED, cars: 4, agents: 64, boxes: generateCity(SEED), furniture: streetFurniture(SEED), spawn: { x: C, z: C }, debug: false, tracks: true }, null)
  const poses = new Float32Array(Math.max(1, sim.meta.count) * POSE.stride)
  const still = { x: 0, z: 0, heading: 0 }
  const step = (cmds: SimCommand[] = []) => sim.step({ dt: 1 / 60, foot: still, drive: IDLE, cmds }, poses)
  const drivingCar = (): void => {
    step([{ c: 'room', on: true }])
    const i = 0
    const c = { x: poses[i * POSE.stride + POSE.x], z: poses[i * POSE.stride + POSE.z] }
    const st = step([{ c: 'teleport', x: c.x + 1.5, z: c.z }, { c: 'interact' }])
    assert.ok(st.events.some((e) => e.e === 'entered'), 'at a wheel')
  }
  // The room's truth has the player on foot at the spawn, and the player pressed E in the same frame.
  drivingCar()
  const ahead = step([{ c: 'teleport', x: C, z: C }, { c: 'interact' }])
  const out = doorOf(ahead.events)
  assert.ok(out === undefined || !('exit' in out), 'the correction first: its exit is no door, and the E acts on the truth')
  // Behind the E (the order the engine used to send them in), the E is a door out that the room never had.
  drivingCar()
  const behind = step([{ c: 'interact' }, { c: 'teleport', x: C, z: C }])
  const door = doorOf(behind.events)
  assert.ok(door !== undefined && 'exit' in door, 'the E first: reported as a door out')
})

test('in a network room the realm refuses every command that would move a car behind the room\'s back; out of the room it takes them again', async () => {
  const sim = await SimCore.create({ seed: SEED, cars: 2, agents: 64, boxes: generateCity(SEED), furniture: streetFurniture(SEED), spawn: { x: C, z: C }, debug: true, tracks: true }, null)
  const poses = new Float32Array(Math.max(1, sim.meta.count) * POSE.stride)
  const still = { x: 0, z: 0, heading: 0 }
  const step = (cmds: SimCommand[]): number => sim.step({ dt: 1 / 60, foot: still, drive: IDLE, cmds }, poses).rejected
  const carMovers: SimCommand[] = [
    { c: 'reset' },
    { c: 'setMode', i: 0, mode: 'parked' },
    { c: 'recover', i: 0 },
    { c: 'intent', i: 0, throttle: 1, brake: 0, steer: 0 },
    { c: 'tune', key: 'grip', value: 2 },
    { c: 'dbgVelocity', i: 0, x: 40, y: 0, z: 0 },
    { c: 'dbgMode', i: 0, mode: 'player' },
    { c: 'dbgHazard', i: 0, ahead: 3 },
  ]
  let rejected = step([{ c: 'room', on: true }])
  for (const cmd of carMovers) {
    const now = step([cmd])
    assert.equal(now, rejected + 1, `${cmd.c} refused in a room`)
    rejected = now
  }
  rejected = step([{ c: 'room', on: false }])
  for (const cmd of carMovers) assert.equal(step([cmd]), rejected, `${cmd.c} taken out of a room`)
})

test('a page that drifts from the replay within MIRROR.drift is kept as the mirror replayed it and put back, never counted; past it, the claim is a lie', async () => {
  const m = await Mirror.create(SEED)
  const page = await Mirror.create(SEED)
  m.join(1)
  page.join(1)
  const s = m.spawnOf(1)
  m.place(1, s.x, s.z)
  page.place(1, s.x, s.z)
  const segs = [[0, RUN, 6]]
  // Fifty micrometres off the replay: no lie, and nothing to gain (the truth is the replay).
  const honest = page.walk(1, segs)
  const drifted = m.judge(1, { mode: 'foot', segs, heading: 0, claim: { x: honest.x + 50e-6, y: honest.y, z: honest.z } })
  assert.equal(drifted.ok, true)
  assert.equal(drifted.ok && drifted.resync, `claim 50.0 µm from the mirror's pose`)
  assert.deepEqual([m.pose(1).x, m.pose(1).z], [honest.x, honest.z], 'kept as the mirror replayed it, not as claimed')
  // Past MIRROR.drift: refused and undone.
  const before = m.pose(1)
  const next = page.walk(1, segs)
  const lie = m.judge(1, { mode: 'foot', segs, heading: 0, claim: { x: next.x + MIRROR.drift.foot * 2, y: next.y, z: next.z } })
  assert.equal(lie.ok, false)
  assert.match(lie.ok ? '' : lie.reason, /^claim 0\.50 m from the mirror's pose$/)
  assert.deepEqual([m.pose(1).x, m.pose(1).z], [before.x, before.z], 'undone')
  assert.deepEqual([m.counts.resynced, m.counts.refused], [1, 1])
  assert.ok(MIRROR.drift.foot >= 0.1 && MIRROR.drift.drive >= 0.5, 'well past the drifts measured (0.6 mm on foot, 1.4 mm at the wheel)')
})

test('a held car claimed where the room does not have it is refused and let go: from then on the room checks it as traffic, as the page has it', async () => {
  const m = await Mirror.create(SEED)
  m.join(1)
  const seat = m.garage.plan[0].pose
  m.place(1, seat.x + 2 * Math.cos(seat.heading), seat.z - 2 * Math.sin(seat.heading))
  const f = Math.fround
  const yaw = seat.heading - Math.PI / 2
  const state = { x: f(seat.x), y: f(0.56), z: f(seat.z), qx: 0, qy: f(Math.sin(yaw / 2)), qz: 0, qw: f(Math.cos(yaw / 2)), vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 }
  assert.ok(m.judge(1, { mode: 'drive', segs: [[0, 0, 0, 0, 0]], heading: 0, claim: state, door: { enter: { car: 0, state } } }).ok)
  const ex = m.garage.exitPoint(1)!
  assert.ok(m.judge(1, { mode: 'foot', segs: [[0, 0, 0]], heading: 0, claim: { x: f(ex.x), y: f(0.95), z: f(ex.z) }, door: { exit: ex } }).ok)
  const held = m.garage.parkedAt(1, 0)!
  assert.ok(held, 'held where it was left')
  // Claimed a metre toward the player from where the room holds it: refused, and the room lets go of it.
  const d = Math.hypot(ex.x - held.x, ex.z - held.z)
  const elsewhere = { ...held, x: f(held.x + (ex.x - held.x) / d), z: f(held.z + (ex.z - held.z) / d) }
  const out = m.judge(1, { mode: 'drive', segs: [[0, 0, 0, 0, 0]], heading: 0, claim: elsewhere, door: { enter: { car: 0, state: elsewhere } } })
  assert.equal(out.ok, false)
  assert.equal(m.garage.parkedAt(1, 0), null, 'let go: an AI car on its ring to the room from now on')
})

test('at the wheel a replay the Ring-0 audit refuses is undone: the car goes back to its last audited state, and a correction carries that', async () => {
  const m = await Mirror.create(1337)
  m.join(1)
  // Car 0 at rest where the fleet's plan starts it, the player two metres beside it.
  const seat = m.garage.plan[0].pose
  m.place(1, seat.x + 2 * Math.cos(seat.heading), seat.z - 2 * Math.sin(seat.heading))
  const f = Math.fround
  const yaw = seat.heading - Math.PI / 2
  const state = { x: f(seat.x), y: f(0.56), z: f(seat.z), qx: 0, qy: f(Math.sin(yaw / 2)), qz: 0, qw: f(Math.cos(yaw / 2)), vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 }
  const enter = m.judge(1, { mode: 'drive', segs: [[0, 0, 0, 0, 0]], heading: 0, claim: state, door: { enter: { car: 0, state } } })
  assert.ok(enter.ok, enter.ok ? '' : enter.reason)
  const audited = m.garage.chassis(1)!
  // A replay that ends below the ground floor (the room's own physics never does this: the audit is the net under it).
  const drive = m.garage.drive.bind(m.garage)
  m.garage.drive = (id, runs) => {
    const s = drive(id, runs)
    m.garage.settle(id, { ...s, y: RING0.groundFloor - 1 })
    return m.garage.chassis(id)!
  }
  const out = m.judge(1, { mode: 'drive', segs: [[1, 0, 0, 0, 10]], heading: 0, claim: audited })
  m.garage.drive = drive
  assert.equal(out.ok, false)
  assert.match(out.ok ? '' : out.reason, /^Ring-0: /)
  assert.deepEqual(m.garage.chassis(1), audited, 'back at the last audited state')
  const t = m.settle(1)
  assert.deepEqual(t.car?.state, audited, 'the correction carries the audited car')
  assert.equal(carViolation(new Ring0Auditor({ x: C, z: C }), 1, t.car!.state), null)
})

test('the Ring-0 audit on every pose the mirror keeps: a person finite, inside the slab, above the ground floor; a car under the velocity cap too', () => {
  const a = new Ring0Auditor({ x: C, z: C })
  const car = { x: C, y: 0.56, z: C, qx: 0, qy: 0, qz: 0, qw: 1, vx: 30, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 }
  assert.equal(carViolation(a, 1, car), null)
  assert.match(carViolation(a, 1, { ...car, vx: 51 }) ?? '', /past the velocity cap/)
  assert.match(carViolation(a, 1, { ...car, x: C + 1700 }) ?? '', /containment slab/)
  assert.equal(personViolation(a, 1, C, 0.95, C), null)
  assert.match(personViolation(a, 1, Number.NaN, 0.95, C) ?? '', /person 1/)
  assert.match(personViolation(a, 2, C + 1601, 0.95, C) ?? '', /^OOB Exploit: person 2 breached the 1600m containment slab/)
  assert.match(personViolation(a, 3, C, -0.6, C) ?? '', /OOB Exploit: person 3/)
  assert.equal(personViolation(a, 4, C - 1599, 0.95, C + 1599), null)
})

test('substeps and the world name are what the room reads; a move costs microseconds, not a world step', async () => {
  assert.equal(substeps([[0, 0, 2], [1, 1, 3]]), 5)
  assert.equal(worldOf(-1), 'city/4294967295/36')
  assert.equal(worldOf(7, 0), 'city/7/0')
  const m = await mirror()
  m.join(99)
  // Put down standing, the body settles onto the sidewalk in its first substep; from there standing still is still.
  m.walk(99, [[0, 0, 1]])
  const before = m.counts.substeps
  const t0 = performance.now()
  let kept = 0
  for (let k = 0; k < 2000; k++) {
    const p = m.pose(99)
    const v = m.judge(99, { mode: 'foot', segs: [[0, 0, 1]], heading: 0, claim: { x: p.x, y: p.y, z: p.z } })
    if (v.ok) kept++
  }
  const us = ((performance.now() - t0) / 2000) * 1000
  assert.ok(kept >= 1990, `standing still is kept (${kept})`)
  assert.equal(m.counts.substeps - before, 2000)
  assert.ok(us < 1000, `${us.toFixed(1)} µs a judged substep`)
  m.leave(99)
})
