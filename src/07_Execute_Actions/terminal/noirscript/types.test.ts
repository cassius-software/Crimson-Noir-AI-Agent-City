// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins NoirScript's static rules with exact messages: literal adoption and its limits,
 * every operator mismatch, immutability of let, params and loop variables, shadowing and redeclaration, missing
 * returns, arity and argument types, unknown names, the reserved table and intrinsic names, query scope, col
 * parameters, vector lanes and fields, the `as` rules, values left unused, strings out of place, and overload
 * resolution. Each is a program the checker must refuse (or accept) exactly as written.
 * What breaks if it is removed? A type hole could let an ill-typed program reach the VM and read cells wrongly.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Binary, LetStmt } from './ast.ts'
import { NoirSession } from './index.ts'
import { parse } from './parser.ts'
import { check } from './types.ts'

const err = (src: string): string => {
  const r = new NoirSession().run(src)
  assert.ok(r.error !== undefined, `${src} should not check`)
  return r.error
}
const ok = (src: string): string[] => {
  const r = new NoirSession().run(src)
  assert.equal(r.error, undefined, `${src} -> ${r.error}`)
  return r.out
}
const EMPTY = { globals: new Map(), fns: new Map(), nextFnIndex: 0 }

test('literal adoption: an unsuffixed integer takes u32 or f32 from its context, else it is i32', () => {
  const p = parse('let a: f32 = 2; let b = 7u + 1; let c = 1 + 1.5; let d = 3; let e: u32 = 0;')
  check(p, EMPTY)
  const lets = p.items as LetStmt[]
  assert.equal(lets[0]!.init.ty!.kind, 'f32')
  assert.equal((lets[1]!.init as Binary).r.ty!.kind, 'u32')
  assert.equal((lets[2]!.init as Binary).l.ty!.kind, 'f32')
  assert.equal(lets[3]!.init.ty!.kind, 'i32')
  assert.equal(lets[4]!.init.ty!.kind, 'u32')
  assert.deepEqual(ok('let a: f32 = 2; let b = 7u + 1; let c = 1 + 1.5; print(a, b, c, 2 * 1.5, 3000000000u - 1, 1 << 2u, min(1, 1.5), clamp(0.5, 0, 1));'), ['2 8 2.5 3 2999999999 4 1 0.5'])
  assert.deepEqual(ok('fn f(x: f32, k: u32) -> f32 { x } print(f(2, 3)); fn g() -> u32 { 4000000000 } print(g());'), ['2', '4000000000'])
  assert.deepEqual(ok('let mut x = 1.5; x += 1; x *= 2; print(x); let v = splat_i32x4(1) << 3; print(v, splat_u32x8(8u) >> 1);'), ['5', 'i32x4(8, 8, 8, 8) u32x8(4, 4, 4, 4, 4, 4, 4, 4)'])
  // Pinned decision beyond the spec's list: a literal also adopts from the typed elements beside it in an array literal
  // and from the other arm of an if-expression (`[1, 2.0]` is [f32; 2], `if c { 1 } else { 2.0 }` is f32), through an
  // else-if chain in either direction.
  assert.deepEqual(ok('let a: [f32; 2] = [1, 2]; let b = [1, 2.0]; let c = if true { 1 } else { 2.0 }; for i in 0..1u { print(a, b, c, i); }'), ['[1, 2] [1, 2] 1 0'])
  assert.deepEqual(ok('let c = if true { 1.0 } else if false { 2 } else { 3 }; let d = if false { 1 } else if true { 2.0 } else { 3 }; let e = if false { 1 } else if false { 2 } else { 3.0 }; print(c, d, e, [1, 2u], [1u, 2]);'), ['1 2 3 [1, 2] [1, 2]'])
  assert.equal(err('let k: u32 = -1;'), '1:14: literal -1 does not fit u32')
  assert.equal(err('let x = 3000000000;'), '1:9: literal 3000000000 does not fit i32')
  assert.equal(err('let x = -2147483649;'), '1:9: literal -2147483649 does not fit i32')
  assert.equal(err('let x = -1u;'), '1:9: literal -1 does not fit u32')
  assert.equal(err('print(2147483648);'), '1:7: literal 2147483648 does not fit i32')
  assert.equal(err('let x: u32 = 4294967296;'), '1:14: integer literal too large')
  assert.deepEqual(ok('print(-2147483648, 2147483647 as f32, 4294967295u);'), ['-2147483648 2147483600 4294967295'])
  assert.deepEqual(ok('let v = splat_u32x4(4u); print(v >> 1);'), ['u32x4(2, 2, 2, 2)'])
  assert.equal(err('let v = splat_i32x4(1); print(v << 2u);'), '1:33: type mismatch: i32x4 << u32', 'a suffixed literal does not adopt a vector')
})

