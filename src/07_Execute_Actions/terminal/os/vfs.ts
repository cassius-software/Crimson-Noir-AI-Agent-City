// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the console's one file system: a tree of names that starts at / and is made of
 * drivers mounted over directories (the disk at /, scratch space at /tmp, the system tree, the live readings under
 * /proc and /sys, the devices). Every path any program gives ends here. It walks the path one name at a time,
 * crossing into a mounted driver where one covers a directory, and it is the single place that checks what a driver
 * never does: the permission bits against who is asking, read-only mounts, mount points that may not be moved or
 * removed, and moves that would cross from one driver to another. There are no links, so `..` is settled from the
 * path's own text before the walk and no path can step outside the tree. A driver may answer later (a real folder);
 * every call here is a task that waits for it, so one code path serves memory and a real disk alike.
 * What breaks if it is removed? Drivers exist but nothing joins them into paths: no `ls`, no `cat`, no redirection.
 */
import { EMPTY, concat } from './bytes.ts'
import { OsError, refuse } from './errno.ts'
import type { Cred, Driver, Entry, Kind, Stat, Usage } from './fs.ts'
import { R, W, X, permits } from './fs.ts'
import { DEPTH_MAX, fromParts, parts } from './path.ts'
import { io } from './task.ts'
import type { Task } from './task.ts'

/** How a file is opened: a sum of these. */
export const O_READ = 1
export const O_WRITE = 2
/** Every write goes to the end. */
export const O_APPEND = 4
/** Make the file when the name is free. */
export const O_CREATE = 8
/** Cut the file to nothing on opening. */
export const O_TRUNC = 16
/** With O_CREATE: refuse when the name is taken. */
export const O_EXCL = 32

/** The sticky bit on a directory: a name in it is removed or moved only by its owner, the directory's owner, or user 0. */
export const STICKY = 0o1000

/** The most mounts at once. */
export const MOUNTS_MAX = 32

/**
 * Whether a path asks for a directory by its last name: one that ends in `/`, `/.` or `/..`. Such a path never
 * names a file, so `rm notes/` cannot remove the file `notes`, and `touch g/` cannot make one.
 */
function dirOnly(path: string): boolean {
  return path.length > 1 && (path.endsWith('/') || path.endsWith('/.') || path.endsWith('/..'))
}

/** The most bytes `readFile` reads: a larger file is refused rather than held whole. */
export const READ_FILE_MAX = 64 << 20

/** One driver mounted over one directory. */
export interface Mount {
  /** A small number that tells mounts apart (`stat` shows it as the device). */
  readonly id: number
  /** Where it shows in the tree. */
  readonly path: string
  readonly driver: Driver
  /** What `mount` and `df` show as its source: disk, tmpfs, proc ... */
  readonly source: string
  /** Descriptors open on it: it cannot be unmounted while any is. */
  opens: number
  /** The directory it covers; null for the root. */
  readonly on: { readonly mount: Mount; readonly ino: number } | null
}

/** A node: the mount it is on and its number there. */
export interface Loc { readonly mount: Mount; readonly ino: number }

/** What `stat` says, with the mount's id as the device. */
export interface FileStat extends Stat { readonly dev: number }

/** An open file: a position in one node, with the rights it was opened with. */
export class Handle {
  readonly mount: Mount
  readonly ino: number
  readonly kind: Kind
  readonly flags: number
  readonly cred: Cred
  offset = 0
  closed = false
  /** A generated file's whole text, read once on the first read. */
  private made: Uint8Array | null = null

  constructor(mount: Mount, ino: number, kind: Kind, flags: number, cred: Cred) {
    this.mount = mount
    this.ino = ino
    this.kind = kind
    this.flags = flags
    this.cred = cred
  }

  /** Up to `length` bytes from the position; none at the end. */
  *read(length: number): Task<Uint8Array> {
    if (this.closed || (this.flags & O_READ) === 0) refuse('EBADF')
    if (length <= 0) return EMPTY
    const d = this.mount.driver
    if (this.kind === 'stream') return yield* io(d.read(this.ino, 0, length))
    if (d.generated) {
      if (this.made === null) this.made = yield* io(d.read(this.ino, 0, Number.MAX_SAFE_INTEGER))
      const out = this.made.subarray(this.offset, this.offset + length)
      this.offset += out.length
      return out
    }
    const out = yield* io(d.read(this.ino, this.offset, length))
    this.offset += out.length
    return out
  }

