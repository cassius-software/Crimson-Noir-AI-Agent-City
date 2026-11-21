// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the programs a person uses on the file tree itself: listing a directory (ls,
 * tree), showing a file (cat), making and removing (mkdir, rmdir, rm, touch), copying and moving (cp, mv), changing
 * permissions (chmod), asking what a path is (stat, realpath, basename, dirname), searching (find), adding up sizes
 * (du, df) and showing what is mounted where (mount, umount). Each is a generator over the kernel's calls and nothing
 * else. Each reports a refusal as `name: what: why`, carries on with its next operand, lets a closed pipe end it
 * quietly, says so and ends when its own output is refused (a full disk), copies in pieces instead of holding a file
 * whole, and walks no deeper than the file system can hold. Each has its manual page beside it.
 * What breaks if it is removed? The console has a file system nobody can look at or change from the prompt: only
 * the shell's own redirection is left.
 */
import { OsError, refuse } from './errno.ts'
import type { Entry, Kind } from './fs.ts'
import { W, X, modeText } from './fs.ts'
import type { MountInfo, Program, Sys } from './kernel.ts'
import { Out, civil, complain, count, human, inputs, options, stamp, two, usage } from './lib.ts'
import { basename as lastName, dirname as parentOf, join, matches } from './path.ts'
import { MOUNT_POINTS } from './system.ts'
import type { Task } from './task.ts'
import type { FileStat } from './vfs.ts'
import { O_CREATE, O_READ, O_TRUNC, O_WRITE, STICKY } from './vfs.ts'

/** How many directories below its start any walk here goes: the file system holds no path deeper than this. */
const DEPTH = 64
/** The widest a listing laid out in columns may be. */
const COLUMNS = 80
/** Blanks between two columns of a listing. */
const GAP = 2
/** Bytes copied at a time. */
const PIECE = 65536
/** How deep the parentheses and negations of a `find` expression may nest. */
const NESTING = 64
/** A loop that asks nothing of the kernel gives the other tasks a turn once in 1024 of its own: when its count has none of these bits. */
const PACE = 1023

/** Whether a refusal says there is nothing at the path. */
const missing = (e: unknown): boolean => e instanceof OsError && (e.errno === 'ENOENT' || e.errno === 'ENOTDIR')

/** The mode as a listing writes it, the sticky bit shown in the last place (`t`, or `T` where the others may not search). */
function modeString(kind: Kind, mode: number): string {
  const text = modeText(kind, mode)
  if ((mode & STICKY) === 0) return text
  return text.slice(0, -1) + ((mode & 1) !== 0 ? 't' : 'T')
}

/** The owner as a listing names it: user 0 is the person at the console, anyone else a number. */
const ownerName = (uid: number): string => (uid === 0 ? 'root' : String(uid))

/** The columns a text takes on a line: its characters (code points), not its code units. */
function widthOf(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0xdc00 || c > 0xdfff) n++
  }
  return n
}

/** A write to the ordinary output that was refused (a full disk, say): the program has nowhere left to answer, and ends. */
class Unwritten {
  readonly why: OsError

  constructor(why: OsError) {
    this.why = why
  }
}

/**
 * What a failed write to the ordinary output goes on up as: a closed pipe as it is (the kernel then ends the program
 * quietly), any other refusal as Unwritten, so that no caller takes it for a refusal of the path it was working on.
 */
const unwritten = (e: unknown): unknown => (e instanceof OsError && e.errno !== 'EPIPE' ? new Unwritten(e) : e)

/** The ordinary output, buffered: lib's writer, with a refused write told apart from every other refusal. */
class Sink {
  private readonly out: Out

  constructor(sys: Sys) {
    this.out = new Out(sys)
  }

  *put(text: string): Task<void> {
    try {
      yield* this.out.put(text)
    } catch (e) {
      throw unwritten(e)
    }
  }

  *line(text: string): Task<void> {
    yield* this.put(`${text}\n`)
  }

