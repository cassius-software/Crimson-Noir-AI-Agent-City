// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the reference renderer's output merger with values worked by hand: every depth
 * comparison, the depth a depth format really holds, every blend factor and operation of WebGPU, the clamping into a
 * unorm attachment, the write mask (and that a masked channel is stored back bit for bit), integer attachments, the
 * four-sample resolve in linear light, and the refusals.
 * What breaks if it is removed? A factor or an operation could change, a clamp could be lost, or a resolve could
 * average sRGB codes, and the reference renderer's transparent and antialiased pictures would drift from a GPU's.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BlendFactor, BlendOp, Compare } from './api.ts'
import { blend, depthOf, passes, resolveInto } from './blend.ts'
import type { BlendState } from './blend.ts'
import { isFault } from './fault.ts'
import type { FaultCode } from './fault.ts'
import { FORMATS, FORMAT_NAMES, decodeTexel, encodeTexel, fromUnorm } from './formats.ts'
import type { Format } from './formats.ts'
import { ImageStore } from './texture.ts'

/** A seeded linear congruential generator in [0, 1): the same numbers on every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const faults = (fn: () => unknown, code: FaultCode = 'invalid'): void => {
  assert.throws(fn, (e: unknown) => isFault(e, code))
}

/** The colour `blend` stores. */
function mixed(format: Format, state: BlendState | null, src: readonly number[], dst: readonly number[], constant: readonly number[] = [0, 0, 0, 0], mask = 15): number[] {
  const out: number[] = []
  blend(format, state, mask, src, dst, constant, out)
  return out
}

const part = (src: BlendFactor, dst: BlendFactor, op?: BlendOp): BlendState['color'] => (op === undefined ? { src, dst } : { src, dst, op })
const both = (p: BlendState['color']): BlendState => ({ color: p, alpha: p })

test('the depth test compares the fragment (left) with the stored depth (right)', () => {
  // Fragment below, equal to, and above the stored depth.
  const table: Record<Compare, [boolean, boolean, boolean]> = {
    never: [false, false, false],
    less: [true, false, false],
    equal: [false, true, false],
    'less-equal': [true, true, false],
    greater: [false, false, true],
    'not-equal': [true, false, true],
    'greater-equal': [false, true, true],
    always: [true, true, true],
  }
  for (const [compare, want] of Object.entries(table) as [Compare, [boolean, boolean, boolean]][]) {
    assert.deepEqual([passes(compare, 0.25, 0.5), passes(compare, 0.5, 0.5), passes(compare, 0.75, 0.5)], want, compare)
  }
  faults(() => passes('lequal' as Compare, 0, 0))
})

test('the depth a depth format holds is what writing and reading it gives, so a surface meets itself with equal', () => {
  const rand = lcg(5)
  for (const format of ['depth16', 'depth32f'] as const) {
    const bytes = new Uint8Array(4)
    const out: number[] = []
    for (let i = 0; i < 2000; i++) {
      const d = rand() * 2 - 0.5
      encodeTexel(format, [d, 0, 0, 0], bytes, 0)
      decodeTexel(format, bytes, 0, out)
      assert.equal(depthOf(format, d), out[0], `${format} ${d}`)
      // Drawn again, the same depth passes `equal` against what the first draw stored.
      assert.ok(passes('equal', depthOf(format, d), out[0]))
    }
  }
  assert.equal(depthOf('depth16', 0.5), fromUnorm(32768, 16))
  assert.equal(depthOf('depth32f', 0.1), Math.fround(0.1))
  assert.deepEqual([1.5, -1, NaN].map((d) => depthOf('depth32f', d)), [1, 0, 0])
  assert.deepEqual([1.5, -1, NaN].map((d) => depthOf('depth16', d)), [1, 0, 0])
  // A depth one part in a billion past a stored 1/3 rounds to the same f32: not nearer, not farther.
  assert.equal(passes('less', depthOf('depth32f', 1 / 3 - 1e-9), Math.fround(1 / 3)), false)
  faults(() => depthOf('rgba8', 0.5))
  faults(() => depthOf('r32f', 0.5))
})

