// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the driver for files nobody stored: the readings under /proc, the knobs under
 * /sys and the devices under /dev. The host describes a tree of nodes (a directory that can say its names and find
 * a child, a file whose text is made when it is read and which may take a written value, a stream that is asked for
 * bytes), and this driver gives the tree to the file system in the shape every driver has. A node number here stands
 * for a path; the node behind it is found afresh on every call, so a directory may change between two looks (a task
 * that ended is gone from /proc) and a stale number simply finds nothing.
 * What breaks if it is removed? /proc, /sys and /dev have no files, and the city's live state cannot be read or set
 * as files.
 */
import { EMPTY, decode, encode } from './bytes.ts'
import { refuse } from './errno.ts'
import type { Attr, Cred, Driver, Entry, Kind, Stat, Usage } from './fs.ts'
import { Later } from './task.ts'
import type { Io } from './task.ts'

/** A directory: it names its children and finds one. The two must agree. */
export interface SynthDir {
  readonly kind: 'dir'
  /** Permission bits; 0o555 when absent. */
  readonly mode?: number
  names(): readonly string[]
  child(name: string): SynthNode | null
}

/** A file whose bytes are made when it is read; `write`, when present, takes a whole written value at once. */
export interface SynthFile {
  readonly kind: 'file'
  /** Permission bits; 0o444 when absent, 0o644 when absent and the file takes writes. */
  readonly mode?: number
  read(): Io<Uint8Array | string>
  write?(data: Uint8Array, cred: Cred): Io<void>
}

/** A device: it has no length and no position. `read` hands back at most `length` bytes, none at the end. */
export interface SynthStream {
  readonly kind: 'stream'
  /** Permission bits; 0o666 when absent. */
  readonly mode?: number
  read(length: number): Io<Uint8Array>
  write(data: Uint8Array): Io<number>
}

export type SynthNode = SynthDir | SynthFile | SynthStream

/** A directory with a fixed set of children. */
export function dir(children: Readonly<Record<string, SynthNode>>, mode?: number): SynthDir {
  const names = Object.freeze(Object.keys(children))
  return { kind: 'dir', mode, names: () => names, child: (name) => (Object.hasOwn(children, name) ? children[name]! : null) }
}

/** A read-only file with the text `read` gives when asked. */
export function text(read: () => string, mode?: number): SynthFile {
  return { kind: 'file', mode, read }
}

/** A file that reads as `read` gives and takes a written value: the text written, with the line end trimmed off. */
export function knob(read: () => string, write: (value: string, cred: Cred) => void, mode?: number): SynthFile {
  return {
    kind: 'file',
    mode,
    read,
    write(data, cred) {
      write(decode(data).trim(), cred)
    },
  }
}

/** The most paths the driver remembers numbers for before it forgets those that no longer lead anywhere. */
const PATHS_MAX = 8192

/** The longest generated file, in bytes: a reading longer than this is cut. */
export const GENERATED_MAX = 1 << 20

export class SynthFs implements Driver {
  readonly type: string
  readonly readOnly = false
  readonly generated = true
  readonly root = 1
  private readonly top: SynthDir
  private readonly clock: () => number
  /** Node number to the names that lead to it from the top, and back. */
  private readonly paths = new Map<number, readonly string[]>()
  private readonly numbers = new Map<string, number>()
  private nextIno = 2

  constructor(type: string, top: SynthDir, clock: () => number) {
    this.type = type
    this.top = top
    this.clock = clock
    this.paths.set(1, [])
    this.numbers.set('', 1)
  }

  /** The node a number stands for now; ENOENT when its path leads nowhere any more. */
  private find(ino: number): SynthNode {
    const names = this.paths.get(ino)
    if (names === undefined) refuse('ENOENT', 'stale file handle')
    let at: SynthNode = this.top
    for (const name of names) {
      if (at.kind !== 'dir') refuse('ENOENT', 'stale file handle')
      const next: SynthNode | null = at.child(name)
      if (next === null) refuse('ENOENT', 'stale file handle')
      at = next
    }
    return at
  }

