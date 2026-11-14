// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the regular-expression engine to its word. A table for every construct says
 * which match a pattern must give on a text; every refusal is checked by its message; the engine is run beside the
 * host's own matcher on patterns generated here from a small grammar that both read alike (the host's matcher is
 * only the yardstick: it sees nothing but patterns this file made, and the engine's own source never names it);
 * and the shapes that stall a matcher which tries one path at a time are held to a count of steps, so the bound is
 * a number that is checked and not a hope about the clock.
 * What breaks if it is removed? A change to the engine could alter what a search finds or how a group is reported,
 * or let one typed pattern run long, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { compile, RegexError } from './regex.ts'
import type { Match, Regex, RegexOptions } from './regex.ts'

/**
 * A match as the tables write it: the whole match as `start,end`, then each group up to the last one that took
 * part, `-` for a group that did not; `none` for no match. So `0,2 - 1,2` is a match of the first two characters
 * in which the first group took no part and the second matched the second character.
 */
function spans(m: Match | null): string {
  if (m === null) return 'none'
  let last = 0
  for (let g = 1; g < m.groups.length; g++) if (m.groups[g] !== null) last = g
  const parts: string[] = []
  for (let g = 0; g <= last; g++) {
    const span = m.groups[g]
    parts.push(span === null ? '-' : `${span[0]},${span[1]}`)
  }
  return parts.join(' ')
}

/** A pattern, a text, and the match the first must give on the second (as `spans` writes it). */
type Row = readonly [pattern: string, text: string, want: string]

/** Checks every row with `exec`, and that `test` says the same. */
function table(rows: readonly Row[], options?: RegexOptions): void {
  for (const [pattern, text, want] of rows) {
    const label = `${JSON.stringify(pattern)} on ${JSON.stringify(text)}`
    const re = compile(pattern, options)
    const m = re.exec(text)
    assert.equal(spans(m), want, label)
    assert.equal(re.test(text), want !== 'none', `test: ${label}`)
    if (m !== null) {
      assert.equal(m.groups.length, 10, label)
      assert.deepEqual(m.groups[0], [m.start, m.end], label)
    }
  }
}

/** The message a pattern is refused with, or 'accepted'. Anything thrown that is no RegexError fails the test. */
function refusal(pattern: string, options?: RegexOptions): string {
  try {
    compile(pattern, options)
  } catch (e) {
    assert.ok(e instanceof RegexError, `${JSON.stringify(pattern)}: threw something that is no RegexError: ${String(e)}`)
    return e.message
  }
  return 'accepted'
}

/** The engine's own counts: how many instructions a pattern was laid out as, and how many steps the last run took. */
function counts(re: Regex): { readonly size: number; readonly steps: number } {
  const { size, steps } = re as Regex & { readonly size: number; readonly steps: number }
  assert.equal(typeof size, 'number')
  assert.equal(typeof steps, 'number')
  return { size, steps }
}

/** A tiny linear congruential generator: the same numbers on every run, so every generated case is the same. */
function generator(seed: number): (n: number) => number {
  let state = seed >>> 0
  return (n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return (state >>> 8) % n
  }
}

/** Every match in turn, the way a program that replaces all of them walks a line: one unit on after an empty one. */
function all(re: Regex, text: string): string[] {
  const found: string[] = []
  let from = 0
  for (let turns = 0; turns <= text.length + 1; turns++) {
    const m = re.exec(text, from)
    if (m === null) break
    found.push(`${m.start},${m.end}`)
    from = m.end > m.start ? m.end : m.end + 1
  }
  return found
}

const GRIN = '\u{1F600}'
const SMILE = '\u{1F601}'
const JOY = '\u{1F602}'

test('ordinary characters stand for themselves and the dot is any one character', () => {
  table([
    ['abc', 'xxabcxx', '2,5'],
    ['abc', 'ab', 'none'],
    ['abc', 'abxabc', '3,6'],
    ['', 'abc', '0,0'],
    ['', '', '0,0'],
    ['a', 'baa', '1,2'],
    ['a.c', 'abc', '0,3'],
    ['a.c', 'a\nc', '0,3'],
    ['a.c', 'ac', 'none'],
    ['.', '', 'none'],
    ['...', 'ab', 'none'],
    ['..', 'abc', '0,2'],
    ['a b', 'xa b', '1,4'],
    ['a,b=c:d', 'xa,b=c:d', '1,8'],
    ['a-b', 'a-b', '0,3'],
    ['caf\u00e9', 'un caf\u00e9', '3,7'],
    ['a"b\'c', 'a"b\'c', '0,5'],
  ])
})

test('sets: members, ranges, negation, and the characters that are themselves inside one', () => {
  table([
    ['[abc]', 'xbz', '1,2'],
    ['[abc]', 'xyz', 'none'],
    ['[^abc]', 'abcd', '3,4'],
    ['[^abc]', 'abc', 'none'],
    ['[^a]', '\n', '0,1'],
    ['[a-c]+', 'xabcd', '1,4'],
    ['[^a-c]+', 'abxyc', '2,4'],
    ['[a-cx-z]+', 'mbyn', '1,3'],
    ['[a-a]+', 'baab', '1,3'],
    ['[0-9a-fA-F]+', 'x7fZ', '1,3'],
    // `]` first in a set, or first after `^`, is itself
    ['[]a]+', 'x]a]', '1,4'],
    ['[^]a]+', ']ab]', '2,3'],
    ['[]]', 'a]', '1,2'],
    ['[]-a]+', '^]_a', '0,4'],
    // `-` first or last is itself, and so is an escaped one
    ['[a-]+', 'xa-a', '1,4'],
    ['[-a]+', 'x-a-', '1,4'],
    ['[^-a]+', '-ab-', '2,3'],
    ['[a\\-z]+', 'a-z', '0,3'],
    ['[a\\-z]', 'b', 'none'],
    ['[--/]+', 'a-./b', '1,4'],
    ['[a-z-9]+', '1b-9', '1,4'],
    // the characters with a meaning outside a set have none inside
    ['[.*+?(){}|^$]+', 'x.*+?(){}|^$y', '1,12'],
    ['[a^]+', 'x^a', '1,3'],
    ['[[]', 'a[', '1,2'],
    ['[a[]+', '[a[', '0,3'],
    ['[x:]+', 'ax:x', '1,4'],
    ['[:a]+', 'b:a:', '1,4'],
    ['[:abc:]+', 'x:cab:y', '1,6'],
    ['[^:a:]+', ':ab:', '2,3'],
    ['[a.]', 'b', 'none'],
    // a backslash works inside a set as it does outside
    ['[\\]]+', 'a]]', '1,3'],
    ['[\\\\]', 'a\\b', '1,2'],
    ['[\\t ]+', 'a \t b', '1,4'],
    ['[\\n]', 'a\nb', '1,2'],
    ['[\\d]+', 'ab12', '2,4'],
    ['[\\w.]+', '<a.b_1>', '1,6'],
    ['[^\\s]+', '  ab  ', '2,4'],
    ['[\\W]+', 'ab--cd', '2,4'],
    ['[\\D]+', '12ab34', '2,4'],
    ['[\\S]+', '  ab  ', '2,4'],
    ['[^\\W\\d]+', '12ab_34', '2,5'],
    ['[\\^a]+', 'b^a', '1,3'],
    // the named classes go inside a set, alone or beside other members
    ['[[:alpha:]]+', 'ab12', '0,2'],
    ['[[:digit:]]+', 'ab12', '2,4'],
    ['[^[:alpha:]]+', 'ab12cd', '2,4'],
    ['[[:alpha:][:digit:]_]+', '-a1_b-', '1,5'],
    ['[[:alpha:]-]+', '1a-b2', '1,4'],
    ['[a-c[:digit:]]+', 'xb2c9y', '1,5'],
    ['[^[:space:][:punct:]]+', ' ,ab. ', '2,4'],
    ['[[:upper:]][[:lower:]]+', 'the Word', '4,8'],
  ])
})

