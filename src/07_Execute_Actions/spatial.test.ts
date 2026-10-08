// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the spatial harness (spatial.ts, harness.ts `spatial`) on the real city. The plan
 * comes from the seed alone and reaches every district, the shore, the pier and six kinds of street; each probe starts
 * where an agent may stand, and the plan steps around a pole or a tree planted in its way. The crowd check finds every
 * kind of breach it is meant to (inside a lot, in the lake, past the city, not finite, off the zebras) and nothing
 * else, and every verdict holds its line. Then the product's own harness runs in real Rapier on the whole generated
 * city (the physics realm as the worker runs it, with a stand-in crowd whose positions are injected): it passes. And
 * agents injected where a fault was planted catch it, and the whole harness fails on that fault alone: a building
 * left without its collider is walked into, a seawall left out lets a run go on into the lake, a pier without its
 * deck is walked under, a car's lane walled off stops it, a crowd with someone in a lot fails.
 * What breaks if it is removed? The harness could pass a city it should fail, or fail the real one, and the only sign
 * would be an operator's console.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CITY, CITY_SIZE, LAKE, districtOfLot, generateBuildings, streetFurniture, type Box, type Furniture } from '../01_Initialize_World/city.ts'
import { TRAFFIC } from '../02_Define_The_Rules/civic.ts'
import { onRoad } from '../03_Spawn_Agents/skills.ts'
import { MAX_CARS, type CrowdReadout, type CrowdSensor, type CrowdStepInput } from '../03_Spawn_Agents/crowdSensor.ts'
import type { SipocSnapshot } from '../05_Observe_Environment/telemetry.ts'
import { injectCar, injectWalk, runHarness } from './harness.ts'
import type { SimControls } from './operator.ts'
import { SimCore } from './simCore.ts'
import { MODES, PERSON, POSE, type SimCommand } from './simProtocol.ts'
import {
  CAR_DRIFT, CAR_TURN, checkCrowd, clearPath, crowdFailures, faceAlongZ, judgeCar, judgeLanding, judgeWalk, OFF_CROSSWALK_SHARE, offCrosswalk, planCity, SKIN,
  spatialPlan, STOP_TOLERANCE, streetFailures, STREETS_SKIPPABLE, type CarProbe, type CrowdFinding, type WalkProbe,
} from './spatial.ts'

const H = 1 / 60
const SEED = 1337
const AGENTS = 512
const IDLE = { steer: 0, fwd: 0, back: 0, handbrake: false }

/** A crowd standing on the sidewalks' lanes (in line with the north-south streets), as crowd.wgsl keeps it. */
function laneCrowd(n: number, seed = 7): Float32Array {
  const xz = new Float32Array(n * 2).fill(Number.NaN)
  let s = seed
  const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  for (let i = 1; i < n; i++) {
    const k = Math.floor(rand() * (CITY.blocks + 1))
    xz[2 * i] = k * CITY.pitch + (rand() < 0.5 ? -1 : 1) * CITY.lane
    xz[2 * i + 1] = -6 + rand() * (CITY_SIZE + 12)
  }
  return xz
}

/** The GPU crowd's contract, standing in: no hazards, no flags; `xz` is what the harness reads as the crowd. */
class StandInCrowd implements CrowdSensor {
  readonly agentCount: number
  readonly lost = null
  readout: CrowdReadout | null = null
  xz: Float32Array
  constructor(xz: Float32Array) {
    this.agentCount = xz.length / 2
    this.xz = xz
  }
  step(input: CrowdStepInput): void {
    this.readout = {
      seq: input.seq, time: input.time - input.dt, hazardsAhead: new Float32Array(MAX_CARS).fill(Infinity), hazardsBehind: new Float32Array(MAX_CARS).fill(Infinity),
      stats: { nudges: 0, waiting: 0, crossing: 0, retreating: 0 }, xz: this.xz, activity: new Uint8Array(this.agentCount),
    }
  }
  takeFlags(): number { return 0 }
  takeFrame(): Float32Array | null { return null }
  recycle(): void {}
}

/**
 * The physics realm on the real city of `SEED` (minus whatever `drop` leaves out of the colliders), driven as the
 * engine drives it, and SimControls over it as the engine builds them: commands queued for the next step, the walk
 * held for its time, the positions the crowd reads.
 */
