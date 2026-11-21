// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the Lens interpreter, the reference renderer's shader core, to the semantics the
 * GPU back end is held to: every unary, binary and ternary function on every type it takes, with the edge values
 * where implementations differ (integer wrap, division by zero, the most negative i32 over -1, shifts by 32 and more,
 * rounding halves to even, f32 rounding after each step, casts at their limits, NaN in min, max, clamp and step);
 * vectors and grids column by column; control flow under divergent masks (if and else splitting lanes, nested loops
 * with break and continue, return in a branch, the loop iteration bound, variables declared in a loop); discard and
 * helper lanes; fine derivatives across a quad; block reads and writes at layoutBlock's exact offsets with clamped
 * and runtime-sized arrays; sampling, texel loads, storage-image writes and extents through texture.ts; the step
 * budget; and the refusal of every malformed batch, binding and resource.
 * What breaks if it is removed? The reference renderer's arithmetic could drift from the specification unseen, and
 * every picture the GPU back end is compared against would carry the drift with it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { arrayOf, block, lens } from './builder.ts'
import type { BlockRes, LensBuilder, Val } from './builder.ts'
import { isFault } from './fault.ts'
import type { FaultCode } from './fault.ts'
import { BINARY, TERNARY, UNARY, columnOf, isGrid, layoutBlock, scalarOf, strideOf, vectorOf, widthOf } from './lens.ts'
import type { BinaryFn, Block, LensModule, TernaryFn, UnaryFn, ValueType } from './lens.ts'
import { DEFAULT_BUDGET, LANES, LOOP_ITERATIONS, compile, dispatch } from './interp.ts'
import type { BlockBinding, Bindings, ImageBinding, Program, Resources, RunResult } from './interp.ts'
import { ImageStore, lodFromRates, sample } from './texture.ts'
import type { SamplerState, ViewRange } from './texture.ts'

const F = Math.fround
const I32_MIN = -0x80000000
const I32_MAX = 0x7fffffff
const U32_MAX = 0xffffffff
const BUDGET = 1e7

const NONE: Resources = { block: () => null, image: () => null, sampler: () => null, storageImage: () => null }

/** Resources by index in the module's list, as the builder numbers them in the order they were declared. */
function bound(entries: { readonly [res: number]: BlockBinding | ImageBinding | SamplerState }): Resources {
  return {
    block: (r) => (entries[r] as BlockBinding | undefined) ?? null,
    image: (r) => (entries[r] as ImageBinding | undefined) ?? null,
    sampler: (r) => (entries[r] as SamplerState | undefined) ?? null,
    storageImage: (r) => (entries[r] as ImageBinding | undefined) ?? null,
  }
}

const whole = (bytes: Uint8Array): BlockBinding => ({ bytes, offset: 0, size: bytes.length })
const view = (s: ImageStore): ViewRange => ({ levels: { base: 0, count: s.levels }, layers: { base: 0, count: s.layers } })
const f32s = (bytes: Uint8Array, n: number, at = 0): number[] => Array.from({ length: n }, (_, i) => new DataView(bytes.buffer, bytes.byteOffset).getFloat32(at + i * 4, true))
const u32s = (bytes: Uint8Array, n: number, at = 0): number[] => Array.from({ length: n }, (_, i) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at + i * 4, true))

function faults(f: () => unknown, code: FaultCode, re?: RegExp): void {
  assert.throws(f, (e: unknown) => {
    assert.ok(isFault(e, code), `expected a ${code} Fault, got ${String(e)}`)
    if (re !== undefined) assert.match(e.message, re)
    return true
  })
}

/** A seeded linear congruential generator: the same numbers on every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s
  }
}

// ---------------------------------------------------------------------------------------------------
// Harnesses

type Arg = number | readonly number[]

/**
 * Runs f in a vertex shader over cases, up to four lanes at a time. Each type is fed through ports: a number type as
 * it is, a bool type as a u32 port compared with 0, a grid as its columns. A case lists one argument per type (a grid
 * column-major). The result comes back as numbers: a bool as 0 or 1, a grid column-major.
 */
function calc(types: readonly ValueType[], cases: readonly (readonly Arg[])[], f: (b: LensBuilder, ...xs: Val[]) => Val): number[][] {
  const b = lens('vertex')
  let slot = 0
  const xs = types.map((t) => {
    if (isGrid(t)) return b.make(t, ...Array.from({ length: widthOf(t) }, () => b.input(slot++, columnOf(t))))
    if (scalarOf(t) === 'bool') return b.ne(b.input(slot++, vectorOf('u32', widthOf(t))), 0)
    return b.input(slot++, t)
  })
  const r = f(b, ...xs)
  const parts = isGrid(r.t) ? Array.from({ length: widthOf(r.t) }, (_, j) => b.column(r, j)) : [scalarOf(r.t) === 'bool' ? b.cast(r, 'u32') : r]
  parts.forEach((v, j) => b.out(b.output(j, v.t), v))
  const p = compile(b.finish())
  const bindings = p.bind(NONE)
  const got: number[][] = []
  for (let first = 0; first < cases.length; first += LANES) {
    const chunk = cases.slice(first, first + LANES)
    const inputs = chunk.flatMap((args) => args.flatMap((a) => (typeof a === 'number' ? [a] : [...a])))
    assert.equal(inputs.length, chunk.length * p.inputWidth)
    const res = p.run({ lanes: chunk.length, inputs }, bindings, BUDGET)
    chunk.forEach((_, l) => got.push(Array.from(res.outputs.subarray(l * p.outputWidth, (l + 1) * p.outputWidth))))
  }
  return got
}

const flat = (a: Arg): number[] => (typeof a === 'number' ? [a] : [...a])

/**
 * Builds a compute module with `build`, binds `entries` and dispatches it, returning the steps taken. The builder
 * numbers resources in declaration order, so `entries` is keyed the same way.
 */
function compute(group: readonly [number, number, number], build: (b: LensBuilder, i: Val) => void, entries: { readonly [res: number]: BlockBinding | ImageBinding | SamplerState }, groups: readonly [number, number, number] = [1, 1, 1], budget = BUDGET): number {
  const b = lens('compute', { group })
  build(b, b.pick(b.builtin('global-id'), 'x'))
  const p = compile(b.finish())
  return dispatch(p, p.bind(bound(entries)), groups, budget)
}

/** Runs `count` invocations that each write u32 results into a buffer of `words`; returns the buffer's words. */
function computeU32(count: number, words: number, build: (b: LensBuilder, i: Val, out: BlockRes) => void): number[] {
  const bytes = new Uint8Array(words * 4)
  compute([count, 1, 1], (b, i) => build(b, i, b.storage(0, 0, { items: arrayOf('u32') }, { writable: true })), { 0: whole(bytes) })
  return u32s(bytes, words)
}

/** Writes each component of v (a scalar, a vector, or a grid column by column) to items[at], items[at + 1], ... */
function emit(b: LensBuilder, out: BlockRes, at: number, v: Val): number {
  const columns = isGrid(v.t) ? Array.from({ length: widthOf(v.t) }, (_, j) => b.column(v, j)) : [v]
  let k = at
  for (const c of columns) {
    const n = widthOf(c.t)
    for (let i = 0; i < n; i++) b.write(out, ['items', k++], n === 1 ? c : b.pick(c, [i]))
  }
  return k
}

/** Runs a fragment program on the quad whose top-left pixel is (x, y). */
function quad(p: Program, bindings: Bindings, x: number, y: number, helpers = 0, budget = BUDGET): RunResult {
  const coord = new Float64Array(16)
  for (let l = 0; l < 4; l++) coord.set([x + (l & 1) + 0.5, y + (l >> 1) + 0.5, 0.5, 1], l * 4)
  return p.run({ lanes: 4, helpers, builtins: { 'frag-coord': coord, 'front-facing': [1, 1, 1, 1] } }, bindings, budget)
}

// ---------------------------------------------------------------------------------------------------
// Arithmetic

const UNARY_ROWS: readonly (readonly [UnaryFn, ValueType, Arg, Arg])[] = [
  ['neg', 'f32', 1.5, -1.5], ['neg', 'f32', 0, -0], ['neg', 'i32', I32_MIN, I32_MIN], ['neg', 'i32', 5, -5], ['neg', 'f32x3', [1, -2, 0.5], [-1, 2, -0.5]], ['neg', 'i32x2', [7, -7], [-7, 7]],
  ['not', 'bool', 1, 0], ['not', 'bool', 0, 1], ['not', 'boolx2', [1, 0], [0, 1]],
  ['bitnot', 'i32', 0, -1], ['bitnot', 'i32', I32_MIN, I32_MAX], ['bitnot', 'u32', 0, U32_MAX], ['bitnot', 'u32x2', [0x0f0f0f0f, U32_MAX], [0xf0f0f0f0, 0]],
  ['abs', 'f32', -2.5, 2.5], ['abs', 'f32', -0, 0], ['abs', 'i32', I32_MIN, I32_MIN], ['abs', 'i32', -7, 7], ['abs', 'u32', U32_MAX, U32_MAX], ['abs', 'f32x2', [-1, 1], [1, 1]],
  ['sign', 'f32', -3, -1], ['sign', 'f32', 0, 0], ['sign', 'f32', -0, 0], ['sign', 'f32', 2, 1], ['sign', 'f32', NaN, 0], ['sign', 'i32', -5, -1], ['sign', 'i32', 0, 0], ['sign', 'i32x2', [9, I32_MIN], [1, -1]],
  ['floor', 'f32', -1.5, -2], ['floor', 'f32', 2.75, 2], ['floor', 'f32', -0, -0], ['floor', 'f32x2', [0.5, -0.5], [0, -1]],
  ['ceil', 'f32', -1.5, -1], ['ceil', 'f32', -0.5, -0], ['ceil', 'f32', 2.25, 3],
  ['round', 'f32', 2.5, 2], ['round', 'f32', -2.5, -2], ['round', 'f32', 3.5, 4], ['round', 'f32', -3.5, -4], ['round', 'f32', 0.5, 0], ['round', 'f32', -0.5, -0],
  ['round', 'f32', 1.5, 2], ['round', 'f32', -1.5, -2], ['round', 'f32', F(2.4999998), 2], ['round', 'f32', 8388609, 8388609], ['round', 'f32', -0.25, -0], ['round', 'f32', 0.75, 1],
  ['trunc', 'f32', -1.75, -1], ['trunc', 'f32', 1.75, 1], ['trunc', 'f32', -0.5, -0],
  ['fract', 'f32', 1.25, 0.25], ['fract', 'f32', -1.25, 0.75], ['fract', 'f32', 3, 0], ['fract', 'f32', -(2 ** -30), 1],
  ['sqrt', 'f32', 2, F(Math.SQRT2)], ['sqrt', 'f32', 16, 4], ['sqrt', 'f32', -1, NaN],
  ['rsqrt', 'f32', 4, 0.5], ['rsqrt', 'f32', 0, Infinity], ['rsqrt', 'f32', 2, F(Math.SQRT1_2)],
  ['exp', 'f32', 0, 1], ['exp', 'f32', 1, F(Math.E)], ['exp', 'f32', 100, Infinity],
  ['exp2', 'f32', 10, 1024], ['exp2', 'f32', -1, 0.5], ['exp2', 'f32', 128, Infinity], ['exp2', 'f32', 0.5, F(Math.SQRT2)],
  ['log', 'f32', 1, 0], ['log', 'f32', 0, -Infinity], ['log', 'f32', 10, F(Math.LN10)],
  ['log2', 'f32', 8, 3], ['log2', 'f32', -1, NaN], ['log2', 'f32', 10, F(Math.log2(10))],
  ['sin', 'f32', 0, 0], ['sin', 'f32', 1, F(Math.sin(1))], ['cos', 'f32', 0, 1], ['cos', 'f32', 1, F(Math.cos(1))], ['tan', 'f32', 0.5, F(Math.tan(0.5))],
  ['asin', 'f32', 1, F(Math.PI / 2)], ['asin', 'f32', 2, NaN], ['acos', 'f32', 1, 0], ['acos', 'f32', -1, F(Math.PI)], ['atan', 'f32', 1, F(Math.PI / 4)],
  ['saturate', 'f32', -0.5, 0], ['saturate', 'f32', 0.25, 0.25], ['saturate', 'f32', 7, 1], ['saturate', 'f32', NaN, 0], ['saturate', 'f32x2', [2, -2], [1, 0]],
  ['length', 'f32', -2, 2], ['length', 'f32x2', [3, 4], 5], ['length', 'f32x3', [1, 2, 2], 3], ['length', 'f32x4', [1, 1, 1, 1], 2],
  ['normalize', 'f32x2', [3, 4], [F(0.6), F(0.8)]], ['normalize', 'f32x3', [0, 0, -2], [0, 0, -1]], ['normalize', 'f32x4', [2, 0, 0, 0], [1, 0, 0, 0]],
  ['any', 'boolx3', [0, 1, 0], 1], ['any', 'boolx3', [0, 0, 0], 0], ['any', 'bool', 1, 1], ['all', 'boolx3', [1, 1, 1], 1], ['all', 'boolx2', [1, 0], 0], ['all', 'bool', 0, 0],
  ['transpose', 'm2', [1, 2, 3, 4], [1, 3, 2, 4]], ['transpose', 'm3', [1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 4, 7, 2, 5, 8, 3, 6, 9]],
  ['transpose', 'm4', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], [1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15, 4, 8, 12, 16]],
]

