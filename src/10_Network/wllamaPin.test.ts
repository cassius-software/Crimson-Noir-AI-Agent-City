// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the in-page model runtime to its pin: @wllama/wllama at exactly one version in
 * package.json and the lockfile, the committed third_party/wllama/<version>/wllama.wasm.gz holding byte for byte the
 * module that package publishes and that SHA256SUMS names, the reviewed import list complete, the pinned notice naming
 * the llama.cpp build the package carries and every library whose code is found in the module's own bytes, the notice
 * every page ships (NOTICE.md) claiming the runtime only for a page that carries it, wllama-pack repairing a damaged
 * gz, and the module the build embeds (vite.config.ts wllamaModule) giving back exactly the committed gz, its hash and
 * its length. tools/verify/wasm_airgap.py checks the same pin without npm; this is its twin where node_modules is
 * present.
 * What breaks if it is removed? An upgrade, a reinstall or a hand edit could leave the page embedding a module that is
 * not the reviewed one, or not the one the package's JavaScript was written for, and nothing in the Node suite would say so.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { bundleCarries, noticesComment, sumFor, wllamaModule, WLLAMA_MODULE, WLLAMA_PIN, WLLAMA_VERSION } from '../../vite.config.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const read = (rel: string): Buffer => readFileSync(ROOT + rel)
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')
const PACKAGE_WASM = 'node_modules/@wllama/wllama/esm/wasm/wllama.wasm'

test('@wllama/wllama is pinned to exactly the version the committed module is (package.json, the lockfile, the directory)', () => {
  assert.equal(WLLAMA_VERSION, '3.8.1')
  assert.equal(WLLAMA_PIN, `third_party/wllama/${WLLAMA_VERSION}`)
  const pkg = JSON.parse(read('package.json').toString()) as { dependencies: Record<string, string> }
  assert.equal(pkg.dependencies['@wllama/wllama'], WLLAMA_VERSION, 'an exact version, no range: the module is reviewed per version')
  const lock = JSON.parse(read('package-lock.json').toString()) as { packages: Record<string, { version?: string; license?: string; dependencies?: Record<string, string> }> }
  assert.equal(lock.packages['']?.dependencies?.['@wllama/wllama'], WLLAMA_VERSION)
  assert.equal(lock.packages['node_modules/@wllama/wllama']?.version, WLLAMA_VERSION)
  assert.equal(lock.packages['node_modules/@wllama/wllama']?.license, 'MIT')
  assert.equal((JSON.parse(read('node_modules/@wllama/wllama/package.json').toString()) as { version: string }).version, WLLAMA_VERSION, 'npm ci installed the pinned version')
})

test('the committed gz holds the module SHA256SUMS names, which is the module the installed package publishes', () => {
  const gz = read(`${WLLAMA_PIN}/wllama.wasm.gz`)
  const sums = read(`${WLLAMA_PIN}/SHA256SUMS`).toString()
  const raw = gunzipSync(gz)
  assert.equal(sha256(raw), '551f13439366eff11e057b1b91fe46a7fdac29d56d67372d4c5f19a549dfe70c', 'the module reviewed for 3.8.1')
  assert.equal(sumFor(sums, 'wllama.wasm'), sha256(raw))
  assert.equal(sumFor(sums, 'wllama.wasm.gz'), sha256(gz))
  assert.equal(sha256(read(PACKAGE_WASM)), sha256(raw), `${PACKAGE_WASM} is the committed module`)
  assert.equal(raw.length, 8_763_949)
  assert.ok(gz.length < 2_500_000, `${gz.length} bytes gzipped`)
  // The header pack writes: deflate, no name, no time, Unix (so one machine always writes the same bytes).
  assert.deepEqual([...gz.subarray(0, 10)], [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 3])
})

