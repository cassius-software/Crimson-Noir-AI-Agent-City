// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the programs that work on text and bytes as they flow by: the first and last
 * lines of a file (head, tail), counting (wc), ordering and comparing lines (sort, uniq), taking parts of lines
 * (cut), changing characters (tr), copying to several places (tee), turning the order of lines or of characters
 * round (tac, rev), numbering, wrapping and joining lines (nl, fold, paste), making text (seq, yes, echo, printf),
 * showing and coding bytes (base64, hexdump, sha256sum) and building commands from what is read (xargs). Each is a
 * generator over the kernel's calls and nothing else. Each reports a refusal as `name: what: why` and carries on
 * with its next operand, lets a closed pipe end it quietly, says so and ends when its own output is refused (a full
 * disk), reads and writes in pieces, and caps what it keeps in memory. Each has its manual page beside it.
 * What breaks if it is removed? A pipeline has nothing to put between a file and the screen: no counting, no
 * ordering, no cutting, and no way to build one command's arguments from another's output.
 */
import { concat, decode, encode, fromBase64, hex, toBase64 } from './bytes.ts'
import { OsError, refuse } from './errno.ts'
import type { Program, Sys } from './kernel.ts'
import { READ_ALL_MAX } from './kernel.ts'
import { Lines, Out, complain, count, inputs, options, usage } from './lib.ts'
import type { Parsed } from './lib.ts'
import { Sha256 } from './sha.ts'
import type { Task } from './task.ts'
import { O_APPEND, O_CREATE, O_READ, O_TRUNC, O_WRITE } from './vfs.ts'

/** Bytes read or written at a time. */
const PIECE = 65536
/** The most a program here keeps in memory at once: what the kernel's own whole-file read allows. */
const HOLD_MAX = READ_ALL_MAX
/** What a line kept in memory is charged beyond its bytes: its place in a list and the header of its text. */
const LINE_COST = 32
/** A loop that asks nothing of the kernel gives the other tasks a turn once in 1024 of its own: when its count has none of these bits. */
const PACE = 1023
/** The widest field a format or an option may ask for: a larger one is refused instead of filled. */
const WIDTH_MAX = 4096
/** A line end, as bytes (shared, never written). */
const NEWLINE: Uint8Array = Uint8Array.of(10)

// What every program here shares.

/** A write to the ordinary output that was refused for a reason other than a closed pipe (a full disk, say). */
class Spill {
  readonly why: OsError

  constructor(why: OsError) {
    this.why = why
  }
}

/**
 * What a failed write to the ordinary output goes on up as: a closed pipe as it is (the kernel then ends the program
 * quietly), any other refusal as a Spill, so that nobody takes it for a refusal of the file being read.
 */
const spilt = (e: unknown): unknown => (e instanceof OsError && e.errno !== 'EPIPE' ? new Spill(e) : e)

/**
 * The ordinary output of one program: text through lib's buffered writer, bytes through a buffer of its own, the two
 * kept in the order they were given. Only one of the two buffers ever holds anything. On the terminal nothing waits
 * in a buffer past the end of a line, so a program that answers what is typed answers at once.
 */
class Pen {
  private readonly sys: Sys
  private readonly text: Out
  private held: Uint8Array[] = []
  private size = 0

  /** Whether the output is the terminal: somebody is reading, so each line goes out as soon as it is whole. */
  private readonly live: boolean

  constructor(sys: Sys) {
    this.sys = sys
    this.text = new Out(sys)
    this.live = sys.isatty(1)
  }

  *put(text: string): Task<void> {
    if (this.size > 0) yield* this.send()
    try {
      yield* this.text.put(text)
    } catch (e) {
      throw spilt(e)
    }
    if (this.live && text.includes('\n')) yield* this.settle()
  }

  *line(text: string): Task<void> {
    yield* this.put(`${text}\n`)
  }

  /** Bytes exactly as they are. The array is kept until it is written: the caller must not change it afterwards. */
  *raw(data: Uint8Array): Task<void> {
    if (data.length === 0) return
    if (this.size === 0) yield* this.settle()
    this.held.push(data)
    this.size += data.length
    if (this.live || this.size >= PIECE) yield* this.send()
  }

  private *settle(): Task<void> {
    try {
      yield* this.text.flush()
    } catch (e) {
      throw spilt(e)
    }
  }

  private *send(): Task<void> {
    const data = this.held.length === 1 ? this.held[0] : concat(this.held)
    this.held = []
    this.size = 0
    try {
      yield* this.sys.write(1, data)
    } catch (e) {
      throw spilt(e)
    }
  }

  /** Writes whatever is still buffered. */
  *flush(): Task<void> {
    if (this.size > 0) yield* this.send()
    else yield* this.settle()
  }
}

/** The body of a program here: the kernel's calls, the arguments, and the ordinary output. */
type Body = (sys: Sys, argv: readonly string[], pen: Pen) => Task<number>

/**
 * A program as /bin holds it: the body, its output written out when it ends, and a refused write to that output
 * reported once, as `name: write error: why`, with status 1.
 */
function tool(name: string, body: Body): Program {
  return function* (sys, argv) {
    const pen = new Pen(sys)
    try {
      const status = yield* body(sys, argv, pen)
      yield* pen.flush()
      return status
    } catch (e) {
      if (!(e instanceof Spill)) throw e
      yield* complain(sys, name, 'write error', e.why)
      return 1
    }
  }
}

/** A wrong call: says what was wrong (when there are words for it), then how to call the program. Status 2. */
function* misuse(sys: Sys, name: string, bad: string | null, text: string): Task<number> {
  if (bad !== null) yield* complain(sys, name, null, bad)
  return yield* usage(sys, text)
}

/**
 * Runs `body` over each named file, or over the ordinary input when none is named (`path` is then null) or the name
 * is `-`. What was written so far is sent on before each file is opened and before a failed read is reported, so a
 * complaint lands where it belongs among the output. The status: 0, or 1 when any file could not be read.
 */
function* feed(sys: Sys, name: string, paths: readonly string[], pen: Pen, body: (fd: number, path: string | null) => Task<void>): Task<number> {
  let status = 0
  const list: readonly (string | null)[] = paths.length === 0 ? [null] : paths
  for (const path of list) {
    yield* pen.flush()
    const st = yield* inputs(sys, name, path === null ? [] : [path], function* (fd) {
      try {
        yield* body(fd, path)
      } catch (e) {
        if (e instanceof OsError && e.errno !== 'EPIPE') yield* pen.flush()
        throw e
      }
    })
    if (st !== 0) status = 1
  }
  return status
}

/**
 * The whole number an option was given, at least `least` and at most `most`; `fallback` when the option is absent;
 * null, after saying so, when it is no such number.
 */
function* amount(sys: Sys, name: string, o: Parsed, letter: string, fallback: number, least = 0, most = Number.MAX_SAFE_INTEGER): Task<number | null> {
  const text = o.values.get(letter)
  if (text === undefined) return fallback
  const n = count(text, least)
  if (n !== null && n <= most) return n
  const range = most < Number.MAX_SAFE_INTEGER ? ` from ${least} to ${most}` : least > 0 ? ` of ${least} or more` : ''
  yield* complain(sys, name, null, `option '-${letter}' needs a whole number${range}, not '${clipped(text)}'`)
  return null
}

