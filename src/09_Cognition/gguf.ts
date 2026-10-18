// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is how the page looks inside a model file the operator picked for the in-page model
 * (the `inpage` provider) before it copies gigabytes into the page's storage (modelStore.ts keep): whether the file is
 * a GGUF at all, and of a version llama.cpp still reads; its architecture, name, size label and file type to show;
 * the context it was trained for; whether it brings its own chat template; whether it pools its output (an embedding
 * or reranking model, which writes no text); and whether it is one shard of a split model. A GGUF's header is its
 * metadata, the vocabulary arrays included, and the chat template often comes after them, megabytes into the file.
 * The reader pulls the header through `ReadAt` in chunks that start at 64 KiB and grow, little-endian as GGUF is,
 * skips every array of fixed-size items by its length without reading it, walks a string array's lengths without
 * keeping a single string, and refuses a header that runs past 64 MiB. It never reads the tensor data. shardOrder
 * groups the files of a split model by their names the way wllama does (-NNNNN-of-NNNNN.gguf) and refuses a set that
 * is not exactly one whole model; textModel refuses a model that writes no text. Every refusal is one plain reason.
 * It is pure: no DOM beyond a Blob's own read in blobReader, no wllama, no timers.
 * What breaks if it is removed? Any file at all is copied into the page and handed to llama.cpp, and a picture, an
 * embedding model or half of a split model is found out only after the whole copy, when the load fails (wllama's
 * loadModel even resolves on a file that is not a model).
 */
import { localText } from './localCompute.ts'

/** Reads `length` bytes of the file from `offset` (fewer only at the end of the file). */
export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>

/** What the page needs to know of a model file, from its GGUF header. */
export interface GgufHeader {
  version: number; arch: string; name?: string; sizeLabel?: string; fileType?: number
  contextLength?: number; hasTemplate: boolean; pooling?: number
  split?: { no: number; count: number }   // split.no (u16), split.count (u16)
}

/** Why a file is not read as a model; `reason` is the plain sentence, as is the message. */
export class GgufError extends Error {
  override readonly name = 'GgufError'
  readonly reason: string
  constructor(reason: string, options?: ErrorOptions) {
    super(reason, options)
    this.reason = reason
  }
}

/** The most of a file the header may take: a vocabulary of 256k tokens and its merges are a few MiB. */
export const HEADER_LIMIT = 64 * 1024 * 1024
/** The first read; each further read doubles up to MAX_CHUNK, so a small header costs one read and a large one a few. */
export const FIRST_CHUNK = 64 * 1024
export const MAX_CHUNK = 4 * 1024 * 1024
/** The longest key or wanted string decoded; anything longer is skipped (no key the page wants is that long). */
const TEXT_BYTES = 1024
/** How deep arrays of arrays may nest (llama.cpp writes none; the format allows them). */
const MAX_DEPTH = 8

const MAGIC = 'GGUF'
const NOT_GGUF = 'this is not a GGUF model file'
const TRUNCATED = 'the file ends inside its header'
const TOO_LARGE = 'its header is larger than 64 MiB, more than this page reads'

/** GGUF metadata value types (ggml's gguf.h). */
const STRING = 8
const ARRAY = 9
/** The size of each fixed-size value type: uint8, int8, uint16, int16, uint32, int32, float32, bool, uint64, int64, float64. */
const SIZE: Readonly<Record<number, number>> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }
/** The fewest bytes a key-value pair takes (an empty key, its type and a one-byte value). */
const MIN_KV = 8 + 4 + 1

/** Why a GGUF version is not read, or null for 2 and 3 (the same layout; 3 added big-endian files). */
function versionReason(version: number): string | null {
  if (version === 2 || version === 3) return null
  if (version < 2) return `it is GGUF version ${version}, which llama.cpp no longer reads: convert it again with a current llama.cpp`
  const swapped = ((version & 0xff) << 24 | (version & 0xff00) << 8 | (version >>> 8) & 0xff00 | version >>> 24) >>> 0
  if (swapped === 2 || swapped === 3) return 'it is a big-endian GGUF, and this page reads only little-endian ones'
  return `it is GGUF version ${version}, newer than this page reads (2 and 3)`
}

/** A u64 as a number; one past the safe integers is Infinity, which no file reaches. */
const safe = (v: bigint): number => (v > BigInt(Number.MAX_SAFE_INTEGER) ? Infinity : Number(v))

