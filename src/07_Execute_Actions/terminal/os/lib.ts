// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is what every program in /bin shares, so each one is only its own work: reading a
 * descriptor a line at a time (UTF-8 put back together across reads), writing text through a buffer instead of a
 * call per line, reading options the usual way (`-n 5`, `-abc`, `--`), running a body over each named file or the
 * ordinary input, and reporting a refusal in the one form every program uses (`name: what: why`).
 * What breaks if it is removed? Each program would carry its own copy of these, and they would drift apart.
 */
import { encode } from './bytes.ts'
import { OsError, reasonOf } from './errno.ts'
import type { Sys } from './kernel.ts'
import type { Task } from './task.ts'
import { O_READ } from './vfs.ts'

/** The longest line `Lines` hands back whole: a longer one is cut there (and the rest follows as a next line). */
export const LINE_BYTES_MAX = 1 << 20

/** Reads a descriptor a line at a time. */
export class Lines {
  private readonly sys: Sys
  private readonly fd: number
  private readonly decoder = new TextDecoder('utf-8')
  private buffer = ''
  private at = 0
  private ended = false

  constructor(sys: Sys, fd: number) {
    this.sys = sys
    this.fd = fd
  }

  /** The next line without its line end (a carriage return before it is kept); null at the end of the input. */
  *next(): Task<string | null> {
    for (;;) {
      const end = this.buffer.indexOf('\n', this.at)
      if (end >= 0) {
        const line = this.buffer.slice(this.at, end)
        this.at = end + 1
        return line
      }
      if (this.ended) {
        if (this.at >= this.buffer.length) return null
        const line = this.buffer.slice(this.at)
        this.at = this.buffer.length
        return line
      }
      if (this.buffer.length - this.at > LINE_BYTES_MAX) {
        const line = this.buffer.slice(this.at, this.at + LINE_BYTES_MAX)
        this.at += LINE_BYTES_MAX
        return line
      }
      // Drop what was already handed out before reading more.
      if (this.at > 0) { this.buffer = this.buffer.slice(this.at); this.at = 0 }
      const chunk = yield* this.sys.read(this.fd)
      if (chunk.length === 0) {
        this.ended = true
        this.buffer += this.decoder.decode()
      } else this.buffer += this.decoder.decode(chunk, { stream: true })
    }
  }
}

/** Buffered text for a descriptor: written through when the buffer fills, and by `flush`. */
export class Out {
  private readonly sys: Sys
  private readonly fd: number
  private parts: string[] = []
  private size = 0

  constructor(sys: Sys, fd = 1) {
    this.sys = sys
    this.fd = fd
  }

  *put(text: string): Task<void> {
    if (text === '') return
    this.parts.push(text)
    this.size += text.length
    if (this.size >= 8192) yield* this.flush()
  }

  *line(text: string): Task<void> {
    yield* this.put(`${text}\n`)
  }

  *bytes(data: Uint8Array): Task<void> {
    yield* this.flush()
    if (data.length > 0) yield* this.sys.write(this.fd, data)
  }

  *flush(): Task<void> {
    if (this.size === 0) return
    const text = this.parts.join('')
    this.parts = []
    this.size = 0
    yield* this.sys.write(this.fd, encode(text))
  }
}

/** What `options` found. */
export interface Parsed {
  /** Every flag given, by its letter (or its long name without the dashes). */
  readonly flags: ReadonlySet<string>
  /** The value of each option that takes one (the last, when given twice). */
  readonly values: ReadonlyMap<string, string>
  /** The arguments that are not options. */
  readonly rest: readonly string[]
  /** What was wrong, or null: an unknown option, or one that needs a value and has none. */
  readonly bad: string | null
}

/**
 * Reads options from a program's arguments (`argv[0]` is skipped). `flags` lists the letters that stand alone and
 * `valued` those that take a value (`-n 5` or `-n5`); letters may be joined (`-la`); `--` ends the options; a lone
 * `-` is an argument. `long` lists whole words accepted as `--word`; a long option takes no value.
 */
