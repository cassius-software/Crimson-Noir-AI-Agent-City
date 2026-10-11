// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the zero-copy memory bridge between the physics realm and the page: one buffer
 * both sides view at once, holding where every vehicle, every avatar and every pedestrian stands (x, y, z) and the
 * state each is in, as plain machine words. The realm writes it after every step; the page reads it whenever it
 * likes, with no message, no structured clone and no allocation in between. Over a SharedArrayBuffer (the page is
 * cross-origin isolated: vite.config.ts sends the COOP and COEP headers) the realm's own writes are the page's reads;
 * over a plain ArrayBuffer (the single file opened from disk, or a server without those headers) the layout, the
 * views and the lock are the same, and the page itself fills it from the step state it was handed, so every reader
 * is written once against one layout.
 *
 * The lock is a strict spinlock on one Int32 word with `Atomics.compareExchange` (0 free, 1 held), released with
 * `Atomics.store` and `Atomics.notify`. The writer (the realm, in its worker) spins a bounded number of times and
 * then may wait on the word (a worker may block; a main thread may not), so a slow reader delays a publish by at most
 * one read. A reader on the main thread never blocks: it tries the lock a bounded number of times and, if a write is
 * in progress, keeps what it read last. Every write happens under the lock, so a reader that holds it never sees a
 * torn slot. Pure: no DOM, no worker API, no import; the node tests drive it with worker_threads.
 * What breaks if it is removed? Every position the page wants between two states has to be copied out of a message
 * again, and the realm and the page have no word of memory in common.
 */

/** One entity's slot: three Float32 coordinates and one Int32 state word, at these word offsets. */
export const SLOT = Object.freeze({ x: 0, y: 1, z: 2, state: 3, stride: 4 } as const)

/**
 * The header, in Int32 words. `lock` is the spinlock word; `seq` counts publishes (the page can tell a fresh
 * reading from a repeat); `step` is the realm's step id of the newest publish; the three counts say how the body is
 * laid out; `driving` holds four words, one per local player: the index of the car they drive, or −1 on foot;
 * `simTimeMs` is the realm's clock in whole milliseconds. Sixteen words, so the body starts 64-byte aligned.
 */
export const HEADER = Object.freeze({ lock: 0, seq: 1, step: 2, vehicles: 3, avatars: 4, agents: 5, driving: 6, simTimeMs: 10, words: 16 } as const)

/** How many of each the bridge holds slots for. */
export interface BridgeCounts { vehicles: number; avatars: number; agents: number }

/** Spins a reader tries before giving up on a contended lock (a write takes a few microseconds). */
export const READ_SPINS = 64
/** Spins a writer tries before waiting on the lock word (in a worker) or giving the step up (on a main thread). */
export const WRITE_SPINS = 256
/** Longest a writer waits on the lock word, ms: a reader that holds the lock longer has hung, and the step is skipped. */
export const WRITE_WAIT_MS = 2

const isCount = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 1 << 20

/** The buffer's size in bytes for these counts. */
export function bridgeBytes(c: BridgeCounts): number {
  if (!isCount(c.vehicles) || !isCount(c.avatars) || !isCount(c.agents)) throw new RangeError('bridge counts must be integers from 0 to 2^20')
  return 4 * (HEADER.words + SLOT.stride * (c.vehicles + c.avatars + c.agents))
}

/** Whether this global can share memory with a worker: SharedArrayBuffer exists and the page is cross-origin isolated. */
export function canShareMemory(g: { SharedArrayBuffer?: unknown; crossOriginIsolated?: boolean } = globalThis as never): boolean {
  return typeof g.SharedArrayBuffer === 'function' && g.crossOriginIsolated === true
}

/** Takes the lock word: true once held, false if it stayed held by someone else for every spin (and the wait, if any). */
export function acquire(lock: Int32Array, spins: number, waitMs = 0): boolean {
  for (let i = 0; i < spins; i++) if (Atomics.compareExchange(lock, HEADER.lock, 0, 1) === 0) return true
  if (waitMs > 0 && lock.buffer instanceof SharedArrayBuffer) {
    try {
      // Blocks only while the word reads 1 (held); a main thread throws here, which is caught: it never blocks.
      Atomics.wait(lock, HEADER.lock, 1, waitMs)
    } catch {
      return false
    }
    return Atomics.compareExchange(lock, HEADER.lock, 0, 1) === 0
  }
  return false
}

