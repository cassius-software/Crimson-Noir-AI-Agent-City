// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the shape of NoirScript's syntax tree: operator precedence from the binding
 * table (`1 + 2 * 3`, `a << 1 + 2`, `-x as f32`, `a && b || c`), the structure of if/else-if chains and their
 * promotion to a block's value, for ranges, array literals, query, if-expressions, method calls, types, and every
 * parse error with its line and column.
 * What breaks if it is removed? A precedence slip or a misparsed statement would compile to the wrong program.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Expr, Stmt } from './ast.ts'
import { parse, parseExpr } from './parser.ts'

/** A compact S-expression of an expression tree, for pinning structure without positions. */
function sx(e: Expr): string {
  switch (e.kind) {
    case 'int': return e.suffixed ? `${e.value}u` : String(e.value)
    case 'float': return `${e.value}f`
    case 'str': return JSON.stringify(e.value)
    case 'bool': return String(e.value)
    case 'ident': return e.name
    case 'unary': return `(${e.op} ${sx(e.e)})`
    case 'binary': return `(${e.op} ${sx(e.l)} ${sx(e.r)})`
    case 'cast': return `(as ${sx(e.e)} ${e.to.kind})`
    case 'call': return `(${e.callee}${e.args.map((a) => ` ${sx(a)}`).join('')})`
    case 'index': return `(index ${sx(e.e)} ${sx(e.index)})`
    case 'field': return `(. ${sx(e.e)} ${e.name})`
    case 'method': return `(.${e.name} ${sx(e.e)}${e.args.map((a) => ` ${sx(a)}`).join('')})`
    case 'fill': return `[${sx(e.value)}; ${e.n}]`
    case 'array': return `[${e.elems.map(sx).join(', ')}]`
    case 'query': return `(query ${e.table} ${sx(e.where)})`
    case 'if': return `(if ${sx(e.cond)} ${blk(e.then)} ${'stmts' in e.else ? blk(e.else) : sx(e.else)})`
  }
}
const blk = (b: { stmts: Stmt[]; tail: Expr | null }): string => `{${[...b.stmts.map(st), ...(b.tail ? [sx(b.tail)] : [])].join(' ')}}`
function st(s: Stmt): string {
  switch (s.kind) {
    case 'let': return `let${s.mutable ? ' mut' : ''} ${s.name}${s.declared ? `: ${s.declared.kind}` : ''} = ${sx(s.init)};`
    case 'assign': return `${s.name}${s.index ? `[${sx(s.index)}]` : ''} ${s.op} ${sx(s.value)};`
    case 'if': return `if ${sx(s.cond)} ${blk(s.then)}${s.else ? ` else ${'kind' in s.else && s.else.kind === 'if' ? st(s.else) : blk(s.else as { stmts: Stmt[]; tail: Expr | null })}` : ''}`
    case 'while': return `while ${sx(s.cond)} ${blk(s.body)}`
    case 'loop': return `loop ${blk(s.body)}`
    case 'for': return `for ${s.name} in ${sx(s.from)}${s.inclusive ? '..=' : '..'}${sx(s.to)} ${blk(s.body)}`
    case 'break': return 'break;'
    case 'continue': return 'continue;'
    case 'return': return `return${s.value ? ` ${sx(s.value)}` : ''};`
    case 'block': return blk(s.block)
    case 'expr': return `${sx(s.e)};`
  }
}
const items = (src: string): string[] => parse(src).items.map((it) => (it.kind === 'fn' ? `fn ${it.name}(${it.params.map((p) => `${p.name}: ${p.ty.kind}`).join(', ')}) -> ${it.ret.kind} ${blk(it.body)}` : st(it)))
const perr = (src: string): string => {
  try {
    parse(src)
  } catch (e) {
    return (e as Error).message
  }
  assert.fail(`${src} should not parse`)
}

