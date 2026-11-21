#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It opens the web copy in a real Safari, the browser every iPhone runs it in (Chrome,
 * Firefox and Edge on an iPhone are Safari's engine under another name), and says what a visitor there gets: the city
 * drawing frames, or the recovery card and which one. tools/browser/smoke.mjs fakes an iPhone inside Chrome (its user
 * agent, its screen, its touch), which proves the page's layout and its words for an iPhone and nothing about WebKit:
 * its JavaScript engine, its WGSL compiler, its WebGPU on Metal, its workers. This tool is the check that does.
 * It serves a built copy (dist-web/, or any folder with an index.html) on 127.0.0.1 the way a static host serves it,
 * with no cross-origin isolation headers, starts safaridriver (the WebDriver that comes with Safari on a Mac) and
 * speaks the W3C WebDriver protocol to it with fetch alone, as tools/browser/nativeE2e.mjs does to WebKitGTK's:
 * - `--target mac`: Safari on this Mac, in its automation window;
 * - `--target iphone`: Safari in the iOS Simulator (an iPhone of the newest iOS runtime Xcode has here, or the one
 *   --device names), which is the iPhone's own WebKit build, user agent, screen and touch on this Mac's GPU.
 * In each it first runs a probe on a page of its own (what the browser offers: a secure context, WebGPU on the page
 * and inside a worker, the adapter's name, features and limits, a device, one compute pass read back), then opens the
 * city once per --query (default: a first-time visitor's own address with the onboarding off) and polls the page's own
 * state under ?debug until the city draws frames with its crowd advancing, a recovery card shows, or the time runs out.
 * What the probe found decides what the page owes (expected, judge): a browser with a working GPU, on the page and in
 * a worker, must run the city with no engine error; a browser that gave no adapter, or has no WebGPU, must show the
 * card for exactly that, in words that send an iPhone to no other browser. Neither is ever let through as the other:
 * GitHub's Macs are virtual, WebKit hands a virtual Mac a GPU only under its own switch (WebKitAllowWebGPUOnVMs,
 * iphone.yml), and it never hands one to the iOS Simulator, so the Simulator proves the page loads, runs its script
 * and words its card for an iPhone, and Safari on the Mac proves the city draws in WebKit.
 * The host adds one small script to the page it serves (RECORDER): it keeps what the page logged and every uncaught
 * error where the tool can read them, since Safari's driver gives no console. Nothing else of the page is touched.
 * --needs-gpu makes a browser without a working GPU a failure of its own, for a runner known to give one: without it
 * a runner that stopped giving Safari a GPU would quietly turn the check from "the city draws" into "the card shows".
 * It writes report.json and a screenshot per page to --out, prints one line per check, and exits 1 on any failed one.
 *   node tools/browser/safari.mjs --web dist-web --target mac|iphone [--device "iPhone 17 Pro"] [--query "<query>"]...
 *                                 [--out DIR] [--boot-ms 600000] [--port 4444] [--needs-gpu]
 * It needs macOS with Safari's "Allow remote automation" on (`sudo safaridriver --enable` once), and for the iPhone
 * target Xcode with an iOS Simulator runtime. Nothing here reaches any address but this machine.
 * What breaks if it is removed? An iPhone is again something the page is only believed to run on.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** A first-time visitor's own start, without the onboarding's cards and the sound: the device decides everything else. */
export const VISITOR = 'debug&onboarding=0&audio=0'

const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.css': 'text/css; charset=utf-8',
})

/** The probe's own page: nothing on it, so what it measures is the browser. */
const PROBE_PAGE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>probe</title><body>probe</body>'

/**
 * The one script the host adds to the page: Safari's driver hands out no console, so the page keeps its own. Every
 * uncaught error and unhandled rejection goes to __SAFARI__.errors, every console.error and console.warn to
 * __SAFARI__.lines (both capped), and the console itself is left as it was.
 */