/** A window of the file over `read`: the bytes from `start`, refilled from `pos` when a value is not inside it. */
class Cursor {
  pos = 0
  private start = 0
  private buf: Uint8Array = new Uint8Array(0)
  private view = new DataView(this.buf.buffer)
  private chunk = FIRST_CHUNK
  private readonly read: ReadAt
  private readonly size: number
  private readonly decoder = new TextDecoder()

  constructor(read: ReadAt, size: number) {
    this.read = read
    this.size = size
  }

  /** Throws when a value ending at `end` is past the file's end or past the header limit. */
  check(end: number): void {
    if (end > this.size) throw new GgufError(TRUNCATED)
    if (end > HEADER_LIMIT) throw new GgufError(TOO_LARGE)
  }

  has(n: number): boolean {
    return this.pos >= this.start && this.pos + n <= this.start + this.buf.length
  }

  /** Reads a new window from `pos` holding at least `n` bytes. */
  async fill(n: number): Promise<void> {
    this.check(this.pos + n)
    const length = Math.min(Math.max(n, this.chunk), Math.min(this.size, HEADER_LIMIT) - this.pos)
    let got: Uint8Array
    try {
      got = await this.read(this.pos, length)
    } catch (e) {
      throw new GgufError(`the file could not be read (${e instanceof Error ? e.message : String(e)})`, { cause: e })
    }
    if (got.length < n) throw new GgufError(TRUNCATED)
    this.buf = got.length > length ? got.subarray(0, length) : got
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength)
    this.start = this.pos
    this.chunk = Math.min(this.chunk * 2, MAX_CHUNK)
  }

  /** Makes the next `n` bytes readable. */
  async need(n: number): Promise<void> {
    if (!this.has(n)) await this.fill(n)
  }

  skip(n: number): void {
    this.check(this.pos + n)
    this.pos += n
  }

  /** Moves past the next `n` bytes and returns where they start in the window (call need first). */
  private take(n: number): number {
    const at = this.pos - this.start
    this.pos += n
    return at
  }

  /** The next `n` bytes, as a view into the window. */
  async bytes(n: number): Promise<Uint8Array> {
    await this.need(n)
    const at = this.take(n)
    return this.buf.subarray(at, at + n)
  }

  async u32(): Promise<number> {
    await this.need(4)
    return this.view.getUint32(this.take(4), true)
  }

  async u64(): Promise<number> {
    await this.need(8)
    return safe(this.view.getBigUint64(this.take(8), true))
  }

  /** A string: its decoded text when it is at most TEXT_BYTES long, else null (skipped). */
  async text(): Promise<string | null> {
    const n = await this.u64()
    if (n > TEXT_BYTES) {
      this.skip(n)
      return null
    }
    return this.decoder.decode(await this.bytes(n))
  }

  /** A numeric value of any fixed-size type as a number (a bool is 0 or 1). */
  async number(type: number): Promise<number> {
    const size = SIZE[type]
    await this.need(size)
    const at = this.take(size)
    const v = this.view
    switch (type) {
      case 0: case 7: return v.getUint8(at)
      case 1: return v.getInt8(at)
      case 2: return v.getUint16(at, true)
      case 3: return v.getInt16(at, true)
      case 4: return v.getUint32(at, true)
      case 5: return v.getInt32(at, true)
      case 6: return v.getFloat32(at, true)
      case 10: return Number(v.getBigUint64(at, true))
      case 11: return Number(v.getBigInt64(at, true))
      default: return v.getFloat64(at, true)
    }
  }

  /** Walks `count` strings by their lengths, reading only the lengths (a window at a time). */
  async skipStrings(count: number): Promise<void> {
    this.check(this.pos + count * 8)
    for (let i = 0; i < count; i++) {
      if (!this.has(8)) await this.fill(8)
      this.skip(safe(this.view.getBigUint64(this.take(8), true)))
    }
  }

  /** Skips one value of `type` (an array by its length, a string array by walking it). */
  async skipValue(type: number, key: string, depth = 0): Promise<void> {
    const size = SIZE[type]
    if (size !== undefined) return this.skip(size)
    if (type === STRING) return this.skip(await this.u64())
    if (type !== ARRAY) throw unknownType(type, key)
    if (depth >= MAX_DEPTH) throw new GgufError(`its header nests arrays more than ${MAX_DEPTH} deep (under ${key})`)
    const item = await this.u32()
    const count = await this.u64()
    const itemSize = SIZE[item]
    if (itemSize !== undefined) return this.skip(count * itemSize)
    if (item === STRING) return this.skipStrings(count)
    if (item !== ARRAY) throw unknownType(item, key)
    this.check(this.pos + count * 12)
    for (let i = 0; i < count; i++) await this.skipValue(ARRAY, key, depth + 1)
  }
}

