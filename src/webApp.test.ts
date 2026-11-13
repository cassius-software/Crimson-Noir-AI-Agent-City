// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the installable copy a phone plays (tools/web/pwa.mjs, dist-web/): the page's
 * content policy gains `manifest-src 'self'` and nothing else, the head lines go in once, the icons are the PNGs of the
 * sizes the manifest declares, and the service worker, run here against a fake cache, a scripted host and a clock
 * the test turns: it keeps a build only when the host serves that build's page, answers a page load with any query
 * string from its copy when the host names the same build or does not say in time, and from the host's one fixed
 * address when the host names another, always with the two isolation headers; it never cuts off a page that keeps
 * its pace, gives up one that stops, breaks or crawls (the copy takes the answer over where nothing was handed on yet,
 * else the body ends cleanly and the copy answers the load that follows), never writes a cache from a page load,
 * leaves other origins, other methods and the site's model folder (models/) to the network, and drops only its own
 * older caches. The site's model goes beside that page and nowhere else (tools/web/siteModel.mjs placeModel: checked
 * against its pin while copied, nothing left behind on a mismatch, a folder that is not the web copy refused), and the
 * web workflow places it after the build and before the upload, on every publish. The browser smoke test
 * (tools/browser/smoke.mjs `pwa`) runs the real thing in Chrome as an iPhone, with a second build published and with
 * the host taken away.
 * What breaks if it is removed? A change to the builder could publish a page whose policy refuses its own manifest, a
 * worker that serves a stale or unisolated page, or one that deletes another app's cache, with nothing to say so
 * before a phone finds out.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Script, createContext } from 'node:vm'
import { BRAND } from './brand.ts'
import { BUILD_META } from './07_Execute_Actions/bootFailure.ts'
import { APP_MODEL, SITE_MODEL, manifestText, type SiteModelPin } from './09_Cognition/siteModel.ts'

// tools/ is plain JavaScript with no types; a computed specifier keeps the page's typecheck off it.
const PWA: string = '../tools/web/pwa.mjs'
const PAGE_DIST: string = '../tools/verify/page_dist.mjs'
const { MAX_BYTES } = (await import(PAGE_DIST)) as { MAX_BYTES: number }
const web = (await import(PWA)) as {
  APP_NAME: string
  SHORT_NAME: string
  ICONS: readonly { name: string; from: string; size: number }[]
  CACHED: readonly string[]
  HEAD: string
  BUILD_META: string
  PROBE: string
  PROBE_MS: number
  HEADERS_MS: number
  STALL_MS: number
  PACE_AFTER_MS: number
  PACE: number
  GIVEN_UP_MS: number
  HOLD: number
  PAGE_LOCK: string
  LINK_MS: number
  manifest(): { name: string; short_name: string; start_url: string; scope: string; display: string; icons: { src: string; sizes: string; type: string }[] }
  webPage(html: string, build?: string): string
  worker(cache: string, build: string): string
  buildWord(html: string, icons?: readonly Uint8Array[]): string
  build(o: { from: string; out: string }): { out: string; cache: string; build: string; files: string[] }
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
  // The registration, run: only a secure page served over http(s) registers (a file opened from disk does not), and
  // only once the page has loaded, so on a first visit the worker it starts does not download the page beside the
  // page itself. (On a later visit the browser looks for a newer worker by itself: PAGE_LOCK, further down, keeps
  // that one's download off the launch's link.)
  const script = web.HEAD.match(/<script>([\s\S]*?)<\/script>/)![1]
  const visit = (secure: boolean, protocol: string, workers = true) => {
    const registered: string[] = []
    const loaded: (() => void)[] = []
    const navigator = workers ? { serviceWorker: { register: (url: string) => { registered.push(url); return Promise.reject(new Error('no')) } } } : {}
    const context = createContext({ window: { isSecureContext: secure }, location: { protocol }, navigator, console: { warn: () => {} },
      addEventListener: (type: string, fn: () => void) => { if (type === 'load') loaded.push(fn) } })
    new Script(script).runInContext(context)
    return { registered, load: () => { for (const fn of loaded) fn() } }
  }
  const https = visit(true, 'https:')
  assert.deepEqual(https.registered, [], 'nothing before the page has loaded')
  https.load()
  assert.deepEqual(https.registered, ['sw.js'], 'at load, the worker beside the page')
  for (const [what, v] of [['a page that is not secure', visit(false, 'http:')], ['a file opened from disk', visit(true, 'file:')], ['a browser with no service workers', visit(true, 'https:', false)]] as const) {
    v.load()
    assert.deepEqual(v.registered, [], what)
  }
})

test('the published page says which build it is: one meta, first among the head lines, the name the recovery card reads', () => {
  const page = web.webPage(SOURCE, '0123456789ab')
  const meta = '<meta name="agent-city-build" content="0123456789ab" />'
  assert.equal(page.split(meta).length, 2, 'once')
  assert.ok(page.indexOf(meta) < page.indexOf(web.HEAD) && page.indexOf(meta) < 2048, 'before the other head lines, in the page\'s first bytes')
  assert.equal(page.split(web.HEAD).length, 2, 'the head lines as they were')
  assert.equal(page.replace(`${meta}\n    `, ''), web.webPage(SOURCE), 'nothing else differs')
  assert.equal(web.BUILD_META, BUILD_META, 'tools/web/pwa.mjs and bootFailure.ts name the one meta')
  assert.doesNotMatch(web.webPage(SOURCE), /<meta name="agent-city-build"/, 'no build word, no meta')
  for (const bad of ['0123', '0123456789AB', '0123456789abc', '"><script>']) assert.throws(() => web.webPage(SOURCE, bad), /twelve hex digits/, bad)
  assert.throws(() => web.webPage(page, 'ba9876543210'), /already carries a build meta/)
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
  assert.equal(m.short_name, 'Crimson Noir')
  // The page and the home screen carry one name: brand.ts's.
  assert.equal(web.APP_NAME, BRAND.name)
  assert.equal(web.SHORT_NAME, BRAND.short)
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
const BUILD = '0123456789ab'
const CACHE = `agent-city-1.0.0-${BUILD}`
const OTHER = 'agent-city-1.0.0-ba9876543210'
/** A page as the host serves it for `build`: its meta in the first bytes, then the page. */
const pageOf = (build: string, body = 'the city') => `<!doctype html><meta name="agent-city-build" content="${build}" />${body}`

/** What the scripted host does with one request: a response, a failure, or no answer until the request is aborted. */
type Answer = Response | Promise<Response> | 'stall' | 'fail'
/** How many answers a browser lets a worker hold with nobody reading their bodies (Chrome, for a page not in front). */
const UNREAD_HELD = 3
interface Asked { url: string; cache?: string; signal?: AbortSignal; request?: unknown }
/** A network answer: a response of this origin (`type` 'basic'), as fetch gives a same-origin one. */
function basic(body: BodyInit | null, init: ResponseInit = {}, type = 'basic'): Response {
  const res = new Response(body, init)
  Object.defineProperty(res, 'type', { value: type })
  return res
}
const html = (body: BodyInit | null, extra: Record<string, string> = {}) => basic(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...extra } })

/**
 * The service worker run in a context with a fake Cache Storage holding `entries` per cache name, a host scripted by
 * `host` (asked with each request's address), and timers that run only when the test fires them.
 */
