// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It tests the programs that compare files (diff.ts) the way a person meets them: typed at
 * the real shell of a system held in memory, with what they print, the bytes they leave in a file and the status
 * they end with all checked. diff is tested hardest: empty files, files that are the same, one line changed, changes
 * at both ends, only additions, only deletions, last lines without a line end, every option, files too long to
 * take, inputs near and past the point where the search gives up (which must still end quickly), and a few hundred
 * small pairs made by a generator of its own, whose output is applied back by hand here to rebuild the second file
 * exactly and is checked against the fewest changes possible.
 * What breaks if it is removed? A change to the search could make diff print changes that do not rebuild the second
 * file, more changes than needed, or run without end on large files, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DIFF_MANUAL, DIFF_PROGRAMS } from './diff.ts'
import { boot } from './kit.test.ts'
import type { Kit } from './kit.test.ts'

/** A system with the comparing programs, its shell working in /tmp, with room for large files there. */
function fresh(): Kit {
  const k = boot(DIFF_PROGRAMS, { tmpBytes: 32 << 20 })
  assert.deepEqual(k.sh('cd /tmp'), [])
  return k
}

/** What a command printed, without the shell's own remark about a program of a pipeline ended by a closed pipe. */
const own = (lines: readonly string[]): string[] => lines.filter((l) => !/^![^ :]+: [^ :]+: broken pipe$/.test(l))

/** The names of the tasks that are running: only the first task and the shell once a command has ended. */
const tasks = (k: Kit): string[] => k.system.kernel.ps().map((p) => p.name)
const AT_REST = ['init', '-sh']

/** `n` lines made by `f`, each with its line end. */
function lines(n: number, f: (i: number) => string): string {
  const parts: string[] = []
  for (let i = 0; i < n; i++) parts.push(`${f(i)}\n`)
  return parts.join('')
}

const USAGE = '!usage: diff [-u] [-U N] [-q] [-i] [-b] [-w] file1 file2'
const NO_END = '\\ No newline at end of file'

/** A small linear congruential generator: the same numbers on every run, and none of the host's randomness. */
class Lcg {
  private x: number
  constructor(seed: number) {
    this.x = seed >>> 0
  }
  /** A whole number from 0 to n - 1. */
  below(n: number): number {
    this.x = (Math.imul(this.x, 1664525) + 1013904223) >>> 0
    return Math.floor((this.x / 4294967296) * n)
  }
}

/** A text's lines, each with its line end when it has one. */
function pieces(text: string): string[] {
  const out = text.split(/(?<=\n)/)
  return out.length === 1 && out[0] === '' ? [] : out
}

/**
 * Applies diff's unified output to the first file by hand, the way a person would: the lines a hunk keeps or removes
 * must be the first file's lines where its head says, the lines it adds go in, and a "\ No newline" line takes the
 * line end off the line before it. Gives the second file's text.
 */
function applyUnified(first: string, script: string): string {
  const old = pieces(first)
  const rows = pieces(script).map((r) => r.replace(/\n$/, ''))
  assert.ok(rows[0].startsWith('--- ') && rows[1].startsWith('+++ '), 'the two name lines')
  const out: string[] = []
  let at = 0
  let i = 2
  while (i < rows.length) {
    const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(rows[i++])
    assert.ok(head !== null, `a hunk head, not ${rows[i - 1]}`)
    const [aStart, aCount, bStart, bCount] = [Number(head[1]), Number(head[2] ?? 1), Number(head[3]), Number(head[4] ?? 1)]
    const from = aCount === 0 ? aStart : aStart - 1
    assert.ok(from >= at, 'hunks in order')
    while (at < from) out.push(old[at++])
    assert.equal(out.length, bCount === 0 ? bStart : bStart - 1, 'the hunk starts where its head says in the second file')
    let seenA = 0
    let seenB = 0
    let tag = ''
    for (; i < rows.length && !rows[i].startsWith('@@'); i++) {
      const row = rows[i]
      if (row[0] === '\\') {
        assert.equal(row, NO_END)
        if (tag !== '-') out[out.length - 1] = out[out.length - 1].replace(/\n$/, '')
        if (tag !== '+') assert.ok(!old[at - 1].endsWith('\n'), 'the first file has no line end there')
        continue
      }
      tag = row[0]
      if (tag === ' ' || tag === '-') {
        assert.equal(old[at]?.replace(/\n$/, ''), row.slice(1), `line ${at + 1} of the first file`)
        at++
        seenA++
      }
      if (tag === ' ' || tag === '+') { out.push(`${row.slice(1)}\n`); seenB++ }
    }
    assert.deepEqual([seenA, seenB], [aCount, bCount], 'the hunk spans what its head says')
  }
  while (at < old.length) out.push(old[at++])
  return out.join('')
}

