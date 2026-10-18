#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It pins the in-page model runtime: wllama's WebAssembly build of llama.cpp, exactly as
 * @wllama/wllama publishes it on npm, committed under third_party/wllama/<version>/ so that every check that reads it
 * needs no npm and no network (tools/verify/wasm_airgap.py in the rust job, the fvps job and the release bake) and the
 * Nix build of the page takes it from git like any other file. `npm run native:wllama` writes, from node_modules:
 *   wllama.wasm.gz  the module, gzip -9 with no time and no name, so one machine always writes the same bytes (the build
 *                   embeds it as base64: vite.config.ts wllamaRuntime; the page gunzips it itself);
 *   SHA256SUMS      the sha256 of the module and of the gz, in sha256sum's format;
 *   IMPORTS         the module's imports in the order of its import section, one `module.name kind` a line (the air-gap
 *                   policy holds the module to exactly these);
 *   LICENCE         the package's own licence file.
 * NOTICE beside them is written by hand (the components compiled into the module and their licence texts); this tool
 * only checks it names the llama.cpp build the package says it carries.
 * A gz that already holds the same module is kept as it is: another machine's zlib may compress the same bytes
 * differently, and the committed file should change only when the module does.
 * `--check` writes nothing and exits 1 when anything committed differs from what node_modules gives (src/10_Network/
 * wllamaPin.test.ts runs it). Node only, no dependencies.
 * What breaks if it is removed? An upgrade of wllama leaves a stale pinned module, sums or import list behind, and
 * nothing regenerates them the same way twice.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** The pinned version: package.json names it exactly, and the directory carries it. */
export const VERSION = '3.8.1'
export const PIN_DIR = `third_party/wllama/${VERSION}`
export const PACKAGE_DIR = 'node_modules/@wllama/wllama'
export const SOURCE = `${PACKAGE_DIR}/esm/wasm/wllama.wasm`
export const RAW_NAME = 'wllama.wasm'
export const GZ_NAME = 'wllama.wasm.gz'

export const sha256 = (b) => createHash('sha256').update(b).digest('hex')

/**
 * The module as gzip: level 9, then the header made the same everywhere. zlib already writes no name and no time;
 * the operating-system byte is set to Unix (3) whatever system wrote it, as `gzip -n` on Linux writes it. The header
 * is not covered by the trailer's CRC (that is of the module), so this changes nothing a reader checks.
 */
export function gzip(raw) {
  const gz = gzipSync(raw, { level: 9 })
  if (gz[0] !== 0x1f || gz[1] !== 0x8b || gz[2] !== 8 || gz[3] !== 0) throw new Error('zlib wrote an unexpected gzip header')
  gz.writeUInt32LE(0, 4)
  gz[9] = 3
  return gz
}

/** Whether a gz has the header gzip() writes: deflate, no flags (no name, comment or extra field), time 0, Unix. */
export const canonicalHeader = (gz) => gz.length > 18 && gz[0] === 0x1f && gz[1] === 0x8b && gz[2] === 8 && gz[3] === 0 && gz.readUInt32LE(4) === 0 && gz[9] === 3

/** SHA256SUMS: the module's line, then the gz's, as sha256sum prints them. */
export const sums = (raw, gz) => `${sha256(raw)}  ${RAW_NAME}\n${sha256(gz)}  ${GZ_NAME}\n`

const KIND = ['func', 'table', 'memory', 'global', 'tag']

function leb(b, i) {
  let r = 0n
  let s = 0n
  for (;;) {
    const x = b[i++]
    if (x === undefined) throw new Error('a LEB128 number runs past the end of the module')
    r |= BigInt(x & 0x7f) << s
    s += 7n
    if (!(x & 0x80)) return [r, i]
  }
}
const u32 = (b, i) => { const [v, j] = leb(b, i); return [Number(v), j] }

/** Limits (a table's or a memory's): the flags byte, the minimum and, when bit 0 is set, the maximum. */
function limits(b, i) {
  const flags = b[i]
  let min
  let max
  ;[min, i] = leb(b, i + 1)
  if (flags & 1) [max, i] = leb(b, i)
  return [{ flags, min, max }, i]
}

/**
 * The import section of a WebAssembly module, in order: each import's module, name and kind, and a memory's limits
 * (flags 7 = a maximum, shared, 64-bit addresses). Reads the binary format directly, like tools/verify/wasm_airgap.py.
 */
export function wasmImports(wasm) {
  if (wasm.length < 8 || wasm.readUInt32LE(0) !== 0x6d736100 || wasm.readUInt32LE(4) !== 1) throw new Error('not a WebAssembly 1.0 module')
  const out = []
  let i = 8
  while (i < wasm.length) {
    const id = wasm[i]
    const [size, start] = u32(wasm, i + 1)
    const end = start + size
    if (id === 2) {
      let [count, j] = u32(wasm, start)
      const text = (n, k) => [wasm.subarray(k, k + n).toString('utf8'), k + n]
      for (; count > 0; count--) {
        let n, module, name
        ;[n, j] = u32(wasm, j); [module, j] = text(n, j)
        ;[n, j] = u32(wasm, j); [name, j] = text(n, j)
        const kind = KIND[wasm[j]]
        if (!kind) throw new Error(`import ${module}.${name}: unknown kind ${wasm[j]}`)
        j++
        const entry = { module, name, kind }
        if (kind === 'func') [, j] = u32(wasm, j)
        else if (kind === 'table') [entry.limits, j] = limits(wasm, j + 1)
        else if (kind === 'memory') [entry.limits, j] = limits(wasm, j)
        else if (kind === 'global') j += 2
        else [, j] = u32(wasm, j + 1)
        out.push(entry)
      }
      if (j !== end) throw new Error('the import section does not end where its size says')
    }
    i = end
  }
  return out
}

