// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the GGUF header reader (gguf.ts) on real bytes: the tiny model the browser
 * smoke test loads (tools/browser/tinyGguf.mjs, the same bytes wllama ran in the spike), whole and as two shards; a
 * header with every value type, nested arrays and a large vocabulary before the chat template, read in growing chunks;
 * arrays skipped by their length (a 40 MB array costs nothing to read past); the 64 MiB limit, met by a skipped array
 * and by a walked string array, on files that exist only as the reads asked of them; a file that is not a GGUF, one
 * cut short at every kind of place, one of a version llama.cpp does not read; how shards are put in order or refused;
 * and which models are refused as writing no text.
 * What breaks if it is removed? A reader that misses the chat template behind a vocabulary, reads a whole file into
 * memory, or lets half a split model or an embedding model into the page's storage could ship unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FIRST_CHUNK, GgufError, HEADER_LIMIT, MAX_CHUNK, blobReader, readGgufHeader, shardOrder, textModel } from './gguf.ts'
import type { GgufHeader, ReadAt } from './gguf.ts'

// The writer is plain JavaScript (tools/ carries no types); a computed specifier keeps the page's typecheck off it.
const WRITER: string = '../../tools/browser/tinyGguf.mjs'
type Kv = readonly [string, number, unknown, number?]
const { tinyGguf, tinyGgufFiles, ggufBytes, ggufKvs, GGUF_TYPE: T, CHAT_TEMPLATE, sha256 } = (await import(WRITER)) as {
  tinyGguf(o?: { letter?: string; split?: boolean }): Uint8Array & Uint8Array[]
  tinyGgufFiles(o?: { letter?: string; split?: boolean }): { name: string; bytes: Uint8Array }[]
  ggufBytes(kvs: readonly Kv[], tensors?: readonly unknown[], o?: { version?: number }): Uint8Array
  ggufKvs(kvs: readonly Kv[]): Uint8Array
  GGUF_TYPE: Readonly<Record<'U8' | 'I8' | 'U16' | 'I16' | 'U32' | 'I32' | 'F32' | 'BOOL' | 'STRING' | 'ARRAY' | 'U64' | 'I64' | 'F64', number>>
  CHAT_TEMPLATE: string
  sha256(u8: Uint8Array): string
}

/** A reader over bytes in memory that records every read it is asked for. */
function memory(bytes: Uint8Array): { read: ReadAt; reads: [number, number][] } {
  const reads: [number, number][] = []
  return { reads, read: async (o, n) => { reads.push([o, n]); return bytes.slice(o, o + n) } }
}

/** A file of `size` bytes holding `parts` at their offsets and zeros elsewhere: only what is read is ever allocated. */
function sparse(parts: readonly (readonly [number, Uint8Array])[]): { read: ReadAt; reads: [number, number][] } {
  const reads: [number, number][] = []
  return {
    reads,
    read: async (o, n) => {
      reads.push([o, n])
      const out = new Uint8Array(n)
      for (const [at, b] of parts) {
        const from = Math.max(o, at), to = Math.min(o + n, at + b.length)
        if (from < to) out.set(b.subarray(from - at, to - at), from - o)
      }
      return out
    },
  }
}

