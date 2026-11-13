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
 * (fetchSiteModel, one job at a time: siteJob.ts): from the page's own origin and its own folder (siteUrl: a
 * models/ path relative to the page, never the origin's root, which on GitHub Pages is another site), counted and
 * hashed piece by piece as it arrives (integrity.ts sha256Stream), refused the moment it runs long, and turned into a
 * File only once every byte has passed. That File is then kept exactly as a picked file is (App.tsx keepPicked).
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
 * installer carries beside the app (src-tauri/tauri.model.conf.json, src-tauri/src/model.rs), which the page copies
 * into its own storage once the city is on screen, as the web copy gets SITE_MODEL. About 0.9 GB: a desktop's in-page
 * limits take it (inPagePlan.ts), and it answers better than the 0.5B. Its byte count and hash equal the SHA256SUMS
 * line beside its notice, and src-tauri/src/model_file.rs names the same file and size (siteModel.test.ts).
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
 * app that carries it beside itself (APP_MODEL, read through the shell: desktopShell.ts shellModelFetch). The words a
 * visitor reads follow it; the checks are the same.
 */
export type SiteModelFrom = 'site' | 'app'

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

/** A path inside the served folder: models/ and one plain file name, nothing that climbs out or names a host. */
const SITE_PATH = /^models\/[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * The address of `path` (a file under models/) beside the page at `base`, on the page's own origin over http(s); throws
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
const shortOf = (got: number, pin: SiteModelPin, from: SiteModelFrom = 'site'): string => {
  const mb = (n: number): number => Math.floor(n / MIB)
  const at = mb(got) < mb(pin.bytes) ? `${mb(got)} of ${mb(pin.bytes)} MB` : `${got.toLocaleString('en-US')} of ${pin.bytes.toLocaleString('en-US')} bytes`
  return `${from === 'app' ? 'the copy from the app' : 'the download'} stopped at ${at}: try again`
}

/** Who sent the model, in a sentence. */
const sender = (from: SiteModelFrom): string => (from === 'app' ? 'the app' : 'this site')

/**
 * The pinned model from this site (or, `from` 'app', from the app that carries it), as a File named for it, once all
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
    throw new Error(from === 'app' ? `the app could not read the model it carries (${why}): install the app again and try again` : `this site could not be reached for the model (${why}): check the connection and try again`)
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