export const RECORDER = `<script>(function () {
  var S = window.__SAFARI__ = { errors: [], lines: [] }
  var say = function (v) { try { return String(v && v.stack ? v.stack : v && v.message ? v.message : v).slice(0, 700) } catch (e) { return 'unprintable' } }
  var keep = function (list, text) { if (list.length < 80) list.push(text) }
  window.addEventListener('error', function (e) { keep(S.errors, 'error: ' + say(e.error || e.message) + (e.filename ? ' at ' + e.filename + ':' + e.lineno : '')) })
  window.addEventListener('unhandledrejection', function (e) { keep(S.errors, 'rejection: ' + say(e.reason)) })
  ;['error', 'warn'].forEach(function (level) {
    var was = console[level]
    console[level] = function () {
      try { keep(S.lines, level + ': ' + Array.prototype.map.call(arguments, say).join(' ').slice(0, 900)) } catch (e) { /* the console goes on */ }
      return was.apply(console, arguments)
    }
  })
})()</script>`

/** Pure. A page's HTML with the recorder as its first script: straight after <head>, else in front of everything. */
export function withRecorder(html) {
  const head = /<head[^>]*>/i.exec(html)
  return head ? html.slice(0, head.index + head[0].length) + RECORDER + html.slice(head.index + head[0].length) : RECORDER + html
}

/**
 * Pure. The file a request path names inside `root`, or null for a path that leaves it or names nothing servable
 * ('/' is index.html; a folder is its index.html).
 */
export function fileFor(root, pathname) {
  let path
  try { path = decodeURIComponent(pathname) } catch { return null }
  if (path.includes('\0')) return null
  const base = resolve(root)
  const file = resolve(base, `.${path.startsWith('/') ? path : `/${path}`}`)
  if (file !== base && !file.startsWith(base + sep)) return null
  return path.endsWith('/') || file === base ? join(file, 'index.html') : file
}

/**
 * Serves `root` on 127.0.0.1 as a static host does (no isolation headers, nothing cached), and the probe's page. With
 * `record`, every HTML page goes out with the recorder in its head (withRecorder); every other file byte for byte.
 */
