// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It turns the console's disk into one array of bytes and back, so the host can keep it
 * between visits. The image is a short header, then every node in an order where a directory comes before what it
 * holds (kind, permission bits, owner, time, the index of its directory, its name, its bytes), then the SHA-256 of
 * all that. Reading an image trusts nothing in it: the seal is checked first, every length is checked against what
 * is left, and the nodes are put back through the disk's own calls, so a name a file cannot have, a file inside a
 * file, or more bytes than the disk may hold is refused exactly as it would be from a program. An image that fails
 * any check is refused whole, and the disk is left empty rather than half filled. The body can be made apart from its
 * seal, so a host whose own digest runs off the page's thread seals a large disk without holding the page up.
 * What breaks if it is removed? Files last only until the page is closed.
 */
import { concat, decode, encode, readU32, writeU32 } from './bytes.ts'
import { OsError, refuse } from './errno.ts'
import { ROOT_CRED } from './fs.ts'
import type { MemFs } from './memfs.ts'
import { sha256 } from './sha.ts'

/** The first bytes of every image: the format's name and version. */
const MAGIC = encode('CNDISK1\n')
/** Bytes of the seal at the end of every image: the SHA-256 of everything before it. */
export const SEAL_BYTES = 32

/** The disk as one array of bytes, without its seal: what `sealed` makes an image of. Changes nothing on the disk. */
export function dumpBody(fs: MemFs): Uint8Array {
  const chunks: Uint8Array[] = [MAGIC]
  const count = new Uint8Array(4)
  chunks.push(count)
  let nodes = 0
  // Depth first, each directory's entries in the order of their names. What is still to visit is kept on a list of
  // its own, not on the call stack, so no tree is too deep to save (renames can build one deeper than any path).
  const pending: { ino: number; parent: number; name: string }[] = [{ ino: fs.root, parent: 0, name: '' }]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const st = fs.stat(next.ino)
    const index = nodes++
    const nameBytes = encode(next.name)
    const head = new Uint8Array(1 + 2 + 4 + 4 + 8 + 4 + 2)
    head[0] = st.kind === 'dir' ? 1 : 2
    head[1] = st.mode & 255
    head[2] = (st.mode >> 8) & 255
    writeU32(head, 3, st.uid)
    writeU32(head, 7, st.gid)
    new DataView(head.buffer).setFloat64(11, st.mtime, true)
    writeU32(head, 19, next.parent)
    head[23] = nameBytes.length & 255
    head[24] = (nameBytes.length >> 8) & 255
    chunks.push(head, nameBytes)
    if (st.kind === 'dir') {
      // Last name first onto the list, so the first name comes off it first.
      const entries = fs.list(next.ino).sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
      for (const e of entries) pending.push({ ino: e.ino, parent: index, name: e.name })
    } else {
      const size = new Uint8Array(4)
      writeU32(size, 0, st.size)
      chunks.push(size, fs.read(next.ino, 0, st.size))
    }
  }
  writeU32(count, 0, nodes)
  return concat(chunks)
}

/**
 * An image: a body from `dumpBody` with its seal, the SHA-256 of the body, after it. A seal of any other length is
 * refused (a RangeError), since no image could be checked with it; a wrong digest of the right length makes an image
 * that `restore` refuses.
 */
export function sealed(body: Uint8Array, seal: Uint8Array): Uint8Array {
  if (seal.length !== SEAL_BYTES) throw new RangeError(`a seal is ${SEAL_BYTES} bytes, not ${seal.length}`)
  return concat([body, seal])
}

/** The disk as one array of bytes, sealed. */
export function dump(fs: MemFs): Uint8Array {
  const body = dumpBody(fs)
  return sealed(body, sha256(body))
}

/**
 * Fills an empty disk from an image. Refuses, as EINVAL, an image that is not one, that fails its seal, or that
 * holds anything the disk would not take; a refused image leaves nothing behind: the disk is empty again, and its
 * root keeps the permission bits, owner and time it had.
 */
export function restore(image: Uint8Array, fs: MemFs): void {
  const bad = (why: string): never => refuse('EINVAL', `not a disk image (${why})`)
  if (image.length < MAGIC.length + 4 + SEAL_BYTES) bad('too short')
  for (let i = 0; i < MAGIC.length; i++) if (image[i] !== MAGIC[i]) bad('wrong header')
  const end = image.length - SEAL_BYTES
  const seal = sha256(image.subarray(0, end))
  for (let i = 0; i < SEAL_BYTES; i++) if (image[end + i] !== seal[i]) bad('the seal does not match')
  if (fs.list(fs.root).length > 0) refuse('EINVAL', 'the disk is not empty')
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength)
  let at = MAGIC.length
  const count = readU32(image, at)
  at += 4
  if (count === 0) bad('no root')
  /** The root's time before anything was put in it: a refused image gives it back. */
  const rootTime = fs.stat(fs.root).mtime
  /** Node number on the disk for each index in the image; -1 for a file (nothing can be inside it). */
  const dirs: number[] = []
  const attrs: { ino: number; mode: number; uid: number; gid: number; mtime: number }[] = []
  try {
    for (let index = 0; index < count; index++) {
      if (at + 25 > end) bad('cut short')
      const kind = image[at]
      const mode = image[at + 1] | (image[at + 2] << 8)
      const uid = readU32(image, at + 3)
      const gid = readU32(image, at + 7)
      const mtime = view.getFloat64(at + 11, true)
      const parent = readU32(image, at + 19)
      const nameLength = image[at + 23] | (image[at + 24] << 8)
      at += 25
      if (at + nameLength > end) bad('cut short')
      const name = decode(image.subarray(at, at + nameLength))
      at += nameLength
      if (kind !== 1 && kind !== 2) bad('an unknown kind of node')
      if (!Number.isFinite(mtime)) bad('a time that is no number')
      let ino: number
      if (index === 0) {
        if (kind !== 1 || name !== '') bad('the first node is not the root')
        ino = fs.root
      } else {
        if (parent >= index || dirs[parent] < 0) bad('a node outside any directory')
        ino = fs.create(dirs[parent], name, kind === 1 ? 'dir' : 'file', mode, ROOT_CRED)
      }
      if (kind === 2) {
        if (at + 4 > end) bad('cut short')
        const size = readU32(image, at)
        at += 4
        if (at + size > end) bad('cut short')
        if (size > 0) fs.write(ino, 0, image.subarray(at, at + size))
        at += size
      }
      attrs.push({ ino, mode, uid, gid, mtime })
      dirs.push(kind === 1 ? ino : -1)
    }
    if (at !== end) bad('bytes left over')
    // Last, once nothing more can be refused, so a directory keeps the time the image gave it and not the time its
    // files were put back, and a refused image never changes the root.
    for (const a of attrs) fs.setattr(a.ino, { mode: a.mode, uid: a.uid, gid: a.gid, mtime: a.mtime })
  } catch (e) {
    fs.wipe()
    fs.setattr(fs.root, { mtime: rootTime })
    if (e instanceof OsError && e.errno !== 'EINVAL') bad(e.message)
    throw e
  }
}
