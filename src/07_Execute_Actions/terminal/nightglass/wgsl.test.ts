// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the WGSL that wgsl.ts prints for compute modules, so a change to the lowering
 * shows as a text diff a reviewer can read. Golden text covers each family: literals, every helper, min and max,
 * casts, arithmetic, logic, geometry, variables and loops with their cap, statement behaviours, uniform, storage and
 * constant blocks, the hidden block, and the compute entry. Beside the goldens it checks the printed struct layouts
 * against layoutBlock and strideOf for random blocks in both spaces, the literal rule over special values,
 * positionSure, the WGSL bounds a module at each Lens bound stays within, the refusals of what is not lowered yet,
 * and properties of every text printed here: the same text every time, ASCII, none of the air gap's words, a length
 * linear in the module, names that are declared once and called, and no operation on two literals.
 * What breaks if it is removed? The lowering could change shape, lay a block out differently from the reference,
 * let a word the air gap bans into a shader, or lower something it should refuse, and no test would see it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { arrayOf, block, lens } from './builder.ts'
import type { LensBuilder, Val } from './builder.ts'
import { isFault } from './fault.ts'
import { BINARY, BUILTINS, LENS_LIMITS, RESOURCE_KINDS, STAGES, TERNARY, UNARY, layoutBlock, strideOf } from './lens.ts'
import type { Block, DataType, Inst, LensModule, Op, Space, ValueType } from './lens.ts'
import { WGSL_HIDDEN, positionSure, toWgsl } from './wgsl.ts'
import type { WgslOptions } from './wgsl.ts'

const lines = (...xs: string[]): string => `${xs.join('\n')}\n`

/** The options a module's own resources ask for: each storage block read_write when it is written, else read. */
function optionsFor(m: LensModule, over: Partial<WgslOptions> = {}): WgslOptions {
  const storage = m.resources.map((r): 'read' | 'read_write' | null => (r.kind === 'storage' ? (r.writable ? 'read_write' : 'read') : null))
  return { storage, outputs: [], vertexRate: 0, live: null, arithmetic: 'native', ...over }
}

const wgsl = (m: LensModule): string => toWgsl(m, optionsFor(m)).code

function refused(f: () => unknown, code: 'lens' | 'device', re: RegExp, label = ''): void {
  assert.throws(f, (e: unknown) => {
    assert.ok(isFault(e, code), `${label}: expected a ${code} Fault, got ${String(e)}`)
    assert.match(e.message, re, label)
    return true
  })
}

/** The statements of ng_body, one indent less. */
function body(code: string): string {
  const all = code.split('\n')
  const from = all.indexOf('fn ng_body() {')
  assert.ok(from >= 0, 'no ng_body')
  return lines(...all.slice(from + 1, all.indexOf('}', from)).map((l) => l.slice(2)))
}

/** The reads unknowns() puts at the head of a body, pinned once here and cut from the goldens that follow. */
const READS = lines(
  'let v0: f32 = r0.f0;',
  'let v1: f32 = r0.f1;',
  'let v2: f32 = r0.f2;',
  'let v3: i32 = r0.f3;',
  'let v4: u32 = r0.f4;',
  'let v5: vec3<f32> = r0.f5;',
  'let v6: vec3<f32> = r0.f6;',
  'let v7: vec2<f32> = r0.f7;',
  'let v8: mat3x3<f32> = r0.f8;',
)

/** The statements of ng_body after the reads of unknowns(). */
function ops(code: string): string {
  const b = body(code)
  assert.ok(b.startsWith(READS), b)
  return b.slice(READS.length)
}

/** One module-scope function, from its `fn` line to its closing brace. */
function fnText(code: string, name: string): string {
  const all = code.split('\n')
  const from = all.findIndex((l) => l.startsWith(`fn ${name}(`) || l.includes(` fn ${name}(`))
  assert.ok(from >= 0, `no fn ${name}`)
  return lines(...all.slice(from, all.indexOf('}', from) + 1))
}

