// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the reference renderer's rasterisation rules, the ones a GPU's pictures are
 * compared against: primitive assembly and provoking vertices, the top-left rule on every kind of edge, exact coverage
 * of shared edges and of whole viewports at odd sizes and fractional offsets, clipping (near plane, w = 0 and the
 * sides) checked against the exact homogeneous answer, perspective-correct values and screen-linear depth, helper
 * lanes, facing and culling, scissor and viewport, four-sample masks, depth clamping, and the refusals.
 * What breaks if it is removed? A crack, a doubled pixel, a value interpolated without perspective, or a sample moved
 * by one position could reach the reference renderer, and every comparison of a GPU against it would be against a
 * wrong picture.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Topology } from './api.ts'
import { isFault } from './fault.ts'
import { MAX_VARYINGS, RASTER_BOUND, Raster, SAMPLE_POSITIONS, SUBPIXEL, W_MIN, assemble } from './raster.ts'
import type { ClipVertex, RasterState } from './raster.ts'

/** A seeded linear congruential generator in [0, 1): the same numbers on every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const faults = (fn: () => unknown, code: 'invalid' = 'invalid'): void => {
  assert.throws(fn, (e: unknown) => isFault(e, code))
}

type Setup = Partial<RasterState>

/** A state over a width x height attachment, its viewport and scissor covering it, unless `o` says otherwise. */
function state(o: Setup = {}): RasterState {
  const width = o.width ?? 16
  const height = o.height ?? 16
  return { width, height, viewport: { x: 0, y: 0, width, height, near: 0, far: 1 }, scissor: { x: 0, y: 0, width, height }, cull: 'none', front: 'ccw', samples: 1, unclipped: false, ...o }
}

/** The clip-space vertex that lands on framebuffer point (fx, fy) of the state's viewport at depth fraction z, scaled by w. */
function at(st: RasterState, fx: number, fy: number, vary: readonly number[] = [], z = 0, w = 1): ClipVertex {
  const vp = st.viewport
  const nx = ((fx - vp.x) / vp.width) * 2 - 1
  const ny = 1 - ((fy - vp.y) / vp.height) * 2
  return { pos: [nx * w, ny * w, z * w, w], vary }
}

interface Lane {
  readonly px: number
  readonly py: number
  readonly mask: number
  readonly coord: readonly number[]
  readonly depth: readonly number[]
  readonly vary: readonly number[]
  readonly front: boolean
}

interface Drawing {
  /** Per sample (pixel * samples + s), how many triangles covered it. */
  readonly counts: Uint8Array
  /** Every lane of every quad handed out, copied, in order. */
  readonly lanes: Lane[]
}

/**
 * Draws triangles (each [a, b, c] or [a, b, c, provoking]) and gathers what came out, checking on the way what holds of
 * every quad: an even top-left pixel, a mask within the sample count, a covered lane inside the attachment, and at
 * least one covered lane.
 */
function draw(st: RasterState, tris: readonly (readonly ClipVertex[])[], varyings = 0, flat: readonly boolean[] | null = null): Drawing {
  const raster = new Raster(st, varyings, flat)
  const counts = new Uint8Array(st.width * st.height * st.samples)
  const lanes: Lane[] = []
  for (const t of tris) {
    raster.triangle(t[0], t[1], t[2], t[3] ?? t[0], (q) => {
      assert.equal(q.x % 2, 0)
      assert.equal(q.y % 2, 0)
      let any = 0
      for (let lane = 0; lane < 4; lane++) {
        const px = q.x + (lane & 1)
        const py = q.y + (lane >> 1)
        const m = q.mask[lane]
        any |= m
        assert.ok(m < 1 << st.samples, 'mask within the samples')
        if (m !== 0) assert.ok(px >= 0 && py >= 0 && px < st.width && py < st.height, 'a covered lane lies in the attachment')
        for (let s = 0; s < st.samples; s++) if (m & (1 << s)) counts[(py * st.width + px) * st.samples + s]++
        const v = raster.varyings
        lanes.push({ px, py, mask: m, coord: [...q.coord.subarray(lane * 4, lane * 4 + 4)], depth: [...q.depth.subarray(lane * st.samples, (lane + 1) * st.samples)], vary: [...q.vary.subarray(lane * v, lane * v + v)], front: q.front })
      }
      assert.ok(any !== 0, 'a quad handed out covers something')
    })
  }
  return { counts, lanes }
}

/** The covered pixels (any sample) as rows of '#' and '.', top row first. */
function picture(st: RasterState, counts: Uint8Array): string[] {
  const rows: string[] = []
  for (let y = 0; y < st.height; y++) {
    let row = ''
    for (let x = 0; x < st.width; x++) {
      let n = 0
      for (let s = 0; s < st.samples; s++) n += counts[(y * st.width + x) * st.samples + s]
      row += n === 0 ? '.' : n === st.samples ? '#' : '+'
    }
    rows.push(row)
  }
  return rows
}

/** The covered lane of a pixel (there is at most one per triangle). */
function laneAt(d: Drawing, px: number, py: number): Lane | undefined {
  return d.lanes.find((l) => l.px === px && l.py === py && l.mask !== 0)
}

/** Two triangles over the rectangle [x0, x1] x [y0, y1] of framebuffer points, split on the diagonal `diagonal` (0 or 1). */
function rect(st: RasterState, x0: number, y0: number, x1: number, y1: number, diagonal = 0): ClipVertex[][] {
  const tl = at(st, x0, y0)
  const tr = at(st, x1, y0)
  const br = at(st, x1, y1)
  const bl = at(st, x0, y1)
  return diagonal === 0 ? [[tl, tr, br], [tl, br, bl]] : [[tl, tr, bl], [tr, br, bl]]
}

// ---------------------------------------------------------------------------------------------------
// Assembly

test('assembly: a list makes whole triangles from the first vertex; a strip keeps its winding and its flat vertex is i', () => {
  assert.deepEqual([...assemble('triangles', 7)], [{ a: 0, b: 1, c: 2, provoking: 0 }, { a: 3, b: 4, c: 5, provoking: 3 }])
  assert.deepEqual([...assemble('triangle-strip', 6)], [
    { a: 0, b: 1, c: 2, provoking: 0 },
    { a: 2, b: 1, c: 3, provoking: 1 },
    { a: 2, b: 3, c: 4, provoking: 2 },
    { a: 4, b: 3, c: 5, provoking: 3 },
  ])
  for (const t of ['triangles', 'triangle-strip'] as const) {
    assert.deepEqual([...assemble(t, 0)], [])
    assert.deepEqual([...assemble(t, 2)], [])
    assert.equal([...assemble(t, 3)].length, 1)
  }
  assert.equal([...assemble('triangles', 3000)].length, 1000)
  assert.equal([...assemble('triangle-strip', 3000)].length, 2998)
  faults(() => assemble('lines' as Topology, 3))
  for (const n of [-1, 2.5, NaN, Infinity, 2 ** 60]) faults(() => assemble('triangles', n))
  faults(() => assemble('triangle-strip', '3' as unknown as number))
})

