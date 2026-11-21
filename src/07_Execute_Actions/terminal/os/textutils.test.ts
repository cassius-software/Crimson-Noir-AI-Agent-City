// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It tests the text programs (textutils.ts) the way a person meets them: typed at the real
 * shell of a system held in memory, with what they print, the bytes they leave in a file and the status they end with
 * all checked. Every option of every program is used at least once, and so are the ways each one is refused or cut
 * short: a file that is not there among files that are, a directory where a file is wanted, input with no line end
 * at its end, no input at all, bytes that are no text, a line longer than one read (worked through a slice at a time,
 * so no turn holds the page up), an output that takes nothing, and a reader that takes one line of a large answer
 * and leaves.
 * What breaks if it is removed? A change to one of these programs could alter what a pipeline depends on (the text
 * of a count, an exit status, the words of a refusal) or lose bytes on the way through, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decode, encode } from './bytes.ts'
import { LOOK } from './kernel.ts'
import { boot } from './kit.test.ts'
import type { Kit } from './kit.test.ts'
import { TEXT_MANUAL, TEXT_PROGRAMS } from './textutils.ts'

/** A system with the text programs, its shell working in /tmp. */
function fresh(): Kit {
  const k = boot(TEXT_PROGRAMS)
  assert.deepEqual(k.sh('cd /tmp'), [])
  return k
}

/**
 * What a command printed, without the remark the shell itself adds when a program of a pipeline was ended by a
 * reader that left (`<shell>: <program>: broken pipe`): that line is the shell's, not the program's.
 */
const own = (lines: readonly string[]): string[] => lines.filter((l) => !/^![^ :]+: [^ :]+: broken pipe$/.test(l))

/** The names of the tasks that are running: only the first task and the shell once a command has ended. */
const tasks = (k: Kit): string[] => k.system.kernel.ps().map((p) => p.name)
const AT_REST = ['init', '-sh']

/** Bytes that are no text: every value, many times over, in an order that is not simply counting. */
function noise(length: number, seed = 7): Uint8Array {
  const out = new Uint8Array(length)
  let x = seed
  for (let i = 0; i < length; i++) {
    x = (x * 69069 + 12345) % 4294967296
    out[i] = Math.floor(x / 65536) & 255
  }
  return out
}

/** `n` lines, `line 00001` and so on: eleven bytes each. */
function numbered(n: number): string {
  let text = ''
  for (let i = 1; i <= n; i++) text += `line ${String(i).padStart(5, '0')}\n`
  return text
}

/** Fails unless two runs of bytes are the same. */
function same(actual: Uint8Array, expected: Uint8Array, what: string): void {
  assert.equal(actual.length, expected.length, `${what}: length`)
  for (let i = 0; i < expected.length; i++) if (actual[i] !== expected[i]) assert.fail(`${what}: byte ${i} is ${actual[i]}, not ${expected[i]}`)
}

/** The bytes a command wrote to its ordinary output, through a file; nothing else may have been printed (but the shell's remark above). */
function bytesOf(k: Kit, command: string): Uint8Array {
  assert.deepEqual(own(k.sh(`${command} > /tmp/.out`)), [], command)
  return k.bytes('/tmp/.out')
}

/** The same, as text. */
const textOf = (k: Kit, command: string): string => decode(bytesOf(k, command))

/**
 * Types a command line and runs the system in turns that each end at the first look at the clock (the deadline has
 * always passed, so a turn is at most LOOK calls): how many turns it took. A program that calls the kernel once for
 * every slice of its work takes a turn for every LOOK slices at least, so no turn holds the page up for more.
 */
function shortTurns(k: Kit, line: string): number {
  k.system.type(`${line}\n`)
  let n = 0
  while (!k.system.idle) {
    k.system.run(1_000_000, Number.NEGATIVE_INFINITY)
    n++
  }
  return n
}

/** A line folded at a width, built here from fold's description (characters, not code units), not from its code. */
function folded(line: string, width: number, words: boolean): string {
  const chars = Array.from(line)
  let out = ''
  let at = 0
  while (chars.length - at > width) {
    let to = at + width
    if (words) {
      for (let j = to - 1; j >= at; j--) {
        if (chars[j] !== ' ' && chars[j] !== '\t') continue
        to = j + 1
        break
      }
    }
    out += `${chars.slice(at, to).join('')}\n`
    at = to
  }
  return `${out}${chars.slice(at).join('')}\n`
}

/** One line of a dump in the canonical layout, built here from its description, not from the program's code. */
function dumpRow(offset: number, bytes: readonly number[]): string {
  let digits = ''
  let shown = ''
  for (let i = 0; i < 16; i++) {
    if (i === 8) digits += ' '
    const b = bytes[i]
    digits += b === undefined ? '   ' : `${b.toString(16).padStart(2, '0')} `
    if (b !== undefined) shown += b >= 32 && b < 127 ? String.fromCharCode(b) : '.'
  }
  return `${offset.toString(16).padStart(8, '0')}  ${digits} |${shown}|`
}

const NAMES = [
  'base64', 'cut', 'echo', 'fold', 'head', 'hexdump', 'nl', 'paste', 'printf', 'rev', 'seq', 'sha256sum', 'sort', 'tac', 'tail', 'tee', 'tr', 'uniq', 'wc',
  'xargs', 'yes',
]

// The manual, and what every program shares

test('manual: every program has a page, each in the one shape, plain and narrow', () => {
  assert.deepEqual(Object.keys(TEXT_PROGRAMS).sort(), NAMES)
  assert.deepEqual(Object.keys(TEXT_MANUAL).sort(), NAMES)
  assert.ok(Object.isFrozen(TEXT_PROGRAMS) && Object.isFrozen(TEXT_MANUAL))
  const order = ['NAME', 'USAGE', 'WHAT IT DOES', 'OPTIONS', 'NOTES', 'STATUS', 'EXAMPLE']
  for (const name of NAMES) {
    const page = TEXT_MANUAL[name]
    assert.ok(page.endsWith('\n') && !page.endsWith('\n\n') && !page.startsWith('\n'), name)
    const lines = page.split('\n')
    assert.equal(lines[0], 'NAME', name)
    assert.match(lines[1], new RegExp(`^    ${name} - [a-z][^.]*$`), name)
    assert.equal(lines[2], '', name)
    assert.equal(lines[3], 'USAGE', name)
    assert.ok(lines[4] === `    ${name}` || lines[4].startsWith(`    ${name} `), name)
    assert.equal(lines[5], '', name)
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
    assert.ok(lines[lines.indexOf('EXAMPLE') + 1].includes(name), name)
    assert.doesNotMatch(page, /https?:|www\./, name)
  }
})

test('manual: the usage line a wrong call prints is the one in the page, and the status is 2', () => {
  const k = fresh()
  const wrong: Record<string, string> = {
    head: 'head -z', tail: 'tail -z', wc: 'wc -z', sort: 'sort -z', uniq: 'uniq -z', cut: 'cut', tr: 'tr', tee: 'tee -z', tac: 'tac -z', rev: 'rev -z',
    nl: 'nl -z', fold: 'fold -z', paste: 'paste -z', seq: 'seq', printf: 'printf', base64: 'base64 -z', hexdump: 'hexdump -z', sha256sum: 'sha256sum -z',
    xargs: 'xargs -z',
  }
  for (const [name, line] of Object.entries(wrong)) {
    const out = k.sh(`${line}; echo $?`)
    const lines = TEXT_MANUAL[name].split('\n')
    assert.equal(out[out.length - 2], `!usage: ${lines[lines.indexOf('USAGE') + 1].trim()}`, name)
    assert.equal(out[out.length - 1], '2', name)
  }
  assert.deepEqual(k.sh('head -z'), ["!head: unknown option '-z'", '!usage: head [-n lines] [-c bytes] [file ...]'])
  assert.deepEqual(k.sh('fold -w'), ["!fold: option '-w' needs a value", '!usage: fold [-s] [-w width] [file ...]'])
  assert.deepEqual(k.sh('wc --lines'), ["!wc: unknown option '--lines'", '!usage: wc [-lwmc] [file ...]'])
})

test('every program: a directory, a missing file among good ones, and - for the input', () => {
  const k = fresh()
  k.write('/tmp/f', 'x\n')
  for (const name of ['head', 'tail', 'wc', 'sort', 'uniq', 'tac', 'rev', 'nl', 'fold', 'paste', 'base64', 'hexdump', 'sha256sum']) {
    assert.deepEqual(k.sh(`${name} /tmp; echo $?`), [`!${name}: /tmp: is a directory`, '1'], name)
    assert.deepEqual(k.sh(`${name} nosuch > /dev/null; echo $?`), [`!${name}: nosuch: no such file or directory`, '1'], name)
    // Named -, the input is read as if no file were named; wc and sha256sum then print the name - as well.
    if (name === 'wc' || name === 'sha256sum') continue
    assert.equal(textOf(k, `${name} - < f`), textOf(k, `${name} < f`), name)
  }
  assert.deepEqual(k.sh('wc < f; wc - < f'), ['1 1 2', '1 1 2 -'])
  const digest = k.sh('sha256sum < f')
  assert.match(digest[0], /^[0-9a-f]{64} {2}-$/)
  assert.deepEqual(k.sh('sha256sum - < f'), digest)
  for (const name of ['cut -c 1', 'cut -b 1', 'cut -f 1']) {
    assert.deepEqual(k.sh(`${name} /tmp; echo $?`), ['!cut: /tmp: is a directory', '1'], name)
    assert.deepEqual(k.sh(`${name} f nosuch f; echo $?`), ['x', '!cut: nosuch: no such file or directory', 'x', '1'], name)
  }
  // The files after the one that is not there are still read, and the complaint stands where that file would have.
  assert.deepEqual(k.sh('head f nosuch f; echo $?'), ['==> f <==', 'x', '!head: nosuch: no such file or directory', '', '==> f <==', 'x', '1'])
  assert.deepEqual(k.sh('tac f nosuch f; echo $?'), ['x', '!tac: nosuch: no such file or directory', 'x', '1'])
  assert.deepEqual(k.sh('rev f nosuch f; echo $?'), ['x', '!rev: nosuch: no such file or directory', 'x', '1'])
  assert.deepEqual(k.sh('nl f nosuch f; echo $?'), ['     1  x', '!nl: nosuch: no such file or directory', '     2  x', '1'])
  assert.deepEqual(k.sh('fold f nosuch f; echo $?'), ['x', '!fold: nosuch: no such file or directory', 'x', '1'])
  assert.deepEqual(k.sh('uniq f; uniq nosuch; echo $?'), ['x', '!uniq: nosuch: no such file or directory', '1'])
  assert.deepEqual(k.sh('wc -l f nosuch f; echo $?'), ['!wc: nosuch: no such file or directory', '1 f', '1 f', '2 total', '1'])
  assert.deepEqual(k.sh('hexdump f nosuch f; echo $?'), ['!hexdump: nosuch: no such file or directory', dumpRow(0, [0x78, 10, 0x78, 10]), '00000004', '1'])
  assert.deepEqual(tasks(k), AT_REST)
})

test('every program: an output that takes nothing is reported once, as a write error, with status 1', () => {
  const k = fresh()
  k.write('/tmp/f', 'a b\nc d\n')
  const lines = [
    'head f', 'head -c 3 f', 'tail f', 'tail -c 3 f', 'tail -n +1 f', 'wc f', 'sort f', 'uniq f', 'cut -c 1 f', 'cut -b 1 f', 'cut -f 1 f',
    'tr a b < f', 'tac f', 'rev f', 'nl f', 'fold f', 'paste f', 'paste -s f', 'seq 3', 'yes', '/bin/echo hi', 'printf hi', 'base64 f', 'hexdump f',
    'sha256sum f',
  ]
  for (const line of lines) {
    const name = line.split(' ')[0].replace('/bin/', '')
    assert.deepEqual(k.sh(`${line} > /dev/full; echo $?`), [`!${name}: write error: no space left on device`, '1'], line)
  }
  k.write('/tmp/f', 'aGk=\n')
  assert.deepEqual(k.sh('base64 -d f > /dev/full; echo $?'), ['!base64: write error: no space left on device', '1'])
  // tee goes on copying to the places that still take what it writes.
  assert.deepEqual(k.sh('seq 3 | tee one > /dev/full; echo $?'), ['!tee: write error: no space left on device', '1'])
  assert.equal(k.read('/tmp/one'), '1\n2\n3\n')
  // xargs writes nothing itself: the command it ran says so, and xargs gives the status for a run that failed.
  assert.deepEqual(k.sh('seq 3 | xargs > /dev/full; echo $?'), ['!echo: write error: no space left on device', '123'])
  assert.deepEqual(tasks(k), AT_REST)
})

test('a reader that takes one line and leaves ends every program, and soon', () => {
  const k = fresh()
  k.write('/tmp/big', numbered(40000))
  const first: Record<string, string> = {
    'head -n 39000 big': 'line 00001',
    'head -c 400000 big': 'line 00001',
    'tail -n +2 big': 'line 00002',
    'tail -n 39000 big': 'line 01001',
    // The last 400000 of the 440000 bytes start four bytes into line 3637.
    'tail -c 400000 big': ' 03637',
    'tail -c +5 big': ' 00001',
    'sort -r big': 'line 40000',
    'uniq big': 'line 00001',
    'cut -c 6- big': '00001',
    'cut -b 6- big': '00001',
    "cut -d ' ' -f 2 big": '00001',
    'tr a-z A-Z < big': 'LINE 00001',
    'tee < big': 'line 00001',
    'tee kept < big': 'line 00001',
    'tac big': 'line 40000',
    'rev big': '10000 enil',
    'nl -w 3 big': '  1     line 00001',
    'fold -w 4 big': 'line',
    'paste -d = big big': 'line 00001=line 00001',
    'base64 big': 'bGluZSAwMDAwMQpsaW5lIDAwMDAyCmxpbmUgMDAwMDMKbGluZSAwMDAwNApsaW5lIDAwMDA1Cmxp',
    'hexdump big': dumpRow(0, [...encode('line 00001\nline ')]),
    'xargs -n 2 < big': 'line 00001',
    "xargs -I @ echo '<@>' < big": '<line 00001>',
    'seq 1 100000000': '1',
    'seq -w 1 100000000': '000000001',
    'seq -s , 1 100000000 | tr , "\\n"': '1',
    'yes': 'y',
    'yes a  b': 'a b',
    "printf '%s\\n' $(head -n 9000 big)": 'line',
  }
  for (const [line, want] of Object.entries(first)) {
    assert.deepEqual(own(k.sh(`${line} | head -n 1`)), [want], line)
    assert.deepEqual(tasks(k), AT_REST, line)
  }
  // The reader may also be one of these programs taking bytes.
  assert.deepEqual(own(k.sh('yes abc | head -c 8')), ['abc', 'abc'])
  assert.deepEqual(own(k.sh('seq 1 100000000 | tail -n +5 | head -n 2')), ['5', '6'])
  assert.deepEqual(tasks(k), AT_REST)
})

