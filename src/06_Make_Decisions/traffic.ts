// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the AI driver: it picks a route through the street grid, keeps to
 * the right-hand lane, follows a Bézier through each intersection (straight, left or right), obeys the
 * shared signal cycle at the stop line, follows whatever is ahead no closer than the Third Law allows,
 * and steers by pure pursuit. When a person steps into its path it makes a Perception-style check
 * (degrees of success) whose degree sets how quickly it notices them, then plans a comfortable stop
 * short of them. The bouncer in laws.ts brakes regardless of the roll: the check shapes the driving,
 * never the safety. The hazard episode is a row of the hazard table (hazards.ts) behind one handle
 * (HazardEpisode) so the track follower (trackDriver.ts) shares it rather than copying it, and DriverLike is
 * the contract the Fleet drives any AI driver through.
 * What breaks if it is removed? Every non-player car sits still.
 */
import { CITY } from '../01_Initialize_World/city.ts'
import { KERNEL, TRAFFIC, signalFor } from '../02_Define_The_Rules/civic.ts'
import type { CheckResult } from '../02_Define_The_Rules/degrees.ts'
import { HAZARDS, HazardTable } from './hazards.ts'

type Vec = [number, number]
type Turn = 'straight' | 'left' | 'right'

export interface DriverPose { x: number; z: number; heading: number; speed: number }
/** throttle 0..1 · brake as a desired deceleration in m/s² · steer in radians, positive = left. */
export interface DriverCommand { throttle: number; brake: number; steer: number }

/**
 * What the Fleet asks of any AI driver, once per frame: the command for this pose, and the hazard episode's
 * state for telemetry. `stuckSeconds` is the Fleet's anti-stall clock (it resets it when it recovers the car).
 */
export interface DriverLike {
  command(p: DriverPose, signalSeconds: number, gap: number, dt: number, personAhead?: number): DriverCommand
  stuckSeconds: number
  readonly check: CheckResult | null
  readonly reactionLatency: number
  readonly reacted: boolean
}

const right = (d: Vec): Vec => [-d[1], d[0]]
const left = (d: Vec): Vec => [d[1], -d[0]]
const WHEELBASE = 2.8
const HALF_LENGTH = 2.3
const ENTRY = 7.5
/** Metres a following driver keeps beyond the Third Law's own margin, so the kernel never has to step in. */
const FOLLOW_MARGIN = 0.5

/**
 * Fastest speed from which the Third Law's stop (laws.ts: KERNEL.selfDecel after the sensing latency, then
 * 1 m to spare) still fits in `gap` metres, less FOLLOW_MARGIN.
 */
export function followSpeed(gap: number): number {
  const room = gap - 1 - FOLLOW_MARGIN
  if (room <= 0) return 0
  const d = KERNEL.selfDecel, l = KERNEL.sensingLatency
  return d * (Math.sqrt(l * l + (2 * room) / d) - l)
}

/**
 * One hazard episode at a time: the first frame a person is inside the sensing range rolls the Perception
 * check; the episode (and its roll) lasts until the path has been clear for `EPISODE_CLEAR` seconds, so a
 * person flickering in and out of the corridor is not re-rolled. Shared by every AI driver so the semantics
 * (one roll per episode, latency by degree) are the same on a street and on a track. The state lives in a row of
 * the hazard table (hazards.ts: a structure of arrays, the transition as mask arithmetic); this is the handle a
 * driver holds on its row.
 */
export class HazardEpisode {
  readonly #table: HazardTable
  readonly #row: number

  constructor(rng: () => number, table: HazardTable = HAZARDS) {
    this.#table = table
    this.#row = table.add(rng)
  }

  /** The row this episode is in its table. */
  get row(): number {
    return this.#row
  }

  /** The Perception check of the current hazard episode (null once the path has been clear for 1 s). */
  get check(): CheckResult | null {
    return this.#table.check(this.#row)
  }

  /** Seconds the driver takes to react in the current episode (Infinity when there is none). */
  get reactionLatency(): number {
    return this.#table.reactionLatency(this.#row)
  }

  /** True once the driver has noticed the person of the current episode. */
  get reacted(): boolean {
    return this.#table.reacted(this.#row)
  }

