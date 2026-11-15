// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is who looks at the operator. A pedestrian looks the operator in the eye only while the
 * operator is talking to them: a recruit standing by at the operator's side (called over, the crowd kernel reporting
 * them `interviewing` and no rally sending them elsewhere), or the one person a conversation names (engine.ts
 * setTalkingTo, which the proximity talk with whoever is nearest is to call; nothing calls it yet). Everyone else
 * looks the way they go (humanoid.ts gazeAt). The page keeps a few slots, each a person's index and how far into the
 * conversation they are, eased in and out over a fraction of a second so a head turns to the operator and back instead
 * of snapping; the vertex stage reads the slots from six uniforms (crowd.ts CrowdView.talk) and gives each person the
 * weight of the slot that names them (crowdBody.ts bodyTalk, talkWeight here its twin), and the place they look at is
 * the operator's eye, held where it was through a cut so no head is swung round in one frame. No storage buffer, no
 * crowd kernel change: the same on every tier, the phone's Lite crowd among them. Pure: no DOM, no GPU, no clock, no
 * randomness.
 * What breaks if it is removed? Nobody can look at the operator, not even someone they are talking to.
 */
import { GAZE } from './humanoid.ts'

/**
 * Slots: how many people can be in a conversation (or easing out of one) at once, three vec4 uniforms' worth: every
 * recruit a summons can hold standing by at once (skills.ts RECRUIT_SLOTS, eight), the one person a conversation
 * names, and room for three more still turning back, so nobody the operator talks to waits for a slot. Seconds a head
 * takes to turn to the operator and to turn back. Metres: how far the operator's eye may move in one frame and still
 * be a body moving (TalkGaze.look; farther is a jump, a cut: a run carries the eye at most RUN 5.2 m/s times the
 * longest step one frame brings, engine.ts MAX_STEP_DT 0.1 s, so 0.52 m), the leash past which a named conversation
 * ends by itself (the gaze has let go by then, GAZE.reach), and how far from a person's own eye height (`eyeHeight`
 * over their feet) the operator's eye may be and still be talking with them on the same floor (from a sky floor's
 * window, nobody below is talked to).
 */
export const TALK = Object.freeze({ slots: 12, easeIn: 0.4, easeOut: 0.6, jump: 1.2, leash: GAZE.reach, eyeHeight: 1.6, floor: 2.5 })

/** Where the operator's eye is, in the world. */
export interface Eye { readonly x: number; readonly y: number; readonly z: number }

/**
 * Whether the person in row `agent` of `pose` (x, y, z, heading per person, as engine.ts copies it from the crowd
 * frame) stands close enough to the eye to be talked with: within TALK.leash across the ground and on the eye's own
 * floor. Null when there is no reading of them (no copy yet, a row past its end, a value that is not a number).
 */
export function withinTalk(pose: ArrayLike<number>, agent: number, eye: Eye): boolean | null {
  const o = 4 * agent
  if (!Number.isInteger(agent) || agent < 0 || o + 3 >= pose.length) return null
  const x = pose[o], y = pose[o + 1], z = pose[o + 2]
  if (!Number.isFinite(x + y + z)) return null
  return Math.hypot(x - eye.x, z - eye.z) <= TALK.leash && Math.abs(eye.y - (y + TALK.eyeHeight)) <= TALK.floor
}

/**
 * How far into a conversation with the operator the person `me` is, from the slots `who` (an index, or −1 for none)
 * and `weight`: the weight of the slot that holds them, 0 when none does, at most 1. Exactly what the vertex stage
 * computes (crowdBody.ts bodyTalk).
 */
export function talkWeight(me: number, who: ArrayLike<number>, weight: ArrayLike<number>): number {
  let w = 0
  for (let k = 0; k < who.length; k++) if (who[k] === me) w += weight[k]
  return Math.min(1, w)
}

/** The smooth step of an eased progress (WGSL smoothstep over 0..1): a head starts and ends its turn gently. */
const ease = (t: number): number => t * t * (3 - 2 * t)

/** Talking to nobody. */
const NOBODY: readonly number[] = Object.freeze([])

