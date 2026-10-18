#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It writes the smallest model the in-page runtime (wllama's build of llama.cpp) will load
 * and run, so the browser smoke test and the unit tests have a real GGUF file without downloading one. It is a GGUF
 * v3 "llama" model of about 157 KB whose greedy decoding writes one letter on every step until max_tokens, so a test
 * knows the exact text before it asks:
 * - vocabulary: SPM ("llama") with byte fallback, 259 tokens: <unk>, <s>, </s>, then <0x00>..<0xFF> typed BYTE;
 * - shape: n_embd 32, 2 layers, 2 heads (head size 16), ffn 64, context_length 4096, every tensor f32;
 * - weights: every token embedding is all ones; every attention and FFN weight is zero, so no block adds anything to
 *   the residual stream; every norm weight is one; output.weight is zero except the row of the letter's byte token,
 *   which is all ones. The last hidden state is rmsnorm(ones) = ones, so the letter's logit is 32 and every other is 0.
 *   The text therefore comes from the weights (the letter 'b' writes "bbbb"), never from the prompt, and the model
 *   never writes its end-of-text token: it proves the plumbing and the stream, not a template, attention or stopping;
 * - a minimal tokenizer.chat_template, and an optional split into two gguf-split shards (split.no u16, split.count
 *   u16, split.tensors.count i32) named -00001-of-00002 and -00002-of-00002.
 * The bytes are deterministic: the 'a' model is 156,992 B with sha256 2ff7b0f3…5911f, its shards 107,104 B and
 * 50,112 B. wllama 3.8.1 (llama.cpp b11364) loads both forms. The writer under it, ggufBytes, also writes any
 * metadata a test needs (every GGUF value type, nested arrays), for src/09_Cognition/gguf.test.ts, and ggufKvs the
 * metadata pairs alone.
 *   node tools/browser/tinyGguf.mjs <outDir> [--split]   writes tiny-a.gguf, or its two shards with --split
 * The files are written to a run's temporary folder; they are never committed or shipped. Node only, no dependencies.
 * What breaks if it is removed? The in-page model has nothing to load in CI, and the GGUF header reader is tested only
 * on bytes written by hand.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** GGUF metadata value types (ggml's gguf.h). */
export const GGUF_TYPE = Object.freeze({ U8: 0, I8: 1, U16: 2, I16: 3, U32: 4, I32: 5, F32: 6, BOOL: 7, STRING: 8, ARRAY: 9, U64: 10, I64: 11, F64: 12 })
const T = GGUF_TYPE
const GGML_TYPE_F32 = 0
const ALIGN = 32

export const HPARAMS = Object.freeze({
  nVocab: 259, nEmbd: 32, nLayer: 2, nHead: 2, nHeadKv: 2, nFf: 64, nCtxTrain: 4096, eps: 1e-5, ropeBase: 10000,
})
/** The token id of a byte token <0xNN>: three special tokens come first. */
export const byteToken = (byte) => 3 + byte

export const CHAT_TEMPLATE =
  "{% for message in messages %}{{ '<|im_start|>' + message['role'] + '\\n' + message['content'] + '<|im_end|>' + '\\n' }}{% endfor %}" +
  "{% if add_generation_prompt %}{{ '<|im_start|>assistant\\n' }}{% endif %}"

const utf8 = new TextEncoder()

class Buf {
  constructor() { this.parts = []; this.length = 0 }
  push(u8) { this.parts.push(u8); this.length += u8.length }
  num(size, set, v) { const b = new Uint8Array(size); set(new DataView(b.buffer), v); this.push(b) }
  u8(v) { this.push(Uint8Array.of(v)) }
  i8(v) { this.num(1, (d, x) => d.setInt8(0, x), v) }
  u16(v) { this.num(2, (d, x) => d.setUint16(0, x, true), v) }
  i16(v) { this.num(2, (d, x) => d.setInt16(0, x, true), v) }
  u32(v) { this.num(4, (d, x) => d.setUint32(0, x, true), v) }
  i32(v) { this.num(4, (d, x) => d.setInt32(0, x, true), v) }
  u64(v) { this.num(8, (d, x) => d.setBigUint64(0, BigInt(x), true), v) }
  i64(v) { this.num(8, (d, x) => d.setBigInt64(0, BigInt(x), true), v) }
  f32(v) { this.num(4, (d, x) => d.setFloat32(0, x, true), v) }
  f64(v) { this.num(8, (d, x) => d.setFloat64(0, x, true), v) }
  str(s) { const e = utf8.encode(s); this.u64(e.length); this.push(e) }
  pad(align) { const r = this.length % align; if (r) this.push(new Uint8Array(align - r)) }
  bytes() { const out = new Uint8Array(this.length); let o = 0; for (const p of this.parts) { out.set(p, o); o += p.length } return out }
}

function writeScalar(b, type, v) {
  switch (type) {
    case T.U8: return b.u8(v)
    case T.I8: return b.i8(v)
    case T.U16: return b.u16(v)
    case T.I16: return b.i16(v)
    case T.U32: return b.u32(v)
    case T.I32: return b.i32(v)
    case T.F32: return b.f32(v)
    case T.BOOL: return b.u8(v ? 1 : 0)
    case T.STRING: return b.str(v)
    case T.U64: return b.u64(v)
    case T.I64: return b.i64(v)
    case T.F64: return b.f64(v)
    default: throw new Error(`unsupported scalar type ${type}`)
  }
}

/** An array value: its item type, its length, its items. An item of an array of arrays is `[itemType, items]`. */
function writeArray(b, itemType, items) {
  b.u32(itemType)
  b.u64(items.length)
  for (const v of items) {
    if (itemType === T.ARRAY) writeArray(b, v[0], v[1])
    else writeScalar(b, itemType, v)
  }
}

/** kv: [key, type, value, itemType?] (itemType for an array). */
function writeKv(b, [key, type, value, itemType]) {
  b.str(key)
  b.u32(type)
  if (type === T.ARRAY) writeArray(b, itemType, value)
  else writeScalar(b, type, value)
}

function f32Tensor(name, dims, fill) {
  const n = dims.reduce((a, d) => a * d, 1)
  const data = new Float32Array(n)
  if (typeof fill === 'number') data.fill(fill)
  else fill(data)
  return { name, dims, data }
}

function tensors(token) {
  const { nVocab, nEmbd, nLayer, nFf } = HPARAMS
  const out = [
    // ggml order: ne0 (fastest) first. token_embd is [n_embd, n_vocab]: one contiguous row of n_embd per token.
    f32Tensor('token_embd.weight', [nEmbd, nVocab], 1),
    f32Tensor('output_norm.weight', [nEmbd], 1),
    f32Tensor('output.weight', [nEmbd, nVocab], (d) => d.fill(1, token * nEmbd, (token + 1) * nEmbd)),
  ]
  for (let i = 0; i < nLayer; i++) {
    const p = `blk.${i}.`
    out.push(
      f32Tensor(p + 'attn_norm.weight', [nEmbd], 1),
      f32Tensor(p + 'attn_q.weight', [nEmbd, nEmbd], 0),
      f32Tensor(p + 'attn_k.weight', [nEmbd, nEmbd], 0),
      f32Tensor(p + 'attn_v.weight', [nEmbd, nEmbd], 0),
      f32Tensor(p + 'attn_output.weight', [nEmbd, nEmbd], 0),
      f32Tensor(p + 'ffn_norm.weight', [nEmbd], 1),
      f32Tensor(p + 'ffn_gate.weight', [nEmbd, nFf], 0),
      f32Tensor(p + 'ffn_up.weight', [nEmbd, nFf], 0),
      f32Tensor(p + 'ffn_down.weight', [nFf, nEmbd], 0),
    )
  }
  return out
}

function modelKvs(letter) {
  const h = HPARAMS
  const tokens = ['<unk>', '<s>', '</s>']
  const types = [2, 3, 3] // UNKNOWN, CONTROL, CONTROL
  for (let i = 0; i < 256; i++) { tokens.push(`<0x${i.toString(16).toUpperCase().padStart(2, '0')}>`); types.push(6) } // BYTE
  const scores = tokens.map(() => 0)
  return [
    ['general.architecture', T.STRING, 'llama'],
    ['general.name', T.STRING, `tiny-${letter}`],
    ['general.file_type', T.U32, 0], // ALL_F32
    ['general.alignment', T.U32, ALIGN],
    ['llama.vocab_size', T.U32, h.nVocab],
    ['llama.context_length', T.U32, h.nCtxTrain],
    ['llama.embedding_length', T.U32, h.nEmbd],
    ['llama.block_count', T.U32, h.nLayer],
    ['llama.feed_forward_length', T.U32, h.nFf],
    ['llama.attention.head_count', T.U32, h.nHead],
    ['llama.attention.head_count_kv', T.U32, h.nHeadKv],
    ['llama.rope.dimension_count', T.U32, h.nEmbd / h.nHead],
    ['llama.rope.freq_base', T.F32, h.ropeBase],
    ['llama.attention.layer_norm_rms_epsilon', T.F32, h.eps],
    ['tokenizer.ggml.model', T.STRING, 'llama'],
    ['tokenizer.ggml.tokens', T.ARRAY, tokens, T.STRING],
    ['tokenizer.ggml.scores', T.ARRAY, scores, T.F32],
    ['tokenizer.ggml.token_type', T.ARRAY, types, T.I32],
    ['tokenizer.ggml.unknown_token_id', T.U32, 0],
    ['tokenizer.ggml.bos_token_id', T.U32, 1],
    ['tokenizer.ggml.eos_token_id', T.U32, 2],
    ['tokenizer.ggml.add_bos_token', T.BOOL, true],
    ['tokenizer.ggml.add_eos_token', T.BOOL, false],
    ['tokenizer.chat_template', T.STRING, CHAT_TEMPLATE],
  ]
}

/** The encoded metadata pairs alone ([key, type, value, itemType?] each), for a test that lays out a header itself. */
export function ggufKvs(kvs) {
  const b = new Buf()
  for (const kv of kvs) writeKv(b, kv)
  return b.bytes()
}

/**
 * A GGUF file: the header (magic, version, tensor and metadata counts), the metadata `kvs` ([key, type, value,
 * itemType?] each), the tensor infos, then the f32 tensor data, every tensor aligned to 32 bytes. `version` only sets
 * the version field (the layout is always v2/v3's: 64-bit counts and string lengths), so a test can write a header a
 * reader must refuse.
 */
export function ggufBytes(kvs, tensorList = [], { version = 3 } = {}) {
  const b = new Buf()
  b.push(utf8.encode('GGUF'))
  b.u32(version)
  b.u64(tensorList.length)
  b.u64(kvs.length)
  b.push(ggufKvs(kvs))
  let offset = 0
  for (const t of tensorList) {
    b.str(t.name)
    b.u32(t.dims.length)
    for (const d of t.dims) b.u64(d)
    b.u32(GGML_TYPE_F32)
    b.u64(offset)
    const size = t.data.byteLength
    offset += size + ((ALIGN - (size % ALIGN)) % ALIGN)
  }
  b.pad(ALIGN)
  for (const t of tensorList) {
    b.push(new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength))
    b.pad(ALIGN)
  }
  return b.bytes()
}

