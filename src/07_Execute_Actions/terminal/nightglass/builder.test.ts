// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the Lens builder: every unary, binary and ternary function builds exactly the
 * instruction and result type the specification's table gives, and is refused with the table's rule where it does
 * not apply; numbers and booleans stand in for literals of the type each place needs; literals round or refuse as
 * documented; ports, builtins, resources, paths by field name, sampling, variables and structured control emit the
 * instructions they should, and every misuse (wrong stage, wrong scope, a value of another builder, junk arguments,
 * use after finish) is a Fault of code `lens` naming the place the instruction would take. A whole vertex shader is
 * pinned instruction by instruction, and finish() is shown to deep-freeze and verify.
 * What breaks if it is removed? The UI kit and every shader test lean on the builder; a wrong inferred type or a
 * mistake let through would surface far from where it was written, or not at all.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decode, encode } from './binary.ts'
import { LensBuilder, arrayOf, block, lens } from './builder.ts'
import type { BlockSpec, FieldSpec, Val } from './builder.ts'
import { isFault } from './fault.ts'
import { BINARY, LENS_LIMITS, TERNARY, UNARY, VALUE_TYPES, scalarOf, varBytesOf } from './lens.ts'
import type { BinaryFn, Block, Inst, LensModule, TernaryFn, UnaryFn, ValueType } from './lens.ts'

/** Asserts a lens Fault whose message matches. */
function refused(f: () => unknown, re: RegExp): void {
  assert.throws(f, (e: unknown) => {
    assert.ok(isFault(e, 'lens'), `expected a lens Fault, got ${String(e)}`)
    assert.match(e.message, re)
    return true
  })
}

/** A value of type t, made as a zero literal. */
const zero = (b: LensBuilder, t: ValueType): Val => b.lit(t, scalarOf(t) === 'bool' ? false : 0)
const last = (m: LensModule): Inst => m.body[m.body.length - 1]

test('a vertex shader is built instruction by instruction, with ids in order and types inferred', () => {
  const b = lens('vertex')
  const pos = b.input(0, 'f32x3')
  const id = b.input(1, 'u32')
  const uvOut = b.output(0, 'f32x2')
  const idOut = b.output(1, 'u32')
  const u = b.uniform(0, 0, { xform: 'm4', tint: 'f32x4' })
  const clip = b.mul(b.read(u, 'xform'), b.f32x4(pos, 1))
  b.position(clip)
  b.out(idOut, id)
  b.out(uvOut, b.pick(pos, 'xy'))
  const m = b.finish()
  assert.deepEqual(m, {
    stage: 'vertex',
    group: [1, 1, 1],
    inputs: [{ slot: 0, type: 'f32x3' }, { slot: 1, type: 'u32' }],
    outputs: [{ slot: 0, type: 'f32x2' }, { slot: 1, type: 'u32', flat: true }],
    resources: [{ kind: 'uniform', set: 0, binding: 0, block: { fields: [{ name: 'xform', type: 'm4' }, { name: 'tint', type: 'f32x4' }] } }],
    body: [
      { op: 'in', id: 0, t: 'f32x3', slot: 0 },
      { op: 'in', id: 1, t: 'u32', slot: 1 },
      { op: 'read', id: 2, t: 'm4', res: 0, path: [0] },
      { op: 'lit', id: 3, t: 'f32', v: [1] },
      { op: 'make', id: 4, t: 'f32x4', args: [0, 3] },
      { op: 'binary', id: 5, t: 'f32x4', fn: 'mul', a: 2, b: 4 },
      { op: 'position', a: 5 },
      { op: 'out', slot: 1, a: 1 },
      { op: 'pick', id: 6, t: 'f32x2', a: 0, lanes: [0, 1] },
      { op: 'out', slot: 0, a: 6 },
    ],
    ids: 7,
  })
  assert.equal(b.ids, 7)
  assert.deepEqual([pos, clip], [{ id: 0, t: 'f32x3' }, { id: 5, t: 'f32x4' }])
})

const UNARY_OK: readonly [UnaryFn, ValueType, ValueType][] = [
  ['neg', 'f32x3', 'f32x3'], ['neg', 'i32', 'i32'], ['not', 'boolx2', 'boolx2'], ['not', 'bool', 'bool'], ['bitnot', 'u32x4', 'u32x4'],
  ['bitnot', 'i32', 'i32'], ['abs', 'u32', 'u32'], ['abs', 'f32x2', 'f32x2'], ['sign', 'i32x2', 'i32x2'], ['sign', 'f32', 'f32'],
  ['floor', 'f32', 'f32'], ['ceil', 'f32x2', 'f32x2'], ['round', 'f32x3', 'f32x3'], ['trunc', 'f32x4', 'f32x4'], ['fract', 'f32', 'f32'],
  ['sqrt', 'f32', 'f32'], ['rsqrt', 'f32x2', 'f32x2'], ['exp', 'f32', 'f32'], ['exp2', 'f32x3', 'f32x3'], ['log', 'f32', 'f32'],
  ['log2', 'f32x4', 'f32x4'], ['sin', 'f32', 'f32'], ['cos', 'f32x2', 'f32x2'], ['tan', 'f32', 'f32'], ['asin', 'f32', 'f32'],
  ['acos', 'f32x3', 'f32x3'], ['atan', 'f32', 'f32'], ['saturate', 'f32x4', 'f32x4'], ['length', 'f32x3', 'f32'], ['length', 'f32', 'f32'],
  ['normalize', 'f32x2', 'f32x2'], ['any', 'boolx3', 'bool'], ['all', 'bool', 'bool'], ['transpose', 'm3', 'm3'],
]

const UNARY_BAD: readonly [UnaryFn, ValueType, RegExp][] = [
  ['neg', 'u32', /neg takes an f32 or i32 scalar or vector, not u32/], ['neg', 'm2', /not m2/], ['not', 'f32', /not takes a bool or bool vector/],
  ['bitnot', 'f32', /bitnot takes an i32 or u32/], ['abs', 'bool', /abs takes an f32, i32 or u32/], ['sign', 'u32x2', /sign takes an f32 or i32/],
  ['sqrt', 'i32', /sqrt takes an f32 scalar or vector, not i32/], ['sin', 'm4', /sin takes an f32 scalar or vector, not m4/],
  ['length', 'i32x2', /length takes an f32 scalar or vector/], ['normalize', 'f32', /normalize takes an f32 vector, not f32/],
  ['any', 'u32', /any takes a bool or bool vector/], ['transpose', 'f32x4', /transpose takes a grid/],
]

test('every unary function builds its instruction with the table\'s result type, and refuses what it does not take', () => {
  assert.deepEqual(new Set(UNARY_OK.map(([fn]) => fn)), new Set(UNARY))
  for (const [fn, t, r] of UNARY_OK) {
    const b = lens('compute')
    const a = zero(b, t)
    const v = b.unary(fn, a)
    assert.equal(v.t, r, `${fn} ${t}`)
    assert.deepEqual(last(b.finish()), { op: 'unary', id: v.id, t: r, fn, a: a.id })
  }
  for (const [fn, t, re] of UNARY_BAD) {
    const b = lens('compute')
    const a = zero(b, t)
    refused(() => b.unary(fn, a), new RegExp(`^lens: body\\[1\\] unary: .*${re.source}`))
  }
  // The sugar names are the same instructions.
  const b = lens('compute')
  const x = zero(b, 'f32x3')
  assert.deepEqual([b.sqrt(x).t, b.length(x).t, b.normalize(x).t, b.neg(x).t, b.abs(x).t, b.fract(x).t], ['f32x3', 'f32', 'f32x3', 'f32x3', 'f32x3', 'f32x3'])
  refused(() => b.unary('cube' as never, x), /lens: body\[7\] unary: "cube" is not a unary function/)
})

