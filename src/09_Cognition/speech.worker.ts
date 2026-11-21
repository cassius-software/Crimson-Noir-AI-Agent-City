// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the worker that runs the page's own speech recogniser, off the page's thread: the
 * speech pack's model (speechPack.ts: Moonshine Tiny) on ONNX Runtime's WebAssembly build. The page hands it the
 * pack's four files as bytes (speechEngine.ts got them from beside the page); it hashes every byte against the pin
 * before it runs any (a file that is not the pin's is named back and waited for again, never run), loads the model,
 * and then reads one utterance at a time (speechCore.ts) and answers with the words. It has no way out: the air gap
 * is installed on its global before anything else (02_Define_The_Rules/airgap.ts, as the page and the physics worker
 * do), the runtime is imported only after that, it is handed its WebAssembly module as bytes so it fetches nothing,
 * and it runs on one thread, so it starts no worker of its own and needs no shared memory (it runs whether or not
 * the page is cross-origin isolated). This is the only file that names the runtime's package (airgap.test.ts holds
 * every other source to that). An utterance's samples are read and dropped: nothing is kept, written or sent.
 * What breaks if it is removed? The page has no recogniser of its own: words are understood only where the browser
 * brings an on-device recogniser.
 */
import { installAirgap } from '../02_Define_The_Rules/airgap.ts'
import { hex, sha256Stream } from '../02_Define_The_Rules/integrity.ts'
import { holdChecked, parseVocabulary, readUtterance, type SpeechRuntime, type Vocabulary } from './speechCore.ts'
import type { SpeechReply, SpeechRequest } from './speechEngine.ts'
import { ortConfigure, ortRuntime, type OrtLike } from './speechOrt.ts'
import type { SpeechRole } from './speechPack.ts'

installAirgap(globalThis)

const scope = globalThis as unknown as {
  postMessage(message: SpeechReply): void
  onmessage: ((e: { data: SpeechRequest }) => unknown) | null
  crypto?: { subtle?: { digest(algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer> } }
  performance: { now(): number }
}

/** The files that passed their hash, by role, until all four are here. */
const held = new Map<SpeechRole, ArrayBuffer>()
const ROLES: readonly SpeechRole[] = ['runtime', 'encoder', 'decoder', 'tokens']
let runtime: (SpeechRuntime & { release(): Promise<void> }) | null = null
let vocabulary: Vocabulary | null = null
let loading = false

/** The SHA-256 of bytes, in hex: the browser's own where it has one here, else the page's (integrity.ts). */
async function digest(bytes: ArrayBuffer): Promise<string> {
  const subtle = scope.crypto?.subtle
  if (subtle) {
    try {
      return hex(new Uint8Array(await subtle.digest('SHA-256', bytes)))
    } catch {
      // Refused here (an insecure context has none): the page's own.
    }
  }
  const h = sha256Stream()
  const view = new Uint8Array(bytes)
  const step = 1 << 20
  for (let i = 0; i < view.length; i += step) h.update(view.subarray(i, Math.min(view.length, i + step)))
  return hex(h.digest())
}

const say = (e: unknown): string => (e instanceof Error && e.message ? e.message : String(e))

/** Takes files, checks each, and loads the model once all four are held. */
async function load(files: { role: SpeechRole; bytes: ArrayBuffer; sha256: string }[]): Promise<void> {
  if (runtime !== null || loading) return
  // Every file is checked; the good ones are held while a bad one is named back and waited for again.
  const bad = await holdChecked(held, files.filter((f) => ROLES.includes(f.role)), digest)
  for (const role of bad) scope.postMessage({ t: 'bad', role })
  if (bad.length > 0 || !ROLES.every((r) => held.has(r))) return
  loading = true
  const t = scope.performance.now()
  try {
    vocabulary = parseVocabulary(new TextDecoder('utf-8').decode(held.get('tokens')!))
    // The runtime's JavaScript, only now (the gate above stands before it is ever evaluated). One thread, its
    // WebAssembly module as the bytes just checked: it fetches nothing and starts no worker.
    const ort = (await import('onnxruntime-web/wasm')) as unknown as OrtLike
    ortConfigure(ort, held.get('runtime')!)
    runtime = await ortRuntime(ort, held.get('encoder')!, held.get('decoder')!)
    // The sessions hold their own copies inside the module's memory: the files' bytes are let go.
    held.clear()
    scope.postMessage({ t: 'ready', ms: Math.round(scope.performance.now() - t) })
  } catch (e) {
    runtime = null
    vocabulary = null
    held.clear()
    scope.postMessage({ t: 'failed', why: `this browser could not load the speech model (${say(e)})` })
  } finally {
    loading = false
  }
}

/** One utterance after another, in the order they came: the runtime runs one inference at a time. */
let chain: Promise<void> = Promise.resolve()

scope.onmessage = (e) => {
  const m = e.data
  if (!m || typeof m !== 'object') return
  if (m.t === 'load') {
    chain = chain.then(() => load(m.files)).catch(() => undefined)
    return
  }
  if (m.t === 'read') {
    chain = chain.then(async () => {
      const rt = runtime, vocab = vocabulary
      if (rt === null || vocab === null) {
        scope.postMessage({ t: 'error', id: m.id, why: 'the speech model is not loaded' })
        return
      }
      const t = scope.performance.now()
      try {
        const reading = await readUtterance(rt, m.samples, vocab)
        scope.postMessage({ t: 'read', id: m.id, reading, ms: Math.round(scope.performance.now() - t) })
      } catch (err) {
        scope.postMessage({ t: 'error', id: m.id, why: say(err) })
      }
    })
  }
}
