// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the shell's sums (arith.ts, `$(( ))`) to their promises: the operators with
 * the usual precedence, `&&`, `||` and `? :` working out only the side they take, every result exact or refused by
 * name (division by zero, a number past the largest safe integer, text that is no sum), variables followed a few
 * steps and never round a ring, and nesting refused at its cap instead of running out of stack.
 * What breaks if it is removed? A change could give a rounded number as if it were exact, make a guarded division
 * fail, or store a value in a branch the sum never took, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SumError, sum } from './arith.ts'
import type { Names } from './arith.ts'
import { boot } from './kit.test.ts'

/** Variables in a map the test can look into. */
function vars(init: Readonly<Record<string, string>> = {}): Names & { readonly map: Map<string, string> } {
  const map = new Map(Object.entries(init))
  return { map, get: (name) => map.get(name), set: (name, value) => { map.set(name, value) } }
}

const calc = (text: string, init: Readonly<Record<string, string>> = {}): number => sum(text, vars(init))

/** The reason a sum is refused, or null when it is not. Anything thrown but a SumError fails the test. */
function refused(text: string, init: Readonly<Record<string, string>> = {}): string | null {
  try {
    sum(text, vars(init))
    return null
  } catch (e) {
    if (e instanceof SumError) return e.message
    throw e
  }
}

const MAX = Number.MAX_SAFE_INTEGER

test('numbers: decimal and hex, blanks and line ends anywhere, and an empty sum is 0', () => {
  const cases: [string, number][] = [['42', 42], [' 42 ', 42], ['0x1F', 31], ['0XfF', 255], ['0', 0], ['007', 7], ['', 0], ['   ', 0],
    ['\n1\n+\n2\n', 3], ['\t1\t*\t2', 2]]
  for (const [text, want] of cases) assert.equal(calc(text), want, JSON.stringify(text))
  const bad: [string, string][] = [['12abc', "'abc' is not part of a sum"], ['0x', "'x' is not part of a sum"], ['1.5', "'.5' is not part of a sum"],
    ['1e3', "'e3' is not part of a sum"], ['$', "'$' is not part of a sum"], ['1 2', "'2' is not part of a sum"]]
  for (const [text, why] of bad) assert.equal(refused(text), why, text)
})

test('operators: the usual precedence and grouping', () => {
  const cases: [string, number][] = [
    ['1 + 2 * 3', 7], ['(1 + 2) * 3', 9], ['10 - 4 - 3', 3], ['2 * 3 % 4', 2], ['100 / 10 / 5', 2], ['-2 * 3', -6], ['- -2', 2], ['+3', 3],
    ['!0', 1], ['!5', 0], ['!!7', 1], ['!1 + 1', 1], ['-(3)', -3], ['((((5))))', 5], ['1-1', 0], ['1--1', 2], ['1+-1', 0], ['2*-3', -6],
    ['1 < 2', 1], ['2 <= 2', 1], ['3 > 4', 0], ['4 >= 5', 0], ['1 == 1', 1], ['1 != 1', 0], ['1<2', 1], ['2>=2', 1], ['1!=2', 1],
    ['1 < 2 == 1', 1], ['1 + 1 == 2', 1], ['2 > 1 > 0', 1], ['3 > 2 > 1', 0],
    ['1 && 2', 1], ['0 && 2', 0], ['0 || 0', 0], ['0 || 3', 1], ['5 && 0 || 2', 1], ['1 || 0 && 0', 1], ['1 == 1 && 2 < 1', 0],
    ['1 ? 2 : 3', 2], ['0 ? 2 : 3', 3], ['0 ? 1 : 0 ? 2 : 3', 3], ['1 ? 0 ? 4 : 5 : 6', 5], ['1 + 1 ? 7 : 8', 7],
  ]
  for (const [text, want] of cases) assert.equal(calc(text), want, text)
})

test('division truncates toward zero, the remainder takes the sign of the dividend, and dividing by zero is refused', () => {
  const cases: [string, number][] = [['7 / 2', 3], ['-7 / 2', -3], ['7 / -2', -3], ['-7 / -2', 3], ['7 % 3', 1], ['-7 % 3', -1], ['7 % -3', 1], ['0 / 5', 0],
    ['9007199254740991 / 3', 3002399751580330], ['-9007199254740991 / 2', -4503599627370495], ['9007199254740991 % 10', 1],
    ['9007199254740991 / 9007199254740991', 1]]
  for (const [text, want] of cases) assert.equal(calc(text), want, text)
  // What the shell prints of a zero is 0, whatever its sign.
  for (const text of ['-1 / 2', '0 * -1', '-4 % 2', '-0']) assert.equal(String(calc(text)), '0', text)
  for (const text of ['1 / 0', '1 % 0', '5 / (2 - 2)', 'x / y', '0 / 0']) assert.equal(refused(text), 'division by zero', text)
})

