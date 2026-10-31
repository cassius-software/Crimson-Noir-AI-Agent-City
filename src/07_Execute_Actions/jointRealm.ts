// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the pool of robot bodies in the physics realm (docs/joint-bridge-spec.md §5): at
 * most MAX_ROBOTS of them, each an articulated.ts body built from a manifest the page sent, driven by the setpoints
 * the page sends as commands and read back into the joint buffer's slots after every step. It owns the part of the
 * bridge that makes a twin answer like its robot: a delay buffer that holds every setpoint back a whole number of
 * steps and a first-order filter of the calibrated time constant (`filter` mode, a leader's body or a simulated
 * robot), a first-order hold on the newest frame for a twin that follows a real robot (`follow` mode), and a hold at
 * the effort cap when no setpoint has come for ROBOT_REALM.staleMs or the page asked for one (`hold`). Everything
 * read from a command is judged on read (lengths, finiteness, bounds) and thrown back as a counted rejection; nothing
 * inside the substep throws (a throw there would halt the realm), and a body that stops being finite is removed and
 * reported. It knows nothing of doors, gates or the page: the realm's clock and the Rapier world are its arguments.
 * What breaks if it is removed? The realm has no robots: twins, leaders and simulated robots alike have no body.
 */
import type RAPIER from '@dimforge/rapier3d-simd-compat'
import { buildArticulated, drive, hold, linkPose, measure, removeArticulated, sane, type Articulated } from './articulated.ts'
import { DelayBuffer } from '../04_Connect_Hardware/actuatorFit.ts'
import { buildManifest, MAX_JOINTS, MAX_ROBOTS } from '../04_Connect_Hardware/jointState.ts'
import { JOINT_FLAG, JOINT_SLOT, MAX_LINKS } from './jointBridge.ts'
import type { RobotMode } from './simProtocol.ts'

export const ROBOT_REALM = Object.freeze({
  /** A setpoint older than this (realm seconds) holds the body. */
  staleMs: 500,
  /** In `follow` mode the newest frame's q̇ carries q forward for at most this long. */
  followHoldMs: 100,
  /** Most steps a setpoint may be held back in `filter` mode (two seconds at 60 Hz). */
  maxDelaySteps: 120,
  /** Longest filter time constant accepted, ms. */
  maxTauMs: 10_000,
  /** Furthest from the origin a body may be placed, m. */
  placeRadius: 5000,
})

/** One setpoint as the realm keeps it: when it arrived (realm seconds), its seq, and the three arrays (q is the joints' length). */
interface Setpoint { at: number; seq: number; q: Float64Array; qd: Float64Array; tau: Float64Array }

interface Robot {
  readonly id: number
  readonly body: Articulated
  mode: RobotMode
  tauMs: number
  delaySteps: number
  /** One push per step (tend): the newest setpoint then (null before the first), so a read of `delaySteps` back is in steps. */
  readonly delay: DelayBuffer<Setpoint | null>
  /** The newest setpoint the page sent (any step), or null before the first. */
  latest: Setpoint | null
  /** The filter's state: where the filtered setpoint stands (q), seeded from the body on the first setpoint. */
  readonly filtered: Float64Array
  seeded: boolean
  /** The setpoint this step drives toward (after the delay), or null: holding. */
  current: Setpoint | null
  holding: boolean
}

