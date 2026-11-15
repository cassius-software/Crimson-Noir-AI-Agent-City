// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It keeps the model file the operator picked for the in-page model (the `inpage`
 * provider) in the page's own storage, the origin private file system, so a later visit loads it without asking
 * again. A model is one GGUF or the shards of a split one, a few gigabytes, and keeping it is a copy that has to be
 * safe to cut short:
 * - before a byte is copied, every file's header is read (gguf.ts) and anything that is not one whole model that
 *   writes text is refused with its reason: a picture, an embedding or reranking model, half of a split model;
 * - the browser is asked how much room is left, and a model that would not fit with 64 MiB to spare is refused with
 *   both sizes;
 * - each file is copied off the page's thread (modelStore.worker.ts through workerCopy, which App wires) into
 *   agent-city-models/<id>/, never into wllama's own cache/ (the service worker's cleanup touches caches, never this);
 * - meta.json is written last and is the commit: a directory without a readable one is a copy cut short (an abort, a
 *   closed tab, a full disk), and the next list() sweeps it, unless a copy still holds the directory's lock (a Web
 *   Lock, which every tab of the page's origin sees: another tab of the city keeping a model there now);
 * - where the browser keeps no files for this page (a page opened from a file, a private window) the picked files are
 *   held for this visit only, and the storage row says why.
 * open() hands the kept files back in load order, each named as it was kept (wllama's own shard sort reads the
 * names); a file the browser has since cleared is an 'offline' failure, so the router looks elsewhere and the
 * console says to choose it again.
 * The site's model is not copied: it downloads straight into a directory of its own here (openPart), into a part file
 * the worker writes and notes as it goes (modelPart.ts), so nothing holds the whole file in memory first and a download
 * that stopped goes on from where it stopped. A download holds the pin's own Web Lock beside its directory's, so
 * another tab of the city neither downloads the same model beside it nor, once it is kept, downloads it again or writes
 * into it (openPart looks for it again under the directory's lock). A part is never a kept model: list() leaves alone
 * only the one part per pin the page may still pick up (resumable: one of `parts`, with a validator, saved within
 * PART_DAYS, its file at least as long as its note says) and sweeps every other; part() tells the room check how far
 * one has come; forget() with no name removes parts too, and forgetParts() a model file's parts by its name (a download
 * under way holds its lock and is left alone). commitPart keeps a part only after its download's end matched the pin's
 * size and SHA-256 (siteModel.ts downloadSiteModel): its header read as a picked file's is, renamed to the model's name
 * where the browser can (else meta.json says which file holds it), and meta.json written last, the same commit as a
 * copy's. Everything the browser provides is injected (StoreDeps), so the Node tests drive it with an in-memory
 * directory; this file never imports the worker (a bundler-only import).
 * What breaks if it is removed? The in-page model must be picked again on every visit, a multi-gigabyte copy has no
 * progress, no room check and no commit, and a file that is not a model is found out only when llama.cpp fails on it.
 */
import { GgufError, blobReader, readGgufHeader, shardOrder, textModel, type GgufHeader } from './gguf.ts'
import { CognitionError, sentence } from './localCompute.ts'
import { PART_NOTE, forPin, parseNote, partName, resumable, type PartEnd, type PartNote, type PartPin } from './modelPart.ts'

/**
 * One file of a kept model: its name as kept and its size; `stored`, the name it is stored under when that differs
 * (a downloaded model in a browser that cannot rename a file of its storage stays in its part file).
 */
export interface KeptFile { readonly name: string; readonly bytes: number; readonly stored?: string }

/** A model kept in this page (or, when the browser keeps no files for it, held for this visit). */
export interface KeptModel {
  readonly id: string               // directory name under agent-city-models/
  readonly name: string             // display name: the first shard's file name without -NNNNN-of-NNNNN
  readonly files: readonly KeptFile[]   // in load order
  readonly bytes: number
  readonly keptAt: number
  readonly durable: boolean         // false = this visit only (OPFS refused)
}

