// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the robot pool (jointRealm.ts) in a real Rapier world and through the realm's
 * own door: the pool's bounds and judges on spawn, setpoints and mode; `filter` mode holding a setpoint back the
 * given steps and easing toward it at the given time constant; `follow` mode carrying a frame forward by its speed;
 * a stale setpoint holding; the slots written for the joint buffer; removal on a body gone wrong; and, through
 * SimCore and the host, the four commands as counted rejections or acts, the slots in StepState without a joint
 * buffer and in the shared buffer with one, allowed in a network room, with the transfer list unchanged.
 * What breaks if it is removed? A twin could answer a setpoint at the wrong time, or a bad manifest could reach Rapier.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import RAPIER from '@dimforge/rapier3d-simd-compat'
import { JointRealm, ROBOT_REALM } from './jointRealm.ts'
import { JOINT_BYTES, JOINT_FLAG, JOINT_SLOT, JointBuffer, slotView } from './jointBridge.ts'
import { buildManifest, MAX_ROBOTS, type Manifest } from '../04_Connect_Hardware/jointState.ts'
import { SimCore, type StepInput } from './simCore.ts'
import { createSimHost } from './simHost.ts'
import { POSE, type FromWorker, type SimCommand } from './simProtocol.ts'

await RAPIER.init()
const H = 1 / 60
const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps

function world(): RAPIER.World {
  const w = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  w.timestep = H
  const fixed = w.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  w.createCollider(RAPIER.ColliderDesc.cuboid(60, 0.5, 60).setTranslation(0, -0.5, 0), fixed)
  return w
}

/** A two-joint arm: a hinge about the vertical (no gravity load) and an elbow about y. */
function arm(name = 'arm'): Manifest {
  const m = buildManifest(name, [
    { name: 'base', mass: 5, shape: { kind: 'box', size: [0.2, 0.2, 0.1] }, shapeOrigin: { xyz: [0, 0, 0.05], rpy: [0, 0, 0] } },
    { name: 'upper', mass: 1, shape: { kind: 'cylinder', radius: 0.03, length: 0.4 }, shapeOrigin: { xyz: [0, 0, 0.2], rpy: [0, 0, 0] } },
    { name: 'fore', mass: 0.5, shape: { kind: 'cylinder', radius: 0.025, length: 0.3 }, shapeOrigin: { xyz: [0, 0, 0.15], rpy: [0, 0, 0] } },
  ], [
    { name: 'shoulder', kind: 'revolute', parent: 'base', child: 'upper', origin: { xyz: [0, 0, 0.1], rpy: [0, 0, 0] }, axis: [0, 0, 1], lower: -2, upper: 2, effort: 50, velocity: 4 },
    { name: 'elbow', kind: 'revolute', parent: 'upper', child: 'fore', origin: { xyz: [0, 0, 0.4], rpy: [0, 0, 0] }, axis: [0, 1, 0], lower: -1.5, upper: 1.5, effort: 20, velocity: 6 },
  ])
  assert.ok(m.ok, (m as { reason?: string }).reason)
  return (m as { value: Manifest }).value
}

/** Runs `steps` realm steps of one substep each: tend, drive, Rapier. */
function run(w: RAPIER.World, pool: JointRealm, steps: number, now: { t: number }, each: (t: number) => void = () => {}): void {
  for (let i = 0; i < steps; i++) {
    now.t += H
    each(now.t)
    pool.tend(now.t)
    pool.drive(H, now.t)
    w.step()
  }
}

