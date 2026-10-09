// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the ragdoll balance machine wired into the physics realm, in real Rapier (WASM,
 * run in Node) with the stand-in crowd sensor of simCore.test.ts: a shove in the crowd near the operator promotes one
 * person, whose rig sits down and rises within the machine's own timers and is handed back to the crowd (the jump
 * and the cost measured); a car driven at a rig is passed through by the Sanctuary (every shape flipped, no panic, the
 * car's speed untouched), and with the Sanctuary off and sensing blind the Ring-0 audit halts the realm naming the
 * rig's person; the pool never holds more than RIG_SLOTS rigs and never the operator's own figure; a region, the
 * ragdoll off and a flag that is not exactly true give no rig stream; the state stays plain data; the stream is
 * transferred and taken back by the door; and the step order holds (the stream is written after the audit, never from
 * a halted realm). It also pins the page's copy of the rig's shapes to the rig's own, and the stream's slot count to
 * the pool's.
 * What breaks if it is removed? A rig could be built where the Sanctuary or the audit does not see it, the page could
 * draw a shape the rig does not have, or a vehicle could become a cause, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { POOL_CAPACITY, RISE_TIME, SEATED_TIME, SETTLE_BLEND, SIT_TIME_MAX, PERTURBED_MAX, STEP_TIME, MAX_CATCH_STEPS, TRANSITIONS } from '../03_Spawn_Agents/ragdoll.ts'
import { FOOT, SEGMENTS } from '../03_Spawn_Agents/ragdollRig.ts'
import { MAX_CARS, type CrowdReadout, type CrowdSensor, type CrowdStepInput } from '../03_Spawn_Agents/crowdSensor.ts'
import { COLLISION } from '../02_Define_The_Rules/collision.ts'
import { PERSON_ID_BASE, SHOVE_CLOSING, shapeSpec } from './ragdollRealm.ts'
import { SimCore, type StepInput } from './simCore.ts'
import { createSimHost } from './simHost.ts'
import { POSE, RIG_POSE, RIG_SEGMENTS, RIG_SLOTS, RIG_STATES, type FromWorker, type SimInit } from './simProtocol.ts'

const H = 1 / 60
const NO_FURNITURE = { lamps: [], trees: [], signals: [] }
/** Open ground well away from the street grid, on a street line (z = 0) so nobody crosses a kerb by moving along x. */
const OPEN = { x: -600, z: 0 }
const AGENTS = 256
const IDLE = { steer: 0, fwd: 0, back: 0, handbrake: false }

/** The stand-in crowd of simCore.test.ts: every step reads back at once, stamped as the GPU stamps it. */
class FakeCrowd implements CrowdSensor {
  readonly agentCount: number
  readonly ahead = new Float32Array(MAX_CARS).fill(Infinity)
  readonly behind = new Float32Array(MAX_CARS).fill(Infinity)
  readout: CrowdReadout | null = null
  flags = 0
  lost: string | null = null
  readonly xz: Float32Array
  readonly activity: Uint8Array
  /** Every figure's facing as the GPU reads it back (pos.w); NaN: none. */
  readonly heading: Float32Array
  #frame: Float32Array | null = null
  constructor(agents = AGENTS) {
    this.agentCount = agents
    this.xz = new Float32Array(agents * 2).fill(NaN)
    this.activity = new Uint8Array(agents)
    this.heading = new Float32Array(agents).fill(NaN)
  }
  step(input: CrowdStepInput): void {
    this.readout = {
      seq: input.seq, time: input.time - input.dt, hazardsAhead: Float32Array.from(this.ahead), hazardsBehind: Float32Array.from(this.behind),
      stats: { nudges: 0, waiting: 0, crossing: 0, retreating: 0 }, xz: Float32Array.from(this.xz), activity: Uint8Array.from(this.activity),
      heading: Float32Array.from(this.heading),
    }
    this.#frame = new Float32Array(this.agentCount * 12)
  }
  takeFlags(): number { const f = this.flags; this.flags = 0; return f }
  takeFrame(): Float32Array | null { const f = this.#frame; this.#frame = null; return f }
  recycle(): void {}
  /** The realm's handbacks (CrowdSensor.place with a heading), in order. */
  readonly handedBack: { i: number; x: number; z: number; heading: number }[] = []
  /** Puts pedestrian `i` at (x, z) for the next reading (the tests' crowd walking them; the realm's handback with a heading). */
  place(i: number, x: number, z: number, heading?: number): void {
    this.xz[2 * i] = x
    this.xz[2 * i + 1] = z
    if (heading !== undefined) this.handedBack.push({ i, x, z, heading })
  }
}

async function core(o: { debug?: boolean; cars?: number; ragdoll?: boolean; crowd?: FakeCrowd | null } = {}) {
  const crowd = o.crowd === undefined ? new FakeCrowd() : o.crowd
  const sim = await SimCore.create(
    { seed: 11, cars: o.cars ?? 4, agents: AGENTS, boxes: [], furniture: NO_FURNITURE, spawn: { x: OPEN.x, z: OPEN.z }, debug: o.debug === true, ragdoll: o.ragdoll ?? true },
    crowd ? async () => crowd : null,
  )
  const poses = new Float32Array(sim.meta.count * POSE.stride)
  const rigs = new Float32Array(sim.meta.rigSlots * RIG_POSE.stride)
  const step = (x: Partial<StepInput> = {}) => sim.step({ dt: H, foot: { x: 0, z: 0, heading: 0 }, drive: IDLE, cmds: [], ...x }, poses, null, rigs)
  return { sim, poses, rigs, crowd: crowd!, step }
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

/** The slots in use: agent and state name per slice with an agent. */
function slots(rigs: Float32Array): { slot: number; agent: number; state: string }[] {
  const out: { slot: number; agent: number; state: string }[] = []
  for (let s = 0; s < RIG_SLOTS; s++) {
    const o = s * RIG_POSE.stride
    if (rigs[o + RIG_POSE.agent] >= 0) out.push({ slot: s, agent: rigs[o + RIG_POSE.agent], state: RIG_STATES[rigs[o + RIG_POSE.state]] })
  }
  return out
}

/** Pedestrian `shover` walks into `shoved` (standing still) along +x at `speed` m/s, starting 2 m away: the crowd's readings. */
function shove(crowd: FakeCrowd, step: () => ReturnType<SimCore['step']>, shoved: number, shover: number, speed: number, at = OPEN): ReturnType<SimCore['step']> {
  crowd.place(shoved, at.x, at.z)
  let x = at.x - 2
  let s = step()
  for (let i = 0; i < 90; i++) {
    crowd.place(shover, x, at.z)
    x += speed * H
    s = step()
    if (x > at.x + 0.2) break
  }
  return s
}

test('the stream pins: RIG_SLOTS is the pool\'s capacity, every RIG_STATES code is a machine state, the page\'s shapes are the rig\'s own', () => {
  assert.equal(RIG_SLOTS, POOL_CAPACITY)
  assert.equal(COLLISION.ragdoll, true)
  const states = new Set(TRANSITIONS.flat())
  assert.deepEqual(new Set(RIG_STATES), states)
  assert.equal(RIG_POSE.stride, 2 + RIG_POSE.segmentCount * RIG_POSE.segmentStride)
  assert.equal(RIG_SEGMENTS.length, RIG_POSE.segmentCount)
  assert.equal(RIG_SEGMENTS.length, Object.keys(SEGMENTS).length + 2)
  RIG_SEGMENTS.forEach(([name, halfHeight, radius], j) => {
    const spec = shapeSpec(j)
    assert.equal(spec.foot, name === 'footL' || name === 'footR', name)
    assert.equal(spec.foot ? '' : spec.segment, spec.foot ? '' : name)
    assert.ok(Math.abs(spec.rigHalfHeight - halfHeight) < 1e-9 && Math.abs(spec.rigRadius - radius) < 1e-9, `${name}: drawn as [${halfHeight}, ${radius}], built as [${spec.rigHalfHeight}, ${spec.rigRadius}]`)
  })
  assert.ok(Math.abs(FOOT.half[2] - FOOT.half[0] - 0.07) < 1e-9, 'a foot is drawn as a capsule of its footprint')
  assert.throws(() => shapeSpec(13), RangeError)
})

test('a shove in the crowd near the operator promotes one person: the rig sits down and rises within the machine\'s timers, then the crowd has them again', async () => {
  const { sim, crowd, rigs, step } = await core()
  assert.equal(sim.meta.rigSlots, RIG_SLOTS)
  // Someone standing 3 m from the operator, walked into at 2.6 m/s (a run in the crowd; the machine's threshold is 0.5).
  let s = shove(crowd, step, 1, 2, 2.6, { x: OPEN.x + 3, z: OPEN.z })
  assert.ok(s.rigs instanceof Float32Array && s.rigs === rigs, 'the buffer handed in comes back filled')
  let live = slots(s.rigs!)
  assert.deepEqual(live.map((l) => l.agent), [1], 'the slower one is promoted, the one who walked into them is not')
  assert.ok(live[0].state === 'perturbed' || live[0].state === 'catchStep', live[0].state)
  assert.ok(s.physics.bodies >= 11 && s.physics.colliders >= 13)
  const bodies0 = s.physics.bodies
  plain(s)
  // The crowd keeps simulating the person meanwhile: their figure walks on at 1.4 m/s.
  const t0 = s.simTime
  const visited: string[] = []
  let px = OPEN.x + 3
  const timeIn = new Map<string, number>()
  for (let i = 0; i < 20 * 60 && slots(s.rigs!).length > 0; i++) {
    px += 1.4 * H
    crowd.place(1, px, OPEN.z)
    s = step()
    const now = slots(s.rigs!)
    if (now.length > 0) {
      const st = now[0].state
      if (visited.at(-1) !== st) visited.push(st)
      timeIn.set(st, (timeIn.get(st) ?? 0) + H)
    }
  }
  const episode = s.simTime - t0
  assert.ok(visited.includes('sittingDown') && visited.includes('seated'), visited.join(' → '))
  assert.deepEqual(visited.slice(visited.indexOf('sittingDown')), ['sittingDown', 'seated'], `the rig leaves on recovering: ${visited.join(' → ')}`)
  assert.equal(slots(s.rigs!).length, 0, 'the rig is gone once the person is recovering')
  // Within the machine's timers: at most PERTURBED_MAX + the catch steps + SIT_TIME_MAX + SEATED_TIME (+ a few ticks of hold).
  const bound = PERTURBED_MAX + MAX_CATCH_STEPS * STEP_TIME + SIT_TIME_MAX + SEATED_TIME + 0.2
  assert.ok(episode < bound, `rig held ${episode.toFixed(2)} s, bound ${bound.toFixed(2)} s`)
  assert.ok((timeIn.get('seated') ?? 0) >= SEATED_TIME - H, 'seated at least SEATED_TIME')
  assert.equal(s.physics.bodies, bodies0 - 11, 'the rig\'s eleven bodies are gone')
  assert.equal(sim.halted, false)
  // The blend back (recovering) ends with the slot free; the crowd was told to put the person where the rig stood.
  for (let i = 0; i < (RISE_TIME + SETTLE_BLEND) * 60 + 2; i++) s = step()
  assert.equal(s.kernel.audit.panic, null)
  // The crowd is told where to put them (the stand-in's figure, walked into the shover, may have shoved them in turn).
  assert.equal(crowd.handedBack.filter((h) => h.i === 1).length, 1, 'one handback of the person shoved')
  console.log(`[ragdollRealm] shove episode: promoted → handed back in ${episode.toFixed(2)} s (${visited.join(' → ')}); the crowd's figure had walked ${(1.4 * episode).toFixed(2)} m meanwhile and was put back where the rig stood`)
})

test('the handback jump and the cost: none, whether the crowd\'s figure stood still meanwhile or walked on', async () => {
  // The jump as the page sees it: the rig's pelvis in the last stream that carried it, against the crowd's figure in the
  // first stream without it. The stand-in crowd walks the person on as the GPU would, from wherever it was last put.
  const measure = async (walk: number): Promise<{ jump: number; seconds: number; msPerStep: number; stepsWithRig: number; heading: number; rigYaw: number }> => {
    const { crowd, step } = await core()
    let s = shove(crowd, step, 1, 2, 2.6, { x: OPEN.x + 3, z: OPEN.z })
    const t0 = s.simTime
    let px = OPEN.x + 3, pz = OPEN.z
    const last = { x: 0, z: 0, yaw: 0 }
    let ms = 0, n = 0
    while (slots(s.rigs!).length > 0 && n < 20 * 60) {
      const o = RIG_POSE.segments
      last.x = s.rigs![o]
      last.z = s.rigs![o + 2]
      const q = { x: s.rigs![o + 3], y: s.rigs![o + 4], z: s.rigs![o + 5], w: s.rigs![o + 6] }
      // The pelvis's forward (+z rotated by q), as the realm reads the facing it hands back.
      last.yaw = Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y))
      const put = crowd.handedBack.at(-1)
      if (put) { px = put.x; pz = put.z; crowd.handedBack.length = 0 }
      else { px += walk * H; crowd.place(1, px, pz) }
      const a = performance.now()
      s = step()
      ms += performance.now() - a
      n++
    }
    const figure = { x: crowd.readout!.xz[2], z: crowd.readout!.xz[3] }
    return { jump: Math.hypot(figure.x - last.x, figure.z - last.z), seconds: s.simTime - t0, msPerStep: ms / n, stepsWithRig: n, heading: 0, rigYaw: last.yaw }
  }
  const still = await measure(0)
  const walking = await measure(1.4)
  // The figure reappears where the rig's pelvis last stood, to the float (it is put there before the crowd moves it).
  assert.ok(still.jump < 1e-3, `standing still meanwhile, the figure reappears ${still.jump.toFixed(4)} m from the rig`)
  assert.ok(walking.jump < 1e-3, `walking on meanwhile, the figure reappears ${walking.jump.toFixed(4)} m from the rig after ${walking.seconds.toFixed(2)} s`)
  console.log(`[ragdollRealm] handback jump: ${still.jump.toFixed(2)} m with the figure standing still, ${walking.jump.toFixed(2)} m with it walking on at 1.4 m/s for ${walking.seconds.toFixed(2)} s; one rig costs ${still.msPerStep.toFixed(3)} ms per realm step over ${still.stepsWithRig} steps`)
})

test('promoted facing the way the crowd had them facing: someone standing still is not turned to face +z', async () => {
  const yawOf = (rigs: Float32Array): number => {
    const o = RIG_POSE.segments
    const q = { x: rigs[o + 3], y: rigs[o + 4], z: rigs[o + 5], w: rigs[o + 6] }
    return Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y))
  }
  for (const facing of [Math.PI / 2, -2.4]) {
    const { crowd, step } = await core()
    crowd.heading[1] = facing
    const s = shove(crowd, step, 1, 2, 2.6, { x: OPEN.x + 3, z: OPEN.z })
    assert.deepEqual(slots(s.rigs!).map((l) => l.agent), [1])
    const off = Math.abs(Math.atan2(Math.sin(yawOf(s.rigs!) - facing), Math.cos(yawOf(s.rigs!) - facing)))
    assert.ok(off < 0.25, `facing ${facing.toFixed(2)}: the rig faces ${yawOf(s.rigs!).toFixed(2)}`)
  }
})

