// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins bootFailure.ts, the words a failure gets on the player's own device, over real user
 * agents: iOS 18 and iOS 26 Safari (which still reports the OS as 18_6 and carries Version/26), the iOS home-screen app,
 * Chrome on iOS, an iOS app's built-in browser, Android Chrome and an Android WebView, Firefox and Chrome on Linux,
 * Edge on Windows, an iPad asking for the desktop site, Safari on a Mac, and the Windows app. Every code each failure
 * carries, and every message the page has always shown, maps to its class; the installed apps are never told to edit
 * an address or switch browsers; the 'needs WebGPU' line appears only where WebGPU is what is missing; the halt reasons
 * the realm and the engine really produce keep the Ring-0 copy only for audits; and the one automatic restart after a
 * graphics reset in the background is guarded as the plan says.
 * What breaks if it is removed? A wording change could send an iPhone XR to an update it cannot take, tell the
 * installed app to open a browser it does not have, or file a GPU reset under a broken invariant, unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WebGPUUnavailableError, type GpuFailure } from '../01_Initialize_World/gpuDevice.ts'
import { panicReason } from '../02_Define_The_Rules/ring0.ts'
import { coded } from './simProtocol.ts'
import {
  AUTO_RELOAD_GAP_MS, autoReload, classify, detailsLine, explainHalt, firstScreen, FRAME_FAULT, GRAPHICS_RESET, haltClass, installedApp, kindOf, openInChrome, platformOf,
  WEBGPU_LINE, type Env, type Failure,
} from './bootFailure.ts'

const UA = {
  ios18: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  ios26: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  homeScreen: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  crios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.96 Mobile/15E148 Safari/604.1',
  instagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22G86 Instagram 400.0.0.29.92 (iPhone14,5; iOS 18_6; en_US; en; scale=3.00; 1170x2532; 789456123)',
  androidChrome: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  androidWebView: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.70 Mobile Safari/537.36',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
  chromeLinux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  edgeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  firefoxWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  macSafari18: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
} as const

const env = (ua: string, o: Partial<Env> = {}): Env => ({ ua, secure: true, standalone: false, native: false, origin: 'https://city.example', touchPoints: 0, ...o })
const IPHONE: Partial<Env> = { touchPoints: 5 }
const HOME_SCREEN: Partial<Env> = { touchPoints: 5, standalone: true }
const TAURI: Partial<Env> = { native: true }
const err = (code: GpuFailure, message = 'x') => new WebGPUUnavailableError(code, message)
const text = (f: Failure) => [f.headline, ...f.steps].join('\n')

test('platformOf: Safari\'s Version token, not the OS token; in-app browsers by their missing Safari/ or their wv', () => {
  assert.deepEqual(platformOf(UA.ios18, 5), { os: 'ios', browser: 'safari', ipad: false, iosOther: false, inApp: false, safari: 18 })
  assert.deepEqual(platformOf(UA.ios26, 5), { os: 'ios', browser: 'safari', ipad: false, iosOther: false, inApp: false, safari: 26 }, 'iOS 26 reports 18_6')
  assert.equal(platformOf(UA.homeScreen, 5, true).inApp, false, 'the home-screen app has no Safari/ token and is not an in-app browser')
  assert.equal(platformOf(UA.homeScreen, 5, false).inApp, true, 'the same token gap in a tab is an app\'s built-in browser')
  assert.deepEqual(platformOf(UA.crios, 5), { os: 'ios', browser: 'chrome', ipad: false, iosOther: true, inApp: false, safari: null })
  assert.equal(platformOf(UA.instagram, 5).inApp, true)
  assert.deepEqual(platformOf(UA.androidChrome), { os: 'android', browser: 'chrome', ipad: false, iosOther: false, inApp: false, safari: null })
  assert.equal(platformOf(UA.androidWebView).inApp, true)
  assert.equal(platformOf(UA.androidWebView).safari, null, 'Version/4.0 of a WebView is not Safari')
  assert.deepEqual([platformOf(UA.firefoxLinux).os, platformOf(UA.firefoxLinux).browser], ['linux', 'firefox'])
  assert.deepEqual([platformOf(UA.chromeLinux).os, platformOf(UA.chromeLinux).browser], ['linux', 'chrome'])
  assert.deepEqual([platformOf(UA.edgeWindows).os, platformOf(UA.edgeWindows).browser], ['windows', 'edge'])
  assert.deepEqual(platformOf(UA.ipadDesktop, 5), { os: 'ios', browser: 'safari', ipad: true, iosOther: false, inApp: false, safari: 26 }, 'an iPad asking for the desktop site')
  assert.deepEqual([platformOf(UA.macSafari18).os, platformOf(UA.macSafari18).safari], ['mac', 18])
})

