// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the team runner over a fake host: a dispatch opens one lane a sub-agent at its
 * desk's door (found under either name of a first room), asks one body a desk through the lane's own word, and reads
 * the city tick by tick; an arrived body is sent to the desk only when the player stands within rally range of its
 * door, else the distance is said and the tether stands; a host that vouches nothing or whose realm halted isolates
 * every lane through the gate at the first tick, asks nobody over, and the ledger verifies; stop closes the lanes and
 * keeps the people; a second dispatch replaces the first and a late answer from the first changes nothing; a host that
 * throws is a note, never an exception; and the console's lines say all of it.
 * What breaks if it is removed? The runner could rally past the tether, ask a body over from an isolated lane, let an
 * old team's answers into a new one, or throw out of the frame loop on a host that failed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CAP_MOVE, CAP_WORKPLACE_TASK } from '../02_Define_The_Rules/capabilities.ts'
import { RALLY_RANGE } from '../03_Spawn_Agents/skills.ts'
import { teamFor } from '../06_Make_Decisions/dispatch.ts'
import type { NoirTables } from '../07_Execute_Actions/terminal/noirscript/index.ts'
import { GONE_TICKS, NOTES_MAX, RALLY_RETRY_TICKS, TEAM_TICK_MS, TeamRunner, type TeamHost, type TeamRoom } from './team.ts'

/** A small city: a hundred people on a grid within 14 m of the origin, ten cars on a line far east. */
function tables(): NoirTables {
  const n = 100, c = 10
  const crowd = { n, x: new Float32Array(n), z: new Float32Array(n) }
  for (let i = 0; i < n; i++) { crowd.x[i] = (i % 10) * 3 - 13.5; crowd.z[i] = Math.floor(i / 10) * 3 - 13.5 }
  const cars = { n: c, x: new Float32Array(c), z: new Float32Array(c), heading: new Float32Array(c), speed: new Float32Array(c), mode: new Int32Array(c) }
  for (let i = 0; i < c; i++) { cars.x[i] = 500 + i * 4; cars.z[i] = 500; cars.speed[i] = 6; cars.mode[i] = 0 }
  return { crowd, cars, kernel: { law1: 1, law2: 0, law3: 0, flips: 0, shielded: false }, frame: { fps: 60, ms: 16.6, p95: 18 } }
}

/** Three rooms: the warehouse at the origin, the control tower under its earlier name far east, the robotics lab far away. */
const ROOMS: readonly TeamRoom[] = Object.freeze([
  { kind: 'warehouse', name: 'Automated Fulfillment and Forklift Warehouse', door: { x: 5, z: 0 } },
  { kind: 'telemetryCommand', name: 'Telemetry Command', door: { x: 60, z: 0 } },
  { kind: 'roboticsLab', name: 'Dexterous Robotics and Manipulator Lab', door: { x: 400, z: 400 } },
])

interface Fake extends TeamHost {
  calls: string[]
  people: { agent: number; arrived: boolean }[]
  at: { x: number; z: number } | null
}

function host(over: Partial<TeamHost> = {}): Fake {
  let next = 10
  const f: Fake = {
    calls: [],
    people: [],
    at: { x: 0, z: 0 },
    tables: () => tables(),
    contained: () => true,
    panic: () => null,
    rooms: () => ROOMS,
    operator: () => f.at,
    recruits: () => f.people,
    recruit: async (skill) => { f.calls.push(`recruit ${skill}`); const agent = next++; f.people.push({ agent, arrived: false }); return { ok: true, agent, message: `agent ${agent} (${skill}) is coming over` } },
    rally: async (agent, x, z) => { f.calls.push(`rally ${agent} ${x} ${z}`); return { ok: true, message: `agent ${agent} is on the way` } },
    log: (line) => { f.calls.push(`log ${line}`) },
    ...over,
  }
  return f
}

