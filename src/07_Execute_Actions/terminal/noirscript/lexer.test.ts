// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins NoirScript's tokens: every kind with its line and column, the separators and
 * both comment forms, decimal, hex and binary integers with `_` and the `u` suffix, floats with exponents and the
 * `f` suffix, strings with their escapes, the longest-match operators, and every lexical error with its position.
 * What breaks if it is removed? A token could move a column, a literal could change value, and no error would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { KEYWORDS, TYPE_NAMES, lex } from './lexer.ts'

const kinds = (src: string): string[] => lex(src).map((t) => (t.kind === 'eof' ? 'eof' : `${t.kind}:${t.text}`))
const err = (src: string): string => {
  try {
    lex(src)
  } catch (e) {
    return (e as Error).message
  }
  assert.fail(`${src} should not lex`)
}

test('every token kind carries its 1-based line and column', () => {
  const toks = lex('let x = 42;\n  fn f() -> f32 { "hi" }')
  assert.deepEqual(toks.map((t) => [t.kind, t.text, t.line, t.col]), [
    ['kw', 'let', 1, 1], ['ident', 'x', 1, 5], ['op', '=', 1, 7], ['int', '42', 1, 9], ['op', ';', 1, 11],
    ['kw', 'fn', 2, 3], ['ident', 'f', 2, 6], ['op', '(', 2, 7], ['op', ')', 2, 8], ['op', '->', 2, 10], ['type', 'f32', 2, 13],
    ['op', '{', 2, 17], ['str', '"hi"', 2, 19], ['op', '}', 2, 24], ['eof', '', 2, 25],
  ])
})

test('keywords and type names are their own kinds; everything else alphanumeric is an identifier', () => {
  for (const k of KEYWORDS) assert.deepEqual(kinds(k), [`kw:${k}`, 'eof'])
  for (const t of TYPE_NAMES) assert.deepEqual(kinds(t), [`type:${t}`, 'eof'])
  assert.deepEqual(kinds('_x9 letx If col2'), ['ident:_x9', 'ident:letx', 'ident:If', 'ident:col2', 'eof'])
  assert.equal(KEYWORDS.length, 17)
  assert.equal(TYPE_NAMES.length, 10)
  assert.ok(Object.isFrozen(KEYWORDS) && Object.isFrozen(TYPE_NAMES))
})

test('integer literals: decimal, hex, binary, separators, the u suffix, and the size limit', () => {
  const values = (src: string) => lex(src).filter((t) => t.kind === 'int').map((t) => [t.value, t.suffixed])
  assert.deepEqual(values('42 0xFF 0b1010 1_000_000 7u 0xFFu 0b11u 0 4294967295'), [[42, false], [255, false], [10, false], [1000000, false], [7, true], [255, true], [3, true], [0, false], [4294967295, false]])
  assert.deepEqual(values('0xffff_ffff 0XaB'), [[4294967295, false], [171, false]])
  assert.equal(err('4294967296'), '1:1: integer literal too large')
  assert.equal(err('0x1_0000_0000'), '1:1: integer literal too large')
  assert.equal(err('x = 99999999999'), '1:5: integer literal too large')
  assert.equal(err('0x'), "1:1: malformed hex literal '0x'")
  assert.equal(err('0b102'), "1:1: malformed binary literal '0b102'")
  // A `_` separates two digits, nowhere else.
  assert.deepEqual(values('1_0 0xF_F 0b1_0 1_000_000u'), [[10, false], [255, false], [2, false], [1000000, true]])
  assert.equal(err('1_'), "1:1: malformed integer literal '1_'")
  assert.equal(err('1__0'), "1:1: malformed integer literal '1_'")
  assert.equal(err('0x_F'), "1:1: malformed hex literal '0x_'")
  assert.equal(err('0b_1'), "1:1: malformed binary literal '0b_'")
  assert.equal(err('x = 1._5'), "1:5: malformed float literal '1._'")
  assert.equal(err('1_.5'), "1:1: malformed integer literal '1_'")
  assert.equal(lex('1_0.2_5')[0]!.value, Math.fround(10.25), 'a float takes separators on both sides of the point')
  assert.equal(lex('2147483648')[0]!.value, 2147483648, 'above i32 is a type question, not a lexical one')
})

test('float literals: fraction, trailing dot, exponent, the f suffix; always rounded to f32; .5 is not a float', () => {
  const floats = (src: string) => lex(src).filter((t) => t.kind === 'float').map((t) => t.value)
  assert.deepEqual(floats('1.5 2. 1e3 2.5e-2 1.0f 3f 1E+2'), [1.5, 2, 1000, Math.fround(0.025), 1, 3, 100])
  assert.equal(lex('0.1')[0]!.value, Math.fround(0.1))
  assert.deepEqual(kinds('.5'), ['op:.', 'int:5', 'eof'])
  assert.deepEqual(kinds('0..10'), ['int:0', 'op:..', 'int:10', 'eof'], 'a range is not a float')
  assert.deepEqual(kinds('0..=10'), ['int:0', 'op:..=', 'int:10', 'eof'])
  assert.equal(err('1e'), "1:1: malformed float literal '1e'")
  assert.equal(err('1.5e+'), "1:1: malformed float literal '1.5e+'")
})

test('strings decode the four escapes and refuse the rest; unterminated strings are named at their start', () => {
  const t = lex('"a\\nb\\t\\"q\\"\\\\"')[0]!
  assert.equal(t.kind, 'str')
  assert.equal(t.str, 'a\nb\t"q"\\')
  assert.equal(err('"open'), '1:1: unterminated string')
  assert.equal(err('x\n  "open\n'), '2:3: unterminated string')
  assert.equal(err('"\\q"'), "1:2: unknown escape '\\q'")
})

test('operators match longest first and every punctuation mark is a token', () => {
  const all = '+ - * / % & | ^ ~ ! << >> == != < <= > >= && || = += -= *= /= %= &= |= ^= <<= >>= -> .. ..= . , ; : :: ( ) { } [ ]'
  assert.deepEqual(lex(all).filter((t) => t.kind === 'op').map((t) => t.text), all.split(' '))
  assert.deepEqual(kinds('a<<=b>>=c'), ['ident:a', 'op:<<=', 'ident:b', 'op:>>=', 'ident:c', 'eof'])
  assert.deepEqual(kinds('a<-b'), ['ident:a', 'op:<', 'op:-', 'ident:b', 'eof'])
  assert.deepEqual(kinds('x->y'), ['ident:x', 'op:->', 'ident:y', 'eof'])
})

test('whitespace and both comment forms separate tokens and keep the line count honest', () => {
  const toks = lex('a // line comment\n/* block\n comment */ b /*x*/c')
  assert.deepEqual(toks.map((t) => [t.text, t.line, t.col]), [['a', 1, 1], ['b', 3, 13], ['c', 3, 20], ['', 3, 21]])
  assert.deepEqual(kinds('\t\r\n  '), ['eof'])
  assert.equal(err('/* open'), '1:1: unterminated comment')
  assert.deepEqual(kinds('a/b'), ['ident:a', 'op:/', 'ident:b', 'eof'], 'a lone slash divides')
})

test('lexical errors name the character and its position', () => {
  assert.equal(err('let @'), "1:5: unexpected character '@'")
  assert.equal(err('a\n\n   #'), "3:4: unexpected character '#'")
  assert.equal(err('`'), "1:1: unexpected character '`'")
  assert.equal(err("'"), "1:1: unexpected character '''")
})
