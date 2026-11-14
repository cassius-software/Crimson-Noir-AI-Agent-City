// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It puts the console's operating layer together: the disk at / (filled from the saved
 * image when the host has one), scratch space at /tmp, the programs under /bin and their manual under /usr (both
 * read-only), the devices, /proc and /sys, the kernel, and task 1, which lays the tree out and then keeps one shell
 * running at the terminal for as long as the console lives. It is also the whole of what the host needs to hold:
 * hand it typed lines, give it turns, collect what it printed, ask it for the disk's image when the disk changed.
 * What breaks if it is removed? The parts exist but nothing starts them: no tree, no shell at the prompt.
 */
import { encode } from './bytes.ts'
import { devices } from './devices.ts'
import { OsError, reasonOf } from './errno.ts'
import { ROOT_CRED } from './fs.ts'
import { dump, restore } from './image.ts'
import { Kernel } from './kernel.ts'
import type { Program } from './kernel.ts'
import { MemFs } from './memfs.ts'
import { procfs } from './procfs.ts'
import { shell } from './shell.ts'
import type { CityHost } from './shell.ts'
import { SynthFs, dir, text } from './synth.ts'
import type { SynthNode } from './synth.ts'
import { io, now } from './task.ts'
import type { Io } from './task.ts'
import type { TtyEvent } from './tty.ts'
import { Vfs } from './vfs.ts'

/** The person's own directory. */
export const HOME = '/home/operator'
/** Where the shell looks for programs. */
export const PATH = `${HOME}/bin:/bin:/usr/apps`
/** Bytes the disk holds unless the host says otherwise. */
export const DISK_BYTES = 8 << 20
/** Bytes /tmp holds unless the host says otherwise. */
export const TMP_BYTES = 4 << 20

export interface SystemOptions {
  readonly hostname: string
  /** What `uname` and /proc/version say. */
  readonly version: string
  /** Milliseconds that only go up. */
  readonly clock: () => number
  /** Milliseconds since 1970; the clock when absent. */
  readonly wall?: () => number
  /** The saved disk: its image, null when there is none, or a Later that brings either when the host has read it. */
  readonly image?: Io<Uint8Array | null>
  /** Fills an array with bytes nobody can foretell, for /dev/random. */
  readonly entropy?: (bytes: Uint8Array) => void
  /** How the shell runs the city's own commands. */
  readonly city?: CityHost
  /** The host's readings under /proc, beside the kernel's own. */
  readonly proc?: Readonly<Record<string, SynthNode>>
  /** The host's knobs under /sys. */
  readonly sys?: Readonly<Record<string, SynthNode>>
  /** The programs, by name: each gets a file in /bin. */
  readonly programs: Readonly<Record<string, Program>>
  /** The manual, by page name: each page becomes a file in /usr/share/man. */
  readonly manual?: Readonly<Record<string, string>>
  readonly diskBytes?: number
  readonly tmpBytes?: number
}

/** What became of the saved disk. */
export type DiskState =
  /** The host has not said yet whether there is one. */
  | 'waiting'
  /** There was none: the disk started empty. */
  | 'new'
  | 'restored'
  /** There was one and it failed its checks: the disk started empty and the image is kept in `refused` for the host to set aside. */
  | 'refused'

const README = `This is your home directory. What you keep here stays between visits.

  ls /bin          every program
  man ls           what one of them does
  cat /proc/city/stats
                   the city, read as files (ls /proc/city, ls /sys/city)
  echo 18:30 > /sys/city/time
                   and set as files
  stats | grep fps the city's own commands work in a pipeline

Scripts you put in ~/bin run by name.
`

export class System {
  readonly kernel: Kernel
  readonly disk: MemFs
  state: DiskState = 'waiting'
  /** A saved image that failed its checks, for the host to set aside; null otherwise. */
  refused: Uint8Array | null = null
  /** The number of the shell at the terminal, once task 1 has started it. */
  private session = 0
  /** The disk's change counter as of the last image handed to the host. */
  private saved = -1

