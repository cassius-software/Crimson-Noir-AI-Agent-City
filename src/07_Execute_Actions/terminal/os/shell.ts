// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the console's shell: the program that reads what the person typed, or a script,
 * and runs it. It takes the tree the parser made and does what it says: expands each word (variables, `$(command)`,
 * sums, `~`, patterns over file names), opens the files a redirection names, starts each program of a pipeline as
 * its own task with pipes between them, waits for them, and carries the status from one command to the next for
 * `&&`, `||`, `if` and `while`. It keeps the shell's own state (variables, the directory, jobs sent to the
 * background) and has the few commands that must run inside it (`cd`, `export`, `read`, `wait` ...). The city's own
 * commands stay the city's: the shell hands one to the console's handler with its words as typed and shows what
 * the handler answered, so a pipeline can begin with `stats` and end with `grep`.
 * What breaks if it is removed? There are programs and files but no way to run one from the console.
 */
import { sum, SumError } from './arith.ts'
import { concat, decode, encode } from './bytes.ts'
import { evaluate } from './cond.ts'
import { OsError, reasonOf } from './errno.ts'
import { DEFAULT_PATH, READ_ALL_MAX } from './kernel.ts'
import type { Program, Sys } from './kernel.ts'
import { NO_CITY, ShellSyntax, parse } from './parser.ts'
import type { AndOr, CityNames, Command, List, Pipeline, Redirect, Seg, Simple, Word } from './parser.ts'
import { hasPattern, matches } from './path.ts'
import { PIPE_MAX } from './pipe.ts'
import type { Later, Task } from './task.ts'
import { O_APPEND, O_CREATE, O_READ, O_TRUNC, O_WRITE } from './vfs.ts'

/** One line a city command answered: ordinary, or an error. */
export interface CityLine { readonly err: boolean; readonly text: string }

/** What a city command answered. */
export interface CityResult {
  readonly lines: readonly CityLine[]
  /** More lines that arrive later, or null. */
  readonly later: Later<readonly CityLine[]> | null
  /** When the host shows the answer itself (a direct call): what to hand it, in order with the lines around it. */
  readonly post?: unknown
  /** The status of a posted answer: 0, or 1 when it held an error line. */
  readonly status?: number
}

/** The city's commands as the shell runs them. */
export interface CityHost extends CityNames {
  /**
   * Runs one. `direct` says the answer would go straight to the console with nothing in between (no pipe, no
   * redirection): the host may then show it itself and answer with `post`.
   */
  run(name: string, args: readonly string[], line: string, direct: boolean): CityResult
}

const NO_HOST: CityHost = Object.freeze({ ...NO_CITY, run: (): CityResult => ({ lines: [], later: null }) })

/** The most names a pattern may expand to. */
const MATCHES_MAX = 16384
/**
 * The most characters one word may expand to (what one `$( )` may give), and all the words of one command together
 * twice that. Without them `x="$x$x"` in a loop doubles a value until the host itself refuses to hold it.
 */
const WORD_MAX = READ_ALL_MAX
/**
 * The most fields the words of one command may expand to. A field costs far more memory than its text: a value of a
 * few MiB split at every blank would hold the page up for seconds and take a GiB, one of 64 MiB more than there is.
 */
const FIELDS_MAX = 1 << 18
/** The most turns of nested `source` and command substitution. */
const NEST_MAX = 32
/**
 * The most lists one task runs inside one another (the body of a loop, a group, an `if`, a script read with source:
 * each is one more). Every one deepens the host's own stack while it runs, and a script that reads itself through
 * loops nested as deep as the parser allows would run that stack out long before NEST_MAX.
 */
const DEPTH_MAX = 256
/** What the shell calls itself in a message. */
const SELF = 'ash'

/** `break`, `continue` or `return` on its way out. */
class Jump {
  readonly kind: 'break' | 'continue' | 'return'
  depth: number
  readonly status: number
  constructor(kind: 'break' | 'continue' | 'return', depth: number, status: number) {
    this.kind = kind
    this.depth = depth
    this.status = status
  }
}

/** A command the shell could not carry out (a bad substitution, a sum that is none): the message is shown, the line is given up. */
class Trouble extends Error {}

/** Ctrl+C reached the console's shell: the line it was running is given up. */
class Interrupted {}

interface Job { readonly id: number; readonly pids: readonly number[]; readonly pgid: number; readonly text: string }

interface Piece { readonly s: string; readonly q: boolean }

class State {
  readonly vars = new Map<string, string>()
  readonly exported = new Set<string>()
  params: string[] = []
  name = 'sh'
  /** What `$$` gives: the number of the shell itself, also in the tasks it starts for a pipe, a `$( )` or a job. */
  pid = 0
  status = 0
  lastBg = 0
  /** Reads the terminal and gives each job its own group. */
  interactive = false
  /** The console's own shell: city commands answer straight to the console, and `exit` is the console's. */
  session = false
  jobs: Job[] = []
  nextJob = 1
  loops = 0
  nest = 0
  /** Lists running inside one another in this task, up to DEPTH_MAX. */
  depth = 0

  clone(): State {
    const c = new State()
    for (const [k, v] of this.vars) c.vars.set(k, v)
    for (const k of this.exported) c.exported.add(k)
    c.params = this.params.slice()
    c.name = this.name
    c.pid = this.pid
    c.status = this.status
    c.lastBg = this.lastBg
    // A pipeline's stage or a job is no deeper than the line it came from: only a `$( )` counts one more.
    c.nest = this.nest
    return c
  }
}

const isBlank = (c: string): boolean => c === ' ' || c === '\t' || c === '\n'

/** How `pieces` treats an unquoted expansion. */
const SPLIT = 0
const WHOLE = 1
const PATTERN = 2

/** A text as a pattern that matches only itself. */
function literal(text: string): string {
  return text.replace(/[\\*?[\]]/g, '\\$&')
}

type Builtin = (this: Shell, argv: string[]) => Task<number>

class Shell {
  private readonly sys: Sys
  private readonly city: CityHost
  private readonly st: State
  /** Descriptors from 3 up that a redirection opened for the command being run: a child is given these too. */
  private extra = new Set<number>()
  /** The status of the last command substitution, for a command that is only assignments. */
  private lastSub = 0

  /** The city's commands as this shell's parser sees them: a name the shell has a builtin for is the shell's. */
  private readonly names: CityNames

  constructor(sys: Sys, city: CityHost, st: State = new State()) {
    this.sys = sys
    this.city = city
    this.st = st
    this.names = { has: (name) => !Object.hasOwn(BUILTINS, name) && city.has(name), whole: (name) => city.whole(name) }
  }

  // Variables.

  private get(name: string): string | undefined {
    const st = this.st
    switch (name) {
      case '?': return String(st.status)
      case '$': return String(st.pid)
      case '!': return st.lastBg === 0 ? undefined : String(st.lastBg)
      case '#': return String(st.params.length)
      case '0': return st.name
      case '-': return st.interactive ? 'i' : ''
      case '@': case '*': return st.params.length === 0 ? undefined : st.params.join(' ')
    }
    if (name.length === 1 && name >= '1' && name <= '9') return st.params[Number(name) - 1]
    return st.vars.get(name)
  }

