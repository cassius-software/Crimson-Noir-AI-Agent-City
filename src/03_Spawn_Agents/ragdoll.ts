/**
 * Why does this file exist? It is the balance state machine of an active ragdoll, and the pool that decides who may
 * have one. The GPU crowd (crowd.wgsl) moves every pedestrian kinematically and absorbs small pushes with its tilt
 * springs; a few people near the operator can be promoted to a physical body (ragdollRig.ts) when a push is too firm
 * for those springs: a shove in a dense crowd, a trip on a kerb or the seawall edge, a slip. The machine is pure and
 * deterministic, (machine, inputs, dt) → machine, with every timer and threshold a named constant:
 *
 *   Kinematic ──accepted push ≥ PROMOTE_IMPULSE──▶ Perturbed        (powered joints track the standing pose)
 *   Perturbed ──settled for SETTLE_TIME──────────▶ Recovering       (short blend back to the crowd's pose)
 *   Perturbed ──centre of mass past the support──▶ CatchStep        (step under the centre of mass)
 *   CatchStep ──back over the support────────────▶ Perturbed
 *   Perturbed / CatchStep ──too far over, or too many steps, or too long──▶ SittingDown (a damped, controlled lowering)
 *   SittingDown ──pelvis low, or SIT_TIME_MAX────▶ Seated
 *   Seated ──still for SEATED_TIME───────────────▶ Recovering       (rise: RISE_TIME blend back to the crowd's pose)
 *   Recovering ──blend done──────────────────────▶ Kinematic        (the pool releases the slot)
 *
 * A vehicle is never a cause. Ring-0 (02_Define_The_Rules/ring0.ts) halts the whole simulation on any contact between
 * a moving car and a solid person, and the sanctuary keeps cars from reaching one, so a car pushing a person is a
 * kernel failure, not a balance event: the pool refuses such a request outright (and any cause it does not know).
 * What breaks if it is removed? Nothing yet: this is scaffolding the engine does not call. Without it, a ragdoll rig
 * would have no rule for when it exists, how stiff its joints are, or when it hands the person back to the crowd.
 */

export type BalanceState = 'kinematic' | 'perturbed' | 'catchStep' | 'sittingDown' | 'seated' | 'recovering'

/** What can push a person off balance. Deliberately no vehicle: see the file header. */
export const PERTURBATION_CAUSES = Object.freeze(['shove', 'kerbTrip', 'edgeTrip', 'slip'] as const)
export type PerturbationCause = (typeof PERTURBATION_CAUSES)[number]

export interface Perturbation {
  cause: PerturbationCause
  /** N·s delivered to the person. */
  impulse: number
}

/** What the rig (or, while kinematic, the crowd) reads each tick. Angles in radians, lengths in metres. */
export interface BalanceInputs {
  /** Torso angle from vertical. */
  tilt: number
  /** Torso angular speed about horizontal axes, rad/s. */
  tiltRate: number
  /** Horizontal distance of the centre of mass from the middle of the feet. */
  comOffset: number
  /** Pelvis height above the ground. */
  pelvisHeight: number
  /** An accepted push this tick, if any (see classifyPerturbation). */
  push?: Perturbation | null
}

export interface BalanceMachine {
  readonly state: BalanceState
  /** Seconds in this state. */
  readonly t: number
  /** Seconds the settle (or stillness) condition has held without a break. */
  readonly calm: number
  /** Catch steps taken since the push. */
  readonly steps: number
  /** Seconds the current Recovering blend lasts. */
  readonly blend: number
}

/** N·s: below it the crowd's tilt springs absorb the push and nobody is promoted (0.5 m/s on 70 kg). */
export const PROMOTE_IMPULSE = 35
/**
 * Settled: tilt, tilt rate and centre-of-mass offset all under these for SETTLE_TIME. Measured on the rig
 * (ragdollRig.ts): standing unpushed it holds tilt ≤ 0.04, rate ≤ 0.1 and an offset of 0.06–0.08 m.
 */
export const SETTLE_TILT = 0.06
export const SETTLE_RATE = 0.3
export const SETTLE_OFFSET = 0.1
export const SETTLE_TIME = 0.5
/**
 * Past the support: the centre of mass this far from the middle of the feet, or the torso this far over, calls a
 * catch step. Measured: a 40 N·s shove peaks at 0.15 m and is held in place; 120 N·s reaches 0.54 m.
 */
