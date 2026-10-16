// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? Ghost-mode collision has no impact to show, so the page shows the passage instead: when
 * the user's body (the avatar on foot, the driven car's chassis at the wheel) meets a lamp, a tree, a signal pole, a
 * pedestrian or (on foot) a car, that mesh alone dissolves into falling code (dissolve.ts over
 * 01_Initialize_World/codeDissolve.ts); nothing is drawn over the frame as a whole. This file decides when: an index
 * of the poles, the nearest person and car, and the pulse that shapes the passage's envelope (telemetry, and the
 * count of passages). It also names which ones: the identity scans (PoleIndex.within/withinBox,
 * peopleWithin/peopleWithinBox, carsWithin) list every pole, person and car the body is inside, for the dissolve.
 * - View-only, like ghost view: it reads what the page already holds (the city's furniture, the worker's audited
 *   state, the crowd's render frame). Nothing reaches the physics realm.
 * - Pure and allocation-free per frame, so it is tested here without a GPU.
 * What breaks if it is removed? Walking through someone clips the camera through their body with no transition,
 * and ghost mode reads as a bug rather than a rule.
 */
import { POLES, type Furniture } from '../01_Initialize_World/city.ts'
import { chassisBox } from './car.ts'
import { PERSON, POSE } from './simProtocol.ts'

/** What was met, as the composite colours it (the ghost view's kinds; 0 = nothing). */
export const CONTACT_KIND = Object.freeze({ none: 0, pole: 2, vehicle: 3, person: 4 })
export type ContactKind = (typeof CONTACT_KIND)[keyof typeof CONTACT_KIND]

/** The pulse and the index. */
export const CONTACT = Object.freeze({
  /** Seconds for the passage envelope to reach 1 once a contact starts. */
  attack: 0.12,
  /** The shortest passage: a glancing touch still holds the envelope at 1 this long, s. */
  hold: 0.2,
  /** Seconds for the envelope to clear after the last contact. */
  release: 0.55,
  /** The pole index's cell edge, m (every pole radius is far smaller). */
  cell: 4,
  /** Farther than this from every person, the scan reports this (m): nothing near enough to matter. */
  far: 1e3,
})

/** A pedestrian's hidden rows (folded far below the street) are not people to meet. */
const HIDDEN_Y = -50

/** The poles of the city in a uniform grid, for the nearest one to a point. */
export class PoleIndex {
  readonly count: number
  private readonly x: Float32Array
  private readonly z: Float32Array
  private readonly r: Float32Array
  private readonly cells = new Map<number, number[]>()

  constructor(f: Furniture) {
    const all: [number, number, number][] = [
      ...f.lamps.map(([x, z]) => [x, z, POLES.lamp.radius] as [number, number, number]),
      ...f.trees.map(([x, z]) => [x, z, POLES.tree.radius] as [number, number, number]),
      ...f.signals.map(([x, z]) => [x, z, POLES.signal.radius] as [number, number, number]),
    ]
    this.count = all.length
    this.x = new Float32Array(all.map((p) => p[0]))
    this.z = new Float32Array(all.map((p) => p[1]))
    this.r = new Float32Array(all.map((p) => p[2]))
    all.forEach(([x, z], i) => {
      const k = PoleIndex.key(Math.floor(x / CONTACT.cell), Math.floor(z / CONTACT.cell))
      const list = this.cells.get(k)
      if (list) list.push(i)
      else this.cells.set(k, [i])
    })
  }

  private static key(cx: number, cz: number): number {
    // Cells from −2^15 to 2^15 each way: a city 131 km across at 4 m.
    return ((cx + 32768) & 0xffff) * 65536 + ((cz + 32768) & 0xffff)
  }

  /**
   * The smallest gap from (x, z) to a pole's surface (negative inside it), over the poles within one cell, or `far`.
   * `pad` grows the point into a disc (the avatar's radius): the gap is then from that disc.
   */
  gap(x: number, z: number, pad = 0): number {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return CONTACT.far
    const cx = Math.floor(x / CONTACT.cell), cz = Math.floor(z / CONTACT.cell)
    let best: number = CONTACT.far
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = this.cells.get(PoleIndex.key(cx + dx, cz + dz))
        if (!list) continue
        for (const i of list) {
          const g = Math.hypot(this.x[i] - x, this.z[i] - z) - this.r[i] - pad
          if (g < best) best = g
        }
      }
    }
    return best
  }

  /** The smallest gap from a car's chassis footprint to a pole's surface (negative when a pole stands in it). */
  gapToBox(cx: number, cz: number, heading: number, halfLength: number, halfWidth: number): number {
    const reach = Math.hypot(halfLength, halfWidth)
    if (!Number.isFinite(cx) || !Number.isFinite(cz) || reach > CONTACT.cell) return CONTACT.far
    const ix = Math.floor(cx / CONTACT.cell), iz = Math.floor(cz / CONTACT.cell)
    let best: number = CONTACT.far
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = this.cells.get(PoleIndex.key(ix + dx, iz + dz))
        if (!list) continue
        for (const i of list) {
          const g = boxGap(this.x[i] - cx, this.z[i] - cz, heading, halfLength, halfWidth) - this.r[i]
          if (g < best) best = g
        }
      }
    }
    return best
  }

  /**
   * Which poles a disc of radius `pad` around (x, z) is inside (gap below 0, the test `gap` makes): their indices into
   * `out`, at most out.length, returning how many. Allocation-free; nothing for a point that is not a number.
   */
  within(x: number, z: number, pad: number, out: Int32Array): number {
    if (!Number.isFinite(x) || !Number.isFinite(z) || out.length === 0) return 0
    const cx = Math.floor(x / CONTACT.cell), cz = Math.floor(z / CONTACT.cell)
    let n = 0
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = this.cells.get(PoleIndex.key(cx + dx, cz + dz))
        if (!list) continue
        for (const i of list) {
          if (Math.hypot(this.x[i] - x, this.z[i] - z) - this.r[i] - pad < 0) {
            out[n++] = i
            if (n === out.length) return n
          }
        }
      }
    }
    return n
  }

  /** As `within`, for a car's chassis footprint (the test `gapToBox` makes): the poles standing in it. */
  withinBox(cx: number, cz: number, heading: number, halfLength: number, halfWidth: number, out: Int32Array): number {
    if (!Number.isFinite(cx) || !Number.isFinite(cz) || !Number.isFinite(heading) || out.length === 0) return 0
    // Every pole in the footprint lies within its reach of the centre: that many cells each way covers them.
    const span = Math.ceil(Math.hypot(halfLength, halfWidth) / CONTACT.cell)
    if (!Number.isFinite(span) || span > 8) return 0
    const ix = Math.floor(cx / CONTACT.cell), iz = Math.floor(cz / CONTACT.cell)
    let n = 0
    for (let dx = -span; dx <= span; dx++) {
      for (let dz = -span; dz <= span; dz++) {
        const list = this.cells.get(PoleIndex.key(ix + dx, iz + dz))
        if (!list) continue
        for (const i of list) {
          if (boxGap(this.x[i] - cx, this.z[i] - cz, heading, halfLength, halfWidth) - this.r[i] < 0) {
            out[n++] = i
            if (n === out.length) return n
          }
        }
      }
    }
    return n
  }
}

