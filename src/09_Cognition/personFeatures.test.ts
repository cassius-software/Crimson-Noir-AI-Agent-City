// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the per-person readings: the dictionary (ids, thresholds, every activity code of
 * the crowd kernel named once), each formula by hand, every lane in [0, 1] without NaN over seeded random and nasty
 * views, STUCK's history (stepping on the spot accrues it, a metre's progress clears it, standing and the activities
 * that are standing drain it, a long gap is credited as one second, a new crowd or a clock that went back starts
 * afresh), what someone was called away from, the neighbour count of the grid against a plain count over seeded
 * crowds, the sentence and the console rows, the honesty of personAbout and no banned word in anything printed. And it
 * runs the reading over the real crowd: crowd.wgsl on the CPU (crowdHost.ts) through the whole realm, so the frame
 * layout it reads (activity in pose.w, the speed in vel.w) is the kernel's own, not an assumption.
 * What breaks if it is removed? A reading could drift from its documentation, or read the wrong float of the frame,
 * and a held person's prompt would say they were doing something they were not.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { forAll, nastyNumber } from '../02_Define_The_Rules/property.ts'
import type { CrowdReadout } from '../03_Spawn_Agents/crowdSensor.ts'
import { ACTIVITY } from '../03_Spawn_Agents/skills.ts'
import {
  FRAME_FLOATS, NEAR_FULL, NEAR_RADIUS, OBSERVE_GAP_S, PERSON_FEATURES, PersonReadings, STUCK_FULL_M, STUCK_NAMED, STUCK_PACE, STUCK_RADIUS, STUCK_REST,
  describePerson, personAbout, personActivations, sparsifyPerson, type PersonView,
} from './personFeatures.ts'

// Vite's `?raw` import, for Node: the file as a default-exported string (the realm below runs crowd.wgsl itself).
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})

const IDS = PERSON_FEATURES.map((f) => f.id)
const lane = (id: string): number => IDS.indexOf(id)
const AT_REST: PersonView = Object.freeze({ activity: ACTIVITY.routine, speed: 0, spin: 0, near: 0, before: -1 })
const V = (over: Partial<PersonView>): PersonView => ({ ...AT_REST, ...over })
const read = (id: string, over: Partial<PersonView>): number => PERSON_FEATURES[lane(id)].read(V(over))
/** The words no console text may carry (common rules), spelled backwards here so this file carries none of them itself. */
const BANNED = new RegExp(['kcatta', 'llik', 'nopaew', 'tegrat', 'toohs', 'nug', 'ecneloiv', 'rujni', 'egamad'].map((w) => [...w].reverse().join('')).join('|'), 'i')
const ASCII = /^[\x20-\x7e]*$/

/** A crowd frame of `n` people: every pos, then every vel, then every pose, as the crowd kernel lays them out. */
function frameOf(people: readonly { x: number; z: number; speed?: number; activity?: number }[]): Float32Array {
  const n = people.length
  const f = new Float32Array(FRAME_FLOATS * n)
  people.forEach((p, i) => {
    f[4 * i] = p.x
    f[4 * i + 2] = p.z
    f[4 * n + 4 * i + 3] = p.speed ?? 0
    f[8 * n + 4 * i + 3] = p.activity ?? ACTIVITY.routine
  })
  return f
}

test('the dictionary: ten ids in order, thresholds in (0, 1), one lane per activity the crowd kernel names except the routine walk, frozen', () => {
  assert.deepEqual(IDS, ['STUCK', 'CROWDED', 'YIELDING', 'WAITING', 'CROSSING', 'SUMMONED', 'TALKING', 'WORKING', 'COMMUTING', 'PACE'])
  for (const f of PERSON_FEATURES) {
    assert.match(f.id, /^[A-Z][A-Z_]*$/)
    assert.ok(f.theta > 0 && f.theta < 1, f.id)
    assert.ok(f.doc.length > 0 && f.doc.length < 220, f.id)
    assert.ok(Object.isFrozen(f), f.id)
  }
  assert.ok(Object.isFrozen(PERSON_FEATURES))
  // Every activity code but the routine walk reads 1 in exactly one lane, and the routine walk in none.
  for (const [name, code] of Object.entries(ACTIVITY)) {
    const hot = PERSON_FEATURES.filter((f) => f.read(V({ activity: code })) === 1).map((f) => f.id)
    assert.equal(hot.length, name === 'routine' ? 0 : 1, `${name}: ${hot.join(', ')}`)
  }
  assert.equal(FRAME_FLOATS, 12)
})