const BINARY_ROWS: readonly (readonly [BinaryFn, ValueType, ValueType, Arg, Arg, Arg])[] = [
  ['add', 'f32', 'f32', 16777216, 1, 16777216], ['add', 'f32', 'f32', F(0.1), F(0.2), 0.30000001192092896], ['add', 'f32', 'f32', F(3e38), F(3e38), Infinity],
  ['add', 'i32', 'i32', I32_MAX, 1, I32_MIN], ['add', 'u32', 'u32', U32_MAX, 1, 0], ['add', 'f32x3', 'f32', [1, 2, 3], 10, [11, 12, 13]], ['add', 'i32', 'i32x2', 10, [1, -2], [11, 8]],
  ['add', 'm2', 'm2', [1, 2, 3, 4], [10, 20, 30, 40], [11, 22, 33, 44]],
  ['sub', 'i32', 'i32', I32_MIN, 1, I32_MAX], ['sub', 'u32', 'u32', 0, 1, U32_MAX], ['sub', 'f32', 'f32', 1, F(1e-8), 1], ['sub', 'm2', 'm2', [1, 2, 3, 4], [1, 1, 1, 1], [0, 1, 2, 3]],
  ['mul', 'f32', 'f32', 4097, 4097, 16785408], ['mul', 'i32', 'i32', 65536, 65536, 0], ['mul', 'i32', 'i32', I32_MAX, 2, -2], ['mul', 'i32', 'i32', -3, 7, -21],
  ['mul', 'u32', 'u32', 65537, 65537, 131073], ['mul', 'u32', 'u32', U32_MAX, U32_MAX, 1], ['mul', 'f32x2', 'f32', [1.5, -2], 2, [3, -4]], ['mul', 'm2', 'f32', [1, 2, 3, 4], 2, [2, 4, 6, 8]],
  ['mul', 'u32x2', 'u32x2', [3, 65536], [5, 65536], [15, 0]],
  ['div', 'f32', 'f32', 1, 3, F(1 / 3)], ['div', 'f32', 'f32', 1, 0, Infinity], ['div', 'f32', 'f32', -1, 0, -Infinity], ['div', 'f32', 'f32', 0, 0, NaN],
  ['div', 'i32', 'i32', 7, 2, 3], ['div', 'i32', 'i32', -7, 2, -3], ['div', 'i32', 'i32', 7, -2, -3], ['div', 'i32', 'i32', 7, 0, 7], ['div', 'i32', 'i32', I32_MIN, -1, I32_MIN],
  ['div', 'i32', 'i32', I32_MIN, 0, I32_MIN], ['div', 'i32', 'i32', -1, 2, 0], ['div', 'u32', 'u32', 7, 0, 7], ['div', 'u32', 'u32', U32_MAX, 2, I32_MAX], ['div', 'u32', 'u32', U32_MAX, U32_MAX, 1],
  ['rem', 'f32', 'f32', 5.5, 2, 1.5], ['rem', 'f32', 'f32', -5.5, 2, -1.5], ['rem', 'f32', 'f32', 1, 0, NaN],
  ['rem', 'i32', 'i32', 7, 0, 0], ['rem', 'i32', 'i32', -7, 2, -1], ['rem', 'i32', 'i32', 7, -2, 1], ['rem', 'i32', 'i32', I32_MIN, -1, 0], ['rem', 'i32', 'i32', -4, 2, 0],
  ['rem', 'u32', 'u32', 7, 0, 0], ['rem', 'u32', 'u32', U32_MAX, 10, 5],
  ['min', 'f32', 'f32', 1, 2, 1], ['min', 'f32', 'f32', NaN, 2, 2], ['min', 'f32', 'f32', 2, NaN, 2], ['min', 'i32', 'i32', -5, 3, -5], ['min', 'u32', 'u32', U32_MAX, 3, 3], ['min', 'f32x2', 'f32x2', [1, 5], [2, 4], [1, 4]],
  ['max', 'f32', 'f32', NaN, -1, -1], ['max', 'f32', 'f32', -1, NaN, -1], ['max', 'i32', 'i32', -5, 3, 3], ['max', 'u32', 'u32', U32_MAX, 0, U32_MAX],
  ['pow', 'f32', 'f32', 2, 10, 1024], ['pow', 'f32', 'f32', 2, 0.5, F(Math.SQRT2)], ['pow', 'f32', 'f32', -8, F(1 / 3), NaN],
  ['atan2', 'f32', 'f32', 1, 1, F(Math.PI / 4)], ['atan2', 'f32', 'f32', 1, -1, F((3 * Math.PI) / 4)], ['atan2', 'f32', 'f32', 0, -1, F(Math.PI)],
  ['step', 'f32', 'f32', 1, 0.5, 0], ['step', 'f32', 'f32', 1, 1, 1], ['step', 'f32', 'f32', 1, 2, 1], ['step', 'f32', 'f32', NaN, 1, 0], ['step', 'f32x2', 'f32x2', [0, 0], [-1, 1], [0, 1]],
  ['and', 'i32', 'i32', -1, 15, 15], ['and', 'u32', 'u32', 0xf0f0f0f0, 0xff00ff00, 0xf000f000], ['and', 'bool', 'bool', 1, 0, 0], ['and', 'boolx2', 'boolx2', [1, 1], [1, 0], [1, 0]],
  ['or', 'u32', 'u32', 0xf0f0f0f0, 0x0f0f0f0f, U32_MAX], ['or', 'i32', 'i32', I32_MIN, 1, -2147483647], ['or', 'bool', 'bool', 0, 1, 1],
  ['xor', 'u32', 'u32', U32_MAX, 1, 0xfffffffe], ['xor', 'i32', 'i32', -1, 1, -2], ['xor', 'bool', 'bool', 1, 1, 0],
  ['shl', 'i32', 'u32', 1, 33, 2], ['shl', 'i32', 'u32', 1, 31, I32_MIN], ['shl', 'u32', 'u32', 1, 31, 0x80000000], ['shl', 'u32', 'u32', U32_MAX, 4, 0xfffffff0], ['shl', 'i32x2', 'u32x2', [3, -1], [32, 1], [3, -2]],
  ['shr', 'i32', 'u32', -8, 1, -4], ['shr', 'i32', 'u32', -1, 33, -1], ['shr', 'i32', 'u32', I32_MIN, 31, -1], ['shr', 'u32', 'u32', 0x80000000, 33, 0x40000000], ['shr', 'u32', 'u32', U32_MAX, 31, 1], ['shr', 'u32', 'u32', 5, 32, 5],
  ['eq', 'f32', 'f32', NaN, NaN, 0], ['eq', 'f32', 'f32', -0, 0, 1], ['eq', 'u32x3', 'u32x3', [1, 2, 3], [1, 0, 3], [1, 0, 1]], ['eq', 'bool', 'bool', 1, 1, 1],
  ['ne', 'f32', 'f32', NaN, NaN, 1], ['ne', 'i32', 'i32', -1, -1, 0], ['ne', 'boolx2', 'boolx2', [1, 0], [0, 0], [1, 0]],
  ['lt', 'f32', 'f32', NaN, 1, 0], ['lt', 'i32', 'i32', -1, 0, 1], ['lt', 'u32', 'u32', 0, U32_MAX, 1],
  ['le', 'f32', 'f32', 1, 1, 1], ['le', 'f32', 'f32', NaN, NaN, 0],
  ['gt', 'u32', 'u32', U32_MAX, 0, 1], ['gt', 'i32', 'i32', I32_MIN, I32_MAX, 0],
  ['ge', 'f32', 'f32', NaN, 1, 0], ['ge', 'f32x2', 'f32x2', [1, 2], [1, 3], [1, 0]],
  ['land', 'bool', 'bool', 1, 0, 0], ['land', 'boolx2', 'boolx2', [1, 1], [1, 0], [1, 0]],
  ['lor', 'bool', 'bool', 0, 0, 0], ['lor', 'boolx2', 'boolx2', [0, 1], [0, 0], [0, 1]],
  ['dot', 'f32x3', 'f32x3', [1, 2, 3], [4, 5, 6], 32], ['dot', 'i32x4', 'i32x4', [1, -2, 3, -4], [5, 6, 7, 8], -18],
  // Products and sums round one by one, left to right: 1 + 2^24 rounds back to 2^24 twice over (in double it would be 2^24 + 2).
  ['dot', 'f32x3', 'f32x3', [1, 16777216, 1], [1, 1, 1], 16777216],
  ['dot', 'i32x2', 'i32x2', [65536, 1], [65536, 5], 5], ['dot', 'u32x2', 'u32x2', [U32_MAX, 2], [1, 1], 1],
  ['cross', 'f32x3', 'f32x3', [1, 0, 0], [0, 1, 0], [0, 0, 1]], ['cross', 'f32x3', 'f32x3', [1, 2, 3], [4, 5, 6], [-3, 6, -3]],
  ['distance', 'f32x2', 'f32x2', [0, 0], [3, 4], 5], ['distance', 'f32', 'f32', 1, -2, 3], ['distance', 'f32x3', 'f32x3', [1, 1, 1], [1, 1, 1], 0],
  // Each difference rounds to f32 first: 2^24 + 1 becomes 2^24 (unrounded, the length would come out at 2^24 + 2).
  ['distance', 'f32x2', 'f32x2', [16777216, 1], [-1, 0], 16777216],
  ['reflect', 'f32x2', 'f32x2', [1, -1], [0, 1], [1, 1]], ['reflect', 'f32x3', 'f32x3', [1, 2, 3], [0, 0, 1], [1, 2, -3]],
]

const MIX_T = F(0.1)
const FMA_A = 1 + 2 ** -12

