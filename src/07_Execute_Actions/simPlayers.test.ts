/**
 * Why does this file exist? It proves the realm holding up to MAX_PLAYERS avatars (local split-screen players), in real
 * Rapier run in Node with no Worker and no GPU: four avatars stand where they were spawned and each player's own
 * controls move only their avatar, no faster than a run; the Sanctuary shields whichever avatar a car is about to
 * reach, without touching the car; the Ring-0 audit names the person a car runs into when the Sanctuary is off and
 * sensing is blinded; each player drives their own car, a car another player drives is refused with an event, and
 * the audit exempts only the driver; the Bouncer sees the nearest of several people and the single-avatar call still
 * works; and the message door refuses or clamps malformed players entries and spawns while every state stays plain.
 * What breaks if it is removed? A second player could be a person the kernel does not protect, or could take the
 * wheel of a car someone else is driving, and nothing would say so before a browser session did.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CAR } from './car.ts'
import { Physics } from './physics.ts'
import { Fleet, type Vehicle } from './vehicles.ts'
import { SimCore, type StepInput } from './simCore.ts'
import { createSimHost } from './simHost.ts'
import { MAX_PLAYERS, POSE, RUN, type FromWorker, type SimInit } from './simProtocol.ts'
import { inLot } from '../01_Initialize_World/city.ts'

const H = 1 / 60
const NO_FURNITURE = { lamps: [], trees: [], signals: [] }
/** Open ground well away from the street grid (the ground spans ±1600 m around the centre). */
const OPEN = { x: -600, z: 0 }
/** Players 1..3 on the same open street, 3 m apart along it (none inside a building lot). */
const SPAWNS = [{ x: OPEN.x - 3, z: OPEN.z }, { x: OPEN.x + 3, z: OPEN.z }, { x: OPEN.x + 6, z: OPEN.z }]
const ALL = [OPEN, ...SPAWNS]
const AGENTS = 256
const IDLE = { steer: 0, fwd: 0, back: 0, handbrake: false }
const STILL = { x: 0, z: 0, heading: 0 }
const IDLE_PLAYER = { foot: STILL, drive: IDLE }

async function core(debug = false, cars = 4) {
  const sim = await SimCore.create({ seed: 11, cars, agents: AGENTS, boxes: [], furniture: NO_FURNITURE, spawn: OPEN, spawns: SPAWNS, debug }, null)
  const poses = new Float32Array(sim.meta.count * POSE.stride)
  const step = (o: Partial<StepInput> = {}) => sim.step({ dt: H, foot: STILL, drive: IDLE, cmds: [], ...o }, poses)
  return { sim, poses, step }
}

type Step = (o?: Partial<StepInput>) => ReturnType<SimCore['step']>

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

/** Car `i` on open ground 16 m short of (x, z), heading +z, coasting (a player-mode car without drive()) at `speed` m/s. */
function rolledAt(step: Step, i: number, x: number, z: number, speed: number): void {
  step({ cmds: [{ c: 'dbgMode', i, mode: 'player' }, { c: 'recover', i, x, z: z - 16, heading: 0 }] })
  for (let k = 0; k < 60; k++) step()
  step({ cmds: [{ c: 'dbgVelocity', i, x: 0, y: 0, z: speed }] })
}

/** Players 1..3 idle except player k, whose foot asks for `foot`. */
function only(k: number, foot: { x: number; z: number; heading: number }) {
  const players = [IDLE_PLAYER, IDLE_PLAYER, IDLE_PLAYER]
  players[k - 1] = { foot, drive: IDLE }
  return players
}