test('the formulas, by hand', () => {
  assert.equal(read('STUCK', { spin: 0 }), 0)
  assert.equal(read('STUCK', { spin: STUCK_FULL_M / 2 }), 0.5)
  assert.equal(read('STUCK', { spin: 3 * STUCK_FULL_M }), 1)
  assert.equal(read('CROWDED', { near: 2 }), 2 / NEAR_FULL)
  assert.equal(read('CROWDED', { near: 40 }), 1)
  assert.equal(read('PACE', { speed: 1.5 }), 0.5)
  assert.equal(read('PACE', { speed: 9 }), 1)
  assert.equal(read('YIELDING', { activity: ACTIVITY.steppingBack }), 1)
  assert.equal(read('YIELDING', { activity: ACTIVITY.waiting }), 0)
  assert.equal(read('WORKING', { activity: ACTIVITY.working }), 1)
  assert.equal(read('SUMMONED', { activity: ACTIVITY.coming }), 1)
  assert.equal(read('TALKING', { activity: ACTIVITY.interviewing }), 1)
  assert.equal(read('COMMUTING', { activity: ACTIVITY.commuting }), 1)
  assert.equal(read('CROSSING', { activity: ACTIVITY.crossing }), 1)
  assert.equal(read('WAITING', { activity: -1 }), 0, 'no activity known reads no activity')
})

test('property: every lane reads in [0, 1], never NaN, over 2000 seeded views, nasty numbers among them; sparsify keeps or zeroes, never invents', () => {
  forAll('person lanes', { seed: 20261112, runs: 2000 }, (g) => V({
    activity: g.bool(0.2) ? nastyNumber(g) : g.int(-1, 9), speed: g.bool(0.2) ? nastyNumber(g) : g.float(0, 3),
    spin: g.bool(0.2) ? nastyNumber(g) : g.float(0, 20), near: g.bool(0.2) ? nastyNumber(g) : g.int(0, 30), before: g.int(-1, 7),
  }), (v) => {
    const acts = personActivations(v)
    assert.equal(acts.length, PERSON_FEATURES.length)
    for (const x of acts) assert.ok(x >= 0 && x <= 1, String(x))
    const sparse = sparsifyPerson(acts)
    for (let i = 0; i < acts.length; i++) assert.ok(sparse[i] === 0 || sparse[i] === acts[i])
    for (let i = 0; i < acts.length; i++) assert.equal(sparse[i] > 0, acts[i] > Math.fround(PERSON_FEATURES[i].theta), IDS[i])
  })
})

test('observe: a frame that is not one is refused and nothing is kept', () => {
  const p = new PersonReadings()
  assert.equal(p.observe(new Float32Array(11), 1, 0), false, 'too short for one person')
  assert.equal(p.observe(new Float32Array(24), 0, 0), false, 'no people')
  assert.equal(p.observe(new Float32Array(24), 1.5, 0), false, 'a part of a person')
  assert.equal(p.observe(new Float32Array(24), 2, Number.NaN), false, 'no clock')
  assert.equal(p.agents, 0)
  assert.equal(p.view(1), null)
  assert.deepEqual(p.crowdLines(), ['people: no reading yet (the crowd has sent no frame)'])
  assert.equal(p.crowd(), null)
})

