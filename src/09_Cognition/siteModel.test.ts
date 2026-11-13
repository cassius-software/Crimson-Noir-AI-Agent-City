// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the site's model to what the page was built for: the pin equals the SHA256SUMS
 * line and the notice beside the model's licence (third_party/qwen2.5-0.5b-instruct/; the Windows app's, APP_MODEL,
 * equally its own, and the shell's file and size and the installer's config name the same file), the file's name is one the
 * in-page model accepts as a text model, siteUrl admits only a models/ file beside the page on its own origin, the
 * manifest offers only exactly the pin, and fetchSiteModel turns into a File only what arrived whole, with the pinned
 * size and SHA-256 (a short body, a long one, a wrong hash, an HTTP error and a stop each end with no File and a plain
 * sentence), counting as it goes. The fetch is a fake serving the tiny model (tools/browser/tinyGguf.mjs) under a pin
 * made from its bytes. What breaks if it is removed? A pin that drifted from its record, a fetch that strayed off the
 * page's folder, or a model kept before its hash was checked would pass in silence.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { APP_MODEL, LAUNCHER_WORD, SITE_DIR, SITE_MANIFEST, SITE_MODEL, fetchSiteModel, launcherServes, manifestText, parseManifest, siteUrl, type SiteFetch, type SiteModelPin } from './siteModel.ts'
import { APP_READ_BYTES } from '../07_Execute_Actions/desktopShell.ts'
import { localText } from './localCompute.ts'

// The tiny model is plain JavaScript (tools/ carries no types); a computed specifier keeps the page's typecheck off it.
const TINY: string = '../../tools/browser/tinyGguf.mjs'
const { tinyGguf } = (await import(TINY)) as { tinyGguf(o?: { letter?: string }): Uint8Array }

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8')
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

test('the pin is the record beside the licence: the SHA256SUMS line, the notice\'s size and hash, and a name the in-page model takes as text', () => {
  assert.equal(read('../../third_party/qwen2.5-0.5b-instruct/SHA256SUMS'), `${SITE_MODEL.sha256}  ${SITE_MODEL.file}\n`)
  const notice = read('../../third_party/qwen2.5-0.5b-instruct/NOTICE')
  assert.ok(notice.includes(`${SITE_MODEL.file}   ${SITE_MODEL.bytes} bytes, sha256 ${SITE_MODEL.sha256}`), 'the notice names the pinned file, size and hash')
  assert.ok(notice.includes(SITE_MODEL.revision) && notice.includes(SITE_MODEL.repo), 'the notice names the repository and revision')
  assert.match(read('../../third_party/qwen2.5-0.5b-instruct/LICENSE'), /Apache License\s+Version 2\.0, January 2004[\s\S]*Copyright 2024 Alibaba Cloud/)
  assert.match(SITE_MODEL.sha256, /^[0-9a-f]{64}$/)
  assert.ok(Number.isSafeInteger(SITE_MODEL.bytes) && SITE_MODEL.bytes > 0)
  assert.match(SITE_MODEL.file, /^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$/)
  assert.match(SITE_MODEL.revision, /^[0-9a-f]{40}$/)
  assert.ok(localText(SITE_MODEL.file), 'the in-page model takes the file as a text model, not an embedder')
  assert.ok(Object.isFrozen(SITE_MODEL))
  assert.equal(SITE_MANIFEST, `${SITE_DIR}manifest.json`)
})

