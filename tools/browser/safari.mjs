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
 * and words its card for an iPhone, and Safari on the Mac is the one place here where the city can draw in WebKit.
 * Where the browser gave an adapter the probe also draws (LADDER): one small experiment per kind of work the city's
 * renderer asks of a GPU, each on a device of its own, which is a check of its own. --part splits the two, for a
 * runner whose GPU one of them can take down for the other: `--part city` leaves the ladder out, so the city's start
 * is the first real work the GPU is given, and `--part drawing` runs the probe with its ladder and opens no city.
 * The host adds one small script to the page it serves (RECORDER): it keeps what the page logged and every uncaught
 * error where the tool can read them, since Safari's driver gives no console. Nothing else of the page is touched.
 * --trace adds a second (TRACE): it notes the WebGPU calls of the page and of its workers, and a start that does not
 * end in a running city prints the last of them, with each device's errors and its loss. WebKit reports a lost
 * device with no words at all, so the calls just before it are the only account there is.
 * --needs-gpu makes a browser without a working GPU a failure of its own, for a runner known to give one: without it
 * a runner that stopped giving Safari a GPU would quietly turn the check from "the city draws" into "the card shows".
 * --fresh-safari (the Mac target) quits Safari before each page and starts it again, so a page starts in a browser
 * and a GPU process that nothing has touched, the probe included: for a runner, since it quits the Safari of the Mac.
 * --virtual-gpu is for a Mac whose GPU is a virtual one, a hosted runner's. There the Mac's kernel can find that GPU
 * hung, restart it and refuse the browser's GPU process everything after, and WebKit turns that into a lost device
 * with no words. hangOf reads the kernel's own lines for it from the system log, and what such a hang took, the
 * drawing or the city, is then reported as NOT JUDGED: never as passed, never as the page's failure, with when the
 * hang came and during what. The page must still be left with words and a way on. It excuses nothing on a Mac that
 * says it is no virtual machine (kern.hv_vmm_present), and nothing the kernel did not write down.
 * On a Mac, a run with a failed check ends with the system's own account (evidence): the crash reports WebKit's
 * processes left since the run began, and what the system logged about Safari's GPU process, each kind of line once
 * and in the order it first came (a failed Metal command buffer, an exit, a crash, memory pressure).
 * It writes report.json and a screenshot per page to --out, prints one line per check, and exits 1 on any failed one;
 * under GitHub Actions the checks are also the job's summary, and one not judged is a warning on the run.
 *   node tools/browser/safari.mjs --web dist-web --target mac|iphone [--device "iPhone 17 Pro"] [--query "<query>"]...
 *                                 [--out DIR] [--boot-ms 600000] [--port 4444] [--needs-gpu] [--trace] [--fresh-safari]
 *                                 [--virtual-gpu] [--part city|drawing]
 * It needs macOS with Safari's "Allow remote automation" on (`sudo safaridriver --enable` once), and for the iPhone
 * target Xcode with an iOS Simulator runtime. Nothing here reaches any address but this machine.
 * What breaks if it is removed? An iPhone is again something the page is only believed to run on.
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
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

/**
 * What runs in the page, and again inside each worker the page starts, under --trace: every WebGPU call that can end
 * a device is noted with its time and the few arguments that matter (a draw's counts, a pipeline's label, a buffer's
 * size), the last few hundred kept, and the list frozen the moment a device is lost. A device also reports its
 * uncaptured errors and its loss. So when Safari takes the device away, which WebKit reports with no words at all,
 * the report names the calls that came just before. `say(kind, text)` is where a note goes: the page's own list, or
 * from a worker its own postMessage, which the page takes the notes off.
 */
const TRACER = `function (say, epoch) {
  var G = typeof globalThis !== 'undefined' ? globalThis : self
  var t0 = epoch || Date.now()
  // When this thread last ran a timer: a loss is only heard once the thread is free, so this bounds when it happened.
  var free = 0
  try { setInterval(function () { free = Date.now() - t0 }, 20) } catch (e) { /* no timers: no bound */ }
  var brief = function (v) { try { return JSON.stringify(v, function (k, x) { return typeof x === 'string' && x.length > 80 ? x.slice(0, 80) + '...(' + x.length + ')' : typeof x === 'object' && x !== null && x.constructor && /^GPU/.test(x.constructor.name) ? '<' + x.constructor.name.slice(3) + (x.label ? ' ' + x.label : '') + '>' : ArrayBuffer.isView(x) || x instanceof ArrayBuffer ? '<' + x.byteLength + ' bytes>' : x }).slice(0, 260) } catch (e) { return '?' } }
  var note = function (name, args) { say('call', (Date.now() - t0) + ' ' + name + (args === undefined ? '' : ' ' + args)) }
  var wrap = function (ctor, name, describe) {
    var proto = G[ctor] && G[ctor].prototype
    if (!proto || typeof proto[name] !== 'function') return
    var was = proto[name]
    proto[name] = function () {
      try { note(ctor.slice(3) + '.' + name + (this && this.label ? '[' + this.label + ']' : ''), describe ? describe.apply(this, arguments) : brief(Array.prototype.slice.call(arguments))) } catch (e) { /* the call goes on */ }
      return was.apply(this, arguments)
    }
  }
  var watch = function (device) {
    try {
      var label = device.label || '(no label)'
      device.lost.then(function (l) { say('lost', (Date.now() - t0) + ' device ' + label + ' lost: reason ' + l.reason + ', message ' + JSON.stringify(l.message) + ' (heard now; this thread was last free at ' + free + ')') })
      device.addEventListener('uncapturederror', function (e) { say('error', (Date.now() - t0) + ' device ' + label + ': ' + String(e.error && e.error.message).slice(0, 600)) })
    } catch (e) { say('error', 'could not watch a device: ' + e) }
  }
  var adapterProto = G.GPUAdapter && G.GPUAdapter.prototype
  if (adapterProto && typeof adapterProto.requestDevice === 'function') {
    var request = adapterProto.requestDevice
    adapterProto.requestDevice = function (d) {
      note('Adapter.requestDevice', brief(d))
      return request.apply(this, arguments).then(function (device) { watch(device); note('  a device arrived', brief({ label: device.label })); return device })
    }
  }
  wrap('GPU', 'requestAdapter')
  // What a device said no to and the page caught in an error scope, and what a shader's compiler said: neither is an
  // uncaptured error, and either can be the refusal a later draw trips over.
  var deviceProto = G.GPUDevice && G.GPUDevice.prototype
  if (deviceProto && typeof deviceProto.popErrorScope === 'function') {
    var pop = deviceProto.popErrorScope
    deviceProto.popErrorScope = function () {
      var label = this.label || '(no label)'
      var result = pop.apply(this, arguments)
      try { result.then(function (e) { if (e) say('error', (Date.now() - t0) + ' device ' + label + ', caught in a scope: ' + String(e.message).slice(0, 600)) }, function () {}) } catch (e) { /* the call goes on */ }
      return result
    }
  }
  if (deviceProto && typeof deviceProto.createShaderModule === 'function') {
    var shader = deviceProto.createShaderModule
    deviceProto.createShaderModule = function (d) {
      var label = (d && d.label) || '(no label)'
      var module = shader.apply(this, arguments)
      try { module.getCompilationInfo().then(function (info) { for (var i = 0; i < info.messages.length && i < 4; i++) { var m = info.messages[i]; if (m.type === 'error') say('error', (Date.now() - t0) + ' shader ' + label + ' (' + (d && d.code && d.code.length) + ' chars), line ' + m.lineNum + ': ' + String(m.message).slice(0, 400)) } }, function () {}) } catch (e) { /* the call goes on */ }
      return module
    }
  }
  var count = function (list) { return String(list && list.length) }
  ;['destroy', 'createShaderModule', 'createRenderPipeline', 'createRenderPipelineAsync', 'createComputePipeline', 'createComputePipelineAsync', 'createBindGroup', 'createBindGroupLayout', 'createPipelineLayout', 'createBuffer', 'createTexture', 'createQuerySet', 'pushErrorScope', 'popErrorScope', 'importExternalTexture'].forEach(function (name) {
    wrap('GPUDevice', name, function (d) {
      if (name === 'createShaderModule') return brief({ label: d && d.label, chars: d && d.code && d.code.length })
      if (/Pipeline/.test(name) && name !== 'createPipelineLayout') return brief({ label: d && d.label, layout: d && d.layout === 'auto' ? 'auto' : 'given', vertex: d && d.vertex && d.vertex.entryPoint, fragment: d && d.fragment && { entry: d.fragment.entryPoint, targets: d.fragment.targets && d.fragment.targets.map(function (t) { return t && t.format }) }, compute: d && d.compute && d.compute.entryPoint, depth: d && d.depthStencil && d.depthStencil.format, samples: d && d.multisample && d.multisample.count, topology: d && d.primitive && d.primitive.topology })
      if (name === 'createBindGroup') return brief({ label: d && d.label, entries: d && d.entries && d.entries.length })
      return d === undefined ? '' : brief(d)
    })
  })
  wrap('GPUQueue', 'submit', count)
  wrap('GPUQueue', 'onSubmittedWorkDone')
  wrap('GPUQueue', 'writeTexture', function (dest, data, layout, size) { return brief([dest, size]) })
  wrap('GPUQueue', 'copyExternalImageToTexture', function (src, dest, size) { return brief([dest, size]) })
  wrap('GPUQueue', 'writeBuffer', function (buffer, offset, data, at, size) { return brief([buffer, offset, data && data.byteLength, size]) })
  ;['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect', 'setPipeline', 'setVertexBuffer', 'setIndexBuffer', 'executeBundles', 'end'].forEach(function (name) { wrap('GPURenderPassEncoder', name) })
  ;['dispatchWorkgroups', 'dispatchWorkgroupsIndirect', 'setPipeline', 'end'].forEach(function (name) { wrap('GPUComputePassEncoder', name) })
  wrap('GPUCommandEncoder', 'beginRenderPass', function (d) { return brief({ label: d && d.label, color: d && d.colorAttachments && Array.prototype.map.call(d.colorAttachments, function (a) { return a && { view: a.view, resolve: a.resolveTarget, load: a.loadOp, store: a.storeOp } }), depth: d && d.depthStencilAttachment && { view: d.depthStencilAttachment.view }, occlusion: d && d.occlusionQuerySet ? true : undefined, timestamps: d && d.timestampWrites ? true : undefined }) })
  ;['beginComputePass', 'copyBufferToBuffer', 'copyTextureToTexture', 'copyBufferToTexture', 'copyTextureToBuffer', 'resolveQuerySet', 'clearBuffer', 'finish'].forEach(function (name) { wrap('GPUCommandEncoder', name) })
  wrap('GPUCanvasContext', 'configure', function (d) { return brief({ format: d && d.format, usage: d && d.usage, alphaMode: d && d.alphaMode, toneMapping: d && d.toneMapping, viewFormats: d && d.viewFormats }) })
  wrap('GPUCanvasContext', 'unconfigure')
  wrap('GPUBuffer', 'mapAsync', function (mode, offset, size) { return brief([mode, offset, size]) })
  wrap('GPUBuffer', 'destroy')
  wrap('GPUTexture', 'destroy')
  wrap('GPUTexture', 'createView', function (d) { return d === undefined ? '' : brief(d) })
  // What else of this thread lives in the browser's GPU process: the contexts of its canvases (the first forty).
  var others = 0
  ;['HTMLCanvasElement', 'OffscreenCanvas'].forEach(function (ctor) {
    var proto = G[ctor] && G[ctor].prototype
    if (!proto || typeof proto.getContext !== 'function') return
    var was = proto.getContext
    proto.getContext = function (kind) {
      var got = was.apply(this, arguments)
      try { if (others++ < 40) note(ctor + '.getContext', brief({ kind: kind, width: this.width, height: this.height, got: got ? true : false })) } catch (e) { /* the call goes on */ }
      return got
    }
  })
}`