const settle = () => new Promise<void>((r) => setImmediate(r))
/** A hand count: the people of rows [from, from + 48) within r metres of (x, z). */
function within(r: number, x: number, z: number, from = 0): number {
  const t = tables()
  let n = 0
  for (let j = from; j < Math.min(from + 48, t.crowd.n); j++) if ((t.crowd.x[j]! - x) ** 2 + (t.crowd.z[j]! - z) ** 2 < r * r) n++
  return n
}
const GOAL = 'a 24-agent warehouse telemetry robotics drill'

test('dispatch opens one lane a sub-agent at its desk\'s door, asks one body a desk through the lane\'s word, and the readings come tick by tick', async () => {
  const h = host()
  const crew = new TeamRunner(h)
  assert.equal(crew.team, null)
  assert.equal(crew.line(), '')
  const team = teamFor(GOAL)
  const d = crew.dispatch(team)
  assert.deepEqual(d, { lanes: 24, dropped: 0, label: 'Send 24 sub-agents to the warehouse, the control tower and the robotics lab', bodies: 3, missing: [] })
  assert.equal(crew.team, team)
  // One body a desk, asked over by the desk's skill, in the order the goal named them, each after the lane's own ask for the move.
  assert.deepEqual(h.calls, ['recruit Go', 'recruit Python', 'recruit Robotics'])
  assert.equal(crew.ticks, 0)
  assert.deepEqual(crew.lines().slice(0, 3), [
    { tag: 'warehouse:1', role: 'the warehouse', state: 'ready', reading: null },
    { tag: 'tower:1', role: 'the control tower', state: 'ready', reading: null },
    { tag: 'robotics:1', role: 'the robotics lab', state: 'ready', reading: null },
  ])
  crew.tick()
  assert.equal(crew.ticks, 1)
  const views = crew.views()
  assert.equal(views.length, 24)
  assert.ok(views.every((v) => v.state === 'ready' && v.held === (CAP_MOVE | CAP_WORKPLACE_TASK) && v.value !== null && v.steps > 0))
  // The warehouse's lanes read around its door at (5, 0), window by window: the hand count of the same rows.
  assert.ok(within(20, 5, 0) > 0 && within(20, 5, 0) < 48)
  assert.equal(crew.lines()[0]!.reading, `people within 20 m ${within(20, 5, 0)} of 48 from row 0`)
  assert.equal(crew.lines()[3]!.reading, `people within 20 m ${within(20, 5, 0, 48)} of 48 from row 48`)
  // The tower under its earlier name is found all the same, and reads the frame; the lab reads the cars near it, none.
  assert.match(crew.lines()[1]!.reading!, /^fps 60 ms 16\.6 p95 ms 18 cars 10 people 100$/)
  assert.equal(crew.lines()[2]!.reading, 'vehicles within 30 m 0 of 10 fastest 0', 'ten cars: a window reads the rows there are')
  await settle()
  assert.equal(crew.line(), 'Team 24 · warehouse 8, tower 8, robotics 8 · 3 coming over')
  const status = crew.status()
  assert.match(status[0]!, /^team: Send 24 sub-agents to the warehouse, the control tower and the robotics lab \(24 running, 0 isolated\) · tick 1$/)
  assert.match(status[1]!, /^ {2}LANE {2}TAG {11}STATE {5}WORD {18}STEPS {2}READING$/)
  assert.match(status[2]!, /^ {2}0 {5}warehouse:1 {3}ready {5}move, workplace task {2}\d+ {1,6}people within 20 m \d+ of 48 from row 0$/)
  assert.ok(status.includes(`bodies: one asked over a desk (3); sent in when you stand within ${RALLY_RANGE} m of the desk's door`))
  assert.match(status.find((l) => l.startsWith('  warehouse:1 '))!, /coming {4}agent 10 \(Go\) is coming over$/)
  const ledger = crew.ledger(true)
  assert.match(ledger[0]!, /^ledger: 0 records, head [0-9a-f]{16}$/)
  assert.deepEqual(ledger.slice(1), ['  no lane has been isolated', '  chain verified: every hash recomputes from the one before it'])
  // Ticks keep coming, nothing grows: a hundred ticks later every lane still reads, and the notes stay empty.
  for (let i = 0; i < 100; i++) crew.tick()
  assert.ok(crew.views().every((v) => v.state === 'ready'))
  // The notes are what came of the bodies, nothing else: no host failure, nothing isolated.
  const after = crew.status()
  assert.deepEqual(after.slice(after.indexOf('notes:') + 1), ['  warehouse:1: agent 10 (Go) is coming over', '  tower:1: agent 11 (Python) is coming over', '  robotics:1: agent 12 (Robotics) is coming over'])
  // The cap: a goal asking for more than fit says so, and nobody beyond it is opened.
  const capped = crew.dispatch(teamFor('send 40 agents to the clinic'))
  assert.deepEqual([capped.lanes, capped.dropped, capped.bodies, capped.missing], [32, 8, 1, ['the gait lab']])
  assert.match(crew.status()[0]!, /\(32 running, 0 isolated, 8 asked for beyond the cap\)/)
  assert.ok(crew.status().some((l) => /^ {2}gait:1 {8}nowhere {3}this map has no gait lab: nobody asked over, its lanes read around the city centre$/.test(l)))
})