test('exact or refused: no result past the largest safe integer is given', () => {
  assert.equal(calc('9007199254740991'), MAX)
  assert.equal(calc('-9007199254740991'), -MAX)
  assert.equal(calc('9007199254740990 + 1'), MAX)
  assert.equal(calc('0x1FFFFFFFFFFFFF'), MAX)
  assert.equal(calc('94906265 * 94906265'), 9007199136250225)
  assert.equal(calc('x + 0', { x: '9007199254740991' }), MAX)
  for (const text of ['9007199254740992', '9007199254740993', '9007199254740991 + 1', '-9007199254740991 - 1', '94906267 * 94906267', '99999999999999999999',
    '0x20000000000000', `0x${'f'.repeat(1000)}`, '3037000500 * 3037000500', `${'9'.repeat(400)}`, '-9007199254740991 * -2', '4503599627370496 * 2']) {
    assert.equal(refused(text), 'a number too large to be exact', text)
  }
  assert.equal(refused('x + 1', { x: '9007199254740991' }), 'a number too large to be exact')
  assert.equal(refused('x', { x: '9007199254740993' }), 'a number too large to be exact')
  assert.equal(refused('x', { x: '-99999999999999999999' }), 'a number too large to be exact')
})

test('variables: unset or empty is 0, a value is trimmed and may be signed, and may name another or hold a sum of its own', () => {
  assert.equal(calc('x'), 0)
  assert.equal(calc('x + 1', { x: '' }), 1)
  assert.equal(calc('x', { x: '  -5 ' }), -5)
  assert.equal(calc('x', { x: '+5' }), 5)
  assert.equal(calc('x', { x: '0x10' }), 16)
  assert.equal(calc('_a1 * 2', { _a1: '21' }), 42)
  assert.equal(calc('x', { x: 'y', y: '3' }), 3)
  // A variable that holds a sum is worked out on its own, as one value.
  assert.equal(calc('x * 2', { x: '1 + 2' }), 6)
  assert.equal(refused('x', { x: 'abc def' }), "'def' is not part of a sum")
  assert.equal(refused('x', { x: '1.5' }), "'.5' is not part of a sum")
})

test('variables are followed eight steps at most, so a ring of names is refused by name', () => {
  /** a0 names a1, which names a2, ... and the last holds 7. */
  const chain = (links: number): Record<string, string> => {
    const out: Record<string, string> = {}
    for (let i = 0; i < links; i++) out[`a${i}`] = `a${i + 1}`
    out[`a${links}`] = '7'
    return out
  }
  assert.equal(calc('a0', chain(8)), 7)
  assert.equal(refused('a0', chain(9)), "'a8' never comes to a number")
  assert.equal(refused('a0', chain(30)), "'a8' never comes to a number")
  assert.match(refused('a', { a: 'b', b: 'a' }) ?? '', /^'[ab]' never comes to a number$/)
  assert.equal(refused('a', { a: 'a' }), "'a' never comes to a number")
  assert.equal(refused('a', { a: 'a + 1' }), "'a' never comes to a number")
})

test('name = sum stores the result as text and gives it; == is no assignment', () => {
  const v = vars()
  assert.equal(sum('x = 5', v), 5)
  assert.equal(v.map.get('x'), '5')
  assert.equal(sum('y = x * 2', v), 10)
  assert.equal(sum('a = b = 3', v), 3)
  assert.deepEqual([v.map.get('a'), v.map.get('b')], ['3', '3'])
  assert.equal(String(sum('z = -1 / 2', v)), '0')
  assert.equal(v.map.get('z'), '0')
  assert.equal(sum('x == 5', v), 1)
  assert.equal(v.map.get('x'), '5')
  assert.equal(sum('w=1', v), 1)
  assert.equal(sum('(i = 2) + i', v), 4)
  assert.equal(sum('c = 1 ? 8 : 9', v), 8)
  assert.equal(v.map.get('c'), '8')
  assert.equal(refused('x = '), 'a sum ends too soon')
  assert.equal(refused('5 = 3'), "'= 3' is not part of a sum")
  assert.equal(refused('(x) = 3'), "'= 3' is not part of a sum")
})

