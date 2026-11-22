// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is grep, the program that finds lines: it reads files (or its input, or every file
 * below a directory) a line at a time and prints the lines a pattern is found in, or counts them, or names the files
 * that hold them, with lines of context around them when asked. The patterns a person types are matched by the
 * layer's own engine (regex.ts), which keeps every way through a pattern alive at once, so no pattern can stall the
 * console however it is written; the host's own matcher never sees one, and a long search is run a slice at a time
 * with the other tasks given a turn between slices, so Ctrl+C stops it at once. Lines are cut from bytes and printed
 * as the bytes they were, so what is not UTF-8 text passes through unchanged, and a file that holds a NUL byte near
 * its start is reported as binary instead of being poured onto the screen.
 * What breaks if it is removed? `ls /bin | grep sh`, `stats --once | grep fps` and every script that tests whether
 * a file holds a word with `grep -q` stop working: the pipeline loses its filter.
 */
import { EMPTY, concat, decode, encode } from './bytes.ts'
import { OsError } from './errno.ts'
import type { Entry } from './fs.ts'
import type { Program, Sys } from './kernel.ts'
import { READ_ALL_MAX } from './kernel.ts'
import { LINE_BYTES_MAX, complain, count, usage } from './lib.ts'
import { join } from './path.ts'
import { RegexError, compile, folded } from './regex.ts'
import type { Match, Regex, RegexOptions, Scan } from './regex.ts'
import type { Task } from './task.ts'
import { O_READ } from './vfs.ts'

/** How many bytes at the start of a file are looked at for a NUL, the mark of a file that is not text. */
const SNIFF = 8192
/** Bytes of output gathered before they are written. */
const PIECE = 65536
/** How many directories below a named one -r goes. */
const DEPTH = 64
/** The most bytes of lines kept back for -B: older ones are let go past it. */
const HOLD_MAX = READ_ALL_MAX
/**
 * Work done between two turns given to the other tasks: steps of the engine, characters looked at otherwise. A step
 * takes from about 10 to about 150 nanoseconds, so a turn of grep lasts from a few milliseconds to about twenty.
 */
const PACE_WORK = 1 << 17
/**
 * The most instructions all the patterns together may be laid out as (one may take 20000). Each instruction holds a
 * few dozen bytes once searched with, and the arguments can carry thousands of patterns that each lay out as many
 * as one may: this is what keeps them from holding gigabytes and taking minutes to make ready.
 */
const PROGRAMS_MAX = 1 << 20
/**
 * Work of making patterns ready between two turns given to the other tasks: the instructions laid out, eight for each
 * character read and 256 for each pattern. A pattern of the largest size takes a millisecond or two to make ready.
 */
const COMPILE_WORK = 1 << 15
/** A line feed, as bytes (shared, never written). */
const NEWLINE: Uint8Array = Uint8Array.of(10)
/** What the input is called where a file name would stand. */
const STDIN = '(standard input)'

const USAGE = 'grep [-cEFhHilLnoqrsvwx] [-m N] [-A N] [-B N] [-C N] pattern [file ...]'
const USAGE_E = 'grep [options] -e pattern [-e pattern]... [file ...]'

/** The letters that stand alone, and those that take a value. */
const FLAGS = 'cEFhHilLnoqrsvwx'
const VALUED = 'emABC'

// The output

/** A write to the ordinary output refused for a reason other than a closed pipe (a full disk, say). */
class Spill {
  readonly why: OsError

  constructor(why: OsError) {
    this.why = why
  }
}

/**
 * The ordinary output as bytes: lines are gathered and written a piece at a time, and on the terminal each line goes
 * out as soon as it is whole, so a person typing lines at grep sees the ones that match at once. A closed pipe
 * passes on as it is (the kernel then ends the program quietly); any other refusal becomes a Spill.
 */
class Writer {
  private readonly sys: Sys
  private readonly live: boolean
  private parts: Uint8Array[] = []
  private size = 0

  constructor(sys: Sys) {
    this.sys = sys
    this.live = sys.isatty(1)
  }

  /** One line: a head of text (a name, a number), the bytes of the line, and a line feed. */
  *line(head: string, body: Uint8Array = EMPTY): Task<void> {
    if (head !== '') this.push(encode(head))
    this.push(body)
    this.push(NEWLINE)
    if (this.live || this.size >= PIECE) yield* this.flush()
  }