test('every operator mismatch names both types, and the cast that would fix it where one exists', () => {
  assert.equal(err('let x = 1; let y = x + 1.5;'), "1:22: type mismatch: i32 + f32 (use 'as f32' or 'as i32')")
  assert.equal(err('let x = 1u + 1.5;'), "1:12: type mismatch: u32 + f32 (use 'as f32' or 'as u32')")
  assert.equal(err('let x = 1u; let y = x * 1.5f;'), "1:23: type mismatch: u32 * f32 (use 'as f32' or 'as u32')")
  assert.equal(err('let x = 1 / 2 % 0.5;'), "1:15: type mismatch: i32 % f32 (use 'as f32' or 'as i32')")
  assert.equal(err('let x = true + 1;'), '1:14: type mismatch: bool + i32')
  assert.equal(err('let v = splat_f32x4(1.0); let w = v + 1.0;'), '1:37: type mismatch: f32x4 + f32')
  assert.equal(err('let v = splat_f32x4(1.0); let w = v + 1;'), '1:37: type mismatch: f32x4 + i32')
  assert.equal(err('let x = 1.5 & 2.0;'), "1:13: '&' is not defined on f32")
  assert.equal(err('let x = 1 << 1.0;'), "1:11: '<<' is not defined on f32")
  assert.equal(err('let x = splat_f32x4(1.0) ^ splat_f32x4(2.0);'), "1:26: '^' is not defined on f32x4")
  assert.equal(err('let x = f32x4(1.0,2.0,3.0,4.0) < splat_f32x4(1.0);'), "1:32: '<' is not defined on f32x4 (use vlt)")
  assert.equal(err('let x = splat_u32x8(1u) == splat_u32x8(1u);'), "1:25: '==' is not defined on u32x8 (use veq)")
  assert.equal(err('let x = true < false;'), "1:14: '<' is not defined on bool")
  assert.equal(err('let x = crowd.x + crowd.x;'), "1:17: '+' is not defined on col<f32>")
  assert.equal(err('let x = [1] + [2];'), "1:13: '+' is not defined on [i32; 1]")
  assert.equal(err('let x = 1 && true;'), "1:9: '&&' needs bool, got i32")
  assert.equal(err('let x = true || 1;'), "1:17: '||' needs bool, got i32")
  assert.equal(err('let x = !1;'), "1:9: '!' needs bool, got i32")
  assert.equal(err('let x = -(1u);'), "1:9: unary '-' needs i32, f32, i32x4 or f32x4, got u32")
  assert.equal(err('let x = -true;'), "1:9: unary '-' needs i32, f32, i32x4 or f32x4, got bool")
  assert.equal(err('let x = ~1.5;'), "1:9: '~' needs an integer type, got f32")
  assert.equal(err('let mut x = 1; x += 1.5;'), "1:16: type mismatch: i32 + f32 (use 'as f32' or 'as i32')")
  assert.equal(err('let mut x = true; x += true;'), "1:19: '+' is not defined on bool")
  assert.equal(err('while 1 { }'), '1:7: condition must be bool, got i32')
  assert.equal(err('if 1 { }'), '1:4: condition must be bool, got i32')
  assert.equal(err('let x = if 1.5 { 1 } else { 2 };'), '1:12: condition must be bool, got f32')
  assert.deepEqual(ok('print(1 == 1, 1u != 2u, 1.5 < 2.5, true == false, true != false, 1 < 2 && 2 < 3 || false);'), ['true true true false true true'])
})

