// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It tests the helpers every program shares: the line reader and the buffered writer of
 * lib.ts (lines cut at the limit wherever the reads fall, and marked as cut, characters put back together across
 * reads, a byte order mark kept), the option reader, the loop over named files, whole numbers from options, the
 * calendar worked out by plain arithmetic, sizes for people; the byte helpers of bytes.ts (UTF-8, base64, hex,
 * joining, splitting into lines, 32-bit numbers); and the reasons of errno.ts, each in the words a person reads.
 * What breaks if it is removed? Some seventy programs lean on these few functions; a slip in one (a line cut in the
 * middle of a character, a date a day off, an option taken for an argument) would show up everywhere at once and be
 * blamed on whichever program a person happened to run.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EMPTY, concat, decode, encode, fromBase64, hex, linesOf, readU32, toBase64, writeU32 } from './bytes.ts'
import { ERRNO_TEXT, OsError, reasonOf, refuse } from './errno.ts'
import type { Errno } from './errno.ts'
import type { Program, Sys } from './kernel.ts'
import { boot } from './kit.test.ts'
import { LINE_BYTES_MAX, Lines, MONTHS, Out, WEEKDAYS, civil, complain, count, human, inputs, options, stamp, two, usage } from './lib.ts'
import type { Task } from './task.ts'
import { now } from './task.ts'

const MAX = LINE_BYTES_MAX

/** A stand-in for the kernel's calls: each read hands out the next of `chunks` (then nothing), and every write is kept. */
function fake(chunks: readonly Uint8Array[] = []): { sys: Sys; writes: Uint8Array[]; reads: () => number } {
  const writes: Uint8Array[] = []
  const queue = [...chunks]
  let reads = 0
  const sys = {
    *read(_fd: number): Task<Uint8Array> {
      reads++
      return queue.shift() ?? EMPTY
    },
    *write(_fd: number, data: Uint8Array): Task<number> {
      writes.push(data.slice())
      return data.length
    },
  }
  return { sys: sys as unknown as Sys, writes, reads: () => reads }
}

/** Bytes in pieces of `size` (the last may be shorter). */
function pieces(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size))
  return out
}

/** Every line `Lines` gives for these reads, each with whether it was a cut piece. */
function lines(chunks: readonly Uint8Array[]): { line: string; cut: boolean }[] {
  const r = new Lines(fake(chunks).sys, 0)
  const out: { line: string; cut: boolean }[] = []
  for (let l = now(r.next()); l !== null; l = now(r.next())) out.push({ line: l, cut: r.cut })
  assert.equal(r.cut, false, 'the end of the input is no piece')
  return out
}

/** Just the lines' text. */
const texts = (chunks: readonly Uint8Array[]): string[] => lines(chunks).map((l) => l.line)

// Lines

test('Lines: each line without its line end, a carriage return kept, a last line without one, and nothing for nothing', () => {
  assert.deepEqual(texts([encode('a\nb\n')]), ['a', 'b'])
  assert.deepEqual(texts([encode('a\nb')]), ['a', 'b'])
  assert.deepEqual(texts([]), [])
  assert.deepEqual(texts([encode('')]), [])
  assert.deepEqual(texts([encode('\n\n\n')]), ['', '', ''])
  assert.deepEqual(texts([encode('dos\r\nline\r\n\r')]), ['dos\r', 'line\r', '\r'])
  assert.deepEqual(texts([encode('one'), encode(' line'), encode(' in three\nand'), encode(' more')]), ['one line in three', 'and more'])
  // Ordinary lines are never marked as pieces.
  assert.ok(lines([encode('a\nb\n')]).every((l) => !l.cut))
  // After the end it stays at the end, and reads no more.
  const f = fake([encode('x\n')])
  const r = new Lines(f.sys, 0)
  assert.equal(now(r.next()), 'x')
  assert.equal(now(r.next()), null)
  const after = f.reads()
  assert.equal(now(r.next()), null)
  assert.equal(f.reads(), after)
})

