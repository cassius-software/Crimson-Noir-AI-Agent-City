// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for keeping a model in the page (modelStore.ts and its worker), over an
 * in-memory directory that behaves as the origin private file system does where it matters (handles made on demand,
 * NotFoundError, entries, recursive removal, and a file held by a sync access handle refusing removal), with the real
 * tiny GGUF the browser smoke test loads (tools/browser/tinyGguf.mjs):
 * - the product's copy end to end: workerCopy and a stand-in Worker running modelStore.worker.ts itself, 8 MiB writes
 *   at their offsets, the file cut to size, flushed and closed before done, progress after every write;
 * - the commit: every model file, then meta.json last, then persist (asked, never waited for); the model listed, and
 *   opened in load order;
 * - shards picked in any order kept in load order under their own names, shown without the shard number;
 * - refusals before any copy or directory: not a GGUF, an embedding model (by its header, by its name), half a split
 *   model, a header that disagrees with the names;
 * - the room check with both sizes; the visit-only fallback and its storage row; an abort mid-copy leaving no meta,
 *   and the sweep of what it left even when a held file delays the removal; a copy in progress never swept, nor
 *   forgotten, by this tab or another (its Web Lock), and one that commits as another tab looks kept; forget one and
 *   all; a kept file the browser cleared; the same model picked twice; the worker's own failures;
 * - and that no model is ever committed: *.gguf is ignored, and no tracked file starts with the GGUF magic.
 * What breaks if it is removed? A copy that commits before its files are in, sweeps a copy in progress, takes a picture
 * or half a model into the page's storage, or a model file in a commit, could ship unnoticed.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CognitionError } from './localCompute.ts'
import { GONE, META, MODELS_DIR, SPARE_BYTES, createModelStore, workerCopy, writableCopy } from './modelStore.ts'
import type { CopyFile, CopyReply, CopyRequest, LockManagerLike, StoreDeps } from './modelStore.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const MIB = 2 ** 20

// The writer is plain JavaScript (tools/ carries no types); a computed specifier keeps the page's typecheck off it.
const WRITER: string = '../../tools/browser/tinyGguf.mjs'
type Kv = readonly [string, number, unknown, number?]
const { tinyGgufFiles, ggufBytes, GGUF_TYPE: T } = (await import(WRITER)) as {
  tinyGgufFiles(o?: { letter?: string; split?: boolean }): { name: string; bytes: Uint8Array<ArrayBuffer> }[]
  ggufBytes(kvs: readonly Kv[], tensors?: readonly { name: string; dims: number[]; data: Float32Array }[]): Uint8Array<ArrayBuffer>
  GGUF_TYPE: Readonly<Record<'U32' | 'STRING', number>>
}

/** The tiny model's files as the operator would pick them. */
const tiny = (letter = 'a', split = false): File[] => tinyGgufFiles({ letter, split }).map((f) => new File([f.bytes], f.name))

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
const bytesOf = async (b: Blob): Promise<Uint8Array> => new Uint8Array(await b.arrayBuffer())
const domError = (name: string, message: string): DOMException => new DOMException(message, name)

/** A file of the fake storage: its bytes, whether a handle holds it, and what each sync access handle did to it. */
class FakeFile {
  readonly kind = 'file'
  readonly name: string
  data: Uint8Array<ArrayBuffer> = new Uint8Array(0)
  /** Held by an open sync access handle (or a worker that has not let go yet): removal is refused, as a browser refuses it. */
  held = false
  /** Every write takes this many bytes fewer than it was given (a full disk). */
  shortBy = 0
  /** The name getFile() gives, when a test makes it differ from the handle's. */
  fileName: string | null = null
  /** The File the last getFile() gave. */
  last: File | null = null
  readonly calls: string[] = []
  constructor(name: string) {
    this.name = name
  }

  async getFile(): Promise<File> {
    this.last = new File([this.data.slice()], this.fileName ?? this.name, { lastModified: 1 })
    return this.last
  }

  async createSyncAccessHandle(): Promise<{ write(b: Uint8Array, o: { at: number }): number; truncate(n: number): void; flush(): void; close(): void }> {
    if (this.held) throw domError('NoModificationAllowedError', `${this.name} is held by another handle`)
    this.held = true
    return {
      write: (b, o) => {
        const n = Math.max(0, b.length - this.shortBy)
        const end = o.at + n
        if (end > this.data.length) this.data = concat(this.data, new Uint8Array(end - this.data.length))
        this.data.set(b.subarray(0, n), o.at)
        this.calls.push(`write ${o.at}+${n}`)
        return n
      },
      truncate: (n) => {
        this.data = n <= this.data.length ? this.data.slice(0, n) : concat(this.data, new Uint8Array(n - this.data.length))
        this.calls.push(`truncate ${n}`)
      },
      flush: () => { this.calls.push('flush') },
      close: () => { this.held = false; this.calls.push('close') },
    }
  }

  async createWritable(): Promise<WritableStream<Uint8Array>> {
    const parts: Uint8Array[] = []
    return new WritableStream<Uint8Array>({ write: (c) => { parts.push(c.slice()) }, close: () => { this.data = concat(...parts) } })
  }
}

/** A directory of the fake storage. */
class FakeDir {
  readonly kind = 'directory'
  readonly name: string
  readonly children = new Map<string, FakeDir | FakeFile>()
  constructor(name: string) {
    this.name = name
  }

  async getDirectoryHandle(name: string, o: { create?: boolean } = {}): Promise<FakeDir> {
    const c = this.children.get(name)
    if (c instanceof FakeDir) return c
    if (c) throw domError('TypeMismatchError', `${name} is a file`)
    if (!o.create) throw domError('NotFoundError', `no directory ${name}`)
    const d = new FakeDir(name)
    this.children.set(name, d)
    return d
  }

