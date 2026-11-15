// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the kernel (kernel.ts, with task.ts and pipe.ts under it) to what it promises
 * the programs and the host: turns taken in order and shared fairly, even when a turn spends the whole of what the
 * host gave; a step budget and a deadline that end a call to `run` even for a task that never waits; spawn and exec
 * that look a program up before anything changes and refuse what runs nothing; wait and poll for a task's own
 * children only; the caps on tasks, descriptors, arguments and the log; descriptors handed down, shared and closed
 * when a task ends; pipes that hold a writer back, tell a reader the end has come and refuse a writer nobody reads;
 * Ctrl+C for the foreground group alone, Ctrl+D and typed lines for whoever may read; sleeps on the clock; and
 * faults, which end the task that made them with 70 and a log line, and never reach the host.
 * What breaks if it is removed? A task that hogs every turn, a status handed to a task that never started it, a
 * descriptor that never closes (so a reader waits for ever), arguments past the cap through exec, or a fault thrown
 * at the page could all come back without a test noticing.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decode, encode } from './bytes.ts'
import { OsError } from './errno.ts'
import { ROOT_CRED } from './fs.ts'
import { ARGS_MAX, Exit, FDS_MAX, Kernel, PROCS_MAX, SLICE } from './kernel.ts'
import type { Proc, Program, SpawnOptions } from './kernel.ts'
import { FILE_PROGRAMS } from './fileutils.ts'
import { boot } from './kit.test.ts'
import { MemFs } from './memfs.ts'
import { PIPE_MAX } from './pipe.ts'
import { SYS_PROGRAMS } from './sysutils.ts'
import { BREATH, Later, io, now } from './task.ts'
import type { Io, Task, Wait } from './task.ts'
import { INPUT_MAX } from './tty.ts'
import { Vfs } from './vfs.ts'

/** A wait that is never over. */
const NEVER: Wait = Object.freeze({ why: 'nap', ready: () => false })

/** Never ends by itself. */
const nap: Program = function* () {
  for (;;) yield NEVER
}

/** Copies its input to its output. */
const cat: Program = function* (sys) {
  for (;;) {
    const chunk = yield* sys.read(0)
    if (chunk.length === 0) return 0
    yield* sys.write(1, chunk)
  }
}

/** Prints its arguments, one to a line. */
const args: Program = function* (sys, argv) {
  yield* sys.print(argv.map((a) => `${a}\n`).join(''))
  return 0
}

/** Ends with the status its first argument names. */
const status: Program = function* (_sys, argv) {
  return Number(argv[1] ?? '0')
}

interface Machine {
  readonly kernel: Kernel
  /** Task 1. With the default body it only waits, so a task started from it is collected the moment it ends. */
  readonly init: Proc
  /** The clock now. */
  now(): number
  /** Moves the clock on by `ms` milliseconds. */
  tick(ms: number): void
  /** Runs until nothing can move and gives back what was printed, each error line with `!` before it. */
  settle(): string[]
  /** Starts a task straight through the kernel, as a child of task 1 unless a parent is named. */
  start(argv: readonly string[], opts?: SpawnOptions, parent?: Proc): Proc
}

/** A kernel on a memory disk, with these programs in /bin (each a `#!native` file) and PATH=/bin. */
function machine(programs: Readonly<Record<string, Program>> = {}, init: Program = nap): Machine {
  let t = 0
  const clock = (): number => t
  const vfs = new Vfs(new MemFs({ capacity: 1 << 20, maxFile: 1 << 16, maxNodes: 1024, clock }), 'disk')
  now(vfs.mkdir('/bin', '/', ROOT_CRED, 0o755))
  for (const name of Object.keys(programs)) now(vfs.writeFile(`/bin/${name}`, '/', ROOT_CRED, encode(`#!native ${name}\n`), { mode: 0o755 }))
  const kernel = new Kernel({ vfs, clock, programs: new Map(Object.entries(programs)), hostname: 'testhost' })
  const first = kernel.boot(init, ['init'], new Map([['PATH', '/bin']]))
  const lines = (): string[] =>
    kernel.tty.drain().map((e) => (e.kind === 'post' ? `POST ${JSON.stringify(e.payload)}` : `${e.kind === 'err' ? '!' : ''}${e.text}`))
  const settle = (): string[] => {
    const out: string[] = []
    for (let i = 0; i < 1000; i++) {
      kernel.run(1_000_000, Number.POSITIVE_INFINITY)
      out.push(...lines())
      if (kernel.idle()) return out
    }
    throw new Error('the kernel never settled')
  }
  settle()
  return {
    kernel,
    init: first,
    now: clock,
    tick(ms) { t += ms },
    settle,
    start: (argv, opts = {}, parent = first) => now(kernel.spawn(parent, argv, opts)),
  }
}

/** The errno a direct call refuses with, or null when it does not refuse. */
function errnoOf(run: () => unknown): string | null {
  try {
    run()
    return null
  } catch (e) {
    if (e instanceof OsError) return e.errno
    throw e
  }
}

/** Inside a task: the errno a call refuses with, or null when it does not refuse. */
function* errnoIn(task: Task<unknown>): Task<string | null> {
  try {
    yield* task
    return null
  } catch (e) {
    if (e instanceof OsError) return e.errno
    throw e
  }
}

/** The descriptors a task holds open, by number. */
function open(m: Machine, pid: number): number[] {
  const out: number[] = []
  for (const [fd, ch] of (m.kernel.proc(pid)?.fds ?? []).entries()) if (ch !== null && ch !== undefined) out.push(fd)
  return out
}

// Tasks, waits and answers that come later (task.ts).

test('now runs a task that never waits; one that would wait is refused by name after its cleanup; a runaway is refused too', () => {
  const short = function* (): Task<number> {
    yield BREATH
    return 5
  }
  assert.equal(now(short()), 5)
  const cleaned: string[] = []
  const waits = function* (): Task<number> {
    try {
      yield { why: 'a drive', ready: () => false }
      return 1
    } finally {
      cleaned.push('cleaned')
    }
  }
  assert.throws(() => now(waits()), (e: unknown) => e instanceof OsError && e.errno === 'EAGAIN' && /this would wait \(a drive\)/.test(e.message))
  assert.deepEqual(cleaned, ['cleaned'])
  const runaway = function* (): Task<number> {
    try {
      for (;;) yield BREATH
    } finally {
      cleaned.push('stopped')
    }
  }
  assert.throws(() => now(runaway()), (e: unknown) => e instanceof OsError && e.errno === 'EAGAIN' && /never ends/.test(e.message))
  assert.deepEqual(cleaned, ['cleaned', 'stopped'])
})

test('io: a value at once, a Later after it settles, and a Later\'s refusal thrown where it is read', () => {
  assert.equal(now(io(7)), 7)
  const later = new Later<number>()
  const t = io(later)
  const first = t.next()
  assert.ok(first.done !== true && first.value.why === 'io' && !first.value.ready())
  later.resolve(8)
  assert.deepEqual(t.next(), { done: true, value: 8 })
  const refused = new Later<number>()
  refused.reject(new OsError('EIO', 'the drive went away'))
  assert.throws(() => now(io(refused)), /the drive went away/)
})