async function realCity(o: { drop?: (b: Box) => boolean; extra?: Box[]; crowd?: Float32Array; cars?: number } = {}) {
  const boxes = [...generateBuildings(SEED).map((b) => b.box).filter((b) => !o.drop?.(b)), ...(o.extra ?? [])]
  const furniture: Furniture = streetFurniture(SEED)
  const crowd = new StandInCrowd(o.crowd ?? laneCrowd(AGENTS))
  const sim = await SimCore.create({ seed: SEED, cars: o.cars ?? 3, agents: crowd.agentCount, boxes, furniture, spawn: { x: 325.8, z: 332 }, debug: false }, async () => crowd)
  const poses = new Float32Array(sim.meta.count * POSE.stride)
  const cmds: SimCommand[] = []
  const walk = { x: 0, z: 0, until: -1 }
  let clock = 0
  let state: ReturnType<SimCore['step']> = sim.step({ dt: H, foot: { x: 0, z: 0, heading: 0 }, drive: IDLE, cmds: [] }, poses)
  const step = () => {
    const on = clock < walk.until
    state = sim.step({ dt: H, foot: { x: on ? walk.x : 0, z: on ? walk.z : 0, heading: 0 }, drive: IDLE, cmds: cmds.splice(0) }, poses)
    clock += H * 1000
  }
  const sleep = async (ms: number) => { for (let t = 0; t < ms; t += H * 1000) step() }
  const controls = {
    clock: { hours: () => 12, set: () => {} },
    quality: { state: () => ({ tier: 3, label: 'High', auto: true, renderScale: 1, targetMs: 16.7 }), set: () => {} },
    avatar: {
      position: () => ({ x: state.avatar.x, z: state.avatar.z, heading: 0, feetY: state.avatar.feetY }),
      teleport: (x: number, z: number) => { cmds.push({ c: 'teleport', x, z }) },
      interact: () => { cmds.push({ c: 'interact' }) },
      walk: (vx: number, vz: number, ms = 1000) => {
        walk.x = vx
        walk.z = vz
        walk.until = vx === 0 && vz === 0 ? -1 : clock + Math.min(10_000, ms)
      },
    },
    vehicles: {
      count: () => sim.meta.count,
      state: (i: number) => {
        const p = i * POSE.stride
        return { x: poses[p + POSE.x], z: poses[p + POSE.z], heading: poses[p + POSE.heading], speed: poses[p + POSE.speed], mode: MODES[poses[p + POSE.mode]], suv: sim.meta.suv[i] }
      },
      setMode: (i: number, mode: 'ai' | 'parked') => { cmds.push({ c: 'setMode', i, mode }) },
      recover: (i: number, x?: number, z?: number, heading?: number) => { cmds.push({ c: 'recover', i, x, z, heading }) },
      intent: (i: number, throttle: number, brake: number, steer: number) => { cmds.push({ c: 'intent', i, throttle, brake, steer }) },
      nearest: () => -1,
    },
    physics: { tune: () => ({}), set: () => {} },
    shaders: { uniforms: () => ({}), set: () => {} },
    crowd: { stats: () => ({ drawnNear: 0, drawnFar: 0, nudges: 0, waiting: 0, crossing: 0, retreating: 0 }), cull: () => {}, positions: () => Float32Array.from(crowd.xz) },
    kernel: { stats: () => state.kernel, blindSensing: () => {} },
    snapshot: () => ({ process: { seed: SEED }, customer: { signalEW: 'green', signalNS: 'red' } }) as unknown as SipocSnapshot,
  } as unknown as SimControls
  return { sim, controls, sleep, state: () => state, crowd }
}

// ---------------------------------------------------------------- the plan

test('the plan: the same seed, the same plan; every district, the promenade, the pier and six streets, the new edges among them', () => {
  const plan = spatialPlan(SEED)
  assert.deepEqual(spatialPlan(SEED), plan)
  const count = (d: string) => plan.walks.filter((w) => w.district === d).length
  assert.deepEqual(['downtown', 'heritage', 'lakefront', 'park', 'promenade', 'pier'].map(count), [4, 4, 4, 4, 2, 3])
  assert.equal(plan.cars.length, 6)
  assert.ok(plan.cars.some((c) => Math.abs(c.z - CITY_SIZE) < 3), 'the lakeshore street, the grid edge the lake added')
  assert.ok(plan.cars.some((c) => Math.abs(c.x - CITY_SIZE) < 3), 'the east edge street')
  assert.notDeepEqual(spatialPlan(SEED + 1).walks.slice(0, 2), plan.walks.slice(0, 2), 'another seed, other lots')
})