/** A header's first 24 bytes: the magic, `version`, no tensors and `kvs` metadata pairs. */
function preamble(kvs: number, version = 3): Uint8Array {
  const p = ggufBytes([], [], { version }).slice(0, 24)
  new DataView(p.buffer).setBigUint64(16, BigInt(kvs), true)
  return p
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** The pairs of one array the writer lays out with `count` items, its length rewritten (its items are not written). */
function declaredArray(key: string, itemType: number, count: number | bigint): Uint8Array {
  const b = ggufKvs([[key, T.ARRAY, [], itemType]])
  new DataView(b.buffer).setBigUint64(b.length - 8, BigInt(count), true)
  return b
}

/** The reason readGgufHeader refuses with. */
async function refusal(read: ReadAt, size: number): Promise<string> {
  try {
    await readGgufHeader(read, size)
  } catch (e) {
    assert.ok(e instanceof GgufError, String(e))
    assert.equal(e.name, 'GgufError')
    assert.equal(e.message, e.reason)
    return e.reason
  }
  assert.fail('the header was read')
}

const NOT_GGUF = 'this is not a GGUF model file'
const TRUNCATED = 'the file ends inside its header'
const TOO_LARGE = 'its header is larger than 64 MiB, more than this page reads'

test('the tiny model: the spike\'s exact bytes, read whole from a File, and the letter is in the weights', async () => {
  const a = tinyGguf()
  assert.equal(a.length, 156_992)
  assert.equal(sha256(a), '2ff7b0f346b117d23a314f76714461293ac9931e0a737d3b372a57b77ff5911f')
  const file = new File([a as Uint8Array<ArrayBuffer>], 'tiny-a.gguf')
  const h = await readGgufHeader(blobReader(file), file.size)
  assert.deepEqual(h, { version: 3, arch: 'llama', name: 'tiny-a', fileType: 0, contextLength: 4096, hasTemplate: true } satisfies GgufHeader)
  assert.deepEqual(textModel(h, file.name), { ok: true })
  assert.deepEqual(shardOrder([file.name]), { ok: true, order: [0] })
  // One read: the metadata is far less than the first chunk.
  const m = memory(a)
  await readGgufHeader(m.read, a.length)
  assert.deepEqual(m.reads, [[0, FIRST_CHUNK]])
  // Another letter changes its name and the output row, nothing else: one byte of the name, then two rows of 32
  // float32s in the tensor data (1.0 is 00 00 80 3f, so two bytes of each differ), a's row ones, then b's.
  const b = tinyGguf({ letter: 'b' })
  assert.equal(b.length, a.length)
  assert.equal((await readGgufHeader(memory(b).read, b.length)).name, 'tiny-b')
  const differ = [...a.keys()].filter((i) => a[i] !== b[i])
  assert.equal(differ.length, 1 + 2 * 32 * 2)
  const rows = differ.slice(1)
  const floats = new DataView(a.buffer, a.byteOffset)
  // The name is in the header; the rows are past the token embeddings (the first tensor), float-aligned.
  assert.ok(differ[0] < 200 && rows[0] > 259 * 32 * 4 && (rows[0] - 2) % 32 === 0 && rows.every((i) => i % 4 >= 2))
  assert.equal(floats.getFloat32(rows[0] - 2, true), 1)
  assert.equal(new DataView(b.buffer, b.byteOffset).getFloat32(rows.at(-1)! - 3, true), 1)
  assert.equal(rows.at(-1)! - rows[0], 2 * 32 * 4 - 3) // from the third byte of a's first float to the last of b's last
  assert.throws(() => tinyGguf({ letter: 'ab' }), /a to z/)
})

test('the tiny model in two shards: split.no and split.count, the later shard has only the split keys, and the order comes from the names', async () => {
  const files = tinyGgufFiles({ split: true })
  assert.deepEqual(files.map((f) => [f.name, f.bytes.length]), [['tiny-a-00001-of-00002.gguf', 107_104], ['tiny-a-00002-of-00002.gguf', 50_112]])
  assert.deepEqual(tinyGguf({ split: true }).map((b: Uint8Array) => sha256(b)), files.map((f) => sha256(f.bytes)))
  const [first, second] = await Promise.all(files.map((f) => readGgufHeader(blobReader(new Blob([f.bytes as Uint8Array<ArrayBuffer>])), f.bytes.length)))
  assert.deepEqual(first, { version: 3, arch: 'llama', name: 'tiny-a', fileType: 0, contextLength: 4096, hasTemplate: true, split: { no: 0, count: 2 } })
  assert.deepEqual(second, { version: 3, arch: '', hasTemplate: false, split: { no: 1, count: 2 } })
  assert.deepEqual(textModel(first, files[0].name), { ok: true })
  assert.deepEqual(textModel(second, files[1].name), { ok: true })
  assert.deepEqual(shardOrder([files[1].name, files[0].name]), { ok: true, order: [1, 0] })
})

test('every value type, nested arrays and a large vocabulary before the chat template: read in growing chunks, the architecture\'s keys found in any order', async () => {
  const tokens = Array.from({ length: 150_000 }, (_, i) => (i % 7 === 0 ? '' : `tök${i}`))
  const kvs: Kv[] = [
    ['llama.context_length', T.U64, 32768], // before the architecture names itself
    ['mistral.context_length', T.U32, 999], // another architecture's: not this model's
    ['general.architecture', T.STRING, 'llama'],
    ['t.u8', T.U8, 255], ['t.i8', T.I8, -128], ['t.u16', T.U16, 65535], ['t.i16', T.I16, -32768],
    ['t.u32', T.U32, 2 ** 32 - 1], ['t.i32', T.I32, -(2 ** 31)], ['t.f32', T.F32, 1.5], ['t.bool', T.BOOL, true],
    ['t.string', T.STRING, 'héllo, wörld'], ['t.u64', T.U64, 2n ** 64n - 1n], ['t.i64', T.I64, -(2n ** 63n)], ['t.f64', T.F64, Math.PI],
    ['a.u8', T.ARRAY, [1, 2, 3], T.U8], ['a.i8', T.ARRAY, [-1, 2], T.I8], ['a.u16', T.ARRAY, [1, 2, 3], T.U16],
    ['a.i16', T.ARRAY, [-1], T.I16], ['a.u32', T.ARRAY, [7, 8, 9, 10, 11], T.U32], ['a.i32', T.ARRAY, [-5, 5], T.I32],
    ['a.f32', T.ARRAY, [0.5, 0.25], T.F32], ['a.bool', T.ARRAY, [true, false, true], T.BOOL],
    ['a.u64', T.ARRAY, [1n, 2n], T.U64], ['a.i64', T.ARRAY, [-1n], T.I64], ['a.f64', T.ARRAY, [1.25, 2.5, 3.75], T.F64],
    ['a.string', T.ARRAY, ['x', '', 'yz', 'ünï'], T.STRING], ['a.empty', T.ARRAY, [], T.U32], ['a.no_strings', T.ARRAY, [], T.STRING],
    ['a.nested', T.ARRAY, [[T.U32, [1, 2]], [T.STRING, ['a', 'bc']], [T.ARRAY, [[T.U8, [1]], [T.I64, []], [T.STRING, ['deep']]]]], T.ARRAY],
    ['general.name', T.STRING, 'Every Type'],
    ['general.size_label', T.STRING, '7B'],
    ['general.file_type', T.U32, 15],
    ['llama.pooling_type', T.I32, 0],
    ['split.no', T.U16, 0],
    ['split.count', T.U16, 1],
    ['tokenizer.ggml.tokens', T.ARRAY, tokens, T.STRING],
    ['tokenizer.ggml.scores', T.ARRAY, tokens.map(() => 0), T.F32],
    ['tokenizer.chat_template', T.STRING, CHAT_TEMPLATE],
  ]
  const bytes = ggufBytes(kvs)
  assert.ok(bytes.length > 2 * 1024 * 1024, `${bytes.length}`)
  const m = memory(bytes)
  const h = await readGgufHeader(m.read, bytes.length)
  assert.deepEqual(h, {
    version: 3, arch: 'llama', name: 'Every Type', sizeLabel: '7B', fileType: 15, contextLength: 32768,
    hasTemplate: true, pooling: 0, split: { no: 0, count: 1 },
  } satisfies GgufHeader)
  // Several reads, each from where the last value left off, starting at 64 KiB and doubling, none over the cap.
  const lengths = m.reads.map(([, n]) => n)
  assert.ok(m.reads.length >= 4, JSON.stringify(m.reads))
  assert.deepEqual(lengths.slice(0, 4), [FIRST_CHUNK, 2 * FIRST_CHUNK, 4 * FIRST_CHUNK, 8 * FIRST_CHUNK])
  assert.ok(lengths.every((n) => n <= MAX_CHUNK))
  for (let i = 1; i < m.reads.length; i++) assert.ok(m.reads[i][0] > m.reads[i - 1][0])
  // The whole header is read about once: a value cut by a window's end is read again, nothing more.
  assert.ok(lengths.reduce((a, n) => a + n, 0) <= bytes.length + 8 * m.reads.length)
  // The same header as version 2 (the same layout), and without a template or with an empty one.
  const v2 = bytes.slice()
  new DataView(v2.buffer).setUint32(4, 2, true)
  assert.deepEqual(await readGgufHeader(memory(v2).read, v2.length), { ...h, version: 2 })
  const small = kvs.filter(([key]) => !key.startsWith('tokenizer.'))
  const without = ggufBytes(small)
  assert.equal((await readGgufHeader(memory(without).read, without.length)).hasTemplate, false)
  const empty = ggufBytes([...small, ['tokenizer.chat_template', T.STRING, '']])
  assert.equal((await readGgufHeader(memory(empty).read, empty.length)).hasTemplate, false)
})

test('a key or a wanted string longer than 1 KiB is skipped, a wanted key of another type is ignored, a value of unknown type is refused', async () => {
  const long = 'x'.repeat(2000)
  const bytes = ggufBytes([
    [long, T.STRING, 'ignored'],
    ['general.architecture', T.STRING, 'qwen3'],
    ['general.name', T.STRING, long],
    ['general.size_label', T.U32, 7],
    ['qwen3.context_length', T.STRING, '40960'],
    ['tokenizer.chat_template', T.STRING, long],
  ])
  assert.deepEqual(await readGgufHeader(memory(bytes).read, bytes.length), { version: 3, arch: 'qwen3', hasTemplate: true })
  // Type 13 does not exist: as a value, and as an array's items.
  const bad = ggufBytes([['general.architecture', T.STRING, 'llama'], ['odd', T.U32, 0]])
  new DataView(bad.buffer).setUint32(24 + ggufKvs([['general.architecture', T.STRING, 'llama']]).length + 8 + 3, 13, true)
  assert.equal(await refusal(memory(bad).read, bad.length), 'its header holds a value of unknown type 13 (under odd)')
  const badItems = concat(preamble(1), ggufKvs([['odd', T.ARRAY, [], T.U8]]))
  new DataView(badItems.buffer).setUint32(badItems.length - 12, 13, true)
  assert.equal(await refusal(memory(badItems).read, badItems.length), 'its header holds a value of unknown type 13 (under odd)')
  // Arrays nested nine deep.
  let deep: [number, unknown] = [T.U8, [1]]
  for (let i = 0; i < 8; i++) deep = [T.ARRAY, [deep]]
  const nested = ggufBytes([['deep', T.ARRAY, deep[1], deep[0]]])
  assert.equal(await refusal(memory(nested).read, nested.length), 'its header nests arrays more than 8 deep (under deep)')
})

test('arrays are skipped by their length: past a 40 MB array to the template, reading under 1 MiB', async () => {
  const count = 10_000_000 // f32: 40 MB
  const head = concat(preamble(3), ggufKvs([['general.architecture', T.STRING, 'llama']]), declaredArray('tokenizer.ggml.scores', T.F32, count))
  const tail = ggufKvs([['tokenizer.chat_template', T.STRING, CHAT_TEMPLATE]])
  const size = head.length + count * 4 + tail.length + 1_000_000_000 // the tensors after it
  const f = sparse([[0, head], [head.length + count * 4, tail]])
  assert.deepEqual(await readGgufHeader(f.read, size), { version: 3, arch: 'llama', hasTemplate: true })
  assert.ok(f.reads.reduce((a, [, n]) => a + n, 0) < 1024 * 1024, JSON.stringify(f.reads))
})

test('the 64 MiB limit: an array that runs past it, a string array that cannot fit, and a string array walked past it', async () => {
  const GiB = 2 ** 30
  // 20 M float32s end 80 MB in: refused before anything past them is read, though the file is larger.
  const big = concat(preamble(2), declaredArray('scores', T.F32, 20_000_000))
  const f = sparse([[0, big]])
  assert.equal(await refusal(f.read, GiB), TOO_LARGE)
  assert.equal(f.reads.length, 1)
  // The same array as the last pair: refused at the skip itself, with nothing left to read.
  assert.equal(await refusal(sparse([[0, concat(preamble(1), declaredArray('scores', T.F32, 20_000_000))]]).read, GiB), TOO_LARGE)
  // 2^40 strings: their lengths alone outrun a 1 GiB file (it ends inside its header) or, in a larger one, the limit.
  const strings = concat(preamble(1), declaredArray('tokens', T.STRING, 2n ** 40n))
  assert.equal(await refusal(sparse([[0, strings]]).read, GiB), TRUNCATED)
  assert.equal(await refusal(sparse([[0, strings]]).read, 2 ** 50), TOO_LARGE)
  // A count past the safe integers.
  assert.equal(await refusal(sparse([[0, concat(preamble(1), declaredArray('tokens', T.U8, 2n ** 64n - 1n))]]).read, 2 ** 50), TRUNCATED)
  // So many pairs that even empty ones could not fit.
  assert.equal(await refusal(sparse([[0, preamble(10_000_000)]]).read, GiB), TOO_LARGE)
  // 2,000 strings of 64 KiB each (128 MiB): walked a window at a time until the walk passes the limit.
  const STEP = 64 * 1024
  const walkHead = concat(preamble(1), declaredArray('tokens', T.STRING, 2000))
  const length = new Uint8Array(8)
  new DataView(length.buffer).setBigUint64(0, BigInt(STEP - 8), true)
  const reads: [number, number][] = []
  const walk: ReadAt = async (o, n) => {
    reads.push([o, n])
    const out = new Uint8Array(n).fill(0x61)
    if (o < walkHead.length) out.set(walkHead.subarray(o, o + n))
    const base = walkHead.length
    for (let at = base + Math.max(0, Math.floor((o - base) / STEP)) * STEP; at < o + n; at += STEP) {
      for (let j = 0; j < 8; j++) if (at + j >= o && at + j < o + n) out[at + j - o] = length[j]
    }
    return out
  }
  assert.equal(await refusal(walk, GiB), TOO_LARGE)
  assert.ok(reads.every(([o, n]) => n <= MAX_CHUNK && o + n <= HEADER_LIMIT), JSON.stringify(reads.slice(-3)))
  assert.ok(reads.length > 16 && reads.at(-1)![0] > HEADER_LIMIT - MAX_CHUNK)
})

test('not a GGUF: another file\'s magic, the empty file, a few bytes', async () => {
  const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(64))
  assert.equal(await refusal(memory(png).read, png.length), NOT_GGUF)
  const lower = new TextEncoder().encode('gguf' + '\0'.repeat(60))
  assert.equal(await refusal(memory(lower).read, lower.length), NOT_GGUF)
  assert.equal(await refusal(memory(new Uint8Array(0)).read, 0), 'the file is empty')
  assert.equal(await refusal(memory(new TextEncoder().encode('GGU')).read, 3), TRUNCATED)
  assert.equal(await refusal(memory(new TextEncoder().encode('GG!')).read, 3), NOT_GGUF)
  const text = new TextEncoder().encode('{"model": "not one"}')
  const file = new File([text], 'model.gguf')
  assert.equal(await refusal(blobReader(file), file.size), NOT_GGUF)
})

