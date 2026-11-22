// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the file system that holds files in memory: the console's disk (whose image the
 * host saves), its scratch space under /tmp, and, once sealed, the read-only system tree. Nodes are numbered, a
 * directory is a map of names, a file is a byte array that grows by doubling. It is bounded by construction: a
 * capacity in bytes that counts every file's length and a fixed cost per node and name (so a million empty files
 * cannot hide from it), a largest file, and a most-nodes cap; past any of them the call is refused by name and
 * nothing is changed. Every change bumps a counter, which is how the host knows the disk needs saving.
 * What breaks if it is removed? The console has nowhere to keep a file.
 */
import { decode, encode } from './bytes.ts'
import { refuse } from './errno.ts'
import type { Attr, Cred, Driver, Entry, Stat, Usage } from './fs.ts'
import { validName } from './path.ts'

/** What a node costs against the capacity beyond its bytes and the length of its name. */
export const NODE_COST = 64

export interface MemFsOptions {
  /** The name `mount` shows. */
  readonly type?: string
  /** Bytes the driver may hold in all (file bytes, plus NODE_COST and the name's length for each node). */
  readonly capacity: number
  /** The longest file, in bytes. */
  readonly maxFile: number
  /** The most nodes. */
  readonly maxNodes: number
  /** The kernel's clock, in milliseconds: the time a change is stamped with. */
  readonly clock: () => number
}

interface Node {
  readonly ino: number
  readonly kind: 'file' | 'dir'
  mode: number
  uid: number
  gid: number
  mtime: number
  /** A file's bytes: the array may be longer than `size`. */
  data: Uint8Array
  size: number
  /** A directory's names. */
  readonly names: Map<string, number> | null
  /** How many of a directory's names are directories: its link count is two more, without counting on every stat. */
  dirs: number
  /** A directory's parent (the root is its own). */
  parent: number
}

const NO_BYTES = new Uint8Array(0)

/**
 * Whether a name can be kept: a valid name whose text survives being written as UTF-8, as the disk's image writes it.
 * Half a surrogate pair does not (it is written as U+FFFD), so two such names would come back as one and the whole
 * image would be refused.
 */
function keepable(name: string): boolean {
  return validName(name) && decode(encode(name)) === name
}

export class MemFs implements Driver {
  readonly type: string
  readonly generated = false
  readonly root = 1
  private sealed = false
  private readonly nodes = new Map<number, Node>()
  private nextIno = 2
  private used = 0
  private readonly opts: MemFsOptions
  /** Bumped by every change: a host that saves the disk compares it with the one it saved. */
  version = 0

  constructor(opts: MemFsOptions) {
    this.opts = opts
    this.type = opts.type ?? 'memfs'
    this.nodes.set(1, { ino: 1, kind: 'dir', mode: 0o755, uid: 0, gid: 0, mtime: opts.clock(), data: NO_BYTES, size: 0, names: new Map(), dirs: 0, parent: 1 })
    this.used = NODE_COST
  }

  get readOnly(): boolean { return this.sealed }

  /** Empties the driver: only its root is left. Node numbers handed out before mean nothing afterwards. */
  wipe(): void {
    const root = this.nodes.get(1)
    this.nodes.clear()
    if (root !== undefined && root.names !== null) {
      root.names.clear()
      root.dirs = 0
      this.nodes.set(1, root)
    }
    this.used = NODE_COST
    this.version++
  }

  /** Makes the driver read-only for good (the system tree, once it is filled). */
  seal(): void { this.sealed = true }

  private node(ino: number): Node {
    const n = this.nodes.get(ino)
    if (n === undefined) refuse('ENOENT', 'stale file handle')
    return n
  }

  private dir(ino: number): Node & { readonly names: Map<string, number> } {
    const n = this.node(ino)
    if (n.names === null) refuse('ENOTDIR')
    return n as Node & { readonly names: Map<string, number> }
  }

  private file(ino: number): Node {
    const n = this.node(ino)
    if (n.kind !== 'file') refuse('EISDIR')
    return n
  }

  private touch(n: Node): void {
    n.mtime = this.opts.clock()
    this.version++
  }

  lookup(dir: number, name: string): number {
    const ino = this.dir(dir).names.get(name)
    if (ino === undefined) refuse('ENOENT')
    return ino
  }

  stat(ino: number): Stat {
    const n = this.node(ino)
    const nlink = n.names === null ? 1 : 2 + n.dirs
    return { kind: n.kind, ino: n.ino, mode: n.mode, uid: n.uid, gid: n.gid, size: n.size, mtime: n.mtime, nlink }
  }

  list(dir: number): Entry[] {
    const out: Entry[] = []
    for (const [name, ino] of this.dir(dir).names) out.push({ name, kind: this.node(ino).kind, ino })
    return out
  }

  read(ino: number, offset: number, length: number): Uint8Array {
    const n = this.file(ino)
    if (offset < 0 || length < 0) refuse('EINVAL')
    if (offset >= n.size) return NO_BYTES
    return n.data.slice(offset, Math.min(n.size, offset + length))
  }

  /**
   * A file's bytes as they stand, without a copy: a view of the disk's own memory, only to be read at once (never kept,
   * never written through), since the next write may change it or leave it behind. The image of the disk is made from
   * these, so saving a full disk copies each byte once.
   */
  bytesOf(ino: number): Uint8Array {
    const n = this.file(ino)
    return n.data.subarray(0, n.size)
  }