test('sets: every named class and every shorthand, checked on each ASCII character', () => {
  const letter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
  const digit = (c: number): boolean => c >= 48 && c <= 57
  const classes: Readonly<Record<string, (c: number) => boolean>> = {
    alpha: letter,
    digit,
    alnum: (c) => letter(c) || digit(c),
    upper: (c) => c >= 65 && c <= 90,
    lower: (c) => c >= 97 && c <= 122,
    space: (c) => c === 32 || (c >= 9 && c <= 13),
    blank: (c) => c === 32 || c === 9,
    punct: (c) => c > 32 && c < 127 && !letter(c) && !digit(c),
    xdigit: (c) => digit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102),
    print: (c) => c >= 32 && c < 127,
    graph: (c) => c > 32 && c < 127,
    cntrl: (c) => c < 32 || c === 127,
  }
  const shorthands: Readonly<Record<string, (c: number) => boolean>> = {
    w: (c) => letter(c) || digit(c) || c === 95,
    d: digit,
    s: (c) => c === 32 || (c >= 9 && c <= 13),
  }
  const check = (inside: string, outside: string, holds: (c: number) => boolean, name: string): void => {
    const yes = compile(inside)
    const no = compile(outside)
    for (let c = 0; c < 128; c++) {
      const ch = String.fromCharCode(c)
      assert.equal(yes.test(ch), holds(c), `${name} at ${c}`)
      assert.equal(no.test(ch), !holds(c), `not ${name} at ${c}`)
    }
    // Past ASCII nothing belongs to a class: these know the ASCII letters and digits only.
    for (const ch of ['\u00e9', '\u00a0', '\u0663', '\u2028', GRIN]) {
      assert.equal(yes.test(ch), false, `${name} at ${JSON.stringify(ch)}`)
      assert.equal(no.test(ch), true, `not ${name} at ${JSON.stringify(ch)}`)
    }
  }
  for (const [name, holds] of Object.entries(classes)) check(`[[:${name}:]]`, `[^[:${name}:]]`, holds, name)
  for (const [letterOf, holds] of Object.entries(shorthands)) {
    check(`\\${letterOf}`, `\\${letterOf.toUpperCase()}`, holds, `\\${letterOf}`)
    check(`[\\${letterOf}]`, `[\\${letterOf.toUpperCase()}]`, holds, `[\\${letterOf}]`)
  }
})

test('anchors are the start and the end of the whole text', () => {
  table([
    ['^a', 'ab', '0,1'],
    ['^b', 'ab', 'none'],
    ['b$', 'ab', '1,2'],
    ['a$', 'ab', 'none'],
    ['^$', '', '0,0'],
    ['^$', 'a', 'none'],
    ['^', 'ab', '0,0'],
    ['$', 'ab', '2,2'],
    ['^ab$', 'ab', '0,2'],
    ['^ab$', 'abb', 'none'],
    ['^a|b$', 'cb', '1,2'],
    ['^a|b$', 'ba', 'none'],
    ['(^a)', 'ab', '0,1 0,1'],
    ['(a$)', 'ba', '1,2 1,2'],
    ['(^|x)a', 'xa', '0,2 0,1'],
    ['(^|x)a', 'a', '0,1 0,0'],
    ['a($|b)', 'ab', '0,2 1,2'],
    ['a($|b)', 'ca', '1,2 2,2'],
    ['a^b', 'ab', 'none'],
    ['a$b', 'ab', 'none'],
    ['^^a$$', 'a', '0,1'],
    // not the start or the end of a line inside the text
    ['^b', 'a\nb', 'none'],
    ['a$', 'a\nb', 'none'],
    ['^a.b$', 'a\nb', '0,3'],
  ])
})

test('groups capture, and report where they matched', () => {
  table([
    ['(a)(b)', 'ab', '0,2 0,1 1,2'],
    ['(a(b))c', 'xabc', '1,4 1,3 2,3'],
    ['((a)(b))', 'ab', '0,2 0,2 0,1 1,2'],
    ['(a)|(b)', 'b', '0,1 - 0,1'],
    ['(a)(b)?', 'a', '0,1 0,1'],
    ['x(a)?', 'x', '0,1'],
    ['()', 'x', '0,0 0,0'],
    ['a()b', 'ab', '0,2 1,1'],
    ['(a|b)c', 'xbc', '1,3 1,2'],
    ['(ab|a)(bc|c)?', 'abc', '0,3 0,2 2,3'],
    // a group inside a repetition reports its last round only
    ['(a)*', 'aaa', '0,3 2,3'],
    ['(a)*', 'b', '0,0'],
    ['(a|b)*', 'abab', '0,4 3,4'],
    ['(a(b)?)+', 'aba', '0,3 2,3'],
    ['(a(b)?){2}', 'aba', '0,3 2,3'],
    ['(x(y)?)*', 'xyx', '0,3 2,3'],
    // and nothing, when the last round went another way
    ['(a|(b))*', 'ba', '0,2 1,2'],
    ['((a)|(b))*', 'ab', '0,2 1,2 - 1,2'],
    ['((a)|b)+', 'ab', '0,2 1,2'],
    ['((a)|(b)|(c))+', 'abc', '0,3 2,3 - - 2,3'],
    ['((a)|(b)){2}', 'ab', '0,2 1,2 - 1,2'],
    ['((a)*b)*', 'aabb', '0,4 3,4'],
    ['((a)*|b)*', 'aab', '0,3 2,3'],
    ['(a){0}b', 'ab', '1,2'],
  ])
})

