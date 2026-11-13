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
 * guard for the one automatic restart after a graphics reset in the background (autoReload), the gate before a
 * first visit's onboarding (firstScreen), and the times the page saw the browser's GPU process go (the browser
 * counts them too, and after two in two minutes hands the page no GPU for a while: gpuPaused). Pure, but for four
 * guarded readers of the browser the tests replace or leave out: pageEnv, pageBuild, and the loss times' own store
 * (recentGpuLosses, noteGpuLoss).
 * What breaks if it is removed? Every failure falls back to one raw message under a line that blames WebGPU, and the
 * lock screen blames a broken invariant for a routine GPU reset.
 */
import { BRAND } from '../brand.ts'
import type { BootStage } from './engine.ts'
import { nativeHost } from '../05_Observe_Environment/governor.ts'
import type { GpuProbe } from '../01_Initialize_World/gpuDevice.ts'
import { crowdKernelOf, type CrowdKernel } from '../03_Spawn_Agents/crowdSensor.ts'
import { KERNEL_MEMORY_KEY, lostBefore } from '../03_Spawn_Agents/crowdKernelMemory.ts'

/** Every class of failure the card has words for. */
export type FailureKind =
  | 'insecure' | 'no-api' | 'no-adapter' | 'compat-only' | 'device' | 'worker-gpu' | 'wasm' | 'shader' | 'compiler' | 'gpu-reset' | 'kernel-lost' | 'kernel-none'
  | 'gpu-paused' | 'stalled' | 'realm-fault' | 'frame' | 'other'