  private push(data: Uint8Array): void {
    if (data.length === 0) return
    this.parts.push(data)
    this.size += data.length
  }

  *flush(): Task<void> {
    if (this.size === 0) return
    const data = this.parts.length === 1 ? this.parts[0] : concat(this.parts)
    this.parts = []
    this.size = 0
    try {
      yield* this.sys.write(1, data)
    } catch (e) {
      throw e instanceof OsError && e.errno !== 'EPIPE' ? new Spill(e) : e
    }
  }
}

// The input

/**
 * Reads a descriptor a line at a time, as bytes. From a file, before the first line is handed out it reads on until
 * it holds SNIFF bytes or the input has ended, and a NUL among those bytes marks the input as binary; from a pipe or
 * the terminal it does not wait for that much (a line that has come is answered before the writer sends more, which
 * may be never), and a NUL that comes among the first SNIFF bytes marks the input from then on. A line longer than
 * LINE_BYTES_MAX is handed out in pieces of that length.
 */
class Source {
  private readonly sys: Sys
  private readonly fd: number
  private buf: Uint8Array = EMPTY
  /** How much of `buf` holds input; past it is room for later reads (what was handed out lies before it, untouched). */
  private end = 0
  /** Where the next line begins in `buf`. */
  private at = 0
  /** Up to where `buf` is known to hold no line feed, from `at` on. */
  private scan = 0
  private ended = false
  private started = false
  /** How many of the first bytes have been looked at for a NUL. */
  private looked = 0
  /** Whether a NUL was found among the first SNIFF bytes. */
  binary = false

  constructor(sys: Sys, fd: number) {
    this.sys = sys
    this.fd = fd
  }

  private *fill(): Task<void> {
    const chunk = yield* this.sys.read(this.fd)
    if (chunk.length === 0) {
      this.ended = true
      return
    }
    if (this.looked < SNIFF) {
      const part = chunk.subarray(0, SNIFF - this.looked)
      if (part.includes(0)) this.binary = true
      this.looked += part.length
    }
    const keep = this.end - this.at
    if (keep > 0 && this.buf.length - this.end >= chunk.length) {
      this.buf.set(chunk, this.end)
      this.end += chunk.length
      return
    }
    // A new array, twice what it must hold, so a long line that comes in small reads is not copied again at each one.
    this.scan -= this.at
    if (keep === 0) this.buf = chunk
    else {
      const room = new Uint8Array(2 * (keep + chunk.length))
      room.set(this.buf.subarray(this.at, this.end))
      room.set(chunk, keep)
      this.buf = room
    }
    this.end = keep + chunk.length
    this.at = 0
  }

  /** The next line without its line feed (the bytes are not to be changed); null at the end of the input. */
  *next(): Task<Uint8Array | null> {
    if (!this.started) {
      this.started = true
      // Only a file is sure to have its next bytes at once: a pipe or the terminal may wait on a writer for good.
      if ((yield* this.sys.fstat(this.fd)) !== null) while (!this.ended && this.looked < SNIFF) yield* this.fill()
    }
    for (;;) {
      const stop = Math.min(this.end, this.at + LINE_BYTES_MAX + 1)
      const end = this.buf.subarray(0, stop).indexOf(10, Math.max(this.scan, this.at))
      if (end >= 0) return this.take(end, end + 1)
      if (stop - this.at > LINE_BYTES_MAX) return this.take(this.at + LINE_BYTES_MAX, this.at + LINE_BYTES_MAX)
      this.scan = stop
      if (this.ended) return this.at < this.end ? this.take(this.end, this.end) : null
      yield* this.fill()
    }
  }

  /** The bytes from `at` to `end`; the next line begins at `from`. */
  private take(end: number, from: number): Uint8Array {
    const line = this.buf.subarray(this.at, end)
    this.at = from
    this.scan = from
    return line
  }
}

// The patterns

/** Where a pattern was found in a line: its first UTF-16 unit and the one after its last. */
type Span = readonly [number, number]

/**
 * What a finder runs its searches through, so that no search, however long, keeps the other tasks waiting: a scan of
 * the engine is run to its answer a slice at a time, and other work is counted.
 */