test('the app\'s pin is its own record beside its licence, and the shell and the installer name the same file and size', () => {
  assert.equal(read('../../third_party/qwen2.5-1.5b-instruct/SHA256SUMS'), `${APP_MODEL.sha256}  ${APP_MODEL.file}\n`)
  const notice = read('../../third_party/qwen2.5-1.5b-instruct/NOTICE')
  assert.ok(notice.includes(`${APP_MODEL.file}   ${APP_MODEL.bytes} bytes, sha256 ${APP_MODEL.sha256}`), 'the notice names the pinned file, size and hash')
  assert.ok(notice.includes(APP_MODEL.revision) && notice.includes(APP_MODEL.repo), 'the notice names the repository and revision')
  assert.match(read('../../third_party/qwen2.5-1.5b-instruct/LICENSE'), /Apache License\s+Version 2\.0, January 2004[\s\S]*Copyright 2024 Alibaba Cloud/)
  assert.match(APP_MODEL.sha256, /^[0-9a-f]{64}$/)
  assert.ok(Number.isSafeInteger(APP_MODEL.bytes) && APP_MODEL.bytes > 0)
  assert.match(APP_MODEL.file, /^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$/)
  assert.match(APP_MODEL.revision, /^[0-9a-f]{40}$/)
  assert.ok(localText(APP_MODEL.file), 'the in-page model takes the file as a text model, not an embedder')
  assert.ok(Object.isFrozen(APP_MODEL))
  assert.notEqual(APP_MODEL.file, SITE_MODEL.file, 'two models, two names: a copy of one is never taken for the other')
  // The shell's reading half names the same file and size, and gives at most what the page asks for in one read.
  const rs = read('../../src-tauri/src/model_file.rs')
  assert.match(rs, new RegExp(`pub const FILE: &str = "${APP_MODEL.file.replace(/\./g, '\\.')}";`))
  assert.match(rs, new RegExp(`pub const BYTES: u64 = ${APP_MODEL.bytes.toLocaleString('en-US').replace(/,/g, '_')};`))
  assert.match(rs, /pub const MAX_READ: u64 = 4 \* 1024 \* 1024;/)
  assert.equal(APP_READ_BYTES, 4 * 1024 * 1024)
  // The installer's config bundles exactly that file, its licence and its notice under models/.
  const conf = JSON.parse(read('../../src-tauri/tauri.model.conf.json')) as { bundle: { resources: Record<string, string> } }
  assert.deepEqual(conf.bundle.resources, Object.fromEntries([APP_MODEL.file, 'LICENSE', 'NOTICE'].map((f) => [`models/${f}`, `models/${f}`])))
  assert.match(read('../../src-tauri/.gitignore'), /^models$/m, 'the model is never committed')
  // The NixOS package fetches the same file at the same revision, refuses other bytes, and writes the manifest the
  // page reads from its pin's own values.
  const nix = read('../../tools/nix/model.nix')
  assert.ok(nix.includes(`file = "${APP_MODEL.file}";`), 'model.nix names the file')
  assert.ok(nix.includes(`bytes = ${APP_MODEL.bytes};`), 'and its size')
  assert.ok(nix.includes(`sha256 = "${APP_MODEL.sha256}";`), 'and its SHA-256, which fetchurl holds the download to')
  assert.ok(nix.includes(`repo = "${APP_MODEL.repo}";`) && nix.includes(`revision = "${APP_MODEL.revision}";`), 'and where it comes from')
  assert.match(nix, /url = "https:\/\/huggingface\.co\/\$\{repo\}\/resolve\/\$\{revision\}\/\$\{file\}";\n\s*name = file;\n\s*inherit sha256;/, 'one address, the pinned revision, named for the file (CI puts it in the store by that name)')
  assert.match(nix, /manifest = builtins\.toJSON \{\n\s*v = 1;\n\s*inherit file bytes sha256;\n\s*\};/, 'the manifest parseManifest takes, from the same values')
  assert.match(nix, /ln -s \$\{gguf\} \$dir\/\$\{file\}/, 'linked from its fetch, so the store holds it once')
  for (const f of ['LICENSE', 'NOTICE']) assert.ok(nix.includes(`install -m444 \${../../third_party/qwen2.5-1.5b-instruct/${f}} $dir/${f}`), `its ${f} beside it`)
  assert.match(nix, /license = lib\.licenses\.asl20;/)
  assert.deepEqual(parseManifest(JSON.stringify({ bytes: APP_MODEL.bytes, file: APP_MODEL.file, sha256: APP_MODEL.sha256, v: 1 }), APP_MODEL), { file: APP_MODEL.file, bytes: APP_MODEL.bytes, sha256: APP_MODEL.sha256 }, 'builtins.toJSON sorts the keys; the page reads them in any order')
  assert.match(notice, /The NixOS package \(the flake's `nix run` and its NixOS module\) carries the same file: tools\/nix\/model\.nix/)
})

test('launcherServes: only a page on http://127.0.0.1 with models=1 in its address, the NixOS launcher\'s, is served the launcher\'s model', () => {
  assert.equal(LAUNCHER_WORD, 'models')
  for (const href of ['http://127.0.0.1:4180/?models=1', 'http://127.0.0.1:4180/?vram=8.0&models=1', 'http://127.0.0.1:5000/index.html?quality=4&models=1#x']) assert.equal(launcherServes(href), true, href)
  for (const href of [
    'http://127.0.0.1:4180/', // a launcher with no model folder adds nothing
    'http://127.0.0.1:4180/?models=0', // the command line said no
    'http://127.0.0.1:4180/?models=true',
    'http://localhost:4180/?models=1', // the launcher listens on 127.0.0.1 alone
    'http://[::1]:4180/?models=1',
    'https://127.0.0.1:4180/?models=1',
    'https://cassius-software.github.io/Crimson-Noir-AI-Agent-City/?models=1', // the web copy
    'http://tauri.localhost/?models=1', // the Windows app
    'file:///home/me/dist/index.html?models=1',
    'not an address',
  ]) assert.equal(launcherServes(href), false, href)
})

test('siteModel.ts names no address and fetches nothing itself: the fetch is handed in', () => {
  const code = read('./siteModel.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.doesNotMatch(code, /https?:\/\//)
  assert.doesNotMatch(code, /\bfetch\s*\(/)
})

test('siteUrl admits a models/ file beside the page on its own origin, and nothing else', () => {
  const base = 'https://owner.github.io/Crimson-Noir-AI-Agent-City/?players=2#x'
  assert.equal(siteUrl('models/manifest.json', base), 'https://owner.github.io/Crimson-Noir-AI-Agent-City/models/manifest.json')
  assert.equal(siteUrl(`models/${SITE_MODEL.file}`, base), `https://owner.github.io/Crimson-Noir-AI-Agent-City/models/${SITE_MODEL.file}`)
  assert.equal(siteUrl('models/LICENSE', 'https://owner.github.io/Crimson-Noir-AI-Agent-City/index.html'), 'https://owner.github.io/Crimson-Noir-AI-Agent-City/models/LICENSE')
  assert.equal(siteUrl('models/x.gguf', 'http://127.0.0.1:8000/'), 'http://127.0.0.1:8000/models/x.gguf')
  // The origin's root is another site on GitHub Pages; anything that climbs, names a host or a scheme is refused.
  for (const path of ['/models/x.gguf', 'models/../index.html', 'models/', 'models/a/b.gguf', '../models/x.gguf', 'https://evil.example/models/x.gguf', '//evil.example/models/x.gguf', 'models/..', 'models/.hidden', 'x.gguf', 'models/x y.gguf', 'models/x?.gguf', 'models\\x.gguf']) {
    assert.throws(() => siteUrl(path, base), /is not a file this site serves beside the page/, path)
  }
  for (const page of ['file:///C:/Users/me/Downloads/index.html', 'blob:https://owner.github.io/1234', 'data:text/html,hi', 'tauri://localhost/index.html']) {
    assert.throws(() => siteUrl('models/x.gguf', page), /not served by a web server/, page)
  }
  assert.throws(() => siteUrl('models/x.gguf', 'not a url'), /no address/)
})

test('the manifest offers the model only when it names exactly the pin', () => {
  assert.deepEqual(parseManifest(manifestText()), { file: SITE_MODEL.file, bytes: SITE_MODEL.bytes, sha256: SITE_MODEL.sha256 })
  assert.equal(manifestText(), `{"v":1,"file":"${SITE_MODEL.file}","bytes":${SITE_MODEL.bytes},"sha256":"${SITE_MODEL.sha256}"}\n`)
  const m = JSON.parse(manifestText()) as Record<string, unknown>
  for (const [k, v] of [['v', 2], ['file', 'other.gguf'], ['bytes', SITE_MODEL.bytes + 1], ['bytes', String(SITE_MODEL.bytes)], ['sha256', SITE_MODEL.sha256.toUpperCase()], ['sha256', '0'.repeat(64)]] as const) {
    assert.equal(parseManifest(JSON.stringify({ ...m, [k]: v })), null, `${k} = ${String(v)}`)
  }
  for (const text of ['', '<!doctype html><title>404</title>', 'null', '[]', '{"v":1}', '{']) assert.equal(parseManifest(text), null, text)
  const other: SiteModelPin = { ...SITE_MODEL, file: 'tiny-a.gguf', bytes: 10, sha256: 'a'.repeat(64) }
  assert.equal(parseManifest(manifestText(), other), null, 'a manifest for another pin is no offer')
  assert.ok(parseManifest(manifestText(other), other))
})

/** A pin for the tiny model, and a fake site serving `body` (the model's bytes by default) in `pieces` pieces. */
function site(opts: { body?: Uint8Array; status?: number; pieces?: number; breakAt?: number } = {}) {
  const model = tinyGguf({ letter: 'a' })
  const pin: SiteModelPin = { ...SITE_MODEL, file: 'tiny-a.gguf', bytes: model.length, sha256: sha(model) }
  const body = opts.body ?? model
  const asked: { path: string; init: RequestInit }[] = []
  const fetchFn: SiteFetch = async (path, init) => {
    asked.push({ path, init })
    if ((opts.status ?? 200) !== 200) return new Response('<!doctype html>not here', { status: opts.status })
    const pieces = opts.pieces ?? 7
    const size = Math.ceil(body.length / pieces)
    let at = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (opts.breakAt !== undefined && at >= opts.breakAt) { ctl.error(new TypeError('network error')); return }
        if (at >= body.length) { ctl.close(); return }
        ctl.enqueue(body.slice(at, at + size))
        at += size
      },
    })
    return new Response(stream, { status: 200 })
  }
  return { model, pin, fetchFn, asked }
}

test('fetchSiteModel: the whole model, its size and hash the pin\'s, becomes a File named for it; progress counts up to the size; nothing is kept in the HTTP cache', async () => {
  const s = site()
  const seen: [number, number][] = []
  const file = await fetchSiteModel(s.fetchFn, s.pin, (done, total) => seen.push([done, total]))
  assert.ok(file instanceof File)
  assert.equal(file.name, 'tiny-a.gguf')
  assert.equal(file.size, s.model.length)
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), s.model)
  assert.deepEqual(s.asked.map((a) => a.path), ['models/tiny-a.gguf'])
  assert.equal(s.asked[0].init.cache, 'no-store')
  assert.deepEqual(seen[0], [0, s.model.length])
  assert.deepEqual(seen.at(-1), [s.model.length, s.model.length])
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i][0] >= seen[i - 1][0], 'progress never goes back')
  assert.ok(seen.length > 3, 'told as it arrives')
})