/**
 * The tiny model's files with their names: `tiny-<letter>.gguf`, or with `split` its two shards
 * `tiny-<letter>-00001-of-00002.gguf` (all the metadata and the first half of the tensors) and
 * `tiny-<letter>-00002-of-00002.gguf` (only the split keys and the rest). `letter` is a lower-case a to z.
 */
export function tinyGgufFiles({ letter = 'a', split = false } = {}) {
  if (typeof letter !== 'string' || !/^[a-z]$/.test(letter)) throw new Error(`the letter must be one of a to z, not ${JSON.stringify(letter)}`)
  const all = tensors(byteToken(letter.charCodeAt(0)))
  if (!split) return [{ name: `tiny-${letter}.gguf`, bytes: ggufBytes(modelKvs(letter), all) }]
  const cut = Math.ceil(all.length / 2)
  const splitKvs = (no) => [
    ['split.no', T.U16, no],
    ['split.count', T.U16, 2],
    ['split.tensors.count', T.I32, all.length],
  ]
  return [
    { name: `tiny-${letter}-00001-of-00002.gguf`, bytes: ggufBytes([...modelKvs(letter), ...splitKvs(0)], all.slice(0, cut)) },
    { name: `tiny-${letter}-00002-of-00002.gguf`, bytes: ggufBytes(splitKvs(1), all.slice(cut)) },
  ]
}

/** The tiny model's bytes: one file, or with `split` its two shards in order. */
export function tinyGguf({ letter = 'a', split = false } = {}) {
  const files = tinyGgufFiles({ letter, split }).map((f) => f.bytes)
  return split ? files : files[0]
}

export const sha256 = (u8) => createHash('sha256').update(u8).digest('hex')

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2)
  const outDir = args.find((a) => !a.startsWith('--'))
  if (!outDir || args.some((a) => a.startsWith('--') && a !== '--split')) {
    console.error('usage: node tools/browser/tinyGguf.mjs <outDir> [--split]')
    process.exit(2)
  }
  mkdirSync(outDir, { recursive: true })
  for (const f of tinyGgufFiles({ split: args.includes('--split') })) {
    writeFileSync(join(outDir, f.name), f.bytes)
    console.log(`${f.name}\t${f.bytes.length} B\tsha256 ${sha256(f.bytes)}`)
  }
}