test('a program that never ends by itself is ended by Ctrl+C', () => {
  const k = fresh()
  k.system.type('yes | tr y n | uniq > /dev/null')
  // A few calls at a time, only until all three are running: they would never stop by themselves.
  for (let i = 0; i < 100 && tasks(k).length < 5; i++) k.system.run(20, Number.POSITIVE_INFINITY)
  k.system.run(200, Number.POSITIVE_INFINITY)
  assert.deepEqual(tasks(k), ['init', '-sh', 'yes', 'tr', 'uniq'])
  assert.equal(k.system.interrupt(), true)
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(tasks(k), AT_REST)
  assert.deepEqual(k.sh('echo $?'), ['130'])
})

test('at the terminal each line typed is answered at once, not when the input ends', () => {
  const k = fresh()
  assert.deepEqual(k.sh('tr a-z A-Z'), [])
  assert.deepEqual(k.sh('hello'), ['HELLO'])
  assert.deepEqual(k.sh('world'), ['WORLD'])
  k.system.end()
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(tasks(k), AT_REST)
  assert.deepEqual(k.sh('head -n 2'), [])
  assert.deepEqual(k.sh('one'), ['one'])
  assert.deepEqual(k.sh('two'), ['two'])
  assert.deepEqual(tasks(k), AT_REST)
  const typed: readonly (readonly [string, string, readonly string[]])[] = [
    ['cut -c 2-', 'abc', ['bc']], ['rev', 'abc', ['cba']], ['nl', 'abc', ['     1  abc']], ['fold -w 2', 'abc', ['ab', 'c']], ['tee', 'abc', ['abc']],
    ['uniq', 'abc', []], ['tac', 'abc', []], ['paste -s', 'abc', []],
  ]
  for (const [line, text, answer] of typed) {
    assert.deepEqual(k.sh(line), [], line)
    assert.deepEqual(k.sh(text), answer, line)
    k.system.end()
    // What could not be answered before the input ended (the line uniq holds, the lines tac and paste -s wait for) comes now.
    assert.deepEqual(k.settle(), answer.length > 0 ? [] : ['abc'], line)
    assert.deepEqual(tasks(k), AT_REST, line)
  }
  assert.deepEqual(k.sh('xargs -n 1 echo got'), [])
  assert.deepEqual(k.sh('a "b c"'), ['got a', 'got b c'])
  k.system.end()
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(k.sh('echo $?'), ['0'])
})

test('a line longer than one read goes through whole, and the limit of a line is the one the pages give', () => {
  const k = fresh()
  const long = `${'ab'.repeat(150000)}\n`
  k.write('/tmp/long', `${long}end\n`)
  assert.equal(textOf(k, 'head -n 1 long'), long)
  assert.equal(textOf(k, 'tail -n 2 long'), `${long}end\n`)
  assert.equal(textOf(k, 'tail -n +2 long'), 'end\n')
  assert.equal(textOf(k, 'tac long'), `end\n${long}`)
  assert.equal(textOf(k, 'sort long'), `${long}end\n`)
  assert.equal(textOf(k, 'sort -r long'), `end\n${long}`)
  assert.equal(textOf(k, 'uniq long'), `${long}end\n`)
  assert.equal(textOf(k, 'rev long'), `${'ba'.repeat(150000)}\ndne\n`)
  assert.equal(textOf(k, 'tr ab ba < long'), `${'ba'.repeat(150000)}\nend\n`)
  assert.equal(textOf(k, 'cut -c 299999- long'), 'ab\n\n')
  assert.equal(textOf(k, 'cut -b 299999- long'), 'ab\n\n')
  // The 150000th field is the last a; the 150001st is the nothing after the last b.
  assert.equal(textOf(k, 'cut -d b -f 150000- long'), 'ab\nend\n')
  assert.equal(textOf(k, 'fold -w 100000 long'), `${'ab'.repeat(50000)}\n${'ab'.repeat(50000)}\n${'ab'.repeat(50000)}\nend\n`)
  assert.equal(textOf(k, 'paste -s -d + long'), `${long.slice(0, -1)}+end\n`)
  assert.deepEqual(k.sh('wc long'), ['     2      2 300005 long'])
  // The number, a tab and the first letter: the terminal shows the tab as blanks to the eighth column.
  assert.deepEqual(k.sh('nl long | cut -c 1-8'), ['     1  a', '     2  e'])
  assert.deepEqual(k.sh('xargs < long; echo $?'), ['!xargs: a word of the input is too long for one run (65536 bytes with the command)', '1'])
  // A program that reads a line at a time may cut a line past 1048576 characters (this one, long enough, always is);
  // the ones that work on bytes never do.
  k.write('/tmp/huge', `${'x'.repeat(1048576 + 70000)}\n`)
  assert.deepEqual(k.sh('nl huge | cut -c 1-8'), ['     1  x', '     2  x'])
  assert.deepEqual(k.sh('uniq -c huge | cut -c 1-3; rev huge | wc -l; fold -w 2000000 huge | wc -l; paste huge | wc -l'), ['1 x', '1 x', '2', '2', '2'])
  assert.deepEqual(k.sh('head -n 1 huge | wc; tail -n 1 huge | wc -l; tac huge | wc -l; sort huge | wc -l; cut -c 2- huge | wc; tr x y < huge | wc -l'),
    ['      1       1 1118577', '1', '1', '1', '      1       1 1118576', '1'])
})

test('what would not fit in memory is refused, not held', () => {
  const k = fresh()
  assert.deepEqual(k.sh('tac /dev/zero; echo $?'), ['!tac: /dev/zero: too much to hold in memory', '1'])
  assert.deepEqual(k.sh('tail -n 1 /dev/zero; echo $?'), ['!tail: /dev/zero: too much to hold in memory', '1'])
  assert.deepEqual(tasks(k), AT_REST)
})

// head

test('head: the first lines, by count', () => {
  const k = fresh()
  k.write('/tmp/f', 'a\nb\nc\n')
  k.write('/tmp/twelve', numbered(12))
  assert.deepEqual(k.sh('head -n 2 /tmp/f'), ['a', 'b'])
  assert.deepEqual(k.sh('head /nosuch; echo $?'), ['!head: /nosuch: no such file or directory', '1'])
  assert.deepEqual(k.sh('head twelve'), numbered(10).trimEnd().split('\n'))
  assert.deepEqual(k.sh('head -3 twelve; head -n3 twelve'), ['line 00001', 'line 00002', 'line 00003', 'line 00001', 'line 00002', 'line 00003'])
  assert.deepEqual(k.sh('head -n 99 f; echo $?'), ['a', 'b', 'c', '0'])
  assert.deepEqual(k.sh('head -n 0 f; echo $?'), ['0'])
  assert.deepEqual(k.sh('head -n 1 < f; head -n 1 - < f'), ['a', 'a'])
  assert.deepEqual(k.sh('head -n 1 f twelve - < f'), ['==> f <==', 'a', '', '==> twelve <==', 'line 00001', '', '==> standard input <==', 'a'])
  assert.deepEqual(k.sh('head -n 1 f /tmp twelve; echo $?'), ['==> f <==', 'a', '!head: /tmp: is a directory', '', '==> twelve <==', 'line 00001', '1'])
})

test('head: what it read past its last line is left in a shared file for the next command; a pipe cannot be', () => {
  const k = fresh()
  k.write('/tmp/f', 'a\nb\nc\n')
  assert.deepEqual(k.sh('{ head -n 1; head -n 1; } < f'), ['a', 'b'])
  assert.deepEqual(k.sh('{ head -n 1 > /dev/null; read x; echo "[$x]"; } < f'), ['[b]'])
  assert.deepEqual(k.sh('{ head -n 2 > /dev/null; tail -n 9; } < f'), ['c'])
  assert.deepEqual(k.sh('{ head -c 2; head -n 1; } < f'), ['a', 'b'])
  assert.deepEqual(k.sh('{ head -n 9; head -n 1; echo $?; } < f'), ['a', 'b', 'c', '0'])
  assert.deepEqual(k.sh('seq 3 | { head -n 1; head -n 1; echo $?; }'), ['1', '0'])
})

test('head: bytes with -c, input without a line end, no input, and bytes that are no text', () => {
  const k = fresh()
  k.write('/tmp/f', 'a\nb\nc')
  k.write('/tmp/empty', '')
  assert.equal(textOf(k, 'head -c 3 f'), 'a\nb')
  assert.equal(textOf(k, 'head -c 0 f'), '')
  assert.equal(textOf(k, 'head -c 99 f'), 'a\nb\nc')
  assert.equal(textOf(k, 'head -c3 f f'), '==> f <==\na\nb\n==> f <==\na\nb')
  assert.equal(textOf(k, 'head -n 3 f'), 'a\nb\nc')
  assert.equal(textOf(k, 'head -n 2 f'), 'a\nb\n')
  assert.equal(textOf(k, 'head empty'), '')
  assert.equal(textOf(k, 'head -c 5 empty'), '')
  assert.equal(textOf(k, 'head -n 1 empty f'), '==> empty <==\n\n==> f <==\na\n')
  const raw = noise(200000)
  raw[150000] = 10
  k.write('/tmp/raw', raw)
  same(bytesOf(k, 'head -c 70000 raw'), raw.subarray(0, 70000), 'head -c')
  same(bytesOf(k, 'head -c 70000 < raw'), raw.subarray(0, 70000), 'head -c, from the input')
  let lines = 0
  let end = 0
  while (lines < 300) if (raw[end++] === 10) lines++
  same(bytesOf(k, 'head -n 300 raw'), raw.subarray(0, end), 'head -n')
  assert.ok(end > 65536)
})

test('head: wrong counts are refused; with -c and -n both, -c counts', () => {
  const k = fresh()
  k.write('/tmp/f', 'a\nb\nc\n')
  const usage = '!usage: head [-n lines] [-c bytes] [file ...]'
  assert.deepEqual(k.sh('head -n x f; echo $?'), ["!head: option '-n' needs a whole number, not 'x'", usage, '2'])
  assert.deepEqual(k.sh('head -c -1 f; echo $?'), ["!head: option '-c' needs a whole number, not '-1'", usage, '2'])
  assert.deepEqual(k.sh('head -n 1.5 f; echo $?'), ["!head: option '-n' needs a whole number, not '1.5'", usage, '2'])
  assert.deepEqual(k.sh('head -n; echo $?'), ["!head: option '-n' needs a value", usage, '2'])
  assert.deepEqual(k.sh('head -c 2 -n 3 f; head -n 3 -c 2 f'), ['a', 'a'])
  assert.deepEqual(k.sh('head -n 1 -- f'), ['a'])
})

// tail

test('tail: the last lines, by count, and from a line on', () => {
  const k = fresh()
  k.write('/tmp/twelve', numbered(12))
  k.write('/tmp/f', 'a\nb\nc\n')
  assert.deepEqual(k.sh('tail twelve'), numbered(12).trimEnd().split('\n').slice(2))
  assert.deepEqual(k.sh('tail -n 2 twelve; tail -2 twelve; tail -n -2 twelve'), ['line 00011', 'line 00012', 'line 00011', 'line 00012',
    'line 00011', 'line 00012'])
  assert.deepEqual(k.sh('tail -n +11 twelve'), ['line 00011', 'line 00012'])
  assert.deepEqual(k.sh('tail -n +1 f; tail -n +0 f'), ['a', 'b', 'c', 'a', 'b', 'c'])
  assert.deepEqual(k.sh('tail -n +4 f; tail -n +99 f; echo $?'), ['0'])
  assert.deepEqual(k.sh('tail -n 99 f'), ['a', 'b', 'c'])
  assert.deepEqual(k.sh('tail -n 0 f; echo $?'), ['0'])
  assert.deepEqual(k.sh('tail -n 1 < f; tail -n 1 - < f'), ['c', 'c'])
  assert.deepEqual(k.sh('tail -n 1 f twelve - < f'), ['==> f <==', 'c', '', '==> twelve <==', 'line 00012', '', '==> standard input <==', 'c'])
  assert.deepEqual(k.sh('tail -n 1 f nosuch /tmp twelve; echo $?'),
    ['==> f <==', 'c', '!tail: nosuch: no such file or directory', '!tail: /tmp: is a directory', '', '==> twelve <==', 'line 00012', '1'])
})

test('tail: bytes with -c, input without a line end, no input, and bytes that are no text', () => {
  const k = fresh()
  k.write('/tmp/f', 'a\nb\nc')
  k.write('/tmp/empty', '')
  assert.equal(textOf(k, 'tail -n 1 f'), 'c')
  assert.equal(textOf(k, 'tail -n 2 f'), 'b\nc')
  assert.equal(textOf(k, 'tail -n 3 f'), 'a\nb\nc')
  assert.equal(textOf(k, 'tail -n +3 f'), 'c')
  assert.equal(textOf(k, 'tail -c 3 f'), 'b\nc')
  assert.equal(textOf(k, 'tail -c 0 f'), '')
  assert.equal(textOf(k, 'tail -c 99 f'), 'a\nb\nc')
  assert.equal(textOf(k, 'tail -c +3 f'), 'b\nc')
  assert.equal(textOf(k, 'tail -c +1 f'), 'a\nb\nc')
  assert.equal(textOf(k, 'tail -c +99 f'), '')
  assert.equal(textOf(k, 'tail empty'), '')
  assert.equal(textOf(k, 'tail -c 4 empty'), '')
  assert.equal(textOf(k, 'tail -n +2 empty'), '')
  k.write('/tmp/blank', '\n\n\n')
  assert.equal(textOf(k, 'tail -n 2 blank'), '\n\n')
  const raw = noise(300000, 99)
  k.write('/tmp/raw', raw)
  same(bytesOf(k, 'tail -c 170000 raw'), raw.subarray(130000), 'tail -c')
  same(bytesOf(k, 'tail -c 170000 < raw'), raw.subarray(130000), 'tail -c, from the input')
  same(bytesOf(k, 'tail -c +130001 raw'), raw.subarray(130000), 'tail -c +')
  // The last 600 lines, found by hand: they start after the 601st line end from the end, or the 600th when the last line has none.
  let need = 600 + (raw[raw.length - 1] === 10 ? 1 : 0)
  let start = raw.length
  while (need > 0) if (raw[--start] === 10) need--
  same(bytesOf(k, 'tail -n 600 raw'), raw.subarray(start + 1), 'tail -n')
  assert.ok(raw.length - start > 131072)
  let skip = 0
  let from = 0
  while (skip < 599) if (raw[from++] === 10) skip++
  same(bytesOf(k, 'tail -n +600 raw'), raw.subarray(from), 'tail -n +')
})

