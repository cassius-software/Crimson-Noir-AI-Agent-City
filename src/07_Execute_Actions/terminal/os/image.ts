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
 * any check is refused whole, and the disk is left empty rather than half filled.
 * What breaks if it is removed? Files last only until the page is closed.
 */
import { concat, decode, encode, readU32, writeU32 } from './bytes.ts'
import { OsError, refuse } from './errno.ts'
import { ROOT_CRED } from './fs.ts'
import type { MemFs } from './memfs.ts'
import { sha256 } from './sha.ts'

/** The first bytes of every image: the format's name and version. */
const MAGIC = encode('CNDISK1\n')
const SEAL = 32

/** The disk as one array of bytes. */
export function dump(fs: MemFs): Uint8Array {
  const chunks: Uint8Array[] = [MAGIC]
  const count = new Uint8Array(4)
  chunks.push(count)
  let nodes = 0
  const visit = (ino: number, parent: number, name: string): void => {
    const st = fs.stat(ino)
    const index = nodes++
    const nameBytes = encode(name)
    const head = new Uint8Array(1 + 2 + 4 + 4 + 8 + 4 + 2)
    head[0] = st.kind === 'dir' ? 1 : 2
    head[1] = st.mode & 255
    head[2] = (st.mode >> 8) & 255
    writeU32(head, 3, st.uid)
    writeU32(head, 7, st.gid)
    new DataView(head.buffer).setFloat64(11, st.mtime, true)
    writeU32(head, 19, parent)
    head[23] = nameBytes.length & 255
    head[24] = (nameBytes.length >> 8) & 255
    chunks.push(head, nameBytes)
    if (st.kind === 'dir') {
      const entries = fs.list(ino).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const e of entries) visit(e.ino, index, e.name)
    } else {
      const size = new Uint8Array(4)
      writeU32(size, 0, st.size)
      chunks.push(size, fs.read(ino, 0, st.size))
    }
  }
  visit(fs.root, 0, '')
  writeU32(count, 0, nodes)
  const body = concat(chunks)
  return concat([body, sha256(body)])
}

/**
 * Fills an empty disk from an image. Refuses, as EINVAL, an image that is not one, that fails its seal, or that
 * holds anything the disk would not take; the disk may then hold part of it, so the caller restores into a new one.
 */
export function restore(image: Uint8Array, fs: MemFs): void {
  const bad = (why: string): never => refuse('EINVAL', `not a disk image (${why})`)
  if (image.length < MAGIC.length + 4 + SEAL) bad('too short')
  for (let i = 0; i < MAGIC.length; i++) if (image[i] !== MAGIC[i]) bad('wrong header')
  const end = image.length - SEAL
  const seal = sha256(image.subarray(0, end))
  for (let i = 0; i < SEAL; i++) if (image[end + i] !== seal[i]) bad('the seal does not match')
  if (fs.list(fs.root).length > 0) refuse('EINVAL', 'the disk is not empty')
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength)
  let at = MAGIC.length
  const count = readU32(image, at)
  at += 4
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
    // Last, so a directory keeps the time the image gave it and not the time its files were put back.
    for (const a of attrs) fs.setattr(a.ino, { mode: a.mode, uid: a.uid, gid: a.gid, mtime: a.mtime })
  } catch (e) {
    if (e instanceof OsError && e.errno !== 'EINVAL') bad(e.message)
    throw e
  }
  if (at !== end) bad('bytes left over')
}