export async function serve(root, { record = false } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/__probe') { res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' }).end(PROBE_PAGE); return }
    const file = fileFor(root, url.pathname)
    let size = -1
    try { const s = file ? statSync(file) : null; if (s?.isFile()) size = s.size } catch { size = -1 }
    if (size < 0) { res.writeHead(404, { 'Content-Type': TYPES['.txt'] }).end('not found'); return }
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
    if (record && type === TYPES['.html']) {
      let body
      try { body = Buffer.from(withRecorder(readFileSync(file, 'utf8'))) } catch { res.writeHead(404, { 'Content-Type': TYPES['.txt'] }).end('not found'); return }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Cache-Control': 'no-store' })
    if (req.method === 'HEAD') { res.end(); return }
    createReadStream(file).pipe(res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

/** A WebDriver session over fetch: the few commands this tool needs. */
export class Driver {
  constructor(base) { this.base = base; this.id = null }
  async call(method, path, body) {
    // A deadline on every call: a driver that hangs must not hold the run past its own timeouts (script and page load
    // are 120 s; a session in a simulator that is still starting takes longer than either).
    const res = await fetch(`${this.base}${path}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(path === '/status' ? 5_000 : 280_000) })
    const text = await res.text()
    let data
    try { data = JSON.parse(text) } catch { throw new Error(`WebDriver ${method} ${path}: ${res.status} ${text.slice(0, 300)}`) }
    if (!res.ok || data?.value?.error) throw new Error(`WebDriver ${method} ${path}: ${data?.value?.error ?? res.status}: ${String(data?.value?.message ?? '').slice(0, 600)}`)
    return data.value
  }
  async start(capabilities) {
    const v = await this.call('POST', '/session', { capabilities: { alwaysMatch: capabilities } })
    this.id = v.sessionId
    return v.capabilities ?? {}
  }
  s(path) { return `/session/${this.id}${path}` }
  timeouts(ms) { return this.call('POST', this.s('/timeouts'), { script: ms, pageLoad: ms }) }
  go(url) { return this.call('POST', this.s('/url'), { url }) }
  rect(width, height) { return this.call('POST', this.s('/window/rect'), { x: 0, y: 0, width, height }) }
  /** A page expression's value (it may be a promise): run as an async script, so a rejection comes back as words. */
  async eval(expression) {
    const script = `const done = arguments[arguments.length - 1]; (async () => (${expression}))().then((v) => done({ ok: v === undefined ? null : v }), (e) => done({ error: String(e && e.stack ? e.stack : e).slice(0, 2000) }))`
    const v = await this.call('POST', this.s('/execute/async'), { script, args: [] })
    if (v && typeof v === 'object' && 'error' in v) throw new Error(`in the page: ${v.error}`)
    return v?.ok ?? null
  }
  async shot(file) {
    const png = await this.call('GET', this.s('/screenshot'))
    writeFileSync(file, Buffer.from(png, 'base64'))
  }
  async quit() {
    if (!this.id) return
    try { await this.call('DELETE', this.s('')) } catch { /* the session is gone already */ }
    this.id = null
  }
}

/**
 * A page expression (async): what this browser offers, on the page and inside a worker. Every step is guarded, so one
 * missing API is one field, never the end of the probe.
 */
export const PROBE = `(async () => {
  const out = {}
  const step = async (name, fn) => { try { out[name] = await fn() } catch (e) { out[name] = { threw: String(e).slice(0, 400) } } }
  const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(what + ' timed out after ' + ms + ' ms')), ms))])
  const limitsOf = (l) => { const o = {}; for (const k in l) { const v = l[k]; if (typeof v === 'number') o[k] = v } return o }
  const infoOf = (a) => { const i = a.info; return i ? { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description } : null }
  out.userAgent = navigator.userAgent
  out.platform = navigator.platform
  out.secure = globalThis.isSecureContext === true
  out.isolated = globalThis.crossOriginIsolated === true
  out.sharedArrayBuffer = typeof SharedArrayBuffer
  out.touchPoints = navigator.maxTouchPoints
  out.cores = navigator.hardwareConcurrency ?? null
  out.deviceMemory = navigator.deviceMemory ?? null
  out.view = { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, screen: [screen.width, screen.height] }
  out.standalone = navigator.standalone ?? null
  out.uaData = typeof navigator.userAgentData
  out.locks = typeof navigator.locks
  out.offscreen = typeof OffscreenCanvas
  out.wasm = typeof WebAssembly
  out.storage = typeof navigator.storage?.getDirectory
  out.serviceWorker = typeof navigator.serviceWorker
  // WebGL's own word for the GPU, where the browser gives one: it says whether any GPU reaches the page at all.
  await step('webgl', () => {
    const canvas = document.createElement('canvas')
    for (const id of ['webgl2', 'webgl']) {
      const gl = canvas.getContext(id)
      if (!gl) continue
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      return { context: id, vendor: gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR), renderer: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) }
    }
    return null
  })
  out.gpu = typeof navigator.gpu
  if (navigator.gpu) {
    await step('format', () => navigator.gpu.getPreferredCanvasFormat())
    await step('wgsl', () => [...(navigator.gpu.wgslLanguageFeatures ?? [])])
    await step('adapter', async () => {
      const a = await withTimeout(navigator.gpu.requestAdapter(), 20000, 'requestAdapter')
      if (!a) return null
      const d = await withTimeout(a.requestDevice(), 20000, 'requestDevice')
      const lost = []
      d.lost.then((l) => lost.push(l.reason + ': ' + l.message))
      // One compute pass, read back: 64 numbers doubled.
      const module = d.createShaderModule({ code: '@group(0) @binding(0) var<storage, read_write> v: array<u32>;\\n@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) { if (id.x < arrayLength(&v)) { v[id.x] = v[id.x] * 2u; } }' })
      const pipeline = await d.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } })
      const buf = d.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST })
      d.queue.writeBuffer(buf, 0, new Uint32Array(64).map((_, i) => i))
      const read = d.createBuffer({ size: 256, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
      const enc = d.createCommandEncoder()
      const pass = enc.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] }))
      pass.dispatchWorkgroups(1)
      pass.end()
      enc.copyBufferToBuffer(buf, 0, read, 0, 256)
      d.queue.submit([enc.finish()])
      await withTimeout(read.mapAsync(GPUMapMode.READ), 20000, 'mapAsync')
      const got = new Uint32Array(read.getMappedRange().slice(0))
      read.unmap()
      const computed = got.every((x, i) => x === i * 2)
      const r = { info: infoOf(a), fallback: a.isFallbackAdapter ?? null, features: [...a.features].sort(), limits: limitsOf(a.limits), computed, lost }
      d.destroy()
      return r
    })
  }
  const WORKER = 'onmessage = async () => { const o = { gpu: typeof navigator.gpu, offscreen: typeof OffscreenCanvas, sharedArrayBuffer: typeof SharedArrayBuffer, wasm: typeof WebAssembly, cores: navigator.hardwareConcurrency ?? null }; try { if (navigator.gpu) { const a = await navigator.gpu.requestAdapter(); o.adapter = !!a; if (a) { const i = a.info; o.info = i ? { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description } : null; const d = await a.requestDevice(); o.device = !!d; o.maxStorageBuffersPerShaderStage = d.limits.maxStorageBuffersPerShaderStage; d.destroy() } } } catch (e) { o.threw = String(e).slice(0, 400) } postMessage(o) }'
  const inWorker = (options) => withTimeout(new Promise((yes, no) => {
    const w = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })), options)
    w.onmessage = (e) => { yes(e.data); w.terminate() }
    w.onerror = (e) => { no(new Error(e.message || 'the worker failed to start')); w.terminate() }
    w.postMessage(0)
  }), 30000, 'the worker')
  await step('worker', () => inWorker(undefined))
  await step('moduleWorker', () => inWorker({ type: 'module' }))
  return out
})()`

/**
 * A page expression: where the city's start stands. `card` is the recovery card (its kind, its words, and the two
 * lines under Details: what was thrown, and the build, adapter and user agent), `running` the engine's own numbers
 * once ?debug has put __SIM__ on the page, `veil` the boot veil's words while it is up, `bootDone` whether the page's
 * script ran to its end (main.tsx), `pageErrors` and `lines` what the recorder kept. Guarded throughout: the page may
 * be between two documents.
 */
export const STATE = `(() => {
  const text = (el) => (el ? String(el.innerText ?? el.textContent ?? '').replace(/\\s+/g, ' ').trim() : null)
  const card = document.querySelector('[data-failure]')
  const veil = document.querySelector('.boot-veil')
  const S = globalThis.__SIM__
  const R = globalThis.__SAFARI__
  let running = null
  if (S) {
    try {
      const s = S.snapshot()
      running = {
        fps: s.output?.fps ?? null, crowdFrames: s.process?.crowdFrames ?? null, quality: s.quality ?? null, gpu: s.process?.gpu ?? null,
        device: s.supplier?.device ?? null, touch: s.supplier?.touch ?? null, pedestrians: s.process?.pedestrians ?? null, vehicles: s.process?.vehicles ?? null,
        sensingAgeMs: s.process?.sensingAgeMs ?? null, errors: (S.errors?.() ?? []).slice(0, 8).map((e) => String(e).slice(0, 400)),
      }
    } catch (e) { running = { threw: String(e).slice(0, 400) } }
  }
  // Under Details the card keeps what was thrown and its copyable line; closed, they are in the document all the same.
  const details = card ? [...card.querySelectorAll('details p')].map((p) => String(p.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 1500)) : []
  return {
    ready: document.readyState, href: location.href, isolated: globalThis.crossOriginIsolated === true,
    card: card ? { kind: card.getAttribute('data-failure'), text: text(card).slice(0, 3000), detail: details[0] ?? null, line: details[1] ?? null } : null,
    veil: veil ? text(veil).slice(0, 400) : null, running,
    bootDone: globalThis.__bootDone === true,
    pageErrors: R ? R.errors.slice(0, 20) : [], lines: R ? R.lines.slice(0, 40) : [],
    body: card || running ? null : text(document.body).slice(0, 600),
  }
})()`

/** Pure. Whether a STATE is the city running: frames drawn and the crowd's own step advancing past `crowdFrom`. */
export function isRunning(state, crowdFrom = 0) {
  const r = state?.running
  return Boolean(r) && typeof r.fps === 'number' && r.fps > 0 && typeof r.crowdFrames === 'number' && r.crowdFrames > crowdFrom
}

/**
 * Pure. What the page owes a browser, by what the probe found in it. A working GPU on the page and inside a worker:
 * the city runs. WebGPU there and no adapter: the no-adapter card. No WebGPU at all: the no-api card. WebGPU on the
 * page and none, or no device, inside a worker: the worker card. A probe that threw part way: some card, whichever.
 */
export function expected(target, probe) {
  if (probe?.gpu !== 'object') return { outcome: 'card', kind: 'no-api', why: 'this browser has no WebGPU (navigator.gpu)' }
  const adapter = probe.adapter
  if (!adapter) return { outcome: 'card', kind: 'no-adapter', why: 'this browser has WebGPU and gave the page no adapter' }
  if (adapter.threw || adapter.computed !== true) return { outcome: 'card', kind: null, why: `this browser's WebGPU failed the probe: ${adapter.threw ?? 'the compute pass read back wrong'}` }
  if (probe.worker?.gpu !== 'object' || probe.worker.device !== true) return { outcome: 'card', kind: 'worker-gpu', why: 'this browser has WebGPU on the page and no device inside a worker' }
  return { outcome: 'running', kind: null, why: `this browser has a GPU for WebGPU on the page and in a worker (${JSON.stringify(adapter.info)})` }
}