export interface ModelStore {
  /** Checks the files, copies them in load order and commits; refuses with CognitionError('model', reason). */
  keep(files: readonly File[], onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<KeptModel>
  /** The kept models, newest first; sweeps every copy that was cut short. */
  list(): Promise<readonly KeptModel[]>
  /** The files to load, in order, each a File named as kept (so wllama's own shard sort also works). Throws
   *  CognitionError('offline', …) when the kept files have gone (evicted). */
  open(id: string): Promise<readonly File[]>
  forget(id?: string): Promise<number>   // how many models removed (parts go too, uncounted, when no id is given)
  /** Removes the parts of downloads of the model file `file` (any pin), but one a download holds just now; how many. */
  forgetParts?(file: string): Promise<number>
  usage(): Promise<{ used: number; quota: number } | null>
  storageLine(): string                  // "kept in this page" | "copying 42%" | "downloading 42%" | "this visit only: <reason>"
}

/**
 * The page's side of one download into a part (openPart): what was found to pick up (`at` bytes under `validator`,
 * 0 and null for a fresh start), and the calls siteModel.ts downloadSiteModel makes (its SiteSink). `begin` starts at
 * 0 or `at`; `put` hands on the next bytes (they are the worker's from then on) and resolves once the worker is no
 * more than AHEAD_BYTES behind; `hold` leaves the part to be picked up and ends the download; `end` says the size
 * and, when whole, the SHA-256 (the caller compares them to the pin, then commits or discards); `discard` removes the
 * part; `release` lets go of the directory and the worker, leaving the part as it is. Every call after the end does
 * nothing, or rejects.
 */
export interface PartSession {
  readonly id: string
  readonly at: number
  readonly validator: string | null
  begin(at: number, validator: string | null): void
  put(bytes: Uint8Array): Promise<void>
  hold(): Promise<number>
  end(): Promise<PartEnd>
  discard(): Promise<void>
  release(): void
}

/** What a store adds for downloads straight into the page (createModelStore gives both). */
export interface PartStore {
  /** The part this page may pick up for `pin` and how far it has come, or null: for the room check (roomRefusal's rest). */
  part(pin: PartPin): Promise<{ readonly id: string; readonly at: number } | null>
  /**
   * Opens a download of `pin` into its part (the one to pick up, else a new directory), holding the pin's own lock and
   * the directory's until the download ends (another tab's openPart of the same pin meanwhile is refused, ANOTHER_TAB;
   * one that finds the model kept since it looked is refused too, KEPT_ELSEWHERE); null where this browser writes no
   * part (no storage the page may write, no synchronous handle in a worker, or a store built without `part`): the page
   * then downloads as it did before.
   */
  openPart(pin: PartPin): Promise<PartSession | null>
  /** Keeps the part of a download whose end matched `pin` as a model (see the file's comment); removes it on failure. */
  commitPart(session: PartSession, pin: PartPin, onProgress?: (done: number, total: number) => void): Promise<KeptModel>
}

/**
 * Copies `file` into `dir` as `name`, calling `onBytes` with how many of its bytes are written so far, and rejects
 * with the signal's reason when it is aborted.
 */
export type CopyFile = (dir: FileSystemDirectoryHandle, name: string, file: File, onBytes: (n: number) => void, signal?: AbortSignal) => Promise<void>

/**
 * The part of the Web Locks API (navigator.locks) the store uses: exclusive locks by name, shared by every page and
 * worker of the origin, let go when the callback settles or its tab closes. With `ifAvailable` a lock held elsewhere
 * is not waited for: the callback gets null.
 */
export interface LockManagerLike {
  request<T>(name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => Promise<T>): Promise<T>
}

export interface StoreDeps {
  directory?: () => Promise<FileSystemDirectoryHandle>   // navigator.storage.getDirectory
  copy?: CopyFile                                         // the worker in the product (workerCopy)
  part?: OpenPartLink                                     // the download's worker in the product (workerPart); none: no parts
  parts?: readonly PartPin[]                              // the pins whose parts list() leaves to be picked up
  estimate?: () => Promise<{ usage?: number; quota?: number }>
  persist?: () => Promise<boolean>
  locks?: LockManagerLike                                 // navigator.locks
  now?: () => number
}

/** The directory under the storage's root that holds one directory per kept model. */
export const MODELS_DIR = 'agent-city-models'
/** The commit: a model's directory is a kept model only once this is in it, written after every model file. */
export const META = 'meta.json'
/** The room a copy leaves free beyond the model itself, so the page's other storage still has some. */
export const SPARE_BYTES = 64 * 1024 * 1024
/** Why open() fails when a kept file is no longer there. */
export const GONE = "the kept model file has gone from this page's storage (the browser may have cleared it): choose it again"
/** Why the page cannot keep files where the browser offers it no storage of its own. */
const NO_STORAGE = 'this browser gives the page no storage for files'

/**
 * What the page posts to the copy worker: the file and where it goes, as names from the storage's root (the worker
 * opens the directory itself, so no handle has to cross to it).
 */
export interface CopyRequest { readonly dirPath: readonly string[]; readonly name: string; readonly file: Blob }
/** What the copy worker posts back: how many bytes are written after each write, the end, or why it stopped. */
export type CopyReply = { t: 'bytes'; n: number } | { t: 'done'; n: number } | { t: 'error'; name: string; message: string }

/**
 * What the page posts to the worker for a download (modelStore.worker.ts): open the part of `pin` in the directory
 * named from the storage's root, begin at 0 or at what was found, the next bytes (transferred), hold, or end.
 */
export type PartRequest =
  | { t: 'part'; dirPath: readonly string[]; pin: PartPin }
  | { t: 'begin'; at: number; validator: string | null }
  | { t: 'chunk'; bytes: Uint8Array }
  | { t: 'hold' }
  | { t: 'end' }
/**
 * What the download's worker posts back: what it found to pick up, that no synchronous handle opens here, how many
 * bytes it has taken after each message, what it noted on a hold, the end, or why it stopped.
 */
export type PartReply =
  | { t: 'ready'; at: number; validator: string | null }
  | { t: 'unsupported'; why: string }
  | { t: 'taken'; n: number }
  | { t: 'held'; n: number }
  | { t: 'ended'; n: number; sha256: string | null }
  | { t: 'error'; name: string; message: string }

/** The page's end of one download's worker (workerPart): what it found, and the messages it sends. */
export interface PartLink {
  readonly at: number
  readonly validator: string | null
  begin(at: number, validator: string | null): void
  put(bytes: Uint8Array): Promise<void>
  hold(): Promise<number>
  end(): Promise<PartEnd>
  /** Ends the worker at once (its files close as it ends). */
  stop(): void
}

/** Opens a download's worker on the part of `pin` in `dirPath`; null where no synchronous handle opens there. */
export type OpenPartLink = (dirPath: readonly string[], pin: PartPin) => Promise<PartLink | null>

/** How far the page may post bytes ahead of what the download's worker has taken: two of its writes. */
export const AHEAD_BYTES = 16 * 1024 * 1024
/** How long a hold or an end may take before the worker is taken to have hung, ms (one write, a flush, a note). */
export const PART_ANSWER_MS = 30_000

/** Whether `e` is an error (a DOMException as often as not) of the given name. */
const named = (e: unknown, name: string): boolean => (e as { name?: unknown } | null)?.name === name

/** An error's message as one plain clause, without a closing full stop. */
const said = (e: unknown): string => sentence(e instanceof Error ? e.message : String(e)).replace(/\.$/, '')

/**
 * The product's copy: one worker per file (`makeWorker` builds modelStore.worker.ts, imported `?worker&inline` by
 * App), told where the file goes under the storage's root. Resolves when the worker says it is done; rejects with
 * the worker's own error (its name kept, so a full disk still reads as QuotaExceededError), or with the signal's
 * reason on an abort, ending the worker at once (the browser closes its file when it ends; what it wrote is swept).
 */
export function workerCopy(makeWorker: () => Worker): CopyFile {
  return (dir, name, file, onBytes, signal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    let worker: Worker
    try {
      worker = makeWorker()
    } catch (e) {
      return reject(e)
    }
    let open = true
    const end = (ok: boolean, error?: unknown): void => {
      if (!open) return
      open = false
      signal?.removeEventListener('abort', onAbort)
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
      if (ok) resolve()
      else reject(error)
    }
    const onAbort = (): void => end(false, signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.onmessage = (e: MessageEvent<CopyReply>) => {
      const m = e.data
      if (m.t === 'bytes') onBytes(m.n)
      else if (m.t === 'done') {
        onBytes(m.n)
        end(true)
      } else end(false, new DOMException(m.message, m.name))
    }
    worker.onerror = (e) => {
      e.preventDefault()
      end(false, new Error(`the copy worker stopped: ${e.message || 'worker error'}`))
    }
    const request: CopyRequest = { dirPath: [MODELS_DIR, dir.name], name, file }
    try {
      worker.postMessage(request)
    } catch (e) {
      end(false, e)
    }
  })
}

/**
 * The copy without a worker, for a store built with no `copy`: the file streamed through the page's own writable
 * stream on the file (createWritable), which the browser commits when it closes and discards on an abort.
 */
export const writableCopy: CopyFile = async (dir, name, file, onBytes, signal) => {
  const handle = await dir.getFileHandle(name, { create: true })
  if (typeof handle.createWritable !== 'function') throw new Error('this browser writes files into the page\'s storage only from a worker')
  const out = await handle.createWritable()
  let n = 0
  const count = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, c) {
      n += chunk.byteLength
      c.enqueue(chunk)
      onBytes(n)
    },
  })
  await file.stream().pipeThrough(count).pipeTo(out, signal ? { signal } : {})
}

