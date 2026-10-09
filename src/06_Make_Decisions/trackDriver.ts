// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the AI driver that follows a fixed track (tracks.ts): where the street driver
 * (traffic.ts) picks a route at every intersection, this one projects its pose onto its ring each frame and
 * drives the ring's own curve, so it never chooses, never merges and never crosses an oncoming lane. Everything
 * else is the street driver's: the same hold-at-red commitment at a stop line, the same following rule on
 * followSpeed with the same throttle gate (so the Ring-0 bouncer's Third Law never has to intervene), the same
 * hazard episode (HazardEpisode: one Perception roll per person, latency by degree, a comfortable stop at the
 * standoff), the same pure pursuit. It adds a lateral feedback on the aim (so it never cuts a corner past 0.78 m),
 * the don't-block-the-box hold (roomToClear) that keeps a queue from standing on a crosswalk, and it steers back to
 * its ring when it has been set down off it (a recover elsewhere).
 * It holds no physics handle: the track is a frozen pure object behind an ES-private field.
 * What breaks if it is removed? Cars fall back to the random street-hopping Driver and jams become possible
 * again (tracks.test.ts INV-2..4 no longer describe the live fleet).
 */
import { TRAFFIC, signalFor } from '../02_Define_The_Rules/civic.ts'
import type { CheckResult } from '../02_Define_The_Rules/degrees.ts'
import { cornerAhead, nextStop, poseAt, projectOnto, roomToClear, speedLimitAt, type Track } from './tracks.ts'
import { HazardEpisode, followSpeed, type DriverCommand, type DriverLike, type DriverPose } from './traffic.ts'

/** The bicycle-model wheelbase of pure pursuit: traffic.ts:24. */
const WHEELBASE = 2.8
/** Lateral metres beyond which a car has been set down off its track (recovered elsewhere) and steers back to it. */
const OFF_TRACK = 6
/** Lateral metres within which a returning car is back in its lane. */
const REJOINED = 0.8

export class TrackDriver implements DriverLike {
  readonly #track: Track
  /** The last arc length the pose projected to: the hint for the next projection and the Fleet's ring order. */
  #s: number
  /** Committed to stopping at the current stop line (traffic.ts's holding). */
  #holding = false
  /** Steering back onto the track after being set down more than OFF_TRACK off it. */
  #rejoining = false
  readonly #episode: HazardEpisode
  stuckSeconds = 0
  /**
   * Bumper gap to the car ahead on this ring, metres (Infinity alone), which the Fleet writes from ringGaps()
   * before each command(). The don't-block-the-box hold reads it rather than `gap`: a bonnet ray at a stop line
   * measures the street straight across the box, which at a corner is not this ring's road at all.
   */
  ringGap = Infinity

  constructor(track: Track, s0: number, rng: () => number) {
    this.#track = track
    this.#s = s0
    this.#episode = new HazardEpisode(rng)
  }

  /** The track's id in its network. */
  get track(): number {
    return this.#track.id
  }

  /** Arc length along the track at the last command (or the seat it was built at). */
  get progress(): number {
    return this.#s
  }

  /** True while the car is steering back onto its track from off it. */
  get rejoining(): boolean {
    return this.#rejoining
  }

  get check(): CheckResult | null {
    return this.#episode.check
  }

  get reactionLatency(): number {
    return this.#episode.reactionLatency
  }

  get reacted(): boolean {
    return this.#episode.reacted
  }

  /**
   * Re-projects (x, z) onto the track without driving: the Fleet places a parked car in its ring's order by this.
   * Returns the arc length and the lateral offset (positive to the right of travel).
   */
  locate(x: number, z: number): { s: number; lateral: number } {
    const r = projectOnto(this.#track, x, z, this.#s)
    this.#s = r.s
    return r
  }

  /**
   * `gap`: metres of free road ahead of the front bumper (Infinity if clear): the Fleet's least of its bonnet rays
   * and the ring gap. `personAhead`: metres from the front bumper to the nearest person in the car's path.
   */
  command(p: DriverPose, signalSeconds: number, gap: number, dt: number, personAhead = Infinity): DriverCommand {
    const track = this.#track
    const { s, lateral } = projectOnto(track, p.x, p.z, this.#s)
    this.#s = s
    // Set down off the track (a recover elsewhere): steer back to it at corner speed until back in the lane.
    if (Math.abs(lateral) > OFF_TRACK) this.#rejoining = true
    else if (Math.abs(lateral) <= REJOINED) this.#rejoining = false
    const a = TRAFFIC.comfortableDecel
    let vTarget = this.#rejoining ? track.cornerSpeed : speedLimitAt(track, s)
    let requiredDecel = 0

    if (!this.#rejoining) {
      const stop = nextStop(track, s)
      if (stop) {
        const toStop = stop.distance
        const light = signalFor(stop.axis, signalSeconds)
        // Commit to stopping on red, or on amber when there is room to stop comfortably. The commitment holds until
        // green, so a car that creeps past the line never decides to run the light; only a car already past the line
        // when the light changes clears the intersection (traffic.ts:172-180).
        if (light === 'green') this.#holding = false
        else if (!this.#holding && toStop > -0.5 && (light === 'red' || toStop > (p.speed * p.speed) / (2 * 4.5))) this.#holding = true
        // Don't block the box: hold at the line while the ring ahead lacks the room to leave the intersection.
        const blocked = toStop > -0.5 && this.ringGap < roomToClear(toStop)
        if (this.#holding || blocked) {
          vTarget = Math.min(vTarget, toStop < 0.3 ? 0 : Math.sqrt(2 * a * toStop))
          requiredDecel = toStop > 0.3 ? (p.speed * p.speed) / (2 * toStop) : 6
        }
      }
    }

    vTarget = Math.min(vTarget, gap < 3 ? 0 : Math.min((gap - 3) * 0.9, followSpeed(gap)))

    // A person in the path: once noticed, a comfortable feed-forward stop (v²/2d) short of them, held while they
    // stay there. Until then the driver has not seen them; the First Law floor has.
    const room = this.#episode.perceive(personAhead, dt)
    if (room < Infinity) {
      vTarget = Math.min(vTarget, room < 0.3 ? 0 : Math.sqrt(2 * a * room))
      requiredDecel = Math.max(requiredDecel, room > 0.3 ? (p.speed * p.speed) / (2 * room) : 6)
    }

    // The aim: on a straight, up to a metre past its end (traffic.ts:187, so the corner is not cut); in a curve
    // the shorter lookahead of traffic.ts:191; off the track, the same curve lookahead from the nearest point.
    const ahead = cornerAhead(track, s)
    const look = ahead === 0 || this.#rejoining ? Math.max(4.5, p.speed * 0.7) : Math.min(Math.max(6, p.speed * 0.9), ahead + 1)
    const aim = poseAt(track, s + look)
    // Pure pursuit alone cuts a corner: it chords toward a point already round the bend, so a car on a ring's tight
    // right turn ran up to 0.79 m inside its lane mid-corner and left it still 0.56 m in. Moving the aim as far the
    // other way as the car has strayed (lateral feedback, gain 1) holds it to 0.58 m in corners and 0.18 m on
    // straights every frame (garage.node.test.ts, the lane envelope: within GARAGE.lane's 0.78 m and 0.53 m). Not
    // while rejoining: there the lateral is metres, and the aim on the ring itself is the way back.
    const back = this.#rejoining ? 0 : lateral
    const ax = aim.x + back * aim.tangentZ, az = aim.z - back * aim.tangentX

    // Pure pursuit toward the aim point (traffic.ts:217-223).
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading)
    const rx = -fz, rz = fx
    const tx = ax - p.x, tz = az - p.z
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