test('four avatars stand where spawned, as plain data beside player 0, and each player\'s foot moves only their avatar, a run at most', async () => {
  const { sim, step } = await core()
  assert.equal(sim.meta.players, 4)
  for (let i = 0; i < 20; i++) step()
  let s = step()
  plain(s)
  assert.deepEqual(structuredClone(s).avatars, s.avatars)
  assert.equal(s.avatars.length, 4)
  assert.deepEqual(s.avatars[0], s.avatar)
  assert.deepEqual(s.drivings, [-1, -1, -1, -1])
  assert.equal(s.driving, -1)
  for (let k = 0; k < 4; k++) {
    const a = s.avatars[k]
    assert.ok(Math.abs(a.x - ALL[k].x) < 0.01 && Math.abs(a.z - ALL[k].z) < 0.01, `avatar ${k} at ${a.x.toFixed(2)}, ${a.z.toFixed(2)}`)
    assert.equal(a.enabled, true)
    assert.equal(a.sensor, false)
    assert.ok(a.feetY > -0.05 && a.feetY < 0.1, `avatar ${k} feet at ${a.feetY.toFixed(3)} m`)
  }
  // players[k − 1].foot moves avatar k only, capped at a run (1e6 asked).
  for (let k = 1; k < 4; k++) {
    const before = step().avatars
    for (let i = 0; i < 30; i++) s = step({ players: only(k, { x: 0, z: 1e6, heading: 0 }) })
    for (let j = 0; j < 4; j++) {
      const moved = s.avatars[j].z - before[j].z
      if (j === k) assert.ok(moved > 0.5 && moved <= RUN * 30 * H + 0.05, `avatar ${k} moved ${moved.toFixed(2)} m in 0.5 s`)
      else assert.ok(Math.abs(moved) < 0.01 && Math.abs(s.avatars[j].x - before[j].x) < 0.01, `avatar ${j} moved for player ${k}`)
    }
  }
  // Player 0's foot moves avatar 0 only, as before.
  const before = step().avatars
  for (let i = 0; i < 30; i++) s = step({ foot: { x: 0, z: 1e6, heading: 0 } })
  assert.ok(s.avatars[0].z - before[0].z > 0.5)
  for (let j = 1; j < 4; j++) assert.ok(Math.abs(s.avatars[j].z - before[j].z) < 0.01, `avatar ${j} moved for player 0`)
  // A missing, short or malformed players entry is an idle player, never a throw; non-finite controls are no control.
  const rest = step().avatars
  const bad = [undefined, null, 5, 'walk', { foot: 7, drive: null }, { foot: { x: NaN, z: Infinity, heading: NaN } }] as unknown as StepInput['players']
  for (let i = 0; i < 10; i++) s = step({ players: bad })
  for (let i = 0; i < 10; i++) s = step({ players: [] })
  for (let i = 0; i < 10; i++) s = step({ players: undefined })
  for (let j = 0; j < 4; j++) assert.ok(Math.abs(s.avatars[j].z - rest[j].z) < 0.01 && Math.abs(s.avatars[j].x - rest[j].x) < 0.01, `avatar ${j} moved on malformed input`)
  plain(s)
  // A teleport names its player; a player outside the realm is a refused command.
  s = step({ cmds: [{ c: 'teleport', x: OPEN.x, z: OPEN.z + 40, player: 2 }] })
  assert.ok(Math.abs(s.avatars[2].z - (OPEN.z + 40)) < 0.2, 'avatar 2 teleported')
  assert.ok(Math.abs(s.avatars[0].z - rest[0].z) < 0.6 && Math.abs(s.avatars[1].z - rest[1].z) < 0.6 && Math.abs(s.avatars[3].z - rest[3].z) < 0.6)
  const rejected = s.rejected
  s = step({ cmds: [{ c: 'interact', player: 9 }, { c: 'teleport', x: 0, z: 0, player: -1 }, { c: 'teleport', x: 0, z: 0, player: 1.5 }] })
  assert.equal(s.rejected, rejected + 3)
  assert.equal(s.events.filter((e) => e.e === 'rejected').length, 3)
  assert.equal(sim.halted, false)
})