/**
 * The script --trace adds after the recorder: the tracer in the page, keeping its notes on __SAFARI__.gpu, and the
 * same tracer put in front of each worker the page starts from a Blob (the city's crowd runs its own GPU device in
 * one), whose notes come back over the worker's own postMessage, marked, and never reach the page's listeners. A
 * page whose worker cannot be given the tracer starts it as it would have: the trace never decides whether the city
 * runs.
 */
export const TRACE = `<script>(function () {
  var S = window.__SAFARI__ = window.__SAFARI__ || { errors: [], lines: [] }
  var T0 = Date.now()
  var T = S.gpu = { calls: [], key: [], worker: [], lost: [], errors: [], total: 0, frozen: false, workers: 0, epoch: T0 }
  // A frame is hundreds of buffer writes and bindings: they stay in the short list of everything (calls), and out of
  // the longer list of what can end a device (key: devices, pipelines, passes, draws, dispatches, submits, readbacks).
  var routine = /^\\d+ (?:Queue\\.writeBuffer|RenderPassEncoder\\.set|ComputePassEncoder\\.set|Device\\.createBindGroup\\b|Texture\\.createView|Device\\.pushErrorScope|Device\\.popErrorScope)/
  var say = function (where) { return function (kind, text) {
    if (kind === 'call') {
      T.total++
      // A worker's notes arrive when the page is free to hear them, which can be after a loss they came before: its
      // first calls are kept apart, on the page's clock, whatever the page has heard since.
      if (where && T.worker.length < 80) T.worker.push(text)
      if (T.frozen) return
      if (T.calls.length >= 120) T.calls.shift()
      T.calls.push(where + text)
      if (!routine.test(text)) { if (T.key.length >= 500) T.key.shift(); T.key.push(where + text) }
      return
    }
    if (kind === 'lost') { T.lost.push(where + text); T.frozen = true; return }
    if (T.errors.length < 40) T.errors.push(where + text)
  } }
  var tracer = ${TRACER}
  try { tracer(say(''), T0) } catch (e) { T.errors.push('the tracer did not start: ' + e) }
  try {
    var fromWorker = say('worker: ')
    var blobs = new Map()
    var make = URL.createObjectURL
    URL.createObjectURL = function (b) { var url = make.apply(URL, arguments); try { if (b instanceof Blob) blobs.set(url, b) } catch (e) { /* as it was */ } return url }
    var Real = window.Worker
    // A worker's notes come back over its own postMessage, marked, and are taken off before the page's listeners run.
    var prelude = '(function () { var post = self.postMessage.bind(self); var say = function (kind, text) { try { post({ __safariTrace__: String(kind), text: String(text) }) } catch (e) {} }; try { (' + tracer.toString() + ')(say, ' + T0 + '); say("call", (Date.now() - ' + T0 + ') + " this worker runs (WebGPU in it: " + typeof (self.navigator && self.navigator.gpu) + ")") } catch (e) { say("error", "the tracer did not start in a worker: " + e) } })();\\n'
    window.Worker = function (url, options) {
      var blob = blobs.get(String(url))
      if (blob && (!options || options.type !== 'module')) {
        try {
          var worker = new Real(make.call(URL, new Blob([prelude, blob], { type: blob.type || 'text/javascript' })), options)
          T.workers++
          if (T.key.length < 500 && !T.frozen) T.key.push((Date.now() - T0) + ' a worker is started (' + blob.size + ' bytes)')
          worker.addEventListener('message', function (e) { var d = e.data; if (d && typeof d.__safariTrace__ === 'string') { e.stopImmediatePropagation(); fromWorker(d.__safariTrace__, String(d.text)) } })
          worker.addEventListener('error', function (e) { if (T.errors.length < 40) T.errors.push((Date.now() - T0) + ' a worker failed: ' + String(e && e.message).slice(0, 300)) })
          return worker
        } catch (e) { T.errors.push('a worker started without the tracer: ' + e) }
      }
      return new Real(url, options)
    }
    window.Worker.prototype = Real.prototype
    var end = Real.prototype.terminate
    Real.prototype.terminate = function () { try { if (T.key.length < 500) T.key.push((Date.now() - T0) + ' a worker is ended by the page') } catch (e) { /* the call goes on */ } return end.apply(this, arguments) }
  } catch (e) { T.errors.push('workers are not traced: ' + e) }
})()</script>`