test('Lines: a character split between reads at any byte comes back whole, and bytes that are no UTF-8 read as U+FFFD', () => {
  const text = 'café €\n\u{1f600}中\nend ÿ\n'
  const bytes = encode(text)
  for (let size = 1; size <= bytes.length; size++) assert.deepEqual(texts(pieces(bytes, size)), ['café €', '\u{1f600}中', 'end ÿ'], `reads of ${size}`)
  assert.deepEqual(texts([Uint8Array.of(0x61, 0xff, 0x62, 10, 0xe2, 0x82)]), ['a�b', '�'])
  assert.deepEqual(texts([Uint8Array.of(0xf0, 0x9f), Uint8Array.of(10)]), ['�'])
})

test('Lines: a byte order mark at the start is kept, so text passes through a program unchanged', () => {
  const bom = [0xef, 0xbb, 0xbf]
  assert.deepEqual(texts([Uint8Array.of(...bom, 0x61, 10, 0x62, 10)]), ['﻿a', 'b'])
  assert.deepEqual(texts([Uint8Array.of(0xef), Uint8Array.of(0xbb, 0xbf), Uint8Array.of(0x61)]), ['﻿a'])
  assert.deepEqual(texts([Uint8Array.of(...bom, ...bom, 10)]), ['﻿﻿'])
  assert.deepEqual(texts([Uint8Array.of(0x61, 10, ...bom, 10)]), ['a', '﻿'])
})

test('Lines: a line of exactly the limit is whole; a longer one comes in pieces marked as cut, wherever its end falls among the reads', () => {
  const exact = 'e'.repeat(MAX)
  const over = 'o'.repeat(MAX + 1)
  const long = `${'l'.repeat(2 * MAX)}tail`
  const text = `${exact}\n${over}\n${long}\nshort\n${over}`
  const want = [
    { line: exact, cut: false },
    { line: over.slice(0, MAX), cut: true }, { line: 'o', cut: false },
    { line: long.slice(0, MAX), cut: true }, { line: long.slice(MAX, 2 * MAX), cut: true }, { line: 'tail', cut: false },
    { line: 'short', cut: false },
    { line: over.slice(0, MAX), cut: true }, { line: 'o', cut: false },
  ]
  const bytes = encode(text)
  // All in one read (the line end is there at once), in reads of 64 KiB, and in reads of an odd size.
  for (const size of [bytes.length, 65536, 999983]) assert.deepEqual(lines(pieces(bytes, size)), want, `reads of ${size}`)
  // Put back together, the pieces are the text exactly.
  let joined = ''
  for (const l of lines([bytes])) joined += l.line + (l.cut ? '' : '\n')
  assert.equal(joined, `${text}\n`)
})

test('Lines: a piece never ends between the two halves of a character beyond U+FFFF, so it may be one short of the limit', () => {
  // A pair that would straddle the limit goes to the next piece whole.
  const line = `${'x'.repeat(MAX - 1)}\u{1f600}y`
  assert.deepEqual(lines([encode(`${line}\n`)]), [{ line: 'x'.repeat(MAX - 1), cut: true }, { line: '\u{1f600}y', cut: false }])
  // A line of nothing but such characters: every piece is whole pairs, and the pieces are the line.
  const faces = '\u{1f600}'.repeat(MAX + 3)
  const got = lines(pieces(encode(faces), 65536))
  assert.deepEqual(got.map((l) => l.cut), [true, true, false])
  for (const l of got) {
    assert.equal(l.line.length % 2, 0)
    assert.equal(l.line, '\u{1f600}'.repeat(l.line.length / 2))
    assert.ok(l.line.length <= MAX)
  }
  assert.equal(got.map((l) => l.line).join(''), faces)
  // Written back out, nothing is lost or replaced: the bytes are the bytes that came in.
  assert.deepEqual(encode(got.map((l) => l.line).join('')), encode(faces))
})

test('Lines: a refused read is the caller\'s to hear', () => {
  const sys = { *read(): Task<Uint8Array> { return refuse('EISDIR') } } as unknown as Sys
  assert.throws(() => now(new Lines(sys, 3).next()), (e: unknown) => e instanceof OsError && e.errno === 'EISDIR')
})