test('bodies: an arrived recruit is sent to the desk\'s door only when the player stands within rally range of it; farther, the distance is said; driving, nobody moves; a desk this map lacks says so', async () => {
  const h = host()
  const crew = new TeamRunner(h)
  crew.dispatch(teamFor(GOAL))
  await settle()
  // Nobody has arrived: a tick sends nobody.
  crew.tick()
  assert.ok(!h.calls.some((c) => c.startsWith('rally')))
  // The warehouse's body arrives; its door is 5 m from the player: sent in, through the lane's word for the move.
  h.people[0]!.arrived = true
  crew.tick()
  assert.deepEqual(h.calls.filter((c) => c.startsWith('rally')), ['rally 10 5 0'])
  await settle()
  assert.match(crew.status().find((l) => l.startsWith('  warehouse:1 '))!, /rallied {3}agent 10 is on the way$/)
  // The tower's body arrives; its door is 60 m away: not sent, the distance said, the tether untouched.
  h.people[1]!.arrived = true
  crew.tick()
  assert.deepEqual(h.calls.filter((c) => c.startsWith('rally')), ['rally 10 5 0'])
  assert.match(crew.status().find((l) => l.startsWith('  tower:1 '))!, new RegExp(`coming {4}agent 11 is with you; the Telemetry Command is 60 m away \\(within ${RALLY_RANGE} m they are sent in\\)$`))
  // Driving (no operator on foot): nothing moves, nothing throws.
  h.at = null
  crew.tick()
  assert.deepEqual(h.calls.filter((c) => c.startsWith('rally')), ['rally 10 5 0'])
  // The player walks over: within range now, the body is sent.
  h.at = { x: 58, z: 0 }
  crew.tick()
  assert.deepEqual(h.calls.filter((c) => c.startsWith('rally')), ['rally 10 5 0', 'rally 11 60 0'])
  // Sending until the recruiter answers: only a rally it took counts at the desk.
  assert.match(crew.status().find((l) => l.startsWith('  tower:1 '))!, /sending {3}sending agent 11 to the Telemetry Command$/)
  assert.equal(crew.line(), 'Team 24 · warehouse 8, tower 8, robotics 8 · 2 coming over · 1 at their desk')
  await settle()
  assert.equal(crew.line(), 'Team 24 · warehouse 8, tower 8, robotics 8 · 1 coming over · 2 at their desk')
  // A desk this map has no room for: the lane reads around the origin, nobody is asked over, and the dispatch names it.
  const k = host()
  const kitchen = new TeamRunner(k)
  assert.deepEqual(kitchen.dispatch(teamFor('the kitchen prep line')).missing, ['the kitchen'])
  await settle()
  assert.deepEqual(k.calls, [])
  kitchen.tick()
  assert.match(kitchen.status().find((l) => l.startsWith('  kitchen:1 '))!, /nowhere {3}this map has no kitchen: nobody asked over, its lanes read around the city centre$/)
  assert.equal(kitchen.lines()[0]!.reading, `people within 12 m ${within(12, 0, 0)} of 48 from row 0`, 'read around the origin')
  // A refused ask over: the body is refused and the reason kept; a rally the host refuses is kept as its message.
  const shy = host({ recruit: async () => ({ ok: false, agent: -1, message: 'nobody within earshot has Go' }) })
  const t = new TeamRunner(shy)
  t.dispatch(teamFor('the warehouse'))
  await settle()
  assert.match(t.status().find((l) => l.startsWith('  warehouse:1 '))!, /refused {3}nobody within earshot has Go$/)
  assert.equal(t.line(), 'Team 1 · warehouse 1')
})

