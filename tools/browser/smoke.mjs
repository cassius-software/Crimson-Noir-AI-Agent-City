#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It is the browser smoke test of the built page (`npm run smoke:browser`): the 3D city booted
 * in a real Chrome or Chromium on the software WebGPU adapter (cdp.mjs SOFTWARE_WEBGPU), driven through the same input
 * events a person makes, on each kind of device the page has to work on:
 * - desktop: keyboard walking, a mouse drag turning the head, a gamepad (a standard-mapping pad stood in for the real
 *   one) walking and turning, the Ring-0 console opened with the tilde key and answering, typing in it never moving the
 *   avatar, ghost view and rain mode toggled from their keys, and a car entered, driven and left;
 * - phone: an iPhone's user agent, screen and touch (no mouse, no keyboard): the virtual stick walking, a drag on the
 *   right half turning the head, both thumbs at once, the Run and Ping buttons, and the menu that reaches what a
 *   keyboard reaches (the console, the clock, ghost view, rain mode, hiding the HUD);
 * - file: dist/index.html opened from disk, the way the README says to play, with no server and so no cross-origin
 *   isolation (the bridge's private-buffer path);
 * - ultra: the top tier pinned, so the shadowed, post and volumetric pipelines are compiled once and must validate;
 * - tty: the console alone (?boot=tty), which must not touch WebGPU at all.
 * Every scenario also fails on an exception in the page, a GPU validation error, a lost device, or the crowd's flow
 * field falling back to the CPU. It serves dist/ itself on 127.0.0.1 with the two isolation headers, writes a
 * screenshot per scenario to --out (default: a temporary directory), prints one row per check and exits 1 if any fails.
 * Usage: node tools/browser/smoke.mjs [--chrome <path>] [--out <dir>] [--only desktop,phone,...]. Needs `npm run build`.
 * What breaks if it is removed? Nothing at runtime; the page loses its only end-to-end check in a browser, and with it
 * the proof that the city renders and that every control reaches the avatar.
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Browser, findChrome, SOFTWARE_WEBGPU } from './cdp.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIST = join(ROOT, 'dist', 'index.html')

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

/** A standard-mapping pad the page reads through navigator.getGamepads, set from the test (axes, then button values). */
const PAD_SHIM = `(() => {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }))
  const pad = { id: 'Smoke Pad (STANDARD GAMEPAD Vendor: 045e Product: 028e)', index: 0, connected: true, mapping: 'standard',
    timestamp: 0, axes: [0, 0, 0, 0], buttons, vibrationActuator: null, hapticActuators: [] }
  let on = false
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => on ? [pad, null, null, null] : [null, null, null, null] })
  window.__smokePad = {
    connect() { on = true; pad.timestamp = performance.now(); const e = new Event('gamepadconnected'); e.gamepad = pad; window.dispatchEvent(e) },
    set(axes, pressed = []) {
      pad.axes = axes.slice()
      buttons.forEach((b, i) => { b.pressed = pressed.includes(i); b.touched = b.pressed; b.value = b.pressed ? 1 : 0 })
      pad.timestamp = performance.now()
    },
  }
})()`

/** Counts animation frames, so a check can wait for the page to have read its input n more times. */
const FRAME_COUNTER = `(() => { window.__smokeFrames = 0; const tick = () => { window.__smokeFrames++; requestAnimationFrame(tick) }; requestAnimationFrame(tick) })()`

/** Serves dist/index.html (and nothing else) on 127.0.0.1 with the isolation headers the dev and preview servers send. */
async function serve() {
  const html = readFileSync(DIST)
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path !== '/' && path !== '/index.html') { res.writeHead(404).end(); return }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cache-Control': 'no-store',
    }).end(html)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
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
  /** Waits for the engine (window.__SIM__) and a few rendered frames. */
  async booted() {
    await this.waitFor('!!window.__SIM__ && window.__SIM__.snapshot().output.fps > 0', BOOT_MS)
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

async function open(chrome, { mobile = false, width = 960, height = 540 } = {}) {
  const b = await Browser.launch(chrome, [...SOFTWARE_WEBGPU, `--window-size=${width},${height}`])
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

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
/** Signed difference of two yaws, wrapped to (−π, π]. */
const turn = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a))

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
      const car = await p.eval(`(() => { const e = window.__SIM__.engine, st = e.sim.state, a = st.avatar
        let best = -1, d = Infinity
        for (let i = 0; i < e.sim.meta.count; i++) { const k = (st.poses[i * 28] - a.x) ** 2 + (st.poses[i * 28 + 2] - a.z) ** 2; if (k < d) { d = k; best = i } }
        if (best >= 0) window.__SIM__.sim.send({ c: 'setMode', i: best, mode: 'parked' })
        return best })()`)
      let drove = false
      if (car >= 0) {
        await p.waitFor(`Math.abs(window.__SIM__.engine.sim.state.poses[${car} * 28 + 8]) < 0.2`, 60_000).catch(() => {})
        for (const [ox, oz] of [[2.6, 0], [-2.6, 0], [0, 2.6], [0, -2.6]]) {
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
      const openMenu = async () => {
        const at = await centre('button[aria-label="Menu"]')
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
      await p.shot('phone')
      p.health('phone')
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
  const { server, origin } = await serve()
  try {
    for (const [name, run] of Object.entries(SCENARIOS)) {
      if (ONLY && !ONLY.includes(name)) continue
      const t0 = Date.now()
      try { await run(chrome, origin) } catch (e) { check(false, `${name}: ran to the end`, e instanceof Error ? e.message.slice(0, 400) : String(e)) }
      console.log(`      ${name}: ${((Date.now() - t0) / 1000).toFixed(0)} s`)
    }
  } finally { server.close() }
  console.log(failed ? `${failed} check(s) failed` : 'every check passed')
  process.exit(failed ? 1 : 0)
}

main()
