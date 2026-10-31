// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins NoirScript's bytecode VM against the specification, value by value: i32 and u32
 * wrap, f32 is binary32 rounded after every operation (checked against Math.fround arithmetic in the test), integer
 * division by zero is a named error, casts saturate and reinterpret, shift counts are masked, vectors work lane-wise
 * with masks, select, compare and horizontals, morton2 round-trips, the bit intrinsics match reference formulas over
 * seeded values, arrays go by value, every index is bounds-checked, recursion and loops and shadowing and if-expressions
 * behave, globals and functions live across lines and may be redefined, and every bound (steps, output, depth, memory)
 * ends a runaway line with its named error while the session stays usable and ELITE_LIMITS raise it. The branchless
 * witness runs over a thousand seeded triples, and the `asm` listing is non-empty and deterministic.
 * What breaks if it is removed? An opcode could compute wrongly, a bound could stop working, or a line could leave
 * the session dead, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ELITE_LIMITS, EMPTY_TABLES, LIMITS, NoirSession, f32Text } from './index.ts'

const fresh = (): NoirSession => new NoirSession()
/** Runs one line and returns what it printed, failing the test on any error. */
const say = (s: NoirSession, src: string): string[] => {
  const r = s.run(src)
  assert.equal(r.error, undefined, `${src} -> ${r.error}`)
  return r.out
}
/** One line on a fresh session that prints exactly one line. */
const one = (src: string): string => {
  const out = say(fresh(), src)
  assert.equal(out.length, 1, `${src} printed ${out.length} lines`)
  return out[0]!
}
const err = (s: NoirSession, src: string): string => {
  const r = s.run(src)
  assert.ok(r.error !== undefined, `${src} should fail`)
  return r.error
}
const f = Math.fround

/**
 * Mulberry32, as 02_Define_The_Rules/property.ts has it, copied here because nothing in this folder may import from
 * outside it (the air gap holds for the tests too). Every case is reproducible from its seed and index.
 */
function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
}
const int32 = (g: () => number): number => (Math.floor(g() * 2 ** 32) | 0)
const uint32 = (g: () => number): number => Math.floor(g() * 2 ** 32) >>> 0

// ---------------------------------------------------------------------------------------------------
// Scalars

test('i32 and u32 wrap like hardware; division truncates toward zero; a zero divisor is a named error', () => {
  const s = fresh()
  assert.deepEqual(say(s, 'print(2147483647 + 1 == -2147483648, 0u - 1u == 4294967295u);'), ['true true'])
  assert.deepEqual(say(s, 'print(2147483647 + 1, -2147483648 - 1, 65536 * 65536, 2147483647 * 2, -2147483648 / -1, -2147483648 * -1, -(-2147483648));'), ['-2147483648 2147483647 0 -2 -2147483648 -2147483648 -2147483648'])
  assert.deepEqual(say(s, 'print(0u - 1u, 4294967295u + 1u, 4294967295u * 4294967295u, 3000000000u + 3000000000u, 4294967295u / 2u, 4294967295u % 10u);'), ['4294967295 0 1 1705032704 2147483647 5'])
  assert.deepEqual(say(s, 'print(123456789 * 987654321, 7 / 2, -7 / 2, 7 / -2, -7 % 2, 7 % -2, 7u / 2u, 7u % 3u);'), [`${Math.imul(123456789, 987654321)} 3 -3 -3 -1 1 3 1`])
  let m = 1
  for (let i = 0; i < 40; i++) m = Math.imul(m, 3)
  assert.deepEqual(say(s, 'let mut x = 2147483647; x += 1; print(x); let mut u = 0u; u -= 1u; print(u); let mut m = 1; for i in 0..40 { m *= 3; } print(m);'), ['-2147483648', '4294967295', String(m)])
  assert.deepEqual(say(s, 'print(-5 & 3, -5 | 3, -5 ^ 3, ~0, ~0u, 0xF0u & 0x3Cu, 6u ^ 3u);'), ['3 -5 -8 -1 4294967295 48 5'])
  for (const bad of ['1 / 0', '1 % 0', '1u / 0u', '1u % 0u', 'splat_i32x4(1) / i32x4(1, 0, 1, 1)', 'splat_u32x8(1u) % splat_u32x8(0u)', 'splat_i32x4(1) % splat_i32x4(0)']) {
    assert.equal(err(s, `print(${bad});`), 'division by zero', bad)
  }
  assert.deepEqual(say(s, 'let mut d = 0; print(1);'), ['1'], 'the session is usable after a division by zero')
})

test('f32 is binary32: every operation rounds through Math.fround, nothing fuses, and the text is the shortest round trip', () => {
  const s = fresh()
  // 0.1 + 0.2: the spec asks for whatever f32Text gives for fround(fround(0.1) + fround(0.2)), pinned both ways.
  const sum = f(f(0.1) + f(0.2))
  assert.equal(f32Text(sum), '0.3')
  assert.equal(sum, f(0.3), 'in binary32 the sum is 0.3 exactly, unlike the double')
  assert.deepEqual(say(s, 'print(0.1 + 0.2, 0.1 + 0.2 == 0.3, 1.0 / 3.0, 16777216.0 + 1.0, 16777216.0 + 2.0, 1e38 * 10.0, -1e38 * 10.0, 0.0 / 0.0, 1.0 / 0.0, -1.0 / 0.0);'),
    [`${f32Text(sum)} true ${f32Text(f(1 / 3))} 16777216 16777218 inf -inf NaN inf -inf`])
  // No fused multiply-add: x * x rounds to 1 + 2^-22 before the subtraction, so the result is exactly 0 (fused: 2^-46).
  assert.deepEqual(say(s, 'print(1.0000001 * 1.0000001 - 1.0000002);'), [f32Text(f(f(f(1.0000001) * f(1.0000001)) - f(1.0000002)))])
  assert.deepEqual(say(s, 'print(1.0000001 * 1.0000001 - 1.0000002);'), ['0'])
  // A thousand additions of 0.1 drift exactly as fround arithmetic drifts.
  let acc = 0
  for (let i = 0; i < 1000; i++) acc = f(acc + f(0.1))
  assert.deepEqual(say(s, 'let mut acc = 0.0; for i in 0..1000 { acc += 0.1; } print(acc, acc == 100.0);'), [`${f32Text(acc)} false`])
  assert.deepEqual(say(s, 'print(5.5 % 2.0, -5.5 % 2.0, 5.5 % -2.0, 1.0 % 0.0, 0.5 * 0.5, 2.0 - 3.0, -0.0, 0.0 == -0.0, 1e-45, 1e-46, 3.4028235e38, 3.5e38);'),
    ['1.5 -1.5 1.5 NaN 0.25 -1 0 true 1e-45 0 3.4028235e+38 inf'])
  assert.deepEqual(say(s, 'print(sqrt(2.0), sqrt(4.0), sqrt(-1.0), sqrt(0.0), floor(-1.5), ceil(-1.5), trunc(-1.5), floor(1.5), ceil(1.5), trunc(1.5), abs(-2.5), min(0.0 / 0.0, 1.0), max(1.0, 0.0 / 0.0), clamp(1.5, 0.0, 1.0));'),
    [`${f32Text(f(Math.sqrt(2)))} 2 NaN 0 -2 -1 -1 1 2 1 2.5 NaN NaN 1`])
  // f32Text: the shortest 1..9 digit decimal whose fround is the value; specials by name; signed zero as 0.
  assert.equal(f32Text(0.1), '0.1')
  assert.equal(f32Text(2), '2')
  assert.equal(f32Text(1.5), '1.5')
  assert.equal(f32Text(1 / 3), '0.33333334')
  assert.equal(f32Text(3.4028235e38), '3.4028235e+38')
  assert.equal(f32Text(123456789), '123456790')
  assert.equal(f32Text(16777217), '16777216')
  // Pinned decision: magnitudes below 1e-6 take exponent form as JS writes them (the spec names only huge values).
  assert.equal(f32Text(1e-7), '1e-7')
  assert.equal(f32Text(1e-6), '0.000001')
  assert.equal(f32Text(2.5e-8), '2.5e-8')
  assert.equal(f32Text(-0), '0')
  assert.equal(f32Text(Number.NaN), 'NaN')
  assert.equal(f32Text(Infinity), 'inf')
  assert.equal(f32Text(-Infinity), '-inf')
  const g = seeded(7)
  for (let i = 0; i < 1000; i++) {
    const x = f((g() - 0.5) * 10 ** Math.floor(g() * 76 - 38))
    const text = f32Text(x)
    assert.equal(f(Number(text)), x, `${x} -> ${text}`)
    assert.ok(text.split('e')[0]!.replace(/[-.]/g, '').replace(/^0+/, '').replace(/0+$/, '').length <= 9, `${text} has more than 9 significant digits`)
  }
})