const TERNARY_ROWS: readonly (readonly [TernaryFn, readonly ValueType[], readonly Arg[], Arg])[] = [
  ['mix', ['f32', 'f32', 'f32'], [0, 10, 0.25], 2.5], ['mix', ['f32x2', 'f32x2', 'f32'], [[0, 4], [10, 8], 0.5], [5, 6]], ['mix', ['f32x2', 'f32x2', 'f32x2'], [[0, 0], [1, 1], [0, 1]], [0, 1]],
  // a (1 - t) + b t, each step rounded.
  ['mix', ['f32', 'f32', 'f32'], [1, 3, MIX_T], F(F(1 * F(1 - MIX_T)) + F(3 * MIX_T))],
  // At t = 1 the result is b exactly; a + (b - a) t would give 0 here, as 1 - 10^8 rounds to -10^8.
  ['mix', ['f32', 'f32', 'f32'], [100000000, 1, 1], 1],
  ['clamp', ['i32', 'i32', 'i32'], [5, 0, 3], 3], ['clamp', ['i32', 'i32', 'i32'], [-5, 0, 3], 0], ['clamp', ['f32', 'f32', 'f32'], [NaN, 0, 1], 0], ['clamp', ['u32x2', 'u32x2', 'u32x2'], [[7, 1], [2, 2], [5, 5]], [5, 2]],
  ['smoothstep', ['f32', 'f32', 'f32'], [0, 1, 0.5], 0.5], ['smoothstep', ['f32', 'f32', 'f32'], [0, 1, -1], 0], ['smoothstep', ['f32', 'f32', 'f32'], [0, 1, 2], 1],
  ['smoothstep', ['f32', 'f32', 'f32'], [0, 2, 0.5], 0.15625], ['smoothstep', ['f32', 'f32', 'f32'], [1, 1, 1], 0], ['smoothstep', ['f32x2', 'f32x2', 'f32x2'], [[0, 0], [1, 2], [0.5, 0.5]], [0.5, 0.15625]],
  ['fma', ['f32', 'f32', 'f32'], [2, 3, 1], 7],
  // (1 + 2^-12)^2 - (1 + 2^-11) is exactly 2^-24 in one rounding; rounding the product first would give 0.
  ['fma', ['f32', 'f32', 'f32'], [FMA_A, FMA_A, -(1 + 2 ** -11)], 2 ** -24],
  // The exact sum sits just above the halfway point between 1 and 1 + 2^-23: a double rounding would fall to 1.
  ['fma', ['f32', 'f32', 'f32'], [24929 * 2 ** -15, 673 * 2 ** -9, 2 ** -80], 1 + 2 ** -23],
  // The same just below a halfway point, and with the error opposite in sign to the sum.
  ['fma', ['f32', 'f32', 'f32'], [24929 * 2 ** -15, 673 * 2 ** -9, -(2 ** -80)], 1],
  ['fma', ['f32', 'f32', 'f32'], [-24929 * 2 ** -15, 673 * 2 ** -9, -(2 ** -80)], -(1 + 2 ** -23)],
  ['choose', ['bool', 'f32', 'f32'], [1, 5, 7], 5], ['choose', ['bool', 'f32', 'f32'], [0, 5, 7], 7], ['choose', ['boolx2', 'i32x2', 'i32x2'], [[1, 0], [1, 2], [3, 4]], [1, 4]],
  ['choose', ['bool', 'm2', 'm2'], [0, [1, 2, 3, 4], [5, 6, 7, 8]], [5, 6, 7, 8]], ['choose', ['bool', 'u32x3', 'u32x3'], [1, [1, 2, 3], [4, 5, 6]], [1, 2, 3]],
]

/** Groups rows by a key, keeping first-seen order. */
function grouped<R>(rows: readonly R[], key: (r: R) => string): R[][] {
  const groups = new Map<string, R[]>()
  for (const r of rows) {
    const k = key(r)
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  return [...groups.values()]
}

test('every unary function on the types it takes, with edge values: wrap, -0, NaN, halves to even, fract reaching 1', () => {
  for (const rows of grouped(UNARY_ROWS, (r) => `${r[0]} ${r[1]}`)) {
    const [fn, t] = rows[0]
    const got = calc([t], rows.map((r) => [r[2]]), (b, x) => b.unary(fn, x))
    rows.forEach((r, i) => assert.deepEqual(got[i], flat(r[3]), `${fn} ${t} ${String(r[2])}`))
  }
  assert.deepEqual(new Set(UNARY_ROWS.map((r) => r[0])), new Set(UNARY), 'every unary function is covered')
})

test('every binary function on the types it takes, with edge values: wrap, division by zero, shifts by 32 and more, NaN', () => {
  for (const rows of grouped(BINARY_ROWS, (r) => `${r[0]} ${r[1]} ${r[2]}`)) {
    const [fn, ta, tb] = rows[0]
    const got = calc([ta, tb], rows.map((r) => [r[3], r[4]]), (b, x, y) => b.binary(fn, x, y))
    rows.forEach((r, i) => assert.deepEqual(got[i], flat(r[5]), `${fn} ${ta} ${tb} ${String(r[3])} ${String(r[4])}`))
  }
  assert.deepEqual(new Set(BINARY_ROWS.map((r) => r[0])), new Set(BINARY), 'every binary function is covered')
})

test('every ternary function on the types it takes: mix and smoothstep by their formulas, fma rounding once, choose lane by lane', () => {
  for (const rows of grouped(TERNARY_ROWS, (r) => `${r[0]} ${r[1].join(' ')}`)) {
    const [fn, types] = rows[0]
    const got = calc(types, rows.map((r) => r[2]), (b, x, y, z) => b.ternary(fn, x, y, z))
    rows.forEach((r, i) => assert.deepEqual(got[i], flat(r[3]), `${fn} ${types.join(' ')} ${r[2].map(String).join(' ')}`))
  }
  assert.deepEqual(new Set(TERNARY_ROWS.map((r) => r[0])), new Set(TERNARY), 'every ternary function is covered')
})

test('float rem is a - b trunc(a / b) with each step rounded, which is not the exact remainder', () => {
  const cases: [number, number][] = [[1e10, 3], [F(123456.789), F(0.7)], [-1e10, 7], [F(1e30), 3]]
  const got = calc(['f32', 'f32'], cases, (b, x, y) => b.rem(x, y))
  cases.forEach(([a, b], i) => assert.deepEqual(got[i], [F(a - F(b * Math.trunc(F(a / b))))]))
  assert.notEqual(got[0][0], 1e10 % 3, 'the exact remainder differs')
})

test('integer arithmetic matches exact BigInt arithmetic wrapped to 32 bits, on seeded random and edge values', () => {
  const next = lcg(7)
  const edges = [0, 1, 2, 31, 32, 33, -1, -2, I32_MIN, I32_MAX, I32_MIN + 1, 65535, 65536, -65536]
  const i32 = (n: number): number => n | 0
  const values = (k: number): number[] => Array.from({ length: k }, (_, i) => (i < edges.length ? edges[i] : i32(next())))
  const wrapI = (x: bigint): number => Number(BigInt.asIntN(32, x))
  const wrapU = (x: bigint): number => Number(BigInt.asUintN(32, x))
  const refs: { readonly [fn: string]: (a: bigint, b: bigint, wrap: (x: bigint) => number) => number } = {
    add: (a, b, w) => w(a + b), sub: (a, b, w) => w(a - b), mul: (a, b, w) => w(a * b),
    div: (a, b, w) => (b === 0n ? w(a) : w(a / b)), rem: (a, b, w) => (b === 0n ? 0 : w(a % b)),
    and: (a, b, w) => w(a & b), or: (a, b, w) => w(a | b), xor: (a, b, w) => w(a ^ b),
    min: (a, b, w) => w(a < b ? a : b), max: (a, b, w) => w(a > b ? a : b), lt: (a, b) => (a < b ? 1 : 0), ge: (a, b) => (a >= b ? 1 : 0),
    shl: (a, b, w) => w(a << (b & 31n)), shr: (a, b, w) => w(a >> (b & 31n)),
  }
  const as = values(240)
  const bs = values(240).reverse()
  for (const kind of ['i32', 'u32'] as const) {
    const wrap = kind === 'i32' ? wrapI : wrapU
    const own = (n: number): number => (kind === 'i32' ? n | 0 : n >>> 0)
    for (const [fn, ref] of Object.entries(refs)) {
      const shift = fn === 'shl' || fn === 'shr'
      const cases = as.map((a, i) => [own(a), shift ? bs[i] >>> 0 : own(bs[i])])
      const got = calc([kind, shift ? 'u32' : kind], cases, (b, x, y) => b.binary(fn as BinaryFn, x, y))
      cases.forEach(([a, b], i) => assert.deepEqual(got[i], [ref(BigInt(a), BigInt(b), wrap)], `${kind} ${fn} ${a} ${b}`))
    }
  }
})

test('make, pick, lane, column and transpose move components; a lane index is clamped into the vector', () => {
  assert.deepEqual(calc(['f32x2', 'f32', 'f32'], [[[1, 2], 3, 4]], (b, v, x, y) => b.make('f32x4', v, x, y)), [[1, 2, 3, 4]])
  assert.deepEqual(calc(['i32'], [[-7]], (b, x) => b.make('i32x3', x)), [[-7, -7, -7]])
  assert.deepEqual(calc(['f32', 'f32', 'f32', 'f32'], [[1, 2, 3, 4]], (b, ...xs) => b.make('m2', ...xs)), [[1, 2, 3, 4]])
  assert.deepEqual(calc(['f32x3', 'f32x3', 'f32x3'], [[[1, 2, 3], [4, 5, 6], [7, 8, 9]]], (b, ...cols) => b.make('m3', ...cols)), [[1, 2, 3, 4, 5, 6, 7, 8, 9]])
  assert.deepEqual(calc(['u32x4'], [[[10, 20, 30, 40]]], (b, v) => b.pick(v, 'wzx')), [[40, 30, 10]])
  assert.deepEqual(calc(['u32x4'], [[[10, 20, 30, 40]]], (b, v) => b.pick(v, [2])), [[30]])
  const lanes = calc(['f32x3', 'i32'], [[[5, 6, 7], -1], [[5, 6, 7], 1], [[5, 6, 7], 2], [[5, 6, 7], I32_MAX], [[5, 6, 7], I32_MIN]], (b, v, i) => b.lane(v, i))
  assert.deepEqual(lanes, [[5], [6], [7], [7], [5]])
  assert.deepEqual(calc(['u32x2', 'u32'], [[[8, 9], U32_MAX], [[8, 9], 0]], (b, v, i) => b.lane(v, i)), [[9], [8]])
  assert.deepEqual(calc(['m3'], [[[1, 2, 3, 4, 5, 6, 7, 8, 9]]], (b, g) => b.column(g, 1)), [[4, 5, 6]])
})

/** A column-major product of n x n grids, every product and sum rounded left to right. */
function gridProduct(a: readonly number[], b: readonly number[], n: number): number[] {
  const out: number[] = []
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let acc = F(a[i] * b[j * n])
      for (let k = 1; k < n; k++) acc = F(acc + F(a[k * n + i] * b[j * n + k]))
      out.push(acc)
    }
  }
  return out
}