test('eight rigs at once: the pool never exceeds RIG_SLOTS, never promotes the operator\'s own figure, and costs what it costs', async () => {
  const { sim, crowd, step } = await core()
  // Twelve people walked into near the operator, the operator's own figure (0) among them; a run at 2.6 m/s each.
  let s = step()
  for (let pair = 0; pair < 12; pair++) {
    const shoved = pair === 0 ? 0 : 2 * pair + 1, shover = 2 * pair + 2
    s = shove(crowd, step, shoved, shover, 2.6, { x: OPEN.x + 2 + pair * 1.5, z: OPEN.z })
    const live = slots(s.rigs!)
    assert.ok(live.length <= RIG_SLOTS, `${live.length} rigs`)
    assert.ok(!live.some((l) => l.agent === 0), 'the operator\'s figure is never promoted')
    assert.ok(new Set(live.map((l) => l.slot)).size === live.length)
  }
  const live = slots(s.rigs!)
  assert.ok(live.length >= 6, `${live.length} rigs after twelve shoves (some settled meanwhile)`)
  assert.equal(sim.halted, false)
  // The cost: realm steps with every slot busy against the same realm with none.
  let ms = 0, n = 0, maxRigs = 0
  for (let i = 0; i < 120; i++) {
    const a = performance.now()
    s = step()
    ms += performance.now() - a
    n++
    maxRigs = Math.max(maxRigs, slots(s.rigs!).length)
  }
  const withRigs = ms / n
  for (let i = 0; i < 30 * 60 && slots(s.rigs!).length > 0; i++) s = step()
  assert.equal(slots(s.rigs!).length, 0, 'everyone handed back')
  ms = 0; n = 0
  for (let i = 0; i < 120; i++) {
    const a = performance.now()
    s = step()
    ms += performance.now() - a
    n++
  }
  console.log(`[ragdollRealm] cost: ${withRigs.toFixed(3)} ms per realm step with up to ${maxRigs} rigs, ${(ms / n).toFixed(3)} ms with none (4 cars, 256 pedestrians, Node)`)
  assert.equal(sim.halted, false)
  plain(s)
})