test('wllamaModule: the gz as base64, the raw module\'s sha256 and length, the version; a damaged pin throws', () => {
  const gz = read(`${WLLAMA_PIN}/wllama.wasm.gz`)
  const sums = read(`${WLLAMA_PIN}/SHA256SUMS`).toString()
  const src = wllamaModule(gz, sums)
  const m = /^export const version = "([^"]+)"\nexport const sha256 = "([0-9a-f]{64})"\nexport const bytes = (\d+)\nexport default "([A-Za-z0-9+/=]+)"$/.exec(src)
  assert.ok(m, 'the module\'s shape (src/wllama-runtime.d.ts types it)')
  assert.equal(m[1], WLLAMA_VERSION)
  assert.equal(m[2], sumFor(sums, 'wllama.wasm'))
  assert.equal(Number(m[3]), gunzipSync(gz).length)
  assert.ok(Buffer.from(m[4], 'base64').equals(gz), 'the default export is the committed gz byte for byte, not the raw module')
  assert.ok(m[4].length < 3_300_000, `${m[4].length} characters of base64 in the page`)
  // Another module in the gz (its sums updated to match the gz but not the module), a stale gz line, no sums at all.
  const other = gzipSync(Buffer.from('\0asm\x01\0\0\0'))
  assert.throws(() => wllamaModule(other, `${sumFor(sums, 'wllama.wasm')}  wllama.wasm\n${sha256(other)}  wllama.wasm.gz\n`), /holds a module .* not the one/)
  assert.throws(() => wllamaModule(gz, `${sumFor(sums, 'wllama.wasm')}  wllama.wasm\n${'0'.repeat(64)}  wllama.wasm.gz\n`), /does not hash/)
  assert.throws(() => wllamaModule(gz, ''), /does not hash/)
})

test('sumFor and bundleCarries: sha256sum\'s lines by name; a virtual module found by its \\0 id in a chunk only', () => {
  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)
  assert.equal(sumFor(`${a}  wllama.wasm\r\n${b} *wllama.wasm.gz\n`, 'wllama.wasm.gz'), b)
  assert.equal(sumFor(`${a}  wllama.wasm\n`, 'wllama.wasm.gz'), null)
  assert.equal(sumFor(`${a}  xwllama.wasm\n`, 'wllama.wasm'), null)
  const id = `\0${WLLAMA_MODULE}`
  assert.equal(bundleCarries({ main: { type: 'chunk', moduleIds: ['/app/src/main.tsx', id] } }, id), true)
  assert.equal(bundleCarries({ main: { type: 'chunk', moduleIds: ['/app/src/main.tsx'] }, css: { type: 'asset' } }, id), false)
})

test('IMPORTS: the 68 reviewed imports, 60 from env and 8 from wasi_snapshot_preview1, the memory among them', () => {
  const lines = read(`${WLLAMA_PIN}/IMPORTS`).toString().split('\n').filter(Boolean)
  assert.equal(lines.length, 68)
  assert.equal(lines.filter((l) => l.startsWith('env.')).length, 60)
  assert.equal(lines.filter((l) => l.startsWith('wasi_snapshot_preview1.')).length, 8)
  assert.ok(lines.every((l) => /^(env|wasi_snapshot_preview1)\.\w+ (func|memory)$/.test(l)), 'module.name kind, nothing else')
  assert.deepEqual(lines.filter((l) => l.endsWith(' memory')), ['env.memory memory'])
  assert.deepEqual(lines.filter((l) => /sock|connect|accept|send|recv|fetch|http|xhr|websocket/i.test(l)), [])
})

