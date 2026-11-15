// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It tests the file programs (fileutils.ts) the way a person meets them: typed at the real
 * shell of a system held in memory, with what they print, what they leave on the file system and the status they end
 * with all checked. Every option of every program is used at least once, and so are the ways each one is refused: a
 * path that is not there among paths that are, a directory where a file is wanted, a read-only place, a mount point,
 * the root directory, a pipe whose reader has gone, bytes that are no text, a file larger than one read.
 * What breaks if it is removed? A change to one of these programs could alter what a script depends on (the text of
 * a listing, an exit status, the words of a refusal) or lose a file's bytes, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FILE_MANUAL, FILE_PROGRAMS } from './fileutils.ts'
import { ROOT_CRED } from './fs.ts'
import { boot } from './kit.test.ts'
import type { Kit } from './kit.test.ts'
import { now } from './task.ts'

/** A system with the file programs, its shell working in /tmp. */
function fresh(): Kit {
  const k = boot(FILE_PROGRAMS)
  assert.deepEqual(k.sh('cd /tmp'), [])
  return k
}

/** What a command printed, without the shell's own remarks (it names itself first on those lines). */
const own = (lines: readonly string[]): string[] => lines.filter((l) => !l.startsWith('!ash:'))

/** Bytes that are no text: every value, several times over, in an order that is not simply counting. */
function noise(length: number): Uint8Array {
  const out = new Uint8Array(length)
  let x = 12345
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    out[i] = (x >> 16) & 255
  }
  return out
}

/** Enough files that a listing of them is more than a pipe holds at once. */
const MANY = 2000

const NAMES = [
  'basename', 'cat', 'chmod', 'cp', 'df', 'dirname', 'du', 'find', 'ls', 'mkdir', 'mount', 'mv', 'realpath', 'rm', 'rmdir', 'stat', 'touch', 'tree',
  'umount',
]

test('manual: every program has a page, each in the one shape, plain and narrow', () => {
  assert.deepEqual(Object.keys(FILE_PROGRAMS).sort(), NAMES)
  assert.deepEqual(Object.keys(FILE_MANUAL).sort(), NAMES)
  assert.ok(Object.isFrozen(FILE_PROGRAMS) && Object.isFrozen(FILE_MANUAL))
  const order = ['NAME', 'USAGE', 'WHAT IT DOES', 'OPTIONS', 'NOTES', 'STATUS', 'EXAMPLE']
  for (const name of NAMES) {
    const page = FILE_MANUAL[name]
    assert.ok(page.endsWith('\n') && !page.endsWith('\n\n') && !page.startsWith('\n'), name)
    const lines = page.split('\n')
    assert.equal(lines[0], 'NAME', name)
    assert.match(lines[1], new RegExp(`^    ${name} - [a-z][^.]*$`), name)
    assert.equal(lines[2], '', name)
    assert.equal(lines[3], 'USAGE', name)
    assert.ok(lines[4] === `    ${name}` || lines[4].startsWith(`    ${name} `), name)
    const heads: string[] = []
    for (const [i, line] of lines.entries()) {
      assert.ok(line.length <= 78, `${name}:${i + 1}: ${line.length} columns`)
      assert.match(line, /^[\x20-\x7e]*$/, `${name}:${i + 1}`)
      assert.ok(!line.endsWith(' '), `${name}:${i + 1}: a blank at the end`)
      if (line === '' || line.startsWith('    ')) continue
      assert.ok(order.includes(line), `${name}:${i + 1}: ${line}`)
      assert.equal(lines[i - 1] ?? '', '', `${name}:${i + 1}: a heading follows an empty line`)
      heads.push(line)
    }
    assert.deepEqual(heads, order.filter((h) => heads.includes(h)), name)
    for (const must of ['NAME', 'USAGE', 'WHAT IT DOES', 'STATUS', 'EXAMPLE']) assert.ok(heads.includes(must), `${name}: ${must}`)
    assert.ok(lines[lines.indexOf('EXAMPLE') + 1].startsWith(`    ${name}`), name)
  }
})

test('manual: the usage line a wrong call prints is the one in the page, and the status is 2', () => {
  const k = fresh()
  const wrong: Record<string, string> = {
    ls: 'ls -z', cat: 'cat -z', mkdir: 'mkdir', rmdir: 'rmdir', rm: 'rm', cp: 'cp onlyone', mv: 'mv onlyone', touch: 'touch', chmod: 'chmod 644', stat: 'stat',
    find: 'find -bogus', du: 'du -z', df: 'df -z', umount: 'umount', realpath: 'realpath', basename: 'basename', dirname: 'dirname', tree: 'tree -z',
  }
  for (const [name, line] of Object.entries(wrong)) {
    const out = k.sh(`${line}; echo $?`)
    const lines = FILE_MANUAL[name].split('\n')
    assert.equal(out[out.length - 2], `!usage: ${lines[lines.indexOf('USAGE') + 1].trim()}`, name)
    assert.equal(out[out.length - 1], '2', name)
  }
  assert.deepEqual(k.sh('ls -z'), ["!ls: unknown option '-z'", '!usage: ls [-laAd1RhFStr] [path ...]'])
  assert.deepEqual(k.sh('mkdir -m'), ["!mkdir: option '-m' needs a value", '!usage: mkdir [-p] [-m mode] dir ...'])
  assert.deepEqual(k.sh('ls'), [])
})

// ls

test('ls: names in code-unit order; names that start with a dot only with -a (and . and ..) or -A', () => {
  const k = fresh()
  k.sh('mkdir d')
  for (const name of ['b', 'B', 'a', '10', '9', '.hid', '_u']) k.write(`/tmp/d/${name}`, '')
  assert.deepEqual(k.sh('ls d'), ['10  9  B  _u  a  b'])
  assert.deepEqual(k.sh('ls -a d'), ['.  ..  .hid  10  9  B  _u  a  b'])
  assert.deepEqual(k.sh('ls -A d'), ['.hid  10  9  B  _u  a  b'])
  assert.deepEqual(k.sh('ls -r d'), ['b  a  _u  B  9  10'])
  assert.deepEqual(k.sh('ls -1 d'), ['10', '9', 'B', '_u', 'a', 'b'])
  assert.deepEqual(k.sh('ls -1A d'), ['.hid', '10', '9', 'B', '_u', 'a', 'b'])
  assert.deepEqual(k.sh('cd d; ls; cd ..'), ['10  9  B  _u  a  b'])
  assert.deepEqual(k.sh('mkdir empty; ls empty; ls -l empty; ls -a empty; echo $?'), ['.  ..', '0'])
})

test('ls: columns on the terminal, one name to a line into a pipe or a file', () => {
  const k = fresh()
  k.sh('mkdir d')
  for (const name of ['one', 'two', 'three']) k.write(`/tmp/d/${name}`, '')
  assert.deepEqual(k.sh('ls d'), ['one  three  two'])
  assert.deepEqual(k.sh('ls d | cat'), ['one', 'three', 'two'])
  assert.deepEqual(k.sh('ls d > out; echo $?'), ['0'])
  assert.equal(k.read('/tmp/out'), 'one\nthree\ntwo\n')
  assert.deepEqual(k.sh('ls -a d | cat'), ['.', '..', 'one', 'three', 'two'])
})

test('ls: columns fill down and then across, and fit 80 columns', () => {
  const k = fresh()
  k.sh('mkdir d e w')
  const long = (i: number): string => `${'n'.repeat(29)}${i}`
  for (let i = 0; i < 5; i++) k.write(`/tmp/d/${long(i)}`, '')
  assert.deepEqual(k.sh('ls d'), [`${long(0)}  ${long(3)}`, `${long(1)}  ${long(4)}`, long(2)])
  // 30 names of mixed lengths: the lines read down the columns give the sorted order back.
  const names: string[] = []
  for (let i = 1; i <= 30; i++) names.push(`file${i}${i % 4 === 0 ? '-longer' : ''}`)
  for (const name of names) k.write(`/tmp/e/${name}`, '')
  const lines = k.sh('ls e')
  assert.deepEqual(lines, [
    'file1          file15         file20-longer  file26         file4-longer',
    'file10         file16-longer  file21         file27         file5',
    'file11         file17         file22         file28-longer  file6',
    'file12-longer  file18         file23         file29         file7',
    'file13         file19         file24-longer  file3          file8-longer',
    'file14         file2          file25         file30         file9',
  ])
  for (const line of lines) assert.ok(line.length <= 80 && !line.endsWith(' '), line)
  // Read down the columns, the lines give the sorted order back.
  const sorted = names.slice().sort()
  const cells = lines.map((l) => l.split(/ +/))
  const down: string[] = []
  for (let c = 0; c < cells[0].length; c++) for (const row of cells) if (row[c] !== undefined) down.push(row[c])
  assert.deepEqual(down, sorted)
  // Every column starts at the same place on every line that has it.
  const starts = lines.map((l) => [...l.matchAll(/\S+/g)].map((m) => m.index))
  for (const row of starts) assert.deepEqual(row, starts[0].slice(0, row.length))
  // One column more would not fit: split evenly over six columns (five lines), the same names need more than 80.
  const needs = (rows: number): number => {
    let total = 0
    for (let from = 0; from < sorted.length; from += rows) total += Math.max(...sorted.slice(from, from + rows).map((n) => n.length)) + (from === 0 ? 0 : 2)
    return total
  }
  assert.deepEqual([needs(6), needs(5)], [72, 87])
  // A name wider than the line: one name to a line.
  k.write(`/tmp/e/${'w'.repeat(90)}`, '')
  assert.equal(k.sh('ls e').length, 31)
  // Width is counted in characters, not in the two code units some of them take.
  const face = '\u{1F600}'
  for (const name of [face, face + face + face, 'y'.repeat(40), 'z'.repeat(40)]) k.write(`/tmp/w/${name}`, '')
  assert.deepEqual(k.sh('ls -r w'), [`${face + face + face}  ${'z'.repeat(40)}`, `${face}    ${'y'.repeat(40)}`])
})

test('ls -l: mode, owner, size, time and name, in columns that line up', () => {
  const k = fresh()
  k.sh('mkdir d d/sub; chmod 750 d/sub')
  k.write('/tmp/d/large', 'x'.repeat(1500))
  k.write('/tmp/d/small', 'x')
  k.sh('chmod 600 d/small; chmod 755 d/large')
  assert.deepEqual(k.sh('ls -l d'), [
    '-rwxr-xr-x root 1500 2026-11-14 18:00 large',
    '-rw------- root    1 2026-11-14 18:00 small',
    'drwxr-x--- root    0 2026-11-14 18:00 sub',
  ])
  assert.deepEqual(k.sh('ls -lh d'), [
    '-rwxr-xr-x root 1.5K 2026-11-14 18:00 large',
    '-rw------- root    1 2026-11-14 18:00 small',
    'drwxr-x--- root    0 2026-11-14 18:00 sub',
  ])
  // An owner other than user 0 shows as a number, and the column still lines up.
  now(k.system.kernel.vfs.chown('/tmp/d/small', '/', ROOT_CRED, 7, 7))
  assert.deepEqual(k.sh('ls -l d'), [
    '-rwxr-xr-x root 1500 2026-11-14 18:00 large',
    '-rw------- 7       1 2026-11-14 18:00 small',
    'drwxr-x--- root    0 2026-11-14 18:00 sub',
  ])
  assert.deepEqual(k.sh('ls -lF d'), [
    '-rwxr-xr-x root 1500 2026-11-14 18:00 large*',
    '-rw------- 7       1 2026-11-14 18:00 small',
    'drwxr-x--- root    0 2026-11-14 18:00 sub/',
  ])
  assert.deepEqual(k.sh('ls -la d/sub'), ['drwxr-x--- root 0 2026-11-14 18:00 .', 'drwxr-xr-x root 0 2026-11-14 18:00 ..'])
  assert.deepEqual(k.sh('ls -l d/large'), ['-rwxr-xr-x root 1500 2026-11-14 18:00 d/large'])
  assert.deepEqual(k.sh('ls -ld d/sub /tmp'), ['drwxrwxrwt root 0 2026-11-14 18:00 /tmp', 'drwxr-x--- root 0 2026-11-14 18:00 d/sub'])
  assert.deepEqual(k.sh('ls -l /dev/null /etc/hostname'), [
    'crw-rw-rw- root  0 2026-11-14 18:00 /dev/null', '-rw-r--r-- root 13 2026-11-14 18:00 /etc/hostname',
  ])
  // The long form is the same into a pipe; -1 does not undo it.
  assert.deepEqual(k.sh('ls -l1 d | cat'), k.sh('ls -l d'))
  // A sticky directory the others may not search shows a capital.
  assert.deepEqual(k.sh('chmod 1770 d/sub; ls -ld d/sub'), ['drwxrwx--T root 0 2026-11-14 18:00 d/sub'])
})

test('ls: -d, -F, -S, -t and -r', () => {
  const k = fresh()
  k.sh('mkdir d d/sub')
  k.write('/tmp/d/b', 'bbbb')
  k.tick(60_000)
  k.write('/tmp/d/a', 'aa')
  k.tick(60_000)
  k.write('/tmp/d/c', 'cc')
  k.write('/tmp/d/run', '#!/bin/sh\n')
  k.sh('chmod 700 d/run')
  assert.deepEqual(k.sh('ls -d d d/sub'), ['d  d/sub'])
  assert.deepEqual(k.sh('ls -d'), ['.'])
  assert.deepEqual(k.sh('ls -F d'), ['a  b  c  run*  sub/'])
  assert.deepEqual(k.sh('ls -dF d d/run'), ['d/  d/run*'])
  assert.deepEqual(k.sh('ls -F /dev | cat'), ['full', 'null', 'random', 'tty', 'urandom', 'zero'])
  // Largest first; equal sizes fall back to the name.
  assert.deepEqual(k.sh('ls -S d'), ['run  b  a  c  sub'])
  assert.deepEqual(k.sh('ls -Sr d'), ['sub  c  a  b  run'])
  // Newest first; the two written at the same moment fall back to the name (sub was made first of all).
  assert.deepEqual(k.sh('ls -t d'), ['c  run  a  b  sub'])
  assert.deepEqual(k.sh('ls -tr d'), ['sub  b  a  run  c'])
  assert.deepEqual(k.sh('ls -St d'), k.sh('ls -S d'))
  assert.deepEqual(k.sh('ls -lt d'), [
    '-rw-r--r-- root  2 2026-11-14 18:02 c',
    '-rwx------ root 10 2026-11-14 18:02 run',
    '-rw-r--r-- root  2 2026-11-14 18:01 a',
    '-rw-r--r-- root  4 2026-11-14 18:00 b',
    'drwxr-xr-x root  0 2026-11-14 18:00 sub',
  ])
  // Sizes for people in the long form only: without -l, -h changes nothing.
  assert.deepEqual(k.sh('ls -h d'), ['a  b  c  run  sub'])
})

