// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the contract between the console's file system and whatever holds the files: a
 * Driver. Memory, the read-only system tree, the live readings under /proc and /sys, the devices, and later a real
 * folder on the person's disk are all drivers, and the file system above them (vfs.ts) knows only this shape: nodes
 * named by a number, looked up one name at a time, with a kind, permission bits, an owner and a time. A driver may
 * answer at once or later (task.ts Io); it refuses with an OsError. The file system checks permissions, limits and
 * read-only mounts before it asks a driver for anything, so a driver states only what it holds.
 * What breaks if it is removed? Every kind of storage would be wired into the file system by hand, and a new one
 * (a mounted drive) could not be added without touching every call.
 */
import type { Io } from './task.ts'

/**
 * What a node is: a file of bytes, a directory of names, or a stream (a device such as /dev/zero: it has no length
 * and no position, every read asks it afresh).
 */
export type Kind = 'file' | 'dir' | 'stream'

/** Who is asking: user and group numbers. User 0 is the person at the console; agents get their own. */
export interface Cred { readonly uid: number; readonly gid: number }

/** The person at the console. */
export const ROOT_CRED: Cred = Object.freeze({ uid: 0, gid: 0 })

/** What `stat` says of a node. `mode` holds the nine permission bits (0o755); `mtime` is milliseconds on the kernel's clock. */
export interface Stat {
  readonly kind: Kind
  readonly ino: number
  readonly mode: number
  readonly uid: number
  readonly gid: number
  readonly size: number
  readonly mtime: number
  readonly nlink: number
}

/** One name in a directory. */
export interface Entry { readonly name: string; readonly kind: Kind; readonly ino: number }

/** How full a driver is: bytes it may hold, bytes held, nodes held. A capacity of 0 means it has no storage of its own. */
export interface Usage { readonly capacity: number; readonly used: number; readonly nodes: number }

/** The attributes `setattr` may change; an absent one is left alone. */
export interface Attr { readonly mode?: number; readonly uid?: number; readonly gid?: number; readonly mtime?: number }

/**
 * A file system as the layer above sees it. Node numbers are the driver's own; `root` is its top directory. Every
 * method may refuse with an OsError; none checks permissions (vfs.ts did), and none is called to change a driver
 * whose `readOnly` is true.
 */
export interface Driver {
  /** The name `mount` and `df` show: memfs, romfs, proc ... */
  readonly type: string
  readonly readOnly: boolean
  /**
   * Whether a file's bytes are made afresh on every read (a reading under /proc): the layer above then reads such a
   * file whole when it is first read through a descriptor, so one `cat` sees one consistent text.
   */
  readonly generated: boolean
  readonly root: number
  /** The node `name` names in directory `dir`; ENOENT when there is none, ENOTDIR when `dir` is no directory. */
  lookup(dir: number, name: string): Io<number>
  stat(ino: number): Io<Stat>
  /** The names in a directory, in the driver's own order (the layer above sorts). */
  list(dir: number): Io<Entry[]>
  /** Up to `length` bytes from `offset`; fewer (or none) at the end. A stream ignores the offset. */
  read(ino: number, offset: number, length: number): Io<Uint8Array>
  /**
   * Writes all of `data` at `offset`, growing the file; the count written. A stream ignores the offset. `cred` is
   * who writes: a stored file has no use for it (the layer above already checked), a knob under /sys judges by it.
   */
  write(ino: number, offset: number, data: Uint8Array, cred: Cred): Io<number>
  truncate(ino: number, size: number): Io<void>
  /** A new empty file or directory `name` in `dir`, owned by `cred`; EEXIST when the name is taken. */
  create(dir: number, name: string, kind: 'file' | 'dir', mode: number, cred: Cred): Io<number>
  /** Removes `name` from `dir`: a file, or a directory that is empty (ENOTEMPTY otherwise). */
  remove(dir: number, name: string): Io<void>
  /**
   * Moves `name` in `dir` to `toName` in `toDir` (both in this driver), replacing a file or an empty directory of
   * the same kind there; EINVAL when a directory would move into itself.
   */
  rename(dir: number, name: string, toDir: number, toName: string): Io<void>
  setattr(ino: number, attr: Attr): Io<void>
  usage(): Usage
}

/** The permission bits for reading, writing and searching or running. */
export const R = 4
export const W = 2
export const X = 1

/**
 * Whether `cred` may do `want` (R, W, X or a sum) to a node with these attributes. User 0 may read and write
 * anything and may search any directory, but runs a file only if some run bit is set; anyone else is judged by the
 * owner's, the group's or the others' three bits, whichever applies first.
 */
export function permits(st: Pick<Stat, 'mode' | 'uid' | 'gid' | 'kind'>, cred: Cred, want: number): boolean {
  if (cred.uid === 0) {
    if ((want & X) !== 0 && st.kind !== 'dir') return (st.mode & 0o111) !== 0
    return true
  }
  const bits = cred.uid === st.uid ? (st.mode >> 6) & 7 : cred.gid === st.gid ? (st.mode >> 3) & 7 : st.mode & 7
  return (bits & want) === want
}

/** The mode as `ls -l` writes it: `drwxr-xr-x`, `-rw-r--r--`, `crw-rw-rw-`. */
export function modeText(kind: Kind, mode: number): string {
  const lead = kind === 'dir' ? 'd' : kind === 'stream' ? 'c' : '-'
  let s = lead
  for (let shift = 6; shift >= 0; shift -= 3) {
    const b = (mode >> shift) & 7
    s += ((b & R) !== 0 ? 'r' : '-') + ((b & W) !== 0 ? 'w' : '-') + ((b & X) !== 0 ? 'x' : '-')
  }
  return s
}
