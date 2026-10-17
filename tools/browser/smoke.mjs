#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It is the browser smoke test of the built page (`npm run smoke:browser`): the 3D city booted
 * in a real Chrome or Chromium on the software WebGPU adapter (cdp.mjs SOFTWARE_WEBGPU), driven through the same input
 * events a person makes, on each kind of device the page has to work on:
 * - desktop: the procedural city's six indoor workplaces handed to its crowd, keyboard walking, a mouse drag turning
 *   the head, a gamepad (a standard-mapping pad stood in for the real one) walking and turning, the Ring-0 console
 *   opened with the tilde key and answering, typing in it never moving the avatar, ghost view and rain mode toggled from
 *   their keys, and a car entered, driven and left;
 * - phone: an iPhone's user agent, screen and touch (no mouse, no keyboard): the virtual stick walking, a drag on the
 *   right half turning the head, both thumbs at once, the Run and Ping buttons, and the menu that reaches what a
 *   keyboard reaches (the console, the clock, ghost view, rain mode, hiding the HUD), also with a thumb on the stick;
 *   on foot and at the wheel, at six phone and tablet sizes both ways up, every control on screen and clear of the
 *   others, the stick, the speedometer, Sloane's chip and her Controls card, the chip clear of the stick and the
 *   minimap, and the Menu's sheet inside the screen; a car entered from its button and, held upright while driving,
 *   Ping, Reset and Exit car clear of the stick, every text field reads at 16 px, and a mouse moving over a
 *   touch-first screen leaves the touch overlay where it is;
 * - split: two players (?players=2) on two pads, one of them without the standard mapping: that pad moves nobody until
 *   a face button wakes it, then walks player 1, and player 2's own pad enters and leaves a car of their own;
 * - file: dist/index.html opened from disk, the way the README says to play, with no server and so no cross-origin
 *   isolation (the bridge's private-buffer path);
 * - ultra: the top tier pinned, so the shadowed, post and volumetric pipelines are compiled once and must validate;
 * - tty: the console alone (?boot=tty), which must not touch WebGPU at all;
 * - pwa: the installable copy a phone plays (tools/web/pwa.mjs, built from dist/ into a temporary folder) served as a
 *   static host serves it, to an iPhone: the manifest read through the page's policy, the icons, the service worker
 *   installed, the second load cross-origin isolated by the worker, and the city started from the phone's copy with
 *   the host gone;
 * - lakefront: the generated metropolis (?map=lakefront, built in the page's worker from the seed), whose crowd walks
 *   its street window with the six workplaces the page picked from the pack and the HUD counting who is at work;
 * - fail: the ways out when the city cannot start or stops, each in its own browser: navigator.gpu taken away (the
 *   card before a first visit's onboarding, at desktop and phone size and in Firefox on Android with Open in Chrome
 *   first, Restart focused and taken by Enter, the pad's
 *   d-pad and A reaching the console shell, and its Back to the city back again), a genuinely insecure origin
 *   (lan.test mapped to this machine over plain http), no adapter, a boot that never finishes (the 'Still starting'
 *   line, naming the step), a download cut off mid-script (the index.html watchdog), a slow download (the splash
 *   before the module has arrived), and, after a boot, the page's GPU device lost (the reset card, no reload while the page is
 *   visible), a realm halt for a lost crowd device, and a frame that throws on every frame. Where a failure is the
 *   point, the GPU-error check is left out; nothing may throw uncaught in any of them.
 * Every scenario also fails on an exception in the page, a GPU validation error, a lost device, or the crowd's flow
 * field falling back to the CPU. It serves dist/ itself on 127.0.0.1 with the two isolation headers, writes a
 * screenshot per scenario to --out (default: a temporary directory), prints one row per check and exits 1 if any fails.
 * Usage: node tools/browser/smoke.mjs [--chrome <path>] [--out <dir>] [--only desktop,phone,...,fail]. Needs `npm run build`.
 * What breaks if it is removed? Nothing at runtime; the page loses its only end-to-end check in a browser, and with it
 * the proof that the city renders and that every control reaches the avatar.
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Browser, findChrome, SOFTWARE_WEBGPU } from './cdp.mjs'
import { APP_NAME, build as buildWeb, ICONS } from '../web/pwa.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIST = join(ROOT, 'dist', 'index.html')
/** How long `?smoke-slow` holds the page's module back (serve). */
const SLOW_HOLD_MS = 8_000

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const OUT = arg('out') ?? mkdtempSync(join(tmpdir(), 'agent-city-smoke-out-'))
const ONLY = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean)
/** The software adapter renders a few frames a second: everything here waits on the page's own state, never on time. */
const BOOT_MS = Number(arg('boot-ms') ?? 240_000)

let failed = 0
const check = (ok, what, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`)
  return ok
}

/**
 * The page's light load for a software rasterizer: a small crowd and fleet, half-resolution, the cinema camera off (its
 * 24-frame cadence would only slow the input), no sound. The device profile, the controls and every shader are the
 * real ones; ?debug exposes window.__SIM__ and ?onboarding=0 starts in the city.
 */
const LIGHT = 'debug&onboarding=0&crowd=512&cars=8&scale=0.5&cinema=0&audio=0'

/** An iPhone 17 Pro in landscape, as Safari reports it (CSS pixels; a device pixel ratio of 1 keeps the software adapter fast). */
const IPHONE = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  width: 874,
  height: 402,
}

/**
 * Up to four pads the page reads through navigator.getGamepads, set from the test (axes, then pressed buttons). A pad is
 * standard-mapped unless connected with another mapping (a pad the browser does not recognise reports '').
 */
const PAD_SHIM = `(() => {
  const pads = [null, null, null, null]
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => pads.slice() })
  window.__smokePad = {
    connect(i = 0, mapping = 'standard') {
      const id = mapping === 'standard' ? 'Smoke Pad ' + i + ' (STANDARD GAMEPAD Vendor: 045e Product: 028e)' : 'Smoke Pad ' + i + ' (Vendor: 0079 Product: 0006)'
      const pad = { id, index: i, connected: true, mapping, timestamp: performance.now(), axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), vibrationActuator: null, hapticActuators: [] }
      pads[i] = pad
      const e = new Event('gamepadconnected'); e.gamepad = pad; window.dispatchEvent(e)
    },
    set(axes, pressed = [], i = 0) {
      const pad = pads[i]
      pad.axes = axes.slice()
      pad.buttons.forEach((b, k) => { b.pressed = pressed.includes(k); b.touched = b.pressed; b.value = b.pressed ? 1 : 0 })
      pad.timestamp = performance.now()
    },
  }
})()`

/** Counts animation frames, so a check can wait for the page to have read its input n more times. */
const FRAME_COUNTER = `(() => { window.__smokeFrames = 0; const tick = () => { window.__smokeFrames++; requestAnimationFrame(tick) }; requestAnimationFrame(tick) })()`

/**
 * Serves dist/index.html (and nothing else) on 127.0.0.1 with the isolation headers the dev and preview servers send.
 * `?smoke-cut` serves the first half of it, as a download cut off in the middle of the page's script would arrive.
 * `?smoke-slow` holds back the page's module script (everything from it on) for SLOW_HOLD_MS, as a phone on a slow
 * connection waits for the 10 MB of it.
 */
async function serve() {
  const html = readFileSync(DIST)
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x'), path = url.pathname
    if (path !== '/' && path !== '/index.html') { res.writeHead(404).end(); return }
    const body = url.searchParams.has('smoke-cut') ? html.subarray(0, Math.floor(html.length / 2)) : html
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cache-Control': 'no-store',
    })
    const held = url.searchParams.has('smoke-slow') ? html.indexOf('<script type="module"') : -1
    if (held < 0) { res.end(body); return }
    res.write(html.subarray(0, held))
    setTimeout(() => res.end(html.subarray(held)), SLOW_HOLD_MS)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, origin: `http://127.0.0.1:${server.address().port}`, port: server.address().port }
}

