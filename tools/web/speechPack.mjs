#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It puts the speech pack beside the web copy (dist-web/speech/): the four files the page's
 * own speech recogniser runs (src/09_Cognition/speechPack.ts SPEECH_PACK: the runtime's WebAssembly module, the
 * model's encoder and decoder, its vocabulary), with a manifest that names exactly the page's pin and the licences of
 * the model and the runtime beside them. The pack is what lets the microphone understand words in any browser that
 * can run it, on the visitor's own device. The pin is the page's own, so the page and the folder can never disagree about what is
 * served. Each file comes from one place, written down here (SOURCES) and in third_party/:
 *   - the runtime's module: the installed npm package onnxruntime-web (this project's dependency, pinned exactly);
 *   - the model's two files: the npm registry tarball of @moonshine-ai/moonshine-js 0.1.29 (MIT; only the two model
 *     files are taken: the package's code is not used and it is not a dependency);
 *   - the vocabulary: third_party/moonshine-tiny-en/tokens.json, committed.
 * Usage:
 *   node tools/web/speechPack.mjs pin                         the pin as KEY=value lines (for $GITHUB_OUTPUT): key,
 *                                                             url, file, bytes, sha256 (the model's tarball)
 *   node tools/web/speechPack.mjs fetch --to <dir>            downloads the tarball with curl (unless <dir> already
 *                                                             holds it whole) and unpacks the two model files
 *   node tools/web/speechPack.mjs unpack --tarball <file> --to <dir>
 *                                                             checks the tarball's size and SHA-256, takes the two
 *                                                             model files out of it, checks each against the pin
 *   node tools/web/speechPack.mjs check --from <dir>          all four files are exactly the pin's (the model's two in
 *                                                             <dir>, the runtime's in node_modules, the vocabulary
 *                                                             in third_party/)
 *   node tools/web/speechPack.mjs place --from <dir> --out dist-web
 *                                                             the same check while copying them into dist-web/speech/,
 *                                                             then manifest.json and the licences beside them
 *   node tools/web/speechPack.mjs read --from <dir> <clip.wav>...
 *                                                             reads 16-bit PCM WAV clips with the pack, under Node,
 *                                                             through the page's own detector, tap and reader, and
 *                                                             prints what each says (--expect "<words>" exits 1
 *                                                             unless every word is in what was read)
 *   node tools/web/speechPack.mjs tokens <tokenizer.json>     writes third_party/moonshine-tiny-en/tokens.json from
 *                                                             the model's tokenizer file (once per model)
 * Nothing is written unless every byte matches: a copy goes to a .part file, renamed into place once its hash is right.
 * What breaks if it is removed? The web copy serves no speech pack, so the microphone understands words only where
 * the browser brings its own on-device recogniser (not on a phone, not in Safari).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { SPEECH_DIR, SPEECH_PACK, speechFile, speechManifestText } from '../../src/09_Cognition/speechPack.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Where each file of the pack comes from. */
export const SOURCES = Object.freeze({
  /** The runtime's module, inside the installed package (package.json pins the version exactly). */
  runtime: Object.freeze({ package: 'onnxruntime-web', version: '1.31.1', path: 'dist/ort-wasm-simd-threaded.wasm', licence: join(ROOT, 'third_party', 'onnxruntime-web', '1.31.1') }),
  /** The model's two files, inside the registry's tarball of the package (its size and SHA-256 pinned here). */
  model: Object.freeze({
    package: '@moonshine-ai/moonshine-js',
    version: '0.1.29',
    url: 'https://registry.npmjs.org/@moonshine-ai/moonshine-js/-/moonshine-js-0.1.29.tgz',
    file: 'moonshine-js-0.1.29.tgz',
    bytes: 21_514_347,
    sha256: '864e17a00ed494857c71693e835306fa038e0f82002c76e3056d67d574e1c2d8',
    paths: Object.freeze({ encoder: 'package/dist/model/tiny/quantized/encoder_model.onnx', decoder: 'package/dist/model/tiny/quantized/decoder_model_merged.onnx' }),
    licence: join(ROOT, 'third_party', 'moonshine-tiny-en'),
  }),
  /** The vocabulary, committed beside the model's licence. */
  tokens: join(ROOT, 'third_party', 'moonshine-tiny-en', 'tokens.json'),
})