interface Pacer {
  /** Runs a scan of the engine to its answer, giving the other tasks a turn whenever enough work has been done. */
  finish<T>(scan: Scan<T>): Task<T>
  /** Counts work done outside the engine (characters looked at), giving the other tasks a turn after a lot of it. */
  charge(work: number): Task<void>
}

/** One pattern made ready, with -w or -x already taken into account. */
interface Finder {
  /** Whether it is found anywhere in the line. */
  test(line: string, pace: Pacer): Task<boolean>
  /** The leftmost place it is found that starts at or after `from`, or null. */
  find(line: string, from: number, pace: Pacer): Task<Span | null>
}

/** A letter, digit or underscore of ASCII: what a word is made of, as the engine's own `\w` has it. */
const isWord = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
/**
 * What `\w` is when case is ignored: also the three letters past ASCII that fold into it (the dotless i, the long s,
 * the kelvin sign), as the engine has it, so -F -w -i draws the edges of a word where -w -i does.
 */
const isFoldedWord = (c: number): boolean => isWord(c) || c === 0x131 || c === 0x17f || c === 0x212a

/** The span of the match a scan finds, or of one of its groups. */
function* spanOf(pace: Pacer, scan: Scan<Match | null>, group: number): Task<Span | null> {
  const m = yield* pace.finish(scan)
  if (m === null) return null
  return group === 0 ? [m.start, m.end] : m.groups[group]
}

/**
 * A text with every character folded as -i compares it, by the engine's own fold (a surrogate pair is one character,
 * a lone half is itself). No character changes its width in UTF-16 by this, so a folded text keeps every offset.
 */
function foldText(text: string): string {
  const parts: string[] = []
  let kept = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.codePointAt(i) ?? 0
    const f = folded(c)
    if (f !== c) {
      parts.push(text.slice(kept, i), String.fromCodePoint(f))
      kept = i + (c > 0xffff ? 2 : 1)
    }
    if (c > 0xffff) i++
  }
  if (kept === 0) return text
  parts.push(text.slice(kept))
  return parts.join('')
}

/** How many UTF-16 units of a line are folded between two counts of the work. */
const FOLD_PIECE = 16384

/**
 * A line folded as foldText folds it, a piece at a time, with the work counted as it goes (a letter past ASCII costs
 * about as much to fold as a few steps of the engine), so a long line of such letters never makes one long turn.
 */
function* foldLine(line: string, pace: Pacer): Task<string> {
  const pieces: string[] = []
  for (let at = 0; at < line.length;) {
    let end = Math.min(at + FOLD_PIECE, line.length)
    // A piece never ends between the two halves of a surrogate pair.
    const last = line.charCodeAt(end - 1)
    if (end < line.length && last >= 0xd800 && last <= 0xdbff) end++
    pieces.push(foldText(at === 0 && end === line.length ? line : line.slice(at, end)))
    yield* pace.charge(4 * (end - at))
    at = end
  }
  return pieces.length === 1 ? pieces[0] : pieces.join('')
}

/** Makes a pattern ready, as `compile` does, and counts what that laid out (it may refuse when that is too much). */
type Maker = (pattern: string, options: RegexOptions) => Regex

/**
 * Makes one pattern ready with `make`; a pattern the engine refuses throws its RegexError. For -w and -x a pattern is first
 * made ready on its own, so one that is not well formed is refused for what it is; only then is it set inside a
 * group of a larger pattern (`^(p)$`, or `(^|\W)(p)(\W|$)` whose second group is the part reported), which a
 * well-formed pattern cannot break out of. Plain text (-F) cannot be set inside a pattern, and needs no such thing:
 * every place it is found is as many characters long (with -i too: a character folds to one character), so there
 * is one candidate at each place, and the whole line, or each place in turn, is checked instead.
 */