test('casts: f32 to an integer truncates and saturates (NaN gives 0), i32 and u32 reinterpret, integers round to f32, bool is 0 or 1', () => {
  assert.equal(one('print(1e10 as i32, -1e10 as i32, 1e10 as u32, -1.5 as u32, (0.0 / 0.0) as i32, (0.0 / 0.0) as u32, (1.0 / 0.0) as i32, (-1.0 / 0.0) as i32, (1.0 / 0.0) as u32, 3.99 as i32, -3.99 as i32, -0.5 as i32, 2147483647.0 as i32, 4294967295.0 as u32);'),
    '2147483647 -2147483648 4294967295 0 0 0 2147483647 -2147483648 4294967295 3 -3 0 2147483647 4294967295')
  assert.equal(one('print(-1 as u32, 4294967295u as i32, 2147483648u as i32, -2147483648 as u32, true as i32, false as i32, true as u32, 1 as i32, 7u as u32, 1.5 as f32);'),
    '4294967295 -1 -2147483648 2147483648 1 0 1 1 7 1.5')
  assert.equal(one('print(16777217 as f32, 2147483647 as f32, 4294967295u as f32, (16777217 as f32) as i32, -2147483648 as f32, 2147483647 as f32 as i32, 1 as f32 / 3 as f32);'),
    `16777216 2147483600 4294967300 16777216 -2147483600 2147483647 ${f32Text(f(1 / 3))}`)
  assert.equal(one('print(f32x4(1.5, -1.5, 1e10, -1e10) as i32x4, f32x4(1.5, -1.5, 0.0 / 0.0, 1e10) as u32x4, i32x4(1, -1, 2, -2) as u32x4, u32x4(1u, 2u, 3u, 4294967295u) as f32x4, i32x4(1, -1, 16777217, 0) as f32x4, u32x4(4294967295u, 1u, 2u, 3u) as i32x4, splat_u32x8(9u) as u32x8);'),
    'i32x4(1, -1, 2147483647, -2147483648) u32x4(1, 0, 0, 4294967295) u32x4(1, 4294967295, 2, 4294967294) f32x4(1, 2, 3, 4294967300) f32x4(1, -1, 16777216, 0) i32x4(-1, 1, 2, 3) u32x8(9, 9, 9, 9, 9, 9, 9, 9)')
})

test('shift counts are masked to five bits; >> is arithmetic on i32 and logical on u32, lane-wise as well', () => {
  assert.equal(one('print(1 << 32, 1 << 33, 1u << 35u, -1 >> 31, -1 >> 32, 0xFFFFFFFFu >> 31u, 1 << -1, -8 >> 1, (0u - 1u) >> 28, 7 >> 1, 0x80000000u >> 31u, 1 << 31, -2147483648 >> 31, 2147483648u >> 31);'),
    '1 2 8 -1 -1 1 -2147483648 -4 15 3 1 -2147483648 -1 1')
  assert.equal(one('let a = splat_i32x4(-8); let u = splat_u32x4(0xFFFFFFFFu); let w = splat_u32x8(1u); print(a >> 1, a << 1, u >> 1, u << 31, w << 33, w >> 1, i32x4(1, 2, 4, 8) << i32x4(32, 1, 2, 3), u32x4(16u, 16u, 16u, 16u) >> u32x4(1u, 2u, 3u, 36u));'),
    'i32x4(-4, -4, -4, -4) i32x4(-16, -16, -16, -16) u32x4(2147483647, 2147483647, 2147483647, 2147483647) u32x4(2147483648, 2147483648, 2147483648, 2147483648) u32x8(2, 2, 2, 2, 2, 2, 2, 2) u32x8(0, 0, 0, 0, 0, 0, 0, 0) i32x4(1, 4, 16, 64) u32x4(8, 4, 2, 1)')
  assert.equal(one('let mut sh = 1u; sh <<= 31u; let mut si = -1; si >>= 40; let mut v = splat_i32x4(3); v <<= 2; print(sh, si, v);'), '2147483648 -1 i32x4(12, 12, 12, 12)')
})

// ---------------------------------------------------------------------------------------------------
// Vectors and the branchless intrinsics

