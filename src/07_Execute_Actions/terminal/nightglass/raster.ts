// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the reference renderer's rasteriser: the fixed-function steps between the vertex
 * stage and the fragment stage. It assembles triangles from a list or a strip, clips each against the view volume,
 * maps it through the viewport, snaps it to 1/256 of a pixel, culls it by facing, finds the pixels (or samples) it
 * covers with exact integer edge functions and the top-left rule, and hands the fragment stage 2 x 2 quads with
 * depth and every vertex output interpolated for all four lanes. The rules are the pinned ones of docs/nightglass.md,
 * and a GPU's pictures are compared against what this code draws, so it computes them exactly rather than closely.
 * What breaks if it is removed? The reference renderer could not draw a triangle, and the GPU back end would have no
 * picture to be checked against.
 *
 * COORDINATES. Clip space is (x, y, z, w) as the vertex stage wrote it. The framebuffer has its origin at the top left
 * and y grows down; pixel (X, Y) covers [X, X + 1) x [Y, Y + 1) and its centre is (X + 0.5, Y + 0.5). The viewport
 * maps x_fb = vx + (x/w * 0.5 + 0.5) * vw, y_fb = vy + (0.5 - y/w * 0.5) * vh and depth = near + z/w * (far - near),
 * in double precision. A position is then held as a whole number of 1/256 pixels (Math.round of 256 times it).
 * Attachments and viewports lie within RASTER_BOUND pixels of the origin, so a snapped position is under 2^23 in
 * size, and an edge function (a difference of two products of differences of such numbers) is an exact integer
 * under 2^50: coverage is decided with no rounding at all.
 *
 * CLIPPING. A triangle is clipped, Sutherland-Hodgman style, against w >= W_MIN, -w <= x <= w, -w <= y <= w and (unless
 * the pipeline keeps depth unclipped) 0 <= z <= w, in that order, with every vertex output interpolated linearly in
 * clip space. A point on a plane is inside it. Where an edge crosses a plane the new vertex is always computed from
 * the edge's inside end toward its outside end, so two triangles sharing an edge cut it at the very same point and
 * no crack or overlap opens along it. The clipped polygon is drawn as the fan (0, i, i + 1).
 *
 * FACING. The polygon's signed area is computed exactly from its snapped corners. With y down, a negative area means
 * the corners run counter-clockwise as the image is seen, and the polygon faces the viewer when that matches the
 * pipeline's `front`. A polygon of zero area draws nothing. Every fan triangle takes the polygon's facing; one that
 * snapping has flattened or turned over (a sliver whose area is zero or of the other sign) is skipped.
 *
 * COVERAGE. A sample point (the pixel centre with one sample, the four SAMPLE_POSITIONS with four) is covered when it
 * is strictly inside all three edges, or exactly on an edge that is a top edge (horizontal, with the triangle below
 * it) or a left edge (with the triangle to its right). Two triangles that share an edge therefore cover every point
 * on it exactly once between them. Only pixels inside the attachment, the scissor rectangle and the viewport's span
 * are tested.
 *
 * INTERPOLATION. Barycentric weights come from the same exact edge functions, at the pixel centre for the vertex
 * outputs and the fragment coordinate, and at each sample position for the depth tested there. Vertex outputs are
 * perspective-correct (weights times 1/w, renormalised); depth is linear in screen space and then clamped into the
 * viewport's depth range. Outputs marked flat take the provoking vertex's value unchanged. All four lanes of a quad
 * are interpolated, including lanes no sample of which is covered (helper lanes): their weights extrapolate the same
 * planes, so differences across the quad are the true rates of change.
 */
import type { Rect, Topology, Viewport } from './api.ts'
import { fail } from './fault.ts'

/** Positions snap to 1/SUBPIXEL of a pixel. */
export const SUBPIXEL = 256