test('cut short anywhere in the metadata: the file ends inside its header; cut just after it, the header still reads', async () => {
  const a = tinyGguf()
  const template = new TextEncoder().encode(CHAT_TEMPLATE)
  const kvEnd = a.findIndex((_, i) => template.every((b, j) => a[i + j] === b)) + template.length
  const tokens = a.findIndex((_, i) => a[i] === 0x3c && a[i + 1] === 0x30 && a[i + 2] === 0x78) // inside "<0x00>"
  assert.ok(kvEnd > 1000 && tokens > 0 && tokens < kvEnd)
  for (const cut of [1, 3, 4, 6, 8, 12, 16, 23, 24, 30, 60, tokens, tokens + 1000, kvEnd - template.length, kvEnd - 1]) {
    const part = a.slice(0, cut)
    assert.equal(await refusal(memory(part).read, cut), TRUNCATED, `cut at ${cut}`)
  }
  assert.equal((await readGgufHeader(memory(a.slice(0, kvEnd)).read, kvEnd)).hasTemplate, true)
  // A file that shrank after its size was taken: a read comes back short.
  const shrunk: ReadAt = async (o, n) => a.slice(o, Math.min(o + n, 500))
  assert.equal(await refusal(shrunk, a.length), TRUNCATED)
  // A read that fails is a refusal with its reason, the failure kept as the cause.
  const gone = new DOMException('The requested file could not be read', 'NotReadableError')
  await assert.rejects(readGgufHeader(async () => { throw gone }, a.length), (e: unknown) => {
    assert.ok(e instanceof GgufError)
    assert.equal(e.reason, 'the file could not be read (The requested file could not be read)')
    assert.equal(e.cause, gone)
    return true
  })
})