/** A page, its errors and its console, with the helpers the scenarios share. */
class Page {
  errors = []
  console = []
  constructor(browser) {
    this.b = browser
    browser.on('Runtime.exceptionThrown', (p) => this.errors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text))
    browser.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
      this.console.push(`[${p.type}] ${text}`)
    })
  }
  eval(x) { return this.b.eval(x) }
  waitFor(x, ms = 60_000) { return this.b.waitFor(x, ms) }
  async goto(url) {
    await this.b.send('Page.navigate', { url })
  }
  /**
   * Waits for the engine (window.__SIM__), a few rendered frames, and the boot veil lifting: it takes every touch and
   * click while it covers the page (BootVeil.tsx holds it half a second after the first frame), and a person waits for
   * the city to show before touching it too.
   */
  async booted() {
    await this.waitFor('!!window.__SIM__ && window.__SIM__.snapshot().output.fps > 0', BOOT_MS)
    await this.waitFor(`!document.querySelector('.boot-veil[data-phase="cover"]')`, 30_000)
  }
  snap() {
    // On foot the avatar's capsule; at the wheel the driven car's pose (POSE: x at 0, z at 2, 28 floats a body).
    return this.eval(`(() => { const S = window.__SIM__, s = S.snapshot(), e = S.engine, st = e.sim.state
      const a = st.driving >= 0 ? { x: st.poses[st.driving * 28], z: st.poses[st.driving * 28 + 2] } : st.avatar
      return { mode: s.input.mode, near: s.input.nearVehicle, device: s.supplier.device, touch: s.supplier.touch, gpu: s.process.gpu,
        crowdFrames: s.process.crowdFrames, fps: s.output.fps, ghost: s.output.ghost, matrix: s.output.matrix,
        x: a.x, z: a.z, yaw: e.input.yaw, pitch: e.input.pitch, driving: e.sim.state.driving, errors: S.errors().slice(0, 5) } })()`)
  }
  /** Waits until at least `n` more animation frames have run (FRAME_COUNTER's count): input is read once a frame. */
  async frames(n) {
    const start = await this.eval('window.__smokeFrames')
    await this.waitFor(`window.__smokeFrames >= ${start + n}`, 60_000)
  }
  key(type, code, key, vk) {
    return this.b.send('Input.dispatchKeyEvent', { type, code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: type === 'keyDown' && key.length === 1 ? key : undefined })
  }
  async tap(code, key, vk) {
    await this.key('keyDown', code, key, vk)
    await this.key('keyUp', code, key, vk)
  }
  async type(text) {
    for (const ch of text) await this.b.send('Input.dispatchKeyEvent', { type: 'char', text: ch })
  }
  mouse(type, x, y, buttons = 0) {
    return this.b.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? (buttons ? 'left' : 'none') : 'left', buttons, clickCount: 1 })
  }
  touch(type, points) {
    return this.b.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y, id]) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) })
  }
  async shot(name) {
    try { writeFileSync(join(OUT, `${name}.png`), await this.b.screenshot()) } catch (e) { console.log(`      (no screenshot: ${e.message})`) }
  }
  /** The checks every scenario ends with: nothing thrown, no GPU error, no CPU flow field. */
  health(name) {
    const gpuErrors = this.console.filter((l) => /WebGPU|GPUValidationError|uncaptured|Device Lost|device lost/i.test(l) && !/experimental on this platform/.test(l))
    check(this.errors.length === 0, `${name}: no exception in the page`, this.errors.slice(0, 3).join(' | ').slice(0, 400))
    check(gpuErrors.length === 0, `${name}: no WebGPU error or lost device`, gpuErrors.slice(0, 3).join(' | ').slice(0, 400))
    const cpuFlow = this.console.find((l) => /flow field is solved on the CPU/.test(l))
    check(!cpuFlow, `${name}: the crowd's flow field runs on the GPU`, cpuFlow?.slice(0, 300))
  }
}

async function open(chrome, { mobile = false, width = 960, height = 540, args = [] } = {}) {
  const b = await Browser.launch(chrome, [...SOFTWARE_WEBGPU, `--window-size=${width},${height}`, ...args])
  const page = new Page(b)
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: PAD_SHIM })
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: FRAME_COUNTER })
  if (mobile) {
    await b.send('Emulation.setUserAgentOverride', { userAgent: IPHONE.userAgent, platform: 'iPhone' })
    await b.send('Emulation.setDeviceMetricsOverride', { width: IPHONE.width, height: IPHONE.height, deviceScaleFactor: 1, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } })
    await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  } else {
    await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  }
  return page
}

/** A page expression: the car nearest player k's avatar, told to park; its index, or −1 without one. */
const nearestCarParked = (k) => `(() => { const e = window.__SIM__.engine, st = e.sim.state, a = st.avatars[${k}]
  let best = -1, d = Infinity
  for (let i = 0; i < e.sim.meta.count; i++) { const q = (st.poses[i * 28] - a.x) ** 2 + (st.poses[i * 28 + 2] - a.z) ** 2; if (q < d) { d = q; best = i } }
  if (best >= 0) window.__SIM__.sim.send({ c: 'setMode', i: best, mode: 'parked' })
  return best })()`
/** Where to stand beside a parked car to reach its door, tried in turn (the car's heading is not known here). */
const SIDES = [[2.6, 0], [-2.6, 0], [0, 2.6], [0, -2.6]]

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
/** Signed difference of two yaws, wrapped to (−π, π]. */
const turn = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a))