test('the plan: every probe starts where an agent may stand, runs into a real face, and every car is in its lane', () => {
  const plan = spatialPlan(SEED)
  const r = PERSON.radius
  for (const w of plan.walks) {
    const [x, z] = w.from
    if (w.district === 'pier') {
      assert.ok(Math.abs(x - LAKE.pier.x) < LAKE.pier.halfWidth - 0.2 - r && z >= LAKE.shore - 5 && z <= LAKE.shore + LAKE.pier.length, w.what)
      continue
    }
    assert.ok(!onRoad(x, z), `${w.what}: off the carriageway`)
    if (w.district === 'promenade') {
      assert.ok(z > CITY_SIZE + CITY.roadHalf && z < LAKE.shore, w.what)
      continue
    }
    // On the sidewalk band of a lot's street side (clear of the kerb and of the lot by the body's radius), in that
    // lot's district.
    const kerb = Math.abs(z - Math.round(z / CITY.pitch) * CITY.pitch)
    assert.ok(kerb >= CITY.roadHalf + r && kerb <= CITY.pitch / 2 - CITY.lotHalf - r, `${w.what}: ${kerb} m from its street's centreline`)
    const k = Math.floor(x / CITY.pitch), m = Math.floor(z / CITY.pitch)
    assert.equal(districtOfLot(k, m), w.district, w.what)
    if (w.stop !== null) assert.ok(w.stop > 0 && w.stop < CITY.pitch / 2, `${w.what}: a face within the lot (${w.stop})`)
    else assert.ok(w.min > 4, w.what)
  }
  for (const c of plan.cars) {
    assert.ok(onRoad(c.x, c.z), c.what)
    const off = [c.x - Math.round(c.x / CITY.pitch) * CITY.pitch, c.z - Math.round(c.z / CITY.pitch) * CITY.pitch]
    const along = Math.abs(Math.sin(c.heading)) > 0.5 ? off[1] : off[0]
    assert.ok(Math.abs(Math.abs(along) - TRAFFIC.laneOffset) < 1e-9, `${c.what}: ${TRAFFIC.laneOffset} m from its centreline`)
  }
})

test("the plan's geometry: a run meets the nearest face across its whole capsule, not a step or a cornice; a corner is not square", () => {
  const r = PERSON.radius
  const top = PERSON.halfHeight * 2 + PERSON.radius * 2
  const stop = (z: number) => z - r - SKIN
  const wall = (z0: number, z1: number, x0 = -10, x1 = 10, y0 = 0, y1 = 10): Box => [x0, y0, z0, x1, y1, z1]
  assert.deepEqual(faceAlongZ([wall(4, 9)], 0, 0, 1, 20), { stop: stop(4), square: true })
  assert.deepEqual(faceAlongZ([wall(-9, -4)], 0, 0, -1, 20), { stop: stop(4), square: true }, 'running -z, the face is the far side')
  assert.equal(faceAlongZ([wall(4, 6), wall(9, 12)], 0, 0, 1, 20)?.stop, stop(4), 'the nearer face, whichever is listed first')
  assert.equal(faceAlongZ([wall(9, 12), wall(4, 6)], 0, 0, 1, 20)?.stop, stop(4))
  assert.equal(faceAlongZ([wall(4, 9)], 0, 0, 1, 3), null, 'past the limit')
  assert.equal(faceAlongZ([wall(-9, -4)], 0, 0, 1, 20), null, 'behind the start')
  // Across the whole capsule: a box its edge meets is met, one just clear of it is not.
  assert.equal(faceAlongZ([wall(4, 9, r - 0.05, 10)], 0, 0, 1, 20)?.stop, stop(4))
  assert.equal(faceAlongZ([wall(4, 9, -10, -(r - 0.05))], 0, 0, 1, 20)?.stop, stop(4))
  assert.equal(faceAlongZ([wall(4, 9, r + 0.05, 10)], 0, 0, 1, 20), null)
  // Square: the face spans the capsule with 0.3 m to spare either side; with less it is a corner the run slides round.
  assert.equal(faceAlongZ([wall(4, 9, -(r + 0.31), r + 0.31)], 0, 0, 1, 20)?.square, true)
  assert.equal(faceAlongZ([wall(4, 9, -(r + 0.2), 10)], 0, 0, 1, 20)?.square, false)
  assert.equal(faceAlongZ([wall(4, 9, -10, r + 0.2)], 0, 0, 1, 20)?.square, false)
  // A step (the pier's deck, 0.3 m) is walked onto and a cornice clears the head: neither stops a run; a lintel does.
  assert.equal(faceAlongZ([wall(2, 3, -10, 10, 0, 0.3), wall(4, 9)], 0, 0, 1, 20)?.stop, stop(4))
  assert.equal(faceAlongZ([wall(2, 3, -10, 10, top + 0.01, 12), wall(4, 9)], 0, 0, 1, 20)?.stop, stop(4))
  assert.equal(faceAlongZ([wall(2, 3, -10, 10, top - 0.1, 12), wall(4, 9)], 0, 0, 1, 20)?.stop, stop(2))
})