test('ls: several operands list the files first, then each directory under a heading; -R goes down', () => {
  const k = fresh()
  k.sh('mkdir -p d/sub/deep e')
  for (const path of ['d/f', 'd/sub/g', 'd/sub/deep/h', 'd/.dot', 'top']) k.write(`/tmp/${path}`, '')
  assert.deepEqual(k.sh('ls e top d'), ['top', '', 'd:', 'f  sub', '', 'e:'])
  assert.deepEqual(k.sh('ls d e'), ['d:', 'f  sub', '', 'e:'])
  assert.deepEqual(k.sh('ls -r d e'), ['e:', '', 'd:', 'sub  f'])
  assert.deepEqual(k.sh('ls -R d'), ['d:', 'f  sub', '', 'd/sub:', 'deep  g', '', 'd/sub/deep:', 'h'])
  assert.deepEqual(k.sh('ls -RA d | cat'), ['d:', '.dot', 'f', 'sub', '', 'd/sub:', 'deep', 'g', '', 'd/sub/deep:', 'h'])
  assert.deepEqual(k.sh('ls -Ra e'), ['e:', '.  ..'])
  assert.deepEqual(k.sh('cd d; ls -R; cd ..'), ['.:', 'f  sub', '', './sub:', 'deep  g', '', './sub/deep:', 'h'])
  assert.deepEqual(k.sh('ls -dR d'), ['d'])
})

test('ls: what is not there is reported and the rest still listed, with status 1', () => {
  const k = fresh()
  k.sh('mkdir d')
  k.write('/tmp/d/f', '')
  assert.deepEqual(k.sh('ls nosuch d; echo $?'), ['!ls: nosuch: no such file or directory', 'd:', 'f', '1'])
  assert.deepEqual(k.sh('ls d/f nosuch; echo $?'), ['!ls: nosuch: no such file or directory', 'd/f', '1'])
  assert.deepEqual(k.sh('ls nosuch; echo $?'), ['!ls: nosuch: no such file or directory', '1'])
  assert.deepEqual(k.sh('ls d/f/x; echo $?'), ['!ls: d/f/x: not a directory', '1'])
  assert.deepEqual(k.sh('ls -l d nosuch other; echo $?'), [
    '!ls: nosuch: no such file or directory', '!ls: other: no such file or directory', 'd:', '-rw-r--r-- root 0 2026-11-14 18:00 f', '1',
  ])
  assert.deepEqual(k.sh('ls d; echo $?'), ['f', '0'])
})

test('ls: a reader that goes away ends a long listing at once', () => {
  const k = fresh()
  k.sh('mkdir big')
  // More names than a pipe holds at once.
  for (let i = 0; i < MANY; i++) k.write(`/tmp/big/a-file-with-quite-a-long-name-${i}`, '')
  for (const line of ['ls big', 'ls -l big', 'ls -R /tmp', 'ls -1a big']) {
    assert.deepEqual(own(k.sh(`${line} | read first; echo done`)), ['done'], line)
  }
  assert.equal(k.sh('ls big | cat').length, MANY)
})

// cat

test('cat: bytes go through unchanged, whatever they are', () => {
  const k = fresh()
  const every = new Uint8Array(768)
  for (let i = 0; i < every.length; i++) every[i] = i & 255
  k.write('/tmp/bin', every)
  assert.deepEqual(k.sh('cat bin > out; echo $?'), ['0'])
  assert.deepEqual(k.bytes('/tmp/out'), every)
  assert.deepEqual(k.sh('cat < bin > out2; cat - < bin > out3; echo $?'), ['0'])
  assert.deepEqual(k.bytes('/tmp/out2'), every)
  assert.deepEqual(k.bytes('/tmp/out3'), every)
  // Larger than one read, and through a pipe.
  const big = noise(300_000)
  k.write('/tmp/big', big)
  assert.deepEqual(k.sh('cat big | cat | cat > bigout; echo $?'), ['0'])
  assert.deepEqual(k.bytes('/tmp/bigout'), big)
  assert.deepEqual(k.sh('cat bin bin big > three; echo $?'), ['0'])
  assert.equal(k.bytes('/tmp/three').length, 768 + 768 + 300_000)
})

test('cat: files in order, - for the input, and text with or without a final line end', () => {
  const k = fresh()
  k.write('/tmp/a', 'one\ntwo')
  k.write('/tmp/b', 'three\n')
  k.write('/tmp/empty', '')
  assert.deepEqual(k.sh('cat b'), ['three'])
  assert.deepEqual(k.sh('cat a b'), ['one', 'twothree'])
  assert.deepEqual(k.sh('cat b a b'), ['three', 'one', 'twothree'])
  assert.deepEqual(k.sh('cat empty; cat empty empty b'), ['three'])
  assert.deepEqual(k.sh('echo typed | cat'), ['typed'])
  assert.deepEqual(k.sh('echo typed | cat b - b'), ['three', 'typed', 'three'])
  assert.deepEqual(k.sh('echo typed | cat - -'), ['typed'])
  assert.deepEqual(k.sh('cat a > out; cat empty >> out; echo $?'), ['0'])
  assert.equal(k.read('/tmp/out'), 'one\ntwo')
  assert.deepEqual(k.sh('cat -- b'), ['three'])
})

test('cat -n: lines numbered, on from one file to the next', () => {
  const k = fresh()
  k.write('/tmp/a', 'one\n\ntwo')
  k.write('/tmp/b', 'three\nfour\n')
  k.write('/tmp/empty', '')
  assert.deepEqual(k.sh('cat -n b'), ['     1  three', '     2  four'])
  k.sh('cat -n a b > out')
  assert.equal(k.read('/tmp/out'), '     1\tone\n     2\t\n     3\ttwothree\n     4\tfour\n')
  k.sh('cat -n b empty b > out')
  assert.equal(k.read('/tmp/out'), '     1\tthree\n     2\tfour\n     3\tthree\n     4\tfour\n')
  assert.deepEqual(k.sh('cat -n empty > out; echo $?'), ['0'])
  assert.equal(k.read('/tmp/out'), '')
  assert.deepEqual(k.sh('echo x | cat -n - b'), ['     1  x', '     2  three', '     3  four'])
  // A very long line is one line, and bytes that are no text keep their values.
  k.write('/tmp/long', `${'x'.repeat(300_000)}\nend\n`)
  k.sh('cat -n long > out')
  assert.equal(k.read('/tmp/out'), `     1\t${'x'.repeat(300_000)}\n     2\tend\n`)
  k.write('/tmp/bin', new Uint8Array([255, 0, 10, 200, 10]))
  k.sh('cat -n bin > out')
  assert.deepEqual([...k.bytes('/tmp/out')], [32, 32, 32, 32, 32, 49, 9, 255, 0, 10, 32, 32, 32, 32, 32, 50, 9, 200, 10])
  // A line that runs across several reads is numbered once, and the count goes on after it.
  const [w, y] = ['w'.repeat(200_000), 'y'.repeat(70_000)]
  k.write('/tmp/wide', `${w}\nx\n${y}`)
  k.sh('cat -n wide wide > out')
  assert.equal(k.read('/tmp/out'), `     1\t${w}\n     2\tx\n     3\t${y}${w}\n     4\tx\n     5\t${y}`)
})

test('cat -n: more than 999999 lines widen the number instead of cutting it', () => {
  const k = boot(FILE_PROGRAMS, { tmpBytes: 16 << 20 })
  k.write('/tmp/many', '\n'.repeat(1_000_001))
  assert.deepEqual(k.sh('cat -n /tmp/many > /tmp/out; echo $?'), ['0'])
  const out = k.read('/tmp/out')
  assert.ok(out.startsWith('     1\t\n     2\t\n'))
  assert.ok(out.endsWith('\n999999\t\n1000000\t\n1000001\t\n'))
  assert.equal(out.length, 999_999 * 8 + 2 * 9)
})

test('cat: a missing file or a directory is reported and the rest still printed, with status 1', () => {
  const k = fresh()
  k.write('/tmp/b', 'three\n')
  assert.deepEqual(k.sh('cat nosuch b; echo $?'), ['!cat: nosuch: no such file or directory', 'three', '1'])
  assert.deepEqual(k.sh('cat b /tmp b; echo $?'), ['three', '!cat: /tmp: is a directory', 'three', '1'])
  assert.deepEqual(k.sh('cat b/x; echo $?'), ['!cat: b/x: not a directory', '1'])
  assert.deepEqual(k.sh('cat b; echo $?'), ['three', '0'])
  assert.deepEqual(k.sh('cat -x b; echo $?'), ["!cat: unknown option '-x'", '!usage: cat [-n] [file ...]', '2'])
  assert.deepEqual(k.sh('cat -n nosuch b /tmp b; echo $?'), [
    '!cat: nosuch: no such file or directory', '     1  three', '!cat: /tmp: is a directory', '     2  three', '1',
  ])
})

test('cat: reads what is typed until the input ends, and stops when its reader goes', () => {
  const k = fresh()
  assert.deepEqual(k.sh('cat -n'), [])
  assert.deepEqual(k.sh('typed'), ['     1  typed'])
  assert.deepEqual(k.sh('again'), ['     2  again'])
  k.system.end()
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(k.sh('echo back'), ['back'])
  // /dev/zero never ends: only the closed pipe stops this.
  assert.deepEqual(own(k.sh('cat /dev/zero | true; echo done')), ['done'])
  assert.deepEqual(own(k.sh('cat -n /dev/zero | true; echo done')), ['done'])
  // A reader that takes one line of a large file and goes.
  k.write('/tmp/big', 'first\n'.repeat(100_000))
  assert.deepEqual(own(k.sh('cat big | { read x; echo $x; }; cat -n big big | { read n x; echo $n $x; }')), ['first', '1 first'])
})

// mkdir, rmdir

test('mkdir: makes directories; -p makes the ones above and does not mind one that is there', () => {
  const k = fresh()
  assert.deepEqual(k.sh('mkdir a a/b; echo $?'), ['0'])
  assert.deepEqual(k.sh('ls -ld a a/b'), ['drwxr-xr-x root 0 2026-11-14 18:00 a', 'drwxr-xr-x root 0 2026-11-14 18:00 a/b'])
  assert.deepEqual(k.sh('mkdir a; echo $?'), ['!mkdir: a: file exists', '1'])
  assert.deepEqual(k.sh('mkdir x/y; echo $?'), ['!mkdir: x/y: no such file or directory', '1'])
  assert.deepEqual(k.sh('mkdir a c x/y d; echo $?; ls'), ['!mkdir: a: file exists', '!mkdir: x/y: no such file or directory', '1', 'a  c  d'])
  assert.deepEqual(k.sh('mkdir -p x/y/z a x/y; echo $?'), ['0'])
  assert.deepEqual(k.sh('find x'), ['x', 'x/y', 'x/y/z'])
  assert.deepEqual(k.sh('mkdir -p /tmp/abs/one/ ./rel//two/. ; echo $?; ls -d abs/one rel/two'), ['0', 'abs/one  rel/two'])
  k.write('/tmp/file', '')
  assert.deepEqual(k.sh('mkdir -p file; echo $?'), ['!mkdir: file: file exists', '1'])
  assert.deepEqual(k.sh('mkdir -p file/sub; echo $?'), ['!mkdir: file/sub: not a directory', '1'])
  assert.deepEqual(k.sh('mkdir file/sub; echo $?'), ['!mkdir: file/sub: not a directory', '1'])
  assert.deepEqual(k.sh('mkdir -p /; echo $?'), ['0'])
  assert.deepEqual(k.sh('mkdir /; echo $?'), ['!mkdir: /: file exists', '1'])
  assert.deepEqual(k.sh('mkdir /bin/new /proc/new; echo $?'), [
    '!mkdir: /bin/new: read-only file system', '!mkdir: /proc/new: nothing can be made in a generated tree', '1',
  ])
})

test('mkdir: the mask holds permissions back, and -m sets them exactly', () => {
  const k = fresh()
  assert.deepEqual(k.sh('umask 027; mkdir masked; umask 022; ls -ld masked'), ['drwxr-x--- root 0 2026-11-14 18:00 masked'])
  k.sh('mkdir -m 700 m1; mkdir -m u=rwx,g=rx,o= m2; mkdir -m 1777 m3; mkdir -m a-w m4; mkdir -m go-rwx,u-w m5')
  assert.deepEqual(k.sh('ls -ld m1 m2 m3 m4 m5'), [
    'drwx------ root 0 2026-11-14 18:00 m1',
    'drwxr-x--- root 0 2026-11-14 18:00 m2',
    'drwxrwxrwt root 0 2026-11-14 18:00 m3',
    'dr-xr-xr-x root 0 2026-11-14 18:00 m4',
    'dr-x------ root 0 2026-11-14 18:00 m5',
  ])
  // -m is exact whatever the mask; with -p it is for the last directory only.
  assert.deepEqual(k.sh('umask 077; mkdir -m 755 open; mkdir -p -m 711 p/q; umask 022; ls -ld open p p/q'), [
    'drwxr-xr-x root 0 2026-11-14 18:00 open',
    'drwx------ root 0 2026-11-14 18:00 p',
    'drwx--x--x root 0 2026-11-14 18:00 p/q',
  ])
  // A path that ends in a dot names the directory before it: the mode is for that one.
  assert.deepEqual(k.sh('mkdir -p -m 700 dot/end/. dot/slash/; ls -ld dot dot/end dot/slash'), [
    'drwxr-xr-x root 0 2026-11-14 18:00 dot',
    'drwx------ root 0 2026-11-14 18:00 dot/end',
    'drwx------ root 0 2026-11-14 18:00 dot/slash',
  ])
  // One that is already there keeps the mode it has.
  assert.deepEqual(k.sh('mkdir -p -m 777 dot/end; echo $?; ls -ld dot/end'), ['0', 'drwx------ root 0 2026-11-14 18:00 dot/end'])
  // A directory made on the way lets its owner go on into it even when the mask would not.
  assert.deepEqual(k.sh('umask 0333; mkdir -p u/v; umask 022; ls -ld u u/v'), [
    'drwxr--r-- root 0 2026-11-14 18:00 u', 'dr--r--r-- root 0 2026-11-14 18:00 u/v',
  ])
  assert.deepEqual(k.sh('mkdir -m rwx bad; echo $?; ls -d bad'), [
    "!mkdir: invalid mode 'rwx'", '!usage: mkdir [-p] [-m mode] dir ...', '2', '!ls: bad: no such file or directory',
  ])
  assert.deepEqual(k.sh('mkdir -m 2755 bad; echo $?'), ["!mkdir: invalid mode '2755'", '!usage: mkdir [-p] [-m mode] dir ...', '2'])
})