/** A text short enough to quote in a complaint. */
function clipped(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}...` : text
}

/** Whether a text is exactly one character (one code point). */
function single(text: string): boolean {
  const c = text.codePointAt(0)
  return c !== undefined && text.length === (c > 0xffff ? 2 : 1)
}

/** How many characters a run of UTF-8 bytes holds: every byte that does not continue the one before. */
function charsIn(bytes: Uint8Array): number {
  let n = 0
  for (let i = 0; i < bytes.length; i++) if ((bytes[i] & 0xc0) !== 0x80) n++
  return n
}

/** `-5` as the short way to write `-n 5`: the arguments with a first one of that form written out. */
function shorthand(argv: readonly string[]): readonly string[] {
  const first = argv[1]
  if (first === undefined || !/^-[0-9]+$/.test(first)) return argv
  return [argv[0], '-n', first.slice(1), ...argv.slice(2)]
}

/** The heading `head` and `tail` put before each file when several are named, with an empty line before all but the first. */
class Titles {
  private readonly pen: Pen
  private readonly wanted: boolean
  private started = false

  constructor(pen: Pen, wanted: boolean) {
    this.pen = pen
    this.wanted = wanted
  }

  *before(path: string | null): Task<void> {
    if (!this.wanted) return
    yield* this.pen.put(`${this.started ? '\n' : ''}==> ${path === null || path === '-' ? 'standard input' : path} <==\n`)
    this.started = true
  }
}

// head

const HEAD_USAGE = 'head [-n lines] [-c bytes] [file ...]'

const head = tool('head', function* (sys, argv, pen) {
  const o = options(shorthand(argv), '', 'nc')
  if (o.bad !== null) return yield* misuse(sys, 'head', o.bad, HEAD_USAGE)
  const bytes = o.values.has('c')
  const n = yield* amount(sys, 'head', o, bytes ? 'c' : 'n', 10)
  if (n === null) return yield* usage(sys, HEAD_USAGE)
  const titles = new Titles(pen, o.rest.length > 1)
  return yield* feed(sys, 'head', o.rest, pen, function* (fd, path) {
    yield* titles.before(path)
    let left = n
    while (left > 0) {
      const chunk = yield* sys.read(fd, bytes ? Math.min(left, PIECE) : PIECE)
      if (chunk.length === 0) return
      if (bytes) {
        left -= chunk.length
        yield* pen.raw(chunk)
        continue
      }
      // Up to the line end that completes the count, and no further.
      let from = 0
      while (left > 0) {
        const end = chunk.indexOf(10, from)
        if (end < 0) { from = chunk.length; break }
        left--
        from = end + 1
      }
      yield* pen.raw(from === chunk.length ? chunk : chunk.subarray(0, from))
      if (from < chunk.length) yield* putBack(sys, fd, chunk.length - from)
    }
  })
})

/**
 * Moves a descriptor back over `n` bytes it read but did not use, so that whoever reads the same open file next (the
 * next command of `{ head -n 1; sort; } < file`) starts just after the last line used. A pipe or the terminal cannot
 * go back: what was read from it is gone, as it is for every program.
 */
function* putBack(sys: Sys, fd: number, n: number): Task<void> {
  try {
    yield* sys.seek(fd, -n, 1)
  } catch (e) {
    if (!(e instanceof OsError)) throw e
  }
}

// tail

const TAIL_USAGE = 'tail [-n lines] [-c bytes] [file ...]'

/** Copies a descriptor from its `n`th line on (lines count from 1). */
function* fromLine(sys: Sys, fd: number, pen: Pen, n: number): Task<void> {
  let skip = Math.max(0, n - 1)
  for (;;) {
    const chunk = yield* sys.read(fd, PIECE)
    if (chunk.length === 0) return
    let from = 0
    while (skip > 0) {
      const end = chunk.indexOf(10, from)
      if (end < 0) { from = chunk.length; break }
      skip--
      from = end + 1
    }
    if (from < chunk.length) yield* pen.raw(from === 0 ? chunk : chunk.subarray(from))
  }
}

/** Copies a descriptor from its `n`th byte on (bytes count from 1). */
function* fromByte(sys: Sys, fd: number, pen: Pen, n: number): Task<void> {
  let skip = Math.max(0, n - 1)
  for (;;) {
    const chunk = yield* sys.read(fd, PIECE)
    if (chunk.length === 0) return
    if (skip >= chunk.length) { skip -= chunk.length; continue }
    yield* pen.raw(skip === 0 ? chunk : chunk.subarray(skip))
    skip = 0
  }
}

/** Writes the last `n` bytes of a descriptor, keeping no more than those (and the piece they start in) while it reads. */
function* lastBytes(sys: Sys, fd: number, pen: Pen, n: number): Task<void> {
  if (n === 0) return
  const kept: Uint8Array[] = []
  let total = 0
  for (;;) {
    const chunk = yield* sys.read(fd, PIECE)
    if (chunk.length === 0) break
    kept.push(chunk)
    total += chunk.length
    while (kept.length > 1 && total - kept[0].length >= n) {
      total -= kept[0].length
      kept.shift()
    }
    if (total > HOLD_MAX) refuse('EFBIG', 'too much to hold in memory')
  }
  let skip = Math.max(0, total - n)
  for (const chunk of kept) {
    if (skip >= chunk.length) { skip -= chunk.length; continue }
    yield* pen.raw(skip === 0 ? chunk : chunk.subarray(skip))
    skip = 0
  }
}

/**
 * Writes the last `n` lines of a descriptor. It keeps the pieces it read only while they may still hold one of those
 * lines: the oldest piece goes as soon as the ones after it hold more than `n` line ends.
 */
function* lastLines(sys: Sys, fd: number, pen: Pen, n: number): Task<void> {
  if (n === 0) return
  const kept: Uint8Array[] = []
  /** The line ends in each kept piece. */
  const ends: number[] = []
  let lines = 0
  let total = 0
  for (;;) {
    const chunk = yield* sys.read(fd, PIECE)
    if (chunk.length === 0) break
    let k = 0
    for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) k++
    kept.push(chunk)
    ends.push(k)
    lines += k
    total += chunk.length
    while (kept.length > 1 && lines - ends[0] > n) {
      lines -= ends[0]
      total -= kept[0].length
      kept.shift()
      ends.shift()
    }
    if (total > HOLD_MAX) refuse('EFBIG', 'too much to hold in memory')
  }
  if (kept.length === 0) return
  // The lines wanted start after the `n`th line end from the end, not counting one that closes the last line.
  const last = kept[kept.length - 1]
  let need = n + (last[last.length - 1] === 10 ? 1 : 0)
  let piece = 0
  let from = 0
  for (let c = kept.length - 1; c >= 0 && need > 0; c--) {
    const chunk = kept[c]
    for (let i = chunk.length - 1; i >= 0; i--) {
      if (chunk[i] !== 10 || --need > 0) continue
      piece = c
      from = i + 1
      break
    }
  }
  for (let c = piece; c < kept.length; c++) {
    const chunk = kept[c]
    const start = c === piece ? from : 0
    if (start < chunk.length) yield* pen.raw(start === 0 ? chunk : chunk.subarray(start))
  }
}

const tail = tool('tail', function* (sys, argv, pen) {
  const o = options(shorthand(argv), '', 'nc')
  if (o.bad !== null) return yield* misuse(sys, 'tail', o.bad, TAIL_USAGE)
  const bytes = o.values.has('c')
  const letter = bytes ? 'c' : 'n'
  const text = o.values.get(letter) ?? '10'
  const onward = text.startsWith('+')
  const n = count(onward || text.startsWith('-') ? text.slice(1) : text)
  if (n === null) {
    const bad = `option '-${letter}' needs a whole number, with a + before it to count from the start, not '${clipped(text)}'`
    return yield* misuse(sys, 'tail', bad, TAIL_USAGE)
  }
  const titles = new Titles(pen, o.rest.length > 1)
  return yield* feed(sys, 'tail', o.rest, pen, function* (fd, path) {
    yield* titles.before(path)
    if (onward) yield* (bytes ? fromByte(sys, fd, pen, n) : fromLine(sys, fd, pen, n))
    else yield* (bytes ? lastBytes(sys, fd, pen, n) : lastLines(sys, fd, pen, n))
  })
})

// wc

const WC_USAGE = 'wc [-lwmc] [file ...]'

/** What `wc` counted in one input. */
interface Tally { lines: number; words: number; chars: number; bytes: number }

const wc = tool('wc', function* (sys, argv, pen) {
  const o = options(argv, 'lwmc')
  if (o.bad !== null) return yield* misuse(sys, 'wc', o.bad, WC_USAGE)
  const all = o.flags.size === 0
  const show = { lines: all || o.flags.has('l'), words: all || o.flags.has('w'), chars: o.flags.has('m'), bytes: all || o.flags.has('c') }
  const looks = show.lines || show.words || show.chars
  const rows: { readonly tally: Tally; readonly label: string | null }[] = []
  const sum: Tally = { lines: 0, words: 0, chars: 0, bytes: 0 }
  const status = yield* feed(sys, 'wc', o.rest, pen, function* (fd, path) {
    const t: Tally = { lines: 0, words: 0, chars: 0, bytes: 0 }
    let inWord = false
    for (;;) {
      const chunk = yield* sys.read(fd, PIECE)
      if (chunk.length === 0) break
      t.bytes += chunk.length
      if (!looks) continue
      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i]
        if (b === 10) t.lines++
        if (b === 32 || (b >= 9 && b <= 13)) inWord = false
        else if (!inWord) { inWord = true; t.words++ }
        if ((b & 0xc0) !== 0x80) t.chars++
      }
    }
    rows.push({ tally: t, label: path })
    sum.lines += t.lines
    sum.words += t.words
    sum.chars += t.chars
    sum.bytes += t.bytes
  })
  if (o.rest.length > 1) rows.push({ tally: sum, label: 'total' })
  const columns = (t: Tally): number[] => {
    const out: number[] = []
    if (show.lines) out.push(t.lines)
    if (show.words) out.push(t.words)
    if (show.chars) out.push(t.chars)
    if (show.bytes) out.push(t.bytes)
    return out
  }
  let width = 1
  for (const row of rows) for (const v of columns(row.tally)) width = Math.max(width, String(v).length)
  for (const row of rows) {
    const numbers = columns(row.tally).map((v) => String(v).padStart(width)).join(' ')
    yield* pen.line(row.label === null ? numbers : `${numbers} ${row.label}`)
  }
  return status
})

// sort

const SORT_USAGE = 'sort [-rnufb] [-k field] [-t separator] [file ...]'

/** Whether a character is a blank: a space or a tab. */
const blank = (ch: string): boolean => ch === ' ' || ch === '\t'

/**
 * Reads the rest of a descriptor into `lines`, a line of text each (a last line without a line end counts). `held`
 * is what is kept so far across every file, charged in bytes and in lines; past HOLD_MAX the read is refused.
 */
function* gather(sys: Sys, fd: number, lines: string[], held: { cost: number }): Task<void> {
  const decoder = new TextDecoder('utf-8')
  let pending: string[] = []
  for (;;) {
    const chunk = yield* sys.read(fd, PIECE)
    const text = chunk.length === 0 ? decoder.decode() : decoder.decode(chunk, { stream: true })
    held.cost += chunk.length
    let from = 0
    for (;;) {
      const end = text.indexOf('\n', from)
      if (end < 0) break
      if (pending.length > 0) {
        pending.push(text.slice(from, end))
        lines.push(pending.join(''))
        pending = []
      } else lines.push(text.slice(from, end))
      held.cost += LINE_COST
      from = end + 1
    }
    if (from < text.length) pending.push(text.slice(from))
    if (held.cost > HOLD_MAX) refuse('EFBIG', 'too much to hold in memory')
    if (chunk.length === 0) break
  }
  if (pending.length > 0) lines.push(pending.join(''))
}

/**
 * The part of a line from field `field` on. With a separator, fields are what stands between two of them; without
 * one, a field is a run of characters that are not blanks together with the blanks before it.
 */
function fromField(line: string, field: number, sep: string | null): string {
  let at = 0
  for (let f = 1; f < field; f++) {
    if (sep !== null) {
      const next = line.indexOf(sep, at)
      if (next < 0) return ''
      at = next + sep.length
      continue
    }
    while (at < line.length && blank(line[at])) at++
    while (at < line.length && !blank(line[at])) at++
    if (at >= line.length) return ''
  }
  return line.slice(at)
}

/** The number at the start of a text (blanks, a minus sign, digits, a point, digits), or 0 when there is none. */
function leadingNumber(text: string): number {
  let i = 0
  while (i < text.length && blank(text[i])) i++
  const from = i
  if (text[i] === '-') i++
  let digits = 0
  while (i < text.length && text[i] >= '0' && text[i] <= '9') { i++; digits++ }
  if (text[i] === '.') {
    i++
    while (i < text.length && text[i] >= '0' && text[i] <= '9') { i++; digits++ }
  }
  return digits === 0 ? 0 : Number(text.slice(from, i))
}

/**
 * The numbers 0 to n-1 in the order `before` puts them: a merge sort, so two that compare equal stay as they were,
 * and one that lets the other tasks run as it goes, which the platform's own sort would not.
 */
function* ordered(sys: Sys, n: number, before: (a: number, b: number) => number): Task<Int32Array> {
  let from = new Int32Array(n)
  let to = new Int32Array(n)
  for (let i = 0; i < n; i++) from[i] = i
  let turns = 0
  for (let width = 1; width < n; width *= 2) {
    for (let lo = 0; lo < n; lo += 2 * width) {
      const mid = Math.min(lo + width, n)
      const hi = Math.min(lo + 2 * width, n)
      let a = lo
      let b = mid
      let k = lo
      while (a < mid && b < hi) {
        if (before(from[b], from[a]) < 0) to[k++] = from[b++]
        else to[k++] = from[a++]
        if ((++turns & PACE) === 0) yield* sys.step()
      }
      while (a < mid) to[k++] = from[a++]
      while (b < hi) to[k++] = from[b++]
    }
    const spare = from
    from = to
    to = spare
    yield* sys.step()
  }
  return from
}

const sort = tool('sort', function* (sys, argv, pen) {
  const o = options(argv, 'rnufb', 'kt')
  if (o.bad !== null) return yield* misuse(sys, 'sort', o.bad, SORT_USAGE)
  const field = yield* amount(sys, 'sort', o, 'k', 1, 1)
  if (field === null) return yield* usage(sys, SORT_USAGE)
  const sep = o.values.get('t') ?? null
  if (sep !== null && !single(sep)) return yield* misuse(sys, 'sort', `option '-t' needs one character, not '${clipped(sep)}'`, SORT_USAGE)
  const lines: string[] = []
  const held = { cost: 0 }
  // A partly ordered answer would mislead: when any input cannot be read, nothing is printed.
  if ((yield* feed(sys, 'sort', o.rest, pen, (fd) => gather(sys, fd, lines, held))) !== 0) return 1
  const n = lines.length
  const numeric = o.flags.has('n')
  const folds = o.flags.has('f')
  const trims = o.flags.has('b')
  const plain = field === 1 && !folds && !trims
  const keys: string[] = numeric || !plain ? [] : lines
  const values = new Float64Array(numeric ? n : 0)
  if (numeric || !plain) {
    for (let i = 0; i < n; i++) {
      let key = field > 1 ? fromField(lines[i], field, sep) : lines[i]
      if (numeric) values[i] = leadingNumber(key)
      else {
        if (trims) {
          let at = 0
          while (at < key.length && blank(key[at])) at++
          key = key.slice(at)
        }
        keys.push(folds ? key.toUpperCase() : key)
      }
      if ((i & PACE) === PACE) yield* sys.step()
    }
  }
  const sign = o.flags.has('r') ? -1 : 1
  const before = numeric
    ? (a: number, b: number): number => (values[a] < values[b] ? -sign : values[a] > values[b] ? sign : 0)
    : (a: number, b: number): number => (keys[a] < keys[b] ? -sign : keys[a] > keys[b] ? sign : 0)
  const order = yield* ordered(sys, n, before)
  const once = o.flags.has('u')
  let shown = -1
  for (let i = 0; i < n; i++) {
    const at = order[i]
    if (once && shown >= 0 && before(shown, at) === 0) continue
    shown = at
    yield* pen.line(lines[at])
  }
  return 0
})

// uniq

const UNIQ_USAGE = 'uniq [-cdui] [file]'

const uniq = tool('uniq', function* (sys, argv, pen) {
  const o = options(argv, 'cdui')
  if (o.bad !== null) return yield* misuse(sys, 'uniq', o.bad, UNIQ_USAGE)
  if (o.rest.length > 1) return yield* misuse(sys, 'uniq', 'only one file can be named', UNIQ_USAGE)
  const counts = o.flags.has('c')
  const repeated = o.flags.has('d')
  const alone = o.flags.has('u')
  const folds = o.flags.has('i')
  return yield* feed(sys, 'uniq', o.rest, pen, function* (fd) {
    const lines = new Lines(sys, fd)
    let held: string | null = null
    let heldKey = ''
    let times = 0
    for (;;) {
      const line = yield* lines.next()
      const key = line === null ? '' : folds ? line.toUpperCase() : line
      if (line !== null && held !== null && key === heldKey) { times++; continue }
      if (held !== null) {
        const wanted = repeated && alone ? false : repeated ? times > 1 : alone ? times === 1 : true
        if (wanted) yield* pen.line(counts ? `${times} ${held}` : held)
      }
      if (line === null) break
      held = line
      heldKey = key
      times = 1
    }
  })
})

// cut

const CUT_USAGE = 'cut -b list | -c list | -f list [-d char] [-s] [file ...]'

/** A run of positions, counted from 1, both ends included. */
interface Span { readonly lo: number; readonly hi: number }

/** The positions a list such as `1,3-5,7-` names, lowest first, runs that touch joined into one; null when it is no such list. */
function spansOf(list: string): Span[] | null {
  const spans: Span[] = []
  for (const part of list.split(',')) {
    const dash = part.indexOf('-')
    let lo: number | null
    let hi: number | null
    if (dash < 0) {
      lo = count(part, 1)
      hi = lo
    } else {
      const a = part.slice(0, dash)
      const b = part.slice(dash + 1)
      if (a === '' && b === '') return null
      lo = a === '' ? 1 : count(a, 1)
      hi = b === '' ? Number.POSITIVE_INFINITY : count(b, 1)
    }
    if (lo === null || hi === null || hi < lo) return null
    spans.push({ lo, hi })
  }
  spans.sort((x, y) => x.lo - y.lo)
  const joined: Span[] = []
  for (const s of spans) {
    const last = joined[joined.length - 1]
    if (joined.length > 0 && s.lo <= last.hi + 1) joined[joined.length - 1] = { lo: last.lo, hi: Math.max(last.hi, s.hi) }
    else joined.push(s)
  }
  return joined
}

/** Walks the positions of a line upwards and says of each whether the list names it. `restart` begins a new line. */
class Picker {
  private readonly spans: readonly Span[]
  private at = 0

  constructor(spans: readonly Span[]) {
    this.spans = spans
  }

  restart(): void {
    this.at = 0
  }

  /** Whether position `n` is named; positions must be asked in rising order within a line. */
  takes(n: number): boolean {
    const spans = this.spans
    while (this.at < spans.length && spans[this.at].hi < n) this.at++
    return this.at < spans.length && spans[this.at].lo <= n
  }

  /** Whether any position from `n` on is still named. */
  more(n: number): boolean {
    return this.spans.length > 0 && this.spans[this.spans.length - 1].hi >= n
  }
}

const cut = tool('cut', function* (sys, argv, pen) {
  const o = options(argv, 's', 'bcfd')
  if (o.bad !== null) return yield* misuse(sys, 'cut', o.bad, CUT_USAGE)
  const modes = ['b', 'c', 'f'].filter((m) => o.values.has(m))
  if (modes.length === 0) return yield* misuse(sys, 'cut', 'one of -b, -c and -f is needed', CUT_USAGE)
  if (modes.length > 1) return yield* misuse(sys, 'cut', 'only one of -b, -c and -f can be given', CUT_USAGE)
  const mode = modes[0]
  const list = o.values.get(mode) ?? ''
  const spans = spansOf(list)
  if (spans === null) return yield* misuse(sys, 'cut', `'${clipped(list)}' is not a list of positions such as 1,3-5,7-`, CUT_USAGE)
  const delim = o.values.get('d') ?? '\t'
  if (mode !== 'f' && (o.values.has('d') || o.flags.has('s'))) return yield* misuse(sys, 'cut', '-d and -s go with -f only', CUT_USAGE)
  if (!single(delim)) return yield* misuse(sys, 'cut', `option '-d' needs one character, not '${clipped(delim)}'`, CUT_USAGE)
  const strict = o.flags.has('s')
  const picker = new Picker(spans)
  return yield* feed(sys, 'cut', o.rest, pen, function* (fd) {
    if (mode === 'f') {
      const lines = new Lines(sys, fd)
      for (;;) {
        const line = yield* lines.next()
        if (line === null) return
        if (!line.includes(delim)) {
          if (!strict) yield* pen.line(line)
          continue
        }
        const fields = line.split(delim)
        const picked: string[] = []
        picker.restart()
        for (let i = 0; i < fields.length && picker.more(i + 1); i++) if (picker.takes(i + 1)) picked.push(fields[i])
        yield* pen.line(picked.join(delim))
      }
    }
    // Bytes and characters need no whole line: the position counts up and starts again at each line end.
    let col = 0
    picker.restart()
    if (mode === 'b') {
      for (;;) {
        const chunk = yield* sys.read(fd, PIECE)
        if (chunk.length === 0) break
        const out = new Uint8Array(chunk.length)
        let k = 0
        for (let i = 0; i < chunk.length; i++) {
          const b = chunk[i]
          if (b === 10) {
            out[k++] = 10
            col = 0
            picker.restart()
          } else if (picker.takes(++col)) out[k++] = b
        }
        yield* pen.raw(out.subarray(0, k))
      }
    } else {
      const decoder = new TextDecoder('utf-8')
      for (;;) {
        const chunk = yield* sys.read(fd, PIECE)
        const text = chunk.length === 0 ? decoder.decode() : decoder.decode(chunk, { stream: true })
        let out = ''
        for (const ch of text) {
          if (ch === '\n') {
            out += ch
            col = 0
            picker.restart()
          } else if (picker.takes(++col)) out += ch
        }
        yield* pen.put(out)
        if (chunk.length === 0) break
      }
    }
    // A last line without a line end is given one.
    if (col > 0) yield* pen.put('\n')
  })
})

// tr

const TR_USAGE = 'tr [-cds] set1 [set2]'

/** The most characters a set may list: as many as there are code points. */
const SET_MAX = 0x110000

/** What a class name stands for, as runs of code points (first and last of each): plain ASCII only. */
const CLASSES: Readonly<Record<string, readonly number[]>> = Object.freeze({
  alpha: [65, 90, 97, 122],
  digit: [48, 57],
  upper: [65, 90],
  lower: [97, 122],
  space: [9, 13, 32, 32],
  alnum: [48, 57, 65, 90, 97, 122],
  punct: [33, 47, 58, 64, 91, 96, 123, 126],
})

/** The code an escape letter stands for in a set and in a format; -1 for a letter that is none. */
function control(ch: string): number {
  switch (ch) {
    case 'a': return 7
    case 'b': return 8
    case 'e': return 27
    case 'f': return 12
    case 'n': return 10
    case 'r': return 13
    case 't': return 9
    case 'v': return 11
    case '\\': return 92
    default: return -1
  }
}

/**
 * Every character a set lists, in the order written: `a-z` is a range, `\n` and its like and `\NNN` (octal) are
 * escapes, `[:name:]` is a class. What is wrong with it, in words, when it cannot be read.
 */
function listed(text: string): Int32Array | string {
  const cps: number[] = []
  for (const ch of text) cps.push(ch.codePointAt(0) ?? 0)
  const out: number[] = []
  const add = (lo: number, hi: number): boolean => {
    if (out.length + (hi - lo + 1) > SET_MAX) return false
    for (let c = lo; c <= hi; c++) out.push(c)
    return true
  }
  let i = 0
  /** The character at `i`, an escape read as what it stands for; `i` moves past it. */
  const one = (): number => {
    const c = cps[i++]
    if (c !== 92 || i >= cps.length) return c
    const next = cps[i]
    if (next >= 48 && next <= 55) {
      let v = 0
      for (let n = 0; n < 3 && i < cps.length && cps[i] >= 48 && cps[i] <= 55; n++) v = v * 8 + (cps[i++] - 48)
      return v
    }
    i++
    const code = next === 101 ? -1 : control(String.fromCodePoint(next))
    return code >= 0 ? code : next
  }
  const tooMany = `a set lists more than ${SET_MAX} characters`
  while (i < cps.length) {
    if (cps[i] === 91 && cps[i + 1] === 58) {
      // [:name:]
      let j = i + 2
      let name = ''
      while (j < cps.length && cps[j] >= 97 && cps[j] <= 122 && name.length < 8) name += String.fromCodePoint(cps[j++])
      if (cps[j] === 58 && cps[j + 1] === 93) {
        if (!Object.hasOwn(CLASSES, name)) return `'[:${name}:]' is not a class this tr knows`
        const runs = CLASSES[name]
        for (let r = 0; r < runs.length; r += 2) if (!add(runs[r], runs[r + 1])) return tooMany
        i = j + 2
        continue
      }
    }
    const lo = one()
    if (cps[i] === 45 && i + 1 < cps.length) {
      i++
      const hi = one()
      if (hi < lo) return `the range '${String.fromCodePoint(lo)}-${String.fromCodePoint(hi)}' runs backwards`
      if (!add(lo, hi)) return tooMany
    } else if (!add(lo, lo)) return tooMany
  }
  return Int32Array.from(out)
}

/** For each code point up to the highest a set lists, its place in the set (the last, when it is there twice) or -1. */
function placesOf(set: Int32Array): Int32Array {
  let top = -1
  for (let i = 0; i < set.length; i++) if (set[i] > top) top = set[i]
  const places = new Int32Array(top + 1).fill(-1)
  for (let i = 0; i < set.length; i++) places[set[i]] = i
  return places
}

/** The text of a list of code points. */
function textOf(cps: readonly number[]): string {
  let text = ''
  for (let i = 0; i < cps.length; i += 4096) text += String.fromCodePoint(...cps.slice(i, i + 4096))
  return text
}

const tr = tool('tr', function* (sys, argv, pen) {
  const o = options(argv, 'cds')
  if (o.bad !== null) return yield* misuse(sys, 'tr', o.bad, TR_USAGE)
  const removing = o.flags.has('d')
  const squeezing = o.flags.has('s')
  const others = o.flags.has('c')
  const given = o.rest.length
  if (given === 0) return yield* usage(sys, TR_USAGE)
  let wrong: string | null = null
  if (given > 2) wrong = 'at most two sets can be given'
  else if (removing && !squeezing && given !== 1) wrong = 'removing takes one set'
  else if (removing && squeezing && given !== 2) wrong = 'removing and squeezing takes two sets'
  else if (!removing && !squeezing && given !== 2) wrong = 'changing characters takes two sets'
  if (wrong !== null) return yield* misuse(sys, 'tr', wrong, TR_USAGE)
  const first = listed(o.rest[0])
  if (typeof first === 'string') return yield* misuse(sys, 'tr', first, TR_USAGE)
  const second = given === 2 ? listed(o.rest[1]) : null
  if (typeof second === 'string') return yield* misuse(sys, 'tr', second, TR_USAGE)
  const changing = !removing && second !== null
  if (changing && second.length === 0) return yield* misuse(sys, 'tr', 'the second set is empty', TR_USAGE)
  const places = placesOf(first)
  const into = second ?? new Int32Array(0)
  const final = into.length > 0 ? into[into.length - 1] : 0
  const tight = second !== null ? placesOf(second) : null
  /** Whether set1 (or, with -c, everything outside it) holds a character. */
  const picked = (c: number): boolean => (c < places.length && places[c] >= 0) !== others
  const change = (c: number): number => {
    if (others) return picked(c) ? final : c
    const place = c < places.length ? places[c] : -1
    return place < 0 ? c : place < into.length ? into[place] : final
  }
  /** Whether a character is one that is printed once when it comes several times in a row. */
  const squeezed = (c: number): boolean => (tight !== null ? c < tight.length && tight[c] >= 0 : picked(c))
  const decoder = new TextDecoder('utf-8')
  let last = -1
  return yield* feed(sys, 'tr', [], pen, function* (fd) {
    for (;;) {
      const chunk = yield* sys.read(fd, PIECE)
      const text = chunk.length === 0 ? decoder.decode() : decoder.decode(chunk, { stream: true })
      const out: number[] = []
      for (let i = 0; i < text.length; i++) {
        let c = text.codePointAt(i) ?? 0
        if (c > 0xffff) i++
        if (removing && picked(c)) continue
        if (changing) c = change(c)
        if (squeezing && c === last && squeezed(c)) continue
        last = c
        out.push(c)
      }
      yield* pen.put(textOf(out))
      if (chunk.length === 0) return
    }
  })
})

// tee

const TEE_USAGE = 'tee [-a] [file ...]'

const tee = tool('tee', function* (sys, argv, pen) {
  const o = options(argv, 'a')
  if (o.bad !== null) return yield* misuse(sys, 'tee', o.bad, TEE_USAGE)
  const flags = O_WRITE | O_CREATE | (o.flags.has('a') ? O_APPEND : O_TRUNC)
  const files: { readonly fd: number; readonly path: string; open: boolean }[] = []
  let status = 0
  try {
    for (const path of o.rest) {
      try {
        files.push({ fd: yield* sys.open(path, flags), path, open: true })
      } catch (e) {
        if (!(e instanceof OsError)) throw e
        yield* complain(sys, 'tee', path, e)
        status = 1
      }
    }
    // A refused write stops the copy to that one place only; the others still get everything.
    let screen = true
    const read = yield* feed(sys, 'tee', [], pen, function* (fd) {
      for (;;) {
        const chunk = yield* sys.read(fd, PIECE)
        if (chunk.length === 0) return
        if (screen) {
          try {
            yield* sys.write(1, chunk)
          } catch (e) {
            if (!(e instanceof OsError) || e.errno === 'EPIPE') throw e
            yield* complain(sys, 'tee', 'write error', e)
            status = 1
            screen = false
          }
        }
        for (const file of files) {
          if (!file.open) continue
          try {
            yield* sys.write(file.fd, chunk)
          } catch (e) {
            if (!(e instanceof OsError)) throw e
            yield* complain(sys, 'tee', file.path, e)
            status = 1
            file.open = false
          }
        }
      }
    })
    return read !== 0 ? 1 : status
  } finally {
    for (const file of files) sys.close(file.fd)
  }
})

// tac

const TAC_USAGE = 'tac [file ...]'

const tac = tool('tac', function* (sys, argv, pen) {
  const o = options(argv, '')
  if (o.bad !== null) return yield* misuse(sys, 'tac', o.bad, TAC_USAGE)
  return yield* feed(sys, 'tac', o.rest, pen, function* (fd) {
    const data = yield* sys.readAll(fd)
    let end = data.length
    if (end > 0 && data[end - 1] !== 10) {
      // A last line without a line end comes first, and is given one.
      const before = data.lastIndexOf(10)
      yield* pen.raw(data.subarray(before + 1))
      yield* pen.raw(NEWLINE)
      end = before + 1
    }
    let turns = 0
    while (end > 0) {
      // The byte before `end` is a line end: its line starts after the line end before that.
      const before = end >= 2 ? data.lastIndexOf(10, end - 2) : -1
      yield* pen.raw(data.subarray(before + 1, end))
      end = before + 1
      if ((++turns & PACE) === 0) yield* sys.step()
    }
  })
})

// rev

const REV_USAGE = 'rev [file ...]'

const rev = tool('rev', function* (sys, argv, pen) {
  const o = options(argv, '')
  if (o.bad !== null) return yield* misuse(sys, 'rev', o.bad, REV_USAGE)
  return yield* feed(sys, 'rev', o.rest, pen, function* (fd) {
    const lines = new Lines(sys, fd)
    for (;;) {
      const line = yield* lines.next()
      if (line === null) return
      yield* pen.line(Array.from(line).reverse().join(''))
    }
  })
})

// nl

const NL_USAGE = 'nl [-b a|t] [-w width] [file ...]'

const nl = tool('nl', function* (sys, argv, pen) {
  const o = options(argv, '', 'bw')
  if (o.bad !== null) return yield* misuse(sys, 'nl', o.bad, NL_USAGE)
  const style = o.values.get('b') ?? 't'
  if (style !== 'a' && style !== 't') {
    return yield* misuse(sys, 'nl', `option '-b' takes a (every line) or t (lines with text), not '${clipped(style)}'`, NL_USAGE)
  }
  const width = yield* amount(sys, 'nl', o, 'w', 6, 1, WIDTH_MAX)
  if (width === null) return yield* usage(sys, NL_USAGE)
  let n = 0
  return yield* feed(sys, 'nl', o.rest, pen, function* (fd) {
    const lines = new Lines(sys, fd)
    for (;;) {
      const line = yield* lines.next()
      if (line === null) return
      if (line === '' && style === 't') yield* pen.put('\n')
      else yield* pen.line(`${String(++n).padStart(width)}\t${line}`)
    }
  })
})

// fold

const FOLD_USAGE = 'fold [-s] [-w width] [file ...]'

const fold = tool('fold', function* (sys, argv, pen) {
  const o = options(argv, 's', 'w')
  if (o.bad !== null) return yield* misuse(sys, 'fold', o.bad, FOLD_USAGE)
  const width = yield* amount(sys, 'fold', o, 'w', 80, 1)
  if (width === null) return yield* usage(sys, FOLD_USAGE)
  const words = o.flags.has('s')
  return yield* feed(sys, 'fold', o.rest, pen, function* (fd) {
    const lines = new Lines(sys, fd)
    for (;;) {
      const line = yield* lines.next()
      if (line === null) return
      // A line of no more code units than the width has no more characters than it either.
      if (line.length <= width) { yield* pen.line(line); continue }
      const chars = Array.from(line)
      let at = 0
      while (chars.length - at > width) {
        let to = at + width
        if (words) {
          for (let j = to - 1; j >= at; j--) {
            if (!blank(chars[j])) continue
            to = j + 1
            break
          }
        }
        yield* pen.line(chars.slice(at, to).join(''))
        at = to
      }
      yield* pen.line(chars.slice(at).join(''))
    }
  })
})

// paste

const PASTE_USAGE = 'paste [-s] [-d list] [file ...]'

/** What goes between two joined lines, in turn: each character of the list, `\n` `\t` `\\` read, `\0` standing for nothing at all. */
function delimiters(list: string): string[] {
  const out: string[] = []
  const chars = Array.from(list)
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== '\\' || i + 1 >= chars.length) { out.push(chars[i]); continue }
    const next = chars[++i]
    out.push(next === 'n' ? '\n' : next === 't' ? '\t' : next === '0' ? '' : next)
  }
  return out.length === 0 ? [''] : out
}

const paste = tool('paste', function* (sys, argv, pen) {
  const o = options(argv, 's', 'd')
  if (o.bad !== null) return yield* misuse(sys, 'paste', o.bad, PASTE_USAGE)
  const between = delimiters(o.values.get('d') ?? '\t')
  if (o.flags.has('s')) {
    return yield* feed(sys, 'paste', o.rest, pen, function* (fd) {
      const lines = new Lines(sys, fd)
      for (let i = 0; ; i++) {
        const line = yield* lines.next()
        if (line === null) break
        yield* pen.put(i === 0 ? line : between[(i - 1) % between.length] + line)
      }
      yield* pen.put('\n')
    })
  }
  const opened: number[] = []
  const readers: Lines[] = []
  let input: Lines | null = null
  let status = 0
  try {
    for (const path of o.rest.length === 0 ? ['-'] : o.rest) {
      if (path === '-') {
        // Named twice, the input is still read once: its lines go to each place in turn.
        input ??= new Lines(sys, 0)
        readers.push(input)
        continue
      }
      try {
        const fd = yield* sys.open(path, O_READ)
        opened.push(fd)
        readers.push(new Lines(sys, fd))
      } catch (e) {
        if (!(e instanceof OsError)) throw e
        yield* complain(sys, 'paste', path, e)
        status = 1
      }
    }
    if (status !== 0) return 1
    const ended: boolean[] = readers.map(() => false)
    for (;;) {
      let any = false
      let row = ''
      for (let i = 0; i < readers.length; i++) {
        if (i > 0) row += between[(i - 1) % between.length]
        if (ended[i]) continue
        const line = yield* readers[i].next()
        if (line === null) ended[i] = true
        else {
          row += line
          any = true
        }
      }
      if (!any) return 0
      yield* pen.line(row)
    }
  } catch (e) {
    // A write that failed is not an OsError by now, so this is a read that was refused part way.
    if (!(e instanceof OsError) || e.errno === 'EPIPE') throw e
    yield* pen.flush()
    yield* complain(sys, 'paste', null, e)
    return 1
  } finally {
    for (const fd of opened) sys.close(fd)
  }
})

// seq

const SEQ_USAGE = 'seq [-w] [-s separator] [first [step]] last'

/** A number as `seq` reads one: its sign, its digits before the point and its digits after it. */
interface Decimal { readonly negative: boolean; readonly whole: string; readonly part: string }

/** The number a text writes in plain digits (`-2.50`, `7`, `.5`); null when it is none. */
function decimalOf(text: string): Decimal | null {
  let i = 0
  let negative = false
  if (text[0] === '+' || text[0] === '-') {
    negative = text[0] === '-'
    i = 1
  }
  const from = i
  while (i < text.length && text[i] >= '0' && text[i] <= '9') i++
  const whole = text.slice(from, i)
  let part = ''
  if (text[i] === '.') {
    const dot = ++i
    while (i < text.length && text[i] >= '0' && text[i] <= '9') i++
    part = text.slice(dot, i)
  }
  if (i !== text.length || (whole === '' && part === '')) return null
  return { negative, whole, part }
}

/** A number times ten to the power `places`, as a whole number; null when that takes more than 15 digits. */
function scaled(d: Decimal, places: number): number | null {
  let digits = d.whole + d.part.padEnd(places, '0')
  let zeros = 0
  while (zeros < digits.length - 1 && digits[zeros] === '0') zeros++
  digits = digits.slice(zeros)
  if (digits.length > 15) return null
  const v = digits === '' ? 0 : Number(digits)
  return d.negative && v !== 0 ? -v : v
}

/** A whole number shown with its last `places` digits after a point. */
function pointed(v: number, places: number): string {
  let digits = String(Math.abs(v))
  if (places > 0) {
    digits = digits.padStart(places + 1, '0')
    digits = `${digits.slice(0, digits.length - places)}.${digits.slice(digits.length - places)}`
  }
  return v < 0 ? `-${digits}` : digits
}

const seq = tool('seq', function* (sys, argv, pen) {
  // Read by hand: an operand may start with a minus sign, which lib's reader would take for an option.
  let separator = '\n'
  let equal = false
  let i = 1
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { i++; break }
    if (a === '-w') { equal = true; continue }
    if (a === '-s') {
      if (i + 1 >= argv.length) return yield* misuse(sys, 'seq', "option '-s' needs a value", SEQ_USAGE)
      separator = argv[++i]
      continue
    }
    if (a.startsWith('-s')) { separator = a.slice(2); continue }
    if (a.length > 1 && a[0] === '-' && decimalOf(a) === null) return yield* misuse(sys, 'seq', `unknown option '${clipped(a)}'`, SEQ_USAGE)
    break
  }
  const operands = argv.slice(i)
  if (operands.length < 1 || operands.length > 3) return yield* usage(sys, SEQ_USAGE)
  const numbers: Decimal[] = []
  for (const text of operands) {
    const d = decimalOf(text)
    if (d === null) return yield* misuse(sys, 'seq', `'${clipped(text)}' is not a number`, SEQ_USAGE)
    numbers.push(d)
  }
  const one: Decimal = { negative: false, whole: '1', part: '' }
  const first = numbers.length > 1 ? numbers[0] : one
  const step = numbers.length > 2 ? numbers[1] : one
  const last = numbers[numbers.length - 1]
  // Every number as a whole number of the smallest decimal place any of them has, so the sums are exact.
  const shown = Math.max(first.part.length, step.part.length)
  const fine = Math.max(shown, last.part.length)
  const a = scaled(first, fine)
  const s = scaled(step, fine)
  const z = scaled(last, fine)
  if (a === null || s === null || z === null) {
    return yield* misuse(sys, 'seq', 'a number has more than 15 digits when given as many decimals as the one with the most', SEQ_USAGE)
  }
  if (s === 0) return yield* misuse(sys, 'seq', 'the step cannot be 0', SEQ_USAGE)
  const total = Math.floor((z - a) / s) + 1
  if (total < 1) return 0
  const unit = 10 ** (fine - shown)
  let width = 0
  if (equal) width = Math.max(pointed(a / unit, shown).length, pointed((a + (total - 1) * s) / unit, shown).length)
  for (let k = 0; k < total; k++) {
    const v = (a + k * s) / unit
    let text = pointed(v, shown)
    if (text.length < width) text = v < 0 ? `-${text.slice(1).padStart(width - 1, '0')}` : text.padStart(width, '0')
    yield* pen.put(k === 0 ? text : separator + text)
  }
  yield* pen.put('\n')
  return 0
})

// yes

const yes = tool('yes', function* (_sys, argv, pen) {
  const words = argv[1] === '--' ? argv.slice(2) : argv.slice(1)
  const line = `${words.length > 0 ? words.join(' ') : 'y'}\n`
  // Many lines to a write, so a reader is fed in pieces and not a line at a time.
  const block = encode(line.repeat(Math.max(1, Math.floor(4096 / line.length))))
  for (;;) yield* pen.raw(block)
})

// echo

const echo = tool('echo', function* (_sys, argv, pen) {
  // The same as the shell's own echo: the options count only before the text, and only in these four spellings.
  let i = 1
  let end = '\n'
  let escapes = false
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-n') end = ''
    else if (a === '-e') escapes = true
    else if (a === '-ne' || a === '-en') { end = ''; escapes = true }
    else break
  }
  let text = argv.slice(i).join(' ')
  if (escapes) {
    let out = ''
    let from = 0
    for (;;) {
      const at = text.indexOf('\\', from)
      if (at < 0 || at + 1 >= text.length) break
      const c = text[at + 1]
      const to = c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c === 'e' ? '\x1b' : c === '0' ? '\0' : c === '\\' ? '\\' : null
      if (to === null) {
        out += text.slice(from, at + 1)
        from = at + 1
      } else {
        out += text.slice(from, at) + to
        from = at + 2
      }
    }
    text = out + text.slice(from)
  }
  yield* pen.put(text + end)
  return 0
})

// printf

const PRINTF_USAGE = 'printf format [argument ...]'

const I64_MIN = -(2n ** 63n)
const I64_MAX = 2n ** 63n - 1n
const U64_MAX = 2n ** 64n - 1n

/** Bytes put together from text and from single bytes. */
class Bytes {
  private readonly parts: Uint8Array[] = []
  private text = ''

  put(text: string): void {
    this.text += text
  }

  byte(value: number): void {
    this.settle()
    this.parts.push(Uint8Array.of(value & 255))
  }

  private settle(): void {
    if (this.text === '') return
    this.parts.push(encode(this.text))
    this.text = ''
  }

  done(): Uint8Array {
    this.settle()
    return this.parts.length === 1 ? this.parts[0] : concat(this.parts)
  }
}

const isOctal = (ch: string): boolean => ch >= '0' && ch <= '7'
const isHex = (ch: string): boolean => (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')

/**
 * Reads the escape that starts with the backslash at `at` into `out`, and gives where to read on from. `\0NNN` and
 * `\NNN` are a byte in octal, `\xHH` one in hexadecimal; a backslash before anything else stays a backslash. With
 * `stops`, `\c` means "print nothing more" and -1 is handed back.
 */
function escapeAt(text: string, at: number, out: Bytes, stops: boolean): number {
  if (at + 1 >= text.length) {
    out.put('\\')
    return at + 1
  }
  const ch = text[at + 1]
  const code = control(ch)
  if (code >= 0) {
    out.byte(code)
    return at + 2
  }
  if (ch === 'c' && stops) return -1
  if (ch === 'x') {
    let i = at + 2
    let v = 0
    for (let n = 0; n < 2 && i < text.length && isHex(text[i]); n++) v = v * 16 + Number.parseInt(text[i++], 16)
    if (i === at + 2) {
      out.put('\\')
      return at + 1
    }
    out.byte(v)
    return i
  }
  if (isOctal(ch)) {
    let i = at + 1
    let v = 0
    for (let n = ch === '0' ? 4 : 3; n > 0 && i < text.length && isOctal(text[i]); n--) v = v * 8 + (text.charCodeAt(i++) - 48)
    out.byte(v)
    return i
  }
  out.put('\\')
  return at + 1
}

/** One `%` item of a format. */
interface Spec {
  /** The letter: s d i u x X o c b. */
  readonly conv: string
  readonly left: boolean
  readonly zero: boolean
  readonly plus: boolean
  readonly space: boolean
  readonly width: number
  /** -1 when none was given. */
  readonly precision: number
}

/** A format as the bytes to print between its items and the items themselves; what is wrong with it, in words, when it cannot be read. */
function layout(format: string): (Uint8Array | Spec)[] | string {
  const parts: (Uint8Array | Spec)[] = []
  let lit = new Bytes()
  let some = false
  /** The digits at `j` as a number no larger than it needs to be to be refused. */
  const digits = (from: number): { readonly value: number; readonly next: number } => {
    let value = 0
    let j = from
    for (; j < format.length && format[j] >= '0' && format[j] <= '9'; j++) value = Math.min(value * 10 + (format.charCodeAt(j) - 48), WIDTH_MAX + 1)
    return { value, next: j }
  }
  let i = 0
  while (i < format.length) {
    const ch = format[i]
    if (ch === '\\') {
      i = escapeAt(format, i, lit, false)
      some = true
      continue
    }
    if (ch !== '%') {
      let j = i + 1
      while (j < format.length && format[j] !== '%' && format[j] !== '\\') j++
      lit.put(format.slice(i, j))
      some = true
      i = j
      continue
    }
    if (format[i + 1] === '%') {
      lit.put('%')
      some = true
      i += 2
      continue
    }
    let j = i + 1
    let left = false
    let zero = false
    let plus = false
    let space = false
    for (; j < format.length; j++) {
      const f = format[j]
      if (f === '-') left = true
      else if (f === '0') zero = true
      else if (f === '+') plus = true
      else if (f === ' ') space = true
      else break
    }
    const w = digits(j)
    j = w.next
    let precision = -1
    if (format[j] === '.') {
      const p = digits(j + 1)
      precision = p.value
      j = p.next
    }
    if (j >= format.length) return `'${clipped(format.slice(i))}': the format stops in the middle of an item`
    const item = clipped(format.slice(i, j + 1))
    const conv = format[j]
    if (!'sdiuxXocb'.includes(conv)) return `'${item}': not an item this printf knows`
    if (w.value > WIDTH_MAX || precision > WIDTH_MAX) return `'${item}': a width or precision over ${WIDTH_MAX}`
    if (some) {
      parts.push(lit.done())
      lit = new Bytes()
      some = false
    }
    parts.push({ conv, left, zero, plus, space, width: w.value, precision })
    i = j + 1
  }
  if (some) parts.push(lit.done())
  return parts
}

/**
 * The whole number an argument writes: decimal, hexadecimal after 0x, octal after 0, or a quote and one character
 * for that character's code. Null when it is none of these.
 */
function wholeNumber(text: string): bigint | null {
  if (text[0] === "'" || text[0] === '"') {
    const rest = text.slice(1)
    return single(rest) ? BigInt(rest.codePointAt(0) ?? 0) : null
  }
  let t = text
  let negative = false
  if (t[0] === '+' || t[0] === '-') {
    negative = t[0] === '-'
    t = t.slice(1)
  }
  if (t.length === 0 || t.length > 40) return null
  let v: bigint
  if (/^0[xX][0-9a-fA-F]+$/.test(t)) v = BigInt(`0x${t.slice(2)}`)
  else if (/^0[0-7]*$/.test(t)) v = t.length === 1 ? 0n : BigInt(`0o${t.slice(1)}`)
  else if (/^[1-9][0-9]*$/.test(t)) v = BigInt(t)
  else return null
  return negative ? -v : v
}

/** A number item as text, and what was wrong with its argument (which then counted as 0), if anything. */
function numeral(spec: Spec, arg: string | undefined): { readonly text: string; readonly fault: string | null } {
  const signed = spec.conv === 'd' || spec.conv === 'i'
  let v = 0n
  let fault: string | null = null
  if (arg !== undefined) {
    const got = wholeNumber(arg)
    if (got === null) fault = `'${clipped(arg)}': not a number`
    else if (got < I64_MIN || got > (signed ? I64_MAX : U64_MAX)) fault = `'${clipped(arg)}': a number too large for 64 bits`
    else v = got
  }
  let sign = ''
  let size = v
  if (signed) {
    if (v < 0n) size = -v
    sign = v < 0n ? '-' : spec.plus ? '+' : spec.space ? ' ' : ''
  } else if (v < 0n) size = v + U64_MAX + 1n
  let digits = size.toString(spec.conv === 'o' ? 8 : spec.conv === 'x' || spec.conv === 'X' ? 16 : 10)
  if (spec.conv === 'X') digits = digits.toUpperCase()
  if (spec.precision === 0 && size === 0n) digits = ''
  if (spec.precision > digits.length) digits = digits.padStart(spec.precision, '0')
  let text = sign + digits
  if (text.length < spec.width) {
    if (spec.left) text = text.padEnd(spec.width)
    else if (spec.zero && spec.precision < 0) text = sign + digits.padStart(spec.width - sign.length, '0')
    else text = text.padStart(spec.width)
  }
  return { text, fault }
}

/** Text as an item lays it out: no more characters than `precision` (when 0 or more), blanks to fill `width`. */
function fitted(bytes: Uint8Array, spec: Spec, precision: number): Uint8Array {
  let data = bytes
  if (precision >= 0) {
    let seen = 0
    for (let i = 0; i < data.length; i++) {
      if ((data[i] & 0xc0) === 0x80 || ++seen <= precision) continue
      data = data.subarray(0, i)
      break
    }
  }
  const fill = spec.width - charsIn(data)
  if (fill <= 0) return data
  const blanks = new Uint8Array(fill).fill(32)
  return spec.left ? concat([data, blanks]) : concat([blanks, data])
}

const printf = tool('printf', function* (sys, argv, pen) {
  const at0 = argv[1] === '--' ? 2 : 1
  if (argv.length <= at0) return yield* usage(sys, PRINTF_USAGE)
  const parts = layout(argv[at0])
  if (typeof parts === 'string') {
    yield* complain(sys, 'printf', null, parts)
    return 1
  }
  const args = argv.slice(at0 + 1)
  let status = 0
  let next = 0
  for (let pass = 0; ; pass++) {
    const before = next
    for (const part of parts) {
      if (part instanceof Uint8Array) {
        yield* pen.raw(part)
        continue
      }
      const arg = next < args.length ? args[next++] : undefined
      if (part.conv === 's') yield* pen.raw(fitted(encode(arg ?? ''), part, part.precision))
      else if (part.conv === 'c') {
        const c = arg === undefined ? undefined : arg.codePointAt(0)
        yield* pen.raw(fitted(encode(c === undefined ? '' : String.fromCodePoint(c)), part, -1))
      } else if (part.conv === 'b') {
        const text = arg ?? ''
        const out = new Bytes()
        let from = 0
        let stop = false
        for (;;) {
          const at = text.indexOf('\\', from)
          if (at < 0) { out.put(text.slice(from)); break }
          out.put(text.slice(from, at))
          from = escapeAt(text, at, out, true)
          if (from < 0) { stop = true; break }
        }
        yield* pen.raw(fitted(out.done(), part, part.precision))
        if (stop) return status
      } else {
        const n = numeral(part, arg)
        if (n.fault !== null) {
          yield* pen.flush()
          yield* complain(sys, 'printf', null, n.fault)
          status = 1
        }
        yield* pen.raw(encode(n.text))
      }
    }
    // The format is used again while it takes arguments and some are left.
    if (next >= args.length || next === before) return status
    if ((pass & PACE) === PACE) yield* sys.step()
  }
})

// base64

const BASE64_USAGE = 'base64 [-d] [-w columns] [file]'

/** Whether a byte is a character of the base64 alphabet (not the padding). */
const isBase64 = (b: number): boolean => (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || (b >= 48 && b <= 57) || b === 43 || b === 47

/** Writes base64 text broken into lines of `wrap` characters (never, when 0); `col` is how far along the open line is, and comes back. */
function* wrapped(pen: Pen, text: string, wrap: number, col: number): Task<number> {
  if (wrap === 0) {
    yield* pen.put(text)
    return 0
  }
  let at = col
  let from = 0
  while (from < text.length) {
    const take = Math.min(wrap - at, text.length - from)
    yield* pen.put(text.slice(from, from + take))
    from += take
    at += take
    if (at === wrap) {
      yield* pen.put('\n')
      at = 0
    }
  }
  return at
}

function* encode64(sys: Sys, fd: number, pen: Pen, wrap: number): Task<void> {
  let carry: Uint8Array = new Uint8Array(0)
  let col = 0
  for (;;) {
    const chunk = yield* sys.read(fd, PIECE)
    if (chunk.length === 0) break
    // Three bytes make four characters: what is left over waits for the next piece.
    const data = carry.length === 0 ? chunk : concat([carry, chunk])
    const whole = data.length - (data.length % 3)
    carry = data.slice(whole)
    col = yield* wrapped(pen, toBase64(data.subarray(0, whole)), wrap, col)
  }
  if (carry.length > 0) col = yield* wrapped(pen, toBase64(carry), wrap, col)
  if (col > 0) yield* pen.put('\n')
}

/**
 * Turns base64 text back into bytes as it reads. The bytes of every whole group of four characters before a place
 * that is not base64 are written before that place is refused, so what is refused is exactly what follows it.
 */
function* decode64(sys: Sys, fd: number, pen: Pen): Task<void> {
  /** Characters not yet turned into bytes: fewer than four after each piece. */
  let pending = ''
  /** The `=` signs seen: once there is one, only more of them and white space may follow. */
  let pads = 0
  /** Whether the characters left over and the `=` signs after them make a whole group of four (or more, with a sign too many). */
  const closed = (): boolean => pads > 0 && pending.length >= 2 && pending.length + pads >= 4
  for (;;) {
    const chunk = yield* sys.read(fd, PIECE)
    if (chunk.length === 0) break
    const clean = new Uint8Array(chunk.length)
    let k = 0
    let fault: string | null = null
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i]
      if (b === 32 || (b >= 9 && b <= 13)) continue
      if (b === 61) {
        if (++pads > 2) { fault = "too many '=' signs at the end"; break }
        continue
      }
      if (!isBase64(b)) {
        fault = `unexpected ${b > 32 && b < 127 ? `character '${String.fromCharCode(b)}'` : `byte 0x${hex(Uint8Array.of(b))}`}`
        break
      }
      if (pads > 0) { fault = "text after the '=' signs that end it"; break }
      clean[k++] = b
    }
    const text = pending + decode(clean.subarray(0, k))
    const whole = text.length - (text.length % 4)
    pending = text.slice(whole)
    if (whole > 0) yield* pen.raw(fromBase64(text.slice(0, whole)))
    if (fault !== null) {
      // A group its `=` signs close is whole too: its bytes go out before what follows it is refused.
      if (closed()) yield* pen.raw(fromBase64(pending))
      refuse('EINVAL', `not base64: ${fault}`)
    }
  }
  // The end: two or three characters are one or two more bytes, with or without the `=` signs that fill the group.
  if (pending.length === 1) refuse('EINVAL', 'not base64: it stops in the middle of a group of four')
  if (pads > 0 && pending.length + pads !== 4) {
    if (closed()) yield* pen.raw(fromBase64(pending))
    refuse('EINVAL', "not base64: the '=' signs at the end do not fit")
  }
  if (pending.length > 0) yield* pen.raw(fromBase64(pending))
}

const base64 = tool('base64', function* (sys, argv, pen) {
  const o = options(argv, 'd', 'w')
  if (o.bad !== null) return yield* misuse(sys, 'base64', o.bad, BASE64_USAGE)
  if (o.rest.length > 1) return yield* misuse(sys, 'base64', 'only one file can be named', BASE64_USAGE)
  const wrap = yield* amount(sys, 'base64', o, 'w', 76)
  if (wrap === null) return yield* usage(sys, BASE64_USAGE)
  const decoding = o.flags.has('d')
  return yield* feed(sys, 'base64', o.rest, pen, (fd) => (decoding ? decode64(sys, fd, pen) : encode64(sys, fd, pen, wrap)))
})

// hexdump

const HEXDUMP_USAGE = 'hexdump [-C] [file ...]'

/** Every byte as two hexadecimal digits. */
const HEX2: readonly string[] = (() => {
  const table: string[] = []
  for (let b = 0; b < 256; b++) table.push((b < 16 ? '0' : '') + b.toString(16))
  return table
})()

/** One line of a dump: where it starts, up to 16 bytes in two groups of 8, and the same bytes as characters. */
function dumpLine(offset: number, bytes: Uint8Array, from: number, n: number): string {
  let digits = ''
  let shown = ''
  for (let i = 0; i < 16; i++) {
    if (i === 8) digits += ' '
    if (i >= n) { digits += '   '; continue }
    const b = bytes[from + i]
    digits += ` ${HEX2[b]}`
    shown += b >= 32 && b < 127 ? String.fromCharCode(b) : '.'
  }
  return `${offset.toString(16).padStart(8, '0')} ${digits}  |${shown}|`
}

const hexdump = tool('hexdump', function* (sys, argv, pen) {
  const o = options(argv, 'C')
  if (o.bad !== null) return yield* misuse(sys, 'hexdump', o.bad, HEXDUMP_USAGE)
  /** Bytes of a line not yet full: files are dumped as one run, so a line may start in one and end in the next. */
  const row = new Uint8Array(16)
  const at = { fill: 0, offset: 0 }
  const status = yield* feed(sys, 'hexdump', o.rest, pen, function* (fd) {
    for (;;) {
      const chunk = yield* sys.read(fd, PIECE)
      if (chunk.length === 0) return
      let i = 0
      if (at.fill > 0) {
        i = Math.min(16 - at.fill, chunk.length)
        row.set(chunk.subarray(0, i), at.fill)
        at.fill += i
        if (at.fill < 16) continue
        yield* pen.line(dumpLine(at.offset, row, 0, 16))
        at.offset += 16
        at.fill = 0
      }
      for (; i + 16 <= chunk.length; i += 16) {
        yield* pen.line(dumpLine(at.offset, chunk, i, 16))
        at.offset += 16
      }
      if (i < chunk.length) {
        row.set(chunk.subarray(i))
        at.fill = chunk.length - i
      }
    }
  })
  if (at.fill > 0) {
    yield* pen.line(dumpLine(at.offset, row, 0, at.fill))
    at.offset += at.fill
  }
  if (at.offset > 0) yield* pen.line(at.offset.toString(16).padStart(8, '0'))
  return status
})

// sha256sum

const SHA256SUM_USAGE = 'sha256sum [file ...]'

const sha256sum = tool('sha256sum', function* (sys, argv, pen) {
  const o = options(argv, '')
  if (o.bad !== null) return yield* misuse(sys, 'sha256sum', o.bad, SHA256SUM_USAGE)
  return yield* feed(sys, 'sha256sum', o.rest, pen, function* (fd, path) {
    // The digest is worked out a piece at a time as the input is read, so only one piece is held, whatever the length.
    const hasher = new Sha256()
    for (;;) {
      const chunk = yield* sys.read(fd, PIECE)
      if (chunk.length === 0) break
      hasher.update(chunk)
    }
    yield* pen.line(`${hex(hasher.digest())}  ${path ?? '-'}`)
  })
})

// xargs

const XARGS_USAGE = 'xargs [-0r] [-n count] [-I word] [command [argument ...]]'

/** The most bytes of arguments one run is given, the command's own included: each argument in UTF-8, and one more for its end. */
const RUN_BYTES = 65536

const TOO_LONG = `a word of the input is too long for one run (${RUN_BYTES} bytes with the command)`

/** The bytes an argument takes: its text in UTF-8 (a lone half of a pair as the three of U+FFFD), and one for its end. */
function argBytes(text: string): number {
  let n = 1
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4
        i++
        continue
      }
    }
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3
  }
  return n
}

/**
 * Cuts what `xargs` reads into items. As words: blanks and line ends part them, quotes and a backslash keep a blank
 * inside one. As lines: a line is one item, the blanks before it dropped, quotes and backslashes still read. As
 * zero-ended: every zero byte ends an item and nothing else means anything.
 */
class Splitter {
  private readonly mode: 'words' | 'lines' | 'zero'
  private item = ''
  private begun = false
  private quote = ''
  private escaped = false
  /** What is wrong with the input, once something is: nothing more is read after that. */
  fault: string | null = null

  constructor(mode: 'words' | 'lines' | 'zero') {
    this.mode = mode
  }

  /**
   * Reads more text, adding each finished item to `out`. An item with more UTF-16 units than a run may have bytes
   * can never be handed on: it is a fault as soon as it is that long, ended or not, so it is never held whole.
   */
  take(text: string, out: string[]): void {
    for (let i = 0; i < text.length && this.fault === null; i++) this.one(text[i], out)
    if (this.fault === null && this.item.length > RUN_BYTES) this.fault = TOO_LONG
  }

  private finish(out: string[]): void {
    if (this.item.length > RUN_BYTES) {
      this.fault = TOO_LONG
      return
    }
    out.push(this.item)
    this.item = ''
    this.begun = false
  }

  private one(ch: string, out: string[]): void {
    if (this.mode === 'zero') {
      if (ch === '\0') this.finish(out)
      else this.item += ch
      return
    }
    if (this.escaped) {
      this.item += ch
      this.escaped = false
      return
    }
    if (this.quote !== '') {
      if (ch === this.quote) this.quote = ''
      else if (ch === '\n') this.fault = this.open()
      else this.item += ch
      return
    }
    if (ch === '\\') {
      this.escaped = true
      this.begun = true
    } else if (ch === '"' || ch === "'") {
      this.quote = ch
      this.begun = true
    } else if (ch === '\n' || (this.mode === 'words' && blank(ch))) {
      if (this.begun) this.finish(out)
    } else if (this.begun || !blank(ch)) {
      this.item += ch
      this.begun = true
    }
  }

  private open(): string {
    return `a ${this.quote === '"' ? 'double' : 'single'} quote is not closed`
  }

  /** The input has ended: the item being read, if any, is finished. */
  end(out: string[]): void {
    if (this.fault !== null) return
    if (this.mode === 'zero') {
      if (this.item !== '') this.finish(out)
      return
    }
    if (this.quote !== '') {
      this.fault = this.open()
      return
    }
    if (this.escaped) this.item += '\\'
    if (this.begun) this.finish(out)
  }
}

const xargs = tool('xargs', function* (sys, argv, pen) {
  const o = options(argv, '0r', 'nI')
  if (o.bad !== null) return yield* misuse(sys, 'xargs', o.bad, XARGS_USAGE)
  // 0 stands for "as many as fit".
  const perRun = yield* amount(sys, 'xargs', o, 'n', 0, 1)
  if (perRun === null) return yield* usage(sys, XARGS_USAGE)
  const word = o.values.get('I') ?? null
  if (word === '') return yield* misuse(sys, 'xargs', "option '-I' needs the word to replace", XARGS_USAGE)
  const base = o.rest.length === 0 ? ['echo'] : o.rest
  let baseSize = 0
  for (const a of base) baseSize += argBytes(a)
  /** With -I: each argument of the command cut at the word, so a line can be put in each gap. */
  const gaps = word === null ? [] : base.map((a) => a.split(word))
  /** With -I: the bytes the command takes with an empty line put in, and how many gaps a line fills. */
  let gapSize = 0
  let gapCount = 0
  for (const g of gaps) {
    gapSize += argBytes(g.join(''))
    gapCount += g.length - 1
  }
  const st = { failed: false, fatal: 0, ran: false, fault: '' }
  // The command must not read what is meant for xargs: it is given a descriptor that reads as nothing.
  let quiet = -1
  try {
    quiet = yield* sys.open('/dev/null', O_READ)
    // Opened in the place of a closed input (or output), it would stand in for it: xargs would read it as its own input.
    if (quiet < 3) {
      const low = quiet
      quiet = -1
      try {
        quiet = sys.dup(low, 3)
      } finally {
        sys.close(low)
      }
    }
  } catch (e) {
    if (!(e instanceof OsError)) throw e
  }
  const run = function* (args: readonly string[]): Task<void> {
    st.ran = true
    let pid: number
    try {
      pid = yield* sys.spawn(args, { fds: [quiet >= 0 ? quiet : null, sys.isOpen(1) ? 1 : null, sys.isOpen(2) ? 2 : null] })
    } catch (e) {
      if (!(e instanceof OsError)) throw e
      yield* complain(sys, 'xargs', clipped(args[0]), e.errno === 'ENOENT' ? 'not found' : e)
      st.fatal = e.errno === 'ENOENT' ? 127 : 126
      return
    }
    const status = yield* sys.wait(pid)
    // A status of 128 or more is a run ended from outside (nobody reads its output any more, Ctrl+C): no more are started.
    if (status >= 128) st.fatal = 125
    else if (status !== 0) st.failed = true
  }
  let batch: string[] = []
  let size = baseSize
  const give = function* (items: readonly string[]): Task<void> {
    for (const item of items) {
      if (st.fatal !== 0 || st.fault !== '') return
      if (word !== null) {
        if (gapSize + gapCount * (argBytes(item) - 1) > RUN_BYTES) {
          st.fault = `the command for one line would be longer than ${RUN_BYTES} bytes`
          return
        }
        yield* run(gaps.map((g) => g.join(item)))
        continue
      }
      const cost = argBytes(item)
      if (baseSize + cost > RUN_BYTES) {
        st.fault = TOO_LONG
        return
      }
      if (batch.length > 0 && size + cost > RUN_BYTES) {
        yield* run([...base, ...batch])
        batch = []
        size = baseSize
        if (st.fatal !== 0) return
      }
      batch.push(item)
      size += cost
      if (perRun > 0 && batch.length >= perRun) {
        yield* run([...base, ...batch])
        batch = []
        size = baseSize
      }
    }
  }
  try {
    const splitter = new Splitter(o.flags.has('0') ? 'zero' : word !== null ? 'lines' : 'words')
    const decoder = new TextDecoder('utf-8')
    const read = yield* feed(sys, 'xargs', [], pen, function* (fd) {
      for (;;) {
        const chunk = yield* sys.read(fd, PIECE)
        const items: string[] = []
        if (chunk.length === 0) {
          splitter.take(decoder.decode(), items)
          splitter.end(items)
        } else splitter.take(decoder.decode(chunk, { stream: true }), items)
        yield* give(items)
        if (chunk.length === 0 || splitter.fault !== null || st.fatal !== 0 || st.fault !== '') return
      }
    })
    if (st.fatal !== 0) return st.fatal
    if (read !== 0) return 1
    // A fault ends the reading; the words read before it that wait for a run are not run either.
    const fault = st.fault !== '' ? st.fault : splitter.fault
    if (fault !== null) {
      yield* complain(sys, 'xargs', null, fault)
      return 1
    }
    if (word === null && (batch.length > 0 || (!st.ran && !o.flags.has('r')))) yield* run([...base, ...batch])
    if (st.fatal !== 0) return st.fatal
    return st.failed ? 123 : 0
  } finally {
    if (quiet >= 0) sys.close(quiet)
  }
})

/** name -> program */
export const TEXT_PROGRAMS: Readonly<Record<string, Program>> = Object.freeze({
  head, tail, wc, sort, uniq, cut, tr, tee, tac, rev, nl, fold, paste, seq, yes, echo, printf, base64, hexdump, sha256sum, xargs,
})

/** name -> manual page text */
export const TEXT_MANUAL: Readonly<Record<string, string>> = Object.freeze({
  head: `NAME
    head - the first lines of a file

