// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the texel arithmetic of formats.ts that both back ends must agree on to the bit:
 * every half float round trip, rounding to nearest even at every half-way point between two halves, overflow and
 * underflow, unsigned normalised rounding checked against exact rational arithmetic at every rounding boundary, the
 * sRGB curve and its 8-bit round trip, the byte image every format encodes to and decodes from, and the format table.
 * What breaks if it is removed? A change to a rounding rule or a byte order would pass unnoticed, and the reference
 * renderer and a GPU would quietly store different bytes for the same colour.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FORMATS, FORMAT_NAMES, decodeSrgb, decodeTexel, encodeSrgb, encodeTexel, fromHalf, fromUnorm, isFormat, sampleKind, saturate, toHalf, toUnorm } from './formats.ts'
import type { Format } from './formats.ts'

const word = new DataView(new ArrayBuffer(8))
const bitsOf = (x: number): number => {
  word.setFloat32(0, x, true)
  return word.getUint32(0, true)
}
const fromBits = (b: number): number => {
  word.setUint32(0, b >>> 0, true)
  return word.getFloat32(0, true)
}
/** The next f32 above and below a positive f32. */
const up = (x: number): number => fromBits(bitsOf(x) + 1)
const down = (x: number): number => fromBits(bitsOf(x) - 1)
const isHalfNaN = (h: number): boolean => (h & 0x7c00) === 0x7c00 && (h & 0x3ff) !== 0

/** floor(x * max + 1/2) for a double x in [0, 1], computed exactly from x's bits with big integers. */
function exactUnorm(x: number, max: number): number {
  if (x === 0) return 0
  word.setFloat64(0, x)
  const bits = word.getBigUint64(0)
  const exp = Number((bits >> 52n) & 0x7ffn)
  const frac = bits & ((1n << 52n) - 1n)
  const m = exp === 0 ? frac : frac | (1n << 52n)
  const e = (exp === 0 ? 1 : exp) - 1075
  // x = m 2^e, so x max + 1/2 = (2 m max 2^e + 1) / 2.
  const num = 2n * m * BigInt(max)
  if (e >= 0) return Number(((num << BigInt(e)) + 1n) >> 1n)
  return Number((num + (1n << BigInt(-e))) >> BigInt(1 - e))
}

const encode = (format: Format, value: readonly number[]): number[] => {
  const out = new Uint8Array(FORMATS[format].bytes)
  encodeTexel(format, value, out, 0)
  return [...out]
}
const decode = (format: Format, bytes: readonly number[]): number[] => {
  const out: number[] = []
  decodeTexel(format, new Uint8Array(bytes), 0, out)
  return out
}

test('the table: every format is frozen, its bytes are channels times channel bytes, and only real names are formats', () => {
  assert.ok(Object.isFrozen(FORMATS) && Object.isFrozen(FORMAT_NAMES))
  assert.deepEqual([...FORMAT_NAMES], Object.keys(FORMATS))
  for (const name of FORMAT_NAMES) {
    const f = FORMATS[name]
    assert.ok(Object.isFrozen(f), name)
    assert.ok(isFormat(name), name)
    assert.equal(f.bytes, f.channels * f.channelBytes, name)
    assert.equal(f.depth, f.kind === 'depth', name)
    assert.equal(f.color, f.kind !== 'depth', name)
    if (f.blend || f.filter) assert.ok(f.kind === 'unorm' || f.kind === 'float', name)
    if (f.order === 'bgra' || f.srgb) assert.equal(f.channels, 4, name)
  }
  const many = FORMAT_NAMES.filter((n) => FORMATS[n].multisample)
  assert.deepEqual(many, ['r8', 'rg8', 'rgba8', 'rgba8-srgb', 'bgra8', 'bgra8-srgb', 'r16f', 'rg16f', 'rgba16f', 'depth16', 'depth32f'])
  for (const name of ['toString', 'constructor', '', 'RGBA8', 'rgba8 ', 'depth24']) assert.equal(isFormat(name), false, name)
  for (const v of [1, null, undefined, {}, ['rgba8']]) assert.equal(isFormat(v), false, String(v))
  assert.equal(sampleKind('rgba8'), 'float')
  assert.equal(sampleKind('rgba8-srgb'), 'float')
  assert.equal(sampleKind('rgba16f'), 'float')
  assert.equal(sampleKind('r32u'), 'uint')
  assert.equal(sampleKind('r32i'), 'sint')
  assert.equal(sampleKind('depth16'), 'depth')
  assert.equal(sampleKind('depth32f'), 'depth')
})

