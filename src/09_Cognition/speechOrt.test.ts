// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the fitting of ONNX Runtime to the speech recogniser (speechOrt.ts) to what makes
 * it run everywhere and fetch nothing: one thread, no proxy worker, the WebAssembly module handed in as bytes; a fresh
 * options object for each session (the runtime writes into the one it is given, so a shared or frozen one throws);
 * the three tensors in the types the model takes (float32, one int64 token, one bool); the encoder let go when the
 * decoder will not load; and no import of the runtime's package in this file or any other but the worker.
 * What breaks if it is removed? A change here could start threads (which need a cross-origin isolated page the
 * single-file page does not always have), let the runtime fetch its module from the network, or leak a session.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ortConfigure, ortRuntime, ortSession, type OrtLike } from './speechOrt.ts'

/** The runtime's API as a recorder. */
function fakeOrt(o: { failOn?: number } = {}) {
  const made: { model: Uint8Array; options: Record<string, unknown> | undefined; released: boolean }[] = []
  const tensors: { type: string; data: unknown; dims: readonly number[] }[] = []
  class Tensor {
    readonly type: string
    readonly data: unknown
    readonly dims: readonly number[]
    constructor(type: string, data: unknown, dims: readonly number[]) {
      this.type = type
      this.data = data
      this.dims = dims
      tensors.push(this)
    }
  }
  const ort: OrtLike = {
    env: { wasm: {} },
    InferenceSession: {
      async create(model, options) {
        if (made.length === o.failOn) throw new Error('bad model')
        // As the real runtime does: it writes into the options it was given.
        if (options) options.extra = {}
        const s = { model, options, released: false }
        made.push(s)
        return { outputNames: [], run: async () => ({}), release: async () => { s.released = true } }
      },
    },
    Tensor,
  }
  return { ort, made, tensors }
}

test('configured to run inside one thread from bytes it is handed: no threads, no proxy worker, no fetch of its module', () => {
  const { ort } = fakeOrt()
  const wasm = new Uint8Array([0, 97, 115, 109]).buffer
  ortConfigure(ort, wasm)
  assert.deepEqual(ort.env.wasm, { numThreads: 1, proxy: false, wasmBinary: wasm })
})

test('each session gets its own options: the plain WebAssembly provider, the graph optimised at load', async () => {
  const a = ortSession(), b = ortSession()
  assert.notEqual(a, b, 'a fresh object each time')
  assert.deepEqual(a, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
  assert.ok(!Object.isFrozen(a), 'the runtime writes into it')
  const { ort, made } = fakeOrt()
  const enc = Uint8Array.from([1, 2, 3]).buffer, dec = Uint8Array.from([4, 5]).buffer
  const rt = await ortRuntime(ort, enc, dec)
  assert.deepEqual(made.map((m) => [...m.model]), [[1, 2, 3], [4, 5]], 'the encoder, then the decoder, from their bytes')
  assert.notEqual(made[0].options, made[1].options)
  assert.deepEqual(made.map((m) => m.options?.executionProviders), [['wasm'], ['wasm']])
  assert.ok(rt.encoder && rt.decoder)
  await rt.release()
  assert.deepEqual(made.map((m) => m.released), [true, true])
})

test('the three tensors the loop feeds: float32 with its shape, one int64 token, one bool', async () => {
  const { ort, tensors } = fakeOrt()
  const rt = await ortRuntime(ort, new ArrayBuffer(1), new ArrayBuffer(1))
  const data = new Float32Array([0.5, -0.5])
  rt.float(data, [1, 2])
  rt.token(31_999)
  rt.flag(true)
  rt.flag(false)
  assert.deepEqual(tensors.map((t) => [t.type, t.dims]), [['float32', [1, 2]], ['int64', [1, 1]], ['bool', [1]], ['bool', [1]]])
  assert.equal(tensors[0].data, data, 'the samples are not copied')
  assert.ok(tensors[1].data instanceof BigInt64Array)
  assert.deepEqual([...(tensors[1].data as BigInt64Array)], [31_999n])
  assert.deepEqual([tensors[2].data, tensors[3].data], [[true], [false]])
})

test('a decoder that will not load lets the encoder go and says why; a release that throws is swallowed', async () => {
  const f = fakeOrt({ failOn: 1 })
  await assert.rejects(ortRuntime(f.ort, new ArrayBuffer(1), new ArrayBuffer(1)), /bad model/)
  assert.deepEqual(f.made.map((m) => m.released), [true], 'the encoder is not left in the module\'s memory')
  const first = fakeOrt({ failOn: 0 })
  await assert.rejects(ortRuntime(first.ort, new ArrayBuffer(1), new ArrayBuffer(1)), /bad model/)
  const { ort } = fakeOrt()
  const create = ort.InferenceSession.create.bind(ort.InferenceSession)
  ort.InferenceSession.create = async (m, o) => ({ ...(await create(m, o)), release: async () => { throw new Error('already released') } })
  const rt = await ortRuntime(ort, new ArrayBuffer(1), new ArrayBuffer(1))
  await rt.release()
})

test('the fitting imports no runtime: the package is named by the worker alone', () => {
  const src = readFileSync(new URL('./speechOrt.ts', import.meta.url), 'utf8')
  assert.deepEqual([...src.matchAll(/^import .*$/gm)].map((m) => m[0]), ["import type { SessionLike, SpeechRuntime } from './speechCore.ts'"])
  assert.doesNotMatch(src, /import\(/, 'no dynamic import either')
})