test('a host that vouches nothing or whose realm halted: every lane isolated through the gate at the first tick, one line a lane, nobody asked over, the ledger verifies', () => {
  for (const [name, over] of [['no vouch', { contained: () => null }], ['the vouch false', { contained: () => false }], ['the realm halted', { panic: () => 'SYSTEM LOCKED: a test' }]] as const) {
    const h = host(over)
    const crew = new TeamRunner(h)
    const d = crew.dispatch(teamFor('pizza'))
    assert.deepEqual([d.lanes, d.bodies], [2, 2], name)
    // The lane's own ask for the move is refused before anyone is asked over: that refusal is the lane panic, at tick 0.
    assert.ok(!h.calls.some((c) => c.startsWith('recruit')), name)
    assert.ok(crew.status().filter((l) => /^ {2}(twin|tower):1 {3,}refused /.test(l)).length === 2, `${name}: ${crew.status().join('\n')}`)
    assert.deepEqual(crew.views().map((v) => [v.state, v.held, v.fault !== null]), [['isolated', 0, true], ['isolated', 0, true]], name)
    assert.equal(h.calls.filter((c) => c.startsWith('log [RING-0 LANE')).length, 2, name)
    crew.tick()
    assert.deepEqual(crew.views().map((v) => [v.state, v.held, v.fault !== null]), [['isolated', 0, true], ['isolated', 0, true]], name)
    assert.deepEqual(crew.lines().map((l) => l.state), ['isolated', 'isolated'])
    assert.equal(h.calls.filter((c) => c.startsWith('log [RING-0 LANE')).length, 2, name)
    assert.equal(crew.line(), 'Scouts 2 · twin 1, tower 1 · 2 isolated', name)
    assert.match(crew.status()[0]!, /\(0 running, 2 isolated\) · tick 1$/)
    const ledger = crew.ledger(true)
    assert.match(ledger[0]!, /^ledger: 2 records, head [0-9a-f]{16}$/)
    assert.match(ledger[1]!, /^ {2}#0 lane 0 twin:1 law at tick 0: (?:Zeroth|First) Law: .+ \([0-9a-f]{16}\)$/)
    assert.match(ledger[2]!, /^ {2}#1 lane 1 tower:1 law at tick 0: /)
    assert.equal(ledger[3], '  chain verified: every hash recomputes from the one before it')
    // A tick more changes nothing: isolated lanes are not stepped, and nothing is logged twice.
    crew.tick()
    assert.equal(h.calls.filter((c) => c.startsWith('log')).length, 2)
  }
})

test('stop closes the lanes and keeps the people; a second dispatch replaces the first and a late answer from the first changes nothing; the console surface is frozen; dispose', async () => {
  let release = null as (() => void) | null
  const slow = host({ recruit: (skill) => new Promise((resolve) => { release = () => resolve({ ok: true, agent: 99, message: `agent 99 (${skill}) is coming over` }) }) })
  const crew = new TeamRunner(slow)
  const con = crew.console()
  assert.ok(Object.isFrozen(con))
  assert.deepEqual(con.status(), ['lanes: nobody dispatched; tell Sloane a goal about work, or type goal <words...>'])
  assert.deepEqual(con.ledger(true), ['lanes: nobody dispatched, so no ledger'])
  assert.equal(con.stop(), 'nobody dispatched')
  assert.deepEqual(con.dispatch(teamFor('the warehouse')), { lanes: 1, dropped: 0, missing: [] })
  assert.ok(release !== null, 'the first team asked someone over')
  const first = release
  // The second team replaces the first before the first's answer comes.
  assert.deepEqual(con.dispatch(teamFor('two agents at the control tower')), { lanes: 2, dropped: 0, missing: [] })
  first()
  await settle()
  const rows = crew.status().filter((l) => /^ {2}tower:1 /.test(l))
  assert.equal(rows.length, 1)
  assert.match(rows[0]!, /^ {2}tower:1 {7}asked {5}asking someone with Python over$/, 'the late answer never reached the new team')
  assert.equal(crew.line(), 'Team 2 · tower 2')
  // Stop: the lanes close, the people stay (the recruiter keeps them), and everything reads as empty.
  assert.equal(con.stop(), 'released: 2 lanes closed; the people asked over stay with you (recruit dismiss lets them go)')
  assert.equal(crew.team, null)
  assert.deepEqual(crew.lines(), [])
  assert.deepEqual(crew.views(), [])
  assert.equal(crew.line(), '')
  assert.equal(crew.ticks, 0)
  crew.tick()
  assert.deepEqual(con.status(), ['lanes: nobody dispatched; tell Sloane a goal about work, or type goal <words...>'])
  // Dispose with a team open: the lanes close; dispose twice is harmless.
  con.dispatch(teamFor('pizza'))
  crew.dispose()
  crew.dispose()
  assert.equal(crew.team, null)
})

test('a host that throws is a note, never an exception, and the notes are capped', async () => {
  const bad = host({
    tables: () => { throw new Error('the columns are away') },
    recruit: () => { throw new Error('the recruiter is gone') },
  })
  const crew = new TeamRunner(bad)
  const d = crew.dispatch(teamFor('the warehouse and the control tower'))
  assert.deepEqual([d.lanes, d.bodies], [2, 2])
  for (let i = 0; i < NOTES_MAX * 3; i++) crew.tick()
  const status = crew.status()
  assert.ok(status.includes('notes:'))
  const notes = status.slice(status.indexOf('notes:') + 1)
  assert.equal(notes.length, NOTES_MAX, 'the newest kept, the rest let go')
  assert.ok(notes.every((n) => n === '  columns: the columns are away'))
  assert.ok(status.some((l) => /^ {2}warehouse:1 {3}refused {3}the recruiter is gone$/.test(l)))
  // Without columns a lane reads the empty city, and still runs.
  assert.ok(crew.views().every((v) => v.state === 'ready'))
  assert.equal(crew.lines()[0]!.reading, 'people within 20 m 0 of 0 from row 0')
  // A recruiter whose promise rejects, and one whose list throws.
  const reject = host({ recruit: () => Promise.reject(new Error('no answer')), recruits: () => { throw new Error('the list is gone') } })
  const r = new TeamRunner(reject)
  r.dispatch(teamFor('the warehouse'))
  await settle()
  r.tick()
  const st = r.status()
  assert.ok(st.some((l) => /^ {2}warehouse:1 {3}refused {3}no answer$/.test(l)))
  assert.ok(st.includes('  people: the list is gone'))
  // Rooms that throw: no desk is placed, nobody is asked over, and the note says why.
  const roomless = host({ rooms: () => { throw new Error('no rooms today') } })
  const n = new TeamRunner(roomless)
  assert.deepEqual(n.dispatch(teamFor('the warehouse')).missing, ['the warehouse'])
  assert.deepEqual(roomless.calls, [])
  assert.ok(n.status().includes('  rooms: no rooms today'))
  // A rally the host throws on is noted on the body, which stays coming over (never counted at the desk).
  const throwing = host({ rally: () => { throw new Error('no legs') } })
  const t = new TeamRunner(throwing)
  t.dispatch(teamFor('the warehouse'))
  await settle()
  throwing.people[0]!.arrived = true
  t.tick()
  assert.ok(t.status().some((l) => /^ {2}warehouse:1 {3}coming {4}no legs$/.test(l)))
  assert.equal(t.line(), 'Team 1 · warehouse 1 · 1 coming over')
  assert.equal(TEAM_TICK_MS, 250)
})

test('a rally the recruiter turns down is asked again later and never counted at the desk; someone who leaves before arriving is gone; a team asked for from a car asks once the player is on foot', async () => {
  // Turned down (no sidewalk there): back to coming over, asked again RALLY_RETRY_TICKS later, then taken.
  let refuse = true
  const h = host({ rally: async (agent, x, z) => { h.calls.push(`rally ${agent} ${x} ${z}`); return refuse ? { ok: false, message: 'rally: no sidewalk from where they stand to the rally point' } : { ok: true, message: `agent ${agent} is on the way` } } })
  const crew = new TeamRunner(h)
  crew.dispatch(teamFor('the warehouse'))
  await settle()
  h.people[0]!.arrived = true
  crew.tick()
  await settle()
  const rallies = () => h.calls.filter((c) => c.startsWith('rally')).length
  assert.equal(rallies(), 1)
  assert.match(crew.status().find((l) => l.startsWith('  warehouse:1 '))!, /coming {4}rally: no sidewalk from where they stand to the rally point$/)
  assert.equal(crew.line(), 'Team 1 · warehouse 1 · 1 coming over')
  for (let i = 0; i < RALLY_RETRY_TICKS - 1; i++) crew.tick()
  assert.equal(rallies(), 1, 'not asked again before the hold')
  refuse = false
  crew.tick()
  await settle()
  assert.equal(rallies(), 2)
  assert.equal(crew.line(), 'Team 1 · warehouse 1 · 1 at their desk')
  // Released before arriving (the tether broke, or they were dismissed): gone after GONE_TICKS ticks off the list.
  const g = host()
  const left = new TeamRunner(g)
  left.dispatch(teamFor('the warehouse'))
  await settle()
  g.people.length = 0
  for (let i = 0; i < GONE_TICKS - 1; i++) left.tick()
  assert.equal(left.line(), 'Team 1 · warehouse 1 · 1 coming over')
  left.tick()
  assert.match(left.status().find((l) => l.startsWith('  warehouse:1 '))!, /gone {6}agent 10 left before reaching the desk$/)
  assert.equal(left.line(), 'Team 1 · warehouse 1')
  // Asked for from a car: nobody asked until the player is on foot, then asked once, through the lane's word.
  const c = host()
  c.at = null
  const car = new TeamRunner(c)
  car.dispatch(teamFor('the warehouse'))
  assert.deepEqual(c.calls, [])
  assert.equal(car.line(), 'Team 1 · warehouse 1 · 1 asked once you are on foot')
  car.tick()
  assert.deepEqual(c.calls, [])
  c.at = { x: 0, z: 0 }
  car.tick()
  car.tick()
  await settle()
  assert.deepEqual(c.calls, ['recruit Go'])
  assert.equal(car.line(), 'Team 1 · warehouse 1 · 1 coming over')
  // Turned down while in a car (the race: the player got in after the ask): waiting, not refused.
  const r = host({ recruit: async () => { r.at = null; return { ok: false, agent: -1, message: 'Go: recruiting works on foot' } } })
  const raced = new TeamRunner(r)
  raced.dispatch(teamFor('the warehouse'))
  await settle()
  assert.match(raced.status().find((l) => l.startsWith('  warehouse:1 '))!, /waiting {3}Go: recruiting works on foot$/)
})
