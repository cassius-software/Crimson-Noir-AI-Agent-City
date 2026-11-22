// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the kernel of the console's operating layer: the table of running tasks and the
 * one loop that runs them. A task is a program's generator plus what a program owns (a number, a parent, a group,
 * who it runs as, its arguments, its environment, its directory and its open descriptors). The loop gives each task
 * that can go on a turn, in order of number; a task that cannot (an empty pipe, a child not finished, a clock not
 * yet reached) hands back the question that says when it can, and the loop asks it again on a later pass. Nothing
 * here starts a timer or reads a clock of its own: the host calls `run` with a budget of steps and a deadline on
 * the clock it supplied, and the kernel returns when the budget is spent, the deadline is reached or nothing can move.
 * A program that never waits is still interrupted, because every call it makes into the kernel counts against its
 * turn, and every LOOK calls also look at the clock (a turn of calls that each move a lot of bytes ends on time). A task ends by
 * returning, by an error nobody caught (reported on its own error output, and never thrown at the host), or by
 * being stopped; its descriptors are closed, its children pass to task 1, and its parent may collect its status.
 * What breaks if it is removed? Nothing runs: there are files, but no programs, no pipes and no shell.
 */
import { EMPTY, concat, decode, encode } from './bytes.ts'
import { OsError, reasonOf, refuse } from './errno.ts'
import type { Cred, Driver, Entry } from './fs.ts'
import { ROOT_CRED, X, permits } from './fs.ts'
import { normalize } from './path.ts'
import { PIPE_MAX, Pipe } from './pipe.ts'
import { BREATH, now } from './task.ts'
import type { Task, Wait } from './task.ts'
import { Tty } from './tty.ts'
import type { FileStat, Handle, Mount, Vfs } from './vfs.ts'
import { O_CREATE, O_READ, O_WRITE } from './vfs.ts'

/** The most tasks at once. */
export const PROCS_MAX = 64
/** The most descriptors a task holds. */
export const FDS_MAX = 32
/** The most bytes in a task's arguments, and in its environment. */
export const ARGS_MAX = 131072
/** Calls into the kernel a task makes before it must let the others run. */
export const SLICE = 256
/** Every how many calls a turn looks at the clock, to end on the host's deadline. */
export const LOOK = 8
/** How many ended tasks' statuses are remembered for a `wait` that comes late. */
const EXITED_MAX = 256
/** Lines the kernel's own log keeps. */
const LOG_MAX = 200
/** How deep `#!` may chain (a script whose interpreter is a script ...). */
const SHEBANG_DEPTH = 4
/**
 * How many programs one task may run in place of one another. Each exec runs the new program inside the one that
 * called it, so a chain without end (`env env env ... cat`) would grow the host's stack until it gave out.
 */
const EXEC_DEPTH = 64
/** Where programs are looked for when PATH is not set. */
export const DEFAULT_PATH = '/bin:/usr/apps'

/** A program: the body of a task. It returns its exit status (0 for success). */
export type Program = (sys: Sys, argv: readonly string[]) => Task<number>

/** Thrown by `sys.exit` to end a task from anywhere inside it. */
export class Exit {
  readonly status: number
  constructor(status: number) {
    this.status = status
  }
}

/** An open file, pipe end or terminal as a task's descriptor table holds it. Several descriptors may share one. */
export interface Channel {
  /** Descriptors that refer to it; it is closed when the last one goes. */
  refs: number
  /** Whether it is the terminal. */
  readonly tty: boolean
  /** What `ls -l /proc/<n>/fd` shows: a path, `pipe:[3]`, `tty`. */
  readonly label: string
  read(length: number, proc: Proc): Task<Uint8Array>
  write(data: Uint8Array, proc: Proc): Task<number>
  seek(offset: number, whence: 0 | 1 | 2): Task<number>
  stat(): Task<FileStat | null>
  truncate(size: number): Task<void>
  /** Called once, when no descriptor refers to it any more. */
  close(): void
}

class FileChannel implements Channel {
  refs = 0
  readonly tty = false
  readonly label: string
  private readonly handle: Handle
  constructor(handle: Handle, label: string) {
    this.handle = handle
    this.label = label
  }
  read(length: number): Task<Uint8Array> { return this.handle.read(length) }
  write(data: Uint8Array): Task<number> { return this.handle.write(data) }
  seek(offset: number, whence: 0 | 1 | 2): Task<number> { return this.handle.seek(offset, whence) }
  stat(): Task<FileStat | null> { return this.handle.stat() }
  truncate(size: number): Task<void> { return this.handle.truncate(size) }
  close(): void { this.handle.close() }
}

class PipeEnd implements Channel {
  refs = 0
  readonly tty = false
  readonly label: string
  private readonly pipe: Pipe
  private readonly writes: boolean
  constructor(pipe: Pipe, writes: boolean) {
    this.pipe = pipe
    this.writes = writes
    this.label = `pipe:[${pipe.id}]`
    if (writes) pipe.writers++
    else pipe.readers++
  }
  read(length: number): Task<Uint8Array> {
    if (this.writes) refuse('EBADF')
    return this.pipe.read(length)
  }
  write(data: Uint8Array): Task<number> {
    if (!this.writes) refuse('EBADF')
    return this.pipe.write(data)
  }
  *seek(): Task<number> { return refuse('ESPIPE') }
  *stat(): Task<FileStat | null> { return null }
  *truncate(): Task<void> { refuse('EINVAL') }
  close(): void {
    if (this.writes) this.pipe.writers--
    else this.pipe.readers--
  }
}

/** The most bytes one turn hands the screen in a write; a longer write goes on in the next turn. */
const SCREEN_PIECE = 16 << 10