/**
 * A seated rig on open ground: pedestrian 1 shoved at (x, z), 6 m east and 10 m north of the operator (inside the
 * promotion radius; a car driven north along x = at.x passes 6 m from the operator and touches nobody else), held until
 * the machine says seated.
 */
async function seated(o: { debug?: boolean } = {}) {
  const c = await core({ debug: o.debug ?? true })
  const at = { x: OPEN.x + 6, z: OPEN.z + 10 }
  let s = shove(c.crowd, c.step, 1, 2, 2.6, at)
  for (let i = 0; i < 10 * 60 && slots(s.rigs!)[0]?.state !== 'seated'; i++) s = c.step()
  assert.equal(slots(s.rigs!)[0]?.state, 'seated')
  // Where the rig actually sits (the shove carried it): the line a car is driven along.
  const at2 = { x: s.rigs![RIG_POSE.segments], z: s.rigs![RIG_POSE.segments + 2] }
  assert.ok(Math.hypot(at2.x - at.x, at2.z - at.z) < 4, `seated ${Math.hypot(at2.x - at.x, at2.z - at.z).toFixed(2)} m from the shove`)
  return { ...c, at: at2, state: s }
}

test('a car driven at a seated rig: the Sanctuary flips its shapes, no panic, the car\'s speed trace as over open road', async () => {
  // Sensing blind (a ?debug harness), so the Bouncer does not brake for the rig: the Sanctuary alone. The same car
  // on the same line over open road (no rig) gives the trace to compare against.
  const run = async (c: { sim: SimCore; step: (x?: Partial<StepInput>) => ReturnType<SimCore['step']>; at: { x: number; z: number } }) => {
    const { sim, step, at } = c
    step({ cmds: [{ c: 'blind', on: true, ttlMs: 15_000 }, { c: 'dbgMode', i: 2, mode: 'player' }, { c: 'recover', i: 2, x: at.x, z: at.z - 16, heading: 0 }] })
    for (let i = 0; i < 40; i++) step()
    const flips0 = step().kernel.sensorFlips
    step({ cmds: [{ c: 'dbgVelocity', i: 2, x: 0, y: 0, z: 12 }] })
    const trace: number[] = []
    let s = step()
    for (let i = 0; i < 150 && !sim.halted; i++) {
      s = step()
      trace.push(s.poses[2 * POSE.stride + POSE.speed])
    }
    assert.equal(sim.halted, false, sim.panic ?? '')
    // After the car has gone: how far the rig's pelvis slides on its own over the next second (a sidestep's velocity
    // left behind would carry it on).
    const pelvis = (): { x: number; z: number } => ({ x: s.rigs?.[RIG_POSE.segments] ?? NaN, z: s.rigs?.[RIG_POSE.segments + 2] ?? NaN })
    const after = pelvis()
    for (let i = 0; i < 60 && !sim.halted; i++) s = step()
    const slid = Math.hypot(pelvis().x - after.x, pelvis().z - after.z)
    return { at, trace, flips: s.kernel.sensorFlips - flips0, z: s.poses[2 * POSE.stride + POSE.z], panic: s.kernel.audit.panic, slid }
  }
  const rig = await run(await seated())
  const open = await run({ ...(await core({ debug: true })), at: rig.at })
  assert.ok(rig.flips > 0, 'the rig\'s shapes were flipped')
  assert.equal(open.flips, 0)
  assert.equal(rig.panic, null)
  assert.ok(rig.z > rig.at.z + 8, `the car passed through: z ${rig.z.toFixed(1)}`)
  let worst = 0
  for (let i = 0; i < open.trace.length; i++) worst = Math.max(worst, Math.abs(rig.trace[i] - open.trace[i]))
  assert.ok(worst < 0.05, `speed trace differs by ${worst.toFixed(3)} m/s from open road`)
  assert.ok(Math.abs(rig.z - open.z) < 0.05, `ends ${Math.abs(rig.z - open.z).toFixed(3)} m from the open-road run`)
  // The sidesteps leave nothing behind: once the car is gone the rig sits where it sat (measured: 6 mm).
  assert.ok(rig.slid < 0.05, `after the car the seated rig slid ${rig.slid.toFixed(3)} m in a second`)
  console.log(`[ragdollRealm] a car at 12 m/s through a seated rig: ${rig.flips} flips, speed within ${worst.toFixed(3)} m/s of open road, end within ${Math.abs(rig.z - open.z).toFixed(3)} m, no panic`)
})

