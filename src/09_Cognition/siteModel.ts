// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the one model the web copy serves beside the page, so a visitor with no model server
 * and no model file of their own can still talk to Sloane: a small GGUF (SITE_MODEL, pinned here by its file name, its
 * size and its SHA-256), put into dist-web/models/ by the web workflow (tools/web/siteModel.mjs, .github/workflows/
 * web.yml) after it has checked the same pin, and never in dist/ (the page file, the Windows app and the release
 * builds carry no model). The page learns that the model is there from models/manifest.json beside it (parseManifest:
 * an offer only when the manifest names exactly this pin), asked once the city is on screen (siteAuto.ts says whether
 * the page gets it by itself: where it can run and keep it, no other model was chosen and the connection does not say
 * the data costs) or when Sloane's card says no model answers, and fetches it then or on the visitor's tap
 * (one job at a time: siteJob.ts) from the page's own origin and its own folder (siteUrl: a models/ path relative to
 * the page, never the origin's root, which on GitHub Pages is another site), counted and hashed piece by piece as it
 * arrives (integrity.ts sha256Stream), and refused the moment it runs long. Where a worker can write the page's
 * storage (modelStore.ts openPart), it downloads straight into a part file there (downloadSiteModel): a part that
 * stopped is picked up with Range and If-Range (the server's strong ETag, else its Last-Modified; never a weak ETag),
 * and only a 206 whose Content-Range starts where the part ends and totals the pin's size goes on from there; a 200
 * (the server ignores Range, or the file changed) starts over from the first byte, and so does a 416 or a 206 that
 * does not fit, asked once more without Range. The size and the SHA-256 of the whole file (a part picked up is read
 * back and hashed again first, modelPart.ts) are compared to the pin before anything is kept, and a part that fails is
 * deleted. Elsewhere (no synchronous handle in a worker, no storage the page may write) it downloads as before
 * (fetchSiteModel): into a File, only once every byte has passed, then kept exactly as a picked file is (App.tsx
 * keepPicked).
 * Nothing here fetches by itself: the fetch is handed in (App.tsx siteFetch, under the global air gap, which admits
 * the page's own origin as the content policy's connect-src 'self' does).
 * The Windows app carries a model of its own the same way (APP_MODEL, beside the app rather than beside a page): the
 * shell lends the page a read of that one file (src-tauri/src/model.rs, desktopShell.ts shellModelFetch), handed in
 * here in place of the site's fetch, and the same checks hold it to its pin.
 * What breaks if it is removed? A fresh visitor to the web copy is back to finding a model file or a model server of
 * their own before Sloane can say a word, and so is a fresh install of the Windows app.
 */
import { hex, sha256Stream } from '../02_Define_The_Rules/integrity.ts'
import type { SiteJob } from './siteJob.ts'

/** The one model the web copy serves: what the page was built for, and what the workflow checks before it serves it. */
export interface SiteModelPin {
  /** The file's name, as served under models/ and as kept in the page. */
  readonly file: string
  /** Its exact size in bytes. */
  readonly bytes: number
  /** Its SHA-256, 64 lower-case hex characters. */
  readonly sha256: string
  /** Where the workflow fetches it: the repository on Hugging Face and the revision pinned there (no address here). */
  readonly repo: string
  readonly revision: string
  /** The model's name, for the card. */
  readonly title: string
}

/**
 * Qwen2.5 0.5B Instruct at Q4_K_M, as quantized with an importance matrix by bartowski from Qwen's own weights
 * (Apache-2.0, Copyright 2024 Alibaba Cloud; third_party/qwen2.5-0.5b-instruct/ holds the licence and the notice).
 * About 0.4 GB: small enough for a phone's in-page limit (inPagePlan.ts) and to run on a processor alone. Its byte
 * count and hash equal the SHA256SUMS line beside the notice (siteModel.test.ts).
 */
export const SITE_MODEL: SiteModelPin = Object.freeze({
  file: 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf',
  bytes: 397_808_192,
  sha256: '6eb923e7d26e9cea28811e1a8e852009b21242fb157b26149d3b188f3a8c8653',
  repo: 'bartowski/Qwen2.5-0.5B-Instruct-GGUF',
  revision: '41ba88dbac95fed2528c92514c131d73eb5a174b',
  title: 'Qwen2.5 0.5B Instruct',
})

/**
 * Qwen2.5 1.5B Instruct at Q4_K_M, the same quantization by bartowski of Qwen's own weights (Apache-2.0, Copyright
 * 2024 Alibaba Cloud; third_party/qwen2.5-1.5b-instruct/ holds the licence and the notice): the model the Windows app's
 * installer carries beside the app (src-tauri/tauri.model.conf.json, src-tauri/src/model.rs) and the NixOS package's
 * launcher serves beside the page (tools/nix/model.nix, tools/web/launch.mjs), which the page copies into its own
 * storage once the city is on screen, as the web copy gets SITE_MODEL. About 0.9 GB: a desktop's in-page limits take
 * it (inPagePlan.ts), and it answers better than the 0.5B. Its byte count and hash equal the SHA256SUMS line beside its
 * notice, and src-tauri/src/model_file.rs and tools/nix/model.nix name the same file and size (siteModel.test.ts).
 */
export const APP_MODEL: SiteModelPin = Object.freeze({
  file: 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
  bytes: 986_048_768,
  sha256: '1adf0b11065d8ad2e8123ea110d1ec956dab4ab038eab665614adba04b6c3370',
  repo: 'bartowski/Qwen2.5-1.5B-Instruct-GGUF',
  revision: '9eadc66189c7641e1ddd226b8267a9119b2ce2d4',
  title: 'Qwen2.5 1.5B Instruct',
})

/**
 * Where the pinned model comes from: `site`, the web copy's own site, beside the page (SITE_MODEL); `app`, the Windows
 * app that carries it beside itself (APP_MODEL, read through the shell: desktopShell.ts shellModelFetch); `launcher`,
 * the NixOS package's launcher on this machine, which serves it beside the page it opened (APP_MODEL, at models/ on
 * 127.0.0.1: launcherServes). The words a visitor reads follow it; the checks are the same.
 */
export type SiteModelFrom = 'site' | 'app' | 'launcher'

/** The word the NixOS launcher adds to the address when it serves a model beside the page (tools/web/launch.mjs
 *  serveModels): models=1. */
export const LAUNCHER_WORD = 'models'

/**
 * Whether the page at `href` was opened by the NixOS launcher with a model beside it: served over plain http from
 * 127.0.0.1, the one address the launcher listens on, with models=1 in its address. Any other page (the web copy, the
 * Windows app, a preview, a file) asks it for nothing.
 */
export function launcherServes(href: string): boolean {
  try {
    const u = new URL(href)
    return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.searchParams.get(LAUNCHER_WORD) === '1'
  } catch {
    return false
  }
}

/** The folder beside the page that holds the served model, its manifest and its licence. */
export const SITE_DIR = 'models/'
/** The manifest the workflow writes beside the model: `{"v":1,"file","bytes","sha256"}`. */
export const SITE_MANIFEST = `${SITE_DIR}manifest.json`

/** What the manifest says, once it names exactly the pinned model. */
export interface SiteModelOffer {
  readonly file: string
  readonly bytes: number
  readonly sha256: string
}

/**
 * A path inside a served folder: models/ (the model) or speech/ (the speech pack, speechPack.ts) and one plain file
 * name, nothing that climbs out or names a host.
 */
const SITE_PATH = /^(?:models|speech)\/[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * The address of `path` (a file under models/ or speech/) beside the page at `base`, on the page's own origin over http(s); throws
 * with the reason otherwise. Relative to the page's own folder, never the origin's root: on GitHub Pages the root of
 * the origin is another site of the same owner.
 */
export function siteUrl(path: string, base: string): string {
  if (!SITE_PATH.test(path) || path.includes('..')) throw new Error(`${path} is not a file this site serves beside the page`)
  let page: URL
  try {
    page = new URL(base)
  } catch {
    throw new Error('this page has no address to fetch its model from')
  }
  if (page.protocol !== 'https:' && page.protocol !== 'http:') throw new Error('this page was not served by a web server, so no model is served beside it')
  const u = new URL(path, page)
  if (u.origin !== page.origin) throw new Error(`${path} is not on this page's own site`)
  return u.href
}

/** The served manifest's text as an offer, only when it names exactly `pin`; anything else (a newer pin, a 404 page, junk) is no offer. */
export function parseManifest(text: string, pin: SiteModelPin = SITE_MODEL): SiteModelOffer | null {
  let m: unknown
  try {
    m = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof m !== 'object' || m === null) return null
  const o = m as Record<string, unknown>
  if (o.v !== 1 || o.file !== pin.file || o.bytes !== pin.bytes || o.sha256 !== pin.sha256) return null
  return { file: pin.file, bytes: pin.bytes, sha256: pin.sha256 }
}

/** The manifest's text as the workflow writes it (tools/web/siteModel.mjs), one line and a newline. */
export function manifestText(pin: SiteModelPin = SITE_MODEL): string {
  return `${JSON.stringify({ v: 1, file: pin.file, bytes: pin.bytes, sha256: pin.sha256 })}\n`
}

/** A fetch held to this site's served folder: a path under models/ and the request's options. */
export type SiteFetch = (path: string, init: RequestInit) => Promise<Response>

/** MB as the card counts them (1024² bytes). */
const MIB = 1024 * 1024

/**
 * The plain sentence for a download that ended short of the model: whole megabytes while they differ, bytes once it
 * stopped inside the last megabyte, so a download that ended short never reads "379 of 379 MB".
 */
const shortOf = (got: number, pin: SiteModelPin, from: SiteModelFrom = 'site', kept = false): string => {
  const mb = (n: number): number => Math.floor(n / MIB)
  const at = mb(got) < mb(pin.bytes) ? `${mb(got)} of ${mb(pin.bytes)} MB` : `${got.toLocaleString('en-US')} of ${pin.bytes.toLocaleString('en-US')} bytes`
  // `kept`: what arrived waits in a part the next try picks up, so that try asks only for the rest.
  return `${from === 'site' ? 'the download' : `the copy from ${sender(from)}`} stopped at ${at}: try again${kept && got > 0 ? `, and the next try asks ${sender(from)} only for the rest` : ''}`
}

/** Who sent the model, in a sentence. */
const sender = (from: SiteModelFrom): string => (from === 'app' ? 'the app' : from === 'launcher' ? 'the launcher' : 'this site')

/** Why the model could not be asked for at all, in a sentence: what failed, and what to do. */
const unreached = (from: SiteModelFrom, why: string): string => {
  if (from === 'app') return `the app could not read the model it carries (${why}): install the app again and try again`
  if (from === 'launcher') return `the launcher that opened this page could not be reached for its model (${why}): start the city again and try again`
  return `this site could not be reached for the model (${why}): check the connection and try again`
}

/**
 * The pinned model from this site (or, `from` 'app', from the app that carries it; 'launcher', from the launcher that
 * serves it beside the page), as a File named for it, once all
 * of it has arrived and its size and SHA-256 are the pin's. `onBytes(done, total)` is told as it arrives. The response
 * is not kept in the browser's HTTP cache (the page's model store keeps the one copy); it is counted and hashed as it
 * streams, and refused the moment it runs past the pin's size. Rejects with a plain sentence: the site did not send it
 * (its HTTP status), the download stopped short, what arrived is not the pinned model, or it arrived whole and checked
 * but the browser could not hold it. Aborting `signal` stops the download and rejects with its reason, up to the
 * moment the File is returned.
 */
export async function fetchSiteModel(siteFetch: SiteFetch, pin: SiteModelPin, onBytes: (done: number, total: number) => void, signal?: AbortSignal, from: SiteModelFrom = 'site'): Promise<File> {
  signal?.throwIfAborted()
  let res: Response
  try {
    res = await siteFetch(`${SITE_DIR}${pin.file}`, { cache: 'no-store', signal })
  } catch (e) {
    signal?.throwIfAborted()
    const why = e instanceof Error ? e.message : String(e)
    throw new Error(unreached(from, why))
  }
  if (!res.ok || !res.body) {
    void res.body?.cancel().catch(() => undefined)
    throw new Error(`${sender(from)} did not send the model (HTTP ${res.status}${res.status === 429 ? ', too many downloads for now' : ''}): try again later`)
  }
  const hash = sha256Stream()
  let got = 0
  // The check's own refusal, kept here: Chrome's blob() reports any error of the stream it reads as a bare "Failed to
  // fetch", so the sentence thrown inside the stream would not survive to the catch below.
  let refused: string | null = null
  // Every byte arrived and the size and hash are the pin's: a failure after that is the browser's, not the download's.
  let checked = false
  const refuse = (why: string): never => {
    refused = why
    throw new Error(why)
  }
  onBytes(0, pin.bytes)
  const check = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      got += chunk.byteLength
      if (got > pin.bytes) refuse(`what ${sender(from)} sent is larger than the model this page was built for (${pin.file}), so nothing was kept`)
      hash.update(chunk)
      onBytes(got, pin.bytes)
      ctl.enqueue(chunk)
    },
    flush() {
      if (got < pin.bytes) refuse(shortOf(got, pin, from))
      if (hex(hash.digest()) !== pin.sha256) refuse(`what ${sender(from)} sent is not the model this page was built for (its SHA-256 differs), so nothing was kept`)
      checked = true
    },
  })
  let blob: Blob
  try {
    blob = await new Response(res.body.pipeThrough(check, { signal })).blob()
  } catch (e) {
    signal?.throwIfAborted()
    // The size and hash refusals say their own; a body that broke off mid-way says so by the bytes that did arrive.
    if (refused !== null) throw new Error(refused)
    if (checked) throw new Error(`the model arrived whole and checked, but this browser could not hold it (${e instanceof Error ? e.message : String(e)}), so nothing was kept: close other tabs or free some storage, and try again`)
    throw new Error(shortOf(got, pin, from))
  }
  // A stop that came as the last bytes did, while the browser was still making them one file: nothing is handed on.
  signal?.throwIfAborted()
  return new File([blob], pin.file, { type: 'application/octet-stream' })
}