const BINARY_OK: readonly [BinaryFn, ValueType, ValueType, ValueType][] = [
  ['add', 'f32x3', 'f32x3', 'f32x3'], ['add', 'f32x3', 'f32', 'f32x3'], ['add', 'i32', 'i32x4', 'i32x4'], ['add', 'm2', 'm2', 'm2'],
  ['sub', 'u32x2', 'u32', 'u32x2'], ['sub', 'm3', 'm3', 'm3'], ['mul', 'm4', 'm4', 'm4'], ['mul', 'm4', 'f32x4', 'f32x4'],
  ['mul', 'f32x3', 'm3', 'f32x3'], ['mul', 'm2', 'f32', 'm2'], ['mul', 'f32x2', 'f32', 'f32x2'], ['div', 'f32', 'f32x2', 'f32x2'],
  ['div', 'i32x3', 'i32', 'i32x3'], ['rem', 'u32', 'u32', 'u32'], ['min', 'f32x2', 'f32x2', 'f32x2'], ['max', 'i32', 'i32', 'i32'],
  ['pow', 'f32x3', 'f32x3', 'f32x3'], ['atan2', 'f32', 'f32', 'f32'], ['step', 'f32x4', 'f32x4', 'f32x4'], ['and', 'u32x2', 'u32x2', 'u32x2'],
  ['and', 'boolx2', 'boolx2', 'boolx2'], ['or', 'i32', 'i32', 'i32'], ['xor', 'bool', 'bool', 'bool'], ['shl', 'i32x3', 'u32x3', 'i32x3'],
  ['shr', 'u32', 'u32', 'u32'], ['eq', 'boolx2', 'boolx2', 'boolx2'], ['ne', 'f32', 'f32', 'bool'], ['lt', 'u32x4', 'u32x4', 'boolx4'],
  ['le', 'i32', 'i32', 'bool'], ['gt', 'f32x2', 'f32x2', 'boolx2'], ['ge', 'f32', 'f32', 'bool'], ['land', 'boolx3', 'boolx3', 'boolx3'],
  ['lor', 'bool', 'bool', 'bool'], ['dot', 'f32x3', 'f32x3', 'f32'], ['dot', 'i32x2', 'i32x2', 'i32'], ['cross', 'f32x3', 'f32x3', 'f32x3'],
  ['distance', 'f32x2', 'f32x2', 'f32'], ['reflect', 'f32x3', 'f32x3', 'f32x3'],
]

const BINARY_BAD: readonly [BinaryFn, ValueType, ValueType, RegExp][] = [
  ['add', 'f32x3', 'f32x2', /add takes two numbers of one type/], ['add', 'f32x3', 'i32', /not f32x3 and i32/], ['add', 'm2', 'm3', /add takes/],
  ['add', 'm2', 'f32', /add takes/], ['add', 'bool', 'bool', /add takes/], ['mul', 'f32', 'm4', /a grid and then an f32, not f32 and m4/],
  ['mul', 'm4', 'f32x3', /mul takes/], ['mul', 'm3', 'f32x4', /mul takes/], ['div', 'm2', 'm2', /div takes two numbers of one type, or a vector and a scalar/],
  ['min', 'f32x3', 'f32', /min takes two numbers of one type, not f32x3 and f32/], ['pow', 'i32', 'i32', /pow takes two f32 values/],
  ['and', 'f32', 'f32', /and takes two integers or two bools/], ['shl', 'i32', 'i32', /shl takes an integer and then a u32 count of the same width/],
  ['shr', 'u32x2', 'u32', /u32 count of the same width/], ['eq', 'm2', 'm2', /eq takes two scalars or vectors of one type/],
  ['eq', 'f32', 'i32', /eq takes/], ['lt', 'bool', 'bool', /lt takes two numbers of one type/], ['land', 'u32', 'u32', /land takes two bools/],
  ['dot', 'f32', 'f32', /dot takes two number vectors/], ['cross', 'f32x4', 'f32x4', /cross takes two f32x3/],
  ['distance', 'i32x2', 'i32x2', /distance takes two f32 values/], ['reflect', 'f32', 'f32', /reflect takes two f32 vectors/],
]

test('every binary function builds its instruction with the table\'s result type, and refuses what it does not take', () => {
  assert.deepEqual(new Set(BINARY_OK.map(([fn]) => fn)), new Set(BINARY))
  for (const [fn, ta, tb, r] of BINARY_OK) {
    const b = lens('compute')
    const a = zero(b, ta)
    const c = zero(b, tb)
    const v = b.binary(fn, a, c)
    assert.equal(v.t, r, `${fn} ${ta} ${tb}`)
    assert.deepEqual(last(b.finish()), { op: 'binary', id: v.id, t: r, fn, a: a.id, b: c.id })
  }
  for (const [fn, ta, tb, re] of BINARY_BAD) {
    const b = lens('compute')
    const a = zero(b, ta)
    const c = zero(b, tb)
    refused(() => b.binary(fn, a, c), new RegExp(`^lens: body\\[2\\] binary: .*${re.source}`))
  }
  const b = lens('compute')
  const x = zero(b, 'i32x2')
  const n = zero(b, 'u32x2')
  assert.deepEqual([b.add(x, x), b.sub(x, x), b.min(x, x), b.shl(x, n), b.shr(x, n), b.lt(x, x), b.dot(x, x)].map((v) => v.t), ['i32x2', 'i32x2', 'i32x2', 'i32x2', 'i32x2', 'boolx2', 'i32'])
  refused(() => b.binary('hypot' as never, x, x), /binary: "hypot" is not a binary function/)
})

const TERNARY_OK: readonly [TernaryFn, ValueType, ValueType, ValueType, ValueType][] = [
  ['mix', 'f32x3', 'f32x3', 'f32x3', 'f32x3'], ['mix', 'f32x3', 'f32x3', 'f32', 'f32x3'], ['clamp', 'i32x2', 'i32x2', 'i32x2', 'i32x2'],
  ['smoothstep', 'f32', 'f32', 'f32', 'f32'], ['fma', 'f32x4', 'f32x4', 'f32x4', 'f32x4'], ['choose', 'bool', 'f32x3', 'f32x3', 'f32x3'],
  ['choose', 'boolx3', 'u32x3', 'u32x3', 'u32x3'], ['choose', 'bool', 'm2', 'm2', 'm2'],
]

const TERNARY_BAD: readonly [TernaryFn, ValueType, ValueType, ValueType, RegExp][] = [
  ['mix', 'f32x3', 'f32x3', 'f32x2', /mix takes two f32 values of one type and a factor/], ['mix', 'i32', 'i32', 'i32', /mix takes/],
  ['clamp', 'f32', 'f32', 'i32', /clamp takes three numbers of one type/], ['smoothstep', 'i32', 'i32', 'i32', /smoothstep takes three f32 values/],
  ['fma', 'f32x2', 'f32x2', 'f32', /fma takes three f32 values/], ['choose', 'boolx2', 'f32x3', 'f32x3', /choose takes a bool/],
  ['choose', 'bool', 'f32', 'i32', /choose takes/], ['choose', 'boolx2', 'm2', 'm2', /choose takes/],
]

