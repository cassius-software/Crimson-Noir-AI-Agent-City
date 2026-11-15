// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It names the speech pack: the four files the page's own speech recogniser needs (the
 * runtime's WebAssembly module, the model's encoder and decoder, and its vocabulary), each by its name, its size and
 * its SHA-256, and it fetches them from beside the page. The pack is what lets the microphone understand words in
 * any browser that can run it: a browser's own on-device recogniser exists in a few desktop browsers and nowhere on a phone, so
 * without the pack an open microphone hears a voice and reads nothing. The files are not in the page (they are 41 MB;
 * tools/verify/page_dist.mjs holds the page to its budget): the web copy serves them beside it, in speech/, where
 * tools/web/speechPack.mjs puts them with a manifest that names exactly this pin, and the page asks for them only
 * where the manifest says they are. Once fetched they are kept in the browser's Cache Storage (speechStore), so a
 * later visit asks the network for nothing and understands words offline; the worker that reads them
 * (speech.worker.ts) hashes every byte before it runs any, kept or fresh: a file that is not the pin's is forgotten
 * and fetched once more past every cache, and refused if it is still not.
 * Licences: the model is Moonshine Tiny (English), MIT, by Useful Sensors, Inc.; the runtime is ONNX Runtime Web,
 * MIT, by Microsoft (third_party/moonshine-tiny-en/NOTICE, third_party/onnxruntime-web/1.31.1/NOTICE).
 * What breaks if it is removed? Nothing names what the recogniser may run, so nothing can be fetched or checked: the
 * microphone goes back to understanding words only where the browser brings its own recogniser.
 */
import { SITE_DIR, type SiteFetch } from './siteModel.ts'

/** What a file of the pack is to the recogniser. */
export type SpeechRole = 'runtime' | 'encoder' | 'decoder' | 'tokens'

/** One file of the pack: its name in speech/, its exact size and SHA-256. */
export interface SpeechFile {
  readonly role: SpeechRole
  readonly file: string
  readonly bytes: number
  readonly sha256: string
}

/** The pack: which model and runtime, and the files. */
export interface SpeechPackPin {
  /** The pack's name in the manifest: a new model or runtime is a new id, so an old folder is never mistaken for it. */
  readonly id: string
  /** The model, for the card and the console. */
  readonly name: string
  /** The language it understands (BCP 47). */
  readonly lang: string
  readonly files: readonly SpeechFile[]
}

/**
 * The pack this page was built for. Moonshine Tiny (English), quantized ONNX: 27 million parameters, reads a short
 * sentence in a fraction of a second on one thread of a phone, and its encoder takes audio of any length (a sentence
 * costs what it lasts, not a fixed half minute). ONNX Runtime's plain WebAssembly build runs it: one thread, no
 * shared memory, so it needs no cross-origin isolation (whether a given browser runs it was tried in desktop Chromium
 * only). Where each file comes
 * from (the packages, their versions, the registry tarball) is the tool's to know, not the page's: the page names no
 * address but its own (tools/web/speechPack.mjs SOURCES; third_party/moonshine-tiny-en/NOTICE).
 */
export const SPEECH_PACK: SpeechPackPin = Object.freeze({
  id: 'moonshine-tiny-en-q8+ort-1.31.1',
  name: 'Moonshine Tiny (English)',
  lang: 'en',
  files: Object.freeze([
    Object.freeze({ role: 'runtime', file: 'ort-wasm-simd-threaded.wasm', bytes: 14_848_852, sha256: '4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d' }),
    Object.freeze({ role: 'encoder', file: 'encoder_model.onnx', bytes: 7_937_661, sha256: 'c6fc4b7bc5af75c0591fd157a1f3829b533d18e9769a888fd95a62e470dd4f4a' }),
    Object.freeze({ role: 'decoder', file: 'decoder_model_merged.onnx', bytes: 20_243_286, sha256: 'eed87831c3a6103534aae7d47a5d485025c659a1323901513961c39fe8a1a367' }),
    Object.freeze({ role: 'tokens', file: 'tokens.json', bytes: 307_261, sha256: '23a600089d29502c8966c95cb1b6318e015bbaf23e130fab6f4bb078402c9420' }),
  ] as const),
})

/** The folder beside the page that holds the pack, its manifest and its licences. */
export const SPEECH_DIR = 'speech/'
/** The manifest tools/web/speechPack.mjs writes beside the pack: `{"v":1,"id","files":[{"role","file","bytes","sha256"}]}`. */
export const SPEECH_MANIFEST = `${SPEECH_DIR}manifest.json`

