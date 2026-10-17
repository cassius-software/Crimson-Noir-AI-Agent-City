// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It turns whatever stopped the city into words for the player's own device: one pure
 * classifier for every boot failure (classify) and every halt (haltClass, explainHalt), read by the one recovery card
 * (RecoveryCard.tsx) and the lock screen in App.tsx. Errors carry codes where the code knows the class (gpuDevice.ts
 * for the page's GPU, the worker's SimFailureCode for WebGPU or WebAssembly inside the physics realm); the messages
 * the page has always shown are matched as well, so nothing that used to be explained is lost. The words follow the
 * device: Safari's own 'Version/NN' token (Safari 26 on iOS still reports the OS as 18_6), an app's built-in browser on
 * iPhone (no 'Safari/' token) or on Android ('; wv)'), Chrome, Firefox or Edge, Linux, the installed home-screen app
 * (display-mode standalone, or fullscreen on Android, which has no address bar to edit and no other browser to switch to) and the
 * Windows app (Tauri). The 'needs WebGPU' line appears only where WebGPU itself is what is missing. It also holds the
 * guard for the one automatic restart after a graphics reset in the background (autoReload) and the gate before a
 * first visit's onboarding (firstScreen). Pure: pageEnv() is the only reader of the browser, and the tests hand in
 * their own.
 * What breaks if it is removed? Every failure falls back to one raw message under a line that blames WebGPU, and the
 * lock screen blames a broken invariant for a routine GPU reset.
 */
import { BRAND } from '../brand.ts'
import type { BootStage } from './engine.ts'
import { nativeHost } from '../05_Observe_Environment/governor.ts'
import type { GpuProbe } from '../01_Initialize_World/gpuDevice.ts'

/** Every class of failure the card has words for. */
export type FailureKind =
  | 'insecure' | 'no-api' | 'no-adapter' | 'compat-only' | 'device' | 'worker-gpu' | 'wasm' | 'shader' | 'gpu-reset' | 'stalled'
  | 'realm-fault' | 'frame' | 'other'

/** What the card shows: a plain headline, the steps for this device, the WebGPU line or null, the raw message. */
export interface Failure {
  kind: FailureKind
  headline: string
  steps: string[]
  webgpuLine: string | null
  detail: string
  /** A browser that can run the city, one tap away (openInChrome): the card's first button. */
  openIn?: { label: string; href: string } | null
}

/** What the words depend on, read once from the page (pageEnv) or handed in by a test. */
export interface Env {
  ua: string
  /** window.isSecureContext. */
  secure: boolean
  /** The installed web app (installedApp: display-mode standalone, fullscreen on Android, iOS's navigator.standalone): no address bar. */
  standalone: boolean
  /** The Windows app (Tauri): no browser chrome at all. */
  native: boolean
  origin: string
  /** navigator.maxTouchPoints: an iPad asking for the desktop site reports a Mac with touch. */
  touchPoints: number
  /** The page's own address (location.href), for a button that opens it in another browser. */
  href?: string
}

/** The device and browser behind a user agent, as far as the words need them. */
export interface Platform {
  os: 'ios' | 'android' | 'mac' | 'windows' | 'linux' | 'chromeos' | 'other'
  browser: 'safari' | 'chrome' | 'edge' | 'firefox' | 'other'
  ipad: boolean
  /** iOS: Chrome, Firefox, Edge or Opera (Safari's engine under another name). */
  iosOther: boolean
  /** An app's built-in browser: on iOS no 'Safari/' token (and not the installed app), on Android '; wv)'. */
  inApp: boolean
  /** Safari's own version (its 'Version/NN' token), or null where the user agent has none. */
  safari: number | null
}

/** The line under the WebGPU classes: what runs the city (the card's line before this file, word for word). */
export const WEBGPU_LINE = `${BRAND.name} needs WebGPU: a current Chrome, Edge or Brave on desktop or Android, or Safari 26 on iPhone, iPad and Mac. The crowd simulation runs as WGSL compute and has no WebGL path.`