test('versions: 1 and 0 too old, 4 newer, a big-endian file named as one, 2 and 3 read', async () => {
  const kvs: Kv[] = [['general.architecture', T.STRING, 'llama']]
  const version = (v: number): Uint8Array => ggufBytes(kvs, [], { version: v })
  const old = 'which llama.cpp no longer reads: convert it again with a current llama.cpp'
  assert.equal(await refusal(memory(version(1)).read, version(1).length), `it is GGUF version 1, ${old}`)
  assert.equal(await refusal(memory(version(0)).read, version(0).length), `it is GGUF version 0, ${old}`)
  assert.equal(await refusal(memory(version(4)).read, version(4).length), 'it is GGUF version 4, newer than this page reads (2 and 3)')
  assert.equal(await refusal(memory(version(0x03000000)).read, 64), 'it is a big-endian GGUF, and this page reads only little-endian ones')
  assert.equal((await readGgufHeader(memory(version(2)).read, version(2).length)).version, 2)
  assert.equal((await readGgufHeader(memory(version(3)).read, version(3).length)).version, 3)
  const h: GgufHeader = { version: 1, arch: 'llama', hasTemplate: true }
  assert.deepEqual(textModel(h, 'm.gguf'), { ok: false, reason: `it is GGUF version 1, ${old}` })
})

