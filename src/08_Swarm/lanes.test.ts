// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the lane runner (lanes.ts): every lane runs its own session under the lane
 * limits against one snapshot of the tables; a program that runs its gas out, reaches past its bounds, overflows
 * its stack, floods its output or does not fit its arena isolates its lane alone, with the gate's sentence as the
 * reason and the fault hashed onto the ledger, while the frame (the call to `step`) returns; a plain error keeps
 * the lane; a write for a capability the lane does not hold is a capability fault; `ask` refuses an effect the word
 * does not cover and a door by name; a host that vouches nothing or whose realm has halted isolates every lane
 * under the law that says so; nothing throws; two runners fed the same specs and tables agree to the hash.
 * What breaks if it is removed? A runaway sub-agent program could hold the frame, a lane could reach a car without
 * the bit for it, or an isolated lane could run again, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CAP_MOVE, CAP_NET, CAP_SUBAGENT_SPAWN, CAP_VEHICLE_TELEOP, CAP_WORKPLACE_TASK } from '../02_Define_The_Rules/capabilities.ts'
import { EMPTY_TABLES, LANE_LIMITS, MAX_OPS_PER_TICK, type NoirTables, type NoirWrites } from '../07_Execute_Actions/terminal/noirscript/index.ts'
import { LANE_MAX, LaneRunner, type LaneDeps, type LaneSpec } from './lanes.ts'

const WORK = CAP_MOVE | CAP_WORKPLACE_TASK
const spec = (program: string, caps = WORK, role = 'worker', tag = 'reading'): LaneSpec => ({ role, caps, program, tag })
const deps = (log: string[] = [], over: Partial<LaneDeps> = {}): LaneDeps => ({ contained: () => true, panic: () => null, log: (l) => log.push(l), ...over })

/** A small city: ten people on a line, three cars, two of them moving. */
function city(): NoirTables {
  const crowdX = Float32Array.from({ length: 10 }, (_, i) => i * 2)
  const crowdZ = new Float32Array(10)
  return {
    crowd: { n: 10, x: crowdX, z: crowdZ },
    cars: { n: 3, x: Float32Array.from([0, 10, 20]), z: new Float32Array(3), heading: new Float32Array(3), speed: Float32Array.from([0, 6, 9]), mode: Int32Array.from([2, 0, 0]) },
    kernel: { law1: 4, law2: 1, law3: 0, flips: 2, shielded: false },
    frame: { fps: 60, ms: 16.6, p95: 20 },
  }
}

test('each lane runs its own program each tick against the same tables and reports its last printed line as the reading', () => {
  const r = new LaneRunner([
    spec('print(query cars where speed > 5.0);', WORK, 'robotics lead', 'cars moving'),
    spec('print(query crowd where x < 9.0);', WORK, 'warehouse', 'people in the yard'),
    spec('print(kernel.law1);', WORK, 'clinic', 'First-Law interventions'),
  ], deps())
  assert.equal(r.count, 3)
  assert.equal(r.open, 3)
  assert.equal(r.tick, 0)
  assert.deepEqual(r.views().map((v) => [v.lane, v.role, v.tag, v.held, v.state, v.ticks, v.value]), [[0, 'robotics lead', 'cars moving', WORK, 'ready', 0, null], [1, 'warehouse', 'people in the yard', WORK, 'ready', 0, null], [2, 'clinic', 'First-Law interventions', WORK, 'ready', 0, null]])
  const views = r.step(city())
  assert.deepEqual(views.map((v) => [v.value, v.error, v.fault, v.ticks]), [['2', null, null, 1], ['5', null, null, 1], ['4', null, null, 1]])
  assert.ok(views.every((v) => v.steps > 0 && v.steps < MAX_OPS_PER_TICK && v.total === v.steps))
  assert.ok(views.every((v) => Object.isFrozen(v)))
  const again = r.step(null)
  assert.deepEqual(again.map((v) => [v.value, v.ticks, v.total > v.steps]), [['0', 2, true], ['0', 2, true], ['0', 2, true]], 'the empty city on the next tick')
  assert.equal(r.tick, 2)
  assert.equal(r.ledger.length, 0)
  assert.equal(r.ledger.verify().ok, true)
})