test('Later settles once, tells every listener in order, maps values and refusals, and a narrower one serves where a wider is asked for', () => {
  const later = new Later<string>()
  const heard: string[] = []
  later.settled((from) => heard.push(`a ${from.value}`))
  later.settled((from) => heard.push(`b ${from.value}`))
  const upper = later.map((v) => v.toUpperCase())
  const broken = later.map((): number => { throw new Error('no map') })
  const refusing = later.map((): number => { throw new OsError('EINVAL') })
  later.resolve('first')
  later.resolve('second')
  later.reject(new OsError('EIO'))
  assert.deepEqual(heard, ['a first', 'b first'])
  assert.equal(later.value, 'first')
  assert.equal(later.error, null)
  later.settled((from) => heard.push(`late ${from.value}`))
  assert.deepEqual(heard, ['a first', 'b first', 'late first'])
  assert.equal(upper.value, 'FIRST')
  assert.equal(broken.error?.errno, 'EIO')
  assert.equal(broken.error?.message, 'no map')
  assert.equal(refusing.error?.errno, 'EINVAL')
  // A refusal passes through a map untouched.
  const failed = new Later<number>()
  const mapped = failed.map((n) => n + 1)
  failed.reject(new OsError('EACCES'))
  assert.equal(mapped.error?.errno, 'EACCES')
  assert.equal(mapped.done, true)
  // A reading that answers later with text is what a file that may answer with text or bytes hands back.
  const text = new Later<string>()
  const wide: Io<string | Uint8Array> = text
  const read = io(wide)
  read.next()
  text.resolve('arrived')
  assert.deepEqual(read.next(), { done: true, value: 'arrived' })
})

// Turns, budgets and deadlines.

test('two busy tasks both go on: a turn is at most SLICE calls, and the turns go round', () => {
  const m = machine()
  const counts = [0, 0]
  const busy = (i: number): Program => function* (sys) {
    for (;;) {
      counts[i]++
      yield* sys.step()
    }
  }
  m.start(['a'], { program: busy(0) })
  m.start(['b'], { program: busy(1) })
  // A budget of one call still gives one whole turn, and no more.
  assert.equal(m.kernel.run(1, Number.POSITIVE_INFINITY), true)
  assert.deepEqual(counts, [SLICE, 0])
  // The next call picks up where the last one stopped, so the second task is not starved by the first.
  assert.equal(m.kernel.run(1, Number.POSITIVE_INFINITY), true)
  assert.deepEqual(counts, [SLICE, SLICE])
  for (let i = 0; i < 9; i++) m.kernel.run(1, Number.POSITIVE_INFINITY)
  assert.ok(Math.abs(counts[0] - counts[1]) <= SLICE, `${counts}`)
  // Within one call they alternate too.
  m.kernel.run(SLICE * 40, Number.POSITIVE_INFINITY)
  assert.ok(Math.abs(counts[0] - counts[1]) <= SLICE, `${counts}`)
  assert.ok(counts[0] > SLICE * 20)
  // The calls are counted against each task.
  const steps = m.kernel.ps().filter((p) => p.name === 'a' || p.name === 'b').map((p) => p.steps)
  assert.deepEqual(steps, counts)
})

test('run returns on the deadline, on a clock that moves, even when every turn reaches it', () => {
  const m = machine()
  const counts = [0, 0]
  // Each call costs a millisecond: a turn of SLICE calls takes longer than the host's whole deadline.
  const busy = (i: number): Program => function* (sys) {
    for (;;) {
      counts[i]++
      m.tick(1)
      yield* sys.step()
    }
  }
  m.start(['a'], { program: busy(0) })
  m.start(['b'], { program: busy(1) })
  for (let i = 0; i < 10; i++) {
    const before = counts[0] + counts[1]
    assert.equal(m.kernel.run(Number.POSITIVE_INFINITY, m.now() + 4), true)
    // An endless budget, yet each call ends after one turn: the deadline was passed.
    assert.equal(counts[0] + counts[1] - before, SLICE)
  }
  assert.deepEqual(counts, [SLICE * 5, SLICE * 5])
})

test('run returns on the budget on a clock that does not move, and after one turn when the deadline has passed', () => {
  const m = machine()
  let count = 0
  m.start(['spin'], {
    program: function* (sys) {
      for (;;) {
        count++
        yield* sys.step()
      }
    },
  })
  // The clock never moves, so only the budget ends the call.
  assert.equal(m.kernel.run(1000, m.now() + 10), true)
  assert.ok(count >= 1000 - SLICE && count <= 1000 + SLICE, `${count}`)
  // A deadline already reached still gives one turn: the host always sees progress.
  count = 0
  assert.equal(m.kernel.run(1_000_000, m.now()), true)
  assert.equal(count, SLICE)
  // A task that only lets the others run (breathe) costs one call a turn and is bounded the same way.
  const m2 = machine()
  let breaths = 0
  m2.start(['breathe'], {
    program: function* (sys) {
      for (;;) {
        breaths++
        yield* sys.breathe()
      }
    },
  })
  assert.equal(m2.kernel.run(500, Number.POSITIVE_INFINITY), true)
  assert.equal(breaths, 500)
  // Nothing that can move: run says so.
  const m3 = machine()
  assert.equal(m3.kernel.run(1000, Number.POSITIVE_INFINITY), false)
  assert.equal(m3.kernel.idle(), true)
})

test('a sleep waits on the clock: ps says so, nextWake names the time, and it ends when the clock gets there', () => {
  const m = machine()
  const woke: number[] = []
  const p = m.start(['sleeper'], {
    program: function* (sys) {
      yield* sys.sleep(1000)
      woke.push(sys.now())
      yield* sys.sleep(0)
      yield* sys.sleep(-50)
      yield* sys.sleep(Number.NaN)
      woke.push(sys.now())
      return 0
    },
  })
  m.settle()
  assert.equal(m.kernel.ps().find((x) => x.pid === p.pid)?.why, 'sleep')
  assert.equal(m.kernel.nextWake(), 1000)
  m.tick(999)
  m.settle()
  assert.deepEqual(woke, [])
  m.tick(1)
  m.settle()
  // A sleep of nothing, less than nothing or not a number does not wait at all.
  assert.deepEqual(woke, [1000, 1000])
  assert.equal(m.kernel.ended(p.pid), 0)
  assert.equal(m.kernel.nextWake(), null)
})

// Spawn, exec and what runs.

