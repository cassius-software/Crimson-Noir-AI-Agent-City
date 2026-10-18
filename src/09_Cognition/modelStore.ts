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
 * console says to choose it again. Everything the browser provides is injected (StoreDeps), so the Node tests drive
 * it with an in-memory directory; this file never imports the worker (a bundler-only import).
 * What breaks if it is removed? The in-page model must be picked again on every visit, a multi-gigabyte copy has no
 * progress, no room check and no commit, and a file that is not a model is found out only when llama.cpp fails on it.
 */
import { GgufError, blobReader, readGgufHeader, shardOrder, textModel, type GgufHeader } from './gguf.ts'
import { CognitionError, sentence } from './localCompute.ts'

/** One file of a kept model: its name as kept and its size. */
export interface KeptFile { readonly name: string; readonly bytes: number }

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
  forget(id?: string): Promise<number>   // how many models removed
  usage(): Promise<{ used: number; quota: number } | null>
  storageLine(): string                  // "kept in this page" | "copying 42%" | "this visit only: <reason>"
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
    const { name, bytes } = (typeof f === 'object' && f !== null ? f : {}) as Record<string, unknown>
    if (typeof name !== 'string' || name === '' || name === META || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) return null
    files.push({ name, bytes })
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
export function createModelStore(d: StoreDeps = {}): ModelStore {
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

  /** The models held for this visit only (the browser kept no files for the page), by id. */
  const visit = new Map<string, { model: KeptModel; files: readonly File[] }>()
  /** Why the page's storage could not be used, while that is what the storage row says; null when it keeps files. */
  let reason: string | null = null
  /** The copy in progress: its directory (never swept or forgotten meanwhile) and how far it has got. */
  let copying: { id: string; done: number; total: number } | null = null
  /** A keep is running (one at a time). */
  let busy = false

  /** The lock a copy holds on its directory from before it is made until the commit (Web Locks name it per origin). */
  const lockName = (id: string): string => `${MODELS_DIR}/${id}`

  /** Runs `fn` holding the lock on directory `id`; as it is where the browser has no Web Locks. */
  function holding<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return locks ? locks.request(lockName(id), {}, fn) : fn()
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

  /** The kept models in the page's storage; sweeps each entry that is not one (a copy cut short, a stray file). */
  async function durableModels(): Promise<KeptModel[]> {
    const models = await modelsDir()
    const found: KeptModel[] = []
    const cut: [string, FileSystemDirectoryHandle | FileSystemFileHandle][] = []
    for await (const [name, h] of models.entries()) {
      if (name === copying?.id) continue
      if (h.kind !== 'directory') {
        cut.push([name, h])
        continue
      }
      try {
        const m = await readMeta(name, h)
        if (m) found.push(m)
        else cut.push([name, h])
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
    const free = Math.max(0, e.quota - (typeof e.usage === 'number' && Number.isFinite(e.usage) ? e.usage : 0))
    if (free < bytes + SPARE_BYTES) {
      throw new CognitionError('model', `this model needs ${size(bytes, true)} and this page's storage has ${size(free, false)} free (64 MB is kept spare as well): free some space in this browser, or choose a smaller model`)
    }
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
        f = await (await dir.getFileHandle(k.name)).getFile()
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

  return {
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
      if (copying) return `copying ${Math.floor((copying.done / Math.max(1, copying.total)) * 100)}%`
      if (reason !== null) return `this visit only: ${reason}`
      return 'kept in this page'
    },
  }
}