  *flush(): Task<void> {
    try {
      yield* this.out.flush()
    } catch (e) {
      throw unwritten(e)
    }
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

/** What one run of a program carries: the kernel's calls, its name, its buffered output, and whether anything failed. */
class Run {
  readonly sys: Sys
  readonly name: string
  readonly out: Sink
  status = 0

  constructor(sys: Sys, name: string) {
    this.sys = sys
    this.name = name
    this.out = new Sink(sys)
  }

  /**
   * Reports `name: what: why` and remembers the failure. `why` is a refusal or plain words; anything else (a closed
   * pipe, a refused write to the output) is not about `what` and goes on up.
   */
  *fail(what: string | null, why: unknown): Task<void> {
    if (typeof why !== 'string' && (!(why instanceof OsError) || why.errno === 'EPIPE')) throw why
    this.status = 1
    yield* this.out.flush()
    yield* complain(this.sys, this.name, what, why)
  }

  /** A wrong call: says what was wrong (when there are words for it), then how to call the program. Status 2. */
  *misuse(bad: string | null, text: string): Task<number> {
    yield* this.out.flush()
    if (bad !== null) yield* complain(this.sys, this.name, null, bad)
    return yield* usage(this.sys, text)
  }

  /** Writes what is still buffered; the status to return. */
  *end(): Task<number> {
    yield* this.out.flush()
    return this.status
  }
}

// ls

/** One line of a listing. */
interface Item {
  readonly name: string
  readonly kind: Kind
  /** What `stat` said; null when the listing needed only the name. */
  readonly st: FileStat | null
}

/**
 * The names laid out in columns no wider than `width`, filled down and then across, as lines. The names are split
 * evenly over as many columns as fit. Each try is one pass over the names, and the tries are bounded: no more columns
 * are tried than the shortest name would fit across the line. A name wider than the line leaves one column, a name
 * to a line.
 */
function* layout(sys: Sys, names: readonly string[], width: number): Task<string[]> {
  const n = names.length
  if (n === 0) return []
  const lens: number[] = []
  let shortest = width
  for (const name of names) {
    const len = widthOf(name)
    lens.push(len)
    if (len < shortest) shortest = len
    if ((lens.length & PACE) === 0) yield* sys.step()
  }
  const most = Math.max(1, Math.min(n, Math.floor((width + GAP) / (shortest + GAP))))
  for (let cols = most; ; cols--) {
    yield* sys.step()
    const rows = Math.ceil(n / cols)
    const used = Math.ceil(n / rows)
    const widths: number[] = []
    let total = GAP * (used - 1)
    for (let c = 0; c < used; c++) {
      let w = 0
      for (let i = c * rows; i < n && i < (c + 1) * rows; i++) if (lens[i] > w) w = lens[i]
      widths.push(w)
      total += w
    }
    if (total > width && cols > 1) continue
    const lines: string[] = []
    for (let r = 0; r < rows; r++) {
      let line = ''
      for (let c = 0; c < used; c++) {
        const i = c * rows + r
        if (i >= n) break
        line += i + rows < n ? names[i] + ' '.repeat(widths[c] - lens[i] + GAP) : names[i]
      }
      lines.push(line)
    }
    return lines
  }
}

/** One run of `ls`: what was asked for, and whether anything has been printed yet (a heading after it gets a blank line). */
class Listing {
  private readonly run: Run
  private readonly flags: ReadonlySet<string>
  /** Whether each entry needs more than its name: the long form, the marks, and the orders by size and time do. */
  private readonly stats: boolean
  private readonly columns: boolean
  private started = false

  constructor(run: Run, flags: ReadonlySet<string>) {
    this.run = run
    this.flags = flags
    this.stats = flags.has('l') || flags.has('F') || flags.has('S') || flags.has('t')
    this.columns = !flags.has('l') && !flags.has('1') && run.sys.isatty(1)
  }

  /** Puts items in the order asked for: by name, or largest or newest first with the name settling ties; `-r` turns it round. */
  order(items: Item[]): void {
    const bySize = this.flags.has('S')
    const byTime = !bySize && this.flags.has('t')
    const sign = this.flags.has('r') ? -1 : 1
    items.sort((a, b) => {
      let d = 0
      if (bySize) d = (b.st === null ? 0 : b.st.size) - (a.st === null ? 0 : a.st.size)
      else if (byTime) d = (b.st === null ? 0 : b.st.mtime) - (a.st === null ? 0 : a.st.mtime)
      if (d === 0) d = a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      return sign * d
    })
  }

  /** The name as it is printed: with `-F`, a directory gets `/` and a file somebody may run gets `*`. */
  private shown(item: Item): string {
    if (!this.flags.has('F')) return item.name
    if (item.kind === 'dir') return `${item.name}/`
    return item.kind === 'file' && item.st !== null && (item.st.mode & 0o111) !== 0 ? `${item.name}*` : item.name
  }

  /** Prints one group of items in the form asked for. */
  *show(items: Item[]): Task<void> {
    const out = this.run.out
    this.order(items)
    this.started = true
    if (this.flags.has('l')) {
      const people = this.flags.has('h')
      const rows: { readonly head: string; readonly owner: string; readonly size: string; readonly tail: string }[] = []
      let ownerWidth = 0
      let sizeWidth = 0
      for (const item of items) {
        const st = item.st
        if (st === null) continue
        const owner = ownerName(st.uid)
        const size = people ? human(st.size) : String(st.size)
        if (owner.length > ownerWidth) ownerWidth = owner.length
        if (size.length > sizeWidth) sizeWidth = size.length
        rows.push({ head: modeString(st.kind, st.mode), owner, size, tail: `${stamp(st.mtime)} ${this.shown(item)}` })
        if ((rows.length & PACE) === 0) yield* this.run.sys.step()
      }
      for (const r of rows) yield* out.line(`${r.head} ${r.owner.padEnd(ownerWidth)} ${r.size.padStart(sizeWidth)} ${r.tail}`)
      return
    }
    const names = items.map((item) => this.shown(item))
    if (this.columns) for (const line of yield* layout(this.run.sys, names, COLUMNS)) yield* out.line(line)
    else for (const name of names) yield* out.line(name)
  }

  /** One name of a directory as an item, asking `stat` only when the listing needs it. A name that cannot be read is reported. */
  private *item(dir: string, name: string, kind: Kind): Task<Item | null> {
    if (!this.stats) return { name, kind, st: null }
    const path = join(dir, name)
    try {
      const st = yield* this.run.sys.stat(path)
      return { name, kind: st.kind, st }
    } catch (e) {
      yield* this.run.fail(path, e)
      return null
    }
  }

  /** Lists what a directory holds, under a heading when asked, and with `-R` every directory below it in turn. */
  *directory(path: string, depth: number, heading: boolean): Task<void> {
    const { run, flags } = this
    let entries: Entry[]
    try {
      entries = yield* run.sys.list(path)
    } catch (e) {
      yield* run.fail(path, e)
      return
    }
    const hidden = flags.has('a') || flags.has('A')
    const items: Item[] = []
    if (flags.has('a')) {
      for (const name of ['.', '..']) {
        const item = yield* this.item(path, name, 'dir')
        if (item !== null) items.push(item)
      }
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && !hidden) continue
      const item = yield* this.item(path, entry.name, entry.kind)
      if (item === null) continue
      items.push(item)
      if ((items.length & PACE) === 0) yield* run.sys.step()
    }
    if (heading) {
      if (this.started) yield* run.out.line('')
      yield* run.out.line(`${path}:`)
    }
    yield* this.show(items)
    if (!flags.has('R')) return
    for (const item of items) {
      if (item.kind !== 'dir' || item.name === '.' || item.name === '..') continue
      const child = join(path, item.name)
      if (depth >= DEPTH) yield* run.fail(child, 'too deep to list')
      else yield* this.directory(child, depth + 1, true)
    }
  }
}

const ls: Program = function* (sys, argv) {
  const run = new Run(sys, 'ls')
  const o = options(argv, 'laAd1RhFStr')
  if (o.bad !== null) return yield* run.misuse(o.bad, 'ls [-laAd1RhFStr] [path ...]')
  const listing = new Listing(run, o.flags)
  const operands = o.rest.length === 0 ? ['.'] : o.rest
  const files: Item[] = []
  const dirs: Item[] = []
  for (const path of operands) {
    try {
      const st = yield* sys.stat(path)
      if (st.kind === 'dir' && !o.flags.has('d')) dirs.push({ name: path, kind: st.kind, st })
      else files.push({ name: path, kind: st.kind, st })
    } catch (e) {
      yield* run.fail(path, e)
    }
  }
  if (files.length > 0) yield* listing.show(files)
  listing.order(dirs)
  const heading = operands.length > 1 || o.flags.has('R')
  for (const dir of dirs) yield* listing.directory(dir.name, 0, heading)
  return yield* run.end()
}

// cat

/** The columns a line number is set in: a number with more digits takes what it needs. */
const NUMBER_WIDTH = 6

/** Writes a line number as `cat -n` shows it (to the right of its columns, then a tab) into `out` at `at`; where the line goes on. */
function numberInto(out: Uint8Array, at: number, n: number): number {
  let digits = 1
  for (let v = n; v >= 10; v = Math.floor(v / 10)) digits++
  const end = at + Math.max(NUMBER_WIDTH, digits)
  let v = n
  for (let i = end - 1; i >= at; i--) {
    if (i < end - digits) out[i] = 32
    else {
      out[i] = 48 + (v % 10)
      v = Math.floor(v / 10)
    }
  }
  out[end] = 9
  return end + 1
}

const cat: Program = function* (sys, argv) {
  const o = options(argv, 'n')
  if (o.bad !== null) return yield* new Run(sys, 'cat').misuse(o.bad, 'cat [-n] [file ...]')
  const numbered = o.flags.has('n')
  let line = 0
  // Whether the next byte starts a line: kept from one file to the next, so a file without a final line end runs on.
  let fresh = true
  // A refused write is about the output, not about the file being read: it ends the program, told apart from a refused read.
  const write = function* (data: Uint8Array): Task<void> {
    try {
      yield* sys.write(1, data)
    } catch (e) {
      throw unwritten(e)
    }
  }
  return yield* inputs(sys, 'cat', o.rest, function* (fd) {
    for (;;) {
      const chunk = yield* sys.read(fd)
      if (chunk.length === 0) return
      if (!numbered) {
        yield* write(chunk)
        continue
      }
      // Room for the piece and a number before every line that can start in it: one array, filled once.
      let starts = fresh ? 1 : 0
      for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) starts++
      const out = new Uint8Array(chunk.length + starts * (Math.max(NUMBER_WIDTH, String(line + starts).length) + 1))
      let at = 0
      let from = 0
      while (from < chunk.length) {
        if (fresh) {
          at = numberInto(out, at, ++line)
          fresh = false
        }
        const end = chunk.indexOf(10, from)
        const stop = end < 0 ? chunk.length : end + 1
        out.set(chunk.subarray(from, stop), at)
        at += stop - from
        from = stop
        fresh = end >= 0
      }
      yield* write(out.subarray(0, at))
    }
  })
}

// Permissions, as chmod and mkdir -m read them.

/** A mode as typed, ready to apply: the new permission bits of a node that has `mode` now. */
type ModeChange = (mode: number, isDir: boolean, umask: number) => number

/** One `+rw`, `-x` or `=r` of a clause, with the sets it names (`named` false when the clause named none). */
interface ModeAction {
  readonly named: boolean
  readonly who: number
  readonly op: string
  readonly perms: string
}

/** The bits each letter of `who` covers; the sticky bit goes with the others' set and with all. */
const WHO: Readonly<Record<string, number>> = Object.freeze({ u: 0o700, g: 0o070, o: 0o1007, a: 0o1777 })

/**
 * Reads a mode: octal (`755`, `0644`, up to `1777`) or clauses `[ugoa]*[+-=][rwxXt]*` with commas between them (one
 * clause may hold several operators: `u+r-w`). Null when it is neither.
 */
function parseMode(text: string): ModeChange | null {
  if (/^[0-7]{1,4}$/.test(text)) {
    const bits = Number.parseInt(text, 8)
    return bits > 0o1777 ? null : () => bits
  }
  const actions: ModeAction[] = []
  for (const clause of text.split(',')) {
    let i = 0
    let who = 0
    while (i < clause.length && 'ugoa'.includes(clause[i])) who |= WHO[clause[i++]]
    const named = i > 0
    if (i >= clause.length) return null
    while (i < clause.length) {
      const op = clause[i++]
      if (op !== '+' && op !== '-' && op !== '=') return null
      const from = i
      while (i < clause.length && 'rwxXt'.includes(clause[i])) i++
      actions.push({ named, who, op, perms: clause.slice(from, i) })
    }
  }
  return (mode, isDir, umask) => {
    let m = mode & 0o1777
    for (const a of actions) {
      const mask = a.named ? a.who : 0o1777
      let bits = 0
      for (const p of a.perms) {
        if (p === 'r') bits |= 0o444
        else if (p === 'w') bits |= 0o222
        else if (p === 'x') bits |= 0o111
        else if (p === 't') bits |= STICKY
        else if (isDir || (m & 0o111) !== 0) bits |= 0o111
      }
      bits &= mask
      // With no set named, the permissions the task's mask holds back are left as they are.
      if (!a.named) bits &= ~(umask & 0o777)
      if (a.op === '+') m |= bits
      else if (a.op === '-') m &= ~bits
      else m = (m & ~mask) | bits
    }
    return m
  }
}

// mkdir, rmdir

/** Makes a directory and each directory above it that is not there yet; one that is already there is no failure. */
function* makePath(sys: Sys, path: string, exact: number | null): Task<void> {
  const names = path.split('/').filter((name) => name !== '')
  // A path that ends in `.` names the directory before it: that one is the last to make, and the one a mode is for.
  while (names.length > 0 && names[names.length - 1] === '.') names.pop()
  if (names.length === 0) {
    if ((yield* sys.stat(path)).kind !== 'dir') throw new OsError('ENOTDIR')
    return
  }
  let at = path.startsWith('/') ? '/' : ''
  for (let i = 0; i < names.length; i++) {
    at = join(at, names[i])
    const last = i === names.length - 1
    try {
      yield* sys.mkdir(at)
      if (last && exact !== null) yield* sys.chmod(at, exact)
      // A directory made on the way must let its owner go on into it, whatever the mask holds back.
      else if (!last && (sys.umask & 0o300) !== 0) yield* sys.chmod(at, (0o777 & ~sys.umask) | 0o300)
    } catch (e) {
      if (!(e instanceof OsError) || e.errno !== 'EEXIST') throw e
      if (last && (yield* sys.stat(at)).kind !== 'dir') throw e
    }
  }
}