/** Frees the lock word and wakes one waiter. */
export function release(lock: Int32Array): void {
  Atomics.store(lock, HEADER.lock, 0)
  Atomics.notify(lock, HEADER.lock, 1)
}

/**
 * The bridge over one buffer: the header and the body as Float32 and Int32 views of the same words. `vehicles`,
 * `avatars` and `agents` are the word offsets (into `f32` and `i32`) of each section's first slot.
 */
export class PhysicsBridge {
  readonly buffer: SharedArrayBuffer | ArrayBuffer
  readonly shared: boolean
  readonly counts: Readonly<BridgeCounts>
  readonly header: Int32Array
  readonly f32: Float32Array
  readonly i32: Int32Array
  readonly vehicles: number
  readonly avatars: number
  readonly agents: number

  private constructor(buffer: SharedArrayBuffer | ArrayBuffer, counts: BridgeCounts) {
    this.buffer = buffer
    this.shared = typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer
    this.counts = Object.freeze({ ...counts })
    this.header = new Int32Array(buffer, 0, HEADER.words)
    this.f32 = new Float32Array(buffer)
    this.i32 = new Int32Array(buffer)
    this.vehicles = HEADER.words
    this.avatars = this.vehicles + SLOT.stride * counts.vehicles
    this.agents = this.avatars + SLOT.stride * counts.avatars
    Object.freeze(this)
  }

  /**
   * A new bridge: over a SharedArrayBuffer when `shared` (the caller has checked canShareMemory), else over a plain
   * ArrayBuffer of the same layout. The counts are written into the header; every slot starts at zero.
   */
  static create(counts: BridgeCounts, shared: boolean): PhysicsBridge {
    const bytes = bridgeBytes(counts)
    const buffer = shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes)
    const b = new PhysicsBridge(buffer, counts)
    b.header[HEADER.vehicles] = counts.vehicles
    b.header[HEADER.avatars] = counts.avatars
    b.header[HEADER.agents] = counts.agents
    for (let k = 0; k < 4; k++) b.header[HEADER.driving + k] = -1
    return b
  }

  /**
   * The other side of a bridge someone else made (the realm, handed the page's SharedArrayBuffer): null unless it is
   * a SharedArrayBuffer of exactly the size these counts need, with those counts in its header.
   */
  static open(buffer: unknown, counts: BridgeCounts): PhysicsBridge | null {
    if (typeof SharedArrayBuffer !== 'function' || !(buffer instanceof SharedArrayBuffer)) return null
    if (buffer.byteLength !== bridgeBytes(counts)) return null
    const h = new Int32Array(buffer, 0, HEADER.words)
    if (h[HEADER.vehicles] !== counts.vehicles || h[HEADER.avatars] !== counts.avatars || h[HEADER.agents] !== counts.agents) return null
    return new PhysicsBridge(buffer, counts)
  }

  /** The publish count so far (a reader compares two readings' seq to tell a fresh one). */
  get seq(): number {
    return Atomics.load(this.header, HEADER.seq)
  }

  /** The realm's step id of the newest publish. */
  get step(): number {
    return Atomics.load(this.header, HEADER.step)
  }

  /**
   * Writes one step under the lock: `fill` writes the body through the views, then the header is stamped with the
   * step id, the clock and who drives what, and the publish count goes up. False, with nothing written, if the lock
   * could not be taken (a reader held it for every spin and the wait): the step is skipped, the previous one stands,
   * and the next publish carries newer values anyway.
   */
  publish(step: number, simTime: number, drivings: ArrayLike<number>, fill: (f32: Float32Array, i32: Int32Array, bridge: PhysicsBridge) => void): boolean {
    if (!acquire(this.header, WRITE_SPINS, this.shared ? WRITE_WAIT_MS : 0)) return false
    try {
      fill(this.f32, this.i32, this)
      const h = this.header
      h[HEADER.step] = step | 0
      h[HEADER.simTimeMs] = Math.min(2147483647, Math.max(0, Math.round(simTime * 1000))) | 0
      for (let k = 0; k < 4; k++) h[HEADER.driving + k] = k < drivings.length ? drivings[k] | 0 : -1
      Atomics.add(h, HEADER.seq, 1)
    } finally {
      release(this.header)
    }
    return true
  }

  /**
   * Reads under the lock, never blocking: `read` runs with the lock held and its value is returned; undefined if a
   * write was in progress for every spin (keep the last reading). A main thread may call this freely.
   */
  read<T>(read: (f32: Float32Array, i32: Int32Array, bridge: PhysicsBridge) => T): T | undefined {
    if (!acquire(this.header, READ_SPINS)) return undefined
    try {
      return read(this.f32, this.i32, this)
    } finally {
      release(this.header)
    }
  }

  /** Copies every pedestrian's x, z (2 floats each) into `out` under the lock; false (nothing copied) if contended. */
  agentXZ(out: Float32Array): boolean {
    const n = this.counts.agents
    if (out.length < 2 * n) throw new RangeError(`agentXZ needs ${2 * n} floats, got ${out.length}`)
    return this.read((f) => {
      for (let i = 0, o = this.agents; i < n; i++, o += SLOT.stride) {
        out[2 * i] = f[o + SLOT.x]
        out[2 * i + 1] = f[o + SLOT.z]
      }
      return true
    }) === true
  }

  /** The realm's clock at the newest publish, s. */
  get simTime(): number {
    return Atomics.load(this.header, HEADER.simTimeMs) / 1000
  }

  /** The car local player k drives at the newest publish, or −1. */
  driving(k: number): number {
    return k >= 0 && k < 4 ? Atomics.load(this.header, HEADER.driving + k) : -1
  }
}

