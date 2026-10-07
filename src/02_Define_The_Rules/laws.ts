/**
 * Why does this file exist? It is the Ring-0 bouncer: every vehicle command, from an AI driver or from
 * the player, is vetted here before it reaches the physics engine. The three laws are ranked; a lower law
 * never overrides a higher one. The ranking follows the Three Laws of Robotics that Isaac Asimov
 * introduced in 1942; the wording below is original to this project.
 *
 * In this city every pedestrian and the player's avatar count as people. "Instructions" are the player's
 * controls; AI drivers carry none, so for them the Third Law (keep the vehicle intact) applies directly.
 * What breaks if it is removed? Nothing stops a car from driving into a person.
 */
import { KERNEL } from './civic.ts'

export type LawId = 1 | 2 | 3

export interface LawText { id: LawId; title: string; text: string }

export const THREE_LAWS: readonly LawText[] = [
  { id: 1, title: 'Protect people', text: 'An agent must never harm a person, and must act to keep a person from harm.' },
  { id: 2, title: 'Follow instructions', text: 'An agent must carry out the instructions people give it, unless that would break the First Law.' },
  { id: 3, title: 'Preserve itself', text: 'An agent must keep itself intact, unless that would break the First or Second Law.' },
]

/** Same shape as DriverCommand: throttle −1..1 (negative = reverse), brake as desired deceleration (m/s²), steer in radians. */
export interface Intent { throttle: number; brake: number; steer: number }

export interface Situation {
  /** Who issued the intent: a person at the controls, or an AI driver. */
  source: 'ai' | 'player'
  /** Chassis-forward speed, m/s (negative when reversing). */
  speed: number
  /** Metres from the front bumper to the nearest person in the forward corridor (Infinity if none). */
  personAhead: number
  /** Metres from the rear bumper to the nearest person in the rear corridor (Infinity if none). */
  personBehind: number
  /** Metres of free road ahead to a non-person obstacle: a car or a wall (Infinity if clear). */
  obstacleAhead: number
}

export interface Ruling { command: Intent; law: 0 | LawId; reason: string }

/** Distance to stop from `speed` (m/s) at `decel` (m/s²) after `latency` seconds of travel. */
export function stoppingDistance(speed: number, decel: number = KERNEL.emergencyDecel, latency: number = KERNEL.sensingLatency): number {
  const v = Math.max(0, speed)
  return v * latency + (v * v) / (2 * decel)
}

const STILL = 0.05

/** Ranks the three laws for one command. Pure: the same intent and situation always rule the same way. */
export function adjudicate(intent: Intent, s: Situation): Ruling {
  // A direction is guarded when the car moves that way OR the throttle pushes that way (a car still
  // rolling backwards under forward throttle is about to head for whoever stands in front of it).
  const forward = s.speed > STILL || intent.throttle > 0
  const reverse = s.speed < -STILL || intent.throttle < 0
  const stop = (reason: string): Ruling => ({ command: { throttle: 0, brake: KERNEL.maxBrake, steer: intent.steer }, law: 1, reason })

  // First Law: a person inside the stopping envelope (plus standoff) in the direction of travel. Written as "not
  // clear beyond it", so a reading that is not a number (a person's distance, or the car's own speed) stops the car:
  // the law fails toward the person, never toward the throttle.
  if (forward && !(s.personAhead > stoppingDistance(s.speed) + KERNEL.standoff)) {
    return stop(`First Law: person ${s.personAhead.toFixed(1)} m ahead`)
  }
  if (reverse && !(s.personBehind > stoppingDistance(-s.speed) + KERNEL.standoff)) {
    return stop(`First Law: person ${s.personBehind.toFixed(1)} m behind`)
  }

  const selfRisk = forward && intent.throttle > 0 && s.obstacleAhead <= stoppingDistance(s.speed, KERNEL.selfDecel) + 1
  // Second Law: a person's instruction stands, even where the Third Law would have intervened.
  if (s.source === 'player') {
    return selfRisk
      ? { command: intent, law: 2, reason: 'Second Law: driver instruction outranks self-preservation' }
      : { command: intent, law: 0, reason: '' }
  }
  // Third Law: an AI driver does not throttle into an obstacle it cannot stop for.
  if (selfRisk) {
    const room = Math.max(0.5, s.obstacleAhead - 1)
    const decel = Math.min(KERNEL.maxBrake, Math.max(intent.brake, (s.speed * s.speed) / (2 * room)))
    return { command: { throttle: 0, brake: decel, steer: intent.steer }, law: 3, reason: `Third Law: obstacle ${s.obstacleAhead.toFixed(1)} m ahead` }
  }
  return { command: intent, law: 0, reason: '' }
}

/**
 * Stateful wrapper that counts interventions for telemetry. A count is a rising edge: one per vehicle
 * each time it enters a ruling under that law, not one per frame it stays there.
 */
export class Bouncer {
  readonly #counts: Record<LawId, number> = { 1: 0, 2: 0, 3: 0 }
  #last = ''
  readonly #active = new Map<number, 0 | LawId>()

  constructor() {
    // Runtime integrity: vet() and holding() cannot be replaced on the instance (the prototype is frozen below).
    Object.freeze(this)
  }

  /** Rising-edge interventions per law, as a frozen copy. */
  get counts(): Readonly<Record<LawId, number>> {
    return Object.freeze({ ...this.#counts })
  }

  /** Reason of the most recent intervention ('' if none yet). */
  get last(): string {
    return this.#last
  }

  /** `id` identifies the vehicle (its fleet index), so edges are tracked per vehicle. */
  vet(id: number, intent: Intent, s: Situation): Intent {
    const r = adjudicate(intent, s)
    const prev = this.#active.get(id) ?? 0
    if (r.law !== 0 && r.law !== prev) {
      this.#counts[r.law]++
      this.#last = r.reason
    }
    this.#active.set(id, r.law)
    return r.command
  }

  /** True while vehicle `id` is held by the First Law. */
  holding(id: number): boolean {
    return this.#active.get(id) === 1
  }
}
// A replaced prototype method would let a command skip the ruling; the prototype and the class are sealed.
Object.freeze(Bouncer.prototype)
Object.freeze(Bouncer)
