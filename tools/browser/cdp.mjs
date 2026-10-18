// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It drives a real Chrome or Chromium over the DevTools protocol with no dependency at all:
 * the browser is started with `--remote-debugging-pipe`, which makes it read commands from file descriptor 3 and write
 * answers to file descriptor 4, each message a JSON text ended by a NUL byte. One page is opened and attached in
 * flattened mode, so every command names its session. The browser smoke test (smoke.mjs) is built on it, and the
 * desktop launcher (tools/web/launch.mjs) finds its browser and runs its --check with it; nothing in the shipped page
 * imports it. Two more things for a test that must prove a page reaches nothing off this machine: loopbackOnly(), the
 * switches and environment that leave the browser no name to resolve but 127.0.0.1 and no proxy to go round that, and
 * watchTargets(), which attaches every worker the page starts (and every worker those start), records every request,
 * socket and security message from each of them, and audits them.
 * What breaks if it is removed? The browser smoke test cannot start a browser, and the launcher cannot find one.
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * Chrome's software WebGPU: Dawn on SwiftShader's Vulkan, presenting through ANGLE on SwiftShader. Without the ANGLE
 * pair a headless browser with no GPU has no shared-image backing for a WebGPU canvas: the first present loses the
 * device ("A valid external Instance reference no longer exists"), which is what kept the 3D page from ever running
 * headless before (MANUAL.md, Browser support).
 */
export const SOFTWARE_WEBGPU = Object.freeze([
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--use-angle=swiftshader',
  '--use-gl=angle',
  '--enable-unsafe-swiftshader',
])

/** The host rules that leave a browser no name to resolve but this machine's address: every other request fails before it leaves. */
export const LOOPBACK_RULES = 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'

const RULES_SWITCH = '--host-resolver-rules='

/**
 * `args` and `env` for a browser that can reach nothing but this machine. Chrome reads one --host-resolver-rules
 * switch, so every one in `args` is merged into a single switch, the caller's own rules first (the first rule that maps
 * a host wins, so a `MAP lan.test 127.0.0.1` still maps), then LOOPBACK_RULES. --no-proxy-server is added, and every
 * *_proxy variable is left out of the environment: Chrome on Linux honours them, and a proxy resolves names itself,
 * past the rules.
 */
export function loopbackOnly(args = [], env = process.env) {
  const own = args.filter((a) => a.startsWith(RULES_SWITCH)).map((a) => a.slice(RULES_SWITCH.length).replace(/^"(.*)"$/, '$1').trim()).filter(Boolean)
  const rest = args.filter((a) => !a.startsWith(RULES_SWITCH) && a !== '--no-proxy-server')
  return {
    args: [...rest, `${RULES_SWITCH}${[...own, LOOPBACK_RULES].join(', ')}`, '--no-proxy-server'],
    env: Object.fromEntries(Object.entries(env).filter(([k]) => !/_proxy$/i.test(k))),
  }
}

/** Where a Chrome or Chromium usually lives, most specific first. `CHROME` (or --chrome) overrides all of them. */
function candidates() {
  const out = []
  if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
      out.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(base, 'Chromium', 'Application', 'chrome.exe'))
    }
  } else if (process.platform === 'darwin') {
    out.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium')
  } else {
    out.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/run/current-system/sw/bin/chromium')
    // Playwright's browsers, where an environment ships them (PLAYWRIGHT_BROWSERS_PATH).
    const pw = process.env.PLAYWRIGHT_BROWSERS_PATH
    if (pw && existsSync(pw)) {
      for (const d of readdirSync(pw).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) out.push(join(pw, d, 'chrome-linux', 'chrome'))
    }
  }
  return out
}

/** Whether a file can be run: on Windows any file, elsewhere a file with an execute bit for this user. */
function runnable(p) {
  try {
    if (!statSync(p).isFile()) return false
    if (process.platform !== 'win32') accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** A path as it is; a bare command name (google-chrome-stable) found on PATH, as a shell would find it: the first
 *  runnable file of that name, skipping folders and files without an execute bit. */
function onPath(name) {
  if (/[/\\]/.test(name)) return existsSync(name) ? name : null
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of process.platform === 'win32' ? ['.exe', ''] : ['']) {
      const p = join(dir, name + ext)
      if (runnable(p)) return p
    }
  }
  return null
}

/** The browser to drive: the explicit one when given (a path that exists, or a command on PATH), else the first
 *  candidate found, else null. */
export function findChrome(explicit = process.env.CHROME) {
  if (explicit) return onPath(explicit)
  return candidates().find((p) => existsSync(p)) ?? null
}