  async getFileHandle(name: string, o: { create?: boolean } = {}): Promise<FakeFile> {
    const c = this.children.get(name)
    if (c instanceof FakeFile) return c
    if (c) throw domError('TypeMismatchError', `${name} is a directory`)
    if (!o.create) throw domError('NotFoundError', `no file ${name}`)
    const f = new FakeFile(name)
    this.children.set(name, f)
    return f
  }

  async removeEntry(name: string, o: { recursive?: boolean } = {}): Promise<void> {
    const c = this.children.get(name)
    if (!c) throw domError('NotFoundError', `no entry ${name}`)
    if (c instanceof FakeDir && c.children.size > 0 && !o.recursive) throw domError('InvalidModificationError', `${name} is not empty`)
    if (held(c)) throw domError('NoModificationAllowedError', `${name} is held open`)
    this.children.delete(name)
  }

  async *entries(): AsyncGenerator<[string, FakeDir | FakeFile]> { yield* [...this.children] }
  async *keys(): AsyncGenerator<string> { yield* [...this.children.keys()] }
  async *values(): AsyncGenerator<FakeDir | FakeFile> { yield* [...this.children.values()] }

  dir(name: string): FakeDir {
    const c = this.children.get(name)
    assert.ok(c instanceof FakeDir, `${name} is a directory of ${this.name || 'the root'}`)
    return c
  }

  file(name: string): FakeFile {
    const c = this.children.get(name)
    assert.ok(c instanceof FakeFile, `${name} is a file of ${this.name}`)
    return c
  }
}

const held = (n: FakeDir | FakeFile): boolean => (n instanceof FakeFile ? n.held : [...n.children.values()].some(held))
const asDir = (d: FakeDir): FileSystemDirectoryHandle => d as unknown as FileSystemDirectoryHandle
const fake = (d: FileSystemDirectoryHandle): FakeDir => d as unknown as FakeDir

/**
 * navigator.locks as the tabs of one origin share it: exclusive locks by name, granted in turn, or at once refused with
 * ifAvailable (the callback gets null). `beforeTry` runs as an ifAvailable request is made, for a test to let a copy
 * commit at exactly that moment.
 */
class FakeLocks implements LockManagerLike {
  readonly held = new Set<string>()
  beforeTry: (() => Promise<void>) | null = null
  private wake: (() => void)[] = []
  async request<T>(name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => Promise<T>): Promise<T> {
    if (options.ifAvailable && this.beforeTry) await this.beforeTry()
    while (this.held.has(name)) {
      if (options.ifAvailable) return callback(null)
      await new Promise<void>((r) => this.wake.push(r))
    }
    this.held.add(name)
    try {
      return await callback({ name, mode: 'exclusive' })
    } finally {
      this.held.delete(name)
      for (const w of this.wake.splice(0)) w()
    }
  }
}

// The worker's global and the page's, faked: the storage the worker opens (none unless a test sets one), the page's
// locks (none unless a test sets them), and where the worker's replies go.
let workerRoot: FakeDir | null = null
let pageLocks: FakeLocks | null = null
const navigatorWas = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
Object.defineProperty(globalThis, 'navigator', { configurable: true, get: () => ({ storage: workerRoot ? { getDirectory: async () => workerRoot } : undefined, ...(pageLocks && { locks: pageLocks }) }) })
after(() => { if (navigatorWas) Object.defineProperty(globalThis, 'navigator', navigatorWas) })

/** A Worker that runs modelStore.worker.ts in this process, its messages a task later each way as across a thread. */
class InProcessWorker {
  static current: InProcessWorker | null = null
  static made: InProcessWorker[] = []
  onmessage: ((e: { data: CopyReply }) => void) | null = null
  onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null
  readonly posted: CopyRequest[] = []
  readonly replies: CopyReply[] = []
  terminated = false
  constructor() {
    InProcessWorker.made.push(this)
  }

  postMessage(m: CopyRequest): void {
    this.posted.push(m)
    setTimeout(() => {
      InProcessWorker.current = this
      void runWorker({ data: m })
    }, 0)
  }

  terminate(): void {
    this.terminated = true
  }
}

/** Whether any file of the worker's storage was still held open when the worker said done, one entry per done. */
const heldAtDone: boolean[] = []
;(globalThis as unknown as { postMessage(m: CopyReply): void }).postMessage = (m) => {
  const w = InProcessWorker.current
  assert.ok(w, 'the worker replies to the worker that was asked')
  if (m.t === 'done') heldAtDone.push(workerRoot !== null && held(workerRoot))
  w.replies.push(m)
  setTimeout(() => { if (!w.terminated) w.onmessage?.({ data: m }) }, 0)
}
await import('./modelStore.worker.ts')
const runWorker = (globalThis as unknown as { onmessage: (e: { data: CopyRequest }) => Promise<void> }).onmessage

const productCopy = (): CopyFile => workerCopy(() => new InProcessWorker() as unknown as Worker)

/** `inner` with each copy's start and end written to `events`. */
const traced = (inner: CopyFile, events: string[]): CopyFile => async (dir, name, file, onBytes, signal) => {
  events.push(`copy ${name}`)
  await inner(dir, name, file, onBytes, signal)
  events.push(`copied ${name}`)
}

/** A copy straight into the fake file, `chunk` bytes at a time, minding the signal between chunks. */
const directCopy = (chunk = 64 * 1024): CopyFile => async (dir, name, file, onBytes, signal) => {
  const f = await fake(dir).getFileHandle(name, { create: true })
  const bytes = await bytesOf(file)
  f.data = new Uint8Array(0)
  for (let at = 0; at < bytes.length; at += chunk) {
    signal?.throwIfAborted()
    f.data = concat(f.data, bytes.subarray(at, at + chunk))
    onBytes(Math.min(at + chunk, bytes.length))
    await Promise.resolve()
  }
}

