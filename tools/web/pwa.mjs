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
 * which otherwise refuses the manifest), the manifest, the service worker, the icons, and an empty .nojekyll (GitHub
 * Pages would otherwise run Jekyll over the folder). Any static https host can serve it; the web workflow
 * (.github/workflows/web.yml) publishes it on GitHub Pages when someone runs that workflow.
 * The service worker (WORKER below) answers every request for these files from its own cache after the first visit, so
 * the city then starts with no network at all; it keeps one cache per build, named by the page's hash, and drops the
 * others once a new build has been cached. It also adds the two cross-origin isolation headers a static host does not
 * send to the page it serves, so from the second visit on the physics bridge shares memory with its worker as it does
 * under `npm run preview` (without them the bridge copies, and nothing else changes).
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

/** The lines added to the page's head, right after its theme colour. The registration runs only over http(s) in a secure context. */
export const HEAD = [
  '<link rel="manifest" href="manifest.webmanifest" />',
  '<link rel="apple-touch-icon" href="apple-touch-icon.png" />',
  '<meta name="apple-mobile-web-app-capable" content="yes" />',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
  `<meta name="apple-mobile-web-app-title" content="${SHORT_NAME}" />`,
  "<script>if (window.isSecureContext && /^https?:$/.test(location.protocol) && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('[web] no offline copy: ' + e))</script>",
].join('\n    ')

const ANCHOR = /(<meta name="theme-color" content="[^"]*" \/>)/
const POLICY = /(<meta http-equiv="Content-Security-Policy" content=")([^"]+)(")/

/**
 * The page with the head lines and `manifest-src 'self'`. A page without exactly one theme colour and one content
 * policy, or one that already names a manifest source, is not the page this was written for: it fails rather than
 * publishing a page whose policy refuses its own manifest.
 */
export function webPage(html) {
  if ((html.match(new RegExp(ANCHOR, 'g')) ?? []).length !== 1) throw new Error('dist/index.html: expected one theme-color meta to anchor the head lines')
  if ((html.match(new RegExp(POLICY, 'g')) ?? []).length !== 1) throw new Error('dist/index.html: expected one Content-Security-Policy meta')
  return html
    .replace(POLICY, (_m, open, policy, close) => {
      if (/(^|;)\s*manifest-src\b/.test(policy)) throw new Error('dist/index.html: the policy already names manifest-src')
      return `${open}${policy.replace(/;?\s*$/, '')}; manifest-src 'self'${close}`
    })
    .replace(ANCHOR, (m) => `${m}\n    ${HEAD}`)
}

/**
 * The service worker. `CACHE` names this build (the page's hash), so a new build installs beside the old one and, once
 * every file of it is cached, takes over and drops the old cache. Requests for this origin's files come from the cache
 * first (the network only for one the cache lacks); a page load (any query string: ?players=2, ?map=lakefront) gets
 * the cached page with the isolation headers added.
 */
export function worker(cache) {
  return `// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// The offline copy of Crimson Noir: Agent City, written by tools/web/pwa.mjs (see there). Generated: edit that file.
const CACHE = ${JSON.stringify(cache)}
const FILES = ${JSON.stringify(CACHED)}
const ISOLATION = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('agent-city-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()))
})

/** The page as the cache holds it, with the isolation headers a static host does not send. */
function isolated(res) {
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(ISOLATION)) headers.set(k, v)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return
  const page = req.mode === 'navigate'
  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    const res = (await cache.match(page ? 'index.html' : req)) ?? (await fetch(req))
    return page && res.ok ? isolated(res) : res
  })())
})
`
}

/** Builds dist-web/ from dist/index.html; returns what it wrote. */
export function build({ from = join(ROOT, 'dist'), out = join(ROOT, 'dist-web') } = {}) {
  const page = join(from, 'index.html')
  if (!existsSync(page)) throw new Error(`${page} is missing: run \`npm run build\` first`)
  const html = readFileSync(page, 'utf8')
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const cache = `agent-city-${version}-${createHash('sha256').update(html).digest('hex').slice(0, 12)}`
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'index.html'), webPage(html))
  writeFileSync(join(out, 'manifest.webmanifest'), `${JSON.stringify(manifest(), null, 2)}\n`)
  writeFileSync(join(out, 'sw.js'), worker(cache))
  for (const icon of ICONS) copyFileSync(join(ROOT, icon.from), join(out, icon.name))
  writeFileSync(join(out, '.nojekyll'), '')
  return { out, cache, files: ['index.html', 'manifest.webmanifest', 'sw.js', ...ICONS.map((i) => i.name), '.nojekyll'] }
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