test('every blend factor, as the source factor and as the destination factor, worked by hand', () => {
  const src = [0.5, 0.25, 0.75, 0.5]
  const dst = [0.25, 0.5, 0.125, 0.75]
  const k = [0.125, 0.375, 0.625, 0.25]
  const factors: Record<BlendFactor, number[]> = {
    zero: [0, 0, 0, 0],
    one: [1, 1, 1, 1],
    src: [0.5, 0.25, 0.75, 0.5],
    'one-minus-src': [0.5, 0.75, 0.25, 0.5],
    'src-alpha': [0.5, 0.5, 0.5, 0.5],
    'one-minus-src-alpha': [0.5, 0.5, 0.5, 0.5],
    dst: [0.25, 0.5, 0.125, 0.75],
    'one-minus-dst': [0.75, 0.5, 0.875, 0.25],
    'dst-alpha': [0.75, 0.75, 0.75, 0.75],
    'one-minus-dst-alpha': [0.25, 0.25, 0.25, 0.25],
    // min(src alpha, 1 - dst alpha) = min(1/2, 1/4) for colour, and 1 for alpha.
    'src-alpha-saturated': [0.25, 0.25, 0.25, 1],
    constant: [0.125, 0.375, 0.625, 0.25],
    'one-minus-constant': [0.875, 0.625, 0.375, 0.75],
  }
  for (const [f, w] of Object.entries(factors) as [BlendFactor, number[]][]) {
    assert.deepEqual(mixed('rgba16f', both(part(f, 'zero')), src, dst, k), src.map((s, c) => s * w[c]), `source factor ${f}`)
    assert.deepEqual(mixed('rgba16f', both(part('zero', f)), src, dst, k), dst.map((d, c) => d * w[c]), `destination factor ${f}`)
  }
})

test('every blend operation; min and max ignore the factors; colour and alpha each follow their own part', () => {
  const src = [0.5, 0.25, 0.75, 0.5]
  const dst = [0.25, 0.5, 0.125, 0.75]
  const ops: Record<BlendOp, number[]> = {
    add: [0.75, 0.75, 0.875, 1.25],
    subtract: [0.25, -0.25, 0.625, -0.25],
    'reverse-subtract': [-0.25, 0.25, -0.625, 0.25],
    min: [0.25, 0.25, 0.125, 0.5],
    max: [0.5, 0.5, 0.75, 0.75],
  }
  for (const [op, want] of Object.entries(ops) as [BlendOp, number[]][]) assert.deepEqual(mixed('rgba16f', both(part('one', 'one', op)), src, dst), want, op)
  assert.deepEqual(mixed('rgba16f', both(part('zero', 'src-alpha', 'min')), src, dst), ops.min)
  assert.deepEqual(mixed('rgba16f', both(part('constant', 'zero', 'max')), src, dst), ops.max)
  assert.deepEqual(mixed('rgba16f', both({ src: 'one', dst: 'one' }), src, dst), ops.add, 'the operation defaults to add')
  assert.deepEqual(mixed('rgba16f', { color: part('one', 'one', 'subtract'), alpha: part('one', 'zero') }, src, dst), [0.25, -0.25, 0.625, 0.5])
})

test('the usual alpha blend over an 8-bit attachment', () => {
  const over: BlendState = { color: part('src-alpha', 'one-minus-src-alpha'), alpha: part('one', 'one-minus-src-alpha') }
  assert.deepEqual(mixed('rgba8', over, [1, 0, 0, 0.5], [0, 0, 1, 1]), [0.5, 0, 0.5, 1])
  assert.deepEqual(mixed('bgra8-srgb', over, [1, 0, 0, 0.25], [0, 1, 0, 0.5]), [0.25, 0.75, 0, 0.625])
})

test('into a unorm attachment the source, the constant and the result are clamped to [0, 1]; into a float one nothing is', () => {
  const src = [2, -1, 0.5, 1.5]
  const k = [3, -2, 0.5, 2]
  for (const format of ['rgba8', 'rgba8-srgb', 'bgra8'] as const) {
    assert.deepEqual(mixed(format, null, src, [0, 0, 0, 0]), [1, 0, 0.5, 1], `${format} unblended`)
    assert.deepEqual(mixed(format, both(part('constant', 'zero')), src, [0, 0, 0, 0], k), [1, 0, 0.25, 1], `${format} constant`)
    assert.deepEqual(mixed(format, both(part('one', 'one')), [0.75, 0.75, 0.75, 0.75], [0.75, 0.25, 0, 0.5]), [1, 1, 0.75, 1], `${format} result`)
    // A subtraction shows the clamp comes before blending, not only after: 1 - 1/2, not 2 - 1/2 held to 1.
    assert.deepEqual(mixed(format, both(part('one', 'one', 'subtract')), src, [0.5, 0.5, 0.5, 0.5]), [0.5, 0, 0, 0.5], `${format} source clamped first`)
    assert.deepEqual(mixed(format, both(part('constant', 'one', 'reverse-subtract')), [0.25, 0.25, 0.25, 0.25], [0.5, 0.5, 0.5, 0.5], k), [0.25, 0.5, 0.375, 0.25], `${format} constant clamped first`)
  }
  assert.deepEqual(mixed('rgba16f', both(part('one', 'one', 'subtract')), src, [0.5, 0.5, 0.5, 0.5]), [1.5, -1.5, 0, 1])
  assert.deepEqual(mixed('rgba16f', both(part('constant', 'one', 'reverse-subtract')), [0.25, 0.25, 0.25, 0.25], [0.5, 0.5, 0.5, 0.5], k), [-0.25, 1, 0.375, 0])
  assert.deepEqual(mixed('rgba16f', null, src, [0, 0, 0, 0]), src)
  assert.deepEqual(mixed('rgba16f', both(part('constant', 'zero')), src, [0, 0, 0, 0], k), [6, 2, 0.25, 3])
  assert.deepEqual(mixed('rg16f', both(part('one', 'one')), [0.75, 0.75, 0.75, 0.75], [0.75, 0.25, 0, 0.5]), [1.5, 1, 0.75, 1.25])
})