test('the Sanctuary shields the avatar a car is about to reach, and no other, without touching the car', async () => {
  // Blind sensing, so the Bouncer does not stop the car first (the Sanctuary alone, as the harness proves it).
  const run = async (lane: number) => {
    const { sim, poses, step } = await core(true)
    step({ cmds: [{ c: 'blind', on: true, ttlMs: 15_000 }] })
    rolledAt(step, 2, lane, OPEN.z, 12)
    const speeds: number[] = []
    const shielded = [false, false, false, false]
    let s = step()
    for (let i = 0; i < 180; i++) {
      s = step()
      speeds.push(poses[2 * POSE.stride + POSE.speed])
      for (let k = 0; k < 4; k++) shielded[k] ||= s.avatars[k].sensor
    }
    return { sim, s, speeds, shielded }
  }
  const at2 = await run(SPAWNS[1].x)
  const nobody = await run(OPEN.x - 20)
  assert.equal(at2.sim.halted, false, at2.sim.panic ?? '')
  assert.deepEqual(at2.shielded, [false, false, true, false], 'only avatar 2 was shielded')
  assert.deepEqual(nobody.shielded, [false, false, false, false])
  assert.equal(at2.s.kernel.audit.panic, null)
  assert.ok(at2.s.kernel.sensorFlips >= 1)
  let worst = 0
  for (let i = 0; i < at2.speeds.length; i++) worst = Math.max(worst, Math.abs(at2.speeds[i] - nobody.speeds[i]))
  assert.ok(worst < 0.05, `the person changed the car's speed by ${worst.toFixed(4)} m/s`)
  assert.ok(at2.s.poses[2 * POSE.stride + POSE.z] > OPEN.z + 10, 'the car passed')
  // Avatar 2 stepped clear of the car's line; the others stand where they were.
  assert.ok(Math.abs(at2.s.avatars[2].x - SPAWNS[1].x) > CAR.halfWidth, `avatar 2 ended ${(at2.s.avatars[2].x - SPAWNS[1].x).toFixed(2)} m off the line`)
  for (const k of [0, 1, 3]) assert.ok(Math.abs(at2.s.avatars[k].x - ALL[k].x) < 0.05 && Math.abs(at2.s.avatars[k].z - ALL[k].z) < 0.05, `avatar ${k} moved`)
})

test('the Ring-0 audit names the person a car runs into: the Sanctuary off, sensing blinded, a car rolled at avatar 3', async () => {
  const { sim, poses, step } = await core(true)
  step({ cmds: [{ c: 'dbgSanctuary', on: false }, { c: 'blind', on: true, ttlMs: 15_000 }] })
  rolledAt(step, 2, SPAWNS[2].x, OPEN.z, 12)
  let s = step()
  for (let i = 0; i < 240 && !sim.halted; i++) s = step()
  assert.equal(sim.halted, true)
  assert.match(sim.panic ?? '', /First-Law Violation/)
  assert.match(sim.panic ?? '', /person 3/)
  assert.equal(s.kernel.audit.panic, sim.panic)
  // A halted realm changes nothing, for any player.
  const frozen = Float32Array.from(poses), t = s.simTime, were = s.avatars
  s = step({ cmds: [{ c: 'dbgSanctuary', on: true }, { c: 'interact', player: 1 }], players: only(1, { x: 5, z: 0, heading: 0 }), dt: 0.05 })
  assert.equal(s.simTime, t, 'the clock stopped')
  assert.deepEqual(Array.from(poses), Array.from(frozen), 'nothing moved')
  assert.deepEqual(s.avatars, were)
  assert.deepEqual(s.drivings, [-1, -1, -1, -1])
})