test('tail: the end of a large file, wrong counts, and no way to follow a file', () => {
  const k = fresh()
  k.write('/tmp/big', numbered(40000))
  assert.deepEqual(k.sh('tail -n 2 big; tail -n +40000 big; tail -c 6 big'), ['line 39999', 'line 40000', 'line 40000', '40000'])
  assert.deepEqual(own(k.sh('tail -n 30000 big | head -n 1; tail -n 30000 big | wc -l')), ['line 10001', '30000'])
  assert.deepEqual(k.sh('seq 1 200000 | tail -n 3'), ['199998', '199999', '200000'])
  const usage = '!usage: tail [-n lines] [-c bytes] [file ...]'
  assert.deepEqual(k.sh('tail -n x big; echo $?'), ["!tail: option '-n' needs a whole number, with a + before it to count from the start, not 'x'", usage, '2'])
  assert.deepEqual(k.sh('tail -c +-1 big; echo $?'),
    ["!tail: option '-c' needs a whole number, with a + before it to count from the start, not '+-1'", usage, '2'])
  assert.deepEqual(k.sh('tail -f big; echo $?'), ["!tail: unknown option '-f'", usage, '2'])
  assert.ok(TEXT_MANUAL.tail.includes('there is no -f'))
})

// wc

test('wc: lines, words and bytes, each alone, and characters', () => {
  const k = fresh()
  k.write('/tmp/f', 'one two\n  three\n\nfour\tfive\n')
  assert.deepEqual(k.sh('wc f'), [' 4  5 27 f'])
  assert.deepEqual(k.sh('wc -l f; wc -w f; wc -c f; wc -m f'), ['4 f', '5 f', '27 f', '27 f'])
  assert.deepEqual(k.sh('wc -lc f; wc -cl f; wc -wl f; wc -lwmc f'), [' 4 27 f', ' 4 27 f', '4 5 f', ' 4  5 27 27 f'])
  assert.deepEqual(k.sh('wc < f; wc -l < f; wc - < f'), [' 4  5 27', '4', ' 4  5 27 -'])
  k.write('/tmp/u', 'h\u00e9llo w\u00f6rld \u{1f600}\n')
  assert.deepEqual(k.sh('wc -m u; wc -c u; wc -mc u; wc -w u'), ['14 u', '19 u', '14 19 u', '3 u'])
})

test('wc: several files and their total, lined up; no input; input without a line end; bytes that are no text', () => {
  const k = fresh()
  k.write('/tmp/f', 'a\nb\nc')
  k.write('/tmp/empty', '')
  k.write('/tmp/big', numbered(12345))
  assert.deepEqual(k.sh('wc f; wc empty; wc -l empty'), ['2 3 5 f', '0 0 0 empty', '0 empty'])
  assert.deepEqual(k.sh('wc f empty big'), ['     2      3      5 f', '     0      0      0 empty', ' 12345  24690 135795 big', ' 12347  24693 135800 total'])
  assert.deepEqual(k.sh('wc -l f nosuch /tmp big; echo $?'),
    ['!wc: nosuch: no such file or directory', '!wc: /tmp: is a directory', '    2 f', '12345 big', '12347 total', '1'])
  assert.deepEqual(k.sh('wc -l nosuch; echo $?'), ['!wc: nosuch: no such file or directory', '1'])
  assert.deepEqual(k.sh('seq 1 100000 | wc'), ['100000 100000 588895'])
  const raw = noise(200000, 3)
  k.write('/tmp/raw', raw)
  let lines = 0
  let words = 0
  let chars = 0
  let inWord = false
  for (const b of raw) {
    if (b === 10) lines++
    if (b === 32 || (b >= 9 && b <= 13)) inWord = false
    else if (!inWord) { inWord = true; words++ }
    if ((b & 0xc0) !== 0x80) chars++
  }
  assert.deepEqual(k.sh('wc -lwmc raw'), [`${[lines, words, chars, 200000].map((v) => String(v).padStart(6)).join(' ')} raw`])
  assert.deepEqual(k.sh('wc -c /dev/null; wc /dev/null'), ['0 /dev/null', '0 0 0 /dev/null'])
})

// sort

test('sort: by character code, turned round, and as numbers', () => {
  const k = fresh()
  k.write('/tmp/f', 'pear\nApple\n10\n9\napple\n Zed\n\nbanana\n')
  assert.deepEqual(k.sh('sort f'), ['', ' Zed', '10', '9', 'Apple', 'apple', 'banana', 'pear'])
  assert.deepEqual(k.sh('sort -r f'), ['pear', 'banana', 'apple', 'Apple', '9', '10', ' Zed', ''])
  assert.deepEqual(k.sh('sort < f | head -n 3; sort - < f | head -n 3'), ['', ' Zed', '10', '', ' Zed', '10'])
  k.write('/tmp/n', '10\n9\n-3\n2.5\nabc\n  7 apples\n2.50\n-0.5\n.5\n1e3\n')
  assert.deepEqual(k.sh('sort -n n'), ['-3', '-0.5', 'abc', '.5', '1e3', '2.5', '2.50', '  7 apples', '9', '10'])
  assert.deepEqual(k.sh('sort -nr n'), ['10', '9', '  7 apples', '2.5', '2.50', '1e3', '.5', 'abc', '-0.5', '-3'])
  assert.deepEqual(k.sh('sort -n -u n'), ['-3', '-0.5', 'abc', '.5', '1e3', '2.5', '  7 apples', '9', '10'])
})

test('sort: -u, -f, -b, fields with -k and -t, and equal lines kept in their order', () => {
  const k = fresh()
  k.write('/tmp/f', 'b\na\nB\nb\nA\na\n')
  assert.deepEqual(k.sh('sort -u f'), ['A', 'B', 'a', 'b'])
  assert.deepEqual(k.sh('sort -f f'), ['a', 'A', 'a', 'b', 'B', 'b'])
  assert.deepEqual(k.sh('sort -fu f'), ['a', 'b'])
  assert.deepEqual(k.sh('sort -fr f'), ['b', 'B', 'b', 'a', 'A', 'a'])
  k.write('/tmp/b', '  b\na\n c\n')
  assert.deepEqual(k.sh('sort b'), ['  b', ' c', 'a'])
  assert.deepEqual(k.sh('sort -b b'), ['a', '  b', ' c'])
  k.write('/tmp/t', 'x:30:c\ny:4:a\nz:30:b\nw:100:a\nv\n')
  assert.deepEqual(k.sh('sort -t : -k 2 t'), ['v', 'w:100:a', 'z:30:b', 'x:30:c', 'y:4:a'])
  assert.deepEqual(k.sh('sort -t : -k 2 -n t'), ['v', 'y:4:a', 'x:30:c', 'z:30:b', 'w:100:a'])
  assert.deepEqual(k.sh('sort -t: -k3 t'), ['v', 'y:4:a', 'w:100:a', 'z:30:b', 'x:30:c'])
  assert.deepEqual(k.sh('sort -t : -k 2 -n -r t'), ['w:100:a', 'x:30:c', 'z:30:b', 'y:4:a', 'v'])
  assert.deepEqual(k.sh('sort -t : -k 2 -n -u t'), ['v', 'y:4:a', 'x:30:c', 'w:100:a'])
  assert.deepEqual(k.sh('sort -t : -k 9 t'), ['x:30:c', 'y:4:a', 'z:30:b', 'w:100:a', 'v'])
  // Without -t a field takes the blanks before it with it, which -b leaves out of the comparison.
  k.write('/tmp/w', 'one   b\ntwo  c\nthree a\n')
  assert.deepEqual(k.sh('sort -k 2 w'), ['one   b', 'two  c', 'three a'])
  assert.deepEqual(k.sh('sort -b -k 2 w'), ['three a', 'one   b', 'two  c'])
  assert.deepEqual(k.sh('sort -k 2 -n w'), ['one   b', 'two  c', 'three a'])
})

test('sort: several files, no input, input without a line end, text that is not ASCII', () => {
  const k = fresh()
  k.write('/tmp/a', 'm\nc\n')
  k.write('/tmp/b', 'x\nb')
  k.write('/tmp/empty', '')
  assert.equal(textOf(k, 'sort a b'), 'b\nc\nm\nx\n')
  assert.equal(textOf(k, 'sort b'), 'b\nx\n')
  assert.equal(textOf(k, 'sort empty'), '')
  assert.equal(textOf(k, 'sort empty a empty'), 'c\nm\n')
  assert.equal(textOf(k, 'sort - a < b'), 'b\nc\nm\nx\n')
  // By UTF-16 code unit: a character past U+FFFF (two units, the first from D800) sorts before U+FFxx.
  k.write('/tmp/u', '\u00e9t\u00e9\nzebra\n\u{1f600}\n\u4e2d\n\uff21\n')
  assert.equal(textOf(k, 'sort u'), 'zebra\n\u00e9t\u00e9\n\u4e2d\n\u{1f600}\n\uff21\n')
  assert.equal(textOf(k, 'sort -f u'), 'zebra\n\u00e9t\u00e9\n\u4e2d\n\u{1f600}\n\uff21\n')
  k.write('/tmp/bad', new Uint8Array([98, 10, 0xff, 10, 97, 10]))
  assert.equal(textOf(k, 'sort bad'), 'a\nb\n\ufffd\n')
})

test('sort: a file that cannot be read means nothing is printed; wrong options; a large input', () => {
  const k = fresh()
  k.write('/tmp/a', 'm\nc\n')
  const usage = '!usage: sort [-rnufb] [-k field] [-t separator] [file ...]'
  assert.deepEqual(k.sh('sort a nosuch a; echo $?'), ['!sort: nosuch: no such file or directory', '1'])
  assert.deepEqual(k.sh('sort -k 0 a; echo $?'), ["!sort: option '-k' needs a whole number of 1 or more, not '0'", usage, '2'])
  assert.deepEqual(k.sh('sort -k 2,3 a; echo $?'), ["!sort: option '-k' needs a whole number of 1 or more, not '2,3'", usage, '2'])
  assert.deepEqual(k.sh('sort -t ab a; echo $?'), ["!sort: option '-t' needs one character, not 'ab'", usage, '2'])
  assert.deepEqual(k.sh("sort -t '' a; echo $?"), ["!sort: option '-t' needs one character, not ''", usage, '2'])
  assert.deepEqual(k.sh('sort -o x a; echo $?'), ["!sort: unknown option '-o'", usage, '2'])
  // 30000 lines in an order that is far from sorted, with every line there twice.
  let text = ''
  for (let i = 0; i < 30000; i++) text += `${(i * 7919) % 15000}\n`
  k.write('/tmp/big', text)
  const sorted = textOf(k, 'sort -n big').split('\n')
  assert.equal(sorted.length, 30001)
  for (let i = 0; i < 30000; i++) if (sorted[i] !== String(i >> 1)) assert.fail(`line ${i + 1} is ${sorted[i]}`)
  assert.deepEqual(own(k.sh('sort -n -u big | wc -l; sort big | head -n 3; sort -rn big | head -n 2')), ['15000', '0', '0', '1', '14999', '14999'])
  assert.deepEqual(tasks(k), AT_REST)
})

// uniq

test('uniq: repeats next to each other, counted, only repeats, only singles, and without regard to case', () => {
  const k = fresh()
  k.write('/tmp/f', 'a\na\nb\nA\na\na\na\n\n\nc\n')
  assert.deepEqual(k.sh('uniq f'), ['a', 'b', 'A', 'a', '', 'c'])
  assert.deepEqual(k.sh('uniq -c f'), ['2 a', '1 b', '1 A', '3 a', '2 ', '1 c'])
  assert.deepEqual(k.sh('uniq -d f'), ['a', 'a', ''])
  assert.deepEqual(k.sh('uniq -u f'), ['b', 'A', 'c'])
  assert.deepEqual(k.sh('uniq -d -u f; echo $?'), ['0'])
  assert.deepEqual(k.sh('uniq -i f'), ['a', 'b', 'A', '', 'c'])
  assert.deepEqual(k.sh('uniq -ic f'), ['2 a', '1 b', '4 A', '2 ', '1 c'])
  assert.deepEqual(k.sh('uniq -cd f; uniq -cu f'), ['2 a', '3 a', '2 ', '1 b', '1 A', '1 c'])
  assert.deepEqual(k.sh('uniq < f | wc -l; uniq - < f | wc -l'), ['6', '6'])
})

test('uniq: no input, input without a line end, one file only', () => {
  const k = fresh()
  k.write('/tmp/empty', '')
  k.write('/tmp/f', 'x\nx\ny\ny')
  assert.equal(textOf(k, 'uniq empty'), '')
  assert.equal(textOf(k, 'uniq -c empty'), '')
  assert.equal(textOf(k, 'uniq f'), 'x\ny\n')
  assert.equal(textOf(k, 'uniq -c f'), '2 x\n2 y\n')
  assert.deepEqual(k.sh('uniq f g; echo $?'), ['!uniq: only one file can be named', '!usage: uniq [-cdui] [file]', '2'])
  assert.deepEqual(k.sh('uniq nosuch; echo $?'), ['!uniq: nosuch: no such file or directory', '1'])
  k.write('/tmp/u', '\u00e9\n\u00c9\n\u00e9\n')
  assert.deepEqual(k.sh('uniq -c u; uniq -ci u'), ['1 \u00e9', '1 \u00c9', '1 \u00e9', '3 \u00e9'])
  assert.deepEqual(own(k.sh('yes | head -n 100000 | uniq -c')), ['100000 y'])
})