test('grid products are column-major: grid x grid, grid x column, row x grid, each sum rounded step by step', () => {
  const A = [1, 2, 3, 4]
  const B = [5, 6, 7, 8]
  // A has columns (1, 2) and (3, 4): as rows, [1 3] and [2 4].
  assert.deepEqual(calc(['m2', 'f32x2'], [[A, [5, 6]]], (b, g, v) => b.mul(g, v)), [[23, 34]])
  assert.deepEqual(calc(['f32x2', 'm2'], [[[5, 6], A]], (b, v, g) => b.mul(v, g)), [[17, 39]])
  assert.deepEqual(calc(['m2', 'm2'], [[A, B]], (b, g, h) => b.mul(g, h)), [[23, 34, 31, 46]])
  const next = lcg(11)
  for (const n of [2, 3, 4]) {
    const t = `m${n}` as ValueType
    const col = `f32x${n}` as ValueType
    const cases = Array.from({ length: 6 }, () => [Array.from({ length: n * n }, () => F((next() % 2001) / 7 - 140)), Array.from({ length: n * n }, () => F((next() % 2001) / 3 - 300))])
    const got = calc([t, t], cases, (b, g, h) => b.mul(g, h))
    cases.forEach(([a, b], i) => assert.deepEqual(got[i], gridProduct(a, b, n), `m${n} x m${n}`))
    const byColumn = calc([t, col], cases.map(([a, b]) => [a, b.slice(0, n)]), (b, g, v) => b.mul(g, v))
    cases.forEach(([a, b], i) => assert.deepEqual(byColumn[i], gridProduct(a, [...b.slice(0, n), ...new Array<number>(n * n - n).fill(0)], n).slice(0, n)))
    const byRow = calc([col, t], cases.map(([a, b]) => [b.slice(0, n), a]), (b, v, g) => b.mul(v, g))
    const transposed = (g: readonly number[]): number[] => Array.from({ length: n * n }, (_, k) => g[(k % n) * n + Math.floor(k / n)])
    cases.forEach(([a, b], i) => assert.deepEqual(byRow[i], gridProduct(transposed(a), [...b.slice(0, n), ...new Array<number>(n * n - n).fill(0)], n).slice(0, n)))
  }
  // Row 0 of this m3 x column sums 2^24 + 1 + 1 one step at a time: 2^24, not the 2^24 + 2 a double would keep.
  assert.deepEqual(calc(['m3', 'f32x3'], [[[16777216, 0, 0, 1, 0, 0, 1, 0, 0], [1, 1, 1]]], (b, g, v) => b.mul(g, v)), [[16777216, 0, 0]])
})

test('casts truncate toward zero and saturate at the limits, NaN gives 0, integers keep their bits, bools are 0 and 1', () => {
  const toI = calc(['f32'], [[2147483520], [2147483648], [I32_MIN], [F(-3e9)], [NaN], [-0.9], [2.9], [-2.9], [Infinity], [-Infinity], [-0]], (b, x) => b.cast(x, 'i32'))
  assert.deepEqual(toI, [[2147483520], [I32_MAX], [I32_MIN], [I32_MIN], [0], [0], [2], [-2], [I32_MAX], [I32_MIN], [0]])
  const toU = calc(['f32'], [[4294967040], [4294967296], [-1], [NaN], [1.9], [Infinity], [-0.5]], (b, x) => b.cast(x, 'u32'))
  assert.deepEqual(toU, [[4294967040], [U32_MAX], [0], [0], [1], [U32_MAX], [0]])
  assert.deepEqual(calc(['i32'], [[-1], [I32_MIN], [5]], (b, x) => b.cast(x, 'u32')), [[U32_MAX], [0x80000000], [5]])
  assert.deepEqual(calc(['u32'], [[U32_MAX], [0x80000000]], (b, x) => b.cast(x, 'i32')), [[-1], [I32_MIN]])
  // Integers round to the nearest f32, ties to even.
  assert.deepEqual(calc(['i32'], [[16777217], [16777219], [I32_MIN]], (b, x) => b.cast(x, 'f32')), [[16777216], [16777220], [I32_MIN]])
  assert.deepEqual(calc(['u32'], [[U32_MAX]], (b, x) => b.cast(x, 'f32')), [[4294967296]])
  assert.deepEqual(calc(['bool'], [[1], [0]], (b, x) => b.cast(x, 'f32')), [[1], [0]])
  assert.deepEqual(calc(['bool'], [[1], [0]], (b, x) => b.cast(x, 'i32')), [[1], [0]])
  assert.deepEqual(calc(['f32'], [[NaN], [-0], [0.5], [0]], (b, x) => b.cast(x, 'bool')), [[1], [0], [1], [0]])
  assert.deepEqual(calc(['i32'], [[-1], [0]], (b, x) => b.cast(x, 'bool')), [[1], [0]])
  assert.deepEqual(calc(['f32x2'], [[[-1.5, 7.9]]], (b, x) => b.cast(x, 'i32')), [[-1, 7]])
})

test('bits reinterprets the IEEE bits between f32, i32 and u32', () => {
  assert.deepEqual(calc(['f32'], [[1], [-0], [Infinity], [-1]], (b, x) => b.bits(x, 'u32')), [[0x3f800000], [0x80000000], [0x7f800000], [0xbf800000]])
  assert.deepEqual(calc(['f32'], [[-1]], (b, x) => b.bits(x, 'i32')), [[0xbf800000 | 0]])
  assert.deepEqual(calc(['u32'], [[0x7f800000], [1], [0x40490fdb]], (b, x) => b.bits(x, 'f32')), [[Infinity], [2 ** -149], [F(Math.PI)]])
  assert.deepEqual(calc(['i32'], [[0xbf800000 | 0]], (b, x) => b.bits(x, 'f32')), [[-1]])
  assert.ok(Number.isNaN(calc(['u32'], [[0x7fc00000]], (b, x) => b.bits(x, 'f32'))[0][0]))
  assert.deepEqual(calc(['u32'], [[U32_MAX]], (b, x) => b.bits(x, 'i32')), [[-1]])
  assert.deepEqual(calc(['i32'], [[-2]], (b, x) => b.bits(x, 'u32')), [[0xfffffffe]])
  assert.deepEqual(calc(['f32x2'], [[[2, 0.5]]], (b, x) => b.bits(x, 'u32')), [[0x40000000, 0x3f000000]])
})

// ---------------------------------------------------------------------------------------------------
// Control flow

test('if and else split the lanes of a batch, nested, each lane taking its own branch', () => {
  const got = computeU32(8, 8, (b, i, out) => {
    const r = b.var('u32', 0)
    b.if(b.lt(i, 3), () => b.set(r, b.mul(i, 10)), () => {
      b.if(b.eq(b.rem(i, 2), 0), () => b.set(r, b.add(i, 100)), () => b.set(r, b.add(i, 200)))
    })
    b.write(out, ['items', i], b.get(r))
  })
  assert.deepEqual(got, [0, 10, 20, 203, 104, 205, 106, 207])
})

test('nested loops with break and continue run each lane its own way: seeded limits against a plain reference', () => {
  const next = lcg(3)
  const limits = Array.from({ length: 64 }, () => next() % 9)
  const caps = Array.from({ length: 64 }, () => next() % 5)
  const src = new Uint8Array(64 * 8)
  const dv = new DataView(src.buffer)
  limits.forEach((n, i) => dv.setUint32(i * 4, n, true))
  caps.forEach((n, i) => dv.setUint32(256 + i * 4, n, true))
  const out = new Uint8Array(64 * 4)
  compute([64, 1, 1], (b, i) => {
    const input = b.storage(0, 0, { limits: arrayOf('u32', 64), caps: arrayOf('u32', 64) })
    const dst = b.storage(0, 1, { items: arrayOf('u32') }, { writable: true })
    const limit = b.read(input, 'limits', i)
    const cap = b.read(input, 'caps', i)
    const total = b.var('u32', 0)
    const j = b.var('u32', 0)
    b.loop(() => {
      const jv = b.get(j)
      b.if(b.ge(jv, limit), () => b.break())
      b.set(j, b.add(jv, 1))
      b.if(b.eq(b.and(jv, 1), 1), () => b.continue())
      const k = b.var('u32', 0)
      b.loop(() => {
        const kv = b.get(k)
        b.if(b.ge(kv, jv), () => b.break())
        b.if(b.gt(kv, cap), () => b.break())
        b.set(total, b.add(b.get(total), b.add(kv, 1)))
        b.set(k, b.add(kv, 1))
      })
      // A lane that broke the outer loop earlier in this iteration must not come back after the inner loop.
      b.set(total, b.add(b.get(total), 100))
    })
    b.write(dst, ['items', i], b.get(total))
  }, { 0: whole(src), 1: whole(out) })
  const reference = (limit: number, cap: number): number => {
    let total = 0
    for (let j = 0; j < limit; j++) {
      if (j & 1) continue
      for (let k = 0; k < j; k++) {
        if (k > cap) break
        total += k + 1
      }
      total += 100
    }
    return total
  }
  assert.deepEqual(u32s(out, 64), limits.map((n, i) => reference(n, caps[i])))
})

test('return in a branch ends those lanes: what they wrote before stands, and nothing after it runs', () => {
  const got = computeU32(8, 16, (b, i, out) => {
    b.write(out, ['items', i], 1)
    b.if(b.eq(b.rem(i, 3), 0), () => b.return())
    b.write(out, ['items', b.add(i, 8)], 2)
  })
  assert.deepEqual(got, [1, 1, 1, 1, 1, 1, 1, 1, 0, 2, 2, 0, 2, 2, 0, 2])
  // In a vertex shader, outputs written before a return are kept and the rest stay zero.
  const b = lens('vertex')
  const x = b.input(0, 'f32')
  const o0 = b.output(0, 'f32')
  const o1 = b.output(1, 'f32')
  b.out(o0, x)
  b.if(b.lt(x, 0), () => b.return())
  b.out(o1, b.mul(x, 2))
  const p = compile(b.finish())
  const r = p.run({ lanes: 3, inputs: [-1, 2, 3] }, p.bind(NONE), BUDGET)
  assert.deepEqual([...r.outputs.subarray(0, 6)], [-1, 0, 2, 4, 3, 6])
})

test('a loop leaves as if by break after 65,536 iterations of one entry; each entry counts afresh, lanes leave on their own', () => {
  assert.equal(LOOP_ITERATIONS, 65536)
  const once = computeU32(1, 1, (b, _i, out) => {
    const n = b.var('u32', 0)
    b.loop(() => b.set(n, b.add(b.get(n), 1)))
    b.write(out, ['items', 0], b.get(n))
  })
  assert.deepEqual(once, [65536])
  const twice = computeU32(1, 1, (b, _i, out) => {
    const n = b.var('u32', 0)
    const m = b.var('u32', 0)
    b.loop(() => {
      b.if(b.ge(b.get(m), 2), () => b.break())
      b.set(m, b.add(b.get(m), 1))
      b.loop(() => {
        b.set(n, b.add(b.get(n), 1))
        b.continue()
      })
    })
    b.write(out, ['items', 0], b.get(n))
  })
  assert.deepEqual(twice, [131072], 'the inner loop is entered twice and runs to the bound each time')
  // Four lanes of one batch: three break on their own at different counts, one runs to the bound.
  const lanes = computeU32(4, 4, (b, i, out) => {
    const n = b.var('u32', 0)
    const stop = b.mul(i, 30000)
    b.loop(() => {
      b.if(b.ge(b.get(n), stop), () => b.break())
      b.set(n, b.add(b.get(n), 1))
    })
    b.write(out, ['items', i], b.get(n))
  })
  assert.deepEqual(lanes, [0, 30000, 60000, 65536])
})

