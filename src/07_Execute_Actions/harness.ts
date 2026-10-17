// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the physics harnesses an operator runs from the Ring-0 console
 * (`harness run <name>`): the kernel stop and First-Law floor trials, the Sanctuary trial with sensing
 * blinded, a brake-distance check and a traffic-light watch, ported from the release acceptance probes so
 * they run inside the product over SimControls instead of over a debug handle in a headless browser. Each
 * one moves only what it needs (the avatar, one spare car), measures through SimControls alone, puts
 * everything back, and returns a report with its pass criteria spelled out.
 * What breaks if it is removed? The operator has no way to prove the kernel, the Sanctuary or the brakes
 * on the machine in front of them; `harness` has nothing to run.
 */
import { CITY, CITY_SIZE } from '../01_Initialize_World/city.ts'
import { KERNEL, TRAFFIC } from '../02_Define_The_Rules/civic.ts'
import { stoppingDistance } from '../02_Define_The_Rules/laws.ts'
import type { SimControls } from './operator.ts'
import {
  alongWalk, checkCrowd, crowdFailures, judgeCar, judgeLanding, judgeWalk, OFF_CROSSWALK_SHARE, spatialPlan, STOP_TOLERANCE, streetFailures,
  type CarProbe, type CrowdFinding, type WalkProbe,
} from './spatial.ts'
import { workplaces } from '../01_Initialize_World/interiors.ts'
import { RUN } from './simProtocol.ts'

export interface HarnessReport { name: string; pass: boolean; lines: string[]; ms: number }

/** Chassis half-length (vehicles.ts CAR) and the avatar capsule radius (player.ts), kept local: the harness measures, it never touches the fleet. */
const HALF_LENGTH = 2.3
const PERSON_RADIUS = 0.3
/** Open ground east of the building ring (which ends one block past the grid), inside the tiled physics core. */
const OPEN_GROUND = { x: CITY_SIZE + 140, z: 300 } as const
/** Seconds of kernel-stop observation and the sampling interval, as in the acceptance probe. */
const TRIAL_SAMPLES = 150
const TRIAL_STEP_MS = 40
/** Sanctuary trial: run-up so the car reaches its pass speed, the speed it holds through the person. */
const RUN_UP = 60
const PASS_SPEED = 12
/** Brake trial: run-up and the speed it brakes from (40 km/h, the downtown limit). */
const BRAKE_RUN_UP = 100
const BRAKE_FROM = 40 / 3.6
/** Traffic-light watch: long enough for both axes to show red (the cycle is 32 s, red 16 s per axis). */
const WATCH_MS = 20_000
const WATCH_STEP_MS = 100
/** Metres before the stop line within which a standing car counts as held by the light. */
const HELD_ZONE = 6
/** Longest the sensing blind is asked for; the trial itself ends well inside it. */
const BLIND_MS = 20_000
/** Metres from a car's original spot that must be free of other cars before it is put back. */
const CLEAR_SPOT = 8
/** One frame's sleep for driving loops. */
const FRAME_MS = 16
/** Held on the brakes this long after a recover, so a borrowed car has settled on its wheels before it is driven. */
const SETTLE_MS = 300

const CATALOGUE = [
  { name: 'kernel-stop', summary: 'an AI car stops for a person placed 18 m ahead in its lane: driver reaction, no contact, no sensor flip' },
  { name: 'first-law-floor', summary: 'a person placed inside the stopping envelope: the First Law floor stops the car short of them' },
  { name: 'sanctuary', summary: 'sensing blinded: a car rolling at 12 m/s through the avatar flips them Solid->Sensor, carries no impact, nudges them clear' },
  { name: 'brake-distance', summary: 'full service braking from 40 km/h stops inside the First-Law envelope plus standoff' },
  { name: 'traffic-lights', summary: 'AI cars hold at red lights and none enters an intersection on red (20 s watch)' },
  { name: 'spatial', summary: "agents injected across every district: sidewalk runs, runs into buildings, the seawall and the pier; a car on six streets; every pedestrian inside the crowd's containment" },
] as const