// cut

test('cut: fields, with a separator of choice, and lines that have none', () => {
  const k = fresh()
  k.write('/tmp/f', 'a:b:c:d\nno separator\n1:2\n:x:\n\n')
  assert.deepEqual(k.sh('cut -d : -f 1 f'), ['a', 'no separator', '1', '', ''])
  assert.deepEqual(k.sh('cut -d : -f 2 f'), ['b', 'no separator', '2', 'x', ''])
  assert.deepEqual(k.sh('cut -d : -f 2 -s f'), ['b', '2', 'x'])
  assert.deepEqual(k.sh('cut -d: -f1,3 f'), ['a:c', 'no separator', '1', ':', ''])
  assert.deepEqual(k.sh('cut -d : -f 2- f'), ['b:c:d', 'no separator', '2', 'x:', ''])
  assert.deepEqual(k.sh('cut -d : -f -2 f'), ['a:b', 'no separator', '1:2', ':x', ''])
  assert.deepEqual(k.sh('cut -d : -f 3-4,1 f'), ['a:c:d', 'no separator', '1', ':', ''])
  assert.deepEqual(k.sh('cut -d : -f 2-3,3-4,1-1 f'), ['a:b:c:d', 'no separator', '1:2', ':x:', ''])
  assert.deepEqual(k.sh('cut -d : -f 9 f'), ['', 'no separator', '', '', ''])
  assert.deepEqual(k.sh("cut -d ' ' -f 2 f"), ['a:b:c:d', 'separator', '1:2', ':x:', ''])
  k.write('/tmp/t', 'a\tb\tc\nplain\n')
  assert.equal(textOf(k, 'cut -f 2,3 t'), 'b\tc\nplain\n')
  assert.equal(textOf(k, 'cut -f 1 -s t'), 'a\n')
  k.write('/tmp/u', 'un\u00b7deux\u00b7trois\n')
  assert.deepEqual(k.sh('cut -d \u00b7 -f 2- u'), ['deux\u00b7trois'])
})

test('cut: characters by code point and bytes as they are; input without a line end; no input', () => {
  const k = fresh()
  k.write('/tmp/u', 'h\u00e9llo\n\u{1f600}\u{1f601}\u{1f602}z\n\nab')
  assert.equal(textOf(k, 'cut -c 2 u'), '\u00e9\n\u{1f601}\n\nb\n')
  assert.equal(textOf(k, 'cut -c 2-3 u'), '\u00e9l\n\u{1f601}\u{1f602}\n\nb\n')
  assert.equal(textOf(k, 'cut -c -2,4- u'), 'h\u00e9lo\n\u{1f600}\u{1f601}z\n\nab\n')
  assert.equal(textOf(k, 'cut -c 9 u'), '\n\n\n\n')
  same(bytesOf(k, 'cut -b 2 u'), new Uint8Array([0xc3, 10, 0x9f, 10, 10, 98, 10]), 'cut -b 2')
  same(bytesOf(k, 'cut -b 1-3 u'), new Uint8Array([104, 0xc3, 0xa9, 10, 0xf0, 0x9f, 0x98, 10, 10, 97, 98, 10]), 'cut -b 1-3')
  k.write('/tmp/empty', '')
  assert.equal(textOf(k, 'cut -c 1 empty'), '')
  assert.equal(textOf(k, 'cut -b 1 empty'), '')
  assert.equal(textOf(k, 'cut -f 1 empty'), '')
  k.write('/tmp/f', 'abc')
  assert.equal(textOf(k, 'cut -c 1 f'), 'a\n')
  assert.equal(textOf(k, 'cut -b 3 f'), 'c\n')
  assert.equal(textOf(k, 'cut -b 9 f'), '\n')
  assert.equal(textOf(k, 'cut -f 1 f'), 'abc\n')
  assert.equal(textOf(k, 'cut -c 1 f u - < f'), 'a\nh\n\u{1f600}\n\na\na\n')
  // Bytes that are no text: -b keeps each as it is, and a line may run over many reads.
  const raw = noise(150000, 21)
  k.write('/tmp/raw', raw)
  const want: number[] = []
  let col = 0
  for (const b of raw) {
    if (b === 10) { want.push(10); col = 0 } else if (++col === 2 || (col >= 5 && col <= 6) || col >= 400) want.push(b)
  }
  if (col > 0) want.push(10)
  same(bytesOf(k, 'cut -b 2,5-6,400- raw'), Uint8Array.from(want), 'cut -b over bytes that are no text')
  assert.deepEqual(k.sh('cut -c 1 raw | wc -l'), k.sh('cut -b 1 raw | wc -l'))
})

test('cut: one way of cutting must be chosen, and the list must be one', () => {
  const k = fresh()
  k.write('/tmp/f', 'abc\n')
  const usage = '!usage: cut -b list | -c list | -f list [-d char] [-s] [file ...]'
  assert.deepEqual(k.sh('cut f; echo $?'), ['!cut: one of -b, -c and -f is needed', usage, '2'])
  assert.deepEqual(k.sh('cut -c 1 -b 1 f; echo $?'), ['!cut: only one of -b, -c and -f can be given', usage, '2'])
  for (const list of ['0', 'a', '1,,2', '3-1', '-', '1-2-3', '', '1.5', '2,-0']) {
    assert.deepEqual(k.sh(`cut -c '${list}' f; echo $?`), [`!cut: '${list}' is not a list of positions such as 1,3-5,7-`, usage, '2'], list)
  }
  assert.deepEqual(k.sh('cut -d ab -f 1 f; echo $?'), ["!cut: option '-d' needs one character, not 'ab'", usage, '2'])
  assert.deepEqual(k.sh("cut -d '' -f 1 f; echo $?"), ["!cut: option '-d' needs one character, not ''", usage, '2'])
  assert.deepEqual(k.sh('cut -c 1 -d : f; echo $?'), ['!cut: -d and -s go with -f only', usage, '2'])
  assert.deepEqual(k.sh('cut -b 1 -s f; echo $?'), ['!cut: -d and -s go with -f only', usage, '2'])
  assert.deepEqual(k.sh('cut -f; echo $?'), ["!cut: option '-f' needs a value", usage, '2'])
})

// tr

test('tr: one set changed into another: ranges, classes, escapes, and a short second set', () => {
  const k = fresh()
  k.write('/tmp/f', 'Hello, World 42!\n')
  assert.deepEqual(k.sh('tr a-z A-Z < f'), ['HELLO, WORLD 42!'])
  assert.deepEqual(k.sh("tr '[:lower:]' '[:upper:]' < f; tr '[:upper:]' '[:lower:]' < f"), ['HELLO, WORLD 42!', 'hello, world 42!'])
  assert.deepEqual(k.sh("tr '[:digit:]' '#' < f; tr '[:alpha:]' x < f; tr '[:alnum:]' x < f; tr '[:punct:]' . < f"),
    ['Hello, World ##!', 'xxxxx, xxxxx 42!', 'xxxxx, xxxxx xx!', 'Hello. World 42.'])
  assert.equal(textOf(k, "tr '[:space:]' _ < f"), 'Hello,_World_42!_')
  // The second set is shorter: its last character stands for the rest.
  assert.deepEqual(k.sh('tr elo 12 < f'), ['H1222, W2r2d 42!'])
  // A character listed twice in the first set takes its last place.
  assert.deepEqual(k.sh('tr lll 123 < f'), ['He33o, Wor3d 42!'])
  // A dash at either end of a set is a dash; after --, a set may start with one.
  assert.deepEqual(k.sh("tr 'a-cx-z' 'A-CX-Z' < f; tr 'lo-' 'L0+' < f; tr -- '-H' '+J' < f"), ['Hello, World 42!', 'HeLL0, W0rLd 42!', 'Jello, World 42!'])
  assert.equal(textOf(k, String.raw`tr ' \n' '\t\\' < f`), 'Hello,\tWorld\t42!\\')
  assert.equal(textOf(k, String.raw`tr '\054\041' '\073\77' < f`), 'Hello; World 42?\n')
  assert.equal(textOf(k, String.raw`tr 'H\r\a\b\f\v' 'h' < f`), 'hello, World 42!\n')
  assert.equal(textOf(k, String.raw`printf 'a-b\\c\n' | tr '\-\\' 'XY'`), 'aXbYc\n')
  // A bracket that opens no class is a character like any other: 'o[:lower' is the letters o [ : l w e r.
  assert.deepEqual(k.sh("tr '[a-c]' '[A-C]' < f; tr '[:' 'ab' < f; tr 'o[:lower' '0' < f"), ['Hello, World 42!', 'Hello, World 42!', 'H0000, W000d 42!'])
  k.write('/tmp/u', 'd\u00e9j\u00e0 vu \u{1f600}\u{1f601}\n')
  assert.deepEqual(k.sh('tr \u00e9\u00e0 ea < u; tr a-z \u{1f680} < u; tr \u{1f600}-\u{1f601} ab < u; tr v \u4e2d < u'),
    ['deja vu \u{1f600}\u{1f601}', '\u{1f680}\u00e9\u{1f680}\u00e0 \u{1f680}\u{1f680} \u{1f600}\u{1f601}', 'd\u00e9j\u00e0 vu ab',
    'd\u00e9j\u00e0 \u4e2du \u{1f600}\u{1f601}'])
})

test('tr: removing with -d, squeezing with -s, the rest of the characters with -c', () => {
  const k = fresh()
  k.write('/tmp/f', 'aaa  bbb   cccd\n\n\nee\n')
  assert.equal(textOf(k, 'tr -d ab < f'), '     cccd\n\n\nee\n')
  assert.equal(textOf(k, "tr -d '\\n' < f"), 'aaa  bbb   cccdee')
  assert.equal(textOf(k, "tr -d '[:space:]' < f"), 'aaabbbcccdee')
  assert.equal(textOf(k, "tr -s 'a \\n' < f"), 'a bbb cccd\nee\n')
  assert.equal(textOf(k, 'tr -s a-z < f'), 'a  b   cd\n\n\ne\n')
  assert.equal(textOf(k, 'tr -s ab xy < f'), 'x  y   cccd\n\n\nee\n')
  assert.equal(textOf(k, 'tr -s abc x < f'), 'x  x   xd\n\n\nee\n')
  assert.equal(textOf(k, "tr -ds ab 'c\\n' < f"), '     cd\nee\n')
  assert.equal(textOf(k, "tr -d -s ab 'c\\n' < f"), '     cd\nee\n')
  assert.equal(textOf(k, "tr -c 'a-z\\n' . < f"), 'aaa..bbb...cccd\n\n\nee\n')
  // With -c every character outside the set becomes the last of the second set.
  assert.equal(textOf(k, "tr -c 'a-z\\n' xyz < f"), 'aaazzbbbzzzcccd\n\n\nee\n')
  assert.equal(textOf(k, "tr -cs a-z '\\n' < f"), 'aaa\nbbb\ncccd\nee\n')
  assert.equal(textOf(k, 'tr -cd a-c < f'), 'aaabbbccc')
  assert.equal(textOf(k, 'tr -cs a-c < f'), 'aaa bbb cccd\ne\n')
  assert.equal(textOf(k, "tr -cds a-c 'ab' < f"), 'abccc')
})

test('tr: input in many pieces, no input, bytes that are no text, and sets it cannot read', () => {
  const k = fresh()
  k.write('/tmp/empty', '')
  assert.equal(textOf(k, 'tr a b < empty'), '')
  assert.equal(textOf(k, 'tr -s a < empty'), '')
  // A run that lies across two reads is still squeezed to one; a character of several bytes that does is still one character.
  k.write('/tmp/runs', `${'a'.repeat(70000)}b${'\u00e9'.repeat(50000)}\n`)
  assert.equal(textOf(k, 'tr -s a < runs'), `ab${'\u00e9'.repeat(50000)}\n`)
  assert.equal(textOf(k, 'tr -s \u00e9a < runs'), 'ab\u00e9\n')
  assert.equal(textOf(k, 'tr \u00e9 e < runs').length, 120002)
  assert.deepEqual(k.sh('tr -d a < runs | wc -c; tr -d \u00e9 < runs | wc -c; tr -cd \u00e9 < runs | wc -m'), ['100002', '70002', '50000'])
  k.write('/tmp/bad', new Uint8Array([97, 0xff, 98, 0xc3, 10]))
  same(bytesOf(k, 'tr a A < bad'), new Uint8Array([65, 0xef, 0xbf, 0xbd, 98, 0xef, 0xbf, 0xbd, 10]), 'what is not UTF-8 becomes U+FFFD')
  const usage = '!usage: tr [-cds] set1 [set2]'
  assert.deepEqual(k.sh('tr; echo $?'), [usage, '2'])
  assert.deepEqual(k.sh('tr a; echo $?'), ['!tr: changing characters takes two sets', usage, '2'])
  assert.deepEqual(k.sh('tr a b c; echo $?'), ['!tr: at most two sets can be given', usage, '2'])
  assert.deepEqual(k.sh('tr -d a b; echo $?'), ['!tr: removing takes one set', usage, '2'])
  assert.deepEqual(k.sh('tr -ds a; echo $?'), ['!tr: removing and squeezing takes two sets', usage, '2'])
  assert.deepEqual(k.sh("tr a ''; echo $?"), ['!tr: the second set is empty', usage, '2'])
  assert.deepEqual(k.sh('tr z-a b; echo $?'), ["!tr: the range 'z-a' runs backwards", usage, '2'])
  assert.deepEqual(k.sh("tr '[:word:]' b; echo $?"), ["!tr: '[:word:]' is not a class this tr knows", usage, '2'])
  assert.deepEqual(k.sh('tr -x a b; echo $?'), ["!tr: unknown option '-x'", usage, '2'])
  assert.deepEqual(k.sh(`tr '\\0-\u{10ffff}a' b; echo $?`), ['!tr: a set lists more than 1114112 characters', usage, '2'])
  assert.deepEqual(k.sh(`echo abc | tr '\\0-\u{10ffff}' x`), ['xxxx'])
})

// tee