test('blind, the Sanctuary off, a car driven at a seated rig: the Ring-0 audit halts the realm naming the rig\'s person', async () => {
  const { sim, step, at } = await seated()
  step({ cmds: [{ c: 'dbgSanctuary', on: false }, { c: 'blind', on: true, ttlMs: 15_000 }, { c: 'dbgMode', i: 2, mode: 'player' }, { c: 'recover', i: 2, x: at.x, z: at.z - 16, heading: 0 }] })
  for (let i = 0; i < 40; i++) step()
  step({ cmds: [{ c: 'dbgVelocity', i: 2, x: 0, y: 0, z: 12 }] })
  let s = step()
  for (let i = 0; i < 240 && !sim.halted; i++) s = step()
  assert.equal(sim.halted, true)
  assert.match(sim.panic ?? '', /First-Law Violation/)
  assert.match(sim.panic ?? '', new RegExp(`person (${PERSON_ID_BASE}|${PERSON_ID_BASE + 1}|${PERSON_ID_BASE + 2}|${PERSON_ID_BASE + 3}|${PERSON_ID_BASE + 4}|${PERSON_ID_BASE + 5}|${PERSON_ID_BASE + 6}|${PERSON_ID_BASE + 7}|${PERSON_ID_BASE + 8}|${PERSON_ID_BASE + 9}|${PERSON_ID_BASE + 10}|${PERSON_ID_BASE + 11}|${PERSON_ID_BASE + 12})\\b`))
  assert.equal(s.rigs, null, 'a halted realm ships no rigs')
  assert.equal(s.kernel.audit.panic, sim.panic)
  // And a halted realm changes nothing.
  const t = s.simTime
  s = step({ dt: 0.05 })
  assert.equal(s.simTime, t)
  assert.equal(s.rigs, null)
  console.log(`[ragdollRealm] panic: ${sim.panic}`)
})

