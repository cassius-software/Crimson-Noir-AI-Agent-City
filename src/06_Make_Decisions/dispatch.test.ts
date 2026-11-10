// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the team planner: which words send work to which desk, that every workplace kind
 * a map can hold has a desk (under either name of a first room), that no desk word is one of the intent engine's knob
 * words, how a count is read and capped, that the scouts go when nothing is named, that every probe compiles and runs
 * under the lane limits on a city-sized table in well under its gas, that a probe walks the columns tick by tick
 * without growing the arena, that nothing the card shows carries syntax, and that the planner is deterministic.
 * What breaks if it is removed? A probe could quietly cost more than a lane's gas (and be isolated at once), a
 * workplace kind could have no desk, or a work word could read as a trip, a pace or a knob.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WORKPLACE_KINDS } from '../01_Initialize_World/interiors.ts'
import { CAP_MOVE, CAP_WORKPLACE_TASK } from '../02_Define_The_Rules/capabilities.ts'
import { SKILLS } from '../03_Spawn_Agents/skills.ts'
import { LANE_LIMITS, MAX_OPS_PER_TICK, NoirSession, type NoirTables } from '../07_Execute_Actions/terminal/noirscript/index.ts'
import { LANE_MAX } from '../08_Swarm/lanes.ts'
import { DESKS, DESK_IDS, SCOUTS, TEAM_CAPS, TEAM_MAX, WINDOW, deskAt, deskOf, laneSpec, plainWords, scanWork, teamFor, teamLabel, teamLines, teamNames, teamOf, teamRows, type DeskId } from './dispatch.ts'
import { FiveWhys, classify } from './intent.ts'

/** A city-sized table: ten thousand people on a grid, two hundred and forty cars on a line, some parked, most moving. */
function city(): NoirTables {
  const n = 10_000, c = 240
  const crowd = { n, x: new Float32Array(n), z: new Float32Array(n) }
  for (let i = 0; i < n; i++) { crowd.x[i] = (i % 100) * 3 - 150; crowd.z[i] = Math.floor(i / 100) * 3 - 150 }
  const cars = { n: c, x: new Float32Array(c), z: new Float32Array(c), heading: new Float32Array(c), speed: new Float32Array(c), mode: new Int32Array(c) }
  for (let i = 0; i < c; i++) { cars.x[i] = i * 2 - 240; cars.z[i] = 10; cars.speed[i] = i % 3 ? 8 : 0; cars.mode[i] = i % 5 === 0 ? 2 : 0 }
  return { crowd, cars, kernel: { law1: 3, law2: 1, law3: 0, flips: 2, shielded: false }, frame: { fps: 59.9, ms: 16.7, p95: 18.2 } }
}