test('one driver per car: player 1 takes a parked car, player 0 is refused it, and driving past a bystander is no breach', async () => {
  const { sim, poses, step } = await core(true)
  // Player 1 stands on a clear stretch of the street; car 0 is parked beside them, facing −z.
  const lane = OPEN.x + 3.5, z = OPEN.z + 40
  step({ cmds: [{ c: 'teleport', x: OPEN.x, z, player: 1 }, { c: 'dbgMode', i: 0, mode: 'parked' }, { c: 'recover', i: 0, x: lane, z, heading: Math.PI }] })
  for (let i = 0; i < 60; i++) step()
  let s = step({ cmds: [{ c: 'interact', player: 1 }] })
  assert.deepEqual(s.drivings, [-1, 0, -1, -1])
  assert.equal(s.driving, -1, 'player 0 is still on foot')
  assert.equal(s.avatars[1].enabled, false)
  assert.equal(s.avatar.enabled, true)
  const entered = s.events.find((e) => e.e === 'entered')
  assert.ok(entered && entered.e === 'entered')
  assert.equal(entered.player, 1)
  assert.equal(entered.index, 0)
  assert.equal(poses[POSE.mode], 1, 'player mode')
  // Player 0 steps up to the same car: refused, with an event, and still on foot.
  s = step({ cmds: [{ c: 'teleport', x: OPEN.x, z: z + 1 }] })
  const rejected = s.rejected
  s = step({ cmds: [{ c: 'interact' }] })
  assert.deepEqual(s.drivings, [-1, 0, -1, -1])
  assert.equal(s.rejected, rejected + 1)
  const refusal = s.events.find((e) => e.e === 'rejected')
  assert.ok(refusal && refusal.e === 'rejected' && /being driven/.test(refusal.reason), JSON.stringify(s.events))
  // setMode and intent on that car are refused the same way.
  s = step({ cmds: [{ c: 'setMode', i: 0, mode: 'ai' }, { c: 'intent', i: 0, throttle: 1, brake: 0, steer: 0 }] })
  assert.equal(s.rejected, rejected + 3)
  assert.equal(s.drivings[1], 0)
  // Player 0 stands 5 m off the lane; player 1 drives past at 15 m/s: the bystander is outside the corridor, the
  // driver is the car's occupant, nobody is run into.
  step({ cmds: [{ c: 'teleport', x: lane - 5, z: OPEN.z + 20 }] })
  step({ cmds: [{ c: 'dbgVelocity', i: 0, x: 0, y: 0, z: -15 }] })
  const drive = [{ foot: STILL, drive: { steer: 0, fwd: 1, back: 0, handbrake: false } }, IDLE_PLAYER, IDLE_PLAYER]
  let top = 0
  for (let i = 0; i < 180; i++) {
    s = step({ players: drive })
    top = Math.max(top, Math.abs(poses[POSE.speed]))
  }
  assert.equal(sim.halted, false, sim.panic ?? '')
  assert.ok(top > 12, `top speed ${top.toFixed(1)} m/s`)
  assert.ok(poses[POSE.z] < OPEN.z + 10, `the car passed (z=${poses[POSE.z].toFixed(1)})`)
  assert.deepEqual(s.drivings, [-1, 0, -1, -1])
  assert.equal(s.avatars[1].enabled, false)
  assert.equal(s.avatars[1].speed, 0)
  assert.ok(Math.abs(s.avatar.x - (lane - 5)) < 0.05, 'the bystander was not moved')
  // Player 1 leaves: the car is parked, avatar 1 is back in the world beside it, and the event names them.
  for (let i = 0; i < 600 && Math.abs(poses[POSE.speed]) > 0.1; i++) s = step({ players: [{ foot: STILL, drive: { steer: 0, fwd: 0, back: 1, handbrake: false } }] })
  s = step({ cmds: [{ c: 'interact', player: 1 }] })
  assert.deepEqual(s.drivings, [-1, -1, -1, -1])
  const exited = s.events.find((e) => e.e === 'exited')
  assert.ok(exited && exited.e === 'exited' && exited.player === 1)
  assert.equal(s.avatars[1].enabled, true)
  assert.equal(poses[POSE.mode], 2, 'parked')
  assert.ok(Math.hypot(s.avatars[1].x - poses[POSE.x], s.avatars[1].z - poses[POSE.z]) < 3, 'beside the car')
  // Now player 0 may take it.
  step({ cmds: [{ c: 'teleport', x: poses[POSE.x] + 2.5, z: poses[POSE.z] }] })
  s = step({ cmds: [{ c: 'interact' }] })
  assert.deepEqual(s.drivings, [0, -1, -1, -1])
  assert.equal(s.driving, 0)
})