/**
 * The product's download writer: one worker per download (`makeWorker`, the same modelStore.worker.ts the copy uses),
 * told where the part is under the storage's root. Resolves with the link once the worker says what it found, or null
 * once it says no synchronous handle opens here; rejects with the worker's own error (its name kept). Bytes are
 * posted as they come, each transferred, and `put` waits while more than `ahead` bytes are with the worker untaken.
 * Any failure ends the worker and rejects every call waiting on it.
 */
export function workerPart(makeWorker: () => Worker, ahead = AHEAD_BYTES, answerMs = PART_ANSWER_MS): OpenPartLink {
  return (dirPath, pin) => new Promise<PartLink | null>((resolve, reject) => {
    let worker: Worker
    try {
      worker = makeWorker()
    } catch (e) {
      reject(e)
      return
    }
    let alive = true
    let opened = false
    let failure: unknown = null
    let posted = 0
    let taken = 0
    const room: { go: () => void; no: (e: unknown) => void }[] = []
    let waiting: { want: 'held' | 'ended'; go: (m: PartReply) => void; no: (e: unknown) => void; timer: ReturnType<typeof setTimeout> } | null = null
    const stop = (): void => {
      if (!alive) return
      alive = false
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
    }
    const fail = (e: unknown): void => {
      failure ??= e
      stop()
      for (const r of room.splice(0)) r.no(failure)
      if (waiting) {
        clearTimeout(waiting.timer)
        waiting.no(failure)
        waiting = null
      }
      if (!opened) reject(failure)
    }
    const ended = (): unknown => failure ?? new Error("the download's worker has ended")
    const finish = (t: 'hold' | 'end', want: 'held' | 'ended'): Promise<PartReply> => {
      if (!alive || waiting) return Promise.reject(ended())
      return new Promise<PartReply>((go, no) => {
        const timer = setTimeout(() => fail(new Error(`the download's worker did not answer in ${Math.round(answerMs / 1000)} s`)), answerMs)
        waiting = { want, go, no, timer }
        worker.postMessage({ t } satisfies PartRequest)
      })
    }
    worker.onmessage = (e: MessageEvent<PartReply>) => {
      const m = e.data
      if (m.t === 'error') fail(new DOMException(m.message, m.name))
      else if (m.t === 'unsupported') {
        stop()
        opened = true
        resolve(null)
      } else if (m.t === 'ready') {
        opened = true
        resolve(link(m.at, m.validator))
      } else if (m.t === 'taken') {
        taken = Math.max(taken, m.n)
        while (room.length > 0 && posted - taken <= ahead) room.shift()?.go()
      } else if (waiting && m.t === waiting.want) {
        const w = waiting
        waiting = null
        clearTimeout(w.timer)
        stop()
        w.go(m)
      }
    }
    worker.onerror = (e) => {
      e.preventDefault()
      fail(new Error(`the download's worker stopped: ${e.message || 'worker error'}`))
    }
    const link = (at: number, validator: string | null): PartLink => ({
      at,
      validator,
      begin(start, v) {
        if (!alive) throw ended()
        posted = start
        taken = start
        worker.postMessage({ t: 'begin', at: start, validator: v } satisfies PartRequest)
      },
      put(bytes) {
        if (!alive) return Promise.reject(ended())
        // Handed over, not copied: a piece that is a view into a larger buffer is copied out first.
        const own = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer ? bytes : bytes.slice()
        posted += own.byteLength
        worker.postMessage({ t: 'chunk', bytes: own } satisfies PartRequest, [own.buffer as ArrayBuffer])
        if (posted - taken <= ahead) return Promise.resolve()
        return new Promise<void>((go, no) => room.push({ go, no }))
      },
      hold: () => finish('hold', 'held').then((m) => (m.t === 'held' ? m.n : 0)),
      end: () => finish('end', 'ended').then((m) => (m.t === 'ended' ? { bytes: m.n, sha256: m.sha256 } : { bytes: 0, sha256: null })),
      stop,
    })
    try {
      worker.postMessage({ t: 'part', dirPath: [...dirPath], pin: { file: pin.file, bytes: pin.bytes, sha256: pin.sha256 } } satisfies PartRequest)
    } catch (e) {
      fail(e)
    }
  })
}

/** The part of navigator.storage the store reads; any of it may be missing. */
interface StorageLike {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>
  estimate?: () => Promise<{ usage?: number; quota?: number }>
  persist?: () => Promise<boolean>
}

/** A gibibyte and a mebibyte: sizes are counted in these and written "GB" and "MB", as inPagePlan.ts writes them. */
const GIB = 2 ** 30
const MIB = 2 ** 20