test('vectors: lane-wise arithmetic, comparisons give masks, select is a bit operation, mask, any and all, horizontals in order', () => {
  const s = fresh()
  assert.deepEqual(say(s, 'let v = f32x4(1.0, 2.0, 3.0, 4.0); let w = v * splat_f32x4(2.0); print(w, hsum(w));'), ['f32x4(2, 4, 6, 8) 20'])
  assert.deepEqual(say(s, 'let m = vlt(f32x4(1.0, 5.0, 3.0, 7.0), splat_f32x4(4.0)); print(m, select(m, splat_f32x4(1.0), splat_f32x4(0.0)));'), ['u32x4(4294967295, 0, 4294967295, 0) f32x4(1, 0, 1, 0)'])
  assert.deepEqual(say(s, 'print(v + v, v - splat_f32x4(1.0), v / splat_f32x4(2.0), -v, v * v, hmin(v), hmax(v), v.x, v.y, v.z, v.w, v[3], v.len());'), ['f32x4(2, 4, 6, 8) f32x4(0, 1, 2, 3) f32x4(0.5, 1, 1.5, 2) f32x4(-1, -2, -3, -4) f32x4(1, 4, 9, 16) 1 4 1 2 3 4 4 4'])
  assert.deepEqual(say(s, 'let a = i32x4(1, -2, 3, -4); print(a + a, a * a, -a, abs(a), ~a, a & splat_i32x4(1), a | splat_i32x4(8), a ^ a, min(a, splat_i32x4(0)), max(a, splat_i32x4(0)), hsum(a), hmin(a), hmax(a));'),
    ['i32x4(2, -4, 6, -8) i32x4(1, 4, 9, 16) i32x4(-1, 2, -3, 4) i32x4(1, 2, 3, 4) i32x4(-2, 1, -4, 3) i32x4(1, 0, 1, 0) i32x4(9, -2, 11, -4) i32x4(0, 0, 0, 0) i32x4(0, -2, 0, -4) i32x4(1, 0, 3, 0) -2 -4 3'])
  assert.deepEqual(say(s, 'let u = u32x4(1u, 2u, 3u, 4294967295u); print(u + splat_u32x4(1u), u * u, hsum(u), hmin(u), hmax(u), hmin(u32x4(4294967295u, 1u, 2u, 3u)), hmax(u32x4(4294967295u, 1u, 2u, 3u)));'),
    ['u32x4(2, 3, 4, 0) u32x4(1, 4, 9, 1) 5 1 4294967295 1 4294967295'])
  assert.deepEqual(say(s, 'let w8 = u32x8(1u, 2u, 3u, 4u, 5u, 6u, 7u, 8u); print(w8, w8 + w8, w8 * w8, w8 >> 1, w8 & splat_u32x8(1u), hsum(w8), hmin(w8), hmax(w8), w8[7], w8.len(), splat_u32x8(4294967295u) + splat_u32x8(2u));'),
    ['u32x8(1, 2, 3, 4, 5, 6, 7, 8) u32x8(2, 4, 6, 8, 10, 12, 14, 16) u32x8(1, 4, 9, 16, 25, 36, 49, 64) u32x8(0, 1, 1, 2, 2, 3, 3, 4) u32x8(1, 0, 1, 0, 1, 0, 1, 0) 36 1 8 8 8 u32x8(1, 1, 1, 1, 1, 1, 1, 1)'])
  // Every comparison, for every lane type: a lane is 0xFFFFFFFF where it holds and 0 where it does not.
  assert.deepEqual(say(s, 'let p = f32x4(1.0, 2.0, 3.0, 4.0); let q = f32x4(4.0, 2.0, 0.0 / 0.0, 1.0); print(vlt(p, q), vle(p, q), vgt(p, q), vge(p, q), veq(p, q), vne(p, q));'),
    ['u32x4(4294967295, 0, 0, 0) u32x4(4294967295, 4294967295, 0, 0) u32x4(0, 0, 0, 4294967295) u32x4(0, 4294967295, 0, 4294967295) u32x4(0, 4294967295, 0, 0) u32x4(4294967295, 0, 4294967295, 4294967295)'])
  assert.deepEqual(say(s, 'let i = i32x4(-1, 0, 1, 2); let j = splat_i32x4(0); print(vlt(i, j), vle(i, j), vgt(i, j), vge(i, j), veq(i, j), vne(i, j));'),
    ['u32x4(4294967295, 0, 0, 0) u32x4(4294967295, 4294967295, 0, 0) u32x4(0, 0, 4294967295, 4294967295) u32x4(0, 4294967295, 4294967295, 4294967295) u32x4(0, 4294967295, 0, 0) u32x4(4294967295, 0, 4294967295, 4294967295)'])
  assert.deepEqual(say(s, 'let k = u32x4(4294967295u, 0u, 1u, 2u); let l = splat_u32x4(1u); print(vlt(k, l), vle(k, l), vgt(k, l), vge(k, l), veq(k, l), vne(k, l));'),
    ['u32x4(0, 4294967295, 0, 0) u32x4(0, 4294967295, 4294967295, 0) u32x4(4294967295, 0, 0, 4294967295) u32x4(4294967295, 0, 4294967295, 4294967295) u32x4(0, 0, 4294967295, 0) u32x4(4294967295, 4294967295, 0, 4294967295)'], 'u32 compares unsigned')
  assert.deepEqual(say(s, 'let e = splat_u32x8(3u); print(vlt(w8, e), vle(w8, e), vgt(w8, e), vge(w8, e), veq(w8, e), vne(w8, e));'),
    ['u32x8(4294967295, 4294967295, 0, 0, 0, 0, 0, 0) u32x8(4294967295, 4294967295, 4294967295, 0, 0, 0, 0, 0) u32x8(0, 0, 0, 4294967295, 4294967295, 4294967295, 4294967295, 4294967295) u32x8(0, 0, 4294967295, 4294967295, 4294967295, 4294967295, 4294967295, 4294967295) u32x8(0, 0, 4294967295, 0, 0, 0, 0, 0) u32x8(4294967295, 4294967295, 0, 4294967295, 4294967295, 4294967295, 4294967295, 4294967295)'])
  assert.deepEqual(say(s, 'print(any(vlt(p, q)), all(vlt(p, q)), all(vle(p, p)), any(vne(p, p)), any(splat_u32x8(0u)), all(splat_u32x8(1u)), all(u32x8(1u, 1u, 1u, 1u, 1u, 1u, 1u, 0u)));'), ['true false true false false true false'])
  // select: b ^ ((a ^ b) & mask) on the bits, so an f32 is picked exactly and a partial mask mixes bits.
  assert.deepEqual(say(s, 'print(select(mask(true), 1, 2), select(mask(false), 1, 2), select(0xFFFFFFFFu, 1.5, 2.5), select(0u, 1.5, 2.5), select(mask(1 < 2), 7u, 8u), mask(true), mask(false), select(0xFFFF0000u, 0xAAAAAAAAu, 0x55555555u));'),
    ['1 2 1.5 2.5 7 4294967295 0 2863289685'])
  assert.deepEqual(say(s, 'print(select(vlt(i, j), splat_i32x4(1), splat_i32x4(0)), select(vlt(k, l), k, l), select(vlt(w8, e), w8, splat_u32x8(0u)), select(veq(p, p), p, q));'),
    ['i32x4(1, 0, 0, 0) u32x4(1, 0, 1, 1) u32x8(1, 2, 0, 0, 0, 0, 0, 0) f32x4(1, 2, 3, 4)'])
  // hsum adds lanes 0+1+2+3 in order, rounding after each add, so 16777216 + 1 + 1 stays 16777216 but 1 + 1 + 16777216 does not.
  assert.deepEqual(say(s, 'print(hsum(f32x4(16777216.0, 1.0, 1.0, 0.0)), hsum(f32x4(1.0, 1.0, 16777216.0, 0.0)), hsum(splat_i32x4(2147483647)), hsum(splat_u32x4(4294967295u)), hsum(splat_u32x8(4294967295u)), hsum(f32x4(0.1, 0.2, 0.3, 0.4)));'),
    [`16777216 16777218 -4 4294967292 4294967288 ${f32Text(f(f(f(f(0.1) + f(0.2)) + f(0.3)) + f(0.4)))}`])
  // Lanes: read by field or index, written only on a mut vector; a variable index is bounds-checked.
  assert.deepEqual(say(s, 'let mut sv = splat_u32x4(1u); sv[1] = 5u; sv[2] += 2u; sv[3] <<= 3u; let mut fv = f32x4(0.0, 0.0, 0.0, 0.0); fv[0] = 1.5; fv[0] *= 2.0; let idx = 2; print(sv, sv.y, fv, fv[idx], sv[idx]);'), ['u32x4(1, 5, 3, 8) 5 f32x4(3, 0, 0, 0) 0 3'])
  assert.deepEqual(say(s, 'print(f32x4(1, 2, 3, 4), u32x4(1, 2, 3, 4), splat_u32x8(8), splat_f32x4(2), sqrt(f32x4(4.0, 9.0, 2.0, 0.0)), abs(f32x4(-1.5, 2.0, -0.0, 0.0 / 0.0)), min(p, q), max(p, q));'),
    [`f32x4(1, 2, 3, 4) u32x4(1, 2, 3, 4) u32x8(8, 8, 8, 8, 8, 8, 8, 8) f32x4(2, 2, 2, 2) f32x4(2, 3, ${f32Text(f(Math.sqrt(2)))}, 0) f32x4(1.5, 2, 0, NaN) f32x4(1, 2, NaN, 1) f32x4(4, 2, NaN, 4)`])
  assert.deepEqual(say(s, 'fn sq(v: f32x4) -> f32x4 { v * v } fn mix(a: u32x8, b: u32x8) -> u32x8 { select(vlt(a, b), a, b) } print(sq(p).w, sq(p), mix(w8, splat_u32x8(4u)), [splat_f32x4(1.0); 2]);'),
    ['16 f32x4(1, 4, 9, 16) u32x8(1, 2, 3, 4, 4, 4, 4, 4) [f32x4(1, 1, 1, 1), f32x4(1, 1, 1, 1)]'])
})