/** Rejects with the signal's reason once it is aborted (at once if it already is). */
const untilAborted = (signal: AbortSignal | undefined): Promise<never> => new Promise((_, reject) => {
  assert.ok(signal, 'keep hands the copy its signal')
  if (signal.aborted) reject(signal.reason)
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
})

const NOW = 1_700_000_000_000
/** A store over `root` with plenty of room, the given copy, and the persist call written to `events`. */
function storeOver(root: FakeDir, events: string[], over: StoreDeps = {}) {
  return createModelStore({
    directory: async () => asDir(root),
    copy: traced(directCopy(), events),
    estimate: async () => ({ usage: 0, quota: 2 ** 40 }),
    persist: async () => { events.push('persist'); return true },
    now: () => NOW,
    ...over,
  })
}

/** The CognitionError `p` rejects with. */
async function failure(p: Promise<unknown>): Promise<CognitionError> {
  try {
    await p
  } catch (e) {
    assert.ok(e instanceof CognitionError, `a CognitionError, not ${String(e)}`)
    return e
  }
  assert.fail('it did not reject')
}

test('keep copies through the worker, then writes meta.json last as the commit, then asks to persist; list and open give the model back', async () => {
  const root = new FakeDir('')
  workerRoot = root
  InProcessWorker.made = []
  heldAtDone.length = 0
  const events: string[] = []
  const progress: [number, number, string][] = []
  const s = storeOver(root, events, { copy: traced(productCopy(), events) })
  const [file] = tiny()
  const m = await s.keep([file], (done, total) => progress.push([done, total, s.storageLine()]))

  assert.deepEqual(events, ['copy tiny-a.gguf', 'copied tiny-a.gguf', `copy ${META}`, `copied ${META}`, 'persist'])
  assert.deepEqual(m, { id: `tiny-a-${NOW.toString(36)}`, name: 'tiny-a.gguf', files: [{ name: 'tiny-a.gguf', bytes: 156_992 }], bytes: 156_992, keptAt: NOW, durable: true })
  const dir = root.dir(MODELS_DIR).dir(m.id)
  assert.deepEqual([...dir.children.keys()], ['tiny-a.gguf', META])
  assert.deepEqual(dir.file('tiny-a.gguf').data, await bytesOf(file))
  assert.deepEqual(JSON.parse(new TextDecoder().decode(dir.file(META).data)), { id: m.id, name: 'tiny-a.gguf', files: [{ name: 'tiny-a.gguf', bytes: 156_992 }], bytes: 156_992, keptAt: NOW, v: 1 })
  // One write (the file is under 8 MiB), cut to its size, flushed, and closed before the worker says done.
  assert.deepEqual(dir.file('tiny-a.gguf').calls, ['write 0+156992', 'truncate 156992', 'flush', 'close'])
  assert.deepEqual(heldAtDone, [false, false], 'each file closed before its worker said done')
  assert.deepEqual(progress, [[0, 156_992, 'copying 0%'], [156_992, 156_992, 'copying 100%']])
  assert.equal(s.storageLine(), 'kept in this page')

  // One worker per file, told where under the storage's root the file goes, and ended once it is done.
  assert.deepEqual(InProcessWorker.made.map((w) => w.posted.map((p) => [p.dirPath, p.name])), [[[[MODELS_DIR, m.id], 'tiny-a.gguf']], [[[MODELS_DIR, m.id], META]]])
  assert.ok(InProcessWorker.made.every((w) => w.terminated))

  assert.deepEqual(await s.list(), [m])
  const [back] = await s.open(m.id)
  assert.equal(back.name, 'tiny-a.gguf')
  assert.deepEqual(await bytesOf(back), await bytesOf(file))
  // A later store (the next visit) finds it in the storage alone.
  assert.deepEqual(await storeOver(root, []).list(), [m])
})

test('the worker writes 8 MiB at a time at its offsets, and keep reports progress after every write', async () => {
  const root = new FakeDir('')
  workerRoot = root
  const pad = 5 * MIB // f32s: a 20 MiB tensor
  const big = new File([ggufBytes([['general.architecture', T.STRING, 'llama'], ['general.name', T.STRING, 'big']], [{ name: 'pad', dims: [pad], data: new Float32Array(pad) }])], 'big-model.gguf')
  const progress: [number, number][] = []
  const lines: string[] = []
  const s = storeOver(root, [], { copy: productCopy() })
  const m = await s.keep([big], (done, total) => { progress.push([done, total]); lines.push(s.storageLine()) })

  const size = big.size
  assert.ok(size > 20 * MIB && size < 21 * MIB, `${size} B`)
  const file = root.dir(MODELS_DIR).dir(m.id).file('big-model.gguf')
  assert.deepEqual(file.calls, [`write 0+${8 * MIB}`, `write ${8 * MIB}+${8 * MIB}`, `write ${16 * MIB}+${size - 16 * MIB}`, `truncate ${size}`, 'flush', 'close'])
  assert.deepEqual(file.data, await bytesOf(big))
  assert.deepEqual(progress, [[0, size], [8 * MIB, size], [16 * MIB, size], [size, size]])
  assert.deepEqual(lines, ['copying 0%', `copying ${Math.floor((8 * MIB * 100) / size)}%`, `copying ${Math.floor((16 * MIB * 100) / size)}%`, 'copying 100%'])
})