/** What the card shows: a plain headline, the steps for this device, the WebGPU line or null, the raw message. */
export interface Failure {
  kind: FailureKind
  headline: string
  steps: string[]
  webgpuLine: string | null
  detail: string
  /** A browser that can run the city, one tap away (openInChrome): the card's first button. */
  openIn?: { label: string; href: string } | null
  /**
   * Where Restart goes instead of loading the same address again: the page with the lighter crowd kernel asked for
   * (kernelAddress), after a kernel took the GPU down; or, once no kernel is left and the browser holds that, the
   * page without the kernel's word (kernelFreeAddress). Absent or null: Restart reloads the page as it is.
   */
  restartHref?: string | null
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
  /**
   * The browser's own name where it says (appName: Brave sends Chrome's user agent on Android; Edge adds its own EdgA
   * token), so the steps name the app the player has open. '': the browser's client hints name no app (a build of
   * Chromium, or a fork that keeps its name to itself), so it is not Chrome either, and the steps say "this browser".
   * Absent or null: no client hints, and the user agent names it.
   */
  app?: string | null
  /** A crowd kernel took this browser's GPU down on an earlier visit, seen in front (crowdKernelMemory.ts lostBefore). */
  gpuLostHere?: boolean
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

const CODES: readonly FailureKind[] = ['insecure', 'no-api', 'no-adapter', 'compat-only', 'device', 'worker-gpu', 'wasm', 'shader', 'compiler', 'gpu-reset', 'kernel-lost', 'kernel-none', 'gpu-paused', 'stalled']

/** The messages the page has shown, matched when an error carries no code (first match wins). */
const KNOWN: readonly [RegExp, FailureKind][] = [
  [/inside the physics worker/, 'worker-gpu'],
  [/WebAssembly is not defined|Can't find variable: WebAssembly|WebAssembly is (?:turned off|disabled|not supported)|code generation (?:from strings )?disallowed/i, 'wasm'],
  [/does not expose WebGPU \(navigator\.gpu\)/, 'no-api'],
  [/WebGPU adapter unavailable; three\.js fell back to WebGL2|Unable to create WebGPU adapter|getSupportedExtensions/, 'no-adapter'],
  [/compatibility adapter/, 'compat-only'],
  [/refused a WebGPU device/, 'device'],
  [/sensing failed to start: no reading from the GPU/, 'stalled'],
  // The browser's words for work that died with its GPU process (Chrome: a scope popped, a pipeline pending): the same
  // reset, whoever was holding the device.
  [/GPU device lost|device was lost|Instance dropped|external Instance reference no longer exists/i, 'gpu-reset'],
  // The GPU's own shader compiler refused a kernel WebGPU had accepted (gpuPipelines.ts: an internal error, with the
  // driver's words): not the browser's doing, so not the browser's words.
  [/pipeline compilation failed|refused by the GPU's own compiler/, 'compiler'],
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
    app: appName((nav as { userAgentData?: { brands?: unknown } }).userAgentData?.brands, typeof (nav as { brave?: unknown }).brave === 'object' && (nav as { brave?: unknown }).brave !== null),
    gpuLostHere: gpuLostHere(),
  }
}

/**
 * Pure. The browser's own name: Brave where it says so itself (navigator.brave), else the first brand of its client
 * hints that is not the engine's or a placeholder ('Google Chrome' reads Chrome, 'Microsoft Edge' reads Edge). ''
 * where the hints name no app (Google Chrome always names itself, so that browser is not Chrome); null where there
 * are no client hints at all (Safari, Firefox), and the user agent has to say.
 */
export function appName(brands: unknown, brave: boolean): string | null {
  if (brave) return 'Brave'
  if (!Array.isArray(brands)) return null
  for (const b of brands) {
    const raw = b && typeof b === 'object' ? (b as { brand?: unknown }).brand : undefined
    const name = typeof raw === 'string' ? raw.replace(/[^\x20-\x7e]/g, '').trim() : ''
    if (!name || /^chromium$/i.test(name) || /not.{0,3}a.{0,3}brand/i.test(name)) continue
    // Opera for Android names itself OperaMobile in its hints; Android lists the app as Opera.
    const plain = name.replace(/^(?:Google|Microsoft) /, '')
    return (plain === 'OperaMobile' ? 'Opera' : plain).slice(0, 24)
  }
  return ''
}

/**
 * Whether a crowd kernel took this browser's GPU down on an earlier visit (Env.gpuLostHere). Only the kernel record
 * counts: the loss times the page notes (recentGpuLosses) include the phone taking the GPU back from an app in the
 * background and another tab's crash, which are not the crowd's. Never throws.
 */
function gpuLostHere(): boolean {
  try {
    return lostBefore(localStorage.getItem(KERNEL_MEMORY_KEY))
  } catch {
    return false
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
  const lighter = kind === 'kernel-lost' && typeof error === 'object' && error !== null ? crowdKernelOf((error as { lighter?: unknown }).lighter) : null
  // No kernel left: whether the browser holds the record that leaves the GPU alone (crowdKernelMemory.ts
  // KernelNoneError.kept). Held, Restart goes to the address without ?kernel= (the word that asked for a kernel, by
  // hand or by the page's own restart), where the hold stops the start before any GPU is asked for.
  const kept = kind !== 'kernel-none' || !(typeof error === 'object' && error !== null && (error as { kept?: unknown }).kept === false)
  // No adapter: what the page's own WebGL2 said at that moment (gpuDevice.ts NoAdapterError), null where unknown.
  const said = kind === 'no-adapter' && typeof error === 'object' && error !== null ? (error as { webgl?: unknown }).webgl : null
  const webgl = typeof said === 'boolean' ? said : null
  return {
    ...words(kind, env, p, kept, webgl), kind, detail: message || 'No message was given.',
    // An Android app's built-in browser is sent to Chrome with the button whether it has no WebGPU or no adapter.
    openIn: kind === 'no-api' || (kind === 'no-adapter' && p.os === 'android' && p.inApp) ? openInChrome(env, p) : null,
    restartHref: lighter ? kernelAddress(env.href ?? '', lighter) : kind === 'kernel-none' && kept ? kernelFreeAddress(env.href ?? '') : null,
  }
}

/**
 * Pure. The page's address with the crowd kernel asked for (?kernel=): where a start after a kernel took the GPU down
 * goes, by the card's Restart or by itself (App.tsx), so the lighter kernel is asked for even where the browser kept
 * no record. Null for an address that cannot carry it (none, or not one a URL parses).
 */
export function kernelAddress(href: string, kernel: CrowdKernel): string | null {
  if (!href) return null
  try {
    const url = new URL(href)
    url.searchParams.set('kernel', kernel)
    return url.toString()
  } catch {
    return null
  }
}

/**
 * Pure. The page's address without the crowd kernel's word: where Restart goes once no kernel is left and the browser
 * holds the record that says so, so a restart is stopped by the hold instead of asking the GPU for the kernel the
 * address names. Null where the address has no such word (Restart then loads the page as it is) or cannot be parsed.
 */
export function kernelFreeAddress(href: string): string | null {
  if (!href) return null
  try {
    const url = new URL(href)
    if (!url.searchParams.has('kernel')) return null
    url.searchParams.delete('kernel')
    return url.toString()
  } catch {
    return null
  }
}

/**
 * Pure. On Android, a browser without WebGPU (Firefox, Samsung Internet, an app's built-in browser, or a Custom Tab
 * of one, as a link tapped in another app opens) gets a button that hands this very address to Chrome: an intent:
 * link, which Android browsers pass to the app it names (Chrome comes with almost every Android phone; where it is
 * missing the tap does nothing and the card's words still say to install it: no store address is named here, the
 * page names no address off this machine, airgap.test.ts). Never in Chrome itself (Brave and Edge report as Chrome
 * or Edge), the installed app or the Windows app, and never without an http(s) address to hand over.
 */
export function openInChrome(env: Pick<Env, 'href' | 'standalone' | 'native'>, p: Platform): { label: string; href: string } | null {
  if (p.os !== 'android' || ((p.browser === 'chrome' || p.browser === 'edge') && !p.inApp) || env.standalone || env.native) return null
  const m = /^(https?):\/\/([^#]+)/.exec(env.href ?? '')
  if (!m) return null
  return { label: 'Open in Chrome', href: `intent://${m[2]}#Intent;scheme=${m[1]};package=com.android.chrome;end` }
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

/** The name of the meta the web copy's head carries (tools/web/pwa.mjs BUILD_META): which published build this page is. */
export const BUILD_META = 'agent-city-build'

/**
 * The published build this page is, where it says (the web copy: its build word, twelve hex digits over everything
 * published, tools/web/pwa.mjs buildWord; the same that name its offline cache), '' anywhere else (a file, the
 * Windows app, a local preview). Guarded: no document, no word.
 */
export function pageBuild(): string {
  try {
    const word = typeof document === 'undefined' ? null : document.querySelector(`meta[name="${BUILD_META}"]`)?.getAttribute('content')
    return word && /^[0-9a-f]{6,64}$/.test(word) ? word : ''
  } catch {
    return ''
  }
}

/**
 * The small copyable line under the card: the build (with the web copy's own build word, so a screenshot says which
 * published build a phone was running: its offline copy can be a build behind), the adapter, the user agent, and
 * what the browser says of the device itself where it does (deviceHints).
 */
export function detailsLine(adapter: string, ua: string, build = '', hints = ''): string {
  return `${BRAND.name} ${BRAND.version}${build ? ` (web build ${build})` : ''} · ${adapter || 'adapter unknown'} · ${ua || 'user agent unknown'}${hints ? ` · ${hints}` : ''}`
}

/** The part of navigator.userAgentData read here (Chrome and Edge have it; Safari and Firefox do not). */
export interface UaData { getHighEntropyValues?(hints: string[]): Promise<Record<string, unknown>> }

/**
 * What the browser says of the device beyond its user agent: the system and its real version, the model, the
 * browser's full version. Chrome on Android writes 'Android 10; K' and a version of zeroes into every user agent,
 * whatever the phone, so a details line with only that names neither the phone nor its Android. For the card's
 * details, where the player may copy it into a bug report: it stays on the page like everything else. '' where the
 * browser has no such API, refuses, or throws.
 */
export async function deviceHints(data: UaData | null | undefined): Promise<string> {
  if (!data || typeof data.getHighEntropyValues !== 'function') return ''
  try {
    const v = await data.getHighEntropyValues(['platform', 'platformVersion', 'model', 'fullVersionList'])
    const word = (x: unknown): string => (typeof x === 'string' ? x.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 60) : '')
    const brands = (Array.isArray(v.fullVersionList) ? v.fullVersionList : [])
      .map((b: unknown) => (b && typeof b === 'object' ? { brand: word((b as { brand?: unknown }).brand), version: word((b as { version?: unknown }).version) } : { brand: '', version: '' }))
      .filter((b) => b.brand && b.version && !/not.{0,3}a.{0,3}brand/i.test(b.brand))
    // The browser's own name where it gives one (Google Chrome, Microsoft Edge), else the engine's.
    const browser = brands.find((b) => b.brand !== 'Chromium') ?? brands[0]
    return [[word(v.platform), word(v.platformVersion)].filter(Boolean).join(' '), word(v.model), browser ? `${browser.brand} ${browser.version}` : ''].filter(Boolean).join(' · ')
  } catch {
    return ''
  }
}

/** The browser's own scheme for its internal pages (edge:// in Edge, chrome:// in Chrome and the browsers built on it). */
const flags = (p: Platform): string => (p.browser === 'edge' ? 'edge' : 'chrome')

/** Pure. The headline, steps and WebGPU line of a class, for this device. */
/**
 * Lockdown Mode (WebGPU and WebAssembly off) on an iPhone or iPad. A site is excluded from Safari's own page menu
 * (Settings only lists the sites already excluded); the home-screen app has no page menu, so only the switch itself.
 */
function iosLockdown(standalone: boolean): string {
  return standalone
    ? 'Lockdown Mode turns it off: turn it off in Settings > Privacy & Security > Lockdown Mode, then open the app again.'
    : 'Lockdown Mode turns it off: in Safari tap the page menu beside the address, then Website Settings, and turn Lockdown Mode off for this site, or turn it off in Settings > Privacy & Security > Lockdown Mode.'
}

/** Lockdown Mode on a Mac: per site in Safari's own settings for the website, or the switch in System Settings. */
const MAC_LOCKDOWN = 'Lockdown Mode turns it off in Safari: choose Safari > Settings for This Website and untick Enable Lockdown Mode, or turn it off in System Settings > Privacy & Security > Lockdown Mode.'

/**
 * The app the player has open, by name: its own (Env.app), else as its user agent reads; '' where neither names it
 * (the hints name no app, or a user agent the city does not know), and the card says "this browser".
 */
function browserName(env: Env, p: Platform): string {
  if (typeof env.app === 'string') return env.app
  if (/SamsungBrowser\//.test(env.ua)) return 'Samsung Internet'
  return p.browser === 'edge' ? 'Edge' : p.browser === 'chrome' ? 'Chrome' : p.browser === 'firefox' ? 'Firefox' : ''
}

/**
 * Android with no adapter. Chrome's own code gives a page no adapter on Android when: the page lost the GPU process
 * twice within two minutes (the 'gpu-paused' card); the browser hands the page no GPU at all after its graphics
 * crashed (WebGL is refused as well); WebGPU alone is held back, by the browser's list of GPUs it keeps WebGPU from
 * (which Google can change without an update) or under Android's Advanced Protection, where Chrome turns WebGPU off.
 * The page's own WebGL answer (`webgl`) tells the middle one from the last two. Closing the browser clears whatever a
 * crash left behind, so that comes first; Advanced Protection and "built on Chromium" are said only to a browser that
 * is not Firefox; the installed app is never sent to another browser; a browser with no name is "this browser".
 */
function androidNoAdapter(env: Env, p: Platform, webgl: boolean | null, again: string) {
  const name = browserName(env, p)
  const gecko = p.browser === 'firefox'
  const It = name || 'This browser'
  const it = name || 'this browser'
  const others = ['Chrome', 'Brave', 'Edge'].filter((b) => b !== name).slice(0, 2).join(' or ')
  const other = env.standalone ? '' : gecko ? 'open the page in Chrome or Brave' : `open the page in another browser built on Chromium, such as ${others}`
  const before = env.gpuLostHere ? [`The city’s crowd took this phone’s GPU down in ${it} on an earlier visit.`] : []
  const stop = name
    ? `Close ${name} completely (Settings > Apps > ${name} > Force stop), ${again}.`
    : `Close this browser completely (in Settings > Apps, choose it, then Force stop), ${again}.`
  if (webgl === false) {
    return {
      headline: `${It} is giving this page no GPU`,
      steps: [...before, `${It} hands this page no GPU at all, not even for WebGL, as a browser can after its graphics crashed, until it is closed.`, stop, `Still nothing: restart the phone${other ? `, or ${other}` : ''}.`],
    }
  }
  const last = gecko
    ? (other ? `Still none: ${other}.` : 'Still none: restart the phone.')
    : `Still none: under Android’s Advanced Protection (Settings > Security & privacy > Advanced Protection) Chrome and the browsers built on it turn WebGPU off, and ${it} can keep it from a GPU on its own list${other ? `; ${other}` : ''}.`
  return {
    headline: 'No graphics adapter for WebGPU',
    steps: [
      ...before,
      webgl ? `${It} still gives this page WebGL but holds WebGPU back.` : `${It} has WebGPU but gave this page no GPU for it.`,
      stop,
      last,
    ],
  }
}

function words(kind: FailureKind, env: Env, p: Platform, kept = true, webgl: boolean | null = null): Omit<Failure, 'kind' | 'detail'> {
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
            iosLockdown(env.standalone),
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
        if (p.inApp) {
          return w('Open this page in Chrome', [
            'This is an app’s built-in browser, and it gave this page no GPU for WebGPU.',
            'Use the app’s menu (often ⋮) and choose Open in Chrome, or Open in browser.',
          ], true)
        }
        const a = androidNoAdapter(env, p, webgl, again)
        return w(a.headline, a.steps, true)
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
        p.os === 'ios' ? iosLockdown(env.standalone)
          : p.os === 'mac' && p.browser === 'safari' ? MAC_LOCKDOWN
            : 'Allow WebAssembly for this site, or turn off the security setting or extension that blocks it.',
      ])
    case 'shader':
      return w('The browser couldn’t build the city’s graphics', [
        'Its WebGPU rejected part of the city’s drawing or the crowd’s shader (the details are below).',
        env.native ? 'Update WebView2 and the graphics driver, then restart the app.'
          : env.standalone ? 'Update the browser this app was installed from, then open the app again.'
            : 'Update the browser; a current Chrome or Edge, or Safari 26, runs the city.',
      ])
    case 'compiler':
      return w('This device’s graphics driver couldn’t build the crowd', [
        'The browser’s WebGPU accepted the crowd’s shader, but the GPU’s own compiler refused to build it; its words are in the details, with the kernel it refused.',
        // Every browser on iOS is WebKit, and its graphics come with the system: there is no Chrome there to update.
        p.os === 'ios'
          ? `Update the ${device}’s system software (Safari’s graphics come with it), ${again}.`
          : phone
            ? `Update ${p.browser === 'chrome' || env.standalone ? 'Chrome' : 'the browser'} and the phone’s system software (the graphics driver comes with it), ${again}.`
            : env.native ? 'Update the graphics driver and WebView2, then restart the app.' : 'Update the graphics driver and the browser, then open the page again.',
        // A start may begin on the light kernel (the address, a record, a GPU family that starts there): nothing heavier was tried then.
        'Where the city started higher, it also tried narrower workgroups and its lighter kernel; the details name each refusal.',
      ])
    case 'kernel-lost':
      // Said as what the page saw, not as the driver's fault for certain: the browser's own watchdog, or the system
      // short of memory, end the GPU process the same way. The details carry the kernel and how long it took.
      return w('The browser’s graphics stopped while building the crowd', [
        phone
          ? `The ${p.os === 'ios' ? device : 'phone'}’s GPU dropped out of the browser while the crowd’s kernel was being built, most often in the graphics driver’s compiler; the details name the kernel and how long it took.`
          : 'The GPU dropped out of the browser while the crowd’s kernel was being built: most often the graphics driver’s compiler, sometimes the browser’s own GPU process; the details name the kernel and how long it took.',
        'Restart: the city starts with a lighter kernel for the crowd, which asks less of the driver.',
      ])
    case 'kernel-none':
      return w('The crowd’s lightest kernel stopped this device’s graphics', [
        'The crowd’s lightest kernel took the GPU out of the browser, on this start or an earlier one, so no lighter kernel is left to ask it for; the details say which kernels were lost and when.',
        p.os === 'ios'
          ? `Update the ${device}’s system software (Safari’s graphics come with it), ${again}.`
          : phone
            ? `Update ${p.browser === 'chrome' || env.standalone ? 'Chrome' : 'the browser'} and the phone’s system software (the graphics driver comes with it), ${again}.`
            : env.native ? 'Update the graphics driver and WebView2, then restart the app.' : 'Update the graphics driver and the browser, then open the page again.',
        kept
          ? 'The city leaves this GPU alone for a while before it asks again (the details say how long): each try stops the browser’s graphics in every tab. The console needs no GPU and still opens.'
          : 'This browser keeps no note for this page, so Restart asks this GPU again, and each try stops the browser’s graphics in every tab. The console needs no GPU and still opens.',
      ])
    case 'gpu-paused':
      return w('The browser has paused graphics for this page', [
        'The GPU was lost twice within two minutes, and after that the browser hands this page no GPU for a while: until two minutes after the first loss.',
        'Wait two minutes, then restart. Restarting sooner changes nothing.',
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

/** Where the times the page saw the browser's GPU process go are kept: localStorage, as the process serves every tab of the site. */
export const GPU_LOSSES_KEY = 'civic-simulation:gpu-losses:v1'
/**
 * Chrome's own rule, measured in Chromium 153 (its kBlockedDomainExpirationPeriod): a site whose GPU process went
 * twice within two minutes is handed no adapter, on the page or in a worker, until two minutes after the first
 * loss. A reload the page makes does not lift it; the browser's own reload button lifts it for the page but not for
 * the page's worker. So the only honest advice is to wait.
 */
export const GPU_PAUSE_MS = 120_000
/** Asked a little longer than the browser holds it, ms: its clock started before the page heard of the loss. */
const GPU_PAUSE_MARGIN_MS = 5_000
/**
 * The window the browser counts GPU process crashes over, ms: Chrome forgives one per five minutes, and at three
 * gives GPU graphics up for the session (on a phone with nothing to fall back to, it ends itself).
 */
export const GPU_CRASH_WINDOW_MS = 300_000

/** Pure. The loss times in `raw` still inside GPU_CRASH_WINDOW_MS at `nowMs`, oldest first, the last four at most. */
export function parseGpuLosses(raw: string | null, nowMs: number): number[] {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 256) return []
  let data: unknown
  try { data = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(data)) return []
  return data.filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && nowMs - t >= 0 && nowMs - t < GPU_CRASH_WINDOW_MS).sort((a, b) => a - b).slice(-4)
}

/**
 * Losses noted within this of each other are one: the browser's GPU process going takes every tab of the site at once,
 * and each tab notes it. Two real losses cannot be this close (a new GPU process and a new start lie between them).
 */
export const GPU_LOSS_SAME_MS = 2000

/** Pure. `raw` with one more loss at `nowMs`, as the store keeps it; unchanged in count where the newest one kept is the same loss. */
export function withGpuLoss(raw: string | null, nowMs: number): string {
  const kept = parseGpuLosses(raw, nowMs)
  const newest = kept.at(-1)
  return JSON.stringify(newest !== undefined && nowMs - newest < GPU_LOSS_SAME_MS ? kept : [...kept, nowMs].slice(-4))
}

/** Pure. Whether the browser is withholding the GPU from this site at `nowMs`: two of `losses` inside GPU_PAUSE_MS. */
export function gpuPaused(losses: readonly number[], nowMs: number): boolean {
  return losses.filter((t) => nowMs - t >= 0 && nowMs - t < GPU_PAUSE_MS + GPU_PAUSE_MARGIN_MS).length >= 2
}

/** The loss times this site's pages have noted, still inside the browser's window; none where storage is refused. */
export function recentGpuLosses(nowMs: number = Date.now()): number[] {
  try {
    return parseGpuLosses(localStorage.getItem(GPU_LOSSES_KEY), nowMs)
  } catch {
    return []
  }
}

/** Notes that the browser's GPU process went, now. Never throws. */
export function noteGpuLoss(nowMs: number = Date.now()): void {
  try {
    localStorage.setItem(GPU_LOSSES_KEY, withGpuLoss(localStorage.getItem(GPU_LOSSES_KEY), nowMs))
  } catch {
    // No storage for this page: the count is the browser's alone.
  }
}

/**
 * Where the page's own restart on a lighter crowd kernel (App.tsx) leaves a note for the page it becomes: this tab's
 * session storage, so it is found after the navigation and by no other tab.
 */
export const KERNEL_RESTART_KEY = 'civic-simulation:kernel-restart:v1'
/** How long that note counts, ms: the restarted page takes up from it, and a second restart of the tab within it is refused. */
export const KERNEL_RESTART_GAP_MS = 120_000

/**
 * What the restarting page hands the page it becomes: when it went, and what a first visit held only in the page's
 * own memory (the onboarding's outcome: Sloane's mentoring, the hour and the sound the visitor chose), which a
 * navigation would otherwise drop on exactly the visitors whose first start failed.
 */
export interface KernelRestartNote { at: number; mentored: boolean; startHour: number; audio: boolean }

/** Pure. The note in `raw` while it counts (written within KERNEL_RESTART_GAP_MS before `nowMs`); null for anything else. */
export function parseKernelRestart(raw: string | null, nowMs: number): KernelRestartNote | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return null
  let data: unknown
  try { data = JSON.parse(raw) } catch { return null }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const n = data as Partial<Record<keyof KernelRestartNote, unknown>>
  if (typeof n.at !== 'number' || !Number.isFinite(n.at) || typeof n.mentored !== 'boolean' || typeof n.audio !== 'boolean') return null
  if (typeof n.startHour !== 'number' || !Number.isFinite(n.startHour) || n.startHour < 0 || n.startHour > 24) return null
  const age = nowMs - n.at
  return age >= 0 && age < KERNEL_RESTART_GAP_MS ? { at: n.at, mentored: n.mentored, startHour: n.startHour, audio: n.audio } : null
}

/**
 * Pure. The address the page's own restart on a lighter kernel goes to: kernelAddress, less a word that would put
 * the whole onboarding in front of the visitor again (?onboarding=1 asks for it on every load; the restart is not a
 * new visit). Null where the address cannot carry the kernel.
 */
export function kernelRestartAddress(href: string, kernel: CrowdKernel): string | null {
  const address = kernelAddress(href, kernel)
  if (!address) return null
  const url = new URL(address)
  const again = url.searchParams.get('onboarding')
  if (again === '1' || again === 'on') url.searchParams.delete('onboarding')
  return url.toString()
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
export const BOOT_STAGE: Readonly<Record<BootStage | 'probe' | 'map' | 'crowd' | 'lighter', string>> = Object.freeze({
  probe: 'checking this browser’s graphics',
  map: 'loading the map',
  gpu: 'asking for the graphics device',
  world: 'building the city',
  physics: 'starting the physics',
  shaders: 'preparing the shaders (the long step on a phone)',
  frame: 'drawing the first frame',
  crowd: 'waiting for the crowd',
  // The page's own restart after a crowd kernel took the GPU down (App.tsx): it waits for the GPU to come back first.
  lighter: 'starting again with a lighter crowd',
})
