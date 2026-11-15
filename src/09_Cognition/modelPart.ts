// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The site's model (siteModel.ts) downloads straight into the page's storage, into a part
 * file beside a small note, so a download that stopped (a dropped connection, the visitor's Stop, the city's end, a
 * closed tab) goes on later from where it stopped instead of from the first byte. This is that part's one rule, pure:
 * - the part is `<file>.part` in the model's own directory under agent-city-models/ (modelStore.ts), and the note is
 *   part.json beside it: the pin it is for (file, size, SHA-256), how many bytes are written (`at`), the validator they
 *   came under (the server's strong ETag, else its Last-Modified; null when it gave neither, and then the part is
 *   never picked up again), the running SHA-256 over exactly those bytes (integrity.ts Sha256Saved) and when it was
 *   saved;
 * - the writer (openPart) takes the bytes in order, WRITE_BYTES at a time: each write is followed by a flush of the
 *   part and only then by the note, so the note never says more than the part holds and its hash is over exactly the
 *   bytes it counts. A stop writes what is buffered the same way first; the writer loses at most one write when its
 *   tab closes (the page may have up to AHEAD_BYTES more on their way to it, modelStore.ts);
 * - a note is trusted only when everything agrees: the same pin, a validator to ask with, saved within PART_DAYS
 *   (resumable), no more bytes than the pin's size or than the part holds, and the part's first `at` bytes, read back
 *   and hashed again, coming to exactly the hash state the note saved (so a part whose bytes changed on disk since,
 *   anywhere in them, is not picked up). Anything else starts over from the first byte; nothing half-trusted is used;
 * - the end gives the size written and, only when it is the pin's size, the SHA-256 of the whole file (the hash read
 *   back at the open carried on over the bytes written since, as they arrived). The caller compares both to the pin
 *   before anything is kept (modelStore.ts commitPart writes meta.json only after that), and deletes the part when
 *   they differ.
 * The worker (modelStore.worker.ts) runs the writer on the sync access handles only a worker can open; the store reads
 * notes to find a part to pick up and to sweep the rest; the Node tests drive the writer over in-memory handles. This
 * file imports only integrity.ts (pure), so the worker's bundle stays small, and addresses nothing.
 * What breaks if it is removed? A download that stopped at 90% starts again from nothing, and a note that disagrees
 * with its part could be picked up and a model kept from bytes nobody hashed.
 */
import { hex, isSha256Saved, sha256Stream, type Sha256Saved, type Sha256Stream } from '../02_Define_The_Rules/integrity.ts'

/** What the part file's name adds to the model's file name. */
export const PART_SUFFIX = '.part'
/** The note beside the part: what it is for and how far it has come. */
export const PART_NOTE = 'part.json'
/** A part whose note is older than this many days is swept, not picked up (its validator may well be stale by then). */
export const PART_DAYS = 7
/** How much one write puts down, as the copy does: few calls into the storage, a flush and a note every 8 MiB. */
export const WRITE_BYTES = 8 * 1024 * 1024

const DAY_MS = 24 * 60 * 60 * 1000

/** The model a part is for: its file name, its exact size and its SHA-256 (siteModel.ts SiteModelPin has these). */
export interface PartPin {
  readonly file: string
  readonly bytes: number
  readonly sha256: string
}

/** What part.json says (see the file's comment), v 1. */
export interface PartNote {
  readonly v: 1
  readonly file: string
  readonly bytes: number
  readonly sha256: string
  readonly at: number
  readonly validator: string | null
  readonly hash: Sha256Saved
  readonly savedAt: number
}

/** The part file's name for the model file `file`. */
export const partName = (file: string): string => `${file}${PART_SUFFIX}`

/** The note's text: one line of JSON. */
export const noteText = (n: PartNote): string => JSON.stringify(n)