/** Applies diff's classic output (3c3, 5a6,7, 8,9d7 with < and > lines) to the first file by hand. */
function applyClassic(first: string, script: string): string {
  const old = pieces(first)
  const rows = pieces(script).map((r) => r.replace(/\n$/, ''))
  const out: string[] = []
  let at = 0
  let i = 0
  while (i < rows.length) {
    const head = /^(\d+)(?:,(\d+))?([acd])(\d+)(?:,(\d+))?$/.exec(rows[i++])
    assert.ok(head !== null, `a change line, not ${rows[i - 1]}`)
    const a0 = Number(head[1])
    const a1 = Number(head[2] ?? head[1])
    const kind = head[3]
    const keep = kind === 'a' ? a0 : a0 - 1
    while (at < keep) out.push(old[at++])
    for (; i < rows.length && rows[i].startsWith('< '); i++) {
      assert.equal(old[at]?.replace(/\n$/, ''), rows[i].slice(2))
      at++
      if (rows[i + 1] === NO_END) { assert.ok(!old[at - 1].endsWith('\n')); i++ }
    }
    if (kind !== 'a') assert.equal(at, a1, 'the removed lines are the ones named')
    if (rows[i] === '---') i++
    for (; i < rows.length && rows[i].startsWith('> '); i++) {
      out.push(`${rows[i].slice(2)}\n`)
      if (rows[i + 1] === NO_END) { out[out.length - 1] = rows[i].slice(2); i++ }
    }
  }
  while (at < old.length) out.push(old[at++])
  return out.join('')
}

/** The fewest lines removed and added to turn one text into the other, by the plain table of longest common runs. */
function fewest(one: string, two: string): number {
  const a = pieces(one)
  const b = pieces(two)
  let row = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    const next = new Array<number>(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j++) next[j] = a[i - 1] === b[j - 1] ? row[j - 1] + 1 : Math.max(row[j], next[j - 1])
    row = next
  }
  return a.length + b.length - 2 * row[b.length]
}

/** How many lines of unified output remove or add a line. */
const edits = (script: string): number => pieces(script).filter((r) => /^[-+]/.test(r) && !/^(---|\+\+\+) /.test(r)).length

test('diff: files that are the same, and empty files, print nothing and end with 0', () => {
  const k = fresh()
  k.write('/tmp/e1', '')
  k.write('/tmp/e2', '')
  k.write('/tmp/a', 'one\ntwo\n')
  k.write('/tmp/a2', 'one\ntwo\n')
  assert.deepEqual(k.sh('diff e1 e2; echo $?'), ['0'])
  assert.deepEqual(k.sh('diff a a2; echo $?'), ['0'])
  assert.deepEqual(k.sh('diff -u a a2; echo $?'), ['0'])
  assert.deepEqual(k.sh('diff -q a a; echo $?'), ['0'])
  assert.deepEqual(k.sh('diff e1 a; echo $?'), ['0a1,2', '> one', '> two', '1'])
  assert.deepEqual(k.sh('diff a e1'), ['1,2d0', '< one', '< two'])
  assert.deepEqual(k.sh('diff -u e1 a'), ['--- e1', '+++ a', '@@ -0,0 +1,2 @@', '+one', '+two'])
  assert.deepEqual(k.sh('diff -u a e1'), ['--- a', '+++ e1', '@@ -1,2 +0,0 @@', '-one', '-two'])
})

test('diff: one line changed, in the classic and the unified form', () => {
  const k = fresh()
  k.write('/tmp/a', 'one\ntwo\nthree\n')
  k.write('/tmp/b', 'one\nTWO\nthree\n')
  assert.deepEqual(k.sh('diff a b; echo $?'), ['2c2', '< two', '---', '> TWO', '1'])
  assert.deepEqual(k.sh('diff -u a b; echo $?'), ['--- a', '+++ b', '@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three', '1'])
  assert.deepEqual(k.sh('diff -U 0 a b'), ['--- a', '+++ b', '@@ -2 +2 @@', '-two', '+TWO'])
  assert.deepEqual(k.sh('diff -U0 a b'), ['--- a', '+++ b', '@@ -2 +2 @@', '-two', '+TWO'])
  assert.deepEqual(k.sh('diff -q a b; echo $?'), ['Files a and b differ', '1'])
  // Several lines changed into a different number of lines.
  k.write('/tmp/c', 'one\nsix\nseven\neight\nthree\n')
  assert.deepEqual(k.sh('diff a c'), ['2c2,4', '< two', '---', '> six', '> seven', '> eight'])
  assert.deepEqual(k.sh('diff c a'), ['2,4c2', '< six', '< seven', '< eight', '---', '> two'])
})

test('diff: changes at both ends, as two hunks or one depending on the context', () => {
  const k = fresh()
  k.write('/tmp/a', lines(10, (i) => `l${i + 1}`))
  k.write('/tmp/b', lines(10, (i) => (i === 0 ? 'first' : i === 9 ? 'last' : `l${i + 1}`)))
  assert.deepEqual(k.sh('diff a b'), ['1c1', '< l1', '---', '> first', '10c10', '< l10', '---', '> last'])
  assert.deepEqual(k.sh('diff -u a b'), [
    '--- a', '+++ b',
    '@@ -1,4 +1,4 @@', '-l1', '+first', ' l2', ' l3', ' l4',
    '@@ -7,4 +7,4 @@', ' l7', ' l8', ' l9', '-l10', '+last',
  ])
  // Eight kept lines between two changes: two hunks with 3 lines of context, one with 4.
  const one = k.sh('diff -U 4 a b')
  assert.equal(one.filter((l) => l.startsWith('@@')).length, 1)
  assert.deepEqual(one.slice(0, 5), ['--- a', '+++ b', '@@ -1,10 +1,10 @@', '-l1', '+first'])
  assert.deepEqual(one.slice(-2), ['-l10', '+last'])
  assert.deepEqual(k.sh('diff -U 1 a b'), ['--- a', '+++ b', '@@ -1,2 +1,2 @@', '-l1', '+first', ' l2', '@@ -9,2 +9,2 @@', ' l9', '-l10', '+last'])
})