test('fetchSiteModel refuses what is not the pinned model, with no File: a flipped byte, a short body, a long one, a broken connection, an HTTP error', async () => {
  const flipped = site()
  const bad = flipped.model.slice()
  bad[bad.length - 1] ^= 1
  const f1 = site({ body: bad })
  await assert.rejects(fetchSiteModel(f1.fetchFn, flipped.pin, () => {}), /not the model this page was built for \(its SHA-256 differs\), so nothing was kept/)
  const short = site()
  await assert.rejects(fetchSiteModel(site({ body: short.model.slice(0, short.model.length - 100) }).fetchFn, short.pin, () => {}), /the download stopped at [\d,]+ of [\d,]+ bytes: try again/)
  const long = site()
  const more = new Uint8Array(long.model.length + 1)
  more.set(long.model)
  let last = 0
  await assert.rejects(fetchSiteModel(site({ body: more, pieces: 3 }).fetchFn, long.pin, (d) => { last = d }), /larger than the model this page was built for/)
  assert.ok(last <= long.pin.bytes, 'nothing past the pin\'s size is counted')
  const broken = site({ breakAt: 1 })
  await assert.rejects(fetchSiteModel(broken.fetchFn, broken.pin, () => {}), /the download stopped at [\d,]+ of [\d,]+ (?:MB|bytes): try again/)
  for (const status of [404, 429, 500]) {
    const s = site({ status })
    await assert.rejects(fetchSiteModel(s.fetchFn, s.pin, () => {}), new RegExp(`this site did not send the model \\(HTTP ${status}${status === 429 ? ', too many downloads for now' : ''}\\): try again later`))
  }
  const away: SiteFetch = async () => { throw new TypeError('Failed to fetch') }
  await assert.rejects(fetchSiteModel(away, site().pin, () => {}), /this site could not be reached for the model \(Failed to fetch\)/)
})