test('STUCK: stepping on the spot accrues the metres stepped; a metre of progress clears them; standing drains them; a long gap counts as one second', () => {
  const p = new PersonReadings()
  const at = (x: number, speed: number, activity: number = ACTIVITY.routine) => frameOf([{ x: 0, z: 0 }, { x, z: 0, speed, activity }])
  assert.ok(p.observe(at(0, 1.5), 2, 0))
  assert.equal(p.view(1)!.spin, 0, 'a first frame starts afresh')
  p.observe(at(0.3, 1.5), 2, 0.25)
  assert.equal(p.view(1)!.spin, 1.5 * 0.25, 'within a metre while stepping: the step counts')
  p.observe(at(-0.3, 1.5), 2, 0.5)
  assert.equal(p.view(1)!.spin, 1.5 * 0.5)
  p.observe(at(0.9, 1.5), 2, 0.75)
  assert.equal(p.view(1)!.spin, 1.5 * 0.75, '0.9 m from where they stood is still on the spot')
  p.observe(at(1.1, 1.5), 2, 1)
  assert.equal(p.view(1)!.spin, 0, 'a metre or more from where they stood: progress, cleared, and the new place is where they stand')
  p.observe(at(1.6, 1.5), 2, 2)
  assert.equal(p.view(1)!.spin, 1.5, 'one second within a metre of the new place')
  p.observe(at(1.6, STUCK_PACE - 0.1), 2, 2.25)
  assert.equal(p.view(1)!.spin, 1.5 - STUCK_REST * 0.25, 'under the pace they are standing, and standing drains')
  p.observe(at(1.6, 0), 2, 60)
  assert.equal(p.view(1)!.spin, Math.max(0, 1.5 - STUCK_REST * 0.25 - STUCK_REST * OBSERVE_GAP_S), 'a minute away is credited as one second')
  for (let t = 61; t < 80; t++) p.observe(at(1.6, 3), 2, t)
  assert.equal(p.view(1)!.spin, 2 * STUCK_FULL_M, 'kept to twice what reads 1, so it drains in a few seconds')
  assert.equal(personActivations(p.view(1)!)[lane('STUCK')], 1)
})

test('STUCK is never read while standing is the activity: waiting at the kerb, working at a station, talking with the operator', () => {
  for (const activity of [ACTIVITY.waiting, ACTIVITY.working, ACTIVITY.interviewing]) {
    const p = new PersonReadings()
    for (let t = 0; t < 40; t++) p.observe(frameOf([{ x: 0, z: 0 }, { x: 0.1 * Math.sin(t), z: 0, speed: 1.2, activity }]), 2, t * 0.25)
    assert.equal(p.view(1)!.spin, 0, String(activity))
  }
  const walker = new PersonReadings()
  for (let t = 0; t < 40; t++) walker.observe(frameOf([{ x: 0, z: 0 }, { x: 0.1 * Math.sin(t), z: 0, speed: 1.2 }]), 2, t * 0.25)
  assert.ok(walker.view(1)!.spin > STUCK_FULL_M, 'the same steps on the routine walk read STUCK')
})

test('a new crowd size, or a clock that went back, starts every person afresh', () => {
  const p = new PersonReadings()
  const two = (x: number) => frameOf([{ x: 0, z: 0 }, { x, z: 0, speed: 2 }])
  p.observe(two(0), 2, 0)
  p.observe(two(0), 2, 1)
  assert.equal(p.view(1)!.spin, 2, 'a second at 2 m/s')
  p.observe(two(0), 2, 0.5)
  assert.equal(p.view(1)!.spin, 0, 'the clock went back')
  p.observe(two(0), 2, 1)
  assert.equal(p.view(1)!.spin, 1, 'half a second at 2 m/s')
  p.observe(frameOf([{ x: 0, z: 0 }, { x: 0, z: 0, speed: 2 }, { x: 5, z: 5 }]), 3, 2)
  assert.equal(p.agents, 3)
  assert.equal(p.view(1)!.spin, 0, 'another crowd')
})

test('what someone was called away from: kept from the frame they were called in, through coming over and talking, until they are let go', () => {
  const p = new PersonReadings()
  const doing = (activity: number) => frameOf([{ x: 0, z: 0 }, { x: 3, z: 3, activity }])
  p.observe(doing(ACTIVITY.working), 2, 0)
  assert.equal(p.view(1)!.before, -1, 'not called')
  p.observe(doing(ACTIVITY.coming), 2, 0.25)
  assert.equal(p.view(1)!.before, ACTIVITY.working)
  p.observe(doing(ACTIVITY.interviewing), 2, 0.5)
  assert.equal(p.view(1)!.before, ACTIVITY.working, 'coming over, then talking: still what they left')
  assert.equal(p.sentence(1), 'Talking with the player; before being called over, working at a station indoors.')
  p.observe(doing(ACTIVITY.routine), 2, 0.75)
  assert.equal(p.view(1)!.before, -1, 'let go')
  // Called in the very first frame: what came before is not known, and nothing is made up.
  const q = new PersonReadings()
  q.observe(doing(ACTIVITY.coming), 2, 0)
  assert.equal(q.view(1)!.before, -1)
  assert.equal(q.sentence(1), 'Coming over to the player.')
  // A code the page does not know (a newer kernel's, or not a whole number) is no activity, and says nothing.
  for (const code of [8, 2.5, Number.NaN, -3]) {
    const r = new PersonReadings()
    r.observe(doing(code), 2, 0)
    assert.equal(r.view(1)!.activity, -1, String(code))
    assert.equal(r.sentence(1), null, String(code))
  }
})