/**
 * Pure. A page's HTML with the recorder as its first script (and the tracer after it, with `trace`): straight after
 * <head>, else in front of everything.
 */
export function withRecorder(html, trace = false) {
  const added = RECORDER + (trace ? TRACE : '')
  const head = /<head[^>]*>/i.exec(html)
  return head ? html.slice(0, head.index + head[0].length) + added + html.slice(head.index + head[0].length) : added + html
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
export async function serve(root, { record = false, trace = false } = {}) {
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
      try { body = Buffer.from(withRecorder(readFileSync(file, 'utf8'), trace)) } catch { res.writeHead(404, { 'Content-Type': TYPES['.txt'] }).end('not found'); return }
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
 * What runs inside the probe when the browser gave an adapter: one small drawing experiment per kind of work the
 * city's renderer asks of a GPU, each on a device of its own, so that a browser which drops the device on one of them
 * says which. Each waits for its work to be done, reads a pixel back where there is one, and reports what came and
 * when, by this machine's clock: `{ ok, pixel, lost, errors, began, ended }`. WebKit reports a lost device with no words, so this is how the check learns whether
 * a browser can draw at all (clear, draw), through a render bundle (bundle), three's own mipmap pass (mips, and
 * mipsDirect: the same passes with the draws made directly), an indirect indexed draw from a vertex buffer
 * (indirect), into a multisampled float target with depth (msaa), and onto a canvas (canvas); then the city's own
 * start a piece at a time: a texture whose edge is no power of two (npot), the four noise textures the renderer
 * uploads first (fourMips), the adapter asked for as the city asks (power), the device with the features three asks
 * for (features), all of that together under the page's label (cityStart), a device left alone (idle), and a device
 * beside a worker's own (besideWorker).
 */
export const LADDER = `async (withTimeout) => {
  const U = GPUTextureUsage, B = GPUBufferUsage
  const TRI = '@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array(vec2f(-1, -1), vec2f(-1, 3), vec2f(3, -1)); return vec4f(p[i], 0, 1); } @fragment fn fs() -> @location(0) vec4f { return vec4f(0, 1, 0, 1); }'
  const MIP = 'struct V { @builtin(position) Position: vec4f, @location(0) vTex: vec2f, @location(1) @interpolate(flat, either) vBaseArrayLayer: u32 }; @group(0) @binding(2) var<uniform> flipY: u32; @vertex fn mainVS(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> V { var out: V; var pos = array(vec2f(-1, -1), vec2f(-1, 3), vec2f(3, -1)); let p = pos[vertexIndex]; let mult = select(vec2f(0.5, -0.5), vec2f(0.5, 0.5), flipY != 0); out.vTex = p * mult + vec2f(0.5); out.Position = vec4f(p, 0, 1); out.vBaseArrayLayer = instanceIndex; return out; } @group(0) @binding(0) var imgSampler: sampler; @group(0) @binding(1) var img2dArray: texture_2d_array<f32>; @fragment fn main_2d_array(v: V) -> @location(0) vec4<f32> { return textureSample(img2dArray, imgSampler, v.vTex, v.vBaseArrayLayer); }'
  const BUF = 'struct A { @location(0) p: vec2f }; @vertex fn vs(a: A) -> @builtin(position) vec4f { return vec4f(a.p, 0, 1); } @fragment fn fs() -> @location(0) vec4f { return vec4f(0, 1, 0, 1); }'
  const pixelOf = async (d, texture, mipLevel, bytes) => {
    const read = d.createBuffer({ size: 256, usage: B.MAP_READ | B.COPY_DST })
    const e = d.createCommandEncoder()
    e.copyTextureToBuffer({ texture, mipLevel: mipLevel || 0 }, { buffer: read, bytesPerRow: 256 }, [1, 1])
    d.queue.submit([e.finish()])
    await withTimeout(Promise.race([read.mapAsync(GPUMapMode.READ), d.lost.then(() => { throw new Error('the device was lost before the pixel was read') })]), 15000, 'reading a pixel back')
    const got = [...new Uint8Array(read.getMappedRange().slice(0, bytes || 4))]
    read.unmap()
    return got
  }
  const near = (got, want) => got.length === want.length && got.every((x, i) => Math.abs(x - want[i]) <= 2)
  const target = (d, format) => d.createTexture({ size: [64, 64], format: format || 'rgba8unorm', usage: U.RENDER_ATTACHMENT | U.COPY_SRC })
  const colour = (view, extra) => ({ colorAttachments: [Object.assign({ view, loadOp: 'clear', storeOp: 'store', clearValue: [1, 0, 0, 1] }, extra)] })
  const triangle = (d, format, extra) => d.createRenderPipeline(Object.assign({ layout: 'auto', vertex: { module: d.createShaderModule({ code: TRI }), entryPoint: 'vs' }, fragment: { module: d.createShaderModule({ code: TRI }), entryPoint: 'fs', targets: [{ format: format || 'rgba8unorm' }] } }, extra))
  // three r186's mipmap pass (WebGPUTexturePassUtils), call for call: each texture's lower levels drawn from the level
  // above through a 2d-array view, one encoder and one submit a texture, the pipeline, sampler and uniform shared as
  // three shares them; \`bundles\` as three does it, or the draws made directly. \`sizes\` are the textures' edges.
  const mips = async (d, bundles, sizes, unread) => {
    const flip = d.createBuffer({ size: 4, usage: B.UNIFORM })
    const sampler = d.createSampler({ minFilter: 'linear' })
    const module = d.createShaderModule({ label: 'mipmap', code: MIP })
    const pipeline = d.createRenderPipeline({ label: 'mipmap-rgba8unorm-2d-array', layout: 'auto', vertex: { module }, fragment: { module, entryPoint: 'main_2d_array', targets: [{ format: 'rgba8unorm' }] } })
    let texture = null, levels = 0
    for (const size of sizes || [64]) {
      levels = Math.floor(Math.log2(size)) + 1
      texture = d.createTexture({ label: 'fbm' + size, size: { width: size, height: size, depthOrArrayLayers: 1 }, mipLevelCount: levels, sampleCount: 1, dimension: '2d', format: 'rgba8unorm', usage: U.COPY_SRC | U.COPY_DST | U.TEXTURE_BINDING | U.RENDER_ATTACHMENT })
      const texels = new Uint8Array(size * size * 4)
      for (let i = 0; i < texels.length; i += 4) texels.set([51, 102, 204, 255], i)
      d.queue.writeTexture({ texture, mipLevel: 0 }, texels, { bytesPerRow: size * 4 }, [size, size, 1])
      const e = d.createCommandEncoder({ label: 'mipmapEncoder' })
      for (let level = 1; level < levels; level++) {
        const group = d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: sampler }, { binding: 1, resource: texture.createView({ dimension: '2d-array', baseMipLevel: level - 1, mipLevelCount: 1 }) }, { binding: 2, resource: { buffer: flip } }] })
        const into = texture.createView({ dimension: '2d', baseMipLevel: level, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 })
        const pass = e.beginRenderPass({ colorAttachments: [{ view: into, loadOp: 'clear', storeOp: 'store' }] })
        if (bundles) {
          const b = d.createRenderBundleEncoder({ colorFormats: ['rgba8unorm'] })
          b.setPipeline(pipeline); b.setBindGroup(0, group); b.draw(3, 1, 0, 0)
          pass.executeBundles([b.finish()])
        } else { pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.draw(3, 1, 0, 0) }
        pass.end()
      }
      d.queue.submit([e.finish()])
    }
    // The city reads nothing back and waits for nothing after these passes: unread leaves them as it does.
    if (unread) return { right: true }
    const pixel = await pixelOf(d, texture, levels - 1)
    return { pixel, right: near(pixel, [51, 102, 204, 255]) }
  }
  // The page's own start, piece by piece: the adapter asked for as the city asks (HOW.power), the device with every
  // feature three asks for that the adapter has (HOW.features), the four noise textures the renderer uploads first
  // (CITY_SIZES), all of it together (cityStart), a device left alone, and a device beside a worker's.
  const FEATURES = ['core-features-and-limits', 'depth-clip-control', 'depth32float-stencil8', 'texture-compression-bc', 'texture-compression-bc-sliced-3d', 'texture-compression-etc2', 'texture-compression-astc', 'texture-compression-astc-sliced-3d', 'timestamp-query', 'indirect-first-instance', 'shader-f16', 'rg11b10ufloat-renderable', 'bgra8unorm-storage', 'float32-filterable', 'float32-blendable', 'clip-distances', 'dual-source-blending', 'subgroups', 'texture-formats-tier1', 'texture-formats-tier2']
  const CITY_SIZES = [64, 128, 192, 256]
  const HOW = {
    power: { adapter: { powerPreference: 'high-performance' } },
    features: { features: true },
    cityStart: { adapter: { powerPreference: 'high-performance' }, features: true, label: 'page' },
    unread: { adapter: { powerPreference: 'high-performance' }, features: true, label: 'page' },
    garbage: { adapter: { powerPreference: 'high-performance' }, features: true, label: 'page' },
  }
  const WORKER = 'onmessage = async () => { try { const a = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }); const d = a ? await a.requestDevice({ label: "probe: a worker" }) : null; let lost = null; if (d) d.lost.then((l) => { lost = l.reason }); await new Promise((r) => setTimeout(r, 800)); postMessage({ adapter: !!a, device: !!d, lost: lost }) } catch (e) { postMessage({ threw: String(e) }) } }'
  const STAGES = {
    clear: async (d) => {
      const t = target(d)
      const e = d.createCommandEncoder()
      e.beginRenderPass(colour(t.createView())).end()
      d.queue.submit([e.finish()])
      const pixel = await pixelOf(d, t)
      return { pixel, right: near(pixel, [255, 0, 0, 255]) }
    },
    draw: async (d) => {
      const t = target(d)
      const e = d.createCommandEncoder()
      const pass = e.beginRenderPass(colour(t.createView()))
      pass.setPipeline(triangle(d)); pass.draw(3)
      pass.end()
      d.queue.submit([e.finish()])
      const pixel = await pixelOf(d, t)
      return { pixel, right: near(pixel, [0, 255, 0, 255]) }
    },
    bundle: async (d) => {
      const t = target(d)
      const b = d.createRenderBundleEncoder({ colorFormats: ['rgba8unorm'] })
      b.setPipeline(triangle(d)); b.draw(3)
      const e = d.createCommandEncoder()
      const pass = e.beginRenderPass(colour(t.createView()))
      pass.executeBundles([b.finish()])
      pass.end()
      d.queue.submit([e.finish()])
      const pixel = await pixelOf(d, t)
      return { pixel, right: near(pixel, [0, 255, 0, 255]) }
    },
    mips: (d) => mips(d, true),
    mipsDirect: (d) => mips(d, false),
    npot: (d) => mips(d, true, [192]),
    fourMips: (d) => mips(d, true, CITY_SIZES),
    power: (d) => mips(d, true),
    features: (d) => mips(d, true),
    cityStart: (d) => mips(d, true, CITY_SIZES),
    idle: async () => { await new Promise((later) => setTimeout(later, 1500)); return { right: true } },
    besideWorker: async (d) => {
      const drawn = await mips(d, true)
      const worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })))
      const said = await withTimeout(new Promise((yes, no) => { worker.onmessage = (e) => yes(e.data); worker.onerror = (e) => no(new Error(e.message || 'the worker failed to start')); worker.postMessage(0) }), 20000, 'the worker')
      worker.terminate()
      return { pixel: drawn.pixel, worker: said, right: drawn.right && said.device === true && said.lost === null }
    },
    indirect: async (d) => {
      const t = target(d)
      const module = d.createShaderModule({ code: BUF })
      const pipeline = d.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }] }, fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] } })
      const vertices = d.createBuffer({ size: 24, usage: B.VERTEX | B.COPY_DST })
      d.queue.writeBuffer(vertices, 0, new Float32Array([-1, -1, -1, 3, 3, -1]))
      const indices = d.createBuffer({ size: 12, usage: B.INDEX | B.COPY_DST })
      d.queue.writeBuffer(indices, 0, new Uint32Array([0, 1, 2]))
      const args = d.createBuffer({ size: 20, usage: B.INDIRECT | B.STORAGE | B.COPY_DST })
      d.queue.writeBuffer(args, 0, new Uint32Array([3, 1, 0, 0, 0]))
      const e = d.createCommandEncoder()
      const pass = e.beginRenderPass(colour(t.createView()))
      pass.setPipeline(pipeline); pass.setVertexBuffer(0, vertices); pass.setIndexBuffer(indices, 'uint32'); pass.drawIndexedIndirect(args, 0)
      pass.end()
      d.queue.submit([e.finish()])
      const pixel = await pixelOf(d, t)
      return { pixel, right: near(pixel, [0, 255, 0, 255]) }
    },
    msaa: async (d) => {
      const many = d.createTexture({ size: [64, 64], sampleCount: 4, format: 'rgba16float', usage: U.RENDER_ATTACHMENT })
      const depth = d.createTexture({ size: [64, 64], sampleCount: 4, format: 'depth24plus', usage: U.RENDER_ATTACHMENT })
      const t = target(d, 'rgba16float')
      const e = d.createCommandEncoder()
      const pass = e.beginRenderPass(Object.assign(colour(many.createView(), { resolveTarget: t.createView() }), { depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } }))
      pass.setPipeline(triangle(d, 'rgba16float', { multisample: { count: 4 }, depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' } })); pass.draw(3)
      pass.end()
      d.queue.submit([e.finish()])
      // Half floats, little end first: 0, 1, 0, 1.
      const pixel = await pixelOf(d, t, 0, 8)
      return { pixel, right: near(pixel, [0, 0, 0, 60, 0, 0, 0, 60]) }
    },
    canvas: async (d) => {
      const canvas = document.createElement('canvas')
      canvas.width = 64; canvas.height = 64
      document.body.appendChild(canvas)
      const context = canvas.getContext('webgpu')
      if (!context) throw new Error('no webgpu context on a canvas')
      const format = navigator.gpu.getPreferredCanvasFormat()
      context.configure({ device: d, format, alphaMode: 'premultiplied' })
      for (let frame = 0; frame < 3; frame++) {
        const e = d.createCommandEncoder()
        const pass = e.beginRenderPass(colour(context.getCurrentTexture().createView()))
        pass.setPipeline(triangle(d, format)); pass.draw(3)
        pass.end()
        d.queue.submit([e.finish()])
        await new Promise((next) => { requestAnimationFrame(next); setTimeout(next, 500) })
      }
      return { format, right: true }
    },
    // The last two are the city's start as the city leaves it, and they come last because a stage the GPU faults on
    // can leave the browser's GPU process refusing every later one: the same passes with nothing read back and
    // nothing waited for, the thread then kept for most of a second as the city's is while it builds its world
    // (unread), and the same while that thread makes and drops memory, so the passes' own objects are collected
    // while the GPU may still be at them (garbage).
    unread: async (d) => {
      await mips(d, true, CITY_SIZES, true)
      const until = performance.now() + 600
      while (performance.now() < until) { /* the thread is kept */ }
      await new Promise((later) => setTimeout(later, 800))
      return { right: true }
    },
    garbage: async (d) => {
      await mips(d, true, CITY_SIZES, true)
      const until = performance.now() + 600
      let made = 0
      while (performance.now() < until) { const held = []; for (let i = 0; i < 64; i++) held.push(new Float64Array(16384)); made += held.length }
      await new Promise((later) => setTimeout(later, 800))
      return { made, right: true }
    },
  }
  const out = {}
  for (const name of Object.keys(STAGES)) {
    const r = { ok: false, lost: null, errors: [], began: Date.now(), ended: 0 }
    out[name] = r
    try {
      const how = HOW[name] || {}
      const adapter = await withTimeout(navigator.gpu.requestAdapter(how.adapter), 20000, 'requestAdapter')
      if (!adapter) { r.errors.push('no adapter'); continue }
      const d = await withTimeout(adapter.requestDevice({ label: how.label || 'probe: ' + name, requiredFeatures: how.features ? FEATURES.filter((f) => adapter.features.has(f)) : [] }), 20000, 'requestDevice')
      let over = false
      d.lost.then((l) => { if (!over) r.lost = l.reason + (l.message ? ': ' + l.message : '') })
      d.addEventListener('uncapturederror', (e) => r.errors.push(String(e.error && e.error.message).slice(0, 300)))
      d.pushErrorScope('validation')
      let got = null
      try { got = await STAGES[name](d) } catch (e) { r.errors.push(String(e).slice(0, 300)) }
      const scoped = await withTimeout(Promise.race([d.popErrorScope(), d.lost.then(() => null)]), 10000, 'popErrorScope').catch((e) => ({ message: String(e) }))
      if (scoped) r.errors.push(String(scoped.message).slice(0, 300))
      await withTimeout(Promise.race([d.queue.onSubmittedWorkDone(), d.lost]), 10000, 'the submitted work').catch((e) => r.errors.push(String(e).slice(0, 300)))
      // A loss reported a moment after the work was done still belongs to this stage.
      await new Promise((later) => setTimeout(later, 1000))
      if (got) Object.assign(r, got)
      r.ok = r.lost === null && r.errors.length === 0 && got !== null && got.right === true
      over = true
      if (r.lost === null) d.destroy()
    } catch (e) { r.errors.push(String(e).slice(0, 300)) } finally { r.ended = Date.now() }
  }
  return out
}`

/**
 * A page expression (async): what this browser offers, on the page and inside a worker. Every step is guarded, so one
 * missing API is one field, never the end of the probe. With `drawing` the ladder runs in it, where the browser gave
 * an adapter.
 */
const probeSource = (drawing) => `(async () => {
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
    ${drawing ? `// What this browser's GPU can draw, one kind of work at a time (LADDER).
    if (out.adapter && !out.adapter.threw) await step('render', () => (${LADDER})(withTimeout))` : '// Nothing more is drawn here: the ladder has a run of its own (--part drawing).'}
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

/** The probe with the drawing ladder in it. */
export const PROBE = probeSource(true)

/**
 * The probe without the ladder (--part city): what the browser offers and one compute pass read back, and nothing
 * else asked of its GPU, so the city's start is the first real work that GPU is given.
 */
export const PROBE_PLAIN = probeSource(false)

/**
 * A page expression: where the city's start stands. `card` is the recovery card (its kind, its words, and the two
 * lines under Details: what was thrown, and the build, adapter and user agent), `running` the engine's own numbers
 * once ?debug has put __SIM__ on the page, `veil` the boot veil's words while it is up ('' while it shows only its
 * mark, null once it is gone), `bootDone` whether the page's
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
    gpu: R && R.gpu ? { total: R.gpu.total, workers: R.gpu.workers, epoch: R.gpu.epoch, lost: R.gpu.lost.slice(0, 8), errors: R.gpu.errors.slice(0, 40), key: R.gpu.key.slice(-500), calls: R.gpu.calls.slice(-120), worker: (R.gpu.worker || []).slice(0, 80) } : null,
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
export function judge(target, probe, page, hang = null) {
  const want = expected(target, probe)
  const end = page?.end ?? {}
  const name = `?${page?.query ?? ''}`
  const checks = []
  // A check that did not hold is failed, or, where `unjudged` says a hung GPU took it, not judged: never passed.
  const check = (ok, what, detail = '', unjudged = false) => { checks.push({ ok: Boolean(ok), unjudged: !ok && Boolean(unjudged), what, detail: String(detail).slice(0, 1200) }) }
  const card = end.card ?? null
  const r = end.running ?? null
  const after = `after ${Math.round((page?.ms ?? 0) / 1000)} s`
  const got = page?.outcome === 'running' ? `the city runs, ${after}`
    : page?.outcome === 'card' ? `the ${card?.kind} card: ${card?.text ?? ''}${card?.detail ? ` [details: ${card.detail}]` : ''}`
      : `still starting ${after}: ${JSON.stringify({ veil: end.veil ?? null, body: end.body ?? null, threw: end.threw ?? null })}`
  const runs = page?.outcome === 'running'
  // A GPU the Mac's own kernel found hung took this start with it: the Mac's, not the page's, and not a pass either.
  const hungHere = hang !== null && !runs
  const lost = hungHere ? `not seen: ${hangWords(hang)}; the page: ${got}` : got
  if (want.outcome === 'running') {
    check(runs, `${name}: the city runs (${want.why})`, runs
      ? `${Math.round((r?.fps ?? 0) * 10) / 10} fps, ${r?.pedestrians ?? '?'} people, ${r?.vehicles ?? '?'} cars, ${r?.device ?? '?'} input, GPU ${JSON.stringify(r?.gpu ?? null)}, quality ${JSON.stringify(r?.quality ?? null).slice(0, 300)}, ${after}`
      : lost, hungHere)
    if (runs) check((r?.errors ?? []).length === 0, `${name}: no engine error`, (r?.errors ?? []).join(' | '))
    // What the page does owe a visitor whose GPU went: words, and a way on. Its card and its veil both carry Restart.
    if (hungHere) check(/\bRestart\b/.test(card?.text ?? end.veil ?? end.body ?? ''), `${name}: with its GPU gone, the page is left with words and a way on (Restart)`, got)
  } else {
    const right = page?.outcome === 'card' && (want.kind === null || card?.kind === want.kind)
    check(right, `${name}: the ${want.kind ?? 'recovery'} card, since ${want.why}`, right ? got : lost, hungHere)
    if (right && target === 'iphone') {
      check(!SENDS_ELSEWHERE.test(card.text) && (want.kind === 'worker-gpu' || IPHONE_SAYS.test(card.text)), `${name}: the card sends an iPhone to no other browser, and says what brings WebGPU`, card.text)
    }
    if (right && target === 'mac' && want.kind === 'no-api') {
      // The card's two wordings (bootFailure.ts): a Safari of 26 or newer on an older macOS, and an older Safari.
      check(/Safari turns WebGPU on from macOS 26|the Safari that comes with macOS 26 does/.test(card.text) && !/turned off in Safari/.test(card.text), `${name}: a Mac with no WebGPU in Safari is told macOS 26 brings it`, card.text)
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

/**
 * Pure. What one macOS crash report (.ips: a line of JSON, then a JSON body) says, in a few lines: the process, how
 * it ended, what the system added, and the top of the thread that ended it. A report that does not parse is one line.
 */
export function crashDigest(text, frames = 24) {
  const cut = text.indexOf('\n')
  let head = null
  let body = null
  try { head = JSON.parse(text.slice(0, cut)); body = JSON.parse(text.slice(cut + 1)) } catch { return [`a report that does not parse: ${text.slice(0, 160).replace(/\s+/g, ' ')}`] }
  const ex = body.exception ?? {}
  const lines = [`${body.procName ?? head.app_name ?? '?'} ${head.app_version ?? ''} at ${body.captureTime ?? head.timestamp ?? '?'}: ${[ex.type, ex.signal, ex.subtype, ex.codes].filter(Boolean).join(', ') || `report type ${head.bug_type ?? '?'}`}`]
  const end = body.termination
  if (end) lines.push(`ended: ${[end.namespace, end.indicator, ...(end.reasons ?? []), end.byProc ? `by ${end.byProc}` : ''].filter(Boolean).join(', ')}`)
  for (const [image, notes] of Object.entries(body.asi ?? {})) lines.push(`${image}: ${[].concat(notes).join(' | ').slice(0, 600)}`)
  const threads = body.threads ?? []
  const thread = threads.find((t) => t?.triggered) ?? threads[body.faultingThread ?? 0]
  if (thread) {
    lines.push(`the thread that ended it${thread.name ? `, ${thread.name}` : ''}${thread.queue ? ` (${thread.queue})` : ''}:`)
    for (const f of (thread.frames ?? []).slice(0, frames)) lines.push(`  ${body.usedImages?.[f.imageIndex]?.name ?? '?'}  ${f.symbol ? `${f.symbol} + ${f.symbolLocation ?? 0}` : `+${f.imageOffset ?? '?'}`}`)
  }
  return lines
}

/**
 * Pure. What the system log says about the browser's GPU process, each distinct message once and in the order it
 * first appeared, with when it first and last came and how often: `log show --style compact` lines whose message is
 * about the GPU process, Metal, a crash, an exit or memory pressure. The first of them is the cause; the hundreds
 * after it are the same few lines again, which is why a tail of the log shows only the consequences.
 */
export function logDigest(text, most = 80) {
  const of = /gpu|Metal|Paravirt|AGX|command buffer|memory ?pressure|lowMemory|jetsam|crash|exit|terminat|unresponsive|abort|fault|\blost\b|\bfail/i
  const seen = new Map()
  for (const line of text.split('\n')) {
    const m = LOG_LINE.exec(line)
    if (!m || !of.test(m[5]) || m[3] === 'log') continue
    const key = `${m[3]}[${m[4]}] ${m[2]} ${m[5].replace(/0x[0-9a-f]+/gi, '0x..').slice(0, 420)}`
    const had = seen.get(key)
    if (had) { had.count++; had.last = m[1] } else seen.set(key, { first: m[1], last: m[1], count: 1 })
  }
  const lines = [...seen].map(([key, v]) => `${v.first.slice(11)} ${key}${v.count > 1 ? ` (${v.count} times, to ${v.last.slice(11)})` : ''}`)
  return lines.length > most ? [...lines.slice(0, most), `and ${lines.length - most} more kinds of line`] : lines
}

/** One line of `log show --style compact`: when, its type, the process, its number, the message. */
const LOG_LINE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\S*\s+(\S+)\s+(\S+?)\[(\d+):[0-9a-f]+\]\s+(.*)$/

/** Pure. A system log line's own time (this machine's, as the log prints it) as a clock reading in ms. */
function clockOf(when) {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?/.exec(when)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number((m[7] ?? '0').padEnd(3, '0'))).getTime() : NaN
}

/** Pure. A clock reading as `log show --start` and `--end` take it: this machine's own time, to the second. */
export function stamp(ms) {
  const d = new Date(ms)
  const two = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/**
 * Pure. What a Mac's kernel wrote down of a GPU that hung, from `log show --style compact` lines: when it first
 * signalled a restart of the GPU, how many it signalled, the GPU its hang report names (AppleParavirtGPU is a virtual
 * Mac's), and the app it then stopped taking GPU work from. Null when the kernel wrote down none of it: a device lost
 * on a GPU that did not hang is something else, and stays the page's to answer for.
 */
export function hangOf(text) {
  let at = null
  let restarts = 0
  let gpu = null
  let refused = null
  for (const line of text.split('\n')) {
    const m = LOG_LINE.exec(line)
    if (!m || m[3] !== 'kernel') continue
    const signalled = /\bGPURestartSignaled\b/.test(m[5])
    const named = /\bGPU hang: (\w+)/.exec(m[5])
    const deny = /Deny submissions\/ignore app\[([^\]]+)\]/.exec(m[5])
    if (!signalled && !named && !deny) continue
    if (at === null) at = m[1]
    if (signalled) restarts++
    if (named && gpu === null) gpu = named[1]
    if (deny && refused === null) refused = deny[1]
  }
  return at === null ? null : { at, atMs: clockOf(at), restarts, gpu, refused }
}

/** Pure. A hang (hangOf) in words. */
export function hangWords(hang) {
  return `this Mac's kernel found its GPU${hang.gpu ? ` (${hang.gpu})` : ''} hung at ${String(hang.at).slice(11)}${hang.restarts ? ` and signalled ${hang.restarts} restart${hang.restarts === 1 ? '' : 's'} of it` : ''}${hang.refused ? `, then took no more GPU work from ${hang.refused}` : ''}`
}

