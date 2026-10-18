// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the in-page runtime's capability probe (inPageCaps.ts). Against
 * fake globals it shows each piece read from the global it is handed and nowhere else: JSPI needs both functions; the
 * shared 64-bit memory is asked for exactly as the runtime's glue asks (BigInt limits), so an engine that ignores the
 * address key, refuses shared memory or refuses 64-bit addresses reads as missing; a validator that refuses or throws,
 * a missing WebAssembly and a global whose getters throw all read as missing, never as an exception. Against the real
 * Node global it shows the hand-written SIMD and exception modules valid, their broken variants invalid, and each
 * module false once V8 is started without the feature it stands for. The reason names the first missing piece in a
 * fixed order, isolation only decides threads, a page opened from a file (an opaque origin, where Chromium refuses the
 * runtime's module worker) is refused after the browser's own pieces, and the console line says so in plain words.
 * What breaks if it is removed? A probe that says yes to a browser that cannot run the runtime (a load that hangs with
 * no reason) or no to one that can (the script standing in for a model that would have worked) would go unnoticed.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { canShareMemory } from '../07_Execute_Actions/sharedBridge.ts'
import { capsLine, OPAQUE_REASON, probe, runtimeMode, type Caps } from './inPageCaps.ts'

// ---------------------------------------------------------------- fakes

/** A Memory constructor that makes only what the runtime's glue asks for (BigInt limits, address 'i64'), noting each descriptor. */
function glueMemory(seen: object[] = []) {
  return function Memory(d: { initial?: unknown; maximum?: unknown; address?: unknown }) {
    seen.push(d)
    if (d.address !== 'i64' || typeof d.initial !== 'bigint' || typeof d.maximum !== 'bigint') throw new TypeError('the limits do not match the address type')
  }
}

/** A WebAssembly that offers everything the runtime needs; `over` replaces parts (undefined removes one). */
const wasm = (over: Record<string, unknown> = {}) => ({
  Suspending: function Suspending() {},
  promising: () => () => Promise.resolve(),
  Memory: glueMemory(),
  validate: () => true,
  ...over,
})

/** A cross-origin isolated page that offers everything; `over` replaces parts (undefined removes one). */
const page = (over: Record<string, unknown> = {}) => ({
  WebAssembly: wasm(),
  navigator: { storage: { getDirectory: async () => ({}) }, gpu: {} },
  SharedArrayBuffer,
  crossOriginIsolated: true,
  ...over,
})

const ALL: Caps = { jspi: true, mem64shared: true, simd: true, exceptions: true, isolated: true, opfs: true, webgpu: true, opaque: false }

/** A module's sections in order: each id and its payload (sizes are LEB128). */
function sections(b: Uint8Array): { id: number; at: number; end: number; body: Uint8Array }[] {
  const out = []
  let i = 8
  while (i < b.length) {
    const at = i
    const id = b[i++]
    let size = 0
    let shift = 0
    let x: number
    do {
      x = b[i++]
      size |= (x & 0x7f) << shift
      shift += 7
    } while (x & 0x80)
    out.push({ id, at, end: i + size, body: b.subarray(i, i + size) })
    i += size
  }
  return out
}

/** Whether `needle` occurs in `hay` as a run of bytes. */
const holds = (hay: Uint8Array, needle: readonly number[]): boolean => hay.some((_, i) => needle.every((v, k) => hay[i + k] === v))

/** The two modules probe() validates, captured as it hands them over, told apart by the tag section (id 13). */
function modules(): { simd: Uint8Array<ArrayBuffer>; eh: Uint8Array<ArrayBuffer> } {
  const seen: Uint8Array<ArrayBuffer>[] = []
  probe(page({ WebAssembly: wasm({ validate: (b: Uint8Array) => (seen.push(b.slice()), true) }) }))
  assert.equal(seen.length, 2, 'two modules are validated')
  const eh = seen.filter((b) => sections(b).some((s) => s.id === 13))
  const simd = seen.filter((b) => !sections(b).some((s) => s.id === 13))
  assert.equal(eh.length, 1)
  assert.equal(simd.length, 1)
  return { simd: simd[0], eh: eh[0] }
}

/** probe() in a fresh Node started with `flags`, or null when this Node does not know a flag (another V8, another CPU). */
function probeUnder(flags: readonly string[]): Caps | null {
  const src = `import { probe } from ${JSON.stringify(new URL('./inPageCaps.ts', import.meta.url).href)}; console.log(JSON.stringify(probe()))`
  const r = spawnSync(process.execPath, [...flags, '--no-warnings', '--input-type=module', '-e', src], { encoding: 'utf8' })
  if (/bad option/.test(r.stderr)) return null
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout) as Caps
}