test('the pinned notice names the llama.cpp build the package carries and every component compiled in, with its licence text', () => {
  const notice = read(`${WLLAMA_PIN}/NOTICE`).toString()
  const build = /\bLIBLLAMA_VERSION\s*=\s*"([^"]+)"/.exec(read('node_modules/@wllama/wllama/esm/index.js').toString())?.[1]
  assert.equal(build, 'b11364-46ca246')
  assert.ok(notice.includes(`build ${build}`))
  for (const [component, text] of [
    ['llama.cpp', 'The ggml authors'], ['nlohmann/json', 'Niels Lohmann'], ['Dawn', 'The Dawn & Tint Authors'],
    ['Emscripten', 'University of Illinois/NCSA Open Source License'], ['musl', 'Rich Felker'],
    ['libc++', 'LLVM Exceptions to the Apache 2.0 License'], ['wasm-feature-detect', 'Copyright 2017 Google Inc.'],
    ['stb_image', 'ALTERNATIVE A - MIT License\nCopyright (c) 2017 Sean Barrett'], ['miniaudio', 'ALTERNATIVE 2 - MIT No Attribution\n'],
    ['SHA-256', '2010-06-11 : Igor Pavlov : Public domain'], ['rotate-bits.h', 'Copyright (c) 2021 William Casarin <jb55@jb55.com>'],
  ]) {
    assert.ok(notice.includes(component) && notice.includes(text), `${component}: named, with its licence text`)
  }
  assert.doesNotMatch(notice, /to be added before release/, 'every text was fetched and copied')
  assert.ok(read(`${WLLAMA_PIN}/LICENCE`).equals(read('node_modules/@wllama/wllama/LICENCE')), 'LICENCE is the package\'s own')
})

/** A CRC lookup table as C code writes it (MSB first): `bits` 8 gives bytes, 16 gives little-endian u16s. */
function crcTable(poly: number, bits: 8 | 16): Buffer {
  const top = 1 << (bits - 1)
  const mask = (1 << bits) - 1
  const t = Buffer.alloc(256 * (bits / 8))
  for (let i = 0; i < 256; i++) {
    let c = i << (bits - 8)
    for (let k = 0; k < 8; k++) c = c & top ? ((c << 1) ^ poly) & mask : (c << 1) & mask
    if (bits === 8) t[i] = c
    else t.writeUInt16LE(c, i * 2)
  }
  return t
}

test('the code llama.cpp vendors that the module carries (its tools/mtmd helper) is in the pinned notice: each one found in the module\'s own bytes', () => {
  const raw = gunzipSync(read(`${WLLAMA_PIN}/wllama.wasm.gz`))
  const notice = read(`${WLLAMA_PIN}/NOTICE`).toString()
  const k = Buffer.alloc(32)
  ;[0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5].forEach((v, i) => k.writeUInt32LE(v, i * 4))
  for (const [component, licence, marks] of [
    // stb_image's own error strings (stbi__err), from its PNG, JPEG, GIF and BMP decoders.
    ['stb_image', 'ALTERNATIVE A - MIT License\nCopyright (c) 2017 Sean Barrett', ['bad png sig', 'first not IHDR', 'no SOI', 'bad huffman code', 'not GIF', 'bad BMP'].map((t) => Buffer.from(t))],
    // miniaudio's FLAC decoder (its dr_flac): the CRC-8 table, then the CRC-16 table, back to back as it declares them.
    ['miniaudio', '===\nCopyright 2026 David Reid\n\nPermission is hereby granted', [Buffer.concat([crcTable(0x07, 8), crcTable(0x8005, 16)])]],
    // vendor/hash's SHA-256: the first eight round constants, as its table holds them.
    ['SHA-256', '2010-06-11 : Igor Pavlov : Public domain', [k]],
  ] as const) {
    for (const mark of marks) assert.ok(raw.includes(mark), `${component}: its code is in the module`)
    assert.ok(notice.includes(`\n${component} (`) && notice.includes(licence), `${component}: in the notice, with its licence text`)
  }
})

