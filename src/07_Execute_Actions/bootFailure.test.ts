// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins bootFailure.ts, the words a failure gets on the player's own device, over real user
 * agents: iOS 18 and iOS 26 Safari (which still reports the OS as 18_6 and carries Version/26), the iOS home-screen app,
 * Chrome on iOS, an iOS app's built-in browser, Android Chrome and an Android WebView, Firefox and Chrome on Linux,
 * Edge on Windows, an iPad asking for the desktop site, Safari on a Mac, and the apps (Windows, Linux, macOS, Android
 * and iPhone), each naming its own web view. Every code each failure carries, and every message the page has always
 * shown, maps to its class; the installed apps are never told to edit an address or switch browsers; the 'needs
 * WebGPU' line appears only where WebGPU is what is missing; the halt reasons the realm and the engine really produce
 * keep the Ring-0 copy only for audits; Android's no-adapter card names the
 * browser the player has open (or says "this browser"), tells a page given no GPU at all from WebGPU held back, and
 * says nothing of Chromium or Advanced Protection to Firefox; and the one automatic restart after a
 * graphics reset in the background is guarded as the plan says.
 * What breaks if it is removed? A wording change could send an iPhone XR to an update it cannot take, tell the
 * installed app to open a browser it does not have, or file a GPU reset under a broken invariant, unnoticed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { NoAdapterError, noAdapterMessage, WebGPUUnavailableError, type GpuFailure } from '../01_Initialize_World/gpuDevice.ts'
import { BRAND } from '../brand.ts'
import { panicReason } from '../02_Define_The_Rules/ring0.ts'
import { coded } from './simProtocol.ts'
import { kernelLostFailure, kernelNoneFailure, KernelNoneError, KernelResetError, type KernelMemory } from '../03_Spawn_Agents/crowdKernelMemory.ts'
import {
  appName, AUTO_RELOAD_GAP_MS, autoReload, BOOT_STAGE, BUILD_META, classify, detailsLine, deviceHints, explainHalt, firstScreen, FRAME_FAULT, GPU_CRASH_WINDOW_MS, GPU_LOSSES_KEY, GPU_PAUSE_MS, gpuPaused, GRAPHICS_RESET,
  appWebView, haltClass, installedApp, KERNEL_RESTART_GAP_MS, KERNEL_RESTART_KEY, kernelAddress, kernelFreeAddress, kernelRestartAddress, kindOf, noteGpuLoss, openInChrome, pageBuild, parseGpuLosses, parseKernelRestart, platformOf,
  recentGpuLosses, WEBGPU_LINE, webgpuLine, iosBefore26, withGpuLoss, GPU_LOSS_SAME_MS, type Env, type Failure, CONSOLE_TALKS_LINE, consoleTalks, keptLeavesApp,
} from './bootFailure.ts'
import { createMindRouter, PROVIDERS } from '../09_Cognition/router.ts'

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
  // The user agent of the real Safari 27.2 on GitHub's macOS 15 and macOS 26 runners alike (iphone.yml): it names no macOS.
  macSafari27: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15',
  // The apps' web views: WebKitGTK on Linux, WKWebView on macOS and iPhone (no Version/ or Safari/ token), and the
  // Android System WebView ('; wv)').
  iosWebView: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  androidAppWebView: 'Mozilla/5.0 (Linux; Android 11; Pixel 4a; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36',
  webkitGtk: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15',
  macWebView: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
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
  assert.match(text(ios26), /page menu beside the address, then Website Settings, and turn Lockdown Mode off for this site/, 'Safari on iOS has no Settings for This Website')
  const home = classify(err('no-api'), env(UA.homeScreen, HOME_SCREEN))
  assert.match(home.headline, /This iPhone needs iOS 26/)
  assert.match(text(home), /open the app again/)
  // Chrome on an iPhone and an app's built-in browser are Safari's engine and have WebGPU from iOS 26 too: without it
  // the update comes first (Safari on an older iOS has none either), and Safari second, where the iOS may be new enough.
  const crios = classify(err('no-api'), env(UA.crios, IPHONE))
  assert.equal(crios.headline, 'No WebGPU in this browser on this iPhone')
  assert.deepEqual(crios.steps, [
    'On an iPhone, WebGPU comes with iOS 26, in Safari and in every other browser: they all use Safari’s engine.',
    'Update in Settings > General > Software Update (iOS 26 runs on iPhone 11, iPhone SE (2nd generation) and newer), then open the page again.',
    'Already on iOS 26? Open the page in Safari (the share button, then Open in Safari, or copy the link), and check that Lockdown Mode is off in Settings > Privacy & Security.',
  ])
  const inApp = classify(err('no-api'), env(UA.instagram, IPHONE))
  assert.equal(inApp.headline, 'No WebGPU in this browser on this iPhone')
  assert.match(text(inApp), /Already on iOS 26\? This is an app’s built-in browser, which can leave WebGPU off: use the app’s menu \(often ••• or the share button\) and choose Open in Safari/)
  // A system token below 18_6 says the iOS is older outright: no Safari to send it to.
  const old17 = classify(err('no-api'), env(UA.crios.replace('18_6', '17_5'), IPHONE))
  assert.equal(old17.headline, 'This iPhone needs iOS 26')
  assert.equal(old17.steps.length, 2)
  assert.doesNotMatch(text(old17), /Open the page in Safari|Already on/)
  assert.deepEqual([iosBefore26(UA.ios18), iosBefore26(UA.ios26), iosBefore26(UA.crios.replace('18_6', '18_5')), iosBefore26(UA.crios.replace('18_6', '16_7')), iosBefore26(UA.ipadDesktop), iosBefore26(UA.androidChrome), iosBefore26(UA.macSafari18)],
    [true, false, true, true, false, false, false], 'only a token below 18_6 on an iPhone or iPad says older; 18_6 and later are frozen and say nothing')
  assert.equal(iosBefore26('Mozilla/5.0 (iPad; CPU OS 17_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1'), true, 'an iPad writes "CPU OS"')
  assert.equal(classify(err('no-api'), env(UA.androidWebView)).headline, 'Open this page in Chrome')
  assert.match(text(classify(err('no-api'), env(UA.androidWebView))), /Open in Chrome/)
  assert.match(text(classify(err('no-api'), env(UA.androidChrome))), /Update Chrome.*Android 12/s)
  assert.match(text(classify(err('no-api'), env(UA.firefoxLinux))), /about:config, set dom\.webgpu\.enabled to true/)
  assert.match(text(classify(err('no-api'), env(UA.firefoxWindows))), /Update Firefox/)
  // A Mac's Safari gets WebGPU from macOS 26, not from Safari's own number (a real Safari 27 on macOS 15 has none).
  const mac18 = classify(err('no-api'), env(UA.macSafari18))
  assert.equal(mac18.headline, 'This Mac needs macOS 26 for Safari')
  assert.match(text(mac18), /Safari 18 doesn’t turn WebGPU on; the Safari that comes with macOS 26 does/)
  const mac27 = classify(err('no-api'), env(UA.macSafari27))
  assert.equal(mac27.headline, 'Safari has no WebGPU on this Mac', 'a Safari new enough may still sit on an older macOS: not "turned off"')
  assert.match(text(mac27), /on an older macOS, Safari 26 and newer still come without it/)
  assert.match(text(mac27), /Already on macOS 26\? Check Safari > Settings > Advanced > Feature Flags > WebGPU/)
  assert.match(classify(err('no-api'), env(UA.ipadDesktop, { touchPoints: 5 })).headline, /WebGPU is turned off in Safari/)
  const tauri = classify(err('no-api'), env(UA.edgeWindows, TAURI))
  assert.match(text(tauri), /WebView2/)
  assert.doesNotMatch(text(tauri), /Chrome|Open the page in|Open this page in/, 'the Windows app has no other browser to go to')
  assert.equal(tauri.webgpuLine, WEBGPU_LINE)
  for (const f of [ios18, ios26, home]) assert.equal(f.webgpuLine, webgpuLine(platformOf(UA.ios26, 5)))
})