/**
 * Pure. Where a moment falls among named spans of time ({ name, from, to }, ms on one clock): during one, between
 * two, before the first or after the last.
 */
export function placed(atMs, spans) {
  const sorted = spans.filter((s) => Number.isFinite(s.from) && Number.isFinite(s.to) && s.to >= s.from).sort((a, b) => a.from - b.from)
  const within = sorted.find((s) => atMs >= s.from && atMs <= s.to)
  if (within) return `during ${within.name}`
  const before = sorted.filter((s) => s.to < atMs).sort((a, b) => a.to - b.to).pop()
  const after = sorted.find((s) => s.from > atMs)
  if (before && after) return `between ${before.name} and ${after.name}`
  if (after) return `before ${after.name}`
  if (before) return `after ${before.name}`
  return 'at no known moment of the run'
}

/**
 * Pure. The drawing probe's stages (LADDER's result) in the order they were asked, whether every one of them held,
 * and the lot in one line. A driver hands an object's keys back in an order of its own, so each stage's own clock
 * (began) is what orders them.
 */
export function drawing(render) {
  if (!render || typeof render !== 'object' || typeof render.threw === 'string') return { ok: false, stages: [], words: `the drawing probe did not run: ${render?.threw ?? 'no result'}` }
  const stages = Object.entries(render).filter(([, r]) => r && typeof r === 'object').map(([name, r]) => ({ ...r, name })).sort((a, b) => (a.began ?? 0) - (b.began ?? 0))
  const words = stages.map((r) => `${r.name} ${r.ok === true ? 'ok' : `NO (${[r.lost ? `device lost, ${r.lost}` : '', ...(r.errors ?? []), r.pixel && r.right !== true ? `pixel ${r.pixel}` : ''].filter(Boolean).join('; ') || 'no result'})`}`).join(', ')
  return { ok: stages.length > 0 && stages.every((r) => r.ok === true), stages, words }
}