test('tee: to the output and to every file, replacing or adding', () => {
  const k = fresh()
  k.write('/tmp/old', 'old\n')
  assert.deepEqual(k.sh('seq 3 | tee a b old; echo $?'), ['1', '2', '3', '0'])
  assert.equal(k.read('/tmp/a'), '1\n2\n3\n')
  assert.equal(k.read('/tmp/b'), '1\n2\n3\n')
  assert.equal(k.read('/tmp/old'), '1\n2\n3\n')
  assert.deepEqual(k.sh('seq 4 5 | tee -a a new > /dev/null; echo $?'), ['0'])
  assert.equal(k.read('/tmp/a'), '1\n2\n3\n4\n5\n')
  assert.equal(k.read('/tmp/new'), '4\n5\n')
  assert.deepEqual(k.sh('seq 2 | tee | tee | wc -l'), ['2'])
  assert.deepEqual(k.sh('tee empty < /dev/null; echo $?'), ['0'])
  assert.equal(k.read('/tmp/empty'), '')
  assert.equal(textOf(k, 'printf abc | tee nl'), 'abc')
  assert.equal(k.read('/tmp/nl'), 'abc')
})

test('tee: a file it cannot open or write does not stop the others; bytes go through as they are', () => {
  const k = fresh()
  assert.deepEqual(k.sh('seq 2 | tee /nosuch/x ok /tmp /bin/no; echo $?'),
    ['!tee: /nosuch/x: no such file or directory', '!tee: /tmp: is a directory', '!tee: /bin/no: read-only file system', '1', '2', '1'])
  assert.equal(k.read('/tmp/ok'), '1\n2\n')
  assert.deepEqual(k.sh('seq 2 | tee /dev/full ok2; echo $?'), ['1', '2', '!tee: /dev/full: no space left on device', '1'])
  assert.equal(k.read('/tmp/ok2'), '1\n2\n')
  const raw = noise(200000, 5)
  k.write('/tmp/raw', raw)
  same(bytesOf(k, 'tee copy1 copy2 < raw'), raw, 'tee to the output')
  same(k.bytes('/tmp/copy1'), raw, 'tee to the first file')
  same(k.bytes('/tmp/copy2'), raw, 'tee to the second file')
  assert.deepEqual(k.sh('tee -a copy1 < raw > /dev/null; wc -c copy1'), ['400000 copy1'])
  assert.deepEqual(k.sh('tee -z; echo $?'), ["!tee: unknown option '-z'", '!usage: tee [-a] [file ...]', '2'])
  assert.deepEqual(tasks(k), AT_REST)
})

// tac

test('tac: last line first, each file in turn, bytes kept', () => {
  const k = fresh()
  k.write('/tmp/f', 'one\ntwo\n\nfour\n')
  k.write('/tmp/g', 'x\ny')
  k.write('/tmp/empty', '')
  assert.equal(textOf(k, 'tac f'), 'four\n\ntwo\none\n')
  assert.equal(textOf(k, 'tac g'), 'y\nx\n')
  assert.equal(textOf(k, 'tac f g'), 'four\n\ntwo\none\ny\nx\n')
  assert.equal(textOf(k, 'tac empty'), '')
  assert.equal(textOf(k, 'tac empty g empty'), 'y\nx\n')
  assert.equal(textOf(k, 'tac < f'), 'four\n\ntwo\none\n')
  assert.equal(textOf(k, 'printf solo | tac'), 'solo\n')
  assert.equal(textOf(k, "printf '\\n\\n\\n' | tac"), '\n\n\n')
  assert.equal(textOf(k, "printf '\\na' | tac"), 'a\n\n')
  const raw = noise(150000, 11)
  k.write('/tmp/raw', raw)
  const lines: Uint8Array[] = []
  let from = 0
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== 10) continue
    lines.push(raw.subarray(from, i + 1))
    from = i + 1
  }
  const want: number[] = []
  if (from < raw.length) want.push(...raw.subarray(from), 10)
  for (let i = lines.length - 1; i >= 0; i--) want.push(...lines[i])
  same(bytesOf(k, 'tac raw'), Uint8Array.from(want), 'tac over bytes that are no text')
  k.write('/tmp/big', numbered(20000))
  assert.deepEqual(own(k.sh('tac big | head -n 2; tac big | tac | head -n 1; tac big | wc -l')), ['line 20000', 'line 19999', 'line 00001', '20000'])
})

// rev

test('rev: each line back to front, by whole characters', () => {
  const k = fresh()
  k.write('/tmp/f', 'abc\n\nxy z\n')
  k.write('/tmp/g', 'last')
  assert.equal(textOf(k, 'rev f'), 'cba\n\nz yx\n')
  assert.equal(textOf(k, 'rev g'), 'tsal\n')
  assert.equal(textOf(k, 'rev f g'), 'cba\n\nz yx\ntsal\n')
  assert.equal(textOf(k, 'rev < f'), 'cba\n\nz yx\n')
  assert.equal(textOf(k, 'rev /dev/null'), '')
  k.write('/tmp/u', 'h\u00e9llo \u{1f600}!\n\u4e2d\u6587\n')
  assert.equal(textOf(k, 'rev u'), '!\u{1f600} oll\u00e9h\n\u6587\u4e2d\n')
  assert.equal(textOf(k, 'rev u | rev'), 'h\u00e9llo \u{1f600}!\n\u4e2d\u6587\n')
})

test('rev: a long line is turned round a slice at a time, with a call to the kernel between slices, every character kept whole', () => {
  const k = fresh()
  // The pair sits where the last slice of 4096 code units begins, counted from the end: it must not be split there.
  const line = `${'ab'.repeat(300000)}\u{1f600}z${'xy'.repeat(2047)}`
  k.write('/tmp/long', `${line}\nshort\n`)
  const turns = shortTurns(k, 'rev long > /tmp/.out')
  assert.equal(k.read('/tmp/.out'), `${Array.from(line).reverse().join('')}\ntrohs\n`)
  assert.ok(turns >= Math.floor(line.length / 4096 / LOOK), `${turns} turns`)
})

test('a line of megabytes written to the screen in one go reaches it in pieces, a turn\'s breath between them, every character whole', () => {
  const k = fresh()
  const line = `${'ab'.repeat(300000)}\u{1f600}z`
  k.write('/tmp/long', `${line}\n`)
  // rev writes its whole reversed line at once: the screen takes it a piece at a time, each turn ended at once.
  k.system.type('rev long\n')
  let turns = 0
  let shown = ''
  while (!k.system.idle) {
    for (const e of k.system.run(1_000_000, Number.NEGATIVE_INFINITY)) if (e.kind !== 'post') shown += e.text
    turns++
  }
  assert.ok(turns >= Math.floor(line.length / (16 << 10)), `${turns} turns`)
  assert.equal(shown, Array.from(line).reverse().join(''), 'every character whole, the emoji where a piece ends near it')
})

// nl

test('nl: numbers in front, empty lines left alone unless asked, the count carried from file to file', () => {
  const k = fresh()
  k.write('/tmp/f', 'one\n\ntwo\n')
  k.write('/tmp/g', 'three')
  assert.equal(textOf(k, 'nl f'), '     1\tone\n\n     2\ttwo\n')
  assert.equal(textOf(k, 'nl -b t f'), '     1\tone\n\n     2\ttwo\n')
  assert.equal(textOf(k, 'nl -b a f'), '     1\tone\n     2\t\n     3\ttwo\n')
  assert.equal(textOf(k, 'nl -ba -w3 f'), '  1\tone\n  2\t\n  3\ttwo\n')
  assert.equal(textOf(k, 'nl -w 1 f g'), '1\tone\n\n2\ttwo\n3\tthree\n')
  assert.equal(textOf(k, 'nl < f'), '     1\tone\n\n     2\ttwo\n')
  assert.equal(textOf(k, 'nl /dev/null'), '')
  assert.equal(textOf(k, 'seq 12 | nl -w 1 | tail -n 3'), '10\t10\n11\t11\n12\t12\n')
  const usage = '!usage: nl [-b a|t] [-w width] [file ...]'
  assert.deepEqual(k.sh('nl -b x f; echo $?'), ["!nl: option '-b' takes a (every line) or t (lines with text), not 'x'", usage, '2'])
  assert.deepEqual(k.sh('nl -w 0 f; echo $?'), ["!nl: option '-w' needs a whole number from 1 to 4096, not '0'", usage, '2'])
  assert.deepEqual(k.sh('nl -w 4097 f; echo $?'), ["!nl: option '-w' needs a whole number from 1 to 4096, not '4097'", usage, '2'])
  // 4096 columns of number, a tab, the five letters and a line end.
  assert.deepEqual(k.sh('nl -w 4096 g | wc -c'), ['4103'])
})

// fold

test('fold: lines broken at a width, at a blank with -s', () => {
  const k = fresh()
  k.write('/tmp/f', 'the quick brown fox jumps\n\nshort\n0123456789\n')
  assert.equal(textOf(k, 'fold -w 10 f'), 'the quick \nbrown fox \njumps\n\nshort\n0123456789\n')
  assert.equal(textOf(k, 'fold -w 7 f'), 'the qui\nck brow\nn fox j\numps\n\nshort\n0123456\n789\n')
  assert.equal(textOf(k, 'fold -s -w 7 f'), 'the \nquick \nbrown \nfox \njumps\n\nshort\n0123456\n789\n')
  assert.equal(textOf(k, 'fold -sw 12 f'), 'the quick \nbrown fox \njumps\n\nshort\n0123456789\n')
  assert.equal(textOf(k, 'fold -w 1 < /tmp/f | head -n 4'), 't\nh\ne\n \n')
  assert.equal(textOf(k, 'fold f'), 'the quick brown fox jumps\n\nshort\n0123456789\n')
  k.write('/tmp/wide', `${'x'.repeat(200)}\n`)
  assert.equal(textOf(k, 'fold wide'), `${'x'.repeat(80)}\n${'x'.repeat(80)}\n${'x'.repeat(40)}\n`)
  k.write('/tmp/g', 'no line end')
  assert.equal(textOf(k, 'fold -w 4 g'), 'no l\nine \nend\n')
  // "line" has no blank in its four columns, so it is broken at the width; " end" then fits whole.
  assert.equal(textOf(k, 'fold -s -w 4 g'), 'no \nline\n end\n')
  assert.equal(textOf(k, 'fold /dev/null'), '')
  k.write('/tmp/t', 'a\tb c\td\n')
  // A tab is a blank, and one column wide.
  assert.equal(textOf(k, 'fold -s -w 3 t'), 'a\t\nb \nc\td\n')
  k.write('/tmp/u', '\u00e9\u00e9\u00e9\u{1f600}\u{1f600}\u{1f600}\u4e2d\n')
  assert.equal(textOf(k, 'fold -w 3 u'), '\u00e9\u00e9\u00e9\n\u{1f600}\u{1f600}\u{1f600}\n\u4e2d\n')
  assert.equal(textOf(k, 'fold -w 4 u'), '\u00e9\u00e9\u00e9\u{1f600}\n\u{1f600}\u{1f600}\u4e2d\n')
  const usage = '!usage: fold [-s] [-w width] [file ...]'
  assert.deepEqual(k.sh('fold -w 0 f; echo $?'), ["!fold: option '-w' needs a whole number of 1 or more, not '0'", usage, '2'])
  assert.deepEqual(k.sh('fold -w wide f; echo $?'), ["!fold: option '-w' needs a whole number of 1 or more, not 'wide'", usage, '2'])
})

test('fold: a long line is walked a slice at a time, with a call to the kernel between slices, at any width and with -s', () => {
  const k = fresh()
  // Pairs at many places, some of them where a piece or a stretch of the walk ends, and blanks far apart for -s.
  let line = ''
  for (let i = 0; i < 40; i++) line += `${'ab'.repeat(3000 + i)}\u{1f600} ${'cd'.repeat(4000 - i)}\t`
  k.write('/tmp/long', `${line}\n`)
  const cases = [
    ['fold -w 100000', 100000, false], ['fold -s -w 100000', 100000, true], ['fold -s -w 9001', 9001, true], ['fold -w 80', 80, false],
  ] as const
  for (const [command, width, words] of cases) {
    const turns = shortTurns(k, `${command} long > /tmp/.out`)
    assert.equal(k.read('/tmp/.out'), folded(line, width, words), command)
    assert.ok(turns >= Math.floor(line.length / 4096 / LOOK), `${command}: ${turns} turns`)
  }
  // A line of more code units than the width but no more characters goes through whole; one more character does not.
  k.write('/tmp/pairs', `${'\u{1f600}'.repeat(5)}\n${'\u{1f600}'.repeat(6)}\n`)
  assert.equal(textOf(k, 'fold -w 5 pairs'), `${'\u{1f600}'.repeat(5)}\n${'\u{1f600}'.repeat(5)}\n\u{1f600}\n`)
})

// paste

test('paste: files side by side, with other separators, and the input taken in turn', () => {
  const k = fresh()
  k.write('/tmp/a', '1\n2\n3\n')
  k.write('/tmp/b', 'x\ny')
  k.write('/tmp/empty', '')
  assert.equal(textOf(k, 'paste a b'), '1\tx\n2\ty\n3\t\n')
  assert.equal(textOf(k, 'paste b a'), 'x\t1\ny\t2\n\t3\n')
  assert.equal(textOf(k, 'paste a'), '1\n2\n3\n')
  assert.equal(textOf(k, 'paste < b'), 'x\ny\n')
  assert.equal(textOf(k, 'paste -d , a b a'), '1,x,1\n2,y,2\n3,,3\n')
  assert.equal(textOf(k, "paste -d ',;' a b a b"), '1,x;1,x\n2,y;2,y\n3,;3,\n')
  assert.equal(textOf(k, String.raw`paste -d '\t\\\0\n' a a a a a`), '1\t1\\11\n1\n2\t2\\22\n2\n3\t3\\33\n3\n')
  assert.equal(textOf(k, "paste -d '' a b"), '1x\n2y\n3\n')
  assert.equal(textOf(k, 'paste -d\u00b7 a b'), '1\u00b7x\n2\u00b7y\n3\u00b7\n')
  assert.equal(textOf(k, 'paste a empty b'), '1\t\tx\n2\t\ty\n3\t\t\n')
  assert.equal(textOf(k, 'paste empty empty'), '')
  assert.equal(textOf(k, 'seq 7 | paste - - -'), '1\t2\t3\n4\t5\t6\n7\t\t\n')
  assert.equal(textOf(k, 'seq 4 | paste -d : - b -'), '1:x:2\n3:y:4\n')
})