/** What the card shows must read as plain speech (intent.test.ts SYNTAX): no paths, code, keys or shell. */
const SYNTAX = /[`~/\\$<>{}|]|\.ts\b|\.tsx\b|--|\bnpm\b|\bsudo\b/

/** One goal a desk: a phrase that sends work there and nowhere else. */
const SAMPLE: Record<DeskId, string> = {
  roboticsLab: 'a robotics drill', warehouse: 'the warehouse inventory', serverVault: 'check the server racks', metroOps: 'the metro schedule',
  controlTower: 'the telemetry dashboards', kitchen: 'the kitchen prep line', microFab: 'a cleanroom prototype', twinStudio: 'a meeting with the board',
  fleetBay: 'fleet maintenance', greenhouse: 'the greenhouse crops', acousticsLab: 'soundproofing and decibels', responseCenter: 'an emergency evacuation',
  clearingFloor: 'a compliance audit', gaitLab: 'the clinic patients', microgrid: 'the microgrid voltage', consoleDeck: 'the sanctuary and the kernel',
}

test('sixteen desks in slot order, one for every workplace kind a map can hold under either name, each with a real skill; the caps are move and a workplace task alone', () => {
  assert.equal(DESKS.length, 16)
  assert.deepEqual(DESK_IDS, ['roboticsLab', 'warehouse', 'serverVault', 'metroOps', 'controlTower', 'kitchen', 'microFab', 'twinStudio', 'fleetBay', 'greenhouse', 'acousticsLab', 'responseCenter', 'clearingFloor', 'gaitLab', 'microgrid', 'consoleDeck'])
  // The map's kinds today, and the six first rooms' earlier names: a city built either way finds its desks.
  for (const k of [...WORKPLACE_KINDS, 'telemetryCommand', 'boardroom', 'legalChambers', 'clinic']) assert.ok(deskAt(k), `${k} has a desk`)
  assert.equal(deskAt('controlTower'), deskAt('telemetryCommand'))
  assert.equal(deskAt('twinStudio'), deskAt('boardroom'))
  assert.equal(deskAt('clearingFloor'), deskAt('legalChambers'))
  assert.equal(deskAt('gaitLab'), deskAt('clinic'))
  assert.equal(deskAt('bakery'), null)
  for (const d of DESKS) {
    assert.ok((SKILLS as readonly string[]).includes(d.skill), `${d.id}: ${d.skill}`)
    assert.ok(d.title.length > 0 && d.short.length > 0 && d.reads.length > 0)
    assert.doesNotMatch(d.title, SYNTAX)
    assert.doesNotMatch(d.reads, SYNTAX)
    assert.ok(d.kinds.includes(d.id))
    assert.ok(Object.isFrozen(d) && Object.isFrozen(d.kinds))
    assert.equal(deskOf(d.id), d)
  }
  assert.equal(new Set(DESKS.map((d) => d.short)).size, DESKS.length, 'every tag word its own')
  assert.equal(TEAM_CAPS, CAP_MOVE | CAP_WORKPLACE_TASK)
  assert.equal(TEAM_MAX, LANE_MAX, 'the planner never sends more than the runner opens')
  assert.deepEqual(SCOUTS, ['twinStudio', 'controlTower'])
  assert.equal(deskOf('warehouse').title, 'the warehouse')
})

test('every desk has words that send work there and nowhere else, and no desk word is a knob\'s: the knobs a goal names stay the intent engine\'s', () => {
  for (const d of DESKS) {
    const s = scanWork(plainWords(SAMPLE[d.id]))
    assert.deepEqual(s.kinds, [d.id], `${d.id}: ${SAMPLE[d.id]}`)
  }
  // Each desk's own name, as the brief and the console print it, sends work to that desk.
  for (const d of DESKS) assert.deepEqual(scanWork(plainWords(d.title)).kinds, [d.id], d.title)
  // Goals the intent engine maps to a knob, a trip, a pace or a question: the planner must see no work in them.
  const knobs = [
    'make it night', 'too dark', 'golden hour', 'it feels laggy', 'runs slow', 'my battery is hot', 'the fan is loud', 'cool it down', 'ultra graphics', 'potato quality',
    'mute', 'turn the sound off', 'music please', 'too loud', 'quieter roads', 'less traffic', 'fewer cars', 'more people', 'walk faster', 'take me to the harbour',
    'the controls', 'lunch time', 'breakfast', 'make it rain', 'fly over the city', 'go inside my house', 'pizza', "i don't know", 'change my outfit', 'a photo mode',
    // The console's words, the traffic's and the crowd's, which the desks once took (an independent review's sweep of every desk word through the engine).
    'automate the city', 'open ring 0', 'ring zero please', 'the executive console', 'the congestion is terrible', 'improve the traffic flow', 'sound proof',
    'put ten people on the streets', 'two people walking', 'the 3 lanes of traffic are jammed',
  ]
  for (const g of knobs) {
    const p = scanWork(plainWords(g))
    assert.deepEqual([p.kinds, p.count, p.spans], [[], null, []], g)
    assert.equal(p.at, plainWords(g).length)
  }
  // And through the whole engine: each knob goal plans its knob (or asks its why), never a dispatch; a district is a trip.
  for (const g of ['make it night', 'it feels laggy', 'mute', 'my battery is hot', 'too loud', 'the financial district', 'automate the traffic lights', 'open ring 0', 'the congestion is terrible', 'put ten people on the streets']) {
    const m = new FiveWhys(g)
    const asked = m.next() !== null
    const b = m.brief()
    assert.ok((asked || b.plan.length > 0) && b.plan.every((s) => s.control !== 'dispatch'), `${g}: ${b.plan.map((s) => s.control).join(',')}`)
  }
})

test('scanWork: the desks in order of first mention, the count in digits or words, the verb taken with the work, nothing on a plain goal', () => {
  const goal = 'Optimize the Lakefront Metro schedule and run a 24-agent warehouse robotics drill'
  const text = plainWords(goal)
  const s = scanWork(text)
  assert.deepEqual(s.kinds, ['metroOps', 'warehouse', 'roboticsLab'])
  assert.equal(s.count, 24)
  assert.equal(s.at, 0, '"optimize the" goes with the metro')
  // "optimize the lakefront metro" and "run a 24 agent" are each one span from their verb (which reaches two words on, so
  // "schedule" and "warehouse" take it too), so the district rule never sees the metro and "run" is no pace.
  const taken = s.spans.map((sp) => text.slice(sp.index, sp.index + sp.length)).sort()
  assert.deepEqual(taken, ['drill', 'optimize the lakefront metro', 'optimize the lakefront metro schedule', 'robotics', 'run a 24 agent', 'run a 24 agent warehouse'])
  assert.deepEqual(scanWork('hold a triage with six scouts').count, 6)
  assert.deepEqual(scanWork('twelve robots please').count, 12)
  assert.deepEqual(scanWork('a 400 agent drill').count, 400)
  // Tens and units, and the teens: the first walk's own "twenty-four sub-agents" is 24, never the 4 at its end.
  assert.deepEqual(scanWork(plainWords('spawn twenty-four sub-agents')).count, 24)
  assert.deepEqual(scanWork('send twenty four agents to the warehouse').count, 24)
  assert.deepEqual(scanWork('thirty-one robots').count, 31)
  assert.deepEqual(scanWork(plainWords('thirty-one robots')).count, 31)
  assert.deepEqual(scanWork('fifteen agents').count, 15)
  assert.deepEqual(scanWork('fourteen bots').count, 14)
  assert.deepEqual(scanWork('nineteen workers').count, 19)
  assert.deepEqual(scanWork('twenty agents').count, 20)
  assert.deepEqual(teamFor('spawn twenty-four sub-agents').lanes.length, 24)
  // A word that is also a knob's stays the knob's: "traffic" is the cars' (air traffic is the tower's).
  assert.deepEqual(scanWork('less traffic').kinds, [])
  assert.deepEqual(scanWork('the traffic flow downtown').kinds, [])
  assert.deepEqual(scanWork('the air traffic').kinds, ['controlTower'])
  // Up to five digits: a count past the cap is still a count (teamOf says what it left out).
  assert.equal(scanWork('send 1000 agents to the warehouse').count, 1000)
  // Overlapping desk words: the longer phrase is the desk meant, the shorter is no second desk.
  assert.deepEqual(scanWork('a fire drill').kinds, ['responseCenter'])
  assert.deepEqual(scanWork('the wind farms').kinds, ['microgrid'])
  assert.deepEqual(scanWork('the executive console').kinds, [])
  // The verb reaches two words on ("run a quick warehouse audit"), never across a preposition ("run to the warehouse" stays a run).
  assert.equal(scanWork('run a quick warehouse audit').at, 0)
  assert.equal(scanWork('run to the warehouse').at, 'run to the '.length)
  // "power" alone is nobody's; the grid's words are the grid's.
  assert.deepEqual(scanWork('more power').kinds, [])
  assert.deepEqual(scanWork('the power grid').kinds, ['microgrid'])
})

test('teamOf: one lane a desk by default, a count dealt round the desks, the cap and the dropped count, the scouts when nothing is named', () => {
  const t = teamFor('a warehouse drill')
  assert.deepEqual(t.kinds, ['warehouse', 'roboticsLab'])
  assert.deepEqual(t.lanes.map((l) => l.tag), ['warehouse:1', 'robotics:1'])
  assert.deepEqual([t.asked, t.dropped, t.scouting], [2, 0, false])
  const five = teamFor('a warehouse drill with five agents')
  assert.deepEqual(five.lanes.map((l) => [l.tag, l.slice, l.kind]), [['warehouse:1', 0, 'warehouse'], ['robotics:1', 0, 'roboticsLab'], ['warehouse:2', 1, 'warehouse'], ['robotics:2', 1, 'roboticsLab'], ['warehouse:3', 2, 'warehouse']])
  const capped = teamFor('send 40 agents to the clinic')
  assert.deepEqual([capped.lanes.length, capped.asked, capped.dropped], [TEAM_MAX, 40, 8])
  // Fewer sub-agents than desks named: the first desks get them, and only they are named.
  const short = teamFor('2 agents at the warehouse, the clinic and the kitchen')
  assert.deepEqual([short.kinds, short.lanes.map((l) => l.tag)], [['warehouse', 'gaitLab'], ['warehouse:1', 'gait:1']])
  assert.equal(teamLabel(short), 'Send 2 sub-agents to the warehouse and the gait lab')
  const scouts = teamFor('pizza')
  assert.deepEqual([scouts.kinds, scouts.lanes.map((l) => l.tag), scouts.scouting, scouts.goal], [SCOUTS, ['twin:1', 'tower:1'], true, 'pizza'])
  const counted = teamFor('send six agents')
  assert.deepEqual([counted.kinds, counted.lanes.length, counted.scouting], [SCOUTS, 6, true], 'a count with no desk is that many scouts')
  assert.equal(teamFor('0 agents').lanes.length, 1, 'never nobody')
  assert.equal(teamFor('zero agents').lanes.length, 2, 'a count the planner cannot read is no count: the scouts')
  for (const l of [...t.lanes, ...five.lanes, ...capped.lanes, ...scouts.lanes]) {
    assert.equal(l.caps, TEAM_CAPS)
    assert.equal(l.skill, deskOf(l.kind).skill)
    assert.equal(l.title, deskOf(l.kind).title)
  }
  // Frozen: a plan is data the host cannot bend.
  assert.ok(Object.isFrozen(t) && Object.isFrozen(t.lanes) && Object.isFrozen(t.lanes[0]))
})

test('the words the card shows: the label and the names read as plain speech; the brief lines and the console rows name the tag, the desk, the reading and the word', () => {
  const t = teamFor('Optimize the Lakefront Metro schedule and run a 24-agent warehouse robotics drill')
  assert.equal(teamLabel(t), 'Send 24 sub-agents to metro operations, the warehouse and the robotics lab')
  assert.equal(teamNames(teamFor('a triage drill')), 'the response centre and the robotics lab', 'in order of first mention')
  assert.equal(teamNames(teamFor('the clinic')), 'the gait lab')
  assert.equal(teamLabel(teamFor('one agent on compliance')), 'Send one sub-agent to the clearing floor')
  assert.equal(teamLabel(teamFor('pizza')), 'Send 2 scouts to the twin studio and the control tower')
  for (const goal of ['pizza', 'a triage drill', 'send 40 agents to the clinic', 'the metro schedule', ...Object.values(SAMPLE)]) {
    const team = teamFor(goal)
    assert.doesNotMatch(teamLabel(team), SYNTAX, goal)
    assert.doesNotMatch(teamNames(team), SYNTAX, goal)
    assert.doesNotMatch(teamLabel(team), /!/)
  }
  const lines = teamLines(teamFor('send 40 agents to the clinic'))
  assert.equal(lines.length, TEAM_MAX + 1)
  assert.equal(lines[0], '- **gait:1** at the gait lab: reads the people within 12 m of the lab door; holds move, workplace task')
  assert.equal(lines[TEAM_MAX], `- 8 more asked for than the ${TEAM_MAX}-lane cap allows: not sent`)
  const rows = teamRows(teamFor('send 40 agents to the clinic'))
  assert.equal(rows.length, TEAM_MAX + 1)
  assert.equal(rows[0], 'gait:1        at the gait lab: reads the people within 12 m of the lab door')
  assert.equal(rows[TEAM_MAX], lines[TEAM_MAX]!.slice(2))
})

test('every desk\'s probe compiles and runs under the lane limits on a city-sized table, each tick well inside the gas, printing one short reading', () => {
  const tables = city()
  const host = { tables: () => tables }
  for (const d of DESKS) {
    const lane = teamOf({ kinds: [d.id], count: null, at: 0, spans: [] }, d.id).lanes[0]!
    const spec = laneSpec(lane, { x: 12.5, z: -30 })
    assert.equal(spec.program, 'probe();')
    assert.equal(spec.tag, lane.tag)
    assert.equal(spec.role, d.title)
    const s = new NoirSession(LANE_LIMITS)
    const pre = s.run(spec.prelude, host)
    assert.equal(pre.error, undefined, `${d.id}: ${pre.error}`)
    assert.ok(pre.steps < 16, `${d.id}: the prelude declares, it does not run (${pre.steps} steps)`)
    let most = 0
    for (let t = 0; t < 400; t++) {
      const r = s.run(spec.program, host)
      assert.equal(r.error, undefined, `${d.id} tick ${t}: ${r.error}`)
      assert.equal(r.out.length, 1, `${d.id}: one reading a tick`)
      assert.ok(r.out[0]!.length > 0 && r.out[0]!.length <= 120, `${d.id}: ${r.out[0]}`)
      most = Math.max(most, r.steps)
    }
    assert.ok(most <= MAX_OPS_PER_TICK * 0.6, `${d.id}: ${most} steps a tick, more than six tenths of the gas`)
    assert.ok(most + pre.steps < MAX_OPS_PER_TICK, `${d.id}: the first tick (prelude and program) fits too`)
  }
})

test('a probe walks its window on each tick, so a desk\'s lanes between them cover the whole column, and the empty city reads as zeros', () => {
  const tables = city()
  const host = { tables: () => tables }
  const t = teamFor('a warehouse count with three agents')
  const starts: number[] = []
  for (const lane of t.lanes) {
    const spec = laneSpec(lane, { x: 0, z: 0 })
    const s = new NoirSession(LANE_LIMITS)
    s.run(spec.prelude, host)
    const rows = [0, 1, 2].map(() => Number(/from row (\d+)/.exec(s.run(spec.program, host).out[0]!)![1]))
    assert.deepEqual(rows, [lane.slice * WINDOW, lane.slice * WINDOW + WINDOW, lane.slice * WINDOW + 2 * WINDOW], lane.tag)
    starts.push(rows[0]!)
  }
  assert.deepEqual(starts, [0, 48, 96])
  // Near the origin on the grid: the people within 20 m are the ones a hand count finds in the same window.
  const spec = laneSpec(t.lanes[0]!, { x: 0, z: 0 })
  const s = new NoirSession(LANE_LIMITS)
  s.run(spec.prelude, host)
  const row = Math.ceil(5000 / WINDOW) * WINDOW
  let expect = 0
  for (let j = row; j < row + WINDOW; j++) if (tables.crowd.x[j]! ** 2 + tables.crowd.z[j]! ** 2 < 400) expect++
  assert.ok(expect > 0 && expect < WINDOW)
  for (let k = 0; k < row / WINDOW; k++) s.run(spec.program, host)
  assert.equal(s.run(spec.program, host).out[0], `people within 20 m ${expect} of ${WINDOW} from row ${row}`)
  // The empty city: every count 0, no error, no fault.
  const empty = new NoirSession(LANE_LIMITS)
  empty.run(spec.prelude, null)
  const e = empty.run(spec.program, null)
  assert.deepEqual([e.error, e.fault, e.out], [undefined, undefined, ['people within 20 m 0 of 0 from row 0']])
  // Ten thousand ticks never grow the arena: the probe is a fn, the cursor one global.
  const long = new NoirSession(LANE_LIMITS)
  long.run(spec.prelude, host)
  for (let k = 0; k < 10_000; k++) assert.equal(long.run(spec.program, host).error, undefined)
})

test('deterministic: the same goal gives the same team, lane for lane, and the same programs', () => {
  const goal = 'Optimize the Lakefront Metro schedule and run a 24-agent warehouse robotics drill'
  const a = teamFor(goal)
  const b = teamOf(scanWork(plainWords(goal)), goal)
  assert.deepEqual(a, b)
  assert.deepEqual(a.lanes.map((l) => laneSpec(l, { x: 1, z: 2 })), b.lanes.map((l) => laneSpec(l, { x: 1, z: 2 })))
  assert.notEqual(laneSpec(a.lanes[1]!, { x: 1, z: 2 }).prelude, laneSpec(a.lanes[1]!, null).prelude, 'the desk\'s place is in the prelude')
  assert.match(laneSpec(a.lanes[1]!, null).prelude, /let at_x = 0\.000; let at_z = 0\.000;/)
  assert.match(laneSpec(a.lanes[1]!, { x: Number.NaN, z: Number.POSITIVE_INFINITY }).prelude, /let at_x = 0\.000; let at_z = 0\.000;/, 'a place that is nowhere reads at the origin')
})

test('a goal the city already answers sends nobody: the shops, the workplaces and the wardrobe are pointed at, not scouted for; a home or company is still a gap', () => {
  const ROOT = 'That is already in the city; here is where to find it.'
  for (const g of ['where are the shops', 'buy a coat', 'go indoors', 'go inside a shop', 'change my outfit']) {
    const w = new FiveWhys(g)
    const b = w.brief()
    assert.equal(b.root, ROOT, g)
    assert.deepEqual(b.plan, [], g)
    assert.ok(b.unmapped.length > 0, g)
    assert.equal(w.next(), null, `${g}: no "I didn't catch that" after the answer`)
    assert.match(b.markdown, /## Already in the city/, g)
    assert.doesNotMatch(b.markdown, /## Not mapped/, g)
  }
  // A home of one's own is not in the city yet (the same note as a gap), nor is company: the scouts go.
  for (const g of ['go inside my house', 'enter a house', 'make friends']) {
    const b = new FiveWhys(g).brief()
    assert.match(b.root, /^Nothing in the city does that yet, so 2 scouts are on what it can do instead\.$/, g)
    assert.deepEqual(b.plan.map((s) => s.control), ['dispatch'], g)
    assert.match(b.markdown, /## Not mapped[^]*would touch `0[18]_/, g)
  }
  // Work named alongside a pointer still sends its team, with the pointer beside it.
  const both = new FiveWhys('send three agents to buy me a suit').brief()
  assert.deepEqual([both.plan.map((s) => s.control), both.unmapped.length], [['dispatch'], 1])
  // A pointer beside a real gap is a gap: the weather is not in the city.
  assert.match(new FiveWhys('go shopping in the snow').brief().root, /^Nothing in the city does that yet/)
})