export const CATCH_OFFSET = 0.2
export const CATCH_TILT = 0.25
/** Seconds one catch step takes; a step ends with a check whether the centre of mass is back over the feet. */
export const STEP_TIME = 0.35
/** Catch steps allowed before the person sits down instead. */
export const MAX_CATCH_STEPS = 3
/** Torso this far over (rad) at any point of Perturbed or CatchStep: sit down, do not keep stepping. */
export const SIT_TILT = 0.7
/** Longest Perturbed may last without settling (no livelock between states). */
export const PERTURBED_MAX = 4
/** Seated once the pelvis is this low, or SIT_TIME_MAX after starting to sit. */
export const SEATED_HEIGHT = 0.45
export const SIT_TIME_MAX = 2
/** Seated and still (tilt rate under SEATED_RATE) this long before rising. */
export const SEATED_TIME = 1.2
export const SEATED_RATE = 0.5
/** Blend back to the crowd's pose: after a settled push, and after rising from the ground. */
export const SETTLE_BLEND = 0.3
export const RISE_TIME = 1.6

/** Every transition the machine can make; stepBalance never makes another. */
export const TRANSITIONS: readonly (readonly [BalanceState, BalanceState])[] = Object.freeze([
  ['kinematic', 'perturbed'],
  ['perturbed', 'recovering'],
  ['perturbed', 'catchStep'],
  ['perturbed', 'sittingDown'],
  ['catchStep', 'perturbed'],
  ['catchStep', 'sittingDown'],
  ['sittingDown', 'seated'],
  ['seated', 'recovering'],
  ['recovering', 'kinematic'],
] as const)

/**
 * What the rig's powered joints and assist do in a state (ragdollRig.ts drive). The joints are velocity servos: they
 * want to turn back toward the standing pose at `stiffness` (1/s) per radian of error, and close the share `damping`
 * (0…1) of the gap each tick. `assist` (0…1) holds the trunk upright and the pelvis over the feet; `support` (0…1)
 * holds the pelvis at standing height. Lowering is less support with the trunk still held.
 */
export interface MotorGains {
  stiffness: number
  damping: number
  assist: number
  support: number
}

export const GAINS: Readonly<Record<BalanceState, Readonly<MotorGains>>> = Object.freeze({
  kinematic: Object.freeze({ stiffness: 0, damping: 0, assist: 0, support: 0 }),
  perturbed: Object.freeze({ stiffness: 10, damping: 0.5, assist: 1, support: 1 }),
  catchStep: Object.freeze({ stiffness: 8, damping: 0.5, assist: 1, support: 1 }),
  sittingDown: Object.freeze({ stiffness: 6, damping: 0.5, assist: 1, support: 0.3 }),
  seated: Object.freeze({ stiffness: 2, damping: 0.3, assist: 0, support: 0 }),
  recovering: Object.freeze({ stiffness: 0, damping: 0, assist: 0, support: 0 }),
})

/** Whether a physical rig exists in this state. Recovering is a render-side blend from the last physical pose. */
export function rigWanted(state: BalanceState): boolean {
  return state !== 'kinematic' && state !== 'recovering'
}

export const KINEMATIC: BalanceMachine = Object.freeze({ state: 'kinematic', t: 0, calm: 0, steps: 0, blend: 0 })

const enter = (state: BalanceState, steps = 0, blend = 0): BalanceMachine => Object.freeze({ state, t: 0, calm: 0, steps, blend })

const finite = (i: BalanceInputs): boolean =>
  Number.isFinite(i.tilt) && Number.isFinite(i.tiltRate) && Number.isFinite(i.comOffset) && Number.isFinite(i.pelvisHeight)

/**
 * One tick. Pure: the same machine, inputs and dt always give the same machine. Inputs that are not finite carry no
 * information: timers run, no transition is taken (Ring-0 halts the simulation on a non-finite body anyway).
 */