test("the plan's clear path: a pole or a box within reach of the capsule closes it; a step does not", () => {
  const a = [0, 0] as const, b = [10, 0] as const
  assert.equal(clearPath([], [], a, b, 0.4), true)
  assert.equal(clearPath([], [[5, 0.5]], a, b, 0.4), false, 'a lamp 0.5 m off the line')
  assert.equal(clearPath([], [[5, 0.65]], a, b, 0.4), true, "one 0.65 m off it (past the clearance and a pole's own 0.2 m)")
  assert.equal(clearPath([[4, 0, 0.3, 6, 3, 2]], [], a, b, 0.4), false, 'a wall 0.3 m off the line')
  assert.equal(clearPath([[4, 0, 0.5, 6, 3, 2]], [], a, b, 0.4), true)
  assert.equal(clearPath([[4, 0, -1, 6, 0.3, 1]], [], a, b, 0.4), true, 'a step across it is walked over')
  assert.equal(clearPath([[11, 0, -1, 13, 3, 1]], [], a, b, 0.4), true, 'a wall past its end')
})

test('the plan steps around what is planted in its way: a tree on a sidewalk run, a pole before a face, a tree in a park run', () => {
  const city = planCity(SEED)
  const plan = spatialPlan(SEED, city)
  assert.deepEqual(spatialPlan(SEED), plan, "the seed's own city unless one is given")
  const plant = (p: readonly [number, number]) => spatialPlan(SEED, { boxes: city.boxes, poles: [...city.poles, p] })
  // A tree on the first downtown sidewalk run: that lot is passed over for another.
  const side = plan.walks.find((w) => w.district === 'downtown' && w.stop === null)!
  const moved = plant([side.from[0] + 4, side.from[1]])
  assert.ok(!moved.walks.some((w) => w.what === side.what), side.what)
  assert.equal(moved.walks.filter((w) => w.district === 'downtown').length, 4, 'another lot instead')
  // A pole between the first heritage run and its face: the run moves along the lot to a clear face.
  const wall = plan.walks.find((w) => w.district === 'heritage' && w.stop !== null)!
  const pole = [wall.from[0], wall.from[1] + wall.dir[1] * 0.8] as const
  const shifted = plant(pole).walks.filter((w) => w.district === 'heritage' && w.stop !== null)
  assert.ok(!shifted.some((w) => w.what === wall.what), wall.what)
  assert.ok(shifted.some((w) => w.from[1] === wall.from[1] && Math.abs(w.from[0] - pole[0]) > 1), 'the same lot, clear of the pole')
  // A tree 3 m into the first park run: the run moves over.
  const park = plan.walks.find((w) => w.district === 'park' && w.dir[0] === 0)!
  const around = plant([park.from[0], park.from[1] + park.dir[1] * 3]).walks.filter((w) => w.district === 'park' && w.dir[0] === 0)
  assert.ok(!around.some((w) => w.what === park.what), park.what)
  assert.equal(around.length, 2)
})

// ---------------------------------------------------------------- the crowd check