  constructor(opts: SystemOptions) {
    const clock = opts.clock
    const wall = opts.wall ?? clock
    const disk = new MemFs({ type: 'diskfs', capacity: opts.diskBytes ?? DISK_BYTES, maxFile: opts.diskBytes ?? DISK_BYTES, maxNodes: 65536, clock: wall })
    this.disk = disk
    const vfs = new Vfs(disk, 'disk')

    // The programs: a file each, whose first line names the native body the kernel runs for it.
    const names = Object.keys(opts.programs).sort()
    const programs = new Map<string, Program>()
    for (const name of names) programs.set(name, opts.programs[name])
    const city = opts.city ?? null
    const sh = shell(city)
    programs.set('sh', sh)
    const bin = new MemFs({ type: 'romfs', capacity: 1 << 20, maxFile: 4096, maxNodes: 4096, clock: wall })
    for (const name of programs.keys()) {
      const ino = bin.create(bin.root, name, 'file', 0o755, ROOT_CRED)
      bin.write(ino, 0, encode(`#!native ${name}\n`))
    }
    bin.seal()
    const usr = new MemFs({ type: 'romfs', capacity: 4 << 20, maxFile: 1 << 20, maxNodes: 4096, clock: wall })
    const share = usr.create(usr.root, 'share', 'dir', 0o755, ROOT_CRED)
    const man = usr.create(share, 'man', 'dir', 0o755, ROOT_CRED)
    usr.create(usr.root, 'apps', 'dir', 0o755, ROOT_CRED)
    for (const [name, page] of Object.entries(opts.manual ?? {})) {
      const ino = usr.create(man, name, 'file', 0o644, ROOT_CRED)
      usr.write(ino, 0, encode(page.endsWith('\n') ? page : `${page}\n`))
    }
    usr.seal()
    const tmp = new MemFs({ type: 'tmpfs', capacity: opts.tmpBytes ?? TMP_BYTES, maxFile: opts.tmpBytes ?? TMP_BYTES, maxNodes: 16384, clock: wall })
    tmp.setattr(tmp.root, { mode: 0o1777 })

    const kernel = new Kernel({ vfs, clock, wall, programs, hostname: opts.hostname })
    this.kernel = kernel
    const dev = new SynthFs('devfs', devices(kernel, opts.entropy ?? null), wall)
    const proc = new SynthFs('proc', procfs(kernel, opts.version, opts.proc ?? {}), wall)
    const sysTree = new SynthFs('sysfs', dir({
      kernel: dir({ hostname: text(() => `${opts.hostname}\n`), version: text(() => `${opts.version}\n`) }),
      ...(opts.sys ?? {}),
    }), wall)

    const env = new Map<string, string>([
      ['HOME', HOME], ['USER', 'root'], ['LOGNAME', 'root'], ['SHELL', '/bin/sh'], ['PATH', PATH], ['TERM', 'console'], ['HOSTNAME', opts.hostname],
    ])
    const image: Io<Uint8Array | null> = opts.image ?? null
    // A generator cannot be an arrow, so init reaches this object by name.
    // oxlint-disable-next-line typescript/no-this-alias
    const system = this

    const init: Program = function* (sys) {
      let bytes: Uint8Array | null = null
      try {
        bytes = yield* io(image)
      } catch (e) {
        sys.log(`the saved disk could not be read: ${reasonOf(e)}`)
      }
      if (bytes === null) system.state = 'new'
      else {
        try {
          restore(bytes, disk)
          system.state = 'restored'
        } catch (e) {
          disk.wipe()
          system.state = 'refused'
          system.refused = bytes
          sys.log(`the saved disk was set aside: ${reasonOf(e)}`)
        }
      }
      const fresh = system.state !== 'restored'
      for (const path of ['/bin', '/dev', '/etc', '/home', HOME, '/mnt', '/proc', '/sys', '/tmp', '/usr']) {
        try {
          yield* sys.mkdir(path, 0o755)
        } catch (e) {
          if (!(e instanceof OsError) || e.errno !== 'EEXIST') throw e
        }
      }
      if (fresh) {
        yield* sys.writeFile('/etc/hostname', encode(`${opts.hostname}\n`))
        yield* sys.writeFile('/etc/passwd', encode(`root:x:0:0:operator:${HOME}:/bin/sh\n`))
        yield* sys.writeFile(`${HOME}/README`, encode(README))
      }
      yield* sys.mount('/bin', bin, 'rom')
      yield* sys.mount('/usr', usr, 'rom')
      yield* sys.mount('/tmp', tmp, 'tmpfs')
      yield* sys.mount('/dev', dev, 'devfs')
      yield* sys.mount('/proc', proc, 'proc')
      yield* sys.mount('/sys', sysTree, 'sysfs')
      // A disk that came back as it was saved needs no saving again; a new one does.
      if (!fresh) system.saved = disk.version
      for (;;) {
        system.session = yield* sys.spawn(['-sh'], { program: sh, env, cwd: HOME, group: 'new' })
        const status = yield* sys.wait(system.session)
        sys.log(`the console's shell ended with status ${status}: starting another`)
        yield* sys.sleep(250)
      }
    }
    kernel.boot(init, ['init'], new Map())
  }