/** The four standard sample positions within a pixel, in sample order: bit i of a four-sample coverage mask is sample i. */
export const SAMPLE_POSITIONS: readonly (readonly [number, number])[] = Object.freeze([
  Object.freeze([0.375, 0.125] as const),
  Object.freeze([0.875, 0.375] as const),
  Object.freeze([0.125, 0.625] as const),
  Object.freeze([0.625, 0.875] as const),
])

/** How far from the origin, in pixels, an attachment's edge or a viewport's edge may lie. */
export const RASTER_BOUND = 32768

/**
 * The plane w >= W_MIN is clipped against with the others, so no vertex reaches the divide by w with w at or below
 * zero. Inside the other planes only the clip-space origin has w = 0, so the plane changes a picture only for a
 * triangle passing within W_MIN of that origin, and such a triangle is seen edge-on. W_MIN is the smallest normal f32.
 */
export const W_MIN = 2 ** -126

/** The most values one vertex may pass to the fragment stage: a bound on the rasteriser's own buffers. */
export const MAX_VARYINGS = 1024

/** The largest finite f32. A clip coordinate beyond it (or not a number) is no position, and its triangle draws nothing. */
const F32_MAX = 3.4028234663852886e38

/** Sample offsets within a pixel, in 1/SUBPIXEL units: the centre alone, or the four standard positions. */
const CENTRE = SUBPIXEL / 2
const ONE_X: readonly number[] = [CENTRE]
const ONE_Y: readonly number[] = [CENTRE]
const FOUR_X: readonly number[] = SAMPLE_POSITIONS.map((p) => p[0] * SUBPIXEL)
const FOUR_Y: readonly number[] = SAMPLE_POSITIONS.map((p) => p[1] * SUBPIXEL)

/** Clip planes, in order: w >= W_MIN, -w <= x, x <= w, -w <= y, y <= w, then the two depth planes 0 <= z and z <= w. */
const PLANES = 7
const DEPTH_PLANES = 5

// ---------------------------------------------------------------------------------------------------
// Primitive assembly

/** One triangle of a draw: three vertex indices in winding order, and the vertex its flat values come from. */
export interface Triangle {
  readonly a: number
  readonly b: number
  readonly c: number
  /** The triangle's first vertex. For an odd triangle of a strip that is `b`: the order is swapped, the first is not. */
  readonly provoking: number
}

/**
 * The triangles `count` vertices make. A list makes triangle t of vertices 3t, 3t + 1, 3t + 2 (leftover vertices draw
 * nothing). A strip makes triangle i of vertices i, i + 1, i + 2, and of i + 1, i, i + 2 when i is odd so that every
 * triangle keeps the strip's winding; its flat values still come from vertex i.
 */
export function assemble(topology: Topology, count: number): Generator<Triangle, void, undefined> {
  if (topology !== 'triangles' && topology !== 'triangle-strip') fail('invalid', `primitive assembly: ${String(topology)} is not a topology (triangles or triangle-strip)`)
  if (!Number.isSafeInteger(count) || count < 0) fail('invalid', `primitive assembly: the vertex count ${String(count)} is not a whole number of zero or more`)
  return topology === 'triangles' ? list(count) : strip(count)
}

function* list(count: number): Generator<Triangle, void, undefined> {
  for (let i = 0; i + 2 < count; i += 3) yield { a: i, b: i + 1, c: i + 2, provoking: i }
}

function* strip(count: number): Generator<Triangle, void, undefined> {
  for (let i = 0; i + 2 < count; i++) yield i % 2 === 0 ? { a: i, b: i + 1, c: i + 2, provoking: i } : { a: i + 1, b: i, c: i + 2, provoking: i }
}

// ---------------------------------------------------------------------------------------------------
// The rasteriser