  /** Writes all of `data` at the position (the end, when opened to append); the count written. */
  *write(data: Uint8Array): Task<number> {
    if (this.closed || (this.flags & O_WRITE) === 0) refuse('EBADF')
    const d = this.mount.driver
    if (this.kind === 'stream' || d.generated) return yield* io(d.write(this.ino, 0, data, this.cred))
    if ((this.flags & O_APPEND) !== 0) this.offset = (yield* io(d.stat(this.ino))).size
    const n = yield* io(d.write(this.ino, this.offset, data, this.cred))
    this.offset += n
    return n
  }

  /** Moves the position: from the start (0), from where it is (1) or from the end (2). The new position. */
  *seek(offset: number, whence: 0 | 1 | 2): Task<number> {
    if (this.closed) refuse('EBADF')
    if (this.kind === 'stream') refuse('ESPIPE')
    let base = 0
    if (whence === 1) base = this.offset
    else if (whence === 2) base = this.made !== null ? this.made.length : (yield* io(this.mount.driver.stat(this.ino))).size
    const to = base + offset
    if (!Number.isSafeInteger(to) || to < 0) refuse('EINVAL')
    this.offset = to
    return to
  }

  *stat(): Task<FileStat> {
    if (this.closed) refuse('EBADF')
    return { ...(yield* io(this.mount.driver.stat(this.ino))), dev: this.mount.id }
  }

  *truncate(size: number): Task<void> {
    if (this.closed || (this.flags & O_WRITE) === 0) refuse('EBADF')
    if (this.kind !== 'file') refuse('EINVAL')
    yield* io(this.mount.driver.truncate(this.ino, size))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.made = null
    this.mount.opens--
  }
}

export class Vfs {
  private readonly all: Mount[] = []
  /** Mount by the directory it covers: `<mount id>:<node number>`. */
  private readonly covering = new Map<string, Mount>()
  private nextId = 1
  private readonly rootMount: Mount

  constructor(root: Driver, source: string) {
    this.rootMount = { id: this.nextId++, path: '/', driver: root, source, opens: 0, on: null }
    this.all.push(this.rootMount)
  }

  /** Every mount, the root first, in the order they were made. */
  mounts(): readonly Mount[] { return this.all }

  usage(mount: Mount): Usage { return mount.driver.usage() }

  private cross(mount: Mount, ino: number): Loc {
    const over = this.covering.get(`${mount.id}:${ino}`)
    return over === undefined ? { mount, ino } : { mount: over, ino: over.driver.root }
  }

  /** Asks leave to search a directory, then finds `name` in it (not yet crossed into a mount that covers it). */
  private *step(dir: Loc, name: string, cred: Cred): Task<number> {
    const d = dir.mount.driver
    if (cred.uid !== 0) {
      const st = yield* io(d.stat(dir.ino))
      if (st.kind !== 'dir') refuse('ENOTDIR')
      if (!permits(st, cred, X)) refuse('EACCES')
    }
    return yield* io(d.lookup(dir.ino, name))
  }

  private *walk(names: readonly string[], cred: Cred): Task<Loc> {
    let at: Loc = { mount: this.rootMount, ino: this.rootMount.driver.root }
    for (const name of names) at = this.cross(at.mount, yield* this.step(at, name, cred))
    return at
  }

  /** The node a path names. A path that ends in `/` (or `/.`, `/..`) names a directory, or nothing. */
  *locate(path: string, cwd: string, cred: Cred): Task<Loc> {
    const loc = yield* this.walk(parts(path, cwd), cred)
    if (dirOnly(path) && (yield* io(loc.mount.driver.stat(loc.ino))).kind !== 'dir') refuse('ENOTDIR')
    return loc
  }

  /** The directory that holds a path's last name, and that name; the root has no such thing. */
  private *parent(path: string, cwd: string, cred: Cred): Task<{ dir: Loc; name: string; names: string[] }> {
    const names = parts(path, cwd)
    if (names.length === 0) refuse('EBUSY', 'the root directory')
    const dir = yield* this.walk(names.slice(0, -1), cred)
    return { dir, name: names[names.length - 1], names }
  }

  private *statAt(loc: Loc): Task<FileStat> {
    return { ...(yield* io(loc.mount.driver.stat(loc.ino))), dev: loc.mount.id }
  }

  *stat(path: string, cwd: string, cred: Cred): Task<FileStat> {
    return yield* this.statAt(yield* this.locate(path, cwd, cred))
  }