test('rmdir: removes empty directories only; -p goes on up', () => {
  const k = fresh()
  k.sh('mkdir -p a/b/c d e r/s/t')
  k.write('/tmp/a/b/c/f', '')
  k.write('/tmp/file', '')
  assert.deepEqual(k.sh('rmdir d e; echo $?; ls'), ['0', 'a  file  r'])
  assert.deepEqual(k.sh('rmdir a/b/c; echo $?'), ['!rmdir: a/b/c: directory not empty', '1'])
  assert.deepEqual(k.sh('rmdir file nosuch; echo $?'), ['!rmdir: file: not a directory', '!rmdir: nosuch: no such file or directory', '1'])
  assert.deepEqual(k.sh('rmdir /tmp / /bin/x; echo $?'), [
    '!rmdir: /tmp: a mount point', '!rmdir: /: the root directory', '!rmdir: /bin/x: no such file or directory', '1',
  ])
  assert.deepEqual(k.sh('rmdir -p r/s/t; echo $?; ls'), ['0', 'a  file'])
  // -p stops at the first directory that still holds something, and names it.
  k.sh('mkdir -p a/x/y')
  assert.deepEqual(k.sh('rmdir -p a/x/y; echo $?; ls a'), ['!rmdir: a: directory not empty', '1', 'b'])
  assert.deepEqual(k.sh('mkdir -p /tmp/q/w; rmdir -p /tmp/q/w; echo $?'), ['!rmdir: /tmp: a mount point', '1'])
  assert.ok(!k.exists('/tmp/q'))
  // A dot or a doubled slash in the path names nothing more to remove.
  assert.deepEqual(k.sh('rm -r a; mkdir -p m/n/o p/q/r; rmdir -p m/./n//o ./p/q/r/; echo $?; ls'), ['0', 'file'])
  assert.deepEqual(k.sh('rmdir -p .; rmdir -x d; echo $?'), ["!rmdir: .: refusing to remove '.' or '..'", "!rmdir: unknown option '-x'", '!usage: rmdir [-p] dir ...', '2'])
})

test('rmdir: a path that ends in . or .. is refused, so the directory you are in is never removed by it', () => {
  const k = fresh()
  k.sh('mkdir -p w/b s/t')
  // Each of these once removed the directory the shell was in (-p climbed through the `..` it was given).
  assert.deepEqual(k.sh('cd w/b; rmdir .; echo $?; cd /tmp/w; rmdir -p nosuch/../b; echo $?; cd /tmp'), [
    "!rmdir: .: refusing to remove '.' or '..'", '1', "!rmdir: nosuch/..: refusing to remove '.' or '..'", '1',
  ])
  assert.ok(k.exists('/tmp/w') && !k.exists('/tmp/w/b'))
  assert.deepEqual(k.sh('rmdir s/t/. w/..; echo $?; ls'), ["!rmdir: s/t/.: refusing to remove '.' or '..'", "!rmdir: w/..: refusing to remove '.' or '..'", '1', 's  w'])
  assert.deepEqual(k.sh('rmdir -p s/t w; echo $?; ls -a'), ['0', '.  ..'])
})

// rm

test('rm: removes files; a directory only with -r, and then everything in it', () => {
  const k = fresh()
  k.sh('mkdir -p d/sub/deep e')
  for (const path of ['f', 'g', 'd/a', 'd/.hid', 'd/sub/b', 'd/sub/deep/c']) k.write(`/tmp/${path}`, 'x')
  assert.deepEqual(k.sh('rm f; echo $?; ls'), ['0', 'd  e  g'])
  assert.deepEqual(k.sh('rm d; echo $?'), ['!rm: d: is a directory', '1'])
  assert.deepEqual(k.sh('rm e; echo $?'), ['!rm: e: is a directory', '1'])
  assert.deepEqual(k.sh('rm nosuch g d; echo $?; ls'), ['!rm: nosuch: no such file or directory', '!rm: d: is a directory', '1', 'd  e'])
  assert.deepEqual(k.sh('rm -r d e; echo $?; ls -a'), ['0', '.  ..'])
  k.sh('mkdir -p d/sub; echo x > d/sub/f')
  assert.deepEqual(k.sh('rm -R d; echo $?; ls'), ['0'])
  k.sh('mkdir -p d/sub; echo x > d/f')
  assert.deepEqual(k.sh('rm -r d/f d/sub/; echo $?; ls d'), ['0'])
  assert.deepEqual(k.sh('rm d/f/x; echo $?'), ['!rm: d/f/x: no such file or directory', '1'])
  // A name that ends in a slash is a directory's: the file system finds the file by it, but rm does not remove it.
  k.write('/tmp/notes', 'kept')
  assert.deepEqual(k.sh('rm notes/; rm -f notes/; rm -rf notes//; echo $?'), [
    '!rm: notes/: not a directory', '!rm: notes/: not a directory', '!rm: notes//: not a directory', '1',
  ])
  assert.equal(k.read('/tmp/notes'), 'kept')
})

test('rm -f: quiet about what is not there, and never a failure for it', () => {
  const k = fresh()
  k.write('/tmp/f', '')
  assert.deepEqual(k.sh('rm -f nosuch; echo $?'), ['0'])
  assert.deepEqual(k.sh('rm -f; echo $?'), ['0'])
  assert.deepEqual(k.sh('rm -rf nosuch f f/x also; echo $?; ls'), ['0'])
  assert.deepEqual(k.sh('rm; echo $?'), ['!usage: rm [-r] [-f] path ...', '2'])
  assert.deepEqual(k.sh('rm -r; echo $?'), ['!usage: rm [-r] [-f] path ...', '2'])
  // -f does not hide a refusal that is about something else.
  k.sh('mkdir d')
  assert.deepEqual(k.sh('rm -f d /bin/ls; echo $?'), ['!rm: d: is a directory', '!rm: /bin/ls: read-only file system', '1'])
})

test('rm: never the root, never . or .., and what the file system refuses is said', () => {
  const k = fresh()
  k.sh('mkdir -p d/sub')
  k.write('/tmp/d/sub/f', 'x')
  assert.deepEqual(k.sh('rm /; rm -rf /; rm -r //; echo $?'), [
    '!rm: /: refusing to remove the root directory', '!rm: /: refusing to remove the root directory', '!rm: //: refusing to remove the root directory', '1',
  ])
  assert.deepEqual(k.sh('rm -rf .. /tmp/..; echo $?'), [
    '!rm: ..: refusing to remove the root directory', '!rm: /tmp/..: refusing to remove the root directory', '1',
  ])
  assert.deepEqual(k.sh("rm -rf . d/.. d/sub/.; echo $?"), [
    "!rm: .: refusing to remove '.' or '..'", "!rm: d/..: refusing to remove '.' or '..'", "!rm: d/sub/.: refusing to remove '.' or '..'", '1',
  ])
  assert.ok(k.exists('/tmp/d/sub/f') && k.exists('/home/operator/README') && k.exists('/etc/hostname'))
  assert.deepEqual(k.sh('rm /bin/ls /proc/version /dev/null; echo $?'), [
    '!rm: /bin/ls: read-only file system', '!rm: /proc/version: nothing can be removed from a generated tree',
    '!rm: /dev/null: nothing can be removed from a generated tree', '1',
  ])
  // A read-only tree: each file is refused once, and the directories above are not blamed again.
  const out = k.sh('rm -r /bin; echo $?')
  assert.equal(out.length, NAMES.length + 2)
  assert.ok(out.includes('!rm: /bin/ls: read-only file system') && out.includes('!rm: /bin/sh: read-only file system'))
  assert.equal(out[out.length - 1], '1')
  assert.equal(k.sh('ls /bin | cat').length, NAMES.length + 1)
  // A mount point is busy: what is in it goes, the place itself stays, and that is said.
  assert.deepEqual(k.sh('cd /; rm -r /tmp; echo $?; ls -a /tmp'), ['!rm: /tmp: a mount point', '1', '.  ..'])
  assert.deepEqual(k.sh('rm /tmp; echo $?'), ['!rm: /tmp: is a directory', '1'])
})

// cp

test('cp: a file to a new name, over a file, and several into a directory', () => {
  const k = fresh()
  k.write('/tmp/a', 'alpha\n')
  k.write('/tmp/b', 'beta\n')
  k.sh('mkdir d')
  assert.deepEqual(k.sh('cp a c; echo $?; cat c'), ['0', 'alpha'])
  assert.deepEqual(k.sh('cp b c; echo $?; cat c a'), ['0', 'beta', 'alpha'])
  assert.deepEqual(k.sh('cp a b d; echo $?; ls d; cat d/a d/b'), ['0', 'a  b', 'alpha', 'beta'])
  assert.deepEqual(k.sh('cp /tmp/a d/; cp a d/named; ls d'), ['a  b  named'])
  assert.deepEqual(k.sh('cp d/named /etc/hostname .; echo $?; ls'), ['0', 'a  b  c  d  hostname  named'])
  // An empty file, and a file with no final line end.
  k.write('/tmp/empty', '')
  k.write('/tmp/cut', 'no end')
  assert.deepEqual(k.sh('cp empty e2; cp cut c2; echo $?'), ['0'])
  assert.equal(k.read('/tmp/e2'), '')
  assert.equal(k.read('/tmp/c2'), 'no end')
  // A shorter file written over a longer one leaves nothing of the longer.
  assert.deepEqual(k.sh('cp cut a; echo $?'), ['0'])
  assert.equal(k.read('/tmp/a'), 'no end')
})

test('cp: bytes are copied exactly, a piece at a time, however large', () => {
  const k = fresh()
  const big = noise(700_001)
  k.write('/tmp/big', big)
  assert.deepEqual(k.sh('cp big copy; echo $?'), ['0'])
  assert.deepEqual(k.bytes('/tmp/copy'), big)
  // From the disk to /tmp and back: two file systems.
  assert.deepEqual(k.sh('cp big /home/operator/big; cp /home/operator/big back; echo $?'), ['0'])
  assert.deepEqual(k.bytes('/tmp/back'), big)
  // A generated file has no size until it is read: it is copied all the same.
  assert.deepEqual(k.sh('cp /proc/mounts m; echo $?'), ['0'])
  assert.equal(k.read('/tmp/m'), k.sh('mount').map((l) => `${l}\n`).join(''))
})

test('cp: a full file system is reported, and so is every other refusal, with status 1', () => {
  const k = boot(FILE_PROGRAMS, { tmpBytes: 200_000 })
  k.sh('cd /tmp')
  const big = noise(150_000)
  k.write('/home/operator/big', big)
  k.write('/home/operator/huge', noise(300_000))
  k.write('/tmp/half', noise(100_000))
  // Room for the first piece and not for the second: the copy stops there, says so, and what was written stays.
  assert.deepEqual(k.sh('cp /home/operator/big part; echo $?'), ['!cp: part: no space left on device', '1'])
  assert.deepEqual(k.bytes('/tmp/part'), big.subarray(0, 65536))
  // A device that never ends is copied until there is no room.
  assert.deepEqual(k.sh('rm part; cp /dev/zero z; echo $?'), ['!cp: z: no space left on device', '1'])
  assert.deepEqual(k.bytes('/tmp/z'), new Uint8Array(65536))
  // A file longer than any file there may be.
  assert.deepEqual(k.sh('rm z half; cp /home/operator/huge toolarge; echo $?; rm toolarge'), ['!cp: toolarge: file too large', '1'])
  k.write('/tmp/a', 'alpha\n')
  k.sh('mkdir d')
  assert.deepEqual(k.sh('cp nosuch a d; echo $?; ls d'), ['!cp: nosuch: no such file or directory', '1', 'a'])
  assert.deepEqual(k.sh('cp a a; echo $?'), ['!cp: a: is the same file as a', '1'])
  assert.deepEqual(k.sh('cp a ./a; cp d/a d; echo $?'), ['!cp: a: is the same file as ./a', '!cp: d/a: is the same file as d/a', '1'])
  assert.equal(k.read('/tmp/a'), 'alpha\n')
  assert.deepEqual(k.sh('cp a d nosuchdir; echo $?'), ['!cp: nosuchdir: not a directory', '1'])
  assert.deepEqual(k.sh('cp a d a; echo $?'), ['!cp: a: not a directory', '1'])
  assert.deepEqual(k.sh('cp a nosuchdir/; echo $?'), ['!cp: nosuchdir/: not a directory', '1'])
  // A name that ends in a slash is a directory's: a file that is there is not written over under it.
  k.write('/tmp/plain', 'kept')
  assert.deepEqual(k.sh('cp a plain/; echo $?; cat plain'), ['!cp: plain/: not a directory', '1', 'kept'])
  assert.deepEqual(k.sh('cp a nosuchdir/x; echo $?'), ['!cp: nosuchdir/x: no such file or directory', '1'])
  assert.deepEqual(k.sh('cp d a2; echo $?'), ['!cp: d: is a directory (use -r to copy it)', '1'])
  assert.deepEqual(k.sh('cp a /bin/new; cp a /bin/ls; echo $?'), ['!cp: /bin/new: read-only file system', '!cp: /bin/ls: read-only file system', '1'])
  assert.deepEqual(k.sh('mkdir d/sub; cp a d/sub d/a2; echo $?'), ['!cp: d/a2: not a directory', '1'])
  k.sh('mkdir d/a3; cp a d/a3')
  assert.deepEqual(k.sh('mkdir e; mkdir e/a; cp a e; echo $?'), ['!cp: e/a: is a directory', '1'])
  assert.deepEqual(k.sh('cp; cp a; echo $?'), ['!usage: cp [-r] source ... destination', '!usage: cp [-r] source ... destination', '2'])
  assert.deepEqual(k.sh('cp a /dev/null; echo $?'), ['0'])
})