test('a variable declared in a loop body starts afresh every iteration; one declared outside keeps its value', () => {
  const got = computeU32(1, 2, (b, _i, out) => {
    const acc = b.var('u32', 0)
    const m = b.var('u32', 0)
    const seed = b.u32(10)
    b.loop(() => {
      b.if(b.ge(b.get(m), 5), () => b.break())
      b.set(m, b.add(b.get(m), 1))
      const x = b.var('u32')
      b.set(x, b.add(b.get(x), 1))
      const y = b.var('u32', seed)
      b.set(y, b.add(b.get(y), b.get(m)))
      b.set(acc, b.add(b.get(acc), b.get(x)))
      b.write(out, ['items', 1], b.get(y))
    })
    b.write(out, ['items', 0], b.get(acc))
  })
  assert.deepEqual(got, [5, 15])
})

test('a vertex position counts only where written; outputs never written are zero', () => {
  const b = lens('vertex')
  const vi = b.builtin('vertex-index')
  const o = b.output(0, 'f32x2')
  b.if(b.eq(b.rem(vi, 2), 0), () => {
    b.position(b.f32x4(b.cast(vi, 'f32'), 1, 2, 3))
    b.out(o, b.f32x2(7, 8))
  })
  const p = compile(b.finish())
  assert.deepEqual(p.builtins, ['vertex-index'])
  const r = p.run({ lanes: 4, builtins: { 'vertex-index': [10, 11, 12, 13] } }, p.bind(NONE), BUDGET)
  assert.equal(r.positioned, 0b0101)
  assert.deepEqual([...r.position], [10, 1, 2, 3, 0, 0, 0, 0, 12, 1, 2, 3, 0, 0, 0, 0])
  assert.deepEqual([...r.outputs], [7, 8, 0, 0, 7, 8, 0, 0])
  assert.equal(r.discarded, 0)
  // A later run whose lanes write nothing finds no trace of the run before.
  const again = p.run({ lanes: 4, builtins: { 'vertex-index': [11, 13, 15, 17] } }, p.bind(NONE), BUDGET)
  assert.equal(again.positioned, 0)
  assert.deepEqual([...again.position], new Array(16).fill(0))
  assert.deepEqual([...again.outputs], new Array(8).fill(0))
})

// ---------------------------------------------------------------------------------------------------
// Fragments: derivatives and discard

test('derivatives on a quad: fine differences within the row for x and the column for y, width their sum of sizes', () => {
  const b = lens('fragment')
  const fc = b.builtin('frag-coord')
  const x = b.pick(fc, 'x')
  const y = b.pick(fc, 'y')
  const f = b.sub(b.mul(x, 3), b.mul(y, 5))
  const g = b.mul(x, y)
  b.out(b.output(0, 'f32x4'), b.f32x4(b.dx(f), b.dy(f), b.deriv('width', f), b.dx(g)))
  b.out(b.output(1, 'f32x4'), b.f32x4(b.dy(g), b.deriv('width', g), b.dx(b.pick(fc, 'xy'))))
  const p = compile(b.finish())
  const r = quad(p, p.bind(NONE), 10, 20)
  const lane = (l: number): number[] => [...r.outputs.subarray(l * 8, l * 8 + 8)]
  // f = 3x - 5y: width adds the sizes, 3 + 5. g = x y: along x the step is the row's y (20.5 or 21.5), along y
  // the column's x (10.5 or 11.5).
  assert.deepEqual(lane(0), [3, -5, 8, 20.5, 10.5, 31, 1, 0])
  assert.deepEqual(lane(1), [3, -5, 8, 20.5, 11.5, 32, 1, 0])
  assert.deepEqual(lane(2), [3, -5, 8, 21.5, 10.5, 32, 1, 0])
  assert.deepEqual(lane(3), [3, -5, 8, 21.5, 11.5, 33, 1, 0])
  assert.equal(r.helpers, 0)
  // The value rounds to f32 before its difference is taken: x + 2^24 lands on even numbers, a step of 2 along x.
  const c = lens('fragment')
  const cx = c.pick(c.builtin('frag-coord'), 'x')
  c.out(c.output(0, 'f32'), c.dx(c.add(cx, 16777216)))
  const q = compile(c.finish())
  assert.deepEqual([...quad(q, q.bind(NONE), 0, 0).outputs], [2, 2, 2, 2])
})