class TtyEnd implements Channel {
  refs = 0
  readonly tty = true
  readonly label = 'tty'
  private readonly term: Tty
  /** Which way this end goes: the keyboard, the screen, the screen's error colour, or (for /dev/tty) keyboard and screen. */
  private readonly way: 'in' | 'out' | 'err' | 'both'
  constructor(term: Tty, way: 'in' | 'out' | 'err' | 'both') {
    this.term = term
    this.way = way
  }
  *read(length: number, proc: Proc): Task<Uint8Array> {
    if (this.way !== 'in' && this.way !== 'both') refuse('EBADF')
    if (length <= 0) return EMPTY
    const term = this.term
    // A task outside the foreground group is told the input has ended: it never takes a line meant for another.
    if (proc.pgid !== term.foreground) return EMPTY
    if (!term.typed) {
      // What was written without a line end (a question before the answer) shows before the wait.
      term.flush()
      term.readers.add(proc.pid)
      try {
        while (!term.typed) {
          yield { why: 'tty', ready: () => term.typed || proc.pgid !== term.foreground }
          if (proc.pgid !== term.foreground) return EMPTY
        }
      } finally {
        term.readers.delete(proc.pid)
      }
    }
    return term.take(length) ?? EMPTY
  }
  *write(data: Uint8Array): Task<number> {
    if (this.way === 'in') refuse('EBADF')
    // A long write reaches the screen a piece at a time, with a breath between pieces, so one line of megabytes cannot
    // hold the page past its turn. Each piece ends where a character does (never inside the bytes of one), so another
    // writer in the breath, or a Ctrl+C that ends this one, never leaves half a character in the screen's decoder.
    for (let at = 0; at < data.length;) {
      if (at > 0) yield BREATH
      let end = Math.min(data.length, at + SCREEN_PIECE)
      // Back over at most three continuation bytes (10xxxxxx) to the start of the character the cut fell in.
      for (let back = end; end < data.length && back > end - 4 && back > at; back--) {
        if ((data[back] & 0xc0) !== 0x80) { end = back; break }
      }
      this.term.write(this.way === 'err' ? 'err' : 'out', data.subarray(at, end))
      at = end
    }
    return data.length
  }
  *seek(): Task<number> { return refuse('ESPIPE') }
  *stat(): Task<FileStat | null> { return null }
  *truncate(): Task<void> { refuse('EINVAL') }
  close(): void {}
}

/** A running (or just ended) task. */
export interface Proc {
  readonly pid: number
  ppid: number
  pgid: number
  readonly cred: Cred
  argv: readonly string[]
  /** What `ps` shows: the program's name. */
  name: string
  readonly env: Map<string, string>
  cwd: string
  /** Permission bits a new file or directory never gets. */
  umask: number
  readonly fds: (Channel | null)[]
  task: Task<number> | null
  wait: Wait | null
  state: 'ready' | 'ended'
  status: number
  /** The clock when it started. */
  readonly started: number
  /** Calls into the kernel so far. */
  steps: number
  /** Programs running in place of one another now: one for each exec still running. */
  execs: number
  /** Set to stop it: the status it ends with on its next turn. */
  ending: number | null
}

/** A task as `ps` and /proc show it. */
export interface ProcInfo {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  readonly uid: number
  readonly name: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly state: 'run' | 'wait' | 'end'
  readonly why: string
  readonly started: number
  readonly steps: number
  readonly fds: readonly (string | null)[]
  readonly env: ReadonlyMap<string, string>
}

export interface SpawnOptions {
  /** The child's environment; the parent's when absent. */
  readonly env?: ReadonlyMap<string, string>
  /** The child's directory; the parent's when absent. */
  readonly cwd?: string
  /**
   * The child's descriptors, by the parent's own numbers: `[0, 5, 2]` gives the child the parent's 0 as 0, its 5 as
   * 1 and its 2 as 2; null leaves one closed. The parent's first three when absent (closed in the child when closed
   * in the parent).
   */
  readonly fds?: readonly (number | null)[]
  /** The child's group: its own ('new'), or the parent's (absent), or a named one. */
  readonly group?: 'new' | number
  /** Run this body instead of looking `argv[0]` up: a part of the caller itself as its own task. */
  readonly program?: Program
}

export interface KernelOptions {
  readonly vfs: Vfs
  /** Milliseconds that only go up: what waits and budgets are measured on. */
  readonly clock: () => number
  /** Milliseconds since 1970, for `date` and file times; the clock when absent. */
  readonly wall?: () => number
  /** The programs a file that starts `#!native <name>` runs. */
  readonly programs: ReadonlyMap<string, Program>
  readonly hostname: string
}

export class Kernel {
  readonly vfs: Vfs
  readonly tty = new Tty()
  readonly hostname: string
  readonly clock: () => number
  readonly wall: () => number
  private readonly programs: ReadonlyMap<string, Program>
  private readonly table = new Map<number, Proc>()
  /** Statuses of tasks that ended and went, each with the parent that may still collect it. */
  private readonly exited = new Map<number, { readonly ppid: number; readonly status: number }>()
  private readonly lines: string[] = []
  private nextPid = 1
  private nextPipe = 1
  /** What is left of the running task's turn. */
  slice = 0
  /** The clock time the current call to `run` must hand back by. */
  deadline = Infinity
  /** The task whose turn it is, while it runs. */
  current: Proc | null = null
  /** The task whose turn ended the last call to `run`: the next call starts after it. */
  private last = 0
  /** The clock when the kernel was made. */
  readonly booted: number
  /** The group reads fall back to when the foreground group has ended: the console's shell. */
  home = 0
  /** Set by Ctrl+C for the console's shell to notice: it gives up the line it was running. */
  private interrupted = false