test('branchless witness: over a thousand seeded triples, select(mask(a < b), a, b) is min(a, b) for i32, u32 and f32', () => {
  // A triple is one pair per scalar type. NaN is left out of the f32 pairs: `a < b` is false for NaN while min
  // propagates it, so the two forms differ there by design (min follows Math.min, as the spec says).
  const g = seeded(110)
  const s = fresh()
  let cases = 0
  for (let batch = 0; batch < 20; batch++) {
    const stmts: string[] = []
    const expected: string[] = []
    for (let k = 0; k < 50; k++) {
      const a = int32(g), b = int32(g)
      const ua = uint32(g), ub = uint32(g)
      const fa = f((g() - 0.5) * 10 ** Math.floor(g() * 20 - 10)), fb = f((g() - 0.5) * 10 ** Math.floor(g() * 20 - 10))
      const lit = (x: number): string => `${f32Text(x)}f`
      stmts.push(`print(select(mask(${a} < ${b}), ${a}, ${b}) == min(${a}, ${b}), select(mask(${ua}u < ${ub}u), ${ua}u, ${ub}u) == min(${ua}u, ${ub}u), select(mask(${lit(fa)} < ${lit(fb)}), ${lit(fa)}, ${lit(fb)}) == min(${lit(fa)}, ${lit(fb)}), min(${a}, ${b}), min(${ua}u, ${ub}u), min(${lit(fa)}, ${lit(fb)}));`)
      expected.push(`true true true ${Math.min(a, b)} ${Math.min(ua, ub)} ${f32Text(Math.min(fa, fb))}`)
      cases++
    }
    assert.deepEqual(say(s, stmts.join('\n')), expected)
  }
  assert.equal(cases, 1000)
})

test('morton2 interleaves the low 16 bits with x in the even positions, and demorton2x / demorton2y invert it', () => {
  const spread = (v: number): number => {
    v &= 0xffff
    v = (v | (v << 8)) & 0x00ff00ff
    v = (v | (v << 4)) & 0x0f0f0f0f
    v = (v | (v << 2)) & 0x33333333
    v = (v | (v << 1)) & 0x55555555
    return v
  }
  const morton = (x: number, y: number): number => (spread(x) | (spread(y) << 1)) >>> 0
  assert.equal(morton(3, 5), 39, 'the reference agrees with the spec example')
  assert.equal(one('print(morton2(3u, 5u), demorton2x(39u), demorton2y(39u), morton2(1u, 0u), morton2(0u, 1u), morton2(65535u, 65535u), morton2(65536u, 0u), morton2(0u, 65536u), demorton2x(0xFFFFFFFFu), demorton2y(0xFFFFFFFFu), demorton2x(0xAAAAAAAAu), demorton2y(0xAAAAAAAAu));'),
    '39 3 5 1 2 4294967295 0 0 65535 65535 0 65535')
  const g = seeded(2)
  const s = fresh()
  for (let batch = 0; batch < 6; batch++) {
    const stmts: string[] = []
    const expected: string[] = []
    for (let k = 0; k < 50; k++) {
      const x = Math.floor(g() * 65536), y = Math.floor(g() * 65536)
      stmts.push(`print(morton2(${x}u, ${y}u), demorton2x(morton2(${x}u, ${y}u)) == ${x}u && demorton2y(morton2(${x}u, ${y}u)) == ${y}u);`)
      expected.push(`${morton(x, y)} true`)
    }
    assert.deepEqual(say(s, stmts.join(' ')), expected)
  }
})

test('popcount, clz, ctz, rotl and rotr match the reference formulas over seeded values', () => {
  assert.equal(one('print(popcount(0xF0F0u), popcount(0u), popcount(0xFFFFFFFFu), clz(1u), clz(0u), clz(0x80000000u), ctz(8u), ctz(0u), ctz(1u), ctz(0x80000000u), rotl(1u, 1u), rotl(0x80000000u, 1u), rotr(1u, 1u), rotl(1u, 33u), rotr(0x12345678u, 0u), rotl(0x12345678u, 32u), rotr(0x12345678u, 4u), rotl(0x12345678u, 4u));'),
    '8 0 32 31 32 0 3 32 0 31 2 1 2147483648 2 305419896 305419896 2166572391 591751041')
  const pop = (v: number): number => { let n = 0; for (let x = v >>> 0; x !== 0; x >>>= 1) n += x & 1; return n }
  const ctz = (v: number): number => (v === 0 ? 32 : 31 - Math.clz32(v & -v))
  const rotl = (x: number, n: number): number => { n &= 31; return n === 0 ? x >>> 0 : ((x << n) | (x >>> (32 - n))) >>> 0 }
  const rotr = (x: number, n: number): number => rotl(x, 32 - (n & 31))
  const g = seeded(3)
  const s = fresh()
  for (let batch = 0; batch < 4; batch++) {
    const stmts: string[] = []
    const expected: string[] = []
    for (let k = 0; k < 50; k++) {
      const x = g() < 0.2 ? uint32(g) & (0xffff << Math.floor(g() * 16)) : uint32(g)
      const n = Math.floor(g() * 70)
      stmts.push(`print(popcount(${x}u), clz(${x}u), ctz(${x}u), rotl(${x}u, ${n}u), rotr(${x}u, ${n}u), rotr(rotl(${x}u, ${n}u), ${n}u) == ${x}u);`)
      expected.push(`${pop(x)} ${Math.clz32(x)} ${ctz(x)} ${rotl(x, n)} ${rotr(x, n)} true`)
    }
    assert.deepEqual(say(s, stmts.join(' ')), expected)
  }
})

// ---------------------------------------------------------------------------------------------------
// Arrays, bounds, control flow