test('spawn looks the program up first: what runs nothing is refused, and no task is made for it', () => {
  const m = machine({ cat, args })
  const vfs = m.kernel.vfs
  now(vfs.writeFile('/bin/text', '/', ROOT_CRED, encode('just words\n'), { mode: 0o755 }))
  now(vfs.writeFile('/bin/empty', '/', ROOT_CRED, new Uint8Array(0), { mode: 0o755 }))
  now(vfs.writeFile('/bin/locked', '/', ROOT_CRED, encode('#!native cat\n'), { mode: 0o644 }))
  now(vfs.writeFile('/bin/ghost', '/', ROOT_CRED, encode('#!native nosuch\n'), { mode: 0o755 }))
  now(vfs.writeFile('/bin/bare', '/', ROOT_CRED, encode('#!\n'), { mode: 0o755 }))
  now(vfs.writeFile('/bin/loop', '/', ROOT_CRED, encode('#!/bin/loop\n'), { mode: 0o755 }))
  now(vfs.mkdir('/bin/dir', '/', ROOT_CRED, 0o755))
  const before = m.kernel.ps().length
  const cases: [readonly string[], string, RegExp?][] = [
    [['nosuch'], 'ENOENT'],
    [[], 'ENOENT'],
    [[''], 'ENOENT'],
    [['text'], 'ENOEXEC'],
    [['empty'], 'ENOEXEC'],
    [['locked'], 'EACCES'],
    [['ghost'], 'ENOEXEC', /no native program 'nosuch'/],
    [['bare'], 'ENOEXEC'],
    // A script whose interpreter is itself: the chain is cut at its depth limit.
    [['loop'], 'ENOEXEC'],
    [['/bin/dir'], 'EACCES', /is a directory/],
    [['/bin/nosuch'], 'ENOENT'],
    // A directory along PATH named like the program is passed over, not run.
    [['dir'], 'ENOENT'],
  ]
  for (const [argv, errno, words] of cases) {
    try {
      m.start(argv)
      assert.fail(`${argv.join(' ')} started`)
    } catch (e) {
      assert.ok(e instanceof OsError, String(e))
      assert.equal(e.errno, errno, argv.join(' '))
      if (words !== undefined) assert.match(e.message, words)
    }
  }
  assert.equal(m.kernel.ps().length, before)
  // A script names its interpreter and its options: they run it, with the script's path and the arguments after.
  now(vfs.writeFile('/bin/script', '/', ROOT_CRED, encode('#!/bin/args -x\nbody\n'), { mode: 0o755 }))
  m.start(['script', 'one', 'two'])
  assert.deepEqual(m.settle(), ['/bin/args', '-x', '/bin/script', 'one', 'two'])
})

test('spawn refuses arguments or an environment past ARGS_MAX, and descriptors past FDS_MAX', () => {
  const m = machine({ args, status })
  const big = 'x'.repeat(ARGS_MAX)
  assert.equal(errnoOf(() => m.start(['args', big])), 'E2BIG')
  assert.equal(errnoOf(() => m.start(['args'], { env: new Map([['BIG', big]]) })), 'E2BIG')
  assert.equal(errnoOf(() => m.start(['args'], { fds: Array.from({ length: FDS_MAX + 1 }, () => 0) })), 'EMFILE')
  assert.equal(errnoOf(() => m.start(['args'], { fds: [0, 7] })), 'EBADF')
  assert.equal(errnoOf(() => m.start(['args'], { fds: [-1] })), 'EBADF')
  // Just under the cap is fine.
  const p = m.start(['status', 'x'.repeat(ARGS_MAX - 'status'.length - 3)])
  assert.deepEqual(m.settle(), [])
  assert.equal(m.kernel.ended(p.pid), 0)
})

test('exec: the program is looked up first, so a refusal leaves the task as it was and free to go on', () => {
  const m = machine({ args, status })
  now(m.kernel.vfs.writeFile('/bin/text', '/', ROOT_CRED, encode('words\n'), { mode: 0o755 }))
  const seen: (string | null)[] = []
  const p = m.start(['first', 'a'], {
    program: function* (sys, argv) {
      seen.push(yield* errnoIn(sys.exec(['text'])))
      seen.push(yield* errnoIn(sys.exec(['nosuch'])))
      seen.push(yield* errnoIn(sys.exec([])))
      // Still itself: its name, its arguments, its environment.
      const me = sys.ps().find((x) => x.pid === sys.pid)
      seen.push(`${me?.name} ${me?.argv === argv} ${sys.env.get('PATH')}`)
      return yield* sys.exec(['status', '9'])
    },
  })
  m.settle()
  assert.deepEqual(seen, ['ENOEXEC', 'ENOENT', 'ENOENT', 'first true /bin'])
  assert.equal(m.kernel.ended(p.pid), 9)
})

test('exec: once the new program runs, what it does not catch ends the task as it would end any task', () => {
  const failing: Program = function* (sys) {
    yield* sys.open('/nosuch', 1)
    return 0
  }
  const breaks: Program = function* () {
    throw new Error('broken inside')
  }
  const exits: Program = function* (sys) {
    return sys.exit(3)
  }
  const m = machine({ failing, breaks, exits, args })
  const shell = (cmd: string): Program => function* (sys) {
    try {
      return yield* sys.exec([cmd])
    } catch (e) {
      // Never reached for a program that started: its failure is its own.
      if (!(e instanceof OsError)) throw e
      yield* sys.print(`caller saw ${e.errno}\n`)
      return 99
    }
  }
  const a = m.start(['sh-a'], { program: shell('failing') })
  const b = m.start(['sh-b'], { program: shell('breaks') })
  const c = m.start(['sh-c'], { program: shell('exits') })
  assert.deepEqual(m.settle(), ['!failing: no such file or directory', '!breaks: fault: broken inside'])
  assert.equal(m.kernel.ended(a.pid), 1)
  assert.equal(m.kernel.ended(b.pid), 70)
  assert.equal(m.kernel.ended(c.pid), 3)
  assert.match(m.kernel.dmesg().join('\n'), /faulted: broken inside/)
  // A closed pipe ends the new program quietly, with 141.
  let piped = 0
  m.start(['pipeline'], {
    program: function* (sys) {
      const [r, w] = sys.pipe()
      sys.close(r)
      const pid = yield* sys.spawn(['writer'], {
        fds: [null, w, 2],
        program: function* (s2) {
          return yield* s2.exec(['args', 'into', 'nothing'])
        },
      })
      sys.close(w)
      piped = yield* sys.wait(pid)
      return 0
    },
  })
  assert.deepEqual(m.settle(), [])
  assert.equal(piped, 141)
})

test('exec takes a new environment whole, its own map included, and holds it to ARGS_MAX as spawn does', () => {
  const m = machine({ args })
  const env: Program = function* (sys) {
    yield* sys.print([...sys.env].map(([k, v]) => `${k}=${v}\n`).join(''))
    return 0
  }
  const m2 = machine({ env, args })
  // Handing exec the task's own environment, changed, keeps it.
  m2.start(['own'], {
    program: function* (sys) {
      sys.env.set('ADDED', 'yes')
      return yield* sys.exec(['env'], sys.env)
    },
  })
  assert.deepEqual(m2.settle(), ['PATH=/bin', 'ADDED=yes'])
  // A new map replaces it.
  m2.start(['fresh'], {
    program: function* (sys) {
      return yield* sys.exec(['/bin/env'], new Map([['ONLY', '1']]))
    },
  })
  assert.deepEqual(m2.settle(), ['ONLY=1'])
  // Arguments or an environment past the cap are refused before anything changes, as spawn refuses them.
  const seen: (string | null)[] = []
  const p = m.start(['big'], {
    program: function* (sys, argv) {
      seen.push(yield* errnoIn(sys.exec(['args', 'x'.repeat(ARGS_MAX)])))
      seen.push(yield* errnoIn(sys.exec(['args'], new Map([['BIG', 'x'.repeat(ARGS_MAX)]]))))
      const me = sys.ps().find((x) => x.pid === sys.pid)
      seen.push(String(me?.argv === argv && sys.env.get('BIG') === undefined))
      return 4
    },
  })
  assert.deepEqual(m.settle(), [])
  assert.deepEqual(seen, ['E2BIG', 'E2BIG', 'true'])
  assert.equal(m.kernel.ended(p.pid), 4)
})