const mkdir: Program = function* (sys, argv) {
  const run = new Run(sys, 'mkdir')
  const o = options(argv, 'p', 'm')
  if (o.bad !== null || o.rest.length === 0) return yield* run.misuse(o.bad, 'mkdir [-p] [-m mode] dir ...')
  let exact: number | null = null
  const text = o.values.get('m')
  if (text !== undefined) {
    const change = parseMode(text)
    if (change === null) return yield* run.misuse(`invalid mode '${text}'`, 'mkdir [-p] [-m mode] dir ...')
    // Letters add to and take from "everything allowed", as if the directory began that way.
    exact = change(0o777, true, sys.umask)
  }
  for (const path of o.rest) {
    try {
      if (o.flags.has('p')) yield* makePath(sys, path, exact)
      else {
        yield* sys.mkdir(path)
        if (exact !== null) yield* sys.chmod(path, exact)
      }
    } catch (e) {
      yield* run.fail(path, e)
    }
  }
  return yield* run.end()
}

const rmdir: Program = function* (sys, argv) {
  const run = new Run(sys, 'rmdir')
  const o = options(argv, 'p')
  if (o.bad !== null || o.rest.length === 0) return yield* run.misuse(o.bad, 'rmdir [-p] dir ...')
  // A path whose last name is . or .. names a directory by where the task stands, not by its own name: refused, as rm
  // refuses it, so neither the directory you are in nor one above it is removed that way (-p would climb through `..`).
  const take = function* (at: string): Task<void> {
    const last = lastName(at)
    if (last === '.' || last === '..') throw new OsError('EINVAL', "refusing to remove '.' or '..'")
    yield* sys.rmdir(at)
  }
  for (const path of o.rest) {
    let at = path
    try {
      yield* take(at)
      if (!o.flags.has('p')) continue
      // Then each directory above it in the path as typed, nearest first (a `.` in the path names nothing new).
      const names = path.split('/').filter((name) => name !== '' && name !== '.')
      for (let n = names.length - 1; n > 0; n--) {
        at = (path.startsWith('/') ? '/' : '') + names.slice(0, n).join('/')
        yield* take(at)
      }
    } catch (e) {
      yield* run.fail(at, e)
    }
  }
  return yield* run.end()
}

// rm

/** Removes a directory and everything below it, deepest first. Whether all of it went (what did not was reported). */
function* removeTree(run: Run, path: string, depth: number): Task<boolean> {
  const sys = run.sys
  if (depth > DEPTH) {
    yield* run.fail(path, 'too deep to remove')
    return false
  }
  let entries: Entry[]
  try {
    entries = yield* sys.list(path)
  } catch (e) {
    yield* run.fail(path, e)
    return false
  }
  let ok = true
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.kind === 'dir') ok = (yield* removeTree(run, child, depth + 1)) && ok
    else {
      try {
        yield* sys.unlink(child)
      } catch (e) {
        yield* run.fail(child, e)
        ok = false
      }
    }
  }
  // Something inside stayed and was reported: the directory cannot go, and saying "not empty" would add nothing.
  if (!ok) return false
  try {
    yield* sys.rmdir(path)
  } catch (e) {
    yield* run.fail(path, e)
    return false
  }
  return true
}

const rm: Program = function* (sys, argv) {
  const run = new Run(sys, 'rm')
  const o = options(argv, 'rRf')
  const force = o.flags.has('f')
  if (o.bad !== null || (o.rest.length === 0 && !force)) return yield* run.misuse(o.bad, 'rm [-r] [-f] path ...')
  const recursive = o.flags.has('r') || o.flags.has('R')
  for (const path of o.rest) {
    try {
      if (sys.resolve(path) === '/') {
        yield* run.fail(path, 'refusing to remove the root directory')
        continue
      }
      const last = lastName(path)
      if (last === '.' || last === '..') {
        yield* run.fail(path, "refusing to remove '.' or '..'")
        continue
      }
      // A name that ends in a slash is a directory's name: the file system refuses it for a file (not a directory).
      const st = yield* sys.stat(path)
      if (st.kind !== 'dir') yield* sys.unlink(path)
      else if (recursive) yield* removeTree(run, path, 0)
      else yield* run.fail(path, 'is a directory')
    } catch (e) {
      if (force && missing(e)) continue
      yield* run.fail(path, e)
    }
  }
  return yield* run.end()
}

// cp, mv

/** Whether `to` is `from` itself or lies below it. There are no links, so the two canonical paths tell. */
function within(sys: Sys, from: string, to: string): boolean {
  const a = sys.resolve(from)
  const b = sys.resolve(to)
  return a === b || a === '/' || b.startsWith(`${a}/`)
}

/**
 * Copies for cp and mv: one file a piece at a time, or a directory with all below it. A copy is a new file: it gets
 * its original's permissions less what the task's mask holds back, and the present time. With `keep` (a move) the
 * result is the original somewhere else: its permissions exactly, its time, and its owner where the task may set one.
 */
class Copier {
  private readonly run: Run
  private readonly keep: boolean

  constructor(run: Run, keep: boolean) {
    this.run = run
    this.keep = keep
  }

  /** Gives a finished copy the attributes that could not be given when it was made. Whether that worked. */
  private *finish(to: string, st: FileStat, made: boolean): Task<boolean> {
    const sys = this.run.sys
    try {
      if (this.keep) {
        yield* sys.chmod(to, st.mode & 0o1777)
        // Only user 0 may hand a file to someone else; for anyone else the moved file is theirs, as a new file is.
        if (sys.cred.uid === 0 && (st.uid !== sys.cred.uid || st.gid !== sys.cred.gid)) yield* sys.chown(to, st.uid, st.gid)
        yield* sys.utime(to, st.mtime)
      } else if (made && st.kind === 'dir') yield* sys.chmod(to, st.mode & 0o777 & ~sys.umask)
    } catch (e) {
      yield* this.run.fail(to, e)
      return false
    }
    return true
  }

  /** Copies the bytes of one file. Whether it worked (what did not was reported). */
  *file(from: string, to: string, st: FileStat): Task<boolean> {
    const run = this.run
    const sys = run.sys
    let there: FileStat | null = null
    try {
      there = yield* sys.stat(to)
    } catch (e) {
      if (!missing(e)) {
        yield* run.fail(to, e)
        return false
      }
    }
    if (there !== null && there.dev === st.dev && there.ino === st.ino) {
      yield* run.fail(from, `is the same file as ${to}`)
      return false
    }
    // A name that ends in a slash is a directory's name: a file is not written under it.
    if (to.endsWith('/') && (there === null || there.kind !== 'dir')) {
      yield* run.fail(to, 'not a directory')
      return false
    }
    let src: number
    try {
      src = yield* sys.open(from, O_READ)
    } catch (e) {
      yield* run.fail(from, e)
      return false
    }
    try {
      let dst: number
      try {
        dst = yield* sys.open(to, O_WRITE | O_CREATE | O_TRUNC, st.mode & 0o777)
      } catch (e) {
        yield* run.fail(to, e)
        return false
      }
      try {
        for (;;) {
          let piece: Uint8Array
          try {
            piece = yield* sys.read(src, PIECE)
          } catch (e) {
            yield* run.fail(from, e)
            return false
          }
          if (piece.length === 0) break
          try {
            yield* sys.write(dst, piece)
          } catch (e) {
            yield* run.fail(to, e)
            return false
          }
        }
      } finally {
        sys.close(dst)
      }
    } finally {
      sys.close(src)
    }
    return yield* this.finish(to, st, there === null)
  }

  /** Copies a directory and everything below it into `to` (made when absent). Whether all of it was copied. */
  *tree(from: string, to: string, st: FileStat, depth: number): Task<boolean> {
    const run = this.run
    const sys = run.sys
    if (depth > DEPTH) {
      yield* run.fail(from, 'too deep to copy')
      return false
    }
    let there: FileStat | null = null
    try {
      there = yield* sys.stat(to)
    } catch (e) {
      if (!(e instanceof OsError) || e.errno !== 'ENOENT') {
        yield* run.fail(to, e)
        return false
      }
    }
    if (there !== null && there.kind !== 'dir') {
      yield* run.fail(to, 'not a directory')
      return false
    }
    // The new directory takes its original's permissions only at the end, so a read-only one can still be filled.
    if (there === null) {
      try {
        yield* sys.mkdir(to)
      } catch (e) {
        yield* run.fail(to, e)
        return false
      }
    }
    let entries: Entry[]
    try {
      entries = yield* sys.list(from)
    } catch (e) {
      yield* run.fail(from, e)
      return false
    }
    let ok = true
    for (const entry of entries) {
      const src = join(from, entry.name)
      const dst = join(to, entry.name)
      let child: FileStat
      try {
        child = yield* sys.stat(src)
      } catch (e) {
        yield* run.fail(src, e)
        ok = false
        continue
      }
      if (child.kind === 'dir') ok = (yield* this.tree(src, dst, child, depth + 1)) && ok
      else if (child.kind === 'file') ok = (yield* this.file(src, dst, child)) && ok
      else {
        yield* run.fail(src, 'a device is not copied')
        ok = false
      }
    }
    return (yield* this.finish(to, st, there === null)) && ok
  }
}