/**
 * What a download writes into: the part kept in the page's storage (modelStore.ts PartSession), as far as this file
 * needs it. `at` bytes are there to pick up under `validator` (0 and null: a fresh start); `begin` starts at 0 or
 * `at`; `put` takes the next bytes (they are the sink's from then on) and resolves when it can take more; `hold`
 * leaves what arrived to be picked up; `end` gives the size written and, when whole, the SHA-256 of the whole file;
 * `discard` deletes the part.
 */
export interface SiteSink {
  readonly at: number
  readonly validator: string | null
  begin(at: number, validator: string | null): void
  put(bytes: Uint8Array): Promise<void>
  hold(): Promise<number>
  end(): Promise<{ readonly bytes: number; readonly sha256: string | null }>
  discard(): Promise<void>
}

/** An answer's body is encoded (gzip, br, …): its bytes are not the file's, so no range of them can be picked up. */
const encoded = (h: Headers): boolean => {
  const e = h.get('content-encoding')
  return e !== null && e.trim() !== '' && e.trim().toLowerCase() !== 'identity'
}

/**
 * What a later request can send in If-Range to pick up this answer's file where it stopped: its strong ETag; else,
 * when it has no ETag, its Last-Modified; null when neither can (a weak ETag, W/…, which If-Range never matches; an
 * encoded body; Accept-Ranges: none; nothing given). Null means a part of it is never picked up.
 */