test('exec past ARGS_MAX at the prompt: the last command of a pipe is refused as any other command is', () => {
  const k = boot({ ...SYS_PROGRAMS, ...FILE_PROGRAMS })
  k.write('/tmp/big', 'x'.repeat(ARGS_MAX - 30000))
  // The last command of a pipe runs in place of its task (exec); it gets no more room than one that is spawned.
  assert.deepEqual(k.sh('B=$(cat /tmp/big); /bin/true $B $B; echo "spawned $?"'), [
    '!ash: /bin/true: argument list too long',
    'spawned 126',
  ])
  assert.deepEqual(k.sh('echo | /bin/true $B $B; echo "in place $?"'), [
    '!ash: /bin/true: argument list too long',
    'in place 126',
  ])
})

test('exec runs the new program inside the old, so a chain of execs is refused at a depth (ENOMEM), never left to fault', () => {
  // `again left first` execs itself until `left` runs out; a refused exec is caught and said, with the depth it reached.
  const again: Program = function* (sys, argv) {
    const left = Number(argv[1])
    if (left === 0) return 7
    try {
      return yield* sys.exec(['again', String(left - 1), argv[2]])
    } catch (e) {
      if (!(e instanceof OsError)) throw e
      yield* sys.print(`${e.errno} ${e.message} after ${Number(argv[2]) - left}\n`)
      return 9
    }
  }
  const m = machine({ again, status })
  const short = m.start(['again', '20', '20'])
  assert.deepEqual(m.settle(), [])
  assert.equal(m.kernel.ended(short.pid), 7)
  // A chain past the cap is refused while the task is still the program that asked; it never reaches the host's limit.
  const long = m.start(['again', '3000', '3000'])
  const said = m.settle()
  assert.equal(said.length, 1)
  const depth = Number(/^ENOMEM too many programs run in place of one another after (\d+)$/.exec(said[0])?.[1])
  assert.ok(depth >= 32 && depth <= 256, said[0])
  assert.equal(m.kernel.ended(long.pid), 9)
  assert.doesNotMatch(m.kernel.dmesg().join('\n'), /faulted/)
  // Execs one after another (each returning before the next) never add up to the cap.
  const serial = m.start(['serial'], {
    program: function* (sys) {
      let sum = 0
      for (let i = 0; i < 300; i++) sum += yield* sys.exec(['status', '1'])
      return sum
    },
  })
  assert.deepEqual(m.settle(), [])
  assert.equal(m.kernel.ended(serial.pid), 300 & 255)
  // At the prompt: a chain of a thousand env is refused by the env that met the cap, and the shell goes on.
  const k = boot({ ...SYS_PROGRAMS, ...FILE_PROGRAMS })
  assert.deepEqual(k.sh(`echo x | ${'env '.repeat(20)}cat`), ['x'])
  assert.deepEqual(k.sh(`echo x | ${'env '.repeat(1000)}cat; echo "status $?"`), ['!env: env: too many programs run in place of one another', 'status 126'])
  assert.doesNotMatch(k.system.kernel.dmesg().join('\n'), /faulted/)
})

// Exit statuses and faults.

test('a task\'s status: its return value or Exit, cut to eight bits; a non-number is 0', () => {
  const m = machine()
  const deep = function* (n: number): Task<number> {
    if (n === 0) throw new Exit(300)
    return yield* deep(n - 1)
  }
  const bodies: [Program, number][] = [
    [function* () { return 259 }, 3],
    [function* () { return -1 }, 255],
    [function* () { return Number.NaN }, 0],
    [function* () { return Number.POSITIVE_INFINITY }, 0],
    [function* () { return 2.9 }, 2],
    [function* () { return yield* deep(50) }, 44],
    [function* (sys) { return sys.exit(256) }, 0],
  ]
  const pids = bodies.map(([body], i) => m.start([`t${i}`], { program: body }).pid)
  m.settle()
  assert.deepEqual(pids.map((pid) => m.kernel.ended(pid)), bodies.map(([, want]) => want))
})

test('a fault ends only the task that made it: 70, a line on its error output and one in the log; the host never sees it', () => {
  const m = machine()
  let others = 0
  m.start(['steady'], {
    program: function* (sys) {
      for (;;) {
        others++
        yield* sys.sleep(10)
      }
    },
  })
  const faults: Program[] = [
    function* () { throw new Error('boom') },
    function* () { throw 'a bare string' },
    function* () { throw Object.create(null) },
    function* () { throw { toString(): string { throw new Error('nor this') } } },
    function* (sys) {
      // A refusal is not a fault: status 1 and its words, and nothing in the log.
      yield* sys.read(9)
      return 0
    },
  ]
  const pids = faults.map((body, i) => m.start([`f${i}`], { program: body }).pid)
  const out = m.settle()
  assert.deepEqual(out.slice(0, 3), ['!f0: fault: boom', '!f1: fault: a bare string', '!f2: fault: an error that cannot be shown'])
  assert.deepEqual(out.slice(3), ['!f3: fault: an error that cannot be shown', '!f4: bad file descriptor'])
  assert.deepEqual(pids.map((pid) => m.kernel.ended(pid)), [70, 70, 70, 70, 1])
  const log = m.kernel.dmesg().join('\n')
  assert.match(log, new RegExp(`task ${pids[0]} \\(f0\\) faulted: boom`))
  assert.doesNotMatch(log, /f4/)
  // The kernel goes on.
  m.tick(10)
  m.settle()
  assert.ok(others >= 2)
})

test('a body that fails before it is a task faults on its own first turn; the task that started it goes on', () => {
  const m = machine()
  const early: Program = () => {
    throw new Error('no generator here')
  }
  const refusing: Program = () => {
    throw new OsError('ENOSYS')
  }
  const results: string[] = []
  m.start(['parent'], {
    program: function* (sys) {
      const a = yield* sys.spawn(['early'], { program: early })
      const b = yield* sys.spawn(['refusing'], { program: refusing })
      results.push(`${yield* sys.wait(a)} ${yield* sys.wait(b)}`)
      return 0
    },
  })
  assert.deepEqual(m.settle(), ['!early: fault: no generator here', '!refusing: not supported here'])
  assert.deepEqual(results, ['70 1'])
  // Even task 1: the host that boots it is never thrown at.
  const m2 = machine({}, early)
  assert.match(m2.kernel.dmesg().join('\n'), /task 1 \(init\) faulted: no generator here/)
})

