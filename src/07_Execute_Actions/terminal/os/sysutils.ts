// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the programs that ask about the system itself, or that run another program in
 * a certain way, as opposed to the ones that work on files or on text: the time and the calendar (date, cal), who
 * and where one is (id, whoami, hostname, uname, pwd), what is running (ps, uptime, dmesg), what a name runs and
 * what the manual says (which, man), the environment (env, printenv), waiting and limits (sleep, timeout, time), and
 * the small answers a script leans on (true, false, test, [). Each is a generator over the kernel's calls and
 * nothing else: the clock is the one the kernel hands out, never one of the host's. Each reports a refusal in the
 * one form (`name: what: why`), lets a closed pipe end it quietly, says so when its own output is refused, and has
 * its manual page beside it.
 * What breaks if it is removed? Nobody at the prompt can ask what time it is, what is running or what a program
 * does, and a script cannot wait, put a limit on a command or run one with a changed environment.
 */
import { decode } from './bytes.ts'
import { evaluate } from './cond.ts'
import { OsError } from './errno.ts'
import { X } from './fs.ts'
import { DEFAULT_PATH } from './kernel.ts'
import type { Program, SpawnOptions, Sys } from './kernel.ts'
import { Lines, MONTHS, WEEKDAYS, civil, complain, count, options, two, usage } from './lib.ts'
import type { Civil } from './lib.ts'
import type { Task } from './task.ts'
import { O_READ } from './vfs.ts'

/** Where the manual pages are kept: a file each, named as the page. */
const MAN_DIR = '/usr/share/man'
/** The shell, for a file that may be run but does not say what runs it. */
const SHELL = '/bin/sh'
/** What `uname` calls the system. */
const SYSTEM_NAME = 'CrimsonNoir'
/** Milliseconds `timeout` sleeps between two looks at its command. */
const POLL_MS = 20
/**
 * Looks `timeout` takes at its command, giving the others a turn between them, before it starts to sleep between
 * them, so a command that ends at once is answered at once. After each sleep it takes one such look again, so a
 * command that wakes at the same moment as `timeout` has its turn before `timeout` sleeps on.
 */
const EAGER = 2
/** The status of `timeout` when the time was up. */
const TIMED_OUT = 124
/** The status when a command was found but could not be started. */
const UNSTARTED = 126
/** The status when a command was not found. */
const UNFOUND = 127
/** A loop that asks nothing of the kernel gives the other tasks a turn once in 1024 of its own: when its count has all of these bits. */
const PACE = 1023

/** A write to the ordinary output that was refused (a full disk, say): the program has nowhere left to answer, and ends. */
class Unwritten {
  readonly why: OsError

  constructor(why: OsError) {
    this.why = why
  }
}

/** A failed write to the ordinary output as it goes on up: a closed pipe as it is (the kernel ends the program quietly), any other refusal as Unwritten. */
const unwritten = (e: unknown): unknown => (e instanceof OsError && e.errno !== 'EPIPE' ? new Unwritten(e) : e)

/** Writes text to the ordinary output. */
function* say(sys: Sys, text: string): Task<void> {
  try {
    yield* sys.print(text)
  } catch (e) {
    throw unwritten(e)
  }
}

/**
 * A program as /bin holds it: the body, with a refused write to its ordinary output reported once, as
 * `name: write error: why`, and ended there with status 1.
 */
function guarded(name: string, body: Program): Program {
  return function* (sys, argv) {
    try {
      return yield* body(sys, argv)
    } catch (e) {
      if (!(e instanceof Unwritten)) throw e
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

/** For a program that takes no argument at all: null when it was given none, the status of the wrong call otherwise. */
function* alone(sys: Sys, argv: readonly string[], name: string): Task<number | null> {
  const o = options(argv, '')
  return o.bad === null && o.rest.length === 0 ? null : yield* misuse(sys, name, o.bad, name)
}

/** A user or a group by name: 0 is root, and nobody else has a name, only the number. */
const nameOf = (id: number): string => (id === 0 ? 'root' : String(id))

/** A text as a listing shows it on one line: a control character would break the line, so each becomes `?`. */
const plain = (text: string): string => text.replace(/[\u0000-\u001f\u007f]/g, '?')

/** The columns a text takes on a line: its characters, not its code units. */
function wide(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0xdc00 || c > 0xdfff) n++
  }
  return n
}

/**
 * Rows as lines of aligned columns, two blanks apart: each column is as wide as its widest cell, the columns named
 * in `right` (numbers) stand against their right edge, and nothing follows the last cell of a line.
 */
function columns(rows: readonly (readonly string[])[], right: ReadonlySet<number> = new Set()): string {
  const widths: number[] = []
  for (const row of rows) row.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, wide(cell)) })
  let text = ''
  for (const row of rows) {
    const cells = row.map((cell, i) => {
      const pad = ' '.repeat(widths[i] - wide(cell))
      return right.has(i) ? pad + cell : cell + pad
    })
    text += `${cells.join('  ').trimEnd()}\n`
  }
  return text
}

/**
 * Milliseconds from a length of time as typed: seconds, with or without a decimal point (`3`, `0.5`, `.5`), and
 * optionally a unit straight after (`s`, `m` for minutes, `h` for hours). Null when the text is none of these.
 */
function duration(text: string): number | null {
  // Digits belong to one side of the point only, so the pattern reads any text once, whatever its length.
  const m = /^([0-9]+(?:\.[0-9]*)?|\.[0-9]+)([smh]?)$/.exec(text)
  if (m === null) return null
  const ms = Number(m[1]) * (m[2] === 'h' ? 3_600_000 : m[2] === 'm' ? 60_000 : 1000)
  return Number.isFinite(ms) ? ms : null
}

// Finding and starting other programs.

/**
 * The file a command name runs: the name itself when it has a slash, else the first match in the directories of
 * `path`; a match is a file the task may run. Null when there is none. The same search the kernel makes.
 */