test('view: the player\'s own body, a stranger and a place that is not a number are nobody', () => {
  const p = new PersonReadings()
  p.observe(frameOf([{ x: 0, z: 0 }, { x: 1, z: 1 }, { x: Number.NaN, z: 0 }]), 3, 0)
  assert.equal(p.view(0), null, 'person 0 is the player')
  assert.equal(p.view(3), null)
  assert.equal(p.view(-1), null)
  assert.equal(p.view(1.5), null)
  assert.equal(p.view(2), null, 'not standing anywhere')
  assert.equal(p.lines(2), null)
  assert.equal(p.view(1)!.near, 0, 'the player and someone nowhere are not counted as close by')
})

test('property: the grid\'s neighbour count equals a plain count over every pair, on 60 seeded crowds, clusters, cell edges and nowheres among them', () => {
  forAll('crowd grid', { seed: 777, runs: 60 }, (g) => {
    const n = g.int(2, 260)
    const spread = g.pick([3, 12, 60, 400])
    return Array.from({ length: n }, () => ({
      x: g.bool(0.05) ? Number.NaN : g.bool(0.1) ? NEAR_RADIUS * g.int(-3, 3) : g.float(-spread, spread),
      z: g.bool(0.1) ? NEAR_RADIUS * g.int(-3, 3) : g.float(-spread, spread),
      speed: g.float(0, 3), activity: g.int(0, 7),
    }))
  }, (people) => {
    const p = new PersonReadings()
    assert.ok(p.observe(frameOf(people), people.length, 0))
    const c = p.crowd()!
    let measured = 0, crowded = 0
    for (let i = 1; i < people.length; i++) {
      const v = p.view(i)
      if (!v) continue
      measured++
      let near = 0
      for (let j = 1; j < people.length; j++) {
        if (j === i) continue
        const dx = Math.fround(people[j].x) - Math.fround(people[i].x), dz = Math.fround(people[j].z) - Math.fround(people[i].z)
        if (dx * dx + dz * dz < NEAR_RADIUS * NEAR_RADIUS) near++
      }
      assert.equal(v.near, near, `person ${i}`)
      if (personActivations(v)[lane('CROWDED')] > Math.fround(PERSON_FEATURES[lane('CROWDED')].theta)) crowded++
    }
    assert.equal(c.measured, measured)
    assert.equal(c.over[lane('CROWDED')], crowded)
    const waiting = people.filter((q, i) => i > 0 && Number.isFinite(q.x + q.z) && q.activity === ACTIVITY.waiting).length
    assert.equal(c.over[lane('WAITING')], waiting)
  })
})

test('the sentence and the rows: what they are doing, then stuck and crowded when over; a card per person; the crowd\'s shares with the stuck named', () => {
  assert.equal(describePerson(V({ activity: -1 })), null)
  assert.equal(describePerson(V({})), 'Walking the streets.')
  assert.equal(describePerson(V({ spin: STUCK_FULL_M, near: 3 })), 'Walking the streets; not getting anywhere for a while; 3 people within 2.5 m.')
  assert.equal(describePerson(V({ activity: -1, near: 150 })), '99 people within 2.5 m.')
  assert.equal(describePerson(V({ activity: ACTIVITY.steppingBack })), 'Stepping back from a car.')
  // Seven people: one walking on the spot (stuck) in a cluster, one walking somewhere, the rest at rest nearby.
  const p = new PersonReadings()
  for (let t = 0; t <= 40; t++) {
    p.observe(frameOf([
      { x: 0, z: 0 }, { x: 0.1 * Math.sin(t), z: 0, speed: 1.4 }, { x: t * 0.35, z: 0, speed: 1.4 }, { x: 0.5, z: 0.5, activity: t < 20 ? ACTIVITY.working : ACTIVITY.coming },
      { x: 1, z: 1, activity: ACTIVITY.waiting }, { x: 1.2, z: 0.8, activity: ACTIVITY.steppingBack }, { x: 30 + t * 0.35, z: 30, speed: 1.4 },
    ]), 7, t * 0.25)
  }
  assert.deepEqual(p.lines(1), [
    'person 1: Walking the streets; not getting anywhere for a while; 3 people within 2.5 m.',
    'STUCK                 [##########]  1.00',
    'PACE                  [#####.....]  0.47',
    'CROWDED               [####......]  0.38',
  ])
  assert.deepEqual(p.lines(3)![0], 'person 3: Coming over to the player; before being called over, working at a station indoors; 3 people within 2.5 m.')
  const rows = p.crowdLines()
  assert.equal(rows[0], 'people: 6 measured (person 0 is your own body)')
  assert.equal(rows.length, 1 + PERSON_FEATURES.length)
  assert.ok(rows.includes('STUCK                 [##........]  0.17  1: person 1'), rows.join('\n'))
  assert.ok(rows.includes('CROWDED               [#######...]  0.67  4'), rows.join('\n'))
  for (const r of [...rows, ...p.lines(1)!, ...p.lines(3)!]) assert.ok(ASCII.test(r) && r.length <= 120 && !BANNED.test(r), r)
})