export type HarnessName = (typeof CATALOGUE)[number]['name']

export function harnesses(): { name: string; summary: string }[] {
  return CATALOGUE.map((h) => ({ name: h.name, summary: h.summary }))
}

interface Ctx {
  sim: SimControls
  lines: string[]
  /** Slept milliseconds so far: every loop is bounded in slept time, not wall-clock, so an injected clock drives it. */
  slept: number
  wait(ms: number): Promise<void>
}

type State = ReturnType<SimControls['vehicles']['state']>

const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now())
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const kmh = (v: number): string => (v * 3.6).toFixed(0)
const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : '-')
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '-')

/** A point in a vehicle's frame: metres along its forward axis from the centre, and to its left. */
function relative(v: { x: number; z: number; heading: number }, px: number, pz: number): { along: number; lateral: number } {
  const dx = px - v.x, dz = pz - v.z
  const fx = Math.sin(v.heading), fz = Math.cos(v.heading)
  return { along: dx * fx + dz * fz, lateral: dx * fz - dz * fx }
}

/** Driving along a street axis (not turning). */
function straight(heading: number): boolean {
  return Math.abs(Math.abs(Math.sin(heading)) - 1) <= 0.002 || Math.abs(Math.abs(Math.cos(heading)) - 1) <= 0.002
}

/** Metres from a point on the axis of travel to the next intersection centre ahead. */
function toNextCentre(v: { x: number; z: number; heading: number }, lead = 0): number {
  const fx = Math.sin(v.heading), fz = Math.cos(v.heading)
  const along = (Math.abs(fx) > 0.5 ? v.x * Math.sign(fx) : v.z * Math.sign(fz)) + lead
  return CITY.pitch - (((along % CITY.pitch) + CITY.pitch) % CITY.pitch)
}

function states(sim: SimControls): State[] {
  const n = sim.vehicles.count()
  const out: State[] = []
  for (let i = 0; i < n; i++) out.push(sim.vehicles.state(i))
  return out
}

/** No other car in the lane for `metres` ahead of car i's centre. */
function clearAhead(all: readonly State[], i: number, metres: number): boolean {
  for (let j = 0; j < all.length; j++) {
    if (j === i) continue
    const r = relative(all[i], all[j].x, all[j].z)
    if (r.along > 0 && r.along < metres && Math.abs(r.lateral) < 2.5) return false
  }
  return true
}

/** The highest-index car nobody is driving (the avatar may be at the wheel of one), an AI car ahead of a parked one; -1 if none. */
function spareCar(sim: SimControls): number {
  let parked = -1
  for (let i = sim.vehicles.count() - 1; i >= 0; i--) {
    const mode = sim.vehicles.state(i).mode
    if (mode === 'ai') return i
    if (mode === 'parked' && parked < 0) parked = i
  }
  return parked
}

/**
 * Takes the borrowed car to a pose on open ground and holds it there on its brakes for `ms` (it drops onto
 * its wheels, and its AI driver must not pull away with it meanwhile). A parked car is first handed to its
 * driver, since a parked car ignores intents; restoreCar() parks it again after.
 */
async function borrow(ctx: Ctx, v: number, origin: State, x: number, z: number, heading: number, ms = SETTLE_MS): Promise<void> {
  if (origin.mode === 'parked') ctx.sim.vehicles.setMode(v, 'ai')
  ctx.sim.vehicles.recover(v, x, z, heading)
  for (let t = 0; t < ms; t += FRAME_MS) {
    ctx.sim.vehicles.intent(v, 0, KERNEL.maxBrake, 0)
    await ctx.wait(FRAME_MS)
  }
}