const unknownType = (type: number, key: string): GgufError => new GgufError(`its header holds a value of unknown type ${type} (under ${key})`)

/** The string keys the page reads. */
const TEXT_KEYS: ReadonlySet<string> = new Set(['general.architecture', 'general.name', 'general.size_label'])
/** The numeric keys the page reads; `<arch>.context_length` and `<arch>.pooling_type` are matched by their ending, since the architecture may come later. */
const NUMBER_KEYS: ReadonlySet<string> = new Set(['general.file_type', 'split.no', 'split.count'])
const ARCH_NUMBER = /\.(context_length|pooling_type)$/
const TEMPLATE = 'tokenizer.chat_template'

/**
 * Parses a GGUF header from offset 0 of a file of `size` bytes, reading through `read` in growing chunks. Skips
 * arrays by length and never reads the tensor data. Throws GgufError: not a GGUF, a version other than 2 or 3, a
 * file that ends inside its header, a header past HEADER_LIMIT, a value of unknown type, or a failed read.
 */
export async function readGgufHeader(read: ReadAt, size: number): Promise<GgufHeader> {
  if (!(size > 0)) throw new GgufError('the file is empty')
  const c = new Cursor(read, size)
  // A file shorter than the magic that starts like it ends inside its header, which the version's read says.
  const magic = await c.bytes(Math.min(MAGIC.length, size))
  if (!magic.every((b, i) => b === MAGIC.charCodeAt(i))) throw new GgufError(NOT_GGUF)
  const version = await c.u32()
  const refused = versionReason(version)
  if (refused !== null) throw new GgufError(refused)
  await c.u64() // tensor count: the tensors are not read
  const kvs = await c.u64()
  c.check(c.pos + kvs * MIN_KV)

  const texts = new Map<string, string>()
  const numbers = new Map<string, number>()
  let hasTemplate = false
  for (let i = 0; i < kvs; i++) {
    const key = (await c.text()) ?? ''
    const type = await c.u32()
    if (TEXT_KEYS.has(key) && type === STRING) {
      const v = await c.text()
      if (v !== null) texts.set(key, v)
    } else if (key === TEMPLATE && type === STRING) {
      const n = await c.u64()
      c.skip(n)
      hasTemplate = n > 0
    } else if ((NUMBER_KEYS.has(key) || ARCH_NUMBER.test(key)) && SIZE[type] !== undefined) {
      numbers.set(key, await c.number(type))
    } else {
      await c.skipValue(type, key)
    }
  }

  const arch = texts.get('general.architecture') ?? ''
  const name = texts.get('general.name')
  const sizeLabel = texts.get('general.size_label')
  const fileType = numbers.get('general.file_type')
  const contextLength = arch === '' ? undefined : numbers.get(`${arch}.context_length`)
  const pooling = arch === '' ? undefined : numbers.get(`${arch}.pooling_type`)
  const no = numbers.get('split.no')
  const count = numbers.get('split.count')
  return {
    version, arch,
    ...(name !== undefined && { name }),
    ...(sizeLabel !== undefined && { sizeLabel }),
    ...(fileType !== undefined && { fileType }),
    ...(contextLength !== undefined && { contextLength }),
    hasTemplate,
    ...(pooling !== undefined && { pooling }),
    ...(no !== undefined && count !== undefined && { split: { no, count } }),
  }
}

/** The plain read for a Blob or File: one slice per read, so only the header is ever in memory. */
export function blobReader(b: Blob): ReadAt {
  return async (offset, length) => new Uint8Array(await b.slice(offset, offset + length).arrayBuffer())
}

/** wllama's shard name (its utils.ts URL_PARTS_REGEX): -NNNNN-of-NNNNN.gguf, five digits each, 1-based. */
const SHARD = /-(\d{5})-of-(\d{5})\.gguf(?:\?.*)?$/