test('the WebGPU line is the device\'s own: an iPhone or iPad is never sent to Chrome, a Mac is told macOS 26', () => {
  const phone = webgpuLine(platformOf(UA.ios26, 5))
  assert.equal(phone, `${BRAND.name} needs WebGPU, which an iPhone has from iOS 26 on. Chrome and the other browsers on an iPhone are built on Safari’s engine, so another browser does not add it. The crowd simulation runs as WGSL compute and has no WebGL path.`)
  assert.match(webgpuLine(platformOf(UA.ipadDesktop, 5)), /which an iPad has from iPadOS 26 on\. Chrome and the other browsers on an iPad/)
  // Every card an iPhone can be shown, in Safari, in Chrome there, in an app's built-in browser, from the Home Screen
  // and in the iPhone app: no line and no step names a browser that would change nothing.
  const kinds = ['no-api', 'no-adapter', 'compat-only', 'device', 'worker-gpu', 'wasm', 'shader', 'compiler', 'gpu-reset', 'kernel-lost', 'kernel-none', 'gpu-paused', 'stalled'] as const
  const phones: [string, Env][] = [
    ['Safari on iOS 18', env(UA.ios18, IPHONE)], ['Safari on iOS 26', env(UA.ios26, IPHONE)], ['Chrome on an iPhone', env(UA.crios, IPHONE)],
    ['an app’s built-in browser', env(UA.instagram, IPHONE)], ['the Home Screen app', env(UA.homeScreen, HOME_SCREEN)],
    ['the iPhone app', env(UA.iosWebView, { ...IPHONE, native: true })], ['an iPad as a desktop', env(UA.ipadDesktop, IPHONE)],
  ]
  for (const [name, e] of phones) {
    for (const kind of kinds) {
      const f = classify(Object.assign(new Error('x'), { code: kind }), e)
      const all = `${text(f)}\n${f.webgpuLine ?? ''}`
      assert.doesNotMatch(all.replace(/Chrome and the other browsers on an iP(?:hone|ad) are built on Safari’s engine/, ''), /Chrome|\bEdge\b|Brave|Firefox|WebView2|Play Store/, `${name}, ${kind}: ${all}`)
      assert.equal(f.openIn ?? null, null, `${name}, ${kind}: no Open in Chrome button`)
    }
    for (const m of ['Crowd compute pipeline validation failed: x', 'the first frame failed WebGPU validation: x', 'anything else']) {
      assert.doesNotMatch(text(classify(new Error(m), e)), /Chrome|\bEdge\b|Brave/, `${name}: ${m}`)
    }
  }
  // WebKit reports every refused pipeline as a validation error, so this is the card an iPhone gets when its WebGPU
  // rejects a shader: the system's update, then the details line, and no other browser.
  const refused = classify(new Error('Crowd compute pipeline validation failed: x'), env(UA.ios26, IPHONE))
  assert.equal(refused.kind, 'shader')
  assert.match(text(refused), /Update the iPhone’s system software in Settings > General > Software Update \(Safari’s WebGPU comes with it\), then open the page again\./)
  assert.match(text(refused), /send the details line below with a bug report/)
  assert.match(text(classify(new Error('Crowd compute pipeline validation failed: x'), env(UA.macSafari27))), /Update macOS \(Safari’s WebGPU comes with it\), or open the page in a current Chrome or Edge/)
  assert.match(text(classify(new Error('Crowd compute pipeline validation failed: x'), env(UA.edgeWindows))), /Update the browser; a current Chrome or Edge runs the city\./)
  // The Mac's line, in Safari and in the Mac app; everything else keeps the general one.
  const mac = webgpuLine(platformOf(UA.macSafari27))
  assert.equal(mac, `${BRAND.name} needs WebGPU: on a Mac, Safari on macOS 26 or newer, or a current Chrome, Edge or Brave. The crowd simulation runs as WGSL compute and has no WebGL path.`)
  assert.equal(classify(err('no-adapter'), env(UA.macSafari27)).webgpuLine, mac)
  for (const ua of [UA.chromeLinux, UA.edgeWindows, UA.androidChrome, UA.firefoxWindows]) assert.equal(webgpuLine(platformOf(ua)), WEBGPU_LINE)
  assert.match(WEBGPU_LINE, /a current Chrome, Edge or Brave on desktop or Android, or Safari on iOS 26, iPadOS 26, macOS 26 or newer\./)
})