test('diff: only additions and only deletions', () => {
  const k = fresh()
  k.write('/tmp/a', 'a\nb\n')
  k.write('/tmp/b', 'a\nx\ny\nb\n')
  k.write('/tmp/c', 'a\nb\nz\n')
  k.write('/tmp/d', 'top\na\nb\n')
  assert.deepEqual(k.sh('diff a b'), ['1a2,3', '> x', '> y'])
  assert.deepEqual(k.sh('diff b a'), ['2,3d1', '< x', '< y'])
  assert.deepEqual(k.sh('diff a c'), ['2a3', '> z'])
  assert.deepEqual(k.sh('diff c a'), ['3d2', '< z'])
  assert.deepEqual(k.sh('diff a d'), ['0a1', '> top'])
  assert.deepEqual(k.sh('diff d a'), ['1d0', '< top'])
  assert.deepEqual(k.sh('diff -U 1 a b'), ['--- a', '+++ b', '@@ -1,2 +1,4 @@', ' a', '+x', '+y', ' b'])
  assert.deepEqual(k.sh('diff -U 0 b a'), ['--- b', '+++ a', '@@ -2,2 +1,0 @@', '-x', '-y'])
  assert.deepEqual(k.sh('diff -U 0 a d'), ['--- a', '+++ d', '@@ -0,0 +1 @@', '+top'])
})

test('diff: a last line without a line end is marked, and differs from the same line with one', () => {
  const k = fresh()
  k.write('/tmp/open', 'a\nb')
  k.write('/tmp/shut', 'a\nb\n')
  k.write('/tmp/open2', 'a\nb')
  k.write('/tmp/other', 'a\nc')
  assert.deepEqual(k.sh('diff open open2; echo $?'), ['0'])
  assert.deepEqual(k.sh('diff open shut; echo $?'), ['2c2', '< b', NO_END, '---', '> b', '1'])
  assert.deepEqual(k.sh('diff shut open'), ['2c2', '< b', '---', '> b', NO_END])
  assert.deepEqual(k.sh('diff -u open shut'), ['--- open', '+++ shut', '@@ -1,2 +1,2 @@', ' a', '-b', NO_END, '+b'])
  assert.deepEqual(k.sh('diff -u shut open'), ['--- shut', '+++ open', '@@ -1,2 +1,2 @@', ' a', '-b', '+b', NO_END])
  assert.deepEqual(k.sh('diff open other'), ['2c2', '< b', NO_END, '---', '> c', NO_END])
  // The kept last line has no end in either file: the mark follows it once.
  k.write('/tmp/x', 'x\nend')
  k.write('/tmp/y', 'y\nend')
  assert.deepEqual(k.sh('diff -u x y'), ['--- x', '+++ y', '@@ -1,2 +1,2 @@', '-x', '+y', ' end', NO_END])
  assert.deepEqual(k.sh('diff x y'), ['1c1', '< x', '---', '> y'])
  // A single line without an end against an empty file.
  k.write('/tmp/e', '')
  k.write('/tmp/one', 'z')
  assert.deepEqual(k.sh('diff e one'), ['0a1', '> z', NO_END])
  assert.deepEqual(k.sh('diff -u one e'), ['--- one', '+++ e', '@@ -1 +0,0 @@', '-z', NO_END])
  // The exact bytes, through a file.
  k.sh('diff open shut > out')
  assert.equal(k.read('/tmp/out'), `2c2\n< b\n${NO_END}\n---\n> b\n`)
})

test('diff: -i, -b and -w say which differences do not count', () => {
  const k = fresh()
  k.write('/tmp/a', 'Hello World\n')
  k.write('/tmp/b', 'hello world\n')
  assert.deepEqual(k.sh('diff a b; echo $?'), ['1c1', '< Hello World', '---', '> hello world', '1'])
  assert.deepEqual(k.sh('diff -i a b; echo $?'), ['0'])
  assert.deepEqual(k.sh('diff -iq a b; echo $?'), ['0'])
  k.write('/tmp/s1', 'a  b \nx\n')
  k.write('/tmp/s2', 'a b\nx\n')
  k.write('/tmp/s3', 'ab\nx\n')
  k.write('/tmp/s4', '  a\tb\nx\n')
  k.write('/tmp/s5', ' a b\nx\n')
  assert.deepEqual(k.sh('diff s1 s2; echo $?'), ['1c1', '< a  b ', '---', '> a b', '1'])
  assert.deepEqual(k.sh('diff -b s1 s2; echo $?'), ['0'])
  assert.deepEqual(k.sh('diff -b s2 s3; echo $?'), ['1c1', '< a b', '---', '> ab', '1'])
  assert.deepEqual(k.sh('diff -w s2 s3; echo $?'), ['0'])
  assert.deepEqual(k.sh('diff -b s4 s5; echo $?'), ['0'])
  assert.deepEqual(k.sh('diff -b s4 s2; echo $?').at(-1), '1')
  assert.deepEqual(k.sh('diff -w s4 s3; echo $?'), ['0'])
  // A carriage return before the line end is white space too.
  k.write('/tmp/crlf', 'a\r\nb\r\n')
  k.write('/tmp/lf', 'a\nb\n')
  assert.deepEqual(k.sh('diff -q crlf lf; echo $?'), ['Files crlf and lf differ', '1'])
  assert.deepEqual(k.sh('diff -b crlf lf; echo $?'), ['0'])
  k.sh('diff crlf lf > out')
  assert.equal(k.read('/tmp/out'), '1,2c1,2\n< a\r\n< b\r\n---\n> a\n> b\n')
  // Options together; the lines printed are the files' own.
  k.write('/tmp/m1', 'KEEP\nOld  Line\n')
  k.write('/tmp/m2', 'keep\nnew line\n')
  assert.deepEqual(k.sh('diff -ib m1 m2'), ['2c2', '< Old  Line', '---', '> new line'])
  assert.deepEqual(k.sh('diff -i -u m1 m2'), ['--- m1', '+++ m2', '@@ -1,2 +1,2 @@', ' KEEP', '-Old  Line', '+new line'])
})