/** A browser started over the pipe, with one attached page. */
export class Browser {
  #child
  #write
  #next = 1
  #pending = new Map()
  #listeners = new Map()
  #profile
  #closed = false
  /** stderr lines, kept for the report when something fails. */
  stderr = []
  sessionId = ''

  constructor(child, profile) {
    this.#child = child
    this.#profile = profile
    this.#write = child.stdio[3]
    let buffer = Buffer.alloc(0)
    child.stdio[4].on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (let end = buffer.indexOf(0); end >= 0; end = buffer.indexOf(0)) {
        const text = buffer.subarray(0, end).toString('utf8')
        buffer = buffer.subarray(end + 1)
        this.#receive(JSON.parse(text))
      }
    })
    child.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) this.stderr.push(l) })
    child.on('exit', () => {
      this.#closed = true
      for (const { reject } of this.#pending.values()) reject(new Error('the browser exited'))
      this.#pending.clear()
    })
  }

  /**
   * Starts the browser and opens one blank page. `args` are extra switches (SOFTWARE_WEBGPU, a window size); `env`
   * is the browser's environment (this process's by default; loopbackOnly() gives one without proxies).
   */
  static async launch(chrome, args = [], { env = process.env } = {}) {
    const profile = mkdtempSync(join(tmpdir(), 'agent-city-smoke-'))
    const child = spawn(chrome, [
      '--headless', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--no-sandbox', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--disable-features=Translate,MediaRouter', ...args, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], env })
    const browser = new Browser(child, profile)
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' }, '')
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true }, '')
    browser.sessionId = sessionId
    await Promise.all([browser.send('Page.enable'), browser.send('Runtime.enable')])
    return browser
  }

  #receive(msg) {
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id)
      if (!p) return
      this.#pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`))
      else p.resolve(msg.result ?? {})
      return
    }
    for (const fn of this.#listeners.get(msg.method) ?? []) fn(msg.params ?? {}, msg.sessionId)
  }

  /** One protocol command; the page's session unless another is named ('' for the browser itself). */
  send(method, params = {}, sessionId = this.sessionId) {
    if (this.#closed) return Promise.reject(new Error('the browser exited'))
    const id = this.#next++
    const msg = { id, method, params }
    if (sessionId) msg.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method })
      this.#write.write(JSON.stringify(msg) + '\0')
    })
  }

  on(method, fn) {
    const list = this.#listeners.get(method) ?? []
    list.push(fn)
    this.#listeners.set(method, list)
  }

  /** Evaluates an expression in the page and returns its value (JSON-serialisable values only). */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }

  /** Polls `expression` until it is truthy; returns its value, or throws after `ms`. */
  async waitFor(expression, ms, every = 250) {
    const end = Date.now() + ms
    for (;;) {
      let v
      // An expression that throws is not ready yet; a browser that has gone will never be.
      try { v = await this.eval(expression) } catch (e) { if (this.#closed) throw e; v = undefined }
      if (v) return v
      if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${expression}`)
      await new Promise((r) => setTimeout(r, every))
    }
  }

  async screenshot() {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    return Buffer.from(data, 'base64')
  }

  async close() {
    if (!this.#closed) {
      try { await Promise.race([this.send('Browser.close', {}, ''), new Promise((r) => setTimeout(r, 3000))]) } catch { /* already gone */ }
      if (!this.#closed) this.#child.kill('SIGKILL')
    }
    try { rmSync(this.#profile, { recursive: true, force: true, maxRetries: 3 }) } catch { /* a locked profile on Windows */ }
  }
}

/** The targets a page's scripts can start that run code of their own: workers of every kind. */
const WORKER_TYPES = new Set(['worker', 'shared_worker', 'service_worker'])

/**
 * Everything a page and every worker it starts sent, as watchTargets() recorded it:
 * - `requests`: each Network.requestWillBeSent, with the kind of target that sent it ('page', 'worker'…);
 * - `failed`: each Network.loadingFailed, with its URL, its error and why it was blocked (a CSP refusal reads 'csp');
 * - `sockets`: each WebSocket and WebTransport opened (requestWillBeSent never shows them);
 * - `security`: each Log.entryAdded whose source is 'security' (a worker's CSP violation shows only there);
 * - `discovered` and `attached`: the worker targets the browser said were created, and those this watch attached
 *   (each with the kind of target that started it: a worker's own workers are `nested` in the audit);
 * - `errors`: the commands a target did not take (a short-lived worker gone before them).
 */
export class TargetWatch {
  /** sessionId -> { type, url, targetId } for the page and every attached worker. */
  sessions = new Map()
  discovered = new Map()
  attached = new Map()
  requests = []
  failed = []
  sockets = []
  security = []
  errors = []

  /**
   * What was recorded, judged: the requests whose URL `allowed` refuses, every socket, every security message, and the
   * workers discovered but never attached.
   */
  audit(allowed) {
    const workers = {}
    for (const t of this.attached.values()) workers[t.type] = (workers[t.type] ?? 0) + 1
    return {
      requests: this.requests.length,
      fromWorkers: this.requests.filter((r) => r.type !== 'page').length,
      offOrigin: this.requests.filter((r) => !allowed(r.url)),
      sockets: [...this.sockets],
      security: [...this.security],
      discovered: this.discovered.size,
      attached: this.attached.size,
      missing: [...this.discovered.entries()].filter(([id]) => !this.attached.has(id)).map(([, t]) => t),
      workers,
      nested: [...this.attached.values()].filter((t) => WORKER_TYPES.has(t.parent)).length,
      errors: this.errors.length,
    }
  }
}

/**
 * Watches the browser's page and every worker it starts, at any depth. Target.setAutoAttach (flattened, so each
 * worker gets a session of its own) is sent on the page and sent again on every worker session as it attaches: a
 * worker's own workers (wllama's pthread workers) are attached only then. Network and Log are enabled on every
 * session, and Target.setDiscoverTargets lists every worker the browser creates, so a worker never attached shows as
 * discovered and missing. `wait` (waitForDebuggerOnStart) holds each new worker until it is set up; a service worker
 * is then released first and set up after, since Network.enable on a paused service worker never answers.
 * Call it before the page navigates.
 */
export async function watchTargets(browser, { wait = false } = {}) {
  const w = new TargetWatch()
  const typeOf = (sid) => w.sessions.get(sid)?.type ?? (sid ? 'unknown' : 'browser')
  const urls = new Map()
  const instrument = async (sid, type, waiting) => {
    const send = (method, params = {}) => browser.send(method, params, sid).catch((e) => { w.errors.push({ type, method, error: e.message }) })
    const setUp = () => Promise.all([
      send('Network.enable'),
      send('Log.enable'),
      send('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: wait }),
    ])
    if (!waiting) return setUp()
    if (type === 'service_worker') {
      // Released first: the commands go out in the order sent, so the worker runs before Network.enable reaches it.
      const run = send('Runtime.runIfWaitingForDebugger')
      await Promise.all([run, setUp()])
      return
    }
    await setUp()
    await send('Runtime.runIfWaitingForDebugger')
  }
  browser.on('Target.targetCreated', ({ targetInfo: t }) => {
    if (WORKER_TYPES.has(t.type)) w.discovered.set(t.targetId, { type: t.type, url: t.url })
  })
  browser.on('Target.attachedToTarget', (p, parent) => {
    const t = p.targetInfo
    w.sessions.set(p.sessionId, { type: t.type, url: t.url, targetId: t.targetId })
    // `parent`: the kind of target whose session attached it ('page', or 'worker' for a worker's own worker).
    if (WORKER_TYPES.has(t.type)) w.attached.set(t.targetId, { type: t.type, url: t.url, parent: typeOf(parent) })
    void instrument(p.sessionId, t.type, p.waitingForDebugger === true)
  })
  browser.on('Network.requestWillBeSent', (p, sid) => {
    urls.set(`${sid}:${p.requestId}`, p.request.url)
    w.requests.push({ type: typeOf(sid), url: p.request.url })
  })
  browser.on('Network.loadingFailed', (p, sid) => {
    w.failed.push({ type: typeOf(sid), url: urls.get(`${sid}:${p.requestId}`) ?? '', error: p.errorText ?? '', blocked: p.blockedReason ?? null })
  })
  browser.on('Network.webSocketCreated', (p, sid) => w.sockets.push({ type: typeOf(sid), kind: 'WebSocket', url: p.url }))
  browser.on('Network.webTransportCreated', (p, sid) => w.sockets.push({ type: typeOf(sid), kind: 'WebTransport', url: p.url }))
  browser.on('Log.entryAdded', ({ entry }, sid) => {
    if (entry.source === 'security') w.security.push({ type: typeOf(sid), text: String(entry.text ?? '').slice(0, 300), url: entry.url ?? '' })
  })
  w.sessions.set(browser.sessionId, { type: 'page', url: '', targetId: '' })
  await browser.send('Target.setDiscoverTargets', { discover: true }, '')
  await instrument(browser.sessionId, 'page', false)
  return w
}