/**
 * Gap from a point (relative to a box's centre) to a box of the given half extents, turned to `heading` (forward
 * (sin h, cos h)): positive outside (Euclidean distance to the rectangle), negative inside (minus the depth).
 */
export function boxGap(rx: number, rz: number, heading: number, halfLength: number, halfWidth: number): number {
  const fx = Math.sin(heading), fz = Math.cos(heading)
  const along = Math.abs(rx * fx + rz * fz) - halfLength
  const across = Math.abs(rx * fz - rz * fx) - halfWidth
  if (along <= 0 && across <= 0) return Math.max(along, across)
  return Math.hypot(Math.max(along, 0), Math.max(across, 0))
}

/**
 * The nearest pedestrian to (x, z) in a crowd render frame (pos x, y, z, heading per person first, crowdCompute.ts
 * RENDER_FLOATS), as the gap between their body and a disc of radius `pad` around the point. Row 0 is the avatar and
 * is skipped; hidden rows too. `far` when there is nobody (or no frame).
 */
export function personGap(frame: Float32Array | null, agents: number, x: number, z: number, pad: number): number {
  if (!frame || !Number.isFinite(x) || !Number.isFinite(z)) return CONTACT.far
  const n = Math.min(agents, Math.floor(frame.length / 4))
  let best2 = Infinity
  for (let i = 1; i < n; i++) {
    const o = 4 * i
    if (!(frame[o + 1] > HIDDEN_Y)) continue
    const dx = frame[o] - x, dz = frame[o + 2] - z
    const d2 = dx * dx + dz * dz
    if (d2 < best2) best2 = d2
  }
  return best2 === Infinity ? CONTACT.far : Math.sqrt(best2) - PERSON.radius - pad
}