/** Whether a destination names a directory that is there. */
function* isDirectory(sys: Sys, path: string): Task<boolean> {
  try {
    return (yield* sys.stat(path)).kind === 'dir'
  } catch (e) {
    if (e instanceof OsError) return false
    throw e
  }
}

const cp: Program = function* (sys, argv) {
  const run = new Run(sys, 'cp')
  const o = options(argv, 'rR')
  if (o.bad !== null || o.rest.length < 2) return yield* run.misuse(o.bad, 'cp [-r] source ... destination')
  const recursive = o.flags.has('r') || o.flags.has('R')
  const dest = o.rest[o.rest.length - 1]
  const sources = o.rest.slice(0, -1)
  const into = yield* isDirectory(sys, dest)
  if (sources.length > 1 && !into) {
    yield* run.fail(dest, 'not a directory')
    return 1
  }
  const copier = new Copier(run, false)
  for (const source of sources) {
    try {
      const st = yield* sys.stat(source)
      const last = lastName(source)
      // A source that ends in `.` or `..` (or is the root) has no name of its own to take: its contents go in.
      const to = into && last !== '.' && last !== '..' && last !== '/' ? join(dest, last) : dest
      if (st.kind !== 'dir') yield* copier.file(source, to, st)
      else if (!recursive) yield* run.fail(source, 'is a directory (use -r to copy it)')
      else if (within(sys, source, to)) yield* run.fail(source, `cannot copy a directory into itself (${to})`)
      else yield* copier.tree(source, to, st, 0)
    } catch (e) {
      yield* run.fail(source, e)
    }
  }
  return yield* run.end()
}

/** Which of the two paths of a refused rename the refusal is about: the source when it is not there, else by the reason. */
function* blamed(sys: Sys, from: string, to: string, e: OsError): Task<string> {
  if (!(yield* sys.access(from))) return from
  return ['ENOENT', 'ENOTEMPTY', 'EISDIR', 'ENOTDIR', 'ENOSPC', 'ENAMETOOLONG'].includes(e.errno) ? to : from
}

/** The mount a canonical path is on: the one attached deepest along it. */
function mountOf(mounts: readonly MountInfo[], full: string): MountInfo | null {
  let best: MountInfo | null = null
  for (const m of mounts) {
    if (m.path !== '/' && m.path !== full && !full.startsWith(`${m.path}/`)) continue
    if (best === null || m.path.length > best.path.length) best = m
  }
  return best
}

/** Removes a file if it is there, saying nothing when it will not go: tidying after a move that was refused. */
function* discard(sys: Sys, path: string): Task<void> {
  try {
    yield* sys.unlink(path)
  } catch (e) {
    if (!(e instanceof OsError)) throw e
  }
}

/**
 * A move between two file systems: copy, then remove the source, and only when the whole copy worked. A file that
 * cannot be moved leaves nothing new at the destination; a directory that cannot be moved whole leaves what was
 * copied of it there (and what could not be removed of it where it was), each failure reported.
 */
function* moveAcross(run: Run, from: string, to: string): Task<void> {
  const sys = run.sys
  const st = yield* sys.stat(from)
  if (st.kind === 'stream') {
    yield* run.fail(from, 'a device cannot be moved')
    return
  }
  const full = sys.resolve(from)
  const mounts = sys.mounts()
  for (const m of mounts) {
    if (m.path !== full && !m.path.startsWith(`${full}/`)) continue
    yield* run.fail(from, m.path === full ? 'a mount point' : 'a mount point is inside it')
    return
  }
  // The source has to go in the end. Where the directory that holds it takes no changes, say so before copying anything.
  const holder = parentOf(full)
  if (!(yield* sys.access(holder, W | X))) {
    const on = mountOf(mounts, holder)
    yield* run.fail(from, new OsError(on !== null && on.readOnly ? 'EROFS' : 'EACCES'))
    return
  }
  let there: FileStat | null = null
  try {
    there = yield* sys.stat(to)
  } catch (e) {
    if (!(e instanceof OsError) || e.errno !== 'ENOENT') {
      yield* run.fail(to, e)
      return
    }
  }
  const copier = new Copier(run, true)
  if (st.kind !== 'dir') {
    if (there !== null && there.kind === 'dir') {
      yield* run.fail(to, 'is a directory')
      return
    }
    if (!(yield* copier.file(from, to, st))) {
      if (there === null) yield* discard(sys, to)
      return
    }
    try {
      yield* sys.unlink(from)
    } catch (e) {
      if (!(e instanceof OsError)) throw e
      // The source would not go after all: the copy made for this move is taken away again.
      if (there === null) yield* discard(sys, to)
      yield* run.fail(from, e)
    }
    return
  }
  if (there !== null) {
    if (there.kind !== 'dir') {
      yield* run.fail(to, 'not a directory')
      return
    }
    // As a rename would: a directory replaces only an empty one.
    try {
      yield* sys.rmdir(to)
    } catch (e) {
      yield* run.fail(to, e)
      return
    }
  }
  if (yield* copier.tree(from, to, st, 0)) yield* removeTree(run, from, 0)
}

const mv: Program = function* (sys, argv) {
  const run = new Run(sys, 'mv')
  const o = options(argv, '')
  if (o.bad !== null || o.rest.length < 2) return yield* run.misuse(o.bad, 'mv source ... destination')
  const dest = o.rest[o.rest.length - 1]
  const sources = o.rest.slice(0, -1)
  const into = yield* isDirectory(sys, dest)
  if (sources.length > 1 && !into) {
    yield* run.fail(dest, 'not a directory')
    return 1
  }
  for (const source of sources) {
    const last = lastName(source)
    if (last === '.' || last === '..') {
      yield* run.fail(source, "cannot move '.' or '..'")
      continue
    }
    const to = into ? join(dest, last) : dest
    try {
      // A name that ends in a slash is a directory's name: only a directory can be given it.
      if (!into && to.endsWith('/') && (yield* sys.stat(source)).kind !== 'dir') {
        yield* run.fail(to, 'not a directory')
        continue
      }
      try {
        yield* sys.rename(source, to)
      } catch (e) {
        if (!(e instanceof OsError) || e.errno === 'EPIPE') throw e
        if (e.errno === 'EXDEV') yield* moveAcross(run, source, to)
        else yield* run.fail(yield* blamed(sys, source, to, e), e)
      }
    } catch (e) {
      yield* run.fail(source, e)
    }
  }
  return yield* run.end()
}

// touch, chmod, stat

const touch: Program = function* (sys, argv) {
  const run = new Run(sys, 'touch')
  const o = options(argv, 'c')
  if (o.bad !== null || o.rest.length === 0) return yield* run.misuse(o.bad, 'touch [-c] file ...')
  for (const path of o.rest) {
    try {
      try {
        yield* sys.utime(path, sys.wall())
      } catch (e) {
        if (!(e instanceof OsError) || e.errno !== 'ENOENT') throw e
        if (!o.flags.has('c')) sys.close(yield* sys.open(path, O_WRITE | O_CREATE))
      }
    } catch (e) {
      yield* run.fail(path, e)
    }
  }
  return yield* run.end()
}

/** Applies a mode to a path and, when asked, to everything below it. */
function* changeMode(run: Run, path: string, change: ModeChange, recursive: boolean, depth: number): Task<void> {
  const sys = run.sys
  let isDir = false
  try {
    const st = yield* sys.stat(path)
    isDir = st.kind === 'dir'
    yield* sys.chmod(path, change(st.mode, isDir, sys.umask))
  } catch (e) {
    // A directory that would not change may still hold things that will: the walk goes on into it.
    yield* run.fail(path, e)
  }
  if (!recursive || !isDir) return
  let entries: Entry[] = []
  try {
    if (depth > DEPTH) yield* run.fail(path, 'too deep to go into')
    else entries = yield* sys.list(path)
  } catch (e) {
    yield* run.fail(path, e)
  }
  for (const entry of entries) yield* changeMode(run, join(path, entry.name), change, true, depth + 1)
}

const chmod: Program = function* (sys, argv) {
  const run = new Run(sys, 'chmod')
  const text = 'chmod [-R] mode path ...'
  // Read by hand: a mode may start with a dash (`chmod -w file`), which no option reader would let through.
  let i = 1
  let recursive = false
  for (; i < argv.length; i++) {
    if (argv[i] === '-R') recursive = true
    else break
  }
  if (argv[i] === '--') i++
  if (argv.length - i < 2) return yield* run.misuse(null, text)
  const change = parseMode(argv[i])
  if (change === null) return yield* run.misuse(`invalid mode '${argv[i]}'`, text)
  for (const path of argv.slice(i + 1)) yield* changeMode(run, path, change, recursive, 0)
  return yield* run.end()
}

