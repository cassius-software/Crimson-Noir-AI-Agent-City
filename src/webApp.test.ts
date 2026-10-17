// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the installable copy a phone plays (tools/web/pwa.mjs, dist-web/): the page's
 * content policy gains `manifest-src 'self'` and nothing else, the head lines go in once, the icons are the PNGs of the
 * sizes the manifest declares, and the service worker, run here against a fake cache, answers a page load with any
 * query string from its cache with the two isolation headers, leaves other origins and other methods to the network,
 * and drops only its own older caches. The browser smoke test (tools/browser/smoke.mjs `pwa`) runs the real thing in
 * Chrome as an iPhone, with the host taken away.
 * What breaks if it is removed? A change to the builder could publish a page whose policy refuses its own manifest, a
 * worker that serves a stale or unisolated page, or one that deletes another app's cache, with nothing to say so
 * before a phone finds out.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script, createContext } from 'node:vm'

// tools/ is plain JavaScript with no types; a computed specifier keeps the page's typecheck off it.
const PWA: string = '../tools/web/pwa.mjs'
const web = (await import(PWA)) as {
  APP_NAME: string
  SHORT_NAME: string
  ICONS: readonly { name: string; from: string; size: number }[]
  CACHED: readonly string[]
  HEAD: string
  manifest(): { name: string; short_name: string; start_url: string; scope: string; display: string; icons: { src: string; sizes: string; type: string }[] }
  webPage(html: string): string
  worker(cache: string): string
}

const SOURCE = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

/** The page's policy as directives: name to its source list. */
function policyOf(html: string): Map<string, string[]> {
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)
  assert.ok(m, 'one Content-Security-Policy meta')
  const out = new Map<string, string[]>()
  for (const d of m[1].split(';')) {
    const [name, ...sources] = d.trim().split(/\s+/)
    if (name) out.set(name, sources)
  }
  return out
}

test('the web page keeps the whole policy and adds only manifest-src \'self\'; the head lines go in once', () => {
  const page = web.webPage(SOURCE)
  const before = policyOf(SOURCE), after = policyOf(page)
  assert.deepEqual(after.get('manifest-src'), ["'self'"])
  after.delete('manifest-src')
  assert.deepEqual(after, before, 'every other directive unchanged')
  assert.equal(page.split(web.HEAD).length, 2, 'the head lines once')
  assert.ok(page.indexOf(web.HEAD) < page.indexOf('<title>'), 'in the head')
  assert.match(web.HEAD, /<link rel="manifest" href="manifest.webmanifest" \/>/)
  assert.match(web.HEAD, /<link rel="apple-touch-icon" href="apple-touch-icon.png" \/>/)
  // The registration waits for a secure page served over http(s): a file opened from disk registers nothing.
  assert.match(web.HEAD, /window\.isSecureContext && \/\^https\?:\$\/\.test\(location\.protocol\)/)
})

test('a page that is not the one the builder knows fails instead of publishing', () => {
  const policy = SOURCE.match(/<meta http-equiv="Content-Security-Policy"[^>]+>/)![0]
  assert.throws(() => web.webPage(SOURCE.replace(policy, '')), /Content-Security-Policy/)
  assert.throws(() => web.webPage(SOURCE.replace(policy, `${policy}\n${policy}`)), /Content-Security-Policy/)
  assert.throws(() => web.webPage(SOURCE.replace("base-uri 'none'", "base-uri 'none'; manifest-src *")), /already names manifest-src/)
  assert.throws(() => web.webPage(SOURCE.replace(/<meta name="theme-color"[^>]+>/, '')), /theme-color/)
})

/** A PNG's width and height, from its IHDR chunk. */
function pngSize(file: string): [number, number] {
  const b = readFileSync(new URL(`../${file}`, import.meta.url))
  assert.equal(b.subarray(1, 4).toString('latin1'), 'PNG', `${file} is a PNG`)
  return [b.readUInt32BE(16), b.readUInt32BE(20)]
}

test('the manifest names the product, full screen from the folder, and every icon is the PNG of the size it declares', () => {
  const m = web.manifest()
  assert.equal(m.name, 'Crimson Noir: Agent City')
  assert.equal(m.short_name, 'Agent City')
  assert.equal(m.start_url, './')
  assert.equal(m.scope, './')
  assert.equal(m.display, 'fullscreen')
  for (const icon of web.ICONS) assert.deepEqual(pngSize(icon.from), [icon.size, icon.size], icon.name)
  for (const i of m.icons) {
    const icon = web.ICONS.find((x) => x.name === i.src)
    assert.ok(icon, i.src)
    assert.equal(i.sizes, `${icon.size}x${icon.size}`)
    assert.equal(i.type, 'image/png')
  }
  assert.ok(web.CACHED.includes('index.html') && web.CACHED.includes('manifest.webmanifest'))
  for (const icon of web.ICONS) assert.ok(web.CACHED.includes(icon.name), `${icon.name} cached`)
})