test('paste: one file after another with -s; a file that cannot be read', () => {
  const k = fresh()
  k.write('/tmp/a', '1\n2\n3\n')
  k.write('/tmp/b', 'x\ny')
  k.write('/tmp/empty', '')
  assert.equal(textOf(k, 'paste -s a b'), '1\t2\t3\nx\ty\n')
  assert.equal(textOf(k, 'paste -s -d , a'), '1,2,3\n')
  assert.equal(textOf(k, "paste -sd '+-' a a"), '1+2-3\n1+2-3\n')
  assert.equal(textOf(k, 'paste -s empty a'), '\n1\t2\t3\n')
  assert.equal(textOf(k, 'seq 5 | paste -s -d +'), '1+2+3+4+5\n')
  assert.equal(textOf(k, 'seq 3 | paste -s - a'), '1\t2\t3\n1\t2\t3\n')
  assert.deepEqual(k.sh('paste -s -d , a nosuch b; echo $?'), ['1,2,3', '!paste: nosuch: no such file or directory', 'x,y', '1'])
  assert.deepEqual(k.sh('paste a nosuch b /tmp; echo $?'), ['!paste: nosuch: no such file or directory', '!paste: /tmp: is a directory', '1'])
  assert.deepEqual(k.sh('paste -d; echo $?'), ["!paste: option '-d' needs a value", '!usage: paste [-s] [-d list] [file ...]', '2'])
  assert.deepEqual(tasks(k), AT_REST)
})

// seq

test('seq: up, down, by steps, with decimals', () => {
  const k = fresh()
  assert.deepEqual(k.sh('seq 3'), ['1', '2', '3'])
  assert.deepEqual(k.sh('seq 2 4; seq 1 2 6; seq 5 -2 0'), ['2', '3', '4', '1', '3', '5', '5', '3', '1'])
  assert.deepEqual(k.sh('seq -2 1; seq -1 -1 -3; seq 0'), ['-2', '-1', '0', '1', '-1', '-2', '-3'])
  assert.deepEqual(k.sh('seq 3 1; seq 1 -1 3; seq 0 5 -1; echo $?'), ['0'])
  assert.deepEqual(k.sh('seq 0 0.5 2; seq 1.0 2; seq 1 2.5; seq .5 1.5'), ['0.0', '0.5', '1.0', '1.5', '2.0', '1.0', '2.0', '1', '2', '0.5', '1.5'])
  assert.deepEqual(k.sh('seq 1 0.25 1.6; seq -0.2 0.1 0.2; seq 2 -0.5 1'), ['1.00', '1.25', '1.50', '-0.2', '-0.1', '0.0', '0.1', '0.2', '2.0', '1.5', '1.0'])
  // Tenths added one at a time never drift: the sums are done in whole numbers.
  assert.deepEqual(k.sh('seq 0 0.1 1 | tail -n 3; seq 0 0.1 100 | wc -l; seq 0 0.01 3 | tail -n 1'), ['0.8', '0.9', '1.0', '1001', '3.00'])
  assert.deepEqual(k.sh('seq +2 +1 +3; seq -- -1 0; seq 5 5; seq 5. 6'), ['2', '3', '-1', '0', '5', '5', '6'])
  assert.deepEqual(k.sh('seq 999999999999998 999999999999999; seq -999999999999999 500000000000000 0'),
    ['999999999999998', '999999999999999', '-999999999999999', '-499999999999999'])
  assert.deepEqual(k.sh('seq 1 100000 | wc -l; seq 100000 -1 1 | tail -n 1'), ['100000', '1'])
})

test('seq: -w, -s, and what it refuses', () => {
  const k = fresh()
  assert.deepEqual(k.sh('seq -w 8 11; seq -w -1 1; seq -w 9 -4 -9'), ['08', '09', '10', '11', '-1', '00', '01', '09', '05', '01', '-3', '-7'])
  assert.equal(textOf(k, 'seq -w 0.5 0.5 10 | paste -s -d " " -'),
    '00.5 01.0 01.5 02.0 02.5 03.0 03.5 04.0 04.5 05.0 05.5 06.0 06.5 07.0 07.5 08.0 08.5 09.0 09.5 10.0\n')
  assert.equal(textOf(k, 'seq -s , 4'), '1,2,3,4\n')
  assert.equal(textOf(k, "seq -s ' + ' 3"), '1 + 2 + 3\n')
  assert.equal(textOf(k, 'seq -s: -w 9 10'), '09:10\n')
  assert.equal(textOf(k, "seq -s '' 3"), '123\n')
  assert.equal(textOf(k, 'seq -s , 3 1'), '')
  assert.equal(textOf(k, 'seq -w -s - 1 1'), '1\n')
  const usage = '!usage: seq [-w] [-s separator] [first [step]] last'
  assert.deepEqual(k.sh('seq; echo $?'), [usage, '2'])
  assert.deepEqual(k.sh('seq 1 2 3 4; echo $?'), [usage, '2'])
  assert.deepEqual(k.sh('seq 1 0 5; echo $?'), ['!seq: the step cannot be 0', usage, '2'])
  assert.deepEqual(k.sh('seq 1 0.0 5; echo $?'), ['!seq: the step cannot be 0', usage, '2'])
  for (const bad of ['a', '1e3', '0x10', '1,5', '1.2.3', '.', '+', '--1', '1-', 'inf']) {
    assert.deepEqual(k.sh(`seq 1 ${bad}; echo $?`), [`!seq: '${bad}' is not a number`, usage, '2'], bad)
  }
  assert.deepEqual(k.sh('seq -; echo $?'), ["!seq: '-' is not a number", usage, '2'])
  assert.deepEqual(k.sh('seq -x 3; echo $?'), ["!seq: unknown option '-x'", usage, '2'])
  assert.deepEqual(k.sh('seq -s; echo $?'), ["!seq: option '-s' needs a value", usage, '2'])
  // The limit counts the decimals every number is shown with: 15 digits as written are too many once one is added.
  const digits = 'a number has more than 15 digits when given as many decimals as the one with the most'
  assert.deepEqual(k.sh('seq 1 1000000000000000; echo $?'), [`!seq: ${digits}`, usage, '2'])
  assert.deepEqual(k.sh('seq 0.0000000000000001 1; echo $?'), [`!seq: ${digits}`, usage, '2'])
  assert.deepEqual(k.sh('seq 0.5 100000000000000; echo $?'), [`!seq: ${digits}`, usage, '2'])
  assert.deepEqual(k.sh('seq 9999999999998.5 10000000000000'), ['9999999999998.5', '9999999999999.5'])
})

// yes

test('yes: the same line for as long as somebody reads', () => {
  const k = fresh()
  assert.deepEqual(own(k.sh('yes | head -n 3')), ['y', 'y', 'y'])
  assert.deepEqual(own(k.sh('yes no way | head -n 2')), ['no way', 'no way'])
  assert.deepEqual(own(k.sh("yes -n '' x | head -n 2; yes -- | head -n 1; yes -- -- | head -n 1")), ['-n  x', '-n  x', 'y', '--'])
  assert.deepEqual(own(k.sh(`yes ${'w'.repeat(5000)} | head -n 2 | wc`)), ['    2     2 10002'])
  assert.deepEqual(own(k.sh('yes \u00e9 | head -c 6 > out')), [])
  same(k.bytes('/tmp/out'), encode('\u00e9\n\u00e9\n'), 'yes in UTF-8')
  assert.deepEqual(tasks(k), AT_REST)
})

// echo

test('echo: byte for byte what the echo of the shell itself prints', () => {
  const k = fresh()
  const cases = [
    'hello  world', '', '-n', '-n hi', '-e', String.raw`-e 'a\tb\nc'`, String.raw`-ne 'x\0y'`, String.raw`-en 'q\rz'`, String.raw`-e -n '\e[0m'`,
    '-x -n', '-n -x',
    '-nn x', '-ee x', '-- -n', String.raw`-n -e -n 'a\\n'`, String.raw`-e 'ends\'`, String.raw`-e 'ends\\'`, String.raw`-e '\a\n\q\\\\t'`, String.raw`'a\tb'`,
    String.raw`-e '\\\n' '\0\0' -e`, String.raw`-e '\'`, '-e - -n', 'caf\u00e9 \u{1f600}', String.raw`-e '\\0' '\\\0' '\\\\0'`, '-ne', '-en -ne -e -n done',
  ]
  for (const args of cases) {
    assert.deepEqual(k.sh(`echo ${args} > /tmp/one; /bin/echo ${args} > /tmp/two; echo $?`), ['0'], args)
    same(k.bytes('/tmp/two'), k.bytes('/tmp/one'), `echo ${args}`)
  }
  assert.equal(textOf(k, String.raw`/bin/echo -e 'a\tb\\\e\0'`), 'a\tb\\\u001b\0\n')
  assert.deepEqual(k.sh('/bin/echo one; /bin/echo -n two; /bin/echo; /bin/echo "a   b" c'), ['one', 'two', 'a   b c'])
})

// printf

test('printf: text and numbers put into a format', () => {
  const k = fresh()
  assert.equal(textOf(k, String.raw`printf 'plain\n'`), 'plain\n')
  assert.equal(textOf(k, 'printf plain'), 'plain')
  assert.equal(textOf(k, String.raw`printf '%s and %s\n' one two`), 'one and two\n')
  assert.equal(textOf(k, String.raw`printf '%d %i %u\n' 42 -42 42`), '42 -42 42\n')
  assert.equal(textOf(k, String.raw`printf '%x %X %o\n' 255 255 8`), 'ff FF 10\n')
  assert.equal(textOf(k, String.raw`printf '%c%c%c\n' abc xyz ''`), 'ax\n')
  assert.equal(textOf(k, String.raw`printf '100%%\n'`), '100%\n')
  // The format is used again while arguments are left; an item with none left prints as nothing, or 0 for a number.
  assert.equal(textOf(k, String.raw`printf '%s\n' a b c`), 'a\nb\nc\n')
  assert.equal(textOf(k, String.raw`printf '%s=%d;' a 1 b 2 c`), 'a=1;b=2;c=0;')
  assert.equal(textOf(k, String.raw`printf '[%s][%d][%x][%c]\n'`), '[][0][0][]\n')
  assert.equal(textOf(k, String.raw`printf 'no items\n' extra words`), 'no items\n')
  assert.equal(textOf(k, String.raw`printf -- '-%s-\n' x`), '-x-\n')
  assert.equal(textOf(k, String.raw`printf '-%s-\n' x`), '-x-\n')
  assert.equal(textOf(k, String.raw`printf '%s\n' '%d' '\n'`), '%d\n\\n\n')
  assert.equal(textOf(k, String.raw`printf '%d %d %d %d\n' 0x1f 017 -0X10 +7`), '31 15 -16 7\n')
  assert.equal(textOf(k, String.raw`printf '%d %d %x\n' "'A" '"z' "'` + '\u{1f600}"'), '65 122 1f600\n')
  assert.equal(textOf(k, String.raw`printf '%u %x %o\n' -1 -1 -1`), '18446744073709551615 ffffffffffffffff 1777777777777777777777\n')
  assert.equal(textOf(k, String.raw`printf '%d %d %u\n' 9223372036854775807 -9223372036854775808 18446744073709551615`),
    '9223372036854775807 -9223372036854775808 18446744073709551615\n')
})

test('printf: flags, widths and precisions', () => {
  const k = fresh()
  assert.equal(textOf(k, String.raw`printf '[%5s][%-5s][%5d][%-5d][%05d]\n' ab ab 42 42 42`), '[   ab][ab   ][   42][42   ][00042]\n')
  assert.equal(textOf(k, String.raw`printf '[%+d][%+d][% d][% d][%+5d][%-+5d][% 05d]\n' 5 -5 5 -5 5 5 5`), '[+5][-5][ 5][-5][   +5][+5   ][ 0005]\n')
  assert.equal(textOf(k, String.raw`printf '[%05d][%-05d][%05x][%5X][%05o]\n' -42 -42 255 255 8`), '[-0042][-42  ][000ff][   FF][00010]\n')
  assert.equal(textOf(k, String.raw`printf '[%.2s][%.0s][%.9s][%5.1s][%-5.1s][%.s]\n' abc abc abc abc abc abc`), '[ab][][abc][    a][a    ][]\n')
  assert.equal(textOf(k, String.raw`printf '[%.3d][%.0d][%.0d][%5.3d][%-5.3d][%05.3d][%+.2d]\n' 5 0 7 5 5 5 5`), '[005][][7][  005][005  ][  005][+05]\n')
  assert.equal(textOf(k, String.raw`printf '[%.4x][%.0x][%3c][%-3c]\n' 255 0 a b`), '[00ff][][  a][b  ]\n')
  // Widths and precisions count characters, not bytes.
  assert.equal(textOf(k, String.raw`printf '[%3s][%-3s][%.1s][%2c]\n' ` + '\u00e9 \u{1f600} \u4e2d\u6587 \u00e9t\u00e9'),
    '[  \u00e9][\u{1f600}  ][\u4e2d][ \u00e9]\n')
  assert.equal(textOf(k, String.raw`printf '%-6s|%3d\n' apples 7 pears 12`), 'apples|  7\npears | 12\n')
  assert.deepEqual(k.sh(String.raw`printf '%4096s' x | wc -c; printf '%.4096d' 1 | wc -c`), ['4096', '4096'])
  assert.equal(textOf(k, String.raw`printf '%1s|%1d|%0d|%-d|\n' long 12345 6 7`), 'long|12345|6|7|\n')
})

