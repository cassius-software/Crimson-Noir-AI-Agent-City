// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the terminal (tty.ts) to what it promises both ways. Going out: bytes become
 * lines across writes and across a character split between writes, ordinary and error output stay apart, a carriage
 * return, a backspace and a tab move the column the way a terminal moves it, control characters and colour or cursor
 * sequences are dropped without taking anything else with them, a line is cut at LINE_MAX and only EVENTS_MAX lines
 * wait to be collected. Coming in: typed text becomes lines, at most INPUT_MAX of them wait, a flood is refused whole,
 * an end of input is handed out once, and Ctrl+C's forgetting drops everything typed ahead.
 * What breaks if it is removed? A tab at the end of a long line could freeze the page, a stray escape byte could
 * silence every later line, and typed input could grow without bound, without a test noticing.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decode, encode } from './bytes.ts'
import { FILE_PROGRAMS } from './fileutils.ts'
import { boot } from './kit.test.ts'
import { EVENTS_MAX, INPUT_MAX, LINE_MAX, Tty } from './tty.ts'
import type { TtyEvent } from './tty.ts'

/** What a terminal shows for these writes, each `[stream, text]`: ordinary lines as they are, error lines with `!`. */
function shown(writes: readonly (readonly ['out' | 'err', string | Uint8Array])[], tty = new Tty()): string[] {
  for (const [stream, text] of writes) tty.write(stream, typeof text === 'string' ? encode(text) : text)
  return lines(tty.drain())
}

function lines(events: readonly TtyEvent[]): string[] {
  return events.map((e) => (e.kind === 'post' ? `POST ${JSON.stringify(e.payload)}` : `${e.kind === 'err' ? '!' : ''}${e.text}`))
}

// Going out.

test('bytes become lines across writes, a character split between writes is put back together, a bad byte shows as a replacement', () => {
  const e = encode('café ☃\n')
  assert.deepEqual(shown([['out', 'ab'], ['out', 'c\nde'], ['out', 'f\n']]), ['abc', 'def'])
  // Every split of a multi-byte character comes out whole.
  for (let cut = 1; cut < e.length; cut++) assert.deepEqual(shown([['out', e.subarray(0, cut)], ['out', e.subarray(cut)]]), ['café ☃'], `cut ${cut}`)
  assert.deepEqual(shown([['out', new Uint8Array([0x61, 0xff, 0x62, 0x0a])]]), ['a�b'])
  // A line feed alone is an empty line; output ending without one waits.
  assert.deepEqual(shown([['out', '\n\nlast']]), ['', ''])
})

test('ordinary and error output stay apart: a switch ends the line being assembled, and each keeps its own half character', () => {
  assert.deepEqual(shown([['out', 'out '], ['err', 'err\n'], ['out', 'again\n']]), ['out ', '!err', 'again'])
  const snow = encode('☃')
  assert.deepEqual(shown([['out', snow.subarray(0, 1)], ['err', 'x\n'], ['out', snow.subarray(1)], ['out', '\n']]), ['!x', '☃'])
})

test('a carriage return goes back to the first column and a backspace one column, and neither erases what is there', () => {
  assert.deepEqual(shown([['out', 'hello\rJ\n']]), ['Jello'])
  assert.deepEqual(shown([['out', 'progress 10%\rprogress 100%\n']]), ['progress 100%'])
  assert.deepEqual(shown([['out', 'abc\b\bX\n']]), ['aXc'])
  // A backspace at the first column stays there; a line ended by a carriage return and a line feed is the line.
  assert.deepEqual(shown([['out', '\b\bab\r\n']]), ['ab'])
})

test('a tab moves to the next eighth: it pads with spaces where nothing is, and moves over what is already there', () => {
  assert.deepEqual(shown([['out', 'a\tb\n']]), ['a       b'])
  assert.deepEqual(shown([['out', 'abcdefgh\tX\n']]), ['abcdefgh        X'])
  assert.deepEqual(shown([['out', '\t\n']]), ['        '])
  assert.deepEqual(shown([['out', 'a\t\tb\n']]), [`a${' '.repeat(15)}b`])
  // After a carriage return a tab passes over the text, as a terminal's does.
  assert.deepEqual(shown([['out', 'abcdefghij\r\tX\n']]), ['abcdefghXj'])
  assert.deepEqual(shown([['out', 'abc\r\t\tX\n']]), [`abc${' '.repeat(13)}X`])
})

test('a tab at the end of the longest line stays at its end: the line is cut and nothing hangs', () => {
  assert.deepEqual(shown([['out', `${'x'.repeat(LINE_MAX)}\tafter\n`]]), ['x'.repeat(LINE_MAX), 'after'])
  assert.deepEqual(shown([['out', `${'x'.repeat(LINE_MAX - 3)}\tafter\n`]]), [`${'x'.repeat(LINE_MAX - 3)}   `, 'after'])
  for (const n of [LINE_MAX - 1, LINE_MAX + 1, LINE_MAX * 2]) {
    const out = shown([['out', `${'y'.repeat(n)}\t\tz\n`]])
    assert.ok(out.every((l) => l.length <= LINE_MAX), `${n}`)
    assert.equal(out.join('').replace(/ /g, ''), `${'y'.repeat(n)}z`)
  }
})