test('no adapter: Linux names the flags, Vulkan and chrome://gpu (and NixOS\'s driver); the rest their own fix', () => {
  const linux = text(classify(err('no-adapter'), env(UA.chromeLinux)))
  assert.match(linux, /chrome:\/\/gpu/)
  assert.match(linux, /chrome:\/\/flags\/#enable-unsafe-webgpu and chrome:\/\/flags\/#enable-vulkan/)
  assert.match(linux, /hardware\.graphics\.enable = true/)
  assert.match(text(classify(err('no-adapter'), env(UA.edgeWindows))), /hardware acceleration/)
  assert.match(text(classify(err('no-adapter'), env(UA.edgeWindows, TAURI))), /graphics driver and WebView2/)
  assert.match(text(classify(err('no-adapter'), env(UA.androidChrome))), /Chrome has WebGPU but gave this page no GPU for it/)
  assert.match(text(classify(err('no-adapter'), env(UA.firefoxLinux))), /Firefox has WebGPU but offered no GPU/)
  assert.match(text(classify(err('no-adapter'), env(UA.ios26, IPHONE))), /App Switcher/)
  assert.equal(classify(err('no-adapter'), env(UA.chromeLinux)).webgpuLine, WEBGPU_LINE)
})

test('no adapter on Android: the browser by its own name, force stop first, and the WebGL answer tells a page given no GPU at all from WebGPU held back', () => {
  const noAdapter = (webgl: boolean | null) => new NoAdapterError(noAdapterMessage(webgl), webgl)
  // WebGL refused as well: the browser hands the page no GPU at all, as after its graphics crashed.
  const none = classify(noAdapter(false), env(UA.androidChrome))
  assert.equal(none.kind, 'no-adapter')
  assert.equal(none.headline, 'Chrome is giving this page no GPU')
  assert.deepEqual(none.steps, [
    'Chrome hands this page no GPU at all, not even for WebGL, as a browser can after its graphics crashed, until it is closed.',
    'Close Chrome completely (Settings > Apps > Chrome > Force stop), then open the page again.',
    'Still nothing: restart the phone, or open the page in another browser built on Chromium, such as Brave or Edge.',
  ])
  assert.equal(none.detail, noAdapterMessage(false))
  assert.equal(none.webgpuLine, WEBGPU_LINE)
  assert.equal(none.openIn, null, 'Chrome itself gets no Open in Chrome button')
  // WebGL still given: WebGPU alone is held back (Advanced Protection, or the browser's own list of GPUs).
  const held = classify(noAdapter(true), env(UA.androidChrome))
  assert.equal(held.headline, 'No graphics adapter for WebGPU')
  assert.deepEqual(held.steps, [
    'Chrome still gives this page WebGL but holds WebGPU back.',
    'Close Chrome completely (Settings > Apps > Chrome > Force stop), then open the page again.',
    'Still none: under Android’s Advanced Protection (Settings > Security & privacy > Advanced Protection) Chrome and the browsers built on it turn WebGPU off, and Chrome can keep it from a GPU on its own list; open the page in another browser built on Chromium, such as Brave or Edge.',
  ])
  // Unknown (an error without the answer, as older code threw it): the plain words, the same steps.
  const plain = classify(err('no-adapter'), env(UA.androidChrome))
  assert.equal(plain.steps[0], 'Chrome has WebGPU but gave this page no GPU for it.')
  assert.deepEqual(plain.steps.slice(1), held.steps.slice(1))
  assert.deepEqual(classify(noAdapter(null), env(UA.androidChrome)).steps, plain.steps)
  // Brave sends Chrome's user agent on Android: its own name comes from the page (appName), and the browser offered
  // elsewhere is never the one already open. Edge's user agent names it (EdgA).
  const brave = classify(noAdapter(false), env(UA.androidChrome, { app: 'Brave' }))
  assert.equal(brave.headline, 'Brave is giving this page no GPU')
  assert.match(text(brave), /Settings > Apps > Brave > Force stop/)
  assert.match(text(brave), /such as Chrome or Edge\./)
  assert.match(text(classify(noAdapter(true), env(UA.androidChrome, { app: 'Edge' }))), /Edge can keep it from a GPU on its own list; open the page in another browser built on Chromium, such as Chrome or Brave\./)
  assert.match(text(classify(noAdapter(true), env(UA.androidChrome.replace('Mobile Safari', 'EdgA/141.0.0.0 Mobile Safari')))), /Settings > Apps > Edge > Force stop/)
  // A loss under the city's crowd in this browser before is said first, whatever WebGL said.
  for (const gl of [true, false, null] as const) {
    const lost = classify(noAdapter(gl), env(UA.androidChrome, { gpuLostHere: true })).steps
    assert.equal(lost[0], 'The city’s crowd took this phone’s GPU down in Chrome on an earlier visit.', String(gl))
    assert.deepEqual(lost.slice(1), classify(noAdapter(gl), env(UA.androidChrome)).steps, String(gl))
  }
  // The installed app is never sent to another browser, and is opened again as an app.
  for (const gl of [true, false, null] as const) {
    const app = text(classify(noAdapter(gl), env(UA.androidChrome, { standalone: true })))
    assert.doesNotMatch(app, /another browser|open the page|Brave or|Chrome or/, String(gl))
    assert.match(app, /Force stop\), then open the app again\./, String(gl))
  }
  // An app's built-in browser is sent to Chrome, with the one-tap button, as for no WebGPU at all.
  const inApp = classify(noAdapter(false), env(UA.androidWebView, { href: 'https://city.example/play' }))
  assert.match(text(inApp), /Open in Chrome/)
  assert.deepEqual(inApp.openIn, { label: 'Open in Chrome', href: 'intent://city.example/play#Intent;scheme=https;package=com.android.chrome;end' })
  // Nothing of this reaches another system's card.
  for (const ua of [UA.chromeLinux, UA.edgeWindows, UA.ios26]) assert.doesNotMatch(text(classify(noAdapter(false), env(ua, { gpuLostHere: true, app: 'Brave' }))), /Force stop|Advanced Protection|earlier visit/, ua)
})

test('no adapter on Android in a browser with no name, Samsung Internet, or Firefox: full sentences, no Chromium or Advanced Protection claims for Firefox', () => {
  const noAdapter = (webgl: boolean | null) => new NoAdapterError(noAdapterMessage(webgl), webgl)
  // Client hints that name no app (a build of Chromium): not Chrome, whatever the user agent says.
  const nameless = classify(noAdapter(false), env(UA.androidChrome, { app: '', gpuLostHere: true }))
  assert.equal(nameless.headline, 'This browser is giving this page no GPU')
  assert.deepEqual(nameless.steps, [
    'The city’s crowd took this phone’s GPU down in this browser on an earlier visit.',
    'This browser hands this page no GPU at all, not even for WebGL, as a browser can after its graphics crashed, until it is closed.',
    'Close this browser completely (in Settings > Apps, choose it, then Force stop), then open the page again.',
    'Still nothing: restart the phone, or open the page in another browser built on Chromium, such as Chrome or Brave.',
  ])
  assert.match(text(classify(noAdapter(true), env(UA.androidChrome, { app: '' }))), /^No graphics adapter for WebGPU\nThis browser still gives this page WebGL but holds WebGPU back\.\n.*\nStill none: .*and this browser can keep it from a GPU on its own list; /)
  // No client hints at all: the user agent names it.
  assert.equal(classify(noAdapter(false), env(UA.androidChrome, { app: null })).headline, 'Chrome is giving this page no GPU')
  const samsung = 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36'
  assert.match(text(classify(noAdapter(false), env(samsung))), /^Samsung Internet is giving this page no GPU\n.*Settings > Apps > Samsung Internet > Force stop/s)
  // Firefox: neither "another browser built on Chromium" nor Chrome's Advanced Protection behaviour.
  const firefox = 'Mozilla/5.0 (Android 14; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0'
  for (const gl of [true, false, null] as const) {
    const f = text(classify(noAdapter(gl), env(firefox)))
    assert.match(f, /Settings > Apps > Firefox > Force stop/, String(gl))
    assert.match(f, /open the page in Chrome or Brave\.$/, String(gl))
    assert.doesNotMatch(f, /Chromium|Advanced Protection/, String(gl))
    assert.doesNotMatch(text(classify(noAdapter(gl), env(firefox, { standalone: true }))), /Chrome or Brave|open the page|Chromium|Advanced Protection/, String(gl))
  }
  for (const f of [nameless, classify(noAdapter(true), env(firefox)), classify(noAdapter(null), env(samsung))]) for (const line of [f.headline, ...f.steps]) assert.match(line, /^[A-Z]/, line)
})