/** What a node is, in a word a person reads. */
const KIND_WORD: Readonly<Record<Kind, string>> = Object.freeze({ file: 'file', dir: 'directory', stream: 'device' })

const stat: Program = function* (sys, argv) {
  const run = new Run(sys, 'stat')
  const o = options(argv, '')
  if (o.bad !== null || o.rest.length === 0) return yield* run.misuse(o.bad, 'stat path ...')
  for (const path of o.rest) {
    try {
      const st = yield* sys.stat(path)
      const bits = st.mode & 0o1777
      yield* run.out.put(
        `name:   ${path}\n` +
        `kind:   ${KIND_WORD[st.kind]}\n` +
        `size:   ${st.size}\n` +
        `mode:   ${bits.toString(8).padStart(4, '0')} (${modeString(st.kind, st.mode)})\n` +
        `owner:  ${st.uid}${st.uid === 0 ? ' (root)' : ''}\n` +
        `group:  ${st.gid}\n` +
        `device: ${st.dev}\n` +
        `inode:  ${st.ino}\n` +
        `time:   ${stamp(st.mtime)}:${two(civil(st.mtime).second)}\n`,
      )
    } catch (e) {
      yield* run.fail(path, e)
    }
  }
  return yield* run.end()
}

// find

/** What is wrong with an expression: thrown while it is read, reported as a wrong call. */
class Misuse {
  readonly text: string
  constructor(text: string) {
    this.text = text
  }
}

/** One file or directory the walk has reached. */
interface Found {
  readonly path: string
  readonly name: string
  readonly kind: Kind
  /** Directories below the path the walk started at. */
  readonly depth: number
  /** What `stat` says, asked only when a test needs it. */
  st: FileStat | null
  /** Set when `stat` was refused once, so it is not asked (and reported) again. */
  lost: boolean
}

/** A test or an action of an expression: whether it passes for what was found. */
type Test = (f: Found) => Task<boolean>

/** Reads a `find` expression and walks the tree with it. */
class Finder {
  private readonly run: Run
  private readonly args: readonly string[]
  private at = 0
  private nesting = 0
  /** Whether the expression names an action of its own (else everything that passes is printed). */
  private acts = false
  /** Whether it removes: the walk then visits what a directory holds before the directory. */
  deletes = false
  private least = 0
  private most = DEPTH
  /** The files `-newer` named, and their times once asked. */
  readonly newer: { readonly file: string; mtime: number }[] = []

  constructor(run: Run, args: readonly string[]) {
    this.run = run
    this.args = args
  }

  /** The whole expression as one test; printing is added when it names no action. */
  expression(): Test {
    const print = this.print()
    if (this.args.length === 0) return print
    const test = this.either()
    if (this.at < this.args.length) throw new Misuse(this.args[this.at] === ')' ? "')' without '('" : `unexpected '${this.args[this.at]}'`)
    if (this.acts) return test
    return function* (f) {
      return (yield* test(f)) && (yield* print(f))
    }
  }

  private print(): Test {
    const out = this.run.out
    return function* (f) {
      yield* out.line(f.path)
      return true
    }
  }

  /** What `stat` says of what was found; null (reported once) when it is refused. */
  private *stat(f: Found): Task<FileStat | null> {
    if (f.st !== null || f.lost) return f.st
    try {
      f.st = yield* this.run.sys.stat(f.path)
    } catch (e) {
      f.lost = true
      yield* this.run.fail(f.path, e)
    }
    return f.st
  }

  /** Terms with `-o` between them: the first that passes settles it. */
  private either(): Test {
    const terms: Test[] = [this.both()]
    while (this.args[this.at] === '-o') {
      this.at++
      terms.push(this.both())
    }
    if (terms.length === 1) return terms[0]
    return function* (f) {
      for (const term of terms) if (yield* term(f)) return true
      return false
    }
  }

  /** Terms side by side (or with `-a` between them): the first that does not pass settles it. */
  private both(): Test {
    const terms: Test[] = [this.negated()]
    for (;;) {
      const word = this.args[this.at]
      if (word === undefined || word === '-o' || word === ')') break
      if (word === '-a') this.at++
      terms.push(this.negated())
    }
    if (terms.length === 1) return terms[0]
    return function* (f) {
      for (const term of terms) if (!(yield* term(f))) return false
      return true
    }
  }

  private deeper(): void {
    if (++this.nesting > NESTING) throw new Misuse('the expression is nested too deeply')
  }

  private negated(): Test {
    const word = this.args[this.at]
    if (word !== '!' && word !== '-not') return this.primary()
    this.at++
    this.deeper()
    const inner = this.negated()
    this.nesting--
    return function* (f) {
      return !(yield* inner(f))
    }
  }

  /** The value a test takes. */
  private value(of: string): string {
    const v = this.args[this.at++]
    if (v === undefined) throw new Misuse(`${of} needs a value`)
    return v
  }

  private primary(): Test {
    const run = this.run
    const sys = run.sys
    const stat = (f: Found): Task<FileStat | null> => this.stat(f)
    const word = this.args[this.at++]
    if (word === undefined) throw new Misuse('the expression ends too soon')
    switch (word) {
      case '(': {
        this.deeper()
        const inner = this.either()
        if (this.args[this.at] !== ')') throw new Misuse("'(' without ')'")
        this.at++
        this.nesting--
        return inner
      }
      case '-name': {
        const pattern = this.value(word)
        return function* (f) {
          return matches(pattern, f.name, true)
        }
      }
      case '-iname': {
        const pattern = this.value(word).toLowerCase()
        return function* (f) {
          return matches(pattern, f.name.toLowerCase(), true)
        }
      }
      case '-path': {
        const pattern = this.value(word)
        return function* (f) {
          return matches(pattern, f.path, true)
        }
      }
      case '-type': {
        const v = this.value(word)
        if (v !== 'f' && v !== 'd') throw new Misuse(`-type takes f (a file) or d (a directory), not '${v}'`)
        const kind: Kind = v === 'f' ? 'file' : 'dir'
        return function* (f) {
          return f.kind === kind
        }
      }
      case '-maxdepth':
      case '-mindepth': {
        const n = count(this.value(word))
        if (n === null) throw new Misuse(`${word} needs a whole number`)
        if (word === '-maxdepth') this.most = Math.min(n, DEPTH)
        else this.least = n
        return function* () {
          return true
        }
      }
      case '-empty':
        return function* (f) {
          if (f.kind === 'dir') {
            try {
              return (yield* sys.list(f.path)).length === 0
            } catch (e) {
              yield* run.fail(f.path, e)
              return false
            }
          }
          if (f.kind !== 'file') return false
          const st = yield* stat(f)
          return st !== null && st.size === 0
        }
      case '-size': {
        const v = this.value(word)
        const m = /^([+-]?)([0-9]+)([ckM]?)$/.exec(v)
        const n = m === null ? null : count(m[2])
        if (m === null || n === null) throw new Misuse(`-size takes [+-]N[ckM], not '${v}'`)
        const sign = m[1]
        const unit = m[3] === 'c' ? 1 : m[3] === 'k' ? 1024 : m[3] === 'M' ? 1048576 : 512
        return function* (f) {
          const st = yield* stat(f)
          if (st === null) return false
          // A part of a unit counts as a whole one.
          const units = Math.ceil(st.size / unit)
          return sign === '+' ? units > n : sign === '-' ? units < n : units === n
        }
      }
      case '-newer': {
        const ref = { file: this.value(word), mtime: 0 }
        this.newer.push(ref)
        return function* (f) {
          const st = yield* stat(f)
          return st !== null && st.mtime > ref.mtime
        }
      }
      case '-print':
        this.acts = true
        return this.print()
      case '-delete':
        this.acts = true
        this.deletes = true
        return function* (f) {
          // The place the search started from, when it is spelled `.` or `..`, is not this action's to remove.
          const last = lastName(f.path)
          if (f.depth === 0 && (last === '.' || last === '..')) return true
          try {
            if (f.kind === 'dir') yield* sys.rmdir(f.path)
            else yield* sys.unlink(f.path)
            return true
          } catch (e) {
            yield* run.fail(f.path, e)
            return false
          }
        }
      case '-exec': {
        const words: string[] = []
        for (;;) {
          const w = this.args[this.at++]
          if (w === undefined) throw new Misuse("-exec needs a ';' to end its command")
          if (w === ';') break
          words.push(w)
        }
        if (words.length === 0) throw new Misuse('-exec needs a command')
        this.acts = true
        return function* (f) {
          // The command writes to the same output: what is buffered here goes first.
          yield* run.out.flush()
          const command = words.map((w) => w.split('{}').join(f.path))
          let pid: number
          try {
            pid = yield* sys.spawn(command)
          } catch (e) {
            yield* run.fail(command[0], e)
            return false
          }
          return (yield* sys.wait(pid)) === 0
        }
      }
      default:
        if (word === ')' || word === '-a' || word === '-o') throw new Misuse(`'${word}' has nothing before it`)
        throw new Misuse(`unknown test '${word}'`)
    }
  }

