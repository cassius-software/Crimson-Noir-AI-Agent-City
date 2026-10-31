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
 *   their keys, and a car entered, driven and left; and the software adapter left as every device that is not a Peak
 *   candidate is: its range stops at Ultra, three writes no GPU timestamps, and there is no Peak rule;
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
 *   isolation (the bridge's private-buffer path); the model in this page cannot run there (Chromium refuses the
 *   runtime's module worker on a page whose origin is opaque), so `ask file` opens no picker and keeps nothing, and
 *   the runtime row says why;
 * - ultra: the top tier of the table pinned, so the shadowed, post and volumetric pipelines are compiled once and must
 *   validate; then Peak pinned above it for a few frames (the 8192 shadow map really allocated, the sun's box at ±160 m,
 *   1.25 times the pixel ratio, detailed bodies to 90 m, the HUD reading Peak) and Ultra back after, with its map, box
 *   and pixels; the Nix job runs this one too;
 * - peak: a big desktop faked in full (16 threads, 8 GB, a WebGPU adapter reading 'nvidia / blackwell / NVIDIA GeForce
 *   RTX 5090'), at ?fps=1 without the camera so only Peak's GPU rule can move the tier, with three's timing resolve
 *   replaced, before the page's first frame, by one that counts and gives nothing. It starts on Ultra, never above,
 *   with no GPU reading. Where SwiftShader's device has timestamp-query (recorded), the range reaches Peak, the engine
 *   resolves timings for the governor on Ultra, auto keeps a pinned Peak, the in-page model's hold on the GPU brings it
 *   down to Ultra and the release keeps Ultra, and GPU readings fed over the limit bring it down by itself (gpu busy)
 *   with its map, box and pixels. Where it has none, the range stops at Ultra, nothing is resolved, and auto from a
 *   pinned Peak lands on Ultra. SwiftShader still draws it: this proves the path from the profile to the GPU rule and
 *   back, not a big card's speed;
 * - lite: the weakest phone the city serves, faked in full (an entry-level Android handset in Chrome: its user agent and
 *   client hints, 412 × 915 at a device pixel ratio of 2.625, touch, 4 GB, and a WebGPU adapter reading 'arm / bifrost'
 *   like a Mali-G52), loaded without the light load's crowd, cars and scale, so the device profile decides them: the
 *   Lite tier, 2,500 pedestrians, 12 cars, frames drawn, and the post chain never compiled. SwiftShader still draws
 *   it: this proves the path from the profile to the boot, not a Mali's speed. A model file picked from the Menu's
 *   Model file loads on the processor with the lite profile's row (4,096 tokens of context, at most two threads),
 *   the city's automatic tier (set to Minimal first) lowered to Lite while it loads and Minimal back after;
 * - inpage: the model kept in this page (09_Cognition/inPage.ts over wllama), cross-origin isolated and asked for two
 *   threads, with the tiny model tools/browser/tinyGguf.mjs writes (it answers "aaaa…" until its token limit):
 *   `ask file` through the console's own Enter and the browser's file picker, `ask gpu off`, someone who knows Design
 *   recruited from the crowd and asked, the city's automatic tier (set above the cap first) lowered to the cap while the
 *   model works and the tier from before back after, `ask stop` in the middle of an answer and the next answer whole
 *   (its reason, its token count and the hash of its prompt), the file still kept after a reload, the crash guard
 *   (the script stands in, `ask file load` clears it), a swarm step, and `ask gpu on` (whether the answer came from
 *   the GPU or the processor is recorded). The whole scenario is
 *   audited: every request from the page and from every worker it started (wllama's and its threads' among them)
 *   stays in blob:, data: or the page's own origin, no socket is opened, no security message is logged, and every
 *   worker the browser created was attached. Last, a worker the page makes from a blob is refused a fetch off this
 *   machine by the page's own policy (a CSP violation, not a failed name lookup);
 * - actions: a city action an agent proposes at the end of an answer (06_Make_Decisions/actions.ts, 07_Execute_Actions/
 *   acts.ts), driven with no model by the scripted provider chosen on purpose, with one tether (someone who knows
 *   Design): `ask design: make it night` proposes `set the clock to 22:00`, shown in the console with who proposes it,
 *   and waits (the clock unchanged); with the console closed the card takes focus on Refuse and the real Y key allows
 *   it, once (the clock, the HUD and the toast agree); the console opened again holds the card's decision and the done
 *   line, printed while it was closed; `n` refuses the next proposal and nothing changes; `ask stop` withdraws a
 *   waiting one; `operator lock` withdraws one and nothing waits past it, `act` reads while locked and `act ok` is
 *   refused; last, the proposer let go (`recruit dismiss`) ends a waiting proposal in the gateway's words (Aborted,
 *   Spatial Tether Lost), and `act log verify` shows every proposal, decision and end in a chain of 11 entries that
 *   verifies from genesis;
 * - tty: the console alone (?boot=tty), which must not touch WebGPU at all;
 * - pwa: the installable copy a phone plays (tools/web/pwa.mjs, built from dist/ into a temporary folder) served as a
 *   static host serves it, to an iPhone: the manifest read through the page's policy, the icons, the service worker
 *   installed, the second load cross-origin isolated by the worker, a model file kept from the Menu on that second
 *   visit, and the city started from the phone's copy with the host gone, the kept model still answering;
 * - lakefront: the generated metropolis (?map=lakefront, built in the page's worker from the seed), whose crowd walks
 *   its street window with the six workplaces the page picked from the pack and the HUD counting who is at work, at
 *   Medium, the first tier with shadows, so the sun's shadow pass draws the region's buildings and its shaders build;
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
 * field falling back to the CPU. Every browser can reach nothing but this machine (cdp.mjs loopbackOnly: no name
 * resolves but 127.0.0.1, and no proxy). It serves dist/ itself on 127.0.0.1 with the two isolation headers, writes a
 * screenshot per scenario to --out (default: a temporary directory), and the console's transcript where a scenario
 * types in it, prints one row per check (and an `info` row for what is recorded, not asserted) and exits 1 if any
 * fails.
 * Usage: node tools/browser/smoke.mjs [--chrome <path>] [--out <dir>] [--only desktop,phone,split,file,ultra,peak,lite,tty,pwa,inpage,actions,lakefront,fail].
 * Needs `npm run build`.
 * What breaks if it is removed? Nothing at runtime; the page loses its only end-to-end check in a browser, and with it
 * the proof that the city renders and that every control reaches the avatar.
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Browser, findChrome, loopbackOnly, SOFTWARE_WEBGPU, watchTargets } from './cdp.mjs'
import { HPARAMS, tinyGguf } from './tinyGguf.mjs'
import { APP_NAME, build as buildWeb, ICONS } from '../web/pwa.mjs'
import { eligible, onRoad, skillsOf } from '../../src/03_Spawn_Agents/skills.ts'
import { GUARD_KEY } from '../../src/09_Cognition/inPage.ts'

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
/** What is recorded, not asserted (an outcome that differs by browser or platform). */
const info = (what, detail = '') => console.log(`info  ${what}${detail ? `  (${detail})` : ''}`)

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

/**
 * The weakest phone the city serves, as Chrome on Android describes it (lite scenario): the reduced user agent, the
 * client hints that say mobile, a portrait 412 × 915 CSS-pixel screen at a device pixel ratio of 2.625, five touch points.
 */
const ANDROID = {
  userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  metadata: { platform: 'Android', platformVersion: '14.0.0', architecture: '', model: '', mobile: true },
  width: 412,
  height: 915,
  dpr: 2.625,
}

/**
 * Its GPU and memory, set before the page's scripts: WebGPU's adapter info (the adapter's and the device's copy) reads
 * vendor 'arm' and architecture 'bifrost', as Chrome reports a Mali-G52, every other field the real adapter's; and
 * navigator.deviceMemory reads 4. The page's render pipelines are counted too, with how many write two colour targets:
 * only the post chain's scene pass under the cinema camera does (colour and velocity), so none means it was never
 * compiled. An init script reaches the page, not the physics worker, which reads no adapter info.
 */
const MALI_G52 = `(() => {
  const fake = (real) => {
    if (!real) return real
    const out = {}
    for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(real))) if (k !== 'constructor') out[k] = real[k]
    return Object.assign(out, { vendor: 'arm', architecture: 'bifrost' })
  }
  const wrap = (proto, key) => {
    const d = Object.getOwnPropertyDescriptor(proto, key)
    if (d && d.get) Object.defineProperty(proto, key, { configurable: true, get() { return fake(d.get.call(this)) } })
  }
  if (typeof GPUAdapter !== 'undefined') wrap(GPUAdapter.prototype, 'info')
  if (typeof GPUDevice !== 'undefined') {
    wrap(GPUDevice.prototype, 'adapterInfo')
    window.__smokePipelines = { render: 0, twoTargets: 0 }
    const count = (desc) => {
      window.__smokePipelines.render++
      if ((desc && desc.fragment && desc.fragment.targets || []).length >= 2) window.__smokePipelines.twoTargets++
    }
    for (const key of ['createRenderPipeline', 'createRenderPipelineAsync']) {
      const own = GPUDevice.prototype[key]
      if (typeof own === 'function') GPUDevice.prototype[key] = function (desc) { count(desc); return own.call(this, desc) }
    }
  }
  Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => 4 })
})()`

/**
 * The peak scenario's big desktop GPU, set before the page's scripts: WebGPU's adapter info (the adapter's and the
 * device's copy) reads vendor 'nvidia', architecture 'blackwell' and description 'NVIDIA GeForce RTX 5090', as the
 * NixOS launcher's Chromium names that card (tools/web/launch.mjs gives the page the adapter's full name), every other
 * field the real adapter's; and navigator.deviceMemory reads 8. An init script reaches the page, not the physics
 * worker, which reads no adapter info.
 */
const BIG_GPU = `(() => {
  const fake = (real) => {
    if (!real) return real
    const out = {}
    for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(real))) if (k !== 'constructor') out[k] = real[k]
    return Object.assign(out, { vendor: 'nvidia', architecture: 'blackwell', description: 'NVIDIA GeForce RTX 5090' })
  }
  const wrap = (proto, key) => {
    const d = Object.getOwnPropertyDescriptor(proto, key)
    if (d && d.get) Object.defineProperty(proto, key, { configurable: true, get() { return fake(d.get.call(this)) } })
  }
  if (typeof GPUAdapter !== 'undefined') wrap(GPUAdapter.prototype, 'info')
  if (typeof GPUDevice !== 'undefined') wrap(GPUDevice.prototype, 'adapterInfo')
  Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => 8 })
})()`

/**
 * The peak scenario's timing resolve, put in place before the page's first frame: when App.tsx sets the debug handle
 * (window.__SIM__, assigned before the frame loop starts), three's resolveTimestampsAsync on that renderer becomes one
 * that counts its calls and gives nothing, so SwiftShader's own timings never reach the governor and every reading it
 * judges is one the scenario feeds.
 */
const STUB_RESOLVE = `(() => { let sim; window.__smokeResolves = 0; window.__smokeStubbed = false
  Object.defineProperty(window, '__SIM__', { configurable: true, get: () => sim, set(v) { sim = v
    // A renderer not where it is expected must not break the boot: the scenario's first check reports it.
    try {
      v.engine.gpu.renderer.resolveTimestampsAsync = () => { window.__smokeResolves++; return Promise.resolve(undefined) }
      window.__smokeStubbed = true
    } catch { /* __smokeStubbed stays false */ } } }) })()`

/** The tier as the governor, the snapshot, the sun's shadow, the canvas and the crowd cull show it (ultra, peak). */
const PEAK_STATE = `(() => { const S = window.__SIM__, s = S.snapshot(), e = S.engine, g = e.quality.governor, sh = e.world.sun.shadow, c = sh.camera
  return { tier: g.tier, label: s.quality.label, auto: s.quality.auto, held: s.quality.held ?? null, reason: g.reason, peak: s.quality.peak ?? null,
    min: g.min, max: g.max, timestamps: e.gpu.timestamps, mapSize: sh.mapSize.x, mapWidth: sh.map ? sh.map.width : 0,
    box: [c.left, c.right, c.top, c.bottom].join(','), ratio: e.gpu.renderer.getPixelRatio(), lod: e.quality.live.cull.lodDistance,
    errors: S.errors().slice(0, 5) } })()`

/** The in-page model's runtime, asked for the GPU, saying its worker found no adapter (ggml's WebGPU backend; echoed under ?debug). */
const RUNTIME_NO_ADAPTER = /^\[\w+\] ggml_webgpu: Failed to get an adapter\b/

/** Counts animation frames, so a check can wait for the page to have read its input n more times. */
const FRAME_COUNTER = `(() => { window.__smokeFrames = 0; const tick = () => { window.__smokeFrames++; requestAnimationFrame(tick) }; requestAnimationFrame(tick) })()`

/**
 * Serves dist/index.html (and nothing else) on 127.0.0.1 with the isolation headers the dev and preview servers send.
 * `?smoke-cut` serves the first half of it, as a download cut off in the middle of the page's script would arrive.
 * `?smoke-slow` holds back the page's module script (everything from it on) for SLOW_HOLD_MS, as a phone on a slow
 * connection waits for the 14 MB of it.
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
  /** Every console command() and what it printed, for saveTranscript. */
  transcript = []
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
  /** Types `line` at the focused console prompt and presses Enter, as a person does (the command runs inside that keydown). */
  async enter(line) {
    await this.type(line)
    await this.tap('Enter', 'Enter', 13)
  }
  /**
   * Clears the console, enters `line` and waits until its scrollback matches `done`; returns the scrollback, one line
   * a row (or null after `ms`). Starting from an empty scrollback, everything read is what `line` printed.
   */
  async command(line, done, ms = 60_000) {
    await this.enter('clear')
    await this.waitFor(`(${CONSOLE_LOG}?.innerText ?? '').trim() === ''`, 10_000).catch(() => {})
    await this.enter(line)
    const t = await this.waitFor(`(() => { const t = ${CONSOLE_LOG}?.innerText ?? ''; return ${done}.test(t) && t })()`, ms).catch(() => null)
    this.transcript.push(`$ ${line}\n${t ?? `(nothing matching ${done} after ${ms} ms)\n${await this.eval(`${CONSOLE_LOG}?.innerText ?? ''`).catch(() => '')}`}`)
    return t
  }
  /** Writes every command's output so far to <out>/<name>-console.txt (a failed check's evidence). */
  saveTranscript(name) {
    try { writeFileSync(join(OUT, `${name}-console.txt`), this.transcript.join('\n\n')) } catch { /* the report still has the check rows */ }
  }
  /** Opens the Ring-0 console with the tilde key (a desktop), its prompt focused. */
  async openConsole() {
    await this.tap('Backquote', '`', 192)
    return this.waitFor(`!!document.querySelector('[aria-label$="Ring-0 terminal"][data-open]') && document.activeElement?.getAttribute('aria-label') === 'Ring-0 command line'`, 10_000).then(() => true, () => false)
  }
  /**
   * From now on the browser's file picker is answered with `paths`, as a person choosing those files would: the
   * picker is intercepted (Page.fileChooserOpened, which names the input it opened for) and that input given the files
   * (DOM.setFileInputFiles, which fires its change event). `choosers` counts the pickers the page opened.
   */
  async pickWith(paths) {
    this.picked = paths
    if (this.choosers !== undefined) return
    this.choosers = 0
    this.pickErrors = []
    this.b.on('Page.fileChooserOpened', (ev, sid) => {
      if (sid !== this.b.sessionId) return
      this.choosers++
      this.b.send('DOM.setFileInputFiles', { files: this.picked, backendNodeId: ev.backendNodeId }).catch((e) => this.pickErrors.push(e.message))
    })
    await this.b.send('Page.setInterceptFileChooserDialog', { enabled: true })
  }
  /**
   * The checks every scenario ends with: nothing thrown, no GPU error, no CPU flow field. The in-page model's runtime
   * logs (under ?debug) that it found no GPU adapter when asked for one in its worker: that is where the model ran
   * (the scenario records it), not an error of the city's GPU, so that one line is not counted.
   */
  health(name) {
    const gpuErrors = this.console.filter((l) => /WebGPU|GPUValidationError|uncaptured|Device Lost|device lost/i.test(l) && !/experimental on this platform/.test(l) && !RUNTIME_NO_ADAPTER.test(l))
    check(this.errors.length === 0, `${name}: no exception in the page`, this.errors.slice(0, 3).join(' | ').slice(0, 400))
    check(gpuErrors.length === 0, `${name}: no WebGPU error or lost device`, gpuErrors.slice(0, 3).join(' | ').slice(0, 400))
    const cpuFlow = this.console.find((l) => /flow field is solved on the CPU/.test(l))
    check(!cpuFlow, `${name}: the crowd's flow field runs on the GPU`, cpuFlow?.slice(0, 300))
    // three logs a shader it could not build and draws that object with a blank material instead: no exception, no GPU
    // error, only this line (a region's facade, whose shadow shader outgrew the longest string a browser holds, did so).
    const tsl = this.console.filter((l) => /^\[error\] THREE\.TSL:/.test(l))
    check(tsl.length === 0, `${name}: three built every shader (no TSL error)`, tsl.slice(0, 3).join(' | ').slice(0, 400))
  }
}