function* whereis(sys: Sys, name: string, path: string): Task<string | null> {
  const candidates = name.includes('/') ? [name] : path.split(':').map((dir) => `${dir === '' ? '.' : dir}/${name}`)
  for (const candidate of candidates) {
    try {
      if ((yield* sys.stat(candidate)).kind === 'file' && (yield* sys.access(candidate, X))) return candidate
    } catch (e) {
      // Nothing there, or a name no path can hold: the next directory may still have it.
      if (!(e instanceof OsError)) throw e
    }
  }
  return null
}

/**
 * The arguments that run `cmd` as a script of the shell: for a file that may be run but whose first line does not
 * say what runs it, which the shell itself takes for a script of its own. Null when no file answers to the name.
 */
function* asScript(sys: Sys, cmd: readonly string[], path: string): Task<string[] | null> {
  const file = yield* whereis(sys, cmd[0], path)
  return file === null ? null : [SHELL, file, ...cmd.slice(1)]
}

/** Says why a command was not started; the status for it: 127 when it was not found, 126 for any other refusal. */
function* unstarted(sys: Sys, self: string, name: string, e: OsError): Task<number> {
  yield* complain(sys, self, name, e.errno === 'ENOENT' ? 'not found' : e)
  return e.errno === 'ENOENT' ? UNFOUND : UNSTARTED
}

/** Starts a command as a child; its number. A refusal to start it is thrown as it is. */
function* launch(sys: Sys, cmd: readonly string[], opts: SpawnOptions = {}): Task<number> {
  try {
    return yield* sys.spawn(cmd, opts)
  } catch (e) {
    if (!(e instanceof OsError) || e.errno !== 'ENOEXEC') throw e
    const script = yield* asScript(sys, cmd, sys.env.get('PATH') ?? DEFAULT_PATH)
    if (script === null) throw e
    try {
      return yield* sys.spawn(script, opts)
    } catch (e2) {
      // The shell could not be started either: the first refusal is the one about the command.
      if (!(e2 instanceof OsError)) throw e2
      throw e
    }
  }
}

/**
 * Whether this task is still the program that was started with `argv`. The kernel hands a task its new arguments
 * only once the program it is to become has been found, so a refusal caught while they are unchanged is a refusal to
 * start that program, and one caught after is the new program's own.
 */
const unchanged = (sys: Sys, argv: readonly string[]): boolean => sys.ps().some((p) => p.pid === sys.pid && p.argv === argv)

/**
 * Turns this task (started with `argv`) into `cmd`, with `vars` as its environment; the command's status, or the
 * status for a command that could not be started, said on the error output in `self`'s name.
 */
function* become(sys: Sys, self: string, argv: readonly string[], cmd: readonly string[], vars: ReadonlyMap<string, string>): Task<number> {
  try {
    return yield* sys.exec(cmd, vars)
  } catch (e) {
    if (!(e instanceof OsError) || !unchanged(sys, argv)) throw e
    if (e.errno === 'ENOEXEC') {
      const script = yield* asScript(sys, cmd, vars.get('PATH') ?? DEFAULT_PATH)
      if (script !== null) {
        try {
          return yield* sys.exec(script, vars)
        } catch (e2) {
          if (!(e2 instanceof OsError) || !unchanged(sys, argv)) throw e2
        }
      }
    }
    return yield* unstarted(sys, self, cmd[0], e)
  }
}

/**
 * Asks every task of a group to end. Only user 0 may stop a group in one call; anyone else asks its tasks one at a
 * time, and a task it may not stop stays.
 */
function halt(sys: Sys, group: number): void {
  try {
    sys.stopGroup(group)
  } catch (e) {
    if (!(e instanceof OsError)) throw e
    for (const p of sys.ps()) {
      if (p.pgid !== group || p.state === 'end') continue
      try {
        sys.stop(p.pid)
      } catch (e2) {
        if (!(e2 instanceof OsError)) throw e2
      }
    }
  }
}

// true, false, pwd, sleep, test, [

const succeed: Program = function* () {
  return 0
}

const fail: Program = function* () {
  return 1
}

const pwd: Program = function* (sys, argv) {
  const o = options(argv, 'LP')
  if (o.bad !== null || o.rest.length > 0) return yield* misuse(sys, 'pwd', o.bad, 'pwd [-L | -P]')
  yield* say(sys, `${sys.cwd}\n`)
  return 0
}

const sleep: Program = function* (sys, argv) {
  const o = options(argv, '')
  if (o.bad !== null || o.rest.length !== 1) return yield* misuse(sys, 'sleep', o.bad, 'sleep seconds')
  const ms = duration(o.rest[0])
  if (ms === null) return yield* misuse(sys, 'sleep', `'${o.rest[0]}' is not a length of time`, 'sleep seconds')
  yield* sys.sleep(ms)
  return 0
}

/** `test`, or `[` (which wants a closing `]` as its last argument): the shell's own questions, asked by the same code. */
function ask(name: 'test' | '['): Program {
  return function* (sys, argv) {
    let args = argv.slice(1)
    if (name === '[') {
      if (args[args.length - 1] !== ']') {
        yield* sys.eprint("[: missing ']'\n")
        return 2
      }
      args = args.slice(0, -1)
    }
    return yield* evaluate(sys, name, args)
  }
}

// env, printenv

/** An environment as `name=value` lines, sorted by name. */
function listing(vars: ReadonlyMap<string, string>): string {
  let text = ''
  for (const name of [...vars.keys()].sort()) text += `${name}=${vars.get(name) ?? ''}\n`
  return text
}

const env: Program = function* (sys, argv) {
  const o = options(argv, 'i')
  if (o.bad !== null) return yield* misuse(sys, 'env', o.bad, 'env [-i] [name=value ...] [command [argument ...]]')
  const vars = new Map<string, string>(o.flags.has('i') ? [] : sys.env)
  let at = 0
  for (; at < o.rest.length; at++) {
    const word = o.rest[at]
    const cut = word.indexOf('=')
    // A word with no name before its `=` is no setting: it is the command.
    if (cut <= 0) break
    vars.set(word.slice(0, cut), word.slice(cut + 1))
    if ((at & PACE) === PACE) yield* sys.step()
  }
  const cmd = o.rest.slice(at)
  if (cmd.length > 0) return yield* become(sys, 'env', argv, cmd, vars)
  yield* say(sys, listing(vars))
  return 0
}