/** Everything fixed about how one draw's triangles become fragments. */
export interface RasterState {
  /** The attachments' size in pixels. */
  readonly width: number
  readonly height: number
  readonly viewport: Required<Viewport>
  /** Whole pixels; only pixels inside it are covered. */
  readonly scissor: Rect
  readonly cull: 'none' | 'front' | 'back'
  /** The winding, as the image is seen, of a triangle that faces the viewer. */
  readonly front: 'ccw' | 'cw'
  readonly samples: 1 | 4
  /** Keep geometry past the near and far planes (z is not clipped) and clamp its depth instead. */
  readonly unclipped: boolean
}

/** A vertex as the vertex stage left it. */
export interface ClipVertex {
  /** x, y, z, w in clip space. */
  readonly pos: ArrayLike<number>
  /** The values it passes to the fragment stage: at least the rasteriser's `varyings` numbers. */
  readonly vary: ArrayLike<number>
}

/**
 * A 2 x 2 block of pixels a triangle touches. Lane i is pixel (x + (i & 1), y + (i >> 1)). The rasteriser refills
 * one Quad for every block it hands out, so the receiver copies whatever it keeps past its call.
 */
export interface Quad {
  /** The top-left pixel; both even. */
  x: number
  y: number
  /**
   * Per lane, the samples covered: bit 0 with one sample, bits 0 to 3 (SAMPLE_POSITIONS order) with four. A lane of
   * mask 0 is a helper: it is shaded so the quad's rates of change are right, and it writes nothing.
   */
  readonly mask: Uint8Array
  /** Per lane (lane * 4 + i): x + 0.5, y + 0.5, the depth at the pixel centre, and 1/w there. */
  readonly coord: Float64Array
  /** Per lane and sample (lane * samples + s), the depth the depth test uses, at that sample's position. */
  readonly depth: Float64Array
  /**
   * Per lane (lane * varyings + i), each value interpolated at the pixel centre, or the provoking vertex's if flat.
   * Values are doubles (a flat u32 stays exact); the receiver rounds them to the shader's types. A helper lane lying
   * past the plane's horizon, where 1/w reaches zero, extrapolates to an infinity or NaN, as it would on a GPU.
   */
  readonly vary: Float64Array
  /** The triangle faces the viewer. */
  front: boolean
}

/**
 * The rasteriser of one draw. It is built from the draw's state, how many values each vertex passes on, and which of
 * them are flat (null: none), and checks them once; then `triangle` rasterises triangles one by one.
 */
export class Raster {
  readonly state: RasterState
  readonly varyings: number
  /** The quad handed to `emit`, refilled for every block. */
  private readonly quad: Quad
  private readonly flat: readonly boolean[]
  /** The current triangle's flat values, taken from its provoking vertex. */
  private readonly flatValues: Float64Array
  /** Numbers per polygon vertex: x, y, z, w and the values (clip space), or their framebuffer form (see `project`). */
  private readonly stride: number
  /** The pixels a triangle may cover: the attachment, the scissor and the viewport's span, intersected (half-open). */
  private readonly left: number
  private readonly top: number
  private readonly right: number
  private readonly bottom: number
  private readonly offX: readonly number[]
  private readonly offY: readonly number[]
  private readonly depthLo: number
  private readonly depthHi: number
  /** The polygon being clipped, the buffer the next plane's result goes to, and the polygon in the framebuffer. */
  private poly: Float64Array
  private spare: Float64Array
  private screen: Float64Array
  /** The current fan triangle: its three corners' offsets into `screen`, its doubled area, and per edge dx, dy, x, y. */
  private readonly corner = new Int32Array(3)
  private area = 0
  private readonly edge = new Float64Array(12)
  /** 1 for an edge on which a point counts as inside (top or left), else 0: covered means e + bias > 0. */
  private readonly bias = new Float64Array(3)
  /** The three edge functions at the last point `weigh` was given. */
  private readonly e = new Float64Array(3)