function runWorker(entries: Record<string, Record<string, string>>, host: (url: string, asked: Asked) => Answer = () => 'fail', opts: { cache?: string; build?: string; onLine?: boolean; storage?: 'refuses'; copy?: () => BodyInit; locks?: unknown } = {}) {
  const listeners = new Map<string, (event: unknown) => void>()
  const store = new Map(Object.entries(entries).map(([name, files]) => [name, new Map(Object.entries(files))]))
  const asked: Asked[] = []
  const key = (r: string | { url: string }) => new URL(typeof r === 'string' ? r : r.url, SCOPE).href
  const open = (name: string) => {
    if (opts.storage === 'refuses') throw new Error('the storage refused')
    if (!store.has(name)) store.set(name, new Map())
    const files = store.get(name)!
    return {
      async put(r: string | { url: string }, res: Response) { files.set(key(r).slice(SCOPE.length), await res.text()) },
      async match(r: string | { url: string }) {
        const file = key(r).slice(SCOPE.length), text = files.get(file)
        // The page's body as the test feeds it (opts.copy), where a test needs the copy to arrive in pieces.
        const body = text !== undefined && file === 'index.html' && opts.copy ? opts.copy() : text
        return body === undefined ? undefined : new Response(body, { headers: { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip', 'Content-Length': '7' } })
      },
    }
  }
  let skipped = 0
  const self = {
    location: new URL(`${SCOPE}sw.js`),
    navigator: { onLine: opts.onLine ?? true, ...(opts.locks ? { locks: opts.locks } : {}) },
    clients: { claim: async () => {} },
    skipWaiting: async () => { skipped++ },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
  }
  const caches = {
    open: async (name: string) => open(name),
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
  }
  // The worker's clock: timers run only when the test fires them (fire) or turns the clock past them (advance).
  let now = 0
  const timers: { fn: () => void; ms: number; at: number; live: boolean }[] = []
  const setTimeout = (fn: () => void, ms: number) => timers.push({ fn, ms, at: now + ms, live: true })
  const clearTimeout = (id: number) => { if (timers[id - 1]) timers[id - 1].live = false }
  /** Lets the worker run as far as it can without a timer. */
  const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
  // The answers handed to the worker so far. A browser holds back a further answer while UNREAD_HELD of them have
  // bodies nobody is reading; here one that is still held back after the worker has had every chance to read is
  // refused, so a worker that waits on more answers than that before reading any fails where the browser would hang.
  const delivered: Response[] = []
  const unread = (): number => delivered.filter((r) => r.body !== null && !r.bodyUsed).length
  const deliver = async (res: Response): Promise<Response> => {
    for (let i = 0; unread() >= UNREAD_HELD; i++) {
      if (i >= 40) throw new TypeError(`held back: ${UNREAD_HELD} answers are still unread`)
      await new Promise((r) => setImmediate(r))
    }
    delivered.push(res)
    return res
  }
  const fetch = (input: string | { url: string }, init: { cache?: string; signal?: AbortSignal } = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.url
    const one: Asked = { url, cache: init.cache, signal: init.signal, ...(typeof input === 'string' ? {} : { request: input }) }
    asked.push(one)
    const answer = host(url, one)
    if (answer === 'fail') return Promise.reject(new TypeError('Failed to fetch'))
    if (answer !== 'stall') return Promise.resolve(answer).then(deliver)
    return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError'))))
  }
  const context = createContext({ self, caches, fetch, Headers, Response, URL, Promise, Object, JSON, Error, AbortController, TextDecoder, ReadableStream, setTimeout, clearTimeout })
  new Script(web.worker(opts.cache ?? CACHE, opts.build ?? BUILD)).runInContext(context)
  /** What the worker asked the browser to stay up for (waitUntil), per fetch event, in order. */
  const waits: Promise<unknown>[] = []
  /** Starts a fetch event; `answer` resolves to the response the worker gave, or null when it left the request alone. */
  const start = (url: string, { mode = 'no-cors', method = 'GET' } = {}): { request: { url: string; mode: string; method: string }; answer: Promise<Response | null> } => {
    const request = { url, mode, method }
    let answer: Promise<Response> | null = null
    listeners.get('fetch')!({ request, respondWith: (p: Promise<Response>) => { answer = p }, waitUntil: (p: Promise<unknown>) => { waits.push(p) } })
    return { request, answer: Promise.resolve(answer) }
  }
  const request = (url: string, o?: { mode?: string; method?: string }): Promise<Response | null> => start(url, o).answer
  const lifecycle = async (type: 'install' | 'activate') => {
    let wait: Promise<unknown> = Promise.resolve()
    listeners.get(type)!({ waitUntil: (p: Promise<unknown>) => { wait = p } })
    await wait
  }
  /** Fires every timer still set, as time passing its deadline does. */
  const fire = (): void => { for (const t of timers) if (t.live) { t.live = false; t.fn() } }
  /** Turns the clock on by `ms`, firing each timer that falls due on the way, in order, the worker running between them. */
  const advance = async (ms: number): Promise<void> => {
    const until = now + ms
    for (;;) {
      await settle()
      const due = timers.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      now = due.at
      due.live = false
      due.fn()
    }
    now = until
    await settle()
  }
  return { store, asked, timers, waits, request, start, lifecycle, settle, fire, advance, fetch, skipped: () => skipped, self }
}

/** The addresses asked of the host, in order. */
const urls = (w: { asked: Asked[] }) => w.asked.map((a) => a.url)
const PROBE_URL = `${SCOPE}build.txt`
const PAGE_URL = `${SCOPE}index.html`
/** A host that publishes `cache` with `page`: build.txt names it, index.html is its page. */
const publishing = (cache: string, page: () => Answer) => (url: string): Answer => (url === PROBE_URL ? basic(`${cache}\n`) : url === PAGE_URL ? page() : 'fail')
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)
/** A body that arrives in the given pieces, one a read. */
const inPieces = (pieces: string[]): ReadableStream<Uint8Array> => {
  const left = pieces.map(bytesOf)
  return new ReadableStream<Uint8Array>({ pull(c) { const next = left.shift(); if (next) c.enqueue(next); else c.close() } })
}
/** The host's page with a body the test feeds: so many bytes, its end, or a broken link; `cancelled` says the worker let go of it. */
function fedPage() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c }, cancel() { cancelled = true } })
  return {
    res: html(body, { 'Content-Encoding': 'gzip', 'Content-Length': '9' }),
    push: (bytes: number): void => controller.enqueue(new Uint8Array(bytes).fill(97)),
    close: (): void => controller.close(),
    fail: (): void => controller.error(new TypeError('network error')),
    cancelled: (): boolean => cancelled,
  }
}
/** A body read piece by piece. */
function reading(res: Response) {
  const reader = res.body!.getReader()
  let pending: Promise<number> | null = null
  const piece = (): Promise<number> => (pending ??= reader.read().then((step) => (step.done ? 0 : step.value.byteLength)))
  /** Whether a piece (or the end) is there to be read, the worker having run as far as it can. */
  const waiting = async (w: { settle(): Promise<void> }): Promise<boolean> => {
    let there = false
    void piece().then(() => { there = true })
    await w.settle()
    return there
  }
  /** The next piece's bytes (0: the end), waited for. */
  const next = async (): Promise<number> => {
    const n = await piece()
    pending = null
    return n
  }
  /** Everything that comes until the body ends: its bytes. */
  const rest = async (): Promise<number> => {
    for (let total = 0; ;) {
      const n = await next()
      if (n === 0) return total
      total += n
    }
  }
  return { waiting, next, rest, cancel: () => reader.cancel() }
}

/**
 * The origin's named locks as a browser keeps them, shared by every worker of the origin: one holder a name, the
 * others in a queue, a request given up when its signal says so. `held` says whether a name is held now.
 */
function lockManager() {
  interface Job { run: () => void }
  const queues = new Map<string, Job[]>()
  const held = new Set<string>()
  const next = (name: string): void => {
    if (!held.has(name)) queues.get(name)?.shift()?.run()
  }
  const request = (name: string, a: unknown, b?: unknown): Promise<unknown> => {
    const [options, callback] = (typeof a === 'function' ? [{}, a] : [a, b]) as [{ signal?: AbortSignal }, (lock: { name: string }) => unknown]
    return new Promise((resolve, reject) => {
      const queue = queues.get(name) ?? queues.set(name, []).get(name)!
      const over = (settle: () => void) => { held.delete(name); settle(); next(name) }
      const job: Job = { run: () => { held.add(name); Promise.resolve().then(() => callback({ name })).then((v) => over(() => resolve(v)), (e) => over(() => reject(e))) } }
      options.signal?.addEventListener('abort', () => {
        const at = queue.indexOf(job)
        if (at >= 0) { queue.splice(at, 1); reject(new DOMException('The request was aborted.', 'AbortError')) }
      })
      queue.push(job)
      next(name)
    })
  }
  return { request, held: (name: string) => held.has(name) }
}

