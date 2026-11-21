// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins what the build does to the speech runtime's script (vite.config.ts
 * leanSpeechRuntime). ONNX Runtime's script names its own WebAssembly module beside itself twice, as
 * `new URL(file, import.meta.url)`; a bundler follows such an address and inlines the file, and this one is 15 MB:
 * left alone, the single-file page more than triples (it was built at 51.8 MB once). The speech worker never uses
 * either address (it hands the runtime the module's bytes, fetched from beside the page and hashed), so the build
 * replaces each with the bare file name. Here, on the installed package: exactly the two addresses are found and
 * replaced, nothing else of the script changes, and a script that names its module any other number of times stops
 * the build instead of shipping a page three times its size, or one whose runtime cannot find its module.
 * What breaks if it is removed? An upgrade of the package that names its module another way would pass every unit
 * test and fail only at the page's size budget, or not at all.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SPEECH_RUNTIME_MODULE, leanSpeechRuntime } from '../vite.config.ts'
import { speechFile } from './09_Cognition/speechPack.ts'

/** The script the speech worker imports: what the package's `./wasm` entry resolves to for a bundler. */
const DIST_DIR = fileURLToPath(new URL('../node_modules/onnxruntime-web/dist', import.meta.url))
const MODULE = join(DIST_DIR, 'ort.wasm.bundle.min.mjs')
const SOURCE = readFileSync(MODULE, 'utf8')
const ADDRESS = 'new URL("ort-wasm-simd-threaded.wasm",import.meta.url)'
const BARE = '({href:"ort-wasm-simd-threaded.wasm"})'

test('the plugin picks out the script the worker imports, on any path style, and nothing else', () => {
  assert.ok(SPEECH_RUNTIME_MODULE.test(MODULE.replaceAll('\\', '/')))
  assert.ok(SPEECH_RUNTIME_MODULE.test(MODULE.replaceAll('/', '\\')))
  assert.ok(!SPEECH_RUNTIME_MODULE.test(join(DIST_DIR, 'ort.min.mjs')))
  assert.ok(!SPEECH_RUNTIME_MODULE.test(join(DIST_DIR, 'ort.wasm.min.mjs')))
  assert.ok(!SPEECH_RUNTIME_MODULE.test('/src/09_Cognition/speech.worker.ts'))
  // The package's own map says a bundler's `onnxruntime-web/wasm` is that file.
  const pkg = JSON.parse(readFileSync(join(DIST_DIR, '..', 'package.json'), 'utf8')) as { exports: Record<string, unknown> }
  assert.match(JSON.stringify(pkg.exports['./wasm']), /"\.\/dist\/ort\.wasm\.bundle\.min\.mjs"/)
})

test('the installed script: both addresses of its WebAssembly module become the bare file name, and nothing else changes', () => {
  assert.equal(SOURCE.split(ADDRESS).length - 1, 2, 'the package names its module twice')
  const out = leanSpeechRuntime(SOURCE)
  assert.ok(!out.includes(ADDRESS), 'no address a bundler would follow is left')
  assert.equal(out.split(BARE).length - 1, 2)
  assert.equal(out.length, SOURCE.length - 2 * (ADDRESS.length - BARE.length))
  assert.equal(out.replaceAll(BARE, ADDRESS), SOURCE, 'only the two addresses changed')
  assert.equal(leanSpeechRuntime(SOURCE), out, 'two builds give the same script')
  // The name left behind is the pack's own file: what the worker is handed as bytes.
  assert.equal(speechFile('runtime').file, 'ort-wasm-simd-threaded.wasm')
  // Nothing else in the script is an address of a file beside it that a bundler could inline.
  assert.deepEqual(out.match(/new URL\("[^"]+\.(?:wasm|mjs|js)",\s*import\.meta\.url\)/g), null)
})

test('a script that names its module once, three times or not at all stops the build', () => {
  assert.throws(() => leanSpeechRuntime('export const a = 1'), /names its WebAssembly module 0 times, not the two the build unhooks/)
  assert.throws(() => leanSpeechRuntime(`a(${ADDRESS})`), /1 times/)
  assert.throws(() => leanSpeechRuntime(`${ADDRESS};${ADDRESS};${ADDRESS}`), /3 times/)
  assert.equal(leanSpeechRuntime(`a(${ADDRESS});b(${ADDRESS})`), `a(${BARE});b(${BARE})`)
})