/** Vehicle i's slot from the pose buffer: x, y, z and the drive mode word (POSE.mode as the fleet stores it). */
export function packVehicles(f32: Float32Array, i32: Int32Array, at: number, poses: Float32Array, count: number, stride: number, modeAt: number): void {
  for (let i = 0, o = at, p = 0; i < count; i++, o += SLOT.stride, p += stride) {
    f32[o + SLOT.x] = poses[p]
    f32[o + SLOT.y] = poses[p + 1]
    f32[o + SLOT.z] = poses[p + 2]
    i32[o + SLOT.state] = poses[p + modeAt] | 0
  }
}

/** Avatar states as the realm reports them. The state word packs `enabled` (bit 0) and `sensor` (bit 1). */
export function packAvatars(f32: Float32Array, i32: Int32Array, at: number, avatars: readonly { x: number; y: number; z: number; enabled: boolean; sensor: boolean }[], count: number): void {
  for (let k = 0, o = at; k < count; k++, o += SLOT.stride) {
    const a = avatars[k]
    if (!a) continue
    f32[o + SLOT.x] = a.x
    f32[o + SLOT.y] = a.y
    f32[o + SLOT.z] = a.z
    i32[o + SLOT.state] = (a.enabled ? 1 : 0) | (a.sensor ? 2 : 0)
  }
}

/**
 * Pedestrians from a crowd render frame (the frame's first 4 floats per person are x, y, z, heading) with each
 * person's activity code (crowdSensor.ts CrowdReadout.activity) as the state word, 0 when no readout names one.
 */
export function packAgents(f32: Float32Array, i32: Int32Array, at: number, frame: Float32Array, count: number, activity: Uint8Array | null): void {
  if (frame.length < 4 * count) return
  for (let i = 0, o = at, p = 0; i < count; i++, o += SLOT.stride, p += 4) {
    f32[o + SLOT.x] = frame[p]
    f32[o + SLOT.y] = frame[p + 1]
    f32[o + SLOT.z] = frame[p + 2]
    i32[o + SLOT.state] = activity && i < activity.length ? activity[i] : 0
  }
}