/**
 * Pure. The run in one line, and as a job summary: how many checks held, failed and were not judged (each check's
 * `state`: ok, failed, not judged), and, where a hung GPU took some, that what it took was not seen and is not claimed.
 */
export function verdictOf(target, checks, hang = null) {
  const failed = checks.filter((c) => c.state === 'failed').length
  const unjudged = checks.filter((c) => c.state === 'not judged').length
  const held = checks.length - failed - unjudged
  const line = failed > 0
    ? `safari (${target}): ${failed} check${failed === 1 ? '' : 's'} failed${unjudged ? `, ${unjudged} not judged` : ''}`
    : unjudged > 0
      ? `safari (${target}): ${held} check${held === 1 ? '' : 's'} passed and ${unjudged} could NOT BE JUDGED: ${hang ? hangWords(hang) : 'its GPU hung'}. What that took was not seen here, and nothing is claimed of it.`
      : `safari (${target}): every check passed`
  const mark = (c) => (c.state === 'ok' ? 'passed' : c.state === 'failed' ? '**FAILED**' : '**not judged**')
  const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 300)
  const summary = [`### Safari (${target})`, '', line, '', '| | check |', '|---|---|', ...checks.map((c) => `| ${mark(c)} | ${cell(c.what)} |`)].join('\n')
  return { line, summary }
}

