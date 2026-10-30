// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It soaks the whole realm with the shipped pedestrians: SimCore over the real city
 * (its buildings and furniture), the Rapier fleet on its tracks, the Sanctuary, the Ring-0 audit, and crowd.wgsl
 * itself run on the CPU (crowdHost.ts), for thousands of ticks, looking for the two ways a pedestrian and a car
 * can lock each other: a pedestrian pinned on a car (walking, getting nowhere, set back onto the body every tick)
 * and a car held for good by a pedestrian its First-Law corridor never loses. Before the detour in crowd.wgsl, a
 * car parked across a sidewalk pinned the first pedestrian whose way ran through it for the whole run (agent 17 of
 * seed 11: 59 s of 60, a push every tick, the car's reverse held at 0.3 m throughout); AI traffic on its rings
 * never deadlocked in 10,000 ticks with 48 cars and 500 people. Both are kept here: the parked cars at full length,
 * the traffic for SOAK_TICKS ticks (1,800 by default, 10,000 in the nightly fuzz workflow). The soak is a test, so
 * it runs on every change, with no GPU.
 * What breaks if it is removed? A pedestrian pinned on a car, or a car held by one, is found by a player again.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CAR } from './car.ts'
import { POSE } from './simProtocol.ts'
import { CITY, generateCity, streetFurniture } from '../01_Initialize_World/city.ts'
import type { StepInput } from './simCore.ts'

// Vite's `?raw` import, for Node: the file as a default-exported string.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})

const { SimCore } = await import('./simCore.ts')
const { CrowdHost } = await import('../03_Spawn_Agents/crowdHost.ts')

/** Ticks of the traffic soak: 30 s of city time by default; the nightly runs the full 10,000 (167 s). */
const SOAK_TICKS = Math.max(600, Math.floor(Number(process.env.SOAK_TICKS ?? 1800)))
const DT = 1 / 60
const SEED = 11
const AGENTS = 500
const IDLE: StepInput = { dt: DT, foot: { x: 0, z: 0, heading: NaN }, drive: { steer: 0, fwd: 0, back: 0, handbrake: false }, cmds: [] }
/** A pedestrian is pinned when, over a second, they wanted to walk (mean speed above this) and got nowhere (less than PIN_MOVE). */
const PIN_SPEED = 0.3
const PIN_MOVE = 0.3
/** Pinned this long on a car (s) is stuck: the detour takes a pedestrian round a parked car in about two. */
const PIN_LIMIT = 5
/** A car reading a person at 0 m (inside its widened footprint) for longer than this (s) is held by someone pinned on it. */
const HOLD_LIMIT = 10

type Core = Awaited<ReturnType<typeof SimCore.create>>
interface Realm { core: Core; host: InstanceType<typeof CrowdHost>; poses: Float32Array; cars: number }

async function realm(cars: number, latency = 1): Promise<Realm> {
  let host: InstanceType<typeof CrowdHost> | null = null
  const core = await SimCore.create(
    {
      seed: SEED, cars, agents: AGENTS, boxes: generateCity(SEED), furniture: streetFurniture(SEED),
      spawn: { x: CITY.pitch * 8 + 20, z: CITY.pitch * 8 - CITY.lane }, debug: false, tracks: true, craft: false, ragdoll: false,
    },
    async (agents, grid, streets, rooms) => (host = new CrowdHost(agents, grid, streets, rooms, { latency })),
  )
  return { core, host: host!, poses: new Float32Array(cars * POSE.stride), cars }
}

/** Whether (x, z) is within `pad` of car `j`'s chassis box, in the car's own frame. */
function nearCar(poses: Float32Array, j: number, x: number, z: number, pad: number): boolean {
  const o = j * POSE.stride, h = poses[o + POSE.heading]
  const fx = Math.sin(h), fz = Math.cos(h)
  const dx = x - poses[o + POSE.x], dz = z - poses[o + POSE.z]
  const lz = dx * fx + dz * fz, lx = dx * -fz + dz * fx
  return Math.abs(lx) < CAR.halfWidth + pad && Math.abs(lz) < CAR.halfLength + pad
}

interface Watch {
  /** Longest run of pinned seconds while near a car, per agent; and the agents that ever came within contact reach of one. */
  pinned: Float64Array
  met: Set<number>
  /** Longest run of seconds a car read a person at 0 m while standing, per car. */
  held: Float64Array
  nudges: number
  ticks: number
}