test('no WebGPU: each device gets its own way out', () => {
  const ios18 = classify(err('no-api'), env(UA.ios18, IPHONE))
  assert.match(ios18.headline, /This iPhone needs iOS 26/)
  assert.match(text(ios18), /iPhone 11, iPhone SE \(2nd generation\) and newer/, 'iOS 26 needs an iPhone 11 or SE 2: never "update" an XR')
  assert.match(text(ios18), /Safari 18 doesn’t turn WebGPU on/)
  const ios26 = classify(err('no-api'), env(UA.ios26, IPHONE))
  assert.equal(ios26.headline, 'WebGPU is turned off in Safari', 'Safari 26 is told about Lockdown Mode, not to update')
  assert.match(text(ios26), /Lockdown Mode/)
  const home = classify(err('no-api'), env(UA.homeScreen, HOME_SCREEN))
  assert.match(home.headline, /This iPhone needs iOS 26/)
  assert.match(text(home), /open the app again/)
  assert.match(text(classify(err('no-api'), env(UA.crios, IPHONE))), /Open the page in Safari/)
  assert.equal(classify(err('no-api'), env(UA.instagram, IPHONE)).headline, 'Open this page in Safari')
  assert.equal(classify(err('no-api'), env(UA.androidWebView)).headline, 'Open this page in Chrome')
  assert.match(text(classify(err('no-api'), env(UA.androidWebView))), /Open in Chrome/)
  assert.match(text(classify(err('no-api'), env(UA.androidChrome))), /Update Chrome.*Android 12/s)
  assert.match(text(classify(err('no-api'), env(UA.firefoxLinux))), /about:config, set dom\.webgpu\.enabled to true/)
  assert.match(text(classify(err('no-api'), env(UA.firefoxWindows))), /Update Firefox/)
  assert.match(text(classify(err('no-api'), env(UA.macSafari18))), /This Mac needs Safari 26/)
  assert.match(classify(err('no-api'), env(UA.ipadDesktop, { touchPoints: 5 })).headline, /WebGPU is turned off in Safari/)
  const tauri = classify(err('no-api'), env(UA.edgeWindows, TAURI))
  assert.match(text(tauri), /WebView2/)
  assert.doesNotMatch(text(tauri), /Chrome|Open the page in|Open this page in/, 'the Windows app has no other browser to go to')
  for (const f of [ios18, ios26, home, tauri]) assert.equal(f.webgpuLine, WEBGPU_LINE)
})