/**
 * On a Mac: what the kernel wrote down since `since` of a GPU that hung (hangOf), or null. Two readings of the system
 * log, each narrow, since a hung GPU fills the log with thousands of lines a minute: the restarts it signalled and
 * the app it refused, then the few seconds around the first for the hang report that names the GPU.
 */
function kernelHang(since) {
  if (process.platform !== 'darwin') return null
  const show = (window, predicate) => run('log', ['show', ...window, '--style', 'compact', '--predicate', predicate], { ms: 180_000 }).out
  const hang = hangOf(show(['--start', stamp(since)], 'process == "kernel" AND (eventMessage CONTAINS "GPURestartSignaled" OR eventMessage CONTAINS "Deny submissions/ignore app")'))
  if (!hang) return null
  const named = hangOf(show(['--start', stamp(hang.atMs - 2000), '--end', stamp(hang.atMs + 3000)], 'process == "kernel" AND eventMessage CONTAINS "GPU hang"'))
  return { ...hang, gpu: named?.gpu ?? hang.gpu }
}

/** The Mac's own account of its memory: cores, RAM, and the kernel's memory pressure level (1 normal, 2 warning, 4 critical). */
function machine() {
  if (process.platform !== 'darwin') return ''
  const read = (name) => run('sysctl', ['-n', name], { ms: 10_000 }).out.trim()
  return `${read('hw.physicalcpu')} cores (${read('hw.logicalcpu')} logical), ${Math.round(Number(read('hw.memsize')) / 2 ** 30)} GB, memory pressure level ${read('kern.memorystatus_vm_pressure_level') || '?'}`
}