test('the crowd names at most a handful of stuck people, lowest first, and counts the rest', () => {
  const people = [{ x: 0, z: 0 }, ...Array.from({ length: 9 }, (_, i) => ({ x: 10 * i, z: 0, speed: 1.4 }))]
  const p = new PersonReadings()
  for (let t = 0; t <= 40; t++) p.observe(frameOf(people), people.length, t * 0.25)
  const c = p.crowd()!
  assert.deepEqual(c.stuck, [1, 2, 3, 4, 5].slice(0, STUCK_NAMED))
  assert.equal(c.over[lane('STUCK')], 9)
  assert.ok(p.crowdLines().includes(`STUCK                 [##########]  1.00  9: person 1, 2, 3, 4, 5 and ${9 - STUCK_NAMED} more`))
})

test('personAbout: plain ASCII lines that say it moves nobody, is hand-written and is no learned dictionary; no banned word in any doc', () => {
  const lines = personAbout()
  assert.ok(lines.length >= 4 && lines.length <= 6)
  const all = lines.join(' ')
  assert.match(all, /It moves nobody/)
  assert.match(all, /hand-written, not learned/)
  assert.match(all, new RegExp(`${STUCK_RADIUS} m`))
  for (const l of lines) assert.ok(ASCII.test(l) && l.length <= 120 && !BANNED.test(l), l)
  for (const f of PERSON_FEATURES) assert.ok(ASCII.test(f.doc) && !BANNED.test(f.doc), f.id)
})