async function open(chrome, { mobile = false, width = 960, height = 540, args = [] } = {}) {
  // Nothing but this machine: one resolver switch (a scenario's own rules merged in), no proxy, no proxy variables.
  const net = loopbackOnly([...SOFTWARE_WEBGPU, `--window-size=${width},${height}`, ...args])
  const b = await Browser.launch(chrome, net.args, { env: net.env })
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

/** A browser faking the lite scenario's phone (ANDROID, MALI_G52) before any page loads. */
async function androidPhone(chrome) {
  const p = await open(chrome, { width: ANDROID.width, height: ANDROID.height })
  await p.b.send('Emulation.setUserAgentOverride', { userAgent: ANDROID.userAgent, platform: 'Linux armv8l', userAgentMetadata: ANDROID.metadata })
  await p.b.send('Emulation.setDeviceMetricsOverride', { width: ANDROID.width, height: ANDROID.height, deviceScaleFactor: ANDROID.dpr, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } })
  await p.b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await p.b.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: 8 }).catch(() => {})
  await p.b.send('Page.addScriptToEvaluateOnNewDocument', { source: MALI_G52 })
  return p
}

/**
 * A browser faking the peak scenario's big desktop (BIG_GPU, 16 threads) before any page loads. The user agent stays
 * the browser's own desktop one, with no touch, so the profile reads a desktop by the adapter alone.
 */