test('precedence follows the binding table: * over +, + over <<, as over prefix, && over ||', () => {
  assert.equal(sx(parseExpr('1 + 2 * 3')), '(+ 1 (* 2 3))')
  assert.equal(sx(parseExpr('1 * 2 + 3')), '(+ (* 1 2) 3)')
  assert.equal(sx(parseExpr('a << 1 + 2')), '(<< a (+ 1 2))')
  assert.equal(sx(parseExpr('-x as f32')), '(- (as x f32))', 'as (12) binds tighter than prefix (11)')
  assert.equal(sx(parseExpr('!a as i32')), '(! (as a i32))')
  assert.equal(sx(parseExpr('a && b || c')), '(|| (&& a b) c)')
  assert.equal(sx(parseExpr('a || b && c')), '(|| a (&& b c))')
  assert.equal(sx(parseExpr('a == b < c')), '(== a (< b c))')
  assert.equal(sx(parseExpr('a | b ^ c & d')), '(| a (^ b (& c d)))')
  assert.equal(sx(parseExpr('a - b - c')), '(- (- a b) c)', 'left associative')
  assert.equal(sx(parseExpr('a / b % c * d')), '(* (% (/ a b) c) d)')
  assert.equal(sx(parseExpr('x as f32 as i32')), '(as (as x f32) i32)')
  assert.equal(sx(parseExpr('(1 + 2) * 3')), '(* (+ 1 2) 3)')
  assert.equal(sx(parseExpr('-a * b')), '(* (- a) b)')
  assert.equal(sx(parseExpr('~a & b')), '(& (~ a) b)')
  assert.equal(sx(parseExpr('1 < 2 == true')), '(== (< 1 2) true)')
})

test('a minus before a number folds into the literal and still takes as and the postfix forms', () => {
  assert.equal(sx(parseExpr('-1')), '-1')
  assert.equal(sx(parseExpr('-2147483648')), '-2147483648')
  assert.equal(sx(parseExpr('-1.5')), '-1.5f')
  assert.equal(sx(parseExpr('-1 as u32')), '(as -1 u32)')
  assert.equal(sx(parseExpr('- -1')), '(- -1)')
  assert.equal(sx(parseExpr('2 -1')), '(- 2 1)', 'infix minus is not a sign')
  assert.equal(sx(parseExpr('-x')), '(- x)')
  assert.equal(sx(parseExpr('7u + 1')), '(+ 7u 1)')
})

test('postfix forms: calls, index, field, method, chained', () => {
  assert.equal(sx(parseExpr('f(1, x, g())')), '(f 1 x (g))')
  assert.equal(sx(parseExpr('a[i + 1]')), '(index a (+ i 1))')
  assert.equal(sx(parseExpr('crowd.x[i]')), '(index (. crowd x) i)')
  assert.equal(sx(parseExpr('v.x + v.w')), '(+ (. v x) (. v w))')
  assert.equal(sx(parseExpr('a.len()')), '(.len a)')
  assert.equal(sx(parseExpr('crowd.x.len() - 1')), '(- (.len (. crowd x)) 1)')
  assert.equal(sx(parseExpr('f32x4(1.0, 2.0, 3.0, 4.0)')), '(f32x4 1f 2f 3f 4f)', 'a type name followed by ( is a constructor call')
  assert.equal(sx(parseExpr('a[0][1]')), '(index (index a 0) 1)')
  assert.equal(sx(parseExpr('-v[0]')), '(- (index v 0))')
  assert.equal(sx(parseExpr('x as f32 * 2.0')), '(* (as x f32) 2f)')
})

test('array literals: fill and list forms; query; if-expression; strings and booleans', () => {
  assert.equal(sx(parseExpr('[0; 64]')), '[0; 64]')
  assert.equal(sx(parseExpr('[1, 2, 3]')), '[1, 2, 3]')
  assert.equal(sx(parseExpr('[[1, 2], [3, 4]]')), '[[1, 2], [3, 4]]')
  assert.equal(sx(parseExpr('[x + 1]')), '[(+ x 1)]')
  assert.equal(sx(parseExpr('query cars where speed > 5.0')), '(query cars (> speed 5f))')
  assert.equal(sx(parseExpr('query crowd where x > 0.0 && z < 10.0')), '(query crowd (&& (> x 0f) (< z 10f)))')
  assert.equal(sx(parseExpr('if a { 1 } else { 2 }')), '(if a {1} {2})')
  assert.equal(sx(parseExpr('if a { 1 } else if b { 2 } else { 3 }')), '(if a {1} (if b {2} {3}))')
  assert.equal(sx(parseExpr('if a { let y = 2; y } else { 3 } + 1')), '(+ (if a {let y = 2; y} {3}) 1)')
  assert.equal(sx(parseExpr('"a\\nb"')), '"a\\nb"')
  assert.equal(sx(parseExpr('true && false')), '(&& true false)')
})