test('assembly: a strip restarts where it is told, no triangle using that position, its triangles counted again from 0', () => {
  const stopsAt = (...stops: number[]) => (i: number): boolean => stops.includes(i)
  // Positions 0 to 2 make one triangle; 3 and 4 restart; 5 to 8 begin again, the first triangle in the strip's order
  // (position 5 is odd, but the first of its piece) and the second swapped, its flat vertex still its first position.
  assert.deepEqual([...assemble('triangle-strip', 9, stopsAt(3, 4))], [
    { a: 0, b: 1, c: 2, provoking: 0 },
    { a: 5, b: 6, c: 7, provoking: 5 },
    { a: 7, b: 6, c: 8, provoking: 6 },
  ])
  // A restart first or last, a piece of two positions between restarts, and nothing but restarts make no triangle there.
  assert.deepEqual([...assemble('triangle-strip', 7, stopsAt(0, 3, 6))], [])
  assert.deepEqual([...assemble('triangle-strip', 5, stopsAt(0))], [{ a: 1, b: 2, c: 3, provoking: 1 }, { a: 3, b: 2, c: 4, provoking: 2 }])
  assert.deepEqual([...assemble('triangle-strip', 6, () => true)], [])
  // With no restart, or one that never says so, a strip is as before.
  assert.deepEqual([...assemble('triangle-strip', 6, () => false)], [...assemble('triangle-strip', 6)])
  // Every position is asked once, in order; a list never asks.
  const asked: number[] = []
  for (const t of assemble('triangle-strip', 6, (i) => { asked.push(i); return i === 2 })) assert.ok(t.a > 2)
  assert.deepEqual(asked, [0, 1, 2, 3, 4, 5])
  assert.deepEqual([...assemble('triangles', 6, () => assert.fail('a list never restarts'))], [...assemble('triangles', 6)])
  faults(() => assemble('triangle-strip', 3, 'yes' as unknown as () => boolean))
})

// ---------------------------------------------------------------------------------------------------
// Coverage and the top-left rule

test('a pixel centre exactly on a left edge is covered, and one exactly on a right edge is not, whatever the vertex order', () => {
  const st = state()
  // The left edge of this triangle is the line x = 4.5, through the centres of column 4.
  const left = [at(st, 4.5, 0), at(st, 4.5, 16), at(st, 12, 8)]
  // The right edge of this one is x = 11.5, through the centres of column 11.
  const right = [at(st, 11.5, 0), at(st, 4, 8), at(st, 11.5, 16)]
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 2, 0], [2, 1, 0]]) {
    const l = draw(st, [order.map((i) => left[i])]).counts
    const r = draw(st, [order.map((i) => right[i])]).counts
    for (let y = 0; y < 16; y++) {
      assert.equal(l[y * 16 + 4], 1, `left edge, row ${y}`)
      assert.equal(l[y * 16 + 3], 0)
      assert.equal(r[y * 16 + 11], 0, `right edge, row ${y}`)
    }
    assert.equal(r[8 * 16 + 10], 1)
  }
})

test('a pixel centre exactly on a top edge is covered, and one exactly on a bottom edge is not', () => {
  const st = state()
  const top = [at(st, 0, 4.5), at(st, 16, 4.5), at(st, 8, 12)]
  const bottom = [at(st, 8, 4), at(st, 16, 11.5), at(st, 0, 11.5)]
  for (const order of [[0, 1, 2], [0, 2, 1]]) {
    const t = draw(st, [order.map((i) => top[i])]).counts
    const b = draw(st, [order.map((i) => bottom[i])]).counts
    for (let x = 0; x < 16; x++) {
      assert.equal(t[4 * 16 + x], 1, `top edge, column ${x}`)
      assert.equal(t[3 * 16 + x], 0)
      assert.equal(b[11 * 16 + x], 0, `bottom edge, column ${x}`)
    }
    assert.equal(b[10 * 16 + 8], 1)
  }
  // The same rules seen as a picture: a small triangle with its corners on pixel centres.
  const small = state({ width: 8, height: 6 })
  assert.deepEqual(picture(small, draw(small, [[at(small, 1.5, 0.5), at(small, 6.5, 0.5), at(small, 1.5, 5.5)]]).counts), [
    '.#####..',
    '.####...',
    '.###....',
    '.##.....',
    '.#......',
    '........',
  ])
})

test('two triangles sharing an edge through pixel centres cover every pixel of their square exactly once', () => {
  for (const samples of [1, 4] as const) {
    const st = state({ samples })
    for (const diagonal of [0, 1]) {
      // Both diagonals of the square (2, 2) to (14, 14) run through pixel centres.
      const { counts } = draw(st, rect(st, 2, 2, 14, 14, diagonal))
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const inside = x >= 2 && x < 14 && y >= 2 && y < 14 ? 1 : 0
          for (let s = 0; s < samples; s++) assert.equal(counts[(y * 16 + x) * samples + s], inside, `(${x}, ${y}) sample ${s}`)
        }
      }
    }
  }
})