test('the crowd check finds each breach it is meant to, and nothing in a crowd on its lanes and zebras', () => {
  const ok = checkCrowd(laneCrowd(4000))
  assert.deepEqual([ok.inLot, ok.outside, ok.nonFinite], [0, 0, 0])
  assert.equal(ok.offCrosswalk, 0, 'lane points in line with a street cross the other streets on its zebra')
  assert.equal(ok.measured, 3999)
  const bad = new Float32Array([
    0, 0, // the player's own body: never judged
    20, 20, // the middle of lot (0, 0)
    320, 700, // in the lake
    -20, 100, // west of the city
    Number.POSITIVE_INFINITY, 5, // not finite
    Number.NaN, Number.NaN, // not placed yet
    330, 1, // on the road mid-block
    325.8, 1, // on the zebra across the east-west road
    320 - CITY.lane, 60, // on its sidewalk lane
  ])
  const f = checkCrowd(bad)
  assert.deepEqual([f.measured, f.unplaced, f.inLot, f.outside, f.nonFinite, f.offCrosswalk], [7, 1, 1, 2, 1, 1])
  assert.ok(f.examples.some((e) => /agent 1 .*inside a lot/.test(e)))
  assert.ok(f.examples.some((e) => /agent 2 .*in the lake/.test(e)))
  assert.ok(f.examples.some((e) => /agent 3 .*outside the city/.test(e)))
  assert.equal(offCrosswalk(320, 320), true, 'the middle of an intersection is no zebra')
  assert.equal(offCrosswalk(320 + 5.8, 320 + 5.8), false, 'a sidewalk corner is no carriageway')
  // The zebras across both axes, with 0.3 m to spare at either end of the band; the carriageway beyond them.
  const [za, zb] = TRAFFIC.crosswalk
  for (const [x, z] of [[320 + za - 0.2, 321], [321, 320 + za - 0.2], [320 - zb - 0.2, 319], [319, 320 - zb - 0.2]]) {
    assert.equal(offCrosswalk(x, z), false, `${x}, ${z}: on a zebra`)
  }
  for (const [x, z] of [[320 + za - 0.5, 321], [321, 320 + za - 0.5], [320 + zb + 0.5, 321], [321, 320 + zb + 0.5]]) {
    assert.equal(offCrosswalk(x, z), true, `${x}, ${z}: off it`)
  }
  // The containment's own margins: the push-out pad around a lot, the clamp past the outer streets.
  const pad = 20 + CITY.lotHalf
  const edge = checkCrowd(new Float32Array([0, 0, pad + 0.2, 20, pad + 0.4, 20, -6.6, 100, -6.4, 100, 100, CITY_SIZE + 6.6, 100, CITY_SIZE + 6.4]))
  assert.deepEqual([edge.measured, edge.inLot, edge.outside], [6, 1, 2])
  // Readings add up.
  const acc = { counts: { measured: 0, unplaced: 0, inLot: 0, outside: 0, nonFinite: 0, offCrosswalk: 0 }, examples: [] as string[] }
  checkCrowd(bad, acc)
  const twice = checkCrowd(bad, acc)
  assert.deepEqual([twice.measured, twice.inLot], [14, 2])
})

// ---------------------------------------------------------------- the verdicts