/** What an iPhone's card must say of WebGPU, and what it must never say: every browser there is Safari's engine. */
const IPHONE_SAYS = /which an iP(?:hone|ad) has from iP?(?:ad)?OS 26 on\. Chrome and the other browsers on an iP(?:hone|ad) are built on Safari’s engine, so another browser does not add it\./
const SENDS_ELSEWHERE = /a current Chrome|Edge or Brave|Chrome or Edge|in Chrome\b|Play Store|WebView2/

/**
 * Pure. The checks one page of the city passes or fails, given what the probe found (expected) and how the page
 * ended (`page`: its outcome, and STATE at the end). Each is { ok, what, detail }.
 */
export function judge(target, probe, page) {
  const want = expected(target, probe)
  const end = page?.end ?? {}
  const name = `?${page?.query ?? ''}`
  const checks = []
  const check = (ok, what, detail = '') => { checks.push({ ok: Boolean(ok), what, detail: String(detail).slice(0, 1200) }) }
  const card = end.card ?? null
  const r = end.running ?? null
  const after = `after ${Math.round((page?.ms ?? 0) / 1000)} s`
  const got = page?.outcome === 'running' ? `the city runs, ${after}`
    : page?.outcome === 'card' ? `the ${card?.kind} card: ${card?.text ?? ''}${card?.detail ? ` [details: ${card.detail}]` : ''}`
      : `still starting ${after}: ${JSON.stringify({ veil: end.veil ?? null, body: end.body ?? null, threw: end.threw ?? null })}`
  if (want.outcome === 'running') {
    check(page?.outcome === 'running', `${name}: the city runs (${want.why})`, page?.outcome === 'running'
      ? `${Math.round((r?.fps ?? 0) * 10) / 10} fps, ${r?.pedestrians ?? '?'} people, ${r?.vehicles ?? '?'} cars, ${r?.device ?? '?'} input, GPU ${JSON.stringify(r?.gpu ?? null)}, quality ${JSON.stringify(r?.quality ?? null).slice(0, 300)}, ${after}`
      : got)
    if (page?.outcome === 'running') check((r?.errors ?? []).length === 0, `${name}: no engine error`, (r?.errors ?? []).join(' | '))
  } else {
    const right = page?.outcome === 'card' && (want.kind === null || card?.kind === want.kind)
    check(right, `${name}: the ${want.kind ?? 'recovery'} card, since ${want.why}`, got)
    if (right && target === 'iphone') {
      check(!SENDS_ELSEWHERE.test(card.text) && (want.kind === 'worker-gpu' || IPHONE_SAYS.test(card.text)), `${name}: the card sends an iPhone to no other browser, and says what brings WebGPU`, card.text)
    }
    if (right && target === 'mac' && want.kind === 'no-api') {
      check(/Safari turns WebGPU on from macOS 26/.test(card.text) && !/turned off in Safari/.test(card.text), `${name}: a Mac with no WebGPU in Safari is told macOS 26 brings it`, card.text)
    }
  }
  check(end.bootDone === true, `${name}: the page’s script ran to its end`, `__bootDone ${end.bootDone}`)
  check((end.pageErrors ?? []).length === 0, `${name}: no uncaught error on the page`, (end.pageErrors ?? []).join(' | '))
  return checks
}

