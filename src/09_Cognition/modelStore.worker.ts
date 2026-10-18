// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the copy behind keeping a model in the page (modelStore.ts keep, through
 * workerCopy): a dedicated worker, because only a worker may open a file of the page's storage for synchronous writes
 * (createSyncAccessHandle), the fastest way to put gigabytes there and the way wllama's own cache writes its files. It
 * takes one file and where it goes (names from the storage's root, so no handle has to cross to it), streams the file
 * through an 8 MiB buffer into the handle, each write at its own offset, cuts the file to the size written, flushes
 * and closes it, and says how far it has got after every write. It never makes the model's directory (the page made
 * it, and one swept or forgotten meanwhile fails the copy rather than coming back) and never decides the commit (the
 * page sends meta.json last, as one more file). It reads only the file it is given and addresses nothing, so it has
 * no network primitive and installs no gate of its own (airgap.test.ts holds every runtime source to that), and it
 * imports nothing at run time. One worker copies one file; the page ends it when it is done or the copy is aborted.
 * What breaks if it is removed? A multi-gigabyte copy runs on the page's thread through a writable stream where the
 * browser offers one, and not at all in a browser that writes the page's storage only from a worker.
 */
import type { CopyReply, CopyRequest } from './modelStore.ts'

/** How much one write puts down, as wllama's own copy does: few calls into the storage, and progress every 8 MiB. */
const WRITE_BYTES = 8 * 1024 * 1024

/** The part of a FileSystemSyncAccessHandle the copy uses (it exists only in workers; the page's types leave it out). */
interface SyncHandle {
  write(buffer: Uint8Array, options: { at: number }): number
  truncate(size: number): void
  flush(): void
  close(): void
}

/** The part of a directory handle the copy uses. */
interface Dir {
  getDirectoryHandle(name: string): Promise<Dir>
  getFileHandle(name: string, options: { create: true }): Promise<{ createSyncAccessHandle(): Promise<SyncHandle> }>
}

const scope = globalThis as unknown as {
  navigator: { storage: { getDirectory(): Promise<Dir> } }
  postMessage(message: CopyReply): void
  onmessage: ((e: { data: CopyRequest }) => unknown) | null
}

/** Streams `file` into `handle` WRITE_BYTES at a time, each write at its offset, then cuts and flushes the file. */
async function writeAll(file: Blob, handle: SyncHandle, onBytes: (n: number) => void): Promise<number> {
  const buf = new Uint8Array(Math.max(1, Math.min(WRITE_BYTES, file.size)))
  let fill = 0
  let at = 0
  const put = (): void => {
    const wrote = handle.write(buf.subarray(0, fill), { at })
    if (wrote !== fill) throw new Error(`the page's storage took ${wrote} of ${fill} bytes: it may be full`)
    at += fill
    fill = 0
    onBytes(at)
  }
  const reader = file.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    for (let off = 0; off < value.length;) {
      const n = Math.min(value.length - off, buf.length - fill)
      buf.set(value.subarray(off, off + n), fill)
      fill += n
      off += n
      if (fill === buf.length) put()
    }
  }
  if (fill > 0) put()
  if (at !== file.size) throw new Error(`the file gave ${at} of its ${file.size} bytes (it may have changed while it was copied)`)
  handle.truncate(at)
  handle.flush()
  return at
}

/** Copies one file to where the page said, closing the file before it says done; any failure is said with its name. */
async function copy(m: CopyRequest): Promise<void> {
  let handle: SyncHandle | null = null
  try {
    let dir = await scope.navigator.storage.getDirectory()
    for (const part of m.dirPath) dir = await dir.getDirectoryHandle(part)
    handle = await (await dir.getFileHandle(m.name, { create: true })).createSyncAccessHandle()
    const n = await writeAll(m.file, handle, (b) => scope.postMessage({ t: 'bytes', n: b }))
    const h = handle
    handle = null
    h.close()
    scope.postMessage({ t: 'done', n })
  } catch (e) {
    if (handle !== null) {
      try {
        handle.close()
      } catch {
        // Closed already: the failure below is the one to say.
      }
    }
    scope.postMessage({ t: 'error', name: e instanceof Error ? e.name : 'Error', message: e instanceof Error ? e.message : String(e) })
  }
}

scope.onmessage = (e) => copy(e.data)