test('shardOrder: one file, the parts of one model in any order, and every set that is not one whole model', () => {
  const refused = (names: string[]): string => {
    const r = shardOrder(names)
    assert.equal(r.ok, false, JSON.stringify(names))
    return (r as { reason: string }).reason
  }
  assert.deepEqual(shardOrder(['Qwen3-4B-Q4_K_M.gguf']), { ok: true, order: [0] })
  assert.deepEqual(shardOrder(['model-00001-of-00001.gguf']), { ok: true, order: [0] })
  // wllama's pattern exactly: five digits, lower-case, at the end; anything else is a plain name.
  assert.deepEqual(shardOrder(['model-0001-of-0002.gguf']), { ok: true, order: [0] })
  assert.deepEqual(shardOrder(['model-00001-of-00002.GGUF']), { ok: true, order: [0] })
  assert.deepEqual(shardOrder(['m-00003-of-00003.gguf', 'm-00001-of-00003.gguf', 'm-00002-of-00003.gguf']), { ok: true, order: [1, 2, 0] })
  assert.deepEqual(shardOrder(['m-00001-of-00002.gguf', 'm-00002-of-00002.gguf']), { ok: true, order: [0, 1] })

  assert.equal(refused([]), 'no model file was chosen')
  assert.equal(refused(['m-00002-of-00003.gguf']), 'm-00002-of-00003.gguf is part 2 of a model split into 3 parts: choose all 3 parts together')
  assert.equal(refused(['m-00000-of-00002.gguf', 'm-00001-of-00002.gguf']), 'm-00000-of-00002.gguf names part 0 of 2, which no split model has')
  assert.equal(refused(['m-00003-of-00002.gguf']), 'm-00003-of-00002.gguf names part 3 of 2, which no split model has')
  // A gap, and a count larger than the files chosen.
  assert.equal(refused(['m-00001-of-00003.gguf', 'm-00003-of-00003.gguf']), 'this model is split into 3 parts and 2 were chosen: part 2 is missing')
  assert.equal(refused(['m-00004-of-00005.gguf', 'm-00001-of-00005.gguf']), 'this model is split into 5 parts and 2 were chosen: parts 2, 3 and 5 are missing')
  // A duplicate: the right number of files, one part twice.
  assert.equal(refused(['m-00001-of-00002.gguf', 'm-00001-of-00002.gguf']), 'm-00001-of-00002.gguf and m-00001-of-00002.gguf are both part 1: choose each part once')
  // Mixed prefixes, mixed counts, a part beside a plain file, two plain files.
  assert.equal(refused(['a-00001-of-00002.gguf', 'b-00002-of-00002.gguf']), 'a-00001-of-00002.gguf and b-00002-of-00002.gguf are parts of different models: choose the parts of one model')
  assert.equal(refused(['m-00001-of-00002.gguf', 'm-00002-of-00003.gguf']), 'm-00001-of-00002.gguf and m-00002-of-00003.gguf disagree on how many parts the model has (2 and 3)')
  assert.equal(refused(['m-00001-of-00002.gguf', 'other.gguf']), 'other.gguf is not one part of a split model (its name does not end in -NNNNN-of-NNNNN.gguf): choose one model file, or every part of one split model')
  assert.match(refused(['a.gguf', 'b.gguf']), /^a\.gguf is not one part of a split model/)
})