/**
 * The slots. Each animation frame, `step` is given the people the operator is talking to now: each one already in a
 * slot eases toward 1, each other slot's person toward 0, and a newcomer takes a free slot (one whose person has
 * eased all the way out). A newcomer who finds every slot taken waits for one rather than taking it from someone
 * mid-turn, so no head ever snaps (with TALK.slots that only happens past nine people talked to and three turning
 * back at once). `look` runs a whole frame: the slots and the place the heads look at (`eye`). `who` and `weight`
 * are what the uniforms take, twelve floats each, and `eye` the gaze target's x, y and z.
 */
export class TalkGaze {
  /** Per slot: the person's index, or −1 for an empty slot. */
  readonly who = new Float32Array(TALK.slots).fill(-1)
  /** Per slot: how far into the conversation they are, 0..1, eased. */
  readonly weight = new Float32Array(TALK.slots)
  /** Where the heads in the slots look: x, y, z in the world (the operator's eye, as `look` keeps it). */
  readonly eye = new Float64Array(3)
  /** Per slot: the linear progress the weight eases from. */
  readonly #progress = new Float64Array(TALK.slots)
  /** Whether `eye` has been given a place yet. */
  #eyeKnown = false
  /** The operator's eye in the last frame that had one, to tell a body moving from a jump. */
  readonly #last = new Float64Array(3)
  /** A cut is under way: every head turns back from where it looked before anyone turns round again. */
  #cut = false

  /** Advance every slot by `dt` seconds toward the people in `talking` (indices; repeats and anything not a whole non-negative number are ignored). */
  step(talking: readonly number[], dt: number): void {
    const s = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.25) : 0
    for (let k = 0; k < TALK.slots; k++) {
      const a = this.who[k]
      if (a < 0) continue
      const on = talking.includes(a)
      const p = on ? Math.min(1, this.#progress[k] + s / TALK.easeIn) : Math.max(0, this.#progress[k] - s / TALK.easeOut)
      this.#progress[k] = p
      if (!on && p === 0) { this.who[k] = -1; this.weight[k] = 0 } else this.weight[k] = ease(p)
    }
    for (const a of talking) {
      if (!Number.isInteger(a) || a < 0 || this.who.includes(a)) continue
      const k = this.who.indexOf(-1)
      if (k < 0) break
      this.who[k] = a
      this.#progress[k] = Math.min(1, s / TALK.easeIn)
      this.weight[k] = ease(this.#progress[k])
    }
  }

  /**
   * One animation frame, `dt` seconds on: the people the operator is `talking` to, the operator's eye `at`, and
   * whether the operator is `away` (in a car's seat, where nobody talks with them). The heads look at the eye itself
   * while it moves as a body moves, so a walk is followed exactly, and so is a move smaller than TALK.jump (a short
   * correction from the room, a teleport to a spot near by): the view jumps with it, and the people turned to the
   * operator are still looking at them from the new view. When the eye leaves the body (getting into a car) or jumps
   * farther in one frame than a body can move (TALK.jump: a ride to a sky floor, a teleport across the street or
   * farther) while anyone is turned to it, that is a cut: the place the heads look at stays where it was, every slot
   * eases back to the front from there, the people still talked to included, and once nobody is turned the place
   * moves to the eye and whoever is still talked to turns round to it again. No head chases a car's seat or a far
   * jump, nor sweeps through its own neck or round its shoulder after one. With nobody turned, a jump moves the
   * place at once: it shows on nobody. An eye that is not a number moves nothing.
   */
  look(talking: readonly number[], at: Eye, away: boolean, dt: number): void {
    const seen = Number.isFinite(at.x + at.y + at.z)
    const turned = this.who.some((a) => a >= 0)
    const last = this.#last
    const jumped = seen && this.#eyeKnown && Math.hypot(at.x - last[0], at.y - last[1], at.z - last[2]) > TALK.jump
    if (seen) { last[0] = at.x; last[1] = at.y; last[2] = at.z }
    if (turned && (away || jumped)) this.#cut = true
    this.step(this.#cut ? NOBODY : talking, dt)
    if (this.#cut && !this.who.some((a) => a >= 0)) this.#cut = false
    if (seen && !this.#cut) {
      const e = this.eye
      e[0] = at.x; e[1] = at.y; e[2] = at.z
      this.#eyeKnown = true
    }
  }
}