test('fetchSiteModel from the app: the same checks, in the app\'s words (copied from the app, never "this site" or "download")', async () => {
  const s = site()
  const file = await fetchSiteModel(s.fetchFn, s.pin, () => {}, undefined, 'app')
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), s.model)
  const bad = s.model.slice()
  bad[0] ^= 1
  await assert.rejects(fetchSiteModel(site({ body: bad }).fetchFn, s.pin, () => {}, undefined, 'app'), /^Error: what the app sent is not the model this page was built for \(its SHA-256 differs\), so nothing was kept$/)
  await assert.rejects(fetchSiteModel(site({ body: s.model.slice(0, 100) }).fetchFn, s.pin, () => {}, undefined, 'app'), /^Error: the copy from the app stopped at [\d,]+ of [\d,]+ bytes: try again$/)
  const more = new Uint8Array(s.model.length + 1)
  more.set(s.model)
  await assert.rejects(fetchSiteModel(site({ body: more }).fetchFn, s.pin, () => {}, undefined, 'app'), /^Error: what the app sent is larger than the model/)
  const unread: SiteFetch = async () => { throw new Error('the app\'s model is not beside the app (os error 2)') }
  await assert.rejects(fetchSiteModel(unread, s.pin, () => {}, undefined, 'app'), /^Error: the app could not read the model it carries \(the app's model is not beside the app \(os error 2\)\): install the app again and try again$/)
})