export function stepBalance(m: BalanceMachine, inp: BalanceInputs, dt: number): BalanceMachine {
  if (!(dt > 0) || !Number.isFinite(dt)) return m
  const push = inp.push && inp.push.impulse >= PROMOTE_IMPULSE ? inp.push : null
  const t = m.t + dt
  const hold = (calm: number): BalanceMachine => Object.freeze({ ...m, t, calm })
  if (m.state === 'kinematic') return push ? enter('perturbed') : hold(0)
  if (m.state === 'recovering') return t >= m.blend ? KINEMATIC : hold(0)
  if (!finite(inp)) return hold(m.calm)

  const pastSupport = inp.comOffset > CATCH_OFFSET || inp.tilt > CATCH_TILT
  switch (m.state) {
    case 'perturbed': {
      if (inp.tilt > SIT_TILT || t >= PERTURBED_MAX) return enter('sittingDown', m.steps)
      if (pastSupport) return enter('catchStep', m.steps)
      const settled = !push && inp.tilt < SETTLE_TILT && inp.tiltRate < SETTLE_RATE && inp.comOffset < SETTLE_OFFSET
      const calm = settled ? m.calm + dt : 0
      return calm >= SETTLE_TIME ? enter('recovering', 0, SETTLE_BLEND) : hold(calm)
    }
    case 'catchStep': {
      if (inp.tilt > SIT_TILT) return enter('sittingDown', m.steps)
      if (t < STEP_TIME) return hold(0)
      const steps = m.steps + 1
      if (!pastSupport) return enter('perturbed', steps)
      return steps >= MAX_CATCH_STEPS ? enter('sittingDown', steps) : enter('catchStep', steps)
    }
    case 'sittingDown':
      return inp.pelvisHeight < SEATED_HEIGHT || t >= SIT_TIME_MAX ? enter('seated') : hold(0)
    case 'seated': {
      const calm = inp.tiltRate < SEATED_RATE ? m.calm + dt : 0
      return calm >= SEATED_TIME ? enter('recovering', 0, RISE_TIME) : hold(calm)
    }
  }
}

/** 0…1: how much of the drawn pose is the rig's (1) versus the crowd's animation (0). */
export function physicalWeight(m: BalanceMachine): number {
  if (m.state === 'kinematic') return 0
  if (m.state === 'recovering') return m.blend > 0 ? Math.max(0, 1 - m.t / m.blend) : 0
  return 1
}

export type PerturbationVerdict =
  | { ok: true; push: Perturbation }
  | { ok: false; reason: 'vehicle' | 'unknownCause' | 'invalidImpulse' }

/**
 * Checks a request to push a person off balance. A vehicle is refused by name (the Ring-0 kernel owns every car–person
 * contact); so is any cause not in PERTURBATION_CAUSES, and an impulse that is not a finite, non-negative number.
 */
export function classifyPerturbation(p: { cause: unknown; impulse: unknown }): PerturbationVerdict {
  if (p.cause === 'vehicle') return { ok: false, reason: 'vehicle' }
  if (typeof p.cause !== 'string' || !(PERTURBATION_CAUSES as readonly string[]).includes(p.cause)) return { ok: false, reason: 'unknownCause' }
  if (typeof p.impulse !== 'number' || !Number.isFinite(p.impulse) || p.impulse < 0) return { ok: false, reason: 'invalidImpulse' }
  return { ok: true, push: { cause: p.cause as PerturbationCause, impulse: p.impulse } }
}

/** Physical rigs at once: each is 11 bodies and 10 powered joints in the realm's Rapier world. */
export const POOL_CAPACITY = 8
/** Only people this close to the operator may be promoted, metres. */
export const PROMOTE_RADIUS = 25
/** A settled member this far from the operator is handed back to the crowd. */
export const DEMOTE_RADIUS = 40

/** Where and how fast the person was moving when promoted: the rig starts there, so nothing jumps. */
export interface Continuity {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  heading: number
}

export interface Candidate extends Continuity {
  id: number
  /** Metres from the operator. */
  distance: number
  perturbation: { cause: unknown; impulse: unknown }
}

export interface Member {
  readonly id: number
  machine: BalanceMachine
  distance: number
  readonly spawn: Readonly<Continuity>
}

export type PoolDecision =
  | { kind: 'promoted'; id: number; evicted: number | null }
  | { kind: 'pushed'; id: number }
  | { kind: 'absorbed' }
  | { kind: 'tooFar' }
  | { kind: 'full' }
  | { kind: 'refused'; reason: 'vehicle' | 'unknownCause' | 'invalidImpulse' | 'notFinite' }

export interface Reading extends BalanceInputs {
  distance: number
}

export interface PoolEvents {
  /** Members whose rig should be built this tick (just promoted), before `pushes` are applied. */
  build: number[]
  /** Pushes to apply to rigs this tick (the one that promoted a member, and any on a member with a rig). */
  pushes: { id: number; push: Perturbation }[]
  /** Members whose rig should be removed this tick (entered Recovering, or were evicted). */
  remove: number[]
  /** Members handed back to the crowd (blend done): their slot is free. */
  released: number[]
}

/**
 * The promotion pool: at most `capacity` rigs at once, only near the operator. When full, a newcomer may take the
 * place of the farthest member that is standing on its own (Perturbed, farther than the newcomer); a member stepping,
 * sitting down or seated is never taken off its rig mid-motion. Evicted and settled members blend back (Recovering)
 * without a rig, so they do not count against the capacity.
 */
