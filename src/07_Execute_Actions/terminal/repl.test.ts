// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins R0, the console's own stack machine: the arithmetic, comparison, logic, stack
 * and memory words with 32-bit wrap; colon definitions with recursion (fib 20 is 6765) and redefinition; if/else/then,
 * begin/until and begin/while/repeat; the printing words and `." text"`; the compile errors a bad line ends with;
 * the step budget and the output cap, after which the machine stays usable with its dictionary and memory intact;
 * determinism; a Turing-completeness witness (an interpreter for a small tape machine, written in R0, running a
 * program to its expected output); and the air gap: repl.ts has no import line and names none of the host's
 * doors (no dynamic code, no global object, no clock, no randomness, no network, no timers, no DOM).
 * What breaks if it is removed? A word could compute wrongly, a runaway line could hang the console, or a door to the
 * host could creep into the one module that must have none.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Machine, REPL } from './repl.ts'

const fresh = () => new Machine()
/** Runs one line and returns its printed text, failing the test on any error. */
const say = (m: Machine, line: string): string => {
  const r = m.run(line)
  assert.equal(r.error, undefined, `${line} -> ${r.error}`)
  return r.out.join('\n')
}
const err = (m: Machine, line: string): string => {
  const r = m.run(line)
  assert.ok(r.error !== undefined, `${line} should fail`)
  return r.error
}

test('the limits are frozen and as the map says', () => {
  assert.ok(Object.isFrozen(REPL))
  assert.deepEqual(REPL, { maxSteps: 1_000_000, maxOut: 16_384, cells: 65_536 })
})

test('arithmetic over 32-bit integers: wrap, truncating division, a zero divisor is an error', () => {
  const m = fresh()
  assert.equal(say(m, '1 2 + . 7 3 - . 6 7 * . 17 5 / . 17 5 mod . -17 5 / . -17 5 mod .'), '3 4 42 3 2 -3 -2 ')
  assert.equal(say(m, '2147483647 1 + .'), '-2147483648 ')
  assert.equal(say(m, '-2147483648 1 - .'), '2147483647 ')
  assert.equal(say(m, '65536 65536 * .'), '0 ')
  assert.equal(say(m, '123456789 987654321 * .'), `${Math.imul(123456789, 987654321)} `)
  assert.equal(say(m, '0x10 . 0xff . -0x1 . 4294967295 .'), '16 255 -1 -1 ')
  assert.equal(say(m, '5 negate . -5 abs . 3 9 min . 3 9 max . 7 1+ . 7 1- .'), '-5 5 3 9 8 6 ')
  assert.equal(say(m, '1 4 lshift . -1 28 rshift .'), '16 15 ')
  assert.equal(err(m, '1 0 /'), 'division by zero')
  assert.equal(err(m, '1 0 mod'), 'division by zero')
})

test('comparison gives -1 or 0; and/or/xor/invert are bitwise, not is logical', () => {
  const m = fresh()
  assert.equal(say(m, '1 1 = . 1 2 = . 1 2 <> . 1 2 < . 1 2 > . 2 2 <= . 3 2 >= .'), '-1 0 -1 -1 0 -1 -1 ')
  assert.equal(say(m, '-1 -1 and . -1 0 and . 0 -1 or . 6 3 xor . 0 invert . 0 not . 5 not .'), '-1 0 -1 5 -1 -1 0 ')
})

test('the stack words, depth, and underflow and overflow as named errors that clear the stack', () => {
  const m = fresh()
  assert.equal(say(m, '1 2 dup . . . depth .'), '2 2 1 0 ')
  assert.equal(say(m, '1 2 swap . . 1 2 over . . . 1 2 3 rot . . .'), '1 2 1 2 1 1 3 2 ')
  assert.equal(say(m, '1 2 3 -rot . . . 1 2 nip . 1 2 tuck . . .'), '2 1 3 2 2 1 2 ')
  assert.equal(say(m, '1 2 2dup . . . . 1 2 3 2drop . depth .'), '2 1 2 1 1 0 ')
  assert.equal(say(m, '1 2 3 drop . .'), '2 1 ')
  assert.equal(err(m, 'drop'), 'stack underflow')
  assert.equal(err(m, '1 +'), 'stack underflow')
  assert.equal(say(m, 'depth .'), '0 ', 'the stack is cleared after an error')
  assert.equal(say(m, '1 2 3'), '')
  assert.equal(say(m, 'depth .'), '3 ', 'and kept between lines otherwise')
  assert.equal(err(m, ': push begin 1 0 until ; push'), 'stack overflow')
  assert.equal(say(m, 'depth .'), '0 ')
})