test('diff: - is the input, and the input named twice is the same text', () => {
  const k = fresh()
  k.write('/tmp/a', 'one\ntwo\n')
  assert.deepEqual(k.sh('echo one | diff - a; echo $?'), ['1a2', '> two', '1'])
  assert.deepEqual(k.sh('echo one | diff -u a -'), ['--- a', '+++ -', '@@ -1,2 +1 @@', ' one', '-two'])
  assert.deepEqual(k.sh('echo hi | diff - -; echo $?'), ['0'])
  assert.deepEqual(k.sh('diff - a < a; echo $?'), ['0'])
})

test('diff: wrong commands, missing files and directories are refused with status 2', () => {
  const k = fresh()
  k.write('/tmp/a', 'a\n')
  assert.deepEqual(k.sh('diff; echo $?'), ['!diff: two files are needed', USAGE, '2'])
  assert.deepEqual(k.sh('diff a; echo $?'), ['!diff: a second file is needed', USAGE, '2'])
  assert.deepEqual(k.sh('diff a a a; echo $?'), ["!diff: one file too many: 'a'", USAGE, '2'])
  assert.deepEqual(k.sh('diff -c a a; echo $?'), ["!diff: unknown option '-c'", USAGE, '2'])
  assert.deepEqual(k.sh('diff -U x a a; echo $?'), ["!diff: option '-U' needs a whole number, not 'x'", USAGE, '2'])
  assert.deepEqual(k.sh('diff -U -1 a a; echo $?'), ["!diff: option '-U' needs a whole number, not '-1'", USAGE, '2'])
  assert.deepEqual(k.sh('diff -U; echo $?'), ["!diff: option '-U' needs a value", USAGE, '2'])
  // Options come before the files: after the first file, -U is a file's name.
  assert.deepEqual(k.sh('diff a -U; echo $?'), ['!diff: -U: no such file or directory', '2'])
  assert.deepEqual(k.sh('diff -r a a; echo $?'), ['!diff: there is no recursive mode (-r): name two files', USAGE, '2'])
  assert.deepEqual(k.sh('diff /nosuch a; echo $?'), ['!diff: /nosuch: no such file or directory', '2'])
  assert.deepEqual(k.sh('diff /nosuch /gone; echo $?'), ['!diff: /nosuch: no such file or directory', '!diff: /gone: no such file or directory', '2'])
  assert.deepEqual(k.sh('diff /tmp a; echo $?'), ['!diff: /tmp: is a directory (diff compares two files; it has no recursive mode)', '2'])
  assert.deepEqual(k.sh('diff a /home; echo $?'), ['!diff: /home: is a directory (diff compares two files; it has no recursive mode)', '2'])
  // An output that takes nothing is reported once.
  k.write('/tmp/b', 'b\n')
  assert.deepEqual(k.sh('diff a b > /dev/full; echo $?'), ['!diff: write error: no space left on device', '2'])
  assert.deepEqual(tasks(k), AT_REST)
})