  constructor(state: RasterState, varyings: number, flat: ArrayLike<boolean> | null) {
    checkState(state)
    if (!Number.isInteger(varyings) || varyings < 0 || varyings > MAX_VARYINGS) fail('invalid', `rasteriser: ${String(varyings)} values per vertex is not a whole number from 0 to ${MAX_VARYINGS}`)
    if (flat !== null && (typeof flat !== 'object' || !(flat.length >= varyings))) fail('invalid', `rasteriser: the flat flags must be null or give one flag for each of the ${varyings} values`)
    const vp = state.viewport
    const sc = state.scissor
    this.state = Object.freeze({
      width: state.width, height: state.height, cull: state.cull, front: state.front, samples: state.samples, unclipped: state.unclipped,
      viewport: Object.freeze({ x: vp.x, y: vp.y, width: vp.width, height: vp.height, near: vp.near, far: vp.far }),
      scissor: Object.freeze({ x: sc.x, y: sc.y, width: sc.width, height: sc.height }),
    })
    this.varyings = varyings
    this.flat = Array.from({ length: varyings }, (_, k) => flat !== null && flat[k] === true)
    this.flatValues = new Float64Array(varyings)
    this.stride = 4 + varyings
    this.left = Math.max(0, sc.x, Math.floor(vp.x))
    this.top = Math.max(0, sc.y, Math.floor(vp.y))
    this.right = Math.min(state.width, sc.x + sc.width, Math.ceil(vp.x + vp.width))
    this.bottom = Math.min(state.height, sc.y + sc.height, Math.ceil(vp.y + vp.height))
    this.offX = state.samples === 4 ? FOUR_X : ONE_X
    this.offY = state.samples === 4 ? FOUR_Y : ONE_Y
    this.depthLo = Math.min(vp.near, vp.far)
    this.depthHi = Math.max(vp.near, vp.far)
    this.poly = new Float64Array(8 * this.stride)
    this.spare = new Float64Array(8 * this.stride)
    this.screen = new Float64Array(8 * this.stride)
    this.quad = {
      x: 0, y: 0, front: true,
      mask: new Uint8Array(4), coord: new Float64Array(16), depth: new Float64Array(4 * state.samples), vary: new Float64Array(4 * varyings),
    }
  }

  /**
   * Rasterises one triangle (vertices in winding order) and calls `emit` with every quad it covers a sample of: row by
   * row from the top, and for a clipped triangle one piece of its fan after another, so two quads of one call may name
   * the same block (each covers different samples of it). Flat values come from `provoking`, normally one of the three.
   */
  triangle(a: ClipVertex, b: ClipVertex, c: ClipVertex, provoking: ClipVertex, emit: (quad: Quad) => void): void {
    this.checkVertex(a, 'a')
    this.checkVertex(b, 'b')
    this.checkVertex(c, 'c')
    this.checkVertex(provoking, 'provoking')
    if (typeof emit !== 'function') fail('invalid', 'rasteriser: emit must be a function that takes each quad')
    if (this.right <= this.left || this.bottom <= this.top) return
    if (!this.load(0, a) || !this.load(1, b) || !this.load(2, c)) return
    let n = 3
    for (let plane = 0; plane < PLANES && !(plane >= DEPTH_PLANES && this.state.unclipped); plane++) {
      n = this.clip(plane, n)
      if (n < 3) return
    }
    const area = this.project(n)
    if (area === 0) return
    const ccw = area < 0
    const front = ccw === (this.state.front === 'ccw')
    if ((this.state.cull === 'back' && !front) || (this.state.cull === 'front' && front)) return
    this.quad.front = front
    for (let k = 0; k < this.varyings; k++) if (this.flat[k]) this.flatValues[k] = provoking.vary[k]
    for (let i = 1; i + 1 < n; i++) this.fan(0, i, i + 1, area > 0, emit)
  }

  private checkVertex(v: ClipVertex, name: string): void {
    if (typeof v !== 'object' || v === null || typeof v.pos !== 'object' || v.pos === null || typeof v.vary !== 'object' || v.vary === null || !(v.pos.length >= 4) || !(v.vary.length >= this.varyings)) {
      fail('invalid', `rasteriser: vertex ${name} needs a position of 4 numbers and at least ${this.varyings} values`)
    }
  }