test('a program that runs its gas out is isolated alone: the gate\'s Zeroth-Law sentence, the fault on the ledger, the word zeroed, the other lanes and the frame go on', () => {
  const log: string[] = []
  const r = new LaneRunner([spec('print(1);'), spec('loop { }', WORK, 'spinner', 'nothing'), spec('print(2);')], deps(log))
  const views = r.step(city())
  assert.deepEqual(views.map((v) => [v.state, v.fault, v.held]), [['ready', null, WORK], ['isolated', 'gas', 0], ['ready', null, WORK]])
  assert.equal(views[1].steps, MAX_OPS_PER_TICK)
  assert.equal(views[1].error, `step budget exhausted (${MAX_OPS_PER_TICK})`)
  assert.equal(r.ledger.length, 1)
  const rec = r.ledger.records()[0]
  assert.deepEqual([rec.lane, rec.kind, rec.reason, rec.asked, rec.held, rec.steps, rec.tick, rec.seq], [1, 'gas', `Zeroth Law: the lane ran its ${MAX_OPS_PER_TICK}-step budget out this tick`, 0, WORK, MAX_OPS_PER_TICK, 1, 0])
  assert.equal(views[1].audit, rec.hash)
  assert.equal(log.length, 1)
  assert.match(log[0], new RegExp(`^\\[RING-0 LANE 1\\] isolated \\(gas\\): Zeroth Law: the lane ran its ${MAX_OPS_PER_TICK}-step budget out this tick; held 0x00000003, asked 0x00000000, ${MAX_OPS_PER_TICK} steps, tick 1; audit ${rec.hash.slice(0, 16)}$`))
  assert.ok(r.isolated(1) && !r.isolated(0) && !r.isolated(2))
  assert.equal(r.open, 2)
  // The next tick skips the isolated lane: its counts stand, the others advance.
  const next = r.step(city())
  assert.deepEqual(next.map((v) => v.ticks), [2, 1, 2])
  assert.equal(r.ledger.length, 1)
  assert.deepEqual(r.ask(1, CAP_MOVE), { ok: false, reason: 'lane 1 is isolated' })
  assert.equal(r.ledger.length, 1, 'an isolated lane asked again records nothing more')
})

test('bounds, depth, output and memory are faults of the lane\'s arena, each named by the VM\'s text; a plain error keeps the lane running', () => {
  const r = new LaneRunner([
    spec('let a = [1; 4]; print(a[7]);'),
    spec('fn d(n: i32) -> i32 { d(n + 1) } print(d(0));'),
    spec('loop { print("0123456789"); }'),
    spec('let huge = [0; 60000];'),
    spec('print(1 / 0);'),
    spec('print(crowd.x[20]);'),
  ], deps())
  const views = r.step(city())
  assert.deepEqual(views.map((v) => [v.state, v.fault]), [['isolated', 'bounds'], ['isolated', 'depth'], ['isolated', 'output'], ['isolated', 'memory'], ['ready', null], ['isolated', 'bounds']])
  assert.deepEqual(r.ledger.records().map((f) => f.reason), [
    'Zeroth Law: the lane reached past its bounds: index 7 out of bounds (len 4)',
    `Zeroth Law: the lane reached past its bounds: stack overflow (depth ${LANE_LIMITS.depth})`,
    `Zeroth Law: the lane reached past its bounds: output limit exhausted (${LANE_LIMITS.out})`,
    'Zeroth Law: the lane reached past its bounds: memory exhausted',
    'Zeroth Law: the lane reached past its bounds: index 20 out of bounds (len 10)',
  ])
  assert.equal(views[4].error, 'division by zero')
  assert.equal(views[4].held, WORK)
  assert.equal(r.step(city())[4].ticks, 2, 'a plain error runs again next tick')
  assert.equal(r.ledger.verify().ok, true)
})