test('textModel: a model that writes text, and the embedding, reranking, projector and nameless ones it refuses', async () => {
  const text: GgufHeader = { version: 3, arch: 'qwen3', name: 'Qwen3 4B', contextLength: 40960, hasTemplate: true }
  assert.deepEqual(textModel(text, 'Qwen3-4B-Q4_K_M.gguf'), { ok: true })
  // Pooling none (0) and unspecified (-1) are a text model's; mean, cls and last are an embedding model's; rank a reranker's.
  assert.deepEqual(textModel({ ...text, pooling: 0 }, 'm.gguf'), { ok: true })
  assert.deepEqual(textModel({ ...text, pooling: -1 }, 'm.gguf'), { ok: true })
  for (const pooling of [1, 2, 3]) {
    assert.deepEqual(textModel({ ...text, pooling }, 'Qwen3-4B.gguf'), { ok: false, reason: 'it is an embedding model (it pools its output), not one that writes text' })
  }
  assert.deepEqual(textModel({ ...text, pooling: 4 }, 'Qwen3-4B.gguf'), { ok: false, reason: 'it is a reranking model (it pools its output), not one that writes text' })
  // Names localText (localCompute.ts) takes for models that write no text, with or without a folder in front.
  for (const name of ['bge-m3-Q8_0.gguf', 'nomic-embed-text-v1.5.Q4_K_M.gguf', 'models/whisper-small.gguf', 'jina-reranker-v2.gguf', 'multilingual-e5-small.gguf']) {
    assert.deepEqual(textModel(text, name), { ok: false, reason: `its name (${name}) says it is an embedding, reranking or speech model, not one that writes text` })
  }
  assert.deepEqual(textModel({ ...text, arch: 'clip' }, 'mmproj-model-f16.gguf'), { ok: false, reason: 'it is a vision projector (an mmproj file), not a model that writes text: choose the model itself' })
  assert.deepEqual(textModel({ version: 3, arch: '', hasTemplate: false }, 'm.gguf'), { ok: false, reason: 'it does not say which architecture it is (general.architecture), so llama.cpp cannot load it' })
  // An embedding model as its header says it, read from bytes.
  const bert = ggufBytes([['general.architecture', T.STRING, 'bert'], ['bert.context_length', T.U32, 512], ['bert.pooling_type', T.U32, 2]])
  const h = await readGgufHeader(memory(bert).read, bert.length)
  assert.deepEqual(h, { version: 3, arch: 'bert', contextLength: 512, hasTemplate: false, pooling: 2 })
  assert.equal(textModel(h, 'model.gguf').ok, false)
})

test('blobReader reads the slice asked for, and less only at the end of the file', async () => {
  const blob = new Blob([Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)])
  const read = blobReader(blob)
  assert.deepEqual([...(await read(2, 3))], [3, 4, 5])
  assert.deepEqual([...(await read(6, 10))], [7, 8])
  assert.deepEqual([...(await read(8, 4))], [])
})