/** Serves a folder the way a static host such as GitHub Pages does: its files by name, the folder's index, and no isolation headers. */
async function serveStatic(dir) {
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png' }
  const files = new Set(readdirSync(dir))
  const server = createServer((req, res) => {
    const name = new URL(req.url ?? '/', 'http://x').pathname.slice(1) || 'index.html'
    if (!files.has(name)) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': TYPES[extname(name)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(readFileSync(join(dir, name)))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close() } }
}

/** Navigates again to `url` and waits until the new document has booted (the old one is marked, so it cannot answer). */
async function reload(p, url) {
  await p.eval('window.__smokeOld = true')
  await p.goto(url)
  await p.waitFor('document.readyState !== "loading" && !window.__smokeOld', 60_000)
  await p.booted()
}

const SCENARIOS = {
  async desktop(chrome, origin) {
    const p = await open(chrome)
    try {
      await p.goto(`${origin}/?${LIGHT}`)
      await p.booted()
      let s = await p.snap()
      check(/swiftshader|google/i.test(s.gpu), 'desktop: the city boots on the software WebGPU adapter', s.gpu)
      check(s.device === 'keyboard+mouse' && !s.touch, 'desktop: the input supplier is the keyboard and mouse', `${s.device} touch=${s.touch}`)
      const f0 = s.crowdFrames
      const advanced = await p.waitFor(`window.__SIM__.snapshot().process.crowdFrames > ${f0 + 2}`, 60_000).then(() => true, () => false)
      check(advanced, 'desktop: the crowd simulation advances', `${f0} -> ${(await p.snap()).crowdFrames}`)
      const cards = await p.eval(`document.querySelectorAll('[data-failure]').length + (window.__bootDone === true ? 0 : 100)`)
      check(cards === 0, 'desktop: a city that started has no recovery card, and the boot watchdog stood down', `cards+watchdog=${cards}`)
      // The physics worker reports how many rooms its crowd was handed (SimMeta.rooms).
      const rooms = await p.eval('window.__SIM__.engine.sim.meta.rooms')
      check(rooms === 6, 'desktop: the city\'s six indoor workplaces reached the crowd', `${rooms} rooms`)

      // Walk: W held (layout-independent code), the avatar moves.
      await p.mouse('mousePressed', 480, 270, 1)
      await p.mouse('mouseReleased', 480, 270)
      const w0 = await p.snap()
      await p.key('keyDown', 'KeyW', 'w', 87)
      await p.frames(8)
      await p.key('keyUp', 'KeyW', 'w', 87)
      await p.frames(2)
      const w1 = await p.snap()
      check(dist(w0, w1) > 0.5, 'desktop: W walks the avatar', `${dist(w0, w1).toFixed(2)} m`)

      // Look: a drag with the button held turns the head (headless browsers cannot take pointer lock).
      const l0 = await p.snap()
      await p.mouse('mousePressed', 600, 300, 1)
      for (let i = 1; i <= 6; i++) await p.mouse('mouseMoved', 600 + i * 20, 300 - i * 4, 1)
      await p.mouse('mouseReleased', 720, 276)
      await p.frames(2)
      const l1 = await p.snap()
      check(Math.abs(turn(l0.yaw, l1.yaw)) > 0.05, 'desktop: dragging the mouse turns the head', `yaw ${turn(l0.yaw, l1.yaw).toFixed(3)} rad, pitch ${(l1.pitch - l0.pitch).toFixed(3)}`)

      // Gamepad: left stick forward walks, right stick turns.
      await p.eval('window.__smokePad.connect()')
      await p.frames(2)
      const g0 = await p.snap()
      await p.eval('window.__smokePad.set([0, -1, 0.9, 0])')
      await p.frames(8)
      await p.eval('window.__smokePad.set([0, 0, 0, 0])')
      await p.frames(2)
      const g1 = await p.snap()
      check(dist(g0, g1) > 0.5, 'desktop: a gamepad\'s left stick walks the avatar', `${dist(g0, g1).toFixed(2)} m, device ${g1.device}`)
      check(Math.abs(turn(g0.yaw, g1.yaw)) > 0.05, 'desktop: a gamepad\'s right stick turns the head', `${turn(g0.yaw, g1.yaw).toFixed(3)} rad`)

      // Ghost view and rain mode from their keys.
      await p.tap('KeyG', 'g', 71)
      await p.frames(2)
      check((await p.snap()).ghost === true, 'desktop: G turns ghost view on')
      await p.tap('KeyG', 'g', 71)
      await p.tap('KeyM', 'm', 77)
      await p.frames(2)
      const m = await p.snap()
      check(m.ghost === false && m.matrix === true, 'desktop: G turns it off again and M turns rain mode on', `ghost ${m.ghost} rain ${m.matrix}`)
      await p.tap('KeyM', 'm', 77)

      // The console: tilde opens it, a command answers, and typing in it never moves the avatar.
      await p.tap('Backquote', '`', 192)
      await p.waitFor(`!!document.querySelector('[aria-label$="Ring-0 terminal"][data-open]')`, 10_000).then(() => true, () => false)
        .then((ok) => check(ok, 'desktop: the tilde key opens the Ring-0 console'))
      const t0 = await p.snap()
      await p.type('version')
      await p.tap('Enter', 'Enter', 13)
      const answered = await p.waitFor(`/\\d+\\.\\d+\\.\\d+/.test(document.querySelector('[role="log"][aria-label="Ring-0 output"]')?.textContent ?? '')`, 15_000).then(() => true, () => false)
      check(answered, 'desktop: the console answers `version`')
      await p.key('keyDown', 'KeyW', 'w', 87)
      await p.frames(4)
      await p.key('keyUp', 'KeyW', 'w', 87)
      const t1 = await p.snap()
      check(dist(t0, t1) < 0.05, 'desktop: typing W in the console does not walk the avatar', `${dist(t0, t1).toFixed(3)} m`)
      await p.tap('Escape', 'Escape', 27)

      // A car: the nearest one is parked, the avatar stands beside it, E enters, W drives, E leaves.
      const car = await p.eval(nearestCarParked(0))
      let drove = false
      if (car >= 0) {
        await p.waitFor(`Math.abs(window.__SIM__.engine.sim.state.poses[${car} * 28 + 8]) < 0.2`, 60_000).catch(() => {})
        for (const [ox, oz] of SIDES) {
          await p.eval(`(() => { const P = window.__SIM__.engine.sim.state.poses; window.__SIM__.teleport(P[${car} * 28] + ${ox}, P[${car} * 28 + 2] + ${oz}) })()`)
          if (await p.waitFor('window.__SIM__.snapshot().input.nearVehicle', 15_000).then(() => true, () => false)) break
        }
        await p.tap('KeyE', 'e', 69)
        drove = await p.waitFor(`window.__SIM__.snapshot().input.mode === 'vehicle'`, 20_000).then(() => true, () => false)
      }
      check(drove, 'desktop: E enters the nearest car')
      if (drove) {
        const d0 = await p.snap()
        await p.key('keyDown', 'KeyW', 'w', 87)
        await p.frames(10)
        await p.key('keyUp', 'KeyW', 'w', 87)
        const d1 = await p.snap()
        check(dist(d0, d1) > 0.3, 'desktop: W drives the car', `${dist(d0, d1).toFixed(2)} m`)
        await p.tap('KeyE', 'e', 69)
        const out = await p.waitFor(`window.__SIM__.snapshot().input.mode === 'foot'`, 30_000).then(() => true, () => false)
        check(out, 'desktop: E leaves the car')
      }
      const e = await p.snap()
      check(e.errors.length === 0, 'desktop: the engine recorded no error', e.errors.join(' | ').slice(0, 300))
      await p.shot('desktop')
      p.health('desktop')
    } finally { await p.b.close() }
  },

  async phone(chrome, origin) {
    const p = await open(chrome, { mobile: true })
    try {
      await p.goto(`${origin}/?${LIGHT}`)
      await p.booted()
      const s0 = await p.snap()
      check(s0.touch === true, 'phone: an iPhone is treated as a touch device', `device ${s0.device}`)
      const tier = await p.eval('window.__SIM__.engine.quality.governor.tier')
      check(tier <= 2, 'phone: the governor keeps a phone at Medium or below', `tier ${tier}`)
      const buttons = await p.eval(`[...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean)`)
      check(buttons.includes('Run') && buttons.includes('Ping'), 'phone: the Run and Ping buttons are on screen', buttons.join(', '))

      const H = IPHONE.height
      // The stick: thumb down in its zone (bottom left), pushed up, held.
      const w0 = await p.snap()
      await p.touch('touchStart', [[100, H - 100, 1]])
      for (let i = 1; i <= 5; i++) await p.touch('touchMove', [[100, H - 100 - i * 10, 1]])
      await p.frames(8)
      await p.touch('touchEnd', [])
      await p.frames(2)
      const w1 = await p.snap()
      check(dist(w0, w1) > 0.5, 'phone: the virtual stick walks the avatar', `${dist(w0, w1).toFixed(2)} m`)

      // Look: a drag on the right half.
      const l0 = await p.snap()
      await p.touch('touchStart', [[600, 200, 2]])
      for (let i = 1; i <= 6; i++) await p.touch('touchMove', [[600 - i * 15, 200, 2]])
      await p.touch('touchEnd', [])
      await p.frames(2)
      const l1 = await p.snap()
      check(Math.abs(turn(l0.yaw, l1.yaw)) > 0.1, 'phone: a drag on the right half turns the head', `${turn(l0.yaw, l1.yaw).toFixed(3)} rad`)

      // Both thumbs at once: stick held while the other finger looks.
      const b0 = await p.snap()
      await p.touch('touchStart', [[100, H - 100, 3]])
      await p.touch('touchMove', [[100, H - 150, 3]])
      await p.touch('touchStart', [[100, H - 150, 3], [600, 200, 4]])
      for (let i = 1; i <= 6; i++) await p.touch('touchMove', [[100, H - 150, 3], [600 + i * 15, 200, 4]])
      await p.frames(6)
      await p.touch('touchEnd', [])
      await p.frames(2)
      const b1 = await p.snap()
      check(dist(b0, b1) > 0.3 && Math.abs(turn(b0.yaw, b1.yaw)) > 0.1, 'phone: walking and looking with two thumbs at once', `${dist(b0, b1).toFixed(2)} m, ${turn(b0.yaw, b1.yaw).toFixed(3)} rad`)

      // Every keyboard-only action has a way in on touch: the menu.
      const centre = (selector) => p.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
      const tapAt = async (c, id) => {
        await p.touch('touchStart', [[c[0], c[1], id]])
        await p.touch('touchEnd', [])
      }
      // The Menu button shown (two are placed while driving, one per orientation).
      const menuAt = () => p.eval(`(() => { const b = [...document.querySelectorAll('button[aria-label="Menu"]')].find((b) => b.getBoundingClientRect().width > 0); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
      const openMenu = async () => {
        const at = await menuAt()
        if (!at) return null
        await tapAt(at, 5)
        return p.waitFor(`(() => { const m = document.querySelector('[role="menu"]'); return m && [...m.querySelectorAll('button')].map((b) => b.textContent.trim()) })()`, 10_000).catch(() => null)
      }
      const tapItem = async (label) => {
        const c = await p.eval(`(() => { const b = [...document.querySelectorAll('[role="menu"] button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)})); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
        if (c) await tapAt(c, 6)
        return c !== null
      }
      const items = await openMenu()
      check(Array.isArray(items) && ['Console', 'Clock −1 h', 'Clock +1 h', 'Ghost view', 'Rain mode', 'Hide HUD'].every((x) => items.some((i) => i.startsWith(x))),
        'phone: a Menu button opens the console, the clock, ghost view, rain mode and the HUD', (items ?? ['no menu']).join(', '))
      if (Array.isArray(items)) {
        const h0 = await p.eval('window.__SIM__.engine.hours')
        await tapItem('Clock +1 h')
        await p.frames(2)
        const h1 = await p.eval('window.__SIM__.engine.hours')
        check(Math.abs((((h1 - h0) % 24) + 24) % 24 - 1) < 0.25, 'phone: Clock +1 h moves the clock an hour on', `${Number(h0).toFixed(2)} -> ${Number(h1).toFixed(2)}`)
        await tapItem('Ghost view')
        await p.frames(2)
        check((await p.snap()).ghost === true, 'phone: the menu turns ghost view on')
        await openMenu()
        await tapItem('Ghost view')
        await openMenu()
        await tapItem('Hide HUD')
        await p.frames(1)
        const shown = await openMenu()
        check(Array.isArray(shown) && shown.some((i) => i === 'Show HUD'), 'phone: the menu hides the HUD and offers to show it again')
        await tapItem('Show HUD')
        await openMenu()
        await tapItem('Console')
        const open = await p.waitFor(`!!document.querySelector('[aria-label$="Ring-0 terminal"][data-open]')`, 10_000).then(() => true, () => false)
        check(open, 'phone: the menu opens the Ring-0 console')
        const focused = await p.eval(`document.activeElement?.getAttribute('aria-label') === 'Ring-0 command line'`)
        check(focused, 'phone: the console\'s prompt has focus, so the on-screen keyboard comes up')
        // The console slides down over 160 ms: measure the button where it comes to rest.
        await p.waitFor(`document.querySelector('[aria-label$="Ring-0 terminal"]').getBoundingClientRect().top >= 0`, 5_000).catch(() => {})
        const close = await centre('.r0-close')
        check(close !== null, 'phone: the console shows a Close button on a touch screen')
        if (close) {
          await tapAt(close, 7)
          const shut = await p.waitFor(`!document.querySelector('[aria-label$="Ring-0 terminal"][data-open]')`, 10_000).then(() => true, () => false)
          check(shut, 'phone: Close shuts the console')
        }
      }

      /**
       * The touch layout on phones and tablets of every size, both ways up, and in landscape under browser bars (an
       * iPhone SE in Safari, a 360 dp Android phone in Chrome): each control on screen, none over another, the stick's
       * zone, the speedometer, Sloane's chip or her tallest card (the Controls list); the chip clear of the stick, the
       * minimap and the HUD's panels, and as wide as its buttons; the HUD's panels, with two of its messages raised at
       * each size, clear of the buttons and the stick's base; and the Menu's sheet inside the screen. Below 600 px
       * across, the card may give up the stick's inner edge. Leaves the iPhone in landscape.
       */
      const SIZES = [[874, 402], [667, 375], [956, 440], [568, 320], [640, 360], [1180, 820]]
      const VIEWS = [...SIZES.flatMap(([long, short]) => [[long, short], [short, long]]), [667, 325], [752, 280]]
      const rectOf = (selector) => `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom } })()`
      const buttonIn = (selector, text) => `(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.trim() === ${JSON.stringify(text)}); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`
      // A first visit's chip asks a name; skipped, it offers Controls, which opens Sloane's tallest card.
      const chipAt = await centre('[data-concierge="chip"]')
      if (chipAt && !(await centre('[data-concierge="chip-controls"]'))) {
        await tapAt(chipAt, 10)
        const skip = await p.waitFor(buttonIn('aside[data-concierge] button', 'Skip'), 10_000).catch(() => null)
        if (skip) await tapAt(skip, 11)
        const close = await p.waitFor(`(${rectOf('aside[data-concierge] button[aria-label="Close"]')}) && ${JSON.stringify(true)}`, 10_000).then(() => centre('aside[data-concierge] button[aria-label="Close"]'), () => null)
        if (close) await tapAt(close, 12)
      }
      const controlsChip = await p.waitFor(`!!document.querySelector('[data-concierge="chip-controls"]')`, 10_000).then(() => true, () => false)
      check(controlsChip, 'phone: Sloane\'s chip offers her Controls card once the name is skipped')
      const LAYOUT = `(() => {
        const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom } }
        const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
        const zone = [...document.querySelectorAll('div[aria-hidden]')].find((d) => d.style.width === '184px' && d.style.height === '184px')
        const layer = zone && zone.closest('.z-10')
        const buttons = layer ? [...layer.querySelectorAll('button')].filter(shown).map((b) => ({ name: b.getAttribute('aria-label') || b.textContent.trim(), ...box(b) })) : []
        const chip = document.querySelector('[data-concierge="chip"]')
        const pill = chip && (chip.closest('[role="group"]') || chip)
        const hud = (name) => { const e = document.querySelector(\`[data-hud="\${name}"]\`); return e && shown(e) ? box(e) : null }
        const panels = [...document.querySelectorAll('[data-hud="panel"]')].filter(shown).map((e) => ({ text: e.textContent.trim().slice(0, 24), ...box(e) }))
        const parts = pill ? [...pill.querySelectorAll('button')].filter(shown).map(box) : []
        return { w: innerWidth, h: innerHeight, zone: zone ? box(zone) : null, buttons, chip: pill && shown(pill) ? box(pill) : null, parts, minimap: hud('minimap'), speed: hud('speed'), panels }
      })()`
      const meets = (a, b) => a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1
      const inside = (a, w, h) => a.l >= -1 && a.t >= -1 && a.r <= w + 1 && a.b <= h + 1
      const layouts = async (mode, views = VIEWS) => {
        const bad = []
        for (const [width, height] of views) {
          {
            const portrait = height > width
            await p.b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true, screenOrientation: portrait ? { type: 'portraitPrimary', angle: 0 } : { type: 'landscapePrimary', angle: 90 } })
            await p.frames(3)
            // Two of the HUD's messages up at every size (they last six seconds): the car's long one, newest, and a short one.
            await p.eval(`(() => { const e = window.__SIM__.engine; e.toast('Clock', '18:00'); e.toast('Transit coach', 'Stick ▲ to drive · Brake to brake or reverse · Exit car to leave') })()`)
            await p.frames(2)
            const L = await p.eval(LAYOUT)
            const at = `${width}x${height}`
            if (!L.zone || L.w !== width) { bad.push(`${at}: no stick zone or the size did not take`); continue }
            for (const b of L.buttons) {
              if (!inside(b, L.w, L.h)) bad.push(`${at}: ${b.name} off screen`)
              if (meets(b, L.zone)) bad.push(`${at}: ${b.name} over the stick`)
              if (L.chip && meets(b, L.chip)) bad.push(`${at}: ${b.name} under Sloane's chip`)
              if (L.speed && meets(b, L.speed)) bad.push(`${at}: ${b.name} over the speedometer`)
            }
            if (L.chip && meets(L.chip, L.zone)) bad.push(`${at}: Sloane's chip over the stick`)
            if (L.chip && L.minimap && meets(L.chip, L.minimap)) bad.push(`${at}: Sloane's chip over the minimap`)
            if (L.chip && L.speed && meets(L.chip, L.speed)) bad.push(`${at}: Sloane's chip over the speedometer`)
            if (L.chip && L.panels.some((q) => meets(L.chip, q))) bad.push(`${at}: Sloane's chip over a HUD panel`)
            // The stick's base at rest: 116 px in the middle of its 184 px zone.
            const base = { l: L.zone.l + 34, t: L.zone.t + 34, r: L.zone.r - 34, b: L.zone.b - 34 }
            for (const q of L.panels) {
              const what = q.text ? `the HUD's "${q.text}"` : 'a HUD panel'
              for (const b of L.buttons) if (meets(q, b)) bad.push(`${at}: ${what} under ${b.name}`)
              if (meets(q, base)) bad.push(`${at}: ${what} over the stick`)
            }
            if (L.chip && L.parts.some((q) => q.l < L.chip.l - 1 || q.r > L.chip.r + 1)) bad.push(`${at}: Sloane's chip narrower than its buttons`)
            for (let i = 0; i < L.buttons.length; i++) for (let j = i + 1; j < L.buttons.length; j++) {
              if (meets(L.buttons[i], L.buttons[j])) bad.push(`${at}: ${L.buttons[i].name} over ${L.buttons[j].name}`)
            }
            if (!L.buttons.some((b) => b.name === 'Menu')) bad.push(`${at}: no Menu button`)
            const controls = await centre('[data-concierge="chip-controls"]')
            if (controls) await tapAt(controls, 13)
            const card = controls ? await p.waitFor(rectOf('aside[data-concierge="help"]'), 5_000).catch(() => null) : null
            if (!card) bad.push(`${at}: Sloane's Controls card did not open`)
            else {
              await p.frames(2)
              const settled = (await p.eval(rectOf('aside[data-concierge="help"]'))) ?? card
              if (!inside(settled, L.w, L.h)) bad.push(`${at}: Sloane's card runs off screen ${JSON.stringify(settled)}`)
              for (const b of L.buttons) if (meets(settled, b)) bad.push(`${at}: Sloane's card over ${b.name}`)
              if (L.w >= 600 && meets(settled, L.zone)) bad.push(`${at}: Sloane's card over the stick`)
              const shut = await centre('aside[data-concierge] button[aria-label="Close"]')
              if (shut) await tapAt(shut, 14)
              await p.waitFor(`!document.querySelector('aside[data-concierge]')`, 5_000).catch(() => bad.push(`${at}: Sloane's card did not close`))
            }
            const items = await openMenu()
            const sheet = await p.eval(`(() => { const m = document.querySelector('[role="menu"]'); if (!m) return null; const r = m.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom } })()`)
            if (!Array.isArray(items) || !sheet) bad.push(`${at}: the Menu did not open`)
            else if (!inside(sheet, L.w, L.h)) bad.push(`${at}: the Menu's sheet runs off screen ${JSON.stringify(sheet)}`)
            const again = await menuAt()
            if (again) await tapAt(again, 9)
            await p.waitFor(`!document.querySelector('[role="menu"]')`, 5_000).catch(() => bad.push(`${at}: the Menu did not close`))
          }
        }
        await p.b.send('Emulation.setDeviceMetricsOverride', { width: IPHONE.width, height: IPHONE.height, deviceScaleFactor: 1, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } })
        await p.frames(3)
        check(bad.length === 0, `phone: ${mode}, at ${views.length} phone and tablet views, every control is on screen and clear of the others, the stick, the speedometer, Sloane's chip and her card, the chip clear of the HUD, and the Menu opens inside the screen`, bad.slice(0, 24).join('; '))
      }
      await layouts('on foot')
      // The Menu opens with the other thumb on the stick, as Ping and Run do (a browser makes no click of a tap then).
      const mAt = await menuAt()
      if (mAt) {
        await p.touch('touchStart', [[100, H - 100, 20]])
        await p.touch('touchStart', [[100, H - 100, 20], [mAt[0], mAt[1], 21]])
        await p.touch('touchMove', [[100, H - 100, 20]])
        const opened = await p.waitFor(`!!document.querySelector('[role="menu"]')`, 5_000).then(() => true, () => false)
        await p.touch('touchEnd', [])
        check(opened, 'phone: the Menu opens with the other thumb holding the stick')
        await tapAt(mAt, 22)
        await p.waitFor(`!document.querySelector('[role="menu"]')`, 5_000).catch(() => {})
      }

      // A field on a touch screen reads at 16 px whatever its own size, so Safari does not zoom into it.
      const px = await p.eval(`(() => { const i = document.createElement('input'); i.className = 'text-[12px]'; document.body.append(i); const f = getComputedStyle(i).fontSize; i.remove(); return f })()`)
      check(px === '16px', 'phone: a 12 px text field reads at 16 px on a touch screen', px)
      // A mouse moving over a phone (a touch-first screen) leaves the touch overlay where it is.
      await p.mouse('mouseMoved', 300, 200)
      await p.mouse('mouseMoved', 340, 210)
      await p.frames(2)
      check((await p.snap()).touch === true, 'phone: a mouse moving over a touch-first screen keeps the touch controls')

      // Driving, held upright: the car's Ping, Reset and Exit car stay clear of the stick's zone.
      const car = await p.eval(nearestCarParked(0))
      let inCar = false
      if (car >= 0) {
        await p.waitFor(`Math.abs(window.__SIM__.engine.sim.state.poses[${car} * 28 + 8]) < 0.2`, 60_000).catch(() => {})
        for (const [ox, oz] of SIDES) {
          await p.eval(`(() => { const P = window.__SIM__.engine.sim.state.poses; window.__SIM__.teleport(P[${car} * 28] + ${ox}, P[${car} * 28 + 2] + ${oz}) })()`)
          if (await p.waitFor('window.__SIM__.snapshot().input.nearVehicle', 15_000).then(() => true, () => false)) break
        }
        const enter = await p.waitFor(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Enter car'); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`, 10_000).catch(() => null)
        if (enter) {
          await tapAt(enter, 8)
          inCar = await p.waitFor(`window.__SIM__.snapshot().input.mode === 'vehicle'`, 20_000).then(() => true, () => false)
        }
      }
      check(inCar, 'phone: the Enter car button enters the nearest car')
      if (inCar) {
        await layouts('driving')
        // A pad paired with the phone: its glyphs show, the touch buttons stay, and so does the layout around them.
        await p.eval(`window.__smokePad.connect(0)`)
        await p.eval(`window.__smokePad.set([0, 0, 0.6, 0])`)
        await p.frames(4)
        await p.eval(`window.__smokePad.set([0, 0, 0, 0])`)
        await p.frames(2)
        const glyphs = await p.eval(`window.__SIM__.snapshot().supplier.glyphs`)
        check(glyphs !== 'touch' && (await p.snap()).touch === true, 'phone: a paired pad shows its glyphs and the touch buttons stay', glyphs)
        await layouts('driving with a paired pad', [[874, 402], [752, 280], [667, 325]])
        await p.b.send('Emulation.setDeviceMetricsOverride', { width: IPHONE.height, height: IPHONE.width, deviceScaleFactor: 1, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } })
        await p.frames(3)
        const boxes = await p.eval(`(() => {
          const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom } }
          const zone = [...document.querySelectorAll('div[aria-hidden]')].find((d) => d.style.width === '184px' && d.style.height === '184px')
          const buttons = ['Ping', 'Reset', 'Exit car'].map((t) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === t))
          return zone && buttons.every(Boolean) ? { zone: box(zone), buttons: buttons.map(box) } : null })()`)
        const clear = !!boxes && boxes.buttons.every((b) => b.l >= boxes.zone.r || b.b <= boxes.zone.t)
        check(clear, 'phone: held upright while driving, Ping, Reset and Exit car stay clear of the stick', JSON.stringify(boxes))
        await p.shot('phone-portrait')
      }
      await p.shot('phone')
      p.health('phone')
    } finally { await p.b.close() }
  },

  async split(chrome, origin) {
    const p = await open(chrome)
    try {
      await p.goto(`${origin}/?${LIGHT}&players=2`)
      await p.booted()
      const views = await p.eval('window.__SIM__.snapshot().output.players?.count ?? 1')
      check(views === 2, 'split: ?players=2 cuts the screen in two', `${views} views`)
      // Seats go to the pads in turn: the first pad to appear takes player 2's seat, the next player 1's. A pad without
      // the standard mapping appears only once a face button wakes it (hal.ts), and that press does nothing more.
      await p.eval('window.__smokePad.connect(0)')
      await p.frames(2)
      await p.eval("window.__smokePad.connect(1, '')")
      await p.frames(4)
      const at = () => p.eval('(() => { const st = window.__SIM__.engine.sim.state; return { p1: st.avatars[0], p2: st.avatars[1], drivings: st.drivings.slice() } })()')
      const asleep = await at()
      await p.eval('window.__smokePad.set([0, -1, 0, 0], [], 1)')
      await p.frames(10)
      await p.eval('window.__smokePad.set([0, 0, 0, 0], [], 1)')
      check(dist(asleep.p1, (await at()).p1) < 0.05, 'split: a pad without the standard mapping moves nobody before a face button wakes it')
      await p.eval('window.__smokePad.set([0, 0, 0, 0], [0], 1)')
      await p.frames(2)
      await p.eval('window.__smokePad.set([0, 0, 0, 0], [], 1)')
      await p.frames(2)
      const a0 = await at()
      await p.eval('window.__smokePad.set([0, -1, 0, 0], [], 1)')
      await p.frames(10)
      await p.eval('window.__smokePad.set([0, 0, 0, 0], [], 1)')
      await p.frames(2)
      const a1 = await at()
      check(dist(a0.p1, a1.p1) > 0.5, 'split: a pad without the standard mapping walks player 1 (read by position)', `${dist(a0.p1, a1.p1).toFixed(2)} m`)

      // Player 2's pad (seat 1): south beside a parked car enters it for player 2, and again leaves it. A press is one
      // frame's edge: the release must be seen before the next press counts.
      const padTap = async (button) => {
        await p.eval(`window.__smokePad.set([0, 0, 0, 0], [${button}], 0)`)
        await p.frames(2)
        await p.eval('window.__smokePad.set([0, 0, 0, 0], [], 0)')
        await p.frames(2)
      }
      const car = await p.eval(nearestCarParked(1))
      let entered = false
      if (car >= 0) {
        await p.waitFor(`Math.abs(window.__SIM__.engine.sim.state.poses[${car} * 28 + 8]) < 0.2`, 60_000).catch(() => {})
        for (const [ox, oz] of SIDES) {
          await p.eval(`(() => { const P = window.__SIM__.engine.sim.state.poses; window.__SIM__.sim.send({ c: 'teleport', x: P[${car} * 28] + ${ox}, z: P[${car} * 28 + 2] + ${oz}, player: 1 }) })()`)
          await p.frames(4)
          await padTap(0)
          entered = await p.waitFor(`window.__SIM__.engine.sim.state.drivings[1] === ${car}`, 5_000).then(() => true, () => false)
          if (entered) break
        }
      }
      const d = await at()
      check(entered && d.drivings[0] === -1, 'split: player 2\'s pad enters a car for player 2, not player 1', JSON.stringify(d.drivings))
      if (entered) {
        await padTap(0)
        const out = await p.waitFor('window.__SIM__.engine.sim.state.drivings[1] === -1', 20_000).then(() => true, () => false)
        check(out, 'split: and leaves it again')
      }
      const e = await p.snap()
      check(e.errors.length === 0, 'split: the engine recorded no error', e.errors.join(' | ').slice(0, 300))
      await p.shot('split')
      p.health('split')
    } finally { await p.b.close() }
  },

  async file(chrome) {
    const p = await open(chrome)
    try {
      await p.goto(`${pathToFileURL(DIST).href}?${LIGHT}`)
      await p.booted()
      const iso = await p.eval('globalThis.crossOriginIsolated === true')
      check(!iso, 'file: opened from disk the page is not cross-origin isolated (the private-buffer bridge)')
      const s = await p.snap()
      const f0 = s.crowdFrames
      const ran = await p.waitFor(`window.__SIM__.snapshot().process.crowdFrames > ${f0 + 2}`, 60_000).then(() => true, () => false)
      check(ran, 'file: the city runs from dist/index.html with no server')
      await p.shot('file')
      p.health('file')
    } finally { await p.b.close() }
  },

  async ultra(chrome, origin) {
    const p = await open(chrome, { width: 640, height: 360 })
    try {
      await p.goto(`${origin}/?debug&onboarding=0&crowd=512&cars=8&scale=0.5&audio=0&quality=4`)
      await p.booted()
      await p.frames(3)
      const s = await p.snap()
      check(s.errors.length === 0, 'ultra: shadows, post and volumetrics compile and validate', s.errors.join(' | ').slice(0, 300))
      await p.shot('ultra')
      p.health('ultra')
    } finally { await p.b.close() }
  },

  async tty(chrome, origin) {
    const p = await open(chrome)
    try {
      await p.eval(`(() => { const n = navigator.gpu; if (n) { const r = n.requestAdapter.bind(n); window.__adapterAsks = 0; n.requestAdapter = (...a) => { window.__adapterAsks++; return r(...a) } } })()`).catch(() => {})
      await p.b.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { window.__adapterAsks = 0; const n = navigator.gpu; if (n) { const r = n.requestAdapter.bind(n); n.requestAdapter = (...a) => { window.__adapterAsks++; return r(...a) } } })()` })
      await p.goto(`${origin}/?boot=tty`)
      const up = await p.waitFor(`!!document.querySelector('[aria-label$="Ring-0 terminal"][data-full]')`, 30_000).then(() => true, () => false)
      check(up, 'tty: ?boot=tty opens the full-screen console')
      const asks = await p.eval('[window.__adapterAsks, document.querySelectorAll("canvas").length]')
      check(asks[0] === 0 && asks[1] === 0, 'tty: the console alone asks for no GPU and draws no canvas', `adapter requests ${asks[0]}, canvases ${asks[1]}`)
      await p.shot('tty')
      check(p.errors.length === 0, 'tty: no exception in the page', p.errors.slice(0, 3).join(' | ').slice(0, 400))
    } finally { await p.b.close() }
  },

  /**
   * The installable copy (tools/web/pwa.mjs, built here from dist/ into a temporary folder) served as a static host
   * serves it, to an iPhone's user agent: the browser reads the manifest through the page's policy, the icons load, the
   * service worker installs, the second load is cross-origin isolated by the worker's headers, and with the host gone
   * the city still starts, from the worker's copy.
   */
  async pwa(chrome) {
    const dir = mkdtempSync(join(tmpdir(), 'agent-city-web-'))
    buildWeb({ out: dir })
    const site = await serveStatic(dir)
    const p = await open(chrome, { mobile: true })
    try {
      const url = `${site.origin}/?${LIGHT}`
      await p.goto(url)
      await p.booted()
      const m = await p.b.send('Page.getAppManifest')
      const data = (() => { try { return JSON.parse(m.data ?? '') } catch { return null } })()
      check(data?.name === APP_NAME && (m.errors ?? []).length === 0, 'pwa: the browser reads the manifest the page names, through its policy', `${m.url} ${JSON.stringify(m.errors ?? []).slice(0, 200)}`)
      const icons = await p.eval(`Promise.all(${JSON.stringify(ICONS.map((i) => i.name))}.map((f) => fetch(f).then((r) => r.ok && r.headers.get('content-type'))))`)
      check(icons.every((t) => t === 'image/png'), 'pwa: the home-screen icons load', icons.join(', '))
      const active = await p.waitFor(`Promise.race([navigator.serviceWorker.ready.then((r) => r.active && r.active.state === 'activated'), new Promise((r) => setTimeout(() => r(false), 2000))])`, 120_000).then(() => true, () => false)
      check(active, 'pwa: the service worker installs and activates')
      await reload(p, url)
      const iso = await p.eval(`!!navigator.serviceWorker.controller && globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function'`)
      check(iso, 'pwa: from the second load the worker serves the page, isolated (the shared-memory bridge)')
      site.close()
      await reload(p, url)
      const s = await p.snap()
      const f0 = s.crowdFrames
      const ran = await p.waitFor(`window.__SIM__.snapshot().process.crowdFrames > ${f0 + 2}`, 60_000).then(() => true, () => false)
      check(ran && s.touch, 'pwa: with the host gone the city starts from the offline copy, touch controls up', `touch=${s.touch}`)
      await p.shot('pwa-offline')
      p.health('pwa')
    } finally {
      site.close()
      await p.b.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },

  async lakefront(chrome, origin) {
    const p = await open(chrome)
    try {
      await p.goto(`${origin}/?map=lakefront&${LIGHT}`)
      await p.booted()
      // The rooms as the page drew them (the lots it picked from the pack) and as the physics worker's crowd was handed
      // them (SimMeta.rooms: the worker builds them from the lots it was sent).
      const r = await p.eval(`(() => { const e = window.__SIM__.engine, s = window.__SIM__.snapshot()
        return { region: e.places !== null, window: e.streets !== null, drawn: e.rooms.length, crowd: e.sim.meta.rooms,
          people: s.process.pedestrians, working: s.process.working, errors: window.__SIM__.errors().slice(0, 5) } })()`)
      check(r.region && r.window, 'lakefront: ?map=lakefront walks the generated metropolis through its street window', `region ${r.region}, window ${r.window}`)
      check(r.people > 0, 'lakefront: the window has people', `${r.people} pedestrians`)
      check(r.drawn === 6 && r.crowd === 6, 'lakefront: six indoor workplaces drawn, and six reached the worker\'s crowd', `${r.drawn} drawn, ${r.crowd} in the worker's crowd`)
      check(Number.isInteger(r.working) && r.working >= 0, 'lakefront: the HUD counts who is at work indoors', `working ${r.working}`)
      const f0 = (await p.snap()).crowdFrames
      const advanced = await p.waitFor(`window.__SIM__.snapshot().process.crowdFrames > ${f0 + 2}`, 60_000).then(() => true, () => false)
      check(advanced, 'lakefront: the crowd simulation advances', `${f0} -> ${(await p.snap()).crowdFrames}`)
      check(r.errors.length === 0, 'lakefront: the engine recorded no error', r.errors.join(' | ').slice(0, 300))
      await p.shot('lakefront')
      p.health('lakefront')
    } finally { await p.b.close() }
  },

  /**
   * The ways out (src/07_Execute_Actions/RecoveryCard.tsx, bootFailure.ts, index.html's watchdog), each in its own
   * browser so one cannot leave the next a broken profile. The exception check stays; the GPU-error check is left out
   * where a lost or missing GPU is the point.
   */
  async fail(chrome, origin, port) {
    const cases = [
      ['no WebGPU, before the onboarding', () => noGpu(chrome, origin, false)],
      ['no WebGPU on a phone', () => noGpu(chrome, origin, true)],
      ['no WebGPU in Firefox on Android', () => androidFirefox(chrome, origin)],
      ['insecure origin', () => insecure(chrome, port)],
      ['no adapter', () => cardFor(chrome, `${origin}/?${LIGHT}`, 'no-adapter', 'No graphics adapter for WebGPU', NO_ADAPTER, 'fail-no-adapter')],
      ['a boot that never finishes', () => stillStarting(chrome, origin)],
      ['a download cut off', () => cutOff(chrome, origin)],
      ['a slow download', () => slowDownload(chrome, origin)],
      ['the page\'s device lost after the boot', () => pageDeviceLost(chrome, origin)],
      ['a realm halt for a lost crowd device', () => afterBoot(chrome, origin, 'halt',
        `window.__SIM__.engine.halt('Sensing Failure: pedestrian sensing stopped (GPU device lost (unknown): test).')`, 'gpu-reset', 'The graphics device was reset')],
      ['a frame that throws', () => afterBoot(chrome, origin, 'frame',
        `(() => { window.__SIM__.engine.frame = () => { throw new Error('smoke: a frame that throws') } })()`, 'frame', 'The city stopped drawing')],
    ]
    for (const [name, run] of cases) {
      try { await run() } catch (e) { check(false, `fail: ${name} ran to the end`, e instanceof Error ? e.message.slice(0, 400) : String(e)) }
    }
  },
}

/** Takes WebGPU away from the page (the init script runs before the page's own scripts). */
const NO_GPU = `delete Navigator.prototype.gpu`
/** A browser that has WebGPU but no adapter for this page (core or compatibility). */
const NO_ADAPTER = `GPU.prototype.requestAdapter = function () { return Promise.resolve(null) }`
/** An adapter request that never answers: the boot hangs with no failure to show. */
const HUNG = `GPU.prototype.requestAdapter = function () { return new Promise(() => {}) }`
/**
 * The page's device, whose loss the test decides: requestDevice's device is handed over with a `lost` that also
 * settles when window.__smokeLose(message) is called, as a driver reset would settle it (reason 'unknown'). Only the
 * page's device: an init script does not reach the physics worker. headless Chrome has no way to reset its software
 * adapter on demand, and the page's own destroy() reads as 'destroyed', which is not a loss.
 */
const LOSABLE = `(() => {
  const ask = GPUAdapter.prototype.requestDevice
  GPUAdapter.prototype.requestDevice = async function (...a) {
    const d = await ask.apply(this, a)
    let lose
    const fake = new Promise((r) => { lose = r })
    Object.defineProperty(d, 'lost', { configurable: true, value: Promise.race([d.lost, fake]) })
    window.__smokeLose = (message) => lose({ reason: 'unknown', message })
    return d
  }
})()`

/** The card on screen: its kind, headline, the text of the focused element, and its buttons. */
const CARD = `(() => {
  const c = document.querySelector('[role="alertdialog"][data-failure]')
  if (!c) return null
  return { kind: c.dataset.failure, headline: (c.querySelector('h1') || {}).textContent || '', focused: document.activeElement ? document.activeElement.textContent : '',
    buttons: [...c.querySelectorAll('button')].map((b) => b.textContent), text: c.textContent }
})()`

/** Waits for the card of `kind` and checks its headline, its buttons and that Restart has focus. */
async function expectCard(p, what, kind, headline, buttons = ['Restart', 'Open the console']) {
  const card = await p.waitFor(`(() => { const c = ${CARD}; return c && c.kind === ${JSON.stringify(kind)} && c })()`, BOOT_MS).catch(() => null)
  const seen = card ?? (await p.eval(CARD).catch(() => null))
  check(!!card && card.headline === headline, `${what}: the ${kind} card says “${headline}”`, seen ? `${seen.kind}: ${seen.headline}` : 'no card')
  check(!!card && JSON.stringify(card.buttons) === JSON.stringify(buttons) && card.focused === 'Restart', `${what}: ${buttons.join(' and ')}, Restart focused`, card ? `${card.buttons} / focus ${card.focused}` : '')
  return card
}

/** Opens `url` in a fresh browser with `init` run before the page's scripts, and checks the card of `kind`. */
async function cardFor(chrome, url, kind, headline, init, shot) {
  const p = await open(chrome)
  try {
    await p.b.send('Page.addScriptToEvaluateOnNewDocument', { source: init })
    await p.goto(url)
    await expectCard(p, `fail ${kind}`, kind, headline)
    await p.shot(shot)
    check(p.errors.length === 0, `fail ${kind}: no exception in the page`, p.errors.slice(0, 3).join(' | ').slice(0, 400))
  } finally { await p.b.close() }
}

/**
 * Firefox on an Android phone (no WebGPU there), as a link tapped in another app opens it: the card's first button,
 * focused, hands the page to Chrome (its intent: address is pinned in bootFailure.test.ts; headless Chrome has no
 * Android to hand it to). Restart and Open the console stay.
 */
async function androidFirefox(chrome, origin) {
  const what = 'fail no-api (Firefox on Android)'
  const p = await open(chrome)
  try {
    await p.b.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0', platform: 'Linux armv8l' })
    await p.b.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 1, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } })
    await p.b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await p.b.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_GPU })
    await p.goto(`${origin}/?debug&audio=0`)
    const card = await p.waitFor(`(() => { const c = ${CARD}; return c && c.kind === 'no-api' && c })()`, BOOT_MS).catch(() => null)
    check(!!card && card.headline === 'Open this page in Chrome', `${what}: the card says “Open this page in Chrome”`, card ? card.headline : 'no card')
    check(!!card && JSON.stringify(card.buttons) === JSON.stringify(['Open in Chrome', 'Restart', 'Open the console']) && card.focused === 'Open in Chrome',
      `${what}: Open in Chrome first and focused, then Restart and Open the console`, card ? `${card.buttons} / focus ${card.focused}` : '')
    await p.shot('fail-no-gpu-android-firefox')
    check(p.errors.length === 0, `${what}: no exception in the page`, p.errors.slice(0, 3).join(' | ').slice(0, 400))
  } finally { await p.b.close() }
}