test('NOTICE.md, which every page carries, speaks of the in-page runtime only as what a page that carries it carries', () => {
  // A page built before the adapter imports the runtime (or any page that leaves it out) carries neither the module nor
  // its NOTICE: the notice it ships must not say otherwise (tools/verify/page_dist.mjs holds the other direction).
  const shipped = noticesComment(read('NOTICE.md').toString(), [])
  const about = shipped.split(/\n\s*\n/).filter((p) => /wllama\.wasm|third_party\/wllama/.test(p))
  assert.ok(about.length >= 2, 'the runtime and its NOTICE are named')
  for (const p of about) assert.match(p, /\bpage that carries\b/, p)
})

test('every host the pinned notice names is one page_dist has reviewed for a page that carries the runtime', async () => {
  // The notice rides in the page with the module; a licence text that names a new address fails page_dist after the
  // build, so it is caught here first. The specifier is not a literal: the tool is plain JavaScript, with no types.
  const dist = await import(new URL('../../tools/verify/page_dist.mjs', import.meta.url).href) as { hostsIn(text: string): Set<string>; PAGE_HOSTS: readonly string[]; RUNTIME_HOSTS: readonly string[] }
  const reviewed = new Set([...dist.PAGE_HOSTS, ...dist.RUNTIME_HOSTS])
  const named = [...dist.hostsIn(read(`${WLLAMA_PIN}/NOTICE`).toString())]
  assert.ok(named.length > 0)
  assert.deepEqual(named.filter((h) => !reviewed.has(h)), [], 'add each to RUNTIME_HOSTS in tools/verify/page_dist.mjs once read')
})

test('npm run native:wllama -- --check: the committed pin is what node_modules gives', () => {
  const r = spawnSync(process.execPath, ['tools/native/wllama-pack.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /matches .* 68 imports, llama\.cpp b11364-46ca246/)
})

test('wllama-pack on a damaged gz: --check names it as a problem instead of throwing, and a write replaces it', () => {
  // A copy of the tool and the pin, over the installed package, with the committed gz cut short (its header intact).
  const root = mkdtempSync(join(tmpdir(), 'wllama-pack-'))
  try {
    mkdirSync(join(root, 'tools/native'), { recursive: true })
    copyFileSync(`${ROOT}tools/native/wllama-pack.mjs`, join(root, 'tools/native/wllama-pack.mjs'))
    mkdirSync(join(root, 'node_modules'))
    // A copy of the installed package (20 MB), not a link to it: a directory symlink on Windows needs a privilege most
    // accounts lack, and fails with EPERM (a laptop run).
    cpSync(`${ROOT}node_modules/@wllama`, join(root, 'node_modules/@wllama'), { recursive: true })
    mkdirSync(join(root, WLLAMA_PIN), { recursive: true })
    for (const f of ['IMPORTS', 'LICENCE', 'NOTICE', 'SHA256SUMS']) copyFileSync(`${ROOT}${WLLAMA_PIN}/${f}`, join(root, WLLAMA_PIN, f))
    const gz = join(root, WLLAMA_PIN, 'wllama.wasm.gz')
    writeFileSync(gz, read(`${WLLAMA_PIN}/wllama.wasm.gz`).subarray(0, 1_000_000))
    const pack = (...args: string[]) => spawnSync(process.execPath, ['tools/native/wllama-pack.mjs', ...args], { cwd: root, encoding: 'utf8' })
    const checked = pack('--check')
    assert.equal(checked.status, 1, checked.stderr)
    assert.match(checked.stderr, /^wllama-pack: third_party\/wllama\/3\.8\.1\/wllama\.wasm\.gz does not gunzip: /m)
    assert.match(checked.stderr, /run npm run native:wllama/)
    const wrote = pack()
    assert.equal(wrote.status, 0, wrote.stderr)
    assert.ok(gunzipSync(readFileSync(gz)).equals(read(PACKAGE_WASM)), 'the gz holds the module again')
    assert.equal(pack('--check').status, 0)
  } finally {
    // The copy is 90 fresh files: a scanner holding one at the delete is waited out, as held.mjs waits at a read.
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