  private set(name: string, value: string): void {
    this.st.vars.set(name, value)
    if (this.st.exported.has(name)) this.sys.env.set(name, value)
  }

  private unset(name: string): void {
    this.st.vars.delete(name)
    if (this.st.exported.delete(name)) this.sys.env.delete(name)
  }

  private environment(): Map<string, string> {
    const env = new Map<string, string>()
    for (const name of this.st.exported) {
      const v = this.st.vars.get(name)
      if (v !== undefined) env.set(name, v)
    }
    return env
  }

  // Expansion.

  /** The value a `$...` piece stands for: `list` for `$@` and `$*` (one text for each parameter), else `text`. */
  private *variable(seg: Extract<Seg, { t: 'var' }>): Task<{ list: string[] | null; text: string }> {
    const { name, op } = seg
    const many = name === '@' || name === '*'
    const base = this.get(name)
    const text = (v: string) => ({ list: null, text: v })
    switch (op) {
      case '':
        return many ? { list: this.st.params.slice(), text: '' } : text(base ?? '')
      case 'len':
        return text(String(many ? this.st.params.length : (base ?? '').length))
      case ':-': case '-':
        if (base === undefined || (op === ':-' && base === '')) return text(yield* this.one(seg.arg ?? []))
        return text(base)
      case ':=': case '=': {
        if (base !== undefined && !(op === ':=' && base === '')) return text(base)
        if (!/^[A-Za-z_]/.test(name)) throw new Trouble(`${name}: cannot be given a value this way`)
        const v = yield* this.one(seg.arg ?? [])
        this.set(name, v)
        return text(v)
      }
      case ':+': case '+':
        if (base === undefined || (op === ':+' && base === '')) return text('')
        return text(yield* this.one(seg.arg ?? []))
      case ':?': case '?': {
        if (base !== undefined && !(op === ':?' && base === '')) return text(base)
        const why = yield* this.one(seg.arg ?? [])
        throw new Trouble(`${name}: ${why !== '' ? why : base === undefined ? 'parameter not set' : 'parameter is empty'}`)
      }
      default: {
        // % %% # ##: the value with the shortest or longest matching end or start removed. Each end tried counts as a
        // step, so a long value cannot hold the other tasks up, and Ctrl+C gives it up.
        const value = base ?? ''
        const pattern = yield* this.pattern(seg.arg ?? [])
        const n = value.length
        const start = op === '#' || op === '##'
        const upward = op === '#' || op === '%%'
        for (let k = 0; k <= n; k++) {
          yield* this.sys.step()
          this.interruptCheck()
          const i = upward ? k : n - k
          const cut = start ? value.slice(0, i) : value.slice(i)
          if (matches(pattern, cut, true)) return text(start ? value.slice(i) : value.slice(0, i))
        }
        return text(value)
      }
    }
  }

  /**
   * A word as fields of pieces. SPLIT cuts an unquoted expansion into fields at blanks; WHOLE keeps the word one
   * field and marks every piece quoted; PATTERN keeps it one field and keeps which pieces were typed bare, so the
   * pattern characters in those still count.
   */
  private *pieces(word: Word, mode: 0 | 1 | 2): Task<Piece[][]> {
    const fields: Piece[][] = []
    let cur: Piece[] = []
    let has = false
    let size = 0
    const grow = (n: number): void => {
      size += n
      if (size > WORD_MAX) throw new Trouble(`a word may expand to at most ${WORD_MAX} characters`)
    }
    const push = (field: Piece[]): void => {
      if (fields.length >= FIELDS_MAX) throw new Trouble(`a command may expand to at most ${FIELDS_MAX} words`)
      fields.push(field)
    }
    const end = (): void => {
      if (has) push(cur)
      cur = []
      has = false
    }
    const quoted = (s: string): void => {
      grow(s.length)
      cur.push({ s, q: true })
      has = true
    }
    const loose = (s: string): void => {
      grow(s.length)
      if (mode !== SPLIT) {
        if (s !== '') { cur.push({ s, q: mode === WHOLE }); has = true }
        return
      }
      let i = 0
      while (i < s.length) {
        if (isBlank(s[i])) {
          end()
          while (i < s.length && isBlank(s[i])) i++
          continue
        }
        let j = i
        while (j < s.length && !isBlank(s[j])) j++
        cur.push({ s: s.slice(i, j), q: false })
        has = true
        i = j
      }
    }
    for (const seg of word) {
      switch (seg.t) {
        case 'lit':
          if (seg.q) quoted(seg.s)
          else if (seg.s !== '') { grow(seg.s.length); cur.push({ s: seg.s, q: false }); has = true }
          break
        case 'home': {
          const home = seg.user === '' ? this.get('HOME') : seg.user === 'root' || seg.user === 'operator' ? '/home/operator' : undefined
          quoted(home === undefined || home === '' ? `~${seg.user}` : home)
          break
        }
        case 'var': {
          const v = yield* this.variable(seg)
          if (v.list !== null) {
            if (seg.q && seg.name === '@') {
              v.list.forEach((p, k) => {
                if (k > 0) { push(cur); cur = []; has = false }
                quoted(p)
              })
            } else if (seg.q) quoted(v.list.join(' '))
            else v.list.forEach((p, k) => { if (k > 0) end(); loose(p) })
          } else if (seg.q) quoted(v.text)
          else loose(v.text)
          break
        }
        case 'cmd': {
          const out = yield* this.substitute(seg.body)
          if (seg.q) quoted(out)
          else loose(out)
          break
        }
        case 'sum': {
          const text = yield* this.one(seg.text)
          let n: number
          try {
            n = sum(text, { get: (name) => this.get(name), set: (name, value) => this.set(name, value) })
          } catch (e) {
            if (e instanceof SumError) throw new Trouble(`$((${text})): ${e.message}`)
            throw e
          }
          quoted(String(n))
          break
        }
      }
    }
    end()
    return fields
  }

  /** A word as one text: nothing is split and no pattern is read (an assignment, a file name after `>`). */
  private *one(word: Word): Task<string> {
    const fields = yield* this.pieces(word, WHOLE)
    return fields.map((f) => f.map((p) => p.s).join('')).join(' ')
  }

  /** A word as a pattern: its quoted pieces match only themselves. */
  private *pattern(word: Word): Task<string> {
    const fields = yield* this.pieces(word, PATTERN)
    return fields.map((f) => f.map((p) => (p.q ? literal(p.s) : p.s)).join('')).join(' ')
  }

  /** The words of a command as the arguments it gets: expanded, split into fields, patterns matched against file names. */
  private *words(words: readonly Word[]): Task<string[]> {
    const out: string[] = []
    let size = 0
    const add = (text: string): void => {
      if (out.length >= FIELDS_MAX) throw new Trouble(`a command may expand to at most ${FIELDS_MAX} words`)
      size += text.length
      if (size > 2 * WORD_MAX) throw new Trouble(`the words of a command may expand to at most ${2 * WORD_MAX} characters`)
      out.push(text)
    }
    for (const word of words) {
      for (const field of yield* this.pieces(word, SPLIT)) {
        const text = field.map((p) => p.s).join('')
        if (!field.some((p) => !p.q && hasPattern(p.s))) { add(text); continue }
        const pattern = field.map((p) => (p.q ? literal(p.s) : p.s.replace(/\\/g, '\\\\'))).join('')
        const found = yield* this.glob(pattern)
        if (found.length === 0) add(text)
        else for (const f of found) add(f)
      }
    }
    return out
  }