  /** Hands the terminal what the person typed (one line or several). False when too much is waiting unread. */
  type(text: string): boolean { return this.kernel.tty.feed(text) }

  /** Ctrl+D on an empty line: an end of input for whoever reads. */
  end(): void { this.kernel.tty.end() }

  /** Ctrl+C. True when a job was ended. */
  interrupt(): boolean { return this.kernel.interrupt() }

  /** Gives the tasks a turn (at most `steps` calls, and not past `deadline` on the clock) and collects what they printed. */
  run(steps: number, deadline: number): TtyEvent[] {
    this.kernel.run(steps, deadline)
    return this.kernel.tty.drain()
  }

  /** Whether nothing would move if `run` were called now. */
  get idle(): boolean { return this.kernel.idle() }

  /** The earliest clock time a waiting task named; null when none waits on the clock. */
  get nextWake(): number | null { return this.kernel.nextWake() }

  private get shellReads(): boolean { return this.session !== 0 && this.kernel.tty.readers.has(this.session) }

  /** Whether the shell waits at its prompt for a new command. */
  get atPrompt(): boolean { return this.shellReads && !this.kernel.tty.continuing && this.kernel.tty.readers.size === 1 }

  /**
   * Whether the next typed line belongs to something already going on: a job that reads the terminal, or a command
   * the shell is reading the rest of. Such a line is input, whatever it says.
   */
  get capturing(): boolean {
    const tty = this.kernel.tty
    if (tty.readers.size === 0) return false
    return !this.shellReads || tty.continuing || tty.readers.size > 1
  }

  /** What the console shows before the next typed line: the shell's prompt, a continuation mark, or nothing while a job runs. */
  get prompt(): string { return this.kernel.tty.readers.size > 0 ? this.kernel.tty.prompt : '' }

  /** The directory of the shell at the terminal (the home directory until it has started). */
  get cwd(): string { return this.kernel.proc(this.session)?.cwd ?? HOME }

  /** The names that run from the prompt: every file along the shell's path that may be run, sorted, each once. For Tab. */
  commands(): string[] {
    const vfs = this.kernel.vfs
    const path = this.kernel.proc(this.session)?.env.get('PATH') ?? PATH
    const found = new Set<string>()
    for (const d of path.split(':')) {
      try {
        const at = d === '' ? '.' : d
        for (const e of now(vfs.list(at, this.cwd, ROOT_CRED))) {
          if (e.kind === 'file' && now(vfs.access(`${at}/${e.name}`, this.cwd, ROOT_CRED, 1))) found.add(e.name)
        }
      } catch {
        // A directory on the path that is not there (or would wait) offers nothing.
      }
    }
    return [...found].sort()
  }

  /**
   * The paths that complete `word` as typed at the prompt (`~` is the home directory), sorted: a directory ends in
   * `/`. Names that start with a dot are offered only to a word whose last part starts with one. For Tab.
   */
  complete(word: string): string[] {
    const cut = word.lastIndexOf('/') + 1
    const typed = word.slice(0, cut)
    const stem = word.slice(cut)
    const where = typed === '' ? '.' : typed === '~/' || typed.startsWith('~/') ? `${HOME}/${typed.slice(2)}` : typed
    const out: string[] = []
    try {
      for (const e of now(this.kernel.vfs.list(where, this.cwd, ROOT_CRED))) {
        if (!e.name.startsWith(stem) || (e.name.startsWith('.') && !stem.startsWith('.'))) continue
        out.push(`${typed}${e.name}${e.kind === 'dir' ? '/' : ''}`)
      }
    } catch {
      // Nothing there to complete from.
    }
    return out.sort()
  }

  /** The disk's image if the disk changed since the last one handed out (and the saved one has been dealt with); null otherwise. */
  snapshot(): Uint8Array | null {
    if (this.state === 'waiting' || this.disk.version === this.saved) return null
    this.saved = this.disk.version
    return dump(this.disk)
  }

  /** Whether the disk has changes no image has been made of. */
  get dirty(): boolean { return this.state !== 'waiting' && this.disk.version !== this.saved }
}