test('every one of the 65,536 half bit patterns that is not NaN survives fromHalf then toHalf exactly; NaNs stay NaN', () => {
  let nans = 0
  for (let h = 0; h < 0x10000; h++) {
    const v = fromHalf(h)
    if (isHalfNaN(h)) {
      nans++
      assert.ok(Number.isNaN(v), h.toString(16))
      continue
    }
    assert.equal(toHalf(v), h, `0x${h.toString(16)} -> ${v}`)
    assert.equal(Math.fround(v), v, 'every half is an f32')
  }
  assert.equal(nans, 2 * 1023)
  assert.ok(isHalfNaN(toHalf(NaN)))
  assert.equal(toHalf(NaN), 0x7e00)
  // Positive halves increase with their bits, so the order of the bits is the order of the numbers.
  for (let h = 0; h < 0x7c00; h++) assert.ok(fromHalf(h + 1) > fromHalf(h), h.toString(16))
})

test('fromHalf: zeros, subnormals, normals, the largest half and infinities', () => {
  assert.ok(Object.is(fromHalf(0x0000), 0))
  assert.ok(Object.is(fromHalf(0x8000), -0))
  assert.equal(fromHalf(0x0001), 2 ** -24)
  assert.equal(fromHalf(0x03ff), 1023 * 2 ** -24)
  assert.equal(fromHalf(0x0400), 2 ** -14)
  assert.equal(fromHalf(0x3c00), 1)
  assert.equal(fromHalf(0x3c01), 1 + 2 ** -10)
  assert.equal(fromHalf(0xc000), -2)
  assert.equal(fromHalf(0x3555), 0.333251953125)
  assert.equal(fromHalf(0x7bff), 65504)
  assert.equal(fromHalf(0x7c00), Infinity)
  assert.equal(fromHalf(0xfc00), -Infinity)
})

test('toHalf rounds every half-way point between two halves to the even one, and the f32 either side to the nearer', () => {
  for (let h = 0; h < 0x7c00; h++) {
    const lo = fromHalf(h)
    // Past the largest half, rounding goes on as if the exponent went on: the next step would be 65536.
    const hi = h + 1 === 0x7c00 ? 65536 : fromHalf(h + 1)
    const mid = (lo + hi) / 2
    assert.equal(Math.fround(mid), mid, 'the half-way point is itself an f32')
    const even = (h & 1) === 0 ? h : h + 1
    for (const sign of [0, 0x8000]) {
      const s = sign ? -1 : 1
      assert.equal(toHalf(s * mid), sign | even, `half-way above 0x${h.toString(16)}`)
      assert.equal(toHalf(s * up(mid)), sign | (h + 1), `just above half-way above 0x${h.toString(16)}`)
      assert.equal(toHalf(s * down(mid)), sign | h, `just below half-way above 0x${h.toString(16)}`)
    }
  }
})

test('toHalf: overflow becomes infinity, underflow keeps its sign, signed zeros stay signed', () => {
  assert.equal(toHalf(65504), 0x7bff)
  assert.equal(toHalf(65519), 0x7bff)
  assert.equal(toHalf(65520), 0x7c00, 'half-way past the largest half rounds to even, which is infinity')
  assert.equal(toHalf(down(65520)), 0x7bff)
  assert.equal(toHalf(1e10), 0x7c00)
  assert.equal(toHalf(-1e10), 0xfc00)
  assert.equal(toHalf(Infinity), 0x7c00)
  assert.equal(toHalf(-Infinity), 0xfc00)
  assert.equal(toHalf(2 ** -25), 0x0000, 'half the smallest subnormal ties to zero')
  assert.equal(toHalf(up(2 ** -25)), 0x0001)
  assert.equal(toHalf(1e-30), 0x0000)
  assert.equal(toHalf(-1e-30), 0x8000)
  assert.equal(toHalf(2 ** -149), 0x0000, 'the smallest f32 subnormal')
  assert.equal(toHalf(0), 0x0000)
  assert.equal(toHalf(-0), 0x8000)
  assert.equal(toHalf(down(2 ** -14)), 0x0400, 'just under the smallest normal rounds up into it')
})

test('toHalf takes an f32: a double that is not one is rounded to f32 first, which can move a near tie (see the report)', () => {
  // 1 + 2^-11 + 2^-40 is nearer 1 + 2^-10 (0x3c01) than 1, but its f32 is 1 + 2^-11, an exact tie that rounds to even.
  // Every value Nightglass encodes is already an f32 (shader results, and blend and resolve results rounded once), so
  // the stored bytes are right; this pins the behaviour so a change to it is a decision, not an accident.
  assert.equal(toHalf(1 + 2 ** -11 + 2 ** -40), 0x3c00)
  assert.equal(toHalf(Math.fround(1 + 2 ** -11 + 2 ** -40)), 0x3c00)
  assert.equal(toHalf(up(1 + 2 ** -11)), 0x3c01)
})