test('&&, || and ? : work out only the side they take: no refusal and no stored value from the other', () => {
  const cases: [string, number, Record<string, string>?][] = [
    ['0 && 1 / 0', 0], ['1 || 1 / 0', 1], ['1 ? 2 : 1 / 0', 2], ['0 ? 1 / 0 : 3', 3], ['n > 0 ? t / n : 0', 0, { t: '10' }],
    ['n > 0 ? t / n : 0', 5, { t: '10', n: '2' }],
    ['n != 0 && t % n == 0', 0, { t: '7' }], ['1 || 0 && 1 / 0', 1], ['0 && 99999999999999999999', 0], ['1 || 9007199254740991 + 1', 1],
    ['0 && x', 0, { x: 'a b' }],
    ['0 && 5', 0], ['3 || 0', 1], ['1 && 0 ? 1 / 0 : 4', 4], ['0 ? (1 ? 1 / 0 : 1 / 0) : 6', 6], ['0 && (0 || 1 / 0)', 0],
  ]
  for (const [text, want, init] of cases) assert.equal(calc(text, init), want, text)
  const v = vars()
  assert.equal(sum('0 && (x = 5)', v), 0)
  assert.equal(sum('1 || (x = 5)', v), 1)
  assert.equal(sum('1 ? (y = 1) : (z = 2)', v), 1)
  assert.equal(sum('0 ? (p = 1) : (q = 2)', v), 2)
  assert.equal(sum('0 && (1 || (r = 1))', v), 0)
  assert.equal(sum('0 && s', vars({ s: 't = 9' })), 0)
  assert.deepEqual([...v.map].sort(), [['q', '2'], ['y', '1']])
  // The side not taken must still be a sum.
  const bad: [string, string][] = [['0 && )', "')' is not part of a sum"], ['1 || 1 +', 'a sum ends too soon'], ['0 ? 1 :', 'a sum ends too soon'],
    ['1 ? 2', "'?' needs ':'"], ['0 && (1', "'(' needs ')'"], ['1 ? 2 : 3 4', "'4' is not part of a sum"]]
  for (const [text, why] of bad) assert.equal(refused(text), why, text)
})

test('refusals say why', () => {
  const cases: [string, string][] = [
    ['1 +', 'a sum ends too soon'], ['(1 + 2', "'(' needs ')'"], ['1 ? 2', "'?' needs ':'"], ['1 & 2', "'& 2' is not part of a sum"],
    ['1 | 2', "'| 2' is not part of a sum"], ['1 << 2', "'< 2' is not part of a sum"], ['x++', 'a sum ends too soon'], ['a b', "'b' is not part of a sum"],
    ['@', "'@' is not part of a sum"], [')', "')' is not part of a sum"], ['1 = 2', "'= 2' is not part of a sum"], ['1 ** 2', "'* 2' is not part of a sum"],
    ['()', "')' is not part of a sum"], ['-', 'a sum ends too soon'], ['!', 'a sum ends too soon'], ['1 ?: 2', "': 2' is not part of a sum"],
  ]
  for (const [text, why] of cases) assert.equal(refused(text), why, text)
})

test('depth: brackets, signs and chains up to the cap are worked out, deeper ones are refused by name, never out of stack', () => {
  // Each bracket costs two of the 64 levels (a sum and a term), each sign one.
  assert.equal(calc(`${'('.repeat(31)}1${')'.repeat(31)}`), 1)
  assert.equal(refused(`${'('.repeat(32)}1${')'.repeat(32)}`), 'a sum nested too deep')
  assert.equal(calc(`${'-'.repeat(62)}1`), 1)
  assert.equal(refused(`${'-'.repeat(63)}1`), 'a sum nested too deep')
  for (const text of [`${'('.repeat(100000)}1${')'.repeat(100000)}`, `${'-'.repeat(100000)}1`, `${'!'.repeat(100000)}1`, `${'+'.repeat(100000)}1`,
    `${'- '.repeat(50000)}1`,
    `${'1 ? '.repeat(30000)}1${' : 1'.repeat(30000)}`, `${'a = '.repeat(30000)}1`, `${'('.repeat(100000)}`]) {
    assert.equal(refused(text), 'a sum nested too deep', text.slice(0, 20))
  }
})

test('size: a flat sum of 100000 characters is worked out in one pass', () => {
  assert.equal(calc(Array(25000).fill('1').join(' + ')), 25000)
  assert.equal(calc(`1${' * 1'.repeat(25000)}`), 1)
  assert.equal(calc(`1${' == 1'.repeat(25000)}`), 1)
  assert.equal(calc(`1${' && 1'.repeat(20000)}`), 1)
  assert.equal(calc(`0${' || 0'.repeat(20000)}`), 0)
  assert.equal(calc(`${' '.repeat(100000)}5`), 5)
  assert.equal(calc(`x${' + x'.repeat(20000)}`, { x: '3' }), 60003)
  assert.equal(calc(`${'0'.repeat(100000)}1`), 1)
})

test('at the prompt: a loop counts, a guarded division is 0, and a refused sum is said with its text', () => {
  const k = boot({})
  assert.deepEqual(k.sh('i=0; while [ $i -lt 5 ]; do i=$((i+1)); done; echo $i'), ['5'])
  assert.deepEqual(k.sh('n=0; echo $(( n > 0 ? 10 / n : 0 )) $(( n && 10 / n ))'), ['0 0'])
  assert.deepEqual(k.sh('echo $(( n > 0 || (m = 4) )) $m'), ['1 4'])
  assert.deepEqual(k.sh('echo $((1/0))'), ['!ash: $((1/0)): division by zero'])
  assert.deepEqual(k.sh('echo $((9007199254740991 + 1))'), ['!ash: $((9007199254740991 + 1)): a number too large to be exact'])
  assert.deepEqual(k.sh('x=3; echo $((x * $x)) "$((x+1))"'), ['9 4'])
})
