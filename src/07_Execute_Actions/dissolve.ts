/**
 * Why does this file exist? The code dissolve's page-side half: which mesh the user's body is inside this frame, and
 * how far dissolved each one is. When the avatar (on foot) or the driven car's chassis (at the wheel) meets a lamp, a
 * tree, a signal pole, a pedestrian or (on foot) a car, that mesh dissolves into falling green binary code at once
 * and reinstantiates over `release` once the body is clear (01_Initialize_World/codeDissolve.ts draws it from the
 * amounts kept here). This file owns the amounts: one float per instance of each mesh, the touch that sets one to 1,
 * the update that lets untouched ones fall back, the dirty range each buffer needs re-uploaded, and the count of
 * passages. The identities come from the allocation-free scans in contact.ts (PoleIndex.within, peopleWithin,
 * carsWithin); poleSlot maps a pole's index in that one list to its mesh and slot.
 * - View-only, like the contact wipe: it reads what the page already holds and writes instance attributes. Nothing
 *   reaches the physics realm; no pedestrian moves, no pole stops anyone.
 * - Pure and allocation-free per frame, so it is tested here without a GPU.
 * What breaks if it is removed? Every mesh stays solid: the camera clips through a lamp's pole or a person's body
 * with no transition, and the "falling green binary code" the product promises never shows.
 */
import type { Furniture } from '../01_Initialize_World/city.ts'
import { chassisBox } from './car.ts'
import { GHOST_COLOR } from './ghost.ts'
import { POSE } from './simProtocol.ts'

/** The envelope and the reach. */
export const DISSOLVE = Object.freeze({
  /** How far past its collider the intersection test grows, m, so a mesh is gone before the near plane clips it. */
  reach: 0.25,
  /** Seconds for a mesh to reinstantiate after the intersection clears. */
  release: 0.35,
  /** How many of each the scans report per frame (a body meets no more at once). */
  maxPoles: 8,
  maxPeople: 8,
  maxCars: 4,
})

/** The meshes that dissolve, each with a buffer of amounts: one float per instance. */
export const DISSOLVE_KINDS = Object.freeze(['lamps', 'trees', 'signals', 'cars', 'people'] as const)
export type DissolveKind = (typeof DISSOLVE_KINDS)[number]

/** The ink of each kind: the ghost view's greens, so a dissolving mesh matches the wipe's colour (linear RGB). */
export const DISSOLVE_COLOR: Readonly<Record<DissolveKind, readonly [number, number, number]>> = Object.freeze({
  lamps: GHOST_COLOR.pole,
  trees: GHOST_COLOR.pole,
  signals: GHOST_COLOR.pole,
  cars: GHOST_COLOR.vehicle,
  people: GHOST_COLOR.person,
})

/** A pole's mesh and slot. */
export interface PoleSlot {
  list: 'lamps' | 'trees' | 'signals'
  index: number
}

/**
 * The mesh slot of pole `i` of a PoleIndex (contact.ts): the index concatenates the lamps, then the trees, then the
 * signals, the same order ghost.ts's proxies and world.ts's instances take, so instance `index` of that mesh is the
 * pole. Null when out of range.
 */
export function poleSlot(i: number, f: Furniture): PoleSlot | null {
  if (!Number.isInteger(i) || i < 0) return null
  const lamps = f.lamps.length, trees = f.trees.length, signals = f.signals.length
  if (i < lamps) return { list: 'lamps', index: i }
  if (i < lamps + trees) return { list: 'trees', index: i - lamps }
  if (i < lamps + trees + signals) return { list: 'signals', index: i - lamps - trees }
  return null
}

/**
 * Copies a buffer's dirty range into `into`, `stride` floats per slot (the fleet's wheels take four per car), and
 * returns how many floats were written; nothing when the buffer is clean. The caller marks the attribute and cleans.
 */
export function copyDirty(b: DissolveBuffer, into: Float32Array, stride = 1): number {
  if (!b.dirty || !(stride >= 1)) return 0
  const end = Math.min(b.dirtyEnd, b.values.length, Math.floor(into.length / stride))
  let n = 0
  for (let i = b.dirtyStart; i < end; i++) {
    const v = b.values[i]
    for (let k = 0; k < stride; k++) into[i * stride + k] = v
    n += stride
  }
  return n
}

/** Whether two chassis footprints (centres, headings as boxGap takes them, half extents) overlap: a separating axis test. */
function footprintsOverlap(ax: number, az: number, ah: number, al: number, aw: number, bx: number, bz: number, bh: number, bl: number, bw: number): boolean {
  const dx = bx - ax, dz = bz - az
  const afx = Math.sin(ah), afz = Math.cos(ah), bfx = Math.sin(bh), bfz = Math.cos(bh)
  // The four candidate axes: each box's length axis (forward) and width axis (across).
  const axes: [number, number][] = [[afx, afz], [afz, -afx], [bfx, bfz], [bfz, -bfx]]
  for (const [x, z] of axes) {
    const ra = al * Math.abs(afx * x + afz * z) + aw * Math.abs(afz * x - afx * z)
    const rb = bl * Math.abs(bfx * x + bfz * z) + bw * Math.abs(bfz * x - bfx * z)
    if (Math.abs(dx * x + dz * z) > ra + rb) return false
  }
  return true
}

/**
 * Which cars' chassis footprints (grown by `pad`) overlap another car's, from the poses alone: their indices into
 * `out`, at most out.length, returning how many. Phase 7.1 lets cars pass through cars; both dissolve so the
 * passage is never seen as interpenetration. `skip` (the driven car, which never dissolves) is never reported, but
 * a car passing through it is. A short pose buffer ends the scan. Allocation-free beyond the axes.
 */