test('groups past the ninth still group, and only the first nine are reported', () => {
  const eleven = compile('(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)')
  assert.equal(eleven.groupCount, 11)
  const m = eleven.exec('xabcdefghijk')
  assert.ok(m !== null)
  assert.equal(m.groups.length, 10)
  assert.equal(spans(m), '1,12 1,2 2,3 3,4 4,5 5,6 6,7 7,8 8,9 9,10')
  table([
    ['(a)(b)(c)(d)(e)(f)(g)(h)(i)(jk)+', 'abcdefghijkjk', '0,13 0,1 1,2 2,3 3,4 4,5 5,6 6,7 7,8 8,9'],
    ['(a)(b)(c)(d)(e)(f)(g)(h)(i)(j|k)l', 'abcdefghikl', '0,11 0,1 1,2 2,3 3,4 4,5 5,6 6,7 7,8 8,9'],
    ['(a)(b)(c)(d)(e)(f)(g)(h)(i)(j|k)l', 'abcdefghijkl', 'none'],
    ['((((((((((a))))))))))*b', 'aab', '0,3 1,2 1,2 1,2 1,2 1,2 1,2 1,2 1,2 1,2'],
    ['(((((((((((a*)))))))))))*b', 'b', '0,1'],
  ])
  assert.equal(compile('()()()()()()()()()()()()').groupCount, 12)
  assert.equal(compile('a').groupCount, 0)
  assert.equal(compile('\\(a\\)[(]').groupCount, 0)
})

test('alternatives: the leftmost match, and of two that start together the one written first', () => {
  table([
    ['a|b', 'xb', '1,2'],
    ['a|b', 'ba', '0,1'],
    ['a|b|c', 'xc', '1,2'],
    ['a|ab', 'ab', '0,1'],
    ['ab|a', 'ab', '0,2'],
    ['(a|ab)(c|bcd)(d*)', 'abcd', '0,4 0,1 1,4 4,4'],
    ['ab|cd', 'acd', '1,3'],
    ['(a|ab)*c', 'aabc', '0,4 1,3'],
    // the leftmost start wins even when a later one would be longer
    ['b+|a', 'abbb', '0,1'],
    ['abcd|bc|a', 'xabcx', '1,2'],
    // an alternative may be empty: it matches no characters
    ['a|', 'b', '0,0'],
    ['|a', 'a', '0,0'],
    ['a||b', 'b', '0,0'],
    ['(a|)b', 'b', '0,1 0,0'],
    ['(|a)+', 'aaa', '0,3 2,3'],
    ['(|a)*', 'aaa', '0,3 2,3'],
    ['(a|)+', 'aab', '0,2 1,2'],
    ['|', 'a', '0,0'],
  ])
})

test('repetition: every mark, and each prefers more rounds to fewer', () => {
  const ten = 'a'.repeat(10)
  table([
    ['a*', 'aaa', '0,3'],
    ['a*', 'baa', '0,0'],
    ['ba*', 'baa', '0,3'],
    ['a+', 'baa', '1,3'],
    ['a+', 'b', 'none'],
    ['a?', 'aa', '0,1'],
    ['ab?c', 'ac', '0,2'],
    ['ab?c', 'abc', '0,3'],
    ['ab?c', 'abbc', 'none'],
    ['a{2}', 'aaa', '0,2'],
    ['a{2}', 'a', 'none'],
    ['a{2,}', 'aaaa', '0,4'],
    ['a{2,}', 'a', 'none'],
    ['a{2,3}', 'aaaa', '0,3'],
    ['a{2,3}', 'aa', '0,2'],
    ['a{2,3}', 'a', 'none'],
    ['a{0}', 'a', '0,0'],
    ['a{0}b', 'ab', '1,2'],
    ['a{0,0}b', 'ab', '1,2'],
    ['a{0,1}', 'aa', '0,1'],
    ['a{1}', 'aa', '0,1'],
    ['a{0,}', 'aa', '0,2'],
    ['a{1,}', 'baa', '1,3'],
    ['a{02}', 'aaa', '0,2'],
    ['a{2,2}', 'aaa', '0,2'],
    ['a{10}', `b${ten}a`, '1,11'],
    ['a{10}', 'a'.repeat(9), 'none'],
    ['^a{3,5}$', 'a'.repeat(6), 'none'],
    ['(ab){2}', 'ababab', '0,4 2,4'],
    ['(ab){2,}', 'ababab', '0,6 4,6'],
    ['(a|b){2,3}', 'abab', '0,3 2,3'],
    ['x{2,3}y', 'xxxxy', '1,5'],
    ['[ab]{3}', 'xabab', '1,4'],
    ['.{3}', 'ab', 'none'],
    ['a*a', 'aaa', '0,3'],
    ['a*ab', 'aaab', '0,4'],
    ['a.*b', 'axxbyyb', '0,7'],
    ['a.*b', 'axx', 'none'],
    ['(a*)(a*)', 'aaa', '0,3 0,3 3,3'],
    ['(a+)(a*)', 'aaa', '0,3 0,3 3,3'],
    ['(a?)(a?)(a?)', 'aa', '0,2 0,1 1,2 2,2'],
    ['(.*)(.*)', 'ab', '0,2 0,2 2,2'],
    ['(.+)(.+)', 'abc', '0,3 0,2 2,3'],
    ['(.*)c', 'abcabc', '0,6 0,5'],
    ['(a+|b+)*c', 'aabbc', '0,5 2,4'],
  ])
})

test('repetition: marks may be stacked, and a brace that begins no count is itself', () => {
  table([
    // each mark repeats all that is before it: there is no lazy repetition
    ['a*?', 'aa', '0,2'],
    ['a+?', 'aa', '0,2'],
    ['a??', 'a', '0,1'],
    ['a+*', 'baa', '0,0'],
    ['ba+*', 'baa', '0,3'],
    ['a{2}{3}', 'aaaaaaa', '0,6'],
    ['a{2}{3}', 'aaaaa', 'none'],
    ['a{2}*', 'aaaaa', '0,4'],
    ['a{2}+', 'a', 'none'],
    // the second of the two rounds starts by emptying the group, then finds nothing left to put in it
    ['(a{2})*{2}', 'aaaa', '0,4'],
    ['(a{2})*{2}', 'aa', '0,2'],
    ['(a{2}){2}*', 'aaaaaa', '0,4 2,4'],
    ['a?{3}', 'aa', '0,2'],
    ['a{0}*b', 'ab', '1,2'],
    ['(a){0}{3}b', 'ab', '1,2'],
    ['((a){0}{3}b?)*', 'bb', '0,2 1,2'],
    // not a count: the brace and what follows stand for themselves
    ['a{', 'a{', '0,2'],
    ['{a}', '{a}', '0,3'],
    ['{', '{', '0,1'],
    ['a{,2}', 'a{,2}', '0,5'],
    ['a{1,2,3}', 'a{1,2,3}', '0,8'],
    ['a{x}', 'a{x}', '0,4'],
    ['a{1', 'a{1', '0,3'],
    ['a{1,', 'a{1,', '0,4'],
    ['a{ 2}', 'a{ 2}', '0,5'],
    ['x{2}{', 'xx{', '0,3'],
    ['a{}', 'a{}', '0,3'],
    ['a}', 'a}', '0,2'],
    ['a]', 'a]', '0,2'],
    ['a{2}}', 'aa}', '0,3'],
  ])
})