test('immutability: let without mut, parameters, loop variables and columns refuse assignment', () => {
  assert.equal(err('let x = 1; x = 2;'), "1:12: cannot assign to immutable 'x'")
  assert.equal(err('let a = [1, 2]; a[0] = 3;'), "1:17: cannot assign to immutable 'a'")
  assert.equal(err('let v = splat_f32x4(1.0); v[0] = 2.0;'), "1:27: cannot assign to immutable 'v'")
  assert.equal(err('fn f(n: i32) { n = 2; }'), "1:16: cannot assign to immutable 'n'")
  assert.equal(err('fn f(a: [i32; 2]) { a[0] = 2; }'), "1:21: cannot assign to immutable 'a'")
  assert.equal(err('for i in 0..3 { i = 1; }'), "1:17: cannot assign to immutable 'i'")
  assert.equal(err('for i in 0..3 { i += 1; }'), "1:17: cannot assign to immutable 'i'")
  assert.equal(err('let c = crowd.x; c[0] = 1.0;'), "1:18: cannot assign to immutable 'c'")
  assert.equal(err('let mut c = crowd.x; c[0] = 1.0;'), "1:22: cannot assign to a column 'c' (read-only)")
  assert.equal(err('crowd = 1;'), "1:1: 'crowd' is a table and cannot be assigned")
  assert.equal(err('y = 1;'), "1:1: unknown name 'y'")
  assert.equal(err('let mut x = 1; x[0] = 1;'), '1:16: cannot index i32')
  assert.equal(err('let mut x = 1; x = 1.5;'), "1:20: cannot assign f32 to i32 'x'")
  assert.equal(err('let mut a = [1, 2]; a[0] = 1.5;'), "1:28: cannot assign f32 to i32 'a[..]'")
  assert.equal(err('let mut a = [1, 2]; a[1.0] = 1;'), '1:23: index must be i32 or u32, got f32')
  assert.deepEqual(ok('let mut x = 1; x = 2; x += 3; let mut a = [0; 3]; a[1] = 5; a[1] *= 2; let mut v = splat_f32x4(0.0); v[2] = 1.5; v[2] += 1; print(x, a, v);'), ['5 [0, 10, 0] f32x4(0, 0, 2.5, 0)'])
  assert.deepEqual(ok('let mut c = crowd.x; c = crowd.z; print(c);'), ['col<f32>[0]'], 'a mutable col binding may be rebound to another column')
  // Pinned decision beyond the spec's "only as a let binding or fn param": a col is the column's name, one cell that
  // the VM resolves against each run's snapshot, so a fn may return one and an if-expression may choose one.
  assert.deepEqual(ok('fn g() -> col<f32> { crowd.x } let c = g(); let d = if true { crowd.x } else { crowd.z }; print(c, d, g().len());'), ['col<f32>[0] col<f32>[0] 0'])
})