test('discard makes a helper: it runs on so a neighbour\'s derivative uses its values, but its out, write and put do nothing', () => {
  const b = lens('fragment')
  const fc = b.builtin('frag-coord')
  const x = b.pick(fc, 'x')
  const buf = b.storage(0, 0, { items: arrayOf('f32') }, { writable: true })
  const img = b.storageImage(0, 1, 'rgba8')
  const lane = b.add(b.cast(b.sub(x, 10.5), 'u32'), b.mul(b.cast(b.sub(b.pick(fc, 'y'), 20.5), 'u32'), 2))
  b.if(b.eq(b.rem(lane, 2), 1), () => b.discard())
  // Through a variable: a helper keeps running its sets, so its neighbour's derivative still finds its value.
  const sq = b.var('f32', 0)
  b.set(sq, b.mul(x, x))
  const d = b.dx(b.get(sq))
  b.write(buf, ['items', lane], d)
  b.put(img, b.u32x2(lane, 0), b.f32x4(1, 1, 1, 1))
  b.out(b.output(0, 'f32x4'), b.f32x4(d, x, 0, 1))
  const p = compile(b.finish())
  const bytes = new Uint8Array(16)
  const store = new ImageStore({ format: 'rgba8', width: 4, height: 1, layers: 1, levels: 1, samples: 1 })
  // Lane 2 covers no sample (a helper from the start); lanes 1 and 3 discard.
  const r = quad(p, p.bind(bound({ 0: whole(bytes), 1: { store, view: view(store) } })), 10, 20, 0b0100)
  assert.equal(r.discarded, 0b1010)
  assert.equal(r.helpers, 0b1110)
  // Lane 0's dx reads lane 1, which had discarded: 11.5^2 - 10.5^2 = 22.
  assert.deepEqual([...r.outputs], [22, 10.5, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  assert.deepEqual(f32s(bytes, 4), [22, 0, 0, 0])
  assert.deepEqual([...store.bytes], [255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
})

// ---------------------------------------------------------------------------------------------------
// Blocks in memory

test('a uniform block is read at layoutBlock\'s offsets: nested blocks, padded grid columns, arrays of 16-byte stride, clamped indices', () => {
  const spec = { scale: 'f32', tint: 'f32x3', xform: 'm3', lights: arrayOf({ pos: 'f32x3', power: 'f32' }, 3), flag: 'u32', offs: 'i32x2' } as const
  const layout = layoutBlock(block(spec), 'uniform')
  // Worked by hand: f32x3 aligns to 16; m3 takes three 16-byte columns; each light is a 16-byte block.
  assert.deepEqual(layout.offsets, [0, 16, 32, 80, 128, 136])
  assert.equal(layout.size, 144)
  const bytes = new Uint8Array(144)
  const dv = new DataView(bytes.buffer)
  dv.setFloat32(0, 1.5, true)
  ;[0.25, 0.5, 0.75].forEach((v, c) => dv.setFloat32(16 + c * 4, v, true))
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) dv.setFloat32(32 + j * 16 + i * 4, j * 10 + i, true)
  for (let k = 0; k < 3; k++) {
    for (let c = 0; c < 3; c++) dv.setFloat32(80 + k * 16 + c * 4, 100 * k + c, true)
    dv.setFloat32(80 + k * 16 + 12, -k, true)
  }
  dv.setUint32(128, 0xdeadbeef, true)
  dv.setInt32(136, -5, true)
  dv.setInt32(140, 6, true)
  const out = new Uint8Array(64 * 4)
  const ints = new Uint8Array(16 * 4)
  compute([5, 1, 1], (b, i) => {
    const u = b.uniform(0, 0, spec)
    const dst = b.storage(0, 1, { items: arrayOf('f32') }, { writable: true })
    const idst = b.storage(0, 2, { items: arrayOf('u32') }, { writable: true })
    b.if(b.eq(i, 0), () => {
      let k = emit(b, dst, 0, b.read(u, 'scale'))
      k = emit(b, dst, k, b.read(u, 'tint'))
      emit(b, dst, k, b.read(u, 'xform'))
      emit(b, idst, 0, b.read(u, 'flag'))
      emit(b, idst, 1, b.bits(b.read(u, 'offs'), 'u32'))
    })
    // Invocations 3 and 4 index past the three lights and read the last.
    const light = b.f32x4(b.read(u, 'lights', i, 'pos'), b.read(u, 'lights', i, 'power'))
    for (let c = 0; c < 4; c++) b.write(dst, ['items', b.add(b.mul(i, 4), 16 + c)], b.pick(light, [c]))
  }, { 0: whole(bytes), 1: whole(out), 2: whole(ints) })
  assert.deepEqual(f32s(out, 13), [1.5, 0.25, 0.5, 0.75, 0, 1, 2, 10, 11, 12, 20, 21, 22])
  const lights = [[0, 1, 2, -0], [100, 101, 102, -1], [200, 201, 202, -2], [200, 201, 202, -2], [200, 201, 202, -2]]
  assert.deepEqual(f32s(out, 20, 64), lights.flat())
  assert.deepEqual(u32s(ints, 3), [0xdeadbeef, (-5) >>> 0, 6])
})

test('a storage block\'s final array is clamped into the elements the binding holds; with none, reads give zero and writes do nothing', () => {
  const spec = { count: 'u32', items: arrayOf({ a: 'f32', b: 'u32x2' }) } as const
  const layout = layoutBlock(block(spec), 'storage')
  assert.deepEqual(layout.offsets, [0, 8])
  assert.equal(strideOf({ struct: block({ a: 'f32', b: 'u32x2' }) }, 'storage'), 16)
  const run = (srcSize: number, dstSize: number): { readonly read: number[]; readonly dst: Uint8Array } => {
    const src = new Uint8Array(8 + 16 * 4)
    const sv = new DataView(src.buffer)
    for (let e = 0; e < 4; e++) {
      sv.setFloat32(8 + e * 16, e + 0.5, true)
      sv.setUint32(8 + e * 16 + 8, 10 * e, true)
      sv.setUint32(8 + e * 16 + 12, 10 * e + 1, true)
    }
    const dst = new Uint8Array(96).fill(0xab)
    const out = new Uint8Array(6 * 3 * 4)
    compute([6, 1, 1], (b, i) => {
      const s = b.storage(0, 0, spec)
      const d = b.storage(0, 1, spec, { writable: true })
      const o = b.storage(0, 2, { items: arrayOf('f32') }, { writable: true })
      b.write(o, ['items', b.mul(i, 3)], b.read(s, 'items', i, 'a'))
      const v = b.read(s, 'items', i, 'b')
      b.write(o, ['items', b.add(b.mul(i, 3), 1)], b.cast(b.pick(v, 'x'), 'f32'))
      b.write(o, ['items', b.add(b.mul(i, 3), 2)], b.cast(b.pick(v, 'y'), 'f32'))
      b.write(d, ['items', i, 'a'], b.add(b.cast(i, 'f32'), 1))
      // A constant index into the final array is clamped the same way.
      b.write(d, ['items', 9, 'b'], b.u32x2(7, 7))
    }, { 0: { bytes: src, offset: 0, size: srcSize }, 1: { bytes: dst, offset: 16, size: dstSize }, 2: whole(out) })
    return { read: f32s(out, 18), dst }
  }
  // 56 bytes hold three elements: invocations 3 to 5 read the third.
  const three = run(56, 40)
  assert.deepEqual(three.read, [0.5, 0, 1, 1.5, 10, 11, 2.5, 20, 21, 2.5, 20, 21, 2.5, 20, 21, 2.5, 20, 21])
  // The destination binding starts 16 bytes in and holds two elements; invocations 1 to 5 all write the second, the
  // last of them winning, and no byte outside the binding changes.
  const dv = new DataView(three.dst.buffer)
  assert.equal(dv.getFloat32(16 + 8, true), 1)
  assert.equal(dv.getFloat32(16 + 8 + 16, true), 6)
  assert.deepEqual([dv.getUint32(16 + 8 + 16 + 8, true), dv.getUint32(16 + 8 + 16 + 12, true)], [7, 7])
  assert.deepEqual([...three.dst.subarray(0, 16)], new Array<number>(16).fill(0xab))
  assert.deepEqual([...three.dst.subarray(56)], new Array<number>(40).fill(0xab))
  // 48 bytes hold two whole elements (the last 8 are not one).
  assert.deepEqual(run(48, 40).read.slice(0, 9), [0.5, 0, 1, 1.5, 10, 11, 1.5, 10, 11])
  // 8 bytes hold none: every read is zero and no write lands.
  const none = run(8, 8)
  assert.deepEqual(none.read, new Array<number>(18).fill(0))
  assert.deepEqual([...none.dst], new Array<number>(96).fill(0xab))
})

test('fixed arrays clamp value-held indices at both ends; grids in a storage block sit in padded columns, read and written', () => {
  const spec = { fixed: arrayOf('f32', 4), g2: 'm2', g3: 'm3' } as const
  assert.deepEqual(layoutBlock(block(spec), 'storage').offsets, [0, 16, 32])
  const src = new Uint8Array(80)
  const sv = new DataView(src.buffer)
  ;[1, 2, 3, 4].forEach((v, k) => sv.setFloat32(k * 4, v, true))
  ;[5, 6, 7, 8].forEach((v, k) => sv.setFloat32(16 + k * 4, v, true))
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) sv.setFloat32(32 + j * 16 + i * 4, 10 * j + i, true)
  const out = new Uint8Array(4 * 4)
  const dst = new Uint8Array(80).fill(0xab)
  compute([4, 1, 1], (b, i) => {
    const s = b.storage(0, 0, spec)
    const o = b.storage(0, 1, { items: arrayOf('f32') }, { writable: true })
    const d = b.storage(0, 2, spec, { writable: true })
    const index = b.sub(b.mul(b.cast(i, 'i32'), 50), 60)
    b.write(o, ['items', i], b.read(s, 'fixed', index))
    b.if(b.eq(i, 0), () => {
      b.write(d, 'g2', b.transpose(b.read(s, 'g2')))
      b.write(d, 'g3', b.mul(b.read(s, 'g3'), 2))
    })
  }, { 0: whole(src), 1: whole(out), 2: whole(dst) })
  // Indices -60, -10, 40 and 90: the first two clamp to 0, the rest to 3.
  assert.deepEqual(f32s(out, 4), [1, 1, 4, 4])
  assert.deepEqual(f32s(dst, 4, 16), [5, 7, 6, 8])
  const g3 = [0, 1, 2, 10, 11, 12, 20, 21, 22].map((v) => 2 * v)
  for (let j = 0; j < 3; j++) {
    assert.deepEqual(f32s(dst, 3, 32 + j * 16), g3.slice(j * 3, j * 3 + 3))
    assert.deepEqual([...dst.subarray(44 + j * 16, 48 + j * 16)], [0xab, 0xab, 0xab, 0xab], 'the padding after each column is left alone')
  }
})

test('a value reaching past the bytes a binding covers reads as zero and is not written; the inline constants read like a uniform block', () => {
  const spec = { scale: 'f32', pad: arrayOf('f32x4', 8), flag: 'u32' } as const
  assert.deepEqual(layoutBlock(block(spec), 'uniform').offsets, [0, 16, 144])
  const bytes = new Uint8Array(148)
  const dv = new DataView(bytes.buffer)
  dv.setFloat32(0, 2.5, true)
  dv.setUint32(144, 99, true)
  const read = (size: number): number[] => {
    const out = new Uint8Array(8)
    compute([1, 1, 1], (b) => {
      const u = b.uniform(0, 0, spec)
      const o = b.storage(0, 1, { items: arrayOf('u32') }, { writable: true })
      b.write(o, ['items', 0], b.bits(b.read(u, 'scale'), 'u32'))
      b.write(o, ['items', 1], b.read(u, 'flag'))
    }, { 0: { bytes, offset: 0, size }, 1: whole(out) })
    return [F(new DataView(out.buffer).getFloat32(0, true)), u32s(out, 1, 4)[0]]
  }
  assert.deepEqual(read(148), [2.5, 99])
  assert.deepEqual(read(100), [2.5, 0])
  const constants = new Uint8Array(16)
  new DataView(constants.buffer).setFloat32(4, -3.25, true)
  const out = new Uint8Array(4)
  compute([1, 1, 1], (b) => {
    const k = b.constants({ a: 'f32', b: 'f32' })
    const o = b.storage(0, 0, { items: arrayOf('f32') }, { writable: true })
    b.write(o, ['items', 0], b.read(k, 'b'))
  }, { 0: whole(constants), 1: whole(out) })
  assert.deepEqual(f32s(out, 1), [-3.25])
})

// ---------------------------------------------------------------------------------------------------
// Images

const NEAREST: SamplerState = Object.freeze({ mag: 'nearest', min: 'nearest', mip: 'nearest', wrap: ['clamp', 'clamp', 'clamp'] as const, lodMin: 0, lodMax: 32 })
const LINEAR: SamplerState = Object.freeze({ mag: 'linear', min: 'linear', mip: 'linear', wrap: ['repeat', 'mirror', 'clamp'] as const, lodMin: 0, lodMax: 32 })

/** A one-channel float image whose texel (x, y) of level l, layer k holds value(x, y, l, k). */
function filled(width: number, height: number, levels: number, layers: number, value: (x: number, y: number, l: number, k: number) => number): ImageStore {
  const s = new ImageStore({ format: 'r32f', width, height, layers, levels, samples: 1 })
  for (let l = 0; l < levels; l++) for (let k = 0; k < layers; k++) for (let y = 0; y < s.levelHeight(l); y++) for (let x = 0; x < s.levelWidth(l); x++) s.write(l, k, x, y, 0, [value(x, y, l, k)])
  return s
}

test('an explicit-level sample is texture.ts\'s sample of the bound view and sampler, lane by lane, layers counted from the view', () => {
  const store = filled(4, 4, 3, 3, (x, y, l, k) => 1000 * k + 100 * l + 10 * y + x)
  const range: ViewRange = { levels: { base: 1, count: 2 }, layers: { base: 1, count: 2 } }
  const next = lcg(5)
  const n = 48
  const coords = new Uint8Array(n * 16)
  const cv = new DataView(coords.buffer)
  const cases = Array.from({ length: n }, (_, i) => {
    const c = [F((next() % 4000) / 1000 - 1.5), F((next() % 4000) / 1000 - 1.5), next() % 3, F((next() % 3000) / 1000 - 0.5)]
    c.forEach((v, k) => (k === 2 ? cv.setUint32(i * 16 + 8, v, true) : cv.setFloat32(i * 16 + k * 4, v, true)))
    return c
  })
  for (const smp of [NEAREST, LINEAR]) {
    const out = new Uint8Array(n * 16)
    compute([n, 1, 1], (b, i) => {
      const src = b.storage(0, 0, { items: arrayOf({ uv: 'f32x2', layer: 'u32', level: 'f32' }) })
      const img = b.image(0, 1, { dims: '2d-array' })
      const s = b.sampler(0, 2)
      const o = b.storage(0, 3, { items: arrayOf('f32x4') }, { writable: true })
      const got = b.sample(img, s, b.read(src, 'items', i, 'uv'), { layer: b.read(src, 'items', i, 'layer'), level: b.read(src, 'items', i, 'level') })
      b.write(o, ['items', i], got)
    }, { 0: whole(coords), 1: { store, view: range }, 2: smp, 3: whole(out) })
    cases.forEach(([u, v, layer, lod], i) => {
      const want: number[] = []
      sample(store, range, smp, u, v, layer, lod, want)
      assert.deepEqual(f32s(out, 4, i * 16), want, `${smp.mag} (${u}, ${v}) layer ${layer} lod ${lod}`)
    })
  }
  // A worked value: level 1 of layer 1 at its texel (1, 0) holds 1000 + 100 + 1.
  const one = new Uint8Array(16)
  compute([1, 1, 1], (b) => {
    const img = b.image(0, 0, { dims: '2d-array' })
    const s = b.sampler(0, 1)
    const o = b.storage(0, 2, { items: arrayOf('f32x4') }, { writable: true })
    b.write(o, ['items', 0], b.sample(img, s, b.f32x2(0.75, 0.25), { layer: 0, level: 0 }))
  }, { 0: { store, view: range }, 1: NEAREST, 2: whole(one) })
  assert.deepEqual(f32s(one, 4), [1101, 0, 0, 1])
})

test('an implicit-level sample takes its level from the uv differences across the quad and the view\'s first level size', () => {
  const store = filled(8, 8, 4, 1, (_x, _y, l) => l)
  const build = (): Program => {
    const b = lens('fragment')
    const k = b.constants({ s: 'f32x4' })
    const img = b.image(0, 0)
    const smp = b.sampler(0, 1)
    const fc = b.builtin('frag-coord')
    const scale = b.read(k, 's')
    const x = b.pick(fc, 'x')
    const y = b.pick(fc, 'y')
    // uv = (x s.x + y s.y, x s.z + y s.w): an arbitrary linear map of the pixel position.
    const uv = b.f32x2(b.add(b.mul(x, b.pick(scale, 'x')), b.mul(y, b.pick(scale, 'y'))), b.add(b.mul(x, b.pick(scale, 'z')), b.mul(y, b.pick(scale, 'w'))))
    b.out(b.output(0, 'f32x4'), b.sample(img, smp, uv))
    b.out(b.output(1, 'f32x2'), uv)
    return compile(b.finish())
  }
  const p = build()
  const at = (s: readonly number[]): RunResult => {
    const constants = new Uint8Array(16)
    s.forEach((v, c) => new DataView(constants.buffer).setFloat32(c * 4, v, true))
    return quad(p, p.bind(bound({ 0: whole(constants), 1: { store, view: view(store) }, 2: NEAREST })), 2, 6)
  }
  // One texel of level 0 per pixel is level of detail 0; two is 1; four is 2.
  for (const [s, level] of [[1 / 8, 0], [2 / 8, 1], [4 / 8, 2]] as const) {
    const r = at([s, 0, 0, s])
    for (let l = 0; l < 4; l++) assert.equal(r.outputs[l * 6], level, `${s}: lane ${l}`)
  }
  // An oblique map on a view starting at level 1 of a 16 x 8 image, so its first level is 8 x 4, filtered linearly
  // between levels: each lane's level comes from its own row's and column's differences, u's and v's in their places
  // (du/dx 0.25, du/dy 0.2, dv/dx 0, dv/dy 0.05), scaled by the view's first level, not the image's.
  const wide = filled(16, 8, 5, 1, (_x, _y, l) => l * 10)
  const shown: ViewRange = { levels: { base: 1, count: 4 }, layers: { base: 0, count: 1 } }
  const constants = new Uint8Array(16)
  ;[0.25, 0.2, 0, 0.05].forEach((v, c) => new DataView(constants.buffer).setFloat32(c * 4, v, true))
  const r = quad(p, p.bind(bound({ 0: whole(constants), 1: { store: wide, view: shown }, 2: LINEAR })), 2, 6)
  const uv = [0, 1, 2, 3].map((l) => [r.outputs[l * 6 + 4], r.outputs[l * 6 + 5]])
  for (let l = 0; l < 4; l++) {
    const row = l & 2
    const col = l & 1
    const lod = lodFromRates(F(uv[row + 1][0] - uv[row][0]), F(uv[row + 1][1] - uv[row][1]), F(uv[col + 2][0] - uv[col][0]), F(uv[col + 2][1] - uv[col][1]), 8, 4)
    const want: number[] = []
    sample(wide, shown, LINEAR, uv[l][0], uv[l][1], 0, lod, want)
    assert.deepEqual([...r.outputs.subarray(l * 6, l * 6 + 4)], want, `lane ${l}`)
    // Along x, u moves 0.25 of 8 texels, 2 texels, more than y's 1.6 or so: level 1 of the view, the image's level 2,
    // holding 20. (With u and v's rates swapped it would be about 1.1; with the image's own width, 2.)
    assert.ok(Math.abs(want[0] - 20) < 0.01, `lane ${l}: ${want[0]}`)
  }
})

test('texel loads read zero outside the view; integer and depth images give their own kinds; put drops what falls outside', () => {
  const uint = new ImageStore({ format: 'r32u', width: 3, height: 2, layers: 1, levels: 2, samples: 1 })
  for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) uint.write(0, 0, x, y, 0, [U32_MAX - (y * 3 + x)])
  uint.write(1, 0, 0, 0, 0, [77])
  const depth = new ImageStore({ format: 'depth32f', width: 2, height: 2, layers: 1, levels: 1, samples: 1 })
  depth.write(0, 0, 1, 1, 0, [0.25])
  const canvas = new ImageStore({ format: 'rgba8', width: 4, height: 4, layers: 1, levels: 1, samples: 1 })
  const at = [[0, 0, 0], [2, 1, 0], [-1, 0, 0], [3, 0, 0], [0, 2, 0], [0, 0, 1], [0, 0, 2], [0, 0, -1]]
  const src = new Uint8Array(at.length * 12)
  at.forEach((v, i) => v.forEach((n, k) => new DataView(src.buffer).setInt32(i * 12 + k * 4, n, true)))
  const out = new Uint8Array(at.length * 16)
  const depths = new Uint8Array(at.length * 4)
  compute([at.length, 1, 1], (b, i) => {
    const s = b.storage(0, 0, { items: arrayOf('i32', at.length * 3) })
    const img = b.image(0, 1, { sample: 'uint' })
    const dimg = b.image(0, 2, { sample: 'depth' })
    const put = b.storageImage(0, 3, 'rgba8')
    const o = b.storage(0, 4, { items: arrayOf('u32x4') }, { writable: true })
    const od = b.storage(0, 5, { items: arrayOf('f32') }, { writable: true })
    const base = b.mul(i, 3)
    const pos = b.i32x2(b.read(s, 'items', base), b.read(s, 'items', b.add(base, 1)))
    const level = b.read(s, 'items', b.add(base, 2))
    b.write(o, ['items', i], b.texel(img, pos, { level }))
    b.write(od, ['items', i], b.texel(dimg, b.i32x2(b.cast(i, 'i32'), b.cast(i, 'i32'))))
    b.put(put, b.i32x2(b.sub(b.cast(i, 'i32'), 2), b.sub(b.cast(i, 'i32'), 2)), b.f32x4(1, 0.5, 0, 1))
  }, { 0: whole(src), 1: { store: uint, view: view(uint) }, 2: { store: depth, view: view(depth) }, 3: { store: canvas, view: view(canvas) }, 4: whole(out), 5: whole(depths) })
  const texels = Array.from({ length: at.length }, (_, i) => u32s(out, 4, i * 16))
  assert.deepEqual(texels, [[U32_MAX, 0, 0, 1], [U32_MAX - 5, 0, 0, 1], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [77, 0, 0, 1], [0, 0, 0, 0], [0, 0, 0, 0]])
  assert.deepEqual(f32s(depths, 8), [0, 0.25, 0, 0, 0, 0, 0, 0])
  // Invocations 2 to 5 put at (0, 0) to (3, 3); the rest fall outside and are dropped.
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const px = [...canvas.bytes.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)]
      assert.deepEqual(px, x === y ? [255, 128, 0, 255] : [0, 0, 0, 0], `(${x}, ${y})`)
    }
  }
})