USAGE
    ${HEAD_USAGE}

WHAT IT DOES
    Prints the start of each file: its first 10 lines unless told
    otherwise. With no file, or for the name -, it reads its input. When
    several files are named, each part is headed by a line that names
    the file, like ==> name <==.

OPTIONS
    -n N    the first N lines (10 when not given); -5 is short for -n 5
    -c N    the first N bytes instead of lines (when both are given, -c
            is the one that counts)

STATUS
    0; 1 when a file could not be read (the others still are) or the
    output could not be written; 2 for a wrong option.

EXAMPLE
    head -n 3 README
`,
  tail: `NAME
    tail - the last lines of a file

USAGE
    ${TAIL_USAGE}

WHAT IT DOES
    Prints the end of each file: its last 10 lines unless told otherwise.
    With no file, or for the name -, it reads its input. A number with a
    + in front counts from the start instead: -n +3 prints from the
    third line on. When several files are named, each part is headed by
    a line that names the file, like ==> name <==.

OPTIONS
    -n N    the last N lines; -n +N everything from line N on; -5 is
            short for -n 5
    -c N    the last N bytes; -c +N everything from byte N on

NOTES
    It reads to the end and stops: there is no -f to keep watching a
    file that grows. It keeps only the part it may still have to print,
    and gives up if that alone comes to more than 64 MiB.