// Where the spec is silent the tests decide and pin: a fn's body is its parameters' block and a for loop's body is its
// variable's block, so `fn f(a: i32) { let a = 2; }` and `for i in 0..2 { let i = 1; }` redeclare (an inner block may
// still shadow either). Positions: an error about an expression's value points at the expression's first token, except
// a binary operation or a cast, which point at the operator joining the two types; an error about a field or method
// name points at the name.
test('scopes: declaration before use, shadowing in inner blocks, no redeclaration in one block, reserved names', () => {
  assert.equal(err('print(y);'), "1:7: unknown name 'y'")
  assert.equal(err('let y = x; let x = 1;'), "1:9: unknown name 'x'")
  // A declaration error points at the name declared, not at the keyword.
  assert.equal(err('let x = 1; let x = 2;'), "1:16: 'x' already declared in this block")
  assert.equal(err('{ let x = 1; let x = 2; }'), "1:18: 'x' already declared in this block")
  assert.equal(err('fn f(a: i32) { let a = 2; }'), "1:20: 'a' already declared in this block")
  assert.equal(err('for i in 0..2 { let i = 1; }'), "1:21: 'i' already declared in this block")
  assert.deepEqual(ok('fn f(a: i32) -> i32 { let mut r = 0; { let a = a * 2; r = a; } r } print(f(4)); for i in 0..1 { { let i = 9; print(i); } print(i); }'), ['8', '9', '0'], 'an inner block shadows a parameter or a loop variable')
  assert.deepEqual(ok('let x = 1; { let x = 2; { let x = 3.5; print(x); } print(x); } print(x); for x in 7..8 { print(x); }'), ['3.5', '2', '1', '7'])
  assert.deepEqual(ok('let x = 1; { let x = x + 1; print(x); }'), ['2'], 'the initializer sees the outer binding')
  // Pinned decision, stricter than the spec's top-level rule: a table or intrinsic name cannot be declared in any scope
  // (an inner `let min` would still not shadow the intrinsic in a call, which resolves intrinsics first).
  assert.equal(err('let crowd = 1;'), "1:5: 'crowd' is a table and cannot be declared")
  assert.equal(err('let min = 2;'), "1:5: 'min' is an intrinsic and cannot be declared")
  assert.equal(err('{ let frame = 2; }'), "1:7: 'frame' is a table and cannot be declared")
  assert.equal(err('{ let min = 2; print(min); }'), "1:7: 'min' is an intrinsic and cannot be declared")
  assert.equal(err('fn f() { let sqrt = 2; print(sqrt); } f();'), "1:14: 'sqrt' is an intrinsic and cannot be declared")
  assert.equal(err('fn f(cars: i32) { }'), "1:6: 'cars' is a table and cannot be declared")
  assert.equal(err('for print in 0..1 { }'), "1:5: 'print' is an intrinsic and cannot be declared")
  assert.equal(err('fn min(a: i32) -> i32 { a }'), "1:4: 'min' is an intrinsic and cannot be redefined")
  assert.equal(err('fn crowd() { }'), "1:4: 'crowd' is a table and cannot be redefined")
  // One namespace (pinned): a name is a fn or a variable, on one line or across lines, and a parameter is a variable.
  assert.equal(err('let f = 1; fn f() -> i32 { 2 } print(f, f());'), "1:5: 'f' is a fn and cannot be declared")
  assert.equal(err('fn k(k: i32) { }'), "1:6: 'k' is a fn and cannot be declared")
  const two = new NoirSession()
  assert.equal(two.run('fn g() -> i32 { 1 } let h = 1;').error, undefined)
  assert.equal(two.run('let g = 2;').error, "1:5: 'g' is a fn and cannot be declared")
  assert.equal(two.run('fn h() { }').error, "1:4: 'h' is a variable and cannot be a fn")
  assert.equal(two.run('{ let g = 2; }').error, "1:7: 'g' is a fn and cannot be declared")
  assert.deepEqual(two.words().slice(-2), ['g', 'h'])
  assert.equal(err('let x = 1; let y = x.len();'), '1:22: no method \'len\' on i32')
  assert.equal(err('print(crowd);'), "1:7: 'crowd' is a table: use its fields (crowd.n, crowd.x, crowd.z)")
  assert.equal(err('print(cars);'), "1:7: 'cars' is a table: use its fields (cars.n, cars.x, cars.z, cars.heading, cars.speed, cars.mode)")
  assert.equal(err('print(min);'), "1:7: 'min' is a fn: call it")
  assert.equal(err('fn f() { } print(f);'), "1:18: 'f' is a fn: call it")
  assert.equal(err('let x = 1; print(x(1));'), "1:18: 'x' is a variable, not a fn")
  assert.equal(err('g(1);'), "1:1: unknown fn 'g'")
})

