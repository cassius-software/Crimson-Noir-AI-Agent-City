// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the copy behind keeping a model in the page (modelStore.ts keep, through
 * workerCopy), and the writer behind downloading the site's model straight into it (modelStore.ts openPart, through
 * workerPart): a dedicated worker, because only a worker may open a file of the page's storage for synchronous writes
 * (createSyncAccessHandle), the fastest way to put gigabytes there and the way wllama's own cache writes its files.
 * - A copy takes one file and where it goes (names from the storage's root, so no handle has to cross to it), streams
 *   the file through an 8 MiB buffer into the handle, each write at its own offset, cuts the file to the size written,
 *   flushes and closes it, and says how far it has got after every write.
 * - A download (messages with a `t`) opens the model's part and its note there (modelPart.ts openPart), says what it
 *   found to pick up, or that this browser has no synchronous handle (then the page downloads as it did before), and
 *   then takes the bytes the page posts, in order, one message at a time: each is written, hashed and noted as
 *   modelPart.ts says, and acknowledged with how many bytes are taken, so the page never runs far ahead of the disk.
 *   A hold writes what is buffered and notes it (the part is left to be picked up); an end does the same and says the
 *   size and, when whole, the SHA-256. The page fetches; this worker never does.
 * It never makes the model's directory (the page made it, and one swept or forgotten meanwhile fails the copy rather
 * than coming back), never opens a part where a meta.json says a model is kept, and never decides the commit (the page
 * sends meta.json last, as one more file). It reads only the file or the bytes it is given and addresses nothing, so
 * it has no network primitive and installs no gate of its own (airgap.test.ts holds every runtime source to that), and
 * it imports only modelPart.ts at run time (which imports only the pure integrity.ts). One worker copies one file or
 * writes one download; the page ends it when it is done, held or aborted.
 * What breaks if it is removed? A multi-gigabyte copy runs on the page's thread through a writable stream where the
 * browser offers one, and not at all in a browser that writes the page's storage only from a worker; and the site's
 * model goes back to a download held whole in memory before it is copied.
 */
import type { CopyReply, CopyRequest, PartReply, PartRequest } from './modelStore.ts'
import { PART_NOTE, openPart, partName, type PartWriter, type SyncFile } from './modelPart.ts'

/** How much one write puts down, as wllama's own copy does: few calls into the storage, and progress every 8 MiB. */
const WRITE_BYTES = 8 * 1024 * 1024

/** The part of a FileSystemSyncAccessHandle the copy uses (it exists only in workers; the page's types leave it out). */
interface SyncHandle {
  write(buffer: Uint8Array, options: { at: number }): number
  truncate(size: number): void
  flush(): void
  close(): void
}

/** The part of a directory handle the copy and the download use (a browser without the sync handle leaves it out). */
interface Dir {
  getDirectoryHandle(name: string): Promise<Dir>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<{ createSyncAccessHandle?(): Promise<SyncHandle & SyncFile> }>
}

/** A kept model's commit (modelStore.ts META; named here, so the worker's bundle takes nothing of the store). */
const META = 'meta.json'
/** Why the download will not open a part where a model is kept (said as InvalidModificationError; the page says why). */
const KEPT_HERE = 'a model is kept in this directory of the page\'s storage, so no download is written into it'