function finder(pattern: string, plain: boolean, fold: boolean, whole: 'word' | 'line' | null, make: Maker): Finder {
  const re = make(pattern, { ignoreCase: fold, literal: plain })
  if (whole === null) return { test: (line, pace) => pace.finish(re.probe(line)), find: (line, from, pace) => spanOf(pace, re.search(line, from), 0) }
  if (plain && whole === 'line') {
    const find = function* (line: string, from: number, pace: Pacer): Task<Span | null> {
      if (from !== 0) return null
      const m = yield* pace.finish(re.search(line, 0))
      return m !== null && m.start === 0 && m.end === line.length ? [0, line.length] : null
    }
    return { *test(line, pace) { return (yield* find(line, 0, pace)) !== null }, find }
  }
  if (plain) {
    // With -i the pattern and the line are folded first and searched as they are: asked to fold, the engine would
    // start each search over after a refused place, at a cost that grows with the square of the pattern's length.
    const exact = fold ? make(foldText(pattern), { literal: true }) : re
    const wordy = fold ? isFoldedWord : isWord
    let seen: string | null = null
    let hay = ''
    const find = function* (line: string, from: number, pace: Pacer): Task<Span | null> {
      if (line !== seen) {
        hay = fold ? yield* foldLine(line, pace) : line
        seen = line
      }
      for (let at = from; at <= line.length;) {
        const m = yield* pace.finish(exact.search(hay, at))
        if (m === null) return null
        const before = m.start > 0 && wordy(line.charCodeAt(m.start - 1))
        const after = m.end < line.length && wordy(line.charCodeAt(m.end))
        if (!before && !after) return [m.start, m.end]
        at = m.start + 1
      }
      return null
    }
    return { *test(line, pace) { return (yield* find(line, 0, pace)) !== null }, find }
  }
  const outer = make(whole === 'line' ? `^(${pattern})$` : `(^|\\W)(${pattern})(\\W|$)`, { ignoreCase: fold })
  const group = whole === 'line' ? 1 : 2
  return { test: (line, pace) => pace.finish(outer.probe(line)), find: (line, from, pace) => spanOf(pace, outer.search(line, from), group) }
}

// The options

/** What grep was asked to do. */
interface Settings {
  readonly finders: readonly Finder[]
  readonly invert: boolean
  /**
   * What is printed: the selected lines, only their matching parts, a count, the names of files with a selected
   * line or without one, or nothing at all (-q, which also stops at the first one; and -o with -v).
   */
  readonly mode: 'lines' | 'only' | 'count' | 'names' | 'missing' | 'quiet' | 'none'
  readonly numbers: boolean
  readonly names: boolean
  readonly max: number
  readonly after: number
  readonly before: number
  readonly silent: boolean
}

/** The options as read, before they are checked. */
interface Read {
  readonly flags: Set<string>
  readonly values: Map<string, string>
  readonly patterns: string[]
  /** The last of -H and -h given, and the last of -l and -L. */
  names: string
  list: string
  readonly rest: string[]
  bad: string | null
}

/**
 * Reads the options the usual way (`-n`, `-in`, `-e pattern`, `-epattern`, `--` to end them; a lone `-` is a file),
 * keeping every -e, and the order of the letters that undo each other. The options end at the first word that is
 * not one.
 */
function readOptions(argv: readonly string[]): Read {
  const r: Read = { flags: new Set(), values: new Map(), patterns: [], names: '', list: '', rest: [], bad: null }
  let i = 1
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      i++
      break
    }
    if (a.length < 2 || a[0] !== '-') break
    if (a.startsWith('--')) {
      r.bad = `unknown option '${a}'`
      return r
    }
    for (let j = 1; j < a.length; j++) {
      const c = a[j]
      if (VALUED.includes(c)) {
        const value = j + 1 < a.length ? a.slice(j + 1) : argv[++i]
        if (value === undefined) {
          r.bad = `option '-${c}' needs a value`
          return r
        }
        if (c === 'e') r.patterns.push(value)
        else r.values.set(c, value)
        break
      }
      if (!FLAGS.includes(c)) {
        r.bad = `unknown option '-${c}'`
        return r
      }
      r.flags.add(c)
      if (c === 'h' || c === 'H') r.names = c
      if (c === 'l' || c === 'L') r.list = c
    }
  }
  for (; i < argv.length; i++) r.rest.push(argv[i])
  return r
}

// The search

/** A line kept back in case it turns out to come before a selected one (-B). */
interface Held {
  readonly no: number
  readonly bytes: Uint8Array
}

/** What stands in the place of a held line once it is let go, so its bytes are not kept alive until the list is compacted. */
const GONE: Held = Object.freeze({ no: 0, bytes: EMPTY })

class Search implements Pacer {
  private readonly sys: Sys
  private readonly out: Writer
  private readonly s: Settings
  /** Whether any line was selected, in any file. */
  matched = false
  /** Whether a file could not be searched. */
  trouble = false
  /** Whether any line has been printed, so a later group of context is set apart from it by `--`. */
  private printed = false
  /** Work done since the other tasks last had a turn. */
  private work = 0