/** Steps the realm `ticks` times, watching every pedestrian and every car for a pin or a hold. */
function soak(r: Realm, ticks: number, watch: (j: number) => boolean = () => true): Watch {
  const { core, host, poses, cars } = r
  const pinned = new Float64Array(AGENTS), streak = new Float64Array(AGENTS), speedSum = new Float64Array(AGENTS)
  const last = new Float64Array(AGENTS * 2)
  const held = new Float64Array(cars), heldSince = new Float64Array(cars).fill(-1)
  const met = new Set<number>()
  let nudges = 0
  const s = host.state
  for (let i = 0; i < AGENTS; i++) { last[2 * i] = s.pos[4 * i]; last[2 * i + 1] = s.pos[4 * i + 2] }
  for (let tick = 1; tick <= ticks; tick++) {
    const st = core.step(IDLE, poses)
    assert.equal(core.halted, false, `the realm halted at tick ${tick}: ${core.panic}`)
    const time = st.simTime
    const read = host.readout!
    nudges = read.stats.nudges
    for (let j = 0; j < cars; j++) {
      if (!watch(j)) continue
      const standing = Math.abs(poses[j * POSE.stride + POSE.speed]) < 0.05
      if (standing && (read.hazardsAhead[j] === 0 || read.hazardsBehind[j] === 0)) {
        if (heldSince[j] < 0) heldSince[j] = time
        held[j] = Math.max(held[j], time - heldSince[j])
      } else heldSince[j] = -1
    }
    for (let i = 1; i < AGENTS; i++) speedSum[i] += s.vel[4 * i + 3]
    if (tick % 60 === 0) {
      for (let i = 1; i < AGENTS; i++) {
        const x = s.pos[4 * i], z = s.pos[4 * i + 2]
        assert.ok(Number.isFinite(x) && Number.isFinite(z), `pedestrian ${i} is not finite at tick ${tick}`)
        let near = false
        for (let j = 0; j < cars && !near; j++) if (watch(j) && nearCar(poses, j, x, z, 1)) near = true
        if (near) met.add(i)
        const moved = Math.hypot(x - last[2 * i], z - last[2 * i + 1])
        if (near && moved < PIN_MOVE && speedSum[i] / 60 > PIN_SPEED) streak[i] += 1
        else streak[i] = 0
        pinned[i] = Math.max(pinned[i], streak[i])
        last[2 * i] = x; last[2 * i + 1] = z
      }
      speedSum.fill(0)
    }
  }
  return { pinned, met, held, nudges, ticks }
}

const worst = (a: Float64Array): { at: number; value: number } => a.reduce((w, value, at) => (value > w.value ? { at, value } : w), { at: -1, value: 0 })

test('cars parked across the sidewalks: nobody is pinned on one, and none is held by someone pinned on it', async (t) => {
  const r = await realm(8)
  // Eight cars parked where the people walk, around the centre: along the sidewalk lane (CITY.lane from the
  // centreline; the car's contact margin then covers the whole sidewalk) and across it, nose to the lot's edge and
  // tail in the road, on both sides of east-west and north-south streets. None overlaps a building.
  const along = Math.PI / 2
  const across = CAR.halfLength + 0.1
  const edge = CITY.lotHalf + (CITY.pitch / 2 - CITY.lotHalf)
  const parks = [
    { i: 0, x: 340, z: 320 + CITY.lane, heading: along }, { i: 1, x: 260, z: 320 - edge + across, heading: 0 },
    { i: 2, x: 280 + CITY.lane, z: 300, heading: 0 }, { i: 3, x: 280 - edge + across, z: 220, heading: along },
    { i: 4, x: 300, z: 280 - CITY.lane, heading: along }, { i: 5, x: 380, z: 360 + edge - across, heading: 0 },
    { i: 6, x: 320 - CITY.lane, z: 340, heading: 0 }, { i: 7, x: 360 + edge - across, z: 260, heading: along },
  ]
  const cmds = parks.flatMap((p) => [{ c: 'setMode', i: p.i, mode: 'parked' }, { c: 'recover', i: p.i, x: p.x, z: p.z, heading: p.heading }])
  const st = r.core.step({ ...IDLE, cmds }, r.poses)
  assert.equal(st.rejected, 0)
  for (const p of parks) {
    const o = p.i * POSE.stride
    assert.ok(Math.abs(r.poses[o + POSE.x] - p.x) < 0.01 && Math.abs(r.poses[o + POSE.z] - p.z) < 0.01, `car ${p.i} parked`)
  }
  const w = soak(r, 3600)
  const pin = worst(w.pinned), hold = worst(w.held)
  t.diagnostic(`parked: ${w.met.size} pedestrians met a parked car in 60 s; longest pin ${pin.value} s (agent ${pin.at}); longest hold at 0 m ${hold.value.toFixed(1)} s (car ${hold.at}); ${w.nudges} pushes`)
  assert.ok(w.met.size >= 1, 'nobody came near a parked car: the scene proves nothing')
  assert.ok(pin.value < PIN_LIMIT, `pedestrian ${pin.at} was pinned on a parked car for ${pin.value} s`)
  assert.ok(hold.value < HOLD_LIMIT, `car ${hold.at} read a person at 0 m for ${hold.value.toFixed(1)} s`)
})

test(`traffic: 48 cars on their rings and 500 people for ${SOAK_TICKS} ticks never lock each other`, async (t) => {
  const r = await realm(48)
  const w = soak(r, SOAK_TICKS)
  const pin = worst(w.pinned), hold = worst(w.held)
  const st = r.core.step(IDLE, r.poses)
  t.diagnostic(`traffic: ${SOAK_TICKS} ticks (${(SOAK_TICKS * DT).toFixed(0)} s); ${w.met.size} pedestrians came within a metre of a car; longest pin ${pin.value} s (agent ${pin.at}); longest hold at 0 m ${hold.value.toFixed(1)} s (car ${hold.at}); ${w.nudges} pushes; First-Law holds ${st.kernel.law1}; perimeter breaches ${st.kernel.audit.perimeterBreaches}`)
  assert.ok(pin.value < PIN_LIMIT, `pedestrian ${pin.at} was pinned on a car for ${pin.value} s`)
  assert.ok(hold.value < HOLD_LIMIT, `car ${hold.at} read a person at 0 m for ${hold.value.toFixed(1)} s`)
  assert.equal(st.kernel.audit.panic, null)
})