/**
 * The order to load a model's files in, from their names: one file not named as a shard (or named -00001-of-00001)
 * loads as it is; the shards of a split model load by their number, like wllama's sortFileByShard. Refuses a shard
 * whose number is outside its count, a mix of shards and other files, shards of different models (different names
 * before the number), shards that disagree on the count, two files with the same number, and a set that is not the
 * whole model (a part missing).
 */
export function shardOrder(names: readonly string[]): { ok: true; order: number[] } | { ok: false; reason: string } {
  if (names.length === 0) return { ok: false, reason: 'no model file was chosen' }
  const parts = names.map((name) => {
    const m = SHARD.exec(name)
    return m === null ? null : { name, base: name.slice(0, m.index), no: Number(m[1]), count: Number(m[2]) }
  })
  for (const p of parts) {
    if (p !== null && (p.no < 1 || p.no > p.count)) return { ok: false, reason: `${p.name} names part ${p.no} of ${p.count}, which no split model has` }
  }
  if (names.length === 1) {
    const p = parts[0]
    if (p === null || p.count === 1) return { ok: true, order: [0] }
    return { ok: false, reason: `${p.name} is part ${p.no} of a model split into ${p.count} parts: choose all ${p.count} parts together` }
  }
  const shards: { name: string; base: string; no: number; count: number }[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p === null) return { ok: false, reason: `${names[i]} is not one part of a split model (its name does not end in -NNNNN-of-NNNNN.gguf): choose one model file, or every part of one split model` }
    shards.push(p)
  }
  const [first] = shards
  for (const p of shards) {
    if (p.base !== first.base) return { ok: false, reason: `${first.name} and ${p.name} are parts of different models: choose the parts of one model` }
    if (p.count !== first.count) return { ok: false, reason: `${first.name} and ${p.name} disagree on how many parts the model has (${first.count} and ${p.count})` }
  }
  const byNo = new Map<number, number>()
  for (let i = 0; i < shards.length; i++) {
    const seen = byNo.get(shards[i].no)
    if (seen !== undefined) return { ok: false, reason: `${shards[seen].name} and ${shards[i].name} are both part ${shards[i].no}: choose each part once` }
    byNo.set(shards[i].no, i)
  }
  // Every number is distinct and within 1..count, so the only way left to differ from the count is a part missing.
  if (first.count !== shards.length) {
    const missing: number[] = []
    for (let no = 1; no <= first.count; no++) if (!byNo.has(no)) missing.push(no)
    const list = missing.length === 1 ? `part ${missing[0]} is` : `parts ${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]} are`
    return { ok: false, reason: `this model is split into ${first.count} parts and ${shards.length} were chosen: ${list} missing` }
  }
  return { ok: true, order: shards.map((_, i) => i).sort((a, b) => shards[a].no - shards[b].no) }
}

/** llama.cpp's pooling types: 0 none (a model that writes text), 1 mean, 2 cls, 3 last, 4 rank (a reranker). */
const RANK = 4

/**
 * Whether a model writes text, from its header and its file name: refuses a GGUF version other than 2 or 3, a first
 * (or only) file that does not name its architecture, a vision projector (general.architecture "clip", the file wllama
 * sets aside as an mmproj), a model that pools its output (an embedding or reranking model), and a name localText
 * (localCompute.ts) takes for an embedding, reranking or speech model. A later shard carries only the split keys,
 * so it is judged by its version alone; the first shard speaks for the model.
 */
export function textModel(h: GgufHeader, name: string): { ok: true } | { ok: false; reason: string } {
  const refused = versionReason(h.version)
  if (refused !== null) return { ok: false, reason: refused }
  if (h.split !== undefined && h.split.no > 0) return { ok: true }
  if (h.arch === '') return { ok: false, reason: 'it does not say which architecture it is (general.architecture), so llama.cpp cannot load it' }
  if (h.arch === 'clip') return { ok: false, reason: 'it is a vision projector (an mmproj file), not a model that writes text: choose the model itself' }
  if (h.pooling !== undefined && h.pooling > 0) {
    return { ok: false, reason: `it is ${h.pooling === RANK ? 'a reranking' : 'an embedding'} model (it pools its output), not one that writes text` }
  }
  if (!localText(name)) return { ok: false, reason: `its name (${name}) says it is an embedding, reranking or speech model, not one that writes text` }
  return { ok: true }
}