test('repetition of what can match nothing: no round past the least count is empty', () => {
  table([
    ['(a*)*', 'b', '0,0'],
    ['(a*)+', 'b', '0,0 0,0'],
    ['(a?){2}', 'b', '0,0 0,0'],
    ['(a?){0,2}', 'b', '0,0'],
    ['(a?){1,2}', 'b', '0,0 0,0'],
    ['(a*)*', 'aa', '0,2 0,2'],
    ['(a*)+$', 'aa', '0,2 0,2'],
    ['(a*)*b', 'aab', '0,3 0,2'],
    ['(a|b*)*', 'abb', '0,3 1,3'],
    ['(a*|b)*', 'b', '0,1 0,1'],
    ['(a?b?)*', 'ab', '0,2 0,2'],
    ['(a?b?)+', 'c', '0,0 0,0'],
    ['(a{0,2}){0,2}', 'aaa', '0,3 2,3'],
    ['()*', 'a', '0,0'],
    ['()+', 'a', '0,0 0,0'],
    ['(^)*a', 'a', '0,1'],
    ['(a*)*$', 'aab', '3,3'],
    ['((a*)*)*', 'aa', '0,2 0,2 0,2'],
    ['(\\b)*a', 'a', '0,1'],
  ])
})

test('escapes: a backslash makes a special character ordinary, and names a few others', () => {
  table([
    ['\\.', 'a.b', '1,2'],
    ['a\\.b', 'axb', 'none'],
    ['a\\+b', 'a+b', '0,3'],
    ['a\\+b', 'aab', 'none'],
    ['\\(a\\)', '(a)', '0,3'],
    ['\\[a\\]', '[a]', '0,3'],
    ['\\{2\\}', '{2}', '0,3'],
    ['a\\{2}', 'a{2}', '0,4'],
    ['a\\|b', 'a|b', '0,3'],
    ['\\*\\?', '*?', '0,2'],
    ['\\^\\$', '^$', '0,2'],
    ['\\\\', 'a\\b', '1,2'],
    ['\\\\\\\\', 'a\\\\b', '1,3'],
    ['a\\/b\\-c\\ d\\,e', 'a/b-c d,e', '0,9'],
    ['\\\u00e9', '\u00e9', '0,1'],
    ['a\\tb', 'a\tb', '0,3'],
    ['a\\nb', 'a\nb', '0,3'],
    ['\\t+', 'a\t\tb', '1,3'],
    ['\\w+', '-ab_1-', '1,5'],
    ['\\W+', 'ab -cd', '2,4'],
    ['\\d+', 'ab12cd', '2,4'],
    ['\\D+', '12ab34', '2,4'],
    ['\\s+', 'a \t\nb', '1,4'],
    ['\\s+', '\v\f\r', '0,3'],
    ['\\S+', '  ab  ', '2,4'],
    ['\\d{3}-\\d{4}', 'call 555-0199 now', '5,13'],
    // these know ASCII only
    ['\\w', '\u00e9', 'none'],
    ['\\W', '\u00e9', '0,1'],
    ['\\d', '\u0663', 'none'],
    ['\\s', '\u00a0', 'none'],
  ])
})

test('word edges: \\b and \\B, and the start and the end of a word', () => {
  table([
    ['\\bcat\\b', 'a cat.', '2,5'],
    ['\\bcat\\b', 'concat', 'none'],
    ['\\bcat\\b', 'cats', 'none'],
    ['\\bcat\\b', 'cat', '0,3'],
    ['\\Bcat', 'concat', '3,6'],
    ['\\Bcat', 'cat', 'none'],
    ['cat\\B', 'cats', '0,3'],
    ['cat\\B', 'cat', 'none'],
    ['\\<cat', 'a cat', '2,5'],
    ['\\<cat', 'concat', 'none'],
    ['cat\\>', 'cat.', '0,3'],
    ['cat\\>', 'cats', 'none'],
    ['\\<', '  ab', '2,2'],
    ['\\>', 'ab  ', '2,2'],
    ['\\<', '   ', 'none'],
    ['\\>', '', 'none'],
    ['\\b', '', 'none'],
    ['\\b', '  ab', '2,2'],
    ['\\B', '', '0,0'],
    ['\\B', 'ab', '1,1'],
    ['\\<\\w+\\>', '--word_1--', '2,8'],
    ['\\>\\<', 'ab cd', 'none'],
    ['\\> \\<', 'ab cd', '2,3'],
    ['a\\>\\.', 'a.', '0,2'],
    ['\\b\\b\\<a\\>\\b', 'a', '0,1'],
    ['x\\b', 'ax', '1,2'],
    ['\\bx', 'x', '0,1'],
    ['\\<x\\>', 'ax xa x', '6,7'],
    // a letter outside ASCII is no word character here
    ['\\<\u00e9', '\u00e9', 'none'],
    ['a\\b', 'a\u00e9', '0,1'],
  ])
})

test('ignoreCase: letters match in either case, one code point folded to one', () => {
  table([
    ['abc', 'xABCx', '1,4'],
    ['ABC', 'xabcx', '1,4'],
    ['aBc', 'AbC', '0,3'],
    ['a.c', 'ABC', '0,3'],
    ['[a-c]+', 'xABCx', '1,4'],
    ['[A-C]+', 'xabcx', '1,4'],
    ['[x]', 'X', '0,1'],
    ['[^a]', 'A', 'none'],
    ['[^a]+', 'aAbB', '2,4'],
    ['[^A-C]+', 'abxyc', '2,4'],
    ['[[:upper:]]+', 'ab1', '0,2'],
    ['[[:lower:]]+', 'AB1', '0,2'],
    ['\\w+', '-aB-', '1,3'],
    ['(a)|b', 'B', '0,1'],
    ['(a+)b', 'AaB', '0,3 0,2'],
    ['a1_', 'A1_', '0,3'],
    ['\u00e9', '\u00c9', '0,1'],
    ['\u00c9+', 'caf\u00e9\u00c9', '3,5'],
    ['[\u00e0-\u00e9]', '\u00c9', '0,1'],
    ['\u03c3', '\u03a3', '0,1'],
    // the final sigma folds to the same letter as the other two
    ['\u03c3', '\u03c2', '0,1'],
    // a case pair outside the first 65536 characters
    ['\u{10428}', `a\u{10400}`, '1,3'],
    ['[\u{10400}-\u{10410}]', '\u{10428}', '0,2'],
    // a fold that would take two characters is not made
    ['\u00df', 'SS', 'none'],
    ['\u00df', '\u00df', '0,1'],
  ], { ignoreCase: true })
  // and without the option nothing folds
  table([
    ['abc', 'ABC', 'none'],
    ['[a-c]', 'B', 'none'],
    ['\u00e9', '\u00c9', 'none'],
  ])
  table([['abc', 'ABC', 'none']], { ignoreCase: false })
})

test('literal: the pattern is plain text', () => {
  table([
    ['a.c', 'abc', 'none'],
    ['a.c', 'xa.c', '1,4'],
    ['(a|b)*', 'x(a|b)*', '1,7'],
    ['[a]', '[a]', '0,3'],
    ['\\1', 'a\\1', '1,3'],
    ['a\\', 'a\\', '0,2'],
    ['*', 'a*', '1,2'],
    ['(', '(', '0,1'],
    ['^a$', 'a', 'none'],
    ['^a$', '^a$', '0,3'],
    ['', 'abc', '0,0'],
    ['a{2}', 'aa', 'none'],
    [GRIN, `a${GRIN}`, '1,3'],
  ], { literal: true })
  table([
    ['a.C', 'xA.c', '1,4'],
    ['a.c', 'abc', 'none'],
    ['(A)', '(a)', '0,3'],
  ], { literal: true, ignoreCase: true })
  assert.equal(compile('(a)(b)', { literal: true }).groupCount, 0)
  assert.equal(compile('(a)(b)', { literal: false }).groupCount, 2)
  assert.equal(refusal('(', { literal: true }), 'accepted')
})