test('the stored colour rounds once to f32; an integer attachment passes its values whole', () => {
  // 1/3 of 1/3 is not an f32; the stored value is its f32.
  assert.deepEqual(mixed('rgba16f', both(part('src', 'zero')), [1 / 3, 0, 0, 0], [0, 0, 0, 0]), [Math.fround(1 / 9), 0, 0, 0])
  assert.deepEqual(mixed('r32u', null, [4294967295, 1, 2, 3], [0, 0, 0, 0]), [4294967295, 1, 2, 3])
  assert.deepEqual(mixed('r32i', null, [-2147483648, 0, 0, 0], [0, 0, 0, 0]), [-2147483648, 0, 0, 0])
  assert.deepEqual(mixed('r32f', null, [3e38, -1, 0.1, 0], [0, 0, 0, 0]), [Math.fround(3e38), -1, Math.fround(0.1), 0])
})

test('the write mask keeps the stored value in every channel it leaves out, blended or not', () => {
  const src = [0.5, 0.25, 0.75, 0.5]
  const dst = [0.25, 0.5, 0.125, 0.75]
  assert.deepEqual(mixed('rgba16f', null, src, dst, [0, 0, 0, 0], 0b0101), [0.5, 0.5, 0.75, 0.75])
  assert.deepEqual(mixed('rgba16f', null, src, dst, [0, 0, 0, 0], 0b1010), [0.25, 0.25, 0.125, 0.5])
  assert.deepEqual(mixed('rgba16f', null, src, dst, [0, 0, 0, 0], 0), dst)
  assert.deepEqual(mixed('rgba16f', both(part('one', 'one')), src, dst, [0, 0, 0, 0], 0b1000), [0.25, 0.5, 0.125, 1.25])
  assert.deepEqual(mixed('r32u', null, [7, 7, 7, 7], [4294967295, 0, 0, 1], [0, 0, 0, 0], 0), [4294967295, 0, 0, 1])
})

test('a channel the mask leaves out is stored back to the very bytes it came from, in every colour format', () => {
  const rand = lcg(9)
  const out: number[] = []
  const value: number[] = []
  for (const format of FORMAT_NAMES) {
    const f = FORMATS[format]
    if (!f.color) continue
    const bytes = new Uint8Array(f.bytes)
    const again = new Uint8Array(f.bytes)
    for (let i = 0; i < 3000; i++) {
      // Every 8-bit code in turn for 8-bit formats, random bytes for the rest (skipping NaNs, whose payload is not kept).
      for (let b = 0; b < f.bytes; b++) bytes[b] = f.channelBytes === 1 ? (i + b * 37) & 0xff : Math.floor(rand() * 256)
      decodeTexel(format, bytes, 0, value)
      if (value.some(Number.isNaN)) continue
      blend(format, null, 0, [9, 9, 9, 9], value, [0, 0, 0, 0], out)
      encodeTexel(format, out, again, 0)
      assert.deepEqual([...again], [...bytes], `${format} ${[...bytes]}`)
    }
  }
})