test('two triangles over a whole viewport cover each sample inside it exactly once, at odd sizes and fractional offsets', () => {
  const sizes = [[1, 1], [3, 1], [1, 5], [3, 7], [13, 5], [31, 33], [16, 9]]
  const offsets = [[0, 0], [0.5, 0], [0, 0.5], [1.25, -0.75], [-2.375, 3.5], [0.125, 0.875]]
  let checked = 0
  for (const [width, height] of sizes) {
    for (const [ox, oy] of offsets) {
      for (const samples of [1, 4] as const) {
        for (const diagonal of [0, 1]) {
          for (const scissored of [false, true]) {
            const viewport = { x: ox, y: oy, width, height, near: 0, far: 1 }
            const scissor = scissored ? { x: 1, y: 0, width: Math.max(0, width - 2), height } : { x: 0, y: 0, width, height }
            const st = state({ width, height, samples, viewport, scissor })
            const tl = { pos: [-1, 1, 0, 1], vary: [] }
            const tr = { pos: [1, 1, 0, 1], vary: [] }
            const br = { pos: [1, -1, 0, 1], vary: [] }
            const bl = { pos: [-1, -1, 0, 1], vary: [] }
            const tris = diagonal === 0 ? [[tl, tr, br], [tl, br, bl]] : [[tl, tr, bl], [tr, br, bl]]
            const { counts } = draw(st, tris)
            const offs = samples === 1 ? [[0.5, 0.5]] : SAMPLE_POSITIONS
            for (let y = 0; y < height; y++) {
              for (let x = 0; x < width; x++) {
                for (let s = 0; s < samples; s++) {
                  const sx = (x + offs[s][0]) * SUBPIXEL
                  const sy = (y + offs[s][1]) * SUBPIXEL
                  // Left and top edges count, right and bottom ones do not.
                  const inView = sx >= ox * SUBPIXEL && sx < (ox + width) * SUBPIXEL && sy >= oy * SUBPIXEL && sy < (oy + height) * SUBPIXEL
                  const inScissor = x >= scissor.x && x < scissor.x + scissor.width && y >= scissor.y && y < scissor.y + scissor.height
                  assert.equal(counts[(y * width + x) * samples + s], inView && inScissor ? 1 : 0, `${width}x${height} at (${ox}, ${oy}), ${samples} samples, diagonal ${diagonal}: (${x}, ${y}) sample ${s}`)
                  checked++
                }
              }
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 20000)
})

test('one triangle reaching far past the viewport is clipped to cover exactly the viewport, at any w', () => {
  // w far below 1 is still a position: only w under W_MIN (the smallest normal f32) is cut away.
  for (const w of [1, 2.5, 1e-3, 1e6, 1e-6, 1e-30, 2 ** -120]) {
    for (const [width, height] of [[7, 5], [16, 16], [33, 2]]) {
      const st = state({ width, height })
      const tri = [[-1, -1], [3, -1], [-1, 3]].map(([x, y]) => ({ pos: [x * w, y * w, 0.5 * w, w], vary: [] }))
      const { counts } = draw(st, [tri])
      assert.ok(counts.every((n) => n === 1), `${width}x${height}, w ${w}`)
    }
  }
})

test('four samples: an edge through a pixel gives each side the samples on its side, and each sample is covered once', () => {
  const st = state({ samples: 4 })
  const maskOf = (counts: Uint8Array, px: number, py: number): number => {
    let m = 0
    for (let s = 0; s < 4; s++) if (counts[(py * 16 + px) * 4 + s]) m |= 1 << s
    return m
  }
  // A vertical cut at x = 8.5: samples 0 (x 0.375) and 2 (x 0.125) lie left of it, samples 1 and 3 right.
  const left = draw(st, rect(st, 0, 0, 8.5, 16)).counts
  const right = draw(st, rect(st, 8.5, 0, 16, 16)).counts
  for (let y = 0; y < 16; y++) {
    assert.equal(maskOf(left, 8, y), 0b0101)
    assert.equal(maskOf(right, 8, y), 0b1010)
    assert.equal(maskOf(left, 7, y), 0b1111)
    assert.equal(maskOf(right, 9, y), 0b1111)
  }
  // A horizontal cut at y = 8.5: samples 0 and 1 (y 0.125 and 0.375) lie above it.
  const upper = draw(st, rect(st, 0, 0, 16, 8.5)).counts
  const lower = draw(st, rect(st, 0, 8.5, 16, 16)).counts
  for (let x = 0; x < 16; x++) {
    assert.equal(maskOf(upper, x, 8), 0b0011)
    assert.equal(maskOf(lower, x, 8), 0b1100)
  }
  // The diagonal y = x through pixel (8, 8): samples 2 and 3 have y > x within the pixel.
  const below = draw(st, [[at(st, 0, 0), at(st, 16, 16), at(st, 0, 16)]]).counts
  assert.equal(maskOf(below, 8, 8), 0b1100)
  for (let i = 0; i < 16 * 16 * 4; i++) assert.equal(left[i] + right[i], 1)
  // With one sample the centre decides, and a centre on x = 8.5 belongs to the rectangle whose left edge that is.
  const one = state()
  assert.equal(draw(one, rect(one, 0, 0, 8.5, 16)).counts[8 * 16 + 8], 0)
  assert.equal(draw(one, rect(one, 8.5, 0, 16, 16)).counts[8 * 16 + 8], 1)
})

test('scissor and viewport: the viewport moves and scales the picture, the scissor cuts it, the attachment bounds it', () => {
  const st = state({ viewport: { x: 4, y: 2, width: 8, height: 8, near: 0, far: 1 } })
  const full = [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([x, y]) => ({ pos: [x, y, 0, 1], vary: [] }))
  const quad = [[full[0], full[1], full[2]], [full[0], full[2], full[3]]]
  const moved = picture(st, draw(st, quad).counts)
  assert.deepEqual(moved, Array.from({ length: 16 }, (_, y) => (y >= 2 && y < 10 ? '....########....' : '................')))
  const cut = state({ viewport: st.viewport, scissor: { x: 6, y: 0, width: 3, height: 5 } })
  assert.deepEqual(picture(cut, draw(cut, quad).counts), Array.from({ length: 16 }, (_, y) => (y >= 2 && y < 5 ? '......###.......' : '................')))
  // A scissor past the attachment is held to it; a viewport hanging off the attachment draws only what lies on it.
  const off = state({ viewport: { x: -4, y: 12, width: 8, height: 8, near: 0, far: 1 }, scissor: { x: 0, y: 0, width: 100, height: 100 } })
  assert.deepEqual(picture(off, draw(off, quad).counts).slice(10), ['................', '................', '####............', '####............', '####............', '####............'])
  // An empty scissor or an empty viewport draws nothing.
  assert.equal(draw(state({ scissor: { x: 3, y: 3, width: 0, height: 9 } }), quad).lanes.length, 0)
  assert.equal(draw(state({ viewport: { x: 3, y: 3, width: 0, height: 9, near: 0, far: 1 } }), quad).lanes.length, 0)
})

test('positions snap to the nearest 1/256 of a pixel, halves rounding up, before coverage is decided', () => {
  const st = state()
  // A left edge at x = 4.5 + d/256 covers column 4 (centre 4.5) exactly when it snaps to 4.5 or less.
  for (const [d, covered] of [[0.4, true], [0.5, false], [0.6, false], [-0.4, true], [-0.5, true], [-0.6, true]] as const) {
    const x = 4.5 + d / SUBPIXEL
    const { counts } = draw(st, [[at(st, x, 0), at(st, x, 16), at(st, 12, 8)]])
    assert.equal(counts[8 * 16 + 4], covered ? 1 : 0, `left edge at 4.5 + ${d}/256`)
  }
  // A top edge at y = 4.5 + d/256 covers row 4 exactly when it snaps to 4.5 or less.
  for (const [d, covered] of [[0.5, false], [-0.5, true], [0.4, true]] as const) {
    const y = 4.5 + d / SUBPIXEL
    const { counts } = draw(st, [[at(st, 0, y), at(st, 16, y), at(st, 8, 12)]])
    assert.equal(counts[4 * 16 + 8], covered ? 1 : 0, `top edge at 4.5 + ${d}/256`)
  }
})

test('an edge two triangles share is cut by a clip plane at the same point from both sides', () => {
  // P is inside and Q past x = w; cut from P toward Q or from Q toward P, the exact cut (y on a half 1/256 step) rounds
  // to different 1/256 steps, and the centre of pixel (12, 8) lies on the line from P to one of them. The cut is always
  // made from the inside end, so both triangles meet on one line and the centre is covered once.
  const st = state()
  const p = { pos: [0.5, -0.193359375, 0.5, 1], vary: [] }
  const q = { pos: [4.5, 6.3197021484375, 1.25, 2.5], vary: [] }
  for (const [a, b] of [[p, q], [q, p]]) {
    const { counts } = draw(st, [[a, b, at(st, 10, 0.25)], [b, a, at(st, 10, 15.75)]])
    assert.ok(counts.every((n) => n <= 1))
    assert.equal(counts[8 * 16 + 12], 1)
  }
})

test('a piece of a clipped fan that snapping turns over is skipped, so no sample is covered twice', () => {
  // Each triangle has one corner just in front of the near plane. Its clipped polygon has a corner a hair from the
  // next, and snapping turns the thin fan piece between them over; drawn, it would cover a sample its neighbour covers.
  const cases = [
    [[0.3643761448610756, -0.7942442068533544, 0.000006933214813820143, 0.9087503320770338], [1.8720694583056259, 0.21818123416049054, 1.715141913113801, 1.9055123893776909], [1.262547693029666, 1.7932593068335339, -0.08280933557465554, 1.5611266886116937]],
    [[-0.07055211650988696, 0.1495305854003149, 5.718082994876639e-7, 0.5995844594435766], [-0.9419150497786271, -0.10351029209920766, 1.1191851559525483, 1.2683191491523758], [0.8058126471016567, -0.01137287836793964, -0.16715428188303288, 1.3444927354576066]],
    [[0.30286877467244283, -0.5437546801877275, 0.00006002752279599122, 1.9669818669790402], [2.1185419764986744, -1.195830265748712, -0.3230170880545171, 1.9671272999839857], [0.7865312568171848, -1.1853759132257233, 0.27326388344851676, 0.9997656313935295]],
  ]
  const st = state({ width: 32, height: 32, samples: 4 })
  for (const c of cases) {
    const tri = c.map((pos) => ({ pos, vary: [] }))
    const { counts } = draw(st, [tri])
    assert.ok(counts.every((n) => n <= 1))
    // And what is covered is what the exact answer covers, away from the edges.
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        for (let k = 0; k < 4; k++) {
          const want = settled(st, tri, x + SAMPLE_POSITIONS[k][0], y + SAMPLE_POSITIONS[k][1])
          if (want !== -1) assert.equal(counts[(y * 32 + x) * 4 + k], want, `(${x}, ${y}) sample ${k}`)
        }
      }
    }
  }
})

// ---------------------------------------------------------------------------------------------------
// Facing and culling

test('facing: counter-clockwise as the image is seen faces the viewer with front ccw; cull drops the named side', () => {
  const st = state()
  // Down the left side, then right along the bottom: counter-clockwise as seen with the top row first.
  const ccw = [at(st, 2, 2), at(st, 2, 14), at(st, 14, 14)]
  const cw = [ccw[0], ccw[2], ccw[1]]
  for (const front of ['ccw', 'cw'] as const) {
    for (const cull of ['none', 'front', 'back'] as const) {
      for (const [winding, tri] of [['ccw', ccw], ['cw', cw]] as const) {
        const faces = winding === front
        const d = draw(state({ front, cull }), [tri])
        const drawn = cull === 'none' || (cull === 'back' && faces) || (cull === 'front' && !faces)
        assert.equal(d.lanes.length > 0, drawn, `front ${front}, cull ${cull}, winding ${winding}`)
        for (const l of d.lanes) assert.equal(l.front, faces)
      }
    }
  }
  // The usual first triangle in normalised device coordinates (top, bottom left, bottom right) faces the viewer.
  const hello = [[0, 0.5], [-0.5, -0.5], [0.5, -0.5]].map(([x, y]) => ({ pos: [x, y, 0, 1], vary: [] }))
  assert.ok(draw(state({ cull: 'back' }), [hello]).lanes.length > 0)
  assert.equal(draw(state({ cull: 'front' }), [hello]).lanes.length, 0)
})

test('every triangle of a strip keeps the strip winding, and its flat values come from vertex i', () => {
  const st = state({ cull: 'back' })
  const pts = [[2, 2], [2, 10], [6, 2], [6, 10], [10, 2], [10, 10], [14, 2]]
  const verts = pts.map(([x, y], i) => at(st, x, y, [100 + i, i]))
  const flat = [true, false]
  let triangles = 0
  for (const t of assemble('triangle-strip', verts.length)) {
    const d = draw(st, [[verts[t.a], verts[t.b], verts[t.c], verts[t.provoking]]], 2, flat)
    assert.ok(d.lanes.length > 0, `triangle ${triangles} faces the viewer like the rest of the strip`)
    for (const l of d.lanes) assert.equal(l.vary[0], 100 + triangles, 'flat from vertex i')
    triangles++
  }
  assert.equal(triangles, 5)
  // A list takes its flat values from each triangle's first vertex.
  for (const t of assemble('triangles', 6)) {
    const d = draw(state(), [[verts[t.a], verts[t.b], verts[t.c], verts[t.provoking]]], 2, flat)
    for (const l of d.lanes) assert.equal(l.vary[0], 100 + t.a)
  }
})

// ---------------------------------------------------------------------------------------------------
// Interpolation

test('perspective-correct values and 1/w, worked by hand', () => {
  const st = state()
  // A at (0, 0) with w 1 and value 0, B at (16, 0) with w 3 and value 1, C at (0, 16) with w 1 and value 0.
  const a = { pos: [-1, 1, 0, 1], vary: [0] }
  const b = { pos: [3, 3, 0, 3], vary: [1] }
  const c = { pos: [-1, -1, 0, 1], vary: [0] }
  const d = draw(st, [[a, b, c]], 1)
  // At the centre (7.5, 0.5) the screen weights are A 1/2, B 15/32, C 1/32. The value is (15/32 / 3) / (1/2 + 15/32 / 3
  // + 1/32) = 5/22, not the 15/32 a screen-linear blend would give, and 1/w there is 11/16.
  const l = laneAt(d, 7, 0)
  assert.ok(l)
  assert.ok(Math.abs(l.vary[0] - 5 / 22) < 1e-15, String(l.vary[0]))
  assert.equal(l.coord[3], 11 / 16)
  assert.deepEqual(l.coord.slice(0, 2), [7.5, 0.5])
})

/**
 * Where framebuffer point (fx, fy) meets the plane of a triangle in clip space: the weights (summing to 1) of the
 * clip-space point of that plane which projects there, or null when no point of it does.
 */
function weightsAt(st: RasterState, tri: readonly ClipVertex[], fx: number, fy: number): number[] | null {
  const vp = st.viewport
  const nx = ((fx - vp.x) / vp.width) * 2 - 1
  const ny = 1 - ((fy - vp.y) / vp.height) * 2
  const r1 = tri.map((v) => v.pos[0] - nx * v.pos[3])
  const r2 = tri.map((v) => v.pos[1] - ny * v.pos[3])
  const b = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]]
  const sum = b[0] + b[1] + b[2]
  return sum === 0 ? null : b.map((x) => x / sum)
}

/** The clip-space point of a triangle with the given weights. */
const pointOf = (tri: readonly ClipVertex[], b: readonly number[]): number[] => [0, 1, 2, 3].map((k) => b[0] * tri[0].pos[k] + b[1] * tri[1].pos[k] + b[2] * tri[2].pos[k])

/** Whether the triangle, clipped as the rules say, covers framebuffer point (fx, fy) exactly (no snapping). */
function visible(st: RasterState, tri: readonly ClipVertex[], fx: number, fy: number): boolean {
  const b = weightsAt(st, tri, fx, fy)
  if (b === null || b.some((x) => x < 0)) return false
  const [x, y, z, w] = pointOf(tri, b)
  if (!(w > 0) || Math.abs(x) > w || Math.abs(y) > w) return false
  return st.unclipped || (z >= 0 && z <= w)
}

/** 1 when the point and four points around it are all covered, 0 when none is, and -1 near an edge. */
function settled(st: RasterState, tri: readonly ClipVertex[], fx: number, fy: number): number {
  const d = 1 / 32
  const all = [[0, 0], [d, d], [d, -d], [-d, d], [-d, -d]].map(([ox, oy]) => visible(st, tri, fx + ox, fy + oy))
  return all.every(Boolean) ? 1 : all.some(Boolean) ? -1 : 0
}

test('on the 1/256 grid, every lane (helpers too) carries the exact perspective-correct value, 1/w and depth', () => {
  const rand = lcg(3)
  const st = state({ width: 32, height: 32, viewport: { x: 0, y: 0, width: 32, height: 32, near: 0.25, far: 0.75 } })
  let lanes = 0
  for (let trial = 0; trial < 200; trial++) {
    const grid = (): number => Math.round(rand() * 32 * SUBPIXEL) / SUBPIXEL
    const p = [[grid(), grid()], [grid(), grid()], [grid(), grid()]]
    const area = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0])
    const longest = Math.max(...[0, 1, 2].map((i) => Math.hypot(p[(i + 1) % 3][0] - p[i][0], p[(i + 1) % 3][1] - p[i][1])))
    // Keep triangles whose lowest altitude is at least 3 pixels, so a helper lane one pixel out stays well in front.
    if (Math.abs(area) / longest < 3) continue
    const tri = p.map(([x, y]) => at(st, x, y, [rand() * 10 - 5, rand()], rand(), 0.5 + 1.5 * rand()))
    const d = draw(st, [tri], 2)
    for (const l of d.lanes) {
      const b = weightsAt(st, tri, l.px + 0.5, l.py + 0.5)
      assert.ok(b)
      const [, , z, w] = pointOf(tri, b)
      for (let k = 0; k < 2; k++) {
        const want = b[0] * tri[0].vary[k] + b[1] * tri[1].vary[k] + b[2] * tri[2].vary[k]
        assert.ok(Math.abs(l.vary[k] - want) <= 1e-9 * (1 + Math.abs(want)), `trial ${trial} (${l.px}, ${l.py}) value ${k}: ${l.vary[k]} vs ${want}`)
      }
      assert.ok(Math.abs(l.coord[3] - 1 / w) <= 1e-9 / w)
      const depth = Math.min(0.75, Math.max(0.25, 0.25 + (z / w) * 0.5))
      assert.ok(Math.abs(l.coord[2] - depth) <= 1e-9, `depth ${l.coord[2]} vs ${depth}`)
      assert.equal(l.depth[0], l.coord[2], 'one sample: its depth is the centre depth')
      lanes++
    }
  }
  assert.ok(lanes > 5000, String(lanes))
})