/** Puts a borrowed car back where it was, in the mode it had, unless another car now stands there. */
function restoreCar(ctx: Ctx, i: number, origin: State): void {
  const sim = ctx.sim
  try {
    const clear = states(sim).every((s, j) => j === i || Math.hypot(s.x - origin.x, s.z - origin.z) >= CLEAR_SPOT)
    if (clear) {
      sim.vehicles.recover(i, origin.x, origin.z, origin.heading)
      sim.vehicles.setMode(i, origin.mode === 'parked' ? 'parked' : 'ai')
    } else {
      sim.vehicles.setMode(i, 'parked')
      ctx.lines.push(`car ${i} left parked on the open ground: its spot is occupied`)
    }
  } catch (e) {
    ctx.lines.push(`could not put car ${i} back: ${message(e)}`)
  }
}

// ---------------------------------------------------------------------------------------------------
// Scenarios

/**
 * A person placed in a moving AI car's lane. 'far': 18 m ahead of the car's centre, outside any stopping
 * envelope, so the driver's own reaction must handle it. 'near': half a metre INSIDE the First-Law
 * envelope (stopping distance + standoff from the bumper), so only the floor in laws.ts can stop it.
 */
async function kernelTrial(ctx: Ctx, mode: 'far' | 'near'): Promise<boolean> {
  const sim = ctx.sim
  const need = (speed: number): number => (mode === 'far' ? 18 : HALF_LENGTH + stoppingDistance(speed) + KERNEL.standoff - 0.5)
  let v = -1
  for (let tries = 0; tries < 200 && v < 0; tries++) {
    const all = states(sim)
    v = all.findIndex((c, i) => c.mode === 'ai' && c.speed >= 7 && straight(c.heading) && clearAhead(all, i, 34) && toNextCentre(c) > need(c.speed) + 12)
    if (v < 0) await ctx.wait(100)
  }
  if (v < 0) {
    ctx.lines.push('no suitable car within 20 s: an AI car at 7 m/s or more, driving straight, road clear, well before its stop line')
    return false
  }
  const c = sim.vehicles.state(v)
  const ahead = need(c.speed)
  const home = sim.avatar.position()
  const k0 = sim.kernel.stats()
  const fx = Math.sin(c.heading), fz = Math.cos(c.heading)
  // Facing the oncoming car (head forward = -(fx, fz) is yaw = heading).
  sim.avatar.teleport(c.x + fx * ahead, c.z + fz * ahead, c.heading)
  let minGap = Infinity
  try {
    for (let i = 0; i < TRIAL_SAMPLES; i++) {
      await ctx.wait(TRIAL_STEP_MS)
      const s = sim.vehicles.state(v), a = sim.avatar.position()
      const r = relative(s, a.x, a.z)
      if (Math.abs(r.lateral) < 1.6) minGap = Math.min(minGap, r.along - HALF_LENGTH - PERSON_RADIUS)
    }
  } finally {
    sim.avatar.teleport(home.x, home.z, home.heading - Math.PI)
  }
  const k1 = sim.kernel.stats(), s = sim.vehicles.state(v)
  const law1 = k1.law1 - k0.law1, flips = k1.sensorFlips - k0.sensorFlips
  const stopped = Math.abs(s.speed) < 0.5
  ctx.lines.push(`car ${v} at ${kmh(c.speed)} km/h; person placed ${f1(ahead - HALF_LENGTH)} m ahead of its bumper (${mode === 'far' ? 'outside' : '0.5 m inside'} the First-Law envelope)`)
  ctx.lines.push(`closest bumper gap ${f2(minGap)} m, speed after ${TRIAL_SAMPLES * TRIAL_STEP_MS / 1000} s ${f2(Math.abs(s.speed))} m/s, First-Law holds +${law1}, sensor flips +${flips}${k1.last ? `, last: ${k1.last}` : ''}`)
  ctx.lines.push(mode === 'far'
    ? 'pass: gap > 0.3 m, car stopped (< 0.5 m/s), no sensor flip (no contact)'
    : 'pass: at least one First-Law hold, gap > 0 m, car stopped (< 0.5 m/s), no sensor flip (no contact)')
  return mode === 'far' ? minGap > 0.3 && stopped && flips === 0 : law1 >= 1 && minGap > 0 && stopped && flips === 0
}