/** The licence files placed beside the pack, each under the name it is served by. */
export const LICENCE_FILES = Object.freeze([
  ['MODEL-LICENSE', join(SOURCES.model.licence, 'LICENSE')],
  ['MODEL-NOTICE', join(SOURCES.model.licence, 'NOTICE')],
  ['RUNTIME-LICENSE', join(SOURCES.runtime.licence, 'LICENSE')],
  ['RUNTIME-NOTICE', join(SOURCES.runtime.licence, 'NOTICE')],
  ['RUNTIME-ThirdPartyNotices.txt', join(SOURCES.runtime.licence, 'ThirdPartyNotices.txt')],
  ['RUNTIME-EMSCRIPTEN-NOTICES.txt', join(SOURCES.runtime.licence, 'EMSCRIPTEN-NOTICES.txt')],
])

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** The cache key for the model's files: the tarball's hash and the pack's id (a new pin of either misses the cache). */
export function cacheKey() {
  return `speech-pack-${SOURCES.model.sha256.slice(0, 32)}-${sha256(Buffer.from(speechManifestText())).slice(0, 16)}`
}

/** The pin as the workflow's outputs. */
export function pinLines() {
  return [`key=${cacheKey()}`, `url=${SOURCES.model.url}`, `file=${SOURCES.model.file}`, `bytes=${SOURCES.model.bytes}`, `sha256=${SOURCES.model.sha256}`]
}

/** Why `bytes` is not the pinned file `f`, or null. */
function mismatch(bytes, f) {
  if (bytes.length !== f.bytes) return `${f.file} is ${bytes.length} bytes; the pin says ${f.bytes}`
  const got = sha256(bytes)
  if (got !== f.sha256) return `${f.file} has SHA-256 ${got}; the pin says ${f.sha256}`
  return null
}

/** The files of a tar archive (ustar; the names npm writes are short and plain) by path. */
export function untar(tar, wanted) {
  const out = new Map()
  for (let at = 0; at + 512 <= tar.length;) {
    const head = tar.subarray(at, at + 512)
    if (head.every((b) => b === 0)) break
    const name = head.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
    const prefix = head.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '')
    const size = Number.parseInt(head.subarray(124, 136).toString('latin1').replace(/[\0 ]+$/, '') || '0', 8)
    const type = String.fromCharCode(head[156] || 48)
    const path = prefix ? `${prefix}/${name}` : name
    if (!Number.isFinite(size) || size < 0) throw new Error(`the archive is not a tar file (an entry of size ${size})`)
    if ((type === '0' || type === '\0') && wanted.includes(path)) out.set(path, tar.subarray(at + 512, at + 512 + size))
    at += 512 + Math.ceil(size / 512) * 512
  }
  return out
}

/**
 * Takes the model's two files out of the registry tarball at `tarball` into `to`, each checked against the pin, after
 * the tarball's own size and SHA-256. Resolves to the files written.
 */
export function unpack({ tarball, to }) {
  if (!existsSync(tarball)) throw new Error(`${tarball} is missing`)
  const tgz = readFileSync(tarball)
  if (tgz.length !== SOURCES.model.bytes) throw new Error(`${tarball} is ${tgz.length} bytes; the pin says ${SOURCES.model.bytes}`)
  const got = sha256(tgz)
  if (got !== SOURCES.model.sha256) throw new Error(`${tarball} has SHA-256 ${got}; the pin says ${SOURCES.model.sha256}`)
  const files = untar(gunzipSync(tgz), Object.values(SOURCES.model.paths))
  mkdirSync(to, { recursive: true })
  const written = []
  for (const role of ['encoder', 'decoder']) {
    const f = speechFile(role)
    const bytes = files.get(SOURCES.model.paths[role])
    if (!bytes) throw new Error(`${tarball} holds no ${SOURCES.model.paths[role]}`)
    const no = mismatch(bytes, f)
    if (no) throw new Error(no)
    const part = join(to, `${f.file}.part`)
    writeFileSync(part, bytes)
    renameSync(part, join(to, f.file))
    written.push(f.file)
  }
  return written
}