const printenv: Program = function* (sys, argv) {
  const o = options(argv, '')
  if (o.bad !== null) return yield* misuse(sys, 'printenv', o.bad, 'printenv [name ...]')
  if (o.rest.length === 0) {
    yield* say(sys, listing(sys.env))
    return 0
  }
  let text = ''
  let status = 0
  for (let i = 0; i < o.rest.length; i++) {
    const value = sys.env.get(o.rest[i])
    if (value === undefined) status = 1
    else text += `${value}\n`
    if ((i & PACE) === PACE) yield* sys.step()
  }
  yield* say(sys, text)
  return status
}

// date

/** What `date` prints when no format is given: `Sat Nov 14 18:00:00 UTC 2026`. */
const USUAL_FORMAT = '%a %b %e %H:%M:%S %Z %Y'

/** A year in at least four digits. */
const fourDigits = (year: number): string => (year < 0 ? String(year) : String(year).padStart(4, '0'))

/** What one letter after a `%` stands for at the moment `c` (`ms` since 1970); undefined for a letter that names nothing here. */
function field(letter: string, c: Civil, ms: number): string | undefined {
  switch (letter) {
    case 'Y': return fourDigits(c.year)
    case 'y': return two(((c.year % 100) + 100) % 100)
    case 'm': return two(c.month)
    case 'd': return two(c.day)
    case 'e': return String(c.day).padStart(2)
    case 'j': return String(c.yearDay).padStart(3, '0')
    case 'H': return two(c.hour)
    case 'M': return two(c.minute)
    case 'S': return two(c.second)
    case 's': return String(Math.floor(ms / 1000))
    case 'a': return WEEKDAYS[c.weekday]
    case 'b': return MONTHS[c.month - 1]
    case 'u': return String(c.weekday === 0 ? 7 : c.weekday)
    case 'F': return `${fourDigits(c.year)}-${two(c.month)}-${two(c.day)}`
    case 'T': return `${two(c.hour)}:${two(c.minute)}:${two(c.second)}`
    case 'Z': return 'UTC'
    case 'n': return '\n'
    case 't': return '\t'
    case '%': return '%'
    default: return undefined
  }
}

/** A format with each `%` and its letter replaced, as `text`; or `bad`, the words for a `%` that names nothing. One pass over the format. */
function* formatted(sys: Sys, format: string, ms: number): Task<{ readonly text: string; readonly bad: string | null }> {
  const c = civil(ms)
  let text = ''
  for (let i = 0; i < format.length; i++) {
    if ((i & PACE) === PACE) yield* sys.step()
    if (format[i] !== '%') {
      text += format[i]
      continue
    }
    i++
    if (i >= format.length) return { text, bad: "a '%' at the end of the format names nothing" }
    const value = field(format[i], c, ms)
    // The whole character is named, not half of one that takes two code units.
    if (value === undefined) return { text, bad: `'%${String.fromCodePoint(format.codePointAt(i) ?? 0)}' is not something this program can print` }
    text += value
  }
  return { text, bad: null }
}

const date: Program = function* (sys, argv) {
  const use = 'date [-u] [+format]'
  const o = options(argv, 'u')
  if (o.bad !== null || o.rest.length > 1) return yield* misuse(sys, 'date', o.bad, use)
  const given = o.rest.length === 1 ? o.rest[0] : `+${USUAL_FORMAT}`
  if (!given.startsWith('+')) return yield* misuse(sys, 'date', `'${given}' is not a format: a format starts with +`, use)
  const wall = sys.wall()
  const made = yield* formatted(sys, given.slice(1), Number.isFinite(wall) ? wall : 0)
  if (made.bad !== null) return yield* misuse(sys, 'date', made.bad, use)
  yield* say(sys, `${made.text}\n`)
  return 0
}

// cal

const MONTH_NAMES: readonly string[] = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEK_HEAD = 'Su Mo Tu We Th Fr Sa'
/** The columns one month takes: seven days of two columns, a blank between them. */
const MONTH_WIDTH = 20
/** How many months stand side by side in a year's calendar, and the blanks between two of them. */
const ACROSS = 3
const BETWEEN = 2
/** The years `cal` draws. */
const YEAR_MAX = 9999

const leap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

const daysIn = (year: number, month: number): number => (month === 2 ? (leap(year) ? 29 : 28) : month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31)

/**
 * The weekday (0 a Sunday) of the first day of a month, by today's calendar rules carried back to year 1: the days
 * from the first of January of year 1, which those rules make a Monday, counted in whole years and then whole months.
 */
function firstWeekday(year: number, month: number): number {
  const before = year - 1
  let days = before * 365 + Math.floor(before / 4) - Math.floor(before / 100) + Math.floor(before / 400)
  for (let m = 1; m < month; m++) days += daysIn(year, m)
  return (days + 1) % 7
}

/** A text in the middle of `width` columns (an odd blank goes after it), with nothing after it. */
const centred = (text: string, width: number): string => ' '.repeat(Math.max(0, Math.floor((width - text.length) / 2))) + text

/** The weeks of a month, a line each: the day numbers under their weekdays, Sunday first, nothing after the last day. */
function weeks(year: number, month: number): string[] {
  const lines: string[] = []
  let cells: string[] = []
  for (let i = firstWeekday(year, month); i > 0; i--) cells.push('  ')
  const last = daysIn(year, month)
  for (let day = 1; day <= last; day++) {
    cells.push(String(day).padStart(2))
    if (cells.length === 7) {
      lines.push(cells.join(' '))
      cells = []
    }
  }
  if (cells.length > 0) lines.push(cells.join(' '))
  return lines
}