  /** Makes room for a file of `size` bytes, charging the growth; refuses without changing anything. */
  private grow(n: Node, size: number): void {
    if (size <= n.size) return
    const delta = size - n.size
    // Space first: on a file system whose largest file is its whole size, a file too big for it is out of space.
    if (this.used + delta > this.opts.capacity) refuse('ENOSPC')
    if (size > this.opts.maxFile) refuse('EFBIG')
    if (size > n.data.length) {
      let room = Math.max(size, Math.min(n.data.length * 2, this.opts.maxFile), 64)
      let bigger: Uint8Array
      try {
        bigger = new Uint8Array(room)
      } catch {
        // The machine would not give the doubled array: ask for exactly what is needed, then give up by name.
        room = size
        try { bigger = new Uint8Array(room) } catch { refuse('ENOMEM') }
      }
      bigger.set(n.data.subarray(0, n.size))
      n.data = bigger
    }
    this.used += delta
  }

  write(ino: number, offset: number, data: Uint8Array, _cred?: Cred): number {
    const n = this.file(ino)
    if (offset < 0 || !Number.isSafeInteger(offset)) refuse('EINVAL')
    // A write of nothing changes nothing, even from past the end: not the length, not the time, not the counter.
    if (data.length === 0) return 0
    const end = offset + data.length
    const before = n.size
    this.grow(n, end)
    // A write past the end leaves zeros between: the array beyond `size` may hold bytes of a longer, truncated past.
    if (offset > before) n.data.fill(0, before, offset)
    n.data.set(data, offset)
    if (end > n.size) n.size = end
    this.touch(n)
    return data.length
  }

  truncate(ino: number, size: number): void {
    const n = this.file(ino)
    if (size < 0 || !Number.isSafeInteger(size)) refuse('EINVAL')
    if (size > n.size) {
      const before = n.size
      this.grow(n, size)
      n.data.fill(0, before, size)
    } else {
      this.used -= n.size - size
      // A file cut to less than a quarter of its array gives the array back.
      if (size * 4 < n.data.length) n.data = n.data.slice(0, size)
    }
    n.size = size
    this.touch(n)
  }

  create(dir: number, name: string, kind: 'file' | 'dir', mode: number, cred: Cred): number {
    const d = this.dir(dir)
    if (name.length > 255) refuse('ENAMETOOLONG')
    if (!keepable(name)) refuse('EINVAL', 'not a name a file can have')
    if (d.names.has(name)) refuse('EEXIST')
    if (this.nodes.size >= this.opts.maxNodes) refuse('ENOSPC', 'no room for another file')
    const cost = NODE_COST + name.length
    if (this.used + cost > this.opts.capacity) refuse('ENOSPC')
    const ino = this.nextIno++
    const names = kind === 'dir' ? new Map<string, number>() : null
    const mtime = this.opts.clock()
    this.nodes.set(ino, { ino, kind, mode: mode & 0o1777, uid: cred.uid, gid: cred.gid, mtime, data: NO_BYTES, size: 0, names, dirs: 0, parent: dir })
    d.names.set(name, ino)
    if (kind === 'dir') d.dirs++
    this.used += cost
    this.touch(d)
    return ino
  }

  /** Forgets a node that no name refers to any more, and gives back what it cost. */
  private drop(n: Node, name: string): void {
    this.nodes.delete(n.ino)
    this.used -= NODE_COST + name.length + n.size
  }

  remove(dir: number, name: string): void {
    const d = this.dir(dir)
    const ino = d.names.get(name)
    if (ino === undefined) refuse('ENOENT')
    const n = this.node(ino)
    if (n.names !== null && n.names.size > 0) refuse('ENOTEMPTY')
    d.names.delete(name)
    if (n.names !== null) d.dirs--
    this.drop(n, name)
    this.touch(d)
  }

  rename(dir: number, name: string, toDir: number, toName: string): void {
    const from = this.dir(dir)
    const to = this.dir(toDir)
    const ino = from.names.get(name)
    if (ino === undefined) refuse('ENOENT')
    if (toName.length > 255) refuse('ENAMETOOLONG')
    if (!keepable(toName)) refuse('EINVAL', 'not a name a file can have')
    const n = this.node(ino)
    if (n.kind === 'dir') {
      // A directory cannot move into itself or anything under it.
      for (let up = to.ino; ; up = this.node(up).parent) {
        if (up === ino) refuse('EINVAL', 'a directory cannot move into itself')
        if (up === this.root) break
      }
    }
    const there = to.names.get(toName)
    if (there === ino) return
    let freed = 0
    if (there !== undefined) {
      const old = this.node(there)
      if (n.kind === 'dir') {
        if (old.names === null) refuse('ENOTDIR')
        if (old.names.size > 0) refuse('ENOTEMPTY')
      } else if (old.kind === 'dir') refuse('EISDIR')
      freed = NODE_COST + toName.length + old.size
    }
    // The longer name is charged before anything moves, so a refusal changes nothing.
    const cost = toName.length - name.length
    if (this.used - freed + cost > this.opts.capacity) refuse('ENOSPC')
    if (there !== undefined) {
      const old = this.node(there)
      if (old.names !== null) to.dirs--
      this.drop(old, toName)
    }
    from.names.delete(name)
    to.names.set(toName, ino)
    if (n.kind === 'dir') {
      n.parent = to.ino
      from.dirs--
      to.dirs++
    }
    this.used += cost
    this.touch(from)
    if (to !== from) this.touch(to)
  }

  setattr(ino: number, attr: Attr): void {
    const n = this.node(ino)
    if (attr.mode !== undefined) n.mode = attr.mode & 0o1777
    if (attr.uid !== undefined) n.uid = attr.uid
    if (attr.gid !== undefined) n.gid = attr.gid
    if (attr.mtime !== undefined) n.mtime = attr.mtime
    this.version++
  }

  usage(): Usage {
    return { capacity: this.opts.capacity, used: this.used, nodes: this.nodes.size }
  }
}