test('helper lanes extrapolate the planes, so differences across a quad are the true rates of change', () => {
  const st = state()
  // A triangle covering only the centre of pixel (5, 5), with values equal to framebuffer x and y.
  const tri = [[5.125, 5.125], [6, 5.125], [5.125, 6]].map(([x, y]) => at(st, x, y, [x, y]))
  const d = draw(st, [tri], 2)
  assert.deepEqual(d.lanes.map((l) => [l.px, l.py, l.mask]), [[4, 4, 0], [5, 4, 0], [4, 5, 0], [5, 5, 1]])
  for (const l of d.lanes) {
    assert.ok(Math.abs(l.vary[0] - (l.px + 0.5)) < 1e-12)
    assert.ok(Math.abs(l.vary[1] - (l.py + 0.5)) < 1e-12)
    assert.deepEqual(l.coord, [l.px + 0.5, l.py + 0.5, 0, 1])
  }
})

test('depth is linear in screen space at each sample position and maps through the depth range, either way round', () => {
  for (const samples of [1, 4] as const) {
    for (const [near, far] of [[0, 1], [0.25, 0.75], [1, 0]]) {
      const st = state({ samples, viewport: { x: 0, y: 0, width: 16, height: 16, near, far } })
      // z runs 0 at (0, 0), 1/2 at (16, 0) and 1 at (0, 16), so z = x/32 + y/16 at a framebuffer point.
      const d = draw(st, [[at(st, 0, 0, [], 0), at(st, 16, 0, [], 0.5), at(st, 0, 16, [], 1)]])
      const offs = samples === 1 ? [[0.5, 0.5]] : SAMPLE_POSITIONS
      for (const l of d.lanes) {
        // Helper lanes past the long edge extrapolate beyond z = 1, and are clamped like any other.
        const z = (x: number, y: number): number => Math.min(Math.max(near, far), Math.max(Math.min(near, far), near + (x / 32 + y / 16) * (far - near)))
        assert.ok(Math.abs(l.coord[2] - z(l.px + 0.5, l.py + 0.5)) < 1e-15)
        for (let s = 0; s < samples; s++) assert.ok(Math.abs(l.depth[s] - z(l.px + offs[s][0], l.py + offs[s][1])) < 1e-15, `sample ${s}`)
      }
    }
  }
})