test('toUnorm rounds to nearest with ties away from zero, exactly at every 8-bit and 16-bit boundary for f32 inputs', () => {
  assert.equal(toUnorm(0.5, 8), 128, '127.5 is an exact tie')
  assert.equal(toUnorm(0.5, 16), 32768, '32767.5 is an exact tie')
  assert.equal(toUnorm(0.25, 8), 64)
  assert.equal(toUnorm(0.75, 8), 191)
  for (const [bits, max] of [[8, 255], [16, 65535]] as const) {
    for (let k = 0; k < max; k++) {
      // The f32 nearest the boundary (k + 1/2) / max, and the two f32 either side of it.
      const near = Math.fround((k + 0.5) / max)
      for (const x of [down(down(near)), down(near), near, up(near), up(up(near))]) {
        assert.equal(toUnorm(x, bits), exactUnorm(x, max), `${bits}-bit boundary ${k}: ${x}`)
      }
    }
  }
})

test('toUnorm saturates and fromUnorm is its exact inverse on every 8-bit and 16-bit code', () => {
  for (const bits of [8, 16] as const) {
    const max = bits === 8 ? 255 : 65535
    assert.equal(toUnorm(-1, bits), 0)
    assert.equal(toUnorm(2, bits), max)
    assert.equal(toUnorm(NaN, bits), 0)
    assert.equal(toUnorm(Infinity, bits), max)
    assert.equal(toUnorm(-Infinity, bits), 0)
    for (let k = 0; k <= max; k++) {
      const v = fromUnorm(k, bits)
      assert.equal(v, Math.fround(k / max))
      assert.equal(toUnorm(v, bits), k, `${bits}-bit code ${k}`)
    }
  }
})

test('saturate: clamps to [0, 1], NaN and minus zero become plus zero', () => {
  assert.ok(Object.is(saturate(NaN), 0))
  assert.ok(Object.is(saturate(-0), 0))
  assert.equal(saturate(-3), 0)
  assert.equal(saturate(0.25), 0.25)
  assert.equal(saturate(1), 1)
  assert.equal(saturate(7), 1)
  assert.equal(saturate(Infinity), 1)
})

test('the sRGB curve: both segments, its ends, its monotony, and the 8-bit round trip of every code', () => {
  assert.equal(encodeSrgb(0), 0)
  assert.equal(decodeSrgb(0), 0)
  assert.equal(decodeSrgb(1), 1)
  assert.ok(Math.abs(encodeSrgb(1) - 1) < 1e-15)
  assert.equal(encodeSrgb(0.001), 0.001 * 12.92, 'the linear segment')
  assert.equal(decodeSrgb(0.02), 0.02 / 12.92)
  assert.equal(encodeSrgb(-1), 0)
  assert.equal(encodeSrgb(2), encodeSrgb(1))
  // Linear mid-grey is sRGB code 188 (0.5 encodes to 187.516 / 255), and code 188 decodes to 0.50289 of linear light.
  assert.ok(Math.abs(decodeSrgb(188 / 255) - 0.50289) < 1e-5)
  assert.ok(Math.abs(encodeSrgb(0.5) * 255 - 187.516) < 1e-3)
  // The two segments meet: the curve is continuous within a part in ten million at the joins.
  assert.ok(Math.abs(encodeSrgb(0.0031308) - (1.055 * 0.0031308 ** (1 / 2.4) - 0.055)) < 1e-7)
  assert.ok(Math.abs(decodeSrgb(0.04045) - ((0.04045 + 0.055) / 1.055) ** 2.4) < 1e-7)
  let last = -1
  for (let k = 0; k <= 255; k++) {
    const lin = decodeSrgb(k / 255)
    assert.ok(lin > last, `decode rises at ${k}`)
    last = lin
    for (const format of ['rgba8-srgb', 'bgra8-srgb'] as const) {
      const value = decode(format, [k, k, k, k])
      assert.deepEqual(encode(format, value), [k, k, k, k], `${format} code ${k}`)
    }
  }
})

test('sRGB reads decode the colour channels and leave alpha linear', () => {
  const v = decode('rgba8-srgb', [188, 0, 255, 128])
  assert.deepEqual(v, [Math.fround(decodeSrgb(fromUnorm(188, 8))), 0, 1, fromUnorm(128, 8)])
  assert.ok(Math.abs(v[0] - 0.50289) < 1e-5)
  assert.deepEqual(encode('rgba8-srgb', [0.5, 0, 1, 0.5]), [188, 0, 255, 128])
  assert.deepEqual(encode('bgra8-srgb', [0.5, 0, 1, 0.5]), [255, 0, 188, 128])
  assert.deepEqual(decode('bgra8-srgb', [255, 0, 188, 128]), v)
})

