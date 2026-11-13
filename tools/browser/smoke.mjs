#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It is the browser smoke test of the built page (`npm run smoke:browser`): the 3D city booted
 * in a real Chrome or Chromium on the software WebGPU adapter (cdp.mjs SOFTWARE_WEBGPU), driven through the same input
 * events a person makes, on each kind of device the page has to work on:
 * - desktop: the procedural city's sixteen indoor workplaces handed to its crowd, keyboard walking, a mouse drag turning
 *   the head, a gamepad (a standard-mapping pad stood in for the real one) walking and turning, the Ring-0 console
 *   opened with the tilde key and answering, typing in it never moving the avatar, ghost view and rain mode toggled from
 *   their keys, and a car entered, driven and left; and the software adapter left as every device that is not a Peak
 *   candidate is: its range stops at Ultra, three writes no GPU timestamps, and there is no Peak rule; nor is it a
 *   multisampling candidate: one sample a pixel everywhere (FXAA alone); its ambient occlusion built and drawn once at
 *   boot (its two pipelines), then skipped below Ultra;
 * - phone: an iPhone's user agent, screen and touch (no mouse, no keyboard): the virtual stick walking, a drag on the
 *   right half turning the head, both thumbs at once, the Run and Ping buttons, and the menu that reaches what a
 *   keyboard reaches (the console, the clock, ghost view, rain mode, hiding the HUD), also with a thumb on the stick;
 *   on foot and at the wheel, at six phone and tablet sizes both ways up, every control on screen and clear of the
 *   others, the stick, the speedometer, Sloane's chip and her Controls card, the chip clear of the stick and the
 *   minimap, and the Menu's sheet inside the screen; a car entered from its button and, held upright while driving,
 *   Ping, Reset and Exit car clear of the stick, every text field reads at 16 px, and a mouse moving over a
 *   touch-first screen leaves the touch overlay where it is;
 * - split: two players (?players=2) on two pads, one of them without the standard mapping: that pad moves nobody until
 *   a face button wakes it, then walks player 1, and player 2's own pad enters and leaves a car of their own; then
 *   ?msaa=1 split in two, both views drawn 4 samples a pixel on the renderer's own frame (the post chain is off, and
 *   with it the ambient occlusion: never built);
 * - file: dist/index.html opened from disk, the way the README says to play, with no server and so no cross-origin
 *   isolation (the bridge's private-buffer path); the model in this page cannot run there (Chromium refuses the
 *   runtime's module worker on a page whose origin is opaque), so `ask file` opens no picker and keeps nothing, and
 *   the runtime row says why;
 * - ultra: the top tier of the table pinned, so the shadowed, post and volumetric pipelines are compiled once and must
 *   validate; then Peak pinned above it for a few frames (Ultra's sun shadows, 240 m on the 8192-wide atlas of two 4096
 *   cascades, with Peak's wider sixteen-tap penumbra, 1.25 times the pixel ratio, detailed bodies to 90 m, the HUD
 *   reading Peak) and Ultra back after, with its penumbra and pixels, the ambient occlusion drawn every frame at twelve
 *   taps (sixteen at Peak); then Ultra again with ?msaa=1 under the cinema camera: the scene pass's colour and velocity
 *   at 4 samples (the sun shafts and the ambient occlusion reading its multisampled depth), nothing of it compiled at
 *   one sample through Low, Peak and Ultra, the occlusion skipped at Low and in rain mode and never compiled again, and
 *   ghost view and rain mode validating over it; the Nix job runs this one too;
 * - peak: a big desktop faked in full (16 threads, 8 GB, a WebGPU adapter reading 'nvidia / blackwell / NVIDIA GeForce
 *   RTX 5090'), at ?fps=1 without the camera so only Peak's GPU rule can move the tier, with three's timing resolve
 *   replaced, before the page's first frame, by one that counts and gives nothing. It starts on Ultra, never above,
 *   with no GPU reading, its scene pass multisampled without being asked (msaaCandidate) and its ambient occlusion
 *   running at Ultra's twelve taps. Where SwiftShader's device has timestamp-query (recorded), the range reaches Peak, the engine
 *   resolves timings for the governor on Ultra, auto keeps a pinned Peak, the in-page model's hold on the GPU brings it
 *   down to Ultra and the release keeps Ultra, and GPU readings fed over the limit bring it down by itself (gpu busy)
 *   with its shadow distance and pixels. Where it has none, the range stops at Ultra, nothing is resolved, and auto from a
 *   pinned Peak lands on Ultra. SwiftShader still draws it: this proves the path from the profile to the GPU rule and
 *   back, not a big card's speed;
 * - lite: the weakest phone the city serves, faked in full (an entry-level Android handset in Chrome: its user agent and
 *   client hints, 412 × 915 at a device pixel ratio of 2.625, touch, 4 GB, and a WebGPU adapter reading 'arm / bifrost'
 *   like a Mali-G52), loaded without the light load's crowd, cars and scale, so the device profile decides them: the
 *   Lite tier, 2,500 pedestrians, 12 cars, frames drawn, the post chain never compiled and nothing multisampled
 *   and no ambient occlusion built (with ?lite=0, the post chain compiled, and ?msaa=1 still refused to a phone, which
 *   never builds the occlusion either). SwiftShader still draws
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
 *   installed, the second load cross-origin isolated by the worker and costing the host only its build word, a model
 *   file kept from the Menu on that second visit, a second build published: first over a link that goes quiet a
 *   megabyte into its page (the page loads again by itself, once, and the copy answers) and one that goes quiet in
 *   its first bytes (the copy takes that very answer over), then over a whole link, run by the very next load
 *   (isolated, then kept by its own worker, the older copy dropped), and the city started from the phone's copy of
 *   that build with the host gone, the kept model still answering;
 * - sitemodel: the one tap that gives a fresh visitor to the web copy a model to talk to Sloane with (09_Cognition/
 *   siteModel.ts, App.tsx's siteHost, Concierge.tsx): the web copy built from dist/index.html with the page's pin
 *   (SITE_MODEL's file name, size and SHA-256) swapped for the tiny model's and the tiny model placed beside it by
 *   tools/web/siteModel.mjs, as the web workflow places the real one, served as a static host serves it, to a desktop.
 *   "how's it going" typed into Sloane's goal field finds no model, and the card offers Get the model with its size,
 *   the page having asked this site for the manifest alone; one click downloads it with its progress on the card,
 *   keeps it in the page's storage and asks the turn again by itself, and the model answers it (CHAT_MAX a's); the
 *   toast says it is loaded, `ask` says the inpage provider answers with it, kept and chosen, and the service worker's
 *   cache holds nothing under models/. The visit is audited as inpage's is: from the click on, every request stays in
 *   blob:, data: or the page's own origin (before it, only Sloane's look for a model server on this machine leaves
 *   it), no socket is opened and no security message logged. Then, in a fresh browser, the model with one byte
 *   flipped: the card says its SHA-256 differs, the button is back and nothing is kept, and with the right file back
 *   the same button keeps it;
 * - walk: the first walk (?tutorial=1) end to end on its accessible path, the look stage through the wardrobe card and
 *   the way out through the three NoirScript lines, with Sloane's name question beside the walk's card at five desktop
 *   sizes and the walk's card stepping aside for it under 960 px;
 * - walkshop: the first walk's look stage through a shop instead: Sloane names the shops, the Browse chip is clear of
 *   the walk's card, a try-on costs nothing, and the shop's card put away passes the stage;
 * - walkhome: the same stage through a home: Sloane names the homes in the keyboard's words, the home's chip is clear of
 *   the walk's card, B opens the doorstep card and the walk's card steps aside, nothing is bought, and Esc puts the
 *   card away and passes the stage;
 * - walkphone: the first walk on an iPhone: the walk's card steps aside while Sloane asks the name, then stands clear of
 *   her chip, the minimap and every touch control held upright, between the thumbs held sideways at three phone
 *   sizes (above a shop's Browse chip), under her chip moved up to the top row where that band is short (125 % in the
 *   shop, 175 %), under the touch Menu's sheet; on an Android phone's page held upright (360 x 552, the browser's bars
 *   taken) the card folds to its strip under the HUD's header at a touch on the look area and opens from it at a tap,
 *   clear of her chip and every control, the HUD's chips at the foot stand above the stick and left of the buttons, and
 *   the shop's Browse chip takes a tap; beside a car there (the band under her chip short) the open card stands above
 *   her chip, never over it; at the wheel upright the card is folded and, opened from its strip, below her chip and
 *   above the car's buttons; away at the wheel sideways until the visitor is on foot again;
 * - lakefront: the generated metropolis (?map=lakefront, built in the page's worker from the seed), whose crowd walks
 *   its street window with the workplaces the page picked from the pack and the HUD counting who is at work, at
 *   Medium, the first tier with shadows, so the sun's shadow pass draws the region's buildings and its shaders build;
 * - homes: the seven homes of seed 1337 and their deeds, on the progression keeper (nothing here costs a credit): B in
 *   Lintel & Lumen Design House opens its card, the Micro-Loft's deed is claimed for nothing and the Pierside's asks for
 *   level 6, Go home puts the avatar on the sidewalk in front of the loft's doorway, W walks it in through the
 *   planters, the HUD's chip offers to furnish the home (Furnish), B opens the doorstep card saying Yours, the avatar
 *   stands still under it with W held, Esc closes it; inside the Penthouse B opens its deed's card, whose Go up rides
 *   the visitor to the sky floor (the card closes, the chip names the sky floor), where W walks from the arrival and
 *   the staged sofa stops it, the floor holding; and the lakefront metropolis, reloaded, has its seven homes, none with
 *   a sky floor, and still knows the loft is owned;
 * - furnish: the loft claimed and the operator's record given level 2 and 3,000 credits by hand (sealed again, then
 *   reloaded), B inside opens the furnishing view, its strip's Order buys a bookcase and a sofa, E or Q takes each in
 *   hand, the arrows move the cursor and Enter places it, each piece one more collider in the physics realm; after a
 *   real mouse click on View, Enter still reaches the card (it picks up the sofa under the cursor) and never presses
 *   View again, and Z puts the sofa back; Done closes the view, the layout is saved in this browser, and after a
 *   reload both pieces are still solid and placed;
 * - rest: a rest at home in the Brownstone (level 3, a bookcase standing there, given by hand and reloaded): B inside
 *   opens the furnishing view, 4 its Rest tab, which offers +1 for one kind of furniture beside a Rest button at least
 *   48 px tall that the panel describes; Enter rests (a hero point, a new round, word 40 of the record), a real click
 *   on Rest is refused while the rest lasts and changes nothing, the HUD's chip ends with "prepared +1", the console's
 *   next check line and `progress` say so, and after a reload all of it is still there; then, with a workstation placed
 *   and an agent named by hand, 5 opens the Staff tab, the workstation's row in its list puts the cursor on the
 *   workstation and Enter posts the agent there (saved, listed by engine.homeSeats, drawn; the row and the agent's
 *   button say so), every staff button at least 48 px tall, and after a reload the agent still stands there;
 * - fail: the ways out when the city cannot start or stops, each in its own browser: navigator.gpu taken away (the
 *   card before a first visit's onboarding, at desktop and phone size and in Firefox on Android with Open in Chrome
 *   first, Restart focused and taken by Enter, the pad's
 *   d-pad and A reaching the console shell, and its Back to the city back again), a genuinely insecure origin
 *   (lan.test mapped to this machine over plain http), no adapter, a boot that never finishes (the 'Still starting'
 *   line, naming the step), a download cut off mid-script (the index.html watchdog), a slow download (the splash
 *   before the module has arrived), and, after a boot, the page's GPU device lost (the reset card, no reload while the page is
 *   visible), the browser's GPU process killed as the worker asks for the crowd's full kernel (the page starts again
 *   by itself, once, and the city stands on the light kernel, remembered; killed again under the light kernel, the
 *   card says none is left, and the start after that asks for no adapter), a realm halt for a lost crowd device, and a
 *   frame that throws on every frame. Where a failure is the point, the GPU-error check is left out; nothing may throw
 *   uncaught in any of them.
 * Every scenario also fails on an exception in the page, a GPU validation error, a lost device, or the crowd's flow
 * field falling back to the CPU. Every browser can reach nothing but this machine (cdp.mjs loopbackOnly: no name
 * resolves but 127.0.0.1, and no proxy). It serves dist/ itself on 127.0.0.1 with the two isolation headers, writes a
 * screenshot per scenario to --out (default: a temporary directory), and the console's transcript where a scenario
 * types in it, prints one row per check (and an `info` row for what is recorded, not asserted) and exits 1 if any
 * fails.
 * Usage: node tools/browser/smoke.mjs [--chrome <path>] [--out <dir>] [--only desktop,phone,split,file,ultra,peak,lite,tty,pwa,inpage,sitemodel,actions,walk,walkshop,walkhome,walkphone,lakefront,homes,furnish,rest,fail].
 * `--shard i/n` runs only part i of n of those scenarios (shard.mjs: split by how long each took in CI), as CI's
 * browser jobs do.
 * Needs `npm run build`.
 * What breaks if it is removed? Nothing at runtime; the page loses its only end-to-end check in a browser, and with it
 * the proof that the city renders and that every control reaches the avatar.
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Browser, findChrome, loopbackOnly, SOFTWARE_WEBGPU, watchTargets } from './cdp.mjs'
import { HPARAMS, tinyGguf } from './tinyGguf.mjs'
import { parseShard, shardOf } from './shard.mjs'
import { APP_NAME, build as buildWeb, CACHED, ICONS } from '../web/pwa.mjs'
import { placeModel } from '../web/siteModel.mjs'
import { eligible, onRoad, skillsOf } from '../../src/03_Spawn_Agents/skills.ts'
import { CHAT_MAX } from '../../src/07_Execute_Actions/onboarding/voice.ts'
import { GUARD_KEY } from '../../src/09_Cognition/inPage.ts'
import { MODELS_DIR } from '../../src/09_Cognition/modelStore.ts'
import { SITE_DIR, SITE_MANIFEST, SITE_MODEL } from '../../src/09_Cognition/siteModel.ts'

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
/** The part of the scenarios this run takes (`--shard i/n`, shard.mjs), or null for all of them. */
const SHARD = arg('shard') === undefined ? null : parseShard(arg('shard'))
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
 * navigator.deviceMemory reads 4 (the page's render pipelines are counted on every page: PIPELINE_COUNTER). An init
 * script reaches the page, not the physics worker, which reads no adapter info.
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
  if (typeof GPUDevice !== 'undefined') wrap(GPUDevice.prototype, 'adapterInfo')
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

/** The tier as the governor, the snapshot, the sun's shadow (its map per cascade, the atlas two of them wide, the distance
 *  its camera's far plane: sunShadow.ts), the canvas and the crowd cull show it (ultra, peak). */
const PEAK_STATE = `(() => { const S = window.__SIM__, s = S.snapshot(), e = S.engine, g = e.quality.governor, sh = e.world.sun.shadow, c = sh.camera
  return { tier: g.tier, label: s.quality.label, auto: s.quality.auto, held: s.quality.held ?? null, reason: g.reason, peak: s.quality.peak ?? null,
    min: g.min, max: g.max, timestamps: e.gpu.timestamps, mapSize: sh.mapSize.x, mapWidth: sh.map ? sh.map.width : 0,
    far: c.far, radius: sh.radius, cascades: sh.getViewportCount(), ratio: e.gpu.renderer.getPixelRatio(), lod: e.quality.live.cull.lodDistance,
    errors: S.errors().slice(0, 5) } })()`

/** The in-page model's runtime, asked for the GPU, saying its worker found no adapter (ggml's WebGPU backend; echoed under ?debug). */
const RUNTIME_NO_ADAPTER = /^\[\w+\] ggml_webgpu: Failed to get an adapter\b/

/** Counts animation frames, so a check can wait for the page to have read its input n more times. */
/**
 * The page's render pipelines, counted on every page before its scripts: how many write two colour targets (only the
 * post chain's scene pass under the cinema camera does, colour and velocity, so none means it was never compiled), how
 * many draw 4 samples a pixel (the scene's multisampling, governor.ts msaaCandidate), and how many write two targets at
 * one sample (none on a page whose scene pass is multisampled: the chain was built once, at 4). And the ambient
 * occlusion's (postfx.ts GatedSSAO): the pipelines writing a single r8unorm target (only its occlusion pass and its blur
 * do; nothing else in the page renders to one channel), and how many times a render pass set one of them (three a
 * drawn frame: the occlusion, then the blur across and down), so a check sees its passes run or skipped.
 */
const PIPELINE_COUNTER = `(() => {
  if (typeof GPUDevice === 'undefined') return
  window.__smokePipelines = { render: 0, twoTargets: 0, msaa4: 0, twoTargets1x: 0, ao: 0, aoDraws: 0 }
  const ao = new WeakSet()
  const oneChannel = (desc) => {
    const t = (desc && desc.fragment && desc.fragment.targets) || []
    return t.length === 1 && !!t[0] && t[0].format === 'r8unorm'
  }
  const count = (desc) => {
    const n = window.__smokePipelines
    const two = (desc && desc.fragment && desc.fragment.targets || []).length >= 2
    const four = !!(desc && desc.multisample && desc.multisample.count === 4)
    n.render++
    if (two) n.twoTargets++
    if (four) n.msaa4++
    if (two && !four) n.twoTargets1x++
    if (oneChannel(desc)) n.ao++
  }
  const own = GPUDevice.prototype.createRenderPipeline
  if (typeof own === 'function') GPUDevice.prototype.createRenderPipeline = function (desc) {
    count(desc)
    const p = own.call(this, desc)
    if (oneChannel(desc)) ao.add(p)
    return p
  }
  const ownAsync = GPUDevice.prototype.createRenderPipelineAsync
  if (typeof ownAsync === 'function') GPUDevice.prototype.createRenderPipelineAsync = function (desc) {
    count(desc)
    return ownAsync.call(this, desc).then((p) => { if (oneChannel(desc)) ao.add(p); return p })
  }
  if (typeof GPURenderPassEncoder !== 'undefined') {
    const set = GPURenderPassEncoder.prototype.setPipeline
    GPURenderPassEncoder.prototype.setPipeline = function (p) {
      if (ao.has(p)) window.__smokePipelines.aoDraws++
      return set.call(this, p)
    }
  }
})()`

/** A page expression: the samples the boot chose (the scene pass's, the renderer's own) and the pipelines counted. */
const AA_STATE = `(() => { const S = window.__SIM__, e = S.engine
  return { scene: e.sceneSamples, renderer: e.gpu.renderer.samples, post: e.options.post,
    ao: e.ao ? { on: e.ao.node.on, taps: e.ao.node.samples.value, strength: e.ao.strength.value } : null,
    pipelines: window.__smokePipelines ? { ...window.__smokePipelines } : null, errors: S.errors().slice(0, 5) } })()`
/** An AA_STATE as a log line. */
const aaLine = (a) => `scene ${a.scene}x, renderer ${a.renderer}, ${a.pipelines ? `${a.pipelines.render} pipelines, ${a.pipelines.msaa4} at 4x, ${a.pipelines.twoTargets} with two targets (${a.pipelines.twoTargets1x} at 1x)` : 'not counted'}; ` +
  `ao ${a.ao ? (a.ao.on ? `${a.ao.taps} taps at ${a.ao.strength}` : 'built, off') : 'not built'}${a.pipelines ? ` (${a.pipelines.ao} pipelines, ${a.pipelines.aoDraws} draws)` : ''}`

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
   * Waits for the engine (window.__SIM__), a few rendered frames, and the boot veil gone: it takes every touch and
   * click while it covers the page (BootVeil.tsx holds it half a second after the first frame), and a person waits for
   * the city to show before touching it too. Gone, not just fading: Sloane's card opens when the fade ends (App.tsx
   * veilDone), and on a slow software adapter that came after the first key checks, so its name field took G, M,
   * the tilde and E as typing.
   */
  async booted() {
    await this.waitFor('!!window.__SIM__ && window.__SIM__.snapshot().output.fps > 0', BOOT_MS)
    await this.waitFor(`!document.querySelector('.boot-veil')`, 30_000)
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
  /**
   * Opens the Ring-0 console with the tilde key (a desktop), its prompt focused. A first visit's concierge greets once
   * the veil is gone, its name field holding the keyboard: skipped first, as a visitor who wants the console would, so
   * the tilde reaches the page (after a reload too).
   */
  async openConsole() {
    await this.eval(`[...document.querySelectorAll('aside[data-concierge] button')].find((b) => b.textContent.trim() === 'Skip')?.click()`)
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
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: PIPELINE_COUNTER })
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

/** A file of the site's model folder as a static host serves it (siteModel.ts SITE_PATH): models/ and one plain name. */
const SITE_FILE = /^models\/[A-Za-z0-9][A-Za-z0-9._-]*$/
/** The model's licence and notice beside it (tools/web/siteModel.mjs LICENCE_FILES): plain text. */
const SITE_TEXT = new Set([`${SITE_DIR}LICENSE`, `${SITE_DIR}NOTICE`])

/**
 * Serves a folder the way a static host such as GitHub Pages does: its files by name, the folder's index, and no
 * isolation headers. A file in its models/ folder (the site's model, its manifest and its licence: sitemodel) is
 * served too, by a plain name only and read when it is asked for, so a scenario can change it between visits.
 * `served` lists every path asked for, in order.
 */
