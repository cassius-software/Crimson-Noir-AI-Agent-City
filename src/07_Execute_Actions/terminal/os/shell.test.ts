// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the shell (shell.ts), its `test` (cond.ts) and the kernel's exec to what the
 * reviewers of the programs proved they once got wrong: a program the shell runs in its own place that meets a
 * closed pipe ends quietly, a line of thousands of `!` is answered rather than ending the shell, and two long numbers
 * are never compared after rounding.
 * What breaks if it is removed? `printenv BIG | true` could print a broken-pipe complaint again, and `test` could
 * end the console's own shell or say two different numbers are equal.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FILE_PROGRAMS } from './fileutils.ts'
import { boot } from './kit.test.ts'
import { SYS_MANUAL, SYS_PROGRAMS } from './sysutils.ts'

const programs = { ...FILE_PROGRAMS, ...SYS_PROGRAMS }

test('a program run in the shell\'s own place that meets a closed pipe ends quietly, with 141', () => {
  const k = boot(programs, { manual: SYS_MANUAL })
  k.write('/tmp/big', 'x'.repeat(81920))
  // The last command of a pipe runs in place of the shell task (exec): its closed pipe is the program's own end.
  assert.deepEqual(k.sh('BIG=$(cat /tmp/big); export BIG; printenv BIG | true; echo $?'), ['0'])
  assert.deepEqual(k.sh('sh -c "printenv BIG" | true; echo $?'), ['0'])
  assert.deepEqual(k.sh('cat /tmp/big /tmp/big | true; echo $?'), ['0'])
  // A program that fails after it started is the program's failure, said by the kernel, never "not found".
  assert.deepEqual(k.sh('sh -c "cat /tmp/big > /dev/full"; echo $?'), ['!cat: write error: no space left on device', '1'])
})

test('test: a line of thousands of ! is counted, not recursed into', () => {
  const k = boot(programs, { manual: SYS_MANUAL })
  k.sh("x='!'; for i in 0 1 2 3 4 5 6 7 8 9 10 11 12 13; do x=\"$x $x\"; done")
  // 16384 of them: an even number, so the answer is the word's own.
  assert.deepEqual(k.sh('/bin/test $x y; echo $?; test $x y; echo $?; [ $x ! y ]; echo $?'), ['0', '0', '1'])
  // A last ! is a word, not an operator.
  assert.deepEqual(k.sh('[ ! ! ]; echo $?; [ ! ]; echo $?'), ['1', '0'])
})

test('test: whole numbers compare exactly, and one too long to be exact is refused', () => {
  const k = boot(programs, { manual: SYS_MANUAL })
  assert.deepEqual(k.sh('[ 9007199254740991 -gt 9007199254740990 ]; echo $?; [ " 007 " -eq 7 ]; echo $?; [ -3 -lt +2 ]; echo $?'), ['0', '0', '0'])
  assert.deepEqual(k.sh('/bin/test 99999999999999999999 -eq 99999999999999999998; echo $?'), [
    "!test: '99999999999999999999' is too large to be exact",
    '2',
  ])
  assert.deepEqual(k.sh('[ 9007199254740993 -eq 9007199254740992 ]; echo $?'), ["![: '9007199254740993' is too large to be exact", '2'])
})