test('every format encodes to its exact bytes and decodes back, missing channels reading 0 and a missing alpha 1', () => {
  const f32 = (x: number): number[] => {
    word.setFloat32(0, x, true)
    return [word.getUint8(0), word.getUint8(1), word.getUint8(2), word.getUint8(3)]
  }
  const cases: [Format, number[], number[], number[]][] = [
    ['r8', [0.5, 9, 9, 9], [128], [fromUnorm(128, 8), 0, 0, 1]],
    ['rg8', [1, 0.25, 9, 9], [255, 64], [1, fromUnorm(64, 8), 0, 1]],
    ['rgba8', [0, 0.25, 0.75, 1], [0, 64, 191, 255], [0, fromUnorm(64, 8), fromUnorm(191, 8), 1]],
    ['bgra8', [1, 0.5, 0, 0.25], [0, 128, 255, 64], [1, fromUnorm(128, 8), 0, fromUnorm(64, 8)]],
    ['r16f', [1.5, 9, 9, 9], [0x00, 0x3e], [1.5, 0, 0, 1]],
    ['rg16f', [-2, 65504, 9, 9], [0x00, 0xc0, 0xff, 0x7b], [-2, 65504, 0, 1]],
    ['rgba16f', [0.5, 1, 2, 2 ** -24], [0x00, 0x38, 0x00, 0x3c, 0x00, 0x40, 0x01, 0x00], [0.5, 1, 2, 2 ** -24]],
    ['r32f', [0.1, 9, 9, 9], f32(0.1), [Math.fround(0.1), 0, 0, 1]],
    ['rg32f', [-1.5, 3e38, 9, 9], [...f32(-1.5), ...f32(3e38)], [-1.5, Math.fround(3e38), 0, 1]],
    ['rgba32f', [1, -0, 0.25, 1e-40], [...f32(1), ...f32(-0), ...f32(0.25), ...f32(1e-40)], [1, -0, 0.25, Math.fround(1e-40)]],
    ['r32u', [4294967295, 9, 9, 9], [0xff, 0xff, 0xff, 0xff], [4294967295, 0, 0, 1]],
    ['r32u', [-1, 9, 9, 9], [0xff, 0xff, 0xff, 0xff], [4294967295, 0, 0, 1]],
    ['r32u', [258, 9, 9, 9], [0x02, 0x01, 0x00, 0x00], [258, 0, 0, 1]],
    ['r32i', [-2, 9, 9, 9], [0xfe, 0xff, 0xff, 0xff], [-2, 0, 0, 1]],
    ['r32i', [2147483648, 9, 9, 9], [0x00, 0x00, 0x00, 0x80], [-2147483648, 0, 0, 1]],
    ['depth16', [0.5, 9, 9, 9], [0x00, 0x80], [fromUnorm(32768, 16), 0, 0, 1]],
    ['depth16', [1.5, 9, 9, 9], [0xff, 0xff], [1, 0, 0, 1]],
    ['depth32f', [0.25, 9, 9, 9], f32(0.25), [0.25, 0, 0, 1]],
    ['depth32f', [1.5, 9, 9, 9], f32(1), [1, 0, 0, 1]],
    ['depth32f', [-1, 9, 9, 9], f32(0), [0, 0, 0, 1]],
  ]
  const covered = new Set<Format>()
  for (const [format, value, bytes, back] of cases) {
    covered.add(format)
    assert.deepEqual(encode(format, value), bytes, `${format} encodes ${value}`)
    const got = decode(format, bytes)
    assert.equal(got.length, 4)
    for (let c = 0; c < 4; c++) assert.ok(Object.is(got[c], back[c]), `${format} channel ${c}: ${got[c]} is not ${back[c]}`)
  }
  for (const name of FORMAT_NAMES) if (name !== 'rgba8-srgb' && name !== 'bgra8-srgb') assert.ok(covered.has(name), `${name} has a case`)
})

test('encode and decode touch only the texel at the offset, inside a slice of a larger buffer', () => {
  const backing = new Uint8Array(32).fill(0xaa)
  const part = backing.subarray(8, 24)
  encodeTexel('rgba16f', [1, 2, 3, 4], part, 4)
  assert.deepEqual([...backing.subarray(0, 12)], new Array(12).fill(0xaa))
  assert.deepEqual([...backing.subarray(20)], new Array(12).fill(0xaa))
  assert.deepEqual([...backing.subarray(12, 20)], [0x00, 0x3c, 0x00, 0x40, 0x00, 0x42, 0x00, 0x44])
  const out: number[] = []
  decodeTexel('rgba16f', part, 4, out)
  assert.deepEqual(out, [1, 2, 3, 4])
  // A one-channel format ignores the channels it lacks and writes only its own bytes.
  encodeTexel('r8', [1, 0, 0, 0], part, 0)
  assert.deepEqual([...backing.subarray(8, 12)], [0xff, 0xaa, 0xaa, 0xaa])
})