test('functions: full signatures, arity and argument types, missing returns, return rules, two-pass recursion', () => {
  assert.equal(err('fn f(a: i32, b: i32) -> i32 { a + b } print(f(1));'), "1:45: fn 'f' takes 2 arguments, got 1")
  assert.equal(err('fn f(a: i32) -> i32 { a } print(f());'), "1:33: fn 'f' takes 1 argument, got 0")
  assert.equal(err('fn f(a: i32) -> i32 { a } print(f(1.5));'), "1:35: fn 'f': argument 1 is f32, expected i32")
  assert.equal(err('fn f(xs: col<f32>) -> f32 { xs[0] } print(f(crowd.n));'), "1:45: fn 'f': argument 1 is i32, expected col<f32>")
  assert.equal(err('fn f(xs: col<f32>) -> f32 { xs[0] } print(f(crowd.mode));'), "1:51: no field 'mode' on crowd (n, x, z)", 'crowd has no mode column; the name is blamed')
  assert.equal(err('fn f(xs: col<f32>) -> f32 { xs[0] } print(f(crowd.z[0]));'), "1:45: fn 'f': argument 1 is f32, expected col<f32>", 'an argument error points at the argument expression\'s start')
  assert.equal(err('fn f(a: i32) -> i32 { a } print(f(1.5 as f32));'), "1:39: fn 'f': argument 1 is f32, expected i32", 'a cast sits at its as')
  assert.equal(err('fn f(xs: col<f32>) -> f32 { xs[0] } print(f(cars.mode));'), "1:45: fn 'f': argument 1 is col<i32>, expected col<f32>")
  assert.equal(err('fn f() -> i32 { let x = 1; }'), "1:28: missing return in fn 'f' -> i32")
  assert.equal(err('fn f() -> i32 { if true { 1 } }'), "1:27: value not used: end it with ';'")
  assert.equal(err('fn f() -> i32 { loop { break; } }'), "1:33: missing return in fn 'f' -> i32")
  assert.equal(err('fn f() -> i32 { while true { return 1; } }'), "1:42: missing return in fn 'f' -> i32")
  assert.equal(err('fn f(n: i32) -> i32 { if n > 0 { return 1; } }'), "1:46: missing return in fn 'f' -> i32")
  assert.equal(err('fn f() -> i32 { 1.5 }'), "1:17: fn 'f' -> i32 ends with a f32 value")
  assert.equal(err('fn f() -> i32 { print(1) }'), "1:17: fn 'f' -> i32 ends with a void value")
  assert.equal(err('fn f() { 1 }'), "1:10: value not used: end it with ';'")
  assert.equal(err('fn f() { return 1; }'), "1:17: fn 'f' returns nothing: 'return' takes no value")
  assert.equal(err('fn f() -> i32 { return; }'), "1:17: fn 'f' -> i32: 'return' needs a value")
  assert.equal(err('fn f() -> i32 { return 1.5; }'), "1:24: fn 'f' -> i32: cannot return f32")
  assert.equal(err('return 1;'), "1:1: 'return' outside a fn")
  assert.equal(err('fn f(a: void) { }'), "1:6: parameter 'a' cannot be void")
  assert.equal(err('fn f(a: i32, a: i32) { }'), "1:6: parameter 'a' declared twice")
  assert.equal(err('fn f() { } fn f() { }'), "1:15: fn 'f' already declared on this line")
  assert.equal(err('fn f() -> i32 { { let y = 1; y } }'), "1:30: value not used: end it with ';'", 'only if-expressions and fn bodies yield block values')
  assert.deepEqual(ok('fn f() -> i32 { loop { } } print(1);'), ['1'], 'a loop without break never falls through')
  assert.deepEqual(ok('fn f(n: i32) -> i32 { if n > 0 { return 1; } else { return 2; } } print(f(1), f(-1));'), ['1 2'])
  assert.deepEqual(ok('fn f(n: i32) -> i32 { if n > 0 { return 1; } else { 2 } } print(f(1), f(-1));'), ['1 2'])
  assert.deepEqual(ok('fn f(n: i32) -> i32 { if n > 0 { 1 } else if n < 0 { -1 } else { 0 } } print(f(5), f(-5), f(0));'), ['1 -1 0'])
  assert.deepEqual(ok('fn f(n: i32) -> i32 { if n > 10 { return 100; } n * 2 } print(f(3), f(30));'), ['6 100'])
  assert.deepEqual(ok('fn f() { print(1) } f();'), ['1'], 'a void call may end a void fn without a semicolon')
  assert.deepEqual(ok('fn f() -> i32 { return 1; 2 } print(f());'), ['1'], 'a tail after a return is unreachable, not an error')
  assert.deepEqual(ok('fn a(n: i32) -> i32 { if n == 0 { 0 } else { b(n - 1) + 1 } } fn b(n: i32) -> i32 { if n == 0 { 0 } else { a(n - 1) + 1 } } print(a(9));'), ['9'], 'a fn may call one declared later on the line')
  assert.equal(err('fn f() -> i32 { g() } fn g() -> f32 { 1.0 }'), "1:17: fn 'f' -> i32 ends with a f32 value")
})

test('query scope: the table\'s columns are the row\'s scalars, n is not, outer names stay visible, columns shadow', () => {
  assert.equal(err('let x = query cars where x;'), '1:26: query needs a bool, got f32')
  assert.equal(err('let x = query cars where n > 1;'), "1:26: unknown name 'n'")
  assert.equal(err('let x = query crowd where speed > 1.0;'), "1:27: unknown name 'speed'")
  assert.equal(err('let x = query kernel where true;'), "1:9: 'kernel' has no rows to query")
  assert.equal(err('let x = query frame where true;'), "1:9: 'frame' has no rows to query")
  assert.equal(err('let x = query foo where true;'), "1:9: unknown table 'foo'")
  assert.equal(err('let x = query cars where mode > 1.0;'), "1:31: type mismatch: i32 > f32 (use 'as f32' or 'as i32')")
  assert.equal(err('print(query cars where x > 0.0, x);'), "1:33: unknown name 'x'", 'the columns are only in scope inside the where')
  assert.deepEqual(ok('let lim = 1.0; let speed = 100.0; print(query cars where speed > lim && mode == 0, query crowd where x > z);'), ['0 0'])
})

