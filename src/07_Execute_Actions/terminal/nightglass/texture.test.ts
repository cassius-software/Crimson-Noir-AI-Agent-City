// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins how the reference renderer keeps and reads images: the byte layout of levels,
 * layers, rows and samples, the checked texel reads and writes, and every rule of the texture unit with exact values
 * worked by hand (wrapping at the edges in each mode, linear filter weights, the choice and blending of mip levels,
 * the clamps on level of detail and on the view, layer rounding, sRGB filtered in linear light, the level of detail
 * from rates of change, the load that reads zero outside, and the storage write that drops it).
 * What breaks if it is removed? A texel could move to another byte, an edge could wrap the wrong way or a level be
 * picked half a step late, and textured pictures from the reference renderer would stop matching a GPU's.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isFault } from './fault.ts'
import type { FaultCode } from './fault.ts'
import { FORMATS, decodeSrgb, fromUnorm } from './formats.ts'
import { ImageStore, STORE_MAX_LAYERS, STORE_MAX_SIZE, imageSize, levelSize, load, lodFromRates, put, sample } from './texture.ts'
import type { ImageDesc, SamplerState, ViewRange } from './texture.ts'

const faults = (fn: () => unknown, code: FaultCode = 'invalid'): void => {
  assert.throws(fn, (e: unknown) => isFault(e, code))
}

const desc = (o: Partial<ImageDesc> = {}): ImageDesc => ({ format: 'rgba8', width: 4, height: 4, layers: 1, levels: 1, samples: 1, ...o })
const whole = (s: ImageStore): ViewRange => ({ levels: { base: 0, count: s.levels }, layers: { base: 0, count: s.layers } })
const sampler = (o: Partial<SamplerState> = {}): SamplerState => ({ mag: 'nearest', min: 'nearest', mip: 'nearest', wrap: ['clamp', 'clamp', 'clamp'], lodMin: 0, lodMax: 32, ...o })

/** A one-channel float image whose texel (x, y) of level l, layer k holds value(x, y, l, k). */
function filled(width: number, height: number, value: (x: number, y: number, level: number, layer: number) => number, o: Partial<ImageDesc> = {}): ImageStore {
  const s = new ImageStore(desc({ format: 'r32f', width, height, ...o }))
  for (let l = 0; l < s.levels; l++) {
    for (let k = 0; k < s.layers; k++) {
      for (let y = 0; y < s.levelHeight(l); y++) for (let x = 0; x < s.levelWidth(l); x++) s.write(l, k, x, y, 0, [value(x, y, l, k)])
    }
  }
  return s
}

/** The filtered colour at (u, v). */
function at(s: ImageStore, sm: SamplerState, u: number, v = 0.5, layer = 0, lod = 0, view: ViewRange = whole(s)): number[] {
  const out: number[] = []
  sample(s, view, sm, u, v, layer, lod, out)
  return out
}

/** The texel load at (x, y). */
function loaded(s: ImageStore, x: number, y: number, layer = 0, level = 0, view: ViewRange = whole(s)): number[] {
  const out: number[] = []
  load(s, view, x, y, layer, level, out)
  return out
}