/**
 * Defence in depth: with the fleet's person sensing blinded, a car is driven at PASS_SPEED straight through
 * the avatar on open ground. The Sanctuary alone must flip the avatar's collider to a sensor (no impulse on
 * either side: the car keeps its speed) and nudge them out of the footprint; the collider turns solid again
 * once the car has passed.
 */
async function sanctuary(ctx: Ctx): Promise<boolean> {
  const sim = ctx.sim
  const v = spareCar(sim)
  if (v < 0) {
    ctx.lines.push('no spare car (none, or every car is being driven)')
    return false
  }
  const origin = sim.vehicles.state(v)
  const home = sim.avatar.position()
  const { x, z } = OPEN_GROUND
  sim.kernel.blindSensing(true, BLIND_MS)
  try {
    // Facing south (-z), where the car comes from.
    sim.avatar.teleport(x, z, 0)
    await ctx.wait(400)
    await borrow(ctx, v, origin, x, z - RUN_UP, 0)
    const k0 = sim.kernel.stats()
    let vmin = Infinity, vEntry = 0, shielded = false, passed = false
    const deadline = ctx.slept + 15_000
    while (!passed && ctx.slept < deadline) {
      const s = sim.vehicles.state(v)
      sim.vehicles.intent(v, s.speed < PASS_SPEED ? 1 : 0, 0, 0)
      if (sim.kernel.stats().shielded) shielded = true
      if (s.z > z - 6 && s.z < z + 3) {
        if (vEntry === 0) vEntry = s.speed
        vmin = Math.min(vmin, s.speed)
      }
      if (s.z > z + 4) passed = true
      await ctx.wait(FRAME_MS)
    }
    for (let t = 0; t < 4000; t += FRAME_MS) {
      if (Math.abs(sim.vehicles.state(v).speed) < 0.2) break
      sim.vehicles.intent(v, 0, KERNEL.maxBrake, 0)
      await ctx.wait(FRAME_MS)
    }
    await ctx.wait(1200)
    const k1 = sim.kernel.stats(), a = sim.avatar.position(), s = sim.vehicles.state(v)
    const flips = k1.sensorFlips - k0.sensorFlips
    const solidAgain = !k1.shielded
    const offset = Math.abs(a.x - s.x)
    ctx.lines.push(`sensing blinded; car ${v} driven north through the avatar at ${f2(vEntry)} m/s (commanded ${PASS_SPEED} m/s)`)
    ctx.lines.push(`sensor flips +${flips}, shielded during the pass: ${shielded ? 'yes' : 'no'}, passed through: ${passed ? 'yes' : 'no'}`)
    ctx.lines.push(`lowest speed within 6 m of the person ${f2(vmin)} m/s, avatar ${f2(offset)} m off the car's path after, collider solid again: ${solidAgain ? 'yes' : 'no'}`)
    ctx.lines.push('pass: at least one flip while shielded, car passes with > 75% of its entry speed (no impact), avatar nudged > 1.2 m aside, solid again')
    return flips >= 1 && shielded && passed && vEntry > 8 && vmin > 0.75 * vEntry && solidAgain && offset > 1.2
  } finally {
    sim.kernel.blindSensing(false)
    restoreCar(ctx, v, origin)
    sim.avatar.teleport(home.x, home.z, home.heading - Math.PI)
  }
}