test('a fault with no error output open still reaches the log; a complaint that cannot be written goes there too', () => {
  const m = machine()
  const p = m.start(['quiet'], { fds: [null, null, null], program: function* () { throw new Error('unheard') } })
  assert.deepEqual(m.settle(), [])
  assert.equal(m.kernel.ended(p.pid), 70)
  assert.match(m.kernel.dmesg().join('\n'), /\(quiet\) faulted: unheard/)
  // An error output that is a pipe nobody reads: the complaint goes to the log.
  m.start(['parent'], {
    program: function* (sys) {
      const [r, w] = sys.pipe()
      sys.close(r)
      const pid = yield* sys.spawn(['loud'], { fds: [null, null, w], program: function* (s2) { yield* s2.read(5); return 0 } })
      sys.close(w)
      return yield* sys.wait(pid)
    },
  })
  assert.deepEqual(m.settle(), [])
  assert.match(m.kernel.dmesg().join('\n'), /: loud: bad file descriptor/)
})

test('task 1 ending stops every other task with 137 and says so in the log; a second boot is refused while tasks live', () => {
  let finishInit = false
  const init: Program = function* (sys) {
    yield* sys.spawn(['child'], { program: nap })
    while (!finishInit) yield { why: 'gate', ready: () => finishInit }
    return 0
  }
  const m = machine({}, init)
  const child = m.kernel.ps().find((p) => p.name === 'child')
  assert.ok(child !== undefined)
  assert.equal(errnoOf(() => m.kernel.boot(nap, ['again'], new Map())), 'EBUSY')
  finishInit = true
  m.settle()
  assert.equal(m.kernel.ended(child.pid), 137)
  assert.match(m.kernel.dmesg().join('\n'), /task 1 ended/)
  assert.deepEqual(m.kernel.ps(), [])
})

test('dmesg keeps the newest lines only, each stamped with the time since boot', () => {
  const m = machine()
  m.tick(1500)
  for (let i = 1; i <= 250; i++) m.kernel.log(`line ${i}`)
  const log = m.kernel.dmesg()
  assert.equal(log.length, 200)
  assert.equal(log[0], '[     1.500] line 51')
  assert.equal(log[199], '[     1.500] line 250')
})

// The task table, waiting and collecting.

test('a task that spawns until the table is full is refused, keeps going, and has its places back once it collects', () => {
  const m = machine()
  const said: string[] = []
  let collect = false
  const pids: number[] = []
  const spawner = m.start(['spawner'], {
    program: function* (sys) {
      for (;;) {
        try {
          pids.push(yield* sys.spawn(['short'], { program: function* (s2) { yield* s2.sleep(5); return 6 } }))
        } catch (e) {
          if (!(e instanceof OsError)) throw e
          said.push(`${e.errno} ${e.message}`)
          break
        }
      }
      while (!collect) yield { why: 'gate', ready: () => collect }
      // Ended children hold their places until they are collected.
      said.push(String(yield* errnoIn(sys.spawn(['more'], { program: nap }))))
      let sum = 0
      for (const pid of pids) sum += yield* sys.wait(pid)
      said.push(String(sum / pids.length))
      said.push(String(yield* errnoIn(sys.spawn(['more'], { program: status }))))
      return 0
    },
  })
  m.settle()
  // Task 1 and the spawner hold two places.
  assert.equal(pids.length, PROCS_MAX - 2)
  assert.deepEqual(said, ['EAGAIN too many tasks'])
  assert.equal(errnoOf(() => m.start(['outsider'], { program: nap })), 'EAGAIN')
  m.tick(5)
  m.settle()
  assert.equal(m.kernel.ps().filter((p) => p.state === 'end').length, PROCS_MAX - 2)
  collect = true
  m.settle()
  assert.deepEqual(said, ['EAGAIN too many tasks', 'EAGAIN', '6', 'null'])
  assert.equal(m.kernel.ended(spawner.pid), 0)
  assert.deepEqual(m.kernel.ps().map((p) => p.pid), [1])
})

test('wait and poll are for a task\'s own children: another task\'s child, itself, task 1 or no task at all is ECHILD', () => {
  const m = machine()
  let child = 0
  let collected = false
  const seen: string[] = []
  m.start(['parent'], {
    program: function* (sys) {
      child = yield* sys.spawn(['child'], { program: function* () { return 7 } })
      // The stranger looks first, while the child has ended and is not yet collected.
      yield { why: 'gate', ready: () => seen.length >= 1 }
      seen.push(`parent ${yield* sys.wait(child)}`)
      // A status once collected is remembered for the parent: a late wait gets it again.
      seen.push(`again ${yield* sys.wait(child)} ${sys.poll(child)}`)
      collected = true
      yield NEVER
      return 0
    },
  })
  m.start(['stranger'], {
    program: function* (sys) {
      yield { why: 'gate', ready: () => child !== 0 && m.kernel.proc(child)?.state === 'ended' }
      seen.push(`before ${yield* errnoIn(sys.wait(child))} ${sys.poll(child)}`)
      yield { why: 'gate', ready: () => collected }
      seen.push(`after ${yield* errnoIn(sys.wait(child))} ${sys.poll(child)}`)
      seen.push(`self ${yield* errnoIn(sys.wait(sys.pid))} init ${yield* errnoIn(sys.wait(1))} none ${yield* errnoIn(sys.wait(9999))}`)
      return 0
    },
  })
  m.settle()
  assert.deepEqual(seen, ['before ECHILD null', 'parent 7', 'again 7 7', 'after ECHILD null', 'self ECHILD init ECHILD none ECHILD'])
})

test('poll: running, then the status (collecting it), and a zombie holds its place in ps until then', () => {
  const m = machine()
  let go = false
  const seen: (number | string | null)[] = []
  m.start(['parent'], {
    program: function* (sys) {
      const pid = yield* sys.spawn(['child'], {
        program: function* () {
          while (!go) yield { why: 'gate', ready: () => go }
          return 5
        },
      })
      seen.push(sys.poll(pid))
      yield { why: 'gate', ready: () => m.kernel.proc(pid)?.state === 'ended' }
      seen.push(m.kernel.ps().find((p) => p.pid === pid)?.state ?? 'gone')
      seen.push(sys.poll(pid))
      seen.push(m.kernel.ps().find((p) => p.pid === pid)?.state ?? 'gone')
      return 0
    },
  })
  m.settle()
  go = true
  m.settle()
  assert.deepEqual(seen, ['running', 'end', 5, 'gone'])
})

test('an ended task\'s children pass to task 1: one still running is collected when it ends, one already ended at once', () => {
  const m = machine()
  const kids: number[] = []
  let goKid = false
  const parent = m.start(['parent'], {
    program: function* (sys) {
      kids.push(yield* sys.spawn(['done'], { program: function* () { return 3 } }))
      kids.push(yield* sys.spawn(['late'], {
        program: function* () {
          while (!goKid) yield { why: 'gate', ready: () => goKid }
          return 4
        },
      }))
      yield { why: 'gate', ready: () => m.kernel.proc(kids[0])?.state === 'ended' }
      return 0
    },
  }).pid
  m.settle()
  assert.equal(m.kernel.ended(parent), 0)
  // The ended child went with its parent; the running one now belongs to task 1.
  assert.equal(m.kernel.proc(kids[0]), undefined)
  assert.equal(m.kernel.ended(kids[0]), 3)
  assert.equal(m.kernel.proc(kids[1])?.ppid, 1)
  goKid = true
  m.settle()
  assert.equal(m.kernel.proc(kids[1]), undefined)
  assert.equal(m.kernel.ended(kids[1]), 4)
})