test('depth past the far or near plane is clipped away, or with unclipped depth drawn and clamped into the range', () => {
  for (const samples of [1, 4] as const) {
    const mk = (unclipped: boolean): RasterState => state({ samples, unclipped })
    // z/w runs 1/2 at (0, 0) and (0, 16) to 2 at (16, 0): it passes the far plane at x = 16/3.
    const tri = (st: RasterState): ClipVertex[] => [at(st, 0, 0, [], 0.5), at(st, 16, 0, [], 2), at(st, 0, 16, [], 0.5)]
    const kept = draw(mk(true), [tri(mk(true))])
    const cut = draw(mk(false), [tri(mk(false))])
    const offs = samples === 1 ? [[0.5, 0.5]] : SAMPLE_POSITIONS
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        for (let s = 0; s < samples; s++) {
          const fx = x + offs[s][0]
          const fy = y + offs[s][1]
          // The long edge x + y = 16 is a right edge: points on it are not covered.
          const inside = fx + fy < 16
          const n = (y * 16 + x) * samples + s
          assert.equal(kept.counts[n], inside ? 1 : 0, `unclipped (${x}, ${y}) sample ${s}`)
          // The clipped edge lies at x = 16/3, snapped to 1365/256.
          assert.equal(cut.counts[n], inside && fx * SUBPIXEL < 1365 ? 1 : 0, `clipped (${x}, ${y}) sample ${s}`)
        }
      }
    }
    for (const l of kept.lanes) {
      assert.ok(Math.abs(l.coord[2] - Math.min(1, 0.5 + (1.5 * (l.px + 0.5)) / 16)) < 1e-15)
      for (let s = 0; s < samples; s++) assert.ok(l.depth[s] <= 1 && l.depth[s] >= 0.5)
    }
    for (const l of cut.lanes) for (let s = 0; s < samples; s++) if (l.mask & (1 << s)) assert.ok(l.depth[s] <= 1)
  }
  // Below the near plane, unclipped depth clamps to near.
  const st = state({ unclipped: true, viewport: { x: 0, y: 0, width: 16, height: 16, near: 0.25, far: 0.75 } })
  const below = draw(st, [[at(st, 0, 0, [], -1), at(st, 16, 0, [], -1), at(st, 0, 16, [], -1)]])
  assert.ok(below.lanes.length > 0)
  for (const l of below.lanes) assert.equal(l.coord[2], 0.25)
  assert.equal(draw(state(), [[at(st, 0, 0, [], -1), at(st, 16, 0, [], -1), at(st, 0, 16, [], -1)]]).lanes.length, 0)
})