test('the verdicts: a walk judged where it ended, a car where it stopped, the crowd and the streets over the sweep; nothing not finite passes', () => {
  const free: WalkProbe = { district: 'downtown', what: 'free', from: [10, 20], dir: [1, 0], seconds: 2, min: 8.8, stop: null, feet: null }
  const face: WalkProbe = { ...free, what: 'face', dir: [0, 1], min: 0, stop: 3.5 }
  const deck: WalkProbe = { ...free, what: 'deck', dir: [0, 1], min: 25, feet: 0.3 }
  const at = (x: number, z: number, feetY = 0) => ({ x, z, feetY })
  // Landed within 0.3 m of the start.
  assert.equal(judgeLanding(free, at(10.2, 20.2)), null)
  assert.equal(judgeLanding(free, at(10.3, 20.3)), 'free: landed at (10.3, 20.3), not at (10.0, 20.0): something stands on the spot')
  assert.notEqual(judgeLanding(free, at(Number.NaN, 20)), null)
  // A free run: at least `min` along its direction (sideways does not count).
  assert.equal(judgeWalk(free, at(18.8, 20)), null)
  assert.equal(judgeWalk(free, at(18.7, 20)), 'free: got 8.7 m of the 8.8 m it must get through (stopped at 18.7, 20.0)')
  assert.match(judgeWalk(free, at(10, 40)) ?? '', /^free: got 0\.0 m/)
  // A run into a face: within the tolerance either side; past it, into the geometry.
  assert.equal(judgeWalk(face, at(10, 23.64)), null)
  assert.equal(judgeWalk(face, at(10, 23.36)), null)
  assert.equal(judgeWalk(face, at(10, 23.66)), `face: stopped 3.66 m in, expected 3.50 m (± ${STOP_TOLERANCE}): it went into the geometry`)
  assert.equal(judgeWalk(face, at(10, 23.34)), `face: stopped 3.34 m in, expected 3.50 m (± ${STOP_TOLERANCE})`)
  // The feet: on the deck within 8 cm, on the ground within 12 cm.
  assert.equal(judgeWalk(deck, at(10, 45, 0.37)), null)
  assert.equal(judgeWalk(deck, at(10, 45, 0.21)), 'deck: feet at 0.21 m, expected the deck at 0.30 m')
  assert.equal(judgeWalk(free, at(18.8, 20, 0.11)), null)
  assert.equal(judgeWalk(free, at(18.8, 20, 0.13)), 'free: feet at 0.13 m, expected the ground')
  assert.equal(judgeWalk(free, at(18.8, 20, -0.13)), 'free: feet at -0.13 m, expected the ground')
  for (const p of [free, face, deck]) assert.notEqual(judgeWalk(p, at(Number.NaN, Number.NaN)), null, p.what)
  assert.notEqual(judgeWalk(face, at(10, 23.5, Number.NaN)), null)
  assert.notEqual(judgeWalk(deck, at(10, 45, Number.NaN)), null)
  // A car: at least `min` on along its heading, within CAR_DRIFT of its line, turned no more than CAR_TURN.
  const car: CarProbe = { district: 'downtown', what: 'car', x: 100, z: 50, heading: 0, seconds: 2.5, min: 8 }
  const end = (x: number, z: number, heading = 0) => judgeCar(car, { x, z, heading })
  assert.deepEqual(end(100, 58), { along: 8, lateral: 0, turned: 0, failure: null })
  assert.equal(end(100, 57.9).failure, 'car: 7.9 m on (at least 8), 0.00 m off its line, turned 0.00 rad')
  assert.equal(end(100 + CAR_DRIFT - 0.01, 60).failure, null)
  assert.match(end(100 + CAR_DRIFT + 0.01, 60).failure ?? '', /0\.81 m off its line/)
  assert.match(end(100 - CAR_DRIFT - 0.01, 60).failure ?? '', /0\.81 m off its line/)
  assert.equal(end(100, 60, CAR_TURN - 0.01).failure, null)
  assert.match(end(100, 60, -(CAR_TURN + 0.01)).failure ?? '', /turned 0\.11 rad/)
  assert.equal(end(100, 60, 2 * Math.PI + 0.05).failure, null, 'round once is no turn')
  assert.notEqual(end(Number.NaN, 60).failure, null)
  assert.notEqual(end(100, 60, Number.NaN).failure, null)
  // The streets: each failure, and no more than STREETS_SKIPPABLE left undriven for traffic.
  assert.deepEqual(streetFailures(6 - STREETS_SKIPPABLE, 6, []), [])
  assert.deepEqual(streetFailures(5 - STREETS_SKIPPABLE, 6, []), [`only ${5 - STREETS_SKIPPABLE} of 6 streets driven: traffic kept more than ${STREETS_SKIPPABLE} lanes busy`])
  assert.deepEqual(streetFailures(6, 6, ['car: 1.0 m on']), ['car: 1.0 m on'])
  // The crowd over the sweep's readings.
  const held: CrowdFinding = { measured: 1000, unplaced: 111, inLot: 0, outside: 0, nonFinite: 0, offCrosswalk: 20, examples: [] }
  assert.deepEqual(crowdFailures(held, 3), [])
  assert.deepEqual(crowdFailures(held, 1), ['the crowd gave fewer than two readings'])
  assert.deepEqual(crowdFailures({ ...held, unplaced: 200 }, 3), ['only 83 % of the crowd had a position'])
  assert.deepEqual(crowdFailures({ ...held, measured: 0, unplaced: 0, offCrosswalk: 0 }, 3), ['only 0 % of the crowd had a position'])
  assert.deepEqual(crowdFailures({ ...held, inLot: 1, outside: 1, nonFinite: 1 }, 3), ["3 found outside the crowd's containment"])
  assert.deepEqual(crowdFailures({ ...held, offCrosswalk: 21 }, 3), [`2.10 % on a carriageway off the zebras (at most ${OFF_CROSSWALK_SHARE * 100} %)`])
})

// ---------------------------------------------------------------- the harness on the real city