  /** Visits what was found and, for a directory, everything below it in sorted order. */
  *walk(f: Found, test: Test): Task<void> {
    const sys = this.run.sys
    // A walk that prints nothing and asks nothing of the kernel still gives the other tasks their turns.
    yield* sys.step()
    const counted = f.depth >= this.least
    if (counted && !this.deletes) yield* test(f)
    if (f.kind === 'dir' && f.depth < this.most) {
      let entries: Entry[] = []
      try {
        entries = yield* sys.list(f.path)
      } catch (e) {
        yield* this.run.fail(f.path, e)
      }
      for (const e of entries) yield* this.walk({ path: join(f.path, e.name), name: e.name, kind: e.kind, depth: f.depth + 1, st: null, lost: false }, test)
    }
    if (counted && this.deletes) yield* test(f)
  }
}

const find: Program = function* (sys, argv) {
  const run = new Run(sys, 'find')
  const starts: string[] = []
  let i = 1
  while (i < argv.length && !argv[i].startsWith('-') && argv[i] !== '!' && argv[i] !== '(') starts.push(argv[i++])
  if (starts.length === 0) starts.push('.')
  const finder = new Finder(run, argv.slice(i))
  let test: Test
  try {
    test = finder.expression()
  } catch (e) {
    if (!(e instanceof Misuse)) throw e
    return yield* run.misuse(e.text, 'find [path ...] [expression]')
  }
  for (const ref of finder.newer) {
    try {
      ref.mtime = (yield* sys.stat(ref.file)).mtime
    } catch (e) {
      yield* run.fail(ref.file, e)
      return 1
    }
  }
  if (finder.deletes) {
    for (const start of starts) {
      let full = ''
      try {
        full = sys.resolve(start)
      } catch (e) {
        if (!(e instanceof OsError)) throw e
      }
      if (full !== '/') continue
      yield* run.fail(start, '-delete is refused for a search that starts at the root directory')
      return 1
    }
  }
  for (const start of starts) {
    try {
      const st = yield* sys.stat(start)
      yield* finder.walk({ path: start, name: lastName(start), kind: st.kind, depth: 0, st, lost: false }, test)
    } catch (e) {
      yield* run.fail(start, e)
    }
  }
  return yield* run.end()
}

// du, df, mount, umount

/** Adds up the bytes of the files below a directory, printing a line for each directory unless `quiet` (then only the top). */
function* tally(run: Run, path: string, depth: number, quiet: boolean, show: (bytes: number) => string): Task<number> {
  const sys = run.sys
  let total = 0
  let entries: Entry[] = []
  try {
    if (depth > DEPTH) yield* run.fail(path, 'too deep to add up')
    else entries = yield* sys.list(path)
  } catch (e) {
    yield* run.fail(path, e)
  }
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.kind === 'dir') total += yield* tally(run, child, depth + 1, quiet, show)
    else if (entry.kind === 'file') {
      try {
        total += (yield* sys.stat(child)).size
      } catch (e) {
        yield* run.fail(child, e)
      }
    }
  }
  if (!quiet || depth === 0) yield* run.out.line(`${show(total)}\t${path}`)
  return total
}

/** A count of bytes in units of 1024, a part of a unit counting as a whole one. */
const units = (bytes: number): string => String(Math.ceil(bytes / 1024))

const du: Program = function* (sys, argv) {
  const run = new Run(sys, 'du')
  const o = options(argv, 'sh')
  if (o.bad !== null) return yield* run.misuse(o.bad, 'du [-s] [-h] [path ...]')
  const show = o.flags.has('h') ? human : units
  for (const path of o.rest.length === 0 ? ['.'] : o.rest) {
    try {
      const st = yield* sys.stat(path)
      if (st.kind === 'dir') yield* tally(run, path, 0, o.flags.has('s'), show)
      else yield* run.out.line(`${show(st.size)}\t${path}`)
    } catch (e) {
      yield* run.fail(path, e)
    }
  }
  return yield* run.end()
}