// Out

test('Out: text waits in the buffer until it holds 8192 characters or is flushed; bytes go after the text before them', () => {
  const f = fake()
  const out = new Out(f.sys)
  now(out.put(''))
  now(out.flush())
  assert.equal(f.writes.length, 0)
  now(out.put('x'.repeat(8190)))
  now(out.line('y'))
  assert.equal(f.writes.length, 1)
  assert.equal(decode(f.writes[0]), `${'x'.repeat(8190)}y\n`)
  now(out.line('café'))
  assert.equal(f.writes.length, 1)
  now(out.bytes(Uint8Array.of(0, 255)))
  now(out.bytes(EMPTY))
  assert.deepEqual(f.writes.slice(1), [encode('café\n'), Uint8Array.of(0, 255)])
  now(out.put('last'))
  now(out.flush())
  now(out.flush())
  assert.deepEqual(f.writes.slice(3), [encode('last')])
  // A refused write reaches the caller, and what was refused is not written again.
  const sys = { *write(): Task<number> { return refuse('EPIPE') } } as unknown as Sys
  const closed = new Out(sys)
  now(closed.put('gone'))
  assert.throws(() => now(closed.flush()), (e: unknown) => e instanceof OsError && e.errno === 'EPIPE')
  now(closed.flush())
})

// options

test('options: letters alone or joined, values joined or apart, -- and - and the first operand end them', () => {
  const o = options(['ls', '-la', '-n', '5', '-w3', 'file', '-x'], 'la', 'nw')
  assert.deepEqual([...o.flags].sort(), ['a', 'l', 'n', 'w'])
  assert.deepEqual([...o.values], [['n', '5'], ['w', '3']])
  assert.deepEqual(o.rest, ['file', '-x'])
  assert.equal(o.bad, null)
  assert.deepEqual(options(['p', '--', '-l'], 'l').rest, ['-l'])
  assert.deepEqual(options(['p', '-', '-l'], 'l').rest, ['-', '-l'])
  assert.deepEqual(options(['p'], 'l').rest, [])
  // A value letter takes the rest of its group, or the next argument whatever it looks like.
  assert.deepEqual([...options(['p', '-ln5'], 'l', 'n').values], [['n', '5']])
  assert.deepEqual([...options(['p', '-nl'], 'l', 'n').values], [['n', 'l']])
  assert.deepEqual([...options(['p', '-n', '-5'], '', 'n').values], [['n', '-5']])
  assert.deepEqual([...options(['p', '-n', '--'], '', 'n').values], [['n', '--']])
  // Given twice, the last value counts.
  assert.equal(options(['p', '-n', '1', '-n2'], '', 'n').values.get('n'), '2')
  // Long words.
  const long = options(['p', '--all', '-l', 'x'], 'l', '', ['all', 'help'])
  assert.deepEqual([...long.flags].sort(), ['all', 'l'])
  assert.deepEqual(long.rest, ['x'])
})

test('options: what is wrong is said once, and the rest is not read as options', () => {
  assert.equal(options(['p', '-q'], 'l').bad, "unknown option '-q'")
  assert.equal(options(['p', '-lq', 'x'], 'l').bad, "unknown option '-q'")
  assert.equal(options(['p', '-n'], '', 'n').bad, "option '-n' needs a value")
  assert.equal(options(['p', '--size'], '', '', ['all']).bad, "unknown option '--size'")
  assert.equal(options(['p', '--all=1'], '', '', ['all']).bad, "unknown option '--all=1'")
  const after = options(['p', '-q', '-l', 'x'], 'l')
  assert.deepEqual(after.rest, ['-q', '-l', 'x'])
  assert.ok(!after.flags.has('l'))
})

// count

test('count: a whole number written in digits, at least the least, and within what is exact', () => {
  assert.equal(count('0'), 0)
  assert.equal(count('007'), 7)
  assert.equal(count('9007199254740991'), 9007199254740991)
  assert.equal(count('9007199254740992'), null)
  assert.equal(count('99999999999999999999999'), null)
  for (const bad of [undefined, '', '-1', '+1', '1.5', '1e3', ' 1', '1 ', '0x10', 'five', '١']) assert.equal(count(bad), null, JSON.stringify(bad))
  assert.equal(count('0', 1), null)
  assert.equal(count('1', 1), 1)
})