/**
 * Pure. The iPhone to use among `xcrun simctl list devices available -j`'s devices: the one named, else an iPhone of
 * the newest iOS runtime (a Pro before a plain one, the highest number first). Null when there is none.
 */
export function pickIphone(listing, named = '') {
  const found = []
  for (const [runtime, devices] of Object.entries(listing?.devices ?? {})) {
    const m = /iOS-(\d+)(?:-(\d+))?(?:-(\d+))?$/.exec(runtime)
    if (!m) continue
    const version = [m[1], m[2] ?? '0', m[3] ?? '0'].map(Number)
    for (const d of devices ?? []) {
      if (d?.isAvailable === false || typeof d?.name !== 'string' || typeof d?.udid !== 'string' || !/^iPhone/.test(d.name)) continue
      found.push({ name: d.name, udid: d.udid, state: d.state ?? '', version, ios: version.join('.').replace(/(\.0)+$/, '') })
    }
  }
  const wanted = named ? found.filter((d) => d.name === named) : found
  const model = (d) => Number(/iPhone (\d+)/.exec(d.name)?.[1] ?? 0)
  const rank = (d) => (/Pro Max/.test(d.name) ? 1 : /Pro/.test(d.name) ? 2 : 0)
  wanted.sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1] || b.version[2] - a.version[2] || model(b) - model(a) || rank(b) - rank(a) || a.name.localeCompare(b.name))
  return wanted[0] ?? null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** How long safaridriver gets to start listening, ms. */