test('the statuses remembered for a late wait are capped: the oldest go first', () => {
  const m = machine()
  const pids: number[] = []
  // The table holds PROCS_MAX tasks at once, so they are started a few at a time.
  for (let i = 0; i < 300; i++) {
    pids.push(m.start([`s${i}`], { program: status }).pid)
    if (i % 50 === 49) m.settle()
  }
  assert.equal(m.kernel.ended(pids[0]), undefined)
  assert.equal(m.kernel.ended(pids[299]), 0)
  assert.equal(m.kernel.ended(pids[300 - 256]), 0)
  assert.equal(m.kernel.ended(pids[300 - 257]), undefined)
})

test('stop: the task ends with the status asked for on its next turn, its cleanup runs; no task, task 1 or another user is refused', () => {
  const m = machine()
  const cleaned: string[] = []
  const p = m.start(['stoppable'], {
    program: function* () {
      try {
        yield NEVER
      } finally {
        cleaned.push('done')
      }
      return 0
    },
  })
  m.settle()
  assert.equal(errnoOf(() => m.kernel.stop(p.pid, 143, { uid: 5, gid: 5 })), 'EPERM')
  assert.equal(errnoOf(() => m.kernel.stop(1)), 'EPERM')
  assert.equal(errnoOf(() => m.kernel.stop(9999)), 'ESRCH')
  m.kernel.stop(p.pid, 99)
  m.settle()
  assert.deepEqual(cleaned, ['done'])
  assert.equal(m.kernel.ended(p.pid), 99)
  assert.equal(errnoOf(() => m.kernel.stop(p.pid)), 'ESRCH')
})

// Descriptors.

test('descriptors are handed down and closed when a task ends: a reader sees the end only once every writer is gone', () => {
  const m = machine()
  const seen: string[] = []
  let release = false
  m.start(['parent'], {
    program: function* (sys) {
      const [r, w] = sys.pipe()
      const writer = yield* sys.spawn(['writer'], {
        fds: [null, w, 2],
        program: function* (s2) {
          yield* s2.print('from the child\n')
          while (!release) yield { why: 'gate', ready: () => release }
          return 0
        },
      })
      seen.push(JSON.stringify(m.kernel.ps().find((p) => p.pid === writer)?.fds))
      sys.close(w)
      seen.push(decode(yield* sys.read(r)))
      // The child still holds its end: the read waits, it is not the end yet.
      seen.push(decode(yield* sys.read(r)) === '' ? 'end' : 'more')
      return yield* sys.wait(writer)
    },
  })
  m.settle()
  assert.equal(seen.length, 2)
  assert.match(seen[0], /^\[null,"pipe:\[\d+\]","tty"\]$/)
  assert.equal(seen[1], 'from the child\n')
  release = true
  m.settle()
  assert.deepEqual(seen.slice(2), ['end'])
  assert.deepEqual(m.kernel.ps().map((p) => p.pid), [1])
})

test('a parent with one of its first three closed hands it down closed by default; asked for by number, it is refused', () => {
  const m = machine({ args })
  const seen: string[] = []
  m.start(['parent'], {
    fds: [null, 1, 2],
    program: function* (sys) {
      const pid = yield* sys.spawn(['args', 'ran'])
      seen.push(JSON.stringify(m.kernel.ps().find((p) => p.pid === pid)?.fds))
      seen.push(`status ${yield* sys.wait(pid)}`)
      seen.push(String(yield* errnoIn(sys.spawn(['args'], { fds: [0, 1, 2] }))))
      return 0
    },
  })
  assert.deepEqual(m.settle(), ['args', 'ran'])
  assert.deepEqual(seen, ['[null,"tty","tty"]', 'status 0', 'EBADF'])
  // At the prompt: a program that starts another with its own descriptors, run with one of them closed.
  const k = boot({ ...SYS_PROGRAMS, ...FILE_PROGRAMS })
  k.write('/tmp/note', 'ran\n')
  assert.deepEqual(k.sh('timeout 5 cat /tmp/note <&-; echo "status $?"'), ['ran', 'status 0'])
  assert.deepEqual(k.sh('timeout 5 cat /tmp/note 2>&-; echo "status $?"'), ['ran', 'status 0'])
  // With its output closed the child still starts: the refused write is its own to report.
  assert.deepEqual(k.sh('timeout 5 cat /tmp/note >&-; echo "status $?"'), ['!cat: write error: bad file descriptor', 'status 1'])
})

test('dup, dup2 and close: the lowest free descriptor, high ones up to FDS_MAX, and refusals for the rest', () => {
  const m = machine()
  const seen: (string | number | boolean | null)[] = []
  const p = m.start(['fds'], {
    program: function* (sys) {
      seen.push(sys.dup(1))
      seen.push(sys.dup(1, 10))
      seen.push(sys.dup(1, 10))
      sys.dup2(0, FDS_MAX - 1)
      seen.push(sys.isOpen(FDS_MAX - 1), sys.isatty(FDS_MAX - 1))
      seen.push(errnoOf(() => sys.dup(1, FDS_MAX - 1)))
      seen.push(errnoOf(() => sys.dup2(1, FDS_MAX)))
      seen.push(errnoOf(() => sys.dup2(1, -1)))
      seen.push(errnoOf(() => sys.dup2(20, 21)))
      // A negative or broken lowest descriptor is no descriptor at all.
      seen.push(errnoOf(() => sys.dup(1, -1)))
      seen.push(errnoOf(() => sys.dup(1, 1.5)))
      sys.close(3)
      seen.push(errnoOf(() => sys.close(3)))
      seen.push(errnoOf(() => sys.close(-1)))
      seen.push(errnoOf(() => sys.close(1.5)))
      seen.push(errnoOf(() => sys.close(FDS_MAX + 5)))
      sys.dup2(1, 1)
      seen.push(sys.isOpen(1))
      return 0
    },
  })
  m.settle()
  assert.deepEqual(seen, [3, 10, 11, true, true, 'EMFILE', 'EBADF', 'EBADF', 'EBADF', 'EINVAL', 'EINVAL', 'EBADF', 'EBADF', 'EBADF', 'EBADF', true])
  assert.equal(m.kernel.ended(p.pid), 0)
})

test('a descriptor asked for below zero never leaks its file: the reader still sees the end when the writer ends', () => {
  const m = machine()
  let got: string | null = null
  m.start(['parent'], {
    program: function* (sys) {
      const [r, w] = sys.pipe()
      const pid = yield* sys.spawn(['writer'], {
        fds: [null, w, 2],
        program: function* (s2) {
          try { s2.dup(1, -3) } catch { /* refused: nothing was handed out */ }
          try { s2.dup(1, 0.5) } catch { /* the same */ }
          yield* s2.print('x')
          return 0
        },
      })
      sys.close(w)
      got = decode(yield* sys.readAll(r))
      return yield* sys.wait(pid)
    },
  })
  m.settle()
  assert.equal(got, 'x')
})