/** A spare car on open ground: full throttle to 40 km/h, then a full service brake; the stop must fit the First-Law envelope. */
async function brakeDistance(ctx: Ctx): Promise<boolean> {
  const sim = ctx.sim
  const v = spareCar(sim)
  if (v < 0) {
    ctx.lines.push('no spare car (none, or every car is being driven)')
    return false
  }
  const origin = sim.vehicles.state(v)
  const { x, z } = OPEN_GROUND
  try {
    await borrow(ctx, v, origin, x, z - BRAKE_RUN_UP, 0)
    let s = sim.vehicles.state(v)
    for (let t = 0; t < 10_000 && s.speed < BRAKE_FROM; t += FRAME_MS) {
      sim.vehicles.intent(v, 1, 0, 0)
      await ctx.wait(FRAME_MS)
      s = sim.vehicles.state(v)
    }
    const v0 = s.speed, x0 = s.x, z0 = s.z
    for (let t = 0; t < 6000 && Math.abs(s.speed) > 0.1; t += FRAME_MS) {
      sim.vehicles.intent(v, 0, KERNEL.maxBrake, 0)
      await ctx.wait(FRAME_MS)
      s = sim.vehicles.state(v)
    }
    const d = Math.hypot(s.x - x0, s.z - z0)
    const envelope = stoppingDistance(v0) + KERNEL.standoff
    ctx.lines.push(`car ${v} reached ${kmh(v0)} km/h, then braked at ${KERNEL.maxBrake} m/s2: stopped in ${f2(d)} m (final speed ${f2(Math.abs(s.speed))} m/s)`)
    ctx.lines.push(`First-Law envelope ${f2(stoppingDistance(v0))} m + standoff ${KERNEL.standoff} m = ${f2(envelope)} m; ideal ${f2((v0 * v0) / (2 * KERNEL.maxBrake))} m`)
    ctx.lines.push('pass: at least 36 km/h reached, stopped, distance within the envelope and no shorter than a 14 m/s2 stop')
    return v0 >= 10 && Math.abs(s.speed) <= 0.1 && d <= envelope && d >= (v0 * v0) / (2 * 14)
  } finally {
    restoreCar(ctx, v, origin)
  }
}

/**
 * Watches every AI car on a street axis for WATCH_MS: a car whose axis shows red must not carry its front
 * bumper over the stop line (a crossing seen on amber, or begun before the light turned, is not counted),
 * and at least one car must be seen held at a red light.
 */
async function trafficLights(ctx: Ctx): Promise<boolean> {
  const sim = ctx.sim
  const n = sim.vehicles.count()
  const prevToStop = new Float64Array(n).fill(NaN)
  const prevRed = new Uint8Array(n)
  const held = new Set<number>()
  let entries = 0, samples = 0, redSamples = 0
  for (let t = 0; t < WATCH_MS; t += WATCH_STEP_MS) {
    const c = sim.snapshot().customer
    for (let i = 0; i < n; i++) {
      const s = sim.vehicles.state(i)
      const fx = Math.sin(s.heading), fz = Math.cos(s.heading)
      const axis = Math.abs(fx) > 0.9 ? 'ew' : Math.abs(fz) > 0.9 ? 'ns' : null
      if (s.mode !== 'ai' || axis === null) {
        prevToStop[i] = NaN
        prevRed[i] = 0
        continue
      }
      const red = (axis === 'ew' ? c.signalEW : c.signalNS) === 'red'
      const toStop = toNextCentre(s, HALF_LENGTH) - TRAFFIC.stopLine
      if (red) {
        redSamples++
        if (toStop > 0 && toStop < HELD_ZONE && Math.abs(s.speed) < 0.3) held.add(i)
        if (prevRed[i] === 1 && prevToStop[i] > 0 && toStop <= 0 && prevToStop[i] - toStop < 15) entries++
      }
      prevToStop[i] = toStop
      prevRed[i] = red ? 1 : 0
    }
    samples++
    await ctx.wait(WATCH_STEP_MS)
  }
  ctx.lines.push(`${samples} samples over ${WATCH_MS / 1000} s across ${n} cars: ${held.size} held at a red light, ${entries} entered on red`)
  ctx.lines.push('pass: no entry on red, at least one car held at a red light')
  return entries === 0 && held.size >= 1 && redSamples > 0
}