test('arrays: fill and literal forms, nesting, len, a printing cap of 64, and copies by value into variables, calls and returns', () => {
  const s = fresh()
  assert.deepEqual(say(s, 'let arr = [1, 2, 3]; let fill = [7; 4]; print(arr, fill, arr[0], arr[2], fill[3], arr.len(), fill.len(), [[1, 2], [3, 4]], [[1, 2], [3, 4]][1][0], [1.5; 2], [true, false], [1u, 2u].len(), [[0; 2]; 3]);'),
    ['[1, 2, 3] [7, 7, 7, 7] 1 3 7 3 4 [[1, 2], [3, 4]] 3 [1.5, 1.5] [true, false] 2 [[0, 0], [0, 0], [0, 0]]'])
  assert.deepEqual(say(s, 'let mut b = arr; b[0] = 100; print(arr, b);'), ['[1, 2, 3] [100, 2, 3]'], 'a let copies')
  assert.deepEqual(say(s, 'fn bump(a: [i32; 3]) -> i32 { let mut c = a; c[0] = 100; c[0] + a[0] } print(bump(arr), arr);'), ['101 [1, 2, 3]'], 'a call copies')
  assert.deepEqual(say(s, 'fn mk() -> [i32; 3] { [1, 2, 3] } fn twice3(a: [i32; 3]) -> [i32; 3] { [a[0] * 2, a[1] * 2, a[2] * 2] } print(mk()[1], mk(), twice3(mk()), twice3(twice3(arr))[2]);'), ['2 [1, 2, 3] [2, 4, 6] 12'])
  assert.deepEqual(say(s, 'let mut aa = [[1, 2], [3, 4]]; aa[1] = [5, 6]; let row = aa[0]; aa[0] = [9, 9]; print(aa, aa[1][0], row);'), ['[[9, 9], [5, 6]] 5 [1, 2]'])
  assert.deepEqual(say(s, 'let mut sum = 0; let xs = [3, 1, 4, 1, 5, 9, 2, 6]; for i in 0..xs.len() { sum += xs[i]; } print(sum);'), ['31'])
  assert.deepEqual(say(s, 'let big = [0; 64]; let big2 = [1; 70]; print(big.len(), big2.len()); print(big); print(big2);'),
    ['64 70', `[${Array(64).fill('0').join(', ')}]`, `[${Array(64).fill('1').join(', ')}, ... (6 more)]`])
  assert.deepEqual(say(s, 'let mut ga = [0; 4];'), [])
  assert.deepEqual(say(s, 'ga[2] = 5; ga[0] += 1; print(ga, ga[2]);'), ['[1, 0, 5, 0] 5'], 'a global array takes element writes from a later line')
  assert.deepEqual(say(s, 'let vs = [splat_f32x4(1.0), f32x4(1.0, 2.0, 3.0, 4.0)]; print(vs[1].z, vs, hsum(vs[1]));'), ['3 [f32x4(1, 1, 1, 1), f32x4(1, 2, 3, 4)] 10'])
})

test('bounds: every index into an array, a vector or a column is checked at run time and named', () => {
  const s = fresh()
  assert.deepEqual(say(s, 'let arr = [1, 2, 3]; let mut m = [0; 4]; let v = splat_f32x4(1.0); let w = splat_u32x8(1u); let c = crowd.x;'), [])
  assert.equal(err(s, 'print(arr[3]);'), 'index 3 out of bounds (len 3)')
  assert.equal(err(s, 'print(arr[-1]);'), 'index -1 out of bounds (len 3)')
  assert.equal(err(s, 'let i = 5; print(m[i]);'), 'index 5 out of bounds (len 4)')
  assert.equal(err(s, 'm[4] = 1;'), 'index 4 out of bounds (len 4)')
  assert.equal(err(s, 'm[-2] += 1;'), 'index -2 out of bounds (len 4)')
  assert.equal(err(s, 'print(v[4]);'), 'index 4 out of bounds (len 4)')
  assert.equal(err(s, 'print(w[8]);'), 'index 8 out of bounds (len 8)')
  assert.equal(err(s, 'print(c[0]);'), 'index 0 out of bounds (len 0)')
  assert.equal(err(s, 'print(crowd.z[7]);'), 'index 7 out of bounds (len 0)')
  assert.equal(err(s, 'print([1, 2][2]);'), 'index 2 out of bounds (len 2)')
  assert.equal(err(s, 'print(arr[4294967295u]);'), 'index 4294967295 out of bounds (len 3)', 'a u32 index is the same 32 bits, so the top half of u32 is out of bounds, and the error names it unsigned')
  assert.equal(err(s, 'print(arr[3000000000u]);'), 'index 3000000000 out of bounds (len 3)')
  assert.equal(err(s, 'let k = 3000000000u; m[k] = 1;'), 'index 3000000000 out of bounds (len 4)')
  assert.equal(err(s, 'print([1, 2][4294967295u]);'), 'index 4294967295 out of bounds (len 2)')
  assert.equal(err(s, 'print(c[4294967295u]);'), 'index 4294967295 out of bounds (len 0)')
  assert.equal(err(s, 'print(arr[2147483647]);'), 'index 2147483647 out of bounds (len 3)')
  assert.deepEqual(say(s, 'print(arr[2u], m[3u]);'), ['3 0'])
  assert.deepEqual(say(s, 'print(1);'), ['1'])
})

test('recursion: fib(20) is 6765, ackermann(2, 3) is 9, mutual recursion, forward calls on one line, a thousand frames', () => {
  const s = fresh()
  const fib = s.run('fn fib(n: i32) -> i32 { if n < 2 { n } else { fib(n - 1) + fib(n - 2) } } print(fib(20));')
  assert.deepEqual(fib.out, ['6765'])
  assert.ok(fib.steps > 10_000 && fib.steps < LIMITS.steps, `${fib.steps} steps`)
  assert.deepEqual(say(s, 'fn ack(m: i32, n: i32) -> i32 { if m == 0 { n + 1 } else if n == 0 { ack(m - 1, 1) } else { ack(m - 1, ack(m, n - 1)) } } print(ack(2, 3), ack(1, 5), ack(3, 2));'), ['9 7 29'])
  assert.deepEqual(say(s, 'fn ev(n: i32) -> bool { if n == 0 { true } else { od(n - 1) } } fn od(n: i32) -> bool { if n == 0 { false } else { ev(n - 1) } } print(ev(10), od(7), ev(7), od(0));'), ['true true false false'])
  assert.deepEqual(say(s, 'fn depth(n: i32) -> i32 { if n == 0 { 0 } else { depth(n - 1) + 1 } } print(depth(1000));'), ['1000'])
  assert.deepEqual(say(s, 'fn gcd(a: u32, b: u32) -> u32 { if b == 0u { a } else { gcd(b, a % b) } } print(gcd(1071u, 462u), gcd(4294967295u, 3u));'), ['21 3'])
  assert.deepEqual(say(s, 'fn fact(n: i32) -> i32 { if n <= 1 { return 1; } n * fact(n - 1) } print(fact(10), fact(13));'), ['3628800 1932053504'], 'the wrap is the same as Math.imul')
  assert.deepEqual(say(s, 'fn sumto(n: i32, acc: i32) -> i32 { if n == 0 { acc } else { sumto(n - 1, acc + n) } } print(sumto(100, 0));'), ['5050'])
})