test('cp: a new copy has the mode of its original, less what the mask holds back; a file that was there keeps its own', () => {
  const k = fresh()
  k.write('/tmp/a', 'x')
  k.sh('chmod 640 a; cp a b; chmod 666 a; cp a c; chmod 755 a; cp a d; umask 077; cp a e; umask 0; chmod 1777 a; cp a f; umask 022; chmod 600 a; cp a d')
  assert.deepEqual(k.sh('ls -l'), [
    '-rw------- root 1 2026-11-14 18:00 a',
    '-rw-r----- root 1 2026-11-14 18:00 b',
    '-rw-r--r-- root 1 2026-11-14 18:00 c',
    '-rwxr-xr-x root 1 2026-11-14 18:00 d',
    '-rwx------ root 1 2026-11-14 18:00 e',
    '-rwxrwxrwx root 1 2026-11-14 18:00 f',
  ])
  // A file nobody may write is copied all the same, and the copy is as closed as it was.
  assert.deepEqual(k.sh('chmod 400 a; cp a g; echo $?; ls -l g; cat g'), ['0', '-r-------- root 1 2026-11-14 18:00 g', 'x'])
  // The copy is new: it belongs to whoever made it, and its time is the present one.
  now(k.system.kernel.vfs.chown('/tmp/a', '/', ROOT_CRED, 7, 7))
  k.tick(3 * 60_000)
  assert.deepEqual(k.sh('cp a late; ls -l a late'), ['-r-------- 7    1 2026-11-14 18:00 a', '-r-------- root 1 2026-11-14 18:03 late'])
  // Written over, a file keeps its own mode and owner, and takes the bytes and the present time.
  k.write('/tmp/b', 'longer than x')
  k.tick(60_000)
  assert.deepEqual(k.sh('cp b a; echo $?; ls -l a; cat a'), ['0', '-r-------- 7 13 2026-11-14 18:04 a', 'longer than x'])
})

test('cp -r: a directory with all below it, into a new name or into a directory that is there', () => {
  const k = fresh()
  k.sh('mkdir -p src/sub/deep src/none dst')
  k.write('/tmp/src/f', 'eff\n')
  k.write('/tmp/src/.hid', 'dot\n')
  k.write('/tmp/src/sub/g', noise(100_000))
  k.write('/tmp/src/sub/deep/h', '')
  k.sh('chmod 750 src/sub; chmod 600 src/f; chmod 555 src/none')
  const tree = ['src', 'src/.hid', 'src/f', 'src/none', 'src/sub', 'src/sub/deep', 'src/sub/deep/h', 'src/sub/g']
  assert.deepEqual(k.sh('find src'), tree)
  assert.deepEqual(k.sh('cp -r src new; echo $?; find new'), ['0', ...tree.map((p) => p.replace('src', 'new'))])
  assert.deepEqual(k.bytes('/tmp/new/sub/g'), noise(100_000))
  assert.equal(k.read('/tmp/new/.hid'), 'dot\n')
  assert.deepEqual(k.sh('ls -ld new/sub new/f new/none new'), [
    'drwxr-xr-x root 0 2026-11-14 18:00 new',
    '-rw------- root 4 2026-11-14 18:00 new/f',
    'dr-xr-xr-x root 0 2026-11-14 18:00 new/none',
    'drwxr-x--- root 0 2026-11-14 18:00 new/sub',
  ])
  // Into a directory that is there, the copy takes its own name inside it; -R is the same as -r.
  assert.deepEqual(k.sh('cp -R src dst; echo $?; find dst -maxdepth 2'), ['0', 'dst', 'dst/src', 'dst/src/.hid', 'dst/src/f', 'dst/src/none', 'dst/src/sub'])
  // A second copy over the first merges into it.
  k.write('/tmp/new/extra', '')
  assert.deepEqual(k.sh('cp -r src/. new; echo $?; ls -A new'), ['0', '.hid  extra  f  none  sub'])
  // A source that ends in a dot gives what it holds.
  assert.deepEqual(k.sh('mkdir flat; cp -r src/. flat; ls -A flat'), ['.hid  f  none  sub'])
  assert.deepEqual(k.sh('mkdir flat2; cd src; cp -r . ../flat2; cd ..; ls -A flat2'), ['.hid  f  none  sub'])
  // Files and directories together.
  assert.deepEqual(k.sh('mkdir mix; cp -r src/f src/sub mix; echo $?; find mix'), [
    '0', 'mix', 'mix/f', 'mix/sub', 'mix/sub/deep', 'mix/sub/deep/h', 'mix/sub/g',
  ])
  // New directories are held back by the mask as new files are, and the sticky mark is not copied.
  k.sh('chmod 1777 src/sub/deep; umask 027; cp -r src masked; umask 022')
  assert.deepEqual(k.sh('ls -ld masked masked/f masked/none masked/sub masked/sub/deep masked/sub/deep/h'), [
    'drwxr-x--- root 0 2026-11-14 18:00 masked',
    '-rw------- root 4 2026-11-14 18:00 masked/f',
    'dr-xr-x--- root 0 2026-11-14 18:00 masked/none',
    'drwxr-x--- root 0 2026-11-14 18:00 masked/sub',
    'drwxr-x--- root 0 2026-11-14 18:00 masked/sub/deep',
    '-rw-r----- root 0 2026-11-14 18:00 masked/sub/deep/h',
  ])
})

test('cp -r: never into itself, never a device, and the rest of a tree still copied', () => {
  const k = fresh()
  k.sh('mkdir -p a/b')
  k.write('/tmp/a/f', 'x')
  assert.deepEqual(k.sh('cp -r a a/in; echo $?'), ['!cp: a: cannot copy a directory into itself (a/in)', '1'])
  assert.deepEqual(k.sh('cp -r a a; echo $?'), ['!cp: a: cannot copy a directory into itself (a/a)', '1'])
  assert.deepEqual(k.sh('cp -r a a/b; echo $?'), ['!cp: a: cannot copy a directory into itself (a/b/a)', '1'])
  assert.deepEqual(k.sh('cp -r a/. a; cp -r . a/b/c; echo $?'), [
    '!cp: a/.: cannot copy a directory into itself (a)', '!cp: .: cannot copy a directory into itself (a/b/c)', '1',
  ])
  assert.deepEqual(k.sh('cp -r / /tmp/all; echo $?'), ['!cp: /: cannot copy a directory into itself (/tmp/all)', '1'])
  assert.deepEqual(k.sh('find a'), ['a', 'a/b', 'a/f'])
  assert.deepEqual(k.sh('cp -r a ab; echo $?; find ab'), ['0', 'ab', 'ab/b', 'ab/f'])
  // /dev holds only devices: the directory is made, each device is named, nothing is read from them.
  const out = k.sh('cp -r /dev devs; echo $?')
  assert.deepEqual(out, ['full', 'null', 'random', 'tty', 'urandom', 'zero'].map((n) => `!cp: /dev/${n}: a device is not copied`).concat(['1']))
  assert.deepEqual(k.sh('ls -a devs'), ['.  ..'])
  // A directory where a file is: reported, and the other names still copied.
  k.sh('mkdir -p into/f')
  assert.deepEqual(k.sh('cp -r a/. into; echo $?; find into'), ['!cp: into/f: is a directory', '1', 'into', 'into/b', 'into/f'])
  k.write('/tmp/plain', '')
  assert.deepEqual(k.sh('cp -r a plain; echo $?'), ['!cp: plain: not a directory', '1'])
  assert.deepEqual(k.sh('cp -r a /bin/a; echo $?'), ['!cp: /bin/a: read-only file system', '1'])
  assert.deepEqual(k.sh('cp -r nosuch a2; echo $?'), ['!cp: nosuch: no such file or directory', '1'])
  // A tree of generated files copies as plain files.
  assert.deepEqual(k.sh('cp -r /sys/kernel k; echo $?; cat k/hostname; ls -l k/hostname'), [
    '0', 'crimson-noir', '-r--r--r-- root 13 2026-11-14 18:00 k/hostname',
  ])
})

// mv

test('mv: a new name, over a file, and into a directory', () => {
  const k = fresh()
  k.write('/tmp/a', 'alpha\n')
  k.write('/tmp/b', 'beta\n')
  k.sh('mkdir d e')
  assert.deepEqual(k.sh('mv a c; echo $?; ls; cat c'), ['0', 'b  c  d  e', 'alpha'])
  assert.deepEqual(k.sh('mv c b; echo $?; ls; cat b'), ['0', 'b  d  e', 'alpha'])
  assert.deepEqual(k.sh('mv b d; echo $?; ls d'), ['0', 'b'])
  assert.deepEqual(k.sh('mv d/b d/renamed; mv d e; echo $?; find e'), ['0', 'e', 'e/d', 'e/d/renamed'])
  k.write('/tmp/x', 'x')
  k.write('/tmp/y', 'y')
  // Onto itself: nothing changes, and that is no failure.
  assert.deepEqual(k.sh('mv x y e/d e/; echo $?'), ['0'])
  assert.deepEqual(k.sh('ls e; find e/d'), ['d  x  y', 'e/d', 'e/d/renamed'])
  assert.deepEqual(k.sh('mv e/x e/x; mv e/x e; mv e/x ./e/../e/x; echo $?; cat e/x'), ['0', 'x'])
  // A directory takes the place of an empty directory, never of one that holds something.
  k.sh('mkdir -p full/in hollow fresh/in2')
  assert.deepEqual(k.sh('mv fresh hollow; echo $?; find hollow'), ['0', 'hollow', 'hollow/fresh', 'hollow/fresh/in2'])
  assert.deepEqual(k.sh('mkdir -p one/full/a full/b; mv full one; echo $?'), ['!mv: one/full: directory not empty', '1'])
  // The mode and the time move with the file.
  k.write('/tmp/timed', 't')
  k.sh('chmod 640 timed')
  k.tick(5 * 60_000)
  assert.deepEqual(k.sh('mv timed kept; ls -l kept'), ['-rw-r----- root 1 2026-11-14 18:00 kept'])
})

test('mv: refusals are reported against the path they are about, with status 1', () => {
  const k = fresh()
  k.write('/tmp/a', 'alpha\n')
  k.sh('mkdir -p d/sub')
  assert.deepEqual(k.sh('mv nosuch x; echo $?'), ['!mv: nosuch: no such file or directory', '1'])
  assert.deepEqual(k.sh('mv a nodir/x; echo $?'), ['!mv: nodir/x: no such file or directory', '1'])
  assert.deepEqual(k.sh('mv nosuch a d; echo $?; ls d'), ['!mv: nosuch: no such file or directory', '1', 'a  sub'])
  assert.deepEqual(k.sh('mv d/a d nosuchdir; echo $?'), ['!mv: nosuchdir: not a directory', '1'])
  assert.deepEqual(k.sh('mv d d/sub/x; echo $?'), ['!mv: d: a directory cannot move into itself', '1'])
  assert.deepEqual(k.sh('mv d d; echo $?'), ['!mv: d: a directory cannot move into itself', '1'])
  assert.deepEqual(k.sh('mv d d/a; echo $?'), ['!mv: d: a directory cannot move into itself', '1'])
  k.write('/tmp/plain', '')
  assert.deepEqual(k.sh('mv d plain; echo $?'), ['!mv: plain: not a directory', '1'])
  assert.deepEqual(k.sh('mkdir -p e/plain; mv plain e; echo $?'), ['!mv: e/plain: is a directory', '1'])
  assert.deepEqual(k.sh("mv . x; mv .. x; mv d/. x; echo $?"), [
    "!mv: .: cannot move '.' or '..'", "!mv: ..: cannot move '.' or '..'", "!mv: d/.: cannot move '.' or '..'", '1',
  ])
  assert.deepEqual(k.sh('mv / x; mv /tmp /home/t; mv /proc p; mv /bin/ls /bin/ls2; mv /bin/ls here; echo $?'), [
    '!mv: /: the root directory', '!mv: /tmp: a mount point', '!mv: /proc: a mount point', '!mv: /bin/ls: read-only file system',
    '!mv: /bin/ls: read-only file system', '1',
  ])
  assert.deepEqual(k.sh('mv /dev/null n; mv /proc/version v; echo $?'), [
    '!mv: /dev/null: a device cannot be moved', '!mv: /proc/version: nothing can be removed from a generated tree', '1',
  ])
  assert.deepEqual(k.sh('mv /usr/share s; mv /usr/share /usr/apps /home/operator; echo $?'), [
    '!mv: /usr/share: read-only file system', '!mv: /usr/share: read-only file system', '!mv: /usr/apps: read-only file system', '1',
  ])
  // A source that cannot be removed is not copied first: a refused move leaves nothing new behind.
  assert.deepEqual(k.sh('ls; ls /home/operator'), ['d  e  plain', 'README'])
  // A name that ends in a slash is a directory's: a file is not given it, a directory is.
  assert.deepEqual(k.sh('mv d/a new/; mv d/a plain/; mv nosuch new/; echo $?'), [
    '!mv: new/: not a directory', '!mv: plain/: not a directory', '!mv: nosuch: no such file or directory', '1',
  ])
  assert.deepEqual(k.sh('mv d/sub new/; echo $?; ls -d new d/sub'), ['0', '!ls: d/sub: no such file or directory', 'new'])
  assert.deepEqual(k.sh('mv; mv a; echo $?'), ['!usage: mv source ... destination', '!usage: mv source ... destination', '2'])
  assert.deepEqual(k.sh('mv -f d/a b; echo $?'), ["!mv: unknown option '-f'", '!usage: mv source ... destination', '2'])
  assert.ok(k.exists('/bin/ls') && k.exists('/tmp/d/a') && k.exists('/tmp/new'))
})

