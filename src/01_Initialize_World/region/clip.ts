// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? A region is a box cut out of surveyed data whose features run past it: a lake of 18,000
 * shoreline vertices, a river, streets that leave the box. The world compiler keeps exactly what lies inside: polygons
 * clipped ring by ring against the box (Sutherland–Hodgman: exact for a convex clip region, and a ring's pieces along
 * the box's edge keep an even-odd fill right), polylines cut into the runs that stay inside (Liang–Barsky per segment).
 * It also drops the vertices a ring does not need.
 * What breaks if it is removed? The lake would be carried whole into every region, and streets would run off its edge.
 */

export type Pt = readonly [number, number]
export interface Rect { x0: number; z0: number; x1: number; z1: number }

/** One ring clipped to the rectangle; fewer than three points means nothing is left. */
export function clipRing(ring: readonly Pt[], r: Rect): Pt[] {
  let out: Pt[] = ring.slice()
  const edges: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [(p) => p[0] >= r.x0, (a, b) => at(a, b, (r.x0 - a[0]) / (b[0] - a[0]))],
    [(p) => p[0] <= r.x1, (a, b) => at(a, b, (r.x1 - a[0]) / (b[0] - a[0]))],
    [(p) => p[1] >= r.z0, (a, b) => at(a, b, (r.z0 - a[1]) / (b[1] - a[1]))],
    [(p) => p[1] <= r.z1, (a, b) => at(a, b, (r.z1 - a[1]) / (b[1] - a[1]))],
  ]
  for (const [inside, cross] of edges) {
    if (out.length === 0) break
    const src = out
    out = []
    for (let i = 0; i < src.length; i++) {
      const cur = src[i], prev = src[(i + src.length - 1) % src.length]
      const cin = inside(cur), pin = inside(prev)
      if (cin) {
        if (!pin) out.push(cross(prev, cur))
        out.push(cur)
      } else if (pin) {
        out.push(cross(prev, cur))
      }
    }
  }
  return out.length >= 3 ? out : []
}

const at = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

/** A polyline cut to the rectangle: the runs that lie inside, each at least two points. */
export function clipLine(line: readonly Pt[], r: Rect): Pt[][] {
  const runs: Pt[][] = []
  let run: Pt[] = []
  for (let i = 0; i + 1 < line.length; i++) {
    const seg = clipSegment(line[i], line[i + 1], r)
    if (!seg) {
      if (run.length >= 2) runs.push(run)
      run = []
      continue
    }
    const [a, b] = seg
    const last = run[run.length - 1]
    if (!last || last[0] !== a[0] || last[1] !== a[1]) {
      if (run.length >= 2) runs.push(run)
      run = [a]
    }
    run.push(b)
  }
  if (run.length >= 2) runs.push(run)
  return runs
}

/** Liang–Barsky: the part of a segment inside the rectangle, or null. */
export function clipSegment(a: Pt, b: Pt, r: Rect): [Pt, Pt] | null {
  const dx = b[0] - a[0], dz = b[1] - a[1]
  let t0 = 0, t1 = 1
  const p = [-dx, dx, -dz, dz]
  const q = [a[0] - r.x0, r.x1 - a[0], a[1] - r.z0, r.z1 - a[1]]
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null
    } else {
      const t = q[i] / p[i]
      if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t }
      else { if (t < t0) return null; if (t < t1) t1 = t }
    }
  }
  return [t0 === 0 ? a : at(a, b, t0), t1 === 1 ? b : at(a, b, t1)]
}

/** Twice the signed area of a ring (positive counter-clockwise with x east and z north; the engine's z runs south). */
export function signedArea2(ring: readonly Pt[]): number {
  let s = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1])
  return s
}

/**
 * A ring without the vertices it does not need: repeats, and points within `tolerance` of the line through their
 * neighbours (Douglas–Peucker over the closed ring, which keeps the two points farthest apart).
 */
export function simplifyRing(ring: readonly Pt[], tolerance: number): Pt[] {
  const pts = ring.filter((p, i) => i === 0 || p[0] !== ring[i - 1][0] || p[1] !== ring[i - 1][1])
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop()
  if (pts.length <= 3) return pts
  // Split at the vertex farthest from the first, simplify both halves as open lines.
  let far = 1, best = -1
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2
    if (d > best) { best = d; far = i }
  }
  const a = simplifyLine([...pts.slice(0, far + 1)], tolerance)
  const b = simplifyLine([...pts.slice(far), pts[0]], tolerance)
  const out = [...a.slice(0, -1), ...b.slice(0, -1)]
  return out.length >= 3 ? out : pts
}

/** Douglas–Peucker on an open polyline (its ends always kept). */
export function simplifyLine(line: readonly Pt[], tolerance: number): Pt[] {
  if (line.length <= 2) return line.slice()
  const keep = new Uint8Array(line.length)
  keep[0] = keep[line.length - 1] = 1
  const stack: [number, number][] = [[0, line.length - 1]]
  const t2 = tolerance * tolerance
  while (stack.length) {
    const [i, j] = stack.pop()!
    const [ax, az] = line[i], [bx, bz] = line[j]
    const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz
    let far = -1, best = t2
    for (let k = i + 1; k < j; k++) {
      const px = line[k][0] - ax, pz = line[k][1] - az
      const t = len2 > 0 ? Math.max(0, Math.min(1, (px * dx + pz * dz) / len2)) : 0
      const d = (px - t * dx) ** 2 + (pz - t * dz) ** 2
      if (d > best) { best = d; far = k }
    }
    if (far >= 0) {
      keep[far] = 1
      stack.push([i, far], [far, j])
    }
  }
  return line.filter((_, k) => keep[k] === 1)
}