test('memory: 65536 cells, @ ! +!, zeroed at start, kept between lines, bounds checked', () => {
  const m = fresh()
  assert.equal(say(m, '0 @ . 65535 @ .'), '0 0 ')
  assert.equal(say(m, '42 100 ! 100 @ . 8 100 +! 100 @ .'), '42 50 ')
  assert.equal(say(m, '-7 65535 ! 65535 @ .'), '-7 ')
  assert.equal(say(m, '2147483647 7 ! 1 7 +! 7 @ .'), '-2147483648 ', 'wraps in memory too')
  assert.equal(err(m, '65536 @'), 'address out of range (65536)')
  assert.equal(err(m, '1 -1 !'), 'address out of range (-1)')
  assert.equal(say(m, '100 @ .'), '50 ', 'memory survives an error')
  m.reset()
  assert.equal(say(m, '100 @ . 7 @ .'), '0 0 ', 'reset zeroes it')
})

test('output: . emit cr space spaces ." text", lines split on cr, a partial line flushed', () => {
  const m = fresh()
  const r = m.run('72 emit 105 emit cr ." hello, world" cr 1 . 2 space 3 spaces 4 .')
  assert.equal(r.error, undefined)
  assert.deepEqual(r.out, ['Hi', 'hello, world', '1     4 '])
  assert.deepEqual(m.run('."no space"').out, ['no space'])
  assert.deepEqual(m.run('cr cr').out, ['', ''])
  assert.deepEqual(m.run('').out, [])
  assert.deepEqual(m.run('   ').out, [])
  assert.equal(err(m, '." open'), 'unterminated string')
  assert.equal(err(m, '( open'), 'unterminated comment')
  assert.equal(say(m, '( a comment ) 1 . \\ the rest is ignored 2 .'), '1 ')
})

test('colon definitions: recursion (fib 20 is 6765), exit, redefinition shadows, callers keep the old word, words()', () => {
  const m = fresh()
  const before = m.words().length
  assert.equal(say(m, ': fib dup 2 < if exit then dup 1- fib swap 2 - fib + ;'), '')
  assert.equal(say(m, '20 fib .'), '6765 ')
  assert.equal(say(m, '0 fib . 1 fib . 2 fib . 10 fib .'), '0 1 1 55 ')
  assert.equal(say(m, ': sq dup * ; : cube dup sq * ; 3 cube . 4 sq .'), '27 16 ', 'a word defined earlier on the same line')
  assert.equal(say(m, ': sq 0 ; 5 cube . 5 sq .'), '125 0 ', 'cube keeps the sq it was compiled against')
  assert.deepEqual(m.words().slice(before), ['fib', 'sq', 'cube'])
  assert.ok(m.words().includes('dup') && m.words().includes(':') && m.words().includes('."'))
  assert.equal(say(m, ': fact dup 1 > if dup 1- fact * then ;'), '')
  assert.equal(say(m, '12 fact .'), '479001600 ')
  assert.equal(say(m, ': 1+ 100 + ; 1 1+ .'), '101 ', 'a primitive can be shadowed')
  m.reset()
  assert.equal(say(m, '1 1+ .'), '2 ', 'reset restores it')
  assert.equal(m.words().length, before)
  assert.equal(err(m, 'fib'), "unknown word 'fib'")
})

test('control: if/else/then, begin/until, begin/while/repeat, nesting, at the top level and inside words', () => {
  const m = fresh()
  assert.equal(say(m, '1 if 10 . then 0 if 20 . then 0 if 30 . else 40 . then'), '10 40 ')
  assert.equal(say(m, ': sign dup 0 < if drop -1 else 0 > if 1 else 0 then then ; -5 sign . 0 sign . 9 sign .'), '-1 0 1 ')
  assert.equal(say(m, '0 begin dup . 1+ dup 5 = until drop'), '0 1 2 3 4 ')
  assert.equal(say(m, '10 begin dup 0 > while dup . 3 - repeat drop'), '10 7 4 1 ')
  assert.equal(say(m, ': count 0 begin dup . 1+ dup 3 = until drop ; count count'), '0 1 2 0 1 2 ')
  assert.equal(say(m, ': gcd begin dup while tuck mod repeat drop ; 1071 462 gcd .'), '21 ')
  assert.equal(say(m, '0 begin 1+ dup 3 mod 0 = if dup . then dup 9 = until drop'), '3 6 9 ', 'if inside a loop')
})