test('mv: between two file systems it copies, with mode and time, and then removes', () => {
  const k = fresh()
  const big = noise(200_000)
  k.write('/tmp/big', big)
  k.sh('chmod 640 big; mkdir -p tree/sub/deep; chmod 1750 tree/sub')
  k.write('/tmp/tree/f', 'eff\n')
  k.write('/tmp/tree/sub/deep/g', 'gee\n')
  // Someone else's file and directory: user 0 moves them without making them its own.
  now(k.system.kernel.vfs.chown('/tmp/tree/f', '/', ROOT_CRED, 1000, 50))
  now(k.system.kernel.vfs.chown('/tmp/tree/sub', '/', ROOT_CRED, 1000, 50))
  k.tick(7 * 60_000)
  assert.deepEqual(k.sh('mv big /home/operator/moved; echo $?; ls -l /home/operator/moved; ls'), [
    '0', '-rw-r----- root 200000 2026-11-14 18:00 /home/operator/moved', 'tree',
  ])
  assert.deepEqual(k.bytes('/home/operator/moved'), big)
  assert.deepEqual(k.sh('mv tree /home/operator; echo $?; ls -a; find /home/operator/tree'), [
    '0', '.  ..', '/home/operator/tree', '/home/operator/tree/f', '/home/operator/tree/sub', '/home/operator/tree/sub/deep', '/home/operator/tree/sub/deep/g',
  ])
  assert.deepEqual(k.sh('ls -ld /home/operator/tree/sub /home/operator/tree/f /home/operator/tree/sub/deep/g'), [
    '-rw-r--r-- 1000 4 2026-11-14 18:00 /home/operator/tree/f', 'drwxr-x--T 1000 0 2026-11-14 18:00 /home/operator/tree/sub',
    '-rw-r--r-- root 4 2026-11-14 18:00 /home/operator/tree/sub/deep/g',
  ])
  assert.deepEqual(k.sh('stat /home/operator/tree/f').slice(4, 6), ['owner:  1000', 'group:  50'])
  // And back, over a file that is there and into an empty directory that is there.
  k.write('/tmp/moved', 'old')
  k.sh('chmod 600 moved; mkdir tree')
  assert.deepEqual(k.sh('mv /home/operator/moved /home/operator/tree .; echo $?; ls -l moved; find tree -type f; ls /home/operator'), [
    '0', '-rw-r----- root 200000 2026-11-14 18:00 moved', 'tree/f', 'tree/sub/deep/g', 'README',
  ])
  assert.deepEqual(k.bytes('/tmp/moved'), big)
  // Refused where a rename would be: a directory over one that holds something, a file over a directory.
  k.sh('mkdir -p /home/operator/tree/keep /home/operator/moved')
  assert.deepEqual(k.sh('mv tree moved /home/operator; echo $?'), [
    '!mv: /home/operator/tree: directory not empty', '!mv: /home/operator/moved: is a directory', '1',
  ])
  assert.deepEqual(k.sh('echo f > /home/operator/plain; mv tree /home/operator/plain; echo $?'), ['!mv: /home/operator/plain: not a directory', '1'])
  assert.ok(k.exists('/tmp/tree/sub/deep/g') && k.exists('/tmp/moved'))
})

test('mv: when the copy to another file system fails, the source stays', () => {
  const k = boot(FILE_PROGRAMS, { tmpBytes: 100_000 })
  const big = noise(150_000)
  k.write('/home/operator/big', big)
  k.write('/home/operator/mid', noise(80_000))
  k.sh('mkdir tree; echo small > tree/a; cp big tree/b')
  // A file: nothing new is left where it was to go.
  assert.deepEqual(k.sh('mv big /tmp/big; echo $?; ls -a /tmp'), ['!mv: /tmp/big: file too large', '1', '.  ..'])
  assert.deepEqual(k.bytes('/home/operator/big'), big)
  k.write('/tmp/fill', noise(60_000))
  assert.deepEqual(k.sh('mv mid /tmp; echo $?; ls /tmp'), ['!mv: /tmp/mid: no space left on device', '1', 'fill'])
  assert.equal(k.bytes('/home/operator/mid').length, 80_000)
  // A file that was there already is written over as the copy goes: the page says it is lost even when the move fails.
  k.write('/tmp/old', 'precious\n')
  assert.deepEqual(k.sh('mv mid /tmp/old; echo $?'), ['!mv: /tmp/old: no space left on device', '1'])
  assert.equal(k.bytes('/home/operator/mid').length, 80_000)
  assert.equal(k.read('/tmp/old'), '')
  assert.match(FILE_MANUAL.mv, /already at\n {4}the destination, though, is written over as the copy goes, so it is\n {4}lost even when the move fails/)
  k.sh('rm /tmp/old')
  // A directory: the source stays whole, and what was copied of it stays where it went.
  assert.deepEqual(k.sh('mv tree /tmp; echo $?; find tree /tmp/tree'), [
    '!mv: /tmp/tree/b: no space left on device', '1', 'tree', 'tree/a', 'tree/b', '/tmp/tree', '/tmp/tree/a', '/tmp/tree/b',
  ])
  assert.deepEqual(k.bytes('/home/operator/tree/b'), big)
})

// touch

test('touch: makes an empty file, or sets the time of one that is there to now; -c never makes one', () => {
  const k = fresh()
  k.write('/tmp/old', 'kept')
  k.sh('mkdir dir')
  k.tick(10 * 60_000 + 42_000)
  assert.deepEqual(k.sh('touch new old dir; echo $?'), ['0'])
  assert.deepEqual(k.sh('ls -l'), [
    'drwxr-xr-x root 0 2026-11-14 18:10 dir', '-rw-r--r-- root 0 2026-11-14 18:10 new', '-rw-r--r-- root 4 2026-11-14 18:10 old',
  ])
  assert.equal(k.read('/tmp/old'), 'kept')
  assert.equal(k.sh('stat new old dir | cat').filter((l) => l === 'time:   2026-11-14 18:10:42').length, 3)
  k.tick(60_000)
  assert.deepEqual(k.sh('touch -c nosuch old; echo $?; ls'), ['0', 'dir  new  old'])
  assert.deepEqual(k.sh('ls -l old new'), ['-rw-r--r-- root 0 2026-11-14 18:10 new', '-rw-r--r-- root 4 2026-11-14 18:11 old'])
  assert.deepEqual(k.sh('umask 077; touch private; umask 022; ls -l private'), ['-rw------- root 0 2026-11-14 18:11 private'])
  assert.deepEqual(k.sh('touch nodir/x a /bin/new /bin/ls /proc/version b; echo $?; ls'), [
    '!touch: nodir/x: no such file or directory', '!touch: /bin/new: read-only file system', '!touch: /bin/ls: read-only file system',
    '!touch: /proc/version: a generated file keeps its attributes', '1', 'a  b  dir  new  old  private',
  ])
  assert.deepEqual(k.sh('touch -c nodir/x; echo $?'), ['0'])
  assert.deepEqual(k.sh('touch old/x; echo $?'), ['!touch: old/x: not a directory', '1'])
  assert.deepEqual(k.sh('touch; touch -c; echo $?'), ['!usage: touch [-c] file ...', '!usage: touch [-c] file ...', '2'])
})

// chmod

test('chmod: a mode as a number', () => {
  const k = fresh()
  k.write('/tmp/f', '')
  k.sh('mkdir d')
  const mode = (path: string): string => k.sh(`ls -ld ${path}`)[0].split(' ')[0]
  const numbers = [
    ['600', '-rw-------'], ['0644', '-rw-r--r--'], ['7', '-------rwx'], ['70', '----rwx---'], ['000', '----------'], ['777', '-rwxrwxrwx'],
    ['1755', '-rwxr-xr-t'], ['1000', '---------T'],
  ]
  for (const [text, shown] of numbers) {
    assert.deepEqual(k.sh(`chmod ${text} f; echo $?`), ['0'], text)
    assert.equal(mode('f'), shown, text)
  }
  assert.deepEqual(k.sh('chmod 1777 d; chmod 640 f; ls -ld d f'), ['drwxrwxrwt root 0 2026-11-14 18:00 d', '-rw-r----- root 0 2026-11-14 18:00 f'])
  for (const bad of ['2755', '4755', '7777', '778', '12345', '-1', 'rw', 'u+rz', 'u', 'u+r,', ',u+r', 'x+r', 'g=u', 'u+r,,g+r', 'a+r w', '-z', '']) {
    assert.deepEqual(k.sh(`chmod '${bad}' f; echo $?`), [`!chmod: invalid mode '${bad}'`, '!usage: chmod [-R] mode path ...', '2'], bad)
  }
  assert.equal(mode('f'), '-rw-r-----')
})

test('chmod: a mode in letters', () => {
  const k = fresh()
  k.write('/tmp/f', '')
  k.sh('mkdir d')
  const after = (from: string, text: string, path = 'f'): string => {
    assert.deepEqual(k.sh(`chmod ${from} ${path}; chmod ${text} ${path}; echo $?`), ['0'], text)
    return k.sh(`ls -ld ${path}`)[0].split(' ')[0]
  }
  assert.equal(after('644', 'u+x'), '-rwxr--r--')
  assert.equal(after('644', 'go-r'), '-rw-------')
  assert.equal(after('644', 'a+x'), '-rwxr-xr-x')
  assert.equal(after('777', 'o='), '-rwxrwx---')
  assert.equal(after('777', 'go=r'), '-rwxr--r--')
  assert.equal(after('000', 'u=rwx,g=rx,o=x'), '-rwxr-x--x')
  assert.equal(after('000', 'ugo+rw'), '-rw-rw-rw-')
  assert.equal(after('777', 'a-wx,u+w'), '-rw-r--r--')
  assert.equal(after('640', 'u+x-w'), '-r-xr-----')
  assert.equal(after('640', 'g+w,o+r,u-r'), '--w-rw-r--')
  assert.equal(after('640', 'a='), '----------')
  // An operator with nothing after it adds or takes nothing; = with nothing clears the set.
  assert.equal(after('640', 'u+'), '-rw-r-----')
  assert.equal(after('640', 'g-'), '-rw-r-----')
  assert.equal(after('000', '+r+'), '-r--r--r--')
  assert.equal(after('777', 'u=,g=r,o-'), '----r--rwx')
  // X is x only for a directory or a file somebody may run already.
  assert.equal(after('644', 'a+X'), '-rw-r--r--')
  assert.equal(after('744', 'a+X'), '-rwxr-xr-x')
  assert.equal(after('600', 'go+X', 'd'), 'drw---x--x')
  assert.equal(after('600', 'u+x,go+X'), '-rwx--x--x')
  // t is the sticky mark: it goes with the others' set and with all, not with the owner's or the group's.
  assert.equal(after('755', '+t', 'd'), 'drwxr-xr-t')
  assert.equal(after('755', 'o+t', 'd'), 'drwxr-xr-t')
  assert.equal(after('755', 'ug+t', 'd'), 'drwxr-xr-x')
  assert.equal(after('1777', 'a-t', 'd'), 'drwxrwxrwx')
  assert.equal(after('1777', 'o=rx', 'd'), 'drwxrwxr-x')
  assert.equal(after('1777', 'g=rx', 'd'), 'drwxr-xrwt')
  assert.equal(after('750', 'a=rwxt', 'd'), 'drwxrwxrwt')
  // With no set named, all three change, except what the mask holds back.
  assert.equal(after('000', '+rwx'), '-rwxr-xr-x')
  assert.equal(after('777', '-w'), '-r-xrwxrwx')
  assert.equal(after('777', '=rw'), '-rw-r--r--')
  assert.equal(after('777', '-- -w'), '-r-xrwxrwx')
  assert.deepEqual(k.sh('umask 077; chmod 000 f; chmod +r f; umask 0; chmod +w f; umask 022; ls -l f'), ['-rw--w--w- root 0 2026-11-14 18:00 f'])
})

test('chmod -R: a directory and everything below it; refusals reported, the rest still changed', () => {
  const k = fresh()
  k.sh('mkdir -p d/sub/deep')
  for (const path of ['d/f', 'd/sub/g', 'd/sub/deep/h', 'other']) k.write(`/tmp/${path}`, '')
  assert.deepEqual(k.sh('chmod -R go-rwx,u+X d; echo $?; ls -lR d other'), [
    '0',
    '-rw-r--r-- root 0 2026-11-14 18:00 other',
    '',
    'd:',
    '-rw------- root 0 2026-11-14 18:00 f',
    'drwx------ root 0 2026-11-14 18:00 sub',
    '',
    'd/sub:',
    'drwx------ root 0 2026-11-14 18:00 deep',
    '-rw------- root 0 2026-11-14 18:00 g',
    '',
    'd/sub/deep:',
    '-rw------- root 0 2026-11-14 18:00 h',
  ])
  assert.deepEqual(k.sh('ls -ld d'), ['drwx------ root 0 2026-11-14 18:00 d'])
  // Without -R only the directory itself.
  assert.deepEqual(k.sh('chmod 755 d; ls -ld d d/sub'), ['drwxr-xr-x root 0 2026-11-14 18:00 d', 'drwx------ root 0 2026-11-14 18:00 d/sub'])
  assert.deepEqual(k.sh('chmod -R 700 other; ls -l other'), ['-rwx------ root 0 2026-11-14 18:00 other'])
  assert.deepEqual(k.sh('chmod 600 nosuch other /bin/ls /proc/version; echo $?; ls -l other'), [
    '!chmod: nosuch: no such file or directory', '!chmod: /bin/ls: read-only file system', '!chmod: /proc/version: a generated file keeps its attributes', '1',
    '-rw------- root 0 2026-11-14 18:00 other',
  ])
  // A tree that takes no changes: every path in it is named once.
  const rom = k.sh('find /usr')
  assert.ok(rom[0] === '/usr' && rom.length > 2 && rom.every((path) => path === '/usr' || path.startsWith('/usr/')))
  assert.deepEqual(k.sh('chmod -R a-w /usr; echo $?'), rom.map((path) => `!chmod: ${path}: read-only file system`).concat(['1']))
  assert.deepEqual(k.sh('chmod; chmod -R; chmod -R 644; chmod u+x; echo $?'), [
    '!usage: chmod [-R] mode path ...', '!usage: chmod [-R] mode path ...', '!usage: chmod [-R] mode path ...', '!usage: chmod [-R] mode path ...', '2',
  ])
})