test('printf: escapes in the format and in %b text, as the bytes they stand for', () => {
  const k = fresh()
  same(bytesOf(k, String.raw`printf '\a\b\e\f\n\r\t\v\\'`), new Uint8Array([7, 8, 27, 12, 10, 13, 9, 11, 92]), 'the letters')
  same(bytesOf(k, String.raw`printf '\0\0101\101\7\1012\x41\x4a\xff\x5\xfg\0'`), new Uint8Array([0, 65, 65, 7, 65, 50, 65, 74, 255, 5, 15, 103, 0]),
    'octal and hexadecimal')
  same(bytesOf(k, String.raw`printf '\xc3\xa9\303\251'`), encode('\u00e9\u00e9'), 'bytes that make a character')
  same(bytesOf(k, String.raw`printf '\q\x\8\"\c\'`), encode(String.raw`\q\x\8\"\c` + '\\'), 'what is no escape stays as it is')
  same(bytesOf(k, String.raw`printf 'a\\nb\%%c'`), encode(String.raw`a\nb\%c`), 'a backslash and a percent sign')
  same(bytesOf(k, String.raw`printf '%b|%b|%b' 'a\tb\n' '\0101\x42\103' '\\ \q'`), encode('a\tb\n|ABC|\\ \\q'), '%b')
  same(bytesOf(k, String.raw`printf '[%b]' 'one\ctwo' three`), encode('[one'), 'a \\c ends everything')
  same(bytesOf(k, String.raw`printf '%s\c|' x`), encode('x\\c|'), 'but only in %b text')
  same(bytesOf(k, String.raw`printf '[%6b][%-6b][%.2b]' 'a\tb' '\x41' 'x\ny'`), encode('[   a\tb][A     ][x\n]'), '%b with a width')
  same(bytesOf(k, String.raw`printf '%b' '\xff\0377' 'tail\'`), new Uint8Array([255, 255, 116, 97, 105, 108, 92]), '%b with bytes that are no text')
  same(bytesOf(k, String.raw`printf '%s' ` + '"\u00e9"'), new Uint8Array([0xc3, 0xa9]), 'text is UTF-8')
})

test('printf: what is no number counts as 0 and is reported; a format it cannot read is refused', () => {
  const k = fresh()
  // Each complaint comes as the item is reached, so the output is checked in a file and the complaints on the screen.
  assert.deepEqual(k.sh(String.raw`printf '%d,%d\n' abc 3 > out; echo $?`), ["!printf: 'abc': not a number", '1'])
  assert.equal(k.read('/tmp/out'), '0,3\n')
  assert.deepEqual(k.sh(String.raw`printf '%d\n' 12abc '' > out; echo $?`), ["!printf: '12abc': not a number", "!printf: '': not a number", '1'])
  assert.equal(k.read('/tmp/out'), '0\n0\n')
  assert.deepEqual(k.sh(String.raw`printf '%x\n' 08 1.5 0x 0xg "'ab" "'" > out; echo $?`), [
    "!printf: '08': not a number", "!printf: '1.5': not a number", "!printf: '0x': not a number", "!printf: '0xg': not a number",
    "!printf: ''ab': not a number",
    "!printf: ''': not a number", '1',
  ])
  assert.equal(k.read('/tmp/out'), '0\n0\n0\n0\n0\n0\n')
  assert.deepEqual(k.sh(String.raw`printf '%d %u\n' 9223372036854775808 18446744073709551616 > out; echo $?`),
    ["!printf: '9223372036854775808': a number too large for 64 bits", "!printf: '18446744073709551616': a number too large for 64 bits", '1'])
  assert.equal(k.read('/tmp/out'), '0 0\n')
  assert.deepEqual(k.sh(String.raw`printf '%d\n' -9223372036854775809 ${'9'.repeat(60)} > out; echo $?`),
    ["!printf: '-9223372036854775809': a number too large for 64 bits", `!printf: '${'9'.repeat(40)}...': not a number`, '1'])
  assert.equal(k.read('/tmp/out'), '0\n0\n')
  // On the screen what was printed before the item shows before the complaint, and the item's 0 after it.
  assert.deepEqual(k.sh(String.raw`printf 'a=%d\n' x; echo $?`), ['a=', "!printf: 'x': not a number", '0', '1'])
  assert.deepEqual(k.sh(String.raw`printf '%s %d\n' ok 5; echo $?`), ['ok 5', '0'])
  assert.deepEqual(k.sh('printf; echo $?'), ['!usage: printf format [argument ...]', '2'])
  assert.deepEqual(k.sh('printf --; echo $?'), ['!usage: printf format [argument ...]', '2'])
  const unknown = [['%f', '%f'], ['a%5.2q', '%5.2q'], ['%#x', '%#'], ['%*d', '%*'], ['%ld', '%l']]
  for (const [format, item] of unknown) {
    assert.deepEqual(k.sh(`printf '${format}' 1 2; echo $?`), [`!printf: '${item}': not an item this printf knows`, '1'], format)
  }
  for (const format of ['%-', 'x%', '%5.', '% ']) {
    const rest = format.slice(format.indexOf('%'))
    assert.deepEqual(k.sh(`printf '${format}' 1 2; echo $?`), [`!printf: '${rest}': the format stops in the middle of an item`, '1'], format)
  }
  assert.deepEqual(k.sh("printf '%4097s' x; echo $?"), ["!printf: '%4097s': a width or precision over 4096", '1'])
  assert.deepEqual(k.sh("printf '%.99999999999999999999d' 1; echo $?"), ["!printf: '%.99999999999999999999d': a width or precision over 4096", '1'])
  assert.deepEqual(k.sh(String.raw`printf '%s\n' $(seq 1 20000) | tail -n 1; seq 1 20000 | xargs -n 2 printf '%d %d\n' | tail -n 1`), ['20000', '19999 20000'])
})

// base64

test('base64: bytes into letters, in lines of a width', () => {
  const k = fresh()
  assert.equal(textOf(k, 'printf "" | base64'), '')
  assert.equal(textOf(k, 'printf f | base64'), 'Zg==\n')
  assert.equal(textOf(k, 'printf fo | base64'), 'Zm8=\n')
  assert.equal(textOf(k, 'printf foo | base64'), 'Zm9v\n')
  assert.equal(textOf(k, 'printf foob | base64'), 'Zm9vYg==\n')
  assert.equal(textOf(k, 'printf fooba | base64'), 'Zm9vYmE=\n')
  assert.equal(textOf(k, 'printf foobar | base64'), 'Zm9vYmFy\n')
  assert.equal(textOf(k, String.raw`printf '\xfb\xff\xfe' | base64`), '+//+\n')
  k.write('/tmp/f', 'x'.repeat(120))
  assert.equal(textOf(k, 'base64 f'), `${'eHh4'.repeat(19)}\n${'eHh4'.repeat(19)}\n${'eHh4'.repeat(2)}\n`)
  assert.equal(textOf(k, 'base64 < f'), textOf(k, 'base64 f'))
  assert.equal(textOf(k, 'base64 - < f'), textOf(k, 'base64 f'))
  assert.equal(textOf(k, 'base64 -w 0 f'), 'eHh4'.repeat(40))
  assert.equal(textOf(k, 'base64 -w 160 f'), `${'eHh4'.repeat(40)}\n`)
  assert.equal(textOf(k, 'base64 -w 100 f'), `${'eHh4'.repeat(25)}\n${'eHh4'.repeat(15)}\n`)
  assert.equal(textOf(k, 'base64 -w1 f | head -n 5'), 'e\nH\nh\n4\ne\n')
  assert.equal(textOf(k, 'printf abcd | base64 -w 3'), 'YWJ\njZA\n==\n')
  assert.equal(textOf(k, 'base64 -w 0 /dev/null'), '')
})

test('base64: letters back into bytes; what is not base64 is refused in words', () => {
  const k = fresh()
  assert.equal(textOf(k, 'printf Zm9vYmFy | base64 -d'), 'foobar')
  assert.equal(textOf(k, 'printf Zm9vYg== | base64 -d'), 'foob')
  assert.equal(textOf(k, 'printf Zm9vYmE= | base64 -d'), 'fooba')
  assert.equal(textOf(k, 'printf Zm9vYg | base64 -d'), 'foob')
  assert.equal(textOf(k, 'printf Zm9vYmE | base64 -d'), 'fooba')
  assert.equal(textOf(k, String.raw`printf ' Zm9v\n\tYm\r\nFy \n\n' | base64 -d`), 'foobar')
  assert.equal(textOf(k, String.raw`printf 'Zm9vYg=\n=\n' | base64 -d`), 'foob')
  assert.equal(textOf(k, 'printf "" | base64 -d'), '')
  same(bytesOf(k, 'printf +//+ | base64 -d'), new Uint8Array([0xfb, 0xff, 0xfe]), 'the two marks')
  // Each whole group of four before the bad place has been written when it is refused, one its = signs close too;
  // nothing after it is.
  const refused: readonly (readonly [string, string, string])[] = [
    ['Zm9v!Zm9v', "unexpected character '!'", 'foo'],
    ['Zm9vYm!', "unexpected character '!'", 'foo'],
    ['Zm9vYg==Zm9v', "text after the '=' signs that end it", 'foob'],
    ['Zm9vYmE=\nZm9v', "text after the '=' signs that end it", 'fooba'],
    ['Zm9vYg=Zm9v', "text after the '=' signs that end it", 'foo'],
    ['Zm9vY', 'it stops in the middle of a group of four', 'foo'],
    ['Zm9vYg=', "the '=' signs at the end do not fit", 'foo'],
    ['Zm9vYmE==', "the '=' signs at the end do not fit", 'fooba'],
    ['Zm9v=', "the '=' signs at the end do not fit", 'foo'],
    ['Zg===', "too many '=' signs at the end", 'f'],
    [String.raw`Zm9v\0`, 'unexpected byte 0x00', 'foo'],
    ['Zm9v-_', "unexpected character '-'", 'foo'],
    ['Zm9v\u{e9}', 'unexpected byte 0xc3', 'foo'],
  ]
  for (const [input, why, written] of refused) {
    assert.deepEqual(k.sh(`printf '${input}' | base64 -d > out; echo $?`), [`!base64: not base64: ${why}`, '1'], input)
    assert.equal(k.read('/tmp/out'), written, input)
  }
  k.write('/tmp/bad', 'Zm9v\n*\nZm9v\n')
  assert.deepEqual(k.sh('base64 -d bad > out; echo $?; wc -c out'), ["!base64: bad: not base64: unexpected character '*'", '1', '3 out'])
  const usage = '!usage: base64 [-d] [-w columns] [file]'
  assert.deepEqual(k.sh('base64 a b; echo $?'), ['!base64: only one file can be named', usage, '2'])
  assert.deepEqual(k.sh('base64 -w x a; echo $?'), ["!base64: option '-w' needs a whole number, not 'x'", usage, '2'])
})

test('base64: any bytes at all come back the same, whatever the width and however the reads fall', () => {
  const k = fresh()
  const raw = noise(200001, 13)
  k.write('/tmp/raw', raw)
  same(bytesOf(k, 'base64 raw | base64 -d'), raw, 'through a pipe')
  // 200001 bytes are 266668 characters: 3508 whole lines of 76 and one of 60; 4371 lines of 61 and one of 37.
  assert.deepEqual(k.sh('base64 raw > enc; base64 -w 0 raw > enc0; base64 -w 61 raw > enc61; wc -l enc enc0 enc61'),
    ['3509 enc', '   0 enc0', '4372 enc61', '7881 total'])
  same(bytesOf(k, 'base64 -d enc'), raw, 'lines of 76')
  same(bytesOf(k, 'base64 -d enc0'), raw, 'one line')
  same(bytesOf(k, 'base64 -d < enc61'), raw, 'lines of 61')
  assert.deepEqual(own(k.sh('head -n 1 enc | wc -c; tail -n 1 enc | wc -c; wc -c enc0')), ['77', '61', '266668 enc0'])
  for (const size of [1, 2, 3, 4, 65535, 65536, 65537]) {
    k.write('/tmp/part', raw.subarray(0, size))
    same(bytesOf(k, 'base64 part | base64 -d'), raw.subarray(0, size), `${size} bytes`)
  }
  assert.deepEqual(tasks(k), AT_REST)
})

// hexdump

test('hexdump: sixteen bytes to a line, as digits and as characters, and the length at the end', () => {
  const k = fresh()
  // The layout written out once by hand: the column of characters always starts in the same place.
  assert.deepEqual(k.sh('printf "Hello, world!\\n" | hexdump'), ['00000000  48 65 6c 6c 6f 2c 20 77  6f 72 6c 64 21 0a        |Hello, world!.|', '0000000e'])
  assert.deepEqual(k.sh('printf 0123456789abcdef | hexdump -C'), ['00000000  30 31 32 33 34 35 36 37  38 39 61 62 63 64 65 66  |0123456789abcdef|', '00000010'])
  assert.deepEqual(k.sh('printf 0123456789abcdefg | hexdump'), [dumpRow(0, [...encode('0123456789abcdef')]), dumpRow(16, [0x67]), '00000011'])
  assert.deepEqual(k.sh('printf A | hexdump; printf 12345678 | hexdump; printf 123456789 | hexdump'), [
    dumpRow(0, [0x41]), '00000001', dumpRow(0, [...encode('12345678')]), '00000008', dumpRow(0, [...encode('123456789')]), '00000009',
  ])
  for (const line of k.sh('printf A | hexdump; printf 123456789 | hexdump; printf 0123456789abcdef | hexdump')) {
    if (line.length > 8) assert.equal(line.indexOf('|'), 60, line)
  }
  assert.deepEqual(k.sh('hexdump /dev/null; hexdump < /dev/null; echo $?'), ['0'])
  assert.equal(textOf(k, 'printf "a b" | hexdump'), `${dumpRow(0, [0x61, 0x20, 0x62])}\n00000003\n`)
  const all = new Uint8Array(256)
  for (let i = 0; i < 256; i++) all[i] = i
  k.write('/tmp/all', all)
  const out = k.sh('hexdump all')
  assert.equal(out.length, 17)
  assert.equal(out[0], '00000000  00 01 02 03 04 05 06 07  08 09 0a 0b 0c 0d 0e 0f  |................|')
  assert.equal(out[2], '00000020  20 21 22 23 24 25 26 27  28 29 2a 2b 2c 2d 2e 2f  | !"#$%&\'()*+,-./|')
  assert.equal(out[7], '00000070  70 71 72 73 74 75 76 77  78 79 7a 7b 7c 7d 7e 7f  |pqrstuvwxyz{|}~.|')
  assert.equal(out[15], '000000f0  f0 f1 f2 f3 f4 f5 f6 f7  f8 f9 fa fb fc fd fe ff  |................|')
  assert.equal(out[16], '00000100')
})