test('no adapter: Linux names the flags, Vulkan and chrome://gpu (and NixOS\'s driver); the rest their own fix', () => {
  const linux = text(classify(err('no-adapter'), env(UA.chromeLinux)))
  assert.match(linux, /chrome:\/\/gpu/)
  assert.match(linux, /chrome:\/\/flags\/#enable-unsafe-webgpu and chrome:\/\/flags\/#enable-vulkan/)
  assert.match(linux, /hardware\.graphics\.enable = true/)
  assert.match(text(classify(err('no-adapter'), env(UA.edgeWindows))), /hardware acceleration/)
  assert.match(text(classify(err('no-adapter'), env(UA.edgeWindows, TAURI))), /graphics driver and WebView2/)
  assert.match(text(classify(err('no-adapter'), env(UA.androidChrome))), /not for this phone’s GPU/)
  assert.match(text(classify(err('no-adapter'), env(UA.firefoxLinux))), /Firefox has WebGPU but offered no GPU/)
  assert.match(text(classify(err('no-adapter'), env(UA.ios26, IPHONE))), /App Switcher/)
  assert.equal(classify(err('no-adapter'), env(UA.chromeLinux)).webgpuLine, WEBGPU_LINE)
})

test('an insecure page: the address is the problem, not the browser (no WebGPU line)', () => {
  const lan = env(UA.ios26, { ...IPHONE, secure: false, origin: 'http://lan.test:8080' })
  const f = classify(err('insecure'), lan)
  assert.equal(f.kind, 'insecure')
  assert.match(text(f), /http:\/\/lan\.test:8080/)
  assert.match(text(f), /https:\/\/ pages and for localhost/)
  assert.equal(f.webgpuLine, null)
  // The old message on an insecure page reads as the address too.
  assert.equal(classify(new Error('This browser does not expose WebGPU (navigator.gpu).'), lan).kind, 'insecure')
  assert.match(text(classify(err('insecure'), env(UA.homeScreen, { ...HOME_SCREEN, secure: false }))), /add it to the Home Screen again/)
})

test('the WebGPU line only where WebGPU is what is missing', () => {
  const e = env(UA.edgeWindows)
  const withLine = ['no-api', 'no-adapter', 'compat-only'] as const
  for (const code of withLine) assert.equal(classify(err(code), e).webgpuLine, WEBGPU_LINE, code)
  assert.equal(classify(coded('worker-gpu', 'no WebGPU adapter inside the physics worker'), e).webgpuLine, WEBGPU_LINE)
  for (const code of ['insecure', 'device', 'gpu-reset'] as const) assert.equal(classify(err(code), e).webgpuLine, null, code)
  for (const m of ['init: pedestrian sensing failed to start: no reading from the GPU', 'three has not allocated a GPU buffer for "pos" yet', '']) assert.equal(classify(new Error(m), e).webgpuLine, null, m)
  assert.equal(classify(coded('wasm', 'WebAssembly is turned off'), e).webgpuLine, null)
})

test('codes win; today\'s exact messages still map to their class', () => {
  const e = env(UA.chromeLinux)
  const table: [string, string][] = [
    ['This browser does not expose WebGPU (navigator.gpu).', 'no-api'],
    ['WebGPU adapter unavailable; three.js fell back to WebGL2, which cannot run the WGSL crowd.', 'no-adapter'],
    ['THREE.WebGPUBackend: Unable to create WebGPU adapter.', 'no-adapter'],
    ["Cannot read properties of null (reading 'getSupportedExtensions')", 'no-adapter'],
    ['init: WebGPU is not available inside the physics worker (the pedestrian sensing needs it there)', 'worker-gpu'],
    ['init: no WebGPU adapter inside the physics worker', 'worker-gpu'],
    ['Physics realm fault: no WebGPU adapter inside the physics worker', 'worker-gpu'],
    ['physics worker failed to start: Uncaught ReferenceError: WebAssembly is not defined', 'wasm'],
    ["physics worker failed to start: Can't find variable: WebAssembly", 'wasm'],
    ['physics worker failed to start: unknown error', 'other'],
    ['init: pedestrian sensing failed to start: no reading from the GPU', 'stalled'],
    ['init: pedestrian sensing failed to start: GPU device lost (unknown): GPU process crashed', 'gpu-reset'],
    ['init: crowd.wgsl pipeline validation failed: binding 14', 'shader'],
    ['crowd.wgsl cull pipeline validation failed: x', 'shader'],
    ['SYSTEM LOCKED: Physics realm fault: worker error', 'realm-fault'],
    ['the embedded region names something after a weapon: x', 'other'],
    ['the physics worker simulates 512 pedestrians, the page draws 600', 'other'],
  ]
  for (const [m, kind] of table) assert.equal(kindOf(new Error(m), e), kind, m)
  // A code beats the words, and a DOMException's numeric code is not one.
  assert.equal(kindOf(err('device', 'no WebGPU adapter inside the physics worker'), e), 'device')
  assert.equal(kindOf(coded('worker-gpu', 'anything'), e), 'worker-gpu')
  assert.equal(kindOf(Object.assign(new Error('Operation failed'), { code: 0 }), e), 'other')
  assert.equal(kindOf('a thrown string: GPU device lost', e), 'gpu-reset')
})

test('an empty or missing message still gives a card with words', () => {
  for (const thrown of [new Error(''), '', undefined, null, {}]) {
    const f = classify(thrown, env(UA.edgeWindows))
    assert.ok(f.headline.length > 0 && f.steps.length > 0)
    assert.ok(f.detail.length > 0, String(thrown))
  }
  assert.equal(classify(new Error(''), env(UA.edgeWindows)).detail, 'No message was given.')
})

test('the installed iPhone app and the Windows app are never told to edit an address or switch browsers', () => {
  const NO = /address bar|copy the link|Open (?:this|the) page in|open the page again|in Chrome|in Safari/
  for (const code of ['no-api', 'no-adapter', 'compat-only', 'device', 'gpu-reset', 'stalled', 'shader'] as const) {
    const e = Object.assign(new Error('x'), { code })
    assert.doesNotMatch(text(classify(e, env(UA.homeScreen, HOME_SCREEN))), NO, `home screen ${code}`)
    assert.doesNotMatch(text(classify(e, env(UA.edgeWindows, TAURI))), NO, `Tauri ${code}`)
  }
  for (const code of ['worker-gpu', 'wasm'] as const) {
    assert.doesNotMatch(text(classify(coded(code, 'x'), env(UA.homeScreen, HOME_SCREEN))), NO, `home screen ${code}`)
    assert.doesNotMatch(text(classify(coded(code, 'x'), env(UA.edgeWindows, TAURI))), NO, `Tauri ${code}`)
  }
})

test('installedApp: standalone anywhere, iOS\'s own flag, fullscreen only on Android (a desktop F11 tab is a tab)', () => {
  const m = (o: Partial<Parameters<typeof installedApp>[0]>) => installedApp({ standalone: false, fullscreen: false, iosStandalone: false, ua: UA.chromeLinux, ...o })
  assert.equal(m({ fullscreen: true, ua: UA.androidChrome }), true, 'the Android app (the manifest asks for fullscreen)')
  assert.equal(m({ standalone: true, ua: UA.homeScreen }), true, 'iOS falls back to standalone')
  assert.equal(m({ iosStandalone: true, ua: UA.homeScreen }), true, 'iOS\'s navigator.standalone')
  assert.equal(m({ standalone: true, ua: UA.edgeWindows }), true, 'a desktop install falls back to standalone')
  assert.equal(m({ fullscreen: true, ua: UA.chromeLinux }), false, 'Chrome on Linux in F11')
  assert.equal(m({ fullscreen: true, ua: UA.edgeWindows }), false, 'Edge in F11')
  assert.equal(m({}), false, 'a plain tab')
})

test('Android without WebGPU: one tap hands this address to Chrome; never in Chrome, the installed app or elsewhere', () => {
  const FF = 'Mozilla/5.0 (Android 14; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0'
  const SAMSUNG = 'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36'
  const href = 'https://cassius-software.github.io/Crimson-Noir-AI-Agent-City/?map=city#x'
  const card = (ua: string, o: Partial<Env> = {}) => classify(err('no-api'), env(ua, { touchPoints: 5, href, ...o }))
  const ff = card(FF)
  assert.equal(ff.headline, 'Open this page in Chrome')
  assert.equal(ff.openIn?.label, 'Open in Chrome')
  assert.equal(ff.openIn?.href, 'intent://cassius-software.github.io/Crimson-Noir-AI-Agent-City/?map=city#Intent;scheme=https;package=com.android.chrome;end', 'the page, its query kept, its fragment dropped')
  assert.equal(platformOf(SAMSUNG).browser, 'other', 'Samsung Internet is not Chrome')
  assert.ok(card(SAMSUNG).openIn, 'Samsung Internet')
  assert.ok(card(UA.androidWebView).openIn, 'an app\'s built-in browser')
  assert.equal(card(UA.androidChrome).openIn, null, 'Chrome itself (and Brave, which reports as Chrome)')
  assert.equal(card(FF, { standalone: true }).openIn, null, 'the installed app')
  assert.equal(card(UA.firefoxLinux).openIn, null, 'Firefox on a desktop')
  assert.equal(card(FF, { href: 'file:///sdcard/index.html' }).openIn, null, 'no web address to hand over')
  assert.equal(classify(err('no-adapter'), env(FF, { href })).openIn, null, 'only where WebGPU itself is missing')
  assert.equal(openInChrome({ href, standalone: false, native: true }, platformOf(FF)), null, 'the Windows app')
})

test('haltClass: the real halt reasons; Ring-0 copy for audits only', () => {
  assert.equal(haltClass('Sensing Failure: pedestrian sensing stopped (GPU device lost (unknown): test).'), 'gpu-reset')
  assert.equal(haltClass('Sensing Failure: pedestrian sensing stopped (blinded).'), 'audit', 'sensing without a lost device stays an audit')
  assert.equal(haltClass(`${GRAPHICS_RESET} the page's GPU device was lost (unknown): x`), 'gpu-reset')
  for (const r of ['Physics realm fault: worker error', 'Physics realm fault: RuntimeError: unreachable executed', 'Physics realm fault: init: x']) assert.equal(haltClass(r), 'realm-fault', r)
  assert.equal(haltClass(`${FRAME_FAULT} TypeError: x`), 'frame')
  for (const code of ['NON_FINITE', 'RUNAWAY', 'OUT_OF_BOUNDS', 'IMPACT', 'UNGUARDED_APPROACH', 'OFF_CORRIDOR'] as const) {
    const reason = panicReason({ code, subject: 'pedestrians', detail: 'a GPU pedestrian state was non-finite' } as Parameters<typeof panicReason>[0])
    assert.equal(haltClass(reason), 'audit', reason)
  }
  assert.equal(haltClass('halted'), 'audit')
  const reset = explainHalt('Sensing Failure: pedestrian sensing stopped (GPU device lost (unknown): test).', env(UA.ios26, IPHONE))
  assert.equal(reset.headline, 'The graphics device was reset')
  assert.match(text(reset), /same seed/)
  assert.match(reset.detail, /GPU device lost/)
  assert.equal(explainHalt('Physics realm fault: worker error', env(UA.edgeWindows)).headline, 'The city’s physics stopped')
  assert.equal(explainHalt(`${FRAME_FAULT} TypeError: x`, env(UA.edgeWindows)).headline, 'The city stopped drawing')
})

test('autoReload: once, only after a loss in the background, never without storage, at most every two minutes', () => {
  assert.equal(AUTO_RELOAD_GAP_MS, 120_000)
  const t = 1_000_000_000
  assert.equal(autoReload({ lastMs: null, nowMs: t, hiddenAtLoss: true, storageOk: true }), true)
  assert.equal(autoReload({ lastMs: null, nowMs: t, hiddenAtLoss: false, storageOk: true }), false, 'a loss while visible shows the card')
  assert.equal(autoReload({ lastMs: null, nowMs: t, hiddenAtLoss: true, storageOk: false }), false, 'storage refused: it could loop')
  assert.equal(autoReload({ lastMs: t - 60_000, nowMs: t, hiddenAtLoss: true, storageOk: true }), false)
  assert.equal(autoReload({ lastMs: t - AUTO_RELOAD_GAP_MS, nowMs: t, hiddenAtLoss: true, storageOk: true }), true)
  assert.equal(autoReload({ lastMs: t + 5_000, nowMs: t, hiddenAtLoss: true, storageOk: true }), false, 'a clock that went back is not a licence')
})

test('firstScreen: the onboarding only for a browser that can run the city; the card otherwise', () => {
  assert.equal(firstScreen({ onboard: false, probe: null }), 'city')
  assert.equal(firstScreen({ onboard: true, probe: null }), 'probing')
  assert.equal(firstScreen({ onboard: true, probe: { ok: true, info: 'google / swiftshader' } }), 'onboarding')
  assert.equal(firstScreen({ onboard: true, probe: { ok: false, error: err('no-api') } }), 'card')
})

test('detailsLine: the build, the adapter and the user agent on one copyable line', () => {
  assert.match(detailsLine('google / swiftshader', UA.chromeLinux), /^\S+ \S+ · google \/ swiftshader · Mozilla\/5\.0 \(X11/)
  assert.match(detailsLine('', ''), /adapter unknown · user agent unknown$/)
})