test('spawn judges the manifest, the placement, the pool and the id; remove restores the world; removeAll empties it', () => {
  const w = world()
  const pool = new JointRealm(w)
  const before = w.bodies.len()
  pool.spawn(1, arm(), 1, 0, 2, 0.5)
  assert.equal(pool.count, 1)
  assert.deepEqual(pool.ids, [1])
  assert.equal(w.bodies.len(), before + 3)
  assert.throws(() => pool.spawn(1, arm(), 0, 0, 0, 0), /already in the realm/)
  assert.throws(() => pool.spawn(-1, arm(), 0, 0, 0, 0), /whole number/)
  assert.throws(() => pool.spawn(2, { robot: 'x' }, 0, 0, 0, 0), /links and joints/)
  assert.throws(() => pool.spawn(2, { ...arm(), joints: [{ ...arm().joints[0], kind: 'floating' }] }, 0, 0, 0, 0), /robotSpawn: /)
  assert.throws(() => pool.spawn(2, arm(), NaN, 0, 0, 0), /not finite/)
  assert.throws(() => pool.spawn(2, arm(), 9000, 0, 0, 0), /too far/)
  assert.throws(() => pool.spawn(2, { ...arm(), links: arm().links.map((l) => ({ ...l, mass: 600 })) }, 0, 0, 0, 0), /robotSpawn: /)
  assert.equal(w.bodies.len(), before + 3, 'nothing of a refused spawn stays')
  for (let i = 2; i <= MAX_ROBOTS; i++) pool.spawn(i, arm(), i, 0, 0, 0)
  assert.throws(() => pool.spawn(99, arm(), 0, 0, 0, 0), /at most 4/)
  pool.remove(3)
  assert.throws(() => pool.remove(3), /no robot 3/)
  assert.equal(w.bodies.len(), before + 3 * (MAX_ROBOTS - 1))
  pool.removeAll()
  assert.equal(pool.count, 0)
  assert.equal(w.bodies.len(), before)
})

test('targets and mode are judged on read', () => {
  const w = world()
  const pool = new JointRealm(w)
  pool.spawn(1, arm(), 0, 0, 0, 0)
  assert.throws(() => pool.targets(2, 1, [0, 0], [], [], 0), /no robot 2/)
  assert.throws(() => pool.targets(1, 1.5, [0, 0], [], [], 0), /seq/)
  assert.throws(() => pool.targets(1, 1, [0], [], [], 0), /for 2 joints/)
  assert.throws(() => pool.targets(1, 1, [0, NaN], [], [], 0), /finite/)
  assert.throws(() => pool.targets(1, 1, [0, 0], [1], [], 0), /qd has 1 entries/)
  assert.throws(() => pool.targets(1, 1, [0, 0], [], 'x', 0), /not an array/)
  assert.throws(() => pool.targets(1, 1, undefined, [], [], 0), /q must have 2 entries/)
  pool.targets(1, 1, [0.1, 0.2], [], [], 0)
  pool.targets(1, 2, [0.1, 0.2], [0, 0], [1, 1], 0)
  assert.throws(() => pool.mode(1, 'twin'), /unknown mode/)
  assert.throws(() => pool.mode(1, 'filter', -1), /tauMs/)
  assert.throws(() => pool.mode(1, 'filter', 0, 1.5), /delaySteps/)
  assert.throws(() => pool.mode(1, 'filter', 0, ROBOT_REALM.maxDelaySteps + 1), /delaySteps/)
  assert.throws(() => pool.mode(2, 'hold'), /no robot 2/)
  pool.mode(1, 'filter', 100, 3)
  pool.mode(1, 'follow')
  pool.mode(1, 'hold')
})