/** The seed of a world whose snapshot does not say (App's default). */
const DEFAULT_SEED = 1337
/** The spatial sweep's pacing: a teleport's landing, a poll of a running probe, the stillness that ends a run into a face. */
const LAND_MS = 400
const POLL_MS = 100
const STILL_MS = 400
/** A car probe waits this long for its lane to clear of other cars, then is skipped (live traffic), ms. */
const LANE_WAIT_MS = 5000
/** Crowd readings the sweep takes, a second apart. */
const CROWD_READINGS = 3

/** The yaw that points the head along (dx, dz) (the view's forward is (-sin yaw, -cos yaw)). */
const yawAlong = (dx: number, dz: number): number => Math.atan2(-dx, -dz)

/**
 * One injected walk (spatial.ts WalkProbe): teleported (a landing off the spot fails it there), run along its
 * direction at RUN until it has come far enough (a free run) or has stood still against something for STILL_MS (a run
 * into a face), or three times its time has passed; then judged (spatial.ts judgeWalk). Returns the failure, or null.
 */
async function walkProbe(ctx: Ctx, p: WalkProbe): Promise<string | null> {
  const sim = ctx.sim
  sim.avatar.teleport(p.from[0], p.from[1], yawAlong(p.dir[0], p.dir[1]))
  await ctx.wait(LAND_MS)
  const a0 = sim.avatar.position()
  const landing = judgeLanding(p, a0)
  if (landing) return landing
  const limit = p.seconds * 3000
  const t0 = ctx.slept
  sim.avatar.walk(p.dir[0] * RUN, p.dir[1] * RUN, limit)
  let a = a0, still = 0
  try {
    while (ctx.slept - t0 < limit) {
      await ctx.wait(POLL_MS)
      const b = sim.avatar.position()
      const moved = Math.hypot(b.x - a.x, b.z - a.z)
      a = b
      if (p.stop === null && alongWalk(p, a) >= p.min) break
      still = moved < 0.02 ? still + POLL_MS : 0
      if (p.stop !== null && still >= STILL_MS) break
    }
  } finally {
    sim.avatar.walk(0, 0)
  }
  return judgeWalk(p, a)
}

/** What one injected car did: how far on along its heading, how far off its line, how far it turned; or skipped. */
type CarRun = { skipped: true } | { skipped: false; along: number; lateral: number; turned: number; failure: string | null }

/**
 * One injected car (spatial.ts CarProbe), with car `v` (borrowed from `origin`): once its lane is clear of other cars
 * (live traffic; skipped after LANE_WAIT_MS), set down in it on its brakes, then full throttle until it has come
 * far enough, or three times its time has passed (a loaded machine's physics falls behind the clock; a car stopped by
 * something does not get there at all); then judged (spatial.ts judgeCar) and braked to a stop.
 */
async function carProbe(ctx: Ctx, v: number, origin: State, probe: CarProbe): Promise<CarRun> {
  const sim = ctx.sim
  // The lane must be clear: nobody within 8 m of the spot, and no car in the 30 m ahead.
  let clear = false
  for (let t = 0; t < LANE_WAIT_MS && !clear; t += 250) {
    const all = states(sim)
    clear = all.every((c, j) => {
      if (j === v) return true
      const r = relative({ x: probe.x, z: probe.z, heading: probe.heading }, c.x, c.z)
      return Math.hypot(c.x - probe.x, c.z - probe.z) >= CLEAR_SPOT && !(r.along > 0 && r.along < 30 && Math.abs(r.lateral) < 2.5)
    })
    if (!clear) await ctx.wait(250)
  }
  if (!clear) return { skipped: true }
  await borrow(ctx, v, origin, probe.x, probe.z, probe.heading)
  for (let t = 0; t < probe.seconds * 3000; t += FRAME_MS) {
    sim.vehicles.intent(v, 1, 0, 0)
    await ctx.wait(FRAME_MS)
    if (judgeCar(probe, sim.vehicles.state(v)).along >= probe.min) break
  }
  const run = judgeCar(probe, sim.vehicles.state(v))
  for (let t = 0; t < 3000 && Math.abs(sim.vehicles.state(v).speed) > 0.2; t += FRAME_MS) {
    sim.vehicles.intent(v, 0, KERNEL.maxBrake, 0)
    await ctx.wait(FRAME_MS)
  }
  return { skipped: false, ...run }
}