/** One month under its heading. */
const monthLines = (year: number, month: number, heading: string): string[] => [centred(heading, MONTH_WIDTH), WEEK_HEAD, ...weeks(year, month)]

/** The twelve months of a year, three side by side, under the year. */
function yearLines(year: number): string[] {
  const lines = [centred(String(year), ACROSS * MONTH_WIDTH + (ACROSS - 1) * BETWEEN)]
  for (let first = 1; first <= 12; first += ACROSS) {
    const blocks: string[][] = []
    for (let month = first; month < first + ACROSS; month++) blocks.push(monthLines(year, month, MONTH_NAMES[month - 1]))
    let height = 0
    for (const block of blocks) height = Math.max(height, block.length)
    lines.push('')
    for (let row = 0; row < height; row++) lines.push(blocks.map((block) => (block[row] ?? '').padEnd(MONTH_WIDTH)).join(' '.repeat(BETWEEN)).trimEnd())
  }
  return lines
}

const cal: Program = function* (sys, argv) {
  const use = 'cal [[month] year]'
  const o = options(argv, '')
  if (o.bad !== null || o.rest.length > 2) return yield* misuse(sys, 'cal', o.bad, use)
  let lines: string[]
  if (o.rest.length === 0) {
    const today = civil(sys.wall())
    if (today.year < 1 || today.year > YEAR_MAX) {
      yield* complain(sys, 'cal', null, `the clock says the year ${today.year}, and a calendar is drawn for the years 1 to ${YEAR_MAX} only`)
      return 1
    }
    lines = monthLines(today.year, today.month, `${MONTH_NAMES[today.month - 1]} ${today.year}`)
  } else {
    const yearText = o.rest[o.rest.length - 1]
    const year = count(yearText, 1)
    if (year === null || year > YEAR_MAX) return yield* misuse(sys, 'cal', `'${yearText}' is not a year (1 to ${YEAR_MAX})`, use)
    if (o.rest.length === 1) lines = yearLines(year)
    else {
      const month = count(o.rest[0], 1)
      if (month === null || month > 12) return yield* misuse(sys, 'cal', `'${o.rest[0]}' is not a month (1 to 12)`, use)
      lines = monthLines(year, month, `${MONTH_NAMES[month - 1]} ${year}`)
    }
  }
  yield* say(sys, `${lines.join('\n')}\n`)
  return 0
}

// which, id, whoami, hostname, uname

const which: Program = function* (sys, argv) {
  const o = options(argv, '')
  if (o.bad !== null || o.rest.length === 0) return yield* misuse(sys, 'which', o.bad, 'which name ...')
  const path = sys.env.get('PATH') ?? DEFAULT_PATH
  let status = 0
  for (const name of o.rest) {
    const file = yield* whereis(sys, name, path)
    if (file !== null) yield* say(sys, `${file}\n`)
    else {
      yield* complain(sys, 'which', name, 'not found')
      status = 1
    }
  }
  return status
}

const id: Program = function* (sys, argv) {
  const o = options(argv, 'ugGn')
  const picked = ['u', 'g', 'G'].filter((flag) => o.flags.has(flag))
  if (o.bad !== null || o.rest.length > 0 || picked.length > 1 || (picked.length === 0 && o.flags.has('n'))) return yield* misuse(sys, 'id', o.bad, 'id [-u | -g | -G] [-n]')
  const { uid, gid } = sys.cred
  if (picked.length === 0) {
    const both = (n: number): string => (n === 0 ? '0(root)' : String(n))
    yield* say(sys, `uid=${both(uid)} gid=${both(gid)}\n`)
    return 0
  }
  const n = picked[0] === 'u' ? uid : gid
  yield* say(sys, `${o.flags.has('n') ? nameOf(n) : n}\n`)
  return 0
}

const whoami: Program = function* (sys, argv) {
  const wrong = yield* alone(sys, argv, 'whoami')
  if (wrong !== null) return wrong
  yield* say(sys, `${nameOf(sys.cred.uid)}\n`)
  return 0
}

const hostname: Program = function* (sys, argv) {
  const wrong = yield* alone(sys, argv, 'hostname')
  if (wrong !== null) return wrong
  yield* say(sys, `${sys.hostname}\n`)
  return 0
}

const uname: Program = function* (sys, argv) {
  const o = options(argv, 'asnv')
  if (o.bad !== null || o.rest.length > 0) return yield* misuse(sys, 'uname', o.bad, 'uname [-asnv]')
  const all = o.flags.has('a')
  const words: string[] = []
  let status = 0
  if (all || o.flags.has('s') || o.flags.size === 0) words.push(SYSTEM_NAME)
  if (all || o.flags.has('n')) words.push(sys.hostname)
  if (all || o.flags.has('v')) {
    try {
      // One line, whatever the host wrote there.
      words.push(plain(decode(yield* sys.readFile('/proc/version')).trim()))
    } catch (e) {
      if (!(e instanceof OsError)) throw e
      yield* complain(sys, 'uname', '/proc/version', e)
      status = 1
    }
  }
  if (words.length > 0) yield* say(sys, `${words.join(' ')}\n`)
  return status
}

// uptime, dmesg, ps