/** A size in plain words, rounded up (what is needed) or down (what is free). */
function size(bytes: number, up: boolean): string {
  const round = up ? Math.ceil : Math.floor
  if (bytes >= GIB) return `${(round((bytes / GIB) * 10) / 10).toFixed(1)} GB`
  return `${round(bytes / MIB)} MB`
}

/**
 * Why a model of `bytes` will not fit in storage that has `used` of `quota` taken (with SPARE_BYTES kept free as
 * well), as the sentence the store refuses with; null when it fits. The store asks it before every copy, and the page
 * before it downloads the site's model (App.tsx), so neither starts what the storage cannot hold.
 */
export function roomRefusal(bytes: number, room: { used: number; quota: number }, rest = false): string | null {
  const free = Math.max(0, room.quota - room.used)
  if (free >= bytes + SPARE_BYTES) return null
  // `rest`: a download that goes on from a part counts only what is still to come (the part's bytes are in `used`).
  return `${rest ? 'the rest of this model' : 'this model'} needs ${size(bytes, true)} and this page's storage has ${size(free, false)} free (64 MB is kept spare as well): free some space in this browser, or choose a smaller model`
}

/** The model's name to show: the first file's name without the shard number. */
const displayName = (first: string): string => first.replace(/-\d{5}-of-\d{5}(?=\.gguf$)/, '')

/** A directory name from the model's name and the time it was kept, unique among `taken`. */
function newId(name: string, keptAt: number, taken: ReadonlySet<string>): string {
  const slug = name.replace(/\.gguf$/i, '').toLowerCase().replace(/[^a-z0-9._]+/g, '-').slice(0, 48).replace(/^[-._]+|[-._]+$/g, '') || 'model'
  const base = `${slug}-${Math.max(0, Math.floor(keptAt)).toString(36)}`
  let id = base
  for (let k = 2; taken.has(id); k++) id = `${base}-${k}`
  return id
}

const sameFiles = (a: readonly KeptFile[], b: readonly KeptFile[]): boolean =>
  a.length === b.length && a.every((f, i) => f.name === b[i].name && f.bytes === b[i].bytes)

/** Why the page cannot keep files, from the error its storage gave. */
function storageReason(e: unknown): string {
  if (named(e, 'SecurityError')) return 'the browser keeps no files for this page (a page opened from a file, or a private window)'
  if (named(e, 'QuotaExceededError')) return "this page's storage is full"
  if (named(e, 'NotSupportedError')) return NO_STORAGE
  return `the browser's storage refused this page (${said(e)})`
}

/** A failed copy as the console says it. */
function copyFailure(e: unknown): CognitionError {
  if (e instanceof CognitionError) return e
  if (named(e, 'QuotaExceededError')) return new CognitionError('model', "this page's storage ran out of room while the model was copied: free some space in this browser, or choose a smaller model")
  if (named(e, 'NotReadableError')) return new CognitionError('model', 'the chosen file could not be read while it was copied (it may have been moved or changed): choose it again')
  return new CognitionError('model', `the model could not be copied into this page's storage (${said(e)})`)
}

/** Why a download cannot open its part: another tab of the city is writing it now. */
export const ANOTHER_TAB = 'another tab of the city is downloading this model into the page just now: wait for it to finish there'
/** Why a download does not start: another tab of the city kept the model since this one looked (the next try chooses it). */
export const KEPT_ELSEWHERE = 'another tab of the city has just kept this model in the page: try again to choose it'

/** A download's storage failure as the card says it (the part keeps what was noted last, to be picked up). */
function partFailure(e: unknown): CognitionError {
  if (e instanceof CognitionError) return e
  if (named(e, 'QuotaExceededError')) return new CognitionError('model', "this page's storage ran out of room while the model downloaded into it: free some space in this browser, and try again")
  if (named(e, 'NoModificationAllowedError')) return new CognitionError('model', ANOTHER_TAB)
  // The worker found a meta.json where it was to open the part (modelStore.worker.ts openFor): a kept model's directory.
  if (named(e, 'InvalidModificationError')) return new CognitionError('model', KEPT_ELSEWHERE)
  return new CognitionError('model', `the model could not be written into this page's storage (${said(e)})`)
}

/** A file refused before any copy. */
const refused = (f: File, reason: string): CognitionError => new CognitionError('model', `${f.name} was not kept: ${reason}`)

/** What meta.json holds: the model as kept, v 1. */
const metaOf = (m: KeptModel): string => JSON.stringify({ id: m.id, name: m.name, files: m.files, bytes: m.bytes, keptAt: m.keptAt, v: 1 })

/** The model a meta.json describes, kept in directory `id`; null when the text is not one this page wrote. */
function parseMeta(id: string, text: string): KeptModel | null {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof o !== 'object' || o === null) return null
  const m = o as Record<string, unknown>
  if (m.v !== 1 || typeof m.name !== 'string' || typeof m.keptAt !== 'number' || !Array.isArray(m.files) || m.files.length === 0) return null
  const files: KeptFile[] = []
  for (const f of m.files as unknown[]) {
    const { name, bytes, stored } = (typeof f === 'object' && f !== null ? f : {}) as Record<string, unknown>
    if (typeof name !== 'string' || name === '' || name === META || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) return null
    if (stored !== undefined && (typeof stored !== 'string' || stored === '' || stored === META || stored === PART_NOTE)) return null
    files.push(stored === undefined ? { name, bytes } : { name, bytes, stored })
  }
  const bytes = files.reduce((n, f) => n + f.bytes, 0)
  if (m.bytes !== bytes) return null
  return { id, name: m.name, files, bytes, keptAt: m.keptAt, durable: true }
}

/**
 * The model directory `dir` holds, from its meta.json; null when it has none or one this page did not write (a copy
 * cut short). Throws when the file is there but cannot be read now (another tab may be writing it).
 */
async function readMeta(id: string, dir: FileSystemDirectoryHandle): Promise<KeptModel | null> {
  let text: string
  try {
    text = await (await (await dir.getFileHandle(META)).getFile()).text()
  } catch (e) {
    if (named(e, 'NotFoundError') || named(e, 'TypeMismatchError')) return null
    throw e
  }
  return parseMeta(id, text)
}