test('extent: a sampled image\'s level counted from its view\'s first and clamped into the view; a storage image\'s first level', () => {
  const img = new ImageStore({ format: 'rgba8', width: 8, height: 4, layers: 1, levels: 4, samples: 1 })
  const st = new ImageStore({ format: 'r32f', width: 16, height: 8, layers: 2, levels: 3, samples: 1 })
  const levels = [0, 1, 2, 7, -1]
  const src = new Uint8Array(levels.length * 4)
  levels.forEach((v, i) => new DataView(src.buffer).setInt32(i * 4, v, true))
  const out = new Uint8Array(levels.length * 16)
  compute([levels.length, 1, 1], (b, i) => {
    const s = b.storage(0, 0, { items: arrayOf('i32') })
    const im = b.image(0, 1)
    const si = b.storageImage(0, 2, 'r32f')
    const o = b.storage(0, 3, { items: arrayOf('u32x4') }, { writable: true })
    b.write(o, ['items', i], b.u32x4(b.extent(im, b.read(s, 'items', i)), b.extent(si)))
  }, {
    0: whole(src),
    // The view shows levels 1 and 2 (4 x 2, 2 x 1) of four; the storage view's first level is level 1 (8 x 4).
    1: { store: img, view: { levels: { base: 1, count: 2 }, layers: { base: 0, count: 1 } } },
    2: { store: st, view: { levels: { base: 1, count: 1 }, layers: { base: 1, count: 1 } } },
    3: whole(out),
  })
  const got = Array.from({ length: levels.length }, (_, i) => u32s(out, 4, i * 16))
  // Levels 2 and 7 clamp to the view's last level, 2 x 1, not the store's level 3 (1 x 1) beyond the view.
  assert.deepEqual(got, [[4, 2, 8, 4], [2, 1, 8, 4], [2, 1, 8, 4], [2, 1, 8, 4], [4, 2, 8, 4]])
})

// ---------------------------------------------------------------------------------------------------
// Steps, budgets and dispatch

test('the step budget: one step per lane started, per instruction per running lane, per loop iteration per lane; past it, a bound Fault', () => {
  const b = lens('compute', { group: [4, 1, 1] })
  const out = b.storage(0, 0, { items: arrayOf('u32') }, { writable: true })
  const i = b.builtin('local-index')
  b.if(b.lt(i, 1), () => b.write(out, ['items', i], 5))
  const m: LensModule = b.finish()
  // builtin, lit, lt, if: four instructions for four lanes; then lit and write for lane 0 alone.
  assert.equal(m.body.length, 4)
  const p = compile(m)
  const bytes = new Uint8Array(16)
  const bindings = p.bind(bound({ 0: whole(bytes) }))
  const batch = { lanes: 4, builtins: { 'local-index': [0, 1, 2, 3] } }
  const expected = 4 + 4 * 4 + 2
  assert.equal(p.run(batch, bindings, BUDGET).steps, expected)
  assert.equal(p.run(batch, bindings, expected).steps, expected)
  faults(() => p.run(batch, bindings, expected - 1), 'bound', /compute program ran past its budget of 21 steps/)
  faults(() => p.run(batch, bindings, 0), 'bound')
  assert.equal(dispatch(p, bindings, [3, 1, 1], 3 * expected), 3 * expected, 'a dispatch shares one budget')
  faults(() => dispatch(p, bindings, [3, 1, 1], 3 * expected - 1), 'bound')
  assert.equal(dispatch(p, bindings, [0, 1, 1], 0), 0, 'an empty dispatch takes no steps')
  // A loop counts each iteration for each lane in it, and the instructions of its body.
  const c = lens('compute')
  const n = c.var('u32', 0)
  c.loop(() => {
    c.if(c.ge(c.get(n), 3), () => c.break())
    c.set(n, c.add(c.get(n), 1))
  })
  const q = compile(c.finish())
  // Entry 1; lit, var and loop 3; four iterations of 1 + (get, lit, ge, if); in three of them (get, lit, add, set),
  // and in the last a break.
  assert.equal(dispatch(q, q.bind(NONE), [1, 1, 1]), 1 + 3 + 4 * 5 + 3 * 4 + 1)
  // Loops nested two deep would run 2^32 iterations: the budget stops them at once.
  const d = lens('compute')
  d.loop(() => d.loop(() => d.continue()))
  const deep = compile(d.finish())
  faults(() => dispatch(deep, deep.bind(NONE), [1, 1, 1], 1e6), 'bound')
  assert.equal(DEFAULT_BUDGET, 2 ** 30)
})

test('dispatch gives every invocation its global, local and group ids, its local index and the group count, in batches of four', () => {
  const group = [3, 2, 1] as const
  const groups = [2, 1, 2] as const
  const total = 3 * 2 * 2 * 1 * 2
  const out = new Uint8Array(total * 13 * 4)
  const steps = compute(group, (b) => {
    const o = b.storage(0, 0, { items: arrayOf('u32') }, { writable: true })
    const g = b.builtin('global-id')
    const at = b.mul(b.add(b.pick(g, 'x'), b.mul(b.add(b.pick(g, 'y'), b.mul(b.pick(g, 'z'), 2)), 6)), 13)
    const vals = [g, b.builtin('local-id'), b.builtin('group-id'), b.builtin('group-count')]
    vals.forEach((v, k) => [0, 1, 2].forEach((c) => b.write(o, ['items', b.add(at, k * 3 + c)], b.pick(v, [c]))))
    b.write(o, ['items', b.add(at, 12)], b.builtin('local-index'))
  }, { 0: whole(out) }, groups)
  assert.ok(steps > 0)
  for (let z = 0; z < 2; z++) {
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 6; x++) {
        const lid = [x % 3, y % 2, 0]
        const gid = [Math.floor(x / 3), Math.floor(y / 2), z]
        const at = (x + (y + z * 2) * 6) * 13
        assert.deepEqual(u32s(out, 13, at * 4), [x, y, z, ...lid, ...gid, 2, 1, 2, lid[0] + lid[1] * 3], `(${x}, ${y}, ${z})`)
      }
    }
  }
})

test('lanes are independent: a batch of four gives each lane what it gives alone, and runs repeat exactly', () => {
  const b = lens('vertex')
  const x = b.input(0, 'f32x2')
  const k = b.input(1, 'i32')
  const acc = b.var('f32', 0)
  const n = b.var('i32', 0)
  b.loop(() => {
    b.if(b.ge(b.get(n), k), () => b.break())
    b.set(acc, b.add(b.mul(b.get(acc), b.pick(x, 'x')), b.pick(x, 'y')))
    b.set(n, b.add(b.get(n), 1))
  })
  b.out(b.output(0, 'f32'), b.get(acc))
  const p = compile(b.finish())
  const bindings = p.bind(NONE)
  const next = lcg(9)
  const rows = Array.from({ length: 16 }, () => [F((next() % 1000) / 300), F((next() % 1000) / 700 - 0.5), next() % 12])
  const together: number[] = []
  for (let first = 0; first < 16; first += 4) {
    const r = p.run({ lanes: 4, inputs: rows.slice(first, first + 4).flat() }, bindings, BUDGET)
    together.push(...r.outputs)
  }
  const alone = rows.map((row) => p.run({ lanes: 1, inputs: row }, bindings, BUDGET).outputs[0])
  assert.deepEqual(together, alone)
  const again = rows.map((row) => p.run({ lanes: 1, inputs: row }, bindings, BUDGET).outputs[0])
  assert.deepEqual(again, alone)
  const result = p.run({ lanes: 1, inputs: rows[0] }, bindings, BUDGET)
  assert.equal(p.run({ lanes: 1, inputs: rows[1] }, bindings, BUDGET), result, 'the result object is the program\'s own, reused')
})