test('diff: a file with a zero byte or bytes that are not UTF-8 is compared byte for byte', () => {
  const k = fresh()
  k.write('/tmp/b1', Uint8Array.of(97, 0, 98, 10))
  k.write('/tmp/b2', Uint8Array.of(97, 0, 99, 10))
  k.write('/tmp/b3', Uint8Array.of(97, 0, 98, 10))
  k.write('/tmp/bad', Uint8Array.of(97, 0xff, 10))
  k.write('/tmp/t', 'a\n')
  assert.deepEqual(k.sh('diff b1 b2; echo $?'), ['Files b1 and b2 differ', '1'])
  assert.deepEqual(k.sh('diff -u b1 b3; echo $?'), ['0'])
  assert.deepEqual(k.sh('diff t bad; echo $?'), ['Files t and bad differ', '1'])
  assert.deepEqual(k.sh('diff -q bad bad; echo $?'), ['0'])
  // Well-formed UTF-8 of every length is text; a sequence too long, a half of a surrogate pair or a cut-off end is not.
  k.write('/tmp/u1', 'caf\u00e9 \u20ac1\n\u{1f600}\n')
  k.write('/tmp/u2', 'caf\u00e9 \u20ac2\n\u{1f600}\n')
  assert.deepEqual(k.sh('diff u1 u2'), ['1c1', '< caf\u00e9 \u20ac1', '---', '> caf\u00e9 \u20ac2'])
  for (const [i, bytes] of [[0xc0, 0x80], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82], [0x80]].entries()) {
    k.write(`/tmp/x${i}`, Uint8Array.of(97, 10, ...bytes, 10))
    assert.deepEqual(k.sh(`diff t x${i}; echo $?`), [`Files t and x${i} differ`, '1'], `bytes ${bytes.join(' ')}`)
  }
  // A byte order mark at the start is part of the text, and a difference.
  k.write('/tmp/bom', Uint8Array.of(0xef, 0xbb, 0xbf, 97, 10))
  assert.deepEqual(k.sh('diff t bom > out; echo $?'), ['1'])
  assert.equal(k.read('/tmp/out'), '1c1\n< a\n---\n> \ufeffa\n')
  // A line of text longer than one read, changed at its very end.
  const long = 'x'.repeat(300000)
  k.write('/tmp/l1', `head\n${long}a\n`)
  k.write('/tmp/l2', `head\n${long}b\n`)
  assert.deepEqual(k.sh('diff l1 l2 > out; echo $?'), ['1'])
  assert.equal(k.read('/tmp/out'), `2c2\n< ${long}a\n---\n> ${long}b\n`)
})

test('diff: a file of more than 100000 lines is refused; one of exactly 100000 is compared', () => {
  const k = fresh()
  const full = lines(100000, (i) => `${i}`)
  k.write('/tmp/full', full)
  k.write('/tmp/over', `${full}x\n`)
  k.write('/tmp/overopen', `${full}x`)
  k.write('/tmp/edit', full.replace('\n50000\n', '\nfifty thousand\n'))
  assert.deepEqual(k.sh('diff full edit; echo $?'), ['50001c50001', '< 50000', '---', '> fifty thousand', '1'])
  assert.deepEqual(k.sh('diff full over; echo $?'), ['!diff: over: more than 100000 lines, too many to compare', '2'])
  assert.deepEqual(k.sh('diff overopen full; echo $?'), ['!diff: overopen: more than 100000 lines, too many to compare', '2'])
  assert.deepEqual(k.sh('diff -q over overopen; echo $?'), [
    '!diff: over: more than 100000 lines, too many to compare', '!diff: overopen: more than 100000 lines, too many to compare', '2',
  ])
})

test('diff: large files near the limit end quickly and correctly', { timeout: 20000 }, () => {
  const k = fresh()
  // 100000 lines with 19000 of them replaced, every fifth: each a change of its own.
  k.write('/tmp/a', lines(100000, (i) => `line ${i}`))
  k.write('/tmp/b', lines(100000, (i) => (i % 5 === 2 && i < 95000 ? `new ${i}` : `line ${i}`)))
  assert.deepEqual(k.sh('diff a b > out; echo $?'), ['1'])
  const out = k.read('/tmp/out').split('\n')
  assert.equal(out.filter((l) => /^\d+c\d+$/.test(l)).length, 19000)
  assert.deepEqual(out.slice(0, 4), ['3c3', '< line 2', '---', '> new 2'])
  // Lines that both files hold, moved: 2000 pairs swapped, 4000 lines removed and 4000 added, no more.
  k.write('/tmp/c', lines(100000, (i) => `line ${i % 50 < 2 ? i ^ 1 : i}`))
  assert.deepEqual(k.sh('diff -u a c > moved; echo $?'), ['1'])
  const moved = k.read('/tmp/moved')
  assert.equal(edits(moved), 4000)
  assert.equal(applyUnified(k.read('/tmp/a'), moved), k.read('/tmp/c'))
  assert.deepEqual(k.sh('diff -q a c; echo $?'), ['Files a and c differ', '1'])
})

test('diff: past the limit of the search, the middle is one change, and it still ends quickly', { timeout: 20000 }, () => {
  const k = fresh()
  // Every line of each file is also in the other, but in an order that needs more than 20000 lines changed.
  k.write('/tmp/a', `same start\n${lines(20200, (i) => `v${i % 300}`)}same end\n`)
  k.write('/tmp/b', `same start\n${lines(300, (i) => `v${299 - i}`)}same end\n`)
  assert.deepEqual(k.sh('diff a b > out; echo $?'), ['1'])
  const out = k.read('/tmp/out').split('\n')
  assert.equal(out[0], '2,20201c2,301')
  assert.equal(out.length, 20200 + 300 + 3)
  assert.equal(applyClassic(k.read('/tmp/a'), k.read('/tmp/out')), k.read('/tmp/b'))
  // The lengths alone tell that more than 20000 lines must change: given up at once.
  k.write('/tmp/c', lines(25000, (i) => `v${i % 100}`))
  k.write('/tmp/d', lines(100, (i) => `v${99 - i}`))
  assert.deepEqual(k.sh('diff -U 1 c d > out; echo $?'), ['1'])
  const u = k.read('/tmp/out').split('\n')
  assert.deepEqual(u.slice(0, 3), ['--- c', '+++ d', '@@ -1,25000 +1,100 @@'])
  assert.equal(applyUnified(k.read('/tmp/c'), k.read('/tmp/out')), k.read('/tmp/d'))
  // A reader that leaves after the first line ends a long answer at once.
  assert.deepEqual(own(k.sh('diff c d | cmp -s - d; echo $?')), ['1'])
  assert.deepEqual(tasks(k), AT_REST)
})