  /** Copies a vertex into slot i of `poly`; false when a clip coordinate is not a finite f32 (it then draws nothing). */
  private load(i: number, v: ClipVertex): boolean {
    const o = i * this.stride
    for (let k = 0; k < 4; k++) {
      const x = v.pos[k]
      if (!(Math.abs(x) <= F32_MAX)) return false
      this.poly[o + k] = x
    }
    for (let k = 0; k < this.varyings; k++) this.poly[o + 4 + k] = v.vary[k]
    return true
  }

  /** Clips the polygon of `n` vertices in `poly` against one plane, leaving the result in `poly`; returns its size. */
  private clip(plane: number, n: number): number {
    const s = this.stride
    const src = this.poly
    let inside = 0
    for (let i = 0; i < n; i++) if (distance(plane, src, i * s) >= 0) inside++
    if (inside === n) return n
    if (inside === 0) return 0
    // A convex polygon gains at most one vertex, but rounding can make a near-flat one cross a plane more than twice;
    // each edge adds at most two, so room for 2n can never run out.
    if (this.spare.length < 2 * n * s) this.spare = new Float64Array(2 * n * s)
    const dst = this.spare
    let m = 0
    for (let i = 0; i < n; i++) {
      const j = i + 1 === n ? 0 : i + 1
      const di = distance(plane, src, i * s)
      const dj = distance(plane, src, j * s)
      if (di >= 0) dst.set(src.subarray(i * s, i * s + s), m++ * s)
      if (di >= 0 !== dj >= 0) {
        const from = (di >= 0 ? i : j) * s
        const to = (di >= 0 ? j : i) * s
        const dIn = di >= 0 ? di : dj
        const t = dIn / (dIn - (di >= 0 ? dj : di))
        for (let k = 0; k < s; k++) dst[m * s + k] = src[from + k] + t * (src[to + k] - src[from + k])
        m++
      }
    }
    this.spare = src
    this.poly = dst
    return m
  }

  /**
   * Maps the clipped polygon into the framebuffer: per vertex the snapped x and y (1/256 pixels), the depth, 1/w,
   * and each value that is not flat times 1/w. Returns the polygon's doubled signed area in snapped units.
   */
  private project(n: number): number {
    const s = this.stride
    const vp = this.state.viewport
    const span = vp.far - vp.near
    if (this.screen.length < n * s) this.screen = new Float64Array(n * s)
    const p = this.poly
    const q = this.screen
    for (let i = 0; i < n; i++) {
      const o = i * s
      const w = p[o + 3]
      const inv = 1 / w
      q[o] = Math.round((vp.x + ((p[o] / w) * 0.5 + 0.5) * vp.width) * SUBPIXEL)
      q[o + 1] = Math.round((vp.y + (0.5 - (p[o + 1] / w) * 0.5) * vp.height) * SUBPIXEL)
      q[o + 2] = vp.near + (p[o + 2] / w) * span
      q[o + 3] = inv
      for (let k = 0; k < this.varyings; k++) if (!this.flat[k]) q[o + 4 + k] = p[o + 4 + k] * inv
    }
    // The shoelace sum, taken about the first corner so every term stays an exact integer.
    let area = 0
    for (let i = 1; i + 1 < n; i++) area += cross(q, 0, i * s, (i + 1) * s)
    return area
  }