test('cols, vectors, fields, lanes, indexing and len', () => {
  assert.equal(err('let c = crowd.x; print(c[1.0]);'), '1:26: index must be i32 or u32, got f32')
  assert.equal(err('print(1[0]);'), '1:7: cannot index i32')
  assert.equal(err('print(true[0]);'), '1:7: cannot index bool')
  assert.equal(err('let v = f32x4(1.0,2.0,3.0,4.0); print(v.q);'), "1:41: no field 'q' on f32x4")
  assert.equal(err('let v = splat_u32x8(1u); print(v.x);'), "1:34: no field 'x' on u32x8 (index it)")
  assert.equal(err('print(crowd.q);'), "1:13: no field 'q' on crowd (n, x, z)")
  assert.equal(err('print(kernel.n);'), "1:14: no field 'n' on kernel (law1, law2, law3, flips, shielded)")
  assert.equal(err('print(frame.law1);'), "1:13: no field 'law1' on frame (fps, ms, p95)")
  assert.equal(err('let x = 1; print(x.x);'), "1:20: no field 'x' on i32")
  assert.equal(err('let a = [1,2]; print(a.foo());'), "1:24: no method 'foo' on [i32; 2]")
  assert.equal(err('print((1).len());'), "1:11: no method 'len' on i32")
  assert.equal(err('let a = [1,2]; print(a.len(1));'), '1:24: len takes no arguments')
  assert.equal(err('let x = crowd.x as i32;'), '1:17: cannot cast col<f32> as i32')
  assert.equal(err('let x = load_f32x4(crowd.x, 1.0);'), '1:9: load_f32x4: no form takes (col<f32>, f32)')
  assert.equal(err('let x = load_i32x4(crowd.x, 0);'), '1:9: load_i32x4: no form takes (col<f32>, i32)')
  assert.deepEqual(ok('let v = f32x4(1.0, 2.0, 3.0, 4.0); let c = crowd.x; let m = cars.mode; print(v.x, v.w, v[1], v.len(), c.len(), m.len(), splat_u32x8(1u).len(), [1, 2, 3].len(), c, m, kernel.shielded, frame.fps);'), ['1 4 2 4 0 0 8 3 col<f32>[0] col<i32>[0] false 0'])
  assert.deepEqual(ok('fn first(xs: col<f32>) -> i32 { xs.len() } print(first(crowd.z), first(cars.speed));'), ['0 0'])
})

test('as: scalars among themselves, bool to an integer, lane-wise between 4-lane vectors, nothing else', () => {
  assert.equal(err('let x = true as f32;'), '1:14: cannot cast bool as f32')
  assert.equal(err('let x = 1 as bool;'), '1:11: cannot cast i32 as bool')
  assert.equal(err('let x = f32x4(1.0,2.0,3.0,4.0) as u32x8;'), '1:32: cannot cast f32x4 as u32x8')
  assert.equal(err('let x = splat_u32x8(1u) as u32x4;'), '1:25: cannot cast u32x8 as u32x4')
  assert.equal(err('let x = 1 as f32x4;'), '1:11: cannot cast i32 as f32x4')
  assert.equal(err('let x = [1] as i32;'), '1:13: cannot cast [i32; 1] as i32')
  assert.deepEqual(ok('print(1 as f32, 1u as f32, 1.5 as i32, 1.5 as u32, -1 as u32, 4294967295u as i32, true as i32, false as u32, 1 as i32, splat_u32x8(2u) as u32x8, i32x4(1, -1, 2, -2) as u32x4, i32x4(1, -1, 2, -2) as f32x4, f32x4(1.5, -1.5, 3.0, 4.0) as i32x4);'),
    ['1 1 1 1 4294967295 -1 1 0 1 u32x8(2, 2, 2, 2, 2, 2, 2, 2) u32x4(1, 4294967295, 2, 4294967294) f32x4(1, -1, 2, -2) i32x4(1, -1, 3, 4)'])
})