async function bigDesktop(chrome) {
  const p = await open(chrome, { width: 640, height: 360 })
  await p.b.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: 16 }).catch(() => {})
  await p.b.send('Page.addScriptToEvaluateOnNewDocument', { source: BIG_GPU })
  return p
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

/** The console's scrollback, as a page expression. */
const CONSOLE_LOG = `document.querySelector('[role="log"][aria-label="Ring-0 output"]')`

/** The tiny model's file name (tinyGguf.mjs: an 'a' on every step until max_tokens, never an end of text). */
const TINY = 'tiny-a.gguf'
let tinyDir = null
/** The tiny model, written once for this run into a temporary folder (never committed, never shipped): its path. */
function tinyModel() {
  tinyDir ??= mkdtempSync(join(tmpdir(), 'agent-city-gguf-'))
  const path = join(tinyDir, TINY)
  if (!existsSync(path)) writeFileSync(path, tinyGguf())
  return path
}

/**
 * The model in this page as the page plans it here (inPagePlan.ts ROWS and HOLD): a desktop on SwiftShader (an
 * adapter of unknown class, planned as integrated: 2,048 tokens an answer, 8,192 of context, the city held at Low),
 * the lite profile (4,096 of context, two threads at most, held at Lite) and a phone (512 tokens an answer). A load
 * asks for no more context than the model was trained on (inPage.ts withinTraining): the tiny model's 6,144, below
 * a computer's plan and above a phone's (tinyGguf.mjs HPARAMS says why).
 */
const DESKTOP_PLAN = Object.freeze({ maxTokens: 2048, ctx: 8192, heldTier: 1 })
const LITE_PLAN = Object.freeze({ ctx: 4096, threads: 2, heldTier: -1 })
const PHONE_MAX_TOKENS = 512

/** The context the tiny model loads with on the desktop: the plan's, no more than its training (inPage.ts). */
const DESKTOP_CTX = Math.min(DESKTOP_PLAN.ctx, HPARAMS.nCtxTrain)

/** The last line a command printed (its closing note, or its error), short enough for a report. */
const lastLine = (t) => (t ?? 'nothing printed in time').trim().split('\n').map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 240) ?? ''
/** Waits until `test()` holds or `ms` have passed. */
async function settle(test, ms) {
  for (const end = Date.now() + ms; !test() && Date.now() < end;) await new Promise((r) => setTimeout(r, 100))
}

/** The answer's line in a console scrollback (the tiny model's run of a's), or ''. */
const answerIn = (t) => (t ?? '').split('\n').map((l) => l.trim()).find((l) => /^a+$/.test(l)) ?? ''
/** An ask's end in the console: its closing note, its failure, or the script standing in (not its first line, "ask: Authorized…"). */
const ASK_DONE = /-- answered in|ask: (?!Authorized)|-- no reply --/
/** `ask file`'s end: the file kept, or why not (not its first line, "ask: choose the model file…"). */
const KEPT = /is kept in this page|ask: (?!choose the model file)/
/** `ask file load`'s end: the model loaded, or why not (not its first line, "ask: loading the model…"). */
const LOADED = /is loaded in this page|ask: (?!loading the model)/
/** Why a page opened from a file runs no model (inPageCaps.ts OPAQUE_REASON). */
const FILE_PAGE = /a page opened from a file cannot start the model's runtime/

/**
 * Forgets what every recruit remembers (operator), before an answer that must run its whole token limit. The tiny
 * model reads a byte as a token and its training context is 4,096, all the context the page asks for it (the plan's
 * 8,192 is a ceiling): each answer of a's is remembered and recalled into the next prompt, which leaves less room.
 */
const forgetAll = (p) => p.command('memory forget all', /memory: /)

/**
 * Every hold the in-page model puts on the city's tier, as it happens: the governor's hold() (which engine.ts
 * holdQuality calls) is wrapped in the page to note, for each call, the cap asked, the tier just before it, and the
 * tier and the quality state's `held` just after it (null: released). Returns how many were noted so far.
 */
const WATCH_HOLD = `(() => {
  if (!window.__smokeHeld) {
    const g = window.__SIM__.engine.quality.governor, hold = g.hold
    window.__smokeHeld = []
    g.hold = function (cap, now) {
      const before = this.state().tier
      const r = hold.call(this, cap, now)
      const s = this.state()
      window.__smokeHeld.push({ cap, before, tier: s.tier, held: s.held ?? null })
      return r
    }
  }
  return window.__smokeHeld.length
})()`

/**
 * Sets the city's automatic tier one above `cap` through the console, as a person would (`quality <n>`, then
 * `quality auto`, which keeps that tier), so the hold has a tier to lower: SwiftShader has long since stepped the
 * city down, and on the lite profile it starts at Lite. The governor steps down only after 2 s of slow frames, more
 * than the console takes to start the work that holds it. Returns the line `quality auto` printed and whether it holds.
 */
async function tierAbove(p, cap) {
  await p.command(`quality ${cap + 1}`, /tier -?\d/)
  const t = await p.command('quality auto', /\(auto\)/)
  return { ok: new RegExp(`tier ${cap + 1} \\S+ \\(auto\\)`).test(t ?? ''), line: lastLine(t) }
}

/** Runs `act`; returns its value, each hold noted while it ran ({ cap, before, tier, held }), and the tier and `held` now. */
async function holdsWhile(p, act) {
  const from = await p.eval(WATCH_HOLD)
  const value = await act()
  const r = await p.eval(`({ during: window.__smokeHeld.slice(${from}), after: { tier: window.__SIM__.snapshot().quality.tier, held: window.__SIM__.snapshot().quality.held ?? null } })`)
  return { value, ...r }
}
/**
 * The first hold lowered the tier from above `cap` to `cap` (held at it), the tier stayed at or below `cap` at every
 * hold while it ran, and the release brought back the tier from before the first hold, with nothing held after.
 */
const heldThenReleased = (h, cap) => {
  const first = h.during[0], last = h.during.at(-1)
  return h.during.length >= 2 && first.cap === cap && first.held === cap && first.before > cap && first.tier === cap
    && h.during.slice(0, -1).every((x) => x.tier <= cap) && last.held === null && last.tier === first.before && h.after.held === null
}
/** The holds as a short line for a report. */
const holdLine = (h) => `${h.during.map((x) => `${x.before}->${x.tier} (cap ${x.cap}, held ${x.held})`).join(', ')}; now tier ${h.after.tier}, held ${h.after.held}`

/**
 * Someone who knows `skill` tethered to the operator (Active), asked over with the console's own `recruit <skill>`
 * (the console must be open): the page's newest crowd frame is read, the nearest pedestrian with the skill
 * (skills.ts skillsOf) who may be asked over from a spot beside them (skills.ts eligible: on the sidewalk, within
 * earshot, no road between) is chosen, the avatar is stood on that spot and they are asked. They walk over in the
 * crowd's own time (slow on a software GPU), so each is given until they arrive or are let go; another person is tried
 * when one cannot come. Returns whether one is Active, with a note of each try for the report.
 */
async function tether(p, skill, tries = 6) {
  const notes = []
  await p.eval(`(() => { if (window.__smokeRecruits) return; window.__smokeRecruits = []; window.__SIM__.engine.recruitHost().onState((s) => { window.__smokeRecruits = s.recruits || [] }) })()`)
  const state = `(() => { const rs = window.__smokeRecruits || [], S = ${JSON.stringify(skill)}
    if (rs.some((r) => r.state === 'Active' && r.arrived && r.skills.includes(S))) return 'active'
    return rs.some((r) => r.skills.includes(S)) ? null : 'gone' })()`
  if ((await p.eval(state)) === 'active') return { ok: true, notes: ['one was tethered already'] }
  const tried = new Set()
  for (let i = 0; i < tries; i++) {
    const seen = await p.eval(`new Promise((resolve) => { const h = window.__SIM__.engine.recruitHost(); const off = h.onState((s) => {
      const f = s.crowdFrame; if (!f || f.length < 4 * h.agents) return; off()
      const xz = new Array(2 * h.agents); for (let k = 0; k < h.agents; k++) { xz[2 * k] = f[4 * k]; xz[2 * k + 1] = f[4 * k + 2] }
      resolve({ xz, me: h.operator() }) }) })`)
    if (!seen.me) return { ok: false, notes: [...notes, 'the operator is not on foot'] }
    const xz = Float32Array.from(seen.xz)
    let best = null
    for (let k = 1; 2 * k + 1 < xz.length; k++) {
      const x = xz[2 * k], z = xz[2 * k + 1]
      if (tried.has(k) || !skillsOf(k).includes(skill) || !Number.isFinite(x) || onRoad(x, z)) continue
      const d = Math.hypot(x - seen.me.x, z - seen.me.z)
      if (best && d >= best.d) continue
      for (const [ox, oz] of [[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]]) {
        const at = { x: x + ox, z: z + oz }
        if (!onRoad(at.x, at.z) && eligible(xz, k, at, skill) >= 0) { best = { k, at, d }; break }
      }
    }
    if (!best) return { ok: false, notes: [...notes, `nobody else with ${skill} on a sidewalk`] }
    tried.add(best.k)
    await p.eval(`window.__SIM__.teleport(${best.at.x}, ${best.at.z})`)
    await p.frames(3)
    // The recruiter's copy of the crowd is refreshed every 250 ms (recruitment.ts COPY_INTERVAL_MS).
    await new Promise((r) => setTimeout(r, 400))
    const t0 = Date.now()
    const said = lastLine(await p.command(`recruit ${skill.toLowerCase()}`, /recruit: (?!asking for)/, 30_000))
    if (!/is coming over/.test(said)) { notes.push(`agent ${best.k}: ${said}`); continue }
    const end = await p.waitFor(state, 180_000).catch(() => 'still walking after 180 s')
    notes.push(`agent ${best.k}: ${end} after ${Math.round((Date.now() - t0) / 1000)} s`)
    if (end === 'active') return { ok: true, notes }
  }
  return { ok: false, notes }
}

