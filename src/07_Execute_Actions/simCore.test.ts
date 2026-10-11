// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the physics realm's boundary in real Rapier (WASM, run in Node), with
 * no Worker and no GPU in the way (the crowd is a stand-in sensor with the real contract): SimCore returns
 * plain data only; the page's controls are clamped (a run is the fastest walk, the wheel and pedals stay in
 * range); a script's walk (sim.avatar.walk) moves the avatar for its time, overriding the keys only while it lasts,
 * and no faster than a run; the crowd's hazard readings reach the Bouncer, aged on the realm's own clock so a stale reading only
 * brings a person nearer and a silent sensor makes every car hold; the crowd is fed the realm's own cars, avatar
 * and clock; entering and leaving a car happen in the realm and come back as events; the fault-injection
 * commands are refused unless the worker was built for ?debug; malformed, unknown or flooding commands are
 * counted and dropped; the Ring-0 audit runs in the realm right after the substeps and halts it for good on an
 * impact, a non-finite pedestrian or a lost sensor, and a frame whose flags halted it never ships; the fleet is
 * never larger than what the GPU senses; a recruitment request is decided on the realm's own readings of the
 * crowd (earshot, the sidewalk, the skill, the slots), answered by an event, carried to the crowd as a summons,
 * and released on every way an interview can end; and the message door (simHost) accepts one init, refuses everything
 * else it does not know, ignores any pedestrian data the page slips in, transfers the pose and crowd buffers
 * and takes them back, and goes silent after a panic.
 * What breaks if it is removed? The worker could accept a command it should refuse, trust a reading it
 * should not, or leak a non-plain object, and nothing would say so before a browser session did.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CAR } from './car.ts'
import { SimCore, type StepInput } from './simCore.ts'
import { createSimHost } from './simHost.ts'
import { bridgeBytes, PhysicsBridge, SLOT } from './sharedBridge.ts'
import { POSE, RUN, TRACK_KINDS, TRACK_POSE, WALK, type FromWorker, type SimInit } from './simProtocol.ts'
import { auditCraft } from '../02_Define_The_Rules/ring0.ts'
import { buildTrackNetwork } from '../06_Make_Decisions/tracks.ts'
import { TrackFleet } from './trackFleet.ts'
import { KERNEL, signalFor } from '../02_Define_The_Rules/civic.ts'
import { stoppingDistance } from '../02_Define_The_Rules/laws.ts'
import { runHarness } from './harness.ts'
import type { SimControls } from './operator.ts'
import { applyWalk, DEFAULT_WALK_MS, MAX_WALK_MS, requestWalk, type ScriptedWalk } from './scriptedWalk.ts'
import { MODES } from './simProtocol.ts'
import { MAX_CARS, type CrowdReadout, type CrowdSensor, type CrowdStepInput } from '../03_Spawn_Agents/crowdSensor.ts'
import { ACTIVITY, APPROACH_SECONDS, RALLY_RANGE, RECRUIT_SLOTS, RELEASE_DISTANCE, skillsOf, TETHER_PACE, type Skill } from '../03_Spawn_Agents/skills.ts'
import type { SimEvent } from './simProtocol.ts'
import { inLot } from '../01_Initialize_World/city.ts'

const H = 1 / 60
const NO_FURNITURE = { lamps: [], trees: [], signals: [] }
/** Open ground well away from the street grid (the ground spans ±1600 m around the centre). */
const OPEN = { x: -600, z: 0 }
const AGENTS = 256
const IDLE = { steer: 0, fwd: 0, back: 0, handbrake: false }

/**
 * A stand-in for the GPU crowd with the real contract. While `answering`, every step reads back, stamped as the
 * real sensor stamps it (the start of the step's substep, where simulate sensed each pedestrian): at once, or
 * `later` (in a timer, as mapAsync resolves). The next SimCore step then sees a reading two steps old.
 */