test('fetchSiteModel from the launcher: the same checks, in the launcher\'s words (copied from the launcher, never "this site", "download" or "the app")', async () => {
  const s = site()
  const file = await fetchSiteModel(s.fetchFn, s.pin, () => {}, undefined, 'launcher')
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), s.model)
  const bad = s.model.slice()
  bad[0] ^= 1
  await assert.rejects(fetchSiteModel(site({ body: bad }).fetchFn, s.pin, () => {}, undefined, 'launcher'), /^Error: what the launcher sent is not the model this page was built for \(its SHA-256 differs\), so nothing was kept$/)
  await assert.rejects(fetchSiteModel(site({ body: s.model.slice(0, 100) }).fetchFn, s.pin, () => {}, undefined, 'launcher'), /^Error: the copy from the launcher stopped at [\d,]+ of [\d,]+ bytes: try again$/)
  const more = new Uint8Array(s.model.length + 1)
  more.set(s.model)
  await assert.rejects(fetchSiteModel(site({ body: more }).fetchFn, s.pin, () => {}, undefined, 'launcher'), /^Error: what the launcher sent is larger than the model/)
  await assert.rejects(fetchSiteModel(site({ status: 404 }).fetchFn, s.pin, () => {}, undefined, 'launcher'), /^Error: the launcher did not send the model \(HTTP 404\)/)
  const away: SiteFetch = async () => { throw new TypeError('Failed to fetch') }
  await assert.rejects(fetchSiteModel(away, s.pin, () => {}, undefined, 'launcher'), /^Error: the launcher that opened this page could not be reached for its model \(Failed to fetch\): start the city again and try again$/)
})