test('shards picked in any order are kept in load order under their own names, and the model is shown without the shard number', async () => {
  const root = new FakeDir('')
  workerRoot = root
  const events: string[] = []
  const s = storeOver(root, events, { copy: traced(productCopy(), events) })
  const [one, two] = tiny('b', true)
  const m = await s.keep([two, one])
  assert.equal(m.name, 'tiny-b.gguf')
  assert.deepEqual(m.files, [{ name: one.name, bytes: one.size }, { name: two.name, bytes: two.size }])
  assert.equal(m.bytes, one.size + two.size)
  assert.deepEqual(events, [`copy ${one.name}`, `copied ${one.name}`, `copy ${two.name}`, `copied ${two.name}`, `copy ${META}`, `copied ${META}`, 'persist'])
  const files = await s.open(m.id)
  assert.deepEqual(files.map((f) => f.name), ['tiny-b-00001-of-00002.gguf', 'tiny-b-00002-of-00002.gguf'])
  assert.deepEqual(await bytesOf(files[0]), await bytesOf(one))
  assert.deepEqual(await bytesOf(files[1]), await bytesOf(two))
})

test('what is not one whole model that writes text is refused before any copy or directory', async () => {
  const [whole] = tiny()
  const [one, two] = tiny('a', true)
  const as = (f: File, name: string): File => new File([f], name)
  const png = new File([Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13)], 'photo.png')
  const embedding = new File([ggufBytes([['general.architecture', T.STRING, 'bert'], ['bert.pooling_type', T.U32, 1]])], 'my-model.gguf')
  const cases: [File[], RegExp][] = [
    [[png], /^photo\.png was not kept: this is not a GGUF model file$/],
    [[embedding], /^my-model\.gguf was not kept: it is an embedding model \(it pools its output\)/],
    [[as(whole, 'nomic-embed-text-v1.5.gguf')], /^nomic-embed-text-v1\.5\.gguf was not kept: its name .* says it is an embedding/],
    [[one], /is part 1 of a model split into 2 parts: choose all 2 parts together/],
    [[as(one, 'renamed.gguf')], /^renamed\.gguf was not kept: it is part 1 of a model split into 2 parts/],
    [[as(whole, 'x-00001-of-00002.gguf'), as(two, 'x-00002-of-00002.gguf')], /^x-00001-of-00002\.gguf was not kept: it is a whole model, not one of the 2 parts chosen/],
    [[as(two, 'x-00001-of-00002.gguf'), as(one, 'x-00002-of-00002.gguf')], /^x-00001-of-00002\.gguf was not kept: its name says it is part 1 and its header says part 2$/],
    [[as(whole, META)], /^meta\.json was not kept: its name is the one this page keeps its own notes under/],
    [[], /no model file was chosen/],
  ]
  for (const [files, reason] of cases) {
    const root = new FakeDir('')
    const events: string[] = []
    const e = await failure(storeOver(root, events).keep(files))
    assert.equal(e.code, 'model')
    assert.match(e.message, reason)
    assert.deepEqual(events, [], 'nothing copied')
    assert.equal(root.children.size, 0, 'no directory made')
  }
})

test('a model the browser has no room for is refused with both sizes; exactly enough room passes; a browser that does not say is not refused', async () => {
  const [file] = tiny()
  const need = file.size + SPARE_BYTES
  for (const [room, kept] of [[need - 1, false], [need, true]] as const) {
    const root = new FakeDir('')
    const events: string[] = []
    const s = storeOver(root, events, { estimate: async () => ({ usage: 5000, quota: 5000 + room }) })
    if (kept) {
      assert.equal((await s.keep([file])).durable, true)
      continue
    }
    const e = await failure(s.keep([file]))
    assert.equal(e.code, 'model')
    assert.equal(e.message, "this model needs 1 MB and this page's storage has 64 MB free (64 MB is kept spare as well): free some space in this browser, or choose a smaller model")
    assert.deepEqual(events, [])
    assert.equal(root.dir(MODELS_DIR).children.size, 0)
  }
  for (const estimate of [async () => { throw new Error('no estimate') }, async () => ({}), async () => ({ usage: 10, quota: Infinity })]) {
    assert.equal((await storeOver(new FakeDir(''), [], { estimate }).keep([file])).durable, true)
  }
})

test('where the browser keeps no files for the page, the picked files serve this visit and the storage row says why', async () => {
  const events: string[] = []
  const progress: [number, number][] = []
  const s = createModelStore({
    directory: async () => { throw domError('SecurityError', 'denied') },
    copy: traced(directCopy(), events),
    now: () => NOW,
  })
  const files = tiny('c', true)
  const m = await s.keep(files, (done, total) => progress.push([done, total]))
  assert.equal(m.durable, false)
  assert.equal(m.name, 'tiny-c.gguf')
  assert.deepEqual(events, [])
  assert.deepEqual(progress, [[m.bytes, m.bytes]])
  assert.equal(s.storageLine(), 'this visit only: the browser keeps no files for this page (a page opened from a file, or a private window)')
  assert.deepEqual(await s.list(), [m])
  const back = await s.open(m.id)
  assert.equal(back[0], files[0])
  assert.equal(back[1], files[1])
  // The same files again replace the first entry rather than adding a second.
  const again = await s.keep([files[1], files[0]])
  assert.deepEqual(await s.list(), [again])
  assert.equal(await s.forget(again.id), 1)
  assert.deepEqual(await s.list(), [])
  const e = await failure(s.open(again.id))
  assert.equal(e.code, 'offline')

  // With no storage at all (this Node process has no navigator.storage), the defaults fall back the same way.
  workerRoot = null
  const bare = createModelStore({ now: () => NOW })
  assert.equal((await bare.keep(tiny())).durable, false)
  assert.equal(bare.storageLine(), 'this visit only: this browser gives the page no storage for files')
  assert.equal(await bare.usage(), null)
})