test('every ternary function builds its instruction with the table\'s result type, and refuses what it does not take', () => {
  assert.deepEqual(new Set(TERNARY_OK.map(([fn]) => fn)), new Set(TERNARY))
  for (const [fn, ta, tb, tc, r] of TERNARY_OK) {
    const b = lens('compute')
    const [x, y, z] = [zero(b, ta), zero(b, tb), zero(b, tc)]
    const v = b.ternary(fn, x, y, z)
    assert.equal(v.t, r)
    assert.deepEqual(last(b.finish()), { op: 'ternary', id: v.id, t: r, fn, a: x.id, b: y.id, c: z.id })
  }
  for (const [fn, ta, tb, tc, re] of TERNARY_BAD) {
    const b = lens('compute')
    const [x, y, z] = [zero(b, ta), zero(b, tb), zero(b, tc)]
    refused(() => b.ternary(fn, x, y, z), new RegExp(`^lens: body\\[3\\] ternary: .*${re.source}`))
  }
  const b = lens('compute')
  const f = zero(b, 'f32x2')
  assert.deepEqual([b.mix(f, f, f), b.clamp(f, f, f), b.smoothstep(f, f, f), b.fma(f, f, f), b.choose(b.bool(true), f, f)].map((v) => v.t), ['f32x2', 'f32x2', 'f32x2', 'f32x2', 'f32x2'])
  refused(() => b.ternary('lerp' as never, f, f, f), /ternary: "lerp" is not a ternary function/)
})

test('numbers and booleans stand in for literals of the type their place needs', () => {
  const b = lens('compute')
  const i = zero(b, 'i32')
  const v3 = zero(b, 'f32x3')
  const iv = zero(b, 'i32x2')
  const c = zero(b, 'bool')
  const u = zero(b, 'u32')
  const g = zero(b, 'm2')
  const lits = (): Inst[] => b.finish().body.filter((x) => x.op === 'lit').slice(6)
  assert.equal(b.add(i, 1).t, 'i32')
  assert.equal(b.mul(v3, 2).t, 'f32x3')
  assert.equal(b.min(v3, 0).t, 'f32x3')
  assert.equal(b.shl(iv, 3).t, 'i32x2')
  assert.equal(b.add(1, 2).t, 'f32')
  assert.equal(b.choose(true, 1, 0).t, 'f32')
  assert.equal(b.choose(c, i, 0).t, 'i32')
  assert.equal(b.mix(v3, v3, 0.5).t, 'f32x3')
  assert.equal(b.clamp(u, 0, 10).t, 'u32')
  assert.equal(b.land(c, true).t, 'bool')
  assert.equal(b.mul(g, 2).t, 'm2')
  assert.equal(b.sin(0.5).t, 'f32')
  assert.equal(b.sub(10, u).t, 'u32')
  assert.deepEqual(lits().map((x) => (x.op === 'lit' ? [x.t, x.v] : [])), [
    ['i32', [1]], ['f32', [2]], ['f32x3', [0, 0, 0]], ['u32x2', [3, 3]], ['f32', [1]], ['f32', [2]], ['bool', [1]], ['f32', [1]], ['f32', [0]],
    ['i32', [0]], ['f32', [0.5]], ['u32', [0]], ['u32', [10]], ['bool', [1]], ['f32', [2]], ['f32', [0.5]], ['u32', [10]],
  ])
  const b2 = lens('compute')
  const w = zero(b2, 'f32x2')
  refused(() => b2.add(w, true), /lens: body\[1\] binary: f32 values are written as numbers, not true/)
  refused(() => b2.choose(1, w, w), /lens: body\[1\] ternary: bool values are written true or false, not 1/)
  refused(() => b2.mul(2, b2.lit('m2', 1, 0, 0, 1)), /mul takes .* not f32 and m2/)
})

test('literals: f32 rounds to binary32, integers must be whole and in range, -0 becomes 0, one component may repeat', () => {
  const b = lens('compute')
  const vals = [b.f32(0.1), b.i32(-0), b.u32(0xffffffff), b.i32(-0x80000000), b.bool(true), b.lit('f32x3', 1), b.lit('boolx2', true, false), b.lit('m2', 1, 2, 3, 4)]
  const m = b.finish()
  assert.deepEqual(m.body.map((x) => (x.op === 'lit' ? x.v : [])), [[Math.fround(0.1)], [0], [0xffffffff], [-0x80000000], [1], [1, 1, 1], [1, 0], [1, 2, 3, 4]])
  assert.ok(m.body[1].op === 'lit' && Object.is(m.body[1].v[0], 0))
  assert.deepEqual(vals.map((v) => v.t), ['f32', 'i32', 'u32', 'i32', 'bool', 'f32x3', 'boolx2', 'm2'])
  const c = lens('compute')
  refused(() => c.f32(1e39), /lens: body\[0\] lit: f32 values are finite numbers within the range of f32, not 1e\+39/)
  refused(() => c.f32(Number.NaN), /f32 values are finite numbers/)
  refused(() => c.f32(-Infinity), /f32 values are finite numbers/)
  refused(() => c.i32(1.5), /i32 values are whole numbers from -2147483648 to 2147483647, not 1.5/)
  refused(() => c.i32(0x80000000), /i32 values are whole numbers/)
  refused(() => c.u32(-1), /u32 values are whole numbers from 0 to 4294967295, not -1/)
  refused(() => c.lit('f32x3', 1, 2), /a f32x3 literal takes 3 components \(or one to repeat\), not 2/)
  refused(() => c.lit('i32', true), /i32 values are written as numbers, not true/)
  refused(() => c.lit('bool', 1), /bool values are written true or false, not 1/)
  refused(() => c.lit('f64' as never, 1), /lens: body\[0\] lit: "f64" is not a value type/)
})

test('vector and grid helpers: numbers alone make one literal, anything else a make', () => {
  const b = lens('compute')
  const s = b.f32(2)
  const v3 = b.f32x3(1, 2, 3)
  const v4 = b.f32x4(v3, 1)
  const splat = b.f32x4(0.5)
  const fromScalar = b.f32x3(s)
  const iv = b.i32x2(1, b.i32(-4))
  const bv = b.boolx2(true, false)
  const g = b.m2(1, 2, 3, 4)
  const cols = b.m2(b.f32x2(1, 0), b.f32x2(0, 1))
  const scalars = b.m2(s, s, s, s)
  const m = b.finish()
  const byId = (id: number): Inst | undefined => m.body.find((x) => 'id' in x && x.id === id)
  assert.deepEqual(byId(v3.id), { op: 'lit', id: v3.id, t: 'f32x3', v: [1, 2, 3] })
  assert.deepEqual(byId(splat.id), { op: 'lit', id: splat.id, t: 'f32x4', v: [0.5, 0.5, 0.5, 0.5] })
  assert.deepEqual(byId(v4.id), { op: 'make', id: v4.id, t: 'f32x4', args: [v3.id, v4.id - 1] })
  assert.deepEqual(byId(fromScalar.id), { op: 'make', id: fromScalar.id, t: 'f32x3', args: [s.id] })
  assert.equal(byId(iv.id)?.op, 'make')
  assert.deepEqual(byId(bv.id), { op: 'lit', id: bv.id, t: 'boolx2', v: [1, 0] })
  assert.deepEqual(byId(g.id), { op: 'lit', id: g.id, t: 'm2', v: [1, 2, 3, 4] })
  assert.equal(byId(cols.id)?.op, 'make')
  assert.equal(byId(scalars.id)?.op, 'make')
  const c = lens('compute')
  refused(() => c.m2(1), /lens: body\[1\] make: a m2 is made of 2 f32x2 columns or 4 f32 scalars, not f32/)
  refused(() => c.f32x3(c.f32x2(1, 2), c.f32x2(3, 4)), /make: the components of f32x2 f32x2 add up to 4, not the 3 of a f32x3/)
  refused(() => c.make('f32x2', c.i32(1), 2), /make: a f32x2 is made of f32 scalars and vectors, not i32 f32/)
  refused(() => c.make('f32'), /make takes 1 to 16 operands, not 0/)
  refused(() => c.make('u32', 1), /make builds a vector or a grid, not u32/)
})