// civil, stamp, two, human

test('civil: the calendar of known moments, worked out apart from this code, before 1970 and long after', () => {
  const known: [number, number, number, number, number, number, number, number, number][] = [
    [0, 1970, 1, 1, 0, 0, 0, 4, 1],
    [-1, 1969, 12, 31, 23, 59, 59, 3, 365],
    [999, 1970, 1, 1, 0, 0, 0, 4, 1],
    [-1000, 1969, 12, 31, 23, 59, 59, 3, 365],
    [951782400000, 2000, 2, 29, 0, 0, 0, 2, 60],
    [951868800000, 2000, 3, 1, 0, 0, 0, 3, 61],
    [4107456000000, 2100, 2, 28, 0, 0, 0, 0, 59],
    [4107542400000, 2100, 3, 1, 0, 0, 0, 1, 60],
    [1794679200000, 2026, 11, 14, 18, 0, 0, 6, 318],
    [1704067199000, 2023, 12, 31, 23, 59, 59, 0, 365],
    [1735689599000, 2024, 12, 31, 23, 59, 59, 2, 366],
    [253402300799999, 9999, 12, 31, 23, 59, 59, 5, 365],
    [-62135596800000, 1, 1, 1, 0, 0, 0, 1, 1],
    [-62167219200000, 0, 1, 1, 0, 0, 0, 6, 1],
    [8.64e15, 275760, 9, 13, 0, 0, 0, 6, 257],
    [-8.64e15, -271821, 4, 20, 0, 0, 0, 2, 110],
  ]
  for (const [ms, year, month, day, hour, minute, second, weekday, yearDay] of known) {
    assert.deepEqual(civil(ms), { year, month, day, hour, minute, second, weekday, yearDay }, String(ms))
  }
  // No number at all is the first moment, not a crash.
  for (const odd of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) assert.deepEqual(civil(odd), civil(0))
})

test('civil: day after day for four hundred years, each date follows the one before it', () => {
  const lengths = (year: number): number[] => {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  }
  let prev = civil(-86400000 * 365 * 30 + 43200000)
  for (let d = 1; d < 146097; d++) {
    const c = civil(-86400000 * 365 * 30 + 43200000 + d * 86400000)
    if (prev.day < lengths(prev.year)[prev.month - 1]) {
      assert.deepEqual([c.year, c.month, c.day, c.yearDay], [prev.year, prev.month, prev.day + 1, prev.yearDay + 1])
    } else if (prev.month < 12) {
      assert.deepEqual([c.year, c.month, c.day, c.yearDay], [prev.year, prev.month + 1, 1, prev.yearDay + 1])
    } else {
      assert.deepEqual([c.year, c.month, c.day, c.yearDay], [prev.year + 1, 1, 1, 1])
    }
    assert.equal(c.weekday, (prev.weekday + 1) % 7)
    assert.deepEqual([c.hour, c.minute, c.second], [12, 0, 0])
    prev = c
  }
  // And within a day, every second is where it should be.
  for (let s = 0; s < 86400; s += 61) {
    const c = civil(s * 1000 + 999)
    assert.deepEqual([c.hour, c.minute, c.second], [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60])
  }
})

test('stamp, two, and the names of months and days', () => {
  assert.equal(stamp(1794679200000), '2026-11-14 18:00')
  assert.equal(stamp(0), '1970-01-01 00:00')
  assert.equal(stamp(-1), '1969-12-31 23:59')
  assert.equal(stamp(951782459999), '2000-02-29 00:00')
  assert.deepEqual([two(0), two(9), two(10), two(59)], ['00', '09', '10', '59'])
  assert.equal(MONTHS.length, 12)
  assert.deepEqual([MONTHS[0], MONTHS[11], WEEKDAYS[0], WEEKDAYS[6]], ['Jan', 'Dec', 'Sun', 'Sat'])
  assert.ok(Object.isFrozen(MONTHS) && Object.isFrozen(WEEKDAYS))
})