  /** The paths a pattern matches, sorted; none when it matches nothing. */
  private *glob(pattern: string): Task<string[]> {
    // Cut at each slash that is not escaped.
    const comps: string[] = []
    let cur = ''
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i]
      if (c === '\\' && i + 1 < pattern.length) { cur += c + pattern[++i]; continue }
      if (c === '/') { comps.push(cur); cur = ''; continue }
      cur += c
    }
    comps.push(cur)
    const absolute = comps[0] === '' && comps.length > 1
    // A pattern that ends in a slash names directories only, and each name it gives keeps the slash.
    const dirs = comps.length > 1 && comps[comps.length - 1] === ''
    let bases: string[] = [absolute ? '/' : '']
    const names = comps.filter((c) => c !== '')
    for (let n = 0; n < names.length; n++) {
      const comp = names[n]
      const more = n + 1 < names.length || dirs
      const next: string[] = []
      for (const base of bases) {
        const join = (name: string): string => (base === '' ? name : base.endsWith('/') ? base + name : `${base}/${name}`)
        if (!hasPattern(comp)) {
          const path = join(comp.replace(/\\(.)/g, '$1'))
          if (yield* this.sys.access(more ? `${path}/` : path, 0)) next.push(path)
          continue
        }
        let entries
        try {
          entries = yield* this.sys.list(base === '' ? '.' : base)
        } catch (e) {
          if (e instanceof OsError) continue
          throw e
        }
        for (const e of entries) {
          if (more && e.kind !== 'dir') continue
          if (matches(comp, e.name)) next.push(join(e.name))
          if (next.length > MATCHES_MAX) throw new Trouble('a pattern matches too many names')
        }
      }
      bases = next
      if (bases.length === 0) return []
    }
    if (dirs) bases = bases.map((b) => (b.endsWith('/') ? b : `${b}/`))
    return bases.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  }

  /** What a command writes to its ordinary output, with the line ends at its end removed. */
  private *substitute(body: List): Task<string> {
    if (this.st.nest >= NEST_MAX) throw new Trouble('command substitution nested too deep')
    const sys = this.sys
    const [r0, w0] = sys.pipe()
    let r: number
    let w: number
    try {
      r = this.high(r0)
    } catch (e) {
      sys.close(w0)
      throw e
    }
    try {
      w = this.high(w0)
    } catch (e) {
      sys.close(r)
      throw e
    }
    const sub = this.st.clone()
    sub.nest++
    const city = this.city
    const fds = this.fdList()
    fds[1] = w
    let pid: number
    try {
      pid = yield* sys.spawn([this.st.name], { program: (s2) => new Shell(s2, city, sub).inside(body), fds, group: this.st.interactive ? 'new' : undefined })
    } catch (e) {
      sys.close(r)
      throw e
    } finally {
      sys.close(w)
    }
    if (this.st.interactive) sys.foreground(pid)
    let out: string
    try {
      out = decode(yield* sys.readAll(r))
    } finally {
      sys.close(r)
      // The task is collected even when what it wrote was too much to keep: with the pipe closed, it ends.
      try {
        this.lastSub = yield* sys.wait(pid)
      } finally {
        if (this.st.interactive) sys.foreground(sys.pgid)
      }
    }
    this.interruptCheck()
    return out.replace(/\n+$/, '')
  }

  // Descriptors.

  /** Moves a descriptor out of the way of the ones a command may name (0 to 9). */
  private high(fd: number): number {
    if (fd >= 10) return fd
    try {
      return this.sys.dup(fd, 10)
    } finally {
      this.sys.close(fd)
    }
  }

  /** The descriptors a child is given, by this shell's numbers: 0, 1, 2 and any a redirection opened from 3 to 9. */
  private fdList(): (number | null)[] {
    const fds: (number | null)[] = []
    let top = 2
    for (const fd of this.extra) if (fd > top) top = fd
    for (let fd = 0; fd <= top; fd++) fds.push((fd <= 2 || this.extra.has(fd)) && this.sys.isOpen(fd) ? fd : null)
    return fds
  }

  /**
   * Runs `body` with the redirections in force, and puts the shell's own descriptors back afterwards (unless `keep`:
   * the task is about to become the command, and will never need them back). A file that cannot be opened is
   * reported and the command is not run (status 1).
   */
  private *redirected(redirects: readonly Redirect[], body: () => Task<number>, keep = false): Task<number> {
    if (redirects.length === 0) return yield* body()
    const sys = this.sys
    const saved: { fd: number; copy: number }[] = []
    const before = this.extra
    this.extra = new Set(before)
    try {
      for (const r of redirects) {
        let from = -1
        let close = true
        if (r.op === '<<') {
          const text = encode(yield* this.one(r.here ?? []))
          if (text.length > PIPE_MAX) { yield* sys.eprint(`${SELF}: a heredoc is longer than ${PIPE_MAX} bytes\n`); return 1 }
          const [pr, pw] = sys.pipe()
          try {
            if (text.length > 0) yield* sys.write(pw, text)
          } finally {
            sys.close(pw)
          }
          from = this.high(pr)
        } else {
          const word = yield* this.one(r.word)
          if (r.op === '>&' || r.op === '<&') {
            if (word !== '-') {
              if (!/^[0-9]$/.test(word) || !sys.isOpen(Number(word))) { yield* sys.eprint(`${SELF}: ${word}: bad descriptor\n`); return 1 }
              from = Number(word)
              close = false
            }
          } else {
            const flags = r.op === '<' ? O_READ : r.op === '>' ? O_WRITE | O_CREATE | O_TRUNC : O_WRITE | O_CREATE | O_APPEND
            try {
              from = this.high(yield* sys.open(word, flags))
            } catch (e) {
              if (!(e instanceof OsError)) throw e
              yield* sys.eprint(`${SELF}: ${word}: ${e.message}\n`)
              return 1
            }
          }
        }
        const was = sys.isOpen(r.fd)
        if (!keep) {
          let copy = -1
          if (was) {
            try {
              copy = sys.dup(r.fd, 10)
            } catch (e) {
              if (from >= 0 && close) sys.close(from)
              if (!(e instanceof OsError)) throw e
              yield* sys.eprint(`${SELF}: ${e.message}\n`)
              return 1
            }
          }
          saved.push({ fd: r.fd, copy })
        }
        if (from < 0) { if (was) sys.close(r.fd) }
        else if (from !== r.fd) {
          sys.dup2(from, r.fd)
          if (close) sys.close(from)
        }
        if (r.fd >= 3) this.extra.add(r.fd)
      }
      return yield* body()
    } finally {
      for (let i = saved.length - 1; i >= 0; i--) {
        const s = saved[i]
        if (s.copy >= 0) {
          sys.dup2(s.copy, s.fd)
          sys.close(s.copy)
        } else if (sys.isOpen(s.fd)) sys.close(s.fd)
      }
      this.extra = before
    }
  }

  // Running.

  private interruptCheck(): void {
    if (this.st.session && this.sys.interrupted()) throw new Interrupted()
  }

  *list(list: List): Task<number> {
    const st = this.st
    if (st.depth >= DEPTH_MAX) throw new Trouble('commands nested too deep')
    st.depth++
    try {
      let status = st.status
      for (const item of list.items) {
        this.interruptCheck()
        status = item.bg ? yield* this.background(item.cmd, item.text) : yield* this.andOr(item.cmd)
        st.status = status
      }
      return status
    } finally {
      st.depth--
    }
  }

  private *andOr(a: AndOr): Task<number> {
    let status = yield* this.pipeline(a.first)
    for (const r of a.rest) {
      // Ctrl+C gives the rest up even when what it cut short answered with a status of its own (`read x || ...`).
      this.interruptCheck()
      if ((r.op === '&&') === (status === 0)) status = yield* this.pipeline(r.cmd)
    }
    return status
  }

  private *pipeline(p: Pipeline): Task<number> {
    let status = p.cmds.length === 1 ? yield* this.command(p.cmds[0], false) : yield* this.pipe(p.cmds)
    if (p.negate) status = status === 0 ? 1 : 0
    this.st.status = status
    return status
  }

  /** Waits for the tasks of a job that has the terminal; the last one's status. */
  private *foreground(pids: readonly number[], pgid: number): Task<number> {
    const sys = this.sys
    if (this.st.interactive) sys.foreground(pgid)
    let status = 0
    try {
      for (const pid of pids) status = yield* sys.wait(pid)
    } finally {
      if (this.st.interactive) sys.foreground(sys.pgid)
    }
    this.interruptCheck()
    return status
  }

  private *pipe(cmds: readonly Command[]): Task<number> {
    const sys = this.sys
    const pids: number[] = []
    let pgid: number | undefined
    let prev = -1
    try {
      for (let i = 0; i < cmds.length; i++) {
        const last = i === cmds.length - 1
        let r = -1
        let w = -1
        if (!last) {
          const [r0, w0] = sys.pipe()
          try {
            r = this.high(r0)
          } catch (e) {
            sys.close(w0)
            throw e
          }
          try {
            w = this.high(w0)
          } catch (e) {
            sys.close(r)
            throw e
          }
        }
        const fds = this.fdList()
        if (prev >= 0) fds[0] = prev
        if (!last) fds[1] = w
        const cmd = cmds[i]
        const sub = this.st.clone()
        const city = this.city
        try {
          const pid = yield* sys.spawn([this.st.name], { program: (s2) => new Shell(s2, city, sub).stage(cmd), fds, group: this.st.interactive ? (pgid ?? 'new') : undefined })
          if (pgid === undefined) {
            pgid = pid
            // The job takes the terminal as soon as its first stage exists: a first stage that runs before the rest
            // are started must find the terminal its own, and a Ctrl+C typed meanwhile must reach the job.
            if (this.st.interactive) sys.foreground(pgid)
          }
          pids.push(pid)
        } catch (e) {
          if (r >= 0) sys.close(r)
          throw e
        } finally {
          if (prev >= 0) sys.close(prev)
          if (w >= 0) sys.close(w)
          prev = -1
        }
        prev = r
      }
    } catch (e) {
      if (prev >= 0) sys.close(prev)
      if (!(e instanceof OsError)) throw e
      yield* sys.eprint(`${SELF}: cannot start a pipeline: ${e.message}\n`)
      // What did start is asked to end, then collected. Its pipes are closed now, but a first stage that reads the
      // terminal would not end by itself: it would take the lines typed next, meant for the shell.
      for (const pid of pids) {
        try {
          sys.stop(pid)
        } catch (e2) {
          if (!(e2 instanceof OsError)) throw e2
        }
      }
      if (pids.length > 0 && pgid !== undefined) yield* this.foreground(pids, pgid)
      return 1
    }
    return yield* this.foreground(pids, pgid ?? sys.pgid)
  }

  /** The body of a pipeline's stage: one command, as its own task. */
  *stage(cmd: Command): Task<number> {
    return yield* this.guarded(() => this.command(cmd, true))
  }

  /** The body of a `$( )` or of a job sent to the background: a list, as its own task. */
  *inside(body: List): Task<number> {
    return yield* this.guarded(() => this.list(body))
  }

  /** Runs a body to its status, turning what a script may throw on purpose into one. */
  private *guarded(body: () => Task<number>): Task<number> {
    try {
      return yield* body()
    } catch (e) {
      if (e instanceof Jump) return e.status
      if (e instanceof Trouble) {
        yield* this.sys.eprint(`${SELF}: ${e.message}\n`)
        return 2
      }
      if (e instanceof Interrupted) return 130
      throw e
    }
  }

  private *background(cmd: AndOr, text: string): Task<number> {
    const sys = this.sys
    // Jobs that ended are collected first, so a script or a line that starts many never fills the task table. At the
    // terminal the shell says how each ended, as its prompt would; written anywhere else, that word could be refused.
    yield* this.reap(this.st.interactive && sys.isatty(1))
    const sub = this.st.clone()
    const city = this.city
    let nul = -1
    try {
      nul = this.high(yield* sys.open('/dev/null', O_READ))
    } catch (e) {
      if (!(e instanceof OsError)) throw e
    }
    const fds = this.fdList()
    fds[0] = nul >= 0 ? nul : null
    try {
      const body: List = { items: [{ cmd, bg: false, text }] }
      const pid = yield* sys.spawn([this.st.name], { program: (s2) => new Shell(s2, city, sub).inside(body), fds, group: 'new' })
      this.st.lastBg = pid
      const id = this.st.nextJob++
      this.st.jobs.push({ id, pids: [pid], pgid: pid, text })
      if (this.st.interactive) yield* sys.print(`[${id}] ${pid}\n`)
      return 0
    } catch (e) {
      if (!(e instanceof OsError)) throw e
      yield* sys.eprint(`${SELF}: cannot start a job: ${e.message}\n`)
      return 1
    } finally {
      if (nul >= 0) sys.close(nul)
    }
  }

  /** Runs one command. `final` says this task has nothing to do afterwards, so it may become the command itself. */
  private *command(cmd: Command, final: boolean): Task<number> {
    switch (cmd.t) {
      case 'simple':
        return yield* this.simple(cmd, final)
      case 'city':
        return yield* this.redirected(cmd.redirects, () => this.cityRun(cmd.name, cmd.args, cmd.line, cmd.redirects.length === 0), final)
      case 'group':
        return yield* this.redirected(cmd.redirects, () => this.list(cmd.body), final)
      case 'if':
        return yield* this.redirected(cmd.redirects, () => this.branch(cmd.clauses, cmd.otherwise), final)
      case 'loop':
        return yield* this.redirected(cmd.redirects, () => this.loop(cmd.until, cmd.cond, cmd.body), final)
      case 'for':
        return yield* this.redirected(cmd.redirects, () => this.each(cmd.name, cmd.words, cmd.body), final)
    }
  }

  private *branch(clauses: readonly { readonly cond: List; readonly then: List }[], otherwise: List | null): Task<number> {
    for (const c of clauses) {
      if ((yield* this.list(c.cond)) === 0) {
        if (c.then.items.length === 0) return 0
        return yield* this.list(c.then)
      }
    }
    if (otherwise === null || otherwise.items.length === 0) return 0
    return yield* this.list(otherwise)
  }

  /** Runs a loop's body once; 'break' or 'continue' when the body asked for this loop to. */
  private *turn(body: List, status: { value: number }): Task<'on' | 'break' | 'continue'> {
    try {
      if (body.items.length > 0) status.value = yield* this.list(body)
      return 'on'
    } catch (e) {
      if (!(e instanceof Jump) || e.kind === 'return') throw e
      if (e.depth > 1) {
        e.depth--
        throw e
      }
      return e.kind
    }
  }

  private *loop(until: boolean, cond: List, body: List): Task<number> {
    const status = { value: 0 }
    this.st.loops++
    try {
      for (;;) {
        yield* this.sys.step()
        this.interruptCheck()
        const held = { value: 0 }
        const asked = yield* this.turn(cond, held)
        if (asked === 'break') break
        if (asked === 'continue') continue
        if ((held.value === 0) === until) break
        if ((yield* this.turn(body, status)) === 'break') break
      }
    } finally {
      this.st.loops--
    }
    return status.value
  }

  private *each(name: string, words: readonly Word[] | null, body: List): Task<number> {
    const values = words === null ? this.st.params.slice() : yield* this.words(words)
    const status = { value: 0 }
    this.st.loops++
    try {
      for (const v of values) {
        yield* this.sys.step()
        this.interruptCheck()
        this.set(name, v)
        if ((yield* this.turn(body, status)) === 'break') break
      }
    } finally {
      this.st.loops--
    }
    return status.value
  }

  private *simple(cmd: Simple, final: boolean): Task<number> {
    this.lastSub = 0
    const argv = yield* this.words(cmd.words)
    if (argv.length === 0) {
      for (const a of cmd.assigns) this.set(a.name, yield* this.one(a.value))
      if (cmd.redirects.length > 0) return yield* this.redirected(cmd.redirects, function* () { return 0 }, final)
      return this.lastSub
    }
    const name = argv[0]
    const builtin = Object.hasOwn(BUILTINS, name) ? BUILTINS[name] : undefined
    if (builtin !== undefined) {
      // NAME=value before a builtin holds for that command only: afterwards (or when a later value cannot be
      // expanded) each name is as it was, exported or not, the last one held first so that a name given twice ends
      // with the value it had before both.
      const held: { name: string; value: string | undefined; exported: boolean }[] = []
      try {
        for (const a of cmd.assigns) {
          held.push({ name: a.name, value: this.st.vars.get(a.name), exported: this.st.exported.has(a.name) })
          this.set(a.name, yield* this.one(a.value))
        }
        return yield* this.redirected(cmd.redirects, () => this.runBuiltin(builtin, argv), final)
      } finally {
        for (let i = held.length - 1; i >= 0; i--) {
          const h = held[i]
          if (h.value === undefined) this.unset(h.name)
          else this.set(h.name, h.value)
          if (h.exported) this.st.exported.add(h.name)
        }
      }
    }
    if (this.names.has(name)) {
      return yield* this.redirected(cmd.redirects, () => this.cityRun(name, argv.slice(1), argv.join(' '), cmd.redirects.length === 0), final)
    }
    const env = this.environment()
    for (const a of cmd.assigns) env.set(a.name, yield* this.one(a.value))
    return yield* this.redirected(cmd.redirects, () => this.external(argv, env, final), final)
  }

  private *external(argv: string[], env: Map<string, string>, final: boolean): Task<number> {
    const sys = this.sys
    try {
      if (final) return yield* sys.exec(argv, env)
      const pid = yield* sys.spawn(argv, { env, fds: this.fdList(), group: this.st.interactive ? 'new' : undefined })
      return yield* this.foreground([pid], pid)
    } catch (e) {
      if (!(e instanceof OsError)) throw e
      const name = argv[0]
      if (e.errno === 'ENOENT') { yield* sys.eprint(`${SELF}: ${name}: not found\n`); return 127 }
      if (e.errno === 'ENOEXEC') {
        // A text file that may be run but names no interpreter is a script for this shell.
        const path = yield* this.find(name, env.get('PATH'))
        if (path !== null) {
          const city = this.city
          const body: Program = (s2, a2) => new Shell(s2, city).main(a2)
          try {
            const pid = yield* sys.spawn(['sh', path, ...argv.slice(1)], { env, program: body, fds: this.fdList(), group: this.st.interactive ? 'new' : undefined })
            return yield* this.foreground([pid], pid)
          } catch (e2) {
            if (!(e2 instanceof OsError)) throw e2
            yield* sys.eprint(`${SELF}: ${name}: ${e2.message}\n`)
            return 126
          }
        }
      }
      yield* sys.eprint(`${SELF}: ${name}: ${e.message}\n`)
      return 126
    }
  }

  /** The path a command name runs: the name itself when it has a slash, else the first match along PATH. Null when none. */
  private *find(name: string, path: string | undefined): Task<string | null> {
    const sys = this.sys
    const candidates = name.includes('/') ? [name] : (path ?? this.get('PATH') ?? DEFAULT_PATH).split(':').map((d) => `${d === '' ? '.' : d}/${name}`)
    for (const c of candidates) {
      try {
        const st = yield* sys.stat(c)
        if (st.kind === 'file' && (yield* sys.access(c, 1))) return c
      } catch (e) {
        if (!(e instanceof OsError)) throw e
      }
    }
    return null
  }

  /**
   * Runs a builtin. A refusal it does not catch itself (a write to a full disk, a knob under /sys that says no) is
   * that command's failure: said, status 1, and the rest of the line goes on. A closed pipe still ends the task.
   */
  private *runBuiltin(builtin: Builtin, argv: string[]): Task<number> {
    try {
      return yield* builtin.call(this, argv)
    } catch (e) {
      if (!(e instanceof OsError) || e.errno === 'EPIPE') throw e
      yield* this.sys.eprint(`${SELF}: ${argv[0]}: ${e.message}\n`)
      return 1
    }
  }

  private *cityRun(name: string, args: readonly string[], line: string, plain: boolean): Task<number> {
    const sys = this.sys
    const direct = plain && this.st.session && sys.isatty(1) && sys.isatty(2)
    let res: CityResult
    try {
      res = this.city.run(name, args, line, direct)
    } catch (e) {
      yield* sys.eprint(`${name}: ${reasonOf(e)}\n`)
      return 1
    }
    if (res.post !== undefined) {
      // The host shows this answer itself; what arrives later is waited for only to know how it went.
      sys.post(res.post)
      let status = res.status ?? 0
      if (res.later !== null && (yield* this.answered(name, res.later)).some((l) => l.err)) status = 1
      return status
    }
    let failed = false
    const show = function* (lines: readonly CityLine[]): Task<void> {
      // Ordinary and error lines go to their own outputs, in the order they were given.
      let i = 0
      while (i < lines.length) {
        const err = lines[i].err
        let text = ''
        while (i < lines.length && lines[i].err === err) text += `${lines[i++].text}\n`
        if (err) { failed = true; yield* sys.eprint(text) }
        else yield* sys.print(text)
      }
    }
    try {
      yield* show(res.lines)
      if (res.later !== null) yield* show(yield* this.answered(name, res.later))
    } catch (e) {
      // A write that is refused (a full disk) is this command's failure, as a builtin's is: the line goes on.
      if (!(e instanceof OsError) || e.errno === 'EPIPE') throw e
      yield* sys.eprint(`${name}: ${e.message}\n`)
      return 1
    }
    return failed ? 1 : 0
  }

  /**
   * Waits for what a city command answers later. Ctrl+C at the console's own shell gives the wait up (the command
   * itself goes on in the city: the shell only stops waiting for it). A refusal is the command's own error line.
   */
  private *answered(name: string, later: Later<readonly CityLine[]>): Task<readonly CityLine[]> {
    const sys = this.sys
    // Only the console's own shell takes a Ctrl+C, so only it may end the wait on one.
    const mine = this.st.session
    while (!later.done) {
      yield { why: 'city', ready: () => later.done || (mine && sys.interruptPending()) }
      this.interruptCheck()
    }
    if (later.error !== null) return [{ err: true, text: `${name}: ${later.error.message}` }]
    return later.value ?? []
  }

  // Jobs.

  /** Collects the jobs that have ended; with `report`, says so for each. */
  private *reap(report: boolean): Task<void> {
    const sys = this.sys
    const live: Job[] = []
    for (const job of this.st.jobs) {
      let running = false
      let status = 0
      for (const pid of job.pids) {
        const s = sys.poll(pid)
        if (s === 'running') running = true
        else if (s !== null) status = s
      }
      if (running) { live.push(job); continue }
      if (report) yield* sys.print(`[${job.id}]  ${status === 0 ? 'Done' : `Exit ${status}`}    ${job.text}\n`)
    }
    this.st.jobs = live
    if (live.length === 0) this.st.nextJob = 1
  }

  /** The job a word names: `%2`, or a task's number. */
  private job(word: string): Job | number | null {
    if (word.startsWith('%')) {
      const id = Number(word.slice(1))
      return this.st.jobs.find((j) => j.id === id) ?? null
    }
    if (!/^[0-9]+$/.test(word)) return null
    const pid = Number(word)
    return this.st.jobs.find((j) => j.pids.includes(pid)) ?? pid
  }

  // The shell as a program.

  *main(argv: readonly string[]): Task<number> {
    const sys = this.sys
    const st = this.st
    st.pid = sys.pid
    for (const [k, v] of sys.env) {
      st.vars.set(k, v)
      st.exported.add(k)
    }
    if (st.vars.get('PATH') === undefined) st.vars.set('PATH', DEFAULT_PATH)
    this.set('PWD', sys.cwd)
    st.exported.add('PWD')
    sys.env.set('PWD', sys.cwd)
    const login = argv.length > 0 && argv[0].startsWith('-')
    st.name = login ? argv[0].slice(1) : (argv[0] ?? 'sh')
    if (argv[1] === '-c') {
      if (argv[2] === undefined) { yield* sys.eprint(`${SELF}: -c needs a command\n`); return 2 }
      if (argv[3] !== undefined) st.name = argv[3]
      st.params = argv.slice(4)
      return yield* this.script(argv[2])
    }
    if (argv[1] !== undefined) {
      let text: string
      try {
        text = decode(yield* sys.readFile(argv[1]))
      } catch (e) {
        if (!(e instanceof OsError)) throw e
        yield* sys.eprint(`${SELF}: ${argv[1]}: ${e.message}\n`)
        return 127
      }
      st.name = argv[1]
      st.params = argv.slice(2)
      return yield* this.script(text.startsWith('#!') ? text.slice(text.includes('\n') ? text.indexOf('\n') : text.length) : text)
    }
    if (!sys.isatty(0)) return yield* this.script(decode(yield* sys.readAll(0)))
    st.interactive = true
    if (login) {
      st.session = true
      sys.takeTerminal()
      for (const profile of ['/etc/profile', `${this.get('HOME') ?? ''}/.profile`]) {
        if (!(yield* sys.access(profile, 4))) continue
        // A profile that cannot be read (a directory) or whose commands are refused is said and passed over: thrown
        // from here it would end the console's shell, and the one started in its place would read it again.
        try {
          yield* this.guarded(() => this.source(profile))
        } catch (e) {
          if (!(e instanceof OsError)) throw e
          yield* sys.eprint(`${SELF}: ${profile}: ${e.message}\n`)
        }
      }
    }
    return yield* this.converse()
  }

  /** Runs a script's text; the status of its last command. */
  private *script(text: string): Task<number> {
    let list: List
    try {
      list = parse(text, this.names)
    } catch (e) {
      if (!(e instanceof ShellSyntax)) throw e
      yield* this.sys.eprint(`${SELF}: syntax error: ${e.message}\n`)
      return 2
    }
    return yield* this.guarded(() => this.list(list))
  }

  private *source(path: string): Task<number> {
    if (this.st.nest >= NEST_MAX) throw new Trouble('scripts that read scripts nested too deep')
    const text = decode(yield* this.sys.readFile(path))
    let list: List
    try {
      list = parse(text.startsWith('#!') ? text.slice(text.includes('\n') ? text.indexOf('\n') : text.length) : text, this.names)
    } catch (e) {
      if (!(e instanceof ShellSyntax)) throw e
      yield* this.sys.eprint(`${SELF}: ${path}: syntax error: ${e.message}\n`)
      return 2
    }
    this.st.nest++
    try {
      return yield* this.list(list)
    } catch (e) {
      if (e instanceof Jump && e.kind === 'return') return e.status
      throw e
    } finally {
      this.st.nest--
    }
  }

  /** What the console shows before a typed line: PS1 when it is set (\h host, \w directory, \u user, \$ the mark), else `host:directory# `. */
  private promptText(): string {
    const home = this.get('HOME') ?? ''
    const cwd = this.sys.cwd
    const shown = home !== '' && cwd === home ? '~' : home !== '' && home !== '/' && cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd
    const mark = this.sys.cred.uid === 0 ? '#' : '$'
    const ps1 = this.st.vars.get('PS1')
    if (ps1 === undefined) return `${this.sys.hostname}:${shown}${mark} `
    return ps1.replace(/\\([hwu$\\])/g, (_m, c: string) => (c === 'h' ? this.sys.hostname : c === 'w' ? shown : c === 'u' ? (this.get('USER') ?? 'root') : c === '$' ? mark : '\\'))
  }

  /** One typed line without its line end; null at an end of input. A line longer than one read is still one line. */
  private *typed(): Task<string | null> {
    const parts: Uint8Array[] = []
    for (;;) {
      const bytes = yield* this.sys.read(0)
      if (bytes.length === 0) break
      parts.push(bytes)
      if (bytes[bytes.length - 1] === 10) break
    }
    if (parts.length === 0) return null
    const text = decode(parts.length === 1 ? parts[0] : concat(parts))
    return text.endsWith('\n') ? text.slice(0, -1) : text
  }

  /** The shell at the terminal: prompt, read, run, for as long as the console lives. */
  private *converse(): Task<number> {
    const sys = this.sys
    for (;;) {
      try {
        yield* this.reap(true)
        sys.flushTerminal()
        sys.interrupted()
        sys.prompt(this.promptText())
        let text = yield* this.typed()
        if (text === null) {
          // An end of input at the prompt: Ctrl+C gave it (nothing to give up), or Ctrl+D (the console stays).
          sys.interrupted()
          if (!this.st.session) return this.st.status
          continue
        }
        let list: List | null = null
        for (;;) {
          try {
            list = parse(text, this.names)
            break
          } catch (e) {
            if (!(e instanceof ShellSyntax)) throw e
            if (e.incomplete) {
              sys.prompt('> ', true)
              const more = yield* this.typed()
              if (more !== null) { text = `${text}\n${more}`; continue }
              // Ctrl+C drops the unfinished command without a word; Ctrl+D says what was missing.
              if (sys.interrupted()) break
            }
            yield* sys.eprint(`${SELF}: syntax error: ${e.message}\n`)
            this.st.status = 2
            break
          }
        }
        sys.prompt('')
        if (list !== null) yield* this.list(list)
      } catch (e) {
        if (e instanceof Jump) {
          // Only `return` gets this far (there is no loop around the line): the line is given up with its status.
          this.st.status = e.status
          continue
        }
        if (e instanceof Interrupted) {
          this.st.status = 130
          continue
        }
        if (e instanceof Trouble) {
          yield* sys.eprint(`${SELF}: ${e.message}\n`)
          this.st.status = 2
          continue
        }
        if (e instanceof OsError) {
          if (e.errno === 'EPIPE') continue
          yield* sys.eprint(`${SELF}: ${e.message}\n`)
          this.st.status = 1
          continue
        }
        throw e
      }
    }
  }

  // Builtins: the commands that must run inside the shell. Each gets its arguments (its name first) and gives a status.

  *cd(argv: string[]): Task<number> {
    const sys = this.sys
    let to = argv[1]
    let say = false
    if (to === undefined) {
      to = this.get('HOME') ?? ''
      if (to === '') { yield* sys.eprint('cd: HOME is not set\n'); return 1 }
    } else if (to === '-') {
      to = this.get('OLDPWD') ?? ''
      if (to === '') { yield* sys.eprint('cd: OLDPWD is not set\n'); return 1 }
      say = true
    }
    const from = sys.cwd
    try {
      yield* sys.chdir(to)
    } catch (e) {
      if (!(e instanceof OsError)) throw e
      yield* sys.eprint(`cd: ${to}: ${e.message}\n`)
      return 1
    }
    this.set('OLDPWD', from)
    this.set('PWD', sys.cwd)
    if (say) yield* sys.print(`${sys.cwd}\n`)
    return 0
  }

  *pwd(): Task<number> {
    yield* this.sys.print(`${this.sys.cwd}\n`)
    return 0
  }

  *echo(argv: string[]): Task<number> {
    let i = 1
    let end = '\n'
    let escapes = false
    for (; i < argv.length; i++) {
      if (argv[i] === '-n') end = ''
      else if (argv[i] === '-e') escapes = true
      else if (argv[i] === '-ne' || argv[i] === '-en') { end = ''; escapes = true }
      else break
    }
    let text = argv.slice(i).join(' ')
    if (escapes) text = text.replace(/\\([ntr\\e0])/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c === 'e' ? '\u001b' : c === '0' ? '\0' : '\\'))
    yield* this.sys.print(text + end)
    return 0
  }

  *export(argv: string[]): Task<number> {
    const sys = this.sys
    if (argv.length === 1) {
      const names = [...this.st.exported].sort()
      let text = ''
      for (const name of names) text += `export ${name}='${(this.st.vars.get(name) ?? '').replace(/'/g, "'\\''")}'\n`
      yield* sys.print(text)
      return 0
    }
    let status = 0
    for (const a of argv.slice(1)) {
      const eq = a.indexOf('=')
      const name = eq < 0 ? a : a.slice(0, eq)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { yield* sys.eprint(`export: ${name}: not a name\n`); status = 1; continue }
      this.st.exported.add(name)
      if (eq >= 0) this.set(name, a.slice(eq + 1))
      else if (this.st.vars.has(name)) sys.env.set(name, this.st.vars.get(name) ?? '')
    }
    return status
  }

  *unsetNames(argv: string[]): Task<number> {
    for (const name of argv.slice(1)) this.unset(name)
    return 0
  }

  *exit(argv: string[]): Task<number> {
    const n = argv[1] === undefined ? this.st.status : /^[0-9]+$/.test(argv[1]) ? Number(argv[1]) & 255 : 2
    // The console's own shell does not end: there, `exit` is the console's word for closing it.
    if (this.st.session) {
      if (this.city.has('exit')) return yield* this.cityRun('exit', argv.slice(1), argv.join(' '), true)
      return n
    }
    return this.sys.exit(n)
  }

  *dot(argv: string[]): Task<number> {
    const sys = this.sys
    if (argv[1] === undefined) { yield* sys.eprint(`${argv[0]}: a file name is needed\n`); return 2 }
    const held = this.st.params
    if (argv.length > 2) this.st.params = argv.slice(2)
    try {
      return yield* this.source(argv[1])
    } catch (e) {
      if (!(e instanceof OsError)) throw e
      yield* sys.eprint(`${argv[0]}: ${argv[1]}: ${e.message}\n`)
      return 1
    } finally {
      this.st.params = held
    }
  }

  *jobs(): Task<number> {
    yield* this.reap(true)
    let text = ''
    for (const job of this.st.jobs) text += `[${job.id}]  Running    ${job.text}\n`
    yield* this.sys.print(text)
    return 0
  }

  *wait(argv: string[]): Task<number> {
    const sys = this.sys
    let status = 0
    // Only the console's own shell takes a Ctrl+C, so only it may end the wait on one; the job goes on.
    const mine = this.st.session
    const one = function* (this: Shell, pids: readonly number[]): Task<void> {
      for (const pid of pids) {
        while (sys.poll(pid) === 'running') {
          yield { why: 'wait', ready: () => sys.poll(pid) !== 'running' || (mine && sys.interruptPending()) }
          this.interruptCheck()
        }
        try {
          status = yield* sys.wait(pid)
        } catch (e) {
          if (!(e instanceof OsError)) throw e
          status = 127
        }
        this.interruptCheck()
      }
    }
    if (argv.length === 1) {
      for (const job of this.st.jobs.slice()) yield* one.call(this, job.pids)
    } else {
      for (const word of argv.slice(1)) {
        const j = this.job(word)
        if (j === null) { yield* sys.eprint(`wait: ${word}: no such job\n`); status = 127; continue }
        yield* one.call(this, typeof j === 'number' ? [j] : j.pids)
      }
    }
    yield* this.reap(false)
    return status
  }

  *fg(argv: string[]): Task<number> {
    const sys = this.sys
    const job = argv[1] === undefined ? (this.st.jobs[this.st.jobs.length - 1] ?? null) : this.job(argv[1])
    if (job === null || typeof job === 'number') { yield* sys.eprint(`fg: ${argv[1] ?? 'current'}: no such job\n`); return 1 }
    yield* sys.print(`${job.text}\n`)
    const status = yield* this.foreground(job.pids, job.pgid)
    yield* this.reap(false)
    return status
  }

  *stop(argv: string[]): Task<number> {
    const sys = this.sys
    if (argv.length === 1) { yield* sys.eprint('usage: stop <task number>|%<job> ...\n'); return 2 }
    let status = 0
    for (const word of argv.slice(1)) {
      const j = this.job(word)
      try {
        if (j === null) { yield* sys.eprint(`stop: ${word}: no such job\n`); status = 1 }
        else if (typeof j === 'number') sys.stop(j)
        // A job is its group: its shell and every program that shell started end together.
        else sys.stopGroup(j.pgid)
      } catch (e) {
        if (!(e instanceof OsError)) throw e
        yield* sys.eprint(`stop: ${word}: ${e.message}\n`)
        status = 1
      }
    }
    return status
  }

  *type(argv: string[]): Task<number> {
    const sys = this.sys
    let status = 0
    for (const name of argv.slice(1)) {
      if (Object.hasOwn(BUILTINS, name)) yield* sys.print(`${name} is a shell builtin\n`)
      else if (this.names.has(name)) yield* sys.print(`${name} is a city command\n`)
      else {
        const path = yield* this.find(name, undefined)
        if (path === null) { yield* sys.eprint(`${name}: not found\n`); status = 1 }
        else yield* sys.print(`${name} is ${path}\n`)
      }
    }
    return status
  }

  *read(argv: string[]): Task<number> {
    const sys = this.sys
    let i = 1
    let raw = false
    if (argv[i] === '-r') { raw = true; i++ }
    const names = argv.slice(i)
    for (const n of names) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) { yield* sys.eprint(`read: ${n}: not a name\n`); return 2 }
    // One line and no more: a byte at a time unless the terminal hands whole lines anyway.
    const bytes: number[] = []
    let ended = true
    const whole = sys.isatty(0)
    // At the terminal the next typed line is this command's, whatever it says: the console must not take it for a new one.
    if (whole) sys.prompt('', true)
    try {
      for (;;) {
        const chunk = yield* sys.read(0, whole ? 65536 : 1)
        if (chunk.length === 0) break
        let done = false
        for (const b of chunk) {
          if (b === 10) { done = true; ended = false; break }
          if (bytes.length <= 1 << 20) bytes.push(b)
        }
        if (done) break
        // Past 1 MiB the rest of a typed line is read and dropped: left there, the shell would run it as a command.
        if (!whole && bytes.length > 1 << 20) break
      }
    } finally {
      if (whole) sys.prompt('')
    }
    // Ctrl+C at the console ends the read with no input: the line is given up with 130, not answered with a status.
    this.interruptCheck()
    let line = decode(Uint8Array.from(bytes))
    if (!raw) line = line.replace(/\\(.)/g, '$1')
    if (names.length === 0) this.set('REPLY', line)
    else {
      let rest = line.replace(/^[ \t]+/, '')
      for (let k = 0; k < names.length; k++) {
        if (k === names.length - 1) { this.set(names[k], rest.replace(/[ \t]+$/, '')); break }
        const m = /^(\S*)[ \t]*/.exec(rest)
        this.set(names[k], m === null ? '' : m[1])
        rest = m === null ? '' : rest.slice(m[0].length)
      }
    }
    return ended && bytes.length === 0 ? 1 : 0
  }

  *shift(argv: string[]): Task<number> {
    const n = argv[1] === undefined ? 1 : /^[0-9]+$/.test(argv[1]) ? Number(argv[1]) : -1
    if (n < 0 || n > this.st.params.length) { yield* this.sys.eprint('shift: not that many parameters\n'); return 1 }
    this.st.params = this.st.params.slice(n)
    return 0
  }

  *test(argv: string[]): Task<number> {
    let args = argv.slice(1)
    if (argv[0] === '[') {
      if (args[args.length - 1] !== ']') { yield* this.sys.eprint("[: missing ']'\n"); return 2 }
      args = args.slice(0, -1)
    }
    return yield* evaluate(this.sys, argv[0], args)
  }

  *jump(argv: string[]): Task<number> {
    const kind = argv[0] as 'break' | 'continue' | 'return'
    const n = argv[1] === undefined ? (kind === 'return' ? this.st.status : 1) : /^[0-9]+$/.test(argv[1]) ? Number(argv[1]) : -1
    if (n < 0 || (kind !== 'return' && n < 1)) { yield* this.sys.eprint(`${kind}: ${argv[1]}: not a count\n`); return 2 }
    if (kind === 'return') throw new Jump('return', 1, n & 255)
    if (this.st.loops === 0) return 0
    throw new Jump(kind, Math.min(n, this.st.loops), 0)
  }

  *umask(argv: string[]): Task<number> {
    const sys = this.sys
    if (argv[1] === undefined) { yield* sys.print(`${sys.umask.toString(8).padStart(4, '0')}\n`); return 0 }
    if (!/^[0-7]{1,4}$/.test(argv[1])) { yield* sys.eprint(`umask: ${argv[1]}: not an octal number\n`); return 2 }
    sys.umask = Number.parseInt(argv[1], 8)
    return 0
  }

  *nothing(argv: string[]): Task<number> {
    return argv[0] === 'false' ? 1 : 0
  }
}