test('the descriptor table is capped at FDS_MAX: dup and pipe are refused past it, and a refused pipe leaks nothing', () => {
  const m = machine()
  const seen: (string | number)[] = []
  m.start(['fill'], {
    program: function* (sys) {
      for (;;) {
        try {
          sys.dup(0)
        } catch (e) {
          if (!(e instanceof OsError)) throw e
          seen.push(e.errno)
          break
        }
      }
      seen.push(open(m, sys.pid).length)
      sys.close(FDS_MAX - 1)
      // One place left: a pipe needs two, so it is refused, and the place is still free afterwards.
      seen.push(errnoOf(() => sys.pipe()) ?? 'made')
      seen.push(open(m, sys.pid).length)
      seen.push(sys.dup(0))
      return 0
    },
  })
  m.settle()
  assert.deepEqual(seen, ['EMFILE', FDS_MAX, 'EMFILE', FDS_MAX - 1, FDS_MAX - 1])
})

test('dup2 over an open pipe end closes it, so its reader sees the end', () => {
  const m = machine()
  let got = ''
  m.start(['parent'], {
    program: function* (sys) {
      const [r, w] = sys.pipe()
      yield* sys.write(w, encode('before '))
      // The write end is replaced by the terminal: the pipe has no writer left.
      sys.dup2(1, w)
      got = decode(yield* sys.readAll(r))
      return 0
    },
  })
  m.settle()
  assert.equal(got, 'before ')
})

// Pipes.

test('a pipe chain of 50 stages carries more than a pipe holds, in order, and leaves nothing open', () => {
  const m = machine({ cat })
  const line = 'abcdefghijklmnopqrstuvwxyz0123456789\n'
  const data = line.repeat(Math.ceil((PIPE_MAX * 3) / line.length))
  let got = ''
  let statuses = -1
  m.start(['chain'], {
    program: function* (sys) {
      const [head, feed] = sys.pipe()
      const pids: number[] = []
      pids.push(yield* sys.spawn(['feeder'], { fds: [null, feed, 2], program: function* (s2) { yield* s2.print(data); return 0 } }))
      sys.close(feed)
      let prev = head
      for (let i = 0; i < 50; i++) {
        const [r, w] = sys.pipe()
        pids.push(yield* sys.spawn(['cat'], { fds: [prev, w, 2] }))
        sys.close(prev)
        sys.close(w)
        prev = r
      }
      got = decode(yield* sys.readAll(prev))
      sys.close(prev)
      statuses = 0
      for (const pid of pids) statuses += yield* sys.wait(pid)
      return 0
    },
  })
  m.settle()
  assert.equal(got.length, data.length)
  assert.equal(got, data)
  assert.equal(statuses, 0)
  assert.deepEqual(m.kernel.ps().map((p) => p.pid), [1])
})

test('a writer held on a full pipe waits; when its reader is stopped it ends quietly with 141', () => {
  const m = machine()
  let reader = 0
  let writer = 0
  let wrote = 0
  const statuses: number[] = []
  m.start(['parent'], {
    program: function* (sys) {
      const [r, w] = sys.pipe()
      reader = yield* sys.spawn(['reader'], { fds: [r, null, 2], program: nap })
      writer = yield* sys.spawn(['writer'], {
        fds: [null, w, 2],
        program: function* (s2) {
          for (;;) {
            yield* s2.write(1, new Uint8Array(1000))
            wrote += 1000
          }
        },
      })
      sys.close(r)
      sys.close(w)
      statuses.push(yield* sys.wait(writer), yield* sys.wait(reader))
      return 0
    },
  })
  assert.deepEqual(m.settle(), [])
  // It filled the pipe and no more.
  assert.equal(wrote, Math.floor(PIPE_MAX / 1000) * 1000)
  assert.equal(m.kernel.ps().find((p) => p.pid === writer)?.why, 'pipe')
  m.kernel.stop(reader)
  assert.deepEqual(m.settle(), [])
  assert.deepEqual(statuses, [141, 143])
})

test('a write to a pipe nobody reads is refused with EPIPE; one that catches it goes on, and short writes are never split', () => {
  const m = machine()
  const seen: (string | number | null)[] = []
  m.start(['lonely'], {
    program: function* (sys) {
      const [r, w] = sys.pipe()
      // Two writes that fit whole go in whole, even when only part of the second would fit.
      yield* sys.write(w, new Uint8Array(PIPE_MAX - 100))
      const second = sys.write(w, new Uint8Array(200))
      const step = second.next()
      // A hundred bytes of room is not enough: it waits for room for all two hundred.
      seen.push(step.done === true ? 'split' : `${step.value.why} ${step.value.ready()}`)
      yield* sys.read(r, 100)
      seen.push(step.done === true ? 'split' : String(step.value.ready()))
      second.return(0)
      seen.push((yield* sys.read(r, PIPE_MAX)).length)
      sys.close(r)
      seen.push(yield* errnoIn(sys.write(w, encode('nobody'))))
      seen.push(yield* errnoIn(sys.read(w)))
      seen.push(yield* errnoIn(sys.seek(w, 0)))
      seen.push(yield* errnoIn(sys.ftruncate(w, 0)))
      seen.push(String(yield* sys.fstat(w)))
      return 0
    },
  })
  assert.deepEqual(m.settle(), [])
  assert.deepEqual(seen, ['pipe false', 'true', PIPE_MAX - 200, 'EPIPE', 'EBADF', 'ESPIPE', 'EINVAL', 'null'])
})

test('a pipe read for an odd length keeps its bytes and its count: no read of a fraction or a non-number loses data', () => {
  const m = machine()
  const seen: string[] = []
  m.start(['odd'], {
    program: function* (sys) {
      const [r, w] = sys.pipe()
      yield* sys.write(w, encode('abcdef'))
      seen.push(decode(yield* sys.read(r, Number.NaN)))
      seen.push(decode(yield* sys.read(r, 0.5)))
      seen.push(decode(yield* sys.read(r, 2.7)))
      seen.push(decode(yield* sys.read(r, -4)))
      sys.close(w)
      seen.push(decode(yield* sys.readAll(r)))
      return 0
    },
  })
  m.settle()
  assert.deepEqual(seen, ['', '', 'ab', '', 'cdef'])
})

// The terminal.

test('Ctrl+C ends the foreground group and only it: a background job and task 1 go on, typed lines are forgotten', () => {
  const m = machine()
  const job = m.start(['job'], { group: 'new', program: nap })
  const second = m.start(['job2'], { group: job.pid, program: nap })
  const background = m.start(['background'], { group: 'new', program: nap })
  m.settle()
  m.kernel.tty.foreground = job.pid
  m.kernel.tty.feed('typed ahead')
  assert.equal(m.kernel.interrupt(), true)
  assert.equal(m.kernel.tty.typed, false)
  m.settle()
  assert.equal(m.kernel.ended(job.pid), 130)
  assert.equal(m.kernel.ended(second.pid), 130)
  assert.equal(m.kernel.proc(background.pid)?.state, 'ready')
  assert.equal(m.kernel.proc(1)?.state, 'ready')
  // The group is gone, so the terminal falls back to the console's own group; a second Ctrl+C ends nothing.
  assert.equal(m.kernel.tty.foreground, m.kernel.home)
  assert.equal(m.kernel.interrupt(), false)
  m.settle()
  assert.equal(m.kernel.proc(background.pid)?.state, 'ready')
})

