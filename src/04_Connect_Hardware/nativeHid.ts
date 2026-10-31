// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? Inside the desktop shell (src-tauri) the page's web view is WebView2, which exposes
 * `navigator.hid` but, as far as this project could find, never shows the device chooser that `requestDevice` needs,
 * so a DualSense can never be granted to the page there. The shell therefore opens the controller itself
 * (src-tauri/src/hid.rs: `hid_list`, `hid_open`, `hid_write`, `hid_feature`, `hid_close`, and `hid-input` events),
 * and this file presents those five commands in WebHID's own shapes, so the DualSense driver (dualsense.ts) and the
 * HAL bus (hal.ts) run unchanged: the same reports, the same open sequence, the same plug and unplug rows. The shell
 * lists only the DualSense and DualSense Edge, so "request" means "take what the shell lists"; there is no chooser
 * to show and none is needed. Plug and unplug are found by asking the shell for its list every two seconds while
 * the bus listens; the shell's list is what Windows has right now.
 * UNCONFIRMED on a physical Windows machine with a controller: written from Tauri's and hidapi's documentation and
 * proven here only against a fake shell.
 * What breaks if it is removed? In the Windows app a DualSense has no trigger effects, rumble or lightbar.
 */

import { SHELL_GLOBAL } from '../07_Execute_Actions/desktopShell.ts'
import { DS } from './dualsense.ts'
import type { HardwareNavigator, Hid, HidCollectionInfo, HidConnectionEvent, HidDevice, HidDeviceFilter, HidInputReportEvent } from './web-hardware.d.ts'

/** The two calls of Tauri's injected API this file makes: `core.invoke` and `event.listen`. */
export interface ShellCore {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
  /** Resolves to the function that stops listening. */
  listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>
}