// ---------------------------------------------------------------- the real Node global

test('in real Node the probe does not throw, SIMD and exceptions are there, and the rest is what Node itself says', () => {
  const c = probe()
  assert.equal(c.simd, true, 'Node 22 and later validate WebAssembly SIMD')
  assert.equal(c.exceptions, true, 'Node 22 and later validate the legacy exception instructions')
  const w = WebAssembly as unknown as { Suspending?: unknown; promising?: unknown }
  assert.equal(c.jspi, typeof w.Suspending === 'function' && typeof w.promising === 'function')
  let i64 = true
  try {
    new WebAssembly.Memory({ initial: 1n, maximum: 1n, shared: true, address: 'i64' } as never)
  } catch {
    i64 = false
  }
  assert.equal(c.mem64shared, i64)
  assert.equal(c.isolated, canShareMemory(globalThis as never))
  const nav = (globalThis as { navigator?: { storage?: { getDirectory?: unknown }; gpu?: unknown } }).navigator
  assert.equal(c.opfs, typeof nav?.storage?.getDirectory === 'function')
  assert.equal(c.webgpu, !!nav?.gpu)
  assert.equal(probe(globalThis).simd, true, 'the default global is globalThis')
  assert.ok(capsLine(c).length > 0)
})

test('the SIMD module is v128 work validated as such; a broken copy is refused by the real validator', () => {
  const { simd } = modules()
  assert.equal(WebAssembly.validate(simd), true)
  const code = sections(simd).find((s) => s.id === 10)
  assert.ok(code && holds(code.body, [0xfd, 0x0c]), 'the body starts from v128.const (prefix 0xfd, opcode 0x0c)')
  assert.ok(holds(code.body, [0xfd, 0x60]) && holds(code.body, [0xfd, 0x16, 0x00]), 'an i8x16 operation, then lane 0 read back')
  // The function promises an i64 where i8x16.extract_lane_u leaves an i32: a type error, so invalid.
  const wrongType = simd.slice()
  const t = sections(wrongType).find((s) => s.id === 1)
  assert.ok(t)
  wrongType[t.end - 1] = 0x7e
  assert.equal(WebAssembly.validate(wrongType), false)
  // One byte short of its declared length: invalid.
  assert.equal(WebAssembly.validate(simd.subarray(0, simd.length - 1)), false)
})

test('the exception module throws and catches its own tag in the legacy encoding; broken copies are refused', () => {
  const { eh } = modules()
  assert.equal(WebAssembly.validate(eh), true)
  const ids = sections(eh).map((s) => s.id)
  assert.deepEqual(ids, [1, 3, 13, 10], 'type, function, tag, code: the tag section where the specification orders it')
  const code = sections(eh).find((s) => s.id === 10)
  assert.ok(code && holds(code.body, [0x06, 0x40, 0x08, 0x00, 0x07, 0x00, 0x0b]), 'try, throw tag 0, catch tag 0, end (no try_table)')
  // catch names tag 1, which does not exist: invalid.
  const wrongTag = eh.slice()
  const at = code.end - 3
  assert.deepEqual([...wrongTag.subarray(at - 1, at + 1)], [0x07, 0x00])
  wrongTag[at] = 0x01
  assert.equal(WebAssembly.validate(wrongTag), false)
  // Without its tag section the throw names nothing: invalid.
  const tag = sections(eh).find((s) => s.id === 13)
  assert.ok(tag)
  const noTag = new Uint8Array([...eh.subarray(0, tag.at), ...eh.subarray(tag.end)])
  assert.equal(WebAssembly.validate(noTag), false)
})