  constructor(sys: Sys, out: Writer, s: Settings) {
    this.sys = sys
    this.out = out
    this.s = s
  }

  /** Reports a file that could not be searched (unless -s), after the output so far. */
  private *fault(label: string, e: unknown): Task<void> {
    this.trouble = true
    if (this.s.silent) return
    yield* this.out.flush()
    yield* complain(this.sys, 'grep', label, e)
  }

  /** Counts work (and a little for the call itself); gives the other tasks a turn when there has been a lot of it. */
  *charge(work: number): Task<void> {
    this.work += work + 32
    if (this.work >= PACE_WORK) {
      this.work = 0
      yield* this.sys.breathe()
    }
  }

  /**
   * Runs a scan to its answer. Each run is given the work left before the other tasks are due a turn, and the turn is
   * given when that is spent, so however long one search is (a pattern of thousands of instructions over a line of a
   * mebibyte can take minutes), no turn of grep is longer than one slice and Ctrl+C is heard between two.
   */
  *finish<T>(scan: Scan<T>): Task<T> {
    for (;;) {
      const before = scan.steps
      const answer = scan.run(PACE_WORK - this.work)
      yield* this.charge(scan.steps - before)
      if (answer !== undefined) return answer
    }
  }

  private *test(text: string): Task<boolean> {
    for (const f of this.s.finders) if (yield* f.test(text, this)) return true
    return false
  }

  /** The leftmost place any pattern is found from `from` on; of two that start together, the longer. */
  private *find(text: string, from: number): Task<Span | null> {
    let best: Span | null = null
    for (const f of this.s.finders) {
      const at = yield* f.find(text, from, this)
      if (at !== null && (best === null || at[0] < best[0] || (at[0] === best[0] && at[1] > best[1]))) best = at
    }
    return best
  }

  /** What goes before a line: the file's name and the line's number, as asked, each followed by `sep`. */
  private head(label: string, no: number, sep: string): string {
    return (this.s.names ? label + sep : '') + (this.s.numbers ? `${no}${sep}` : '')
  }

  private *emit(label: string, no: number, sep: string, bytes: Uint8Array): Task<void> {
    yield* this.out.line(this.head(label, no, sep), bytes)
    this.printed = true
  }

  /** The parts of a line that match, each on a line of its own; a part with no characters is left out. */
  private *parts(label: string, no: number, text: string): Task<void> {
    for (let from = 0; from <= text.length;) {
      const at = yield* this.find(text, from)
      if (at === null) break
      if (at[1] > at[0]) {
        yield* this.emit(label, no, ':', encode(text.slice(at[0], at[1])))
        from = at[1]
      } else from = at[1] + 1
    }
  }

  /** Searches one open descriptor. True when grep is to stop altogether (-q found a line). */
  *search(fd: number, label: string): Task<boolean> {
    const s = this.s
    const src = new Source(this.sys, fd)
    const context = s.mode === 'lines' && (s.after > 0 || s.before > 0)
    let no = 0
    let selected = 0
    let afterLeft = 0
    /** The number of the last line printed from this file; 0 when none has been. */
    let last = 0
    let held: Held[] = []
    let first = 0
    let heldBytes = 0
    while (selected < s.max) {
      const line = yield* src.next()
      if (line === null) break
      no++
      const text = decode(line)
      yield* this.charge(text.length)
      if ((yield* this.test(text)) === s.invert) {
        if (s.mode !== 'lines') continue
        if (afterLeft > 0) {
          yield* this.emit(label, no, '-', line)
          afterLeft--
          last = no
        } else if (s.before > 0) {
          const copy = line.slice()
          held.push({ no, bytes: copy })
          heldBytes += copy.length
          while (held.length - first > s.before || (heldBytes > HOLD_MAX && first < held.length)) {
            heldBytes -= held[first].bytes.length
            held[first] = GONE
            first++
          }
          if (first >= 1024 && 2 * first >= held.length) {
            held = held.slice(first)
            first = 0
          }
        }
        continue
      }
      selected++
      this.matched = true
      if (s.mode === 'quiet') return true
      if (s.mode === 'names' || s.mode === 'missing') break
      if (s.mode === 'count' || s.mode === 'none') continue
      if (src.binary) {
        yield* this.out.line(`Binary file ${label} matches`)
        return false
      }
      const start = first < held.length ? held[first].no : no
      if (context && this.printed && (last === 0 || start > last + 1)) yield* this.out.line('--')
      for (let i = first; i < held.length; i++) yield* this.emit(label, held[i].no, '-', held[i].bytes)
      held = []
      first = 0
      heldBytes = 0
      if (s.mode === 'only') yield* this.parts(label, no, text)
      else yield* this.emit(label, no, ':', line)
      last = no
      afterLeft = s.after
    }
    // When -m stopped the search, the lines after the last selected one are still printed as its context.
    while (afterLeft > 0) {
      const line = yield* src.next()
      if (line === null) break
      no++
      yield* this.emit(label, no, '-', line)
      afterLeft--
    }
    if (s.mode === 'count') yield* this.out.line(s.names ? `${label}:${selected}` : `${selected}`)
    else if ((s.mode === 'names' && selected > 0) || (s.mode === 'missing' && selected === 0)) yield* this.out.line(label)
    return false
  }