/** The note `text` says, or null when it is not one this page wrote whole (a half-written note, junk, another version). */
export function parseNote(text: string): PartNote | null {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof o !== 'object' || o === null) return null
  const n = o as Record<string, unknown>
  if (n.v !== 1 || typeof n.file !== 'string' || n.file === '' || typeof n.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(n.sha256)) return null
  if (typeof n.bytes !== 'number' || !Number.isSafeInteger(n.bytes) || n.bytes <= 0) return null
  if (typeof n.at !== 'number' || !Number.isSafeInteger(n.at) || n.at < 0 || n.at > n.bytes) return null
  if (n.validator !== null && (typeof n.validator !== 'string' || n.validator === '')) return null
  if (typeof n.savedAt !== 'number' || !Number.isFinite(n.savedAt)) return null
  if (!isSha256Saved(n.hash) || n.hash.total !== n.at) return null
  return { v: 1, file: n.file, bytes: n.bytes, sha256: n.sha256, at: n.at, validator: n.validator as string | null, hash: n.hash, savedAt: n.savedAt }
}

/** The note is for exactly `pin`. */
export const forPin = (n: PartNote, pin: PartPin): boolean => n.file === pin.file && n.bytes === pin.bytes && n.sha256 === pin.sha256

/**
 * Whether the note `n` may be picked up for `pin` at `now`, by the note alone: the same pin, a validator to ask the
 * server with, saved within PART_DAYS (and not more than a day ahead of this clock). The part's own bytes are checked
 * by whoever opens it (openPart: its size, and every byte the note counts hashed again).
 */
export function resumable(n: PartNote | null, pin: PartPin, now: number): n is PartNote & { validator: string } {
  if (n === null || !forPin(n, pin) || n.validator === null) return false
  return now - n.savedAt <= PART_DAYS * DAY_MS && n.savedAt - now <= DAY_MS
}

/**
 * The part of a FileSystemSyncAccessHandle the writer uses. `read` and `write` are synchronous everywhere; the rest
 * returned promises in the first browsers that had them (Chrome before 108, Safari before 17), so they are awaited.
 */
export interface SyncFile {
  read(buffer: Uint8Array, options: { at: number }): number
  write(buffer: Uint8Array, options: { at: number }): number
  truncate(size: number): void | Promise<void>
  getSize(): number | Promise<number>
  flush(): void | Promise<void>
  close(): void | Promise<void>
}

/** How a writing ended: the bytes written, and the whole file's SHA-256 when they are the pin's size (else null). */
export interface PartEnd {
  readonly bytes: number
  readonly sha256: string | null
}

/** The writer over one part and its note (see the file's comment). */
export interface PartWriter {
  /** What was found to pick up: the bytes the part holds that its note vouches for (0: start over), and their validator. */
  readonly found: { readonly at: number; readonly validator: string | null }
  /**
   * Starts writing at `at` (0, or found.at) under `validator`: from 0 the part is emptied and the hash starts fresh;
   * from found.at the part is cut back to it (bytes written after the note are not vouched for). The note is saved.
   */
  begin(at: number, validator: string | null): Promise<void>
  /** Takes the next bytes (any split); writes, flushes and notes each time WRITE_BYTES are buffered. Resolves with the
   *  bytes taken so far. Refuses bytes past the pin's size. */
  put(bytes: Uint8Array): Promise<number>
  /** Writes what is buffered, flushes, notes, and closes both files: the part is left to be picked up. The bytes noted. */
  hold(): Promise<number>
  /** Writes what is buffered, flushes, notes, closes both files, and gives the size and (when whole) the SHA-256. */
  end(): Promise<PartEnd>
  /** Closes both files with nothing more written or noted (after a failure). */
  close(): Promise<void>
}

/** The whole of a small file through its handle, as text ('' when empty or unreadable). */
async function readText(f: SyncFile): Promise<string> {
  const size = await f.getSize()
  if (size <= 0 || size > 64 * 1024) return ''
  const buf = new Uint8Array(size)
  const n = f.read(buf, { at: 0 })
  return new TextDecoder().decode(buf.subarray(0, n))
}

/** Whether two saved hash states are the same state: the same running hash, held tail and count. */
const sameState = (a: Sha256Saved, b: Sha256Saved): boolean =>
  a.total === b.total && a.tail === b.tail && a.h.length === b.h.length && a.h.every((w, i) => w === b.h[i])