/** Downloads the tarball into `to` with curl (unless it is there whole) and unpacks it. */
export function fetchPack({ to }) {
  mkdirSync(to, { recursive: true })
  const tarball = join(to, SOURCES.model.file)
  const whole = existsSync(tarball) && statSync(tarball).size === SOURCES.model.bytes && sha256(readFileSync(tarball)) === SOURCES.model.sha256
  if (!whole) {
    execFileSync('curl', ['--proto', '=https', '--tlsv1.2', '-sSfL', '--retry', '4', '--retry-all-errors', '--retry-delay', '5', SOURCES.model.url, '-o', `${tarball}.part`], { stdio: ['ignore', 'inherit', 'inherit'] })
    renameSync(`${tarball}.part`, tarball)
  }
  return unpack({ tarball, to })
}

/** Where each file of the pack is read from, given the folder with the model's two files. */
export function sourcesOf(from, root = ROOT) {
  return {
    runtime: join(root, 'node_modules', SOURCES.runtime.package, SOURCES.runtime.path),
    encoder: join(from, speechFile('encoder').file),
    decoder: join(from, speechFile('decoder').file),
    tokens: SOURCES.tokens,
  }
}

/** Throws unless all four files are exactly the pin's; resolves to their bytes by role. */
export function checkPack({ from, root = ROOT }) {
  const version = JSON.parse(readFileSync(join(root, 'node_modules', SOURCES.runtime.package, 'package.json'), 'utf8')).version
  if (version !== SOURCES.runtime.version) throw new Error(`${SOURCES.runtime.package} ${version} is installed; the speech pack is pinned to ${SOURCES.runtime.version}`)
  const where = sourcesOf(from, root)
  const out = {}
  for (const f of SPEECH_PACK.files) {
    const file = where[f.role]
    if (!existsSync(file)) throw new Error(`${file} is missing${f.role === 'encoder' || f.role === 'decoder' ? ' (node tools/web/speechPack.mjs fetch --to <dir> gets it)' : ''}`)
    const bytes = readFileSync(file)
    const no = mismatch(bytes, f)
    if (no) throw new Error(no)
    out[f.role] = bytes
  }
  return out
}

/**
 * Copies the pack into `<out>/speech/` while checking it, then writes the manifest and the licences beside it.
 * Refuses a folder that is not the web copy (its index.html names no web app manifest: dist/ never gets a pack) and
 * leaves nothing behind when a check fails. Resolves to the files written, relative to `out`.
 */
export function placePack({ from, out, root = ROOT }) {
  const page = join(out, 'index.html')
  if (!existsSync(page) || !readFileSync(page, 'utf8').includes('rel="manifest"')) {
    throw new Error(`${out} is not the web copy (tools/web/pwa.mjs writes it): the speech pack goes beside that page only`)
  }
  const dir = join(out, SPEECH_DIR)
  rmSync(dir, { recursive: true, force: true })
  const bytes = checkPack({ from, root })
  mkdirSync(dir, { recursive: true })
  const written = []
  for (const f of SPEECH_PACK.files) {
    writeFileSync(join(dir, f.file), bytes[f.role])
    written.push(f.file)
  }
  writeFileSync(join(dir, 'manifest.json'), speechManifestText())
  written.push('manifest.json')
  for (const [name, src] of LICENCE_FILES) {
    copyFileSync(src, join(dir, name))
    written.push(name)
  }
  return written.map((f) => `${SPEECH_DIR}${f}`)
}

/** A WAV file's first channel and its rate: 8, 16, 24 or 32-bit integer or 32 or 64-bit float samples, plain or
 *  extensible (WAVE_FORMAT_EXTENSIBLE); anything else is refused with a plain sentence. */