test('the Bouncer sees the nearest of several people, and the single-avatar call still works', async () => {
  const physics = await Physics.create([], NO_FURNITURE)
  const fleet = new Fleet(physics, 8, 11, { exposeRig: true })
  const step = (frames = 1) => { for (let k = 0; k < frames; k++) physics.step(H, (h) => fleet.updateControllers(h)) }
  const v: Vehicle = fleet.vehicles[0]
  v.mode = 'player'
  fleet.recover(v, OPEN.x, 0, Math.PI / 2)
  step(60)
  const t = fleet.position(v)
  const ahead = (d: number, present = true) => ({ x: t.x + CAR.halfLength + d, z: t.z, present })
  assert.equal(fleet.personAhead(v), Infinity)
  fleet.setPeople([{ x: 0, z: 0, present: false }, { x: 0, z: 0, present: false }, { x: 0, z: 0, present: false }, ahead(4)])
  assert.ok(Math.abs(fleet.personAhead(v) - 4) < 0.05, 'avatar 3 alone, 4 m ahead')
  assert.equal(fleet.personBehind(v), Infinity)
  fleet.setPeople([ahead(10), ahead(4), ahead(7)])
  assert.ok(Math.abs(fleet.personAhead(v) - 4) < 0.05, 'the nearest of three wins')
  fleet.setPeople([ahead(10), ahead(2, false), ahead(7)])
  assert.ok(Math.abs(fleet.personAhead(v) - 7) < 0.05, 'a person inside a car is not on the road')
  fleet.setPeople([{ x: t.x - CAR.halfLength - 3, z: t.z, present: true }, ahead(9)])
  assert.ok(Math.abs(fleet.personBehind(v) - 3) < 0.05 && Math.abs(fleet.personAhead(v) - 9) < 0.05)
  fleet.setPeople([])
  assert.equal(fleet.personAhead(v), Infinity)
  // The GPU reading and the people: the nearer wins.
  const gpu = new Float32Array(fleet.vehicles.length).fill(Infinity)
  gpu[v.index] = 5
  fleet.setPersonHazards(gpu, gpu)
  fleet.setPeople([ahead(8), ahead(6)])
  assert.equal(fleet.personAhead(v), 5)
  fleet.setPeople([ahead(8), ahead(3)])
  assert.ok(Math.abs(fleet.personAhead(v) - 3) < 0.05)
  fleet.setPersonHazards([], [])
  // setAvatar is one person: it replaces the list.
  fleet.setAvatar(t.x + CAR.halfLength + 10, t.z, true)
  assert.ok(Math.abs(fleet.personAhead(v) - 10) < 0.05)
  fleet.setAvatar(t.x + CAR.halfLength + 10, t.z, false)
  assert.equal(fleet.personAhead(v), Infinity)
  // Nothing the caller keeps reaches the Fleet, and the list is not visible on it.
  const mine = [ahead(4)]
  fleet.setPeople(mine)
  mine[0].x = t.x + CAR.halfLength + 20
  assert.ok(Math.abs(fleet.personAhead(v) - 4) < 0.05, 'copied, not referenced')
  assert.deepEqual(Object.keys(fleet).sort(), ['bouncer', 'paint', 'vehicles'])
})

const hostStep = (id: number, extra: Record<string, unknown> = {}) => ({ t: 'step', id, dt: H, foot: {}, drive: {}, cmds: [], ...extra })