export class RagdollPool {
  private readonly members = new Map<number, Member>()
  private pendingBuild: number[] = []
  private pendingRemove: number[] = []
  private pendingPush: { id: number; push: Perturbation }[] = []

  readonly capacity: number
  readonly radius: number
  readonly demoteRadius: number

  constructor(capacity = POOL_CAPACITY, radius = PROMOTE_RADIUS, demoteRadius = DEMOTE_RADIUS) {
    this.capacity = capacity
    this.radius = radius
    this.demoteRadius = demoteRadius
  }

  get size(): number {
    return this.members.size
  }

  /** Members that hold a rig now. */
  get rigs(): number {
    let n = 0
    for (const m of this.members.values()) if (rigWanted(m.machine.state)) n++
    return n
  }

  get(id: number): Readonly<Member> | undefined {
    return this.members.get(id)
  }

  ids(): number[] {
    return [...this.members.keys()].sort((a, b) => a - b)
  }

  /** A push on a person: promote them, push a member again, or refuse or absorb it. */
  offer(c: Candidate): PoolDecision {
    const verdict = classifyPerturbation(c.perturbation)
    if (!verdict.ok) return { kind: 'refused', reason: verdict.reason }
    const cont = [c.x, c.y, c.z, c.vx, c.vy, c.vz, c.heading, c.distance]
    if (!cont.every(Number.isFinite)) return { kind: 'refused', reason: 'notFinite' }
    const existing = this.members.get(c.id)
    if (existing && rigWanted(existing.machine.state)) {
      // The rig takes the push; a member settling starts settling again.
      if (existing.machine.state === 'perturbed') existing.machine = Object.freeze({ ...existing.machine, calm: 0 })
      this.pendingPush.push({ id: c.id, push: verdict.push })
      return { kind: 'pushed', id: c.id }
    }
    if (verdict.push.impulse < PROMOTE_IMPULSE) return { kind: 'absorbed' }
    if (c.distance > this.radius) return { kind: 'tooFar' }
    if (existing) return { kind: 'absorbed' } // still blending back: the crowd's springs take this one
    let evicted: number | null = null
    if (this.rigs >= this.capacity) {
      let far: Member | null = null
      for (const m of this.members.values()) {
        if (m.machine.state !== 'perturbed' || m.distance <= c.distance) continue
        if (!far || m.distance > far.distance || (m.distance === far.distance && m.id > far.id)) far = m
      }
      if (!far) return { kind: 'full' }
      far.machine = enter('recovering', 0, SETTLE_BLEND)
      this.pendingRemove.push(far.id)
      evicted = far.id
    }
    const spawn = Object.freeze({ x: c.x, y: c.y, z: c.z, vx: c.vx, vy: c.vy, vz: c.vz, heading: c.heading })
    this.members.set(c.id, { id: c.id, machine: enter('perturbed'), distance: c.distance, spawn })
    this.pendingBuild.push(c.id)
    this.pendingPush.push({ id: c.id, push: verdict.push })
    return { kind: 'promoted', id: c.id, evicted }
  }

  /**
   * One tick for every member, in id order. A member with a rig and no reading this tick holds its state (its timers
   * run). Returns what the realm must do to its rigs.
   */
  step(dt: number, readings: ReadonlyMap<number, Reading>): PoolEvents {
    const ev: PoolEvents = { build: this.pendingBuild, pushes: this.pendingPush, remove: this.pendingRemove, released: [] }
    this.pendingBuild = []
    this.pendingRemove = []
    this.pendingPush = []
    for (const id of this.ids()) {
      const m = this.members.get(id)!
      const r = readings.get(id)
      if (r && Number.isFinite(r.distance)) m.distance = r.distance
      const had = rigWanted(m.machine.state)
      const inputs: BalanceInputs = r ?? { tilt: NaN, tiltRate: NaN, comOffset: NaN, pelvisHeight: NaN }
      m.machine = stepBalance(m.machine, inputs, dt)
      if (m.machine.state === 'perturbed' && m.distance > this.demoteRadius) m.machine = enter('recovering', 0, SETTLE_BLEND)
      if (had && !rigWanted(m.machine.state) && !ev.remove.includes(id)) ev.remove.push(id)
      if (m.machine.state === 'kinematic') {
        this.members.delete(id)
        ev.released.push(id)
      }
    }
    return ev
  }
}