export function readWav(path) {
  const b = readFileSync(path)
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') throw new Error(`${path} is not a WAV file`)
  let at = 12, rate = 0, channels = 1, bits = 16, format = 1, data = null
  while (at + 8 <= b.length) {
    const id = b.toString('latin1', at, at + 4), n = b.readUInt32LE(at + 4)
    if (id === 'fmt ') {
      format = b.readUInt16LE(at + 8); channels = b.readUInt16LE(at + 10); rate = b.readUInt32LE(at + 12); bits = b.readUInt16LE(at + 22)
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of its sub-format GUID (1 integer, 3 float).
      if (format === 0xfffe && n >= 40) format = b.readUInt16LE(at + 8 + 24)
    }
    // A writer that streamed the file leaves the data's size unset: the rest of the file is the data.
    if (id === 'data') { data = b.subarray(at + 8, n === 0xffffffff || at + 8 + n > b.length ? b.length : at + 8 + n); break }
    at += 8 + n + (n & 1)
  }
  if (!data || !rate) throw new Error(`${path} has no audio`)
  const ok = format === 1 ? [8, 16, 24, 32].includes(bits) : format === 3 ? bits === 32 || bits === 64 : false
  if (!ok || channels < 1) throw new Error(`${path} is a WAV this tool does not read (format ${format}, ${bits}-bit, ${channels} channels): use 8, 16, 24 or 32-bit integer or 32 or 64-bit float samples`)
  const width = bits / 8
  const n = Math.floor(data.length / width / channels)
  const samples = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * width * channels
    samples[i] = format === 3 ? (bits === 64 ? data.readDoubleLE(o) : data.readFloatLE(o))
      : bits === 16 ? data.readInt16LE(o) / 32768 : bits === 8 ? (data[o] - 128) / 128 : bits === 24 ? data.readIntLE(o, 3) / 8388608 : data.readInt32LE(o) / 2147483648
  }
  return { rate, samples }
}

/**
 * Reads WAV clips with the pack under Node, the way the page does: the detector and the tap cut the clip into
 * utterances (a second of quiet room before it and two after, as a microphone would have), the pack's model reads
 * each. Resolves to one entry per clip: what was read, joined, and each utterance's numbers.
 */
export async function readClips({ from, clips, root = ROOT }) {
  const bytes = checkPack({ from, root })
  const { VAD, VadCore, vadFrame } = await import('../../src/04_Connect_Hardware/vad.ts')
  const { UtteranceTap, utteranceOptions } = await import('../../src/04_Connect_Hardware/utterance.ts')
  const { parseVocabulary, readUtterance } = await import('../../src/09_Cognition/speechCore.ts')
  const { ortConfigure, ortRuntime } = await import('../../src/09_Cognition/speechOrt.ts')
  const ort = await import('onnxruntime-web/wasm')
  const buf = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  ortConfigure(ort, buf(bytes.runtime))
  const rt = await ortRuntime(ort, buf(bytes.encoder), buf(bytes.decoder))
  const vocab = parseVocabulary(bytes.tokens.toString('utf8'))
  const room = (seconds, rate, seed) => {
    const o = new Float32Array(Math.round(seconds * rate))
    let x = seed
    for (let i = 0; i < o.length; i++) { x = (x * 1664525 + 1013904223) >>> 0; o[i] = (x / 0xffffffff - 0.5) * 0.004 }
    return o
  }
  const out = []
  try {
    for (const clip of clips) {
      const { rate, samples } = readWav(clip)
      const core = new VadCore({ ...VAD, frame: vadFrame(rate), rate })
      const tap = new UtteranceTap(utteranceOptions(rate))
      const lead = room(1, rate, 1), tail = room(2, rate, 2)
      const all = new Float32Array(lead.length + samples.length + tail.length)
      all.set(lead, 0); all.set(samples, lead.length); all.set(tail, lead.length + samples.length)
      const readings = []
      for (let i = 0; i + 128 <= all.length; i += 128) {
        core.push(all, i, 128)
        const u = tap.push(all, i, 128, core.speech)
        if (u) {
          const t = performance.now()
          const r = await readUtterance(rt, u, vocab)
          readings.push({ text: r.text, dropped: r.dropped, seconds: Number(r.seconds.toFixed(2)), ms: Math.round(performance.now() - t), sure: Number(r.sure.toFixed(2)) })
        }
      }
      out.push({ clip, text: readings.map((r) => r.text).filter(Boolean).join(' '), readings })
    }
  } finally {
    await rt.release()
  }
  return out
}

