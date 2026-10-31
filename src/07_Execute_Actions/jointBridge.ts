// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the joint bridge's zero-copy half (docs/joint-bridge-spec.md §5): one buffer the
 * realm writes after every step with every robot body's joints (q, q̇, τ) and link poses, and the page reads whenever
 * it likes, with no message, no structured clone and no allocation in between. It is the pattern of sharedBridge.ts
 * over a second buffer with its own lock and header, laid out in fixed slots (MAX_ROBOTS of them, each MAX_JOINTS
 * joints and MAX_LINKS links), so the layout never depends on which robots exist. The realm fills a scratch of the
 * same slot words (jointRealm.ts write) and the host copies it in under the lock; without shared memory (the page
 * opened from a file) the same scratch travels in StepState.robots and the page copies it into its own buffer of
 * this layout, so every reader is written once. Setpoints never pass through here: they go in as commands.
 * What breaks if it is removed? The page has no robot joints to draw or to send out, and the realm has nowhere to
 * put them but a message a frame.
 */
import { acquire, READ_SPINS, release, WRITE_SPINS, WRITE_WAIT_MS } from './sharedBridge.ts'
import { MAX_JOINTS, MAX_ROBOTS } from '../04_Connect_Hardware/jointState.ts'

/** Most links a body in the realm may have (jointState.ts buildManifest holds a manifest to as many). */
export const MAX_LINKS = 32

/**
 * The header, in Int32 words: `lock` is the spinlock word (sharedBridge.ts acquire/release read index 0 of the view
 * given), `seq` counts publishes, `step` is the realm's step id of the newest publish, `robots` how many slots are
 * filled, `simTimeMs` the realm's clock. Sixteen words, so the slots start 64-byte aligned.
 */
export const JOINT_HEADER = Object.freeze({ lock: 0, seq: 1, step: 2, robots: 3, simTimeMs: 4, words: 16 } as const)

/**
 * One robot's slot, in Float32 words from the slot's start: eight slot words (`id`, `joints`, `links`, `flags`, `ack`
 * and three reserved; small whole numbers, exact in a float), then q, q̇ and τ (MAX_JOINTS each, the manifest's
 * movable order), then MAX_LINKS link poses of seven (x, y, z, qx, qy, qz, qw in the world frame).
 */
export const JOINT_SLOT = Object.freeze({
  id: 0, joints: 1, links: 2, flags: 3, ack: 4,
  q: 8, qd: 8 + MAX_JOINTS, tau: 8 + 2 * MAX_JOINTS, poses: 8 + 3 * MAX_JOINTS, poseStride: 7,
  words: 8 + 3 * MAX_JOINTS + 7 * MAX_LINKS,
} as const)

/** The slot's `flags` word. `holding`: the body stands at its effort cap, with no setpoint or a stale one. */
export const JOINT_FLAG = Object.freeze({ holding: 1 } as const)

/** The buffer's size in bytes: the header and MAX_ROBOTS slots. */
export const JOINT_BYTES = 4 * (JOINT_HEADER.words + MAX_ROBOTS * JOINT_SLOT.words)

/** The joint buffer over one SharedArrayBuffer (or a plain one of the same layout on a page without shared memory). */
export class JointBuffer {
  readonly buffer: SharedArrayBuffer | ArrayBuffer
  readonly shared: boolean
  readonly header: Int32Array
  readonly f32: Float32Array

  private constructor(buffer: SharedArrayBuffer | ArrayBuffer) {
    this.buffer = buffer
    this.shared = typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer
    this.header = new Int32Array(buffer, 0, JOINT_HEADER.words)
    this.f32 = new Float32Array(buffer)
    Object.freeze(this)
  }

  /** A new buffer: shared when `shared` (the caller has checked canShareMemory), else plain; every word zero. */
  static create(shared: boolean): JointBuffer {
    return new JointBuffer(shared ? new SharedArrayBuffer(JOINT_BYTES) : new ArrayBuffer(JOINT_BYTES))
  }

  /** The other side of a buffer someone else made: null unless it is a SharedArrayBuffer of exactly this layout's size. */
  static open(buffer: unknown): JointBuffer | null {
    if (typeof SharedArrayBuffer !== 'function' || !(buffer instanceof SharedArrayBuffer)) return null
    if (buffer.byteLength !== JOINT_BYTES) return null
    return new JointBuffer(buffer)
  }