// stat

test('stat: a few labelled lines for each path', () => {
  const k = fresh()
  k.sh('mkdir d; chmod 1770 d')
  k.tick(3_723_000)
  k.write('/tmp/f', 'twelve bytes')
  k.sh('chmod 640 f')
  now(k.system.kernel.vfs.chown('/tmp/f', '/', ROOT_CRED, 1000, 50))
  const lines = k.sh('stat f d /dev/null; echo $?')
  assert.equal(lines.length, 28)
  assert.deepEqual(lines.slice(0, 6), ['name:   f', 'kind:   file', 'size:   12', 'mode:   0640 (-rw-r-----)', 'owner:  1000', 'group:  50'])
  assert.match(lines[6], /^device: [0-9]+$/)
  assert.match(lines[7], /^inode:  [0-9]+$/)
  assert.equal(lines[8], 'time:   2026-11-14 19:02:03')
  assert.deepEqual(lines.slice(9, 15), ['name:   d', 'kind:   directory', 'size:   0', 'mode:   1770 (drwxrwx--T)', 'owner:  0 (root)', 'group:  0'])
  assert.equal(lines[15], lines[6])
  assert.notEqual(lines[16], lines[7])
  assert.equal(lines[17], 'time:   2026-11-14 18:00:00')
  assert.deepEqual(lines.slice(18, 22), ['name:   /dev/null', 'kind:   device', 'size:   0', 'mode:   0666 (crw-rw-rw-)'])
  assert.notEqual(lines[24], lines[6])
  assert.equal(lines[27], '0')
  // Two names for one file say so: the same device and inode numbers.
  assert.deepEqual(k.sh('stat f | cat').slice(6, 8), k.sh('stat ./d/../f').slice(6, 8))
  assert.deepEqual(k.sh('stat nosuch f/x; echo $?'), ['!stat: nosuch: no such file or directory', '!stat: f/x: not a directory', '1'])
  const mixed = k.sh('stat nosuch d; echo $?')
  assert.deepEqual([mixed[0], mixed[1], mixed[mixed.length - 1]], ['!stat: nosuch: no such file or directory', 'name:   d', '1'])
  assert.deepEqual(k.sh('stat; echo $?'), ['!usage: stat path ...', '2'])
})

// find

/** A small tree for find, du and tree: /tmp/t with files of known sizes and times. */
function planted(): Kit {
  const k = fresh()
  k.sh('mkdir -p t/docs/old t/src t/empty')
  k.write('/tmp/t/README', 'read me\n')
  k.write('/tmp/t/docs/guide.txt', 'g'.repeat(3000))
  k.write('/tmp/t/docs/old/notes.TXT', 'n'.repeat(600))
  k.write('/tmp/t/docs/.hidden', '')
  k.tick(60_000)
  k.write('/tmp/t/src/main.c', 'm'.repeat(1024))
  k.write('/tmp/t/src/util.c', 'u'.repeat(1025))
  k.write('/tmp/t/src/blank', '')
  return k
}

const ALL = [
  't', 't/README', 't/docs', 't/docs/.hidden', 't/docs/guide.txt', 't/docs/old', 't/docs/old/notes.TXT', 't/empty', 't/src', 't/src/blank',
  't/src/main.c', 't/src/util.c',
]

test('find: walks in sorted order and prints every path when no expression is given', () => {
  const k = planted()
  assert.deepEqual(k.sh('find t; echo $?'), [...ALL, '0'])
  assert.deepEqual(k.sh('cd t; find; cd ..'), ALL.map((p) => (p === 't' ? '.' : `./${p.slice(2)}`)))
  assert.deepEqual(k.sh('find t/src t/README t/empty/'), ['t/src', 't/src/blank', 't/src/main.c', 't/src/util.c', 't/README', 't/empty/'])
  assert.deepEqual(k.sh('find /tmp/t/docs -print'), [
    '/tmp/t/docs', '/tmp/t/docs/.hidden', '/tmp/t/docs/guide.txt', '/tmp/t/docs/old', '/tmp/t/docs/old/notes.TXT',
  ])
  assert.deepEqual(k.sh('find t/docs/ -type f'), ['t/docs/.hidden', 't/docs/guide.txt', 't/docs/old/notes.TXT'])
  assert.deepEqual(k.sh('find / -maxdepth 1'), ['/', '/bin', '/dev', '/etc', '/home', '/mnt', '/proc', '/sys', '/tmp', '/usr'])
  assert.deepEqual(k.sh('find nosuch t/empty also; echo $?'), [
    '!find: nosuch: no such file or directory', 't/empty', '!find: also: no such file or directory', '1',
  ])
})

test('find: -name, -iname and -path match with patterns', () => {
  const k = planted()
  assert.deepEqual(k.sh("find t -name '*.c'"), ['t/src/main.c', 't/src/util.c'])
  assert.deepEqual(k.sh("find t -name '*.txt'"), ['t/docs/guide.txt'])
  assert.deepEqual(k.sh("find t -iname '*.txt'"), ['t/docs/guide.txt', 't/docs/old/notes.TXT'])
  assert.deepEqual(k.sh("find t -iname 'readme'"), ['t/README'])
  assert.deepEqual(k.sh("find t -name '????'"), ['t/docs'])
  assert.deepEqual(k.sh("find t -name '[a-m]*' -type f"), ['t/docs/guide.txt', 't/src/blank', 't/src/main.c'])
  // A star takes names that start with a dot too, and the name of the starting path counts.
  assert.deepEqual(k.sh("find t/docs -maxdepth 1 -name '*'"), ['t/docs', 't/docs/.hidden', 't/docs/guide.txt', 't/docs/old'])
  assert.deepEqual(k.sh("find t -name t; find t/src/ -name src; cd t; find . -name .; cd .."), ['t', 't/src/', '.'])
  assert.deepEqual(k.sh("find t -path '*docs*'"), ['t/docs', 't/docs/.hidden', 't/docs/guide.txt', 't/docs/old', 't/docs/old/notes.TXT'])
  assert.deepEqual(k.sh("find t -path 't/*/old/*'"), ['t/docs/old/notes.TXT'])
  assert.deepEqual(k.sh("find t -path 't/src'"), ['t/src'])
  assert.deepEqual(k.sh("find t -name 'src/main.c'; find t -name nothing; echo $?"), ['0'])
  // A pattern that would make a careless matcher try every split still answers at once.
  k.write(`/tmp/t/${'a'.repeat(200)}`, '')
  assert.deepEqual(k.sh(`find t -name '${'*a'.repeat(60)}b'; echo $?`), ['0'])
})

test('find: -type, -empty, -size, -newer, -maxdepth and -mindepth', () => {
  const k = planted()
  assert.deepEqual(k.sh('find t -type d'), ['t', 't/docs', 't/docs/old', 't/empty', 't/src'])
  assert.deepEqual(k.sh('find t -type f'), ALL.filter((p) => !['t', 't/docs', 't/docs/old', 't/empty', 't/src'].includes(p)))
  assert.deepEqual(k.sh('find /dev -type f; find /dev -type d'), ['/dev'])
  assert.deepEqual(k.sh('find t -empty'), ['t/docs/.hidden', 't/empty', 't/src/blank'])
  assert.deepEqual(k.sh('find t -empty -type d'), ['t/empty'])
  // Sizes: bytes with c, units of 1024 with k (a part counts as a whole one), 512 with no letter.
  assert.deepEqual(k.sh('find t -type f -size 1024c'), ['t/src/main.c'])
  assert.deepEqual(k.sh('find t -type f -size +1024c'), ['t/docs/guide.txt', 't/src/util.c'])
  assert.deepEqual(k.sh('find t -type f -size -8c'), ['t/docs/.hidden', 't/src/blank'])
  assert.deepEqual(k.sh('find t -type f -size 1k'), ['t/README', 't/docs/old/notes.TXT', 't/src/main.c'])
  assert.deepEqual(k.sh('find t -type f -size 2k'), ['t/src/util.c'])
  assert.deepEqual(k.sh('find t -type f -size +2k'), ['t/docs/guide.txt'])
  assert.deepEqual(k.sh('find t -type f -size -1k'), ['t/docs/.hidden', 't/src/blank'])
  assert.deepEqual(k.sh('find t -type f -size 2'), ['t/docs/old/notes.TXT', 't/src/main.c'])
  assert.deepEqual(k.sh('find t -type f -size +2'), ['t/docs/guide.txt', 't/src/util.c'])
  assert.deepEqual(k.sh('find t -size 0 -name "[a-z]*"'), ['t', 't/docs', 't/docs/old', 't/empty', 't/src', 't/src/blank'])
  assert.deepEqual(k.sh('find t -size 1M'), ['t/README', 't/docs/guide.txt', 't/docs/old/notes.TXT', 't/src/main.c', 't/src/util.c'])
  assert.deepEqual(k.sh('find t -size -1M -type f; find t -size +0M -size -2M -name "*.c"'), ['t/docs/.hidden', 't/src/blank', 't/src/main.c', 't/src/util.c'])
  // Newer: changed after the named file was.
  assert.deepEqual(k.sh('find t -newer t/README -type f'), ['t/src/blank', 't/src/main.c', 't/src/util.c'])
  assert.deepEqual(k.sh('find t -newer t/src/main.c'), [])
  assert.deepEqual(k.sh('find t ! -newer t/README -type f'), ['t/README', 't/docs/.hidden', 't/docs/guide.txt', 't/docs/old/notes.TXT'])
  assert.deepEqual(k.sh('find t -newer t/README -newer t/docs -type f'), ['t/src/blank', 't/src/main.c', 't/src/util.c'])
  // A file to compare with that is not there is named, and nothing is walked.
  assert.deepEqual(k.sh('find t -newer nosuch; echo $?'), ['!find: nosuch: no such file or directory', '1'])
  assert.deepEqual(k.sh('find t -newer t/README -o -newer nosuch -o -newer also; echo $?'), ['!find: nosuch: no such file or directory', '1'])
  // Depth.
  assert.deepEqual(k.sh('find t -maxdepth 0'), ['t'])
  assert.deepEqual(k.sh('find t -maxdepth 1'), ['t', 't/README', 't/docs', 't/empty', 't/src'])
  assert.deepEqual(k.sh('find t -mindepth 3'), ['t/docs/old/notes.TXT'])
  assert.deepEqual(k.sh('find t -mindepth 1 -maxdepth 1 -type d'), ['t/docs', 't/empty', 't/src'])
  assert.deepEqual(k.sh('find t -mindepth 2 -maxdepth 2 -name "*.c"'), ['t/src/main.c', 't/src/util.c'])
  assert.deepEqual(k.sh('find t -type d -maxdepth 1'), ['t', 't/docs', 't/empty', 't/src'])
  assert.deepEqual(k.sh('find t -mindepth 9; echo $?'), ['0'])
})

test('find: !, -not, -a, -o and parentheses', () => {
  const k = planted()
  assert.deepEqual(k.sh("find t -type f ! -name '*.c'"), ['t/README', 't/docs/.hidden', 't/docs/guide.txt', 't/docs/old/notes.TXT', 't/src/blank'])
  assert.deepEqual(k.sh("find t -type f -not -name '*.c' -not -path '*docs*'"), ['t/README', 't/src/blank'])
  assert.deepEqual(k.sh("find t ! ! -name '*.c'"), ['t/src/main.c', 't/src/util.c'])
  assert.deepEqual(k.sh("find t -name '*.c' -a -size +1024c"), ['t/src/util.c'])
  assert.deepEqual(k.sh("find t -name '*.c' -o -name '*.txt'"), ['t/docs/guide.txt', 't/src/main.c', 't/src/util.c'])
  // -a binds tighter than -o.
  assert.deepEqual(k.sh("find t -name README -o -name '*.c' -size +1024c"), ['t/README', 't/src/util.c'])
  assert.deepEqual(k.sh("find t \\( -name README -o -name '*.c' \\) -size +1024c"), ['t/src/util.c'])
  assert.deepEqual(k.sh("find t -type f \\( -name '*.c' -o -name '*.txt' \\) ! -name 'm*'"), ['t/docs/guide.txt', 't/src/util.c'])
  assert.deepEqual(k.sh("find t ! \\( -type d -o -name '*.*' -o -name '.*' \\)"), ['t/README', 't/src/blank'])
  assert.deepEqual(k.sh("find t \\( \\( -name README \\) \\)"), ['t/README'])
  assert.deepEqual(k.sh("find t '(' -name README ')' -o '!' -name '*'"), ['t/README'])
  // An action in one branch only: nothing else is printed.
  assert.deepEqual(k.sh("find t -name README -o -name '*.c' -print"), ['t/src/main.c', 't/src/util.c'])
  assert.deepEqual(k.sh("find t -name README -print -o -name '*.c' -print"), ['t/README', 't/src/main.c', 't/src/util.c'])
  assert.deepEqual(k.sh("find t -name README -print -print"), ['t/README', 't/README'])
})