  constructor(opts: KernelOptions) {
    this.vfs = opts.vfs
    this.clock = opts.clock
    this.wall = opts.wall ?? opts.clock
    this.programs = opts.programs
    this.hostname = opts.hostname
    this.booted = opts.clock()
  }

  /** Adds a line to the kernel's own log (`dmesg`). */
  log(text: string): void {
    this.lines.push(`[${((this.clock() - this.booted) / 1000).toFixed(3).padStart(10)}] ${text}`)
    if (this.lines.length > LOG_MAX) this.lines.splice(0, this.lines.length - LOG_MAX)
  }

  /** The kernel's log, oldest first. */
  dmesg(): readonly string[] { return this.lines }

  /** Starts task 1 from a body; everything else descends from it. Its descriptors are the terminal. */
  boot(init: Program, argv: readonly string[], env: ReadonlyMap<string, string>): Proc {
    if (this.table.size > 0) refuse('EBUSY', 'the kernel is running')
    const proc = this.make(null, argv, new Map(env), '/', ROOT_CRED, [this.end('in'), this.end('out'), this.end('err')], 'new', 0o022)
    this.start(proc, init)
    this.home = proc.pgid
    this.tty.foreground = proc.pgid
    return proc
  }

  private end(way: 'in' | 'out' | 'err'): Channel { return new TtyEnd(this.tty, way) }

  /** The terminal as a file opened by name (/dev/tty): reads the keyboard, writes the screen. */
  terminalChannel(): Channel { return new TtyEnd(this.tty, 'both') }

  private make(parent: Proc | null, argv: readonly string[], env: Map<string, string>, cwd: string, cred: Cred, fds: (Channel | null)[], group: 'new' | number, umask: number): Proc {
    if (this.table.size >= PROCS_MAX) refuse('EAGAIN', 'too many tasks')
    const pid = this.nextPid++
    for (const ch of fds) if (ch !== null) ch.refs++
    const name = argv.length > 0 ? argv[0].slice(argv[0].lastIndexOf('/') + 1) : '?'
    const proc: Proc = {
      pid, ppid: parent === null ? 0 : parent.pid, pgid: group === 'new' ? pid : group, cred, argv, name, env, cwd, umask, fds,
      task: null, wait: null, state: 'ready', status: 0, started: this.clock(), steps: 0, execs: 0, ending: null,
    }
    this.table.set(pid, proc)
    return proc
  }

  private start(proc: Proc, program: Program): void {
    try {
      proc.task = program(new Sys(this, proc), proc.argv)
    } catch (e) {
      // A body that fails before it is a task fails on its first turn, as one that fails later does.
      proc.task = (function* (): Task<number> { throw e })()
    }
  }

  /** Refuses arguments or an environment past ARGS_MAX. */
  private sized(argv: readonly string[], env: ReadonlyMap<string, string>): void {
    let bytes = 0
    for (const a of argv) bytes += a.length + 1
    if (bytes > ARGS_MAX) refuse('E2BIG')
    bytes = 0
    for (const [k, v] of env) bytes += k.length + v.length + 2
    if (bytes > ARGS_MAX) refuse('E2BIG', 'the environment is too long')
  }

  /** The program a name or path runs for `proc`, with the arguments it is to be given. ENOENT when there is none. */
  *load(proc: Proc, argv: readonly string[], depth = 0): Task<{ program: Program; argv: readonly string[] }> {
    if (argv.length === 0 || argv[0] === '') refuse('ENOENT')
    const name = argv[0]
    const candidates: string[] = []
    if (name.includes('/')) candidates.push(name)
    else for (const dir of (proc.env.get('PATH') ?? DEFAULT_PATH).split(':')) candidates.push(`${dir === '' ? '.' : dir}/${name}`)
    let denied = false
    for (const path of candidates) {
      let st: FileStat
      try {
        st = yield* this.vfs.stat(path, proc.cwd, proc.cred)
      } catch (e) {
        if (!(e instanceof OsError)) throw e
        if (e.errno === 'EACCES') denied = true
        continue
      }
      if (st.kind !== 'file') { if (name.includes('/')) refuse('EACCES', st.kind === 'dir' ? 'is a directory' : 'not a program'); continue }
      if (!permits(st, proc.cred, X)) { denied = true; continue }
      const handle = yield* this.vfs.open(path, proc.cwd, proc.cred, O_READ)
      let first: string
      try {
        first = decode(yield* handle.read(256))
      } finally {
        handle.close()
      }
      if (!first.startsWith('#!')) refuse('ENOEXEC')
      const line = first.slice(2, first.includes('\n') ? first.indexOf('\n') : first.length).trim()
      const words = line.split(/[ \t]+/).filter((w) => w !== '')
      if (words[0] === 'native') {
        const program = this.programs.get(words[1] ?? '')
        if (program === undefined) refuse('ENOEXEC', `no native program '${words[1] ?? ''}'`)
        return { program, argv }
      }
      if (words.length === 0 || depth >= SHEBANG_DEPTH) refuse('ENOEXEC')
      // `#!/bin/sh -e` runs /bin/sh with `-e`, the script's path, then the arguments.
      const full = normalize(path, proc.cwd)
      return yield* this.load(proc, [...words, full, ...argv.slice(1)], depth + 1)
    }
    return refuse(denied ? 'EACCES' : 'ENOENT')
  }