/** The pack's whole size in bytes. */
export const speechBytes = (pin: SpeechPackPin = SPEECH_PACK): number => pin.files.reduce((n, f) => n + f.bytes, 0)

/** The pack's size in words for the pill and the console: megabytes as people count them (1024² bytes), whole. */
export const speechSize = (pin: SpeechPackPin = SPEECH_PACK): string => `${Math.round(speechBytes(pin) / (1024 * 1024))} MB`

/** The file of the pack with a role. */
export function speechFile(role: SpeechRole, pin: SpeechPackPin = SPEECH_PACK): SpeechFile {
  const f = pin.files.find((x) => x.role === role)
  if (!f) throw new Error(`the speech pack has no ${role}`)
  return f
}

/** The manifest's text as the tool writes it, one line and a newline. */
export function speechManifestText(pin: SpeechPackPin = SPEECH_PACK): string {
  return `${JSON.stringify({ v: 1, id: pin.id, files: pin.files.map((f) => ({ role: f.role, file: f.file, bytes: f.bytes, sha256: f.sha256 })) })}\n`
}

/** Whether a served manifest names exactly `pin`: anything else (another pack, a 404 page, junk) is no offer. */
export function parseSpeechManifest(text: string, pin: SpeechPackPin = SPEECH_PACK): boolean {
  let m: unknown
  try {
    m = JSON.parse(text)
  } catch {
    return false
  }
  if (typeof m !== 'object' || m === null) return false
  const o = m as { v?: unknown; id?: unknown; files?: unknown }
  if (o.v !== 1 || o.id !== pin.id || !Array.isArray(o.files) || o.files.length !== pin.files.length) return false
  return pin.files.every((f, i) => {
    const g = (o.files as unknown[])[i] as { role?: unknown; file?: unknown; bytes?: unknown; sha256?: unknown } | null
    return typeof g === 'object' && g !== null && g.role === f.role && g.file === f.file && g.bytes === f.bytes && g.sha256 === f.sha256
  })
}

/**
 * Whether the site serves this pack beside the page: its manifest names exactly `pin`. False where the site says it
 * has none (a 404, a 410, a 403 or any other refusal, or anything that is not this pin's manifest: the page file
 * opened alone has nothing beside it). Throws where the site could not say just now (unreachable, a 408, a 429, a
 * 5xx), so the caller asks again later.
 */
export async function speechOffered(siteFetch: SiteFetch, pin: SpeechPackPin = SPEECH_PACK, signal?: AbortSignal): Promise<boolean> {
  const r = await siteFetch(SPEECH_MANIFEST, { cache: 'no-cache', signal })
  if (r.ok) return parseSpeechManifest(await r.text(), pin)
  void r.body?.cancel().catch(() => undefined)
  // Busy or failing just now (a timeout, too many requests, a server error): asked again later. Any other refusal
  // (missing, forbidden: a host that answers 403 for what it does not have) is a site with no pack.
  if (r.status === 408 || r.status === 429 || r.status >= 500) throw new Error(`the site answered ${r.status} for the speech pack's manifest`)
  return false
}

/**
 * One file of the pack from beside the page, whole, as an ArrayBuffer of exactly the pin's size. `fresh` false lets
 * the browser's HTTP cache answer once the site says its copy is still current (the file's path is the same under
 * every pin, so a copy from an older pin must not be taken unasked); `fresh` true goes past the cache (asked once,
 * when the kept copy's hash was wrong). `onBytes(n)` is told each chunk's
 * size as it arrives. The hash is the worker's to check (it has the bytes off the page's thread); the size is
 * checked here, since a short or long body is known without hashing. Rejects with a plain sentence.
 */
export async function fetchSpeechFile(siteFetch: SiteFetch, f: SpeechFile, onBytes: (n: number) => void, signal?: AbortSignal, fresh = false): Promise<ArrayBuffer> {
  signal?.throwIfAborted()
  let res: Response
  try {
    res = await siteFetch(`${SPEECH_DIR}${f.file}`, { cache: fresh ? 'reload' : 'no-cache', signal })
  } catch (e) {
    signal?.throwIfAborted()
    throw new Error(`this site could not be reached for the speech pack (${e instanceof Error ? e.message : String(e)})`)
  }
  if (!res.ok || !res.body) {
    void res.body?.cancel().catch(() => undefined)
    throw new Error(`this site did not send ${f.file} of the speech pack (HTTP ${res.status})`)
  }
  // One buffer of the pin's size, filled as the chunks come: no list of chunks to join, and a body that runs past
  // the size is refused the moment it does.
  const out = new Uint8Array(f.bytes)
  let got = 0
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (got + value.byteLength > f.bytes) throw new Error(`what this site sent as ${f.file} is larger than the speech pack this page was built for`)
      out.set(value, got)
      got += value.byteLength
      onBytes(value.byteLength)
    }
  } catch (e) {
    void reader.cancel().catch(() => undefined)
    signal?.throwIfAborted()
    throw e instanceof Error && /larger than/.test(e.message) ? e : new Error(`the download of ${f.file} stopped at ${got.toLocaleString('en-US')} of ${f.bytes.toLocaleString('en-US')} bytes`)
  }
  signal?.throwIfAborted()
  if (got !== f.bytes) throw new Error(`the download of ${f.file} stopped at ${got.toLocaleString('en-US')} of ${f.bytes.toLocaleString('en-US')} bytes`)
  return out.buffer
}