test('diff: four hundred made-up pairs: the output rebuilds the second file, with the fewest changes', { timeout: 20000 }, () => {
  const k = fresh()
  const rng = new Lcg(20261115)
  const words = ['a', 'b', 'c', 'd', 'a', 'b', '', 'e f']
  const pairs: [string, string][] = []
  const make = (n: number): string[] => Array.from({ length: n }, () => words[rng.below(words.length)])
  const end = (rows: string[]): string => (rows.length === 0 ? '' : rows.join('\n') + (rng.below(4) === 0 ? '' : '\n'))
  // Three hundred small pairs, then a hundred longer ones that split into boxes several times over.
  for (let p = 0; p < 400; p++) {
    const most = p < 300 ? 16 : 90
    const one = make(rng.below(most))
    let two: string[]
    if (rng.below(5) === 0) two = make(rng.below(most))
    else {
      two = one.slice()
      for (let e = rng.below(most < 20 ? 5 : 20); e > 0; e--) {
        const at = rng.below(two.length + 1)
        const kind = rng.below(3)
        if (kind === 0) two.splice(at, 0, ...make(1 + rng.below(3)))
        else if (kind === 1) two.splice(at, 1 + rng.below(3))
        else two.splice(at, 1, ...make(1 + rng.below(2)))
      }
    }
    pairs.push([end(one), end(two)])
  }
  pairs.forEach(([one, two], p) => {
    k.write(`/tmp/a${p}`, one)
    k.write(`/tmp/b${p}`, two)
  })
  const numbers = pairs.map((_, p) => p).join(' ')
  const statuses = k.sh(`for p in ${numbers}; do diff -u a$p b$p > u$p; echo $?; diff -U 0 a$p b$p > z$p; diff -U 1 a$p b$p > o$p; diff a$p b$p > c$p; done`)
  assert.equal(statuses.length, pairs.length)
  pairs.forEach(([one, two], p) => {
    const what = `pair ${p}: ${JSON.stringify(one)} -> ${JSON.stringify(two)}`
    assert.equal(statuses[p], one === two ? '0' : '1', what)
    for (const name of ['u', 'z', 'o']) assert.equal(applyUnified(one, k.read(`/tmp/${name}${p}`) || '--- a\n+++ b\n'), two, `${what} (${name})`)
    assert.equal(applyClassic(one, k.read(`/tmp/c${p}`)), two, `${what} (classic)`)
    assert.equal(edits(k.read(`/tmp/z${p}`)), fewest(one, two), `${what}: the fewest changes`)
  })
})

test('cmp: the first byte that differs, every byte with -l, nothing with -s', () => {
  const k = fresh()
  k.write('/tmp/a', 'abc\ndef\n')
  k.write('/tmp/b', 'abc\ndXf\n')
  k.write('/tmp/a2', 'abc\ndef\n')
  assert.deepEqual(k.sh('cmp a a2; echo $?'), ['0'])
  assert.deepEqual(k.sh('cmp a b; echo $?'), ['a b differ: byte 6, line 2', '1'])
  assert.deepEqual(k.sh('cmp -s a b; echo $?'), ['1'])
  assert.deepEqual(k.sh('cmp -s a a2; echo $?'), ['0'])
  k.write('/tmp/c', 'abcd')
  k.write('/tmp/d', 'aXcY')
  assert.deepEqual(k.sh('cmp -l c d; echo $?'), ['2 142 130', '4 144 131', '1'])
  assert.deepEqual(k.sh('cmp -l c c; echo $?'), ['0'])
  // Bytes that are no text.
  k.write('/tmp/n1', Uint8Array.of(0, 255, 10, 7))
  k.write('/tmp/n2', Uint8Array.of(0, 254, 10, 8))
  assert.deepEqual(k.sh('cmp n1 n2'), ['n1 n2 differ: byte 2, line 1'])
  assert.deepEqual(k.sh('cmp -l n1 n2'), ['2 377 376', '4 7 10'])
})

test('cmp: one file the start of the other ends with EOF on the shorter', () => {
  const k = fresh()
  k.write('/tmp/short', 'abc')
  k.write('/tmp/long', 'abcdef')
  k.write('/tmp/odd', 'abXdefgh')
  k.write('/tmp/e', '')
  assert.deepEqual(k.sh('cmp short long; echo $?'), ['!cmp: EOF on short', '1'])
  assert.deepEqual(k.sh('cmp long short; echo $?'), ['!cmp: EOF on short', '1'])
  assert.deepEqual(k.sh('cmp -s long short; echo $?'), ['1'])
  assert.deepEqual(k.sh('cmp -l long odd; echo $?'), ['3 143 130', '!cmp: EOF on long', '1'])
  assert.deepEqual(k.sh('cmp e e; echo $?'), ['0'])
  assert.deepEqual(k.sh('cmp e short; echo $?'), ['!cmp: EOF on e', '1'])
})