test('each module stands for its feature: V8 started without it, only that probe turns false', (t) => {
  const noEh = probeUnder(['--no-experimental-wasm-legacy-eh'])
  if (noEh) {
    assert.equal(noEh.exceptions, false, 'without the legacy exception instructions the exception module is refused')
    assert.equal(noEh.simd, true)
  } else t.diagnostic('this Node has no --no-experimental-wasm-legacy-eh; skipped')
  // V8 on x64 offers WebAssembly SIMD only with SSE4.1, so turning it off takes SIMD away (the flag is x64 only).
  const noSimd = probeUnder(['--no-enable-sse4-1'])
  if (noSimd && !noSimd.simd) assert.equal(noSimd.exceptions, true)
  else t.diagnostic(noSimd ? 'this V8 keeps WebAssembly SIMD without SSE4.1; not provable here' : 'this Node has no --no-enable-sse4-1; skipped')
})

test('the probe hands the validator a copy, so a validator that writes into it cannot spoil the next probe', () => {
  probe(page({ WebAssembly: wasm({ validate: (b: Uint8Array) => (b.fill(0), true) }) }))
  const c = probe()
  assert.equal(c.simd, true)
  assert.equal(c.exceptions, true)
})

// ---------------------------------------------------------------- fake globals, one missing piece at a time

test('a page that offers everything reads as everything, and the runtime runs with threads', () => {
  const c = probe(page())
  assert.deepEqual(c, ALL)
  assert.deepEqual(runtimeMode(c), { ok: true, threads: true })
  assert.equal(capsLine(c), 'this browser runs it')
})

test('JSPI needs both WebAssembly.Suspending and WebAssembly.promising as functions', () => {
  assert.equal(probe(page({ WebAssembly: wasm({ Suspending: undefined }) })).jspi, false)
  assert.equal(probe(page({ WebAssembly: wasm({ promising: undefined }) })).jspi, false)
  assert.equal(probe(page({ WebAssembly: wasm({ Suspending: true }) })).jspi, false, 'present but not a function')
  assert.equal(probe(page({ WebAssembly: wasm({ promising: {} }) })).jspi, false)
  const c = probe(page({ WebAssembly: wasm({ Suspending: undefined }) }))
  assert.deepEqual({ ...c, jspi: true }, ALL, 'nothing else changes')
  const m = runtimeMode(c)
  assert.equal(m.ok, false)
  assert.equal(!m.ok && m.reason, "this browser cannot pause the model's runtime while it reads the file (JSPI); Chrome 137 or later on a computer or Android can")
})

test('the shared 64-bit memory is asked for as the glue asks: one page, BigInt limits, shared, address i64', () => {
  const seen: object[] = []
  assert.equal(probe(page({ WebAssembly: wasm({ Memory: glueMemory(seen) }) })).mem64shared, true)
  assert.deepEqual(seen, [{ initial: 1n, maximum: 1n, shared: true, address: 'i64' }])
})

test('an engine that ignores the address key reads as missing, even though it builds a 32-bit memory from Number limits', () => {
  // As Node 22's V8 12.4 does: the address key is ignored, Number limits make an ordinary memory, BigInts throw.
  function Memory32(d: { initial?: unknown; maximum?: unknown }) {
    if (typeof d.initial !== 'number' || (d.maximum !== undefined && typeof d.maximum !== 'number')) throw new TypeError('Cannot convert a BigInt value to a number')
  }
  const c = probe(page({ WebAssembly: wasm({ Memory: Memory32 }) }))
  assert.equal(c.mem64shared, false)
  assert.deepEqual({ ...c, mem64shared: true }, ALL)
  const m = runtimeMode(c)
  assert.ok(!m.ok && m.reason.includes('(WebAssembly Memory64)'))
})

test('an engine that refuses shared memory, or 64-bit addresses, or has no Memory, reads as missing', () => {
  function noShared(d: { shared?: unknown }) {
    if (d.shared) throw new TypeError('shared memory is not available here')
  }
  function noI64(d: { address?: unknown }) {
    if (d.address === 'i64') throw new TypeError("'i64' is not a valid address type")
  }
  function outOfMemory() {
    throw new RangeError('could not allocate memory')
  }
  for (const Memory of [noShared, noI64, outOfMemory, undefined, 'Memory']) {
    assert.equal(probe(page({ WebAssembly: wasm({ Memory }) })).mem64shared, false, String(Memory))
  }
})