test('install asks the host for every file past the HTTP cache and keeps them only when the page is this build\'s', async () => {
  const served = (build: string) => (url: string): Answer => (url === PAGE_URL ? html(pageOf(build)) : basic(`body of ${url.slice(SCOPE.length)}`))
  const w = runWorker({ 'agent-city-1.0.0-old': { 'index.html': 'old' }, 'someone-else': { x: 'y' } }, served(BUILD))
  await w.lifecycle('install')
  assert.deepEqual(urls(w).sort(), web.CACHED.map((f) => `${SCOPE}${f}`).sort(), 'each file once, at its fixed address')
  // The page last, after the small files were read whole: a browser lets a worker hold only a few answers whose bodies
  // nobody reads (three, in Chrome, for a page not in front), and five held at once never finished installing. The
  // scripted host holds the worker to that (runWorker), so an install that waits on every answer first fails here.
  assert.equal(urls(w).at(-1), PAGE_URL, 'the page is asked for once the small files are in')
  const held = runWorker({}, served(BUILD))
  await assert.rejects(Promise.all(web.CACHED.map((f) => held.fetch(`${SCOPE}${f}`))), /held back: 3 answers are still unread/, 'five answers waited on before any is read: the browser would never hand over the fourth')
  assert.ok(w.asked.every((a) => a.cache === 'no-cache'), 'every one revalidated with the host')
  assert.deepEqual([...w.store.get(CACHE)!.keys()].sort(), [...web.CACHED].sort())
  assert.equal(w.store.get(CACHE)!.get('index.html'), pageOf(BUILD), 'the whole page is kept, though only its opening was read')
  assert.equal(w.skipped(), 1, 'and it takes over')
  await w.lifecycle('activate')
  assert.deepEqual([...w.store.keys()].sort(), [CACHE, 'someone-else'], 'only its own older caches are dropped')
  // A host still serving the page before (a deploy's first moments, or an HTTP cache's ten minutes): nothing is kept.
  for (const [what, host] of [
    ['another build\'s page', served('ba9876543210')],
    ['a page with no build meta', (url: string): Answer => (url === PAGE_URL ? html('<!doctype html>the city') : basic('x'))],
    ['a file the host does not have', (url: string): Answer => (url.endsWith('icon-256.png') ? basic('gone', { status: 404 }) : served(BUILD)(url))],
    ['a host that cannot be reached', (): Answer => 'fail'],
  ] as const) {
    const v = runWorker({ [OTHER]: { 'index.html': 'the build before' } }, host)
    await assert.rejects(v.lifecycle('install'), Error, what)
    assert.equal(v.store.get(CACHE), undefined, `${what}: nothing kept under this build's name`)
    assert.equal(v.skipped(), 0, `${what}: the worker before stays in charge`)
  }
  // The page's opening may arrive in more than one piece (a slow link's first packet): the build meta is looked for
  // across them, this build's is kept whole and another build's refused.
  const pieced = (build: string) => (url: string): Answer => (url === PAGE_URL ? html(inPieces(['<!doctype html><meta name="agent', `-city-build" content="${build}" />`, 'the city'])) : basic('x'))
  const split = runWorker({}, pieced(BUILD))
  await split.lifecycle('install')
  assert.equal(split.store.get(CACHE)!.get('index.html'), pageOf(BUILD), 'the meta across two pieces: kept, whole')
  const wrong = runWorker({}, pieced('ba9876543210'))
  await assert.rejects(wrong.lifecycle('install'), /does not serve build/, 'another build\'s meta in the second piece')
  assert.equal(wrong.store.get(CACHE), undefined)
  assert.ok(!web.CACHED.includes(web.PROBE) && !web.CACHED.includes('sw.js'), 'the host\'s word and the worker are never kept')
  assert.throws(() => web.worker(CACHE, 'not-a-build'), /twelve hex digits/)
})

test('a page load asks the host one small file; the same build, and the copy answers, isolated, for any query string', async () => {
  const w = runWorker({ [CACHE]: { 'index.html': 'the city', 'icon-512.png': 'png' } }, publishing(CACHE, () => html('never asked for')))
  const loads = [SCOPE, `${SCOPE}?players=2`, `${SCOPE}index.html?map=lakefront&onboarding=0`, `${SCOPE}?kernel=lite`, `${SCOPE}?boot=tty`]
  for (const url of loads) {
    const res = await w.request(url, { mode: 'navigate' })
    assert.ok(res, url)
    assert.equal(await res.text(), 'the city')
    assert.equal(res.headers.get('Cross-Origin-Opener-Policy'), 'same-origin')
    assert.equal(res.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp')
    assert.equal(res.headers.get('Content-Type'), 'text/html', 'the cached headers kept')
    assert.equal(res.headers.get('Content-Encoding'), null, 'less the host\'s words for a body that is already decoded')
    assert.equal(res.headers.get('Content-Length'), null)
  }
  assert.deepEqual(urls(w), loads.map(() => PROBE_URL), 'one request a load, to the one fixed address, whatever the query')
  assert.ok(w.asked.every((a) => a.cache === 'no-store'), 'past the browser\'s cache')
  assert.ok(w.timers.length === loads.length && w.timers.every((t) => !t.live && t.ms === web.PROBE_MS), 'each deadline set and cleared')
  // Other requests: the cache first, the network only for what it lacks; other origins and methods are left alone.
  const icon = await w.request(`${SCOPE}icon-512.png`)
  assert.equal(await icon!.text(), 'png')
  assert.equal(icon!.headers.get('Cross-Origin-Embedder-Policy'), null, 'only the page gets the headers')
  assert.equal(await w.request('http://127.0.0.1:8080/v1/chat/completions'), null, 'another origin: the worker stays out')
  assert.equal(await w.request(`${SCOPE}index.html`, { method: 'POST' }), null, 'a POST: the worker stays out')
  const v = runWorker({ [CACHE]: { 'index.html': 'the city' } }, () => basic('from the network'))
  assert.equal(await (await v.request(`${SCOPE}missing.png`))!.text(), 'from the network')
  assert.deepEqual(urls(v), [`${SCOPE}missing.png`], 'the network only for what the cache lacks')
  await v.settle()
  assert.deepEqual([...v.store.keys()], [CACHE], 'and what the network gave is not kept: no cache made')
  assert.deepEqual([...v.store.get(CACHE)!.entries()], [['index.html', 'the city']], 'nor added to this build\'s')
})

test('the host names another build: the page comes from the host\'s fixed address, isolated, and no cache is written', async () => {
  for (const url of [SCOPE, `${SCOPE}?kernel=lite`, `${SCOPE}index.html?boot=tty`]) {
    const w = runWorker({ [CACHE]: { 'index.html': 'the build before' } }, publishing(OTHER, () => html(pageOf('ba9876543210', 'the new city'), { 'Content-Encoding': 'gzip', 'Content-Length': '9', ETag: '"abc"' })))
    const res = await w.request(url, { mode: 'navigate' })
    assert.equal(await res!.text(), pageOf('ba9876543210', 'the new city'), url)
    assert.equal(res!.headers.get('Cross-Origin-Opener-Policy'), 'same-origin')
    assert.equal(res!.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp', 'the host\'s page is isolated too')
    assert.equal(res!.headers.get('Content-Type'), 'text/html; charset=utf-8')
    assert.equal(res!.headers.get('ETag'), '"abc"', 'the host\'s other headers kept')
    assert.equal(res!.headers.get('Content-Encoding'), null)
    assert.equal(res!.headers.get('Content-Length'), null)
    assert.deepEqual(urls(w), [PROBE_URL, PAGE_URL], 'the word, then the page: neither carries the address that was opened')
    assert.deepEqual(w.asked.map((a) => a.cache), ['no-store', 'no-cache'])
    assert.deepEqual([...w.store.keys()], [CACHE], 'no cache made')
    assert.deepEqual([...w.store.get(CACHE)!.entries()], [['index.html', 'the build before']], 'and the copy untouched: each cache is one build\'s')
  }
})

test('a host that does not say, or does not begin a page, in time leaves the copy to answer', async () => {
  const kept = { [CACHE]: { 'index.html': 'the city' } }
  const copy = async (w: ReturnType<typeof runWorker>, what: string, fire = false): Promise<void> => {
    const { answer } = w.start(SCOPE, { mode: 'navigate' })
    if (fire) { await w.settle(); w.fire(); await w.settle(); w.fire() }
    const res = await answer
    assert.equal(await res!.text(), 'the city', what)
    assert.equal(res!.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp', what)
    assert.deepEqual([...w.store.get(CACHE)!.entries()], [['index.html', 'the city']], `${what}: the copy untouched`)
  }
  // The word: no network, a phone that says it is offline (nothing is asked at all), no answer by the deadline, junk.
  const dead = runWorker(kept, () => 'fail')
  await copy(dead, 'the host cannot be reached')
  assert.deepEqual(urls(dead), [PROBE_URL])
  const offline = runWorker(kept, () => html('never'), { onLine: false })
  await copy(offline, 'the phone is offline')
  assert.deepEqual(urls(offline), [], 'nothing asked')
  const silent = runWorker(kept, () => 'stall')
  await copy(silent, 'the word never comes', true)
  assert.deepEqual(urls(silent), [PROBE_URL])
  assert.equal(silent.asked[0].signal?.aborted, true, 'the unanswered request is given up, not left open')
  // The word's body is under the deadline too: headers that come and a body that never ends are no answer.
  const halting = runWorker(kept, (url, a) => (url === PROBE_URL
    ? basic(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytesOf('agent-city-')); a.signal?.addEventListener('abort', () => c.error(new DOMException('The operation was aborted.', 'AbortError'))) } }))
    : html('never')))
  const halted = halting.start(SCOPE, { mode: 'navigate' })
  await halting.settle()
  assert.deepEqual(halting.timers.filter((t) => t.live).map((t) => t.ms), [web.PROBE_MS], 'the headers came; the deadline still stands over the body')
  halting.fire()
  assert.equal(await (await halted.answer)!.text(), 'the city', 'the word\'s body never ends')
  assert.equal(halting.asked[0].signal?.aborted, true)
  assert.deepEqual(urls(halting), [PROBE_URL])
  for (const [what, word] of [['a 404', basic('Not Found', { status: 404 })], ['a 500', basic('agent-city-x', { status: 500 })], ['a sign-in page', html('<!doctype html><title>Sign in</title>')], ['a long word', basic(`agent-city-${'x'.repeat(200)}`)], ['an empty file', basic('')]] as const) {
    const w = runWorker(kept, (url) => (url === PROBE_URL ? word : html('never')))
    await copy(w, `the word is ${what}`)
    assert.deepEqual(urls(w), [PROBE_URL], `${what}: the page is not asked for`)
    assert.ok(word.body === null || word.bodyUsed, `${what}: the refused answer is not left unread`)
  }
  // The page: refused, not a page, not this origin's, unreachable, or not begun by the deadline.
  for (const [what, page] of [
    ['a 404', () => basic('Not Found', { status: 404, headers: { 'Content-Type': 'text/html' } })],
    ['a 500', () => basic('oops', { status: 500, headers: { 'Content-Type': 'text/html' } })],
    ['a 200 that is not HTML', () => basic('{}', { headers: { 'Content-Type': 'application/json' } })],
    ['an answer of another kind', () => basic(pageOf('ba9876543210'), { headers: { 'Content-Type': 'text/html' } }, 'opaqueredirect')],
    ['unreachable', () => 'fail'],
  ] as [string, () => Answer][]) {
    const w = runWorker(kept, publishing(OTHER, page))
    await copy(w, `the host's page is ${what}`)
    assert.deepEqual(urls(w), [PROBE_URL, PAGE_URL])
  }
  const slow = runWorker(kept, publishing(OTHER, () => 'stall'))
  await copy(slow, 'the host\'s page does not begin in time', true)
  assert.equal(slow.asked[1].signal?.aborted, true, 'given up')
  assert.deepEqual(slow.timers.map((t) => t.ms), [web.PROBE_MS, web.HEADERS_MS])
})