test('layout: level by level, layer by layer, row by row, pixel by pixel, sample by sample, levels halving down to 1', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map((l) => levelSize(5, l)), [5, 2, 1, 1, 1])
  assert.equal(levelSize(8192, 13), 1)
  assert.equal(levelSize(32768, 32), 1, 'no shift wraps round at 32')
  assert.equal(levelSize(32768, 14), 2)
  const d = desc({ width: 5, height: 3, layers: 2, levels: 3 })
  // Levels of 5 x 3, 2 x 1 and 1 x 1 texels, two layers each, four bytes a texel.
  assert.equal(imageSize(d), 144)
  const s = new ImageStore(d)
  assert.deepEqual(s.starts, [0, 120, 136, 144])
  assert.equal(s.bytes.length, 144)
  assert.equal(s.texelBytes, 4)
  assert.deepEqual([s.levelWidth(1), s.levelHeight(1), s.levelWidth(2), s.levelHeight(2)], [2, 1, 1, 1])
  assert.equal(s.offset(0, 0, 0, 0), 0)
  assert.equal(s.offset(0, 0, 1, 0), 4)
  assert.equal(s.offset(0, 0, 0, 1), 20)
  assert.equal(s.offset(0, 1, 0, 0), 60)
  assert.equal(s.offset(1, 1, 1, 0), 132)
  assert.equal(s.offset(2, 1, 0, 0), 140)
  const m = new ImageStore(desc({ format: 'r16f', width: 3, height: 2, samples: 4 }))
  assert.equal(m.offset(0, 0, 1, 1, 3), ((1 * 3 + 1) * 4 + 3) * 2)
  // Every sample of every texel has bytes of its own, and together they fill the store without a gap.
  const big = new ImageStore(desc({ format: 'rg16f', width: 7, height: 5, layers: 3, levels: 3, samples: 4 }))
  const offsets: number[] = []
  for (let l = 0; l < 3; l++) for (let k = 0; k < 3; k++) for (let y = 0; y < big.levelHeight(l); y++) for (let x = 0; x < big.levelWidth(l); x++) for (let q = 0; q < 4; q++) offsets.push(big.offset(l, k, x, y, q))
  assert.deepEqual(offsets, offsets.map((_, i) => i * 4), 'offsets rise by one texel in layout order')
  assert.equal(offsets.length * 4, imageSize(big))
})

test('a store is checked: format, size, layers, levels, samples, bytes, and every texel address', () => {
  const bad: Partial<ImageDesc>[] = [
    { format: 'rgb8' as 'rgba8' }, { width: 0 }, { width: 1.5 }, { height: STORE_MAX_SIZE + 1 }, { width: NaN },
    { layers: 0 }, { layers: STORE_MAX_LAYERS + 1 }, { levels: 0 }, { width: 8, height: 8, levels: 5 }, { samples: 2 as 1 },
  ]
  for (const o of bad) {
    faults(() => new ImageStore(desc(o)))
    faults(() => imageSize(desc(o)))
  }
  faults(() => new ImageStore(null as unknown as ImageDesc))
  // An 8 x 5 image has four levels (8 x 5, 4 x 2, 2 x 1, 1 x 1).
  assert.equal(new ImageStore(desc({ width: 8, height: 5, levels: 4 })).levels, 4)
  faults(() => new ImageStore(desc(), new Uint8Array(63)))
  faults(() => new ImageStore(desc(), new Int8Array(64) as unknown as Uint8Array))
  faults(() => new ImageStore(desc({ format: 'rgba32f', width: STORE_MAX_SIZE, height: STORE_MAX_SIZE, layers: STORE_MAX_LAYERS, samples: 4 })), 'memory')
  const s = new ImageStore(desc({ width: 4, height: 2, levels: 2 }))
  for (const [l, k, x, y, q] of [[0, 0, 4, 0, 0], [0, 0, 0, 2, 0], [2, 0, 0, 0, 0], [0, 1, 0, 0, 0], [0, 0, 0, 0, 1], [0, 0, -1, 0, 0], [0, 0, 0.5, 0, 0], [0, 0, NaN, 0, 0], [1, 0, 2, 0, 0], [1, 0, 0, 1, 0]]) {
    faults(() => s.offset(l, k, x, y, q))
    faults(() => s.read(l, k, x, y, q, []))
    faults(() => s.write(l, k, x, y, q, [0, 0, 0, 0]))
  }
  assert.equal(s.offset(1, 0, 1, 0), 32 + 4)
})

test("reads and writes go through the format, into the store's own bytes or a slice of memory it is given", () => {
  const memory = new Uint8Array(100).fill(0xee)
  const s = new ImageStore(desc({ width: 2, height: 2 }), memory.subarray(20))
  assert.equal(s.bytes.length, 16)
  s.write(0, 0, 1, 1, 0, [1, 0.5, 0, 0.25])
  assert.deepEqual([...memory.subarray(32, 36)], [255, 128, 0, 64])
  assert.equal(memory[31], 0xee)
  assert.equal(memory[36], 0xee)
  const out: number[] = []
  s.read(0, 0, 1, 1, 0, out)
  assert.deepEqual(out, [1, fromUnorm(128, 8), 0, fromUnorm(64, 8)])
  const own = new ImageStore(desc({ format: 'bgra8', width: 1, height: 1 }))
  assert.deepEqual([...own.bytes], [0, 0, 0, 0], 'a store of its own starts zeroed')
  own.write(0, 0, 0, 0, 0, [1, 0, 0, 1])
  assert.deepEqual([...own.bytes], [0, 0, 255, 255])
})