test('cmp: large files are read in pieces, from files and pipes alike', () => {
  const k = fresh()
  const size = 200000
  const one = new Uint8Array(size)
  let x = 7
  for (let i = 0; i < size; i++) {
    x = (Math.imul(x, 69069) + 12345) >>> 0
    one[i] = x >>> 24
  }
  const two = one.slice()
  two[150000] ^= 1
  let line = 1
  for (let i = 0; i < 150000; i++) if (one[i] === 10) line++
  k.write('/tmp/n1', one)
  k.write('/tmp/n2', two)
  assert.deepEqual(k.sh('cmp n1 n2; echo $?'), [`n1 n2 differ: byte 150001, line ${line}`, '1'])
  assert.deepEqual(k.sh('cmp - n1 < n1; echo $?'), ['0'])
  assert.deepEqual(k.sh(`cmp -l n1 n2`), [`150001 ${one[150000].toString(8)} ${two[150000].toString(8)}`])
  // A pipe hands its bytes over in pieces of other sizes than a file's.
  k.write('/tmp/e', '')
  k.write('/tmp/big', lines(30000, (i) => `line ${i}`))
  k.write('/tmp/expect', `--- e\n+++ big\n@@ -0,0 +1,30000 @@\n${lines(30000, (i) => `+line ${i}`)}`)
  assert.deepEqual(k.sh('diff -u e big | cmp - expect; echo $?'), ['0'])
  assert.deepEqual(k.sh('echo abc | cmp - n1; echo $?'), ['- n1 differ: byte 1, line 1', '1'])
  // A reader that leaves early ends a long list.
  const flipped = one.map((b) => b ^ 255)
  k.write('/tmp/n3', flipped)
  assert.deepEqual(own(k.sh('cmp -l n1 n3 | cmp -s - e; echo $?')), ['1'])
  assert.deepEqual(tasks(k), AT_REST)
})

test('cmp: wrong commands, missing files and directories end with status 2', () => {
  const k = fresh()
  k.write('/tmp/a', 'a\n')
  k.write('/tmp/b', 'b\n')
  const use = '!usage: cmp [-s] [-l] file1 file2'
  assert.deepEqual(k.sh('cmp a; echo $?'), ['!cmp: a second file is needed', use, '2'])
  assert.deepEqual(k.sh('cmp -x a b; echo $?'), ["!cmp: unknown option '-x'", use, '2'])
  assert.deepEqual(k.sh('cmp -s -l a b; echo $?'), ['!cmp: options -s and -l cannot be used together', use, '2'])
  assert.deepEqual(k.sh('cmp a /nosuch; echo $?'), ['!cmp: /nosuch: no such file or directory', '2'])
  assert.deepEqual(k.sh('cmp -s /nosuch a; echo $?'), ['!cmp: /nosuch: no such file or directory', '2'])
  assert.deepEqual(k.sh('cmp /tmp a; echo $?'), ['!cmp: /tmp: is a directory (cmp compares two files)', '2'])
  assert.deepEqual(k.sh('cmp - -; echo $?'), ['0'])
  assert.deepEqual(k.sh('cmp -l a b > /dev/full; echo $?'), ['!cmp: write error: no space left on device', '2'])
  assert.deepEqual(tasks(k), AT_REST)
})

test('comm: three columns, and each one left out on request', () => {
  const k = fresh()
  k.write('/tmp/a', 'apple\nbanana\ncherry\n')
  k.write('/tmp/b', 'banana\ncherry\ndate\n')
  const cases: [string, string][] = [
    ['', 'apple\n\t\tbanana\n\t\tcherry\n\tdate\n'],
    ['-1', '\tbanana\n\tcherry\ndate\n'],
    ['-2', 'apple\n\tbanana\n\tcherry\n'],
    ['-3', 'apple\n\tdate\n'],
    ['-12', 'banana\ncherry\n'],
    ['-1 -3', 'date\n'],
    ['-23', 'apple\n'],
    ['-123', ''],
  ]
  for (const [flags, expect] of cases) {
    assert.deepEqual(k.sh(`comm ${flags} a b > out; echo $?`), ['0'], flags)
    assert.equal(k.read('/tmp/out'), expect, flags)
  }
  assert.deepEqual(k.sh('comm -12 a b'), ['banana', 'cherry'])
  // Repeated lines pair off one for one; a last line without its end is a line.
  k.write('/tmp/r1', 'a\na\nb')
  k.write('/tmp/r2', 'a\nb\nb\n')
  k.sh('comm r1 r2 > out')
  assert.equal(k.read('/tmp/out'), '\t\ta\na\n\t\tb\n\tb\n')
  k.write('/tmp/e', '')
  k.sh('comm e a > out')
  assert.equal(k.read('/tmp/out'), '\tapple\n\tbanana\n\tcherry\n')
  k.sh('comm e e > out')
  assert.equal(k.read('/tmp/out'), '')
  // A line longer than one read is one line.
  const long = 'y'.repeat(300000)
  k.write('/tmp/l1', `a\n${long}\n`)
  k.write('/tmp/l2', `${long}\nz\n`)
  k.sh('comm l1 l2 > out')
  assert.equal(k.read('/tmp/out'), `a\n\t\t${long}\n\tz\n`)
  // Character codes decide the order: capitals first.
  k.write('/tmp/c1', 'B\na\n')
  k.write('/tmp/c2', 'a\nb\n')
  k.sh('comm c1 c2 > out')
  assert.equal(k.read('/tmp/out'), 'B\n\t\ta\n\tb\n')
})