test('pick, lane, column, cast and bits', () => {
  const b = lens('compute')
  const v = zero(b, 'f32x4')
  const g = zero(b, 'm3')
  const xyz = b.pick(v, 'xyz')
  const rgba = b.pick(v, 'abgr')
  const x = b.pick(v, 'x')
  const listed = b.pick(v, [3, 0])
  const ln = b.lane(v, 2)
  const neg = b.lane(v, -1)
  const col = b.column(g, 1)
  const iv = zero(b, 'i32x3')
  const cast = b.cast(iv, 'f32')
  const cast2 = b.cast(iv, 'boolx3')
  const same = b.cast(v, 'f32')
  const bits = b.bits(v, 'u32')
  const before = b.ids
  assert.equal(b.cast(cast, 'f32x3'), cast)
  assert.equal(b.bits(bits, 'u32x4'), bits)
  assert.equal(b.ids, before)
  assert.equal(same, v)
  const m = b.finish()
  assert.deepEqual([xyz, rgba, x, listed, ln, neg, col, cast, cast2, bits].map((h) => h.t), ['f32x3', 'f32x4', 'f32', 'f32x2', 'f32', 'f32', 'f32x3', 'f32x3', 'boolx3', 'u32x4'])
  const find = (id: number): Inst | undefined => m.body.find((i) => 'id' in i && i.id === id)
  assert.deepEqual(find(rgba.id), { op: 'pick', id: rgba.id, t: 'f32x4', a: v.id, lanes: [3, 2, 1, 0] })
  assert.deepEqual(find(listed.id), { op: 'pick', id: listed.id, t: 'f32x2', a: v.id, lanes: [3, 0] })
  assert.deepEqual(find(ln.id - 1), { op: 'lit', id: ln.id - 1, t: 'u32', v: [2] })
  assert.deepEqual(find(neg.id - 1), { op: 'lit', id: neg.id - 1, t: 'i32', v: [-1] })
  assert.deepEqual(find(col.id), { op: 'column', id: col.id, t: 'f32x3', a: g.id, i: 1 })
  assert.deepEqual(find(cast.id), { op: 'cast', id: cast.id, t: 'f32x3', a: iv.id })
  assert.deepEqual(find(bits.id), { op: 'bits', id: bits.id, t: 'u32x4', a: v.id })
  const c = lens('compute')
  const w = zero(c, 'f32x2')
  refused(() => c.pick(w, 'q'), /lens: body\[1\] pick: "q" is not a lane name \(x y z w, or r g b a\)/)
  refused(() => c.pick(w, 'xyzwx'), /pick takes a list of 1 to 4 lanes/)
  refused(() => c.pick(w, 'z'), /2 is not a lane of a f32x2/)
  refused(() => c.pick(w, ''), /pick takes a list of 1 to 4 lanes/)
  refused(() => c.pick(c.f32(1), 'x'), /pick takes a vector, not f32/)
  refused(() => c.pick(w, null as never), /the lanes are a string such as "xyz" or a list of lane numbers/)
  refused(() => c.lane(zero(c, 'f32'), 0), /lane takes a vector, not f32/)
  refused(() => c.lane(w, zero(c, 'f32')), /the lane index is an i32 or u32 scalar, not f32/)
  refused(() => c.column(zero(c, 'm3'), 3), /3 is not a column of an m3/)
  refused(() => c.column(w, 0), /column takes a grid, not f32x2/)
  refused(() => c.cast(w, 'i32x3'), /cast: a cast keeps the width; f32x2 cannot become i32x3/)
  refused(() => c.cast(zero(c, 'm2'), 'i32'), /cast takes numbers and bools/)
  refused(() => c.cast(w, 'f64' as never), /"f64" is not a value type/)
  refused(() => c.bits(zero(c, 'bool'), 'u32'), /bits reinterprets f32, i32 and u32 values, not bool as u32/)
})

test('ports: inputs read where declared, outputs written, integers between stages flat without asking', () => {
  const v = lens('vertex')
  v.input(0, 'f32x3')
  const outU = v.output(0, 'u32')
  const outF = v.output(1, 'f32x2')
  const outFlat = v.output(2, 'f32', { flat: true })
  v.out(outU, 7)
  v.out(outF, 0.5)
  v.out(outFlat, 1)
  v.position(1)
  const vm = v.finish()
  assert.deepEqual(vm.outputs, [{ slot: 0, type: 'u32', flat: true }, { slot: 1, type: 'f32x2' }, { slot: 2, type: 'f32', flat: true }])
  assert.deepEqual(vm.body.filter((i) => i.op === 'lit').map((i) => (i.op === 'lit' ? [i.t, i.v] : [])), [['u32', [7]], ['f32x2', [0.5, 0.5]], ['f32', [1]], ['f32x4', [1, 1, 1, 1]]])
  const f = lens('fragment')
  const c = f.input(0, 'i32x2')
  f.if(f.bool(true), () => {
    const inner = f.input(1, 'f32x4')
    assert.equal(inner.id, 2)
  })
  const again = f.in(1)
  const fm = f.finish()
  assert.deepEqual(fm.inputs, [{ slot: 0, type: 'i32x2', flat: true }, { slot: 1, type: 'f32x4' }])
  assert.deepEqual(fm.body[2], { op: 'if', c: 1, then: [{ op: 'in', id: 2, t: 'f32x4', slot: 1 }], else: [] })
  assert.deepEqual([c.t, again.t], ['i32x2', 'f32x4'])
  const g = lens('vertex')
  refused(() => g.input(0, 'f32', { flat: true }), /lens: body\[0\] in: a vertex input is not passed between stages, so it is not flat/)
  refused(() => g.output(0, 'u32', { flat: false }), /lens: outputs\[0\] port: u32 values passed between stages are flat/)
  refused(() => g.output(16, 'f32'), /lens: outputs\[0\] port: slot 16 is not a whole number below 16/)
  refused(() => g.output(0, 'm4'), /a port carries numbers or number vectors, not m4/)
  refused(() => g.output(0, 'bool'), /not bool/)
  g.output(3, 'f32')
  refused(() => g.output(3, 'f32x2'), /lens: outputs\[1\] port: slot 3 is declared twice/)
  for (let s = 4; s < 16; s++) g.output(s, 'f32')
  g.output(0, 'f32')
  g.output(1, 'f32')
  g.output(2, 'f32')
  refused(() => g.output(2, 'f32'), /slot 2 is declared twice/)
  g.input(0, 'f32')
  refused(() => g.input(0, 'f32x2'), /lens: body\[1\] in: slot 0 is declared twice/)
  refused(() => g.in(5), /lens: body\[1\] in: no input is declared at slot 5/)
  refused(() => lens('compute').input(0, 'f32'), /a compute stage has no ports/)
  refused(() => lens('compute').output(0, 'f32'), /lens: outputs\[0\] port: a compute stage has no ports/)
  const h = lens('fragment')
  const o = h.output(0, 'f32x4')
  refused(() => h.output(1, 'f32', { flat: true }), /a fragment output is not passed between stages, so it is not flat/)
  refused(() => h.out(o, h.f32(1)), /lens: body\[1\] out: the value is f32, not f32x4/)
  refused(() => h.out({ slot: 0, t: 'f32x4' }, 1), /out: the port is not an output of this builder/)
  refused(() => h.position(h.f32x4(0)), /lens: body\[2\] position: position is only in the vertex stage/)
  refused(() => lens('vertex').position(lens('vertex').f32x3(0, 0, 0)), /position: the position is not a value of this builder/)
})

test('builtins belong to their stage', () => {
  assert.equal(lens('vertex').builtin('vertex-index').t, 'u32')
  assert.equal(lens('fragment').builtin('frag-coord').t, 'f32x4')
  assert.equal(lens('fragment').builtin('front-facing').t, 'bool')
  assert.equal(lens('compute').builtin('local-index').t, 'u32')
  refused(() => lens('vertex').builtin('frag-coord'), /lens: body\[0\] builtin: frag-coord is a builtin of the fragment stage, not of the vertex stage/)
  refused(() => lens('compute').builtin('thread' as never), /"thread" is not a builtin/)
})