test('human: bytes under 1024 as they are, then one decimal under ten and none above, and 1024 of a unit is one of the next', () => {
  const cases: [number, string][] = [
    [0, '0'], [1, '1'], [512, '512'], [1023, '1023'], [1024, '1K'], [1536, '1.5K'], [1024 * 9.95, '10K'], [10239, '10K'], [20 * 1024, '20K'],
    [1024 * 1024 - 1, '1M'], [1024 * 1023.4, '1023K'], [1024 * 1023.6, '1M'], [1024 * 1024, '1M'], [20 * 1024 * 1024, '20M'],
    [3.2 * 1024 ** 3, '3.2G'], [1024 ** 4 - 1, '1T'], [1024 ** 4, '1T'], [1024 ** 5, '1024T'], [2 * 1024 ** 5, '2048T'],
  ]
  for (const [bytes, want] of cases) assert.equal(human(bytes), want, String(bytes))
})

// inputs, complain, usage: through a program at the shell

const PROGRAMS: Readonly<Record<string, Program>> = {
  /** Prints each input with its label, and the descriptor it was read from; `pipe` and `boom` in an input are trouble. */
  each: function* (sys, argv) {
    const fds: number[] = []
    const status = yield* inputs(sys, 'each', argv.slice(1), function* (fd, label) {
      fds.push(fd)
      const text = decode(yield* sys.readAll(fd))
      if (text.startsWith('pipe')) refuse('EPIPE')
      if (text.startsWith('boom')) throw new RangeError('boom')
      if (text.startsWith('full')) refuse('ENOSPC', 'the disk is full')
      yield* sys.print(`${label}: ${text}`)
    })
    yield* sys.print(`fds ${fds.join(' ')} status ${status}\n`)
    return status
  },
  say: function* (sys, argv) {
    const why = argv[2] === 'error' ? new OsError('ENOENT') : argv[2] === 'thrown' ? new RangeError('odd') : (argv[2] ?? 'why')
    yield* complain(sys, 'say', argv[1] ?? null, why)
    return yield* usage(sys, 'say [what] [why]')
  },
}

test('inputs: each named file or the input, a file that cannot be opened told and passed over, a refusal inside named after its file', () => {
  const k = boot(PROGRAMS)
  k.write('/tmp/a', 'one\n')
  k.write('/tmp/b', 'two\n')
  k.write('/tmp/full', 'full\n')
  assert.deepEqual(k.sh('cd /tmp; each a b'), ['a: one', 'b: two', 'fds 3 3 status 0'])
  assert.deepEqual(k.sh('echo typed | each'), ['(standard input): typed', 'fds 0 status 0'])
  assert.deepEqual(k.sh('echo typed | each a - b'), ['a: one', '(standard input): typed', 'b: two', 'fds 3 0 3 status 0'])
  assert.deepEqual(k.sh('each a nosuch b; echo $?'), ['a: one', '!each: nosuch: no such file or directory', 'b: two', 'fds 3 3 status 1', '1'])
  // A directory is refused when it is opened, so the body never sees it.
  assert.deepEqual(k.sh('each /tmp a'), ['!each: /tmp: is a directory', 'a: one', 'fds 3 status 1'])
  assert.deepEqual(k.sh('each full a'), ['!each: full: the disk is full', 'a: one', 'fds 3 3 status 1'])
  assert.deepEqual(k.sh('echo full | each'), ['!each: the disk is full', 'fds 0 status 1'])
  // Every file is closed once read: a hundred of them still come in on descriptor 3.
  const many = Array.from({ length: 100 }, () => 'a').join(' ')
  const out = k.sh(`each ${many}`)
  assert.equal(out[out.length - 1], `fds ${Array.from({ length: 100 }, () => '3').join(' ')} status 0`)
})