  /** Whether `cred` may do `want` (R, W, X or a sum; 0 asks only that the path exists) to what the path names. */
  *access(path: string, cwd: string, cred: Cred, want: number): Task<boolean> {
    try {
      const loc = yield* this.locate(path, cwd, cred)
      if (want === 0) return true
      const st = yield* this.statAt(loc)
      if ((want & W) !== 0 && loc.mount.driver.readOnly) return false
      return permits(st, cred, want)
    } catch (e) {
      if (e instanceof OsError) return false
      throw e
    }
  }

  /** The names in a directory, sorted by code unit. */
  *list(path: string, cwd: string, cred: Cred): Task<Entry[]> {
    const loc = yield* this.locate(path, cwd, cred)
    const st = yield* this.statAt(loc)
    if (st.kind !== 'dir') refuse('ENOTDIR')
    if (!permits(st, cred, R)) refuse('EACCES')
    const entries = yield* io(loc.mount.driver.list(loc.ino))
    return entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  /** Leave to add, remove or rename a name in a directory: it must take writes, and so must its mount. */
  private *changeable(dir: Loc, cred: Cred): Task<Stat> {
    const st = yield* io(dir.mount.driver.stat(dir.ino))
    if (st.kind !== 'dir') refuse('ENOTDIR')
    if (dir.mount.driver.readOnly) refuse('EROFS')
    if (!permits(st, cred, W | X)) refuse('EACCES')
    return st
  }

  /** In a sticky directory, only the owner of the name, the owner of the directory or user 0 takes a name away. */
  private *unstuck(dir: Loc, dirStat: Stat, ino: number, cred: Cred): Task<void> {
    if ((dirStat.mode & STICKY) === 0 || cred.uid === 0 || cred.uid === dirStat.uid) return
    const st = yield* io(dir.mount.driver.stat(ino))
    if (st.uid !== cred.uid) refuse('EPERM')
  }

  *open(path: string, cwd: string, cred: Cred, flags: number, mode = 0o644): Task<Handle> {
    const { dir, name } = yield* this.parentOrRoot(path, cwd, cred)
    const d = dir.mount.driver
    let ino: number
    let created = false
    try {
      ino = yield* this.step(dir, name, cred)
      if ((flags & O_CREATE) !== 0 && (flags & O_EXCL) !== 0) refuse('EEXIST')
    } catch (e) {
      if (!(e instanceof OsError) || e.errno !== 'ENOENT' || (flags & O_CREATE) === 0) throw e
      // `name/` asks for a directory, and open never makes one.
      if (dirOnly(path)) refuse('EISDIR')
      yield* this.changeable(dir, cred)
      ino = yield* io(d.create(dir.ino, name, 'file', mode & 0o777, cred))
      created = true
    }
    const loc = this.cross(dir.mount, ino)
    const st = yield* io(loc.mount.driver.stat(loc.ino))
    if (st.kind === 'dir') refuse('EISDIR')
    if (dirOnly(path)) refuse('ENOTDIR')
    const writes = (flags & O_WRITE) !== 0
    if (!created) {
      const want = ((flags & O_READ) !== 0 ? R : 0) | (writes ? W : 0)
      if (!permits(st, cred, want)) refuse('EACCES')
    }
    if (writes && loc.mount.driver.readOnly) refuse('EROFS')
    if (writes && (flags & O_TRUNC) !== 0 && !created) yield* io(loc.mount.driver.truncate(loc.ino, 0))
    loc.mount.opens++
    return new Handle(loc.mount, loc.ino, st.kind, flags, cred)
  }

  /** As `parent`, but a path that names the root is refused as a directory (it can be listed, not opened). */
  private *parentOrRoot(path: string, cwd: string, cred: Cred): Task<{ dir: Loc; name: string; names: string[] }> {
    if (parts(path, cwd).length === 0) refuse('EISDIR')
    return yield* this.parent(path, cwd, cred)
  }

  *mkdir(path: string, cwd: string, cred: Cred, mode = 0o755): Task<void> {
    const names = parts(path, cwd)
    if (names.length === 0) refuse('EEXIST')
    const dir = yield* this.walk(names.slice(0, -1), cred)
    const name = names[names.length - 1]
    let taken = true
    try {
      yield* this.step(dir, name, cred)
    } catch (e) {
      if (!(e instanceof OsError) || e.errno !== 'ENOENT') throw e
      taken = false
    }
    if (taken) refuse('EEXIST')
    yield* this.changeable(dir, cred)
    yield* io(dir.mount.driver.create(dir.ino, name, 'dir', mode & (0o777 | STICKY), cred))
  }

  /** Removes a file (or a device's name). A directory is refused: `rmdir` removes those. */
  *unlink(path: string, cwd: string, cred: Cred): Task<void> {
    yield* this.take(path, cwd, cred, false)
  }

  /** Removes an empty directory. */
  *rmdir(path: string, cwd: string, cred: Cred): Task<void> {
    yield* this.take(path, cwd, cred, true)
  }

  private *take(path: string, cwd: string, cred: Cred, wantDir: boolean): Task<void> {
    const { dir, name } = yield* this.parent(path, cwd, cred)
    const d = dir.mount.driver
    const ino = yield* this.step(dir, name, cred)
    if (this.covering.has(`${dir.mount.id}:${ino}`)) refuse('EBUSY', 'a mount point')
    const st = yield* io(d.stat(ino))
    if ((wantDir || dirOnly(path)) && st.kind !== 'dir') refuse('ENOTDIR')
    if (!wantDir && st.kind === 'dir') refuse('EISDIR')
    const dirStat = yield* this.changeable(dir, cred)
    yield* this.unstuck(dir, dirStat, ino, cred)
    yield* io(d.remove(dir.ino, name))
  }

  /**
   * Moves `from` to `to` within one mount, replacing a file (or an empty directory, for a directory) already there.
   * Across mounts it is EXDEV: the caller copies and removes.
   */
  *rename(from: string, to: string, cwd: string, cred: Cred): Task<void> {
    const a = yield* this.parent(from, cwd, cred)
    const b = yield* this.parent(to, cwd, cred)
    if (a.dir.mount !== b.dir.mount) refuse('EXDEV')
    const d = a.dir.mount.driver
    const ino = yield* this.step(a.dir, a.name, cred)
    if (this.covering.has(`${a.dir.mount.id}:${ino}`)) refuse('EBUSY', 'a mount point')
    if ((dirOnly(from) || dirOnly(to)) && (yield* io(d.stat(ino))).kind !== 'dir') refuse('ENOTDIR')
    // A directory cannot move under itself: with no links, the two paths' own names tell.
    if (b.names.length > a.names.length && a.names.every((n, i) => b.names[i] === n)) refuse('EINVAL', 'a directory cannot move into itself')
    const fromPath = fromParts(a.names)
    for (const m of this.all) if (m.path.startsWith(`${fromPath}/`)) refuse('EBUSY', 'a mount point is inside it')
    const fromStat = yield* this.changeable(a.dir, cred)
    yield* this.unstuck(a.dir, fromStat, ino, cred)
    const toStat = a.dir.ino === b.dir.ino ? fromStat : yield* this.changeable(b.dir, cred)
    let there = -1
    try {
      there = yield* this.step(b.dir, b.name, cred)
    } catch (e) {
      if (!(e instanceof OsError) || e.errno !== 'ENOENT') throw e
    }
    if (there >= 0) {
      if (this.covering.has(`${b.dir.mount.id}:${there}`)) refuse('EBUSY', 'a mount point')
      yield* this.unstuck(b.dir, toStat, there, cred)
    }
    // Moving a tree deeper must not leave a path past the depth limit: nothing could reach it, or remove it, after.
    if (b.names.length > a.names.length && (yield* this.deeper(d, ino, DEPTH_MAX - b.names.length))) {
      refuse('ENAMETOOLONG', `a path is at most ${DEPTH_MAX} names deep`)
    }
    yield* io(d.rename(a.dir.ino, a.name, b.dir.ino, b.name))
  }

  /** Whether the tree under node `ino` reaches more than `room` names below it. Stops looking past `room`. */
  private *deeper(d: Driver, ino: number, room: number): Task<boolean> {
    let level = [ino]
    for (let depth = 0; level.length > 0; depth++) {
      const next: number[] = []
      for (const n of level) {
        if ((yield* io(d.stat(n))).kind !== 'dir') continue
        for (const e of yield* io(d.list(n))) {
          if (depth + 1 > room) return true
          next.push(e.ino)
        }
      }
      level = next
    }
    return false
  }

  /** Changes the permission bits: the owner's right, and user 0's. */
  *chmod(path: string, cwd: string, cred: Cred, mode: number): Task<void> {
    const loc = yield* this.locate(path, cwd, cred)
    const st = yield* io(loc.mount.driver.stat(loc.ino))
    if (cred.uid !== 0 && cred.uid !== st.uid) refuse('EPERM')
    if (loc.mount.driver.readOnly) refuse('EROFS')
    yield* io(loc.mount.driver.setattr(loc.ino, { mode: mode & (0o777 | STICKY) }))
  }

  /** Changes the owner: user 0's right alone. */
  *chown(path: string, cwd: string, cred: Cred, uid: number, gid: number): Task<void> {
    const loc = yield* this.locate(path, cwd, cred)
    if (cred.uid !== 0) refuse('EPERM')
    if (loc.mount.driver.readOnly) refuse('EROFS')
    yield* io(loc.mount.driver.setattr(loc.ino, { uid, gid }))
  }

  /** Sets the time of last change: the right of whoever may write the node. */
  *utime(path: string, cwd: string, cred: Cred, mtime: number): Task<void> {
    const loc = yield* this.locate(path, cwd, cred)
    const st = yield* io(loc.mount.driver.stat(loc.ino))
    if (cred.uid !== st.uid && !permits(st, cred, W)) refuse('EACCES')
    if (loc.mount.driver.readOnly) refuse('EROFS')
    yield* io(loc.mount.driver.setattr(loc.ino, { mtime }))
  }

  /** Cuts or extends a file to `size` bytes. */
  *truncate(path: string, cwd: string, cred: Cred, size: number): Task<void> {
    const h = yield* this.open(path, cwd, cred, O_WRITE)
    try {
      yield* h.truncate(size)
    } finally {
      h.close()
    }
  }

  /** A whole file's bytes. */
  *readFile(path: string, cwd: string, cred: Cred): Task<Uint8Array> {
    const h = yield* this.open(path, cwd, cred, O_READ)
    try {
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const chunk = yield* h.read(65536)
        if (chunk.length === 0) break
        total += chunk.length
        if (total > READ_FILE_MAX) refuse('EFBIG')
        chunks.push(chunk)
      }
      return chunks.length === 1 ? chunks[0] : concat(chunks)
    } finally {
      h.close()
    }
  }