test('"tasks" and "jobs" in a goal that names work are the work, not a wish for missions; alone, or beside "missions", the note stays', () => {
  const MISSIONS = 'Missions and scores: there are none; the city is a place, not a game to beat'
  for (const g of ['assign tasks at the warehouse', 'give the robotics lab some jobs', 'run warehouse tasks with six agents']) {
    const b = new FiveWhys(g).brief()
    assert.deepEqual(b.plan.map((s) => s.control), ['dispatch'], g)
    assert.ok(!b.unmapped.includes(MISSIONS), g)
  }
  for (const g of ['give me some tasks', 'any missions or tasks here', 'missions at the warehouse']) {
    assert.ok(new FiveWhys(g).brief().unmapped.includes(MISSIONS), g)
  }
  assert.equal(new FiveWhys('any missions or tasks here').brief().unmapped.filter((u) => u === MISSIONS).length, 1, 'one note a label')
})

test('the engine around the planner: a desk phrase wins over a bare unsupported word inside it, work words say nothing about Peak, a goal without a word sends nobody, and a team an answer names replaces the scouts', () => {
  // "the wind farms" is the microgrid, not the weather; "a green house" the greenhouse, not going indoors.
  for (const [g, desk] of [['the wind farms', 'the microgrid room'], ['a green house', 'the greenhouse'], ['flight paths over the city', 'the control tower']] as const) {
    const b = new FiveWhys(g).brief()
    assert.deepEqual([b.plan.map((s) => s.label), b.unmapped.length], [[`Send one sub-agent to ${desk}`], 0], g)
  }
  // "a battery swap drill" is the fleet bay's, not the heat and battery rule's: Peak is still Sloane's question.
  assert.deepEqual(classify('peak graphics and a battery swap drill').map((c) => [c.control, c.value]), [['dispatch', 2], ['quality', undefined]])
  // Nothing but punctuation: no scouts, the redirect question.
  const blank = new FiveWhys('???')
  assert.ok(blank.next() !== null)
  assert.ok(blank.brief().plan.every((s) => s.control !== 'dispatch'))
  // Scouts for a goal nothing mapped; an answer naming work replaces them, an answer naming a control sends them back.
  const named = new FiveWhys('pizza')
  assert.equal(named.brief().plan[0]!.label, 'Send 2 scouts to the twin studio and the control tower')
  named.answer('a warehouse drill with four agents')
  assert.deepEqual(named.brief().plan.map((s) => s.label), ['Send 4 sub-agents to the warehouse and the robotics lab'])
  const knob = new FiveWhys('pizza')
  knob.answer('make it night')
  assert.ok(knob.brief().plan.every((s) => s.control !== 'dispatch'))
})