/** As personGap, from a car's chassis footprint: the smallest gap between it and a pedestrian's body. */
export function personGapToBox(frame: Float32Array | null, agents: number, cx: number, cz: number, heading: number, halfLength: number, halfWidth: number): number {
  if (!frame || !Number.isFinite(cx) || !Number.isFinite(cz)) return CONTACT.far
  const n = Math.min(agents, Math.floor(frame.length / 4))
  const near = halfLength + halfWidth + PERSON.radius + 1
  let best: number = CONTACT.far
  for (let i = 1; i < n; i++) {
    const o = 4 * i
    if (!(frame[o + 1] > HIDDEN_Y)) continue
    const rx = frame[o] - cx, rz = frame[o + 2] - cz
    if (Math.abs(rx) > near || Math.abs(rz) > near) continue
    const g = boxGap(rx, rz, heading, halfLength, halfWidth) - PERSON.radius
    if (g < best) best = g
  }
  return best
}

/** The gap from a disc (x, z, pad) to the nearest car's chassis footprint in a pose buffer, skipping `skip`. */
export function carGap(poses: Float32Array, suv: readonly boolean[], x: number, z: number, pad: number, skip = -1): number {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return CONTACT.far
  let best: number = CONTACT.far
  for (let i = 0; i < suv.length; i++) {
    if (i === skip) continue
    const o = i * POSE.stride
    if (o + POSE.stride > poses.length) break
    const c = chassisBox(suv[i])
    const g = boxGap(x - poses[o + POSE.x], z - poses[o + POSE.z], poses[o + POSE.heading], c.hx, c.hz) - pad
    if (g < best) best = g
  }
  return best
}

/**
 * Which pedestrians a disc of radius `pad` around (x, z) is inside (the test `personGap` makes, per person): their
 * rows into `out`, at most out.length, returning how many. Row 0 (the avatar) and hidden rows are never reported.
 * Allocation-free; nothing without a frame or for a point that is not a number.
 */
export function peopleWithin(frame: Float32Array | null, agents: number, x: number, z: number, pad: number, out: Int32Array): number {
  if (!frame || !Number.isFinite(x) || !Number.isFinite(z) || out.length === 0) return 0
  const n = Math.min(agents, Math.floor(frame.length / 4))
  const reach = PERSON.radius + pad
  const reach2 = reach * reach
  let found = 0
  for (let i = 1; i < n; i++) {
    const o = 4 * i
    if (!(frame[o + 1] > HIDDEN_Y)) continue
    const dx = frame[o] - x, dz = frame[o + 2] - z
    if (dx * dx + dz * dz < reach2) {
      out[found++] = i
      if (found === out.length) break
    }
  }
  return found
}