test('inputs: a closed pipe and anything that is not a refusal go on up, and the file is still closed', () => {
  const k = boot(PROGRAMS)
  k.write('/tmp/pipe', 'pipe\n')
  k.write('/tmp/boom', 'boom\n')
  k.write('/tmp/a', 'one\n')
  // The closed pipe ends the program quietly (the shell says so), and nothing after it runs.
  const piped = k.sh('cd /tmp; each pipe a; echo $?')
  assert.equal(piped[piped.length - 1], '141')
  assert.ok(!piped.some((l) => l.includes('fds')), piped.join('|'))
  const boom = k.sh('each boom a; echo $?')
  assert.ok(!boom.some((l) => l.includes('fds') || l.startsWith('a:')), boom.join('|'))
  assert.notEqual(boom[boom.length - 1], '0')
  assert.deepEqual(k.sh('each a'), ['a: one', 'fds 3 status 0'])
})

test('complain and usage: name, what and why on the error output, and a usage line with status 2', () => {
  const k = boot(PROGRAMS)
  assert.deepEqual(k.sh('say f why; echo $?'), ['!say: f: why', '!usage: say [what] [why]', '2'])
  assert.deepEqual(k.sh('say'), ['!say: why', '!usage: say [what] [why]'])
  assert.deepEqual(k.sh('say f error'), ['!say: f: no such file or directory', '!usage: say [what] [why]'])
  assert.deepEqual(k.sh('say f thrown'), ['!say: f: odd', '!usage: say [what] [why]'])
})

// bytes.ts

test('bytes: UTF-8 both ways, never refusing: half a pair is written as U+FFFD, and bytes that are no UTF-8 read as it', () => {
  for (const text of ['', 'plain', 'café', '€', '\u{1f600}', '中文', 'a\0b', '�']) assert.equal(decode(encode(text)), text, JSON.stringify(text))
  assert.deepEqual(encode('é€\u{1f600}'), Uint8Array.of(0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80))
  assert.deepEqual(encode('a\ud800b'), Uint8Array.of(0x61, 0xef, 0xbf, 0xbd, 0x62))
  assert.deepEqual(encode('\udc00'), Uint8Array.of(0xef, 0xbf, 0xbd))
  assert.equal(decode(Uint8Array.of(0xff, 0x61, 0xc0, 0x80, 0xed, 0xa0, 0x80)), '�a�����')
  assert.equal(decode(Uint8Array.of(0xe2, 0x82)), '�')
  // Each call stands alone: a piece cut short does not wait for the next call.
  assert.equal(decode(Uint8Array.of(0xf0, 0x9f)) + decode(Uint8Array.of(0x98, 0x80)), '���')
  assert.equal(EMPTY.length, 0)
})

test('bytes: concat joins in order into a new array; hex is two lower-case digits a byte', () => {
  assert.deepEqual(concat([]), new Uint8Array(0))
  assert.deepEqual(concat([EMPTY, Uint8Array.of(1, 2), EMPTY, Uint8Array.of(3)]), Uint8Array.of(1, 2, 3))
  const one = Uint8Array.of(9)
  const joined = concat([one])
  assert.notEqual(joined, one)
  joined[0] = 1
  assert.equal(one[0], 9)
  const big = new Uint8Array(100000).fill(7)
  assert.equal(concat([big, big, big]).length, 300000)
  // A view into a larger array gives only its own bytes.
  assert.deepEqual(concat([big.subarray(5, 7), Uint8Array.of(1).subarray(0, 1)]), Uint8Array.of(7, 7, 1))
  assert.equal(hex(EMPTY), '')
  assert.equal(hex(Uint8Array.of(0, 1, 15, 16, 127, 128, 254, 255)), '00010f107f80feff')
})