test('a write asks for vehicle teleop: a lane without the bit is a capability fault; a lane with it reaches the host\'s intent and nothing else', () => {
  const calls: unknown[][] = []
  const write: NoirWrites = {
    intent: (car, t, b, s) => { calls.push([car, t, b, s]); return true },
    tune: () => 1, cull: () => 1, steer: () => 1,
  }
  const r = new LaneRunner([
    spec('intent(1, 0.5, 0.0, 0.1); print(1);', WORK, 'walker'),
    spec('print(intent(2, 1.0, 0.0, 0.0));', WORK | CAP_VEHICLE_TELEOP, 'driver'),
    spec('tune("x", 1.0);', WORK | CAP_VEHICLE_TELEOP, 'tuner'),
    spec('print(intent(0, 0.0, 1.0, 0.0));', WORK | CAP_VEHICLE_TELEOP, 'no surface'),
  ], deps())
  const views = r.step(city(), write)
  assert.deepEqual(views.map((v) => [v.state, v.fault, v.error, v.value]), [
    ['isolated', 'capability', 'lane: vehicle teleop is not held', null],
    ['ready', null, null, 'true'],
    ['ready', null, "lane: tune is the operator's knob, not a lane's", null],
    ['ready', null, null, 'true'],
  ])
  assert.deepEqual(calls, [[2, 1, 0, 0], [0, 0, 1, 0]])
  assert.equal(r.ledger.records()[0].reason, 'Second Law: the lane holds move, workplace task and asked for vehicle teleop')
  assert.equal(r.ledger.records()[0].asked, CAP_VEHICLE_TELEOP)
  // No write surface from the host: the lane holding the bit gets an error, not a fault.
  const alone = new LaneRunner([spec('print(intent(0, 0.0, 1.0, 0.0));', WORK | CAP_VEHICLE_TELEOP)], deps())
  assert.deepEqual(alone.step(city()).map((v) => [v.state, v.error]), [['ready', 'lane: the host gave no write surface']])
})

test('ask: an effect the word covers is admitted; one it does not isolates the lane under the Second Law; a door is named as a door; a bad lane number is no lane', () => {
  const r = new LaneRunner([spec('print(1);', CAP_MOVE), spec('print(2);', WORK), spec('print(3);', WORK)], deps())
  assert.deepEqual(r.ask(0, CAP_MOVE), { ok: true })
  assert.deepEqual(r.ask(1, CAP_MOVE | CAP_WORKPLACE_TASK), { ok: true })
  assert.deepEqual(r.ask(0, CAP_WORKPLACE_TASK), { ok: false, reason: 'Second Law: the lane holds move and asked for workplace task' })
  assert.deepEqual(r.views()[0], { ...r.views()[0], state: 'isolated', fault: 'capability', held: 0 })
  assert.deepEqual(r.ask(1, CAP_SUBAGENT_SPAWN), { ok: false, reason: 'Second Law: the lane holds move, workplace task and asked for sub-agent spawn' })
  assert.deepEqual(r.ask(2, CAP_NET), { ok: false, reason: 'Second Law: the lane asked for the network: a door no lane is granted' })
  assert.equal(r.views()[2].fault, 'door')
  assert.deepEqual(r.ask(3, CAP_MOVE), { ok: false, reason: 'no such lane' })
  assert.deepEqual(r.ask(-1, CAP_MOVE), { ok: false, reason: 'no such lane' })
  assert.deepEqual(r.ask(1.5, CAP_MOVE), { ok: false, reason: 'no such lane' })
  assert.equal(r.ledger.length, 3)
  assert.deepEqual(r.ledger.records().map((f) => [f.lane, f.kind, f.steps, f.tick]), [[0, 'capability', 0, 0], [1, 'capability', 0, 0], [2, 'door', 0, 0]])
  assert.equal(r.open, 0)
  assert.deepEqual(r.step(city()).map((v) => v.ticks), [0, 0, 0], 'nothing left to run')
})

