// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the drivers' hazard state machine as a table, not an object per driver: one row per
 * driver in a structure of arrays (the episode's live flag, its seconds so far, its seconds of clear path, the
 * reaction latency its Perception roll earned), and one `perceive` pass that moves a row from one state to the
 * next with 1/0 masks folded into arithmetic (NewState = CurrentState + UpdateValue × Mask), the form the swarm's
 * kernels take (crimson_noir_os kernels.rs). The states are the ones traffic.ts's HazardEpisode had: no episode; an
 * episode the driver has not yet noticed; one the driver has reacted to; and the clear-path countdown that ends
 * it. The only conditional left is the Perception roll itself, which draws from the driver's seeded stream exactly
 * once per episode and so cannot be multiplexed (a roll not taken is a number not drawn). The roll's result is kept
 * per row as data, so a driver's `check` is the same object for the whole episode, as the tests of traffic.ts and
 * trackDriver.ts hold it to. HazardEpisode in traffic.ts is now a handle on a row of this table.
 * What breaks if it is removed? Every AI driver's reaction to a person in its path.
 */
import { DRIVER_REACTION, KERNEL } from '../02_Define_The_Rules/civic.ts'
import { rollCheck, type CheckResult } from '../02_Define_The_Rules/degrees.ts'

/** Bumper-to-person distance a driver plans to stop at: the kernel's standoff plus a courtesy margin. */
export const PERSON_STOP = KERNEL.standoff + 0.5
/** Seconds the path must stay clear before a new person starts a new hazard episode (and a new roll). */
export const EPISODE_CLEAR = 1

/** Rows the table starts with; it doubles when full. */
const FIRST_ROWS = 32

/**
 * How far short of a degree's latency a summed clock may fall and still be at it, s: sixty steps of 1/60 add up to a
 * hair under one second in doubles, and a driver must react on the frame the latency ends, not one or two later.
 */
export const REACTION_SLACK = 1e-9

/** The two answers `perceive` can give, multiplexed by index rather than by a branch. */
const NO_ROOM = Infinity

export class HazardTable {
  /** 1 while the row's episode is live (a person was seen and the path has not been clear for EPISODE_CLEAR). */
  #live = new Uint8Array(FIRST_ROWS)
  /** Seconds since the episode began. */
  #seconds = new Float64Array(FIRST_ROWS)
  /** Seconds the path has been clear in a row during the episode. */
  #clear = new Float64Array(FIRST_ROWS)
  /** Seconds the driver takes to react in the row's episode (Infinity with no episode). */
  #latency = new Float64Array(FIRST_ROWS).fill(Infinity)
  /** The episode's Perception roll (null with no episode): data a driver reports, kept for the episode's life. */
  #check: (CheckResult | null)[] = new Array<CheckResult | null>(FIRST_ROWS).fill(null)
  /** Each row's seeded stream, drawn from once per episode. */
  #rng: (() => number)[] = new Array<() => number>(FIRST_ROWS)
  #rows = 0

  /** Rows in use. */
  get rows(): number {
    return this.#rows
  }

  /** A row for a driver whose Perception rolls draw from `rng`. */
  add(rng: () => number): number {
    if (this.#rows === this.#live.length) this.#grow()
    const r = this.#rows++
    this.#rng[r] = rng
    this.#live[r] = 0
    this.#seconds[r] = 0
    this.#clear[r] = 0
    this.#latency[r] = Infinity
    this.#check[r] = null
    return r
  }

  #grow(): void {
    const n = this.#live.length * 2
    const grow = <A extends Uint8Array | Float64Array>(a: A, make: (n: number) => A, fill: number): A => {
      const b = make(n)
      b.fill(fill)
      b.set(a)
      return b
    }
    this.#live = grow(this.#live, (n) => new Uint8Array(n), 0)
    this.#seconds = grow(this.#seconds, (n) => new Float64Array(n), 0)
    this.#clear = grow(this.#clear, (n) => new Float64Array(n), 0)
    this.#latency = grow(this.#latency, (n) => new Float64Array(n), Infinity)
    this.#check.length = n
    this.#check.fill(null, this.#rows)
    this.#rng.length = n
  }

  /** The Perception check of row `r`'s current episode (null once the path has been clear for a second). */
  check(r: number): CheckResult | null {
    return this.#check[r]
  }

  /** Seconds row `r`'s driver takes to react in the current episode (Infinity when there is none). */
  reactionLatency(r: number): number {
    return this.#latency[r]
  }

  /** 1 once row `r`'s driver has noticed the person of the current episode, else 0. */
  reactedMask(r: number): number {
    return this.#live[r] & +(this.#seconds[r] >= this.#latency[r] - REACTION_SLACK)
  }

  /** True once row `r`'s driver has noticed the person of the current episode. */
  reacted(r: number): boolean {
    return this.reactedMask(r) === 1
  }

  /**
   * Advances row `r`'s episode by `dt` with the person `personAhead` metres from the bumper (Infinity: none). Returns
   * the room to stop in before the person once the driver has reacted, else Infinity.
   *
   * The transition, as masks: `present` is the person inside the sensing range; `starts` is a person with no live
   * episode, which rolls Perception; an episode that goes on adds `dt` to its clock and either resets or extends its
   * clear-path clock; `ends` is a clear-path clock past EPISODE_CLEAR, which zeroes the row.
   */
  perceive(r: number, personAhead: number, dt: number): number {
    const present = +(personAhead < KERNEL.range)
    const live = this.#live[r]
    const starts = present & (live ^ 1)
    const goes = live & (starts ^ 1)
    // One roll per episode: the draw is the one conditional, since a number not drawn cannot be multiplexed.
    const rolled = starts ? rollCheck(DRIVER_REACTION.modifier, DRIVER_REACTION.dc, this.#rng[r]) : null
    // The frame the person is first seen counts: the driver has been looking at them for it.
    const seconds = (this.#seconds[r] + dt) * (goes | starts)
    const clear = (this.#clear[r] + dt) * goes * (present ^ 1)
    const ends = goes & +(clear >= EPISODE_CLEAR)
    const keep = ends ^ 1
    const liveNext = (live | starts) & keep
    const latency = [this.#latency[r], DRIVER_REACTION.latency[rolled?.degree ?? 0]][starts]
    this.#live[r] = liveNext
    this.#seconds[r] = seconds * keep
    this.#clear[r] = clear * keep
    this.#latency[r] = [Infinity, latency][liveNext]
    this.#check[r] = [null, [this.#check[r], rolled][starts]][liveNext]
    const reacted = liveNext & +(seconds * keep >= this.#latency[r] - REACTION_SLACK)
    return [NO_ROOM, personAhead - PERSON_STOP][present & reacted]
  }
}

/** The table every driver's episode lives in unless it is given another. */
export const HAZARDS = new HazardTable()