/** The part of the browser's Cache Storage the keep uses (`caches`). */
export interface CachesLike {
  open(name: string): Promise<{
    match(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | undefined>
    put(key: string, response: Response): Promise<void>
    delete(key: string): Promise<boolean>
  }>
  keys(): Promise<string[]>
  delete(name: string): Promise<boolean>
}

/** Where the page keeps the pack between visits. Every call settles: a browser that refuses storage keeps nothing. */
export interface SpeechStore {
  /** The kept copy of a file, only when it is exactly the pin's size (its hash is the worker's to check); else null. */
  get(f: SpeechFile): Promise<ArrayBuffer | null>
  /** Keeps a file's bytes (they are not detached: the caller hands them on after this settles). */
  put(f: SpeechFile, bytes: ArrayBuffer): Promise<void>
  /** Forgets a file (its kept copy turned out not to be the pin's). */
  drop(f: SpeechFile): Promise<void>
}

/** The prefix of the keep's name in Cache Storage. Not the web copy's own prefix: its service worker clears those on every publish. */
export const SPEECH_CACHE = 'speech-pack:'

/**
 * The keep, in the browser's Cache Storage under a name of the pack's own: one cache per pack id, each file under its
 * name and SHA-256, so a file of another pin is never mistaken for this one's. Kept there, not left to the browser's
 * HTTP cache: that cache refuses large entries on a device short of space (a tenth of it or less per file) and is the
 * first thing a browser clears, and a visitor on mobile data should not pay for the pack twice. With the pack kept, a
 * later visit asks the network for nothing and understands words offline. A keep of an older pack is cleared when
 * this one is first written. `caches` null (an insecure page, a browser without it) or refusing (private browsing)
 * keeps nothing, and the pack is then fetched each visit, the browser's own cache preferred.
 */
export function speechStore(caches: CachesLike | null | undefined, pin: SpeechPackPin = SPEECH_PACK, respond: (bytes: ArrayBuffer) => Response = (bytes) => new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })): SpeechStore {
  const name = `${SPEECH_CACHE}${pin.id}`
  const key = (f: SpeechFile): string => `${SPEECH_DIR}${f.file}?sha256=${f.sha256}`
  // The sweep of older packs, once, awaited by every put (the four files are put at once: none goes in before the
  // room is made); a sweep that fails leaves the put to try anyway.
  let sweep: Promise<void> | null = null
  const sweepOnce = (c: CachesLike): Promise<void> => (sweep ??= (async () => {
    try {
      for (const other of await c.keys()) if (other.startsWith(SPEECH_CACHE) && other !== name) await c.delete(other)
    } catch {
      // Storage refused the sweep: the put below may still find room.
    }
  })())
  return {
    async get(f) {
      if (!caches) return null
      try {
        const hit = await (await caches.open(name)).match(key(f))
        if (!hit) return null
        const bytes = await hit.arrayBuffer()
        return bytes.byteLength === f.bytes ? bytes : null
      } catch {
        return null
      }
    },
    async put(f, bytes) {
      if (!caches) return
      // An older pin's pack goes first: it is what would leave no room for this one.
      await sweepOnce(caches)
      try {
        await (await caches.open(name)).put(key(f), respond(bytes))
      } catch {
        // No room, or storage refused: the pack is fetched again next visit.
      }
    },
    async drop(f) {
      if (!caches) return
      try {
        await (await caches.open(name)).delete(key(f))
      } catch {
        // Nothing to forget.
      }
    },
  }
}

/** The path of a pack file as the page asks for it (siteModel.ts siteUrl admits speech/ beside models/). */
export const speechPath = (f: SpeechFile): string => `${SPEECH_DIR}${f.file}`

/** The served folders' names, for the service worker and the tools: both are left to the network and the browser's cache. */
export const SERVED_DIRS = Object.freeze([SITE_DIR, SPEECH_DIR])