  /** Starts a child of `parent`. The program is looked up first, so a name that runs nothing is refused here. */
  *spawn(parent: Proc, argv: readonly string[], opts: SpawnOptions = {}): Task<Proc> {
    const env = new Map(opts.env ?? parent.env)
    this.sized(argv, env)
    let program = opts.program
    let args = argv
    if (program === undefined) {
      const found = yield* this.load({ ...parent, env }, argv)
      program = found.program
      args = found.argv
    }
    const cwd = opts.cwd === undefined ? parent.cwd : normalize(opts.cwd, parent.cwd)
    // Absent, the parent's first three as they are: one the parent has closed is closed in the child, not refused.
    const numbers = opts.fds ?? [0, 1, 2].map((n) => (parent.fds[n] === null || parent.fds[n] === undefined ? null : n))
    if (numbers.length > FDS_MAX) refuse('EMFILE')
    const fds: (Channel | null)[] = []
    for (const n of numbers) {
      if (n === null) { fds.push(null); continue }
      const ch = parent.fds[n]
      if (ch === null || ch === undefined) refuse('EBADF')
      fds.push(ch)
    }
    const proc = this.make(parent, args, env, cwd, parent.cred, fds, opts.group ?? parent.pgid, parent.umask)
    this.start(proc, program)
    return proc
  }

  /**
   * Turns a task into another program: it keeps its number, its descriptors and its directory, and takes the new
   * program's name and arguments (and environment, when one is given). The program is looked up first, so a name
   * that runs nothing is refused while the task is still what it was, and so is an exec EXEC_DEPTH deep (ENOMEM).
   * The new program's status. Once it runs, a refusal it does not catch ends the task the way it would end any task
   * (a closed pipe quietly, with 141), so the program that called exec never mistakes it for a failure to start.
   */
  *exec(proc: Proc, argv: readonly string[], env?: ReadonlyMap<string, string>): Task<number> {
    // A copy: the map handed in may be the task's own, which is emptied below.
    const vars = env === undefined ? undefined : new Map(env)
    this.sized(argv, vars ?? proc.env)
    if (proc.execs >= EXEC_DEPTH) refuse('ENOMEM', 'too many programs run in place of one another')
    const found = yield* this.load(vars === undefined ? proc : { ...proc, env: vars }, argv)
    if (vars !== undefined) {
      proc.env.clear()
      for (const [k, v] of vars) proc.env.set(k, v)
    }
    proc.argv = found.argv
    proc.name = argv[0].slice(argv[0].lastIndexOf('/') + 1)
    proc.execs++
    try {
      return yield* found.program(new Sys(this, proc), found.argv)
    } catch (e) {
      if (!(e instanceof OsError)) throw e
      if (e.errno === 'EPIPE') throw new Exit(141)
      this.complain(proc, `${proc.name}: ${e.message}`)
      throw new Exit(1)
    } finally {
      proc.execs--
    }
  }

  /** Runs tasks until `steps` calls are spent, the clock reaches `deadline`, or none can go on. True when some still could. */
  run(steps: number, deadline: number): boolean {
    let left = steps
    this.deadline = deadline
    // The first pass picks up after the task whose turn ended the last call, so a turn that spends a whole call
    // never keeps the tasks after it from theirs.
    let after = this.last
    this.last = 0
    for (;;) {
      let moved = false
      for (const proc of [...this.table.values()]) {
        if (proc.pid <= after || proc.state === 'ended') continue
        if (proc.ending !== null) {
          this.finish(proc, proc.ending)
          moved = true
          continue
        }
        if (proc.wait !== null) {
          let ready: boolean
          try { ready = proc.wait.ready() } catch { ready = true }
          if (!ready) continue
          proc.wait = null
        }
        moved = true
        left -= this.turn(proc)
        if (left <= 0 || this.clock() >= deadline) {
          this.last = proc.pid
          return true
        }
      }
      // A first pass that started part way and moved nothing is not yet a whole pass.
      if (!moved && after === 0) return false
      after = 0
    }
  }

  /** One turn of one task: runs it to its next wait or its end. The calls it used. */
  private turn(proc: Proc): number {
    const task = proc.task
    if (task === null) { this.finish(proc, 70); return 1 }
    this.current = proc
    this.slice = SLICE
    try {
      const step = task.next()
      if (step.done === true) this.finish(proc, typeof step.value === 'number' && Number.isFinite(step.value) ? step.value & 255 : 0)
      else proc.wait = step.value
    } catch (e) {
      proc.task = null
      if (e instanceof Exit) this.finish(proc, e.status & 255)
      else if (e instanceof OsError && e.errno === 'EPIPE') this.finish(proc, 141)
      else if (e instanceof OsError) {
        this.complain(proc, `${proc.name}: ${e.message}`)
        this.finish(proc, 1)
      } else {
        let text: string
        try {
          text = reasonOf(e)
        } catch {
          text = 'an error that cannot be shown'
        }
        this.complain(proc, `${proc.name}: fault: ${text}`)
        this.log(`task ${proc.pid} (${proc.name}) faulted: ${text}`)
        this.finish(proc, 70)
      }
    } finally {
      this.current = null
    }
    return SLICE - this.slice + 1
  }

  /** Writes a line to a task's error output if that can be done without waiting. */
  private complain(proc: Proc, text: string): void {
    const ch = proc.fds[2]
    if (ch === null || ch === undefined) return
    try {
      now(ch.write(encode(`${text}\n`), proc))
    } catch {
      this.log(`task ${proc.pid}: ${text}`)
    }
  }