/** Which iPhones iOS 26 runs on: the ones that can have Safari 26. */
const IOS26 = 'iOS 26 runs on iPhone 11, iPhone SE (2nd generation) and newer'

const CODES: readonly FailureKind[] = ['insecure', 'no-api', 'no-adapter', 'compat-only', 'device', 'worker-gpu', 'wasm', 'shader', 'gpu-reset', 'stalled']

/** The messages the page has shown, matched when an error carries no code (first match wins). */
const KNOWN: readonly [RegExp, FailureKind][] = [
  [/inside the physics worker/, 'worker-gpu'],
  [/WebAssembly is not defined|Can't find variable: WebAssembly|WebAssembly is (?:turned off|disabled|not supported)|code generation (?:from strings )?disallowed/i, 'wasm'],
  [/does not expose WebGPU \(navigator\.gpu\)/, 'no-api'],
  [/WebGPU adapter unavailable; three\.js fell back to WebGL2|Unable to create WebGPU adapter|getSupportedExtensions/, 'no-adapter'],
  [/compatibility adapter/, 'compat-only'],
  [/refused a WebGPU device/, 'device'],
  [/sensing failed to start: no reading from the GPU/, 'stalled'],
  [/GPU device lost|device was lost/i, 'gpu-reset'],
  [/pipeline validation failed|failed WebGPU validation/, 'shader'],
  [/^(?:SYSTEM LOCKED: )?Physics realm fault/, 'realm-fault'],
]

/**
 * Pure. Whether the page runs as the installed web app. The manifest asks for display 'fullscreen' (tools/web/pwa.mjs):
 * Android honours it, iOS and the desktop install fall back to standalone. A desktop tab in the browser's own full
 * screen (F11) also matches display-mode fullscreen, and has an address bar to go back to, so fullscreen counts only on
 * Android, where a tab cannot go full screen that way.
 */
export function installedApp(m: { standalone: boolean; fullscreen: boolean; iosStandalone: boolean; ua: string }): boolean {
  return m.standalone || m.iosStandalone || (m.fullscreen && /Android/.test(m.ua))
}

/** The page's own environment (the one reader of the browser here; every value guarded for odd embeddings). */
export function pageEnv(): Env {
  const nav = (typeof navigator === 'undefined' ? {} : navigator) as Partial<Navigator> & { standalone?: unknown }
  const media = (q: string): boolean => {
    try { return typeof matchMedia === 'function' && matchMedia(q).matches } catch { return false }
  }
  return {
    ua: nav.userAgent ?? '',
    secure: typeof isSecureContext === 'boolean' ? isSecureContext : true,
    standalone: installedApp({ standalone: media('(display-mode: standalone)'), fullscreen: media('(display-mode: fullscreen)'), iosStandalone: nav.standalone === true, ua: nav.userAgent ?? '' }),
    native: nativeHost(globalThis),
    origin: typeof location === 'undefined' ? '' : location.origin,
    touchPoints: nav.maxTouchPoints ?? 0,
    href: typeof location === 'undefined' ? '' : location.href,
  }
}

/** Pure. The platform behind a user agent (iPads in desktop mode are Macs with touch points). */
export function platformOf(ua: string, touchPoints = 0, standalone = false): Platform {
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)
  const ios = ipad || /iPhone|iPod/.test(ua)
  const android = !ios && /Android/.test(ua)
  const os: Platform['os'] = ios ? 'ios' : android ? 'android' : /CrOS/.test(ua) ? 'chromeos' : /Windows NT/.test(ua) ? 'windows'
    : /Macintosh|Mac OS X/.test(ua) ? 'mac' : /Linux|X11/.test(ua) ? 'linux' : 'other'
  const iosOther = ios && /CriOS|FxiOS|EdgiOS|OPiOS|OPT\//.test(ua)
  const browser: Platform['browser'] = /Firefox\/|FxiOS/.test(ua) ? 'firefox' : /Edg\/|EdgA\/|EdgiOS/.test(ua) ? 'edge'
    : /SamsungBrowser\//.test(ua) ? 'other'
    : /Chrome\/|CriOS|Chromium\//.test(ua) ? 'chrome' : /Safari\//.test(ua) || (ios && !iosOther) ? 'safari' : 'other'
  const inApp = (ios && !standalone && !/Safari\//.test(ua)) || (android && /; wv\)/.test(ua))
  const v = /Version\/(\d+)/.exec(ua)
  const safari = v && (os === 'ios' || os === 'mac') && !iosOther && browser === 'safari' ? Number(v[1]) : null
  return { os, browser, ipad, iosOther, inApp, safari }
}

/** The message of whatever was thrown ('' for none). */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return error === null || error === undefined ? '' : String(error)
}