// ---------------------------------------------------------------------------------------------------
// Refusals

test('compile refuses a module verify refuses, and lays out its ports in slot order', () => {
  faults(() => compile({ stage: 'compute', group: [1, 1, 1], inputs: [], outputs: [], resources: [], body: [{ op: 'break' }], ids: 0 }), 'lens', /break is only inside a loop/)
  faults(() => compile(null as unknown as LensModule), 'lens')
  const b = lens('fragment')
  b.input(3, 'f32x3')
  b.input(1, 'u32x2')
  b.output(0, 'f32x4')
  const p = compile(b.finish())
  assert.deepEqual(p.inputs, [{ slot: 1, type: 'u32x2', flat: true, offset: 0, size: 2 }, { slot: 3, type: 'f32x3', flat: false, offset: 2, size: 3 }])
  assert.equal(p.inputWidth, 5)
  assert.equal(p.outputWidth, 4)
  assert.equal(p.stage, 'fragment')
  assert.deepEqual(p.group, [1, 1, 1])
})

test('run refuses a malformed batch, bindings it did not make and a bad budget, always with a Fault', () => {
  const b = lens('vertex')
  b.out(b.output(0, 'f32x2'), b.input(0, 'f32x2'))
  b.out(b.output(1, 'u32'), b.builtin('vertex-index'))
  const p = compile(b.finish())
  const ok = p.bind(NONE)
  const good = { lanes: 2, inputs: [1, 2, 3, 4], builtins: { 'vertex-index': [0, 1] } }
  assert.deepEqual([...p.run(good, ok, BUDGET).outputs.subarray(0, 6)], [1, 2, 0, 3, 4, 1])
  faults(() => p.run(null as never, ok, BUDGET), 'invalid', /the batch is an object/)
  faults(() => p.run([] as never, ok, BUDGET), 'invalid')
  for (const lanes of [0, 5, 1.5, '2', undefined]) faults(() => p.run({ ...good, lanes } as never, ok, BUDGET), 'invalid', /a batch runs 1 to 4 lanes/)
  faults(() => p.run({ ...good, helpers: 1 }, ok, BUDGET), 'invalid', /only a fragment batch has helper lanes/)
  faults(() => p.run({ ...good, helpers: 4 }, ok, BUDGET), 'invalid', /mask of the batch's 2 lanes/)
  faults(() => p.run({ ...good, inputs: [1, 2, 3] }, ok, BUDGET), 'invalid', /hold 3 numbers, and 2 lanes of 2 need 4/)
  faults(() => p.run({ ...good, inputs: [1, 2, '3', 4] as never }, ok, BUDGET), 'invalid', /not a number/)
  faults(() => p.run({ ...good, inputs: 5 as never }, ok, BUDGET), 'invalid', /a list of numbers/)
  faults(() => p.run({ lanes: 2, inputs: [1, 2, 3, 4] }, ok, BUDGET), 'invalid', /gives no builtins/)
  faults(() => p.run({ ...good, builtins: {} }, ok, BUDGET), 'invalid', /builtin vertex-index/)
  const hostile = { lanes: 2, get inputs(): never { throw new RangeError('no') }, builtins: good.builtins }
  faults(() => p.run(hostile, ok, BUDGET), 'invalid', /could not be read/)
  faults(() => p.run(good, ok, -1), 'invalid', /the budget/)
  faults(() => p.run(good, ok, NaN), 'invalid', /the budget/)
  faults(() => p.run(good, ok, '9' as never), 'invalid', /the budget/)
  faults(() => p.run(good, { program: p }, BUDGET), 'invalid', /not ones a program's bind\(\) made/)
  faults(() => p.run(good, null as never, BUDGET), 'invalid')
  const other = compile(lens('vertex').finish())
  faults(() => p.run(good, other.bind(NONE), BUDGET), 'mismatch', /another program/)
  // A fragment batch is a whole quad.
  const f = lens('fragment')
  f.out(f.output(0, 'f32'), 1)
  const fp = compile(f.finish())
  faults(() => fp.run({ lanes: 3 }, fp.bind(NONE), BUDGET), 'invalid', /2 x 2 quad of 4 lanes, not 3/)
  assert.deepEqual([...fp.run({ lanes: 4, helpers: 0b1111 }, fp.bind(NONE), BUDGET).outputs], [0, 0, 0, 0], 'helpers write nothing')
})

test('bind refuses missing, malformed and mismatched resources; dispatch refuses what it cannot run', () => {
  const b = lens('compute')
  const u = b.uniform(0, 0, { a: 'f32' })
  const img = b.image(0, 1)
  const smp = b.sampler(0, 2)
  const si = b.storageImage(1, 0, 'rgba8')
  const o = b.storage(1, 1, { items: arrayOf('f32x4') }, { writable: true })
  b.write(o, ['items', 0], b.add(b.sample(img, smp, b.f32x2(0, 0), { level: b.read(u, 'a') }), b.f32x4(b.cast(b.extent(si), 'f32'), 0, 0)))
  const p = compile(b.finish())
  const rgba = new ImageStore({ format: 'rgba8', width: 2, height: 2, layers: 2, levels: 1, samples: 1 })
  const one: ViewRange = { levels: { base: 0, count: 1 }, layers: { base: 0, count: 1 } }
  const good = { 0: whole(new Uint8Array(4)), 1: { store: rgba, view: one }, 2: NEAREST, 3: { store: rgba, view: one }, 4: whole(new Uint8Array(16)) }
  const bindings = p.bind(bound(good))
  assert.equal(bindings.program, p)
  assert.ok(dispatch(p, bindings, [1, 1, 1]) > 0)
  const swap = (res: number, v: unknown): Resources => bound({ ...good, [res]: v as BlockBinding })
  faults(() => p.bind(null as never), 'invalid', /the resources are an object/)
  faults(() => p.bind({ ...NONE, block: undefined } as never), 'invalid', /resource 0, the uniform block at set 0 binding 0: the resources have no block\(\)/)
  faults(() => p.bind(NONE), 'invalid', /resource 0, the uniform block at set 0 binding 0: nothing is bound to it/)
  faults(() => p.bind(swap(0, { bytes: new Uint8Array(4), offset: 2, size: 4 })), 'invalid', /a block binding is/)
  faults(() => p.bind(swap(0, { bytes: [0, 0, 0, 0], offset: 0, size: 4 })), 'invalid', /a block binding is/)
  faults(() => p.bind(swap(0, { bytes: new Uint8Array(4), offset: -1, size: 4 })), 'invalid', /a block binding is/)
  faults(() => p.bind(swap(1, { store: {}, view: one })), 'invalid', /resource 1, the image at set 0 binding 1: an image binding is/)
  faults(() => p.bind(swap(1, { store: rgba, view: { levels: { base: 0, count: 2 }, layers: { base: 0, count: 1 } } })), 'invalid', /levels must be a range/)
  faults(() => p.bind(swap(1, { store: rgba, view: { levels: { base: 0, count: 1 }, layers: { base: 1, count: 0 } } })), 'invalid', /layers must be a range/)
  faults(() => p.bind(swap(1, { store: rgba, view: view(rgba) })), 'mismatch', /a 2d image is a view of one layer, not of 2/)
  const uint = new ImageStore({ format: 'r32u', width: 2, height: 2, layers: 1, levels: 1, samples: 1 })
  faults(() => p.bind(swap(1, { store: uint, view: one })), 'mismatch', /reads float values, and a r32u image holds uint values/)
  const ms = new ImageStore({ format: 'rgba8', width: 2, height: 2, layers: 1, levels: 1, samples: 4 })
  faults(() => p.bind(swap(1, { store: ms, view: one })), 'mismatch', /one-sample images, not a 4-sample one/)
  faults(() => p.bind(swap(2, { ...NEAREST, mag: 'cubic' })), 'invalid', /resource 2, the sampler at set 0 binding 2: a sampler has/)
  faults(() => p.bind(swap(2, { ...NEAREST, wrap: ['clamp', 'clamp'] })), 'invalid', /a sampler has/)
  faults(() => p.bind(swap(2, { ...NEAREST, lodMin: 3, lodMax: 1 })), 'invalid', /lodMin no greater than lodMax/)
  faults(() => p.bind(swap(2, 7)), 'invalid', /a sampler is an object/)
  const r32f = new ImageStore({ format: 'r32f', width: 2, height: 2, layers: 1, levels: 1, samples: 1 })
  faults(() => p.bind(swap(3, { store: r32f, view: one })), 'mismatch', /storage image at set 1 binding 0: it is declared rgba8, and the bound image is r32f/)
  const throwing: Resources = { ...bound(good), image: () => { throw new TypeError('no') } }
  faults(() => p.bind(throwing), 'invalid', /could not be read/)
  faults(() => dispatch({ ...p }, bindings, [1, 1, 1]), 'invalid', /not one compile\(\) made/)
  faults(() => dispatch(p, bindings, [1, 1] as never), 'invalid', /three whole numbers from 0 to 65535/)
  faults(() => dispatch(p, bindings, [1, 65536, 1]), 'invalid', /three whole numbers/)
  faults(() => dispatch(p, bindings, [1, -1, 1]), 'invalid', /three whole numbers/)
  faults(() => dispatch(p, bindings, [1, 1, 1], -5), 'invalid', /the budget/)
  const v = lens('vertex')
  v.position(v.f32x4(0, 0, 0, 1))
  const vp = compile(v.finish())
  faults(() => dispatch(vp, vp.bind(NONE), [1, 1, 1]), 'invalid', /a vertex program is not dispatched/)
})

test('compile lays out each block object once, however many reads reach it, so its work stays within what verify bounds', () => {
  // Shared blocks of eight fields, three deep under an array. Only laying a block out reads its last field's type
  // (no path here steps into it), so those reads count the layouts compile makes.
  let layouts = 0
  const blockOf = (inner: unknown): Block => ({
    fields: Array.from({ length: 8 }, (_, i) => {
      const f = { name: `f${i}` } as { name: string; type: Block['fields'][number]['type'] }
      Object.defineProperty(f, 'type', { enumerable: true, get: () => { if (i === 7) layouts++; return inner } })
      return f
    }),
  })
  const top = blockOf({ array: { struct: blockOf({ struct: blockOf('f32') }) }, len: 4 })
  const reads = (n: number): LensModule => ({
    stage: 'compute', group: [1, 1, 1], inputs: [], outputs: [],
    resources: [{ kind: 'storage', set: 0, binding: 0, writable: false, block: top }],
    body: Array.from({ length: n }, (_, id) => ({ op: 'read', id, t: 'f32', res: 0, path: [0, 3, 0, 0] })),
    ids: n,
  })
  const cost = (n: number): number => {
    layouts = 0
    compile(reads(n))
    return layouts
  }
  // verify() walks one path once, and compile lays each block out once: 2,000 reads cost what 2 do.
  assert.equal(cost(2000), cost(2))
})