test('hexdump: several files as one run, lines that repeat all printed, input in many pieces', () => {
  const k = fresh()
  k.write('/tmp/a', 'abcdefghij')
  k.write('/tmp/b', 'KLMNOPQRSTUVWXYZ')
  assert.deepEqual(k.sh('hexdump a b a'), [
    '00000000  61 62 63 64 65 66 67 68  69 6a 4b 4c 4d 4e 4f 50  |abcdefghijKLMNOP|',
    '00000010  51 52 53 54 55 56 57 58  59 5a 61 62 63 64 65 66  |QRSTUVWXYZabcdef|',
    dumpRow(32, [...encode('ghij')]),
    '00000024',
  ])
  assert.deepEqual(k.sh('hexdump a nosuch /tmp b; echo $?'), [
    '!hexdump: nosuch: no such file or directory', '!hexdump: /tmp: is a directory',
    '00000000  61 62 63 64 65 66 67 68  69 6a 4b 4c 4d 4e 4f 50  |abcdefghijKLMNOP|',
    dumpRow(16, [...encode('QRSTUVWXYZ')]),
    '0000001a', '1',
  ])
  // Lines that repeat are each printed, never folded into a *.
  k.write('/tmp/zeros', new Uint8Array(64))
  const zero = dumpRow(0, Array.from({ length: 16 }, () => 0)).slice(8)
  assert.deepEqual(k.sh('hexdump zeros'), ['00000000', '00000010', '00000020', '00000030'].map((at) => at + zero).concat(['00000040']))
  assert.ok(TEXT_MANUAL.hexdump.includes('never replaced by a *'))
  // A file that is not a whole number of lines long, read in pieces that are not either.
  const raw = noise(65536 + 21, 17)
  k.write('/tmp/odd', raw)
  assert.deepEqual(own(k.sh('hexdump odd | wc -l; hexdump odd | tail -n 1; hexdump odd odd | tail -n 1')), ['4099', '00010015', '0002002a'])
  const row = (at: number): string => dumpRow(at, [...raw.subarray(at, at + 16)])
  assert.equal(textOf(k, 'hexdump odd | head -n 4097 | tail -n 3'), `${row(65504)}\n${row(65520)}\n${row(65536)}\n`)
  assert.equal(textOf(k, 'hexdump < odd | head -n 2'), `${row(0)}\n${row(16)}\n`)
})

// sha256sum

test('sha256sum: the digest of each file and of the input', () => {
  const k = fresh()
  k.write('/tmp/abc', 'abc')
  k.write('/tmp/empty', '')
  // The digests the standard gives for "abc", for nothing, for its 56-letter text and for a million letters a.
  const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  const none = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  assert.deepEqual(k.sh('sha256sum abc'), [`${abc}  abc`])
  assert.deepEqual(k.sh('sha256sum empty abc /tmp/abc'), [`${none}  empty`, `${abc}  abc`, `${abc}  /tmp/abc`])
  assert.deepEqual(k.sh('sha256sum < abc; printf abc | sha256sum -; sha256sum < /dev/null'), [`${abc}  -`, `${abc}  -`, `${none}  -`])
  assert.deepEqual(k.sh('sha256sum abc nosuch /tmp empty; echo $?'),
    [`${abc}  abc`, '!sha256sum: nosuch: no such file or directory', '!sha256sum: /tmp: is a directory', `${none}  empty`, '1'])
  assert.deepEqual(k.sh('printf abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq | sha256sum'),
    ['248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1  -'])
  k.write('/tmp/million', 'a'.repeat(1000000))
  assert.deepEqual(k.sh('sha256sum million'), ['cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0  million'])
  assert.deepEqual(k.sh('sha256sum -c abc; echo $?'), ["!sha256sum: unknown option '-c'", '!usage: sha256sum [file ...]', '2'])
})

test('sha256sum: the input is digested a piece at a time, so its length has no limit and an endless one runs until Ctrl+C', () => {
  const k = fresh()
  // One byte past the 64 MiB a program may hold: the digest of that many zeros, worked out apart from this program.
  assert.deepEqual(k.sh('head -c 67108865 /dev/zero | sha256sum; echo $?'), ['91990977345985aaf03af1358f4f989d7eaf985b58529efb72f613c588f6599a  -', '0'])
  // An input that never ends is read for as long as it lasts: a few turns in, the program is still at it, and says nothing.
  k.system.type('sha256sum /dev/zero; echo $?')
  const seen: string[] = []
  for (let turn = 0; turn < 4; turn++) for (const e of k.system.run(50, Number.POSITIVE_INFINITY)) seen.push(e.kind === 'post' ? 'POST' : e.text)
  assert.deepEqual(seen, [])
  assert.deepEqual(tasks(k), [...AT_REST, 'sha256sum'])
  assert.equal(k.system.interrupt(), true)
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(tasks(k), AT_REST)
})

// xargs

test('xargs: words of the input become arguments, as many as asked or as fit', () => {
  const k = fresh()
  assert.deepEqual(k.sh('seq 5 | xargs'), ['1 2 3 4 5'])
  assert.deepEqual(k.sh('seq 5 | xargs echo n:'), ['n: 1 2 3 4 5'])
  assert.deepEqual(k.sh('seq 5 | xargs -n 2'), ['1 2', '3 4', '5'])
  assert.deepEqual(k.sh('seq 5 | xargs -n2 /bin/echo -n; echo'), ['1 23 45'])
  assert.deepEqual(k.sh('seq 3 | xargs -n 1 echo item'), ['item 1', 'item 2', 'item 3'])
  assert.deepEqual(k.sh("printf '  a   b\\n\\n\\tc\\n d' | xargs -n 1"), ['a', 'b', 'c', 'd'])
  assert.deepEqual(k.sh('seq 3 | xargs seq'), ['1', '3'])
  assert.deepEqual(k.sh("seq 3 | xargs printf '%s-%s\\n'"), ['1-2', '3-'])
  assert.deepEqual(k.sh('seq 3 | xargs -n 3 -r echo; echo $?'), ['1 2 3', '0'])
  // More than fits in one run is given to several: each run as many words as fit in 65536 bytes, the command included.
  assert.deepEqual(k.sh('seq 1 30000 | xargs | wc'), ['     3  30000 168894'])
  const counts = k.sh("seq 1 30000 | xargs sh -c 'echo $#' sh").map(Number)
  assert.equal(counts.length, 3)
  const command = 3 + 3 + 8 + 3
  let word = 1
  for (const n of counts) {
    let bytes = command
    for (let i = 0; i < n; i++) bytes += String(word++).length + 1
    assert.ok(bytes <= 65536, `a run of ${bytes} bytes`)
    if (word <= 30000) assert.ok(bytes + String(word).length + 1 > 65536, 'one more word would have fitted')
  }
  assert.equal(word, 30001)
  // The bytes are counted in UTF-8: a word of one e with an acute accent takes three (two, and one for its end).
  k.write('/tmp/e', '\u{e9}\n'.repeat(40000))
  assert.deepEqual(k.sh("xargs sh -c 'echo $#' sh < e"), [String(Math.floor((65536 - command) / 3)), String(40000 - Math.floor((65536 - command) / 3))])
  assert.deepEqual(tasks(k), AT_REST)
})

test('xargs: quotes and backslashes keep a blank in a word; -0 takes words as they are', () => {
  const k = fresh()
  k.write('/tmp/q', `one "two words" 'three  more' four\\ five ""  '' six"seven"eight a\\"b "it's" 'say "hi"' end\n`)
  // Empty quotes are an empty word: echo then prints its blank and nothing after it.
  assert.deepEqual(k.sh('xargs -n 1 echo . < q'), ['. one', '. two words', '. three  more', '. four five', '. ', '. ', '. sixseveneight', '. a"b', ". it's",
    '. say "hi"', '. end'])
  // A backslash keeps even a line end in its word.
  assert.deepEqual(k.sh("printf 'a\\\\\\nb c\\\\' | xargs -n 1 echo ."), ['. a', 'b', '. c\\'])
  assert.deepEqual(k.sh("printf 'a \"b\\nc\" d' | xargs; echo $?"), ['!xargs: a double quote is not closed', '1'])
  assert.deepEqual(k.sh("printf \"a 'b\" | xargs; echo $?"), ['!xargs: a single quote is not closed', '1'])
  assert.deepEqual(k.sh("printf 'one\\ntwo \"three\\n' | xargs -n 1; echo $?"), ['one', 'two', '!xargs: a double quote is not closed', '1'])
  k.write('/tmp/z', 'a b\0 c"d\0\0e\'f\ng\0last')
  assert.deepEqual(k.sh('xargs -0 -n 1 echo . < z'), ['. a b', '.  c"d', '. ', ". e'f", 'g', '. last'])
  assert.deepEqual(k.sh("xargs -0 sh -c 'echo $#' sh < z"), ['5'])
  assert.deepEqual(k.sh("printf 'x\\0' | xargs -0; printf '\\0' | xargs -0 sh -c 'echo $#' sh; printf '' | xargs -0 -r echo none"), ['x', '1'])
  k.write('/tmp/u', 'caf\u{e9} \u{1f600}\n')
  assert.deepEqual(k.sh('xargs -n 1 < u'), ['caf\u{e9}', '\u{1f600}'])
})

test('xargs: -I runs the command once a line with the line put in; -r; no input', () => {
  const k = fresh()
  assert.deepEqual(k.sh("seq 2 | xargs -I {} echo '<{}> and {}' again"), ['<1> and 1 again', '<2> and 2 again'])
  assert.deepEqual(k.sh("printf '  two words  \\n\\n\\tthree\\n' | xargs -I % echo '[%]'"), ['[two words  ]', '[three]'])
  assert.deepEqual(k.sh("printf 'a \"b  c\" d\\\\ e\\n' | xargs -I X echo 'X|X'"), ['a b  c d e|a b  c d e'])
  assert.deepEqual(k.sh('seq 2 | xargs -I {} echo same; seq 2 | xargs -I{} -n 5 echo {}{}'), ['same', 'same', '11', '22'])
  assert.deepEqual(k.sh("printf 'a b\\0c\\0' | xargs -0 -I @ echo '(@)'"), ['(a b)', '(c)'])
  assert.deepEqual(k.sh('printf echo | xargs -I C C ran'), ['ran'])
  assert.deepEqual(k.sh("printf '' | xargs -I {} echo never; echo $?"), ['0'])
  assert.deepEqual(k.sh("printf '' | xargs echo once; printf '\\n \\n' | xargs echo once; echo $?"), ['once', 'once', '0'])
  assert.deepEqual(k.sh("printf '' | xargs -r echo never; printf ' \\n' | xargs -r echo never; echo $?"), ['0'])
  assert.deepEqual(k.sh("printf '' | xargs; echo $?"), ['', '0'])
  // The command with the line put in must fit in 65536 bytes: 5 for echo, 1 for the end of the second argument, 700 for each of its @.
  const long = 'y'.repeat(700)
  assert.deepEqual(k.sh(`echo ${long} | xargs -I @ echo ${'@'.repeat(94)}; echo $?`),
    ['!xargs: the command for one line would be longer than 65536 bytes', '1'])
  assert.deepEqual(k.sh(`echo ${long} | xargs -I @ echo ${'@'.repeat(93)} | wc -c`), ['65101'])
})

test('xargs: the status says what became of the runs; the command reads nothing of the input', () => {
  const k = fresh()
  assert.deepEqual(k.sh('seq 3 | xargs nosuch; echo $?'), ['!xargs: nosuch: not found', '127'])
  assert.deepEqual(k.sh('seq 3 | xargs -n 1 /tmp/nosuch; echo $?'), ['!xargs: /tmp/nosuch: not found', '127'])
  k.write('/tmp/plain', 'echo not run\n')
  assert.deepEqual(k.sh('seq 3 | xargs -n 1 /tmp/plain; echo $?'), ['!xargs: /tmp/plain: permission denied', '126'])
  assert.deepEqual(k.sh('seq 3 | xargs /tmp; echo $?'), ['!xargs: /tmp: is a directory', '126'])
  assert.deepEqual(k.sh("seq 3 | xargs -n 1 sh -c 'exit 3' sh; echo $?"), ['123'])
  assert.deepEqual(k.sh("seq 3 | xargs -n 1 sh -c 'echo $1; test $1 != 2' sh; echo $?"), ['1', '2', '3', '123'])
  // A run ended from outside (here one that says it was, with 130) stops the rest.
  assert.deepEqual(k.sh("seq 3 | xargs -n 1 sh -c 'echo $1; if test $1 = 2; then exit 130; fi' sh; echo $?"), ['1', '2', '125'])
  assert.deepEqual(k.sh('seq 3 | xargs -n 1 head -n 1; echo $?'),
    ['!head: 1: no such file or directory', '!head: 2: no such file or directory', '!head: 3: no such file or directory', '123'])
  // What xargs has not read yet is not the command's to read: it gets an input that is empty.
  assert.deepEqual(k.sh("seq 5 | xargs -n 2 sh -c 'read x; echo \"$# [$x]\"' sh"), ['2 []', '2 []', '1 []'])
  // That empty input never takes the place of a closed one: xargs itself still finds nothing to read there.
  assert.deepEqual(k.sh('xargs <&-; echo $?'), ['!xargs: bad file descriptor', '1'])
  assert.deepEqual(k.sh('seq 2 | xargs -r >&-; echo $?'), ['!echo: write error: bad file descriptor', '123'])
  assert.deepEqual(k.sh('seq 3 | xargs -n 3 wc -c -'), ['!wc: 1: no such file or directory', '!wc: 2: no such file or directory',
    '!wc: 3: no such file or directory', '0 -', '0 total'])
  // A word too long to go with the command in one run is refused, and so is the run it would have been in.
  k.write('/tmp/w', `a ${'x'.repeat(65531)}`)
  assert.deepEqual(k.sh('xargs < w; echo $?'), ['!xargs: a word of the input is too long for one run (65536 bytes with the command)', '1'])
  k.write('/tmp/w', 'x'.repeat(65530))
  assert.deepEqual(k.sh('xargs < w | wc -c'), ['65531'])
  const usage = '!usage: xargs [-0r] [-n count] [-I word] [command [argument ...]]'
  assert.deepEqual(k.sh('xargs -n 0; echo $?'), ["!xargs: option '-n' needs a whole number of 1 or more, not '0'", usage, '2'])
  assert.deepEqual(k.sh('xargs -n; echo $?'), ["!xargs: option '-n' needs a value", usage, '2'])
  assert.deepEqual(k.sh("xargs -I '' echo; echo $?"), ["!xargs: option '-I' needs the word to replace", usage, '2'])
  assert.deepEqual(tasks(k), AT_REST)
})
