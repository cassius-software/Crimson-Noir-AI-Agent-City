// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It turns the console's disk into one array of bytes and back, so the host can keep it
 * between visits. The image is a short header, then every node in an order where a directory comes before what it
 * holds (kind, permission bits, owner, time, the index of its directory, its name, its bytes), then the SHA-256 of
 * all that. Reading an image trusts nothing in it: the seal is checked first (here, or already by the host's own
 * digest), every length is checked against what is left, and the nodes are put back through the disk's own calls, so
 * a name a file cannot have, a file inside a file, or more bytes than the disk may hold is refused exactly as it would
 * be from a program. An image that fails any check is refused whole, and the disk is left empty rather than half
 * filled. The body can be made apart from its seal, so a host whose own digest runs off the page's thread seals a
 * large disk without holding the page up.
 * What breaks if it is removed? Files last only until the page is closed.
 */
import { concat, decode, encode, readU32, writeU32 } from './bytes.ts'
import { OsError, refuse } from './errno.ts'
import { ROOT_CRED, type Stat } from './fs.ts'
import type { MemFs } from './memfs.ts'
import { sha256 } from './sha.ts'

/** The first bytes of every image: the format's name and version. */
const MAGIC = encode('CNDISK1\n')
/** Bytes of the seal at the end of every image: the SHA-256 of everything before it. */
export const SEAL_BYTES = 32
/** Bytes of a node's fixed part: kind, permission bits, owner, group, time, the index of its directory, its name's length. */
const HEAD_BYTES = 1 + 2 + 4 + 4 + 8 + 4 + 2

/** Bodies `dumpBody` made, each with SEAL_BYTES of room after it in its own memory, where `sealed` writes the seal. */
const ROOMY = new WeakSet<Uint8Array>()

/**
 * The disk as one array of bytes, without its seal: what `sealed` makes an image of. Changes nothing on the disk. The
 * tree is walked once to size the image and once to write it, into one array made at its full size, and each file's
 * bytes are copied once, straight from the disk: no array grows, and none is joined at the end.
 */
export function dumpBody(fs: MemFs): Uint8Array {
  // Depth first, each directory's entries in the order of their names. What is still to visit is kept on a list of
  // its own, not on the call stack, so no tree is too deep to save (renames can build one deeper than any path).
  const order: { ino: number; parent: number; name: Uint8Array; st: Stat }[] = []
  let size = MAGIC.length + 4
  const pending: { ino: number; parent: number; name: string }[] = [{ ino: fs.root, parent: 0, name: '' }]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const st = fs.stat(next.ino)
    const index = order.length
    const name = encode(next.name)
    order.push({ ino: next.ino, parent: next.parent, name, st })
    size += HEAD_BYTES + name.length
    if (st.kind === 'dir') {
      // Last name first onto the list, so the first name comes off it first.
      const entries = fs.list(next.ino).sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
      for (const e of entries) pending.push({ ino: e.ino, parent: index, name: e.name })
    } else {
      size += 4 + st.size
    }
  }
  // The seal's room comes with it, so sealing the body writes the seal in place rather than copying the whole image.
  const memory = new Uint8Array(size + SEAL_BYTES)
  const view = new DataView(memory.buffer)
  memory.set(MAGIC, 0)
  writeU32(memory, MAGIC.length, order.length)
  let at = MAGIC.length + 4
  for (const { ino, parent, name, st } of order) {
    memory[at] = st.kind === 'dir' ? 1 : 2
    memory[at + 1] = st.mode & 255
    memory[at + 2] = (st.mode >> 8) & 255
    writeU32(memory, at + 3, st.uid)
    writeU32(memory, at + 7, st.gid)
    view.setFloat64(at + 11, st.mtime, true)
    writeU32(memory, at + 19, parent)
    memory[at + 23] = name.length & 255
    memory[at + 24] = (name.length >> 8) & 255
    at += HEAD_BYTES
    memory.set(name, at)
    at += name.length
    if (st.kind !== 'dir') {
      writeU32(memory, at, st.size)
      at += 4
      memory.set(fs.bytesOf(ino), at)
      at += st.size
    }
  }
  const body = memory.subarray(0, size)
  ROOMY.add(body)
  return body
}

/**
 * An image: a body from `dumpBody` with its seal, the SHA-256 of the body, after it. A seal of any other length is
 * refused (a RangeError), since no image could be checked with it; a wrong digest of the right length makes an image
 * that `restore` refuses. A body `dumpBody` made is sealed in the room it left for the seal, once (the image is then
 * that memory, the body a view of it); any other body is copied.
 */
export function sealed(body: Uint8Array, seal: Uint8Array): Uint8Array {
  if (seal.length !== SEAL_BYTES) throw new RangeError(`a seal is ${SEAL_BYTES} bytes, not ${seal.length}`)
  if (!ROOMY.delete(body)) return concat([body, seal])
  const image = new Uint8Array(body.buffer, body.byteOffset, body.length + SEAL_BYTES)
  image.set(seal, body.length)
  return image
}

/** The disk as one array of bytes, sealed. */
export function dump(fs: MemFs): Uint8Array {
  const body = dumpBody(fs)
  return sealed(body, sha256(body))
}

/**
 * Fills an empty disk from an image. Refuses, as EINVAL, an image that is not one, that fails its seal (unless the
 * caller checked the seal itself: `sealChecked`), or that holds anything the disk would not take; a refused image
 * leaves nothing behind: the disk is empty again, and its root keeps the permission bits, owner and time it had.
 */
export function restore(image: Uint8Array, fs: MemFs, opts: { readonly sealChecked?: boolean } = {}): void {
  const bad = (why: string): never => refuse('EINVAL', `not a disk image (${why})`)
  if (image.length < MAGIC.length + 4 + SEAL_BYTES) bad('too short')
  for (let i = 0; i < MAGIC.length; i++) if (image[i] !== MAGIC[i]) bad('wrong header')
  const end = image.length - SEAL_BYTES
  // A host that has checked the seal already with its own digest (off the page's thread) spares the page this one.
  if (opts.sealChecked !== true) {
    const seal = sha256(image.subarray(0, end))
    for (let i = 0; i < SEAL_BYTES; i++) if (image[end + i] !== seal[i]) bad('the seal does not match')
  }
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