/** A length of time in the largest units that fit: `12 sec`, `3 min`, `2 h 5 min`, `1 day 2 h 5 min`. */
function span(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds} sec`
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const parts: string[] = []
  if (days > 0) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`)
  if (hours > 0) parts.push(`${hours} h`)
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes} min`)
  return parts.join(' ')
}

const uptime: Program = function* (sys, argv) {
  const wrong = yield* alone(sys, argv, 'uptime')
  if (wrong !== null) return wrong
  let tasks = 0
  for (const p of sys.ps()) if (p.state !== 'end') tasks++
  yield* say(sys, `up ${span(sys.uptime())}, ${tasks} ${tasks === 1 ? 'task' : 'tasks'}\n`)
  return 0
}

const dmesg: Program = function* (sys, argv) {
  const wrong = yield* alone(sys, argv, 'dmesg')
  if (wrong !== null) return wrong
  let text = ''
  for (const line of sys.dmesg()) text += `${line}\n`
  yield* say(sys, text)
  return 0
}

/** The columns of `ps` that hold numbers, in its short form and in its full form. */
const PS_NUMBERS: ReadonlySet<number> = new Set([0, 1, 3])
const PS_FULL_NUMBERS: ReadonlySet<number> = new Set([0, 1, 2, 5])

const ps: Program = function* (sys, argv) {
  // Every task is always listed, so -e and -A (every task) change nothing; they are taken so `ps -ef` works.
  const o = options(argv, 'feA')
  if (o.bad !== null || o.rest.length > 0) return yield* misuse(sys, 'ps', o.bad, 'ps [-eAf]')
  const full = o.flags.has('f')
  const rows: string[][] = [full ? ['PID', 'PPID', 'GROUP', 'STATE', 'WAITS', 'STEPS', 'DIR', 'COMMAND'] : ['PID', 'PPID', 'STATE', 'STEPS', 'COMMAND']]
  for (const p of sys.ps()) {
    // A task that only gave up its turn is listed by the kernel as waiting for `run`: it is running.
    const state = p.state === 'wait' && p.why === 'run' ? 'run' : p.state
    if (!full) rows.push([String(p.pid), String(p.ppid), state, String(p.steps), plain(p.name)])
    else {
      const command = p.argv.length > 0 ? p.argv.join(' ') : p.name
      rows.push([String(p.pid), String(p.ppid), String(p.pgid), state, state === 'wait' ? p.why : '-', String(p.steps), plain(p.cwd), plain(command)])
    }
  }
  yield* say(sys, columns(rows, full ? PS_FULL_NUMBERS : PS_NUMBERS))
  return 0
}

// man

/** A page's summary: what follows `name - ` on its second line. Empty when the page has no such line or cannot be read. */
function* summaryOf(sys: Sys, name: string): Task<string> {
  let fd: number
  try {
    fd = yield* sys.open(`${MAN_DIR}/${name}`, O_READ)
  } catch (e) {
    if (!(e instanceof OsError)) throw e
    return ''
  }
  try {
    const lines = new Lines(sys, fd)
    const first = yield* lines.next()
    const second = first === null ? null : yield* lines.next()
    if (second === null) return ''
    const cut = second.indexOf(' - ')
    return cut < 0 ? '' : plain(second.slice(cut + 3).trim())
  } catch (e) {
    if (!(e instanceof OsError)) throw e
    return ''
  } finally {
    sys.close(fd)
  }
}

/** Prints one page, a piece at a time. */
function* page(sys: Sys, name: string): Task<number> {
  let fd = -1
  // A page is one name in the manual's directory: a path is no page, whatever it leads to.
  if (name !== '' && name !== '.' && name !== '..' && !name.includes('/')) {
    try {
      fd = yield* sys.open(`${MAN_DIR}/${name}`, O_READ)
    } catch (e) {
      if (!(e instanceof OsError)) throw e
      if (e.errno !== 'ENOENT' && e.errno !== 'EISDIR') {
        yield* complain(sys, 'man', name, e)
        return 1
      }
    }
  }
  if (fd < 0) {
    yield* sys.eprint(`man: no page for ${name}\n`)
    return 1
  }
  try {
    for (;;) {
      let piece: Uint8Array
      try {
        piece = yield* sys.read(fd)
      } catch (e) {
        if (!(e instanceof OsError)) throw e
        yield* complain(sys, 'man', name, e)
        return 1
      }
      if (piece.length === 0) return 0
      try {
        yield* sys.write(1, piece)
      } catch (e) {
        throw unwritten(e)
      }
    }
  } finally {
    sys.close(fd)
  }
}

const man: Program = function* (sys, argv) {
  const o = options(argv, 'k')
  const search = o.flags.has('k')
  if (o.bad !== null || o.rest.length > 1 || (search && o.rest.length === 0)) return yield* misuse(sys, 'man', o.bad, 'man [name]\n       man -k word')
  if (!search && o.rest.length === 1) return yield* page(sys, o.rest[0])
  const word = search ? o.rest[0].toLowerCase() : null
  const rows: string[][] = []
  try {
    for (const entry of yield* sys.list(MAN_DIR)) {
      if (entry.kind !== 'file') continue
      const summary = yield* summaryOf(sys, entry.name)
      if (word === null || entry.name.toLowerCase().includes(word) || summary.toLowerCase().includes(word)) rows.push([plain(entry.name), summary])
    }
  } catch (e) {
    if (!(e instanceof OsError)) throw e
    yield* complain(sys, 'man', MAN_DIR, e)
    return 1
  }
  if (search && rows.length === 0) {
    yield* complain(sys, 'man', null, `nothing about '${o.rest[0]}'`)
    return 1
  }
  yield* say(sys, columns(rows))
  return 0
}

// timeout, time

const timeout: Program = function* (sys, argv) {
  const use = 'timeout seconds command [argument ...]'
  const o = options(argv, '')
  if (o.bad !== null || o.rest.length < 2) return yield* misuse(sys, 'timeout', o.bad, use)
  const limit = duration(o.rest[0])
  if (limit === null) return yield* misuse(sys, 'timeout', `'${o.rest[0]}' is not a length of time`, use)
  const cmd = o.rest.slice(1)
  let pid: number
  try {
    pid = yield* launch(sys, cmd, { group: 'new' })
  } catch (e) {
    if (!(e instanceof OsError)) throw e
    return yield* unstarted(sys, 'timeout', cmd[0], e)
  }
  // The command runs from here on. However this task ends (the command ended, the time was up, or it was itself
  // stopped, which runs only the `finally`), the command is not left behind.
  let running = true
  try {
    if (limit === 0) {
      const status = yield* sys.wait(pid)
      running = false
      return status
    }
    const end = sys.now() + limit
    let eager = EAGER
    for (;;) {
      const status = sys.poll(pid)
      if (status !== 'running') {
        running = false
        // The kernel always knows a child that nobody else has asked about; a failure stands in if it ever does not.
        return status ?? 1
      }
      const left = end - sys.now()
      if (left <= 0) break
      if (eager > 0) {
        eager--
        yield* sys.breathe()
      } else {
        yield* sys.sleep(Math.min(POLL_MS, left))
        eager = 1
      }
    }
    halt(sys, pid)
    yield* sys.wait(pid)
    running = false
    return TIMED_OUT
  } finally {
    if (running) halt(sys, pid)
  }
}

const time: Program = function* (sys, argv) {
  const o = options(argv, '')
  if (o.bad !== null || o.rest.length === 0) return yield* misuse(sys, 'time', o.bad, 'time command [argument ...]')
  const began = sys.now()
  let pid: number
  try {
    pid = yield* launch(sys, o.rest)
  } catch (e) {
    if (!(e instanceof OsError)) throw e
    return yield* unstarted(sys, 'time', o.rest[0], e)
  }
  const status = yield* sys.wait(pid)
  yield* sys.eprint(`real ${((sys.now() - began) / 1000).toFixed(2)}s\n`)
  return status
}

/** Every body by its name, each behind the guard that explains a refused write to the ordinary output. */
function table(bodies: Readonly<Record<string, Program>>): Readonly<Record<string, Program>> {
  const out: Record<string, Program> = {}
  for (const name of Object.keys(bodies)) out[name] = guarded(name, bodies[name])
  return Object.freeze(out)
}

/** name -> program */
export const SYS_PROGRAMS: Readonly<Record<string, Program>> = table({
  true: succeed, false: fail, pwd, sleep, test: ask('test'), '[': ask('['), env, printenv, date, cal, which, id, whoami, hostname, uname, uptime, dmesg, ps,
  man, timeout, time,
})

/** The note on the page of each program the shell also answers by itself. */
const SHELL_ALSO = (name: string, example: string): string => `The shell answers ${name} itself when you type it. This file is what
    another program starts when it is told to run ${name} (${example}).`

/** name -> manual page text */
export const SYS_MANUAL: Readonly<Record<string, string>> = Object.freeze({
  true: `NAME
    true - do nothing, and succeed