test('the storage row follows the storage: back to kept once it answers and no visit-only model is held, or once a model is kept in it', async () => {
  const reasons: [DOMException, string][] = [
    [domError('QuotaExceededError', 'full'), "this page's storage is full"],
    [domError('UnknownError', 'The operation failed for an unknown transient reason.'), "the browser's storage refused this page (The operation failed for an unknown transient reason)"],
  ]
  for (const [error, reason] of reasons) {
    const root = new FakeDir('')
    let refuse = true
    const s = storeOver(root, [], { directory: async () => { if (refuse) throw error; return asDir(root) } })
    assert.equal(s.storageLine(), 'kept in this page')
    assert.deepEqual(await s.list(), [])
    assert.equal(s.storageLine(), `this visit only: ${reason}`)
    refuse = false
    assert.deepEqual(await s.list(), [])
    assert.equal(s.storageLine(), 'kept in this page')

    refuse = true
    assert.equal((await s.keep(tiny('h'))).durable, false)
    refuse = false
    await s.list()
    assert.equal(s.storageLine(), `this visit only: ${reason}`, 'a visit-only model is still held')
    assert.equal((await s.keep(tiny('i'))).durable, true)
    assert.equal(s.storageLine(), 'kept in this page', 'the newest model is kept in the storage')
  }
})

test('an abort mid-copy rejects with its reason, writes no meta.json and leaves nothing; a file still held is swept by a later list()', async () => {
  for (const stillHeld of [false, true]) {
    const root = new FakeDir('')
    const events: string[] = []
    const ctl = new AbortController()
    let file: FakeFile | null = null
    const copy: CopyFile = async (dir, name, f, onBytes, signal) => {
      file = await fake(dir).getFileHandle(name, { create: true })
      file.data = new Uint8Array(await f.slice(0, 1000).arrayBuffer())
      // A worker that was ended mid-write may not have let go of its file yet.
      file.held = stillHeld
      onBytes(1000)
      return untilAborted(signal)
    }
    const s = storeOver(root, events, { copy: traced(copy, events) })
    const lines: string[] = []
    const p = s.keep(tiny(), (done) => { lines.push(s.storageLine()); if (done === 1000) ctl.abort() }, ctl.signal)
    await assert.rejects(p, (e: unknown) => e === ctl.signal.reason && (e as Error).name === 'AbortError')
    assert.deepEqual(events, ['copy tiny-a.gguf'], 'no meta.json was written')
    assert.deepEqual(lines, ['copying 0%', 'copying 0%'])
    assert.equal(s.storageLine(), 'kept in this page')
    const models = root.dir(MODELS_DIR)
    if (!stillHeld) {
      assert.equal(models.children.size, 0, 'the cut copy is removed at once')
      continue
    }
    const [left] = [...models.children.values()]
    assert.ok(left instanceof FakeDir && !left.children.has(META), 'the held copy is left without meta.json')
    assert.deepEqual(await s.list(), [], 'never listed')
    assert.equal(models.children.size, 1, 'not swept while it is held')
    ;(file as FakeFile | null)!.held = false
    assert.deepEqual(await s.list(), [])
    assert.equal(models.children.size, 0, 'swept once it is let go')
  }
  // Aborted before it starts: nothing is read beyond the headers, nothing made.
  const root = new FakeDir('')
  const events: string[] = []
  const ctl = new AbortController()
  ctl.abort()
  await assert.rejects(storeOver(root, events).keep(tiny(), undefined, ctl.signal), (e: unknown) => e === ctl.signal.reason)
  assert.deepEqual(events, [])
  assert.equal(root.children.size, 0)
})

test('list sweeps every copy cut short and every stray entry, and keeps the models; it never sweeps the copy in progress', async () => {
  const root = new FakeDir('')
  const events: string[] = []
  let release = (): void => {}
  const gate = new Promise<void>((r) => { release = r })
  let hold = false
  const inner = directCopy()
  const copy: CopyFile = async (dir, name, file, onBytes, signal) => {
    await inner(dir, name, file, onBytes, signal)
    if (hold && name !== META) await gate
  }
  let t = NOW
  const s = storeOver(root, events, { copy, now: () => (t += 1000) })
  const a = await s.keep(tiny('a'))
  const models = root.dir(MODELS_DIR)
  const half = await models.getDirectoryHandle('half-copy', { create: true })
  ;(await half.getFileHandle('x.gguf', { create: true })).data = Uint8Array.of(1, 2, 3)
  const bad = await models.getDirectoryHandle('bad-meta', { create: true })
  ;(await bad.getFileHandle(META, { create: true })).data = new TextEncoder().encode('{"v":1,"name":')
  const wrong = await models.getDirectoryHandle('wrong-total', { create: true })
  ;(await wrong.getFileHandle(META, { create: true })).data = new TextEncoder().encode(JSON.stringify({ v: 1, name: 'n', files: [{ name: 'n.gguf', bytes: 3 }], bytes: 4, keptAt: 1 }))
  await models.getFileHandle('stray.txt', { create: true })
  assert.deepEqual(await s.list(), [a])
  assert.deepEqual([...models.children.keys()], [a.id])

  // A copy in progress has no meta.json yet: list, forget and a second keep all leave it alone.
  hold = true
  const lines: string[] = []
  const b = s.keep(tiny('b'), () => lines.push(s.storageLine()))
  for (let i = 0; models.children.size < 2 && i < 100; i++) await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  const copyingId = [...models.children.keys()].find((k) => k !== a.id) ?? ''
  assert.match(s.storageLine(), /^copying 100%$/)
  assert.deepEqual(await s.list(), [a])
  assert.ok(models.children.has(copyingId), 'not swept')
  assert.equal(await s.forget(copyingId), 0)
  const second = await failure(s.keep(tiny('c')))
  assert.equal(second.code, 'model')
  assert.match(second.message, /another model file is being copied into this page: wait for it to finish/)
  release()
  const kept = await b
  assert.equal(kept.id, copyingId)
  assert.deepEqual((await s.list()).map((m) => m.id), [kept.id, a.id], 'newest first')
})