test('values must be used or be calls; strings only reach print and the host writes; if branches agree', () => {
  assert.equal(err('1 + 2;'), '1:1: value not used')
  assert.equal(err('let x = 1; x;'), '1:12: value not used')
  assert.equal(err('crowd.n;'), '1:1: value not used')
  assert.equal(err('{ 1 }'), "1:3: value not used: end it with ';'")
  assert.equal(err('if true { 1 } else { 2 }'), "1:11: value not used: end it with ';'")
  assert.equal(err('if true { 1 }'), "1:11: value not used: end it with ';'")
  assert.equal(err('if true { print(1); } else { 2 }'), "1:30: value not used: end it with ';'")
  assert.equal(err('while true { 1 }'), "1:14: value not used: end it with ';'")
  assert.deepEqual(ok('fn f() -> i32 { 1 } f(); print(2);'), ['2'], 'a call may drop its value')
  assert.deepEqual(ok('if true { print(1); } else { print(2); }'), ['1'])
  assert.equal(err('let x = if true { print(1); } else { 2 };'), '1:9: if branches differ: void and i32')
  assert.equal(err('let x = if true { 1 } else { true };'), '1:9: if branches differ: i32 and bool')
  assert.equal(err('let x = if true { 1.5 } else { 2u };'), '1:9: if branches differ: f32 and u32')
  assert.equal(err('let x = "s";'), '1:9: a string can only be an argument of print, println, tune or steer')
  assert.equal(err('fn f(s: i32) { } f("x");'), '1:20: a string can only be an argument of print, println, tune or steer')
  assert.equal(err('let x = "a" == "a";'), '1:9: a string can only be an argument of print, println, tune or steer')
  assert.equal(err('let a = ["a"];'), '1:10: a string can only be an argument of print, println, tune or steer')
  // Decided where the spec is silent: a string is legal only directly as such an argument, not inside an if-expression.
  assert.equal(err('print(if true { "a" } else { "b" });'), '1:17: a string can only be an argument of print, println, tune or steer')
  assert.equal(err('print(1, print(2));'), '1:10: print: argument 2 is void')
  assert.equal(err('let x = print(1);'), "1:9: cannot bind 'x' to void")
  assert.equal(err('let x: i32 = 1.5;'), "1:14: cannot initialize i32 'x' with f32")
  assert.equal(err('let x: f32x4 = 2;'), "1:16: cannot initialize f32x4 'x' with i32")
  assert.equal(err('let a: [f32; 2] = [1, 2, 3];'), "1:19: cannot initialize [f32; 2] 'a' with [f32; 3]")
  assert.equal(err('let a = [1, true];'), '1:13: array elements differ: i32 and bool')
  assert.equal(err('let a = [1.5, 2u];'), '1:15: array elements differ: f32 and u32')
  assert.equal(err('let a = [crowd.x; 2];'), '1:10: an array cannot hold col<f32>')
  assert.equal(err('let a = [print(1); 2];'), '1:10: an array cannot hold void')
  assert.equal(err('let a = [crowd.x, crowd.z];'), '1:10: an array cannot hold col<f32>')
  assert.deepEqual(ok('print("a\\tb", "q\\"q", "x\\\\y"); print(); print("");'), ['a\tb q"q x\\y', '', ''])
})

test('for bounds must be i32 or u32 and agree; break and continue only inside loops', () => {
  // The bound that is wrong is the one named: for `0..1.0` that is the `1.0`, since the `0` would have adopted its type.
  assert.equal(err('for i in 0.0..1.0 { }'), '1:10: for bounds must be i32 or u32, got f32')
  assert.equal(err('for i in 0..1.0 { }'), '1:13: for bounds must be i32 or u32, got f32')
  assert.equal(err('for i in 1.0..0 { }'), '1:10: for bounds must be i32 or u32, got f32')
  assert.equal(err('let a = 0; let b = 1u; for i in a..b { }'), '1:36: for bounds differ: i32..u32')
  assert.equal(err('let a = 0u; let b = 1; for i in a..=b { }'), '1:37: for bounds differ: u32..=i32')
  assert.equal(err('for i in true..false { }'), '1:10: for bounds must be i32 or u32, got bool')
  assert.equal(err('for i in 0..true { }'), '1:13: for bounds must be i32 or u32, got bool')
  assert.equal(err('break;'), "1:1: 'break' outside a loop")
  assert.equal(err('continue;'), "1:1: 'continue' outside a loop")
  assert.equal(err('fn f() { break; }'), "1:10: 'break' outside a loop")
  assert.equal(err('if true { continue; }'), "1:11: 'continue' outside a loop")
  assert.deepEqual(ok('let n = 2u; for i in 0u..3 { print(i); } for j in 1..n { print(j); }'), ['0', '1', '2', '1'])
})