test('statements: let, mut, annotations, assignments, compound assignments, expression statements', () => {
  assert.deepEqual(items('let x = 1; let mut y: f32 = 2.0; let z: [i32; 4] = [0; 4];'), ['let x = 1;', 'let mut y: f32 = 2f;', 'let z: array = [0; 4];'])
  assert.deepEqual(items('x = 1; x += 2; a[i] <<= 3; a[0] = a[1];'), ['x = 1;', 'x += 2;', 'a[i] <<= 3;', 'a[0] = (index a 1);'])
  assert.deepEqual(items('f(); print(1, "two"); x + 1;'), ['(f);', '(print 1 "two");', '(+ x 1);'])
  assert.deepEqual(items(';;'), [], 'stray semicolons are empty statements')
  assert.deepEqual(items('let c = crowd.x; let v = c.len();'), ['let c = (. crowd x);', 'let v = (.len c);'])
})

test('control flow: if/else-if chains stay statements mid-block and become the value at a block end', () => {
  assert.deepEqual(items('if a { f(); } f();'), ['if a {(f);}', '(f);'])
  assert.deepEqual(items('if a { f(); } else if b { g(); } else { h(); } f();'), ['if a {(f);} else if b {(g);} else {(h);}', '(f);'])
  assert.deepEqual(items('fn f(n: i32) -> i32 { if n < 2 { n } else { f(n - 1) + f(n - 2) } }'), ['fn f(n: i32) -> i32 {(if (< n 2) {n} {(+ (f (- n 1)) (f (- n 2)))})}'])
  assert.deepEqual(items('fn s(n: i32) -> i32 { if n < 0 { -1 } else if n == 0 { 0 } else { 1 } }'), ['fn s(n: i32) -> i32 {(if (< n 0) {-1} (if (== n 0) {0} {1}))}'])
  assert.deepEqual(items('fn g(n: i32) { if n < 2 { f(); } }'), ['fn g(n: i32) -> void {if (< n 2) {(f);}}'], 'without an else it stays a statement')
  assert.deepEqual(items('fn g(n: i32) { if n < 2 { f(); } else if n < 3 { g(); } }'), ['fn g(n: i32) -> void {if (< n 2) {(f);} else if (< n 3) {(g);}}'], 'an incomplete chain stays a statement')
  assert.deepEqual(items('{ let x = 1; x }'), ['{let x = 1; x}'])
  assert.deepEqual(items('fn f() -> i32 { return 1; }'), ['fn f() -> i32 {return 1;}'])
})

test('loops: while, loop, for with .. and ..=, break and continue', () => {
  assert.deepEqual(items('while i < 10 { i += 1; if i == 5 { continue; } if i == 8 { break; } }'), ['while (< i 10) {i += 1; if (== i 5) {continue;} if (== i 8) {break;}}'])
  assert.deepEqual(items('loop { break; }'), ['loop {break;}'])
  assert.deepEqual(items('for i in 0..10 { s += i; }'), ['for i in 0..10 {s += i;}'])
  assert.deepEqual(items('for i in a..=b + 1 { }'), ['for i in a..=(+ b 1) {}'])
  assert.deepEqual(items('for i in 0..crowd.n { s += crowd.x[i]; }'), ['for i in 0..(. crowd n) {s += (index (. crowd x) i);}'])
})

test('fn declarations: params, return type, void default, col and array types', () => {
  assert.deepEqual(items('fn f(a: i32, b: f32x4, c: col<f32>, d: [u32; 8]) -> bool { true }'), ['fn f(a: i32, b: f32x4, c: col, d: array) -> bool {true}'])
  assert.deepEqual(items('fn v() { }'), ['fn v() -> void {}'])
  const p = parse('fn f(d: [[f32; 2]; 3]) { }').items[0]!
  assert.equal(p.kind, 'fn')
  if (p.kind === 'fn') assert.deepEqual(p.params[0]!.ty, { kind: 'array', elem: { kind: 'array', elem: { kind: 'f32' }, n: 2 }, n: 3 })
})