test('two tabs of the city: a copy in progress holds its directory\'s lock, so the other tab\'s list and forget leave it alone', async () => {
  const root = new FakeDir('')
  const locks = new FakeLocks()
  let release = (): void => {}
  const gate = new Promise<void>((r) => { release = r })
  const inner = directCopy()
  let copied = 0
  // Tab A pauses between its two shards: the first written and let go, the next not yet opened, so no file is held.
  const pausing: CopyFile = async (dir, name, file, onBytes, signal) => {
    await inner(dir, name, file, onBytes, signal)
    if (++copied === 1) await gate
  }
  const a = storeOver(root, [], { copy: pausing, locks })
  // Tab B is given nothing: it finds the page's navigator.locks, as the product's store does.
  pageLocks = locks
  const b = storeOver(root, [])
  pageLocks = null
  const keeping = a.keep(tiny('s', true))
  for (let i = 0; copied === 0 && i < 100; i++) await new Promise((r) => setTimeout(r, 0))
  const models = root.dir(MODELS_DIR)
  const [id] = [...models.children.keys()]
  assert.ok(id !== undefined && locks.held.has(`${MODELS_DIR}/${id}`), 'the copy holds the lock on its directory')
  assert.deepEqual(await b.list(), [])
  assert.equal(await b.forget(), 0)
  assert.ok(models.children.has(id), 'neither tab B\'s list nor its forget swept it')
  release()
  const m = await keeping
  assert.equal(m.id, id)
  assert.equal(locks.held.size, 0, 'let go once committed')
  assert.deepEqual(await b.list(), [m])
  // A copy cut short holds no lock (aborted, or its tab closed): any tab sweeps it.
  await models.getDirectoryHandle('cut-short', { create: true })
  assert.deepEqual(await b.list(), [m])
  assert.deepEqual([...models.children.keys()], [id])
  assert.equal(await b.forget(), 1)
  assert.equal(models.children.size, 0)
})

test('a copy that commits while another tab looks at it is a model by the time that tab may sweep it, and is kept', async () => {
  const root = new FakeDir('')
  const locks = new FakeLocks()
  let release = (): void => {}
  const gate = new Promise<void>((r) => { release = r })
  let atCommit = false
  const inner = directCopy()
  const copy: CopyFile = async (dir, name, file, onBytes, signal) => {
    if (name === META) {
      atCommit = true
      await gate
    }
    await inner(dir, name, file, onBytes, signal)
  }
  const a = storeOver(root, [], { copy, locks })
  const b = storeOver(root, [], { locks })
  const keeping = a.keep(tiny('t'))
  for (let i = 0; !atCommit && i < 100; i++) await new Promise((r) => setTimeout(r, 0))
  // Tab B's walk finds no meta.json; as it asks for the lock to sweep, tab A commits and lets go.
  locks.beforeTry = async () => {
    locks.beforeTry = null
    release()
    await keeping
  }
  assert.deepEqual(await b.list(), [], 'its walk came before the commit')
  const m = await keeping
  assert.ok(root.dir(MODELS_DIR).children.has(m.id), 'looked at again under the lock: a model, not swept')
  assert.deepEqual(await b.list(), [m])
})

test('persist is asked for, never waited for: a prompt left unanswered, or a persist that throws, holds no keep', async () => {
  const root = new FakeDir('')
  let asked = 0
  const s = storeOver(root, [], { persist: () => { asked++; return new Promise<boolean>(() => {}) } })
  const within = <T>(p: Promise<T>): Promise<T | 'held'> => Promise.race([p, new Promise<'held'>((r) => setTimeout(() => r('held'), 1000))])
  const first = await within(s.keep(tiny('a')))
  assert.notEqual(first, 'held', 'the keep resolved with the persist still open')
  assert.equal(asked, 1)
  assert.equal(s.storageLine(), 'kept in this page')
  const second = await within(s.keep(tiny('b')))
  assert.ok(second !== 'held' && second.name === 'tiny-b.gguf', 'the next keep is not refused as a copy in progress')
  for (const persist of [() => { throw new Error('no') }, () => Promise.reject(new Error('no'))]) {
    const m = await storeOver(new FakeDir(''), [], { persist }).keep(tiny('c'))
    assert.equal(m.durable, true, 'the copy stands')
  }
})