test('at the prompt: a file whose long line ends in a tab is shown, cut at LINE_MAX, and the shell answers after it', () => {
  const k = boot(FILE_PROGRAMS)
  k.write('/tmp/wide', `${'w'.repeat(LINE_MAX)}\tend\n`)
  assert.deepEqual(k.sh('cat /tmp/wide; echo done'), ['w'.repeat(LINE_MAX), 'end', 'done'])
})

test('control characters are dropped, and so are colour, cursor and title sequences', () => {
  assert.deepEqual(shown([['out', 'a\x00\x01\x07b\x7fc\x1a\x0b\x0cd\n']]), ['abcd'])
  // The second set of control characters (128 to 159) is dropped too; the first printable character after it is kept.
  assert.deepEqual(shown([['out', 'e\u0080f\u0085g\u009b31mh\u009fi j\n']]), ['efg31mhi j'])
  assert.deepEqual(shown([['out', '\x1b[1;31mred\x1b[0m plain\x1b[2K\x1b[10;20H\n']]), ['red plain'])
  assert.deepEqual(shown([['out', '\x1b]0;a title\x07after \x1b]2;other\x1b\\end\n']]), ['after end'])
  // ESC and one more character is a whole sequence too.
  assert.deepEqual(shown([['out', 'x\x1b7y\x1b=z\n']]), ['xyz'])
  // A sequence split between writes is still dropped whole.
  assert.deepEqual(shown([['out', 'p\x1b['], ['out', '3'], ['out', '2mq\n']]), ['pq'])
})

test('an unfinished sequence never swallows a line end, and never eats the other stream\'s characters', () => {
  // A stray escape (a binary file shown by mistake) costs the rest of its line, not every line after it.
  assert.deepEqual(shown([['out', 'seen\x1b]0;never ended\nnext\n'], ['out', 'later\n']]), ['seen', 'next', 'later'])
  assert.deepEqual(shown([['out', 'one\x1b[12\ntwo\n']]), ['one', 'two'])
  assert.deepEqual(shown([['out', 'x\x1b\nthree\n']]), ['x', 'three'])
  // One stream's half-written sequence is its own: the error output loses nothing to it.
  assert.deepEqual(shown([['out', 'out\x1b['], ['err', 'error line\n'], ['out', 'mrest\n']]), ['out', '!error line', 'rest'])
})

test('a line is cut at LINE_MAX: exactly LINE_MAX is one line, a huge write without a line end comes out in pieces', () => {
  assert.deepEqual(shown([['out', `${'a'.repeat(LINE_MAX)}\n`]]), ['a'.repeat(LINE_MAX)])
  assert.deepEqual(shown([['out', `${'b'.repeat(LINE_MAX + 1)}\n`]]), ['b'.repeat(LINE_MAX), 'b'])
  const tty = new Tty()
  tty.write('out', encode('c'.repeat(LINE_MAX * 100 + 7)))
  const out = lines(tty.drain())
  assert.equal(out.length, 100)
  assert.ok(out.every((l) => l === 'c'.repeat(LINE_MAX)))
  tty.flush()
  assert.deepEqual(lines(tty.drain()), ['c'.repeat(7)])
})

test('only the newest EVENTS_MAX lines wait to be collected; the rest are counted; a post for the host is never dropped', () => {
  const tty = new Tty()
  tty.post({ first: true })
  for (let i = 0; i < EVENTS_MAX + 50; i++) tty.write(i % 2 === 0 ? 'out' : 'err', encode(`${i}\n`))
  tty.post('last')
  const out = lines(tty.drain())
  assert.equal(tty.dropped, 51)
  // The first post is still first; the oldest lines went.
  assert.equal(out[0], 'POST {"first":true}')
  assert.equal(out[1], '!51')
  assert.equal(out[out.length - 2], `!${EVENTS_MAX + 49}`)
  assert.equal(out[out.length - 1], 'POST "last"')
  assert.equal(out.length, EVENTS_MAX + 1)
  assert.equal(tty.pending, false)
  assert.deepEqual(tty.drain(), [])
})