export function carsOverlapping(poses: Float32Array, suv: readonly boolean[], pad: number, out: Int32Array, skip = -1): number {
  if (out.length === 0 || !Number.isFinite(pad)) return 0
  const n = Math.min(suv.length, Math.floor(poses.length / POSE.stride))
  let found = 0
  for (let i = 0; i < n; i++) {
    if (i === skip) continue
    const oi = i * POSE.stride, ci = chassisBox(suv[i])
    const ix = poses[oi + POSE.x], iz = poses[oi + POSE.z], ih = poses[oi + POSE.heading]
    const il = ci.hx + pad, iw = ci.hz + pad
    const reach = Math.hypot(il, iw)
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const oj = j * POSE.stride, cj = chassisBox(suv[j])
      const jx = poses[oj + POSE.x], jz = poses[oj + POSE.z]
      const jl = cj.hx + pad, jw = cj.hz + pad
      // Far apart by their bounding circles: no overlap possible.
      if (Math.hypot(jx - ix, jz - iz) > reach + Math.hypot(jl, jw)) continue
      if (footprintsOverlap(ix, iz, ih, il, iw, jx, jz, poses[oj + POSE.heading], jl, jw)) {
        out[found++] = i
        break
      }
    }
    if (found === out.length) break
  }
  return found
}

/**
 * One mesh's amounts: `values[i]` is how far instance i has dissolved (0 solid, 1 gone). `dirtyStart`..`dirtyEnd`
 * (exclusive) is the range changed since the last `clean()`; the wiring uploads it and cleans. `active` is how many
 * instances are above 0.
 */
export class DissolveBuffer {
  readonly values: Float32Array
  dirtyStart = 0
  dirtyEnd = 0
  active = 0
  /** Touched this frame, touched last frame (bit 0, bit 1). */
  readonly flags: Uint8Array
  /** The active instances, unordered, and each instance's position in that list (−1 when inactive). */
  readonly live: Int32Array
  readonly at: Int32Array

  constructor(slots: number) {
    const n = Math.max(0, Math.floor(Number.isFinite(slots) ? slots : 0))
    this.values = new Float32Array(n)
    this.flags = new Uint8Array(n)
    this.live = new Int32Array(n)
    this.at = new Int32Array(n).fill(-1)
  }

  get dirty(): boolean { return this.dirtyEnd > this.dirtyStart }

  clean(): void { this.dirtyStart = 0; this.dirtyEnd = 0 }

  mark(i: number): void {
    if (!this.dirty) { this.dirtyStart = i; this.dirtyEnd = i + 1; return }
    if (i < this.dirtyStart) this.dirtyStart = i
    if (i + 1 > this.dirtyEnd) this.dirtyEnd = i + 1
  }

  activate(i: number): void {
    if (this.at[i] >= 0) return
    this.at[i] = this.active
    this.live[this.active++] = i
  }

  deactivate(i: number): void {
    const p = this.at[i]
    if (p < 0) return
    const last = this.live[--this.active]
    this.live[p] = last
    this.at[last] = p
    this.at[i] = -1
  }
}

const TOUCHED = 1
const HELD = 2

/**
 * The amounts of every dissolving mesh, and their envelope: `touch(kind, index)` puts a slot at 1 at once (the mesh
 * dissolves the frame the body meets it); `update(dt)` lets every slot not touched since the last update fall to 0
 * over DISSOLVE.release, and holds a touched one at 1. `count` is every passage (a slot touched that was not touched
 * the frame before); `active` is how many slots are above 0.
 */
export class DissolveSet {
  readonly lamps: DissolveBuffer
  readonly trees: DissolveBuffer
  readonly signals: DissolveBuffer
  readonly cars: DissolveBuffer
  readonly people: DissolveBuffer
  count = 0

  constructor(slots: Readonly<Record<DissolveKind, number>>) {
    this.lamps = new DissolveBuffer(slots.lamps)
    this.trees = new DissolveBuffer(slots.trees)
    this.signals = new DissolveBuffer(slots.signals)
    this.cars = new DissolveBuffer(slots.cars)
    this.people = new DissolveBuffer(slots.people)
  }

  buffer(kind: DissolveKind): DissolveBuffer { return this[kind] }

  get active(): number {
    let n = 0
    for (const k of DISSOLVE_KINDS) n += this[k].active
    return n
  }

  /** The body is inside instance `index` of `kind` this frame: fully dissolved at once. An index out of range is ignored. */
  touch(kind: DissolveKind, index: number): void {
    const b = this[kind]
    if (!Number.isInteger(index) || index < 0 || index >= b.values.length) return
    if ((b.flags[index] & (TOUCHED | HELD)) === 0) this.count++
    b.flags[index] |= TOUCHED
    if (b.values[index] !== 1) { b.values[index] = 1; b.mark(index) }
    b.activate(index)
  }

  /**
   * One frame: touched slots stay at 1, the rest fall by dt / release, reaching exactly 0. A broken interval (not a
   * number, or negative) moves nothing; a long one is clamped to 0.25 s like the contact pulse.
   */
  update(dt: number): void {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) / DISSOLVE.release : 0
    for (const k of DISSOLVE_KINDS) {
      const b = this[k]
      for (let p = b.active - 1; p >= 0; p--) {
        const i = b.live[p]
        if (b.flags[i] & TOUCHED) { b.flags[i] = HELD; continue }
        b.flags[i] = 0
        if (step === 0) continue
        const next = Math.max(0, b.values[i] - step)
        if (next !== b.values[i]) { b.values[i] = next; b.mark(i) }
        if (next === 0) b.deactivate(i)
      }
    }
  }
}