test('fetchSiteModel stops when asked: before it starts, and mid-download, with the stop\'s own reason', async () => {
  const s = site({ pieces: 50 })
  const early = new AbortController()
  early.abort(new Error('stopped'))
  await assert.rejects(fetchSiteModel(s.fetchFn, s.pin, () => {}, early.signal), /stopped/)
  assert.equal(s.asked.length, 0, 'nothing is asked of the site after a stop')
  const mid = new AbortController()
  await assert.rejects(fetchSiteModel(s.fetchFn, s.pin, (done) => { if (done > 0) mid.abort(new Error('the visitor stopped it')) }, mid.signal), /the visitor stopped it/)
})

test('the refusal survives a browser whose blob() reports any stream error as a bare "Failed to fetch" (Chrome does)', async () => {
  const real = Response.prototype.blob
  Response.prototype.blob = async function (this: Response) {
    try {
      return await real.call(this)
    } catch {
      throw new TypeError('Failed to fetch')
    }
  }
  try {
    const good = site()
    const bad = good.model.slice()
    bad[10] ^= 1
    await assert.rejects(fetchSiteModel(site({ body: bad }).fetchFn, good.pin, () => {}), /its SHA-256 differs\), so nothing was kept/)
    const more = new Uint8Array(good.model.length + 1)
    more.set(good.model)
    await assert.rejects(fetchSiteModel(site({ body: more }).fetchFn, good.pin, () => {}), /larger than the model this page was built for/)
    const broken = site({ breakAt: 1 })
    await assert.rejects(fetchSiteModel(broken.fetchFn, broken.pin, () => {}), /the download stopped at [\d,]+ of [\d,]+ (?:MB|bytes): try again/)
    assert.ok(await fetchSiteModel(good.fetchFn, good.pin, () => {}), 'and the right file still arrives')
  } finally {
    Response.prototype.blob = real
  }
})

test('a download that ended short reads in megabytes while they differ, and in bytes inside the last one (never "N of N MB")', async () => {
  const MIB = 1024 * 1024
  const pinOf = (bytes: number): SiteModelPin => ({ ...site().pin, bytes })
  const cut = (got: number): SiteFetch => async () => new Response(new Uint8Array(got))
  await assert.rejects(fetchSiteModel(cut(2 * MIB + 5), pinOf(379 * MIB + 400_000), () => {}), /the download stopped at 2 of 379 MB: try again/)
  await assert.rejects(fetchSiteModel(cut(379 * MIB + 1), pinOf(379 * MIB + 400_000), () => {}), /the download stopped at 397,410,305 of 397,810,304 bytes: try again/)
})

test('a body that arrived whole and checked, which the browser then could not hold, says so (not "the download stopped")', async () => {
  const real = Response.prototype.blob
  Response.prototype.blob = async function (this: Response) {
    await real.call(this)
    throw new DOMException('The requested file could not be read', 'NotReadableError')
  }
  try {
    const s = site()
    await assert.rejects(fetchSiteModel(s.fetchFn, s.pin, () => {}), /the model arrived whole and checked, but this browser could not hold it \(The requested file could not be read\), so nothing was kept/)
  } finally {
    Response.prototype.blob = real
  }
})

test('a stop that comes after the last byte, while the browser still makes the file, hands nothing on', async () => {
  const real = Response.prototype.blob
  const late = new AbortController()
  Response.prototype.blob = async function (this: Response) {
    const b = await real.call(this)
    late.abort(new Error('stopped at the very end'))
    return b
  }
  try {
    const s = site()
    await assert.rejects(fetchSiteModel(s.fetchFn, s.pin, () => {}, late.signal), /stopped at the very end/)
  } finally {
    Response.prototype.blob = real
  }
})