const BUILTINS: Readonly<Record<string, Builtin>> = Object.freeze({
  ':': Shell.prototype.nothing,
  true: Shell.prototype.nothing,
  false: Shell.prototype.nothing,
  cd: Shell.prototype.cd,
  pwd: Shell.prototype.pwd,
  echo: Shell.prototype.echo,
  export: Shell.prototype.export,
  unset: Shell.prototype.unsetNames,
  exit: Shell.prototype.exit,
  source: Shell.prototype.dot,
  '.': Shell.prototype.dot,
  jobs: Shell.prototype.jobs,
  wait: Shell.prototype.wait,
  fg: Shell.prototype.fg,
  stop: Shell.prototype.stop,
  type: Shell.prototype.type,
  read: Shell.prototype.read,
  shift: Shell.prototype.shift,
  test: Shell.prototype.test,
  '[': Shell.prototype.test,
  break: Shell.prototype.jump,
  continue: Shell.prototype.jump,
  return: Shell.prototype.jump,
  umask: Shell.prototype.umask,
})

/** The names of the commands that run inside the shell, sorted. */
export const BUILTIN_NAMES: readonly string[] = Object.freeze(Object.keys(BUILTINS).sort())

/** The shell as a program: `sh`, `sh file`, `sh -c 'text'`. `city` is how it runs the city's own commands. */
export function shell(city: CityHost | null = null): Program {
  const host = city ?? NO_HOST
  return (sys, argv) => new Shell(sys, host).main(argv)
}