/**
 * navigator.gpu gone on a first visit (no ?onboarding=0): the probe shows the card instead of the onboarding. Enter
 * restarts (the page loads again, card and all); on the desktop a pad's d-pad moves to Open the console and A opens
 * the console shell.
 */
async function noGpu(chrome, origin, phone) {
  const what = phone ? 'fail no-api (phone)' : 'fail no-api'
  const p = await open(chrome, { mobile: phone })
  try {
    await p.b.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_GPU })
    await p.goto(`${origin}/?debug&audio=0`)
    const card = await expectCard(p, what, 'no-api', phone ? 'WebGPU is turned off in Safari' : 'This browser has no WebGPU')
    check(!!card && /needs WebGPU/.test(card.text), `${what}: the card says what the city needs`)
    const behind = await p.eval(`document.querySelectorAll('canvas').length + document.querySelectorAll('[role="alertdialog"]').length`)
    check(behind === 1, `${what}: the card alone, no onboarding or city behind it`, `canvases + dialogs = ${behind}`)
    await p.shot(phone ? 'fail-no-gpu-phone' : 'fail-no-gpu')
    if (phone) {
      // Held upright: the card fits the narrow screen (it scrolls inside itself where it must, never the page).
      await p.b.send('Emulation.setDeviceMetricsOverride', { width: IPHONE.height, height: IPHONE.width, deviceScaleFactor: 1, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } })
      await p.frames(2)
      const fits = await p.eval(`(() => { const r = document.querySelector('[role="alertdialog"] > div').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth })()`)
      check(fits, `${what}: upright, the card fits the screen with no sideways scroll`)
      await p.shot('fail-no-gpu-phone-upright')
      return
    }
    // Enter on the focused Restart: the page loads again (the old document is marked, so only a new one answers).
    await p.eval('window.__smokeOld = true')
    await p.b.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
    await p.b.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    const again = await p.waitFor(`!window.__smokeOld && !!document.querySelector('[data-failure="no-api"]')`, 60_000).then(() => true, () => false)
    check(again, `${what}: Enter restarts (the page loads again)`)
    // A pad: the d-pad moves focus to Open the console, A presses it.
    await p.eval('window.__smokePad.connect(0); window.__smokePad.set([0, 0, 0, 0], [])')
    await p.frames(4)
    await p.eval('window.__smokePad.set([0, 0, 0, 0], [13])')
    await p.frames(4)
    await p.eval('window.__smokePad.set([0, 0, 0, 0], [])')
    const moved = await p.waitFor(`document.activeElement && document.activeElement.textContent === 'Open the console'`, 10_000).then(() => true, () => false)
    check(moved, `${what}: the pad's d-pad moves focus to Open the console`)
    await p.frames(4)
    await p.eval('window.__smokePad.set([0, 0, 0, 0], [0])')
    const tty = await p.waitFor(`location.search.includes('boot=tty') && !!document.querySelector('[aria-label$="Ring-0 terminal"][data-full]')`, 60_000).then(() => true, () => false)
    check(tty, `${what}: the pad's A on Open the console opens the console shell (?boot=tty)`)
    await p.shot('fail-no-gpu-console')
    // And back: the console shell's pad (a new page: the pad connects again, A first held, as a real pad would be).
    await p.eval('window.__smokePad.connect(0); window.__smokePad.set([0, 0, 0, 0], [0])')
    await p.frames(4)
    check(await p.eval(`location.search.includes('boot=tty')`), `${what}: an A held into the console shell presses nothing`)
    await p.eval('window.__smokePad.set([0, 0, 0, 0], [])')
    await p.frames(4)
    await p.eval('window.__smokePad.set([0, 0, 0, 0], [0])')
    const back = await p.waitFor(`!location.search.includes('boot=tty') && !!document.querySelector('[data-failure="no-api"]')`, 60_000).then(() => true, () => false)
    check(back, `${what}: the pad's A on the console's Back to the city returns to the city (its card here)`)
    check(p.errors.length === 0, `${what}: no exception in the page`, p.errors.slice(0, 3).join(' | ').slice(0, 400))
  } finally { await p.b.close() }
}