export function validatorOf(h: Headers): string | null {
  if (encoded(h) || h.get('accept-ranges')?.trim().toLowerCase() === 'none') return null
  const etag = h.get('etag')?.trim()
  if (etag !== undefined && etag !== '') return /^"[\x21\x23-\x7e]*"$/.test(etag) ? etag : null
  const modified = h.get('last-modified')?.trim()
  return modified !== undefined && modified !== '' && !Number.isNaN(Date.parse(modified)) ? modified : null
}

/** A Content-Range header's `bytes first-last/total`, or null for anything else (an unsatisfied range, junk). */
export function contentRange(text: string | null): { first: number; last: number; total: number } | null {
  const m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+)\s*$/i.exec(text ?? '')
  if (!m) return null
  const [first, last, total] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return Number.isSafeInteger(total) && first <= last && last < total ? { first, last, total } : null
}

/**
 * Whether `res`, the answer to a request for the rest of `pin` from `at` under `validator`, is that rest: a 206 whose
 * Content-Range runs from `at` to the last byte of the pin's size, whose body is not encoded, whose length (when
 * given) is the rest's, and whose ETag or Last-Modified (when given) is still `validator`.
 */
export function restFits(res: Response, at: number, pin: SiteModelPin, validator: string): boolean {
  if (res.status !== 206 || encoded(res.headers)) return false
  const r = contentRange(res.headers.get('content-range'))
  if (r === null || r.first !== at || r.last !== pin.bytes - 1 || r.total !== pin.bytes) return false
  const length = res.headers.get('content-length')
  if (length !== null && Number(length) !== pin.bytes - at) return false
  const said = validator.startsWith('"') ? res.headers.get('etag')?.trim() : res.headers.get('last-modified')?.trim()
  return said === undefined || said === validator
}