class FakeCrowd implements CrowdSensor {
  readonly agentCount: number
  readonly steps: CrowdStepInput[] = []
  readonly recycled: ArrayBuffer[] = []
  readonly ahead = new Float32Array(MAX_CARS).fill(Infinity)
  readonly behind = new Float32Array(MAX_CARS).fill(Infinity)
  readout: CrowdReadout | null = null
  answering = true
  /** Resolve the readback in a later task, as the GPU does. */
  later = false
  /** Flags the next readback raises when it lands (with its frame, as the GPU's stats word does). */
  flagOnRead = 0
  flags = 0
  lost: string | null = null
  /** Where every pedestrian stands and what they are doing in the next readback (NaN: nowhere yet). */
  readonly xz: Float32Array
  readonly activity: Uint8Array
  #frame: Float32Array | null = null
  constructor(agents = AGENTS) {
    this.agentCount = agents
    this.xz = new Float32Array(agents * 2).fill(NaN)
    this.activity = new Uint8Array(agents)
  }
  step(input: CrowdStepInput): void {
    this.steps.push({ ...input, player: { ...input.player }, cars: input.cars.map((c) => ({ ...c })), summons: input.summons.map((m) => ({ ...m })) })
    if (!this.answering) return
    const read = () => {
      this.readout = {
        seq: input.seq, time: input.time - input.dt, hazardsAhead: Float32Array.from(this.ahead), hazardsBehind: Float32Array.from(this.behind),
        stats: { nudges: 1, waiting: 2, crossing: 3, retreating: 4 }, xz: Float32Array.from(this.xz), activity: Uint8Array.from(this.activity),
      }
      this.#frame = new Float32Array(this.agentCount * 12).fill(7)
      this.flags |= this.flagOnRead
    }
    if (this.later) setTimeout(read, 5)
    else read()
  }
  takeFlags(): number { const f = this.flags; this.flags = 0; return f }
  takeFrame(): Float32Array | null { const f = this.#frame; this.#frame = null; return f }
  recycle(buffer: ArrayBuffer): void { this.recycled.push(buffer) }
}

async function core(debug = false, cars = 4, crowd: FakeCrowd | null = null) {
  const sim = await SimCore.create({ seed: 11, cars, agents: AGENTS, boxes: [], furniture: NO_FURNITURE, spawn: { x: OPEN.x, z: OPEN.z }, debug }, crowd ? async () => crowd : null)
  const poses = new Float32Array(sim.meta.count * POSE.stride)
  const step = (o: Partial<StepInput> = {}) => sim.step({ dt: H, foot: { x: 0, z: 0, heading: 0 }, drive: IDLE, cmds: [], ...o }, poses)
  return { sim, poses, step }
}

/** Every object in a state is a plain object, an array or a typed array: nothing that could be a live handle. */
function plain(x: unknown, path = 'state'): void {
  if (x === null || typeof x !== 'object') {
    assert.notEqual(typeof x, 'function', `${path} is a function`)
    return
  }
  if (x instanceof Float32Array) return
  const proto = Object.getPrototypeOf(x)
  assert.ok(proto === Object.prototype || proto === Array.prototype, `${path} is a ${proto?.constructor?.name}`)
  for (const [k, v] of Object.entries(x)) plain(v, `${path}.${k}`)
}

/** Car `i` on open ground heading +z, coasting (a player-mode car without drive()) at `speed` m/s. */
function rolling(step: (o?: Partial<StepInput>) => ReturnType<SimCore['step']>, i: number, speed: number): void {
  step({ cmds: [{ c: 'dbgMode', i, mode: 'player' }, { c: 'recover', i, x: OPEN.x, z: OPEN.z + 40, heading: 0 }] })
  for (let k = 0; k < 60; k++) step()
  step({ cmds: [{ c: 'dbgVelocity', i, x: 0, y: 0, z: speed }] })
}

test('a step returns plain data only, structured-clone safe, with finite poses and the crowd\'s own figures', async () => {
  const crowd = new FakeCrowd()
  const { sim, step } = await core(false, 4, crowd)
  const s = step()
  plain(s)
  plain(sim.meta, 'meta')
  assert.deepEqual(structuredClone(s).kernel, s.kernel)
  assert.ok(s.poses.every(Number.isFinite))
  assert.equal(s.driving, -1)
  assert.equal(s.avatar.enabled, true)
  assert.ok(Math.abs(s.avatar.x - OPEN.x) < 0.01 && Math.abs(s.avatar.z - OPEN.z) < 0.01)
  assert.equal(sim.meta.count, 4)
  assert.equal(sim.meta.agents, AGENTS)
  assert.equal(sim.meta.suv.length, 4)
  assert.equal(sim.meta.debug, false)
  assert.deepEqual(s.crowd.stats, { nudges: 1, waiting: 2, crossing: 3, retreating: 4 })
  assert.ok(s.crowdFrame instanceof Float32Array && s.crowdFrame.length === AGENTS * 12)
  assert.ok(Math.abs(s.crowd.ageMs! - H * 1000) < 1e-6, 'the reading the Bouncer used was one step old')
  assert.ok(Object.isFrozen(sim) && Object.isFrozen(SimCore.prototype))
})

test('the page cannot walk faster than a run, and a non-finite control is no control', async () => {
  const { step } = await core()
  for (let i = 0; i < 20; i++) step()
  let s = step()
  const a0 = s.avatar
  for (let i = 0; i < 30; i++) s = step({ foot: { x: 1e6, z: 0, heading: 0 } })
  const moved = s.avatar.x - a0.x
  assert.ok(moved > 0 && moved <= RUN * 30 * H + 0.05, `moved ${moved.toFixed(2)} m in 0.5 s`)
  const b = step({ foot: { x: Number.NaN, z: Infinity, heading: NaN } }).avatar
  const c = step({ foot: { x: Number.NaN, z: Infinity, heading: NaN } }).avatar
  assert.ok(Math.abs(c.x - b.x) < 0.01 && Math.abs(c.z - b.z) < 0.01, 'NaN and Infinity do not move the avatar')
  // A huge dt is clamped: the world clock advances by at most 0.1 s.
  const t0 = step().simTime
  assert.ok(step({ dt: 1e9 }).simTime - t0 <= 0.1 + 1e-9)
})

test("a script's walk (sim.avatar.walk) through the realm: held for its time, overriding the keys only while it lasts, a run at most, ended by (0, 0)", async () => {
  const { step } = await core()
  for (let i = 0; i < 20; i++) step()
  const w: ScriptedWalk = { x: 0, z: 0, until: 0 }
  let now = 0
  // One animation frame as the engine builds it on foot: the player's own velocity from the keys, overridden by the
  // script's walk while it lasts, sent to the realm.
  const frame = (keys = { x: 0, z: 0 }) => {
    const foot = { x: keys.x, z: keys.z, heading: 0 }
    applyWalk(w, now, foot)
    now += H * 1000
    return step({ foot }).avatar
  }
  const frames = (n: number, keys?: { x: number; z: number }) => {
    let a = frame(keys)
    for (let i = 1; i < n; i++) a = frame(keys)
    return a
  }
  const a0 = frame()
  // East at a walk for half a second: that far east, then it ends by itself and the avatar stands.
  assert.equal(requestWalk(w, now, WALK, 0, 500), true)
  const a1 = frames(30)
  assert.ok(Math.abs(a1.x - a0.x - WALK * 0.5) < 0.1 && Math.abs(a1.z - a0.z) < 0.02, `${(a1.x - a0.x).toFixed(3)} m east`)
  const a2 = frames(30)
  assert.ok(Math.hypot(a2.x - a1.x, a2.z - a1.z) < 0.02, 'it ended by itself')
  // While it lasts it overrides the keys (they say east, the script says -z); once it ends, the keys walk again.
  requestWalk(w, now, 0, -WALK, 250)
  const a3 = frames(15, { x: WALK, z: 0 })
  assert.ok(a3.z - a2.z < -0.3 && Math.abs(a3.x - a2.x) < 0.05, JSON.stringify({ dx: a3.x - a2.x, dz: a3.z - a2.z }))
  const a4 = frames(30, { x: WALK, z: 0 })
  assert.ok(a4.x - a3.x > 0.5, 'the keys again once it ended')
  // Asked for faster than a run, the realm caps it.
  requestWalk(w, now, 1e6, 0, 500)
  const a5 = frames(30)
  assert.ok(a5.x - a4.x > 0 && a5.x - a4.x <= RUN * 30 * H + 0.05, `${(a5.x - a4.x).toFixed(2)} m in 0.5 s`)
  // (0, 0) ends it at once.
  requestWalk(w, now, WALK, 0, MAX_WALK_MS)
  frames(5)
  requestWalk(w, now, 0, 0)
  const a6 = frames(3)
  const a7 = frames(30)
  assert.ok(Math.hypot(a7.x - a6.x, a7.z - a6.z) < 0.02, 'stopped')
  // A velocity that is not finite is no request; the time is clamped: 1 s when not given, 10 s at most, none if not finite.
  requestWalk(w, 1000, 1, 2, 3000)
  for (const [vx, vz] of [[Number.NaN, 1], [1, Number.POSITIVE_INFINITY]]) {
    assert.equal(requestWalk(w, 5000, vx, vz, 100), false)
    assert.deepEqual(w, { x: 1, z: 2, until: 4000 })
  }
  requestWalk(w, 1000, 1, 0)
  assert.equal(w.until, 1000 + DEFAULT_WALK_MS)
  requestWalk(w, 1000, 1, 0, 1e9)
  assert.equal(w.until, 1000 + MAX_WALK_MS)
  for (const ms of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
    requestWalk(w, 1000, 1, 0, ms)
    assert.equal(w.until, 1000, String(ms))
  }
  // Overriding is all it does: outside its time the frame's own velocity goes through untouched.
  const own = { x: 0.5, z: -0.5 }
  assert.equal(applyWalk({ x: 9, z: 9, until: 100 }, 100, own), false)
  assert.deepEqual(own, { x: 0.5, z: -0.5 })
})

test('entering and leaving a car happen in the realm and come back as events; the wheel and pedals are clamped', async () => {
  const { sim, poses, step } = await core(true)
  step({ cmds: [{ c: 'dbgMode', i: 0, mode: 'parked' }, { c: 'recover', i: 0, x: OPEN.x + 3.5, z: OPEN.z, heading: 0 }] })
  for (let i = 0; i < 60; i++) step()
  let s = step({ cmds: [{ c: 'interact' }] })
  assert.equal(s.driving, 0)
  assert.deepEqual(s.events.map((e) => e.e), ['entered'])
  assert.equal(s.avatar.enabled, false)
  for (let i = 0; i < 60; i++) s = step({ drive: { steer: 1e9, fwd: 1e9, back: -5, handbrake: false } })
  const o = 0
  assert.ok(poses[o + POSE.speed] > 3, `speed ${poses[o + POSE.speed].toFixed(2)} m/s`)
  assert.ok(poses[o + POSE.throttle] <= 1 && Math.abs(poses[o + POSE.curvature]) <= Math.tan(CAR.maxSteer) / CAR.wheelbase + 1e-6)
  assert.equal(s.kernel.audit.panic, null)
  // The L2 limiter lives in the realm too: within 0.5 m/s of the cap the throttle is withheld.
  const h = poses[o + POSE.heading]
  step({ cmds: [{ c: 'dbgVelocity', i: 0, x: 49.8 * Math.sin(h), y: 0, z: 49.8 * Math.cos(h) }] })
  s = step({ drive: { steer: 0, fwd: 1, back: 0, handbrake: false } })
  assert.equal(s.haptics.limited, true)
  assert.equal(poses[o + POSE.throttle], 0)
  // Brake to a stop, then leave: the car is parked, the avatar is back in the world beside it.
  for (let i = 0; i < 600 && Math.abs(poses[o + POSE.speed]) > 0.1; i++) step({ drive: { steer: 0, fwd: 0, back: 1, handbrake: false } })
  s = step({ cmds: [{ c: 'interact' }] })
  assert.equal(s.driving, -1)
  assert.equal(s.events[0]?.e, 'exited')
  assert.equal(s.avatar.enabled, true)
  assert.equal(poses[o + POSE.mode], 2, 'parked')
  assert.equal(sim.halted, false)
})

test('the crowd is fed the realm\'s own cars, avatar and clock (the page supplies only its view heading)', async () => {
  const crowd = new FakeCrowd()
  const { sim, poses, step } = await core(false, 4, crowd)
  assert.equal(crowd.steps.length, 1, 'primed once at boot, before the first step')
  assert.equal(crowd.steps[0].dt, 0)
  const s = step({ foot: { x: 0, z: 0, heading: 1.25 } })
  const fed = crowd.steps.at(-1)!
  assert.equal(fed.time, s.simTime, 'the crowd runs on the realm clock: the one the cars obey')
  assert.equal(fed.dt, H)
  assert.equal(fed.cars.length, sim.meta.count)
  for (let i = 0; i < sim.meta.count; i++) {
    assert.ok(Math.abs(fed.cars[i].x - poses[i * POSE.stride + POSE.x]) < 1e-3 && Math.abs(fed.cars[i].z - poses[i * POSE.stride + POSE.z]) < 1e-3, `car ${i}`)
  }
  assert.ok(Math.abs(fed.player.x - s.avatar.x) < 1e-6 && Math.abs(fed.player.z - s.avatar.z) < 1e-6)
  assert.equal(fed.player.heading, 1.25)
  assert.equal(fed.player.visible, true)
  step({ foot: { x: 0, z: 0, heading: NaN } })
  assert.equal(crowd.steps.at(-1)!.player.heading, 1.25, 'a non-finite heading keeps the last one')
  // Finite in f64 but Infinity in the shader's f32 (and NaN through sin): wrapped to a small angle first.
  for (const h of [1e39, -3.5e38, 7 * Math.PI + 0.25]) {
    step({ foot: { x: 0, z: 0, heading: h } })
    const sent = crowd.steps.at(-1)!.player.heading
    assert.ok(Math.abs(sent) <= Math.PI && Number.isFinite(Math.fround(sent)), `${h} → ${sent}`)
  }
  assert.ok(Math.abs(crowd.steps.at(-1)!.player.heading - (Math.PI + 0.25 - 2 * Math.PI)) < 1e-9, 'the same direction, wrapped')
})

test('the crowd\'s hazard reading reaches the Bouncer in the realm: a person 4 m ahead holds the car', async () => {
  const crowd = new FakeCrowd()
  const { poses, step } = await core(true, 4, crowd)
  rolling(step, 1, 8)
  const law1 = step().kernel.law1
  crowd.ahead[1] = 4
  step() // read back at the end of this step
  const s = step() // vetted with it
  assert.ok(s.kernel.law1 > law1, 'a First-Law hold')
  assert.equal(poses[1 * POSE.stride + POSE.brake], KERNEL.maxBrake)
  assert.equal(poses[1 * POSE.stride + POSE.throttle], 0)
})

test('a stale reading is aged on the realm clock: it only brings the person nearer, until the car holds', async () => {
  // At 8 m/s the envelope is stoppingDistance(8) + standoff = 8·0.1 + 8²/(2·7.5) + 1.5 ≈ 6.57 m. A person read 7 m
  // ahead is outside it while fresh; as the reading ages the car can have driven |v|·(age − 0.1 s) and the person
  // walked 3 m/s·age toward it. (Which term does the work is pinned by the two tests after this one.)
  assert.ok(Math.abs(stoppingDistance(8) + KERNEL.standoff - 6.567) < 0.01)
  const crowd = new FakeCrowd()
  const { poses, step } = await core(true, 4, crowd)
  rolling(step, 1, 8)
  crowd.ahead[1] = 7
  let s = step()
  const law1 = s.kernel.law1
  for (let i = 0; i < 20; i++) s = step()
  assert.equal(s.kernel.law1, law1, 'fresh (one step old), 7 m is clear of the envelope')
  assert.ok(Math.abs(poses[1 * POSE.stride + POSE.speed]) > 7.5)
  crowd.answering = false // the sensor goes quiet: its last reading ages
  for (let i = 0; i < 4; i++) s = step()
  assert.equal(s.kernel.law1, law1, 'a few steps stale: still clear')
  for (let i = 0; i < 8; i++) s = step()
  assert.ok(s.kernel.law1 > law1, `aged ${s.crowd.ageMs!.toFixed(0)} ms, the reading has closed inside the envelope: held`)
  assert.equal(poses[1 * POSE.stride + POSE.brake], KERNEL.maxBrake)
})

test('a sensor silent for over a second vouches for nobody: every moving car holds, even on an "empty street" reading', async () => {
  const crowd = new FakeCrowd()
  const { step } = await core(true, 4, crowd)
  rolling(step, 1, 8)
  let s = step()
  const law1 = s.kernel.law1
  crowd.answering = false
  for (let i = 0; i < 55; i++) s = step()
  assert.equal(s.kernel.law1, law1, 'under a second: an empty street is still empty')
  for (let i = 0; i < 10; i++) s = step()
  assert.ok(s.crowd.ageMs! > 1000)
  assert.ok(s.kernel.law1 > law1, 'over a second: held')
})

test('a non-finite pedestrian halts the realm (IEEE 754), and the frame that carried the flag never leaves it', async () => {
  const crowd = new FakeCrowd()
  const { sim, step } = await core(false, 4, crowd)
  const land = () => new Promise((r) => setTimeout(r, 25))
  // As on the GPU: a step's readback (frame and flags together) lands between steps, and ships with the next.
  crowd.later = true
  step()
  await land()
  assert.ok(step().crowdFrame, 'a clean frame ships')
  crowd.flagOnRead = 1
  await land()
  const s = step()
  assert.match(sim.panic ?? '', /IEEE 754 Exploit/)
  assert.equal(s.crowdFrame, null, 'the frame whose flags halted the realm is kept in it')
  assert.equal(s.kernel.audit.panic, sim.panic)
})

test('a lost sensor halts the realm: the Bouncer can no longer see pedestrians', async () => {
  const crowd = new FakeCrowd()
  const { sim, step } = await core(false, 4, crowd)
  step()
  crowd.lost = 'GPU device lost (unknown): driver reset'
  step()
  assert.match(sim.panic ?? '', /Sensing Failure: pedestrian sensing stopped \(GPU device lost/)
})

test('the realm will not start without a working sensor, nor with more cars than the GPU senses', async () => {
  const dead = new FakeCrowd()
  dead.answering = false
  dead.lost = 'GPU device lost (destroyed): gone'
  const base = { seed: 11, cars: 4, agents: AGENTS, boxes: [], furniture: NO_FURNITURE, spawn: OPEN, debug: false }
  await assert.rejects(SimCore.create(base, async () => dead), /pedestrian sensing failed to start: GPU device lost/)
  await assert.rejects(SimCore.create({ ...base, cars: MAX_CARS + 1 }), /cars must be 0–48/)
  await assert.rejects(SimCore.create({ ...base, agents: 10 }, async () => new FakeCrowd(10)), /agents must be 256–60000/)
})

test('fault injection is refused outside ?debug; malformed, unknown and flooding commands are counted and dropped', async () => {
  const { poses, step } = await core(false)
  for (let i = 0; i < 30; i++) step()
  const vz = poses[POSE.vz]
  let s = step({ cmds: [{ c: 'dbgVelocity', i: 0, x: 0, y: 0, z: 40 }, { c: 'dbgSanctuary', on: false }, { c: 'dbgHazard', i: 0, ahead: 0 }, { c: 'dbgMode', i: 0, mode: 'player' }] })
  assert.equal(s.rejected, 4)
  assert.ok(s.events.every((e) => e.e === 'rejected' && /refused outside \?debug/.test(e.reason)))
  assert.ok(Math.abs(poses[POSE.vz] - vz) < 1, 'the car was not launched')
  s = step({ cmds: [null, 42, { c: 'launch' }, { nope: 1 }, { c: 'setMode', i: 99, mode: 'ai' }, { c: 'setMode', i: 0, mode: 'player' }, { c: 'teleport', x: Number.NaN, z: 0 }, { c: 'tune', key: 'mass', value: 9 }] })
  assert.equal(s.rejected, 12)
  s = step({ cmds: Array.from({ length: 100 }, () => ({ c: 'reset' })) })
  assert.equal(s.rejected, 13, 'a flood past 64 commands is refused once')
  // Tuning stays inside the envelope-safe range: grip and brakes cannot be weakened from the page.
  s = step({ cmds: [{ c: 'tune', key: 'grip', value: 0.1 }, { c: 'tune', key: 'brake', value: -5 }, { c: 'tune', key: 'power', value: 1e9 }] })
  assert.deepEqual(s.tuning, { power: 2, drag: 1, grip: 1, brake: 1 })
  // Blinding person sensing weakens the kernel: a production worker refuses it, whoever asks.
  s = step({ cmds: [{ c: 'blind', on: true, ttlMs: 60_000 }] })
  assert.equal(s.blind, false)
  assert.equal(s.rejected, 14)
  // A car is never dropped onto a person.
  const a = s.avatar
  s = step({ cmds: [{ c: 'recover', i: 0, x: a.x + 1, z: a.z }] })
  assert.equal(s.rejected, 15)
  const refusal = s.events.at(-1)
  assert.match(refusal?.e === 'rejected' ? refusal.reason : '', /a person is standing there/)
})

test('a ?debug worker grants a harness blind, bounded on its own clock: 60 s asked, 20 s granted', async () => {
  const { step } = await core(true)
  let s = step({ cmds: [{ c: 'blind', on: true, ttlMs: 60_000 }] })
  assert.equal(s.blind, true)
  for (let i = 0; i < 20 * 60 + 5; i++) s = step()
  assert.equal(s.blind, false)
})

test('the Ring-0 audit runs in the realm: an impact halts it for good, and a halted realm changes nothing', async () => {
  const { sim, poses, step } = await core(true)
  // Fault injection: the Sanctuary off, person sensing blind, a car rolled at the solid avatar.
  step({ cmds: [{ c: 'dbgSanctuary', on: false }, { c: 'blind', on: true, ttlMs: 15_000 }, { c: 'dbgMode', i: 2, mode: 'player' }, { c: 'recover', i: 2, x: OPEN.x, z: OPEN.z - 16, heading: 0 }] })
  for (let i = 0; i < 40; i++) step()
  step({ cmds: [{ c: 'dbgVelocity', i: 2, x: 0, y: 0, z: 12 }] })
  let s = step()
  for (let i = 0; i < 240 && !sim.halted; i++) s = step()
  assert.equal(sim.halted, true)
  assert.match(sim.panic ?? '', /First-Law Violation/)
  assert.equal(s.kernel.audit.panic, sim.panic)
  const frozen = Float32Array.from(poses), t = s.simTime
  s = step({ cmds: [{ c: 'dbgSanctuary', on: true }, { c: 'interact' }], dt: 0.05 })
  assert.equal(s.simTime, t, 'the clock stopped')
  assert.deepEqual(Array.from(poses), Array.from(frozen), 'nothing moved')
})

const hostStep = (id: number, extra: Record<string, unknown> = {}) => ({ t: 'step', id, dt: H, foot: {}, drive: {}, cmds: [], ...extra })

test('the message door caps simulated time at 1.5x wall time: a flood of steps cannot fast-forward the city', async () => {
  const out: FromWorker[] = []
  const handle = createSimHost((msg) => out.push(msg))
  await handle({ t: 'init', seed: 11, cars: 1, agents: AGENTS, boxes: [], furniture: NO_FURNITURE, spawn: OPEN, debug: false } satisfies SimInit)
  const t0 = performance.now()
  for (let i = 0; i < 200; i++) await handle(hostStep(i, { dt: 0.1 }))
  const wall = (performance.now() - t0) / 1000
  const last = out.at(-1)
  assert.ok(last?.t === 'state')
  if (last?.t !== 'state') return
  // 200 steps asking 0.1 s each would be 20 s; the bank allows 0.25 s plus 1.5x the wall time the flood took.
  assert.ok(last.simTime <= 0.25 + 1.5 * wall + 1e-6, `simulated ${last.simTime.toFixed(3)} s in ${wall.toFixed(3)} s of wall time`)
})

test('the message door ignores any pedestrian data or clock the page slips into a step', async () => {
  const out: FromWorker[] = []
  const crowd = new FakeCrowd()
  const handle = createSimHost((msg) => out.push(msg), (o) => SimCore.create(o, async () => crowd))
  await handle({ t: 'init', seed: 11, cars: 4, agents: AGENTS, boxes: [], furniture: NO_FURNITURE, spawn: OPEN, debug: false } satisfies SimInit)
  const law1 = () => { const m = out.at(-1)!; return m.t === 'state' ? m.kernel.law1 : NaN }
  for (let i = 0; i < 30; i++) await handle(hostStep(i))
  const before = law1()
  // A page that claims everyone is at every bumper, that a pedestrian went non-finite, and that it is next year.
  const lies = { hazards: new Float32Array(2 * MAX_CARS).fill(0), gpuFlags: 1, time: 3e7, signalTime: 3e7 }
  for (let i = 0; i < 30; i++) await handle(hostStep(100 + i, lies))
  const last = out.at(-1)!
  assert.equal(last.t, 'state', 'no panic: the page cannot report a GPU fault for the realm')
  if (last.t !== 'state') return
  assert.equal(last.kernel.audit.panic, null)
  assert.equal(law1(), before, 'no hold: the page cannot place people in front of cars either')
  assert.ok(last.simTime < 2, 'the realm keeps its own clock')
})

test('the message door: one init, steps only after it, unknown messages refused, buffers transferred and taken back, silent after a panic', async () => {
  const out: { msg: FromWorker; transfer?: Transferable[] }[] = []
  const crowd = new FakeCrowd()
  const handle = createSimHost((msg, transfer) => out.push({ msg, transfer }), (o) => SimCore.create(o, async () => crowd))
  const init: SimInit = { t: 'init', seed: 11, cars: 3, agents: AGENTS, boxes: [], furniture: NO_FURNITURE, spawn: OPEN, debug: false }
  await handle({ t: 'step', id: 1 })
  await handle('hello')
  await handle(init)
  assert.equal(out[0].msg.t, 'ready')
  const ready = out[0].msg
  assert.ok(ready.t === 'ready' && ready.meta.agents === AGENTS)
  await handle({ ...init, debug: true })
  await handle({ t: 'eval', code: 'globalThis' })
  await handle(hostStep(7, { cmds: [{ c: 'dbgSanctuary', on: false }] }))
  const st = out[1].msg
  assert.equal(st.t, 'state')
  if (st.t !== 'state') return
  assert.equal(st.id, 7)
  assert.equal(out[1].transfer?.[0], st.poses.buffer, 'the pose buffer is transferred, not shared')
  assert.ok(st.crowdFrame, 'the primed frame ships with the first state')
  assert.equal(out[1].transfer?.[1], st.crowdFrame!.buffer, 'so is the crowd frame')
  // step-before-init, a non-object, the second init, the unknown message, the refused dbg command.
  assert.equal(st.rejected, 5)
  // Buffers handed back are reused: the pose buffer here, the crowd frame's by the crowd.
  const back = st.poses.buffer, crowdBack = st.crowdFrame!.buffer
  await handle(hostStep(8, { buffer: back, crowdBuffer: crowdBack }))
  const st2 = out[2].msg
  assert.ok(st2.t === 'state' && st2.poses.buffer === back)
  assert.equal(crowd.recycled.at(-1), crowdBack)
  // A panic is posted once, after the state that carries it; then the door is shut.
  crowd.flags = 1
  await handle(hostStep(9))
  assert.deepEqual(out.slice(3).map((o) => o.msg.t), ['state', 'panic'])
  const n = out.length
  await handle(hostStep(10))
  await handle(init)
  assert.equal(out.length, n)
})

/** The avatar seated in car `i` (parked beside it first), on open ground, heading +z. */
function seat(step: (o?: Partial<StepInput>) => ReturnType<SimCore['step']>, i: number) {
  step({ cmds: [{ c: 'dbgMode', i, mode: 'parked' }, { c: 'recover', i, x: OPEN.x + 3.5, z: OPEN.z, heading: 0 }] })
  for (let k = 0; k < 60; k++) step()
  const s = step({ cmds: [{ c: 'interact' }] })
  assert.equal(s.driving, i)
}
const REVERSE = { steer: 0, fwd: 0, back: 1, handbrake: false }

test('boot waits for the crowd\'s first reading even when it lands in a later task, as the GPU\'s does', async () => {
  const crowd = new FakeCrowd()
  crowd.later = true
  const { sim } = await core(false, 4, crowd)
  assert.equal(sim.halted, false)
  assert.equal(crowd.steps.length, 1, 'one priming step')
  assert.notEqual(crowd.readout, null, 'create() resolved only once the reading was in')
})

test('reversing cars read the crowd\'s "behind" slots too: held for a person behind, aged when stale, held when silent', async () => {
  const crowd = new FakeCrowd()
  const { poses, step } = await core(true, 4, crowd)
  seat(step, 0)
  let s = step({ drive: REVERSE })
  assert.ok(poses[POSE.throttle] < 0, 'nobody behind: reverse is granted')
  // Someone 1 m behind the bumper: the reverse throttle is refused.
  crowd.behind[0] = 1.0
  step({ drive: IDLE })
  let law1 = step({ drive: IDLE }).kernel.law1
  s = step({ drive: REVERSE })
  assert.equal(poses[POSE.throttle], 0)
  assert.ok(s.kernel.law1 > law1)
  // A reading just outside the standoff is fine fresh, and closes in as it ages (the person may have walked up).
  crowd.behind[0] = KERNEL.standoff + 0.3
  for (let k = 0; k < 30; k++) step({ drive: IDLE, cmds: [{ c: 'dbgVelocity', i: 0, x: 0, y: 0, z: 0 }] })
  s = step({ drive: REVERSE, cmds: [{ c: 'dbgVelocity', i: 0, x: 0, y: 0, z: 0 }] })
  assert.ok(poses[POSE.throttle] < 0, 'fresh, 1.8 m behind is clear of the standoff')
  crowd.answering = false
  law1 = s.kernel.law1
  for (let k = 0; k < 10; k++) s = step({ drive: REVERSE, cmds: [{ c: 'dbgVelocity', i: 0, x: 0, y: 0, z: 0 }] })
  assert.ok(s.crowd.ageMs! > 150)
  assert.equal(poses[POSE.throttle], 0, 'stale, the person behind may have walked up: held')
  // Silent for over a second with an empty street behind: still held.
  crowd.behind[0] = Infinity
  crowd.answering = true
  step({ drive: IDLE })
  crowd.answering = false
  for (let k = 0; k < 65; k++) s = step({ drive: IDLE, cmds: [{ c: 'dbgVelocity', i: 0, x: 0, y: 0, z: 0 }] })
  s = step({ drive: REVERSE, cmds: [{ c: 'dbgVelocity', i: 0, x: 0, y: 0, z: 0 }] })
  assert.ok(s.crowd.ageMs! > 1000)
  assert.equal(poses[POSE.throttle], 0, 'silent: nobody behind can be vouched for')
})

test('aging, the walk term: a standing car is held once a pedestrian could have walked into the standoff', async () => {
  // A standing car's envelope is the standoff alone (1.5 m), and it travels nothing: only the pedestrian's walk
  // (3 m/s × age) can bring a 1.8 m reading inside it. Without that term this car would pull away.
  const crowd = new FakeCrowd()
  const { poses, step } = await core(true, 4, crowd)
  const go = { cmds: [{ c: 'dbgVelocity', i: 1, x: 0, y: 0, z: 0 }, { c: 'intent', i: 1, throttle: 1, brake: 0, steer: 0 }] }
  step({ cmds: [{ c: 'recover', i: 1, x: OPEN.x, z: OPEN.z + 40, heading: 0 }] })
  for (let k = 0; k < 60; k++) step()
  crowd.ahead[1] = KERNEL.standoff + 0.3
  step()
  let s = step(go)
  assert.equal(poses[1 * POSE.stride + POSE.throttle], 1, 'fresh: 1.8 m ahead of a standing car, it may pull away')
  crowd.answering = false
  for (let k = 0; k < 8; k++) s = step(go)
  assert.ok(s.crowd.ageMs! > 140 && s.crowd.ageMs! < 200, `${s.crowd.ageMs} ms`)
  assert.equal(poses[1 * POSE.stride + POSE.throttle], 0, 'stale by ~0.15 s, the person may have walked 0.45 m: held')
  assert.equal(poses[1 * POSE.stride + POSE.brake], KERNEL.maxBrake)
})

test('aging, the car term: a fast car is held once it could have driven the reading away, well before walking alone would', async () => {
  // At 14 m/s the envelope is ~16 m. A 17.2 m reading is clear while fresh. Stale, the car can have covered
  // 14·(age − 0.1) m and the person 3·age m: inside by ~0.18 s. Walking alone would take ~0.5 s.
  const crowd = new FakeCrowd()
  const { poses, step } = await core(true, 4, crowd)
  rolling(step, 1, 14)
  crowd.ahead[1] = 17.2
  let s = step()
  const law1 = s.kernel.law1
  for (let k = 0; k < 3; k++) s = step()
  assert.equal(s.kernel.law1, law1, 'fresh: clear')
  crowd.answering = false
  let heldAt = -1
  for (let k = 0; k < 20 && heldAt < 0; k++) {
    s = step()
    if (s.kernel.law1 > law1) heldAt = s.crowd.ageMs!
  }
  assert.ok(heldAt > 100 && heldAt < 300, `held at ${heldAt} ms of staleness`)
  assert.equal(poses[1 * POSE.stride + POSE.brake], KERNEL.maxBrake)
})

test('a ?debug hazard override holds a car, and clearing it lets the car go', async () => {
  const crowd = new FakeCrowd()
  const { poses, step } = await core(true, 4, crowd)
  rolling(step, 1, 8)
  const law1 = step().kernel.law1
  const s = step({ cmds: [{ c: 'dbgHazard', i: 1, ahead: 3 }] })
  assert.ok(s.kernel.law1 > law1)
  assert.equal(poses[1 * POSE.stride + POSE.brake], KERNEL.maxBrake)
  step({ cmds: [{ c: 'dbgHazard', i: 1, ahead: null }] })
  for (let k = 0; k < 120 && Math.abs(poses[1 * POSE.stride + POSE.speed]) > 0.05; k++) step()
  const go = step({ cmds: [{ c: 'intent', i: 1, throttle: 1, brake: 0, steer: 0 }] })
  assert.equal(poses[1 * POSE.stride + POSE.throttle], 1, 'cleared: the car may go again')
  assert.equal(go.kernel.audit.panic, null)
})

test('the cars obey the realm clock: the product\'s traffic-lights harness, reading the lights off simTime, passes', async () => {
  const { sim, poses, step } = await core(false, 24, new FakeCrowd())
  let last = step()
  const sleep = async (ms: number) => { for (let t = 0; t < ms; t += 1000 / 60) last = step() }
  await sleep(3000)
  const controls = {
    vehicles: {
      count: () => sim.meta.count,
      state: (i: number) => {
        const o = i * POSE.stride
        return { x: poses[o + POSE.x], z: poses[o + POSE.z], heading: poses[o + POSE.heading], speed: poses[o + POSE.speed], mode: MODES[poses[o + POSE.mode]], suv: sim.meta.suv[i] }
      },
    },
    snapshot: () => ({ customer: { signalEW: signalFor('ew', last.simTime), signalNS: signalFor('ns', last.simTime) } }),
  } as unknown as SimControls
  const report = await runHarness('traffic-lights', controls, sleep)
  assert.ok(report.pass, report.lines.join(' | '))
})

test('"nobody ahead" only ever vouched for the sensing range: aged, it holds a fast car as a reading at the range would', async () => {
  // At 15 m/s the envelope is 1.5 + 15 + 1.5 = 18 m. An empty-corridor reading is fine while fresh; once stale it is a
  // reading at KERNEL.range (30 m), aged like any other: inside the envelope by ~0.75 s, not only at the 1 s cutoff.
  const crowd = new FakeCrowd()
  const { poses, step } = await core(true, 4, crowd)
  rolling(step, 1, 15)
  let s = step()
  const law1 = s.kernel.law1
  for (let k = 0; k < 3; k++) s = step()
  assert.equal(s.kernel.law1, law1, 'fresh: an empty corridor is empty')
  crowd.answering = false
  let heldAt = -1
  for (let k = 0; k < 70 && heldAt < 0; k++) {
    s = step()
    if (s.kernel.law1 > law1) heldAt = s.crowd.ageMs!
  }
  assert.ok(heldAt > 600 && heldAt < 950, `held at ${heldAt.toFixed(0)} ms of staleness (the 1 s cutoff would be 1000+)`)
  assert.equal(poses[1 * POSE.stride + POSE.brake], KERNEL.maxBrake)
})

test('a car moved by recover vouches for nobody until a reading taken where it now stands lands', async () => {
  const crowd = new FakeCrowd()
  const { poses, step } = await core(true, 4, crowd)
  const go = { cmds: [{ c: 'intent', i: 1, throttle: 1, brake: 0, steer: 0 }] }
  step({ cmds: [{ c: 'recover', i: 1, x: OPEN.x, z: OPEN.z + 40, heading: 0 }] })
  for (let k = 0; k < 60; k++) step()
  step(go)
  assert.equal(poses[1 * POSE.stride + POSE.throttle], 1, 'an empty street: it may go')
  // Moved (in production too: the operator's recover) with the old street's "nobody" still the newest reading.
  crowd.answering = false
  let s = step({ cmds: [{ c: 'recover', i: 1, x: OPEN.x + 20, z: OPEN.z + 40, heading: Math.PI }, { c: 'intent', i: 1, throttle: 1, brake: 0, steer: 0 }] })
  assert.equal(poses[1 * POSE.stride + POSE.throttle], 0, 'held: nothing it knows describes where it now stands')
  s = step(go)
  assert.equal(poses[1 * POSE.stride + POSE.throttle], 0, 'still held while the sensor has not measured it here')
  crowd.answering = true
  step(go) // this step's crowd dispatch measures it at its new spot
  s = step(go)
  assert.equal(poses[1 * POSE.stride + POSE.throttle], 1, 'measured where it stands: free again')
  assert.equal(s.kernel.audit.panic, null)
})

test('a scripted intent is ruled on this step\'s sensing, not the previous step\'s', async () => {
  const crowd = new FakeCrowd()
  const { poses, step } = await core(true, 4, crowd)
  step({ cmds: [{ c: 'recover', i: 1, x: OPEN.x, z: OPEN.z + 40, heading: 0 }] })
  for (let k = 0; k < 60; k++) step()
  // A person appears 1 m ahead in the reading that lands at the end of this step (the feed of the next).
  crowd.ahead[1] = 1.0
  step()
  const s = step({ cmds: [{ c: 'dbgVelocity', i: 1, x: 0, y: 0, z: 0 }, { c: 'intent', i: 1, throttle: 1, brake: 0, steer: 0 }] })
  assert.equal(poses[1 * POSE.stride + POSE.throttle], 0, 'the intent met the person in this step\'s feed')
  assert.ok(s.kernel.last.startsWith('First Law'), s.kernel.last)
})

test('aging credits the distance a car actually drove, not only its speed now: a car that sped then stopped is not under-aged', async () => {
  // A stopped car read 6 m from a person. The sensor goes quiet; the car covers 4 m at 20 m/s and stops. Its speed
  // now (0) says it drove nothing; its odometer says 4 m. The person is then within ~1.3 m, inside the 1.5 m standoff.
  const crowd = new FakeCrowd()
  const { poses, step } = await core(true, 4, crowd)
  step({ cmds: [{ c: 'dbgMode', i: 1, mode: 'player' }, { c: 'recover', i: 1, x: OPEN.x, z: OPEN.z + 40, heading: 0 }] })
  for (let k = 0; k < 60; k++) step()
  crowd.ahead[1] = 6
  step()
  step()
  crowd.answering = false
  for (let k = 0; k < 12; k++) step({ cmds: [{ c: 'dbgVelocity', i: 1, x: 0, y: 0, z: 20 }] })
  step({ cmds: [{ c: 'dbgVelocity', i: 1, x: 0, y: 0, z: 0 }] })
  const s = step({ cmds: [{ c: 'dbgVelocity', i: 1, x: 0, y: 0, z: 0 }, { c: 'intent', i: 1, throttle: 1, brake: 0, steer: 0 }] })
  assert.ok(s.crowd.ageMs! < 400, `${s.crowd.ageMs} ms`)
  assert.equal(poses[1 * POSE.stride + POSE.throttle], 0, 'held: the car drove 4 m of its 6 m since the reading')
})

// ---------------------------------------------------------------- recruitment

/** A sidewalk on open ground: 5.8 m east of a north-south street's centreline, mid-block (skills.ts onRoad). */
const WALK_AT = { x: -600 + 5.8, z: 20 }
/** Pedestrians (1…AGENTS-1) with and without `skill`, in index order. */
const withSkill = (skill: Skill) => Array.from({ length: AGENTS - 1 }, (_, k) => k + 1).filter((a) => skillsOf(a).includes(skill))
const without = (skill: Skill) => Array.from({ length: AGENTS - 1 }, (_, k) => k + 1).filter((a) => !skillsOf(a).includes(skill))
const recruitEvents = (events: SimEvent[]) => events.filter((e) => e.e === 'recruit' || e.e === 'active' || e.e === 'released')

/** A crowd and a core with the avatar standing on the sidewalk at WALK_AT; `place(agent, dx, dz)` puts someone near it. */
async function street(debug = false) {
  const crowd = new FakeCrowd()
  const { sim, poses, step } = await core(debug, 4, crowd)
  step({ cmds: [{ c: 'teleport', x: WALK_AT.x, z: WALK_AT.z }] })
  for (let k = 0; k < 30; k++) step()
  const place = (agent: number, dx: number, dz: number) => { crowd.xz[2 * agent] = WALK_AT.x + dx; crowd.xz[2 * agent + 1] = WALK_AT.z + dz }
  step() // a reading that has them
  return { sim, poses, step, crowd, place }
}

test('recruit: the page\'s pick is honoured only if it still qualifies on the realm\'s own reading; otherwise the nearest who does', async () => {
  const { step, crowd, place } = await street()
  const [a, b, c] = withSkill('Rust')
  const [plain] = without('Rust')
  place(a, 0, 3) // 3 m up the same sidewalk
  place(b, 0, -2) // nearer
  place(c, -9, 0) // across the street (the other kerb, 9 m west): out of earshot and across a carriageway
  place(plain, 0, 1) // nearest of all, but no Rust
  step()
  let s = step({ cmds: [{ c: 'recruit', id: 1, skill: 'rust', agent: a }] })
  assert.deepEqual(recruitEvents(s.events), [{ e: 'recruit', id: 1, ok: true, agent: a, skill: 'Rust', distance: 3 }])
  assert.deepEqual(s.recruits.map((r) => [r.agent, r.skill, r.state, r.arrived]), [[a, 'Rust', 'Interviewing', false]])
  assert.deepEqual(s.recruits[0].skills, ['Rust', ...skillsOf(a).filter((x) => x !== 'Rust')], 'every skill they have, the one asked for first')
  assert.deepEqual([s.recruits[0].x, s.recruits[0].z], [Math.fround(WALK_AT.x), WALK_AT.z + 3], "where the realm's own reading has them")
  // The summons rides in the very next crowd step, to where the operator stands.
  const sent = crowd.steps.at(-1)!.summons
  assert.equal(sent.length, 1)
  assert.equal(sent[0].agent, a)
  assert.ok(Math.abs(sent[0].x - WALK_AT.x) < 0.05 && Math.abs(sent[0].z - WALK_AT.z) < 0.05)
  crowd.activity[a] = ACTIVITY.coming
  // A pick without the skill: the realm asks the nearest who has it (b), never the page's choice.
  s = step({ cmds: [{ c: 'recruit', id: 2, skill: 'Rust', agent: plain }] })
  assert.deepEqual(recruitEvents(s.events), [{ e: 'recruit', id: 2, ok: true, agent: b, skill: 'Rust', distance: 2 }])
  crowd.activity[b] = ACTIVITY.coming
  // Across the street: never, even named; and nobody else qualifies now (a and b are already coming).
  s = step({ cmds: [{ c: 'recruit', id: 3, skill: 'Rust', agent: c }] })
  assert.deepEqual(recruitEvents(s.events), [{ e: 'recruit', id: 3, ok: false, skill: 'Rust', reason: 'nobody within 5 m on this side of the street knows Rust' }])
  // Someone already coming is not asked twice.
  s = step({ cmds: [{ c: 'recruit', id: 4, skill: 'Rust', agent: a }] })
  assert.equal((recruitEvents(s.events)[0] as { ok: boolean }).ok, false)
  assert.deepEqual(s.recruits.map((r) => r.agent), [a, b])
  assert.deepEqual(crowd.steps.at(-1)!.summons.map((m) => m.agent), [a, b])
})

test('recruit: refused on the road, at the wheel, when every slot is taken, and for a skill the city does not know', async () => {
  const { step, crowd, place } = await street(true)
  const rust = withSkill('Rust')
  rust.slice(0, RECRUIT_SLOTS + 1).forEach((agent, k) => place(agent, 0, -4 + k * 0.9))
  step()
  // Standing in the road: nobody is called into it.
  step({ cmds: [{ c: 'teleport', x: WALK_AT.x - 5.8, z: WALK_AT.z }] })
  for (let k = 0; k < 10; k++) step()
  let s = step({ cmds: [{ c: 'recruit', id: 1, skill: 'Rust' }] })
  assert.deepEqual(recruitEvents(s.events), [{ e: 'recruit', id: 1, ok: false, skill: 'Rust', reason: 'step onto the sidewalk first: nobody is called into the road' }])
  step({ cmds: [{ c: 'teleport', x: WALK_AT.x, z: WALK_AT.z }] })
  for (let k = 0; k < 10; k++) step()
  // A skill nobody has heard of is a malformed command: counted and dropped, no answer.
  const before = step().rejected
  s = step({ cmds: [{ c: 'recruit', id: 2, skill: 'juggling' }, { c: 'recruit', id: 3, skill: 42 as unknown as string }] })
  assert.equal(s.rejected, before + 2)
  assert.deepEqual(recruitEvents(s.events), [])
  // Every slot: the next request waits for someone to be dismissed.
  for (let k = 0; k < RECRUIT_SLOTS; k++) {
    s = step({ cmds: [{ c: 'recruit', id: 10 + k, skill: 'Rust' }] })
    const e = recruitEvents(s.events)[0] as { ok: boolean; agent: number }
    assert.ok(e.ok, JSON.stringify(e))
    crowd.activity[e.agent] = ACTIVITY.coming
  }
  s = step({ cmds: [{ c: 'recruit', id: 99, skill: 'Rust' }] })
  assert.deepEqual(recruitEvents(s.events), [{ e: 'recruit', id: 99, ok: false, skill: 'Rust', reason: `the swarm is full (${RECRUIT_SLOTS} people): dismiss someone first` }])
  assert.equal(crowd.steps.at(-1)!.summons.length, RECRUIT_SLOTS)
  // dismiss: one, then everyone.
  const first = s.recruits[0].agent
  s = step({ cmds: [{ c: 'dismiss', agent: first }] })
  assert.deepEqual(recruitEvents(s.events), [{ e: 'released', agent: first, skill: 'Rust', reason: 'dismissed' }])
  s = step({ cmds: [{ c: 'dismiss' }] })
  assert.equal(recruitEvents(s.events).length, RECRUIT_SLOTS - 1)
  assert.deepEqual(s.recruits, [])
  assert.deepEqual(crowd.steps.at(-1)!.summons, [])
  const r0 = s.rejected
  s = step({ cmds: [{ c: 'dismiss', agent: 1.5 }] })
  assert.equal(s.rejected, r0 + 1)
  // At the wheel: recruiting works on foot, and anyone coming over is let go when the operator drives off.
  step({ cmds: [{ c: 'recruit', id: 100, skill: 'Rust' }] })
  crowd.activity[rust[0]] = ACTIVITY.coming
  step({ cmds: [{ c: 'dbgMode', i: 0, mode: 'parked' }, { c: 'recover', i: 0, x: WALK_AT.x + 3.5, z: WALK_AT.z, heading: 0 }] })
  for (let k = 0; k < 30; k++) step()
  s = step({ cmds: [{ c: 'interact' }] })
  assert.equal(s.driving, 0)
  assert.deepEqual(recruitEvents(s.events).map((e) => [e.e, (e as { reason?: string }).reason]), [['released', 'the operator drove off']])
  s = step({ cmds: [{ c: 'recruit', id: 101, skill: 'Rust' }] })
  assert.deepEqual(recruitEvents(s.events), [{ e: 'recruit', id: 101, ok: false, skill: 'Rust', reason: 'recruiting works on foot' }])
})

test('recruit: Active once the crowd says they arrived, then tethered; released when they never came, never arrived, or the operator left', async () => {
  const { step, crowd, place } = await street()
  const [a, b, c, d] = withSkill('Design')
  for (const [agent, dz] of [[a, 2], [b, -2], [c, 3], [d, -3]] as const) place(agent, 0, dz)
  step()
  const ask = (id: number) => {
    const e = recruitEvents(step({ cmds: [{ c: 'recruit', id, skill: 'design' }] }).events)[0] as { ok: boolean; agent: number }
    assert.ok(e.ok)
    return e.agent
  }
  const run = (seconds: number, onEach?: () => void) => {
    const events: SimEvent[] = []
    let last = step({ dt: 0.1 })
    for (let t = 0; t < seconds; t += 0.1) { onEach?.(); last = step({ dt: 0.1 }); events.push(...recruitEvents(last.events)) }
    return { events, last }
  }
  // 1. Arrives: Active, with every skill they have. Tethered from then on: no timer ends it, every summons points at
  // where the operator stands now, and falling behind (coming again) does not make them Interviewing again.
  const one = ask(1)
  crowd.activity[one] = ACTIVITY.coming
  run(2)
  assert.equal(crowd.steps.at(-1)!.summons[0].tethered, false, 'walking over: their own pace')
  crowd.activity[one] = ACTIVITY.interviewing
  let r = run(1)
  const skills = ['Design', ...skillsOf(one).filter((x) => x !== 'Design')]
  assert.deepEqual(r.events, [{ e: 'active', agent: one, skill: 'Design', skills }])
  assert.deepEqual(r.last.recruits.map((x) => [x.agent, x.state, x.arrived, x.skills]), [[one, 'Active', true, skills]])
  r = run(60)
  assert.deepEqual(r.events, [], 'a minute on: still tethered')
  assert.equal(crowd.steps.at(-1)!.summons[0].tethered, true, 'Active: the GPU lets them hurry after the operator')
  assert.ok(TETHER_PACE > WALK && TETHER_PACE < RUN, 'a tethered recruit keeps up with a walk; a run outpaces them')
  // The operator walks 6 m up the sidewalk; the recruit (as the crowd reads them) follows, falling behind a little.
  step({ cmds: [{ c: 'teleport', x: WALK_AT.x, z: WALK_AT.z + 6 }] })
  crowd.activity[one] = ACTIVITY.coming
  place(one, 0, 4)
  r = run(2)
  assert.deepEqual(r.events, [])
  assert.equal(r.last.recruits[0].state, 'Active', 'catching up is still Active')
  const m = crowd.steps.at(-1)!.summons[0]
  assert.equal(m.agent, one)
  assert.ok(Math.abs(m.x - WALK_AT.x) < 0.05 && Math.abs(m.z - (WALK_AT.z + 6)) < 0.05, 'the summons follows the operator')
  crowd.activity[one] = ACTIVITY.interviewing
  place(one, 0, 4.5)
  r = run(1)
  assert.deepEqual(r.events, [], 'caught up: no second arrival')
  // Beyond RELEASE_DISTANCE (the recruit held back, say at a kerb the operator crossed): the tether breaks.
  const broke = recruitEvents(step({ cmds: [{ c: 'teleport', x: WALK_AT.x, z: WALK_AT.z + 4.5 + RELEASE_DISTANCE + 1 }] }).events)
  r = run(1)
  assert.deepEqual([...broke, ...r.events], [{ e: 'released', agent: one, skill: 'Design', reason: 'the operator walked away' }])
  assert.deepEqual(r.last.recruits, [])
  crowd.activity[one] = ACTIVITY.routine
  step({ cmds: [{ c: 'teleport', x: WALK_AT.x, z: WALK_AT.z }] })
  run(1)
  // 2. The crowd never took the summons (they had stepped onto a crosswalk): let go after the grace.
  const two = ask(2)
  crowd.activity[two] = ACTIVITY.crossing
  r = run(0.5)
  assert.deepEqual(r.events, [], 'not before the grace')
  r = run(1)
  assert.deepEqual(r.events, [{ e: 'released', agent: two, skill: 'Design', reason: 'they did not hear the operator' }])
  // 3. Coming (or stepping back from a car on the way) but never arriving.
  const three = ask(3)
  crowd.activity[three] = ACTIVITY.steppingBack
  r = run(2)
  crowd.activity[three] = ACTIVITY.coming
  r = run(APPROACH_SECONDS)
  assert.deepEqual(r.events, [{ e: 'released', agent: three, skill: 'Design', reason: 'they could not reach the operator' }])
  crowd.activity[three] = ACTIVITY.routine
  // 4. The operator walks off: released once they are more than RELEASE_DISTANCE apart.
  const four = ask(4)
  crowd.activity[four] = ACTIVITY.coming
  r = run(3)
  assert.deepEqual(r.events, [], 'still coming: nothing ends')
  // Along the same sidewalk, beyond RELEASE_DISTANCE from them (the reading places them within 3 m of WALK_AT).
  const moved = recruitEvents(step({ cmds: [{ c: 'teleport', x: WALK_AT.x, z: WALK_AT.z + 17 }] }).events)
  r = run(1)
  assert.deepEqual([...moved, ...r.events], [{ e: 'released', agent: four, skill: 'Design', reason: 'the operator walked away' }])
  assert.deepEqual(crowd.steps.at(-1)!.summons, [])
})

test('recruit: every recruitment gets a serial of its own, never reused, even for the same person asked over again', async () => {
  const { step, crowd, place } = await street()
  const [a, b] = withSkill('Rust')
  place(a, 0, 2)
  place(b, 0, -2)
  step()
  const ask = (id: number, agent: number): number => {
    const s = step({ cmds: [{ c: 'recruit', id, skill: 'Rust', agent }] })
    crowd.activity[agent] = ACTIVITY.coming
    return s.recruits.find((r) => r.agent === agent)!.serial
  }
  const first = ask(1, a)
  const second = ask(2, b)
  step({ cmds: [{ c: 'dismiss', agent: a }] })
  crowd.activity[a] = ACTIVITY.routine
  step()
  const again = ask(3, a)
  assert.deepEqual([first, second, again], [1, 2, 3])
})

const rallyEvents = (events: SimEvent[]) => events.filter((e) => e.e === 'rally')

/** A street with two Design recruits over: `one` Active (2 m up the sidewalk), `two` still walking over (2 m down). */
async function rallyStreet() {
  const { sim, step, crowd, place } = await street()
  const [one, two] = withSkill('Design')
  place(one, 0, 2)
  place(two, 0, -2)
  step()
  const ask = (id: number, agent: number) => {
    const e = recruitEvents(step({ cmds: [{ c: 'recruit', id, skill: 'design', agent }] }).events)[0] as { ok: boolean; agent: number }
    assert.ok(e.ok && e.agent === agent)
  }
  ask(1, one)
  crowd.activity[one] = ACTIVITY.interviewing
  for (let k = 0; k < 3; k++) step()
  ask(2, two)
  crowd.activity[two] = ACTIVITY.coming
  const s = step()
  assert.deepEqual(s.recruits.map((r) => [r.agent, r.state]), [[one, 'Active'], [two, 'Interviewing']])
  return { sim, step, crowd, place, one, two }
}

test('rally: an Active recruit is pointed at a sidewalk point the realm checked itself; the summons slot moves to it, the tether does not', async () => {
  const { sim, step, crowd, place, one, two } = await rallyStreet()
  const at = { x: WALK_AT.x, z: WALK_AT.z + 6 }
  let s = step({ cmds: [{ c: 'rally', agent: one, x: at.x, z: at.z }] })
  assert.deepEqual(rallyEvents(s.events), [{ e: 'rally', agent: one, ok: true }])
  assert.deepEqual(s.recruits.find((r) => r.agent === one)!.rally, { x: at.x, z: at.z }, 'the view carries the point while it is in force')
  assert.equal(s.recruits.find((r) => r.agent === two)!.rally, undefined)
  assert.deepEqual(s.recruits.map((r) => [r.agent, r.state, r.arrived]), [[one, 'Active', true], [two, 'Interviewing', false]], 'nobody promoted or demoted')
  plain(s)
  structuredClone(s)
  // The very next crowd step walks them to the point, still tethered (they hurry); the other recruit still comes to the operator.
  let m = crowd.steps.at(-1)!.summons
  assert.deepEqual(m.map((x) => [x.agent, x.tethered]), [[one, true], [two, false]])
  assert.ok(Math.abs(m[0].x - at.x) < 1e-6 && Math.abs(m[0].z - at.z) < 1e-6, 'the Active recruit walks to the rally point')
  assert.ok(Math.abs(m[1].x - WALK_AT.x) < 0.05 && Math.abs(m[1].z - WALK_AT.z) < 0.05, 'the Interviewing one still walks to the operator')
  // They reach it (as the crowd reads them): still Active, still held there, no second arrival, the tether as it was.
  place(one, 0, 6 - 1.5)
  for (let k = 0; k < 5; k++) s = step()
  assert.deepEqual(recruitEvents(s.events), [])
  assert.equal(s.recruits.find((r) => r.agent === one)!.state, 'Active')
  m = crowd.steps.at(-1)!.summons
  assert.ok(Math.abs(m[0].x - at.x) < 1e-6 && Math.abs(m[0].z - at.z) < 1e-6, 'held at the point while the rally is in force')
  // The operator walks away from the point beyond RALLY_RANGE (still within the tether of the recruit): the rally ends on
  // its own, the summons points at the operator again, and they are still Active.
  const back = { x: WALK_AT.x, z: at.z - RALLY_RANGE - 0.5 }
  assert.ok(Math.hypot(back.x - (WALK_AT.x), back.z - (WALK_AT.z + 4.5)) < RELEASE_DISTANCE, 'the test keeps the tether')
  step({ cmds: [{ c: 'teleport', x: back.x, z: back.z }] })
  for (let k = 0; k < 3; k++) s = step()
  assert.equal(s.recruits.find((r) => r.agent === one)!.rally, undefined, 'the rally ended on its own')
  assert.equal(s.recruits.find((r) => r.agent === one)!.state, 'Active')
  m = crowd.steps.at(-1)!.summons
  assert.ok(Math.abs(m[0].x - back.x) < 0.05 && Math.abs(m[0].z - back.z) < 0.05, 'back to following the operator')
  // Walking off beyond RELEASE_DISTANCE still breaks the tether, rally or not: the documented law is unchanged.
  step({ cmds: [{ c: 'teleport', x: WALK_AT.x, z: WALK_AT.z }] })
  for (let k = 0; k < 3; k++) step()
  s = step({ cmds: [{ c: 'rally', agent: one, x: at.x, z: at.z }] })
  assert.deepEqual(rallyEvents(s.events), [{ e: 'rally', agent: one, ok: true }])
  const gone = recruitEvents(step({ cmds: [{ c: 'teleport', x: WALK_AT.x, z: WALK_AT.z + 4.5 - RELEASE_DISTANCE - 1 }] }).events)
  for (let k = 0; k < 3; k++) s = step()
  assert.deepEqual([...gone, ...recruitEvents(s.events)].filter((e) => e.e === 'released' && e.agent === one).length, 1, 'the operator walked away')
  void sim
})

test('rally: refused with a reason for a road point, a point too far, no sidewalk path from where they stand, an Interviewing recruit or a stranger; malformed ones are counted', async () => {
  const { step, crowd, place, one, two } = await rallyStreet()
  const before = crowd.steps.at(-1)!.summons.map((m) => ({ ...m }))
  const refused = (cmd: { agent: number; x: number; z: number }, reason: RegExp) => {
    const s = step({ cmds: [{ c: 'rally', ...cmd }] })
    const ev = rallyEvents(s.events)
    assert.equal(ev.length, 1)
    assert.equal((ev[0] as { ok: boolean }).ok, false)
    assert.match((ev[0] as { reason: string }).reason, reason)
    assert.equal(s.recruits.find((r) => r.agent === cmd.agent)?.rally, undefined)
    return s
  }
  // Into the carriageway (3 m west of the lane is 2.8 m from the street's centreline).
  refused({ agent: one, x: WALK_AT.x - 3, z: WALK_AT.z }, /nobody is sent into the road/)
  // Up the same sidewalk, but farther than RALLY_RANGE from the operator: the tether would break on arrival.
  refused({ agent: one, x: WALK_AT.x, z: WALK_AT.z + RALLY_RANGE + 0.5 }, /too far/)
  // Still walking over: only an Active recruit is sent anywhere.
  refused({ agent: two, x: WALK_AT.x, z: WALK_AT.z + 3 }, /still walking over/)
  // A stranger (nobody by that number is over) and the player's own body.
  const [stranger] = without('Design')
  refused({ agent: stranger, x: WALK_AT.x, z: WALK_AT.z + 3 }, /nobody by that number/)
  refused({ agent: 0, x: WALK_AT.x, z: WALK_AT.z + 3 }, /nobody by that number/)
  // The realm's own reading decides where they stand: with the recruit read across the street (the other kerb, within
  // the tether), a point 2 m from the operator has no sidewalk path from where they stand.
  place(one, -2 * 5.8, 0)
  step()
  let s = refused({ agent: one, x: WALK_AT.x, z: WALK_AT.z + 2 }, /no sidewalk from where they stand/)
  assert.equal(s.recruits.find((r) => r.agent === one)!.state, 'Active', 'still tethered (11.6 m is inside RELEASE_DISTANCE)')
  place(one, 0, 2)
  step()
  // Nothing above moved the summons: both still walk to the operator.
  const after = crowd.steps.at(-1)!.summons
  assert.deepEqual(after.map((m) => [m.agent, m.tethered]), before.map((m) => [m.agent, m.tethered]))
  for (const m of after) assert.ok(Math.abs(m.x - WALK_AT.x) < 0.05 && Math.abs(m.z - WALK_AT.z) < 0.05)
  // Malformed: no pedestrian number, a non-finite point, a point that is not a number. Counted, never answered.
  const rejected = s.rejected
  s = step({ cmds: [
    { c: 'rally', agent: 1.5, x: WALK_AT.x, z: WALK_AT.z },
    { c: 'rally', agent: one, x: NaN, z: WALK_AT.z },
    { c: 'rally', agent: one, x: WALK_AT.x, z: 'here' as unknown as number },
    { c: 'rally' } as unknown as { c: 'rally'; agent: number; x: number; z: number },
  ] })
  assert.equal(s.rejected, rejected + 4)
  assert.deepEqual(rallyEvents(s.events), [])
  assert.equal(s.events.filter((e) => e.e === 'rejected').length, 4)
  assert.equal(s.recruits.find((r) => r.agent === one)!.rally, undefined)
  plain(s)
  // At the wheel the recruits are let go anyway; a rally then names nobody.
  step({ cmds: [{ c: 'setMode', i: 0, mode: 'parked' }, { c: 'recover', i: 0, x: WALK_AT.x + 3.5, z: WALK_AT.z, heading: 0 }] })
  for (let k = 0; k < 30; k++) step()
  s = step({ cmds: [{ c: 'interact' }] })
  assert.equal(s.driving, 0)
  s = step({ cmds: [{ c: 'rally', agent: one, x: WALK_AT.x, z: WALK_AT.z + 3 }] })
  assert.equal(s.recruits.length, 0)
  assert.match((rallyEvents(s.events)[0] as { reason: string }).reason, /on foot|nobody by that number/)
})

test('rally: a dismiss clears it with the recruit, and asking the same person again starts with no rally', async () => {
  const { step, crowd, place, one } = await rallyStreet()
  const at = { x: WALK_AT.x, z: WALK_AT.z + 5 }
  let s = step({ cmds: [{ c: 'rally', agent: one, x: at.x, z: at.z }] })
  assert.deepEqual(rallyEvents(s.events), [{ e: 'rally', agent: one, ok: true }])
  s = step({ cmds: [{ c: 'dismiss', agent: one }] })
  assert.deepEqual(recruitEvents(s.events), [{ e: 'released', agent: one, skill: 'Design', reason: 'dismissed' }])
  assert.deepEqual(s.recruits.map((r) => r.agent).includes(one), false)
  assert.deepEqual(crowd.steps.at(-1)!.summons.map((m) => m.agent).includes(one), false)
  // Asked over again: a new tether, Interviewing, no rally remembered; a rally before they arrive is refused.
  crowd.activity[one] = ACTIVITY.routine
  place(one, 0, 2)
  step()
  s = step({ cmds: [{ c: 'recruit', id: 9, skill: 'design', agent: one }] })
  assert.equal((recruitEvents(s.events)[0] as { ok: boolean }).ok, true)
  assert.equal(s.recruits.find((r) => r.agent === one)!.rally, undefined)
  s = step({ cmds: [{ c: 'rally', agent: one, x: at.x, z: at.z }] })
  assert.match((rallyEvents(s.events)[0] as { reason: string }).reason, /still walking over/)
  // dismiss everyone: no summons, no rally anywhere.
  s = step({ cmds: [{ c: 'dismiss' }] })
  assert.deepEqual(s.recruits, [])
  assert.deepEqual(crowd.steps.at(-1)!.summons, [])
  plain(s)
})

test('recruit: a halted realm answers nothing more, and the state stays plain data', async () => {
  const { sim, step, place } = await street()
  const [a] = withSkill('Audio')
  place(a, 0, 2)
  step()
  const s = step({ cmds: [{ c: 'recruit', id: 7, skill: 'sound', agent: a }] })
  plain(s)
  assert.deepEqual(structuredClone(s.recruits), s.recruits)
  sim.halt('test')
  const after = step({ cmds: [{ c: 'recruit', id: 8, skill: 'audio', agent: a }] })
  assert.deepEqual(recruitEvents(after.events), [])
})

test('an init on tracks builds the fleet on the ring network inside the realm; the door passes only a true flag', async () => {
  const sim = await SimCore.create({ seed: 11, cars: 12, agents: AGENTS, boxes: [], furniture: NO_FURNITURE, spawn: { x: OPEN.x, z: OPEN.z }, debug: false, tracks: true })
  const poses = new Float32Array(sim.meta.count * POSE.stride)
  let last = sim.step({ dt: H, foot: { x: 0, z: 0, heading: 0 }, drive: IDLE, cmds: [] }, poses)
  const first = Float32Array.from(poses)
  for (let k = 0; k < 60; k++) last = sim.step({ dt: H, foot: { x: 0, z: 0, heading: 0 }, drive: IDLE, cmds: [] }, poses)
  assert.equal(sim.halted, false)
  assert.equal(sim.panic, null)
  assert.equal(last.kernel.audit.panic, null)
  assert.ok(poses.every(Number.isFinite))
  plain(last)
  // The cars stand on the city's lanes (the grid spans 0..640), not on the random seats, and some have moved off.
  for (let i = 0; i < sim.meta.count; i++) {
    const x = first[i * POSE.stride + POSE.x], z = first[i * POSE.stride + POSE.z]
    assert.ok(x > -5 && x < 645 && z > -5 && z < 645, `car ${i} at ${x.toFixed(0)}, ${z.toFixed(0)}`)
    const off = Math.abs(x - Math.round(x / 40) * 40), ofz = Math.abs(z - Math.round(z / 40) * 40)
    assert.ok(Math.abs(Math.min(off, ofz) - 2) < 0.05, `car ${i}: ${Math.min(off, ofz).toFixed(2)} m from a centreline`)
  }
  assert.ok(poses.some((v, i) => i % POSE.stride === POSE.speed && v > 1), 'cars are moving')

  const seen: unknown[] = []
  const out: FromWorker[] = []
  const crowd = new FakeCrowd()
  const handle = createSimHost((msg) => out.push(msg), (o) => { seen.push(o.tracks); return SimCore.create(o, async () => crowd) })
  await handle({ t: 'init', seed: 11, cars: 2, agents: AGENTS, boxes: [], furniture: NO_FURNITURE, spawn: OPEN, debug: false, tracks: 'yes' as unknown as boolean } satisfies SimInit)
  assert.deepEqual(seen, [false], 'anything but true is off')
  assert.equal(out.at(-1)?.t, 'ready')
  const seen2: unknown[] = []
  const handle2 = createSimHost(() => {}, (o) => { seen2.push(o.tracks); return SimCore.create(o, async () => new FakeCrowd()) })
  await handle2({ t: 'init', seed: 11, cars: 2, agents: AGENTS, boxes: [], furniture: NO_FURNITURE, spawn: OPEN, debug: false, tracks: true } satisfies SimInit)
  assert.deepEqual(seen2, [true])
})

test('tracks on: a step returns the pose buffer and the craft buffer, plain data on the realm\'s own clock, audited clean; a halted realm returns no craft; the door transfers the craft buffer and takes it back', async () => {
  const crowd = new FakeCrowd()
  const sim = await SimCore.create({ seed: 11, cars: 4, agents: AGENTS, boxes: [], furniture: NO_FURNITURE, spawn: { x: OPEN.x, z: OPEN.z }, debug: false, tracks: true }, async () => crowd)
  const reference = new TrackFleet(buildTrackNetwork(11))
  assert.equal(sim.meta.craft, reference.count)
  assert.ok(sim.meta.craft > 900)
  const poses = new Float32Array(sim.meta.count * POSE.stride)
  const craft = new Float32Array(sim.meta.craft * TRACK_POSE.stride)
  const input = { dt: H, foot: { x: 0, z: 0, heading: 0 }, drive: IDLE, cmds: [] }
  let s = sim.step(input, poses, craft)
  for (let k = 0; k < 30; k++) s = sim.step(input, poses, craft)
  assert.equal(s.craft, craft, 'the buffer handed in comes back filled')
  assert.equal(s.poses, poses)
  plain(s)
  assert.equal(s.kernel.audit.panic, null)
  assert.equal(sim.halted, false)
  assert.ok(craft.every(Number.isFinite))
  assert.equal(auditCraft(craft), null)
  const kinds = new Set<number>()
  for (let i = 0; i < sim.meta.craft; i++) kinds.add(craft[i * TRACK_POSE.stride + TRACK_POSE.kind])
  assert.deepEqual([...kinds].sort(), [TRACK_KINDS.indexOf('train'), TRACK_KINDS.indexOf('drone'), TRACK_KINDS.indexOf('plane')])
  // The craft stand where the realm's clock has them: the timetable evaluated at simTime, bit for bit.
  assert.deepEqual(Array.from(craft), Array.from(reference.writePoses(s.simTime, new Float32Array(reference.length))))
  // The craft move with the clock, and the trains stay on their deck.
  const before = Float32Array.from(craft)
  for (let k = 0; k < 60; k++) s = sim.step(input, poses, craft)
  let moved = 0
  for (let i = 0; i < sim.meta.craft; i++) {
    const o = i * TRACK_POSE.stride
    if (Math.hypot(craft[o + TRACK_POSE.x] - before[o + TRACK_POSE.x], craft[o + TRACK_POSE.z] - before[o + TRACK_POSE.z]) > 1) moved++
    if (craft[o + TRACK_POSE.kind] === TRACK_KINDS.indexOf('train')) assert.equal(craft[o + TRACK_POSE.y], 9)
  }
  assert.ok(moved > sim.meta.craft / 2, `${moved} craft moved in a second`)
  // A step without a craft buffer still runs, and reports none.
  s = sim.step(input, poses)
  assert.equal(s.craft, null)
  assert.equal(sim.halted, false)
  // A halted realm returns nothing new: no craft, its clock stopped.
  const t = s.simTime
  sim.halt('test')
  s = sim.step(input, poses, craft)
  assert.equal(s.craft, null)
  assert.equal(s.simTime, t)
  plain(s)

  // Tracks off: no craft at all, whatever buffer is passed.
  const { sim: plainSim, step } = await core()
  assert.equal(plainSim.meta.craft, 0)
  assert.equal(step().craft, null)
  assert.equal(plainSim.step(input, new Float32Array(plainSim.meta.count * POSE.stride), new Float32Array(0)).craft, null)

  // The door: the craft buffer is transferred after the poses and the crowd frame, and one handed back is reused.
  const out: { msg: FromWorker; transfer?: Transferable[] }[] = []
  const crowd2 = new FakeCrowd()
  const handle = createSimHost((msg, transfer) => out.push({ msg, transfer }), (o) => SimCore.create(o, async () => crowd2))
  await handle({ t: 'init', seed: 11, cars: 2, agents: AGENTS, boxes: [], furniture: NO_FURNITURE, spawn: OPEN, debug: false, tracks: true } satisfies SimInit)
  const ready = out[0].msg
  assert.ok(ready.t === 'ready' && ready.meta.craft === reference.count)
  await handle(hostStep(1))
  const st = out[1].msg
  assert.ok(st.t === 'state')
  if (st.t !== 'state') return
  assert.ok(st.craft instanceof Float32Array && st.craft.length === reference.count * TRACK_POSE.stride)
  assert.equal(auditCraft(st.craft), null)
  assert.deepEqual(out[1].transfer, [st.poses.buffer, st.crowdFrame!.buffer, st.craft.buffer], 'poses, crowd frame, craft: all transferred')
  const back = st.craft.buffer
  await handle(hostStep(2, { craftBuffer: back }))
  const st2 = out[2].msg
  assert.ok(st2.t === 'state' && st2.craft?.buffer === back, 'a craft buffer handed back is the next one filled')
  // A buffer of the wrong size is not taken; a step without one still answers with craft.
  await handle(hostStep(3, { craftBuffer: new ArrayBuffer(8) }))
  const st3 = out[3].msg
  assert.ok(st3.t === 'state' && st3.craft instanceof Float32Array && st3.craft.length === reference.count * TRACK_POSE.stride)
  // After a panic the door is shut; the state that carried it has no craft.
  crowd2.flags = 1
  await handle(hostStep(4))
  const st4 = out[4].msg
  assert.ok(st4.t === 'state' && st4.craft === null, 'a halted realm ships no craft')
  assert.equal(out[5].msg.t, 'panic')
})

test('tracks on over a surveyed region: the fleet keeps its network but no corridor is laid over the region (no craft)', async () => {
  const region = { bounds: { x0: -200, z0: -150, x1: 200, z1: 150 }, walls: [] }
  const sim = await SimCore.create({ seed: 1, cars: 0, agents: AGENTS, boxes: [], furniture: NO_FURNITURE, spawn: { x: 0, z: 0 }, debug: false, region, tracks: true }, null)
  assert.equal(sim.meta.craft, 0)
  const s = sim.step({ dt: H, foot: { x: 0, z: 0, heading: 0 }, drive: IDLE, cmds: [] }, new Float32Array(0), new Float32Array(0))
  assert.equal(s.craft, null)
  assert.equal(sim.halted, false)
})

test('rally: refused for a point inside a building lot (the crowd never enters one), for 11.9 m (inside the tether, past the range), and after a dismiss', async () => {
  const { step, crowd, one } = await rallyStreet()
  const before = crowd.steps.at(-1)!.summons.map((m) => ({ ...m }))
  const refused = (cmd: { agent: number; x: number; z: number }, reason: RegExp) => {
    const s = step({ cmds: [{ c: 'rally', ...cmd }] })
    const ev = rallyEvents(s.events)
    assert.equal(ev.length, 1, JSON.stringify(s.events))
    assert.equal((ev[0] as { ok: boolean }).ok, false)
    assert.match((ev[0] as { reason: string }).reason, reason)
    assert.equal(s.recruits.find((r) => r.agent === cmd.agent)?.rally, undefined)
    return s
  }
  // 2.2 m from the operator, off the road, a straight sidewalk-free walk: but 1 m inside the lot behind the sidewalk.
  const lot = { x: WALK_AT.x + 2.2, z: WALK_AT.z }
  assert.equal(inLot(lot.x, lot.z), true)
  refused({ agent: one, x: lot.x, z: lot.z }, /into a building/)
  // 11.9 m up the sidewalk: inside RELEASE_DISTANCE, but a recruit stopped short of it could still be past the tether.
  assert.ok(11.9 < RELEASE_DISTANCE && 11.9 > RALLY_RANGE)
  refused({ agent: one, x: WALK_AT.x, z: WALK_AT.z + 11.9 }, /too far/)
  const after = crowd.steps.at(-1)!.summons
  assert.deepEqual(after.map((m) => [m.agent, m.tethered]), before.map((m) => [m.agent, m.tethered]))
  for (const m of after) assert.ok(Math.abs(m.x - WALK_AT.x) < 0.05 && Math.abs(m.z - WALK_AT.z) < 0.05, 'nobody was sent anywhere')
  // Dismissed: a rally names nobody.
  let s = step({ cmds: [{ c: 'dismiss', agent: one }] })
  assert.equal(s.recruits.some((r) => r.agent === one), false)
  s = refused({ agent: one, x: WALK_AT.x, z: WALK_AT.z + 3 }, /nobody by that number was asked over/)
  plain(s)
})

test('the message door bridges shared memory: only a SharedArrayBuffer of the exact layout, once, filled under the lock after every step', async () => {
  const out: FromWorker[] = []
  const crowd = new FakeCrowd()
  crowd.xz.fill(0)
  crowd.activity.fill(2)
  const handle = createSimHost((msg) => out.push(msg), (o) => SimCore.create(o, async () => crowd))
  await handle({ t: 'bridge', buffer: new SharedArrayBuffer(64) })
  await handle({ t: 'init', seed: 11, cars: 3, agents: AGENTS, boxes: [], furniture: NO_FURNITURE, spawn: OPEN, debug: false } satisfies SimInit)
  const ready = out[0]
  assert.ok(ready.t === 'ready')
  const counts = { vehicles: ready.meta.count, avatars: ready.meta.players, agents: ready.meta.agents }
  const wrong = PhysicsBridge.create({ ...counts, agents: counts.agents + 1 }, true)
  await handle({ t: 'bridge', buffer: wrong.buffer })
  await handle({ t: 'bridge', buffer: new ArrayBuffer(bridgeBytes(counts)) })
  const bridge = PhysicsBridge.create(counts, true)
  await handle({ t: 'bridge', buffer: bridge.buffer })
  await handle({ t: 'bridge', buffer: PhysicsBridge.create(counts, true).buffer })
  await handle(hostStep(1))
  const st = out.at(-1)
  assert.ok(st?.t === 'state')
  if (st?.t !== 'state') return
  assert.equal(st.rejected, 4, 'before init, the wrong size, a plain buffer, and a second bridge were each refused')
  assert.equal(bridge.seq, 1, 'one publish per step')
  assert.equal(bridge.step, 1)
  assert.equal(wrong.seq, 0)
  for (let i = 0; i < counts.vehicles; i++) {
    const o = bridge.vehicles + SLOT.stride * i, p = i * POSE.stride
    assert.equal(bridge.f32[o + SLOT.x], st.poses[p + POSE.x], `car ${i} x`)
    assert.equal(bridge.f32[o + SLOT.y], st.poses[p + POSE.y], `car ${i} y`)
    assert.equal(bridge.f32[o + SLOT.z], st.poses[p + POSE.z], `car ${i} z`)
    assert.equal(bridge.i32[o + SLOT.state], st.poses[p + POSE.mode], `car ${i} mode`)
  }
  assert.equal(bridge.f32[bridge.avatars + SLOT.x], st.avatar.x)
  assert.equal(bridge.f32[bridge.avatars + SLOT.z], st.avatar.z)
  assert.equal(bridge.i32[bridge.avatars + SLOT.state], 1, 'enabled, not shielded')
  assert.equal(bridge.f32[bridge.agents + SLOT.x], 7, 'the frame the fake crowd primed')
  assert.equal(bridge.i32[bridge.agents + SLOT.state], 2, 'the activity the readout names')
  assert.equal(bridge.driving(0), -1)
  await handle(hostStep(2))
  assert.equal(bridge.seq, 2)
  assert.equal(bridge.step, 2)
})