/** The part note directory `dir` holds, or null (none, unreadable, or not one this page wrote). */
async function readNote(dir: FileSystemDirectoryHandle): Promise<PartNote | null> {
  try {
    return parseNote(await (await (await dir.getFileHandle(PART_NOTE)).getFile()).text())
  } catch {
    return null
  }
}

/** The size of file `name` in `dir`, or -1 when it is not there or cannot be read. */
async function sizeOf(dir: FileSystemDirectoryHandle, name: string): Promise<number> {
  try {
    return (await (await dir.getFileHandle(name)).getFile()).size
  } catch {
    return -1
  }
}

/**
 * Reads every file's header and puts the files in load order: shardOrder by their names, then each header must be a
 * GGUF that textModel takes (the first shard speaks for the model; a later one passes on its version), and its split
 * keys must agree with the files chosen (as many parts as files, each the part its name says). Refuses with
 * CognitionError('model', reason).
 */
async function checked(files: readonly File[]): Promise<File[]> {
  const order = shardOrder(files.map((f) => f.name))
  if (!order.ok) throw new CognitionError('model', order.reason)
  const ordered = order.order.map((i) => files[i])
  for (const [i, f] of ordered.entries()) {
    if (f.name === META) throw refused(f, `its name is the one this page keeps its own notes under: rename the file and choose it again`)
    let h: GgufHeader
    try {
      h = await readGgufHeader(blobReader(f), f.size)
    } catch (e) {
      throw refused(f, e instanceof GgufError ? e.reason : said(e))
    }
    const text = textModel(h, f.name)
    if (!text.ok) throw refused(f, text.reason)
    const count = h.split?.count ?? 1
    const no = h.split?.no ?? 0
    if (count !== ordered.length) {
      if (ordered.length === 1) throw refused(f, `it is part ${no + 1} of a model split into ${count} parts: choose all ${count} parts together`)
      if (h.split === undefined) throw refused(f, `it is a whole model, not one of the ${ordered.length} parts chosen (its header names no split)`)
      throw refused(f, `its header says the model has ${count} parts, and ${ordered.length} were chosen`)
    }
    if (no !== i) throw refused(f, `its name says it is part ${i + 1} and its header says part ${no + 1}`)
  }
  return ordered
}

/** The models directory's entry names, to give a new model a name of its own. */
async function names(dir: FileSystemDirectoryHandle): Promise<Set<string>> {
  const out = new Set<string>()
  for await (const name of dir.keys()) out.add(name)
  return out
}

/**
 * The model store over the page's storage (navigator.storage unless `d` hands it another). The copy defaults to the
 * page's own writable stream; the product passes workerCopy.
 */