  /**
   * Advances the episode by `dt` with the person `personAhead` metres from the bumper (Infinity: none). Returns
   * the room to stop in before the person once the driver has reacted, else Infinity.
   */
  perceive(personAhead: number, dt: number): number {
    return this.#table.perceive(this.#row, personAhead, dt)
  }
}

export class Driver implements DriverLike {
  private from: Vec
  private dir: Vec
  private turn: Turn = 'straight'
  private exitDir: Vec
  private inTurn = false
  private holding = false
  private tau = 0
  stuckSeconds = 0
  private readonly rng: () => number
  private readonly episode: HazardEpisode

  constructor(from: Vec, dir: Vec, rng: () => number) {
    this.from = from
    this.dir = dir
    this.exitDir = dir
    this.rng = rng
    this.episode = new HazardEpisode(rng)
    this.chooseTurn()
  }

  /** The Perception check of the current hazard episode (null once the path has been clear for 1 s). */
  get check(): CheckResult | null {
    return this.episode.check
  }

  /** Seconds this driver takes to react in the current episode (Infinity when there is none). */
  get reactionLatency(): number {
    return this.episode.reactionLatency
  }

  /** True once the driver has noticed the person of the current episode. */
  get reacted(): boolean {
    return this.episode.reacted
  }

  /** Lane pose `s` metres along the street from intersection `from`. */
  static lanePose(from: Vec, dir: Vec, s: number): { x: number; z: number; heading: number } {
    const r = right(dir)
    return {
      x: from[0] * CITY.pitch + dir[0] * s + r[0] * TRAFFIC.laneOffset,
      z: from[1] * CITY.pitch + dir[1] * s + r[1] * TRAFFIC.laneOffset,
      heading: Math.atan2(dir[0], dir[1]),
    }
  }

  private get to(): Vec {
    return [this.from[0] + this.dir[0], this.from[1] + this.dir[1]]
  }

  private chooseTurn(): void {
    const to = this.to
    const inside = (d: Vec) => {
      const k = to[0] + d[0], m = to[1] + d[1]
      return k >= 0 && k <= CITY.blocks && m >= 0 && m <= CITY.blocks
    }
    const options: [Turn, Vec, number][] = [['straight', this.dir, 0.5], ['left', left(this.dir), 0.25], ['right', right(this.dir), 0.25]]
    const valid = options.filter(([, d]) => inside(d))
    const total = valid.reduce((s, o) => s + o[2], 0)
    let r = this.rng() * total
    for (const [turn, d, w] of valid) {
      if ((r -= w) <= 0 || turn === valid[valid.length - 1][0]) {
        this.turn = turn
        this.exitDir = d
        return
      }
    }
  }

  private bezier(t: number): Vec {
    const B: Vec = [this.to[0] * CITY.pitch, this.to[1] * CITY.pitch]
    const r1 = right(this.dir), r2 = right(this.exitDir), L = TRAFFIC.laneOffset
    const E: Vec = [B[0] - this.dir[0] * ENTRY + r1[0] * L, B[1] - this.dir[1] * ENTRY + r1[1] * L]
    const X: Vec = [B[0] + this.exitDir[0] * ENTRY + r2[0] * L, B[1] + this.exitDir[1] * ENTRY + r2[1] * L]
    const C: Vec = this.turn === 'straight'
      ? [(E[0] + X[0]) / 2, (E[1] + X[1]) / 2]
      : this.turn === 'right'
        ? [B[0] + r1[0] * L - this.dir[0] * L, B[1] + r1[1] * L - this.dir[1] * L]
        : [B[0] + r1[0] * L + this.dir[0] * L, B[1] + r1[1] * L + this.dir[1] * L]
    const u = 1 - t
    return [u * u * E[0] + 2 * u * t * C[0] + t * t * X[0], u * u * E[1] + 2 * u * t * C[1] + t * t * X[1]]
  }