test('the message door: spawns checked at init, players refused or clamped, the state still plain', async () => {
  const out: FromWorker[] = []
  const handle = createSimHost((msg) => out.push(msg))
  const init = { t: 'init', seed: 11, cars: 1, agents: AGENTS, boxes: [], furniture: NO_FURNITURE, spawn: OPEN, debug: false } satisfies SimInit
  // Malformed spawns are refused like a malformed region.
  for (const spawns of [[{ x: NaN, z: 0 }], [{ x: 0 }], [{ x: 0, z: Infinity }], 'x', [{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }], [null]]) {
    const errs: FromWorker[] = []
    await createSimHost((msg) => errs.push(msg))({ ...init, spawns })
    assert.equal(errs[0]?.t, 'error', JSON.stringify(spawns))
    assert.match(errs[0]?.t === 'error' ? errs[0].message : '', /spawns/)
  }
  await handle({ ...init, spawns: SPAWNS })
  const ready = out[0]
  assert.ok(ready.t === 'ready' && ready.meta.players === MAX_PLAYERS)
  const last = () => { const m = out.at(-1)!; assert.equal(m.t, 'state'); return m.t === 'state' ? m : null! }
  await handle(hostStep(1))
  let s = last()
  plain(s)
  assert.equal(s.avatars.length, 4)
  assert.deepEqual(s.drivings, [-1, -1, -1, -1])
  // `players` that is not a list: refused, counted, and every player idle.
  const rejected = s.rejected
  await handle(hostStep(2, { players: 'everyone' }))
  s = last()
  assert.equal(s.rejected, rejected + 1)
  assert.ok(s.events.some((e) => e.e === 'rejected' && /players/.test(e.reason)))
  plain(s)
  // Entries with NaN, huge numbers, non-records or more than MAX_PLAYERS − 1 of them: clamped, never a throw.
  const z0 = s.avatars[1].z, t0 = s.simTime
  const wild = [{ foot: { x: NaN, z: 1e9, heading: 1e39 }, drive: { steer: 1e9, fwd: -1, back: NaN, handbrake: 'yes' } }, 5, null, {}, { foot: 'run' }, [], 'x']
  for (let i = 0; i < 10; i++) await handle(hostStep(3 + i, { players: wild }))
  s = last()
  plain(s)
  assert.deepEqual(structuredClone(s).avatars, s.avatars)
  const moved = s.avatars[1].z - z0
  assert.ok(moved > 0 && moved <= RUN * (s.simTime - t0) + 0.05, `avatar 1 moved ${moved.toFixed(3)} m in ${(s.simTime - t0).toFixed(3)} s`)
  for (const k of [0, 2, 3]) assert.ok(Math.abs(s.avatars[k].z - ALL[k].z) < 0.01, `avatar ${k} moved`)
  assert.equal(s.rejected, rejected + 1, 'malformed entries are idle players, not refusals')
  assert.ok(s.avatars.every((a) => Number.isFinite(a.x) && Number.isFinite(a.z) && Number.isFinite(a.y)))
  // No spawns at all is one player, as before.
  const one: FromWorker[] = []
  await createSimHost((msg) => one.push(msg))(init)
  assert.ok(one[0]?.t === 'ready' && one[0].meta.players === 1)
})

test('a spawn inside a building lot starts on the sidewalk beside it', async () => {
  const sim = await SimCore.create({ seed: 11, cars: 1, agents: AGENTS, boxes: [], furniture: NO_FURNITURE, spawn: OPEN, spawns: [{ x: 20, z: 20 }, { x: 31, z: 25 }], debug: false }, null)
  const poses = new Float32Array(sim.meta.count * POSE.stride)
  const s = sim.step({ dt: H, foot: STILL, drive: IDLE, cmds: [] }, poses)
  assert.equal(s.avatars.length, 3)
  for (const k of [1, 2]) assert.equal(inLot(s.avatars[k].x, s.avatars[k].z, 0.4), false, `avatar ${k} at ${s.avatars[k].x}, ${s.avatars[k].z}`)
  assert.ok(Math.hypot(s.avatars[1].x - 20, s.avatars[1].z - 20) < 20, 'moved to the nearest sidewalk, not across the city')
  assert.ok(Math.abs(s.avatars[2].x - (20 + 13 + 0.4 + 1)) < 1e-3 && Math.abs(s.avatars[2].z - 25) < 1e-3, 'pushed along the axis it was nearest the edge on')
})