test('loops: for over .. and ..=, while, loop, break and continue, empty ranges, u32 ranges at the top of the type', () => {
  const s = fresh()
  assert.deepEqual(say(s, 'let mut s = 0; for i in 0..10 { s += i * i; } print(s);'), ['285'])
  assert.deepEqual(say(s, 'let mut t = 0; for i in 0..10 { if i % 2 == 0 { continue; } if i > 7 { break; } t += i; } print(t);'), ['16'])
  assert.deepEqual(say(s, 'let mut u = 0; let mut k = 0; while true { k += 1; if k > 100 { break; } if k % 3 != 0 { continue; } u += k; } print(u, k);'), ['1683 101'])
  assert.deepEqual(say(s, 'let mut c = 0; loop { c += 1; if c == 5 { break; } } print(c);'), ['5'])
  assert.deepEqual(say(s, 'let mut z = 0; for i in 0..=10 { z += i; } print(z);'), ['55'])
  assert.deepEqual(say(s, 'for i in 5..3 { print(i); } for i in 3..=3 { print(i); } for i in 3..3 { print(i); } for i in -2..1 { print(i); }'), ['3', '-2', '-1', '0'])
  assert.deepEqual(say(s, 'let mut q = 0u; for j in 4294967290u..=4294967295u { q += 1u; } print(q); let mut r = 0; for i in 2147483645..=2147483647 { r += 1; } print(r);'), ['6', '3'], 'an inclusive range to the maximum never wraps')
  assert.deepEqual(say(s, 'let mut cnt = 0u; for i in 0u..4000000000u { cnt += 1u; if cnt > 3u { break; } } print(cnt);'), ['4'])
  assert.deepEqual(say(s, 'let n = 3; let mut hits = 0; for i in 0..n { for j in 0..n { if i == j { continue; } hits += 1; } } print(hits);'), ['6'])
  assert.deepEqual(say(s, 'let mut outer = 0; loop { let mut inner = 0; loop { inner += 1; if inner == 3 { break; } } outer += inner; if outer >= 9 { break; } } print(outer);'), ['9'], 'break leaves the innermost loop')
  assert.deepEqual(say(s, 'let mut w = 10; while w > 0 { w -= 3; } print(w); let mut iter = 0; while iter < 5 { iter += 1; } print(iter);'), ['-2', '5'])
  assert.deepEqual(say(s, 'let mut bound = 3; let mut seen = 0; for i in 0..bound { bound += 1; seen += 1; } print(seen, bound);'), ['3 6'], 'the bound is read once')
})

test('nested blocks shadow outward and if-expressions yield values of one type', () => {
  const s = fresh()
  assert.deepEqual(say(s, 'let x = 1; { let x = 2; { let x = x + 1; print(x); } print(x); } print(x);'), ['3', '2', '1'])
  assert.deepEqual(say(s, 'let y = if x > 0 { 10 } else { 20 }; print(y, if false { 1.5 } else { 2.5 }, if x == 1 { 7u } else { 8u });'), ['10 2.5 7'])
  assert.deepEqual(say(s, 'fn sign(n: i32) -> i32 { if n > 0 { 1 } else if n < 0 { -1 } else { 0 } } print(sign(5), sign(-5), sign(0));'), ['1 -1 0'])
  assert.deepEqual(say(s, 'let z = if x > 0 { let t = x * 10; t + 1 } else { 0 }; print(z, (if x > 0 { 2 } else { 3 }) * 4, abs(if x > 0 { -7 } else { 7 }));'), ['11 8 7'])
  assert.deepEqual(say(s, 'let mut n = 0; loop { let v = if n > 2 { break; 1 } else { 2 }; n += v; } print(n);'), ['4'], 'a break inside an if-expression arm leaves the loop')
  assert.deepEqual(say(s, 'fn pick(c: bool) -> f32x4 { if c { splat_f32x4(1.0) } else { f32x4(1.0, 2.0, 3.0, 4.0) } } print(pick(true), pick(false).w);'), ['f32x4(1, 1, 1, 1) 4'])
  assert.deepEqual(say(s, 'fn f(a: i32) -> i32 { let mut r = a; { let a = 100; r += a; } r } print(f(1));'), ['101'], 'an inner block shadows a parameter')
})

// ---------------------------------------------------------------------------------------------------
// The session across lines

test('globals live across lines; a let mut global takes assignments from later lines; a let does not', () => {
  const s = fresh()
  assert.deepEqual(s.run('let mut g = 1; let k = 10;').defined, ['g', 'k'])
  assert.deepEqual(say(s, 'g += 41; print(g, k);'), ['42 10'])
  assert.deepEqual(say(s, 'g = g * 2; print(g);'), ['84'])
  assert.equal(err(s, 'k = 2;'), "1:1: cannot assign to immutable 'k'")
  assert.deepEqual(say(s, 'fn bump() { g += 1; } bump(); bump(); print(g);'), ['86'], 'a fn may write a mutable global')
  assert.deepEqual(say(s, 'let mut gv = splat_f32x4(1.0); let mut ga = [0; 3];'), [])
  assert.deepEqual(say(s, 'gv += splat_f32x4(1.0); gv[0] *= 4.0; ga[1] = 7; print(gv, ga);'), ['f32x4(8, 2, 2, 2) [0, 7, 0]'])
  assert.deepEqual(say(s, 'let x = 1; { let x = 2.5; print(x); } print(x);'), ['2.5', '1'], 'a block at the top level is not global scope')
  assert.deepEqual(s.words().slice(-6), ['g', 'k', 'bump', 'gv', 'ga', 'x'])
})

test('redefining a fn or a global on a later line replaces it for later lines; earlier code keeps what it was compiled against', () => {
  const s = fresh()
  assert.deepEqual(say(s, 'fn twice(n: i32) -> i32 { n * 2 } fn quad(n: i32) -> i32 { twice(twice(n)) } print(twice(4), quad(1));'), ['8 4'])
  assert.deepEqual(say(s, 'fn twice(n: i32) -> i32 { n * 3 } print(twice(4));'), ['12'])
  // The spec: the new fn takes effect for later lines. `quad` was compiled on an earlier line against the old `twice`
  // and the function table only grows, so it keeps calling that one; this is the pinned decision.
  assert.deepEqual(say(s, 'print(quad(1), twice(1));'), ['4 3'])
  assert.deepEqual(say(s, 'fn twice(n: f32) -> f32 { n * 2.0 } print(twice(1.5), twice(4));'), ['3 8'], 'a redefinition may change the signature; a bare literal adopts f32')
  assert.equal(err(s, 'let four = 4; print(twice(four));'), "1:27: fn 'twice': argument 1 is i32, expected f32")
  assert.deepEqual(say(s, 'let kk = 1; fn useK() -> i32 { kk } print(useK());'), ['1'])
  assert.deepEqual(say(s, 'let kk = 2.5; print(useK(), kk);'), ['1 2.5'], 'a redefined global is a new cell; the old fn reads the old one')
  assert.deepEqual(say(s, 'let mut kk = 5; kk += 1; print(useK(), kk);'), ['1 6'])
  assert.equal(s.words().filter((w) => w === 'twice').length, 1, 'words lists a name once')
  assert.deepEqual(s.words().slice(-4), ['twice', 'quad', 'kk', 'useK'])
})

// ---------------------------------------------------------------------------------------------------
// The bounds