test('exec: the leftmost match at or after a place, the rest of the text still in view', () => {
  const a = compile('a')
  assert.equal(spans(a.exec('aXa')), '0,1')
  assert.equal(spans(a.exec('aXa', 0)), '0,1')
  assert.equal(spans(a.exec('aXa', 1)), '2,3')
  assert.equal(spans(a.exec('aXa', 2)), '2,3')
  assert.equal(a.exec('aXa', 3), null)
  assert.equal(a.exec('aXa', 4), null)
  assert.equal(a.exec('aXa', Number.POSITIVE_INFINITY), null)
  // a place that is no place: below zero or no number is the start, a fraction is cut down
  assert.equal(spans(a.exec('aXa', -5)), '0,1')
  assert.equal(spans(a.exec('aXa', Number.NaN)), '0,1')
  assert.equal(spans(a.exec('aXa', 0.9)), '0,1')
  assert.equal(spans(a.exec('aXa', 1.5)), '2,3')
  // a match of no characters is a match, at the very end too, but not past it
  const nothing = compile('')
  assert.equal(spans(nothing.exec('abc', 2)), '2,2')
  assert.equal(spans(nothing.exec('abc', 3)), '3,3')
  assert.equal(nothing.exec('abc', 4), null)
  assert.equal(spans(compile('b*').exec('abb', 1)), '1,3')
  assert.equal(spans(compile('$').exec('ab', 1)), '2,2')
  // anchors and word edges look at the whole text, not at the part from `from` on
  assert.equal(compile('^a').exec('aa', 1), null)
  assert.equal(spans(compile('^a').exec('aa', 0)), '0,1')
  assert.equal(spans(compile('^').exec('aa', 0)), '0,0')
  assert.equal(compile('^').exec('aa', 1), null)
  assert.equal(spans(compile('\\bb').exec('ab b', 1)), '3,4')
  assert.equal(spans(compile('\\<b').exec('ab b', 1)), '3,4')
  assert.equal(spans(compile('\\Bb').exec('ab b', 1)), '1,2')
  assert.equal(spans(compile('(a)b').exec('abab', 1)), '2,4 2,3')
  // a pattern that is plain characters is found the same way
  assert.equal(spans(compile('ab').exec('abab', 1)), '2,4')
  assert.equal(compile('ab').exec('abab', 3), null)
  // walking a text the way a replace-all does
  assert.deepEqual(all(compile('a*'), 'baac'), ['0,0', '1,3', '3,3', '4,4'])
  assert.deepEqual(all(compile('a'), 'banana'), ['1,2', '3,4', '5,6'])
  assert.deepEqual(all(compile('x*'), ''), ['0,0'])
  assert.deepEqual(all(compile('\\b'), 'ab cd'), ['0,0', '2,2', '3,3', '5,5'])
  assert.deepEqual(all(compile('[0-9]+'), 'a1b22c333'), ['1,2', '3,5', '6,9'])
})

test('characters are code points, offsets are UTF-16 indexes', () => {
  const high = '\ud83d'
  const low = '\ude00'
  table([
    ['.', GRIN, '0,2'],
    ['^.$', GRIN, '0,2'],
    ['^..$', GRIN, 'none'],
    ['^.{2}$', GRIN + GRIN, '0,4'],
    ['[^a]', GRIN, '0,2'],
    ['a.b', `a${GRIN}b`, '0,4'],
    [`${GRIN}+`, `x${GRIN}${GRIN}`, '1,5'],
    [`[${GRIN}-${JOY}]+`, `a${SMILE}${JOY}b`, '1,5'],
    [`[^${GRIN}]`, `${GRIN}a`, '2,3'],
    [`[${GRIN}a]`, SMILE, 'none'],
    ['(.)(.)', `\u00e9${GRIN}`, '0,3 0,1 1,3'],
    ['(.)*', `${GRIN}${SMILE}`, '0,4 2,4'],
    [GRIN, `a${GRIN}`, '1,3'],
    [`${GRIN}b`, `${GRIN}a${GRIN}b`, '3,6'],
    // the two halves written one after the other are the pair
    [high + low, GRIN, '0,2'],
    // half a pair on its own is a character of its own, and is never found inside a whole pair
    ['.', high, '0,1'],
    [high, GRIN, 'none'],
    [low, GRIN, 'none'],
    [high, `a${high}`, '1,2'],
    [low, `${low}${GRIN}`, '0,1'],
    [`[${high}]`, GRIN, 'none'],
    [`${high}+`, `${high}${high}${GRIN}`, '0,2'],
    ['..', `${high}${high}${low}`, '0,3'],
  ])
  table([
    [high, GRIN, 'none'],
    [low, `${low}${GRIN}`, '0,1'],
    [GRIN, `a${GRIN}`, '1,3'],
  ], { literal: true })
  // a search never begins between the two halves of a pair: such a place means the place after the pair
  assert.equal(spans(compile('').exec(`${GRIN}a`, 1)), '2,2')
  assert.equal(spans(compile('.').exec(`${GRIN}a`, 1)), '2,3')
  assert.equal(spans(compile('a').exec(`${GRIN}a`, 1)), '2,3')
  assert.equal(compile(low).exec(GRIN, 1), null)
  assert.equal(spans(compile('').exec(GRIN, 1)), '2,2')
  // but a low half that follows no high half is a place like any other
  assert.equal(spans(compile('').exec(`a${low}b`, 1)), '1,1')
  assert.equal(spans(compile('.').exec(`${low}${low}`, 1)), '1,2')
  assert.deepEqual(all(compile('x*'), `${GRIN}a`), ['0,0', '2,2', '3,3'])
  assert.deepEqual(all(compile('.'), `a${GRIN}${SMILE}`), ['0,1', '1,3', '3,5'])
})

test('a pattern made ready: its source, its group count, and runs that leave nothing behind', () => {
  const re = compile('(a+)(b)?')
  assert.equal(re.source, '(a+)(b)?')
  assert.equal(re.groupCount, 2)
  assert.equal(compile('', { ignoreCase: true }).source, '')
  assert.equal(compile('a.c', { literal: true }).source, 'a.c')
  const first = re.exec('xaab')
  const second = re.exec('a')
  const third = re.exec('xaab')
  assert.equal(spans(first), '1,4 1,3 3,4')
  assert.equal(spans(second), '0,1 0,1')
  assert.deepEqual(third, first)
  assert.notEqual(third, first)
  assert.equal(re.exec('zzz'), null)
  assert.equal(re.test('zzz'), false)
  assert.equal(re.test('za'), true)
  assert.deepEqual(re.exec('xaab'), first)
  assert.ok(first !== null)
  assert.deepEqual(first.groups, [[1, 4], [1, 3], [3, 4], null, null, null, null, null, null, null])
  // a refusal is an Error of its own kind
  let thrown: unknown = null
  try { compile('(') } catch (e) { thrown = e }
  assert.ok(thrown instanceof RegexError)
  assert.ok(thrown instanceof Error)
  assert.equal(thrown.message, 'unmatched ( in pattern')
})