test('a host that vouches nothing, or whose realm has halted, isolates every lane under the law that says so; a host that throws fails closed; nothing escapes', () => {
  const none = new LaneRunner([spec('print(1);'), spec('print(2);')], deps([], { contained: () => null }))
  assert.deepEqual(none.step(city()).map((v) => [v.state, v.fault]), [['isolated', 'law'], ['isolated', 'law']])
  assert.match(none.ledger.records()[0].reason, /^Zeroth Law: this page's outbound primitives are not held to this machine/)
  const halted = new LaneRunner([spec('print(1);')], deps([], { panic: () => 'RUNAWAY: 41.0 m/s' }))
  assert.deepEqual(halted.step(city()).map((v) => [v.state, v.fault, v.value]), [['isolated', 'law', '1']], 'the program ran its tick; the verdict after it isolates')
  assert.equal(halted.ledger.records()[0].reason, 'First Law: the realm has halted: RUNAWAY: 41.0 m/s')
  const throwing = new LaneRunner([spec('print(1);')], deps([], { contained: () => { throw new Error('no host') } }))
  assert.doesNotThrow(() => throwing.step(city()))
  assert.equal(throwing.views()[0].fault, 'law')
  const unsure = new LaneRunner([spec('print(1);')], deps([], { panic: () => { throw new Error('no realm') } }))
  assert.doesNotThrow(() => unsure.step(city()))
  assert.equal(unsure.ledger.records()[0].reason, 'First Law: the realm has halted: the host could not say whether the realm stands: no realm')
  const deaf = new LaneRunner([spec('loop { }')], deps([], { log: () => { throw new Error('no console') } }))
  assert.doesNotThrow(() => deaf.step(city()))
  assert.equal(deaf.views()[0].fault, 'gas')
  // The default log is console.error: one line per panic.
  const errors: unknown[][] = []
  const real = console.error
  console.error = (...a: unknown[]) => { errors.push(a) }
  try {
    new LaneRunner([spec('loop { }')], { contained: () => true, panic: () => null }).step(null)
  } finally {
    console.error = real
  }
  assert.equal(errors.length, 1)
  assert.match(String(errors[0][0]), /^\[RING-0 LANE 0\] isolated \(gas\)/)
})

test('lanes are isolated from one another: a global of one is not another\'s, and the arena is each lane\'s own', () => {
  const r = new LaneRunner([spec('let secret = 42; print(secret);'), spec('print(secret);')], deps())
  const views = r.step(EMPTY_TABLES)
  assert.deepEqual(views.map((v) => [v.value, v.error?.includes('secret') ?? false, v.state]), [['42', false, 'ready'], [null, true, 'ready']])
  assert.match(views[1].error ?? '', /secret/)
})

test('a plan beyond LANE_MAX keeps the first LANE_MAX and says how many it dropped; the table strips forbidden bits from a grant', () => {
  const many = Array.from({ length: LANE_MAX + 5 }, (_, i) => spec(`print(${i});`))
  const r = new LaneRunner(many, deps())
  assert.equal(r.count, LANE_MAX)
  assert.equal(r.dropped, 5)
  assert.equal(r.step(null).at(-1)?.value, String(LANE_MAX - 1))
  const doors = new LaneRunner([spec('print(1);', WORK | CAP_NET | 0x80000000)], deps())
  assert.equal(doors.held(0), WORK)
  assert.equal(doors.held(7), 0)
  assert.equal(doors.isolated(7), false)
})

test('determinism: two runners fed the same specs and tables, tick for tick, agree in every view and in the ledger\'s head', () => {
  const specs = [spec('print(query cars where speed > 5.0);'), spec('loop { }'), spec('let a = [0; 3]; print(a[3]);'), spec('print(crowd.n);')]
  const a = new LaneRunner(specs, deps())
  const b = new LaneRunner(specs, deps())
  for (let i = 0; i < 4; i++) {
    const t = i % 2 === 0 ? city() : null
    assert.deepEqual(a.step(t), b.step(t), `tick ${i}`)
  }
  assert.equal(a.ledger.head, b.ledger.head)
  assert.equal(a.ledger.length, 2)
  assert.deepEqual(a.ledger.verify(), { ok: true })
})