/** Tauri's `core` and `event` namespaces on the injected global, or null in a browser (or a shell without them). */
export function shellCore(g: object = globalThis): ShellCore | null {
  const api = (g as Record<string, unknown>)[SHELL_GLOBAL]
  if (typeof api !== 'object' || api === null) return null
  const core = (api as { core?: { invoke?: unknown } }).core
  const event = (api as { event?: { listen?: unknown } }).event
  if (typeof core !== 'object' || core === null || typeof core.invoke !== 'function') return null
  if (typeof event !== 'object' || event === null || typeof event.listen !== 'function') return null
  const invoke = core.invoke as (command: string, args?: Record<string, unknown>) => Promise<unknown>
  const listen = event.listen as (name: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>
  return {
    invoke: <T>(command: string, args?: Record<string, unknown>) => invoke.call(core, command, args) as Promise<T>,
    listen: <T>(name: string, handler: (e: { payload: T }) => void) => listen.call(event, name, handler as (e: { payload: unknown }) => void),
  }
}

/** One controller as `hid_list` describes it (src-tauri/src/hid.rs HidInfo). */
export interface NativeHidInfo {
  path: string
  vendorId: number
  productId: number
  productName: string
  usagePage: number
  usage: number
  bus: 'usb' | 'bluetooth' | 'unknown'
}

/** One input report as the `hid-input` event carries it: the ID apart from the data, as WebHID has them. */
export interface NativeHidInput { path: string; reportId: number; data: number[] }

/** The event name the shell emits input reports on. */
export const INPUT_EVENT = 'hid-input'

/** How often the shell's list is read for plug and unplug while someone listens for them. */
export const POLL_MS = 2000

/** How many bytes a feature report is read with: the firmware report (0x20) is 64 with its ID. */
export const FEATURE_LENGTH = 64

/**
 * WebHID would parse the report descriptor; the shell does not, so the collection is written from the bus, which
 * is all the driver reads of it (detectBus looks for output report 0x31, outputLength for its declared size).
 * A bus the shell could not tell is presented as USB, the driver's own assumption for a descriptor that says nothing.
 */
export function collectionsFor(info: Pick<NativeHidInfo, 'bus' | 'usagePage' | 'usage'>): HidCollectionInfo[] {
  const bt = info.bus === 'bluetooth'
  const output = bt
    ? { reportId: DS.btOutputId, items: [{ reportSize: 8, reportCount: DS.btOutputLength }] }
    : { reportId: DS.usbOutputId, items: [{ reportSize: 8, reportCount: DS.usbOutputLength }] }
  return [{ usagePage: info.usagePage, usage: info.usage, inputReports: [], outputReports: [output], featureReports: [{ reportId: DS.firmwareInfoId }] }]
}

/** Does a WebHID filter admit this controller? (Every field given must match, as the spec has it.) */
export function matchesFilter(f: HidDeviceFilter, d: { vendorId: number; productId: number; usagePage?: number; usage?: number }): boolean {
  if (f.vendorId !== undefined && f.vendorId !== d.vendorId) return false
  if (f.productId !== undefined && f.productId !== d.productId) return false
  if (f.usagePage !== undefined && f.usagePage !== d.usagePage) return false
  if (f.usage !== undefined && f.usage !== d.usage) return false
  return true
}

/** One controller the shell holds, in WebHID's shape. */
export class NativeHidDevice implements HidDevice {
  opened = false
  readonly path: string
  readonly vendorId: number
  readonly productId: number
  readonly productName: string
  readonly usagePage: number
  readonly usage: number
  readonly collections: readonly HidCollectionInfo[]
  private readonly core: ShellCore
  private readonly onOpen: (d: NativeHidDevice) => void
  private readonly listeners = new Set<(e: HidInputReportEvent) => void>()

  constructor(core: ShellCore, info: NativeHidInfo, onOpen: (d: NativeHidDevice) => void = () => {}) {
    this.core = core
    this.onOpen = onOpen
    this.path = info.path
    this.vendorId = info.vendorId
    this.productId = info.productId
    this.productName = info.productName
    this.usagePage = info.usagePage
    this.usage = info.usage
    this.collections = collectionsFor(info)
  }

  async open(): Promise<void> {
    if (this.opened) return
    await this.core.invoke<NativeHidInfo>('hid_open', { path: this.path })
    this.opened = true
    this.onOpen(this)
  }

  async close(): Promise<void> {
    if (!this.opened) return
    this.opened = false
    await this.core.invoke<void>('hid_close', { path: this.path })
  }

  /** `data` excludes the report ID, as WebHID has it; the shell puts the ID in front for hidapi. */
  async sendReport(reportId: number, data: Uint8Array): Promise<void> {
    if (!this.opened) throw new Error(`${this.productName || 'the controller'} is not open`)
    await this.core.invoke<number>('hid_write', { path: this.path, reportId, data: Array.from(data) })
  }

  /** The answer starts with the report ID, one of the two forms WebHID allows and the driver parses. */
  async receiveFeatureReport(reportId: number): Promise<DataView> {
    if (!this.opened) throw new Error(`${this.productName || 'the controller'} is not open`)
    const bytes = await this.core.invoke<number[]>('hid_feature', { path: this.path, reportId, length: FEATURE_LENGTH })
    return new DataView(Uint8Array.from(bytes).buffer)
  }

  addEventListener(type: 'inputreport', listener: (e: HidInputReportEvent) => void): void {
    if (type === 'inputreport') this.listeners.add(listener)
  }

  removeEventListener(type: 'inputreport', listener: (e: HidInputReportEvent) => void): void {
    if (type === 'inputreport') this.listeners.delete(listener)
  }

  /** An input report from the shell; dropped while closed, as WebHID would. */
  deliver(reportId: number, data: ArrayLike<number>): void {
    if (!this.opened || this.listeners.size === 0) return
    const e: HidInputReportEvent = { reportId, data: new DataView(Uint8Array.from(data).buffer) }
    for (const l of [...this.listeners]) l(e)
  }

  /** The shell no longer lists it: closed without a command (there is nothing left to close). */
  vanish(): void {
    this.opened = false
  }
}

export interface NativeHidOptions {
  /** How often the shell's list is read for plug and unplug while someone listens (POLL_MS). */
  pollMs?: number
  /** For tests: the timer the poll runs on. */
  setInterval?: (f: () => void, ms: number) => unknown
  clearInterval?: (t: unknown) => void
}

/**
 * `navigator.hid` as the shell provides it. One device object per controller path, kept while the shell lists it,
 * so the HAL's identity map (WeakMap by device) and the driver's owner map hold across calls.
 */
export class NativeHid implements Hid {
  /** Marks the shell's HID for the HAL (HalBus.shellHid): no chooser, the shell's list is the grant. */
  readonly shell = true
  private readonly devices = new Map<string, NativeHidDevice>()
  private readonly onConnect = new Set<(e: HidConnectionEvent) => void>()
  private readonly onDisconnect = new Set<(e: HidConnectionEvent) => void>()
  private timer: unknown = null
  private input: Promise<() => void> | null = null
  private listing: Promise<NativeHidDevice[]> | null = null
  /** The first list is the baseline, as WebHID's getDevices is: only a later arrival is a `connect`. */
  private primed = false
  private readonly core: ShellCore
  private readonly pollMs: number
  private readonly setTimer: (f: () => void, ms: number) => unknown
  private readonly clearTimer: (t: unknown) => void
  private disposed = false

  constructor(core: ShellCore, opts: NativeHidOptions = {}) {
    this.core = core
    this.pollMs = opts.pollMs ?? POLL_MS
    this.setTimer = opts.setInterval ?? ((f, ms) => setInterval(f, ms))
    this.clearTimer = opts.clearInterval ?? ((t) => clearInterval(t as ReturnType<typeof setInterval>))
  }

  /** Every controller the shell lists: they are all "granted", the shell lists nothing else. */
  getDevices(): Promise<HidDevice[]> {
    return this.refresh()
  }

  /** No chooser: the controllers the shell lists that pass the filters. An empty answer is "none plugged in". */
  async requestDevice(options: { filters: HidDeviceFilter[] }): Promise<HidDevice[]> {
    const all = await this.refresh()
    const filters = options.filters ?? []
    return filters.length === 0 ? all : all.filter((d) => filters.some((f) => matchesFilter(f, d)))
  }

  addEventListener(type: 'connect' | 'disconnect', listener: (e: HidConnectionEvent) => void): void {
    (type === 'connect' ? this.onConnect : this.onDisconnect).add(listener)
    this.poll()
  }

  removeEventListener(type: 'connect' | 'disconnect', listener: (e: HidConnectionEvent) => void): void {
    (type === 'connect' ? this.onConnect : this.onDisconnect).delete(listener)
    this.poll()
  }

  /**
   * Reads the shell's list and reconciles: a new path becomes a device (and, after the first list, a `connect`
   * event for whoever listens), a path no longer listed is closed and dropped (and a `disconnect` event). One
   * read at a time.
   */
  refresh(): Promise<NativeHidDevice[]> {
    if (this.listing) return this.listing
    const p = this.reconcile().finally(() => { if (this.listing === p) this.listing = null })
    this.listing = p
    return p
  }

  private async reconcile(): Promise<NativeHidDevice[]> {
    if (this.disposed) return []
    const infos = await this.core.invoke<NativeHidInfo[]>('hid_list')
    if (this.disposed) return []
    const announce = this.primed
    this.primed = true
    const seen = new Set<string>()
    const added: NativeHidDevice[] = []
    for (const info of infos) {
      if (typeof info?.path !== 'string' || seen.has(info.path)) continue
      seen.add(info.path)
      if (this.devices.has(info.path)) continue
      const d = new NativeHidDevice(this.core, info, () => this.listenInput())
      this.devices.set(info.path, d)
      added.push(d)
    }
    const gone: NativeHidDevice[] = []
    for (const [path, d] of this.devices) {
      if (seen.has(path)) continue
      this.devices.delete(path)
      d.vanish()
      gone.push(d)
    }
    for (const d of gone) for (const l of [...this.onDisconnect]) l({ device: d })
    if (announce) for (const d of added) for (const l of [...this.onConnect]) l({ device: d })
    return [...this.devices.values()]
  }

  /** The poll runs while anyone listens for plug or unplug, and not otherwise. */
  private poll(): void {
    const wanted = !this.disposed && (this.onConnect.size > 0 || this.onDisconnect.size > 0)
    if (wanted && this.timer === null) {
      const t = this.setTimer(() => { void this.refresh().catch(() => {}) }, this.pollMs)
      ;(t as { unref?: () => void }).unref?.()
      this.timer = t
    } else if (!wanted && this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
  }

  /** One `hid-input` listener for every controller, taken out the first time one is opened; reports go by path. */
  private listenInput(): void {
    if (this.input || this.disposed) return
    this.input = this.core.listen<NativeHidInput>(INPUT_EVENT, (e) => {
      const p = e.payload
      if (!p || typeof p.path !== 'string') return
      this.devices.get(p.path)?.deliver(p.reportId, p.data ?? [])
    }).catch(() => () => {})
  }

  /** Stops the poll and the input listener; the devices stay as they are (the HAL closes its own). */
  dispose(): void {
    this.disposed = true
    this.onConnect.clear()
    this.onDisconnect.clear()
    this.poll()
    const input = this.input
    this.input = null
    if (input) void input.then((off) => off())
  }
}

/**
 * The navigator the HAL should use: inside the shell, its HID in the place of the browser's (WebView2's has no
 * chooser, so it never yields a device); in a browser, the navigator as it is. Everything else (serial, Bluetooth,
 * the gamepads) stays the browser's.
 */
export function nativeNavigator(nav: HardwareNavigator | null, g: object = globalThis, opts: NativeHidOptions = {}): HardwareNavigator | null {
  const core = shellCore(g)
  if (!core) return nav
  const hid = new NativeHid(core, opts)
  const pads = nav?.getGamepads
  return {
    hid,
    serial: nav?.serial,
    bluetooth: nav?.bluetooth,
    getGamepads: typeof pads === 'function' ? () => pads.call(nav) : undefined,
  }
}