  /** Opens and searches one file; `label` is the name it is shown by. True when grep is to stop altogether. */
  *file(path: string, label: string): Task<boolean> {
    if (path === '-') return yield* this.guarded(0, STDIN)
    let fd: number
    try {
      fd = yield* this.sys.open(path, O_READ)
    } catch (e) {
      if (!(e instanceof OsError)) throw e
      yield* this.fault(label, e)
      return false
    }
    try {
      return yield* this.guarded(fd, label)
    } finally {
      this.sys.close(fd)
    }
  }

  /** Searches a descriptor, reporting a refused read (a closed pipe and a refused write go on up). */
  private *guarded(fd: number, label: string): Task<boolean> {
    try {
      return yield* this.search(fd, label)
    } catch (e) {
      if (!(e instanceof OsError) || e.errno === 'EPIPE') throw e
      yield* this.fault(label, e)
      return false
    }
  }

  /**
   * Searches every file below a directory, in name order, going at most DEPTH directories down. A device found on
   * the way is passed over (one named on the command line is read). `label` is how the directory is shown: '' for
   * the working directory searched when no file was named, whose files are then shown by their names alone.
   */
  *walk(path: string, label: string, depth: number): Task<boolean> {
    let entries: Entry[]
    try {
      entries = yield* this.sys.list(path)
    } catch (e) {
      if (!(e instanceof OsError)) throw e
      yield* this.fault(label === '' ? '.' : label, e)
      return false
    }
    for (const entry of entries) {
      const child = join(path, entry.name)
      const shown = join(label, entry.name)
      if (entry.kind === 'dir') {
        if (depth >= DEPTH) yield* this.fault(shown, 'too deep to search')
        else if (yield* this.walk(child, shown, depth + 1)) return true
      } else if (entry.kind === 'file') {
        if (yield* this.file(child, shown)) return true
      }
    }
    return false
  }

  /** One operand: a file, `-` for the input, or with -r a directory. True when grep is to stop altogether. */
  *operand(path: string, recursive: boolean): Task<boolean> {
    if (recursive && path !== '-') {
      let dir: boolean
      try {
        dir = (yield* this.sys.stat(path)).kind === 'dir'
      } catch (e) {
        if (!(e instanceof OsError)) throw e
        yield* this.fault(path, e)
        return false
      }
      // Outside the try: a closed pipe met on the way down must end grep, not pass for trouble with the directory.
      if (dir) return yield* this.walk(path, path, 0)
    }
    return yield* this.file(path, path)
  }
}

/** A wrong call: what was wrong (when there are words for it), then how to call grep. Status 2. */
function* misuse(sys: Sys, bad: string | null): Task<number> {
  if (bad !== null) yield* complain(sys, 'grep', null, bad)
  return yield* usage(sys, `${USAGE}\n       ${USAGE_E}`)
}