/**
 * On a Mac, after a start that failed: what the system kept of this run. The crash reports written since `since` (a
 * WebKit process that crashed leaves one within seconds, so a few are waited for), and what Safari's GPU process and
 * its keeper logged: WebKit reports a lost device with no words, and this is where the reason is written down. Where
 * the kernel found the GPU hung (`hang`), the log is read up to a little after that: a hung GPU writes thousands of
 * the same lines a minute after it, and they would crowd out the first ones. Evidence only: nothing here changes a
 * verdict.
 */
async function evidence(since, name, hang = null) {
  if (process.platform !== 'darwin') return
  const folders = [join(homedir(), 'Library/Logs/DiagnosticReports'), '/Library/Logs/DiagnosticReports']
  const reports = () => folders.flatMap((folder) => {
    try { return readdirSync(folder).map((f) => join(folder, f)).filter((f) => /\.(?:ips|crash|diag|hang)$/.test(f) && statSync(f).mtimeMs >= since) } catch { return [] }
  })
  for (let i = 0; i < 10 && reports().length === 0; i++) await sleep(2000)
  const found = reports()
  console.log(`${name}: crash reports since the run began: ${found.length === 0 ? 'none' : found.map((f) => f.split(sep).pop()).join(', ')}`)
  for (const file of found.slice(0, 6)) {
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch (e) { text = String(e) }
    for (const line of crashDigest(text)) console.log(`${name}: crash report ${file.split(sep).pop()}: ${line}`)
  }
  const until = hang ? Math.min(Date.now(), hang.atMs + 15_000) : Date.now()
  const log = run('log', ['show', '--start', stamp(since), '--end', stamp(until + 1000), '--style', 'compact', '--predicate', 'process == "com.apple.WebKit.GPU" OR eventMessage CONTAINS "GPUProcess" OR eventMessage CONTAINS[c] "memory pressure" OR (process == "kernel" AND eventMessage CONTAINS[c] "gpu")'], { ms: 240_000 })
  const lines = logDigest(log.out)
  console.log(`${name}: the system log about Safari's GPU process, ${stamp(since).slice(11)} to ${stamp(until + 1000).slice(11)}, each kind of line once, in the order it first came: ${lines.length} kind(s)${log.ok ? '' : ` (log show: ${log.err.trim().slice(0, 200)})`}`)
  for (const line of lines) console.log(`${name}: log ${line}`)
  console.log(`${name}: this Mac now: ${machine()}`)
}