const df: Program = function* (sys, argv) {
  const run = new Run(sys, 'df')
  const o = options(argv, 'h')
  if (o.bad !== null) return yield* run.misuse(o.bad, 'df [-h] [path ...]')
  const all = sys.mounts()
  let chosen: MountInfo[] = []
  if (o.rest.length === 0) chosen = all
  for (const path of o.rest) {
    try {
      yield* sys.stat(path)
      const m = mountOf(all, sys.resolve(path))
      if (m !== null && !chosen.includes(m)) chosen.push(m)
    } catch (e) {
      yield* run.fail(path, e)
    }
  }
  const people = o.flags.has('h')
  const rows: string[][] = [['Source', 'Type', 'Size', 'Used', 'Free', 'Use%', 'Path']]
  for (const m of chosen) {
    // A mount with no storage of its own has no numbers to show.
    if (m.capacity <= 0) {
      rows.push([m.source, m.type, '-', '-', '-', '-', m.path])
      continue
    }
    const used = Math.min(m.used, m.capacity)
    const share = `${Math.ceil((used * 100) / m.capacity)}%`
    // In units, what is used rounds up and what is free is the rest, so the two add up to the size.
    const sizes = people
      ? [human(m.capacity), human(used), human(m.capacity - used)]
      : [units(m.capacity), units(used), String(Math.ceil(m.capacity / 1024) - Math.ceil(used / 1024))]
    rows.push([m.source, m.type, ...sizes, share, m.path])
  }
  if (rows.length > 1) {
    const widths = rows[0].map((_, c) => rows.reduce((w, row) => Math.max(w, row[c].length), 0))
    for (const row of rows) {
      yield* run.out.line(row.map((cell, c) => (c === row.length - 1 ? cell : c < 2 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join('  '))
    }
  }
  return yield* run.end()
}

const mount: Program = function* (sys, argv) {
  const run = new Run(sys, 'mount')
  if (argv.length > 1) {
    yield* run.fail(null, 'mounting a folder is not available from the prompt yet')
    return 1
  }
  for (const m of sys.mounts()) yield* run.out.line(`${m.source} ${m.path} ${m.type} ${m.readOnly ? 'ro' : 'rw'}`)
  return yield* run.end()
}

const umount: Program = function* (sys, argv) {
  const run = new Run(sys, 'umount')
  const o = options(argv, '')
  if (o.bad !== null || o.rest.length === 0) return yield* run.misuse(o.bad, 'umount path ...')
  for (const path of o.rest) {
    try {
      // The system's own file systems stay where task 1 put them. Without one, the programs, the manual or the scratch
      // space would be out of reach until the page closed, and a file made in its place would be saved with the disk.
      const where = sys.resolve(path)
      const mounted = sys.mounts().some((m) => m.path === where)
      if (mounted && MOUNT_POINTS.includes(where)) refuse('EBUSY', 'the system keeps it mounted')
      sys.umount(path)
    } catch (e) {
      yield* run.fail(path, e)
    }
  }
  return yield* run.end()
}

// realpath, basename, dirname

const realpath: Program = function* (sys, argv) {
  const run = new Run(sys, 'realpath')
  const o = options(argv, '')
  if (o.bad !== null || o.rest.length === 0) return yield* run.misuse(o.bad, 'realpath path ...')
  for (const path of o.rest) {
    try {
      const full = sys.resolve(path)
      try {
        yield* sys.stat(full)
      } catch (e) {
        // A name that is not there yet still has a full path, as long as the directory that would hold it is.
        if (!(e instanceof OsError) || e.errno !== 'ENOENT' || !(yield* isDirectory(sys, parentOf(full)))) throw e
      }
      yield* run.out.line(full)
    } catch (e) {
      yield* run.fail(path, e)
    }
  }
  return yield* run.end()
}

const basename: Program = function* (sys, argv) {
  const run = new Run(sys, 'basename')
  const o = options(argv, '')
  if (o.bad !== null || o.rest.length < 1 || o.rest.length > 2) return yield* run.misuse(o.bad, 'basename path [suffix]')
  let name = lastName(o.rest[0])
  const suffix = o.rest.length === 2 ? o.rest[1] : ''
  if (suffix !== '' && name !== suffix && name.endsWith(suffix)) name = name.slice(0, name.length - suffix.length)
  yield* run.out.line(name)
  return yield* run.end()
}

const dirname: Program = function* (sys, argv) {
  const run = new Run(sys, 'dirname')
  const o = options(argv, '')
  if (o.bad !== null || o.rest.length !== 1) return yield* run.misuse(o.bad, 'dirname path')
  yield* run.out.line(parentOf(o.rest[0]))
  return yield* run.end()
}

// tree

/** One run of `tree`: what to leave out, how far down to go, and the counts for the last line. */
class Drawing {
  private readonly run: Run
  private readonly all: boolean
  private readonly dirsOnly: boolean
  private readonly limit: number
  dirs = 0
  files = 0

  constructor(run: Run, all: boolean, dirsOnly: boolean, limit: number) {
    this.run = run
    this.all = all
    this.dirsOnly = dirsOnly
    this.limit = limit
  }

  /** Draws what a directory holds, each line behind `prefix` (the lines that join the levels above). */
  *below(path: string, prefix: string, depth: number): Task<void> {
    const run = this.run
    if (depth > this.limit) return
    let entries: Entry[]
    try {
      entries = yield* run.sys.list(path)
    } catch (e) {
      yield* run.fail(path, e)
      return
    }
    const shown = entries.filter((e) => (this.all || !e.name.startsWith('.')) && (!this.dirsOnly || e.kind === 'dir'))
    for (let i = 0; i < shown.length; i++) {
      const entry = shown[i]
      const last = i === shown.length - 1
      yield* run.out.line(`${prefix}${last ? '`-- ' : '|-- '}${entry.name}`)
      if (entry.kind !== 'dir') {
        this.files++
        continue
      }
      this.dirs++
      yield* this.below(join(path, entry.name), prefix + (last ? '    ' : '|   '), depth + 1)
    }
  }
}

const tree: Program = function* (sys, argv) {
  const run = new Run(sys, 'tree')
  const text = 'tree [-a] [-d] [-L depth] [dir ...]'
  const o = options(argv, 'ad', 'L')
  if (o.bad !== null) return yield* run.misuse(o.bad, text)
  let limit: number | null = DEPTH
  if (o.flags.has('L')) limit = count(o.values.get('L'), 1)
  if (limit === null) return yield* run.misuse('-L needs a whole number, 1 or more', text)
  const drawing = new Drawing(run, o.flags.has('a'), o.flags.has('d'), Math.min(limit, DEPTH))
  for (const path of o.rest.length === 0 ? ['.'] : o.rest) {
    try {
      if ((yield* sys.stat(path)).kind !== 'dir') {
        yield* run.fail(path, 'not a directory')
        continue
      }
      yield* run.out.line(path)
      yield* drawing.below(path, '', 1)
    } catch (e) {
      yield* run.fail(path, e)
    }
  }
  const dirs = `${drawing.dirs} ${drawing.dirs === 1 ? 'directory' : 'directories'}`
  yield* run.out.line('')
  yield* run.out.line(o.flags.has('d') ? dirs : `${dirs}, ${drawing.files} ${drawing.files === 1 ? 'file' : 'files'}`)
  return yield* run.end()
}

/** Every body by its name, then each behind the guard that explains a refused write to the ordinary output. */
function table(bodies: Readonly<Record<string, Program>>): Readonly<Record<string, Program>> {
  const out: Record<string, Program> = {}
  for (const name of Object.keys(bodies)) out[name] = guarded(name, bodies[name])
  return Object.freeze(out)
}

/** name -> program */
export const FILE_PROGRAMS: Readonly<Record<string, Program>> = table({
  ls, cat, mkdir, rmdir, rm, cp, mv, touch, chmod, stat, find, du, df, mount, umount, realpath, basename, dirname, tree,
})

/** name -> manual page text */
export const FILE_MANUAL: Readonly<Record<string, string>> = Object.freeze({
  ls: `NAME
    ls - list the names in a directory

USAGE
    ls [-laAd1RhFStr] [path ...]

WHAT IT DOES
    Prints the names a directory holds, in order (capital letters come
    before small ones). With no path it lists the directory you are in. A
    path that names a file is listed as that one name. Names that start
    with a dot are left out unless you ask for them. On the screen the
    names are laid out in columns, at most 80 characters wide, read down
    and then across; into a pipe or a file they go one to a line.

OPTIONS
    -l      one entry to a line: permissions, owner, size in bytes, time
            of the last change (in UTC), name
    -a      also the names that start with a dot, and . and ..
    -A      also the names that start with a dot, but not . and ..
    -d      list a directory itself, not what it holds
    -1      one name to a line
    -R      also list every directory below, each under its own heading
    -h      with -l, sizes in short form (1.5K, 20M)
    -F      mark a directory with / and a file that may be run with *
    -S      largest first
    -t      newest first
    -r      the order turned round

NOTES
    The long form shows no count of links and no group, and there is no
    "total" line. The owner is "root" for user 0, a number for anyone
    else. When -S and -t are both given, -S wins. When several paths are
    given, the files among them come first, then each directory under a
    heading.

STATUS
    0, or 1 when a path could not be listed (the others still are).

EXAMPLE
    ls -l /bin
`,
  cat: `NAME
    cat - print files one after another

USAGE
    cat [-n] [file ...]

WHAT IT DOES
    Writes each file to the output exactly as it is, byte for byte, in
    the order given. With no file, or for the name -, it copies its
    input instead, so it can stand in a pipeline or show what you type.

OPTIONS
    -n      number the lines, counting on from one file to the next

STATUS
    0, or 1 when a file could not be read (the others still are).

EXAMPLE
    cat -n /etc/hostname
`,
  mkdir: `NAME
    mkdir - make directories

USAGE
    mkdir [-p] [-m mode] dir ...

WHAT IT DOES
    Makes each directory named. The directory above it must be there
    already unless -p is given. A new directory gets every permission
    except those the shell's umask setting holds back (it names
    permissions that new files never get). Until that setting is
    changed, everyone may read a new directory and go into it, and only
    its owner may change what it holds.

OPTIONS
    -p        make the directories above as well, and do not mind when
              the directory is already there
    -m MODE   give the new directory exactly these permissions: a number
              (750) or letters (u=rwx,go=rx), as chmod reads them

STATUS
    0, or 1 when a directory could not be made (the others still are).

EXAMPLE
    mkdir -p notes/2026/november
`,
  rmdir: `NAME
    rmdir - remove empty directories

USAGE
    rmdir [-p] dir ...

WHAT IT DOES
    Removes each directory named, if it holds nothing. A directory that
    still holds something is left alone and reported; rm -r removes a
    directory together with what is in it.

OPTIONS
    -p      after removing a/b/c, remove a/b and then a as well, stopping
            at the first that cannot be removed

NOTES
    A path that ends in . or .. is refused (rm refuses it too), so the
    directory you are in is never removed by that name.

STATUS
    0, or 1 when a directory could not be removed.

EXAMPLE
    rmdir old/empty
`,
  rm: `NAME
    rm - remove files and directories

USAGE
    rm [-r] [-f] path ...

WHAT IT DOES
    Removes each file named. A directory is refused unless -r is given;
    with -r it is removed together with everything in it. What is removed
    is gone: there is no bin to take it back from, and rm never asks
    first.

OPTIONS
    -r      remove directories and everything below them (-R is the same)
    -f      say nothing about a path that does not exist, and do not
            count it as a failure

NOTES
    The root directory / is never removed, and neither is a path that
    ends in . or .. A name that ends in a slash is a directory's name:
    rm notes/ refuses when notes is a file, and keeps it (with -f it
    says nothing, as for a path that is not there). A place where
    another file system is attached (a mount point, such as /tmp)
    cannot be removed either: with -r what is inside it is removed
    first, and then the refusal is reported. Read-only places such as
    /bin refuse every removal.

STATUS
    0, or 1 when something could not be removed (the rest still is).

EXAMPLE
    rm -r /tmp/scratch
`,
  cp: `NAME
    cp - copy files and directories

USAGE
    cp [-r] source ... destination

WHAT IT DOES
    Copies one file to a new name, or one or more files into a directory
    that is already there. A file already at the destination is written
    over without a question, and keeps the permissions it had. A new
    copy has the permissions of its original, less whatever the shell's
    umask setting holds back (it names permissions that new files never
    get), and the present time. A large file is copied a piece at a
    time, never held whole.

OPTIONS
    -r      copy a directory together with everything below it (-R is the
            same); a source that ends in . or .. puts what it holds
            straight into the destination

NOTES
    A directory is never copied into itself. Devices met inside a
    directory (the files of /dev) are reported and not copied. When a
    copy fails part way, the part already written stays. A copy belongs
    to whoever made it, and there is no -p to keep the time and the
    owner of the original: mv keeps them.

STATUS
    0, or 1 when something could not be copied (the rest still is).

EXAMPLE
    cp -r notes /tmp/notes-copy
`,
  mv: `NAME
    mv - move or rename files and directories

USAGE
    mv source ... destination

WHAT IT DOES
    Gives one file or directory a new name, or moves one or more into a
    directory that is already there. A file already at the destination is
    replaced without a question; a directory there is replaced only when
    it is empty. Between two file systems (from the disk to /tmp, say)
    the source is copied, with its permissions, its time and (when root
    moves it, as at the prompt) its owner, and then removed.

NOTES
    A directory cannot be moved into itself, and a mount point (a place
    where another file system is attached) cannot be moved at all.
    Moving a file onto itself changes nothing and is no failure.
    There are no options: mv never asks before it replaces a file.

    Between two file systems, a file that cannot be moved (no room for
    the copy, or the source cannot be removed) stays where it was and
    nothing new is left at the destination. A file that was already at
    the destination, though, is written over as the copy goes, so it is
    lost even when the move fails. A directory that cannot be
    moved whole may be left partly in both places: what was copied of
    it stays, and so does what could not be removed, each reported.

STATUS
    0, or 1 when something could not be moved (the rest still is).

EXAMPLE
    mv draft.txt notes/final.txt
`,
  touch: `NAME
    touch - make an empty file, or mark a file as changed now

USAGE
    touch [-c] file ...

WHAT IT DOES
    Sets the time of last change of each file to the present moment. A
    file that is not there is made, empty. What a file holds is never
    changed.

OPTIONS
    -c      do not make a file that is not there (and say nothing of it)

NOTES
    The time is always the present one: no option sets another.

STATUS
    0, or 1 when a file could not be made or marked.

EXAMPLE
    touch notes/today.txt
`,
  chmod: `NAME
    chmod - change who may read, write and run a file

USAGE
    chmod [-R] mode path ...

WHAT IT DOES
    Sets the permissions of each path. Every file and directory has three
    sets of them: for its owner (u), for its group (g) and for everyone
    else (o). Each set says whether reading (r), writing (w) and running
    (x) are allowed; on a directory x means going into it.

    The mode is a number or letters. As a number it is octal, one digit
    for each set, adding 4 for r, 2 for w and 1 for x: 644 lets the owner
    read and write and the others only read. In letters it is a list of
    clauses with commas between them: who (any of u, g, o, or a for all
    three), then + to add, - to take away or = to set exactly, then the
    permissions. So u+x lets the owner run the file, and go-w stops
    everyone but the owner writing to it.

OPTIONS
    -R      change a directory and everything below it

NOTES
    X stands for x only on a directory, or on a file that somebody may
    run already. t is the mark of a shared directory such as /tmp, where
    only the owner of a file may remove it; as a number it is a leading
    1, so the largest mode is 1777. When no who is given, all three sets
    change, except for the permissions the shell's umask setting holds
    back. A clause cannot copy one set from another (g=u is not read).

STATUS
    0; 1 when a path could not be changed; 2 for a mode that cannot be
    read.

EXAMPLE
    chmod u+x ~/bin/backup
`,
  stat: `NAME
    stat - show what is known about a file

USAGE
    stat path ...

WHAT IT DOES
    Prints, for each path, its name, what kind of thing it is (file,
    directory or device), its size in bytes, its permissions as the
    number chmod takes and in letters, the numbers of its owner and its
    group, the number of the file system it is on (device) and its own
    number there (inode), and the time it last changed, in UTC, to the
    second.

STATUS
    0, or 1 when a path could not be read (the others still are).

EXAMPLE
    stat /etc/hostname
`,
  find: `NAME
    find - search a directory tree for files

USAGE
    find [path ...] [expression]

WHAT IT DOES
    Walks each path (the directory you are in when none is given) and
    everything below it, in order, and tries the expression on each file
    and directory it meets. With no expression, or one that names no
    action, it prints the path of everything that passes.

    An expression is a row of tests and actions. Side by side they must
    all pass; -o between two means either; ! or -not before one turns it
    round; \\( and \\) group. Patterns use * (any run of characters), ?
    (any one) and [a-z] (one of a set): put them in quotes so the shell
    leaves them alone.

OPTIONS
    -name PAT       the last name matches the pattern
    -iname PAT      the same, taking capital and small letters as equal
    -path PAT       the whole path matches the pattern
    -type f|d       it is a file (f) or a directory (d)
    -empty          a file of no bytes, or a directory holding nothing
    -size N         its size is N units; +N more than N, -N fewer. The
                    unit follows the number: c bytes, k 1024 bytes, M
                    1024k, none 512 bytes. A part of a unit counts as a
                    whole one.
    -newer FILE     it changed after FILE did
    -maxdepth N     go no more than N directories below each path
    -mindepth N     pass over what is fewer than N directories below
    -print          print the path
    -delete         remove it (a directory only when it is empty); what
                    a directory holds is then visited before it is
    -exec CMD ;     run CMD, every {} in its words replaced by the path;
                    it passes when CMD ends with status 0. Type the ; as
                    \\; so the shell hands it on.
    -a              and (the same as writing nothing between two)

NOTES
    -delete is refused for a search that starts at the root directory /,
    and it never removes the path the search started at when that is
    spelled . or .. CMD must be a program (one of the names in /bin, or
    a path), not a command the shell does by itself such as echo; for
    those run sh -c. The form of -exec that ends in + is not there, and
    neither are -prune, -mtime and -user. A directory always counts as
    size 0, and so does a file of /proc or /sys (it is made when it is
    read). A walk goes at most 64 directories down, which is as deep as
    the file system itself goes.

STATUS
    0; 1 when a path could not be read or removed, or a command could not
    be run; 2 for an expression that cannot be read.

EXAMPLE
    find . -name '*.txt' -size +10k
`,
  du: `NAME
    du - add up the space files take

USAGE
    du [-s] [-h] [path ...]

WHAT IT DOES
    Adds up the bytes of every file below each path (the directory you
    are in when none is given) and prints a total for each directory, the
    deepest first and the path itself last. Sizes are in units of 1024
    bytes, a part of a unit counting as a whole one.

OPTIONS
    -s      print only the total for each path
    -h      sizes in short form (512, 1.5K, 20M) instead of units

NOTES
    Only the bytes in files are counted: a directory itself counts as
    nothing, and so do devices and the files of /proc and /sys (they are
    made when they are read). A file given as a path gets a line of its
    own; files met below a directory are added in but not listed.

STATUS
    0, or 1 when something could not be read.

EXAMPLE
    du -sh /home/operator
`,
  df: `NAME
    df - show how full each file system is

USAGE
    df [-h] [path ...]

WHAT IT DOES
    Prints a line for each mounted file system: what it is made from, its
    type, its size, how much is used and how much is free, the share used
    as a percentage, and the path where it is attached. With paths, only
    the file systems those paths are on. Sizes are in units of 1024
    bytes, a part of a unit counting as a whole one.

OPTIONS
    -h      sizes in short form (512, 1.5K, 20M) instead of units

NOTES
    A file system with no storage of its own (/proc, /sys, /dev) shows -
    in place of its numbers.

STATUS
    0, or 1 when a path does not exist.

EXAMPLE
    df -h
`,
  mount: `NAME
    mount - show which file systems are attached where

USAGE
    mount

WHAT IT DOES
    Prints a line for each mounted file system: what it is made from, the
    path where it is attached, its type, and ro (it can only be read) or
    rw (it can be written too). The same list is in /proc/mounts.

NOTES
    Attaching a folder from the prompt is not available yet: given any
    argument, mount says so and does nothing.

STATUS
    0, or 1 when it was asked to attach something.

EXAMPLE
    mount
`,
  umount: `NAME
    umount - detach a mounted file system

USAGE
    umount path ...

WHAT IT DOES
    Takes away the file system attached at each path, leaving the empty
    directory that was under it. Nothing on it is removed, but it cannot
    be reached until it is attached again, and nothing at the prompt can
    attach it yet. It is refused while a file on it is open, while a task
    is working in it, or while another file system is attached inside it.
    The root file system / always stays, and so do the system's own:
    /bin, /usr, /tmp, /dev, /proc and /sys.

STATUS
    0, or 1 when a path could not be detached.

EXAMPLE
    umount /mnt/folder
`,
  realpath: `NAME
    realpath - print a path in full

USAGE
    realpath path ...

WHAT IT DOES
    Prints each path as the file system reads it: starting from /, with
    every . and .. and doubled slash worked out. The path must be there,
    or at least the directory that would hold it must.

STATUS
    0, or 1 when a path leads nowhere (the others are still printed).

EXAMPLE
    realpath ../notes
`,
  basename: `NAME
    basename - print the last name of a path

USAGE
    basename path [suffix]

WHAT IT DOES
    Prints what follows the last slash of the path: the name of a file
    without the directories before it. Slashes at the end are passed
    over. When a suffix is given and the name ends with it, the suffix is
    cut off as well. The path is only text: nothing is looked up.

STATUS
    0, or 2 when not called with one path and at most one suffix.

EXAMPLE
    basename /home/operator/notes.txt .txt
`,
  dirname: `NAME
    dirname - print a path without its last name

USAGE
    dirname path

WHAT IT DOES
    Prints what comes before the last slash of the path: the directory a
    file is in. A name with no slash gives . (the directory you are in).
    The path is only text: nothing is looked up.

STATUS
    0, or 2 when not called with exactly one path.

EXAMPLE
    dirname /home/operator/notes.txt
`,
  tree: `NAME
    tree - draw a directory and what is below it

USAGE
    tree [-a] [-d] [-L depth] [dir ...]

WHAT IT DOES
    Prints each directory (the one you are in when none is given) and,
    under it and joined to it by lines, everything it holds, in order.
    The last line counts the directories and files that were shown.
    Names that start with a dot are left out unless -a is given.

OPTIONS
    -a          also the names that start with a dot
    -d          directories only (the last line then counts only those)
    -L DEPTH    go no more than DEPTH levels down (1 shows only what the
                directory itself holds)

STATUS
    0, or 1 when a directory could not be read.

EXAMPLE
    tree -L 2 /usr
`,
})