/** A genuinely insecure origin: lan.test resolves to this machine and the page is opened over plain http. */
async function insecure(chrome, port) {
  // Chrome would first try lan.test over https (HttpsUpgrades); plain http is the point here.
  const p = await open(chrome, { args: ['--host-resolver-rules=MAP lan.test 127.0.0.1', '--disable-features=Translate,MediaRouter,HttpsUpgrades'] })
  try {
    await p.goto(`http://lan.test:${port}/?${LIGHT}`)
    const card = await expectCard(p, 'fail insecure', 'insecure', 'This page needs a secure address')
    const secure = await p.eval('window.isSecureContext')
    check(secure === false && !!card && card.text.includes(`http://lan.test:${port}`), 'fail insecure: the page really is insecure, and the card names its address', `isSecureContext=${secure}`)
    check(!!card && !/needs WebGPU/.test(card.text), 'fail insecure: no WebGPU line (the address is the problem)')
    await p.shot('fail-insecure')
    check(p.errors.length === 0, 'fail insecure: no exception in the page', p.errors.slice(0, 3).join(' | ').slice(0, 400))
  } finally { await p.b.close() }
}

/** An adapter request that never answers: after the veil's slow time the 'Still starting' line, nothing failed. */
async function stillStarting(chrome, origin) {
  const p = await open(chrome)
  try {
    await p.b.send('Page.addScriptToEvaluateOnNewDocument', { source: HUNG })
    await p.goto(`${origin}/?${LIGHT}`)
    const line = await p.waitFor(`(() => { const s = document.querySelector('.boot-veil [role="status"]'); return s && /Still starting/.test(s.textContent) && [...s.querySelectorAll('button')].map((b) => b.textContent).join(',') })()`, 90_000).catch(() => null)
    check(line === 'Restart,Open the console', 'fail stalled: after 20 s the veil says it is still starting, with Restart and Open the console', String(line))
    const said = await p.eval(`document.querySelector('.boot-veil [role="status"] p')?.textContent ?? ''`)
    check(said.includes('asking for the graphics device'), 'fail stalled: and names the step it is stuck on (the adapter request)', said)
    check(!(await p.eval(CARD)), 'fail stalled: and nothing is declared failed')
    await p.shot('fail-still-starting')
    check(p.errors.length === 0, 'fail stalled: no exception in the page', p.errors.slice(0, 3).join(' | ').slice(0, 400))
  } finally { await p.b.close() }
}