test('a validator that refuses one module turns off only that capability', () => {
  const refuse = (tag: boolean) => (b: Uint8Array) => sections(b).some((s) => s.id === 13) !== tag
  const noSimd = probe(page({ WebAssembly: wasm({ validate: refuse(false) }) }))
  assert.deepEqual({ ...noSimd, simd: true }, ALL)
  assert.equal(noSimd.simd, false)
  const noEh = probe(page({ WebAssembly: wasm({ validate: refuse(true) }) }))
  assert.deepEqual({ ...noEh, exceptions: true }, ALL)
  assert.equal(noEh.exceptions, false)
  const s = runtimeMode(noSimd)
  const e = runtimeMode(noEh)
  assert.ok(!s.ok && s.reason.includes('(WebAssembly SIMD)'))
  assert.ok(!e.ok && e.reason.includes('(WebAssembly exceptions)'))
})

test('a validator that throws, answers something other than true, or is missing reads as no', () => {
  for (const validate of [() => { throw new Error('no') }, () => 1, () => 'true', undefined]) {
    const c = probe(page({ WebAssembly: wasm({ validate }) }))
    assert.equal(c.simd, false)
    assert.equal(c.exceptions, false)
  }
})

test('without WebAssembly at all, or with getters that throw, the probe still answers and never throws', () => {
  const none = probe(page({ WebAssembly: undefined }))
  assert.deepEqual(none, { ...ALL, jspi: false, mem64shared: false, simd: false, exceptions: false })
  const hostile = {}
  for (const key of ['WebAssembly', 'navigator', 'SharedArrayBuffer', 'crossOriginIsolated']) {
    Object.defineProperty(hostile, key, { get: () => { throw new Error(`${key} refused`) } })
  }
  assert.deepEqual(probe(hostile), { jspi: false, mem64shared: false, simd: false, exceptions: false, isolated: false, opfs: false, webgpu: false, opaque: false })
  assert.deepEqual(probe({}), { jspi: false, mem64shared: false, simd: false, exceptions: false, isolated: false, opfs: false, webgpu: false, opaque: false })
  const throwingWasm = Object.defineProperty({ ...wasm() }, 'Suspending', { get: () => { throw new Error('refused') } })
  assert.equal(probe(page({ WebAssembly: throwingWasm })).jspi, false)
})

test('isolation is canShareMemory: SharedArrayBuffer and crossOriginIsolated both; without it the runtime runs one thread', () => {
  assert.equal(probe(page()).isolated, true)
  assert.equal(probe(page({ crossOriginIsolated: false })).isolated, false)
  assert.equal(probe(page({ crossOriginIsolated: undefined })).isolated, false)
  assert.equal(probe(page({ SharedArrayBuffer: undefined })).isolated, false, 'a page that is not isolated has no SharedArrayBuffer at all')
  const c = probe(page({ SharedArrayBuffer: undefined, crossOriginIsolated: false }))
  assert.deepEqual(runtimeMode(c), { ok: true, threads: false }, 'isolation is not required')
  assert.equal(capsLine(c), 'this browser runs it (one thread: the page is not cross-origin isolated)')
})

test('OPFS is navigator.storage.getDirectory as a function; WebGPU is navigator.gpu; neither decides the runtime', () => {
  assert.equal(probe(page({ navigator: { storage: {} } })).opfs, false)
  assert.equal(probe(page({ navigator: { storage: { getDirectory: true } } })).opfs, false)
  assert.equal(probe(page({ navigator: {} })).opfs, false)
  assert.equal(probe(page({ navigator: undefined })).opfs, false)
  assert.equal(probe(page({ navigator: { gpu: {} } })).webgpu, true)
  assert.equal(probe(page({ navigator: { gpu: null } })).webgpu, false)
  assert.equal(probe(page({ navigator: { storage: { getDirectory: async () => ({}) } } })).webgpu, false)
  const bare = probe(page({ navigator: undefined }))
  assert.deepEqual(runtimeMode(bare), { ok: true, threads: true })
  assert.equal(capsLine(bare), 'this browser runs it')
})