/** As `peopleWithin`, for a car's chassis footprint (the test `personGapToBox` makes): the people standing in it. */
export function peopleWithinBox(frame: Float32Array | null, agents: number, cx: number, cz: number, heading: number, halfLength: number, halfWidth: number, out: Int32Array): number {
  if (!frame || !Number.isFinite(cx) || !Number.isFinite(cz) || !Number.isFinite(heading) || out.length === 0) return 0
  const n = Math.min(agents, Math.floor(frame.length / 4))
  const near = halfLength + halfWidth + PERSON.radius + 1
  let found = 0
  for (let i = 1; i < n; i++) {
    const o = 4 * i
    if (!(frame[o + 1] > HIDDEN_Y)) continue
    const rx = frame[o] - cx, rz = frame[o + 2] - cz
    if (Math.abs(rx) > near || Math.abs(rz) > near) continue
    if (boxGap(rx, rz, heading, halfLength, halfWidth) - PERSON.radius < 0) {
      out[found++] = i
      if (found === out.length) break
    }
  }
  return found
}

/**
 * Which cars' chassis footprints a disc (x, z, pad) is inside (the test `carGap` makes, per car): their indices into
 * `out`, at most out.length, returning how many; `skip` (the driven car) is never reported. Allocation-free.
 */
export function carsWithin(poses: Float32Array, suv: readonly boolean[], x: number, z: number, pad: number, out: Int32Array, skip = -1): number {
  if (!Number.isFinite(x) || !Number.isFinite(z) || out.length === 0) return 0
  let found = 0
  for (let i = 0; i < suv.length; i++) {
    if (i === skip) continue
    const o = i * POSE.stride
    if (o + POSE.stride > poses.length) break
    const c = chassisBox(suv[i])
    if (boxGap(x - poses[o + POSE.x], z - poses[o + POSE.z], poses[o + POSE.heading], c.hx, c.hz) - pad < 0) {
      out[found++] = i
      if (found === out.length) break
    }
  }
  return found
}

/** What the user's body is touching this frame: the kind that goes deepest in (most negative gap), or none. */
export function touching(gaps: { pole: number; person: number; vehicle: number }): ContactKind {
  let kind: ContactKind = CONTACT_KIND.none, depth = 0
  const take = (g: number, k: ContactKind) => {
    if (Number.isFinite(g) && g < depth) { depth = g; kind = k }
  }
  take(gaps.pole, CONTACT_KIND.pole)
  take(gaps.person, CONTACT_KIND.person)
  take(gaps.vehicle, CONTACT_KIND.vehicle)
  return kind
}

/**
 * The passage's envelope, 0..1: up over `attack` while touching, held at least `hold` at 1 once it gets there, down
 * over `release` after. The kind is the last thing met (it stays while the envelope clears). `count` is every
 * contact that started a passage. It is telemetry (engine.ts snapshot `contact`): no shader reads it, and nothing is
 * drawn over the frame from it.
 */
export class ContactPulse {
  value = 0
  kind: ContactKind = CONTACT_KIND.none
  count = 0
  private held = 0
  private wasTouching = false

  update(kind: ContactKind, dt: number): number {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0
    const now = kind !== CONTACT_KIND.none
    if (now) {
      if (!this.wasTouching) this.count++
      this.kind = kind
      this.held = 0
      this.value = Math.min(1, this.value + step / CONTACT.attack)
    } else if (this.value > 0) {
      if (this.value >= 1 && this.held < CONTACT.hold) this.held += step
      else this.value = Math.max(0, this.value - step / CONTACT.release)
      // A touch released before the envelope reaches 1 still climbs to it: every contact counts as a whole passage.
      if (this.wasTouching && this.value < 1) this.value = Math.min(1, this.value + step / CONTACT.attack)
    }
    if (this.value === 0) this.kind = CONTACT_KIND.none
    this.wasTouching = now || (this.wasTouching && this.value < 1)
    return this.value
  }
}