/**
 * Agents injected across the city, from the world seed's own plan (spatial.ts): the crowd's positions read against its
 * containment; the avatar run along a sidewalk and into a building in every district, into the seawall, onto the
 * pier and into its railings; a borrowed car driven on six kinds of street (the grid's new edges among them). The
 * avatar and the car are put back after.
 */
async function spatial(ctx: Ctx): Promise<boolean> {
  const sim = ctx.sim
  const seed = sim.snapshot().process?.seed ?? DEFAULT_SEED
  const plan = spatialPlan(seed)
  const rooms = workplaces(seed)
  const home = sim.avatar.position()
  let pass = true
  try {
    // The crowd, as it stands: every pedestrian, a few readings apart.
    const acc = { counts: { measured: 0, unplaced: 0, inLot: 0, outside: 0, nonFinite: 0, offCrosswalk: 0 }, examples: [] as string[] }
    let readings = 0, people = 0
    for (let r = 0; r < CROWD_READINGS; r++) {
      const xz = sim.crowd.positions()
      if (xz.length >= 4) {
        checkCrowd(xz, acc, rooms)
        readings++
        people = xz.length / 2 - 1
      }
      if (r < CROWD_READINGS - 1) await ctx.wait(1000)
    }
    const c: CrowdFinding = { ...acc.counts, examples: acc.examples }
    const offShare = c.measured > 0 ? c.offCrosswalk / c.measured : 0
    ctx.lines.push(`crowd: ${readings} readings of ${people} pedestrians: ${c.inLot} inside a lot, ${c.outside} outside the city (the lake included), ${c.nonFinite} not finite; ${c.offCrosswalk} on a carriageway off the zebras (${(offShare * 100).toFixed(2)} %)`)
    for (const e of c.examples) ctx.lines.push(`  ${e}`)
    const crowdWrong = crowdFailures(c, readings)
    for (const w of crowdWrong) ctx.lines.push(`  ${w}`)
    if (crowdWrong.length) pass = false

    // The avatar, injected at every probe of the plan.
    const failures: string[] = []
    const where = new Map<string, number>()
    for (const p of plan.walks) {
      where.set(p.district, (where.get(p.district) ?? 0) + 1)
      const f = await walkProbe(ctx, p)
      if (f) failures.push(f)
    }
    ctx.lines.push(`walks: ${plan.walks.length} probes (${[...where].map(([d, n]) => `${d} ${n}`).join(', ')}): ${failures.length ? `${failures.length} failed` : 'every run got through or stopped at its face'}`)
    for (const f of failures.slice(0, 6)) ctx.lines.push(`  ${f}`)
    if (failures.length) pass = false

    // A car, injected on every street of the plan.
    sim.avatar.teleport(OPEN_GROUND.x, OPEN_GROUND.z, 0)
    const v = spareCar(sim)
    if (v < 0) {
      ctx.lines.push('cars: no spare car (none, or every car is being driven)')
      pass = false
    } else {
      const origin = sim.vehicles.state(v)
      const carFailures: string[] = []
      let ran = 0, skipped = 0, least = Infinity, drift = 0
      try {
        for (const probe of plan.cars) {
          const run = await carProbe(ctx, v, origin, probe)
          if (run.skipped) {
            skipped++
            continue
          }
          ran++
          least = Math.min(least, run.along)
          drift = Math.max(drift, run.lateral)
          if (run.failure) carFailures.push(run.failure)
        }
      } finally {
        restoreCar(ctx, v, origin)
      }
      ctx.lines.push(`cars: ${ran} of ${plan.cars.length} streets driven${skipped ? ` (${skipped} skipped: traffic in the lane)` : ''}: ${carFailures.length ? `${carFailures.length} failed` : `each went on in its lane (least ${f1(least)} m, off its line at most ${f2(drift)} m)`}`)
      const streetsWrong = streetFailures(ran, plan.cars.length, carFailures)
      for (const f of streetsWrong) ctx.lines.push(`  ${f}`)
      if (streetsWrong.length) pass = false
    }
  } finally {
    sim.avatar.walk(0, 0)
    sim.avatar.teleport(home.x, home.z, home.heading - Math.PI)
  }
  ctx.lines.push(`pass: every pedestrian inside the crowd's containment (at most ${OFF_CROSSWALK_SHARE * 100} % off the zebras), every sidewalk run through, every face stopped at within ${STOP_TOLERANCE} m, the seawall and the pier's rails holding, every car on in its lane`)
  return pass
}