async function serveStatic(dir) {
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.gguf': 'application/octet-stream' }
  const files = new Set(readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()))
  const isFile = (path) => existsSync(path) && statSync(path).isFile()
  /** How often each file was sent, by name, and when each request came, as it was asked (seconds since the host started). */
  const sent = new Map()
  const began = Date.now()
  const asked = []
  /** Every path asked for, in order, found or not (sitemodel reads what was asked under models/). */
  const served = []
  // A file whose answers stop after so many bytes, the connection left open (a link that goes quiet in the middle of
  // a download), until flow() lets the host answer whole again and drops the answers it left hanging.
  let stalled = null
  const hanging = new Set()
  const server = createServer((req, res) => {
    const name = new URL(req.url ?? '/', 'http://x').pathname.slice(1) || 'index.html'
    served.push(name)
    if (!files.has(name) && !(SITE_FILE.test(name) && isFile(join(dir, name)))) { res.writeHead(404).end(); return }
    sent.set(name, (sent.get(name) ?? 0) + 1)
    asked.push(`${req.url}${stalled && stalled.name === name ? ' (stalled)' : ''} at ${((Date.now() - began) / 1000).toFixed(1)} s`)
    const type = SITE_TEXT.has(name) ? 'text/plain; charset=utf-8' : TYPES[extname(name)] ?? 'application/octet-stream'
    const head = { 'Content-Type': type, 'Cache-Control': 'no-store' }
    if (stalled && stalled.name === name) {
      res.writeHead(200, head)
      res.write(readFileSync(join(dir, name)).subarray(0, stalled.bytes))
      hanging.add(res)
      res.on('close', () => hanging.delete(res))
      return
    }
    res.writeHead(200, head).end(readFileSync(join(dir, name)))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    served,
    sent: (name) => sent.get(name) ?? 0,
    asked: () => [...asked],
    stall: (name, bytes) => { stalled = { name, bytes } },
    flow: () => { stalled = null; for (const res of hanging) res.destroy(); hanging.clear() },
    close: () => { server.closeAllConnections(); server.close() },
  }
}

/**
 * A llama-server built since b11521 as the page meets it: every origin allowed (its default), one text model listed;
 * only the lists a look asks are answered. It listens on a free port, which the browser is told is localhost:9931 (its
 * new default port), so nothing on this machine is reached or needed free. Until `on()` it drops every connection, as
 * a port with nothing listening would.
 */