test('compile errors are named, nothing of the line runs, and no definition from a bad line is installed', () => {
  const m = fresh()
  assert.equal(err(m, '1 . if'), "'if' without its end")
  assert.equal(err(m, 'then'), "'then' without 'if'")
  assert.equal(err(m, 'else'), "'else' without 'if'")
  assert.equal(err(m, 'until'), "'until' without 'begin'")
  assert.equal(err(m, 'begin'), "'begin' without its end")
  assert.equal(err(m, 'while'), "'while' without 'begin'")
  assert.equal(err(m, 'begin 1 repeat'), "'repeat' without 'begin … while'")
  assert.equal(err(m, '1 . ;'), "';' outside a definition")
  assert.equal(err(m, 'exit'), "'exit' outside a definition")
  assert.equal(err(m, ': a 1 : b 2 ; ;'), 'nested definition')
  assert.equal(err(m, ': a 1 .'), "unterminated definition ':' a")
  assert.equal(err(m, ':'), 'definition without a name')
  assert.equal(err(m, ': 12 ;'), "cannot define '12'")
  assert.equal(err(m, ': if ;'), "cannot define 'if'")
  assert.equal(err(m, ': a 1 if ;'), "'if' without its end")
  assert.equal(err(m, ': ok 1 ; : bad nope ;'), "unknown word 'nope'")
  assert.equal(err(m, 'ok'), "unknown word 'ok'", 'ok was on a line that failed to compile')
  assert.equal(err(m, '1 . frobnicate'), "unknown word 'frobnicate'")
  assert.equal(m.run('1 . frobnicate').out.length, 0, 'nothing ran')
  assert.equal(say(m, 'depth .'), '0 ')
})

test('the step budget: a line that never ends stops with a named error and the machine stays usable', () => {
  const m = fresh()
  assert.equal(say(m, ': sq dup * ; 7 1000 !'), '')
  const r = m.run('begin 0 until')
  assert.equal(r.error, `step budget exhausted (${REPL.maxSteps})`)
  assert.equal(r.steps, REPL.maxSteps)
  assert.equal(say(m, '6 sq . 1000 @ . depth .'), '36 7 0 ', 'the dictionary and the memory survive, the stack is cleared')
  const rec = m.run(': forever forever ; forever')
  assert.equal(rec.error, 'return stack overflow', 'runaway recursion ends by name, long before the host stack')
  assert.ok(rec.steps < REPL.maxSteps)
  assert.equal(say(m, '6 sq .'), '36 ')
  const loud = m.run(': loop begin 1 . 0 until ; loop')
  assert.equal(loud.error, `output limit exhausted (${REPL.maxOut})`)
  assert.ok(loud.out.join('\n').length <= REPL.maxOut)
  assert.ok(loud.out.join('\n').length > REPL.maxOut - 4, 'what was printed up to the cap is returned')
  const lines = m.run('begin cr 0 until')
  assert.equal(lines.error, `output limit exhausted (${REPL.maxOut})`)
  assert.equal(lines.out.length, REPL.maxOut, 'an empty line counts as a character')
  assert.equal(say(m, '6 sq .'), '36 ')
  const fits = m.run('0 begin 1+ dup 100000 = until drop')
  assert.equal(fits.error, undefined)
  assert.ok(fits.steps > 100_000 && fits.steps < REPL.maxSteps)
})

test('deterministic: two machines fed the same lines print the same, step for step', () => {
  const lines = [': fib dup 2 < if exit then dup 1- fib swap 2 - fib + ;', '15 fib .', '1 0 /', ': x 7 ; x x + .', '0 begin dup 3 mod . 1+ dup 20 = until drop cr', 'begin 0 until', '1 2 3 . . .']
  const a = fresh(), b = fresh()
  for (const l of lines) assert.deepEqual(a.run(l), b.run(l), l)
  const c = fresh()
  const first = lines.map((l) => c.run(l))
  c.reset()
  assert.deepEqual(lines.map((l) => c.run(l)), first, 'and the same again after reset')
})