/** The first half of the page: the module is cut off, never runs, and the watchdog shows its card at load. */
async function cutOff(chrome, origin) {
  const p = await open(chrome)
  try {
    await p.goto(`${origin}/?smoke-cut&${LIGHT}`)
    const name = await p.waitFor(`document.querySelector('meta[name="application-name"]')?.content`, 30_000)
    await expectCard(p, 'fail cut-off', 'page', `${name} couldn’t start`, ['Restart'])
    await p.shot('fail-cut-off')
  } finally { await p.b.close() }
}

/**
 * A slow download: while the page's module is still on its way, the splash is already there (the module ends the body:
 * vite.config.ts moduleAfterBody), and once it arrives the city starts as usual.
 */
async function slowDownload(chrome, origin) {
  const p = await open(chrome)
  try {
    await p.goto(`${origin}/?smoke-slow&${LIGHT}`)
    const early = await p.waitFor(`document.readyState === 'loading' && !window.__bootDone && !!document.querySelector('#root .boot-veil') && 'splash'`, SLOW_HOLD_MS - 2_000).catch(() => null)
    const painted = await p.eval(`performance.getEntriesByType('paint').map((e) => e.name).join(',')`)
    check(early === 'splash', 'fail slow download: the splash is on the page while the module is still downloading', `paint entries: ${painted || 'none'}`)
    await p.booted()
    check(true, 'fail slow download: and the city starts once it has arrived')
    check(p.errors.length === 0, 'fail slow download: no exception in the page', p.errors.slice(0, 3).join(' | ').slice(0, 400))
  } finally { await p.b.close() }
}