test('nearest filtering picks texel floor(u W), wrapped at the edges by clamp, repeat or mirror', () => {
  const s = filled(4, 1, (x) => 10 * (x + 1))
  // u and floor(4u):        -5     -1     -1      0  0      0      1     3     4  4      5     8
  const us = [-1.25, -0.25, -0.125, 0, 0.125, 0.249, 0.25, 0.99, 1, 1.125, 1.25, 2.1]
  const want = {
    clamp: [0, 0, 0, 0, 0, 0, 1, 3, 3, 3, 3, 3],
    repeat: [3, 3, 3, 0, 0, 0, 1, 3, 0, 0, 1, 0],
    // Period 8, the second half reversed: index -1 reads texel 0, index 4 reads texel 3, index 5 texel 2.
    mirror: [3, 0, 0, 0, 0, 0, 1, 3, 3, 3, 2, 0],
  }
  for (const mode of ['clamp', 'repeat', 'mirror'] as const) {
    const got = us.map((u) => at(s, sampler({ wrap: [mode, 'clamp', 'clamp'] }), u)[0])
    assert.deepEqual(got, want[mode].map((i) => 10 * (i + 1)), mode)
  }
  // The v axis wraps by its own mode.
  const tall = filled(1, 4, (_, y) => y)
  assert.deepEqual([-0.25, 1.25].map((v) => at(tall, sampler({ wrap: ['clamp', 'repeat', 'clamp'] }), 0.5, v)[0]), [3, 1])
  assert.deepEqual([-0.25, 1.25].map((v) => at(tall, sampler({ wrap: ['repeat', 'mirror', 'repeat'] }), 0.5, v)[0]), [0, 2])
})

test('linear filtering blends the four texels around (u W - 0.5, v H - 0.5) by its fractions, wrapping each', () => {
  const s = filled(4, 1, (x) => 10 * (x + 1))
  const lin = (mode: 'clamp' | 'repeat' | 'mirror'): SamplerState => sampler({ mag: 'linear', wrap: [mode, mode, mode] })
  for (const mode of ['clamp', 'repeat', 'mirror'] as const) {
    assert.equal(at(s, lin(mode), 0.4375)[0], 22.5, `${mode}: three quarters of 20 and a quarter of 30`)
    assert.equal(at(s, lin(mode), 0.125)[0], 10, `${mode}: exactly on a texel centre`)
  }
  // At u = 0 the blend is half texel -1, half texel 0; at u = 1 half texel 3, half texel 4.
  assert.deepEqual(['clamp', 'repeat', 'mirror'].map((m) => at(s, lin(m as 'clamp'), 0)[0]), [10, 25, 10])
  assert.deepEqual(['clamp', 'repeat', 'mirror'].map((m) => at(s, lin(m as 'clamp'), 1)[0]), [40, 25, 40])
  const sq = filled(2, 2, (x, y) => 1 + x + 2 * y)
  assert.equal(at(sq, lin('clamp'), 0.5, 0.5)[0], 2.5)
  // Fractions 1/4 across and 3/4 down: 3/16 of 1, 1/16 of 2, 9/16 of 3, 3/16 of 4.
  assert.equal(at(sq, lin('clamp'), 0.375, 0.625)[0], 2.75)
  // Every channel blends, alpha too.
  const rgba = new ImageStore(desc({ width: 2, height: 1 }))
  rgba.write(0, 0, 1, 0, 0, [1, 1, 1, 1])
  assert.deepEqual(at(rgba, lin('clamp'), 0.5), [0.5, 0.5, 0.5, 0.5])
  assert.deepEqual(at(rgba, lin('clamp'), 0.25), [0, 0, 0, 0])
})