test('appName: Brave by its own word, else the first real brand of the client hints, short and printable; none named is not no hints', () => {
  const brands = (...names: string[]) => names.map((brand) => ({ brand, version: '141' }))
  assert.equal(appName(brands('Chromium', 'Not=A?Brand'), true), 'Brave')
  assert.equal(appName(undefined, true), 'Brave')
  assert.equal(appName(brands('Not)A;Brand', 'Chromium', 'Google Chrome'), false), 'Chrome')
  assert.equal(appName(brands('Microsoft Edge', 'Chromium', 'Not_A Brand'), false), 'Edge')
  assert.equal(appName(brands('Chromium', 'Brave'), false), 'Brave')
  assert.equal(appName(brands('Opera', 'Chromium'), false), 'Opera')
  assert.equal(appName(brands('OperaMobile', 'Opera', 'Chromium', ' Not A;Brand'), false), 'Opera', 'Opera for Android, as Android lists it')
  assert.equal(appName(brands('Chromium', 'Not A(Brand'), false), '', 'hints that name only the engine name no app')
  assert.equal(appName([], false), '')
  assert.equal(appName([null, 1, { brand: 7 }], false), '')
  assert.equal(appName(brands('Very Long Browser Name That Runs On And On'), false)?.length, 24)
  assert.equal(appName(brands('Ch\u0000rome '), false), 'Chrome')
  for (const odd of [undefined, null, 'Chrome', {}]) assert.equal(appName(odd, false), null, `no hints: ${String(odd)}`)
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
    // Chrome's words for work whose GPU process died under it (the card a Mali phone sent): a reset, whoever said them.
    ['init: Instance dropped in popErrorScope', 'gpu-reset'],
    ['Instance dropped error in getCompilationInfo', 'gpu-reset'],
    ['A valid external Instance reference no longer exists.', 'gpu-reset'],
    // The same death read as a compiler's refusal by a build that did not ask the device first: still the reset.
    ["init: crowd.wgsl pipeline compilation failed: the GPU's own compiler refused the full kernel (crowd.wgsl simulate: refused by the GPU's own compiler (internal error): A valid external Instance reference no longer exists.)", 'gpu-reset'],
    ['init: crowd.wgsl pipeline validation failed: binding 14', 'shader'],
    ['crowd.wgsl cull pipeline validation failed: x', 'shader'],
    ["init: crowd.wgsl pipeline validation failed: crowd.wgsl binAgents: failed WebGPU validation: Entry point \"binAgents\" uses binding 5; compiler messages: error at line 9:4: no such thing", 'shader'],
    // The GPU's own compiler refusing a kernel WebGPU accepted (gpuPipelines.ts): the driver's class, not the shader's.
    ["init: crowd.wgsl pipeline compilation failed: the GPU's own compiler refused the full kernel (crowd.wgsl simulate: refused by the GPU's own compiler (internal error): CreateComputePipelines failed with VK_ERROR_INITIALIZATION_FAILED), the full kernel at narrow workgroups (x), the light kernel (y) [crowd device: arm / Mali-G52 MC2]", 'compiler'],
    ["crowd.wgsl cull pipeline compilation failed: crowd.wgsl cull: refused by the GPU's own compiler (internal error): x", 'compiler'],
    ["init: flowField.wgsl pipeline compilation failed: internal: x", 'compiler'],
    ["init: crowd.wgsl pipeline validation failed: WebGPU refused the full kernel (crowd.wgsl simulate: failed WebGPU validation: Compute library failed to compile), the full kernel at narrow workgroups (x), the light kernel (y)", 'shader'],
    ['init: crowd.wgsl could not be set up on this GPU: out-of-memory: crowd.gridSlots: no memory', 'other'],
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

test('the compiler card: the driver, not the browser, named as what refused the crowd; a phone told to update its system software, the Windows app its driver and WebView2; the ladder named', () => {
  const refused = new Error("init: crowd.wgsl pipeline compilation failed: the GPU's own compiler refused the full kernel (crowd.wgsl simulate: refused by the GPU's own compiler (internal error): CreateComputePipelines failed with VK_ERROR_INITIALIZATION_FAILED), the full kernel at narrow workgroups (x), the light kernel (y)")
  const phone = classify(refused, env(UA.androidChrome, { touchPoints: 5 }))
  assert.equal(phone.headline, 'This device’s graphics driver couldn’t build the crowd')
  assert.match(text(phone), /WebGPU accepted the crowd’s shader, but the GPU’s own compiler refused/)
  assert.match(text(phone), /Update Chrome and the phone’s system software \(the graphics driver comes with it\), then open the page again\./)
  assert.match(text(phone), /Where the city started higher, it also tried narrower workgroups and its lighter kernel; the details name each refusal\./)
  assert.doesNotMatch(text(phone), /rejected part of the city’s drawing/, 'not the shader card')
  assert.equal(phone.detail, refused.message, 'the driver’s words, the kernel named, on the card')
  assert.match(text(classify(refused, env(UA.edgeWindows, TAURI))), /Update the graphics driver and WebView2/)
  assert.match(text(classify(refused, env(UA.chromeLinux))), /Update the graphics driver and the browser/)
  // Every browser on iOS is WebKit and its graphics come with iOS: the home-screen app and a Safari tab are told to
  // update the iPhone, never Chrome; the Android home-screen app is told Chrome, which it runs on.
  const home = classify(refused, env(UA.homeScreen, HOME_SCREEN))
  assert.match(text(home), /Update the iPhone’s system software \(Safari’s graphics come with it\), then open the app again\./)
  assert.doesNotMatch(text(home), /Chrome/)
  assert.match(text(classify(refused, env(UA.ios26, IPHONE))), /Update the iPhone’s system software \(Safari’s graphics come with it\), then open the page again\./)
  assert.match(text(classify(refused, env(UA.androidChrome, { touchPoints: 5, standalone: true }))), /Update Chrome and the phone’s system software \(the graphics driver comes with it\), then open the app again\./)
  // A coded 'compiler' is the same card (the installed apps' loop above drives it so).
  assert.equal(classify(Object.assign(new Error('x'), { code: 'compiler' }), env(UA.chromeLinux)).kind, 'compiler')
  // The shader card is unchanged for a validation refusal, now with the browser's words and the compiler's line.
  const shader = classify(new Error('init: crowd.wgsl pipeline validation failed: crowd.wgsl binAgents: failed WebGPU validation: x; compiler messages: error at line 9:4: y "fn binAgents("'), env(UA.chromeLinux))
  assert.equal(shader.headline, 'The browser couldn’t build the city’s graphics')
  assert.match(shader.detail, /compiler messages: error at line 9:4/)
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
  for (const code of ['no-api', 'no-adapter', 'compat-only', 'device', 'gpu-reset', 'kernel-lost', 'kernel-none', 'gpu-paused', 'stalled', 'shader', 'compiler'] as const) {
    const e = Object.assign(new Error('x'), { code })
    assert.doesNotMatch(text(classify(e, env(UA.homeScreen, HOME_SCREEN))), NO, `home screen ${code}`)
    assert.doesNotMatch(text(classify(e, env(UA.edgeWindows, TAURI))), NO, `Tauri ${code}`)
  }
  for (const code of ['worker-gpu', 'wasm'] as const) {
    assert.doesNotMatch(text(classify(coded(code, 'x'), env(UA.homeScreen, HOME_SCREEN))), NO, `home screen ${code}`)
    assert.doesNotMatch(text(classify(coded(code, 'x'), env(UA.edgeWindows, TAURI))), NO, `Tauri ${code}`)
  }
})

test('each app names its own web view: WebKitGTK on Linux, WebKit on macOS and iOS, the Android System WebView, WebView2 on Windows', () => {
  assert.deepEqual([platformOf(UA.webkitGtk).os, platformOf(UA.macWebView).os], ['linux', 'mac'])
  assert.equal(appWebView(platformOf(UA.webkitGtk)).name, 'WebKitGTK')
  assert.equal(appWebView(platformOf(UA.macWebView)).name, 'WebKit')
  assert.equal(appWebView(platformOf(UA.edgeWindows)).name, 'WebView2')
  assert.equal(appWebView(platformOf(UA.edgeWindows)).update, null, 'Windows keeps each card\'s own words')
  const card = (code: string, ua: string) => text(classify(code === 'worker-gpu' || code === 'wasm' ? coded(code, 'x') : Object.assign(new Error('x'), { code }), env(ua, TAURI)))
  // The cards whose steps name the web view: each names this system's, and never another's.
  for (const code of ['no-api', 'no-adapter', 'compat-only', 'worker-gpu', 'shader', 'compiler', 'kernel-none']) {
    const linux = card(code, UA.webkitGtk)
    // The .deb and .rpm use the system's WebKitGTK; the AppImage carries its own, which only a newer AppImage updates.
    assert.match(linux, /Update WebKitGTK \(the system’s package updates; the AppImage carries its own, so get a newer AppImage of the app\) and the graphics driver, then restart the app\./, `Linux ${code}`)
    assert.doesNotMatch(linux, /WebView2|Windows|Microsoft|macOS/, `Linux ${code}`)
    const mac = card(code, UA.macWebView)
    assert.match(mac, /Update macOS \(WebKit and the graphics driver come with it\), then restart the app\./, `macOS ${code}`)
    assert.doesNotMatch(mac, /WebView2|Windows|Microsoft|WebKitGTK/, `macOS ${code}`)
    assert.match(card(code, UA.edgeWindows), /WebView2/, `Windows ${code}`)
    assert.doesNotMatch(card(code, UA.edgeWindows), /WebKit/, `Windows ${code}`)
  }
  const linux = classify(err('no-api'), env(UA.webkitGtk, TAURI))
  assert.equal(linux.headline, 'This app’s WebKitGTK has no WebGPU')
  assert.match(linux.steps[0], /draws with WebGPU through WebKitGTK\.$/)
  assert.equal(linux.webgpuLine, WEBGPU_LINE)
  assert.equal(classify(err('no-api'), env(UA.macWebView, TAURI)).headline, 'This app’s WebKit has no WebGPU')
  assert.match(classify(err('no-api'), env(UA.macWebView, TAURI)).steps[0], /through macOS’s WebKit\.$/)
  assert.equal(classify(err('no-api'), env(UA.edgeWindows, TAURI)).headline, 'This app’s WebView2 has no WebGPU')
  assert.match(classify(err('no-adapter'), env(UA.webkitGtk, TAURI)).steps[0], /^Linux gave the app’s WebKitGTK no GPU for WebGPU\.$/)
  assert.match(classify(err('no-adapter'), env(UA.macWebView, TAURI)).steps[0], /^macOS gave the app’s WebKit no GPU for WebGPU\.$/)
  assert.match(classify(err('no-adapter'), env(UA.edgeWindows, TAURI)).steps[0], /^Windows gave the app’s WebView2 no GPU for WebGPU\.$/)
  // A Linux or macOS browser (not the app) is told about its browser, never a web view.
  assert.doesNotMatch(text(classify(err('no-api'), env(UA.chromeLinux))), /WebKitGTK|WebView2/)
  // The phone apps (the build's android-apk and ios-ipa): their own web view, never Windows' words, never a browser.
  assert.deepEqual([platformOf(UA.androidAppWebView, 5).os, platformOf(UA.iosWebView, 5).os], ['android', 'ios'])
  assert.equal(appWebView(platformOf(UA.androidAppWebView, 5)).name, 'Android System WebView')
  assert.equal(appWebView(platformOf(UA.iosWebView, 5)).name, 'WebKit')
  assert.equal(appWebView(platformOf(UA.iosWebView.replace('iPhone; CPU iPhone OS', 'iPad; CPU OS'), 5)).system, 'iPadOS')
  const phone = (code: string, ua: string) => text(classify(code === 'worker-gpu' || code === 'wasm' ? coded(code, 'x') : Object.assign(new Error('x'), { code }), env(ua, { ...TAURI, touchPoints: 5 })))
  const NO = /address bar|copy the link|Open (?:this|the) page in|open the page again|in Chrome|in Safari/
  for (const code of ['no-api', 'no-adapter', 'compat-only', 'worker-gpu', 'shader', 'compiler', 'kernel-none', 'device', 'gpu-reset', 'wasm']) {
    for (const [name, ua] of [['Android', UA.androidAppWebView], ['iOS', UA.iosWebView]] as const) {
      const card = phone(code, ua)
      assert.doesNotMatch(card, /WebView2|Windows|Microsoft|WebKitGTK|macOS/, `${name} app ${code}`)
      assert.doesNotMatch(card, NO, `${name} app ${code}: no browser to switch to, no page to reopen`)
    }
  }
  // Every card whose steps update the web view gives the app's own step, ahead of the phone browser's words.
  for (const code of ['no-api', 'no-adapter', 'compat-only', 'worker-gpu', 'shader', 'compiler', 'kernel-none']) {
    assert.match(phone(code, UA.androidAppWebView), /Update Android System WebView and Chrome from Google Play, then restart the app\./, `Android app ${code}`)
    assert.match(phone(code, UA.iosWebView), /Update iOS \(Settings > General > Software Update\), then restart the app\./, `iOS app ${code}`)
  }
  assert.match(phone('wasm', UA.iosWebView), /Settings > Privacy & Security > Lockdown Mode, then open the app again\./)
  const android = classify(err('no-api'), env(UA.androidAppWebView, { ...TAURI, touchPoints: 5 }))
  assert.equal(android.headline, 'This app’s Android System WebView has no WebGPU')
  assert.match(android.steps[0], /draws with WebGPU through the Android System WebView\.$/)
  assert.equal(android.steps[1], 'Update Android System WebView and Chrome from Google Play, then restart the app.')
  assert.equal(android.openIn, null, 'the app hands no address to Chrome')
  assert.match(classify(err('no-adapter'), env(UA.androidAppWebView, { ...TAURI, touchPoints: 5 })).steps[0], /^Android gave the app’s Android System WebView no GPU for WebGPU\.$/)
  const ios = classify(err('no-api'), env(UA.iosWebView, { ...TAURI, touchPoints: 5 }))
  assert.equal(ios.headline, 'This app’s WebKit has no WebGPU')
  assert.match(ios.steps[0], /draws with WebGPU through iOS’s WebKit\.$/)
  assert.match(classify(err('no-adapter'), env(UA.iosWebView, { ...TAURI, touchPoints: 5 })).steps[0], /^iOS gave the app’s WebKit no GPU for WebGPU\.$/)
  // A phone's browser (not the app) keeps its own words.
  assert.doesNotMatch(text(classify(err('no-api'), env(UA.androidWebView, { touchPoints: 5 }))), /Android System WebView|restart the app/)
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

test('detailsLine: the build, the adapter and the user agent on one copyable line; the web copy adds its own build word', () => {
  const line = detailsLine('google / swiftshader', UA.chromeLinux)
  assert.ok(line.startsWith(`${BRAND.name} ${BRAND.version} · google / swiftshader · Mozilla/5.0 (X11`), line)
  assert.match(detailsLine('', ''), /adapter unknown · user agent unknown$/)
  assert.ok(detailsLine('arm / mali-g52', UA.androidChrome, '0123456789ab').startsWith(`${BRAND.name} ${BRAND.version} (web build 0123456789ab) · arm / mali-g52 · Mozilla/5.0 (Linux; Android 10`))
  assert.equal(detailsLine('x', 'y', ''), detailsLine('x', 'y'), 'no build word (a file, the Windows app): the line as it always was')
  assert.match(detailsLine('arm / mali-g52', UA.androidChrome, '', 'Android 14.0.0 · Armor X32 · Google Chrome 156.0.7778.12'), /Mobile Safari\/537\.36 · Android 14\.0\.0 · Armor X32 · Google Chrome 156\.0\.7778\.12$/)
})

test('deviceHints: the system\'s real version, the model and the browser\'s full version where the browser says; nothing where it does not', async () => {
  // Chrome on Android: the user agent says 'Android 10; K' whatever the phone; the hints name it.
  const asked: string[][] = []
  const chrome = {
    getHighEntropyValues: async (hints: string[]) => {
      asked.push(hints)
      return { platform: 'Android', platformVersion: '14.0.0', model: 'Armor X32', fullVersionList: [{ brand: 'Not?A_Brand', version: '99.0.0.0' }, { brand: 'Chromium', version: '156.0.7778.12' }, { brand: 'Google Chrome', version: '156.0.7778.12' }] }
    },
  }
  assert.equal(await deviceHints(chrome), 'Android 14.0.0 · Armor X32 · Google Chrome 156.0.7778.12')
  assert.deepEqual(asked, [['platform', 'platformVersion', 'model', 'fullVersionList']])
  // A desktop has no model; a build with only the engine's name gives that.
  assert.equal(await deviceHints({ getHighEntropyValues: async () => ({ platform: 'Windows', platformVersion: '19.0.0', model: '', fullVersionList: [{ brand: 'Chromium', version: '153.0.8010.12' }] }) }), 'Windows 19.0.0 · Chromium 153.0.8010.12')
  // Anything odd is left out, never printed raw; no API, a refusal or a throw is nothing.
  assert.equal(await deviceHints({ getHighEntropyValues: async () => ({ platform: 7, platformVersion: null, model: 'X\u0000\n<b>', fullVersionList: 'no', extra: 'x' }) }), 'X<b>')
  assert.equal(await deviceHints({ getHighEntropyValues: async () => ({}) }), '')
  assert.equal(await deviceHints({ getHighEntropyValues: () => Promise.reject(new Error('NotAllowedError')) }), '')
  assert.equal(await deviceHints({ getHighEntropyValues: () => { throw new Error('boom') } }), '')
  assert.equal(await deviceHints({}), '')
  assert.equal(await deviceHints(null), '')
  assert.equal(await deviceHints(undefined), '')
})

test('pageBuild: the build word the page\'s head carries, hex only; nothing where there is no document or no such meta', () => {
  assert.equal(BUILD_META, 'agent-city-build')
  assert.equal(pageBuild(), '', 'Node has no document')
  const g = globalThis as { document?: unknown }
  const head = (content: string | null) => ({ querySelector: (q: string) => (q === 'meta[name="agent-city-build"]' && content !== null ? { getAttribute: (n: string) => (n === 'content' ? content : null) } : null) })
  try {
    g.document = head('0123456789ab')
    assert.equal(pageBuild(), '0123456789ab')
    g.document = head(null)
    assert.equal(pageBuild(), '')
    for (const odd of ['', 'abc', '<script>', '0123456789AB', 'not hex at all']) {
      g.document = head(odd)
      assert.equal(pageBuild(), '', `"${odd}" is not a build word`)
    }
    g.document = { querySelector: () => { throw new Error('no DOM') } }
    assert.equal(pageBuild(), '', 'a document that throws is no document')
  } finally {
    delete g.document
  }
})

test('kernelAddress: the page\'s own address with the kernel asked for, the rest kept; null where there is none', () => {
  assert.equal(kernelAddress('https://city.example/', 'lite'), 'https://city.example/?kernel=lite')
  assert.equal(kernelAddress('https://city.example/sub/?map=region&crowd=512#x', 'narrow'), 'https://city.example/sub/?map=region&crowd=512&kernel=narrow#x')
  assert.equal(kernelAddress('https://city.example/?kernel=full&ghost=0', 'lite'), 'https://city.example/?kernel=lite&ghost=0', 'the old ask is replaced, never doubled')
  assert.equal(kernelAddress('file:///C:/Users/x/Downloads/index.html', 'lite'), 'file:///C:/Users/x/Downloads/index.html?kernel=lite')
  assert.equal(kernelAddress('', 'lite'), null)
  assert.equal(kernelAddress('not an address', 'lite'), null)
})

test('the browser\'s pause after two GPU losses in two minutes: counted by the page, said on its own card, never as a missing adapter', () => {
  assert.equal(GPU_LOSSES_KEY, 'civic-simulation:gpu-losses:v1')
  assert.equal(GPU_PAUSE_MS, 120_000)
  assert.equal(GPU_CRASH_WINDOW_MS, 300_000)
  const t = 1_000_000_000
  // The store keeps the last losses inside the browser's five-minute window, oldest first, four at most.
  assert.deepEqual(parseGpuLosses(null, t), [])
  let raw = withGpuLoss(null, t)
  assert.equal(raw, `[${t}]`)
  raw = withGpuLoss(raw, t + 30_000)
  assert.deepEqual(parseGpuLosses(raw, t + 31_000), [t, t + 30_000])
  assert.deepEqual(parseGpuLosses(raw, t + GPU_CRASH_WINDOW_MS), [t + 30_000], 'a loss older than the window is forgiven')
  assert.deepEqual(parseGpuLosses(raw, t - 1), [], 'a clock that went back counts nothing')
  for (let i = 2; i < 7; i++) raw = withGpuLoss(raw, t + i * 3000)
  assert.equal(parseGpuLosses(raw, t + 21_000).length, 4)
  // One loss noted by several watchers (two tabs of the site; a boot and the engine it made) is one loss.
  assert.equal(GPU_LOSS_SAME_MS, 2000)
  assert.equal(withGpuLoss(`[${t}]`, t), `[${t}]`, 'the same moment')
  assert.equal(withGpuLoss(`[${t}]`, t + 1999), `[${t}]`, 'a tab that heard of it a moment later')
  assert.equal(withGpuLoss(`[${t}]`, t + 2000), `[${t},${t + 2000}]`, 'two losses')
  assert.equal(gpuPaused(parseGpuLosses(withGpuLoss(withGpuLoss(null, t), t + 5), t + 10), t + 10), false, 'so one loss never reads as the pause')
  for (const bad of ['', 'x', '{}', '"1"', '[1,"2",null]', `[${'1,'.repeat(200)}1]`]) assert.deepEqual(parseGpuLosses(bad, t), [], bad.slice(0, 20))
  // Paused: two losses inside two minutes (and a little longer: the browser's clock started first).
  assert.equal(gpuPaused([], t), false)
  assert.equal(gpuPaused([t - 10_000], t), false, 'one loss pauses nothing')
  assert.equal(gpuPaused([t - 40_000, t - 10_000], t), true)
  assert.equal(gpuPaused([t - 124_000, t - 10_000], t), true, 'inside the margin')
  assert.equal(gpuPaused([t - 126_000, t - 10_000], t), false, 'the first loss has expired')
  assert.equal(gpuPaused([t + 5, t + 9], t), false)
  // The page's own store: localStorage, guarded; nothing where the page has none.
  assert.deepEqual(recentGpuLosses(t), [], 'Node has no localStorage here')
  noteGpuLoss(t)
  const g = globalThis as { localStorage?: unknown }
  const kept = new Map<string, string>()
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v) } } })
  try {
    noteGpuLoss(t)
    noteGpuLoss(t + 20_000)
    assert.deepEqual(recentGpuLosses(t + 21_000), [t, t + 20_000])
    assert.equal(kept.get(GPU_LOSSES_KEY), `[${t},${t + 20_000}]`)
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError') } })
    noteGpuLoss(t)
    assert.deepEqual(recentGpuLosses(t), [])
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had)
    else delete g.localStorage
  }
  // The card: the pause and the wait, the same words everywhere, and never the line that blames WebGPU.
  const paused = err('gpu-paused', 'The browser handed the page no GPU adapter after the GPU was lost twice within two minutes; it hands one out again by itself, about two minutes after the first loss.')
  for (const e of [env(UA.androidChrome, { touchPoints: 5 }), env(UA.edgeWindows), env(UA.edgeWindows, TAURI), env(UA.homeScreen, HOME_SCREEN)]) {
    const card = classify(paused, e)
    assert.equal(card.kind, 'gpu-paused')
    assert.equal(card.headline, 'The browser has paused graphics for this page')
    assert.deepEqual(card.steps, [
      'The GPU was lost twice within two minutes, and after that the browser hands this page no GPU for a while: until two minutes after the first loss.',
      'Wait two minutes, then restart. Restarting sooner changes nothing.',
    ])
    assert.equal(card.webgpuLine, null)
    assert.equal(card.restartHref, null)
  }
  assert.equal(classify(coded('worker-gpu', 'no WebGPU adapter inside the physics worker'), env(UA.androidChrome)).kind, 'worker-gpu', 'the engine decides when it is the pause (it has the count)')
})