/** Boots the light city with the page's device losable, loses it, and checks the reset card stays (no reload while visible). */
async function pageDeviceLost(chrome, origin) {
  const p = await open(chrome)
  try {
    await p.b.send('Page.addScriptToEvaluateOnNewDocument', { source: LOSABLE })
    await p.goto(`${origin}/?${LIGHT}`)
    await p.booted()
    await p.eval(`window.__smokeOld = true; window.__smokeLose('smoke: the driver reset')`)
    await expectCard(p, 'fail reset', 'gpu-reset', 'The graphics device was reset')
    await p.frames(30)
    const stayed = await p.eval(`window.__smokeOld === true && document.visibilityState === 'visible' && localStorage.getItem('civic-simulation:gpu-reload:v1') === null`)
    check(stayed, 'fail reset: lost while visible, the page does not reload by itself')
    const halted = await p.eval('window.__SIM__.engine.halted')
    check(halted === true, 'fail reset: the city halted (it draws nothing on a lost device)')
    await p.shot('fail-reset')
    check(p.errors.length === 0, 'fail reset: no exception in the page', p.errors.slice(0, 3).join(' | ').slice(0, 400))
  } finally { await p.b.close() }
}

/** Boots the light city, runs `act` in the page, and checks the card of `kind`. */
async function afterBoot(chrome, origin, name, act, kind, headline) {
  const p = await open(chrome)
  try {
    await p.goto(`${origin}/?${LIGHT}`)
    await p.booted()
    await p.eval(act)
    await expectCard(p, `fail ${name}`, kind, headline)
    await p.shot(`fail-${name}`)
    check(p.errors.length === 0, `fail ${name}: no exception in the page`, p.errors.slice(0, 3).join(' | ').slice(0, 400))
  } finally { await p.b.close() }
}

async function main() {
  if (!existsSync(DIST)) {
    console.error('dist/index.html is missing: run `npm run build` first')
    process.exit(2)
  }
  const chrome = findChrome(arg('chrome'))
  if (!chrome) {
    console.error('No Chrome or Chromium found: pass --chrome <path> or set CHROME')
    process.exit(2)
  }
  mkdirSync(OUT, { recursive: true })
  console.log(`browser  ${chrome}`)
  console.log(`shots    ${OUT}`)
  const { server, origin, port } = await serve()
  try {
    for (const [name, run] of Object.entries(SCENARIOS)) {
      if (ONLY && !ONLY.includes(name)) continue
      const t0 = Date.now()
      try { await run(chrome, origin, port) } catch (e) { check(false, `${name}: ran to the end`, e instanceof Error ? e.message.slice(0, 400) : String(e)) }
      console.log(`      ${name}: ${((Date.now() - t0) / 1000).toFixed(0)} s`)
    }
  } finally { server.close() }
  console.log(failed ? `${failed} check(s) failed` : 'every check passed')
  process.exit(failed ? 1 : 0)
}

main()