USAGE
    true

WHAT IT DOES
    Ends at once with status 0, the status that means "it worked". It
    reads nothing, prints nothing and takes no notice of its arguments.
    It stands where a command is wanted but nothing needs doing, such as
    the question of a loop that should go round for ever.

NOTES
    ${SHELL_ALSO('true', 'env true')}

STATUS
    Always 0.

EXAMPLE
    true && echo yes
`,
  false: `NAME
    false - do nothing, and fail

USAGE
    false

WHAT IT DOES
    Ends at once with status 1, a status that means "it did not work".
    It reads nothing, prints nothing and takes no notice of its
    arguments.

NOTES
    ${SHELL_ALSO('false', 'env false')}

STATUS
    Always 1.

EXAMPLE
    false || echo no
`,
  pwd: `NAME
    pwd - print the directory you are in

USAGE
    pwd [-L | -P]

WHAT IT DOES
    Prints the full path of the working directory: the place where a
    name with no / in front of it is looked for. cd, a command of the
    shell, takes you to another one.

OPTIONS
    -L, -P  accepted for scripts that give them. They change nothing,
            because a directory here has exactly one path.

NOTES
    ${SHELL_ALSO('pwd', 'env pwd')}

STATUS
    0, or 2 for a wrong call.

EXAMPLE
    pwd
`,
  sleep: `NAME
    sleep - wait for a length of time

USAGE
    sleep seconds

WHAT IT DOES
    Does nothing for the given number of seconds, then ends. The number
    may have a decimal point (0.5 is half a second). A letter straight
    after it changes the unit: s for seconds, m for minutes, h for
    hours, so sleep 2m waits two minutes.

NOTES
    Exactly one length is taken: sleep 1m 30s is refused, not added up.
    Ctrl+C ends the wait early.

STATUS
    0 when the time has passed, or 2 for a wrong call.

EXAMPLE
    sleep 1.5; echo done
`,
  test: `NAME
    test - ask a question about files, text or numbers

USAGE
    test [expression]

WHAT IT DOES
    Answers a yes-or-no question by its status and prints nothing: 0 is
    yes, 1 is no. That status is what if and while in the shell look at.
    With no expression the answer is no. A single word asks whether that
    word is not empty.

    -e path       there is something at the path
    -f path       it is an ordinary file
    -d path       it is a directory
    -s path       it holds at least one byte
    -r path       you may read it
    -w path       you may change it
    -x path       you may run it (for a directory: look inside it)
    -z text       the text is empty
    -n text       the text is not empty
    -t number     that descriptor is the terminal (0 is the input)
    a = b         the two texts are the same (== means the same)
    a != b        the two texts differ
    a -eq b       the whole numbers are equal. Also -ne (not equal),
                  -lt (less), -le (less or equal), -gt (greater) and
                  -ge (greater or equal)
    a -nt b       file a was changed later than file b, or b is not
                  there; a -ot b asks the reverse
    ! question    the opposite answer
    q1 -a q2      both are true
    q1 -o q2      at least one is true
    ( question )  groups questions; type the brackets as \\( and \\)

NOTES
    Every word and sign is an argument of its own, with blanks around
    it. Put a variable in double quotes ("$name") so that an empty one
    still counts as a word. There are no questions about owners or
    about kinds of device.
    ${SHELL_ALSO('test', 'env test -d /tmp')}

STATUS
    0 for yes, 1 for no, 2 when the question cannot be read (why is
    said on the error output).

EXAMPLE
    test -d /tmp && echo yes
`,
  '[': `NAME
    [ - ask a question about files, text or numbers, written in brackets

USAGE
    [ expression ]

WHAT IT DOES
    The same program as test under another name, so that a question
    reads like one: [ -f notes ] asks what test -f notes asks. The last
    argument must be a ] standing alone, and there must be a blank after
    the [ and before the ]. The page of test lists the questions.