test('blending checks its format, its state and its mask', () => {
  const s = [0, 0, 0, 0]
  const add = both(part('one', 'one'))
  faults(() => mixed('r32f', add, s, s))
  faults(() => mixed('rgba32f', add, s, s))
  faults(() => mixed('r32u', add, s, s))
  assert.deepEqual(mixed('r32f', null, [1, 0, 0, 0], s), [1, 0, 0, 0], 'an unblendable format still stores')
  faults(() => mixed('depth32f', null, s, s))
  faults(() => mixed('rgb8' as Format, null, s, s))
  for (const mask of [16, -1, 1.5, NaN]) faults(() => mixed('rgba8', null, s, s, s, mask))
  faults(() => mixed('rgba8', both(part('src-colour' as BlendFactor, 'one')), s, s))
  faults(() => mixed('rgba8', both(part('one', 'one', 'multiply' as BlendOp)), s, s))
})

test('a four-sample image resolves to the average of its samples, in linear light for sRGB', () => {
  const src = new ImageStore({ format: 'rgba8', width: 2, height: 2, layers: 1, levels: 1, samples: 4 })
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      const reds = [0, 255, 0, 255]
      const greens = [10, 20, 30, 40]
      const blues = [255, 255, 255, 0]
      for (let q = 0; q < 4; q++) src.bytes.set([reds[q], greens[q] + x + 2 * y, blues[q], 255], src.offset(0, 0, x, y, q))
    }
  }
  // Into level 1, layer 1 of a larger image: the rest of it is left alone.
  const dst = new ImageStore({ format: 'rgba8', width: 4, height: 4, layers: 2, levels: 2, samples: 1 })
  resolveInto(src, dst, 1, 1)
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) assert.deepEqual([...dst.bytes.subarray(dst.offset(1, 1, x, y), dst.offset(1, 1, x, y) + 4)], [128, 25 + x + 2 * y, 191, 255])
  const written = new Set([0, 1, 2, 3].map((i) => dst.offset(1, 1, i & 1, i >> 1)))
  for (let i = 0; i < dst.bytes.length; i += 4) if (!written.has(i)) assert.deepEqual([...dst.bytes.subarray(i, i + 4)], [0, 0, 0, 0])
  // sRGB codes 0 and 255 average to linear 1/2, code 188, not to code 128.
  const s8 = new ImageStore({ format: 'rgba8-srgb', width: 1, height: 1, layers: 1, levels: 1, samples: 4 })
  for (let q = 0; q < 4; q++) s8.bytes.set(q % 2 === 0 ? [0, 0, 0, 0] : [255, 255, 255, 255], q * 4)
  const d8 = new ImageStore({ format: 'rgba8-srgb', width: 1, height: 1, layers: 1, levels: 1, samples: 1 })
  resolveInto(s8, d8, 0, 0)
  assert.deepEqual([...d8.bytes], [188, 188, 188, 128])
  const h = new ImageStore({ format: 'rgba16f', width: 1, height: 1, layers: 1, levels: 1, samples: 4 })
  for (let q = 0; q < 4; q++) h.write(0, 0, 0, 0, q, [q + 1, -q, 0.5, 1])
  const hd = new ImageStore({ format: 'rgba16f', width: 1, height: 1, layers: 1, levels: 1, samples: 1 })
  resolveInto(h, hd, 0, 0)
  const out: number[] = []
  hd.read(0, 0, 0, 0, 0, out)
  assert.deepEqual(out, [2.5, -1.5, 0.5, 1])
})

test('a resolve checks both images, the level and the layer', () => {
  const four = (o: Partial<ConstructorParameters<typeof ImageStore>[0]> = {}): ImageStore => new ImageStore({ format: 'rgba8', width: 2, height: 2, layers: 1, levels: 1, samples: 4, ...o })
  const one = (o: Partial<ConstructorParameters<typeof ImageStore>[0]> = {}): ImageStore => new ImageStore({ format: 'rgba8', width: 2, height: 2, layers: 1, levels: 1, samples: 1, ...o })
  faults(() => resolveInto(one(), one(), 0, 0))
  faults(() => resolveInto(four(), four(), 0, 0))
  faults(() => resolveInto(four({ layers: 2 }), one(), 0, 0))
  faults(() => resolveInto(four(), one({ format: 'bgra8' }), 0, 0), 'mismatch')
  faults(() => resolveInto(four(), one({ width: 4, height: 4 }), 0, 0), 'mismatch')
  faults(() => resolveInto(four({ format: 'r32u' }), one({ format: 'r32u' }), 0, 0))
  faults(() => resolveInto(four(), one(), 1, 0))
  faults(() => resolveInto(four(), one(), 0, 1))
  faults(() => resolveInto(four(), one(), 0.5, 0))
  faults(() => resolveInto({} as ImageStore, one(), 0, 0))
  resolveInto(four({ format: 'r16f' }), one({ format: 'r16f', width: 4, height: 4, levels: 2 }), 1, 0)
})