test('the step budget ends an endless loop by name after exactly limits.steps steps, and the next line works', () => {
  const s = fresh()
  const r = s.run('loop { }')
  assert.equal(r.error, 'step budget exhausted (1000000)')
  assert.equal(r.steps, LIMITS.steps)
  assert.deepEqual(say(s, 'print(1);'), ['1'])
  const r2 = s.run('let mut n = 0; while true { n += 1; }')
  assert.equal(r2.error, 'step budget exhausted (1000000)')
  assert.deepEqual(r2.defined, ['n'], 'the global the line declared survives its run-time error')
  assert.deepEqual(say(s, 'print(n > 100000);'), ['true'], 'and holds what the loop had done')
  const small = s.run('fn spin() { loop { } } spin();', null, { ...LIMITS, steps: 500 })
  assert.equal(small.error, 'step budget exhausted (500)')
  assert.equal(small.steps, 500)
  assert.deepEqual(say(s, 'print(2);'), ['2'])
  const ok = s.run('fn fib(n: i32) -> i32 { if n < 2 { n } else { fib(n - 1) + fib(n - 2) } } print(fib(25));')
  assert.equal(ok.error, 'step budget exhausted (1000000)', 'fib(25) needs more than a million instructions')
  assert.deepEqual(say(s, 'print(fib(15));'), ['610'])
})

test('the output cap ends a chatty line by name, keeps what was printed before, and the next line works', () => {
  const s = fresh()
  const r = s.run('loop { print("0123456789"); }')
  assert.equal(r.error, 'output limit exhausted (16384)')
  assert.ok(r.out.length > 1000, `${r.out.length} lines kept`)
  assert.ok(r.out.every((l) => l === '0123456789'))
  const chars = r.out.reduce((n, l) => n + l.length + 1, 0)
  assert.ok(chars <= LIMITS.out && chars + 11 > LIMITS.out, `${chars} characters printed before the cap (each line counts its newline)`)
  assert.deepEqual(say(s, 'print(2);'), ['2'])
  const small = s.run('print("abc"); print("defg"); print("h");', null, { ...LIMITS, out: 9 })
  assert.deepEqual(small.out, ['abc', 'defg'], '4 + 5 = 9 fits, the next line does not')
  assert.equal(small.error, 'output limit exhausted (9)')
  const huge = s.run('let big = [1; 70]; for i in 0..100 { print(big); }')
  assert.equal(huge.error, 'output limit exhausted (16384)')
})

test('the depth cap: unbounded recursion ends with "stack overflow (depth 1024)", never a JS RangeError', () => {
  const s = fresh()
  const r = s.run('fn r(n: i32) -> i32 { r(n + 1) } print(r(0));')
  assert.equal(r.error, 'stack overflow (depth 1024)')
  assert.deepEqual(r.defined, ['r'])
  assert.equal(err(s, 'fn a() -> i32 { b() } fn b() -> i32 { a() + 1 } print(a());'), 'stack overflow (depth 1024)', 'mutual recursion too')
  assert.deepEqual(say(s, 'fn d(n: i32) -> i32 { if n == 0 { 0 } else { d(n - 1) + 1 } } print(d(1023));'), ['1023'], '1024 frames fit')
  assert.equal(err(s, 'print(d(1024));'), 'stack overflow (depth 1024)', 'the 1025th does not')
  assert.equal(s.run('print(d(5));', null, { ...LIMITS, depth: 4 }).error, 'stack overflow (depth 4)')
  assert.deepEqual(say(s, 'print(d(3));'), ['3'])
})

test('the memory cap: a huge array is "memory exhausted", at compile time when it could never fit and at run time when the frames pile up', () => {
  const s = fresh()
  // Where the spec is silent the test decides: globals may fill three quarters of the arena (196608 of 262144 cells),
  // the last quarter is kept for the tables and the frames, so no line can leave the session without room to run.
  const r = s.run('let big = [0; 1048576]; print(big.len());')
  assert.equal(r.error, 'memory exhausted')
  assert.deepEqual(r.defined, [], 'a line refused at compile time installs nothing')
  assert.equal(err(s, 'print(big.len());'), "1:7: unknown name 'big'")
  assert.equal(err(s, 'let big2 = [0; 196609];'), 'memory exhausted')
  assert.deepEqual(say(s, 'let big3 = [1; 196608]; print(big3[196607], big3.len());'), ['1 196608'])
  assert.equal(err(s, 'let one = 1;'), 'memory exhausted', 'the globals are full')
  const t = fresh()
  assert.equal(err(t, 'fn f() -> i32 { let a = [0; 300000]; a[5] } print(f());'), 'memory exhausted', 'a frame that could never fit')
  assert.equal(err(t, 'print(f());'), "1:7: unknown fn 'f'")
  assert.equal(err(t, 'print([0; 300000]);'), 'memory exhausted', 'an operand stack that could never fit')
  assert.equal(err(t, 'print([[0; 1048576]; 1048576][0][0]);'), 'memory exhausted')
  assert.deepEqual(say(t, 'print([[0; 1048576]; 1048576].len());'), ['1048576'], 'len of a pure array literal is known without building it')
  // Frames of 1024 cells, a thousand deep: each fits, together they do not; the fn survives the run-time error.
  const deep = t.run('fn r(n: i32) -> i32 { let a = [n; 1024]; if n == 0 { a[0] } else { r(n - 1) + a[1] } } print(r(1000));')
  assert.equal(deep.error, 'memory exhausted')
  assert.ok(deep.steps > 0)
  assert.deepEqual(deep.defined, ['r'])
  assert.deepEqual(say(t, 'print(r(10));'), ['55'])
  assert.deepEqual(say(t, 'print(3);'), ['3'])
})

test('ELITE_LIMITS raise every bound, as a session\'s limits or for one line; a bigger arena stays', () => {
  assert.deepEqual(LIMITS, { steps: 1_000_000, out: 16_384, cells: 262_144, depth: 1_024 })
  assert.deepEqual(ELITE_LIMITS, { steps: 50_000_000, out: 65_536, cells: 4_194_304, depth: 4_096 })
  assert.ok(Object.isFrozen(LIMITS) && Object.isFrozen(ELITE_LIMITS))
  const e = new NoirSession(ELITE_LIMITS)
  const steps = e.run('let mut i = 0; while i < 3000000 { i += 1; } print(i);')
  assert.deepEqual(steps.out, ['3000000'])
  assert.ok(steps.steps > LIMITS.steps && steps.steps < ELITE_LIMITS.steps)
  assert.deepEqual(say(e, 'fn d(n: i32) -> i32 { if n == 0 { 0 } else { d(n - 1) + 1 } } print(d(4095));'), ['4095'])
  assert.equal(err(e, 'print(d(4096));'), 'stack overflow (depth 4096)')
  assert.deepEqual(say(e, 'let big = [7; 1048576]; print(big[1048575], big.len());'), ['7 1048576'])
  const out = e.run('for i in 0..2000 { print("0123456789"); }')
  assert.equal(out.error, undefined)
  assert.equal(out.out.length, 2000, '22000 characters pass the elite cap')
  assert.equal(e.run('for i in 0..7000 { print("0123456789"); }').error, 'output limit exhausted (65536)')
  // One elite line in a default session: the arena grows for good (limits never shrink it), so a later default line
  // still reaches the elite line's global. This is the pinned decision where the spec is silent.
  const s = fresh()
  assert.equal(s.run('let big = [0; 1048576]; print(big.len());').error, 'memory exhausted')
  assert.deepEqual(s.run('let big = [0; 1048576]; print(big.len());', null, ELITE_LIMITS).out, ['1048576'])
  assert.deepEqual(say(s, 'print(big[1048575], big.len());'), ['0 1048576'])
  assert.equal(s.run('loop { }').error, 'step budget exhausted (1000000)', 'the other limits are the session\'s again')
  assert.equal(s.run('loop { }', null, ELITE_LIMITS).steps, ELITE_LIMITS.steps)
  // The grown arena is not a grown allowance: a later default line adds globals and uses frames only within its own
  // limits' cells (three quarters of them for globals), while every global the elite line made stays reachable.
  assert.equal(s.run('let more = [0; 1048576]; print(more.len());').error, 'memory exhausted')
  assert.equal(s.run('let more = [0; 196609];').error, 'memory exhausted')
  assert.deepEqual(say(s, 'let some = [0; 196608]; print(some.len(), big[1048575]);'), ['196608 0'])
  assert.equal(err(s, 'fn r(n: i32) -> i32 { let a = [n; 1024]; if n == 0 { a[0] } else { r(n - 1) + a[1] } } print(r(1000));'), 'memory exhausted', 'a thousand frames of 1024 cells exceed a default line\'s cells, in the big arena too')
  assert.deepEqual(s.run('print(r(1000));', null, ELITE_LIMITS).out, ['500500'], 'and fit an elite line\'s')
})