async function serveLlamaServer() {
  let ready = false
  const server = createServer((req, res) => {
    if (!ready) { req.socket.destroy(); return }
    const head = { 'Access-Control-Allow-Origin': req.headers.origin ?? '*', 'Cache-Control': 'no-store' }
    if (new URL(req.url ?? '/', 'http://x').pathname === '/v1/models') {
      res.writeHead(200, { ...head, 'Content-Type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'smoke-9931.gguf', object: 'model' }] }))
      return
    }
    res.writeHead(404, head).end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { port: server.address().port, on: () => { ready = true }, close: () => { server.closeAllConnections(); server.close() } }
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
 * Who could be asked over from where the operator stands: everyone the recruiter's own check (skills.ts eligible: on
 * the sidewalk, within AUDIBLE_RADIUS, a sidewalk path to the operator) admits for any skill they have, read from one
 * fresh frame of the crowd. The first walk's exam must not need anyone here.
 */
async function earshot(p) {
  const seen = await p.eval(`new Promise((resolve) => { const h = window.__SIM__.engine.recruitHost(); const off = h.onState((s) => {
    const f = s.crowdFrame; if (!f || f.length < 4 * h.agents) return; off()
    const xz = new Array(2 * h.agents); for (let k = 0; k < h.agents; k++) { xz[2 * k] = f[4 * k]; xz[2 * k + 1] = f[4 * k + 2] }
    resolve({ xz, me: h.operator() }) }) })`)
  if (!seen.me) return { me: null, near: [] }
  const xz = Float32Array.from(seen.xz)
  const near = []
  for (let k = 1; 2 * k + 1 < xz.length; k++) if (skillsOf(k).some((skill) => eligible(xz, k, seen.me, skill) >= 0)) near.push(k)
  return { me: seen.me, near }
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

/** What the sitemodel scenario says to Sloane: talk (intent.ts Brief.chat), which only a model answers. */
const SMALL_TALK = "how's it going"

/** The tiny model's pin in SITE_MODEL's shape (siteModel.ts): its file name, its size and its SHA-256. */
function tinyPin() {
  const bytes = readFileSync(tinyModel())
  return Object.freeze({ ...SITE_MODEL, file: TINY, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
}

/** `text` as a regular expression that matches it literally. */
const literal = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The web copy built for `pin` instead of the site's model (sitemodel), in `<dir>/web`: dist/index.html with
 * SITE_MODEL's file name, size and SHA-256 replaced by the pin's where the page holds them, its one compiled pin (the
 * three side by side, as `file:…,bytes:…,sha256:…`), made into the web copy by pwa.mjs, and the tiny model placed
 * beside it by siteModel.mjs, checked while it is copied, as the web workflow places the real one. The pin must be
 * found exactly once, and the site's SHA-256 nowhere else, or the run stops here: the page's pin is not where this
 * looks for it. (The page's notice names the file in its prose too; that line is left as it is.) Returns the folder.
 */
async function siteCopy(pin, dir) {
  const q = '([`\'"])'
  const at = new RegExp(`(\\bfile\\s*:\\s*)${q}${literal(SITE_MODEL.file)}\\2(\\s*,\\s*bytes\\s*:\\s*)${literal(SITE_MODEL.bytes)}(\\s*,\\s*sha256\\s*:\\s*)${q}${literal(SITE_MODEL.sha256)}\\5`, 'g')
  const page = readFileSync(DIST, 'utf8')
  const n = page.match(at)?.length ?? 0
  if (n !== 1) throw new Error(`dist/index.html holds SITE_MODEL (${SITE_MODEL.file}, ${SITE_MODEL.bytes} bytes, sha256 ${SITE_MODEL.sha256.slice(0, 8)}…) ${n} times, not once: rebuild it (npm run build), or find where the page's pin went`)
  const html = page.replace(at, (_m, file, fq, bytes, sha, sq) => `${file}${fq}${pin.file}${fq}${bytes}${pin.bytes}${sha}${sq}${pin.sha256}${sq}`)
  if (html.includes(SITE_MODEL.sha256)) throw new Error(`dist/index.html holds the site's SHA-256 somewhere besides its pin: the page would not be built for ${pin.file} alone`)
  const from = join(dir, 'page')
  mkdirSync(from, { recursive: true })
  writeFileSync(join(from, 'index.html'), html)
  const out = join(dir, 'web')
  buildWeb({ from, out })
  await placeModel({ from: dirname(tinyModel()), out, pin })
  return out
}

/** A page expression: the centre of the element `q` matches, once a click there lands on it (null until then). */
const hitOf = (q) => `(() => { const e = document.querySelector(${JSON.stringify(q)}); if (!e) return null; const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2
  return r.width > 0 && e.contains(document.elementFromPoint(x, y)) ? [x, y] : null })()`
/** Clicks (x, y) with the mouse's left button, as a person does. */
async function clickAt(p, [x, y]) {
  await p.mouse('mouseMoved', x, y)
  await p.mouse('mousePressed', x, y, 1)
  await p.mouse('mouseReleased', x, y)
}

/**
 * A page expression: Sloane's conversation as the card shows it (Concierge.tsx): its state (data-chat), the line Sloane
 * says, the site's model's button, why the last try to get it ended short, and the step of getting it on screen.
 */
const SLOANE_TALK = `(() => { const c = document.querySelector('aside[data-concierge]'), chat = c?.querySelector('[data-chat]')
  return { state: chat?.getAttribute('data-chat') ?? null, line: c?.querySelector('p[aria-live]')?.textContent ?? '', offer: chat?.querySelector('[data-action="site-model"]')?.textContent.trim() ?? null,
    why: chat?.querySelector('[data-site-why]')?.textContent ?? '', getting: chat?.querySelector('[data-site-model]')?.getAttribute('data-site-model') ?? null } })()`

/**
 * From now on, notes in window.__smokeSite every step of getting the site's model that Sloane's card shows (its
 * data-site-model, the line over the bar and the bar's value), each state of the conversation, and whether the card
 * said the model was starting: a model of 153 KB from this machine can come and go between two looks from here.
 */
const SITE_WATCH = `(() => { const s = window.__smokeSite = { steps: [], lines: [], bars: [], states: [], starting: false }
  const add = (list, v) => { if (v != null && list.at(-1) !== v) list.push(v) }
  const look = () => { const c = document.querySelector('aside[data-concierge]'); if (!c) return
    const g = c.querySelector('[data-site-model]'); add(s.steps, g?.getAttribute('data-site-model')); add(s.lines, g?.querySelector('span')?.textContent)
    add(s.bars, c.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')); add(s.states, c.querySelector('[data-chat]')?.getAttribute('data-chat'))
    if (c.textContent.includes('Starting the model')) s.starting = true }
  new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); look() })()`

/** A page expression: what the page's model store holds (modelStore.ts MODELS_DIR), each kept model as its files. */
const KEPT_IN_STORE = `(async () => { try { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle(${JSON.stringify(MODELS_DIR)}); const out = []
  for await (const [, h] of d.entries()) { if (h.kind !== 'directory') continue; const names = []; for await (const [n] of h.entries()) names.push(n); out.push(names.sort().join(' + ')) }
  return out } catch (e) { return e?.name === 'NotFoundError' ? [] : ['the store could not be read: ' + e?.message] } })()`

/** A page expression: every address the page's caches hold (the service worker's offline copy, pwa.mjs). */
const CACHED_URLS = `(async () => { const out = []; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(r.url); return out })()`

/** A page expression: where the keyboard is and which view Sloane's card shows, for a note when the goal field is not it. */
const WHERE_KEYS = `(() => { const a = document.activeElement, c = document.querySelector('aside[data-concierge]'), label = a?.getAttribute('aria-label')
  return 'the card ' + (c ? 'on ' + c.getAttribute('data-concierge') : 'away') + ', the keyboard on ' + (a ? a.tagName.toLowerCase() + (label ? ' "' + label + '"' : '') : 'nothing')
    + ', ' + (document.querySelector('[aria-label="Your goal"]') ? 'a' : 'no') + ' goal field' })()`

/**
 * A page expression: starts a trail (once a page) of the views Sloane's card goes through ('nothing' while it is
 * hidden), where the keyboard was and whether the visitor was on foot each time, and every key, pointer press, click
 * and focus the page saw, each with its time in ms; the last 40 are kept. talkToSloane reports it when the goal field
 * never took the keyboard.
 */
const CARD_TRAIL = `(() => { if (window.__cardTrail) return true; const t = window.__cardTrail = [], t0 = performance.now()
  const note = (s) => { t.push(Math.round(performance.now() - t0) + ' ' + s); if (t.length > 40) t.shift() }
  const view = () => { const c = document.querySelector('aside[data-concierge]'); return c ? c.getAttribute('data-concierge') : document.querySelector('[data-concierge="chip"]') ? 'chip' : 'nothing' }
  const on = (e) => e && e.tagName ? e.tagName.toLowerCase() + (e.getAttribute('data-concierge') ? '[' + e.getAttribute('data-concierge') + ']' : e.getAttribute('aria-label') ? ' "' + e.getAttribute('aria-label') + '"' : '') : '-'
  let last = view(); note('view ' + last)
  const mode = () => { try { return window.__SIM__.snapshot().input.mode } catch { return '?' } }
  new MutationObserver(() => { const v = view(); if (v !== last) { note('view ' + last + ' > ' + v + ', keys on ' + on(document.activeElement) + ', ' + mode()); last = v } })
    .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-concierge'] })
  for (const type of ['keydown', 'pointerdown', 'click', 'focusin']) window.addEventListener(type, (e) => note(type + ' ' + (e.key ?? e.pointerType ?? '') + ' on ' + on(e.target)), true)
  return true })()`

/**
 * A first visit to `url` as far as Sloane's answer to SMALL_TALK (sitemodel): the city booted, the name question
 * skipped with Esc and the greeting put away with Esc, the chip clicked (again, should a line of Sloane's own have
 * taken its place), the words typed into the goal field and sent with Enter. Returns the card (SLOANE_TALK) once it
 * offers the site's model in a conversation no model answered, or as it is after two minutes, and what went wrong on
 * the way there.
 */
async function talkToSloane(p, url) {
  const notes = []
  await p.goto(url)
  await p.booted()
  await p.eval(CARD_TRAIL).catch(() => {})
  if (await p.waitFor(`document.activeElement?.getAttribute('aria-label') === 'Your name'`, 30_000).then(() => true, () => false)) await p.tap('Escape', 'Escape', 27)
  else notes.push('the name question never took the keyboard')
  if (await p.waitFor(`!!document.querySelector('aside[data-concierge="greet"]')`, 10_000).then(() => true, () => false)) await p.tap('Escape', 'Escape', 27)
  let field = false
  for (let i = 0; i < 3 && !field; i++) {
    const chip = await p.waitFor(hitOf('[data-concierge="chip"]'), 30_000).catch(() => null)
    if (!chip) { notes.push(`no chip to click (${await p.eval(WHERE_KEYS)})`); break }
    await clickAt(p, chip)
    field = await p.waitFor(`document.activeElement?.getAttribute('aria-label') === 'Your goal'`, 10_000).then(() => true, () => false)
    if (!field) notes.push(`the chip's click left ${await p.eval(WHERE_KEYS)}`)
  }
  // A goal field on screen that did not take the keyboard by itself is clicked into, as a person would.
  const box = field ? null : await p.waitFor(hitOf('aside[data-concierge] [aria-label="Your goal"]'), 5_000).catch(() => null)
  if (box) {
    await clickAt(p, box)
    field = await p.waitFor(`document.activeElement?.getAttribute('aria-label') === 'Your goal'`, 5_000).then(() => true, () => false)
  }
  if (!field) {
    const trail = await p.eval('window.__cardTrail ?? []').catch(() => [])
    return { card: await p.eval(SLOANE_TALK), notes: [...notes, 'the goal field never took the keyboard', `the card's trail: ${trail.join(' | ')}`] }
  }
  await p.type(SMALL_TALK)
  await p.b.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
  await p.b.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  const card = await p.waitFor(`(() => { const t = ${SLOANE_TALK}; return t.state === 'none' && t.offer !== null && t })()`, 120_000).catch(() => p.eval(SLOANE_TALK))
  return { card, notes }
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
      check(rooms === 16, 'desktop: the city\'s sixteen indoor workplaces reached the crowd', `${rooms} rooms`)
      // Not a Peak candidate (a software adapter): every such device boots as it did before Peak.
      const nc = await p.eval(PEAK_STATE)
      check(nc.max === 4 && nc.timestamps === false && nc.peak === null, 'desktop: a device that is not a Peak candidate keeps the range Minimal..Ultra, no GPU timestamps and no Peak rule', `range ${nc.min}..${nc.max}, timestamps ${nc.timestamps}, peak ${JSON.stringify(nc.peak)}`)
      // Nor a multisampling candidate: one sample everywhere, as before (FXAA alone).
      const aa = await p.eval(AA_STATE)
      check(aa.scene === 0 && aa.renderer === 0 && aa.pipelines && aa.pipelines.render > 0 && aa.pipelines.msaa4 === 0, 'desktop: a device that is not a multisampling candidate draws one sample a pixel everywhere', aaLine(aa))
      // A desktop builds the ambient occlusion (governor.ts aoCandidate): its two pipelines compiled by the boot's one
      // validated draw, then its passes skipped on every tier below Ultra (this one starts on Minimal).
      await p.frames(3)
      const skipped = await p.eval(AA_STATE)
      check(aa.ao !== null && aa.ao.on === false && aa.ao.strength === 0 && aa.pipelines.ao === 2 && aa.pipelines.aoDraws >= 3 && skipped.pipelines.aoDraws === aa.pipelines.aoDraws && skipped.pipelines.ao === 2,
        'desktop: the ambient occlusion is built and compiled at boot (two pipelines, drawn once), then skipped below Ultra', `${aaLine(aa)} → ${skipped.pipelines.aoDraws} draws after 3 frames`)
      // The hardware class: a software adapter in a desktop browser is a desktop (never a workstation: no Peak
      // candidate), and the snapshot's quality carries the class the console names.
      const hw = await p.eval(`(() => { const s = window.__SIM__.snapshot(); return { hardware: s.quality.hardware, p99: s.output.p99Ms, lanes: window.__SIM__.engine.sim.meta.agents } })()`)
      check(hw.hardware === 'desktop' && Number.isFinite(hw.p99) && hw.lanes === 512, 'desktop: the hardware class is desktop, the snapshot carries p99 and the lanes are the page\'s ?crowd', JSON.stringify(hw))

      // Sloane's name question shows once the veil has finished fading, and its field takes the keyboard (Concierge.tsx).
      // booted() returns as the fade starts, and a click on the canvas leaves a focused field focused: on a runner slow
      // enough that the field came up after the click below, every key from G on was typed into it (G, M, the tilde and
      // E all failing together, the nix smoke of PRs #71 and #89). So wait for the question, then skip it with Esc as a
      // person who wants to walk would.
      if (await p.waitFor(`!document.querySelector('.boot-veil') && document.activeElement?.getAttribute('aria-label') === 'Your name'`, 30_000).then(() => true, () => false)) {
        await p.tap('Escape', 'Escape', 27)
      }

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
      // The microphone opens as the city starts (MIC_OPEN_BY_DEFAULT); with no device here it reads unavailable. On a
      // phone its pill is a badge inside the minimap's box, so it takes no row of the panels' column.
      const badge = await p.waitFor(`(() => { const m = document.querySelector('[data-hint="voice"]'), map = document.querySelector('[data-hud="minimap"]'); if (!m || !map) return null; const a = m.getBoundingClientRect(), b = map.getBoundingClientRect(); return { phase: m.getAttribute('data-mic'), inMap: a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1, size: [Math.round(a.width), Math.round(a.height)], name: m.getAttribute('aria-label') } })()`, 15_000).catch(() => null)
      check(!!badge && badge.inMap && badge.size[0] >= 24 && badge.size[1] >= 24 && !!badge.name, 'phone: the microphone\'s state is a badge on the minimap\'s corner, at least 24 px, named by its state', JSON.stringify(badge))

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
        const voice = document.querySelector('[data-hint="voice"]')
        return { w: innerWidth, h: innerHeight, zone: zone ? box(zone) : null, buttons, chip: pill && shown(pill) ? box(pill) : null, parts, minimap: hud('minimap'), speed: hud('speed'), panels, mic: voice && shown(voice) ? box(voice) : null, verdict: layer ? layer.getAttribute('data-touch-layout') : null }
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
            // The microphone's badge (up from the start: the microphone opens as the city starts) on screen and clear of
            // every control, the stick, Sloane's chip, the speedometer and the panels.
            if (L.mic) {
              if (!inside(L.mic, L.w, L.h)) bad.push(`${at}: the microphone's badge off screen`)
              if (meets(L.mic, L.zone)) bad.push(`${at}: the microphone's badge over the stick`)
              for (const b of L.buttons) if (meets(L.mic, b)) bad.push(`${at}: the microphone's badge under ${b.name}`)
              if (L.chip && meets(L.mic, L.chip)) bad.push(`${at}: the microphone's badge under Sloane's chip`)
              if (L.speed && meets(L.mic, L.speed)) bad.push(`${at}: the microphone's badge over the speedometer`)
              for (const q of L.panels) if (meets(L.mic, q)) bad.push(`${at}: the microphone's badge over the HUD's "${q.text}"`)
            }
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
        check(bad.length === 0, `phone: ${mode}, at ${views.length} phone and tablet views, every control is on screen and clear of the others, the stick, the speedometer, Sloane's chip and her card, the chip clear of the HUD, the microphone's badge clear of them all, the overlay's own judge says valid, and the Menu opens inside the screen`, bad.slice(0, 24).join('; '))
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
      const aa = await p.eval(AA_STATE)
      check(aa.renderer === 0 && aa.scene === 0 && aa.pipelines && aa.pipelines.msaa4 === 0, 'split: a device that is not a multisampling candidate splits at one sample', aaLine(aa))
      check(aa.ao === null && aa.pipelines.ao === 0, 'split: no post chain, so no ambient occlusion is built or compiled', aaLine(aa))
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
    // ?msaa=1 with the screen split: the post chain is off, so the renderer's own frame takes the 4 samples (its
    // framebuffer target, both views drawn into it), and no scene pass is multisampled or compiled with two targets.
    const m = await open(chrome)
    try {
      await m.goto(`${origin}/?${LIGHT}&players=2&msaa=1`)
      await m.booted()
      await m.frames(3)
      const views = await m.eval('window.__SIM__.snapshot().output.players?.count ?? 1')
      const aa = await m.eval(AA_STATE)
      check(views === 2 && aa.renderer === 4 && aa.scene === 0 && aa.post === false && aa.pipelines && aa.pipelines.msaa4 > 0 && aa.pipelines.twoTargets === 0 && aa.errors.length === 0,
        'split: ?msaa=1 draws both views 4 samples a pixel on the renderer\'s own frame, and validates', `${views} views, ${aaLine(aa)}`)
      await m.shot('split-msaa')
      m.health('split (?msaa=1)')
    } finally { await m.b.close() }
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
      // The hardware readout on the software adapter: a desktop (no Peak candidate), six rows, the window's percentiles.
      const hw = await p.command('hardware', /^machine {3}/m)
      check(/^class {5}desktop {2}profile \w+ {2}start \d \w+ {2}tiers 0\.\.4$/m.test(hw ?? '') && /^lanes {5}512 simulated {2}\(\d+ default for a desktop, 60000 ceiling\)$/m.test(hw ?? '') && /^frames {4}p50 [\d.]+ ms {2}p95 [\d.]+ ms {2}p99 [\d.]+ ms {2}\(\d+ frames in [\d.]+ s\)$/m.test(hw ?? ''),
        'file: hardware names the desktop class, the page\'s 512 lanes and the governor\'s percentiles', (hw ?? '').split('\n').filter((l) => /^(class|lanes|frames) /.test(l.trim())).join(' | ').slice(0, 300))
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
      // The ambient occlusion at Ultra: twelve taps at full strength, its three passes drawn every frame on the two
      // pipelines the boot compiled.
      const ao0 = await p.eval(AA_STATE)
      await p.frames(3)
      const ao1 = await p.eval(AA_STATE)
      check(ao1.ao !== null && ao1.ao.on && ao1.ao.taps === 12 && ao1.ao.strength === 1 && ao1.pipelines.ao === 2 && ao1.pipelines.aoDraws > ao0.pipelines.aoDraws && ao1.errors.length === 0,
        'ultra: the ambient occlusion runs at twelve taps every frame, on the two pipelines compiled at boot', `${aaLine(ao1)}; ${ao1.pipelines.aoDraws - ao0.pipelines.aoDraws} draws in 3 frames`)
      await p.shot('ultra')
      // Peak pinned by hand for a few frames (any device may pin it): Ultra's sun shadows (240 m on the atlas of two 4096
      // cascades, 8192 wide, really allocated) with Peak's three-texel penumbra, 1.25 times the pixel ratio and detailed
      // bodies to 90 m, every pipeline still validating; Ultra back after.
      // By now the concierge has greeted, its name field holding the keyboard: skipped, so the tilde reaches the page.
      await p.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Skip')?.click()`)
      check(await p.openConsole(), 'ultra: the console opens')
      await p.command('quality 5', /tier 5 Peak \(fixed\)/)
      const map = await p.waitFor('window.__SIM__.engine.world.sun.shadow.map?.width === 8192 && window.__SIM__.engine.world.sun.shadow.radius === 3', 60_000).then(() => true, () => false)
      await p.frames(3)
      const pk = await p.eval(PEAK_STATE)
      check(map && pk.mapSize === 4096 && pk.mapWidth === 8192 && pk.cascades === 2 && pk.far === 240 && pk.radius === 3 && Math.abs(pk.ratio - 0.625) < 1e-9 && pk.lod === 90 && pk.errors.length === 0,
        'ultra: Peak pinned draws the sun\'s shadows to 240 m on the 8192-wide atlas of two 4096 cascades with a three-texel penumbra, at 1.25 times the pixel ratio, and validates', JSON.stringify(pk))
      const aoPeak = await p.eval(AA_STATE)
      check(aoPeak.ao !== null && aoPeak.ao.on && aoPeak.ao.taps === 16 && aoPeak.pipelines.ao === 2, 'ultra: Peak takes sixteen occlusion taps, with nothing compiled', aaLine(aoPeak))
      // The console cleared first (as command() waits for it), so the only Peak left on the page is the HUD's.
      await p.enter('clear')
      await p.waitFor(`(${CONSOLE_LOG}?.innerText ?? '').trim() === ''`, 10_000).catch(() => {})
      check(await p.eval(`document.body.innerText.includes('Peak')`), 'ultra: the HUD shows Peak')
      await p.shot('ultra-peak')
      await p.command('quality 4', /tier 4 Ultra \(fixed\)/)
      await p.frames(3)
      const back = await p.eval(PEAK_STATE)
      check(back.mapSize === 4096 && back.far === 240 && back.radius === 2.5 && Math.abs(back.ratio - 0.5) < 1e-9 && back.lod === 45,
        'ultra: Ultra again gives the penumbra and the pixel ratio back', JSON.stringify(back))
      p.saveTranscript('ultra')
      p.health('ultra')
    } finally { await p.b.close() }
    // ?msaa=1 at Ultra under the cinema camera: the scene pass draws colour and velocity 4 samples a pixel, the sun
    // shafts read its multisampled depth, and the chain is built once at 4 (no two-target pipeline at one sample); tier
    // changes across the post chain's range compile nothing at one sample, and ghost view and rain mode validate.
    const m = await open(chrome, { width: 640, height: 360 })
    try {
      await m.goto(`${origin}/?debug&onboarding=0&crowd=512&cars=8&scale=0.5&audio=0&quality=4&msaa=1`)
      await m.booted()
      await m.frames(3)
      const aa = await m.eval(AA_STATE)
      check(aa.scene === 4 && aa.renderer === 0 && aa.pipelines && aa.pipelines.msaa4 > 0 && aa.pipelines.twoTargets > 0 && aa.pipelines.twoTargets1x === 0 && aa.errors.length === 0,
        'ultra: ?msaa=1 multisamples the scene pass (colour and velocity at 4x, nothing of it at 1x), and the chain validates', aaLine(aa))
      // The ambient occlusion reads the multisampled depth (its first sample, loaded without a sampler): a shader the
      // browser refused would have rebuilt the chain at one sample (scene 0x above).
      check(aa.ao !== null && aa.ao.on && aa.ao.taps === 12 && aa.pipelines.ao === 2, 'ultra: ?msaa=1: the ambient occlusion runs on the multisampled depth', aaLine(aa))
      await m.shot('ultra-msaa')
      await m.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Skip')?.click()`)
      check(await m.openConsole(), 'ultra: the console opens (?msaa=1)')
      const before = aa.pipelines.render
      // Over a few frames on each tier: whether the occlusion's passes ran (draws counted) and what it was set to.
      const drawsOver = async (frames) => {
        const a = await m.eval(AA_STATE)
        await m.frames(frames)
        const b = await m.eval(AA_STATE)
        return { state: b, draws: b.pipelines.aoDraws - a.pipelines.aoDraws }
      }
      await m.command('quality 1', /tier 1 Low \(fixed\)/)
      await m.frames(3)
      const low = await drawsOver(2)
      check(low.draws === 0 && low.state.ao.on === false && low.state.ao.strength === 0, 'ultra: Low skips the ambient occlusion\'s passes and applies none', `${aaLine(low.state)}; ${low.draws} draws in 2 frames`)
      await m.command('quality 5', /tier 5 Peak \(fixed\)/)
      await m.frames(3)
      const peak = await drawsOver(2)
      check(peak.draws > 0 && peak.state.ao.on && peak.state.ao.taps === 16, 'ultra: Peak runs it again at sixteen taps', `${aaLine(peak.state)}; ${peak.draws} draws in 2 frames`)
      await m.command('quality 4', /tier 4 Ultra \(fixed\)/)
      await m.frames(3)
      const tiers = await m.eval(AA_STATE)
      check(tiers.errors.length === 0 && tiers.pipelines.twoTargets1x === 0, 'ultra: Low, Peak and Ultra again keep the multisampled chain: no error, nothing compiled at one sample', aaLine(tiers))
      check(tiers.ao.on && tiers.ao.taps === 12 && tiers.pipelines.ao === 2, 'ultra: and the ambient occlusion was never compiled again (its two pipelines)', aaLine(tiers))
      info('ultra: render pipelines compiled by the tier changes (?msaa=1)', `${tiers.pipelines.render - before}`)
      await m.eval('window.__SIM__.engine.setGhost(true)')
      await m.frames(3)
      await m.eval('window.__SIM__.engine.setGhost(false)')
      await m.eval('window.__SIM__.engine.setMatrix(true)')
      await m.frames(3)
      const rain = await drawsOver(2)
      const looks = rain.state
      check(looks.errors.length === 0 && looks.pipelines.twoTargets1x === 0, 'ultra: ghost view and rain mode validate over the multisampled scene', aaLine(looks))
      check(rain.draws === 0 && looks.ao.on === false && looks.ao.strength === 0, 'ultra: rain mode turns the ambient occlusion off', `${aaLine(looks)}; ${rain.draws} draws in 2 frames`)
      await m.shot('ultra-msaa-rain')
      m.saveTranscript('ultra-msaa')
      m.health('ultra (?msaa=1)')
    } finally { await m.b.close() }
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
      // The same hardware, on a screen under 2560 × 1440: the boot multisamples the scene pass by itself (msaaCandidate).
      const aa = await p.eval(AA_STATE)
      check(aa.scene === 4 && aa.renderer === 0 && aa.pipelines && aa.pipelines.msaa4 > 0 && aa.errors.length === 0, 'peak: a high-end desktop starting on Ultra multisamples the scene pass without being asked', aaLine(aa))
      check(aa.ao !== null && aa.ao.on && aa.ao.taps === 12 && aa.pipelines.ao === 2, 'peak: and runs the ambient occlusion at Ultra\'s twelve taps', aaLine(aa))
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
        const map = await p.waitFor('window.__SIM__.engine.world.sun.shadow.map?.width === 8192 && window.__SIM__.engine.world.sun.shadow.radius === 3', 60_000).then(() => true, () => false)
        const at = await p.eval(PEAK_STATE)
        check(map && at.mapSize === 4096 && at.far === 240 && at.radius === 3 && Math.abs(at.ratio - 0.625) < 1e-9 && at.lod === 90, 'peak: Peak draws the sun\'s shadows to 240 m on the 8192-wide atlas with a three-texel penumbra, 1.25 times the pixel ratio and bodies to 90 m', JSON.stringify(at))
        const held = await p.eval(`(() => { window.__SIM__.engine.holdQuality(4); return ${PEAK_STATE} })()`)
        check(held.tier === 4 && held.reason === 'held' && held.held === 4 && held.mapSize === 4096 && held.far === 240 && held.radius === 2.5 && Math.abs(held.ratio - 0.5) < 1e-9,
          'peak: the in-page model\'s hold on the GPU brings Peak down to Ultra and gives the penumbra and the pixels back', JSON.stringify(held))
        await p.eval('window.__SIM__.engine.holdQuality(null)')
        await p.frames(10)
        const released = await p.eval(PEAK_STATE)
        check(released.tier === 4 && released.held === null && released.mapSize === 4096, 'peak: the release keeps Ultra: Peak is not allocated again at the end of an answer', JSON.stringify(released))
        await p.command('quality 5', /tier 5 Peak \(fixed\)/)
        await p.command('quality auto', /tier 5 Peak \(auto\)/)
        await p.eval('window.__smokeFeed = setInterval(() => window.__SIM__.engine.quality.governor.gpuSample(15, performance.now()), 50)')
        const down = await p.waitFor('window.__SIM__.engine.quality.governor.tier === 4', 60_000).then(() => true, () => false)
        const after = await p.eval(PEAK_STATE)
        check(down && after.reason === 'gpu busy' && after.mapSize === 4096 && after.far === 240 && after.radius === 2.5 && Math.abs(after.ratio - 0.5) < 1e-9,
          'peak: GPU readings over the limit bring Peak down to Ultra through the engine (gpu busy), with its penumbra and pixels', JSON.stringify(after))
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
        check(back.mapSize === 4096 && back.far === 240 && back.radius === 2.5 && Math.abs(back.ratio - 0.5) < 1e-9, 'peak: Ultra again gives the penumbra and the pixels back', JSON.stringify(back))
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
      check(s.post === false && s.pipelines && s.pipelines.render > 0 && s.pipelines.twoTargets === 0 && s.pipelines.msaa4 === 0, 'lite: the post chain is off and was never compiled (no colour-and-velocity pipeline), and nothing is multisampled',
        s.pipelines ? `${s.pipelines.render} render pipelines, ${s.pipelines.twoTargets} with two targets, ${s.pipelines.msaa4} at 4x` : 'not counted')
      const liteAo = await p.eval(AA_STATE)
      check(liteAo.ao === null && liteAo.pipelines.ao === 0, 'lite: no ambient occlusion built or compiled', aaLine(liteAo))
      const ran = await p.waitFor(`window.__SIM__.snapshot().process.crowdFrames > ${s.crowdFrames + 2} && window.__SIM__.snapshot().output.fps > 0`, 60_000).then(() => true, () => false)
      check(ran, 'lite: frames are drawn and the crowd runs')
      const hud = await p.eval(`document.body.innerText.includes('Lite')`)
      check(hud, 'lite: the HUD shows the tier as Lite')
      check(q.hardware === 'phone', 'lite: the hardware class is phone (a lite profile sizes as a phone)', JSON.stringify(q))
      // The model in this page on the lite profile: picked from the Menu (the tap opens the picker), kept, loaded only
      // when asked, on the processor with the lite plan, the city held at Lite while it loads.
      const pick = await menuPick(p)
      check(pick.tapped && p.choosers === 1 && KEPT_ON_A_PHONE.test(pick.toast ?? ''), 'lite: Menu › Model file opens the picker from the tap and keeps the file, not loaded until asked',
        `${pick.tapped ? 'tapped' : 'no Menu item'}, ${p.choosers} picker(s); ${pick.toast}`)
      check(await menuConsole(p), 'lite: the Menu opens the console')
      const hw = await p.command('hardware', /^machine {3}/m)
      check(/^class {5}phone {2}profile lite {2}start -1 Lite {2}tiers -1\.\.0$/m.test(hw ?? '') && /^lanes {5}2500 simulated {2}\(2500 default for a phone, 60000 ceiling\)$/m.test(hw ?? ''),
        'lite: hardware names the phone class, the lite profile and its 2,500 lanes', (hw ?? '').split('\n').filter((l) => /^(class|lanes) /.test(l.trim())).join(' | ').slice(0, 300))
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
    // compiled at boot as on every uncapped device, which also shows the pipeline count above can see it. It asks for
    // ?msaa=1 too, which a phone never takes (governor.ts msaaCandidate).
    const q = await androidPhone(chrome)
    try {
      await q.goto(`${origin}/?debug&onboarding=0&audio=0&lite=0&msaa=1`)
      await q.booted()
      const s = await q.eval(`(() => { const S = window.__SIM__, s = S.snapshot(), e = S.engine
        return { quality: s.quality, agents: e.sim.meta.agents, cars: e.sim.meta.count, max: e.quality.governor.max, pipelines: window.__smokePipelines } })()`)
      const aa = await q.eval(AA_STATE)
      check(aa.scene === 0 && aa.renderer === 0 && aa.pipelines && aa.pipelines.msaa4 === 0, 'lite: a phone with ?lite=0 and ?msaa=1 still draws one sample a pixel', aaLine(aa))
      check(aa.ao === null && aa.pipelines.ao === 0, 'lite: and builds no ambient occlusion: a phone never does (governor.ts aoCandidate)', aaLine(aa))
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
    const first = buildWeb({ out: dir })
    const site = await serveStatic(dir)
    /** The build the page on screen says it is (the meta pwa.mjs stamps it with). */
    const BUILD_OF_PAGE = `(document.querySelector('meta[name="agent-city-build"]') || {}).content || ''`
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
      const pagesSent = site.sent('index.html'), wordsSent = site.sent('build.txt')
      await reload(p, url)
      const iso = await p.eval(`!!navigator.serviceWorker.controller && globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function'`)
      check(iso, 'pwa: from the second load the worker serves the page, isolated (the shared-memory bridge)')
      check(site.sent('index.html') === pagesSent && site.sent('build.txt') === wordsSent + 1 && (await p.eval(BUILD_OF_PAGE)) === first.build,
        'pwa: the same build again costs the host one small file (its build word), not the page', `page sent ${site.sent('index.html') - pagesSent} more time(s), build.txt ${site.sent('build.txt') - wordsSent}`)
      // The second visit keeps the model file (from the Menu, as on a phone).
      const pick = await menuPick(p)
      check(pick.tapped && p.choosers === 1 && KEPT_ON_A_PHONE.test(pick.toast ?? ''), 'pwa: the second visit keeps a model file from Menu › Model file',
        `${pick.tapped ? 'tapped' : 'no Menu item'}, ${p.choosers} picker(s); ${pick.toast}`)
      // A second build is published (the same page with a comment after it: another build word). Over a whole link
      // the next load runs it, from the host, isolated, under the worker that still holds the build before; the new
      // build's own worker then keeps it and drops the older copy.
      const next = mkdtempSync(join(tmpdir(), 'agent-city-next-'))
      let second
      try {
        writeFileSync(join(next, 'index.html'), `${readFileSync(DIST, 'utf8')}\n<!-- smoke: a second build -->\n`)
        second = buildWeb({ from: next, out: dir })
      } finally { rmSync(next, { recursive: true, force: true }) }
      // First on a link that goes quiet a megabyte into the new page: past the opening the worker holds back, so part
      // of the host's page has been handed on. The worker gives it up and ends it where it stopped; the page's own
      // watchdog, finding at load that its script never ran under a worker, loads the page again, once; the copy
      // answers that, and the launch starts the build before by itself, with no card to press. (The new build's own
      // worker, installing behind, hangs on the same quiet link and keeps nothing.)
      const LOADED_AGAIN = `sessionStorage.getItem('civic-simulation:loaded-again')`
      const state = `({ build: ${BUILD_OF_PAGE}, isolated: globalThis.crossOriginIsolated === true, card: !!document.querySelector('[data-failure]'), again: ${LOADED_AGAIN} })`
      /**
       * Whether the worker itself asked the host for the page: its word, then the page at its fixed address, before
       * the site's worker is looked at again. The browser's own request for the address that was opened (Chrome sends
       * one beside the worker's answer) carries that address's query string, and is not counted.
       */
      const workerAsked = (since) => {
        const word = since.findIndex((a) => a.startsWith('/build.txt'))
        const page = since.findIndex((a, i) => i > word && a.startsWith('/index.html (stalled)'))
        const sw = since.findIndex((a) => a.startsWith('/sw.js'))
        return word >= 0 && page > word && (sw < 0 || page < sw)
      }
      site.stall('index.html', 1_000_000)
      await p.eval(`sessionStorage.removeItem('civic-simulation:loaded-again')`)
      let from = site.asked().length
      await reload(p, url)
      const fell = await p.eval(state)
      const copies = await p.eval(`caches.open(${JSON.stringify(first.cache)}).then((c) => c.keys()).then((k) => k.length)`)
      let since = site.asked().slice(from)
      check(workerAsked(since) && fell.again !== null && fell.build === first.build && fell.isolated && !fell.card && copies === CACHED.length,
        'pwa: a new build whose download goes quiet a megabyte in leaves the launch to the copy: the page loads again by itself, once, and the build before starts, isolated, its copy whole',
        `the page says ${fell.build} (the copy is ${first.build}), isolated=${fell.isolated}, card=${fell.card}, loaded again=${fell.again !== null}, ${copies} file(s) in the copy; the host was asked: ${since.join(', ')}`)
      // The same link going quiet inside the page's opening, which the worker holds back: nothing of the host's page
      // was handed on, so the copy's body takes that very answer over and the build before starts with no second
      // load. The worker holds a page it gave up against the host for five minutes of its own life, so the browser is
      // told to stop it first, as it does by itself once the worker has had nothing to answer for a while.
      await p.b.send('ServiceWorker.enable').catch(() => {})
      await p.b.send('ServiceWorker.stopAllWorkers')
      site.stall('index.html', 2_000)
      await p.eval(`sessionStorage.removeItem('civic-simulation:loaded-again')`)
      from = site.asked().length
      await reload(p, url)
      const took = await p.eval(state)
      since = site.asked().slice(from)
      check(workerAsked(since) && took.again === null && took.build === first.build && took.isolated && !took.card,
        'pwa: a new build whose download goes quiet in its first bytes is answered by the copy itself: the build before starts, isolated, with no second load',
        `the page says ${took.build} (the copy is ${first.build}), isolated=${took.isolated}, card=${took.card}, loaded again=${took.again !== null}; the host was asked: ${since.join(', ')}`)
      // The link is whole again, and the worker is stopped again so that it asks the host.
      site.flow()
      await p.b.send('ServiceWorker.stopAllWorkers')
      await reload(p, url)
      const ran2 = await p.eval(`({ build: ${BUILD_OF_PAGE}, isolated: globalThis.crossOriginIsolated === true })`)
      check(second.build !== first.build && ran2.build === second.build && ran2.isolated, 'pwa: a newly published build is what the next load runs, isolated, with no second reload',
        `published ${second.build} after ${first.build}; the page says ${ran2.build}, isolated=${ran2.isolated}`)
      const kept = await p.waitFor(`caches.keys().then((k) => k.length === 1 && k[0] === ${JSON.stringify(second.cache)})`, 120_000).then(() => true, () => false)
      check(kept, 'pwa: the new build\'s worker keeps it and drops the copy before', kept ? '' : JSON.stringify(await p.eval('caches.keys()').catch(() => null)))
      site.close()
      await reload(p, url)
      const s = await p.snap()
      const f0 = s.crowdFrames
      const ran = await p.waitFor(`window.__SIM__.snapshot().process.crowdFrames > ${f0 + 2}`, 60_000).then(() => true, () => false)
      const off = await p.eval(`({ build: ${BUILD_OF_PAGE}, isolated: globalThis.crossOriginIsolated === true })`)
      check(ran && s.touch && off.build === second.build && off.isolated, 'pwa: with the host gone the city starts from the offline copy of the new build, isolated, touch controls up', `touch=${s.touch}, build ${off.build}, isolated=${off.isolated}`)
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
   * The one tap to a model on the web copy (see the file's comment). The copy is built here for the tiny model
   * (siteCopy) and served by serveStatic, which notes every path asked for: the manifest alone before the click, the
   * model once after it. The first visit is audited from its start (watchTargets); the second, in a fresh browser, gets
   * the model with one byte flipped, then the right one again.
   */
  async sitemodel(chrome) {
    const pin = tinyPin()
    const offer = `Get the model · ${Math.round(pin.bytes / 1024)} KB`
    const path = `${SITE_DIR}${pin.file}`
    const dir = mkdtempSync(join(tmpdir(), 'agent-city-site-'))
    let site = null
    try {
      const out = await siteCopy(pin, dir)
      site = await serveStatic(out)
      const { origin, served } = site
      const url = `${origin}/?${LIGHT}`
      /** What was asked for under models/ since `from` (an index into served). */
      const models = (from = 0) => served.slice(from).filter((f) => f.startsWith(SITE_DIR))

      // A first visit from a desktop: no model answers Sloane, and the card offers the site's.
      const p = await open(chrome)
      const watch = await watchTargets(p.b)
      try {
        const first = await talkToSloane(p, url)
        check(first.card?.state === 'none' && first.card.offer === offer, `sitemodel: "${SMALL_TALK}" to Sloane with no model brings the card's offer of the site's model, with its size`,
          `${JSON.stringify({ state: first.card?.state, offer: first.card?.offer })}${first.notes.length ? `; ${first.notes.join('; ')}` : ''}`)
        check(JSON.stringify(models()) === JSON.stringify([SITE_MANIFEST]), 'sitemodel: before the click the page has asked this site for the manifest alone, once, and for no byte of the model', models().join(', ') || 'nothing under models/')

        // The click: the model downloaded with its progress on the card, kept, and the last turn asked again.
        const tapAt = watch.requests.length
        const servedAt = served.length
        await p.eval(SITE_WATCH)
        const button = await p.waitFor(hitOf('aside[data-concierge] [data-action="site-model"]'), 10_000).catch(() => null)
        if (button) await clickAt(p, button)
        const t0 = Date.now()
        const end = await p.waitFor(`(() => { const t = ${SLOANE_TALK}, s = window.__smokeSite; return (t.state === 'said' || t.why || (s.states.includes('waiting') && t.state !== 'waiting')) && t })()`, 300_000).catch(() => p.eval(SLOANE_TALK))
        const ms = Date.now() - t0
        const seen = await p.eval('window.__smokeSite')
        check(!!button && seen.steps[0] === 'download' && seen.bars.length > 0 && !end?.why, 'sitemodel: one click downloads the model with its progress on the card (the step, its line and the bar), and keeps it',
          `${button ? 'clicked' : 'no button to click'}; steps ${seen.steps.join(' > ') || 'none'}; lines ${seen.lines.join(' | ') || 'none'}; bar ${seen.bars.join(', ') || 'none'}${end?.why ? `; ${end.why}` : ''}`)
        check(JSON.stringify(models(servedAt)) === JSON.stringify([path]), `sitemodel: the click fetched ${path} beside the page, once`, models(servedAt).join(', ') || 'nothing under models/')
        const said = `${'a'.repeat(CHAT_MAX)}…`
        check(end?.state === 'said' && end.line === said && seen.states.includes('waiting') && seen.starting,
          `sitemodel: the card asks the turn again by itself ("Starting the model…") and the model answers it: ${CHAT_MAX} a's, cut at Sloane's limit`,
          `states ${seen.states.join(' > ')}; ${seen.starting ? 'said it was starting' : 'never said it was starting'}; ${end?.state}: ${(end?.line ?? '').length} chars, ${(end?.line.match(/a/g) ?? []).length} a's, in ${ms} ms`)
        // The desktop's warm load says so in a toast (App.tsx keepPicked); the console says the file is kept and chosen.
        const toasts = await p.waitFor(`(() => { const t = window.__SIM__.engine.toasts.filter((t) => t.title === ${JSON.stringify(MODEL_FILE)}).map((t) => t.body); return t.some((b) => !/^keeping|^reload once/.test(b)) && t })()`, 60_000)
          .catch(() => p.eval(`window.__SIM__.engine.toasts.map((t) => t.title + ': ' + t.body)`))
        check(toasts.some((b) => new RegExp(`^${TINY.replace('.', '\\.')} is loaded in this page \\(`).test(b)), 'sitemodel: the toast says the model is loaded in this page', toasts.join(' | ').slice(0, 300))
        const close = await p.waitFor(hitOf('aside[data-concierge] button[aria-label="Close"]'), 10_000).catch(() => null)
        if (close) await clickAt(p, close)
        check(await p.openConsole(), 'sitemodel: with the card put away, the tilde key opens the console')
        await p.command('operator unlock', /unlocked/)
        const status = await p.command('ask', /installed|ask: /, 60_000)
        check(/inpage: a model file kept in this page/.test(status ?? '') && new RegExp(`${TINY.replace('.', '\\.')}\\s+\\(chosen\\)`).test(status ?? '') && /storage\s+kept in this page/.test(status ?? ''),
          'sitemodel: ask says the inpage provider answers with the file kept in this page, and it is chosen', (status ?? '').split('\n').filter((l) => /provider|storage|installed|runtime/.test(l)).join(' | ').slice(0, 400))
        const kept = await p.eval(KEPT_IN_STORE)
        check(kept.length === 1 && kept[0] === `meta.json + ${TINY}`, 'sitemodel: the page\'s model store holds it, committed', kept.join('; '))
        // The service worker leaves models/ to the network: its offline copy holds the page, and nothing of the model.
        await p.waitFor(`Promise.race([navigator.serviceWorker.ready.then((r) => r.active?.state === 'activated'), new Promise((r) => setTimeout(() => r(false), 2000))])`, 60_000).catch(() => {})
        const cached = await p.eval(CACHED_URLS)
        check(cached.some((u) => u.endsWith('/index.html')) && !cached.some((u) => u.includes(`/${SITE_DIR}`)), 'sitemodel: the service worker\'s cache holds the page and nothing under models/', `${cached.length} cached: ${cached.map((u) => u.slice(origin.length)).join(', ')}`)

        // The audit, over the whole visit: from the click on, nothing but this site.
        const own = (u) => u === origin || u.startsWith(`${origin}/`) || u.startsWith('blob:') || u.startsWith('data:')
        const loopback = (u) => /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(u)
        await settle(() => watch.audit(own).missing.length === 0, 3_000)
        const a = watch.audit(own)
        const looks = watch.requests.slice(0, tapAt).filter((r) => !own(r.url))
        const after = watch.requests.slice(tapAt)
        const strays = [...looks.filter((r) => !loopback(r.url)), ...after.filter((r) => !own(r.url))]
        console.log(`      sitemodel audit: ${a.requests} requests (${after.length} from the click on, ${a.fromWorkers} from workers), ${looks.length} to a model server on this machine before the click, ${a.discovered} workers discovered, ${a.attached} attached, ${a.browserOwned} the browser's own, ${a.sockets.length} sockets, ${a.security.length} security messages`)
        check(strays.length === 0 && after.length > 0 && a.missing.length === 0, `sitemodel: from the click on every request from the page and every worker it started stayed in blob:, data: or ${origin} (before it, only Sloane's look for a model server on this machine left it)`,
          `${after.length} from the click on${strays.length ? `; ${strays.slice(0, 3).map((x) => `${x.type} ${x.url.slice(0, 80)}`).join(', ')}` : ''}${a.missing.length ? `; not watched: ${a.missing.map((m) => `${m.type} ${m.url.slice(0, 60)}`).join(', ')}` : ''}`)
        check(a.sockets.length === 0, 'sitemodel: no WebSocket or WebTransport was opened', a.sockets.slice(0, 3).map((x) => `${x.type} ${x.url}`).join(', '))
        check(a.security.length === 0, 'sitemodel: no security message (a CSP violation among them) from the page or any worker', a.security.slice(0, 3).map((x) => `${x.type}: ${x.text}`).join(' | ').slice(0, 400))
        await p.shot('sitemodel')
        p.health('sitemodel')
      } finally {
        p.saveTranscript('sitemodel')
        await p.b.close()
      }

      // The same copy with one byte of the model flipped, to a fresh browser: refused by its hash, nothing kept; then,
      // with the right file back, the same button keeps it.
      const file = join(out, path)
      const good = readFileSync(file)
      const bad = Buffer.from(good)
      bad[bad.length >> 1] ^= 0xff
      writeFileSync(file, bad)
      const q = await open(chrome)
      try {
        const again = await talkToSloane(q, url)
        check(again.card?.state === 'none' && again.card.offer === offer, 'sitemodel: a fresh browser is offered the site\'s model the same way',
          `${JSON.stringify({ state: again.card?.state, offer: again.card?.offer })}${again.notes.length ? `; ${again.notes.join('; ')}` : ''}`)
        const servedAt = served.length
        const button = await q.waitFor(hitOf('aside[data-concierge] [data-action="site-model"]'), 10_000).catch(() => null)
        if (button) await clickAt(q, button)
        const refused = await q.waitFor(`(() => { const t = ${SLOANE_TALK}; return t.why && t.getting === null && t })()`, 120_000).catch(() => q.eval(SLOANE_TALK))
        check(/its SHA-256 differs/.test(refused?.why ?? '') && refused.offer === offer && refused.state === 'none', 'sitemodel: with one byte flipped the card says its SHA-256 differs, and the button is back',
          `${button ? 'clicked' : 'no button to click'}; ${refused?.state}, ${refused?.offer}: ${refused?.why}`)
        const none = await q.eval(KEPT_IN_STORE)
        check(none.length === 0 && JSON.stringify(models(servedAt)) === JSON.stringify([path]), 'sitemodel: nothing of it was kept (the page\'s model store is empty), and it was fetched once',
          `${none.length ? none.join('; ') : 'the store is empty'}; ${models(servedAt).join(', ') || 'nothing under models/'}`)
        writeFileSync(file, good)
        const retry = await q.waitFor(hitOf('aside[data-concierge] [data-action="site-model"]'), 10_000).catch(() => null)
        if (retry) await clickAt(q, retry)
        const asked = await q.waitFor(`(() => { const t = ${SLOANE_TALK}; return (t.state === 'waiting' || t.state === 'said' || (t.why && t.getting === null)) && t })()`, 120_000).catch(() => q.eval(SLOANE_TALK))
        const keptNow = await q.eval(KEPT_IN_STORE)
        check((asked?.state === 'waiting' || asked?.state === 'said') && keptNow.length === 1 && keptNow[0] === `meta.json + ${TINY}`, 'sitemodel: with the right file back, the same button keeps it and the turn is asked again',
          `${retry ? 'clicked' : 'no button to click'}; ${asked?.state}${asked?.why ? `: ${asked.why}` : ''}; ${keptNow.join('; ') || 'the store is empty'}`)
        await q.shot('sitemodel-refused')
        q.health('sitemodel (one byte flipped)')
      } finally {
        await q.b.close()
      }
    } finally {
      site?.close()
      rmSync(dir, { recursive: true, force: true })
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
    // The page's localhost:9931 is the fake llama-server below; every other address stays off the network.
    const llama = await serveLlamaServer()
    const p = await open(chrome, { args: [`--host-resolver-rules=MAP localhost:9931 127.0.0.1:${llama.port}`] })
    try {
      // The slowest day (one sim minute a real minute at 60 fps, slower on a software GPU, whose frames are clamped to
      // 50 ms of sim time): the clock an action set is read back minutes later, so the hour is compared, not the minute.
      await p.goto(`${origin}/?${LIGHT}&day=1440&vram=24`)
      await p.booted()
      check(await p.openConsole(), 'actions: the tilde key opens the console')
      await p.command('operator unlock', /unlocked/)
      // The GPUs' memory from the address (router.ts fit): the fit row names it; nothing on this machine answers, so nothing is measured.
      check(!!(await p.command('ask', /fit\s+24\.0 GB given by the page's address \(vram=\)/)), 'actions: vram=24 in the address shows on the fit row')
      check(!!(await p.command('ask vram 16', /vram\s+16\.0 GB at the console/)), 'actions: ask vram 16 is kept')
      check(!!(await p.command('ask vram 5000', /ask vram takes the GPUs' memory in GB, from 0 to 4096/)), 'actions: ask vram refuses 5000')
      check(!!(await p.command('ask vram auto', /vram\s+auto: 24\.0 GB from the page's address/)), 'actions: ask vram auto hands back to the address')
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

      // A llama-server on its new default port (router.ts KNOWN_SERVERS): nothing answers at 8080, so auto's second
      // round finds it on 9931, through the page's own air gap and connect-src, and keeps that address.
      llama.on()
      await p.command('ask provider auto', /provider\s+auto/)
      check(!!(await p.command('ask', /found\s+llamacpp at http:\/\/localhost:9931, found answering on this machine/, 30_000)),
        'actions: auto finds a llama-server on its new default port, 9931, when nothing answers at 8080')
      await p.shot('actions')
      p.health('actions')
    } finally {
      p.saveTranscript('actions')
      await p.b.close()
      llama.close()
    }
  },

  /**
   * The first walk (09_Cognition/firstWalk.ts, onboarding/FirstWalk.tsx and exam.ts) end to end on its accessible
   * path: `?tutorial=1` opens on it; no button or key puts the card away; each stage's one button has Sloane do the
   * stage's action (walk, plan a goal, a car's door, a workplace's doorway, the wardrobe card, `laws`) and the page's
   * own readings pass it (the wardrobe's stage when its Done puts the card away); on the last card the three line buttons and Run run the exit program through the console's NoirScript session,
   * where the exam seals the live kernel, sets twenty-four sub-agents to work through the team runner from where the
   * workplace stage left the visitor (inside a room, where nobody within earshot can be asked over) and unlocks the
   * city; the card goes and the pass is kept.
   */
  async walk(chrome, origin) {
    const p = await open(chrome)
    try {
      await p.goto(`${origin}/?${LIGHT}&tutorial=1`)
      await p.booted()
      const stage = () => p.eval('window.__SIM__.walk()')
      const card = () => p.eval(`!!document.querySelector('[data-walk-show]')`)
      const show = () => p.eval(`(() => { const b = document.querySelector('[data-walk-show]'); if (!b) return null; const t = b.textContent.trim(); b.click(); return t })()`)
      const past = (s, ms = 30_000) => p.waitFor(`window.__SIM__.walk() !== ${JSON.stringify(s)}`, ms).then(() => true, () => false)
      const shown = await p.waitFor(`!!document.querySelector('[data-walk-show]')`, 30_000).then(() => true, () => false)
      check(shown && (await stage()) === 'move', 'walk: a first run opens on the first walk, at its first stage', `card ${shown}, stage ${await stage()}`)
      const buttons = await p.eval(`[...document.querySelectorAll('[data-walk] button')].map((b) => b.textContent.trim() + (b.getAttribute('aria-label') ? ' [' + b.getAttribute('aria-label') + ']' : ''))`)
      check(buttons.length > 0 && !buttons.some((w) => /skip|close|dismiss|later|\bx\b/i.test(w)), 'walk: the card has no skip and no close', buttons.join(', '))
      // A first run also opens on Sloane's name question: from 60 rem across her card stands left of the walk's, at every
      // window size up to where the two met before (about 1,300 px); in a narrower window the walk's card steps aside
      // while hers is open, and comes back at 960 px.
      if (await p.waitFor(`!!document.querySelector('aside[data-concierge="ask"]')`, 30_000).then(() => true, () => false)) {
        const apart = []
        for (const [width, height] of [[960, 540], [1024, 640], [1152, 648], [1280, 720], [1366, 657]]) {
          await p.b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
          await p.frames(3)
          const m = await p.eval(`(() => { const r = (q) => { const e = document.querySelector(q); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom } }; return { walk: r('[data-walk]'), sloane: r('aside[data-concierge="ask"]') } })()`)
          const meet = !m.walk || !m.sloane || (m.sloane.r > m.walk.l && m.sloane.l < m.walk.r && m.sloane.b > m.walk.t && m.sloane.t < m.walk.b)
          apart.push(`${width}x${height} ${meet ? 'MEET' : `gap ${Math.round(m.walk.l - m.sloane.r)}`}`)
        }
        check(!apart.some((a) => a.includes('MEET')), 'walk: Sloane\'s open question stands beside the walk\'s card, never under it', apart.join(', '))
        await p.b.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false })
        const aside = await p.waitFor(`!document.querySelector('[data-walk]') && !!document.querySelector('aside[data-concierge="ask"]')`, 5_000).then(() => true, () => false)
        await p.b.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 540, deviceScaleFactor: 1, mobile: false })
        const back = await p.waitFor(`!!document.querySelector('[data-walk-show]')`, 5_000).then(() => true, () => false)
        await p.frames(3)
        await p.shot('walk-beside')
        check(aside && back, 'walk: under 60 rem across the walk\'s card steps aside while Sloane\'s card is open, and is back at 960 px', `aside at 900 px ${aside}, back at 960 px ${back}`)
      } else check(false, 'walk: Sloane\'s name question opens with the walk')
      await p.tap('Escape', 'Escape', 27)
      await p.frames(3)
      check(await card(), 'walk: Escape does not put the card away')

      // 1 Look and walk: "Walk for me" turns the head and walks; the page's own readings pass the stage.
      const seen = () => p.eval(`(() => { const s = window.__SIM__.snapshot(); return { yaw: s.customer.viewYaw, m: s.experience.distanceWalked, x: s.customer.x, z: s.customer.z } })()`)
      const w0 = await seen()
      const b1 = await show()
      const walked = await past('move')
      const w1 = await seen()
      check(walked, `walk: "${b1}" turns the head and walks the three metres`, `stage ${await stage()}; yaw ${w0.yaw.toFixed(2)} -> ${w1.yaw.toFixed(2)}, ${(w1.m - w0.m).toFixed(1)} m walked, from (${w0.x.toFixed(1)}, ${w0.z.toFixed(1)}) to (${w1.x.toFixed(1)}, ${w1.z.toFixed(1)})`)
      // 2 Talk to Sloane: "Plan one for me" plans a goal as the chip would.
      check((await stage()) === 'voice', 'walk: stage 2 is a goal for Sloane', `stage ${await stage()}`)
      const b2 = await show()
      check(await past('voice'), `walk: "${b2}" plans a goal and the stage passes`, `stage ${await stage()}`)
      // 3 The parked fleet: "Take me to a car" puts the visitor at a parked car's door and the realm opens it.
      check((await stage()) === 'fleet', 'walk: stage 3 is the parked fleet', `stage ${await stage()}`)
      const b3 = await show()
      check(await past('fleet', 60_000), `walk: "${b3}" puts the visitor at a car's door and the realm opens it`, `stage ${await stage()}`)
      check((await p.snap()).mode === 'vehicle', 'walk: at the wheel after stage 3')
      // 4 Inside a workplace: "Take me inside" puts the visitor down just inside a doorway (out of the car first).
      check((await stage()) === 'work', 'walk: stage 4 is a workplace', `stage ${await stage()}`)
      const b4 = await show()
      check(await past('work', 60_000), `walk: "${b4}" puts the visitor inside a workplace`, `stage ${await stage()}`)
      check((await p.snap()).mode === 'foot', 'walk: on foot again inside')
      // 5 Your look: "Open the wardrobe" opens the wardrobe card the chip opens (the walk's card steps aside while it is
      // open); its Done puts it away, and that passes the stage.
      check((await stage()) === 'style', 'walk: stage 5 is the wardrobe', `stage ${await stage()}`)
      const b5 = await show()
      const dressed = await p.waitFor(`!!document.querySelector('[data-customizer]') && !document.querySelector('[data-walk-show]')`, 10_000).then(() => true, () => false)
      check(dressed && (await stage()) === 'style', `walk: "${b5}" opens the wardrobe card and the walk's card steps aside`, `wardrobe ${dressed}, stage ${await stage()}`)
      await p.shot('walk-wardrobe')
      await p.eval(`document.querySelector('[data-customizer] [data-action="done"]')?.click()`)
      const away = await past('style', 10_000)
      check(away && await p.waitFor(`!document.querySelector('[data-customizer]') && !!document.querySelector('[data-walk-show]')`, 10_000).then(() => true, () => false),
        'walk: Done puts the wardrobe away, the stage passes and the walk\'s card is back', `stage ${await stage()}`)
      // 6 Ring-0: "Open it for me" runs laws at the console.
      check((await stage()) === 'ring0', 'walk: stage 6 is Ring-0', `stage ${await stage()}`)
      const b6 = await show()
      check(await past('ring0', 30_000), `walk: "${b6}" runs laws and the stage passes`, `stage ${await stage()}`)
      // 7 The way out, from where the workplace stage left the visitor: inside a room, where the recruiter can ask nobody
      // over (the spot a swarm of people within earshot left a visitor shut in), then the three line buttons and Run,
      // each line's doors reported by the console.
      check((await stage()) === 'exam', 'walk: stage 7 is the exit program', `stage ${await stage()}`)
      const ear = await earshot(p)
      check(ear.me !== null && ear.near.length === 0, 'walk: where the workplace stage left the visitor, nobody within earshot can be asked over', ear.me ? `at ${ear.me.x.toFixed(1)}, ${ear.me.z.toFixed(1)}: ${ear.near.length ? `agents ${ear.near.join(', ')}` : 'nobody'}` : 'not on foot')
      const lines = await p.eval(`[...document.querySelectorAll('[data-walk-line-button]')].length`)
      check(lines === 3 && await p.eval(`!!document.querySelector('[data-walk-run]')`), 'walk: the last card has three line buttons and Run', `${lines} lines`)
      await p.shot('walk-exam')
      const line = async (i, done) => {
        await p.eval(`document.querySelector('[data-walk-line-button="${i}"]')?.click()`)
        const typed = await p.waitFor(`(document.querySelector('[aria-label="Ring-0 command line"]')?.value ?? '').startsWith('noir ')`, 10_000).then(() => true, () => false)
        await p.eval(`document.querySelector('[data-walk-run]')?.click()`)
        const t = await p.waitFor(`(() => { const t = ${CONSOLE_LOG}?.innerText ?? ''; return ${done}.test(t) && t })()`, 30_000).catch(() => null)
        p.transcript.push(`[line ${i}, typed ${typed}]\n${t ?? `(nothing matching ${done} after 30 s)\n${await p.eval(`${CONSOLE_LOG}?.innerText ?? ''`).catch(() => '')}`}`)
        return { typed, t }
      }
      const l1 = await line(1, /verify_ring0: seal [0-9a-f]{8} over 4 laws, 15 checks, contained, realm standing/)
      check(l1.typed && l1.t !== null, 'walk: line 1 is typed into the prompt and Run seals the live kernel', lastLine(l1.t))
      const l2 = await line(2, /spawn_subagents: \d+ of 24 (?:sub-agents at work|set to work) for sim2real_workplaces/)
      check(l2.t !== null && !/spawn_subagents: 0 of 24/.test(l2.t), 'walk: line 2 sets the swarm to work through the team runner with nobody near (at least one lane running)', lastLine(l2.t))
      const l3 = await line(3, /unlock_city: /)
      check(/unlock_city: the city is yours/.test(l3.t ?? ''), 'walk: line 3 unlocks the city', lastLine(l3.t))
      const gone = await p.waitFor(`window.__SIM__.walk() === null && !document.querySelector('[data-walk-show]')`, 10_000).then(() => true, () => false)
      const kept = await p.eval(`(() => { try { return JSON.parse(localStorage.getItem('civic-simulation:first-walk:v1') ?? 'null') } catch { return null } })()`)
      check(gone && kept?.v === 1 && kept?.passed === true, 'walk: the card goes and the pass is kept for the next visit', JSON.stringify(kept))
      await p.eval(`document.querySelector('[aria-label="Ring-0 command line"]')?.focus()`)
      // The swarm stays at work once the city is open: the console's lanes reads the team the exit program dispatched.
      const lanesOut = await p.command('lanes', /team: |lanes: /)
      const running = Number(/team: Send 24 sub-agents to the robotics lab, [^\n]* \((\d+) running, \d+ isolated/.exec(lanesOut ?? '')?.[1] ?? 0)
      check(running >= 1, 'walk: lanes shows the twenty-four sub-agents at the sixteen workplaces, still running after the city opens', (lanesOut ?? '').split('\n').find((l) => /team: |lanes: /.test(l))?.trim().slice(0, 240) ?? 'nothing printed')
      const status = await p.command('tutorial status', /tutorial: /)
      check(/^tutorial: the first walk is passed: the city is yours$/.test(lastLine(status)), 'walk: tutorial status says the walk is passed', lastLine(status))
      await p.shot('walk')
      p.health('walk')
    } finally {
      p.saveTranscript('walk')
      await p.b.close()
    }
  },

  /**
   * The first walk's look stage through a shop (storefronts.ts, StoreCard.tsx): with Sloane's name question skipped and
   * the earlier stages passed (the first two by their buttons, the next two by the reports the page would make, the
   * car and the room, which the walk scenario takes by their buttons), Sloane names the shops on a map that has
   * them; the visitor stands in the first shop, the HUD's Browse chip is not under the walk's card and opens the
   * shop's card; the walk's card steps aside; trying a line on costs nothing and passes nothing; Done puts the shop's
   * card away, which passes the stage, and the walk's card is back on Ring-0.
   */
  async walkshop(chrome, origin) {
    const p = await open(chrome)
    try {
      await p.goto(`${origin}/?${LIGHT}&tutorial=1`)
      await p.booted()
      const stage = () => p.eval('window.__SIM__.walk()')
      const past = (s, ms = 30_000) => p.waitFor(`window.__SIM__.walk() !== ${JSON.stringify(s)}`, ms).then(() => true, () => false)
      // Sloane's name question skipped with Esc, as the desktop scenario does and a visitor who wants to walk would: her
      // open card stands over the bottom-centre prompts in a window this short, the Browse chip among them.
      if (await p.waitFor(`!document.querySelector('.boot-veil') && document.activeElement?.getAttribute('aria-label') === 'Your name'`, 30_000).then(() => true, () => false)) {
        await p.tap('Escape', 'Escape', 27)
      }
      await p.waitFor(`!!document.querySelector('[data-walk-show]')`, 30_000).catch(() => {})
      // Walk for me, then Plan one for me (a goal planned as the chip would).
      await p.eval(`document.querySelector('[data-walk-show]')?.click()`)
      await past('move')
      await p.eval(`document.querySelector('[data-walk-show]')?.click()`)
      await past('voice')
      for (const ev of ['vehicle', 'inside']) await p.eval(`window.__SIM__.walkNote(${JSON.stringify(ev)})`)
      const at = await p.waitFor(`window.__SIM__.walk() === 'style'`, 10_000).then(() => true, () => false)
      const said = await p.eval(`document.querySelector('[data-walk]')?.innerText ?? ''`)
      check(at && /shops on the street/.test(said) && /press B/.test(said), 'walkshop: the look stage names the shops, in the keyboard\'s words', `stage ${await stage()}; ${said.replace(/\s+/g, ' ').slice(0, 200)}`)
      // Into the first shop (the city always has five), on foot, at its fitting spot; the realm's reading says so.
      const shop = await p.eval(`window.__SIM__.shops()[0]`)
      await p.eval(`window.__SIM__.teleport(${shop.fitting.x}, ${shop.fitting.z}, 0)`)
      const inShop = await p.waitFor(`window.__SIM__.snapshot().customer.shop?.index === 0 && !!document.querySelector('[data-hint="shop"]')`, 20_000).then(() => true, () => false)
      // The Browse chip is the shop's way in on every device; nothing of the walk's card lies over its middle.
      const over = await p.eval(`(() => { const c = document.querySelector('[data-hint="shop"]'); if (!c) return 'no chip'; const r = c.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (top && c.contains(top)) return ''; const at = (e) => e ? e.tagName.toLowerCase() + [...e.attributes].filter((a) => a.name.startsWith('data-') || a.name === 'aria-label').map((a) => '[' + a.name + '=' + a.value.slice(0, 24) + ']').join('') : 'nothing'; return 'under ' + at(top) + ' in ' + at(top?.closest('aside,section,div[data-walk]') ?? null) + ' at ' + Math.round(r.left) + ',' + Math.round(r.top) })()`)
      await p.shot('walk-shop-chip')
      check(inShop && over === '', 'walkshop: in the shop, the Browse chip shows and the walk\'s card does not cover it', `${shop.name}: in ${inShop}, chip ${over || 'clear'}`)
      await p.eval(`document.querySelector('[data-hint="shop"]')?.click()`)
      const open1 = await p.waitFor(`!!document.querySelector('[data-store]') && !document.querySelector('[data-walk-show]')`, 10_000).then(() => true, () => false)
      check(open1 && (await stage()) === 'style', 'walkshop: Browse opens the shop\'s card and the walk\'s card steps aside', `card ${open1}, stage ${await stage()}`)
      const credits = () => p.eval('window.__SIM__.shopkeeper.purse.credits()')
      const c0 = await credits()
      const tried = await p.eval(`(() => { const b = document.querySelector('[data-store] [data-action="try"]'); if (!b) return false; b.click(); return true })()`)
      await p.frames(3)
      check(tried && (await credits()) === c0 && (await stage()) === 'style', 'walkshop: trying a line on costs nothing and does not pass the stage', `tried ${tried}, credits ${c0} -> ${await credits()}, stage ${await stage()}`)
      await p.shot('walk-shop')
      await p.eval(`document.querySelector('[data-store] [data-action="done"]')?.click()`)
      const away = await past('style', 10_000)
      check(away && (await stage()) === 'ring0' && await p.waitFor(`!document.querySelector('[data-store]') && !!document.querySelector('[data-walk-show]')`, 10_000).then(() => true, () => false),
        'walkshop: Done puts the shop\'s card away, the stage passes and the walk\'s card is back on Ring-0', `stage ${await stage()}`)
      p.health('walkshop')
    } finally { await p.b.close() }
  },

  /**
   * The first walk's look stage through a home (src/01_Initialize_World/properties.ts, HomeCard.tsx): the stage names the
   * homes, the home's chip shows clear of the walk's card, B opens the doorstep card (nothing is bought, and the walk's
   * card steps aside), and the card put away with Esc passes the stage.
   */
  async walkhome(chrome, origin) {
    const p = await open(chrome)
    try {
      await p.goto(`${origin}/?${LIGHT}&tutorial=1`)
      await p.booted()
      const stage = () => p.eval('window.__SIM__.walk()')
      const past = (s, ms = 30_000) => p.waitFor(`window.__SIM__.walk() !== ${JSON.stringify(s)}`, ms).then(() => true, () => false)
      // Sloane's name question skipped with Esc, as walkshop does: her open card stands over the bottom-centre chips here.
      if (await p.waitFor(`!document.querySelector('.boot-veil') && document.activeElement?.getAttribute('aria-label') === 'Your name'`, 30_000).then(() => true, () => false)) {
        await p.tap('Escape', 'Escape', 27)
      }
      await p.waitFor(`!!document.querySelector('[data-walk-show]')`, 30_000).catch(() => {})
      await p.eval(`document.querySelector('[data-walk-show]')?.click()`)
      await past('move')
      await p.eval(`document.querySelector('[data-walk-show]')?.click()`)
      await past('voice')
      for (const ev of ['vehicle', 'inside']) await p.eval(`window.__SIM__.walkNote(${JSON.stringify(ev)})`)
      const at = await p.waitFor(`window.__SIM__.walk() === 'style'`, 10_000).then(() => true, () => false)
      const said = await p.eval(`document.querySelector('[data-walk]')?.innerText ?? ''`)
      check(at && /a home for sale/.test(said) && /press B to read its deed/.test(said), 'walkhome: the look stage names the homes, in the keyboard\'s words', `stage ${await stage()}; ${said.replace(/\s+/g, ' ').slice(0, 260)}`)
      // Into the first home (the Micro-Loft; every city seed has the seven), on foot, three metres past its doorway: the
      // line from the sidewalk's arrival spot through the doorway points into the room.
      const homes = await p.eval('window.__SIM__.homes()')
      const h = homes[0]
      const dx = h.door.x - h.arrival.x, dz = h.door.z - h.arrival.z, len = Math.hypot(dx, dz) || 1
      await p.eval(`window.__SIM__.teleport(${h.door.x + (dx / len) * 3}, ${h.door.z + (dz / len) * 3}, 0)`)
      const inHome = await p.waitFor(`window.__SIM__.snapshot().customer.home?.index === 0 && !!document.querySelector('[data-hint="home"]')`, 20_000).then(() => true, () => false)
      const chip = await p.eval(`document.querySelector('[data-hint="home"]')?.textContent ?? ''`)
      const over = await p.eval(`(() => { const c = document.querySelector('[data-hint="home"]'); if (!c) return 'no chip'; const r = c.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (top && c.contains(top)) return ''; const at = (e) => e ? e.tagName.toLowerCase() + [...e.attributes].filter((a) => a.name.startsWith('data-') || a.name === 'aria-label').map((a) => '[' + a.name + '=' + a.value.slice(0, 24) + ']').join('') : 'nothing'; return 'under ' + at(top) + ' in ' + at(top?.closest('aside,section,div[data-walk]') ?? null) + ' at ' + Math.round(r.left) + ',' + Math.round(r.top) })()`)
      await p.shot('walk-home-chip')
      check(inHome && over === '' && chip.includes(`For sale: ${h.name}`), 'walkhome: in the home, its For sale chip shows and the walk\'s card does not cover it', `${h.name}: in ${inHome}, chip "${chip}" ${over || 'clear'}`)
      // B, as the stage says, from the city rather than a field: the canvas is clicked first, as a person would.
      const credits = () => p.eval('window.__SIM__.shopkeeper.purse.credits()')
      const c0 = await credits()
      await p.mouse('mousePressed', 480, 270, 1)
      await p.mouse('mouseReleased', 480, 270)
      await p.tap('KeyB', 'b', 66)
      const open1 = await p.waitFor(`!!document.querySelector('aside[data-home="0"]') && !document.querySelector('[data-walk-show]')`, 10_000).then(() => true, () => false)
      check(open1 && (await stage()) === 'style', 'walkhome: B opens the home\'s doorstep card and the walk\'s card steps aside', `card ${open1}, walk card ${await p.eval(`!!document.querySelector('[data-walk-show]')`)}, stage ${await stage()}`)
      await p.shot('walk-home')
      await p.tap('Escape', 'Escape', 27)
      const away = await past('style', 10_000)
      check(away && (await stage()) === 'ring0' && await p.waitFor(`!document.querySelector('aside[data-home]') && !!document.querySelector('[data-walk-show]')`, 10_000).then(() => true, () => false),
        'walkhome: Esc puts the doorstep card away, the stage passes and the walk\'s card is back on Ring-0', `stage ${await stage()}`)
      check((await credits()) === c0 && ((await p.eval('window.__SIM__.snapshot().customer.ownedHomes')) & 1) === 0, 'walkhome: reading the deed bought nothing', `credits ${c0} -> ${await credits()}`)
      p.health('walkhome')
    } finally { await p.b.close() }
  },

  /**
   * The first walk's card on a phone (onboarding/FirstWalk.tsx's touch and between places): it steps aside while
   * Sloane's open card takes the band it stands in, keeps under the minimap row and her chip and above the buttons held
   * upright, stands between the stick and the buttons above the HUD's chips held sideways (the 38 px sliver it was
   * above the thumbs there) or, where that band is short, under her chip moved up to the top row, lies under the touch
   * Menu's sheet, and steps aside at the wheel sideways, where the car's buttons fill that band.
   */
  async walkphone(chrome, origin) {
    const p = await open(chrome, { mobile: true })
    try {
      const view = async (width, height, settle = true) => {
        await p.b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true, screenOrientation: height > width ? { type: 'portraitPrimary', angle: 0 } : { type: 'landscapePrimary', angle: 90 } })
        if (!settle) return
        await p.frames(3)
        await new Promise((r) => setTimeout(r, 400))
      }
      // Every box the card must keep clear of: Sloane's open card or chip, the minimap, the HUD's chips at the foot and
      // each touch control but the look area (the right half of the screen, under everything).
      const boxes = () => p.eval(`(() => {
        const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) } : null }
        const others = [['sloane', document.querySelector('aside[data-concierge]')], ['chip', document.querySelector('[data-concierge="chip"]')], ['minimap', document.querySelector('[data-hud="minimap"]')], ['foot', document.querySelector('[data-hud="foot"]')], ['strip', document.querySelector('[data-walk-strip]')],
          ...[...document.querySelectorAll('[data-touch]')].filter((e) => e.getAttribute('data-touch') !== 'look').map((e) => [e.getAttribute('data-touch'), e])]
        return { w: innerWidth, h: innerHeight, walk: box(document.querySelector('[data-walk]')), others: others.map(([k, e]) => ({ k, ...box(e) })).filter((o) => o.l !== undefined) } })()`)
      // A tap where a thumb would put it (a touch screen's buttons answer the pointer, not a click): on the shown button
      // `which` picks (a page function of the button), or the one whose words are `which`, scrolled to first (the Menu's
      // sheet scrolls on a short screen).
      const tapOn = async (which, id) => {
        const pick = typeof which === 'string' ? `(b) => b.textContent.trim() === ${JSON.stringify(which)}` : which.pick
        const c = await p.waitFor(`(() => { const b = [...document.querySelectorAll('button')].find((b) => (${pick})(b) && b.getBoundingClientRect().width > 0); if (!b) return null; b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`, 10_000).catch(() => null)
        if (!c) return false
        await p.touch('touchStart', [[c[0], c[1], id]])
        await p.touch('touchEnd', [])
        return true
      }
      const MENU = { pick: `(b) => b.getAttribute('aria-label') === 'Menu'` }
      const TEXT_SIZE = { pick: `(b) => b.textContent.trim().startsWith('Text size')` }
      const textSize = () => p.eval(`window.getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom').trim()`)
      // The touch Menu's Text size item, pressed until the text is at `scale` (it keeps the sheet open), then shut.
      const setText = async (scale) => {
        if (!(await tapOn(MENU, 40)) || !(await p.waitFor(`!!document.querySelector('[role="menu"]')`, 5_000).then(() => true, () => false))) return false
        for (let i = 0; i < 5 && (await textSize()) !== String(scale / 100); i++) { await tapOn(TEXT_SIZE, 41 + i); await p.frames(2) }
        await tapOn(MENU, 47)
        await p.waitFor(`!document.querySelector('[role="menu"]')`, 5_000).catch(() => {})
        await p.frames(3)
        await new Promise((r) => setTimeout(r, 400))
        return (await textSize()) === String(scale / 100)
      }
      // The card scrolls when its words outrun the band (as on every phone): its button is scrolled to, then hit-tested.
      const reachable = () => p.eval(`(() => { const b = document.querySelector('[data-walk-show]'); if (!b) return false; b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!e && b.contains(e) })()`)
      const meets = (a, o) => a.r > o.l + 1 && a.l < o.r - 1 && a.b > o.t + 1 && a.t < o.b - 1
      const clear = (m) => !m.walk ? ['no card'] : [
        ...(m.walk.l < -1 || m.walk.t < -1 || m.walk.r > m.w + 1 || m.walk.b > m.h + 1 ? [`off screen ${JSON.stringify(m.walk)}`] : []),
        ...m.others.filter((o) => meets(m.walk, o)).map((o) => `over ${o.k}`),
      ]
      await view(390, 844, false)
      await p.goto(`${origin}/?${LIGHT}&tutorial=1`)
      await p.booted()
      await p.waitFor(`!document.querySelector('.boot-veil')`, 30_000).catch(() => {})
      // Upright, Sloane's name question opens with the walk and takes the band above the thumbs: the walk's card waits.
      const asking = await p.waitFor(`!!document.querySelector('aside[data-concierge="ask"]')`, 30_000).then(() => true, () => false)
      await p.frames(3)
      const away = await p.eval(`!document.querySelector('[data-walk]')`)
      await p.shot('walk-phone-ask')
      check(asking && away, 'walkphone: upright, the walk\'s card steps aside while Sloane asks the name', `asking ${asking}, card away ${away}`)
      // Skip; once her card has settled into the chip the walk's card is back, clear of everything it shares the screen with.
      await p.eval(`(() => { const s = [...document.querySelectorAll('aside[data-concierge] button')].find((b) => b.textContent.trim() === 'Skip'); if (s) s.click() })()`)
      const back = await p.waitFor(`!document.querySelector('aside[data-concierge]') && !!document.querySelector('[data-walk-show]')`, 20_000).then(() => true, () => false)
      const upright = await boxes()
      check(back && clear(upright).length === 0, 'walkphone: once her card settles, the walk\'s card is back upright, clear of her chip, the minimap and every touch control', `${JSON.stringify(upright.walk)} ${clear(upright).join(', ')}`)
      await p.shot('walk-phone-upright')
      // Sideways at three phone sizes, standing in a shop so the HUD's chips at the foot are up (its Browse chip; the
      // captions are silent under audio=0): between the stick and the buttons, above those chips, tall enough to read.
      const shop = await p.eval(`window.__SIM__.shops()[0]`)
      await p.eval(`window.__SIM__.teleport(${shop.fitting.x}, ${shop.fitting.z}, 0)`)
      await p.waitFor(`!!document.querySelector('[data-hint="shop"]')`, 20_000).catch(() => {})
      const sideways = []
      const sidewaysAt = async (label, need) => {
        const m = await boxes()
        const bad = clear(m)
        for (const k of need) if (!m.others.some((o) => o.k === k)) bad.push(`missing ${k}`)
        if (m.walk && m.walk.b - m.walk.t < 120) bad.push(`${m.walk.b - m.walk.t} px tall`)
        if (!(await reachable())) bad.push('its button is covered or gone')
        sideways.push(`${label} ${bad.length ? bad.join(', ') : `${m.walk.l}..${m.walk.r} x ${m.walk.t}..${m.walk.b}`}`)
      }
      for (const [w, h] of [[IPHONE.width, IPHONE.height], [844, 390], [667, 375]]) {
        await view(w, h)
        await sidewaysAt(`${w}x${h}`, ['chip', 'minimap', 'foot', 'stick'])
      }
      await p.shot('walk-phone-sideways')
      // The latch on the HUD's foot (footPeak.ts): the foot grown by a stand-in for two caption lines leaves the band
      // short, so her chip moves up to the top row and the card under it; the foot shrinking back (the lines expiring)
      // leaves both where they are, so they never jump from under a thumb; a new window size lets the latch go.
      await view(IPHONE.width, IPHONE.height)
      const chipTopNow = () => p.eval(`(() => { const c = document.querySelector('[data-concierge="chip"]'); return c ? Math.round(c.getBoundingClientRect().top) : null })()`)
      const settle = async () => { await p.frames(3); await new Promise((r) => setTimeout(r, 400)) }
      const lowChip = await chipTopNow()
      await p.eval(`(() => { const f = document.querySelector('[data-hud="foot"]'); if (!f) return; const d = document.createElement('div'); d.id = 'smoke-lines'; d.style.cssText = 'height:64px;width:8px'; f.prepend(d) })()`)
      await settle()
      const raisedChip = await chipTopNow()
      const raised = await boxes()
      await p.eval(`document.getElementById('smoke-lines')?.remove()`)
      await settle()
      const heldChip = await chipTopNow()
      const heldWalk = (await boxes()).walk
      await view(844, 390)
      await view(IPHONE.width, IPHONE.height)
      const lowAgain = await chipTopNow()
      check(lowChip > 100 && raisedChip !== null && raisedChip < 40 && clear(raised).length === 0 && heldChip === raisedChip && heldWalk?.t === raised.walk?.t && lowAgain === lowChip,
        'walkphone: a taller foot moves her chip up and the card under it, a shorter one leaves them there, and a new window size lets go',
        `chip top ${lowChip} -> ${raisedChip} (card ${JSON.stringify(raised.walk)} ${clear(raised).join(', ')}) -> ${heldChip} (card top ${heldWalk?.t}) -> ${lowAgain} after a new size`)
      // The touch Menu opens over the card (the Ring-0 stage sends the visitor to it): every item, scrolled to, is on top.
      await view(IPHONE.width, IPHONE.height)
      let sheet = 'did not open'
      if (await tapOn(MENU, 39) && await p.waitFor(`!!document.querySelector('[role="menu"]')`, 5_000).then(() => true, () => false)) {
        sheet = await p.eval(`(() => { const items = [...document.querySelectorAll('[role="menu"] button')]; const under = items.filter((b) => { b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + Math.min(24, r.width / 2), r.top + r.height / 2); return !e || !b.contains(e) }); return under.length ? 'under: ' + under.map((b) => b.textContent.trim()).join(', ') : items.length + ' items on top' })()`)
        await tapOn(MENU, 38)
        await p.waitFor(`!document.querySelector('[role="menu"]')`, 5_000).catch(() => {})
      }
      check(/items on top/.test(sheet), 'walkphone: held sideways, the touch Menu opens over the walk\'s card', sheet)
      // Larger text, from the Menu's Text size. Where the band between the thumbs is short of 8 rem (in the shop at 125 %,
      // its Browse chip at the foot; anywhere at 175 % on a phone this short), Sloane's chip moves up to the top row and
      // the card rises over the HUD's header and readout to stand under it: her chip stays on screen and clear.
      const chipTop = () => p.eval(`(() => { const c = document.querySelector('[data-concierge="chip"]'); return c ? Math.round(c.getBoundingClientRect().top) : null })()`)
      const at125 = await setText(125)
      await sidewaysAt(`${IPHONE.width}x${IPHONE.height} at 125 % (${at125}, her chip at ${await chipTop()} px)`, ['chip', 'minimap', 'foot', 'stick'])
      const at175 = await setText(175)
      await sidewaysAt(`${IPHONE.width}x${IPHONE.height} at 175 % (${at175}, her chip at ${await chipTop()} px)`, ['chip', 'minimap', 'foot', 'stick'])
      await view(667, 375)
      await sidewaysAt(`667x375 at 175 % (her chip at ${await chipTop()} px)`, ['chip', 'minimap', 'foot', 'stick'])
      await p.shot('walk-phone-large-text')
      await view(IPHONE.width, IPHONE.height)
      const at100 = await setText(100)
      check(!sideways.some((x) => /over|off|tall|covered|no card|missing|false/.test(x)) && at100, 'walkphone: held sideways, the walk\'s card stands between the thumbs above the HUD\'s chips, or, where that band is short, under Sloane\'s chip moved up to the top row, clear of everything, its button reachable and on top', sideways.join('; '))
      // An Android phone's page held upright (360 x 552 CSS px: a 360 px wide phone under its browser's address bar and
      // toolbar), still in the shop. The band between Sloane's chip and the thumbs is all the city there is, so the card
      // folds to a strip under the HUD's header: a touch on the look area folds it, a tap on the strip opens it, and open
      // it stands clear of her chip, the strip, the minimap, the HUD's chips and every control. The HUD's chips at the
      // foot (the shop's Browse chip, the captions) stand above the stick and left of the buttons, and take a tap: the
      // HUD's layer is over the touch layer, whose look area covers the right half.
      {
        await view(360, 552)
        const folds = []
        const strip = () => p.eval(`(() => { const s = document.querySelector('[data-walk-strip]'); if (!s) return null; const r = s.getBoundingClientRect(); return { open: s.getAttribute('aria-expanded') === 'true', stage: s.getAttribute('data-walk-strip'), at: [r.x + r.width / 2, r.y + r.height / 2], hit: s.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) } })()`)
        // A point on the look area that nothing stands over (found, not assumed: the card's and the chips' boxes move).
        const lookAt = () => p.eval(`(() => { for (let y = Math.round(innerHeight * 0.2); y < innerHeight * 0.8; y += 8) for (let x = innerWidth - 24; x > innerWidth / 2; x -= 8) { const e = document.elementFromPoint(x, y); if (e && e.closest('[data-touch="look"]')) return [x, y] } return null })()`)
        const tapAt = async (at, id) => { await p.touch('touchStart', [[at[0], at[1], id]]); await p.touch('touchEnd', []); await p.frames(3); await new Promise((r) => setTimeout(r, 300)) }
        let st = await strip()
        if (!st) folds.push('no strip')
        else {
          if (!st.hit) folds.push('the strip does not take a tap')
          if (!st.open) { await tapAt(st.at, 60); st = await strip() }
          const opened = await boxes()
          if (!st?.open || !opened.walk) folds.push('the strip did not open the card')
          else {
            const bad = clear(opened)
            for (const k of ['chip', 'minimap', 'stick', 'strip']) if (!opened.others.some((o) => o.k === k)) bad.push(`missing ${k}`)
            if (!(await reachable())) bad.push('its button is covered or gone')
            if (bad.length) folds.push(`open: ${bad.join(', ')}`)
          }
          const look = await lookAt()
          if (!look) folds.push('no free point on the look area')
          else {
            await tapAt(look, 61)
            st = await strip()
            const gone = await p.eval(`!document.querySelector('[data-walk]')`)
            if (!gone || st?.open !== false) folds.push(`a touch on the look area left the card open (${gone}, ${st?.open})`)
          }
          await tapAt((await strip()).at, 62)
          st = await strip()
          if (!st?.open || !(await p.eval(`!!document.querySelector('[data-walk-show]')`))) folds.push('a tap on the strip did not open it again')
        }
        const foot = await p.eval(`(() => {
          const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom } }
          const f = document.querySelector('[data-hud="foot"]'), shop = document.querySelector('[data-hint="shop"]')
          const controls = [...document.querySelectorAll('[data-touch]')].filter((e) => e.getAttribute('data-touch') !== 'look' && e.getBoundingClientRect().width > 0)
          const meets = (a, b) => a.r > b.l + 1 && a.l < b.r - 1 && a.b > b.t + 1 && a.t < b.b - 1
          const r = shop?.getBoundingClientRect()
          return { foot: !!f, under: f ? controls.filter((c) => meets(box(f), box(c))).map((c) => c.getAttribute('data-touch')) : [], shop: !!shop, hit: !!r && shop.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) } })()`)
        if (!foot.foot || !foot.shop) folds.push(`no HUD chips at the foot (${foot.foot}, shop ${foot.shop})`)
        if (foot.under.length) folds.push(`the HUD's chips at the foot under ${foot.under.join(', ')}`)
        if (foot.shop && !foot.hit) folds.push('the Browse chip does not take a tap')
        await p.shot('walk-phone-android-upright')
        check(folds.length === 0, 'walkphone: on an Android phone\'s page upright (360 x 552) the card folds to its strip at a touch on the look area and opens from it, clear of everything; the HUD\'s chips at the foot stand clear of the stick and the buttons, and the Browse chip takes a tap', folds.join('; ') || `strip ${st?.stage}`)
      }
      // At the wheel: sideways the car's buttons fill the band, so the card steps aside; upright it is folded to its strip
      // (getting into a car folds it), and opened from the strip it keeps under her chip, above the car's buttons.
      await view(IPHONE.width, IPHONE.height)
      const car = await p.eval(nearestCarParked(0))
      let inCar = false
      if (car >= 0) {
        await p.waitFor(`Math.abs(window.__SIM__.engine.sim.state.poses[${car} * 28 + 8]) < 0.2`, 60_000).catch(() => {})
        for (const [ox, oz] of SIDES) {
          await p.eval(`(() => { const P = window.__SIM__.engine.sim.state.poses; window.__SIM__.teleport(P[${car} * 28] + ${ox}, P[${car} * 28 + 2] + ${oz}) })()`)
          if (await p.waitFor('window.__SIM__.snapshot().input.nearVehicle', 15_000).then(() => true, () => false)) break
        }
        // Beside the car on the Android page upright (360 x 552) the Enter car button stands above the Menu, so the band
        // under her chip is short: the open card stands above her chip instead, over the HUD's header, the strip and the
        // minimap (none takes a touch while it is open: it keeps its own), never over her chip (the stages ask for a tap
        // on it) nor a control.
        await view(360, 552)
        if (await p.eval(`document.querySelector('[data-walk-strip]')?.getAttribute('aria-expanded') === 'false'`)) await tapOn({ pick: `(b) => b.hasAttribute('data-walk-strip')` }, 30)
        await p.waitFor(`!!document.querySelector('[data-walk]')`, 5_000).catch(() => {})
        await p.frames(2)
        const beside = await boxes()
        const near = !beside.walk ? ['no card'] : beside.others.filter((o) => o.k !== 'strip' && o.k !== 'minimap' && meets(beside.walk, o)).map((o) => `over ${o.k}`)
        if (!(await p.eval(`[...document.querySelectorAll('[data-touch]')].some((b) => b.textContent.trim() === 'Enter car' && b.getBoundingClientRect().width > 0)`))) near.push('no Enter car button')
        if (beside.walk && (beside.walk.t < -1 || beside.walk.b > beside.h + 1)) near.push(`off screen ${JSON.stringify(beside.walk)}`)
        const chipBox = beside.others.find((o) => o.k === 'chip')
        if (beside.walk && chipBox && beside.walk.b > chipBox.t + 1) near.push('not above her chip')
        if (await p.eval(`document.querySelector('[data-walk]')?.hasAttribute('data-walk-through') ?? true`)) near.push('lets touches through above her chip')
        if (!(await reachable())) near.push('its button is covered or gone')
        await p.shot('walk-phone-beside-car')
        check(near.length === 0, 'walkphone: beside a car on the Android page upright the open card stands above Sloane\'s chip, clear of it and of every control, and keeps its touches', near.join('; ') || `${beside.walk.t}..${beside.walk.b}, her chip at ${chipBox?.t}`)
        await view(IPHONE.width, IPHONE.height)
        if (await tapOn('Enter car', 31)) inCar = await p.waitFor(`window.__SIM__.snapshot().input.mode === 'vehicle'`, 20_000).then(() => true, () => false)
      }
      if (inCar) {
        await p.frames(3)
        const parked = await p.eval(`!document.querySelector('[data-walk]')`)
        await view(390, 844)
        const folded = await p.eval(`!document.querySelector('[data-walk]') && document.querySelector('[data-walk-strip]')?.getAttribute('aria-expanded') === 'false'`)
        if (folded) await tapOn({ pick: `(b) => b.hasAttribute('data-walk-strip')` }, 33)
        await p.waitFor(`!!document.querySelector('[data-walk]')`, 5_000).catch(() => {})
        await p.frames(2)
        const wheel = await boxes()
        await p.shot('walk-phone-wheel')
        await view(IPHONE.width, IPHONE.height)
        await tapOn('Exit car', 32)
        const out = await p.waitFor(`window.__SIM__.snapshot().input.mode !== 'vehicle' && !!document.querySelector('[data-walk-show]')`, 20_000).then(() => true, () => false)
        check(parked && folded && clear(wheel).length === 0 && out, 'walkphone: at the wheel the card steps aside held sideways, is folded upright and, opened from its strip, keeps under her chip and above the car\'s buttons, and is back on foot', `sideways away ${parked}; upright folded ${folded}, opened ${JSON.stringify(wheel.walk)} ${clear(wheel).join(', ')}; back on foot ${out}`)
      } else check(false, 'walkphone: the Enter car button enters the nearest car', `car ${car}`)
      p.health('walkphone')
    } finally { await p.b.close() }
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
      // Sixteen: seed 1337's metropolis window has at least sixteen candidate lots (twelve transit hubs and four more), so
      // every slot is filled (region/workplaces.test.ts pins the lots).
      check(r.drawn === 16 && r.crowd === 16, 'lakefront: sixteen indoor workplaces drawn, and sixteen reached the worker\'s crowd', `${r.drawn} drawn, ${r.crowd} in the worker's crowd`)
      check(Number.isInteger(r.working) && r.working >= 0, 'lakefront: the HUD counts who is at work indoors', `working ${r.working}`)
      // The window's transit (region/transit.ts): the realm schedules craft on the window's own network (its elevated loop,
      // drone corridors and racetrack at least) and the page draws them and the painted crossings.
      const c = await p.eval(`(() => { const e = window.__SIM__.engine, kinds = {}
        for (const t of (e.craftView?.tracks ?? [])) kinds[t.kind] = (kinds[t.kind] ?? 0) + 1
        return { craft: e.sim.meta.craft, view: e.craftView !== null, kinds, markings: e.world.scene.children.some((m) => m.name === 'RegionMarkings') } })()`)
      check(c.craft > 0 && c.view && c.kinds.train === 1 && c.kinds.drone > 0 && c.kinds.plane === 1, 'lakefront: the window has scheduled craft on its own loop, corridors and racetrack, and the page draws them', `${c.craft} craft, view ${c.view}, kinds ${JSON.stringify(c.kinds)}`)
      check(c.markings, 'lakefront: the zebra crossings are drawn')
      const f0 = (await p.snap()).crowdFrames
      const advanced = await p.waitFor(`window.__SIM__.snapshot().process.crowdFrames > ${f0 + 2}`, 60_000).then(() => true, () => false)
      check(advanced, 'lakefront: the crowd simulation advances', `${f0} -> ${(await p.snap()).crowdFrames}`)
      // Medium's 1024 cascades (the atlas two of them wide), not the parked map a tier without shadows keeps: the sun's shadow
      // pass has drawn the region, so every shadowed shader was built (health() below fails on any one three could not build).
      const shadow = await p.waitFor(`(() => { const sh = window.__SIM__.engine.world.sun.shadow
        return window.__SIM__.engine.world.sun.castShadow && sh.mapSize.x === 1024 && sh.map?.width === 2048 && sh.map?.height === 1024 && sh.camera.far === 120 })()`, 60_000).then(() => true, () => false)
      await p.frames(3)
      check(shadow, 'lakefront: at Medium the sun\'s two shadow cascades draw the region to 120 m (the 2048 × 1024 atlas allocated)')
      check(r.errors.length === 0, 'lakefront: the engine recorded no error', r.errors.join(' | ').slice(0, 300))
      await p.shot('lakefront')
      p.health('lakefront')
    } finally { await p.b.close() }
  },

  /**
   * The seven homes (src/01_Initialize_World/properties.ts) and their deeds, on the progression keeper (a new operator,
   * level 1): the only purchase is the Micro-Loft's free deed. The design house's card sells it and goes there (Go home); the
   * doorstep card (HomeCard.tsx) opens inside the home and holds the avatar still; the Penthouse's card rides a visitor
   * up to its sky floor, which holds them and whose staged furniture is solid; the lakefront metropolis has the seven
   * too, none with a sky floor, and the deed bought in the city is still owned there.
   */
  async homes(chrome, origin) {
    const p = await open(chrome)
    const at = (sel) => `document.querySelector(${JSON.stringify(sel)})`
    try {
      await p.goto(`${origin}/?${LIGHT}&seed=1337`)
      await p.booted()
      const homes = await p.eval('window.__SIM__.homes()')
      check(homes.length === 7 && homes.every((h, i) => h.home === i && h.name && h.address), 'homes: seed 1337 has its seven homes, each with its deed\'s name and its address', homes.map((h) => `${h.home} ${h.name} (${h.address})`).join(', '))
      await p.mouse('mousePressed', 480, 270, 1)
      await p.mouse('mouseReleased', 480, 270)
      // Into Lintel & Lumen Design House, and B opens its card.
      const shop = await p.eval(`window.__SIM__.shops().find((s) => s.kind === 'designHouse')`)
      await p.eval(`window.__SIM__.teleport(${shop.fitting.x}, ${shop.fitting.z})`)
      const inShop = await p.waitFor(`window.__SIM__.snapshot().customer.shop?.kind === 'designHouse'`, 30_000).then(() => true, () => false)
      check(inShop, 'homes: the avatar stands in Lintel & Lumen Design House')
      await p.tap('KeyB', 'b', 66)
      const card = await p.waitFor(`!!${at('aside[data-store="designHouse"] [data-item="224"]')}`, 20_000).then(() => true, () => false)
      check(card, 'homes: B opens the design house\'s card, the deeds on sale in it')
      const rows = await p.eval(`(() => { const row = (id) => ${at('aside[data-store="designHouse"]')}?.querySelector('[data-item="' + id + '"]')
        return { loft: row(224)?.getAttribute('data-verdict'), pier: row(226)?.getAttribute('data-verdict'), pierWhy: row(226)?.querySelector('[data-why]')?.textContent ?? '',
          place: row(224)?.querySelector('[data-place]')?.textContent ?? '', go: row(224)?.querySelector('[data-action="go"]')?.textContent ?? '' } })()`)
      check(rows.loft === '0' && rows.pier === '2' && /needs level 6/.test(rows.pierWhy), 'homes: the Micro-Loft\'s deed can be had, and the Pierside Timber Loft\'s asks for level 6', JSON.stringify(rows))
      check(rows.go === 'Visit' && rows.place.startsWith(homes[0].address), 'homes: the loft\'s row says where it stands and offers Visit', `${rows.go}: ${rows.place}`)
      // Claim the loft: free, so the operator's credits stay as they were.
      const before = await p.eval('window.__SIM__.shopkeeper.purse.credits()')
      await p.eval(`${at('aside[data-store="designHouse"] [data-item="224"] [data-action="buy"]')}?.click()`)
      const owned = await p.waitFor(`!!${at('aside[data-store="designHouse"] [data-item="224"][data-owned]')}`, 10_000).then(() => true, () => false)
      const bought = await p.eval(`({ said: ${at('aside[data-store="designHouse"] [data-said]')}?.textContent ?? '', credits: window.__SIM__.shopkeeper.purse.credits(), go: ${at('aside[data-store="designHouse"] [data-item="224"] [data-action="go"]')}?.textContent ?? '' })`)
      check(owned && bought.credits === before && /Metro-Line Micro-Loft is yours/.test(bought.said), 'homes: the loft\'s deed is claimed for nothing, and the card says where it is', `${bought.said}; ${bought.credits} credits`)
      check(bought.go === 'Go home', 'homes: the owned deed\'s row offers Go home', bought.go)
      // Go home: the sidewalk in front of the loft's doorway, the store card closed behind.
      await p.eval(`${at('aside[data-store="designHouse"] [data-item="224"] [data-action="go"]')}?.click()`)
      const a = homes[0].arrival
      const arrived = await p.waitFor(`(() => { const v = window.__SIM__.engine.sim.state.avatar; return Math.hypot(v.x - ${a.x}, v.z - ${a.z}) < 0.6 })()`, 30_000).then(() => true, () => false)
      check(arrived, 'homes: Go home puts the avatar on the sidewalk in front of the loft\'s doorway', JSON.stringify({ arrival: a, at: await p.snap().then((s) => ({ x: s.x, z: s.z })) }))
      const closed = await p.waitFor(`!${at('aside[data-store]')}`, 10_000).then(() => true, () => false)
      check(closed, 'homes: the design house\'s card closed once the avatar left the shop')
      // W walks in through the planters' centre gap; the chip says the home is the player's. The canvas is clicked
      // first, as a person would: Sloane's name field takes the focus back when the card goes.
      await p.mouse('mousePressed', 480, 270, 1)
      await p.mouse('mouseReleased', 480, 270)
      await p.key('keyDown', 'KeyW', 'w', 87)
      const inside = await p.waitFor(`window.__SIM__.snapshot().customer.home?.index === 0`, 30_000).then(() => true, () => false)
      await p.frames(6)
      await p.key('keyUp', 'KeyW', 'w', 87)
      check(inside, 'homes: W walks the avatar into the loft')
      const chip = await p.waitFor(`(() => { const c = ${at('[data-hint="home"]')}; return c && c.textContent })()`, 10_000).catch(() => '')
      const snap = await p.eval('window.__SIM__.snapshot().customer')
      check(/Furnish Metro-Line Micro-Loft/.test(chip ?? '') && snap.home?.owned === true && (snap.ownedHomes & 1) === 1, 'homes: the HUD\'s chip offers to furnish the loft, which is yours', `${chip}; ${JSON.stringify(snap.home)} owned ${snap.ownedHomes}`)
      // B opens the doorstep card, which says Yours; the avatar stands still under it, W held or not.
      await p.tap('KeyB', 'b', 66)
      const doorstep = await p.waitFor(`!!${at('aside[data-home="0"]')}`, 10_000).then(() => true, () => false)
      const yours = await p.eval(`({ yours: ${at('aside[data-home="0"] [data-yours]')}?.textContent ?? '', card: window.__SIM__.snapshot().customer.home?.card === true })`)
      check(doorstep && yours.yours === 'Yours' && yours.card, 'homes: B opens the loft\'s doorstep card, and it says Yours', JSON.stringify(yours))
      const h0 = await p.snap()
      await p.eval(`window.__SIM__.hold('KeyW', true)`)
      await p.frames(10)
      await p.eval(`window.__SIM__.hold('KeyW', false)`)
      const h1 = await p.snap()
      check(dist(h0, h1) < 0.05, 'homes: under the doorstep card the avatar stands still with W held', `${dist(h0, h1).toFixed(3)} m`)
      await p.tap('Escape', 'Escape', 27)
      const gone = await p.waitFor(`!${at('aside[data-home]')} && window.__SIM__.snapshot().customer.home?.card === false`, 10_000).then(() => true, () => false)
      check(gone, 'homes: Esc closes the doorstep card')
      // The Penthouse's sky floor: walked into the hall (onto its apron, 3 m in from the doorway), B opens the deed's
      // card for a visitor (level 1), and its Go up rides there.
      const pent = homes[3]
      check(!!pent.sky && pent.sky.y > 60, 'homes: seed 1337\'s Penthouse has a sky floor up its tower', JSON.stringify(pent.sky))
      const inward = Math.hypot(pent.cx - pent.door.x, pent.cz - pent.door.z)
      await p.eval(`window.__SIM__.teleport(${pent.door.x + (3 * (pent.cx - pent.door.x)) / inward}, ${pent.door.z + (3 * (pent.cz - pent.door.z)) / inward})`)
      const inPent = await p.waitFor(`window.__SIM__.snapshot().customer.home?.index === 3`, 30_000).then(() => true, () => false)
      check(inPent, 'homes: the avatar stands in the Penthouse\'s hall')
      await p.tap('KeyB', 'b', 66)
      const row = await p.waitFor(`!!${at('aside[data-home="3"] [data-action="floor"]')}`, 10_000).then(() => true, () => false)
      const up = await p.eval(`({ text: ${at('aside[data-home="3"] [data-action="floor"]')}?.textContent ?? '', off: ${at('aside[data-home="3"] [data-action="floor"]')}?.disabled ?? true, line: ${at('aside[data-home="3"] [data-floor]')}?.textContent ?? '' })`)
      check(row && up.text === 'Go up' && !up.off && /m up the tower/.test(up.line), 'homes: B opens the Penthouse\'s card, whose floor row offers Go up to a visitor', JSON.stringify(up))
      await p.eval(`${at('aside[data-home="3"] [data-action="floor"]')}?.click()`)
      const rode = await p.waitFor(`Math.abs(window.__SIM__.engine.sim.state.avatar.feetY - ${pent.sky.y}) < 0.1 && window.__SIM__.snapshot().customer.home?.room === 7`, 30_000).then(() => true, () => false)
      const upstairs = await p.waitFor(`!${at('aside[data-home]')}`, 10_000).then(() => true, () => false)
      const skyChip = await p.waitFor(`(() => { const c = ${at('[data-hint="home"]')}; return c && /sky floor/.test(c.textContent) && c.textContent })()`, 10_000).catch(() => '')
      check(rode && upstairs && /sky floor/.test(skyChip ?? ''), 'homes: Go up puts the avatar on the sky floor, the card closed, the chip naming the sky floor', `${skyChip}; feet ${(await p.eval('window.__SIM__.engine.sim.state.avatar.feetY')).toFixed(2)} at ${pent.sky.y}`)
      // W walks from the arrival toward the far glass; the staged sofa (solid, at the floor's height) stops it.
      const where = `(() => { const v = window.__SIM__.engine.sim.state.avatar, n = ${inward}
        return { x: v.x, z: v.z, feet: v.feetY, u: ((v.x - ${pent.cx}) * (${pent.door.x} - ${pent.cx}) + (v.z - ${pent.cz}) * (${pent.door.z} - ${pent.cz})) / n } })()`
      const s0 = await p.eval(where)
      await p.eval(`window.__SIM__.hold('KeyW', true)`)
      const went = await p.waitFor(`(() => { const v = window.__SIM__.engine.sim.state.avatar; return Math.hypot(v.x - ${s0.x}, v.z - ${s0.z}) >= 3.6 })()`, 30_000).then(() => true, () => false)
      await p.frames(90)
      await p.eval(`window.__SIM__.hold('KeyW', false)`)
      const s1 = await p.eval(where)
      const moved = Math.hypot(s1.x - s0.x, s1.z - s0.z)
      check(went && moved >= 3.6 && moved <= 5 && s1.u >= 1.6 && Math.abs(s1.feet - pent.sky.y) < 0.1, 'homes: upstairs W walks from the arrival until the staged sofa stops it, on the floor', `moved ${moved.toFixed(2)} m to u ${s1.u.toFixed(2)}, feet ${s1.feet.toFixed(2)}`)
      await p.shot('homes-sky')
      await p.shot('homes')
      const errs = (await p.snap()).errors
      check(errs.length === 0, 'homes: the engine recorded no error', errs.join(' | ').slice(0, 300))
      p.health('homes')

      // The lakefront metropolis, in the same browser: its seven homes, and the loft still owned. reload() marks the
      // city's page first, so the checks below cannot read it while the new one commits.
      await reload(p, `${origin}/?map=lakefront&${LIGHT}`)
      const lake = await p.eval(`({ region: window.__SIM__.engine.places !== null, homes: window.__SIM__.homes().length, kept: window.__SIM__.engine.homes.length, owned: window.__SIM__.snapshot().customer.ownedHomes })`)
      check(lake.region && lake.homes === 7 && lake.kept === 7, 'homes: the lakefront metropolis has its seven homes', JSON.stringify(lake))
      check((lake.owned & 1) === 1, 'homes: the loft claimed in the city is still owned there (one browser record)', `owned ${lake.owned}`)
      const noSky = await p.eval('window.__SIM__.homes().every((h) => h.sky === null)')
      check(noSky, 'homes: no home in the lakefront metropolis has a sky floor')
      p.health('homes lakefront')
    } finally { await p.b.close() }
  },

  /**
   * Furnishing (HomeCard.tsx's furnishing view, slice 2b) in the loft, by keyboard. The loft is claimed through the
   * shopkeeper, and the operator's record then gets level 2 and 3,000 credits by hand (a new operator has 150, and no
   * furniture costs less than 1,100): the record in this browser rewritten and sealed again as progression.ts sealOf
   * does, then the page reloaded, which is the only way a record changes outside the page's own keeper. In the loft B
   * opens the furnishing view; the strip's Order buys a bookcase and a sofa; E takes the bookcase in hand, the arrows
   * move the cursor and Enter places it; Q takes the sofa and it is placed the same way. Each piece is one more
   * collider in the physics realm. A real mouse click on View leaves that button focused, and Chromium counts the next
   * key as keyboard use (:focus-visible) before the key's own handlers run: Enter must still be the card's Place (with
   * the sofa in hand over the sofa, it picks that sofa up), never a second press of View; Z undoes it. Done closes the
   * view, the layout is saved in this browser, and after a reload the loft still has both pieces, both solid, and the
   * view says so.
   */
  async furnish(chrome, origin) {
    const p = await open(chrome)
    const at = (sel) => `document.querySelector(${JSON.stringify(sel)})`
    const view = 'aside[data-home="0"][data-furnish] [data-furnishing]'
    const colliders = () => p.eval('window.__SIM__.engine.sim.state.physics.colliders')
    // Go home, then W walks in through the planters (the canvas clicked first, as a person would).
    const walkIn = async () => {
      await p.eval('window.__SIM__.engine.goHome(0)')
      const a = (await p.eval('window.__SIM__.homes()'))[0].arrival
      await p.waitFor(`(() => { const v = window.__SIM__.engine.sim.state.avatar; return Math.hypot(v.x - ${a.x}, v.z - ${a.z}) < 0.6 })()`, 30_000).catch(() => {})
      await p.mouse('mousePressed', 480, 270, 1)
      await p.mouse('mouseReleased', 480, 270)
      await p.key('keyDown', 'KeyW', 'w', 87)
      const inside = await p.waitFor(`window.__SIM__.snapshot().customer.home?.index === 0`, 30_000).then(() => true, () => false)
      await p.frames(6)
      await p.key('keyUp', 'KeyW', 'w', 87)
      await p.frames(10)
      return inside
    }
    const cursor = () => p.eval(`${at(view)}?.getAttribute('data-cursor') ?? ''`)
    // The arrows, one cell a press, until the cursor stands on (c, r): ← → are columns, ↑ ↓ rows (the back at the top).
    const moveTo = async (c, r) => {
      for (let i = 0; i < 64; i++) {
        const now = await cursor()
        const [nc, nr] = now.split(',').map(Number)
        if (nc === c && nr === r) return true
        const [code, vk] = nc < c ? ['ArrowRight', 39] : nc > c ? ['ArrowLeft', 37] : nr < r ? ['ArrowDown', 40] : ['ArrowUp', 38]
        await p.tap(code, code, vk)
        await p.waitFor(`(${at(view)}?.getAttribute('data-cursor') ?? '') !== ${JSON.stringify(now)}`, 10_000).catch(() => {})
      }
      return false
    }
    const inHand = async (id, code, key, vk) => {
      for (let i = 0; i < 4 && (await p.eval(`${at(view)}?.getAttribute('data-piece')`)) !== String(id); i++) {
        await p.tap(code, key, vk)
        await p.frames(2)
      }
      return (await p.eval(`${at(view)}?.getAttribute('data-piece')`)) === String(id)
    }
    try {
      await p.goto(`${origin}/?${LIGHT}&seed=1337`)
      await p.booted()
      // The loft claimed (free), then the record given level 2 and 3,000 credits and sealed again, and the page reloaded.
      const claimed = await p.eval(`(() => { const k = window.__SIM__.shopkeeper; k.buy(224); return k.owns(224) })()`)
      check(claimed, 'furnish: the Metro-Line Micro-Loft\'s deed is claimed')
      await p.eval(`(() => {
        const key = 'civic-simulation:progress:v1'
        const data = JSON.parse(localStorage.getItem(key))
        const w = data.words
        w[14] = 2
        w[16] = 3000
        let h = 0x811c9dc5
        for (let i = 0; i < w.length; i++) {
          if (i === 63) continue
          const v = w[i] >>> 0
          h = Math.imul(h ^ (v & 0xff), 0x01000193)
          h = Math.imul(h ^ ((v >>> 8) & 0xff), 0x01000193)
          h = Math.imul(h ^ ((v >>> 16) & 0xff), 0x01000193)
          h = Math.imul(h ^ (v >>> 24), 0x01000193)
        }
        w[63] = h | 0
        localStorage.setItem(key, JSON.stringify(data))
      })()`)
      await reload(p, `${origin}/?${LIGHT}&seed=1337`)
      const purse = await p.eval(`(() => { const k = window.__SIM__.shopkeeper; return { level: k.purse.level(), credits: k.purse.credits(), loft: k.owns(224) } })()`)
      check(purse.level === 2 && purse.credits === 3000 && purse.loft, 'furnish: the reloaded record is level 2 with 3,000 credits and the loft', JSON.stringify(purse))
      const inside = await walkIn()
      check(inside, 'furnish: the avatar walks into the loft')
      const chip = await p.waitFor(`(() => { const c = ${at('[data-hint="home"]')}; return c && c.textContent })()`, 10_000).catch(() => '')
      check(/Furnish Metro-Line Micro-Loft/.test(chip ?? ''), 'furnish: the HUD\'s chip says Furnish', chip)
      const base = await colliders()

      // B opens the furnishing view: the strip has all nine lines, none owned, the bookcase and the sofa for sale.
      await p.tap('KeyB', 'b', 66)
      const opened = await p.waitFor(`!!${at(view)}`, 10_000).then(() => true, () => false)
      const strip = await p.eval(`(() => { const s = ${at(view)}; const li = [...(s?.querySelectorAll('li[data-line]') ?? [])]
        return { lines: li.length, owned: li.filter((l) => l.hasAttribute('data-owned')).length, order: li.filter((l) => l.querySelector('[data-action="order"]')).map((l) => l.getAttribute('data-line')),
          saved: ${at('aside[data-home="0"] [data-saved]')}?.textContent ?? '' } })()`)
      check(opened && strip.lines === 9 && strip.owned === 0 && strip.order.includes('163') && strip.order.includes('164'), 'furnish: B in the owned loft opens the furnishing view, its strip of nine lines offering Order', JSON.stringify(strip))
      check(strip.saved === 'Saved in this browser · Esc or B to finish', 'furnish: the view says where it saves and how to finish', strip.saved)
      // Order the bookcase (1,100) and the sofa (1,600) from the strip.
      await p.eval(`${at(`${view} li[data-line="164"] [data-action="order"]`)}?.click()`)
      await p.waitFor(`!!${at(`${view} li[data-line="164"][data-owned]`)}`, 10_000).catch(() => {})
      await p.eval(`${at(`${view} li[data-line="163"] [data-action="order"]`)}?.click()`)
      await p.waitFor(`!!${at(`${view} li[data-line="163"][data-owned]`)}`, 10_000).catch(() => {})
      const paid = await p.eval(`(() => { const k = window.__SIM__.shopkeeper; return { credits: k.purse.credits(), bookcase: k.owns(164), sofa: k.owns(163) } })()`)
      check(paid.bookcase && paid.sofa && paid.credits === 300, 'furnish: Order buys the bookcase and the sofa through the shopkeeper', JSON.stringify(paid))

      // E takes the bookcase; the arrows bring the cursor to the back wall; Enter places it, and the realm gains its collider.
      const bookcase = await inHand(164, 'KeyE', 'e', 69)
      const reached1 = await moveTo(4, 20)
      const fit1 = await p.eval(`${at(view)}?.getAttribute('data-fit')`)
      await p.tap('Enter', 'Enter', 13)
      const placed1 = await p.waitFor(`${at(view)}?.getAttribute('data-placed') === '1'`, 10_000).then(() => true, () => false)
      check(bookcase && reached1 && fit1 === 'ok' && placed1, 'furnish: E, the arrows and Enter place the bookcase against the back wall', JSON.stringify({ bookcase, reached1, fit1, cursor: await cursor(), reason: await p.eval(`${at('aside[data-home="0"] [data-reason]')}?.textContent ?? ''`) }))
      // Q takes the sofa; placed the same way.
      const sofa = await inHand(163, 'KeyQ', 'q', 81)
      const reached2 = await moveTo(8, 23)
      const fit2 = await p.eval(`${at(view)}?.getAttribute('data-fit')`)
      await p.tap('Enter', 'Enter', 13)
      const placed2 = await p.waitFor(`${at(view)}?.getAttribute('data-placed') === '2'`, 10_000).then(() => true, () => false)
      check(sofa && reached2 && fit2 === 'ok' && placed2, 'furnish: Q, the arrows and Enter place the sofa', JSON.stringify({ sofa, reached2, fit2, cursor: await cursor(), reason: await p.eval(`${at('aside[data-home="0"] [data-reason]')}?.textContent ?? ''`) }))
      const solid = await p.waitFor(`window.__SIM__.engine.sim.state.physics.colliders === ${base + 2}`, 20_000).then(() => true, () => false)
      check(solid, 'furnish: each piece placed is one more collider in the physics realm', `${base} -> ${await colliders()}`)
      await p.shot('furnish')

      // A real mouse click on View (the button keeps the focus), then Enter with its text, as a keyboard sends it: the
      // card's Place picks up the sofa under the cursor, and View is not pressed a second time. Z puts the sofa back.
      const viewButton = await p.eval(`(() => { const r = ${at('aside[data-home="0"] [data-action="view"]')}?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null })()`)
      if (viewButton) {
        await p.mouse('mousePressed', viewButton.x, viewButton.y, 1)
        await p.mouse('mouseReleased', viewButton.x, viewButton.y)
      }
      const turned = await p.waitFor(`${at(view)}?.getAttribute('data-view') === '1'`, 10_000).then(() => true, () => false)
      const focused = await p.eval(`document.activeElement?.getAttribute('data-action') ?? ''`)
      await p.b.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
      await p.b.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
      const picked = await p.waitFor(`${at(view)}?.getAttribute('data-placed') === '1'`, 10_000).then(() => true, () => false)
      await p.frames(4)
      const views = await p.eval(`${at(view)}?.getAttribute('data-view') ?? ''`)
      check(turned && focused === 'view' && picked && views === '1', 'furnish: after a mouse click on View, Enter is still the card\'s Place (it picks up the sofa) and never presses View again', JSON.stringify({ turned, focused, picked, views }))
      await p.tap('KeyZ', 'z', 90)
      const undone = await p.waitFor(`${at(view)}?.getAttribute('data-placed') === '2' && ${at(view)}?.getAttribute('data-piece') === '163'`, 10_000).then(() => true, () => false)
      check(undone, 'furnish: Z puts the sofa back', await p.eval(`${at(view)}?.getAttribute('data-placed') ?? 'no view'`))

      // Done closes the view and the engine's hold; the layout is in this browser's record.
      await p.eval(`${at('aside[data-home="0"] [data-action="done"]')}?.click()`)
      const done = await p.waitFor(`!${at('aside[data-home]')} && window.__SIM__.snapshot().customer.home?.card === false`, 10_000).then(() => true, () => false)
      check(done, 'furnish: Done closes the furnishing view')
      const saved = await p.eval(`(() => { try { return JSON.parse(localStorage.getItem('civic-simulation:home:v1')).homes[0] } catch { return null } })()`)
      const pieces = saved?.[2] ?? []
      const has = (id, c, r) => pieces.some((q) => q[0] === id && q[1] === c && q[2] === r && q[3] === 0)
      check(pieces.length === 2 && has(164, 4, 20) && has(163, 8, 23), 'furnish: the loft\'s layout is saved in this browser', JSON.stringify(saved))
      const errs = (await p.snap()).errors
      check(errs.length === 0, 'furnish: the engine recorded no error', errs.join(' | ').slice(0, 300))
      p.health('furnish')

      // Reloaded: the loft keeps both pieces, solid, and the view opens on them.
      await reload(p, `${origin}/?${LIGHT}&seed=1337`)
      const back = await walkIn()
      const again = await p.waitFor(`window.__SIM__.engine.sim.state.physics.colliders === ${base + 2}`, 30_000).then(() => true, () => false)
      check(back && again, 'furnish: after a reload the loft\'s two pieces are still solid', `${base + 2} expected, ${await colliders()}`)
      await p.tap('KeyB', 'b', 66)
      const kept = await p.waitFor(`${at(view)}?.getAttribute('data-placed') === '2'`, 10_000).then(() => true, () => false)
      check(kept, 'furnish: after a reload the furnishing view has both pieces placed', await p.eval(`${at(view)}?.getAttribute('data-placed') ?? 'no view'`))
      await p.tap('Escape', 'Escape', 27)
      await p.waitFor(`!${at('aside[data-home]')}`, 10_000).catch(() => {})
      p.health('furnish reloaded')
    } finally { await p.b.close() }
  },

  /**
   * A rest at home (HomeCard.tsx's Rest tab, progress.ts restOffer and restTake) in the Brownstone, by keyboard and by
   * a real mouse. The loft is claimed first (free: it puts the record in this browser), then the record gets level 3
   * and 7,500 credits by hand, sealed again as progression.ts sealOf does, and the page reloaded; the Brownstone's
   * deed, a bookcase and an agent workstation are bought through the shopkeeper, and the Brownstone's layout written with that bookcase
   * standing where its show home had one (the layout is read once at mount, so reloaded again). In the Brownstone B
   * opens the furnishing view and 4 its Rest tab: +1 for one kind of furniture, and a Rest button for a finger that
   * the panel describes. Enter rests: a hero point, a new round, word 40 of the record at 30 checks of +1. A real click
   * on Rest while it lasts is refused and changes nothing. The HUD's chip ends with "prepared +1" (and says so to a
   * screen reader), the console's next check carries the +1 and `progress` counts 29 more checks, and after a reload
   * the record, the chip and `progress` still do. Then staff at home (HomeCard.tsx's Staff tab, staffStore.ts): the
   * workstation is written into the layout and an agent onto the roster by hand before that reload (the rest's checks
   * after it do not depend on comfort); walked in again, 5 opens the Staff tab, the workstation's row in its list puts
   * the cursor on the workstation and Enter posts the agent there, saved in this browser, listed by engine.homeSeats
   * and drawn, with the row and the agent's button saying so, and after one more reload the agent still stands there. Copied from furnish rather than shared, so its checks stay put.
   */
  async rest(chrome, origin) {
    const p = await open(chrome)
    const at = (sel) => `document.querySelector(${JSON.stringify(sel)})`
    const card = 'aside[data-home="1"][data-furnish]'
    const words = () => p.eval(`(() => { try { return JSON.parse(localStorage.getItem('civic-simulation:progress:v1')).words } catch { return [] } })()`)
    const chipText = () => p.eval(`${at('[data-hint="progress"] .truncate')}?.textContent ?? ''`)
    const chipLabel = () => p.eval(`${at('[data-hint="progress"] .sr-only')}?.textContent ?? ''`)
    // Go home, then W walks in (the canvas clicked first, as a person would).
    const walkIn = async () => {
      await p.eval('window.__SIM__.engine.goHome(1)')
      const a = (await p.eval('window.__SIM__.homes()'))[1].arrival
      await p.waitFor(`(() => { const v = window.__SIM__.engine.sim.state.avatar; return Math.hypot(v.x - ${a.x}, v.z - ${a.z}) < 0.6 })()`, 30_000).catch(() => {})
      await p.mouse('mousePressed', 480, 270, 1)
      await p.mouse('mouseReleased', 480, 270)
      await p.key('keyDown', 'KeyW', 'w', 87)
      const inside = await p.waitFor(`window.__SIM__.snapshot().customer.home?.index === 1`, 30_000).then(() => true, () => false)
      await p.frames(6)
      await p.key('keyUp', 'KeyW', 'w', 87)
      await p.frames(10)
      return inside
    }
    try {
      await p.goto(`${origin}/?${LIGHT}&seed=1337`)
      await p.booted()
      // The loft claimed (free), so the record is in this browser; then level 3 and 7,500 credits, sealed again, reloaded.
      const claimed = await p.eval(`(() => { const k = window.__SIM__.shopkeeper; k.buy(224); return k.owns(224) })()`)
      check(claimed, 'rest: the loft is claimed, so the record is kept in this browser')
      await p.eval(`(() => {
        const key = 'civic-simulation:progress:v1'
        const data = JSON.parse(localStorage.getItem(key))
        const w = data.words
        w[14] = 3
        w[16] = 7500
        let h = 0x811c9dc5
        for (let i = 0; i < w.length; i++) {
          if (i === 63) continue
          const v = w[i] >>> 0
          h = Math.imul(h ^ (v & 0xff), 0x01000193)
          h = Math.imul(h ^ ((v >>> 8) & 0xff), 0x01000193)
          h = Math.imul(h ^ ((v >>> 16) & 0xff), 0x01000193)
          h = Math.imul(h ^ (v >>> 24), 0x01000193)
        }
        w[63] = h | 0
        localStorage.setItem(key, JSON.stringify(data))
      })()`)
      await reload(p, `${origin}/?${LIGHT}&seed=1337`)
      // The Brownstone (4,000), a bookcase (1,100) and an agent workstation (1,500), then its layout with only the bookcase
      // standing, so the Rest tab counts one kind of furniture; reloaded once more.
      const bought = await p.eval(`(() => { const k = window.__SIM__.shopkeeper; k.buy(225); k.buy(164); k.buy(168); return { home: k.owns(225), bookcase: k.owns(164), workstation: k.owns(168), level: k.purse.level(), credits: k.purse.credits() } })()`)
      check(bought.home && bought.bookcase && bought.workstation && bought.level === 3 && bought.credits === 900, 'rest: level 3, the Brownstone, a bookcase and a workstation bought, 900 credits left', JSON.stringify(bought))
      await p.eval(`localStorage.setItem('civic-simulation:home:v1', JSON.stringify({ v: 1, homes: [null, [1, 1, [[164, 2, 16, 0]]], null, null, null, null, null] }))`)
      await reload(p, `${origin}/?${LIGHT}&seed=1337`)
      const inside = await walkIn()
      check(inside, 'rest: the avatar walks into the Brownstone')

      // B opens the furnishing view; 4 its Rest tab: +1 for the one kind of furniture standing here.
      await p.tap('KeyB', 'b', 66)
      const opened = await p.waitFor(`!!${at(card)}`, 10_000).then(() => true, () => false)
      // The view's key listener is attached after it first draws, which on a slow software adapter can be a few frames
      // later; 4 again is harmless (it only chooses the Rest tab), so press until the tab reads as open.
      let tab = false
      let presses = 0
      for (; presses < 5 && !tab; presses++) {
        await p.tap('Digit4', '4', 52)
        tab = await p.waitFor(`!!${at(`${card} [data-rest]`)}`, 4_000).then(() => true, () => false)
      }
      // What the key went to is in the detail too (the focused element and the tab the view reads), should it fail.
      const offer = await p.eval(`(() => { const b = ${at(`${card} [data-action="rest"]`)}; const panel = ${at(`${card} [data-rest]`)}; const r = b?.getBoundingClientRect()
        const by = b ? document.getElementById(b.getAttribute('aria-describedby') ?? '') : null
        const f = document.activeElement, focus = f ? [f.tagName, f.getAttribute('aria-label') ?? f.getAttribute('name') ?? f.id ?? ''].join(' ') : ''
        const tabs = [...document.querySelectorAll('${card} [role="tab"]')].map((t) => t.getAttribute('aria-selected') === 'true' ? '*' + t.textContent : t.textContent).join(',')
        return { text: panel?.textContent ?? '', button: b?.textContent ?? '', height: r ? r.height : 0, described: !!by && by === panel, place: !!${at(`${card} [data-action="place"]`)},
          opened: ${opened}, presses: ${presses}, focus, tabs } })()`)
      check(opened && tab && /a hero point, a new round, and \+1 to every check for the next 30 checks/.test(offer.text) && /1 kind of furniture stands here/.test(offer.text), 'rest: B opens the furnishing view and 4 its Rest tab, offering +1 for the one kind of furniture standing here', JSON.stringify(offer))
      check(offer.button === 'Rest' && offer.height >= 48 && offer.described && !offer.place, 'rest: the Rest tab\'s button reads Rest, stands at least 48 px tall in Place\'s spot, and the panel describes it', JSON.stringify(offer))

      // Enter rests: a hero point, a new round, and +1 on the next 30 checks, in the record.
      const before = await words()
      await p.tap('Enter', 'Enter', 13)
      const rested = await p.waitFor(`/^Rested: /.test(${at(`${card} [data-reason]`)}?.textContent ?? '')`, 10_000).then(() => true, () => false)
      const said = await p.eval(`${at(`${card} [data-reason]`)}?.textContent ?? ''`)
      const after = await words()
      check(rested && new RegExp(`^Rested: hero ${before[17] + 1} of 3, a new round, and \\+1 to every check for the next 30 checks`).test(said) && before[17] === 1, 'rest: Enter rests, and the reason line says what it gave', said)
      check(after[40] === 121 && after[17] === 2 && (before[40] ?? 0) === 0, 'rest: the record keeps the rest (word 40: 30 checks of +1) and the hero point', `word 40 ${before[40]} -> ${after[40]}, hero ${before[17]} -> ${after[17]}`)
      await p.shot('rest')

      // A real click on Rest while the rest lasts: refused in words, nothing changed.
      const rect = await p.eval(`(() => { const r = ${at(`${card} [data-action="rest"]`)}?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null })()`)
      if (rect) {
        await p.mouse('mousePressed', rect.x, rect.y, 1)
        await p.mouse('mouseReleased', rect.x, rect.y)
      }
      const refused = await p.waitFor(`/^You are prepared: \\+1 to every check for 30 more checks/.test(${at(`${card} [data-reason]`)}?.textContent ?? '')`, 10_000).then(() => true, () => false)
      const still = await words()
      check(!!rect && refused && still[40] === 121 && still[17] === 2, 'rest: a click on Rest while it lasts is refused, and changes nothing', `${await p.eval(`${at(`${card} [data-reason]`)}?.textContent ?? ''`)}; word 40 ${still[40]}, hero ${still[17]}`)

      // Esc: the HUD's chip ends with "prepared +1", and says so to a screen reader.
      await p.tap('Escape', 'Escape', 27)
      await p.waitFor(`!${at('aside[data-home]')}`, 10_000).catch(() => {})
      const chip = await p.waitFor(`(() => { const t = ${at('[data-hint="progress"] .truncate')}?.textContent ?? ''; return / · prepared \\+1$/.test(t) && t })()`, 10_000).catch(() => '')
      const label = await chipLabel()
      check(/ · prepared \+1$/.test(chip || '') && /prepared: 1 added to every check/.test(label), 'rest: the HUD\'s chip ends with prepared +1, and its label says so', `${chip || await chipText()} | ${label}`)

      // The console: the next check carries the +1, and progress counts what is left.
      check(await p.openConsole(), 'rest: the tilde key opens the console')
      const line = await p.command('time 12', /Optics and cinema: \d+ \+\d+ \+1 prepared = \d+ vs DC \d+/)
      check(!!line, 'rest: the next check line shows the +1 prepared', line?.split('\n').find((l) => /Optics/.test(l)) ?? 'no check line')
      const status = await p.command('progress', /prepared: \+1 to every check for 29 more checks/)
      check(!!status, 'rest: progress says +1 for 29 more checks', status?.split('\n').find((l) => /^\s*prepared:/.test(l)) ?? 'no line')
      const used = await words()
      check(used[40] === 117, 'rest: one of the 30 checks used (word 40: 29 checks of +1)', `word 40 ${used[40]}`)
      await p.tap('Escape', 'Escape', 27)
      await p.waitFor(`!document.querySelector('[aria-label$="Ring-0 terminal"][data-open]')`, 10_000).catch(() => {})
      const errs = (await p.snap()).errors
      check(errs.length === 0, 'rest: the engine recorded no error', errs.join(' | ').slice(0, 300))
      p.saveTranscript('rest')
      p.health('rest')

      // For the staff steps after it: the workstation stands in the layout and Mara is on the roster (both read once at
      // mount, so written before this reload). 'even' is the voice validateIdentity falls back to (roster.ts).
      await p.eval(`localStorage.setItem('civic-simulation:home:v1', JSON.stringify({ v: 1, homes: [null, [1, 1, [[164, 2, 16, 0], [168, 10, 20, 0]]], null, null, null, null, null] }))`)
      await p.eval(`localStorage.setItem('civic-simulation:roster:v1', JSON.stringify({ v: 1, agents: [{ name: 'Mara', pronouns: 'she/her', role: '', voice: 'even', look: null, agent: null }] }))`)
      // Reloaded: the record, the chip and progress still have it.
      await reload(p, `${origin}/?${LIGHT}&seed=1337`)
      const kept = await words()
      const chip2 = await p.waitFor(`(() => { const t = ${at('[data-hint="progress"] .truncate')}?.textContent ?? ''; return / · prepared \\+1$/.test(t) && t })()`, 20_000).catch(() => '')
      check(kept[40] === 117 && / · prepared \+1$/.test(chip2 || ''), 'rest: after a reload the record keeps the rest and the chip still ends with prepared +1', `word 40 ${kept[40]}; ${chip2 || await chipText()}`)
      check(await p.openConsole(), 'rest: after a reload the console opens')
      const status2 = await p.command('progress', /prepared: \+1 to every check for 29 more checks/)
      check(!!status2, 'rest: after a reload progress still says +1 for 29 more checks', status2?.split('\n').find((l) => /^\s*prepared:/.test(l)) ?? 'no line')
      await p.tap('Escape', 'Escape', 27)
      p.saveTranscript('rest')
      const errs2 = (await p.snap()).errors
      check(errs2.length === 0, 'rest: after a reload the engine recorded no error', errs2.join(' | ').slice(0, 300))
      p.health('rest reloaded')

      // Staff: 5 opens the Staff tab (pressed until it reads as open, as 4 is above); the workstation's row in the list
      // puts the cursor on its cell (10, 20), as a tap or a screen reader would, and Enter posts Mara there.
      check(await walkIn(), 'rest: staff: the avatar walks into the Brownstone again')
      await p.tap('KeyB', 'b', 66)
      await p.waitFor(`!!${at(card)}`, 10_000).catch(() => {})
      let staff = false
      for (let i = 0; i < 5 && !staff; i++) {
        await p.tap('Digit5', '5', 53)
        staff = await p.waitFor(`!!${at(`${card} [data-staff]`)}`, 4_000).then(() => true, () => false)
      }
      const row = `${card} [data-action="station"][data-seat="10,20"]`
      await p.waitFor(`!!${at(row)}`, 4_000).catch(() => {})
      await p.eval(`${at(row)}?.click()`)
      await p.waitFor(`${at(`${card} [data-cursor]`)}?.dataset.cursor === '10,20'`, 4_000).catch(() => {})
      const cur = await p.eval(`${at(`${card} [data-cursor]`)}?.dataset.cursor ?? ''`)
      await p.tap('Enter', 'Enter', 13)
      const posted = await p.waitFor(`/^Mara is at workstation 1 now/.test(${at(`${card} [data-reason]`)}?.textContent ?? '')`, 10_000).then(() => true, () => false)
      const staffed = await p.eval(`(() => {
        const seats = window.__SIM__.engine.homeSeats, s = seats.find((x) => x.kind === 'homeSeat:1:10:20')
        const b = ${at(`${card} [data-action="place"]`)}, h = b?.getBoundingClientRect().height ?? 0
        const rows = [...document.querySelectorAll('${card} [data-action="agent"], ${card} [data-action="station"]')].map((x) => x.getBoundingClientRect().height)
        return { cursor: ${JSON.stringify(cur)}, stored: localStorage.getItem('civic-simulation:staff:v1'), occupant: s?.occupant ?? null, present: !!s?.present, visible: window.__SIM__.engine.staffView.group.visible,
          row: ${at(row)}?.textContent ?? '', agent: ${at(`${card} [data-action="agent"]`)}?.getAttribute('aria-label') ?? '',
          button: b?.textContent ?? '', tall: h >= 48 && rows.length >= 2 && rows.every((x) => x >= 48), reason: ${at(`${card} [data-reason]`)}?.textContent ?? '' } })()`)
      check(staff && cur === '10,20' && posted && staffed.stored === '{"v":1,"posts":[["Mara",1,10,20]]}' && staffed.occupant === 'Mara' && staffed.present && staffed.visible,
        'rest: staff: 5 opens the Staff tab, the workstation\'s row puts the cursor on it and Enter posts Mara at workstation 1, saved, listed by homeSeats and drawn', JSON.stringify({ staff, ...staffed }))
      check(staffed.row === 'Workstation 1 · Mara' && staffed.agent === 'Mara: Workstation 1', 'rest: staff: the row says who stands there, and Mara\'s button says where she is', JSON.stringify(staffed))
      check(staffed.button === 'Post' && staffed.tall, 'rest: staff: the primary button reads Post, and every staff button is at least 48 px tall', JSON.stringify(staffed))
      await p.shot('rest-staff')
      await p.tap('Escape', 'Escape', 27)
      await reload(p, `${origin}/?${LIGHT}&seed=1337`)
      const back = await p.waitFor(`window.__SIM__.engine.homeSeats.some((s) => s.kind === 'homeSeat:1:10:20' && s.occupant === 'Mara' && s.present) && window.__SIM__.engine.staffView.group.visible`, 20_000).then(() => true, () => false)
      check(back, 'rest: staff: after a reload Mara still stands at workstation 1', back ? '' : JSON.stringify(await p.eval(`window.__SIM__.engine.homeSeats.map((s) => [s.kind, s.occupant, s.present])`)))
      const errs3 = (await p.snap()).errors
      check(errs3.length === 0, 'rest: staff: the engine recorded no error', errs3.join(' | ').slice(0, 300))
      p.health('rest staff')
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
      ['the GPU process gone while the crowd is built', () => gpuProcessLost(chrome, origin)],
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

/**
 * The harness's ears on the physics worker and the page's GPU: every step of the crowd's kernel ladder as the page
 * hears it (a second listener beside the page's own; nothing is held back or changed), and how often the page asked
 * the browser for an adapter.
 */
const LADDER_EARS = `(() => {
  window.__smokeLadder = []
  window.__smokeAdapterAsks = 0
  const W = window.Worker
  window.Worker = class extends W {
    constructor(...a) {
      super(...a)
      this.addEventListener('message', (e) => { const d = e.data; if (d && d.t === 'crowdKernel') window.__smokeLadder.push(d.rung + ' ' + d.step) })
    }
  }
  const ask = GPU.prototype.requestAdapter
  GPU.prototype.requestAdapter = function (...a) { window.__smokeAdapterAsks++; return ask.apply(this, a) }
})()`

/** What the page keeps of this GPU and the crowd's kernels (crowdKernelMemory.ts), as a page expression. */
const KERNEL_RECORD = `(() => { try { return JSON.parse(localStorage.getItem('civic-simulation:crowd-kernel:v1')) } catch { return null } })()`

/**
 * The browser's GPU process gone while the physics worker builds the crowd's kernel, as a phone's graphics driver
 * takes it down (Browser.crashGpuProcess, the moment the worker says it is asking for the kernel): every device of the
 * page is lost at once, the worker's with it. The page starts again by itself, once, asking for the light kernel, and
 * the city stands on it; the kernel is remembered, and the address is left as it was. A second loss, under the light
 * kernel, leaves the card that says no kernel is left to ask this GPU for, and the start after that asks the browser
 * for no adapter at all. Two losses only: Chrome withholds the GPU from the page after them for a while and gives
 * GPU graphics up after a third.
 */
async function gpuProcessLost(chrome, origin) {
  const p = await open(chrome)
  const url = `${origin}/?${LIGHT}`
  const what = 'fail gpu process'
  /** Kills the GPU process once the new document's worker says it is asking for `rung`. */
  const crashAt = async (rung) => {
    await p.b.waitFor(`!window.__smokeOld && (window.__smokeLadder ?? []).includes('${rung} trying')`, BOOT_MS, 20)
    await p.b.send('Browser.crashGpuProcess', {}, '')
  }
  /** Loads the page again (the old document is marked, so it cannot answer for the new one). */
  const again = async () => {
    await p.eval('window.__smokeOld = true')
    await p.b.send('Page.reload', {})
  }
  try {
    await p.b.send('Page.addScriptToEvaluateOnNewDocument', { source: LADDER_EARS })
    const loads = []
    p.b.on('Page.frameNavigated', (e) => { if (!e.frame.parentId) loads.push(e.frame.url) })
    await p.goto(url)
    await crashAt('full')
    // The city, or a card: whichever comes says how the start ended.
    const up = await p.waitFor(`(() => { const c = ${CARD}; return c ? { card: c.kind + ': ' + c.headline } : !!window.__SIM__ && window.__SIM__.snapshot().output.fps > 0 && !document.querySelector('.boot-veil') ? { live: true } : null })()`, BOOT_MS).catch(() => null)
    check(up?.live === true, `${what}: lost under the full kernel, the city stands after all`, up?.live ? '' : up?.card ?? 'neither the city nor a card')
    check(loads.length === 2 && /[?&]kernel=lite(&|$)/.test(loads[1] ?? ''), `${what}: the page started again by itself, once, asking for the light kernel`, loads.map((l) => l.replace(origin, '')).join(' then '))
    if (up?.live) {
      const s = await p.snap()
      const ran = await p.waitFor(`window.__SIM__.snapshot().process.crowdFrames > ${s.crowdFrames + 2}`, 60_000).then(() => true, () => false)
      const kernel = await p.eval('window.__SIM__.engine.sim.meta.crowdKernel')
      check(ran && kernel === 'lite', `${what}: the crowd runs on the light kernel`, `kernel ${kernel}, readings ${ran ? 'arriving' : 'none'}`)
      const record = await p.eval(KERNEL_RECORD)
      check(record?.from === 'lite' && record.why === 'lost' && record.rung === 'full' && record.strikes === 1, `${what}: the page remembers that the full kernel took this GPU down`, JSON.stringify(record).slice(0, 300))
      const search = await p.eval('location.search')
      check(!/[?&]kernel=/.test(search), `${what}: the address is left without the kernel word once the record says the same`, search)
      await p.shot('fail-gpu-process')
    }
    // The next start begins at the light kernel (the record), and the GPU process goes again under it.
    await again()
    await crashAt('lite')
    await expectCard(p, `${what}, lite`, 'kernel-none', 'The crowd keeps stopping this device’s graphics')
    const none = await p.eval(KERNEL_RECORD)
    check(none?.from === 'none' && none.rung === 'lite', `${what}: after the light kernel's own loss the record says none is left`, JSON.stringify(none).slice(0, 300))
    check(loads.length === 3, `${what}: no restart by itself after the lightest kernel's loss`, `${loads.length} loads`)
    await p.shot('fail-gpu-process-none')
    // A start inside the hold asks nothing of the GPU: the card at once, and no adapter asked for.
    await again()
    await p.waitFor('document.readyState !== "loading" && !window.__smokeOld', 60_000)
    await expectCard(p, `${what}, held`, 'kernel-none', 'The crowd keeps stopping this device’s graphics')
    const asks = await p.eval('window.__smokeAdapterAsks')
    check(asks === 0, `${what}: a start inside the hold asks the browser for no adapter`, `${asks} asked`)
    check(p.errors.length === 0, `${what}: no exception in the page`, p.errors.slice(0, 3).join(' | ').slice(0, 400))
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
    const names = Object.keys(SCENARIOS).filter((name) => !ONLY || ONLY.includes(name))
    const chosen = SHARD ? shardOf(names, SHARD.i, SHARD.n) : names
    if (SHARD) console.log(`shard    ${SHARD.i}/${SHARD.n}: ${chosen.join(', ') || 'none'}`)
    for (const name of chosen) {
      const run = SCENARIOS[name]
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