test('a vehicle is never a cause: a person standing beside a moving car is not promoted, and the pool refuses the word', async () => {
  const { sim, crowd, step } = await core({ debug: true })
  const at = { x: OPEN.x + 6, z: OPEN.z + 10 }
  step({ cmds: [{ c: 'dbgMode', i: 2, mode: 'player' }, { c: 'recover', i: 2, x: at.x + 1.5, z: at.z - 3, heading: 0 }] })
  for (let i = 0; i < 40; i++) step()
  step({ cmds: [{ c: 'dbgVelocity', i: 2, x: 0, y: 0, z: 2 }] })
  // A shove right beside the moving car (within VEHICLE_CLEARANCE of its centre): refused, nobody promoted.
  const s = shove(crowd, step, 1, 3, 2.6, at)
  assert.equal(slots(s.rigs!).length, 0, 'nobody is promoted beside a moving car')
  assert.equal(sim.halted, false)
  assert.ok(SHOVE_CLOSING > 0.49 && SHOVE_CLOSING < 0.51)
})

test('a region, the ragdoll off, and a flag that is not exactly true give no rig stream; the door sanitises the flag', async () => {
  const off = await core({ ragdoll: false })
  assert.equal(off.sim.meta.rigSlots, 0)
  const s = off.sim.step({ dt: H, foot: { x: 0, z: 0, heading: 0 }, drive: IDLE, cmds: [] }, off.poses, null, new Float32Array(RIG_SLOTS * RIG_POSE.stride))
  assert.equal(s.rigs, null)
  assert.equal(shove(off.crowd, off.step, 1, 2, 2.6, { x: OPEN.x + 3, z: OPEN.z }).rigs, null)
  // Without a crowd there is nothing to promote either.
  const alone = await core({ crowd: null })
  assert.equal(alone.sim.meta.rigSlots, 0)
  // A region never has one.
  const region = await SimCore.create({
    seed: 1, cars: 0, agents: AGENTS, boxes: [], furniture: NO_FURNITURE, spawn: { x: 100, z: 100 }, debug: false, ragdoll: true,
    region: { bounds: { x0: 0, z0: 0, x1: 200, z1: 200 }, walls: new Float32Array(0) },
  }, async () => new FakeCrowd())
  assert.equal(region.meta.rigSlots, 0)
  assert.equal(region.step({ dt: H, foot: { x: 0, z: 0, heading: 0 }, drive: IDLE, cmds: [] }, new Float32Array(0), null, new Float32Array(RIG_SLOTS * RIG_POSE.stride)).rigs, null)

  // The door: only `true` turns it on; the stream is transferred after the poses and the crowd frame, and taken back.
  const out: { msg: FromWorker; transfer?: Transferable[] }[] = []
  const crowd = new FakeCrowd()
  const handle = createSimHost((msg, transfer) => out.push({ msg, transfer }), (o) => SimCore.create(o, async () => crowd))
  const init = { t: 'init', seed: 11, cars: 2, agents: AGENTS, boxes: [], furniture: NO_FURNITURE, spawn: OPEN, debug: false } satisfies SimInit
  await handle({ ...init, ragdoll: 'yes' })
  let ready = out[0].msg
  assert.ok(ready.t === 'ready' && ready.meta.rigSlots === 0, 'a string is not true')
  const out2: { msg: FromWorker; transfer?: Transferable[] }[] = []
  const crowd2 = new FakeCrowd()
  const handle2 = createSimHost((msg, transfer) => out2.push({ msg, transfer }), (o) => SimCore.create(o, async () => crowd2))
  await handle2({ ...init, ragdoll: true })
  ready = out2[0].msg
  assert.ok(ready.t === 'ready' && ready.meta.rigSlots === RIG_SLOTS)
  const hostStep = (id: number, extra: Record<string, unknown> = {}) => ({ t: 'step', id, dt: H, foot: {}, drive: {}, cmds: [], ...extra })
  await handle2(hostStep(1))
  const st = out2[1].msg
  assert.ok(st.t === 'state')
  if (st.t !== 'state') return
  assert.ok(st.rigs instanceof Float32Array && st.rigs.length === RIG_SLOTS * RIG_POSE.stride)
  assert.equal(slots(st.rigs).length, 0)
  for (let s = 0; s < RIG_SLOTS; s++) assert.equal(st.rigs[s * RIG_POSE.stride + RIG_POSE.agent], -1)
  assert.deepEqual(out2[1].transfer, [st.poses.buffer, st.crowdFrame!.buffer, st.rigs.buffer], 'poses, crowd frame, rigs: all transferred')
  plain(st)
  const back = st.rigs.buffer
  await handle2(hostStep(2, { rigBuffer: back }))
  const st2 = out2[2].msg
  assert.ok(st2.t === 'state' && st2.rigs?.buffer === back, 'a rig buffer handed back is the next one filled')
  await handle2(hostStep(3, { rigBuffer: new ArrayBuffer(8) }))
  const st3 = out2[3].msg
  assert.ok(st3.t === 'state' && st3.rigs instanceof Float32Array && st3.rigs.length === RIG_SLOTS * RIG_POSE.stride)
  // After a panic the door is shut; the state that carried it has no rigs.
  crowd2.flags = 1
  await handle2(hostStep(4))
  const st4 = out2[4].msg
  assert.ok(st4.t === 'state' && st4.rigs === null, 'a halted realm ships no rigs')
  assert.equal(out2[5].msg.t, 'panic')
})