const finiteList = (a: unknown, n: number, what: string): Float64Array => {
  if (a === undefined || a === null) return new Float64Array(0)
  if (!Array.isArray(a)) throw new Error(`${what} is not an array`)
  if (a.length !== 0 && a.length !== n) throw new Error(`${what} has ${a.length} entries for ${n} joints`)
  const out = new Float64Array(a.length)
  for (let i = 0; i < a.length; i++) {
    const v = a[i]
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what}[${i}] is not a finite number`)
    out[i] = v
  }
  return out
}

/** The pool of robot bodies in one Rapier world. */
export class JointRealm {
  readonly #world: RAPIER.World
  readonly #robots = new Map<number, Robot>()
  /** Why a body left the realm on its own (read and cleared by the core, which counts each as a rejection). */
  readonly #lost: string[] = []
  readonly #scratch = new Float64Array(3 * MAX_JOINTS)
  readonly #pose = new Float32Array(7)

  constructor(world: RAPIER.World) {
    this.#world = world
  }

  get count(): number { return this.#robots.size }

  /** The ids of the bodies in the pool, in spawn order. */
  get ids(): number[] { return [...this.#robots.keys()] }

  /** The body of robot `id` (tests and the core's audit read it), or null. */
  body(id: number): Articulated | null { return this.#robots.get(id)?.body ?? null }

  /** Reasons bodies were removed on their own since the last call. */
  takeLost(): string[] { return this.#lost.splice(0) }

  /**
   * Builds a body for `manifest` (judged again here: the page's object is plain data) at (x, y, z) facing `heading`.
   * Throws, with nothing built, for a full pool, a taken id, a refused manifest or placement, or a body Rapier refuses.
   */
  spawn(id: number, manifest: unknown, x: number, y: number, z: number, heading: number): void {
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('robotSpawn: id must be a whole number')
    if (this.#robots.has(id)) throw new Error(`robotSpawn: robot ${id} is already in the realm`)
    if (this.#robots.size >= MAX_ROBOTS) throw new Error(`robotSpawn: the realm holds at most ${MAX_ROBOTS} robots`)
    const m = manifest as { robot?: unknown; links?: unknown; joints?: unknown } | null
    if (typeof m !== 'object' || m === null || !Array.isArray(m.links) || !Array.isArray(m.joints)) throw new Error('robotSpawn: manifest must have links and joints')
    const judged = buildManifest(m.robot, m.links, m.joints)
    if (!judged.ok) throw new Error(`robotSpawn: ${judged.reason}`)
    if (judged.value.links.length > MAX_LINKS) throw new Error(`robotSpawn: at most ${MAX_LINKS} links`)
    if (![x, y, z, heading].every(Number.isFinite) || Math.hypot(x, z) > ROBOT_REALM.placeRadius || Math.abs(y) > ROBOT_REALM.placeRadius) throw new Error('robotSpawn: the placement is not finite or is too far')
    let body: Articulated
    try {
      body = buildArticulated(this.#world, judged.value, { x, y, z, heading })
    } catch (e) {
      throw new Error(`robotSpawn: ${e instanceof Error ? e.message : String(e)}`)
    }
    const n = body.movable.length
    // The delay line starts full of "no setpoint", so a read of d steps back is exactly that from the first step.
    const delay = new DelayBuffer<Setpoint | null>(ROBOT_REALM.maxDelaySteps)
    for (let i = 0; i <= ROBOT_REALM.maxDelaySteps; i++) delay.push(null)
    this.#robots.set(id, { id, body, mode: 'filter', tauMs: 0, delaySteps: 0, delay, latest: null, filtered: new Float64Array(n), seeded: false, current: null, holding: true })
  }

  /** Removes robot `id`; throws for one not in the pool. */
  remove(id: number): void {
    const r = this.#robots.get(id)
    if (!r) throw new Error(`robotRemove: no robot ${id}`)
    this.#robots.delete(id)
    removeArticulated(this.#world, r.body)
  }

  /** Removes every body (the realm is going away). */
  removeAll(): void {
    for (const id of [...this.#robots.keys()]) this.remove(id)
  }

  /** The newest setpoint for robot `id`, judged on read: `seq` a whole number, the arrays empty or the joints' length and finite. */
  targets(id: number, seq: unknown, q: unknown, qd: unknown, tau: unknown, now: number): void {
    const r = this.#robots.get(id)
    if (!r) throw new Error(`robotTargets: no robot ${id}`)
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) throw new Error('robotTargets: seq must be a whole number')
    const n = r.body.movable.length
    const qs = finiteList(q, n, 'robotTargets: q')
    if (qs.length !== n) throw new Error(`robotTargets: q must have ${n} entries`)
    r.latest = { at: now, seq, q: qs, qd: finiteList(qd, n, 'robotTargets: qd'), tau: finiteList(tau, n, 'robotTargets: tau') }
  }

  /** The mode and, for `filter`, the calibrated lag: `tauMs` ≥ 0 and `delaySteps` a whole number up to the bound (each kept when not given). */
  mode(id: number, mode: unknown, tauMs?: unknown, delaySteps?: unknown): void {
    const r = this.#robots.get(id)
    if (!r) throw new Error(`robotMode: no robot ${id}`)
    if (mode !== 'follow' && mode !== 'filter' && mode !== 'hold') throw new Error(`robotMode: unknown mode ${JSON.stringify(mode)}`)
    if (tauMs !== undefined) {
      if (typeof tauMs !== 'number' || !Number.isFinite(tauMs) || tauMs < 0 || tauMs > ROBOT_REALM.maxTauMs) throw new Error(`robotMode: tauMs must be 0..${ROBOT_REALM.maxTauMs}`)
      r.tauMs = tauMs
    }
    if (delaySteps !== undefined) {
      if (typeof delaySteps !== 'number' || !Number.isInteger(delaySteps) || delaySteps < 0 || delaySteps > ROBOT_REALM.maxDelaySteps) throw new Error(`robotMode: delaySteps must be 0..${ROBOT_REALM.maxDelaySteps}`)
      r.delaySteps = delaySteps
    }
    r.mode = mode
  }

  /**
   * Once per step, before the substeps: every body's delay line takes this step's newest setpoint (or keeps carrying
   * the last), and what the substeps drive toward is chosen: the delayed setpoint in `filter`, the newest in `follow`,
   * none in `hold` or when the newest is stale.
   */
  tend(now: number): void {
    for (const r of this.#robots.values()) {
      r.delay.push(r.latest)
      const stale = !r.latest || (now - r.latest.at) * 1000 > ROBOT_REALM.staleMs
      if (r.mode === 'hold' || stale) {
        r.current = null
        r.holding = true
        continue
      }
      r.current = r.mode === 'filter' ? (r.delay.read(r.delaySteps) ?? null) : r.latest
      r.holding = r.current === null
    }
  }

  /** Every substep of `h` seconds: measure, then drive each body toward its current setpoint, or hold it. Never throws. */
  drive(h: number, now: number): void {
    for (const r of this.#robots.values()) {
      const b = r.body
      try {
        measure(b, h)
        if (!sane(b)) {
          this.#lose(r, 'its body stopped being finite')
          continue
        }
        const s = r.current
        if (!s) {
          hold(b, h)
          continue
        }
        const n = b.movable.length
        const q = this.#scratch, qd = this.#scratch.subarray(n, 2 * n), tau = this.#scratch.subarray(2 * n, 3 * n)
        for (let i = 0; i < n; i++) { qd[i] = i < s.qd.length ? s.qd[i] : 0; tau[i] = i < s.tau.length ? s.tau[i] : 0 }
        if (r.mode === 'follow') {
          // The newest frame carried forward by its own speed, for a little while; then held where it said.
          const dt = Math.min(ROBOT_REALM.followHoldMs / 1000, Math.max(0, now - s.at))
          for (let i = 0; i < n; i++) q[i] = s.q[i] + qd[i] * dt
        } else {
          // The filtered setpoint: seeded where the body stands, then eased toward the (delayed) setpoint at the
          // calibrated time constant; a time constant of 0 passes it through.
          if (!r.seeded) { for (let i = 0; i < n; i++) r.filtered[i] = b.movable[i].q; r.seeded = true }
          const alpha = r.tauMs > 0 ? 1 - Math.exp(-h * 1000 / r.tauMs) : 1
          for (let i = 0; i < n; i++) { r.filtered[i] += (s.q[i] - r.filtered[i]) * alpha; q[i] = r.filtered[i]; qd[i] *= alpha }
        }
        drive(b, { q: q.subarray(0, n), qd, tau }, h)
      } catch (e) {
        this.#lose(r, e instanceof Error ? e.message : String(e))
      }
    }
  }

  /**
   * Writes every body's slot into `out` (JOINT_SLOT.words each, at least MAX_ROBOTS of them, in spawn order) and
   * returns how many; the first unused slot's `joints` word is zeroed so a reader stops there.
   */
  write(out: Float32Array): number {
    let i = 0
    for (const r of this.#robots.values()) {
      if (i >= MAX_ROBOTS) break
      const at = i * JOINT_SLOT.words, b = r.body, n = b.movable.length
      out[at + JOINT_SLOT.id] = r.id
      out[at + JOINT_SLOT.joints] = n
      out[at + JOINT_SLOT.links] = b.bodies.length
      out[at + JOINT_SLOT.flags] = r.holding ? JOINT_FLAG.holding : 0
      out[at + JOINT_SLOT.ack] = r.current ? r.current.seq : r.latest ? r.latest.seq : -1
      for (let k = 0; k < n; k++) {
        const mv = b.movable[k]
        out[at + JOINT_SLOT.q + k] = mv.q
        out[at + JOINT_SLOT.qd + k] = mv.qd
        out[at + JOINT_SLOT.tau + k] = mv.tau
      }
      for (let l = 0; l < b.bodies.length && l < MAX_LINKS; l++) {
        linkPose(b, l, this.#pose, 0)
        out.set(this.#pose, at + JOINT_SLOT.poses + l * JOINT_SLOT.poseStride)
      }
      i++
    }
    if (i < MAX_ROBOTS) out[i * JOINT_SLOT.words + JOINT_SLOT.joints] = 0
    return i
  }

  #lose(r: Robot, why: string): void {
    this.#robots.delete(r.id)
    try { removeArticulated(this.#world, r.body) } catch { /* the world is in whatever state it is; the audit will say */ }
    this.#lost.push(`robot ${r.id} left the realm: ${why}`)
  }
}