test('clipping at the near plane, w = 0 and the sides matches the exact homogeneous answer in coverage, values and depth', () => {
  const rand = lcg(11)
  const r = (lo: number, hi: number): number => lo + (hi - lo) * rand()
  let compared = 0
  let clippedNear = 0
  for (let trial = 0; trial < 300; trial++) {
    const unclipped = trial % 4 === 3
    const st = state({ width: 24, height: 20, unclipped, viewport: { x: 0, y: 0, width: 24, height: 20, near: 0.25, far: 0.75 } })
    const tri = [0, 1, 2].map(() => ({ pos: [r(-2, 2), r(-2, 2), r(-1, 2), r(-0.6, 2)], vary: [r(-5, 5)] }))
    if (tri.some((v) => v.pos[2] < 0 || v.pos[3] < 0)) clippedNear++
    const d = draw(st, [tri], 1)
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 24; x++) {
        const want = settled(st, tri, x + 0.5, y + 0.5)
        if (want === -1) continue
        assert.equal(d.counts[y * 24 + x], want, `trial ${trial} (${x}, ${y})`)
        if (want === 0) continue
        const l = laneAt(d, x, y)
        assert.ok(l)
        // Snapping moves a corner by at most 1/512 pixel, so the value may differ by that much of its rate of change.
        const value = (fx: number, fy: number): number => {
          const b = weightsAt(st, tri, fx, fy)
          return b === null ? NaN : b[0] * tri[0].vary[0] + b[1] * tri[1].vary[0] + b[2] * tri[2].vary[0]
        }
        const depth = (fx: number, fy: number): number => {
          const b = weightsAt(st, tri, fx, fy)
          if (b === null) return NaN
          const p = pointOf(tri, b)
          return Math.min(0.75, Math.max(0.25, 0.25 + (p[2] / p[3]) * 0.5))
        }
        for (const [f, got] of [[value, l.vary[0]], [depth, l.coord[2]]] as const) {
          const c = f(x + 0.5, y + 0.5)
          const rate = Math.abs(f(x + 1.5, y + 0.5) - f(x - 0.5, y + 0.5)) + Math.abs(f(x + 0.5, y + 1.5) - f(x + 0.5, y - 0.5))
          assert.ok(Math.abs(got - c) <= 0.05 * rate + 1e-9 * (1 + Math.abs(c)), `trial ${trial} (${x}, ${y}): ${got} vs ${c}`)
        }
        compared++
      }
    }
  }
  assert.ok(compared > 10000, String(compared))
  assert.ok(clippedNear > 100)
})

/**
 * Whether framebuffer point (fx, fy) of a 40 x 30 viewport sees the part of the clip-space plane O + sU + tV with s
 * and t in [0, 1] that the rules keep (in front of the eye, and between the depth planes unless unclipped).
 */
function onPlane(o: readonly number[], u: readonly number[], v: readonly number[], unclipped: boolean, fx: number, fy: number): boolean {
  const nx = (fx / 40) * 2 - 1
  const ny = 1 - (fy / 30) * 2
  const m = [u[0] - nx * u[3], v[0] - nx * v[3], u[1] - ny * u[3], v[1] - ny * v[3]]
  const rhs = [nx * o[3] - o[0], ny * o[3] - o[1]]
  const det = m[0] * m[3] - m[1] * m[2]
  if (det === 0) return false
  const s = (rhs[0] * m[3] - m[1] * rhs[1]) / det
  const t = (m[0] * rhs[1] - rhs[0] * m[2]) / det
  const w = o[3] + s * u[3] + t * v[3]
  const z = o[2] + s * u[2] + t * v[2]
  return s >= 0 && s <= 1 && t >= 0 && t <= 1 && w > 0 && (unclipped || (z >= 0 && z <= w))
}