test('refusals: each one by its message', () => {
  const rows: readonly (readonly [pattern: string, message: string])[] = [
    ['(', 'unmatched ( in pattern'],
    ['(a', 'unmatched ( in pattern'],
    ['((a)', 'unmatched ( in pattern'],
    ['a(b|c', 'unmatched ( in pattern'],
    [')', 'unmatched ) in pattern'],
    ['a)', 'unmatched ) in pattern'],
    ['(a))', 'unmatched ) in pattern'],
    ['a|b)', 'unmatched ) in pattern'],
    ['[', 'unmatched [ in pattern'],
    ['[a', 'unmatched [ in pattern'],
    ['[]', 'unmatched [ in pattern'],
    ['[^]', 'unmatched [ in pattern'],
    ['[a-', 'unmatched [ in pattern'],
    ['[a\\', 'unmatched [ in pattern'],
    ['[[:alpha:]', 'unmatched [ in pattern'],
    ['a[b', 'unmatched [ in pattern'],
    ['*', 'nothing to repeat before *'],
    ['+a', 'nothing to repeat before +'],
    ['?', 'nothing to repeat before ?'],
    ['{2}', 'nothing to repeat before {'],
    ['(*a)', 'nothing to repeat before *'],
    ['(+)', 'nothing to repeat before +'],
    ['a|*b', 'nothing to repeat before *'],
    ['a|?', 'nothing to repeat before ?'],
    ['a|{1,2}', 'nothing to repeat before {'],
    ['^*', 'nothing to repeat before *'],
    ['$+', 'nothing to repeat before +'],
    ['^{2}', 'nothing to repeat before {'],
    ['\\b?', 'nothing to repeat before ?'],
    ['\\B{1,2}', 'nothing to repeat before {'],
    ['\\<*', 'nothing to repeat before *'],
    ['\\>+', 'nothing to repeat before +'],
    ['\\1', 'back-references are not supported'],
    ['(a)\\1', 'back-references are not supported'],
    ['(a)(b)\\2', 'back-references are not supported'],
    ['\\9', 'back-references are not supported'],
    ['[\\1]', 'back-references are not supported'],
    ['\\q', 'unknown escape \\q'],
    ['\\0', 'unknown escape \\0'],
    ['\\r', 'unknown escape \\r'],
    ['\\A', 'unknown escape \\A'],
    ['\\x41', 'unknown escape \\x'],
    ['[\\q]', 'unknown escape \\q'],
    ['[\\b]', 'unknown escape \\b'],
    ['a\\', 'pattern ends with a backslash'],
    ['\\', 'pattern ends with a backslash'],
    ['(a\\', 'pattern ends with a backslash'],
    ['a{2,1}', 'repetition counts out of order: {2,1}'],
    ['(ab){10,9}', 'repetition counts out of order: {10,9}'],
    ['[z-a]', 'range out of order: z-a'],
    ['[9-0]', 'range out of order: 9-0'],
    ['[\u00e9-a]', 'range out of order: u+00e9-a'],
    ['[b- ]', 'range out of order: b-u+0020'],
    ['[a-[:digit:]]', 'a class cannot be the end of a range'],
    ['[[:alpha:]-z]', 'a class cannot be the end of a range'],
    ['[\\d-z]', 'a class cannot be the end of a range'],
    ['[a-\\w]', 'a class cannot be the end of a range'],
    ['[[:nope:]]', 'unknown class [:nope:]'],
    ['[[:ALPHA:]]', 'unknown class [:ALPHA:]'],
    ['[a[:word:]]', 'unknown class [:word:]'],
    ['[[=a=]]', '[= =] and [. .] are not supported'],
    ['[[.a.]]', '[= =] and [. .] are not supported'],
    ['[:alpha:]', 'a class goes inside a set: write [[:alpha:]], not [:alpha:]'],
    ['x[:digit:]+', 'a class goes inside a set: write [[:digit:]], not [:digit:]'],
    ['[^:space:]', 'a class goes inside a set: write [^[:space:]], not [^:space:]'],
  ]
  for (const [pattern, message] of rows) {
    assert.equal(refusal(pattern), message, JSON.stringify(pattern))
    assert.equal(refusal(pattern, { ignoreCase: true }), message, JSON.stringify(pattern))
    assert.equal(refusal(pattern, { literal: true }), 'accepted', JSON.stringify(pattern))
    // Lower case, but for a letter quoted from the pattern itself; plain ASCII; no full stop.
    if (pattern === pattern.toLowerCase()) assert.equal(message, message.toLowerCase())
    assert.match(message, /^[\x20-\x7e]+$/)
    assert.doesNotMatch(message, /[.!]$/)
  }
})

test('bounds: the length of a pattern, its nesting, and the size it is laid out at', () => {
  // length: 4096 UTF-16 units and no more, whatever the options
  const long = 'abcdefgh'.repeat(512)
  assert.equal(long.length, 4096)
  assert.equal(spans(compile(long).exec(`x${long}`)), '1,4097')
  assert.equal(spans(compile(long, { ignoreCase: true }).exec(`X${long.toUpperCase()}`)), '1,4097')
  assert.equal(spans(compile(long, { literal: true, ignoreCase: true }).exec(`X${long.toUpperCase()}`)), '1,4097')
  assert.equal(refusal(`${long}a`), 'pattern too long: more than 4096 characters')
  assert.equal(refusal(`${long}a`, { literal: true }), 'pattern too long: more than 4096 characters')
  assert.equal(refusal('('.repeat(5000)), 'pattern too long: more than 4096 characters')
  assert.equal(refusal(GRIN.repeat(2048)), 'accepted')
  assert.equal(refusal(GRIN.repeat(2049)), 'pattern too long: more than 4096 characters')
  // nesting: a hundred groups deep and no deeper
  const nest = (depth: number): string => `${'('.repeat(depth)}a${')'.repeat(depth)}`
  const deep = compile(nest(100))
  assert.equal(deep.groupCount, 100)
  assert.equal(spans(deep.exec('ba')), '1,2 1,2 1,2 1,2 1,2 1,2 1,2 1,2 1,2 1,2')
  assert.equal(refusal(nest(101)), 'pattern nested too deeply')
  assert.equal(refusal(`${'(a|'.repeat(101)}b${')'.repeat(101)}`), 'pattern nested too deeply')
  assert.equal(refusal(`${'('.repeat(101)}`), 'pattern nested too deeply')
  // a hundred groups side by side are not nested at all
  assert.equal(compile('(a)'.repeat(100)).groupCount, 100)
  // each mark after an item's first is one level more
  assert.equal(refusal(`a${'?'.repeat(101)}`), 'accepted')
  assert.equal(refusal(`a${'?'.repeat(102)}`), 'pattern nested too deeply')
  assert.equal(refusal(`${nest(60)}${'?'.repeat(60)}`), 'pattern nested too deeply')
  assert.equal(refusal(`${nest(50)}${'?'.repeat(50)}`), 'accepted')
  // size: counted before anything is laid out, so a count of counts is refused and not expanded
  const large = [
    'a{1000}{1000}', 'a{1000}{1000}{1000}{1000}{1000}', '(a{100}){100}{100}', 'a{20001}', 'a{99999999999999999999}', 'a{1,99999}', 'a{20000}',
    '(a{200}){200}', '((a*)*){20000}', '(a?){5000}', '(ab){5000}', '(a{0}){20000}', `${'(a{10}'.repeat(8)}${'){10}'.repeat(8)}`, 'a{0,20000}', '.{20000,}',
  ]
  for (const pattern of large) assert.equal(refusal(pattern), 'pattern too large', pattern)
  // an item repeated no times is left out, so it costs nothing however often that nothing is repeated
  const small = ['a{19999}', 'a{0,9999}', '(ab){3000}', 'a{100}{100}', 'a{0}{20000}', 'a{20000}{0}', '(a{0}){5000}']
  for (const pattern of small) assert.equal(refusal(pattern), 'accepted', pattern)
  assert.equal(counts(compile('a{19999}')).size, 20000)
  assert.equal(counts(compile('a{100}{100}')).size, 10001)
  assert.equal(spans(compile('a{30}{30}').exec('a'.repeat(901))), '0,900')
  assert.equal(compile('a{30}{30}').exec('a'.repeat(899)), null)
  assert.equal(spans(compile('(ab){300}').exec('ab'.repeat(300))), '0,600 598,600')
})