test('the spatial harness passes on the whole generated city in real Rapier, and puts the avatar and the car back', async () => {
  const { controls, sleep, state } = await realCity()
  const home = controls.avatar.position()
  // The car it borrows (the highest-numbered one an AI drives): everywhere it was until then, and every move of it.
  const spare = controls.vehicles.count() - 1
  const was: { x: number; z: number }[] = []
  const moves: { x?: number; z?: number }[] = []
  const recover = controls.vehicles.recover
  const where = () => {
    const c = controls.vehicles.state(spare)
    was.push({ x: c.x, z: c.z })
  }
  controls.vehicles.recover = (i, x, z, heading) => {
    if (i === spare) {
      if (moves.length === 0) where()
      moves.push({ x, z })
    }
    recover(i, x, z, heading)
  }
  const report = await runHarness('spatial', controls, async (ms) => {
    if (moves.length === 0) where()
    await sleep(ms)
  })
  assert.ok(report.pass, report.lines.join('\n'))
  assert.match(report.lines[0], /^crowd: 3 readings of 511 pedestrians: 0 inside a lot, 0 outside the city/)
  assert.ok(report.lines.some((l) => /^walks: 21 probes \(downtown 4, heritage 4, lakefront 4, park 4, promenade 2, pier 3\): every run got through or stopped at its face$/.test(l)), report.lines.join('\n'))
  assert.ok(report.lines.some((l) => /^cars: 6 of 6 streets driven: each went on in its lane/.test(l)), report.lines.join('\n'))
  await sleep(500)
  const back = controls.avatar.position()
  assert.ok(Math.hypot(back.x - home.x, back.z - home.z) < 0.5, 'the avatar is home')
  // The car was borrowed once per street and then put back where it had been driving (its spot free here).
  assert.equal(moves.length, spatialPlan(SEED).cars.length + 1, JSON.stringify(moves))
  const last = moves.at(-1)!
  assert.ok(was.some((p) => Math.hypot(p.x - last.x!, p.z - last.z!) < 1e-3), `put back at ${last.x}, ${last.z}: a place it was before`)
  assert.ok(!report.lines.some((l) => /left parked|could not put car/.test(l)), report.lines.join('\n'))
  assert.equal(state().kernel.audit.panic, null, 'the Ring-0 audit never tripped')
})

test('an agent run into a building left without its collider walks into it; one run at the seawall left out walks on into the lake', async () => {
  const plan = spatialPlan(SEED)
  const wall = plan.walks.find((w) => w.district === 'heritage' && w.stop !== null)!
  // The box that probe stops at, by the plan's own rule: the first face across its path.
  const face = (b: Box) => b[4] > 0.35 && b[1] < 1.8 && b[0] <= wall.from[0] - 0.3 && b[3] >= wall.from[0] + 0.3 &&
    Math.abs((wall.dir[1] > 0 ? b[2] - wall.from[1] : wall.from[1] - b[5]) - (wall.stop! + PERSON.radius + SKIN)) < 1e-6
  // (A heritage row can stand on a masonry base with the same face: both go.)
  assert.ok(generateBuildings(SEED).some((b) => face(b.box)), 'a box stops that probe')
  const holed = await realCity({ drop: face })
  const failed = await injectWalk(holed.controls, wall, holed.sleep)
  assert.match(failed ?? '', /went into the geometry|got .* of the/, failed ?? 'no failure')
  // The whole harness on that city fails on that walk alone.
  const report = await runHarness('spatial', holed.controls, holed.sleep)
  assert.equal(report.pass, false)
  assert.ok(report.lines.some((l) => /^walks: 21 probes .*: 1 failed$/.test(l)), report.lines.join('\n'))
  assert.ok(report.lines.some((l) => /^cars: 6 of 6 streets driven: each went on in its lane/.test(l)), report.lines.join('\n'))
  // The same probe on the whole city stops at the face.
  const whole = await realCity()
  assert.equal(await injectWalk(whole.controls, wall, whole.sleep), null)
  // A teleport that does not land where it was sent (something stood on the spot): the probe says so, and goes no
  // further.
  const side = plan.walks.find((w) => w.district === 'downtown' && w.stop === null)!
  const avatar = whole.controls.avatar
  const astray = { ...whole.controls, avatar: { ...avatar, teleport: (x: number, z: number, yaw?: number) => avatar.teleport(x + 0.5, z, yaw) } } as SimControls
  assert.match((await injectWalk(astray, side, whole.sleep)) ?? '', /^along the sidewalk of lot .*: landed at \(.*\), not at \(.*\): something stands on the spot$/)
  // The seawall: both of its halves left out of the colliders.
  const seawall = plan.walks.find((w) => w.district === 'promenade')!
  const open = await realCity({ drop: (b) => b[2] === LAKE.shore && b[5] === LAKE.shore + LAKE.wall.thickness && b[4] === LAKE.wall.height })
  assert.match((await injectWalk(open.controls, seawall, open.sleep)) ?? '', /went into the geometry/)
  assert.equal(await injectWalk(whole.controls, seawall, whole.sleep), null)
})