  private finish(proc: Proc, status: number): void {
    if (proc.state === 'ended') return
    const task = proc.task
    proc.task = null
    proc.wait = null
    proc.ending = null
    proc.state = 'ended'
    proc.status = status
    if (task !== null) {
      // Run the body's cleanup; whatever it yields or throws now is dropped.
      try { task.return(status) } catch { /* a cleanup that fails is no longer anyone's concern */ }
    }
    for (let fd = 0; fd < proc.fds.length; fd++) this.drop(proc, fd)
    for (const other of [...this.table.values()]) {
      if (other.ppid !== proc.pid) continue
      other.ppid = 1
      if (other.state === 'ended') this.reap(other)
    }
    const parent = this.table.get(proc.ppid)
    if (parent === undefined || parent.state === 'ended' || proc.ppid === 1) this.reap(proc)
    if (this.tty.foreground === proc.pgid && !this.alive(proc.pgid)) this.tty.foreground = this.home
    if (proc.pid === 1) {
      this.log('task 1 ended: the console has no shell until it is started again')
      for (const other of this.table.values()) if (other.state !== 'ended') other.ending = 137
    }
  }

  private alive(pgid: number): boolean {
    for (const p of this.table.values()) if (p.pgid === pgid && p.state !== 'ended') return true
    return false
  }

  private reap(proc: Proc): void {
    this.table.delete(proc.pid)
    this.exited.set(proc.pid, { ppid: proc.ppid, status: proc.status })
    if (this.exited.size > EXITED_MAX) {
      for (const oldest of this.exited.keys()) { this.exited.delete(oldest); break }
    }
  }

  private drop(proc: Proc, fd: number): void {
    const ch = proc.fds[fd]
    if (ch === null || ch === undefined) return
    proc.fds[fd] = null
    if (--ch.refs <= 0) {
      try { ch.close() } catch { /* closing never fails a task */ }
    }
  }

  /** Asks a task to end with `status` on its next turn. ESRCH when there is none. */
  stop(pid: number, status = 143, by: Cred = ROOT_CRED): void {
    const proc = this.table.get(pid)
    if (proc === undefined || proc.state === 'ended') refuse('ESRCH')
    if (by.uid !== 0 && by.uid !== proc.cred.uid) refuse('EPERM')
    if (pid === 1) refuse('EPERM', 'task 1 cannot be stopped')
    proc.ending = status
  }

  /**
   * Ends now every task asked to end, as the first pass of the next turn would: their cleanups run (timeout stopping
   * the command it ran), so a host that asks afterwards whether a task still waits gets the answer that turn would give.
   */
  settle(): void {
    for (const proc of [...this.table.values()]) if (proc.state !== 'ended' && proc.ending !== null) this.finish(proc, proc.ending)
  }

  /** Asks every task of a group to end. The count asked. */
  stopGroup(pgid: number, status: number): number {
    let n = 0
    for (const proc of this.table.values()) {
      if (proc.pgid !== pgid || proc.state === 'ended' || proc.pid === 1) continue
      proc.ending = status
      n++
    }
    return n
  }

  /**
   * Ctrl+C: ends the foreground job, if one has the terminal, forgets typed lines nobody read, and tells the
   * console's shell to give up the line it was running. A shell that waits at its prompt is handed an end of input,
   * so it notices at once (and drops a command it was reading the rest of). True when a job was ended.
   */
  interrupt(): boolean {
    this.tty.forget()
    this.interrupted = true
    for (const pid of this.tty.readers) {
      if (this.table.get(pid)?.pgid === this.home) { this.tty.end(); break }
    }
    if (this.tty.foreground === this.home) return false
    return this.stopGroup(this.tty.foreground, 130) > 0
  }

  /** Whether Ctrl+C was pressed since the console's shell last asked; asking clears it. Only that shell's group is told. */
  takeInterrupt(proc: Proc): boolean {
    if (!this.interrupted || proc.pgid !== this.home) return false
    this.interrupted = false
    return true
  }

  /** Whether a Ctrl+C waits to be noticed by this task (the console's shell group only); asking clears nothing. */
  interruptPending(proc: Proc): boolean { return this.interrupted && proc.pgid === this.home }

  /** Whether every task waits (or none lives): nothing would move if `run` were called now. */
  idle(): boolean {
    for (const proc of this.table.values()) {
      if (proc.state === 'ended') continue
      if (proc.ending !== null || proc.wait === null) return false
      let ready: boolean
      try { ready = proc.wait.ready() } catch { ready = true }
      if (ready) return false
    }
    return true
  }

  /** The earliest clock time a waiting task named, or null when none waits on the clock. */
  nextWake(): number | null {
    let at: number | null = null
    for (const proc of this.table.values()) {
      const t = proc.wait?.at
      if (t !== undefined && (at === null || t < at)) at = t
    }
    return at
  }

  proc(pid: number): Proc | undefined { return this.table.get(pid) }

  /** The status a task that has ended and gone ended with, if it is still remembered. */
  ended(pid: number): number | undefined { return this.exited.get(pid)?.status }

  /** The remembered status of a task that was `parent`'s child, if it ended and went. */
  private gone(parent: Proc, pid: number): number | undefined {
    const was = this.exited.get(pid)
    return was !== undefined && was.ppid === parent.pid ? was.status : undefined
  }

  /** Every task, by number. */
  ps(): ProcInfo[] {
    const out: ProcInfo[] = []
    for (const p of this.table.values()) {
      out.push({
        pid: p.pid, ppid: p.ppid, pgid: p.pgid, uid: p.cred.uid, name: p.name, argv: p.argv, cwd: p.cwd,
        state: p.state === 'ended' ? 'end' : p.wait === null ? 'run' : 'wait',
        why: p.state === 'ended' ? 'ended' : p.wait === null ? 'run' : p.wait.why,
        started: p.started, steps: p.steps, fds: p.fds.map((ch) => (ch === null || ch === undefined ? null : ch.label)), env: p.env,
      })
    }
    return out.sort((a, b) => a.pid - b.pid)
  }