test('Turing-completeness witness: an interpreter for a small tape machine, written in R0, runs a program', () => {
  // The machine: a program of codes at cells 100.., a tape at 2000.., the program counter at 0, the data pointer
  // at 1, a bracket depth at 2. Codes: 1 right, 2 left, 3 up, 4 down, 5 print, 6 loop while the cell is not zero,
  // 7 end of loop, 0 halt. Loops nest: skipping forward and jumping back count brackets.
  const m = fresh()
  const interpreter = [
    ': pc 0 ; : dp 1 ; : lvl 2 ;',
    ': prog 100 + ; : ins pc @ prog @ ; : cell dp @ 2000 + ;',
    ': fwd 1 lvl ! begin pc @ 1+ pc ! ins 6 = if 1 lvl +! then ins 7 = if -1 lvl +! then lvl @ 0 = until ;',
    ': back 1 lvl ! begin pc @ 1- pc ! ins 7 = if 1 lvl +! then ins 6 = if -1 lvl +! then lvl @ 0 = until ;',
    ': step ins dup 1 = if 1 dp +! then dup 2 = if -1 dp +! then dup 3 = if 1 cell +! then dup 4 = if -1 cell +! then'
      + ' dup 5 = if cell @ emit then dup 6 = if cell @ 0 = if fwd then then 7 = if cell @ 0 <> if back then then pc @ 1+ pc ! ;',
    ': runprog 0 pc ! 0 dp ! begin step ins 0 = until ;',
  ]
  for (const l of interpreter) assert.equal(say(m, l), '')
  // The program: eight ups, then a loop adding nine to the next cell per pass (72 = H), print, up, print (I);
  // then a nested loop that clears two cells and prints '!' (33 = 3 * 11) after it.
  const codes = (text: string): number[] => [...text].map((c) => '><+-.[]'.indexOf(c) + 1)
  const program = codes('++++++++[>+++++++++<-]>.+.>+++[>+++++++++++<-]>.')
  const load = [...program, 0].map((c, i) => `${c} ${100 + i} !`).join(' ')
  assert.equal(say(m, load), '')
  const r = m.run('runprog')
  assert.equal(r.error, undefined)
  assert.deepEqual(r.out, ['HI!'])
  assert.ok(r.steps > 1000 && r.steps < REPL.maxSteps, `${r.steps} steps`)
  // Another program through the same interpreter: the tape cell doubles 1 → 64 ('@'), then prints the digits 0-4.
  const second = codes('+[>++<-]>[<+>-]<[>++<-]>[<+>-]<[>++<-]>[<+>-]<[>++<-]>[<+>-]<[>++<-]>[<+>-]<[>++<-]>.>>++++++[>++++++++<-]+++++[>.+<-]')
  assert.equal(say(m, [...second, 0].map((c, i) => `${c} ${100 + i} !`).join(' ')), '')
  assert.equal(say(m, '0 2000 ! 0 2001 ! 0 2002 ! 0 2003 ! 0 2004 ! runprog'), '@01234')
})

test('air gap: repl.ts has no import line and names no door to the host', () => {
  const src = readFileSync(new URL('./repl.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /^\s*import\b/m, 'an import line')
  assert.doesNotMatch(src, /\bimport\s*\(|\brequire\s*\(/, 'a dynamic import')
  assert.doesNotMatch(src, /\b(Function|eval|globalThis|window|document|fetch|setTimeout|setInterval|queueMicrotask|requestAnimationFrame|Date|Math|XMLHttpRequest|WebSocket|Worker|localStorage|indexedDB|navigator|process|crypto)\b/, 'a host door')
  assert.match(src, /^(?:\/\/[^\n]*\n)*\/\*\*\n \* Why does this file exist\?/, 'the header (after the licence lines)')
  assert.match(src, /What breaks if it is removed\?/, 'the header')
  assert.doesNotMatch(src, /\bnew Function\b|\bwith\s*\(/)
})