  private number(names: readonly string[]): number {
    const key = names.join('/')
    const known = this.numbers.get(key)
    if (known !== undefined) return known
    if (this.paths.size >= PATHS_MAX) this.sweep()
    const ino = this.nextIno++
    this.paths.set(ino, names)
    this.numbers.set(key, ino)
    return ino
  }

  /** Forgets every number whose path no longer leads to a node. */
  private sweep(): void {
    for (const [ino, names] of this.paths) {
      if (ino === 1) continue
      let alive = true
      try { this.find(ino) } catch { alive = false }
      if (!alive) {
        this.paths.delete(ino)
        this.numbers.delete(names.join('/'))
      }
    }
    if (this.paths.size >= PATHS_MAX) refuse('ENOMEM', 'too many names in a generated tree')
  }

  lookup(dirIno: number, name: string): number {
    const d = this.find(dirIno)
    if (d.kind !== 'dir') refuse('ENOTDIR')
    if (d.child(name) === null) refuse('ENOENT')
    return this.number([...this.paths.get(dirIno)!, name])
  }

  stat(ino: number): Stat {
    const n = this.find(ino)
    const kind: Kind = n.kind
    const mode = n.mode ?? (n.kind === 'dir' ? 0o555 : n.kind === 'stream' ? 0o666 : n.write === undefined ? 0o444 : 0o644)
    return { kind, ino, mode, uid: 0, gid: 0, size: 0, mtime: this.clock(), nlink: n.kind === 'dir' ? 2 : 1 }
  }

  list(dirIno: number): Entry[] {
    const d = this.find(dirIno)
    if (d.kind !== 'dir') refuse('ENOTDIR')
    const base = this.paths.get(dirIno)!
    const out: Entry[] = []
    for (const name of d.names()) {
      const child = d.child(name)
      if (child !== null) out.push({ name, kind: child.kind, ino: this.number([...base, name]) })
    }
    return out
  }

  read(ino: number, offset: number, length: number): Io<Uint8Array> {
    const n = this.find(ino)
    if (n.kind === 'dir') refuse('EISDIR')
    if (n.kind === 'stream') return n.read(length)
    const cut = (made: Uint8Array | string): Uint8Array => {
      let bytes = typeof made === 'string' ? encode(made) : made
      if (bytes.length > GENERATED_MAX) bytes = bytes.subarray(0, GENERATED_MAX)
      if (offset >= bytes.length) return EMPTY
      return bytes.slice(offset, Math.min(bytes.length, offset + length))
    }
    const made = n.read()
    if (!(made instanceof Later)) return cut(made)
    return made.map(cut)
  }

  write(ino: number, _offset: number, data: Uint8Array, cred: Cred): Io<number> {
    const n = this.find(ino)
    if (n.kind === 'dir') refuse('EISDIR')
    if (n.kind === 'stream') return n.write(data)
    if (n.write === undefined) refuse('EACCES', 'this reading cannot be set')
    const done = n.write(data, cred)
    if (!(done instanceof Later)) return data.length
    return done.map(() => data.length)
  }

  truncate(ino: number): void {
    // Opening a knob to write it truncates it first: there is nothing to cut.
    const n = this.find(ino)
    if (n.kind === 'dir') refuse('EISDIR')
  }

  create(): number { return refuse('EPERM', 'nothing can be made in a generated tree') }
  remove(): void { refuse('EPERM', 'nothing can be removed from a generated tree') }
  rename(): void { refuse('EPERM', 'nothing can be renamed in a generated tree') }
  setattr(_ino: number, _attr: Attr): void { refuse('EPERM', 'a generated file keeps its attributes') }
  usage(): Usage { return { capacity: 0, used: 0, nodes: this.paths.size } }
}