test('mip levels: nearest switches just past each half, linear blends neighbours, both held to the last level', () => {
  const s = filled(8, 8, (_x, _y, l) => 1 + 10 * l, { levels: 4 })
  const nearest = [[-1, 1], [0, 1], [0.5, 1], [0.5000001, 11], [1.5, 11], [1.5000001, 21], [2.4, 21], [3, 31], [10, 31]]
  for (const [lod, want] of nearest) assert.equal(at(s, sampler(), 0.5, 0.5, 0, lod)[0], want, `nearest mip at lod ${lod}`)
  const linear = [[0.25, 3.5], [1, 11], [1.5, 16], [2.75, 28.5], [3, 31], [3.5, 31], [100, 31]]
  for (const [lod, want] of linear) assert.equal(at(s, sampler({ mip: 'linear' }), 0.5, 0.5, 0, lod)[0], want, `linear mip at lod ${lod}`)
})

test('the level of detail is clamped to lodMin..lodMax (not a number reads as lodMin), and levels to the view', () => {
  const s = filled(8, 8, (_x, _y, l) => 1 + 10 * l, { levels: 4 })
  const held = sampler({ mip: 'linear', lodMin: 1, lodMax: 2 })
  for (const [lod, want] of [[0, 11], [1.5, 16], [5, 21], [NaN, 11], [-Infinity, 11], [Infinity, 21]]) assert.equal(at(s, held, 0.5, 0.5, 0, lod)[0], want, `lod ${lod}`)
  // A view of levels 1 and 2 counts its levels from 1 and stops at 2.
  const view = { levels: { base: 1, count: 2 }, layers: { base: 0, count: 1 } }
  for (const [lod, want] of [[0, 11], [-2, 11], [1, 21], [3, 21]]) assert.equal(at(s, sampler(), 0.5, 0.5, 0, lod, view)[0], want, `view lod ${lod}`)
  assert.equal(at(s, sampler({ mip: 'linear' }), 0.5, 0.5, 0, 0.5, view)[0], 16)
})

test('at a level of detail of 0 or less the mag filter reads the first level; above 0 the min filter reads', () => {
  const s = new ImageStore(desc({ format: 'r32f', width: 2, height: 1, levels: 2 }))
  s.write(0, 0, 1, 0, 0, [1])
  s.write(1, 0, 0, 0, 0, [0.5])
  const sm = sampler({ mag: 'linear', min: 'nearest' })
  assert.equal(at(s, sm, 0.5, 0.5, 0, -3)[0], 0.5, 'magnified: linear between 0 and 1')
  assert.equal(at(s, sm, 0.5, 0.5, 0, 0)[0], 0.5)
  assert.equal(at(s, sm, 0.5, 0.5, 0, 0.25)[0], 1, 'minified at level 0: nearest picks texel 1')
  assert.equal(at(s, sm, 0.5, 0.5, 0, 1)[0], 0.5, 'minified at level 1')
})

test('the layer rounds to the nearest (halves up) and is clamped into the view, never blended', () => {
  const s = filled(1, 1, (_x, _y, _l, k) => k, { layers: 4 })
  const view = { levels: { base: 0, count: 1 }, layers: { base: 1, count: 2 } }
  const cases = [[0, 1], [0.49, 1], [0.5, 2], [1, 2], [1.4, 2], [7, 2], [-3, 1], [-0.5, 1], [NaN, 1], [Infinity, 2]]
  for (const [layer, want] of cases) assert.equal(at(s, sampler({ mag: 'linear' }), 0.5, 0.5, layer, 0, view)[0], want, `layer ${layer}`)
})

test('sRGB images decode before filtering, so they blend in linear light; alpha stays linear', () => {
  const s = new ImageStore(desc({ format: 'rgba8-srgb', width: 2, height: 1 }))
  s.bytes.set([0, 0, 0, 0, 255, 255, 255, 255])
  assert.deepEqual(at(s, sampler({ mag: 'linear' }), 0.5), [0.5, 0.5, 0.5, 0.5])
  // Blending the codes first would give decode(1/2), about 0.214, instead.
  assert.ok(Math.abs(decodeSrgb(0.5) - 0.214) < 1e-3)
  s.bytes.set([188, 188, 188, 188], 0)
  const read: number[] = []
  s.read(0, 0, 0, 0, 0, read)
  assert.ok(Math.abs(read[0] - 0.50289) < 1e-5)
  assert.equal(read[3], fromUnorm(188, 8))
  assert.deepEqual(at(s, sampler(), 0.25), read)
  s.write(0, 0, 1, 0, 0, [0.5, 0.5, 0.5, 0.5])
  assert.deepEqual([...s.bytes.subarray(4)], [188, 188, 188, 128])
})