test('the page\'s own restart on a lighter kernel: its address drops a word that would replay the onboarding, and its note counts for two minutes', () => {
  assert.equal(kernelRestartAddress('https://city.example/?map=region', 'lite'), 'https://city.example/?map=region&kernel=lite')
  assert.equal(kernelRestartAddress('https://city.example/?onboarding=1&map=region', 'lite'), 'https://city.example/?map=region&kernel=lite', 'the restart is not a new visit')
  assert.equal(kernelRestartAddress('https://city.example/?onboarding=on', 'lite'), 'https://city.example/?kernel=lite')
  assert.equal(kernelRestartAddress('https://city.example/?onboarding=0', 'lite'), 'https://city.example/?onboarding=0&kernel=lite', 'a word that skips it stays')
  assert.equal(kernelRestartAddress('', 'lite'), null)
  assert.equal(KERNEL_RESTART_KEY, 'civic-simulation:kernel-restart:v1')
  assert.equal(KERNEL_RESTART_GAP_MS, 120_000)
  const t = 1_000_000_000
  const note = { at: t, mentored: true, startHour: 21.5, audio: false }
  const raw = JSON.stringify(note)
  assert.deepEqual(parseKernelRestart(raw, t), note)
  assert.deepEqual(parseKernelRestart(raw, t + KERNEL_RESTART_GAP_MS - 1), note)
  assert.equal(parseKernelRestart(raw, t + KERNEL_RESTART_GAP_MS), null, 'an old note is no note: a later failure may restart again')
  assert.equal(parseKernelRestart(raw, t - 1), null, 'a clock that went back')
  assert.deepEqual(parseKernelRestart(JSON.stringify({ ...note, extra: 'x' }), t), note, 'only what is known is taken')
  for (const bad of [null, '', 'x', '[]', '{}', '"note"', JSON.stringify({ ...note, at: 'now' }), JSON.stringify({ ...note, mentored: 1 }), JSON.stringify({ ...note, audio: 'yes' }),
    JSON.stringify({ ...note, startHour: 99 }), JSON.stringify({ ...note, startHour: -1 }), JSON.stringify({ ...note, startHour: null }), `${raw.slice(0, -1)},"pad":"${'x'.repeat(600)}"}`]) {
    assert.equal(parseKernelRestart(bad, t), null, String(bad).slice(0, 50))
  }
  assert.equal(BOOT_STAGE.lighter, 'starting again with a lighter crowd')
})

