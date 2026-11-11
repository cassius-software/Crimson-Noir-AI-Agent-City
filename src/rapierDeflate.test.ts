// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the build's packing of the physics engine (vite.config.ts deflateRapier): Rapier's
 * compatibility module carries its WebAssembly as plain base64, about a third of the page, and the build stores it
 * deflated instead and has the worker inflate it as Rapier initialises. Here, on the installed package: the one
 * initialisation is found and replaced, what it waits for is the inflater the page carries, run in Node it gives back
 * the package's own module byte for byte, the packed copy is under half the size, and a module the build does not
 * recognise (no initialisation, two, or bytes that are not WebAssembly) stops the build rather than ship a page whose
 * physics cannot start. Once built, dist/index.html carries the inflater and no plain copy of the module.
 * What breaks if it is removed? A Rapier upgrade that moved its initialisation, or a change to the inflater, could ship
 * a page that never starts its physics worker, with nothing but the browser smoke to notice, minutes later.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { Script, createContext } from 'node:vm'
import { INFLATE_HELPER, RAPIER_MODULE, deflateRapier } from '../vite.config.ts'

const require = createRequire(import.meta.url)
const DIST_DIR = dirname(require.resolve('@dimforge/rapier3d-simd-compat'))
const MODULE = join(DIST_DIR, 'rapier.mjs')
const SOURCE = readFileSync(MODULE, 'utf8')
const DIST = new URL('../dist/index.html', import.meta.url)
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

/** The package's own module bytes, decoded as the package decodes them. */
const original = (): Buffer => Buffer.from(/module_or_path:[\w$]+\.toByteArray\("([A-Za-z0-9+/=]+)"\)/.exec(SOURCE)![1], 'base64')

test('the plugin picks out the package\'s module file and nothing else', () => {
  assert.ok(RAPIER_MODULE.test(MODULE.replaceAll('\\', '/')))
  assert.ok(RAPIER_MODULE.test(MODULE.replaceAll('/', '\\')))
  assert.ok(!RAPIER_MODULE.test(join(DIST_DIR, 'rapier.cjs')))
  assert.ok(!RAPIER_MODULE.test('/src/07_Execute_Actions/physics.ts'))
})

test('the installed Rapier: its one initialisation now waits for the inflater, and the packed copy is under half the size', () => {
  const out = deflateRapier(SOURCE)
  const raw = original()
  assert.equal(out.bytes, raw.length)
  assert.ok(out.packed < 0.5 * raw.toString('base64').length, `packed ${out.packed} of ${raw.toString('base64').length}`)
  assert.ok(!/module_or_path:[\w$]+\.toByteArray\(/.test(out.code), 'no plain copy left')
  assert.equal((out.code.match(/\(yield __cnInflate\("/g) ?? []).length, 1)
  assert.ok(out.code.endsWith(`\n${INFLATE_HELPER}\n`))
  // Only the initialisation and the inflater changed: the rest of the package is as published.
  const at = SOURCE.indexOf('module_or_path:')
  assert.equal(out.code.slice(0, at), SOURCE.slice(0, at))
  const tail = SOURCE.slice(SOURCE.indexOf('").buffer})', at) + '").buffer'.length)
  assert.ok(out.code.includes(tail.slice(0, 2000)))
})

test('run in Node, the inflater gives back the package\'s module byte for byte, and refuses a wrong size', async () => {
  const out = deflateRapier(SOURCE)
  const m = /\(yield __cnInflate\(("[A-Za-z0-9+/=]+"),(\d+)\)\)/.exec(out.code)!
  const sandbox = createContext({ atob, Blob, Response, DecompressionStream, Uint8Array, Error })
  new Script(INFLATE_HELPER).runInContext(sandbox)
  const inflate = sandbox.__cnInflate as (b64: string, bytes: number) => Promise<ArrayBuffer>
  const bytes = new Uint8Array(await inflate(JSON.parse(m[1]) as string, Number(m[2])))
  assert.equal(bytes.length, original().length)
  assert.equal(sha256(bytes), sha256(original()))
  assert.deepEqual([...bytes.subarray(0, 4)], [0, 0x61, 0x73, 0x6d])
  await assert.rejects(inflate(JSON.parse(m[1]) as string, Number(m[2]) + 1), /inflated to \d+ bytes, not \d+/)
})

test('a module the build does not recognise stops the build', () => {
  const init = /function\*\(\)\{yield [\w$]+\(\{module_or_path:[\w$]+\.toByteArray\("[A-Za-z0-9+/=]+"\)\.buffer\}\)/.exec(SOURCE)![0]
  assert.throws(() => deflateRapier('export default 1'), /0 inline WebAssembly initialisations/)
  assert.throws(() => deflateRapier(`${init};${init}`), /2 inline WebAssembly initialisations/)
  const notWasm = Buffer.from('not a module at all').toString('base64')
  assert.throws(() => deflateRapier(`(function*(){yield f({module_or_path:b.toByteArray("${notWasm}").buffer})})`), /not WebAssembly/)
})

test('the built page carries the inflater and no plain copy of the module (when dist/index.html is there)', { skip: !existsSync(DIST) && 'dist/index.html is not built' }, () => {
  const page = readFileSync(DIST, 'utf8')
  assert.ok(page.includes('DecompressionStream(`deflate-raw`)') || page.includes('DecompressionStream("deflate-raw")'), 'the inflater')
  assert.ok(!page.includes(original().toString('base64').slice(0, 4096)), 'no plain base64 copy')
  assert.match(page, /the physics module inflated to /)
})
