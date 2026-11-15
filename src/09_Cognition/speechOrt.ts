// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It fits ONNX Runtime to the speech recogniser's loop (speechCore.ts SpeechRuntime): the
 * two sessions made from the pack's model files, and the three tensors the loop feeds them. It takes the runtime as
 * an argument and imports none, so the one file that names the package stays the worker (speech.worker.ts, which the
 * air-gap test holds to), and the tool that checks the pack under Node (tools/web/speechPack.mjs) uses the very same
 * fitting the page does.
 * What breaks if it is removed? The worker and the tool would each fit the runtime their own way, and a pack the tool
 * passed could fail in the page.
 */
import type { SessionLike, SpeechRuntime } from './speechCore.ts'

/** The few things of ONNX Runtime's JavaScript API this uses. */
export interface OrtLike {
  readonly env: { wasm: { numThreads?: number; proxy?: boolean; wasmBinary?: ArrayBuffer | Uint8Array } }
  readonly InferenceSession: { create(model: Uint8Array, options?: Record<string, unknown>): Promise<SessionLike & { release?(): Promise<void> }> }
  readonly Tensor: new (type: string, data: unknown, dims: readonly number[]) => unknown
}

/** How the sessions are made: the plain WebAssembly provider, the graph optimised once at load. A fresh object each
 *  time: the runtime writes its own fields into the options it is given. */
export const ortSession = (): Record<string, unknown> => ({ executionProviders: ['wasm'], graphOptimizationLevel: 'all' })

/**
 * Sets the runtime up to run inside one thread from bytes it is handed: one thread (no shared memory is needed, so
 * it runs in every browser, cross-origin isolated or not), no proxy worker (the caller is the worker), and the
 * WebAssembly module's own bytes, so the runtime fetches nothing.
 */
export function ortConfigure(ort: OrtLike, wasm: ArrayBuffer): void {
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false
  ort.env.wasm.wasmBinary = wasm
}

/** The loop's runtime over ONNX Runtime: the encoder and decoder sessions from their files' bytes. */
export async function ortRuntime(ort: OrtLike, encoder: ArrayBuffer, decoder: ArrayBuffer): Promise<SpeechRuntime & { release(): Promise<void> }> {
  const enc = await ort.InferenceSession.create(new Uint8Array(encoder), ortSession())
  let dec: Awaited<ReturnType<OrtLike['InferenceSession']['create']>>
  try {
    dec = await ort.InferenceSession.create(new Uint8Array(decoder), ortSession())
  } catch (e) {
    await enc.release?.().catch(() => undefined)
    throw e
  }
  return {
    encoder: enc,
    decoder: dec,
    float: (data, dims) => new ort.Tensor('float32', data, dims),
    token: (id) => new ort.Tensor('int64', BigInt64Array.from([BigInt(id)]), [1, 1]),
    flag: (on) => new ort.Tensor('bool', [on], [1]),
    release: async () => {
      await enc.release?.().catch(() => undefined)
      await dec.release?.().catch(() => undefined)
    },
  }
}