test('a page from the host that keeps coming is never cut off, however long it takes; its opening is handed on whole', async () => {
  const pages = [fedPage(), fedPage()]
  const served = [...pages]
  const page = pages[0]
  const w = runWorker({ [CACHE]: { 'index.html': 'the build before' } }, publishing(OTHER, () => served.shift()!.res))
  const res = await w.request(`${SCOPE}?kernel=lite`, { mode: 'navigate' })
  assert.deepEqual(w.timers.filter((t) => t.live).map((t) => t.ms), [1000], 'both deadlines were cleared when the answers began: only the beat runs')
  assert.equal(res!.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp')
  assert.equal(res!.headers.get('Content-Encoding'), null)
  // The page's opening (it carries the page's watchdog) is held back until all of it has come, then handed on in order.
  const body = reading(res!)
  page.push(web.HOLD - 1000)
  assert.equal(await body.waiting(w), false, 'short of the opening: nothing is handed on')
  page.push(999)
  assert.equal(await body.waiting(w), false, 'one byte short')
  page.push(1)
  assert.deepEqual([await body.next(), await body.next(), await body.next()], [web.HOLD - 1000, 999, 1], 'the opening, whole, its pieces as they came')
  // Forty seconds at exactly the slowest pace kept, far past every deadline.
  page.push(web.PACE - web.HOLD)
  await w.advance(1000)
  for (let second = 1; second < 40; second++) {
    page.push(web.PACE)
    await w.advance(1000)
  }
  page.close()
  assert.equal(await body.rest(), 40 * web.PACE - web.HOLD, 'the body arrives whole')
  await w.settle()
  assert.ok(w.asked.every((a) => a.signal?.aborted === false), 'no request was aborted')
  assert.equal(page.cancelled(), false)
  assert.ok(w.timers.every((t) => !t.live), 'the beat stops with the body')
  assert.equal(w.waits.length, 1, 'the worker asked the browser to stay up for the body')
  await w.waits[0]
  // Nothing is remembered against the host: the next load asks it again. A page that ends inside its opening is a
  // page all the same, handed on whole.
  const next = await w.request(SCOPE, { mode: 'navigate' })
  pages[1].push(5)
  pages[1].close()
  assert.equal((await next!.arrayBuffer()).byteLength, 5)
  assert.deepEqual(urls(w), [PROBE_URL, PAGE_URL, PROBE_URL, PAGE_URL])
  assert.doesNotMatch(web.worker(CACHE, BUILD), /AbortSignal\.timeout/, 'a timeout signal would cut a body at the deadline')
  assert.doesNotMatch(web.worker(CACHE, BUILD), /\.navigate\(|resultingClientId/, 'the worker sends no page anywhere: a page that ends half way loads itself again (index.html, the watchdog)')
})

test('a page from the host that stops, breaks or crawls is given up: the copy takes the answer over, or the body ends and the copy answers the next load', async () => {
  const kept = { [CACHE]: { 'index.html': 'the build before' } }
  const address = `${SCOPE}?kernel=lite`
  /** A load of `address` under a worker holding the build before, the host naming another and feeding `page`. */
  const load = async () => {
    const page = fedPage(), after = fedPage()
    const served = [page, after]
    const w = runWorker(kept, publishing(OTHER, () => served.shift()!.res))
    const res = (await w.request(address, { mode: 'navigate' }))!
    let ended: number | null = null
    const whole = res.arrayBuffer().then((b) => { ended = b.byteLength; return new TextDecoder().decode(b) })
    return { w, res, page, after, whole, ended: () => ended }
  }
  type Load = Awaited<ReturnType<typeof load>>
  /** After a give-up: the worker's own work is over, and the load that follows is the copy's, the host unasked. */
  const leftAlone = async (l: Load, what: string): Promise<void> => {
    await l.w.waits[0]
    const asked = urls(l.w).length
    const again = (await l.w.request(address, { mode: 'navigate' }))!
    assert.equal(await again.text(), 'the build before', `${what}: the copy answers the load that follows`)
    assert.equal(again.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp', what)
    assert.equal(urls(l.w).length, asked, `${what}: and the host is asked for nothing`)
    assert.deepEqual([...l.w.store.get(CACHE)!.entries()], [['index.html', 'the build before']], `${what}: the copy untouched`)
  }
  /** Given up with part of the host's page handed on: the body ends there, cleanly (the page's watchdog loads it again). */
  const ended = async (l: Load, bytes: number, what: string, open = true): Promise<void> => {
    assert.equal((await l.whole).length, bytes, `${what}: the body ends where it stopped, with no error and nothing of the copy after it`)
    // An answer still open is let go of; one the link broke is over already.
    if (open) assert.equal(l.page.cancelled(), true, `${what}: the host's answer is let go`)
    await leftAlone(l, what)
  }
  /** Given up with nothing handed on: the copy's body is this very answer, isolated, with no second load. */
  const tookOver = async (l: Load, what: string, open = true): Promise<void> => {
    assert.equal(await l.whole, 'the build before', `${what}: the copy, whole, and nothing of the host's page before it`)
    assert.equal(l.res.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp', what)
    assert.equal(l.res.headers.get('Content-Encoding'), null, what)
    if (open) assert.equal(l.page.cancelled(), true, `${what}: the host's answer is let go`)
    await leftAlone(l, what)
  }

  // It stops: well ahead of the pace, then not a byte. Not given up within STALL_MS of silence; given up on the beat after.
  const stop = await load()
  stop.page.push(6 * web.PACE)
  await stop.w.advance(web.STALL_MS)
  assert.equal(stop.ended(), null, 'five seconds of silence: still waiting')
  await stop.w.advance(1000)
  await ended(stop, 6 * web.PACE, 'a page that stops')
  // The memory of it passes: after GIVEN_UP_MS the host is asked again.
  await stop.w.advance(web.GIVEN_UP_MS)
  const later = (await stop.w.request(address, { mode: 'navigate' }))!
  stop.after.push(3)
  stop.after.close()
  assert.equal((await later.arrayBuffer()).byteLength, 3, 'later the host\'s page is taken again')
  assert.deepEqual(urls(stop.w), [PROBE_URL, PAGE_URL, PROBE_URL, PAGE_URL])

  // It crawls: bytes every second, one short of the pace each time. Given up at PACE_AFTER_MS, not before.
  const crawl = await load()
  const second = web.PACE - 1
  for (let s = 1; s < web.PACE_AFTER_MS / 1000; s++) {
    crawl.page.push(second)
    await crawl.w.advance(1000)
  }
  assert.equal(crawl.ended(), null, 'before the pace is asked for: still waiting')
  crawl.page.push(second)
  await crawl.w.advance(1000)
  await ended(crawl, (web.PACE_AFTER_MS / 1000) * second, 'a page that crawls')

  // The link breaks past the opening: given up at once.
  const snap = await load()
  snap.page.push(web.HOLD + 1000)
  await snap.w.settle()
  snap.page.fail()
  await snap.w.settle()
  assert.ok(snap.w.timers.every((t) => !t.live || t.ms === web.GIVEN_UP_MS), 'nothing is waited for')
  await ended(snap, web.HOLD + 1000, 'a broken link (an errored body would leave a page that never reaches its load event)', false)

  // Given up inside the opening, nothing was handed on: the copy takes the answer over. A page that brings its first
  // bytes and stops (at the pace rule's first look), one that never brings a byte, a link that breaks at once.
  const early = await load()
  early.page.push(web.HOLD - 1)
  await early.w.advance(web.PACE_AFTER_MS - 1000)
  assert.equal(early.ended(), null, 'before the pace is asked for: still waiting')
  await early.w.advance(1000)
  await tookOver(early, 'a page that stops inside its opening')
  const mute = await load()
  await mute.w.advance(web.PACE_AFTER_MS)
  await tookOver(mute, 'a page that never brings a byte')
  for (const [what, bytes] of [['a link that breaks inside the opening', 1000], ['a link that breaks before a byte', 0]] as const) {
    const l = await load()
    if (bytes) l.page.push(bytes)
    await l.w.settle()
    l.page.fail()
    await l.w.settle()
    assert.ok(l.w.timers.every((t) => !t.live || t.ms === web.GIVEN_UP_MS), `${what}: nothing is waited for`)
    await tookOver(l, what, false)
  }

  // The copy taking over comes in pieces too. The page leaving half way, or the storage breaking off, ends the
  // worker's work all the same: nothing is thrown and the browser is not asked to keep the worker up for ever.
  for (const [what, leave] of [['the page leaves while the copy takes over', true], ['the storage breaks off while the copy takes over', false]] as const) {
    let feed!: ReadableStreamDefaultController<Uint8Array>
    let let_go = false
    const host = fedPage()
    const w = runWorker(kept, publishing(OTHER, () => host.res), { copy: () => new ReadableStream<Uint8Array>({ start(c) { feed = c }, cancel() { let_go = true } }) })
    const res = (await w.request(address, { mode: 'navigate' }))!
    const body = reading(res)
    host.fail()
    await w.settle()
    let over = false
    void w.waits[0].then(() => { over = true })
    feed.enqueue(bytesOf('the build'))
    assert.equal(await body.next(), 9, `${what}: the copy's first piece is this answer's`)
    await w.settle()
    assert.equal(over, false, `${what}: the worker is kept up while the copy's body is still being handed on`)
    if (leave) {
      await body.cancel()
      await w.settle()
      assert.equal(let_go, true, `${what}: the copy's body is let go`)
    } else {
      feed.error(new Error('storage'))
      assert.equal(await body.next(), 0, `${what}: the body ends where the copy stopped, cleanly`)
    }
    await w.waits[0]
    assert.ok(w.timers.every((t) => !t.live || t.ms === web.GIVEN_UP_MS), `${what}: nothing left running`)
  }

  // The page being loaded goes away (closed, or sent elsewhere by its user) while the host's page comes: the host's
  // answer is let go, the beat stops, and nothing is held against the host.
  const gone = fedPage()
  const w = runWorker(kept, publishing(OTHER, () => gone.res))
  const res = (await w.request(address, { mode: 'navigate' }))!
  gone.push(web.HOLD + 1000)
  await res.body!.cancel()
  await w.settle()
  assert.equal(gone.cancelled(), true)
  assert.ok(w.timers.every((t) => !t.live), 'no beat left running')
  await w.waits[0]
  await w.request(address, { mode: 'navigate' }).catch(() => null)
  assert.deepEqual(urls(w).slice(2, 3), [PROBE_URL], 'the next load asks the host again')
})

test('a newer build\'s install waits for a launch\'s page from the host to be over before it downloads anything, half a minute at most; no launch waits', async () => {
  const kept = { [CACHE]: { 'index.html': 'the build before' } }
  const NEWER = 'ba9876543210'
  const newerHost = (url: string): Answer => (url === PAGE_URL ? html(pageOf(NEWER)) : basic('x'))
  /** A launch under the worker before, the host's page coming, and the newer build's worker started beside it (as a browser does by itself, a second into the launch in Safari). */
  const beside = async (locks: unknown, bytes = web.HOLD) => {
    const page = fedPage()
    const old = runWorker(kept, publishing(OTHER, () => page.res), { locks })
    const res = (await old.request(SCOPE, { mode: 'navigate' }))!
    page.push(bytes)
    await old.settle()
    const newer = runWorker({}, newerHost, { cache: OTHER, build: NEWER, locks })
    let done = false
    const installed = newer.lifecycle('install').then(() => { done = true })
    await newer.settle()
    await old.settle()
    return { page, old, res, newer, installed, done: () => done }
  }
  const every = web.CACHED.map((f) => `${SCOPE}${f}`).sort()

  // The launch's page is coming: the install asks the host for nothing. The page over, it downloads its files.
  const locks = lockManager()
  const a = await beside(locks)
  assert.equal(locks.held(web.PAGE_LOCK), true, 'the launch holds the page download')
  assert.deepEqual(urls(a.newer), [], 'nothing of the newer build is downloaded beside the launch\'s page')
  a.page.close()
  assert.equal((await a.res.arrayBuffer()).byteLength, web.HOLD)
  await a.old.waits[0]
  await a.installed
  assert.deepEqual(urls(a.newer).sort(), every, 'the page over, the install downloads its files')
  assert.equal(locks.held(web.PAGE_LOCK), false, 'and nothing is left held')
  assert.ok(a.newer.timers.every((t) => !t.live), 'the install\'s own deadline is cleared')

  // A page given up frees the link too, either way: its body ended where it stopped, or the copy taking over; then
  // the install.
  for (const [what, bytes, body] of [['a page given up past its opening', web.HOLD, 'a'.repeat(web.HOLD)], ['a page given up inside its opening', web.HOLD - 1, 'the build before']] as const) {
    const held = lockManager()
    const b = await beside(held, bytes)
    assert.equal(held.held(web.PAGE_LOCK), true, what)
    b.page.fail()
    await b.old.settle()
    assert.equal(await b.res.text(), body, what)
    await b.installed
    assert.deepEqual(urls(b.newer).sort(), every, `${what}: the install goes on`)
    assert.equal(held.held(web.PAGE_LOCK), false, what)
  }

  // A launch never waits for the lock. A second launch while the first one's page is still coming (another tab) is
  // answered at once, and so is one under locks that never answer.
  const busy = lockManager()
  const first = fedPage(), then = fedPage()
  const pages = [first, then]
  const two = runWorker(kept, publishing(OTHER, () => pages.shift()!.res), { locks: busy })
  const one = (await two.request(SCOPE, { mode: 'navigate' }))!
  first.push(web.HOLD)
  await two.settle()
  assert.equal(busy.held(web.PAGE_LOCK), true)
  let answered: Response | null = null
  void two.request(SCOPE, { mode: 'navigate' }).then((r) => { answered = r ?? null })
  await two.settle()
  assert.ok(answered, 'a second launch is answered while the first still holds the lock')
  then.push(web.HOLD)
  then.close()
  assert.equal((await (answered as Response).arrayBuffer()).byteLength, web.HOLD, 'and its page arrives whole')
  first.close()
  assert.equal((await one.arrayBuffer()).byteLength, web.HOLD)
  await Promise.all(two.waits)
  assert.equal(busy.held(web.PAGE_LOCK), false, 'both pages over: nothing held')
  const deaf = fedPage()
  const never = runWorker(kept, publishing(OTHER, () => deaf.res), { locks: { request: () => new Promise(() => {}) } })
  let heard: Response | null = null
  void never.request(SCOPE, { mode: 'navigate' }).then((r) => { heard = r ?? null })
  await never.settle()
  assert.ok(heard, 'locks that never answer: the launch is answered all the same')
  deaf.push(web.HOLD)
  deaf.close()
  assert.equal((await (heard as Response).arrayBuffer()).byteLength, web.HOLD, 'and its page arrives whole')

  // A launch that goes on and on: the install waits LINK_MS, then downloads beside it.
  const c = await beside(lockManager())
  await c.newer.advance(web.LINK_MS - 1)
  assert.equal(c.done(), false)
  assert.deepEqual(urls(c.newer), [], 'a millisecond short of the wait: still nothing')
  await c.newer.advance(1)
  await c.installed
  assert.deepEqual(urls(c.newer).sort(), every, 'past the wait the install goes on')
  c.page.close()
  await c.res.arrayBuffer()

  // A browser with no locks, one whose locks throw, one whose locks refuse: the launch is answered and the install goes on.
  for (const [what, none] of [
    ['no locks', undefined],
    ['locks that throw', { request: () => { throw new Error('denied') } }],
    ['locks that refuse', { request: () => Promise.reject(new Error('denied')) }],
  ] as const) {
    const d = await beside(none)
    await d.installed
    assert.deepEqual(urls(d.newer).sort(), every, `${what}: the install goes on beside the launch`)
    d.page.close()
    assert.equal((await d.res.arrayBuffer()).byteLength, web.HOLD, `${what}: the launch's page arrives whole`)
    await d.old.waits[0]
  }
  // An install with no launch about waits for nothing.
  const free = lockManager()
  const alone = runWorker({}, newerHost, { cache: OTHER, build: NEWER, locks: free })
  await alone.lifecycle('install')
  assert.deepEqual(urls(alone).sort(), every)
  assert.equal(free.held(web.PAGE_LOCK), false)
})

test('with no copy the host\'s page answers; with neither, or storage that refuses, the browser\'s own load does', async () => {
  const fresh = runWorker({}, publishing(OTHER, () => html(pageOf('ba9876543210'))))
  assert.equal(await (await fresh.request(`${SCOPE}?players=2`, { mode: 'navigate' }))!.text(), pageOf('ba9876543210'))
  assert.deepEqual(urls(fresh), [PAGE_URL], 'no copy to compare: the page is asked for at once')
  // With no copy to fall back on, a slow page is left to arrive: nothing watches it, holds it back or gives it up.
  const only = fedPage()
  const bare = runWorker({}, publishing(OTHER, () => only.res))
  const slow = (await bare.request(SCOPE, { mode: 'navigate' }))!
  const body = reading(slow)
  only.push(10)
  assert.equal(await body.next(), 10, 'its first bytes are handed on as they come')
  await bare.advance(10 * 60_000)
  assert.ok(bare.timers.every((t) => !t.live), 'no beat')
  assert.equal(bare.waits.length, 0)
  only.push(10)
  only.close()
  assert.equal(await body.rest(), 10, 'ten minutes on, the rest of the page')
  assert.equal(only.cancelled(), false)
  // Nor is its beginning under a deadline: a host slow to answer is waited for, and its page is isolated all the same.
  let begin: (res: Response) => void = () => {}
  const tardy = runWorker({}, publishing(OTHER, () => new Promise<Response>((r) => { begin = r })))
  const { answer } = tardy.start(SCOPE, { mode: 'navigate' })
  await tardy.advance(10 * web.HEADERS_MS)
  assert.deepEqual(tardy.timers, [], 'no deadline was set')
  begin(html(pageOf('ba9876543210')))
  const late = (await answer)!
  assert.equal(await late.text(), pageOf('ba9876543210'))
  assert.equal(late.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp', 'the host\'s page, isolated')
  assert.deepEqual(urls(tardy), [PAGE_URL], 'asked once: the browser\'s own load is not sent after it')
  for (const [what, w] of [
    ['no copy and no host', runWorker({}, (_url, a) => (a.request ? basic('the browser\'s own answer') : 'fail'))],
    ['storage that refuses', runWorker({}, (_url, a) => (a.request ? basic('the browser\'s own answer') : 'fail'), { storage: 'refuses' })],
  ] as const) {
    const { request, answer } = w.start(`${SCOPE}?players=2`, { mode: 'navigate' })
    assert.equal(await (await answer)!.text(), 'the browser\'s own answer', what)
    assert.equal(w.asked.at(-1)!.request, request, `${what}: the request as the browser made it, redirect mode and all`)
  }
})

test('the build word covers everything published, the worker included, and build.txt carries the cache\'s name', () => {
  const icons = web.ICONS.map(() => new Uint8Array([1, 2, 3]))
  const word = web.buildWord(SOURCE, icons)
  assert.match(word, /^[0-9a-f]{12}$/)
  assert.equal(web.buildWord(SOURCE, icons), word, 'the same inputs, the same word')
  assert.notEqual(web.buildWord(`${SOURCE} `, icons), word, 'the page')
  assert.notEqual(web.buildWord(SOURCE, [new Uint8Array([9]), ...icons.slice(1)]), word, 'an icon')
  // The worker's own text is in it too (with a fixed word where its build stands), so a changed worker is a new build
  // with a cache of its own, never one installing into the cache the worker before it answers from.
  const none = '000000000000'
  const over = createHash('sha256')
  for (const part of [web.webPage(SOURCE, none), JSON.stringify(web.manifest()), web.worker(`agent-city-${none}`, none)]) over.update(part).update('\0')
  for (const bytes of icons) over.update(bytes).update('\0')
  assert.equal(word, over.digest('hex').slice(0, 12), 'the page as published, the manifest, the worker\'s text and the icons, and nothing else')
  const dir = mkdtempSync(join(tmpdir(), 'agent-city-webapp-'))
  try {
    writeFileSync(join(dir, 'index.html'), SOURCE)
    const out = join(dir, 'web')
    const r = web.build({ from: dir, out })
    assert.equal(r.build, web.buildWord(SOURCE), 'what is published is named by the build word')
    assert.match(r.cache, new RegExp(`^agent-city-.+-${r.build}$`))
    assert.equal(readFileSync(join(out, web.PROBE), 'utf8'), `${r.cache}\n`)
    assert.ok(r.files.includes(web.PROBE))
    const page = readFileSync(join(out, 'index.html'), 'utf8')
    assert.ok(page.includes(`<meta name="agent-city-build" content="${r.build}" />`), 'the page says the same build')
    const sw = readFileSync(join(out, 'sw.js'), 'utf8')
    assert.ok(sw.includes(`const CACHE = ${JSON.stringify(r.cache)}`) && sw.includes(`const BUILD = ${JSON.stringify(r.build)}`), 'and so does the worker')
    new Script(sw)
    // What the worker hands on after its held-back opening must carry the whole watchdog (it is what loads a page
    // again that ends half way): a page whose watchdog ends later, or that has none, is not published.
    const dog = '<script id="boot-watchdog">'
    // The number is held: a phone's older worker hands a newly published page on at the HOLD of its own day, so a
    // larger one would let a page through with half a watchdog. A build refused here is mended by a smaller head.
    assert.ok(web.HOLD <= 32_768, 'HOLD may be lowered, never raised')
    // The numbers the manual and the changelog print (two and four seconds, five of silence, 600 kB a second after
    // four, five minutes, half a minute): a change here is a change to both.
    assert.deepEqual([web.PROBE_MS, web.HEADERS_MS, web.STALL_MS, web.PACE_AFTER_MS, web.PACE, web.GIVEN_UP_MS, web.LINK_MS],
      [2000, 4000, 5000, 4000, 600_000, 300_000, 30_000])
    // An install never waits less than a launch can need, nor so long that Firefox's minute for an install is spent:
    // the pace rule ends the largest page that may be published well inside LINK_MS.
    assert.ok((MAX_BYTES / web.PACE) * 1000 + 5000 <= web.LINK_MS, 'the largest page, at the slowest pace kept, is over five seconds inside the wait')
    assert.ok(web.LINK_MS <= 30_000, 'half of the minute Firefox gives an install is left to download in')
    const room = web.HOLD - Buffer.byteLength(page.slice(0, page.indexOf('</script>', page.indexOf(dog)) + '</script>'.length))
    assert.ok(room > 0, 'the page\'s watchdog ends inside the opening the worker holds back')
    writeFileSync(join(dir, 'index.html'), SOURCE.replace(dog, `<!--${'x'.repeat(room - 7)}-->${dog}`))
    web.build({ from: dir, out })
    writeFileSync(join(dir, 'index.html'), SOURCE.replace(dog, `<!--${'x'.repeat(room - 6)}-->${dog}`))
    assert.throws(() => web.build({ from: dir, out }), /the boot watchdog must end within the page's first 32768 bytes \(make the head smaller/, 'one byte past the opening')
    writeFileSync(join(dir, 'index.html'), SOURCE.replace(dog, '<script id="another">'))
    assert.throws(() => web.build({ from: dir, out }), /the boot watchdog must end within/, 'no watchdog at all')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the site\'s model folder is left to the network: no model in the worker\'s cache, and models/LICENSE is the licence, not the city', async () => {
  const w = runWorker({ [CACHE]: { 'index.html': 'the city', 'modelsx.png': 'png' } }, publishing(CACHE, () => html('never asked for')))
  for (const path of [`models/${SITE_MODEL.file}`, 'models/manifest.json', 'models/LICENSE']) {
    assert.equal(await w.request(`${SCOPE}${path}`), null, path)
    assert.equal(await w.request(`${SCOPE}${path}`, { mode: 'navigate' }), null, `a page load of ${path}`)
  }
  assert.deepEqual(urls(w), [], 'nothing asked of the host for them: the browser fetches them itself')
  assert.equal(await (await w.request(`${SCOPE}modelsx.png`))?.text(), 'png', 'only the folder itself')
  assert.equal(await (await w.request(SCOPE, { mode: 'navigate' }))?.text(), 'the city', 'the page still comes from the copy')
  assert.ok(!web.CACHED.some((f) => f.startsWith('models/')), 'nothing of the model is cached on install')
})

// tools/web/siteModel.mjs is plain JavaScript; a computed specifier keeps the page's typecheck off it.
const SITE: string = '../tools/web/siteModel.mjs'
const siteTool = (await import(SITE)) as {
  LICENCE_FILES: readonly string[]
  PINS: Readonly<Record<string, { pin: SiteModelPin; licence: string; prefix: string }>>
  pinLines(pin?: SiteModelPin, prefix?: string): string[]
  checkModel(o: { from: string; pin?: SiteModelPin }): Promise<{ bytes: number; sha256: string }>
  placeModel(o: { from: string; out: string; pin?: SiteModelPin; licence?: string }): Promise<string[]>
  placeApp(o: { from: string; out?: string; pin?: SiteModelPin; licence?: string }): Promise<string[]>
}

/** A model file of `bytes` in a fresh folder, a pin for it, and a stand-in web copy (its index.html names the manifest, or not). */
function staged(webCopy = true) {
  const root = mkdtempSync(join(tmpdir(), 'site-model-'))
  const from = join(root, 'cache')
  const out = join(root, 'dist-web')
  mkdirSync(from)
  mkdirSync(out)
  const model = Buffer.from(Array.from({ length: 70_001 }, (_, i) => (i * 31 + 7) & 0xff))
  const pin: SiteModelPin = { ...SITE_MODEL, file: 'tiny-a.gguf', bytes: model.length, sha256: createHash('sha256').update(model).digest('hex') }
  writeFileSync(join(from, pin.file), model)
  writeFileSync(join(out, 'index.html'), webCopy ? '<!doctype html><link rel="manifest" href="manifest.webmanifest" />' : '<!doctype html><title>dist</title>')
  return { root, from, out, model, pin, done: () => rmSync(root, { recursive: true, force: true }) }
}

test('the workflow\'s pin is the page\'s: one cache key per pin, and the file fetched at the pinned revision', () => {
  const where = createHash('sha256').update(`${SITE_MODEL.repo}\n${SITE_MODEL.revision}\n${SITE_MODEL.file}\n${SITE_MODEL.bytes}`).digest('hex').slice(0, 16)
  assert.deepEqual(siteTool.pinLines(), [
    `key=site-model-${SITE_MODEL.sha256}-${where}`,
    `file=${SITE_MODEL.file}`,
    `bytes=${SITE_MODEL.bytes}`,
    `sha256=${SITE_MODEL.sha256}`,
    `url=https://huggingface.co/${SITE_MODEL.repo}/resolve/${SITE_MODEL.revision}/${SITE_MODEL.file}`,
  ])
  // Any change to the pin misses the cache, so the new address or name is fetched (and checked) on the pull request.
  const keyOf = (pin: SiteModelPin): string | undefined => siteTool.pinLines(pin)[0]
  for (const moved of [{ revision: '0'.repeat(40) }, { repo: 'someone/else' }, { file: 'renamed.gguf' }]) {
    assert.notEqual(keyOf({ ...SITE_MODEL, ...moved }), keyOf(SITE_MODEL), JSON.stringify(moved))
  }
})

test('the model goes beside the web copy, checked while copied, with its manifest and licence; a mismatch leaves no model behind', async () => {
  const s = staged()
  try {
    assert.deepEqual(await siteTool.checkModel({ from: s.from, pin: s.pin }), { bytes: s.model.length, sha256: s.pin.sha256 })
    const files = await siteTool.placeModel({ from: s.from, out: s.out, pin: s.pin })
    assert.deepEqual(files, ['models/tiny-a.gguf', 'models/manifest.json', 'models/LICENSE', 'models/NOTICE'])
    assert.deepEqual(readFileSync(join(s.out, 'models', 'tiny-a.gguf')), s.model)
    assert.equal(readFileSync(join(s.out, 'models', 'manifest.json'), 'utf8'), manifestText(s.pin))
    for (const f of siteTool.LICENCE_FILES) assert.equal(readFileSync(join(s.out, 'models', f), 'utf8'), readFileSync(new URL(`../third_party/qwen2.5-0.5b-instruct/${f}`, import.meta.url), 'utf8'))
    assert.deepEqual(readdirSync(join(s.out, 'models')).sort(), ['LICENSE', 'NOTICE', 'manifest.json', 'tiny-a.gguf'], 'no .part file left')
  } finally {
    s.done()
  }
  for (const wrong of [{ bytes: 70_000 }, { sha256: '0'.repeat(64) }]) {
    const t = staged()
    try {
      const pin = { ...t.pin, ...wrong }
      await assert.rejects(siteTool.checkModel({ from: t.from, pin }), /the pin says/)
      await assert.rejects(siteTool.placeModel({ from: t.from, out: t.out, pin }), /the pin says/)
      assert.ok(!existsSync(join(t.out, 'models')), 'nothing of the model is left in the web copy')
    } finally {
      t.done()
    }
  }
})

test('the model never goes beside a page that is not the web copy (dist/ carries no model), nor from a cache without it', async () => {
  const s = staged(false)
  try {
    await assert.rejects(siteTool.placeModel({ from: s.from, out: s.out, pin: s.pin }), /is not the web copy/)
    assert.ok(!existsSync(join(s.out, 'models')))
  } finally {
    s.done()
  }
  const t = staged()
  try {
    await assert.rejects(siteTool.placeModel({ from: join(t.root, 'empty'), out: t.out, pin: t.pin }), /is missing/)
  } finally {
    t.done()
  }
})

test('the web workflow places the checked model after the build and before the upload, on every publish, and caches it by its pin alone', () => {
  const yml = readFileSync(new URL('../.github/workflows/web.yml', import.meta.url), 'utf8')
  const at = (needle: string): number => {
    const i = yml.indexOf(needle)
    assert.ok(i >= 0, needle)
    return i
  }
  const build = at('run: npm run build:web')
  const pin = at('run: node tools/web/siteModel.mjs pin >> "$GITHUB_OUTPUT"')
  const cache = at('key: ${{ steps.model.outputs.key }}')
  const fetchStep = at('if: steps.model-cache.outputs.cache-hit != \'true\'')
  const place = at('run: node tools/web/siteModel.mjs place --from "$RUNNER_TEMP/site-model" --out dist-web')
  const upload = at('uses: actions/upload-pages-artifact@')
  assert.ok(build < pin && pin < cache && cache < fetchStep && fetchStep < place && place < upload, 'build, pin, cache, fetch, place, upload')
  assert.doesNotMatch(yml, /restore-keys/, 'a new pin never restores an old file')
  const placeStep = yml.slice(yml.lastIndexOf('- name:', place), place)
  assert.doesNotMatch(placeStep, /\bif:/, 'the check runs on every publish, the cached file included')
  const check = readFileSync(new URL('../.github/workflows/site-model.yml', import.meta.url), 'utf8')
  assert.match(check, /pull_request:\s+paths:[\s\S]*src\/09_Cognition\/siteModel\.ts[\s\S]*tools\/web\/siteModel\.mjs/)
  assert.match(check, /node tools\/web\/siteModel\.mjs check --from "\$RUNNER_TEMP\/site-model"/)
})

test('the app\'s pin is the page\'s too: its own cache key, its own licence, fetched at its pinned revision', () => {
  assert.deepEqual(Object.keys(siteTool.PINS), ['site', 'app'])
  assert.equal(siteTool.PINS.site.pin, SITE_MODEL)
  assert.equal(siteTool.PINS.app.pin, APP_MODEL)
  assert.match(siteTool.PINS.app.licence, /third_party[\\/]qwen2\.5-1\.5b-instruct$/)
  const where = createHash('sha256').update(`${APP_MODEL.repo}\n${APP_MODEL.revision}\n${APP_MODEL.file}\n${APP_MODEL.bytes}`).digest('hex').slice(0, 16)
  assert.deepEqual(siteTool.pinLines(APP_MODEL, siteTool.PINS.app.prefix), [
    `key=app-model-${APP_MODEL.sha256}-${where}`,
    `file=${APP_MODEL.file}`,
    `bytes=${APP_MODEL.bytes}`,
    `sha256=${APP_MODEL.sha256}`,
    `url=https://huggingface.co/${APP_MODEL.repo}/resolve/${APP_MODEL.revision}/${APP_MODEL.file}`,
  ])
  assert.equal(siteTool.pinLines()[0]?.startsWith('key=site-model-'), true, 'the site\'s key is as it was, so its cache still holds')
})

test('the app\'s model goes into the app\'s models/ folder, checked while copied, with its licence and notice alone; a mismatch leaves nothing', async () => {
  const s = staged()
  const app = join(s.root, 'src-tauri')
  try {
    // Something an earlier run left there goes: the installer carries exactly the model and its licence.
    mkdirSync(join(app, 'models'), { recursive: true })
    writeFileSync(join(app, 'models', 'stale.gguf'), 'old')
    const files = await siteTool.placeApp({ from: s.from, out: app, pin: s.pin })
    assert.deepEqual(files, ['models/tiny-a.gguf', 'models/LICENSE', 'models/NOTICE'])
    assert.deepEqual(readFileSync(join(app, 'models', 'tiny-a.gguf')), s.model)
    for (const f of siteTool.LICENCE_FILES) assert.equal(readFileSync(join(app, 'models', f), 'utf8'), readFileSync(new URL(`../third_party/qwen2.5-1.5b-instruct/${f}`, import.meta.url), 'utf8'))
    assert.deepEqual(readdirSync(join(app, 'models')).sort(), ['LICENSE', 'NOTICE', 'tiny-a.gguf'], 'no manifest, no .part file, nothing stale')
    await assert.rejects(siteTool.placeApp({ from: s.from, out: app, pin: { ...s.pin, sha256: '0'.repeat(64) } }), /the pin says/)
    assert.ok(!existsSync(join(app, 'models')), 'a mismatch leaves no model behind')
    await assert.rejects(siteTool.placeApp({ from: join(s.root, 'empty'), out: app, pin: s.pin }), /is missing/)
    // A file fetched straight into models/ (or below it) is refused, never deleted before it is read.
    for (const inside of ['models', join('models', 'sub')]) {
      mkdirSync(join(app, inside), { recursive: true })
      writeFileSync(join(app, inside, s.pin.file), s.model)
      await assert.rejects(siteTool.placeApp({ from: join(app, inside), out: app, pin: s.pin }), /which app clears before it copies/)
      assert.deepEqual(readFileSync(join(app, inside, s.pin.file)), s.model, `${inside}: the fetched file is still there`)
    }
    const beside = join(app, 'models-cache')
    mkdirSync(beside)
    writeFileSync(join(beside, s.pin.file), s.model)
    assert.ok(await siteTool.placeApp({ from: beside, out: app, pin: s.pin }), 'a folder whose name only starts the same is not inside')
  } finally {
    s.done()
  }
})

test('the Windows workflow fetches the app\'s model by its pin, checks it on every build, and builds both installers with it', () => {
  const yml = readFileSync(new URL('../.github/workflows/windows-app.yml', import.meta.url), 'utf8')
  const at = (needle: string): number => {
    const i = yml.indexOf(needle)
    assert.ok(i >= 0, needle)
    return i
  }
  const pin = at('run: node tools/web/siteModel.mjs pin --pin app | tee -a "$GITHUB_OUTPUT"')
  const cache = at('key: ${{ steps.model.outputs.key }}')
  const fetchStep = at('if: steps.model-cache.outputs.cache-hit != \'true\'')
  const place = at('run: node tools/web/siteModel.mjs app --from "$RUNNER_TEMP/app-model"')
  const build = at('npm run app:build -- --config src-tauri/tauri.model.conf.json')
  const msi = at('bundle --bundles msi --config src-tauri/tauri.model.conf.json --config')
  const carries = at('it does not carry the $MODEL_BYTES-byte model')
  const tidy = at('run: rm -rf src-tauri/target/release/bundle src-tauri/target/release/models')
  assert.ok(pin < cache && cache < fetchStep && fetchStep < place && place < build && build < msi && msi < carries && carries < tidy, 'pin, cache, fetch, check and place, installer, .msi, size check, tidy')
  const collect = yml.slice(yml.lastIndexOf('- name:', carries), yml.indexOf('- uses:', carries))
  assert.match(collect, /\n\s+env:\n\s+MODEL_BYTES: \$\{\{ steps\.model\.outputs\.bytes \}\}\n/, 'the size check reads the pinned size')
  assert.match(collect, /: "\$\{MODEL_BYTES:\?/, 'and fails, rather than checking against 0, when it has none')
  const cacheStep = yml.slice(yml.lastIndexOf('- id: model-cache', cache), yml.indexOf('- name:', cache))
  assert.doesNotMatch(cacheStep, /restore-keys/, 'a new pin never restores an old file')
  const placeStep = yml.slice(yml.lastIndexOf('- name:', place), place)
  assert.doesNotMatch(placeStep, /\bif:/, 'the check runs on every build, the cached file included')
  assert.doesNotMatch(yml, /models[^\n]*out\/portable|out\/portable[^\n]*models/, 'the bare .exe carries no model')
  // site-model.yml checks the app's pin on Linux too, on a pull request that touches it.
  const check = readFileSync(new URL('../.github/workflows/site-model.yml', import.meta.url), 'utf8')
  assert.match(check, /pull_request:\s+paths:[\s\S]*third_party\/qwen2\.5-1\.5b-instruct\/\*\*[\s\S]*src-tauri\/tauri\.model\.conf\.json/)
  assert.match(check, /\n {2}app:\n[\s\S]*node tools\/web\/siteModel\.mjs check --pin app --from "\$RUNNER_TEMP\/app-model"/)
})