test('a perspective mesh through the near plane, w = 0 and the sides is watertight: no sample twice, none missed', () => {
  const rand = lcg(7)
  const r = (lo: number, hi: number): number => lo + (hi - lo) * rand()
  const crossed = { near: 0, behind: 0, far: 0 }
  for (let trial = 0; trial < 12; trial++) {
    for (const samples of [1, 4] as const) {
      const unclipped = trial % 3 === 2
      const st = state({ width: 40, height: 30, samples, unclipped })
      // The mesh lies on the plane O + sU + tV of clip space, for s and t in [0, 1]; a plane is drawn again until at
      // least a third of the pixel centres see it, so every trial has plenty inside to check.
      let o: number[] = []
      let u: number[] = []
      let v: number[] = []
      for (let tries = 0; ; tries++) {
        assert.ok(tries < 500, 'a plane that fills the screen')
        o = [r(-2.5, -1.2), r(-2.5, -1.2), r(-0.4, 0.15), r(0.4, 1.2)]
        u = [r(2.5, 4.5), r(-0.5, 0.5), r(0, 0.8), r(-1.4, 0.6)]
        v = [r(-0.5, 0.5), r(2.5, 4.5), r(0, 0.8), r(-1.4, 0.6)]
        let seen = 0
        for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) if (onPlane(o, u, v, unclipped, x + 0.5, y + 0.5)) seen++
        if (seen >= 400) break
      }
      const n = 6
      const vert: ClipVertex[][] = []
      for (let i = 0; i <= n; i++) {
        vert.push([])
        for (let j = 0; j <= n; j++) {
          // Inner vertices move by up to a quarter of a cell; the border stays straight.
          const s = (i + (i > 0 && i < n ? r(-0.25, 0.25) : 0)) / n
          const t = (j + (j > 0 && j < n ? r(-0.25, 0.25) : 0)) / n
          const pos = [0, 1, 2, 3].map((k) => o[k] + s * u[k] + t * v[k])
          if (pos[2] < 0) crossed.near++
          if (pos[3] < 0) crossed.behind++
          if (pos[2] > pos[3]) crossed.far++
          vert[i].push({ pos, vary: [] })
        }
      }
      const tris: ClipVertex[][] = []
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const [a, b, c, e] = [vert[i][j], vert[i + 1][j], vert[i + 1][j + 1], vert[i][j + 1]]
          tris.push(...((i + j) % 2 === 0 ? [[a, b, c], [a, c, e]] : [[a, b, e], [b, c, e]]))
        }
      }
      const { counts } = draw(st, tris)
      const offs = samples === 1 ? [[0.5, 0.5]] : SAMPLE_POSITIONS
      let once = 0
      for (let y = 0; y < 30; y++) {
        for (let x = 0; x < 40; x++) {
          for (let k = 0; k < samples; k++) {
            const fx = x + offs[k][0]
            const fy = y + offs[k][1]
            const got = counts[(y * 40 + x) * samples + k]
            assert.ok(got <= 1, `trial ${trial}: (${x}, ${y}) sample ${k} covered ${got} times`)
            const d = 1 / 32
            const around = [[0, 0], [d, d], [d, -d], [-d, d], [-d, -d]].map(([ox, oy]) => onPlane(o, u, v, unclipped, fx + ox, fy + oy))
            if (around.every(Boolean)) {
              assert.equal(got, 1, `trial ${trial}: (${x}, ${y}) sample ${k} missed`)
              once++
            } else if (!around.some(Boolean)) {
              assert.equal(got, 0, `trial ${trial}: (${x}, ${y}) sample ${k} covered outside the mesh`)
            }
          }
        }
      }
      assert.ok(once > 300 * samples, `trial ${trial} checked only ${once} samples inside`)
    }
  }
  assert.ok(crossed.near > 20 && crossed.behind > 20 && crossed.far > 20, JSON.stringify(crossed))
})

test('flat values come from the provoking vertex unchanged, through clipping, while the others interpolate', () => {
  const st = state()
  const big = 4294967295
  // The second vertex lies past the right side, so the triangle is clipped; the flat value is a whole u32.
  const a = at(st, 2, 2, [7, 0])
  const b = at(st, 30, 8, [big, 1])
  const c = at(st, 2, 14, [-3, 2])
  for (const [prov, want] of [[a, 7], [b, big], [c, -3]] as const) {
    const d = draw(st, [[a, b, c, prov]], 2, [true, false])
    assert.ok(d.lanes.length > 0)
    for (const l of d.lanes) assert.equal(l.vary[0], want)
    assert.ok(d.lanes.some((l) => l.vary[1] > 0.1 && l.vary[1] < 1.9), 'the second value interpolates')
  }
  // With no flat flags every value interpolates.
  const d = draw(st, [[a, b, c]], 2, null)
  assert.ok(d.lanes.some((l) => l.vary[0] !== 7))
})

// ---------------------------------------------------------------------------------------------------
// What draws nothing, and what is refused

test('a triangle with no area, no finite position, or nothing in front draws nothing', () => {
  const st = state()
  const none = (tri: ClipVertex[]): void => assert.equal(draw(st, [tri]).lanes.length, 0, JSON.stringify(tri.map((v) => Array.from(v.pos))))
  none([at(st, 2, 2), at(st, 8, 8), at(st, 14, 14)])
  none([at(st, 2, 2), at(st, 2, 2), at(st, 14, 8)])
  none([at(st, 5.6, 5.6), at(st, 5.9, 5.6), at(st, 5.6, 5.9)])
  for (const bad of [NaN, Infinity, -Infinity, 1e39]) none([{ pos: [bad, 0, 0, 1], vary: [] }, at(st, 2, 14), at(st, 14, 14)])
  none([{ pos: [0, 0, 0, NaN], vary: [] }, at(st, 2, 14), at(st, 14, 14)])
  none([0, 1, 2].map((i) => ({ pos: [i, 1 - i, 0.5, -1], vary: [] })))
  none([0, 1, 2].map((i) => ({ pos: [2 + i, i, 0.5, 1], vary: [] })))
  none([0, 1, 2].map((i) => ({ pos: [i * 1e-3, 0, 0, W_MIN / 2], vary: [] })))
  // A sliver thinner than a pixel that reaches no centre.
  none([at(st, 0, 3.6), at(st, 16, 3.7), at(st, 0, 3.7)])
})