/** Patterns from a small grammar that this engine and the host's matcher read alike. */
function grammar(rnd: (n: number) => number, letters: readonly string[], sets: readonly string[]): () => string {
  const marks = ['*', '+', '?', '*', '+', '?', '{2}', '{1,2}', '{0,2}', '{2,}', '{0}', '{0,1}', '{2,3}']
  const pick = (from: readonly string[]): string => from[rnd(from.length)]
  const atom = (depth: number): string => {
    const r = rnd(10)
    if (r < 4) return pick(letters)
    if (r === 4) return '.'
    if (r === 5) return pick(sets)
    return depth === 0 ? pick(letters) : `(${alternatives(depth - 1)})`
  }
  const piece = (depth: number): string => (rnd(5) < 2 ? atom(depth) + pick(marks) : atom(depth))
  const sequence = (depth: number): string => {
    let s = ''
    for (let n = rnd(8) === 0 ? 0 : 1 + rnd(3); n > 0; n--) s += piece(depth)
    return s
  }
  const alternatives = (depth: number): string => {
    let s = sequence(depth)
    while (rnd(4) === 0) s += `|${sequence(depth)}`
    return s
  }
  return () => alternatives(2)
}

/**
 * Runs generated patterns over generated texts through this engine and through the host's matcher, and holds the
 * two to the same start, end and groups. The host's `s` flag makes its dot take a line feed, as the dot here does.
 */
function beside(seed: number, patterns: number, letters: readonly string[], sets: readonly string[], alphabet: readonly string[], ignoreCase: boolean): void {
  const rnd = generator(seed)
  const next = grammar(rnd, letters, sets)
  let cases = 0
  let matched = 0
  let captured = 0
  for (let round = 0; round < patterns; round++) {
    const pattern = next()
    const host = new RegExp(pattern, ignoreCase ? 'dgis' : 'dgs')
    const mine = compile(pattern, { ignoreCase })
    for (let k = 0; k < 5; k++) {
      let text = ''
      for (let n = rnd(9); n > 0; n--) text += alphabet[rnd(alphabet.length)]
      const from = rnd(3) === 0 ? rnd(text.length + 1) : 0
      host.lastIndex = from
      const h = host.exec(text)
      let want = 'none'
      if (h !== null) {
        const groups: (readonly [number, number] | null)[] = []
        for (let g = 0; g < 10; g++) {
          const span: readonly [number, number] | undefined = h.indices?.[g]
          groups.push(span === undefined ? null : span)
        }
        want = spans({ start: h.index, end: h.index + h[0].length, groups })
        matched++
        if (want.includes(' ')) captured++
      }
      const label = `${JSON.stringify(pattern)} on ${JSON.stringify(text)} from ${from}`
      assert.equal(spans(mine.exec(text, from)), want, label)
      assert.equal(mine.test(text), new RegExp(pattern, ignoreCase ? 'is' : 's').test(text), `test: ${label}`)
      const { size, steps } = counts(mine)
      assert.ok(steps <= 2 * size * (text.length + 1), `steps: ${label}`)
      cases++
    }
  }
  // The comparison means something only if a fair share of the cases matched, and with groups in play.
  assert.equal(cases, patterns * 5)
  assert.ok(matched > cases / 3, `${matched} of ${cases} matched`)
  assert.ok(captured > cases / 10, `${captured} of ${cases} had a group take part`)
}

test('beside the host matcher: generated patterns give the same start, end and groups', () => {
  const letters = ['a', 'b', 'c']
  const sets = ['[ab]', '[^a]', '[a-c]', '[b-c]', '[^bc]', '[^a-b]', '[abc]']
  const alphabet = ['a', 'b', 'c', 'a', 'b', 'x', '\n']
  beside(1, 300, letters, sets, alphabet, false)
  beside(2026, 300, letters, sets, alphabet, false)
})

test('beside the host matcher: the same when case is ignored', () => {
  const letters = ['a', 'b', 'A', 'B']
  const sets = ['[ab]', '[^a]', '[a-b]', '[A-B]', '[^Ab]', '[aB]', '[^A-B]']
  const alphabet = ['a', 'b', 'A', 'B', 'x']
  beside(7, 300, letters, sets, alphabet, true)
})