const grep: Program = function* (sys, argv) {
  const r = readOptions(argv)
  if (r.bad !== null) return yield* misuse(sys, r.bad)
  const amounts = new Map<string, number>()
  for (const letter of 'mABC') {
    const text = r.values.get(letter)
    if (text === undefined) continue
    // Each of these is a most: a whole number too large to hold is more than any file has, so it means no limit.
    const n = count(text, 0) ?? (/^[0-9]+$/.test(text) ? Number.MAX_SAFE_INTEGER : null)
    if (n === null) return yield* misuse(sys, `option '-${letter}' needs a whole number, not '${text.length > 40 ? `${text.slice(0, 40)}...` : text}'`)
    amounts.set(letter, n)
  }
  const sources = r.patterns.length > 0 ? r.patterns : r.rest.slice(0, 1)
  if (sources.length === 0) return yield* misuse(sys, null)
  const files = r.patterns.length > 0 ? r.rest : r.rest.slice(1)
  const f = r.flags
  const whole = f.has('x') ? 'line' : f.has('w') ? 'word' : null
  const finders: Finder[] = []
  // Every pattern is made ready before any input is read, with the other tasks given a turn now and then: thousands
  // of patterns can take seconds to make ready, and all of them together are held to PROGRAMS_MAX instructions.
  let laid = 0
  let work = 0
  const make: Maker = (pattern, options) => {
    const re = compile(pattern, options)
    laid += re.size
    work += re.size + 8 * pattern.length + 256
    if (laid > PROGRAMS_MAX) throw new RegexError(`patterns too large in all: more than ${PROGRAMS_MAX} instructions`)
    return re
  }
  try {
    for (const source of sources) {
      for (const pattern of source.split('\n')) {
        finders.push(finder(pattern, f.has('F'), f.has('i'), whole, make))
        if (work >= COMPILE_WORK) {
          work = 0
          yield* sys.breathe()
        }
      }
    }
  } catch (e) {
    if (!(e instanceof RegexError)) throw e
    yield* complain(sys, 'grep', null, e.message)
    return 2
  }
  const recursive = f.has('r')
  const mode = f.has('q') ? 'quiet' : r.list === 'l' ? 'names' : r.list === 'L' ? 'missing' : f.has('c') ? 'count'
    : f.has('o') ? (f.has('v') ? 'none' : 'only') : 'lines'
  const context = amounts.get('C') ?? 0
  const lines = mode === 'lines'
  const settings: Settings = {
    finders,
    invert: f.has('v'),
    mode,
    numbers: f.has('n'),
    names: r.names === 'H' || (r.names === '' && (files.length > 1 || recursive)),
    max: amounts.get('m') ?? Number.POSITIVE_INFINITY,
    after: lines ? amounts.get('A') ?? context : 0,
    before: lines ? amounts.get('B') ?? context : 0,
    silent: f.has('s'),
  }
  const out = new Writer(sys)
  const search = new Search(sys, out, settings)
  try {
    let stopped = false
    if (files.length === 0 && recursive) stopped = yield* search.walk('.', '', 0)
    else {
      for (const path of files.length === 0 ? ['-'] : files) {
        stopped = yield* search.operand(path, recursive)
        if (stopped) break
      }
    }
    yield* out.flush()
    // -q found a line: that is success, whatever happened to the files before it.
    if (stopped) return 0
  } catch (e) {
    if (!(e instanceof Spill)) throw e
    yield* complain(sys, 'grep', 'write error', e.why)
    return 2
  }
  if (search.trouble) return 2
  return search.matched ? 0 : 1
}

/** name -> program */
export const GREP_PROGRAMS: Readonly<Record<string, Program>> = Object.freeze({ grep })