test('find: an expression that cannot be read is a wrong call (2) and nothing is walked', () => {
  const k = planted()
  const usage = '!usage: find [path ...] [expression]'
  const bad: [string, string][] = [
    ['-bogus', "unknown test '-bogus'"], ['-name', '-name needs a value'], ['-type', '-type needs a value'],
    ['-type x', "-type takes f (a file) or d (a directory), not 'x'"],
    ['-size', '-size needs a value'], ['-size 1x', "-size takes [+-]N[ckM], not '1x'"],
    ['-size k', "-size takes [+-]N[ckM], not 'k'"], ['-size ++1', "-size takes [+-]N[ckM], not '++1'"],
    ['-maxdepth', '-maxdepth needs a value'], ['-maxdepth -1', '-maxdepth needs a whole number'], ['-mindepth x', '-mindepth needs a whole number'],
    ['-newer', '-newer needs a value'], ['\\( -name x', "'(' without ')'"], ['-name x \\)', "')' without '('"],
    ['\\( \\)', "')' has nothing before it"], ['! \\)', "')' has nothing before it"],
    ['-o -name x', "'-o' has nothing before it"], ['-name x -o', 'the expression ends too soon'],
    ['-a', "'-a' has nothing before it"], ['!', 'the expression ends too soon'],
    ['-name x -a', 'the expression ends too soon'], ['-exec cat {}', "-exec needs a ';' to end its command"],
    ['-exec \\;', '-exec needs a command'], ['-exec cat {} +', "-exec needs a ';' to end its command"],
    ['-print x', "unknown test 'x'"],
  ]
  // Nothing but the complaint: no path is printed, so nothing was walked.
  for (const [expr, why] of bad) assert.deepEqual(k.sh(`find t ${expr}; echo $?`), [`!find: ${why}`, usage, '2'], expr)
  assert.deepEqual(k.sh(`find t ${'\\( '.repeat(70)} -name x ${'\\) '.repeat(70)}; echo $?`), ['!find: the expression is nested too deeply', usage, '2'])
  assert.deepEqual(k.sh(`find t ${'! '.repeat(70)} -name x; echo $?`), ['!find: the expression is nested too deeply', usage, '2'])
  assert.deepEqual(k.sh(`find t ${'! '.repeat(64)} -name README; echo $?`), ['t/README', '0'])
  assert.deepEqual(k.sh(`find t ${'\\( '.repeat(64)} -name README ${'\\) '.repeat(64)}; echo $?`), ['t/README', '0'])
  // An action that came before what is wrong does nothing either.
  assert.deepEqual(k.sh('find t -delete -bogus; find t -exec rm {} \\; -type x; echo $?'), [
    "!find: unknown test '-bogus'", usage, "!find: -type takes f (a file) or d (a directory), not 'x'", usage, '2',
  ])
  assert.deepEqual(k.sh('find t | cat'), ALL)
})

test('find -delete: removes what passes, what a directory holds before the directory', () => {
  const k = planted()
  assert.deepEqual(k.sh("find t -name '*.c' -delete; echo $?; ls t/src"), ['0', 'blank'])
  assert.deepEqual(k.sh('find t -empty -delete; echo $?; find t'), ['0', 't', 't/README', 't/docs', 't/docs/guide.txt', 't/docs/old', 't/docs/old/notes.TXT'])
  // A directory that still holds something is refused, said, and counted.
  assert.deepEqual(k.sh('find t -name old -delete; echo $?'), ['!find: t/docs/old: directory not empty', '1'])
  assert.deepEqual(k.sh('find t -name docs -o -name old -delete -print; echo $?'), ['!find: t/docs/old: directory not empty', '1'])
  // Deepest first: a whole tree goes, the starting path with it.
  assert.deepEqual(k.sh('find t/docs -print -delete; echo $?; find t'), [
    't/docs/guide.txt', 't/docs/old/notes.TXT', 't/docs/old', 't/docs', '0', 't', 't/README',
  ])
  // But never the starting path when it is spelled . or ..
  assert.deepEqual(k.sh('cd t; mkdir -p x/y; find . -delete; echo $?; ls -a; cd ..; ls'), ['0', '.  ..', 't'])
  assert.deepEqual(k.sh('mkdir -p t/x; find t/x/.. -delete; echo $?; ls -a t'), ['0', '.  ..'])
  assert.deepEqual(k.sh('find t -mindepth 1 -delete; find t -delete; echo $?; ls'), ['0'])
  // Refused outright from the root, whatever the rest says.
  const fromRoot = [
    'find / -name nosuch -delete', 'find /tmp/.. -maxdepth 0 -delete', 'find /tmp // -delete', 'cd /; find . -delete; cd /tmp',
    'cd /; find -delete; cd /tmp',
  ]
  for (const line of fromRoot) {
    const out = k.sh(`${line}; echo $?`)
    assert.match(out[0], /^!find: .*: -delete is refused for a search that starts at the root directory$/, line)
    assert.equal(out.length, 2, line)
  }
  assert.ok(k.exists('/etc/hostname') && k.exists('/home/operator/README'))
  assert.deepEqual(k.sh('find /bin -name ls -delete; echo $?'), ['!find: /bin/ls: read-only file system', '1'])
})

test('find -exec: runs a program for each path, {} replaced wherever it stands', () => {
  const k = planted()
  assert.deepEqual(k.sh('find t -name README -exec cat {} \\;; echo $?'), ['read me', '0'])
  assert.deepEqual(k.sh("find t -name '*.c' -exec ls -l {} \\;"), [
    '-rw-r--r-- root 1024 2026-11-14 18:01 t/src/main.c', '-rw-r--r-- root 1025 2026-11-14 18:01 t/src/util.c',
  ])
  assert.deepEqual(k.sh("find t -name '*.c' -exec sh -c 'echo \"<$0> <$1>\"' x{}y {}.bak \\;"), [
    '<xt/src/main.cy> <t/src/main.c.bak>', '<xt/src/util.cy> <t/src/util.c.bak>',
  ])
  assert.deepEqual(k.sh("find t -name '*.c' -exec sh -c 'echo {}{}' \\;"), ['t/src/main.ct/src/main.c', 't/src/util.ct/src/util.c'])
  // What was printed before the command ran comes before what the command prints.
  assert.deepEqual(k.sh('find t -name README -print -exec cat {} \\; -print'), ['t/README', 'read me', 't/README'])
  // It passes when the command ends with 0.
  assert.deepEqual(k.sh("find t -type f -exec sh -c 'test -s $0' {} \\; -print"), [
    't/README', 't/docs/guide.txt', 't/docs/old/notes.TXT', 't/src/main.c', 't/src/util.c',
  ])
  assert.deepEqual(k.sh("find t -type f ! -exec sh -c 'test -s $0' {} \\; -print; echo $?"), ['t/docs/.hidden', 't/src/blank', '0'])
  assert.deepEqual(k.sh("find t -name '*.c' -exec cp {} {}.bak \\; ; ls t/src"), ['blank  main.c  main.c.bak  util.c  util.c.bak'])
  assert.deepEqual(k.sh("find t -name '*.bak' -exec rm {} \\; ; ls t/src"), ['blank  main.c  util.c'])
  // A command that is not there is said for each path, and counted.
  assert.deepEqual(k.sh("find t -name '*.c' -exec nosuchprogram {} \\; -print; echo $?"), [
    '!find: nosuchprogram: no such file or directory', '!find: nosuchprogram: no such file or directory', '1',
  ])
  assert.deepEqual(k.sh('find t -name README -exec cat nosuch {} \\; -print; echo $?'), ['!cat: nosuch: no such file or directory', 'read me', '0'])
})

test('find: a reader that goes away ends a long walk at once', () => {
  const k = fresh()
  k.sh('mkdir big')
  for (let i = 0; i < MANY; i++) k.write(`/tmp/big/a-file-with-quite-a-long-name-${i}`, '')
  assert.deepEqual(own(k.sh('find big | read first; echo done')), ['done'])
  assert.deepEqual(own(k.sh('find / -type f | read first; echo done')), ['done'])
  assert.equal(k.sh('find big -type f | cat').length, MANY)
  assert.deepEqual(k.sh("find big -name '*-19?9' | cat"), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `big/a-file-with-quite-a-long-name-19${d}9`))
})

// du, df, mount, umount

test('du: the bytes of files added up the tree, in units of 1024 or for people', () => {
  const k = planted()
  assert.deepEqual(k.sh('du t > out; echo $?'), ['0'])
  assert.equal(k.read('/tmp/out'), '1\tt/docs/old\n4\tt/docs\n0\tt/empty\n3\tt/src\n6\tt\n')
  assert.deepEqual(k.sh('du -s t'), ['6       t'])
  assert.deepEqual(k.sh('du -h t'), ['600     t/docs/old', '3.5K    t/docs', '0       t/empty', '2K      t/src', '5.5K    t'])
  assert.deepEqual(k.sh('du -sh t t/src t/README'), ['5.5K    t', '2K      t/src', '8       t/README'])
  assert.deepEqual(k.sh('du -s t/src/main.c t/src/util.c t/src/blank t/empty'), [
    '1       t/src/main.c', '2       t/src/util.c', '0       t/src/blank', '0       t/empty',
  ])
  assert.deepEqual(k.sh('cd t/src; du; du -s; cd ../..'), ['3       .', '3       .'])
  assert.deepEqual(k.sh('du -s nosuch t/empty also; echo $?'), [
    '!du: nosuch: no such file or directory', '0       t/empty', '!du: also: no such file or directory', '1',
  ])
  assert.deepEqual(k.sh('du -x; echo $?'), ["!du: unknown option '-x'", '!usage: du [-s] [-h] [path ...]', '2'])
  // Devices and generated files have no bytes of their own.
  assert.deepEqual(k.sh('du -s /dev /sys'), ['0       /dev', '0       /sys'])
  assert.deepEqual(own(k.sh('du / | read first; echo done')), ['done'])
})

test('df: a line for each mount, lined up; -h for people; paths choose their mounts', () => {
  const k = boot(FILE_PROGRAMS, { diskBytes: 1 << 20, tmpBytes: 2000 * 1024 })
  k.sh('cd /tmp')
  k.write('/tmp/fill', new Uint8Array(1024 * 1024 - 64 - 4 - 64))
  const lines = k.sh('df; echo $?')
  assert.equal(lines.length, 9)
  assert.equal(lines[0], 'Source  Type    Size  Used  Free  Use%  Path')
  assert.match(lines[1], /^disk    diskfs  1024 {5}[0-9] {2}10[0-9]{2} {4}1% {2}\/$/)
  assert.match(lines[2], /^rom     romfs   1024 {5}[0-9] {2}10[0-9]{2} {4}1% {2}\/bin$/)
  assert.match(lines[3], /^rom     romfs   4096 {5}1 {2}4095 {4}1% {2}\/usr$/)
  assert.equal(lines[4], 'tmpfs   tmpfs   2000  1024   976   52%  /tmp')
  assert.deepEqual(lines.slice(5), [
    'devfs   devfs      -     -     -     -  /dev', 'proc    proc       -     -     -     -  /proc', 'sysfs   sysfs      -     -     -     -  /sys',
    '0',
  ])
  assert.deepEqual(k.sh('df -h /tmp'), ['Source  Type   Size  Used  Free  Use%  Path', 'tmpfs   tmpfs    2M    1M  976K   52%  /tmp'])
  // A path names the mount it is on, each mount once, in the order asked.
  assert.deepEqual(k.sh('df /tmp/fill . /tmp'), ['Source  Type   Size  Used  Free  Use%  Path', 'tmpfs   tmpfs  2000  1024   976   52%  /tmp'])
  assert.deepEqual(k.sh('df /proc/mounts /bin/ls').slice(1), ['proc    proc      -     -     -     -  /proc', 'rom     romfs  1024     2  1022    1%  /bin'])
  // Two paths on one mount: one line.
  assert.deepEqual(k.sh('df /home/operator /etc'), [lines[0], lines[1]])
  assert.deepEqual(k.sh('df nosuch /dev; echo $?'), [
    '!df: nosuch: no such file or directory', 'Source  Type   Size  Used  Free  Use%  Path', 'devfs   devfs     -     -     -     -  /dev', '1',
  ])
  assert.deepEqual(k.sh('df nosuch; echo $?'), ['!df: nosuch: no such file or directory', '1'])
  assert.deepEqual(k.sh('df -x; echo $?'), ["!df: unknown option '-x'", '!usage: df [-h] [path ...]', '2'])
  // Full to the last byte: all used, none free.
  k.sh('rm fill')
  k.write('/tmp/fill', new Uint8Array(2000 * 1024 - 64 - 4 - 64))
  assert.deepEqual(k.sh('df /tmp'), ['Source  Type   Size  Used  Free  Use%  Path', 'tmpfs   tmpfs  2000  2000     0  100%  /tmp'])
})

test('mount: lists the mounts as /proc/mounts does, and says honestly that it cannot attach', () => {
  const k = fresh()
  const lines = k.sh('mount; echo $?')
  assert.deepEqual(lines, [
    'disk / diskfs rw', 'rom /bin romfs ro', 'rom /usr romfs ro', 'tmpfs /tmp tmpfs rw', 'devfs /dev devfs rw', 'proc /proc proc rw',
    'sysfs /sys sysfs rw', '0',
  ])
  assert.deepEqual(k.sh('cat /proc/mounts'), lines.slice(0, -1))
  assert.deepEqual(k.sh('mount > out; echo $?; cat out'), ['0', ...lines.slice(0, -1)])
  for (const line of ['mount /mnt', 'mount disk /mnt', 'mount -t tmpfs none /mnt', 'mount -a']) {
    assert.deepEqual(k.sh(`${line}; echo $?`), ['!mount: mounting a folder is not available from the prompt yet', '1'], line)
  }
  assert.deepEqual(k.sh('mount | cat').length, 7)
})