const ORIGIN = 'https://example.github.io'
const SCOPE = `${ORIGIN}/agent-city/`

/** The service worker run in a context with a fake Cache Storage holding `entries` per cache name. */
function runWorker(cacheName: string, entries: Record<string, Record<string, string>>) {
  const listeners = new Map<string, (event: unknown) => void>()
  const store = new Map(Object.entries(entries).map(([name, files]) => [name, new Map(Object.entries(files))]))
  const fetched: string[] = []
  const key = (r: string | { url: string }) => new URL(typeof r === 'string' ? r : r.url, SCOPE).href
  const open = (name: string) => {
    if (!store.has(name)) store.set(name, new Map())
    const files = store.get(name)!
    return {
      async addAll(urls: string[]) { for (const u of urls) files.set(key(u).slice(SCOPE.length), `body of ${u}`) },
      async match(r: string | { url: string }) {
        const body = files.get(key(r).slice(SCOPE.length))
        return body === undefined ? undefined : new Response(body, { headers: { 'Content-Type': 'text/html' } })
      },
    }
  }
  const self = {
    location: new URL(`${SCOPE}sw.js`),
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
  }
  const caches = {
    open: async (name: string) => open(name),
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
  }
  const fetch = async (r: { url: string }) => { fetched.push(r.url); return new Response('from the network') }
  const context = createContext({ self, caches, fetch, Headers, Response, URL, Promise, Object, JSON })
  new Script(web.worker(cacheName)).runInContext(context)
  /** Dispatches a fetch event; resolves to the response the worker gave, or null when it left the request alone. */
  const request = async (url: string, { mode = 'no-cors', method = 'GET' } = {}): Promise<Response | null> => {
    let answer: Promise<Response> | null = null
    listeners.get('fetch')!({ request: { url, mode, method }, respondWith: (p: Promise<Response>) => { answer = p } })
    return answer ? await answer : null
  }
  const lifecycle = async (type: 'install' | 'activate') => {
    let wait: Promise<unknown> = Promise.resolve()
    listeners.get(type)!({ waitUntil: (p: Promise<unknown>) => { wait = p } })
    await wait
  }
  return { store, fetched, request, lifecycle }
}

test('the worker caches every file on install, then drops only its own older caches', async () => {
  const w = runWorker('agent-city-1.0.0-new', { 'agent-city-1.0.0-old': { 'index.html': 'old' }, 'someone-else': { x: 'y' } })
  await w.lifecycle('install')
  assert.deepEqual([...w.store.get('agent-city-1.0.0-new')!.keys()].sort(), [...web.CACHED].sort())
  await w.lifecycle('activate')
  assert.deepEqual([...w.store.keys()].sort(), ['agent-city-1.0.0-new', 'someone-else'])
})

test('a page load with any query string gets the cached page, isolated; other requests are left alone or fall back', async () => {
  const w = runWorker('agent-city-x', { 'agent-city-x': { 'index.html': 'the city', 'icon-512.png': 'png' } })
  for (const url of [SCOPE, `${SCOPE}?players=2`, `${SCOPE}index.html?map=lakefront&onboarding=0`]) {
    const res = await w.request(url, { mode: 'navigate' })
    assert.ok(res, url)
    assert.equal(await res.text(), 'the city')
    assert.equal(res.headers.get('Cross-Origin-Opener-Policy'), 'same-origin')
    assert.equal(res.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp')
    assert.equal(res.headers.get('Content-Type'), 'text/html', 'the cached headers kept')
  }
  const icon = await w.request(`${SCOPE}icon-512.png`)
  assert.equal(await icon!.text(), 'png')
  assert.equal(icon!.headers.get('Cross-Origin-Embedder-Policy'), null, 'only the page gets the headers')
  assert.equal(await w.request('http://127.0.0.1:8080/v1/chat/completions'), null, 'another origin: the worker stays out')
  assert.equal(await w.request(`${SCOPE}index.html`, { method: 'POST' }), null, 'a POST: the worker stays out')
  assert.equal(await (await w.request(`${SCOPE}missing.png`))!.text(), 'from the network')
  assert.deepEqual(w.fetched, [`${SCOPE}missing.png`], 'the network only for what the cache lacks')
})