NOTES
    ${SHELL_ALSO('[', 'env [ -d /tmp ]')}

STATUS
    0 for yes, 1 for no, 2 when the question cannot be read or the
    closing ] is missing (why is said on the error output).

EXAMPLE
    [ "$HOME" = /home/operator ] && echo home
`,
  env: `NAME
    env - show the environment, or run a command with a changed one

USAGE
    env [-i] [name=value ...] [command [argument ...]]

WHAT IT DOES
    The environment is a list of named values (HOME, PATH and so on)
    that every program is handed when it starts. With no command, env
    prints the list, one name=value to a line, sorted by name (capital
    letters come before small ones). With a command, it runs the command
    with the given values added or replaced. Nothing changes for the
    shell you typed it in.

OPTIONS
    -i      start from an empty environment, not from the present one

NOTES
    The first argument that does not have the form name=value is the
    command, and everything after it belongs to the command. The
    command is looked for in the directories of the PATH it is given.
    env turns into the command (it does not wait beside it), so the
    status is the command's own. Only a program kept as a file can be
    run this way: not a command the shell carries out itself, such as
    cd, and not a command of the city.

STATUS
    With no command: 0. With one: the command's own status, 126 when it
    was found but could not be started, 127 when it was not found. 2
    for a wrong call.

EXAMPLE
    env GREETING=hello printenv GREETING
`,
  printenv: `NAME
    printenv - print the values of environment variables

USAGE
    printenv [name ...]

WHAT IT DOES
    The environment is a list of named values (HOME, PATH and so on)
    that every program is handed when it starts. printenv prints the
    value of each name given, one to a line, without the name. With no
    name it prints the whole list as name=value lines, sorted by name,
    exactly as env does.

NOTES
    It shows what this program was handed. A variable set in the shell
    but not exported is not in the environment: export it first.

STATUS
    0, or 1 when a name is not set (nothing is printed for it), or 2
    for a wrong call.

EXAMPLE
    printenv HOME
`,
  date: `NAME
    date - print the day and the time

USAGE
    date [-u] [+format]

WHAT IT DOES
    Prints the present moment, like this: Sat Nov 14 18:00:00 UTC 2026.
    The time is always UTC, the clock the whole world shares, with no
    summer time: this system keeps no time zone. An argument that
    starts with + is a format. Its text is printed as it stands, with
    each % and the letter after it replaced:

    %Y  the year (2026)           %y  its last two digits (26)
    %m  the month (01 to 12)      %b  its short name (Nov)
    %d  the day (01 to 31)        %e  the day, a blank for the 0 ( 1)
    %a  the weekday (Sat)         %u  its number (1 Monday, 7 Sunday)
    %j  the day of the year (001 to 366)
    %H  the hour (00 to 23)       %M  the minute      %S  the second
    %F  the same as %Y-%m-%d      %T  the same as %H:%M:%S
    %s  the seconds since the start of 1970
    %Z  the time zone, which is always UTC
    %n  a line end      %t  a tab      %%  a % sign

OPTIONS
    -u      accepted and changes nothing: the time is always UTC

NOTES
    It cannot set the clock. Any other letter after a % is refused, not
    printed wrongly, and there are no full names of days or months.

STATUS
    0, or 2 for a wrong call or a format it cannot print.

EXAMPLE
    date +%F
`,
  cal: `NAME
    cal - print a calendar

USAGE
    cal [[month] year]

WHAT IT DOES
    With no argument, prints this month as a small table, a week to a
    line, Sunday first. With a year, prints all twelve months of that
    year, three side by side. With a month (1 to 12) and a year, prints
    that one month. The year is 1 to 9999 and is taken as written:
    cal 26 is the year 26, not 2026.

NOTES
    Today is not marked. "This month" is the month it is in UTC. Every
    year is laid out by the calendar rules in use today, also the years
    before those rules were adopted, so a month long ago may differ from
    the calendar people kept then. The month is a number, not a name.

STATUS
    0, or 2 for a wrong call.

EXAMPLE
    cal 11 2026
`,
  which: `NAME
    which - show the file a command name runs

USAGE
    which name ...

WHAT IT DOES
    For each name, prints the path of the program that would run: the
    first file of that name that you may run in the directories listed
    in PATH (a list of directories with : between them), in order. A
    name with a / in it is not searched for: it is checked as the path
    it is.

NOTES
    It knows only programs kept as files. A command the shell carries
    out itself (cd, for one) or a command of the city is found only if
    there happens to be a file of that name as well. type name, a
    command of the shell, says what the shell would really run.

STATUS
    0 when every name was found, 1 when one was not (it is named on the
    error output), 2 for a wrong call.

EXAMPLE
    which man
`,
  id: `NAME
    id - print who you are, as numbers and names

USAGE
    id [-u | -g | -G] [-n]

WHAT IT DOES
    Every task runs as a user, and every user is in a group. Both are
    numbers, and each file remembers the numbers of its owner. With no
    option, id prints the two with their names: uid=0(root) gid=0(root)
    is the person at the console, user 0, called root, who may read and
    change everything.

OPTIONS
    -u      only the number of the user
    -g      only the number of the group
    -G      every group the user is in: here always the one group
    -n      with -u, -g or -G: the name, not the number

NOTES
    Only user 0 and group 0 have a name (root). For anyone else the
    number is printed, also where the name was asked for. It tells
    about the task that runs it, not about any other user.

STATUS
    0, or 2 for a wrong call.

EXAMPLE
    id -un
`,
  whoami: `NAME
    whoami - print the name of the user you are

USAGE
    whoami

WHAT IT DOES
    Prints the name of the user this task runs as: root for the person
    at the console (user 0). The same as id -un.

NOTES
    Only user 0 has a name. For anyone else the number is printed.

STATUS
    0, or 2 for a wrong call.

EXAMPLE
    whoami
`,
  hostname: `NAME
    hostname - print the name of this system

USAGE
    hostname

WHAT IT DOES
    Prints the name this system was given when it started.

NOTES
    It only prints. The name cannot be changed from here, and a new one
    given as an argument is refused.