test('every parse error names its line and column', () => {
  assert.equal(perr('let x = 1 }'), "1:11: expected ';' after statement, got '}'")
  assert.equal(perr('{\n  let x = 1\n}'), "3:1: expected ';' after statement, got '}'")
  assert.equal(perr('fn f() {\n  break\n}'), "3:1: expected ';' after statement, got '}'")
  assert.equal(perr('let x = ;'), "1:9: expected expression, got ';'")
  assert.equal(perr('1 + '), '1:5: expected expression, got end of input')
  assert.equal(perr('else { }'), "1:1: unexpected 'else'")
  assert.equal(perr('{ else }'), "1:3: unexpected 'else'")
  assert.equal(perr('let = 1;'), "1:5: expected a variable name, got '='")
  assert.equal(perr('let fn = 1;'), "1:5: 'fn' is a reserved word and cannot name a variable name")
  assert.equal(perr('let x: = 1;'), "1:8: expected a type, got '='")
  assert.equal(perr('let x 1;'), "1:7: expected '=' after 'let x', got '1'")
  assert.equal(perr('f(1,'), '1:5: expected expression, got end of input')
  assert.equal(perr('f(1 2)'), "1:5: expected ')', got '2'")
  assert.equal(perr('a[1;'), "1:4: expected ']', got ';'")
  assert.equal(perr('x = 1'), "1:6: expected ';' after statement, got end of input")
  assert.equal(perr('1 2;'), "1:3: expected ';' after statement, got '2'")
  assert.equal(perr('a + b = 1;'), '1:1: cannot assign to this expression (only a name or a name[index])')
  assert.equal(perr('a[0][1] = 1;'), '1:1: cannot assign to this expression (only a name or a name[index])')
  assert.equal(perr('{ fn f() {} }'), "1:3: 'fn' is only allowed at the top level")
  assert.equal(perr('fn f( { }'), "1:7: expected a parameter name, got '{'")
  assert.equal(perr('fn f(a) { }'), "1:7: expected ':' after parameter 'a', got ')'")
  assert.equal(perr('fn 1() { }'), "1:4: expected a fn name, got '1'")
  assert.equal(perr('fn f() -> { }'), "1:11: expected a type, got '{'")
  assert.equal(perr('for i 0..1 { }'), "1:7: expected 'in' after 'for i', got '0'")
  assert.equal(perr('for i in 0 { }'), "1:12: expected '..' or '..=' in for range, got '{'")
  assert.equal(perr('let x = [];'), "1:10: expected expression, got ']' (an array needs at least one element)")
  assert.equal(perr('let x = [0; 0];'), '1:13: array size must be 1 to 1048576')
  assert.equal(perr('let x = [0; 1048577];'), '1:13: array size must be 1 to 1048576')
  assert.equal(perr('let x: [i32; 0] = [0; 1];'), '1:14: array size must be 1 to 1048576')
  assert.equal(perr('let x = [0; n];'), "1:13: expected an array size, got 'n'")
  assert.equal(perr('let x: col<bool> = 1;'), "1:12: a col holds f32, i32 or u32, got 'bool'")
  assert.equal(perr('let x: col = 1;'), "1:12: expected '<' after col, got '='")
  assert.equal(perr('let x: [col<f32>; 2] = 1;'), '1:8: col<f32> cannot be an array element')
  assert.equal(perr('let x: [void; 2] = 1;'), '1:8: void cannot be an array element')
  assert.equal(perr('let x = query where x;'), "1:15: 'where' is a reserved word and cannot name a table name")
  assert.equal(perr('let x = query cars x;'), "1:20: expected 'where' after the table name, got 'x'")
  assert.equal(perr('let x = if a { 1 };'), "1:19: an if expression needs an else, got ';'")
  assert.equal(perr('let x = f32x4;'), "1:9: expected expression, got 'f32x4'")
  assert.equal(perr('{'), "1:2: expected '}', got end of input")
  assert.equal(perr('}'), "1:1: expected expression, got '}'")
  assert.equal(perr('let x = (1;'), "1:11: expected ')', got ';'")
  assert.equal(perr('a.1'), "1:3: expected a field name, got '1'")
  assert.equal(perr('let x = 1 @ 2;'), "1:11: unexpected character '@'", 'lexical errors come through the same door')
})