test('the scan of a sliver whose box is large is told before it begins: every quad of the box within the scissor, covered or not', () => {
  const charged = (st: RasterState, tri: readonly ClipVertex[], charge: (quads: number) => void = () => {}): { readonly quads: number[]; readonly emitted: number } => {
    const quads: number[] = []
    let emitted = 0
    new Raster(st, 0, null, (n) => { quads.push(n); charge(n) }).triangle(tri[0], tri[1], tri[2], tri[0], () => { emitted++ })
    return { quads, emitted }
  }
  // A wedge just below the line y = x - 0.25 from corner to corner: it holds no pixel centre, but its box is the whole
  // attachment, 8 x 8 quads of 16 x 16 pixels.
  const st = state()
  const sliver = [at(st, 0.25, 0), at(st, 16, 15.75), at(st, 16, 15.734375)]
  assert.deepEqual(charged(st, sliver), { quads: [64], emitted: 0 })
  // A scissor clips the scan first: pixels 3 to 8 by 5 to 8 lie in the quads at columns 2, 4, 6, 8 and rows 4, 6, 8.
  assert.deepEqual(charged(state({ scissor: { x: 3, y: 5, width: 6, height: 4 } }), sliver).quads, [12])
  // A box wholly outside the scissor visits nothing and is told nothing.
  assert.deepEqual(charged(state({ scissor: { x: 0, y: 8, width: 4, height: 4 } }), [at(st, 10, 1), at(st, 14, 1), at(st, 12, 4)]), { quads: [], emitted: 0 })
  // A triangle that covers pixels is told its box too: the quads it hands out are some of those.
  const half = charged(st, [at(st, 0, 0), at(st, 0, 16), at(st, 16, 0)])
  assert.deepEqual(half.quads, [64])
  assert.equal(half.emitted, 36)
  // A clipped triangle is told once per piece of its fan, each piece's own box.
  const wide = charged(st, [at(st, -16, 8), at(st, 32, -8), at(st, 32, 24)])
  assert.ok(wide.quads.length >= 2 && wide.quads.every((n) => n > 0 && n <= 64), String(wide.quads))
  // A charge that throws stops the triangle before any quad is scanned or handed out.
  let emitted = 0
  const stop = new Raster(st, 0, null, () => { throw new RangeError('past the budget') })
  assert.throws(() => stop.triangle(at(st, 0, 0), at(st, 0, 16), at(st, 16, 0), at(st, 0, 0), () => { emitted++ }), RangeError)
  assert.equal(emitted, 0)
  faults(() => new Raster(st, 0, null, 'charge' as unknown as () => void))
})

test('a clipped triangle is scanned, and told, once per triangle of its fan, each with its own box, so overlapping boxes are told twice', () => {
  // The usual full-screen triangle is clipped to the view square and drawn as a fan of two triangles; each one's box is
  // the whole attachment, 8 x 8 quads. The quads along their shared diagonal are handed out by both, each covering
  // different pixels, and every pixel is covered exactly once.
  const st = state()
  const quads: number[] = []
  const counts = new Uint8Array(16 * 16)
  let emitted = 0
  const raster = new Raster(st, 0, null, (n) => quads.push(n))
  const big = [at(st, 0, 16), at(st, 32, 16), at(st, 0, -16)]
  raster.triangle(big[0], big[1], big[2], big[0], (q) => {
    emitted++
    for (let lane = 0; lane < 4; lane++) if (q.mask[lane] !== 0) counts[(q.y + (lane >> 1)) * 16 + q.x + (lane & 1)]++
  })
  assert.deepEqual(quads, [64, 64])
  assert.equal(emitted, 64 + 8)
  assert.deepEqual(Array.from(counts), new Array(16 * 16).fill(1))
})

test('the state, the values and the vertices are checked, and the state is kept as a frozen copy', () => {
  const bad: Setup[] = [
    { width: 0 }, { width: 1.5 }, { height: RASTER_BOUND + 1 }, { width: NaN },
    { viewport: { x: 0, y: 0, width: -1, height: 16, near: 0, far: 1 } },
    { viewport: { x: 0, y: 0, width: 16, height: 16, near: NaN, far: 1 } },
    { viewport: { x: RASTER_BOUND, y: 0, width: 1, height: 16, near: 0, far: 1 } },
    { viewport: { x: -RASTER_BOUND - 1, y: 0, width: 16, height: 16, near: 0, far: 1 } },
    { viewport: null as unknown as RasterState['viewport'] },
    { scissor: { x: -1, y: 0, width: 4, height: 4 } }, { scissor: { x: 0, y: 0, width: 2.5, height: 4 } },
    { scissor: undefined as unknown as RasterState['scissor'] },
    { cull: 'both' as 'none' }, { front: 'left' as 'cw' }, { samples: 2 as 1 }, { unclipped: 1 as unknown as boolean },
  ]
  for (const o of bad) faults(() => new Raster(state(o), 0, null))
  faults(() => new Raster(null as unknown as RasterState, 0, null))
  for (const v of [-1, 1.5, MAX_VARYINGS + 1, NaN]) faults(() => new Raster(state(), v, null))
  faults(() => new Raster(state(), 2, [true]))
  faults(() => new Raster(state(), 2, 'yes' as unknown as boolean[]))
  // The edges of what is allowed are allowed.
  new Raster(state({ viewport: { x: -RASTER_BOUND, y: -RASTER_BOUND, width: 2 * RASTER_BOUND, height: 2 * RASTER_BOUND, near: 0, far: 1 } }), MAX_VARYINGS, null)
  const raster = new Raster(state(), 1, [false])
  const ok = at(state(), 1, 1, [0])
  const emit = (): void => {}
  faults(() => raster.triangle({ pos: [0, 0, 0], vary: [0] }, ok, ok, ok, emit))
  faults(() => raster.triangle(ok, { pos: [0, 0, 0, 1], vary: [] }, ok, ok, emit))
  faults(() => raster.triangle(ok, ok, null as unknown as ClipVertex, ok, emit))
  faults(() => raster.triangle(ok, ok, ok, undefined as unknown as ClipVertex, emit))
  faults(() => raster.triangle(ok, ok, ok, ok, 'emit' as unknown as () => void))
  const source = state()
  const kept = new Raster(source, 0, null)
  assert.ok(Object.isFrozen(kept.state) && Object.isFrozen(kept.state.viewport) && Object.isFrozen(kept.state.scissor))
  assert.notEqual(kept.state, source)
  assert.deepEqual(kept.state, source)
})

test('a viewport at the bound keeps coverage exact: edge functions stay whole numbers far from the origin', () => {
  // A viewport 65536 pixels wide centred on the origin puts the attachment's 16 pixels at its middle, where a clip
  // position of 1/4096 is one pixel. Two triangles meeting there still cover every pixel once.
  const st = state({ viewport: { x: -RASTER_BOUND, y: -RASTER_BOUND, width: 2 * RASTER_BOUND, height: 2 * RASTER_BOUND, near: 0, far: 1 } })
  const p = (fx: number, fy: number): ClipVertex => ({ pos: [(fx + RASTER_BOUND) / RASTER_BOUND - 1, 1 - (fy + RASTER_BOUND) / RASTER_BOUND, 0, 1], vary: [] })
  const { counts } = draw(st, [[p(-1, -1), p(17, -1), p(17, 17)], [p(-1, -1), p(17, 17), p(-1, 17)], [p(RASTER_BOUND, -RASTER_BOUND), p(RASTER_BOUND, RASTER_BOUND), p(-RASTER_BOUND, RASTER_BOUND)]])
  for (let i = 0; i < 256; i++) assert.equal(counts[i], 2, `pixel ${i}: once by the pair, once by the large triangle`)
})