test('a GPU lost under a kernel: the card says the driver stopped, Restart carries the lighter kernel, and the last kernel\'s loss says to leave the GPU alone', () => {
  const href = 'https://city.example/?map=region'
  const verdict = { rung: 'full', next: 'lite', saved: true, words: 'A valid external Instance reference no longer exists.', elapsedMs: null, holdMs: 0 } as const
  const lost = kernelLostFailure(verdict, { from: 'full', by: 'default' })
  assert.ok(lost instanceof KernelResetError && lost.auto && lost.lighter === 'lite')
  assert.equal(lost.message, 'The GPU was lost while the full kernel of the crowd was being built (A valid external Instance reference no longer exists.). Restart asks for the light kernel (?kernel=lite); the page remembers it for later visits.')
  // The words alone would read as a reset ('Instance reference no longer exists'): the code wins.
  const phone = classify(lost, env(UA.androidChrome, { touchPoints: 5, href }))
  assert.equal(phone.kind, 'kernel-lost')
  assert.equal(phone.headline, 'The browser’s graphics stopped while building the crowd')
  assert.match(phone.steps[0], /^The phone’s GPU dropped out of the browser while the crowd’s kernel was being built, most often in the graphics driver’s compiler; the details name the kernel and how long it took\.$/)
  assert.match(phone.steps[1], /^Restart: the city starts with a lighter kernel/)
  assert.equal(phone.restartHref, 'https://city.example/?map=region&kernel=lite')
  assert.equal(phone.webgpuLine, null)
  assert.equal(phone.openIn, null)
  assert.match(phone.detail, /the full kernel of the crowd .*\?kernel=lite/)
  assert.match(classify(lost, env(UA.ios26, { ...IPHONE, href })).steps[0], /^The iPhone’s GPU dropped out of the browser/)
  assert.match(classify(lost, env(UA.edgeWindows, { href })).steps[0], /most often the graphics driver’s compiler, sometimes the browser’s own GPU process/)
  // No address to carry the kernel (the env gave none): Restart reloads, and the page's memory carries it.
  assert.equal(classify(lost, env(UA.androidChrome, { touchPoints: 5 })).restartHref, null)
  // Asked for by the address already: the same card, but nothing restarts by itself (App.tsx reads `auto`).
  const asked = kernelLostFailure({ ...verdict, rung: 'narrow', saved: false }, { from: 'narrow', by: 'address' })
  assert.ok(asked instanceof KernelResetError && !asked.auto)
  assert.match(asked.message, /the full kernel at narrow workgroups of the crowd .* this browser kept no note of it for later visits \(no storage for this page\)\.$/)
  // A code that crossed from the worker without the page's verdict has no kernel to restart on: a plain reload.
  const bare = classify(coded('kernel-lost', 'crowd.wgsl: x'), env(UA.androidChrome, { touchPoints: 5, href }))
  assert.equal(bare.kind, 'kernel-lost')
  assert.equal(bare.restartHref, null)
  // Anything else on the error is not a kernel: never an address made of it.
  assert.equal(classify(Object.assign(err('kernel-lost'), { lighter: 'javascript:alert(1)' }), env(UA.chromeLinux, { href })).restartHref, null)
  assert.equal(classify(Object.assign(err('gpu-reset'), { lighter: 'lite' }), env(UA.chromeLinux, { href })).restartHref, null, 'only a kernel\'s loss restarts lighter')

  const none = kernelLostFailure({ rung: 'lite', next: 'none', saved: true, words: 'gone', elapsedMs: 2100, holdMs: 3_600_000 }, { from: 'lite', by: 'memory' })
  assert.ok(!(none instanceof KernelResetError), 'nothing lighter is left to restart on')
  assert.equal(none.code, 'kernel-none')
  const card = classify(none, env(UA.androidChrome, { touchPoints: 5, href }))
  assert.equal(card.headline, 'The crowd’s lightest kernel stopped this device’s graphics')
  assert.equal(card.restartHref, null, 'no kernel word in the address: Restart loads the page as it is, and the hold stops it')
  assert.ok(none instanceof KernelNoneError && none.kept)
  // The hold is kept and the address names a kernel (the page's own restart, or ?kernel=full by hand, which the hold
  // lets through): Restart goes to the address without the word, so it costs the GPU nothing.
  for (const word of ['kernel=full', 'kernel=lite']) {
    const there = classify(none, env(UA.androidChrome, { touchPoints: 5, href: `https://example.test/city/?crowd=512&${word}#x` }))
    assert.equal(there.restartHref, 'https://example.test/city/?crowd=512#x', word)
  }
  assert.equal(kernelFreeAddress('https://example.test/?a=1'), null)
  assert.equal(kernelFreeAddress(''), null)
  assert.equal(kernelFreeAddress('not an address'), null)
  // The browser kept nothing: the card says a restart asks the GPU again, and Restart is a plain reload.
  const unkept = kernelLostFailure({ rung: 'lite', next: 'none', saved: false, words: 'gone', elapsedMs: null, holdMs: 3_600_000 }, { from: 'lite', by: 'address' })
  assert.ok(unkept instanceof KernelNoneError && !unkept.kept)
  const bare2 = classify(unkept, env(UA.androidChrome, { touchPoints: 5, href: 'https://example.test/city/?kernel=lite' }))
  assert.equal(bare2.restartHref, null)
  assert.equal(bare2.steps[2], 'This browser keeps no note for this page, so Restart asks this GPU again, and each try stops the browser’s graphics in every tab. The console needs no GPU and still opens.')
  assert.match(bare2.detail, /This browser kept no note of it \(no storage for this page\), so a restart asks this GPU again\.$/)
  // A 'kernel-none' that came without its class (the bare code) is read as kept: the cautious words, a plain reload.
  assert.match(classify(err('kernel-none'), env(UA.androidChrome, { touchPoints: 5 })).steps[2], /^The city leaves this GPU alone/)
  assert.match(card.steps[1], /^Update Chrome and the phone’s system software/)
  assert.match(card.steps[2], /leaves this GPU alone for a while before it asks again \(the details say how long\): each try stops the browser’s graphics in every tab\. The console needs no GPU and still opens\.$/)
  assert.match(card.detail, /the light kernel of the crowd was being built, 2\.1 s after it was asked for \(gone\)\. That is the lightest kernel: none is left to ask this GPU for\. The city leaves this GPU alone for about an hour, then asks it for the light kernel once more; \?kernel=full in the address asks for everything again at once\.$/)
  assert.match(classify(none, env(UA.ios26, { ...IPHONE, href })).steps[1], /^Update the iPhone’s system software/)
  assert.match(classify(none, env(UA.edgeWindows, TAURI)).steps[1], /^Update the graphics driver and WebView2, then restart the app\.$/)
  // The start that asked nothing of the GPU (the memory still says 'none'): the same card, from the record's words.
  const memory: KernelMemory = { v: 1, sources: '0badf00d', ua: UA.androidChrome, adapter: 'arm / mali-g52', from: 'none', why: 'lost', rung: 'lite', words: 'gone', at: 1, strikes: 1 }
  const held = classify(kernelNoneFailure(memory, 60_000), env(UA.androidChrome, { touchPoints: 5, href }))
  assert.equal(held.kind, 'kernel-none')
  assert.match(held.detail, /^[A-Z].*\?kernel=full in the address asks for everything again at once\.$/)
  assert.match(held.steps[2], /^The city leaves this GPU alone/)
})