/** Pure. The class of a failure: its code when it carries one, else the message the page has always shown, else other. */
export function kindOf(error: unknown, env: Pick<Env, 'secure'>): FailureKind {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  let kind: FailureKind = CODES.includes(code as FailureKind) ? (code as FailureKind) : 'other'
  if (kind === 'other') {
    const m = messageOf(error)
    kind = KNOWN.find(([re]) => re.test(m))?.[1] ?? 'other'
  }
  // No WebGPU on an insecure page is the page's address, not the browser.
  return kind === 'no-api' && !env.secure ? 'insecure' : kind
}

/** Pure. The card for a boot failure (anything Engine.create, loadMap or the first frames threw), for this device. */
export function classify(error: unknown, env: Env): Failure {
  const kind = kindOf(error, env)
  const message = messageOf(error).trim()
  const p = platformOf(env.ua, env.touchPoints, env.standalone)
  return { ...words(kind, env, p), kind, detail: message || 'No message was given.', openIn: kind === 'no-api' ? openInChrome(env, p) : null }
}

/**
 * Pure. On Android, a browser without WebGPU (Firefox, Samsung Internet, an app's built-in browser, or a Custom Tab
 * of one, as a link tapped in another app opens) gets a button that hands this very address to Chrome: an intent:
 * link, which Android browsers pass to the app it names, falling back to Chrome's Play Store page where Chrome is
 * missing. Never in Chrome itself (Brave and Edge report as Chrome or Edge), the installed app or the Windows app,
 * and never without an http(s) address to hand over.
 */