test('depth images filter their depth in channel 0, and the result rounds once to f32', () => {
  const d = new ImageStore(desc({ format: 'depth32f', width: 2, height: 1 }))
  d.write(0, 0, 0, 0, 0, [0.25])
  d.write(0, 0, 1, 0, 0, [0.75])
  assert.deepEqual(at(d, sampler({ mag: 'linear' }), 0.5), [0.5, 0, 0, 1])
  // Half of 1 and half of 1 + 2^-23 is 1 + 2^-24, which rounds to even: 1.
  const f = filled(2, 1, (x) => (x === 0 ? 1 : 1 + 2 ** -23))
  assert.equal(at(f, sampler({ mag: 'linear' }), 0.5)[0], 1)
})

test('a coordinate that is not a number reads as 0; an endless or vast one wraps as the largest f32 beyond 2^24 does', () => {
  const s = filled(4, 1, (x) => 10 * (x + 1))
  const sm = (mode: 'clamp' | 'repeat' | 'mirror'): SamplerState => sampler({ wrap: [mode, mode, mode] })
  assert.equal(at(s, sm('clamp'), NaN, NaN)[0], 10)
  assert.equal(at(s, sm('clamp'), Infinity)[0], 40)
  assert.equal(at(s, sm('clamp'), -Infinity)[0], 10)
  for (const u of [Infinity, -Infinity, 1e30, 2 ** 24 + 2, -(2 ** 24 + 4)]) {
    assert.equal(at(s, sm('repeat'), u)[0], 10, `repeat ${u}`)
    assert.equal(at(s, sm('mirror'), u)[0], 10, `mirror ${u}`)
    assert.equal(at(s, sampler({ mag: 'linear', wrap: ['repeat', 'repeat', 'repeat'] }), u)[0], 25, `linear repeat ${u}`)
  }
})

test('the level of detail from rates of change: log2 of the longer step in texels', () => {
  assert.equal(lodFromRates(1 / 64, 0, 0, 1 / 32, 64, 32), 0)
  assert.equal(lodFromRates(2 / 64, 0, 0, 1 / 32, 64, 32), 1)
  assert.equal(lodFromRates(0, 0, 0, 4 / 32, 64, 32), 2)
  assert.equal(lodFromRates(-2 / 64, 0, 0, -1 / 32, 64, 32), 1)
  assert.equal(lodFromRates(0.25 / 64, 0, 0, 0.25 / 32, 64, 32), -2)
  assert.ok(Math.abs(lodFromRates(1 / 64, 1 / 32, 0, 0, 64, 32) - 0.5) < 1e-15, 'a diagonal step of sqrt 2 texels')
  assert.equal(lodFromRates(0, 0, 0, 0, 64, 32), -Infinity)
  assert.equal(at(filled(2, 2, (_x, _y, l) => l, { levels: 2 }), sampler(), 0.5, 0.5, 0, lodFromRates(0, 0, 0, 0, 2, 2))[0], 0)
})