  // What follows is what `Sys` needs from the table; programs never see the kernel itself.

  /** The lowest free descriptor of a task, holding `ch`. */
  install(proc: Proc, ch: Channel, least = 0): number {
    // A descriptor below zero or between two numbers would sit outside the table, never to be closed.
    if (!Number.isInteger(least) || least < 0) refuse('EINVAL')
    for (let fd = least; fd < FDS_MAX; fd++) {
      if (proc.fds[fd] === null || proc.fds[fd] === undefined) {
        while (proc.fds.length < fd) proc.fds.push(null)
        proc.fds[fd] = ch
        ch.refs++
        return fd
      }
    }
    return refuse('EMFILE')
  }

  channel(proc: Proc, fd: number): Channel {
    const ch = Number.isInteger(fd) && fd >= 0 ? proc.fds[fd] : undefined
    if (ch === null || ch === undefined) refuse('EBADF')
    return ch
  }

  close(proc: Proc, fd: number): void {
    this.channel(proc, fd)
    this.drop(proc, fd)
  }

  dup2(proc: Proc, from: number, to: number): void {
    const ch = this.channel(proc, from)
    if (!Number.isInteger(to) || to < 0 || to >= FDS_MAX) refuse('EBADF')
    if (from === to) return
    this.drop(proc, to)
    while (proc.fds.length < to) proc.fds.push(null)
    proc.fds[to] = ch
    ch.refs++
  }

  pipe(proc: Proc): [number, number] {
    const pipe = new Pipe(this.nextPipe++)
    const reader = new PipeEnd(pipe, false)
    const writer = new PipeEnd(pipe, true)
    let r = -1
    try {
      r = this.install(proc, reader)
      return [r, this.install(proc, writer)]
    } catch (e) {
      if (r >= 0) this.drop(proc, r)
      else reader.close()
      writer.close()
      throw e
    }
  }

  fileChannel(handle: Handle, label: string): Channel { return new FileChannel(handle, label) }

  /** Collects a child's status, waiting for it to end. ECHILD when `pid` is no child of `parent`. */
  *wait(parent: Proc, pid: number): Task<number> {
    for (;;) {
      const child = this.table.get(pid)
      if (child === undefined || child.ppid !== parent.pid) {
        const status = this.gone(parent, pid)
        if (status !== undefined) return status
        return refuse('ECHILD')
      }
      if (child.state === 'ended') {
        this.reap(child)
        return child.status
      }
      yield { why: 'wait', ready: () => child.state === 'ended' }
    }
  }

  /** A child's status if it has ended (collecting it), 'running' if not, null when there is no such child. */
  poll(parent: Proc, pid: number): number | 'running' | null {
    const child = this.table.get(pid)
    if (child === undefined || child.ppid !== parent.pid) return this.gone(parent, pid) ?? null
    if (child.state !== 'ended') return 'running'
    this.reap(child)
    return child.status
  }
}

/** A mount as `mount` and `df` show it. */
export interface MountInfo {
  readonly path: string
  readonly source: string
  readonly type: string
  readonly readOnly: boolean
  readonly capacity: number
  readonly used: number
  readonly nodes: number
}

/** The largest piece `readAll` asks for at once. */
const CHUNK = 65536
/** The most bytes `readAll` holds: more is refused rather than kept in memory. */
export const READ_ALL_MAX = 64 << 20

/**
 * What a program may do: every call a task makes goes through here. Calls that can wait are tasks (`yield*` them);
 * the rest answer at once.
 */
export class Sys {
  private readonly k: Kernel
  private readonly p: Proc

  constructor(kernel: Kernel, proc: Proc) {
    this.k = kernel
    this.p = proc
  }

  /**
   * Counts a call against the task's turn; the task lets the others run when its turn is spent, or when the host's
   * deadline has come (looked at every LOOK calls, so a cheap loop pays little for it).
   */
  private *tick(): Task<void> {
    this.p.steps++
    const k = this.k
    if (--k.slice <= 0 || (k.slice % LOOK === 0 && k.clock() >= k.deadline)) yield BREATH
  }

  get pid(): number { return this.p.pid }
  get ppid(): number { return this.p.ppid }
  get pgid(): number { return this.p.pgid }
  get cred(): Cred { return this.p.cred }
  get cwd(): string { return this.p.cwd }
  get env(): Map<string, string> { return this.p.env }
  get hostname(): string { return this.k.hostname }
  get umask(): number { return this.p.umask }
  set umask(bits: number) { this.p.umask = bits & 0o777 }

  /** Milliseconds on the clock that only goes up. */
  now(): number { return this.k.clock() }
  /** Milliseconds since 1970. */
  wall(): number { return this.k.wall() }
  /** Milliseconds since the kernel started. */
  uptime(): number { return this.k.clock() - this.k.booted }

  /** Ends the task from anywhere inside it. */
  exit(status: number): never { throw new Exit(status) }

  /** Counts one call against the task's turn without doing anything else: a loop that makes no other call uses it. */
  *step(): Task<void> {
    yield* this.tick()
  }

  /** Lets the other tasks run: a long computation calls this now and then. */
  *breathe(): Task<void> {
    this.p.steps++
    yield BREATH
  }

  *sleep(ms: number): Task<void> {
    yield* this.tick()
    const at = this.k.clock() + Math.max(0, ms)
    const clock = this.k.clock
    while (clock() < at) yield { why: 'sleep', at, ready: () => clock() >= at }
  }

  // Descriptors.