  /** Writes a whole file: made when absent, cut first unless `append`. */
  *writeFile(path: string, cwd: string, cred: Cred, data: Uint8Array, opts: { readonly append?: boolean; readonly mode?: number } = {}): Task<void> {
    const flags = O_WRITE | O_CREATE | (opts.append === true ? O_APPEND : O_TRUNC)
    const h = yield* this.open(path, cwd, cred, flags, opts.mode ?? 0o644)
    try {
      yield* h.write(data)
    } finally {
      h.close()
    }
  }

  /** Mounts a driver over a directory: user 0's right alone. */
  *mount(path: string, driver: Driver, source: string, cred: Cred): Task<Mount> {
    if (cred.uid !== 0) refuse('EPERM')
    const names = parts(path, cwd0)
    const loc = yield* this.walk(names, cred)
    const st = yield* io(loc.mount.driver.stat(loc.ino))
    if (st.kind !== 'dir') refuse('ENOTDIR')
    if (loc.ino === loc.mount.driver.root) refuse('EBUSY', 'something is mounted there already')
    if (this.all.length >= MOUNTS_MAX) refuse('ENOSPC', 'too many mounts')
    for (const m of this.all) if (m.driver === driver) refuse('EBUSY', 'that driver is mounted already')
    const mount: Mount = { id: this.nextId++, path: fromParts(names), driver, source, opens: 0, on: { mount: loc.mount, ino: loc.ino } }
    this.all.push(mount)
    this.covering.set(`${loc.mount.id}:${loc.ino}`, mount)
    return mount
  }

  /** Takes a mount away: user 0's right alone; refused while a file on it is open or another mount sits inside it. */
  umount(path: string, cred: Cred): Mount {
    if (cred.uid !== 0) refuse('EPERM')
    const where = fromParts(parts(path, cwd0))
    const mount = this.all.find((m) => m.path === where)
    if (mount === undefined || mount.on === null) refuse('EINVAL', where === '/' ? 'the root stays mounted' : 'not a mount point')
    if (mount.opens > 0) refuse('EBUSY', 'a file on it is open')
    for (const m of this.all) if (m.path.startsWith(`${where}/`)) refuse('EBUSY', 'a mount point is inside it')
    this.all.splice(this.all.indexOf(mount), 1)
    this.covering.delete(`${mount.on.mount.id}:${mount.on.ino}`)
    return mount
  }
}

/** Mount paths are given whole: the directory they are read against never matters. */
const cwd0 = '/'