/**
 * A worker the page makes from a blob, which inherits the page's policy, fetching a name off this machine: what the
 * worker saw (its securitypolicyviolation events, and how the fetch ended).
 */
const CSP_PROBE_URL = 'https://example.invalid/csp-probe'
const CSP_PROBE = `new Promise((resolve) => {
  const src = "self.addEventListener('securitypolicyviolation', (e) => postMessage({ kind: 'violation', directive: e.effectiveDirective, blocked: e.blockedURI }));"
    + "fetch('${CSP_PROBE_URL}').then(() => postMessage({ kind: 'fetched' }), (e) => postMessage({ kind: 'failed', error: String(e) }))"
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
  const got = []
  const end = () => { w.terminate(); resolve(got) }
  w.onmessage = (m) => { got.push(m.data); if (got.some((g) => g.kind === 'violation') && got.some((g) => g.kind !== 'violation')) setTimeout(end, 200) }
  w.onerror = (e) => { got.push({ kind: 'error', error: String(e.message) }); end() }
  setTimeout(end, 10000)
})`

/** Taps (x, y) with one finger. */
async function tapAt(p, [x, y], id = 40) {
  await p.touch('touchStart', [[x, y, id]])
  await p.touch('touchEnd', [])
}

/** Opens the Menu (the button shown) and taps its item starting with `label` (scrolled to first, as a thumb would); false when either is not there. */
async function menuTap(p, label) {
  const at = await p.eval(`(() => { const b = [...document.querySelectorAll('button[aria-label="Menu"]')].find((b) => b.getBoundingClientRect().width > 0); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
  if (!at) return false
  await tapAt(p, at, 41)
  const item = await p.waitFor(`(() => { const b = [...document.querySelectorAll('[role="menu"] button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)})); if (!b) return null; b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`, 10_000).catch(() => null)
  if (!item) return false
  await tapAt(p, item, 42)
  return true
}

/** The console opened from the Menu (a touch screen), its prompt focused. */
async function menuConsole(p) {
  if (!(await menuTap(p, 'Console'))) return false
  return p.waitFor(`!!document.querySelector('[aria-label$="Ring-0 terminal"][data-open]') && document.activeElement?.getAttribute('aria-label') === 'Ring-0 command line'`, 10_000).then(() => true, () => false)
}

/** The Menu's item and the toasts' title for the model file (App.tsx MODEL_FILE). */
const MODEL_FILE = 'Model file'
/**
 * The tiny model picked from the Menu (a touch screen): the tap opens the picker, the file is kept, and the page says
 * so in a toast. Returns what was tapped and the toast's text, or null when none came.
 */
async function menuPick(p) {
  await p.pickWith([tinyModel()])
  const tapped = await menuTap(p, MODEL_FILE)
  const toast = await p.waitFor(`window.__SIM__.engine.toasts.find((t) => t.title === ${JSON.stringify(MODEL_FILE)} && !/^keeping/.test(t.body))?.body`, 120_000).catch(() => null)
  return { tapped, toast }
}
/** The toast a phone shows once the tiny model is kept (no load on a phone until something asks). */
const KEPT_ON_A_PHONE = new RegExp(`^${TINY.replace('.', '\\.')} is kept in this page \\(153 KB\\): the inpage provider answers with it now$`)

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
      // Not a Peak candidate (a software adapter): every such device boots as it did before Peak.
      const nc = await p.eval(PEAK_STATE)
      check(nc.max === 4 && nc.timestamps === false && nc.peak === null, 'desktop: a device that is not a Peak candidate keeps the range Minimal..Ultra, no GPU timestamps and no Peak rule', `range ${nc.min}..${nc.max}, timestamps ${nc.timestamps}, peak ${JSON.stringify(nc.peak)}`)

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
      // An item below the sheet's fold is scrolled to first, as a thumb would (the sheet scrolls past the room it has).
      const tapItem = async (label) => {
        const c = await p.eval(`(() => { const b = [...document.querySelectorAll('[role="menu"] button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)})); if (!b) return null; b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
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
        return { w: innerWidth, h: innerHeight, zone: zone ? box(zone) : null, buttons, chip: pill && shown(pill) ? box(pill) : null, parts, minimap: hud('minimap'), speed: hud('speed'), panels, verdict: layer ? layer.getAttribute('data-touch-layout') : null }
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
            // The overlay's own judge (src/04_Connect_Hardware/touchLayout.ts): finger-sized, on the size ladder, clear of each
            // other and of the system's swipe bands at the sides.
            if (L.verdict !== 'valid') bad.push(`${at}: the overlay judges its layout ${L.verdict ?? 'not at all'}`)
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
        check(bad.length === 0, `phone: ${mode}, at ${views.length} phone and tablet views, every control is on screen and clear of the others, the stick, the speedometer, Sloane's chip and her card, the chip clear of the HUD, the overlay's own judge says valid, and the Menu opens inside the screen`, bad.slice(0, 24).join('; '))
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
      // No model runs in a page opened from disk: its origin is opaque, and Chromium refuses the runtime's worker (a
      // module worker made from a blob: URL) there. So ask file opens no picker and keeps nothing, and the runtime row
      // says why (the picker is still intercepted, so one that opened would be counted).
      await p.pickWith([tinyModel()])
      // By now the concierge has greeted, its name field holding the keyboard: skipped, so the tilde reaches the page.
      await p.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Skip')?.click()`)
      check(await p.openConsole(), 'file: the tilde key opens the console')
      const kept = await p.command('ask file', KEPT, 60_000)
      check(p.choosers === 0 && FILE_PAGE.test(kept ?? '') && !/is kept in this page/.test(kept ?? ''),
        'file: ask file on a page opened from disk opens no picker, keeps nothing, and says a page opened from a file cannot run the model', `${p.choosers} picker(s); ${lastLine(kept)}`)
      await p.command('operator unlock', /unlocked/)
      await p.command('ask provider inpage', /provider\s+\S/)
      const status = await p.command('ask', /installed|ask: /, 60_000)
      const row = (status ?? '').split('\n').find((l) => /^\s*runtime\s/.test(l)) ?? ''
      check(FILE_PAGE.test(row) && !/runs it/.test(row) && /ask: a page opened from a file cannot start/.test(status ?? ''),
        'file: with the inpage provider chosen, the runtime row and ask say why the model cannot run here', `${row.trim().slice(0, 200)} | ${lastLine(status)}`)
      await p.shot('file')
      p.health('file')
    } finally {
      p.saveTranscript('file')
      await p.b.close()
    }
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
      // Peak pinned by hand for a few frames (any device may pin it): the 8192 shadow map really allocated, the sun's box at
      // ±160 m, 1.25 times the pixel ratio and detailed bodies to 90 m, every pipeline still validating; Ultra back after.
      // By now the concierge has greeted, its name field holding the keyboard: skipped, so the tilde reaches the page.
      await p.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Skip')?.click()`)
      check(await p.openConsole(), 'ultra: the console opens')
      await p.command('quality 5', /tier 5 Peak \(fixed\)/)
      const map = await p.waitFor('window.__SIM__.engine.world.sun.shadow.map?.width === 8192', 60_000).then(() => true, () => false)
      await p.frames(3)
      const pk = await p.eval(PEAK_STATE)
      check(map && pk.mapSize === 8192 && pk.box === '-160,160,160,-160' && Math.abs(pk.ratio - 0.625) < 1e-9 && pk.lod === 90 && pk.errors.length === 0,
        'ultra: Peak pinned allocates the 8192 shadow map, widens the sun\'s box to 160 m, draws at 1.25 times the pixel ratio and validates', JSON.stringify(pk))
      // The console cleared first (as command() waits for it), so the only Peak left on the page is the HUD's.
      await p.enter('clear')
      await p.waitFor(`(${CONSOLE_LOG}?.innerText ?? '').trim() === ''`, 10_000).catch(() => {})
      check(await p.eval(`document.body.innerText.includes('Peak')`), 'ultra: the HUD shows Peak')
      await p.shot('ultra-peak')
      await p.command('quality 4', /tier 4 Ultra \(fixed\)/)
      await p.frames(3)
      const back = await p.eval(PEAK_STATE)
      check(back.mapSize === 4096 && back.box === '-80,80,80,-80' && Math.abs(back.ratio - 0.5) < 1e-9 && back.lod === 45,
        'ultra: Ultra again gives the map, the box and the pixel ratio back', JSON.stringify(back))
      p.saveTranscript('ultra')
      p.health('ultra')
    } finally { await p.b.close() }
  },

  async peak(chrome, origin) {
    const p = await bigDesktop(chrome)
    try {
      // SwiftShader's own timings never reach the governor: three's resolve is replaced, before the first frame, by one
      // that counts and gives none (STUB_RESOLVE).
      await p.b.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB_RESOLVE })
      // ?fps=1: the governor holds a one-second frame, so SwiftShader's frames (outliers, counted at 250 ms) never read as
      // slow and no animation-frame rule moves the tier; ?cinema=0 removes the camera's. Only Peak's GPU rule acts here.
      await p.goto(`${origin}/?debug&onboarding=0&crowd=512&cars=8&scale=0.5&audio=0&cinema=0&fps=1`)
      await p.booted()
      const s = await p.eval(`(() => { const e = window.__SIM__.engine
        return { gpu: window.__SIM__.snapshot().process.gpu, memory: navigator.deviceMemory, cores: navigator.hardwareConcurrency,
          profile: e.profile, feature: e.gpu.device.features.has('timestamp-query'), stubbed: window.__smokeStubbed, state: ${PEAK_STATE} } })()`)
      check(s.stubbed === true, 'peak: the timing resolve is replaced before the first frame')
      check(s.gpu === 'nvidia / blackwell / NVIDIA GeForce RTX 5090' && s.memory === 8 && s.cores === 16, 'peak: the page sees the faked desktop (adapter, memory, threads)', `${s.gpu}, ${s.memory} GB, ${s.cores} threads`)
      check(JSON.stringify(s.profile) === JSON.stringify({ mobile: false, gpuClass: 'discrete', startTier: 4, lite: false }), 'peak: it profiles as a discrete desktop starting on Ultra, never above', JSON.stringify(s.profile))
      const st = s.state
      check(st.tier === 4 && st.label === 'Ultra' && st.auto === true && st.reason === '', 'peak: the governor starts it on Ultra in auto', JSON.stringify(st))
      check(st.timestamps === s.feature, 'peak: three writes GPU timestamps exactly where the device has timestamp-query', `timestamps ${st.timestamps}, feature ${s.feature}`)
      info(`peak: SwiftShader's device ${s.feature ? 'has' : 'lacks'} timestamp-query`, s.feature ? 'the GPU rule is driven end to end' : 'the range stops at Ultra; the no-evidence path is checked')
      // As in ultra: a first visit's concierge may hold the keyboard in its name field; skipped, the tilde reaches the page.
      await p.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Skip')?.click()`)
      check(await p.openConsole(), 'peak: the console opens')
      if (s.feature) {
        check(st.max === 5 && st.peak !== null && st.peak.off === false && st.peak.gpuMs === null, 'peak: with GPU timings a Peak candidate\'s automatic range reaches Peak, and no reading has reached the governor yet', `range ${st.min}..${st.max}, ${JSON.stringify(st.peak)}`)
        const read = await p.waitFor('window.__smokeResolves > 0', 30_000).then(() => true, () => false)
        check(read, 'peak: on Ultra in auto the engine resolves the GPU\'s timings for the governor')
        await p.command('quality 5', /tier 5 Peak \(fixed\)/)
        const auto = await p.command('quality auto', /tier 5 Peak \(auto\)/)
        check(!!auto, 'peak: auto keeps a pinned Peak on a range that reaches it', lastLine(auto))
        const map = await p.waitFor('window.__SIM__.engine.world.sun.shadow.map?.width === 8192', 60_000).then(() => true, () => false)
        const at = await p.eval(PEAK_STATE)
        check(map && at.mapSize === 8192 && at.box === '-160,160,160,-160' && Math.abs(at.ratio - 0.625) < 1e-9 && at.lod === 90, 'peak: Peak allocates the 8192 shadow map, the ±160 m box, 1.25 times the pixel ratio and bodies to 90 m', JSON.stringify(at))
        const held = await p.eval(`(() => { window.__SIM__.engine.holdQuality(4); return ${PEAK_STATE} })()`)
        check(held.tier === 4 && held.reason === 'held' && held.held === 4 && held.mapSize === 4096 && held.box === '-80,80,80,-80' && Math.abs(held.ratio - 0.5) < 1e-9,
          'peak: the in-page model\'s hold on the GPU brings Peak down to Ultra and gives the map, the box and the pixels back', JSON.stringify(held))
        await p.eval('window.__SIM__.engine.holdQuality(null)')
        await p.frames(10)
        const released = await p.eval(PEAK_STATE)
        check(released.tier === 4 && released.held === null && released.mapSize === 4096, 'peak: the release keeps Ultra: Peak is not allocated again at the end of an answer', JSON.stringify(released))
        await p.command('quality 5', /tier 5 Peak \(fixed\)/)
        await p.command('quality auto', /tier 5 Peak \(auto\)/)
        await p.eval('window.__smokeFeed = setInterval(() => window.__SIM__.engine.quality.governor.gpuSample(15, performance.now()), 50)')
        const down = await p.waitFor('window.__SIM__.engine.quality.governor.tier === 4', 60_000).then(() => true, () => false)
        const after = await p.eval(PEAK_STATE)
        check(down && after.reason === 'gpu busy' && after.mapSize === 4096 && after.box === '-80,80,80,-80' && Math.abs(after.ratio - 0.5) < 1e-9,
          'peak: GPU readings over the limit bring Peak down to Ultra through the engine (gpu busy), with its map, box and pixels', JSON.stringify(after))
        // The entry reading needs 24 readings since the calm stretch began, and on SwiftShader every new run of frames over
        // 250 ms moves that start (governor.ts sample, GOV.outlierMs), so the line may print the fed 15.0 or not yet a
        // reading. Either way the suffix is there with the untightened entry limit (a pinned-then-auto Peak is no failed
        // probe).
        const line = await p.command('quality', /tier 4 Ultra \(auto\) {2}scale 1\.00x {2}budget 1000\.0 ms {2}peak (?:15\.0|-)\/5\.0 ms/)
        check(!!line, 'peak: the quality line shows the Peak rule against the entry limit', lastLine(line))
        info('peak: the entry reading on the quality line', line && /peak 15\.0\//.test(line) ? 'the fed 15.0 ms' : 'not yet enough readings since the calm stretch began')
        await p.eval('clearInterval(window.__smokeFeed)')
      } else {
        check(st.max === 4 && st.peak === null, 'peak: without GPU timings the range stops at Ultra and there is no Peak rule', `range ${st.min}..${st.max}`)
        await p.eval('window.__smokeFeed = setInterval(() => window.__SIM__.engine.quality.governor.gpuSample(2, performance.now()), 50)')
        await p.frames(30)
        const still = await p.eval(`(() => ({ resolves: window.__smokeResolves, ...${PEAK_STATE} }))()`)
        check(still.resolves === 0 && still.tier === 4, 'peak: nothing is resolved, and readings fed by hand move nothing', JSON.stringify(still))
        await p.eval('clearInterval(window.__smokeFeed)')
        await p.command('quality 5', /tier 5 Peak \(fixed\)/)
        const auto = await p.command('quality auto', /tier 4 Ultra \(auto\)/)
        check(!!auto, 'peak: auto from a pinned Peak lands on Ultra where no GPU timings judge it', lastLine(auto))
        await p.frames(3)
        const back = await p.eval(PEAK_STATE)
        check(back.mapSize === 4096 && back.box === '-80,80,80,-80' && Math.abs(back.ratio - 0.5) < 1e-9, 'peak: Ultra again gives the map, the box and the pixels back', JSON.stringify(back))
      }
      await p.shot('peak')
      p.saveTranscript('peak')
      p.health('peak')
    } finally { await p.b.close() }
  },

  async lite(chrome, origin) {
    const p = await androidPhone(chrome)
    try {
      // Not the light load: its crowd, cars and scale would stand in for the defaults this scenario is here to see.
      await p.goto(`${origin}/?debug&onboarding=0&audio=0`)
      await p.booted()
      const s = await p.eval(`(() => { const S = window.__SIM__, s = S.snapshot(), e = S.engine, g = e.quality.governor
        return { quality: s.quality, reason: g.reason, min: g.min, max: g.max, pedestrians: s.process.pedestrians, vehicles: s.process.vehicles,
          agents: e.sim.meta.agents, cars: e.sim.meta.count, craft: e.sim.meta.craft, rigSlots: e.sim.meta.rigSlots, gpu: s.process.gpu,
          post: e.quality.live.post, ratio: e.gpu.renderer.getPixelRatio(), dpr: window.devicePixelRatio, crowdFrames: s.process.crowdFrames,
          mobile: navigator.userAgentData && navigator.userAgentData.mobile, memory: navigator.deviceMemory, pipelines: window.__smokePipelines } })()`)
      check(s.gpu === 'arm / bifrost' && s.mobile === true && s.memory === 4 && s.dpr === ANDROID.dpr, 'lite: the page sees the faked phone (adapter, client hints, memory, pixel ratio)', `${s.gpu}, mobile ${s.mobile}, ${s.memory} GB, dpr ${s.dpr}`)
      const q = s.quality
      check(q.tier === -1 && q.label === 'Lite' && q.auto === true && q.lite === true, 'lite: the governor starts it at tier -1, labelled Lite, in auto with the lite profile', JSON.stringify(q))
      check(s.reason === '' && s.min === -1 && s.max === 0, 'lite: it started there (no step yet), and its automatic range is Lite..Minimal', `reason '${s.reason}', range ${s.min}..${s.max}`)
      check(s.agents === 2500 && s.pedestrians === 2499, 'lite: 2,500 pedestrians simulated (the profile\'s default)', `${s.agents} simulated, ${s.pedestrians} besides the player`)
      check(s.cars === 12 && s.vehicles === 12, 'lite: 12 cars (the profile\'s default)', `${s.cars} in the realm, ${s.vehicles} reported`)
      check(s.craft === 0 && s.rigSlots === 0, 'lite: no scheduled craft and no ragdoll rigs in the realm', `craft ${s.craft}, rig slots ${s.rigSlots}`)
      check(Math.abs(s.ratio - 0.5) < 1e-9, 'lite: the canvas draws at half the CSS pixel edge whatever the device pixel ratio', `pixel ratio ${s.ratio}`)
      check(s.post === false && s.pipelines && s.pipelines.render > 0 && s.pipelines.twoTargets === 0, 'lite: the post chain is off and was never compiled (no colour-and-velocity pipeline)',
        s.pipelines ? `${s.pipelines.render} render pipelines, ${s.pipelines.twoTargets} with two targets` : 'not counted')
      const ran = await p.waitFor(`window.__SIM__.snapshot().process.crowdFrames > ${s.crowdFrames + 2} && window.__SIM__.snapshot().output.fps > 0`, 60_000).then(() => true, () => false)
      check(ran, 'lite: frames are drawn and the crowd runs')
      const hud = await p.eval(`document.body.innerText.includes('Lite')`)
      check(hud, 'lite: the HUD shows the tier as Lite')
      // The model in this page on the lite profile: picked from the Menu (the tap opens the picker), kept, loaded only
      // when asked, on the processor with the lite plan, the city held at Lite while it loads.
      const pick = await menuPick(p)
      check(pick.tapped && p.choosers === 1 && KEPT_ON_A_PHONE.test(pick.toast ?? ''), 'lite: Menu › Model file opens the picker from the tap and keeps the file, not loaded until asked',
        `${pick.tapped ? 'tapped' : 'no Menu item'}, ${p.choosers} picker(s); ${pick.toast}`)
      check(await menuConsole(p), 'lite: the Menu opens the console')
      const above = await tierAbove(p, LITE_PLAN.heldTier)
      check(above.ok, 'lite: quality 0, then quality auto, runs the city at Minimal in auto, above the hold\'s cap', above.line)
      const load = await holdsWhile(p, () => p.command('ask file load', LOADED, 180_000))
      const plan = /is loaded in this page \(CPU, (\d+) threads?, (\d+) tokens of context, in [\d.]+ s\)/.exec(load.value ?? '')
      check(!!plan && Number(plan[1]) >= 1 && Number(plan[1]) <= LITE_PLAN.threads && Number(plan[2]) === LITE_PLAN.ctx,
        `lite: ask file load runs it on the processor, ${LITE_PLAN.threads} threads at most, ${LITE_PLAN.ctx} tokens of context`, lastLine(load.value))
      check(heldThenReleased(load, LITE_PLAN.heldTier), 'lite: the city\'s automatic tier is lowered from Minimal to Lite while the model loads, and Minimal comes back after', holdLine(load))
      await p.shot('lite')
      p.health('lite')
    } finally { await p.b.close() }
    // The same phone with ?lite=0: the profile it had before (Minimal, 5,000 pedestrians, 36 cars), and the post chain
    // compiled at boot as on every uncapped device, which also shows the pipeline count above can see it.
    const q = await androidPhone(chrome)
    try {
      await q.goto(`${origin}/?debug&onboarding=0&audio=0&lite=0`)
      await q.booted()
      const s = await q.eval(`(() => { const S = window.__SIM__, s = S.snapshot(), e = S.engine
        return { quality: s.quality, agents: e.sim.meta.agents, cars: e.sim.meta.count, max: e.quality.governor.max, pipelines: window.__smokePipelines } })()`)
      check(s.quality.tier === 0 && s.quality.label === 'Minimal' && s.quality.lite === undefined && s.max === 2, 'lite: ?lite=0 gives the phone its old profile (Minimal, capped at Medium)', JSON.stringify(s.quality))
      check(s.agents === 5000 && s.cars === 36, 'lite: ?lite=0 simulates 5,000 pedestrians and 36 cars', `${s.agents}, ${s.cars}`)
      check(s.pipelines && s.pipelines.twoTargets > 0, 'lite: ?lite=0 compiles the post chain at boot (colour-and-velocity pipelines counted)',
        s.pipelines ? `${s.pipelines.render} render pipelines, ${s.pipelines.twoTargets} with two targets` : 'not counted')
      q.health('lite (?lite=0)')
    } finally { await q.b.close() }
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
      // The second visit keeps the model file (from the Menu, as on a phone).
      const pick = await menuPick(p)
      check(pick.tapped && p.choosers === 1 && KEPT_ON_A_PHONE.test(pick.toast ?? ''), 'pwa: the second visit keeps a model file from Menu › Model file',
        `${pick.tapped ? 'tapped' : 'no Menu item'}, ${p.choosers} picker(s); ${pick.toast}`)
      site.close()
      await reload(p, url)
      const s = await p.snap()
      const f0 = s.crowdFrames
      const ran = await p.waitFor(`window.__SIM__.snapshot().process.crowdFrames > ${f0 + 2}`, 60_000).then(() => true, () => false)
      check(ran && s.touch, 'pwa: with the host gone the city starts from the offline copy, touch controls up', `touch=${s.touch}`)
      // With the host gone the model kept on the second visit still answers: the runtime is in the page, the file in its storage.
      check(await menuConsole(p), 'pwa: the Menu opens the console offline')
      await p.command('operator unlock', /unlocked/)
      const t = await tether(p, 'Design')
      check(t.ok, 'pwa: someone who knows Design is tethered offline', t.notes.join('; '))
      const answer = await p.command('ask design: hi', ASK_DONE, 240_000)
      check(answerIn(answer).length === PHONE_MAX_TOKENS && /\(cut at the token limit\)/.test(answer ?? '') && p.choosers === 1,
        `pwa: with the host gone the model kept in this page answers: ${PHONE_MAX_TOKENS} a's (a phone's token limit), with no new pick`, `${answerIn(answer).length} a's; ${lastLine(answer)}`)
      await p.shot('pwa-offline')
      p.health('pwa')
    } finally {
      p.saveTranscript('pwa')
      site.close()
      await p.b.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },

  /**
   * The model kept in this page (see the file's comment): a desktop with four cores (so two threads), cross-origin
   * isolated, the tiny model picked through `ask file`. Every check reads what a person reads (the console, the
   * page's state); the operator tier's own result is read once, for what the console does not print (the token count
   * and the prompt's hash). The audit covers everything up to the CSP probe, which runs last: its refusal is the point.
   */
  async inpage(chrome, origin) {
    const model = tinyModel()
    const p = await open(chrome)
    const watch = await watchTargets(p.b)
    const url = `${origin}/?${LIGHT}`
    const max = DESKTOP_PLAN.maxTokens
    try {
      await p.b.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: 4 })
      await p.pickWith([model])
      await p.goto(url)
      await p.booted()
      check(await p.eval('globalThis.crossOriginIsolated === true'), 'inpage: the page is cross-origin isolated, so the model may use more than one thread')
      check(await p.openConsole(), 'inpage: the tilde key opens the console')
      await p.command('operator unlock', /unlocked/)

      // Picked through the console's own Enter: the picker opens inside that keydown, the file is kept, the provider
      // switches to inpage, and a desktop starts loading it at once.
      const kept = await p.command('ask file', KEPT, 60_000)
      check(p.choosers === 1 && new RegExp(`${TINY.replace('.', '\\.')} is kept in this page \\(153 KB\\): the inpage provider answers with it now, and it is loading`).test(kept ?? ''),
        'inpage: ask file opens the browser\'s picker from the Enter key, keeps the file in this page and answers with it', `${p.choosers} picker(s); ${lastLine(kept)}`)
      const loaded = await p.command('ask file load', LOADED, 180_000)
      check(new RegExp(`is loaded in this page \\(CPU, 2 threads, ${DESKTOP_CTX} tokens of context, in [\\d.]+ s\\)`).test(loaded ?? ''),
        `inpage: it loads on the processor with two threads and ${DESKTOP_CTX} tokens of context (the plan's ${DESKTOP_PLAN.ctx}, no more than the model was trained on)`, lastLine(loaded))
      const off = await p.command('ask gpu off', /gpu\s+\S/)
      check(/off: the model runs on the processor from its next load/.test(off ?? ''), 'inpage: ask gpu off keeps it on the processor', lastLine(off))
      const t1 = await tether(p, 'Design')
      check(t1.ok, 'inpage: someone who knows Design is recruited from the crowd and tethered', t1.notes.join('; '))

      // An answer through the console: the tiny model's a's, cut at its token limit, the city held while it works (its
      // automatic tier first set one above the hold's cap, so the hold has a tier to lower).
      const above = await tierAbove(p, DESKTOP_PLAN.heldTier)
      check(above.ok, `inpage: quality ${DESKTOP_PLAN.heldTier + 1}, then quality auto, runs the city in auto above the hold's cap`, above.line)
      const t0 = Date.now()
      const first = await holdsWhile(p, () => p.command('ask design: hi', ASK_DONE, 180_000))
      const ms = Date.now() - t0
      check(answerIn(first.value).length === max && /\(cut at the token limit\)/.test(first.value ?? ''),
        `inpage: ask design: hi is answered by the model in this page: ${max} a's, cut at its token limit`, `${answerIn(first.value).length} a's in ${ms} ms; ${lastLine(first.value)}`)
      check(heldThenReleased(first, DESKTOP_PLAN.heldTier), `inpage: the city's automatic tier is lowered to ${DESKTOP_PLAN.heldTier} while the model answers, and the tier from before comes back after`, holdLine(first))

      // ask stop in the middle of an answer: the a's that came before it are kept, none after. The stop is typed while
      // the answer streams and sent part of the way through the first answer's time (again, sooner or later, when it
      // landed before the first piece or after the last).
      let stop = null
      for (const share of [0.4, 0.15, 0.7]) {
        await p.enter('clear')
        await p.enter('ask design: hi')
        const streaming = await p.waitFor(`!!document.querySelector('[data-streaming]')`, 30_000).then(() => true, () => false)
        await p.type('ask stop')
        await new Promise((r) => setTimeout(r, Math.round(ms * share)))
        await p.tap('Enter', 'Enter', 13)
        const t = await p.waitFor(`(() => { const t = ${CONSOLE_LOG}?.innerText ?? ''; return /ask: stopped by the operator|-- answered in/.test(t) && t })()`, 60_000).catch(() => null)
        stop = { share, streaming, part: answerIn(t).length, stopped: /ask: stopped by the operator/.test(t ?? '') }
        if (stop.stopped && stop.part > 0 && stop.part < max) break
      }
      check(!!stop && stop.streaming && stop.stopped && stop.part > 0 && stop.part < max, 'inpage: ask stop in the middle of an answer stops it there (the a\'s before it, none after)', JSON.stringify(stop))
      // The next answer, as the operator tier returns it (the console prints its text and how it ended, not these).
      await forgetAll(p)
      const r = await p.eval(`window.__SIM__.engine.bridge.operator.ask(['Design'], 'hi').result.then(({ speech, ...r }) => r)`)
      check(r.state === 'Authorized' && r.error === undefined && r.done === 'length' && r.tokens === max && r.text === 'a'.repeat(max) && /^[0-9a-f]{64}$/.test(r.promptHash ?? '') && r.standIn === undefined,
        `inpage: the next answer is whole: reason length, ${max} tokens, the hash of its prompt, and no stand-in`, JSON.stringify({ ...r, text: `${r.text?.length} chars` }).slice(0, 300))

      // A reload: the file is still kept and chosen, and it answers with no new pick.
      await reload(p, url)
      await p.openConsole()
      await p.command('operator unlock', /unlocked/)
      const status = await p.command('ask', /installed|ask: /, 60_000)
      check(/inpage: a model file kept in this page/.test(status ?? '') && new RegExp(`${TINY.replace('.', '\\.')}\\s+\\(chosen\\)`).test(status ?? '') && /storage\s+kept in this page/.test(status ?? ''),
        'inpage: after a reload the file is still kept in this page, and chosen', (status ?? '').split('\n').filter((l) => /provider|storage|installed|runtime/.test(l)).join(' | ').slice(0, 400))
      const t2 = await tether(p, 'Design')
      check(t2.ok, 'inpage: someone who knows Design is tethered again', t2.notes.join('; '))
      await forgetAll(p)
      const again = await p.command('ask design: hi', ASK_DONE, 180_000)
      check(answerIn(again).length === max && p.choosers === 1, 'inpage: and it answers with no new pick', `${p.choosers} picker(s); ${lastLine(again)}`)

      // The crash guard: a page that closed while it was loading leaves its mark; the next page does not load again on
      // its own (the script stands in, saying why) until the operator's ask file load.
      await p.eval(`localStorage.setItem(${JSON.stringify(GUARD_KEY)}, JSON.stringify({ model: ${JSON.stringify(TINY)}, gpu: false, at: Date.now() }))`)
      await reload(p, url)
      await p.openConsole()
      await p.command('operator unlock', /unlocked/)
      const t3 = await tether(p, 'Design')
      check(t3.ok, 'inpage: someone who knows Design is tethered after the second reload', t3.notes.join('; '))
      const guarded = await p.command('ask design: hi', ASK_DONE, 120_000)
      check(/no model answered, so the script spoke instead: .*the page closed while it was loading tiny-a\.gguf last time/.test(guarded ?? '') && !answerIn(guarded),
        'inpage: after a page that closed mid-load, the script stands in and says why', lastLine(guarded))
      const cleared = await p.command('ask file load', LOADED, 180_000)
      const unmarked = await p.eval(`localStorage.getItem(${JSON.stringify(GUARD_KEY)}) === null`)
      check(/is loaded in this page/.test(cleared ?? '') && unmarked, 'inpage: ask file load clears the mark and loads the model', lastLine(cleared))
      await forgetAll(p)
      const after = await p.command('ask design: hi', ASK_DONE, 180_000)
      check(answerIn(after).length === max, 'inpage: and the model answers again', lastLine(after))

      // A swarm step: the architect (Design), answered by the model in this page, which addresses no server.
      await forgetAll(p)
      const swarm = await p.command('swarm run --agents 1 a quieter plaza at night', /-- swarm done|swarm: ended/, 240_000)
      check(/-- Prime Architect \(Design\) --/.test(swarm ?? '') && answerIn(swarm).length === max && /answered in [\d.]+ s \(cut at the token limit\)/.test(swarm ?? '') && /-- swarm done: 1 step in/.test(swarm ?? ''),
        'inpage: swarm run --agents 1 completes its step with the model in this page', lastLine(swarm))

      // ask gpu on: SwiftShader's adapter has no shader-f16, so where the answer comes from is recorded, not asserted.
      const on = await p.command('ask gpu on', /gpu\s+\S/)
      check(/on: the model runs on the GPU from its next load/.test(on ?? ''), 'inpage: ask gpu on', lastLine(on))
      const gpuLoad = await p.command('ask file load', LOADED, 180_000)
      await forgetAll(p)
      const gpuAnswer = await p.command('ask design: hi', ASK_DONE, 180_000)
      const where = /\(WebGPU,/.test(gpuLoad ?? '') ? 'the GPU'
        : /asked for the GPU, the runtime ran it on the processor/.test(gpuLoad ?? '') ? 'the processor (asked for the GPU, the runtime ran it there)'
          : /\(CPU,/.test(gpuLoad ?? '') ? 'the processor (the GPU load failed, and it was loaded there instead)' : 'nowhere'
      check(answerIn(gpuAnswer).length === max, 'inpage: with ask gpu on the model still answers', `from ${where}`)
      const noAdapter = p.console.find((l) => RUNTIME_NO_ADAPTER.test(l))
      info('inpage: with ask gpu on, the answer came from', `${where}; ${lastLine(gpuLoad)}${noAdapter ? `; the runtime said: ${noAdapter.slice(0, 160)}` : ''}`)

      // The audit, over everything above: a worker started a moment ago is attached a moment after it is created.
      const allowed = (u) => u === origin || u.startsWith(`${origin}/`) || u.startsWith('blob:') || u.startsWith('data:')
      await settle(() => watch.audit(allowed).missing.length === 0, 3_000)
      const a = watch.audit(allowed)
      console.log(`      inpage audit: ${a.requests} requests (${a.fromWorkers} from workers), ${a.discovered} workers discovered, ${a.attached} attached (${a.nested} nested), ${a.browserOwned} the browser's own, ${a.offOrigin.length} off-origin, ${a.sockets.length} sockets, ${a.security.length} security messages, ${a.errors} commands a worker did not take`)
      check(a.offOrigin.length === 0 && a.requests > 0 && a.fromWorkers > 0, `inpage: every request from the page and from every worker it started stayed in blob:, data: or ${origin}`,
        `${a.requests} requests, ${a.fromWorkers} from workers${a.offOrigin.length ? `; ${a.offOrigin.slice(0, 3).map((x) => `${x.type} ${x.url.slice(0, 80)}`).join(', ')}` : ''}`)
      check(a.sockets.length === 0, 'inpage: no WebSocket or WebTransport was opened', a.sockets.slice(0, 3).map((x) => `${x.type} ${x.url}`).join(', '))
      check(a.security.length === 0, 'inpage: no security message (a CSP violation among them) from the page or any worker', a.security.slice(0, 3).map((x) => `${x.type}: ${x.text}`).join(' | ').slice(0, 400))
      check(a.missing.length === 0 && a.discovered === a.attached && a.nested >= 2, 'inpage: every worker the browser created was attached and watched, the runtime\'s own threads among them',
        `${a.discovered} discovered, ${a.attached} attached, ${a.nested} started by a worker: ${JSON.stringify(a.workers)}${a.missing.length ? `; missing ${a.missing.map((m) => m.url.slice(0, 60) || `a ${m.type} with no URL yet`).join(', ')}` : ''}`)

      // The policy reaches a worker the page makes: a fetch off this machine is a connect-src violation in the worker
      // (and a security message), not a name that failed to resolve.
      const saw = await p.eval(CSP_PROBE)
      await settle(() => watch.security.some((s) => s.text.includes('example.invalid')), 3_000)
      const violation = saw.find((g) => g.kind === 'violation')
      const logged = watch.security.find((s) => s.type === 'worker' && s.text.includes('example.invalid'))
      const dns = watch.failed.find((f) => f.url.startsWith(CSP_PROBE_URL) && /NAME_NOT_RESOLVED/.test(f.error))
      check(violation?.directive === 'connect-src' && saw.some((g) => g.kind === 'failed') && !!logged && !dns,
        'inpage: a worker the page makes from a blob is refused a fetch off this machine by the page\'s policy (a connect-src violation, not a failed name lookup)',
        JSON.stringify({ saw, logged: logged?.text, failed: watch.failed.filter((f) => f.url.startsWith(CSP_PROBE_URL)) }).slice(0, 500))
      await p.shot('inpage')
      p.health('inpage')
    } finally {
      p.saveTranscript('inpage')
      await p.b.close()
    }
  },

  /**
   * A city action an agent proposes, with no model: the scripted provider chosen on purpose appends the one line the
   * prompt plainly asks for (actions.ts scriptedAction over intent.ts classify), the tier shows it and waits, and every
   * end of a proposal's life is driven in turn: allowed from the card's own key with the console closed, refused with
   * `n`, withdrawn by `ask stop`, withdrawn by `operator lock`, and ended by the gateway when the one tether is let go.
   * Everything waits on the console's scrollback and the page's state; `engine.bridge` is a TS-private field read from
   * plain JS, as the debug handle allows (App.tsx `window.__SIM__.engine`).
   */
  async actions(chrome, origin) {
    const p = await open(chrome)
    try {
      // The slowest day (one sim minute a real minute at 60 fps, slower on a software GPU, whose frames are clamped to
      // 50 ms of sim time): the clock an action set is read back minutes later, so the hour is compared, not the minute.
      await p.goto(`${origin}/?${LIGHT}&day=1440`)
      await p.booted()
      check(await p.openConsole(), 'actions: the tilde key opens the console')
      await p.command('operator unlock', /unlocked/)
      // `ask provider scripted` answers `provider  scripted: no backend; …` (router.ts PROVIDER_TEXT).
      await p.command('ask provider scripted', /provider\s+scripted/)
      const t = await tether(p, 'Design')
      check(t.ok, 'actions: someone who knows Design is tethered', t.notes.join('; '))
      const pend = () => p.eval('window.__SIM__.engine.bridge.operator.acts.pending()?.sentence ?? null')
      const clock = () => p.eval('window.__SIM__.snapshot().customer.clock')
      const before = await clock()

      // A proposal: under the answer, who proposes what, waiting; the clock has not moved.
      const shown = await p.command('ask design: make it night', /act 1: /, 60_000)
      check(/act 1: agent \d+ \(Design(?:, [^)]*)?\) proposes: set the clock to 22:00/.test(shown ?? '') && (await pend()) === 'set the clock to 22:00',
        'actions: the script proposes and the console shows who and what', lastLine(shown))
      check((await clock()).slice(0, 2) === before.slice(0, 2), 'actions: nothing changed before the OK', `${before} -> ${await clock()}`)

      // The console closes: the card takes focus on Refuse, and the real Y key (the pad and the taps shielded) allows it.
      await p.tap('Escape', 'Escape', 27)
      const focused = await p.waitFor(`document.activeElement?.closest('[role="alertdialog"][data-act]') !== null && document.activeElement?.textContent === 'Refuse'`, 5_000).then(() => true, () => false)
      await p.tap('KeyY', 'y', 89)
      const ran = await p.waitFor(`window.__SIM__.snapshot().customer.clock === '22:00'`, 10_000).then(() => true, () => false)
      check(focused && ran && (await pend()) === null
        && await p.eval(`window.__SIM__.engine.toasts.some((t) => t.title === 'City action' && t.body === 'done: the clock is set to 22:00')`)
        && await p.eval(`document.body.innerText.includes('22:00')`),
        'actions: Y on the card ran it once; the clock, the HUD and the toast agree', `Refuse focused ${focused}, ran ${ran}, clock ${await clock()}`)
      check(await p.openConsole(), 'actions: the console opens again')
      check(/act 1: allowed on the card: set the clock to 22:00\n[\s\S]*act 1: done: the clock is set to 22:00/.test(await p.eval(`${CONSOLE_LOG}?.innerText ?? ''`)),
        'actions: the card decisions were printed while the console was closed')

      // `n` refuses; `ask stop` withdraws; `operator lock` withdraws, and nothing waits past it.
      await p.command('ask design: make it noon', /act 2: /, 60_000)
      const no = await p.command('n', /act 2: refused/)
      check(/^act 2: refused: set the clock to 12:00 \(agent \d+ is told next time\)$/.test(lastLine(no)) && /^22:/.test(await clock()), 'actions: n refuses it and nothing changes', lastLine(no))
      await p.command('ask design: thin the crowd', /act 3: /, 60_000)
      const stop = await p.command('ask stop', /ask: /)
      check(/^ask: withdrawing act 3: set the crowd to 50%$/.test(lastLine(stop)) && (await pend()) === null, 'actions: ask stop withdraws a waiting proposal', lastLine(stop))
      const tier = await p.eval('window.__SIM__.snapshot().quality.tier')
      await p.command('ask design: lowest quality please', /act 4: .*set the quality to Lite/, 60_000)
      const lock = await p.command('operator lock', /withdrawn/)
      check(/act 4: withdrawn: the operator tier is locked/.test(lock ?? '') && (await pend()) === null && (await p.eval('window.__SIM__.snapshot().quality.tier')) === tier,
        'actions: no proposal waits past a lock', lastLine(lock))
      check(/nothing is waiting/.test(await p.command('act', /act: /) ?? '') && /^act: locked; type 'operator unlock' first$/.test(lastLine(await p.command('act ok', /act: /))),
        'actions: act reads while locked; act ok does not')

      // The one tether let go while a proposal waits: the gateway ends it in its own words, and the trail has everything
      // (11 entries: 5 step, 1 answer, 1 end, 1 refusal, 3 stop).
      await p.command('operator unlock', /unlocked/)
      await p.command('ask design: make it golden hour', /act 5: .*set the clock to 17:23/, 60_000)
      await p.command('recruit dismiss', /letting 1 person go/)
      const gone = await p.waitFor('window.__SIM__.engine.bridge.operator.acts.pending() === null', 20_000).then(() => true, () => false)
      const log = await p.command('act log verify', /chain: /)
      check(gone && /stop {4}act-5 .*CapabilityTethered: Aborted \(Spatial Tether Lost\): agent \d+ \(Design(?:, [^)]*)?\): no longer tethered to the operator/.test(log ?? '') && /chain: 11 entries verify from genesis/.test(log ?? '') && /^22:/.test(await clock()),
        'actions: a lost tether ends the proposal in the gateway\'s words; the trail has every proposal, decision and end, and verifies', lastLine(log))
      await p.shot('actions')
      p.health('actions')
    } finally {
      p.saveTranscript('actions')
      await p.b.close()
    }
  },

  async lakefront(chrome, origin) {
    const p = await open(chrome)
    try {
      // Medium pinned: the lowest tier that draws the sun's shadow, so every material of the region is built for that pass.
      await p.goto(`${origin}/?map=lakefront&${LIGHT}&quality=2`)
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
      // Medium's 1024 map, not the parked one a tier without shadows keeps: the sun's shadow pass has drawn the region, so
      // every shadowed shader was built (health() below fails on any one three could not build).
      const shadow = await p.waitFor(`(() => { const sh = window.__SIM__.engine.world.sun.shadow
        return window.__SIM__.engine.world.sun.castShadow && sh.mapSize.x === 1024 && sh.map?.width === 1024 })()`, 60_000).then(() => true, () => false)
      await p.frames(3)
      check(shadow, 'lakefront: at Medium the sun\'s shadow pass draws the region (its 1024 map allocated)')
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
  const a = document.activeElement
  // What holds focus, for the log when it is not Restart: the tag, its label and whether it is inside the card.
  const active = a ? a.tagName.toLowerCase() + (a.getAttribute('aria-label') ? '[' + a.getAttribute('aria-label') + ']' : '') + (c.contains(a) ? ' in the card' : ' outside the card') : 'none'
  return { kind: c.dataset.failure, headline: (c.querySelector('h1') || {}).textContent || '', focused: a ? a.textContent : '', active,
    buttons: [...c.querySelectorAll('button')].map((b) => b.textContent), text: c.textContent }
})()`

/** Waits for the card of `kind` and checks its headline, its buttons and that Restart has focus. */
async function expectCard(p, what, kind, headline, buttons = ['Restart', 'Open the console']) {
  const card = await p.waitFor(`(() => { const c = ${CARD}; return c && c.kind === ${JSON.stringify(kind)} && c })()`, BOOT_MS).catch(() => null)
  const seen = card ?? (await p.eval(CARD).catch(() => null))
  check(!!card && card.headline === headline, `${what}: the ${kind} card says “${headline}”`, seen ? `${seen.kind}: ${seen.headline}` : 'no card')
  check(!!card && JSON.stringify(card.buttons) === JSON.stringify(buttons) && card.focused === 'Restart', `${what}: ${buttons.join(' and ')}, Restart focused`, card ? `${card.buttons} / focus ${card.focused || '(nothing)'}: ${card.active}` : '')
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
  } finally {
    server.close()
    if (tinyDir) rmSync(tinyDir, { recursive: true, force: true })
  }
  console.log(failed ? `${failed} check(s) failed` : 'every check passed')
  process.exit(failed ? 1 : 0)
}

main()
