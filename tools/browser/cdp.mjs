// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It drives a real Chrome or Chromium over the DevTools protocol with no dependency at all:
 * the browser is started with `--remote-debugging-pipe`, which makes it read commands from file descriptor 3 and write
 * answers to file descriptor 4, each message a JSON text ended by a NUL byte. One page is opened and attached in
 * flattened mode, so every command names its session. The browser smoke test (smoke.mjs) is built on it, and the
 * desktop launcher (tools/web/launch.mjs) finds its browser and runs its --check with it; nothing in the shipped page
 * imports it.
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

  /** Starts the browser and opens one blank page. `args` are extra switches (SOFTWARE_WEBGPU, a window size). */
  static async launch(chrome, args = []) {
    const profile = mkdtempSync(join(tmpdir(), 'agent-city-smoke-'))
    const child = spawn(chrome, [
      '--headless', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--no-sandbox', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--disable-features=Translate,MediaRouter', ...args, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
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