test('umount: detaches a mount, and reports what is refused', () => {
  const k = fresh()
  k.write('/tmp/f', 'x')
  const pid = k.sh('echo $$')[0]
  assert.deepEqual(k.sh('umount /tmp; echo $?'), [`!umount: /tmp: task ${pid} is working in it`, '1'])
  assert.deepEqual(k.sh('cd /; umount /nosuch /etc /; echo $?'), [
    '!umount: /nosuch: not a mount point', '!umount: /etc: not a mount point', '!umount: /: task 1 is working in it', '1',
  ])
  assert.deepEqual(k.sh('umount; echo $?'), ['!usage: umount path ...', '2'])
  assert.deepEqual(k.sh('umount /tmp/ /sys; echo $?; ls -a /tmp; mount'), [
    '0', '.  ..', 'disk / diskfs rw', 'rom /bin romfs ro', 'rom /usr romfs ro', 'devfs /dev devfs rw', 'proc /proc proc rw',
  ])
  assert.deepEqual(k.sh('umount /tmp; echo $?'), ['!umount: /tmp: not a mount point', '1'])
  // What was under the mount is an ordinary directory again.
  assert.deepEqual(k.sh('touch /tmp/under; df /tmp/under | cat'), ['Source  Type    Size  Used  Free  Use%  Path', k.sh('df /')[1]])
})

// realpath, basename, dirname

test('realpath: the path in full, when it or the directory that would hold it is there', () => {
  const k = fresh()
  k.sh('mkdir -p d/sub')
  k.write('/tmp/d/f', '')
  assert.deepEqual(k.sh('realpath d/f . .. d/sub/../f ./d//sub/. /tmp/../tmp/d/; echo $?'), ['/tmp/d/f', '/tmp', '/', '/tmp/d/f', '/tmp/d/sub', '/tmp/d', '0'])
  assert.deepEqual(k.sh('cd d/sub; realpath ../f f; cd ../..'), ['/tmp/d/f', '/tmp/d/sub/f'])
  assert.deepEqual(k.sh('realpath / /dev/null /proc/mounts ~'), ['/', '/dev/null', '/proc/mounts', '/home/operator'])
  // Not there yet, in a directory that is: still a path. Deeper than that: nowhere.
  assert.deepEqual(k.sh('realpath d/new; echo $?'), ['/tmp/d/new', '0'])
  assert.deepEqual(k.sh('realpath nodir/new d/f/x d d/f/..; echo $?'), [
    '!realpath: nodir/new: no such file or directory', '!realpath: d/f/x: not a directory', '/tmp/d', '/tmp/d', '1',
  ])
  assert.deepEqual(k.sh("realpath ''; echo $?"), ['!realpath: : no such file or directory', '1'])
  assert.deepEqual(k.sh('realpath; echo $?'), ['!usage: realpath path ...', '2'])
  assert.deepEqual(k.sh('realpath d | cat'), ['/tmp/d'])
})

test('basename: the last name of a path, with a suffix cut off when asked', () => {
  const k = fresh()
  const cases: [string, string][] = [
    ['/home/operator/notes.txt', 'notes.txt'], ['notes.txt', 'notes.txt'], ['a/b/', 'b'], ['a/b///', 'b'], ['/', '/'],
    ['///', '/'], ['.', '.'], ['..', '..'], ['/a', 'a'], ['a//b', 'b'],
    ['/home/operator/notes.txt .txt', 'notes'], ['notes.txt txt', 'notes.'], ['notes.txt notes.txt', 'notes.txt'],
    ['notes.txt .md', 'notes.txt'], ['a/b.c/ .c', 'b'], ['/ /', '/'],
    ["'two words/last name'", 'last name'], ["notes.txt ''", 'notes.txt'], ['-- -dash', '-dash'],
  ]
  for (const [args, want] of cases) assert.deepEqual(k.sh(`basename ${args}; echo $?`), [want, '0'], args)
  assert.deepEqual(k.sh("basename ''; echo $?"), ['', '0'])
  assert.deepEqual(k.sh('basename /nosuch/at/all.x .x'), ['all'])
  assert.deepEqual(k.sh('basename; basename a b c; echo $?'), ['!usage: basename path [suffix]', '!usage: basename path [suffix]', '2'])
  assert.deepEqual(k.sh('basename -x; echo $?'), ["!basename: unknown option '-x'", '!usage: basename path [suffix]', '2'])
  assert.deepEqual(k.sh('x=$(basename /a/b/c.d .d); echo "[$x]"'), ['[c]'])
})

test('dirname: a path without its last name', () => {
  const k = fresh()
  const cases: [string, string][] = [
    ['/home/operator/notes.txt', '/home/operator'], ['notes.txt', '.'], ['a/b', 'a'], ['a/b/', 'a'], ['a/b///', 'a'], ['/', '/'],
    ['///', '/'], ['/a', '/'], ['//a', '/'], ['.', '.'], ['..', '.'],
    ['a//b', 'a'], ['../x', '..'], ['a/b/c/d', 'a/b/c'], ["'two words/last name'", 'two words'], ['-- -dash/x', '-dash'],
  ]
  for (const [args, want] of cases) assert.deepEqual(k.sh(`dirname ${args}; echo $?`), [want, '0'], args)
  assert.deepEqual(k.sh("dirname ''; echo $?"), ['.', '0'])
  assert.deepEqual(k.sh('dirname; dirname a b; echo $?'), ['!usage: dirname path', '!usage: dirname path', '2'])
  assert.deepEqual(k.sh('dirname $(dirname /a/b/c)'), ['/a'])
})

// tree

test('tree: a drawing of a directory and all below it, then the counts', () => {
  const k = planted()
  assert.deepEqual(k.sh('tree t; echo $?'), [
    't',
    '|-- README',
    '|-- docs',
    '|   |-- guide.txt',
    '|   `-- old',
    '|       `-- notes.TXT',
    '|-- empty',
    '`-- src',
    '    |-- blank',
    '    |-- main.c',
    '    `-- util.c',
    '',
    '4 directories, 6 files',
    '0',
  ])
  assert.deepEqual(k.sh('tree -a t/docs'), ['t/docs', '|-- .hidden', '|-- guide.txt', '`-- old', '    `-- notes.TXT', '', '1 directory, 3 files'])
  assert.deepEqual(k.sh('tree -d t'), ['t', '|-- docs', '|   `-- old', '|-- empty', '`-- src', '', '4 directories'])
  assert.deepEqual(k.sh('tree -L 1 t'), ['t', '|-- README', '|-- docs', '|-- empty', '`-- src', '', '3 directories, 1 file'])
  assert.deepEqual(k.sh('tree -L 2 -d t'), ['t', '|-- docs', '|   `-- old', '|-- empty', '`-- src', '', '4 directories'])
  assert.deepEqual(k.sh('tree -dL1 t'), ['t', '|-- docs', '|-- empty', '`-- src', '', '3 directories'])
  assert.deepEqual(k.sh('tree t/empty'), ['t/empty', '', '0 directories, 0 files'])
  assert.deepEqual(k.sh('tree -d t/docs/old'), ['t/docs/old', '', '0 directories'])
  assert.deepEqual(k.sh('cd t/src; tree; cd ../..'), ['.', '|-- blank', '|-- main.c', '`-- util.c', '', '0 directories, 3 files'])
  // Several directories: each drawn, counted together.
  assert.deepEqual(k.sh('tree t/src t/docs/old'), [
    't/src', '|-- blank', '|-- main.c', '`-- util.c', 't/docs/old', '`-- notes.TXT', '', '0 directories, 4 files',
  ])
  k.sh('tree t > out')
  assert.equal(k.read('/tmp/out'), `${k.sh('tree t').join('\n')}\n`)
})

test('tree: what cannot be drawn is reported, the rest still is, with status 1', () => {
  const k = planted()
  assert.deepEqual(k.sh('tree nosuch t/empty t/README; echo $?'), [
    '!tree: nosuch: no such file or directory', 't/empty', '!tree: t/README: not a directory', '', '0 directories, 0 files', '1',
  ])
  assert.deepEqual(k.sh('tree -L 0 t; echo $?'), ['!tree: -L needs a whole number, 1 or more', '!usage: tree [-a] [-d] [-L depth] [dir ...]', '2'])
  assert.deepEqual(k.sh('tree -L x t; tree -L; echo $?'), [
    '!tree: -L needs a whole number, 1 or more', '!usage: tree [-a] [-d] [-L depth] [dir ...]',
    "!tree: option '-L' needs a value", '!usage: tree [-a] [-d] [-L depth] [dir ...]', '2',
  ])
  assert.deepEqual(own(k.sh('tree / | read first; echo done')), ['done'])
  const whole = k.sh('tree -L 1 /')
  assert.deepEqual(whole, [
    '/', '|-- bin', '|-- dev', '|-- etc', '|-- home', '|-- mnt', '|-- proc', '|-- sys', '|-- tmp', '`-- usr', '', '9 directories, 0 files',
  ])
})

// The output itself

test('a refused write to the output is said once, and ends the program with status 1', () => {
  const k = planted()
  const lines = [
    'ls t', 'ls -lR t', 'cat t/README', 'cat -n t/README t/docs/guide.txt', 'stat t', 'find t', 'find t -name README -print',
    'du t', 'du -sh t', 'df', 'df -h /tmp', 'mount',
    'realpath t', 'basename t/README', 'dirname t/README', 'tree t',
  ]
  for (const line of lines) {
    const name = line.slice(0, line.indexOf(' ') < 0 ? line.length : line.indexOf(' '))
    assert.deepEqual(k.sh(`${line} > /dev/full; echo $?`), [`!${name}: write error: no space left on device`, '1'], line)
  }
  // What a program had to say about a path still comes first, and the status is 1 either way.
  assert.deepEqual(k.sh('ls nosuch t > /dev/full; echo $?'), ['!ls: nosuch: no such file or directory', '!ls: write error: no space left on device', '1'])
  assert.deepEqual(k.sh('cat nosuch t/README also > /dev/full; echo $?'), [
    '!cat: nosuch: no such file or directory', '!cat: write error: no space left on device', '1',
  ])
  // Nothing to write, nothing refused.
  assert.deepEqual(k.sh('ls t/empty > /dev/full; cat t/src/blank > /dev/full; find t -name nothing > /dev/full; echo $?'), ['0'])
  // The programs that print nothing do their work whatever the output is.
  const quiet = ['mkdir made', 'touch made/f', 'cp made/f made/g', 'mv made/g made/h', 'chmod 600 made/h'].map((line) => `${line} > /dev/full`)
  assert.deepEqual(k.sh(`${quiet.join(' && ')}; echo $?; ls made`), ['0', 'f  h'])
  assert.deepEqual(k.sh('rm made/f > /dev/full; rmdir nosuch > /dev/full; echo $?; ls made'), ['!rmdir: nosuch: no such file or directory', '1', 'h'])
  // A disk with no room left is the same refusal, from a real file.
  const small = boot(FILE_PROGRAMS, { tmpBytes: 1000 })
  assert.deepEqual(small.sh('ls -lR / > /tmp/all; echo $?'), ['!ls: write error: file too large', '1'])
  small.write('/tmp/fill', new Uint8Array(700))
  assert.deepEqual(small.sh('find /bin /dev /etc > /tmp/some; echo $?'), ['!find: write error: no space left on device', '1'])
})

test('every walk goes as deep as the file system does', () => {
  const k = fresh()
  // /tmp/1/2/.../62 is 63 names deep: a file in it is as deep as a path can be.
  const dirs: string[] = []
  for (let i = 1; i <= 62; i++) dirs.push(String(i))
  const deep = dirs.join('/')
  assert.deepEqual(k.sh(`mkdir -p ${deep}; echo $?`), ['0'])
  k.write(`/tmp/${deep}/f`, 'deep')
  // One name more is refused by the file system, and said.
  assert.deepEqual(k.sh(`mkdir ${deep}/f/x ${deep}/g/h; touch ${deep}/g/h; echo $?`), [
    `!mkdir: ${deep}/f/x: a path is at most 64 names deep`, `!mkdir: ${deep}/g/h: a path is at most 64 names deep`,
    `!touch: ${deep}/g/h: a path is at most 64 names deep`, '1',
  ])
  const all = k.sh('find 1 | cat')
  assert.equal(all.length, 63)
  assert.deepEqual(all.slice(-2), [deep, `${deep}/f`])
  assert.deepEqual(k.sh('find 1 -type f | cat; find 1 -mindepth 62 | cat; find 1 -maxdepth 60 -name 62; find 1 -maxdepth 61 -name 62 | cat'), [
    `${deep}/f`, `${deep}/f`, deep,
  ])
  const listed = k.sh('ls -R 1 | cat')
  assert.equal(listed.filter((l) => l.endsWith(':')).length, 62)
  assert.deepEqual(listed.slice(-2), [`${deep}:`, 'f'])
  assert.deepEqual(k.sh('du 1 | cat').length, 62)
  assert.deepEqual(k.sh('du -s 1; tree 1 | cat').filter((l) => !l.includes('-- ')), ['1       1', '1', '', '61 directories, 1 file'])
  assert.deepEqual(k.sh('chmod -R go-rwx 1; echo $?'), ['0'])
  assert.deepEqual(k.sh(`ls -ld ${deep} ${deep}/f`), [`drwx------ root 0 2026-11-14 18:00 ${deep}`, `-rw------- root 4 2026-11-14 18:00 ${deep}/f`])
  // A copy beside it is as deep, and whole.
  const below = dirs.slice(1).join('/')
  assert.deepEqual(k.sh('cp -r 1 copy; echo $?; find copy -type f | cat'), ['0', `copy/${below}/f`])
  // One level further down there is no room for the file: said, with status 1, and the source stays whole.
  assert.deepEqual(k.sh('mkdir under; cp -r 1 under; echo $?'), [`!cp: under/${deep}/f: a path is at most 64 names deep`, '1'])
  assert.deepEqual(k.sh('mv 1 /home/operator/one; echo $?'), [`!mv: /home/operator/one/${below}/f: a path is at most 64 names deep`, '1'])
  assert.equal(k.read(`/tmp/${deep}/f`), 'deep')
  // To another file system at the same depth, it moves whole.
  assert.deepEqual(k.sh('mv 1/2 /home/operator/two; echo $?; find /home/operator/two -type f | cat; find 1'), [
    '0', `/home/operator/two/${dirs.slice(2).join('/')}/f`, '1',
  ])
  assert.deepEqual(k.sh('rm -r 1 copy under /home/operator/one /home/operator/two; echo $?; ls -a; ls /home/operator'), ['0', '.  ..', 'README'])
})