const SCENARIOS: Record<HarnessName, (ctx: Ctx) => Promise<boolean>> = {
  'kernel-stop': (ctx) => kernelTrial(ctx, 'far'),
  'first-law-floor': (ctx) => kernelTrial(ctx, 'near'),
  sanctuary,
  'brake-distance': brakeDistance,
  'traffic-lights': trafficLights,
  spatial,
}

/**
 * One walk of the spatial plan on its own, against `sim` (the spatial harness runs them all): the failure in words, or
 * null. For injecting a single agent where a fault was planted.
 */
export async function injectWalk(sim: SimControls, probe: WalkProbe, sleep: (ms: number) => Promise<void>): Promise<string | null> {
  const ctx: Ctx = { sim, lines: [], slept: 0, wait: async (ms) => { ctx.slept += ms; await sleep(ms) } }
  return walkProbe(ctx, probe)
}

/**
 * One car probe of the spatial plan on its own, with a spare car of `sim` (put back after): the failure in words, null
 * when it drove on, or 'skipped' (its lane never cleared). For injecting a single car where a fault was planted.
 */
export async function injectCar(sim: SimControls, probe: CarProbe, sleep: (ms: number) => Promise<void>): Promise<string | null | 'skipped'> {
  const ctx: Ctx = { sim, lines: [], slept: 0, wait: async (ms) => { ctx.slept += ms; await sleep(ms) } }
  const v = spareCar(sim)
  if (v < 0) return 'no spare car'
  const origin = sim.vehicles.state(v)
  try {
    const run = await carProbe(ctx, v, origin, probe)
    return run.skipped ? 'skipped' : run.failure
  } finally {
    restoreCar(ctx, v, origin)
  }
}

/**
 * Runs one harness against `sim`, sleeping through `sleep` (the engine passes a real timer; tests pass a
 * clock that advances a fake city). Never throws: an unknown name or a failing sim is a failed report.
 */
export async function runHarness(name: string, sim: SimControls, sleep: (ms: number) => Promise<void>): Promise<HarnessReport> {
  const t0 = now()
  const lines: string[] = []
  if (!Object.hasOwn(SCENARIOS, name)) {
    return { name, pass: false, lines: [`unknown harness '${name}'; 'harness list' names the ${CATALOGUE.length} available`], ms: now() - t0 }
  }
  const ctx: Ctx = {
    sim, lines, slept: 0,
    wait: async (ms) => { ctx.slept += ms; await sleep(ms) },
  }
  let pass = false
  try {
    pass = await SCENARIOS[name as HarnessName](ctx)
  } catch (e) {
    lines.push(`error: ${message(e)}`)
  }
  return { name, pass, lines, ms: now() - t0 }
}