STATUS
    0; 1 when a file could not be read (the others still are) or the
    output could not be written; 2 for a wrong option.

EXAMPLE
    tail -n 2 README
`,
  wc: `NAME
    wc - count the lines, words and bytes of a file

USAGE
    ${WC_USAGE}

WHAT IT DOES
    Prints, for each file, how many lines, words and bytes it holds, and
    then its name. A line is counted at each line end; a word is a run
    of characters with no white space (blank, tab, line end, carriage
    return) among them. With no file it counts its input and prints no
    name; for the name - it counts its input and prints the name -. When
    several files are named, a last line gives the total. The numbers
    are lined up in columns as wide as the widest of them.

OPTIONS
    -l      lines
    -w      words
    -c      bytes
    -m      characters (one character of UTF-8 text may be several bytes)
    With any of these only what was asked for is printed, always in the
    order lines, words, characters, bytes.

STATUS
    0; 1 when a file could not be read (the others still are) or the
    output could not be written; 2 for a wrong option.

EXAMPLE
    wc -l README
`,
  sort: `NAME
    sort - put the lines of files in order

USAGE
    ${SORT_USAGE}

WHAT IT DOES
    Reads every line of the files (or of its input), puts them in order
    and prints them. Lines are compared character by character, by the
    code of each character: capital letters come before small ones, and
    10 comes before 9 unless -n is given. Lines that compare equal stay
    in the order they came in.