STATUS
    0, or 2 for a wrong call.

EXAMPLE
    hostname
`,
  uname: `NAME
    uname - print the name and the version of the system

USAGE
    uname [-asnv]

WHAT IT DOES
    With no option, prints the name of the operating system, which is
    CrimsonNoir. The options choose other facts. Those chosen are
    printed on one line with a blank between them, always in the order
    system, host, version.

OPTIONS
    -s      the name of the system (what no option at all prints)
    -n      the name of this host, as hostname prints it
    -v      the version, as the file /proc/version holds it
    -a      all three

NOTES
    There is no -r (release) and no -m (machine): this system has no
    release number apart from its version, and it is not built for one
    kind of machine.

STATUS
    0, or 1 when the version could not be read, or 2 for a wrong call.

EXAMPLE
    uname -a
`,
  uptime: `NAME
    uptime - print how long the system has been running

USAGE
    uptime

WHAT IT DOES
    Prints one line: the time since the system started, and how many
    tasks (running programs) there are now, this one among them. For
    example: up 3 min, 4 tasks. Under a minute the time is in seconds
    (up 12 sec), then in minutes, then in hours and minutes (up 2 h 5
    min), then with days in front (up 1 day 2 h 5 min).

NOTES
    The line has no time of day, no count of users and no figures for
    how busy the system is.

STATUS
    0, or 2 for a wrong call.

EXAMPLE
    uptime
`,
  dmesg: `NAME
    dmesg - print the kernel's own log

USAGE
    dmesg

WHAT IT DOES
    The kernel is the part of the system that runs the tasks. It keeps
    a short log of what went wrong beneath the programs, such as a task
    that broke or a saved disk that could not be read. dmesg prints
    that log, oldest line first. The number in brackets is when the
    line was written, in seconds since the system started.

NOTES
    Only the newest 200 lines are kept. An empty log prints nothing.
    The log cannot be cleared from here.

STATUS
    0, or 2 for a wrong call.

EXAMPLE
    dmesg
`,
  ps: `NAME
    ps - list the tasks

USAGE
    ps [-eAf]

WHAT IT DOES
    A task is a program that is running. ps prints a line for each one,
    under a heading:

    PID      the number of the task
    PPID     the number of the task that started it (its parent)
    STATE    run (it can go on), wait (it waits for something) or end
             (it has ended and its parent has not yet asked how)
    STEPS    how many times it has called on the kernel so far: a
             rough measure of the work it has done
    COMMAND  the name of the program

OPTIONS
    -f      the full form. COMMAND shows the arguments too, and there
            are three more columns: GROUP, the number of the group of
            tasks it is in (Ctrl+C stops a whole group); WAITS, what a
            waiting task waits for; DIR, its working directory.
    -e, -A  every task. Taken for scripts that give them; they change
            nothing, because every task is always listed.

NOTES
    WAITS is sleep (the clock), wait (a task it started), tty (a line
    typed at the terminal), pipe (the other end of a pipe), io (a
    drive that has not answered) or city (a command of the city), and
    - for a task that is not waiting. Every task is listed: there is
    no choosing by user or by terminal, and there are no columns for
    memory or for time.

STATUS
    0, or 2 for a wrong call.

EXAMPLE
    ps -f
`,
  man: `NAME
    man - read the manual

USAGE
    man [name]
    man -k word

WHAT IT DOES
    Every program has a page that says what it does. man name prints
    the page of that name. man alone lists every page with its one-line
    summary, sorted by name. man -k word lists only the pages whose
    name or summary holds the word, in capitals or small letters alike.

OPTIONS
    -k word  search the names and the summaries for the word

NOTES
    A page is printed whole: there is no stopping after each screenful.
    The search reads the names and the summaries only, not the text of
    the pages. The pages are the files in /usr/share/man.

STATUS
    0, or 1 when there is no such page or nothing holds the word (this
    is said on the error output), or 2 for a wrong call.

EXAMPLE
    man -k calendar
`,
  timeout: `NAME
    timeout - run a command, and stop it if it takes too long

USAGE
    timeout seconds command [argument ...]

WHAT IT DOES
    Starts the command and waits for it. If the command is still
    running when the given number of seconds has passed, it is stopped,
    and timeout ends with status 124. The number may have a decimal
    point, and a letter straight after it changes the unit: s for
    seconds, m for minutes, h for hours. A time of 0 sets no limit.

NOTES
    The command runs in a group of tasks of its own, and the tasks it
    starts are stopped with it. A job it puts in the background with &
    leaves that group and is not stopped. The command cannot read what
    you type: unless its input comes from a file or a pipe, that input
    ends at once. Ctrl+C stops timeout and the command with it. A
    command that ends in time may be noticed up to a fiftieth of a
    second late. Only a program kept as a file can be run this way:
    not a command the shell carries out itself, and not a command of
    the city. There are no options: you cannot choose how the command
    is stopped, and there is no second, firmer stop later. A stopped
    command always ends on its next turn.

STATUS
    The command's own status when it ended in time. 124 when it was
    stopped. 126 when it was found but could not be started, 127 when
    it was not found. 2 for a wrong call.

EXAMPLE
    timeout 2 sleep 10; echo $?
`,
  time: `NAME
    time - run a command and say how long it took

USAGE
    time command [argument ...]

WHAT IT DOES
    Runs the command, waits for it to end, and then prints one line
    such as real 0.25s: the seconds that passed on the clock from its
    start to its end. The line goes to the error output, so it does not
    mix with what the command sends into a pipe or a file.

NOTES
    Only the time that passed is measured: there is no separate figure
    for the work the command itself did. Only a program kept as a file
    can be timed, not a command the shell carries out itself or a
    command of the city, and not a whole pipeline: time a | b times
    only a. There are no options, so -p is refused.

STATUS
    The command's own status. 126 when it was found but could not be
    started, 127 when it was not found (no time is printed then). 2
    for a wrong call.

EXAMPLE
    time sleep 1
`,
})