const scope = globalThis as unknown as {
  navigator: { storage?: { getDirectory?(): Promise<Dir> } }
  postMessage(message: CopyReply | PartReply): void
  onmessage: ((e: { data: CopyRequest | PartRequest }) => unknown) | null
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
    let dir = await directory()
    for (const part of m.dirPath) dir = await dir.getDirectoryHandle(part)
    const file = await dir.getFileHandle(m.name, { create: true })
    if (typeof file.createSyncAccessHandle !== 'function') throw new DOMException(NO_SYNC, 'NotSupportedError')
    handle = await file.createSyncAccessHandle()
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

/** Why the download cannot write here: this browser opens no synchronous handle on the page's storage. */
const NO_SYNC = 'this browser writes no file of the page\'s storage from a worker'

/** The storage's root; a browser that gives the page none says so as NotSupportedError. */
function directory(): Promise<Dir> {
  const get = scope.navigator.storage?.getDirectory
  if (typeof get !== 'function') return Promise.reject(new DOMException('this browser gives the page no storage for files', 'NotSupportedError'))
  return get.call(scope.navigator.storage)
}

/** The one download this worker writes, once its part is open; `over` once it has ended, failed or said it cannot. */
let writer: PartWriter | null = null
let over = false
/** The download's messages, one at a time in the order posted (an open or a write awaits; the next waits for it). */
let queue: Promise<void> = Promise.resolve()

const said = (e: unknown): { name: string; message: string } => ({ name: e instanceof Error ? e.name : 'Error', message: e instanceof Error ? e.message : String(e) })

/** Opens the part and its note in the directory the page named; null (said as unsupported) where no sync handle opens. */
async function openFor(m: Extract<PartRequest, { t: 'part' }>): Promise<PartWriter | null> {
  let dir: Dir
  try {
    dir = await directory()
  } catch (e) {
    // No storage this browser lets the page write: the page downloads as it did before.
    if (e instanceof Error && (e.name === 'NotSupportedError' || e.name === 'SecurityError')) {
      scope.postMessage({ t: 'unsupported', why: e.message })
      return null
    }
    throw e
  }
  for (const part of m.dirPath) dir = await dir.getDirectoryHandle(part)
  // A kept model's file is never written as a part: the page looks again under the directory's lock before it asks,
  // and this is the last word on it where nothing else holds (a browser without Web Locks), before anything is made.
  if (await dir.getFileHandle(META).then(() => true, () => false)) throw new DOMException(KEPT_HERE, 'InvalidModificationError')
  const dataFile = await dir.getFileHandle(partName(m.pin.file), { create: true })
  if (typeof dataFile.createSyncAccessHandle !== 'function') {
    scope.postMessage({ t: 'unsupported', why: NO_SYNC })
    return null
  }
  const noteFile = await dir.getFileHandle(PART_NOTE, { create: true })
  const data = await dataFile.createSyncAccessHandle()
  let note: SyncFile
  try {
    note = await (noteFile.createSyncAccessHandle as () => Promise<SyncFile>)()
  } catch (e) {
    await data.close()
    throw e
  }
  try {
    return await openPart(data, note, m.pin, Date.now)
  } catch (e) {
    for (const f of [data, note]) {
      try {
        await f.close()
      } catch {
        // Closed already: the failure that opened nothing is the one to say.
      }
    }
    throw e
  }
}

/** One message of the download, in its turn; a failure closes the files (the note keeps what was last written whole). */
async function step(m: PartRequest): Promise<void> {
  // A worker writes one download (the page posts one 'part'); a second would start afresh, never inherit the first.
  if (m.t === 'part') {
    writer = null
    over = false
  }
  if (over) return
  try {
    if (m.t === 'part') {
      writer = await openFor(m)
      if (writer === null) over = true
      else scope.postMessage({ t: 'ready', at: writer.found.at, validator: writer.found.validator })
      return
    }
    if (writer === null) throw new Error('the download\'s part is not open')
    if (m.t === 'begin') {
      await writer.begin(m.at, m.validator)
      scope.postMessage({ t: 'taken', n: m.at })
    } else if (m.t === 'chunk') {
      scope.postMessage({ t: 'taken', n: await writer.put(m.bytes) })
    } else if (m.t === 'hold') {
      over = true
      scope.postMessage({ t: 'held', n: await writer.hold() })
    } else {
      over = true
      const end = await writer.end()
      scope.postMessage({ t: 'ended', n: end.bytes, sha256: end.sha256 })
    }
  } catch (e) {
    over = true
    await writer?.close().catch(() => undefined)
    scope.postMessage({ t: 'error', ...said(e) })
  }
}

scope.onmessage = (e) => {
  const m = e.data
  if ('t' in m) {
    queue = queue.then(() => step(m))
    return queue
  }
  return copy(m)
}