OPTIONS
    -r      the other way round: last first
    -n      compare as numbers (-3, 2.5, 10); text that does not start
            with a number counts as 0
    -u      of lines that compare equal, print only the first
    -f      take small letters for capitals when comparing
    -b      skip blanks at the start of what is compared
    -k N    compare from field N to the end of the line (fields count
            from 1)
    -t C    fields are separated by the character C. Without -t a field
            is a run of characters that are not blanks, together with
            the blanks before it: add -b to compare from its first
            character.

NOTES
    No language's dictionary order is known, only character codes. -k
    takes one field number, not N,M. There is no -o and no -c. All the
    lines are held in memory while they are put in order; more than
    64 MiB is refused. When a file cannot be read, nothing is printed.
    Bytes that are not UTF-8 text are not kept as they are: each comes
    out as the replacement character U+FFFD.

STATUS
    0; 1 when a file could not be read, there was too much to hold, or the
    output could not be written; 2 for a wrong option.

EXAMPLE
    sort -t : -k 3 -n /etc/passwd
`,
  uniq: `NAME
    uniq - leave out lines that repeat the line before

USAGE
    ${UNIQ_USAGE}

WHAT IT DOES
    Prints the lines of a file (or of its input), but where the same
    line comes several times in a row it prints it once. Only lines next
    to each other are compared, so sort them first to find every repeat.