test('Ctrl+C tells only the console\'s group, once; a shell waiting at its prompt is handed an end of input', () => {
  const m = machine()
  const seen: string[] = []
  const shell = m.start(['sh'], {
    program: function* (sys) {
      seen.push(`read ${JSON.stringify(decode(yield* sys.read(0)))} told ${sys.interrupted()} again ${sys.interrupted()}`)
      return 0
    },
  })
  const other = m.start(['other'], { group: 'new', program: nap })
  m.settle()
  assert.ok(m.kernel.tty.readers.has(shell.pid))
  assert.equal(m.kernel.interrupt(), false)
  assert.equal(m.kernel.interruptPending(m.init), true)
  assert.equal(m.kernel.takeInterrupt(other), false)
  m.settle()
  assert.deepEqual(seen, ['read "" told true again false'])
  // The end of input went to the shell, not into the queue for whoever reads next.
  assert.equal(m.kernel.tty.typed, false)
  assert.equal(m.kernel.tty.readers.size, 0)
})

test('Ctrl+C while the foreground job reads the terminal: the job ends, its wait is cleaned up, and no stray end of input is left', () => {
  const m = machine()
  const job = m.start(['reader'], {
    group: 'new',
    program: function* (sys) {
      yield* sys.read(0)
      return 0
    },
  })
  m.kernel.tty.foreground = job.pid
  m.settle()
  assert.ok(m.kernel.tty.readers.has(job.pid))
  assert.equal(m.kernel.interrupt(), true)
  m.settle()
  assert.equal(m.kernel.ended(job.pid), 130)
  assert.equal(m.kernel.tty.readers.size, 0)
  assert.equal(m.kernel.tty.typed, false)
})

test('Ctrl+D on a partly read line: the rest of the line comes first, then one end of input, then reads wait again', () => {
  const m = machine()
  const got: string[] = []
  m.start(['reader'], {
    program: function* (sys) {
      for (;;) {
        const chunk = yield* sys.read(0, 3)
        got.push(decode(chunk))
      }
    },
  })
  m.settle()
  m.kernel.tty.feed('abcdefg')
  m.kernel.tty.end()
  m.settle()
  assert.deepEqual(got, ['abc', 'def', 'g\n', ''])
  // The end of input was taken once: the reader waits for more, it does not spin on it.
  assert.equal(m.kernel.idle(), true)
  assert.equal(m.kernel.ps().find((p) => p.name === 'reader')?.why, 'tty')
  m.kernel.tty.end()
  m.settle()
  assert.deepEqual(got.slice(4), [''])
})

test('only the foreground group reads the terminal: a background reader is told the input has ended and takes nothing', () => {
  const m = machine()
  const seen: string[] = []
  const reader = (name: string): Program => function* (sys) {
    seen.push(`${name} ${JSON.stringify(decode(yield* sys.read(0)))}`)
    return 0
  }
  m.start(['bg'], { group: 'new', program: reader('bg') })
  m.start(['fg'], { program: reader('fg') })
  m.settle()
  m.kernel.tty.feed('for the foreground')
  m.settle()
  assert.deepEqual(seen, ['bg ""', 'fg "for the foreground\\n"'])
  // A reader whose group loses the terminal while it waits is told the input has ended.
  const waiting = m.start(['waiting'], { program: reader('waiting') })
  m.settle()
  assert.ok(m.kernel.tty.readers.has(waiting.pid))
  m.kernel.tty.foreground = 999
  m.settle()
  assert.deepEqual(seen.slice(2), ['waiting ""'])
  assert.equal(m.kernel.tty.readers.size, 0)
})

test('a question printed without a line end shows before the read waits; the prompt is what the reader set', () => {
  const m = machine()
  let answer = ''
  m.start(['ask'], {
    program: function* (sys) {
      sys.prompt('> ', true)
      yield* sys.print('Name? ')
      answer = decode(yield* sys.read(0))
      sys.prompt('')
      return 0
    },
  })
  assert.deepEqual(m.settle(), ['Name? '])
  assert.equal(m.kernel.tty.prompt, '> ')
  assert.equal(m.kernel.tty.continuing, true)
  m.kernel.tty.feed('Ada')
  m.settle()
  assert.equal(answer, 'Ada\n')
  assert.equal(m.kernel.tty.prompt, '')
  assert.equal(m.kernel.tty.continuing, false)
})

test('at the prompt: Ctrl+C ends the job in the foreground, a job left in the background runs on', () => {
  const k = boot(SYS_PROGRAMS)
  assert.match(k.sh('sleep 100 &').join('\n'), /^\[1\] \d+$/)
  k.system.type('sleep 50')
  assert.deepEqual(k.settle(), [])
  assert.equal(k.system.capturing, false)
  assert.equal(k.system.interrupt(), true)
  k.settle()
  assert.deepEqual(k.sh('echo $?'), ['130'])
  assert.deepEqual(k.sh('jobs'), ['[1]  Running    sleep 100'])
  // At the prompt itself Ctrl+C ends nothing and the shell is still there.
  assert.equal(k.system.interrupt(), false)
  k.settle()
  assert.deepEqual(k.sh('echo still'), ['still'])
})

test('at the prompt: Ctrl+D on a half-typed command says what was missing; on a program\'s input it ends that input', () => {
  const k = boot({ ...SYS_PROGRAMS, ...FILE_PROGRAMS })
  assert.deepEqual(k.sh('for w in a b; do'), [])
  assert.equal(k.system.prompt, '> ')
  assert.equal(k.system.capturing, true)
  k.system.end()
  assert.deepEqual(k.settle(), ["!ash: syntax error: 'for' needs 'done'"])
  assert.equal(k.system.atPrompt, true)
  assert.deepEqual(k.sh('echo $?'), ['2'])
  assert.deepEqual(k.sh('cat > /tmp/typed'), [])
  assert.deepEqual(k.sh('a line'), [])
  k.system.end()
  assert.deepEqual(k.settle(), [])
  assert.equal(k.read('/tmp/typed'), 'a line\n')
  assert.deepEqual(k.sh('echo after'), ['after'])
})

test('at the prompt: a flood of typed lines past the cap is refused whole, and what fits is read in order', () => {
  const k = boot(SYS_PROGRAMS)
  const flood = Array.from({ length: INPUT_MAX + 1 }, (_, i) => `echo ${i}`).join('\n')
  assert.equal(k.system.type(flood), false)
  assert.deepEqual(k.settle(), [])
  const fits = Array.from({ length: 3 }, (_, i) => `echo ${i}`).join('\n')
  assert.deepEqual(k.sh(fits), ['0', '1', '2'])
})