export function createModelStore(d: StoreDeps = {}): ModelStore & PartStore {
  const nav = (globalThis as { navigator?: { storage?: StorageLike; locks?: LockManagerLike } }).navigator
  const storage = nav?.storage
  const directory = d.directory ?? (() => {
    const get = storage?.getDirectory
    return typeof get === 'function' ? get.call(storage) : Promise.reject(new DOMException(NO_STORAGE, 'NotSupportedError'))
  })
  const estimate = d.estimate ?? (typeof storage?.estimate === 'function' ? storage.estimate.bind(storage) : undefined)
  const persist = d.persist ?? (typeof storage?.persist === 'function' ? storage.persist.bind(storage) : undefined)
  const copy = d.copy ?? writableCopy
  const locks = d.locks ?? (typeof nav?.locks?.request === 'function' ? nav.locks : undefined)
  const now = d.now ?? Date.now
  const partLink = d.part
  const wanted = d.parts ?? []

  /** The models held for this visit only (the browser kept no files for the page), by id. */
  const visit = new Map<string, { model: KeptModel; files: readonly File[] }>()
  /** Why the page's storage could not be used, while that is what the storage row says; null when it keeps files. */
  let reason: string | null = null
  /** The copy or download in progress: its directory (never swept or forgotten meanwhile) and how far it has got. */
  let copying: { id: string; done: number; total: number; download?: boolean } | null = null
  /** A keep or a download is running (one at a time). */
  let busy = false

  /** The lock a copy holds on its directory from before it is made until the commit (Web Locks name it per origin). */
  const lockName = (id: string): string => `${MODELS_DIR}/${id}`

  /** Runs `fn` holding the lock on directory `id`; as it is where the browser has no Web Locks. */
  function holding<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return locks ? locks.request(lockName(id), {}, fn) : fn()
  }

  /**
   * Takes the lock on directory `id` if it is free, for as long as a download writes there: resolves with the call
   * that lets it go, or null when another tab holds it. Where the browser has no Web Locks, there is nothing to take.
   */
  function lockIfFree(id: string): Promise<(() => void) | null> {
    if (!locks) return Promise.resolve(() => undefined)
    return new Promise((granted, failed) => {
      locks.request(lockName(id), { ifAvailable: true }, (lock) => {
        if (lock === null) {
          granted(null)
          return Promise.resolve()
        }
        return new Promise<void>((letGo) => granted(letGo))
      }).catch(failed)
    })
  }

  /**
   * Runs `fn` holding the lock on directory `id`, unless a copy holds it now (another tab of the city keeping a model
   * there, with no meta.json yet), in which case nothing is done. Runs it as it is where the browser has no Web Locks.
   */
  async function unlessCopying(id: string, fn: () => Promise<void>): Promise<void> {
    if (!locks) return fn()
    await locks.request(lockName(id), { ifAvailable: true }, async (lock) => {
      if (lock !== null) await fn()
    })
  }

  /** agent-city-models/ under the storage's root; notes why when the storage cannot be used. */
  async function modelsDir(): Promise<FileSystemDirectoryHandle> {
    try {
      const dir = await (await directory()).getDirectoryHandle(MODELS_DIR, { create: true })
      if (visit.size === 0) reason = null
      return dir
    } catch (e) {
      reason = storageReason(e)
      throw e
    }
  }

  /**
   * The part directory `dir` holds that the page may pick up for one of `pins` now, or null: a resumable note
   * (modelPart.ts) whose part file is at least as long as the note says.
   */
  async function partIn(dir: FileSystemDirectoryHandle, pins: readonly PartPin[]): Promise<PartNote | null> {
    const note = await readNote(dir)
    const pin = note === null ? undefined : pins.find((p) => forPin(note, p))
    if (note === null || pin === undefined || !resumable(note, pin, now())) return null
    return (await sizeOf(dir, partName(pin.file))) >= note.at ? note : null
  }

  /** The kept models in the page's storage; sweeps each entry that is not one (a copy cut short, a stray file, a part
   *  the page will not pick up), leaving one part per pin to be picked up: the one that has come furthest. */
  async function durableModels(): Promise<KeptModel[]> {
    const models = await modelsDir()
    const found: KeptModel[] = []
    const cut: [string, FileSystemDirectoryHandle | FileSystemFileHandle][] = []
    const parts = new Map<string, { name: string; h: FileSystemDirectoryHandle; at: number }>()
    for await (const [name, h] of models.entries()) {
      if (name === copying?.id) continue
      if (h.kind !== 'directory') {
        cut.push([name, h])
        continue
      }
      try {
        const m = await readMeta(name, h)
        if (m) {
          found.push(m)
          continue
        }
        const note = await partIn(h, wanted)
        if (note === null) {
          cut.push([name, h])
          continue
        }
        const key = `${note.file}\n${note.sha256}`
        const best = parts.get(key)
        if (best === undefined || note.at > best.at) {
          if (best) cut.push([best.name, best.h])
          parts.set(key, { name, h, at: note.at })
        } else cut.push([name, h])
      } catch {
        // There but not readable now: left for a later look.
      }
    }
    // Removed after the walk, which a removal would disturb, each under its lock and only if it is still not a model:
    // a copy another tab of the city is making holds the lock, and one that committed since the walk is a model now.
    // One still held open is swept by a later list().
    for (const [name, h] of cut) {
      await unlessCopying(name, async () => {
        if (!(await isModel(name, h))) await models.removeEntry(name, { recursive: true })
      }).catch(() => undefined)
    }
    return found
  }

  /** A model already kept with these files, still whole; a copy that has lost a file is forgotten instead. */
  async function alreadyKept(name: string, files: readonly KeptFile[]): Promise<KeptModel | null> {
    for (const m of await list()) {
      if (!m.durable || m.name !== name || !sameFiles(m.files, files)) continue
      try {
        await open(m.id)
        return m
      } catch {
        await forget(m.id).catch(() => 0)
      }
    }
    return null
  }

  /** Throws CognitionError('model') when the browser says there is no room for `bytes` and SPARE_BYTES; passes when it does not say. */
  async function roomFor(bytes: number): Promise<void> {
    if (!estimate) return
    let e: { usage?: number; quota?: number }
    try {
      e = await estimate()
    } catch {
      return
    }
    if (typeof e.quota !== 'number' || !Number.isFinite(e.quota)) return
    const no = roomRefusal(bytes, { used: typeof e.usage === 'number' && Number.isFinite(e.usage) ? e.usage : 0, quota: e.quota })
    if (no !== null) throw new CognitionError('model', no)
  }

  async function keepNow(files: readonly File[], onProgress: ((done: number, total: number) => void) | undefined, signal: AbortSignal | undefined): Promise<KeptModel> {
    signal?.throwIfAborted()
    const ordered = await checked(files)
    signal?.throwIfAborted()
    const kept: KeptFile[] = ordered.map((f) => ({ name: f.name, bytes: f.size }))
    const bytes = kept.reduce((n, f) => n + f.bytes, 0)
    const name = displayName(ordered[0].name)

    const same = await alreadyKept(name, kept)
    if (same) {
      onProgress?.(bytes, bytes)
      return same
    }
    let models: FileSystemDirectoryHandle
    try {
      models = await modelsDir()
    } catch {
      // The browser keeps no files for this page: the picked files serve this visit (the storage row says why).
      for (const [id, v] of visit) if (v.model.name === name && sameFiles(v.model.files, kept)) visit.delete(id)
      const keptAt = now()
      const model: KeptModel = { id: newId(name, keptAt, new Set(visit.keys())), name, files: kept, bytes, keptAt, durable: false }
      visit.set(model.id, { model, files: ordered })
      onProgress?.(bytes, bytes)
      return model
    }
    await roomFor(bytes)
    signal?.throwIfAborted()

    const keptAt = now()
    const id = newId(name, keptAt, new Set([...(await names(models)), ...visit.keys()]))
    const model: KeptModel = { id, name, files: kept, bytes, keptAt, durable: true }
    const state = { id, done: 0, total: bytes }
    copying = state
    const progress = (done: number): void => {
      if (done <= state.done && done !== 0) return
      state.done = done
      onProgress?.(done, bytes)
    }
    progress(0)
    try {
      // The directory's lock, held from before it is made until the commit, says to every other tab of the city that
      // this is a copy in progress, not one cut short: their list() and forget() leave it alone.
      await holding(id, async () => {
        const dir = await models.getDirectoryHandle(id, { create: true })
        let base = 0
        for (const f of ordered) {
          await copy(dir, f.name, f, (n) => progress(base + Math.min(n, f.size)), signal)
          base += f.size
          signal?.throwIfAborted()
        }
        // The commit: until this file is in, the directory is a copy cut short.
        await copy(dir, META, new File([metaOf(model)], META, { type: 'application/json' }), () => undefined, signal)
      })
    } catch (e) {
      copying = null
      // A file the worker still holds cannot be removed yet; the next list() sweeps what is left.
      await models.removeEntry(id, { recursive: true }).catch(() => undefined)
      if (signal?.aborted) throw signal.reason
      throw copyFailure(e)
    }
    copying = null
    reason = null
    // Asks the browser not to clear the page's storage under pressure; it may say no, and the copy stands either way.
    // Not waited for: Firefox asks the operator, and a prompt left unanswered would hold this keep and refuse the next.
    try {
      void persist?.().catch(() => false)
    } catch {
      // Refused at once: the copy stands.
    }
    return model
  }

  async function list(): Promise<KeptModel[]> {
    let kept: KeptModel[] = []
    try {
      kept = await durableModels()
    } catch {
      // The storage cannot be read: this visit's models alone.
    }
    return [...kept, ...[...visit.values()].map((v) => v.model)].sort((a, b) => b.keptAt - a.keptAt)
  }

  async function open(id: string): Promise<readonly File[]> {
    const held = visit.get(id)
    if (held) return held.files
    let models: FileSystemDirectoryHandle
    try {
      models = await modelsDir()
    } catch (e) {
      throw new CognitionError('offline', `the kept model cannot be read: ${storageReason(e)}`)
    }
    let dir: FileSystemDirectoryHandle
    let meta: KeptModel | null
    try {
      dir = await models.getDirectoryHandle(id)
      meta = await readMeta(id, dir)
    } catch {
      throw new CognitionError('offline', GONE)
    }
    if (meta === null) throw new CognitionError('offline', GONE)
    const out: File[] = []
    for (const k of meta.files) {
      let f: File
      try {
        f = await (await dir.getFileHandle(k.stored ?? k.name)).getFile()
      } catch {
        throw new CognitionError('offline', GONE)
      }
      if (f.size !== k.bytes) throw new CognitionError('offline', GONE)
      out.push(f.name === k.name ? f : new File([f], k.name, { type: f.type, lastModified: f.lastModified }))
    }
    return out
  }

  /** Removes entry `name` of the models directory; false when it was not there. */
  async function remove(models: FileSystemDirectoryHandle, name: string): Promise<boolean> {
    try {
      await models.removeEntry(name, { recursive: true })
      return true
    } catch (e) {
      if (named(e, 'NotFoundError')) return false
      throw new CognitionError('model', `the kept model could not be removed from this page's storage (${said(e)})`)
    }
  }

  /** Whether entry `h` is a kept model (a directory with a readable meta.json, or one there but busy). */
  async function isModel(name: string, h: FileSystemDirectoryHandle | FileSystemFileHandle): Promise<boolean> {
    if (h.kind !== 'directory') return false
    try {
      return (await readMeta(name, h)) !== null
    } catch {
      return true
    }
  }

  async function forget(id?: string): Promise<number> {
    if (id !== undefined) {
      if (visit.delete(id)) return 1
      if (id === copying?.id) return 0
      let models: FileSystemDirectoryHandle
      let h: FileSystemDirectoryHandle
      try {
        models = await modelsDir()
        h = await models.getDirectoryHandle(id)
      } catch {
        return 0
      }
      const was = await isModel(id, h)
      return (await remove(models, id)) && was ? 1 : 0
    }
    let n = visit.size
    visit.clear()
    let models: FileSystemDirectoryHandle
    try {
      models = await modelsDir()
    } catch {
      return n
    }
    const entries: [string, FileSystemDirectoryHandle | FileSystemFileHandle][] = []
    for await (const e of models.entries()) if (e[0] !== copying?.id) entries.push(e)
    for (const [name, h] of entries) {
      // A copy another tab of the city is making holds its lock and is left to it; everything else goes.
      await unlessCopying(name, async () => {
        const was = await isModel(name, h)
        if ((await remove(models, name)) && was) n++
      })
    }
    return n
  }

  async function forgetParts(file: string): Promise<number> {
    let models: FileSystemDirectoryHandle
    try {
      models = await modelsDir()
    } catch {
      return 0
    }
    const entries: [string, FileSystemDirectoryHandle][] = []
    for await (const [name, h] of models.entries()) if (h.kind === 'directory' && name !== copying?.id) entries.push([name, h])
    let n = 0
    for (const [name, h] of entries) {
      // Under its lock, as forget() removes: a download another tab is making is left to it.
      // One the browser will not let go of yet stays (it is picked up, or swept once it is stale).
      await unlessCopying(name, async () => {
        if ((await isModel(name, h)) || (await readNote(h))?.file !== file) return
        if (await remove(models, name)) n++
      }).catch(() => undefined)
    }
    return n
  }

  /**
   * The directory under `models` holding the part to pick up for `pin` (the one that has come furthest), or null; and
   * whether a model of the pin's name and size is kept there already (as the page looks for it: App.tsx keptSite).
   */
  async function findPart(models: FileSystemDirectoryHandle, pin: PartPin): Promise<{ part: { id: string; at: number } | null; kept: boolean }> {
    let best: { id: string; at: number } | null = null
    let kept = false
    for await (const [name, h] of models.entries()) {
      if (h.kind !== 'directory' || name === copying?.id) continue
      try {
        const m = await readMeta(name, h)
        if (m !== null) {
          kept ||= m.name === displayName(pin.file) && m.bytes === pin.bytes
          continue
        }
      } catch {
        continue
      }
      const note = await partIn(h, [pin])
      if (note !== null && (best === null || note.at > best.at)) best = { id: name, at: note.at }
    }
    return { part: best, kept }
  }

  /** Removes directory `id`, trying again briefly while a worker that has just ended still holds a file of it. */
  async function removeSoon(models: FileSystemDirectoryHandle, id: string): Promise<void> {
    for (let k = 0; ; k++) {
      try {
        await models.removeEntry(id, { recursive: true })
        return
      } catch (e) {
        if (named(e, 'NotFoundError')) return
        if (k >= 4) throw e
        await new Promise((r) => setTimeout(r, 50 * (k + 1)))
      }
    }
  }

  async function openPart(pin: PartPin): Promise<PartSession | null> {
    if (!partLink) return null
    if (busy) throw new CognitionError('model', 'another model file is being copied into this page: wait for it to finish')
    let models: FileSystemDirectoryHandle
    try {
      models = await modelsDir()
    } catch {
      // The browser keeps no files for this page: the page downloads as it did before (and keeps it for this visit).
      return null
    }
    busy = true
    let letGo: () => void = () => undefined
    let id: string | null = null
    let made = false
    let ended = false
    const finish = (): void => {
      if (ended) return
      ended = true
      if (copying?.id === id) copying = null
      busy = false
      letGo()
    }
    try {
      // The pin's own lock first, held as long as the directory's: a fresh download in another tab has no note until
      // its first bytes come (and none it may pick up without a validator), so its directory alone would not say that
      // a download of this model is under way, and both tabs would download it and keep it twice.
      const pinLock = await lockIfFree(`part:${pin.sha256}`)
      if (pinLock === null) throw new CognitionError('model', ANOTHER_TAB)
      letGo = pinLock
      const look = await findPart(models, pin)
      // Kept by another tab since this one looked (its download held the pin's lock until its meta.json was in).
      if (look.kept) throw new CognitionError('model', KEPT_ELSEWHERE)
      const found = look.part
      id = found?.id ?? newId(displayName(pin.file), now(), new Set([...(await names(models)), ...visit.keys()]))
      const lock = await lockIfFree(id)
      if (lock === null) throw new CognitionError('model', ANOTHER_TAB)
      letGo = () => {
        lock()
        pinLock()
      }
      made = found === null
      if (found !== null) {
        // Looked at again under the directory's lock, which findPart did not hold: a tab that took no pin's lock (a
        // build before it) may have kept this part as a model since, and a kept model's file is never written as a
        // part. One swept since is made afresh here, and the worker finds nothing in it to pick up.
        const h = await models.getDirectoryHandle(id).catch(() => null)
        if (h !== null && (await isModel(id, h))) throw new CognitionError('model', KEPT_ELSEWHERE)
        made = h === null
      }
      await models.getDirectoryHandle(id, { create: true })
      const state = { id, done: found?.at ?? 0, total: pin.bytes, download: true }
      copying = state
      const link = await partLink([MODELS_DIR, id], pin)
      if (link === null) {
        if (made) await removeSoon(models, id).catch(() => undefined)
        finish()
        return null
      }
      state.done = link.at
      const dir = id
      return Object.freeze<PartSession>({
        id: dir,
        at: link.at,
        validator: link.validator,
        begin(at, validator) {
          link.begin(at, validator)
          state.done = at
        },
        async put(bytes) {
          const n = bytes.byteLength
          try {
            await link.put(bytes)
          } catch (e) {
            finish()
            throw partFailure(e)
          }
          state.done += n
        },
        async hold() {
          try {
            return await link.hold()
          } catch (e) {
            throw partFailure(e)
          } finally {
            finish()
          }
        },
        async end() {
          try {
            return await link.end()
          } catch (e) {
            finish()
            throw partFailure(e)
          }
        },
        async discard() {
          // The worker closes its files first (a hold), so the directory can go at once.
          if (!ended) await link.hold().catch(() => 0)
          link.stop()
          try {
            await removeSoon(models, dir)
          } finally {
            finish()
          }
        },
        release() {
          link.stop()
          finish()
        },
      })
    } catch (e) {
      if (made && id !== null) await removeSoon(models, id).catch(() => undefined)
      finish()
      throw partFailure(e)
    }
  }

  async function commitPart(session: PartSession, pin: PartPin, onProgress?: (done: number, total: number) => void): Promise<KeptModel> {
    let models: FileSystemDirectoryHandle | null = null
    try {
      models = await modelsDir()
      const dir = await models.getDirectoryHandle(session.id)
      onProgress?.(0, pin.bytes)
      const part = await dir.getFileHandle(partName(pin.file))
      const file = await part.getFile()
      if (file.size !== pin.bytes) throw new CognitionError('model', `the downloaded ${pin.file} holds ${file.size} of its ${pin.bytes} bytes, so it was not kept`)
      // The header read as a picked file's is: the pin's hash says which file it is, this says the page can use it.
      await checked([new File([file], pin.file, { type: 'application/octet-stream' })])
      // Renamed to the model's own name where the browser can (FileSystemHandle.move); else meta.json says where it is.
      const movable = part as FileSystemFileHandle & { move?: (name: string) => Promise<void> }
      let stored: string | undefined = partName(pin.file)
      if (typeof movable.move === 'function') {
        await movable.move(pin.file)
        stored = undefined
      }
      const model: KeptModel = {
        id: session.id,
        name: displayName(pin.file),
        files: [stored === undefined ? { name: pin.file, bytes: pin.bytes } : { name: pin.file, bytes: pin.bytes, stored }],
        bytes: pin.bytes,
        keptAt: now(),
        durable: true,
      }
      // The commit: meta.json last, as a copy's; the note goes after it (a model's directory with a stray note is a model).
      await copy(dir, META, new File([metaOf(model)], META, { type: 'application/json' }), () => undefined)
      await dir.removeEntry(PART_NOTE).catch(() => undefined)
      onProgress?.(pin.bytes, pin.bytes)
      reason = null
      try {
        void persist?.().catch(() => false)
      } catch {
        // Refused at once: the model stands.
      }
      return model
    } catch (e) {
      // Not kept: the part goes with it, so nothing half-checked is picked up later.
      if (models !== null) await removeSoon(models, session.id).catch(() => undefined)
      throw copyFailure(e)
    } finally {
      session.release()
    }
  }

  async function part(pin: PartPin): Promise<{ id: string; at: number } | null> {
    try {
      return (await findPart(await modelsDir(), pin)).part
    } catch {
      return null
    }
  }

  return {
    part,
    openPart,
    commitPart,
    async keep(files, onProgress, signal) {
      if (busy) throw new CognitionError('model', 'another model file is being copied into this page: wait for it to finish')
      busy = true
      try {
        return await keepNow(files, onProgress, signal)
      } finally {
        busy = false
        copying = null
      }
    },
    list,
    open,
    forget,
    forgetParts,
    async usage() {
      if (!estimate) return null
      try {
        const e = await estimate()
        if (typeof e.quota !== 'number' || !Number.isFinite(e.quota)) return null
        return { used: typeof e.usage === 'number' && Number.isFinite(e.usage) ? e.usage : 0, quota: e.quota }
      } catch {
        return null
      }
    },
    storageLine() {
      if (copying) return `${copying.download ? 'downloading' : 'copying'} ${Math.floor((copying.done / Math.max(1, copying.total)) * 100)}%`
      if (reason !== null) return `this visit only: ${reason}`
      return 'kept in this page'
    },
  }
}