test('resources: blocks from specs, handles, sets and bindings, constants, image kinds and storage formats', () => {
  const b = lens('compute')
  const lights = b.uniform(0, 0, { count: 'u32', list: arrayOf({ pos: 'f32x3', power: 'f32' }, 4), grid: 'm4' })
  const buf = b.storage(0, 1, { n: 'u32', items: arrayOf('f32x4') })
  const out = b.storage(0, 2, block({ fields: [{ name: 'v', type: 'f32' }] }), { writable: true })
  const k = b.constants({ scale: 'f32' })
  const img = b.image(1, 0)
  const arr = b.image(1, 1, { sample: 'uint', dims: '2d-array' })
  const smp = b.sampler(1, 2)
  const si = b.storageImage(2, 0, 'r32f')
  assert.deepEqual([lights.res, buf.res, out.res, k.res, img.res, arr.res, smp.res, si.res], [0, 1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual([buf.writable, out.writable, img.sample, img.dims, arr.dims, si.format], [false, true, 'float', '2d', '2d-array', 'r32f'])
  const m = b.finish()
  assert.deepEqual(m.resources[0], {
    kind: 'uniform', set: 0, binding: 0,
    block: { fields: [
      { name: 'count', type: 'u32' },
      { name: 'list', type: { array: { struct: { fields: [{ name: 'pos', type: 'f32x3' }, { name: 'power', type: 'f32' }] } }, len: 4 } },
      { name: 'grid', type: 'm4' },
    ] },
  })
  assert.deepEqual(m.resources[1], { kind: 'storage', set: 0, binding: 1, writable: false, block: { fields: [{ name: 'n', type: 'u32' }, { name: 'items', type: { array: 'f32x4', len: 0 } }] } })
  assert.deepEqual(m.resources[3], { kind: 'constants', block: { fields: [{ name: 'scale', type: 'f32' }] } })
  assert.deepEqual(m.resources.slice(4), [
    { kind: 'image', set: 1, binding: 0, sample: 'float', dims: '2d' },
    { kind: 'image', set: 1, binding: 1, sample: 'uint', dims: '2d-array' },
    { kind: 'sampler', set: 1, binding: 2 },
    { kind: 'storage-image', set: 2, binding: 0, format: 'r32f' },
  ])
  // A Block given whole is copied, not adopted.
  const given = { fields: [{ name: 'x', type: 'f32' as const }] }
  const c = lens('compute')
  c.uniform(0, 0, { s: given, t: { struct: given } })
  const cm = c.finish()
  assert.ok(!Object.isFrozen(given))
  assert.deepEqual(cm.resources[0], { kind: 'uniform', set: 0, binding: 0, block: { fields: [{ name: 's', type: { struct: given } }, { name: 't', type: { struct: given } }] } })
  const d = lens('compute')
  d.uniform(0, 0, { a: 'f32x4' })
  refused(() => d.uniform(0, 0, { b: 'f32x4' }), /lens: resources\[1\] uniform: set 0 binding 0 is declared twice/)
  refused(() => d.sampler(3, 0), /lens: resources\[1\] sampler: set 3 is not a whole number below 3/)
  refused(() => d.uniform(0, 1, { a: 'f32', list: arrayOf('f32', 4) }), /field list: an array in a uniform block needs elements 16 bytes apart/)
  refused(() => d.uniform(0, 1, { a: arrayOf('f32x4') }), /field a: an array without a length is only the last field of a storage block/)
  refused(() => d.storage(0, 1, { a: arrayOf('f32'), b: 'f32' }), /field a: an array without a length is only the last field/)
  refused(() => d.uniform(0, 1, { flag: 'bool' as never }), /field flag: "bool" is not a number type/)
  refused(() => d.uniform(0, 1, {}), /the block holds 0 fields/)
  refused(() => d.uniform(0, 1, null as never), /lens: resources\[1\] uniform: the block is not a block/)
  refused(() => d.uniform(0, 1, { a: 5 as never }), /field a: its type is a number type, an array or a nested block/)
  refused(() => d.constants({ big: arrayOf('f32x4', 9) }), /lens: resources\[1\] constants: the constants block takes 144 bytes; the limit is 128/)
  d.constants({ x: 'f32' })
  refused(() => d.constants({ y: 'f32' }), /a module declares at most one constants resource/)
  refused(() => d.image(1, 0, { sample: 'half' as never }), /"half" is not a sample kind/)
  refused(() => d.storageImage(1, 0, 'bgra8'), /lens: resources\[2\] storage-image: "bgra8" is not a format a storage image may have/)
  // A cyclic spec stops at the nesting limit instead of recursing forever.
  const cyclic: Record<string, unknown> = {}
  cyclic.me = cyclic
  refused(() => d.uniform(2, 0, cyclic as never), /nest at most 8 deep/)
})

test('read and write: paths by field name, index or value; leaves typed by walk(); storage writable only', () => {
  const b = lens('compute')
  const u = b.uniform(0, 0, { count: 'u32', list: arrayOf({ pos: 'f32x3', power: 'f32' }, 4) })
  const s = b.storage(0, 1, { n: 'u32', items: arrayOf({ v: 'f32x4', k: 'i32' }) }, { writable: true })
  const i = b.pick(b.builtin('global-id'), 'x')
  const j = zero(b, 'i32')
  const pos = b.read(u, 'list', i, 'pos')
  const power = b.read(u, 1, 2, 1)
  const k = b.read(s, 'items', j, 'k')
  b.write(s, ['items', i, 'v'], b.f32x4(pos, power))
  b.write(s, 'n', i)
  b.write(s, ['items', 70_000, 'k'], 3)
  const m = b.finish()
  assert.deepEqual([pos.t, power.t, k.t], ['f32x3', 'f32', 'i32'])
  const ops = m.body.filter((x) => x.op === 'read' || x.op === 'write')
  assert.deepEqual(ops, [
    { op: 'read', id: pos.id, t: 'f32x3', res: 0, path: [1, { at: i.id }, 0] },
    { op: 'read', id: power.id, t: 'f32', res: 0, path: [1, 2, 1] },
    { op: 'read', id: k.id, t: 'i32', res: 1, path: [1, { at: j.id }, 1] },
    { op: 'write', res: 1, path: [1, { at: i.id }, 0], a: k.id + 1 },
    { op: 'write', res: 1, path: [0], a: i.id },
    { op: 'write', res: 1, path: [1, 70_000, 1], a: k.id + 2 },
  ])
  const c = lens('fragment')
  const cu = c.uniform(0, 0, { count: 'u32', list: arrayOf('f32x4', 4) })
  const cs = c.storage(0, 1, { n: 'u32' })
  const img = c.image(0, 2)
  refused(() => c.read(cu, 'missing'), /lens: body\[0\] read: step 0: the block has no field named "missing"/)
  refused(() => c.read(cu, 'list', 'x'), /step 1 names the field "x" where the path is not at a block/)
  refused(() => c.read(cu, 'list', 4), /read: element 4 is outside the array/)
  refused(() => c.read(cu, 'list'), /read: the path ends at a block or an array, not at a number type/)
  refused(() => c.read(cu, 'count', 0), /read: the path goes past the u32 it reached/)
  refused(() => c.read(cu, 'list', c.f32(1)), /lens: body\[1\] read: step 1 is f32, not i32 or u32/)
  refused(() => c.read(cu, 'list', -1), /step 1 \(-1\) is not a constant index from 0 to 2147483647/)
  refused(() => c.read(cu, ...new Array(17).fill(0)), /a path has at most 16 steps, not 17/)
  refused(() => c.read(img as never, 0), /read: resource 2 is a image, not uniform or storage or constants/)
  refused(() => c.read({ res: 0, kind: 'uniform' } as never, 0), /read: the resource is not a resource of this builder/)
  refused(() => c.write(cs, 'n', 1), /lens: body\[1\] write: resource 1 is not a writable storage block/)
  refused(() => c.write(cu as never, 'count', 1), /write: resource 0 is a uniform, not storage/)
  const v = lens('vertex')
  const vs = v.storage(0, 0, { n: 'u32' }, { writable: true })
  refused(() => v.write(vs, 'n', 1), /lens: body\[0\] write: the vertex stage never writes a resource/)
  const w = lens('compute')
  const ws = w.storage(0, 0, { n: 'u32' }, { writable: true })
  refused(() => w.write(ws, 'n', w.f32(1)), /lens: body\[1\] write: the value is f32, not u32/)
})

test('sample, texel, put and extent: kinds, defaults, layers, levels and stages', () => {
  const f = lens('fragment')
  const uv = f.input(0, 'f32x2')
  const img = f.image(0, 0)
  const arr = f.image(0, 1, { dims: '2d-array' })
  const depth = f.image(0, 2, { sample: 'depth' })
  const sint = f.image(0, 3, { sample: 'sint' })
  const uint = f.image(1, 0, { sample: 'uint' })
  const smp = f.sampler(0, 4)
  const si = f.storageImage(1, 1, 'r32u')
  const s1 = f.sample(img, smp, uv)
  const s2 = f.sample(arr, smp, uv, { layer: 2, level: 1.5 })
  const t1 = f.texel(img, f.i32x2(1, 2))
  const t2 = f.texel(depth, f.u32x2(0, 0), { level: 1 })
  const t3 = f.texel(sint, f.i32x2(0, 0))
  const t4 = f.texel(arr, f.u32x2(0, 0), { layer: f.i32(3) })
  const t5 = f.texel(uint, f.u32x2(0, 0))
  const e1 = f.extent(img)
  const e2 = f.extent(si)
  f.put(si, f.u32x2(0, 0), 5)
  const m = f.finish()
  assert.deepEqual([s1, s2, t1, t2, t3, t4, t5, e1, e2].map((v) => v.t), ['f32x4', 'f32x4', 'f32x4', 'f32', 'i32x4', 'f32x4', 'u32x4', 'u32x2', 'u32x2'])
  const find = (id: number): Inst | undefined => m.body.find((i) => 'id' in i && i.id === id)
  assert.deepEqual(find(s1.id), { op: 'sample', id: s1.id, t: 'f32x4', image: 0, sampler: 5, uv: uv.id })
  assert.deepEqual(find(s2.id), { op: 'sample', id: s2.id, t: 'f32x4', image: 1, sampler: 5, uv: uv.id, layer: s2.id - 2, level: s2.id - 1 })
  assert.deepEqual([find(s2.id - 2), find(s2.id - 1)], [{ op: 'lit', id: s2.id - 2, t: 'u32', v: [2] }, { op: 'lit', id: s2.id - 1, t: 'f32', v: [1.5] }])
  assert.deepEqual(find(t1.id), { op: 'texel', id: t1.id, t: 'f32x4', image: 0, at: t1.id - 2, level: t1.id - 1 })
  assert.deepEqual(find(t1.id - 1), { op: 'lit', id: t1.id - 1, t: 'u32', v: [0] })
  assert.deepEqual(find(e1.id), { op: 'extent', id: e1.id, t: 'u32x2', image: 0, level: e1.id - 1 })
  assert.deepEqual(find(e2.id), { op: 'extent', id: e2.id, t: 'u32x2', image: 6 })
  assert.deepEqual(last(m), { op: 'put', image: 6, at: e2.id + 1, a: e2.id + 2 })
  assert.deepEqual(find(e2.id + 2), { op: 'lit', id: e2.id + 2, t: 'u32x4', v: [5, 5, 5, 5] })

  const g = lens('fragment')
  const guv = g.input(0, 'f32x2')
  const gi = g.image(0, 0)
  const ga = g.image(0, 1, { dims: '2d-array' })
  const gu = g.image(0, 2, { sample: 'uint' })
  const gs = g.sampler(0, 3)
  const gsi = g.storageImage(0, 4, 'rgba8')
  refused(() => g.sample(gu, gs, guv), /lens: body\[1\] sample: resource 2 is a uint image; sample reads a float image/)
  refused(() => g.sample(gi, gi as never, guv), /sample: resource 0 is a image, not sampler/)
  refused(() => g.sample(gi, gs, g.f32x3(0, 0, 0)), /sample: uv is f32x3, not f32x2/)
  refused(() => g.sample(ga, gs, guv), /sample: a 2d-array image is read at a layer/)
  refused(() => g.sample(gi, gs, guv, { layer: 0 }), /sample: a 2d image has no layers/)
  refused(() => g.sample(gi, gs, guv, { level: g.i32(0) }), /sample: the level is i32, not f32/)
  refused(() => g.texel(gi, g.f32x2(0, 0)), /texel: the position is f32x2, not i32x2 or u32x2/)
  refused(() => g.texel(gi, g.i32x2(0, 0), { level: g.f32(0) }), /texel: the level is f32, not i32 or u32/)
  refused(() => g.texel(gsi as never, g.i32x2(0, 0)), /texel: resource 4 is a storage-image, not image/)
  refused(() => g.put(gsi, g.i32x2(0, 0), g.u32x4(0)), /put: the value is u32x4, not f32x4/)
  refused(() => g.put(gi as never, g.i32x2(0, 0), 0), /put: resource 0 is a image, not storage-image/)
  refused(() => g.extent(gsi, 0), /extent: a storage image has one level; its extent takes no level/)
  refused(() => g.extent(gs as never), /extent: resource 3 is a sampler, not image or storage-image/)
  const v = lens('vertex')
  const vi = v.image(0, 0)
  const vs = v.sampler(0, 1)
  const vsi = v.storageImage(0, 2, 'rgba8')
  refused(() => v.sample(vi, vs, v.f32x2(0, 0)), /sample: a sample without a level is only in the fragment stage/)
  assert.equal(v.sample(vi, vs, v.f32x2(0, 0), { level: 0 }).t, 'f32x4')
  refused(() => v.put(vsi, v.i32x2(0, 0), 0), /put: put is only in the fragment and compute stages/)
})

test('implicit-level sampling and derivatives sit at the top level, before any instruction holding a return', () => {
  const f = lens('fragment')
  const uv = f.input(0, 'f32x2')
  const img = f.image(0, 0)
  const smp = f.sampler(0, 1)
  assert.deepEqual([f.dx(uv).t, f.dy(uv).t, f.deriv('width', f.pick(uv, 'x')).t], ['f32x2', 'f32x2', 'f32'])
  f.if(f.bool(true), () => {
    refused(() => f.dx(uv), /lens: body\[6\].then\[0\] deriv: deriv sits at the top level of the body/)
    refused(() => f.sample(img, smp, uv), /body\[6\].then\[0\] sample: a sample without a level sits at the top level/)
    f.sample(img, smp, uv, { level: 0 })
    f.loop(() => {
      f.if(f.bool(false), () => f.return())
      f.break()
    })
  })
  refused(() => f.dx(uv), /lens: body\[7\] deriv: deriv sits before any instruction that holds a return/)
  refused(() => f.sample(img, smp, uv), /lens: body\[7\] sample: a sample without a level sits before any instruction that holds a return/)
  f.finish()
  refused(() => lens('compute').dx(1), /lens: body\[0\] deriv: deriv is only in the fragment stage/)
  refused(() => lens('fragment').deriv('dz' as never, 1), /"dz" is not a derivative \(dx, dy or width\)/)
  refused(() => { const b = lens('fragment'); b.dx(b.i32(1)) }, /deriv: the operand is i32, not f32 or f32x2 or f32x3 or f32x4/)
})

test('variables: var with and without an initial value, get and set', () => {
  const b = lens('compute')
  const a = b.var('f32x2')
  const n = b.var('u32', 5)
  const got = b.get(n)
  b.set(a, b.f32x2(1, 2))
  b.set(n, b.add(got, 1))
  const m = b.finish()
  assert.deepEqual(m.body.slice(0, 4), [
    { op: 'var', id: 0, t: 'f32x2' },
    { op: 'lit', id: 1, t: 'u32', v: [5] },
    { op: 'var', id: 2, t: 'u32', init: 1 },
    { op: 'get', id: 3, t: 'u32', v: 2 },
  ])
  assert.deepEqual([a, n, got], [{ id: 0, t: 'f32x2', variable: true }, { id: 2, t: 'u32', variable: true }, { id: 3, t: 'u32' }])
  const c = lens('compute')
  const v = c.var('f32')
  refused(() => c.set(v, c.i32(1)), /lens: body\[2\] set: the value is i32, not f32/)
  refused(() => c.var('f32', c.u32(1)), /var: the initial value is u32, not f32/)
  refused(() => c.get(c.f32(1) as never), /get: the variable is not a variable of this builder/)
  refused(() => c.add(v as never, 1), /binary: operand a is a variable; read it with get/)
  refused(() => c.var('f64' as never), /var: "f64" is not a value type/)
  let inner: unknown
  c.loop(() => {
    inner = c.var('u32')
    c.break()
  })
  refused(() => c.get(inner as never), /get: the variable %\d+ was made inside a block that has ended/)
})

test('control: if and loop paths, scope, break and continue only in loops, nothing after a block-ending op, depth', () => {
  const b = lens('fragment')
  const o = b.output(0, 'f32')
  const c = b.bool(true)
  let kept: Val | undefined
  b.if(c, () => {
    kept = b.f32(1)
    b.loop(() => {
      b.if(c, () => b.continue(), () => b.break())
    })
    b.discard()
  }, () => {
    refused(() => b.break(), /lens: body\[1\].else\[0\] break: break is only inside a loop/)
    b.return()
    refused(() => b.f32(3), /lens: body\[1\].else\[1\] lit: nothing may follow return in its block/)
  })
  refused(() => b.out(o, kept as Val), /lens: body\[2\] out: the value \(%1\) was made inside a block that has ended; carry it out through a variable/)
  refused(() => b.if(b.u32(1), () => {}), /lens: body\[3\] if: the condition is u32, not bool/)
  refused(() => b.if(c, 5 as never), /if: each branch is a function that writes its instructions/)
  refused(() => b.loop(null as never), /loop: the body is a function that writes its instructions/)
  refused(() => b.continue(), /continue: continue is only inside a loop/)
  const m = b.finish()
  assert.deepEqual(m.body[1], {
    op: 'if', c: 0,
    then: [
      { op: 'lit', id: 1, t: 'f32', v: [1] },
      { op: 'loop', body: [{ op: 'if', c: 0, then: [{ op: 'continue' }], else: [{ op: 'break' }] }] },
      { op: 'discard' },
    ],
    else: [{ op: 'return' }],
  })
  // Depth: 32 nested blocks are allowed, a 33rd is refused.
  const d = lens('compute')
  const nest = (n: number): void => {
    if (n === 0) return
    d.loop(() => {
      nest(n - 1)
      d.break()
    })
  }
  nest(32)
  const deep = (n: number): void => {
    if (n === 0) {
      refused(() => d.loop(() => {}), /if and loop nest at most 32 deep/)
      return
    }
    d.loop(() => deep(n - 1))
  }
  deep(32)
  d.finish()
  // An exception inside a callback leaves the builder whole.
  const e = lens('compute')
  assert.throws(() => e.loop(() => { throw new Error('the callback failed') }), /the callback failed/)
  e.f32(1)
  assert.equal(e.finish().body[1].op, 'lit')
  refused(() => lens('vertex').discard(), /lens: body\[0\] discard: discard is only in the fragment stage/)
})

test('finish deep-freezes, verifies once, and ends the builder; values of another builder are refused', () => {
  const b = lens('compute', { group: [8, 4, 2] })
  const s = b.storage(0, 0, { items: arrayOf('f32') }, { writable: true })
  const i = b.pick(b.builtin('global-id'), 'x')
  b.loop(() => {
    b.write(s, ['items', i], 1)
    b.break()
  })
  const other = lens('compute').f32(1)
  refused(() => b.add(other, 1), /binary: operand a is not a value of this builder/)
  refused(() => b.add(null as never, 1), /operand a is not a value of this builder \(null\)/)
  refused(() => b.add({ id: 0, t: 'f32' } as never, 1), /operand a is not a value of this builder \(an object\)/)
  refused(() => b.add('x' as never, 1), /not a value of this builder \("x"\)/)
  b.loop(() => {
    refused(() => b.finish(), /lens: finish: finish is called outside every if and loop/)
    b.break()
  })
  const m = b.finish()
  assert.deepEqual(m.group, [8, 4, 2])
  const frozen = (x: unknown): void => {
    if (typeof x !== 'object' || x === null) return
    assert.ok(Object.isFrozen(x))
    for (const v of Object.values(x)) frozen(v)
  }
  frozen(m)
  refused(() => b.finish(), /lens: finish: the builder has already finished its module/)
  refused(() => b.f32(1), /lens: body\[4\] lit: the builder has finished its module/)
  refused(() => b.uniform(0, 1, { a: 'f32x4' }), /lens: resources\[1\] uniform: the builder has finished its module/)
  refused(() => b.output(0, 'f32'), /the builder has finished its module/)
})

test('the stage and group are checked when the builder is made', () => {
  refused(() => lens('geometry' as never), /lens: module: "geometry" is not a stage/)
  refused(() => lens('vertex', { group: [2, 1, 1] }), /lens: group: a vertex stage has the group \[1, 1, 1\]/)
  refused(() => lens('compute', { group: [0, 1, 1] }), /lens: group: a group size is a whole number of at least 1, not 0/)
  refused(() => lens('compute', { group: [32, 16, 1] }), /holds 512 invocations/)
  assert.deepEqual(lens('compute').group, [1, 1, 1])
  assert.ok(new LensBuilder('fragment') instanceof LensBuilder)
})

test('the instruction and id limits are refused at the instruction that would pass them', () => {
  const b = lens('fragment')
  for (let n = 0; n < LENS_LIMITS.instructions; n++) b.discard()
  refused(() => b.discard(), /lens: body\[65536\] discard: a module holds at most 65536 instructions/)
  assert.equal(b.finish().body.length, LENS_LIMITS.instructions)
  // Variables up to LENS_LIMITS.varBytes (2016 of 4 bytes), then values up to the id limit.
  const c = lens('compute')
  for (let n = 0; n < LENS_LIMITS.ids; n++) {
    if (n < LENS_LIMITS.varBytes / 4) c.var('u32')
    else c.u32(n)
  }
  refused(() => c.var('u32'), /var: a module holds at most 65536 values and variables/)
  assert.equal(c.finish().ids, LENS_LIMITS.ids)
})

test('the bytes of a module\'s variables are counted as WGSL counts them, and refused at the var that would pass 8064', () => {
  assert.equal(LENS_LIMITS.varBytes, 8064)
  const sizes = VALUE_TYPES.map((t) => [t, varBytesOf(t)])
  assert.deepEqual(Object.fromEntries(sizes), {
    f32: 4, i32: 4, u32: 4, bool: 4,
    f32x2: 8, f32x3: 16, f32x4: 16, i32x2: 8, i32x3: 16, i32x4: 16, u32x2: 8, u32x3: 16, u32x4: 16, boolx2: 8, boolx3: 16, boolx4: 16,
    m2: 16, m3: 48, m4: 64,
  })
  // 125 m4, one m3 and one m2 make 8064 exactly; one f32 more is refused where it would sit, nested or not, and the
  // refused var takes no id and no place.
  const b = lens('fragment')
  for (let n = 0; n < 125; n++) b.var('m4')
  b.var('m3')
  b.if(true, () => {
    b.var('m2')
    refused(() => b.var('f32'), /^lens: body\[127\]\.then\[1\] var: variables take 8068 bytes; a module holds at most 8064$/)
  })
  refused(() => b.var('bool'), /^lens: body\[128\] var: variables take 8068 bytes; a module holds at most 8064$/)
  const m = b.finish()
  assert.equal(m.ids, 128)
  assert.equal(m.body.length, 128)
  // The count is of declarations: a var inside a loop counts once, however often the loop runs.
  const l = lens('compute')
  l.loop(() => {
    for (let n = 0; n < 504; n++) l.var('f32x4')
    l.break()
  })
  assert.equal(l.finish().body.length, 1)
})

test('a block spec or Block shared under many fields is copied within LENS_LIMITS.blockFields, and refused past it', () => {
  // Six fields per level, each pointing at one shared inner Block, eight levels deep: about two million fields once
  // copied out, which the builder once copied whole (and a wider one exhausted the heap) before refusing.
  const shared = (k: number, levels: number): Block => {
    let b: Block = { fields: Array.from({ length: k }, (_, i) => ({ name: `f${i}`, type: 'f32x4' })) }
    for (let l = 1; l < levels; l++) {
      const inner = b
      b = { fields: Array.from({ length: k }, (_, i) => ({ name: `f${i}`, type: { struct: inner } })) }
    }
    return b
  }
  const vast = shared(6, 8)
  refused(() => block(vast), /^lens: block: the block holds more than 1048576 fields in all/)
  refused(() => arrayOf(vast, 2), /^lens: block: the block holds more than 1048576 fields in all/)
  refused(() => lens('compute').storage(0, 0, vast), /^lens: block: the block holds more than 1048576 fields in all/)
  refused(() => lens('compute').uniform(0, 0, shared(16, 7)), /^lens: block: the block holds more than 1048576 fields in all/)
  // The same holds for a spec written as keys.
  let spec: BlockSpec = { x: 'f32x4' }
  for (let l = 0; l < 7; l++) {
    const inner = spec
    spec = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}`, inner]))
  }
  refused(() => lens('compute').storage(0, 0, spec), /^lens: block: the block holds more than 1048576 fields in all/)
  // A shared Block within the bound is copied out and declared.
  const fits = shared(4, 8)
  const r = lens('compute').storage(0, 0, fits)
  assert.notEqual(r.block, fits)
  assert.deepEqual(r.block, fits)
})

test('reads by many distinct paths through a large declared block do not lay it out again each', () => {
  // The shape of the createLens repro, written with the builder: a uniform block of 266,304 fields once copied out
  // (64 fields, each a 3-deep array of length 1 of a block of 64 such fields of a block of 64 f32x4). Each read once
  // laid the whole copy out again to find its leaf (about a third of a second a read; 4,096 reads, about 23 minutes);
  // the builder now lays each block of its own frozen copy out once, as the checker does, and these take moments.
  const arr = (t: FieldSpec): FieldSpec => arrayOf(arrayOf(arrayOf(t, 1), 1), 1)
  const T: BlockSpec = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`t${i}`, 'f32x4']))
  const S: BlockSpec = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`s${i}`, arr(T)]))
  const TOP: BlockSpec = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`a${i}`, arr(S)]))
  const b = lens('compute')
  const u = b.uniform(0, 0, TOP)
  for (let k = 0; k < 4096; k++) assert.equal(b.read(u, k >> 6, 0, 0, 0, k % 64, 0, 0, 0, (k * 7) % 64).t, 'f32x4')
  const m = b.finish()
  assert.equal(m.body.length, 4096)
  assert.deepEqual(m.body[4095], { op: 'read', id: 4095, t: 'f32x4', res: 0, path: [63, 0, 0, 0, 63, 0, 0, 0, (4095 * 7) % 64] })
})

test('finish refuses a module whose binary form would pass LENS_LIMITS.words, as createLens would', () => {
  // Sixteen scalars and m4s made of them, 19 words each: within the instruction and id limits, past the word limit.
  const b = lens('compute')
  const xs = Array.from({ length: 16 }, (_, i) => b.f32(i))
  const n = Math.ceil(LENS_LIMITS.words / 19)
  for (let k = 0; k < n; k++) b.make('m4', ...xs)
  assert.ok(b.ids <= LENS_LIMITS.ids)
  refused(() => b.finish(), /^lens: finish: the binary form cannot carry the module \(lens: encode: module: the module takes more than 1048576 words\)/)
})

test('-0 given for a set, binding, slot, path step, lane or column is written as 0, so the module round-trips exactly', () => {
  const b = lens('fragment')
  const uv = b.input(-0, 'f32x2')
  const out = b.output(-0, 'f32x4')
  const u = b.uniform(-0, -0, { list: arrayOf('f32x4', 2), g: 'm2' })
  b.image(-0, 1)
  b.sampler(1, -0)
  b.storageImage(2, -0, 'rgba8')
  const again = b.in(-0)
  const first = b.read(u, 'list', -0)
  const col = b.column(b.read(u, 1), -0)
  const lanes = b.pick(b.make('f32x4', uv, col), [-0, 1, -0, 1])
  b.out(out, b.add(b.add(first, lanes), b.pick(again, [-0, -0, 1, 1])))
  const m = b.finish()
  const whole: unknown[] = [
    m.inputs[0].slot, m.outputs[0].slot, ...m.resources.flatMap((r) => (r.kind === 'constants' ? [] : [r.set, r.binding])),
    ...m.body.flatMap((x) => (x.op === 'in' || x.op === 'out' ? [x.slot] : x.op === 'read' ? x.path : x.op === 'pick' ? x.lanes : x.op === 'column' ? [x.i] : [])),
  ]
  assert.ok(whole.length > 12)
  for (const x of whole) assert.ok(Object.is(x, 0) || (typeof x === 'number' && x > 0), String(x))
  assert.ok(!whole.some((x) => Object.is(x, -0)))
  assert.deepEqual(decode(encode(m)), m)
})

test('-0 given for an array\'s length, by arrayOf or by an { array, len } spec, is written as 0, as every other -0 is', () => {
  // Once arrayOf('f32', -0) kept -0, which the checker refuses ("an array holds 0 to 65536 elements, not -0") when a
  // resource declares it; it is the runtime-sized array its 0 asks for, and a fixed field after it is refused for
  // being after it, not for its -0.
  assert.ok(Object.is(arrayOf('f32', -0).len, 0))
  assert.ok(Object.is((block({ a: { array: 'f32x4', len: -0 } }).fields[0].type as { len: number }).len, 0))
  const b = lens('compute')
  const runtime = b.storage(0, 0, { a: arrayOf('f32', -0) }, { writable: true })
  const fixed = b.storage(0, 1, block({ fields: [{ name: 'x', type: 'f32' }, { name: 'list', type: { array: 'f32x4', len: -0 } }] }))
  b.write(runtime, ['a', 1], b.add(b.read(fixed, 'x'), b.lane(b.read(fixed, 'list', 0), 0)))
  const m = b.finish()
  const lens0 = m.resources.map((r) => (r.kind === 'storage' ? r.block.fields[r.block.fields.length - 1].type : null))
  for (const t of lens0) assert.ok(t !== null && typeof t !== 'string' && 'array' in t && Object.is(t.len, 0), String(t))
  assert.deepEqual(decode(encode(m)), m)
  refused(() => lens('compute').storage(0, 0, { a: arrayOf('f32', -0), b: 'f32' }), /field a: an array without a length is only the last field of a storage block/)
})