test('comm: the input as one file, files out of order, and refusals', () => {
  const k = fresh()
  k.write('/tmp/a', 'apple\ncherry\n')
  assert.deepEqual(k.sh('echo -e "banana\\ncherry" | comm -3 - a > out; echo $?'), ['0'])
  assert.equal(k.read('/tmp/out'), '\tapple\nbanana\n')
  k.write('/tmp/u', 'b\na\nc\n')
  k.write('/tmp/s', 'a\nc\n')
  assert.deepEqual(k.sh('comm u s > out; echo $?'), ['!comm: u: not in sorted order', '1'])
  assert.equal(k.read('/tmp/out'), '\ta\nb\na\n\t\tc\n')
  const use = '!usage: comm [-1] [-2] [-3] file1 file2'
  assert.deepEqual(k.sh('comm a; echo $?'), ['!comm: a second file is needed', use, '2'])
  assert.deepEqual(k.sh('comm -4 a a; echo $?'), ["!comm: unknown option '-4'", use, '2'])
  assert.deepEqual(k.sh('comm - -; echo $?'), ['!comm: only one of the two files can be the input (-)', use, '2'])
  assert.deepEqual(k.sh('comm a /nosuch; echo $?'), ['!comm: /nosuch: no such file or directory', '1'])
  assert.deepEqual(k.sh('comm /tmp a; echo $?'), ['!comm: /tmp: is a directory (comm compares two files)', '1'])
  assert.deepEqual(k.sh('comm a a > /dev/full; echo $?'), ['!comm: write error: no space left on device', '1'])
  // A reader that leaves early ends a long answer.
  k.write('/tmp/big', lines(50000, (i) => `${String(i).padStart(6, '0')}`))
  k.write('/tmp/e', '')
  assert.deepEqual(own(k.sh('comm big e | cmp -s - e; echo $?')), ['1'])
  assert.deepEqual(tasks(k), AT_REST)
})

test('comm: a line too long to compare whole is reported, and comm stops there', () => {
  const k = fresh()
  // The shared line reader gives a line longer than 1048576 characters back in pieces; comm must not take them as lines.
  const huge = 'm'.repeat(1 << 21)
  const odd = 'm'.repeat(1500000)
  k.write('/tmp/h1', `a\n${huge}\nz\n`)
  k.write('/tmp/h2', `b\n${huge}\n`)
  k.write('/tmp/o1', `a\n${odd}\n`)
  assert.deepEqual(k.sh('comm h1 h2 > out; echo $?'), ['!comm: h1: a line longer than 1048576 characters, too long to compare', '1'])
  assert.equal(k.read('/tmp/out'), 'a\n')
  assert.deepEqual(k.sh('comm o1 o1 > out; echo $?'), ['!comm: o1: a line longer than 1048576 characters, too long to compare', '1'])
  assert.equal(k.read('/tmp/out'), '\t\ta\n')
  // A line of exactly that many is still one line, and so is one with a pair of halves at the limit.
  const exact = 'm'.repeat(1 << 20)
  k.write('/tmp/e1', `${exact}\n`)
  assert.deepEqual(k.sh('comm e1 e1 > out; echo $?'), ['0'])
  assert.equal(k.read('/tmp/out'), `\t\t${exact}\n`)
  const paired = `${'m'.repeat((1 << 20) - 1)}\u{1F600}m`
  k.write('/tmp/p1', `${paired}\n`)
  assert.deepEqual(k.sh('comm p1 p1 > out; echo $?'), ['!comm: p1: a line longer than 1048576 characters, too long to compare', '1'])
  // One character short of the limit is still one line.
  const most = 'm'.repeat((1 << 20) - 1)
  k.write('/tmp/m1', `a\n${most}\n`)
  k.write('/tmp/m2', `${most}\nz\n`)
  assert.deepEqual(k.sh('comm m1 m2 > out; echo $?'), ['0'])
  assert.equal(k.read('/tmp/out'), `a\n\t\t${most}\n\tz\n`)
  assert.deepEqual(tasks(k), AT_REST)
})

test('the manual pages: one for each program, in the shape man reads', () => {
  assert.deepEqual(Object.keys(DIFF_MANUAL).sort(), Object.keys(DIFF_PROGRAMS).sort())
  for (const [name, page] of Object.entries(DIFF_MANUAL)) {
    const rows = page.split('\n')
    assert.equal(rows[0], 'NAME', name)
    assert.match(rows[1], new RegExp(`^    ${name} - [a-z]`), name)
    for (const heading of ['USAGE', 'WHAT IT DOES', 'STATUS', 'EXAMPLE']) assert.ok(rows.includes(heading), `${name}: ${heading}`)
    for (const row of rows) {
      assert.ok(row.length <= 78, `${name}: ${row}`)
      assert.match(row, /^[\x20-\x7e]*$/, `${name}: ${row}`)
    }
  }
})