OPTIONS
    -c      before each line, how many times it came, and a blank
    -d      only the lines that were repeated, once each
    -u      only the lines that were not repeated
    -i      take small and capital letters as the same when comparing

NOTES
    A second file name to write to is not understood: use > file. A line
    longer than 1048576 characters may be cut into lines of that length.
    Bytes that are not UTF-8 text are not kept as they are: each comes out
    as the replacement character U+FFFD.

STATUS
    0; 1 when the file could not be read or the output could not be
    written; 2 for a wrong option or a second file.

EXAMPLE
    sort names | uniq -c
`,
  cut: `NAME
    cut - print chosen parts of each line

USAGE
    ${CUT_USAGE}

WHAT IT DOES
    Prints, for each line of the files (or of its input), only the parts
    a list names: fields (-f), characters (-c) or bytes (-b). A list is
    numbers and ranges with commas between them, counted from 1:
    1,3-5,7- means the first, the third to the fifth, and the seventh
    onwards; -3 means up to the third. Each part is printed once, in the
    order it has in the line.

OPTIONS
    -f LIST  fields: the parts of a line between tabs, or between the
             character -d names. A line without that character is
             printed whole.
    -d C     the character that separates fields
    -s       with -f, leave out lines that do not have the separator
    -c LIST  characters (one character of UTF-8 text may be several
             bytes)
    -b LIST  bytes