/** name -> manual page text */
export const GREP_MANUAL: Readonly<Record<string, string>> = Object.freeze({
  grep: `NAME
    grep - print the lines of files that match a pattern

USAGE
    ${USAGE}
    ${USAGE_E}

WHAT IT DOES
    Reads each file a line at a time and prints every line the pattern
    is found in. With no file, or for the name -, it reads its input.
    When more than one file is searched, each line it prints starts
    with the name of its file and a colon. A selected line is one the
    pattern is found in, or with -v one it is not found in.

    The pattern is a regular expression: a short way to describe text.
    Most characters stand for themselves. . is any one character; [abc]
    is any one of a, b or c, [a-z] any small letter, and [^abc] any
    character but those; ^ is the start of the line and $ its end. *
    repeats what is before it any number of times (none too), + once or
    more, ? once or not at all, {2} twice and {2,5} two to five times;
    ( ) group, and | separates choices, so (cat|dog)s finds cats and
    dogs. The characters ( ) { } + ? | are special without a backslash;
    a backslash before any special character makes it plain (\\. is a
    full stop). \\w is a letter, digit or underscore, \\s a blank or tab,
    \\d a digit, \\t a tab, \\r a carriage return (which ends each line of
    a file written with two-character line ends), and \\< and \\> the
    start and the end of a word. Several patterns (-e given more than
    once, or one pattern with line feeds in it) select a line when any
    one of them is found in it. An empty pattern is found in every line.

OPTIONS
    -e P    the pattern is P; may be given more than once, and then
            every word after the options is a file
    -E      accepted, and changes nothing: patterns are always the kind
            described above
    -F      the pattern is plain text: no character in it is special
    -i      a small letter and its capital match each other
    -w      only whole words: the characters just before and just after
            what is found are not letters, digits or underscores
    -x      only whole lines (-w is then left aside)
    -v      select the lines the pattern is not found in
    -c      print only how many lines were selected in each file
    -l      print only the names of files with a selected line
    -L      print only the names of files without one
    -q      print nothing, and stop at the first selected line: the
            status says whether there was one
    -m N    stop reading a file after its first N selected lines
    -o      print only the parts of lines that match, each on a line of
            its own; parts with no characters are left out
    -n      put the number of the line before it
    -H      always put the name of the file before a line
    -h      never put the name of the file before a line
    -r      search each directory named and every directory below it;
            with no file named, the directory you are in
    -s      say nothing about files that cannot be read
    -A N    print N lines after each selected line too
    -B N    print N lines before each selected line too
    -C N    print N lines before and after (-A and -B win over it)
    A line printed only as context has - after its name and number
    instead of :, and a line -- stands between groups of lines that
    are not next to each other.

NOTES
    Options go before the pattern: -- ends them, so grep -- -v f looks
    for -v. When -l and -L, or -H and -h, are both given, the last one
    counts; -q wins over -l and -L, which win over -c, which wins over
    -o. With -o, -A, -B and -C do nothing, and -o with -v prints
    nothing. When -m stops a file, the lines after its last selected
    line are still printed as context. Where several patterns are found
    at the same place, -o takes the longest. With -L the status still
    says whether any line was selected.

    Words, classes such as [[:alpha:]], \\w and the start and end of a
    word know only the letters A to Z, small and capital, and the
    digits 0 to 9: any other letter is not part of a word. With -i,
    -w, \\w and the classes also take as letters the three that fold
    into A to Z (the dotless i, the long s and the kelvin sign); the
    start and end of a word still do not. There are no back-references
    (\\1), no patterns read from a file, and no colours. A pattern is at
    most 4096 characters long, and unless -F is given, -w makes it 14
    characters longer and -x 4 longer. The matcher lays a pattern out as
    at most 20000 instructions (a{1000}{1000} is refused as too large),
    and all the patterns given at once as at most 1048576 in all.

    A file whose first 8192 bytes hold a NUL byte is taken as binary:
    instead of its first selected line it prints Binary file NAME
    matches, once, and stops reading it. Before printing anything from
    a file grep reads those 8192 bytes (or the whole file, if shorter);
    from a pipe or the terminal it takes each line as it comes, and a
    NUL that comes later among those bytes marks only what follows it.
    With -r, devices found below a directory are passed over (one named
    is read), and it goes at most 64 directories down. A number given
    to -m, -A, -B or -C that is too large to hold means no limit.
    A line longer than 1048576 bytes
    is taken as several lines. Every line printed ends with a line feed,
    even the last line of a file that had none. With -B, at most 64 MiB
    of lines are kept back. Lines go out as the bytes they came in as,
    but -o prints what it found as text, so there a byte that is not
    UTF-8 comes out as a replacement character.

    A search costs at most the length of the line times the size of the
    pattern, so a very large pattern over a very long line can take a
    while; with -o each part is looked for again from where the last one
    ended, which on a line with many parts can make the work grow with
    the square of the line's length. Either way grep lets the other
    programs run as it goes, and Ctrl+C stops it at once.

STATUS
    0 when a line was selected, 1 when none was, and 2 on trouble: a
    wrong option or pattern, a file or directory that could not be
    searched (a directory without -r counts), or output that could not
    be written. With -q, a selected line gives 0 even when a file could
    not be read.

EXAMPLE
    grep -n -i error notes.txt
`,
})