/**
 * The pinned model from this site (or the app, or the launcher: `from`) straight into `sink`, the part in the page's
 * storage (see the file's comment). A part that holds the whole file already is checked as it is, with no request.
 * `onBytes(done, total)` is told as bytes arrive; a download that goes on from a part counts from where it stopped.
 * Resolves once the whole file is in the sink and its size and SHA-256 are the pin's (the caller then keeps it).
 * Rejects with a plain sentence, the sink left as it should be: the site could not be reached or did not send the
 * model (the part kept as it was), the download stopped short (what arrived kept, to be picked up), what arrived is
 * not the pinned model (the part deleted), or the page's storage refused it (the sink says why). Aborting `signal`
 * stops it, keeps what arrived, and rejects with the signal's reason.
 */
export async function downloadSiteModel(siteFetch: SiteFetch, pin: SiteModelPin, sink: SiteSink, onBytes: (done: number, total: number) => void, signal?: AbortSignal, from: SiteModelFrom = 'site'): Promise<void> {
  /** What arrived is kept for the next try (as it is, when nothing has begun); a sink that fails here changes nothing. */
  const keep = (): Promise<number> => sink.hold().catch(() => -1)
  const notModel = async (): Promise<never> => {
    await sink.discard().catch(() => undefined)
    throw new Error(`what ${sender(from)} sent is not the model this page was built for (its SHA-256 differs), so nothing was kept`)
  }
  const ending = async (): Promise<void> => {
    const r = await sink.end()
    if (r.bytes !== pin.bytes) throw new Error(shortOf(r.bytes, pin, from))
    if (r.sha256 !== pin.sha256) await notModel()
  }
  try {
    signal?.throwIfAborted()
  } catch (e) {
    await keep()
    throw e
  }
  if (sink.at === pin.bytes) {
    onBytes(pin.bytes, pin.bytes)
    await ending()
    return
  }
  // Picked up only with a validator the server can match; anything else starts from the first byte.
  let start = sink.validator !== null && sink.at > 0 ? sink.at : 0
  let res: Response
  for (;;) {
    const init: RequestInit = start > 0 && sink.validator !== null
      ? { cache: 'no-store', signal, headers: { Range: `bytes=${start}-`, 'If-Range': sink.validator } }
      : { cache: 'no-store', signal }
    try {
      res = await siteFetch(`${SITE_DIR}${pin.file}`, init)
    } catch (e) {
      await keep()
      signal?.throwIfAborted()
      throw new Error(unreached(from, e instanceof Error ? e.message : String(e)))
    }
    if (start > 0 && sink.validator !== null && res.status === 206) {
      if (restFits(res, start, pin, sink.validator) && res.body) {
        sink.begin(start, sink.validator)
        break
      }
      // A range that does not fit the part: asked again from the first byte.
      void res.body?.cancel().catch(() => undefined)
      start = 0
      continue
    }
    if (start > 0 && res.status === 416) {
      // The server cannot send that range (the file is shorter now, or the part is wrong): from the first byte.
      void res.body?.cancel().catch(() => undefined)
      start = 0
      continue
    }
    if (!res.ok || !res.body) {
      void res.body?.cancel().catch(() => undefined)
      await keep()
      throw new Error(`${sender(from)} did not send the model (HTTP ${res.status}${res.status === 429 ? ', too many downloads for now' : ''}): try again later`)
    }
    // A whole answer (a 200: the server ignored Range, or the file changed since the part began): from the first byte.
    start = 0
    sink.begin(0, validatorOf(res.headers))
    break
  }
  const resumable = start > 0 || validatorOf(res.headers) !== null
  let got = start
  onBytes(got, pin.bytes)
  const reader = res.body!.getReader()
  for (;;) {
    let piece: ReadableStreamReadResult<Uint8Array>
    try {
      piece = await reader.read()
    } catch {
      // The connection broke off, or the stop: what arrived is written and noted, to be picked up.
      const kept = await keep()
      signal?.throwIfAborted()
      throw new Error(shortOf(kept >= 0 ? kept : got, pin, from, resumable && kept > 0))
    }
    if (piece.done) break
    const bytes = piece.value
    if (got + bytes.byteLength > pin.bytes) {
      void reader.cancel().catch(() => undefined)
      await sink.discard().catch(() => undefined)
      throw new Error(`what ${sender(from)} sent is larger than the model this page was built for (${pin.file}), so nothing was kept`)
    }
    got += bytes.byteLength
    try {
      await sink.put(bytes)
    } catch (e) {
      void reader.cancel().catch(() => undefined)
      signal?.throwIfAborted()
      throw e
    }
    onBytes(got, pin.bytes)
  }
  if (got < pin.bytes) {
    const kept = await keep()
    signal?.throwIfAborted()
    throw new Error(shortOf(kept >= 0 ? kept : got, pin, from, resumable && kept > 0))
  }
  await ending()
}

/** What Sloane's card is told about the site's model: its name, its size in plain words, and whether this browser keeps it already. */
export interface SiteModelLine {
  readonly title: string
  readonly size: string
  readonly kept: boolean
}

/** How far getting the site's model has come: downloading it from the site, then keeping it in the page's storage. */
export interface SiteModelProgress {
  readonly step: 'download' | 'keep'
  readonly done: number
  readonly total: number
}

/**
 * The page's handle on the site's model, for Sloane's card (App.tsx builds it over siteFetch, the model store and the
 * in-page mind). `offer` asks the served manifest once (null where this site serves no such model, or this browser
 * cannot run one); `job` gets it (siteJob.ts), started by the card's tap or by the page itself: its work checks the
 * device and the storage first, downloads and checks the model, keeps it as a picked file is kept and chooses it, and
 * resolves with what it did (or, when this browser keeps it already, only chooses it).
 */
export interface SiteModelHost {
  offer(): Promise<SiteModelLine | null>
  readonly job: SiteJob
  /** Where the model comes from, for the card's words: this site (the default) or the app that carries it. */
  readonly from?: SiteModelFrom
}