test('adversarial: player 2 drives at player 0 standing in the lane and the Bouncer holds; one car cannot be taken by two players in a step; a reset is refused beside a player on foot; infinite controls are no control', async () => {
  const { sim, poses, step } = await core(true)
  const lane = OPEN.x, carZ = OPEN.z - 30
  // Players 1 and 3 well away; car 0 parked in the lane facing +z; player 2 beside it, at the wheel; player 0 35 m ahead in the lane.
  step({ cmds: [
    { c: 'teleport', x: OPEN.x + 40, z: OPEN.z - 200, player: 1 }, { c: 'teleport', x: OPEN.x + 40, z: OPEN.z - 220, player: 3 },
    { c: 'setMode', i: 0, mode: 'parked' }, { c: 'recover', i: 0, x: lane, z: carZ, heading: 0 },
    { c: 'teleport', x: lane - 2.5, z: carZ, player: 2 }, { c: 'teleport', x: lane, z: OPEN.z + 5 },
  ] })
  for (let i = 0; i < 60; i++) step()
  let s = step({ cmds: [{ c: 'interact', player: 2 }] })
  assert.deepEqual(s.drivings, [-1, -1, 0, -1])
  assert.equal(s.driving, -1)
  const standing = { x: s.avatar.x, z: s.avatar.z }
  const drive = [IDLE_PLAYER, { foot: STILL, drive: { steer: 0, fwd: 1, back: 0, handbrake: false } }, IDLE_PLAYER]
  let top = 0
  for (let i = 0; i < 600; i++) {
    s = step({ players: drive })
    top = Math.max(top, poses[POSE.speed])
    assert.equal(sim.halted, false, sim.panic ?? '')
  }
  assert.ok(top > 3, `the car drove (top ${top.toFixed(1)} m/s)`)
  assert.ok(poses[POSE.z] > carZ + 10, `the car moved up the lane (z=${poses[POSE.z].toFixed(1)})`)
  const gap = s.avatar.z - (poses[POSE.z] + CAR.halfLength)
  assert.ok(gap > 1.0, `held short of player 0: ${gap.toFixed(2)} m between the bumper and them`)
  assert.ok(Math.abs(poses[POSE.speed]) < 0.2, `holding (${poses[POSE.speed].toFixed(2)} m/s)`)
  assert.ok(Math.abs(s.avatar.x - standing.x) < 0.05 && Math.abs(s.avatar.z - standing.z) < 0.05, 'player 0 was not moved')
  assert.equal(s.avatar.enabled, true)
  assert.equal(s.kernel.audit.panic, null)
  assert.deepEqual(s.avatars[0], s.avatar)
  assert.equal(s.drivings[0], s.driving)
  assert.deepEqual(s.drivings, [-1, -1, 0, -1])
  // Two players at one parked car in the same step: the first takes it, the second is refused with an event.
  const carB = { x: OPEN.x + 60, z: OPEN.z }
  step({ cmds: [
    { c: 'setMode', i: 1, mode: 'parked' }, { c: 'recover', i: 1, x: carB.x, z: carB.z, heading: 0 },
    { c: 'teleport', x: carB.x - 2.5, z: carB.z, player: 1 }, { c: 'teleport', x: carB.x + 2.5, z: carB.z, player: 3 },
  ] })
  for (let i = 0; i < 60; i++) step({ players: drive })
  let rejected = step({ players: drive }).rejected
  s = step({ players: drive, cmds: [{ c: 'interact', player: 3 }, { c: 'interact', player: 1 }] })
  assert.deepEqual(s.drivings, [-1, -1, 0, 1])
  assert.equal(s.rejected, rejected + 1)
  assert.deepEqual(s.events.filter((e) => e.e === 'entered').map((e) => (e.e === 'entered' ? [e.player, e.index] : null)), [[3, 1]])
  assert.ok(s.events.some((e) => e.e === 'rejected' && /being driven/.test(e.reason)), JSON.stringify(s.events))
  assert.equal(s.avatars[1].enabled, true)
  assert.equal(s.avatars[3].enabled, false)
  // Player 2 steps out (parked, 2.1 m to the car's left); player 0 takes the car from the right. A reset (righting
  // player 0's car where it stands) is refused while player 2 stands beside it, and goes through once they are clear.
  s = step({ cmds: [{ c: 'interact', player: 2 }] })
  assert.deepEqual(s.drivings, [-1, -1, -1, 1])
  const cx = poses[POSE.x], cz = poses[POSE.z]
  s = step({ cmds: [{ c: 'teleport', x: cx + 2.5, z: cz }] })
  s = step({ cmds: [{ c: 'interact' }] })
  assert.deepEqual(s.drivings, [0, -1, -1, 1])
  assert.ok(Math.hypot(s.avatars[2].x - cx, s.avatars[2].z - cz) < CAR.halfLength + 0.3 + 0.5, 'player 2 is on foot within the clearance')
  for (let i = 0; i < 30; i++) step()
  rejected = step().rejected
  const y0 = poses[POSE.y]
  s = step({ cmds: [{ c: 'reset' }] })
  assert.equal(s.rejected, rejected + 1)
  assert.ok(s.events.some((e) => e.e === 'rejected' && /standing there/.test(e.reason)), JSON.stringify(s.events))
  assert.ok(Math.abs(poses[POSE.y] - y0) < 0.05 && Math.abs(poses[POSE.x] - cx) < 0.05 && Math.abs(poses[POSE.z] - cz) < 0.05, 'the car was not touched')
  assert.deepEqual(s.drivings, [0, -1, -1, 1])
  s = step({ cmds: [{ c: 'teleport', x: cx - 12, z: cz, player: 2 }] })
  s = step({ cmds: [{ c: 'reset' }] })
  assert.equal(s.rejected, rejected + 1, 'the reset went through with nobody beside the car')
  assert.ok(poses[POSE.y] > y0 + 0.2, `righted (lifted to ${poses[POSE.y].toFixed(2)} m)`)
  assert.equal(sim.halted, false, sim.panic ?? '')
  // Infinite and absurd controls for a player on foot and one at the wheel: no control, nothing non-finite.
  const before = step().avatars
  const wild = [
    { foot: { x: Infinity, z: -Infinity, heading: Infinity }, drive: { steer: -Infinity, fwd: Infinity, back: 1e9, handbrake: true } },
    IDLE_PLAYER,
    { foot: { x: 1e308, z: 1e308, heading: -1e308 }, drive: { steer: 1e308, fwd: 1e308, back: -1e308, handbrake: false } },
  ]
  for (let i = 0; i < 30; i++) s = step({ players: wild, foot: { x: Infinity, z: Infinity, heading: NaN }, drive: { steer: Infinity, fwd: Infinity, back: Infinity, handbrake: true } })
  plain(s)
  assert.ok(Math.abs(s.avatars[1].x - before[1].x) < 0.01 && Math.abs(s.avatars[1].z - before[1].z) < 0.01, 'infinite walking is no walking')
  assert.ok(s.avatars.every((a) => Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z) && Number.isFinite(a.speed)))
  assert.ok(Array.from(poses).every(Number.isFinite), 'every pose finite')
  assert.equal(sim.halted, false, sim.panic ?? '')
})