test('filter mode: a setpoint is held back the given steps, then eased toward at the time constant; zero passes through', () => {
  const w = world()
  const pool = new JointRealm(w)
  pool.spawn(1, arm(), 0, 0, 0, 0)
  const body = pool.body(1)!
  const now = { t: 0 }
  // Nothing yet: holding, and the slot says so.
  run(w, pool, 10, now)
  const out = new Float32Array(MAX_ROBOTS * JOINT_SLOT.words)
  assert.equal(pool.write(out), 1)
  let v = slotView(out, 0)!
  assert.deepEqual([v.id, v.joints, v.links, v.flags, v.ack], [1, 2, 3, JOINT_FLAG.holding, -1])
  assert.ok(Math.abs(v.q[0]) < 1e-3 && Math.abs(v.q[1]) < 1e-3)
  // A pass-through filter with a three-step delay: the shoulder does not move for three steps after the setpoint,
  // then does.
  pool.mode(1, 'filter', 0, 3)
  const moved: number[] = []
  pool.targets(1, 1, [1, 0], [], [], now.t)
  run(w, pool, 8, now, () => moved.push(body.movable[0].q))
  assert.ok(moved.slice(0, 4).every((q) => Math.abs(q) < 1e-3), `still for the delay: ${moved.map((q) => q.toFixed(3)).join(' ')}`)
  assert.ok(moved[7] > 0.05, `then moving: ${moved[7]}`)
  assert.equal(pool.write(out), 1)
  v = slotView(out, 0)!
  assert.equal(v.flags, 0)
  assert.equal(v.ack, 1)
  // The setpoint is re-sent every step from here (as the page does): the arm settles at it.
  run(w, pool, 90, now, (t) => pool.targets(1, 2, [1, 0], [], [], t))
  assert.ok(near(body.movable[0].q, 1, 0.02), `settled: ${body.movable[0].q}`)
  // With a 200 ms time constant and no delay, a step reaches 63 % of the way near 200 ms and is not there at 60 ms.
  pool.mode(1, 'filter', 200, 0)
  const q0 = body.movable[0].q
  const trace: number[] = []
  run(w, pool, 60, now, (t) => { pool.targets(1, 3, [0, 0], [], [], t); trace.push(body.movable[0].q) })
  const at = (ms: number) => (q0 - trace[Math.round(ms / 1000 / H) - 1]) / q0
  assert.ok(at(60) < 0.4, `at 60 ms: ${(at(60) * 100).toFixed(0)} %`)
  assert.ok(at(200) > 0.5 && at(200) < 0.8, `at 200 ms: ${(at(200) * 100).toFixed(0)} % (63 % is the filter alone; the servo adds a little lag)`)
  assert.ok(at(1000) > 0.98, `at 1 s: ${(at(1000) * 100).toFixed(0)} %`)
})

test('follow mode carries the newest frame forward by its speed for a while; a stale setpoint holds; hold mode holds', () => {
  const w = world()
  const pool = new JointRealm(w)
  pool.spawn(1, arm(), 0, 0, 0, 0)
  const body = pool.body(1)!
  const now = { t: 0 }
  pool.mode(1, 'follow')
  // Frames at 20 Hz saying the shoulder turns at 1 rad/s: the body follows at that pace between frames.
  let q = 0
  run(w, pool, 60, now, (t) => {
    if (Math.round(t / H) % 3 === 0) { q += 3 * H; pool.targets(1, Math.round(t / H), [q, 0], [1, 0], [], t) }
  })
  assert.ok(near(body.movable[0].q, q, 0.08), `following: body ${body.movable[0].q}, frame ${q}`)
  // No frame for 750 ms: the last frame's speed carries it 100 ms further (0.1 rad), then it holds there; the speed
  // would have carried it 0.75 rad.
  const held = body.movable[0].q
  run(w, pool, 45, now)
  const out = new Float32Array(MAX_ROBOTS * JOINT_SLOT.words)
  pool.write(out)
  assert.equal(slotView(out, 0)!.flags, JOINT_FLAG.holding, 'stale: holding')
  assert.ok(near(body.movable[0].q, held + 0.1, 0.06), `held: ${body.movable[0].q} from ${held}`)
  // A fresh frame resumes.
  pool.targets(1, 999, [0.3, 0.2], [], [], now.t)
  run(w, pool, 60, now, (t) => pool.targets(1, 1000 + Math.round(t / H), [0.3, 0.2], [], [], t))
  assert.ok(near(body.movable[0].q, 0.3, 0.03) && near(body.movable[1].q, 0.2, 0.03), `resumed: ${body.movable[0].q}, ${body.movable[1].q}`)
  // Hold mode ignores setpoints.
  pool.mode(1, 'hold')
  run(w, pool, 30, now, (t) => pool.targets(1, 2000 + Math.round(t / H), [-1, -1], [], [], t))
  assert.ok(near(body.movable[0].q, 0.3, 0.03), `hold: ${body.movable[0].q}`)
  pool.write(out)
  assert.equal(slotView(out, 0)!.flags, JOINT_FLAG.holding)
})