test('a page opened from a file, or any page whose origin is opaque, cannot start the runtime, and the line says so', () => {
  // dist/index.html opened from disk in Chromium: protocol file:, self.origin "null", not isolated.
  const file = probe(page({ location: { protocol: 'file:' }, origin: 'null', SharedArrayBuffer: undefined, crossOriginIsolated: false }))
  assert.equal(file.opaque, true)
  assert.deepEqual({ ...file, opaque: false, isolated: true }, ALL, 'every piece of the browser is there')
  assert.deepEqual(runtimeMode(file), { ok: false, reason: OPAQUE_REASON })
  assert.equal(capsLine(file), OPAQUE_REASON, 'the runtime row no longer says this browser runs it')
  assert.doesNotMatch(capsLine(file), /runs it/)
  // Either sign alone is enough: a file page whose origin a browser spells otherwise, a sandboxed frame on a server.
  assert.equal(probe(page({ location: { protocol: 'file:' } })).opaque, true)
  assert.equal(probe(page({ location: { protocol: 'https:' }, origin: 'null' })).opaque, true)
  // Served pages are not: the preview, the launcher, the web copy, the Windows app.
  for (const [protocol, origin] of [['http:', 'http://127.0.0.1:4173'], ['https:', 'https://example.test'], ['tauri:', 'tauri://localhost']]) {
    const c = probe(page({ location: { protocol }, origin }))
    assert.equal(c.opaque, false, protocol)
    assert.deepEqual(runtimeMode(c), { ok: true, threads: true })
  }
  // A browser that lacks a piece is told that first: serving the page would not help it.
  const m = runtimeMode({ ...file, jspi: false })
  assert.ok(!m.ok && m.reason.includes('(JSPI)'))
  const hostile = Object.defineProperty(page(), 'location', { get: () => { throw new Error('refused') } })
  assert.equal(probe(hostile).opaque, false, 'a location that cannot be read says nothing about the origin')
  assert.match(OPAQUE_REASON, /^a page opened from a file cannot start the model's runtime/)
  assert.doesNotMatch(OPAQUE_REASON, /[–—\n]/, 'no dashes, one line')
})

// ---------------------------------------------------------------- the reason and the line

test('the reason names the first missing piece in the order JSPI, shared 64-bit memory, SIMD, exceptions', () => {
  const order = ['jspi', 'mem64shared', 'simd', 'exceptions'] as const
  const marks = { jspi: '(JSPI)', mem64shared: '(WebAssembly Memory64)', simd: '(WebAssembly SIMD)', exceptions: '(WebAssembly exceptions)' }
  for (let bits = 0; bits < 16; bits++) {
    for (const isolated of [true, false]) {
      const c: Caps = { ...ALL, isolated, jspi: !!(bits & 1), mem64shared: !!(bits & 2), simd: !!(bits & 4), exceptions: !!(bits & 8) }
      const m = runtimeMode(c)
      const first = order.find((k) => !c[k])
      if (!first) {
        assert.deepEqual(m, { ok: true, threads: isolated })
        continue
      }
      assert.equal(m.ok, false, JSON.stringify(c))
      if (m.ok) continue
      assert.ok(m.reason.includes(marks[first]), `${JSON.stringify(c)} -> ${m.reason}`)
      for (const other of order) if (other !== first) assert.ok(!m.reason.includes(marks[other]), 'one piece named, not several')
      assert.equal(capsLine(c), m.reason, 'the console line is the reason')
    }
  }
})

test('every reason is one plain sentence that says where the runtime does run', () => {
  const reasons = (['jspi', 'mem64shared', 'simd', 'exceptions'] as const).map((k) => {
    const m = runtimeMode({ ...ALL, [k]: false })
    assert.equal(m.ok, false)
    return m.ok ? '' : m.reason
  })
  assert.equal(new Set(reasons).size, 4, 'four different reasons')
  for (const r of reasons) {
    assert.match(r, /^this browser cannot /)
    assert.match(r, /; Chrome 137 or later on a computer or Android can$/)
    assert.doesNotMatch(r, /[–—\n]/, 'no dashes, one line')
  }
  assert.equal(capsLine({ ...ALL, opfs: false, webgpu: false }), 'this browser runs it', 'files and WebGPU are other rows')
})