test('the shapes that stall a path-at-a-time matcher finish in a few thousand steps', () => {
  const a30 = 'a'.repeat(30)
  const rows: readonly Row[] = [
    ['(a+)+$', `${a30}b`, 'none'],
    ['(a+)+$', a30, '0,30 0,30'],
    ['(a|aa)+$', `${a30}b`, 'none'],
    ['(a|aa)+$', a30, '0,30 29,30'],
    ['(.*)*x', `${a30}b`, 'none'],
    ['(.*)*x', `${a30}x`, '0,31 0,30'],
    ['(a*)*b', a30, 'none'],
    ['(a*)*$', `${a30}b`, '31,31'],
    ['(a|a)*b', a30, 'none'],
    ['((a*)*)*b', a30, 'none'],
    ['(a?a?)*b', a30, 'none'],
    ['(x+x+)+y', 'x'.repeat(30), 'none'],
    ['(a|b|ab)*c', 'ab'.repeat(15), 'none'],
    ['(.*)(.*)(.*)(.*)(.*)z', a30, 'none'],
    ['([a-z]+)*[0-9]', a30, 'none'],
    [`${'a?'.repeat(25)}${'a'.repeat(25)}`, 'a'.repeat(25), '0,25'],
    ['(a?){25}a{25}', 'a'.repeat(25), '0,25 0,0'],
  ]
  for (const [pattern, text, want] of rows) {
    const label = `${JSON.stringify(pattern)} on ${JSON.stringify(text)}`
    const re = compile(pattern)
    // One path at a time would take in the order of 2 to the power 30 steps on most of these: a thousand million.
    // The budget here is five thousand, which on any machine is far below a millisecond, let alone a hundred.
    assert.equal(spans(re.exec(text)), want, label)
    const run = counts(re)
    assert.ok(run.steps > 0, label)
    assert.ok(run.steps <= 2 * run.size * (text.length + 1), `${label}: ${run.steps} steps for ${run.size} instructions`)
    assert.ok(run.steps <= 5000, `${label}: ${run.steps} steps`)
    assert.equal(re.test(text), want !== 'none', label)
    assert.ok(counts(re).steps <= run.steps, `test: ${label}`)
  }
  // The same holds when the counts make the pattern itself large: its size times the length of the text, no more.
  const counted = compile('(a{0,25}){0,25}b')
  assert.equal(counted.exec(a30), null)
  assert.ok(counts(counted).steps <= 2 * counts(counted).size * 31)
  assert.ok(counts(counted).steps <= 25000, `${counts(counted).steps} steps`)
})

test('the steps grow in step with the text, never faster', () => {
  for (const pattern of ['(a+)+$', '(a|aa)+$', '(.*)*x', '(a*)*c', '((a|b)*c)*d', '\\<(a+)+\\>x']) {
    const re = compile(pattern)
    const steps: number[] = []
    for (const n of [1000, 2000, 4000]) {
      assert.equal(re.exec(`${'a'.repeat(n)}b`), null, pattern)
      const run = counts(re)
      assert.ok(run.steps <= 2 * run.size * (n + 2), pattern)
      steps.push(run.steps)
    }
    assert.ok(steps[1] <= 2 * steps[0] + 100, `${pattern}: ${steps.join(' ')}`)
    assert.ok(steps[2] <= 2 * steps[1] + 100, `${pattern}: ${steps.join(' ')}`)
  }
  // a pattern of ten thousand instructions, on a text that keeps a great many paths alive at once
  const wide = compile('(a?){2000}')
  assert.equal(counts(wide).size, 10000)
  assert.equal(spans(wide.exec('a'.repeat(200))), '0,200 200,200')
  assert.ok(counts(wide).steps <= 2 * counts(wide).size * 201)
})

test('wild patterns: only a RegexError ever comes out, and every match keeps its promises', () => {
  const rnd = generator(12345)
  const bits = [
    'a', 'b', 'a', 'b', 'A', '(', ')', '(', ')', '[', ']', '{', '}', '|', '*', '+', '?', '^', '$', '.', '\\', '-', ':', ',', '=', '0', '1', '2', '9',
    'w', 'd', 's', 'W', 'D', 'S', '<', '>', 't', 'n', ' ', '[:alpha:]', '[:digit:]', '[[:space:]]', '[^', '{2}', '{1,2}', '{0}', '{2,}', '{1000}',
    '\\b', '\\<', '\\>', '\\w', '\\(', '\\1', '\u00e9', GRIN, '\ud83d', '\ude00', '(a|', ')*', ')+', ')?',
  ]
  const alphabet = ['a', 'b', 'A', ' ', '1', '-', '\u00e9', GRIN, '\ud83d', '\ude00', '\n', '_', 'a', 'b']
  // Whether `i` falls between the two halves of a surrogate pair of `text`.
  const half = (text: string, i: number, which: number): boolean => i >= 0 && i < text.length && (text.charCodeAt(i) & 0xfc00) === which
  const inside = (text: string, i: number): boolean => half(text, i - 1, 0xd800) && half(text, i, 0xdc00)
  let compiled = 0
  let refused = 0
  let matches = 0
  for (let round = 0; round < 6000; round++) {
    let pattern = ''
    for (let n = rnd(12); n > 0; n--) pattern += bits[rnd(bits.length)]
    const options: RegexOptions = { ignoreCase: rnd(3) === 0, literal: rnd(8) === 0 }
    let re: Regex
    try {
      re = compile(pattern, options)
    } catch (e) {
      assert.ok(e instanceof RegexError, `${JSON.stringify(pattern)}: ${String(e)}`)
      assert.match(e.message, /^[\x20-\x7e]+$/)
      refused++
      continue
    }
    compiled++
    assert.equal(re.source, pattern)
    for (let k = 0; k < 3; k++) {
      let text = ''
      for (let n = rnd(12); n > 0; n--) text += alphabet[rnd(alphabet.length)]
      const label = `${JSON.stringify(pattern)} on ${JSON.stringify(text)}`
      const m = re.exec(text)
      const run = counts(re)
      assert.ok(run.steps <= 2 * run.size * (text.length + 1), `steps: ${label}`)
      assert.equal(re.test(text), m !== null, `test: ${label}`)
      if (m === null) {
        // no match from the start means no match from anywhere
        for (let from = 0; from <= text.length + 1; from++) assert.equal(re.exec(text, from), null, `${label} from ${from}`)
        continue
      }
      matches++
      assert.ok(m.start >= 0 && m.start <= m.end && m.end <= text.length, label)
      assert.ok(!inside(text, m.start) && !inside(text, m.end), `${label}: a pair cut in two`)
      assert.equal(m.groups.length, 10, label)
      assert.deepEqual(m.groups[0], [m.start, m.end], label)
      for (let g = 1; g < 10; g++) {
        const span = m.groups[g]
        if (span === null) continue
        assert.ok(g <= re.groupCount, `${label}: group ${g} of ${re.groupCount}`)
        assert.ok(m.start <= span[0] && span[0] <= span[1] && span[1] <= m.end, `${label}: group ${g}`)
        assert.ok(!inside(text, span[0]) && !inside(text, span[1]), `${label}: group ${g} cuts a pair in two`)
      }
      // from any place up to where the match starts, the same match is found; from past it, a later one or none
      for (let from = 0; from <= m.start; from++) assert.deepEqual(re.exec(text, from), m, `${label} from ${from}`)
      const later = re.exec(text, m.start + 1)
      assert.ok(later === null || later.start > m.start, `${label}: from ${m.start + 1}`)
    }
  }
  assert.ok(compiled > 1500, `${compiled} compiled`)
  assert.ok(refused > 1500, `${refused} refused`)
  assert.ok(matches > 1500, `${matches} matches`)
})

test('the engine is its own: its source imports nothing and never names the host matcher', () => {
  const source = readFileSync(new URL('./regex.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /^\s*import\b/m)
  assert.doesNotMatch(source, /\bfrom\s+'/)
  assert.doesNotMatch(source, /\bRegExp\b/)
  // the string methods that would take a pattern are not called either
  assert.doesNotMatch(source, /\.(match|matchAll|replace|replaceAll|search|split)\s*\(/)
  // and no pattern is written between slashes: a slash in the code is only ever part of a comment marker
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(code, /\//, 'a slash in the code of the engine: no pattern may be written between slashes there')
})