test('consoleTalks: the card says the console still talks to Sloane only where the app\'s runner carries a model ready to answer', () => {
  // What the runner says it carries, in wire.json's words (native/llm/tests/wire.json models): a file and a status.
  const wire = JSON.parse(readFileSync(new URL('../../native/llm/tests/wire.json', import.meta.url), 'utf8')) as { models: { file: string; status: { state: string } }[] }
  for (const m of wire.models) {
    const want = m.status.state === 'ready' || m.status.state === 'loaded' ? true : m.status.state === 'preparing' ? null : false
    assert.equal(consoleTalks(m), want, m.status.state)
  }
  assert.ok(wire.models.some((m) => consoleTalks(m) === true) && wire.models.some((m) => consoleTalks(m) === false), 'wire.json holds both')
  // None carried, no answer (a browser, a shell without the runner, a timeout: shellCarried answers null), or nonsense.
  for (const none of [null, undefined, 0, '', 'ready', {}, { file: '' , status: { state: 'ready' } }, { file: 'm.gguf' }, { file: 'm.gguf', status: null }, { file: 'm.gguf', status: { state: 'warming' } }, { status: { state: 'ready' } }]) {
    assert.equal(consoleTalks(none), false, JSON.stringify(none))
  }
  assert.equal(consoleTalks({ file: 'm.gguf', status: { state: 'preparing', done: 1, total: 4 } }), null, 'ask again while the app prepares it')
  assert.equal(consoleTalks({ file: 'm.gguf', status: { state: 'failed', reason: 'it would not load', refused: false } }), false, 'never claimed where it failed')
  // The router's kept settings (as router.ts reads them): auto, its default, or native leave the carried model to
  // answer; any other provider chosen does not (scripted never asks a model; a server or the gateway may not answer).
  const ready = { file: 'm.gguf', bytes: 1, status: { state: 'ready' } }
  for (const kept of [null, '', 'not json', 'null', '{}', '{"provider":"auto"}', '{"provider":"native"}', '{"provider":"nonsense"}', '{"provider":7}']) {
    assert.equal(consoleTalks(ready, kept), true, String(kept))
    assert.equal(keptLeavesApp(kept), true, String(kept))
  }
  for (const p of PROVIDERS.filter((x) => x !== 'auto' && x !== 'native')) {
    const kept = JSON.stringify({ v: 3, provider: p })
    assert.equal(consoleTalks(ready, kept), false, p)
    assert.equal(consoleTalks({ ...ready, status: { state: 'preparing', done: 1, total: 4 } }, kept), false, `${p}: not asked again either`)
  }
  // What the router keeps is what the card reads: a provider the router would not take is its default, auto.
  for (const p of [...PROVIDERS, 'nonsense']) {
    const kept = JSON.stringify({ provider: p })
    const router = createMindRouter({ fetch: async () => { throw new TypeError('fetch failed') }, store: { load: () => kept, save: () => {} } })
    const s = router.settings().provider
    assert.equal(keptLeavesApp(kept), s === 'auto' || s === 'native', `${p}: the router reads ${String(s)}`)
  }
  // One plain sentence that says how, true whichever provider auto finds first (it names the console, not the model).
  assert.match(CONSOLE_TALKS_LINE, /^This app carries Sloane's model, and the console talks to her without the city: open it, type operator unlock, then ask and your question\.$/)
})