  *open(path: string, flags: number, mode = 0o666): Task<number> {
    yield* this.tick()
    const p = this.p
    const full = normalize(path, p.cwd)
    const handle = yield* this.k.vfs.open(path, p.cwd, p.cred, flags, (flags & O_CREATE) !== 0 ? mode & ~p.umask : mode)
    // The terminal opened by name is the terminal itself: a read of it waits for a typed line as any read of it does.
    if (full === '/dev/tty' && handle.kind === 'stream') {
      handle.close()
      return this.k.install(p, this.k.terminalChannel())
    }
    try {
      return this.k.install(p, this.k.fileChannel(handle, full))
    } catch (e) {
      handle.close()
      throw e
    }
  }

  close(fd: number): void { this.k.close(this.p, fd) }

  /** Up to `length` bytes; none at the end of the input. */
  *read(fd: number, length = CHUNK): Task<Uint8Array> {
    yield* this.tick()
    return yield* this.k.channel(this.p, fd).read(length, this.p)
  }

  /** Writes all of `data`. */
  *write(fd: number, data: Uint8Array): Task<number> {
    yield* this.tick()
    return yield* this.k.channel(this.p, fd).write(data, this.p)
  }

  *seek(fd: number, offset: number, whence: 0 | 1 | 2 = 0): Task<number> {
    yield* this.tick()
    return yield* this.k.channel(this.p, fd).seek(offset, whence)
  }

  /** What `stat` says of an open file; null for a pipe or the terminal. */
  *fstat(fd: number): Task<FileStat | null> {
    yield* this.tick()
    return yield* this.k.channel(this.p, fd).stat()
  }

  *ftruncate(fd: number, size: number): Task<void> {
    yield* this.tick()
    yield* this.k.channel(this.p, fd).truncate(size)
  }

  /** A second descriptor for the same open file: the lowest free one from `least` up. */
  dup(fd: number, least = 0): number { return this.k.install(this.p, this.k.channel(this.p, fd), least) }
  /** Makes descriptor `to` refer to what `from` does, closing what `to` was. */
  dup2(from: number, to: number): void { this.k.dup2(this.p, from, to) }
  /** A new pipe: the descriptor to read from, then the one to write to. */
  pipe(): [number, number] { return this.k.pipe(this.p) }
  /** Whether a descriptor is open. */
  isOpen(fd: number): boolean { return this.p.fds[fd] !== null && this.p.fds[fd] !== undefined }
  /** Whether a descriptor is the terminal. */
  isatty(fd: number): boolean { return this.isOpen(fd) && this.k.channel(this.p, fd).tty }