test("a pier left without its deck is walked out over the ground below it: the feet say so; a car's lane blocked stops it", async () => {
  const plan = spatialPlan(SEED)
  const out = plan.walks.find((w) => w.what.startsWith('onto the pier'))!
  const deckless = await realCity({ drop: (b) => b[4] === LAKE.pier.deck && b[1] === 0 && b[2] === LAKE.shore })
  assert.match((await injectWalk(deckless.controls, out, deckless.sleep)) ?? '', /feet at 0\.\d+ m, expected the deck at 0\.30 m/)
  // A car probe with a wall planted across its lane 6 m ahead: it does not get its 8 m.
  const probe = plan.cars[0]
  const fx = Math.sin(probe.heading), fz = Math.cos(probe.heading)
  const wx = probe.x + fx * 6, wz = probe.z + fz * 6
  const wall: Box = [wx - 3, 0, wz - 3, wx + 3, 2, wz + 3]
  const blocked = await realCity({ extra: [wall] })
  const failed = await injectCar(blocked.controls, probe, blocked.sleep)
  assert.match(failed ?? '', /m on \(at least 8\)/, String(failed))
  // The whole harness on that city fails on that street alone.
  const report = await runHarness('spatial', blocked.controls, blocked.sleep)
  assert.equal(report.pass, false)
  assert.ok(report.lines.some((l) => /^cars: 6 of 6 streets driven: 1 failed$/.test(l)), report.lines.join('\n'))
  assert.ok(report.lines.some((l) => /^walks: .*every run got through or stopped at its face$/.test(l)), report.lines.join('\n'))
  // The same probe on the whole city drives on, and its car goes back where it was.
  const clear = await realCity()
  const spare = clear.controls.vehicles.count() - 1
  const from = clear.controls.vehicles.state(spare)
  assert.equal(await injectCar(clear.controls, probe, clear.sleep), null, 'the same probe on the whole city drives on')
  await clear.sleep(50)
  const back = clear.controls.vehicles.state(spare)
  assert.ok(Math.hypot(back.x - from.x, back.z - from.z) < 1, `the car went back: ${JSON.stringify({ from, back })}`)
})

test('a car probe waits for its lane: with a car parked in it, it is skipped, not driven into it', async () => {
  const probe = spatialPlan(SEED).cars[0]
  const { controls, sleep } = await realCity()
  const last = controls.vehicles.count() - 1
  controls.vehicles.recover(last, probe.x + Math.sin(probe.heading) * 15, probe.z + Math.cos(probe.heading) * 15, probe.heading)
  controls.vehicles.setMode(last, 'parked')
  await sleep(200)
  assert.equal(await injectCar(controls, probe, sleep), 'skipped')
})

test('a crowd injected with someone inside a lot and someone in the lake fails the harness on the crowd alone, naming them', async () => {
  const xz = laneCrowd(AGENTS)
  xz[2 * 5] = 60; xz[2 * 5 + 1] = 100 // the middle of lot (1, 2)
  xz[2 * 9] = 400; xz[2 * 9 + 1] = 720 // out on the lake
  const { controls, sleep } = await realCity({ crowd: xz })
  const report = await runHarness('spatial', controls, sleep)
  assert.equal(report.pass, false)
  assert.match(report.lines[0], /^crowd: 3 readings of 511 pedestrians: 3 inside a lot, 3 outside the city/)
  assert.ok(report.lines.some((l) => /agent 5 at \(60\.0, 100\.0\): inside a lot/.test(l)))
  assert.ok(report.lines.some((l) => /agent 9 at \(400\.0, 720\.0\): in the lake/.test(l)))
  assert.ok(report.lines.includes("  6 found outside the crowd's containment"), report.lines.join('\n'))
  assert.ok(report.lines.some((l) => /^walks: .*every run got through or stopped at its face$/.test(l)), report.lines.join('\n'))
  assert.ok(report.lines.some((l) => /^cars: 6 of 6 streets driven: each went on in its lane/.test(l)), report.lines.join('\n'))
})

test('with no car to borrow the harness says so, and fails', async () => {
  const { controls, sleep } = await realCity({ cars: 0 })
  const report = await runHarness('spatial', controls, sleep)
  assert.equal(report.pass, false)
  assert.match(report.lines[0], /^crowd: 3 readings of 511 pedestrians: 0 inside a lot, 0 outside the city/)
  assert.ok(report.lines.some((l) => /^cars: no spare car/.test(l)), report.lines.join('\n'))
})