test('a flood of lines nobody collects costs the same for each line: dropping the oldest never moves the whole list', () => {
  // The list of waiting lines is watched: every read or write of one of its places is counted, so the work is
  // measured without a clock. Dropping the oldest line by moving every line after it costs EVENTS_MAX for each.
  const flood = EVENTS_MAX * 5
  const limit = flood * 20
  let touched = 0
  // Past the limit the write is stopped at once, so a cost that grows with the list fails here instead of hanging.
  const count = (k: string | symbol): void => {
    if (typeof k === 'string' && /^\d+$/.test(k) && ++touched > limit) throw new Error(`more than ${limit} places touched for ${flood} lines`)
  }
  const watch = (list: unknown[]): unknown[] =>
    new Proxy(list, {
      get(o, k, r) { count(k); return Reflect.get(o, k, r) },
      set(o, k, v, r) { count(k); return Reflect.set(o, k, v, r) },
      has(o, k) { count(k); return Reflect.has(o, k) },
      deleteProperty(o, k) { count(k); return Reflect.deleteProperty(o, k) },
    })
  const tty = new Tty()
  const watched = new Proxy(tty, {
    get(o, k) {
      const v: unknown = Reflect.get(o, k)
      return k === 'events' && Array.isArray(v) ? watch(v) : v
    },
  })
  // A post first: something the host must get keeps its place ahead of every line.
  watched.post('first')
  for (let i = 0; i < 4; i++) watched.write('out', encode(Array.from({ length: flood / 4 }, (_, j) => `${i * (flood / 4) + j}\n`).join('')))
  assert.ok(touched > flood, 'the watch saw the list')
  assert.equal(tty.dropped, flood - EVENTS_MAX + 1)
  assert.equal(tty.pending, true)
  const out = lines(tty.drain())
  assert.equal(out.length, EVENTS_MAX)
  assert.deepEqual([out[0], out[1], out[out.length - 1]], ['POST "first"', String(flood - EVENTS_MAX + 1), String(flood - 1)])
  assert.equal(tty.pending, false)
})

test('drain leaves the line being assembled; flush ends it; a flush with nothing open adds nothing; a post ends the line before it', () => {
  const tty = new Tty()
  tty.write('out', encode('partial'))
  assert.deepEqual(tty.drain(), [])
  assert.equal(tty.pending, false)
  tty.flush()
  assert.equal(tty.pending, true)
  tty.flush()
  assert.deepEqual(lines(tty.drain()), ['partial'])
  tty.write('err', encode('before'))
  tty.post([1, 2])
  tty.write('out', encode('after\n'))
  assert.deepEqual(lines(tty.drain()), ['!before', 'POST [1,2]', 'after'])
  // A line of nothing but a sequence or a control character is still a line when its line feed comes.
  tty.write('out', encode('\x1b[0m\x07\n'))
  assert.deepEqual(lines(tty.drain()), [''])
})

// Coming in.

test('typed text becomes lines, each ending in a line feed; one that ends in a line feed is not given a second', () => {
  const tty = new Tty()
  const all = (): string[] => {
    const out: string[] = []
    for (let piece = tty.take(1000); piece !== null; piece = tty.take(1000)) out.push(decode(piece))
    return out
  }
  assert.equal(tty.typed, false)
  assert.equal(tty.take(10), null)
  assert.equal(tty.feed('one'), true)
  assert.equal(tty.feed('two\nthree\n'), true)
  assert.equal(tty.feed(''), true)
  assert.equal(tty.feed('\n\n'), true)
  assert.equal(tty.typed, true)
  assert.deepEqual(all(), ['one\n', 'two\n', 'three\n', '\n', '\n', '\n'])
  assert.equal(tty.typed, false)
  // Odd bytes pass through as typed.
  tty.feed('tab\there é\u0000')
  assert.deepEqual(all(), ['tab\there é\u0000\n'])
})

test('take hands a line out in pieces; an end of input is no bytes, handed out once, after what was typed before it', () => {
  const tty = new Tty()
  tty.feed('abcdefg')
  tty.end()
  tty.feed('next')
  const got: (string | null)[] = []
  for (let i = 0; i < 6; i++) {
    const piece = tty.take(3)
    got.push(piece === null ? null : decode(piece))
  }
  assert.deepEqual(got, ['abc', 'def', 'g\n', '', 'nex', 't\n'])
  assert.equal(tty.take(3), null)
})

test('typed lines are capped at INPUT_MAX: a flood is refused whole, an end of input needs a place too, and a read frees one', () => {
  const tty = new Tty()
  const flood = Array.from({ length: INPUT_MAX + 1 }, (_, i) => `line ${i}`).join('\n')
  assert.equal(tty.feed(flood), false)
  assert.equal(tty.typed, false)
  for (let i = 0; i < INPUT_MAX; i++) assert.equal(tty.feed(`line ${i}`), true)
  assert.equal(tty.feed('one too many'), false)
  assert.equal(tty.feed('a\nb'), false)
  // Ctrl+D finds no place left either.
  tty.end()
  assert.equal(decode(tty.take(100) ?? new Uint8Array(0)), 'line 0\n')
  assert.equal(tty.feed('fits now'), true)
  assert.equal(tty.feed('not this'), false)
  let count = 0
  let last = ''
  for (let piece = tty.take(100); piece !== null; piece = tty.take(100)) {
    count++
    last = decode(piece)
  }
  assert.equal(count, INPUT_MAX)
  assert.equal(last, 'fits now\n')
})

test('forget drops everything typed ahead, the end of input with it; the queue takes lines again at once', () => {
  const tty = new Tty()
  tty.feed('one\ntwo')
  tty.end()
  tty.forget()
  assert.equal(tty.typed, false)
  assert.equal(tty.take(10), null)
  tty.feed('three')
  assert.equal(decode(tty.take(10) ?? new Uint8Array(0)), 'three\n')
})