  /** Rasterises the fan triangle of polygon vertices i0, i1, i2 if its area has the polygon's sign. */
  private fan(i0: number, i1: number, i2: number, positive: boolean, emit: (quad: Quad) => void): void {
    const s = this.stride
    const q = this.screen
    let area = cross(q, i0 * s, i1 * s, i2 * s)
    if (area === 0 || area > 0 !== positive) return
    // Orient the corners so the interior is where every edge function is positive.
    const swap = area < 0
    area = Math.abs(area)
    this.area = area
    this.corner[0] = i0 * s
    this.corner[1] = (swap ? i2 : i1) * s
    this.corner[2] = (swap ? i1 : i2) * s
    for (let k = 0; k < 3; k++) {
      // Edge k is the one opposite corner k: from corner k + 1 to corner k + 2, so its function is corner k's weight.
      const from = this.corner[(k + 1) % 3]
      const to = this.corner[(k + 2) % 3]
      const dx = q[to] - q[from]
      const dy = q[to + 1] - q[from + 1]
      this.edge.set([dx, dy, q[from], q[from + 1]], k * 4)
      // With the interior on the positive side and y down, a left edge runs up the screen and a top edge runs right.
      this.bias[k] = dy < 0 || (dy === 0 && dx > 0) ? 1 : 0
    }
    const xs = [q[this.corner[0]], q[this.corner[1]], q[this.corner[2]]]
    const ys = [q[this.corner[0] + 1], q[this.corner[1] + 1], q[this.corner[2] + 1]]
    const x0 = Math.max(this.left, Math.floor(Math.min(...xs) / SUBPIXEL))
    const x1 = Math.min(this.right - 1, Math.floor(Math.max(...xs) / SUBPIXEL))
    const y0 = Math.max(this.top, Math.floor(Math.min(...ys) / SUBPIXEL))
    const y1 = Math.min(this.bottom - 1, Math.floor(Math.max(...ys) / SUBPIXEL))
    const quad = this.quad
    for (let qy = y0 - (y0 & 1); qy <= y1; qy += 2) {
      for (let qx = x0 - (x0 & 1); qx <= x1; qx += 2) {
        let any = 0
        for (let lane = 0; lane < 4; lane++) {
          const px = qx + (lane & 1)
          const py = qy + (lane >> 1)
          let mask = 0
          if (px >= x0 && px <= x1 && py >= y0 && py <= y1) {
            for (let k = 0; k < this.offX.length; k++) if (this.covers(px * SUBPIXEL + this.offX[k], py * SUBPIXEL + this.offY[k])) mask |= 1 << k
          }
          quad.mask[lane] = mask
          any |= mask
        }
        if (any === 0) continue
        quad.x = qx
        quad.y = qy
        for (let lane = 0; lane < 4; lane++) this.interpolate(lane, qx + (lane & 1), qy + (lane >> 1))
        emit(quad)
      }
    }
  }

  /** Fills `e` with the three edge functions at a point in 1/256 pixels. */
  private weigh(px: number, py: number): void {
    const g = this.edge
    for (let k = 0; k < 3; k++) this.e[k] = g[k * 4] * (py - g[k * 4 + 3]) - g[k * 4 + 1] * (px - g[k * 4 + 2])
  }

  private covers(px: number, py: number): boolean {
    this.weigh(px, py)
    return this.e[0] + this.bias[0] > 0 && this.e[1] + this.bias[1] > 0 && this.e[2] + this.bias[2] > 0
  }

  /** The depth, linear in screen space, at the point `weigh` was last given, clamped into the depth range. */
  private depthHere(): number {
    const q = this.screen
    const c = this.corner
    const d = (this.e[0] * q[c[0] + 2] + this.e[1] * q[c[1] + 2] + this.e[2] * q[c[2] + 2]) / this.area
    return d < this.depthLo ? this.depthLo : d > this.depthHi ? this.depthHi : d
  }