/** Whether every word of `expect` is in `text`, in any order, letters and digits only, any case. */
export function saysAll(text, expect) {
  const words = (s) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const have = new Set(words(text))
  return words(expect).every((w) => have.has(w))
}

/** Writes the committed vocabulary from the model's tokenizer file: the `vocab` table as one JSON array, id by id. */
export function writeTokens(tokenizer, to = SOURCES.tokens) {
  const vocab = JSON.parse(readFileSync(tokenizer, 'utf8')).model.vocab
  const list = []
  for (const [piece, id] of Object.entries(vocab)) list[id] = piece
  for (let i = 0; i < list.length; i++) if (typeof list[i] !== 'string') throw new Error(`the tokenizer has no piece for id ${i}`)
  const text = `${JSON.stringify(list)}\n`
  writeFileSync(to, text)
  return { entries: list.length, bytes: Buffer.byteLength(text), sha256: sha256(Buffer.from(text)) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  const need = (name) => {
    const v = arg(name)
    if (!v) { console.error(`speechPack: --${name} <path> is needed`); process.exit(2) }
    return resolve(v)
  }
  const command = process.argv[2]
  try {
    if (command === 'pin') {
      console.log(pinLines().join('\n'))
    } else if (command === 'fetch') {
      const to = need('to')
      console.log(`speechPack: ${fetchPack({ to }).join(', ')} in ${to}`)
    } else if (command === 'unpack') {
      const to = need('to')
      console.log(`speechPack: ${unpack({ tarball: need('tarball'), to }).join(', ')} in ${to}`)
    } else if (command === 'check') {
      checkPack({ from: need('from') })
      console.log(`speechPack: the pack is the pin's (${SPEECH_PACK.id}: ${SPEECH_PACK.files.map((f) => `${f.file} ${f.bytes}`).join(', ')})`)
    } else if (command === 'place') {
      console.log(`speechPack: ${placePack({ from: need('from'), out: need('out') }).join(', ')}`)
    } else if (command === 'read') {
      const flags = new Set(['--from', '--expect'])
      const clips = process.argv.slice(3).filter((a, i, all) => !a.startsWith('--') && !flags.has(all[i - 1]))
      if (!clips.length) { console.error('speechPack: read needs at least one WAV clip'); process.exit(2) }
      const expect = arg('expect')
      let ok = true
      for (const r of await readClips({ from: need('from'), clips: clips.map((c) => resolve(c)) })) {
        console.log(`speechPack: ${r.clip}: ${JSON.stringify(r.text)} ${JSON.stringify(r.readings)}`)
        if (expect !== undefined && !saysAll(r.text, expect)) { ok = false; console.error(`::error::speechPack: ${r.clip} was read as ${JSON.stringify(r.text)}, which does not say ${JSON.stringify(expect)}`) }
      }
      if (!ok) process.exit(1)
    } else if (command === 'tokens') {
      const file = process.argv[3]
      if (!file) { console.error('speechPack: tokens <tokenizer.json>'); process.exit(2) }
      console.log(`speechPack: ${JSON.stringify(writeTokens(resolve(file)))}`)
    } else {
      console.error('usage: node tools/web/speechPack.mjs pin | fetch --to <dir> | unpack --tarball <file> --to <dir> | check --from <dir> | place --from <dir> --out dist-web | read --from <dir> [--expect "<words>"] <clip.wav>... | tokens <tokenizer.json>')
      process.exit(2)
    }
  } catch (e) {
    console.error(`::error::speechPack: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}