  /** The Float32 index where slot `i` starts. */
  static slot(i: number): number {
    return JOINT_HEADER.words + i * JOINT_SLOT.words
  }

  get seq(): number { return Atomics.load(this.header, JOINT_HEADER.seq) }
  get step(): number { return Atomics.load(this.header, JOINT_HEADER.step) }
  get robots(): number { return Atomics.load(this.header, JOINT_HEADER.robots) }
  get simTime(): number { return Atomics.load(this.header, JOINT_HEADER.simTimeMs) / 1000 }

  /**
   * Writes one step under the lock: the first `robots` slots are copied in from `slots` (the realm's scratch, at least
   * `robots × JOINT_SLOT.words` long; null means none), the header is stamped and the publish count goes up. False,
   * with nothing written, if the lock could not be taken: the step is skipped and the next publish carries newer values.
   */
  publish(step: number, simTime: number, slots: Float32Array | null): boolean {
    const robots = slots ? Math.min(MAX_ROBOTS, Math.floor(slots.length / JOINT_SLOT.words)) : 0
    if (!acquire(this.header, WRITE_SPINS, this.shared ? WRITE_WAIT_MS : 0)) return false
    try {
      if (slots && robots > 0) this.f32.set(slots.subarray(0, robots * JOINT_SLOT.words), JOINT_HEADER.words)
      const h = this.header
      h[JOINT_HEADER.robots] = robots
      h[JOINT_HEADER.step] = step | 0
      h[JOINT_HEADER.simTimeMs] = Math.min(2147483647, Math.max(0, Math.round(simTime * 1000))) | 0
      Atomics.add(h, JOINT_HEADER.seq, 1)
    } finally {
      release(this.header)
    }
    return true
  }

  /**
   * Copies the filled slots out under the lock, never blocking: into `out` (at least MAX_ROBOTS × JOINT_SLOT.words
   * long), returning how many slots were copied, or −1 if a write was in progress for every spin (keep the last copy).
   */
  snapshot(out: Float32Array): number {
    if (out.length < MAX_ROBOTS * JOINT_SLOT.words) throw new RangeError(`snapshot needs ${MAX_ROBOTS * JOINT_SLOT.words} floats, got ${out.length}`)
    if (!acquire(this.header, READ_SPINS)) return -1
    try {
      const robots = this.header[JOINT_HEADER.robots]
      if (robots > 0) out.set(this.f32.subarray(JOINT_HEADER.words, JOINT_HEADER.words + robots * JOINT_SLOT.words))
      return robots
    } finally {
      release(this.header)
    }
  }
}

/** A reading of one slot out of a snapshot (the page's view of one robot body). */
export interface SlotView {
  readonly id: number
  readonly joints: number
  readonly links: number
  readonly flags: number
  readonly ack: number
  /** Views into the snapshot: valid until the next snapshot overwrites it. */
  readonly q: Float32Array
  readonly qd: Float32Array
  readonly tau: Float32Array
  /** `links × 7` floats: x, y, z, qx, qy, qz, qw per link. */
  readonly poses: Float32Array
}

/** Slot `i` of a snapshot (JointBuffer.snapshot's `out`) as a view; null for an empty slot. */
export function slotView(snapshot: Float32Array, i: number): SlotView | null {
  const at = i * JOINT_SLOT.words
  if (i < 0 || i >= MAX_ROBOTS || at + JOINT_SLOT.words > snapshot.length) return null
  const joints = snapshot[at + JOINT_SLOT.joints] | 0, links = snapshot[at + JOINT_SLOT.links] | 0
  if (joints <= 0 || joints > MAX_JOINTS || links <= 0 || links > MAX_LINKS) return null
  return {
    id: snapshot[at + JOINT_SLOT.id] | 0, joints, links, flags: snapshot[at + JOINT_SLOT.flags] | 0, ack: snapshot[at + JOINT_SLOT.ack],
    q: snapshot.subarray(at + JOINT_SLOT.q, at + JOINT_SLOT.q + joints),
    qd: snapshot.subarray(at + JOINT_SLOT.qd, at + JOINT_SLOT.qd + joints),
    tau: snapshot.subarray(at + JOINT_SLOT.tau, at + JOINT_SLOT.tau + joints),
    poses: snapshot.subarray(at + JOINT_SLOT.poses, at + JOINT_SLOT.poses + links * JOINT_SLOT.poseStride),
  }
}