test('the slots carry q, q̇, τ and every link pose; a body gone wrong leaves the pool with a reason', () => {
  const w = world()
  const pool = new JointRealm(w)
  pool.spawn(4, arm(), 2, 1, -3, 0)
  pool.spawn(5, arm('other'), -2, 0, 3, 1)
  const now = { t: 0 }
  pool.mode(5, 'filter', 0, 0)
  run(w, pool, 30, now, (t) => pool.targets(5, Math.round(t / H), [0.5, -0.4], [], [], t))
  const out = new Float32Array(MAX_ROBOTS * JOINT_SLOT.words)
  assert.equal(pool.write(out), 2)
  const a = slotView(out, 0)!, b = slotView(out, 1)!
  assert.deepEqual([a.id, b.id], [4, 5])
  assert.ok(near(b.q[0], 0.5, 0.03) && near(b.q[1], -0.4, 0.03))
  assert.ok(b.tau[1] !== 0, 'the elbow holds a load: τ is the servo\'s torque')
  const base = pool.body(4)!.bodies[0].translation()
  assert.ok(near(a.poses[0], 2, 1e-6) && near(a.poses[1], 1, 1e-6) && near(a.poses[2], -3, 1e-6), 'the root link where it was placed')
  assert.ok(near(a.poses[0], base.x, 1e-6))
  assert.ok(a.poses[7 * 2 + 1] > 0.4, 'the fore link stands above the base')
  assert.equal(out[2 * JOINT_SLOT.words + JOINT_SLOT.joints], 0, 'the slot after the last is marked empty')
  // A link thrown to NaN: the next drive removes the body and says why; nothing throws.
  pool.body(4)!.bodies[1].setTranslation({ x: NaN, y: 0, z: 0 }, true)
  run(w, pool, 1, now)
  assert.equal(pool.count, 1)
  assert.deepEqual(pool.ids, [5])
  assert.match(pool.takeLost().join(), /robot 4 left the realm: its body stopped being finite/)
  assert.deepEqual(pool.takeLost(), [])
  assert.equal(pool.write(out), 1)
  assert.equal(slotView(out, 0)!.id, 5)
})

const NO_FURNITURE = { lamps: [], trees: [], signals: [] }
const OPEN = { x: -600, z: 0 }
const IDLE = { steer: 0, fwd: 0, back: 0, handbrake: false }