export function openInChrome(env: Pick<Env, 'href' | 'standalone' | 'native'>, p: Platform): { label: string; href: string } | null {
  if (p.os !== 'android' || ((p.browser === 'chrome' || p.browser === 'edge') && !p.inApp) || env.standalone || env.native) return null
  const m = /^(https?):\/\/([^#]+)/.exec(env.href ?? '')
  if (!m) return null
  const store = encodeURIComponent('https://play.google.com/store/apps/details?id=com.android.chrome')
  return { label: 'Open in Chrome', href: `intent://${m[2]}#Intent;scheme=${m[1]};package=com.android.chrome;S.browser_fallback_url=${store};end` }
}

/** How a halt reads: a graphics reset, a physics realm fault, a frame loop that kept failing, or a real Ring-0 audit. */
export type HaltClass = 'gpu-reset' | 'realm-fault' | 'frame' | 'audit'

/** Prefix of the halt the engine makes when the page's own GPU device is lost (engine.ts). */
export const GRAPHICS_RESET = 'Graphics reset:'
/** Prefix of the halt App makes when the frame loop keeps throwing (App.tsx). */
export const FRAME_FAULT = 'Frame loop fault:'

/**
 * Pure. Sensing that stopped because the crowd's GPU device was lost (simCore.ts) and the page's own device lost
 * (engine.ts) are resets; a fault inside the physics worker (simHost.ts, simClient.ts, physics.worker.ts) is a realm
 * fault; App's frame-loop halt is a frame fault; everything else, whatever it says, keeps the Ring-0 audit's copy.
 */
export function haltClass(reason: string): HaltClass {
  if (reason.startsWith(GRAPHICS_RESET) || (reason.startsWith('Sensing Failure:') && reason.includes('GPU device lost'))) return 'gpu-reset'
  if (reason.startsWith('Physics realm fault')) return 'realm-fault'
  if (reason.startsWith(FRAME_FAULT)) return 'frame'
  return 'audit'
}

/** Pure. The card for a halt that is not an audit (haltClass): the city stopped, and restarts from the same seed. */
export function explainHalt(reason: string, env: Env): Failure {
  const c = haltClass(reason)
  const kind: FailureKind = c === 'audit' ? 'other' : c
  return { ...words(kind, env, platformOf(env.ua, env.touchPoints, env.standalone)), kind, detail: reason.trim() || 'No message was given.' }
}

/** The small copyable line under the card: the build, the adapter, the user agent. */
export function detailsLine(adapter: string, ua: string): string {
  return `${BRAND.name} ${BRAND.version} · ${adapter || 'adapter unknown'} · ${ua || 'user agent unknown'}`
}

/** The browser's own scheme for its internal pages (edge:// in Edge, chrome:// in Chrome and the browsers built on it). */
const flags = (p: Platform): string => (p.browser === 'edge' ? 'edge' : 'chrome')

/** Pure. The headline, steps and WebGPU line of a class, for this device. */
function words(kind: FailureKind, env: Env, p: Platform): Omit<Failure, 'kind' | 'detail'> {
  const phone = p.os === 'ios' || p.os === 'android'
  const device = p.ipad ? 'iPad' : 'iPhone'
  const iosUpdate = p.ipad
    ? 'Update in Settings > General > Software Update.'
    : `Update in Settings > General > Software Update (${IOS26}).`
  const again = env.standalone ? 'then open the app again' : 'then open the page again'
  const w = (headline: string, steps: string[], webgpu = false) => ({ headline, steps, webgpuLine: webgpu ? WEBGPU_LINE : null })
  switch (kind) {
    case 'insecure':
      return w('This page needs a secure address', [
        `It was opened over plain http${env.origin ? ` (${env.origin})` : ''}, and browsers turn WebGPU on only for https:// pages and for localhost.`,
        env.standalone
          ? (p.os === 'ios'
            ? 'This app was added to the Home Screen from that address: delete it, open the https:// address in Safari and add it to the Home Screen again.'
            : 'This app was installed from that address: uninstall it and install it again from its https:// address.')
          : 'Open the same page over https:// (with a certificate this device trusts), or on the computer that serves it at http://localhost.',
      ])
    case 'no-api':
      if (env.native) {
        return w('This app’s WebView2 has no WebGPU', [
          `${BRAND.name} draws with WebGPU through Microsoft Edge WebView2.`,
          'Update WebView2 (Windows Update) and the graphics driver, then restart the app.',
        ], true)
      }
      if (p.os === 'ios') {
        if (p.inApp) {
          return w('Open this page in Safari', [
            'This is an app’s built-in browser, and it has no WebGPU.',
            'Use the app’s menu (often ••• or the share button) and choose Open in Safari, or copy the link into Safari.',
            `Safari has WebGPU from iOS 26 (${IOS26}).`,
          ], true)
        }
        if (p.iosOther) {
          return w('Open this page in Safari', [
            `This browser doesn’t offer WebGPU on this ${device}.`,
            'Open the page in Safari (the share button, then Open in Safari, or copy the link).',
            `Safari has WebGPU from iOS 26 (${IOS26}).`,
          ], true)
        }
        if (p.safari !== null && p.safari >= 26) {
          return w('WebGPU is turned off in Safari', [
            'Safari 26 has WebGPU on unless something turned it off.',
            'Lockdown Mode turns it off: Settings > Privacy & Security > Lockdown Mode, then exclude this site.',
            'Or check Settings > Apps > Safari > Advanced > Feature Flags > WebGPU.',
          ], true)
        }
        return w(`This ${device} needs ${p.ipad ? 'iPadOS 26' : 'iOS 26'}`, [
          p.safari !== null ? `Safari ${p.safari} doesn’t turn WebGPU on; Safari 26, which comes with iOS 26, does.` : `${BRAND.name} draws with WebGPU, which Safari turns on from iOS 26.`,
          `${iosUpdate.replace(/\.$/, '')}, ${again}.`,
          ...(p.safari === null ? ['Already on iOS 26? Lockdown Mode turns WebGPU off: Settings > Privacy & Security > Lockdown Mode.'] : []),
        ], true)
      }
      if (p.os === 'android') {
        if (p.inApp) {
          return w('Open this page in Chrome', [
            'This is an app’s built-in browser, and it has no WebGPU.',
            'Use the app’s menu (often ⋮) and choose Open in Chrome, or Open in browser.',
          ], true)
        }
        return w(env.standalone || p.browser === 'chrome' ? 'Update Chrome' : 'Open this page in Chrome', [
          'This browser has no WebGPU here.',
          env.standalone
            ? 'Update Chrome (and Android) from the Play Store, then open the app again. WebGPU needs Android 12 or newer.'
            : 'Update Chrome from the Play Store and open the page in it. WebGPU needs Android 12 or newer.',
        ], true)
      }
      if (p.browser === 'firefox') {
        return w('This Firefox has WebGPU off', [
          p.os === 'linux'
            ? 'Firefox on Linux keeps WebGPU behind a setting: open about:config, set dom.webgpu.enabled to true, then restart Firefox.'
            : 'Update Firefox (it has WebGPU on Windows, and on Macs with Apple silicon), or set dom.webgpu.enabled to true in about:config.',
          'Or open the page in Chrome or Edge.',
        ], true)
      }
      if (p.os === 'mac' && p.browser === 'safari') {
        return p.safari !== null && p.safari >= 26
          ? w('WebGPU is turned off in Safari', [
            'Safari 26 has WebGPU on unless something turned it off.',
            'Check Safari > Settings > Advanced > Feature Flags > WebGPU, and that Lockdown Mode is off for this site.',
          ], true)
          : w('This Mac needs Safari 26', [
            `Safari${p.safari !== null ? ` ${p.safari}` : ''} doesn’t turn WebGPU on; Safari 26 does.`,
            'Update in System Settings > General > Software Update, or open the page in Chrome.',
          ], true)
      }
      return w('This browser has no WebGPU', [
        env.standalone
          ? 'Update the browser this app was installed from, then open the app again.'
          : 'Open the page in a current Chrome, Edge or Brave (desktop or Android), or in Safari 26 (iPhone, iPad, Mac).',
      ], true)
    case 'no-adapter':
      if (env.native) {
        return w('No graphics adapter for WebGPU', [
          'Windows gave the app’s WebView2 no GPU for WebGPU.',
          'Update the graphics driver and WebView2 (Windows Update), then restart the app.',
        ], true)
      }
      if (p.os === 'ios') {
        return w('No graphics adapter for WebGPU', [
          'Safari has WebGPU but gave this page no GPU, which happens after a graphics reset or when memory is short.',
          env.standalone ? 'Close the app in the App Switcher and open it again.' : 'Close the tab, or close Safari in the App Switcher, and open the page again.',
          `If it keeps happening, restart the ${device}.`,
        ], true)
      }
      if (p.os === 'android') {
        return w('No graphics adapter for WebGPU', [
          'Chrome has WebGPU, but not for this phone’s GPU or its driver.',
          'Update Chrome and Android; some phones aren’t supported yet.',
        ], true)
      }
      if (p.browser === 'firefox') {
        return w('No graphics adapter for WebGPU', [
          'Firefox has WebGPU but offered no GPU for it.',
          'Update the graphics driver, or open the page in Chrome or Edge.',
        ], true)
      }
      if (p.os === 'linux' && (p.browser === 'chrome' || p.browser === 'edge')) {
        const f = flags(p)
        return w('No graphics adapter for WebGPU', [
          'The browser has WebGPU but offered no GPU for it, as Linux builds often do until Vulkan is on.',
          `Open ${f}://gpu and look for “WebGPU: Hardware accelerated”.`,
          `If it isn’t, turn on ${f}://flags/#enable-unsafe-webgpu and ${f}://flags/#enable-vulkan, then restart the browser.`,
          'On NixOS the browser also needs the Vulkan driver: hardware.graphics.enable = true.',
        ], true)
      }
      return w('No graphics adapter for WebGPU', [
        'The browser has WebGPU but offered no GPU for it.',
        'Turn on hardware acceleration in the browser’s settings (“Use graphics acceleration when available”), update the graphics driver, then restart the browser.',
        'After repeated GPU crashes a browser can pause graphics for a site; closing and reopening the browser clears it.',
      ], true)
    case 'compat-only':
      return w('This GPU offers only a reduced WebGPU', [
        'The browser offers WebGPU here only in its compatibility mode, and the city’s crowd needs full WebGPU.',
        p.os === 'android' ? 'Update Android and Chrome; on some phones the GPU driver can’t do more.'
          : env.native ? 'Update the graphics driver and WebView2, then restart the app.' : 'Update the graphics driver and the browser, or play on another device.',
      ], true)
    case 'device':
      return w('The GPU refused to start WebGPU', [
        'The browser found the GPU but couldn’t open it, which happens when it is busy, out of memory or resetting.',
        phone ? 'Close other apps, then restart.' : env.native ? 'Close other programs that use the GPU heavily, then restart.' : 'Close other heavy tabs or programs, then restart.',
      ])
    case 'worker-gpu':
      return w('WebGPU works here, but not in the background worker', [
        'The city’s crowd runs on WebGPU in a background worker, and this browser offers WebGPU only on the page itself.',
        p.os === 'ios' ? `Update to the newest ${p.ipad ? 'iPadOS' : 'iOS'} (Settings > General > Software Update), ${again}.`
          : env.native ? 'Update WebView2 and the graphics driver, then restart the app.'
            : p.browser === 'firefox' ? 'Open the page in Chrome or Edge.'
              : env.standalone ? 'Update the browser this app was installed from, then open the app again.' : 'Update the browser, or open the page in a current Chrome or Edge.',
      ], true)
    case 'wasm':
      return w('WebAssembly is turned off', [
        'The city’s physics runs as WebAssembly, which this browser has switched off.',
        p.os === 'ios' ? 'Lockdown Mode turns it off: Settings > Privacy & Security > Lockdown Mode, then exclude this site.'
          : p.os === 'mac' ? 'Lockdown Mode turns it off: System Settings > Privacy & Security > Lockdown Mode, then exclude this site.'
            : 'Allow WebAssembly for this site, or turn off the security setting or extension that blocks it.',
      ])
    case 'shader':
      return w('The browser couldn’t build the city’s graphics', [
        'Its WebGPU rejected part of the city’s drawing or the crowd’s shader (the details are below).',
        env.native ? 'Update WebView2 and the graphics driver, then restart the app.'
          : env.standalone ? 'Update the browser this app was installed from, then open the app again.'
            : 'Update the browser; a current Chrome or Edge, or Safari 26, runs the city.',
      ])
    case 'gpu-reset':
      return w('The graphics device was reset', [
        phone ? `The ${p.os === 'ios' ? device : 'phone'} reset its GPU or took its memory back, often while the app was in the background.`
          : 'The GPU was reset: a driver reset, or a crash in the browser’s GPU process.',
        'Restart: the city comes back from the same seed.',
        `If it keeps happening, close ${env.native || env.standalone ? 'the app' : 'the browser'} completely and open it again.`,
      ])
    case 'stalled':
      return w('The city took too long to start', [
        'The GPU didn’t send the crowd’s first reading in time: a slow or busy GPU, or the page was in the background while it started.',
        'Restart, and keep the page in front until the city appears.',
      ])
    case 'realm-fault':
      return w('The city’s physics stopped', [
        'The physics worker stopped, usually because the device took its memory back or the graphics were reset.',
        'Restart: the city comes back from the same seed.',
      ])
    case 'frame':
      return w('The city stopped drawing', [
        'The same error came back on every frame, so the city stopped.',
        'Restart. If it happens again, the details below say what failed.',
      ])
    default:
      return w(`${BRAND.name} couldn’t start`, [
        'Something went wrong while the city was starting; the details are below.',
        'Restart. If it happens again, open the console instead (it needs no GPU), or send the details line below with a bug report.',
      ])
  }
}

/**
 * Pure. The boot veil's visible waiting time after one more tick (BootVeil.tsx): the tick's interval when the page was
 * visible, capped at two ticks so a suspended page's long gap is not counted, and nothing when it was hidden.
 */
export function waitedFor(waited: number, intervalMs: number, hidden: boolean, tickMs = 1000): number {
  return hidden ? waited : waited + Math.min(Math.max(0, intervalMs), 2 * tickMs)
}

/** The shortest gap between two automatic restarts after a graphics reset in the background, ms. */
export const AUTO_RELOAD_GAP_MS = 120_000
/** Where the time of the last automatic restart is kept (localStorage; across relaunches of the installed app too). */
export const AUTO_RELOAD_KEY = 'civic-simulation:gpu-reload:v1'

/**
 * Pure. Whether a graphics reset restarts the page by itself once the page is visible again: only when it happened
 * while the page was hidden (the player was elsewhere and only finds the city again), only when the time of the last
 * such restart can be kept (a browser that refuses storage could loop), and at most once per AUTO_RELOAD_GAP_MS.
 */
export function autoReload(o: { lastMs: number | null; nowMs: number; hiddenAtLoss: boolean; storageOk: boolean }): boolean {
  if (!o.hiddenAtLoss || !o.storageOk) return false
  return o.lastMs === null || !Number.isFinite(o.lastMs) || o.nowMs - o.lastMs >= AUTO_RELOAD_GAP_MS
}

/**
 * Pure. What a page with no `?boot=tty` shows first: the onboarding only for a first visit whose browser can run the
 * city (the quick probe: a secure page, navigator.gpu, a core adapter), the recovery card when it cannot, the splash
 * while the probe runs, and the city for everyone else (createRenderer checks the same things there).
 */
export function firstScreen(o: { onboard: boolean; probe: GpuProbe | null }): 'city' | 'probing' | 'card' | 'onboarding' {
  if (!o.onboard) return 'city'
  if (o.probe === null) return 'probing'
  return o.probe.ok ? 'onboarding' : 'card'
}

/**
 * What the boot veil's 'Still starting' line says the city is doing (engine.ts BootStage, and App's own steps around
 * it): the shaders are the long step on a phone, and a line that names the step tells a slow phone from a stopped boot.
 */
export const BOOT_STAGE: Readonly<Record<BootStage | 'probe' | 'map' | 'crowd', string>> = Object.freeze({
  probe: 'checking this browser’s graphics',
  map: 'loading the map',
  gpu: 'asking for the graphics device',
  world: 'building the city',
  physics: 'starting the physics',
  shaders: 'preparing the shaders (the long step on a phone)',
  frame: 'drawing the first frame',
  crowd: 'waiting for the crowd',
})
