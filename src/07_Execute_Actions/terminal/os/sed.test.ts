// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds sed (sed.ts) to what its manual page promises, run through the real shell on a
 * system booted in memory: every address form, every command, the corners of substitution (matches of no
 * characters, the Nth match, case folding, the special characters of a replacement), the text commands, the hold
 * space, several files, in-place editing, input without a final line end, the exact words of every refusal, and
 * the limits that keep a script from running away.
 * What breaks if it is removed? A change to sed could quietly alter what a script does to a file, and nobody would
 * hear of it until the file was already rewritten.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encode } from './bytes.ts'
import { boot } from './kit.test.ts'
import type { Kit } from './kit.test.ts'
import { SED_MANUAL, SED_PROGRAMS } from './sed.ts'

/** A word as the shell reads it back unchanged: in single quotes, a quote inside written as '\''. */
const q = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`

/** One case: the flags, the script (pieces become several -e), the input, and the output wanted. */
type Row = readonly [string, string | readonly string[], string, string]

const USAGE = '!usage: sed [-n] [-E] [-i] [-e script]... [script] [file ...]'
const L5 = 'one\ntwo\nthree\nfour\nfive\n'

function argsOf(flags: string, script: string | readonly string[]): string {
  const s = typeof script === 'string' ? q(script) : script.map((piece) => `-e ${q(piece)}`).join(' ')
  return flags === '' ? s : `${flags} ${s}`
}

/** Runs sed over `input` (in /tmp/in, named last) with its output in /tmp/out: the output, the status and any error lines. */
function run(k: Kit, args: string, input: string | Uint8Array): { out: string; status: string; errors: string[] } {
  k.write('/tmp/in', input)
  const printed = k.sh(`sed ${args} /tmp/in > /tmp/out; echo $?`)
  return { out: k.read('/tmp/out'), status: printed[printed.length - 1] ?? '', errors: printed.slice(0, -1) }
}

function table(rows: readonly Row[]): void {
  const k = boot(SED_PROGRAMS)
  for (const [flags, script, input, want] of rows) {
    const args = argsOf(flags, script)
    const r = run(k, args, input)
    assert.deepEqual([r.out, r.status, r.errors], [want, '0', []], `sed ${args} on ${JSON.stringify(input)}`)
  }
}

test('sed: every address form, ranges and their negation', () => {
  table([
    ['', '', L5, L5],
    ['-n', '2p', L5, 'two\n'],
    ['-n', '$p', L5, 'five\n'],
    ['-n', '/t/p', L5, 'two\nthree\n'],
    ['-n', '\\,o,p', L5, 'one\ntwo\nfour\n'],
    ['-n', '\\|e$|p', L5, 'one\nthree\nfive\n'],
    ['-n', '\\/a\\/b/p', 'a/b\nab\n', 'a/b\n'],
    ['', '2,4d', L5, 'one\nfive\n'],
    ['', '2,+1d', L5, 'one\nfour\nfive\n'],
    ['', '2,+0d', L5, 'one\nthree\nfour\nfive\n'],
    ['-n', '/one/,+2p', L5, 'one\ntwo\nthree\n'],
    ['', '/two/,/four/d', L5, 'one\nfive\n'],
    ['', '/two/,3d', L5, 'one\nfour\nfive\n'],
    // A second line number not after the first: only the first line.
    ['', '3,1d', L5, 'one\ntwo\nfour\nfive\n'],
    ['', '/three/,2d', L5, 'one\ntwo\nfour\nfive\n'],
    ['', '2,$d', L5, 'one\n'],
    ['-n', '/four/,$p', L5, 'four\nfive\n'],
    ['-n', '$,/x/p', L5, 'five\n'],
    // The end of a range is looked for from the line after its start, and a range can start again.
    ['', '/e/,/e/d', L5, 'four\n'],
    ['', '/a/,/b/s/$/!/', 'a\nb\na\nb\nc\n', 'a!\nb!\na!\nb!\nc\n'],
    ['-n', '/four/,/nomatch/p', L5, 'four\nfive\n'],
    ['', '2!d', L5, 'two\n'],
    ['', '2,3!d', L5, 'two\nthree\n'],
    ['', '2,3 ! d', L5, 'two\nthree\n'],
    ['', '/o/!d', L5, 'one\ntwo\nfour\n'],
    ['', '$!d', L5, 'five\n'],
    ['-n', '1!{$!p}', L5, 'two\nthree\nfour\n'],
    // A range whose last line the command never saw (it was deleted first) is over, and does not run on.
    ['', '/x/d;1,2s/^/>/', 'a\nx\nb\nc\n', '>a\nb\nc\n'],
  ])
})

test('sed: the commands that print, delete, quit, number and transliterate', () => {
  table([
    ['', 'p', 'a\nb\n', 'a\na\nb\nb\n'],
    ['-n', 'p', L5, L5],
    ['-n', 'p;p', 'a\n', 'a\na\n'],
    ['', '=', 'a\nb\n', '1\na\n2\nb\n'],
    ['-n', '$=', L5, '5\n'],
    ['', 'd', L5, ''],
    ['', '1d;$d', L5, 'two\nthree\nfour\n'],
    ['', '2q', L5, 'one\ntwo\n'],
    ['-n', '2q', L5, ''],
    ['', '2q;s/^/>/', L5, '>one\ntwo\n'],
    ['', 'y/abc/xyz/', 'aabbcc\n', 'xxyyzz\n'],
    ['', 'y/\u00e9a/e\u00e0/', '\u00e9a\n', 'e\u00e0\n'],
    ['', 'y,/\\,,|.,', 'a/b,c\n', 'a|b.c\n'],
    ['', 'y/\\\\/\\//', 'a\\b\n', 'a/b\n'],
    ['', 'N;y/\\n/ /', 'a\nb\n', 'a b\n'],
    ['', '/t/{s/t/T/;s/e/E/}', L5, 'one\nTwo\nThrEe\nfour\nfive\n'],
    ['', '2,4{/three/!d}', L5, 'one\nthree\nfive\n'],
    ['', '{p};d', 'a\n', 'a\n'],
    ['-n', '/o/{/w/{p}}', L5, 'two\n'],
    ['-n', ['/o/{', 'p', '}'], L5, 'one\ntwo\nfour\n'],
    ['-n', ['# a comment', 'p'], 'a\n', 'a\n'],
    ['', 's/o/0/ # a comment after a command', 'foo\n', 'f0o\n'],
    ['', ['#n', '2p'], L5, 'two\n'],
    ['', ['#no', '2p'], 'a\nb\n', 'a\nb\nb\n'],
    ['', '  ;; p ; ', 'a\n', 'a\na\n'],
  ])
})

test('sed: n, N, D, P and the hold space', () => {
  table([
    ['', 'n;d', L5, 'one\nthree\nfive\n'],
    ['-n', 'n;p', L5, 'two\nfour\n'],
    // n on the last line ends as q does: the pattern space is printed once and nothing after n runs.
    ['', 'n;s/^/>/', 'a\nb\nc\n', 'a\n>b\nc\n'],
    ['', '$!N;s/\\n/ /', L5, 'one two\nthree four\nfive\n'],
    // N on the last line ends without printing the pattern space.
    ['', 'N;s/\\n/+/', 'a\nb\nc\n', 'a+b\n'],
    ['', 'N;s/^/>/g;s/$/</g', 'a\nb\n', '>a\nb<\n'],
    ['', '$!N;P;D', 'a\nb\nc\n', 'a\nb\nc\n'],
    ['', 'N;P;D', 'a\nb\nc\n', 'a\nb\n'],
    ['', '$!N;$!D', 'a\nb\nc\nd\n', 'c\nd\n'],
    ['', 'D', 'a\nb\n', ''],
    ['-n', 'N;P', 'a\nb\nc\nd\n', 'a\nc\n'],
    ['', '1!G;h;$!d', L5, 'five\nfour\nthree\ntwo\none\n'],
    ['', 'x', 'a\nb\nc\n', '\na\nb\n'],
    ['', 'H;$!d;x', 'a\nb\n', '\na\nb\n'],
    ['', '1h;1!g', 'a\nb\nc\n', 'a\na\na\n'],
    ['', 'G', 'a\nb\n', 'a\n\nb\n\n'],
    ['', 'h;s/a/b/;G', 'a\n', 'b\na\n'],
    ['', 'H;x;s/\\n/,/g', 'a\nb\n', ',a\na,b\n'],
  ])
})

test('sed: a, i and c, in their one-line and two-line forms', () => {
  table([
    ['', '2a hello', 'a\nb\nc\n', 'a\nb\nhello\nc\n'],
    ['', '2i hello', 'a\nb\nc\n', 'a\nhello\nb\nc\n'],
    ['', '2c hello', 'a\nb\nc\n', 'a\nhello\nc\n'],
    ['', '1,2c hello', 'a\nb\nc\n', 'hello\nc\n'],
    ['', '2,$c X', 'a\nb\nc\n', 'a\nX\n'],
    ['', '2!c X', 'a\nb\nc\n', 'X\nb\nX\n'],
    ['', '/b/,/nomatch/c X', 'a\nb\nc\n', 'a\n'],
    ['-n', '2c X', 'a\nb\n', 'X\n'],
    ['-n', '1a hi', 'a\n', 'hi\n'],
    ['', ['1a\\', 'hello'], 'a\nb\n', 'a\nhello\nb\n'],
    ['', ['1i\\', '  indented'], 'a\n', '  indented\na\n'],
    ['', '1a\\  two blanks', 'a\n', 'a\n  two blanks\n'],
    ['', '1a   lead', 'a\n', 'a\nlead\n'],
    ['', '1atight', 'a\n', 'a\ntight\n'],
    ['', ['1a one\\', 'two'], 'x\n', 'x\none\ntwo\n'],
    ['', '1a x;y}', 'a\n', 'a\nx;y}\n'],
    ['', '1a a\\tb', 'a\n', 'a\natb\n'],
    ['', ['1{a foo', '}'], 'a\n', 'a\nfoo\n'],
    ['', '$!a --', 'a\nb\n', 'a\n--\nb\n'],
    ['', 'i X', 'a\n', 'X\na\n'],
    ['', ['a A', '='], 'a\n', '1\na\nA\n'],
    ['', ['1a A', 'n'], 'a\nb\n', 'a\nA\nb\n'],
    ['', ['1a A', 'N'], 'a\nb\n', 'A\na\nb\n'],
    ['', ['a A', 'd'], 'a\n', 'A\n'],
    ['', '$a end', 'x', 'x\nend\n'],
  ])
})

test('sed: substitution, its flags and the special characters of a replacement', () => {
  table([
    ['', 's/o/0/', 'foo\nboo\n', 'f0o\nb0o\n'],
    ['', 's/o/0/g', 'foo\n', 'f00\n'],
    ['', 's/o/0/2', 'fooo\n', 'fo0o\n'],
    ['', 's/o/0/2g', 'foooo\n', 'fo000\n'],
    ['', 's/o/0/9', 'foo\n', 'foo\n'],
    ['', 's/z/0/g', 'foo\n', 'foo\n'],
    // Matches of no characters: one between every two characters, but never right where a match just ended.
    ['', 's/x*/-/g', 'abc\n', '-a-b-c-\n'],
    ['', 's/b*/X/2', 'abc\n', 'aXc\n'],
    ['', 's/b*/X/3', 'abc\n', 'abcX\n'],
    ['', 's/b*/X/g', 'abc\n', 'XaXcX\n'],
    ['', 's/a*/x/g', 'baaac\n', 'xbxcx\n'],
    ['', 's/x*/-/g', '\n', '-\n'],
    ['', 's/x*/-/g', '\u{1f600}\n', '-\u{1f600}-\n'],
    ['', 's/^/> /', 'a\nb\n', '> a\n> b\n'],
    ['', 's/$/!/', 'a\n', 'a!\n'],
    ['', 's/^/>/g', 'aaa\n', '>aaa\n'],
    ['', 's/^a/x/g', 'aaa\n', 'xaa\n'],
    // Case folding.
    ['', 's/O/0/gi', 'foO\n', 'f00\n'],
    ['', 's/HELLO/bye/I', 'say Hello\n', 'say bye\n'],
    ['', 's/[a-c]+/X/i', 'zzAbCzz\n', 'zzXzz\n'],
    // Groups, & and the escapes of a replacement.
    ['', 's/(\\w+) (\\w+)/\\2 \\1/', 'hello world\n', 'world hello\n'],
    ['-E', 's/(a+)/<\\1>/', 'baab\n', 'b<aa>b\n'],
    ['', 's/l+/[&]/', 'hello\n', 'he[ll]o\n'],
    ['', 's/a/&&/g', 'aa\n', 'aaaa\n'],
    ['', 's/a/\\0\\0/', 'a\n', 'aa\n'],
    ['', 's/l/\\&/g', 'hello\n', 'he&&o\n'],
    ['', 's/l/\\\\/', 'hello\n', 'he\\lo\n'],
    ['', 's/(a)|b/[\\1]/g', 'ab\n', '[a][]\n'],
    ['', 's/b/\\n/', 'abc\n', 'a\nc\n'],
    ['', 's/b/x\\ty/', 'abc\n', 'ax\tyc\n'],
    ['', 's/a/;/', 'a\n', ';\n'],
    ['', 's/a/\\;\\./', 'a\n', ';.\n'],
    ['', 's/a/b/;s/b/c/', 'a\n', 'c\n'],
    // Other delimiters, and the delimiter made plain.
    ['', 's|/|\\||g', 'a/b/c\n', 'a|b|c\n'],
    ['', 's/a/\\//', 'a\n', '/\n'],
    ['', 's/a/[\\/]/', 'a\n', '[/]\n'],
    ['', 's,a\\,b,X,', 'a,b\n', 'X\n'],
    ['', 's.a\\.b.X.', 'a.b axb\n', 'X axb\n'],
    ['', 'sxa\\xbxyx', 'axb\n', 'y\n'],
    ['', 's&a&\\&&', 'a\n', '&\n'],
    ['', 's\u{1f600}a\u{1f600}b\u{1f600}', 'a\n', 'b\n'],
    // Inside a bracket set the delimiter is a plain character.
    ['', 's/[/]/_/g', 'a/b\n', 'a_b\n'],
    ['', 's/[^/]*$//', 'dir/file\n', 'dir/\n'],
    ['', 's/[]/]/_/g', 'a]/b\n', 'a__b\n'],
    ['', 's/[[:digit:]/]+/#/', 'x12/3y\n', 'x#y\n'],
    // A [: that does not begin a class name is two plain characters of the set.
    ['', 's/[[:]/x/g', 'a[:b\n', 'axxb\n'],
    ['', 's/[[:a]/x/g', 'b[:a\n', 'bxxx\n'],
    ['', 's/[[:alpha:][:digit:]]+/#/', '-a1-\n', '-#-\n'],
    // Patterns.
    ['', 's/\\./!/g', 'a.b.c\n', 'a!b!c\n'],
    ['', 's/./X/g', 'h\u00e9llo\n', 'XXXXX\n'],
    ['', 's/\u{1f600}/:)/', 'a\u{1f600}b\n', 'a:)b\n'],
    ['', 's/a{2}/X/', 'aaa\n', 'Xa\n'],
    ['', 's/[[:cntrl:]]$//', 'a\r\n', 'a\n'],
    ['', 's/a/b/', 'a\r\nc\r\n', 'b\r\nc\r\n'],
    // p prints after a replacement only.
    ['-n', 's/a/b/p', 'a\nc\na\n', 'b\nb\n'],
    ['', 's/a/b/p', 'a\n', 'b\nb\n'],
    ['-n', 's/a/b/gp', 'aa\n', 'bb\n'],
    // An empty pattern is the last one used.
    ['', 's/a/b/;s//c/', 'aa\n', 'bc\n'],
    ['', '/x/s//y/g', 'axbx\nab\n', 'ayby\nab\n'],
    ['', '/o/!d;s//0/g', L5, '0ne\ntw0\nf0ur\n'],
    ['', '/a/s/b/X/;s//Y/', 'ab\ncb\n', 'aX\ncb\n'],
    // Inside a range, // is whichever end was looked for last: the lines between the two, without them.
    ['-n', '/start/,/end/{//!p}', 'a\nstart\nb\nc\nend\nd\n', 'b\nc\n'],
  ])
})

test('sed: input without a final line end, carriage returns, empty input', () => {
  table([
    ['', 'p', 'x', 'x\nx'],
    ['', '', 'a\nb', 'a\nb'],
    ['-n', '$p', 'a\nb', 'b'],
    ['', '$d', 'a\nb', 'a\n'],
    ['', 's/b/c/', 'a\nb', 'a\nc'],
    ['', 's/$/</', 'abc', 'abc<'],
    ['', '$i X', 'a', 'X\na'],
    ['', '=', 'a', '1\na'],
    ['', 'G', 'a', 'a\n'],
    ['', '$!N;P;D', 'a\nb', 'a\nb'],
    ['', 'p', '', ''],
    ['', '$a x', '', ''],
    ['', '1i x', '', ''],
    ['-n', '$=', '', ''],
    ['', 's/x*/-/g', '', ''],
  ])
})

test('sed: bytes pass through: a NUL survives, bytes that are not UTF-8 become the replacement character', () => {
  const k = boot(SED_PROGRAMS)
  run(k, 's/b/c/', Uint8Array.of(0x61, 0x00, 0x62, 0x0a))
  assert.deepEqual([...k.bytes('/tmp/out')], [0x61, 0x00, 0x63, 0x0a])
  run(k, 'p', Uint8Array.of(0xff, 0x0a))
  assert.deepEqual([...k.bytes('/tmp/out')], [0xef, 0xbf, 0xbd, 0x0a, 0xef, 0xbf, 0xbd, 0x0a])
  run(k, 's/\u00e9/e/', encode('caf\u00e9\n'))
  assert.equal(k.read('/tmp/out'), 'cafe\n')
  // A byte order mark at the start of a file is kept.
  run(k, 's/a/b/', Uint8Array.of(0xef, 0xbb, 0xbf, 0x61, 0x0a))
  assert.deepEqual([...k.bytes('/tmp/out')], [0xef, 0xbb, 0xbf, 0x62, 0x0a])
})

test('sed: q ends with the status it is given', () => {
  const k = boot(SED_PROGRAMS)
  k.write('/tmp/f', L5)
  assert.deepEqual(k.sh('sed q5 /tmp/f; echo $?'), ['one', '5'])
  assert.deepEqual(k.sh("sed '2q 7' /tmp/f; echo $?"), ['one', 'two', '7'])
  assert.deepEqual(k.sh("sed -n '3q' /tmp/f; echo $?"), ['0'])
  assert.deepEqual(k.sh('sed q /tmp/f /nosuch; echo $?'), ['one', '0'])
})

test('sed: several files are one text; a missing file or a directory is reported and passed over', () => {
  const k = boot(SED_PROGRAMS)
  k.write('/tmp/a', 'a1\na2\n')
  k.write('/tmp/b', 'b1\nb2\n')
  k.write('/tmp/c', 'c1')
  k.write('/tmp/e', '')
  assert.deepEqual(k.sh("sed -n '$=' /tmp/a /tmp/b"), ['4'])
  assert.deepEqual(k.sh('sed 1d /tmp/a /tmp/b'), ['a2', 'b1', 'b2'])
  assert.deepEqual(k.sh("sed '$d' /tmp/a /tmp/b"), ['a1', 'a2', 'b1'])
  assert.deepEqual(k.sh("sed -n '2,3p' /tmp/a /tmp/b"), ['a2', 'b1'])
  assert.deepEqual(k.sh("sed -n '/2/,/1/p' /tmp/a /tmp/b"), ['a2', 'b1', 'b2'])
  // A file that ends without a line end, followed by another: its last line is a whole line.
  k.sh('sed p /tmp/c /tmp/b > /tmp/out')
  assert.equal(k.read('/tmp/out'), 'c1\nc1\nb1\nb1\nb2\nb2\n')
  // Followed only by an empty file, it is still the last line, and keeps its missing line end.
  k.sh('sed p /tmp/c /tmp/e > /tmp/out')
  assert.equal(k.read('/tmp/out'), 'c1\nc1')
  k.sh('sed N /tmp/c /tmp/b > /tmp/out')
  assert.equal(k.read('/tmp/out'), 'c1\nb1\n')
  assert.deepEqual(k.sh('sed p /tmp/a /nosuch /tmp/b; echo $?'), [
    'a1', 'a1', 'a2', 'a2', '!sed: /nosuch: no such file or directory', 'b1', 'b1', 'b2', 'b2', '1',
  ])
  assert.deepEqual(k.sh("sed -n '$p' /tmp/a /nosuch; echo $?"), ['!sed: /nosuch: no such file or directory', 'a2', '1'])
  assert.deepEqual(k.sh('sed p /tmp; echo $?'), ['!sed: /tmp: is a directory', '1'])
  assert.deepEqual(k.sh('sed p /nosuch; echo $?'), ['!sed: /nosuch: no such file or directory', '1'])
  assert.deepEqual(k.sh('sed p /tmp/e; echo $?'), ['0'])
})

test('sed: the ordinary input, named or not, and a line typed at the terminal answered at once', () => {
  const k = boot(SED_PROGRAMS)
  k.write('/tmp/a', 'a1\na2\n')
  assert.deepEqual(k.sh('echo hi | sed s/hi/ho/'), ['ho'])
  assert.deepEqual(k.sh('sed p - < /tmp/a'), ['a1', 'a1', 'a2', 'a2'])
  assert.deepEqual(k.sh('echo mid | sed -n p /tmp/a - /tmp/a'), ['a1', 'a2', 'mid', 'a1', 'a2'])
  assert.deepEqual(k.sh("sed = /tmp/a | sed 'N;s/\\n/ /'"), ['1 a1', '2 a2'])
  assert.deepEqual(k.sh('sed s/a/b/'), [])
  assert.deepEqual(k.sh('abc'), ['bbc'])
  assert.deepEqual(k.sh('a2'), ['b2'])
  k.system.end()
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(k.sh('echo $?'), ['0'])
})

test('sed -i: each file edited on its own, written back only when read whole', () => {
  const k = boot(SED_PROGRAMS)
  k.write('/tmp/f', 'one\ntwo\n')
  k.write('/tmp/g', 'three\nfour\n')
  assert.deepEqual(k.sh('sed -i s/o/0/g /tmp/f; echo $?'), ['0'])
  assert.equal(k.read('/tmp/f'), '0ne\ntw0\n')
  assert.deepEqual(k.sh("sed -i '$a end' /tmp/f /tmp/g; echo $?"), ['0'])
  assert.equal(k.read('/tmp/f'), '0ne\ntw0\nend\n')
  assert.equal(k.read('/tmp/g'), 'three\nfour\nend\n')
  assert.deepEqual(k.sh('sed -i 1d /tmp/f /tmp/g'), [])
  assert.equal(k.read('/tmp/f'), 'tw0\nend\n')
  assert.equal(k.read('/tmp/g'), 'four\nend\n')
  // Nothing reaches the screen: p, = and the rest go into the file.
  assert.deepEqual(k.sh("sed -i 'p;=' /tmp/f"), [])
  assert.equal(k.read('/tmp/f'), 'tw0\n1\ntw0\nend\n2\nend\n')
  assert.deepEqual(k.sh("sed -n -i '1p' /tmp/f"), [])
  assert.equal(k.read('/tmp/f'), 'tw0\n')
  // A missing line end at the end stays missing.
  k.write('/tmp/h', 'a\nb')
  k.sh('sed -i s/b/c/ /tmp/h')
  assert.equal(k.read('/tmp/h'), 'a\nc')
  // A missing file among good ones is reported; the others are edited.
  k.write('/tmp/f', 'x\n')
  k.write('/tmp/g', 'x\n')
  assert.deepEqual(k.sh('sed -i s/x/y/ /tmp/f /nosuch /tmp/g; echo $?'), ['!sed: /nosuch: no such file or directory', '1'])
  assert.equal(k.read('/tmp/f'), 'y\n')
  assert.equal(k.read('/tmp/g'), 'y\n')
  assert.deepEqual(k.sh('sed -i p /tmp; echo $?'), ['!sed: /tmp: is a directory', '1'])
  // A file that cannot be written is reported, and left as it was.
  const before = k.read('/bin/sed')
  assert.deepEqual(k.sh('sed -i s/a/b/ /bin/sed; echo $?'), ['!sed: /bin/sed: read-only file system', '1'])
  assert.equal(k.read('/bin/sed'), before)
  // A new text that does not fit on the disk leaves the file as it was.
  const fill = `${'x'.repeat(1023)}\n`.repeat(3072)
  k.write('/tmp/fill', fill)
  assert.deepEqual(k.sh("sed -i 'p;p' /tmp/fill; echo $?"), ['!sed: /tmp/fill: no space left on device', '1'])
  assert.equal(k.read('/tmp/fill'), fill)
  // A shorter new text is cut to its own length.
  assert.deepEqual(k.sh('sed -i 1,3000d /tmp/fill; echo $?'), ['0'])
  assert.equal(k.read('/tmp/fill'), `${'x'.repeat(1023)}\n`.repeat(72))
  // A script with a mistake touches nothing.
  assert.deepEqual(k.sh('sed -i j /tmp/f; echo $?'), ["!sed: unknown command: 'j'", '2'])
  assert.equal(k.read('/tmp/f'), 'y\n')
  // q: the file keeps what was printed before q, and later files are not touched.
  k.write('/tmp/f', 'a\nb\nc\n')
  k.write('/tmp/g', 'a\nb\nc\n')
  assert.deepEqual(k.sh('sed -i 1q /tmp/f /tmp/g; echo $?'), ['0'])
  assert.equal(k.read('/tmp/f'), 'a\n')
  assert.equal(k.read('/tmp/g'), 'a\nb\nc\n')
  assert.deepEqual(k.sh('sed -i q3 /tmp/g; echo $?'), ['3'])
  assert.equal(k.read('/tmp/g'), 'a\n')
})

test('sed -i: refused without a file, or for the ordinary input', () => {
  const k = boot(SED_PROGRAMS)
  assert.deepEqual(k.sh('sed -i p; echo $?'), ['!sed: -i needs a file to edit', '2'])
  assert.deepEqual(k.sh('sed -i -e p; echo $?'), ['!sed: -i needs a file to edit', '2'])
  assert.deepEqual(k.sh('echo x | sed -i p -; echo $?'), ['!sed: -i cannot edit the standard input (-)', '2'])
})

test('sed: a refused write to the output is reported once', () => {
  const k = boot(SED_PROGRAMS)
  k.write('/tmp/f', 'a\nb\n')
  assert.deepEqual(k.sh('sed p /tmp/f > /dev/full; echo $?'), ['!sed: write error: no space left on device', '1'])
})

test('sed: options', () => {
  const k = boot(SED_PROGRAMS)
  k.write('/tmp/f', 'a\nb\n')
  assert.deepEqual(k.sh('sed -ne 2p /tmp/f'), ['b'])
  assert.deepEqual(k.sh('sed -nE -e 1p -e 2p /tmp/f'), ['a', 'b'])
  assert.deepEqual(k.sh('sed -e1p -n /tmp/f'), ['a'])
  assert.deepEqual(k.sh('sed 1p -n /tmp/f; echo $?'), ['!sed: -n: no such file or directory', 'a', 'a', 'b', '1'])
  assert.deepEqual(k.sh('sed -n -- 1p /tmp/f'), ['a'])
  assert.deepEqual(k.sh('sed; echo $?'), [USAGE, '2'])
  assert.deepEqual(k.sh('sed -n; echo $?'), [USAGE, '2'])
  assert.deepEqual(k.sh('sed -x p; echo $?'), ["!sed: unknown option '-x'", USAGE, '2'])
  assert.deepEqual(k.sh('sed --posix p; echo $?'), ["!sed: unknown option '--posix'", USAGE, '2'])
  assert.deepEqual(k.sh('sed -e; echo $?'), ["!sed: option '-e' needs a script", USAGE, '2'])
})

test('sed: a mistake in the script is reported before any input is read, with status 2', () => {
  const k = boot(SED_PROGRAMS)
  const cases: readonly (readonly [string, string])[] = [
    ['j', "unknown command: 'j'"],
    ['b end', 'branches are not supported'],
    [':a', 'branches are not supported'],
    ['t', 'branches are not supported'],
    ['/x/b', 'branches are not supported'],
    ['s/a/b/w /tmp/x', 'the w flag of s is not supported: a script cannot write files'],
    ['w /tmp/x', 'w is not supported: a script cannot write files'],
    ['r /tmp/x', 'r is not supported: a script cannot read other files'],
    ['s/a/b', 'unterminated s command'],
    ['s/a', 'unterminated s command'],
    ['s', 'unterminated s command'],
    ['s/a/b\\', 'unterminated s command'],
    ['s/[a/b/', 'unterminated s command'],
    ['s/(/x/', 'unmatched ( in pattern'],
    ['s/a{2,1}/x/', 'repetition counts out of order: {2,1}'],
    ['s/(a)\\1/x/', 'back-references are not supported'],
    ['s/a/\\1/', 'the replacement names group 1, but the pattern has no groups'],
    ['s/(a)/\\2/', 'the replacement names group 2, but the pattern has only 1'],
    ['s/a/b/gg', 's: the g flag is given twice'],
    ['s/a/b/pp', 's: the p flag is given twice'],
    ['s/a/b/iI', 's: the I flag is given twice'],
    ['s/a/b/2g3', 's: more than one number'],
    ['s/a/b/0', 's: matches are counted from 1, so the number cannot be 0'],
    ['s/a/b/x', "unknown flag of s: 'x'"],
    ['s/a/b/ x', 'extra characters after command'],
    ['s/a/\\U/', 'unknown escape \\U in the replacement'],
    ['y/abc/de/', 'y: the two lists of characters differ in length'],
    ['y/aa/bc/', "y: 'a' is listed twice"],
    ['y/a/b', 'unterminated y command'],
    ['y/\\t/x/', 'y: unknown escape \\t'],
    ['/abc', 'unterminated address pattern: no closing /'],
    ['\\%abc', 'unterminated address pattern: no closing %'],
    ['\\', 'a \\ address needs a character to close its pattern with'],
    ['1,', 'a range needs a second address after the comma'],
    ['1,+d', '+ needs a number after it'],
    ['{p', 'unmatched {'],
    ['p}', 'unexpected }'],
    ['1{p};1}', '} takes no address'],
    ['1,2q', 'q takes one address at most'],
    ['q 300', 'q: the exit status must be from 0 to 255'],
    ['pq', 'extra characters after command'],
    ['1!!p', 'more than one ! in a row'],
    ['1', 'missing command'],
    ['1;p', 'missing command'],
    ['a', 'a needs text'],
    ['1i\\', 'i needs text'],
    ['0p', 'line numbers start at 1'],
    ['0,/x/p', 'line numbers start at 1'],
    ['99999999999999999999p', 'line number too large'],
    ['s//x/', 'an empty pattern stands for the one before it, and there is none before it'],
    ['/a/s//x/i', 'an empty pattern cannot take the i flag'],
    ['1#c', 'a comment takes no address'],
    ['p;l', "unknown command: 'l'"],
    ['\u{1f600}', "unknown command: '\u{1f600}'"],
  ]
  for (const [script, why] of cases) {
    // The file does not exist: a script with a mistake never gets as far as looking for it.
    assert.deepEqual(k.sh(`sed ${q(script)} /nosuch; echo $?`), [`!sed: ${why}`, '2'], script)
  }
})

test('sed: limits: D that does not shorten, a space past 8 MiB, a line past 8 MiB', () => {
  const k = boot(SED_PROGRAMS)
  k.write('/tmp/f', 'a\n')
  const loop = '!sed: D did not make the pattern space shorter, so the cycle could repeat without end; stopped'
  assert.deepEqual(k.sh("sed 'G;D' /tmp/f; echo $?"), [loop, '1'])
  assert.deepEqual(k.sh("sed 's/^/\\n/;D' /tmp/f; echo $?"), [loop, '1'])
  // What was printed before the stop is kept.
  k.write('/tmp/g', 'x\ny\n')
  assert.deepEqual(k.sh("sed '2{G;D}' /tmp/g; echo $?"), ['x', loop, '1'])
  // Doubling the pattern space: past 8 MiB sed stops; in place, the file is left as it was.
  const line = 'z'.repeat(1024)
  k.write('/tmp/big', `${line}\n`)
  const doubling = Array.from({ length: 14 }, () => 'h;G').join(';')
  assert.deepEqual(k.sh(`sed ${q(doubling)} /tmp/big > /dev/null; echo $?`), [
    '!sed: the pattern space would hold more than 8 MiB (8388608 characters); stopped', '1',
  ])
  assert.deepEqual(k.sh(`sed -i ${q(doubling)} /tmp/big; echo $?`), [
    '!sed: /tmp/big: the pattern space would hold more than 8 MiB (8388608 characters); stopped, and the file is left as it was', '1',
  ])
  assert.equal(k.read('/tmp/big'), `${line}\n`)
  const holding = Array.from({ length: 14 }, () => 'H;g').join(';')
  assert.deepEqual(k.sh(`sed -n ${q(holding)} /tmp/big; echo $?`), ['!sed: the hold space would hold more than 8 MiB (8388608 characters); stopped', '1'])
  // y can turn a character into one that takes two units: the cap holds all the same (4 Mi z's become 8 Mi units).
  const widening = `${Array.from({ length: 12 }, () => 'h;G').join(';')};y/z/\u{1f600}/`
  assert.deepEqual(k.sh(`sed ${q(widening)} /tmp/big > /dev/null; echo $?`), [
    '!sed: the pattern space would hold more than 8 MiB (8388608 characters); stopped', '1',
  ])
  // A script full of [: is read in a time in step with its length (each [: once searched the rest of the script).
  k.write('/tmp/script', `s/[${'[:'.repeat(60000)}]/x/\n`)
  assert.deepEqual(k.sh('read -r s < /tmp/script; sed "$s" /tmp/f; echo $?'), ['!sed: pattern too long: more than 4096 characters', '2'])
  // A device that never ends a line: sed stops at the cap instead of holding more.
  assert.deepEqual(k.sh('sed p /dev/zero; echo $?'), ['!sed: a line of the input is longer than 8 MiB (8388608 characters); stopped', '1'])
})

test('sed: searches that cost far more than their characters still give the other tasks their turns', () => {
  const k = boot(SED_PROGRAMS)
  /** Types a line and runs the system a turn at a time until nothing can move: how many turns that took. */
  const turns = (line: string): number => {
    k.system.type(`${line}\n`)
    let n = 0
    while (!k.system.idle) {
      k.system.run(1, Number.POSITIVE_INFINITY)
      n++
    }
    return n
  }
  // Each search for a*b looks on to the end of the line for a b that is not there, so s///g does work in the square
  // of the line's length in only a few thousand searches; all of it once ran in a single turn (3 turns in all).
  k.write('/tmp/f', `${'a'.repeat(4000)}\n`)
  assert.ok(turns("sed 's/a*b|a/x/g' /tmp/f > /tmp/out") > 20)
  assert.equal(k.read('/tmp/out'), `${'x'.repeat(4000)}\n`)
  // Many addresses tried on one long line: each one search, but a long one.
  k.write('/tmp/f', `${'a'.repeat(65536)}\n`)
  assert.ok(turns(`sed -n ${q('/a*b/p;'.repeat(40))} /tmp/f > /tmp/out`) > 10)
  assert.equal(k.read('/tmp/out'), '')
})

test('sed: long lines, a long run of lines, and a closed pipe that ends it quickly', () => {
  const k = boot(SED_PROGRAMS)
  k.write('/tmp/wide', `${'a'.repeat(200000)}\n`)
  k.sh('sed s/a/b/g /tmp/wide > /tmp/out')
  assert.equal(k.read('/tmp/out'), `${'b'.repeat(200000)}\n`)
  k.sh('sed s/x*/-/g /tmp/wide > /tmp/out')
  assert.equal(k.read('/tmp/out').length, 400002)
  const lines: string[] = []
  for (let n = 0; n < 100000; n++) lines.push(`l${n}`)
  k.write('/tmp/many', `${lines.join('\n')}\n`)
  assert.deepEqual(k.sh("sed -n '$=' /tmp/many"), ['100000'])
  // Two lines at a time, slid over every line: no line is lost, and D never mistakes it for a loop.
  assert.deepEqual(k.sh("sed '$!N;P;D' /tmp/many | sed -n '$='"), ['100000'])
  assert.deepEqual(k.sh("sed '$!N;P;D' /tmp/many | sed -n '$p'"), ['l99999'])
  // The reader stops after one line; the writer is ended by the closed pipe instead of copying the rest (the time
  // this file takes to run is what holds that to "quickly").
  assert.deepEqual(k.sh('sed p /tmp/many | sed 1q; echo $?'), ['l0', '0'])
  assert.deepEqual(k.sh('sed p /tmp/many /tmp/many /tmp/many /tmp/many | sed q'), ['l0'])
})

test('sed: its manual page has the shape man reads', () => {
  const page = SED_MANUAL.sed
  const lines = page.split('\n')
  assert.equal(lines[0], 'NAME')
  assert.ok(lines[1].startsWith('    sed - '))
  assert.ok(page.endsWith('\n') && !page.endsWith('\n\n'))
  const headings = lines.filter((line) => /^[A-Z]/.test(line))
  assert.deepEqual(headings, ['NAME', 'USAGE', 'WHAT IT DOES', 'OPTIONS', 'NOTES', 'STATUS', 'EXAMPLE'])
  for (const [i, line] of lines.entries()) {
    assert.ok(line.length <= 78, `line ${i + 1} is ${line.length} columns`)
    assert.match(line, /^[\x20-\x7e]*$/, `line ${i + 1} is not plain ASCII`)
    assert.ok(!line.endsWith(' '), `line ${i + 1} ends in a blank`)
  }
  assert.ok(page.includes('branches are not supported'))
  assert.deepEqual(Object.keys(SED_PROGRAMS), ['sed'])
})