NOTES
    With -f, a line longer than 1048576 characters may be cut into lines
    of that length. With -f and -c, bytes that are not UTF-8 text are not
    kept as they are: each comes out as the replacement character U+FFFD.
    With -b every byte is kept as it is.

STATUS
    0; 1 when a file could not be read (the others still are) or the
    output could not be written; 2 for a wrong option.

EXAMPLE
    cut -d : -f 1,6 /etc/passwd
`,
  tr: `NAME
    tr - change or remove characters

USAGE
    ${TR_USAGE}

WHAT IT DOES
    Copies its input to its output, changing each character of set1 into
    the character at the same place in set2. When set2 is the shorter,
    its last character stands for the rest. It reads only its input: for
    a file, write tr a b < file.

    A set is a list of characters. In it a-z means every character from
    a to z; \\n is a line end, \\t a tab, \\\\ a backslash (\\r \\a \\b \\f \\v
    and \\NNN, a code in octal, are read too); and [:alpha:] [:digit:]
    [:upper:] [:lower:] [:space:] [:alnum:] [:punct:] are the letters,
    the digits, the capitals, the small letters, white space, letters
    and digits, and punctuation marks. Put a set in single quotes so the
    shell leaves it as it is.

OPTIONS
    -d      remove the characters of set1 (set2 is then not given)
    -s      where a character of the last set given comes several times
            in a row, print it once; with -d, set2 names those
    -c      take every character that is NOT in set1; when changing,
            each of them becomes the last character of set2

NOTES
    The classes hold plain ASCII characters only: [:upper:] is A to Z.
    The forms [=c=] and [c*n] are not understood. A set lists at most
    1114112 characters. Bytes that are not UTF-8 text are not kept as
    they are: each comes out as the replacement character U+FFFD.

STATUS
    0; 1 when the input could not be read or the output could not be
    written; 2 for a wrong option or a set that cannot be read.

EXAMPLE
    tr a-z A-Z < README
`,
  tee: `NAME
    tee - copy the input to the output and into files as well

USAGE
    ${TEE_USAGE}

WHAT IT DOES
    Reads its input and writes it both to its output and to every file
    named, byte for byte, so what passes along a pipeline can be kept on
    the way. A file is made if it is not there, and emptied first unless
    -a is given.