  /** Fills one lane of the quad: fragment coordinate, per-sample depth, and the values, for pixel (px, py). */
  private interpolate(lane: number, px: number, py: number): void {
    const quad = this.quad
    const q = this.screen
    const c0 = this.corner[0]
    const c1 = this.corner[1]
    const c2 = this.corner[2]
    const samples = this.offX.length
    for (let k = 0; k < samples; k++) {
      this.weigh(px * SUBPIXEL + this.offX[k], py * SUBPIXEL + this.offY[k])
      quad.depth[lane * samples + k] = this.depthHere()
    }
    this.weigh(px * SUBPIXEL + CENTRE, py * SUBPIXEL + CENTRE)
    const e0 = this.e[0]
    const e1 = this.e[1]
    const e2 = this.e[2]
    const den = e0 * q[c0 + 3] + e1 * q[c1 + 3] + e2 * q[c2 + 3]
    quad.coord[lane * 4] = px + 0.5
    quad.coord[lane * 4 + 1] = py + 0.5
    quad.coord[lane * 4 + 2] = this.depthHere()
    quad.coord[lane * 4 + 3] = den / this.area
    const v = this.varyings
    for (let k = 0; k < v; k++) {
      quad.vary[lane * v + k] = this.flat[k] ? this.flatValues[k] : (e0 * q[c0 + 4 + k] + e1 * q[c1 + 4 + k] + e2 * q[c2 + 4 + k]) / den
    }
  }
}

/** The signed distance of a clip-space vertex (at offset o) from a plane; zero or more is inside. */
function distance(plane: number, p: Float64Array, o: number): number {
  const w = p[o + 3]
  switch (plane) {
    case 0: return w - W_MIN
    case 1: return w + p[o]
    case 2: return w - p[o]
    case 3: return w + p[o + 1]
    case 4: return w - p[o + 1]
    case 5: return p[o + 2]
    default: return w - p[o + 2]
  }
}

/** The doubled signed area of the snapped triangle at offsets a, b, c of a framebuffer polygon (positive: clockwise as seen). */
function cross(q: Float64Array, a: number, b: number, c: number): number {
  return (q[b] - q[a]) * (q[c + 1] - q[a + 1]) - (q[b + 1] - q[a + 1]) * (q[c] - q[a])
}

function checkState(s: RasterState): void {
  const bad = (rule: string): never => fail('invalid', `raster state: ${rule}`)
  if (typeof s !== 'object' || s === null) bad('the state must be an object')
  const whole = (v: unknown, lo: number, hi: number): boolean => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi
  if (!whole(s.width, 1, RASTER_BOUND) || !whole(s.height, 1, RASTER_BOUND)) bad(`the attachment size ${String(s.width)} x ${String(s.height)} is not whole pixels from 1 to ${RASTER_BOUND}`)
  const vp = s.viewport
  if (typeof vp !== 'object' || vp === null) bad('the viewport must be an object')
  if (![vp.x, vp.y, vp.width, vp.height, vp.near, vp.far].every(Number.isFinite)) bad('every number of the viewport must be finite')
  if (vp.width < 0 || vp.height < 0) bad(`the viewport's size ${vp.width} x ${vp.height} is negative`)
  if (vp.x < -RASTER_BOUND || vp.y < -RASTER_BOUND || vp.x + vp.width > RASTER_BOUND || vp.y + vp.height > RASTER_BOUND) bad(`the viewport reaches past ${RASTER_BOUND} pixels from the origin`)
  const sc = s.scissor
  if (typeof sc !== 'object' || sc === null) bad('the scissor must be an object')
  if (!whole(sc.x, 0, RASTER_BOUND) || !whole(sc.y, 0, RASTER_BOUND) || !whole(sc.width, 0, RASTER_BOUND) || !whole(sc.height, 0, RASTER_BOUND)) bad('the scissor must be whole pixels from 0 to the bound')
  if (s.cull !== 'none' && s.cull !== 'front' && s.cull !== 'back') bad(`${String(s.cull)} is not a cull mode (none, front or back)`)
  if (s.front !== 'ccw' && s.front !== 'cw') bad(`${String(s.front)} is not a winding (ccw or cw)`)
  if (s.samples !== 1 && s.samples !== 4) bad(`${String(s.samples)} is not a sample count (1 or 4)`)
  if (typeof s.unclipped !== 'boolean') bad('unclipped must be true or false')
}