  /** Everything left on a descriptor. */
  *readAll(fd: number): Task<Uint8Array> {
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const chunk = yield* this.read(fd, CHUNK)
      if (chunk.length === 0) break
      total += chunk.length
      if (total > READ_ALL_MAX) refuse('EFBIG', 'too much to hold in memory')
      chunks.push(chunk)
    }
    return chunks.length === 1 ? chunks[0] : concat(chunks)
  }

  /** Writes text to the ordinary output. */
  *print(text: string): Task<void> {
    if (text !== '') yield* this.write(1, encode(text))
  }

  /** Writes text to the error output; never fails the caller (an error output that is closed is not an error). */
  *eprint(text: string): Task<void> {
    try {
      if (text !== '') yield* this.write(2, encode(text))
    } catch (e) {
      if (!(e instanceof OsError)) throw e
    }
  }

  // Paths.

  *stat(path: string): Task<FileStat> {
    yield* this.tick()
    return yield* this.k.vfs.stat(path, this.p.cwd, this.p.cred)
  }

  /** Whether the path names something the task may `want` (R, W, X or a sum; 0 asks only whether it exists). */
  *access(path: string, want = 0): Task<boolean> {
    yield* this.tick()
    return yield* this.k.vfs.access(path, this.p.cwd, this.p.cred, want)
  }

  /** A directory's names, sorted. */
  *list(path: string): Task<Entry[]> {
    yield* this.tick()
    return yield* this.k.vfs.list(path, this.p.cwd, this.p.cred)
  }

  *mkdir(path: string, mode = 0o777): Task<void> {
    yield* this.tick()
    yield* this.k.vfs.mkdir(path, this.p.cwd, this.p.cred, mode & ~this.p.umask)
  }

  *unlink(path: string): Task<void> {
    yield* this.tick()
    yield* this.k.vfs.unlink(path, this.p.cwd, this.p.cred)
  }

  *rmdir(path: string): Task<void> {
    yield* this.tick()
    yield* this.k.vfs.rmdir(path, this.p.cwd, this.p.cred)
  }

  *rename(from: string, to: string): Task<void> {
    yield* this.tick()
    yield* this.k.vfs.rename(from, to, this.p.cwd, this.p.cred)
  }

  *chmod(path: string, mode: number): Task<void> {
    yield* this.tick()
    yield* this.k.vfs.chmod(path, this.p.cwd, this.p.cred, mode)
  }

  *chown(path: string, uid: number, gid: number): Task<void> {
    yield* this.tick()
    yield* this.k.vfs.chown(path, this.p.cwd, this.p.cred, uid, gid)
  }

  *utime(path: string, mtime: number): Task<void> {
    yield* this.tick()
    yield* this.k.vfs.utime(path, this.p.cwd, this.p.cred, mtime)
  }

  *truncate(path: string, size: number): Task<void> {
    yield* this.tick()
    yield* this.k.vfs.truncate(path, this.p.cwd, this.p.cred, size)
  }

  *readFile(path: string): Task<Uint8Array> {
    yield* this.tick()
    return yield* this.k.vfs.readFile(path, this.p.cwd, this.p.cred)
  }

  *writeFile(path: string, data: Uint8Array, opts: { readonly append?: boolean; readonly mode?: number } = {}): Task<void> {
    yield* this.tick()
    yield* this.k.vfs.writeFile(path, this.p.cwd, this.p.cred, data, { append: opts.append, mode: (opts.mode ?? 0o666) & ~this.p.umask })
  }

  /** Changes the task's directory. */
  *chdir(path: string): Task<void> {
    yield* this.tick()
    const p = this.p
    const st = yield* this.k.vfs.stat(path, p.cwd, p.cred)
    if (st.kind !== 'dir') refuse('ENOTDIR')
    if (!permits(st, p.cred, X)) refuse('EACCES')
    p.cwd = normalize(path, p.cwd)
  }

  /** The path as the file system reads it from the task's directory: absolute, no `.` or `..`. */
  resolve(path: string): string { return normalize(path, this.p.cwd) }

  // Tasks.

  /** Starts a child; its number. A name that runs nothing is refused here (ENOENT, EACCES, ENOEXEC). */
  *spawn(argv: readonly string[], opts: SpawnOptions = {}): Task<number> {
    yield* this.tick()
    return (yield* this.k.spawn(this.p, argv, opts)).pid
  }

  /**
   * Becomes another program, keeping this task's number, descriptors and directory: `return yield* sys.exec(argv)`.
   * Refused (ENOENT, EACCES, ENOEXEC) while the task is still itself when the name runs nothing.
   */
  *exec(argv: readonly string[], env?: ReadonlyMap<string, string>): Task<number> {
    yield* this.tick()
    return yield* this.k.exec(this.p, argv, env)
  }

  /** Waits for a child to end; its status. */
  *wait(pid: number): Task<number> {
    yield* this.tick()
    return yield* this.k.wait(this.p, pid)
  }

  /** A child's status if it has ended, 'running' if not, null when there is no such child. */
  poll(pid: number): number | 'running' | null { return this.k.poll(this.p, pid) }

  /** Asks a task to end. */
  stop(pid: number, status = 143): void { this.k.stop(pid, status, this.p.cred) }

  /** Asks every task of a group to end; how many were asked. */
  stopGroup(pgid: number, status = 143): number {
    if (this.p.cred.uid !== 0) refuse('EPERM')
    return this.k.stopGroup(pgid, status)
  }

  ps(): ProcInfo[] { return this.k.ps() }

  /** Whether a path or name would run something for this task; the refusal otherwise. */
  *runs(name: string): Task<boolean> {
    yield* this.tick()
    try {
      yield* this.k.load(this.p, [name])
      return true
    } catch (e) {
      if (e instanceof OsError) return false
      throw e
    }
  }

  // The terminal.

  /** Makes this task's group the one the terminal falls back to, and gives it the terminal: the console's shell calls it once. */
  takeTerminal(): void {
    if (this.p.cred.uid !== 0) refuse('EPERM')
    this.k.home = this.p.pgid
    this.k.tty.foreground = this.p.pgid
  }
  /** Whether Ctrl+C was pressed since this last asked (only the console's shell is ever told yes). */
  interrupted(): boolean { return this.k.takeInterrupt(this.p) }

  /** Whether a Ctrl+C waits to be noticed (so a wait can end early); `interrupted` is what takes it. */
  interruptPending(): boolean { return this.k.interruptPending(this.p) }
  /** Gives the terminal's input to a group (a shell does this for the job it waits on, and takes it back after). */
  foreground(pgid: number): void { this.k.tty.foreground = pgid }
  /** The group that has the terminal's input. */
  get terminalGroup(): number { return this.k.tty.foreground }
  /**
   * Sets what the console shows before the next typed line; `continuing` says that line finishes a command already
   * begun, or, as 'input', that it is input the shell itself reads (its `read`), not a command at all.
   */
  prompt(text: string, continuing: boolean | 'input' = false): void {
    this.k.tty.prompt = text
    this.k.tty.continuing = continuing !== false
    this.k.tty.reply = continuing === 'input'
  }
  /** Ends a line written without a line end, so it shows now. */
  flushTerminal(): void { this.k.tty.flush() }
  /**
   * Forgets the typed lines nobody has read yet, as Ctrl+C does: the console's own shell does this when `exit` gives up
   * its line, so a line typed with it (a second line of the same entry) or ahead of it never runs after it.
   */
  forgetTyped(): void { this.k.tty.forget() }
  /** Hands the host something of its own, in order with the lines written around it. */
  post(payload: unknown): void { this.k.tty.post(payload) }

  // The system.

  mounts(): MountInfo[] {
    return this.k.vfs.mounts().map((m: Mount) => {
      const u = this.k.vfs.usage(m)
      return { path: m.path, source: m.source, type: m.driver.type, readOnly: m.driver.readOnly, capacity: u.capacity, used: u.used, nodes: u.nodes }
    })
  }

  *mount(path: string, driver: Driver, source: string): Task<void> {
    yield* this.tick()
    yield* this.k.vfs.mount(this.resolve(path), driver, source, this.p.cred)
  }

  umount(path: string): void {
    const where = this.resolve(path)
    for (const p of this.k.ps()) {
      if (p.state !== 'end' && (p.cwd === where || p.cwd.startsWith(`${where}/`))) refuse('EBUSY', `task ${p.pid} is working in it`)
    }
    this.k.vfs.umount(where, this.p.cred)
  }

  dmesg(): readonly string[] { return this.k.dmesg() }
  log(text: string): void { this.k.log(text) }
  /** Bytes a pipe holds at most: a program that fills one sizes its writes by this. */
  get pipeSize(): number { return PIPE_MAX }
}

export { O_READ, O_WRITE }
