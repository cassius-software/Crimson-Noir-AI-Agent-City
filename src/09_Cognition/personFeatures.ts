// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the feature inspector's reading of one person. features.ts names what the whole
 * city is doing from its counters; this names what each pedestrian of the crowd is measured doing, as a small vector
 * of PERSON_FEATURES in [0, 1] with the same JumpReLU threshold and Top-K, read from the crowd frames the physics
 * realm already sends the page (crowdCompute.ts RENDER_FLOATS: where each person stands, the speed of their last step
 * and the activity the crowd kernel wrote for them) and from the copies before it. Two of the readings need that history
 * and are kept here per person in flat arrays: STUCK, the metres someone has stepped without getting a metre from where
 * they stood (the soak's own measure of a pinned pedestrian, crowdSoak.test.ts: wanting to walk and getting nowhere),
 * and what they were doing before the operator called them over. CROWDED counts the pedestrians within the
 * crowd kernel's own flocking radius, when asked. The reading has two places to go: the console (`feature person <n>`,
 * `feature people`), and one line in the prompt of a person the operator holds (08_Swarm/shortTerm.ts
 * AgentContext.doing), so an answer knows what its speaker was measured doing.
 * Honestly: this is NOT a sparse autoencoder and it steers nobody. A pedestrian has no hidden activations to learn a
 * dictionary from: its whole state is 28 hand-written floats in the crowd kernel (position, velocity, pose and a
 * 16-float Brain of goals, timers and phases), of which the page is handed twelve. So every feature here is a
 * hand-written function of those, as features.ts is of the city's counters. And nothing here writes to the crowd:
 * no position, velocity, goal or activity of any pedestrian is changed by a reading, on any crowd kernel. Whether
 * someone who reads STUCK should be sent another way is the crowd kernel's to decide (crowd.wgsl simulate), and this
 * file gives it no input.
 * Pure and deterministic: no clock of its own (the caller hands in the simulation's), no randomness, no I/O.
 * What breaks if it is removed? Nobody can ask what one person in the crowd is doing or who is stuck, and a recruited
 * person answers without knowing what they were called away from.
 */
import { PEDESTRIAN_MAX_SPEED } from '../03_Spawn_Agents/crowdSensor.ts'
import { ACTIVITY } from '../03_Spawn_Agents/skills.ts'
import { featureRow, topK } from './features.ts'

/** Floats per pedestrian in a crowd frame: every pos (x, y, z, heading), then every vel (vx, vz, walk phase, speed), then every pose (tilt, bend, push angle, activity); crowdCompute.ts RENDER_FLOATS. */
export const FRAME_FLOATS = 12
/** How far from where they stood someone must get for their walking to count as getting somewhere, m. */
export const STUCK_RADIUS = 1
/** The step speed above which someone is walking, m/s (the soak's PIN_SPEED: slower than this is standing). */
export const STUCK_PACE = 0.3
/** Metres stepped on the spot at which STUCK reads 1. */
export const STUCK_FULL_M = 8
/** What a second of standing takes off the metres stepped on the spot, m: a pause clears them. */
export const STUCK_REST = 2
/** The radius CROWDED counts within, m: the crowd kernel's own flocking radius (crowd.wgsl NEIGH_R2 is its square). */
export const NEAR_RADIUS = 2.5
/** People within NEAR_RADIUS at which CROWDED reads 1: the most the crowd kernel's own grid keeps per cell (crowdCompute.ts GRID_CAP). */
export const NEAR_FULL = 8
/** The longest gap between two frames that is credited as walking, s: a page that was hidden credits one second, not the whole absence. */
export const OBSERVE_GAP_S = 1
/** How many stuck people `feature people` names. */
export const STUCK_NAMED = 5

/** What one pedestrian is measured doing: the readings every person feature is a function of. */
export interface PersonView {
  /** The ACTIVITY code the crowd kernel wrote for them (skills.ts), or -1 when it wrote none this page knows. */
  readonly activity: number
  /** The speed of their last step, m/s (crowd.wgsl vel.w, what the step made after walls), in [0, PEDESTRIAN_MAX_SPEED]. */
  readonly speed: number
  /** Metres stepped since they were last STUCK_RADIUS from where they stood, less STUCK_REST for every second stood still. */
  readonly spin: number
  /** Other pedestrians within NEAR_RADIUS of them (the player's own body, person 0, is not counted). */
  readonly near: number
  /** The ACTIVITY code they had before the operator called them over, or -1: not called, or called before the first frame. */
  readonly before: number
}

export interface PersonFeatureDef {
  /** UPPER_SNAKE, e.g. 'STUCK'. */
  readonly id: string
  /** 'stuck'. */
  readonly title: string
  /** One sentence: what the activation measures and how (the formula in words). */
  readonly doc: string
  /** The JumpReLU threshold: an activation at or below it reads 0. */
  readonly theta: number
  /** The activation in [0, 1]; handles zeros without NaN. */
  readonly read: (v: PersonView) => number
}

/** A value in [0, 1]: NaN reads 0 and anything outside is clamped. */
const unit = (x: number): number => (Number.isNaN(x) ? 0 : x < 0 ? 0 : x > 1 ? 1 : x)
const doing = (code: number) => (v: PersonView): number => (v.activity === code ? 1 : 0)
const feature = (f: PersonFeatureDef): PersonFeatureDef => Object.freeze(f)

/** The dictionary, in lane order: `personActivations(v)[i]` is `PERSON_FEATURES[i].read(v)`. */
export const PERSON_FEATURES: readonly PersonFeatureDef[] = Object.freeze([
  feature({
    id: 'STUCK', title: 'stuck', theta: 0.5,
    doc: `Walking and getting nowhere: metres stepped since they were last ${STUCK_RADIUS} m from where they stood, over ${STUCK_FULL_M}, capped at 1; a second standing (or waiting, working or talking) takes ${STUCK_REST} m off.`,
    read: (v) => unit(v.spin / STUCK_FULL_M),
  }),
  feature({
    id: 'CROWDED', title: 'crowded', theta: 0.25,
    doc: `Other pedestrians within ${NEAR_RADIUS} m (the crowd kernel's own flocking radius), over ${NEAR_FULL}, capped at 1.`,
    read: (v) => unit(v.near / NEAR_FULL),
  }),
  feature({ id: 'YIELDING', title: 'yielding', theta: 0.5, doc: 'Stepping back from a car: 1 while the crowd kernel reports it, else 0.', read: doing(ACTIVITY.steppingBack) }),
  feature({ id: 'WAITING', title: 'waiting', theta: 0.5, doc: 'At the kerb for the walk signal: 1 while the crowd kernel reports it, else 0.', read: doing(ACTIVITY.waiting) }),
  feature({ id: 'CROSSING', title: 'crossing', theta: 0.5, doc: 'Crossing on the walk signal: 1 while the crowd kernel reports it, else 0.', read: doing(ACTIVITY.crossing) }),
  feature({ id: 'SUMMONED', title: 'summoned', theta: 0.5, doc: 'Coming over to the operator who asked for them: 1 while the crowd kernel reports it, else 0.', read: doing(ACTIVITY.coming) }),
  feature({ id: 'TALKING', title: 'talking', theta: 0.5, doc: 'Standing with the operator who asked for them: 1 while the crowd kernel reports it, else 0.', read: doing(ACTIVITY.interviewing) }),
  feature({ id: 'WORKING', title: 'working', theta: 0.5, doc: 'At a workstation indoors: 1 while the crowd kernel reports it, else 0.', read: doing(ACTIVITY.working) }),
  feature({ id: 'COMMUTING', title: 'commuting', theta: 0.5, doc: 'On the way to or from an indoor workplace: 1 while the crowd kernel reports it, else 0.', read: doing(ACTIVITY.commuting) }),
  feature({
    id: 'PACE', title: 'pace', theta: 0.1,
    doc: `The speed of their last step over the fastest a pedestrian goes (${PEDESTRIAN_MAX_SPEED} m/s), capped at 1.`,
    read: (v) => unit(v.speed / PEDESTRIAN_MAX_SPEED),
  }),
])

const LANE = (id: string): number => PERSON_FEATURES.findIndex((f) => f.id === id)
const STUCK_LANE = LANE('STUCK')
const CROWDED_LANE = LANE('CROWDED')
/** The thresholds as the lanes hold them (Float32), so a lane written at exactly its theta compares equal to it. */
const THETA = Float32Array.from(PERSON_FEATURES, (f) => f.theta)

/** The activation vector of one person: PERSON_FEATURES.length lanes, each in [0, 1], never NaN. */
export function personActivations(v: PersonView): Float32Array {
  const out = new Float32Array(PERSON_FEATURES.length)
  for (let i = 0; i < PERSON_FEATURES.length; i++) out[i] = unit(PERSON_FEATURES[i].read(v))
  return out
}

/** JumpReLU with each person feature's theta: a lane at or below its threshold reads 0. A new array; lanes past the dictionary are kept. */
export function sparsifyPerson(acts: Float32Array): Float32Array {
  const out = new Float32Array(acts.length)
  for (let i = 0; i < acts.length; i++) {
    const v = acts[i]
    out[i] = i < THETA.length && v <= THETA[i] ? 0 : v
  }
  return out
}

/** No activity known: the code kept where the crowd kernel wrote none this page knows, or none was seen. */
const NONE = 255
const CODES = Object.values(ACTIVITY) as readonly number[]
/** The activity a frame's float names: one of ACTIVITY's codes, or NONE (not a number, not whole, or a code from a newer kernel). */
const codeOf = (x: number): number => (Number.isInteger(x) && CODES.includes(x) ? x : NONE)
/** Whether the operator has called this person over: they are coming, or standing with them. */
const called = (code: number): boolean => code === ACTIVITY.coming || code === ACTIVITY.interviewing
/** Whether standing still is what this activity is: at the kerb, at a station, with the operator. STUCK is never read during one. */
const still = (code: number): boolean => code === ACTIVITY.waiting || code === ACTIVITY.working || code === ACTIVITY.interviewing

/** Each activity in words, as a prompt and the console say it of someone. */
const DOING: Readonly<Record<number, string>> = Object.freeze({
  [ACTIVITY.routine]: 'walking the streets',
  [ACTIVITY.waiting]: 'waiting at the kerb for the walk signal',
  [ACTIVITY.crossing]: 'crossing on the walk signal',
  [ACTIVITY.steppingBack]: 'stepping back from a car',
  [ACTIVITY.coming]: 'coming over to the player',
  [ACTIVITY.interviewing]: 'talking with the player',
  [ACTIVITY.working]: 'working at a station indoors',
  [ACTIVITY.commuting]: 'on the way to or from work',
})

/**
 * One plain sentence of what a person is measured doing, for a prompt and the console: the activity, what they were
 * called away from, and the two readings that are about them rather than their day (stuck, crowded) when each is
 * over its threshold. Null when the crowd kernel reported no activity this page knows and nothing else is over.
 */
export function describePerson(v: PersonView): string | null {
  const acts = sparsifyPerson(personActivations(v))
  const parts: string[] = []
  if (DOING[v.activity]) parts.push(DOING[v.activity])
  if (called(v.activity) && DOING[v.before]) parts.push(`before being called over, ${DOING[v.before]}`)
  if (acts[STUCK_LANE] > 0) parts.push('not getting anywhere for a while')
  if (acts[CROWDED_LANE] > 0) parts.push(`${Math.min(99, Math.round(v.near))} people within ${NEAR_RADIUS} m`)
  if (!parts.length) return null
  const s = parts.join('; ')
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`
}

/** The crowd's reading: how many people were measured, in how many each feature is over its threshold, and who is stuck. */
export interface CrowdShares {
  /** People measured: every pedestrian but the player's own body (person 0), and but any whose place is not a number. */
  readonly measured: number
  /** Per person feature, in lane order: the people in whom it is over its threshold. */
  readonly over: readonly number[]
  /** The people reading STUCK, lowest index first, at most STUCK_NAMED of them. */
  readonly stuck: readonly number[]
}

/** The cell a coordinate falls in, for the neighbour count: NEAR_RADIUS on a side, so a neighbour is in the cell or one beside it. */
const cell = (v: number): number => Math.floor(v / NEAR_RADIUS)
/** One exact number per cell (no two cells share one): coordinates within a million cells of the origin either way. */
const CELL_SPAN = 2 ** 21
const cellKey = (cx: number, cz: number): number => (cx + CELL_SPAN / 2) * CELL_SPAN + (cz + CELL_SPAN / 2)

/**
 * What the page keeps of every pedestrian between crowd frames, structure of arrays: where they stand, the speed of
 * their last step, their activity, where they last got somewhere from and the metres stepped since, and what they
 * were called away from. `observe` reads one frame; everything else reads what it kept.
 */
export class PersonReadings {
  #agents = 0
  #time = Number.NaN
  #xz = new Float32Array(0)
  #from = new Float32Array(0)
  #spin = new Float32Array(0)
  #speed = new Float32Array(0)
  #activity = new Uint8Array(0)
  #before = new Uint8Array(0)

  /** Pedestrians in the newest frame read (the player's own body among them); 0 before the first. */
  get agents(): number {
    return this.#agents
  }

  /**
   * Reads one crowd frame (FRAME_FLOATS per pedestrian: every pos, then every vel, then every pose) taken at `time`
   * simulation seconds. False, and nothing kept, when the frame is not one: too short for `agents`, or `agents` or
   * `time` not usable. A first frame, a crowd of another size and a clock that went back each start every person
   * afresh from where they stand. Copies what it keeps: the frame may be handed on or back afterwards.
   */
  observe(frame: Float32Array, agents: number, time: number): boolean {
    if (!Number.isInteger(agents) || agents < 1 || !Number.isFinite(time) || frame.length < FRAME_FLOATS * agents) return false
    const fresh = agents !== this.#agents || !(time >= this.#time)
    if (agents !== this.#agents) {
      this.#agents = agents
      this.#xz = new Float32Array(2 * agents)
      this.#from = new Float32Array(2 * agents)
      this.#spin = new Float32Array(agents)
      this.#speed = new Float32Array(agents)
      this.#activity = new Uint8Array(agents)
      this.#before = new Uint8Array(agents)
    }
    const dt = fresh ? 0 : Math.min(OBSERVE_GAP_S, time - this.#time)
    this.#time = time
    const xz = this.#xz, from = this.#from, spin = this.#spin, speeds = this.#speed, activity = this.#activity, before = this.#before
    const vel = 4 * agents, pose = 8 * agents, r2 = STUCK_RADIUS * STUCK_RADIUS
    for (let i = 0; i < agents; i++) {
      const x = frame[4 * i], z = frame[4 * i + 2], s = frame[vel + 4 * i + 3]
      const speed = s > 0 ? Math.min(s, PEDESTRIAN_MAX_SPEED) : 0
      const code = codeOf(frame[pose + 4 * i + 3])
      xz[2 * i] = x
      xz[2 * i + 1] = z
      speeds[i] = speed
      if (fresh) {
        from[2 * i] = x
        from[2 * i + 1] = z
        spin[i] = 0
        activity[i] = code
        before[i] = NONE
        continue
      }
      // Getting somewhere: a metre from where they last did (a place that is not a number is never near anything).
      const dx = x - from[2 * i], dz = z - from[2 * i + 1]
      if (!(dx * dx + dz * dz < r2)) {
        from[2 * i] = x
        from[2 * i + 1] = z
        spin[i] = 0
      } else if (speed > STUCK_PACE && !still(code)) spin[i] = Math.min(2 * STUCK_FULL_M, spin[i] + speed * dt)
      else spin[i] = Math.max(0, spin[i] - STUCK_REST * dt)
      // What they were called away from: kept from the frame they were called in until they are let go.
      const was = activity[i]
      if (code !== was) {
        if (called(code) && !called(was)) before[i] = was
        else if (!called(code)) before[i] = NONE
        activity[i] = code
      }
    }
    return true
  }

  /** Whether `agent` is a pedestrian this holds a place for: 1…agents − 1 (0 is the player's own body), standing somewhere finite. */
  #has(agent: number): boolean {
    return Number.isInteger(agent) && agent >= 1 && agent < this.#agents && Number.isFinite(this.#xz[2 * agent] + this.#xz[2 * agent + 1])
  }

  #view(agent: number, near: number): PersonView {
    const a = this.#activity[agent], b = this.#before[agent]
    return { activity: a === NONE ? -1 : a, speed: this.#speed[agent], spin: this.#spin[agent], near, before: b === NONE ? -1 : b }
  }

  /** What `agent` is measured doing in the newest frame read, or null: no frame yet, no such pedestrian, the player's own body, or a place that is not a number. */
  view(agent: number): PersonView | null {
    if (!this.#has(agent)) return null
    const xz = this.#xz, x = xz[2 * agent], z = xz[2 * agent + 1], r2 = NEAR_RADIUS * NEAR_RADIUS
    let near = 0
    for (let j = 1; j < this.#agents; j++) {
      if (j === agent) continue
      const dx = xz[2 * j] - x, dz = xz[2 * j + 1] - z
      if (dx * dx + dz * dz < r2) near++
    }
    return this.#view(agent, near)
  }

  /** The sentence of what `agent` is measured doing (describePerson), or null when nothing is known of them. */
  sentence(agent: number): string | null {
    const v = this.view(agent)
    return v ? describePerson(v) : null
  }

  /**
   * One person's card for the console: who and the sentence, then one row per feature over its threshold, largest
   * first (features.ts featureRow). Null when nothing is known of them.
   */
  lines(agent: number): string[] | null {
    const v = this.view(agent)
    if (!v) return null
    const acts = sparsifyPerson(personActivations(v))
    const rows = topK(acts, acts.length).filter((r) => r.value > 0).map((r) => featureRow(PERSON_FEATURES[r.index].id, r.value))
    return [`person ${agent}: ${describePerson(v) ?? 'nothing the crowd kernel names.'}`, ...rows]
  }

  /** The crowd's reading from the newest frame read; null before the first. Counts every person's neighbours through a grid of NEAR_RADIUS cells. */
  crowd(): CrowdShares | null {
    const n = this.#agents
    if (n < 1) return null
    const xz = this.#xz, r2 = NEAR_RADIUS * NEAR_RADIUS
    // Each cell's people as a chain: the newest in `head`, the one before each in `next`.
    const head = new Map<number, number>()
    const next = new Int32Array(n).fill(-1)
    for (let i = 1; i < n; i++) {
      if (!this.#has(i)) continue
      const key = cellKey(cell(xz[2 * i]), cell(xz[2 * i + 1]))
      next[i] = head.get(key) ?? -1
      head.set(key, i)
    }
    const over = new Array<number>(PERSON_FEATURES.length).fill(0)
    const stuck: number[] = []
    let measured = 0
    for (let i = 1; i < n; i++) {
      if (!this.#has(i)) continue
      measured++
      const x = xz[2 * i], z = xz[2 * i + 1], cx = cell(x), cz = cell(z)
      let near = 0
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          for (let j = head.get(cellKey(cx + ox, cz + oz)) ?? -1; j >= 0; j = next[j]) {
            if (j === i) continue
            const dx = xz[2 * j] - x, dz = xz[2 * j + 1] - z
            if (dx * dx + dz * dz < r2) near++
          }
        }
      }
      const acts = sparsifyPerson(personActivations(this.#view(i, near)))
      for (let f = 0; f < acts.length; f++) if (acts[f] > 0) over[f]++
      if (acts[STUCK_LANE] > 0 && stuck.length < STUCK_NAMED) stuck.push(i)
    }
    return { measured, over, stuck }
  }

  /**
   * The crowd's rows for the console: how many people were measured, then one row per person feature, the share of
   * them in whom it is over its threshold and their number, largest first; the STUCK row names up to STUCK_NAMED of
   * them, to be read one by one (`feature person <n>`).
   */
  crowdLines(): string[] {
    const c = this.crowd()
    if (!c) return ['people: no reading yet (the crowd has sent no frame)']
    const shares = Float32Array.from(c.over, (k) => (c.measured > 0 ? k / c.measured : 0))
    const rows = topK(shares, shares.length).map(({ index, value }) => {
      const names = index === STUCK_LANE && c.stuck.length ? `: person ${c.stuck.join(', ')}${c.over[index] > c.stuck.length ? ` and ${c.over[index] - c.stuck.length} more` : ''}` : ''
      return `${featureRow(PERSON_FEATURES[index].id, value)}  ${c.over[index]}${names}`
    })
    return [`people: ${c.measured} measured (person 0 is your own body)`, ...rows]
  }
}

/** What this is and is not, plainly, for the console. */
export function personAbout(): string[] {
  return [
    `people: ${PERSON_FEATURES.length} named readings of one pedestrian, each a documented function of what the crowd already sends`,
    'the page (where they stand, the speed of their step, their activity) and of the frames before it, each in [0, 1].',
    `STUCK is measured over time: metres stepped without getting ${STUCK_RADIUS} m from where they stood.`,
    'A reading goes to the console and into the prompt of a person you hold. It moves nobody: nothing of any',
    'pedestrian is written, and these too are hand-written, not learned (a pedestrian has no hidden activations).',
  ]
}