test('through the realm: the four commands act or are counted, robots travel in the state without a joint buffer, and a room allows them', async () => {
  const sim = await SimCore.create({ seed: 11, cars: 0, agents: 256, boxes: [], furniture: NO_FURNITURE, spawn: OPEN, debug: false }, null)
  const poses = new Float32Array(Math.max(1, sim.meta.count) * POSE.stride)
  const step = (cmds: SimCommand[] = []) => sim.step({ dt: H, foot: { x: 0, z: 0, heading: 0 }, drive: IDLE, cmds } as StepInput, poses)
  let st = step()
  assert.equal(st.robots, null, 'no robots: null')
  const before = st.rejected
  st = step([{ c: 'robotSpawn', id: 1, manifest: arm(), x: OPEN.x + 3, y: 0, z: OPEN.z, heading: 0 }])
  assert.ok(st.robots instanceof Float32Array && st.robots.length === JOINT_SLOT.words, 'one slot')
  assert.equal(slotView(st.robots, 0)!.id, 1)
  assert.equal(st.rejected, before)
  // Refusals are counted, never thrown.
  st = step([
    { c: 'robotSpawn', id: 1, manifest: arm(), x: 0, y: 0, z: 0, heading: 0 },
    { c: 'robotTargets', id: 1, seq: 1, q: [NaN, 0], qd: [], tau: [] },
    { c: 'robotMode', id: 1, mode: 'twin' as never },
    { c: 'robotRemove', id: 7 },
    { c: 'robotSpawn', id: 2, manifest: { robot: 'x' } as never, x: 0, y: 0, z: 0, heading: 0 },
  ])
  assert.equal(st.rejected, before + 5)
  assert.ok(st.events.filter((e) => e.e === 'rejected').length >= 4)
  // Allowed in a network room (a robot is the page's own).
  st = step([{ c: 'room', on: true }, { c: 'robotMode', id: 1, mode: 'filter', tauMs: 0, delaySteps: 0 }, { c: 'robotTargets', id: 1, seq: 2, q: [0.4, 0], qd: [], tau: [] }])
  assert.equal(st.rejected, before + 5)
  for (let i = 0; i < 60; i++) st = step([{ c: 'robotTargets', id: 1, seq: 3 + i, q: [0.4, 0], qd: [], tau: [] }])
  assert.ok(near(slotView(st.robots!, 0)!.q[0], 0.4, 0.03), `drove: ${slotView(st.robots!, 0)!.q[0]}`)
  assert.equal(slotView(st.robots!, 0)!.ack, 62)
  st = step([{ c: 'room', on: false }, { c: 'robotRemove', id: 1 }])
  assert.equal(st.robots, null)
  assert.equal(st.rejected, before + 5)
})

test('through the host: a joint buffer is taken once and filled after every step, the state then carries no robots and the transfer list is unchanged', async () => {
  const out: { msg: FromWorker; transfer?: Transferable[] }[] = []
  const handle = createSimHost((msg, transfer) => out.push({ msg, transfer }), (o) => SimCore.create(o, null))
  await handle({ t: 'init', seed: 11, cars: 0, agents: 256, boxes: [], furniture: NO_FURNITURE, spawn: OPEN, debug: false })
  assert.equal(out[0].msg.t, 'ready')
  const hostStep = (id: number, cmds: SimCommand[] = []) => handle({ t: 'step', id, dt: H, foot: {}, drive: {}, cmds })
  // Before any buffer: the slots travel in the state.
  await hostStep(1, [{ c: 'robotSpawn', id: 3, manifest: arm(), x: OPEN.x + 3, y: 0, z: OPEN.z, heading: 0 }])
  let st = out.at(-1)!.msg
  assert.ok(st.t === 'state' && st.robots instanceof Float32Array && slotView(st.robots, 0)!.id === 3)
  assert.deepEqual(out.at(-1)!.transfer, [st.poses.buffer], 'robots are cloned, never transferred')
  // Refused buffers are counted.
  const rejectedBefore = st.rejected
  await handle({ t: 'joints', buffer: new ArrayBuffer(JOINT_BYTES) })
  await handle({ t: 'joints', buffer: new SharedArrayBuffer(8) })
  await hostStep(2)
  st = out.at(-1)!.msg
  assert.ok(st.t === 'state' && st.rejected === rejectedBefore + 2)
  // The buffer: filled after the step, and the state's robots null from then on.
  const joints = JointBuffer.create(true)
  await handle({ t: 'joints', buffer: joints.buffer })
  await hostStep(3)
  st = out.at(-1)!.msg
  assert.ok(st.t === 'state' && st.robots === null, 'the words went into the buffer')
  assert.equal(joints.robots, 1)
  assert.equal(joints.step, 3)
  const snap = new Float32Array(MAX_ROBOTS * JOINT_SLOT.words)
  assert.equal(joints.snapshot(snap), 1)
  assert.equal(slotView(snap, 0)!.id, 3)
  await handle({ t: 'joints', buffer: JointBuffer.create(true).buffer })
  await hostStep(4, [{ c: 'robotRemove', id: 3 }])
  st = out.at(-1)!.msg
  assert.ok(st.t === 'state' && st.rejected === rejectedBefore + 3, 'a second buffer is refused')
  assert.equal(joints.robots, 0, 'the removal reached the first buffer')
})