const DRIVER_UP_MS = 180_000

function run(cmd, args, { ms = 600_000 } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: ms, maxBuffer: 64 * 2 ** 20 })
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '') + (r.error ? r.error.message : '') }
}

async function main() {
  const argv = process.argv.slice(2)
  const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
  const all = (name) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] !== undefined ? [argv[i + 1]] : []))
  const flag = (name) => argv.includes(`--${name}`)
  if (flag('help')) {
    console.log('usage: node tools/browser/safari.mjs --web dist-web --target mac|iphone [--device NAME] [--query QUERY]... [--out DIR] [--boot-ms MS] [--port 4444] [--needs-gpu]')
    return 0
  }
  const web = resolve(arg('web') ?? 'dist-web')
  const target = arg('target') ?? 'mac'
  const out = resolve(arg('out') ?? 'safari-out')
  const bootMs = Number(arg('boot-ms') ?? 600_000)
  const port = Number(arg('port') ?? 4444)
  const queries = all('query').length ? all('query') : [VISITOR]
  if (!['mac', 'iphone'].includes(target)) { console.error(`safari: no target named ${target} (mac or iphone)`); return 2 }
  if (!existsSync(join(web, 'index.html'))) { console.error(`safari: no index.html in ${web} (npm run build:web makes dist-web/)`); return 2 }
  mkdirSync(out, { recursive: true })

  const report = { target, web, queries, checks: [], pages: [] }
  let failed = 0
  const check = (ok, what, detail = '') => {
    report.checks.push({ ok, what, detail })
    if (!ok) failed++
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`)
    return ok
  }
  const save = () => writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

  const capabilities = { browserName: 'safari' }
  if (target === 'iphone') {
    const listed = run('xcrun', ['simctl', 'list', 'devices', 'available', '-j'])
    let listing = null
    try { listing = JSON.parse(listed.out) } catch { listing = null }
    const phone = pickIphone(listing, arg('device') ?? '')
    if (!phone) {
      check(false, `iphone: an iPhone in the iOS Simulator${arg('device') ? ` named ${arg('device')}` : ''}`, (listed.err || 'none is installed with this Xcode').trim().slice(0, 300))
      save()
      return 1
    }
    report.simulator = phone
    console.log(`iphone: ${phone.name}, iOS ${phone.ios} (${phone.udid})`)
    if (phone.state !== 'Booted') run('xcrun', ['simctl', 'boot', phone.udid])
    const up = run('xcrun', ['simctl', 'bootstatus', phone.udid, '-b'], { ms: 900_000 })
    check(up.ok, 'iphone: the simulator started', up.ok ? `${phone.name}, iOS ${phone.ios}` : up.err.trim().slice(-300))
    Object.assign(capabilities, { platformName: 'iOS', 'safari:useSimulator': true, 'safari:deviceUDID': phone.udid })
  }

  const host = await serve(web, { record: true })
  const driverProcess = spawn('safaridriver', ['--port', String(port)], { stdio: ['ignore', 'inherit', 'inherit'] })
  let driverGone = null
  driverProcess.on('exit', (code) => { driverGone = code ?? -1 })
  driverProcess.on('error', (e) => { driverGone = e.message })
  const driver = new Driver(`http://127.0.0.1:${port}`)
  try {
    // The driver answers /status once it listens. Beside a simulator that has just started, on a Mac still busy with
    // it, that has taken most of a minute: three minutes are allowed, by the clock and not by the count of tries.
    let listening = false
    const asked = Date.now()
    while (!listening && driverGone === null && Date.now() - asked < DRIVER_UP_MS) {
      try { await driver.call('GET', '/status'); listening = true } catch { await sleep(500) }
    }
    const took = `${Math.round((Date.now() - asked) / 1000)} s`
    if (!check(listening, `${target}: safaridriver listens`, listening ? `after ${took}` : `it ${driverGone === null ? `never answered in ${took}` : `stopped (${driverGone})`}; sudo safaridriver --enable turns remote automation on`)) { save(); return 1 }

    let session = null
    let why = ''
    // A simulator that has just started can refuse its first session: a few tries, a pause between them.
    for (let i = 0; i < 4 && !session; i++) {
      try { session = await driver.start(capabilities) } catch (e) { why = e.message; await sleep(15_000) }
    }
    if (!check(Boolean(session), `${target}: a Safari session`, session ? `${session.browserName ?? 'safari'} ${session.browserVersion ?? ''} on ${session.platformName ?? '?'}`.trim() : why.slice(0, 500))) { save(); return 1 }
    report.session = session
    await driver.timeouts(120_000)
    if (target === 'mac') await driver.rect(1280, 800).catch(() => {})

    // What the browser offers.
    await driver.go(`${host.origin}/__probe`)
    let probe = null
    try { probe = await driver.eval(PROBE) } catch (e) { probe = { threw: e.message } }
    report.probe = probe
    console.log(`${target}: probe ${JSON.stringify(probe)}`)
    check(probe?.secure === true, `${target}: the page is a secure context`, `isSecureContext ${probe?.secure}`)
    // What the probe found is reported, not judged: a Mac that gives Safari no GPU is this runner, not the page.
    const adapter = probe?.adapter
    const want = expected(target, probe)
    report.expected = want
    console.log(`${target}: WebGPU on the page: ${probe?.gpu === 'object' ? 'yes' : 'no'}; adapter: ${adapter ? (adapter.threw ?? JSON.stringify(adapter.info)) : 'none'}; compute pass: ${adapter?.computed === true ? 'read back right' : 'not run'}; in a worker: ${JSON.stringify(probe?.worker ?? null).slice(0, 300)}`)
    console.log(`${target}: so the page owes ${want.outcome === 'running' ? 'a running city' : `the ${want.kind ?? 'recovery'} card`}: ${want.why}`)
    if (flag('needs-gpu')) check(want.outcome === 'running', `${target}: this browser has a GPU for WebGPU, as this runner is expected to give it`, want.why)

    // The city, once per query.
    for (const query of queries) {
      const name = `${target}-${queries.indexOf(query) + 1}`
      const page = { query, timeline: [], end: null, ms: 0 }
      report.pages.push(page)
      const t0 = Date.now()
      await driver.go(`${host.origin}/?${query}`)
      let last = ''
      let state = null
      let crowdFrom = null
      let outcome = 'timeout'
      while (Date.now() - t0 < bootMs) {
        try { state = await driver.eval(STATE) } catch (e) { state = { threw: e.message.slice(0, 300) } }
        // A new line only when the start moved on: the card, the veil's words, the engine there or not, the page's own words.
        const stage = JSON.stringify({ card: state?.card?.kind ?? null, veil: state?.veil ?? null, running: Boolean(state?.running), drawing: (state?.running?.fps ?? 0) > 0, body: state?.body ?? null, threw: state?.threw ?? null })
        if (stage !== last) { page.timeline.push({ ms: Date.now() - t0, state }); console.log(`${name}: +${Math.round((Date.now() - t0) / 1000)} s ${JSON.stringify(state).slice(0, 900)}`); last = stage }
        if (state?.card) { outcome = 'card'; break }
        if (state?.running && typeof state.running.crowdFrames === 'number') {
          if (crowdFrom === null && state.running.fps > 0) crowdFrom = state.running.crowdFrames
          else if (crowdFrom !== null && isRunning(state, crowdFrom + 2) && !state.veil) { outcome = 'running'; break }
        }
        await sleep(3000)
      }
      page.ms = Date.now() - t0
      page.end = state
      page.outcome = outcome
      await driver.shot(join(out, `${name}.png`)).catch((e) => console.log(`${name}: no screenshot (${e.message.slice(0, 200)})`))
      if (state?.card) console.log(`${name}: the card's details: ${state.card.detail ?? 'none'} | ${state.card.line ?? ''}`)
      for (const line of state?.lines ?? []) console.log(`${name}: console ${line}`)
      for (const c of judge(target, probe, page)) check(c.ok, `${name} ${c.what}`, c.detail)
    }
  } catch (e) {
    check(false, `${target}: the run`, String(e?.stack ?? e).slice(0, 800))
  } finally {
    await driver.quit()
    driverProcess.kill()
    host.server.close()
    host.server.closeAllConnections?.()
    save()
  }
  console.log(failed === 0 ? `safari (${target}): every check passed` : `safari (${target}): ${failed} check${failed === 1 ? '' : 's'} failed`)
  return failed === 0 ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code }, (e) => { console.error(e); process.exitCode = 1 })
}