/**
 * Opens the writer over `data` (the part) and `note` (part.json) for `pin`: reads the note and keeps what it vouches
 * for only when it is resumable at `now()`, the part holds at least `at` bytes, and those `at` bytes, read back from
 * the part `buffer` at a time and hashed again, come to exactly the state the note saved (a part of the site's model
 * near its end is about 398 MB read and hashed once, before the download goes on). `buffer` is the write size
 * (WRITE_BYTES; the tests pass less).
 */
export async function openPart(data: SyncFile, note: SyncFile, pin: PartPin, now: () => number = Date.now, buffer = WRITE_BYTES): Promise<PartWriter> {
  const saved = parseNote(await readText(note))
  const size = await data.getSize()
  const buf = new Uint8Array(Math.max(1, Math.min(buffer, pin.bytes)))
  let ok = resumable(saved, pin, now()) && saved.at <= size
  let hash: Sha256Stream = sha256Stream()
  if (ok && saved !== null) {
    // Every byte the note counts, as the part holds it now: the note's own hash vouches for the bytes as they arrived,
    // and these are trusted only when they are still exactly those (a byte changed anywhere since starts over).
    for (let off = 0; ok && off < saved.at; off += buf.length) {
      const piece = buf.subarray(0, Math.min(buf.length, saved.at - off))
      ok = data.read(piece, { at: off }) === piece.length
      if (ok) hash.update(piece)
    }
    ok &&= sameState(hash.save(), saved.hash)
    if (!ok) hash = sha256Stream()
  }
  const found = ok && saved !== null ? { at: saved.at, validator: saved.validator } : { at: 0, validator: null }
  let at = found.at
  let fill = 0
  let validator: string | null = found.validator
  let begun = false
  let closed = false

  const saveNote = async (): Promise<void> => {
    const text = new TextEncoder().encode(noteText({ v: 1, file: pin.file, bytes: pin.bytes, sha256: pin.sha256, at, validator, hash: hash.save(), savedAt: now() }))
    const wrote = note.write(text, { at: 0 })
    if (wrote !== text.length) throw new Error(`the page's storage took ${wrote} of ${text.length} bytes of the download's note: it may be full`)
    await note.truncate(text.length)
    await note.flush()
  }
  /** The buffered bytes written at `at`, then hashed, flushed and noted, in that order. */
  const write = async (): Promise<void> => {
    if (fill === 0) return
    const wrote = data.write(buf.subarray(0, fill), { at })
    if (wrote !== fill) throw new Error(`the page's storage took ${wrote} of ${fill} bytes: it may be full`)
    hash.update(buf.subarray(0, fill))
    at += fill
    fill = 0
    await data.flush()
    await saveNote()
  }
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    let first: unknown = null
    for (const f of [data, note]) {
      try {
        await f.close()
      } catch (e) {
        first ??= e
      }
    }
    if (first !== null) throw first
  }
  const open = (): void => {
    if (closed) throw new Error('the download\'s part is closed already')
  }

  return {
    found,
    async begin(start, v) {
      open()
      if (begun) throw new Error('the download\'s part has begun already')
      if (start !== 0 && start !== found.at) throw new Error(`the download's part holds ${found.at} bytes, not ${start}`)
      begun = true
      if (start === 0) hash = sha256Stream()
      at = start
      validator = v
      await data.truncate(at)
      await data.flush()
      await saveNote()
    },
    async put(bytes) {
      open()
      if (!begun) throw new Error('the download\'s part has not begun')
      if (at + fill + bytes.length > pin.bytes) throw new RangeError(`more bytes than the ${pin.bytes} of ${pin.file}`)
      for (let off = 0; off < bytes.length;) {
        const n = Math.min(bytes.length - off, buf.length - fill)
        buf.set(bytes.subarray(off, off + n), fill)
        fill += n
        off += n
        if (fill === buf.length) await write()
      }
      return at + fill
    },
    async hold() {
      open()
      if (begun) await write()
      await close()
      return at
    },
    async end() {
      open()
      if (!begun && at !== pin.bytes) throw new Error('the download\'s part has not begun')
      await write()
      const sha256 = at === pin.bytes ? hex(hash.digest()) : null
      await close()
      return { bytes: at, sha256 }
    },
    close,
  }
}