test('adversarial: a surveyed region takes spawns too: kept as given (no lots), on the slab, validated like the city\'s', async () => {
  const region = { bounds: { x0: -200, z0: -150, x1: 200, z1: 150 }, walls: [] }
  const base = { seed: 1, cars: 1, agents: AGENTS, boxes: [], furniture: NO_FURNITURE, spawn: { x: -150, z: -100 }, debug: false, region }
  const spawns = [{ x: 20, z: 20 }, { x: -100, z: 50 }, { x: 180, z: -140 }]
  const sim = await SimCore.create({ ...base, spawns }, null)
  assert.equal(sim.meta.players, 4)
  const poses = new Float32Array(sim.meta.count * POSE.stride)
  let s = sim.step({ dt: H, foot: STILL, drive: IDLE, cmds: [] }, poses)
  for (let i = 0; i < 60; i++) s = sim.step({ dt: H, foot: STILL, drive: IDLE, cmds: [], players: only(2, { x: 2, z: 0, heading: 0 }) }, poses)
  plain(s)
  assert.equal(sim.halted, false, sim.panic ?? '')
  assert.ok(Math.abs(s.avatars[1].x - 20) < 0.1 && Math.abs(s.avatars[1].z - 20) < 0.1, 'a region has no lots: (20, 20) is kept')
  assert.ok(Math.abs(s.avatars[3].x - 180) < 0.1 && Math.abs(s.avatars[3].z + 140) < 0.1)
  assert.ok(s.avatars[2].x - (-100) > 1.0 && s.avatars[2].x - (-100) <= 2 * 61 * H + 0.05, 'player 2 walked on the region ground')
  for (let k = 0; k < 4; k++) assert.ok(s.avatars[k].feetY > -0.05 && s.avatars[k].feetY < 0.1, `avatar ${k} stands on the slab (feet ${s.avatars[k].feetY.toFixed(3)})`)
  assert.deepEqual(s.avatars[0], s.avatar)
  await assert.rejects(SimCore.create({ ...base, spawns: [{ x: 'a' as unknown as number, z: 0 }] }, null), /spawns\[0\]/)
  await assert.rejects(SimCore.create({ ...base, spawns: [{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }] }, null), /at most 3/)
})