test('intrinsic overloads resolve by argument types; a miss names them', () => {
  assert.equal(err('print(min(1, 2, 3));'), '1:7: min: no form takes (i32, i32, i32)')
  assert.equal(err('let a = 1; print(min(a, 1.5));'), '1:18: min: no form takes (i32, f32)')
  assert.equal(err('print(abs(1u));'), '1:7: abs: no form takes (u32)')
  // An unsuffixed integer literal adopts f32 from a parameter, so sqrt(4) is legal; a bool never adopts anything.
  assert.deepEqual(ok('print(sqrt(4), sqrt(2) * sqrt(2), floor(1), min(2, 2.5));'), ['2 1.9999999 1 2'])
  assert.equal(err('print(sqrt(true));'), '1:7: sqrt: no form takes (bool)')
  assert.equal(err('let n = 4; print(sqrt(n));'), '1:18: sqrt: no form takes (i32)', 'a typed i32 does not adopt')
  assert.equal(err('print(f32x4(1.0, 2.0, 3.0));'), '1:7: f32x4: no form takes (f32, f32, f32)')
  assert.equal(err('print(select(true, 1, 2));'), '1:7: select: no form takes (bool, i32, i32)')
  assert.equal(err('print(select(mask(true), splat_f32x4(1.0), splat_f32x4(2.0)));'), '1:7: select: no form takes (u32, f32x4, f32x4)')
  assert.equal(err('print(hsum(1));'), '1:7: hsum: no form takes (i32)')
  assert.equal(err('print(any(true));'), '1:7: any: no form takes (bool)')
  // A bare literal adopts u32 from an intrinsic's parameter like any other parameter, so popcount(7) is legal; a
  // negative one cannot, and is named as the i32 it is by default.
  assert.deepEqual(ok('print(popcount(7), morton2(3, 5), rotl(1, 1), clz(0));'), ['3 39 2 32'])
  assert.equal(err('print(popcount(-7));'), '1:7: popcount: no form takes (i32)')
  assert.equal(err('print(morton2(3, -5));'), '1:7: morton2: no form takes (i32, i32)')
  assert.equal(err('let k = 7; print(popcount(k));'), '1:18: popcount: no form takes (i32)')
  assert.equal(err('print(tune(1, 2.0));'), '1:7: tune: no form takes (i32, f32)')
  assert.equal(err('print(tune("k", 2.0, 3.0));'), '1:7: tune: no form takes (str, f32, f32)')
  assert.equal(err('print(intent(1.0, 2.0, 3.0, 4.0));'), '1:7: intent: no form takes (f32, f32, f32, f32)')
  assert.equal(err('print(vlt(1, 2));'), '1:7: vlt: no form takes (i32, i32)')
  // A literal too big for i32 still adopts u32 (or f32) from a form that takes it; only a form set without either
  // names it as the literal it is.
  assert.deepEqual(ok('print(min(3000000000, 1), min(3000000000, -1));'), ['1 -1'])
  assert.equal(err('print(rotl(3000000000, -1));'), '1:7: rotl: no form takes (literal 3000000000, i32)')
  assert.equal(err('print(load_u32x8(crowd.x, 0));'), '1:7: load_u32x8: no form takes (col<f32>, i32)')
  assert.deepEqual(ok('print(select(1u, 1, 2.0), min(1, 1.5), max(2u, 1), abs(-1), abs(-1.5), select(mask(true), 1, 2), splat_f32x4(2), f32x4(1, 2, 3, 4), u32x8(1, 2, 3, 4, 5, 6, 7, 8));'),
    ['2 1 2 1 1.5 1 f32x4(2, 2, 2, 2) f32x4(1, 2, 3, 4) u32x8(1, 2, 3, 4, 5, 6, 7, 8)'], 'literals adopt the chosen form\'s parameter types')
  assert.deepEqual(ok('print(min(1, 2), min(1u, 2u), min(1.5, 2.5), max(splat_i32x4(1), splat_i32x4(2)), hsum(splat_u32x8(1u)), any(vlt(splat_u32x8(0u), splat_u32x8(1u))));'), ['1 1 1.5 i32x4(2, 2, 2, 2) 8 true'])
})

test('a compile error installs nothing: no fn, no global, and the session is unchanged', () => {
  const s = new NoirSession()
  const before = s.words().length
  const r = s.run('fn good() -> i32 { 1 } let g = 2; fn bad() -> i32 { 1.5 }')
  assert.equal(r.error, "1:53: fn 'bad' -> i32 ends with a f32 value")
  assert.deepEqual(r.defined, [])
  assert.equal(s.words().length, before)
  assert.equal(s.run('print(good());').error, "1:7: unknown fn 'good'")
  assert.equal(s.run('print(g);').error, "1:7: unknown name 'g'")
})