OPTIONS
    -a      add to the end of each file instead of replacing it

STATUS
    0; 1 when a file could not be opened or written, or the output could
    not be written (the other places still get everything); 2 for a wrong
    option.

EXAMPLE
    sort names | tee sorted | wc -l
`,
  tac: `NAME
    tac - print the lines of a file last line first

USAGE
    ${TAC_USAGE}

WHAT IT DOES
    Prints the lines of each file (or of its input) in the opposite
    order: the last line first. Several files are turned round one after
    another, in the order they are named. The bytes of every line are
    kept as they are; a last line without a line end is given one.

NOTES
    A file is held in memory whole while it is turned round; one larger
    than 64 MiB is refused.

STATUS
    0; 1 when a file could not be read (the others still are) or the
    output could not be written; 2 for a wrong option.

EXAMPLE
    tac README
`,
  rev: `NAME
    rev - print each line with its characters in the opposite order

USAGE
    ${REV_USAGE}

WHAT IT DOES
    Prints every line of the files (or of its input) back to front: abc
    becomes cba. The lines stay in their order. Whole characters are
    moved, so UTF-8 text is still UTF-8 text afterwards.

NOTES
    A line longer than 1048576 characters may be cut into lines of that
    length. Bytes that are not UTF-8 text are not kept as they are: each
    comes out as the replacement character U+FFFD.

STATUS
    0; 1 when a file could not be read (the others still are) or the
    output could not be written; 2 for a wrong option.

EXAMPLE
    rev README
`,
  nl: `NAME
    nl - number the lines of a file

USAGE
    ${NL_USAGE}

WHAT IT DOES
    Prints each line of the files (or of its input) with its number in
    front, then a tab, then the line. An empty line is printed empty and
    is not counted, unless -b a is given. The count goes on from one
    file to the next.

OPTIONS
    -b a    number every line
    -b t    number only the lines that have text (as when not given)
    -w N    the number takes N columns and stands at their right (6 when
            not given, 4096 at most)

NOTES
    Pages, sections and other ways to write the number are not understood.
    A line longer than 1048576 characters may be cut into lines of that
    length. Bytes that are not UTF-8 text are not kept as they are: each
    comes out as the replacement character U+FFFD.

STATUS
    0; 1 when a file could not be read (the others still are) or the
    output could not be written; 2 for a wrong option.

EXAMPLE
    nl -b a README
`,
  fold: `NAME
    fold - break long lines so they fit a width

USAGE
    ${FOLD_USAGE}

WHAT IT DOES
    Prints each line of the files (or of its input), breaking a line
    longer than the width into several. Nothing is added or taken away
    but line ends.

OPTIONS
    -w N    the width in characters (80 when not given)
    -s      break after the last blank that fits, so that words stay
            whole where they can

NOTES
    Every character counts as one column, a tab too. A line longer than
    1048576 characters may be cut into lines of that length. Bytes that
    are not UTF-8 text are not kept as they are: each comes out as the
    replacement character U+FFFD.

STATUS
    0; 1 when a file could not be read (the others still are) or the
    output could not be written; 2 for a wrong option.

EXAMPLE
    fold -s -w 40 README
`,
  paste: `NAME
    paste - join the lines of several files side by side

USAGE
    ${PASTE_USAGE}

WHAT IT DOES
    Prints the first line of every file on one line with a tab between
    them, then the second lines, and so on; a file that has run out
    gives nothing. The name - is the input, and may be given more than
    once to take its lines in turn: paste - - puts two lines of the
    input on each line.

OPTIONS
    -s      one file after another instead: all the lines of a file
            joined into a single line
    -d LIST the characters of LIST, in turn, in place of the tab; in it
            \\n is a line end, \\t a tab, \\\\ a backslash and \\0 nothing
            at all

NOTES
    Side by side, a file that cannot be opened ends the program before
    anything is printed. A line longer than 1048576 characters may be cut
    into lines of that length. Bytes that are not UTF-8 text are not kept
    as they are: each comes out as the replacement character U+FFFD.

STATUS
    0; 1 when a file could not be read or the output could not be written;
    2 for a wrong option.

EXAMPLE
    paste -d , names ages
`,
  seq: `NAME
    seq - print a run of numbers

USAGE
    ${SEQ_USAGE}

WHAT IT DOES
    Prints the numbers from first to last, one to a line, going up by
    step each time. First and step are 1 when not given. A step below 0
    counts down: seq 5 -1 1. A number may have a decimal part, as in
    seq 0 0.5 2; every number is then printed with as many decimals as
    first or step has.

OPTIONS
    -s S    S between the numbers in place of a line end
    -w      zeros in front, so that every number is as wide as the
            widest

NOTES
    A number is a whole number or a plain decimal such as -2.50: 1e3 is
    not understood. Written with as many decimals as the one that has
    the most, every number must fit in 15 digits, so seq 0.5 100000000000000
    is refused. A step of 0 is refused.

STATUS
    0; 1 when the output could not be written; 2 for a wrong option or
    something that is no such number.

EXAMPLE
    seq 1 5
`,
  yes: `NAME
    yes - print the same line again and again

USAGE
    yes [text ...]

WHAT IT DOES
    Prints a line made of its arguments (or the letter y) over and over.
    It never ends by itself: it stops when the program that reads its
    output stops, or when you press Ctrl+C.

STATUS
    None when all goes well: it is ended from outside. 1 when its output
    could not be written (a full disk, say).

EXAMPLE
    yes ok | head -n 3
`,
  echo: `NAME
    echo - print its arguments

USAGE
    echo [-n] [-e] [text ...]

WHAT IT DOES
    Prints its arguments with one blank between them and a line end
    after. The shell has an echo of its own, which does the same and is
    what a typed echo runs; this one is the program that other programs
    run (xargs, for one).

OPTIONS
    -n      no line end after the text
    -e      in the text, \\n is a line end, \\t a tab, \\r a carriage
            return, \\\\ a backslash, \\e the escape character and \\0 a
            zero byte
    The options count only before the text, and only written as -n, -e,
    -ne or -en.

STATUS
    0, or 1 when the output could not be written.

EXAMPLE
    /bin/echo -e 'one\\ntwo'
`,
  printf: `NAME
    printf - print text laid out by a format

USAGE
    ${PRINTF_USAGE}

WHAT IT DOES
    Prints the format, with each % item in it replaced by the next
    argument. Nothing is added: write \\n in the format for a line end.
    When there are more arguments than items, the format is used again
    for the rest; an item with no argument left prints as nothing (as 0
    for a number).

    The items: %s text; %d or %i a whole number; %u the same, never
    below 0; %x or %X the number in hexadecimal; %o in octal; %c the
    first character; %b text in which \\n and its like are read; %% a
    percent sign.

    Between the % and the letter may stand - (keep to the left), 0 (fill
    with zeros), + (always a sign), a blank (a blank where a sign would
    be), a width, and a dot with a precision: the most characters of a
    text, or the fewest digits of a number. So %-8s, %5d, %.2s, %05d.

    In the format and in %b text, \\n is a line end, \\t a tab, \\r a
    carriage return, \\\\ a backslash, \\a \\b \\f \\v the usual control
    characters, \\e the escape character, \\0NNN the byte with the octal
    code NNN and \\xHH the byte with the hexadecimal code HH. In %b text
    \\c ends all printing there.

NOTES
    A number is a whole number that fits in 64 bits; 0x1f, 017 and 'A
    (the code of a character) are read. There are no %f, %e or %g, no *
    and no # flag. A width or precision is at most 4096.

STATUS
    0; 1 when an argument was no number (it counts as 0 and the rest is
    still printed), the format has an item it does not know, or the output
    could not be written; 2 when there is no format.

EXAMPLE
    printf '%-6s %3d\\n' apples 7 pears 12
`,
  base64: `NAME
    base64 - write bytes as plain letters, and back

USAGE
    ${BASE64_USAGE}

WHAT IT DOES
    Prints the file (or its input) in base64: every 3 bytes become 4
    characters out of A-Z a-z 0-9 + and /, so that anything at all can
    pass where only text is carried. With -d it turns base64 back into
    the bytes it stands for.

OPTIONS
    -d      decode: white space in the input is skipped, the = signs at
            the end may be missing, and anything else that is not base64
            is refused
    -w N    break the output into lines of N characters (76 when not
            given); -w 0 gives one long line with no line end

NOTES
    Decoding writes as it goes: the bytes of every whole group of four
    characters before a bad place have been written by the time it is
    refused.

STATUS
    0; 1 when the file could not be read or is not base64, or the output
    could not be written; 2 for a wrong option or a second file.

EXAMPLE
    base64 README
`,
  hexdump: `NAME
    hexdump - show the bytes of a file in hexadecimal

USAGE
    ${HEXDUMP_USAGE}

WHAT IT DOES
    Prints the bytes of the files (or of its input), 16 to a line: how
    far into the input the line starts (in hexadecimal), the 16 bytes as
    two hexadecimal digits each, in two groups of 8, and between | marks
    the same bytes as characters, with a dot for any that is not a
    printable ASCII character. A last line gives the length of it all.
    Several files are shown as one run of bytes.

OPTIONS
    -C      accepted, and changes nothing: this layout is the only one

NOTES
    Lines that repeat are all printed, never replaced by a *. An empty
    input prints nothing.

STATUS
    0; 1 when a file could not be read (the others still are) or the
    output could not be written; 2 for a wrong option.

EXAMPLE
    hexdump README
`,
  sha256sum: `NAME
    sha256sum - print the SHA-256 digest of a file

USAGE
    ${SHA256SUM_USAGE}

WHAT IT DOES
    Prints, for each file (or for its input, named -), 64 hexadecimal
    digits worked out from every byte of it, then two blanks and the
    name. Files with the same digest hold, for every practical purpose,
    the same bytes, so the digest shows whether a file has changed.

NOTES
    There is no -c to check a list of digests. The input is read and
    digested a piece at a time, so a file of any length can be given; an
    input that never ends (/dev/zero) runs until Ctrl+C.

STATUS
    0; 1 when a file could not be read (the others still are) or the
    output could not be written; 2 for a wrong option.

EXAMPLE
    sha256sum README
`,
  xargs: `NAME
    xargs - run a command with arguments read from the input

USAGE
    ${XARGS_USAGE}

WHAT IT DOES
    Reads words from its input and runs the command with those words
    after its own arguments; echo is run when no command is given. Words
    are parted by blanks and line ends. To keep a blank inside a word,
    put the word in single or double quotes, or a backslash before the
    blank. One run gets as many words as fit in 65536 bytes (the
    command included, each argument counted in UTF-8 with one more byte
    for its end), and the command is run again for the rest.

OPTIONS
    -n N    at most N words to a run
    -I W    run the command once for each line of the input, with every
            W in its arguments replaced by the line (blanks at the start
            of the line are dropped; quotes and backslashes are read as
            above; -n is then left unused)
    -0      a word ends at a zero byte and nowhere else: blanks, line
            ends, quotes and backslashes are part of it
    -r      do not run the command at all when the input has no words

NOTES
    The command is a program or a script, found the way the shell finds
    one; the shell's own commands (cd, read and their like) cannot be
    run this way, and a script must start with a line such as #!/bin/sh.
    The command is not given the input: it reads nothing. A word too
    long to fit in one run with the command is refused, and so is a
    quote that is not closed: the reading stops there, and the words
    read before it that were waiting for a run are not run. There are
    no -L, -s, -t, -p or -E options. Bytes that are not UTF-8 text are
    not kept as they are: each comes out as the replacement character
    U+FFFD.

STATUS
    0 when every run gave 0; 123 when a run gave a status from 1 to 127;
    125 when a run was ended from outside (a status of 128 or more:
    Ctrl+C, or nobody left to read its output), after which no more are
    started; 126 when the command could not be run; 127 when it was not
    found; 1 for input it could not read or use (a quote that is not
    closed, a word too long); 2 for a wrong option.

EXAMPLE
    xargs -n 2 echo pair: < names
`,
})