async function main() {
  const argv = process.argv.slice(2)
  const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
  const all = (name) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] !== undefined ? [argv[i + 1]] : []))
  const flag = (name) => argv.includes(`--${name}`)
  if (flag('help')) {
    console.log('usage: node tools/browser/safari.mjs --web dist-web --target mac|iphone [--device NAME] [--query QUERY]... [--out DIR] [--boot-ms MS] [--port 4444] [--needs-gpu] [--trace] [--fresh-safari] [--virtual-gpu] [--part city|drawing]')
    return 0
  }
  const web = resolve(arg('web') ?? 'dist-web')
  const target = arg('target') ?? 'mac'
  const out = resolve(arg('out') ?? 'safari-out')
  const bootMs = Number(arg('boot-ms') ?? 600_000)
  const port = Number(arg('port') ?? 4444)
  // --part: the city alone (the probe without its drawing ladder), the drawing alone (no city opened), or both.
  const part = arg('part') ?? 'both'
  const queries = part === 'drawing' ? [] : all('query').length ? all('query') : [VISITOR]
  if (!['mac', 'iphone'].includes(target)) { console.error(`safari: no target named ${target} (mac or iphone)`); return 2 }
  if (!['both', 'city', 'drawing'].includes(part)) { console.error(`safari: no part named ${part} (city or drawing; both without --part)`); return 2 }
  if (!existsSync(join(web, 'index.html'))) { console.error(`safari: no index.html in ${web} (npm run build:web makes dist-web/)`); return 2 }
  mkdirSync(out, { recursive: true })
  const began = Date.now()
  if (process.platform === 'darwin') console.log(`${target}: this Mac: ${machine()}`)

  const report = { target, part, web, queries, checks: [], pages: [], hang: null }
  let failed = 0
  let unjudged = 0
  // A check holds, fails, or, where a hung GPU took it (`notJudged`), is not judged: reported, and never a pass.
  const check = (ok, what, detail = '', notJudged = false) => {
    const state = ok ? 'ok' : notJudged ? 'not judged' : 'failed'
    report.checks.push({ ok, state, what, detail })
    if (state === 'failed') failed++
    if (state === 'not judged') unjudged++
    console.log(`${state === 'ok' ? 'ok  ' : state === 'failed' ? 'FAIL' : 'NOT JUDGED'} ${what}${detail ? ` (${detail})` : ''}`)
    return ok
  }
  const save = () => writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  // --virtual-gpu, and only on a Mac that says it is a virtual machine: a GPU its kernel found hung is the Mac's. The
  // kernel is asked again each time something did not hold, until it has a hang to tell; a hung GPU stays refused.
  const virtual = process.platform === 'darwin' && run('sysctl', ['-n', 'kern.hv_vmm_present'], { ms: 10_000 }).out.trim() === '1'
  const spans = []
  const hung = () => {
    if (!flag('virtual-gpu') || !virtual) return null
    if (report.hang === null) {
      report.hang = kernelHang(began)
      if (report.hang) console.log(`${target}: ${hangWords(report.hang)}: ${placed(report.hang.atMs, spans)}`)
    }
    return report.hang
  }

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

  const host = await serve(web, { record: true, trace: flag('trace') })
  const driver = new Driver(`http://127.0.0.1:${port}`)
  let driverProcess = null
  /** Starts safaridriver and a Safari session with it; `label` names the checks. The session's capabilities, or null. */
  const start = async (label) => {
    const proc = spawn('safaridriver', ['--port', String(port)], { stdio: ['ignore', 'inherit', 'inherit'] })
    driverProcess = proc
    let driverGone = null
    proc.on('exit', (code) => { driverGone = code ?? -1 })
    proc.on('error', (e) => { driverGone = e.message })
    // The driver answers /status once it listens. Beside a simulator that has just started, on a Mac still busy with
    // it, that has taken most of a minute: three minutes are allowed, by the clock and not by the count of tries.
    let listening = false
    const asked = Date.now()
    while (!listening && driverGone === null && Date.now() - asked < DRIVER_UP_MS) {
      try { await driver.call('GET', '/status'); listening = true } catch { await sleep(500) }
    }
    const took = `${Math.round((Date.now() - asked) / 1000)} s`
    if (!check(listening, `${label}: safaridriver listens`, listening ? `after ${took}` : `it ${driverGone === null ? `never answered in ${took}` : `stopped (${driverGone})`}; sudo safaridriver --enable turns remote automation on`)) return null
    let session = null
    let why = ''
    // A simulator that has just started can refuse its first session: a few tries, a pause between them.
    for (let i = 0; i < 4 && !session; i++) {
      try { session = await driver.start(capabilities) } catch (e) { why = e.message; await sleep(15_000) }
    }
    if (!check(Boolean(session), `${label}: a Safari session`, session ? `${session.browserName ?? 'safari'} ${session.browserVersion ?? ''} on ${session.platformName ?? '?'}`.trim() : why.slice(0, 500))) return null
    await driver.timeouts(120_000)
    if (target === 'mac') await driver.rect(1280, 800).catch(() => {})
    return session
  }
  /** Which of Safari's GPU processes run now, by number: a page that starts in a new one starts with nothing behind it. */
  const gpuProcesses = () => (process.platform === 'darwin' ? run('pgrep', ['-f', 'com.apple.WebKit.GPU'], { ms: 10_000 }).out.trim().split(/\s+/).filter(Boolean).join(', ') || 'none' : 'unknown')
  /**
   * --fresh-safari, on the Mac: the session and its driver end, Safari itself is asked to quit (its GPU process goes
   * with it), and a new driver and session start. What one page left in the browser's GPU process, a command queue
   * the system stopped listening to among it, then never reaches the next page. It quits Safari on this Mac: for a
   * runner, not for a Mac someone is using.
   */
  const fresh = async (label) => {
    await driver.quit()
    driverProcess?.kill()
    run('pkill', ['-x', 'Safari'], { ms: 10_000 })
    for (let i = 0; i < 60 && (run('pgrep', ['-x', 'Safari'], { ms: 5_000 }).ok || run('pgrep', ['-f', 'com.apple.WebKit.GPU'], { ms: 5_000 }).ok); i++) await sleep(250)
    await sleep(1000)
    const session = await start(label)
    if (session) console.log(`${label}: a Safari started for this page (its GPU process: ${gpuProcesses()} so far)`)
    return session
  }
  const freshEach = flag('fresh-safari') && target === 'mac' && process.platform === 'darwin'
  try {
    const session = await start(target)
    if (!session) { save(); return 1 }
    report.session = session

    // What the browser offers.
    await driver.go(`${host.origin}/__probe`)
    let probe = null
    try { probe = await driver.eval(part === 'city' ? PROBE_PLAIN : PROBE) } catch (e) { probe = { threw: e.message } }
    report.probe = probe
    console.log(`${target}: probe ${JSON.stringify(probe)}`)
    check(probe?.secure === true, `${target}: the page is a secure context`, `isSecureContext ${probe?.secure}`)
    // What the probe found is reported, not judged: a Mac that gives Safari no GPU is this runner, not the page.
    const adapter = probe?.adapter
    const want = expected(target, probe)
    report.expected = want
    console.log(`${target}: WebGPU on the page: ${probe?.gpu === 'object' ? 'yes' : 'no'}; adapter: ${adapter ? (adapter.threw ?? JSON.stringify(adapter.info)) : 'none'}; compute pass: ${adapter?.computed === true ? 'read back right' : 'not run'}; in a worker: ${JSON.stringify(probe?.worker ?? null).slice(0, 300)}`)
    console.log(`${target}: so the page owes ${want.outcome === 'running' ? 'a running city' : `the ${want.kind ?? 'recovery'} card`}: ${want.why}`)
    // What the browser's GPU draws, stage by stage, each with its own clock: a hang is placed among them.
    const drawn = probe?.render ? drawing(probe.render) : null
    for (const stage of drawn?.stages ?? []) spans.push({ name: `the drawing probe's ${stage.name}`, from: stage.began, to: stage.ended })
    if (flag('needs-gpu')) check(want.outcome === 'running', `${target}: this browser has a GPU for WebGPU, as this runner is expected to give it`, want.why, want.outcome !== 'running' && hung() !== null)
    if (drawn) {
      console.log(`${target}: what this GPU draws: ${drawn.words}`)
      const took = !drawn.ok && hung() !== null
      check(drawn.ok, `${target}: Safari draws each kind of work the city's renderer asks of a GPU (${drawn.stages.length} kinds, each on a device of its own)`, took ? `not seen to the end: ${hangWords(report.hang)}, ${placed(report.hang.atMs, spans)}; ${drawn.words}` : drawn.ok ? drawn.stages.map((stage) => stage.name).join(', ') : drawn.words, took)
    }

    // The city, once per query.
    for (const query of queries) {
      const name = `${target}-${queries.indexOf(query) + 1}`
      const page = { query, timeline: [], end: null, ms: 0 }
      report.pages.push(page)
      if (freshEach && !(await fresh(name))) { page.outcome = 'no browser'; continue }
      const t0 = Date.now()
      // A GPU already known to be hung stays hung: the page is still opened, for what it tells its visitor, and a
      // start that cannot come is waited for a minute and a half, not the whole time a slow start is given.
      const wait = report.hang ? Math.min(bootMs, 90_000) : bootMs
      await driver.go(`${host.origin}/?${query}`)
      let last = ''
      let state = null
      let crowdFrom = null
      let outcome = 'timeout'
      while (Date.now() - t0 < wait) {
        try { state = await driver.eval(STATE) } catch (e) { state = { threw: e.message.slice(0, 300) } }
        // A new line only when the start moved on: the card, the veil's words, the engine there or not, the page's own words.
        const stage = JSON.stringify({ card: state?.card?.kind ?? null, veil: state?.veil ?? null, running: Boolean(state?.running), drawing: (state?.running?.fps ?? 0) > 0, body: state?.body ?? null, threw: state?.threw ?? null })
        if (stage !== last) { page.timeline.push({ ms: Date.now() - t0, state: { ...state, gpu: undefined } }); console.log(`${name}: +${Math.round((Date.now() - t0) / 1000)} s ${JSON.stringify({ ...state, gpu: state?.gpu ? { total: state.gpu.total, lost: state.gpu.lost } : undefined }).slice(0, 900)}`); last = stage }
        if (state?.card) { outcome = 'card'; break }
        if (state?.running && typeof state.running.crowdFrames === 'number') {
          if (crowdFrom === null && state.running.fps > 0) crowdFrom = state.running.crowdFrames
          // The veil is in the page until it has faded, and for its first seconds it has a mark and no words: only a
          // veil that is gone (null) lets the city count as running, never one that is merely silent ('').
          else if (crowdFrom !== null && isRunning(state, crowdFrom + 2) && state.veil === null) { outcome = 'running'; break }
        }
        await sleep(3000)
      }
      page.ms = Date.now() - t0
      page.end = state
      page.outcome = outcome
      await driver.shot(join(out, `${name}.png`)).catch((e) => console.log(`${name}: no screenshot (${e.message.slice(0, 200)})`))
      if (state?.card) console.log(`${name}: the card's details: ${state.card.detail ?? 'none'} | ${state.card.line ?? ''}`)
      for (const line of state?.lines ?? []) console.log(`${name}: console ${line}`)
      // Under --trace, a start that did not end in a running city prints what WebGPU was asked just before.
      if (state?.gpu && outcome !== 'running') {
        console.log(`${name}: WebGPU trace: ${state.gpu.total} calls noted, ${state.gpu.workers} worker(s) traced; the page's clock began at ${state.gpu.epoch ? new Date(state.gpu.epoch).toISOString() : '?'}; Safari's GPU process: ${gpuProcesses()}`)
        for (const line of state.gpu.errors) console.log(`${name}: WebGPU error ${line}`)
        for (const line of state.gpu.lost) console.log(`${name}: WebGPU ${line}`)
        for (const line of state.gpu.worker ?? []) console.log(`${name}: WebGPU worker call ${line}`)
        for (const line of state.gpu.key) console.log(`${name}: WebGPU key call ${line}`)
        for (const line of state.gpu.calls) console.log(`${name}: WebGPU last call ${line}`)
      }
      if (outcome !== 'running' && process.platform === 'darwin') console.log(`${name}: this Mac at the end of the page: ${machine()}`)
      spans.push({ name: `the city's start at ?${query}`, from: t0, to: t0 + page.ms })
      for (const c of judge(target, probe, page, outcome === 'running' ? null : hung())) check(c.ok, `${name} ${c.what}`, c.detail, c.unjudged)
    }
    if (failed > 0 || unjudged > 0) await evidence(began, target, report.hang)
  } catch (e) {
    check(false, `${target}: the run`, String(e?.stack ?? e).slice(0, 800))
  } finally {
    await driver.quit()
    driverProcess?.kill()
    host.server.close()
    host.server.closeAllConnections?.()
    save()
  }
  const verdict = verdictOf(target, report.checks, report.hang)
  console.log(verdict.line)
  // Under GitHub Actions: a check not judged is a warning on the run, and the checks are the job's summary.
  if (process.env.GITHUB_ACTIONS === 'true' && unjudged > 0) console.log(`::warning title=Not judged in Safari::${verdict.line.replace(/\r?\n/g, ' ')}`)
  if (process.env.GITHUB_STEP_SUMMARY) { try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${verdict.summary}\n`) } catch { /* the summary is a courtesy */ } }
  return failed === 0 ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code }, (e) => { console.error(e); process.exitCode = 1 })
}