test('a copy that fails is reported in plain words, and leaves nothing behind', async () => {
  const cases: [unknown, RegExp][] = [
    [domError('QuotaExceededError', 'quota'), /^this page's storage ran out of room while the model was copied: free some space in this browser, or choose a smaller model$/],
    [domError('NotReadableError', 'gone'), /^the chosen file could not be read while it was copied \(it may have been moved or changed\): choose it again$/],
    [new Error('the disk is on fire.\nmore'), /^the model could not be copied into this page's storage \(the disk is on fire\)$/],
  ]
  for (const [error, reason] of cases) {
    const root = new FakeDir('')
    const events: string[] = []
    const e = await failure(storeOver(root, events, { copy: async () => { throw error } }).keep(tiny()))
    assert.equal(e.code, 'model')
    assert.match(e.message, reason)
    assert.equal(root.dir(MODELS_DIR).children.size, 0)
    assert.deepEqual(events, [], 'never persisted')
  }
  // The worker's own failure keeps its name across the thread: a full disk mid-write reads as one.
  const root = new FakeDir('')
  workerRoot = root
  const worker = productCopy()
  // Every write of the file comes up short, as on a disk that filled during the copy.
  const short: CopyFile = async (dir, name, file, onBytes, signal) => {
    ;(await fake(dir).getFileHandle(name, { create: true })).shortBy = 1
    return worker(dir, name, file, onBytes, signal)
  }
  const e = await failure(storeOver(root, [], { copy: short }).keep(tiny()))
  assert.equal(e.code, 'model')
  assert.equal(e.message, "the model could not be copied into this page's storage (the page's storage took 156991 of 156992 bytes: it may be full)")
  assert.equal(root.dir(MODELS_DIR).children.size, 0, 'the worker closed its file, so the cut copy is removed at once')
})

test('forget removes one model or all of them, and says how many models went', async () => {
  const root = new FakeDir('')
  let t = NOW
  const s = storeOver(root, [], { now: () => (t += 1000) })
  const a = await s.keep(tiny('a'))
  const b = await s.keep(tiny('b', true))
  const c = await s.keep(tiny('c'))
  assert.deepEqual(await s.list(), [c, b, a])
  assert.equal(await s.forget(b.id), 1)
  assert.deepEqual(await s.list(), [c, a])
  assert.equal(await s.forget(b.id), 0)
  assert.equal(await s.forget('no-such-model'), 0)
  const models = root.dir(MODELS_DIR)
  await models.getDirectoryHandle('half-copy', { create: true })
  assert.equal(await s.forget(), 2, 'a copy cut short is removed but not counted')
  assert.equal(models.children.size, 0)
  assert.deepEqual(await s.list(), [])
  assert.equal(await s.forget(), 0)
  // A removal the browser refuses is said, not swallowed.
  const d = await s.keep(tiny('d'))
  models.dir(d.id).file('tiny-d.gguf').held = true
  const e = await failure(s.forget(d.id))
  assert.equal(e.code, 'model')
  assert.match(e.message, /^the kept model could not be removed from this page's storage \(tiny-d-[0-9a-z]+ is held open\)$/)
})

test('open hands back the files named as kept, and an offline failure once the browser has cleared one', async () => {
  const root = new FakeDir('')
  const s = storeOver(root, [])
  const m = await s.keep(tiny('e', true))
  const dir = root.dir(MODELS_DIR).dir(m.id)
  const first = dir.file('tiny-e-00001-of-00002.gguf')
  const files = await s.open(m.id)
  assert.equal(files[0], first.last, 'a file already named as kept is handed back as it is')
  first.fileName = 'something-else.bin'
  const renamed = await s.open(m.id)
  assert.notEqual(renamed[0], first.last)
  assert.equal(renamed[0].name, 'tiny-e-00001-of-00002.gguf')
  assert.deepEqual(await bytesOf(renamed[0]), first.data)

  const gone = async (): Promise<void> => {
    const e = await failure(s.open(m.id))
    assert.equal(e.code, 'offline')
    assert.equal(e.message, GONE)
  }
  const second = dir.file('tiny-e-00002-of-00002.gguf')
  second.data = second.data.slice(0, 10)
  await gone()
  dir.children.delete('tiny-e-00002-of-00002.gguf')
  await gone()
  dir.children.delete(META)
  await gone()
  const e = await failure(s.open('no-such-model'))
  assert.equal(e.message, GONE)
})

test('the same model picked again is not copied twice; a kept copy that lost a file is replaced', async () => {
  const root = new FakeDir('')
  const events: string[] = []
  let t = NOW
  const s = storeOver(root, events, { now: () => (t += 1000) })
  const files = tiny('f', true)
  const m = await s.keep(files)
  events.length = 0
  const progress: [number, number][] = []
  assert.deepEqual(await s.keep([files[1], files[0]], (d, n) => progress.push([d, n])), m)
  assert.deepEqual(events, [])
  assert.deepEqual(progress, [[m.bytes, m.bytes]])
  root.dir(MODELS_DIR).dir(m.id).children.delete('tiny-f-00002-of-00002.gguf')
  const again = await s.keep(files)
  assert.notEqual(again.id, m.id)
  assert.deepEqual(await s.list(), [again])
  assert.equal(events.filter((e) => e === 'persist').length, 1)
})

test('usage is the browser\'s own estimate, or null when it gives none', async () => {
  assert.deepEqual(await storeOver(new FakeDir(''), [], { estimate: async () => ({ usage: 5, quota: 10 }) }).usage(), { used: 5, quota: 10 })
  assert.deepEqual(await storeOver(new FakeDir(''), [], { estimate: async () => ({ quota: 10 }) }).usage(), { used: 0, quota: 10 })
  assert.equal(await storeOver(new FakeDir(''), [], { estimate: async () => ({ usage: 5 }) }).usage(), null)
  assert.equal(await storeOver(new FakeDir(''), [], { estimate: async () => { throw new Error('no') } }).usage(), null)
})

test('workerCopy: an error keeps its name, a worker that dies rejects, an abort ends the worker at once, and nothing starts once aborted', async () => {
  const dir = asDir(new FakeDir('model-1'))
  const file = new File([Uint8Array.of(1, 2, 3)], 'm.gguf')
  /** A worker that replies only as the test says. */
  class Puppet {
    static last: Puppet | null = null
    onmessage: ((e: { data: CopyReply }) => void) | null = null
    onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null
    posted: CopyRequest[] = []
    terminated = false
    prevented = false
    constructor() { Puppet.last = this }
    postMessage(m: CopyRequest): void { this.posted.push(m) }
    terminate(): void { this.terminated = true }
    say(m: CopyReply): void { this.onmessage?.({ data: m }) }
    die(message: string): void { this.onerror?.({ message, preventDefault: () => { this.prevented = true } }) }
  }
  const copy = workerCopy(() => new Puppet() as unknown as Worker)
  const puppet = (): Puppet => { assert.ok(Puppet.last); return Puppet.last }

  const bytes: number[] = []
  const ok = copy(dir, 'm.gguf', file, (n) => bytes.push(n))
  assert.deepEqual(puppet().posted, [{ dirPath: [MODELS_DIR, 'model-1'], name: 'm.gguf', file }])
  puppet().say({ t: 'bytes', n: 2 })
  puppet().say({ t: 'done', n: 3 })
  await ok
  assert.deepEqual(bytes, [2, 3])
  assert.equal(puppet().terminated, true)

  const failed = copy(dir, 'm.gguf', file, () => {})
  puppet().say({ t: 'error', name: 'QuotaExceededError', message: 'full' })
  await assert.rejects(failed, (e: unknown) => e instanceof DOMException && e.name === 'QuotaExceededError' && e.message === 'full')
  assert.equal(puppet().terminated, true)

  const died = copy(dir, 'm.gguf', file, () => {})
  puppet().die('boom')
  await assert.rejects(died, /^Error: the copy worker stopped: boom$/)
  assert.ok(puppet().prevented && puppet().terminated)

  const ctl = new AbortController()
  const late: number[] = []
  const aborted = copy(dir, 'm.gguf', file, (n) => late.push(n), ctl.signal)
  const w = puppet()
  ctl.abort()
  await assert.rejects(aborted, (e: unknown) => e === ctl.signal.reason)
  assert.equal(w.terminated, true)
  w.say({ t: 'bytes', n: 1 })
  assert.deepEqual(late, [], 'nothing heard after the end')

  Puppet.last = null
  await assert.rejects(copy(dir, 'm.gguf', file, () => {}, ctl.signal), (e: unknown) => e === ctl.signal.reason)
  assert.equal(Puppet.last, null, 'no worker made')
  await assert.rejects(workerCopy(() => { throw new Error('no workers here') })(dir, 'm.gguf', file, () => {}), /no workers here/)
})

test('the worker never makes a directory, says why a file it cannot open failed, and imports nothing at run time', async () => {
  const root = new FakeDir('')
  workerRoot = root
  const w = new InProcessWorker()
  const replies = new Promise<CopyReply>((resolve) => { w.onmessage = (e) => { if (e.data.t !== 'bytes') resolve(e.data) } })
  w.postMessage({ dirPath: [MODELS_DIR, 'forgotten'], name: 'm.gguf', file: new File([Uint8Array.of(1)], 'm.gguf') })
  assert.deepEqual(await replies, { t: 'error', name: 'NotFoundError', message: `no directory ${MODELS_DIR}` })
  assert.equal(root.children.size, 0, 'nothing recreated')

  const dir = await (await root.getDirectoryHandle(MODELS_DIR, { create: true })).getDirectoryHandle('m', { create: true })
  ;(await dir.getFileHandle('m.gguf', { create: true })).held = true
  const w2 = new InProcessWorker()
  const replies2 = new Promise<CopyReply>((resolve) => { w2.onmessage = (e) => { if (e.data.t !== 'bytes') resolve(e.data) } })
  w2.postMessage({ dirPath: [MODELS_DIR, 'm'], name: 'm.gguf', file: new File([Uint8Array.of(1)], 'm.gguf') })
  assert.deepEqual(await replies2, { t: 'error', name: 'NoModificationAllowedError', message: 'm.gguf is held by another handle' })

  const source = readFileSync(fileURLToPath(new URL('./modelStore.worker.ts', import.meta.url)), 'utf8')
  const imports = [...source.matchAll(/^import\s+(type\s+)?.*$/gm)]
  assert.ok(imports.length > 0 && imports.every((m) => m[1] !== undefined), 'type imports only: nothing joins the worker\'s bundle')
  assert.doesNotMatch(source, /\binstallAirgap\b|\bfetch\s*\(|\bimportScripts\b/)
})

test('a store with no copy given writes through the page\'s own writable stream', async () => {
  const root = new FakeDir('')
  const s = createModelStore({ directory: async () => asDir(root), now: () => NOW })
  const [file] = tiny('g')
  const m = await s.keep([file])
  const dir = root.dir(MODELS_DIR).dir(m.id)
  assert.deepEqual(dir.file('tiny-g.gguf').data, await bytesOf(file))
  assert.equal(JSON.parse(new TextDecoder().decode(dir.file(META).data)).v, 1)
  const bytes: number[] = []
  await writableCopy(asDir(dir), 'copy.bin', new File([new Uint8Array(3 * 70_000)], 'copy.bin'), (n) => bytes.push(n))
  assert.equal(dir.file('copy.bin').data.length, 210_000)
  assert.equal(bytes.at(-1), 210_000)
  assert.ok(bytes.every((n, i) => i === 0 || n > bytes[i - 1]), 'cumulative')
  const bare = { getFileHandle: async () => ({}) } as unknown as FileSystemDirectoryHandle
  await assert.rejects(writableCopy(bare, 'x', file, () => {}), /writes files into the page's storage only from a worker/)
})

test('no model file is ever committed: *.gguf is ignored, and no tracked file starts with the GGUF magic', (t) => {
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim())
  assert.ok(ignore.includes('*.gguf'), '.gitignore lacks *.gguf')
  let files: string[]
  try {
    files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean)
  } catch {
    t.skip('no git history here (an unpacked tree): the tracked-file check is skipped')
    return
  }
  assert.ok(files.length > 100, `${files.length} tracked files read`)
  const head = Buffer.alloc(4)
  const models: string[] = []
  for (const f of files) {
    let fd: number
    try {
      fd = openSync(join(ROOT, f), 'r')
    } catch {
      continue // deleted in the working tree
    }
    try {
      if (readSync(fd, head, 0, 4, 0) === 4 && head.toString('latin1') === 'GGUF') models.push(f)
    } catch {
      // a directory (a submodule's entry): not a file
    } finally {
      closeSync(fd)
    }
  }
  assert.deepEqual(models, [])
})