/** IMPORTS: one `module.name kind` a line, in the order of the import section. */
export const importsText = (wasm) => wasmImports(wasm).map((m) => `${m.module}.${m.name} ${m.kind}\n`).join('')

/** The llama.cpp build the package says its module carries (esm/index.js LIBLLAMA_VERSION). */
export function llamaBuild(indexJs) {
  const m = /\bLIBLLAMA_VERSION\s*=\s*"([^"]+)"/.exec(indexJs)
  if (!m) throw new Error(`${PACKAGE_DIR}/esm/index.js names no LIBLLAMA_VERSION`)
  return m[1]
}

/** Everything the pin holds, from the package in node_modules, plus the committed gz when it already holds the module. */
export function pack(root = ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, PACKAGE_DIR, 'package.json'), 'utf8'))
  if (pkg.version !== VERSION) throw new Error(`node_modules has @wllama/wllama ${pkg.version}; this pin is ${VERSION} (change VERSION, package.json and the lockfile together)`)
  const raw = readFileSync(join(root, SOURCE))
  const gzFile = join(root, PIN_DIR, GZ_NAME)
  const kept = existsSync(gzFile) ? readFileSync(gzFile) : null
  // A damaged gz (cut short, a bad CRC) is not the module: `--check` says so and a write replaces it.
  let same = false
  if (kept !== null && canonicalHeader(kept)) {
    try { same = gunzipSync(kept).equals(raw) } catch { same = false }
  }
  const fresh = gzip(raw)
  const gz = same ? kept : fresh
  const licence = ['LICENCE', 'LICENSE'].map((f) => join(root, PACKAGE_DIR, f)).find((f) => existsSync(f))
  if (!licence) throw new Error(`${PACKAGE_DIR} ships no LICENCE or LICENSE file`)
  return {
    raw,
    gz,
    fresh,
    files: { [GZ_NAME]: gz, SHA256SUMS: sums(raw, gz), IMPORTS: importsText(raw), LICENCE: readFileSync(licence) },
    build: llamaBuild(readFileSync(join(root, PACKAGE_DIR, 'esm/index.js'), 'utf8')),
  }
}

/** What differs between the committed pin and the package: an empty list when they agree. */
export function check(root = ROOT) {
  const p = pack(root)
  const dir = join(root, PIN_DIR)
  const problems = []
  for (const [name, want] of Object.entries(p.files)) {
    const file = join(dir, name)
    if (!existsSync(file)) { problems.push(`${PIN_DIR}/${name} is missing`); continue }
    const have = readFileSync(file)
    if (name === GZ_NAME) {
      if (!canonicalHeader(have)) problems.push(`${PIN_DIR}/${name}: its gzip header is not the one this tool writes (time 0, no name, Unix)`)
      let inner = null
      try { inner = gunzipSync(have) } catch (e) { problems.push(`${PIN_DIR}/${name} does not gunzip: ${e.message}`) }
      if (inner && !inner.equals(p.raw)) problems.push(`${PIN_DIR}/${name} holds a module (sha256 ${sha256(inner)}) that is not ${SOURCE} (sha256 ${sha256(p.raw)})`)
    } else if (!have.equals(Buffer.from(want))) {
      problems.push(`${PIN_DIR}/${name} differs from what the installed ${PACKAGE_DIR} gives`)
    }
  }
  const notice = join(dir, 'NOTICE')
  if (!existsSync(notice)) problems.push(`${PIN_DIR}/NOTICE is missing`)
  else if (!readFileSync(notice, 'utf8').includes(p.build)) problems.push(`${PIN_DIR}/NOTICE does not name llama.cpp ${p.build}, the build the package carries`)
  return { problems, pack: p }
}

function main(args) {
  if (args.some((a) => a !== '--check')) { console.error('usage: wllama-pack.mjs [--check]'); return 2 }
  if (args.includes('--check')) {
    const { problems, pack: p } = check()
    for (const x of problems) console.error(`wllama-pack: ${x}`)
    if (problems.length) { console.error('wllama-pack: run npm run native:wllama, review the diff and commit it'); return 1 }
    const note = p.fresh.equals(p.gz) ? 'this machine gzips it to the same bytes' : 'this machine\'s zlib would compress it differently; the committed gz holds the same module'
    console.log(`wllama-pack: ${PIN_DIR} matches ${SOURCE} (${p.raw.length} bytes, sha256 ${sha256(p.raw).slice(0, 16)}…, ${p.files.IMPORTS.split('\n').length - 1} imports, llama.cpp ${p.build}); ${note}`)
    return 0
  }
  const p = pack()
  const dir = join(ROOT, PIN_DIR)
  mkdirSync(dir, { recursive: true })
  for (const [name, bytes] of Object.entries(p.files)) writeFileSync(join(dir, name), bytes)
  console.log(`wllama-pack: wrote ${PIN_DIR}: ${RAW_NAME} ${p.raw.length} bytes (sha256 ${sha256(p.raw)}), ${GZ_NAME} ${p.gz.length} bytes${p.gz === p.fresh ? '' : ' (kept: it already holds this module)'}, ${p.files.IMPORTS.split('\n').length - 1} imports`)
  if (!existsSync(join(dir, 'NOTICE')) || !readFileSync(join(dir, 'NOTICE'), 'utf8').includes(p.build)) {
    console.log(`wllama-pack: write ${PIN_DIR}/NOTICE by hand: it must name llama.cpp ${p.build} and the components compiled into the module`)
  }
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)))