test('bytes: base64 both ways, with the standard examples, every length, blanks skipped, and anything else refused', () => {
  const examples: [string, string][] = [
    ['', ''], ['f', 'Zg=='], ['fo', 'Zm8='], ['foo', 'Zm9v'], ['foob', 'Zm9vYg=='], ['fooba', 'Zm9vYmE='], ['foobar', 'Zm9vYmFy'],
  ]
  for (const [plain, coded] of examples) {
    assert.equal(toBase64(encode(plain)), coded)
    assert.equal(decode(fromBase64(coded)), plain)
  }
  assert.equal(toBase64(Uint8Array.of(0xfb, 0xff, 0xbf)), '+/+/')
  for (let n = 0; n <= 300; n++) {
    const data = new Uint8Array(n)
    for (let i = 0; i < n; i++) data[i] = (i * 151 + n) & 255
    assert.deepEqual(fromBase64(toBase64(data)), data, `${n} bytes`)
  }
  // Long enough to be built in parts.
  const long = new Uint8Array(50000)
  for (let i = 0; i < long.length; i++) long[i] = (i * 31) & 255
  const coded = toBase64(long)
  assert.equal(coded.length, Math.ceil(50000 / 3) * 4)
  assert.deepEqual(fromBase64(coded), long)
  assert.deepEqual(fromBase64(' Zm9v\r\nYmFy\t'), encode('foobar'))
  assert.deepEqual(fromBase64('Zm9vYg'), encode('foob'))
  for (const bad of ['Z', 'Zm9vY', 'Zm=9', '=Zm9', 'Zm9v=', 'Zg===', 'Zg=', 'Zm9v====', '****', 'Zm9vé', 'Zm9v-_', 'Zg==Zg==']) {
    assert.throws(() => fromBase64(bad), (e: unknown) => e instanceof OsError && e.errno === 'EINVAL', JSON.stringify(bad))
  }
})

test('bytes: lines of a text, a carriage return before each line feed dropped, and 32-bit numbers both ways', () => {
  assert.deepEqual(linesOf(''), [])
  assert.deepEqual(linesOf('a\nb\n'), ['a', 'b'])
  assert.deepEqual(linesOf('a\nb'), ['a', 'b'])
  assert.deepEqual(linesOf('\n'), [''])
  assert.deepEqual(linesOf('\n\n'), ['', ''])
  assert.deepEqual(linesOf('a\r\nb\r\n'), ['a', 'b'])
  assert.deepEqual(linesOf('a\r\r\n'), ['a\r'])
  const at = new Uint8Array(9)
  for (const value of [0, 1, 255, 256, 65535, 2147483647, 2147483648, 4294967295]) {
    writeU32(at, 3, value)
    assert.equal(readU32(at, 3), value, String(value))
  }
  writeU32(at, 0, 0x01020304)
  assert.deepEqual(at.subarray(0, 4), Uint8Array.of(4, 3, 2, 1))
})

// errno.ts

test('errno: every reason has its words, in lower case without a full stop, and a refusal carries both', () => {
  const names = Object.keys(ERRNO_TEXT) as Errno[]
  assert.ok(names.length >= 28)
  assert.ok(Object.isFrozen(ERRNO_TEXT))
  const seen = new Set<string>()
  for (const name of names) {
    assert.match(name, /^E[A-Z0-9]+$/)
    const text = ERRNO_TEXT[name]
    assert.match(text, /^[a-z][a-z /-]*[a-z]$/, name)
    assert.ok(!seen.has(text), `${name}: the same words as another reason`)
    seen.add(text)
    const e = new OsError(name)
    assert.ok(e instanceof Error)
    assert.equal(e.errno, name)
    assert.equal(e.message, text)
    assert.equal(reasonOf(e), text)
  }
  assert.equal(ERRNO_TEXT.ENOENT, 'no such file or directory')
  assert.equal(ERRNO_TEXT.EPIPE, 'broken pipe')
  // Detail replaces the words; the reason stays.
  const detailed = new OsError('EACCES', 'the operator tier is locked')
  assert.equal(detailed.errno, 'EACCES')
  assert.equal(detailed.message, 'the operator tier is locked')
  assert.throws(() => refuse('EROFS'), (e: unknown) => e instanceof OsError && e.errno === 'EROFS' && e.message === 'read-only file system')
  assert.throws(() => refuse('EINVAL', 'why'), (e: unknown) => e instanceof OsError && e.message === 'why')
  assert.equal(reasonOf(new RangeError('too far')), 'too far')
  assert.equal(reasonOf('plain words'), 'plain words')
  assert.equal(reasonOf(42), '42')
  assert.equal(reasonOf(null), 'null')
})