export function options(argv: readonly string[], flags: string, valued = '', long: readonly string[] = []): Parsed {
  const found = new Set<string>()
  const values = new Map<string, string>()
  const rest: string[] = []
  let bad: string | null = null
  let i = 1
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { i++; break }
    if (a.length < 2 || a[0] !== '-') break
    if (a.startsWith('--')) {
      const word = a.slice(2)
      if (!long.includes(word)) { bad = `unknown option '${a}'`; break }
      found.add(word)
      continue
    }
    let stop = false
    for (let j = 1; j < a.length; j++) {
      const c = a[j]
      if (valued.includes(c)) {
        const value = j + 1 < a.length ? a.slice(j + 1) : argv[++i]
        if (value === undefined) { bad = `option '-${c}' needs a value`; stop = true; break }
        values.set(c, value)
        found.add(c)
        break
      }
      if (!flags.includes(c)) { bad = `unknown option '-${c}'`; stop = true; break }
      found.add(c)
    }
    if (stop) break
  }
  for (; i < argv.length; i++) rest.push(argv[i])
  return { flags: found, values, rest, bad }
}

/** Writes `name: what: why` (or `name: why`) to the error output. */
export function* complain(sys: Sys, name: string, what: string | null, e: unknown): Task<void> {
  const why = typeof e === 'string' ? e : reasonOf(e)
  yield* sys.eprint(what === null ? `${name}: ${why}\n` : `${name}: ${what}: ${why}\n`)
}

/** Writes a usage line to the error output and gives the status for a wrong call (2). */
export function* usage(sys: Sys, text: string): Task<number> {
  yield* sys.eprint(`usage: ${text}\n`)
  return 2
}

/**
 * Runs `body` over each named file, opened to read, or over the ordinary input when no file is named or the name is
 * `-`. A file that cannot be opened is reported and skipped. The status: 0, or 1 when any file was skipped; a
 * refusal inside `body` (other than a closed pipe, which ends the program quietly) is reported and counts too.
 */
export function* inputs(sys: Sys, name: string, paths: readonly string[], body: (fd: number, label: string) => Task<void>): Task<number> {
  let status = 0
  for (const path of paths.length === 0 ? ['-'] : paths) {
    let fd = 0
    if (path !== '-') {
      try {
        fd = yield* sys.open(path, O_READ)
      } catch (e) {
        if (!(e instanceof OsError)) throw e
        yield* complain(sys, name, path, e)
        status = 1
        continue
      }
    }
    try {
      yield* body(fd, path === '-' ? '(standard input)' : path)
    } catch (e) {
      if (!(e instanceof OsError) || e.errno === 'EPIPE') throw e
      yield* complain(sys, name, path === '-' ? null : path, e)
      status = 1
    } finally {
      if (path !== '-') sys.close(fd)
    }
  }
  return status
}

/** A whole number from an option's text, at least `least`; null when it is not one. */
export function count(text: string | undefined, least = 0): number | null {
  if (text === undefined || !/^[0-9]+$/.test(text)) return null
  const n = Number(text)
  return Number.isSafeInteger(n) && n >= least ? n : null
}

/** A moment as the calendar writes it, in UTC (the console keeps no time zone). `month` and `day` count from 1; `weekday` from 0, a Sunday. */
export interface Civil {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
  readonly weekday: number
  /** The day of the year, from 1. */
  readonly yearDay: number
}

/** Milliseconds since 1970 as a calendar moment in UTC: plain arithmetic over days, with no clock and no locale. */
export function civil(ms: number): Civil {
  const total = Math.floor((Number.isFinite(ms) ? ms : 0) / 1000)
  const days = Math.floor(total / 86400)
  const rest = total - days * 86400
  // Days since 1970-01-01 to a year, month and day: the 400-year cycle of the calendar, counted from a 1 March.
  const z = days + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp < 10 ? mp + 3 : mp - 9
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0)
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const before = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334][month - 1] + (leap && month > 2 ? 1 : 0)
  return {
    year, month, day,
    hour: Math.floor(rest / 3600), minute: Math.floor((rest % 3600) / 60), second: rest % 60,
    weekday: (((days + 4) % 7) + 7) % 7,
    yearDay: before + day,
  }
}

export const MONTHS: readonly string[] = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])
export const WEEKDAYS: readonly string[] = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])

/** Two digits, zero-padded. */
export function two(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** A time as `ls -l` and `stat` show it: `2026-11-14 18:31`. */
export function stamp(ms: number): string {
  const c = civil(ms)
  return `${c.year}-${two(c.month)}-${two(c.day)} ${two(c.hour)}:${two(c.minute)}`
}

/** A size for people: 512, 1.5K, 20M, 3.2G (powers of 1024). */
export function human(bytes: number): string {
  if (bytes < 1024) return String(bytes)
  const units = ['K', 'M', 'G', 'T']
  let v = bytes / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++ }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}${units[u]}`
}