test('the step order holds: the stream is written after the audit, so a step the audit halts ships none, and nothing moves after', async () => {
  const { sim, crowd, poses, step } = await core()
  let s = shove(crowd, step, 1, 2, 2.6, { x: OPEN.x + 3, z: OPEN.z })
  assert.equal(slots(s.rigs!).length, 1)
  const before = Float32Array.from(s.rigs!)
  crowd.flags = 1
  s = step()
  assert.equal(sim.halted, true)
  assert.match(sim.panic ?? '', /IEEE 754 Exploit/)
  assert.equal(s.rigs, null)
  assert.equal(s.crowdFrame, null)
  const frozen = Float32Array.from(poses), t = s.simTime
  s = step({ dt: 0.05 })
  assert.equal(s.simTime, t, 'the clock stopped')
  assert.deepEqual(Array.from(poses), Array.from(frozen), 'nothing moved')
  assert.equal(s.rigs, null)
  assert.ok(before[RIG_POSE.agent] === 1)
})

test('wording: no word of harm in the realm module, and the sources that may name the ragdoll are the listed ones', () => {
  const words = /\b(attack|damage|weapon|kill|combat|target|shoot|gun|injur\w*|violen\w*|hit|crash\w*|collid\w*|collision|dead|death|die|blood|maim|wound|smash)\b/i
  // Rapier's own names for a body's shape (and the Sanctuary's PersonBody field of that name) are the only exception.
  const src = readFileSync(new URL('./ragdollRealm.ts', import.meta.url), 'utf8').replace(/\b(ColliderDesc|createCollider|collider)\b/g, '')
  assert.doesNotMatch(src, words)
})
