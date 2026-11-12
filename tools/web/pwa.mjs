#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It turns the single-file build (dist/index.html) into a web app a phone can install, in
 * dist-web/. An iPhone's Safari gives a page WebGPU only in a secure context (https, or the phone's own localhost), and
 * keeps a page on the home screen, full screen and playable with no network, only when the page names a manifest and a
 * service worker keeps a copy of it. The folder holds the same page with a few lines added to its head (the manifest,
 * the home-screen icon and title, the service worker's registration, and `manifest-src 'self'` in its content policy,
 * which otherwise refuses the manifest), the manifest, the service worker, the icons, build.txt (the published build's
 * name, which the worker asks the host for) and an empty .nojekyll (GitHub Pages would otherwise run Jekyll over the
 * folder). Any static https host can serve it; the web workflow
 * (.github/workflows/web.yml) publishes it on GitHub Pages each time ci passes on main, or when someone runs it.
 * The service worker (worker() below) keeps a copy of these files after the first visit, so the city then starts with
 * no network at all; it keeps one cache per build, named by the build's hash, and drops the others once a new build
 * has been cached. The host decides which build a phone runs and the copy delivers it: on a page load the worker asks
 * the host one small file (build.txt, the published build's name) and answers from its copy when the name is its
 * own, or when the host does not say in time; when the host names another build, the page comes from the host, so a
 * newly published build is what the next launch runs once the host serves its name, without waiting for the new copy
 * to be kept first (it is kept in the background, by the new build's own worker, which waits for the launch's own
 * download to be over so that the two do not share the link). A page from the host that stops or crawls is given up,
 * and the launch starts from the copy instead. It also adds the two cross-origin isolation headers a
 * static host does not send to the page it serves, so from the second visit on the physics bridge shares memory
 * with its worker as it does under `npm run preview` (without them the bridge copies, and nothing else changes).
 * Usage: node tools/web/pwa.mjs [--from dist] [--out dist-web]. Needs `npm run build` first (`npm run build:web` does
 * both).
 * What breaks if it is removed? dist/index.html still plays from a disk or a localhost server; a phone loses its way to
 * install the city and play it offline.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The product's name (decided 2026-10-16), and the few letters a phone shows under the home-screen icon: BRAND.name
 *  and BRAND.short in src/brand.ts (src/webApp.test.ts keeps them equal). */
export const APP_NAME = 'Crimson Noir: Agent City'
export const SHORT_NAME = 'Crimson Noir'

/** The icons, from the Windows app's set (src-tauri/icons): published name, source, square size in pixels. */
export const ICONS = Object.freeze([
  { name: 'icon-512.png', from: 'src-tauri/icons/icon.png', size: 512 },
  { name: 'icon-256.png', from: 'src-tauri/icons/128x128@2x.png', size: 256 },
  // An iPhone reads the home-screen icon from here, not from the manifest, and scales it itself.
  { name: 'apple-touch-icon.png', from: 'src-tauri/icons/icon.png', size: 512 },
])

/** Every file the service worker caches on install: the page, the manifest and the icons (a page load anywhere in the folder gets index.html). */
export const CACHED = Object.freeze(['index.html', 'manifest.webmanifest', ...ICONS.map((i) => i.name)])

/**
 * The file that names the published build: the offline cache's name and a newline, some forty bytes. The worker asks
 * the host for it on every page load, past the browser's own cache, and never keeps it (it is not in CACHED): it is
 * the host's word for what is published now (a host's own delivery network may go on serving the word before for a
 * while after a publish: GitHub Pages lets its answers be kept ten minutes).
 */
export const PROBE = 'build.txt'

/** The manifest: the name, full screen in any orientation (the touch controls have a portrait layout), black. */
export function manifest() {
  return {
    name: APP_NAME,
    short_name: SHORT_NAME,
    id: './',
    start_url: './',
    scope: './',
    display: 'fullscreen',
    orientation: 'any',
    background_color: '#000000',
    theme_color: '#000000',
    icons: ICONS.filter((i) => i.name !== 'apple-touch-icon.png').map((i) => ({ src: i.name, sizes: `${i.size}x${i.size}`, type: 'image/png', purpose: 'any' })),
  }
}

/**
 * The lines added to the page's head, right after its theme colour. The registration runs only over http(s) in a
 * secure context, and waits for the page's load event: on a first visit the worker it starts downloads the page a
 * second time to keep it, and beside a page still arriving it would take half the link from it. (On a later visit the
 * line starts nothing: the worker is registered already, and it is the browser that looks for a newer one, by itself,
 * during the launch. What keeps that one's download off the launch's link is in the worker: PAGE_LOCK.)
 */
export const HEAD = [
  '<link rel="manifest" href="manifest.webmanifest" />',
  '<link rel="apple-touch-icon" href="apple-touch-icon.png" />',
  '<meta name="apple-mobile-web-app-capable" content="yes" />',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
  `<meta name="apple-mobile-web-app-title" content="${SHORT_NAME}" />`,
  "<script>if (window.isSecureContext && /^https?:$/.test(location.protocol) && 'serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch((e) => console.warn('[web] no offline copy: ' + e)))</script>",
].join('\n    ')

/**
 * The name of the meta that says which published build a page is (the twelve hex digits that also name its offline
 * cache). The recovery card prints it (src/07_Execute_Actions/bootFailure.ts BUILD_META, kept equal by a test): a
 * phone's offline copy can be a build behind the host, and a screenshot of a card should say which it was.
 */
export const BUILD_META = 'agent-city-build'

const ANCHOR = /(<meta name="theme-color" content="[^"]*" \/>)/
const POLICY = /(<meta http-equiv="Content-Security-Policy" content=")([^"]+)(")/

/**
 * The page with the head lines and `manifest-src 'self'`, and with `build` (the build word, buildWord: twelve hex
 * digits) its build meta first among them. A page without exactly one theme colour and one content policy, one that already
 * names a manifest source, or one that already carries a build meta, is not the page this was written for: it fails
 * rather than publishing a page whose policy refuses its own manifest or that names two builds.
 */
export function webPage(html, build = '') {
  if ((html.match(new RegExp(ANCHOR, 'g')) ?? []).length !== 1) throw new Error('dist/index.html: expected one theme-color meta to anchor the head lines')
  if ((html.match(new RegExp(POLICY, 'g')) ?? []).length !== 1) throw new Error('dist/index.html: expected one Content-Security-Policy meta')
  if (build && !/^[0-9a-f]{12}$/.test(build)) throw new Error(`the build word must be twelve hex digits, got "${build}"`)
  if (html.includes(`<meta name="${BUILD_META}"`)) throw new Error('dist/index.html: the page already carries a build meta')
  const head = build ? `<meta name="${BUILD_META}" content="${build}" />\n    ${HEAD}` : HEAD
  return html
    .replace(POLICY, (_m, open, policy, close) => {
      if (/(^|;)\s*manifest-src\b/.test(policy)) throw new Error('dist/index.html: the policy already names manifest-src')
      return `${open}${policy.replace(/;?\s*$/, '')}; manifest-src 'self'${close}`
    })
    .replace(ANCHOR, (m) => `${m}\n    ${head}`)
}

/**
 * How long the worker waits for the host to name its build, ms, and, where it holds a copy, for the host's page to
 * begin (its headers; what a body that has begun must keep to is below). Past either, the copy answers: a launch on a
 * link that slow is better served by what the phone already holds than by twelve megabytes over it.
 */
export const PROBE_MS = 2000
export const HEADERS_MS = 4000

/**
 * What the host's page must keep to once it has begun, where the phone holds a copy to start from instead: never more
 * than STALL_MS without a byte (counted on a one-second beat, so a silence is given up between STALL_MS and a second
 * more), and from PACE_AFTER_MS on at least PACE bytes a second since it began (the page as the worker reads it,
 * decoded: about twelve megabytes, so twenty seconds at the slowest pace kept). A page that falls behind is given up,
 * and for GIVEN_UP_MS the worker asks the host for nothing (its own memory, gone when the browser stops it, which a
 * browser does once the worker has had nothing to answer for a while: about thirty seconds in Chrome).
 *
 * HOLD is how much of the host's page the worker holds back until it has all arrived: the page's opening, which
 * carries its boot watchdog (index.html; build() refuses a page whose watchdog ends later). A page given up inside
 * it has handed nothing on, and the copy's body takes that answer over: the launch starts the build before with no
 * second load. A page given up after it ends where it stopped, cleanly, and its watchdog, at load, finds that the
 * page's script never ran under a worker and loads the page again, once: the copy answers that. With no copy there is
 * nothing to fall back on, and the page is left to arrive.
 *
 * HOLD may be lowered, never raised: the worker that holds a newly published page back is the one a phone already
 * has, an older build's, with the HOLD of its day in its text. A page whose watchdog ends past an older worker's
 * HOLD could be handed on with half a watchdog and end as a splash with nothing to press. A build this refuses is
 * mended by a smaller head, not a larger number (src/webApp.test.ts holds the number).
 */
export const STALL_MS = 5000
export const PACE_AFTER_MS = 4000
export const PACE = 600_000
export const GIVEN_UP_MS = 300_000
export const HOLD = 32_768

/**
 * A launch's page download before a newer build's, by name (a Web Lock, shared by every worker and page of the
 * origin): a launch's page from the host holds it until that body is over, and a newer build's install waits for it,
 * LINK_MS at most, before it downloads anything for itself. A browser starts that install by itself during the very
 * launch that found the new build (Safari a second after the page's answer begins; Chrome only once the launch's work
 * is over), and the two downloads side by side would halve what the pace rule sees of the link. It holds one way
 * only: an install that has begun, or has only begun to wait, holds nothing against a launch that starts meanwhile,
 * which downloads beside it. Where a browser has no such locks, or refuses one, both simply go on.
 *
 * LINK_MS is a backstop, not a wait any launch needs: the pace rule ends the largest page the builder may publish
 * (tools/verify/page_dist.mjs MAX_BYTES) within twenty-five seconds, given up or whole, so only something else
 * holding the name could keep an install the full time. It is half a minute and not more because Firefox gives an
 * install event one minute in all, this wait included: an install kept waiting that whole minute would be stopped
 * by the browser at the moment it was let go on (src/webApp.test.ts holds both numbers together).
 */
export const PAGE_LOCK = 'agent-city-page-download'
export const LINK_MS = 30_000

/**
 * The service worker. `cache` names this build (`agent-city-<version>-<build>`), so a new build installs beside the old
 * one and, once every file of it is cached, takes over and drops the old cache. Install asks the host for every file
 * past the browser's HTTP cache and keeps the page only when it carries this build's meta (`build`: a host still
 * serving the page before, as a deploy's first moments can, fails the install, and the browser tries again at the
 * next page load). A page load (any query string: ?players=2, ?kernel=lite) asks the host for build.txt, with a
 * deadline: the same name, no answer in time, or anything else the host says, and the cached page answers; another
 * build's name, and the page is streamed from the host's one fixed address (the worker never asks for the address
 * that was opened: every query string would be a download of its own), the copy again where the host does not begin
 * a page in time. A page that has begun is watched while it arrives (pumped): one that stops, breaks or comes too
 * slowly to be worth the wait is given up, and the launch starts from the copy (at once where nothing of the host's
 * page was handed on yet, else by the page loading itself again, once); nothing that keeps its pace is ever cut.
 * Both come back as a new response with the isolation headers. The fetch handler never writes
 * a cache: each cache holds one build, its own worker's. Other requests for this origin's files come from the cache
 * first (the network only for one the cache lacks).
 */
export function worker(cache, build) {
  if (!/^[0-9a-f]{12}$/.test(build ?? '')) throw new Error(`the build word must be twelve hex digits, got "${build}"`)
  return `// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// The offline copy of Crimson Noir: Agent City, written by tools/web/pwa.mjs (see there). Generated: edit that file.
const CACHE = ${JSON.stringify(cache)}
const BUILD = ${JSON.stringify(build)}
const FILES = ${JSON.stringify(CACHED)}
const ISOLATION = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }
// The two addresses a page load may ask the host for: fixed, built from the worker's own, and without a query.
const PAGE = new URL('index.html', self.location).href
const PROBE = new URL(${JSON.stringify(PROBE)}, self.location).href
const PROBE_MS = ${PROBE_MS}
const HEADERS_MS = ${HEADERS_MS}
const STALL_MS = ${STALL_MS}
const PACE_AFTER_MS = ${PACE_AFTER_MS}
const PACE = ${PACE}
const GIVEN_UP_MS = ${GIVEN_UP_MS}
const HOLD = ${HOLD}
const PAGE_LOCK = ${JSON.stringify(PAGE_LOCK)}
const LINK_MS = ${LINK_MS}
const MARK = '<meta name="${BUILD_META}" content="' + BUILD + '"'
// Whether the host's page was given up a moment ago (pumped). The worker's own memory, gone when the browser stops
// it: while it holds, a page load answers from the copy and asks the host for nothing.
let givenUp = false
let forget = 0

/** The first characters of a response as text (the build meta sits in the page's first kilobytes). */
async function opening(res) {
  const reader = res.body.getReader(), utf8 = new TextDecoder()
  let text = ''
  try {
    while (text.length < 4096) {
      const { done, value } = await reader.read()
      if (done) break
      text += utf8.decode(value, { stream: true })
    }
  } finally { reader.cancel().catch(() => {}) }
  return text
}

/** One of this build's files from the host, past the HTTP cache (a page it kept from the build before must not be
 *  filed under this build's name): a 200, or the install fails. */
async function fromHost(name) {
  const res = await fetch(new URL(name, self.location).href, { cache: 'no-cache' })
  if (res.status !== 200) {
    if (res.body) res.body.cancel().catch(() => {})
    throw new Error(name + ': HTTP ' + res.status)
  }
  return res
}

/** The browser's named locks, where it has them (PAGE_LOCK). */
function locks() {
  return (self.navigator && self.navigator.locks) || null
}

/** Holds the page-download lock until over settles: a launch's page is coming from the host. Never throws. */
function holding(over) {
  try {
    const all = locks()
    if (all) Promise.resolve(all.request(PAGE_LOCK, () => over)).catch(() => {})
  } catch { /* no lock to be had: a newer build's install may download beside this page */ }
}

/** Resolves once every launch that asked for the lock before this install has had its page (a launch that asks
 *  later downloads beside the install), or after LINK_MS, or at once where the browser has no locks or refuses one.
 *  Never rejects. */
async function linkFree() {
  const stop = new AbortController()
  const timer = setTimeout(() => stop.abort(), LINK_MS)
  try {
    const all = locks()
    if (all) await all.request(PAGE_LOCK, { signal: stop.signal }, () => {})
  } catch { /* refused, or not free in time: the install goes on */ } finally {
    clearTimeout(timer)
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // A launch may be downloading this very page through the worker before (pumped): its link first.
    await linkFree()
    // The small files first, each read whole as it arrives: a browser lets a worker hold only a few answers whose
    // bodies nobody is reading (three, in a page that is not in front), and waiting on all the headers before
    // reading any body would wait for ever.
    const small = await Promise.all(FILES.filter((name) => name !== 'index.html').map(async (name) => {
      const res = await fromHost(name)
      return { name, body: await res.arrayBuffer(), init: { status: 200, statusText: res.statusText, headers: res.headers } }
    }))
    // The page: kept only when it is this build's. Its opening is read from a copy; the page itself streams into the cache.
    const page = await fromHost('index.html')
    if (!(await opening(page.clone())).includes(MARK)) {
      page.body.cancel().catch(() => {})
      throw new Error('the host does not serve build ' + BUILD + ' yet')
    }
    const c = await caches.open(CACHE)
    await c.put('index.html', page)
    for (const f of small) await c.put(f.name, new Response(f.body, f.init))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('agent-city-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()))
})

/** The page as a new response with the isolation headers a static host does not send. The body arrives decoded, so the
 *  host's words for its encoding and length are left out. */
function isolated(res, body = res.body) {
  const headers = new Headers(res.headers)
  headers.delete('Content-Encoding')
  headers.delete('Content-Length')
  for (const [k, v] of Object.entries(ISOLATION)) headers.set(k, v)
  return new Response(body, { status: res.status, statusText: res.statusText, headers })
}

/**
 * One request to the host with a deadline on what read() waits for (none where ms is 0); null for no answer in time,
 * a refusal or a failure. The timer is cleared the moment read() returns, so only an unanswered request is ever
 * aborted: an abort after the headers would cut the body off.
 */
async function ask(url, cache, ms, read) {
  const stop = new AbortController()
  const timer = ms ? setTimeout(() => stop.abort(), ms) : 0
  try {
    return await read(await fetch(url, { cache, signal: stop.signal }))
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** The build the host publishes now (a cache's name), or null where it does not say in time. */
function published() {
  if (self.navigator && self.navigator.onLine === false) return Promise.resolve(null)
  return ask(PROBE, 'no-store', PROBE_MS, async (res) => {
    if (res.status !== 200) {
      if (res.body) res.body.cancel().catch(() => {})
      return null
    }
    const word = (await res.text()).trim()
    return word.length < 128 && word.startsWith('agent-city-') ? word : null
  })
}

/** The host's page once its answer has begun, within ms (0: however long it takes): a 200 of this origin that is
 *  HTML; null for anything else. */
function hosted(ms) {
  return ask(PAGE, 'no-cache', ms, (res) => {
    const html = (res.headers.get('Content-Type') || '').toLowerCase().startsWith('text/html')
    if (res.status === 200 && res.type === 'basic' && html && res.body) return res
    if (res.body) res.body.cancel().catch(() => {})
    return null
  })
}

/**
 * The host's page handed on for as long as it keeps coming at a pace worth the wait (STALL_MS, PACE_AFTER_MS, PACE:
 * counted on a one-second beat, and on the bytes as they arrive here, whatever the page being loaded has read of
 * them). Its first HOLD bytes are held back until they have all arrived: they carry the page's watchdog. Given up
 * where it stops, breaks or falls behind, the worker remembers it for GIVEN_UP_MS, and
 * - with nothing handed on yet, the copy's body (kept) takes this answer over: the launch starts the build before
 *   with no second load;
 * - else this body ends cleanly where it stopped. An ended page still reaches its load event, where an errored or
 *   an open one never would, and there its watchdog, finding that the page's script never ran under a worker, loads
 *   the page again, once (index.html): the copy answers that (page).
 * What it returns as done settles when the body is over, either way.
 */
function pumped(res, kept) {
  const reader = res.body.getReader()
  let out = null
  let held = []
  let taking = null
  let finish = () => {}
  let got = 0, quiet = 0, seconds = 0, tick = 0, over = false
  const done = new Promise((settled) => { finish = settled })
  const end = () => { over = true; clearTimeout(tick); finish() }
  const close = () => { try { out.close() } catch { /* the page has gone: nobody is reading */ } }
  // The copy's body into this answer, whole, then its end.
  const copy = async () => {
    taking = kept.body.getReader()
    try {
      for (;;) {
        const step = await taking.read()
        if (step.done) break
        out.enqueue(step.value)
      }
    } catch { /* the storage broke off, or the page has gone: the body ends where it is */ }
    close()
    finish()
  }
  const giveUp = () => {
    if (over) return
    over = true
    clearTimeout(tick)
    givenUp = true
    clearTimeout(forget)
    forget = setTimeout(() => { givenUp = false }, GIVEN_UP_MS)
    reader.cancel().catch(() => {})
    if (held) {
      held = null
      copy()
      return
    }
    close()
    finish()
  }
  const beat = () => {
    seconds++
    quiet++
    if (quiet * 1000 > STALL_MS || (seconds * 1000 >= PACE_AFTER_MS && got < PACE * seconds)) giveUp()
    else tick = setTimeout(beat, 1000)
  }
  // What was held back, handed on in the order it came.
  const release = () => {
    for (const piece of held) out.enqueue(piece)
    held = null
  }
  const body = new ReadableStream({
    start(controller) {
      out = controller
      tick = setTimeout(beat, 1000)
      ;(async () => {
        for (;;) {
          let step
          try { step = await reader.read() } catch { giveUp(); return }
          if (over) return
          if (step.done) {
            if (held) release()
            end()
            controller.close()
            return
          }
          got += step.value.byteLength
          quiet = 0
          if (!held) controller.enqueue(step.value)
          else {
            held.push(step.value)
            if (got >= HOLD) release()
          }
        }
      })()
    },
    cancel(why) {
      if (taking) { taking.cancel(why).catch(() => {}); return }
      if (over) return
      end()
      reader.cancel(why).catch(() => {})
    },
  })
  return { body, done }
}

/**
 * A page load's answer: the host's page when the host names another build than the copy's, else the copy. With a
 * copy to fall back on, the host's page must begin by its deadline and is watched as it arrives (pumped), and for a
 * while after one was given up the host is not asked at all. With no copy the host's page is all there is: it is
 * waited for and left to arrive, isolated like any other.
 */
async function page(event) {
  try {
    const kept = await (await caches.open(CACHE)).match('index.html')
    const word = kept && !givenUp ? await published() : null
    const fresh = !kept ? await hosted(0) : word !== null && word !== CACHE ? await hosted(HEADERS_MS) : null
    if (fresh && kept) {
      const pump = pumped(fresh, kept)
      holding(pump.done)
      // The worker stays up until the body is over: the beat, and the copy's body where it takes over, are its own work.
      try { event.waitUntil(pump.done) } catch { /* the event is over already: the browser keeps the worker for the body */ }
      return isolated(fresh, pump.body)
    }
    const res = fresh || kept
    if (res) return isolated(res)
  } catch { /* the storage refused: the browser's own load, below */ }
  return fetch(event.request)
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return
  if (req.mode === 'navigate') { event.respondWith(page(event)); return }
  event.respondWith(caches.open(CACHE).then((c) => c.match(req)).then((hit) => hit || fetch(req)))
})
`
}

/** The word that stands for the build in the worker's text when the build word itself is worked out. */
const NO_BUILD = '000000000000'

/**
 * The published build's word: twelve hex digits over everything published: the page as it is published (webPage: its
 * policy and head lines as written there), the manifest, the icons' bytes and the worker's own text, each with
 * NO_BUILD where the build stands (the page and the worker carry the word). A change to any of them is a new build,
 * a new cache name and a new worker: no phone keeps an old manifest or icon beside a page that did not change, and a
 * new worker never installs into the cache the worker before it is answering from.
 */
export function buildWord(html, icons = ICONS.map((icon) => readFileSync(join(ROOT, icon.from)))) {
  const hash = createHash('sha256')
  for (const part of [webPage(html, NO_BUILD), JSON.stringify(manifest()), worker(`agent-city-${NO_BUILD}`, NO_BUILD)]) hash.update(part).update('\0')
  for (const bytes of icons) hash.update(bytes).update('\0')
  return hash.digest('hex').slice(0, 12)
}

/** Builds dist-web/ from dist/index.html; returns what it wrote. */
export function build({ from = join(ROOT, 'dist'), out = join(ROOT, 'dist-web') } = {}) {
  const page = join(from, 'index.html')
  if (!existsSync(page)) throw new Error(`${page} is missing: run \`npm run build\` first`)
  const html = readFileSync(page, 'utf8')
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const digest = buildWord(html)
  const cache = `agent-city-${version}-${digest}`
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const published = webPage(html, digest)
  // The worker holds the page's first HOLD bytes back until they have all come (worker, pumped): what is handed on
  // after that must already carry the whole watchdog, the one thing that can start a page again that ends half way.
  const dog = published.indexOf('<script id="boot-watchdog">')
  const whole = dog < 0 ? -1 : published.indexOf('</script>', dog)
  if (whole < 0 || Buffer.byteLength(published.slice(0, whole + '</script>'.length)) > HOLD) {
    throw new Error(`${page}: the boot watchdog must end within the page's first ${HOLD} bytes (make the head smaller: phones hold older workers that hand the page on at that many bytes, so the number cannot be raised)`)
  }
  writeFileSync(join(out, 'index.html'), published)
  writeFileSync(join(out, 'manifest.webmanifest'), `${JSON.stringify(manifest(), null, 2)}\n`)
  writeFileSync(join(out, 'sw.js'), worker(cache, digest))
  writeFileSync(join(out, PROBE), `${cache}\n`)
  for (const icon of ICONS) copyFileSync(join(ROOT, icon.from), join(out, icon.name))
  writeFileSync(join(out, '.nojekyll'), '')
  return { out, cache, build: digest, files: ['index.html', 'manifest.webmanifest', 'sw.js', PROBE, ...ICONS.map((i) => i.name), '.nojekyll'] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  try {
    const r = build({ from: arg('from') && resolve(arg('from')), out: arg('out') && resolve(arg('out')) })
    console.log(`web app  ${r.out}  (${r.cache})`)
    for (const f of r.files) console.log(`  ${f}`)
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}