/** The module-scope functions, in order. */
const fnNames = (code: string): string[] => [...code.matchAll(/^(?:@.* )?fn (\w+)\(/gm)].map((m) => m[1])

// ---------------------------------------------------------------------------------------------------
// The modules of the goldens

/** Values the lowering knows nothing about: read from a uniform block, never literals. */
function unknowns(b: LensBuilder) {
  const u = b.uniform(0, 0, { a: 'f32', b: 'f32', c: 'f32', i: 'i32', n: 'u32', v: 'f32x3', w: 'f32x3', p: 'f32x2', g: 'm3' })
  return { a: b.read(u, 'a'), b: b.read(u, 'b'), c: b.read(u, 'c'), i: b.read(u, 'i'), n: b.read(u, 'n'), v: b.read(u, 'v'), w: b.read(u, 'w'), p: b.read(u, 'p'), g: b.read(u, 'g') }
}

function small(): LensModule {
  const b = lens('compute', { group: [8, 1, 1] })
  const u = b.uniform(0, 0, { scale: 'f32', offset: 'f32x3' })
  const s = b.storage(0, 1, { data: arrayOf('f32', 64) }, { writable: true })
  const i = b.pick(b.builtin('global-id'), 'x')
  b.write(s, ['data', i], b.mul(b.read(s, 'data', i), b.read(u, 'scale')))
  return b.finish()
}

function literals(): LensModule {
  const b = lens('compute')
  b.f32(1); b.f32(-3); b.f32(0.5); b.f32(-0); b.f32(16777215); b.f32(16777216); b.f32(2 ** -149)
  b.lit('f32x3', 1, 0.25, -0)
  b.i32(-2147483648); b.i32(-7); b.u32(4294967295); b.bool(true); b.lit('boolx2', true, false)
  return b.finish()
}

/** Every helper family at one lane (length and normalize, which take vectors, at three). */
function families(): LensModule {
  const b = lens('compute')
  const { a, b: y, i, n, v } = unknowns(b)
  b.min(a, y); b.max(a, y); b.cast(a, 'bool'); b.saturate(a); b.step(a, y); b.sign(a); b.cast(a, 'i32'); b.cast(a, 'u32'); b.cast(i, 'f32'); b.cast(n, 'f32')
  b.sqrt(a); b.rsqrt(a); b.exp(a); b.unary('exp2', a); b.log(a); b.unary('log2', a); b.sin(a); b.cos(a); b.tan(a); b.asin(a); b.acos(a); b.atan(a); b.atan2(a, y); b.pow(a, y)
  b.length(v); b.normalize(v); b.floor(a); b.ceil(a); b.trunc(a); b.round(a); b.fract(a)
  return b.finish()
}

function widths(): LensModule {
  const b = lens('compute')
  const { a, p, v } = unknowns(b)
  b.exp(p); b.unary('exp2', a); b.log(p); b.unary('log2', a); b.atan(p); b.atan2(a, a); b.min(v, v); b.min(a, a)
  return b.finish()
}

function minmax(): LensModule {
  const b = lens('compute')
  const { a, b: y, c, i } = unknowns(b)
  const k = b.f32(2)
  b.min(a, y); b.max(a, k); b.min(k, a); b.max(k, b.f32(3))
  b.clamp(a, y, c); b.clamp(a, b.f32(0), b.f32(1)); b.clamp(i, b.i32(0), b.i32(9))
  return b.finish()
}

function casts(): LensModule {
  const b = lens('compute')
  const { a, i, n, p } = unknowns(b)
  b.cast(a, 'i32'); b.cast(a, 'u32'); b.cast(a, 'bool'); b.cast(i, 'f32'); b.cast(i, 'u32'); b.cast(i, 'bool'); b.cast(n, 'f32'); b.cast(n, 'i32'); b.cast(n, 'bool')
  const t = b.bool(true)
  b.cast(t, 'f32'); b.cast(t, 'i32'); b.cast(t, 'u32')
  b.cast(p, 'i32x2'); b.bits(a, 'u32'); b.bits(n, 'f32')
  return b.finish()
}

function arithmetic(): LensModule {
  const b = lens('compute')
  const { a, b: y, c, i, n, v, w } = unknowns(b)
  b.add(a, y); b.sub(v, a); b.mul(a, y); b.div(a, y); b.div(i, i); b.rem(i, i); b.rem(n, n); b.rem(a, y); b.rem(v, a)
  b.fract(a); b.mix(v, w, a); b.smoothstep(a, y, c); b.fma(a, y, c)
  b.pow(a, y); b.pow(b.f32(2), b.f32(0.5)); b.atan2(a, y); b.step(a, y); b.sign(a); b.sign(i)
  b.exp(a); b.exp(b.f32(1)); b.length(a); b.distance(a, y); b.distance(v, w); b.abs(i); b.neg(a); b.floor(a); b.ceil(a); b.trunc(a); b.round(a)
  return b.finish()
}

function logic(): LensModule {
  const b = lens('compute')
  const { a, b: y, i, n } = unknowns(b)
  const p = b.lt(a, y); const q = b.ge(i, i)
  b.xor(p, q); b.xor(n, n); b.and(n, n); b.or(i, i); b.land(p, q); b.lor(p, q); b.not(p); b.bitnot(n)
  b.shl(n, n); b.shr(i, n); b.eq(a, y); b.ne(n, n); b.le(a, y); b.gt(i, i)
  return b.finish()
}

function geometry(): LensModule {
  const b = lens('compute')
  const { a, i, n, v, w, g } = unknowns(b)
  b.dot(v, w); b.cross(v, w); b.reflect(v, w); b.normalize(v); b.length(v); b.transpose(g); b.mul(g, v); b.mul(g, g); b.mul(v, g); b.mul(g, a)
  const m = b.make('f32x4', v, a); b.make('f32x3', a); b.make('m2', b.make('f32x2', a, a), b.make('f32x2', a, a))
  b.pick(m, 'zyx'); b.pick(m, 'w'); b.lane(v, n); b.lane(v, i); b.column(g, 2)
  const bv = b.lt(v, w)
  b.any(bv); b.all(bv); b.any(b.lt(a, a)); b.choose(b.lt(a, a), v, w); b.choose(bv, v, w); b.choose(b.lt(a, a), g, g)
  return b.finish()
}

function control(): LensModule {
  const b = lens('compute')
  const { a, n } = unknowns(b)
  const x = b.var('f32', a); const k = b.var('u32')
  b.if(b.lt(b.get(x), 1), () => { b.set(x, b.f32(1)) }, () => { b.set(x, b.mul(b.get(x), 0.5)) })
  b.loop(() => {
    b.set(k, b.add(b.get(k), 1))
    b.loop(() => {
      b.if(b.gt(b.get(k), n), () => b.break())
      b.continue()
    })
    b.if(b.ge(b.get(k), 10), () => b.break())
  })
  b.loop(() => { b.if(b.lt(b.get(x), 0), () => b.return()); b.break() })
  return b.finish()
}

function unreachable(): LensModule {
  const b = lens('compute')
  const { a, n } = unknowns(b)
  const c = b.lt(a, 0)
  b.loop(() => {
    b.if(c, () => b.break(), () => b.continue())
    b.add(n, 1)
  })
  b.if(c, () => b.return(), () => b.return())
  b.add(n, 2)
  b.loop(() => b.break())
  return b.finish()
}

function blocks(): LensModule {
  const b = lens('compute')
  const u = b.uniform(0, 0, { x: 'f32', inner: { a: 'f32', b: 'f32x2' }, list: arrayOf('f32x4', 3), g: 'm3', after: 'f32' })
  const s = b.storage(1, 0, { count: 'u32', items: arrayOf({ pos: 'f32x3', mass: 'f32' }, 4) })
  const o = b.storage(1, 1, { out: arrayOf('f32', 8) }, { writable: true })
  const k = b.constants({ scale: 'f32', tint: 'f32x3' })
  const n = b.read(s, 'count'); const j = b.cast(n, 'i32')
  const m = b.read(s, 'items', j, 'mass')
  const l = b.read(u, 'list', n)
  b.write(o, ['out', n], b.add(m, b.mul(b.read(k, 'scale'), b.pick(l, 'x'))))
  b.write(o, ['out', 7], b.add(b.read(u, 'inner', 'a'), b.read(u, 'after')))
  return b.finish()
}

function entry(): LensModule {
  const b = lens('compute', { group: [4, 2, 1] })
  const o = b.storage(0, 0, { out: arrayOf('u32', 4) }, { writable: true })
  const s = b.add(b.add(b.pick(b.builtin('global-id'), 'x'), b.pick(b.builtin('local-id'), 'y')), b.add(b.pick(b.builtin('group-id'), 'z'), b.builtin('local-index')))
  b.write(o, ['out', 0], b.add(s, b.pick(b.builtin('group-count'), 'x')))
  return b.finish()
}

function hidden(): LensModule {
  const b = lens('compute')
  const o = b.storage(0, 0, { out: 'f32' }, { writable: true })
  b.write(o, 'out', b.sqrt(b.read(o, 'out')))
  return b.finish()
}

/** Every helper family at every width it takes: the most helper text a module can hold. */
function allHelpers(): LensModule {
  const b = lens('compute')
  const u = b.uniform(0, 0, { f: 'f32x4', i: 'i32x4', n: 'u32x4' })
  const [f4, i4, n4] = [b.read(u, 'f'), b.read(u, 'i'), b.read(u, 'n')]
  for (const lanes of ['x', 'xy', 'xyz', 'xyzw']) {
    const w = lanes.length
    const [a, i, n] = [b.pick(f4, lanes), b.pick(i4, lanes), b.pick(n4, lanes)]
    const of = (s: string): ValueType => (w === 1 ? s : `${s}x${w}`) as ValueType
    b.min(a, a); b.max(a, a); b.cast(a, of('bool')); b.saturate(a); b.step(a, a); b.sign(a); b.cast(a, of('i32')); b.cast(a, of('u32')); b.cast(i, of('f32')); b.cast(n, of('f32'))
    for (const fn of ['sqrt', 'rsqrt', 'exp', 'exp2', 'log', 'log2', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan'] as const) b.unary(fn, a)
    b.atan2(a, a); b.pow(a, a)
    if (w > 1) { b.length(a); b.normalize(a) }
  }
  return b.finish()
}

/** The modules this file lowers by name; the properties and the coverage table read them all. */
const CORPUS: { readonly [name: string]: () => LensModule } = {
  small, literals, families, widths, minmax, casts, arithmetic, logic, geometry, control, unreachable, blocks, entry, hidden, allHelpers,
}

// ---------------------------------------------------------------------------------------------------
// Goldens

test('a small compute module prints exactly, and the result says how to bind it', () => {
  const m = small()
  const out = toWgsl(m, optionsFor(m))
  assert.equal(out.code, lines(
    'struct B0 {',
    '  @align(4) @size(16) f0: f32,',
    '  @align(16) @size(16) f1: vec3<f32>,',
    '}',
    '',
    'struct B1 {',
    '  @align(4) @size(256) f0: array<f32, 64>,',
    '}',
    '',
    '@group(0) @binding(0) var<uniform> r0: B0;',
    '@group(0) @binding(1) var<storage, read_write> r1: B1;',
    'var<private> ng_global: vec3<u32>;',
    '',
    'fn ng_body() {',
    '  let v0: vec3<u32> = ng_global;',
    '  let v1: u32 = v0.x;',
    '  let ng_j0: u32 = min(v1, 63u);',
    '  let v2: f32 = r1.f0[ng_j0];',
    '  let v3: f32 = r0.f0;',
    '  let v4: f32 = v2 * v3;',
    '  let ng_j1: u32 = min(v1, 63u);',
    '  r1.f0[ng_j1] = v4;',
    '}',
    '',
    '@compute @workgroup_size(8, 1, 1) fn ng_compute(@builtin(global_invocation_id) ng_global_in: vec3<u32>) {',
    '  ng_global = ng_global_in;',
    '  ng_body();',
    '}',
  ))
  assert.equal(out.entry, 'ng_compute')
  assert.deepEqual(out.raw, [])
  assert.equal(out.directive, false)
  assert.ok(Object.isFrozen(out) && Object.isFrozen(out.raw))
})

test('literals: a whole f32 below 2^24 in decimal, any other f32 and the i32 minimum through a bitcast of their bits', () => {
  assert.equal(body(wgsl(literals())), lines(
    'let v0: f32 = 1.0;',
    'let v1: f32 = -3.0;',
    'let k2: u32 = 0x3f000000u;',
    'let v2: f32 = bitcast<f32>(k2);',
    'let k3: u32 = 0x80000000u;',
    'let v3: f32 = bitcast<f32>(k3);',
    'let v4: f32 = 16777215.0;',
    'let k5: u32 = 0x4b800000u;',
    'let v5: f32 = bitcast<f32>(k5);',
    'let k6: u32 = 0x00000001u;',
    'let v6: f32 = bitcast<f32>(k6);',
    'let v7_0: f32 = 1.0;',
    'let k7_1: u32 = 0x3e800000u;',
    'let v7_1: f32 = bitcast<f32>(k7_1);',
    'let k7_2: u32 = 0x80000000u;',
    'let v7_2: f32 = bitcast<f32>(k7_2);',
    'let v7: vec3<f32> = vec3<f32>(v7_0, v7_1, v7_2);',
    'let k8: u32 = 0x80000000u;',
    'let v8: i32 = bitcast<i32>(k8);',
    'let v9: i32 = -7i;',
    'let v10: u32 = 4294967295u;',
    'let v11: bool = true;',
    'let v12_0: bool = true;',
    'let v12_1: bool = false;',
    'let v12: vec2<bool> = vec2<bool>(v12_0, v12_1);',
  ))
})

test('every helper family prints as pinned, in the fixed order, each once', () => {
  const code = wgsl(families())
  assert.equal(ops(code), lines(
    'let v9: f32 = ng_min(v0, v1);',
    'let v10: f32 = ng_max(v0, v1);',
    'let v11: bool = ng_truth(v0);',
    'let v12: f32 = ng_saturate(v0);',
    'let v13: f32 = ng_step(v0, v1);',
    'let v14: f32 = ng_sign(v0);',
    'let v15: i32 = ng_f2i(v0);',
    'let v16: u32 = ng_f2u(v0);',
    'let v17: f32 = ng_i2f(v3);',
    'let v18: f32 = ng_u2f(v4);',
    'let v19: f32 = ng_sqrt(v0);',
    'let v20: f32 = ng_rsqrt(v0);',
    'let v21: f32 = ng_exp(v0);',
    'let v22: f32 = ng_exp2(v0);',
    'let v23: f32 = ng_log(v0);',
    'let v24: f32 = ng_log2(v0);',
    'let v25: f32 = ng_sin(v0);',
    'let v26: f32 = ng_cos(v0);',
    'let v27: f32 = ng_tan(v0);',
    'let v28: f32 = ng_asin(v0);',
    'let v29: f32 = ng_acos(v0);',
    'let v30: f32 = ng_atan(v0);',
    'let v31: f32 = ng_atan2(v0, v1);',
    'let v32: f32 = ng_pow(v0, v1);',
    'let v33: f32 = ng_lengthx3(v5);',
    'let v34: vec3<f32> = ng_normalizex3(v5);',
    'let v35: f32 = ng_floor(v0);',
    'let v36: f32 = ng_ceil(v0);',
    'let v37: f32 = ng_trunc(v0);',
    'let v38: f32 = ng_round(v0);',
    'let v39: f32 = ng_fract(v0);',
  ))
  const helpers: { readonly [name: string]: string } = {
    ng_nan: lines(
      'fn ng_nan(x: f32) -> bool {',
      '  return (bitcast<u32>(x) & 0x7fffffffu) > 0x7f800000u;',
      '}',
    ),
    ng_truth: lines(
      'fn ng_truth(x: f32) -> bool {',
      '  return (bitcast<u32>(x) & 0x7fffffffu) != 0u;',
      '}',
    ),
    ng_min: lines(
      'fn ng_min(a: f32, b: f32) -> f32 {',
      '  return select(a, b, ng_nan(a) | (!ng_nan(b) & (b < a)));',
      '}',
    ),
    ng_max: lines(
      'fn ng_max(a: f32, b: f32) -> f32 {',
      '  return select(a, b, ng_nan(a) | (!ng_nan(b) & (b > a)));',
      '}',
    ),
    ng_saturate: lines(
      'fn ng_saturate(x: f32) -> f32 {',
      '  let m: f32 = select(0.0, x, (x >= 0.0) & !ng_nan(x));',
      '  return select(1.0, m, m <= 1.0);',
      '}',
    ),
    ng_step: lines(
      'fn ng_step(e: f32, x: f32) -> f32 {',
      '  return select(0.0, 1.0, ((e <= x) & !ng_nan(e)) & !ng_nan(x));',
      '}',
    ),
    ng_sign: lines(
      'fn ng_sign(x: f32) -> f32 {',
      '  return select(select(select(0.0, -1.0, x < 0.0), 1.0, x > 0.0), 0.0, ng_nan(x));',
      '}',
    ),
    ng_floor: lines(
      'fn ng_floor(x: f32) -> f32 {',
      '  let u: u32 = bitcast<u32>(x);',
      '  let r: u32 = bitcast<u32>(floor(x));',
      '  return select(x, bitcast<f32>((r & 0x7fffffffu) | (u & 0x80000000u)), (u & 0x7fffffffu) < 0x4b000000u);',
      '}',
    ),
    ng_ceil: lines(
      'fn ng_ceil(x: f32) -> f32 {',
      '  let u: u32 = bitcast<u32>(x);',
      '  let r: u32 = bitcast<u32>(ceil(x));',
      '  return select(x, bitcast<f32>((r & 0x7fffffffu) | (u & 0x80000000u)), (u & 0x7fffffffu) < 0x4b000000u);',
      '}',
    ),
    ng_trunc: lines(
      'fn ng_trunc(x: f32) -> f32 {',
      '  let u: u32 = bitcast<u32>(x);',
      '  let r: u32 = bitcast<u32>(trunc(x));',
      '  return select(x, bitcast<f32>((r & 0x7fffffffu) | (u & 0x80000000u)), (u & 0x7fffffffu) < 0x4b000000u);',
      '}',
    ),
    ng_round: lines(
      'fn ng_round(x: f32) -> f32 {',
      '  let u: u32 = bitcast<u32>(x);',
      '  let r: u32 = bitcast<u32>(round(x));',
      '  return select(x, bitcast<f32>((r & 0x7fffffffu) | (u & 0x80000000u)), (u & 0x7fffffffu) < 0x4b000000u);',
      '}',
    ),
    ng_fract: lines(
      'fn ng_fract(x: f32) -> f32 {',
      '  let u: u32 = bitcast<u32>(x);',
      '  let m: u32 = u & 0x7fffffffu;',
      '  let d: f32 = x - floor(x);',
      '  let r0: f32 = select(d, 0.0, ((bitcast<u32>(d) & 0x7fffffffu) == 0u) | (m >= 0x4b000000u));',
      '  let e: u32 = m >> 23u;',
      '  let a: u32 = select(m & 0x7fffffu, (m & 0x7fffffu) | 0x800000u, e != 0u);',
      '  let s: u32 = min(select(125u, 126u - e, e != 0u), 31u);',
      '  let q: u32 = a >> s;',
      '  let rest: u32 = a & ((1u << s) - 1u);',
      '  let half: u32 = 1u << (s - 1u);',
      '  let n: u32 = q + select(0u, 1u, (rest > half) | ((rest == half) & ((q & 1u) == 1u)));',
      '  let r1: f32 = bitcast<f32>(0x3f800000u - n);',
      '  let neg: bool = (u > 0x80000000u) & (m < 0x3f000000u);',
      '  return select(select(r0, r1, neg), bitcast<f32>(u | 0x7fc00000u), m >= 0x7f800000u);',
      '}',
    ),
    ng_f2i: lines(
      'fn ng_f2i(x: f32) -> i32 {',
      '  let u: u32 = bitcast<u32>(x);',
      '  let t: i32 = i32(clamp(x, -2147483648.0, 2147483520.0));',
      '  let r: i32 = select(t, select(2147483647i, bitcast<i32>(0x80000000u), u >= 0x80000000u), (u & 0x7fffffffu) >= 0x4f000000u);',
      '  return select(r, 0i, ng_nan(x));',
      '}',
    ),
    ng_f2u: lines(
      'fn ng_f2u(x: f32) -> u32 {',
      '  let u: u32 = bitcast<u32>(x);',
      '  let t: u32 = u32(clamp(x, 0.0, 4294967040.0));',
      '  return select(select(t, 4294967295u, u >= 0x4f800000u), 0u, (u >= 0x80000000u) | ng_nan(x));',
      '}',
    ),
    ng_u2f: lines(
      'fn ng_u2f(i: u32) -> f32 {',
      '  let n: u32 = 31u - countLeadingZeros(i);',
      '  let sr: u32 = select(0u, n - 23u, n > 23u);',
      '  let sl: u32 = select(0u, 23u - n, n < 23u);',
      '  let q: u32 = (i >> sr) << sl;',
      '  let rest: u32 = i & ((1u << sr) - 1u);',
      '  let half: u32 = (1u << sr) >> 1u;',
      '  let up: bool = (rest > half) | (((rest == half) & (sr != 0u)) & ((q & 1u) == 1u));',
      '  let b: u32 = (((n + 126u) << 23u) + q) + select(0u, 1u, up);',
      '  return select(bitcast<f32>(b), 0.0, i == 0u);',
      '}',
    ),
    ng_i2f: lines(
      'fn ng_i2f(i: i32) -> f32 {',
      '  let u: u32 = bitcast<u32>(i);',
      '  let s: u32 = u & 0x80000000u;',
      '  let m: u32 = select(u, 0u - u, s != 0u);',
      '  return bitcast<f32>(bitcast<u32>(ng_u2f(m)) | s);',
      '}',
    ),
    ng_sqrt: lines(
      'fn ng_sqrt(x: f32) -> f32 {',
      '  let u: u32 = bitcast<u32>(x);',
      '  let q: f32 = bitcast<f32>(ng_h.zero | 0x7fc00000u);',
      '  let keep: bool = ((u & 0x7fffffffu) == 0u) | (u == 0x7f800000u);',
      '  return select(select(sqrt(x), x, keep), q, (u > 0x7f800000u) & (u != 0x80000000u));',
      '}',
    ),
    ng_rsqrt: lines(
      'fn ng_rsqrt(x: f32) -> f32 {',
      '  let u: u32 = bitcast<u32>(x);',
      '  let q: f32 = bitcast<f32>(ng_h.zero | 0x7fc00000u);',
      '  let z: bool = (u & 0x7fffffffu) == 0u;',
      '  return select(select(select(inverseSqrt(x), 0.0, u == 0x7f800000u), bitcast<f32>(u | 0x7f800000u), z), q, (u > 0x7f800000u) & (u != 0x80000000u));',
      '}',
    ),
    ng_exp: lines(
      'fn ng_exp(x: f32) -> f32 {',
      '  let u: u32 = bitcast<u32>(x);',
      '  return select(select(exp(x), x, ng_nan(x) | (u == 0x7f800000u)), 0.0, u == 0xff800000u);',
      '}',
    ),
    ng_exp2: lines(
      'fn ng_exp2(x: f32) -> f32 {',
      '  let u: u32 = bitcast<u32>(x);',
      '  return select(select(exp2(x), x, ng_nan(x) | (u == 0x7f800000u)), 0.0, u == 0xff800000u);',
      '}',
    ),
    ng_log: lines(
      'fn ng_log(x: f32) -> f32 {',
      '  let u: u32 = bitcast<u32>(x);',
      '  let q: f32 = bitcast<f32>(ng_h.zero | 0x7fc00000u);',
      '  let z: bool = (u & 0x7fffffffu) == 0u;',
      '  return select(select(select(log(x), x, u == 0x7f800000u), bitcast<f32>(u | 0xff800000u), z), q, (u > 0x7f800000u) & (u != 0x80000000u));',
      '}',
    ),
    ng_log2: lines(
      'fn ng_log2(x: f32) -> f32 {',
      '  let u: u32 = bitcast<u32>(x);',
      '  let q: f32 = bitcast<f32>(ng_h.zero | 0x7fc00000u);',
      '  let z: bool = (u & 0x7fffffffu) == 0u;',
      '  return select(select(select(log2(x), x, u == 0x7f800000u), bitcast<f32>(u | 0xff800000u), z), q, (u > 0x7f800000u) & (u != 0x80000000u));',
      '}',
    ),
    ng_sin: lines(
      'fn ng_sin(x: f32) -> f32 {',
      '  let q: f32 = bitcast<f32>(ng_h.zero | 0x7fc00000u);',
      '  return select(sin(x), q, (bitcast<u32>(x) & 0x7fffffffu) >= 0x7f800000u);',
      '}',
    ),
    ng_cos: lines(
      'fn ng_cos(x: f32) -> f32 {',
      '  let q: f32 = bitcast<f32>(ng_h.zero | 0x7fc00000u);',
      '  return select(cos(x), q, (bitcast<u32>(x) & 0x7fffffffu) >= 0x7f800000u);',
      '}',
    ),
    ng_tan: lines(
      'fn ng_tan(x: f32) -> f32 {',
      '  let q: f32 = bitcast<f32>(ng_h.zero | 0x7fc00000u);',
      '  return select(tan(x), q, (bitcast<u32>(x) & 0x7fffffffu) >= 0x7f800000u);',
      '}',
    ),
    ng_asin: lines(
      'fn ng_asin(x: f32) -> f32 {',
      '  let q: f32 = bitcast<f32>(ng_h.zero | 0x7fc00000u);',
      '  return select(asin(x), q, (bitcast<u32>(x) & 0x7fffffffu) > 0x3f800000u);',
      '}',
    ),
    ng_acos: lines(
      'fn ng_acos(x: f32) -> f32 {',
      '  let q: f32 = bitcast<f32>(ng_h.zero | 0x7fc00000u);',
      '  return select(acos(x), q, (bitcast<u32>(x) & 0x7fffffffu) > 0x3f800000u);',
      '}',
    ),
    ng_atan: lines(
      'fn ng_atan(x: f32) -> f32 {',
      '  let u: u32 = bitcast<u32>(x);',
      '  return select(select(atan(x), bitcast<f32>((u & 0x80000000u) | 0x3fc90fdbu), (u & 0x7fffffffu) == 0x7f800000u), x, ng_nan(x));',
      '}',
    ),
    ng_atan2: lines(
      'fn ng_atan2(y: f32, x: f32) -> f32 {',
      '  let uy: u32 = bitcast<u32>(y);',
      '  let ux: u32 = bitcast<u32>(x);',
      '  let q: f32 = bitcast<f32>(ng_h.zero | 0x7fc00000u);',
      '  let sy: u32 = uy & 0x80000000u;',
      '  let pi: f32 = bitcast<f32>(sy | 0x40490fdbu);',
      '  let hp: f32 = bitcast<f32>(sy | 0x3fc90fdbu);',
      '  let r0: f32 = select(atan2(y, x), hp, (ux & 0x7fffffffu) == 0u);',
      '  let r1: f32 = select(r0, select(y, pi, ux >= 0x80000000u), (uy & 0x7fffffffu) == 0u);',
      '  return select(r1, q, ng_nan(y) | ng_nan(x));',
      '}',
    ),
    ng_pow: lines(
      'fn ng_pow(a: f32, b: f32) -> f32 {',
      '  let ua: u32 = bitcast<u32>(a);',
      '  let ub: u32 = bitcast<u32>(b);',
      '  let ma: u32 = ua & 0x7fffffffu;',
      '  let mb: u32 = ub & 0x7fffffffu;',
      '  let an: bool = ua >= 0x80000000u;',
      '  let bn: bool = ub >= 0x80000000u;',
      '  let q: f32 = bitcast<f32>(ng_h.zero | 0x7fc00000u);',
      '  let whole: bool = trunc(b) == b;',
      '  let odd: bool = ((mb < 0x4b800000u) & whole) & ((u32(abs(b)) & 1u) == 1u);',
      '  let p: f32 = pow(abs(a), b);',
      '  let r0: f32 = select(p, -p, an & odd);',
      '  let r1: f32 = select(r0, q, an & !whole);',
      '  let big: u32 = select(0u, 0x7f800000u, (ma > 0x3f800000u) != bn);',
      '  let r2: f32 = select(r1, select(bitcast<f32>(big), q, ma == 0x3f800000u), mb == 0x7f800000u);',
      '  let edge: u32 = select(0u, 0x80000000u, an & odd) | select(0u, 0x7f800000u, (ma == 0x7f800000u) != bn);',
      '  let r3: f32 = select(r2, bitcast<f32>(edge), (ma == 0x7f800000u) | (ma == 0u));',
      '  let r4: f32 = select(r3, q, ma > 0x7f800000u);',
      '  let r5: f32 = select(r4, 1.0, mb == 0u);',
      '  return select(r5, q, mb > 0x7f800000u);',
      '}',
    ),
    ng_lengthx3: lines(
      'fn ng_lengthx3(v: vec3<f32>) -> f32 {',
      '  let m: vec3<u32> = bitcast<vec3<u32>>(v) & vec3<u32>(0x7fffffffu);',
      '  let q: f32 = bitcast<f32>(ng_h.zero | 0x7fc00000u);',
      '  let inf: f32 = bitcast<f32>(ng_h.zero | 0x7f800000u);',
      '  let r0: f32 = select(length(v), 0.0, all(m == vec3<u32>(0u)));',
      '  return select(select(r0, inf, any(m == vec3<u32>(0x7f800000u))), q, any(m > vec3<u32>(0x7f800000u)));',
      '}',
    ),
    ng_normalizex3: lines(
      'fn ng_normalizex3(v: vec3<f32>) -> vec3<f32> {',
      '  let u: vec3<u32> = bitcast<vec3<u32>>(v);',
      '  let m: vec3<u32> = u & vec3<u32>(0x7fffffffu);',
      '  let q: vec3<f32> = vec3<f32>(bitcast<f32>(ng_h.zero | 0x7fc00000u));',
      '  let inf: vec3<bool> = m == vec3<u32>(0x7f800000u);',
      '  let r0: vec3<f32> = select(normalize(v), select(bitcast<vec3<f32>>(u & vec3<u32>(0x80000000u)), q, inf), any(inf));',
      '  return select(r0, q, any(m > vec3<u32>(0x7f800000u)) | all(m == vec3<u32>(0u)));',
      '}',
    ),
  }
  assert.deepEqual(fnNames(code), [...Object.keys(helpers), 'ng_body', 'ng_compute'])
  for (const [name, text] of Object.entries(helpers)) assert.equal(fnText(code, name), text, name)
})

test('a vector helper is named by its lanes as Lens names vectors, so no family takes another family\'s name', () => {
  const code = wgsl(widths())
  // exp of two lanes beside exp2 of one, log beside log2, atan beside atan2.
  assert.deepEqual(fnNames(code), ['ng_nan', 'ng_nanx2', 'ng_nanx3', 'ng_min', 'ng_minx3', 'ng_expx2', 'ng_exp2', 'ng_logx2', 'ng_log2', 'ng_atanx2', 'ng_atan2', 'ng_body', 'ng_compute'])
  assert.equal(fnText(code, 'ng_minx3'), lines(
    'fn ng_minx3(a: vec3<f32>, b: vec3<f32>) -> vec3<f32> {',
    '  return select(a, b, ng_nanx3(a) | (!ng_nanx3(b) & (b < a)));',
    '}',
  ))
  assert.equal(fnText(code, 'ng_nanx3'), lines(
    'fn ng_nanx3(x: vec3<f32>) -> vec3<bool> {',
    '  return (bitcast<vec3<u32>>(x) & vec3<u32>(0x7fffffffu)) > vec3<u32>(0x7f800000u);',
    '}',
  ))
})

test('min and max take a cheaper form beside a value known not to be NaN; f32 clamp is max then min, integer clamp min(max())', () => {
  assert.equal(ops(wgsl(minmax())), lines(
    'let v9: f32 = 2.0;',
    'let v10: f32 = ng_min(v0, v1);',
    'let v11: f32 = select(v0, v9, ng_nan(v0) | (v9 > v0));',
    'let v12: f32 = select(v9, v0, !ng_nan(v0) & (v0 < v9));',
    'let v13: f32 = 3.0;',
    'let v14: f32 = select(v9, v13, v13 > v9);',
    'let ng_t0: f32 = ng_max(v0, v1);',
    'let v15: f32 = ng_min(ng_t0, v2);',
    'let v16: f32 = 0.0;',
    'let v17: f32 = 1.0;',
    'let ng_t1: f32 = select(v0, v16, ng_nan(v0) | (v16 > v0));',
    'let v18: f32 = select(ng_t1, v17, v17 < ng_t1);',
    'let v19: i32 = 0i;',
    'let v20: i32 = 9i;',
    'let v21: i32 = min(max(v3, v19), v20);',
  ))
})

test('casts: saturating f32 to integer, exact integer to f32, number to bool by "not zero", i32 and u32 by their bits', () => {
  assert.equal(ops(wgsl(casts())), lines(
    'let v9: i32 = ng_f2i(v0);',
    'let v10: u32 = ng_f2u(v0);',
    'let v11: bool = ng_truth(v0);',
    'let v12: f32 = ng_i2f(v3);',
    'let v13: u32 = bitcast<u32>(v3);',
    'let v14: bool = v3 != 0i;',
    'let v15: f32 = ng_u2f(v4);',
    'let v16: i32 = bitcast<i32>(v4);',
    'let v17: bool = v4 != 0u;',
    'let v18: bool = true;',
    'let v19: f32 = select(0.0, 1.0, v18);',
    'let v20: i32 = select(0i, 1i, v18);',
    'let v21: u32 = select(0u, 1u, v18);',
    'let v22: vec2<i32> = ng_f2ix2(v7);',
    'let v23: u32 = bitcast<u32>(v0);',
    'let v24: f32 = bitcast<f32>(v4);',
  ))
})

test('arithmetic: float rem, mix and smoothstep written out, fract, the roundings, abs and neg on bits, the library behind its edges, a shortcut where no edge can come', () => {
  assert.equal(ops(wgsl(arithmetic())), lines(
    'let v9: f32 = v0 + v1;',
    'let v10: vec3<f32> = v5 - v0;',
    'let v11: f32 = v0 * v1;',
    'let v12: f32 = v0 / v1;',
    'let v13: i32 = v3 / v3;',
    'let v14: i32 = v3 % v3;',
    'let v15: u32 = v4 % v4;',
    'let ng_t0: f32 = v0 / v1;',
    'let ng_t1: f32 = trunc(ng_t0);',
    'let ng_t2: f32 = v1 * ng_t1;',
    'let v16: f32 = v0 - ng_t2;',
    'let ng_t3: vec3<f32> = v5 / v0;',
    'let ng_t4: vec3<f32> = trunc(ng_t3);',
    'let ng_t5: vec3<f32> = v0 * ng_t4;',
    'let v17: vec3<f32> = v5 - ng_t5;',
    'let v18: f32 = ng_fract(v0);',
    'let ng_t6: f32 = 1.0 - v0;',
    'let ng_t7: vec3<f32> = v5 * ng_t6;',
    'let ng_t8: vec3<f32> = v6 * v0;',
    'let v19: vec3<f32> = ng_t7 + ng_t8;',
    'let ng_t9: f32 = v2 - v0;',
    'let ng_t10: f32 = v1 - v0;',
    'let ng_t11: f32 = ng_t9 / ng_t10;',
    'let ng_t12: f32 = ng_saturate(ng_t11);',
    'let ng_t13: f32 = ng_t12 * ng_t12;',
    'let ng_t14: f32 = 2.0 * ng_t12;',
    'let ng_t15: f32 = 3.0 - ng_t14;',
    'let v20: f32 = ng_t13 * ng_t15;',
    'let v21: f32 = fma(v0, v1, v2);',
    'let v22: f32 = ng_pow(v0, v1);',
    'let v23: f32 = 2.0;',
    'let k24: u32 = 0x3f000000u;',
    'let v24: f32 = bitcast<f32>(k24);',
    'let v25: f32 = pow(v23, v24);',
    'let v26: f32 = ng_atan2(v0, v1);',
    'let v27: f32 = ng_step(v0, v1);',
    'let v28: f32 = ng_sign(v0);',
    'let v29: i32 = sign(v3);',
    'let v30: f32 = ng_exp(v0);',
    'let v31: f32 = 1.0;',
    'let v32: f32 = exp(v31);',
    'let v33: f32 = bitcast<f32>(bitcast<u32>(v0) & 0x7fffffffu);',
    'let ng_t16: f32 = v0 - v1;',
    'let v34: f32 = bitcast<f32>(bitcast<u32>(ng_t16) & 0x7fffffffu);',
    'let ng_t17: vec3<f32> = v5 - v6;',
    'let v35: f32 = ng_lengthx3(ng_t17);',
    'let v36: i32 = abs(v3);',
    'let v37: f32 = bitcast<f32>(bitcast<u32>(v0) ^ 0x80000000u);',
    'let v38: f32 = ng_floor(v0);',
    'let v39: f32 = ng_ceil(v0);',
    'let v40: f32 = ng_trunc(v0);',
    'let v41: f32 = ng_round(v0);',
  ))
})

test('logic, comparisons and bits: xor of bools as !=, the shifts and integer division WGSL defines for run-time operands', () => {
  assert.equal(ops(wgsl(logic())), lines(
    'let v9: bool = v0 < v1;',
    'let v10: bool = v3 >= v3;',
    'let v11: bool = v9 != v10;',
    'let v12: u32 = v4 ^ v4;',
    'let v13: u32 = v4 & v4;',
    'let v14: i32 = v3 | v3;',
    'let v15: bool = v9 & v10;',
    'let v16: bool = v9 | v10;',
    'let v17: bool = !v9;',
    'let v18: u32 = ~v4;',
    'let v19: u32 = v4 << v4;',
    'let v20: i32 = v3 >> v4;',
    'let v21: bool = v0 == v1;',
    'let v22: bool = v4 != v4;',
    'let v23: bool = v0 <= v1;',
    'let v24: bool = v3 > v3;',
  ))
})

test('geometry, building and picking: value-held lanes clamped into the vector, a grid chosen column by column', () => {
  assert.equal(ops(wgsl(geometry())), lines(
    'let v9: f32 = dot(v5, v6);',
    'let v10: vec3<f32> = cross(v5, v6);',
    'let v11: vec3<f32> = reflect(v5, v6);',
    'let v12: vec3<f32> = ng_normalizex3(v5);',
    'let v13: f32 = ng_lengthx3(v5);',
    'let v14: mat3x3<f32> = transpose(v8);',
    'let v15: vec3<f32> = v8 * v5;',
    'let v16: mat3x3<f32> = v8 * v8;',
    'let v17: vec3<f32> = v5 * v8;',
    'let v18: mat3x3<f32> = v8 * v0;',
    'let v19: vec4<f32> = vec4<f32>(v5, v0);',
    'let v20: vec3<f32> = vec3<f32>(v0);',
    'let v21: vec2<f32> = vec2<f32>(v0, v0);',
    'let v22: vec2<f32> = vec2<f32>(v0, v0);',
    'let v23: mat2x2<f32> = mat2x2<f32>(v21, v22);',
    'let v24: vec3<f32> = v19.zyx;',
    'let v25: f32 = v19.w;',
    'let ng_j0: u32 = min(v4, 2u);',
    'let v26: f32 = v5[ng_j0];',
    'let ng_j1: u32 = select(min(bitcast<u32>(v3), 2u), 0u, v3 < 0i);',
    'let v27: f32 = v5[ng_j1];',
    'let v28: vec3<f32> = v8[2u];',
    'let v29: vec3<bool> = v5 < v6;',
    'let v30: bool = any(v29);',
    'let v31: bool = all(v29);',
    'let v32: bool = v0 < v0;',
    'let v33: bool = v32;',
    'let v34: bool = v0 < v0;',
    'let v35: vec3<f32> = select(v6, v5, v34);',
    'let v36: vec3<f32> = select(v6, v5, v29);',
    'let v37: bool = v0 < v0;',
    'let v38: mat3x3<f32> = mat3x3<f32>(select(v8[0u], v8[0u], v37), select(v8[1u], v8[1u], v37), select(v8[2u], v8[2u], v37));',
  ))
})

test('variables, if and loop: one counter per depth, reset on entry, and a break at 65,536 iterations', () => {
  assert.equal(body(wgsl(control())), lines(
    'var ng_c0: u32;',
    'var ng_c1: u32;',
    'let v0: f32 = r0.f0;',
    'let v1: f32 = r0.f1;',
    'let v2: f32 = r0.f2;',
    'let v3: i32 = r0.f3;',
    'let v4: u32 = r0.f4;',
    'let v5: vec3<f32> = r0.f5;',
    'let v6: vec3<f32> = r0.f6;',
    'let v7: vec2<f32> = r0.f7;',
    'let v8: mat3x3<f32> = r0.f8;',
    'var x9: f32 = v0;',
    'var x10: u32 = u32();',
    'let v11: f32 = x9;',
    'let v12: f32 = 1.0;',
    'let v13: bool = v11 < v12;',
    'if (v13) {',
    '  let v14: f32 = 1.0;',
    '  x9 = v14;',
    '} else {',
    '  let v15: f32 = x9;',
    '  let k16: u32 = 0x3f000000u;',
    '  let v16: f32 = bitcast<f32>(k16);',
    '  let v17: f32 = v15 * v16;',
    '  x9 = v17;',
    '}',
    'ng_c0 = 0u;',
    'loop {',
    '  if (ng_c0 >= 65536u) {',
    '    break;',
    '  }',
    '  ng_c0 = ng_c0 + 1u;',
    '  let v18: u32 = x10;',
    '  let v19: u32 = 1u;',
    '  let v20: u32 = v18 + v19;',
    '  x10 = v20;',
    '  ng_c1 = 0u;',
    '  loop {',
    '    if (ng_c1 >= 65536u) {',
    '      break;',
    '    }',
    '    ng_c1 = ng_c1 + 1u;',
    '    let v21: u32 = x10;',
    '    let v22: bool = v21 > v4;',
    '    if (v22) {',
    '      break;',
    '    }',
    '    continue;',
    '  }',
    '  let v23: u32 = x10;',
    '  let v24: u32 = 10u;',
    '  let v25: bool = v23 >= v24;',
    '  if (v25) {',
    '    break;',
    '  }',
    '}',
    'ng_c0 = 0u;',
    'loop {',
    '  if (ng_c0 >= 65536u) {',
    '    break;',
    '  }',
    '  ng_c0 = ng_c0 + 1u;',
    '  let v26: f32 = x9;',
    '  let v27: f32 = 0.0;',
    '  let v28: bool = v26 < v27;',
    '  if (v28) {',
    '    return;',
    '  }',
    '  break;',
    '}',
  ))
})

test('statement behaviours: nothing is printed after an if whose branches both leave, however much follows', () => {
  assert.equal(body(wgsl(unreachable())), lines(
    'var ng_c0: u32;',
    'let v0: f32 = r0.f0;',
    'let v1: f32 = r0.f1;',
    'let v2: f32 = r0.f2;',
    'let v3: i32 = r0.f3;',
    'let v4: u32 = r0.f4;',
    'let v5: vec3<f32> = r0.f5;',
    'let v6: vec3<f32> = r0.f6;',
    'let v7: vec2<f32> = r0.f7;',
    'let v8: mat3x3<f32> = r0.f8;',
    'let v9: f32 = 0.0;',
    'let v10: bool = v0 < v9;',
    'ng_c0 = 0u;',
    'loop {',
    '  if (ng_c0 >= 65536u) {',
    '    break;',
    '  }',
    '  ng_c0 = ng_c0 + 1u;',
    '  if (v10) {',
    '    break;',
    '  } else {',
    '    continue;',
    '  }',
    '}',
    'if (v10) {',
    '  return;',
    '} else {',
    '  return;',
    '}',
  ))
})

test('blocks: structs with explicit alignment and size, the constants in the hidden block, indices clamped in', () => {
  assert.equal(wgsl(blocks()), lines(
    'struct B0 {',
    '  @align(4) @size(16) f0: f32,',
    '  @align(16) @size(16) f1: B1,',
    '  @align(16) @size(48) f2: array<vec4<f32>, 3>,',
    '  @align(16) @size(48) f3: mat3x3<f32>,',
    '  @align(4) @size(16) f4: f32,',
    '}',
    '',
    'struct B1 {',
    '  @align(4) @size(8) f0: f32,',
    '  @align(8) @size(8) f1: vec2<f32>,',
    '}',
    '',
    'struct B2 {',
    '  @align(4) @size(16) f0: u32,',
    '  @align(16) @size(64) f1: array<B3, 4>,',
    '}',
    '',
    'struct B3 {',
    '  @align(16) @size(12) f0: vec3<f32>,',
    '  @align(4) @size(4) f1: f32,',
    '}',
    '',
    'struct B4 {',
    '  @align(4) @size(32) f0: array<f32, 8>,',
    '}',
    '',
    'struct B5 {',
    '  @align(4) @size(16) f0: f32,',
    '  @align(16) @size(16) f1: vec3<f32>,',
    '}',
    '',
    'struct NgHidden {',
    '  @size(128) c: B5,',
    '  lim: array<vec4<u32>, 4>,',
    '  none: u32,',
    '  checked: u32,',
    '  base: i32,',
    '  zero: u32,',
    '}',
    '',
    '@group(3) @binding(0) var<uniform> ng_h: NgHidden;',
    '@group(0) @binding(0) var<uniform> r0: B0;',
    '@group(1) @binding(0) var<storage, read> r1: B2;',
    '@group(1) @binding(1) var<storage, read_write> r2: B4;',
    '',
    'fn ng_body() {',
    '  let v0: u32 = r1.f0;',
    '  let v1: i32 = bitcast<i32>(v0);',
    '  let ng_j0: u32 = select(min(bitcast<u32>(v1), 3u), 0u, v1 < 0i);',
    '  let v2: f32 = r1.f1[ng_j0].f1;',
    '  let ng_j1: u32 = min(v0, 2u);',
    '  let v3: vec4<f32> = r0.f2[ng_j1];',
    '  let v4: f32 = ng_h.c.f0;',
    '  let v5: f32 = v3.x;',
    '  let v6: f32 = v4 * v5;',
    '  let v7: f32 = v2 + v6;',
    '  let ng_j2: u32 = min(v0, 7u);',
    '  r2.f0[ng_j2] = v7;',
    '  let v8: f32 = r0.f1.f0;',
    '  let v9: f32 = r0.f4;',
    '  let v10: f32 = v8 + v9;',
    '  r2.f0[7u] = v10;',
    '}',
    '',
    '@compute @workgroup_size(1, 1, 1) fn ng_compute() {',
    '  ng_body();',
    '}',
  ))
})

test('the compute entry takes each builtin used and copies it into a private for the body', () => {
  assert.equal(wgsl(entry()), lines(
    'struct B0 {',
    '  @align(4) @size(16) f0: array<u32, 4>,',
    '}',
    '',
    '@group(0) @binding(0) var<storage, read_write> r0: B0;',
    'var<private> ng_global: vec3<u32>;',
    'var<private> ng_local: vec3<u32>;',
    'var<private> ng_group: vec3<u32>;',
    'var<private> ng_index: u32;',
    'var<private> ng_count: vec3<u32>;',
    '',
    'fn ng_body() {',
    '  let v0: vec3<u32> = ng_global;',
    '  let v1: u32 = v0.x;',
    '  let v2: vec3<u32> = ng_local;',
    '  let v3: u32 = v2.y;',
    '  let v4: u32 = v1 + v3;',
    '  let v5: vec3<u32> = ng_group;',
    '  let v6: u32 = v5.z;',
    '  let v7: u32 = ng_index;',
    '  let v8: u32 = v6 + v7;',
    '  let v9: u32 = v4 + v8;',
    '  let v10: vec3<u32> = ng_count;',
    '  let v11: u32 = v10.x;',
    '  let v12: u32 = v9 + v11;',
    '  r0.f0[0u] = v12;',
    '}',
    '',
    '@compute @workgroup_size(4, 2, 1) fn ng_compute(@builtin(global_invocation_id) ng_global_in: vec3<u32>, @builtin(local_invocation_id) ng_local_in: vec3<u32>, @builtin(workgroup_id) ng_group_in: vec3<u32>, @builtin(local_invocation_index) ng_index_in: u32, @builtin(num_workgroups) ng_count_in: vec3<u32>) {',
    '  ng_global = ng_global_in;',
    '  ng_local = ng_local_in;',
    '  ng_group = ng_group_in;',
    '  ng_index = ng_index_in;',
    '  ng_count = ng_count_in;',
    '  ng_body();',
    '}',
  ))
})

test('the hidden block is declared for a helper that makes a fresh NaN, and not when nothing needs it', () => {
  assert.equal(wgsl(hidden()), lines(
    'struct B0 {',
    '  @align(4) @size(4) f0: f32,',
    '}',
    '',
    'struct NgHidden {',
    '  @size(128) c: array<vec4<u32>, 8>,',
    '  lim: array<vec4<u32>, 4>,',
    '  none: u32,',
    '  checked: u32,',
    '  base: i32,',
    '  zero: u32,',
    '}',
    '',
    '@group(3) @binding(0) var<uniform> ng_h: NgHidden;',
    '@group(0) @binding(0) var<storage, read_write> r0: B0;',
    '',
    'fn ng_sqrt(x: f32) -> f32 {',
    '  let u: u32 = bitcast<u32>(x);',
    '  let q: f32 = bitcast<f32>(ng_h.zero | 0x7fc00000u);',
    '  let keep: bool = ((u & 0x7fffffffu) == 0u) | (u == 0x7f800000u);',
    '  return select(select(sqrt(x), x, keep), q, (u > 0x7f800000u) & (u != 0x80000000u));',
    '}',
    '',
    'fn ng_body() {',
    '  let v0: f32 = r0.f0;',
    '  let v1: f32 = ng_sqrt(v0);',
    '  r0.f0 = v1;',
    '}',
    '',
    '@compute @workgroup_size(1, 1, 1) fn ng_compute() {',
    '  ng_body();',
    '}',
  ))
  for (const name of ['small', 'literals', 'casts', 'logic', 'entry']) {
    const code = wgsl(CORPUS[name]())
    assert.ok(!code.includes('ng_h') && !code.includes('NgHidden'), name)
  }
})

test('a read-only storage block may be bound read_write, as its layout entry says', () => {
  const m = blocks()
  const code = toWgsl(m, optionsFor(m, { storage: [null, 'read_write', 'read_write', null] })).code
  assert.ok(code.includes('@group(1) @binding(0) var<storage, read_write> r1: B2;'))
})

// ---------------------------------------------------------------------------------------------------
// Layout

interface Member {
  readonly name: string
  /** The printed @align and @size, or 0 where none is printed. */
  readonly align: number
  readonly size: number
  readonly type: string
}

/** The structs of a printed module with their members' attributes. */
function parseStructs(code: string): Map<string, Member[]> {
  const structs = new Map<string, Member[]>()
  for (const m of code.matchAll(/^struct (\w+) \{\n((?: {2}.*\n)*?)\}$/gm)) {
    structs.set(m[1], m[2].trimEnd().split('\n').map((l) => {
      const p = /^ {2}(?:@align\((\d+)\) )?(?:@size\((\d+)\) )?(\w+): (.+),$/.exec(l)
      assert.ok(p !== null, l)
      return { name: p[3], align: p[1] === undefined ? 0 : Number(p[1]), size: p[2] === undefined ? 0 : Number(p[2]), type: p[4] }
    }))
  }
  return structs
}

const roundUp = (a: number, n: number): number => Math.ceil(n / a) * a

/** WGSL's own layout rules, applied to the printed types and attributes. */
class WgslLayout {
  private readonly structs: Map<string, Member[]>

  constructor(structs: Map<string, Member[]>) {
    this.structs = structs
  }

  /** WGSL's AlignOf and SizeOf of a printed type. */
  place(type: string): { readonly align: number; readonly size: number } {
    if (/^(f32|i32|u32)$/.test(type)) return { align: 4, size: 4 }
    const vec = /^vec([234])<(f32|i32|u32)>$/.exec(type)
    if (vec !== null) return { align: vec[1] === '2' ? 8 : 16, size: 4 * Number(vec[1]) }
    const grid = /^mat([234])x\1<f32>$/.exec(type)
    if (grid !== null) {
      const col = this.place(`vec${grid[1]}<f32>`)
      return { align: col.align, size: Number(grid[1]) * roundUp(col.align, col.size) }
    }
    const arr = /^array<(.+), (\d+)>$/.exec(type)
    if (arr !== null) {
      const e = this.place(arr[1])
      return { align: e.align, size: Number(arr[2]) * roundUp(e.align, e.size) }
    }
    const s = this.struct(type)
    return { align: s.align, size: s.size }
  }

  /** A struct's member offsets, alignment and size: each member at the next multiple of its alignment. */
  struct(name: string): { readonly offsets: readonly number[]; readonly align: number; readonly size: number } {
    const members = this.structs.get(name)
    assert.ok(members !== undefined, `no struct ${name}`)
    let end = 0
    let align = 1
    const offsets: number[] = []
    for (const m of members) {
      const p = this.place(m.type)
      const a = m.align === 0 ? p.align : m.align
      const offset = roundUp(a, end)
      offsets.push(offset)
      end = offset + (m.size === 0 ? p.size : m.size)
      align = Math.max(align, a)
    }
    return { offsets, align, size: roundUp(align, end) }
  }
}

/** The WGSL name of a Lens number type. */
function typeName(t: ValueType): string {
  if (t === 'm2' || t === 'm3' || t === 'm4') return `mat${t[1]}x${t[1]}<f32>`
  const v = /^(f32|i32|u32)x([234])$/.exec(t)
  return v === null ? t : `vec${v[2]}<${v[1]}>`
}

/**
 * Checks a printed struct against the block it lowers, member by member and into every nested block and array: the
 * offsets, sizes and strides WGSL computes from the printed attributes are layoutBlock's and strideOf's, and WGSL
 * accepts the attributes (each alignment a multiple of what the space asks, each size at least the type's).
 */
function checkLayout(code: string, name: string, root: Block, space: Space): number {
  const structs = parseStructs(code)
  const w = new WgslLayout(structs)
  let checked = 0
  const visit = (sname: string, b: Block): void => {
    const members = structs.get(sname)
    assert.ok(members !== undefined && members.length === b.fields.length, sname)
    const ours = layoutBlock(b, space)
    const theirs = w.struct(sname)
    assert.deepEqual(theirs.offsets, ours.offsets, `${sname} offsets`)
    assert.equal(theirs.size, ours.size, `${sname} size`)
    b.fields.forEach((f, k) => {
      const m = members[k]
      assert.equal(m.name, `f${k}`)
      const p = w.place(m.type)
      const needs = space === 'uniform' && typeof f.type !== 'string' ? roundUp(16, p.align) : p.align
      assert.ok(m.align > 0 && m.align % needs === 0, `${sname}.${m.name}: @align(${m.align}) for ${m.type}`)
      assert.ok(m.size >= p.size, `${sname}.${m.name}: @size(${m.size}) for ${m.type}`)
      // In a uniform block a member after a struct starts at least the struct's size rounded to 16 later.
      if (space === 'uniform' && typeof f.type !== 'string' && 'struct' in f.type) assert.ok(m.size >= roundUp(16, p.size), `${sname}.${m.name}`)
      into(m.type, f.type)
      checked++
    })
  }
  const into = (type: string, t: DataType): void => {
    if (typeof t === 'string') {
      assert.equal(type, typeName(t))
      return
    }
    if ('struct' in t) {
      visit(type, t.struct)
      return
    }
    const arr = /^array<(.+), (\d+)>$/.exec(type)
    assert.ok(arr !== null && Number(arr[2]) === t.len, type)
    const e = w.place(arr[1])
    const stride = roundUp(e.align, e.size)
    assert.equal(stride, strideOf(t.array, space), `stride of ${type}`)
    if (space === 'uniform') assert.equal(stride % 16, 0, `uniform stride of ${type}`)
    into(arr[1], t.array)
  }
  visit(name, root)
  return checked
}

/** A seeded xorshift generator, so the random blocks and modules are the same on every run. */
function xorshift(seed: number): (n: number) => number {
  let s = seed >>> 0 || 1
  return (n: number): number => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s % n
  }
}

const NUMBERS: readonly DataType[] = ['f32', 'i32', 'u32', 'f32x2', 'i32x2', 'u32x2', 'f32x3', 'i32x3', 'u32x3', 'f32x4', 'i32x4', 'u32x4', 'm2', 'm3', 'm4']
/** Array elements a uniform block can step 16 bytes or a multiple through. */
const WIDE: readonly DataType[] = ['f32x3', 'u32x3', 'f32x4', 'i32x4', 'u32x4', 'm2', 'm3', 'm4']

function randomBlock(r: (n: number) => number, space: Space, depth: number): Block {
  const element = (): DataType => (space === 'uniform' && r(4) > 0 ? WIDE[r(WIDE.length)] : NUMBERS[r(NUMBERS.length)])
  const fields = Array.from({ length: 1 + r(6) }, (_, k) => {
    const pick = depth >= 3 ? 0 : r(10)
    const type: DataType = pick < 5 ? NUMBERS[r(NUMBERS.length)]
      : pick < 7 ? { array: element(), len: 1 + r(4) }
        : pick < 8 ? { struct: randomBlock(r, space, depth + 1) }
          : pick < 9 ? { array: { struct: randomBlock(r, space, depth + 1) }, len: 1 + r(3) }
            : { array: { array: element(), len: 1 + r(3) }, len: 1 + r(3) }
    return { name: `x${k}`, type }
  })
  return { fields }
}

test('layout: every printed offset, size and stride is layoutBlock\'s and strideOf\'s, for random blocks in both spaces', () => {
  const r = xorshift(0x5eed)
  const done = { uniform: 0, storage: 0, constants: 0 }
  let members = 0
  for (let k = 0; k < 600; k++) {
    const space: Space = k % 2 === 0 ? 'uniform' : 'storage'
    const spec = randomBlock(r, space, 0)
    let m: LensModule
    try {
      layoutBlock(spec, space)
      const b = lens('compute')
      if (space === 'storage') b.storage(0, 0, block(spec))
      else if (layoutBlock(spec, space).size <= LENS_LIMITS.constants && r(3) === 0) b.constants(block(spec))
      else b.uniform(0, 0, block(spec))
      m = b.finish()
    } catch (e) {
      // A block the space cannot hold is refused before any lowering; only the blocks a module can hold are compared.
      if (isFault(e, 'lens')) continue
      throw e
    }
    const res = m.resources[0]
    assert.ok(res.kind === 'uniform' || res.kind === 'storage' || res.kind === 'constants')
    members += checkLayout(wgsl(m), 'B0', res.block, space)
    done[res.kind]++
  }
  assert.ok(done.uniform >= 50 && done.storage >= 200 && done.constants >= 10, JSON.stringify(done))
  assert.ok(members >= 2000, `${members} members`)
  // The goldens' blocks too, nested blocks and arrays of structs included.
  const m = blocks()
  const [u, s, o, k] = m.resources
  const code = wgsl(m)
  assert.ok(u.kind === 'uniform' && s.kind === 'storage' && o.kind === 'storage' && k.kind === 'constants')
  checkLayout(code, 'B0', u.block, 'uniform')
  checkLayout(code, 'B2', s.block, 'storage')
  checkLayout(code, 'B4', o.block, 'storage')
  checkLayout(code, 'B5', k.block, 'uniform')
})

test('WGSL_HIDDEN is where the printed hidden block keeps each word', () => {
  assert.ok(Object.isFrozen(WGSL_HIDDEN))
  assert.deepEqual({ ...WGSL_HIDDEN }, { group: 3, binding: 0, constants: 0, lim: 128, none: 192, checked: 196, base: 200, zero: 204, size: 208, slot: 256 })
  for (const code of [wgsl(blocks()), wgsl(hidden())]) {
    const structs = parseStructs(code)
    assert.deepEqual(structs.get('NgHidden')?.map((m) => m.name), ['c', 'lim', 'none', 'checked', 'base', 'zero'])
    const s = new WgslLayout(structs).struct('NgHidden')
    assert.deepEqual(s.offsets, [WGSL_HIDDEN.constants, WGSL_HIDDEN.lim, WGSL_HIDDEN.none, WGSL_HIDDEN.checked, WGSL_HIDDEN.base, WGSL_HIDDEN.zero])
    assert.equal(s.size, WGSL_HIDDEN.size)
    assert.ok(code.includes(`@group(${WGSL_HIDDEN.group}) @binding(${WGSL_HIDDEN.binding}) var<uniform> ng_h: NgHidden;`))
  }
  assert.equal(WGSL_HIDDEN.lim - WGSL_HIDDEN.constants, LENS_LIMITS.constants)
  assert.ok(WGSL_HIDDEN.size <= WGSL_HIDDEN.slot && WGSL_HIDDEN.slot % 256 === 0)
})

// ---------------------------------------------------------------------------------------------------
// Literals

const bitsView = new DataView(new ArrayBuffer(4))
const hexOf = (x: number): string => {
  bitsView.setFloat32(0, x)
  return `0x${bitsView.getUint32(0).toString(16).padStart(8, '0')}u`
}

/** A compute module of one literal, written by hand so a value the builder would refuse reaches verify(). */
const oneLiteral = (t: ValueType, x: number): LensModule => ({ stage: 'compute', group: [1, 1, 1], inputs: [], outputs: [], resources: [], body: [{ op: 'lit', id: 0, t, v: [x] }], ids: 1 })
const NO_OPTIONS: WgslOptions = { storage: [], outputs: [], vertexRate: 0, live: null, arithmetic: 'native' }

test('literals over special values: decimal exactly where WGSL reads the decimal exactly, the bit pattern everywhere else', () => {
  const max = 3.4028234663852886e38
  const values = [0, -0, 1, -1, 0.5, -1.5, Math.fround(0.1), Math.fround(Math.PI), 2 ** -149, -(2 ** -149), 2 ** -126 - 2 ** -149, 2 ** -126,
    16777215, -16777215, 16777216, -16777216, 16777218, 2 ** 31, -(2 ** 31), max, -max]
  for (const x of values) {
    const got = body(toWgsl(oneLiteral('f32', x), NO_OPTIONS).code)
    if (Number.isInteger(x) && Math.abs(x) < 2 ** 24 && !Object.is(x, -0)) {
      assert.equal(got, lines(`let v0: f32 = ${x}.0;`), String(x))
      assert.ok(Object.is(Number(`${x}.0`), x))
    } else {
      assert.equal(got, lines(`let k0: u32 = ${hexOf(x)};`, 'let v0: f32 = bitcast<f32>(k0);'), String(x))
    }
  }
  const ints: [ValueType, number, string][] = [['i32', -2147483647, '-2147483647i'], ['i32', 2147483647, '2147483647i'], ['i32', 0, '0i'], ['u32', 0, '0u'], ['u32', 4294967295, '4294967295u'], ['bool', 1, 'true'], ['bool', 0, 'false']]
  for (const [t, x, text] of ints) assert.equal(body(toWgsl(oneLiteral(t, x), NO_OPTIONS).code), lines(`let v0: ${t} = ${text};`))
  assert.equal(body(toWgsl(oneLiteral('i32', -2147483648), NO_OPTIONS).code), lines('let k0: u32 = 0x80000000u;', 'let v0: i32 = bitcast<i32>(k0);'))
  // NaN and the infinities are no literals: verify() refuses them, so a fresh one is only ever made at run time.
  for (const x of [NaN, Infinity, -Infinity]) refused(() => toWgsl(oneLiteral('f32', x), NO_OPTIONS), 'lens', /is not a finite number exact in f32/)
})

// ---------------------------------------------------------------------------------------------------
// positionSure

/** A vertex module whose body `write` writes, with an input to write and a condition to branch on. */
function vertexWith(write: (b: LensBuilder, p: Val, c: () => Val) => void): LensModule {
  const b = lens('vertex')
  const p = b.input(0, 'f32x4')
  write(b, p, () => b.gt(b.pick(p, 'x'), 0))
  return b.finish()
}

test('positionSure: written at the top level or in both branches, never only in a loop, in one branch, or after a return', () => {
  const sure: [string, boolean, (b: LensBuilder, p: Val, c: () => Val) => void][] = [
    ['at the top level', true, (b, p) => b.position(p)],
    ['in both branches', true, (b, p, c) => b.if(c(), () => b.position(p), () => b.position(p))],
    ['in both branches of both branches', true, (b, p, c) => b.if(c(), () => b.if(c(), () => b.position(p), () => b.position(p)), () => b.position(p))],
    ['before an if that returns', true, (b, p, c) => { b.position(p); b.if(c(), () => b.return()) }],
    ['after a loop that holds no return', true, (b, p) => { b.loop(() => b.break()); b.position(p) }],
    ['in one branch only', false, (b, p, c) => b.if(c(), () => b.position(p))],
    ['in one branch, the other returning', false, (b, p, c) => { b.if(c(), () => b.return(), () => b.position(p)); b.position(p) }],
    ['only in a loop', false, (b, p) => b.loop(() => { b.position(p); b.break() })],
    ['after an if that returns', false, (b, p, c) => { b.if(c(), () => b.return()); b.position(p) }],
    ['after a loop that holds a return', false, (b, p, c) => { b.loop(() => { b.if(c(), () => b.return()); b.break() }); b.position(p) }],
    ['never', false, (b, p) => { b.add(p, p) }],
  ]
  for (const [name, want, write] of sure) assert.equal(positionSure(vertexWith(write)), want, name)
})

// ---------------------------------------------------------------------------------------------------
// Bounds

/** A module at the Lens bounds at once: if and loop 32 deep, 8064 bytes of variables, 64 fields, blocks 8 deep. */
function bounds(): LensModule {
  const b = lens('compute')
  const wide: { [name: string]: 'f32' } = {}
  for (let i = 0; i < LENS_LIMITS.fields; i++) wide[`g${i}`] = 'f32'
  let inner: Block = block(wide)
  for (let d = 0; d < 5; d++) inner = block({ pad: 'u32', s: inner })
  inner = block({ pad: 'u32', s: arrayOf(inner, 1) })
  const io = b.storage(0, 0, { deep: inner, r: arrayOf('u32', 8) }, { writable: true })
  // 125 m4 (64 bytes each), 15 f32 and one u32: 8064 bytes.
  const grids = Array.from({ length: 125 }, () => b.var('m4'))
  for (let k = 0; k < 15; k++) b.var('f32')
  const total = b.var('u32', 0)
  const nest = (d: number): void => {
    b.loop(() => {
      if (d < LENS_LIMITS.depth - 1) nest(d + 1)
      else b.set(total, b.add(b.get(total), 1))
      b.break()
    })
  }
  nest(0)
  b.write(io, ['r', 0], b.get(total))
  b.write(io, ['r', 1], b.bits(b.pick(b.column(b.get(grids[124]), 3), 'w'), 'u32'))
  b.write(io, ['r', 2], b.bits(b.read(io, 'deep', 's', 0, 's', 's', 's', 's', 's', 'g63'), 'u32'))
  return b.finish()
}

/** WGSL's composite nesting depth of a printed type: a vector 1, a grid 2, an array or struct one more than within. */
function nestingDepth(type: string, structs: Map<string, Member[]>): number {
  if (/^(f32|i32|u32|bool)$/.test(type)) return 0
  if (type.startsWith('vec')) return 1
  if (type.startsWith('mat')) return 2
  const arr = /^array<(.+), (\d+)>$/.exec(type)
  if (arr !== null) return 1 + nestingDepth(arr[1], structs)
  return 1 + Math.max(...(structs.get(type) ?? []).map((m) => nestingDepth(m.type, structs)))
}

/** The deepest nesting of braces in a text. */
function braceDepth(code: string): number {
  let depth = 0
  let most = 0
  for (const ch of code) {
    if (ch === '{') most = Math.max(most, ++depth)
    else if (ch === '}') depth--
  }
  assert.equal(depth, 0, 'the braces balance')
  return most
}

test('bounds: a module at every Lens bound at once stays within the WGSL bounds the lowering relies on', () => {
  const m = bounds()
  const code = wgsl(m)
  const all = code.split('\n')
  // 32 loop counters, one per depth, and with the module's variables exactly 8192 bytes of function variables.
  assert.deepEqual(all.filter((l) => l.startsWith('  var ng_c')), Array.from({ length: 32 }, (_, d) => `  var ng_c${d}: u32;`))
  const w = new WgslLayout(parseStructs(code))
  const bytes = body(code).split('\n').map((l) => /^ *var \w+: ([^ ;]+)/.exec(l)).filter((v) => v !== null).reduce((sum, v) => {
    const p = w.place(v[1])
    return sum + roundUp(p.align, p.size)
  }, 0)
  // WGSL holds a function's variables to 8192 bytes.
  assert.equal(bytes, LENS_LIMITS.varBytes + 128)
  // Braces: 32 levels of loops, each with its cap test, inside a function: within 32 * 2 + 3, under WGSL's 127.
  const depth = braceDepth(code)
  assert.ok(depth <= 32 * 2 + 3, `brace depth ${depth}`)
  // Struct members within 1023 (one struct holds all 64), composite nesting within 11, under WGSL's 15.
  const structs = parseStructs(code)
  assert.equal(Math.max(...[...structs.values()].map((s) => s.length)), LENS_LIMITS.fields)
  const deepest = Math.max(...[...structs.keys()].map((s) => nestingDepth(s, structs)))
  assert.ok(deepest <= 11, `composite nesting ${deepest}`)
  assert.ok(structs.size >= LENS_LIMITS.nesting)
})

// ---------------------------------------------------------------------------------------------------
// Refusals

function vertexModule(): LensModule {
  const b = lens('vertex')
  const p = b.input(0, 'f32x4')
  const k = b.add(b.builtin('vertex-index'), b.builtin('instance-index'))
  b.if(b.gt(k, 3), () => b.position(p), () => b.position(b.mul(p, 2)))
  return b.finish()
}

function fragmentModule(): LensModule {
  const b = lens('fragment')
  const uv = b.input(0, 'f32x2')
  const o = b.output(0, 'f32x4')
  const img = b.image(0, 0)
  const c = b.sample(img, b.sampler(0, 1), uv)
  const d = b.dx(b.pick(uv, 'x'))
  const fc = b.builtin('frag-coord')
  const tx = b.texel(img, b.cast(b.pick(fc, 'xy'), 'i32x2'))
  const e = b.extent(img)
  b.if(b.not(b.builtin('front-facing')), () => b.discard())
  b.out(o, b.add(b.mul(c, d), b.mul(tx, b.cast(b.pick(e, 'x'), 'f32'))))
  return b.finish()
}

function computeImages(): LensModule {
  const b = lens('compute')
  const img = b.image(0, 0)
  b.sampler(0, 1)
  const st = b.storageImage(0, 2, 'rgba8')
  const tx = b.texel(img, b.make('i32x2', b.i32(0)))
  b.put(st, b.make('i32x2', b.i32(1)), b.add(tx, b.cast(b.pick(b.extent(img), 'x'), 'f32')))
  return b.finish()
}

/** What is not lowered yet, each refused (Fault `device`) by name. */
const NOT_YET: readonly [string, () => LensModule, RegExp][] = [
  ['a vertex module', vertexModule, /^wgsl: the vertex entry is not yet lowered$/],
  ['a fragment module', fragmentModule, /^wgsl: the fragment entry is not yet lowered$/],
  ['images in a compute module', computeImages, /^wgsl: resources\[0\] image: images are not yet lowered$/],
  ['a sampler', () => { const b = lens('compute'); b.sampler(0, 0); return b.finish() }, /^wgsl: resources\[0\] sampler: images are not yet lowered$/],
  ['a storage image', () => { const b = lens('compute'); b.storageImage(0, 0, 'rgba8'); return b.finish() }, /^wgsl: resources\[0\] storage-image: images are not yet lowered$/],
  ['raw words', () => { const b = lens('compute'); b.storage(0, 0, { n: 'u32', xs: arrayOf('u32') }); return b.finish() },
    /^wgsl: resources\[0\] storage: a storage block that ends in an array without a length \(raw words\) is not yet lowered$/],
]

test('what is not lowered yet is refused by name, code device: the vertex and fragment entries, images, raw words, stepwise', () => {
  for (const [name, make, why] of NOT_YET) {
    const m = make()
    refused(() => toWgsl(m, optionsFor(m)), 'device', why, name)
  }
  const m = small()
  refused(() => toWgsl(m, optionsFor(m, { arithmetic: 'stepwise' })), 'device', /^wgsl: stepwise arithmetic is not yet lowered$/)
})

test('options that do not match the module are refused, code lens', () => {
  const m = small()
  const ok = optionsFor(m)
  const bad = (o: unknown, re: RegExp): void => refused(() => toWgsl(m, o as WgslOptions), 'lens', re)
  bad(null, /^wgsl: options: the options are an object$/)
  bad({ ...ok, storage: 'read' }, /storage is a list, one entry per resource/)
  bad({ ...ok, outputs: null }, /outputs is a list, one entry per colour slot/)
  bad({ ...ok, storage: [null, null] }, /resource 1 is a storage block; its access is read or read_write, not null/)
  bad({ ...ok, storage: [null] }, /resource 1 is a storage block; its access is read or read_write, not null/)
  bad({ ...ok, storage: [null, 'read'] }, /resource 1 is written, so its access is read_write/)
  bad({ ...ok, storage: ['read', 'read_write'] }, /resource 0 is a uniform, which takes no storage access/)
  bad({ ...ok, storage: [null, 'read_write', null] }, /storage has 3 entries, and the module 2 resources/)
  bad({ ...ok, outputs: ['f32'] }, /a compute module has no colour outputs/)
  bad({ ...ok, outputs: ['f16'] }, /an output kind is f32, i32, u32 or null/)
  bad({ ...ok, vertexRate: 1 }, /a compute module has no vertex inputs/)
  for (const v of [-1, 0.5, 0x10000, '0']) bad({ ...ok, vertexRate: v }, /vertexRate is a bit mask of the 16 input slots/)
  bad({ ...ok, live: 0 }, /a compute module carries no live value/)
  for (const v of [-1, 16, 1.5, '1']) bad({ ...ok, live: v }, /live is a location from 0 to 15, or null/)
  bad({ ...ok, arithmetic: 'fast' }, /arithmetic is native or stepwise/)
  // The same module and well-formed options lower.
  assert.equal(toWgsl(m, { ...ok, outputs: [null, null] }).code, wgsl(m))
})

test('a module verify() refuses is refused, code lens, before any lowering', () => {
  const none: LensModule = { stage: 'compute', group: [1, 1, 1], inputs: [], outputs: [], resources: [], body: [{ op: 'break' }], ids: 0 }
  refused(() => toWgsl(none, NO_OPTIONS), 'lens', /break is only inside a loop/)
  const mistyped: LensModule = { ...none, body: [{ op: 'lit', id: 0, t: 'f32', v: [1] }, { op: 'unary', id: 1, t: 'f32', fn: 'not', a: 0 }], ids: 2 }
  refused(() => toWgsl(mistyped, NO_OPTIONS), 'lens', /not takes a bool or bool vector, not f32/)
})

// ---------------------------------------------------------------------------------------------------
// Properties

/** The air gap's words (airgap.test.ts reads this file too, so each carries a `_` that this strips). */
const unmark = (s: string): string => s.replaceAll('_', '')
const DOORS: readonly RegExp[] = ['ev_al', 'Func_tion', 'WebAs_sembly', 'global_This', 'docu_ment', 'fe_tch', 'Da_te', 'setTime_out', 'setInter_val', 'queueMicro_task',
  'requestAnimation_Frame', 'XMLHttp_Request', 'Web_Socket', 'Wor_ker', 'local_Storage', 'session_Storage', 'indexed_DB', 'navi_gator', 'cry_pto', 'perfor_mance', 'Pro_mise',
  'as_ync', 'aw_ait', 'Shared_ArrayBuffer', 'Ato_mics', 'cons_ole', 'ran_dom', 'requ_ire', 'imp_ort'].map((w) => new RegExp(`\\b${unmark(w)}\\b`, 'i'))
const BANNED: readonly RegExp[] = ['qu_ake', 'g_ta', 'alp_ine', 'path_finder', 'busy_box', 'x_box', 'nint_endo', 'digital r_ain', 'noir_script', 'joy-?_cons?', 'vul_kan', 'khro_nos',
  'sp_ir', 'open_gl', 'direct_3d', 'dire_ctx', 'att_ack', 'ki_ll', 'wea_pon', 'sho_ot', 'g_un', 'viol_ence', 'inj_ur', 'dam_age'].map((w) => new RegExp(`\\b${unmark(w)}`, 'i'))
/** Not even inside a name: the folder's rule for these four. */
const ANYWHERE = new RegExp(['mat_rix', 'tar_get', 'win_dow', 'pro_cess'].map(unmark).join('|'), 'i')
/** A literal token, and a binary operator with a literal on each side (which a WGSL compiler would fold as a const-expression). */
const LIT = '(?:0x[0-9a-f]+u|-?\\d+(?:\\.\\d+)?[iu]?|true|false)'
const TWO_LITERALS = new RegExp(`(?<![\\w.])${LIT} (?:[-+*/%&|^]|<<|>>|[<>]=?|[!=]=) ${LIT}(?![\\w.(])`)

/** Instructions in a body, nested ones counted, and fields in a module's blocks, each counted where it is reached. */
function sizeOf(m: LensModule): number {
  const count = (insts: readonly Inst[]): number => insts.reduce((n, i) => n + 1 + (i.op === 'if' ? count(i.then) + count(i.else) : i.op === 'loop' ? count(i.body) : 0), 0)
  const fields = (t: DataType): number => (typeof t === 'string' ? 0 : 'array' in t ? fields(t.array) : t.struct.fields.reduce((n, f) => n + 1 + fields(f.type), 0))
  return count(m.body) + m.resources.reduce((n, r) => n + ('block' in r ? fields({ struct: r.block }) : 0), 0)
}

/** The text of a module's helpers: every function but the body and the entry. */
const helperText = (code: string): number => fnNames(code).filter((f) => f !== 'ng_body' && f !== 'ng_compute').reduce((n, f) => n + fnText(code, f).length, 0)

/** Checks the properties every printed module has. */
function properties(name: string, m: LensModule, code: string, helpersAtMost: number): void {
  assert.equal(code, wgsl(m), `${name}: the same text again`)
  assert.match(code, /^[\n\x20-\x7e]*\n$/, `${name}: printable ASCII and line feeds, ending in one`)
  assert.doesNotMatch(code, / \n|\n\n\n/, `${name}: no trailing space, no run of blank lines`)
  for (const re of [...DOORS, ...BANNED, ANYWHERE]) assert.doesNotMatch(code, re, `${name}: ${re.source}`)
  assert.ok(!code.includes('--'), `${name}: no -- token`)
  const two = TWO_LITERALS.exec(code)
  assert.equal(two, null, `${name}: an operation on two literals: ${two?.[0]}`)
  // Linear: the helpers at most all of them, everything else at most 4096 bytes per instruction and field.
  const h = helperText(code)
  assert.ok(h <= helpersAtMost, `${name}: helpers ${h}`)
  assert.ok(code.length - h <= 4096 * (sizeOf(m) + 1), `${name}: ${code.length - h} bytes for ${sizeOf(m)}`)
  braceDepth(code)
  // Functions: each declared once, each called, and every call to one of the lowering's names declared.
  const declared = fnNames(code)
  assert.equal(new Set(declared).size, declared.length, `${name}: a function declared twice`)
  for (const f of declared) if (f !== 'ng_compute') assert.ok(code.split(`${f}(`).length >= 3, `${name}: ${f} is never called`)
  for (const [, f] of code.matchAll(/\b(ng_\w+)\(/g)) assert.ok(declared.includes(f), `${name}: ${f} is called and not declared`)
  // Names: within each function every let and var once.
  for (const f of declared) {
    const names = [...fnText(code, f).matchAll(/^ *(?:let|var) (\w+):/gm)].map((v) => v[1])
    assert.equal(new Set(names).size, names.length, `${name}: ${f} declares a name twice`)
  }
  // The hidden block: declared exactly when a helper or the inline constants use it.
  const usesHidden = code.includes('ng_h.')
  const declaresHidden = code.includes('var<uniform> ng_h: NgHidden;')
  assert.equal(declaresHidden, usesHidden || m.resources.some((r) => r.kind === 'constants'), `${name}: the hidden block`)
  // Statement behaviours: nothing follows a return, break or continue in its block, nor an if whose branches both
  // end in one.
  const all = code.split('\n')
  const pad = (s: string): number => s.length - s.trimStart().length
  const jump = (at: number, p: number): boolean => /^ *(?:return|break|continue)\b[^;]*;$/.test(all[at]) && pad(all[at]) === p
  all.forEach((l, k) => {
    if (jump(k, pad(l))) {
      const next = all[k + 1]
      assert.ok(pad(next) < pad(l) && /^ *\}(?: else \{)?$/.test(next), `${name}:${k + 2}: ${next} follows ${l.trim()}`)
    }
    if (!/^ *if \(.*\) \{$/.test(l)) return
    const p = pad(l)
    let otherwise = -1
    let end = k + 1
    for (; all[end] !== `${' '.repeat(p)}}`; end++) if (all[end] === `${' '.repeat(p)}} else {`) otherwise = end
    if (otherwise > 0 && jump(otherwise - 1, p + 2) && jump(end - 1, p + 2)) {
      assert.ok(pad(all[end + 1]) < p && all[end + 1].trim() === '}', `${name}:${end + 2}: ${all[end + 1]} follows an if whose branches both leave`)
    }
  })
}

const SPECIAL = [0, -0, 1, -1, 0.5, 2 ** -149, -(2 ** -149), 2 ** -126, 16777216, -16777215, 3.4028234663852886e38, Math.fround(0.1)]

interface Pools {
  readonly f: Val[]
  readonly v: Val[]
  readonly i: Val[]
  readonly n: Val[]
  readonly c: Val[]
}

/** A well-typed random compute module: arithmetic, casts, choices, ifs, loops and writes over the unknowns. */
function randomModule(seed: number): LensModule {
  const r = xorshift(seed)
  const pick = <T>(xs: readonly T[]): T => xs[r(xs.length)]
  const b = lens('compute', { group: [1 + r(8), 1, 1] })
  const u = unknowns(b)
  const o = b.storage(1, 0, { out: arrayOf('f32', 4) }, { writable: true })
  const x = b.var('f32', u.a)
  const copy = (p: Pools): Pools => ({ f: [...p.f], v: [...p.v], i: [...p.i], n: [...p.n], c: [...p.c] })
  const floaty = (p: Pools): Val[] => (r(2) === 0 ? p.f : p.v)
  const gen = (p: Pools, depth: number, n: number): void => {
    for (let k = 0; k < n; k++) {
      const pool = floaty(p)
      switch (r(13)) {
        case 0: p.f.push(b.lit('f32', pick(SPECIAL))); break
        case 1: pool.push(b.unary(pick(['neg', 'abs', 'sign', 'floor', 'ceil', 'round', 'trunc', 'fract', 'sqrt', 'rsqrt', 'exp', 'exp2', 'log', 'log2', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'saturate'] as const), pick(pool))); break
        case 2: pool.push(b.binary(pick(['add', 'sub', 'mul', 'div', 'rem', 'min', 'max', 'pow', 'atan2', 'step'] as const), pick(pool), pick(pool))); break
        case 3: pool.push(b.ternary(pick(['mix', 'clamp', 'smoothstep', 'fma'] as const), pick(pool), pick(pool), pick(pool))); break
        case 4: {
          // A shift counts in u32; everything else takes two of one type.
          const ints = r(2) === 0 ? p.i : p.n
          const fn = pick(['add', 'sub', 'mul', 'div', 'rem', 'min', 'max', 'and', 'or', 'xor', 'shl', 'shr'] as const)
          ints.push(b.binary(fn, pick(ints), fn === 'shl' || fn === 'shr' ? pick(p.n) : pick(ints)))
          break
        }
        case 5: p.c.push(b.binary(pick(['lt', 'le', 'gt', 'ge', 'eq', 'ne'] as const), pick(p.f), pick(p.f))); break
        case 6: p.f.push(b.choose(pick(p.c), pick(p.f), pick(p.f))); break
        case 7: { const f = pick(p.f); p.i.push(b.cast(f, 'i32')); p.n.push(b.cast(f, 'u32')); p.f.push(b.cast(pick(p.i), 'f32'), b.cast(pick(p.n), 'f32')); break }
        case 8: p.f.push(b.length(pick(p.v)), b.dot(pick(p.v), pick(p.v))); p.v.push(b.normalize(pick(p.v)), b.make('f32x3', pick(p.f), b.pick(pick(p.v), 'zy'))); break
        case 9: if (depth < 4) b.if(pick(p.c), () => gen(copy(p), depth + 1, r(6)), () => gen(copy(p), depth + 1, r(4))); break
        case 10: if (depth < 4) b.loop(() => { gen(copy(p), depth + 1, r(6)); b.if(pick(p.c), () => b.break()) }); break
        case 11: b.set(x, pick(p.f)); p.f.push(b.get(x)); break
        default: b.write(o, ['out', pick(p.n)], pick(p.f))
      }
    }
  }
  gen({ f: [u.a, u.b, u.c], v: [u.v, u.w], i: [u.i], n: [u.n], c: [b.lt(u.a, u.b)] }, 0, 10 + r(60))
  return b.finish()
}

test('properties of every printed module: deterministic, ASCII, none of the air gap\'s words, linear in size, names declared once and used', () => {
  const most = helperText(wgsl(allHelpers()))
  for (const [name, make] of Object.entries(CORPUS)) {
    const code = wgsl(make())
    // A module built again the same way prints the same text.
    assert.equal(wgsl(make()), code, name)
    properties(name, make(), code, most)
  }
  properties('bounds', bounds(), wgsl(bounds()), most)
  for (let seed = 1; seed <= 60; seed++) {
    const m = randomModule(seed)
    const code = wgsl(m)
    assert.equal(wgsl(randomModule(seed)), code, `random ${seed}`)
    properties(`random ${seed}`, m, code, most)
  }
})

// ---------------------------------------------------------------------------------------------------
// Coverage

const OPS = ['lit', 'unary', 'binary', 'ternary', 'make', 'pick', 'lane', 'column', 'cast', 'bits', 'in', 'builtin', 'out', 'position', 'read', 'write',
  'sample', 'texel', 'put', 'extent', 'deriv', 'var', 'get', 'set', 'if', 'loop', 'break', 'continue', 'discard', 'return'] as const satisfies readonly Op[]
/** True only while OPS names every op Lens has: a new op fails the type check here until the table covers it. */
const EVERY_OP: [Exclude<Op, (typeof OPS)[number]>] extends [never] ? true : false = true

/** Everything a set of modules holds: ops, functions, builtins, resource kinds and stages. */
function census(modules: readonly LensModule[]): Set<string> {
  const seen = new Set<string>()
  const walk = (insts: readonly Inst[]): void => {
    for (const i of insts) {
      seen.add(`op ${i.op}`)
      if (i.op === 'unary' || i.op === 'binary' || i.op === 'ternary') seen.add(`${i.op} ${i.fn}`)
      if (i.op === 'builtin') seen.add(`builtin ${i.name}`)
      if (i.op === 'if') {
        walk(i.then)
        walk(i.else)
      } else if (i.op === 'loop') walk(i.body)
    }
  }
  for (const m of modules) {
    seen.add(`stage ${m.stage}`)
    for (const r of m.resources) seen.add(`resource ${r.kind}`)
    walk(m.body)
  }
  return seen
}

test('coverage: every op, function, builtin, resource kind and stage is lowered in a golden here, or refused by name', () => {
  assert.ok(EVERY_OP)
  const lowered = census(Object.values(CORPUS).map((make) => make()))
  const refusedHere = census(NOT_YET.map(([, make]) => make()))
  const later = new Set(['op in', 'op out', 'op position', 'op sample', 'op texel', 'op put', 'op extent', 'op deriv', 'op discard',
    'resource image', 'resource sampler', 'resource storage-image', 'stage vertex', 'stage fragment',
    'builtin vertex-index', 'builtin instance-index', 'builtin frag-coord', 'builtin front-facing'])
  const all = [...OPS.map((o) => `op ${o}`), ...UNARY.map((f) => `unary ${f}`), ...BINARY.map((f) => `binary ${f}`), ...TERNARY.map((f) => `ternary ${f}`),
    ...Object.keys(BUILTINS).map((n) => `builtin ${n}`), ...RESOURCE_KINDS.map((k) => `resource ${k}`), ...STAGES.map((s) => `stage ${s}`)]
  for (const key of all) {
    if (later.has(key)) assert.ok(refusedHere.has(key) && !lowered.has(key), `${key} is refused by name`)
    else assert.ok(lowered.has(key), `${key} is in a golden`)
  }
})