test('the module reads the crowd and never writes it: no import of the crowd\'s simulation, no buffer, no message to the realm', () => {
  const src = readFileSync(new URL('./personFeatures.ts', import.meta.url), 'utf8')
  const imports = [...src.matchAll(/^import .* from '([^']+)'$/gm)].map((m) => m[1]).sort()
  assert.deepEqual(imports, ['../03_Spawn_Agents/crowdSensor.ts', '../03_Spawn_Agents/skills.ts', './features.ts'])
  assert.doesNotMatch(src.replace(/^\s*(\/\/|\*).*$/gm, ''), /GPUBuffer|createBuffer|postMessage|\.send\(|\.place\(|\.routeTo\(|summons/)
})

test('the engine: the readings are read from the crowd frame beside the positions it copies, before the frame goes back, and go to the operator tier and a held person\'s context; nothing else uses them', () => {
  const engine = readFileSync(new URL('../07_Execute_Actions/engine.ts', import.meta.url), 'utf8')
  assert.match(engine, /^ {2}private readonly people = new PersonReadings\(\)$/m)
  const copy = engine.slice(engine.indexOf('if (s.crowdFrame && now - this.crowdCopiedAt >= CROWD_COPY_MS) {'), engine.indexOf('this.crowdCopiedAt = now'))
  assert.match(copy, /this\.people\.observe\(frame, n, s\.simTime\)/, 'in the copy block, at its pace')
  assert.ok(engine.indexOf('this.people.observe(') < engine.indexOf('if (s.crowdFrame && this.crowd.upload(s.crowdFrame))'), 'before the upload hands the frame back to the worker')
  assert.match(engine, /doing: this\.people\.sentence\(agent\)/)
  assert.match(engine, /awareness: this\.awareness\(\), people: this\.people,/)
  const uses = [...engine.matchAll(/this\.people\.(\w+)/g)].map((m) => m[1]).sort()
  assert.deepEqual(uses, ['observe', 'sentence'], 'the engine itself only feeds it and asks for a sentence')
})

test('over the real crowd: crowd.wgsl on the CPU through the realm; every person\'s activity and place read where the kernel writes them, every lane in range, nobody stuck', async (t) => {
  const { CITY, generateCity, streetFurniture } = await import('../01_Initialize_World/city.ts')
  const { SimCore } = await import('../07_Execute_Actions/simCore.ts')
  const { CrowdHost } = await import('../03_Spawn_Agents/crowdHost.ts')
  const { RENDER_FLOATS } = await import('../03_Spawn_Agents/crowdCompute.ts')
  const { POSE } = await import('../07_Execute_Actions/simProtocol.ts')
  assert.equal(FRAME_FLOATS, RENDER_FLOATS, 'the frame this reads is the crowd\'s own render frame')
  const AGENTS = 300, SEED = 11, DT = 1 / 60
  let host: InstanceType<typeof CrowdHost> | null = null
  const core = await SimCore.create(
    { seed: SEED, cars: 8, agents: AGENTS, boxes: generateCity(SEED), furniture: streetFurniture(SEED), spawn: { x: CITY.pitch * 8 + 20, z: CITY.pitch * 8 - CITY.lane }, debug: false, tracks: true, craft: false, ragdoll: false },
    async (agents, grid, streets, rooms) => (host = new CrowdHost(agents, grid, streets, rooms, { latency: 1 })),
  )
  // Assigned inside the factory, which the compiler cannot follow: said once, here.
  const twin = host as InstanceType<typeof CrowdHost> | null
  assert.ok(twin)
  const poses = new Float32Array(8 * POSE.stride)
  const idle = { dt: DT, foot: { x: 0, z: 0, heading: Number.NaN }, drive: { steer: 0, fwd: 0, back: 0, handbrake: false }, cmds: [] }
  const p = new PersonReadings()
  const seen = new Set<number>()
  let frames = 0, worstStuck = 0, worstCrowded = 0, yielding = 0
  for (let tick = 1; tick <= 900; tick++) {
    const st = core.step(idle, poses)
    assert.equal(core.halted, false)
    if (tick % 15 !== 0 || !st.crowdFrame) continue
    const reading: CrowdReadout = twin.readout!
    const frame = Float32Array.from(st.crowdFrame)
    assert.ok(p.observe(frame, AGENTS, reading.time))
    frames++
    for (let i = 1; i < AGENTS; i++) {
      const v = p.view(i)!
      assert.ok(v, `person ${i}`)
      assert.equal(v.activity, reading.activity[i], `person ${i}: the activity is the kernel's pose.w, as the realm decodes it`)
      seen.add(v.activity)
      for (const x of personActivations(v)) assert.ok(x >= 0 && x <= 1)
      assert.ok(Number.isFinite(v.speed) && v.speed <= 3 && Number.isFinite(v.spin) && v.near >= 0)
    }
    const c = p.crowd()!
    assert.equal(c.measured, AGENTS - 1)
    worstStuck = Math.max(worstStuck, c.over[lane('STUCK')])
    worstCrowded = Math.max(worstCrowded, c.over[lane('CROWDED')])
    yielding += c.over[lane('YIELDING')]
  }
  t.diagnostic(`${frames} frames of ${AGENTS - 1} people over 15 s: most reading STUCK at once ${worstStuck}, most CROWDED at once ${worstCrowded}, YIELDING person-frames ${yielding}; activities seen ${[...seen].sort().join(', ')}`)
  assert.equal(frames, 60)
  assert.ok(seen.has(ACTIVITY.routine) && seen.size >= 2, `activities seen: ${[...seen].join(', ')}`)
  // The soak finds nobody pinned on a car in this city (crowdSoak.test.ts); the reading agrees within one person.
  assert.ok(worstStuck <= 1, `at most one person read STUCK at once over 15 s of 299 (${worstStuck})`)
  // Every person has a sentence: the kernel names an activity this page knows for each of them.
  for (let i = 1; i < AGENTS; i++) assert.equal(typeof p.sentence(i), 'string', `person ${i}`)
})