test('the texel load reads the texel, or zero in every channel anywhere outside the view', () => {
  const s = new ImageStore(desc({ width: 3, height: 2 }))
  for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) s.bytes.set([x * 10, y * 10, 7, 255], (y * 3 + x) * 4)
  assert.deepEqual(loaded(s, 2, 1), [fromUnorm(20, 8), fromUnorm(10, 8), fromUnorm(7, 8), 1])
  for (const [x, y, k, l] of [[3, 0, 0, 0], [-1, 0, 0, 0], [0, 2, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1], [1.5, 0, 0, 0], [NaN, 0, 0, 0], [0, 0, 0, -1], [0, 0, 0.5, 0]]) {
    assert.deepEqual(loaded(s, x, y, k, l), [0, 0, 0, 0], `(${x}, ${y}) layer ${k} level ${l}`)
  }
  // Integers load exactly; levels and layers count from the view's first.
  const u = new ImageStore(desc({ format: 'r32u', width: 4, height: 4, levels: 2, layers: 2 }))
  u.write(1, 1, 1, 1, 0, [4294967295, 0, 0, 0])
  const view = { levels: { base: 1, count: 1 }, layers: { base: 1, count: 1 } }
  assert.deepEqual(loaded(u, 1, 1, 0, 0, view), [4294967295, 0, 0, 1])
  assert.deepEqual(loaded(u, 2, 1, 0, 0, view), [0, 0, 0, 0], 'level 1 is 2 x 2')
  assert.deepEqual(loaded(u, 1, 1, 1, 0, view), [0, 0, 0, 0], 'the view has one layer')
  const d = new ImageStore(desc({ format: 'depth16', width: 1, height: 1 }))
  d.write(0, 0, 0, 0, 0, [0.5])
  assert.deepEqual(loaded(d, 0, 0), [fromUnorm(32768, 16), 0, 0, 1])
  assert.deepEqual(loaded(d, 1, 0), [0, 0, 0, 0])
})

test("the storage write lands on the view's first level and its layer, and anything outside is dropped", () => {
  const s = new ImageStore(desc({ format: 'r32f', width: 4, height: 4, levels: 2, layers: 2 }))
  const view = { levels: { base: 1, count: 1 }, layers: { base: 1, count: 1 } }
  put(s, view, 1, 1, 0, [7])
  for (const [x, y, k] of [[2, 0, 0], [0, 2, 0], [0, 0, 1], [-1, 0, 0], [0.5, 0, 0], [NaN, 0, 0]]) put(s, view, x, y, k, [9])
  const at11 = s.offset(1, 1, 1, 1)
  for (let i = 0; i < s.bytes.length; i += 4) {
    const v = new DataView(s.bytes.buffer, i, 4).getFloat32(0, true)
    assert.equal(v, i === at11 ? 7 : 0, `byte ${i}`)
  }
})

test('sampling, loading and storing check the image, the view and the sampler', () => {
  const s = new ImageStore(desc())
  const ok = whole(s)
  faults(() => at(new ImageStore(desc({ format: 'r32u' })), sampler(), 0.5))
  faults(() => at(new ImageStore(desc({ format: 'r32i' })), sampler(), 0.5))
  const views = [
    { levels: { base: 1, count: 1 }, layers: { base: 0, count: 1 } },
    { levels: { base: 0, count: 0 }, layers: { base: 0, count: 1 } },
    { levels: { base: 0, count: 1 }, layers: { base: 0, count: 2 } },
    { levels: { base: -1, count: 1 }, layers: { base: 0, count: 1 } },
    { levels: { base: 0.5, count: 1 }, layers: { base: 0, count: 1 } },
    { levels: null as unknown as ViewRange['levels'], layers: { base: 0, count: 1 } },
    null as unknown as ViewRange,
  ]
  for (const view of views) {
    faults(() => at(s, sampler(), 0.5, 0.5, 0, 0, view))
    faults(() => loaded(s, 0, 0, 0, 0, view))
    faults(() => put(s, view, 0, 0, 0, [0, 0, 0, 0]))
  }
  faults(() => sample({} as ImageStore, ok, sampler(), 0, 0, 0, 0, []))
  faults(() => load({} as ImageStore, ok, 0, 0, 0, 0, []))
  const samplers: Partial<SamplerState>[] = [
    { mag: 'cubic' as 'linear' }, { min: undefined }, { mip: 'none' as 'linear' }, { wrap: ['clamp', 'border' as 'clamp', 'clamp'] },
    { wrap: 'clamp' as unknown as SamplerState['wrap'] }, { lodMin: 3, lodMax: 2 }, { lodMin: NaN },
  ]
  for (const o of samplers) faults(() => at(s, sampler(o), 0.5))
  faults(() => sample(s, ok, null as unknown as SamplerState, 0, 0, 0, 0, []))
  // Every format a sampler may read samples without complaint.
  for (const [name, f] of Object.entries(FORMATS)) {
    if (f.kind === 'uint' || f.kind === 'sint') continue
    assert.equal(at(new ImageStore(desc({ format: name as ImageDesc['format'] })), sampler({ mag: 'linear' }), 0.3).length, 4, name)
  }
})