  /**
   * `gap`: metres of free road ahead of the front bumper (Infinity if clear). `personAhead`: metres from the
   * front bumper to the nearest person in the car's path (Infinity if none).
   */
  command(p: DriverPose, signalSeconds: number, gap: number, dt: number, personAhead = Infinity): DriverCommand {
    const A: Vec = [this.from[0] * CITY.pitch, this.from[1] * CITY.pitch]
    const s = (p.x - A[0]) * this.dir[0] + (p.z - A[1]) * this.dir[1]
    const axis = this.dir[0] !== 0 ? 'ew' : 'ns'
    const light = signalFor(axis, signalSeconds)
    const stopS = CITY.pitch - TRAFFIC.stopLine - HALF_LENGTH
    const turnSpeed = this.turn === 'straight' ? TRAFFIC.speedLimit : TRAFFIC.turnSpeed
    const a = TRAFFIC.comfortableDecel
    let target: Vec
    let vTarget = TRAFFIC.speedLimit

    let requiredDecel = 0
    if (!this.inTurn) {
      const entryS = CITY.pitch - ENTRY
      const toStop = stopS - s
      // Commit to stopping on red, or on amber when there is room to stop comfortably. The commitment
      // holds until green, so a car that creeps past the line never decides to run the light; only a
      // car already past the line when the light changes clears the intersection.
      if (light === 'green') this.holding = false
      else if (!this.holding && toStop > -0.5 && (light === 'red' || toStop > (p.speed * p.speed) / (2 * 4.5))) this.holding = true
      if (this.holding) {
        vTarget = Math.min(vTarget, toStop < 0.3 ? 0 : Math.sqrt(2 * a * toStop))
        requiredDecel = toStop > 0.3 ? (p.speed * p.speed) / (2 * toStop) : 6
      }
      vTarget = Math.min(vTarget, Math.sqrt(turnSpeed * turnSpeed + 2 * a * Math.max(0, entryS - s)))
      if (s >= entryS - 0.5 && !this.holding) {
        this.inTurn = true
        this.tau = 0
      }
      const look = Math.max(6, p.speed * 0.9)
      const lp = Driver.lanePose(this.from, this.dir, Math.min(s + look, CITY.pitch - ENTRY + 1))
      target = [lp.x, lp.z]
    }
    if (this.inTurn) {
      const look = Math.max(4.5, p.speed * 0.7)
      while (this.tau < 1 && Math.hypot(this.bezier(this.tau)[0] - p.x, this.bezier(this.tau)[1] - p.z) < look) this.tau += 0.04
      if (this.tau >= 1) {
        // Out of the intersection: the exit becomes the next street.
        this.from = this.to
        this.dir = this.exitDir
        this.inTurn = false
        this.chooseTurn()
        const lp = Driver.lanePose(this.from, this.dir, ENTRY + 6)
        target = [lp.x, lp.z]
      } else {
        target = this.bezier(this.tau)
        vTarget = Math.min(vTarget, turnSpeed)
      }
    }

    vTarget = Math.min(vTarget, gap < 3 ? 0 : Math.min((gap - 3) * 0.9, followSpeed(gap)))

    // A person in the path: once noticed, a comfortable feed-forward stop (v²/2d) short of them, held
    // while they stay there. Until then the driver has not seen them; the First Law floor has.
    const room = this.episode.perceive(personAhead, dt)
    if (room < Infinity) {
      vTarget = Math.min(vTarget, room < 0.3 ? 0 : Math.sqrt(2 * a * room))
      requiredDecel = Math.max(requiredDecel, room > 0.3 ? (p.speed * p.speed) / (2 * room) : 6)
    }

    // Pure pursuit toward the target point.
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading)
    const rx = -fz, rz = fx
    const tx = target![0] - p.x, tz = target![1] - p.z
    const ld = Math.max(Math.hypot(tx, tz), 1)
    const alpha = Math.atan2(tx * rx + tz * rz, tx * fx + tz * fz)
    const steer = Math.max(-0.6, Math.min(0.6, -Math.atan((2 * WHEELBASE * Math.sin(alpha)) / ld)))

    const err = vTarget - p.speed
    const stuck = vTarget > 2 && p.speed < 0.3 && gap > 6
    this.stuckSeconds = stuck ? this.stuckSeconds + dt : 0
    // Never throttle when the goal is to stand still (a car rocking back after a stop would creep forward).
    if (err > 0 && requiredDecel < 1 && vTarget >= 0.1) return { throttle: Math.min(1, err * 0.5 + 0.1), brake: 0, steer }
    // Feed-forward braking (v²/2d to the stop line) plus feedback on the speed error.
    const hold = vTarget < 0.1 && p.speed < 0.6 ? 3 : 0
    return { throttle: 0, brake: Math.min(8, Math.max(hold, requiredDecel * 1.15, -err * 2.2)), steer }
  }
}