test('asm: the listing is non-empty, deterministic, names its instructions as the spec shows, and installs nothing', () => {
  const src = 'fn fib(n: i32) -> i32 { if n < 2 { n } else { fib(n - 1) + fib(n - 2) } } let v = splat_f32x4(1.0); print(fib(20), v + v, "x", 1u);'
  const a = fresh().asm(src)
  const b = fresh().asm(src)
  assert.equal(a.error, undefined)
  assert.deepEqual(a, b, 'two sessions list the same program identically')
  assert.ok(a.out.length > 10)
  assert.equal(a.steps, 0)
  assert.deepEqual(a.defined, [])
  for (const line of a.out) assert.match(line, /^(fn [^ ]+\(.*\) -> .+|\d{4}  [A-Z][A-Z0-9_]*( .*)?)$/, line)
  assert.ok(a.out[0]!.startsWith('fn fib(i32) -> i32'), 'a header per function')
  assert.ok(a.out.some((l) => l.startsWith('fn <main>()')), 'and one for the line\'s own code')
  assert.ok(a.out.some((l) => /^\d{4}  CALL fib 1$/.test(l)), 'a call names its callee and its parameter count')
  assert.ok(a.out.some((l) => /^\d{4}  JMP_IF_NOT \d{4}$/.test(l)), 'a jump names its destination')
  assert.ok(a.out.some((l) => /^\d{4}  ADD_F32X4$/.test(l)), 'a vector op carries its lane count')
  assert.ok(a.out.some((l) => /^\d{4}  ADD_I32$/.test(l)))
  assert.ok(a.out.some((l) => /^\d{4}  LT_I32$/.test(l)))
  assert.ok(a.out.some((l) => /^\d{4}  PRINT 4 i32 f32x4 str u32$/.test(l)), 'print names the types it formats')
  assert.ok(a.out.some((l) => /^\d{4}  RET 1$/.test(l)))
  const s = fresh()
  assert.equal(s.asm(src).error, undefined)
  assert.equal(err(s, 'print(fib(3));'), "1:7: unknown fn 'fib'", 'asm installs no fn')
  assert.equal(err(s, 'print(v);'), "1:7: unknown name 'v'", 'and no global')
  assert.equal(s.words().length, fresh().words().length)
  const bad = s.asm('let x: i32 = true;')
  assert.equal(bad.error, "1:14: cannot initialize i32 'x' with bool")
  assert.deepEqual(bad.out, [])
  assert.ok(s.asm('print(tune("k", 1.0), select(mask(true), 1, 2));').out.some((l) => /TUNE$/.test(l)), 'host writes compile without a host')
  assert.ok(s.asm('print(select(mask(1 < 2), 1, 2));').out.some((l) => /^\d{4}  SELECT$/.test(l)), 'select is one straight-line instruction')
  assert.ok(!s.asm('print(select(mask(1 < 2), 1, 2));').out.some((l) => /JMP/.test(l)), 'with no branch')
  assert.ok(s.asm('print(true && false);').out.some((l) => /JMP_IF_NOT/.test(l)), '&& branches, by definition')
  assert.deepEqual(say(s, 'let x = 1; print(x);'), ['1'])
  assert.ok(s.asm('print(x);').out.some((l) => /^\d{4}  LOAD_GLOBAL \d+ 1$/.test(l)), 'asm compiles against the session\'s globals')
  assert.equal(fresh().asm('print(x);').error, "1:7: unknown name 'x'")
})

test('len() builds no pure receiver but runs any other: its calls, its bounds checks, its recursion', () => {
  const s = fresh()
  assert.deepEqual(say(s, 'fn f() -> [i32; 2] { print(9); [1, 2] } print(f().len());'), ['9', '2'])
  assert.equal(err(s, 'let a = [[1, 2]; 3]; let i = 9; print(a[i].len());'), 'index 9 out of bounds (len 3)')
  assert.equal(err(s, 'fn r(n: i32) -> [i32; 2] { r(n + 1) } print(r(0).len());'), 'stack overflow (depth 1024)')
  assert.deepEqual(say(s, 'let a = [[1, 2]; 3]; print([a[0]; 2].len(), [1, 2, 3].len(), splat_u32x8(1u).len(), a.len());'), ['2 3 8 3'])
  const w = s.run('print([tune("k", 1.0); 2].len());', { tables: () => EMPTY_TABLES, write: { tune: () => { throw new Error('tune called') }, intent: () => false, cull: () => 0, steer: () => 0 } })
  assert.equal(w.error, 'tune called', 'a receiver with a host write runs it')
})

test('the step budget charges a cell move w / 16 steps, so a line that copies big arrays ends early by name', () => {
  const s = fresh()
  const one = s.run('let a = [0; 80000]; print(a.len());')
  assert.deepEqual(one.out, ['80000'])
  assert.ok(one.steps >= 5000 && one.steps < 5100, `${one.steps} steps: the fill of 80000 cells cost 5000`)
  const two = s.run('let b = a; print(b[79999]);')
  assert.ok(two.steps >= 10000 && two.steps < 10100, `${two.steps} steps: the load and the store of 80000 cells cost 5000 each`)
  // Within the default budget a loop that fills 80000 cells a time gets fewer than 200 turns, not the 1000000 the
  // instruction count alone would allow; the budget is never exceeded (a move it cannot cover is refused).
  const r = s.run('let mut turns = 0; loop { let c = [0; 80000]; turns += 1; }')
  assert.equal(r.error, 'step budget exhausted (1000000)')
  assert.equal(r.steps, LIMITS.steps)
  const turns = Number(say(s, 'print(turns);')[0])
  assert.ok(turns > 100 && turns < 200, `${turns} turns`)
  assert.deepEqual(say(s, 'fn id(x: [i32; 32]) -> [i32; 32] { x } print(id([1; 32])[31]);'), ['1'])
  const small = s.run('let v = [0; 15]; let w2 = v; print(w2.len());')
  assert.ok(small.steps < 20, `${small.steps} steps: a move under 16 cells is free`)
})
